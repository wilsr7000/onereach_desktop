/**
 * Health module -- PUBLIC API.
 *
 * Per ADR-019 / Rule 11 in `lite/LITE-RULES.md`, cross-module imports
 * go through `<module>/api.ts` -- never reach into `store.ts` or
 * `main.ts`.
 *
 * Health answers "what is true right now?" -- a pull-based current-
 * state snapshot across documented lite modules. The counterpart to
 * the central event log (which answers "what happened over time?").
 * No mutable state is maintained; every call re-reads.
 *
 * Usage from another module:
 *
 *   import { getHealthApi } from '../health/api.js';
 *   const snap = await getHealthApi().snapshot();
 *   console.log(snap.auth.signedIn, snap.totp.configured);
 *
 * Tests: `_setHealthApiForTesting(stub)` injects a custom
 * implementation, `_resetHealthApiForTesting()` clears the singleton.
 *
 * Security: the snapshot type (and its branches in `types.ts`) has
 * NO fields for secrets. Token values, TOTP code/secret, and Neon
 * passwords cannot be expressed in the type and are not produced by
 * the default store. See `lite/health/README.md` "Security posture."
 */

import { HealthStore } from './store.js';
import type { HealthStoreConfig } from './store.js';
import type { AppHealthSnapshot } from './types.js';

// Re-export shape types for consumers (renderer types in
// lite-window.d.ts mirror these).
export type {
  AppHealthSnapshot,
  HealthAppSnapshot,
  HealthWindowSnapshot,
  HealthAuthSnapshot,
  HealthTotpSnapshot,
  HealthNeonSnapshot,
  HealthUpdaterSnapshot,
  HealthDiagnosticsSnapshot,
} from './types.js';
export { HEALTH_SCHEMA_VERSION } from './types.js';

/**
 * The public surface of the health module.
 *
 * **Error contract**: `snapshot()` is best-effort and never throws.
 * If every backing module fails, the returned snapshot is a fully
 * populated object with safe fallback values in each section (e.g.
 * `auth.signedIn = false`, `totp.configured = false`).
 */
export interface HealthApi {
  /**
   * Build a fresh snapshot of "what is true right now" across
   * documented lite modules. Best-effort: missing or failing
   * sections produce safe fallbacks rather than throwing.
   *
   * @returns A complete `AppHealthSnapshot`. Always resolved; never
   *   rejects.
   *
   * @example
   * ```typescript
   * import { getHealthApi } from '../health/api.js';
   * const snap = await getHealthApi().snapshot();
   * if (!snap.auth.signedIn) showSignInPrompt();
   * ```
   */
  snapshot(): Promise<AppHealthSnapshot>;
}

/**
 * Default backing implementation. Wired by `lite/health/main.ts`
 * via `_setHealthApiForTesting()` once `initHealth()` runs.
 *
 * Until then, calls to `getHealthApi().snapshot()` return a minimal
 * "uninitialized" snapshot so consumers always get a well-shaped
 * object. (Fallback values match what the real store produces when
 * every backing module is missing.)
 */
class UninitializedHealthApi implements HealthApi {
  async snapshot(): Promise<AppHealthSnapshot> {
    const now = Date.now();
    return {
      schemaVersion: 1,
      capturedAt: new Date(now).toISOString(),
      app: {
        version: '0.0.0',
        platform: process.platform,
        arch: process.arch,
        uptimeMs: 0,
        userDataPath: '',
        startedAt: now,
      },
      windows: [],
      auth: {
        signedIn: false,
        environment: 'edison',
        hasMultToken: false,
        hasAccountToken: false,
      },
      totp: { configured: false, hasCurrentCode: false },
      neon: { configured: false, ready: false, hasPassword: false },
      updater: {
        failedAttempts: 0,
        lastAttemptVersion: null,
        lastAttemptTime: null,
      },
      diagnostics: { recentErrorCount: 0, recentWarnCount: 0 },
    };
  }
}

let _instance: HealthApi = new UninitializedHealthApi();

/** Get the singleton Health API. Lazily initialized. */
export function getHealthApi(): HealthApi {
  return _instance;
}

/** Reset the singleton (for tests). */
export function _resetHealthApiForTesting(): void {
  _instance = new UninitializedHealthApi();
}

/**
 * Override the singleton with a custom implementation. Used by
 * `initHealth()` at boot to install the real store-backed
 * implementation, and by tests to inject stubs.
 */
export function _setHealthApiForTesting(api: HealthApi): void {
  _instance = api;
}

// ─── Convenience: install the real impl from a config ───────────────────

/**
 * Build the default `HealthApi` backed by `HealthStore`. Used by
 * `initHealth()` in `main.ts`; exposed here so tests that need the
 * real store (with custom readers) don't have to import from
 * `store.ts`.
 */
export function makeHealthApi(config: HealthStoreConfig): HealthApi {
  const store = new HealthStore(config);
  return { snapshot: () => store.snapshot() };
}
