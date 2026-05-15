/**
 * agent-result-normalize -- dual-channel contract shim tests
 *
 * Pins the migration shim that lets legacy agents (single `message`
 * field) coexist with new dual-channel agents (separate spokenSummary
 * + visualText). The shim is the keystone of the Orb Unified UX work
 * (see /.cursor/plans/orb_chat_unified_ux_*.plan.md):
 *
 *   - Scenario 1 (voice-in, rich): spokenSummary != visualText; both set
 *   - Scenario 2 (text-in, rich):  visualText set; spokenSummary unused
 *   - Scenario 3 (simple):         spokenSummary == visualText (== message)
 *   - Legacy:                       only `message` -> spoken == visual
 *
 * displayMode heuristic invariants:
 *   - explicit displayMode always wins
 *   - panelWidth >= 400 OR panelHeight >= 300 -> 'modal'
 *   - has html/ui but small -> 'inline'
 *   - no html/ui -> null (text-only chat append)
 */

import { describe, it, expect } from 'vitest';

const { normalizeAgentResult, MODAL_MIN_WIDTH, MODAL_MIN_HEIGHT } = require('../../lib/agent-result-normalize.js');

describe('normalizeAgentResult -- legacy agent backward compatibility', () => {
  it('legacy agent with only `message` -> spoken == visual == message', () => {
    const r = normalizeAgentResult({ success: true, message: 'Hello there.' });
    expect(r.spokenSummary).toBe('Hello there.');
    expect(r.visualText).toBe('Hello there.');
  });

  it('legacy agent with `message` + `html` (small) -> displayMode = "inline"', () => {
    const r = normalizeAgentResult({ success: true, message: 'See below', html: '<div>x</div>' });
    expect(r.displayMode).toBe('inline');
  });

  it('legacy agent with `message` + `ui` spec but no panelWidth -> "inline"', () => {
    const r = normalizeAgentResult({ success: true, message: 'See list', ui: { type: 'eventList', events: [] } });
    expect(r.displayMode).toBe('inline');
  });

  it('legacy agent text-only -> displayMode = null (chat-only render)', () => {
    const r = normalizeAgentResult({ success: true, message: '72 and sunny.' });
    expect(r.displayMode).toBeNull();
    expect(r.html).toBeNull();
    expect(r.ui).toBeNull();
  });

  it('legacy daily-brief shape (panelWidth: 480) -> "modal" via heuristic', () => {
    const r = normalizeAgentResult({
      success: true,
      message: 'Three meetings today.',
      ui: { type: 'dayView' },
      panelWidth: 480,
      panelHeight: 720,
    });
    expect(r.displayMode).toBe('modal');
    expect(r.panelWidth).toBe(480);
    expect(r.panelHeight).toBe(720);
  });
});

describe('normalizeAgentResult -- new dual-channel contract', () => {
  it('Scenario 1: voice-in rich -- spokenSummary and visualText differ', () => {
    const r = normalizeAgentResult({
      success: true,
      spokenSummary: 'Three meetings, two need prep.',
      visualText:
        'You have 3 meetings: 9am client review (needs deck), 11am 1:1 with Sarah, 2pm board prep (needs summary).',
      ui: { type: 'dayView' },
      panelWidth: 480,
      panelHeight: 540,
    });
    expect(r.spokenSummary).toBe('Three meetings, two need prep.');
    expect(r.visualText).toContain('client review');
    expect(r.visualText).not.toBe(r.spokenSummary);
    expect(r.displayMode).toBe('modal');
  });

  it('Scenario 2: text-in rich -- visualText set, spokenSummary unused (but legal to set anyway)', () => {
    const r = normalizeAgentResult({
      success: true,
      spokenSummary: '', // explicit empty -- caller will gate TTS by inputModality
      visualText: 'Pasted: 200-word doc; summarized as: ...',
      html: '<div class="summary">...</div>',
      panelWidth: 360,
    });
    expect(r.visualText).toContain('Pasted:');
    expect(r.displayMode).toBe('inline'); // 360 < MODAL_MIN_WIDTH
  });

  it('Scenario 3: simple -- spokenSummary == visualText, no UI', () => {
    const r = normalizeAgentResult({
      success: true,
      spokenSummary: '72 and sunny in Austin.',
      visualText: '72 and sunny in Austin.',
    });
    expect(r.spokenSummary).toBe(r.visualText);
    expect(r.displayMode).toBeNull();
  });

  it('explicit displayMode = "modal" wins even when small', () => {
    const r = normalizeAgentResult({
      success: true,
      message: 'x',
      displayMode: 'modal',
      panelWidth: 200,
      panelHeight: 200,
    });
    expect(r.displayMode).toBe('modal');
  });

  it('explicit displayMode = "inline" wins even when large', () => {
    const r = normalizeAgentResult({
      success: true,
      message: 'x',
      displayMode: 'inline',
      panelWidth: 800,
      panelHeight: 600,
    });
    expect(r.displayMode).toBe('inline');
  });

  it('new fields take precedence over legacy `message`', () => {
    const r = normalizeAgentResult({
      success: true,
      message: 'this is the legacy single channel',
      spokenSummary: 'spoken',
      visualText: 'visual',
    });
    expect(r.spokenSummary).toBe('spoken');
    expect(r.visualText).toBe('visual');
  });

  it('partial new fields: spokenSummary only -> visualText falls back to message', () => {
    const r = normalizeAgentResult({
      success: true,
      message: 'fallback text',
      spokenSummary: 'short',
    });
    expect(r.spokenSummary).toBe('short');
    expect(r.visualText).toBe('fallback text');
  });

  it('partial new fields: visualText only -> spokenSummary falls back to message', () => {
    const r = normalizeAgentResult({
      success: true,
      message: 'fallback text',
      visualText: 'longer visual',
    });
    expect(r.spokenSummary).toBe('fallback text');
    expect(r.visualText).toBe('longer visual');
  });
});

