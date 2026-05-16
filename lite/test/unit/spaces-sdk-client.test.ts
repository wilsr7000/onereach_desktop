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
    // Soft-deleted Spaces (deletedAt set) MUST be filtered out.
    // Without this WHERE, a deleted Space stays visible in the
    // sidebar after `deleteSpace()` even though the mutation
    // succeeded -- the user-reported bug from 2026-05-15.
    expect(CYPHER.LIST_SPACES).toMatch(/WHERE s\.deletedAt IS NULL/);
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
    // Soft-deleted Spaces (target Space OR a multi-Space chip
    // target) MUST be filtered so the user never sees an item
    // attributed to a Space they just deleted.
    expect(CYPHER.LIST_ITEMS_IN_SPACE).toMatch(/WHERE s\.deletedAt IS NULL/);
    expect(CYPHER.LIST_ITEMS_IN_SPACE).toMatch(/other\.deletedAt IS NULL/);
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

  it('GET_ITEM projects size + mimeType + tags + lastEditedBy (Phase A2)', () => {
    expect(CYPHER.GET_ITEM).toMatch(/coalesce\(a\.size, a\.fileSize, a\.byteCount\) AS size/);
    expect(CYPHER.GET_ITEM).toMatch(/coalesce\(a\.mimeType, a\.contentType\) AS mimeType/);
    expect(CYPHER.GET_ITEM).toMatch(/coalesce\(a\.tags, edgeTags, \[\]\) AS tags/);
    expect(CYPHER.GET_ITEM).toMatch(
      /OPTIONAL MATCH \(editor:Person\)-\[:LAST_EDITED\]->\(a\)/
    );
    expect(CYPHER.GET_ITEM).toMatch(/AS lastEditedBy/);
  });

  it('GET_ITEM uses [:TAGGED_AS]->(:Tag) edges as the canonical tag fallback', () => {
    expect(CYPHER.GET_ITEM).toMatch(/OPTIONAL MATCH \(a\)-\[:TAGGED_AS\]->\(t:Tag\)/);
    expect(CYPHER.GET_ITEM).toMatch(/coalesce\(t\.name, t\.id\)\) AS edgeTags/);
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

  it('maps size + mimeType when present (Phase A2)', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a:Asset {id: $id})', [
      {
        id: 'i-200',
        title: 'A PDF',
        kind: 'document',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        otherSpaces: [],
        producedBy: null,
        size: 8421376,
        mimeType: 'application/pdf',
      },
    ]);
    const client = makeClient(stub);
    const item = await client.getItem('i-200');
    expect(item?.size).toBe(8421376);
    expect(item?.mimeType).toBe('application/pdf');
  });

  it('drops size when non-positive or non-finite', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a:Asset {id: $id})', [
      {
        id: 'i-201',
        title: 'A',
        kind: 'other',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: null,
        size: -1,
      },
    ]);
    const client = makeClient(stub);
    const item = await client.getItem('i-201');
    expect(item?.size).toBeUndefined();
  });

  it('floors fractional size values to an integer', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a:Asset {id: $id})', [
      {
        id: 'i-202',
        title: 'A',
        kind: 'other',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: null,
        size: 1234.7,
      },
    ]);
    const client = makeClient(stub);
    const item = await client.getItem('i-202');
    expect(item?.size).toBe(1234);
  });

  it('normalizes tags into a clean string[] (drops empty / non-string entries)', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a:Asset {id: $id})', [
      {
        id: 'i-203',
        title: 'Tagged',
        kind: 'text',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: null,
        tags: ['  policy ', '', 'q3', null, 42, '   ', 'finance'],
      },
    ]);
    const client = makeClient(stub);
    const item = await client.getItem('i-203');
    expect(item?.tags).toEqual(['policy', 'q3', 'finance']);
  });

  it('defaults tags to [] when missing or non-array', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a:Asset {id: $id})', [
      {
        id: 'i-204',
        title: 'No tags',
        kind: 'text',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: null,
      },
    ]);
    const client = makeClient(stub);
    const item = await client.getItem('i-204');
    expect(item?.tags).toEqual([]);
  });

  it('maps lastEditedBy when projection is non-null', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a:Asset {id: $id})', [
      {
        id: 'i-205',
        title: 'Edited',
        kind: 'text',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: { kind: 'Person', name: 'Robb', id: 'p-1' },
        lastEditedBy: { kind: 'Person', name: 'Alice', id: 'p-2' },
      },
    ]);
    const client = makeClient(stub);
    const item = await client.getItem('i-205');
    expect(item?.lastEditedBy).toEqual({
      kind: 'Person',
      name: 'Alice',
      id: 'p-2',
    });
  });

  it('returns null lastEditedBy when projection is null (schema lacks the edge)', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a:Asset {id: $id})', [
      {
        id: 'i-206',
        title: 'No editor',
        kind: 'text',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: null,
        lastEditedBy: null,
      },
    ]);
    const client = makeClient(stub);
    const item = await client.getItem('i-206');
    expect(item?.lastEditedBy).toBeNull();
  });
});

// ─── Phase 3b: items.update + tag mutations ─────────────────────────────

describe('CYPHER strings — Phase 3b mutations', () => {
  it('UPDATE_ITEM uses coalesce so missing fields keep the prior value', () => {
    expect(CYPHER.UPDATE_ITEM).toMatch(/SET a\.name = coalesce\(\$title, a\.name\)/);
    expect(CYPHER.UPDATE_ITEM).toMatch(/SET .*a\.title = coalesce\(\$title, a\.title\)/s);
    expect(CYPHER.UPDATE_ITEM).toMatch(/a\.description = coalesce\(\$description, a\.description\)/);
    expect(CYPHER.UPDATE_ITEM).toMatch(/a\.type = coalesce\(\$type, a\.type\)/);
    expect(CYPHER.UPDATE_ITEM).toMatch(/a\.updatedAt = \$now/);
  });

  it('UPDATE_ITEM maintains a single [:LAST_EDITED] edge via DELETE+MERGE', () => {
    expect(CYPHER.UPDATE_ITEM).toMatch(/OPTIONAL MATCH \(a\)<-\[r:LAST_EDITED\]-\(:Person\)/);
    expect(CYPHER.UPDATE_ITEM).toMatch(/DELETE r/);
    expect(CYPHER.UPDATE_ITEM).toMatch(/MERGE \(x\)-\[:LAST_EDITED\]->\(a\)/);
  });

  it('ADD_TAG merges :Tag by name + edge by MERGE (idempotent)', () => {
    expect(CYPHER.ADD_TAG).toMatch(/MATCH \(a:Asset \{id: \$id\}\)/);
    expect(CYPHER.ADD_TAG).toMatch(/MERGE \(t:Tag \{name: \$tag\}\)/);
    expect(CYPHER.ADD_TAG).toMatch(/MERGE \(a\)-\[:TAGGED_AS\]->\(t\)/);
  });

  it('REMOVE_TAG deletes only the edge (leaves :Tag node intact)', () => {
    expect(CYPHER.REMOVE_TAG).toMatch(
      /MATCH \(a:Asset \{id: \$id\}\)-\[r:TAGGED_AS\]->\(t:Tag \{name: \$tag\}\)/
    );
    expect(CYPHER.REMOVE_TAG).toMatch(/DELETE r/);
    // Does NOT delete the tag node — that would orphan tags shared
    // with other assets.
    expect(CYPHER.REMOVE_TAG).not.toMatch(/DELETE t/);
  });
});

