/**
 * FlowHttpKVClient unit tests.
 *
 * Verifies the login-token KV transport (2026-08-20 auth migration):
 *   - Every request carries `Authorization: Bearer <login token>` from
 *     the injected token resolver ("login settings") — there is NO
 *     refresh_token flow call, ever.
 *   - Every request hits the SHARED org KV URL
 *     (`/http/{SHARED_KV_ACCOUNT_ID}/keyvalue2`) — the URL never
 *     varies by who signed in (the rich@onereach.com first-sign-in
 *     404 class: per-account flow deployments are retired).
 *   - Signed-out (empty token) throws without touching the network.
 *   - Maps server responses to the same KVApi semantics as before.
 *   - Reclassifies stale-token errors and fires onAuthRejected.
 *
 * Network is stubbed via a fetch impl that records requests + returns
 * canned responses. No real HTTP.
 */

import { describe, it, expect } from 'vitest';
import { FlowHttpKVClient, SHARED_KV_ACCOUNT_ID } from '../../kv/flow-http-client.js';
import { KVError, KV_ERROR_CODES } from '../../kv/client.js';

// ─── fetch stub ────────────────────────────────────────────────────────────

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

interface FakeResponseSpec {
  status?: number;
  body?: unknown;
  bodyText?: string;
}

class FetchStub {
  public readonly requests: RecordedRequest[] = [];
  /** Per-call queue of responses, in order. Reset per test. */
  public responses: FakeResponseSpec[] = [];

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers instanceof Headers) {
      init.headers.forEach((v, k) => {
        headers[k] = v;
      });
    } else if (Array.isArray(init?.headers)) {
      for (const [k, v] of init.headers) headers[k] = v;
    } else if (init?.headers !== undefined) {
      Object.assign(headers, init.headers as Record<string, string>);
    }
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const recorded: RecordedRequest = { url, method, headers };
    if (body !== undefined) recorded.body = body;
    this.requests.push(recorded);

    const spec = this.responses.shift();
    if (spec === undefined) {
      throw new Error(`FetchStub: no canned response for ${method} ${url}`);
    }
    const status = spec.status ?? 200;
    const text =
      spec.bodyText !== undefined
        ? spec.bodyText
        : spec.body !== undefined
          ? JSON.stringify(spec.body)
          : '';
    return makeResponse(status, text);
  };
}

