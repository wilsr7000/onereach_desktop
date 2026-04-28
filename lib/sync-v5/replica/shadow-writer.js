/**
 * Shadow-writer: mirror every successful spaces-api write to the
 * materialised SQLite replica.
 *
 * Per docs/sync-v5/replica-shape.md §5.1 (commit C in the A->F
 * cutover ladder). The replica needs to track every change made
 * through the primary path so commit D's shadow-read has something
 * to compare against, and so commit E's cutover lands on a replica
 * that's already up-to-date.
 *
 * Architectural choice: subscribe to spaces-api's existing event
 * surface (`SpacesAPI.on(event, callback)` -> unsubscribe fn) rather
 * than instrumenting each write method. Reasons:
 *   - Zero modification to spaces-api.js -- decouples the cutover
 *     work from the write-path code.
 *   - Symmetry with the existing event listeners (UI live-update,
 *     broadcast handler) -- the replica is "just another listener".
 *   - Single attach/detach point makes feature-flag flipping easy.
 *
 * Events handled (15):
 *   space:created           -> replica.upsertSpace (vc bumped)
 *   space:updated           -> read existing + merge data + upsertSpace
 *   space:deleted           -> replica.softDeleteSpace
 *   item:added              -> replica.upsertItem (vc bumped)
 *   item:updated            -> read existing + merge data + upsertItem
 *   item:deleted            -> replica.softDeleteItem
 *   items:bulk-deleted      -> per id soft-delete
 *   item:moved              -> replica.moveItem
 *   items:bulk-moved        -> per id moveItem
 *   item:tags:updated       -> read existing + replace tags + upsertItem
 *   tags:renamed            -> sweep items in space, replace oldTag with newTag
 *   tags:deleted            -> sweep items in space, drop tag
 *   smartFolder:created     -> replica.upsertSmartFolder
 *   smartFolder:updated     -> read existing + merge updates + upsertSmartFolder
 *   smartFolder:deleted     -> replica.deleteSmartFolder
 *
 * Failure isolation: every handler is wrapped in try/catch. A throw
 * inside a handler increments the per-event error counter and logs;
 * it does NOT propagate back into spaces-api's _emit caller (which
 * has its own try/catch around listener invocation, but defense-in-
 * depth is cheap here). The primary write has already succeeded; the
 * replica falling behind is a divergence to alarm on, not a reason
 * to crash the app.
 *
 * VC semantics: the writer's host device is the only writer in shadow-
 * write phase (commit C); pulls from other devices land in commit D.
 * Therefore every shadow-write bumps the row's `vc[deviceId]` by 1.
 * Multi-device causality kicks in only when the pull engine starts
 * applying remote ops.
 *
 * Diagnostics: returns an `inspect()`-able handle so /sync/queue.
 * replica.shadowWriter can surface counters (writes, errors, last-
 * write timestamp). attachShadowWriter() returns a detach() function
 * that unsubscribes every listener; main.js boot wiring calls this
 * on a paused replica or during an orderly shutdown.
 */

'use strict';

const { getLogQueue } = require('../../log-event-queue');
const _logQueueDefault = (() => {
  try { return getLogQueue(); } catch (_e) { return null; }
})();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Attach the shadow-writer to a SpacesAPI instance and a Replica.
 *
 * @param {object} args
 * @param {object} args.spacesApi -- SpacesAPI instance (must expose
 *   `.on(event, callback)` returning an unsubscribe fn).
 * @param {object} args.replica  -- Initialised Replica instance.
 * @param {string} args.deviceId -- The local device's stable ID.
 * @param {object} [args.logger] -- { info, warn, error, debug }.
 * @returns {ShadowWriterHandle} { detach(), inspect(), counters }
 *
 * @typedef {object} ShadowWriterHandle
 * @property {() => void} detach -- unsubscribes every listener; idempotent
 * @property {() => object} inspect -- returns a snapshot of counters + state
 * @property {object} counters -- live counters (mutate via the writer; do
 *   not read this directly in production code; use inspect() instead)
 */
