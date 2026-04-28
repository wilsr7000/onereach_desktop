/**
 * Shadow-reader: subscribe to spaces-api read events, query the
 * replica with the same args, compare results, log divergences, and
 * tick the validation gate's counters.
 *
 * Per docs/sync-v5/replica-shape.md §5.1 (commit D in the A->F
 * cutover ladder). This is the systematic divergence detection
 * that gates the read-path flip in commit E. Every primary read
 * (spaces-api items.list / item.fetched / tags.findItems /
 * smartFolders.list / search) is observed; the shadow-reader runs
 * the corresponding replica query, compares, and increments the
 * §6.6 gate counters.
 *
 * Architectural choice (mirrors commit C):
 *   - Subscribe to spaces-api's existing `.on(event, callback)`
 *     event surface. spaces-api gets ~5 _emit calls added at the
 *     tails of read methods (additive only; older callers ignore
 *     the new events).
 *   - Zero monkey-patching, decoupled lifecycle, single attach
 *     point (main.js boot wiring).
 *
 * Read events handled:
 *   items:listed         -> replica.listItemsBySpace, set-by-id diff
 *   item:fetched         -> replica.getItem, field-whitelist diff
 *   items:findByTags     -> replica.findItemsByTags, set-by-id diff
 *   smartFolders:listed  -> replica.listSmartFolders, set-by-id diff
 *   search:completed     -> count-only (no comparison in commit D;
 *                           ships when FTS5 is wired)
 *
 * Performance: every event ticks the gate's invocation counter, but
 * the deep comparison only runs on a deterministic sample of HOT-
 * path events (items:listed, item:fetched). Cold-path events
 * (findByTags, smartFolders:listed, search) compare 100%. Sampling
 * is via hash(event + args) % `sampleRate`, so identical args
 * produce identical sample decisions across runs.
 *
 * Failure isolation: comparison errors increment per-event error
 * counters but never propagate. Divergence comparison runs on a
 * setImmediate AFTER the primary result was returned to the caller,
 * so even a slow replica query never adds user-visible latency.
 *
 * Diagnostics: returns an inspect()-able handle with per-event
 * counters, last divergence summary, sample rate, and validation
 * gate snapshot.
 */

'use strict';

const { getLogQueue } = require('../../log-event-queue');
const _logQueueDefault = (() => {
  try { return getLogQueue(); } catch (_e) { return null; }
})();

// ---------------------------------------------------------------------------
// Field whitelist for item field-equivalence diffs.
// Volatile fields (timestamps, scoring, hash internals, replica-only
// columns) are excluded because they can legitimately differ between
// the primary path's view and the replica's view without indicating
// a sync problem.
// ---------------------------------------------------------------------------

const ITEM_FIELD_WHITELIST = Object.freeze([
  'id', 'type', 'space_id', 'preview', 'pinned', 'active',
  'file_name', 'file_size', 'file_type', 'is_screenshot',
  'source', 'metadata_source',
]);

