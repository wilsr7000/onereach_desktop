/**
 * StateManager - Core auto-save and undo/redo system
 *
 * Provides:
 * - Undo/redo stack (in-memory, configurable depth)
 * - Auto-save with debouncing
 * - Named snapshots (persistent)
 * - State change callbacks
 *
 * Usage:
 * ```javascript
 * const stateManager = new StateManager('video-editor', {
 *   maxUndoLevels: 50,
 *   autoSaveInterval: 5000,
 *   onStateChange: (state) => applyState(state)
 * });
 *
 * // Push state changes
 * stateManager.pushState(currentState, 'Added marker');
 *
 * // Undo/redo
 * stateManager.undo();
 * stateManager.redo();
 *
 * // Named snapshots
 * await stateManager.createSnapshot('Before export');
 * ```
 */

const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();
class StateManager {
  /**
   * Create a new StateManager instance
   * @param {string} editorId - Unique identifier for this editor (e.g., 'video-editor', 'clipboard-viewer')
   * @param {object} options - Configuration options
   * @param {number} [options.maxUndoLevels=50] - Maximum undo history depth
   * @param {number} [options.autoSaveInterval=5000] - Auto-save interval in ms (0 to disable)
   * @param {function} [options.onStateChange] - Callback when state changes (undo/redo/restore)
   * @param {function} [options.onAutoSave] - Callback when auto-save triggers
   * @param {function} [options.getState] - Function to get current state for auto-save
   */
  constructor(editorId, options = {}) {
    this.editorId = editorId;
    this.maxUndoLevels = options.maxUndoLevels || 50;
    this.autoSaveInterval = options.autoSaveInterval || 5000;
    this.onStateChange = options.onStateChange || null;
    this.onAutoSave = options.onAutoSave || null;
    this.getState = options.getState || null;

    // Undo/redo stacks
    this.undoStack = [];
    this.redoStack = [];
    this.currentState = null;

    // Auto-save state
    this.autoSaveTimer = null;
    this.autoSaveDebounceTimer = null;
    this.isDirty = false;
    this.lastSavedState = null;

    // Snapshot storage (will use IPC for persistence)
    this.snapshotStorage = null;

    log.info('app', '[StateManager] Initialized for', { v0: editorId });
  }

  // ═══════════════════════════════════════════════════════════
  // UNDO/REDO
  // ═══════════════════════════════════════════════════════════

  /**
   * Push a new state onto the undo stack
   * @param {object} state - The state to save
   * @param {string} [description] - Human-readable description of the change
   * @returns {void}
   */
  pushState(state, description = '') {
    // Don't push if state is identical to current
    if (this.currentState && this._statesEqual(state, this.currentState.state)) {
      return;
    }

    // Create state entry
    const entry = {
      state: this._cloneState(state),
      description,
      timestamp: Date.now(),
    };

    // Push current state to undo stack (if exists)
    if (this.currentState) {
      this.undoStack.push(this.currentState);

      // Trim undo stack if needed
      while (this.undoStack.length > this.maxUndoLevels) {
        this.undoStack.shift();
      }
    }

    // Clear redo stack (new action invalidates redo history)
    this.redoStack = [];

    // Set current state
    this.currentState = entry;
    this.isDirty = true;

    // Trigger debounced auto-save
    this._triggerAutoSave();

    log.info('app', '[StateManager] State pushed: "" (undo: , redo: )', {
      v0: description,
      v1: this.undoStack.length,
      v2: this.redoStack.length,
    });
  }

  /**
   * Undo the last action
   * @returns {boolean} True if undo was successful
   */
  undo() {
    if (!this.canUndo()) {
      log.info('app', '[StateManager] Nothing to undo');
      return false;
    }

    // Move current to redo stack
    if (this.currentState) {
      this.redoStack.push(this.currentState);
    }

    // Pop from undo stack
    this.currentState = this.undoStack.pop();

    // Notify callback
    if (this.onStateChange) {
      this.onStateChange(this.currentState.state, 'undo', this.currentState.description);
    }

    log.info('app', '[StateManager] Undo: "" (undo: , redo: )', {
      v0: this.currentState.description,
      v1: this.undoStack.length,
      v2: this.redoStack.length,
    });
    return true;
  }

  /**
   * Redo the last undone action
   * @returns {boolean} True if redo was successful
   */
  redo() {
    if (!this.canRedo()) {
      log.info('app', '[StateManager] Nothing to redo');
      return false;
    }

    // Move current to undo stack
    if (this.currentState) {
      this.undoStack.push(this.currentState);
    }

    // Pop from redo stack
    this.currentState = this.redoStack.pop();

    // Notify callback
    if (this.onStateChange) {
      this.onStateChange(this.currentState.state, 'redo', this.currentState.description);
    }

    log.info('app', '[StateManager] Redo: "" (undo: , redo: )', {
      v0: this.currentState.description,
      v1: this.undoStack.length,
      v2: this.redoStack.length,
    });
    return true;
  }

  /**
   * Check if undo is available
   * @returns {boolean}
   */
  canUndo() {
    return this.undoStack.length > 0;
  }

