/**
 * Spaces SDK client unit tests.
 *
 * Tests the Cypher-emitting SDK client against a stub `queryFn` that
 * returns canned record streams. The stub captures every Cypher +
 * parameter pair the client emits, so the suite asserts both:
 *   - The exact Cypher fragment for each method (regression guard
 *     against accidental query drift).
 *   - The row-to-domain-object mapping (covers field aliasing,
 *     missing fields, malformed payloads, kind validation).
 *
 * The Neon module is never imported here -- the client takes a
 * narrow `queryFn` callback for exactly this reason. Integration
 * with the real `getNeonApi().query` is covered separately by the
 * `spaces-integration.test.ts` Phase 1+ suite.
 */

import { describe, it, expect } from 'vitest';
import {
  SdkSpacesClient,
  CYPHER,
  type SpacesQueryFn,
} from '../../spaces/sdk-client.js';
import { SpacesError } from '../../spaces/errors.js';
import { UNCATEGORIZED_SPACE_ID } from '../../spaces/scope.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

interface QueryCall {
  cypher: string;
  parameters: Record<string, unknown> | undefined;
}

interface StubQuery {
  fn: SpacesQueryFn;
  calls: QueryCall[];
  /** Returns the response keyed by a Cypher needle (substring). */
  setResponse(needle: string, rows: Array<Record<string, unknown>>): void;
  setError(needle: string, err: unknown): void;
}

function buildStubQuery(): StubQuery {
  const calls: QueryCall[] = [];
  const responses = new Map<string, Array<Record<string, unknown>>>();
  const errors = new Map<string, unknown>();
  const fn: SpacesQueryFn = async (cypher, parameters) => {
    calls.push({ cypher, parameters });
    for (const [needle, err] of errors) {
      if (cypher.includes(needle)) throw err;
    }
    for (const [needle, rows] of responses) {
      if (cypher.includes(needle)) return rows;
    }
    return [];
  };
  return {
    fn,
    calls,
    setResponse: (needle, rows) => responses.set(needle, rows),
    setError: (needle, err) => errors.set(needle, err),
  };
}

function makeClient(stub: StubQuery): SdkSpacesClient {
  return new SdkSpacesClient({ query: stub.fn });
}

// ─── Cypher source regression guards ─────────────────────────────────────

