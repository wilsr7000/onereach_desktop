/**
 * Memory-ingest module -- shared types. Per ADR-079.
 *
 * Lite acts as an MCP *client* here (the inverse of `lite/mcp/spaces-mcp.ts`,
 * where Lite is the server): the user connects one or more external
 * "agentic memory" MCP servers, and Space items are pushed to them for
 * ingestion. Each item carries a per-server flag keyed to its content
 * hash, so "already ingested" is content-true, not a sticky boolean --
 * editing an item automatically makes it pending again.
 */

/** One configured agentic-memory MCP server. */
export interface MemoryServerConfig {
  /** Stable id (crypto.randomUUID at add time). */
  id: string;
  /** User-facing label ("Team memory", "Mem0 prod"). */
  name: string;
  /** Streamable-HTTP MCP endpoint URL. */
  url: string;
  /**
   * Optional bearer credential. Sent as `Authorization: Bearer <key>`
   * on every MCP request. Stored in the user's own OAGI KV alongside
   * the rest of the Lite config -- same trust boundary as the Neon
   * settings (ADR-070), never written to disk in the repo.
   */
  apiKey?: string;
  /**
   * Optional explicit tool name. When absent the client resolves the
   * ingestion tool from the server's `tools/list` by name heuristics
   * (see `resolveIngestTool`). An explicit name always wins.
   */
  toolName?: string;
  /** ISO timestamp of when the server was added. */
  createdAt: string;
}

/**
 * Per-server ingestion record stored on the item, JSON-encoded into the
 * `agenticMemory` metadata key (a plain string value, so it rides the
 * existing `items.patchMetadata` merge surface and is visible in the
 * item's metadata table).
 */
export interface IngestRecord {
  /** Content hash (sha256 hex) at the time of ingestion. */
  sha: string;
  /** ISO timestamp of the successful ingestion. */
  at: string;
  /** Server name at ingestion time (survives server removal). */
  name: string;
}

/** The whole flag: serverId -> record. */
export type IngestFlags = Record<string, IngestRecord>;

/** Metadata key carrying the JSON-encoded {@link IngestFlags}. */
export const INGEST_FLAG_KEY = 'agenticMemory';

/** Per-item outcome inside a space run. */
export type IngestItemOutcome = 'sent' | 'skipped' | 'failed';

/** Progress beat emitted while a space run walks its items. */
export interface IngestProgress {
  itemId: string;
  itemTitle: string;
  serverId: string;
  serverName: string;
  outcome: IngestItemOutcome;
  /** Present when outcome === 'failed'. */
  message?: string;
  /** 1-based position of the item in the run. */
  index: number;
  total: number;
}

/** Failure detail collected across a run. */
export interface IngestFailure {
  itemId: string;
  itemTitle: string;
  serverId: string;
  serverName: string;
  message: string;
}

/** Summary returned by a space ingestion run. */
export interface IngestRunSummary {
  spaceId: string;
  /** Items examined (space members at run start). */
  items: number;
  /** (item, server) pairs actually pushed this run. */
  sent: number;
  /** (item, server) pairs skipped because the flag matched the hash. */
  skipped: number;
  failed: IngestFailure[];
  /** Per-server rollup, keyed by server id. */
  perServer: Record<
    string,
    { name: string; sent: number; skipped: number; failed: number }
  >;
}
