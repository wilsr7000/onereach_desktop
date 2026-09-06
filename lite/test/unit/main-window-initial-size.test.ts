/**
 * The main window opens at a size that suits the display (2026-09-06,
 * user: "make the main window a bit larger"): 80% × 85% of the work
 * area, never below 1360×850 (the old fixed size was 1280×800, and 80%
 * of a 14-inch laptop's work area IS 1280 — the floor is what makes the
 * change visible there), capped at 1680×1050, and the display minus a
 * 40 px margin when the display is too small for the target.
 */

import { describe, it, expect } from 'vitest';
import { initialMainWindowSize } from '../../main-window/window.js';

describe('initialMainWindowSize', () => {
  it('a 16-inch laptop work area gets the fraction (larger than the floor)', () => {
    expect(initialMainWindowSize({ width: 1728, height: 1083 })).toEqual({ width: 1382, height: 921 });
  });

  it('a 14-inch laptop and a 1440×900 display get the floor — visibly more than the old 1280×800', () => {
    expect(initialMainWindowSize({ width: 1512, height: 944 })).toEqual({ width: 1360, height: 850 });
    expect(initialMainWindowSize({ width: 1440, height: 900 })).toEqual({ width: 1360, height: 850 });
  });

  it('a 6K display is capped so the window stays a window', () => {
    expect(initialMainWindowSize({ width: 3008, height: 1660 })).toEqual({ width: 1680, height: 1050 });
  });

  it('a display too small for the target keeps a 40 px margin', () => {
    expect(initialMainWindowSize({ width: 1280, height: 720 })).toEqual({ width: 1240, height: 680 });
    expect(initialMainWindowSize({ width: 1024, height: 700 })).toEqual({ width: 984, height: 660 });
  });

  it('never goes below the window minimum, and every result is an integer', () => {
    const tiny = initialMainWindowSize({ width: 700, height: 500 });
    expect(tiny).toEqual({ width: 720, height: 480 });
    for (const area of [{ width: 1512, height: 944 }, { width: 1366, height: 728 }, { width: 2560, height: 1440 }]) {
      const r = initialMainWindowSize(area);
      expect(Number.isInteger(r.width) && Number.isInteger(r.height)).toBe(true);
    }
  });

  it('an unknown work area falls back to the fixed default', () => {
    expect(initialMainWindowSize(null)).toEqual({ width: 1280, height: 800 });
    expect(initialMainWindowSize({ width: 0, height: 0 })).toEqual({ width: 1280, height: 800 });
  });
});
