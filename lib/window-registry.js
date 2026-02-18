/**
 * Centralized Window Registry
 *
 * Replaces ad-hoc `let xxxWindow = null` patterns across main.js with a
 * centralized registry that handles singleton enforcement, cleanup, and
 * destroyed-window guards.
 *
 * Usage:
 *   const registry = require('./lib/window-registry');
 *
 *   // Create-or-focus a singleton window
 *   registry.createOrFocus('settings', () => {
 *     const win = new BrowserWindow({ ... });
 *     win.loadFile('settings.html');
 *     return win;
 *   });
 *
 *   // Register an already-created window
 *   registry.register('capture', captureWindow, { singleton: false });
 *
 *   // Safe send (no-op if window is destroyed)
 *   registry.send('settings', 'update-data', payload);
 *
 *   // Get window (returns null if destroyed/missing)
 *   const win = registry.get('settings');
 *
 *   // Close all (for app quit)
 *   registry.closeAll();
 */

class WindowRegistry {
  constructor() {
    /** @type {Map<string, { window: Electron.BrowserWindow, opts: object }>} */
    this._windows = new Map();
  }

  /**
   * Singleton pattern: show existing window or create a new one.
   * @param {string} name - Unique window identifier
   * @param {() => Electron.BrowserWindow} factory - Function that creates the window
   * @param {object} [opts] - Options
   * @param {Function} [opts.onClosed] - Extra cleanup callback when window closes
   * @returns {Electron.BrowserWindow}
   */
  createOrFocus(name, factory, opts = {}) {
    const existing = this.get(name);
    if (existing) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
      return existing;
    }

    const win = factory();
    this.register(name, win, opts);
    return win;
  }

  /**
   * Register a window with the registry. Automatically cleans up on 'closed'.
   * @param {string} name - Unique window identifier
   * @param {Electron.BrowserWindow} window - The BrowserWindow instance
   * @param {object} [opts] - Options
   * @param {boolean} [opts.singleton=true] - Whether this should be a singleton
   * @param {Function} [opts.onClosed] - Extra cleanup callback when window closes
   */
  register(name, window, opts = {}) {
    if (!window || window.isDestroyed()) {
      console.warn(`[WindowRegistry] Attempted to register destroyed window: ${name}`);
      return;
    }

    this._windows.set(name, { window, opts });

    window.on('closed', () => {
      this._windows.delete(name);
      if (typeof opts.onClosed === 'function') {
        try {
          opts.onClosed();
        } catch (err) {
          console.warn(`[WindowRegistry] onClosed callback error for "${name}":`, err.message);
        }
      }
    });
  }

  /**
   * Get a window by name. Returns null if not found or destroyed.
   * @param {string} name
   * @returns {Electron.BrowserWindow|null}
   */
  get(name) {
    const entry = this._windows.get(name);
    if (!entry) return null;

    if (entry.window.isDestroyed()) {
      this._windows.delete(name);
      return null;
    }

    return entry.window;
  }

  /**
   * Check if a window exists and is not destroyed.
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return this.get(name) !== null;
  }

  /**
   * Safe send: sends IPC message to window, no-op if destroyed or missing.
   * @param {string} name - Window name
   * @param {string} channel - IPC channel
   * @param {...*} args - Arguments to send
   * @returns {boolean} Whether the message was sent
   */
  send(name, channel, ...args) {
    const win = this.get(name);
    if (!win) return false;

    try {
      win.webContents.send(channel, ...args);
      return true;
    } catch (err) {
      console.warn(`[WindowRegistry] send failed for "${name}" on channel "${channel}":`, err.message);
      return false;
    }
  }

  /**
   * Safe executeJavaScript on a window.
   * @param {string} name - Window name
   * @param {string} js - JavaScript code to execute
   * @returns {Promise<*>|null}
   */
  executeJS(name, js) {
    const win = this.get(name);
    if (!win) return null;

    try {
      return win.webContents.executeJavaScript(js, true);
    } catch (err) {
      console.warn(`[WindowRegistry] executeJS failed for "${name}":`, err.message);
      return null;
    }
  }

  /**
   * Close and unregister a specific window.
   * @param {string} name
   */
  close(name) {
    const win = this.get(name);
    if (win) {
      try {
        win.close();
      } catch (err) {
        console.warn(`[WindowRegistry] close failed for "${name}":`, err.message);
      }
    }
    this._windows.delete(name);
  }

  /**
   * Close all registered windows (for app quit).
   * Handles already-destroyed windows gracefully.
   */
  closeAll() {
    for (const [name, entry] of this._windows.entries()) {
      try {
        if (!entry.window.isDestroyed()) {
          entry.window.close();
        }
      } catch (err) {
        console.warn(`[WindowRegistry] closeAll failed for "${name}":`, err.message);
      }
    }
    this._windows.clear();
  }

  /**
   * Destroy all registered windows (forced cleanup).
   */
  destroyAll() {
    for (const [name, entry] of this._windows.entries()) {
      try {
        if (!entry.window.isDestroyed()) {
          entry.window.destroy();
        }
      } catch (err) {
        console.warn(`[WindowRegistry] destroyAll failed for "${name}":`, err.message);
      }
    }
    this._windows.clear();
  }

  /**
   * List all registered window names and their status.
   * @returns {Array<{name: string, alive: boolean, visible: boolean, focused: boolean}>}
   */
  list() {
    const result = [];
    for (const [name, entry] of this._windows.entries()) {
      const destroyed = entry.window.isDestroyed();
      result.push({
        name,
        alive: !destroyed,
        visible: !destroyed && entry.window.isVisible(),
        focused: !destroyed && entry.window.isFocused(),
      });
    }
    return result;
  }

  /**
   * Number of tracked windows.
   * @returns {number}
   */
  get size() {
    return this._windows.size;
  }
}

// Singleton instance
const registry = new WindowRegistry();

module.exports = registry;
