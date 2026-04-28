/**
 * Materialised SQLite replica -- Replica class.
 *
 * Per docs/sync-v5/replica-shape.md §0 (goal) and §3 (schema), this
 * class is the per-device cache of (:Space, :Asset) state projected
 * from the graph (and, during cutover, mirror-written by the existing
 * clipboard-storage-v2). After cutover, every Spaces query in the app
 * goes through here.
 *
 * Commit A scope (this file): the foundational layer.
 *   - init({ dbPath, tenantId, deviceId }) -- open DB + apply schema
 *     + seed replica_meta + handle schemaVersion handshake
 *   - close() -- graceful shutdown, no-op if not opened
 *   - Basic CRUD on spaces and items (just enough for tests + boot
 *     wiring in commit B). The full query surface (search, smart
 *     folders, tag aggregates) lands in commit B/C/D as the cutover
 *     advances.
 *   - shouldShadow(relativePath) -- the no-shadow gate from §6.3
 *     (gsx-agent/*.md filesystem reads must NOT be replica-shadowed).
 *   - getMeta / setMeta -- replica_meta key/value access.
 *   - inspect() -- diagnostics-friendly snapshot (counts, settings,
 *     schemaVersion, cursor) for the /sync/* HTTP endpoints.
 *
 * Out of scope for commit A (deferred to follow-up commits):
 *   - Cold-device migration from existing clipboard-storage-v2 (§4).
 *     The migration tool ships in commit B alongside the boot
 *     wiring; commit A just makes sure the schema accepts what the
 *     migrator will produce.
 *   - search() over FTS5 (commit C/D as part of cutover).
 *   - Smart-folder evaluation (commit D).
 *   - Compactor purge step for tombstoneRetentionDays (commit F).
 *
 * The Replica is a SINGLETON per (dbPath, tenantId) pair. Tests
 * create their own with explicit dbPath = ':memory:'. Production code
 * should use the factory `getReplica(opts)` which keeps a process-wide
 * map keyed by (dbPath, tenantId).
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { SCHEMA_VERSION, getInitDDL, DDL_ITEMS_FTS, buildReplicaMetaSeed } = require('./schema');

// ---------------------------------------------------------------------------
// Lazy import of better-sqlite3 so the schema module + tests that don't
// touch the DB can be inspected without the native binding.
// ---------------------------------------------------------------------------

let Database = null;
function _loadDatabase() {
  if (Database) return Database;
  try {
    Database = require('better-sqlite3');
    return Database;
  } catch (err) {
    const e = new Error('better-sqlite3 native module not available; run npm install. Original: ' + err.message);
    e.code = 'BETTER_SQLITE3_MISSING';
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Replica
// ---------------------------------------------------------------------------

class Replica {
  /**
   * @param {object} opts
   * @param {string} opts.dbPath -- absolute file path or ':memory:'.
   * @param {string} [opts.tenantId='default'] -- the tenant column for
   *   every row this replica writes.
   * @param {string} [opts.deviceId=''] -- this device's stable ID;
   *   stored in replica_meta and used for vc bumps in follow-up
   *   commits.
   * @param {string[]} [opts.noShadowPaths=['gsx-agent/*.md']] -- glob
   *   patterns that should NOT be answered by the replica (per §6.3).
   *   The replica's read path checks these before querying SQLite.
   * @param {number} [opts.tombstoneRetentionDays] -- if set, the
   *   compactor purges active=0 rows older than this. Default unset =
   *   keep forever (mirrors graph :Tombstone semantics).
   * @param {boolean} [opts.readonly=false] -- open the DB readonly.
   *   Used by diagnostics to inspect a paused replica.
   */
  constructor({ dbPath, tenantId = 'default', deviceId = '', noShadowPaths = ['gsx-agent/*.md'], tombstoneRetentionDays, readonly = false } = {}) {
    if (!dbPath) {
      throw new Error('Replica: dbPath is required (use ":memory:" for tests)');
    }
    this.dbPath = dbPath;
    this.tenantId = tenantId;
    this.deviceId = String(deviceId || '');
    this.noShadowPaths = Array.isArray(noShadowPaths) ? noShadowPaths.slice() : [];
    this.tombstoneRetentionDays = tombstoneRetentionDays;
    this.readonly = !!readonly;
    this.db = null;
    this._stmts = null;
    this._opened = false;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Open the SQLite file (creating it if needed) and apply the
   * schema. Idempotent: calling init() twice is a no-op after the
   * first call. On schemaVersion mismatch, throws an error tagged with
   * code REPLICA_SCHEMA_VERSION_MISMATCH so the caller can route
   * to the migration tool (commit B+) or refuse to boot.
   */
  init() {
    if (this._opened) return this;

    const Db = _loadDatabase();

    // Ensure the parent directory exists for file-backed DBs.
    if (this.dbPath !== ':memory:') {
      const dir = path.dirname(this.dbPath);
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }

    this.db = new Db(this.dbPath, { readonly: this.readonly });

    // Practical pragmas for an Electron embedded DB. WAL gives us
    // concurrent reader + writer (the renderer can read while the
    // pull engine writes); foreign_keys ON enforces the items->item_tags
    // cascade.
    if (!this.readonly) {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('synchronous = NORMAL');
    } else {
      this.db.pragma('foreign_keys = ON');
    }

    if (!this.readonly) {
      this._applySchema();
      this._seedMetaIfFresh();
    }

    this._verifySchemaVersion();
    this._prepareStatements();
    this._opened = true;
    return this;
  }

  /**
   * Apply the schema DDL inside a transaction. FTS5 virtual table is
   * conditional because CREATE VIRTUAL TABLE doesn't honour IF NOT
   * EXISTS in all SQLite builds.
   */
  _applySchema() {
    const ddls = getInitDDL();
    const apply = this.db.transaction(() => {
      for (const stmt of ddls) {
        this.db.exec(stmt);
      }
      // FTS5: only create if missing.
      const existsRow = this.db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='items_fts'`
      ).get();
      if (!existsRow) {
        try {
          this.db.exec(DDL_ITEMS_FTS);
        } catch (err) {
          // FTS5 may not be compiled into the better-sqlite3 binary on
          // this platform. Don't fail init -- tag the replica as
          // FTS-disabled and continue. search() in commit C will fall
          // back to a non-FTS path if this is the case.
          this.fts5Available = false;
          this.fts5Error = err.message;
          return;
        }
      }
      this.fts5Available = true;
    });
    apply();
  }

  /**
   * Seed replica_meta on a fresh DB. If schemaVersion is already set,
   * this is a no-op (init was called against an existing replica).
   */
  _seedMetaIfFresh() {
    const existing = this.db.prepare(
      `SELECT value FROM replica_meta WHERE tenant_id = ? AND key = 'schemaVersion'`
    ).get(this.tenantId);
    if (existing) return;

    const seed = buildReplicaMetaSeed({
      tenantId: this.tenantId,
      deviceId: this.deviceId,
    });
    const insert = this.db.prepare(
      `INSERT INTO replica_meta (tenant_id, key, value) VALUES (@tenant_id, @key, @value)`
    );
    const tx = this.db.transaction(() => {
      for (const row of seed) insert.run(row);
    });
    tx();
  }

  /**
   * Compare the on-disk schemaVersion against the compiled-in
   * SCHEMA_VERSION. Mismatch throws so the caller can route to
   * migration tooling.
   */
  _verifySchemaVersion() {
    const row = this.db.prepare(
      `SELECT value FROM replica_meta WHERE tenant_id = ? AND key = 'schemaVersion'`
    ).get(this.tenantId);

    if (!row) {
      // Fresh readonly DB with no seed; treat as version 0 (uninited).
      if (this.readonly) {
        this.schemaVersion = 0;
        return;
      }
      throw new Error('Replica: replica_meta not seeded after init; this should not happen.');
    }

    const onDisk = parseInt(row.value, 10);
    this.schemaVersion = onDisk;
    if (onDisk > SCHEMA_VERSION) {
      const e = new Error(
        `Replica: on-disk schemaVersion ${onDisk} is newer than this build's ${SCHEMA_VERSION}; ` +
        `refusing to open. Upgrade the app or revert the replica file.`
      );
      e.code = 'REPLICA_SCHEMA_VERSION_NEWER';
      throw e;
    }
    if (onDisk < SCHEMA_VERSION) {
      const e = new Error(
        `Replica: on-disk schemaVersion ${onDisk} is older than ${SCHEMA_VERSION}; ` +
        `migration required (route to lib/sync-v5/replica/migrate.js when implemented).`
      );
      e.code = 'REPLICA_SCHEMA_VERSION_OLDER';
      throw e;
    }
  }

  /**
   * Prepare the hot-path statements once. Each method below uses these
   * cached prepared statements so SQL parsing happens at init() time,
   * not per-call. Cleared on close().
   */
  _prepareStatements() {
    const t = this.tenantId;

    this._stmts = {
      // Spaces
      softDeleteSpaceStmt: this.db.prepare(`
        UPDATE spaces SET active = 0, deleted_at = ?, deleted_by = ?, updated_at = ?, vc = ?
        WHERE tenant_id = ? AND id = ?
      `),
      // Items: soft-delete + space_id reassignment + tag-mass-update helpers used
      // by the shadow-writer for the move / bulk / rename event paths.
      softDeleteItemStmt: this.db.prepare(`
        UPDATE items SET active = 0, deleted_at = ?, deleted_by = ?, modified_at = ?, vc = ?
        WHERE tenant_id = ? AND id = ?
      `),
      moveItemStmt: this.db.prepare(`
        UPDATE items SET space_id = ?, modified_at = ?, vc = ?
        WHERE tenant_id = ? AND id = ?
      `),
      listItemsForTagSweep: this.db.prepare(`
        SELECT id, tags, vc FROM items
        WHERE tenant_id = ? AND space_id = ? AND active = 1
      `),

      // Smart folders (commit C; not in commit-A scaffold)
      upsertSmartFolderStmt: this.db.prepare(`
        INSERT INTO smart_folders (tenant_id, id, name, icon, color, criteria, created_at, updated_at)
        VALUES (@tenant_id, @id, @name, @icon, @color, @criteria, @created_at, @updated_at)
        ON CONFLICT (tenant_id, id) DO UPDATE SET
          name = excluded.name,
          icon = excluded.icon,
          color = excluded.color,
          criteria = excluded.criteria,
          updated_at = excluded.updated_at
      `),
      getSmartFolderStmt: this.db.prepare(
        `SELECT * FROM smart_folders WHERE tenant_id = ? AND id = ?`
      ),
      deleteSmartFolderStmt: this.db.prepare(
        `DELETE FROM smart_folders WHERE tenant_id = ? AND id = ?`
      ),
      countSmartFoldersStmt: this.db.prepare(
        `SELECT COUNT(*) AS n FROM smart_folders WHERE tenant_id = ?`
      ),
      listSmartFoldersStmt: this.db.prepare(
        `SELECT * FROM smart_folders WHERE tenant_id = ? ORDER BY updated_at DESC`
      ),

      // Item read query surface (commit D, for shadow-reader equivalence
      // checks). The list-by-space query mirrors spaces-api's items.list
      // sort ("pinned first, then timestamp DESC"). The tag-aggregate
      // queries hit the denormalised item_tags join table so they stay
      // O(rows-with-tag) rather than O(items) JSON-scan.
      listItemsBySpaceStmt: this.db.prepare(`
        SELECT * FROM items
        WHERE tenant_id = ? AND space_id = ? AND active = 1
        ORDER BY pinned DESC, timestamp DESC
      `),
      listItemsBySpaceTypeStmt: this.db.prepare(`
        SELECT * FROM items
        WHERE tenant_id = ? AND space_id = ? AND type = ? AND active = 1
        ORDER BY pinned DESC, timestamp DESC
      `),
      listItemsBySpacePinnedStmt: this.db.prepare(`
        SELECT * FROM items
        WHERE tenant_id = ? AND space_id = ? AND pinned = ? AND active = 1
        ORDER BY pinned DESC, timestamp DESC
      `),
      listTagsBySpaceStmt: this.db.prepare(`
        SELECT it.tag AS tag, COUNT(*) AS count
        FROM item_tags it
        JOIN items i ON i.tenant_id = it.tenant_id AND i.id = it.item_id
        WHERE it.tenant_id = ? AND i.space_id = ? AND i.active = 1
        GROUP BY it.tag
        ORDER BY count DESC, it.tag ASC
      `),
      listAllTagsStmt: this.db.prepare(`
        SELECT it.tag AS tag, COUNT(*) AS count
        FROM item_tags it
        JOIN items i ON i.tenant_id = it.tenant_id AND i.id = it.item_id
        WHERE it.tenant_id = ? AND i.active = 1
        GROUP BY it.tag
        ORDER BY count DESC, it.tag ASC
      `),
      findItemsByTagsAnyStmt: this.db.prepare(`
        SELECT DISTINCT i.* FROM items i
        JOIN item_tags it ON i.tenant_id = it.tenant_id AND i.id = it.item_id
        WHERE i.tenant_id = ? AND i.active = 1
          AND it.tag IN (SELECT value FROM json_each(?))
        ORDER BY i.timestamp DESC
      `),
      findItemsByTagsAnyInSpaceStmt: this.db.prepare(`
        SELECT DISTINCT i.* FROM items i
        JOIN item_tags it ON i.tenant_id = it.tenant_id AND i.id = it.item_id
        WHERE i.tenant_id = ? AND i.active = 1 AND i.space_id = ?
          AND it.tag IN (SELECT value FROM json_each(?))
        ORDER BY i.timestamp DESC
      `),

      // Spaces (continued)
      insertSpace: this.db.prepare(`
        INSERT INTO spaces (tenant_id, id, name, icon, color, is_system, created_at, updated_at, vc, active)
        VALUES (@tenant_id, @id, @name, @icon, @color, @is_system, @created_at, @updated_at, @vc, @active)
        ON CONFLICT (tenant_id, id) DO UPDATE SET
          name = excluded.name,
          icon = excluded.icon,
          color = excluded.color,
          is_system = excluded.is_system,
          updated_at = excluded.updated_at,
          vc = excluded.vc,
          active = excluded.active
      `),
      getSpace: this.db.prepare(
        `SELECT * FROM spaces WHERE tenant_id = ? AND id = ?`
      ),
      listSpaces: this.db.prepare(
        `SELECT * FROM spaces WHERE tenant_id = ? AND active = 1 ORDER BY updated_at DESC`
      ),
      countSpaces: this.db.prepare(
        `SELECT COUNT(*) AS n FROM spaces WHERE tenant_id = ? AND active = 1`
      ),

      // Items (insert/get only at this scaffold; full surface lands in
      // commit B/C as cutover progresses).
      insertItem: this.db.prepare(`
        INSERT INTO items (
          tenant_id, id, type, space_id, timestamp, preview,
          content_path, thumbnail_path, metadata_path, tags, pinned,
          file_name, file_size, file_type, file_category, file_ext,
          is_screenshot, json_subtype, source, metadata_source,
          content_hash, vc, active, deleted_at, deleted_by,
          created_at, modified_at, has_parked_precursor
        ) VALUES (
          @tenant_id, @id, @type, @space_id, @timestamp, @preview,
          @content_path, @thumbnail_path, @metadata_path, @tags, @pinned,
          @file_name, @file_size, @file_type, @file_category, @file_ext,
          @is_screenshot, @json_subtype, @source, @metadata_source,
          @content_hash, @vc, @active, @deleted_at, @deleted_by,
          @created_at, @modified_at, @has_parked_precursor
        )
        ON CONFLICT (tenant_id, id) DO UPDATE SET
          type = excluded.type,
          space_id = excluded.space_id,
          timestamp = excluded.timestamp,
          preview = excluded.preview,
          content_path = excluded.content_path,
          thumbnail_path = excluded.thumbnail_path,
          metadata_path = excluded.metadata_path,
          tags = excluded.tags,
          pinned = excluded.pinned,
          source = excluded.source,
          metadata_source = excluded.metadata_source,
          content_hash = excluded.content_hash,
          vc = excluded.vc,
          active = excluded.active,
          deleted_at = excluded.deleted_at,
          deleted_by = excluded.deleted_by,
          modified_at = excluded.modified_at,
          has_parked_precursor = excluded.has_parked_precursor
      `),
      getItem: this.db.prepare(
        `SELECT * FROM items WHERE tenant_id = ? AND id = ?`
      ),
      countItems: this.db.prepare(
        `SELECT COUNT(*) AS n FROM items WHERE tenant_id = ? AND active = 1`
      ),
      countItemsBySpace: this.db.prepare(
        `SELECT COUNT(*) AS n FROM items WHERE tenant_id = ? AND space_id = ? AND active = 1`
      ),

      // item_tags (denorm; bulk-replace via delete + insert per item).
      deleteItemTags: this.db.prepare(
        `DELETE FROM item_tags WHERE tenant_id = ? AND item_id = ?`
      ),
      insertItemTag: this.db.prepare(
        `INSERT OR IGNORE INTO item_tags (tenant_id, item_id, tag) VALUES (?, ?, ?)`
      ),
      listItemTags: this.db.prepare(
        `SELECT tag FROM item_tags WHERE tenant_id = ? AND item_id = ? ORDER BY tag`
      ),

      // replica_meta
      getMeta: this.db.prepare(
        `SELECT value FROM replica_meta WHERE tenant_id = ? AND key = ?`
      ),
      setMeta: this.db.prepare(`
        INSERT INTO replica_meta (tenant_id, key, value) VALUES (?, ?, ?)
        ON CONFLICT (tenant_id, key) DO UPDATE SET value = excluded.value
      `),
    };

    void t; // reserved for future per-tenant statement variants
  }

  /**
   * Close the DB. Idempotent; safe to call from a SIGTERM handler.
   */
  close() {
    if (!this._opened) return;
    try {
      if (this.db) this.db.close();
    } catch (_err) {
      // Already closed or platform-specific noise; intentional swallow
      // because close() is called from shutdown paths.
    }
    this.db = null;
    this._stmts = null;
    this._opened = false;
  }

  // ---------------------------------------------------------------------------
  // No-shadow gate (§6.3)
  // ---------------------------------------------------------------------------

  /**
   * Should the replica answer a query for this filesystem-relative
   * path, or fall through to the filesystem read?
   *
   * Per §6.3: the replica owns the catalog (items + tags + smart
   * folders); the filesystem owns raw markdown / files. Specifically,
   * gsx-agent/*.md files are read directly from disk by unified-bidder
   * and omni-data-agent and must NOT be answered from a replica
   * cache.
   *
   * Pattern matching: simple glob -- '*' matches any non-slash
   * sequence within a path segment. This is intentionally narrow;
   * paths are checked in normalised form (forward slashes, no
   * leading './').
   *
   * @param {string} relativePath -- e.g. 'gsx-agent/conversation-history.md'.
   * @returns {boolean} true if the replica MAY answer; false to
   *   force filesystem fall-through.
   */
  shouldShadow(relativePath) {
    if (!relativePath) return true;
    const normalised = String(relativePath).replace(/\\/g, '/').replace(/^\.\/+/, '');
    for (const pattern of this.noShadowPaths) {
      if (_matchGlob(pattern, normalised)) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Spaces CRUD (commit-A scaffold; full surface in follow-up commits)
  // ---------------------------------------------------------------------------

  /**
   * Upsert a space row. Caller is responsible for the vc field
   * (vector clock); pass '{}' if not yet maintaining causality.
   *
   * @param {object} space
   */
  upsertSpace(space) {
    this._assertOpen();
    const row = _normaliseSpaceRow(this.tenantId, space);
    this._stmts.insertSpace.run(row);
    return row;
  }

  /**
   * @returns {object|null}
   */
  getSpace(id) {
    this._assertOpen();
    const row = this._stmts.getSpace.get(this.tenantId, id);
    return row || null;
  }

  /**
   * @returns {object[]} active spaces for this tenant, newest first.
   */
  listSpaces() {
    this._assertOpen();
    return this._stmts.listSpaces.all(this.tenantId);
  }

  // ---------------------------------------------------------------------------
  // Items CRUD (commit-A scaffold)
  // ---------------------------------------------------------------------------

  /**
   * Upsert an item row. Bulk-replaces the denormalised tags. Runs in
   * a transaction so a partial failure doesn't leave item / item_tags
   * inconsistent.
   */
  upsertItem(item) {
    this._assertOpen();
    const row = _normaliseItemRow(this.tenantId, item);
    const tags = Array.isArray(item.tags) ? item.tags : _parseTagsField(row.tags);

    const tx = this.db.transaction(() => {
      this._stmts.insertItem.run(row);
      this._stmts.deleteItemTags.run(this.tenantId, row.id);
      for (const t of tags) {
        if (typeof t === 'string' && t.length > 0) {
          this._stmts.insertItemTag.run(this.tenantId, row.id, t);
        }
      }
    });
    tx();
    return row;
  }

  getItem(id) {
    this._assertOpen();
    const row = this._stmts.getItem.get(this.tenantId, id);
    if (!row) return null;
    return _hydrateItemRow(row, this.listItemTags(id));
  }

  listItemTags(itemId) {
    this._assertOpen();
    const rows = this._stmts.listItemTags.all(this.tenantId, itemId);
    return rows.map((r) => r.tag);
  }

  // ---------------------------------------------------------------------------
  // Item / tag / smart-folder read query surface (commit D).
  //
  // These are the queries shadow-reader runs to compare against
  // spaces-api's results. Each returns plain row objects (not
  // hydrated; tags are populated on demand) so the comparison can
  // happen at the row level without expensive joins.
  //
  // The sort order matches spaces-api wherever possible (pinned
  // first then timestamp DESC) so id-set comparisons aren't
  // confused by ordering differences. Where ordering genuinely
  // differs (FTS5 ranking vs. boolean-AND order) the shadow-reader
  // does set-by-id comparison rather than positional.
  // ---------------------------------------------------------------------------

  /**
   * List items in a space, with optional type/pinned/tags filters.
   *
   * @param {string} spaceId
   * @param {object} [options]
   * @param {string} [options.type]   -- exact-match filter
   * @param {boolean} [options.pinned] -- exact-match filter
   * @param {string[]} [options.tags] -- ALL must match (intersection)
   * @param {string[]} [options.anyTags] -- ANY must match (union)
   * @param {number} [options.limit]
   * @param {number} [options.offset]
   * @returns {object[]} hydrated item rows (with tags array)
   */
  listItemsBySpace(spaceId, options = {}) {
    this._assertOpen();
    if (!spaceId) throw new Error('Replica.listItemsBySpace: spaceId is required');

    let rows;
    if (options.type) {
      rows = this._stmts.listItemsBySpaceTypeStmt.all(this.tenantId, spaceId, String(options.type));
    } else if (options.pinned !== undefined) {
      rows = this._stmts.listItemsBySpacePinnedStmt.all(this.tenantId, spaceId, options.pinned ? 1 : 0);
    } else {
      rows = this._stmts.listItemsBySpaceStmt.all(this.tenantId, spaceId);
    }

    // Tag filters (post-query): mirror spaces-api semantics --
    // case-insensitive ALL / ANY against the per-item tags.
    if (options.tags && options.tags.length > 0) {
      const wanted = options.tags.map((t) => String(t).toLowerCase());
      rows = rows.filter((r) => {
        const tags = this.listItemTags(r.id).map((t) => t.toLowerCase());
        return wanted.every((w) => tags.includes(w));
      });
    }
    if (options.anyTags && options.anyTags.length > 0) {
      const wanted = options.anyTags.map((t) => String(t).toLowerCase());
      rows = rows.filter((r) => {
        const tags = this.listItemTags(r.id).map((t) => t.toLowerCase());
        return wanted.some((w) => tags.includes(w));
      });
    }

    // Pagination.
    const offset = options.offset || 0;
    const limit = typeof options.limit === 'number' ? options.limit : rows.length;
    rows = rows.slice(offset, offset + limit);

    // Hydrate tags (matches spaces-api items.list output shape;
    // shadow-reader's id-set comparison only uses id but tag-set
    // diffs need the tags too).
    return rows.map((row) => _hydrateItemRow(row, this.listItemTags(row.id)));
  }

  /**
   * Tag-aggregate query: tags used by any active item in `spaceId`.
   * Returns [{tag, count}] sorted by count DESC, then tag ASC.
   */
  listTagsBySpace(spaceId) {
    this._assertOpen();
    if (!spaceId) throw new Error('Replica.listTagsBySpace: spaceId is required');
    return this._stmts.listTagsBySpaceStmt.all(this.tenantId, spaceId);
  }

  /**
   * Tag-aggregate query: every tag used by any active item across
   * all spaces in this tenant. Returns [{tag, count}] but unlike the
   * spaces-api equivalent does NOT include the per-tag spaces[] list
   * (that's a follow-up; the gate doesn't require it for D).
   */
  listAllTags() {
    this._assertOpen();
    return this._stmts.listAllTagsStmt.all(this.tenantId);
  }

  /**
   * Find items by tag(s). matchAll=true requires intersection;
   * matchAll=false (default) is union. Mirrors spaces-api's
   * tags.findItems semantics.
   */
  findItemsByTags(tags, options = {}) {
    this._assertOpen();
    if (!Array.isArray(tags) || tags.length === 0) return [];
    const tagsJson = JSON.stringify(tags.map(String));

    let rows;
    if (options.spaceId) {
      rows = this._stmts.findItemsByTagsAnyInSpaceStmt.all(this.tenantId, options.spaceId, tagsJson);
    } else {
      rows = this._stmts.findItemsByTagsAnyStmt.all(this.tenantId, tagsJson);
    }

    // matchAll: filter post-query because the SQL union returns
    // any-match. Single-pass with a Set-of-itemTags lookup.
    if (options.matchAll && tags.length > 1) {
      const wanted = tags.map((t) => String(t).toLowerCase());
      rows = rows.filter((r) => {
        const itemTags = this.listItemTags(r.id).map((t) => t.toLowerCase());
        return wanted.every((w) => itemTags.includes(w));
      });
    }

    if (options.limit) rows = rows.slice(0, options.limit);

    return rows.map((row) => _hydrateItemRow(row, this.listItemTags(row.id)));
  }

  /**
   * List smart folders for the current tenant. Newest-first.
   */
  listSmartFolders() {
    this._assertOpen();
    const rows = this._stmts.listSmartFoldersStmt.all(this.tenantId);
    return rows.map((r) => ({ ...r, criteria: _safeParseJson(r.criteria) || {} }));
  }

  // ---------------------------------------------------------------------------
  // Soft-delete + move (commit C; used by the shadow-writer for the
  // item:deleted / items:bulk-deleted / item:moved / items:bulk-moved /
  // space:deleted event paths)
  // ---------------------------------------------------------------------------

  /**
   * Soft-delete an item: active=0 + deleted_at + deleted_by + bumped vc.
   * Mirrors graph :Tombstone semantics; the row is preserved so the
   * compactor can decide retention per syncV5.replica.tombstoneRetentionDays.
   *
   * @param {object} args
   * @param {string} args.itemId
   * @param {string} args.deletedBy   -- typically deviceId
   * @param {string} [args.deletedAt] -- ISO; defaults to now
   * @param {string} [args.vc]        -- JSON-encoded VC; defaults to existing+bump
   * @returns {boolean} true if a row was tombstoned, false if no live row exists
   */
  softDeleteItem({ itemId, deletedBy, deletedAt, vc } = {}) {
    this._assertOpen();
    if (!itemId) throw new Error('Replica.softDeleteItem: itemId required');
    const existing = this._stmts.getItem.get(this.tenantId, itemId);
    if (!existing) return false;
    const nowIso = deletedAt || new Date().toISOString();
    const newVc = vc || _bumpVcJson(existing.vc, deletedBy || this.deviceId);
    const r = this._stmts.softDeleteItemStmt.run(
      nowIso, deletedBy || this.deviceId, nowIso, newVc, this.tenantId, itemId
    );
    return r.changes > 0;
  }

  /**
   * Soft-delete a space. Items inside are NOT cascade-tombstoned
   * (matching SpacesAPI semantics where deleting a space requires
   * the items to be moved out first; the event surface fires
   * `space:deleted` only when the space is empty).
   */
  softDeleteSpace({ spaceId, deletedBy, deletedAt, vc } = {}) {
    this._assertOpen();
    if (!spaceId) throw new Error('Replica.softDeleteSpace: spaceId required');
    const existing = this._stmts.getSpace.get(this.tenantId, spaceId);
    if (!existing) return false;
    const nowIso = deletedAt || new Date().toISOString();
    const newVc = vc || _bumpVcJson(existing.vc, deletedBy || this.deviceId);
    const r = this._stmts.softDeleteSpaceStmt.run(
      nowIso, deletedBy || this.deviceId, nowIso, newVc, this.tenantId, spaceId
    );
    return r.changes > 0;
  }

  /**
   * Reassign an item's space_id (without writing to the rest of the
   * row). Bumps vc. Used by the shadow-writer for item:moved and
   * items:bulk-moved events. Returns true if a row was updated.
   */
  moveItem({ itemId, toSpaceId, modifiedAt, vc } = {}) {
    this._assertOpen();
    if (!itemId) throw new Error('Replica.moveItem: itemId required');
    if (!toSpaceId) throw new Error('Replica.moveItem: toSpaceId required');
    const existing = this._stmts.getItem.get(this.tenantId, itemId);
    if (!existing) return false;
    const nowIso = modifiedAt || new Date().toISOString();
    const newVc = vc || _bumpVcJson(existing.vc, this.deviceId);
    const r = this._stmts.moveItemStmt.run(
      toSpaceId, nowIso, newVc, this.tenantId, itemId
    );
    return r.changes > 0;
  }

  // ---------------------------------------------------------------------------
  // Smart folders (commit C; not in the commit-A scaffold)
  // ---------------------------------------------------------------------------

  upsertSmartFolder(folder) {
    this._assertOpen();
    if (!folder || !folder.id) {
      throw new Error('Replica.upsertSmartFolder: folder.id required');
    }
    const nowIso = new Date().toISOString();
    this._stmts.upsertSmartFolderStmt.run({
      tenant_id: this.tenantId,
      id: String(folder.id),
      name: folder.name || folder.id,
      icon: folder.icon || null,
      color: folder.color || null,
      criteria: typeof folder.criteria === 'string'
        ? folder.criteria
        : JSON.stringify(folder.criteria || {}),
      created_at: folder.created_at || folder.createdAt || nowIso,
      updated_at: folder.updated_at || folder.updatedAt || nowIso,
    });
    return folder.id;
  }

  getSmartFolder(id) {
    this._assertOpen();
    const row = this._stmts.getSmartFolderStmt.get(this.tenantId, id);
    if (!row) return null;
    return {
      ...row,
      criteria: _safeParseJson(row.criteria) || {},
    };
  }

  /**
   * Hard-delete: smart_folders don't have an `active` column in the
   * commit-A schema, and they're cheap to recreate from criteria.
   * Returns true if a row was removed.
   */
  deleteSmartFolder(id) {
    this._assertOpen();
    const r = this._stmts.deleteSmartFolderStmt.run(this.tenantId, id);
    return r.changes > 0;
  }

  // ---------------------------------------------------------------------------
  // VC helper exposed for the shadow-writer (which bumps the vc on
  // every mirrored write) and for tests that want to reason about the
  // clock state of a row without recomputing it themselves.
  // ---------------------------------------------------------------------------

  /**
   * Read the current vc for an item; null if the item doesn't exist.
   * Returns the JSON-encoded form (matches the column type) so callers
   * can pass it back unchanged into upsertItem.
   */
  getItemVc(itemId) {
    this._assertOpen();
    const row = this._stmts.getItem.get(this.tenantId, itemId);
    return row ? row.vc : null;
  }

  /**
   * Read the current vc for a space; null if not found.
   */
  getSpaceVc(spaceId) {
    this._assertOpen();
    const row = this._stmts.getSpace.get(this.tenantId, spaceId);
    return row ? row.vc : null;
  }

  /**
   * Compute the next vc for a write originating from `deviceId`.
   * Pure-function shape so the shadow-writer can call it without
   * needing to read the existing row twice. Increments deviceId's slot
   * by 1; leaves all other slots unchanged.
   */
  bumpVc(currentVcJson, deviceId) {
    return _bumpVcJson(currentVcJson, deviceId || this.deviceId);
  }

  // ---------------------------------------------------------------------------
  // replica_meta
  // ---------------------------------------------------------------------------

  getMeta(key) {
    this._assertOpen();
    const row = this._stmts.getMeta.get(this.tenantId, key);
    return row ? row.value : null;
  }

  setMeta(key, value) {
    this._assertOpen();
    this._stmts.setMeta.run(this.tenantId, key, String(value));
  }

  // ---------------------------------------------------------------------------
  // Diagnostics
  // ---------------------------------------------------------------------------

  /**
   * Returns a snapshot of the replica's state suitable for the
   * /sync/queue and /sync/health diagnostics endpoints. Cheap; reads
   * a handful of indexed counts. Does not load any item bodies.
   */
  inspect() {
    this._assertOpen();
    const spaces = this._stmts.countSpaces.get(this.tenantId).n;
    const items = this._stmts.countItems.get(this.tenantId).n;
    const smartFolders = this._stmts.countSmartFoldersStmt
      ? this._stmts.countSmartFoldersStmt.get(this.tenantId).n
      : 0;
    return {
      dbPath: this.dbPath,
      tenantId: this.tenantId,
      deviceId: this.deviceId,
      schemaVersion: this.schemaVersion,
      compiledInSchemaVersion: SCHEMA_VERSION,
      readonly: this.readonly,
      fts5Available: !!this.fts5Available,
      fts5Error: this.fts5Error || null,
      noShadowPaths: this.noShadowPaths.slice(),
      tombstoneRetentionDays: this.tombstoneRetentionDays || null,
      counts: { spaces, items, smartFolders },
      meta: {
        cursor: this.getMeta('cursor') || '',
        lastFullPullAt: this.getMeta('lastFullPullAt') || '',
        replicaCreatedAt: this.getMeta('replicaCreatedAt') || '',
        migratedFromClipboardStorageAt: this.getMeta('migratedFromClipboardStorageAt') || '',
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  _assertOpen() {
    if (!this._opened) {
      throw new Error('Replica: not opened; call init() first.');
    }
  }
}

// ---------------------------------------------------------------------------
// Row normalisation helpers (pure functions, exported for testing)
// ---------------------------------------------------------------------------

/**
 * Coerce a caller-supplied space object into the shape the
 * insertSpace prepared statement expects. Defaults the vc to '{}',
 * timestamps to now, and handles boolean -> integer translation.
 */
function _normaliseSpaceRow(tenantId, space) {
  if (!space || !space.id) {
    throw new Error('Replica.upsertSpace: space.id is required');
  }
  const nowIso = new Date().toISOString();
  return {
    tenant_id: tenantId,
    id: String(space.id),
    name: space.name || space.id,
    icon: space.icon || null,
    color: space.color || null,
    is_system: space.is_system ? 1 : (space.isSystem ? 1 : 0),
    created_at: space.created_at || space.createdAt || nowIso,
    updated_at: space.updated_at || space.updatedAt || nowIso,
    vc: typeof space.vc === 'string' ? space.vc : (space.vc ? JSON.stringify(space.vc) : '{}'),
    active: space.active === undefined ? 1 : (space.active ? 1 : 0),
  };
}

/**
 * Coerce a caller-supplied item object into the insertItem shape.
 * Mirrors the column list 1:1 so the prepared statement's named
 * parameters all bind. Tags are JSON-encoded for the items.tags
 * column (the denorm join is populated separately).
 */
function _normaliseItemRow(tenantId, item) {
  if (!item || !item.id) {
    throw new Error('Replica.upsertItem: item.id is required');
  }
  if (!item.type) {
    throw new Error('Replica.upsertItem: item.type is required');
  }
  const nowIso = new Date().toISOString();
  const tagsArray = Array.isArray(item.tags) ? item.tags : (typeof item.tags === 'string' ? _parseTagsField(item.tags) : []);
  return {
    tenant_id: tenantId,
    id: String(item.id),
    type: String(item.type),
    space_id: item.space_id || item.spaceId || 'unclassified',
    timestamp: typeof item.timestamp === 'number' ? item.timestamp : Date.now(),
    preview: item.preview || null,
    content_path: item.content_path || item.contentPath || null,
    thumbnail_path: item.thumbnail_path || item.thumbnailPath || null,
    metadata_path: item.metadata_path || item.metadataPath || null,
    tags: JSON.stringify(tagsArray),
    pinned: item.pinned ? 1 : 0,
    file_name: item.file_name || item.fileName || null,
    file_size: typeof item.file_size === 'number' ? item.file_size : (typeof item.fileSize === 'number' ? item.fileSize : null),
    file_type: item.file_type || item.fileType || null,
    file_category: item.file_category || item.fileCategory || null,
    file_ext: item.file_ext || item.fileExt || null,
    is_screenshot: item.is_screenshot ? 1 : (item.isScreenshot ? 1 : 0),
    json_subtype: item.json_subtype || item.jsonSubtype || null,
    source: item.source || null,
    metadata_source: item.metadata_source || item.metadataSource || null,
    content_hash: item.content_hash || item.contentHash || null,
    vc: typeof item.vc === 'string' ? item.vc : (item.vc ? JSON.stringify(item.vc) : '{}'),
    active: item.active === undefined ? 1 : (item.active ? 1 : 0),
    deleted_at: item.deleted_at || item.deletedAt || null,
    deleted_by: item.deleted_by || item.deletedBy || null,
    created_at: item.created_at || item.createdAt || nowIso,
    modified_at: item.modified_at || item.modifiedAt || nowIso,
    has_parked_precursor: item.has_parked_precursor ? 1 : (item.hasParkedPrecursor ? 1 : 0),
  };
}

/**
 * Bump deviceId's slot in a JSON-encoded VectorClock by 1, leaving
 * all other slots unchanged. Returns the new JSON-encoded string.
 *
 * Used by softDeleteItem / softDeleteSpace / moveItem and by the
 * shadow-writer to maintain causal monotonicity on every write.
 *
 *   _bumpVcJson('{}', 'devA')           -> '{"devA":1}'
 *   _bumpVcJson('{"devA":3}', 'devA')   -> '{"devA":4}'
 *   _bumpVcJson('{"devA":3}', 'devB')   -> '{"devA":3,"devB":1}'
 */
function _bumpVcJson(currentJson, deviceId) {
  if (!deviceId) {
    throw new Error('_bumpVcJson: deviceId is required');
  }
  let vc = {};
  if (typeof currentJson === 'string' && currentJson.length > 0) {
    try {
      const parsed = JSON.parse(currentJson);
      if (parsed && typeof parsed === 'object') vc = parsed;
    } catch (_err) {
      // Malformed vc: treat as empty (data corruption recovery; the
      // bump still produces a valid clock).
    }
  } else if (currentJson && typeof currentJson === 'object') {
    vc = { ...currentJson };
  }
  vc[deviceId] = (typeof vc[deviceId] === 'number' ? vc[deviceId] : 0) + 1;
  return JSON.stringify(vc);
}

/**
 * Parse the items.tags column (JSON-encoded string array) safely.
 * Returns [] for malformed input rather than throwing -- a malformed
 * tag string is data corruption, not a query error, and shouldn't
 * crash the renderer that's trying to display the item.
 */
function _parseTagsField(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_err) {
    return [];
  }
}

/**
 * Safe JSON parse: returns null on malformed input rather than
 * throwing. Used by getSmartFolder() to surface criteria as a
 * parsed object even if a row has corrupted JSON.
 */
function _safeParseJson(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return JSON.parse(value);
  } catch (_err) {
    return null;
  }
}

/**
 * Re-attach the tags array to a raw item row (the items.tags column
 * is JSON; we surface it as a parsed array in the public shape).
 * Caller passes the tags from item_tags as the canonical source so
 * this helper stays pure.
 */
function _hydrateItemRow(row, tags) {
  return {
    ...row,
    tags: Array.isArray(tags) && tags.length ? tags : _parseTagsField(row.tags),
    pinned: !!row.pinned,
    is_screenshot: !!row.is_screenshot,
    active: !!row.active,
    has_parked_precursor: !!row.has_parked_precursor,
  };
}

/**
 * Minimal glob matcher for the no-shadow patterns. Supports:
 *   - '*' matching any non-slash sequence within a path segment
 *   - '**' matching any sequence including slashes
 * Sufficient for the patterns we use (gsx-agent/*.md,
 * gsx-agent/**\/secret.md, etc.). Anchored to whole-string match.
 */
function _matchGlob(pattern, str) {
  const re = '^' + pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // escape regex metacharacters
    .replace(/\*\*/g, '\u0000')             // mark **
    .replace(/\*/g, '[^/]*')                // single * = no slashes
    .replace(/\u0000/g, '.*')               // ** = anything
    + '$';
  return new RegExp(re).test(str);
}

// ---------------------------------------------------------------------------
// Singleton factory
// ---------------------------------------------------------------------------

const _instances = new Map();

/**
 * Returns a process-wide singleton Replica for the given (dbPath,
 * tenantId) pair. Tests should construct Replica directly with
 * dbPath = ':memory:' to keep instances isolated.
 */
function getReplica(opts = {}) {
  const key = `${opts.tenantId || 'default'}::${opts.dbPath || ''}`;
  let inst = _instances.get(key);
  if (!inst) {
    inst = new Replica(opts);
    _instances.set(key, inst);
  }
  return inst;
}

/**
 * Test-only: clear the singleton map so each test starts fresh.
 * NOT exported on the public surface; tests reach in by name.
 */
function _resetReplicaSingletons() {
  for (const inst of _instances.values()) {
    try { inst.close(); } catch (_e) { /* swallow during reset */ }
  }
  _instances.clear();
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  Replica,
  getReplica,
  // pure helpers exported for testing
  _normaliseSpaceRow,
  _normaliseItemRow,
  _parseTagsField,
  _hydrateItemRow,
  _matchGlob,
  _bumpVcJson,
  _resetReplicaSingletons,
};
