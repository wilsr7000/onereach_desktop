/**
 * Local-API MCP aggregator — one MCP server fronting every local HTTP
 * API the desktop app runs on loopback, so an MCP client (Claude Code /
 * Claude Desktop) can DISCOVER and call them from one connect point
 * (2026-08-31: "add MCP to all the local APIs … this will help with
 * discovery").
 *
 * Three servers, one catalog:
 *   47291  Spaces / Tool API   search, spaces, items, tags (reads)
 *   47292  Log & app-control   logs, health, ai status, budget, sync (reads)
 *   47293  Agent Gateway       submit-task, playbook-qa (safe actions)
 *
 * SCOPE (chosen 2026-08-31): read + discovery + SAFE actions. The
 * mutating control endpoints — POST /app/restart, POST /ai/pause,
 * /ai/resume, /logging/level — are deliberately NOT in the catalog, so
 * a connected client can neither restart the app nor halt its AI. The
 * catalog below is the single source of truth: `describe_api` narrates
 * it and `registerTools` registers exactly its `callable` entries.
 *
 * This is a CLIENT of the loopback HTTP servers (which live in the main
 * Onereach.ai app), not a re-implementation — every tool forwards to
 * 127.0.0.1 and returns the JSON verbatim. It therefore inherits each
 * API's own behavior and permission posture (e.g. /playbook-qa stays
 * viewer-scoped via the viewerId it forwards).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z, type ZodTypeAny } from 'zod';

/** The three local APIs. Ports are env-overridable (see resolvePorts). */
export type LocalApiId = 'spaces' | 'control' | 'gateway';

export interface ApiParam {
  name: string;
  /** Where the value rides on the wire. */
  in: 'path' | 'query' | 'body';
  type: 'string' | 'number' | 'boolean' | 'object';
  required?: boolean;
  description: string;
}

export interface ApiOperation {
  /** MCP tool name (snake_case, api-prefixed). */
  tool: string;
  api: LocalApiId;
  method: 'GET' | 'POST';
  /** Path template; `:name` segments are filled from path params. */
  path: string;
  summary: string;
  params: ApiParam[];
  /**
   * false = shown by discovery (describe_api) but NOT registered as a
   * callable tool. Used for surfaces a one-shot tool can't model, e.g.
   * the gateway's Server-Sent-Events stream.
   */
  callable: boolean;
  /** Reason a non-callable op is listed but not wired. */
  note?: string;
}

export interface ApiDescriptor {
  id: LocalApiId;
  title: string;
  defaultPort: number;
  /** Env var that overrides the port. */
  portEnv: string;
  summary: string;
}

export const APIS: readonly ApiDescriptor[] = [
  {
    id: 'spaces',
    title: 'Spaces / Tool API',
    defaultPort: 47291,
    portEnv: 'LOCAL_API_SPACES_PORT',
    summary:
      'Local knowledge store: search, spaces, items, and tags. Reads only here.',
  },
  {
    id: 'control',
    title: 'Log & app-control API',
    defaultPort: 47292,
    portEnv: 'LOCAL_API_CONTROL_PORT',
    summary:
      'App health, structured logs, AI status, agent budget, and sync health. ' +
      'Reads only — restart and AI pause/resume are intentionally not exposed.',
  },
  {
    id: 'gateway',
    title: 'Agent Gateway',
    defaultPort: 47293,
    portEnv: 'LOCAL_API_GATEWAY_PORT',
    summary:
      'Run agents and playbook Q&A over the same auction the in-app orb uses.',
  },
];

/**
 * The operation catalog. Reads + safe actions only. Adding a row here
 * is all it takes to expose a new tool; `local-api-mcp.test.ts` pins
 * that no mutating control endpoint ever appears.
 */
