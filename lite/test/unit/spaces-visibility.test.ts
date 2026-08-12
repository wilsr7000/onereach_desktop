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
    // The 2026-08-07 review pass: read surfaces that leaked restricted
    // Spaces' CONTENTS even though the sidebar hid the Space itself.
    ['LIST_TICKETS_IN_SPACE', CYPHER.LIST_TICKETS_IN_SPACE],
    ['GET_CURRENT_PLAYBOOK', CYPHER.GET_CURRENT_PLAYBOOK],
    ['HOME_RECENT_EVENTS', CYPHER.HOME_RECENT_EVENTS],
    ['HOME_TOP_CONTRIBUTORS', CYPHER.HOME_TOP_CONTRIBUTORS],
    ['HOME_PERMISSION_SUMMARY', CYPHER.HOME_PERMISSION_SUMMARY],
    ['HOME_ENTITY_COUNTS_FALLBACK', CYPHER.HOME_ENTITY_COUNTS_FALLBACK],
  ];
  const gatedAssetQueries: Array<[string, string]> = [
    ['GET_ITEM', CYPHER.GET_ITEM],
    ['SEARCH_ITEMS', CYPHER.SEARCH_ITEMS],
    ['HOME_RECENT_ITEMS', CYPHER.HOME_RECENT_ITEMS],
    ['ITEM_RECENT_COMMITS', CYPHER.ITEM_RECENT_COMMITS],
  ];

  /**
   * Deliberately UNGATED, each with a reason. Listed so the next
   * reviewer sees a decision, not an omission:
   *  - FIND_ASSET_BY_FILE_KEY / FIND_AGENT_ASSET_IN_SPACE /
   *    LIST_INLINE_BINARY_ASSETS: main-process write-path helpers
   *    (orphan-cleanup ambiguity guard, create dedupe, GSX migration).
   *    Viewer-gating them would make cleanup DELETE files whose assets
   *    are merely invisible to the current viewer.
   *  - AGENT_LIBRARY_SEARCH / MEMBER_LIBRARY_SEARCH /
   *    HOME_AGENTS_SAMPLE: account-wide directories by design.
   *  - SPACE_EXISTS_BY_ID / SPACE_ITEM_COUNT: internal pre-flights;
   *    the mutations they serve are themselves gated now.
   *  - UNCATEGORIZED_*: items with no Space are visible by definition.
   */
  const DELIBERATELY_UNGATED = [
    'FIND_ASSET_BY_FILE_KEY',
    'FIND_AGENT_ASSET_IN_SPACE',
    'LIST_INLINE_BINARY_ASSETS',
    'AGENT_LIBRARY_SEARCH',
    // ADR-062 meeting ring (Decision 1): :MeetingLive is deliberately
    // un-spaced — "a doorbell, not an artifact". Transient account-wide
    // broadcast (title/joinUrl/host, TTL-bounded LIMIT 5); completed-
    // meeting assets (ADR-061) ARE gated. See inventory EXEMPT note.
    'LIST_LIVE_MEETINGS',
    'MEMBER_LIBRARY_SEARCH',
    'HOME_AGENTS_SAMPLE',
    'SPACE_EXISTS_BY_ID',
    'SPACE_ITEM_COUNT',
    // Internal endpoint-diff helper on the agent WRITE path; the
    // renderer reads endpoints through gated GET_ITEM projections.
    'GET_AGENT_ENDPOINTS',
  ];

  it('every ungated MATCH query is on the deliberate list — no accidental leaks', () => {
    const undeclared: string[] = [];
    for (const [name, body] of Object.entries(CYPHER)) {
      if (!/\bMATCH\b/.test(body)) continue;
      const gated =
        body.includes('SPACE_VISIBLE') === false && // predicates are interpolated…
        !body.includes('coalesce(s.visibility') &&
        !body.includes('coalesce(vs.visibility') &&
        !body.includes('coalesce(other.visibility') &&
        !body.includes('$viewerId');
      const writes = /\b(MERGE|CREATE|SET|DELETE|DETACH)\b/.test(body);
      if (gated && !writes && !name.startsWith('UNCATEGORIZED') && !name.startsWith('LIST_ITEMS_UNCATEGORIZED')) {
        if (!DELIBERATELY_UNGATED.includes(name)) undeclared.push(name);
      }
    }
    expect(undeclared, 'new read query lacks visibility AND is not on the deliberate list').toEqual([]);
  });

  it('space chips cannot name a restricted Space', () => {
    // An item reachable through one open Space must not reveal the
    // NAMES of restricted Spaces it also belongs to. GET_ITEM gates
    // the `s`-bound chips join; LIST_ITEMS_IN_SPACE gates its
    // `other`-bound join.
    expect(CYPHER.GET_ITEM).toContain('coalesce(vs.visibility'); // the item itself
    expect(CYPHER.GET_ITEM).toContain('coalesce(s.visibility'); // its chips
    expect(CYPHER.LIST_ITEMS_IN_SPACE).toContain('coalesce(other.visibility');
    expect(CYPHER.LIST_ITEMS_IN_SPACE).toContain('r2.expiresUnixMs');
  });

  it('membership + space mutations require the caller to see the Space', () => {
    for (const q of [
      CYPHER.ADD_SPACE_MEMBER,
      CYPHER.REMOVE_SPACE_MEMBER,
      CYPHER.UPDATE_SPACE,
      CYPHER.RENAME_SPACE,
      CYPHER.SOFT_DELETE_SPACE,
      CYPHER.HARD_DELETE_SPACE,
      CYPHER.UNDELETE_SPACE,
    ]) {
      expect(q).toContain("coalesce(s.visibility, 'open')");
      expect(q).toContain('$viewerId');
    }
  });

  it.each(gatedSpaceQueries)('%s gates on the space visibility predicate', (_name, q) => {
    expect(q).toContain("coalesce(s.visibility, 'open') <> 'restricted'");
    expect(q).toContain('$viewerId');
    expect(q).toContain('[r:HAS_ACCESS]->(s)');
    // ADR-052 — an EXISTING grant is not enough; it must still be live.
    expect(
      q.includes('r.expiresUnixMs IS NULL OR r.expiresUnixMs > $nowMs'),
      'expired grants must not confer visibility'
    ).toBe(true);
  });

  it.each(gatedAssetQueries)('%s gates on the asset visibility rule', (_name, q) => {
    expect(q).toContain("coalesce(vs.visibility, 'open') <> 'restricted'");
    expect(q).toContain('$viewerId');
    expect(q).toContain('[r:HAS_ACCESS]->(vs)');
    expect(q).toContain('r.expiresUnixMs IS NULL OR r.expiresUnixMs > $nowMs');
    // Uncategorized assets stay visible — and since 2026-08-06 that
    // means "in no LIVE Space", so an asset whose every Space was
    // deleted stays reachable instead of vanishing from every surface.
    expect(q).toContain('MATCH (a)-[:BELONGS_TO]->(anyLive:Space)');
    expect(q).toContain('WHERE anyLive.deletedAt IS NULL');
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

describe('ADR-052 — a malformed expiry must be rejected, never made permanent', () => {
  it('the members.add handler refuses a non-string, non-null expiresAt', async () => {
    // 2026-08-07 review: the handler coerced anything non-string to
    // `null`, which the SDK reads as PERMANENT — so an epoch-ms number
    // or a Date (both survive structured clone) silently produced a
    // permanent grant the admin believed expires Friday.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const candidates = [path.resolve('spaces/ipc.ts'), path.resolve('lite/spaces/ipc.ts')];
    const found = candidates.find((p) => fs.existsSync(p));
    expect(found, 'ipc.ts not found').toBeDefined();
    const src = fs.readFileSync(found as string, 'utf8');
    const start = src.indexOf('MEMBERS_ADD,');
    expect(start).toBeGreaterThan(-1);
    const handler = src.slice(start, start + 2200);
    expect(handler).toMatch(/must be an ISO string or null/);
    // The silent-coercion form must be gone.
    expect(handler).not.toMatch(/typeof payload\?\.expiresAt === 'string'\s*\n?\s*\? \(payload\.expiresAt as string \| null\)\s*\n?\s*: null/);
  });
});
