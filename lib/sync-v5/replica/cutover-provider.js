/**
 * Cutover provider: spacesApi-shaped read methods backed by the
 * materialised SQLite replica.
 *
 * Per docs/sync-v5/replica-shape.md §5.1 (commit E in the A->F
 * cutover ladder). When `syncV5.replica.cutoverEnabled` is true AND
 * `validationGate.cutoverAllowed()` returns true (per §6.6:
 * thresholds + ≥7-day floor + zero divergences), spaces-api's read
 * methods route through this adapter instead of clipboard-storage-v2.
 *
 * Why a separate adapter rather than wrapping spaces-api directly:
 *   - spaces-api uses a `get items()` getter that returns a fresh
 *     object per access. Monkey-patching `spacesApi.items.list = ...`
 *     wouldn't survive the next access (every call re-evaluates the
 *     getter and creates a new closure object).
 *   - spaces-api owns the cutover decision (it has the validation
 *     gate context and the fail-open semantics). The adapter is
 *     just the read implementation; spaces-api wires it in via
 *     setCutoverProvider() at boot and decides per-call whether to
 *     route through it.
 *   - Keeping the implementation here means the cutover
 *     translation logic (replica row shape -> spaces-api result
 *     shape) lives in one place and is testable without spinning up
 *     spaces-api itself.
 *
 * The adapter is a thin pure-data translator: it calls Replica's
 * read methods (added in commit D) and reshapes the rows so they
 * match spaces-api's documented output. The Replica's storage layer
 * is already populated by the migration (commit B) and kept current
 * by the shadow-writer (commit C); no I/O outside SQLite happens
 * here.
 *
 * What this adapter implements (matches the §6.6 read surface):
 *   - list(spaceId, options)        -> spaces-api items.list shape
 *   - get(spaceId, itemId)          -> spaces-api items.get shape
 *   - findItems(tags, options)      -> spaces-api tags.findItems shape
 *   - listSmartFolders()            -> spaces-api smartFolders.list shape
 *
 * What this adapter does NOT implement (deferred to follow-ups):
 *   - search(query, options) -- the FTS5 query path is wired in a
 *     separate commit alongside items_fts triggers + BM25 ranking
 *     parity. Until then, search continues through the primary path
 *     even when cutover is otherwise active.
 *   - files.read(spaceId, relPath) -- intentionally NOT replica-
 *     shadowed per §6.3 (gsx-agent/*.md filesystem reads). The
 *     primary path always answers these; cutover doesn't change
 *     that.
 */

'use strict';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a cutover-ready provider object that spaces-api can route
 * its reads through. The provider exposes the read methods spaces-
 * api calls; each one returns a result in spaces-api's documented
 * shape.
 *
 * @param {object} args
 * @param {object} args.replica -- initialised Replica instance.
 * @returns {CutoverProvider}
 *
 * @typedef {object} CutoverProvider
 * @property {(spaceId:string, options:object) => Promise<object[]>} list
 * @property {(spaceId:string, itemId:string) => Promise<object|null>} get
 * @property {(tags:string[], options:object) => Promise<object[]>} findItems
 * @property {() => Promise<object[]>} listSmartFolders
 * @property {() => object} inspect -- diagnostics surface
 */
