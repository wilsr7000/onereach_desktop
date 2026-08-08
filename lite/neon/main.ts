/**
 * Neon main-process orchestration.
 *
 * Owns:
 *   - IPC handlers for `lite:neon:query`, `lite:neon:status`,
 *     `lite:neon:test-connection`, `lite:neon:configure`
 *   - Lazy hydration / passthrough to the `NeonApi` singleton
 *
 * Per ADR-019 / Rule 11, this module is the boundary between Electron
 * IPC and the typed `NeonApi`. Renderers never see `EdisonNeonClient`
 * directly.
 *
 * Per ADR-030, every handler emits an instant `neon.ipc.<verb>` event
 * on entry so renderer-driven activity is observable in `/logs`.
 *
 * Renderer side lives in `preload-lite.ts` (`window.lite.neon`) and
 * the Settings -> Neon section in `lite/settings/sections/neon.ts`.
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { getNeonApi, NeonError, _resetNeonApiForTesting } from './api.js';
import { NEON_EVENTS } from './events.js';
import type { NeonConfig, NeonRecord, NeonStatus } from './types.js';
import { getLoggingApi } from '../logging/api.js';
import { getNamedQuery } from './named-queries.js';
import { wrapIpcHandler } from '../errors.js';

/**
 * Marker key for the renderer's `parseError` (preload-lite.ts). Every
 * handler is registered through `wrapIpcHandler` with this marker so
 * unknown errors reach the renderer as `{ code: 'UNKNOWN', message }`
 * instead of Electron's generic "Error invoking remote method"
 * (2026-08-08 hardening review).
 */
const IPC_ERROR_MARKER = '__neonError';

// ---------------------------------------------------------------------------
// IPC channel names. All prefixed `lite:neon:` per Rule 3.
// ---------------------------------------------------------------------------

export const NEON_IPC = {
  QUERY_NAMED: 'lite:neon:query-named',
  STATUS: 'lite:neon:status',
  TEST_CONNECTION: 'lite:neon:test-connection',
  CONFIGURE: 'lite:neon:configure',
} as const;

// ---------------------------------------------------------------------------
// Init / teardown
// ---------------------------------------------------------------------------

export interface InitNeonOptions {
  /** Optional logger -- routed through lite logging by default in api.ts. */
  logger?: {
    info: (message: string, data?: unknown) => void;
    warn: (message: string, data?: unknown) => void;
    error: (message: string, data?: unknown) => void;
  };
}

export interface NeonHandle {
  /** Tear down IPC handlers. Idempotent. */
  teardown(): void;
}

let registered = false;

/**
 * Register IPC handlers. Safe to call multiple times -- subsequent
 * calls are no-ops.
 */
