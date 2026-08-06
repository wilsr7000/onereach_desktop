/**
 * ADR-051 — per-space visibility option.
 *
 * Two layers:
 *   1. Query-shape guards: every read surface that can leak a
 *      restricted Space (sidebar list, in-space items, direct get,
 *      search, home feed) carries the visibility predicate and binds
 *      `$viewerId`; UPDATE_SPACE can write visibility and auto-grants
 *      the flipper access.
 *   2. Client behavior against a stub queryFn: viewer normalization,
 *      param assembly, enum validation, row mapping.
 */

import { describe, it, expect } from 'vitest';
import {
  SdkSpacesClient,
  CYPHER,
  type SpacesQueryFn,
} from '../../spaces/sdk-client.js';
import { _coerceUpdateSpaceInputForTesting } from '../../spaces/ipc.js';

// ─── stub query ──────────────────────────────────────────────────────────

interface QueryCall {
  cypher: string;
  parameters: Record<string, unknown> | undefined;
}

function buildStub(rowsFor: (cypher: string) => Array<Record<string, unknown>>): {
  fn: SpacesQueryFn;
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  const fn: SpacesQueryFn = async (cypher, parameters) => {
    calls.push({ cypher, parameters });
    return rowsFor(cypher);
  };
  return { fn, calls };
}

const SPACE_ROW = {
  id: 's-1',
  name: 'Ops',
  description: '',
  color: '',
  iconKey: '',
  kind: 'user',
  visibility: 'restricted',
  itemCount: 0,
  createdAt: '',
  updatedAt: '',
};

// ─── 1. query-shape guards ───────────────────────────────────────────────

describe('visibility predicates in the Cypher surface', () => {
  const gatedSpaceQueries: Array<[string, string]> = [
    ['LIST_SPACES', CYPHER.LIST_SPACES],
    ['LIST_ITEMS_IN_SPACE', CYPHER.LIST_ITEMS_IN_SPACE],
  ];
  const gatedAssetQueries: Array<[string, string]> = [
    ['GET_ITEM', CYPHER.GET_ITEM],
    ['SEARCH_ITEMS', CYPHER.SEARCH_ITEMS],
    ['HOME_RECENT_ITEMS', CYPHER.HOME_RECENT_ITEMS],
  ];

  it.each(gatedSpaceQueries)('%s gates on the space visibility predicate', (_name, q) => {
    expect(q).toContain("coalesce(s.visibility, 'open') <> 'restricted'");
    expect(q).toContain('$viewerId');
    expect(q).toContain('[:HAS_ACCESS]->(s)');
  });

  it.each(gatedAssetQueries)('%s gates on the asset visibility rule', (_name, q) => {
    expect(q).toContain("coalesce(vs.visibility, 'open') <> 'restricted'");
    expect(q).toContain('$viewerId');
    expect(q).toContain('[:HAS_ACCESS]->(vs)');
    // Uncategorized assets stay visible.
    expect(q).toContain('NOT EXISTS { MATCH (a)-[:BELONGS_TO]->(:Space) }');
  });

  it('LIST_SPACES projects visibility so the renderer can badge + toggle', () => {
    expect(CYPHER.LIST_SPACES).toContain("coalesce(s.visibility, 'open') AS visibility");
  });

  it('UPDATE_SPACE writes visibility behind a flag and auto-grants the flipper', () => {
    expect(CYPHER.UPDATE_SPACE).toContain('$writeVisibility');
    expect(CYPHER.UPDATE_SPACE).toContain('SET s.visibility = $visibility');
    // Auto-grant: restricting a Space MERGEs the caller's access edge
    // in the same transaction (no lock-yourself-out).
    expect(CYPHER.UPDATE_SPACE).toContain("MERGE (viewer:Person {id: $viewerId})");
    expect(CYPHER.UPDATE_SPACE).toContain('MERGE (viewer)-[:HAS_ACCESS]->(s)');
    expect(CYPHER.UPDATE_SPACE).toContain("$visibility = 'restricted'");
  });
});

// ─── 2. client behavior ──────────────────────────────────────────────────

