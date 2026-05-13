/**
 * Spaces window persistence tests.
 *
 * Covers the pure helpers exported by `lite/spaces/window.ts` so the
 * Phase 0 "Window position survives restart" success criterion has
 * regression-guarded behavior without needing Electron's BrowserWindow
 * to instantiate in the test runner.
 *
 * The integration of these helpers into the BrowserWindow factory is
 * covered by the Electron E2E suite; this file pins the data-parsing
 * + display-clamping rules.
 */

import { describe, it, expect } from 'vitest';
import { parseBounds, clampToDisplay } from '../../spaces/window.js';

// ─── parseBounds ─────────────────────────────────────────────────────────

describe('parseBounds', () => {
  it('round-trips a complete bounds blob', () => {
    expect(
      parseBounds({ x: 100, y: 200, width: 1200, height: 800 })
    ).toEqual({ x: 100, y: 200, width: 1200, height: 800 });
  });

  it('accepts width/height alone (x/y omitted -> center on parent)', () => {
    expect(parseBounds({ width: 1200, height: 800 })).toEqual({
      width: 1200,
      height: 800,
    });
  });

  it('returns null for non-object inputs', () => {
    expect(parseBounds(null)).toBeNull();
    expect(parseBounds(undefined)).toBeNull();
    expect(parseBounds('1240x820')).toBeNull();
    expect(parseBounds(42)).toBeNull();
  });

  it('returns null when neither width nor height parses', () => {
    expect(parseBounds({})).toBeNull();
    expect(parseBounds({ x: 100, y: 100 })).toBeNull();
    expect(parseBounds({ width: 'huge' as unknown as number })).toBeNull();
  });

  it('drops fields below the minimum window size', () => {
    // MIN_WIDTH = 920, MIN_HEIGHT = 600.
    const got = parseBounds({ x: 0, y: 0, width: 400, height: 500 });
    // Width + height were too small to use, so both fall through; with
    // nothing usable, returns null.
    expect(got).toBeNull();
  });

  it('keeps width when only height is below minimum', () => {
    const got = parseBounds({ width: 1000, height: 200 });
    expect(got).toEqual({ width: 1000 });
  });

  it('drops non-finite numbers', () => {
    expect(
      parseBounds({ x: NaN, y: Infinity, width: 1200, height: 800 })
    ).toEqual({ width: 1200, height: 800 });
  });
});

// ─── clampToDisplay ──────────────────────────────────────────────────────

describe('clampToDisplay', () => {
  const oneDisplay = [
    { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
  ];

  it('returns the input bounds when they sit inside a display', () => {
    expect(
      clampToDisplay({ x: 100, y: 100, width: 1200, height: 800 }, oneDisplay)
    ).toEqual({ x: 100, y: 100, width: 1200, height: 800 });
  });

  it('snaps off-screen bounds back to the primary display origin', () => {
    const got = clampToDisplay(
      { x: 5000, y: 5000, width: 1200, height: 800 },
      oneDisplay
    );
    expect(got).toEqual({ x: 0, y: 0, width: 1200, height: 800 });
  });

  it('accepts partial overlap with a display as "on screen"', () => {
    // Window straddles the right edge but a few px are still visible.
    const got = clampToDisplay(
      { x: 1900, y: 200, width: 1200, height: 800 },
      oneDisplay
    );
    expect(got.x).toBe(1900);
    expect(got.y).toBe(200);
  });

  it('clamps width/height to MIN_WIDTH / MIN_HEIGHT (920 / 600)', () => {
    const got = clampToDisplay(
      { x: 0, y: 0, width: 200, height: 200 },
      oneDisplay
    );
    expect(got.width).toBe(920);
    expect(got.height).toBe(600);
  });

  it('returns x=0/y=0 when bounds.x and bounds.y are omitted', () => {
    const got = clampToDisplay({ width: 1200, height: 800 }, oneDisplay);
    expect(got).toEqual({ x: 0, y: 0, width: 1200, height: 800 });
  });

  it('keeps coords intact when no displays are available (test/CI safety net)', () => {
    const got = clampToDisplay({ x: 50, y: 60, width: 1200, height: 800 }, []);
    expect(got).toEqual({ x: 50, y: 60, width: 1200, height: 800 });
  });

  it('picks the primary display when the saved position lives on a vanished second monitor', () => {
    const displays = [
      { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
      // No second monitor any more.
    ];
    const got = clampToDisplay(
      { x: 2500, y: 0, width: 1200, height: 800 },
      displays
    );
    expect(got).toEqual({ x: 0, y: 0, width: 1200, height: 800 });
  });

  it('keeps the saved position when it lives on a still-attached second monitor', () => {
    const displays = [
      { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
      { bounds: { x: 1920, y: 0, width: 2560, height: 1440 } },
    ];
    const got = clampToDisplay(
      { x: 3000, y: 200, width: 1200, height: 800 },
      displays
    );
    expect(got).toEqual({ x: 3000, y: 200, width: 1200, height: 800 });
  });
});
