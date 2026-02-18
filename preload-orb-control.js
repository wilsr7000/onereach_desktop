/**
 * Shared Orb Control Preload Module
 *
 * Provides IPC wrappers for controlling the desktop Voice Orb from
 * external web apps loaded in webviews.
 *
 * NOTE: This module requires require() for local files, so it only works
 * in NON-sandboxed preloads (sandbox: false). For sandboxed preloads
 * (the default in Electron 20+), the orbControl API is inlined directly
 * in preload-minimal.js and preload-spaces.js instead.
 *
 * Usage in a non-sandboxed preload:
 *   const { getOrbControlMethods } = require('./preload-orb-control');
 *   contextBridge.exposeInMainWorld('orbControl', getOrbControlMethods());
 *
 * @module PreloadOrbControl
 */

const { ipcRenderer } = require('electron');

// Fixed tool ID for external app HUD items
const EXTERNAL_TOOL_ID = 'external-app';

// ==================== HEARTBEAT (internal, transparent to app) ====================
const HEARTBEAT_INTERVAL_MS = 5000;
let _heartbeatInterval = null;
let _isHiding = false;

function _startHeartbeat() {
  _stopHeartbeat();
  _isHiding = true;
  _heartbeatInterval = setInterval(() => {
    try {
      ipcRenderer.send('orb-control:heartbeat');
    } catch (_ignored) {
      /* IPC send when window may be closing */
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function _stopHeartbeat() {
  _isHiding = false;
  if (_heartbeatInterval) {
    clearInterval(_heartbeatInterval);
    _heartbeatInterval = null;
  }
}

// Clean up on page unload
try {
  window.addEventListener('beforeunload', () => {
    _stopHeartbeat();
  });
} catch (err) {
  console.warn('[orb-control] beforeunload listener:', err.message);
}

/**
 * Get all Orb Control methods as IPC-backed functions (hardened).
 * @returns {Object} Orb Control methods ready for contextBridge
 */
function getOrbControlMethods() {
  return {
    // -- Visibility --
    hide: async () => {
      try {
        const result = await ipcRenderer.invoke('orb-control:hide');
        if (result && result.success) _startHeartbeat();
        return result || { success: false, error: 'no response' };
      } catch (e) {
        return { success: false, error: e.message || 'hide failed' };
      }
    },

    show: async () => {
      _stopHeartbeat();
      try {
        return await ipcRenderer.invoke('orb-control:show');
      } catch (e) {
        return { success: false, error: e.message || 'show failed' };
      }
    },

    toggle: async () => {
      try {
        const result = await ipcRenderer.invoke('orb-control:toggle');
        if (result && result.visible) {
          _stopHeartbeat();
        } else {
          _startHeartbeat();
        }
        return result || { success: false, error: 'no response' };
      } catch (e) {
        return { success: false, error: e.message || 'toggle failed' };
      }
    },

    isVisible: () => ipcRenderer.invoke('orb-control:is-visible').catch(() => false),

    // -- HUD Items (with input validation) --
    addHUDItem: (item) => {
      if (!item || typeof item !== 'object') {
        return Promise.resolve({ error: 'item must be an object' });
      }
      return ipcRenderer.invoke('hud-api:add-item', EXTERNAL_TOOL_ID, item);
    },

    removeHUDItem: (itemId) => {
      if (!itemId || typeof itemId !== 'string') {
        return Promise.resolve({ success: false, error: 'itemId must be a string' });
      }
      return ipcRenderer.invoke('hud-api:remove-item', EXTERNAL_TOOL_ID, itemId);
    },

    getHUDItems: () => ipcRenderer.invoke('hud-api:get-items', EXTERNAL_TOOL_ID).catch(() => []),

    clearHUDItems: () => ipcRenderer.invoke('hud-api:clear-items', EXTERNAL_TOOL_ID).catch(() => ({ success: false })),

    // -- Status --
    getStatus: () =>
      ipcRenderer.invoke('orb-control:get-status').catch(() => ({
        visible: false,
        listening: false,
        connected: false,
      })),

    // -- Events (callbacks wrapped to prevent app errors breaking IPC) --
    onVisibilityChange: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const handler = (_event, data) => {
        try {
          callback(data);
        } catch (_ignored) {
          /* user callback threw, prevent breaking IPC */
        }
      };
      ipcRenderer.on('orb-control:visibility-change', handler);
      return () => {
        try {
          ipcRenderer.removeListener('orb-control:visibility-change', handler);
        } catch (_ignored) {
          /* removeListener during teardown */
        }
      };
    },

    onStatusChange: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const handler = (_event, data) => {
        try {
          callback(data);
        } catch (_ignored) {
          /* user callback threw, prevent breaking IPC */
        }
      };
      ipcRenderer.on('orb-control:status-change', handler);
      return () => {
        try {
          ipcRenderer.removeListener('orb-control:status-change', handler);
        } catch (_ignored) {
          /* removeListener during teardown */
        }
      };
    },
  };
}

module.exports = { getOrbControlMethods };
