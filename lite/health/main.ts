/**
 * Health main-process orchestration.
 *
 * Owns:
 *   - The default `HealthApi` singleton (real `HealthStore`-backed
 *     implementation wired to the live module readers).
 *   - One IPC channel: `lite:health:snapshot` -- lets renderers
 *     fetch a current-state snapshot.
 *
 * The store reads from `getAuthApi()`, `getTotpApi()`, `getNeonApi()`,
 * `readUpdateState()`, and `getLoggingApi().recent()`. Each read is
 * wrapped in best-effort try/catch in the store so a missing or
 * misbehaving module never poisons the whole snapshot.
 *
 * @internal -- consumers go through `getHealthApi()` (renderer:
 * `window.lite.health.snapshot()`).
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { _setHealthApiForTesting, _resetHealthApiForTesting, makeHealthApi } from './api.js';
import type { AppHealthSnapshot } from './types.js';
import { getAuthApi } from '../auth/api.js';
import { getTotpApi } from '../totp/api.js';
import { getNeonApi } from '../neon/api.js';
import { getLoggingApi } from '../logging/api.js';
import { readUpdateState } from '../updater/state.js';

// IPC channel name. Per Rule 3, prefixed `lite:health:`.
export const HEALTH_IPC = {
  SNAPSHOT: 'lite:health:snapshot',
} as const;

export interface InitHealthOptions {
  /** Lite version (NOT app.getVersion()). */
  version: string;
  /** Wall-clock ms epoch when the app process started (for uptime). */
  startedAt: number;
  /** Resolved `app.getPath('userData')`. */
  userDataPath: string;
  /** Optional logger (defaults to silent). */
  logger?: {
    info: (message: string, data?: unknown) => void;
    warn: (message: string, data?: unknown) => void;
    error: (message: string, data?: unknown) => void;
  };
}

export interface HealthHandle {
  /** Tear down IPC handlers + reset the singleton. Idempotent. */
  teardown(): void;
}

let registered = false;

/**
 * Register the IPC handler and install the real store-backed
 * `HealthApi` singleton. Safe to call multiple times -- idempotent.
 */
export function initHealth(opts: InitHealthOptions): HealthHandle {
  const log = opts.logger ?? {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  // Wire the store with live module readers. Each reader adapts the
  // foreign module's public interface to the narrow shape the store
  // expects. Adapters intentionally call only `<module>/api.ts` --
  // never reach into internals (Rule 11).
  const api = makeHealthApi({
    version: opts.version,
    startedAt: opts.startedAt,
    userDataPath: opts.userDataPath,
    logger: { warn: (msg, data) => log.warn(msg, data) },
    auth: {
      getSession: (env) => {
        const s = getAuthApi().getSession(env);
        if (s === null) return null;
        const out: { accountId: string; email?: string; expiresAt?: number } = {
          accountId: s.accountId,
        };
        if (s.email !== undefined) out.email = s.email;
        if (s.expiresAt !== undefined) out.expiresAt = s.expiresAt;
        return out;
      },
      getToken: (env) => getAuthApi().getToken(env),
    },
    totp: {
      hasSecret: () => getTotpApi().hasSecret(),
      getMetadata: async () => {
        const m = await getTotpApi().getMetadata();
        if (m === null) return null;
        const out: { issuer?: string; account?: string; secretLength?: number } = {};
        if (m.issuer !== undefined) out.issuer = m.issuer;
        if (m.account !== undefined) out.account = m.account;
        if (typeof m.secretLength === 'number') out.secretLength = m.secretLength;
        return out;
      },
      getCurrentCode: async () => {
        const c = await getTotpApi().getCurrentCode();
        return { timeRemaining: c.timeRemaining };
      },
    },
    neon: {
      status: () => getNeonApi().status(),
    },
    updater: {
      read: () => readUpdateState(opts.userDataPath),
    },
    diagnostics: {
      recent: (pattern, limit) => {
        const events = getLoggingApi().recent(pattern, limit);
        return events.map((e) => ({
          name: e.name,
          level: e.level,
          ...(e.data !== undefined ? { data: e.data } : {}),
          ...(e.error !== undefined ? { error: e.error } : { error: null }),
        }));
      },
    },
    // `windows` is left unset so the store falls back to the real
    // `BrowserWindow.getAllWindows()` registry.
  });

  _setHealthApiForTesting(api);

  if (registered) {
    return { teardown: teardownInternal };
  }

  ipcMain.handle(
    HEALTH_IPC.SNAPSHOT,
    async (_event: IpcMainInvokeEvent): Promise<AppHealthSnapshot> => {
      return api.snapshot();
    }
  );

  registered = true;
  log.info('health initialized');
  return { teardown: teardownInternal };
}

function teardownInternal(): void {
  if (!registered) return;
  try {
    ipcMain.removeHandler(HEALTH_IPC.SNAPSHOT);
  } catch {
    /* best-effort */
  }
  registered = false;
  _resetHealthApiForTesting();
}

/** @internal -- exposed for tests. */
export function _isHealthRegisteredForTesting(): boolean {
  return registered;
}

/** @internal -- exposed for tests so they can re-init cleanly. */
export function _resetHealthRegistrationForTesting(): void {
  teardownInternal();
}
