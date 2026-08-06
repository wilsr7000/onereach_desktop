/**
 * "The Spaces window opens, then disappears."
 *
 * Reported as a crash. It wasn't one — the window was alive the whole
 * time, at (2151, -21) on a second display. Two defects stacked:
 *
 *   1. The window was shown on `ready-to-show`, BEFORE the saved bounds
 *      arrived from KV. When those bounds pointed at another monitor,
 *      the window appeared on the screen you were looking at and then
 *      teleported away. The old code called this "a minor re-flow".
 *
 *   2. `clampToDisplay` only required a window to OVERLAP a display, so
 *      a negative y sailed through — putting the title bar above the
 *      screen top, behind the macOS menu bar, where it can't be grabbed.
 *
 * The numbers in these tests are the real ones read off the running app.
 */

import { describe, it, expect } from 'vitest';
import { clampToDisplay } from '../../spaces/window.js';

/** The user's actual layout: built-in laptop display + one to the right. */
const TWO_DISPLAYS = [
  { bounds: { x: 0, y: 0, width: 1728, height: 1117 } },
  { bounds: { x: 1728, y: 0, width: 3008, height: 1692 } },
];

describe('clampToDisplay — title bar must stay grabbable', () => {
  it('pulls a negative-y window down onto its display (the observed bug)', () => {
    // Exactly what was restored in the field.
    const got = clampToDisplay({ x: 2151, y: -21, width: 1240, height: 801 }, TWO_DISPLAYS);
    expect(got.y, 'a title bar above the screen top cannot be grabbed').toBe(0);
    // The x is legitimate — the window really is on the second display,
    // and we must not yank it back to the primary.
    expect(got.x).toBe(2151);
    expect(got.width).toBe(1240);
    expect(got.height).toBe(801);
  });

  it('clamps to the HOST display top, not the primary', () => {
    const stacked = [
      { bounds: { x: 0, y: 0, width: 1728, height: 1117 } },
      // A display mounted above the primary has a negative origin.
      { bounds: { x: 0, y: -900, width: 1600, height: 900 } },
    ];
    // Sits on the upper display; -880 is legitimately on-screen there.
    const got = clampToDisplay({ x: 100, y: -880, width: 800, height: 600 }, stacked);
    expect(got.y, 'must not be dragged to the primary top').toBe(-880);
  });

  it('leaves a well-placed window untouched', () => {
    const got = clampToDisplay({ x: 200, y: 150, width: 1200, height: 800 }, TWO_DISPLAYS);
    expect(got).toEqual({ x: 200, y: 150, width: 1200, height: 800 });
  });

  it('still rescues a window on a display that is no longer attached', () => {
    // Second monitor unplugged; the saved x is now nowhere.
    const got = clampToDisplay({ x: 2151, y: -21, width: 1240, height: 801 }, [
      { bounds: { x: 0, y: 0, width: 1728, height: 1117 } },
    ]);
    expect(got.x).toBe(0);
    expect(got.y).toBe(0);
  });

  it('never pushes a window UP — only down onto the display', () => {
    const got = clampToDisplay({ x: 10, y: 900, width: 400, height: 300 }, TWO_DISPLAYS);
    expect(got.y).toBe(900);
  });
});
