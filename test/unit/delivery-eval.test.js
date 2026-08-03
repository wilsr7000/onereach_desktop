/**
 * delivery-eval -- end-of-turn "did the user actually get the answer?" verdict
 *
 * Pins the eval the voice pipeline was missing: every prior failure mode
 * (orphaned dispatch, dropped audio, rejected state transition) was SILENT.
 * The eval grades each settled voice task, alarms on failure (error-level
 * central event + broadcast + one-shot audible fallback), and surfaces the
 * reflector's low-quality flag centrally.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// The logger is injected through the module's _deps seam (module-level
// vi.mock doesn't reliably intercept this CJS require chain in this repo).
const logged = [];
const captureLog = {
  info: (cat, msg, data) => logged.push({ level: 'info', cat, msg, data }),
  warn: (cat, msg, data) => logged.push({ level: 'warn', cat, msg, data }),
  error: (cat, msg, data) => logged.push({ level: 'error', cat, msg, data }),
  debug: () => {},
};

const deliveryEval = require('../../lib/delivery-eval');
const { computeVerdict, evaluateDelivery, subscribeQualityFlags } = deliveryEval;

let speak, broadcast;
beforeEach(() => {
  logged.length = 0;
  deliveryEval.__resetForTests();
  speak = vi.fn(() => Promise.resolve(true));
  broadcast = vi.fn();
  deliveryEval.__setDeps({ log: captureLog, getSpeaker: () => ({ speak }), broadcast });
});

describe('computeVerdict (pure)', () => {
  it('delivered when speak confirmed playback', () => {
    expect(computeVerdict({ inputModality: 'voice', spokenSummary: 'hi', speakAttempted: true, speakResult: true }))
      .toBe('delivered');
  });

  it('silent-failure when speak resolved false (playback never confirmed)', () => {
    expect(computeVerdict({ inputModality: 'voice', spokenSummary: 'hi', speakAttempted: true, speakResult: false }))
      .toBe('silent-failure');
  });

  it('silent-failure when the speak path threw', () => {
    expect(computeVerdict({ inputModality: 'voice', spokenSummary: 'hi', speakAttempted: true, error: 'boom' }))
      .toBe('silent-failure');
  });

  it('not-spoken when voice-in but TTS never attempted (e.g. no speaker)', () => {
    expect(computeVerdict({ inputModality: 'voice', spokenSummary: 'hi', speakAttempted: false }))
      .toBe('not-spoken');
  });

  it('not-spoken when voice-in settled with no spokenSummary at all', () => {
    expect(computeVerdict({ inputModality: 'voice', spokenSummary: '', speakAttempted: false }))
      .toBe('not-spoken');
  });

  it('skipped-text passes for text-in tasks', () => {
    expect(computeVerdict({ inputModality: 'text', spokenSummary: 'hi', speakAttempted: false }))
      .toBe('skipped-text');
  });

  it('partial-no-panel when speech played but the promised modal never spawned', () => {
    expect(computeVerdict({
      inputModality: 'voice', spokenSummary: 'brief on screen', speakAttempted: true, speakResult: true,
      panelPromised: true, panelShown: false,
    })).toBe('partial-no-panel');
  });

  it('delivered when the promised panel actually spawned', () => {
    expect(computeVerdict({
      inputModality: 'voice', spokenSummary: 'hi', speakAttempted: true, speakResult: true,
      panelPromised: true, panelShown: true,
    })).toBe('delivered');
  });

  it('does not grade panels when the caller supplied no panel facts (backward compat)', () => {
    expect(computeVerdict({ inputModality: 'voice', spokenSummary: 'hi', speakAttempted: true, speakResult: true }))
      .toBe('delivered');
  });

  it('silent-failure outranks the panel grade when speech itself failed', () => {
    expect(computeVerdict({
      inputModality: 'voice', spokenSummary: 'hi', speakAttempted: true, speakResult: false,
      panelPromised: true, panelShown: false,
    })).toBe('silent-failure');
  });
});

describe('evaluateDelivery — partial-no-panel gets LOUD with a panel-specific fallback', () => {
  it('logs error, broadcasts, and speaks the results-window apology', async () => {
    evaluateDelivery({
      taskId: 't9', inputModality: 'voice', spokenSummary: 'brief on screen',
      speakAttempted: true, speakResult: true, panelPromised: true, panelShown: false,
    });
    const entry = logged.find((l) => l.data?.event === 'delivery:verdict');
    expect(entry.level).toBe('error');
    expect(entry.data.verdict).toBe('partial-no-panel');
    expect(broadcast).toHaveBeenCalledWith(
      'voice-task:delivery-failed',
      expect.objectContaining({ verdict: 'partial-no-panel' })
    );
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0][0]).toMatch(/results window/i);
  });
});

describe('evaluateDelivery — success paths stay quiet', () => {
  it('logs info and does NOT broadcast or speak fallback on delivered', () => {
    evaluateDelivery({ taskId: 't1', inputModality: 'voice', spokenSummary: 'hi', speakAttempted: true, speakResult: true });
    const entry = logged.find((l) => l.data?.event === 'delivery:verdict');
    expect(entry.level).toBe('info');
    expect(entry.data.verdict).toBe('delivered');
    expect(broadcast).not.toHaveBeenCalled();
    expect(speak).not.toHaveBeenCalled();
  });
});

describe('evaluateDelivery — silent failures get LOUD', () => {
  it('logs at ERROR level with the verdict', () => {
    evaluateDelivery({ taskId: 't1', inputModality: 'voice', spokenSummary: 'hi', speakAttempted: true, speakResult: false });
    const entry = logged.find((l) => l.data?.event === 'delivery:verdict');
    expect(entry.level).toBe('error');
    expect(entry.data.verdict).toBe('silent-failure');
  });

  it('broadcasts voice-task:delivery-failed for UI surfaces', () => {
    evaluateDelivery({ taskId: 't1', inputModality: 'voice', spokenSummary: 'hi', speakAttempted: true, speakResult: false });
    expect(broadcast).toHaveBeenCalledWith(
      'voice-task:delivery-failed',
      expect.objectContaining({ taskId: 't1', verdict: 'silent-failure' })
    );
  });

  it('speaks ONE audible fallback per task (no repeat, no recursion)', () => {
    const facts = { taskId: 't1', inputModality: 'voice', spokenSummary: 'hi', speakAttempted: true, speakResult: false };
    evaluateDelivery(facts);
    evaluateDelivery(facts); // duplicate settle / retry grading
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0][0]).toMatch(/couldn't deliver/i);
  });

  it('a failing fallback is logged but never re-graded (no infinite loop)', async () => {
    speak.mockReturnValueOnce(Promise.resolve(false));
    evaluateDelivery({ taskId: 't2', inputModality: 'voice', spokenSummary: 'hi', speakAttempted: true, speakResult: false });
    await new Promise((r) => { setTimeout(r, 0); });
    const fb = logged.find((l) => l.data?.event === 'delivery:fallback');
    expect(fb.level).toBe('error');
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it('never throws even if grading itself explodes', () => {
    deliveryEval.__setDeps({ getSpeaker: () => { throw new Error('kaboom'); } });
    expect(() =>
      evaluateDelivery({ taskId: 't3', inputModality: 'voice', spokenSummary: 'hi', speakAttempted: true, speakResult: false })
    ).not.toThrow();
  });
});

describe('subscribeQualityFlags — reflector verdict surfaces centrally', () => {
  it('logs a warn-level delivery:quality-flag on learning:low-quality-answer', () => {
    const bus = new EventEmitter();
    subscribeQualityFlags(bus);
    bus.emit('learning:low-quality-answer', { taskId: 't1', agentId: 'daily-brief-agent', score: 0.3, reason: 'vacuous' });
    const entry = logged.find((l) => l.data?.event === 'delivery:quality-flag');
    expect(entry.level).toBe('warn');
    expect(entry.data.agentId).toBe('daily-brief-agent');
  });

  it('subscribes only once even if called twice', () => {
    const bus = new EventEmitter();
    subscribeQualityFlags(bus);
    subscribeQualityFlags(bus);
    expect(bus.listenerCount('learning:low-quality-answer')).toBe(1);
  });
});