  /**
   * Check if redo is available
   * @returns {boolean}
   */
  canRedo() {
    return this.redoStack.length > 0;
  }

  /**
   * Get undo/redo status for UI updates
   * @returns {object} { canUndo, canRedo, undoDescription, redoDescription }
   */
  getUndoRedoStatus() {
    return {
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
      undoDescription: this.undoStack.length > 0 ? this.undoStack[this.undoStack.length - 1].description : null,
      redoDescription: this.redoStack.length > 0 ? this.redoStack[this.redoStack.length - 1].description : null,
      undoCount: this.undoStack.length,
      redoCount: this.redoStack.length,
    };
  }

  /**
   * Clear all undo/redo history
   */
  clearHistory() {
    this.undoStack = [];
    this.redoStack = [];
    log.info('app', '[StateManager] History cleared');
  }

  // ═══════════════════════════════════════════════════════════
  // AUTO-SAVE
  // ═══════════════════════════════════════════════════════════

  /**
   * Start auto-save timer
   */
  startAutoSave() {
    if (this.autoSaveInterval <= 0) return;

    this.stopAutoSave();
    this.autoSaveTimer = setInterval(() => {
      this._performAutoSave();
    }, this.autoSaveInterval);

    log.info('app', '[StateManager] Auto-save started (interval: ms)', { v0: this.autoSaveInterval });
  }

  /**
   * Stop auto-save timer
   */
  stopAutoSave() {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
    if (this.autoSaveDebounceTimer) {
      clearTimeout(this.autoSaveDebounceTimer);
      this.autoSaveDebounceTimer = null;
    }
  }

  /**
   * Force an immediate save
   */
  async forceSave() {
    await this._performAutoSave();
  }

  /**
   * Trigger debounced auto-save (called after each state change)
   * @private
   */
  _triggerAutoSave() {
    if (this.autoSaveDebounceTimer) {
      clearTimeout(this.autoSaveDebounceTimer);
    }

    // Debounce: wait 1 second after last change before saving
    this.autoSaveDebounceTimer = setTimeout(() => {
      this._performAutoSave();
    }, 1000);
  }

  /**
   * Perform the actual auto-save
   * @private
   */
  async _performAutoSave() {
    if (!this.isDirty) return;

    try {
      const stateToSave = this.getState ? this.getState() : this.currentState?.state;

      if (!stateToSave) return;

      // Save to localStorage as backup
      const key = `stateManager_${this.editorId}_autosave`;
      localStorage.setItem(
        key,
        JSON.stringify({
          state: stateToSave,
          timestamp: Date.now(),
          editorId: this.editorId,
        })
      );

      this.isDirty = false;
      this.lastSavedState = stateToSave;

      // Notify callback
      if (this.onAutoSave) {
        this.onAutoSave(stateToSave);
      }

      log.info('app', '[StateManager] Auto-saved for', { v0: this.editorId });
    } catch (error) {
      log.error('app', '[StateManager] Auto-save failed', { error: error });
    }
  }

  /**
   * Load auto-saved state (for crash recovery)
   * @returns {object|null} The saved state or null
   */
  loadAutoSave() {
    try {
      const key = `stateManager_${this.editorId}_autosave`;
      const saved = localStorage.getItem(key);

      if (saved) {
        const data = JSON.parse(saved);
        log.info('app', '[StateManager] Loaded auto-save from', { v0: new Date(data.timestamp).toLocaleString() });
        return data;
      }
    } catch (error) {
      log.error('app', '[StateManager] Failed to load auto-save', { error: error });
    }
    return null;
  }

  /**
   * Clear auto-saved state
   */
  clearAutoSave() {
    const key = `stateManager_${this.editorId}_autosave`;
    localStorage.removeItem(key);
    log.info('app', '[StateManager] Auto-save cleared');
  }

  // ═══════════════════════════════════════════════════════════
  // NAMED SNAPSHOTS (Persistent)
  // ═══════════════════════════════════════════════════════════

