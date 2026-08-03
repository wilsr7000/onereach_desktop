/**
 * surface-policy -- rich results must land on a surface the user can see
 *
 * Regression for the 2026-08 "no visual window opened": a degraded daily
 * brief (dayView failed -> fallback ui, no explicit mode/sizes) derived
 * displayMode 'inline' and rendered only into the closed orb chat while the
 * TTS claimed "brief on screen". The policy escalates derived-inline html on
 * a voice turn to a modal window with default sizing.
 */

import { describe, it, expect } from 'vitest';

const { resolveSurface, DEFAULT_PANEL_WIDTH, DEFAULT_PANEL_HEIGHT } = require('../../lib/surface-policy.js');

describe('surface-policy.resolveSurface()', () => {
  it('escalates derived-inline + html + voice-in to a modal with default sizes (the daily-brief bug)', () => {
    const out = resolveSurface({
      explicitDisplayMode: null, // agent degraded: no explicit mode
      displayMode: 'inline', // heuristic derived
      hasHtml: true,
      inputModality: 'voice',
      panelWidth: null,
      panelHeight: null,
    });
    expect(out.mode).toBe('modal');
    expect(out.escalated).toBe(true);
    expect(out.panelWidth).toBe(DEFAULT_PANEL_WIDTH);
    expect(out.panelHeight).toBe(DEFAULT_PANEL_HEIGHT);
  });

  it('keeps agent-supplied sizes when escalating', () => {
    const out = resolveSurface({
      explicitDisplayMode: null,
      displayMode: 'inline',
      hasHtml: true,
      inputModality: 'voice',
      panelWidth: 720,
      panelHeight: null,
    });
    expect(out.escalated).toBe(true);
    expect(out.panelWidth).toBe(720);
    expect(out.panelHeight).toBe(DEFAULT_PANEL_HEIGHT);
  });

  it('honors an EXPLICIT inline from the agent (small ack card by design)', () => {
    const out = resolveSurface({
      explicitDisplayMode: 'inline',
      displayMode: 'inline',
      hasHtml: true,
      inputModality: 'voice',
    });
    expect(out.mode).toBe('inline');
    expect(out.escalated).toBe(false);
  });

  it('does not escalate text-in tasks (user is already looking at chat)', () => {
    const out = resolveSurface({
      explicitDisplayMode: null,
      displayMode: 'inline',
      hasHtml: true,
      inputModality: 'text',
    });
    expect(out.mode).toBe('inline');
    expect(out.escalated).toBe(false);
  });

  it('does not touch inline results without html (nothing to show)', () => {
    const out = resolveSurface({
      explicitDisplayMode: null,
      displayMode: 'inline',
      hasHtml: false,
      inputModality: 'voice',
    });
    expect(out.mode).toBe('inline');
    expect(out.escalated).toBe(false);
  });

  it('passes derived modal through untouched', () => {
    const out = resolveSurface({
      explicitDisplayMode: null,
      displayMode: 'modal',
      hasHtml: true,
      inputModality: 'voice',
      panelWidth: 480,
      panelHeight: 540,
    });
    expect(out.mode).toBe('modal');
    expect(out.escalated).toBe(false);
    expect(out.panelWidth).toBe(480);
  });

  it('treats missing inputModality as voice (legacy default, matches the bridge)', () => {
    const out = resolveSurface({ explicitDisplayMode: null, displayMode: 'inline', hasHtml: true });
    expect(out.mode).toBe('modal');
    expect(out.escalated).toBe(true);
  });

  it('is safe on empty input', () => {
    expect(() => resolveSurface()).not.toThrow();
    expect(resolveSurface().mode).toBeNull();
  });
});
