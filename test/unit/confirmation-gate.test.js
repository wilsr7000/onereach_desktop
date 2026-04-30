/**
 * Confirmation Gate - Unit Tests
 *
 * Verifies the integration surface between the production pipeline
 * and the three Phase 1 modules (policy / stakes / phrases). Focuses
 * on the gate's public contract: given a realistic (task, agent,
 * confidences), it returns the correct decision + phrase + stakes
 * and applyGateEffects calls the injected speaker appropriately.
 *
 * Run:  npx vitest run test/unit/confirmation-gate.test.js
 */

import { describe, it, expect, vi } from 'vitest';

const {
  evaluateConfirmationGate,
  applyGateEffects,
  DECISIONS,
  STAKES,
} = require('../../lib/naturalness/confirmation-gate');

describe('evaluateConfirmationGate', () => {
  it('confident low-stakes action returns ack with a phrase', () => {
    const result = evaluateConfirmationGate({
      task: { content: 'play some jazz' },
      agent: { id: 'dj-agent', executionType: 'action' },
      winnerConfidence: 0.92,
      rng: () => 0,
    });
    expect(result.decision).toBe(DECISIONS.ACK);
    expect(result.phrase).toBeTruthy();
    expect(result.stakes).toBe(STAKES.LOW);
  });

  it('high-stakes destructive content always confirms regardless of confidence', () => {
    const result = evaluateConfirmationGate({
      task: { content: 'delete all my emails' },
      agent: { id: 'email-agent', executionType: 'action' },
      winnerConfidence: 0.99,
      intentConfidence: 1.0,
    });
    expect(result.decision).toBe(DECISIONS.CONFIRM);
    expect(result.stakes).toBe(STAKES.HIGH);
    expect(result.phrase).toMatch(/cannot be undone/i);
  });

  it('informational task dispatches silently', () => {
    const result = evaluateConfirmationGate({
      task: { content: 'what time is it' },
      agent: { id: 'time-agent', executionType: 'informational' },
    });
    expect(result.decision).toBe(DECISIONS.DISPATCH);
    expect(result.phrase).toBeNull();
  });

  it('system executionType always dispatches silently', () => {
    const result = evaluateConfirmationGate({
      task: { content: 'handle error' },
      agent: { id: 'error-agent', executionType: 'system' },
      winnerConfidence: 0.2,
      intentConfidence: 0.2,
    });
    expect(result.decision).toBe(DECISIONS.DISPATCH);
    expect(result.phrase).toBeNull();
  });

  it('medium-stakes action with shaky winner confirms', () => {
    const result = evaluateConfirmationGate({
      task: { content: 'schedule a meeting with alice tomorrow at 3' },
      agent: { id: 'calendar-mutate-agent', executionType: 'action' },
      winnerConfidence: 0.7,
    });
    expect(result.decision).toBe(DECISIONS.CONFIRM);
    expect(result.stakes).toBe(STAKES.MEDIUM);
    expect(result.phrase).toMatch(/^Want me to schedule/);
  });

  it('honors agent-declared stakes override', () => {
    const result = evaluateConfirmationGate({
      task: { content: 'play some jazz' },
      agent: { id: 'dj-agent', executionType: 'action', stakes: STAKES.HIGH },
    });
    expect(result.decision).toBe(DECISIONS.CONFIRM);
    expect(result.stakes).toBe(STAKES.HIGH);
  });

  it('defaults executionType to informational when agent is missing it', () => {
    const result = evaluateConfirmationGate({
      task: { content: 'what is the capital of france' },
      agent: { id: 'search-agent' },
    });
    expect(result.decision).toBe(DECISIONS.DISPATCH);
  });

  it('empty input does not throw and returns a dispatch', () => {
    const result = evaluateConfirmationGate();
    expect(result.decision).toBe(DECISIONS.DISPATCH);
    expect(result.phrase).toBeNull();
  });

  it('propagates the policy reason for diagnostics', () => {
    const result = evaluateConfirmationGate({
      task: { content: 'delete my old inbox' },
      agent: { id: 'email-agent', executionType: 'action' },
    });
    expect(result.reason).toBeTruthy();
  });
});

describe('applyGateEffects', () => {
  it('calls speak() with the gate phrase when phrase is present', async () => {
    const speak = vi.fn().mockResolvedValue(true);
    await applyGateEffects(
      {
        decision: DECISIONS.ACK,
        phrase: 'got it',
        stakes: STAKES.LOW,
        agent: { voice: 'coral' },
        reason: 'confident action',
      },
      { speak }
    );
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith('got it', { voice: 'coral' });
  });

  it('does not call speak() for a pure dispatch', async () => {
    const speak = vi.fn();
    await applyGateEffects(
      { decision: DECISIONS.DISPATCH, phrase: null, stakes: STAKES.LOW, agent: null, reason: 'x' },
      { speak }
    );
    expect(speak).not.toHaveBeenCalled();
  });

  it('falls back to voice=alloy when agent voice is missing', async () => {
    const speak = vi.fn().mockResolvedValue(true);
    await applyGateEffects(
      {
        decision: DECISIONS.ACK,
        phrase: 'on it',
        stakes: STAKES.LOW,
        agent: { id: 'no-voice-agent' },
        reason: 'x',
      },
      { speak }
    );
    expect(speak).toHaveBeenCalledWith('on it', { voice: 'alloy' });
  });

  it('logs a warning for confirm-first because suspension is deferred', async () => {
    const speak = vi.fn().mockResolvedValue(true);
    const logWarn = vi.fn();
    await applyGateEffects(
      {
        decision: DECISIONS.CONFIRM,
        phrase: 'Want me to schedule a meeting tomorrow at 3?',
        stakes: STAKES.MEDIUM,
        agent: { voice: 'coral' },
        reason: 'medium-stakes action',
      },
      { speak, logWarn }
    );
    expect(speak).toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledTimes(1);
    const [msg, meta] = logWarn.mock.calls[0];
    expect(msg).toMatch(/not yet suspending/i);
    expect(meta.stakes).toBe(STAKES.MEDIUM);
  });

  it('throws if effects.speak is missing', async () => {
    await expect(
      applyGateEffects({ decision: DECISIONS.ACK, phrase: 'got it', stakes: 'low' }, {})
    ).rejects.toThrow(/speak is required/);
  });
});
