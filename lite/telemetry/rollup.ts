/**
 * Daily rollup assembly — turning a day of activity into the small,
 * disclosed payload described in `consent.ts`.
 *
 * Pure by design: no Electron, no KV, no clock of its own. Everything
 * that varies is passed in, so the shaping rules (rounding, capping,
 * day boundaries) are testable exactly.
 */

import { TELEMETRY_SCHEMA_VERSION } from './types.js';
import type { DailyCounters, DailyRollup } from './types.js';

/** Empty counters for a fresh day. */
export function emptyCounters(): DailyCounters {
  return { launches: 0, errorsByCategory: {}, surfacesOpened: {}, bugReportsFiled: 0 };
}

/** The UTC calendar day (`YYYY-MM-DD`) an instant falls in. */
export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Round active time to whole minutes.
 *
 * Deliberately coarse. Millisecond-accurate presence over a day is
 * enough to reconstruct someone's working hours, breaks, and when they
 * stepped away — which is not what "how is the app being used" needs,
 * and not something an alpha tester signed up for.
 */
export function roundActiveMinutes(activeMs: number): number {
  if (!Number.isFinite(activeMs) || activeMs <= 0) return 0;
  return Math.round(activeMs / 60_000);
}

/**
 * Cap the cardinality of a counter map.
 *
 * Category and surface names are supposed to come from a fixed
 * vocabulary, but a bug (or a caller interpolating an id into a name)
 * could turn one into an unbounded set that leaks specifics. Keeping
 * the top N by count and dropping the tail bounds both the payload
 * size and that exposure.
 */
export function capCounterMap(
  map: Record<string, number>,
  max = 20
): Record<string, number> {
  const entries = Object.entries(map)
    .filter(([, v]) => Number.isFinite(v) && v > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const kept = entries.slice(0, max);
  const dropped = entries.slice(max);
  const out: Record<string, number> = {};
  for (const [k, v] of kept) out[k] = v;
  if (dropped.length > 0) {
    // Never silently truncate — say how much was left out.
    out['__other'] = dropped.reduce((sum, [, v]) => sum + v, 0);
  }
  return out;
}

export interface BuildRollupInput {
  installId: string;
  nowMs: number;
  version: string;
  platform: string;
  arch: string;
  activeMs: number;
  counters: DailyCounters;
  health: {
    signedIn: boolean;
    neonConfigured: boolean;
    totpConfigured: boolean;
    updaterHealthy: boolean;
  };
}

/**
 * Assemble the payload. The returned object carries exactly the keys
 * `ALLOWED_ROLLUP_KEYS` permits — the send path re-checks that, so
 * these two cannot drift apart unnoticed.
 */
export function buildDailyRollup(input: BuildRollupInput): DailyRollup {
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    installId: input.installId,
    day: utcDay(input.nowMs),
    version: input.version,
    platform: input.platform,
    arch: input.arch,
    activeMinutes: roundActiveMinutes(input.activeMs),
    counters: {
      launches: Math.max(0, Math.trunc(input.counters.launches)),
      errorsByCategory: capCounterMap(input.counters.errorsByCategory),
      surfacesOpened: capCounterMap(input.counters.surfacesOpened),
      bugReportsFiled: Math.max(0, Math.trunc(input.counters.bugReportsFiled)),
    },
    health: {
      signedIn: input.health.signedIn === true,
      neonConfigured: input.health.neonConfigured === true,
      totpConfigured: input.health.totpConfigured === true,
      updaterHealthy: input.health.updaterHealthy === true,
    },
  };
}

/**
 * Has a rollup for this day already been sealed?
 *
 * One rollup per install per day. Re-running must UPDATE rather than
 * append, or a machine left open across a restart produces duplicate
 * days and the usage numbers quietly double.
 */
export function isSameDay(a: string | null | undefined, b: string): boolean {
  return typeof a === 'string' && a === b;
}

/** Human title for the Space item that carries a rollup. */
export function rollupTitle(rollup: DailyRollup): string {
  return `${rollup.day} · ${rollup.version} · ${rollup.platform}`;
}