function attachShadowWriter({ spacesApi, replica, deviceId, logger } = {}) {
  if (!spacesApi || typeof spacesApi.on !== 'function') {
    throw new Error('attachShadowWriter: spacesApi with .on() is required');
  }
  if (!replica) throw new Error('attachShadowWriter: replica is required');
  if (!deviceId) throw new Error('attachShadowWriter: deviceId is required');

  const log = logger || _logQueueDefault || _silentLogger();

  // Counters: per-event writes + errors + a global lastWriteAt timestamp.
  // Plain object so tests can read it; production code should call
  // inspect() (which returns a snapshot, not a live reference).
  const counters = {
    attachedAt: new Date().toISOString(),
    detachedAt: null,
    lastWriteAt: null,
    lastWriteEvent: null,
    lastError: null,
    writes: 0,
    errors: 0,
    perEvent: Object.create(null),
  };

  /**
   * Wrap a handler so its throws become counter increments + log
   * lines, never propagated. The first argument is the event name
   * (used for counters); the second is the actual handler.
   */
  function safe(eventName, handler) {
    if (!counters.perEvent[eventName]) {
      counters.perEvent[eventName] = { writes: 0, errors: 0, lastError: null };
    }
    return (payload) => {
      try {
        handler(payload);
        counters.writes++;
        counters.perEvent[eventName].writes++;
        counters.lastWriteAt = new Date().toISOString();
        counters.lastWriteEvent = eventName;
      } catch (err) {
        counters.errors++;
        counters.lastError = { event: eventName, message: err.message };
        counters.perEvent[eventName].errors++;
        counters.perEvent[eventName].lastError = err.message;
        log.warn('replica/shadow-writer', `${eventName} handler failed`, {
          error: err.message,
          payload: _safePreview(payload),
        });
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Per-event handlers
  // ---------------------------------------------------------------------------

  // ── Spaces ──
  const onSpaceCreated = safe('space:created', (payload) => {
    const sp = payload && payload.space;
    if (!sp || !sp.id) return;
    const existingVc = replica.getSpaceVc(sp.id);
    replica.upsertSpace({
      ...sp,
      vc: replica.bumpVc(existingVc, deviceId),
      active: true,
    });
  });

  const onSpaceUpdated = safe('space:updated', (payload) => {
    const { spaceId, data } = payload || {};
    if (!spaceId) return;
    const existing = replica.getSpace(spaceId);
    if (!existing) {
      // Replica missing the row spaces-api just updated -- divergence.
      // Synthesise a minimal upsert so the replica catches up; further
      // divergence handling happens in commit D's shadow-read pass.
      replica.upsertSpace({
        id: spaceId,
        name: (data && data.name) || spaceId,
        ...data,
        vc: replica.bumpVc(null, deviceId),
        active: true,
      });
      return;
    }
    replica.upsertSpace({
      ...existing,
      ...data,
      id: spaceId,
      vc: replica.bumpVc(existing.vc, deviceId),
      active: true,
    });
  });

  const onSpaceDeleted = safe('space:deleted', (payload) => {
    const { spaceId } = payload || {};
    if (!spaceId) return;
    replica.softDeleteSpace({
      spaceId,
      deletedBy: deviceId,
    });
  });

  // ── Items ──
  const onItemAdded = safe('item:added', (payload) => {
    const { spaceId, item } = payload || {};
    if (!item || !item.id) return;
    const existingVc = replica.getItemVc(item.id);
    replica.upsertItem({
      ...item,
      space_id: item.space_id || item.spaceId || spaceId || 'unclassified',
      vc: replica.bumpVc(existingVc, deviceId),
      active: true,
    });
  });

  const onItemUpdated = safe('item:updated', (payload) => {
    const { spaceId, itemId, data } = payload || {};
    if (!itemId) return;
    const existing = replica.getItem(itemId);
    if (!existing) {
      // Divergence; synthesise a minimal write so the replica catches
      // up on the row that exists in spaces-api. Tags in `data` (if
      // any) will pass through normaliseItemRow.
      replica.upsertItem({
        id: itemId,
        type: (data && data.type) || 'unknown',
        space_id: spaceId || 'unclassified',
        ...data,
        vc: replica.bumpVc(null, deviceId),
        active: true,
      });
      return;
    }
    replica.upsertItem({
      ...existing,
      ...data,
      id: itemId,
      space_id: existing.space_id, // preserve unless explicitly moved
      vc: replica.bumpVc(existing.vc, deviceId),
      active: true,
    });
  });

  const onItemDeleted = safe('item:deleted', (payload) => {
    const { itemId } = payload || {};
    if (!itemId) return;
    replica.softDeleteItem({ itemId, deletedBy: deviceId });
  });

  const onItemsBulkDeleted = safe('items:bulk-deleted', (payload) => {
    const { itemIds } = payload || {};
    if (!Array.isArray(itemIds)) return;
    for (const id of itemIds) {
      try {
        replica.softDeleteItem({ itemId: id, deletedBy: deviceId });
      } catch (err) {
        // Per-id failure is logged but doesn't abort the bulk;
        // counter still increments at the event level via safe().
        log.warn('replica/shadow-writer', 'bulk-delete: per-id failed', {
          itemId: id, error: err.message,
        });
      }
    }
  });

  const onItemMoved = safe('item:moved', (payload) => {
    const { itemId, toSpaceId } = payload || {};
    if (!itemId || !toSpaceId) return;
    const moved = replica.moveItem({ itemId, toSpaceId });
    if (!moved) {
      // Replica didn't have the item -- divergence. Insert a
      // minimal row so the replica reflects the move; the shadow-
      // read pass (commit D) will surface the divergence.
      replica.upsertItem({
        id: itemId,
        type: 'unknown',
        space_id: toSpaceId,
        vc: replica.bumpVc(null, deviceId),
        active: true,
      });
    }
  });

  const onItemsBulkMoved = safe('items:bulk-moved', (payload) => {
    const { itemIds, toSpaceId } = payload || {};
    if (!Array.isArray(itemIds) || !toSpaceId) return;
    for (const id of itemIds) {
      try {
        const moved = replica.moveItem({ itemId: id, toSpaceId });
        if (!moved) {
          replica.upsertItem({
            id, type: 'unknown', space_id: toSpaceId,
            vc: replica.bumpVc(null, deviceId), active: true,
          });
        }
      } catch (err) {
        log.warn('replica/shadow-writer', 'bulk-move: per-id failed', {
          itemId: id, error: err.message,
        });
      }
    }
  });

  // ── Tags ──
  const onItemTagsUpdated = safe('item:tags:updated', (payload) => {
    const { itemId, tags } = payload || {};
    if (!itemId) return;
    const existing = replica.getItem(itemId);
    if (!existing) {
      // Divergence: spaces-api updated tags on an item the replica
      // doesn't know about. Synthesise.
      replica.upsertItem({
        id: itemId,
        type: 'unknown',
        space_id: payload.spaceId || 'unclassified',
        tags: Array.isArray(tags) ? tags : [],
        vc: replica.bumpVc(null, deviceId),
        active: true,
      });
      return;
    }
    replica.upsertItem({
      ...existing,
      id: itemId,
      tags: Array.isArray(tags) ? tags : [],
      vc: replica.bumpVc(existing.vc, deviceId),
      active: true,
    });
  });

  const onTagsRenamed = safe('tags:renamed', (payload) => {
    const { spaceId, oldTag, newTag } = payload || {};
    if (!spaceId || !oldTag || !newTag) return;
    const rows = replica._stmts.listItemsForTagSweep.all(replica.tenantId, spaceId);
    for (const r of rows) {
      const tags = _parseTagsArray(r.tags);
      if (tags.indexOf(oldTag) === -1) continue;
      const renamed = tags.map((t) => (t === oldTag ? newTag : t));
      // Dedupe in case the new tag was already present.
      const deduped = Array.from(new Set(renamed));
      try {
        replica.upsertItem({
          id: r.id,
          // upsertItem requires type; we only have what's in the row.
          // Fetch full to preserve other fields.
          ..._fetchFullItem(replica, r.id),
          tags: deduped,
          vc: replica.bumpVc(r.vc, deviceId),
        });
      } catch (err) {
        log.warn('replica/shadow-writer', 'tags:renamed sweep failed for item', {
          itemId: r.id, error: err.message,
        });
      }
    }
  });

  const onTagsDeleted = safe('tags:deleted', (payload) => {
    const { spaceId, tag } = payload || {};
    if (!spaceId || !tag) return;
    const rows = replica._stmts.listItemsForTagSweep.all(replica.tenantId, spaceId);
    for (const r of rows) {
      const tags = _parseTagsArray(r.tags);
      if (tags.indexOf(tag) === -1) continue;
      const stripped = tags.filter((t) => t !== tag);
      try {
        replica.upsertItem({
          id: r.id,
          ..._fetchFullItem(replica, r.id),
          tags: stripped,
          vc: replica.bumpVc(r.vc, deviceId),
        });
      } catch (err) {
        log.warn('replica/shadow-writer', 'tags:deleted sweep failed for item', {
          itemId: r.id, error: err.message,
        });
      }
    }
  });

  // ── Smart folders ──
  const onSmartFolderCreated = safe('smartFolder:created', (payload) => {
    const { folder } = payload || {};
    if (!folder || !folder.id) return;
    replica.upsertSmartFolder(folder);
  });

  const onSmartFolderUpdated = safe('smartFolder:updated', (payload) => {
    const { folderId, updates } = payload || {};
    if (!folderId) return;
    const existing = replica.getSmartFolder(folderId);
    if (!existing) {
      // Divergence; synthesise. Caller didn't include name/criteria,
      // so we have to pick safe defaults.
      replica.upsertSmartFolder({
        id: folderId,
        name: (updates && updates.name) || folderId,
        criteria: (updates && updates.criteria) || {},
        ...updates,
      });
      return;
    }
    replica.upsertSmartFolder({
      ...existing,
      ...updates,
      id: folderId,
    });
  });

  const onSmartFolderDeleted = safe('smartFolder:deleted', (payload) => {
    const { folderId } = payload || {};
    if (!folderId) return;
    replica.deleteSmartFolder(folderId);
  });

  // ---------------------------------------------------------------------------
  // Subscribe + return handle
  // ---------------------------------------------------------------------------

  const unsubs = [
    spacesApi.on('space:created', onSpaceCreated),
    spacesApi.on('space:updated', onSpaceUpdated),
    spacesApi.on('space:deleted', onSpaceDeleted),
    spacesApi.on('item:added', onItemAdded),
    spacesApi.on('item:updated', onItemUpdated),
    spacesApi.on('item:deleted', onItemDeleted),
    spacesApi.on('items:bulk-deleted', onItemsBulkDeleted),
    spacesApi.on('item:moved', onItemMoved),
    spacesApi.on('items:bulk-moved', onItemsBulkMoved),
    spacesApi.on('item:tags:updated', onItemTagsUpdated),
    spacesApi.on('tags:renamed', onTagsRenamed),
    spacesApi.on('tags:deleted', onTagsDeleted),
    spacesApi.on('smartFolder:created', onSmartFolderCreated),
    spacesApi.on('smartFolder:updated', onSmartFolderUpdated),
    spacesApi.on('smartFolder:deleted', onSmartFolderDeleted),
  ];

  let detached = false;
  function detach() {
    if (detached) return;
    detached = true;
    counters.detachedAt = new Date().toISOString();
    for (const u of unsubs) {
      try { if (typeof u === 'function') u(); } catch (_err) { /* swallow */ }
    }
    log.info('replica/shadow-writer', 'detached', {
      writes: counters.writes, errors: counters.errors,
    });
  }

  function inspect() {
    return {
      attachedAt: counters.attachedAt,
      detachedAt: counters.detachedAt,
      lastWriteAt: counters.lastWriteAt,
      lastWriteEvent: counters.lastWriteEvent,
      lastError: counters.lastError,
      writes: counters.writes,
      errors: counters.errors,
      perEvent: _shallowClone(counters.perEvent),
      // Useful for the operator to confirm the writer is bound
      // to the right entities.
      replica: {
        dbPath: replica.dbPath,
        tenantId: replica.tenantId,
        deviceId: replica.deviceId,
      },
      eventsHandled: 15,
    };
  }

  log.info('replica/shadow-writer', 'attached', {
    deviceId, tenantId: replica.tenantId, eventsHandled: unsubs.length,
  });

  return { detach, inspect, counters };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function _parseTagsArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_err) {
    return [];
  }
}

/**
 * Fetch the full hydrated item row from the replica for the
 * tags-sweep paths (which need to preserve all other fields when
 * upserting with a new tags array). Returns an empty object on
 * miss; the caller's spread merges to a no-op.
 */
function _fetchFullItem(replica, itemId) {
  try {
    const it = replica.getItem(itemId);
    return it || {};
  } catch (_err) {
    return {};
  }
}

function _shallowClone(obj) {
  const out = Object.create(null);
  for (const k of Object.keys(obj)) {
    out[k] = { ...obj[k] };
  }
  return out;
}

function _safePreview(payload) {
  try {
    const s = JSON.stringify(payload);
    return s.length > 400 ? s.slice(0, 400) + '...[truncated]' : s;
  } catch (_err) {
    return '<unserialisable>';
  }
}

function _silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  attachShadowWriter,
  // Pure helpers exported for testing
  _parseTagsArray,
};
