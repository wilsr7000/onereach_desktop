'use strict';

/**
 * agent-ui-modal-manager -- per-agent floating modal windows
 *
 * Phase 2 of the Orb Unified UX redesign. When an agent returns a
 * "rich" micro-UI (panelWidth >= 400 or panelHeight >= 300, OR explicit
 * displayMode === 'modal'), the bridge calls showAgentUIModal(...) to
 * pop the panel in its own frameless BrowserWindow sized to content.
 *
 * Replaces the cramped Command HUD window:
 *   - Sized to the agent's panelWidth x panelHeight (not 340x420 default)
 *   - One modal per agentId; re-firing same agent updates in place
 *   - NOT alwaysOnTop (so the user can keep working)
 *   - Frameless with a tiny title bar (agent name + close button, no
 *     accelerator -- per project keyboard-shortcut rules)
 *   - Position: opposite side of orb from the chat panel; remembers
 *     last position per agentId in a JSON file under userData
 *   - Closes via the X button, programmatic .close(), or
 *     closeAgentUIModal(agentId)
 *
 * Public API:
 *   showAgentUIModal(opts) -- create or update a modal
 *   closeAgentUIModal(agentId) -- close one modal
 *   closeAllAgentUIModals() -- close all (e.g. on app quit)
 *   getActiveModalIds() -- introspection for tests / health checks
 *
 * The module is lazy: it requires Electron only when an Electron-needing
 * function is called, so it can be unit-tested without the full
 * Electron runtime. Pure helpers (computeModalPosition,
 * sanitizeDimensions) are exported separately for direct testing.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const DEFAULT_MIN_WIDTH = 320;
const DEFAULT_MIN_HEIGHT = 240;
const DEFAULT_MAX_WIDTH = 1200;
const DEFAULT_MAX_HEIGHT = 1200;
const POSITION_SPACING = 20;
const POSITION_FILE = 'agent-ui-modal-positions.json';

// ---------------------------------------------------------------------------
// Pure helpers (testable without Electron)
// ---------------------------------------------------------------------------

function sanitizeDimensions({ width, height }) {
  let w = Number.isFinite(width) && width > 0 ? Math.round(width) : DEFAULT_MIN_WIDTH;
  let h = Number.isFinite(height) && height > 0 ? Math.round(height) : DEFAULT_MIN_HEIGHT;
  w = Math.max(DEFAULT_MIN_WIDTH, Math.min(DEFAULT_MAX_WIDTH, w));
  h = Math.max(DEFAULT_MIN_HEIGHT, Math.min(DEFAULT_MAX_HEIGHT, h));
  return { width: w, height: h };
}

/**
 * Compute the best position for a modal relative to the orb.
 * Strategy:
 *   - Place on the opposite side of the orb from the chat panel
 *   - Vertically centered around the orb's vertical midpoint
 *   - Clamp to display work area
 *   - If a saved position is provided AND it's still within the work
 *     area, use it as-is (user moved it to where they want it)
 */
function computeModalPosition({ orbBounds, workArea, width, height, savedPosition, chatOpenSide }) {
  // savedPosition wins if it's still within the work area.
  if (
    savedPosition &&
    Number.isFinite(savedPosition.x) &&
    Number.isFinite(savedPosition.y) &&
    workArea &&
    savedPosition.x >= workArea.x - 8 &&
    savedPosition.x + width <= workArea.x + workArea.width + 8 &&
    savedPosition.y >= workArea.y - 8 &&
    savedPosition.y + height <= workArea.y + workArea.height + 8
  ) {
    return { x: Math.round(savedPosition.x), y: Math.round(savedPosition.y) };
  }

  if (!orbBounds || !workArea) {
    // Fallback: center of work area or screen origin
    if (workArea) {
      return {
        x: Math.round(workArea.x + (workArea.width - width) / 2),
        y: Math.round(workArea.y + (workArea.height - height) / 2),
      };
    }
    return { x: 100, y: 100 };
  }

  const orbCenterX = orbBounds.x + orbBounds.width / 2;
  const orbCenterY = orbBounds.y + orbBounds.height / 2;
  const displayCenterX = workArea.x + workArea.width / 2;

  // Decide side. If chat is open on one side, prefer the other side.
  // Otherwise, place modal on the opposite side of the orb so it doesn't
  // overlap.
  let placeRight;
  if (chatOpenSide === 'right') placeRight = false;
  else if (chatOpenSide === 'left') placeRight = true;
  else placeRight = orbCenterX <= displayCenterX;

  let x;
  if (placeRight) {
    x = orbBounds.x + orbBounds.width + POSITION_SPACING;
  } else {
    x = orbBounds.x - width - POSITION_SPACING;
  }

  // Vertically center on the orb, then nudge up if it would go off screen
  let y = Math.round(orbCenterY - height / 2);

  // Clamp
  x = Math.max(workArea.x + 8, Math.min(x, workArea.x + workArea.width - width - 8));
  y = Math.max(workArea.y + 8, Math.min(y, workArea.y + workArea.height - height - 8));

  return { x: Math.round(x), y: Math.round(y) };
}

// ---------------------------------------------------------------------------
// Position persistence
// ---------------------------------------------------------------------------

let _positionStorePath = null;
function getPositionStorePath() {
  if (_positionStorePath) return _positionStorePath;
  const home = os.homedir();
  const dir = process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'Onereach.ai')
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA || home, 'Onereach.ai')
      : path.join(home, '.config', 'Onereach.ai');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_e) { /* OK */ }
  _positionStorePath = path.join(dir, POSITION_FILE);
  return _positionStorePath;
}
function _setPositionStorePath(p) { _positionStorePath = p; }
function _resetPositionStorePath() { _positionStorePath = null; }

