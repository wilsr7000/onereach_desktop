/**
 * NEON bridge — main-process wiring. Per ADR-081.
 *
 * Adapts the gated `SpacesApi` to the bridge's `NeonReads` and starts
 * the loopback HTTP server. Every read goes through `getSpacesApi()`,
 * which is bound to the signed-in viewer (ADR-051), so the bridge is
 * viewer-scoped for free — a web app calling it acts as the signed-in
 * user and sees only what that user may see.
 */

import { getSpacesApi } from '../spaces/api.js';
import { getSignedInViewerId } from '../spaces/main.js';
import { resolveSpaceScope } from '../spaces/scope.js';
import { getLoggingApi } from '../logging/api.js';
import { startNeonBridge, type NeonReads, type NeonBridgeServer } from './server.js';

let server: NeonBridgeServer | null = null;

/** SpacesApi → NeonReads. Read-only slice; nothing here mutates. */
function spacesReads(): NeonReads {
  return {
    whoAmI: async () => getSignedInViewerId(),
    listSpaces: () => getSpacesApi().listSpaces(),
    listItems: (spaceId) =>
      getSpacesApi().items.list(resolveSpaceScope(spaceId), { limit: 500 }),
    getItem: (id) => getSpacesApi().items.get(id),
    search: (query, spaceId) =>
      getSpacesApi().items.search(
        spaceId !== undefined && spaceId.length > 0 ? { query, spaceId } : { query }
      ),
  };
}

export interface NeonBridgeHandle {
  readonly port: number;
  teardown(): Promise<void>;
}

/**
 * Start the NEON bridge. Idempotent — a second call returns the running
 * handle. Failure to bind is logged, not thrown: the bridge is an
 * accelerant for web apps, never a boot dependency.
 */
export async function initNeonBridge(
  opts: { port?: number } = {}
): Promise<NeonBridgeHandle | null> {
  if (server !== null) {
    return { port: server.port, teardown: teardownNeonBridge };
  }
  try {
    server = await startNeonBridge(
      {
        reads: spacesReads(),
        logger: {
          info: (msg, data) => getLoggingApi().info('neon-bridge', msg, data),
          warn: (msg, data) => getLoggingApi().warn('neon-bridge', msg, data),
        },
      },
      opts.port !== undefined ? { port: opts.port } : {}
    );
    return { port: server.port, teardown: teardownNeonBridge };
  } catch (err) {
    getLoggingApi().error('neon-bridge', 'failed to start', {
      error: (err as Error).message,
    });
    server = null;
    return null;
  }
}

export async function teardownNeonBridge(): Promise<void> {
  if (server === null) return;
  const s = server;
  server = null;
  await s.close();
}
