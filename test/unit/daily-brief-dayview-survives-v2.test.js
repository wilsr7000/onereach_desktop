/**
 * Daily Brief dayView UI -- survives the Agent System v2 pipeline
 *
 * Regression guard: ensure the rich dayView UI spec produced by
 * daily-brief-agent via `buildDayViewSpec` still renders to HTML via
 * the shared agent-ui-renderer AFTER Agent System v2 landed.
 *
 * Tests exercised:
 *   - buildDayViewSpec returns a { type: 'dayView', ... } spec.
 *   - renderAgentUI handles type === 'dayView' and produces HTML with
 *     the signature visual elements (timeline, insight cards, smart
 *     actions, focus window, right-now block).
 *   - The agent-middleware converts result.ui -> result.html using the
 *     same renderer so the command-HUD gets a ready-to-inject HTML
 *     string.
 */

import { describe, it, expect } from 'vitest';

const { buildDayViewSpec } = require('../../lib/calendar-format');
const { renderAgentUI } = require('../../lib/agent-ui-renderer');

function _mkBriefData() {
  // buildDayViewSpec reads `timeline` (from generateMorningBrief);
  // insightCards / actions / focusWindow are derived internally.
  return {
    date: '2026-04-20',
    currentTimeFormatted: '9:15 AM',
    timeline: [
      {
        start: '9:30 AM',
        end: '10:00 AM',
        title: 'Standup',
        location: 'Zoom',
        status: 'upcoming',
        guests: [{ name: 'Alice' }, { name: 'Bob' }],
      },
      {
        start: '10:00 AM',
        end: '11:00 AM',
        title: 'Deep work',
        status: 'upcoming',
        guests: [],
      },
    ],
  };
}

const BRIEFING_TEXT = 'Good morning. Here is your day.\n\nYou have two meetings this morning.';

describe('daily-brief dayView rendering survives v2', () => {
  it('buildDayViewSpec returns a spec with type === dayView', () => {
    const spec = buildDayViewSpec(_mkBriefData(), BRIEFING_TEXT);
    expect(spec).toBeTruthy();
    expect(spec.type).toBe('dayView');
    // Must carry the fields the renderer reads:
    expect(spec.now).toBeTruthy();
    expect(Array.isArray(spec.events)).toBe(true);
    expect(Array.isArray(spec.insightCards)).toBe(true);
    expect(Array.isArray(spec.briefing)).toBe(true);
    expect(Array.isArray(spec.actions)).toBe(true);
  });

  it('renderAgentUI handles the dayView spec and produces HTML', () => {
    const spec = buildDayViewSpec(_mkBriefData(), BRIEFING_TEXT);
    const html = renderAgentUI(spec);
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(500);

    // Signature visual elements -- if these disappear the "awesome UI
    // for showing graphics" is gone.
    expect(html).toContain('AI Day View');
    expect(html).toContain('Timeline');
    expect(html).toContain('Right now');
    expect(html).toContain('Good morning');             // briefing paragraph
    expect(html).toContain('two meetings');
    expect(html).toContain('Standup');                   // event title
    expect(html).toContain('Deep work');                 // event title
  });

  it('agent-middleware normalizeResult converts result.ui to result.html', () => {
    const { normalizeResult } = require('../../packages/agents/agent-middleware');
    const spec = buildDayViewSpec(_mkBriefData(), BRIEFING_TEXT);
    const processed = normalizeResult({
      success: true,
      message: 'Here is your day',
      ui: spec,
    });
    expect(typeof processed.html).toBe('string');
    expect(processed.html).toContain('AI Day View');
    expect(processed.html).toContain('Timeline');
  });
});
