/**
 * The day accumulator — counters for the current UTC day, and the
 * rollover that seals a finished day into a rollup candidate.
 *
 * Pure over injected state so the rollover rules are testable to the
 * minute. The persistence seam mirrors `identity.ts`: main.ts owns the
 * file, this module owns the semantics.
 *
 * The invariant that matters: A DAY IS SEALED EXACTLY ONCE. The state
 * carries the day it is accumulating for; when the clock says a
 * different day, the old state is handed back for sealing and a fresh
 * one starts. A machine that slept through midnight seals yesterday on
 * wake; one that was off entirely seals it on next boot. Days with the
 * app never open produce no rollup at all — which is itself accurate
 * usage data, not a gap to paper over.
 */

import { emptyCounters, utcDay } from './rollup.js';
import type { DailyCounters } from './types.js';

/** Everything accumulated for one UTC day. */
export interface TelemetryDayState {
  /** The UTC day (`YYYY-MM-DD`) these numbers belong to. */
  day: string;
  counters: DailyCounters;
  /** App-open time so far, in ms. Rounded only at seal time. */
  activeMs: number;
}

export function freshDayState(nowMs: number): TelemetryDayState {
  return { day: utcDay(nowMs), counters: emptyCounters(), activeMs: 0 };
}

/**
 * Parse persisted state. Anything implausible yields null and the
 * caller starts fresh — losing at most one day of counters, never
 * crashing the app over its own bookkeeping.
 */
export function parseDayState(raw: string): TelemetryDayState | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v['day'] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v['day'])) return null;
  const c = v['counters'];
  if (c === null || typeof c !== 'object') return null;
  const counters = c as Record<string, unknown>;
  return {
    day: v['day'],
    counters: {
      launches: toCount(counters['launches']),
      errorsByCategory: toCountMap(counters['errorsByCategory']),
      surfacesOpened: toCountMap(counters['surfacesOpened']),
      bugReportsFiled: toCount(counters['bugReportsFiled']),
    },
    activeMs: toCount(v['activeMs']),
  };
}

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;
}

function toCountMap(value: unknown): Record<string, number> {
  if (value === null || typeof value !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const n = toCount(v);
    if (n > 0 && typeof k === 'string' && k.length > 0) out[k] = n;
  }
  return out;
}

/**
 * Advance the clock. When the state's day is still today, it is
 * returned unchanged and there is nothing to seal. When the day has
 * rolled (midnight passed, machine woke, app rebooted days later), the
 * finished state comes back as `toSeal` and accumulation restarts.
 */
export function rollDay(
  state: TelemetryDayState,
  nowMs: number
): { state: TelemetryDayState; toSeal: TelemetryDayState | null } {
  const today = utcDay(nowMs);
  if (state.day === today) return { state, toSeal: null };
  return { state: freshDayState(nowMs), toSeal: state };
}

// ── Counter bumps. Mutating on purpose: the state object is the live
// accumulator owned by main.ts, and a copy-per-error would be churn
// with no reader to benefit. ──────────────────────────────────────────

export function bumpLaunch(state: TelemetryDayState): void {
  state.counters.launches += 1;
}

export function bumpError(state: TelemetryDayState, category: string): void {
  const key = normalizeLabel(category);
  state.counters.errorsByCategory[key] = (state.counters.errorsByCategory[key] ?? 0) + 1;
}

export function bumpSurface(state: TelemetryDayState, surface: string): void {
  const key = normalizeLabel(surface);
  state.counters.surfacesOpened[key] = (state.counters.surfacesOpened[key] ?? 0) + 1;
}

export function bumpBugReport(state: TelemetryDayState): void {
  state.counters.bugReportsFiled += 1;
}

export function addActiveMs(state: TelemetryDayState, ms: number): void {
  if (Number.isFinite(ms) && ms > 0) state.activeMs += ms;
}

/**
 * Labels come from event categories — a fixed vocabulary today, but
 * one typo'd emitter interpolating an id would leak specifics into
 * every rollup. Lowercase, strip anything exotic, and hard-cap the
 * length so a label is only ever a short ASCII token.
 */
export function normalizeLabel(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);
  return cleaned.length > 0 ? cleaned : 'other';
}
