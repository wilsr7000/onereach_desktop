/**
 * Memory-ingest module -- IPC surface. Per ADR-079.
 *
 * Channels the Settings window (server CRUD) and the Spaces window
 * (ingest runs) invoke. Mirrors the spaces envelope convention:
 * `{ok:true,value}` | `{ok:false,error:{message}}` because Errors do
 * not serialize losslessly through `ipcMain.handle`.
 *
 * Credential rule (same as the Neon password, ADR-070): the API key is
 * WRITE-ONLY across this boundary. `listServers` returns `hasApiKey`,
 * never the key itself -- no renderer ever holds a memory-server
 * credential after the add form clears.
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { getKVApi } from '../kv/api.js';
import { getLoggingApi } from '../logging/api.js';
import { getSpacesApi } from '../spaces/api.js';
import { resolveSpaceScope } from '../spaces/scope.js';
import { connectMemoryServer, resolveIngestTool } from './client.js';
import { ingestSpace, type EngineSpacesApi } from './engine.js';
import { addServer, listServers, removeServer } from './store.js';
import type { IngestRunSummary, MemoryServerConfig } from './types.js';

export const MEMORY_IPC = {
  LIST_SERVERS: 'lite:memory:listServers',
  ADD_SERVER: 'lite:memory:addServer',
  REMOVE_SERVER: 'lite:memory:removeServer',
  TEST_SERVER: 'lite:memory:testServer',
  INGEST_SPACE: 'lite:memory:ingestSpace',
  /** Push channel: `IngestProgress` beats stream to the invoking window. */
  INGEST_PROGRESS: 'lite:memory:ingestProgress',
} as const;

export type MemoryIpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { message: string } };

/** What the renderer sees of a server -- credential projected to a flag. */
export interface MemoryServerView {
  id: string;
  name: string;
  url: string;
  hasApiKey: boolean;
  toolName?: string;
  createdAt: string;
}

function toView(s: MemoryServerConfig): MemoryServerView {
  const view: MemoryServerView = {
    id: s.id,
    name: s.name,
    url: s.url,
    hasApiKey: typeof s.apiKey === 'string' && s.apiKey.length > 0,
    createdAt: s.createdAt,
  };
  if (s.toolName !== undefined) view.toolName = s.toolName;
  return view;
}

function fail(err: unknown): { ok: false; error: { message: string } } {
  return { ok: false, error: { message: (err as Error).message } };
}

/** Adapter: the engine's spaces slice over the real SpacesApi. */
function engineSpaces(): EngineSpacesApi {
  const api = getSpacesApi();
  return {
    async listItemIds(spaceId) {
      const items = await api.items.list(resolveSpaceScope(spaceId), {
        limit: 500,
      });
      return items.map((i) => i.id);
    },
    async getItem(id) {
      const item = await api.items.get(id);
      if (item === null) throw new Error(`Item ${id} not found`);
      return item;
    },
    async patchMetadata(id, patch) {
      await api.items.patchMetadata(id, patch);
    },
    async getSpaceName(spaceId) {
      const spaces = await api.listSpaces();
      return spaces.find((s) => s.id === spaceId)?.name ?? 'Space';
    },
  };
}

let registered = false;

type Handler = Parameters<typeof ipcMain.handle>[1];

function handleMemoryIpc(channel: string, handler: Handler): void {
  const register = ipcMain.handle.bind(ipcMain);
  const verb = channel.replace(/^lite:memory:/, '');
  register(channel, (event, ...args) => {
    getLoggingApi().event(`memory.ipc.${verb}`);
    return handler(event, ...args);
  });
}

/** Register every memory-ingest IPC handler. Idempotent. */
export function registerMemoryIngestIpc(): void {
  if (registered) return;

  handleMemoryIpc(
    MEMORY_IPC.LIST_SERVERS,
    async (): Promise<MemoryIpcResult<MemoryServerView[]>> => {
      try {
        const servers = await listServers(getKVApi());
        return { ok: true, value: servers.map(toView) };
      } catch (err) {
        return fail(err);
      }
    }
  );

  handleMemoryIpc(
    MEMORY_IPC.ADD_SERVER,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { name?: unknown; url?: unknown; apiKey?: unknown; toolName?: unknown }
    ): Promise<MemoryIpcResult<MemoryServerView>> => {
      try {
        const input: Parameters<typeof addServer>[1] = {
          name: typeof payload?.name === 'string' ? payload.name : '',
          url: typeof payload?.url === 'string' ? payload.url : '',
        };
        if (typeof payload?.apiKey === 'string') input.apiKey = payload.apiKey;
        if (typeof payload?.toolName === 'string') input.toolName = payload.toolName;
        const record = await addServer(getKVApi(), input);
        return { ok: true, value: toView(record) };
      } catch (err) {
        return fail(err);
      }
    }
  );

  handleMemoryIpc(
    MEMORY_IPC.REMOVE_SERVER,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { id?: unknown }
    ): Promise<MemoryIpcResult<null>> => {
      try {
        const id = typeof payload?.id === 'string' ? payload.id : '';
        if (id.length === 0) throw new Error('Server id is required');
        await removeServer(getKVApi(), id);
        return { ok: true, value: null };
      } catch (err) {
        return fail(err);
      }
    }
  );

  handleMemoryIpc(
    MEMORY_IPC.TEST_SERVER,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { id?: unknown }
    ): Promise<MemoryIpcResult<{ toolCount: number; ingestTool: string | null }>> => {
      try {
        const id = typeof payload?.id === 'string' ? payload.id : '';
        const server = (await listServers(getKVApi())).find((s) => s.id === id);
        if (server === undefined) throw new Error('Server not found');
        const session = await connectMemoryServer(server);
        try {
          const tools = await session.listTools();
          const tool = resolveIngestTool(tools, server.toolName);
          return {
            ok: true,
            value: { toolCount: tools.length, ingestTool: tool?.name ?? null },
          };
        } finally {
          await session.close().catch(() => undefined);
        }
      } catch (err) {
        return fail(err);
      }
    }
  );

  handleMemoryIpc(
    MEMORY_IPC.INGEST_SPACE,
    async (
      event: IpcMainInvokeEvent,
      payload?: { spaceId?: unknown }
    ): Promise<MemoryIpcResult<IngestRunSummary>> => {
      try {
        const spaceId =
          typeof payload?.spaceId === 'string' ? payload.spaceId : '';
        if (spaceId.length === 0) throw new Error('spaceId is required');
        const servers = await listServers(getKVApi());
        if (servers.length === 0) {
          throw new Error(
            'No agentic memory connected -- add one in Settings > Agentic memory'
          );
        }
        const summary = await ingestSpace(spaceId, {
          spaces: engineSpaces(),
          servers,
          connect: connectMemoryServer,
          onProgress: (beat) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send(MEMORY_IPC.INGEST_PROGRESS, beat);
            }
          },
        });
        getLoggingApi().event('memory.ingest.finish', {
          spaceId,
          sent: summary.sent,
          skipped: summary.skipped,
          failed: summary.failed.length,
        });
        return { ok: true, value: summary };
      } catch (err) {
        return fail(err);
      }
    }
  );

  registered = true;
}

/** Remove every handler (test teardown symmetry). */
export function unregisterMemoryIngestIpc(): void {
  if (!registered) return;
  for (const channel of Object.values(MEMORY_IPC)) {
    if (channel === MEMORY_IPC.INGEST_PROGRESS) continue;
    ipcMain.removeHandler(channel);
  }
  registered = false;
}
