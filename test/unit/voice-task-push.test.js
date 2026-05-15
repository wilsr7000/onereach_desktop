/**
 * voice-task-push -- proactive alert pipeline
 *
 * Phase 6 of Orb Unified UX redesign. Agents push proactive alerts
 * (critical-meeting alarms, scheduled briefs, monitor-agent findings)
 * via pushProactiveAlert(...). The bridge subscribes via
 * setProactiveListener and routes alerts through the SAME unified
 * surfaces as user-initiated tasks (chat history, hybrid inline/modal,
 * TTS).
 *
 * This test pins the pure logic + listener registration. The bridge
 * integration (chat broadcast, history append, modal spawn, TTS) is
 * pinned at the source level in
 * test/unit/exchange-bridge-proactive-dispatch.test.js.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const push = require('../../lib/voice-task-push.js');

beforeEach(() => {
  push._clearListeners();
});

describe('pushProactiveAlert -- input validation', () => {
  it('throws on missing payload', () => {
    expect(() => push.pushProactiveAlert()).toThrow(TypeError);
    expect(() => push.pushProactiveAlert(null)).toThrow(TypeError);
    expect(() => push.pushProactiveAlert('oops')).toThrow(TypeError);
  });

  it('throws on missing agentId', () => {
    expect(() => push.pushProactiveAlert({ message: 'x' })).toThrow(RangeError);
    expect(() => push.pushProactiveAlert({ agentId: '', message: 'x' })).toThrow(RangeError);
  });

  it('throws when neither spokenSummary, visualText, nor message provided', () => {
    expect(() =>
      push.pushProactiveAlert({ agentId: 'critical-meeting-alarm' })
    ).toThrow(RangeError);
    expect(() =>
      push.pushProactiveAlert({ agentId: 'critical-meeting-alarm', message: '' })
    ).toThrow(RangeError);
  });

  it('accepts spokenSummary alone (visualText falls back)', () => {
    push.setProactiveListener(() => {});
    expect(() =>
      push.pushProactiveAlert({
        agentId: 'critical-meeting-alarm',
        spokenSummary: 'Sales sync starts in 2 minutes.',
      })
    ).not.toThrow();
  });

  it('accepts visualText alone (spokenSummary falls back)', () => {
    push.setProactiveListener(() => {});
    expect(() =>
      push.pushProactiveAlert({
        agentId: 'monitor-agent',
        visualText: 'Disk usage exceeded 90%',
      })
    ).not.toThrow();
  });

  it('accepts legacy message alone (both channels fall back)', () => {
    push.setProactiveListener(() => {});
    expect(() =>
      push.pushProactiveAlert({
        agentId: 'critical-meeting-alarm',
        message: 'Meeting in 2 minutes.',
      })
    ).not.toThrow();
  });
});

describe('pushProactiveAlert -- listener invocation', () => {
  it('invokes registered listener with synthetic task + result + agentId', () => {
    const cb = vi.fn();
    push.setProactiveListener(cb);
    const taskId = push.pushProactiveAlert({
      agentId: 'critical-meeting-alarm',
      agentName: 'Meeting Alarm',
      spokenSummary: 'Sales sync in 2 minutes.',
      visualText: 'Sales sync (Acme) in 2 minutes. Conf A. Link: ...',
      panelWidth: 380,
      panelHeight: 220,
    });
    expect(cb).toHaveBeenCalledTimes(1);
    const arg = cb.mock.calls[0][0];
    expect(arg.task).toBeDefined();
    expect(arg.task.id).toBe(taskId);
    expect(arg.task.metadata.origin).toBe('proactive');
    expect(arg.task.inputModality).toBe('voice');
    expect(arg.task.agentId).toBe('critical-meeting-alarm');
    expect(arg.agentId).toBe('critical-meeting-alarm');
    expect(arg.result.success).toBe(true);
    expect(arg.result.spokenSummary).toBe('Sales sync in 2 minutes.');
    expect(arg.result.visualText).toContain('Acme');
    expect(arg.result.panelWidth).toBe(380);
  });

  it('returns the synthetic taskId so caller can correlate', () => {
    push.setProactiveListener(() => {});
    const taskId = push.pushProactiveAlert({
      agentId: 'a',
      message: 'hi',
    });
    expect(typeof taskId).toBe('string');
    expect(taskId.length).toBeGreaterThan(5);
  });

  it('uses caller-provided taskId when set (idempotent push)', () => {
    push.setProactiveListener(() => {});
    const taskId = push.pushProactiveAlert({
      agentId: 'a',
      message: 'hi',
      taskId: 'fixed-ulid-123',
    });
    expect(taskId).toBe('fixed-ulid-123');
  });

  it('no listener registered = silent drop, no throw', () => {
    expect(() =>
      push.pushProactiveAlert({ agentId: 'a', message: 'hi' })
    ).not.toThrow();
  });

  it('multiple listeners all receive the alert', () => {
    const a = vi.fn();
    const b = vi.fn();
    push.setProactiveListener(a);
    push.setProactiveListener(b);
    push.pushProactiveAlert({ agentId: 'x', message: 'hi' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('one listener throwing does not block other listeners', () => {
    const bad = vi.fn(() => { throw new Error('boom'); });
    const good = vi.fn();
    push.setProactiveListener(bad);
    push.setProactiveListener(good);
    push.pushProactiveAlert({ agentId: 'x', message: 'hi' });
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('setProactiveListener returns an unsubscribe function', () => {
    const cb = vi.fn();
    const unsub = push.setProactiveListener(cb);
    push.pushProactiveAlert({ agentId: 'x', message: 'first' });
    unsub();
    push.pushProactiveAlert({ agentId: 'x', message: 'second' });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('rejects non-function listener', () => {
    const unsub = push.setProactiveListener('not a function');
    expect(typeof unsub).toBe('function');
    expect(push._getListenerCount()).toBe(0);
  });
});

describe('pushProactiveAlert -- result shape (what the listener gets)', () => {
  it('forwards ui, html, panelWidth, panelHeight, displayMode, soundCue, data', () => {
    const cb = vi.fn();
    push.setProactiveListener(cb);
    push.pushProactiveAlert({
      agentId: 'critical-meeting-alarm',
      spokenSummary: 'attention',
      ui: { type: 'alarmCard', meeting: 'Sales' },
      html: '<div class="alarm">x</div>',
      panelWidth: 380,
      panelHeight: 220,
      displayMode: 'modal',
      soundCue: { type: 'one-shot', name: 'attention' },
      data: { meetingId: 'abc' },
    });
    const r = cb.mock.calls[0][0].result;
    expect(r.ui).toEqual({ type: 'alarmCard', meeting: 'Sales' });
    expect(r.html).toBe('<div class="alarm">x</div>');
    expect(r.panelWidth).toBe(380);
    expect(r.panelHeight).toBe(220);
    expect(r.displayMode).toBe('modal');
    expect(r.soundCue).toEqual({ type: 'one-shot', name: 'attention' });
    expect(r.data).toEqual({ meetingId: 'abc' });
  });

  it('synthetic task always tagged origin: proactive AND inputModality: voice', () => {
    const cb = vi.fn();
    push.setProactiveListener(cb);
    push.pushProactiveAlert({ agentId: 'a', message: 'hi' });
    const t = cb.mock.calls[0][0].task;
    expect(t.metadata.origin).toBe('proactive');
    expect(t.inputModality).toBe('voice');
  });
});