function buildCutoverProvider({ replica } = {}) {
  if (!replica) throw new Error('buildCutoverProvider: replica is required');

  const counters = {
    builtAt: new Date().toISOString(),
    perMethod: Object.create(null),
  };

  function tick(method) {
    if (!counters.perMethod[method]) {
      counters.perMethod[method] = { calls: 0, errors: 0, lastCallAt: null };
    }
    counters.perMethod[method].calls++;
    counters.perMethod[method].lastCallAt = new Date().toISOString();
  }

  function wrap(method, fn) {
    return async (...args) => {
      tick(method);
      try {
        return await fn(...args);
      } catch (err) {
        counters.perMethod[method].errors++;
        // Re-throw -- spaces-api's caller decides fail-open vs.
        // fail-closed based on syncV5.replica.fallbackToOldPath.
        throw err;
      }
    };
  }

  // ---------------------------------------------------------------------------
  // list(spaceId, options) -> items[]
  // ---------------------------------------------------------------------------

  const list = wrap('list', async (spaceId, options = {}) => {
    if (!spaceId) return [];
    const rows = replica.listItemsBySpace(spaceId, {
      type: options.type,
      pinned: options.pinned,
      tags: options.tags,
      anyTags: options.anyTags,
      limit: options.limit,
      offset: options.offset,
    });

    // Reshape to spaces-api's items.list output shape.
    // spaces-api uses camelCase (spaceId, fileName, isScreenshot) for
    // the row fields; replica stores snake_case. Translate.
    return rows.map((row) => _replicaRowToSpacesItem(row));
  });

  // ---------------------------------------------------------------------------
  // get(spaceId, itemId) -> item | null
  // ---------------------------------------------------------------------------

  const get = wrap('get', async (spaceId, itemId) => {
    if (!itemId) return null;
    const row = replica.getItem(itemId);
    if (!row) return null;
    // spaces-api items.get tolerates a space mismatch by logging a
    // warning -- the replica's space_id is authoritative because
    // shadow-writer keeps it in sync with item:moved events.
    if (spaceId && row.space_id && row.space_id !== spaceId) {
      // Caller asked about an item in a different space than where
      // the replica thinks it lives. Return null to mirror the
      // primary path's "item not found in this space" semantics
      // (rather than returning the row which would silently change
      // the renderer's view).
      return null;
    }
    return _replicaRowToSpacesItem(row);
  });

  // ---------------------------------------------------------------------------
  // findItems(tags, options) -> items[]
  // ---------------------------------------------------------------------------

  const findItems = wrap('findItems', async (tags, options = {}) => {
    if (!Array.isArray(tags) || tags.length === 0) return [];
    const rows = replica.findItemsByTags(tags, {
      spaceId: options.spaceId,
      matchAll: options.matchAll,
      limit: options.limit,
    });
    return rows.map((row) => _replicaRowToSpacesItem(row));
  });

  // ---------------------------------------------------------------------------
  // listSmartFolders() -> smartFolders[]
  // ---------------------------------------------------------------------------

  const listSmartFolders = wrap('listSmartFolders', async () => {
    const rows = replica.listSmartFolders();
    // spaces-api smartFolders.list returns the raw folder objects
    // (id, name, icon, color, criteria, createdAt, updatedAt). The
    // replica row format already matches except for snake_case
    // timestamps -> camelCase.
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      icon: row.icon,
      color: row.color,
      criteria: row.criteria,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  });

  function inspect() {
    return {
      builtAt: counters.builtAt,
      perMethod: _shallowCloneMap(counters.perMethod),
      replica: {
        dbPath: replica.dbPath,
        tenantId: replica.tenantId,
        deviceId: replica.deviceId,
      },
    };
  }

  return { list, get, findItems, listSmartFolders, inspect };
}

// ---------------------------------------------------------------------------
// Row reshapers (pure functions, exported for testing)
// ---------------------------------------------------------------------------

/**
 * Reshape a replica items row into spaces-api's item shape.
 *
 * Replica columns are snake_case + integer-coerced booleans; spaces-
 * api consumers expect camelCase + native booleans on a few fields.
 * The `tags` array and structured `metadata` payload pass through
 * unchanged (the replica already hydrates `tags` via item_tags;
 * `metadata` is intentionally NOT mirrored in v5 -- consumers that
 * need full metadata still go through the primary path or the
 * filesystem `metadata.json`).
 *
 * Hidden / replica-internal columns (vc, content_hash, deleted_at,
 * deleted_by, has_parked_precursor, replica_meta keys, tenant_id)
 * are intentionally NOT exposed -- they're sync internals, not
 * spaces-api surface.
 */
function _replicaRowToSpacesItem(row) {
  if (!row) return row;
  return {
    id: row.id,
    type: row.type,
    spaceId: row.space_id,
    timestamp: row.timestamp,
    preview: row.preview,
    contentPath: row.content_path,
    thumbnailPath: row.thumbnail_path,
    metadataPath: row.metadata_path,
    tags: Array.isArray(row.tags) ? row.tags : (typeof row.tags === 'string' ? _safeParseJson(row.tags) || [] : []),
    pinned: !!row.pinned,
    fileName: row.file_name,
    fileSize: row.file_size,
    fileType: row.file_type,
    fileCategory: row.file_category,
    fileExt: row.file_ext,
    isScreenshot: !!row.is_screenshot,
    jsonSubtype: row.json_subtype,
    source: row.source,
    metadataSource: row.metadata_source,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
  };
}

function _safeParseJson(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return JSON.parse(value);
  } catch (_err) {
    return null;
  }
}

function _shallowCloneMap(obj) {
  const out = Object.create(null);
  for (const k of Object.keys(obj)) out[k] = { ...obj[k] };
  return out;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  buildCutoverProvider,
  // Pure helpers exported for testing
  _replicaRowToSpacesItem,
};
