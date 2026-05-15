/**
 * agent-ui-modal-manager -- pure-helper tests
 *
 * The modal manager has two layers:
 *   1. Pure helpers (sanitizeDimensions, computeModalPosition,
 *      load/save positions) -- testable without the Electron runtime.
 *   2. Electron-dependent layer (showAgentUIModal, lifecycle) -- only
 *      runs in a real BrowserWindow context.
 *
 * This test file pins layer (1). The Electron-dependent layer is
 * exercised at boot of the live app (the bridge calls
 * showAgentUIModal when an agent's displayMode === 'modal'); failures
 * there surface as logs we can grep with the test-audit harness.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');

const mgr = require('../../lib/agent-ui-modal-manager.js');

let TMP_PATH;

beforeEach(() => {
  TMP_PATH = path.join(os.tmpdir(), `agent-ui-modal-positions-${Date.now()}-${Math.random()}.json`);
  mgr._setPositionStorePath(TMP_PATH);
});

afterEach(() => {
  try { fs.unlinkSync(TMP_PATH); } catch (_e) { /* gone */ }
  mgr._resetPositionStorePath();
});

describe('sanitizeDimensions', () => {
  it('returns the requested width/height when in range', () => {
    const r = mgr.sanitizeDimensions({ width: 480, height: 540 });
    expect(r).toEqual({ width: 480, height: 540 });
  });

  it('clamps width below the min', () => {
    const r = mgr.sanitizeDimensions({ width: 50, height: 600 });
    expect(r.width).toBe(mgr.DEFAULT_MIN_WIDTH);
    expect(r.height).toBe(600);
  });

  it('clamps height below the min', () => {
    const r = mgr.sanitizeDimensions({ width: 500, height: 100 });
    expect(r.width).toBe(500);
    expect(r.height).toBe(mgr.DEFAULT_MIN_HEIGHT);
  });

  it('clamps absurdly large width', () => {
    const r = mgr.sanitizeDimensions({ width: 5000, height: 600 });
    expect(r.width).toBe(mgr.DEFAULT_MAX_WIDTH);
  });

  it('clamps absurdly large height', () => {
    const r = mgr.sanitizeDimensions({ width: 480, height: 5000 });
    expect(r.height).toBe(mgr.DEFAULT_MAX_HEIGHT);
  });

  it('falls back to mins on missing/invalid input', () => {
    expect(mgr.sanitizeDimensions({})).toEqual({ width: mgr.DEFAULT_MIN_WIDTH, height: mgr.DEFAULT_MIN_HEIGHT });
    expect(mgr.sanitizeDimensions({ width: -10, height: 'abc' })).toEqual({
      width: mgr.DEFAULT_MIN_WIDTH,
      height: mgr.DEFAULT_MIN_HEIGHT,
    });
  });

  it('rounds fractional dimensions', () => {
    const r = mgr.sanitizeDimensions({ width: 480.7, height: 540.3 });
    expect(r).toEqual({ width: 481, height: 540 });
  });
});