describe('viewer binding', () => {
  it('binds the normalized (trimmed, lowercased) viewer id on gated reads', async () => {
    const { fn, calls } = buildStub(() => []);
    const client = new SdkSpacesClient({
      query: fn,
      viewerId: () => '  Robb@Onereach.com ',
    });
    await client.listSpaces();
    expect(calls[0]!.parameters).toMatchObject({ viewerId: 'robb@onereach.com' });
  });

  it("binds '' when no viewer resolver is configured (only open spaces)", async () => {
    const { fn, calls } = buildStub(() => []);
    const client = new SdkSpacesClient({ query: fn });
    await client.listSpaces();
    expect(calls[0]!.parameters).toMatchObject({ viewerId: '' });
  });

  it("binds '' when the resolver reports signed-out", async () => {
    const { fn, calls } = buildStub(() => []);
    const client = new SdkSpacesClient({ query: fn, viewerId: () => null });
    await client.listSpaces();
    expect(calls[0]!.parameters).toMatchObject({ viewerId: '' });
  });

  it('binds the viewer on getItem / search / home reads too', async () => {
    const { fn, calls } = buildStub(() => []);
    const client = new SdkSpacesClient({ query: fn, viewerId: () => 'v@x.com' });
    await client.getItem('a-1');
    await client.searchItems({ query: 'q' });
    expect(calls.every((c) => c.parameters?.['viewerId'] === 'v@x.com')).toBe(true);
  });
});

describe('updateSpace visibility', () => {
  it('passes the write flag + value + viewer for the auto-grant', async () => {
    const { fn, calls } = buildStub((c) =>
      c.includes('$writeVisibility') ? [SPACE_ROW] : []
    );
    const client = new SdkSpacesClient({ query: fn, viewerId: () => 'me@x.com' });
    const out = await client.updateSpace('s-1', { visibility: 'restricted' });
    expect(calls[0]!.parameters).toMatchObject({
      writeVisibility: true,
      visibility: 'restricted',
      viewerId: 'me@x.com',
    });
    expect(out.visibility).toBe('restricted');
  });

  it('leaves visibility untouched when the patch omits it', async () => {
    const { fn, calls } = buildStub((c) =>
      c.includes('$writeVisibility') ? [SPACE_ROW] : []
    );
    const client = new SdkSpacesClient({ query: fn });
    await client.updateSpace('s-1', { description: 'd' });
    expect(calls[0]!.parameters).toMatchObject({ writeVisibility: false });
  });

  it('rejects an invalid visibility value before touching the graph', async () => {
    const { fn, calls } = buildStub(() => []);
    const client = new SdkSpacesClient({ query: fn });
    await expect(
      client.updateSpace('s-1', { visibility: 'secret' as never })
    ).rejects.toMatchObject({ code: 'SPACES_INVALID_INPUT' });
    expect(calls).toHaveLength(0);
  });
});

describe('row mapping', () => {
  it('surfaces visibility on listed spaces', async () => {
    const { fn } = buildStub((c) => (c.includes('MATCH (s:Space)') ? [SPACE_ROW] : []));
    const client = new SdkSpacesClient({ query: fn, viewerId: () => 'me@x.com' });
    const spaces = await client.listSpaces();
    expect(spaces[0]!.visibility).toBe('restricted');
  });

  it('drops junk visibility values instead of propagating them', async () => {
    const { fn } = buildStub((c) =>
      c.includes('MATCH (s:Space)') ? [{ ...SPACE_ROW, visibility: 'banana' }] : []
    );
    const client = new SdkSpacesClient({ query: fn });
    const spaces = await client.listSpaces();
    expect(spaces[0]!.visibility).toBeUndefined();
  });
});

describe('IPC patch coercion (the layer that silently ate visibility)', () => {
  // Driven-pass regression (2026-08-05): the renderer sent
  // {visibility:'restricted'}, the graph write ran, but the IPC coercer
  // whitelist dropped the field — updatedAt bumped, visibility null.
  it('passes visibility through the update-space coercer', () => {
    expect(_coerceUpdateSpaceInputForTesting({ visibility: 'restricted' })).toEqual({
      visibility: 'restricted',
    });
    expect(_coerceUpdateSpaceInputForTesting({ visibility: 'open' })).toEqual({
      visibility: 'open',
    });
  });

  it('drops junk visibility values at the boundary', () => {
    expect(_coerceUpdateSpaceInputForTesting({ visibility: 'secret' })).toEqual({});
    expect(_coerceUpdateSpaceInputForTesting({ visibility: 7 })).toEqual({});
  });
});