describe('SdkSpacesClient.updateItem', () => {
  it('rejects empty id with SPACES_INVALID_INPUT', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    await expect(client.updateItem('', { title: 'New' })).rejects.toMatchObject({
      code: 'SPACES_INVALID_INPUT',
    });
  });

  it('rejects an empty title (trim catches whitespace-only)', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    await expect(client.updateItem('i-1', { title: '   ' })).rejects.toMatchObject({
      code: 'SPACES_INVALID_INPUT',
    });
  });

  it('rejects title longer than MAX_ITEM_TITLE_LENGTH (200)', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    await expect(
      client.updateItem('i-1', { title: 'x'.repeat(201) })
    ).rejects.toMatchObject({ code: 'SPACES_INVALID_INPUT' });
  });

  it('rejects description longer than MAX_ITEM_DESCRIPTION_LENGTH (4000)', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    await expect(
      client.updateItem('i-1', { description: 'x'.repeat(4001) })
    ).rejects.toMatchObject({ code: 'SPACES_INVALID_INPUT' });
  });

  it('rejects an unknown kind in patch.type', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    await expect(
      client.updateItem('i-1', { type: 'spreadsheet' as unknown as 'document' })
    ).rejects.toMatchObject({ code: 'SPACES_INVALID_INPUT' });
  });

  it('forwards trimmed fields to the Cypher params and re-fetches', async () => {
    const stub = buildStubQuery();
    stub.setResponse('UPDATE (?:.*)\\bMATCH \\(a:Asset \\{id: \\$id\\}\\)', []);
    stub.setResponse('MATCH (a:Asset {id: $id})\n    OPTIONAL MATCH', [
      {
        id: 'i-1',
        title: 'New title',
        kind: 'document',
        createdAt: '',
        updatedAt: '2026-01-01T00:00:00Z',
        otherSpaces: [],
        producedBy: null,
      },
    ]);
    const client = makeClient(stub);
    const result = await client.updateItem('i-1', {
      title: '  New title  ',
      description: '  ',
      type: 'document',
      editorId: '  p-1  ',
    });
    // Should re-fetch and return the new Item shape.
    expect(result.title).toBe('New title');
    // Inspect the params on the UPDATE_ITEM call (first call).
    const update = stub.calls.find((c) => c.cypher.includes('UPDATE')) ?? stub.calls[0];
    expect(update?.parameters).toMatchObject({
      id: 'i-1',
      title: 'New title',
      description: '',
      type: 'document',
      editorId: 'p-1',
    });
    expect(typeof update?.parameters?.['now']).toBe('string');
  });

  it('omits unchanged fields from params (collapses to null)', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a:Asset {id: $id})\n    OPTIONAL MATCH', [
      {
        id: 'i-2',
        title: 't',
        kind: 'text',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: null,
      },
    ]);
    const client = makeClient(stub);
    await client.updateItem('i-2', { title: 'Only the title' });
    const update = stub.calls.find((c) => c.cypher.includes('SET a.name = coalesce'));
    expect(update?.parameters).toMatchObject({
      id: 'i-2',
      title: 'Only the title',
      description: null,
      type: null,
      editorId: null,
    });
  });

  it('throws SPACES_NOT_FOUND when the item disappears between update and re-fetch', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a:Asset {id: $id})\n    OPTIONAL MATCH', []);
    const client = makeClient(stub);
    await expect(
      client.updateItem('vanished', { title: 'whatever' })
    ).rejects.toMatchObject({ code: 'SPACES_NOT_FOUND' });
  });
});