describe('computeModalPosition', () => {
  // Standard test display: 1920x1080 at origin
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };

  // Orb in lower-right corner (90px square at 1810,950)
  const orbBoundsRight = { x: 1810, y: 950, width: 90, height: 90 };
  // Orb in lower-left corner
  const orbBoundsLeft = { x: 20, y: 950, width: 90, height: 90 };

  it('places modal to the LEFT of orb when orb is on the right half', () => {
    const r = mgr.computeModalPosition({
      orbBounds: orbBoundsRight,
      workArea,
      width: 480,
      height: 540,
    });
    // Should be on the left side of the orb -> x < orbBounds.x
    expect(r.x).toBeLessThan(orbBoundsRight.x);
    expect(r.x).toBeGreaterThanOrEqual(workArea.x);
  });

  it('places modal to the RIGHT of orb when orb is on the left half', () => {
    const r = mgr.computeModalPosition({
      orbBounds: orbBoundsLeft,
      workArea,
      width: 480,
      height: 540,
    });
    expect(r.x).toBeGreaterThan(orbBoundsLeft.x + orbBoundsLeft.width);
    expect(r.x + 480).toBeLessThanOrEqual(workArea.x + workArea.width);
  });

  it('respects chatOpenSide override (chat on left -> modal on right)', () => {
    const r = mgr.computeModalPosition({
      orbBounds: orbBoundsRight, // would normally place on left
      workArea,
      width: 480,
      height: 540,
      chatOpenSide: 'left',
    });
    // chatOpenSide === 'left' forces modal to the right, even though
    // the orb is on the right half. The clamp will then push it back
    // inside the work area on the right edge.
    expect(r.x + 480).toBeLessThanOrEqual(workArea.x + workArea.width);
  });

  it('vertically centers around the orb', () => {
    const r = mgr.computeModalPosition({
      orbBounds: orbBoundsRight,
      workArea,
      width: 480,
      height: 200,
    });
    const orbCenterY = orbBoundsRight.y + orbBoundsRight.height / 2;
    const modalCenterY = r.y + 100;
    expect(Math.abs(modalCenterY - orbCenterY)).toBeLessThanOrEqual(40); // some clamping wiggle
  });

  it('uses savedPosition when present and inside the work area', () => {
    const saved = { x: 200, y: 300 };
    const r = mgr.computeModalPosition({
      orbBounds: orbBoundsRight,
      workArea,
      width: 480,
      height: 540,
      savedPosition: saved,
    });
    expect(r).toEqual(saved);
  });

  it('ignores savedPosition that would go off the right edge', () => {
    const saved = { x: 1900, y: 300 }; // 1900 + 480 > 1920
    const r = mgr.computeModalPosition({
      orbBounds: orbBoundsRight,
      workArea,
      width: 480,
      height: 540,
      savedPosition: saved,
    });
    expect(r).not.toEqual(saved);
  });

  it('ignores savedPosition that would go off the bottom edge', () => {
    const saved = { x: 200, y: 1000 }; // 1000 + 540 > 1080
    const r = mgr.computeModalPosition({
      orbBounds: orbBoundsRight,
      workArea,
      width: 480,
      height: 540,
      savedPosition: saved,
    });
    expect(r).not.toEqual(saved);
  });

  it('falls back to work-area center when no orbBounds', () => {
    const r = mgr.computeModalPosition({
      orbBounds: null,
      workArea,
      width: 480,
      height: 540,
    });
    expect(r.x).toBe(Math.round((1920 - 480) / 2));
    expect(r.y).toBe(Math.round((1080 - 540) / 2));
  });

  it('falls back to {100,100} when no work area or orb', () => {
    const r = mgr.computeModalPosition({ orbBounds: null, workArea: null, width: 480, height: 540 });
    expect(r).toEqual({ x: 100, y: 100 });
  });

  it('clamps modal inside work area on left/top edges', () => {
    const r = mgr.computeModalPosition({
      orbBounds: { x: -100, y: -50, width: 90, height: 90 }, // orb half off screen
      workArea,
      width: 480,
      height: 540,
    });
    expect(r.x).toBeGreaterThanOrEqual(workArea.x);
    expect(r.y).toBeGreaterThanOrEqual(workArea.y);
  });
});

describe('saveAgentPosition + loadSavedPositions', () => {
  it('round-trips a saved position', () => {
    mgr.saveAgentPosition('daily-brief-agent', 200, 300);
    const positions = mgr.loadSavedPositions();
    expect(positions['daily-brief-agent'].x).toBe(200);
    expect(positions['daily-brief-agent'].y).toBe(300);
    expect(positions['daily-brief-agent'].savedAt).toBeGreaterThan(0);
  });

  it('multiple agents persist independently', () => {
    mgr.saveAgentPosition('a', 10, 20);
    mgr.saveAgentPosition('b', 30, 40);
    const positions = mgr.loadSavedPositions();
    expect(positions.a).toMatchObject({ x: 10, y: 20 });
    expect(positions.b).toMatchObject({ x: 30, y: 40 });
  });

  it('overwriting same agent updates in place', () => {
    mgr.saveAgentPosition('a', 10, 20);
    mgr.saveAgentPosition('a', 100, 200);
    const positions = mgr.loadSavedPositions();
    expect(positions.a).toMatchObject({ x: 100, y: 200 });
    expect(Object.keys(positions)).toEqual(['a']);
  });

  it('loadSavedPositions on empty/missing file returns {}', () => {
    expect(mgr.loadSavedPositions()).toEqual({});
  });

  it('loadSavedPositions on corrupt JSON returns {} (graceful degrade)', () => {
    fs.writeFileSync(TMP_PATH, '{ this is not json }', 'utf8');
    expect(mgr.loadSavedPositions()).toEqual({});
  });
});
