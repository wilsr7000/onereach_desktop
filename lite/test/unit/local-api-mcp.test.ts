/**
 * Local-API MCP aggregator (2026-08-31: "add MCP to all the local APIs
 * … help with discovery"). Pins the load-bearing guarantees: the
 * catalog is the single source of truth, the chosen scope (read +
 * discovery + safe actions) holds — no mutating control endpoint is
 * ever callable — and request building maps path/query/body correctly
 * incl. the fail-closed viewer forwarding on playbook-qa.
 */
import { describe, it, expect } from 'vitest';
import {
  APIS,
  OPERATIONS,
  buildInputSchema,
  buildRequest,
  callOperation,
  createDeps,
  discoveryCatalog,
  resolvePorts,
  type ApiOperation,
  type CallDeps,
  type FetchLike,
} from '../../mcp/local-api-mcp.js';

const PORTS = { spaces: 47291, control: 47292, gateway: 47293 } as const;

function deps(over: Partial<CallDeps> = {}): CallDeps {
  return {
    fetchImpl: (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
      text: async () => '',
    })) as unknown as FetchLike,
    ports: { ...PORTS },
    ...over,
  };
}

function op(tool: string): ApiOperation {
  const found = OPERATIONS.find((o) => o.tool === tool);
  if (found === undefined) throw new Error(`no op ${tool}`);
  return found;
}

// ─── catalog integrity + scope ──────────────────────────────────────────────

describe('operation catalog', () => {
  it('every op names a known API and unique tool', () => {
    const ids = new Set(APIS.map((a) => a.id));
    const tools = new Set<string>();
    for (const o of OPERATIONS) {
      expect(ids.has(o.api), `${o.tool} → unknown api ${o.api}`).toBe(true);
      expect(tools.has(o.tool), `duplicate tool ${o.tool}`).toBe(false);
      tools.add(o.tool);
      // Path params must each have a declared path param.
      for (const seg of o.path.split('/').filter((s) => s.startsWith(':'))) {
        const name = seg.slice(1);
        expect(
          o.params.some((p) => p.name === name && p.in === 'path'),
          `${o.tool} path needs param ${name}`
        ).toBe(true);
      }
    }
  });

  it('NEVER exposes a mutating control endpoint (the chosen scope)', () => {
    const forbidden = [
      '/app/restart',
      '/ai/pause',
      '/ai/resume',
      '/logging/level',
    ];
    for (const o of OPERATIONS) {
      for (const bad of forbidden) {
        expect(o.path === bad, `${o.tool} exposes forbidden ${bad}`).toBe(false);
      }
    }
    // Control API is reads only: no POST callable there.
    const controlPosts = OPERATIONS.filter(
      (o) => o.api === 'control' && o.method === 'POST' && o.callable
    );
    expect(controlPosts).toEqual([]);
  });

  it('only submit-task and playbook-qa are callable POSTs (the safe actions)', () => {
    const callablePosts = OPERATIONS.filter((o) => o.method === 'POST' && o.callable).map(
      (o) => o.tool
    );
    expect(new Set(callablePosts)).toEqual(
      new Set(['spaces_deep_search', 'gateway_submit_task', 'gateway_playbook_qa'])
    );
  });

  it('the SSE stream is discoverable but not callable', () => {
    expect(op('gateway_task_events').callable).toBe(false);
  });
});

// ─── port resolution ─────────────────────────────────────────────────────────

describe('resolvePorts', () => {
  it('defaults to 47291/47292/47293', () => {
    expect(resolvePorts({})).toEqual(PORTS);
  });
  it('honors env overrides and ignores junk', () => {
    expect(resolvePorts({ LOCAL_API_SPACES_PORT: '5000' }).spaces).toBe(5000);
    expect(resolvePorts({ LOCAL_API_CONTROL_PORT: 'nope' }).control).toBe(47292);
  });
});

// ─── request building ────────────────────────────────────────────────────────