function makeResponse(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const KV_URL = `https://em.edison.api.onereach.ai/http/${SHARED_KV_ACCOUNT_ID}/keyvalue2`;

function makeClient(opts: {
  token?: string;
  baseUrl?: string;
  onAuthRejected?: (reason: string) => void;
} = {}): { client: FlowHttpKVClient; stub: FetchStub } {
  const stub = new FetchStub();
  const config: ConstructorParameters<typeof FlowHttpKVClient>[0] = {
    token: () => opts.token ?? 'mult-token-abc',
    fetchImpl: stub.fetch,
    baseUrl: opts.baseUrl ?? 'https://em.edison.api.onereach.ai',
  };
  if (opts.onAuthRejected !== undefined) config.onAuthRejected = opts.onAuthRejected;
  const client = new FlowHttpKVClient(config);
  return { client, stub };
}

// ─── Login-token auth (the 2026-08-20 migration contract) ──────────────────

describe('FlowHttpKVClient login-token auth', () => {
  it('sends Authorization: Bearer <login token> on every op', async () => {
    const { client, stub } = makeClient({ token: 'mult-xyz' });
    stub.responses = [
      { status: 404 }, // get
      { status: 200, body: { ok: true } }, // set
      { status: 200, body: { records: [] } }, // listKeys
      { status: 200, body: { ok: true } }, // delete
    ];
    await client.get('c', 'k');
    await client.set('c', 'k', { a: 1 });
    await client.listKeys('c');
    await client.delete('c', 'k');
    expect(stub.requests).toHaveLength(4);
    for (const req of stub.requests) {
      expect(req.headers['Authorization']).toBe('Bearer mult-xyz');
    }
  });

  it('NEVER calls the refresh_token flow', async () => {
    // The per-account /refresh_token dance is retired (it 404'd for any
    // teammate whose default GSX account lacked the flow — the
    // rich@onereach.com sign-in incident). The login token is used
    // directly; one network call per KV op.
    const { client, stub } = makeClient();
    stub.responses = [{ status: 404 }, { status: 404 }, { status: 404 }];
    await client.get('c', 'k1');
    await client.get('c', 'k2');
    await client.get('c', 'k3');
    const refreshCalls = stub.requests.filter((r) => r.url.includes('refresh_token'));
    expect(refreshCalls).toHaveLength(0);
    expect(stub.requests).toHaveLength(3);
  });

  it('always hits the SHARED org KV URL — never a per-user account URL', async () => {
    const { client, stub } = makeClient({ token: 'someone-elses-mult' });
    stub.responses = [{ status: 404 }];
    await client.get('lite-tool-entries', 'default');
    expect(stub.requests[0]?.url).toBe(`${KV_URL}?id=lite-tool-entries&key=default`);
    expect(stub.requests[0]?.url).toContain(SHARED_KV_ACCOUNT_ID);
  });

  it('reads the token fresh on every call — auth rotation needs no cache bust', async () => {
    let token = 'first';
    const stub = new FetchStub();
    const client = new FlowHttpKVClient({
      token: () => token,
      fetchImpl: stub.fetch,
      baseUrl: 'https://em.edison.api.onereach.ai',
    });
    stub.responses = [{ status: 404 }, { status: 404 }];
    await client.get('c', 'k1');
    token = 'second';
    await client.get('c', 'k2');
    expect(stub.requests[0]?.headers['Authorization']).toBe('Bearer first');
    expect(stub.requests[1]?.headers['Authorization']).toBe('Bearer second');
  });

  it('throws KVError 401 without touching the network when signed out', async () => {
    const rejected: string[] = [];
    const { client, stub } = makeClient({ token: '', onAuthRejected: (r) => rejected.push(r) });
    await expect(client.get('c', 'k')).rejects.toMatchObject({
      code: KV_ERROR_CODES.HTTP,
      status: 401,
    });
    expect(stub.requests).toHaveLength(0);
    expect(rejected).toHaveLength(1);
  });
});

// ─── KV operation wire format ──────────────────────────────────────────────

describe('FlowHttpKVClient.set', () => {
  it('PUTs to /keyvalue2?id=...&key=... with the value JSON-encoded as a string', async () => {
    const { client, stub } = makeClient();
    stub.responses = [{ status: 200, body: { ok: true } }];
    await client.set('lite-tool-entries', 'default', { foo: 'bar' });
    const req = stub.requests[0];
    expect(req?.method).toBe('PUT');
    expect(req?.url).toBe(`${KV_URL}?id=lite-tool-entries&key=default`);
    // The value is sent under `itemValue` (the field the flow actually
    // stores) as a JSON STRING, plus `n` for older flow versions. Sending
    // it under `value` was ignored by the flow -> round-tripped to the
    // literal "undefined" and wiped persisted state.
    const enc = JSON.stringify({ foo: 'bar' });
    expect(JSON.parse(req?.body ?? '{}')).toEqual({
      id: 'lite-tool-entries',
      key: 'default',
      itemValue: enc,
      n: enc,
    });
  });

  it('round-trips an object: set() stringifies, get() unwraps it back', async () => {
    const { client, stub } = makeClient();
    // Simulate the flow echoing back the stringified value under { value }.
    const stored = JSON.stringify({ schemaVersion: 1, entries: [{ id: 'a' }] });
    stub.responses = [
      { status: 200, body: { ok: true } }, // PUT
      { status: 200, body: { value: stored } }, // GET returns the string
    ];
    await client.set('lite-idw-entries', 'default', { schemaVersion: 1, entries: [{ id: 'a' }] });
    const got = await client.get('lite-idw-entries', 'default');
    expect(got).toEqual({ schemaVersion: 1, entries: [{ id: 'a' }] });
  });

  it('URL-encodes collection + key', async () => {
    const { client, stub } = makeClient();
    stub.responses = [{ status: 200, body: { ok: true } }];
    await client.set('weird/coll', 'edison:abc-123', {});
    expect(stub.requests[0]?.url).toContain('id=weird%2Fcoll&key=edison%3Aabc-123');
  });
});

describe('FlowHttpKVClient.get', () => {
  it('returns null on HTTP 404', async () => {
    const { client, stub } = makeClient();
    stub.responses = [{ status: 404 }];
    expect(await client.get('c', 'k')).toBeNull();
  });

  it('returns null on the "No data found." sentinel', async () => {
    const { client, stub } = makeClient();
    stub.responses = [{ status: 200, body: { Status: 'No data found.' } }];
    expect(await client.get('c', 'k')).toBeNull();
  });

  it('parses { value: ... } shape', async () => {
    const { client, stub } = makeClient();
    stub.responses = [{ status: 200, body: { value: { foo: 'bar' } } }];
    expect(await client.get('c', 'k')).toEqual({ foo: 'bar' });
  });

  it('parses { get: { value } } shape', async () => {
    const { client, stub } = makeClient();
    stub.responses = [{ status: 200, body: { get: { value: 'hello' } } }];
    expect(await client.get('c', 'k')).toBe('hello');
  });

  it('parses double-encoded inner JSON strings', async () => {
    const { client, stub } = makeClient();
    stub.responses = [{ status: 200, body: { value: '{"nested":true}' } }];
    expect(await client.get('c', 'k')).toEqual({ nested: true });
  });

  it('unwraps a TOP-LEVEL double-encoded JSON string into the object', async () => {
    // Regression: the flow (esp. after the sign-in KV migration) can
    // return the whole body as a JSON-stringified blob, so JSON.parse
    // yields a *string*, not an object. Previously this returned the
    // raw string, which made object-shaped stores (tabs, IDW menu,
    // tools) treat their blob as corrupt and reset to empty on boot —
    // i.e. agents/menu/tabs vanished across restarts. The client must
    // unwrap one more level. `body` is a JS string here, so the stub's
    // JSON.stringify produces a double-encoded response body.
    const { client, stub } = makeClient();
    stub.responses = [
      { status: 200, body: '{"schemaVersion":1,"tabs":[{"id":"t1"}],"activeId":"t1"}' },
    ];
    expect(await client.get('lite-main-window-tabs', 'default')).toEqual({
      schemaVersion: 1,
      tabs: [{ id: 't1' }],
      activeId: 't1',
    });
  });

  it('leaves a legitimate plain-string value as a string (no over-coercion)', async () => {
    // A stored value that is genuinely a string like "hello" must NOT
    // be coerced — only object/array re-parses are unwrapped.
    const { client, stub } = makeClient();
    stub.responses = [{ status: 200, body: 'hello' }];
    expect(await client.get('c', 'k')).toBe('hello');
  });
});

describe('FlowHttpKVClient.listKeys', () => {
  it('POSTs to /keyvalue2 with body { id: collection } and parses records[]', async () => {
    const { client, stub } = makeClient();
    stub.responses = [
      {
        status: 200,
        body: { records: [{ key: 'a' }, { key: 'b' }, 'c'] },
      },
    ];
    expect(await client.listKeys('c')).toEqual(['a', 'b', 'c']);
    const req = stub.requests[0];
    expect(req?.method).toBe('POST');
    expect(req?.url).toBe(KV_URL);
    expect(JSON.parse(req?.body ?? '{}')).toEqual({ id: 'c' });
  });
});

describe('FlowHttpKVClient.delete', () => {
  it('DELETEs /keyvalue2?id=...&key=...', async () => {
    const { client, stub } = makeClient();
    stub.responses = [{ status: 200, body: { ok: true } }];
    await client.delete('c', 'k');
    expect(stub.requests[0]?.method).toBe('DELETE');
  });

  it('treats 404 on delete as idempotent success', async () => {
    const { client, stub } = makeClient();
    stub.responses = [{ status: 404 }];
    await expect(client.delete('c', 'k')).resolves.toBeUndefined();
  });
});

// ─── Auth-rejection signaling ──────────────────────────────────────────────

describe('FlowHttpKVClient onAuthRejected', () => {
  it('fires when KV returns HTTP 401', async () => {
    const rejected: string[] = [];
    const { client, stub } = makeClient({ onAuthRejected: (r) => rejected.push(r) });
    stub.responses = [{ status: 401, bodyText: 'Token was not accepted: wrong keyId' }];
    await expect(client.set('c', 'k', {})).rejects.toMatchObject({
      code: KV_ERROR_CODES.HTTP,
      status: 401,
    });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain('wrong keyId');
  });

  it('fires when KV returns 200 but body contains "Token was not accepted" (legacy flow shape)', async () => {
    const rejected: string[] = [];
    const { client, stub } = makeClient({ onAuthRejected: (r) => rejected.push(r) });
    // The flow KV occasionally returns 4xx as 200+body. Detect by body content.
    stub.responses = [{ status: 400, bodyText: 'wrong keyId' }];
    await expect(client.set('c', 'k', {})).rejects.toBeInstanceOf(KVError);
    expect(rejected).toHaveLength(1);
  });

  it('does not fire on 5xx server errors', async () => {
    const rejected: string[] = [];
    const { client, stub } = makeClient({ onAuthRejected: (r) => rejected.push(r) });
    stub.responses = [{ status: 503, bodyText: 'service unavailable' }];
    await expect(client.set('c', 'k', {})).rejects.toMatchObject({
      code: KV_ERROR_CODES.HTTP,
      status: 503,
    });
    expect(rejected).toEqual([]);
  });

  it('a 401 does not poison later calls — the next op retries with the current token', async () => {
    // With no client-side token cache there is nothing to drop: after a
    // rejection (e.g. the server rotated its keyset mid-session and the
    // kernel re-signed-in), the very next call reads the CURRENT login
    // token and proceeds.
    let token = 'stale';
    const stub = new FetchStub();
    const client = new FlowHttpKVClient({
      token: () => token,
      fetchImpl: stub.fetch,
      baseUrl: 'https://em.edison.api.onereach.ai',
    });
    stub.responses = [
      { status: 401, bodyText: 'Token was not accepted' },
      { status: 200, body: { ok: true } },
    ];
    await expect(client.set('c', 'k', {})).rejects.toBeInstanceOf(KVError);
    token = 'fresh-after-resignin';
    await client.set('c', 'k', {});
    expect(stub.requests[1]?.headers['Authorization']).toBe('Bearer fresh-after-resignin');
  });
});
