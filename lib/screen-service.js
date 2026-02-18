/**
 * Screen Service -- Centralized screen geometry and display management.
 *
 * Provides multi-monitor awareness, orb positioning helpers, edge snapping,
 * per-display position memory, and agent screen context.
 *
 * IMPORTANT: Electron's `screen` module can only be used after app.whenReady().
 * All functions lazy-require it on first call, so this module is safe to
 * require() at any time.
 */

'use strict';

// ---------------------------------------------------------------------------
// Lazy accessor for Electron's screen module
// ---------------------------------------------------------------------------

let _testScreen = null;

function getScreen() {
  if (_testScreen) return _testScreen;
  // Always access fresh -- require() is cached by Node, and this avoids
  // stale references when the module is hot-reloaded or mocked in tests.
  return require('electron').screen;
}

/**
 * Inject a mock screen object for unit testing.
 * Call with null to restore default behavior.
 * @param {Object|null} mockScreen
 */
function _setScreenForTesting(mockScreen) {
  _testScreen = mockScreen;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Visible orb dimensions inside the BrowserWindow */
const ORB_SIZE = 80;
const ORB_MARGIN = 20;
/** Expanded window size (for chat panel + tooltip) */
const ORB_WINDOW_WIDTH = 400;
const ORB_WINDOW_HEIGHT = 550;
/** Collapsed window size (just the orb circle + margin) */
const ORB_COLLAPSED_WIDTH = 130;
const ORB_COLLAPSED_HEIGHT = 130;

/** Distance in px within which the orb snaps to a screen edge or corner */
const SNAP_DISTANCE = 20;

/** Minimum margin from display edge after clamping (px) */
const CLAMP_MARGIN = 10;

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * Generate a stable key for a display based on its logical bounds.
 * Format: "{width}x{height}@{x},{y}"
 * Example: "2560x1440@0,0"  or  "1440x900@2560,0"
 *
 * @param {Electron.Display} display
 * @returns {string}
 */
function displayKey(display) {
  const b = display.bounds;
  return `${b.width}x${b.height}@${b.x},${b.y}`;
}

/**
 * Get all connected displays.
 * @returns {Electron.Display[]}
 */
function getAllDisplays() {
  return getScreen().getAllDisplays();
}

/**
 * Get the display nearest to a BrowserWindow's top-left corner.
 * If the window is destroyed or has no position, returns the primary display.
 *
 * @param {Electron.BrowserWindow} win
 * @returns {Electron.Display}
 */
function getDisplayForWindow(win) {
  try {
    if (!win || win.isDestroyed()) {
      return getScreen().getPrimaryDisplay();
    }
    const [x, y] = win.getPosition();
    return getScreen().getDisplayNearestPoint({ x, y });
  } catch {
    return getScreen().getPrimaryDisplay();
  }
}

/**
 * Get the display nearest to an arbitrary point.
 * Falls back to primary display on any error.
 *
 * @param {{ x: number, y: number }} point
 * @returns {Electron.Display}
 */
function getDisplayForPoint(point) {
  try {
    if (
      !point ||
      typeof point.x !== 'number' ||
      typeof point.y !== 'number' ||
      !isFinite(point.x) ||
      !isFinite(point.y)
    ) {
      return getScreen().getPrimaryDisplay();
    }
    return getScreen().getDisplayNearestPoint(point);
  } catch {
    return getScreen().getPrimaryDisplay();
  }
}

// ---------------------------------------------------------------------------
// Orb geometry
// ---------------------------------------------------------------------------

/**
 * Compute the on-screen center position of the visible 80x80 orb within its
 * 400x550 BrowserWindow. The orb sits at the bottom of the window, offset to
 * the left or right depending on `side`.
 *
 * @param {Electron.BrowserWindow | { getPosition: () => [number, number], getSize: () => [number, number] }} orbWindow
 * @param {'left' | 'right'} side  -- which side of the window the orb is on
 * @returns {{ cx: number, cy: number, size: number }}
 */
function getOrbScreenPosition(orbWindow, side = 'right') {
  const [winX, winY] = orbWindow.getPosition();
  const [winW, winH] = orbWindow.getSize();

  // Horizontal center: orb is ORB_MARGIN from the edge on its side
  const cx =
    side === 'left'
      ? winX + ORB_MARGIN + ORB_SIZE / 2 // left:  winX + 20 + 40 = winX + 60
      : winX + winW - ORB_MARGIN - ORB_SIZE / 2; // right: winX + 400 - 20 - 40 = winX + 340

  // Vertical center: orb is ORB_MARGIN from the bottom
  const cy = winY + winH - ORB_MARGIN - ORB_SIZE / 2; // winY + 550 - 20 - 40 = winY + 490

  return { cx, cy, size: ORB_SIZE };
}

// ---------------------------------------------------------------------------
// Clamping
// ---------------------------------------------------------------------------

/**
 * Clamp a window rectangle to stay within a display's work area.
 * Returns the adjusted { x, y } -- width and height are unchanged.
 *
 * @param {{ x: number, y: number, width: number, height: number }} bounds
 * @param {Electron.Display} display
 * @returns {{ x: number, y: number }}
 */
function clampToDisplay(bounds, display) {
  const wa = display.workArea;
  const margin = CLAMP_MARGIN;

  let x = bounds.x;
  let y = bounds.y;

  // Right edge: window must not overflow past workArea right
  const maxX = wa.x + wa.width - bounds.width - margin;
  // Left edge
  const minX = wa.x + margin;
  // Bottom edge
  const maxY = wa.y + wa.height - bounds.height - margin;
  // Top edge
  const minY = wa.y + margin;

  x = Math.max(minX, Math.min(x, maxX));
  y = Math.max(minY, Math.min(y, maxY));

  return { x: Math.round(x), y: Math.round(y) };
}

// ---------------------------------------------------------------------------
// Edge magnetism / snapping
// ---------------------------------------------------------------------------

/**
 * Apply edge magnetism: if the orb window is within SNAP_DISTANCE of a
 * display edge or corner, snap it flush to that edge.
 *
 * Called after drag-end (debounce). The orbBounds should represent the actual
 * visible orb rectangle (not the full 400x550 window), but for simplicity we
 * snap the *window* based on where the visible orb would be after placement.
 *
 * @param {{ x: number, y: number, width: number, height: number }} windowBounds
 * @param {Electron.Display} display
 * @param {number} [snapDist] -- override snap distance (default SNAP_DISTANCE)
 * @returns {{ x: number, y: number, snapped: boolean }}
 */
function snapToEdge(windowBounds, display, snapDist = SNAP_DISTANCE) {
  const wa = display.workArea;
  let { x, y } = windowBounds;
  const { width: w, height: h } = windowBounds;

  const originalX = x;
  const originalY = y;

  // Snap left edge
  if (Math.abs(x - wa.x) <= snapDist) {
    x = wa.x;
  }
  // Snap right edge
  else if (Math.abs(x + w - (wa.x + wa.width)) <= snapDist) {
    x = wa.x + wa.width - w;
  }

  // Snap top edge
  if (Math.abs(y - wa.y) <= snapDist) {
    y = wa.y;
  }
  // Snap bottom edge
  else if (Math.abs(y + h - (wa.y + wa.height)) <= snapDist) {
    y = wa.y + wa.height - h;
  }

  return {
    x: Math.round(x),
    y: Math.round(y),
    snapped: x !== originalX || y !== originalY,
  };
}

// ---------------------------------------------------------------------------
// Per-display position memory
// ---------------------------------------------------------------------------

/**
 * Look up the saved orb position for a specific display.
 *
 * @param {Object} positionsMap -- the voiceOrbPositions settings object
 * @param {Electron.Display} display
 * @returns {{ x: number, y: number, side: string } | null}
 */
function getSavedPositionForDisplay(positionsMap, display) {
  if (!positionsMap || typeof positionsMap !== 'object') return null;
  const key = displayKey(display);
  const entry = positionsMap[key];
  if (entry && typeof entry.x === 'number' && typeof entry.y === 'number') {
    return entry;
  }
  return null;
}

/**
 * Update the saved position for a specific display in the positions map.
 * Returns a new map (does not mutate).
 *
 * @param {Object} positionsMap -- existing map (or null/undefined)
 * @param {Electron.Display} display
 * @param {{ x: number, y: number, side: string }} position
 * @returns {Object} updated map
 */
function setSavedPositionForDisplay(positionsMap, display, position) {
  const map = { ...(positionsMap || {}) };
  const key = displayKey(display);
  map[key] = {
    x: Math.round(position.x),
    y: Math.round(position.y),
    side: position.side || 'right',
  };
  return map;
}

/**
 * Migrate from old flat voiceOrbPosition to new per-display map.
 * Called once on startup if the old key exists and the new one doesn't.
 *
 * @param {{ x: number, y: number } | null} oldPosition
 * @param {string} oldSide
 * @returns {Object} new positions map with _default key
 */
function migrateOldPosition(oldPosition, oldSide) {
  const map = {};
  if (oldPosition && typeof oldPosition.x === 'number' && typeof oldPosition.y === 'number') {
    // Try to figure out which display this was on
    const display = getDisplayForPoint(oldPosition);
    const key = displayKey(display);
    map[key] = {
      x: oldPosition.x,
      y: oldPosition.y,
      side: oldSide || 'right',
    };
  }
  return map;
}

// ---------------------------------------------------------------------------
// HUD positioning
// ---------------------------------------------------------------------------

/**
 * Compute the best position for the Command HUD window relative to the orb.
 * Centers horizontally on the actual visible orb and places above it.
 * Falls back to below if there isn't enough room above.
 * Clamps to the orb's display work area.
 *
 * @param {Electron.BrowserWindow} orbWindow
 * @param {string} side -- 'left' or 'right'
 * @param {number} hudWidth
 * @param {number} hudHeight
 * @param {number} [spacing=20] -- gap between HUD and orb
 * @returns {{ x: number, y: number }}
 */
function computeHUDPosition(orbWindow, side, hudWidth, hudHeight, spacing = 20) {
  const { cx, cy, size } = getOrbScreenPosition(orbWindow, side);
  const display = getDisplayForWindow(orbWindow);
  const wa = display.workArea;

  // Center HUD horizontally on actual orb center
  let x = cx - hudWidth / 2;

  // Place above the orb's top edge
  const orbTop = cy - size / 2;
  let y = orbTop - hudHeight - spacing;

  // Clamp horizontal
  x = Math.max(wa.x + CLAMP_MARGIN, Math.min(x, wa.x + wa.width - hudWidth - CLAMP_MARGIN));

  // Clamp vertical -- prefer above, fall back to below
  if (y < wa.y + CLAMP_MARGIN) {
    // Not enough room above -- try below the orb
    const orbBottom = cy + size / 2;
    y = orbBottom + spacing;

    if (y + hudHeight > wa.y + wa.height - CLAMP_MARGIN) {
      // Not enough room below either -- pin to top
      y = wa.y + CLAMP_MARGIN;
    }
  }

  return { x: Math.round(x), y: Math.round(y) };
}

// ---------------------------------------------------------------------------
// Display change listener
// ---------------------------------------------------------------------------

/** Registered cleanup functions for display listeners */
let _displayListenerCleanup = null;

/**
 * Register a callback for display configuration changes.
 * The callback receives (eventType, display, changedMetrics) where eventType
 * is 'added', 'removed', or 'metrics-changed'.
 *
 * @param {function} callback -- (eventType: string, display: Electron.Display, changedMetrics?: string[]) => void
 * @returns {function} cleanup -- call to remove all listeners
 */
function listenForDisplayChanges(callback) {
  const s = getScreen();

  const onAdded = (_, display) => callback('added', display);
  const onRemoved = (_, display) => callback('removed', display);
  const onChanged = (_, display, changedMetrics) => callback('metrics-changed', display, changedMetrics);

  s.on('display-added', onAdded);
  s.on('display-removed', onRemoved);
  s.on('display-metrics-changed', onChanged);

  const cleanup = () => {
    s.removeListener('display-added', onAdded);
    s.removeListener('display-removed', onRemoved);
    s.removeListener('display-metrics-changed', onChanged);
  };

  _displayListenerCleanup = cleanup;
  return cleanup;
}

// ---------------------------------------------------------------------------
// Agent screen context
// ---------------------------------------------------------------------------

/**
 * Build a screen context object for injection into agent task metadata.
 * Includes display geometry, orb position, and optionally the frontmost app.
 *
 * @param {Electron.BrowserWindow | null} orbWindow
 * @param {string} orbSide
 * @returns {Object}
 */
function getScreenContext(orbWindow, orbSide = 'right') {
  try {
    const displays = getAllDisplays().map((d, i) => ({
      index: i,
      width: d.workArea.width,
      height: d.workArea.height,
      x: d.workArea.x,
      y: d.workArea.y,
      scaleFactor: d.scaleFactor,
      primary: d.bounds.x === 0 && d.bounds.y === 0,
    }));

    let orbPosition = null;
    if (orbWindow && !orbWindow.isDestroyed()) {
      const { cx, cy, size } = getOrbScreenPosition(orbWindow, orbSide);
      const orbDisplay = getDisplayForWindow(orbWindow);
      const displayIdx = getAllDisplays().findIndex((d) => d.id === orbDisplay.id);
      orbPosition = {
        display: displayIdx >= 0 ? displayIdx : 0,
        side: orbSide,
        cx: Math.round(cx),
        cy: Math.round(cy),
        size,
      };
    }

    // Frontmost app -- read from cached context if available
    let frontmostApp = null;
    try {
      if (global.appContextCapture && typeof global.appContextCapture.getFrontmostApp === 'function') {
        frontmostApp = global.appContextCapture.getFrontmostApp();
      }
    } catch {
      /* ignore */
    }

    return {
      displays,
      displayCount: displays.length,
      orbPosition,
      frontmostApp,
    };
  } catch (err) {
    console.error('[ScreenService] getScreenContext error:', err.message);
    return { displays: [], displayCount: 0, orbPosition: null, frontmostApp: null };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Constants
  ORB_SIZE,
  ORB_MARGIN,
  ORB_WINDOW_WIDTH,
  ORB_WINDOW_HEIGHT,
  ORB_COLLAPSED_WIDTH,
  ORB_COLLAPSED_HEIGHT,
  SNAP_DISTANCE,
  CLAMP_MARGIN,

  // Display helpers
  displayKey,
  getAllDisplays,
  getDisplayForWindow,
  getDisplayForPoint,

  // Orb geometry
  getOrbScreenPosition,

  // Clamping & snapping
  clampToDisplay,
  snapToEdge,

  // Per-display memory
  getSavedPositionForDisplay,
  setSavedPositionForDisplay,
  migrateOldPosition,

  // HUD positioning
  computeHUDPosition,

  // Display change listener
  listenForDisplayChanges,

  // Agent context
  getScreenContext,

  // Testing
  _setScreenForTesting,
};