describe('buildRequest', () => {
  it('fills path params and drops absent optionals from the query', () => {
    const req = buildRequest(
      op('spaces_list_items'),
      { spaceId: 'sp 1', limit: 10 },
      deps()
    );
    expect(req.url).toBe('http://127.0.0.1:47291/api/spaces/sp%201/items?limit=10');
    expect(req.method).toBe('GET');
    expect(req.body).toBeUndefined();
  });

  it('POST ops carry a JSON body and content-type', () => {
    const req = buildRequest(
      op('gateway_submit_task'),
      { text: 'do it', targetAgentId: 'spaces-agent' },
      deps()
    );
    expect(req.url).toBe('http://127.0.0.1:47293/submit-task');
    expect(req.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(req.body!)).toEqual({ text: 'do it', targetAgentId: 'spaces-agent' });
  });

  it('forwards the default viewerId to playbook-qa (fail-closed scoping) but not elsewhere', () => {
    const qa = buildRequest(
      op('gateway_playbook_qa'),
      { question: 'why?' },
      deps({ viewerId: 'robb@onereach.com' })
    );
    expect(JSON.parse(qa.body!)).toEqual({ question: 'why?', viewerId: 'robb@onereach.com' });
    // An explicit viewerId is never overridden.
    const explicit = buildRequest(
      op('gateway_playbook_qa'),
      { question: 'why?', viewerId: 'someone@else.com' },
      deps({ viewerId: 'robb@onereach.com' })
    );
    expect(JSON.parse(explicit.body!).viewerId).toBe('someone@else.com');
    // A different POST op does NOT get a viewerId injected.
    const task = buildRequest(op('gateway_submit_task'), { text: 'x' }, deps({ viewerId: 'robb@onereach.com' }));
    expect(JSON.parse(task.body!)).toEqual({ text: 'x' });
  });

  it('honors a port override in the built URL', () => {
    const req = buildRequest(op('spaces_status'), {}, deps({ ports: { ...PORTS, spaces: 5000 } }));
    expect(req.url).toBe('http://127.0.0.1:5000/api/status');
  });
});

// ─── zod schema ──────────────────────────────────────────────────────────────

describe('buildInputSchema', () => {
  it('marks required vs optional and types', () => {
    const schema = buildInputSchema(op('spaces_search'));
    const q = schema.q!;
    const limit = schema.limit!;
    expect(q.isOptional()).toBe(false);
    expect(limit.isOptional()).toBe(true);
    // Required string rejects a missing value; optional number accepts absence.
    expect(q.safeParse(undefined).success).toBe(false);
    expect(limit.safeParse(undefined).success).toBe(true);
    expect(limit.safeParse(5).success).toBe(true);
  });
});

// ─── call + error handling ───────────────────────────────────────────────────

describe('callOperation', () => {
  it('returns parsed JSON on success', async () => {
    const d = deps({
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ spaces: [1, 2] }),
        text: async () => '',
      })) as unknown as FetchLike,
    });
    expect(await callOperation(op('spaces_list'), {}, d)).toEqual({ spaces: [1, 2] });
  });

  it('a connection refusal explains the app is not running', async () => {
    const d = deps({
      fetchImpl: (async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:47291');
      }) as unknown as FetchLike,
    });
    await expect(callOperation(op('spaces_list'), {}, d)).rejects.toThrow(/Onereach\.ai app running/);
  });

  it('surfaces HTTP errors with status + body', async () => {
    const d = deps({
      fetchImpl: (async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: 'boom' }),
        text: async () => '',
      })) as unknown as FetchLike,
    });
    await expect(callOperation(op('spaces_list'), {}, d)).rejects.toThrow(/HTTP 500.*boom/);
  });
});

// ─── discovery payload ───────────────────────────────────────────────────────

describe('discoveryCatalog', () => {
  it('groups every op under its API and flags the non-callable one', () => {
    const cat = discoveryCatalog(PORTS) as {
      apis: Array<{ id: string; port: number; operations: Array<{ tool: string }> }>;
      note: string;
    };
    expect(cat.apis.map((a) => a.id)).toEqual(['spaces', 'control', 'gateway']);
    const gateway = cat.apis.find((a) => a.id === 'gateway')!;
    expect(gateway.operations.some((o) => o.tool.includes('not callable'))).toBe(true);
    expect(cat.note).toMatch(/restart/i);
  });
});

// ─── production deps ─────────────────────────────────────────────────────────

describe('createDeps', () => {
  it('picks up the viewer id from LOCAL_API_VIEWER_ID (or SPACES_VIEWER_ID)', () => {
    expect(createDeps({ LOCAL_API_VIEWER_ID: 'a@b.com' }).viewerId).toBe('a@b.com');
    expect(createDeps({ SPACES_VIEWER_ID: 'c@d.com' }).viewerId).toBe('c@d.com');
    expect(createDeps({}).viewerId).toBeUndefined();
  });
});
