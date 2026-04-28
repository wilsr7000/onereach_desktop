/**
 * Unit tests for lib/sync-v5/replica/migrate.js
 *
 * Covers cold-device migration end-to-end with all collaborators
 * stubbed:
 *   - Real (in-memory) Replica from lib/sync-v5/replica/replica.js
 *   - Fake storage with in-process index.spaces / index.items / itemsDir
 *   - Fake blobStore implementing { upload(hash, buf) }
 *   - Fake fs with a tiny vmemfs-like surface for body reads
 *
 * The migration is one-shot, idempotent, isolated per-item, and
 * dependency-injected for exactly this kind of testing. Tests should
 * complete in <100ms.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const path = require('path');
const { Replica } = require('../../../lib/sync-v5/replica/replica');
const {
  migrateFromClipboardStorage,
  _readBodyBuffer,
} = require('../../../lib/sync-v5/replica/migrate');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a Replica against :memory: for one test.
 */
function freshReplica({ tenantId = 'default', deviceId = 'dev-1' } = {}) {
  const r = new Replica({ dbPath: ':memory:', tenantId, deviceId }).init();
  return r;
}

/**
 * Tiny in-memory blobStore that records uploads. Mirrors the
 * LocalBlobStore.upload contract: returns { hash, alreadyPresent,
 * byteCount }.
 */
function fakeBlobStore() {
  const blobs = new Map();
  return {
    blobs,
    async upload(hash, buf) {
      if (typeof hash !== 'string' || hash.length !== 64) {
        throw new Error(`fake upload: invalid hash ${hash}`);
      }
      const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '', 'utf8');
      const already = blobs.has(hash);
      if (!already) blobs.set(hash, buffer);
      return { hash, alreadyPresent: already, byteCount: buffer.length };
    },
    async exists(hash) {
      return blobs.has(hash);
    },
  };
}

/**
 * Fake fs covering just the read paths migrate uses. files = Map<absPath, Buffer|null>.
 * If the value is null the path "exists" but isn't a regular file.
 */
