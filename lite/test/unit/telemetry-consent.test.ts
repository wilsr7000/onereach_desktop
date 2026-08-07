/**
 * The consent gate and the disclosure it promises.
 *
 * This is the only thing between a colleague's machine and a central
 * graph, so the tests are written from the standpoint of the person
 * being measured, not the person doing the measuring:
 *
 *   - silence must never mean yes;
 *   - a malformed or tampered record must never mean yes;
 *   - "no" must stay no without being asked again;
 *   - and the payload must not be able to exceed what the prompt said
 *     it would be.
 */

import { describe, it, expect } from 'vitest';
import {
  maySend,
  shouldPrompt,
  recordDecision,
  disclosureViolations,
  CONSENT_DISCLOSURE,
  ALLOWED_ROLLUP_KEYS,
} from '../../telemetry/consent.js';
import { buildDailyRollup, emptyCounters } from '../../telemetry/rollup.js';

describe('maySend — silence is never consent', () => {
  const NOPE: Array<[string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['empty object', {}],
    ['unset', { state: 'unset' }],
    ['denied', { state: 'denied' }],
    ['a bare string', 'granted'],
    ['string "true"', { state: 'true' }],
    ['boolean true', { state: true }],
    ['number 1', { state: 1 }],
    ['capitalised', { state: 'Granted' }],
    ['an array', []],
  ];
  for (const [label, value] of NOPE) {
    it(`refuses to send for ${label}`, () => {
      expect(maySend(value), `${label} must not authorise a send`).toBe(false);
    });
  }

  it('sends only on an exact granted record', () => {
    expect(maySend({ state: 'granted' })).toBe(true);
  });
});

describe('shouldPrompt — ask once, respect the answer', () => {
  it('asks when we have never asked', () => {
    expect(shouldPrompt(undefined)).toBe(true);
    expect(shouldPrompt({})).toBe(true);
    expect(shouldPrompt({ state: 'unset' })).toBe(true);
  });

  // Re-asking is how a consent dialog becomes something people dismiss
  // reflexively, which destroys the meaning of a "yes".
  it('never re-asks after a decision, either way', () => {
    expect(shouldPrompt({ state: 'denied' })).toBe(false);
    expect(shouldPrompt({ state: 'granted' })).toBe(false);
  });

  it('asks again if the record is unrecognisable — better than assuming', () => {
    expect(shouldPrompt({ state: 'banana' })).toBe(true);
  });
});

describe('recordDecision', () => {
  it('stamps when and in which version the choice was made', () => {
    const r = recordDecision('granted', '0.0.34', '2026-08-07T01:00:00.000Z');
    expect(r).toEqual({
      state: 'granted',
      decidedAt: '2026-08-07T01:00:00.000Z',
      decidedInVersion: '0.0.34',
    });
  });

  it('records a denial just as durably as a grant', () => {
    expect(recordDecision('denied', '0.0.34', '2026-08-07T01:00:00.000Z').state).toBe('denied');
  });
});

describe('the disclosure is a promise the payload must keep', () => {
  it('tells the user what is sent and what never is', () => {
    expect(CONSENT_DISCLOSURE.sends.length).toBeGreaterThan(0);
    expect(CONSENT_DISCLOSURE.neverSends.join(' ')).toMatch(/passwords|tokens/i);
    expect(CONSENT_DISCLOSURE.footer).toMatch(/Settings/);
  });

  // THE load-bearing test. A real rollup must contain nothing the
  // prompt did not mention. If someone adds a field, this fails and
  // forces the disclosure to be updated too.
  it('a real rollup carries no field the user was not told about', () => {
    const rollup = buildDailyRollup({
      installId: 'inst-1',
      nowMs: Date.parse('2026-08-07T01:00:00.000Z'),
      version: '0.0.34',
      platform: 'darwin',
      arch: 'arm64',
      activeMs: 3_600_000,
      counters: emptyCounters(),
      health: {
        signedIn: true,
        neonConfigured: true,
        totpConfigured: false,
        updaterHealthy: true,
      },
    });
    expect(disclosureViolations(rollup)).toEqual([]);
  });

  it('flags a payload that smuggles an extra field', () => {
    expect(disclosureViolations({ installId: 'x', assetTitles: ['secret plan'] })).toContain(
      'assetTitles'
    );
  });

  it('rejects a non-object payload outright', () => {
    expect(disclosureViolations('nope').length).toBeGreaterThan(0);
  });

  it('the allow-list has no field that looks like content', () => {
    for (const k of ALLOWED_ROLLUP_KEYS) {
      expect(k).not.toMatch(/title|name|url|path|content|text|message|email/i);
    }
  });
});