const SMARTFOLDER_FIELD_WHITELIST = Object.freeze([
  'id', 'name', 'icon', 'color',
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Attach the shadow-reader to a SpacesAPI instance + Replica +
 * ValidationGate.
 *
 * @param {object} args
 * @param {object} args.spacesApi -- SpacesAPI with .on() event surface.
 * @param {object} args.replica  -- Initialised Replica.
 * @param {object} args.gate     -- Initialised ValidationGate.
 * @param {number} [args.hotPathSampleRate=10] -- 1-in-N sampling on
 *   items:listed and item:fetched. Set to 1 to compare every call.
 *   Cold-path events always compare.
 * @param {object} [args.logger]
 * @returns {ShadowReaderHandle} { detach(), inspect() }
 */
function attachShadowReader({ spacesApi, replica, gate, hotPathSampleRate = 10, logger } = {}) {
  if (!spacesApi || typeof spacesApi.on !== 'function') {
    throw new Error('attachShadowReader: spacesApi with .on() is required');
  }
  if (!replica) throw new Error('attachShadowReader: replica is required');
  if (!gate) throw new Error('attachShadowReader: gate is required');

  const log = logger || _logQueueDefault || _silentLogger();
  const sampleRate = Math.max(1, Math.floor(hotPathSampleRate));

  const counters = {
    attachedAt: new Date().toISOString(),
    detachedAt: null,
    sampleRate,
    perEvent: Object.create(null),
    lastDivergence: null,
  };

  function bumpCounter(event, field) {
    if (!counters.perEvent[event]) {
      counters.perEvent[event] = {
        invocations: 0,
        sampledComparisons: 0,
        divergences: 0,
        errors: 0,
      };
    }
    counters.perEvent[event][field]++;
  }

  /**
   * Wrap an event handler so its work runs on a setImmediate AFTER
   * the spaces-api caller has already received the primary result.
   * Failures inside increment per-event error counters; nothing
   * propagates back into spaces-api's _emit chain.
   */
  function deferred(eventName, handler) {
    return (payload) => {
      bumpCounter(eventName, 'invocations');
      setImmediate(() => {
        try {
          handler(payload);
        } catch (err) {
          bumpCounter(eventName, 'errors');
          log.warn('replica/shadow-reader', `${eventName} comparison failed`, {
            error: err.message,
            payload: _safePreview(payload),
          });
        }
      });
    };
  }

  /**
   * Deterministic 1-in-N sampler based on a 32-bit FNV-1a hash of
   * the JSON-stringified args. Same args always sample to the same
   * decision, so divergence reports are reproducible.
   */
  function shouldSample(eventName, args) {
    if (sampleRate === 1) return true;
    const key = eventName + '|' + _safeStringify(args);
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h = h >>> 0;
    return (h % sampleRate) === 0;
  }

  function recordDivergence(eventName, summary) {
    bumpCounter(eventName, 'divergences');
    counters.lastDivergence = {
      event: eventName,
      at: new Date().toISOString(),
      ...summary,
    };
    gate.recordDivergence(_eventToGateMethod(eventName));
    log.warn('replica/shadow-reader', `${eventName} divergence`, summary);
  }

  // ---------------------------------------------------------------------------
  // Per-event handlers
  // ---------------------------------------------------------------------------

  // ── items:listed -- hot path; sampled comparison ──
  const onItemsListed = deferred('items:listed', (payload) => {
    const { spaceId, options = {}, items } = payload || {};
    if (!spaceId || !Array.isArray(items)) return;

    // Tick the gate counter on EVERY invocation (gate counts
    // invocations regardless of sample).
    gate.recordInvocation('itemsList');

    if (!shouldSample('items:listed', { spaceId, options })) return;
    bumpCounter('items:listed', 'sampledComparisons');

    const replicaItems = replica.listItemsBySpace(spaceId, options);
    const cmp = compareById(items, replicaItems);
    if (!cmp.equivalent) {
      recordDivergence('items:listed', {
        spaceId,
        options: _safePreview(options),
        primaryCount: items.length,
        replicaCount: replicaItems.length,
        onlyInPrimary: cmp.onlyInPrimary.slice(0, 10),
        onlyInReplica: cmp.onlyInReplica.slice(0, 10),
      });
    }
  });

  // ── item:fetched -- hot path; sampled field-whitelist comparison ──
  const onItemFetched = deferred('item:fetched', (payload) => {
    const { itemId, item } = payload || {};
    if (!itemId) return;

    gate.recordInvocation('itemsGet');

    if (!shouldSample('item:fetched', { itemId })) return;
    bumpCounter('item:fetched', 'sampledComparisons');

    const replicaItem = replica.getItem(itemId);
    const cmp = compareItemFields(item, replicaItem, ITEM_FIELD_WHITELIST);
    if (!cmp.equivalent) {
      recordDivergence('item:fetched', {
        itemId,
        reason: cmp.reason,
        differences: cmp.differences,
      });
    }
  });

  // ── items:findByTags -- cold path; always compare ──
  const onItemsFindByTags = deferred('items:findByTags', (payload) => {
    const { tags, options = {}, items } = payload || {};
    if (!Array.isArray(tags) || !Array.isArray(items)) return;

    bumpCounter('items:findByTags', 'sampledComparisons');

    const replicaItems = replica.findItemsByTags(tags, options);
    const cmp = compareById(items, replicaItems);
    if (!cmp.equivalent) {
      recordDivergence('items:findByTags', {
        tags, options: _safePreview(options),
        primaryCount: items.length,
        replicaCount: replicaItems.length,
        onlyInPrimary: cmp.onlyInPrimary.slice(0, 10),
        onlyInReplica: cmp.onlyInReplica.slice(0, 10),
      });
    }
  });

  // ── smartFolders:listed -- cold path; always compare; gate counter ──
  const onSmartFoldersListed = deferred('smartFolders:listed', (payload) => {
    const { folders } = payload || {};
    if (!Array.isArray(folders)) return;

    gate.recordInvocation('smartFoldersList');
    bumpCounter('smartFolders:listed', 'sampledComparisons');

    const replicaFolders = replica.listSmartFolders();
    const cmp = compareById(folders, replicaFolders);
    if (!cmp.equivalent) {
      recordDivergence('smartFolders:listed', {
        primaryCount: folders.length,
        replicaCount: replicaFolders.length,
        onlyInPrimary: cmp.onlyInPrimary.slice(0, 10),
        onlyInReplica: cmp.onlyInReplica.slice(0, 10),
      });
    }
  });

  // ── search:completed -- count-only in commit D ──
  // The replica's commit-A schema has FTS5 declared but query
  // wiring + items_fts triggers ship in a follow-up commit.
  // Counting search invocations toward the §6.6 gate is correct
  // (the gate counts invocations, not equivalences); the comparison
  // ships once FTS5 query parity is real.
  const onSearchCompleted = deferred('search:completed', (_payload) => {
    gate.recordInvocation('search');
    // Comparison deliberately omitted in commit D.
  });

  // ---------------------------------------------------------------------------
  // Subscribe + return handle
  // ---------------------------------------------------------------------------

  const unsubs = [
    spacesApi.on('items:listed', onItemsListed),
    spacesApi.on('item:fetched', onItemFetched),
    spacesApi.on('items:findByTags', onItemsFindByTags),
    spacesApi.on('smartFolders:listed', onSmartFoldersListed),
    spacesApi.on('search:completed', onSearchCompleted),
  ];

  let detached = false;
  function detach() {
    if (detached) return;
    detached = true;
    counters.detachedAt = new Date().toISOString();
    for (const u of unsubs) {
      try { if (typeof u === 'function') u(); } catch (_err) { /* swallow */ }
    }
    log.info('replica/shadow-reader', 'detached', {
      perEvent: counters.perEvent,
    });
  }

  function inspect() {
    return {
      attachedAt: counters.attachedAt,
      detachedAt: counters.detachedAt,
      sampleRate: counters.sampleRate,
      lastDivergence: counters.lastDivergence,
      perEvent: _shallowCloneMap(counters.perEvent),
      eventsHandled: 5,
      gate: gate.evaluate(),
    };
  }

  log.info('replica/shadow-reader', 'attached', {
    sampleRate, eventsHandled: unsubs.length,
  });

  return { detach, inspect, counters };
}

// ---------------------------------------------------------------------------
// Comparison helpers (pure functions)
// ---------------------------------------------------------------------------

/**
 * Set-by-id comparison. Returns equivalent=true iff both arrays
 * contain the same set of entity ids (regardless of order). When
 * not equivalent, returns the per-side diff (truncated by caller).
 *
 * @param {Array<{id:string}>} primary
 * @param {Array<{id:string}>} replica
 */
function compareById(primary, replica) {
  const p = new Set();
  const r = new Set();
  for (const it of primary) if (it && it.id) p.add(String(it.id));
  for (const it of replica) if (it && it.id) r.add(String(it.id));
  const onlyInPrimary = [];
  const onlyInReplica = [];
  for (const id of p) if (!r.has(id)) onlyInPrimary.push(id);
  for (const id of r) if (!p.has(id)) onlyInReplica.push(id);
  return {
    equivalent: onlyInPrimary.length === 0 && onlyInReplica.length === 0,
    onlyInPrimary,
    onlyInReplica,
  };
}

/**
 * Field-whitelist comparison for a single item. Mismatches on
 * volatile fields (timestamps, _search, hash internals) don't
 * register; only mismatches on fields the operator can act on do.
 *
 * Returns equivalent=true when:
 *   - Both objects are present.
 *   - Every whitelist field has the same primitive value.
 *   - tags array (if present on both) has the same set of strings.
 */
function compareItemFields(primary, replica, whitelist = ITEM_FIELD_WHITELIST) {
  if (primary == null && replica == null) return { equivalent: true, reason: 'both-null' };
  if (primary == null) return { equivalent: false, reason: 'missing-in-primary' };
  if (replica == null) return { equivalent: false, reason: 'missing-in-replica' };

  const differences = [];

  for (const field of whitelist) {
    const pv = _normaliseField(primary, field);
    const rv = _normaliseField(replica, field);
    // If the primary doesn't expose this field, replica having it
    // (e.g. internal columns the primary path doesn't surface) is
    // not a divergence. Only fields the operator can act on, on
    // both sides, are compared.
    if (pv === undefined) continue;
    if (pv !== rv) {
      differences.push({ field, primary: pv, replica: rv });
    }
  }

  // Tags: case-insensitive set comparison so render order doesn't
  // pollute the diff.
  if ('tags' in primary || 'tags' in replica) {
    const pt = _toTagSet(primary.tags);
    const rt = _toTagSet(replica.tags);
    if (pt.size !== rt.size || ![...pt].every((t) => rt.has(t))) {
      differences.push({
        field: 'tags',
        primary: [...pt],
        replica: [...rt],
      });
    }
  }

  return {
    equivalent: differences.length === 0,
    reason: differences.length === 0 ? 'equivalent' : 'field-diff',
    differences: differences.slice(0, 10),
  };
}

function _normaliseField(obj, field) {
  // spaces-api uses camelCase (spaceId, fileName); replica uses
  // snake_case (space_id, file_name). For each whitelist field,
  // try both spellings. Returns undefined when neither is present
  // so the caller can distinguish "field absent" from "field=null".
  if (Object.prototype.hasOwnProperty.call(obj, field) && obj[field] !== undefined) {
    return _normalisePrimitive(obj[field]);
  }
  const camel = field.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  if (Object.prototype.hasOwnProperty.call(obj, camel) && obj[camel] !== undefined) {
    return _normalisePrimitive(obj[camel]);
  }
  return undefined;
}

function _normalisePrimitive(v) {
  if (v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

function _toTagSet(tags) {
  if (!tags) return new Set();
  if (typeof tags === 'string') {
    try {
      const parsed = JSON.parse(tags);
      tags = Array.isArray(parsed) ? parsed : [];
    } catch (_e) {
      tags = [];
    }
  }
  if (!Array.isArray(tags)) return new Set();
  const out = new Set();
  for (const t of tags) {
    if (typeof t === 'string' && t.length > 0) out.add(t.toLowerCase());
  }
  return out;
}

function _eventToGateMethod(event) {
  switch (event) {
    case 'items:listed': return 'itemsList';
    case 'item:fetched': return 'itemsGet';
    case 'items:findByTags': return 'itemsList'; // tag-based item lookup; counts toward list bucket
    case 'smartFolders:listed': return 'smartFoldersList';
    case 'search:completed': return 'search';
    default: return event;
  }
}

function _safePreview(payload) {
  try {
    const s = JSON.stringify(payload);
    return s.length > 400 ? s.slice(0, 400) + '...[truncated]' : s;
  } catch (_e) {
    return '<unserialisable>';
  }
}

function _safeStringify(v) {
  try { return JSON.stringify(v); } catch (_e) { return '<un>'; }
}

function _shallowCloneMap(obj) {
  const out = Object.create(null);
  for (const k of Object.keys(obj)) out[k] = { ...obj[k] };
  return out;
}

function _silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  attachShadowReader,
  // Pure helpers exported for testing
  compareById,
  compareItemFields,
  ITEM_FIELD_WHITELIST,
  SMARTFOLDER_FIELD_WHITELIST,
};
