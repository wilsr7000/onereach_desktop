/**
 * The main window opens at a size that suits the display (2026-09-06,
 * user: "make the main window a bit larger"): 80% × 85% of the work
 * area, never below the old fixed 1280×800, capped at 1680×1050, and
 * the display itself (minus a margin) when the display is smaller than
 * the old default.
 */

import { describe, it, expect } from 'vitest';
import { initialMainWindowSize } from '../../main-window/window.js';

describe('initialMainWindowSize', () => {
  it('a 16-inch laptop work area gets a window larger than the old default', () => {
    expect(initialMainWindowSize({ width: 1728, height: 1080 })).toEqual({ width: 1382, height: 918 });
  });

  it('a 6K display is capped so the window stays a window', () => {
    expect(initialMainWindowSize({ width: 3008, height: 1660 })).toEqual({ width: 1680, height: 1050 });
  });

  it('a display near the old default keeps at least the old default', () => {
    expect(initialMainWindowSize({ width: 1440, height: 900 })).toEqual({ width: 1280, height: 800 });
  });

  it('a display smaller than the old default gets the display minus a margin', () => {
    expect(initialMainWindowSize({ width: 1024, height: 700 })).toEqual({ width: 984, height: 660 });
  });

  it('an unknown work area falls back to the fixed default', () => {
    expect(initialMainWindowSize(null)).toEqual({ width: 1280, height: 800 });
    expect(initialMainWindowSize({ width: 0, height: 0 })).toEqual({ width: 1280, height: 800 });
  });
});
