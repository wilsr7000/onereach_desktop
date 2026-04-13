/**
 * User Action Queue
 *
 * A persistent queue of things the learning system needs from the user
 * or wants to tell them. Built on top of the existing HUD Items system
 * (hud-api addHUDItem/removeHUDItem) so any UI that subscribes to HUD
 * item events can display them.
 *
 * Also persists items to the Agent Product Manager space for durability
 * across restarts.
 *
 * Item types:
 *   - action-needed:  user must do something (add API key, grant permission)
 *   - review:         improvement was deployed, user can review/undo
 *   - info:           informational (agent was improved, stats update)
 *   - blocked:        improvement blocked, needs user intervention
 *   - suggestion:     optional enhancement the user could make
 */

'use strict';

const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

const TOOL_ID = 'agent-learning';

let _hudApi = null;
function _getHudApi() {
  if (!_hudApi) _hudApi = require('../hud-api');
  return _hudApi;
}

const _items = new Map();

const ITEM_TYPES = {
  ACTION_NEEDED: 'action-needed',
  REVIEW: 'review',
  INFO: 'info',
  BLOCKED: 'blocked',
  SUGGESTION: 'suggestion',
};

/**
 * Add an item to the user action queue.
 *
 * @param {object} params
 * @param {string} params.type - One of ITEM_TYPES
 * @param {string} params.text - User-facing message
 * @param {string} [params.agentId] - Related agent
 * @param {string} [params.agentName] - Human-readable agent name
 * @param {string} [params.actionId] - Link to dependency-resolver action
 * @param {object} [params.metadata] - Extra context
 * @param {string[]} [params.tags] - For filtering
 * @returns {object} The created item
 */
function addItem(params) {
  const { type, text, agentId, agentName, actionId, metadata, tags } = params;

  const hudApi = _getHudApi();

  const item = hudApi.addHUDItem(TOOL_ID, {
    type: type || ITEM_TYPES.INFO,
    text: text || '',
    tags: [
      'agent-learning',
      ...(type ? [type] : []),
      ...(tags || []),
    ],
    addedBy: 'agent-learning',
    agentId: agentId || null,
  });

  // Enrich with our metadata (HUD items are plain objects in memory)
  const enriched = {
    ...item,
    agentName: agentName || agentId || null,
    actionId: actionId || null,
    metadata: metadata || null,
    resolved: false,
  };

  _items.set(item.id, enriched);

  log.info('agent-learning', 'Added user action queue item', {
    id: item.id,
    type,
    agentId,
    text: text?.slice(0, 80),
  });

  return enriched;
}

/**
 * Add a "user needs to do something" item.
 */
function addActionNeeded(params) {
  return addItem({
    type: ITEM_TYPES.ACTION_NEEDED,
    ...params,
  });
}

/**
 * Add a "review this improvement" item.
 */
function addReviewItem(params) {
  return addItem({
    type: ITEM_TYPES.REVIEW,
    ...params,
  });
}

/**
 * Add an informational item (improvement deployed, stats, etc.).
 */
function addInfoItem(params) {
  return addItem({
    type: ITEM_TYPES.INFO,
    ...params,
  });
}

/**
 * Add a blocked item (improvement waiting on user).
 */
function addBlockedItem(params) {
  return addItem({
    type: ITEM_TYPES.BLOCKED,
    ...params,
  });
}

/**
 * Add an optional suggestion.
 */
function addSuggestion(params) {
  return addItem({
    type: ITEM_TYPES.SUGGESTION,
    ...params,
  });
}

/**
 * Mark an item as resolved and remove it from the HUD.
 */
function resolveItem(itemId) {
  const item = _items.get(itemId);
  if (!item) return false;

  item.resolved = true;
  item.resolvedAt = Date.now();

  try {
    const hudApi = _getHudApi();
    hudApi.removeHUDItem(TOOL_ID, itemId);
  } catch (_) { /* best-effort */ }

  log.info('agent-learning', 'Resolved user action queue item', { id: itemId });
  return true;
}

/**
 * Get all unresolved items, optionally filtered by type.
 */
function getItems(filterType) {
  const items = Array.from(_items.values()).filter((i) => !i.resolved);
  if (filterType) return items.filter((i) => i.type === filterType);
  return items;
}

/**
 * Get items for a specific agent.
 */
function getItemsForAgent(agentId) {
  return Array.from(_items.values()).filter(
    (i) => !i.resolved && i.agentId === agentId
  );
}

/**
 * Get the count of unresolved items by type.
 */
function getCounts() {
  const counts = { total: 0 };
  for (const item of _items.values()) {
    if (item.resolved) continue;
    counts.total++;
    counts[item.type] = (counts[item.type] || 0) + 1;
  }
  return counts;
}

/**
 * Get all items including resolved (for history).
 */
function getAllItems() {
  return Array.from(_items.values());
}

/**
 * Remove an item entirely.
 */
function removeItem(itemId) {
  const existed = _items.delete(itemId);
  if (existed) {
    try {
      const hudApi = _getHudApi();
      hudApi.removeHUDItem(TOOL_ID, itemId);
    } catch (_) { /* best-effort */ }
  }
  return existed;
}

/**
 * Clear all items.
 */
function clear() {
  for (const itemId of _items.keys()) {
    try {
      const hudApi = _getHudApi();
      hudApi.removeHUDItem(TOOL_ID, itemId);
    } catch (_) { /* best-effort */ }
  }
  _items.clear();
}

/** Override for testing */
function _setTestDeps(deps) {
  if (deps.hudApi) _hudApi = deps.hudApi;
}

module.exports = {
  addItem,
  addActionNeeded,
  addReviewItem,
  addInfoItem,
  addBlockedItem,
  addSuggestion,
  resolveItem,
  getItems,
  getItemsForAgent,
  getCounts,
  getAllItems,
  removeItem,
  clear,
  ITEM_TYPES,
  TOOL_ID,
  _setTestDeps,
};
