/**
 * Task Store
 *
 * Single source of truth for live task state that today is spread across
 * six Maps inside lib/hud-api.js:
 *
 *   - _taskToolMap            (taskId -> toolId)
 *   - _taskSpaceMap           (taskId -> spaceId)
 *   - _taskTimestamps         (taskId -> createdAt; for TTL cleanup)
 *   - _hudItems               (toolId -> Map<itemId, item>)
 *   - _disambiguationStates   (stateId -> { taskId, toolId, question, options, createdAt })
 *   - _needsInputRequests     (taskId -> { toolId, prompt, agentId, createdAt })
 *
 * Phase 0 of the agent-system upgrade introduces this store as a NEW
 * authoritative home for that state. hud-api can mirror-write to it
 * behind the `typedTaskContract` flag so consumers can migrate
 * incrementally; subsequent phases retire the raw Maps.
 *
 * Deliberate design points:
 *   - Pure JS, no Electron deps. Easy to unit-test.
 *   - Cleanup is driven by calling `sweep(now)`; caller owns the timer.
 *     (hud-api already runs a periodic cleanup; it can delegate to us.)
 *   - TTL constants match the legacy values so behavior is bit-for-bit
 *     identical when the store is swapped in.
 *
 * @module lib/exchange/task-store
 */

'use strict';

// TTLs mirror lib/hud-api.js exactly (do not change without a
// corresponding update there).
const STALE_TASK_TTL_MS = 10 * 60 * 1000;
const STALE_STATE_TTL_MS = 5 * 60 * 1000;

class TaskStore {
  constructor() {
    // Task -> routing info. Value shape: { taskId, toolId, spaceId, createdAt }
    this._tasks = new Map();

    // Per-tool HUD items. toolId -> Map<itemId, item>
    this._hudItems = new Map();

    // Active disambiguation states. stateId -> full state object
    this._disambiguations = new Map();

    // Pending needs-input requests. taskId -> full request object
    this._needsInputs = new Map();
  }

  // ==================== TASK ROUTING ====================

  /**
   * Register a new task's routing context.
   * @param {string} taskId
   * @param {{ toolId?: string, spaceId?: string, createdAt?: number }} [opts]
   */
  createTask(taskId, opts = {}) {
    if (!taskId) throw new Error('createTask: taskId required');
    const entry = {
      taskId,
      toolId: opts.toolId || null,
      spaceId: opts.spaceId || null,
      createdAt: typeof opts.createdAt === 'number' ? opts.createdAt : Date.now(),
    };
    this._tasks.set(taskId, entry);
    return entry;
  }

  /**
   * Update routing for an existing task (or create if missing).
   */
  updateTask(taskId, patch = {}) {
    if (!taskId) throw new Error('updateTask: taskId required');
    const existing = this._tasks.get(taskId);
    if (!existing) {
      return this.createTask(taskId, patch);
    }
    if (patch.toolId !== undefined) existing.toolId = patch.toolId;
    if (patch.spaceId !== undefined) existing.spaceId = patch.spaceId;
    if (typeof patch.createdAt === 'number') existing.createdAt = patch.createdAt;
    return existing;
  }

  getTask(taskId) {
    return this._tasks.get(taskId) || null;
  }

  getToolId(taskId) {
    const entry = this._tasks.get(taskId);
    return entry ? entry.toolId : null;
  }

  getSpaceId(taskId) {
    const entry = this._tasks.get(taskId);
    return entry ? entry.spaceId : null;
  }

  /**
   * Remove a task's routing info. Idempotent.
   */
  deleteTask(taskId) {
    return this._tasks.delete(taskId);
  }

  /**
   * List active task ids (tasks with routing entries).
   * @returns {string[]}
   */
  listActiveTaskIds() {
    return Array.from(this._tasks.keys());
  }

  activeTaskCount() {
    return this._tasks.size;
  }

  // ==================== HUD ITEMS ====================

  /**
   * Add or replace an item in a tool's HUD bucket.
   * @param {string} toolId
   * @param {Object} item - must have an `id` property
   * @returns {Object} the stored item
   */
  addItem(toolId, item) {
    if (!toolId) throw new Error('addItem: toolId required');
    if (!item || !item.id) throw new Error('addItem: item.id required');
    if (!this._hudItems.has(toolId)) {
      this._hudItems.set(toolId, new Map());
    }
    this._hudItems.get(toolId).set(item.id, item);
    return item;
  }

  getItem(toolId, itemId) {
    const bucket = this._hudItems.get(toolId);
    return bucket ? bucket.get(itemId) || null : null;
  }

