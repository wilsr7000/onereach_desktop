/**
 * Daily Brief -- HUD fit contract
 *
 * Locks down the result contract that lets the rich daily-brief dayView
 * actually fit in the Command HUD:
 *
 *   - For a dayView ui spec, the agent's `computePanelHeight()` MUST
 *     return ≥ 540 (so the fixed cards always have room).
 *   - It MUST grow with event count so a busy day doesn't hide events
 *     behind an inner scrollbar.
 *   - It MUST NOT exceed the HUD's hard ceiling (900) so the HUD's own
 *     resizeWindow can never request more than the screen.
 *   - The result of `execute()` (when a dayView ui is produced) carries
 *     `panelWidth` and `panelHeight`, otherwise the HUD has nothing to
 *     resize against.
 *
 * If any of these break, the dayView starts getting clipped in the HUD
 * again -- which is exactly the regression this test exists to catch.
 */

import { describe, it, expect } from 'vitest';

const dailyBrief = require('../../packages/agents/daily-brief-agent');

describe('daily-brief computePanelHeight (dayView -> HUD size)', () => {
  it('returns at least 540px even with zero events (fixed cards still need room)', () => {
    const h = dailyBrief.computePanelHeight({ type: 'dayView', events: [] });
    expect(h).toBeGreaterThanOrEqual(540);
  });

  it('returns at least 540px when ui has no events array at all', () => {
    expect(dailyBrief.computePanelHeight({ type: 'dayView' })).toBeGreaterThanOrEqual(540);
    expect(dailyBrief.computePanelHeight(null)).toBeGreaterThanOrEqual(540);
  });

  it('grows with the number of timeline events', () => {
    const small = dailyBrief.computePanelHeight({
      type: 'dayView',
      events: [{ title: 'a' }, { title: 'b' }],
    });
    const big = dailyBrief.computePanelHeight({
      type: 'dayView',
      events: Array.from({ length: 5 }, (_, i) => ({ title: `e${i}` })),
    });
    expect(big).toBeGreaterThan(small);
  });

  it('caps at 900px no matter how busy the day is (HUD ceiling)', () => {
    const huge = dailyBrief.computePanelHeight({
      type: 'dayView',
      events: Array.from({ length: 30 }, (_, i) => ({ title: `e${i}` })),
    });
    expect(huge).toBeLessThanOrEqual(900);
  });
});

describe('daily-brief result contract (dayView path includes panelWidth + panelHeight)', () => {
  // We don't run execute() here -- it has many side-effects (memory,
  // multi-agent contributors, AI calls). Instead we verify that the
  // file's shipped formula plus the agent's helper produce a result
  // shape consistent with the HUD's expectations.
  it('panelWidth/panelHeight are wired into the dayView return path', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../packages/agents/daily-brief-agent.js'),
      'utf8'
    );
    // The relevant block:
    //   const isDayView = ui?.type === 'dayView';
    //   const panelHeight = isDayView ? this.computePanelHeight(ui) : undefined;
    //   return { ..., panelWidth: isDayView ? 480 : undefined, panelHeight, ... }
    expect(src).toMatch(/panelWidth:\s*isDayView\s*\?\s*480\s*:\s*undefined/);
    expect(src).toMatch(/panelHeight,/);
    expect(src).toMatch(/this\.computePanelHeight\(ui\)/);
  });
});