export function initNeon(opts: InitNeonOptions = {}): NeonHandle {
  const log = opts.logger ?? {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  if (registered) {
    return { teardown: teardownInternal };
  }

  // N4 (2026-08-07 graph review): the raw `lite:neon:query` channel is
  // GONE. It accepted arbitrary Cypher from any Lite renderer with a
  // "non-empty string" check. Renderers now invoke fixed queries BY
  // NAME from the registry modules populate at init — the Cypher text
  // never crosses IPC, so a compromised renderer can pick from the
  // menu but never write it. Main-process modules are unaffected: they
  // keep calling getNeonApi().query() directly.
  ipcMain.handle(
    NEON_IPC.QUERY_NAMED,
    wrapIpcHandler(IPC_ERROR_MARKER, async (
      _event: IpcMainInvokeEvent,
      payload: { name?: unknown; parameters?: unknown }
    ): Promise<{ records: NeonRecord[] }> => {
      getLoggingApi().event(NEON_EVENTS.IPC_QUERY);
      const name = typeof payload?.name === 'string' ? payload.name : '';
      const cypher = getNamedQuery(name);
      if (cypher === null) {
        log.warn('named query rejected: unknown name', { name: name.slice(0, 80) });
        throw new Error(
          JSON.stringify({
            __neonError: {
              name: 'NeonError',
              code: 'NEON_INVALID_INPUT',
              message: `Unknown named query: ${name.slice(0, 80)}`,
              context: {},
              remediation:
                'Renderers may only run queries registered at init. Register it in the owning module.',
            },
          })
        );
      }
      const parameters = validateParameters(payload?.parameters);
      try {
        const records = await getNeonApi().query(cypher, parameters);
        log.info('named query ok', { name, recordCount: records.length });
        return { records };
      } catch (err) {
        if (err instanceof NeonError) {
          log.warn('named query rejected', { name, code: err.code });
        } else {
          log.error('named query unexpected error', { name, error: (err as Error).message });
        }
        // wrapIpcHandler envelopes: typed errors keep their code,
        // anything else crosses as UNKNOWN.
        throw err;
      }
    })
  );

  ipcMain.handle(
    NEON_IPC.STATUS,
    wrapIpcHandler(IPC_ERROR_MARKER, async (_event: IpcMainInvokeEvent): Promise<NeonStatus> => {
      getLoggingApi().event(NEON_EVENTS.IPC_STATUS);
      return getNeonApi().status();
    })
  );

  ipcMain.handle(
    NEON_IPC.TEST_CONNECTION,
    wrapIpcHandler(IPC_ERROR_MARKER, async (_event: IpcMainInvokeEvent): Promise<{ ok: boolean; error?: string; code?: string }> => {
      getLoggingApi().event(NEON_EVENTS.IPC_TEST_CONNECTION);
      try {
        const ok = await getNeonApi().ping();
        log.info('test-connection ok', { ok });
        return { ok };
      } catch (err) {
        if (err instanceof NeonError) {
          log.warn('test-connection rejected', { code: err.code, message: err.message });
          return {
            ok: false,
            error: err.formatForUser(),
            code: err.code,
          };
        }
        log.error('test-connection unexpected error', { error: (err as Error).message });
        return {
          ok: false,
          error: (err as Error).message,
        };
      }
    })
  );

  ipcMain.handle(
    NEON_IPC.CONFIGURE,
    wrapIpcHandler(IPC_ERROR_MARKER, async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<{ ok: true; status: NeonStatus }> => {
      getLoggingApi().event(NEON_EVENTS.IPC_CONFIGURE);
      const config = validateConfig(payload);
      try {
        await getNeonApi().configure(config);
        const status = await getNeonApi().status();
        log.info('configure ok', { fields: Object.keys(config) });
        return { ok: true, status };
      } catch (err) {
        if (err instanceof NeonError) {
          log.warn('configure rejected', { code: err.code, message: err.message });
        } else {
          log.error('configure unexpected error', { error: (err as Error).message });
        }
        throw err;
      }
    })
  );

  registered = true;
  log.info('neon initialized', {});
  return { teardown: teardownInternal };
}

function teardownInternal(): void {
  if (!registered) return;
  try {
    ipcMain.removeHandler(NEON_IPC.QUERY_NAMED);
    ipcMain.removeHandler(NEON_IPC.STATUS);
    ipcMain.removeHandler(NEON_IPC.TEST_CONNECTION);
    ipcMain.removeHandler(NEON_IPC.CONFIGURE);
  } catch {
    // best-effort
  }
  registered = false;
}

/** @internal -- exposed for tests. */
export function _isNeonRegisteredForTesting(): boolean {
  return registered;
}

/** @internal -- exposed for tests so they can re-init cleanly. */
export function _resetNeonRegistrationForTesting(): void {
  teardownInternal();
  _resetNeonApiForTesting();
}

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------


function validateParameters(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('parameters must be a plain object');
  }
  return value as Record<string, unknown>;
}

function validateConfig(value: unknown): NeonConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('config must be a plain object');
  }
  const c = value as Record<string, unknown>;
  const out: NeonConfig = {};
  if (c['endpoint'] !== undefined) {
    if (typeof c['endpoint'] !== 'string') throw new Error('endpoint must be a string');
    out.endpoint = c['endpoint'];
  }
  if (c['uri'] !== undefined) {
    if (typeof c['uri'] !== 'string') throw new Error('uri must be a string');
    out.uri = c['uri'];
  }
  if (c['user'] !== undefined) {
    if (typeof c['user'] !== 'string') throw new Error('user must be a string');
    out.user = c['user'];
  }
  if (c['password'] !== undefined) {
    if (typeof c['password'] !== 'string') throw new Error('password must be a string');
    out.password = c['password'];
  }
  if (c['database'] !== undefined) {
    if (typeof c['database'] !== 'string') throw new Error('database must be a string');
    out.database = c['database'];
  }
  return out;
}