describe('CYPHER source strings', () => {
  it('listSpaces query matches :Space + itemCount via :Asset/:BELONGS_TO', () => {
    expect(CYPHER.LIST_SPACES).toMatch(/MATCH \(s:Space\)/);
    expect(CYPHER.LIST_SPACES).toMatch(/\(a:Asset\)-\[:BELONGS_TO\]->\(s\)/);
    expect(CYPHER.LIST_SPACES).toMatch(/RETURN/);
    expect(CYPHER.LIST_SPACES).toMatch(/ORDER BY toLower/);
    expect(CYPHER.LIST_SPACES).toMatch(/count\(a\) AS itemCount/);
  });

  it('uncategorized count uses NOT (a)-[:BELONGS_TO]->(:Space)', () => {
    expect(CYPHER.UNCATEGORIZED_COUNT).toMatch(
      /WHERE NOT \(a\)-\[:BELONGS_TO\]->\(:Space\)/
    );
    expect(CYPHER.UNCATEGORIZED_COUNT).toMatch(/count\(a\) AS count/);
  });

  it('list-items-uncategorized matches :Asset with no :Space membership', () => {
    expect(CYPHER.LIST_ITEMS_UNCATEGORIZED).toMatch(/MATCH \(a:Asset\)/);
    expect(CYPHER.LIST_ITEMS_UNCATEGORIZED).toMatch(
      /WHERE NOT \(a\)-\[:BELONGS_TO\]->\(:Space\)/
    );
    expect(CYPHER.LIST_ITEMS_UNCATEGORIZED).toMatch(/\[\] AS otherSpaces/);
    expect(CYPHER.LIST_ITEMS_UNCATEGORIZED).toMatch(/SKIP toInteger\(\$offset\)/);
    expect(CYPHER.LIST_ITEMS_UNCATEGORIZED).toMatch(/LIMIT toInteger\(\$limit\)/);
  });

  it('list-items-in-space takes a spaceId param and filters otherSpaces', () => {
    expect(CYPHER.LIST_ITEMS_IN_SPACE).toMatch(/\(a:Asset\)-\[:BELONGS_TO\]->\(s:Space \{id: \$spaceId\}\)/);
    expect(CYPHER.LIST_ITEMS_IN_SPACE).toMatch(/other\.id <> s\.id/);
    expect(CYPHER.LIST_ITEMS_IN_SPACE).toMatch(/\[x IN otherSpacesRaw WHERE x\.id IS NOT NULL\] AS otherSpaces/);
  });

  it('getItem uses :Asset id parameter and LIMIT 1', () => {
    expect(CYPHER.GET_ITEM).toMatch(/\(a:Asset \{id: \$id\}\)/);
    expect(CYPHER.GET_ITEM).toMatch(/LIMIT 1$/m);
    expect(CYPHER.GET_ITEM).toMatch(/coalesce\(a\.content, ''\) AS content/);
    expect(CYPHER.GET_ITEM).toMatch(/null AS metadata/);
  });

  it('every projection uses canonical-with-legacy coalesce for renames', () => {
    // a.name is canonical (per :Schema), a.title is legacy (per
    // omnigraph-client.js). Both LIST_ITEMS_* projections must
    // coalesce so existing data still renders.
    expect(CYPHER.LIST_ITEMS_IN_SPACE).toMatch(/coalesce\(a\.name, a\.title, a\.id\) AS title/);
    expect(CYPHER.LIST_ITEMS_UNCATEGORIZED).toMatch(/coalesce\(a\.name, a\.title, a\.id\) AS title/);
    expect(CYPHER.LIST_ITEMS_IN_SPACE).toMatch(/coalesce\(a\.type, a\.assetType, 'other'\) AS kind/);
    expect(CYPHER.LIST_ITEMS_IN_SPACE).toMatch(/coalesce\(a\.url, a\.fileUrl\) AS fileKey/);
  });

  it('uses canonical (:Person)-[:CREATED]->(:Asset) for producer projection', () => {
    expect(CYPHER.LIST_ITEMS_IN_SPACE).toMatch(
      /OPTIONAL MATCH \(creator:Person\)-\[:CREATED\]->\(a\)/
    );
    expect(CYPHER.LIST_ITEMS_UNCATEGORIZED).toMatch(
      /OPTIONAL MATCH \(creator:Person\)-\[:CREATED\]->\(a\)/
    );
    expect(CYPHER.GET_ITEM).toMatch(
      /OPTIONAL MATCH \(creator:Person\)-\[:CREATED\]->\(a\)/
    );
  });
});

// ─── listSpaces() ────────────────────────────────────────────────────────

describe('SdkSpacesClient.listSpaces', () => {
  it('maps Cypher rows to Space objects with full property set', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (s:Space)', [
      {
        id: 'sp-1',
        name: 'Engineering',
        description: 'Engineering work',
        color: '#4f8cff',
        iconKey: 'cog',
        itemCount: 42,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-05T00:00:00Z',
      },
    ]);
    const client = makeClient(stub);
    const spaces = await client.listSpaces();
    expect(spaces).toEqual([
      {
        id: 'sp-1',
        name: 'Engineering',
        description: 'Engineering work',
        color: '#4f8cff',
        iconKey: 'cog',
        itemCount: 42,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-05T00:00:00Z',
      },
    ]);
  });

  it('drops optional fields cleanly when Cypher returns null/empty', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (s:Space)', [
      {
        id: 'sp-2',
        name: 'Minimal',
        description: null,
        color: null,
        iconKey: null,
        itemCount: null,
        createdAt: null,
        updatedAt: null,
      },
    ]);
    const client = makeClient(stub);
    const [space] = await client.listSpaces();
    expect(space).toEqual({ id: 'sp-2', name: 'Minimal' });
    expect(space).not.toHaveProperty('description');
    expect(space).not.toHaveProperty('color');
    expect(space).not.toHaveProperty('itemCount');
  });

  it('returns an empty array when no rows come back', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (s:Space)', []);
    const client = makeClient(stub);
    expect(await client.listSpaces()).toEqual([]);
  });

  it('throws SPACES_CYPHER when a row is missing the required id', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (s:Space)', [{ name: 'No-id' }]);
    const client = makeClient(stub);
    await expect(client.listSpaces()).rejects.toThrow(SpacesError);
  });
});

// ─── getUncategorizedCount() ─────────────────────────────────────────────