describe('SdkSpacesClient.addTag / removeTag', () => {
  it('addTag rejects empty / whitespace-only tags', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    await expect(client.addTag('i-1', '   ')).rejects.toMatchObject({
      code: 'SPACES_INVALID_INPUT',
    });
  });

  it('addTag rejects oversize tags (>60 chars)', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    await expect(client.addTag('i-1', 'x'.repeat(61))).rejects.toMatchObject({
      code: 'SPACES_INVALID_INPUT',
    });
  });

  it('addTag rejects empty id', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    await expect(client.addTag('', 'tag')).rejects.toMatchObject({
      code: 'SPACES_INVALID_INPUT',
    });
  });

  it('addTag trims the tag + re-fetches the updated tag list', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MERGE (t:Tag {name: $tag})', [{ id: 'i-1', tag: 'q3' }]);
    stub.setResponse('MATCH (a:Asset {id: $id})\n    OPTIONAL MATCH', [
      {
        id: 'i-1',
        title: 't',
        kind: 'text',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: null,
        tags: ['q3'],
      },
    ]);
    const client = makeClient(stub);
    const tags = await client.addTag('i-1', '  q3  ');
    expect(tags).toEqual(['q3']);
    const addCall = stub.calls.find((c) => c.cypher.includes('MERGE (t:Tag {name: $tag})'));
    expect(addCall?.parameters).toEqual({ id: 'i-1', tag: 'q3' });
  });

  it('removeTag rejects empty / oversize tags + empty id', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    await expect(client.removeTag('', 'x')).rejects.toMatchObject({
      code: 'SPACES_INVALID_INPUT',
    });
    await expect(client.removeTag('i-1', '')).rejects.toMatchObject({
      code: 'SPACES_INVALID_INPUT',
    });
    await expect(client.removeTag('i-1', 'x'.repeat(61))).rejects.toMatchObject({
      code: 'SPACES_INVALID_INPUT',
    });
  });

  it('removeTag forwards trimmed tag to Cypher', async () => {
    const stub = buildStubQuery();
    stub.setResponse(
      'MATCH (a:Asset {id: $id})-[r:TAGGED_AS]->(t:Tag {name: $tag})',
      []
    );
    stub.setResponse('MATCH (a:Asset {id: $id})\n    OPTIONAL MATCH', [
      {
        id: 'i-1',
        title: 't',
        kind: 'text',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: null,
        tags: [],
      },
    ]);
    const client = makeClient(stub);
    const tags = await client.removeTag('i-1', '  policy ');
    expect(tags).toEqual([]);
    const removeCall = stub.calls.find((c) => c.cypher.includes('-[r:TAGGED_AS]->'));
    expect(removeCall?.parameters).toEqual({ id: 'i-1', tag: 'policy' });
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
    // Soft-deleted Spaces don't count toward the data-room overview.
    expect(CYPHER.HOME_ENTITY_COUNTS_FALLBACK).toMatch(
      /MATCH \(s:Space\) WHERE s\.deletedAt IS NULL/
    );
  });

  it('HOME_RECENT_ITEMS uses :Asset label and ItemSummary projection', () => {
    expect(CYPHER.HOME_RECENT_ITEMS).toMatch(/MATCH \(a:Asset\)/);
    expect(CYPHER.HOME_RECENT_ITEMS).toMatch(/coalesce\(a\.name, a\.title, a\.id\) AS title/);
    expect(CYPHER.HOME_RECENT_ITEMS).toMatch(/LIMIT toInteger\(\$limit\)/);
    // The Space chip projection must skip deleted Spaces so a
    // recent-item card never claims a Space the user just deleted.
    expect(CYPHER.HOME_RECENT_ITEMS).toMatch(/WHERE s\.deletedAt IS NULL/);
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
    // Soft-deleted Spaces don't count toward "you can see N Spaces".
    expect(CYPHER.HOME_PERMISSION_SUMMARY).toMatch(/WHERE s\.deletedAt IS NULL/);
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

// ─── Mutation queries (Phase 3a) ─────────────────────────────────────────
//
// Cypher-source guards + behavior tests for create / rename / delete /
// undelete. The behavior tests use the same `buildStubQuery` harness as
// the read queries; they assert row mapping, parameter shape,
// disambiguation between NOT_FOUND and DUPLICATE_NAME / DELETE_NON_EMPTY,
// and the soft-vs-hard delete path split.

describe('CYPHER source strings — mutations (Phase 3a)', () => {
  it('CREATE_SPACE checks uniqueness via case-insensitive name predicate', () => {
    expect(CYPHER.CREATE_SPACE).toMatch(
      /OPTIONAL MATCH \(existing:Space\)\s+WHERE toLower\(coalesce\(existing\.name, ''\)\) = toLower\(\$name\)/
    );
    expect(CYPHER.CREATE_SPACE).toMatch(/WHERE existing IS NULL/);
    expect(CYPHER.CREATE_SPACE).toMatch(/CREATE \(s:Space \{/);
    expect(CYPHER.CREATE_SPACE).toMatch(/id: \$id/);
    expect(CYPHER.CREATE_SPACE).toMatch(/createdAt: \$now/);
    expect(CYPHER.CREATE_SPACE).toMatch(/updatedAt: \$now/);
    expect(CYPHER.CREATE_SPACE).toMatch(/RETURN s\.id AS id/);
  });

  it('RENAME_SPACE matches target by id, checks new-name collision separately', () => {
    expect(CYPHER.RENAME_SPACE).toMatch(/MATCH \(s:Space \{id: \$id\}\)/);
    expect(CYPHER.RENAME_SPACE).toMatch(/s\.deletedAt IS NULL/);
    expect(CYPHER.RENAME_SPACE).toMatch(/OPTIONAL MATCH \(other:Space\)/);
    expect(CYPHER.RENAME_SPACE).toMatch(/other\.id <> \$id/);
    expect(CYPHER.RENAME_SPACE).toMatch(/WHERE other IS NULL/);
    expect(CYPHER.RENAME_SPACE).toMatch(/SET s\.name = \$name,\s+s\.updatedAt = \$now/);
  });

  it('SPACE_EXISTS_BY_ID returns a count for disambiguation', () => {
    expect(CYPHER.SPACE_EXISTS_BY_ID).toMatch(/MATCH \(s:Space \{id: \$id\}\)/);
    expect(CYPHER.SPACE_EXISTS_BY_ID).toMatch(/RETURN count\(s\) AS count/);
  });

  it('SPACE_ITEM_COUNT measures BELONGS_TO assets for hard-delete pre-flight', () => {
    expect(CYPHER.SPACE_ITEM_COUNT).toMatch(/MATCH \(s:Space \{id: \$id\}\)/);
    expect(CYPHER.SPACE_ITEM_COUNT).toMatch(
      /OPTIONAL MATCH \(a:Asset\)-\[:BELONGS_TO\]->\(s\)/
    );
    expect(CYPHER.SPACE_ITEM_COUNT).toMatch(/RETURN count\(a\) AS count/);
  });

  it('SOFT_DELETE_SPACE sets deletedAt + updatedAt, skips already-deleted', () => {
    expect(CYPHER.SOFT_DELETE_SPACE).toMatch(/MATCH \(s:Space \{id: \$id\}\)/);
    expect(CYPHER.SOFT_DELETE_SPACE).toMatch(/WHERE s\.deletedAt IS NULL/);
    expect(CYPHER.SOFT_DELETE_SPACE).toMatch(/SET s\.deletedAt = \$now/);
    expect(CYPHER.SOFT_DELETE_SPACE).toMatch(/s\.updatedAt = \$now/);
  });

  it('HARD_DELETE_SPACE uses plain DELETE (no DETACH) for orphan-safety', () => {
    expect(CYPHER.HARD_DELETE_SPACE).toMatch(/MATCH \(s:Space \{id: \$id\}\)/);
    expect(CYPHER.HARD_DELETE_SPACE).toMatch(/DELETE s/);
    // DETACH DELETE would silently nuke :BELONGS_TO edges -- we
    // deliberately use plain DELETE so a constraint error surfaces
    // any orphaned edge instead of swallowing the data loss.
    expect(CYPHER.HARD_DELETE_SPACE).not.toMatch(/DETACH DELETE/);
  });

  it('UNDELETE_SPACE clears deletedAt and projects itemCount alongside the row', () => {
    expect(CYPHER.UNDELETE_SPACE).toMatch(/MATCH \(s:Space \{id: \$id\}\)/);
    expect(CYPHER.UNDELETE_SPACE).toMatch(/WHERE s\.deletedAt IS NOT NULL/);
    expect(CYPHER.UNDELETE_SPACE).toMatch(/SET s\.deletedAt = null/);
    expect(CYPHER.UNDELETE_SPACE).toMatch(/RETURN s\.id AS id/);
    expect(CYPHER.UNDELETE_SPACE).toMatch(/itemCount AS itemCount/);
  });
});

describe('SdkSpacesClient.createSpace', () => {
  it('returns the persisted Space on success', async () => {
    const stub = buildStubQuery();
    stub.setResponse('CREATE (s:Space', [
      {
        id: 'space-uuid-123',
        name: 'New Space',
        description: '',
        color: '',
        iconKey: '',
        itemCount: 0,
        createdAt: '2026-01-15T10:00:00Z',
        updatedAt: '2026-01-15T10:00:00Z',
      },
    ]);
    const client = makeClient(stub);
    const result = await client.createSpace({ name: 'New Space' });
    expect(result).toEqual({
      id: 'space-uuid-123',
      name: 'New Space',
      itemCount: 0,
      createdAt: '2026-01-15T10:00:00Z',
      updatedAt: '2026-01-15T10:00:00Z',
    });
  });

  it('passes the name, generated id, and an ISO timestamp to the query', async () => {
    const stub = buildStubQuery();
    stub.setResponse('CREATE (s:Space', [
      {
        id: 'auto-id',
        name: 'Audit',
        description: '',
        color: '',
        iconKey: '',
        itemCount: 0,
        createdAt: '',
        updatedAt: '',
      },
    ]);
    const client = makeClient(stub);
    await client.createSpace({ name: 'Audit' });
    const createCall = stub.calls.find((c) => c.cypher.includes('CREATE (s:Space'));
    expect(createCall?.parameters).toMatchObject({ name: 'Audit' });
    expect(typeof createCall?.parameters?.['id']).toBe('string');
    expect((createCall?.parameters?.['id'] as string).length).toBeGreaterThan(0);
    const now = createCall?.parameters?.['now'];
    expect(typeof now).toBe('string');
    // Must look like an ISO 8601 timestamp.
    expect(now as string).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('throws SPACES_DUPLICATE_NAME when the create returns no rows', async () => {
    const stub = buildStubQuery();
    stub.setResponse('CREATE (s:Space', []);
    const client = makeClient(stub);
    await expect(client.createSpace({ name: 'Audit' })).rejects.toMatchObject({
      code: 'SPACES_DUPLICATE_NAME',
    });
  });

  it('rejects empty name with SPACES_INVALID_INPUT (client-side)', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    await expect(client.createSpace({ name: '   ' })).rejects.toMatchObject({
      code: 'SPACES_INVALID_INPUT',
    });
    // Should not even hit the wire.
    expect(stub.calls.length).toBe(0);
  });

  it('rejects too-long names with SPACES_INVALID_INPUT', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    const longName = 'a'.repeat(200);
    await expect(client.createSpace({ name: longName })).rejects.toMatchObject({
      code: 'SPACES_INVALID_INPUT',
    });
    expect(stub.calls.length).toBe(0);
  });

  it('trims whitespace on the name before sending', async () => {
    const stub = buildStubQuery();
    stub.setResponse('CREATE (s:Space', [
      { id: 'x', name: 'Audit', description: '', color: '', iconKey: '', itemCount: 0, createdAt: '', updatedAt: '' },
    ]);
    const client = makeClient(stub);
    await client.createSpace({ name: '  Audit  ' });
    const createCall = stub.calls.find((c) => c.cypher.includes('CREATE (s:Space'));
    expect(createCall?.parameters?.['name']).toBe('Audit');
  });
});

describe('SdkSpacesClient.renameSpace', () => {
  it('returns the updated Space on success', async () => {
    const stub = buildStubQuery();
    stub.setResponse('SET s.name', [
      {
        id: 'sp-1',
        name: 'Updated',
        description: '',
        color: '',
        iconKey: '',
        createdAt: '',
        updatedAt: '2026-02-01T00:00:00Z',
      },
    ]);
    const client = makeClient(stub);
    const result = await client.renameSpace('sp-1', 'Updated');
    expect(result).toMatchObject({ id: 'sp-1', name: 'Updated' });
  });

  it('throws SPACES_NOT_FOUND when the rename returns 0 rows and the id is gone', async () => {
    const stub = buildStubQuery();
    stub.setResponse('SET s.name', []);
    // Existence probe returns count=0 -> the space is missing.
    stub.setResponse('RETURN count(s) AS count', [{ count: 0 }]);
    const client = makeClient(stub);
    await expect(client.renameSpace('sp-x', 'New')).rejects.toMatchObject({
      code: 'SPACES_NOT_FOUND',
    });
  });

  it('throws SPACES_DUPLICATE_NAME when the rename returns 0 rows but the id exists', async () => {
    const stub = buildStubQuery();
    stub.setResponse('SET s.name', []);
    stub.setResponse('RETURN count(s) AS count', [{ count: 1 }]);
    const client = makeClient(stub);
    await expect(client.renameSpace('sp-1', 'Collision')).rejects.toMatchObject({
      code: 'SPACES_DUPLICATE_NAME',
    });
  });

  it('rejects empty id with SPACES_INVALID_INPUT (client-side)', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    await expect(client.renameSpace('', 'name')).rejects.toMatchObject({
      code: 'SPACES_INVALID_INPUT',
    });
    expect(stub.calls.length).toBe(0);
  });
});

describe('SdkSpacesClient.deleteSpace', () => {
  it('soft delete (default) sets deletedAt without checking item count', async () => {
    const stub = buildStubQuery();
    stub.setResponse('SET s.deletedAt = $now', [{ id: 'sp-1' }]);
    const client = makeClient(stub);
    await client.deleteSpace('sp-1');
    // Must NOT have run the SPACE_ITEM_COUNT pre-flight for soft delete.
    expect(stub.calls.find((c) => c.cypher.includes('count(a) AS count'))).toBeUndefined();
  });

  it('soft delete is idempotent when the space is already soft-deleted', async () => {
    const stub = buildStubQuery();
    // SOFT_DELETE_SPACE returns 0 rows (already deleted).
    stub.setResponse('SET s.deletedAt = $now', []);
    // But the existence probe says the space exists.
    stub.setResponse('RETURN count(s) AS count', [{ count: 1 }]);
    const client = makeClient(stub);
    // Should resolve without throwing.
    await expect(client.deleteSpace('sp-1')).resolves.toBeUndefined();
  });

  it('soft delete throws SPACES_NOT_FOUND when the space never existed', async () => {
    const stub = buildStubQuery();
    stub.setResponse('SET s.deletedAt = $now', []);
    stub.setResponse('RETURN count(s) AS count', [{ count: 0 }]);
    const client = makeClient(stub);
    await expect(client.deleteSpace('missing')).rejects.toMatchObject({
      code: 'SPACES_NOT_FOUND',
    });
  });

  it('hard delete refuses with SPACES_DELETE_NON_EMPTY when items remain', async () => {
    const stub = buildStubQuery();
    stub.setResponse('OPTIONAL MATCH (a:Asset)-[:BELONGS_TO]->(s)', [{ count: 7 }]);
    const client = makeClient(stub);
    await expect(client.deleteSpace('sp-1', { soft: false })).rejects.toMatchObject({
      code: 'SPACES_DELETE_NON_EMPTY',
    });
    // Must NOT have run HARD_DELETE_SPACE.
    expect(stub.calls.find((c) => c.cypher.includes('DELETE s'))).toBeUndefined();
  });

  it('hard delete proceeds when item count is 0', async () => {
    const stub = buildStubQuery();
    stub.setResponse('OPTIONAL MATCH (a:Asset)-[:BELONGS_TO]->(s)', [{ count: 0 }]);
    stub.setResponse('DELETE s', []);
    const client = makeClient(stub);
    await client.deleteSpace('sp-1', { soft: false });
    expect(stub.calls.find((c) => c.cypher.includes('DELETE s'))).toBeDefined();
  });

  it('hard delete throws SPACES_NOT_FOUND when the space does not exist', async () => {
    const stub = buildStubQuery();
    // SPACE_ITEM_COUNT returns no rows because MATCH didn't bind.
    stub.setResponse('OPTIONAL MATCH (a:Asset)-[:BELONGS_TO]->(s)', []);
    const client = makeClient(stub);
    await expect(client.deleteSpace('missing', { soft: false })).rejects.toMatchObject({
      code: 'SPACES_NOT_FOUND',
    });
  });
});

describe('SdkSpacesClient.undeleteSpace', () => {
  it('returns the restored Space on success', async () => {
    const stub = buildStubQuery();
    stub.setResponse('SET s.deletedAt = null', [
      {
        id: 'sp-1',
        name: 'Restored',
        description: '',
        color: '',
        iconKey: '',
        itemCount: 4,
        createdAt: '',
        updatedAt: '',
      },
    ]);
    const client = makeClient(stub);
    const result = await client.undeleteSpace('sp-1');
    expect(result).toMatchObject({ id: 'sp-1', name: 'Restored', itemCount: 4 });
  });

  it('throws SPACES_NOT_FOUND when the space is hard-deleted', async () => {
    const stub = buildStubQuery();
    stub.setResponse('SET s.deletedAt = null', []);
    stub.setResponse('RETURN count(s) AS count', [{ count: 0 }]);
    const client = makeClient(stub);
    await expect(client.undeleteSpace('gone')).rejects.toMatchObject({
      code: 'SPACES_NOT_FOUND',
    });
  });
});

// ─── Phase 3c: per-asset activity log ───────────────────────────────────

describe('CYPHER source strings — Phase 3c (per-asset activity)', () => {
  it('ITEM_RECENT_COMMITS matches :Asset by id and tolerates multiple commit-to-asset shapes', () => {
    expect(CYPHER.ITEM_RECENT_COMMITS).toMatch(/MATCH \(a:Asset \{id: \$id\}\)/);
    // Match path: singular canonical, legacy alias, canonical array, edge model.
    expect(CYPHER.ITEM_RECENT_COMMITS).toMatch(/c\.assetId = \$id/);
    expect(CYPHER.ITEM_RECENT_COMMITS).toMatch(/c\.targetId = \$id/);
    expect(CYPHER.ITEM_RECENT_COMMITS).toMatch(/\$id IN coalesce\(c\.assetIds, \[\]\)/);
    expect(CYPHER.ITEM_RECENT_COMMITS).toMatch(/\(c\)-\[:TOUCHED\]->\(a\)/);
  });

  it('ITEM_RECENT_COMMITS honors $since cutoff and orders newest first', () => {
    expect(CYPHER.ITEM_RECENT_COMMITS).toMatch(/\$since IS NULL OR c\.timestamp >= \$since/);
    expect(CYPHER.ITEM_RECENT_COMMITS).toMatch(/ORDER BY c\.timestamp DESC/);
    expect(CYPHER.ITEM_RECENT_COMMITS).toMatch(/LIMIT toInteger\(\$limit\)/);
  });

  it('ITEM_RECENT_COMMITS row shape matches HOME_RECENT_EVENTS so the renderer can reuse it', () => {
    expect(CYPHER.ITEM_RECENT_COMMITS).toMatch(/c\.hash AS id/);
    expect(CYPHER.ITEM_RECENT_COMMITS).toMatch(/c\.author AS author/);
    expect(CYPHER.ITEM_RECENT_COMMITS).toMatch(/c\.message AS kind/);
    expect(CYPHER.ITEM_RECENT_COMMITS).toMatch(/toString\(c\.timestamp\) AS timestamp/);
    expect(CYPHER.ITEM_RECENT_COMMITS).toMatch(
      /coalesce\(s\.name, c\.spaceId\) AS spaceName/
    );
  });

  it('ITEM_RECENT_COMMITS resolves spaceName via OPTIONAL MATCH on :IN_SPACE', () => {
    expect(CYPHER.ITEM_RECENT_COMMITS).toMatch(
      /OPTIONAL MATCH \(c\)-\[:IN_SPACE\]->\(s:Space\)/
    );
  });
});

describe('SdkSpacesClient.itemRecentCommits', () => {
  it('rejects empty id', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    await expect(client.itemRecentCommits('')).rejects.toMatchObject({
      code: 'SPACES_INVALID_INPUT',
    });
  });

  it('defaults limit to 20 and leaves since as null', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a:Asset {id: $id})', []);
    const client = makeClient(stub);
    await client.itemRecentCommits('asset-1');
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toEqual({ id: 'asset-1', limit: 20, since: null });
  });

  it('caps limit at 100', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a:Asset {id: $id})', []);
    const client = makeClient(stub);
    await client.itemRecentCommits('asset-1', { limit: 9999 });
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toMatchObject({ limit: 100 });
  });

  it('rejects zero / negative limit by falling back to default (20)', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a:Asset {id: $id})', []);
    const client = makeClient(stub);
    await client.itemRecentCommits('asset-1', { limit: -10 });
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toMatchObject({ limit: 20 });
  });

  it('forwards a numeric since cutoff', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a:Asset {id: $id})', []);
    const client = makeClient(stub);
    await client.itemRecentCommits('asset-1', { since: 1_700_000_000_000 });
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toMatchObject({ since: 1_700_000_000_000 });
  });

  it('treats negative / NaN since as null (defensive)', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a:Asset {id: $id})', []);
    const client = makeClient(stub);
    await client.itemRecentCommits('asset-1', { since: -1 });
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toMatchObject({ since: null });
  });

  it('maps rows into Event[] with spaceId/spaceName when present', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a:Asset {id: $id})', [
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
    const events = await client.itemRecentCommits('asset-1');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      id: 'h1',
      author: 'Audit Agent',
      kind: 'item:added',
      spaceId: 'sp-1',
      spaceName: 'Engineering',
    });
    expect(events[1]).not.toHaveProperty('spaceName');
    expect(events[1]).not.toHaveProperty('spaceId');
  });

  it('returns [] when the asset has no commits (OPTIONAL MATCH absorbs not-found)', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a:Asset {id: $id})', []);
    const client = makeClient(stub);
    const events = await client.itemRecentCommits('ghost-asset');
    expect(events).toEqual([]);
  });
});

