/**
 * Unit tests for lib/sync-v5/tombstone.js
 *
 * Covers the no-resurrection invariant (v5 invariant 4) which is the
 * load-bearing test for tombstone correctness.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const tombstone = require('../../../lib/sync-v5/tombstone');
const vc = require('../../../lib/sync-v5/vector-clock');

const A = '01HABC';
const B = '01HDEF';

function makeOmni({ ready = true, queryRows = [], throwOnQuery = null } = {}) {
  return {
    isReady: () => ready,
    executeQuery: vi.fn(async () => {
      if (throwOnQuery) throw throwOnQuery;
      return queryRows;
    }),
  };
}

describe('sync-v5 / tombstone', () => {
  describe('CYPHER constants', () => {
    it('CYPHER_WRITE_TOMBSTONE writes :Tombstone, soft-deletes :Asset, links them', () => {
      expect(tombstone.CYPHER_WRITE_TOMBSTONE).toContain('CREATE (t:Tombstone');
      expect(tombstone.CYPHER_WRITE_TOMBSTONE).toContain('SET a.active = false');
      expect(tombstone.CYPHER_WRITE_TOMBSTONE).toContain('MERGE (t)-[:TOMBSTONES]->(a)');
    });

    it('CYPHER_GET_TOMBSTONE returns finalVc', () => {
      expect(tombstone.CYPHER_GET_TOMBSTONE).toContain('MATCH (t:Tombstone {entityId: $entityId})');
      expect(tombstone.CYPHER_GET_TOMBSTONE).toContain('finalVc');
    });
  });

  describe('writeTombstone', () => {
    it('writes with serialised finalVc', async () => {
      const omni = makeOmni({ queryRows: [{ entityId: 'a1' }] });
      await tombstone.writeTombstone(
        { entityId: 'a1', deletedBy: A, finalVc: { [A]: 5 } },
        { omniClient: omni }
      );
      const [, params] = omni.executeQuery.mock.calls[0];
      expect(params.entityId).toBe('a1');
      expect(params.deletedBy).toBe(A);
      // finalVc is JSON-stringified for graph storage
      expect(JSON.parse(params.finalVc)).toEqual({ [A]: 5 });
    });

    it('rejects missing required fields', async () => {
      const omni = makeOmni();
      await expect(tombstone.writeTombstone({}, { omniClient: omni })).rejects.toThrow(/entityId/);
      await expect(
        tombstone.writeTombstone({ entityId: 'x' }, { omniClient: omni })
      ).rejects.toThrow(/deletedBy/);
      await expect(
        tombstone.writeTombstone({ entityId: 'x', deletedBy: A }, { omniClient: omni })
      ).rejects.toThrow(/finalVc/);
    });

    it('rejects malformed finalVc', async () => {
      const omni = makeOmni();
      await expect(
        tombstone.writeTombstone(
          { entityId: 'x', deletedBy: A, finalVc: { [A]: -1 } },
          { omniClient: omni }
        )
      ).rejects.toThrow(/VectorClock/);
    });

    it('throws when graph is not ready', async () => {
      const omni = makeOmni({ ready: false });
      await expect(
        tombstone.writeTombstone(
          { entityId: 'x', deletedBy: A, finalVc: {} },
          { omniClient: omni }
        )
      ).rejects.toThrow(/not ready/);
    });
  });

  describe('getTombstone', () => {
    it('returns null when not present', async () => {
      const omni = makeOmni({ queryRows: [] });
      const r = await tombstone.getTombstone('a1', { omniClient: omni });
      expect(r).toBe(null);
    });

    it('parses finalVc back into a VectorClock', async () => {
      const omni = makeOmni({
        queryRows: [
          {
            entityId: 'a1',
            deletedAt: '2026-01-01T00:00:00Z',
            deletedBy: A,
            finalVc: JSON.stringify({ [A]: 3, [B]: 2 }),
          },
        ],
      });
      const r = await tombstone.getTombstone('a1', { omniClient: omni });
      expect(r.entityId).toBe('a1');
      expect(r.finalVc).toEqual({ [A]: 3, [B]: 2 });
    });

    it('returns null when query throws', async () => {
      const omni = makeOmni({ throwOnQuery: new Error('boom') });
      const r = await tombstone.getTombstone('a1', { omniClient: omni });
      expect(r).toBe(null);
    });
  });

  describe('shouldAllowWrite (no-resurrection invariant)', () => {
    function omniWithTombstone(finalVc) {
      return makeOmni({
        queryRows: [
          {
            entityId: 'a1',
            deletedAt: '2026-01-01T00:00:00Z',
            deletedBy: A,
            finalVc: JSON.stringify(finalVc),
          },
        ],
      });
    }

    it('allows write when no tombstone exists', async () => {
      const omni = makeOmni({ queryRows: [] });
      const r = await tombstone.shouldAllowWrite('a1', { [A]: 1 }, { omniClient: omni });
      expect(r.allowed).toBe(true);
      expect(r.reason).toMatch(/no tombstone/);
    });

    it('REFUSES pre-delete write that meets a tombstone (the regression case)', async () => {
      // Tombstone was written when entity vc was {A: 5, B: 3}.
      // A long-offline device's queued op has vc {A: 4, B: 2} -- strictly older.
      // Must refuse.
      const omni = omniWithTombstone({ [A]: 5, [B]: 3 });
      const r = await tombstone.shouldAllowWrite('a1', { [A]: 4, [B]: 2 }, { omniClient: omni });
      expect(r.allowed).toBe(false);
      expect(r.reason).toMatch(/no-resurrection/);
    });

    it('REFUSES write whose vc equals the tombstone finalVc', async () => {
      const omni = omniWithTombstone({ [A]: 5 });
      const r = await tombstone.shouldAllowWrite('a1', { [A]: 5 }, { omniClient: omni });
      expect(r.allowed).toBe(false);
    });

    it('ALLOWS write strictly newer than tombstone (resurrect intent)', async () => {
      const omni = omniWithTombstone({ [A]: 5 });
      const r = await tombstone.shouldAllowWrite('a1', { [A]: 6 }, { omniClient: omni });
      expect(r.allowed).toBe(true);
      expect(r.reason).toMatch(/resurrect/);
    });

    it('REFUSES write that is concurrent with the tombstone (deletes win)', async () => {
      // Tombstone vc: {A: 5}
      // Incoming vc: {B: 1} -- concurrent (each has a slot the other lacks)
      const omni = omniWithTombstone({ [A]: 5 });
      const r = await tombstone.shouldAllowWrite('a1', { [B]: 1 }, { omniClient: omni });
      expect(r.allowed).toBe(false);
      expect(r.reason).toMatch(/concurrent/);
    });
  });
});
