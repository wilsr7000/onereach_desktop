/**
 * Regression: the WS task_result payload must carry the rich dual-channel + UI
 * fields. Dropping ui, displayMode, panelWidth/Height, spokenSummary/visualText was why the
 * daily-brief dayView modal never popped (and voice==chat) — the fields were
 * stripped on the exchange hop before the settled handler could render them.
 *
 * Run: npx vitest run test/unit/marshal-task-result.test.js
 */

import { describe, it, expect } from 'vitest';

const { marshalTaskResult } = require('../../lib/exchange/marshal-task-result');

describe('marshalTaskResult', () => {
  it('preserves the dayView modal fields a daily-brief-style agent returns', () => {
    const agentResult = {
      success: true,
      message: 'Nine meetings today, brief on screen.',
      spokenSummary: 'Nine meetings today, brief on screen.',
      visualText: 'Daily brief for today',
      displayMode: 'modal',
      ui: { type: 'dayView', events: [] },
      panelWidth: 480,
      panelHeight: 700,
      soundCue: { type: 'one-shot', name: 'morning-motif' },
      data: { type: 'morning_brief' },
    };
    const out = marshalTaskResult(agentResult, agentResult.message);

    // The exact fields that used to be dropped:
    expect(out.ui).toEqual({ type: 'dayView', events: [] });
    expect(out.displayMode).toBe('modal');
    expect(out.panelWidth).toBe(480);
    expect(out.panelHeight).toBe(700);
    expect(out.spokenSummary).toBe('Nine meetings today, brief on screen.');
    expect(out.visualText).toBe('Daily brief for today');
    expect(out.soundCue).toEqual({ type: 'one-shot', name: 'morning-motif' });
    expect(out.data).toEqual({ type: 'morning_brief' });
    expect(out.success).toBe(true);
    expect(out.output).toBe('Nine meetings today, brief on screen.');
  });

  it('uses the provided output (needsInput.prompt) over the raw message', () => {
    const out = marshalTaskResult(
      { success: true, message: 'short', needsInput: { agentId: 'a', prompt: 'Which calendar?' } },
      'Which calendar?'
    );
    expect(out.output).toBe('Which calendar?');
    expect(out.needsInput).toEqual({ agentId: 'a', prompt: 'Which calendar?' });
  });

  it('carries error only on failure', () => {
    expect(marshalTaskResult({ success: false, error: 'boom' }, null).error).toBe('boom');
    expect(marshalTaskResult({ success: true, error: 'ignored' }, 'ok').error).toBeUndefined();
  });

  it('is null-safe and omits absent fields as undefined', () => {
    const out = marshalTaskResult(null, 'x');
    expect(out.output).toBe('x');
    expect(out.ui).toBeUndefined();
    expect(out.displayMode).toBeUndefined();
  });
});