// ─── Phase 4: shared spaces (playbooks + tickets) ───────────────────────

describe('CYPHER source strings — Phase 4 (shared spaces)', () => {
  it('LIST_SPACES projects coalesce(s.kind, "user") AS kind', () => {
    expect(CYPHER.LIST_SPACES).toMatch(/coalesce\(s\.kind, 'user'\) AS kind/);
  });

  it('GET_ITEM projects ticket fields with status default and assignee object', () => {
    expect(CYPHER.GET_ITEM).toMatch(/coalesce\(a\.status, 'open'\) AS ticketStatus/);
    expect(CYPHER.GET_ITEM).toMatch(/a\.priority AS ticketPriority/);
    expect(CYPHER.GET_ITEM).toMatch(
      /coalesce\(sourcePlaybook\.id, a\.playbookId\) AS ticketPlaybookId/
    );
    expect(CYPHER.GET_ITEM).toMatch(/AS ticketAssignee/);
    expect(CYPHER.GET_ITEM).toMatch(
      /OPTIONAL MATCH \(a\)-\[:ASSIGNED_TO\]->\(assignee\)/
    );
    expect(CYPHER.GET_ITEM).toMatch(
      /OPTIONAL MATCH \(a\)-\[:DECOMPOSED_FROM\]->\(pb:Asset\)/
    );
  });

  it('SET_SPACE_KIND filters out soft-deleted spaces and stamps updatedAt', () => {
    expect(CYPHER.SET_SPACE_KIND).toMatch(/MATCH \(s:Space \{id: \$id\}\)/);
    expect(CYPHER.SET_SPACE_KIND).toMatch(/WHERE s\.deletedAt IS NULL/);
    expect(CYPHER.SET_SPACE_KIND).toMatch(/SET s\.kind = \$kind/);
    expect(CYPHER.SET_SPACE_KIND).toMatch(/s\.updatedAt = \$now/);
  });

  it('GET_CURRENT_PLAYBOOK resolves canonical edge then legacy property', () => {
    expect(CYPHER.GET_CURRENT_PLAYBOOK).toMatch(
      /OPTIONAL MATCH \(s\)-\[:CURRENT_PLAYBOOK\]->\(canonical:Asset\)/
    );
    expect(CYPHER.GET_CURRENT_PLAYBOOK).toMatch(
      /OPTIONAL MATCH \(legacy:Asset \{id: s\.currentPlaybookId\}\)/
    );
    expect(CYPHER.GET_CURRENT_PLAYBOOK).toMatch(/coalesce\(canonical, legacy\)/);
  });

  it('SET_CURRENT_PLAYBOOK drops the prior edge, MERGEs the new one, and stamps type', () => {
    expect(CYPHER.SET_CURRENT_PLAYBOOK).toMatch(
      /OPTIONAL MATCH \(s\)-\[old:CURRENT_PLAYBOOK\]->\(:Asset\)/
    );
    expect(CYPHER.SET_CURRENT_PLAYBOOK).toMatch(/DELETE old/);
    expect(CYPHER.SET_CURRENT_PLAYBOOK).toMatch(/MERGE \(s\)-\[:CURRENT_PLAYBOOK\]->\(pb\)/);
    expect(CYPHER.SET_CURRENT_PLAYBOOK).toMatch(/SET pb\.type = 'playbook'/);
    expect(CYPHER.SET_CURRENT_PLAYBOOK).toMatch(/count\(t\) AS ticketCount/);
  });

  it('LIST_TICKETS_IN_SPACE matches by belongs-to + ticket type with status filter', () => {
    expect(CYPHER.LIST_TICKETS_IN_SPACE).toMatch(
      /MATCH \(a:Asset\)-\[:BELONGS_TO\]->\(s:Space \{id: \$spaceId\}\)/
    );
    expect(CYPHER.LIST_TICKETS_IN_SPACE).toMatch(/coalesce\(a\.type, a\.assetType\) = 'ticket'/);
    expect(CYPHER.LIST_TICKETS_IN_SPACE).toMatch(/\$status IS NULL OR/);
    expect(CYPHER.LIST_TICKETS_IN_SPACE).toMatch(/coalesce\(a\.status, 'open'\) = \$status/);
  });

  it('LIST_TICKETS_IN_SPACE orders open tickets first', () => {
    expect(CYPHER.LIST_TICKETS_IN_SPACE).toMatch(
      /WHEN 'open' THEN 0[\s\S]+WHEN 'in_progress' THEN 1[\s\S]+WHEN 'blocked' THEN 2[\s\S]+WHEN 'done' THEN 3/
    );
  });

  it('CREATE_TICKET CREATEs Asset, merges BELONGS_TO + optional DECOMPOSED_FROM + ASSIGNED_TO', () => {
    expect(CYPHER.CREATE_TICKET).toMatch(/CREATE \(a:Asset \{/);
    expect(CYPHER.CREATE_TICKET).toMatch(/type: 'ticket'/);
    expect(CYPHER.CREATE_TICKET).toMatch(/MERGE \(a\)-\[:BELONGS_TO\]->\(s\)/);
    expect(CYPHER.CREATE_TICKET).toMatch(/MERGE \(a\)-\[:DECOMPOSED_FROM\]->\(x\)/);
    expect(CYPHER.CREATE_TICKET).toMatch(/MERGE \(a\)-\[:ASSIGNED_TO\]->\(x\)/);
  });

  it('UPDATE_TICKET only updates :Asset rows where type === ticket', () => {
    expect(CYPHER.UPDATE_TICKET).toMatch(/coalesce\(a\.type, a\.assetType\) = 'ticket'/);
    expect(CYPHER.UPDATE_TICKET).toMatch(/SET a\.name = coalesce\(\$title, a\.name\)/);
    expect(CYPHER.UPDATE_TICKET).toMatch(/a\.status = coalesce\(\$status, a\.status\)/);
    expect(CYPHER.UPDATE_TICKET).toMatch(/a\.priority = coalesce\(\$priority, a\.priority\)/);
    // Assignee re-merge: drop the prior edge first.
    expect(CYPHER.UPDATE_TICKET).toMatch(/OPTIONAL MATCH \(a\)-\[r:ASSIGNED_TO\]->\(\)/);
    expect(CYPHER.UPDATE_TICKET).toMatch(/DELETE r/);
  });
});

describe('SdkSpacesClient.setSpaceKind', () => {
  it('rejects unknown kinds', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    await expect(
      client.setSpaceKind('sp-1', 'bogus' as unknown as 'user')
    ).rejects.toMatchObject({ code: 'SPACES_INVALID_INPUT' });
  });

  it('throws SPACES_NOT_FOUND when the Space is missing', async () => {
    const stub = buildStubQuery();
    stub.setResponse('SET s.kind = $kind', []);
    const client = makeClient(stub);
    await expect(client.setSpaceKind('sp-gone', 'shared')).rejects.toMatchObject({
      code: 'SPACES_NOT_FOUND',
    });
  });

  it('returns the new kind on success', async () => {
    const stub = buildStubQuery();
    stub.setResponse('SET s.kind = $kind', [{ id: 'sp-1', kind: 'shared' }]);
    const client = makeClient(stub);
    const next = await client.setSpaceKind('sp-1', 'shared');
    expect(next).toBe('shared');
  });
});

describe('SdkSpacesClient.getCurrentPlaybook', () => {
  it('returns null when no playbook is set', async () => {
    const stub = buildStubQuery();
    stub.setResponse('OPTIONAL MATCH (s)-[:CURRENT_PLAYBOOK]', []);
    const client = makeClient(stub);
    const pb = await client.getCurrentPlaybook('sp-1');
    expect(pb).toBeNull();
  });

  it('re-fetches the playbook via getItem when one is set', async () => {
    const stub = buildStubQuery();
    stub.setResponse('OPTIONAL MATCH (s)-[:CURRENT_PLAYBOOK]', [{ playbookId: 'pb-1' }]);
    stub.setResponse('MATCH (a:Asset {id: $id})\n    OPTIONAL MATCH', [
      {
        id: 'pb-1',
        title: 'Q1 plan',
        kind: 'playbook',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: null,
        tags: [],
      },
    ]);
    const client = makeClient(stub);
    const pb = await client.getCurrentPlaybook('sp-1');
    expect(pb).not.toBeNull();
    expect(pb?.id).toBe('pb-1');
    expect(pb?.kind).toBe('playbook');
  });
});

describe('SdkSpacesClient.setCurrentPlaybook', () => {
  it('rejects empty playbookId', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    await expect(client.setCurrentPlaybook('sp-1', '')).rejects.toMatchObject({
      code: 'SPACES_INVALID_INPUT',
    });
  });

  it('returns the freshly-fetched playbook plus ticketCount', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MERGE (s)-[:CURRENT_PLAYBOOK]', [
      { playbookId: 'pb-1', ticketCount: 4 },
    ]);
    stub.setResponse('MATCH (a:Asset {id: $id})\n    OPTIONAL MATCH', [
      {
        id: 'pb-1',
        title: 'Q1 plan',
        kind: 'playbook',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: null,
        tags: [],
      },
    ]);
    const client = makeClient(stub);
    const result = await client.setCurrentPlaybook('sp-1', 'pb-1');
    expect(result.ticketCount).toBe(4);
    expect(result.playbook.id).toBe('pb-1');
  });
});

