/**
 * Window rescue — the durable guard for the "window is visible but you
 * can't grab or close it" class of bug.
 *
 * Three of these shipped on 2026-08-06/07, all from restoring saved
 * coordinates that pass a naive on-screen check:
 *   - y = -21  → title bar above the top of the screen
 *   - y = 3    → title bar behind the macOS menu bar
 *   - late KV bounds moving an already-shown window to another display
 *
 * The numbers below are the real ones observed on the user's machine.
 */

import { describe, it, expect } from 'vitest';
import {
  isWindowReachable,
  rescueBounds,
  MIN_GRABBABLE_PX,
  type RescueDisplay,
} from '../../window-rescue.js';

/** The user's actual primary display: menu bar occupies the top 37px. */
const MAC: RescueDisplay[] = [
  {
    bounds: { x: 0, y: 0, width: 1728, height: 1117 },
    workArea: { x: 0, y: 37, width: 1728, height: 1080 },
  },
];

/** Laptop + a second monitor to the right. */
const TWO: RescueDisplay[] = [
  ...MAC,
  {
    bounds: { x: 1728, y: 0, width: 3008, height: 1692 },
    workArea: { x: 1728, y: 37, width: 3008, height: 1655 },
  },
];

describe('isWindowReachable', () => {
  it('rejects the observed menu-bar overlap (y=3)', () => {
    expect(isWindowReachable({ x: 423, y: 3, width: 1124, height: 692 }, MAC)).toBe(false);
  });

  it('rejects the observed off-screen-top case (y=-21)', () => {
    expect(isWindowReachable({ x: 2151, y: -21, width: 1240, height: 801 }, MAC)).toBe(false);
  });

  it('rejects a window dragged below the visible band', () => {
    expect(isWindowReachable({ x: 100, y: 1200, width: 800, height: 600 }, MAC)).toBe(false);
  });

  it('rejects a window pushed off the right edge', () => {
    expect(isWindowReachable({ x: 1720, y: 100, width: 800, height: 600 }, MAC)).toBe(false);
  });

  it('accepts a normally-placed window', () => {
    expect(isWindowReachable({ x: 200, y: 150, width: 1200, height: 800 }, MAC)).toBe(true);
  });

  it('accepts a window sitting exactly on the first usable row', () => {
    expect(isWindowReachable({ x: 0, y: 37, width: 800, height: 600 }, MAC)).toBe(true);
  });

  it('accepts a window on a second display', () => {
    expect(isWindowReachable({ x: 2000, y: 200, width: 1000, height: 700 }, TWO)).toBe(true);
  });

  it('is permissive when no displays are known (never fights a headless env)', () => {
    expect(isWindowReachable({ x: -9999, y: -9999, width: 10, height: 10 }, [])).toBe(true);
  });
});

describe('rescueBounds', () => {
  it('pulls the menu-bar case down to the first usable row, keeping size + x', () => {
    const got = rescueBounds({ x: 423, y: 3, width: 1124, height: 692 }, MAC);
    expect(got).toEqual({ x: 423, y: 37, width: 1124, height: 692 });
  });

  it('rescues an off-screen window onto a real display', () => {
    const got = rescueBounds({ x: 2151, y: -21, width: 1240, height: 801 }, MAC);
    expect(isWindowReachable(got, MAC)).toBe(true);
    expect(got.width).toBeLessThanOrEqual(1728);
  });

  it('leaves a well-placed window EXACTLY as it was', () => {
    const placed = { x: 200, y: 150, width: 1200, height: 800 };
    expect(rescueBounds(placed, MAC)).toEqual(placed);
  });

  it('keeps a window on the second display it legitimately lives on', () => {
    const onSecond = { x: 2000, y: 200, width: 1000, height: 700 };
    expect(rescueBounds(onSecond, TWO)).toEqual(onSecond);
  });

  it('always produces reachable bounds for any junk input', () => {
    const junk = [
      { x: -5000, y: -5000, width: 400, height: 300 },
      { x: 99999, y: 99999, width: 400, height: 300 },
      { x: 0, y: -1, width: 2000, height: 2000 },
      { x: 1727, y: 36, width: 1200, height: 900 },
    ];
    for (const bounds of junk) {
      const got = rescueBounds(bounds, MAC);
      expect(isWindowReachable(got, MAC), `failed for ${JSON.stringify(bounds)}`).toBe(true);
      expect(got.y).toBeGreaterThanOrEqual(37);
    }
  });

  it('falls back to display bounds when a display reports no workArea', () => {
    const noWorkArea: RescueDisplay[] = [
      { bounds: { x: 0, y: 0, width: 1728, height: 1117 } },
    ];
    const got = rescueBounds({ x: 100, y: -21, width: 800, height: 600 }, noWorkArea);
    expect(got.y).toBe(0);
  });

  it('is a no-op when no displays are known', () => {
    const bounds = { x: 1, y: 2, width: 3, height: 4 };
    expect(rescueBounds(bounds, [])).toEqual(bounds);
  });

  it('requires a real grab target, not a 1px sliver', () => {
    expect(MIN_GRABBABLE_PX).toBeGreaterThanOrEqual(28);
  });
});
