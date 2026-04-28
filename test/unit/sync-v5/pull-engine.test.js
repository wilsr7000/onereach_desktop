/**
 * Unit tests for lib/sync-v5/pull-engine.js
 *
 * Covers the v5 4.7 pull pipeline: read remote ops, gate against
 * tombstones, route through conflict resolution, advance cursor.
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const { PullEngine, APPLY_MODE, CYPHER_READ_OPLOG_SINCE } = require('../../../lib/sync-v5/pull-engine');
const { ConflictStore, VERDICT } = require('../../../lib/sync-v5/conflict');
const vc = require('../../../lib/sync-v5/vector-clock');

const A = '01HABC';
const B = '01HDEF';
const SELF = '01HSELF';

function tempCursorPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-engine-test-'));
  return path.join(dir, 'cursor.json');
}

function makeOmni({ byCypher = {}, ready = true, throwOnQuery = null } = {}) {
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

function makeFixture({ byCypher = {}, omniReady = true } = {}) {
  const conflictStore = new ConflictStore();
  const omni = makeOmni({ byCypher, ready: omniReady });
  const localApplied = [];
  const localStore = new Map();
  const localApplyFn = vi.fn(async (args) => {
    localApplied.push(args);
    localStore.set(args.entityId, args.version);
  });
  const localLookupFn = vi.fn(async (entityId) => localStore.get(entityId) || null);
  const engine = new PullEngine({
    omniClient: omni,
    deviceId: SELF,
    conflictStore,
    localApplyFn,
    localLookupFn,
    cursorPath: tempCursorPath(),
    pollIntervalMs: 1000000, // very long; we'll call pollOnce manually
  });
  return { engine, omni, conflictStore, localApplyFn, localLookupFn, localApplied, localStore };
}

describe('sync-v5 / pull-engine', () => {
  describe('constructor validation', () => {
    it('rejects missing required deps', () => {
      expect(() => new PullEngine({})).toThrow(/omniClient/);
      expect(() => new PullEngine({ omniClient: makeOmni() })).toThrow(/deviceId/);
      expect(() => new PullEngine({ omniClient: makeOmni(), deviceId: 'd' })).toThrow(/conflictStore/);
      expect(
        () => new PullEngine({ omniClient: makeOmni(), deviceId: 'd', conflictStore: new ConflictStore() })
      ).toThrow(/localLookupFn/);
    });
  });

  describe('pollOnce', () => {
    it('returns 0 when graph not ready', async () => {
      const { engine, omni } = makeFixture({ omniReady: false });
      const processed = await engine.pollOnce();
      expect(processed).toBe(0);
      expect(omni.executeQuery).not.toHaveBeenCalled();
    });

    it('returns 0 when no remote ops since cursor', async () => {
      const { engine } = makeFixture({ byCypher: { 'MATCH (op:OperationLog)': [] } });
      const processed = await engine.pollOnce();
      expect(processed).toBe(0);
    });

    it('skips ops authored by self (own-op gate)', async () => {
      const { engine, omni, localApplyFn } = makeFixture({
        byCypher: {
          'MATCH (op:OperationLog)': [
            {
              traceId: 't1',
              deviceId: SELF,
              entityId: 'a1',
              entityType: 'asset',
              opType: 'asset.upsert',
              at: '2026-04-27T12:00:00Z',
              contentHash: 'abc',
              vcAfter: JSON.stringify({ [SELF]: 1 }),
            },
          ],
        },
      });
      await engine.pollOnce();
      expect(localApplyFn).not.toHaveBeenCalled();
      const stats = engine.inspect();
      expect(stats.ownOpsSkipped).toBe(1);
    });

    it('applies remote ops that strictly dominate local', async () => {
      const { engine, omni, localApplyFn, localStore } = makeFixture({
        byCypher: {
          'MATCH (op:OperationLog)': [
            {
              traceId: 't1',
              deviceId: A,
              entityId: 'a1',
              entityType: 'asset',
              opType: 'asset.upsert',
              at: '2026-04-27T12:00:00Z',
              contentHash: 'abc',
              vcAfter: JSON.stringify({ [A]: 2 }),
            },
          ],
          // No tombstone exists for this entity.
          'MATCH (t:Tombstone {entityId': [],
        },
      });
      // Pre-seed local with an older version.
      localStore.set('a1', { vc: { [A]: 1 }, payload: {}, authorDeviceId: A, authoredAt: 'x' });
      await engine.pollOnce();
      expect(localApplyFn).toHaveBeenCalledOnce();
      expect(engine.inspect().applied).toBe(1);
    });

    it('registers a CONFLICT in the ConflictStore when vcs are concurrent', async () => {
      const { engine, conflictStore, localStore } = makeFixture({
        byCypher: {
          'MATCH (op:OperationLog)': [
            {
              traceId: 't1',
              deviceId: B,
              entityId: 'a1',
              entityType: 'asset',
              opType: 'asset.upsert',
              at: '2026-04-27T12:00:00Z',
              contentHash: 'abc',
              vcAfter: JSON.stringify({ [B]: 1 }),
            },
          ],
          'MATCH (t:Tombstone {entityId': [],
        },
      });
      localStore.set('a1', { vc: { [A]: 1 }, payload: { v: 'mine' }, authorDeviceId: A, authoredAt: 'x' });
      await engine.pollOnce();
      expect(engine.inspect().conflicts).toBe(1);
      expect(conflictStore.count()).toBe(1);
    });

    it('refuses ops blocked by a tombstone (no-resurrection invariant)', async () => {
      const { engine, localApplyFn } = makeFixture({
        byCypher: {
          'MATCH (op:OperationLog)': [
            {
              traceId: 't1',
              deviceId: A,
              entityId: 'a1',
              entityType: 'asset',
              opType: 'asset.upsert',
              at: '2026-04-27T12:00:00Z',
              contentHash: 'abc',
              // Older vc than the tombstone.
              vcAfter: JSON.stringify({ [A]: 1 }),
            },
          ],
          'MATCH (t:Tombstone {entityId': [
            {
              entityId: 'a1',
              deletedAt: '2026-04-26T00:00:00Z',
              deletedBy: A,
              finalVc: JSON.stringify({ [A]: 5 }), // newer than incoming
            },
          ],
        },
      });
      await engine.pollOnce();
      expect(localApplyFn).not.toHaveBeenCalled();
      expect(engine.inspect().tombstoneRefused).toBe(1);
    });

    it('advances the cursor after processing a batch', async () => {
      const { engine, omni } = makeFixture({
        byCypher: {
          'MATCH (op:OperationLog)': [
            {
              traceId: 't1',
              deviceId: A,
              entityId: 'a1',
              entityType: 'asset',
              opType: 'asset.upsert',
              at: '2026-04-27T12:00:00Z',
              contentHash: 'abc',
              vcAfter: JSON.stringify({ [A]: 1 }),
            },
          ],
          'MATCH (t:Tombstone {entityId': [],
        },
      });
      await engine.pollOnce();
      expect(engine.inspect().cursor).toBe('2026-04-27T12:00:00Z');
    });

    it('uses cursor in the next poll request', async () => {
      const { engine, omni } = makeFixture({
        byCypher: {
          'MATCH (op:OperationLog)': [
            {
              traceId: 't1',
              deviceId: A,
              entityId: 'a1',
              entityType: 'asset',
              opType: 'asset.upsert',
              at: '2026-04-27T12:00:00Z',
              contentHash: 'abc',
              vcAfter: JSON.stringify({ [A]: 1 }),
            },
          ],
          'MATCH (t:Tombstone {entityId': [],
        },
      });
      await engine.pollOnce();
      await engine.pollOnce();
      // Second OperationLog read should pass the cursor as $sinceAt.
      const oplogCalls = omni.executeQuery.mock.calls.filter(([c]) =>
        c.includes('MATCH (op:OperationLog)')
      );
      expect(oplogCalls.length).toBeGreaterThanOrEqual(2);
      expect(oplogCalls[1][1].sinceAt).toBe('2026-04-27T12:00:00Z');
    });

    it('handles malformed remote vc by skipping the op (fail closed)', async () => {
      const { engine, localApplyFn } = makeFixture({
        byCypher: {
          'MATCH (op:OperationLog)': [
            {
              traceId: 't1',
              deviceId: A,
              entityId: 'a1',
              entityType: 'asset',
              opType: 'asset.upsert',
              at: '2026-04-27T12:00:00Z',
              contentHash: 'abc',
              vcAfter: 'not valid json',
            },
          ],
          'MATCH (t:Tombstone {entityId': [],
        },
      });
      await engine.pollOnce();
      expect(localApplyFn).not.toHaveBeenCalled();
    });
  });

  describe('persistence', () => {
    it('saves and restores the cursor across instances', async () => {
      const cursorPath = tempCursorPath();
      const conflictStore = new ConflictStore();
      const omni = makeOmni({
        byCypher: {
          'MATCH (op:OperationLog)': [
            {
              traceId: 't1',
              deviceId: A,
              entityId: 'a1',
              entityType: 'asset',
              opType: 'asset.upsert',
              at: '2026-04-27T12:00:00Z',
              contentHash: 'abc',
              vcAfter: JSON.stringify({ [A]: 1 }),
            },
          ],
          'MATCH (t:Tombstone {entityId': [],
        },
      });
      const engine1 = new PullEngine({
        omniClient: omni,
        deviceId: SELF,
        conflictStore,
        localApplyFn: async () => {},
        localLookupFn: async () => null,
        cursorPath,
        pollIntervalMs: 1000000,
      });
      await engine1.pollOnce();
      expect(engine1.inspect().cursor).toBe('2026-04-27T12:00:00Z');

      // Fresh engine, same cursor file.
      const engine2 = new PullEngine({
        omniClient: omni,
        deviceId: SELF,
        conflictStore: new ConflictStore(),
        localApplyFn: async () => {},
        localLookupFn: async () => null,
        cursorPath,
        pollIntervalMs: 1000000,
      });
      expect(engine2.inspect().cursor).toBe('2026-04-27T12:00:00Z');
    });
  });

  describe('CYPHER_READ_OPLOG_SINCE', () => {
    it('reads :OperationLog rows after a cursor with vcAfter', () => {
      expect(CYPHER_READ_OPLOG_SINCE).toContain(':OperationLog');
      expect(CYPHER_READ_OPLOG_SINCE).toContain('$sinceAt IS NULL OR op.at > datetime($sinceAt)');
      expect(CYPHER_READ_OPLOG_SINCE).toContain('vcAfter');
      expect(CYPHER_READ_OPLOG_SINCE).toContain('ORDER BY op.at ASC');
    });
  });

  describe('applyMode (operator-visible label for APPLY-verdict behaviour)', () => {
    it('exports the documented modes', () => {
      expect(APPLY_MODE.NOOP).toBe('noop');
      expect(APPLY_MODE.SQLITE).toBe('sqlite');
      expect(APPLY_MODE.CUSTOM).toBe('custom');
    });

    it('defaults to "custom" when not specified', () => {
      const { engine } = makeFixture();
      expect(engine.inspect().applyMode).toBe('custom');
      expect(engine.inspect().applyModeNote).toBe(null);
    });

    it('"noop" surfaces the explanatory note in inspect()', () => {
      const conflictStore = new ConflictStore();
      const engine = new PullEngine({
        omniClient: makeOmni(),
        deviceId: SELF,
        conflictStore,
        localApplyFn: async () => {},
        localLookupFn: async () => null,
        applyMode: 'noop',
        cursorPath: tempCursorPath(),
      });
      const r = engine.inspect();
      expect(r.applyMode).toBe('noop');
      expect(r.applyModeNote).toMatch(/discarded/);
      expect(r.applyModeNote).toMatch(/CONFLICT/);
    });

    it('"sqlite" does not surface the noop note', () => {
      const conflictStore = new ConflictStore();
      const engine = new PullEngine({
        omniClient: makeOmni(),
        deviceId: SELF,
        conflictStore,
        localApplyFn: async () => {},
        localLookupFn: async () => null,
        applyMode: 'sqlite',
        cursorPath: tempCursorPath(),
      });
      expect(engine.inspect().applyMode).toBe('sqlite');
      expect(engine.inspect().applyModeNote).toBe(null);
    });

    it('rejects an invalid applyMode at construction time', () => {
      const conflictStore = new ConflictStore();
      expect(
        () =>
          new PullEngine({
            omniClient: makeOmni(),
            deviceId: SELF,
            conflictStore,
            localApplyFn: async () => {},
            localLookupFn: async () => null,
            applyMode: 'bogus',
            cursorPath: tempCursorPath(),
          })
      ).toThrow(/applyMode must be one of/);
    });
  });
});
