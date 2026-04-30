/**
 * Direct-graph cutover provider: spacesApi-shaped read methods backed
 * directly by Aura via OmniGraphClient (no replica).
 *
 * When the user wants graph-as-source-of-truth without the SQLite
 * replica's complexity, this provider plugs into the same
 * SpacesAPI.setCutoverProvider hook (commit E) but answers reads via
 * Cypher queries to the now-working direct-Aura path in
 * omnigraph-client.js.
 *
 * Trade-off: every read is a network round-trip (~100-200ms) instead
 * of a local SQLite hit (<5ms). For a power-user app where reads are
 * UI-render-bound, this is felt; for an agent-driven app where reads
 * are infrequent, it's fine. The replica + pull-engine architecture
 * (commits A-F) was designed to give SQLite-fast reads while keeping
 * graph-as-truth; this provider is the "skip the replica, go straight"
 * variant.
 *
 * What this provider implements (matches the §6.6 read surface from
 * cutover-provider.js):
 *   - list(spaceId, options)   -> spaces-api items.list shape
 *   - get(spaceId, itemId)     -> spaces-api items.get shape
 *   - findItems(tags, options) -> spaces-api tags.findItems shape
 *   - listSmartFolders()       -> spaces-api smartFolders.list shape
 *   - inspect()                -> diagnostics
 *
 * What it does NOT implement (deferred / NEVER):
 *   - search(): Cypher full-text search is a separate problem; for now
 *     search continues to use the primary path.
 *   - files.read(): explicitly never via the graph (per §6.3 no-shadow
 *     rule -- gsx-agent/*.md must come from the filesystem).
 *
 * Result-shape parity: Cypher RETURN aliases are mapped 1:1 to the
 * spaces-api result fields. Internal graph-only fields
 * (_history, created_by_app_id, etc.) are stripped.
 */

'use strict';

const KEY_SPACE_FIELDS = Object.freeze([
  'id', 'name', 'icon', 'color',
  'createdAt', 'updatedAt', 'isSystem',
]);

