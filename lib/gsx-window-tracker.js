/**
 * GSX Window Tracker
 *
 * Tracks all GSX windows to ensure proper cleanup on quit.
 * Extracted from menu.js for separation of concerns.
 */

const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

const gsxWindows = [];

/**
 * Register a GSX window for tracking
 * @param {BrowserWindow} window - The window to track
 * @param {string} title - Window title for debugging
 */
function registerGSXWindow(window, title) {
  gsxWindows.push({ window, title, created: Date.now() });
  log.info('window', 'Registered: (Total: )', { title: title, gsxWindows: gsxWindows.length });

  // Remove from tracking when closed
  window.once('closed', () => {
    const index = gsxWindows.findIndex((w) => w.window === window);
    if (index !== -1) {
      gsxWindows.splice(index, 1);
      log.info('window', 'Unregistered: (Remaining: )', { title: title, gsxWindows: gsxWindows.length });
    }
  });
}

/**
 * Force close all tracked GSX windows
 * Used during app quit to prevent zombie windows
 */
function closeAllGSXWindows() {
  log.info('window', 'Force closing windows', { gsxWindows: gsxWindows.length });

  gsxWindows.forEach(({ window, title }) => {
    if (!window.isDestroyed()) {
      log.info('window', 'Destroying', { title: title });
      try {
        window.destroy();
      } catch (error) {
        log.error('window', 'Error destroying', { title: title, error: error });
      }
    }
  });

  gsxWindows.length = 0; // Clear array
}

/**
 * Get count of tracked GSX windows
 * @returns {number}
 */
function getGSXWindowCount() {
  return gsxWindows.length;
}

module.exports = {
  registerGSXWindow,
  closeAllGSXWindows,
  getGSXWindowCount,
};