describe('normalizeAgentResult -- displayMode heuristic boundaries', () => {
  it(`panelWidth exactly ${MODAL_MIN_WIDTH} -> modal`, () => {
    const r = normalizeAgentResult({ success: true, message: 'x', html: '<div>x</div>', panelWidth: MODAL_MIN_WIDTH });
    expect(r.displayMode).toBe('modal');
  });

  it(`panelWidth ${MODAL_MIN_WIDTH - 1} -> inline`, () => {
    const r = normalizeAgentResult({ success: true, message: 'x', html: '<div>x</div>', panelWidth: MODAL_MIN_WIDTH - 1 });
    expect(r.displayMode).toBe('inline');
  });

  it(`panelHeight exactly ${MODAL_MIN_HEIGHT} -> modal`, () => {
    const r = normalizeAgentResult({ success: true, message: 'x', html: '<div>x</div>', panelHeight: MODAL_MIN_HEIGHT });
    expect(r.displayMode).toBe('modal');
  });

  it(`panelHeight ${MODAL_MIN_HEIGHT - 1} with no panelWidth -> inline`, () => {
    const r = normalizeAgentResult({
      success: true,
      message: 'x',
      html: '<div>x</div>',
      panelHeight: MODAL_MIN_HEIGHT - 1,
    });
    expect(r.displayMode).toBe('inline');
  });

  it('large panelHeight wins even if width is small', () => {
    const r = normalizeAgentResult({ success: true, message: 'x', html: '<div>x</div>', panelWidth: 200, panelHeight: 600 });
    expect(r.displayMode).toBe('modal');
  });

  it('zero or negative dimensions ignored (treated as null)', () => {
    const r = normalizeAgentResult({ success: true, message: 'x', html: '<div>x</div>', panelWidth: 0, panelHeight: -100 });
    expect(r.displayMode).toBe('inline');
    expect(r.panelWidth).toBeNull();
    expect(r.panelHeight).toBeNull();
  });
});

describe('normalizeAgentResult -- defensive shape handling', () => {
  it('null result -> safe empty shape with success=false', () => {
    const r = normalizeAgentResult(null);
    expect(r.success).toBe(false);
    expect(r.spokenSummary).toBe('');
    expect(r.visualText).toBe('');
    expect(r.displayMode).toBeNull();
  });

  it('undefined result -> same as null', () => {
    const r = normalizeAgentResult(undefined);
    expect(r.success).toBe(false);
  });

  it('string result (non-object) -> safe empty shape', () => {
    const r = normalizeAgentResult('oops');
    expect(r.success).toBe(false);
    expect(r.spokenSummary).toBe('');
  });

  it('result with success=false explicitly -> preserved', () => {
    const r = normalizeAgentResult({ success: false, message: 'sorry' });
    expect(r.success).toBe(false);
    expect(r.spokenSummary).toBe('sorry');
  });

  it('preserves passthrough fields (data, soundCue, needsInput, agentId, etc.)', () => {
    const r = normalizeAgentResult({
      success: true,
      message: 'm',
      data: { foo: 'bar' },
      soundCue: { type: 'one-shot', name: 'morning-motif' },
      needsInput: { prompt: 'pick one' },
      agentId: 'daily-brief-agent',
      anythingElse: 42,
    });
    expect(r.data).toEqual({ foo: 'bar' });
    expect(r.soundCue).toEqual({ type: 'one-shot', name: 'morning-motif' });
    expect(r.needsInput).toEqual({ prompt: 'pick one' });
    expect(r.agentId).toBe('daily-brief-agent');
    expect(r.anythingElse).toBe(42);
  });
});