  /**
   * Merge-update an item. Returns updated item or null if not found.
   */
  updateItem(toolId, itemId, patch) {
    const bucket = this._hudItems.get(toolId);
    if (!bucket) return null;
    const existing = bucket.get(itemId);
    if (!existing) return null;
    const updated = { ...existing, ...patch };
    bucket.set(itemId, updated);
    return updated;
  }

  removeItem(toolId, itemId) {
    const bucket = this._hudItems.get(toolId);
    if (!bucket) return false;
    return bucket.delete(itemId);
  }

  /**
   * All items for a tool, most-recent-first (by createdAt if present).
   */
  listItems(toolId) {
    const bucket = this._hudItems.get(toolId);
    if (!bucket) return [];
    const items = Array.from(bucket.values());
    items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return items;
  }

  clearToolItems(toolId) {
    return this._hudItems.delete(toolId);
  }

  // ==================== DISAMBIGUATION ====================

  /**
   * Store an active disambiguation state.
   * @param {string} stateId
   * @param {Object} state - { taskId, toolId, question, options, createdAt? }
   */
  createDisambiguation(stateId, state) {
    if (!stateId) throw new Error('createDisambiguation: stateId required');
    const full = {
      ...state,
      stateId,
      createdAt: typeof state.createdAt === 'number' ? state.createdAt : Date.now(),
    };
    this._disambiguations.set(stateId, full);
    return full;
  }

  getDisambiguation(stateId) {
    return this._disambiguations.get(stateId) || null;
  }

  deleteDisambiguation(stateId) {
    return this._disambiguations.delete(stateId);
  }

  listDisambiguations() {
    return Array.from(this._disambiguations.values());
  }

  // ==================== NEEDS INPUT ====================

  /**
   * Store a pending needs-input request for a task.
   * @param {string} taskId
   * @param {Object} request - { toolId, prompt, agentId, createdAt? }
   */
  setNeedsInput(taskId, request) {
    if (!taskId) throw new Error('setNeedsInput: taskId required');
    const full = {
      ...request,
      taskId,
      createdAt: typeof request.createdAt === 'number' ? request.createdAt : Date.now(),
    };
    this._needsInputs.set(taskId, full);
    return full;
  }

  getNeedsInput(taskId) {
    return this._needsInputs.get(taskId) || null;
  }

  clearNeedsInput(taskId) {
    return this._needsInputs.delete(taskId);
  }

  listNeedsInputs() {
    return Array.from(this._needsInputs.values());
  }

  // ==================== CLEANUP ====================

  /**
   * Remove stale routing, disambiguation, and needs-input entries.
   * Ports the TTL logic from lib/hud-api.js verbatim.
   *
   * @param {number} [now]
   * @returns {{ tasksRemoved: number, disambiguationsRemoved: number, needsInputsRemoved: number }}
   */
  sweep(now = Date.now()) {
    let tasksRemoved = 0;
    let disambiguationsRemoved = 0;
    let needsInputsRemoved = 0;

    for (const [taskId, entry] of this._tasks) {
      if (now - entry.createdAt > STALE_TASK_TTL_MS) {
        this._tasks.delete(taskId);
        tasksRemoved++;
      }
    }

    for (const [stateId, state] of this._disambiguations) {
      if (now - state.createdAt > STALE_STATE_TTL_MS) {
        this._disambiguations.delete(stateId);
        disambiguationsRemoved++;
      }
    }

    for (const [taskId, request] of this._needsInputs) {
      if (now - request.createdAt > STALE_STATE_TTL_MS) {
        this._needsInputs.delete(taskId);
        needsInputsRemoved++;
      }
    }

    return { tasksRemoved, disambiguationsRemoved, needsInputsRemoved };
  }

  /**
   * Reset all state. Test utility only.
   */
  clearAll() {
    this._tasks.clear();
    this._hudItems.clear();
    this._disambiguations.clear();
    this._needsInputs.clear();
  }

  /**
   * Summary counts. Cheap read for diagnostics.
   */
  stats() {
    let totalItems = 0;
    for (const bucket of this._hudItems.values()) totalItems += bucket.size;
    return {
      activeTasks: this._tasks.size,
      tools: this._hudItems.size,
      totalItems,
      disambiguations: this._disambiguations.size,
      needsInputs: this._needsInputs.size,
    };
  }
}

// ==================== SINGLETON ====================

let _instance = null;

function getTaskStore() {
  if (!_instance) _instance = new TaskStore();
  return _instance;
}

function _resetTaskStoreForTests() {
  _instance = null;
}

module.exports = {
  TaskStore,
  getTaskStore,
  _resetTaskStoreForTests,
  STALE_TASK_TTL_MS,
  STALE_STATE_TTL_MS,
};
