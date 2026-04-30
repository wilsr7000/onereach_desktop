/**
 * Affect Matching Integration Smoke Test
 *
 * Covers the full Phase 6 loop:
 *   user utterance -> classifyAffect -> record in tracker
 *   assistant reply -> lookup tracker -> adjustResponse -> spoken text
 *
 * Mirrors the exchange-bridge + voice-speaker slices in-test against
 * the real modules, without booting Electron.
 *
 * Run:  npx vitest run test/unit/affect-matching-integration.test.js
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { classifyAffect } = require('../../lib/naturalness/affect-classifier');
const { adjustResponse } = require('../../lib/naturalness/response-modifier');
const {
  getSharedAffectTracker,
  configureAffectTracker,
  resetSharedAffectTracker,
} = require('../../lib/naturalness/affect-tracker');

describe('affect-matching integration', () => {
  let clockMs;
  beforeEach(() => {
    clockMs = 1_000_000;
    configureAffectTracker({ now: () => clockMs });
  });
  afterEach(() => {
    resetSharedAffectTracker();
  });

  /** Mirror of the Phase 6 slice in exchange-bridge.processSubmit. */
  function simulateUserTurn(text, { recentErrors = 0, recentRepeat = false } = {}) {
    const affect = classifyAffect({ text, recentErrors, recentRepeat });
    if (affect.label !== 'neutral') {
      getSharedAffectTracker().record(affect);
    }
    return affect;
  }

  /** Mirror of the Phase 6 slice in voice-speaker._doSpeak. */
  function simulateSpeak(text, opts = {}) {
    if (opts.skipAffectMatching) return { text, modified: false };
    const affect = getSharedAffectTracker().get();
    if (!affect) return { text, modified: false };
    return adjustResponse({ text, affect, rng: () => 0 });
  }

  describe('frustrated loop', () => {
    it('user frustration triggers empathy in the next assistant response', () => {
      simulateUserTurn('ugh, this is broken again. seriously.');
      const spoken = simulateSpeak('OK, so let me check your account');
      expect(spoken.modified).toBe(true);
      expect(spoken.text.toLowerCase()).toMatch(/^got it/);
    });

    it('subsequent neutral turn does NOT erase earlier frustration during TTL', () => {
      simulateUserTurn('ugh, this is broken again. seriously.');
      simulateUserTurn('what time is it'); // neutral, does not overwrite
      const spoken = simulateSpeak('Sure, let me see');
      expect(spoken.modified).toBe(true);
    });

    it('after TTL, a new neutral turn leaves spoken unchanged', () => {
      simulateUserTurn('ugh, this is broken again. seriously.');
      clockMs += 70_000; // expire
      simulateUserTurn('what time is it');
      const spoken = simulateSpeak('It is three');
      expect(spoken.modified).toBe(false);
    });
  });

  describe('rushed loop', () => {
    it('rushed user -> filler-strip + sentence cap on the response', () => {
      simulateUserTurn('QUICK what time is it now hurry');
      const long =
        "OK, so let me see. It is three in the afternoon. The forecast is clear. Traffic is light. Your next meeting is at four.";
      const spoken = simulateSpeak(long);
      expect(spoken.modified).toBe(true);
      expect(spoken.transforms).toContain('cap-sentences:2');
    });
  });

  describe('excited loop', () => {
    it('excited user -> energy prefix on response', () => {
      simulateUserTurn('yes! amazing! finally it works!');
      const spoken = simulateSpeak('Your task completed');
      expect(spoken.modified).toBe(true);
      expect(spoken.text.toLowerCase()).toMatch(/^nice!/);
    });
  });

  describe('priority + replacement', () => {
    it('frustration overrides earlier excitement', () => {
      simulateUserTurn('yes! awesome! nice!');
      expect(getSharedAffectTracker().get()).toMatchObject({ label: 'excited' });

      simulateUserTurn('ugh, this is really annoying and seriously broken');
      expect(getSharedAffectTracker().get()).toMatchObject({ label: 'frustrated' });
    });

    it('a later hesitation does not overwrite in-TTL frustration', () => {
      simulateUserTurn('ugh, stop doing that seriously');
      simulateUserTurn('um, maybe, I guess we could try it');
      expect(getSharedAffectTracker().get()).toMatchObject({ label: 'frustrated' });
    });
  });

  describe('skipAffectMatching opt-out', () => {
    it('fixed safety prompts bypass the modifier', () => {
      simulateUserTurn('ugh, fuck this broken thing');
      const spoken = simulateSpeak(
        "OK, I'll forget that \"jess\" meant \"jazz\"",
        { skipAffectMatching: true }
      );
      expect(spoken.modified).toBe(false);
      expect(spoken.text).toBe("OK, I'll forget that \"jess\" meant \"jazz\"");
    });
  });

  describe('noop path (neutral throughout)', () => {
    it('no user affect -> response passes through unchanged', () => {
      simulateUserTurn('what time is it');
      const spoken = simulateSpeak('It is three in the afternoon.');
      expect(spoken.modified).toBe(false);
    });
  });
});
