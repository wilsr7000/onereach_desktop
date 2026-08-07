/**
 * N4 — renderers carry no Cypher.
 *
 * From the 2026-08-07 graph review: `window.lite.neon.query` accepted
 * arbitrary Cypher from any Lite renderer, validated only as
 * "non-empty string". The renderer surface had exactly one consumer
 * (the IDW catalog, one fixed query), so the raw channel is GONE:
 * modules register fixed Cypher at init and renderers invoke by name.
 *
 * Two layers here: the registry's own contract, and a source-level
 * lockdown asserting the raw channel cannot quietly return — the exact
 * shape of regression a convenience patch would introduce ("just
 * expose query for this one debug panel").
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  registerNamedQuery,
  getNamedQuery,
  listNamedQueries,
  _resetNamedQueriesForTesting,
} from '../../neon/named-queries.js';

describe('named-query registry', () => {
  beforeEach(() => {
    _resetNamedQueriesForTesting();
  });

  it('round-trips a registered query', () => {
    registerNamedQuery('idw.oagi-catalog', 'MATCH (n) RETURN n');
    expect(getNamedQuery('idw.oagi-catalog')).toBe('MATCH (n) RETURN n');
  });

  it('returns null for an unknown name — the reject path', () => {
    expect(getNamedQuery('nope.never-registered')).toBeNull();
  });

  // Silently replacing a reviewed query is the substitution the
  // registry exists to prevent.
  it('refuses to REDEFINE a name with different Cypher', () => {
    registerNamedQuery('spaces.discovery.counts', 'MATCH (a) RETURN count(a)');
    expect(() =>
      registerNamedQuery('spaces.discovery.counts', 'MATCH (p:Person) RETURN p')
    ).toThrow(/redefinition/);
  });

  it('treats identical re-registration as a no-op (idempotent inits)', () => {
    registerNamedQuery('idw.oagi-catalog', 'MATCH (n) RETURN n');
    expect(() => registerNamedQuery('idw.oagi-catalog', 'MATCH (n) RETURN n')).not.toThrow();
  });

  it('enforces the <module>.<name> format', () => {
    expect(() => registerNamedQuery('nodots', 'MATCH (n) RETURN n')).toThrow(/module/);
    expect(() => registerNamedQuery('Bad.Case', 'MATCH (n) RETURN n')).toThrow(/module/);
    expect(() => registerNamedQuery('', 'MATCH (n) RETURN n')).toThrow(/module/);
  });

  it('rejects empty Cypher', () => {
    expect(() => registerNamedQuery('a.b', '   ')).toThrow(/empty Cypher/);
  });

  it('lists names but never leaks Cypher through the listing', () => {
    registerNamedQuery('a.one', 'MATCH (x) RETURN x');
    registerNamedQuery('b.two', 'MATCH (y) RETURN y');
    const listed = listNamedQueries();
    expect(listed).toEqual(['a.one', 'b.two']);
    expect(JSON.stringify(listed)).not.toContain('MATCH');
  });
});

describe('the raw channel stays gone (source lockdown)', () => {
  function read(rel: string): string {
    const candidates = [rel, rel.replace(/^lite\//, '')].map((p) => path.resolve(p));
    const found = candidates.find((p) => fs.existsSync(p));
    expect(found, `${rel} not found`).toBeDefined();
    return fs.readFileSync(found as string, 'utf8');
  }

  it('the preload neon bridge exposes no raw query()', () => {
    const src = read('lite/preload-lite.ts');
    // The channel constant itself must not exist — 'lite:neon:query'
    // exactly (the named channel is 'lite:neon:query-named').
    expect(
      /['"]lite:neon:query['"]/.test(src),
      'the raw lite:neon:query channel must not return to the preload'
    ).toBe(false);
    // And the bridge interface must not declare query(cypher...).
    expect(
      /query\(\s*\n?\s*cypher/.test(src),
      'NeonBridge must not re-grow a query(cypher, ...) method'
    ).toBe(false);
  });

  it('the main process registers no handler for the raw channel', () => {
    const src = read('lite/neon/main.ts');
    expect(/QUERY:\s*['"]lite:neon:query['"]/.test(src)).toBe(false);
    expect(src.includes("QUERY_NAMED: 'lite:neon:query-named'")).toBe(true);
  });

  it('the window typings offer queryNamed, not query', () => {
    const src = read('lite/lite-window.d.ts');
    const bridge = src.slice(src.indexOf('interface LiteNeonBridge'), src.indexOf('interface', src.indexOf('interface LiteNeonBridge') + 10));
    expect(bridge.includes('queryNamed(')).toBe(true);
    expect(/\n\s*query\(cypher/.test(bridge)).toBe(false);
  });

  it('the sole renderer consumer invokes by name', () => {
    const src = read('lite/idw/catalog-renderer.ts');
    expect(src.includes("queryNamed('idw.oagi-catalog'")).toBe(true);
    expect(src.includes('neon.query(')).toBe(false);
  });
});
