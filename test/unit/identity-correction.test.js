/**
 * Identity-correction tests
 *
 * Run: npx vitest run test/unit/identity-correction.test.js
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

const {
  detectIdentityCorrection,
  applyIdentityCorrection,
} = require('../../lib/identity-correction');

describe('detectIdentityCorrection', () => {
  describe('retract-only', () => {
    const cases = [
      ["I don't live in Las Vegas", 'las vegas'],
      ["I don't live in Berkeley anymore", 'berkeley'],
      ["I'm not in Berkeley right now", 'berkeley'],
      ["I'm not in San Francisco currently", 'san francisco'],
      ["I moved away from Vegas", 'vegas'],
      ["I don't live there anymore", '*'],
    ];
    for (const [msg, expected] of cases) {
      it(`detects "${msg}" as retract-only`, () => {
        const d = detectIdentityCorrection(msg);
        expect(d).not.toBeNull();
        expect(d.type).toBe('retract-only');
        expect(d.retractedValue.toLowerCase()).toBe(expected);
        expect(d.assertedValue).toBeNull();
        expect(d.field).toBe('Home City');
      });
    }
  });

  describe('retract-and-assert (combined sentences)', () => {
    const cases = [
      ["Not Vegas, I'm in Portland", 'vegas', 'portland'],
      ["It's not Berkeley, I'm in Austin", 'berkeley', 'austin'],
      ["I live in Reno, not Vegas", 'vegas', 'reno'],
      ["I'm not in Berkeley anymore, I'm in San Francisco", 'berkeley', 'san francisco'],
    ];
    for (const [msg, retracted, asserted] of cases) {
      it(`detects "${msg}"`, () => {
        const d = detectIdentityCorrection(msg);
        expect(d).not.toBeNull();
        expect(d.type).toBe('retract-and-assert');
        expect(d.retractedValue.toLowerCase()).toBe(retracted);
        expect(d.assertedValue.toLowerCase()).toBe(asserted);
      });
    }
  });

  describe('does NOT falsely detect', () => {
    const cases = [
      'What is the capital of Las Vegas',         // question
      'coffee shops in Berkeley',                 // query
      'Weather in Vegas',                          // query
      'I went to Berkeley yesterday',              // past event, not identity
      'My friend lives in Vegas',                  // third-person
      'Vegas is hot this time of year',            // no first-person
      'Tell me about Vegas',                       // request
    ];
    for (const msg of cases) {
      it(`ignores "${msg}"`, () => {
        expect(detectIdentityCorrection(msg)).toBeNull();
      });
    }
  });

  describe('edge cases', () => {
    it('returns null for empty/null input', () => {
      expect(detectIdentityCorrection('')).toBeNull();
      expect(detectIdentityCorrection(null)).toBeNull();
      expect(detectIdentityCorrection(undefined)).toBeNull();
    });

    it('strips trailing noise adverbs from captured value', () => {
      const d = detectIdentityCorrection("I'm not in Berkeley right now");
      expect(d.retractedValue.toLowerCase()).toBe('berkeley');
    });
  });
});

describe('applyIdentityCorrection', () => {
  function makeMockProfile() {
    const facts = {};
    return {
      _facts: facts,
      updateFact: vi.fn((k, v) => { facts[k] = v; }),
      save: vi.fn(async () => {}),
    };
  }

  function makeMockLocationService(live) {
    return {
      getLocation: vi.fn(async () => live || { source: 'unknown' }),
    };
  }

  it('retract-only with live location -> writes live city', async () => {
    const profile = makeMockProfile();
    const loc = makeMockLocationService({ city: 'Portland', source: 'precise' });
    const detection = {
      type: 'retract-only',
      retractedValue: 'Las Vegas',
      assertedValue: null,
      field: 'Home City',
    };
    const r = await applyIdentityCorrection(detection, { userProfile: profile, locationService: loc });
    expect(profile.updateFact).toHaveBeenCalledWith('Home City', '(not yet learned)');
    expect(profile.updateFact).toHaveBeenCalledWith('Home City', 'Portland');
    expect(profile.save).toHaveBeenCalled();
    expect(r.finalValue).toBe('Portland');
    expect(r.liveCityUsed).toBe(true);
    expect(r.spokenResponse).toMatch(/Portland/);
    expect(r.spokenResponse).toMatch(/where you are now/i);
  });

  it('retract-only with NO live location -> clears and asks', async () => {
    const profile = makeMockProfile();
    const loc = makeMockLocationService({ source: 'unknown' });
    const detection = {
      type: 'retract-only',
      retractedValue: 'Las Vegas',
      assertedValue: null,
      field: 'Home City',
    };
    const r = await applyIdentityCorrection(detection, { userProfile: profile, locationService: loc });
    expect(profile.updateFact).toHaveBeenCalledWith('Home City', '(not yet learned)');
    expect(r.finalValue).toBeNull();
    expect(r.spokenResponse).toMatch(/where are you/i);
    expect(r.spokenResponse).toMatch(/Las Vegas/);
  });

  it('retract-and-assert -> writes asserted value, does not call location service', async () => {
    const profile = makeMockProfile();
    const loc = makeMockLocationService({ city: 'Seattle', source: 'precise' });
    const detection = {
      type: 'retract-and-assert',
      retractedValue: 'Las Vegas',
      assertedValue: 'Portland',
      field: 'Home City',
    };
    const r = await applyIdentityCorrection(detection, { userProfile: profile, locationService: loc });
    expect(profile.updateFact).toHaveBeenCalledWith('Home City', 'Portland');
    expect(loc.getLocation).not.toHaveBeenCalled();
    expect(r.finalValue).toBe('Portland');
    expect(r.liveCityUsed).toBe(false);
    expect(r.spokenResponse).toMatch(/Portland/);
  });

  it('falls back to stored source as "no live" (stored is what we just cleared)', async () => {
    const profile = makeMockProfile();
    const loc = makeMockLocationService({ city: 'Las Vegas', source: 'stored' });
    const detection = {
      type: 'retract-only',
      retractedValue: 'Las Vegas',
      assertedValue: null,
      field: 'Home City',
    };
    const r = await applyIdentityCorrection(detection, { userProfile: profile, locationService: loc });
    // stored source is ignored because that's the very value we just cleared
    expect(r.finalValue).toBeNull();
    expect(r.spokenResponse).toMatch(/where are you/i);
  });

  it('handles a null detection gracefully', async () => {
    const r = await applyIdentityCorrection(null, {});
    expect(r.spokenResponse).toBe('');
  });
});