function loadSavedPositions() {
  try {
    const p = getPositionStorePath();
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_e) {
    return {};
  }
}

function saveAgentPosition(agentId, x, y) {
  try {
    const p = getPositionStorePath();
    const positions = loadSavedPositions();
    positions[agentId] = { x: Math.round(x), y: Math.round(y), savedAt: Date.now() };
    fs.writeFileSync(p, JSON.stringify(positions, null, 2), 'utf8');
  } catch (_e) {
    // Persistence is best-effort; ignore failures
  }
}

// ---------------------------------------------------------------------------
// Modal lifecycle (Electron-dependent)
// ---------------------------------------------------------------------------

const activeModals = new Map(); // agentId -> BrowserWindow

function _getElectron() {
  // Lazy require so unit tests can import the pure helpers without
  // the Electron runtime.
  return require('electron');
}

function _getOrbBounds() {
  if (typeof global !== 'undefined' && global.orbWindow && !global.orbWindow.isDestroyed()) {
    try { return global.orbWindow.getBounds(); } catch (_e) { /* gone */ }
  }
  return null;
}

function _getOrbWorkArea() {
  if (typeof global !== 'undefined' && global.orbWindow && !global.orbWindow.isDestroyed()) {
    try {
      const { screen } = _getElectron();
      const bounds = global.orbWindow.getBounds();
      const display = screen.getDisplayMatching(bounds);
      return display.workArea;
    } catch (_e) { /* fall through */ }
  }
  try {
    const { screen } = _getElectron();
    return screen.getPrimaryDisplay().workArea;
  } catch (_e) {
    return null;
  }
}

function _getChatOpenSide() {
  // The orb sets currentOrbSide and tracks chat anchor via main IPC.
  // For now we just check the orb's bounds vs display center as a
  // proxy; once the orb publishes a global.orbChatOpenSide we can
  // read it directly.
  if (typeof global !== 'undefined' && typeof global.orbChatOpenSide === 'string') {
    return global.orbChatOpenSide;
  }
  return null;
}

function showAgentUIModal({ agentId, agentName, html, panelWidth, panelHeight }) {
  if (!agentId || typeof html !== 'string') return null;
  const dims = sanitizeDimensions({ width: panelWidth, height: panelHeight });

  // Update existing
  const existing = activeModals.get(agentId);
  if (existing && !existing.isDestroyed()) {
    try {
      existing.setSize(dims.width, dims.height, true);
      existing.webContents.send('agent-ui:update', { html, panelWidth: dims.width, panelHeight: dims.height });
      existing.focus();
      return existing;
    } catch (_e) {
      // Window might be in a weird state; fall through to recreate
      try { existing.destroy(); } catch (_e2) { /* OK */ }
      activeModals.delete(agentId);
    }
  }

  const { BrowserWindow } = _getElectron();
  const orbBounds = _getOrbBounds();
  const workArea = _getOrbWorkArea();
  const savedPosition = loadSavedPositions()[agentId] || null;
  const { x, y } = computeModalPosition({
    orbBounds,
    workArea,
    width: dims.width,
    height: dims.height,
    savedPosition,
    chatOpenSide: _getChatOpenSide(),
  });

  const win = new BrowserWindow({
    width: dims.width,
    height: dims.height,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: false,
    skipTaskbar: false,
    hasShadow: true,
    resizable: true,
    minWidth: DEFAULT_MIN_WIDTH,
    minHeight: DEFAULT_MIN_HEIGHT,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload-agent-ui-modal.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
    show: false,
  });

  win.loadFile(path.join(__dirname, '..', 'agent-ui-modal.html'), {
    query: { agentId, agentName: agentName || '' },
  });

  win.webContents.once('did-finish-load', () => {
    win.webContents.send('agent-ui:render', {
      agentId,
      agentName: agentName || '',
      html,
      panelWidth: dims.width,
      panelHeight: dims.height,
    });
    win.show();
  });

  win.on('move', () => {
    try {
      const [px, py] = win.getPosition();
      saveAgentPosition(agentId, px, py);
    } catch (_e) { /* OK */ }
  });

  win.on('closed', () => {
    activeModals.delete(agentId);
  });

  activeModals.set(agentId, win);
  return win;
}

function closeAgentUIModal(agentId) {
  const win = activeModals.get(agentId);
  if (win && !win.isDestroyed()) {
    try { win.close(); } catch (_e) { /* OK */ }
  }
  activeModals.delete(agentId);
}

function closeAllAgentUIModals() {
  for (const [agentId, win] of activeModals) {
    if (win && !win.isDestroyed()) {
      try { win.close(); } catch (_e) { /* OK */ }
    }
    activeModals.delete(agentId);
  }
}

function getActiveModalIds() {
  return Array.from(activeModals.keys());
}

module.exports = {
  // Public API
  showAgentUIModal,
  closeAgentUIModal,
  closeAllAgentUIModals,
  getActiveModalIds,
  // Pure helpers (exported for tests + reuse)
  sanitizeDimensions,
  computeModalPosition,
  loadSavedPositions,
  saveAgentPosition,
  // Constants
  DEFAULT_MIN_WIDTH,
  DEFAULT_MIN_HEIGHT,
  DEFAULT_MAX_WIDTH,
  DEFAULT_MAX_HEIGHT,
  POSITION_SPACING,
  // Test seams
  _setPositionStorePath,
  _resetPositionStorePath,
};
