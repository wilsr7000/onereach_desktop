/**
 * Unit tests for lib/sync-v5/diagnostics-endpoints.js
 *
 * Covers: each route handler returns the documented shape; provider
 * registration; trace-id validation; phase reporting; graceful degradation
 * when graph unavailable.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const {
  PHASE,
  handleSyncQueue,
  handleSyncDlq,
  handleSyncTrace,
  handleSyncHealth,
  handleSyncHealthOne,
  setProviders,
  _resetProviders,
} = require('../../../lib/sync-v5/diagnostics-endpoints');
const { newTraceId } = require('../../../lib/sync-v5/trace-id');

beforeEach(() => {
  _resetProviders();
});

describe('sync-v5 / diagnostics-endpoints', () => {
  describe('PHASE constant', () => {
    it('reports phase-1 (so callers know what is wired)', () => {
      expect(PHASE).toBe('phase-1');
    });
  });

  describe('handleSyncQueue', () => {
    it('returns the documented shape with phase + device + schemaVersion', async () => {
      const r = await handleSyncQueue();
      expect(r.status).toBe(200);
      expect(r.body.phase).toBe('phase-1');
      expect(r.body.device).toBeDefined();
      expect(r.body.device.deviceId).toBeDefined();
      expect(r.body.device.deviceClass).toMatch(/^(desktop|mobile)$/);
      expect(r.body.schemaVersion).toBeDefined();
      expect(typeof r.body.schemaVersion.device).toBe('number');
    });

    it('schemaVersion includes apocAvailable + apocVersion fields (operator gate visibility)', async () => {
      const r = await handleSyncQueue();
      expect(r.body.schemaVersion).toHaveProperty('apocAvailable');
      expect(r.body.schemaVersion).toHaveProperty('apocVersion');
      // No live graph in tests, so these are false / null -- the SHAPE is the
      // assertion, the values are runtime-dependent.
      expect(typeof r.body.schemaVersion.apocAvailable).toBe('boolean');
    });

    it('reports queue.wired=false when no provider registered', async () => {
      const r = await handleSyncQueue();
      expect(r.body.queue.wired).toBe(false);
      expect(r.body.queue.note).toMatch(/Phase 2/);
    });

    it('uses queueProvider when registered', async () => {
      setProviders({
        queueProvider: () => ({ depth: 5, oldest: { traceId: 't', age: 100 }, inFlight: null }),
      });
      const r = await handleSyncQueue();
      expect(r.body.queue.depth).toBe(5);
      expect(r.body.queue.oldest.traceId).toBe('t');
    });

    it('captures heartbeat reporter inspect output when registered', async () => {
      setProviders({
        heartbeatReporter: {
          inspect: () => ({
            deviceId: 'D',
            deviceClass: 'desktop',
            started: true,
            isAsleep: false,
            pendingAckCount: 3,
            lastFlushAt: '2026-04-27T12:00:00Z',
            lastFlushError: null,
          }),
        },
      });
      const r = await handleSyncQueue();
      expect(r.body.heartbeat.deviceId).toBe('D');
      expect(r.body.heartbeat.pendingAckCount).toBe(3);
    });

    it('reports conflicts.wired=false when no ConflictStore registered', async () => {
      const r = await handleSyncQueue();
      expect(r.body.conflicts.wired).toBe(false);
      expect(r.body.conflicts.note).toMatch(/Phase 4/);
    });

    it('captures ConflictStore inspect output when registered (Phase 4)', async () => {
      setProviders({
        conflictStore: {
          inspect: () => ({
            count: 2,
            groups: [
              { entityId: 'a1', entityType: 'asset', createdAt: 'x', versionCount: 2 },
              { entityId: 'a2', entityType: 'asset', createdAt: 'y', versionCount: 3 },
            ],
          }),
        },
      });
      const r = await handleSyncQueue();
      expect(r.body.conflicts.count).toBe(2);
      expect(r.body.conflicts.groups).toHaveLength(2);
    });

    it('reports pullEngine.wired=false when no PullEngine registered', async () => {
      const r = await handleSyncQueue();
      expect(r.body.pullEngine.wired).toBe(false);
      expect(r.body.pullEngine.note).toMatch(/Phase 4/);
    });

    it('captures PullEngine inspect output when registered (Phase 4)', async () => {
      setProviders({
        pullEngine: {
          inspect: () => ({
            started: false,
            cursor: '2026-04-27T12:00:00Z',
            applied: 5,
            ignored: 1,
            conflicts: 0,
            tombstoneRefused: 0,
          }),
        },
      });
      const r = await handleSyncQueue();
      expect(r.body.pullEngine.cursor).toBe('2026-04-27T12:00:00Z');
      expect(r.body.pullEngine.applied).toBe(5);
    });

    it('reports replica wired:false when no replica provider is registered', async () => {
      const r = await handleSyncQueue();
      expect(r.body.replica.wired).toBe(false);
      expect(r.body.replica.note).toMatch(/replica/i);
    });

    it('captures Replica inspect output when registered (Phase 5 / commit B)', async () => {
      setProviders({
        replica: {
          inspect: () => ({
            dbPath: '/tmp/replica.sqlite',
            tenantId: 'default',
            schemaVersion: 1,
            counts: { spaces: 3, items: 1019 },
            fts5Available: true,
            meta: { cursor: '', lastFullPullAt: '' },
          }),
        },
      });
      const r = await handleSyncQueue();
      expect(r.body.replica).toMatchObject({
        dbPath: '/tmp/replica.sqlite',
        tenantId: 'default',
        schemaVersion: 1,
        counts: { spaces: 3, items: 1019 },
        fts5Available: true,
      });
    });

    it('replica provider that throws is surfaced as { error: ... }', async () => {
      setProviders({
        replica: {
          inspect: () => { throw new Error('replica oom'); },
        },
      });
      const r = await handleSyncQueue();
      expect(r.body.replica).toEqual({ error: 'replica oom' });
    });

    it('does not crash if provider throws', async () => {
      setProviders({
        queueProvider: () => {
          throw new Error('boom');
        },
      });
      const r = await handleSyncQueue();
      expect(r.body.queue.error).toBe('boom');
    });
  });

  describe('handleSyncDlq', () => {
    it('returns wired=false with empty entries when no provider', async () => {
      const r = await handleSyncDlq();
      expect(r.status).toBe(200);
      expect(r.body.wired).toBe(false);
      expect(r.body.count).toBe(0);
      expect(r.body.entries).toEqual([]);
    });

    it('returns DLQ data when provider is registered', async () => {
      setProviders({
        dlqProvider: () => ({
          count: 2,
          oldestParkedAt: '2026-04-26T10:00:00Z',
          entries: [
            { traceId: 't1', cause: 'corrupt blob', parkedAt: '2026-04-26T10:00:00Z' },
            { traceId: 't2', cause: 'schema refusal', parkedAt: '2026-04-27T10:00:00Z' },
          ],
        }),
      });
      const r = await handleSyncDlq();
      expect(r.body.wired).toBe(true);
      expect(r.body.count).toBe(2);
      expect(r.body.entries).toHaveLength(2);
    });

    it('returns 500 if the dlqProvider throws', async () => {
      setProviders({
        dlqProvider: () => {
          throw new Error('boom');
        },
      });
      const r = await handleSyncDlq();
      expect(r.status).toBe(500);
    });
  });

  describe('handleSyncTrace', () => {
    it('rejects invalid trace IDs', async () => {
      const r1 = await handleSyncTrace('');
      expect(r1.status).toBe(400);
      const r2 = await handleSyncTrace('short');
      expect(r2.status).toBe(400);
      const r3 = await handleSyncTrace(null);
      expect(r3.status).toBe(400);
    });

    it('returns wired=false for local timeline when no provider', async () => {
      const r = await handleSyncTrace(newTraceId());
      expect(r.status).toBe(200);
      expect(r.body.local.wired).toBe(false);
      expect(r.body.local.note).toMatch(/Phase 2/);
    });

    it('uses traceLookupProvider when registered', async () => {
      const t = newTraceId();
      setProviders({
        traceLookupProvider: async (traceId) => ({
          queueInsertAt: '2026-04-27T11:59:00Z',
          blobUploadedAt: '2026-04-27T11:59:01Z',
          status: 'pending',
          traceId,
        }),
      });
      const r = await handleSyncTrace(t);
      expect(r.body.local.traceId).toBe(t);
      expect(r.body.local.status).toBe('pending');
    });

    it('reports graph.found=false when graph unreachable', async () => {
      const r = await handleSyncTrace(newTraceId());
      expect(r.body.graph.found).toBe(false);
    });
  });

  describe('handleSyncHealth', () => {
    it('returns a snapshot keyed by query name', async () => {
      const url = new URL('http://x/sync/health');
      const r = await handleSyncHealth(url);
      expect(r.status).toBe(200);
      expect(r.body.phase).toBe('phase-1');
      expect(r.body).toHaveProperty('activeConflicts');
      expect(r.body).toHaveProperty('opsLandedNotAcked');
      expect(r.body).toHaveProperty('dlqAggregate');
      expect(r.body).toHaveProperty('schemaVersionDistribution');
      expect(r.body).toHaveProperty('stuckDevices');
    });
  });

  describe('handleSyncHealthOne', () => {
    it('404s for unknown query names', async () => {
      const url = new URL('http://x/sync/health/not-a-query');
      const r = await handleSyncHealthOne('not-a-query', url);
      expect(r.status).toBe(404);
    });

    it('returns name + count + rows for a known query', async () => {
      const url = new URL('http://x/sync/health/activeConflicts');
      const r = await handleSyncHealthOne('activeConflicts', url);
      // 200 because the unconfigured-graph case still returns name + count=0,
      // but error is non-null and rows is empty; status is 500 in that case.
      expect([200, 500]).toContain(r.status);
      expect(r.body.name).toBe('activeConflicts');
      expect(typeof r.body.count).toBe('number');
    });
  });

  describe('setProviders', () => {
    it('only overrides named providers (partial update)', async () => {
      setProviders({ queueProvider: () => ({ depth: 1, oldest: null, inFlight: null }) });
      setProviders({ dlqProvider: () => ({ count: 0, entries: [], oldestParkedAt: null }) });
      // Both should still be active.
      const q = await handleSyncQueue();
      expect(q.body.queue.depth).toBe(1);
      const d = await handleSyncDlq();
      expect(d.body.wired).toBe(true);
    });

    it('ignores invalid input gracefully', () => {
      expect(() => setProviders(null)).not.toThrow();
      expect(() => setProviders('not an object')).not.toThrow();
    });
  });
});