function fakeFs(files = new Map(), dirs = new Set()) {
  return {
    files,
    dirs,
    existsSync(p) {
      return files.has(p) || dirs.has(p);
    },
    statSync(p) {
      if (dirs.has(p)) return { isFile: () => false, isDirectory: () => true, size: 0 };
      const buf = files.get(p);
      if (!buf && buf !== null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { isFile: () => true, isDirectory: () => false, size: buf.length };
    },
    readFileSync(p) {
      const buf = files.get(p);
      if (!buf) throw new Error(`fakeFs: ${p} not present`);
      return buf;
    },
    readdirSync(p) {
      if (!dirs.has(p)) throw new Error(`fakeFs: ${p} not a dir`);
      const prefix = p.endsWith('/') ? p : p + '/';
      const out = [];
      for (const f of files.keys()) {
        if (f.startsWith(prefix)) {
          const rest = f.slice(prefix.length);
          if (!rest.includes('/')) out.push(rest);
        }
      }
      return out;
    },
  };
}

let r = null;

beforeEach(() => {
  r = freshReplica();
});

afterEach(() => {
  if (r) try { r.close(); } catch (_e) { /* close-noise OK */ }
  r = null;
});

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

describe('migrateFromClipboardStorage -- argument validation', () => {
  it('throws if replica is missing', async () => {
    await expect(migrateFromClipboardStorage({ storage: {}, deviceId: 'd' }))
      .rejects.toThrow(/replica is required/);
  });

  it('throws if storage is missing', async () => {
    await expect(migrateFromClipboardStorage({ replica: r, deviceId: 'd' }))
      .rejects.toThrow(/storage is required/);
  });

  it('throws if deviceId is missing', async () => {
    await expect(migrateFromClipboardStorage({ replica: r, storage: {} }))
      .rejects.toThrow(/deviceId is required/);
  });
});

// ---------------------------------------------------------------------------
// Spaces walk
// ---------------------------------------------------------------------------

describe('migrateFromClipboardStorage -- spaces walk', () => {
  it('migrates all spaces from storage.index.spaces', async () => {
    const storage = {
      index: {
        spaces: [
          { id: 's1', name: 'Inbox', icon: 'inbox', isSystem: true,
            createdAt: '2026-04-01T00:00:00.000Z', updatedAt: '2026-04-02T00:00:00.000Z' },
          { id: 's2', name: 'Notes', icon: 'note', isSystem: false,
            createdAt: '2026-04-03T00:00:00.000Z', updatedAt: '2026-04-04T00:00:00.000Z' },
        ],
        items: [],
      },
      itemsDir: '/tmp/items-fake',
    };

    const result = await migrateFromClipboardStorage({
      replica: r,
      storage,
      deviceId: 'dev-1',
      skipContent: true,
    });

    expect(result.ran).toBe(true);
    expect(result.spacesMigrated).toBe(2);
    expect(r.getSpace('s1')).toMatchObject({ name: 'Inbox', is_system: 1 });
    expect(r.getSpace('s2')).toMatchObject({ name: 'Notes', is_system: 0 });
  });

  it('seeds vc = { [deviceId]: 1 } on every migrated space', async () => {
    const storage = { index: { spaces: [{ id: 's1', name: 'X' }], items: [] }, itemsDir: '/x' };
    await migrateFromClipboardStorage({ replica: r, storage, deviceId: 'my-device', skipContent: true });
    expect(r.getSpace('s1').vc).toBe(JSON.stringify({ 'my-device': 1 }));
  });

  it('handles missing spaces array gracefully', async () => {
    const result = await migrateFromClipboardStorage({
      replica: r,
      storage: { index: {}, itemsDir: '/x' },
      deviceId: 'd',
      skipContent: true,
    });
    expect(result.spacesMigrated).toBe(0);
  });

  it('isolates per-space failure', async () => {
    const storage = {
      index: {
        spaces: [
          { id: 's1', name: 'A' },
          { /* missing id -- will throw */ name: 'broken' },
          { id: 's3', name: 'C' },
        ],
        items: [],
      },
      itemsDir: '/x',
    };
    const result = await migrateFromClipboardStorage({
      replica: r, storage, deviceId: 'd', skipContent: true,
    });
    expect(result.spacesMigrated).toBe(2);
    expect(r.getSpace('s1')).not.toBeNull();
    expect(r.getSpace('s3')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Items walk -- skipContent path (catalog only)
// ---------------------------------------------------------------------------

describe('migrateFromClipboardStorage -- items walk (skipContent)', () => {
  it('migrates index entries with full metadata round-trip', async () => {
    const storage = {
      index: {
        spaces: [{ id: 's1', name: 'Inbox' }],
        items: [
          { id: 'i1', type: 'text', spaceId: 's1', timestamp: 1700000000000,
            preview: 'hello world', tags: ['a', 'b'], pinned: true, source: 'clip' },
          { id: 'i2', type: 'image', spaceId: 's1', timestamp: 1700000001000,
            preview: 'screenshot', tags: [], isScreenshot: true,
            fileName: 'screenshot.png', fileSize: 1234, fileType: 'image/png' },
        ],
      },
      itemsDir: '/x',
    };

    const result = await migrateFromClipboardStorage({
      replica: r, storage, deviceId: 'd1', skipContent: true,
    });

    expect(result.itemsMigrated).toBe(2);
    expect(result.contentHashed).toBe(0);

    const i1 = r.getItem('i1');
    expect(i1).toMatchObject({ type: 'text', space_id: 's1', preview: 'hello world', pinned: true });
    expect(i1.tags.sort()).toEqual(['a', 'b']);

    const i2 = r.getItem('i2');
    expect(i2).toMatchObject({
      type: 'image', file_name: 'screenshot.png', file_size: 1234,
      file_type: 'image/png', is_screenshot: true,
    });
  });

  it('seeds vc = { [deviceId]: 1 } on every migrated item', async () => {
    const storage = {
      index: { spaces: [], items: [{ id: 'i1', type: 'text' }] },
      itemsDir: '/x',
    };
    await migrateFromClipboardStorage({ replica: r, storage, deviceId: 'dev-7', skipContent: true });
    const raw = r.db.prepare('SELECT vc FROM items WHERE id = ?').get('i1');
    expect(raw.vc).toBe(JSON.stringify({ 'dev-7': 1 }));
  });

  it('handles tags as JSON-string in the index entry', async () => {
    const storage = {
      index: { spaces: [], items: [{ id: 'i1', type: 'text', tags: '["x","y"]' }] },
      itemsDir: '/x',
    };
    await migrateFromClipboardStorage({ replica: r, storage, deviceId: 'd', skipContent: true });
    expect(r.listItemTags('i1').sort()).toEqual(['x', 'y']);
  });

  it('isolates per-item failure into result.errors', async () => {
    const storage = {
      index: {
        spaces: [],
        items: [
          { id: 'i1', type: 'text' },
          { type: 'broken' /* no id; upsertItem throws */ },
          { id: 'i3', type: 'text' },
        ],
      },
      itemsDir: '/x',
    };
    const result = await migrateFromClipboardStorage({
      replica: r, storage, deviceId: 'd', skipContent: true,
    });
    expect(result.itemsMigrated).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/item\.id is required/);
  });

  it('preserves an existing index-level contentHash even when skipContent is true', async () => {
    const storage = {
      index: {
        spaces: [],
        items: [{ id: 'i1', type: 'text', contentHash: 'a'.repeat(64) }],
      },
      itemsDir: '/x',
    };
    await migrateFromClipboardStorage({ replica: r, storage, deviceId: 'd', skipContent: true });
    const i1 = r.getItem('i1');
    expect(i1.content_hash).toBe('a'.repeat(64));
  });
});

// ---------------------------------------------------------------------------
// Items walk -- with content hashing + blob upload
// ---------------------------------------------------------------------------

describe('migrateFromClipboardStorage -- with blob store', () => {
  it('hashes inline string content and uploads to blob store', async () => {
    const storage = {
      index: {
        spaces: [],
        items: [{ id: 'i1', type: 'text', content: 'hello world' }],
      },
      itemsDir: '/x',
    };
    const blob = fakeBlobStore();
    const result = await migrateFromClipboardStorage({
      replica: r, storage, deviceId: 'd', blobStore: blob,
    });

    expect(result.contentHashed).toBe(1);
    expect(result.contentSkipped).toBe(0);
    expect(blob.blobs.size).toBe(1);

    const i1 = r.getItem('i1');
    expect(i1.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('idempotent at the blob layer -- duplicate hashes report alreadyPresent', async () => {
    const storage = {
      index: {
        spaces: [],
        items: [
          { id: 'i1', type: 'text', content: 'same' },
          { id: 'i2', type: 'text', content: 'same' },
        ],
      },
      itemsDir: '/x',
    };
    const blob = fakeBlobStore();
    const result = await migrateFromClipboardStorage({
      replica: r, storage, deviceId: 'd', blobStore: blob,
    });

    expect(result.contentHashed).toBe(2);
    expect(blob.blobs.size).toBe(1); // dedup at the blob layer
    expect(r.getItem('i1').content_hash).toBe(r.getItem('i2').content_hash);
  });

  it('blobBytesWritten counts only NEW bytes (already-present uploads count zero)', async () => {
    const storage = {
      index: {
        spaces: [],
        items: [
          { id: 'i1', type: 'text', content: 'aaa' },
          { id: 'i2', type: 'text', content: 'aaa' },
        ],
      },
      itemsDir: '/x',
    };
    const blob = fakeBlobStore();
    const result = await migrateFromClipboardStorage({
      replica: r, storage, deviceId: 'd', blobStore: blob,
    });
    expect(result.blobBytesWritten).toBe(3);
  });

  it('blob upload failure: row keeps the hash but counts as upload error (still hashed)', async () => {
    const storage = {
      index: {
        spaces: [],
        items: [{ id: 'i1', type: 'text', content: 'oops' }],
      },
      itemsDir: '/x',
    };
    const flakyBlob = {
      async upload() { throw new Error('disk full'); },
    };
    const result = await migrateFromClipboardStorage({
      replica: r, storage, deviceId: 'd', blobStore: flakyBlob,
    });
    expect(result.contentHashed).toBe(1);
    expect(r.getItem('i1').content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads body from disk when content is not inline', async () => {
    const itemsDir = '/items';
    const itemDir = path.join(itemsDir, 'i1');
    const bodyPath = path.join(itemDir, 'body.txt');
    const fs = fakeFs(
      new Map([[bodyPath, Buffer.from('on-disk content')]]),
      new Set([itemDir])
    );
    const storage = {
      itemsDir,
      index: { spaces: [], items: [{ id: 'i1', type: 'file' }] },
    };
    const blob = fakeBlobStore();
    const result = await migrateFromClipboardStorage({
      replica: r, storage, deviceId: 'd', blobStore: blob, fs,
    });
    expect(result.contentHashed).toBe(1);
    expect(blob.blobs.size).toBe(1);
  });

  it('counts contentSkipped when no body is readable', async () => {
    const storage = {
      itemsDir: '/no-such-dir',
      index: { spaces: [], items: [{ id: 'i1', type: 'file' }] },
    };
    const fs = fakeFs(new Map(), new Set()); // no files, no dirs
    const blob = fakeBlobStore();
    const result = await migrateFromClipboardStorage({
      replica: r, storage, deviceId: 'd', blobStore: blob, fs,
    });
    expect(result.contentHashed).toBe(0);
    expect(result.contentSkipped).toBe(1);
    expect(r.getItem('i1').content_hash).toBeNull();
  });

  it('respects an injected hash function (pure-function override)', async () => {
    const storage = {
      index: { spaces: [], items: [{ id: 'i1', type: 'text', content: 'x' }] },
      itemsDir: '/x',
    };
    const blob = fakeBlobStore();
    const customHash = () => 'b'.repeat(64);
    const result = await migrateFromClipboardStorage({
      replica: r, storage, deviceId: 'd', blobStore: blob, hash: customHash,
    });
    expect(result.contentHashed).toBe(1);
    expect(r.getItem('i1').content_hash).toBe('b'.repeat(64));
  });

  it('rejects a hash function that returns garbage', async () => {
    const storage = {
      index: { spaces: [], items: [{ id: 'i1', type: 'text', content: 'x' }] },
      itemsDir: '/x',
    };
    const blob = fakeBlobStore();
    const result = await migrateFromClipboardStorage({
      replica: r, storage, deviceId: 'd', blobStore: blob, hash: () => 'too-short',
    });
    // Hash invalid -> contentSkipped; row migrated without hash.
    expect(result.contentSkipped).toBe(1);
    expect(result.contentHashed).toBe(0);
    expect(r.getItem('i1').content_hash).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('migrateFromClipboardStorage -- idempotency', () => {
  it('second run is a no-op (returns ran: false) without force', async () => {
    const storage = {
      index: { spaces: [{ id: 's1', name: 'A' }], items: [{ id: 'i1', type: 'text' }] },
      itemsDir: '/x',
    };

    const first = await migrateFromClipboardStorage({
      replica: r, storage, deviceId: 'd', skipContent: true,
    });
    expect(first.ran).toBe(true);
    expect(first.itemsMigrated).toBe(1);

    const second = await migrateFromClipboardStorage({
      replica: r, storage, deviceId: 'd', skipContent: true,
    });
    expect(second.ran).toBe(false);
    expect(second.itemsMigrated).toBe(0);
    expect(second.previousMigratedAt).toBe(first.finishedAt);
  });

  it('force: true re-runs the migration', async () => {
    const storage = {
      index: { spaces: [], items: [{ id: 'i1', type: 'text' }] },
      itemsDir: '/x',
    };
    const first = await migrateFromClipboardStorage({
      replica: r, storage, deviceId: 'd', skipContent: true,
    });
    const second = await migrateFromClipboardStorage({
      replica: r, storage, deviceId: 'd', skipContent: true, force: true,
    });
    expect(first.ran).toBe(true);
    expect(second.ran).toBe(true);
  });

  it('persists migrationStats to replica_meta for diagnostics', async () => {
    const storage = {
      index: { spaces: [{ id: 's1', name: 'A' }], items: [{ id: 'i1', type: 'text' }] },
      itemsDir: '/x',
    };
    await migrateFromClipboardStorage({ replica: r, storage, deviceId: 'd', skipContent: true });
    const stats = JSON.parse(r.getMeta('migrationStats'));
    expect(stats).toMatchObject({ ran: true, spacesMigrated: 1, itemsMigrated: 1 });
  });
});

// ---------------------------------------------------------------------------
// _readBodyBuffer pure helper
// ---------------------------------------------------------------------------

describe('_readBodyBuffer -- helper', () => {
  it('returns inline string content as a UTF-8 buffer', async () => {
    const buf = await _readBodyBuffer({ id: 'i1', content: 'hello' }, {}, fakeFs(), path);
    expect(buf).toEqual(Buffer.from('hello', 'utf8'));
  });

  it('returns inline Buffer content unchanged', async () => {
    const inputBuf = Buffer.from([1, 2, 3]);
    const buf = await _readBodyBuffer({ id: 'i1', content: inputBuf }, {}, fakeFs(), path);
    expect(buf).toEqual(inputBuf);
  });

  it('reads from contentPath when it resolves on disk', async () => {
    const fs = fakeFs(new Map([['/abs/body.txt', Buffer.from('disk-content')]]));
    const buf = await _readBodyBuffer(
      { id: 'i1', contentPath: '/abs/body.txt' },
      {},
      fs,
      path,
    );
    expect(buf).toEqual(Buffer.from('disk-content'));
  });

  it('walks itemsDir/<id>/ and prefers the largest non-sidecar file', async () => {
    const itemsDir = '/items';
    const itemDir = path.join(itemsDir, 'i1');
    const bigFile = path.join(itemDir, 'body.bin');
    const smallFile = path.join(itemDir, 'tiny.txt');
    const sidecar = path.join(itemDir, 'metadata.json');
    const fs = fakeFs(
      new Map([
        [bigFile, Buffer.alloc(100, 1)],
        [smallFile, Buffer.from('hi')],
        [sidecar, Buffer.from('{}')],
      ]),
      new Set([itemDir]),
    );
    const buf = await _readBodyBuffer({ id: 'i1' }, { itemsDir }, fs, path);
    expect(buf).toEqual(Buffer.alloc(100, 1));
  });

  it('returns null when no body is recoverable', async () => {
    const buf = await _readBodyBuffer({ id: 'i1' }, { itemsDir: '/nope' }, fakeFs(), path);
    expect(buf).toBeNull();
  });

  it('returns null for null/undefined item without throwing', async () => {
    expect(await _readBodyBuffer(null, {}, fakeFs(), path)).toBeNull();
    expect(await _readBodyBuffer(undefined, {}, fakeFs(), path)).toBeNull();
  });
});
