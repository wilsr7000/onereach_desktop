/**
 * Daily rollup shaping.
 *
 * The theme is deliberate coarseness. Everything here is about
 * measuring the APP without measuring the PERSON: minute-rounded
 * presence instead of exact timings, bounded counter maps instead of
 * open-ended label sets, and one report per day instead of a stream.
 */

import { describe, it, expect } from 'vitest';
import {
  buildDailyRollup,
  emptyCounters,
  utcDay,
  roundActiveMinutes,
  capCounterMap,
  isSameDay,
  rollupTitle,
} from '../../telemetry/rollup.js';

const NOW = Date.parse('2026-08-07T01:23:45.000Z');

function rollup(over: Partial<Parameters<typeof buildDailyRollup>[0]> = {}) {
  return buildDailyRollup({
    installId: 'inst-1',
    nowMs: NOW,
    version: '0.0.34',
    platform: 'darwin',
    arch: 'arm64',
    activeMs: 0,
    counters: emptyCounters(),
    health: {
      signedIn: true,
      neonConfigured: true,
      totpConfigured: false,
      updaterHealthy: true,
    },
    ...over,
  });
}

describe('utcDay', () => {
  it('uses UTC so installs in different timezones bucket consistently', () => {
    expect(utcDay(Date.parse('2026-08-07T23:59:59Z'))).toBe('2026-08-07');
    expect(utcDay(Date.parse('2026-08-08T00:00:00Z'))).toBe('2026-08-08');
  });
});

describe('roundActiveMinutes — coarse on purpose', () => {
  it('rounds to whole minutes', () => {
    expect(roundActiveMinutes(90_000)).toBe(2);
    expect(roundActiveMinutes(3_600_000)).toBe(60);
  });

  // Exact presence over a day reconstructs someone's working hours and
  // breaks. Minutes answer "was the app used" without that.
  it('never reports sub-minute precision', () => {
    expect(roundActiveMinutes(1_000)).toBe(0);
    expect(roundActiveMinutes(29_000)).toBe(0);
  });

  it('is defensive about junk', () => {
    expect(roundActiveMinutes(-5)).toBe(0);
    expect(roundActiveMinutes(Number.NaN)).toBe(0);
    expect(roundActiveMinutes(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('capCounterMap — bounded label sets', () => {
  it('keeps the map as-is when it is small', () => {
    expect(capCounterMap({ spaces: 3, auth: 1 })).toEqual({ spaces: 3, auth: 1 });
  });

  it('drops zero and negative entries', () => {
    expect(capCounterMap({ a: 0, b: -2, c: 1 })).toEqual({ c: 1 });
  });

  // A bug that interpolates an id into a category name would otherwise
  // turn this into an unbounded set that leaks specifics.
  it('caps runaway cardinality and says how much it dropped', () => {
    const wild: Record<string, number> = {};
    for (let i = 0; i < 50; i += 1) wild[`cat-${i}`] = i + 1;
    const out = capCounterMap(wild, 5);
    expect(Object.keys(out)).toHaveLength(6); // 5 kept + __other
    expect(out['__other']).toBeGreaterThan(0);
  });

  it('never silently truncates — the remainder is always reported', () => {
    const wild: Record<string, number> = { a: 10, b: 9, c: 8 };
    const out = capCounterMap(wild, 1);
    expect(out['a']).toBe(10);
    expect(out['__other'], 'dropped counts must still be represented').toBe(17);
  });
});

describe('buildDailyRollup', () => {
  it('stamps the schema version so old rows stay readable', () => {
    expect(rollup().schemaVersion).toBe(1);
  });

  it('buckets into the UTC day of the instant', () => {
    expect(rollup().day).toBe('2026-08-07');
  });

  it('coerces health flags to real booleans', () => {
    const r = buildDailyRollup({
      installId: 'i',
      nowMs: NOW,
      version: 'v',
      platform: 'p',
      arch: 'a',
      activeMs: 0,
      counters: emptyCounters(),
      health: {
        signedIn: 'yes',
        neonConfigured: 1,
        totpConfigured: null,
        updaterHealthy: undefined,
      } as never,
    });
    expect(r.health).toEqual({
      signedIn: false,
      neonConfigured: false,
      totpConfigured: false,
      updaterHealthy: false,
    });
  });

  it('never emits fractional or negative counts', () => {
    const r = rollup({
      counters: { ...emptyCounters(), launches: 2.7, bugReportsFiled: -3 },
    });
    expect(r.counters.launches).toBe(2);
    expect(r.counters.bugReportsFiled).toBe(0);
  });

  it('carries no free text — every value is a number, boolean, or fixed token', () => {
    const r = rollup({ activeMs: 600_000 });
    // installId is a random uuid; version/platform/arch are fixed
    // vocabularies. Nothing user-authored may appear.
    const json = JSON.stringify(r);
    expect(json).not.toMatch(/\.pdf|\.md|http|@/);
  });
});

describe('one rollup per install per day', () => {
  it('recognises an already-sealed day', () => {
    expect(isSameDay('2026-08-07', '2026-08-07')).toBe(true);
  });

  it('treats a missing marker as not-yet-sealed', () => {
    expect(isSameDay(null, '2026-08-07')).toBe(false);
    expect(isSameDay(undefined, '2026-08-07')).toBe(false);
  });

  it('rolls over at the day boundary', () => {
    expect(isSameDay('2026-08-06', '2026-08-07')).toBe(false);
  });
});

describe('rollupTitle', () => {
  it('reads as a scannable row in the Space', () => {
    expect(rollupTitle(rollup())).toBe('2026-08-07 · 0.0.34 · darwin');
  });
});
