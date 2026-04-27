/**
 * Unit tests for lib/sync-v5/schema-version.js
 *
 * Covers: compatibility check across all states, write-allowed gate,
 * handshake banner messages, admin upsert validation, error paths.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const {
  COMPILED_IN_SCHEMA_VERSION,
  COMPAT_STATES,
  CYPHER_READ_SCHEMA_VERSION,
  CYPHER_UPSERT_SCHEMA_VERSION,
  getCompiledInVersion,
  readGraphSchemaVersion,
  checkCompatibility,
  isWriteAllowed,
  handshake,
  adminUpsertSchemaVersion,
} = require('../../../lib/sync-v5/schema-version');

function makeFakeOmni({ ready = true, queryResult = [], throwOnQuery = null } = {}) {
  return {
    isReady: () => ready,
    executeQuery: vi.fn(async (cypher, params) => {
      if (throwOnQuery) throw throwOnQuery;
      return typeof queryResult === 'function' ? queryResult(cypher, params) : queryResult;
    }),
  };
}

describe('sync-v5 / schema-version', () => {
  describe('checkCompatibility', () => {
    it('returns COMPATIBLE when versions match', () => {
      expect(checkCompatibility(1, 1)).toBe(COMPAT_STATES.COMPATIBLE);
      expect(checkCompatibility(5, 5)).toBe(COMPAT_STATES.COMPATIBLE);
    });

    it('returns GRAPH_NEWER_COMPAT_MODE when graph is exactly +1', () => {
      expect(checkCompatibility(2, 1)).toBe(COMPAT_STATES.GRAPH_NEWER_COMPAT_MODE);
      expect(checkCompatibility(6, 5)).toBe(COMPAT_STATES.GRAPH_NEWER_COMPAT_MODE);
    });

    it('returns DEVICE_NEWER_READONLY (device too old) when graph is +2 or more', () => {
      expect(checkCompatibility(3, 1)).toBe(COMPAT_STATES.DEVICE_NEWER_READONLY);
      expect(checkCompatibility(10, 1)).toBe(COMPAT_STATES.DEVICE_NEWER_READONLY);
    });

    it('returns COMPATIBLE when device is ahead of graph (pre-rollout staged release)', () => {
      expect(checkCompatibility(1, 2)).toBe(COMPAT_STATES.COMPATIBLE);
      expect(checkCompatibility(1, 5)).toBe(COMPAT_STATES.COMPATIBLE);
    });

    it('returns UNKNOWN when graph version is null or non-numeric', () => {
      expect(checkCompatibility(null)).toBe(COMPAT_STATES.UNKNOWN);
      expect(checkCompatibility(undefined)).toBe(COMPAT_STATES.UNKNOWN);
      expect(checkCompatibility('1')).toBe(COMPAT_STATES.UNKNOWN);
    });

    it('uses COMPILED_IN_SCHEMA_VERSION when device version is omitted', () => {
      expect(checkCompatibility(COMPILED_IN_SCHEMA_VERSION)).toBe(COMPAT_STATES.COMPATIBLE);
    });
  });

  describe('isWriteAllowed', () => {
    it('allows writes in COMPATIBLE and GRAPH_NEWER_COMPAT_MODE', () => {
      expect(isWriteAllowed(COMPAT_STATES.COMPATIBLE)).toBe(true);
      expect(isWriteAllowed(COMPAT_STATES.GRAPH_NEWER_COMPAT_MODE)).toBe(true);
    });

    it('refuses writes in DEVICE_NEWER_READONLY and UNKNOWN', () => {
      expect(isWriteAllowed(COMPAT_STATES.DEVICE_NEWER_READONLY)).toBe(false);
      expect(isWriteAllowed(COMPAT_STATES.UNKNOWN)).toBe(false);
    });
  });

  describe('readGraphSchemaVersion', () => {
    it('returns nulls when omniClient is unavailable', async () => {
      const r = await readGraphSchemaVersion({ omniClient: null });
      expect(r.version).toBe(null);
    });

    it('returns nulls when omniClient is not ready', async () => {
      const r = await readGraphSchemaVersion({ omniClient: makeFakeOmni({ ready: false }) });
      expect(r.version).toBe(null);
    });

    it('returns nulls when no :SchemaVersion node exists', async () => {
      const r = await readGraphSchemaVersion({ omniClient: makeFakeOmni({ queryResult: [] }) });
      expect(r.version).toBe(null);
    });

    it('parses a normal numeric version', async () => {
      const omni = makeFakeOmni({
        queryResult: [{ version: 3, deployedAt: '2026-01-01T00:00:00Z', migrationsRequired: ['m1'] }],
      });
      const r = await readGraphSchemaVersion({ omniClient: omni });
      expect(r.version).toBe(3);
      expect(r.migrationsRequired).toEqual(['m1']);
      expect(r.deployedAt).toContain('2026-01-01');
    });

    it('parses a Neo4j Integer object form', async () => {
      const omni = makeFakeOmni({
        queryResult: [{ version: { low: 7, high: 0 }, deployedAt: null, migrationsRequired: [] }],
      });
      const r = await readGraphSchemaVersion({ omniClient: omni });
      expect(r.version).toBe(7);
    });

    it('returns nulls when query throws', async () => {
      const omni = makeFakeOmni({ throwOnQuery: new Error('boom') });
      const r = await readGraphSchemaVersion({ omniClient: omni });
      expect(r.version).toBe(null);
    });
  });

  describe('handshake', () => {
    it('produces a writeAllowed=true result for matching versions', async () => {
      const omni = makeFakeOmni({
        queryResult: [{ version: COMPILED_IN_SCHEMA_VERSION, deployedAt: '2026-01-01', migrationsRequired: [] }],
      });
      const r = await handshake({ omniClient: omni });
      expect(r.state).toBe(COMPAT_STATES.COMPATIBLE);
      expect(r.writeAllowed).toBe(true);
      expect(r.banner).toBe(null);
    });

    it('produces a banner for compat mode', async () => {
      const omni = makeFakeOmni({
        queryResult: [{ version: COMPILED_IN_SCHEMA_VERSION + 1, deployedAt: '2026-01-01', migrationsRequired: [] }],
      });
      const r = await handshake({ omniClient: omni });
      expect(r.state).toBe(COMPAT_STATES.GRAPH_NEWER_COMPAT_MODE);
      expect(r.writeAllowed).toBe(true);
      expect(r.banner).toMatch(/compat mode/);
    });

    it('produces a banner for device-too-old read-only', async () => {
      const omni = makeFakeOmni({
        queryResult: [{ version: COMPILED_IN_SCHEMA_VERSION + 2, deployedAt: '2026-01-01', migrationsRequired: [] }],
      });
      const r = await handshake({ omniClient: omni });
      expect(r.state).toBe(COMPAT_STATES.DEVICE_NEWER_READONLY);
      expect(r.writeAllowed).toBe(false);
      expect(r.banner).toMatch(/too old/);
    });

    it('produces an UNKNOWN banner when graph is unreachable', async () => {
      const r = await handshake({ omniClient: null });
      expect(r.state).toBe(COMPAT_STATES.UNKNOWN);
      expect(r.writeAllowed).toBe(false);
      expect(r.banner).toMatch(/unavailable/);
    });
  });

  describe('adminUpsertSchemaVersion', () => {
    it('rejects non-positive integer versions', async () => {
      const omni = makeFakeOmni();
      await expect(adminUpsertSchemaVersion({ version: 0 }, { omniClient: omni })).rejects.toThrow(/positive integer/);
      await expect(adminUpsertSchemaVersion({ version: -1 }, { omniClient: omni })).rejects.toThrow(/positive integer/);
      await expect(adminUpsertSchemaVersion({ version: 1.5 }, { omniClient: omni })).rejects.toThrow(/positive integer/);
    });

    it('refuses to run when client is not ready', async () => {
      const omni = makeFakeOmni({ ready: false });
      await expect(adminUpsertSchemaVersion({ version: 2 }, { omniClient: omni })).rejects.toThrow(/not ready/);
    });

    it('runs the upsert Cypher with parameters', async () => {
      const omni = makeFakeOmni({ queryResult: [{ version: 2 }] });
      const r = await adminUpsertSchemaVersion(
        { version: 2, migrationsRequired: ['m1', 'm2'] },
        { omniClient: omni }
      );
      expect(r.version).toBe(2);
      expect(omni.executeQuery).toHaveBeenCalledOnce();
      const [cypher, params] = omni.executeQuery.mock.calls[0];
      expect(cypher).toContain('MERGE (sv:SchemaVersion)');
      expect(params).toEqual({ version: 2, migrationsRequired: ['m1', 'm2'] });
    });
  });

  describe('Cypher constants', () => {
    it('CYPHER_READ_SCHEMA_VERSION queries SchemaVersion node', () => {
      expect(CYPHER_READ_SCHEMA_VERSION).toContain(':SchemaVersion');
      expect(CYPHER_READ_SCHEMA_VERSION).toContain('LIMIT 1');
    });

    it('CYPHER_UPSERT_SCHEMA_VERSION uses MERGE with ON CREATE/ON MATCH', () => {
      expect(CYPHER_UPSERT_SCHEMA_VERSION).toContain('MERGE (sv:SchemaVersion)');
      expect(CYPHER_UPSERT_SCHEMA_VERSION).toContain('ON CREATE');
      expect(CYPHER_UPSERT_SCHEMA_VERSION).toContain('ON MATCH');
    });
  });

  it('getCompiledInVersion returns the constant', () => {
    expect(getCompiledInVersion()).toBe(COMPILED_IN_SCHEMA_VERSION);
    expect(typeof COMPILED_IN_SCHEMA_VERSION).toBe('number');
    expect(COMPILED_IN_SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
  });
});