describe('SdkSpacesClient.getUncategorizedCount', () => {
  it('returns the count value as a number', async () => {
    const stub = buildStubQuery();
    stub.setResponse('WHERE NOT (a)-[:BELONGS_TO]->(:Space)', [{ count: 17 }]);
    const client = makeClient(stub);
    expect(await client.getUncategorizedCount()).toBe(17);
  });

  it('returns 0 when no rows come back', async () => {
    const stub = buildStubQuery();
    stub.setResponse('WHERE NOT (a)-[:BELONGS_TO]->(:Space)', []);
    const client = makeClient(stub);
    expect(await client.getUncategorizedCount()).toBe(0);
  });

  it('clamps negative or fractional counts to a non-negative integer', async () => {
    const stub = buildStubQuery();
    stub.setResponse('WHERE NOT (a)-[:BELONGS_TO]->(:Space)', [{ count: -5 }]);
    const client = makeClient(stub);
    expect(await client.getUncategorizedCount()).toBe(0);
  });

  it('returns 0 when count field is missing or non-numeric', async () => {
    const stub = buildStubQuery();
    stub.setResponse('WHERE NOT (a)-[:BELONGS_TO]->(:Space)', [{ count: 'nope' }]);
    const client = makeClient(stub);
    expect(await client.getUncategorizedCount()).toBe(0);
  });
});

// ─── listItems() — uncategorized scope ──────────────────────────────────

describe('SdkSpacesClient.listItems (uncategorized)', () => {
  it('emits LIST_ITEMS_UNCATEGORIZED with default offset/limit', async () => {
    const stub = buildStubQuery();
    stub.setResponse('WHERE NOT (a)-[:BELONGS_TO]->(:Space)\n    OPTIONAL MATCH', []);
    const client = makeClient(stub);
    await client.listItems({ kind: 'uncategorized' });
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toEqual({ offset: 0, limit: 100 });
    expect(call?.cypher).toContain('OPTIONAL MATCH (creator:Person)-[:CREATED]->(a)');
  });

  it('always returns otherSpaces=[] for uncategorized scope', async () => {
    const stub = buildStubQuery();
    stub.setResponse('WHERE NOT (a)-[:BELONGS_TO]->(:Space)\n    OPTIONAL MATCH', [
      {
        id: 'i-1',
        title: 'Inbox file',
        kind: 'document',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
        otherSpaces: [{ id: 'sp-99', name: 'Should be stripped' }], // lie from Cypher
        producedBy: null,
      },
    ]);
    const client = makeClient(stub);
    const [item] = await client.listItems({ kind: 'uncategorized' });
    expect(item?.otherSpaces).toEqual([]);
  });

  it('normalizes unknown kinds to "other"', async () => {
    const stub = buildStubQuery();
    stub.setResponse('WHERE NOT (a)-[:BELONGS_TO]->(:Space)\n    OPTIONAL MATCH', [
      {
        id: 'i-2',
        title: 'Weird',
        kind: 'thing-from-future',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        otherSpaces: [],
        producedBy: null,
      },
    ]);
    const client = makeClient(stub);
    const [item] = await client.listItems({ kind: 'uncategorized' });
    expect(item?.kind).toBe('other');
  });

  it('parses producedBy when the producer projection is populated', async () => {
    const stub = buildStubQuery();
    stub.setResponse('WHERE NOT (a)-[:BELONGS_TO]->(:Space)\n    OPTIONAL MATCH', [
      {
        id: 'i-3',
        title: 'Agent output',
        kind: 'text',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        otherSpaces: [],
        producedBy: { kind: 'Agent', name: 'Quarterly Audit Agent', id: 'ag-1' },
      },
    ]);
    const client = makeClient(stub);
    const [item] = await client.listItems({ kind: 'uncategorized' });
    expect(item?.producedBy).toEqual({
      kind: 'Agent',
      name: 'Quarterly Audit Agent',
      id: 'ag-1',
    });
  });

  it('respects limit/offset opts (clamped to MAX_LIMIT=500)', async () => {
    const stub = buildStubQuery();
    stub.setResponse('WHERE NOT (a)-[:BELONGS_TO]->(:Space)\n    OPTIONAL MATCH', []);
    const client = makeClient(stub);
    await client.listItems({ kind: 'uncategorized' }, { limit: 999_999, offset: 50 });
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toEqual({ offset: 50, limit: 500 });
  });
});

