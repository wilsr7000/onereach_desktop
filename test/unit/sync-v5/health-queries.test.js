/**
 * Unit tests for lib/sync-v5/health-queries.js
 *
 * Covers: query name validation, default param merging, error handling for
 * unconfigured graph, fleet snapshot parallel execution.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const {
  QUERIES,
  CYPHER_ACTIVE_CONFLICTS,
  CYPHER_OPS_LANDED_NOT_ACKED,
  CYPHER_DLQ_AGGREGATE,
  CYPHER_SCHEMA_VERSION_DISTRIBUTION,
  CYPHER_STUCK_DEVICES,
  runHealthQuery,
  runFleetHealthSnapshot,
} = require('../../../lib/sync-v5/health-queries');

function makeFakeOmni({ ready = true, byCypher = {}, defaultRows = [] } = {}) {
  return {
    isReady: () => ready,
    executeQuery: vi.fn(async (cypher, params) => {
      for (const [needle, rows] of Object.entries(byCypher)) {
        if (cypher.includes(needle)) {
          return typeof rows === 'function' ? rows(cypher, params) : rows;
        }
      }
      return defaultRows;
    }),
  };
}

describe('sync-v5 / health-queries', () => {
  describe('QUERIES manifest', () => {
    it('exposes the 5 documented queries', () => {
      expect(Object.keys(QUERIES).sort()).toEqual([
        'activeConflicts',
        'dlqAggregate',
        'opsLandedNotAcked',
        'schemaVersionDistribution',
        'stuckDevices',
      ]);
    });

    it('every query has a cypher and a defaults object', () => {
      for (const [name, def] of Object.entries(QUERIES)) {
        expect(typeof def.cypher).toBe('string');
        expect(def.cypher.length).toBeGreaterThan(0);
        expect(typeof def.defaults).toBe('object');
      }
    });
  });

  describe('Cypher pattern checks', () => {
    it('activeConflicts joins :Asset via :CONFLICT', () => {
      expect(CYPHER_ACTIVE_CONFLICTS).toContain(':Asset');
      expect(CYPHER_ACTIVE_CONFLICTS).toContain(':CONFLICT');
    });

    it('opsLandedNotAcked filters by ackedByDevice', () => {
      expect(CYPHER_OPS_LANDED_NOT_ACKED).toContain(':OperationLog');
      expect(CYPHER_OPS_LANDED_NOT_ACKED).toContain('coalesce(op.ackedByDevice, false) = false');
    });

    it('dlqAggregate filters to latest heartbeat per device', () => {
      expect(CYPHER_DLQ_AGGREGATE).toContain(':Heartbeat');
      expect(CYPHER_DLQ_AGGREGATE).toContain('max(h.at)');
      expect(CYPHER_DLQ_AGGREGATE).toContain('h2.dlqCount > 0');
    });

    it('schemaVersionDistribution aggregates per latest heartbeat', () => {
      expect(CYPHER_SCHEMA_VERSION_DISTRIBUTION).toContain(':Heartbeat');
      expect(CYPHER_SCHEMA_VERSION_DISTRIBUTION).toContain('count(*)');
    });

    it('stuckDevices uses class-aware staleness rules', () => {
      expect(CYPHER_STUCK_DEVICES).toContain("h2.deviceClass = 'desktop'");
      expect(CYPHER_STUCK_DEVICES).toContain("h2.deviceClass = 'mobile'");
      expect(CYPHER_STUCK_DEVICES).toContain('expectedNextHeartbeatBy');
      expect(CYPHER_STUCK_DEVICES).toContain('PT30M');
      expect(CYPHER_STUCK_DEVICES).toContain('$mobileSleepDuration');
    });
  });

  describe('runHealthQuery', () => {
    it('returns an error for unknown query names', async () => {
      const r = await runHealthQuery('not-a-query', {}, { omniClient: makeFakeOmni() });
      expect(r.error).toMatch(/Unknown query/);
      expect(r.rows).toEqual([]);
    });

    it('returns rows from the omniClient', async () => {
      const omni = makeFakeOmni({ defaultRows: [{ leftId: 'a', rightId: 'b' }] });
      const r = await runHealthQuery('activeConflicts', {}, { omniClient: omni });
      expect(r.error).toBe(null);
      expect(r.rows).toEqual([{ leftId: 'a', rightId: 'b' }]);
    });

    it('returns an error when graph is not ready', async () => {
      const r = await runHealthQuery(
        'activeConflicts',
        {},
        { omniClient: makeFakeOmni({ ready: false }) }
      );
      expect(r.error).toMatch(/not configured/);
    });

    it('merges defaults with user params', async () => {
      const omni = makeFakeOmni();
      await runHealthQuery('stuckDevices', { mobileSleepDuration: 'P14D' }, { omniClient: omni });
      const [, params] = omni.executeQuery.mock.calls[0];
      expect(params).toEqual({ limit: 100, mobileSleepDuration: 'P14D' });
    });

    it('survives an executeQuery exception', async () => {
      const omni = makeFakeOmni();
      omni.executeQuery = vi.fn(async () => {
        throw new Error('boom');
      });
      const r = await runHealthQuery('activeConflicts', {}, { omniClient: omni });
      expect(r.error).toMatch(/boom/);
      expect(r.rows).toEqual([]);
    });
  });

  describe('runFleetHealthSnapshot', () => {
    it('runs all 5 queries in parallel and returns a keyed result', async () => {
      const omni = makeFakeOmni({
        byCypher: {
          ':CONFLICT': [{ leftId: 'a' }],
          'OperationLog': [{ traceId: 't' }],
          'h2.dlqCount > 0': [{ deviceId: 'd1', dlqCount: 3 }],
          'count(*) AS deviceCount': [{ schemaVersion: 1, deviceCount: 5 }],
          'expectedNextHeartbeatBy IS NOT NULL': [{ deviceId: 'stuck1' }],
        },
      });
      const r = await runFleetHealthSnapshot({ omniClient: omni });
      expect(Object.keys(r).sort()).toEqual([
        'activeConflicts',
        'dlqAggregate',
        'opsLandedNotAcked',
        'schemaVersionDistribution',
        'stuckDevices',
      ]);
      expect(r.activeConflicts.rows).toHaveLength(1);
      expect(r.stuckDevices.rows).toHaveLength(1);
      expect(omni.executeQuery).toHaveBeenCalledTimes(5);
    });

    it('passes through the mobileSleepDuration override to stuckDevices', async () => {
      const omni = makeFakeOmni();
      await runFleetHealthSnapshot({ omniClient: omni, mobileSleepDuration: 'P14D' });
      const stuckCall = omni.executeQuery.mock.calls.find(([c]) =>
        c.includes('expectedNextHeartbeatBy IS NOT NULL')
      );
      expect(stuckCall[1].mobileSleepDuration).toBe('P14D');
    });
  });
});
