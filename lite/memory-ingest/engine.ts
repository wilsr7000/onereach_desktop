/**
 * Memory-ingest module -- the space ingestion engine. Per ADR-079.
 *
 * Walks a Space's items and pushes each one to every connected
 * agentic-memory server, EXCEPT (item, server) pairs whose stored flag
 * already matches the item's current content hash. The flag is a JSON
 * document in the `agenticMemory` metadata key (see types.ts), written
 * through `items.patchMetadata` -- a per-key merge, so concurrent user
 * edits to other metadata are never clobbered.
 *
 * The skip test is hash equality, not existence: editing an item (or
 * replacing a file) changes the hash, which silently re-arms the pair.
 * "Already ingested" is therefore always content-true.
 *
 * All effects are injected (spaces api slice, server list, connect fn,
 * clock) so the engine is a pure unit under test.
 */

import { createHash } from 'node:crypto';
import {
  buildIngestArgs,
  resolveIngestTool,
  type IngestPayload,
  type MemoryConnectFn,
  type MemorySession,
  type RemoteTool,
} from './client.js';
import {
  INGEST_FLAG_KEY,
  type IngestFlags,
  type IngestProgress,
  type IngestRunSummary,
  type MemoryServerConfig,
} from './types.js';

/** The item shape the engine reads (subset of spaces `Item`). */
export interface EngineItem {
  id: string;
  title: string;
  kind: string;
  content?: string;
  description?: string;
  sourceUrl?: string;
  metadata?: Record<string, unknown>;
}

/** The spaces surface the engine needs, main-process side. */
export interface EngineSpacesApi {
  listItemIds(spaceId: string): Promise<string[]>;
  getItem(id: string): Promise<EngineItem>;
  patchMetadata(id: string, patch: Record<string, string>): Promise<void>;
  getSpaceName(spaceId: string): Promise<string>;
}