// ─── listItems() — space scope ──────────────────────────────────────────

describe('SdkSpacesClient.listItems (space)', () => {
  it('throws SPACES_INVALID_INPUT for an empty spaceId', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    await expect(
      client.listItems({ kind: 'space', spaceId: '' })
    ).rejects.toMatchObject({ code: 'SPACES_INVALID_INPUT' });
  });

  it('emits LIST_ITEMS_IN_SPACE with the spaceId parameter', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a:Asset)-[:BELONGS_TO]->(s:Space', []);
    const client = makeClient(stub);
    await client.listItems({ kind: 'space', spaceId: 'sp-77' }, { limit: 20 });
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toEqual({ spaceId: 'sp-77', offset: 0, limit: 20 });
  });

  it('keeps non-null otherSpaces chips and drops empty entries', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a:Asset)-[:BELONGS_TO]->(s:Space', [
      {
        id: 'i-9',
        title: 'Cross-space item',
        kind: 'document',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        otherSpaces: [
          { id: 'sp-2', name: 'Sales', color: '#ff9c4a', iconKey: 'briefcase' },
          { id: 'sp-3', name: 'Marketing' },
          { id: null, name: 'empty' }, // should be dropped
          { name: 'no-id' }, // should be dropped
        ],
        producedBy: null,
      },
    ]);
    const client = makeClient(stub);
    const [item] = await client.listItems({ kind: 'space', spaceId: 'sp-1' });
    expect(item?.otherSpaces).toEqual([
      { id: 'sp-2', name: 'Sales', color: '#ff9c4a', iconKey: 'briefcase' },
      { id: 'sp-3', name: 'Marketing' },
    ]);
  });
});

// ─── getItem() ──────────────────────────────────────────────────────────

describe('SdkSpacesClient.getItem', () => {
  it('returns null when no rows come back', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a:Asset {id: $id})', []);
    const client = makeClient(stub);
    expect(await client.getItem('missing')).toBeNull();
  });

  it('maps the full Item including content + metadata', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a:Asset {id: $id})', [
      {
        id: 'i-100',
        title: 'Spec doc',
        kind: 'text',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        excerpt: 'first 120 chars…',
        content: 'full text content here',
        metadata: { source: 'web-clip', wordCount: 1234 },
        otherSpaces: [{ id: 'sp-1', name: 'Engineering' }],
        producedBy: { kind: 'Person', name: 'Robb', id: 'p-1' },
      },
    ]);
    const client = makeClient(stub);
    const item = await client.getItem('i-100');
    expect(item).toMatchObject({
      id: 'i-100',
      title: 'Spec doc',
      kind: 'text',
      content: 'full text content here',
      metadata: { source: 'web-clip', wordCount: 1234 },
      otherSpaces: [{ id: 'sp-1', name: 'Engineering' }],
      producedBy: { kind: 'Person', name: 'Robb', id: 'p-1' },
    });
  });

  it('throws SPACES_INVALID_INPUT for empty id', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    await expect(client.getItem('')).rejects.toMatchObject({
      code: 'SPACES_INVALID_INPUT',
    });
  });

  it('drops malformed metadata silently (returns the rest of the Item)', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a:Asset {id: $id})', [
      {
        id: 'i-101',
        title: 'No meta',
        kind: 'document',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        otherSpaces: [],
        producedBy: null,
        metadata: 'not-an-object',
      },
    ]);
    const client = makeClient(stub);
    const item = await client.getItem('i-101');
    expect(item).not.toBeNull();
    expect(item?.metadata).toBeUndefined();
  });
});

// ─── Error normalization ────────────────────────────────────────────────

