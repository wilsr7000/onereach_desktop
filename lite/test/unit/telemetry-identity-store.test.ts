/**
 * Install identity + the day accumulator.
 *
 * Identity: a random UUID whose only job is tying one install's
 * rollups together. The tests guard the two properties that matter —
 * corruption never crashes and never leaks (a tampered file cannot
 * smuggle an arbitrary string into every payload), and a persisted id
 * is stable across boots.
 *
 * Store: A DAY IS SEALED EXACTLY ONCE. Sleep through midnight, reboot
 * days later, or stay open — the finished day comes back for sealing
 * exactly one time, and days with the app closed produce nothing.
 */

import { describe, it, expect } from 'vitest';
import {
  loadOrMintIdentity,
  parseIdentity,
  looksLikeUuid,
  shortInstallId,
  type IdentityIo,
} from '../../telemetry/identity.js';
import {
  freshDayState,
  parseDayState,
  rollDay,
  bumpError,
  bumpSurface,
  bumpLaunch,
  bumpBugReport,
  addActiveMs,
  normalizeLabel,
} from '../../telemetry/store.js';

const UUID = '9f1c2b4a-1234-4abc-8def-0123456789ab';
const NOW = Date.parse('2026-08-07T10:00:00.000Z');

function memoryIo(initial: string | null = null): IdentityIo & { stored: string | null } {
  const box = {
    stored: initial,
    read: (): string | null => box.stored,
    write: (content: string): void => {
      box.stored = content;
    },
  };
  return box;
}

describe('install identity', () => {
  it('mints and persists on first run', () => {
    const io = memoryIo();
    const id = loadOrMintIdentity(io, () => UUID, () => '2026-08-07T10:00:00.000Z');
    expect(id.installId).toBe(UUID);
    expect(io.stored).toContain(UUID);
  });

  it('is stable across boots — the whole point of persisting', () => {
    const io = memoryIo();
    const first = loadOrMintIdentity(io, () => UUID, () => '2026-08-07T10:00:00.000Z');
    const second = loadOrMintIdentity(
      io,
      () => 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      () => '2026-08-08T10:00:00.000Z'
    );
    expect(second.installId).toBe(first.installId);
    expect(second.firstSeenAt).toBe(first.firstSeenAt);
  });

  it('re-mints on junk rather than crashing', () => {
    const io = memoryIo('not json at all {{{');
    const id = loadOrMintIdentity(io, () => UUID, () => '2026-08-07T10:00:00.000Z');
    expect(id.installId).toBe(UUID);
  });

  // The leak guard: an id must LOOK like our UUIDs, or a hand-edited
  // file could put an email or hostname into every payload ever sent.
  it('rejects a tampered id that is not uuid-shaped', () => {
    const io = memoryIo(
      JSON.stringify({ installId: 'robb@onereach.com', firstSeenAt: '2026-01-01T00:00:00Z' })
    );
    const id = loadOrMintIdentity(io, () => UUID, () => '2026-08-07T10:00:00.000Z');
    expect(id.installId).toBe(UUID);
  });

  it('survives a write failure with an in-memory identity', () => {
    const io: IdentityIo = {
      read: () => null,
      write: () => {
        throw new Error('read-only disk');
      },
    };
    expect(loadOrMintIdentity(io, () => UUID, () => 'now').installId).toBe(UUID);
  });

  it('parseIdentity requires both fields plausible', () => {
    expect(parseIdentity(JSON.stringify({ installId: UUID }))).toBeNull();
    expect(
      parseIdentity(JSON.stringify({ installId: UUID, firstSeenAt: 'yesterday-ish' }))
    ).toBeNull();
    expect(
      parseIdentity(JSON.stringify({ installId: UUID, firstSeenAt: '2026-08-07T10:00:00Z' }))
    ).not.toBeNull();
  });

  it('looksLikeUuid is strict about shape', () => {
    expect(looksLikeUuid(UUID)).toBe(true);
    expect(looksLikeUuid('deadbeef')).toBe(false);
    expect(looksLikeUuid('')).toBe(false);
  });

  it('shortInstallId is the first 8 chars, for Space names', () => {
    expect(shortInstallId(UUID)).toBe('9f1c2b4a');
  });
});