export const OPERATIONS: readonly ApiOperation[] = [
  // ─── Spaces (47291) — reads ──────────────────────────────────────────
  {
    tool: 'spaces_status',
    api: 'spaces',
    method: 'GET',
    path: '/api/status',
    summary: 'Spaces API health + database status.',
    params: [],
    callable: true,
  },
  {
    tool: 'spaces_list',
    api: 'spaces',
    method: 'GET',
    path: '/api/spaces',
    summary: 'List all local spaces.',
    params: [],
    callable: true,
  },
  {
    tool: 'spaces_get',
    api: 'spaces',
    method: 'GET',
    path: '/api/spaces/:spaceId',
    summary: 'Get one space by id.',
    params: [
      { name: 'spaceId', in: 'path', type: 'string', required: true, description: 'Space id' },
    ],
    callable: true,
  },
  {
    tool: 'spaces_list_items',
    api: 'spaces',
    method: 'GET',
    path: '/api/spaces/:spaceId/items',
    summary: 'List items in a space (paged; filter by type/pinned).',
    params: [
      { name: 'spaceId', in: 'path', type: 'string', required: true, description: 'Space id' },
      { name: 'limit', in: 'query', type: 'number', description: 'Max rows (default 50)' },
      { name: 'offset', in: 'query', type: 'number', description: 'Paging offset' },
      { name: 'type', in: 'query', type: 'string', description: 'Filter by item type' },
      { name: 'pinned', in: 'query', type: 'boolean', description: 'Only pinned items' },
    ],
    callable: true,
  },
  {
    tool: 'spaces_get_item',
    api: 'spaces',
    method: 'GET',
    path: '/api/spaces/:spaceId/items/:itemId',
    summary: 'Read one item in full.',
    params: [
      { name: 'spaceId', in: 'path', type: 'string', required: true, description: 'Space id' },
      { name: 'itemId', in: 'path', type: 'string', required: true, description: 'Item id' },
    ],
    callable: true,
  },
  {
    tool: 'spaces_search',
    api: 'spaces',
    method: 'GET',
    path: '/api/search',
    summary: 'Full-text search across items.',
    params: [
      { name: 'q', in: 'query', type: 'string', required: true, description: 'Query text' },
      { name: 'spaceId', in: 'query', type: 'string', description: 'Scope to one space' },
      { name: 'type', in: 'query', type: 'string', description: 'Filter by item type' },
      { name: 'limit', in: 'query', type: 'number', description: 'Max rows (default 20)' },
    ],
    callable: true,
  },
  {
    tool: 'spaces_search_suggestions',
    api: 'spaces',
    method: 'GET',
    path: '/api/search/suggestions',
    summary: 'Type-ahead search suggestions for a prefix.',
    params: [
      { name: 'prefix', in: 'query', type: 'string', required: true, description: 'Prefix' },
      { name: 'limit', in: 'query', type: 'number', description: 'Max suggestions' },
    ],
    callable: true,
  },
  {
    tool: 'spaces_deep_search',
    api: 'spaces',
    method: 'POST',
    path: '/api/search/deep',
    summary:
      'LLM-powered semantic search — items ranked against AI filters. Read-only. ' +
      'Discover filters with spaces_deep_filters.',
    params: [
      { name: 'query', in: 'body', type: 'string', required: true, description: 'Natural-language query' },
      { name: 'filters', in: 'body', type: 'object', description: 'AI filter selection (see spaces_deep_filters)' },
      { name: 'spaceId', in: 'body', type: 'string', description: 'Scope to one space' },
      { name: 'limit', in: 'body', type: 'number', description: 'Max rows' },
    ],
    callable: true,
  },
  {
    tool: 'spaces_deep_filters',
    api: 'spaces',
    method: 'GET',
    path: '/api/search/deep/filters',
    summary: 'List the available AI filters for deep search.',
    params: [],
    callable: true,
  },
  {
    tool: 'spaces_tags',
    api: 'spaces',
    method: 'GET',
    path: '/api/tags',
    summary: 'List every tag in use, account-wide.',
    params: [],
    callable: true,
  },
  {
    tool: 'spaces_tags_search',
    api: 'spaces',
    method: 'GET',
    path: '/api/tags/search',
    summary: 'Find items by tag(s).',
    params: [
      { name: 'tags', in: 'query', type: 'string', required: true, description: 'Comma-separated tags' },
      { name: 'matchAll', in: 'query', type: 'boolean', description: 'Require all tags (AND) vs any (OR)' },
      { name: 'spaceId', in: 'query', type: 'string', description: 'Scope to one space' },
    ],
    callable: true,
  },

  // ─── Control (47292) — reads only ────────────────────────────────────
  {
    tool: 'app_health',
    api: 'control',
    method: 'GET',
    path: '/health',
    summary: 'App health snapshot.',
    params: [],
    callable: true,
  },
  {
    tool: 'app_status',
    api: 'control',
    method: 'GET',
    path: '/app/status',
    summary: 'App status (version, uptime, window state).',
    params: [],
    callable: true,
  },
  {
    tool: 'app_pid',
    api: 'control',
    method: 'GET',
    path: '/app/pid',
    summary: 'Main-process pid.',
    params: [],
    callable: true,
  },
  {
    tool: 'app_actions',
    api: 'control',
    method: 'GET',
    path: '/app/actions',
    summary: 'The app-control actions this build advertises.',
    params: [],
    callable: true,
  },
  {
    tool: 'logs_query',
    api: 'control',
    method: 'GET',
    path: '/logs',
    summary: 'Query structured logs (filter by level/category/limit).',
    params: [
      { name: 'level', in: 'query', type: 'string', description: 'Minimum level (debug|info|warn|error)' },
      { name: 'category', in: 'query', type: 'string', description: 'Filter by category' },
      { name: 'limit', in: 'query', type: 'number', description: 'Max rows' },
    ],
    callable: true,
  },
  {
    tool: 'logs_stats',
    api: 'control',
    method: 'GET',
    path: '/logs/stats',
    summary: 'Log volume + level counters.',
    params: [],
    callable: true,
  },
  {
    tool: 'ai_status',
    api: 'control',
    method: 'GET',
    path: '/ai/status',
    summary: 'Whether the AI loop is running or paused.',
    params: [],
    callable: true,
  },
  {
    tool: 'budget_agents',
    api: 'control',
    method: 'GET',
    path: '/budget/agents',
    summary: 'Per-agent token/spend budget snapshot.',
    params: [],
    callable: true,
  },
  {
    tool: 'sync_health',
    api: 'control',
    method: 'GET',
    path: '/sync/health',
    summary: 'Cloud-sync health (queue depth, DLQ, last run).',
    params: [],
    callable: true,
  },
  {
    tool: 'sync_queue',
    api: 'control',
    method: 'GET',
    path: '/sync/queue',
    summary: 'Pending cloud-sync queue.',
    params: [],
    callable: true,
  },

  // ─── Gateway (47293) — safe actions + reads ──────────────────────────
  {
    tool: 'gateway_health',
    api: 'gateway',
    method: 'GET',
    path: '/health',
    summary: 'Gateway health (task + subscriber counts).',
    params: [],
    callable: true,
  },
  {
    tool: 'gateway_submit_task',
    api: 'gateway',
    method: 'POST',
    path: '/submit-task',
    summary:
      'Run an agent. Route directly with targetAgentId, or omit it for open auction. ' +
      'Returns { taskId, queued, handled, message?, data? }; follow the SSE stream for completion.',
    params: [
      { name: 'text', in: 'body', type: 'string', required: true, description: 'The task / prompt text' },
      { name: 'targetAgentId', in: 'body', type: 'string', description: 'Route directly to this agent (skip bidding)' },
      { name: 'spaceId', in: 'body', type: 'string', description: 'Space context for the task' },
      { name: 'toolId', in: 'body', type: 'string', description: 'Caller id (default agent-gateway)' },
      { name: 'metadata', in: 'body', type: 'object', description: 'Free-form metadata attached to the task' },
    ],
    callable: true,
  },
  {
    tool: 'gateway_playbook_qa',
    api: 'gateway',
    method: 'POST',
    path: '/playbook-qa',
    summary:
      'Ask a question over playbooks. Results are scoped to what the viewer may see ' +
      '(fail-closed); pass viewerId to set that scope.',
    params: [
      { name: 'question', in: 'body', type: 'string', required: true, description: 'The question' },
      { name: 'mode', in: 'body', type: 'string', description: 'retrieval | quality (default auto)' },
      { name: 'spaceId', in: 'body', type: 'string', description: 'Scope to one space' },
      { name: 'limit', in: 'body', type: 'number', description: 'Max candidates' },
      { name: 'viewerId', in: 'body', type: 'string', description: 'Viewer identity for permission scoping' },
    ],
    callable: true,
  },
  {
    tool: 'gateway_task_events',
    api: 'gateway',
    method: 'GET',
    path: '/events/:taskId',
    summary:
      'Server-Sent-Events stream of a task timeline. Not a one-shot tool — connect ' +
      'to this URL directly for live events.',
    params: [
      { name: 'taskId', in: 'path', type: 'string', required: true, description: 'Task id from gateway_submit_task' },
    ],
    callable: false,
    note: 'SSE stream; a one-shot MCP tool cannot model it. Listed for discovery.',
  },
];

