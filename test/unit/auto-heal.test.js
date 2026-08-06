/**
 * UC-05 / UC-08: agents fix THEMSELVES.
 *
 * agent-health-tracker: per-agent failure + quality streaks (transient
 * failures excluded, successes reset, 3-attempt hard cap).
 * auto-heal: rebuild-in-place from the playbook via the Claude Code
 * builder, honest announce, post-heal retry of the original request.
 * Plus the middleware emitting the structured failure event that feeds it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// CJS singleton monkey-patch (neither vi.mock nor vi.spyOn reliably
// intercepts this repo's CJS singletons under vitest): the middleware logs
// through the same getLogQueue() instance, so direct method replacement is
// the seam that provably works (see repo gotchas).
const { getLogQueue } = require('../../lib/log-event-queue');
const realLog = getLogQueue();
const logMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const errorCalls = [];
realLog.error = (...args) => { errorCalls.push(args); };
realLog.info = () => {};
realLog.warn = () => {};

import { AgentHealthTracker, DEFAULTS } from '../../lib/exchange/agent-health-tracker.js';
import { attemptAutoHeal } from '../../lib/exchange/auto-heal.js';

// CJS require (not ESM import) so the middleware shares the SAME
// log-event-queue instance the spy above is attached to.
const { safeExecuteAgent } = require('../../packages/agents/agent-middleware.js');

// ─── tracker ─────────────────────────────────────────────────────────────────

describe('AgentHealthTracker', () => {
  let t;
  beforeEach(() => {
    t = new AgentHealthTracker();
  });

  it('heals after 2 consecutive HARD failures; transient never counts', () => {
    t.recordFailure('a1', { transient: true });
    t.recordFailure('a1', { transient: true });
    expect(t.evaluate('a1').heal).toBe(false);

    t.recordFailure('a1', { taskContent: 'set a timer' });
    expect(t.evaluate('a1').heal).toBe(false);
    t.recordFailure('a1');
    const d = t.evaluate('a1');
    expect(d).toMatchObject({ heal: true, reason: 'failure-streak', lastTaskContent: 'set a timer' });
  });

  it('heals after 2 consecutive bad grades (quality streak)', () => {
    t.recordBadGrade('a1');
    expect(t.evaluate('a1').heal).toBe(false);
    t.recordBadGrade('a1', { taskContent: 'whats my day look like' });
    expect(t.evaluate('a1')).toMatchObject({ heal: true, reason: 'quality-streak' });
  });

  it('a success resets both streaks (thresholds mean CONSECUTIVE)', () => {
    t.recordFailure('a1');
    t.recordBadGrade('a1');
    t.recordSuccess('a1');
    t.recordFailure('a1');
    t.recordBadGrade('a1');
    expect(t.evaluate('a1').heal).toBe(false);
  });

  it('hard-caps heal attempts at 3 per agent', () => {
    expect(DEFAULTS.maxHealAttempts).toBe(3);
    expect(t.beginHealAttempt('a1')).toBe(1);
    expect(t.beginHealAttempt('a1')).toBe(2);
    expect(t.beginHealAttempt('a1')).toBe(3);
    expect(t.beginHealAttempt('a1')).toBeNull();
    t.recordFailure('a1');
    t.recordFailure('a1');
    expect(t.evaluate('a1')).toMatchObject({ heal: false, reason: 'attempts-exhausted' });
  });

  it('beginHealAttempt clears the triggering streaks', () => {
    t.recordFailure('a1');
    t.recordFailure('a1');
    t.beginHealAttempt('a1');
    expect(t.snapshot('a1')).toMatchObject({ failures: 0, badGrades: 0, healAttempts: 1 });
  });

  it('tracks agents independently', () => {
    t.recordFailure('a1');
    t.recordFailure('a1');
    expect(t.evaluate('a1').heal).toBe(true);
    expect(t.evaluate('a2').heal).toBe(false);
  });
});

// ─── auto-heal executor ──────────────────────────────────────────────────────

describe('attemptAutoHeal', () => {
  const DEF = {
    id: 'agent-123',
    name: 'Alarm Manager',
    description: 'alarms',
    prompt: 'You manage alarms.',
    playbook: { markdown: '# Local Agent Playbook: Alarm Manager\n## Goal\nAlarms.' },
  };

  let tracker;
  let deps;
  let spoken;
  let resubmitted;

  beforeEach(() => {
    tracker = new AgentHealthTracker();
    spoken = [];
    resubmitted = [];
    deps = {
      tracker,
      getAgentDef: vi.fn((id) => (id === 'agent-123' ? DEF : null)),
      builder: vi.fn(async () => ({
        success: true,
        agent: { id: 'agent-123', name: 'Alarm Manager' },
        verified: { mode: 'live-tested', detail: 'ok' },
      })),
      speak: vi.fn(async (t) => spoken.push(t)),
      resubmit: vi.fn(async (text, meta) => resubmitted.push({ text, meta })),
      log: logMock,
    };
  });

  it('rebuilds in place from the playbook, announces, and retries the original request', async () => {
    const out = await attemptAutoHeal(
      { agentId: 'agent-123', reason: 'failure-streak', originalRequest: 'set an alarm for 6am' },
      deps
    );

    expect(out).toMatchObject({ healed: true, attempt: 1, verifiedMode: 'live-tested', retried: true });

    // Built FROM the stored spec, updating the SAME agent
    const [request, opts] = deps.builder.mock.calls[0];
    expect(request).toContain('# Local Agent Playbook: Alarm Manager'); // playbook is the spec
    expect(opts.updateAgentId).toBe('agent-123');

    // Honest announce + one retry with the loop guard
    expect(spoken[0]).toMatch(/rebuilt and tested/i);
    expect(resubmitted[0]).toMatchObject({
      text: 'set an alarm for 6am',
      meta: { retriedAfterHeal: true, healedAgentId: 'agent-123' },
    });
  });

  it('never heals built-in/unknown agents', async () => {
    const out = await attemptAutoHeal({ agentId: 'time-agent', reason: 'failure-streak' }, deps);
    expect(out).toEqual({ healed: false, reason: 'not-a-store-agent' });
    expect(deps.builder).not.toHaveBeenCalled();
    expect(tracker.snapshot('time-agent').healAttempts).toBe(0); // no attempt consumed
  });

  it('gives up honestly after 3 attempts', async () => {
    deps.builder.mockResolvedValue({ success: false, error: 'nope', verified: { mode: 'failed' } });
    for (let i = 1; i <= 3; i++) {
      const out = await attemptAutoHeal({ agentId: 'agent-123', reason: 'failure-streak' }, deps);
      expect(out).toMatchObject({ healed: false, reason: 'rebuild-failed', attempt: i });
    }
    const fourth = await attemptAutoHeal({ agentId: 'agent-123', reason: 'failure-streak' }, deps);
    expect(fourth).toMatchObject({ healed: false, reason: 'attempts-exhausted' });
    expect(deps.builder).toHaveBeenCalledTimes(3); // hard cap
    expect(spoken.at(-1)).toMatch(/tried fixing .* three times/i);
  });

  it('pending-restart heals announce honestly and do NOT retry', async () => {
    deps.builder.mockResolvedValue({
      success: true,
      agent: { id: 'agent-123' },
      verified: { mode: 'config-pending-restart', detail: 'executionType=llm' },
    });
    const out = await attemptAutoHeal(
      { agentId: 'agent-123', reason: 'quality-streak', originalRequest: 'set an alarm' },
      deps
    );
    expect(out).toMatchObject({ healed: true, verifiedMode: 'config-pending-restart', retried: false });
    expect(spoken[0]).toMatch(/after the next restart/i);
    expect(deps.resubmit).not.toHaveBeenCalled();
  });

  it('a thrown rebuild counts the attempt but reports honestly', async () => {
    deps.builder.mockRejectedValue(new Error('builder exploded'));
    const out = await attemptAutoHeal({ agentId: 'agent-123', reason: 'failure-streak' }, deps);
    expect(out).toMatchObject({ healed: false, reason: 'rebuild-threw', attempt: 1 });
  });
});

// ─── the middleware event that feeds the loop ────────────────────────────────

describe('middleware emits agent:execution-failure', () => {
  beforeEach(() => {
    errorCalls.length = 0;
  });

  it('hard failures carry the structured event with errorClass hard + task content', async () => {
    const agent = {
      id: 'agent-123',
      name: 'Alarm Manager',
      execute: async () => {
        throw new Error('boom');
      },
    };
    await safeExecuteAgent(agent, { content: 'set an alarm for 6am' });
    const call = errorCalls.find((c) => c[1]?.includes('execution failed'));
    expect(call[2]).toMatchObject({
      event: 'agent:execution-failure',
      agentId: 'agent-123',
      errorClass: 'hard',
      taskContent: 'set an alarm for 6am',
    });
  });

  it('rate limits are transient (never count toward healing)', async () => {
    const agent = {
      id: 'agent-123',
      name: 'Alarm Manager',
      execute: async () => {
        const e = new Error('too many requests');
        e.statusCode = 429;
        throw e;
      },
    };
    await safeExecuteAgent(agent, { content: 'x' });
    const call = errorCalls.find((c) => c[1]?.includes('execution failed'));
    expect(call[2].errorClass).toBe('transient');
  });
});

// ─── bridge wiring invariants ────────────────────────────────────────────────

describe('exchange-bridge auto-heal wiring (source invariants)', () => {
  const fs = require('fs');
  const path = require('path');
  const SRC = fs.readFileSync(path.join(__dirname, '../../src/voice-task-sdk/exchange-bridge.js'), 'utf8');

  it('subscribes failure events and low-quality grades into the tracker', () => {
    expect(SRC).toMatch(/agent:execution-failure/);
    expect(SRC).toMatch(/healTracker\.recordFailure/);
    expect(SRC).toMatch(/learning:low-quality-answer[\s\S]{0,400}recordBadGrade/);
  });

  it('evaluates and heals via attemptAutoHeal with the store/builder/speak deps', () => {
    expect(SRC).toMatch(/require\('\.\.\/\.\.\/lib\/exchange\/auto-heal'\)/);
    expect(SRC).toMatch(/attemptAutoHeal\(/);
    expect(SRC).toMatch(/resubmit:/);
    // The post-heal retry guard lives in the executor itself
    const healSrc = fs.readFileSync(path.join(__dirname, '../../lib/exchange/auto-heal.js'), 'utf8');
    expect(healSrc).toMatch(/retriedAfterHeal/);
  });
});
