/**
 * Confirmation Gate Integration Smoke Test
 *
 * Replays the slice of the `task:assigned` handler that invokes the
 * confirmation gate, using the real gate modules. Does NOT load the
 * full exchange-bridge.js (too many Electron / WebSocket imports);
 * instead we drive the exact pattern the integration patch applies.
 *
 * The confirmation gate always runs as of the always-on cutover.
 *
 * Run:  npx vitest run test/unit/confirmation-gate-integration.test.js
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  evaluateConfirmationGate,
  applyGateEffects,
} = require('../../lib/naturalness/confirmation-gate');

// ============================================================
// Harness: mirror the task:assigned slice
// ============================================================

async function simulateTaskAssigned({ task, winner, agent }, speaker, logger) {
  const output = { gateSpoke: false, gateDecision: null };
  try {
    const gate = evaluateConfirmationGate({
      task,
      agent,
      winnerConfidence: winner.confidence ?? 1.0,
      intentConfidence: (task.metadata && task.metadata.intentConfidence) ?? 1.0,
      hasPriorContext: false,
      planSummary: winner.plan || winner.reasoning || '',
    });
    output.gateDecision = gate.decision;

    if (gate.phrase) {
      await applyGateEffects(gate, {
        speak: (text, opts) => speaker.speak(text, { ...opts, voice: 'coral' }),
        logWarn: (msg, meta) => logger.warn(msg, meta),
      });
      task.metadata = task.metadata || {};
      task.metadata._confirmationGateSpoke = true;
      output.gateSpoke = true;
    }
  } catch (err) {
    logger.warn('gate error', { error: err.message });
  }

  // Mirror of the deferred-ack block: only fires when gate did NOT speak.
  if (!(task.metadata && task.metadata._confirmationGateSpoke)) {
    if (agent.acks && agent.acks.length > 0) {
      output.deferredAckEligible = true;
    }
  }

  return output;
}

describe('confirmation-gate integration (task:assigned slice)', () => {
  let speaker;
  let logger;

  beforeEach(() => {
    speaker = { speak: vi.fn().mockResolvedValue(true) };
    logger = { warn: vi.fn() };
  });

  describe('confident action', () => {
    it('speaks a pre-action ack and suppresses the deferred ack', async () => {
      const task = { id: 't1', content: 'play some jazz', metadata: {} };
      const result = await simulateTaskAssigned(
        {
          task,
          winner: { agentId: 'dj-agent', confidence: 0.92 },
          agent: { id: 'dj-agent', executionType: 'action', acks: ['Let me find something good...'] },
        },
        speaker,
        logger
      );
      expect(speaker.speak).toHaveBeenCalledTimes(1);
      expect(result.gateSpoke).toBe(true);
      expect(result.gateDecision).toBe('ack-and-dispatch');
      expect(task.metadata._confirmationGateSpoke).toBe(true);
      expect(result.deferredAckEligible).toBeUndefined();
    });
  });

  describe('high-stakes action', () => {
    it('speaks a confirmation and logs that suspension is deferred', async () => {
      const task = { id: 't2', content: 'delete all my emails', metadata: {} };
      const result = await simulateTaskAssigned(
        {
          task,
          winner: { agentId: 'email-agent', confidence: 0.95 },
          agent: { id: 'email-agent', executionType: 'action' },
        },
        speaker,
        logger
      );
      expect(speaker.speak).toHaveBeenCalledTimes(1);
      const spokenText = speaker.speak.mock.calls[0][0];
      expect(spokenText).toMatch(/cannot be undone/i);
      expect(result.gateDecision).toBe('confirm-first');
      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [warnMsg] = logger.warn.mock.calls[0];
      expect(warnMsg).toMatch(/not yet suspending/i);
    });
  });

  describe('informational task', () => {
    it('dispatches silently and leaves deferred ack eligible', async () => {
      const result = await simulateTaskAssigned(
        {
          task: { id: 't3', content: 'what time is it', metadata: {} },
          winner: { agentId: 'time-agent', confidence: 0.95 },
          agent: {
            id: 'time-agent',
            executionType: 'informational',
            acks: ['Checking...'],
          },
        },
        speaker,
        logger
      );
      expect(speaker.speak).not.toHaveBeenCalled();
      expect(result.gateDecision).toBe('dispatch');
      expect(result.deferredAckEligible).toBe(true);
    });
  });

  describe('system agent', () => {
    it('bypasses the gate even on low-confidence routing', async () => {
      const result = await simulateTaskAssigned(
        {
          task: { id: 't4', content: 'handle failure', metadata: { intentConfidence: 0.2 } },
          winner: { agentId: 'error-agent', confidence: 0.2 },
          agent: { id: 'error-agent', executionType: 'system' },
        },
        speaker,
        logger
      );
      expect(speaker.speak).not.toHaveBeenCalled();
      expect(result.gateDecision).toBe('dispatch');
    });
  });
});
