/**
 * Multi-turn modal (ADR-EX-003 follow-up). handleNeedsInput now renders a
 * follow-up question's UI as a modal keyed to the pending agent, so an agent can
 * present a modal form on EVERY turn, not just the first. This pins the exact
 * precondition that new branch relies on:
 *
 *   a needsInput result carrying a modal-sized UI  ->  normalizeAgentResult
 *   yields displayMode 'modal' + renderable html  ->  showAgentUIModal fires.
 *
 * The wiring mirrors the proven task:settled modal path; this locks the
 * decision that gates it.
 */

import { describe, it, expect } from 'vitest';

const { normalizeAgentResult } = require('../../lib/agent-result-normalize');
const { renderAgentUI } = require('../../lib/agent-ui-renderer');

describe('follow-up needsInput modal precondition', () => {
  it('a needsInput result with modal-sized html normalizes to displayMode modal', () => {
    const result = {
      success: true,
      needsInput: { agentId: 'calendar-mutate-agent', prompt: 'Pick a slot' },
      html: '<div>slot picker</div>',
      panelWidth: 480,
      panelHeight: 420,
    };
    const n = normalizeAgentResult({ ...result, message: 'Pick a slot' });
    expect(n.displayMode).toBe('modal');
    expect(n.html).toBe('<div>slot picker</div>');
  });

  it('a needsInput result with a ui spec (no html) renders to html for the modal', () => {
    const result = {
      success: true,
      needsInput: { agentId: 'email-agent', prompt: 'Choose recipient' },
      ui: { type: 'confirm', title: 'Send to?', options: [{ label: 'Robb', value: 'robb' }] },
      panelWidth: 420,
      panelHeight: 300,
    };
    const n = normalizeAgentResult({ ...result, message: 'Choose recipient' });
    // The handler renders ui->html when normalize left html empty.
    const html = n.html || renderAgentUI(n.ui);
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(20);
    expect(n.displayMode).toBe('modal');
  });

  it('a plain spoken follow-up (no html/ui) does NOT become a modal', () => {
    const result = { success: true, needsInput: { agentId: 'a1', prompt: 'Which calendar?' } };
    const n = normalizeAgentResult({ ...result, message: 'Which calendar?' });
    expect(n.displayMode).not.toBe('modal');
    expect(n.html).toBeNull();
  });

  it('a small inline UI on a follow-up stays inline, not modal', () => {
    const result = {
      success: true,
      needsInput: { agentId: 'a1', prompt: 'ok?' },
      html: '<span>ok</span>',
      // no panel dims -> inline
    };
    const n = normalizeAgentResult({ ...result, message: 'ok?' });
    expect(n.displayMode).toBe('inline');
  });
});
