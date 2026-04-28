/**
 * Cold-device migration: clipboard-storage-v2 -> Replica.
 *
 * Per docs/sync-v5/replica-shape.md §4 (initial population). Runs
 * once on first boot after `syncV5.replica.enabled` flips true. Reads
 * the existing local data (DuckDB index + per-item metadata.json +
 * body files on disk) and projects it into the SQLite replica.
 *
 * The migration is one-shot, idempotent, and isolated: a per-item
 * failure logs + skips + continues; total failure leaves the replica
 * in whatever state it had reached so a re-run can pick up where the
 * previous one left off.
 *
 * What this commit (B) ships:
 *   - Spaces walk: every entry in storage.index.spaces becomes a
 *     replica row.
 *   - Items walk: every entry in storage.index.items becomes a
 *     replica row, plus a content_hash if the body can be read.
 *   - Content blob upload: bodies are SHA-256 hashed and written to
 *     the blob store keyed by hash. Idempotent at the blob layer
 *     (LocalBlobStore.upload skips already-present hashes).
 *   - vc initialisation: every migrated row gets `vc = { [deviceId]: 1 }`.
 *     From the v5 perspective every existing item is "this device's
 *     first version" -- no causal relationship with any other device
 *     until that device's writes start landing.
 *   - replica_meta updates:
 *       'migratedFromClipboardStorageAt' -- ISO timestamp of when
 *         migration completed (separate from 'lastFullPullAt' so
 *         "did the catalog migrate?" and "did a full graph pull
 *         happen?" are distinguishable).
 *       'migrationStats' -- JSON summary so the diagnostics
 *         endpoint can surface counts without re-reading the DB.
 *
 * Out of scope (deferred to commits C/D):
 *   - Smart folder migration (smart-folders are spaces-API-side only;
 *     ship in commit C with the shadow-write surface).
 *   - Pull-engine wiring to the replica (commit D when applyMode
 *     flips from 'noop' to 'sqlite').
 *   - Background re-hash of items whose content_hash is null because
 *     the body was unreadable at migration time (commit C / a
 *     periodic warmup task).
 *
 * Testing strategy: every collaborator (replica, storage, blobStore,
 * fs, hash, logger) is dependency-injected so the test suite can
 * stub them with in-memory fakes and assert the migration's behaviour
 * end-to-end without touching a real DuckDB or filesystem.
 */

'use strict';

const fsDefault = require('fs');
const pathDefault = require('path');
const cryptoDefault = require('crypto');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the cold-device migration.
 *
 * @param {object} args
 * @param {object} args.replica  -- An initialised Replica instance.
 * @param {object} args.storage  -- The clipboard-storage-v2 singleton:
 *   must expose `index.spaces[]`, `index.items[]`, `itemsDir` (string,
 *   absolute path), and `loadItem(itemId)`.
 * @param {string} args.deviceId -- The local device's stable ID.
 *   Used to seed `vc = { [deviceId]: 1 }` for every migrated row.
 * @param {object} [args.blobStore] -- Optional; if provided, bodies
 *   are uploaded keyed by SHA-256. Pass null/undefined to skip blob
 *   uploads (catalog-only migration).
 * @param {object} [args.fs=fs]   -- Filesystem module (testable).
 * @param {object} [args.path=path] -- Path module (testable).
 * @param {function} [args.hash]  -- (buffer:Buffer) => string. Defaults
 *   to SHA-256 hex via the node crypto module.
 * @param {object} [args.logger] -- { info, warn, error, debug }.
 * @param {boolean} [args.force=false] -- Re-run even if migration
 *   already completed (replica_meta.migratedFromClipboardStorageAt
 *   is set).
 * @param {boolean} [args.skipContent=false] -- Skip body load + hash;
 *   migrate index metadata only. Useful for tests and for an
 *   emergency-fast catalog-only pass that wants to defer hashing.
 *
 * @returns {Promise<MigrationResult>} a plain object summarising
 *   what was migrated. The same shape is also persisted as
 *   replica_meta.migrationStats so the /sync/queue diagnostics
 *   endpoint can read it without re-running.
 *
 * @typedef {object} MigrationResult
 * @property {boolean} ran             -- false if skipped (already migrated and not forced)
 * @property {string}  startedAt        -- ISO timestamp
 * @property {string}  finishedAt       -- ISO timestamp
 * @property {number}  durationMs
 * @property {number}  spacesMigrated
 * @property {number}  itemsMigrated
 * @property {number}  contentHashed    -- count of items whose body was hashed + blob-uploaded
 * @property {number}  contentSkipped   -- count of items whose body was unreadable / skipped
 * @property {number}  blobBytesWritten -- total bytes added to the blob store (zero for already-present hashes)
 * @property {Array<{itemId: string, error: string}>} errors -- per-item failures, each isolated
 */