describe('day accumulator', () => {
  it('accumulates counters within a day, nothing to seal', () => {
    const state = freshDayState(NOW);
    bumpLaunch(state);
    bumpError(state, 'spaces');
    bumpError(state, 'spaces');
    bumpSurface(state, 'settings');
    bumpBugReport(state);
    addActiveMs(state, 60_000);

    const r = rollDay(state, NOW + 3_600_000); // an hour later, same day
    expect(r.toSeal).toBeNull();
    expect(r.state.counters.errorsByCategory['spaces']).toBe(2);
    expect(r.state.counters.launches).toBe(1);
  });

  it('seals exactly once when midnight passes', () => {
    const state = freshDayState(NOW);
    bumpLaunch(state);

    const afterMidnight = Date.parse('2026-08-08T00:05:00.000Z');
    const first = rollDay(state, afterMidnight);
    expect(first.toSeal?.day).toBe('2026-08-07');
    expect(first.toSeal?.counters.launches).toBe(1);
    expect(first.state.day).toBe('2026-08-08');

    // Rolling again the same day must NOT seal a second time.
    const second = rollDay(first.state, afterMidnight + 60_000);
    expect(second.toSeal).toBeNull();
  });

  // The machine was off for three days: yesterday's numbers seal on
  // boot; the closed days produce nothing, which is itself the truth.
  it('a multi-day gap seals only the finished day', () => {
    const state = freshDayState(NOW);
    bumpLaunch(state);
    const daysLater = Date.parse('2026-08-11T09:00:00.000Z');
    const r = rollDay(state, daysLater);
    expect(r.toSeal?.day).toBe('2026-08-07');
    expect(r.state.day).toBe('2026-08-11');
  });

  it('round-trips through persistence', () => {
    const state = freshDayState(NOW);
    bumpError(state, 'auth');
    addActiveMs(state, 120_000);
    const revived = parseDayState(JSON.stringify(state));
    expect(revived).toEqual(state);
  });

  it('treats corrupt persisted state as absent', () => {
    expect(parseDayState('{{{')).toBeNull();
    expect(parseDayState(JSON.stringify({ day: 'someday', counters: {} }))).toBeNull();
    expect(parseDayState(JSON.stringify({ day: '2026-08-07' }))).toBeNull();
  });

  it('sanitizes counter junk on revive rather than propagating it', () => {
    const revived = parseDayState(
      JSON.stringify({
        day: '2026-08-07',
        counters: {
          launches: -3,
          errorsByCategory: { spaces: 2, bogus: -1, weird: 'x' },
          surfacesOpened: {},
          bugReportsFiled: 1.9,
        },
        activeMs: 'lots',
      })
    );
    expect(revived?.counters.launches).toBe(0);
    expect(revived?.counters.errorsByCategory).toEqual({ spaces: 2 });
    expect(revived?.counters.bugReportsFiled).toBe(1);
    expect(revived?.activeMs).toBe(0);
  });
});

describe('normalizeLabel — labels stay short fixed tokens', () => {
  it('passes clean category names through', () => {
    expect(normalizeLabel('spaces')).toBe('spaces');
    expect(normalizeLabel('bug-report')).toBe('bug-report');
  });

  // One typo'd emitter interpolating an id into a category would
  // otherwise leak specifics into every rollup.
  it('flattens interpolated ids into bounded ascii', () => {
    const label = normalizeLabel('tab:9f1c2b4a-1234-4abc-8def-0123456789ab');
    expect(label.length).toBeLessThanOrEqual(24);
    expect(label).toMatch(/^[a-z0-9-]+$/);
  });

  it('never returns empty', () => {
    expect(normalizeLabel('***')).toBe('other');
    expect(normalizeLabel('')).toBe('other');
  });
});
