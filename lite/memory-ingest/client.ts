/**
 * Memory-ingest module -- outbound MCP client. Per ADR-079.
 *
 * Wraps @modelcontextprotocol/sdk's `Client` + streamable-HTTP
 * transport behind a tiny session interface so the engine (and every
 * test) never touches the SDK directly. The interesting logic --
 * picking WHICH remote tool ingests, and mapping our item payload onto
 * THAT tool's input schema -- is pure and exported for direct testing,
 * because remote memory servers do not share a schema convention.
 */

import type { MemoryServerConfig } from './types.js';

/** Minimal view of a remote tool from `tools/list`. */
export interface RemoteTool {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
}

/** One live connection to a memory server. */
export interface MemorySession {
  listTools(): Promise<RemoteTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

/** Factory the engine uses; production default is {@link connectMemoryServer}. */
export type MemoryConnectFn = (
  server: MemoryServerConfig
) => Promise<MemorySession>;

/**
 * Tool-name heuristics, most to least specific. An explicit
 * `server.toolName` bypasses all of this. Order matters: a server
 * exposing both `add_memory` and `delete_memory` must resolve to the
 * former, and `ingest` beats a generic `store`.
 */
const TOOL_NAME_PATTERNS: RegExp[] = [
  /^ingest/i,
  /ingest/i,
  /^(add|store|save|create|upsert|write)[-_ ]?memor/i,
  /memor/i,
  /^(add|store|save|upsert)[-_ ]?(document|content|note|item|knowledge)/i,
  /^(add|store|save|upsert)$/i,
];

/** Names that must never be picked implicitly, whatever else matches. */
const TOOL_NAME_VETO = /(delete|remove|forget|clear|purge|search|query|get|list|read|retrieve)/i;

/**
 * Resolve the ingestion tool from a server's tool list.
 * Returns undefined when nothing matches -- the caller turns that into
 * a user-facing "set a tool name for this server" message.
 */
export function resolveIngestTool(
  tools: RemoteTool[],
  explicitName?: string
): RemoteTool | undefined {
  if (explicitName !== undefined && explicitName.length > 0) {
    return tools.find((t) => t.name === explicitName);
  }
  for (const pattern of TOOL_NAME_PATTERNS) {
    const hit = tools.find(
      (t) => pattern.test(t.name) && !TOOL_NAME_VETO.test(t.name)
    );
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** The document Lite composes for one item. */
export interface IngestPayload {
  itemId: string;
  title: string;
  kind: string;
  spaceId: string;
  spaceName: string;
  /** Composed markdown body (title, description, content, source). */
  document: string;
  contentSha256: string;
}

/** Property names commonly used for the main text body, in priority order. */
const CONTENT_PROP_NAMES = [
  'content',
  'text',
  'information',
  'memory',
  'messages',
  'data',
  'document',
  'body',
  'input',
  'message',
];

/**
 * Map our payload onto the remote tool's input schema.
 *
 * Strategy: find the property that wants the text body (by well-known
 * name, else the first required string property), put the composed
 * document there, then opportunistically fill other recognized
 * properties (title/name, source, id, metadata) when the schema
 * declares them. Throws when no body property can be identified --
 * better a clear per-item failure than a silent garbage call.
 */
export function buildIngestArgs(
  tool: RemoteTool,
  payload: IngestPayload
): Record<string, unknown> {
  const props = tool.inputSchema?.properties ?? {};
  const required = tool.inputSchema?.required ?? [];
  const names = Object.keys(props);

  let bodyProp = CONTENT_PROP_NAMES.find((n) => names.includes(n));
  if (bodyProp === undefined) {
    bodyProp = required.find((n) => {
      const t = props[n]?.type;
      return t === 'string' || t === undefined;
    });
  }
  if (bodyProp === undefined && names.length === 0) {
    // Schema-less tool: send the conventional shape and let the server sort it.
    return { content: payload.document, title: payload.title };
  }
  if (bodyProp === undefined) {
    throw new Error(
      `Tool "${tool.name}" has no recognizable text property -- set an explicit tool name or check the server`
    );
  }

  const args: Record<string, unknown> = { [bodyProp]: payload.document };
  const fillIfDeclared = (name: string, value: unknown): void => {
    if (name !== bodyProp && names.includes(name)) args[name] = value;
  };
  fillIfDeclared('title', payload.title);
  fillIfDeclared('name', payload.title);
  fillIfDeclared('source', `onereach-lite:space/${payload.spaceId}`);
  fillIfDeclared('id', payload.itemId);
  fillIfDeclared('metadata', {
    itemId: payload.itemId,
    spaceId: payload.spaceId,
    space: payload.spaceName,
    kind: payload.kind,
    contentSha256: payload.contentSha256,
  });
  return args;
}

/**
 * Production connect: SDK `Client` over streamable HTTP, bearer auth
 * when the server has an apiKey. Imports are dynamic so the (heavy)
 * SDK only loads when an ingestion actually runs.
 */
export const connectMemoryServer: MemoryConnectFn = async (server) => {
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
  ]);
  const headers: Record<string, string> = {};
  if (server.apiKey !== undefined && server.apiKey.length > 0) {
    headers.Authorization = `Bearer ${server.apiKey}`;
  }
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers },
  });
  const client = new Client(
    { name: 'onereach-lite-memory-ingest', version: '1.0.0' },
    { capabilities: {} }
  );
  // exactOptionalPropertyTypes friction: the SDK's Transport interface
  // declares optional props without `| undefined`. Runtime-compatible.
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
  return {
    async listTools() {
      const res = await client.listTools();
      return res.tools as RemoteTool[];
    },
    async callTool(name, args) {
      const res = await client.callTool({ name, arguments: args });
      // MCP tools report failure in-band; surface it as a throw so the
      // engine records a failure instead of flagging the item ingested.
      if ((res as { isError?: boolean }).isError === true) {
        const content = (res as { content?: Array<{ text?: string }> }).content;
        const text = content?.map((c) => c.text ?? '').join(' ').trim();
        throw new Error(
          text !== undefined && text.length > 0
            ? text
            : `Tool "${name}" reported an error`
        );
      }
    },
    async close() {
      await client.close();
    },
  };
};
