/**
 * State Manager Module
 * 
 * Provides auto-save, undo/redo, named snapshots, and deployment versions
 * for all editors in the application.
 * 
 * Usage (in renderer/browser):
 * ```javascript
 * import { StateManager } from './src/state-manager/index.js';
 * 
 * const stateManager = new StateManager('video-editor', {
 *   maxUndoLevels: 50,
 *   autoSaveInterval: 5000,
 *   onStateChange: (state, action, description) => {
 *     console.log(`State changed: ${action} - ${description}`);
 *     applyState(state);
 *   },
 *   getState: () => getCurrentEditorState()
 * });
 * 
 * // Push state changes
 * stateManager.pushState(state, 'Added marker');
 * 
 * // Undo/redo
 * stateManager.undo();
 * stateManager.redo();
 * 
 * // Named snapshots
 * await stateManager.createSnapshot('Before export');
 * const snapshots = await stateManager.listSnapshots();
 * await stateManager.restoreSnapshot(snapshotId);
 * ```
 * 
 * Usage (in main process for IPC):
 * ```javascript
 * const { SnapshotStorage } = require('./src/state-manager/index.js');
 * 
 * const snapshotStorage = new SnapshotStorage(app.getPath('userData'));
 * 
 * ipcMain.handle('snapshot:save', (event, editorId, snapshot) => {
 *   return snapshotStorage.saveSnapshot(editorId, snapshot);
 * });
 * ```
 */

// Browser/renderer exports (ES modules)
export { StateManager } from './StateManager.js';

// For main process (CommonJS)
if (typeof module !== 'undefined' && module.exports) {
  const { SnapshotStorage } = require('./SnapshotStorage.js');
  module.exports = {
    SnapshotStorage,
    // StateManager is for renderer only
  };
}











