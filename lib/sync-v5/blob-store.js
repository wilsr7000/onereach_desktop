/**
 * Content-addressed blob store interface (v5 Section 3.2)
 *
 * Bodies (clipboard text, images, video, files) live keyed by `sha256(content)`.
 * `:Asset.contentHash` points at a retrievable blob -- no "file not found"
 * path. The interface here is the contract; Phase 2 ships:
 *   - `BlobStoreInterface` -- documented contract every backend implements
 *   - `LocalBlobStore` -- writes blobs to a content-addressed local directory
 *     under userData/sync-v5/blobs/. Used in tests and as a Phase 2 placeholder.
 *   - `NoopBlobStore` -- "no upload, just record the hash" mode for early
 *     dev/test. Always reports success.
 *
 * Phase 3 ships:
 *   - `GsxBlobStore` -- the production implementation that uploads to
 *     GSX Files (`PUT /files/<sha256>`) idempotently. The IPC + auth path
 *     for that is a separate effort; this module shows where it plugs in.
 *
 * The 4-step write protocol in v5 Section 4.5 is:
 *   (1) compute hash + traceId
 *   (2) blobStore.upload(hash, content, { traceId })
 *   (3) graph tx { upsert :Asset, bump vc, write :OperationLog }
 *   (4) local mark-and-remove
 * If step 2 fails, queue retains op; nothing in graph; nothing orphaned.
 * If step 3 fails, blob is unreferenced; weekly sweeper collects after
 * 7-day grace window.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { isValidTraceId } = require('./trace-id');
const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

/**
 * Compute the SHA-256 of a buffer or string. The blob store is keyed by
 * this hash; `:Asset.contentHash` references it.
 *
 * @param {Buffer|string} content
 * @returns {string} 64-char hex
 */
function computeContentHash(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content || '', 'utf8');
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Documented interface every blob backend implements. Not enforced by
 * inheritance (this is JS), but tested by the sync engine's unit tests.
 *
 * Methods:
 *   - async upload(hash, content, { traceId }) -> { hash, alreadyPresent, byteCount }
 *       idempotent: if a blob at `hash` already exists with the same hash,
 *       return immediately with alreadyPresent=true.
 *       throws on auth/network failure -- the sync engine's retry logic
 *       handles that.
 *   - async exists(hash) -> boolean
 *   - async fetch(hash) -> Buffer
 *       throws if not found; degraded UI path is the caller's responsibility.
 *   - name -> string -- for diagnostics/logging
 */

class NoopBlobStore {
  constructor() {
    this.name = 'noop';
    this._uploads = []; // for tests
  }

  async upload(hash, content, ctx = {}) {
    if (typeof hash !== 'string' || hash.length !== 64) {
      throw new Error(`upload: hash must be 64-hex, got ${typeof hash}/${hash?.length}`);
    }
    if (ctx.traceId && !isValidTraceId(ctx.traceId)) {
      throw new Error(`upload: invalid traceId ${ctx.traceId}`);
    }
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content || '', 'utf8');
    this._uploads.push({ hash, byteCount: buf.length, traceId: ctx.traceId || null });
    return { hash, alreadyPresent: false, byteCount: buf.length };
  }

  async exists(_hash) {
    return false;
  }

  async fetch(hash) {
    throw new Error(`NoopBlobStore: fetch not supported (hash=${hash})`);
  }
}

/**
 * Local content-addressed store. Writes blobs under
 *   `userData/sync-v5/blobs/<first 2 of hash>/<remaining hex>`.
 *
 * Idempotent: if a blob at the path exists, upload returns alreadyPresent=true.
 *
 * Used in tests and as a Phase 2 placeholder until GsxBlobStore lands. Also
 * useful as a permanent local content cache (the v5 architecture has the
 * device cache blobs locally; this is exactly that shape).
 */
class LocalBlobStore {
  /**
   * @param {object} [opts]
   * @param {string} [opts.rootDir]
   */
  constructor(opts = {}) {
    this.name = 'local';
    this._root = opts.rootDir || _defaultBlobRoot();
    fs.mkdirSync(this._root, { recursive: true });
  }

  _pathFor(hash) {
    return path.join(this._root, hash.slice(0, 2), hash.slice(2));
  }

  async upload(hash, content, ctx = {}) {
    if (typeof hash !== 'string' || hash.length !== 64) {
      throw new Error(`upload: hash must be 64-hex, got ${typeof hash}/${hash?.length}`);
    }
    if (ctx.traceId && !isValidTraceId(ctx.traceId)) {
      throw new Error(`upload: invalid traceId ${ctx.traceId}`);
    }
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content || '', 'utf8');
    // Verify the hash matches the content -- defense in depth against
    // upstream hash bugs.
    const computed = crypto.createHash('sha256').update(buf).digest('hex');
    if (computed !== hash) {
      throw new Error(
        `upload: hash mismatch (computed ${computed.slice(0, 12)}..., declared ${hash.slice(0, 12)}...)`
      );
    }

    const target = this._pathFor(hash);
    if (fs.existsSync(target)) {
      // Idempotent: same hash already exists. The byte-by-byte content is
      // identical by definition (SHA-256 collision resistance).
      return { hash, alreadyPresent: true, byteCount: buf.length };
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
    try {
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, target);
    } catch (err) {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch (_) {
        /* ignore cleanup */
      }
      throw err;
    }
    log.debug('sync-v5', 'LocalBlobStore upload', {
      hash: hash.slice(0, 12) + '...',
      byteCount: buf.length,
      traceId: ctx.traceId,
    });
    return { hash, alreadyPresent: false, byteCount: buf.length };
  }

  async exists(hash) {
    if (typeof hash !== 'string' || hash.length !== 64) return false;
    return fs.existsSync(this._pathFor(hash));
  }

  async fetch(hash) {
    if (typeof hash !== 'string' || hash.length !== 64) {
      throw new Error(`fetch: hash must be 64-hex, got ${typeof hash}/${hash?.length}`);
    }
    const p = this._pathFor(hash);
    if (!fs.existsSync(p)) {
      throw new Error(`LocalBlobStore: blob not found for hash ${hash.slice(0, 12)}...`);
    }
    return fs.readFileSync(p);
  }

  /**
   * Used by the diagnostics surface to report local cache size.
   * @returns {{ blobCount:number, totalBytes:number }}
   */
  inspect() {
    let count = 0;
    let bytes = 0;
    try {
      if (!fs.existsSync(this._root)) return { blobCount: 0, totalBytes: 0 };
      const buckets = fs.readdirSync(this._root);
      for (const b of buckets) {
        const bucketDir = path.join(this._root, b);
        if (!fs.statSync(bucketDir).isDirectory()) continue;
        const files = fs.readdirSync(bucketDir);
        for (const f of files) {
          if (f.endsWith('.tmp')) continue;
          count++;
          try {
            bytes += fs.statSync(path.join(bucketDir, f)).size;
          } catch (_) {
            /* ignore stale entry */
          }
        }
      }
    } catch (_) {
      /* return what we have */
    }
    return { blobCount: count, totalBytes: bytes };
  }
}

function _defaultBlobRoot() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'sync-v5', 'blobs');
    }
  } catch (_) {
    /* not in electron context */
  }
  return path.join(require('os').tmpdir(), 'sync-v5-test', 'blobs');
}

module.exports = {
  computeContentHash,
  NoopBlobStore,
  LocalBlobStore,
};
