/**
 * Confirmation Policy - Unit Tests
 *
 * Exhaustively exercises the decision matrix for the calibratedConfirmation
 * phase. Each test row maps to one cell of the policy table documented in
 * confirmation-policy.js.
 *
 * Run:  npx vitest run test/unit/confirmation-policy.test.js
 */

import { describe, it, expect } from 'vitest';

const {
  decide,
  DEFAULT_THRESHOLDS,
  EXEC_TYPES,
  STAKES,
  DECISIONS,
} = require('../../lib/naturalness/confirmation-policy');

describe('confirmation-policy.decide', () => {
  describe('system executionType', () => {
    it('always dispatches, even with high stakes or low confidence', () => {
      expect(
        decide({ executionType: EXEC_TYPES.SYSTEM, stakes: STAKES.HIGH }).decision
      ).toBe(DECISIONS.DISPATCH);
      expect(
        decide({
          executionType: EXEC_TYPES.SYSTEM,
          intentConfidence: 0.1,
          winnerConfidence: 0.2,
        }).decision
      ).toBe(DECISIONS.DISPATCH);
    });
  });

  describe('high-stakes actions', () => {
    it('confirms even when routing is extremely confident', () => {
      expect(
        decide({
          executionType: EXEC_TYPES.ACTION,
          stakes: STAKES.HIGH,
          intentConfidence: 1.0,
          winnerConfidence: 1.0,
        }).decision
      ).toBe(DECISIONS.CONFIRM);
    });

    it('confirms regardless of prior context', () => {
      expect(
        decide({
          executionType: EXEC_TYPES.ACTION,
          stakes: STAKES.HIGH,
          hasPriorContext: true,
        }).decision
      ).toBe(DECISIONS.CONFIRM);
      expect(
        decide({
          executionType: EXEC_TYPES.ACTION,
          stakes: STAKES.HIGH,
          hasPriorContext: false,
        }).decision
      ).toBe(DECISIONS.CONFIRM);
    });

    it('high-stakes informational also confirms (rare but defined)', () => {
      expect(
        decide({
          executionType: EXEC_TYPES.INFORMATIONAL,
          stakes: STAKES.HIGH,
        }).decision
      ).toBe(DECISIONS.CONFIRM);
    });
  });

  describe('informational tasks', () => {
    it('dispatches when confident', () => {
      const r = decide({
        executionType: EXEC_TYPES.INFORMATIONAL,
        intentConfidence: 1.0,
        winnerConfidence: 0.9,
      });
      expect(r.decision).toBe(DECISIONS.DISPATCH);
    });

    it('confirms when intent is unclear and no prior context', () => {
      const r = decide({
        executionType: EXEC_TYPES.INFORMATIONAL,
        intentConfidence: 0.5,
        hasPriorContext: false,
      });
      expect(r.decision).toBe(DECISIONS.CONFIRM);
    });

    it('dispatches low-intent when prior context exists (trust pronoun resolution)', () => {
      const r = decide({
        executionType: EXEC_TYPES.INFORMATIONAL,
        intentConfidence: 0.5,
        hasPriorContext: true,
      });
      expect(r.decision).toBe(DECISIONS.DISPATCH);
    });

    it('never plays a pre-ack (that would be chatty)', () => {
      for (const ic of [1.0, 0.9, 0.8, 0.75]) {
        expect(
          decide({
            executionType: EXEC_TYPES.INFORMATIONAL,
            intentConfidence: ic,
            winnerConfidence: 0.95,
          }).decision
        ).toBe(DECISIONS.DISPATCH);
      }
    });
  });

  describe('action tasks with low stakes', () => {
    it('acknowledges before dispatch when routing is confident', () => {
      const r = decide({
        executionType: EXEC_TYPES.ACTION,
        stakes: STAKES.LOW,
        intentConfidence: 1.0,
        winnerConfidence: 0.9,
      });
      expect(r.decision).toBe(DECISIONS.ACK);
    });

    it('confirms when intent is unclear', () => {
      const r = decide({
        executionType: EXEC_TYPES.ACTION,
        stakes: STAKES.LOW,
        intentConfidence: 0.5,
        winnerConfidence: 0.9,
      });
      expect(r.decision).toBe(DECISIONS.CONFIRM);
    });

    it('confirms when the winner is shaky', () => {
      const r = decide({
        executionType: EXEC_TYPES.ACTION,
        stakes: STAKES.LOW,
        intentConfidence: 1.0,
        winnerConfidence: 0.55,
      });
      expect(r.decision).toBe(DECISIONS.CONFIRM);
    });
  });

  describe('action tasks with medium stakes', () => {
    it('requires a HIGH-confidence winner before dispatching with ack', () => {
      const highConf = decide({
        executionType: EXEC_TYPES.ACTION,
        stakes: STAKES.MEDIUM,
        intentConfidence: 1.0,
        winnerConfidence: 0.9,
      });
      expect(highConf.decision).toBe(DECISIONS.ACK);

      // Winner in the 0.65-0.82 band for medium stakes -> confirm
      const mediumConf = decide({
        executionType: EXEC_TYPES.ACTION,
        stakes: STAKES.MEDIUM,
        intentConfidence: 1.0,
        winnerConfidence: 0.75,
      });
      expect(mediumConf.decision).toBe(DECISIONS.CONFIRM);
    });
  });

  describe('threshold overrides', () => {
    it('applies the provided thresholds', () => {
      // With default thresholds, this is an ACK (winner 0.7 >= 0.65)
      const defaultResult = decide({
        executionType: EXEC_TYPES.ACTION,
        stakes: STAKES.LOW,
        intentConfidence: 1.0,
        winnerConfidence: 0.7,
      });
      expect(defaultResult.decision).toBe(DECISIONS.ACK);

      // With stricter threshold, 0.7 is below mediumWinnerConfidence -> CONFIRM
      const strict = decide({
        executionType: EXEC_TYPES.ACTION,
        stakes: STAKES.LOW,
        intentConfidence: 1.0,
        winnerConfidence: 0.7,
        thresholds: { mediumWinnerConfidence: 0.75 },
      });
      expect(strict.decision).toBe(DECISIONS.CONFIRM);
    });

    it('partial threshold overrides merge with defaults', () => {
      const r = decide({
        executionType: EXEC_TYPES.INFORMATIONAL,
        intentConfidence: 0.6,
        hasPriorContext: false,
        thresholds: { lowIntent: 0.5 }, // lower bar -> dispatch
      });
      expect(r.decision).toBe(DECISIONS.DISPATCH);
    });
  });

  describe('defaults and edge cases', () => {
    it('empty input defaults to dispatch (informational, confident)', () => {
      const r = decide({});
      expect(r.decision).toBe(DECISIONS.DISPATCH);
    });

    it('no-argument call does not throw', () => {
      expect(() => decide()).not.toThrow();
      expect(decide().decision).toBe(DECISIONS.DISPATCH);
    });

    it('unknown executionType falls back to dispatch with a trace reason', () => {
      const r = decide({ executionType: 'mystery-meat' });
      expect(r.decision).toBe(DECISIONS.DISPATCH);
      expect(r.reason).toMatch(/unknown executionType/i);
    });

    it('every return value includes a human-readable reason', () => {
      const samples = [
        {},
        { executionType: EXEC_TYPES.SYSTEM },
        { executionType: EXEC_TYPES.ACTION, stakes: STAKES.HIGH },
        { executionType: EXEC_TYPES.ACTION, winnerConfidence: 0.3 },
        {
          executionType: EXEC_TYPES.ACTION,
          stakes: STAKES.MEDIUM,
          winnerConfidence: 0.75,
        },
      ];
      for (const s of samples) {
        expect(decide(s).reason).toBeTruthy();
      }
    });
  });

  describe('DEFAULT_THRESHOLDS', () => {
    it('is frozen so consumers cannot mutate it accidentally', () => {
      expect(Object.isFrozen(DEFAULT_THRESHOLDS)).toBe(true);
    });
  });
});
