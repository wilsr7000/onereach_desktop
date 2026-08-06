/**
 * Cross-app timestamp normalization.
 *
 * The graph is written by more than one app and they disagree on the
 * format: Lite writes ISO 8601 strings, GSX / WISER Playbooks writes
 * epoch milliseconds. Verified against the live graph — three Space
 * nodes carried BOTH `updatedAt` ('2026-05-19T03:06:17') and
 * `updated_at` (1785976501151).
 *
 * Unnormalized, `Date.parse('1785976501151')` is NaN, so GSX-written
 * Spaces rendered a raw number where a date belongs and always sank to
 * the bottom of the "recently updated" sort.
 */

import { describe, it, expect } from 'vitest';
import { normalizeGraphTimestamp } from '../../spaces/sdk-client.js';

describe('normalizeGraphTimestamp', () => {
  it('passes ISO strings through VERBATIM (no needless re-serialization)', () => {
    expect(normalizeGraphTimestamp('2026-05-19T03:06:17.000Z')).toBe(
      '2026-05-19T03:06:17.000Z'
    );
    // A shorter-but-valid ISO form keeps its exact shape too: rewriting
    // it would be a spurious change to already-correct data.
    expect(normalizeGraphTimestamp('2026-01-01T00:00:00Z')).toBe('2026-01-01T00:00:00Z');
  });

  it('converts epoch millis (the GSX/WISER shape) to ISO', () => {
    // The exact value observed on a live Space node.
    const out = normalizeGraphTimestamp('1785976501151');
    expect(out).toBe(new Date(1785976501151).toISOString());
    expect(Date.parse(out as string)).toBeGreaterThan(0);
  });

  it('accepts epoch millis as a number, not just a numeric string', () => {
    expect(normalizeGraphTimestamp(1785976501151)).toBe(
      new Date(1785976501151).toISOString()
    );
  });

  it('widens 10-digit epoch SECONDS rather than reading them as 1970', () => {
    const seconds = 1785976501;
    const out = normalizeGraphTimestamp(String(seconds));
    expect(out).toBe(new Date(seconds * 1000).toISOString());
    expect(new Date(out as string).getUTCFullYear()).toBeGreaterThan(2020);
  });

  it('returns undefined for junk so callers keep their missing-timestamp path', () => {
    expect(normalizeGraphTimestamp('')).toBeUndefined();
    expect(normalizeGraphTimestamp('   ')).toBeUndefined();
    expect(normalizeGraphTimestamp('not a date')).toBeUndefined();
    expect(normalizeGraphTimestamp(undefined)).toBeUndefined();
    expect(normalizeGraphTimestamp(null)).toBeUndefined();
    expect(normalizeGraphTimestamp(0)).toBeUndefined();
  });

  it('makes the two writers directly comparable (the point of the exercise)', () => {
    // A GSX write that is genuinely NEWER than a Lite write must sort
    // as newer once normalized -- string-comparing the raw values would
    // put every '1...' epoch before every '2...' ISO date.
    const liteOlder = normalizeGraphTimestamp('2026-05-19T03:06:17.000Z');
    const gsxNewer = normalizeGraphTimestamp('1785976501151'); // ~2026-08
    expect(Date.parse(gsxNewer as string)).toBeGreaterThan(
      Date.parse(liteOlder as string)
    );
    // And the naive string compare that this replaces was wrong:
    expect('1785976501151' > '2026-05-19T03:06:17.000Z').toBe(false);
  });
});