/** Resolve each API's port from env, falling back to the default. */
export function resolvePorts(
  env: Record<string, string | undefined> = process.env
): Record<LocalApiId, number> {
  const out = {} as Record<LocalApiId, number>;
  for (const api of APIS) {
    const raw = env[api.portEnv];
    const parsed = raw !== undefined ? Number.parseInt(raw, 10) : NaN;
    out[api.id] = Number.isFinite(parsed) && parsed > 0 ? parsed : api.defaultPort;
  }
  return out;
}

/** Build the flat zod input schema for one operation. */
export function buildInputSchema(op: ApiOperation): Record<string, ZodTypeAny> {
  const schema: Record<string, ZodTypeAny> = {};
  for (const p of op.params) {
    let base: ZodTypeAny;
    switch (p.type) {
      case 'number':
        base = z.number();
        break;
      case 'boolean':
        base = z.boolean();
        break;
      case 'object':
        base = z.record(z.unknown());
        break;
      default:
        base = z.string();
    }
    schema[p.name] = (p.required === true ? base : base.optional()).describe(
      p.description
    );
  }
  return schema;
}

export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface CallDeps {
  fetchImpl: FetchLike;
  ports: Record<LocalApiId, number>;
  host?: string;
  /** Default viewer identity forwarded to viewer-scoped ops (playbook-qa). */
  viewerId?: string;
}

