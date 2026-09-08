/**
 * The main window opens at a size that suits the display (2026-09-06,
 * user: "make the main window a bit larger", then "make the main window
 * open larger"): 90% of the work area in each direction, never below
 * 1360×850 (the old fixed size was 1280×800), capped at 2200×1350, and
 * the display minus a 40 px margin when the display is too small for
 * the target.
 */

import { describe, it, expect } from 'vitest';
import { initialMainWindowSize } from '../../main-window/window.js';

describe('initialMainWindowSize', () => {
  it('a 16-inch laptop work area gets 90% of it', () => {
    expect(initialMainWindowSize({ width: 1728, height: 1083 })).toEqual({ width: 1555, height: 975 });
  });

  it('a 14-inch laptop and a 1440×900 display get at least the floor — visibly more than the old 1280×800', () => {
    expect(initialMainWindowSize({ width: 1512, height: 944 })).toEqual({ width: 1361, height: 850 });
    expect(initialMainWindowSize({ width: 1440, height: 900 })).toEqual({ width: 1360, height: 850 });
  });

  it('a 6K display is capped so the window stays a window; a 5K takes 90%', () => {
    expect(initialMainWindowSize({ width: 3008, height: 1660 })).toEqual({ width: 2200, height: 1350 });
    expect(initialMainWindowSize({ width: 2560, height: 1415 })).toEqual({ width: 2200, height: 1274 });
  });

  it('a display too small for the target keeps a 40 px margin', () => {
    expect(initialMainWindowSize({ width: 1280, height: 720 })).toEqual({ width: 1240, height: 680 });
    expect(initialMainWindowSize({ width: 1024, height: 700 })).toEqual({ width: 984, height: 660 });
  });

  it('never goes below the window minimum, and every result is an integer', () => {
    expect(initialMainWindowSize({ width: 700, height: 500 })).toEqual({ width: 720, height: 480 });
    for (const area of [{ width: 1512, height: 944 }, { width: 1366, height: 728 }, { width: 2560, height: 1440 }]) {
      const r = initialMainWindowSize(area);
      expect(Number.isInteger(r.width) && Number.isInteger(r.height)).toBe(true);
      expect(r.width).toBeLessThanOrEqual(area.width);
      expect(r.height).toBeLessThanOrEqual(area.height);
    }
  });

  it('an unknown work area falls back to the fixed default', () => {
    expect(initialMainWindowSize(null)).toEqual({ width: 1280, height: 800 });
    expect(initialMainWindowSize({ width: 0, height: 0 })).toEqual({ width: 1280, height: 800 });
  });
});