describe('SdkSpacesClient error normalization', () => {
  it('maps NEON_NOT_CONFIGURED to SPACES_NOT_AUTHENTICATED', async () => {
    const stub = buildStubQuery();
    const neonErr = new Error('not configured');
    (neonErr as Error & { code?: string }).code = 'NEON_NOT_CONFIGURED';
    stub.setError('MATCH (s:Space)', neonErr);
    const client = makeClient(stub);
    await expect(client.listSpaces()).rejects.toMatchObject({
      code: 'SPACES_NOT_AUTHENTICATED',
    });
  });

  it('maps NEON_NETWORK / NEON_TIMEOUT to SPACES_NETWORK', async () => {
    const stub = buildStubQuery();
    const neonErr = new Error('timeout');
    (neonErr as Error & { code?: string }).code = 'NEON_TIMEOUT';
    stub.setError('MATCH (s:Space)', neonErr);
    const client = makeClient(stub);
    await expect(client.listSpaces()).rejects.toMatchObject({
      code: 'SPACES_NETWORK',
    });
  });

  it('maps NEON_QUERY / NEON_HTTP / NEON_BAD_INPUT to SPACES_CYPHER', async () => {
    const stub = buildStubQuery();
    const neonErr = new Error('syntax error');
    (neonErr as Error & { code?: string }).code = 'NEON_QUERY';
    stub.setError('MATCH (s:Space)', neonErr);
    const client = makeClient(stub);
    await expect(client.listSpaces()).rejects.toMatchObject({
      code: 'SPACES_CYPHER',
    });
  });

  it('unknown errors map to SPACES_CYPHER with the original message', async () => {
    const stub = buildStubQuery();
    stub.setError('MATCH (s:Space)', new Error('boom'));
    const client = makeClient(stub);
    await expect(client.listSpaces()).rejects.toMatchObject({
      code: 'SPACES_CYPHER',
      message: 'boom',
    });
  });

  it('default client (no query fn) throws SPACES_NOT_INITIALIZED', async () => {
    const client = new SdkSpacesClient();
    await expect(client.listSpaces()).rejects.toMatchObject({
      code: 'SPACES_NOT_INITIALIZED',
    });
  });
});

// ─── Scope discriminator sanity ──────────────────────────────────────────

describe('SpaceScope handling', () => {
  it('UNCATEGORIZED_SPACE_ID is the synthetic sentinel string', () => {
    expect(UNCATEGORIZED_SPACE_ID).toBe('__uncategorized__');
  });
});

// ─── Home view (chunk 3k + 3o) ──────────────────────────────────────────
//
// Cypher source regression + row-mapping coverage for the 6 new SDK
// methods that power the Home news-feed cards. See lite/spaces/HOME-V1.md.