  /**
   * Create a named snapshot (saved to disk via IPC)
   * @param {string} name - Name for the snapshot
   * @param {object} [state] - State to save (defaults to current state)
   * @returns {Promise<object>} The created snapshot info
   */
  async createSnapshot(name, state = null) {
    const stateToSave = state || (this.getState ? this.getState() : this.currentState?.state);

    if (!stateToSave) {
      throw new Error('No state to snapshot');
    }

    const snapshot = {
      id: `snap_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name,
      editorId: this.editorId,
      state: this._cloneState(stateToSave),
      timestamp: Date.now(),
      createdAt: new Date().toISOString(),
    };

    // Save via IPC (if available)
    if (typeof window !== 'undefined' && window.stateManager?.saveSnapshot) {
      await window.stateManager.saveSnapshot(this.editorId, snapshot);
    } else {
      // Fallback to localStorage
      const key = `stateManager_${this.editorId}_snapshots`;
      const snapshots = JSON.parse(localStorage.getItem(key) || '[]');
      snapshots.unshift(snapshot);

      // Keep max 100 snapshots
      while (snapshots.length > 100) {
        snapshots.pop();
      }

      localStorage.setItem(key, JSON.stringify(snapshots));
    }

    log.info('app', '[StateManager] Snapshot created: ""', { v0: name });
    return snapshot;
  }

  /**
   * List all snapshots for this editor
   * @returns {Promise<array>} List of snapshot info (without full state data)
   */
  async listSnapshots() {
    // Try IPC first
    if (typeof window !== 'undefined' && window.stateManager?.listSnapshots) {
      return await window.stateManager.listSnapshots(this.editorId);
    }

    // Fallback to localStorage
    const key = `stateManager_${this.editorId}_snapshots`;
    const snapshots = JSON.parse(localStorage.getItem(key) || '[]');

    // Return metadata only (not full state)
    return snapshots.map((s) => ({
      id: s.id,
      name: s.name,
      timestamp: s.timestamp,
      createdAt: s.createdAt,
    }));
  }

  /**
   * Restore a snapshot by ID
   * @param {string} snapshotId - The snapshot ID to restore
   * @returns {Promise<boolean>} True if successful
   */
  async restoreSnapshot(snapshotId) {
    let snapshot = null;

    // Try IPC first
    if (typeof window !== 'undefined' && window.stateManager?.getSnapshot) {
      snapshot = await window.stateManager.getSnapshot(this.editorId, snapshotId);
    } else {
      // Fallback to localStorage
      const key = `stateManager_${this.editorId}_snapshots`;
      const snapshots = JSON.parse(localStorage.getItem(key) || '[]');
      snapshot = snapshots.find((s) => s.id === snapshotId);
    }

    if (!snapshot) {
      log.error('app', '[StateManager] Snapshot not found:', { v0: snapshotId });
      return false;
    }

    // Push current state before restoring (so user can undo the restore)
    if (this.currentState) {
      this.pushState(this.currentState.state, 'Before snapshot restore');
    }

    // Set restored state as current
    this.currentState = {
      state: snapshot.state,
      description: `Restored: ${snapshot.name}`,
      timestamp: Date.now(),
    };

    // Notify callback
    if (this.onStateChange) {
      this.onStateChange(snapshot.state, 'restore', snapshot.name);
    }

    log.info('app', '[StateManager] Restored snapshot: ""', { v0: snapshot.name });
    return true;
  }

  /**
   * Delete a snapshot
   * @param {string} snapshotId - The snapshot ID to delete
   * @returns {Promise<boolean>} True if successful
   */
  async deleteSnapshot(snapshotId) {
    // Try IPC first
    if (typeof window !== 'undefined' && window.stateManager?.deleteSnapshot) {
      return await window.stateManager.deleteSnapshot(this.editorId, snapshotId);
    }

    // Fallback to localStorage
    const key = `stateManager_${this.editorId}_snapshots`;
    let snapshots = JSON.parse(localStorage.getItem(key) || '[]');
    const initialLength = snapshots.length;
    snapshots = snapshots.filter((s) => s.id !== snapshotId);

    if (snapshots.length === initialLength) {
      return false;
    }

    localStorage.setItem(key, JSON.stringify(snapshots));
    log.info('app', '[StateManager] Deleted snapshot:', { v0: snapshotId });
    return true;
  }

  /**
   * Rename a snapshot
   * @param {string} snapshotId - The snapshot ID
   * @param {string} newName - The new name
   * @returns {Promise<boolean>} True if successful
   */
  async renameSnapshot(snapshotId, newName) {
    // Try IPC first
    if (typeof window !== 'undefined' && window.stateManager?.renameSnapshot) {
      return await window.stateManager.renameSnapshot(this.editorId, snapshotId, newName);
    }

    // Fallback to localStorage
    const key = `stateManager_${this.editorId}_snapshots`;
    const snapshots = JSON.parse(localStorage.getItem(key) || '[]');
    const snapshot = snapshots.find((s) => s.id === snapshotId);

    if (!snapshot) {
      return false;
    }

    snapshot.name = newName;
    localStorage.setItem(key, JSON.stringify(snapshots));
    log.info('app', '[StateManager] Renamed snapshot to: ""', { v0: newName });
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // UTILITY METHODS
  // ═══════════════════════════════════════════════════════════

  /**
   * Deep clone a state object
   * @private
   */
  _cloneState(state) {
    try {
      return JSON.parse(JSON.stringify(state));
    } catch (error) {
      log.error('app', '[StateManager] Failed to clone state', { error: error });
      return state;
    }
  }

  /**
   * Check if two states are equal
   * @private
   */
  _statesEqual(state1, state2) {
    try {
      return JSON.stringify(state1) === JSON.stringify(state2);
    } catch (_error) {
      return false;
    }
  }

  /**
   * Get current state
   * @returns {object|null}
   */
  getCurrentState() {
    return this.currentState?.state || null;
  }

  /**
   * Clean up resources
   */
  destroy() {
    this.stopAutoSave();
    log.info('app', '[StateManager] Destroyed for', { v0: this.editorId });
  }
}

// Export for both CommonJS and ES modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { StateManager };
}

export { StateManager };
