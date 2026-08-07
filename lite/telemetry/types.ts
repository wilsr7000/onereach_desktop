/**
 * Telemetry module -- shared types.
 *
 * Purpose: during the alpha rollout, give the maintainer a picture of
 * how each installed copy of Lite is actually behaving -- versions in
 * the wild, crashes, which surfaces get used -- without turning the
 * app into a surveillance tool aimed at colleagues.
 *
 * Two rules shape everything here:
 *
 *   1. NOTHING LEAVES THE MACHINE WITHOUT CONSENT. Consent is opt-in,
 *      defaults to off, and is revocable. The app is fully functional
 *      with it off, forever, and never nags.
 *
 *   2. THE PAYLOAD IS A ROLLUP, NOT A TRANSCRIPT. Counts, versions and
 *      presence booleans -- never log lines, asset titles, URLs, file
 *      names, or message contents. If a field could embarrass someone
 *      or reveal what they were working on, it does not belong here.
 */

/** Bumps when the daily-rollup shape changes incompatibly. */
export const TELEMETRY_SCHEMA_VERSION = 1 as const;

/**
 * Where consent stands for this install.
 *
 * `unset` is distinct from `denied`: unset means we have not asked yet
 * (so the prompt is still owed), denied means the user said no (so it
 * must never be asked again unprompted).
 */
export type TelemetryConsent = 'unset' | 'granted' | 'denied';

/** Persisted consent record. */
export interface TelemetryConsentRecord {
  state: TelemetryConsent;
  /** ISO timestamp of the user's decision. Absent while `unset`. */
  decidedAt?: string;
  /** Lite version the decision was made in, for auditability. */
  decidedInVersion?: string;
}

/**
 * Stable identifier for THIS installation.
 *
 * Deliberately a random UUID minted on first run and stored in
 * userData -- NOT derived from a MAC address, disk serial, or hostname.
 * A derived id is a device fingerprint that follows someone across
 * reinstalls and can be correlated with other systems. A random id
 * does the one job needed here: tie an install's own reports together.
 * Deleting the app data resets it, which is the correct behaviour.
 */
export interface InstallIdentity {
  installId: string;
  /** ISO timestamp the id was first minted. */
  firstSeenAt: string;
}

/** Counts accumulated over one UTC day. Reset when the day rolls over. */
export interface DailyCounters {
  /** App launches. */
  launches: number;
  /** Errors logged, keyed by category (`spaces`, `auth`, ...). */
  errorsByCategory: Record<string, number>;
  /** Feature surfaces opened, keyed by name (`spaces`, `settings`, ...). */
  surfacesOpened: Record<string, number>;
  /** Bug reports filed from this install. */
  bugReportsFiled: number;
}

/**
 * One day's report for one install. This is the ENTIRE payload that
 * leaves the machine -- there is no second, richer channel.
 */
export interface DailyRollup {
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  installId: string;
  /** UTC calendar day, `YYYY-MM-DD`. One rollup per install per day. */
  day: string;
  /** Lite version running when the rollup was sealed. */
  version: string;
  platform: string;
  arch: string;
  /** Total foreground time, rounded to minutes to blunt inference. */
  activeMinutes: number;
  counters: DailyCounters;
  /** Presence booleans from the health snapshot -- never values. */
  health: {
    signedIn: boolean;
    neonConfigured: boolean;
    totpConfigured: boolean;
    updaterHealthy: boolean;
  };
}