describe('CYPHER source strings — Home view', () => {
  it('HOME_ENTITY_COUNTS uses APOC stats', () => {
    expect(CYPHER.HOME_ENTITY_COUNTS).toMatch(/CALL apoc\.meta\.stats\(\) YIELD labels/);
    expect(CYPHER.HOME_ENTITY_COUNTS).toMatch(/RETURN labels/);
  });

  it('HOME_ENTITY_COUNTS_FALLBACK uses explicit UNION ALL per label', () => {
    expect(CYPHER.HOME_ENTITY_COUNTS_FALLBACK).toMatch(/MATCH \(s:Space\)/);
    expect(CYPHER.HOME_ENTITY_COUNTS_FALLBACK).toMatch(/MATCH \(a:Asset\)/);
    expect(CYPHER.HOME_ENTITY_COUNTS_FALLBACK).toMatch(/MATCH \(p:Person\)/);
    expect(CYPHER.HOME_ENTITY_COUNTS_FALLBACK).toMatch(/MATCH \(g:Agent\)/);
    expect(CYPHER.HOME_ENTITY_COUNTS_FALLBACK).toMatch(/UNION ALL/);
  });

  it('HOME_RECENT_ITEMS uses :Asset label and ItemSummary projection', () => {
    expect(CYPHER.HOME_RECENT_ITEMS).toMatch(/MATCH \(a:Asset\)/);
    expect(CYPHER.HOME_RECENT_ITEMS).toMatch(/coalesce\(a\.name, a\.title, a\.id\) AS title/);
    expect(CYPHER.HOME_RECENT_ITEMS).toMatch(/LIMIT toInteger\(\$limit\)/);
  });

  it('HOME_TOP_CONTRIBUTORS aggregates :Commit by author with $sinceMs cutoff', () => {
    expect(CYPHER.HOME_TOP_CONTRIBUTORS).toMatch(/MATCH \(c:Commit\)/);
    expect(CYPHER.HOME_TOP_CONTRIBUTORS).toMatch(/c\.timestamp >= \$sinceMs/);
    expect(CYPHER.HOME_TOP_CONTRIBUTORS).toMatch(/count\(c\) AS events/);
    expect(CYPHER.HOME_TOP_CONTRIBUTORS).toMatch(/LIMIT toInteger\(\$limit\)/);
  });

  it('HOME_RECENT_EVENTS surfaces c.message verbatim as kind (per Q-Home-4)', () => {
    expect(CYPHER.HOME_RECENT_EVENTS).toMatch(/MATCH \(c:Commit\)/);
    expect(CYPHER.HOME_RECENT_EVENTS).toMatch(/c\.message AS kind/);
    expect(CYPHER.HOME_RECENT_EVENTS).toMatch(/\$since IS NULL OR c\.timestamp >= \$since/);
  });

  it('HOME_RECENT_EVENTS accepts an optional $spaceId filter (per-Space mini-Home)', () => {
    // The per-Space view feeds this query the active spaceId so the
    // timeline shows only commits for that Space. NULL means "no
    // scope filter" (Home view).
    expect(CYPHER.HOME_RECENT_EVENTS).toMatch(
      /\$spaceId IS NULL OR c\.spaceId = \$spaceId/
    );
  });

  it('HOME_RECENT_EVENTS uses (:Commit)-[:IN_SPACE]->(:Space) — direction matters', () => {
    // The actual graph stores the edge as Commit → Space (verified
    // live: 120 commits forward direction, 0 reverse). The reverse
    // arrow `(c)<-[:IN_SPACE]-(s:Space)` would silently miss every
    // edge and the modal would render the spaceId as the spaceName
    // via the `coalesce(s.name, c.spaceId)` fallback. Pin the
    // correct direction so future edits don't drift.
    expect(CYPHER.HOME_RECENT_EVENTS).toMatch(
      /OPTIONAL MATCH \(c\)-\[:IN_SPACE\]->\(s:Space\)/
    );
    expect(CYPHER.HOME_RECENT_EVENTS).not.toMatch(/<-\[:IN_SPACE\]-/);
  });

  it('HOME_AGENTS_SAMPLE uses :Agent label with name + description fallback', () => {
    expect(CYPHER.HOME_AGENTS_SAMPLE).toMatch(/MATCH \(a:Agent\)/);
    expect(CYPHER.HOME_AGENTS_SAMPLE).toMatch(/coalesce\(a\.name, a\.title, a\.id\) AS name/);
    expect(CYPHER.HOME_AGENTS_SAMPLE).toMatch(/coalesce\(a\.description, a\.summary, ''\) AS description/);
  });

  it('HOME_PERMISSION_SUMMARY counts visible :Space nodes', () => {
    expect(CYPHER.HOME_PERMISSION_SUMMARY).toMatch(/MATCH \(s:Space\)/);
    expect(CYPHER.HOME_PERMISSION_SUMMARY).toMatch(/count\(s\) AS visible/);
  });
});

describe('SdkSpacesClient.getEntityCounts', () => {
  it('normalises APOC labels into a flat counts shape', async () => {
    const stub = buildStubQuery();
    stub.setResponse('apoc.meta.stats()', [
      {
        labels: { Space: 4, Asset: 9, Person: 3, Agent: 159, Heartbeat: 565 },
      },
    ]);
    const client = makeClient(stub);
    expect(await client.getEntityCounts()).toEqual({
      spaces: 4,
      assets: 9,
      people: 3,
      agents: 159,
    });
  });

  it('falls back to UNION ALL when APOC returns "procedure not found"', async () => {
    const stub = buildStubQuery();
    const apocErr = new Error('There is no procedure with the name `apoc.meta.stats` registered');
    (apocErr as Error & { code?: string }).code = 'NEON_QUERY';
    stub.setError('apoc.meta.stats()', apocErr);
    stub.setResponse('UNION ALL', [
      { kind: 'Space', n: 4 },
      { kind: 'Asset', n: 9 },
      { kind: 'Person', n: 3 },
      { kind: 'Agent', n: 159 },
    ]);
    const client = makeClient(stub);
    expect(await client.getEntityCounts()).toEqual({
      spaces: 4,
      assets: 9,
      people: 3,
      agents: 159,
    });
  });

  it('defaults missing labels to 0 instead of undefined', async () => {
    const stub = buildStubQuery();
    stub.setResponse('apoc.meta.stats()', [{ labels: { Space: 2 } }]);
    const client = makeClient(stub);
    expect(await client.getEntityCounts()).toEqual({
      spaces: 2,
      assets: 0,
      people: 0,
      agents: 0,
    });
  });

  it('propagates non-APOC errors instead of falling back', async () => {
    const stub = buildStubQuery();
    const authErr = new Error('not configured');
    (authErr as Error & { code?: string }).code = 'NEON_NOT_CONFIGURED';
    stub.setError('apoc.meta.stats()', authErr);
    const client = makeClient(stub);
    await expect(client.getEntityCounts()).rejects.toMatchObject({
      code: 'SPACES_NOT_AUTHENTICATED',
    });
  });
});

