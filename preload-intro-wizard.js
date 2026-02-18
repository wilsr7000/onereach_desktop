/**
 * Preload script for Intro Wizard
 * Provides IPC bridge for version tracking and wizard completion
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('introWizard', {
  /**
   * Get initialization data for the wizard
   * @returns {Promise<{currentVersion: string, lastSeenVersion: string|null, isFirstRun: boolean}>}
   */
  getInitData: () => ipcRenderer.invoke('intro-wizard:get-init-data'),

  /**
   * Mark the current version as seen (called when user closes wizard)
   */
  markAsSeen: () => ipcRenderer.invoke('intro-wizard:mark-seen'),

  /**
   * Close the wizard window
   */
  close: () => ipcRenderer.invoke('intro-wizard:close'),
});
