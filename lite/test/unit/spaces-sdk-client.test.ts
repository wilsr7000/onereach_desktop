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