async function migrateFromClipboardStorage(args) {
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();

  const {
    replica,
    storage,
    deviceId,
    blobStore = null,
    fs: fsDep = fsDefault,
    path: pathDep = pathDefault,
    hash: hashFn = _sha256Hex,
    logger = _silentLogger(),
    force = false,
    skipContent = false,
  } = args || {};

  if (!replica) throw new Error('migrateFromClipboardStorage: replica is required');
  if (!storage) throw new Error('migrateFromClipboardStorage: storage is required');
  if (!deviceId) throw new Error('migrateFromClipboardStorage: deviceId is required');

  // Idempotency check: if migration already completed and force isn't
  // set, return a "skipped" result. The replica is in whatever state
  // the previous run left it; the caller can read replica_meta to
  // see the last successful timestamp.
  const previousMigratedAt = _getMeta(replica, 'migratedFromClipboardStorageAt');
  if (previousMigratedAt && !force) {
    logger.info('replica/migrate', 'Skipping migration -- already completed', {
      migratedAt: previousMigratedAt,
    });
    return {
      ran: false,
      startedAt,
      finishedAt: startedAt,
      durationMs: 0,
      spacesMigrated: 0,
      itemsMigrated: 0,
      contentHashed: 0,
      contentSkipped: 0,
      blobBytesWritten: 0,
      errors: [],
      previousMigratedAt,
    };
  }

  logger.info('replica/migrate', 'Starting cold-device migration', {
    deviceId,
    skipContent,
    blobStoreEnabled: !!blobStore,
  });

  // Initialise vc once -- every migrated row carries the same value.
  const initialVc = JSON.stringify({ [deviceId]: 1 });

  // ---------------------------------------------------------------------------
  // Spaces walk
  // ---------------------------------------------------------------------------
  let spacesMigrated = 0;
  const spaces = (storage.index && Array.isArray(storage.index.spaces)) ? storage.index.spaces : [];
  for (const sp of spaces) {
    try {
      replica.upsertSpace({
        id: sp.id,
        name: sp.name || sp.id,
        icon: sp.icon || null,
        color: sp.color || null,
        is_system: !!sp.isSystem,
        created_at: sp.createdAt || sp.created_at || startedAt,
        updated_at: sp.updatedAt || sp.updated_at || startedAt,
        vc: initialVc,
        active: true,
      });
      spacesMigrated++;
    } catch (err) {
      logger.warn('replica/migrate', 'Space migration failed; skipping', {
        spaceId: sp && sp.id,
        error: err.message,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Items walk
  // ---------------------------------------------------------------------------
  let itemsMigrated = 0;
  let contentHashed = 0;
  let contentSkipped = 0;
  let blobBytesWritten = 0;
  const errors = [];

  const items = (storage.index && Array.isArray(storage.index.items)) ? storage.index.items : [];
  for (const it of items) {
    try {
      // Default content_hash to whatever the index already has
      // (rare; new items don't carry one yet).
      let contentHash = it.contentHash || it.content_hash || null;

      if (!skipContent && blobStore) {
        const hashed = await _hashAndUploadBody({
          item: it,
          storage,
          blobStore,
          fs: fsDep,
          path: pathDep,
          hash: hashFn,
          logger,
        });
        if (hashed.contentHash) {
          contentHash = hashed.contentHash;
          contentHashed++;
          blobBytesWritten += hashed.bytesWritten;
        } else if (hashed.skipped) {
          contentSkipped++;
        }
      } else if (!skipContent && !blobStore && !contentHash) {
        // No blob store provided but caller wants content; just hash
        // for the row, don't upload. This is the fast-catalog case
        // where the user's blob store is the graph blob store and
        // hashes will be re-verified post-pull.
        const buf = await _readBodyBuffer(it, storage, fsDep, pathDep);
        if (buf) {
          contentHash = hashFn(buf);
          contentHashed++;
        } else {
          contentSkipped++;
        }
      }

      replica.upsertItem({
        id: it.id,
        type: it.type || 'unknown',
        space_id: it.spaceId || it.space_id || 'unclassified',
        timestamp: typeof it.timestamp === 'number' ? it.timestamp : Date.now(),
        preview: it.preview || null,
        content_path: it.contentPath || it.content_path || null,
        thumbnail_path: it.thumbnailPath || it.thumbnail_path || null,
        metadata_path: it.metadataPath || it.metadata_path || null,
        tags: Array.isArray(it.tags) ? it.tags : (typeof it.tags === 'string' ? _safeParseJson(it.tags) || [] : []),
        pinned: !!it.pinned,
        file_name: it.fileName || it.file_name || null,
        file_size: typeof it.fileSize === 'number' ? it.fileSize : (typeof it.file_size === 'number' ? it.file_size : null),
        file_type: it.fileType || it.file_type || null,
        file_category: it.fileCategory || it.file_category || null,
        file_ext: it.fileExt || it.file_ext || null,
        is_screenshot: !!it.isScreenshot,
        json_subtype: it.jsonSubtype || it.json_subtype || null,
        source: it.source || null,
        metadata_source: it.metadataSource || it.metadata_source || null,
        content_hash: contentHash,
        vc: initialVc,
        active: true,
        created_at: it.createdAt || it.created_at || startedAt,
        modified_at: it.modifiedAt || it.modified_at || startedAt,
      });
      itemsMigrated++;
    } catch (err) {
      errors.push({ itemId: it && it.id, error: err.message });
      logger.warn('replica/migrate', 'Item migration failed; isolated', {
        itemId: it && it.id,
        error: err.message,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Bookkeeping
  // ---------------------------------------------------------------------------
  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - startedAtMs;
  const result = {
    ran: true,
    startedAt,
    finishedAt,
    durationMs,
    spacesMigrated,
    itemsMigrated,
    contentHashed,
    contentSkipped,
    blobBytesWritten,
    errors,
  };

  try {
    replica.setMeta('migratedFromClipboardStorageAt', finishedAt);
    replica.setMeta('migrationStats', JSON.stringify(result));
  } catch (err) {
    // Stats persistence is best-effort. The migration data is
    // already in the replica; failing to write stats just means the
    // diagnostics endpoint will show "stats unavailable" until next
    // run.
    logger.warn('replica/migrate', 'Stats persistence failed; non-fatal', { error: err.message });
  }

  logger.info('replica/migrate', 'Migration complete', {
    spacesMigrated,
    itemsMigrated,
    contentHashed,
    contentSkipped,
    durationMs,
    errors: errors.length,
  });

  return result;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Try to read an item's body bytes from disk via storage.loadItem +
 * direct fs reads. Returns null if not readable (file missing, item
 * type has no body, etc.).
 *
 * Strategy:
 *   1. If item has explicit contentPath, read that file.
 *   2. Else look in storage.itemsDir/<itemId>/ for the body file.
 *   3. If item.type is 'text' / 'url' and content is in the index
 *      entry as a string, encode it as UTF-8.
 *   4. Otherwise skip (return null).
 *
 * Defensive against missing fields and IO errors -- a per-item read
 * failure shouldn't cascade into a migration failure.
 */
async function _readBodyBuffer(item, storage, fs, path) {
  if (!item) return null;

  // Case 1: explicit contentPath that resolves on disk.
  const contentPath = item.contentPath || item.content_path || null;
  if (contentPath) {
    const abs = path.isAbsolute(contentPath)
      ? contentPath
      : (storage.storageRoot ? path.join(storage.storageRoot, contentPath) : contentPath);
    try {
      if (fs.existsSync(abs)) {
        const stat = fs.statSync(abs);
        if (stat.isFile()) return fs.readFileSync(abs);
      }
    } catch (_err) {
      // fall through; try the items-dir walk below
    }
  }

  // Case 2: items-dir walk.
  if (storage.itemsDir && item.id) {
    try {
      const itemDir = path.join(storage.itemsDir, item.id);
      if (fs.existsSync(itemDir)) {
        const candidates = fs.readdirSync(itemDir).filter((f) => {
          // Skip metadata + thumbnail + dotfiles.
          return !f.endsWith('.json') && !f.endsWith('.png') && !f.endsWith('.svg') && !f.startsWith('.');
        });
        if (candidates.length > 0) {
          // Prefer the largest file (heuristic: body > sidecar).
          let best = null;
          let bestSize = -1;
          for (const c of candidates) {
            const p = path.join(itemDir, c);
            try {
              const sz = fs.statSync(p).size;
              if (sz > bestSize) {
                best = p;
                bestSize = sz;
              }
            } catch (_e) { /* skip stale entry */ }
          }
          if (best) return fs.readFileSync(best);
        }
      }
    } catch (_err) {
      // fall through; try inline content
    }
  }

  // Case 3: inline content from index entry.
  const inline = item.content;
  if (typeof inline === 'string' && inline.length > 0) {
    return Buffer.from(inline, 'utf8');
  }
  if (Buffer.isBuffer(inline)) return inline;

  return null;
}

/**
 * Read body, hash, upload to blob store. Returns { contentHash,
 * bytesWritten, skipped }. Per-item failures are isolated -- a bad
 * read returns { skipped: true } rather than throwing.
 */
async function _hashAndUploadBody({ item, storage, blobStore, fs, path, hash, logger }) {
  let buf = null;
  try {
    buf = await _readBodyBuffer(item, storage, fs, path);
  } catch (err) {
    logger.warn('replica/migrate', 'Body read failed; skipping content hash', {
      itemId: item && item.id,
      error: err.message,
    });
    return { contentHash: null, bytesWritten: 0, skipped: true };
  }
  if (!buf) {
    return { contentHash: null, bytesWritten: 0, skipped: true };
  }

  let contentHash;
  try {
    contentHash = hash(buf);
    if (typeof contentHash !== 'string' || contentHash.length !== 64) {
      throw new Error(`hash function returned invalid value: ${contentHash}`);
    }
  } catch (err) {
    logger.warn('replica/migrate', 'Hash computation failed; skipping', {
      itemId: item && item.id,
      error: err.message,
    });
    return { contentHash: null, bytesWritten: 0, skipped: true };
  }

  let bytesWritten = 0;
  try {
    const r = await blobStore.upload(contentHash, buf);
    bytesWritten = r && !r.alreadyPresent ? (r.byteCount || buf.length) : 0;
  } catch (err) {
    logger.warn('replica/migrate', 'Blob upload failed; row will store hash without confirmed blob', {
      itemId: item && item.id,
      hash: contentHash.slice(0, 12) + '...',
      error: err.message,
    });
    // Keep the hash on the row even if upload failed -- shadow-write
    // (commit C) will re-attempt the upload when the item is next
    // touched.
  }

  return { contentHash, bytesWritten, skipped: false };
}

/**
 * Default SHA-256 hex hasher (replaceable in tests).
 */
function _sha256Hex(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '', 'utf8');
  return cryptoDefault.createHash('sha256').update(b).digest('hex');
}

/**
 * Cheap meta read that swallows errors; used in the idempotency
 * check where a missing key just means "first run".
 */
function _getMeta(replica, key) {
  try {
    return replica.getMeta(key);
  } catch (_err) {
    return null;
  }
}

function _safeParseJson(s) {
  try {
    return JSON.parse(s);
  } catch (_err) {
    return null;
  }
}

function _silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  migrateFromClipboardStorage,
  // Internals exported for testing.
  _readBodyBuffer,
  _hashAndUploadBody,
  _sha256Hex,
};
