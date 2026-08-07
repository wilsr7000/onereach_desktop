/**
 * Telemetry module -- PUBLIC API.
 *
 * The only file other lite modules import from this module (ADR-019 /
 * Rule 11). The surface is deliberately tiny: read status, record a
 * consent decision, run the one-time ask. Everything else -- counting,
 * sealing, sending -- is internal, because no other module has any
 * business influencing what leaves the machine.
 *
 * The consent invariant the whole module hangs off: nothing is ever
 * sent unless the persisted record says exactly `granted`. The
 * uninitialized default below therefore reports `unset` and treats
 * `setConsent` as a no-op -- a caller racing boot cannot conjure a
 * grant out of an uninitialized module.
 */

import type { BrowserWindow } from 'electron';
import type { TelemetryConsentRecord } from './types.js';

/** Status snapshot surfaced to Settings and the renderer bridge. */
export interface TelemetryStatus {
  /** Random per-install UUID -- see `identity.ts` for why it is random. */
  installId: string;
  consent: TelemetryConsentRecord;
  /** UTC day (`YYYY-MM-DD`) currently accumulating. */
  day: string;
  /** The per-install Space id once ensured, else null. */
  spaceId: string | null;
  /** UTC day of the last rollup that actually SENT, or null if never. */
  lastSentDay: string | null;
  /** Outcome of the most recent seal attempt. */
  lastRollupOutcome: 'sent' | 'skipped-consent' | 'failed' | null;
  /** ISO timestamp of that attempt. */
  lastRollupAttemptAt: string | null;
}

/**
 * Telemetry surface. Implemented by `initTelemetry()` in `main.ts`;
 * the default is a safe uninitialized stand-in.
 */
export interface TelemetryApi {
  /**
   * Current consent + identity + accumulation day.
   *
   * @returns The live status. Never throws; the uninitialized
   *   implementation returns an empty-identity, `unset`-consent shape.
   */
  getStatus(): TelemetryStatus;

  /**
   * Record a consent decision (Settings toggle / consent dialog).
   *
   * @param state `'granted'` opts this install in; `'denied'` opts out.
   *   Anything else must be ignored by implementations.
   * @returns The status after the decision.
   */
  setConsent(state: 'granted' | 'denied'): TelemetryStatus;

  /**
   * Show the one-time consent ask if it is still owed (consent is
   * `unset`). Resolves without prompting when a decision exists.
   *
   * @param parent Window to parent the dialog to; null for app-modal.
   */
  promptIfNeeded(parent: BrowserWindow | null): Promise<void>;
}

/**
 * Uninitialized default. Reports `unset`, ignores decisions, never
 * prompts. Deliberately inert: telemetry that half-works before boot
 * wiring is worse than telemetry that waits.
 */
class UninitializedTelemetryApi implements TelemetryApi {
  getStatus(): TelemetryStatus {
    return {
      installId: '',
      consent: { state: 'unset' },
      day: '',
      spaceId: null,
      lastSentDay: null,
      lastRollupOutcome: null,
      lastRollupAttemptAt: null,
    };
  }

  setConsent(): TelemetryStatus {
    return this.getStatus();
  }

  async promptIfNeeded(): Promise<void> {
    /* not initialized -- the ask stays owed */
  }
}

let _instance: TelemetryApi = new UninitializedTelemetryApi();

/** Get the singleton Telemetry API. Lazily initialized. */
export function getTelemetryApi(): TelemetryApi {
  return _instance;
}

/** Reset the singleton (for tests). */
export function _resetTelemetryApiForTesting(): void {
  _instance = new UninitializedTelemetryApi();
}

/**
 * Override the singleton. Used by `initTelemetry()` at boot to install
 * the real file-backed implementation, and by tests to inject stubs.
 */
export function _setTelemetryApiForTesting(api: TelemetryApi): void {
  _instance = api;
}

// ── Re-exports consumers may need ────────────────────────────────────
//
// NOTE deliberately absent: `initTelemetry` is NOT re-exported here.
// main.ts imports the singleton installer from this file, so an
// api -> main re-export would be a cycle (dep-cruiser bans it). Boot
// imports `initTelemetry` from './telemetry/main.js' directly — the
// same shape as initHealth / initSpaces.

export { CONSENT_DISCLOSURE, maySend, shouldPrompt } from './consent.js';

export type {
  TelemetryConsent,
  TelemetryConsentRecord,
  InstallIdentity,
  DailyRollup,
  DailyCounters,
} from './types.js';
