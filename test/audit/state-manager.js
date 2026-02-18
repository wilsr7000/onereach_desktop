'use strict';

const fs = require('fs');
const path = require('path');
const { _parseAllPlans } = require('./plan-parser');

const STATE_DIR = path.join(__dirname, 'state');
const STATE_FILE = path.join(STATE_DIR, 'audit-state.json');
const STATE_TMP = STATE_FILE + '.tmp';

const VALID_STATUSES = ['untested', 'pending', 'passed', 'failed', 'skipped', 'blocked'];

/**
 * Manages persistent test audit state.
 * Survives across sessions, supports resumability and regression tracking.
 */
class StateManager {
  constructor() {
    this._state = null;
    this._items = []; // parsed plan items (read-only reference)
  }

  /**
   * Initialize: load existing state or create fresh from parsed plans.
   * @param {Array} parsedItems - Items from plan-parser.parseAllPlans()
   */
  init(parsedItems) {
    this._items = parsedItems;
    this._ensureDir();

    if (fs.existsSync(STATE_FILE)) {
      this._state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      // Reconcile: add any new items from plans that aren't in state yet
      this._reconcile(parsedItems);
    } else {
      this._state = this._createFresh(parsedItems);
      this.save();
    }
  }

  /**
   * Create a fresh state object from parsed items.
   */
  _createFresh(parsedItems) {
    const now = new Date().toISOString();
    const items = {};
    for (const item of parsedItems) {
      items[item.id] = {
        status: 'untested',
        type: item.type,
        planNumber: item.planNumber,
        section: item.section,
        description: item.description,
        lastRunAt: null,
        runs: [],
      };
    }

    return {
      version: 1,
      createdAt: now,
      lastUpdated: now,
      appVersion: this._getAppVersion(),
      cursor: {
        planNumber: parsedItems.length > 0 ? parsedItems[0].planNumber : 1,
        itemIndex: 0,
        itemId: parsedItems.length > 0 ? parsedItems[0].id : null,
      },
      items,
      regressionRuns: [],
      summary: this._computeSummary(items),
    };
  }

  /**
   * Reconcile state with parsed items: add new items, remove stale ones.
   */
  _reconcile(parsedItems) {
    const itemIds = new Set(parsedItems.map((i) => i.id));
    const stateIds = new Set(Object.keys(this._state.items));

    // Add new items not in state
    for (const item of parsedItems) {
      if (!stateIds.has(item.id)) {
        this._state.items[item.id] = {
          status: 'untested',
          type: item.type,
          planNumber: item.planNumber,
          section: item.section,
          description: item.description,
          lastRunAt: null,
          runs: [],
        };
      }
    }

    // Mark removed items (don't delete -- keep audit history)
    for (const id of stateIds) {
      if (!itemIds.has(id) && !this._state.items[id]._removed) {
        this._state.items[id]._removed = true;
      }
    }

    this._state.summary = this._computeSummary(this._state.items);
  }

  /**
   * Save state atomically: write to .tmp, then rename.
   */
  save() {
    this._state.lastUpdated = new Date().toISOString();
    this._state.summary = this._computeSummary(this._state.items);

    const json = JSON.stringify(this._state, null, 2);
    fs.writeFileSync(STATE_TMP, json, 'utf-8');
    fs.renameSync(STATE_TMP, STATE_FILE);
  }

  /**
   * Get the full state object (read-only snapshot).
   */
  getState() {
    return this._state;
  }

  /**
   * Get a single item's state by ID.
   */
  getItem(id) {
    return this._state.items[id] || null;
  }

  /**
   * Record a test result for an item.
   * @param {string} id - Item ID
   * @param {string} status - 'passed' | 'failed' | 'skipped' | 'blocked'
   * @param {Object} details - { durationMs, notes, error, logCorrelationId }
   */
  recordResult(id, status, details = {}) {
    if (!VALID_STATUSES.includes(status)) {
      throw new Error(`Invalid status: ${status}. Must be one of: ${VALID_STATUSES.join(', ')}`);
    }

    const item = this._state.items[id];
    if (!item) {
      throw new Error(`Unknown item ID: ${id}`);
    }

    const now = new Date().toISOString();
    const run = {
      timestamp: now,
      status,
      durationMs: details.durationMs || 0,
      notes: details.notes || '',
      error: details.error || null,
      logCorrelationId: details.logCorrelationId || null,
    };

    item.runs.push(run);
    item.status = status;
    item.lastRunAt = now;

    this.save();
    return run;
  }

  /**
   * Get/set the cursor (bookmark position).
   */
  getCursor() {
    return this._state.cursor;
  }

  setCursor(planNumber, itemIndex, itemId) {
    this._state.cursor = { planNumber, itemIndex, itemId };
    // Don't save here -- caller saves after test
  }

  /**
   * Find the next untested item (in plan order).
   * @returns {Object|null} - The parsed item + state, or null if all tested.
   */
  getNextUntested() {
    for (const item of this._items) {
      const state = this._state.items[item.id];
      if (state && state.status === 'untested') {
        return { ...item, state };
      }
    }
    return null;
  }

  /**
   * Get all items with a given status.
   */
  getItemsByStatus(status) {
    return this._items
      .filter((item) => {
        const s = this._state.items[item.id];
        return s && s.status === status;
      })
      .map((item) => ({ ...item, state: this._state.items[item.id] }));
  }

  /**
   * Get all passed items (for regression testing).
   */
  getPassedItems() {
    return this.getItemsByStatus('passed');
  }

  /**
   * Get all failed items (for re-testing).
   */
  getFailedItems() {
    return this.getItemsByStatus('failed');
  }

  /**
   * Get items for a specific plan.
   */
  getPlanItems(planNumber) {
    return this._items
      .filter((item) => item.planNumber === planNumber)
      .map((item) => ({ ...item, state: this._state.items[item.id] }));
  }

  /**
   * Record a regression run result.
   */
  addRegressionRun(runData) {
    this._state.regressionRuns.push(runData);
    this.save();
  }

  /**
   * Get computed summary.
   */
  getSummary() {
    return this._state.summary;
  }

  /**
   * Reset all state. Requires explicit confirmation.
   */
  reset(confirm = false) {
    if (!confirm) {
      throw new Error('Reset requires explicit confirmation. Call reset(true).');
    }
    this._state = this._createFresh(this._items);
    this.save();
  }

  /**
   * Compute summary from items map.
   */
  _computeSummary(items) {
    const summary = {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      blocked: 0,
      untested: 0,
      pending: 0,
      percentComplete: 0,
    };

    for (const [item] of Object.entries(items)) {
      if (item._removed) continue;
      summary.total++;
      if (summary[item.status] !== undefined) {
        summary[item.status]++;
      }
    }

    const tested = summary.passed + summary.failed;
    summary.percentComplete = summary.total > 0 ? Math.round((tested / summary.total) * 1000) / 10 : 0;

    return summary;
  }

  /**
   * Read app version from package.json.
   */
  _getAppVersion() {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8'));
      return pkg.version || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Ensure state directory exists.
   */
  _ensureDir() {
    if (!fs.existsSync(STATE_DIR)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    }
  }
}

module.exports = { StateManager };