describe('SdkSpacesClient.listTickets', () => {
  it('defaults to limit 200, status null, offset 0', async () => {
    const stub = buildStubQuery();
    stub.setResponse('coalesce(a.type, a.assetType) = \'ticket\'', []);
    const client = makeClient(stub);
    await client.listTickets('sp-1');
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toEqual({
      spaceId: 'sp-1',
      status: null,
      limit: 200,
      offset: 0,
    });
  });

  it('passes a valid status filter through', async () => {
    const stub = buildStubQuery();
    stub.setResponse('coalesce(a.type, a.assetType) = \'ticket\'', []);
    const client = makeClient(stub);
    await client.listTickets('sp-1', { status: 'open' });
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toMatchObject({ status: 'open' });
  });

  it('rejects unknown status', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    await expect(
      client.listTickets('sp-1', { status: 'bogus' as unknown as 'open' })
    ).rejects.toMatchObject({ code: 'SPACES_INVALID_INPUT' });
  });

  it('maps rows into ticket-shaped Items', async () => {
    const stub = buildStubQuery();
    stub.setResponse('coalesce(a.type, a.assetType) = \'ticket\'', [
      {
        id: 't-1',
        title: 'Write tests',
        excerpt: 'Cover the SDK paths',
        createdAt: '',
        updatedAt: '',
        status: 'in_progress',
        priority: 'high',
        playbookId: 'pb-1',
        assignee: { kind: 'Person', name: 'Alice', id: 'p-1' },
      },
      {
        id: 't-2',
        title: 'Done one',
        createdAt: '',
        updatedAt: '',
        status: 'done',
        playbookId: null,
        assignee: null,
      },
    ]);
    const client = makeClient(stub);
    const rows = await client.listTickets('sp-1');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.kind).toBe('ticket');
    expect(rows[0]?.ticket).toMatchObject({
      status: 'in_progress',
      priority: 'high',
      playbookId: 'pb-1',
    });
    expect(rows[0]?.ticket?.assignee?.name).toBe('Alice');
    expect(rows[1]?.ticket?.status).toBe('done');
    expect(rows[1]?.ticket?.assignee).toBeNull();
  });
});