describe('SdkSpacesClient.listRecentItems', () => {
  it('emits HOME_RECENT_ITEMS with the limit parameter', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a:Asset)', []);
    const client = makeClient(stub);
    await client.listRecentItems({ limit: 5 });
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toEqual({ limit: 5 });
  });

  it('clamps limit to default 3 when not provided', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a:Asset)', []);
    const client = makeClient(stub);
    await client.listRecentItems();
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toEqual({ limit: 3 });
  });

  it('caps limit at 50 (Home card max-row context)', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a:Asset)', []);
    const client = makeClient(stub);
    await client.listRecentItems({ limit: 999 });
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toEqual({ limit: 50 });
  });

  it('maps rows to ItemSummary with single-Space chip', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a:Asset)', [
      {
        id: 'a-1',
        title: 'Conversation transcript',
        kind: 'text',
        createdAt: '2026-05-11T18:00:00Z',
        updatedAt: '2026-05-11T18:00:00Z',
        otherSpaces: [
          { id: 'sp-1', name: 'ChatGPT Conversations', color: '#10a37f' },
        ],
        producedBy: null,
      },
    ]);
    const client = makeClient(stub);
    const items = await client.listRecentItems();
    expect(items[0]?.title).toBe('Conversation transcript');
    expect(items[0]?.otherSpaces[0]?.name).toBe('ChatGPT Conversations');
  });
});

describe('SdkSpacesClient.topContributors', () => {
  it('passes window=week sinceMs by default', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (c:Commit)', []);
    const client = makeClient(stub);
    const before = Date.now();
    await client.topContributors();
    const after = Date.now();
    const call = stub.calls[stub.calls.length - 1];
    const since = (call?.parameters?.['sinceMs'] as number);
    // 7 days = 604800000 ms; allow 1s slack for clock between calls.
    expect(since).toBeGreaterThanOrEqual(before - 7 * 24 * 60 * 60 * 1000 - 1000);
    expect(since).toBeLessThanOrEqual(after - 7 * 24 * 60 * 60 * 1000 + 1000);
    expect(call?.parameters?.['limit']).toBe(4);
  });

  it('honours window=day', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (c:Commit)', []);
    const client = makeClient(stub);
    const before = Date.now();
    await client.topContributors({ window: 'day', limit: 10 });
    const after = Date.now();
    const call = stub.calls[stub.calls.length - 1];
    const since = (call?.parameters?.['sinceMs'] as number);
    expect(since).toBeGreaterThanOrEqual(before - 24 * 60 * 60 * 1000 - 1000);
    expect(since).toBeLessThanOrEqual(after - 24 * 60 * 60 * 1000 + 1000);
    expect(call?.parameters?.['limit']).toBe(10);
  });

  it('maps rows; v1 displayName equals author verbatim', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (c:Commit)', [
      { author: 'Audit Agent', events: 47, lastEventAt: '1778691652347' },
      { author: 'device_mac.lan_xyz', events: 14, lastEventAt: '1778600000000' },
    ]);
    const client = makeClient(stub);
    const rows = await client.topContributors();
    expect(rows).toEqual([
      {
        author: 'Audit Agent',
        displayName: 'Audit Agent',
        events: 47,
        lastEventAt: '1778691652347',
      },
      {
        author: 'device_mac.lan_xyz',
        displayName: 'device_mac.lan_xyz',
        events: 14,
        lastEventAt: '1778600000000',
      },
    ]);
  });

  it('drops malformed rows (missing author)', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (c:Commit)', [
      { events: 10 }, // no author
      { author: 'OK', events: 5, lastEventAt: '0' },
    ]);
    const client = makeClient(stub);
    const rows = await client.topContributors();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.author).toBe('OK');
  });
});