/** Build the request URL + init for an operation and its arguments. */
export function buildRequest(
  op: ApiOperation,
  args: Record<string, unknown>,
  deps: CallDeps
): { url: string; method: string; headers: Record<string, string>; body?: string } {
  const host = deps.host ?? '127.0.0.1';
  const port = deps.ports[op.api];
  let path = op.path;
  const query = new URLSearchParams();
  const bodyObj: Record<string, unknown> = {};

  for (const p of op.params) {
    const v = args[p.name];
    if (v === undefined || v === null) continue;
    if (p.in === 'path') {
      path = path.replace(`:${p.name}`, encodeURIComponent(String(v)));
    } else if (p.in === 'query') {
      query.set(p.name, String(v));
    } else {
      bodyObj[p.name] = v;
    }
  }

  // Forward a default viewer identity to viewer-scoped ops when the
  // caller didn't set one explicitly (keeps /playbook-qa fail-closed
  // rather than silently unscoped).
  if (
    op.tool === 'gateway_playbook_qa' &&
    bodyObj.viewerId === undefined &&
    deps.viewerId !== undefined &&
    deps.viewerId.length > 0
  ) {
    bodyObj.viewerId = deps.viewerId;
  }

  const qs = query.toString();
  const url = `http://${host}:${port}${path}${qs.length > 0 ? `?${qs}` : ''}`;
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (op.method === 'POST') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(bodyObj);
  }
  return { url, method: op.method, headers, ...(body !== undefined ? { body } : {}) };
}

