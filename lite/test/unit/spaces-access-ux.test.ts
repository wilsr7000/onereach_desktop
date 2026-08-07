/**
 * Access-duration UX — what a member row actually says.
 *
 * The design bet: a person reads "who can see this, and until when",
 * never the five mechanisms underneath (bucket privacy, file TTL, link
 * expiry, Space visibility, grant expiry). These tests pin the wording
 * and the state machine that carries that, because the wording IS the
 * feature — a grant whose deadline is shown wrong is worse than one
 * with no deadline shown at all.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { accessState, accessLabel, accessPresetToIso } from '../../spaces/spaces.js';

const NOW = Date.parse('2026-08-06T12:00:00.000Z');
const at = (iso: string): { accessExpiresAt: string } => ({ accessExpiresAt: iso });

describe('accessState', () => {
  it('is permanent when no expiry is set — the pre-ADR default', () => {
    expect(accessState({}, NOW)).toBe('permanent');
    expect(accessState({ accessExpiresAt: '' }, NOW)).toBe('permanent');
  });

  // A grant we can't parse must not read as expired: that would show
  // "access expired" for someone who can still see everything, which is
  // worse than showing nothing.
  it('falls back to permanent on an unparseable value, never to expired', () => {
    expect(accessState({ accessExpiresAt: 'soon-ish' }, NOW)).toBe('permanent');
  });

  it('is active while comfortably in the future', () => {
    expect(accessState(at('2026-08-20T12:00:00.000Z'), NOW)).toBe('active');
  });

  it('is soon inside the last 24 hours', () => {
    expect(accessState(at('2026-08-07T06:00:00.000Z'), NOW)).toBe('soon');
  });

  it('is expired once the instant has passed', () => {
    expect(accessState(at('2026-08-06T11:59:59.000Z'), NOW)).toBe('expired');
  });

  it('treats exactly-now as expired — a zero-length grant is over', () => {
    expect(accessState(at('2026-08-06T12:00:00.000Z'), NOW)).toBe('expired');
  });
});

describe('accessLabel', () => {
  it('says nothing for permanent access — the common case adds no noise', () => {
    expect(accessLabel({}, NOW)).toBe('');
  });

  // Relative when you need to ACT, absolute when you're PLANNING. One
  // format would be wrong at one end or the other.
  it('is relative when the deadline is urgent', () => {
    expect(accessLabel(at('2026-08-06T18:00:00.000Z'), NOW)).toBe('expires in 6h');
    expect(accessLabel(at('2026-08-06T12:30:00.000Z'), NOW)).toBe('expires in 30m');
  });

  it('is absolute once it is far enough out to plan around', () => {
    expect(accessLabel(at('2026-08-14T12:00:00.000Z'), NOW)).toBe('until 14 Aug');
  });

  it('never rounds an imminent deadline down to zero', () => {
    expect(accessLabel(at('2026-08-06T12:00:20.000Z'), NOW)).toBe('expires in 1m');
  });

  it('names the lapsed state in plain words', () => {
    expect(accessLabel(at('2026-08-01T12:00:00.000Z'), NOW)).toBe('access expired');
  });

  it('switches format at the 48h boundary, not mid-scale', () => {
    expect(accessLabel(at('2026-08-08T11:00:00.000Z'), NOW)).toContain('expires in');
    expect(accessLabel(at('2026-08-08T13:00:00.000Z'), NOW)).toContain('until');
  });
});

describe('accessPresetToIso', () => {
  it('returns null for permanent', () => {
    expect(accessPresetToIso('', NOW)).toBeNull();
    expect(accessPresetToIso('forever', NOW)).toBeNull();
  });

  it('resolves presets to absolute instants', () => {
    expect(accessPresetToIso('24h', NOW)).toBe('2026-08-07T12:00:00.000Z');
    expect(accessPresetToIso('7d', NOW)).toBe('2026-08-13T12:00:00.000Z');
    expect(accessPresetToIso('30d', NOW)).toBe('2026-09-05T12:00:00.000Z');
    expect(accessPresetToIso('90d', NOW)).toBe('2026-11-04T12:00:00.000Z');
  });

  // The SDK rejects a past expiry, so a preset that resolved into the
  // past would be a dead-on-arrival grant the user can't diagnose.
  it('always resolves into the future', () => {
    for (const p of ['24h', '7d', '30d', '90d']) {
      expect(Date.parse(accessPresetToIso(p, NOW) as string)).toBeGreaterThan(NOW);
    }
  });

  it('round-trips through the label as an active grant', () => {
    const iso = accessPresetToIso('7d', NOW) as string;
    expect(accessState({ accessExpiresAt: iso }, NOW)).toBe('active');
    expect(accessLabel({ accessExpiresAt: iso }, NOW)).toBe('until 13 Aug');
  });
});