describe('SdkSpacesClient.listRecentEvents', () => {
  it('default limit is 50, since + spaceId both null (Home scope)', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (c:Commit)', []);
    const client = makeClient(stub);
    await client.listRecentEvents();
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toEqual({ limit: 50, since: null, spaceId: null });
  });

  it('passes since when provided as a non-negative number', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (c:Commit)', []);
    const client = makeClient(stub);
    await client.listRecentEvents({ limit: 10, since: 1700000000000 });
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toEqual({
      limit: 10,
      since: 1700000000000,
      spaceId: null,
    });
  });

  it('caps limit at 200', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (c:Commit)', []);
    const client = makeClient(stub);
    await client.listRecentEvents({ limit: 1_000_000 });
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toEqual({ limit: 200, since: null, spaceId: null });
  });

  it('passes spaceId when provided (per-Space mini-Home)', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (c:Commit)', []);
    const client = makeClient(stub);
    await client.listRecentEvents({ limit: 20, spaceId: 'sp-77' });
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toEqual({ limit: 20, since: null, spaceId: 'sp-77' });
  });

  it('treats an empty spaceId as "no scope" (null), not an empty match', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (c:Commit)', []);
    const client = makeClient(stub);
    await client.listRecentEvents({ spaceId: '' });
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toEqual({ limit: 50, since: null, spaceId: null });
  });

  it('maps rows; missing spaceId / spaceName drop the optional fields', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (c:Commit)', [
      {
        id: 'h1',
        author: 'Audit Agent',
        kind: 'item:added',
        timestamp: '1778691652347',
        spaceId: 'sp-1',
        spaceName: 'Engineering',
      },
      {
        id: 'h2',
        author: 'system',
        kind: 'item:updated',
        timestamp: '1778691000000',
      },
    ]);
    const client = makeClient(stub);
    const rows = await client.listRecentEvents();
    expect(rows[0]?.spaceName).toBe('Engineering');
    expect(rows[1]).not.toHaveProperty('spaceName');
    expect(rows[1]).not.toHaveProperty('spaceId');
  });
});

describe('SdkSpacesClient.listAgentsSample', () => {
  it('default limit is 3, cap is 200', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a:Agent)', []);
    const client = makeClient(stub);
    await client.listAgentsSample();
    let call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toEqual({ limit: 3 });
    await client.listAgentsSample({ limit: 9999 });
    call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toEqual({ limit: 200 });
  });

  it('maps rows; description defaults to empty string', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a:Agent)', [
      { id: 'ag-1', name: 'Audit Agent', description: 'Quarterly compliance' },
      { id: 'ag-2', name: 'No Desc' },
    ]);
    const client = makeClient(stub);
    const rows = await client.listAgentsSample();
    expect(rows[0]).toEqual({
      id: 'ag-1',
      name: 'Audit Agent',
      description: 'Quarterly compliance',
    });
    expect(rows[1]).toEqual({ id: 'ag-2', name: 'No Desc', description: '' });
  });

  it('drops rows with no id', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a:Agent)', [
      { name: 'Orphan', description: '' },
      { id: 'ag-3', name: 'Valid', description: '' },
    ]);
    const client = makeClient(stub);
    const rows = await client.listAgentsSample();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('ag-3');
  });
});

describe('SdkSpacesClient.getPermissionSummary', () => {
  it('returns visibleSpaceCount as a non-negative integer', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (s:Space)', [{ visibleSpaceCount: 4 }]);
    const client = makeClient(stub);
    expect(await client.getPermissionSummary()).toEqual({ visibleSpaceCount: 4 });
  });

  it('clamps negative or non-numeric visibleSpaceCount to 0', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (s:Space)', [{ visibleSpaceCount: -3 }]);
    const client = makeClient(stub);
    expect(await client.getPermissionSummary()).toEqual({ visibleSpaceCount: 0 });
  });

  it('exposes totalSpaceCount when present', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (s:Space)', [
      { visibleSpaceCount: 4, totalSpaceCount: 7 },
    ]);
    const client = makeClient(stub);
    expect(await client.getPermissionSummary()).toEqual({
      visibleSpaceCount: 4,
      totalSpaceCount: 7,
    });
  });

  it('returns visibleSpaceCount=0 when no rows come back', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (s:Space)', []);
    const client = makeClient(stub);
    expect(await client.getPermissionSummary()).toEqual({ visibleSpaceCount: 0 });
  });
});