describe('SdkSpacesClient.createTicket', () => {
  it('rejects empty title', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    await expect(client.createTicket('sp-1', { title: '   ' })).rejects.toMatchObject({
      code: 'SPACES_INVALID_INPUT',
    });
  });

  it('rejects unknown status', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    await expect(
      client.createTicket('sp-1', {
        title: 'x',
        status: 'wat' as unknown as 'open',
      })
    ).rejects.toMatchObject({ code: 'SPACES_INVALID_INPUT' });
  });

  it('defaults status to open, generates an id, returns the re-fetched Item', async () => {
    const stub = buildStubQuery();
    stub.setResponse('CREATE (a:Asset', [{ id: 'ticket-stub' }]);
    stub.setResponse('MATCH (a:Asset {id: $id})\n    OPTIONAL MATCH', [
      {
        id: 'ticket-stub',
        title: 'Write tests',
        kind: 'ticket',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: null,
        tags: [],
        ticketStatus: 'open',
        ticketAssignee: null,
      },
    ]);
    const client = makeClient(stub);
    const created = await client.createTicket('sp-1', { title: 'Write tests' });
    expect(created.kind).toBe('ticket');
    expect(created.ticket?.status).toBe('open');
    // Verify the CREATE parameters carried the trimmed title and defaulted status.
    const createCall = stub.calls.find((c) => c.cypher.includes('CREATE (a:Asset'));
    expect(createCall?.parameters).toMatchObject({
      spaceId: 'sp-1',
      title: 'Write tests',
      status: 'open',
    });
  });

  it('throws SPACES_NOT_FOUND when the Space is missing', async () => {
    const stub = buildStubQuery();
    stub.setResponse('CREATE (a:Asset', []);
    const client = makeClient(stub);
    await expect(
      client.createTicket('sp-gone', { title: 'x' })
    ).rejects.toMatchObject({ code: 'SPACES_NOT_FOUND' });
  });
});