const KEY_ITEM_FIELDS = Object.freeze([
  'id', 'type', 'spaceId', 'space_id',
  'preview', 'timestamp', 'createdAt', 'modifiedAt',
  'fileName', 'fileSize', 'fileType', 'fileCategory', 'fileExt',
  'isScreenshot', 'jsonSubtype', 'pinned',
  'source', 'metadataSource', 'contentHash', 'tagsJson',
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a direct-graph cutover provider.
 *
 * @param {object} args
 * @param {object} args.omniClient -- OmniGraphClient instance (must be
 *   isReady() with direct-Aura credentials).
 * @param {object} [args.logger]
 * @returns {DirectGraphCutoverProvider}
 *
 * @typedef {object} DirectGraphCutoverProvider
 * @property {(spaceId:string, options:object) => Promise<object[]>} list
 * @property {(spaceId:string, itemId:string) => Promise<object|null>} get
 * @property {(tags:string[], options:object) => Promise<object[]>} findItems
 * @property {() => Promise<object[]>} listSmartFolders
 * @property {() => object} inspect
 */
function buildDirectGraphCutoverProvider({ omniClient, logger } = {}) {
  if (!omniClient) {
    throw new Error('buildDirectGraphCutoverProvider: omniClient is required');
  }
  if (typeof omniClient.executeQuery !== 'function') {
    throw new Error('buildDirectGraphCutoverProvider: omniClient must have executeQuery()');
  }
  if (typeof omniClient.isReady === 'function' && !omniClient.isReady()) {
    throw new Error('buildDirectGraphCutoverProvider: omniClient is not ready (missing credentials?)');
  }

  const log = logger || _silentLogger();
  const counters = {
    builtAt: new Date().toISOString(),
    perMethod: Object.create(null),
  };

  function tick(method) {
    if (!counters.perMethod[method]) {
      counters.perMethod[method] = { calls: 0, errors: 0, lastCallAt: null, totalMs: 0 };
    }
    counters.perMethod[method].calls++;
    counters.perMethod[method].lastCallAt = new Date().toISOString();
  }

  function wrap(method, fn) {
    return async (...args) => {
      tick(method);
      const start = Date.now();
      try {
        const result = await fn(...args);
        counters.perMethod[method].totalMs += Date.now() - start;
        return result;
      } catch (err) {
        counters.perMethod[method].errors++;
        // Re-throw -- spaces-api's caller decides fail-open via
        // setCutoverProvider's fallbackEnabled flag.
        log.warn('replica/direct-graph-cutover', `${method} failed`, { error: err.message });
        throw err;
      }
    };
  }

  // ---------------------------------------------------------------------------
  // list(spaceId, options) -> items[]
  // ---------------------------------------------------------------------------

  const list = wrap('list', async (spaceId, options = {}) => {
    if (!spaceId) return [];
    // Build the Cypher: items in this space, with tag filters + pagination.
    // The graph stores assets as :Asset nodes linked to :Space via
    // :CONTAINS. The KEYS push from earlier tonight + __seedGraph use
    // this shape.
    let where = 'a.spaceId = $spaceId';
    const params = { spaceId };
    if (options.type) { where += ' AND a.type = $type'; params.type = options.type; }
    if (options.pinned !== undefined) { where += ' AND a.pinned = $pinned'; params.pinned = !!options.pinned; }

    const limit = typeof options.limit === 'number' ? options.limit : 1000;
    const offset = options.offset || 0;

    const cypher = `
      MATCH (a:Asset)
      WHERE ${where}
      RETURN a
      ORDER BY coalesce(a.pinned, false) DESC, coalesce(a.timestamp, 0) DESC
      SKIP ${offset} LIMIT ${limit}
    `;
    const records = await omniClient.executeQuery(cypher, params);

    let items = records.map((r) => _nodeToSpacesItem(r.a));

    // Tag filters (post-query): mirror spaces-api semantics --
    // case-insensitive ALL / ANY against per-item tags. Using
    // tagsJson string field on the graph node.
    if (options.tags && options.tags.length > 0) {
      const wanted = options.tags.map((t) => String(t).toLowerCase());
      items = items.filter((it) => {
        const tags = (it.tags || []).map((t) => String(t).toLowerCase());
        return wanted.every((w) => tags.includes(w));
      });
    }
    if (options.anyTags && options.anyTags.length > 0) {
      const wanted = options.anyTags.map((t) => String(t).toLowerCase());
      items = items.filter((it) => {
        const tags = (it.tags || []).map((t) => String(t).toLowerCase());
        return wanted.some((w) => tags.includes(w));
      });
    }

    return items;
  });

  // ---------------------------------------------------------------------------
  // get(spaceId, itemId) -> item | null
  // ---------------------------------------------------------------------------

  const get = wrap('get', async (spaceId, itemId) => {
    if (!itemId) return null;
    const cypher = `MATCH (a:Asset {id: $itemId}) RETURN a LIMIT 1`;
    const records = await omniClient.executeQuery(cypher, { itemId });
    if (!records.length) return null;
    const item = _nodeToSpacesItem(records[0].a);
    // Cross-space mismatch -> return null to mirror primary path semantics.
    if (spaceId && item.spaceId && item.spaceId !== spaceId) return null;
    return item;
  });

  // ---------------------------------------------------------------------------
  // findItems(tags, options) -> items[]
  // ---------------------------------------------------------------------------

  const findItems = wrap('findItems', async (tags, options = {}) => {
    if (!Array.isArray(tags) || tags.length === 0) return [];

    let where = 'ANY (t IN $tags WHERE a.tagsJson CONTAINS \'"\' + t + \'"\')';
    const params = { tags };
    if (options.spaceId) { where += ' AND a.spaceId = $spaceId'; params.spaceId = options.spaceId; }

    const limit = options.limit || 1000;
    const cypher = `
      MATCH (a:Asset)
      WHERE ${where}
      RETURN a
      ORDER BY coalesce(a.timestamp, 0) DESC
      LIMIT ${limit}
    `;
    const records = await omniClient.executeQuery(cypher, params);
    let items = records.map((r) => _nodeToSpacesItem(r.a));

    // matchAll -> all tags must be present
    if (options.matchAll && tags.length > 1) {
      const wanted = tags.map((t) => String(t).toLowerCase());
      items = items.filter((it) => {
        const itemTags = (it.tags || []).map((t) => String(t).toLowerCase());
        return wanted.every((w) => itemTags.includes(w));
      });
    }
    return items;
  });

  // ---------------------------------------------------------------------------
  // listSmartFolders()
  // ---------------------------------------------------------------------------

  const listSmartFolders = wrap('listSmartFolders', async () => {
    // Smart folders aren't pushed to graph by the existing __seedGraph
    // path (it pushes Spaces + Assets only). Return [] to keep the UI
    // honest: graph doesn't know about smart folders yet. The follow-up
    // would add a SmartFolder node type + push path.
    return [];
  });

  function inspect() {
    return {
      builtAt: counters.builtAt,
      perMethod: _shallowCloneMap(counters.perMethod),
      omniClient: typeof omniClient.inspect === 'function'
        ? omniClient.inspect()
        : { hasInspect: false },
    };
  }

  return { list, get, findItems, listSmartFolders, inspect };
}

// ---------------------------------------------------------------------------
// Row reshaper -- :Asset graph node -> spaces-api item shape
// ---------------------------------------------------------------------------

/**
 * Convert a Cypher :Asset node (as returned by the OmniGraphClient
 * shape: { id, labels, properties }) into a spaces-api items.list /
 * items.get-shaped object. Strips graph-only provenance fields.
 */
function _nodeToSpacesItem(node) {
  if (!node) return null;
  // OmniGraphClient returns nodes as { id, labels, properties }.
  // Properties is where the actual fields live.
  const props = node.properties || node;
  const tags = _parseTags(props.tagsJson || props.tags);

  return {
    id: props.id,
    type: props.type,
    spaceId: props.spaceId || props.space_id || null,
    timestamp: typeof props.timestamp === 'number' ? props.timestamp : (parseInt(props.timestamp, 10) || 0),
    preview: props.preview || null,
    contentPath: props.contentPath || props.content_path || null,
    thumbnailPath: props.thumbnailPath || props.thumbnail_path || null,
    metadataPath: props.metadataPath || props.metadata_path || null,
    tags,
    pinned: !!props.pinned,
    fileName: props.fileName || props.file_name || null,
    fileSize: typeof props.fileSize === 'number' ? props.fileSize
              : typeof props.file_size === 'number' ? props.file_size : null,
    fileType: props.fileType || props.file_type || null,
    fileCategory: props.fileCategory || props.file_category || null,
    fileExt: props.fileExt || props.file_ext || null,
    isScreenshot: !!(props.isScreenshot || props.is_screenshot),
    jsonSubtype: props.jsonSubtype || props.json_subtype || null,
    source: props.source || null,
    metadataSource: props.metadataSource || props.metadata_source || null,
    createdAt: props.createdAt || props.created_at || null,
    modifiedAt: props.modifiedAt || props.modified_at || null,
  };
}

function _parseTags(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_err) {
    return [];
  }
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
  buildDirectGraphCutoverProvider,
  // Pure helpers exported for testing
  _nodeToSpacesItem,
  _parseTags,
};
