'use strict';

/**
 * preload-agent-ui-modal -- bridge for the per-agent micro-UI modal
 *
 * Phase 2 of the Orb Unified UX redesign. Each agent that returns a
 * "rich" micro-UI (displayMode === 'modal') gets its own frameless
 * BrowserWindow loaded with agent-ui-modal.html. This preload exposes
 * a tiny window.modalAPI so the renderer can:
 *
 *   - Subscribe to render / update events from the main process
 *   - Close itself programmatically
 *
 * No node integration. CSP locks down what the modal HTML can load.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('modalAPI', {
  /**
   * Subscribe to the initial render event sent right after the page loads.
   * Called with { agentId, agentName, html, panelWidth, panelHeight }.
   */
  onRender: (callback) => {
    const handler = (_e, data) => {
      try { callback(data); } catch (err) { console.error('[modalAPI.onRender]', err); }
    };
    ipcRenderer.on('agent-ui:render', handler);
    return () => ipcRenderer.removeListener('agent-ui:render', handler);
  },

  /**
   * Subscribe to update events for re-fires of the same agent (the
   * manager replaces in place rather than spawning a new window).
   */
  onUpdate: (callback) => {
    const handler = (_e, data) => {
      try { callback(data); } catch (err) { console.error('[modalAPI.onUpdate]', err); }
    };
    ipcRenderer.on('agent-ui:update', handler);
    return () => ipcRenderer.removeListener('agent-ui:update', handler);
  },

  /**
   * Close the modal window programmatically (used by the X button).
   */
  close: () => ipcRenderer.send('agent-ui:close-self'),
});
