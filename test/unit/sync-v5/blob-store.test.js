/**
 * Unit tests for lib/sync-v5/blob-store.js
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const {
  computeContentHash,
  NoopBlobStore,
  LocalBlobStore,
} = require('../../../lib/sync-v5/blob-store');
const { newTraceId } = require('../../../lib/sync-v5/trace-id');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'blob-store-test-'));
}

describe('sync-v5 / blob-store', () => {
  describe('computeContentHash', () => {
    it('returns 64-hex SHA-256 of a string', () => {
      const h = computeContentHash('hello');
      expect(h).toHaveLength(64);
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    });

    it('matches Node crypto reference for buffers', () => {
      const buf = Buffer.from('world');
      const expected = crypto.createHash('sha256').update(buf).digest('hex');
      expect(computeContentHash(buf)).toBe(expected);
    });

    it('treats null/undefined as empty buffer', () => {
      const empty = crypto.createHash('sha256').update(Buffer.from('')).digest('hex');
      expect(computeContentHash(null)).toBe(empty);
      expect(computeContentHash(undefined)).toBe(empty);
    });
  });

  describe('NoopBlobStore', () => {
    it('records uploads but never persists', async () => {
      const store = new NoopBlobStore();
      const hash = computeContentHash('hi');
      const r = await store.upload(hash, 'hi', { traceId: newTraceId() });
      expect(r.alreadyPresent).toBe(false);
      expect(store._uploads).toHaveLength(1);
      expect(await store.exists(hash)).toBe(false);
    });

    it('rejects bad hashes and bad traceIds', async () => {
      const store = new NoopBlobStore();
      await expect(store.upload('not-a-hash', 'x')).rejects.toThrow(/64-hex/);
      await expect(store.upload('a'.repeat(64), 'x', { traceId: 'short' })).rejects.toThrow(
        /traceId/
      );
    });

    it('throws on fetch (noop has no storage)', async () => {
      const store = new NoopBlobStore();
      await expect(store.fetch('a'.repeat(64))).rejects.toThrow(/not supported/);
    });
  });

  describe('LocalBlobStore', () => {
    it('writes a blob to the content-addressed path', async () => {
      const root = tempRoot();
      const store = new LocalBlobStore({ rootDir: root });
      const content = 'hello sync-v5';
      const hash = computeContentHash(content);
      const r = await store.upload(hash, content);
      expect(r.alreadyPresent).toBe(false);
      const expectedPath = path.join(root, hash.slice(0, 2), hash.slice(2));
      expect(fs.existsSync(expectedPath)).toBe(true);
      expect(fs.readFileSync(expectedPath, 'utf8')).toBe(content);
    });

    it('is idempotent: second upload returns alreadyPresent=true', async () => {
      const store = new LocalBlobStore({ rootDir: tempRoot() });
      const content = 'idempotent';
      const hash = computeContentHash(content);
      await store.upload(hash, content);
      const r2 = await store.upload(hash, content);
      expect(r2.alreadyPresent).toBe(true);
    });

    it('rejects upload when declared hash does not match content', async () => {
      const store = new LocalBlobStore({ rootDir: tempRoot() });
      const wrongHash = 'a'.repeat(64);
      await expect(store.upload(wrongHash, 'real content')).rejects.toThrow(/hash mismatch/);
    });

    it('exists returns true after upload', async () => {
      const store = new LocalBlobStore({ rootDir: tempRoot() });
      const content = 'exists-check';
      const hash = computeContentHash(content);
      expect(await store.exists(hash)).toBe(false);
      await store.upload(hash, content);
      expect(await store.exists(hash)).toBe(true);
    });

    it('fetch returns the stored bytes', async () => {
      const store = new LocalBlobStore({ rootDir: tempRoot() });
      const content = 'fetch-me';
      const hash = computeContentHash(content);
      await store.upload(hash, content);
      const got = await store.fetch(hash);
      expect(got.toString('utf8')).toBe(content);
    });

    it('fetch throws on missing blob (degraded path)', async () => {
      const store = new LocalBlobStore({ rootDir: tempRoot() });
      await expect(store.fetch('a'.repeat(64))).rejects.toThrow(/not found/);
    });

    it('inspect reports blob count and bytes', async () => {
      const store = new LocalBlobStore({ rootDir: tempRoot() });
      await store.upload(computeContentHash('a'), 'a');
      await store.upload(computeContentHash('bb'), 'bb');
      const r = store.inspect();
      expect(r.blobCount).toBe(2);
      expect(r.totalBytes).toBe(3);
    });
  });
});