describe('SdkSpacesClient.updateTicket', () => {
  it('rejects empty id', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    await expect(client.updateTicket('', {})).rejects.toMatchObject({
      code: 'SPACES_INVALID_INPUT',
    });
  });

  it('rejects unknown status / priority', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    await expect(
      client.updateTicket('t-1', { status: 'nope' as unknown as 'open' })
    ).rejects.toMatchObject({ code: 'SPACES_INVALID_INPUT' });
    await expect(
      client.updateTicket('t-1', { priority: 'sky' as unknown as 'low' })
    ).rejects.toMatchObject({ code: 'SPACES_INVALID_INPUT' });
  });

  it('forwards null assigneeId to clear the assignment', async () => {
    const stub = buildStubQuery();
    stub.setResponse(
      "WHERE coalesce(a.type, a.assetType) = 'ticket'",
      [{ id: 't-1' }]
    );
    stub.setResponse('MATCH (a:Asset {id: $id})\n    OPTIONAL MATCH', [
      {
        id: 't-1',
        title: 't',
        kind: 'ticket',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: null,
        tags: [],
        ticketStatus: 'open',
        ticketAssignee: null,
      },
    ]);
    const client = makeClient(stub);
    await client.updateTicket('t-1', { assigneeId: null });
    const call = stub.calls.find((c) => c.cypher.includes('UPDATE_TICKET') ||
      c.cypher.includes('coalesce($status, a.status)'));
    expect(call?.parameters).toMatchObject({ assigneeId: null });
  });

  it('throws SPACES_NOT_FOUND when the ticket is missing', async () => {
    const stub = buildStubQuery();
    stub.setResponse("WHERE coalesce(a.type, a.assetType) = 'ticket'", []);
    const client = makeClient(stub);
    await expect(
      client.updateTicket('t-gone', { status: 'done' })
    ).rejects.toMatchObject({ code: 'SPACES_NOT_FOUND' });
  });

  it('returns the freshly re-fetched ticket Item with status updated', async () => {
    const stub = buildStubQuery();
    stub.setResponse(
      "WHERE coalesce(a.type, a.assetType) = 'ticket'",
      [{ id: 't-1' }]
    );
    stub.setResponse('MATCH (a:Asset {id: $id})\n    OPTIONAL MATCH', [
      {
        id: 't-1',
        title: 'ticket',
        kind: 'ticket',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: null,
        tags: [],
        ticketStatus: 'done',
        ticketAssignee: null,
      },
    ]);
    const client = makeClient(stub);
    const updated = await client.updateTicket('t-1', { status: 'done' });
    expect(updated.ticket?.status).toBe('done');
  });
});

describe('toItem ticket projection', () => {
  it('toSpace surfaces s.kind from the projection', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (s:Space)', [
      {
        id: 'sp-1',
        name: 'Engineering',
        description: '',
        color: '',
        iconKey: '',
        kind: 'shared',
        itemCount: 0,
        createdAt: '',
        updatedAt: '',
      },
      {
        id: 'sp-2',
        name: 'Misc',
        description: '',
        color: '',
        iconKey: '',
        kind: 'user',
        itemCount: 0,
        createdAt: '',
        updatedAt: '',
      },
    ]);
    const client = makeClient(stub);
    const spaces = await client.listSpaces();
    expect(spaces[0]?.kind).toBe('shared');
    expect(spaces[1]?.kind).toBe('user');
  });

  it('toItem skips ticket sub-shape for non-ticket items', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a:Asset {id: $id})\n    OPTIONAL MATCH', [
      {
        id: 'doc-1',
        title: 'Whitepaper',
        kind: 'document',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: null,
        tags: [],
        // These ARE present in the row (the projection always returns them)
        // but `toItem` only assembles `item.ticket` when kind === 'ticket'.
        ticketStatus: 'open',
        ticketAssignee: null,
      },
    ]);
    const client = makeClient(stub);
    const item = await client.getItem('doc-1');
    expect(item?.ticket).toBeUndefined();
  });

  it('toItem assembles ticket sub-shape with status default + assignee + playbookId', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a:Asset {id: $id})\n    OPTIONAL MATCH', [
      {
        id: 't-1',
        title: 'Write tests',
        kind: 'ticket',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: null,
        tags: [],
        ticketStatus: 'in_progress',
        ticketPriority: 'high',
        ticketPlaybookId: 'pb-1',
        ticketAssignee: { kind: 'Agent', name: 'Audit Agent', id: 'ag-1' },
      },
    ]);
    const client = makeClient(stub);
    const item = await client.getItem('t-1');
    expect(item?.kind).toBe('ticket');
    expect(item?.ticket).toEqual({
      status: 'in_progress',
      priority: 'high',
      playbookId: 'pb-1',
      assignee: { kind: 'Agent', name: 'Audit Agent', id: 'ag-1' },
    });
  });
});