/** Call one operation and return its JSON (or a helpful error string). */
export async function callOperation(
  op: ApiOperation,
  args: Record<string, unknown>,
  deps: CallDeps
): Promise<unknown> {
  const req = buildRequest(op, args, deps);
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await deps.fetchImpl(req.url, {
      method: req.method,
      headers: req.headers,
      ...(req.body !== undefined ? { body: req.body } : {}),
    });
  } catch (err) {
    const msg = (err as Error).message;
    const api = APIS.find((a) => a.id === op.api);
    if (/ECONNREFUSED|fetch failed|ECONNRESET/i.test(msg)) {
      throw new Error(
        `${api?.title ?? op.api} isn't reachable on port ${deps.ports[op.api]} — ` +
          `is the Onereach.ai app running? (${msg})`
      );
    }
    throw new Error(`${op.tool} failed: ${msg}`);
  }
  const parsed = await res.json().catch(() => null);
  if (!res.ok) {
    const detail =
      parsed !== null ? JSON.stringify(parsed) : await res.text().catch(() => '');
    throw new Error(`${op.tool} → HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return parsed;
}

function text(value: unknown): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    content: [
      {
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

/** Discovery payload: the whole catalog, grouped by API. */
export function discoveryCatalog(
  ports: Record<LocalApiId, number>
): Record<string, unknown> {
  return {
    apis: APIS.map((a) => ({
      id: a.id,
      title: a.title,
      port: ports[a.id],
      summary: a.summary,
      operations: OPERATIONS.filter((op) => op.api === a.id).map((op) => ({
        tool: op.callable ? op.tool : `${op.tool} (not callable)`,
        method: op.method,
        path: op.path,
        summary: op.summary,
        params: op.params.map((p) => `${p.name}${p.required ? '*' : ''}:${p.type} (${p.in})`),
        ...(op.note !== undefined ? { note: op.note } : {}),
      })),
    })),
    note:
      'Mutating control endpoints (app restart, AI pause/resume, log-level ' +
      'changes) are intentionally NOT exposed as tools.',
  };
}

/** Register discovery meta-tools + every callable operation. */
export function registerTools(server: McpServer, deps: CallDeps): void {
  server.registerTool(
    'list_local_apis',
    {
      description:
        'Discover every local Onereach.ai HTTP API and its operations — the full ' +
        'catalog (ports, methods, paths, params). Start here.',
      inputSchema: {},
    },
    async () => text(discoveryCatalog(deps.ports))
  );

  server.registerTool(
    'describe_api',
    {
      description: 'Detail one local API and its operations by id (spaces | control | gateway).',
      inputSchema: {
        api: z.enum(['spaces', 'control', 'gateway']).describe('Which API'),
      },
    },
    async ({ api }) => {
      const full = discoveryCatalog(deps.ports) as {
        apis: Array<{ id: string }>;
      };
      const one = full.apis.find((a) => a.id === api);
      return text(one ?? `Unknown api "${api}". Use one of: spaces, control, gateway.`);
    }
  );

  for (const op of OPERATIONS) {
    if (!op.callable) continue;
    server.registerTool(
      op.tool,
      { description: op.summary, inputSchema: buildInputSchema(op) },
      async (args: Record<string, unknown>) => text(await callOperation(op, args ?? {}, deps))
    );
  }
}

/** Production deps: real fetch + env-resolved ports + default viewer. */
export function createDeps(
  env: Record<string, string | undefined> = process.env
): CallDeps {
  const viewerId = env.LOCAL_API_VIEWER_ID ?? env.SPACES_VIEWER_ID;
  return {
    fetchImpl: fetch as unknown as FetchLike,
    ports: resolvePorts(env),
    ...(viewerId !== undefined && viewerId.length > 0 ? { viewerId } : {}),
  };
}

async function main(): Promise<void> {
  const server = new McpServer({ name: 'onereach-local-apis', version: '1.0.0' });
  registerTools(server, createDeps());
  await server.connect(new StdioServerTransport());
}

// Only run as a program — imports (tests) get the seams without side effects.
if (process.argv[1] !== undefined && /local-api-mcp/.test(process.argv[1])) {
  void main();
}
