/**
 * Window rescue — bring off-screen / unreachable windows back.
 *
 * Three window-position bugs shipped in one day (2026-08-06/07), all
 * the same shape: a window is restored to coordinates that are
 * technically "on a display" but not actually usable, so the title bar
 * carries no grab handle and the close button is unreachable. Observed
 * in the wild at y=-21 (above the screen) and y=3 (behind the macOS
 * menu bar).
 *
 * Per-window clamping fixes each site as it is found. This module is
 * the durable half:
 *
 *   - `isWindowReachable` / `rescueBounds` state the rule ONCE, in
 *     terms of the display's WORK AREA (which excludes the menu bar
 *     and the Dock) rather than its raw bounds.
 *   - `rescueAllWindows()` walks every open BrowserWindow and moves
 *     the unreachable ones. It is wired to a menu item (the remedy a
 *     stuck user can actually click) and runs once at startup (so a
 *     bad persisted position never survives a restart).
 *
 * Pure functions take displays as a parameter so they are testable
 * without Electron.
 */

import { BrowserWindow, screen } from 'electron';

export interface RescueRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RescueDisplay {
  bounds: RescueRect;
  /** Usable area — excludes the macOS menu bar and the Dock. */
  workArea?: RescueRect;
}

/**
 * Minimum visible height of a window's top edge, in px. The title bar
 * is ~28px on macOS; we require the full bar plus a margin so there is
 * something to grab.
 */
export const MIN_GRABBABLE_PX = 32;

/** The usable rect of a display (work area when known, else bounds). */
function usable(display: RescueDisplay): RescueRect {
  return display.workArea ?? display.bounds;
}

/**
 * Is this window actually reachable — can the user grab its title bar
 * and reach its close button?
 *
 * Reachable means: the top edge sits at or below the work area's top
 * (so the title bar is not behind the menu bar), the top edge is above
 * the work area's bottom, and enough horizontal width overlaps that
 * the traffic lights are on-screen.
 */
export function isWindowReachable(
  bounds: RescueRect,
  displays: ReadonlyArray<RescueDisplay>
): boolean {
  if (displays.length === 0) return true; // nothing to judge against
  return displays.some((display) => {
    const area = usable(display);
    const topInside =
      bounds.y >= area.y && bounds.y <= area.y + area.height - MIN_GRABBABLE_PX;
    const horizontalOverlap =
      Math.min(bounds.x + bounds.width, area.x + area.width) -
      Math.max(bounds.x, area.x);
    return topInside && horizontalOverlap >= MIN_GRABBABLE_PX;
  });
}

/**
 * Where an unreachable window should go: keep its size, nudge it onto
 * the nearest usable area. Never moves a window that is already fine —
 * a deliberately-placed window keeps its position.
 */
export function rescueBounds(
  bounds: RescueRect,
  displays: ReadonlyArray<RescueDisplay>
): RescueRect {
  if (displays.length === 0) return bounds;
  if (isWindowReachable(bounds, displays)) return bounds;

  // Prefer the display the window most overlaps; fall back to primary.
  let best = displays[0] as RescueDisplay;
  let bestOverlap = -1;
  for (const display of displays) {
    const area = usable(display);
    const ox =
      Math.min(bounds.x + bounds.width, area.x + area.width) -
      Math.max(bounds.x, area.x);
    const oy =
      Math.min(bounds.y + bounds.height, area.y + area.height) -
      Math.max(bounds.y, area.y);
    const overlap = Math.max(0, ox) * Math.max(0, oy);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = display;
    }
  }
  const area = usable(best);
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  // Clamp x into the area, then pin y to the first usable row when the
  // window is above it (the menu-bar case) or below the visible band.
  const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - width);
  const maxY = area.y + area.height - MIN_GRABBABLE_PX;
  const y = Math.min(Math.max(bounds.y, area.y), Math.max(area.y, maxY));
  return { x, y, width, height };
}

/** Live displays, in the shape the pure helpers expect. */
function currentDisplays(): RescueDisplay[] {
  try {
    return screen.getAllDisplays().map((d) => ({
      bounds: d.bounds,
      workArea: d.workArea,
    }));
  } catch {
    return [];
  }
}

export interface RescueResult {
  /** How many windows were actually moved. */
  moved: number;
  /** How many were inspected. */
  inspected: number;
}

/**
 * Move every unreachable open window back into view. Safe to call at
 * any time: windows that are already reachable are left untouched.
 */
export function rescueAllWindows(
  log?: (message: string, data?: unknown) => void
): RescueResult {
  const displays = currentDisplays();
  let moved = 0;
  let inspected = 0;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    inspected++;
    try {
      const current = win.getBounds();
      const next = rescueBounds(current, displays);
      if (next.x === current.x && next.y === current.y &&
          next.width === current.width && next.height === current.height) {
        continue;
      }
      // A minimized window can't be seen regardless; restore it too so
      // "Bring Windows Into View" does what its label promises.
      if (win.isMinimized()) win.restore();
      win.setBounds(next);
      if (!win.isVisible()) win.show();
      moved++;
      log?.('window-rescue: moved an unreachable window', {
        title: win.getTitle(),
        from: current,
        to: next,
      });
    } catch {
      // Best-effort: one bad window must not stop the sweep.
    }
  }
  return { moved, inspected };
}
