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

// ---------------------------------------------------------------------------
// IPC channel names. All prefixed `lite:neon:` per Rule 3.
// ---------------------------------------------------------------------------

export const NEON_IPC = {
  QUERY: 'lite:neon:query',
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

  ipcMain.handle(
    NEON_IPC.QUERY,
    async (
      _event: IpcMainInvokeEvent,
      payload: { cypher?: unknown; parameters?: unknown }
    ): Promise<{ records: NeonRecord[] }> => {
      getLoggingApi().event(NEON_EVENTS.IPC_QUERY);
      const cypher = validateCypher(payload?.cypher);
      const parameters = validateParameters(payload?.parameters);
      try {
        const records = await getNeonApi().query(cypher, parameters);
        log.info('query ok', { recordCount: records.length });
        return { records };
      } catch (err) {
        if (err instanceof NeonError) {
          log.warn('query rejected', { code: err.code, message: err.message });
          // Surface a JSON-serializable error so the renderer can
          // reconstruct the structure without losing the code.
          // Electron prefixes the rejection's `.message` in the
          // renderer with "Error invoking remote method '<channel>':
          // Error: " before our JSON. The preload's `parseError`
          // strips that prefix by skipping to the first `{`.
          throw new Error(JSON.stringify({ __neonError: err.toJSON() }));
        }
        log.error('query unexpected error', { error: (err as Error).message });
        throw err;
      }
    }
  );

  ipcMain.handle(
    NEON_IPC.STATUS,
    async (_event: IpcMainInvokeEvent): Promise<NeonStatus> => {
      getLoggingApi().event(NEON_EVENTS.IPC_STATUS);
      return getNeonApi().status();
    }
  );

  ipcMain.handle(
    NEON_IPC.TEST_CONNECTION,
    async (_event: IpcMainInvokeEvent): Promise<{ ok: boolean; error?: string; code?: string }> => {
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
    }
  );

  ipcMain.handle(
    NEON_IPC.CONFIGURE,
    async (
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
          throw new Error(JSON.stringify({ __neonError: err.toJSON() }));
        }
        log.error('configure unexpected error', { error: (err as Error).message });
        throw err;
      }
    }
  );

  registered = true;
  log.info('neon initialized', {});
  return { teardown: teardownInternal };
}

function teardownInternal(): void {
  if (!registered) return;
  try {
    ipcMain.removeHandler(NEON_IPC.QUERY);
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

function validateCypher(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('cypher must be a string');
  }
  if (value.length === 0) {
    throw new Error('cypher must be non-empty');
  }
  return value;
}

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
