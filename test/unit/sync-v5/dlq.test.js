/**
 * Unit tests for lib/sync-v5/dlq.js
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const {
  DeadLetterQueue,
  computeBackoffMs,
  shouldPark,
  DEFAULT_RETRY_BUDGET,
  DEFAULT_MAX_BACKOFF_MS,
} = require('../../../lib/sync-v5/dlq');
const { newTraceId } = require('../../../lib/sync-v5/trace-id');

function makeTempPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlq-test-'));
  return path.join(dir, 'dlq.json');
}

function fakeOp(extra = {}) {
  return {
    traceId: newTraceId(),
    opType: 'asset.upsert',
    entityType: 'asset',
    entityId: 'a1',
    payload: {},
    retryCount: 8,
    lastError: 'graph timeout',
    ...extra,
  };
}

describe('sync-v5 / dlq', () => {
  describe('park', () => {
    it('writes a new entry with cause + retryCount', () => {
      const dlq = new DeadLetterQueue({ dbPath: makeTempPath() });
      const op = fakeOp();
      const e = dlq.park(op, 'graph timeout');
      expect(e.traceId).toBe(op.traceId);
      expect(e.cause).toBe('graph timeout');
      expect(e.retryCount).toBe(8);
      expect(dlq.count()).toBe(1);
    });

    it('falls back to op.lastError when cause is omitted', () => {
      const dlq = new DeadLetterQueue({ dbPath: makeTempPath() });
      const op = fakeOp({ lastError: 'corrupt blob' });
      const e = dlq.park(op);
      expect(e.cause).toBe('corrupt blob');
    });

    it('rejects ops without valid traceId', () => {
      const dlq = new DeadLetterQueue({ dbPath: makeTempPath() });
      expect(() => dlq.park({ traceId: 'bogus' })).toThrow(/valid traceId/);
    });
  });

  describe('remove + get', () => {
    it('returns the parked entry and removes it', () => {
      const dlq = new DeadLetterQueue({ dbPath: makeTempPath() });
      const op = fakeOp();
      dlq.park(op, 'x');
      const e = dlq.remove(op.traceId);
      expect(e.traceId).toBe(op.traceId);
      expect(dlq.get(op.traceId)).toBe(null);
      expect(dlq.count()).toBe(0);
    });

    it('returns null when the entry is not present', () => {
      const dlq = new DeadLetterQueue({ dbPath: makeTempPath() });
      expect(dlq.remove(newTraceId())).toBe(null);
    });
  });

  describe('list + oldestParkedAt', () => {
    it('returns entries oldest-first', async () => {
      const dlq = new DeadLetterQueue({ dbPath: makeTempPath() });
      const ids = [];
      for (let i = 0; i < 3; i++) {
        const op = fakeOp();
        ids.push(op.traceId);
        dlq.park(op, 'x');
        await new Promise((r) => setTimeout(r, 5));
      }
      const list = dlq.list({ limit: 10 });
      expect(list.map((e) => e.traceId)).toEqual(ids);
      expect(dlq.oldestParkedAt()).toBe(list[0].parkedAt);
    });

    it('respects limit', () => {
      const dlq = new DeadLetterQueue({ dbPath: makeTempPath() });
      for (let i = 0; i < 5; i++) dlq.park(fakeOp(), 'x');
      expect(dlq.list({ limit: 2 })).toHaveLength(2);
    });

    it('returns null oldestParkedAt for empty DLQ', () => {
      const dlq = new DeadLetterQueue({ dbPath: makeTempPath() });
      expect(dlq.oldestParkedAt()).toBe(null);
    });
  });

  describe('persistence', () => {
    it('survives reload', () => {
      const p = makeTempPath();
      const dlq1 = new DeadLetterQueue({ dbPath: p });
      const op = fakeOp();
      dlq1.park(op, 'x');
      const dlq2 = new DeadLetterQueue({ dbPath: p });
      expect(dlq2.count()).toBe(1);
      expect(dlq2.get(op.traceId).cause).toBe('x');
    });
  });

  describe('toHeartbeatState', () => {
    it('returns the shape used by HeartbeatReporter.dlqStateProvider', () => {
      const dlq = new DeadLetterQueue({ dbPath: makeTempPath() });
      const op = fakeOp();
      dlq.park(op, 'x');
      const r = dlq.toHeartbeatState();
      expect(r.dlqCount).toBe(1);
      expect(r.oldestParkedAt).toBeTruthy();
    });
  });

  describe('computeBackoffMs', () => {
    // Random is uniform on [0,1); jitter formula is base + base*0.2*(random*2-1).
    // So `() => 0.5` gives zero jitter (the midpoint).
    const noJitter = () => 0.5;
    it('grows exponentially with no jitter (random=0.5)', () => {
      const r = (n) => computeBackoffMs(n, DEFAULT_MAX_BACKOFF_MS, noJitter);
      expect(r(0)).toBe(1000);
      expect(r(1)).toBe(2000);
      expect(r(2)).toBe(4000);
      expect(r(10)).toBe(1024 * 1000);
    });

    it('caps at maxMs', () => {
      const r = computeBackoffMs(100, 5000, noJitter);
      expect(r).toBe(5000);
    });

    it('applies bounded jitter (within ±20%)', () => {
      const base = computeBackoffMs(2, DEFAULT_MAX_BACKOFF_MS, noJitter);
      const jitterHigh = computeBackoffMs(2, DEFAULT_MAX_BACKOFF_MS, () => 1); // +20%
      const jitterLow = computeBackoffMs(2, DEFAULT_MAX_BACKOFF_MS, () => 0); // -20%
      expect(jitterLow).toBeLessThanOrEqual(base);
      expect(jitterHigh).toBeGreaterThanOrEqual(base);
      // Range: base * (1 ± 0.2)
      expect(jitterHigh).toBeLessThanOrEqual(Math.round(base * 1.2));
      expect(jitterLow).toBeGreaterThanOrEqual(Math.round(base * 0.8));
    });

    it('never returns negative', () => {
      for (let i = 0; i < 50; i++) {
        const r = computeBackoffMs(0, DEFAULT_MAX_BACKOFF_MS); // real Math.random
        expect(r).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('shouldPark', () => {
    it('returns false until retry budget reached', () => {
      expect(shouldPark({ retryCount: 0 })).toBe(false);
      expect(shouldPark({ retryCount: DEFAULT_RETRY_BUDGET - 1 })).toBe(false);
    });

    it('returns true at or beyond retry budget', () => {
      expect(shouldPark({ retryCount: DEFAULT_RETRY_BUDGET })).toBe(true);
      expect(shouldPark({ retryCount: 100 })).toBe(true);
    });

    it('honours custom retry budget', () => {
      expect(shouldPark({ retryCount: 2 }, 3)).toBe(false);
      expect(shouldPark({ retryCount: 3 }, 3)).toBe(true);
    });
  });
});
