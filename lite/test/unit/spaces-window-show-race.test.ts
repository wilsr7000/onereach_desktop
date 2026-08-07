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

  it('pushes a window out from under the macOS menu bar (observed at y=3)', () => {
    // The window was found stuck at y=3: `bounds.y` is 0 on the primary
    // display and INCLUDES the menu bar, so y=3 passed the old clamp
    // while the title bar sat behind the menu bar — no grab handle, no
    // reachable close button. workArea.y is the first usable row.
    const withMenuBar = [
      { bounds: { x: 0, y: 0, width: 1728, height: 1117 },
        workArea: { x: 0, y: 37, width: 1728, height: 1080 } },
    ];
    const got = clampToDisplay({ x: 423, y: 3, width: 1124, height: 692 }, withMenuBar);
    expect(got.y, 'title bar must clear the menu bar').toBe(37);
    expect(got.x).toBe(423);
  });

  it('still clamps correctly when a display reports no workArea', () => {
    const noWorkArea = [{ bounds: { x: 0, y: 0, width: 1728, height: 1117 } }];
    const got = clampToDisplay({ x: 100, y: -21, width: 800, height: 600 }, noWorkArea);
    expect(got.y).toBe(0);
  });

  it('leaves a window below the menu bar untouched', () => {
    const withMenuBar = [
      { bounds: { x: 0, y: 0, width: 1728, height: 1117 },
        workArea: { x: 0, y: 37, width: 1728, height: 1080 } },
    ];
    const got = clampToDisplay({ x: 200, y: 150, width: 1200, height: 800 }, withMenuBar);
    expect(got.y).toBe(150);
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

/**
 * Defect 1's remaining hole, found in the 2026-08-06 review: the
 * watchdog centers + SHOWS the window after 1200ms, but the bounds
 * loader's `.then` still applied `setBounds` whenever it eventually
 * resolved — so a slow KV read teleported the now-visible window to
 * another display. Late bounds must lose to an already-positioned
 * window. Asserted at source level: the guard is one early return
 * inside a promise chain wired to Electron's window lifecycle, which
 * a unit test cannot instantiate.
 */
describe('late bounds must not move an already-shown window', () => {
  it('the loader bails out when the watchdog already positioned it', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const candidates = [
      path.resolve('spaces/window.ts'),
      path.resolve('lite/spaces/window.ts'),
    ];
    const found = candidates.find((p) => fs.existsSync(p));
    expect(found, `window.ts not found: ${candidates.join(', ')}`).toBeDefined();
    const src = fs.readFileSync(found as string, 'utf8');

    const start = src.indexOf('loader()');
    expect(start, 'loader() chain not found — renamed?').toBeGreaterThan(-1);
    const chain = src.slice(start, start + 900);
    // The guard must sit BEFORE the setBounds call in the same chain.
    const guardAt = chain.indexOf('if (positioned) return;');
    const setBoundsAt = chain.indexOf('win.setBounds(safeBounds)');
    expect(guardAt, 'late-bounds guard missing from the loader chain').toBeGreaterThan(-1);
    expect(setBoundsAt).toBeGreaterThan(-1);
    expect(
      guardAt < setBoundsAt,
      'the positioned-guard must precede setBounds, or the window still teleports'
    ).toBe(true);
  });
});
