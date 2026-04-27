/**
 * Unit tests for lib/sync-v5/op-queue.js
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const { OpQueue, STATUSES } = require('../../../lib/sync-v5/op-queue');
const { newTraceId } = require('../../../lib/sync-v5/trace-id');

function makeTempPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-queue-test-'));
  return path.join(dir, 'queue.json');
}

describe('sync-v5 / op-queue', () => {
  describe('enqueue', () => {
    it('appends an op with status=pending and a generated traceId', () => {
      const q = new OpQueue({ dbPath: makeTempPath() });
      const id = q.enqueue({ opType: 'asset.upsert', entityType: 'asset', entityId: 'a1' });
      expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(q.getDepth()).toBe(1);
      expect(q.get(id).status).toBe(STATUSES.PENDING);
    });

    it('rejects missing required fields', () => {
      const q = new OpQueue({ dbPath: makeTempPath() });
      expect(() => q.enqueue({})).toThrow(/opType/);
      expect(() => q.enqueue({ opType: 'x' })).toThrow(/entityType/);
      expect(() => q.enqueue({ opType: 'x', entityType: 'a' })).toThrow(/entityId/);
    });

    it('rejects duplicate traceIds', () => {
      const q = new OpQueue({ dbPath: makeTempPath() });
      const t = newTraceId();
      q.enqueue({ opType: 'x', entityType: 'a', entityId: 'i', traceId: t });
      expect(() => q.enqueue({ opType: 'x', entityType: 'a', entityId: 'i', traceId: t })).toThrow(
        /duplicate/
      );
    });

    it('persists across instances', () => {
      const p = makeTempPath();
      const q1 = new OpQueue({ dbPath: p });
      q1.enqueue({ opType: 'x', entityType: 'a', entityId: 'i' });
      const q2 = new OpQueue({ dbPath: p });
      expect(q2.getDepth()).toBe(1);
    });
  });

  describe('peek + ordering', () => {
    it('returns oldest-first by ULID lex sort', async () => {
      const q = new OpQueue({ dbPath: makeTempPath() });
      const ids = [];
      for (let i = 0; i < 5; i++) {
        ids.push(q.enqueue({ opType: 'x', entityType: 'a', entityId: 'i' + i }));
        await new Promise((r) => setTimeout(r, 2)); // ensure distinct ms in ULID
      }
      const got = q.peek({ limit: 10 });
      expect(got.map((o) => o.traceId)).toEqual(ids);
    });

    it('respects the limit parameter', () => {
      const q = new OpQueue({ dbPath: makeTempPath() });
      for (let i = 0; i < 5; i++) q.enqueue({ opType: 'x', entityType: 'a', entityId: 'i' + i });
      expect(q.peek({ limit: 3 })).toHaveLength(3);
    });

    it('skips ops not in pending status', () => {
      const q = new OpQueue({ dbPath: makeTempPath() });
      const id = q.enqueue({ opType: 'x', entityType: 'a', entityId: 'i' });
      q.markInFlight(id);
      expect(q.peek({ limit: 10 })).toHaveLength(0);
    });
  });

  describe('status transitions', () => {
    it('markInFlight: pending -> in-flight', () => {
      const q = new OpQueue({ dbPath: makeTempPath() });
      const id = q.enqueue({ opType: 'x', entityType: 'a', entityId: 'i' });
      expect(q.markInFlight(id)).toBe(true);
      expect(q.get(id).status).toBe(STATUSES.IN_FLIGHT);
      expect(q.markInFlight(id)).toBe(false); // already in flight
    });

    it('markAcked: removes from queue (idempotent on second call)', () => {
      const q = new OpQueue({ dbPath: makeTempPath() });
      const id = q.enqueue({ opType: 'x', entityType: 'a', entityId: 'i' });
      expect(q.markAcked(id)).toBe(true);
      expect(q.get(id)).toBe(null);
      expect(q.markAcked(id)).toBe(false);
    });

    it('markFailed: bumps retryCount and resets to pending', () => {
      const q = new OpQueue({ dbPath: makeTempPath() });
      const id = q.enqueue({ opType: 'x', entityType: 'a', entityId: 'i' });
      q.markInFlight(id);
      q.markFailed(id, new Error('boom'));
      const op = q.get(id);
      expect(op.retryCount).toBe(1);
      expect(op.status).toBe(STATUSES.PENDING);
      expect(op.lastError).toBe('boom');
    });

    it('removeForDlq: returns the op and removes it', () => {
      const q = new OpQueue({ dbPath: makeTempPath() });
      const id = q.enqueue({ opType: 'x', entityType: 'a', entityId: 'i' });
      const removed = q.removeForDlq(id);
      expect(removed.traceId).toBe(id);
      expect(q.get(id)).toBe(null);
    });
  });

  describe('persistence: in-flight ops reset on reload', () => {
    it('reloads in-flight ops as pending (mid-flight crash recovery)', () => {
      const p = makeTempPath();
      const q1 = new OpQueue({ dbPath: p });
      const id = q1.enqueue({ opType: 'x', entityType: 'a', entityId: 'i' });
      q1.markInFlight(id);
      const q2 = new OpQueue({ dbPath: p });
      expect(q2.get(id).status).toBe(STATUSES.PENDING);
    });
  });

  describe('inspect', () => {
    it('reports depth, oldest, and inFlight', () => {
      const q = new OpQueue({ dbPath: makeTempPath() });
      const i1 = q.enqueue({ opType: 'x', entityType: 'a', entityId: 'i1' });
      q.enqueue({ opType: 'x', entityType: 'a', entityId: 'i2' });
      q.markInFlight(i1);
      const r = q.inspect();
      expect(r.depth).toBe(2);
      expect(r.inFlight.entityId).toBe('i1');
      expect(r.oldest.entityId).toBe('i2');
    });

    it('returns nulls for an empty queue', () => {
      const q = new OpQueue({ dbPath: makeTempPath() });
      const r = q.inspect();
      expect(r.depth).toBe(0);
      expect(r.oldest).toBe(null);
      expect(r.inFlight).toBe(null);
    });
  });

  describe('getOldestPendingAt', () => {
    it('returns null when empty', () => {
      const q = new OpQueue({ dbPath: makeTempPath() });
      expect(q.getOldestPendingAt()).toBe(null);
    });

    it('returns the createdAt of the oldest pending op', async () => {
      const q = new OpQueue({ dbPath: makeTempPath() });
      const i1 = q.enqueue({ opType: 'x', entityType: 'a', entityId: 'a' });
      const op1 = q.get(i1);
      expect(q.getOldestPendingAt()).toBe(op1.createdAt);
    });
  });
});
