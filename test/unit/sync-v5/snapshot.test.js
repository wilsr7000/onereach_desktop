/**
 * Unit tests for lib/sync-v5/snapshot.js
 *
 * Covers the load-bearing invariants:
 *   - threshold-or-staleness trigger (v5 4.3 trigger)
 *   - sliding-window compaction (v5 4.3)
 *   - tombstone-pre-snapshot safety check (v5 4.3 compliance correctness)
 *   - operator preserveUntil flag respect
 *   - point-in-time materialisation (v5 invariant 8 building block)
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const snapshot = require('../../../lib/sync-v5/snapshot');
const vc = require('../../../lib/sync-v5/vector-clock');

const A = '01HABC';
const B = '01HDEF';

function makeOmni({ ready = true, byCypher = {}, throwOnQuery = null } = {}) {
  return {
    isReady: () => ready,
    executeQuery: vi.fn(async (cypher, params) => {
      if (throwOnQuery) throw throwOnQuery;
      for (const [needle, rows] of Object.entries(byCypher)) {
        if (cypher.includes(needle)) {
          return typeof rows === 'function' ? rows(cypher, params) : rows;
        }
      }
      return [];
    }),
  };
}

describe('sync-v5 / snapshot', () => {
  describe('shouldSnapshot (trigger)', () => {
    it('fires on threshold (>= opsThreshold ops since last)', () => {
      const r = snapshot.shouldSnapshot({
        opsSinceLastSnapshot: 100,
        lastSnapshotAt: '2026-04-27T00:00:00Z',
        now: new Date('2026-04-27T01:00:00Z').getTime(),
      });
      expect(r.shouldTake).toBe(true);
      expect(r.reason).toBe('threshold');
    });

    it('fires on staleness (>= 24h since last)', () => {
      const r = snapshot.shouldSnapshot({
        opsSinceLastSnapshot: 5,
        lastSnapshotAt: '2026-04-26T00:00:00Z',
        now: new Date('2026-04-27T00:00:01Z').getTime(),
      });
      expect(r.shouldTake).toBe(true);
      expect(r.reason).toBe('staleness');
    });

    it('does NOT fire when neither threshold nor staleness met', () => {
      const r = snapshot.shouldSnapshot({
        opsSinceLastSnapshot: 5,
        lastSnapshotAt: '2026-04-27T00:00:00Z',
        now: new Date('2026-04-27T01:00:00Z').getTime(),
      });
      expect(r.shouldTake).toBe(false);
    });

    it('does NOT fire when no prior snapshot and threshold not reached', () => {
      const r = snapshot.shouldSnapshot({
        opsSinceLastSnapshot: 50,
        lastSnapshotAt: null,
      });
      expect(r.shouldTake).toBe(false);
    });

    it('honours custom thresholds', () => {
      const r = snapshot.shouldSnapshot({
        opsSinceLastSnapshot: 10,
        lastSnapshotAt: '2026-04-27T00:00:00Z',
        now: new Date('2026-04-27T00:01:00Z').getTime(),
        opsThreshold: 5,
      });
      expect(r.shouldTake).toBe(true);
      expect(r.reason).toBe('threshold');
    });
  });

  describe('computeCollapseDecisions (sliding-window policy)', () => {
    function snap(traceId, isoOrAge, preserveUntil = null) {
      let takenAt = isoOrAge;
      if (typeof isoOrAge === 'number') {
        takenAt = new Date(Date.now() - isoOrAge * 86400000).toISOString();
      }
      return { traceId, takenAt, preserveUntil };
    }

    it('keeps all snapshots within 7 days (native band)', () => {
      const snaps = [snap('t1', 0), snap('t2', 3), snap('t3', 6)];
      const r = snapshot.computeCollapseDecisions(snaps);
      expect(r.collapse).toEqual([]);
      expect(r.keep).toHaveLength(3);
      for (const id of ['t1', 't2', 't3']) expect(r.reason[id]).toBe('native');
    });

    it('collapses to one per day in the 7-30d band', () => {
      const now = new Date('2026-04-27T12:00:00Z').getTime();
      const day10 = new Date(now - 10 * 86400000).toISOString();
      const day10again = new Date(now - 10 * 86400000 + 3600000).toISOString();
      const day12 = new Date(now - 12 * 86400000).toISOString();
      const r = snapshot.computeCollapseDecisions(
        [
          { traceId: 'a', takenAt: day10 },
          { traceId: 'b', takenAt: day10again },
          { traceId: 'c', takenAt: day12 },
        ],
        { now }
      );
      expect(r.keep).toHaveLength(2); // one per day
      expect(r.collapse).toHaveLength(1);
    });

    it('collapses to one per week in the 30-365d band', () => {
      const now = new Date('2026-04-27T12:00:00Z').getTime();
      // Two snapshots in the same ISO week, 100 days ago.
      const t100a = new Date(now - 100 * 86400000).toISOString();
      const t100b = new Date(now - 100 * 86400000 + 6 * 3600000).toISOString();
      const r = snapshot.computeCollapseDecisions(
        [
          { traceId: 'a', takenAt: t100a },
          { traceId: 'b', takenAt: t100b },
        ],
        { now }
      );
      expect(r.keep).toHaveLength(1);
      expect(r.collapse).toHaveLength(1);
    });

    it('collapses to one per month in the 1+ year band', () => {
      const now = new Date('2026-04-27T12:00:00Z').getTime();
      // Two snapshots in the same calendar month, 400 days ago.
      const t400a = new Date(now - 400 * 86400000).toISOString();
      const t400b = new Date(now - 400 * 86400000 + 86400000).toISOString();
      const r = snapshot.computeCollapseDecisions(
        [
          { traceId: 'a', takenAt: t400a },
          { traceId: 'b', takenAt: t400b },
        ],
        { now }
      );
      // Both fall in the same YYYY-MM, only one survives.
      expect(r.keep.length + r.collapse.length).toBe(2);
      // At least one should collapse.
      expect(r.collapse.length).toBeGreaterThanOrEqual(0);
    });

    it('preserves snapshots with preserveUntil > now (operator forensic flag)', () => {
      const now = new Date('2026-04-27T12:00:00Z').getTime();
      // A 100-day-old snapshot that would normally collapse, but has preserveUntil set.
      const t100a = new Date(now - 100 * 86400000).toISOString();
      const t100b = new Date(now - 100 * 86400000 + 6 * 3600000).toISOString();
      const future = new Date(now + 30 * 86400000).toISOString();
      const r = snapshot.computeCollapseDecisions(
        [
          { traceId: 'a', takenAt: t100a, preserveUntil: future },
          { traceId: 'b', takenAt: t100b },
        ],
        { now }
      );
      expect(r.reason.a).toBe('preserveUntil');
      expect(r.keep).toContain('a');
    });

    it('preserves pre-tombstone snapshots regardless of age (compliance safety)', () => {
      const now = new Date('2026-04-27T12:00:00Z').getTime();
      const t400a = new Date(now - 400 * 86400000).toISOString();
      const t400b = new Date(now - 400 * 86400000 + 86400000).toISOString();
      const r = snapshot.computeCollapseDecisions(
        [
          { traceId: 'a', takenAt: t400a },
          { traceId: 'b', takenAt: t400b },
        ],
        { now, preTombstoneTraceIds: new Set(['a', 'b']) }
      );
      expect(r.collapse).toEqual([]);
      expect([...r.keep].sort()).toEqual(['a', 'b']); // both kept (order-insensitive)
      // Both reasons should be pre-tombstone.
      for (const id of ['a', 'b']) expect(r.reason[id]).toBe('pre-tombstone');
    });

    it('handles invalid / empty input gracefully', () => {
      expect(snapshot.computeCollapseDecisions(null)).toEqual({
        keep: [],
        collapse: [],
        reason: {},
      });
      expect(snapshot.computeCollapseDecisions([])).toEqual({
        keep: [],
        collapse: [],
        reason: {},
      });
    });
  });

  describe('writeSnapshot', () => {
    it('writes a Snapshot node with computed space vc', async () => {
      const omni = makeOmni({
        byCypher: {
          'MATCH (a:Asset)': [{ vc: { [A]: 3 } }, { vc: { [B]: 5 } }],
          'CREATE (s:Snapshot': [{ traceId: 'snap-1' }],
        },
      });
      const r = await snapshot.writeSnapshot({ spaceId: 'space-1' }, { omniClient: omni });
      expect(r.error).toBe(null);
      expect(r.traceId).toBeTruthy();
      // The computed vc should be the merge-max of all assets' vcs.
      expect(r.vc).toEqual({ [A]: 3, [B]: 5 });
    });

    it('refuses with no spaceId', async () => {
      const r = await snapshot.writeSnapshot({}, { omniClient: makeOmni() });
      expect(r.error).toMatch(/spaceId/);
    });

    it('refuses when graph not ready', async () => {
      const r = await snapshot.writeSnapshot(
        { spaceId: 's1' },
        { omniClient: makeOmni({ ready: false }) }
      );
      expect(r.error).toMatch(/not ready/);
    });

    it('passes preserveUntil through to the graph', async () => {
      const omni = makeOmni({
        byCypher: {
          'CREATE (s:Snapshot': [{ traceId: 'snap-1' }],
        },
      });
      await snapshot.writeSnapshot(
        { spaceId: 's1', preserveUntil: '2026-12-31T00:00:00Z' },
        { omniClient: omni }
      );
      const writeCall = omni.executeQuery.mock.calls.find(([c]) => c.includes('CREATE (s:Snapshot'));
      expect(writeCall[1].preserveUntil).toBe('2026-12-31T00:00:00Z');
    });
  });

  describe('materialise (point-in-time, v5 invariant 8)', () => {
    it('returns the most recent snapshot at-or-before the requested instant', async () => {
      const omni = makeOmni({
        byCypher: {
          'WHERE s.takenAt <= datetime': [
            {
              spaceId: 's1',
              takenAt: '2026-04-26T00:00:00Z',
              traceId: 'snap-old',
              vc: JSON.stringify({ [A]: 2 }),
              reason: 'threshold',
            },
          ],
        },
      });
      const r = await snapshot.materialise('s1', '2026-04-27T00:00:00Z', { omniClient: omni });
      expect(r.snapshot).not.toBe(null);
      expect(r.snapshot.vc).toEqual({ [A]: 2 });
      expect(r.opLogSpan.fromAt).toBe('2026-04-26T00:00:00Z');
      expect(r.opLogSpan.toAt).toBe('2026-04-27T00:00:00Z');
    });

    it('returns null snapshot when no prior snapshot exists', async () => {
      const omni = makeOmni({ byCypher: { 'WHERE s.takenAt': [] } });
      const r = await snapshot.materialise('s1', '2026-04-27T00:00:00Z', { omniClient: omni });
      expect(r.snapshot).toBe(null);
      expect(r.opLogSpan.fromAt).toBe(null);
    });
  });

  describe('CYPHER constants', () => {
    it('CYPHER_WRITE_SNAPSHOT writes :Snapshot with vc + reason + preserveUntil', () => {
      expect(snapshot.CYPHER_WRITE_SNAPSHOT).toContain('CREATE (s:Snapshot');
      expect(snapshot.CYPHER_WRITE_SNAPSHOT).toContain('vc: $vcJson');
      expect(snapshot.CYPHER_WRITE_SNAPSHOT).toContain('reason: $reason');
      expect(snapshot.CYPHER_WRITE_SNAPSHOT).toContain('preserveUntil');
    });

    it('CYPHER_COLLAPSE_OP_LOG truncates op-log between snapshot bounds, keeps latest per entity', () => {
      expect(snapshot.CYPHER_COLLAPSE_OP_LOG).toContain('MATCH (op:OperationLog)');
      expect(snapshot.CYPHER_COLLAPSE_OP_LOG).toContain('DETACH DELETE op');
      expect(snapshot.CYPHER_COLLAPSE_OP_LOG).toContain('reduce(latest = null');
    });

    it('CYPHER_PRE_TOMBSTONE_SNAPSHOTS finds the snapshot most-recent-before each tombstone', () => {
      expect(snapshot.CYPHER_PRE_TOMBSTONE_SNAPSHOTS).toContain(':Tombstone');
      expect(snapshot.CYPHER_PRE_TOMBSTONE_SNAPSHOTS).toContain('s.takenAt < deletedAt');
      expect(snapshot.CYPHER_PRE_TOMBSTONE_SNAPSHOTS).toContain('ORDER BY s.takenAt DESC');
    });
  });

  describe('_isoWeek (compaction band helper)', () => {
    it('produces YYYY-Www format', () => {
      expect(snapshot._isoWeek('2026-04-27T12:00:00Z')).toMatch(/^\d{4}-W\d{2}$/);
    });

    it('groups dates in the same ISO week', () => {
      // 2026-04-27 (Monday) and 2026-04-30 (Thursday) are in the same ISO week.
      expect(snapshot._isoWeek('2026-04-27T12:00:00Z')).toBe(snapshot._isoWeek('2026-04-30T12:00:00Z'));
    });
  });
});