// ─── Phase 4 v2: identity + sharing ─────────────────────────────────────

describe('CYPHER source strings — Phase 4 v2 (identity + sharing)', () => {
  it('MERGE_PERSON upserts by id with ON CREATE / ON MATCH branches', () => {
    expect(CYPHER.MERGE_PERSON).toMatch(/MERGE \(p:Person \{id: \$id\}\)/);
    expect(CYPHER.MERGE_PERSON).toMatch(/ON CREATE SET p\.name = \$name/);
    expect(CYPHER.MERGE_PERSON).toMatch(
      /ON MATCH SET p\.name = coalesce\(p\.name, \$name\)/
    );
    expect(CYPHER.MERGE_PERSON).toMatch(/coalesce\(p\.email, \$email\)/);
  });

  it('LIST_SPACE_MEMBERS matches Person OR Agent via HAS_ACCESS', () => {
    expect(CYPHER.LIST_SPACE_MEMBERS).toMatch(/MATCH \(s:Space \{id: \$spaceId\}\)/);
    expect(CYPHER.LIST_SPACE_MEMBERS).toMatch(
      /OPTIONAL MATCH \(member\)-\[:HAS_ACCESS\]->\(s\)/
    );
    expect(CYPHER.LIST_SPACE_MEMBERS).toMatch(/member:Person OR member:Agent/);
  });

  it('ADD_SPACE_MEMBER MERGEs HAS_ACCESS idempotently', () => {
    expect(CYPHER.ADD_SPACE_MEMBER).toMatch(/MERGE \(member\)-\[:HAS_ACCESS\]->\(s\)/);
    expect(CYPHER.ADD_SPACE_MEMBER).toMatch(/member:Person OR member:Agent/);
  });

  it('REMOVE_SPACE_MEMBER deletes the HAS_ACCESS edge', () => {
    expect(CYPHER.REMOVE_SPACE_MEMBER).toMatch(
      /MATCH \(member \{id: \$memberId\}\)-\[r:HAS_ACCESS\]->\(s:Space \{id: \$spaceId\}\)/
    );
    expect(CYPHER.REMOVE_SPACE_MEMBER).toMatch(/DELETE r/);
  });
});

describe('SdkSpacesClient.getOrCreatePerson', () => {
  it('rejects empty id', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    await expect(client.getOrCreatePerson({ id: '' })).rejects.toMatchObject({
      code: 'SPACES_INVALID_INPUT',
    });
  });

  it('trims inputs and forwards name + email + ISO now', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MERGE (p:Person {id: $id})', [
      { id: 'alice@onereach.ai', name: 'Alice', email: 'alice@onereach.ai' },
    ]);
    const client = makeClient(stub);
    const p = await client.getOrCreatePerson({
      id: '  alice@onereach.ai  ',
      name: '  Alice  ',
      email: '  alice@onereach.ai  ',
    });
    expect(p).toEqual({
      id: 'alice@onereach.ai',
      name: 'Alice',
      email: 'alice@onereach.ai',
    });
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toMatchObject({
      id: 'alice@onereach.ai',
      name: 'Alice',
      email: 'alice@onereach.ai',
    });
  });

  it('returns the user-supplied id if the MERGE returns no rows', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MERGE (p:Person {id: $id})', []);
    const client = makeClient(stub);
    const p = await client.getOrCreatePerson({ id: 'alice', name: 'Alice' });
    expect(p.id).toBe('alice');
    expect(p.name).toBe('Alice');
  });
});

describe('SdkSpacesClient.listSpaceMembers', () => {
  it('returns [] when no members', async () => {
    const stub = buildStubQuery();
    stub.setResponse('OPTIONAL MATCH (member)-[:HAS_ACCESS]', []);
    const client = makeClient(stub);
    const members = await client.listSpaceMembers('sp-1');
    expect(members).toEqual([]);
  });

  it('maps rows into SpaceMember objects with default kind/name', async () => {
    const stub = buildStubQuery();
    stub.setResponse('OPTIONAL MATCH (member)-[:HAS_ACCESS]', [
      { kind: 'Person', id: 'alice', name: 'Alice' },
      { kind: 'Agent', id: 'audit', name: 'Audit Agent' },
      { kind: 'Person', id: 'bob', name: '' },
    ]);
    const client = makeClient(stub);
    const members = await client.listSpaceMembers('sp-1');
    expect(members).toHaveLength(3);
    expect(members[0]).toEqual({ kind: 'Person', id: 'alice', name: 'Alice' });
    expect(members[2]).toEqual({ kind: 'Person', id: 'bob', name: '' });
  });

  it('skips rows with missing/empty id (defensive)', async () => {
    const stub = buildStubQuery();
    stub.setResponse('OPTIONAL MATCH (member)-[:HAS_ACCESS]', [
      { kind: 'Person', id: '', name: 'No Id' },
      { kind: 'Person', id: 'alice', name: 'Alice' },
    ]);
    const client = makeClient(stub);
    const members = await client.listSpaceMembers('sp-1');
    expect(members).toHaveLength(1);
    expect(members[0]?.id).toBe('alice');
  });
});

describe('SdkSpacesClient.addSpaceMember', () => {
  it('rejects empty memberId', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    await expect(client.addSpaceMember('sp-1', '')).rejects.toMatchObject({
      code: 'SPACES_INVALID_INPUT',
    });
  });

  it('throws SPACES_NOT_FOUND when MERGE returns no rows', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MERGE (member)-[:HAS_ACCESS]->(s)', []);
    const client = makeClient(stub);
    await expect(
      client.addSpaceMember('sp-1', 'alice')
    ).rejects.toMatchObject({ code: 'SPACES_NOT_FOUND' });
  });

  it('returns the canonical (kind, id, name) tuple', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MERGE (member)-[:HAS_ACCESS]->(s)', [
      { kind: 'Agent', id: 'audit', name: 'Audit Agent' },
    ]);
    const client = makeClient(stub);
    const member = await client.addSpaceMember('sp-1', 'audit');
    expect(member).toEqual({ kind: 'Agent', id: 'audit', name: 'Audit Agent' });
  });
});

describe('SdkSpacesClient.removeSpaceMember', () => {
  it('rejects empty memberId', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    await expect(client.removeSpaceMember('sp-1', '')).rejects.toMatchObject({
      code: 'SPACES_INVALID_INPUT',
    });
  });

  it('returns silently when the edge is absent (no-op semantics)', async () => {
    const stub = buildStubQuery();
    stub.setResponse('-[r:HAS_ACCESS]->(s:Space {id: $spaceId})', []);
    const client = makeClient(stub);
    await expect(client.removeSpaceMember('sp-1', 'alice')).resolves.toBeUndefined();
  });

  it('forwards spaceId + memberId as Cypher params', async () => {
    const stub = buildStubQuery();
    stub.setResponse('-[r:HAS_ACCESS]->(s:Space {id: $spaceId})', [
      { id: 'alice' },
    ]);
    const client = makeClient(stub);
    await client.removeSpaceMember('sp-1', 'alice');
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toEqual({ spaceId: 'sp-1', memberId: 'alice' });
  });
});
