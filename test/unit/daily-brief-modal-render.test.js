/**
 * Daily-brief modal render — regression for "brief speaks but no visual modal".
 *
 * The daily-brief-agent returns a `ui` dayView SPEC (no `html`). Every visual
 * surface (agent-ui modal, command-hud panel) renders from `html`, and the
 * modal-spawn guard requires it — so the exchange must render ui→html in the
 * task:settled path. This pins the two facts that make that work:
 *   1. renderAgentUI knows how to render a dayView spec to non-empty html.
 *   2. That's exactly the branch the settled-path fix takes: no html + ui.type
 *      present  ->  render.
 */

import { describe, it, expect } from 'vitest';

const { renderAgentUI } = require('../../lib/agent-ui-renderer');
const { buildDayViewSpec } = require('../../lib/calendar-format');
const { normalizeAgentResult } = require('../../lib/agent-result-normalize');

const briefData = {
  timeline: [
    { title: 'Standup', start: '9:00 AM', status: 'upcoming' },
    { title: '1:1 with Marcus', start: '11:00 AM', status: 'upcoming' },
  ],
  conflicts: [],
  backToBack: [],
  longestFree: { durationMinutes: 120 },
};

describe('daily-brief dayView renders to html for the modal', () => {
  it('renderAgentUI turns a dayView spec into non-empty html', () => {
    const spec = buildDayViewSpec(briefData, 'A busy day.');
    expect(spec.type).toBe('dayView');
    const html = renderAgentUI(spec);
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(100);
  });

  it("agent's ui-only result is 'modal' but has no html until rendered (the bug shape)", () => {
    const spec = buildDayViewSpec(briefData, 'A busy day.');
    const agentResult = { success: true, ui: spec, displayMode: 'modal', panelWidth: 480, panelHeight: 600 };
    const normalized = normalizeAgentResult(agentResult);
    expect(normalized.displayMode).toBe('modal');
    expect(normalized.html).toBeNull(); // <- why the modal guard used to skip

    // The settled-path fix: no html + ui.type present -> render.
    expect(!normalized.html && normalized.ui && normalized.ui.type).toBeTruthy();
    const rendered = renderAgentUI(normalized.ui);
    expect(rendered.length).toBeGreaterThan(100);
  });
});
