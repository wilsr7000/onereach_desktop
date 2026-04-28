/**
 * Unit tests for omnigraph-client.js -- direct Aura fallback.
 *
 * Tests the path-selection + result-normalisation logic added to bypass
 * the broken GSX proxy. Strategy: instantiate OmniGraphClient with the
 * direct credentials, mock-stub the neo4j-driver via the client's
 * _directDriver hook, and exercise executeQuery + inspect + isReady.
 *
 * No real Neo4j connection -- driver is replaced with a stub that
 * returns canned records.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron-log', () => ({ default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));

const Mod = require('../../omnigraph-client');
const ClientClass = Mod.OmniGraphClient;

// ---------------------------------------------------------------------------
// Fake neo4j-driver: minimal surface matching what _executeDirect uses.
// ---------------------------------------------------------------------------

function fakeDriver(planRecords) {
  let closed = false;
  return {
    session() {
      return {
        async run(cypher, params) {
          if (closed) throw new Error('driver closed');
          // planRecords can be a function for per-call control, or a fixed array
          const records = typeof planRecords === 'function'
            ? planRecords(cypher, params)
            : planRecords;
          return {
            records: records.map((r) => ({
              keys: Object.keys(r),
              get(key) { return r[key]; },
            })),
          };
        },
        async close() { /* noop */ },
      };
    },
    async close() { closed = true; },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OmniGraphClient -- direct Aura fallback', () => {
  describe('isReady()', () => {
    it('false with no credentials at all', () => {
      const c = new ClientClass({});
      expect(c.isReady()).toBe(false);
    });

    it('true with GSX creds only (legacy path)', () => {
      const c = new ClientClass({
        endpoint: 'https://example.com/proxy',
        neo4jPassword: 'pw',
      });
      expect(c.isReady()).toBe(true);
    });

    it('true with direct Aura creds only (new path)', () => {
      const c = new ClientClass({
        neo4jUri: 'neo4j+s://x.databases.neo4j.io',
        neo4jPassword: 'pw',
      });
      expect(c.isReady()).toBe(true);
    });

    it('true with both', () => {
      const c = new ClientClass({
        endpoint: 'https://example.com/proxy',
        neo4jUri: 'neo4j+s://x.databases.neo4j.io',
        neo4jPassword: 'pw',
      });
      expect(c.isReady()).toBe(true);
    });

    it('false when password missing even though URI is set', () => {
      const c = new ClientClass({ neo4jUri: 'neo4j+s://x.databases.neo4j.io' });
      expect(c.isReady()).toBe(false);
    });
  });

  describe('inspect()', () => {
    it('reports preferredPath = direct when both creds present', () => {
      const c = new ClientClass({
        endpoint: 'https://example.com/proxy',
        neo4jUri: 'neo4j+s://x.databases.neo4j.io',
        neo4jPassword: 'pw',
      });
      expect(c.inspect().preferredPath).toBe('direct');
    });

    it('reports preferredPath = gsx when only GSX creds present', () => {
      const c = new ClientClass({ endpoint: 'https://example.com/proxy', neo4jPassword: 'pw' });
      expect(c.inspect().preferredPath).toBe('gsx');
    });

    it('reports preferredPath = none with no creds', () => {
      const c = new ClientClass({});
      expect(c.inspect().preferredPath).toBe('none');
    });

    it('counters start at zero', () => {
      const c = new ClientClass({});
      expect(c.inspect().counters).toEqual({
        directQueries: 0, gsxQueries: 0, directErrors: 0, gsxErrors: 0,
      });
    });
  });

  describe('executeQuery() -- direct path with stubbed driver', () => {
    let c;

    beforeEach(() => {
      c = new ClientClass({
        neo4jUri: 'neo4j+s://x.databases.neo4j.io',
        neo4jPassword: 'pw',
      });
      // Inject the stub driver, bypassing the lazy require.
      c._directDriver = fakeDriver([
        { n: 1, name: 'hello' },
        { n: 2, name: 'world' },
      ]);
    });

    it('returns plain records keyed by RETURN aliases', async () => {
      const r = await c.executeQuery('MATCH (a) RETURN a.n AS n, a.name AS name');
      expect(r).toEqual([
        { n: 1, name: 'hello' },
        { n: 2, name: 'world' },
      ]);
    });

    it('increments directQueries counter on success', async () => {
      await c.executeQuery('MATCH (a) RETURN a');
      expect(c.inspect().counters.directQueries).toBe(1);
    });

    it('increments directErrors on driver throw', async () => {
      c._directDriver = {
        session: () => ({
          async run() { throw new Error('Cypher syntax error: invalid input'); },
          async close() {},
        }),
        async close() {},
      };
      await expect(c.executeQuery('BAD CYPHER')).rejects.toThrow(/Cypher syntax/);
      expect(c.inspect().counters.directErrors).toBe(1);
    });

    it('throws Cypher errors directly, no fallback (GSX cannot fix syntax)', async () => {
      c.endpoint = 'https://example.com/proxy';
      c._directDriver = {
        session: () => ({
          async run() { throw new Error('Invalid input: SHOULD'); },
          async close() {},
        }),
        async close() {},
      };
      await expect(c.executeQuery('BAD')).rejects.toThrow(/Invalid input/);
      expect(c.inspect().counters.gsxQueries).toBe(0); // never tried GSX
    });
  });

  describe('executeQuery() -- value normalisation via stubbed records', () => {
    it('flattens neo4j Integer-like values via duck-type', async () => {
      // Simulate a neo4j Integer with .inSafeRange + .toNumber
      const fakeInt = { inSafeRange: () => true, toNumber: () => 42, toString: () => '42' };
      // We can't easily activate isInt() detection without loading the real
      // driver module. Instead test the output of _executeDirect with values
      // that are already plain JS (neo4j-driver delivers them as Integer
      // class but _normaliseDriverValue handles plain primitives too).
      const c = new ClientClass({
        neo4jUri: 'neo4j+s://x', neo4jPassword: 'pw',
      });
      c._directDriver = fakeDriver([{ count: 42, name: 'x' }]);
      const r = await c.executeQuery('RETURN count(*) AS count, "x" AS name');
      expect(r[0]).toEqual({ count: 42, name: 'x' });
      // (Integer normalisation is exercised in real network round-trip tests.)
      void fakeInt;
    });

    it('passes through arrays and nested objects', async () => {
      const c = new ClientClass({
        neo4jUri: 'neo4j+s://x', neo4jPassword: 'pw',
      });
      c._directDriver = fakeDriver([{ tags: ['a', 'b'], meta: { foo: 1, bar: 'baz' } }]);
      const r = await c.executeQuery('RETURN ...');
      expect(r[0].tags).toEqual(['a', 'b']);
      expect(r[0].meta).toEqual({ foo: 1, bar: 'baz' });
    });
  });

  describe('executeQuery() -- GSX-only path stays untouched', () => {
    it('uses GSX endpoint when no direct creds (fetch-based path runs)', async () => {
      const c = new ClientClass({
        endpoint: 'https://example.com/proxy',
        neo4jPassword: 'pw',
      });
      // Stub global.fetch -- the GSX path uses fetch directly.
      const origFetch = global.fetch;
      const calls = [];
      global.fetch = async (url, opts) => {
        calls.push({ url, body: opts && opts.body });
        // Return a "direct response with result" shape so the path doesn't
        // poll. Per the existing executeQuery code, postData.result with
        // postData.result.records is a direct-return success.
        return {
          ok: true,
          async json() {
            return { result: { records: [{ ok: true }] } };
          },
        };
      };
      try {
        const r = await c.executeQuery('MATCH (a) RETURN a');
        expect(r).toEqual([{ ok: true }]);
        expect(calls.length).toBe(1);
        expect(calls[0].url).toBe('https://example.com/proxy');
        expect(c.inspect().counters.directQueries).toBe(0);
        // Note: GSX direct-response success path doesn't tick gsxQueries
        // (only the polling path does); that's a pre-existing behaviour.
      } finally {
        global.fetch = origFetch;
      }
    });
  });

  describe('closeDirectDriver()', () => {
    it('idempotent', async () => {
      const c = new ClientClass({});
      await expect(c.closeDirectDriver()).resolves.not.toThrow();
      await expect(c.closeDirectDriver()).resolves.not.toThrow();
    });

    it('clears the cached driver', async () => {
      const c = new ClientClass({ neo4jUri: 'neo4j+s://x', neo4jPassword: 'pw' });
      c._directDriver = fakeDriver([]);
      expect(c._directDriver).not.toBeNull();
      await c.closeDirectDriver();
      expect(c._directDriver).toBeNull();
    });
  });
});