/** Parse the stored flag; malformed values degrade to "nothing ingested". */
export function parseIngestFlags(raw: unknown): IngestFlags {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const out: IngestFlags = {};
    for (const [sid, rec] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        typeof rec === 'object' &&
        rec !== null &&
        typeof (rec as { sha?: unknown }).sha === 'string'
      ) {
        const r = rec as { sha: string; at?: unknown; name?: unknown };
        out[sid] = {
          sha: r.sha,
          at: typeof r.at === 'string' ? r.at : '',
          name: typeof r.name === 'string' ? r.name : '',
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Content identity for the skip test. Binary uploads already carry
 * `metadata.contentSha256` (stamped at intake, ADR batch-intake work);
 * text-ish items hash their visible fields. Either way the identity
 * moves when the content moves.
 */
export function itemContentSha(item: EngineItem): string {
  const stamped = item.metadata?.contentSha256;
  if (typeof stamped === 'string' && stamped.length > 0) return stamped;
  const basis = [
    item.title,
    item.description ?? '',
    item.content ?? '',
    item.sourceUrl ?? '',
  ].join('\n');
  return createHash('sha256').update(basis, 'utf8').digest('hex');
}

/** Compose the markdown document a memory server receives for one item. */
export function composeDocument(item: EngineItem, spaceName: string): string {
  const lines: string[] = [`# ${item.title}`, ''];
  lines.push(`Space: ${spaceName} | Kind: ${item.kind}`);
  if (item.sourceUrl !== undefined && item.sourceUrl.length > 0) {
    lines.push(`Source: ${item.sourceUrl}`);
  }
  lines.push('');
  if (item.description !== undefined && item.description.length > 0) {
    lines.push(item.description, '');
  }
  if (item.content !== undefined && item.content.length > 0) {
    lines.push(item.content);
  }
  return lines.join('\n').trim();
}

export interface IngestSpaceDeps {
  spaces: EngineSpacesApi;
  servers: MemoryServerConfig[];
  connect: MemoryConnectFn;
  onProgress?: (beat: IngestProgress) => void;
  nowIso?: () => string;
}

/** Seeded up front, but the accessor keeps index reads total. */
function perServerEntry(
  summary: IngestRunSummary,
  id: string,
  name: string
): { name: string; sent: number; skipped: number; failed: number } {
  const existing = summary.perServer[id];
  if (existing !== undefined) return existing;
  const fresh = { name, sent: 0, skipped: 0, failed: 0 };
  summary.perServer[id] = fresh;
  return fresh;
}

interface ServerSession {
  server: MemoryServerConfig;
  session?: MemorySession;
  tool?: RemoteTool;
  /** A connect/resolve failure poisons the server for the whole run. */
  fatal?: string;
}

/**
 * Run one space ingestion. Never throws for per-item or per-server
 * trouble -- every failure lands in the summary; only a broken items
 * listing (permissions, network) rejects.
 */
export async function ingestSpace(
  spaceId: string,
  deps: IngestSpaceDeps
): Promise<IngestRunSummary> {
  const nowIso = deps.nowIso ?? ((): string => new Date().toISOString());
  const summary: IngestRunSummary = {
    spaceId,
    items: 0,
    sent: 0,
    skipped: 0,
    failed: [],
    perServer: {},
  };
  for (const s of deps.servers) {
    summary.perServer[s.id] = { name: s.name, sent: 0, skipped: 0, failed: 0 };
  }
  if (deps.servers.length === 0) return summary;

  const spaceName = await deps.spaces.getSpaceName(spaceId);
  const ids = await deps.spaces.listItemIds(spaceId);
  summary.items = ids.length;

  // Sessions connect lazily -- a run where every pair is up-to-date
  // never opens a socket at all.
  const sessions: ServerSession[] = deps.servers.map((server) => ({ server }));
  const ensureSession = async (
    s: ServerSession
  ): Promise<{ session: MemorySession; tool: RemoteTool } | { error: string }> => {
    if (s.fatal !== undefined) return { error: s.fatal };
    if (s.session !== undefined && s.tool !== undefined) {
      return { session: s.session, tool: s.tool };
    }
    try {
      const session = await deps.connect(s.server);
      const tools = await session.listTools();
      const tool = resolveIngestTool(tools, s.server.toolName);
      if (tool === undefined) {
        await session.close().catch(() => undefined);
        s.fatal =
          s.server.toolName !== undefined
            ? `Tool "${s.server.toolName}" not found on ${s.server.name}`
            : `No ingestion tool recognized on ${s.server.name} -- set a tool name in Settings`;
        return { error: s.fatal };
      }
      s.session = session;
      s.tool = tool;
      return { session, tool };
    } catch (err) {
      s.fatal = `Could not connect to ${s.server.name}: ${(err as Error).message}`;
      return { error: s.fatal };
    }
  };

  try {
    let index = 0;
    for (const id of ids) {
      index += 1;
      let item: EngineItem;
      try {
        item = await deps.spaces.getItem(id);
      } catch (err) {
        // Unreadable item: one failure row per server keeps rollups honest.
        for (const s of deps.servers) {
          summary.failed.push({
            itemId: id,
            itemTitle: id,
            serverId: s.id,
            serverName: s.name,
            message: `Could not read item: ${(err as Error).message}`,
          });
          perServerEntry(summary, s.id, s.name).failed += 1;
        }
        continue;
      }
      const sha = itemContentSha(item);
      const flags = parseIngestFlags(item.metadata?.[INGEST_FLAG_KEY]);
      let flagsDirty = false;

      for (const s of sessions) {
        const per = perServerEntry(summary, s.server.id, s.server.name);
        const beatBase = {
          itemId: item.id,
          itemTitle: item.title,
          serverId: s.server.id,
          serverName: s.server.name,
          index,
          total: ids.length,
        };
        if (flags[s.server.id]?.sha === sha) {
          summary.skipped += 1;
          per.skipped += 1;
          deps.onProgress?.({ ...beatBase, outcome: 'skipped' });
          continue;
        }
        const ready = await ensureSession(s);
        if ('error' in ready) {
          summary.failed.push({ ...beatBase, message: ready.error });
          per.failed += 1;
          deps.onProgress?.({ ...beatBase, outcome: 'failed', message: ready.error });
          continue;
        }
        const payload: IngestPayload = {
          itemId: item.id,
          title: item.title,
          kind: item.kind,
          spaceId,
          spaceName,
          document: composeDocument(item, spaceName),
          contentSha256: sha,
        };
        try {
          const args = buildIngestArgs(ready.tool, payload);
          await ready.session.callTool(ready.tool.name, args);
          flags[s.server.id] = { sha, at: nowIso(), name: s.server.name };
          flagsDirty = true;
          summary.sent += 1;
          per.sent += 1;
          deps.onProgress?.({ ...beatBase, outcome: 'sent' });
        } catch (err) {
          const message = (err as Error).message;
          summary.failed.push({ ...beatBase, message });
          per.failed += 1;
          deps.onProgress?.({ ...beatBase, outcome: 'failed', message });
        }
      }

      if (flagsDirty) {
        try {
          await deps.spaces.patchMetadata(item.id, {
            [INGEST_FLAG_KEY]: JSON.stringify(flags),
          });
        } catch (err) {
          // The push succeeded but the flag didn't stick: report it,
          // because the pair will re-send next run (harmless for a
          // memory store, but the user should know writes are failing).
          for (const s of deps.servers) {
            if (flags[s.id]?.sha === sha && parseIngestFlags(item.metadata?.[INGEST_FLAG_KEY])[s.id]?.sha !== sha) {
              summary.failed.push({
                itemId: item.id,
                itemTitle: item.title,
                serverId: s.id,
                serverName: s.name,
                message: `Ingested but flag write failed: ${(err as Error).message}`,
              });
            }
          }
        }
      }
    }
  } finally {
    await Promise.all(
      sessions.map((s) => s.session?.close().catch(() => undefined))
    );
  }
  return summary;
}
