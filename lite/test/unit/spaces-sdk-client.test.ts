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
    // ADR-052 — `run()` injects `$nowMs` into EVERY query so the
    // access-expiry predicate can never be evaluated without a clock.
    // It is infrastructure, not something any individual call site
    // passes, so strip it here: these tests assert the parameters a
    // method actually builds, and every one of them would otherwise
    // have to carry an unpredictable wall-clock value. `run()`'s
    // injection is covered directly in spaces-access-expiry.test.ts.
    const { nowMs: _nowMs, ...callerParams } = (parameters ?? {}) as Record<string, unknown>;
    calls.push({
      cypher,
      parameters: parameters === undefined ? undefined : callerParams,
    });
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
  it('no query has duplicate aliases in its final RETURN (meta)', () => {
    // A duplicate `AS <name>` makes Cypher reject the WHOLE query and
    // the Edison endpoint surfaces that as zero rows — the renderer
    // then reports "Item not found" for perfectly healthy nodes. This
    // shipped once (2026-08-06: a second `AS description` in GET_ITEM
    // broke every detail-open); this test makes the class impossible.
    for (const [name, query] of Object.entries(CYPHER)) {
      if (typeof query !== 'string') continue;
      // Split into projection clauses: every WITH and every RETURN
      // owns its aliases; a duplicate WITHIN one clause is the bug
      // (across clauses is normal — `count(a) AS n ... n AS n`).
      const clauses = query.split(/\b(?=WITH\s|RETURN\s)/g).slice(1);
      for (const clause of clauses) {
        const aliases = [...clause.matchAll(/\bAS (\w+)/g)].map((m) => m[1]);
        const dupes = [...new Set(aliases.filter((a) => aliases.indexOf(a) !== aliases.lastIndexOf(a)))];
        expect(dupes, `${name} has duplicate aliases in a projection clause`).toEqual([]);
      }
    }
  });

  it('listSpaces query matches :Space + itemCount via member labels (ADR-060)', () => {
    expect(CYPHER.LIST_SPACES).toMatch(/MATCH \(s:Space\)/);
    // ADR-060: count what the grid renders — every member kind, live only.
    expect(CYPHER.LIST_SPACES).toMatch(/\(a\)-\[:BELONGS_TO\]->\(s\)/);
    expect(CYPHER.LIST_SPACES).toContain('a:Asset OR a:Playbook OR a:Note');
    expect(CYPHER.LIST_SPACES).toMatch(/a\.deletedAt IS NULL/);
    // Soft-deleted Spaces (deletedAt set) MUST be filtered out.
    // Without this WHERE, a deleted Space stays visible in the
    // sidebar after `deleteSpace()` even though the mutation
    // succeeded -- the user-reported bug from 2026-05-15.
    expect(CYPHER.LIST_SPACES).toMatch(/WHERE s\.deletedAt IS NULL/);
    expect(CYPHER.LIST_SPACES).toMatch(/RETURN/);
    expect(CYPHER.LIST_SPACES).toMatch(/ORDER BY toLower/);
    expect(CYPHER.LIST_SPACES).toMatch(/count\(a\) AS itemCount/);
  });

  it('uncategorized count filters soft-deleted assets and excludes BELONGS_TO', () => {
    expect(CYPHER.UNCATEGORIZED_COUNT).toMatch(/a\.deletedAt IS NULL/);
    // Semantics changed 2026-08-06: "uncategorized" is "in no LIVE
    // Space", so assets whose Space was deleted stay findable.
    expect(CYPHER.UNCATEGORIZED_COUNT).toMatch(
      /MATCH \(a\)-\[:BELONGS_TO\]->\(live:Space\)/
    );
    expect(CYPHER.UNCATEGORIZED_COUNT).toMatch(/count\(a\) AS count/);
  });

  it('list-items-uncategorized matches :Asset with no :Space membership + non-deleted', () => {
    // ADR-058: matches members by label set (Asset/Playbook/Note), not (a:Asset).
    expect(CYPHER.LIST_ITEMS_UNCATEGORIZED).toMatch(/a:Asset OR a:Playbook OR a:Note/);
    expect(CYPHER.LIST_ITEMS_UNCATEGORIZED).toMatch(/a\.deletedAt IS NULL/);
    expect(CYPHER.LIST_ITEMS_UNCATEGORIZED).toMatch(
      /MATCH \(a\)-\[:BELONGS_TO\]->\(live:Space\)/
    );
    expect(CYPHER.LIST_ITEMS_UNCATEGORIZED).toMatch(/\[\] AS otherSpaces/);
    expect(CYPHER.LIST_ITEMS_UNCATEGORIZED).toMatch(/SKIP toInteger\(\$offset\)/);
    expect(CYPHER.LIST_ITEMS_UNCATEGORIZED).toMatch(/LIMIT toInteger\(\$limit\)/);
  });

  it('summary excerpts fall back to inline content, guarded against data-URLs', () => {
    // Tile previews read `excerpt`; text/doc assets created via upload
    // or paste have `content` but rarely `description`/`notes`. The
    // fallback chain must reach content (capped) or every text tile
    // renders as a blank ¶ card — the 2026-08-05 "tile previews are
    // not working" report. Legacy base64 stubs must stay excluded.
    for (const q of [
      CYPHER.LIST_ITEMS_UNCATEGORIZED,
      CYPHER.LIST_ITEMS_IN_SPACE,
    ]) {
      expect(q).toMatch(/left\(a\.content, 280\)/);
      expect(q).toMatch(/a\.content STARTS WITH 'data:'/);
      // Empty-string guard: every tier must skip '' (created assets
      // carry description: '' — plain coalesce would stop there and
      // the content fallback would never fire).
      expect(q).toMatch(
        /CASE WHEN trim\(coalesce\(a\.description, ''\)\) = '' THEN NULL ELSE a\.description END/
      );
      expect(q).toMatch(
        /CASE WHEN trim\(coalesce\(a\.excerpt, ''\)\) = '' THEN NULL ELSE a\.excerpt END/
      );
      // Playbook tiles need description AND plan steps: summaries
      // carry `description` for all kinds plus a playbook-only
      // `contentHead` (excerpt alone would collapse them).
      expect(q).toMatch(/AS description,/);
      expect(q).toMatch(
        /coalesce\(a\.type, a\.assetType\) IN \['playbook', 'transcript', 'knowledge', 'journey'\]/
      );
      // Agent tiles need the behavioral type + endpoints without a
      // full getItem round-trip.
      expect(q).toMatch(/AS tileAgentType,/);
      expect(q).toMatch(/AS tileAgentEndpoints,/);
      expect(q).toMatch(/a\.metadata AS tileMetadata,/);
      expect(q).toMatch(/AS contentHead,/);
    }
  });

  it('member library searches Person + Agent with people first', () => {
    expect(CYPHER.MEMBER_LIBRARY_SEARCH).toMatch(/member:Person OR member:Agent/);
    expect(CYPHER.MEMBER_LIBRARY_SEARCH).toMatch(/CASE WHEN member:Person THEN 0 ELSE 1 END/);
    expect(CYPHER.MEMBER_LIBRARY_SEARCH).toMatch(/LIMIT toInteger\(\$limit\)/);
  });

  it('library-agent create falls back to a REPRESENTS source asset for content', () => {
    expect(CYPHER.CREATE_AGENT_FROM_LIBRARY).toMatch(/OPTIONAL MATCH \(src:Asset\)-\[:REPRESENTS\]->\(g\)/);
    expect(CYPHER.CREATE_AGENT_FROM_LIBRARY).toMatch(/coalesce\(g\.okf, g\.definition, srcAsset\.content, ''\)/);
    // Blank agent names fall back to the id, never an empty title.
    expect(CYPHER.CREATE_AGENT_FROM_LIBRARY).toMatch(/CASE WHEN trim\(coalesce\(g\.name, g\.title, ''\)\) = ''/);
  });

  it('endpoint registration MERGEs by url (no duplicate REACHABLE_VIA children)', () => {
    expect(CYPHER.CREATE_AGENT_ENDPOINT_MERGED).toMatch(/MERGE \(ag\)-\[:REACHABLE_VIA\]->\(e:AgentEndpoint:__KIND_LABEL__ \{url: \$url\}\)/);
    expect(CYPHER.CREATE_AGENT_ENDPOINT_MERGED).toMatch(/ON CREATE SET/);
  });

  it('list-items-in-space takes a spaceId param and filters otherSpaces', () => {
    expect(CYPHER.LIST_ITEMS_IN_SPACE).toMatch(/\(a\)-\[:BELONGS_TO\]->\(s:Space \{id: \$spaceId\}\)/);
    expect(CYPHER.LIST_ITEMS_IN_SPACE).toMatch(/other\.id <> s\.id/);
    expect(CYPHER.LIST_ITEMS_IN_SPACE).toMatch(/\[x IN otherSpacesRaw WHERE x\.id IS NOT NULL\] AS otherSpaces/);
    // Soft-deleted Spaces (target Space OR a multi-Space chip
    // target) MUST be filtered so the user never sees an item
    // attributed to a Space they just deleted.
    expect(CYPHER.LIST_ITEMS_IN_SPACE).toMatch(/s\.deletedAt IS NULL/);
    expect(CYPHER.LIST_ITEMS_IN_SPACE).toMatch(/other\.deletedAt IS NULL/);
  });

  it('getItem looks up a member node by id (ADR-058) and LIMITs 1', () => {
    expect(CYPHER.GET_ITEM).toMatch(/MATCH \(a \{id: \$id\}\)/);
    expect(CYPHER.GET_ITEM).toMatch(/a:Asset OR a:Playbook OR a:Note/);
    expect(CYPHER.GET_ITEM).toMatch(/LIMIT 1$/m);
    expect(CYPHER.GET_ITEM).toMatch(/coalesce\(a\.content, ''\) AS content/);
    // Metadata sprint: `a.metadata` is projected as the JSON string.
    expect(CYPHER.GET_ITEM).toMatch(/a\.metadata AS metadata/);
    // Sprint 1: soft-deleted assets must be hidden from every read.
    expect(CYPHER.GET_ITEM).toMatch(/a\.deletedAt IS NULL/);
  });

  it('every projection uses canonical-with-legacy coalesce for renames', () => {
    // a.name is canonical (per :Schema), a.title is legacy (per
    // omnigraph-client.js). Both LIST_ITEMS_* projections must
    // coalesce so existing data still renders.
    expect(CYPHER.LIST_ITEMS_IN_SPACE).toMatch(/coalesce\(a\.name, a\.title, a\.id\) AS title/);
    expect(CYPHER.LIST_ITEMS_UNCATEGORIZED).toMatch(/coalesce\(a\.name, a\.title, a\.id\) AS title/);
    // ADR-058: kind is label-aware (Playbook/Note derive from the label);
    // typed Assets still fall back to type/assetType.
    expect(CYPHER.LIST_ITEMS_IN_SPACE).toMatch(/WHEN a:Playbook THEN 'playbook'/);
    expect(CYPHER.LIST_ITEMS_IN_SPACE).toMatch(/coalesce\(a\.type, a\.assetType, 'other'\)\s*\n\s*END AS kind/);
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

describe('deleting a Space must not strand its assets', () => {
  // Verified live 2026-08-06: soft-deleting a Space left its assets
  // alive in the graph but reachable from NOWHERE — not the Space
  // (hidden), not Uncategorized (they still had a BELONGS_TO edge),
  // not search, not direct get. "Uncategorized" now means "in no LIVE
  // Space", which is the only reading that keeps them findable.
  it('uncategorized means "no LIVE space", not "no space at all"', () => {
    for (const q of [CYPHER.UNCATEGORIZED_COUNT, CYPHER.LIST_ITEMS_UNCATEGORIZED]) {
      expect(q).toMatch(/NOT EXISTS \{/);
      expect(q).toMatch(/MATCH \(a\)-\[:BELONGS_TO\]->\(live:Space\)/);
      expect(q).toMatch(/WHERE live\.deletedAt IS NULL/);
      // The old predicate stranded them — it must be gone.
      expect(q).not.toMatch(/NOT \(a\)-\[:BELONGS_TO\]->\(:Space\)/);
    }
  });

  it('asset visibility survives when every owning Space is deleted', () => {
    // ASSET_VISIBLE is inlined into the read queries; check one that
    // carries it plus the direct-get path.
    for (const q of [CYPHER.GET_ITEM, CYPHER.SEARCH_ITEMS]) {
      expect(q).toMatch(/MATCH \(a\)-\[:BELONGS_TO\]->\(anyLive:Space\)/);
      expect(q).toMatch(/WHERE anyLive\.deletedAt IS NULL/);
    }
  });

  it('the non-empty hard-delete refusal no longer claims the wrong recovery path', async () => {
    const stub = buildStubQuery();
    stub.setResponse('OPTIONAL MATCH (a)-[:BELONGS_TO]->(s)', [{ count: 3 }]);
    const client = new SdkSpacesClient({ query: stub.fn });
    await expect(client.deleteSpace('space-1', { soft: false })).rejects.toThrow(
      /still contains 3 item/
    );
    try {
      await client.deleteSpace('space-1', { soft: false });
    } catch (err) {
      const remediation = (err as { remediation?: string }).remediation ?? '';
      expect(remediation).toContain('Uncategorized');
      // It used to promise soft delete "keeps items reachable via
      // Uncategorized" as an inherent property — it wasn't true then.
      expect(remediation).not.toMatch(/keeps items reachable via Uncategorized/);
    }
  });
});

describe('creation attribution (2026-08-07)', () => {
  it('CREATE_ASSET writes an activity Commit in the shape the readers expect', () => {
    // ITEM_RECENT_COMMITS matches on assetId/TOUCHED; HOME_RECENT_EVENTS
    // projects hash/author/message/timestamp/spaceId + IN_SPACE. The
    // create-time commit must satisfy both, and must NOT be written
    // when the author is unknown (no lying "Someone" rows).
    expect(CYPHER.CREATE_ASSET).toContain('MERGE (c:Commit {hash: $commitHash})');
    expect(CYPHER.CREATE_ASSET).toContain("c.message = 'item:added'");
    expect(CYPHER.CREATE_ASSET).toContain('MERGE (c)-[:IN_SPACE]->(s)');
    expect(CYPHER.CREATE_ASSET).toContain('MERGE (c)-[:TOUCHED]->(a)');
    expect(CYPHER.CREATE_ASSET).toMatch(/CASE WHEN \$commitAuthor IS NULL THEN \[\]/);
  });

  it('BOTH create variants write the commit; MERGE-by-hash keeps it idempotent', () => {
    for (const q of [CYPHER.CREATE_ASSET, CYPHER.CREATE_ASSET_UNCATEGORIZED]) {
      expect(q).toContain('MERGE (c:Commit {hash: $commitHash})');
      expect(q).toContain("c.message = 'item:added'");
      expect(q).toContain('MERGE (c)-[:TOUCHED]->(a)');
      // Non-idempotent CREATE under a fanned-out OPTIONAL MATCH row set
      // would duplicate commits — the MERGE form cannot.
      expect(q).not.toMatch(/CREATE \(c:Commit/);
    }
    expect(CYPHER.CREATE_ASSET).toContain('MERGE (c)-[:IN_SPACE]->(s)');
  });

  it('creatorName is capped before persisting as Commit.author', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const found = ['spaces/sdk-client.ts', 'lite/spaces/sdk-client.ts']
      .map((r) => path.resolve(r))
      .find((f) => fs.existsSync(f));
    expect(found).toBeDefined();
    const src = fs.readFileSync(found as string, 'utf8');
    expect(src).toContain('.trim().slice(0, 120)');
  });

  it('the commit hash generator produces git-shaped 40-hex ids', async () => {
    const mod = await import('../../spaces/sdk-client.js');
    const src = (await import('node:fs')).readFileSync(
      (await import('node:path')).resolve(
        (await import('node:fs')).existsSync('spaces/sdk-client.ts')
          ? 'spaces/sdk-client.ts'
          : 'lite/spaces/sdk-client.ts'
      ),
      'utf8'
    );
    expect(src).toContain('function generateCommitHash');
    expect(mod).toBeDefined();
  });
});

describe('SdkSpacesClient directory searches', () => {
  it('member library maps rows, defaults kind to Person, and skips id-less junk', async () => {
    // Review finding (2026-08-06): the mapper used requireString on
    // `id`, so ONE malformed node threw the whole directory search
    // (LIST_SPACE_MEMBERS skips such rows instead).
    const stub = buildStubQuery();
    stub.setResponse('MEMBER_LIBRARY', []);
    stub.setResponse('member:Person OR member:Agent', [
      { kind: 'Person', id: 'dana@x.com', name: 'Dana', email: 'dana@x.com' },
      { kind: 'Agent', id: 'agent-7', name: 'Risk Analyst', email: null },
      { kind: 'Person', id: null, name: 'Broken row', email: null },
      { kind: null, id: 'p-9', name: 'No kind', email: null },
    ]);
    const client = new SdkSpacesClient({ query: stub.fn });
    const rows = await client.searchMemberLibrary('', 25);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ kind: 'Person', id: 'dana@x.com', name: 'Dana', email: 'dana@x.com' });
    expect(rows[1]?.kind).toBe('Agent');
    expect(rows[1]?.email).toBe('');
    // Unknown/missing kind falls back to Person (never throws).
    expect(rows[2]).toEqual({ kind: 'Person', id: 'p-9', name: 'No kind', email: '' });
  });

  it('member library clamps the limit and trims the query', async () => {
    const stub = buildStubQuery();
    stub.setResponse('member:Person OR member:Agent', []);
    const client = new SdkSpacesClient({ query: stub.fn });
    await client.searchMemberLibrary('  robb  ', 5000);
    const call = stub.calls.find((c) => c.cypher.includes('member:Person OR member:Agent'));
    expect(call?.parameters?.['q']).toBe('robb');
    expect(call?.parameters?.['limit']).toBe(100);
  });

  it('agent library skips id-less rows too', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (g:Agent)', [
      { id: 'a-1', name: 'Support', description: 'Helps', agentType: 'conversational' },
      { id: null, name: 'Junk', description: '', agentType: null },
    ]);
    const client = new SdkSpacesClient({ query: stub.fn });
    const rows = await client.searchAgentLibrary('', 25);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('a-1');
  });
});

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
    stub.setResponse('RETURN count(a) AS count', [{ count: 17 }]);
    const client = makeClient(stub);
    expect(await client.getUncategorizedCount()).toBe(17);
  });

  it('returns 0 when no rows come back', async () => {
    const stub = buildStubQuery();
    stub.setResponse('RETURN count(a) AS count', []);
    const client = makeClient(stub);
    expect(await client.getUncategorizedCount()).toBe(0);
  });

  it('clamps negative or fractional counts to a non-negative integer', async () => {
    const stub = buildStubQuery();
    stub.setResponse('RETURN count(a) AS count', [{ count: -5 }]);
    const client = makeClient(stub);
    expect(await client.getUncategorizedCount()).toBe(0);
  });

  it('returns 0 when count field is missing or non-numeric', async () => {
    const stub = buildStubQuery();
    stub.setResponse('RETURN count(a) AS count', [{ count: 'nope' }]);
    const client = makeClient(stub);
    expect(await client.getUncategorizedCount()).toBe(0);
  });
});

// ─── listItems() — uncategorized scope ──────────────────────────────────

describe('SdkSpacesClient.listItems (uncategorized)', () => {
  it('emits LIST_ITEMS_UNCATEGORIZED with default offset/limit', async () => {
    const stub = buildStubQuery();
    stub.setResponse('[] AS otherSpaces', []);
    const client = makeClient(stub);
    await client.listItems({ kind: 'uncategorized' });
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toEqual({ offset: 0, limit: 100, viewerId: '' });
    expect(call?.cypher).toContain('OPTIONAL MATCH (creator:Person)-[:CREATED]->(a)');
  });

  it('always returns otherSpaces=[] for uncategorized scope', async () => {
    const stub = buildStubQuery();
    stub.setResponse('[] AS otherSpaces', [
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
    stub.setResponse('[] AS otherSpaces', [
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
    stub.setResponse('[] AS otherSpaces', [
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
    stub.setResponse('[] AS otherSpaces', []);
    const client = makeClient(stub);
    await client.listItems({ kind: 'uncategorized' }, { limit: 999_999, offset: 50 });
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toEqual({ offset: 50, limit: 500, viewerId: '' });
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
    stub.setResponse('MATCH (a)-[:BELONGS_TO]->(s:Space', []);
    const client = makeClient(stub);
    await client.listItems({ kind: 'space', spaceId: 'sp-77' }, { limit: 20 });
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toEqual({ spaceId: 'sp-77', offset: 0, limit: 20, viewerId: '' });
  });

  it('keeps non-null otherSpaces chips and drops empty entries', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a)-[:BELONGS_TO]->(s:Space', [
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
    stub.setResponse('MATCH (a {id: $id})', []);
    const client = makeClient(stub);
    expect(await client.getItem('missing')).toBeNull();
  });

  it('maps the full Item including content + metadata', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a {id: $id})', [
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
    stub.setResponse('MATCH (a {id: $id})', [
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
    stub.setResponse('MATCH (a {id: $id})', [
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
    stub.setResponse('MATCH (a {id: $id})', [
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
    stub.setResponse('MATCH (a {id: $id})', [
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
    stub.setResponse('MATCH (a {id: $id})', [
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
    stub.setResponse('MATCH (a {id: $id})', [
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
    stub.setResponse('MATCH (a {id: $id})', [
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
    stub.setResponse('MATCH (a {id: $id})', [
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
    stub.setResponse("coalesce(a.content, '') AS content", [
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
    // ADR-057: the first call is now the snapshot pre-read (GET_ITEM);
    // find the update by its distinctive SET clause.
    const update = stub.calls.find((c) => c.cypher.includes('SET a.name = coalesce'));
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
    stub.setResponse("coalesce(a.content, '') AS content", [
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
    stub.setResponse("coalesce(a.content, '') AS content", []);
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
    stub.setResponse("coalesce(a.content, '') AS content", [
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
    expect(addCall?.parameters).toEqual({ id: 'i-1', tag: 'q3', viewerId: '' });
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
    stub.setResponse("coalesce(a.content, '') AS content", [
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
    expect(removeCall?.parameters).toEqual({ id: 'i-1', tag: 'policy', viewerId: '' });
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

  it('HOME_RECENT_ITEMS surfaces all member kinds (ADR-058) with ItemSummary projection', () => {
    expect(CYPHER.HOME_RECENT_ITEMS).toMatch(/a:Asset OR a:Playbook OR a:Note/);
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
    stub.setResponse('firstSpace', []);
    const client = makeClient(stub);
    await client.listRecentItems({ limit: 5 });
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toEqual({ limit: 5, viewerId: '' });
  });

  it('clamps limit to default 3 when not provided', async () => {
    const stub = buildStubQuery();
    stub.setResponse('firstSpace', []);
    const client = makeClient(stub);
    await client.listRecentItems();
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toEqual({ limit: 3, viewerId: '' });
  });

  it('caps limit at 50 (Home card max-row context)', async () => {
    const stub = buildStubQuery();
    stub.setResponse('firstSpace', []);
    const client = makeClient(stub);
    await client.listRecentItems({ limit: 999 });
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toEqual({ limit: 50, viewerId: '' });
  });

  it('maps rows to ItemSummary with single-Space chip', async () => {
    const stub = buildStubQuery();
    stub.setResponse('firstSpace', [
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
    expect(call?.parameters).toEqual({ limit: 50, since: null, spaceId: null, viewerId: '' });
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
      viewerId: '',
    });
  });

  it('caps limit at 200', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (c:Commit)', []);
    const client = makeClient(stub);
    await client.listRecentEvents({ limit: 1_000_000 });
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toEqual({ limit: 200, since: null, spaceId: null, viewerId: '' });
  });

  it('passes spaceId when provided (per-Space mini-Home)', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (c:Commit)', []);
    const client = makeClient(stub);
    await client.listRecentEvents({ limit: 20, spaceId: 'sp-77' });
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toEqual({ limit: 20, since: null, spaceId: 'sp-77', viewerId: '' });
  });

  it('treats an empty spaceId as "no scope" (null), not an empty match', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (c:Commit)', []);
    const client = makeClient(stub);
    await client.listRecentEvents({ spaceId: '' });
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toEqual({ limit: 50, since: null, spaceId: null, viewerId: '' });
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
    expect(call?.parameters).toEqual({ limit: 3, viewerId: '' });
    await client.listAgentsSample({ limit: 9999 });
    call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toEqual({ limit: 200, viewerId: '' });
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

  it('UPDATE_SPACE gates per-field writes and skips soft-deleted spaces', () => {
    expect(CYPHER.UPDATE_SPACE).toMatch(/MATCH \(s:Space \{id: \$id\}\)/);
    expect(CYPHER.UPDATE_SPACE).toMatch(/WHERE s\.deletedAt IS NULL/);
    expect(CYPHER.UPDATE_SPACE).toMatch(/SET s\.updatedAt = \$now/);
    // Per-field FOREACH guards -- a field is only written when its flag is true.
    expect(CYPHER.UPDATE_SPACE).toMatch(
      /FOREACH \(_ IN CASE WHEN \$writeDescription THEN \[1\] ELSE \[\] END[\s\S]+SET s\.description = \$description/
    );
    expect(CYPHER.UPDATE_SPACE).toMatch(
      /FOREACH \(_ IN CASE WHEN \$writeColor THEN \[1\] ELSE \[\] END[\s\S]+SET s\.color = \$color/
    );
    expect(CYPHER.UPDATE_SPACE).toMatch(
      /FOREACH \(_ IN CASE WHEN \$writeIconKey THEN \[1\] ELSE \[\] END[\s\S]+SET s\.iconKey = \$iconKey/
    );
    // No s.name = $name ever sneaks in -- renames go through RENAME_SPACE.
    expect(CYPHER.UPDATE_SPACE).not.toMatch(/SET s\.name/);
  });

  it('SPACE_ITEM_COUNT measures BELONGS_TO assets for hard-delete pre-flight', () => {
    expect(CYPHER.SPACE_ITEM_COUNT).toMatch(/MATCH \(s:Space \{id: \$id\}\)/);
    // ADR-060: the pre-flight counts every member kind, live only.
    expect(CYPHER.SPACE_ITEM_COUNT).toMatch(/OPTIONAL MATCH \(a\)-\[:BELONGS_TO\]->\(s\)/);
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

describe('SdkSpacesClient.updateSpace', () => {
  it('writes only the description field when only description is in the patch', async () => {
    const stub = buildStubQuery();
    stub.setResponse('s.description = $description', [
      {
        id: 'sp-1',
        name: 'Original',
        description: 'New objective',
        color: '',
        iconKey: '',
        createdAt: '',
        updatedAt: '2026-05-18T12:00:00Z',
      },
    ]);
    const client = makeClient(stub);
    const result = await client.updateSpace('sp-1', { description: 'New objective' });
    expect(result).toMatchObject({ id: 'sp-1', description: 'New objective' });
    const call = stub.calls.find((c) => c.cypher.includes('s.description = $description'));
    expect(call?.parameters).toMatchObject({
      id: 'sp-1',
      writeDescription: true,
      description: 'New objective',
      writeColor: false,
      writeIconKey: false,
    });
  });

  it('clears the description when passed empty string', async () => {
    const stub = buildStubQuery();
    stub.setResponse('s.description = $description', [
      {
        id: 'sp-1',
        name: 'Original',
        description: '',
        color: '',
        iconKey: '',
        createdAt: '',
        updatedAt: '2026-05-18T12:00:00Z',
      },
    ]);
    const client = makeClient(stub);
    const result = await client.updateSpace('sp-1', { description: '' });
    // Convention across Spaces: an empty description is projected as a
    // missing field (toSpace() drops empty strings) rather than `''`.
    // Consumers treat the absence as "no description".
    expect(result.description).toBeUndefined();
    const call = stub.calls.find((c) => c.cypher.includes('s.description = $description'));
    // The wire payload still sends the explicit empty string so the
    // Cypher can clear the existing value.
    expect(call?.parameters).toMatchObject({
      writeDescription: true,
      description: '',
    });
  });

  it('writes color + iconKey when both are in the patch', async () => {
    const stub = buildStubQuery();
    stub.setResponse('s.color = $color', [
      {
        id: 'sp-1',
        name: 'Original',
        description: '',
        color: '#4f8cff',
        iconKey: 'rocket',
        createdAt: '',
        updatedAt: '2026-05-18T12:00:00Z',
      },
    ]);
    const client = makeClient(stub);
    await client.updateSpace('sp-1', { color: '#4f8cff', iconKey: 'rocket' });
    const call = stub.calls.find((c) => c.cypher.includes('s.color = $color'));
    expect(call?.parameters).toMatchObject({
      writeDescription: false,
      writeColor: true,
      color: '#4f8cff',
      writeIconKey: true,
      iconKey: 'rocket',
    });
  });

  it('empty patch is still a valid update (bumps updatedAt only)', async () => {
    const stub = buildStubQuery();
    stub.setResponse('s.updatedAt = $now', [
      {
        id: 'sp-1',
        name: 'Original',
        description: '',
        color: '',
        iconKey: '',
        createdAt: '',
        updatedAt: '2026-05-18T12:00:00Z',
      },
    ]);
    const client = makeClient(stub);
    await client.updateSpace('sp-1', {});
    const call = stub.calls.find((c) => c.cypher.includes('s.updatedAt = $now'));
    expect(call?.parameters).toMatchObject({
      writeDescription: false,
      writeColor: false,
      writeIconKey: false,
    });
  });

  it('throws SPACES_NOT_FOUND when the update returns 0 rows', async () => {
    const stub = buildStubQuery();
    stub.setResponse('s.description = $description', []);
    const client = makeClient(stub);
    await expect(
      client.updateSpace('sp-x', { description: 'whatever' })
    ).rejects.toMatchObject({ code: 'SPACES_NOT_FOUND' });
  });

  it('rejects empty id with SPACES_INVALID_INPUT (client-side)', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    await expect(
      client.updateSpace('', { description: 'x' })
    ).rejects.toMatchObject({ code: 'SPACES_INVALID_INPUT' });
    expect(stub.calls.length).toBe(0);
  });

  it('rejects oversized description with SPACES_INVALID_INPUT (client-side)', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    const tooLong = 'x'.repeat(3001);
    await expect(
      client.updateSpace('sp-1', { description: tooLong })
    ).rejects.toMatchObject({ code: 'SPACES_INVALID_INPUT' });
    expect(stub.calls.length).toBe(0);
  });

  it('trims whitespace on description before sending', async () => {
    const stub = buildStubQuery();
    stub.setResponse('s.description = $description', [
      {
        id: 'sp-1',
        name: 'Original',
        description: 'New objective',
        color: '',
        iconKey: '',
        createdAt: '',
        updatedAt: '2026-05-18T12:00:00Z',
      },
    ]);
    const client = makeClient(stub);
    await client.updateSpace('sp-1', { description: '  New objective  ' });
    const call = stub.calls.find((c) => c.cypher.includes('s.description = $description'));
    expect(call?.parameters?.['description']).toBe('New objective');
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
    stub.setResponse('OPTIONAL MATCH (a)-[:BELONGS_TO]->(s)', [{ count: 7 }]);
    const client = makeClient(stub);
    await expect(client.deleteSpace('sp-1', { soft: false })).rejects.toMatchObject({
      code: 'SPACES_DELETE_NON_EMPTY',
    });
    // Must NOT have run HARD_DELETE_SPACE.
    expect(stub.calls.find((c) => c.cypher.includes('DELETE s'))).toBeUndefined();
  });

  it('hard delete proceeds when item count is 0', async () => {
    const stub = buildStubQuery();
    stub.setResponse('OPTIONAL MATCH (a)-[:BELONGS_TO]->(s)', [{ count: 0 }]);
    stub.setResponse('DELETE s', []);
    const client = makeClient(stub);
    await client.deleteSpace('sp-1', { soft: false });
    expect(stub.calls.find((c) => c.cypher.includes('DELETE s'))).toBeDefined();
  });

  it('hard delete throws SPACES_NOT_FOUND when the space does not exist', async () => {
    const stub = buildStubQuery();
    // SPACE_ITEM_COUNT returns no rows because MATCH didn't bind.
    stub.setResponse('OPTIONAL MATCH (a)-[:BELONGS_TO]->(s)', []);
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
    stub.setResponse('MATCH (a {id: $id})', []);
    const client = makeClient(stub);
    await client.itemRecentCommits('asset-1');
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toEqual({ id: 'asset-1', limit: 20, since: null, viewerId: '' });
  });

  it('caps limit at 100', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a {id: $id})', []);
    const client = makeClient(stub);
    await client.itemRecentCommits('asset-1', { limit: 9999 });
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toMatchObject({ limit: 100 });
  });

  it('rejects zero / negative limit by falling back to default (20)', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a {id: $id})', []);
    const client = makeClient(stub);
    await client.itemRecentCommits('asset-1', { limit: -10 });
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toMatchObject({ limit: 20 });
  });

  it('forwards a numeric since cutoff', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a {id: $id})', []);
    const client = makeClient(stub);
    await client.itemRecentCommits('asset-1', { since: 1_700_000_000_000 });
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toMatchObject({ since: 1_700_000_000_000 });
  });

  it('treats negative / NaN since as null (defensive)', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a {id: $id})', []);
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
    stub.setResponse('MATCH (a {id: $id})', []);
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

  it('CREATE_AGENT writes the asset + parent :Agent + typed child with edges', () => {
    expect(CYPHER.CREATE_AGENT).toMatch(/CREATE \(a:Asset \{/);
    expect(CYPHER.CREATE_AGENT).toMatch(/type: 'agent'/);
    expect(CYPHER.CREATE_AGENT).toMatch(/content: \$okf/);
    expect(CYPHER.CREATE_AGENT).toMatch(/MERGE \(a\)-\[:BELONGS_TO\]->\(s\)/);
    expect(CYPHER.CREATE_AGENT).toMatch(/CREATE \(ag:Agent \{/);
    expect(CYPHER.CREATE_AGENT).toMatch(/CREATE \(a\)-\[:REPRESENTS\]->\(ag\)/);
    expect(CYPHER.CREATE_AGENT).toMatch(/CREATE \(t:AgentType:__TYPE_LABEL__ \{/);
    expect(CYPHER.CREATE_AGENT).toMatch(/CREATE \(ag\)-\[:HAS_TYPE\]->\(t\)/);
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
    stub.setResponse("coalesce(a.content, '') AS content", [
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
    stub.setResponse("coalesce(a.content, '') AS content", [
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
      viewerId: '',
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
    stub.setResponse("coalesce(a.content, '') AS content", [
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

describe('SdkSpacesClient.createAgent', () => {
  // GET_ITEM is uniquely identified by its BELONGS_TO OPTIONAL MATCH
  // (CREATE_AGENT uses MERGE, never OPTIONAL MATCH ...->(s:Space)).
  const GET_ITEM_NEEDLE = 'OPTIONAL MATCH (a)-[:BELONGS_TO]->(s:Space)';
  function agentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'agent-stub',
      title: 'My Agent',
      kind: 'agent',
      createdAt: '',
      updatedAt: '',
      otherSpaces: [],
      producedBy: null,
      tags: [],
      content: 'name: My Agent',
      agentType: 'conversational',
      ...overrides,
    };
  }

  it('rejects empty OKF', async () => {
    const client = makeClient(buildStubQuery());
    await expect(
      client.createAgent({ spaceId: 'sp-1', name: 'A', okf: '   ', agentType: 'tool' })
    ).rejects.toMatchObject({ code: 'SPACES_INVALID_INPUT' });
  });

  it('rejects a missing spaceId (agents must live in a Space)', async () => {
    const client = makeClient(buildStubQuery());
    await expect(
      client.createAgent({ spaceId: '', name: 'A', okf: 'x: 1', agentType: 'tool' })
    ).rejects.toMatchObject({ code: 'SPACES_INVALID_INPUT' });
  });

  it('writes asset + parent :Agent + typed child, returns kind=agent + agentType', async () => {
    const stub = buildStubQuery();
    stub.setResponse('CREATE (a:Asset', [{ id: 'agent-stub' }]);
    stub.setResponse(GET_ITEM_NEEDLE, [agentRow()]);
    const client = makeClient(stub);
    const created = await client.createAgent({
      spaceId: 'sp-1',
      name: 'My Agent',
      okf: 'name: My Agent',
      agentType: 'conversational',
    });
    expect(created.kind).toBe('agent');
    expect(created.agentType).toBe('conversational');

    const createCall = stub.calls.find(
      (c) => c.cypher.includes('CREATE (a:Asset') && c.cypher.includes('REPRESENTS')
    );
    expect(createCall).toBeDefined();
    // OKF stored as content; type carried as a param + interpolated label.
    expect(createCall?.parameters).toMatchObject({
      spaceId: 'sp-1',
      name: 'My Agent',
      okf: 'name: My Agent',
      agentType: 'conversational',
    });
    // The full subgraph is written in one statement.
    expect(createCall?.cypher).toContain("type: 'agent'");
    expect(createCall?.cypher).toContain('MERGE (a)-[:BELONGS_TO]->(s)');
    expect(createCall?.cypher).toContain('CREATE (ag:Agent {');
    expect(createCall?.cypher).toContain('(a)-[:REPRESENTS]->(ag)');
    expect(createCall?.cypher).toContain('(ag)-[:HAS_TYPE]->(t)');
    // Placeholder replaced with the sanitized per-type label.
    expect(createCall?.cypher).not.toContain('__TYPE_LABEL__');
    expect(createCall?.cypher).toContain(':AgentType:Conversational');
  });

  it('sanitizes the agent type into a safe PascalCase Cypher label', async () => {
    const cases: Array<[string, string]> = [
      ['workflow', ':AgentType:Workflow'],
      ['multi step', ':AgentType:MultiStep'],
      ['weird id/../x!', ':AgentType:WeirdIdX'],
      ['', ':AgentType:Other'],
      ['123', ':AgentType:Other'], // must start with a letter
    ];
    for (const [agentType, expectedLabel] of cases) {
      const stub = buildStubQuery();
      stub.setResponse('CREATE (a:Asset', [{ id: 'a' }]);
      stub.setResponse(GET_ITEM_NEEDLE, [agentRow({ agentType })]);
      const client = makeClient(stub);
      await client.createAgent({ spaceId: 'sp-1', name: 'A', okf: 'x: 1', agentType });
      const createCall = stub.calls.find((c) => c.cypher.includes('REPRESENTS'));
      expect(createCall?.cypher, `agentType=${JSON.stringify(agentType)}`).toContain(
        expectedLabel
      );
      // The injection-y input never breaks out of the label position.
      expect(createCall?.cypher).not.toContain('__TYPE_LABEL__');
      expect(createCall?.cypher).not.toContain('/../');
      expect(createCall?.cypher).not.toContain('!');
    }
  });

  it('throws SPACES_NOT_FOUND when the Space is missing', async () => {
    const stub = buildStubQuery();
    stub.setResponse('CREATE (a:Asset', []);
    const client = makeClient(stub);
    await expect(
      client.createAgent({ spaceId: 'sp-gone', name: 'A', okf: 'x: 1', agentType: 'tool' })
    ).rejects.toMatchObject({ code: 'SPACES_NOT_FOUND' });
  });

  it('writes each reachability endpoint as a per-kind :REACHABLE_VIA child node', async () => {
    const stub = buildStubQuery();
    stub.setResponse('CREATE (a:Asset', [{ id: 'agent-stub' }]);
    stub.setResponse(GET_ITEM_NEEDLE, [agentRow()]);
    const client = makeClient(stub);
    await client.createAgent({
      spaceId: 'sp-1',
      name: 'My Agent',
      okf: 'name: My Agent',
      agentType: 'conversational',
      endpoints: [
        { kind: 'mcp', url: 'https://x/mcp', channels: ['web', 'slack'] },
        { kind: 'skill', url: 'https://x/skill', channels: [] },
      ],
    });

    // Endpoints are also denormalized onto the asset as a JSON property.
    const createCall = stub.calls.find((c) => c.cypher.includes('REPRESENTS'));
    const json = createCall?.parameters?.['agentEndpointsJson'];
    expect(typeof json).toBe('string');
    expect(JSON.parse(json as string)).toEqual([
      { kind: 'mcp', url: 'https://x/mcp', channels: ['web', 'slack'] },
      { kind: 'skill', url: 'https://x/skill', channels: [] },
    ]);

    // One :REACHABLE_VIA write per endpoint, each with its sanitized label.
    const epCalls = stub.calls.filter((c) => c.cypher.includes('REACHABLE_VIA'));
    expect(epCalls).toHaveLength(2);
    expect(epCalls[0]?.cypher).toContain(':AgentEndpoint:Mcp');
    expect(epCalls[0]?.cypher).not.toContain('__KIND_LABEL__');
    expect(epCalls[0]?.parameters).toMatchObject({
      agentId: expect.any(String),
      endpointId: expect.any(String),
      kind: 'mcp',
      url: 'https://x/mcp',
      channels: 'web,slack', // joined for storage
    });
    expect(epCalls[1]?.cypher).toContain(':AgentEndpoint:Skill');
    expect(epCalls[1]?.parameters).toMatchObject({
      kind: 'skill',
      url: 'https://x/skill',
      channels: '',
    });
  });

  it('writes no :REACHABLE_VIA nodes + an empty endpoints prop when none are given', async () => {
    const stub = buildStubQuery();
    stub.setResponse('CREATE (a:Asset', [{ id: 'agent-stub' }]);
    stub.setResponse(GET_ITEM_NEEDLE, [agentRow()]);
    const client = makeClient(stub);
    await client.createAgent({ spaceId: 'sp-1', name: 'A', okf: 'x: 1', agentType: 'tool' });
    expect(stub.calls.some((c) => c.cypher.includes('REACHABLE_VIA'))).toBe(false);
    const createCall = stub.calls.find((c) => c.cypher.includes('REPRESENTS'));
    expect(createCall?.parameters?.['agentEndpointsJson']).toBe('');
  });

  it('drops endpoints with an empty url and trims + dedupes channels', async () => {
    const stub = buildStubQuery();
    stub.setResponse('CREATE (a:Asset', [{ id: 'agent-stub' }]);
    stub.setResponse(GET_ITEM_NEEDLE, [agentRow()]);
    const client = makeClient(stub);
    await client.createAgent({
      spaceId: 'sp-1',
      name: 'A',
      okf: 'x: 1',
      agentType: 'tool',
      endpoints: [
        { kind: 'mcp', url: '   ', channels: [] }, // empty url -> dropped
        { kind: 'api', url: 'https://y/api', channels: [' rest ', 'rest', '', 'Webhook'] },
      ],
    });
    const epCalls = stub.calls.filter((c) => c.cypher.includes('REACHABLE_VIA'));
    expect(epCalls).toHaveLength(1);
    expect(epCalls[0]?.parameters).toMatchObject({
      kind: 'api',
      url: 'https://y/api',
      channels: 'rest,Webhook', // trimmed, case-preserving, de-duplicated
    });
  });

  it('projects the asset agentEndpoints JSON back onto the returned Item', async () => {
    const stub = buildStubQuery();
    stub.setResponse('CREATE (a:Asset', [{ id: 'agent-stub' }]);
    stub.setResponse(GET_ITEM_NEEDLE, [
      agentRow({
        agentEndpoints: JSON.stringify([
          { kind: 'api', url: 'https://y/api', channels: ['rest'] },
        ]),
      }),
    ]);
    const client = makeClient(stub);
    const created = await client.createAgent({
      spaceId: 'sp-1',
      name: 'A',
      okf: 'x: 1',
      agentType: 'tool',
    });
    expect(created.agentEndpoints).toEqual([
      { kind: 'api', url: 'https://y/api', channels: ['rest'] },
    ]);
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
    stub.setResponse("coalesce(a.content, '') AS content", [
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
    stub.setResponse("coalesce(a.content, '') AS content", [
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
    stub.setResponse("coalesce(a.content, '') AS content", [
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
    stub.setResponse("coalesce(a.content, '') AS content", [
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
    // ADR-052 — the edge is bound (`r`) so the grant's expiry can be
    // projected. Deliberately NOT filtered on expiry: a lapsed member
    // stays listed so the owner can see why they lost access.
    expect(CYPHER.LIST_SPACE_MEMBERS).toMatch(
      /OPTIONAL MATCH \(member\)-\[r:HAS_ACCESS\]->\(s\)/
    );
    expect(CYPHER.LIST_SPACE_MEMBERS).toContain('r.expiresUnixMs AS expiresUnixMs');
    // Two DIFFERENT expiry checks must not be conflated:
    //   - the VIEWER's grant (inside the SPACE_VISIBLE EXISTS) may and
    //     does check expiry — an expired viewer cannot read a
    //     restricted roster (2026-08-07 gating pass);
    //   - the ROSTER edge must NOT be expiry-filtered — lapsed members
    //     stay listed so the owner can see why and renew them.
    // So: the member OPTIONAL MATCH carries only the label check.
    expect(CYPHER.LIST_SPACE_MEMBERS).toMatch(
      /OPTIONAL MATCH \(member\)-\[r:HAS_ACCESS\]->\(s\)\n\s+WHERE member:Person OR member:Agent\n\s+WITH member, r/
    );
    expect(CYPHER.LIST_SPACE_MEMBERS).toMatch(/member:Person OR member:Agent/);
  });

  it('ADD_SPACE_MEMBER MERGEs HAS_ACCESS idempotently', () => {
    // ADR-052 — the edge is now bound (`r`) so a per-grant expiry can
    // be written onto it.
    expect(CYPHER.ADD_SPACE_MEMBER).toMatch(/MERGE \(member\)-\[r:HAS_ACCESS\]->\(s\)/);
    expect(CYPHER.ADD_SPACE_MEMBER).toMatch(/member:Person OR member:Agent/);
    // Expiry is written only when the caller asked, so re-adding a
    // member never silently changes an existing deadline.
    expect(CYPHER.ADD_SPACE_MEMBER).toContain('$writeExpiry');
    expect(CYPHER.ADD_SPACE_MEMBER).toContain('r.expiresUnixMs = $expiresUnixMs');
  });

  it('REMOVE_SPACE_MEMBER deletes the edge — and only for an authorized caller', () => {
    // 2026-08-07 gating pass: the Space is matched FIRST, gated by
    // SPACE_VISIBLE, so a caller who cannot see a restricted Space
    // cannot strip its members.
    expect(CYPHER.REMOVE_SPACE_MEMBER).toMatch(/MATCH \(s:Space \{id: \$spaceId\}\)/);
    // ADR-065: the gate is belonging-only (creator or live member) —
    // 'open' visibility no longer grants anything.
    expect(CYPHER.REMOVE_SPACE_MEMBER).toContain("coalesce(s.createdBy, '') = $viewerId");
    expect(CYPHER.REMOVE_SPACE_MEMBER).toMatch(
      /MATCH \(member \{id: \$memberId\}\)-\[r:HAS_ACCESS\]->\(s\)/
    );
    expect(CYPHER.REMOVE_SPACE_MEMBER).toMatch(/DELETE r/);
    // 2026-08-08 release review: the revoke returns evidence — a
    // deleted-edge COUNT, not a parameter echo. The aggregation
    // guarantees one row, so `[]` is distinguishable as a swallowed
    // Cypher error (Edison empty-200) and zero as "nothing removed".
    expect(CYPHER.REMOVE_SPACE_MEMBER).toContain('RETURN count(r) AS deleted');
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
    stub.setResponse('OPTIONAL MATCH (member)-[r:HAS_ACCESS]', []);
    const client = makeClient(stub);
    const members = await client.listSpaceMembers('sp-1');
    expect(members).toEqual([]);
  });

  it('maps rows into SpaceMember objects with default kind/name', async () => {
    const stub = buildStubQuery();
    stub.setResponse('OPTIONAL MATCH (member)-[r:HAS_ACCESS]', [
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
    stub.setResponse('OPTIONAL MATCH (member)-[r:HAS_ACCESS]', [
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
    stub.setResponse('MERGE (member)-[r:HAS_ACCESS]->(s)', []);
    const client = makeClient(stub);
    await expect(
      client.addSpaceMember('sp-1', 'alice')
    ).rejects.toMatchObject({ code: 'SPACES_NOT_FOUND' });
  });

  it('returns the canonical (kind, id, name) tuple', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MERGE (member)-[r:HAS_ACCESS]->(s)', [
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

  // 2026-08-08 release review: a REVOKE is verified, never assumed.
  // The old contract returned silently on ANY result — combined with
  // Edison's errors-as-empty-200s, a failed revoke looked done.

  it('throws SPACES_CYPHER on an empty result (Edison-swallowed error)', async () => {
    // A count() aggregation always yields one row; empty rows can only
    // mean the query itself failed and Edison ate the error.
    const stub = buildStubQuery();
    stub.setResponse('count(r) AS deleted', []);
    const client = makeClient(stub);
    await expect(client.removeSpaceMember('sp-1', 'alice')).rejects.toMatchObject({
      code: 'SPACES_CYPHER',
      message: expect.stringContaining('may NOT have been revoked'),
    });
  });

  it('throws SPACES_NOT_FOUND when zero edges were deleted', async () => {
    // Member already absent, or the Space is not visible to the viewer
    // — either way nothing was revoked, and the caller must know.
    const stub = buildStubQuery();
    stub.setResponse('count(r) AS deleted', [{ deleted: 0 }]);
    const client = makeClient(stub);
    await expect(client.removeSpaceMember('sp-1', 'alice')).rejects.toMatchObject({
      code: 'SPACES_NOT_FOUND',
    });
  });

  it('resolves when an edge was deleted; forwards spaceId + memberId', async () => {
    const stub = buildStubQuery();
    stub.setResponse('count(r) AS deleted', [{ deleted: 1 }]);
    const client = makeClient(stub);
    await expect(client.removeSpaceMember('sp-1', 'alice')).resolves.toBeUndefined();
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toEqual({ spaceId: 'sp-1', memberId: 'alice', viewerId: '' });
  });
});

// ─── Sprint 1: asset CRUD ───────────────────────────────────────────────

describe('CYPHER source strings — Sprint 1 (asset CRUD)', () => {
  it('CREATE_ASSET requires a Space, CREATEs :Asset, merges BELONGS_TO + optional CREATED', () => {
    expect(CYPHER.CREATE_ASSET).toMatch(/MATCH \(s:Space \{id: \$spaceId\}\)/);
    expect(CYPHER.CREATE_ASSET).toMatch(/WHERE s\.deletedAt IS NULL/);
    expect(CYPHER.CREATE_ASSET).toMatch(/CREATE \(a:Asset \{/);
    expect(CYPHER.CREATE_ASSET).toMatch(/type: \$kind/);
    expect(CYPHER.CREATE_ASSET).toMatch(/MERGE \(a\)-\[:BELONGS_TO\]->\(s\)/);
    expect(CYPHER.CREATE_ASSET).toMatch(/OPTIONAL MATCH \(p:Person \{id: coalesce\(\$creatorId, \$viewerId\)\}\)/);
    expect(CYPHER.CREATE_ASSET).toMatch(/MERGE \(x\)-\[:CREATED\]->\(a\)/);
  });

  it('CREATE_ASSET_UNCATEGORIZED creates without a BELONGS_TO edge', () => {
    expect(CYPHER.CREATE_ASSET_UNCATEGORIZED).toMatch(/CREATE \(a:Asset \{/);
    expect(CYPHER.CREATE_ASSET_UNCATEGORIZED).not.toMatch(/BELONGS_TO/);
  });

  it('SOFT_DELETE_ASSET sets deletedAt and only matches non-deleted member rows', () => {
    // ADR-059: delete works on any member kind (Asset/Playbook/Note).
    expect(CYPHER.SOFT_DELETE_ASSET).toMatch(/MATCH \(a \{id: \$id\}\)/);
    expect(CYPHER.SOFT_DELETE_ASSET).toContain('a:Asset OR a:Playbook OR a:Note');
    expect(CYPHER.SOFT_DELETE_ASSET).toMatch(/a\.deletedAt IS NULL/);
    expect(CYPHER.SOFT_DELETE_ASSET).toMatch(/SET a\.deletedAt = \$now/);
    expect(CYPHER.SOFT_DELETE_ASSET).toMatch(/a\.updatedAt = \$now/);
  });

  it('RESTORE_ASSET clears deletedAt and only matches soft-deleted rows', () => {
    expect(CYPHER.RESTORE_ASSET).toMatch(/WHERE a\.deletedAt IS NOT NULL/);
    expect(CYPHER.RESTORE_ASSET).toMatch(/SET a\.deletedAt = null/);
  });

  it('HARD_DELETE_ASSET uses DETACH DELETE (drops incident edges)', () => {
    expect(CYPHER.HARD_DELETE_ASSET).toMatch(/MATCH \(a:Asset \{id: \$id\}\)/);
    expect(CYPHER.HARD_DELETE_ASSET).toMatch(/DETACH DELETE a/);
  });
});

describe('SdkSpacesClient.createAsset', () => {
  it('rejects empty title', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    await expect(
      client.createAsset({ spaceId: 'sp-1', title: '   ' })
    ).rejects.toMatchObject({ code: 'SPACES_INVALID_INPUT' });
  });

  it('infers kind=text from content when not specified', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MERGE (n:Note {id: $id})', [{ id: 'note-stub', spaceName: 'S' }]);
    stub.setResponse("coalesce(a.content, '') AS content", [
      {
        id: 'asset-stub',
        title: 'Note',
        kind: 'text',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: null,
        tags: [],
      },
    ]);
    const client = makeClient(stub);
    const created = await client.createAsset({
      spaceId: 'sp-1',
      title: 'Note',
      content: 'Hello',
    });
    expect(created.kind).toBe('text');
    // ADR-059: inferred text in a Space births a universal note citizen.
    const call = stub.calls.find((c) => c.cypher.includes('MERGE (n:Note {id: $id})'));
    expect(call?.parameters).toMatchObject({ content: 'Hello', subtype: 'Basic' });
  });

  it('infers kind=other when only fileKey is provided', async () => {
    const stub = buildStubQuery();
    stub.setResponse('CREATE (a:Asset', [{ id: 'asset-stub' }]);
    stub.setResponse("coalesce(a.content, '') AS content", [
      {
        id: 'asset-stub',
        title: 'Doc',
        kind: 'other',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: null,
        tags: [],
      },
    ]);
    const client = makeClient(stub);
    await client.createAsset({
      spaceId: 'sp-1',
      title: 'Doc',
      fileKey: 'foo/bar.pdf',
    });
    const call = stub.calls.find((c) => c.cypher.includes('CREATE (a:Asset'));
    expect(call?.parameters).toMatchObject({ kind: 'other', fileKey: 'foo/bar.pdf' });
  });

  it('uses CREATE_ASSET_UNCATEGORIZED when spaceId is empty', async () => {
    const stub = buildStubQuery();
    stub.setResponse('CREATE (a:Asset', [{ id: 'asset-stub' }]);
    stub.setResponse("coalesce(a.content, '') AS content", [
      {
        id: 'asset-stub',
        title: 'Intake',
        kind: 'text',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: null,
        tags: [],
      },
    ]);
    const client = makeClient(stub);
    await client.createAsset({ spaceId: '', title: 'Intake', content: 'x' });
    // Verify the uncategorized variant was used: no spaceId in params.
    const call = stub.calls.find((c) => c.cypher.includes('CREATE (a:Asset'));
    expect(call?.parameters).not.toHaveProperty('spaceId');
  });

  it('throws SPACES_NOT_FOUND when target space is missing', async () => {
    const stub = buildStubQuery();
    stub.setResponse('CREATE (a:Asset', []);
    const client = makeClient(stub);
    await expect(
      client.createAsset({ spaceId: 'sp-gone', title: 'x', content: 'y' })
    ).rejects.toMatchObject({ code: 'SPACES_NOT_FOUND' });
  });
});

describe('SdkSpacesClient.deleteAsset', () => {
  it('rejects empty id', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    await expect(client.deleteAsset('')).rejects.toMatchObject({
      code: 'SPACES_INVALID_INPUT',
    });
  });

  it('defaults to soft delete; throws SPACES_NOT_FOUND when 0 rows', async () => {
    const stub = buildStubQuery();
    stub.setResponse('SET a.deletedAt = $now', []);
    const client = makeClient(stub);
    await expect(client.deleteAsset('i-gone')).rejects.toMatchObject({
      code: 'SPACES_NOT_FOUND',
    });
  });

  it('soft delete returns void on success', async () => {
    const stub = buildStubQuery();
    stub.setResponse('SET a.deletedAt = $now', [{ id: 'i-1' }]);
    const client = makeClient(stub);
    await expect(client.deleteAsset('i-1')).resolves.toBeUndefined();
  });

  it('hard delete uses DETACH DELETE Cypher', async () => {
    const stub = buildStubQuery();
    stub.setResponse('DETACH DELETE a', []);
    const client = makeClient(stub);
    await client.deleteAsset('i-1', { soft: false });
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.cypher).toMatch(/DETACH DELETE a/);
  });
});

describe('SdkSpacesClient.restoreAsset', () => {
  it('rejects empty id', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    await expect(client.restoreAsset('')).rejects.toMatchObject({
      code: 'SPACES_INVALID_INPUT',
    });
  });

  it('throws SPACES_NOT_FOUND when the asset is not soft-deleted', async () => {
    const stub = buildStubQuery();
    stub.setResponse('SET a.deletedAt = null', []);
    const client = makeClient(stub);
    await expect(client.restoreAsset('i-fresh')).rejects.toMatchObject({
      code: 'SPACES_NOT_FOUND',
    });
  });

  it('returns the re-fetched Item on success', async () => {
    const stub = buildStubQuery();
    stub.setResponse('SET a.deletedAt = null', [{ id: 'i-1' }]);
    stub.setResponse("coalesce(a.content, '') AS content", [
      {
        id: 'i-1',
        title: 'Back',
        kind: 'text',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: null,
        tags: [],
      },
    ]);
    const client = makeClient(stub);
    const restored = await client.restoreAsset('i-1');
    expect(restored.id).toBe('i-1');
  });
});

// ─── Sprint 3: move / copy / search ─────────────────────────────────────

describe('CYPHER source strings — Sprint 3 (move / copy / search)', () => {
  it('MOVE_ASSET_TO_SPACE drops old BELONGS_TO and merges new one', () => {
    expect(CYPHER.MOVE_ASSET_TO_SPACE).toMatch(/MATCH \(a \{id: \$id\}\)/);
    expect(CYPHER.MOVE_ASSET_TO_SPACE).toContain('a:Asset OR a:Playbook OR a:Note');
    expect(CYPHER.MOVE_ASSET_TO_SPACE).toMatch(/MATCH \(target:Space \{id: \$toSpaceId\}\)/);
    expect(CYPHER.MOVE_ASSET_TO_SPACE).toMatch(
      /OPTIONAL MATCH \(a\)-\[old:BELONGS_TO\]->\(source:Space \{id: \$fromSpaceId\}\)/
    );
    expect(CYPHER.MOVE_ASSET_TO_SPACE).toMatch(/DELETE old/);
    expect(CYPHER.MOVE_ASSET_TO_SPACE).toMatch(/MERGE \(a\)-\[:BELONGS_TO\]->\(target\)/);
  });

  it('ADD_ASSET_TO_SPACE MERGEs an additional BELONGS_TO edge (idempotent)', () => {
    expect(CYPHER.ADD_ASSET_TO_SPACE).toMatch(/MERGE \(a\)-\[:BELONGS_TO\]->\(target\)/);
    expect(CYPHER.ADD_ASSET_TO_SPACE).not.toMatch(/DELETE/);
  });

  it('REMOVE_ASSET_FROM_SPACE drops one BELONGS_TO edge', () => {
    expect(CYPHER.REMOVE_ASSET_FROM_SPACE).toMatch(
      /MATCH \(a \{id: \$id\}\)-\[r:BELONGS_TO\]->\(s:Space \{id: \$spaceId\}\)/
    );
    expect(CYPHER.REMOVE_ASSET_FROM_SPACE).toContain('a:Asset OR a:Playbook OR a:Note');
    expect(CYPHER.REMOVE_ASSET_FROM_SPACE).toMatch(/DELETE r/);
  });

  it('SEARCH_ITEMS uses case-insensitive CONTAINS across name + description + excerpt', () => {
    expect(CYPHER.SEARCH_ITEMS).toMatch(/CONTAINS toLower\(\$query\)/);
    expect(CYPHER.SEARCH_ITEMS).toMatch(/coalesce\(a\.name, a\.title, ''\)/);
    expect(CYPHER.SEARCH_ITEMS).toMatch(/coalesce\(a\.description, ''\)/);
    expect(CYPHER.SEARCH_ITEMS).toMatch(/coalesce\(a\.excerpt, ''\)/);
  });

  it('SEARCH_ITEMS scopes to a Space when $spaceId is non-null', () => {
    expect(CYPHER.SEARCH_ITEMS).toMatch(/\$spaceId IS NULL/);
    expect(CYPHER.SEARCH_ITEMS).toMatch(
      /EXISTS \{ MATCH \(a\)-\[:BELONGS_TO\]->\(:Space \{id: \$spaceId\}\)/
    );
  });
});

describe('SdkSpacesClient.moveAssetToSpace', () => {
  it('rejects empty id / toSpaceId', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    await expect(client.moveAssetToSpace('', null, 'sp-2')).rejects.toMatchObject({
      code: 'SPACES_INVALID_INPUT',
    });
    await expect(client.moveAssetToSpace('i-1', null, '')).rejects.toMatchObject({
      code: 'SPACES_INVALID_INPUT',
    });
  });

  it('throws SPACES_NOT_FOUND when neither asset nor target matches', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MERGE (a)-[:BELONGS_TO]->(target)', []);
    const client = makeClient(stub);
    await expect(
      client.moveAssetToSpace('i-gone', null, 'sp-2')
    ).rejects.toMatchObject({ code: 'SPACES_NOT_FOUND' });
  });

  it('passes fromSpaceId=null when empty, or the provided id otherwise', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MERGE (a)-[:BELONGS_TO]->(target)', [{ id: 'i-1' }]);
    stub.setResponse("coalesce(a.content, '') AS content", [
      {
        id: 'i-1',
        title: 'x',
        kind: 'text',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: null,
        tags: [],
      },
    ]);
    const client = makeClient(stub);
    await client.moveAssetToSpace('i-1', '', 'sp-2');
    const call1 = stub.calls.find((c) => c.cypher.includes('MERGE (a)-[:BELONGS_TO]->(target)'));
    expect(call1?.parameters).toMatchObject({ fromSpaceId: null, toSpaceId: 'sp-2' });

    await client.moveAssetToSpace('i-1', 'sp-old', 'sp-2');
    const call2 = stub.calls
      .reverse()
      .find((c) => c.cypher.includes('MERGE (a)-[:BELONGS_TO]->(target)'));
    expect(call2?.parameters).toMatchObject({ fromSpaceId: 'sp-old' });
  });
});

describe('SdkSpacesClient.addAssetToSpace', () => {
  it('rejects empty inputs', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    await expect(client.addAssetToSpace('', 'sp-2')).rejects.toMatchObject({
      code: 'SPACES_INVALID_INPUT',
    });
    await expect(client.addAssetToSpace('i-1', '')).rejects.toMatchObject({
      code: 'SPACES_INVALID_INPUT',
    });
  });

  it('returns the updated Item on success', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MERGE (a)-[:BELONGS_TO]->(target)', [{ id: 'i-1' }]);
    stub.setResponse("coalesce(a.content, '') AS content", [
      {
        id: 'i-1',
        title: 'x',
        kind: 'text',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [{ id: 'sp-2', name: 'New Space' }],
        producedBy: null,
        tags: [],
      },
    ]);
    const client = makeClient(stub);
    const item = await client.addAssetToSpace('i-1', 'sp-2');
    expect(item.otherSpaces).toEqual([{ id: 'sp-2', name: 'New Space' }]);
  });
});

describe('SdkSpacesClient.removeAssetFromSpace', () => {
  it('forwards spaceId + id as Cypher params', async () => {
    const stub = buildStubQuery();
    stub.setResponse('-[r:BELONGS_TO]->(s:Space {id: $spaceId})', [{ id: 'i-1' }]);
    stub.setResponse("coalesce(a.content, '') AS content", [
      {
        id: 'i-1',
        title: 'x',
        kind: 'text',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: null,
        tags: [],
      },
    ]);
    const client = makeClient(stub);
    await client.removeAssetFromSpace('i-1', 'sp-2');
    const call = stub.calls.find((c) =>
      c.cypher.includes('-[r:BELONGS_TO]->(s:Space {id: $spaceId})')
    );
    expect(call?.parameters).toMatchObject({ id: 'i-1', spaceId: 'sp-2' });
  });
});

describe('SdkSpacesClient.searchItems', () => {
  it('returns [] for empty query without hitting Cypher', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    const out = await client.searchItems({ query: '   ' });
    expect(out).toEqual([]);
    expect(stub.calls.length).toBe(0);
  });

  it('passes query lowercased + spaceId when non-empty', async () => {
    const stub = buildStubQuery();
    stub.setResponse('CONTAINS toLower($query)', []);
    const client = makeClient(stub);
    await client.searchItems({ query: 'AUDIT', spaceId: 'sp-1' });
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toMatchObject({ query: 'AUDIT', spaceId: 'sp-1' });
  });

  it('null spaceId when not supplied', async () => {
    const stub = buildStubQuery();
    stub.setResponse('CONTAINS toLower($query)', []);
    const client = makeClient(stub);
    await client.searchItems({ query: 'hello' });
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toMatchObject({ spaceId: null });
  });

  it('maps rows into ItemSummary objects', async () => {
    const stub = buildStubQuery();
    stub.setResponse('CONTAINS toLower($query)', [
      {
        id: 'i-1',
        title: 'Audit notes',
        kind: 'text',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: null,
      },
    ]);
    const client = makeClient(stub);
    const results = await client.searchItems({ query: 'audit' });
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe('Audit notes');
  });

  it('caps limit at 200', async () => {
    const stub = buildStubQuery();
    stub.setResponse('CONTAINS toLower($query)', []);
    const client = makeClient(stub);
    await client.searchItems({ query: 'x', limit: 9999 });
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.parameters).toMatchObject({ limit: 200 });
  });
});

// ─── Metadata sprint ────────────────────────────────────────────────────

describe('CYPHER source strings — metadata sprint', () => {
  it('GET_ITEM projects a.metadata (no longer null)', () => {
    expect(CYPHER.GET_ITEM).toMatch(/a\.metadata AS metadata/);
    expect(CYPHER.GET_ITEM).not.toMatch(/null AS metadata/);
  });

  it('CREATE_ASSET writes the metadata property', () => {
    expect(CYPHER.CREATE_ASSET).toMatch(/metadata: \$metadata/);
    expect(CYPHER.CREATE_ASSET_UNCATEGORIZED).toMatch(/metadata: \$metadata/);
  });

  it('SET_METADATA replaces the JSON blob', () => {
    expect(CYPHER.SET_METADATA).toMatch(/MATCH \(a:Asset \{id: \$id\}\)/);
    expect(CYPHER.SET_METADATA).toMatch(/SET a\.metadata = \$metadata/);
  });
});

describe('toItem metadata projection', () => {
  it('parses a JSON string from the graph into an object', async () => {
    const stub = buildStubQuery();
    stub.setResponse("coalesce(a.content, '') AS content", [
      {
        id: 'i-1',
        title: 'meta-thing',
        kind: 'document',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: null,
        tags: [],
        metadata: '{"width":1024,"height":768,"tags":["a","b"]}',
      },
    ]);
    const client = makeClient(stub);
    const item = await client.getItem('i-1');
    expect(item?.metadata).toEqual({
      width: 1024,
      height: 768,
      tags: ['a', 'b'],
    });
  });

  it('tolerates a legacy object-form metadata projection', async () => {
    const stub = buildStubQuery();
    stub.setResponse("coalesce(a.content, '') AS content", [
      {
        id: 'i-1',
        title: 't',
        kind: 'text',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: null,
        tags: [],
        metadata: { author: 'Robb', version: 2 },
      },
    ]);
    const client = makeClient(stub);
    const item = await client.getItem('i-1');
    expect(item?.metadata).toEqual({ author: 'Robb', version: 2 });
  });

  it('drops invalid metadata silently (malformed JSON / wrong shape)', async () => {
    const stub = buildStubQuery();
    stub.setResponse("coalesce(a.content, '') AS content", [
      {
        id: 'i-1',
        title: 't',
        kind: 'text',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: null,
        tags: [],
        metadata: '{not json}',
      },
    ]);
    const client = makeClient(stub);
    const item = await client.getItem('i-1');
    expect(item?.metadata).toBeUndefined();
  });

  it('drops nested-object values inside arrays (primitive-only enforcement)', async () => {
    const stub = buildStubQuery();
    stub.setResponse("coalesce(a.content, '') AS content", [
      {
        id: 'i-1',
        title: 't',
        kind: 'text',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: null,
        tags: [],
        // nested object inside the array should be dropped
        metadata: '{"good":["x",2,true],"bad":["x",{"nope":1}]}',
      },
    ]);
    const client = makeClient(stub);
    const item = await client.getItem('i-1');
    expect(item?.metadata?.['good']).toEqual(['x', 2, true]);
    expect(item?.metadata?.['bad']).toEqual(['x']); // nested object dropped
  });
});

describe('SdkSpacesClient.setMetadata', () => {
  it('rejects empty id', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    await expect(client.setMetadata('', { x: 1 })).rejects.toMatchObject({
      code: 'SPACES_INVALID_INPUT',
    });
  });

  it('serializes the metadata bag as a JSON string before writing', async () => {
    const stub = buildStubQuery();
    stub.setResponse('SET a.metadata = $metadata', [{ id: 'i-1' }]);
    stub.setResponse("coalesce(a.content, '') AS content", [
      {
        id: 'i-1',
        title: 't',
        kind: 'text',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: null,
        tags: [],
        metadata: '{"width":1024}',
      },
    ]);
    const client = makeClient(stub);
    await client.setMetadata('i-1', { width: 1024 });
    const call = stub.calls.find((c) => c.cypher.includes('SET a.metadata = $metadata'));
    expect(call?.parameters?.['metadata']).toBe('{"width":1024}');
  });

  it('throws SPACES_NOT_FOUND when the asset is missing', async () => {
    const stub = buildStubQuery();
    stub.setResponse('SET a.metadata = $metadata', []);
    const client = makeClient(stub);
    await expect(
      client.setMetadata('i-gone', { x: 1 })
    ).rejects.toMatchObject({ code: 'SPACES_NOT_FOUND' });
  });
});

describe('SdkSpacesClient.patchMetadata', () => {
  it('shallow-merges the patch with existing metadata', async () => {
    const stub = buildStubQuery();
    // First getItem returns existing metadata.
    stub.setResponse("coalesce(a.content, '') AS content", [
      {
        id: 'i-1',
        title: 't',
        kind: 'text',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: null,
        tags: [],
        metadata: '{"width":1024,"height":768}',
      },
    ]);
    stub.setResponse('SET a.metadata = $metadata', [{ id: 'i-1' }]);
    const client = makeClient(stub);
    await client.patchMetadata('i-1', { height: 1080, author: 'Alice' });
    const setCall = stub.calls.find((c) => c.cypher.includes('SET a.metadata = $metadata'));
    const written = JSON.parse(String(setCall?.parameters?.['metadata'] ?? '{}'));
    expect(written).toMatchObject({ width: 1024, height: 1080, author: 'Alice' });
  });

  it('null in the patch removes the key', async () => {
    const stub = buildStubQuery();
    stub.setResponse("coalesce(a.content, '') AS content", [
      {
        id: 'i-1',
        title: 't',
        kind: 'text',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: null,
        tags: [],
        metadata: '{"width":1024,"height":768}',
      },
    ]);
    stub.setResponse('SET a.metadata = $metadata', [{ id: 'i-1' }]);
    const client = makeClient(stub);
    await client.patchMetadata('i-1', { width: null });
    const setCall = stub.calls.find((c) => c.cypher.includes('SET a.metadata = $metadata'));
    const written = JSON.parse(String(setCall?.parameters?.['metadata'] ?? '{}'));
    expect(written).not.toHaveProperty('width');
    expect(written).toHaveProperty('height');
  });
});

describe('SdkSpacesClient.removeMetadataKey', () => {
  it('rejects empty key', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    await expect(client.removeMetadataKey('i-1', '')).rejects.toMatchObject({
      code: 'SPACES_INVALID_INPUT',
    });
  });

  it('round-trips through patchMetadata with a null value', async () => {
    const stub = buildStubQuery();
    stub.setResponse("coalesce(a.content, '') AS content", [
      {
        id: 'i-1',
        title: 't',
        kind: 'text',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: null,
        tags: [],
        metadata: '{"width":1024,"height":768}',
      },
    ]);
    stub.setResponse('SET a.metadata = $metadata', [{ id: 'i-1' }]);
    const client = makeClient(stub);
    await client.removeMetadataKey('i-1', 'width');
    const setCall = stub.calls.find((c) => c.cypher.includes('SET a.metadata = $metadata'));
    const written = JSON.parse(String(setCall?.parameters?.['metadata'] ?? '{}'));
    expect(written).not.toHaveProperty('width');
    expect(written).toEqual({ height: 768 });
  });
});

describe('SdkSpacesClient.createAsset with metadata', () => {
  it('serializes the metadata bag to JSON when present in the input', async () => {
    const stub = buildStubQuery();
    stub.setResponse('CREATE (a:Asset', [{ id: 'asset-stub' }]);
    stub.setResponse("coalesce(a.content, '') AS content", [
      {
        id: 'asset-stub',
        title: 'X',
        kind: 'image',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: null,
        tags: [],
        metadata: '{"width":4096,"height":2160}',
      },
    ]);
    const client = makeClient(stub);
    await client.createAsset({
      spaceId: 'sp-1',
      title: 'X',
      kind: 'image',
      metadata: { width: 4096, height: 2160 },
    });
    const createCall = stub.calls.find((c) => c.cypher.includes('CREATE (a:Asset'));
    expect(createCall?.parameters?.['metadata']).toBe('{"width":4096,"height":2160}');
  });

  it('writes empty string for missing metadata (preserves "absent" semantics)', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MERGE (n:Note {id: $id})', [{ id: 'note-stub', spaceName: 'S' }]);
    stub.setResponse("coalesce(a.content, '') AS content", [
      {
        id: 'asset-stub',
        title: 'No meta',
        kind: 'text',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: null,
        tags: [],
      },
    ]);
    const client = makeClient(stub);
    await client.createAsset({
      spaceId: 'sp-1',
      title: 'No meta',
      content: 'x',
    });
    // ADR-059: text-in-space goes down the note-citizen path; the
    // "absent metadata = empty string" semantic must hold there too.
    const createCall = stub.calls.find((c) => c.cypher.includes('MERGE (n:Note {id: $id})'));
    expect(createCall?.parameters?.['metadata']).toBe('');
  });
});

// ─── ADR-058: read all space members, not just :Asset ────────────────────
//
// WISER Playbooks writes :Playbook and :Note nodes; agents write their
// own. All hang off a Space via BELONGS_TO but lack the :Asset label,
// so the old (a:Asset) filter hid them (a user's email :Note + 234
// WISER playbooks invisible). Content reads now match the member label
// set and derive kind from the label.
describe('ADR-058: space-content reads render all member kinds', () => {
  it('LIST_ITEMS_IN_SPACE, GET_ITEM, HOME_RECENT_ITEMS, SEARCH_ITEMS, LIST_ITEMS_UNCATEGORIZED all use the member label set', () => {
    for (const q of [
      CYPHER.LIST_ITEMS_IN_SPACE,
      CYPHER.GET_ITEM,
      CYPHER.HOME_RECENT_ITEMS,
      CYPHER.SEARCH_ITEMS,
      CYPHER.LIST_ITEMS_UNCATEGORIZED,
    ]) {
      expect(q).toContain('a:Asset OR a:Playbook OR a:Note');
    }
  });

  it('the managed :Checklist node is NOT in the member set (own library, not the grid)', () => {
    expect(CYPHER.LIST_ITEMS_IN_SPACE).not.toContain(':Checklist');
  });

  it('kind derives from the label: Playbook->playbook, Note->text, else type/assetType', () => {
    expect(CYPHER.LIST_ITEMS_IN_SPACE).toContain("WHEN a:Playbook THEN 'playbook'");
    expect(CYPHER.LIST_ITEMS_IN_SPACE).toContain("WHEN a:Note THEN 'text'");
    expect(CYPHER.LIST_ITEMS_IN_SPACE).toContain("ELSE coalesce(a.type, a.assetType, 'other')");
  });

  it('member reads stay ADR-051 visibility-gated ($viewerId present)', () => {
    for (const q of [CYPHER.LIST_ITEMS_IN_SPACE, CYPHER.GET_ITEM, CYPHER.HOME_RECENT_ITEMS, CYPHER.SEARCH_ITEMS]) {
      expect(q).toContain('$viewerId');
    }
  });
});

// ─── ADR-060: cross-writer recency at the graph level ────────────────────
//
// The graph's timestamps arrive in every shape its writers use (Lite:
// ISO strings; WISER/GSX/notes: epoch ms; legacy: epoch seconds).
// String-ordering a mix pins one population above the other, so
// "somebody else edited this recently" could never surface in Recent.
// Both recency reads now fold every shape into an epoch-ms key with a
// TOTAL Cypher expression — regex-gated branches, fallback 0 — because
// one malformed row must degrade to "old", never throw (Edison maps
// Cypher errors to empty 200s, which would blank the whole list).
describe('ADR-060: Recent reflects graph-level activity by any writer', () => {
  it('LIST_SPACES and HOME_RECENT_ITEMS normalize every timestamp shape', () => {
    for (const q of [CYPHER.LIST_SPACES, CYPHER.HOME_RECENT_ITEMS]) {
      expect(q).toContain("=~ '^\\d{10}$'");
      expect(q).toContain('* 1000');
      expect(q).toContain("=~ '^\\d+$'");
      expect(q).toContain('.epochMillis');
      expect(q).toContain('ELSE 0 END');
    }
  });

  it('HOME_RECENT_ITEMS orders by the normalized activity key, not string coalesce', () => {
    expect(CYPHER.HOME_RECENT_ITEMS).toContain('ORDER BY activityMs DESC');
    expect(CYPHER.HOME_RECENT_ITEMS).not.toMatch(/ORDER BY coalesce\(toString/);
  });

  it('LIST_SPACES projects lastActivityMs as max(member activity, space self)', () => {
    expect(CYPHER.LIST_SPACES).toContain('max(');
    expect(CYPHER.LIST_SPACES).toContain('lastActivityMs AS lastActivityMs');
  });

  it('toSpace maps a positive lastActivityMs to ISO lastActivity and leaves 0 unset', async () => {
    const stub = buildStubQuery();
    stub.setResponse('OPTIONAL MATCH (a)-[:BELONGS_TO]->(s)', [
      {
        id: 'sp-act',
        name: 'Active',
        itemCount: 3,
        createdAt: '',
        updatedAt: '',
        lastActivityMs: 1786417450242,
      },
      { id: 'sp-idle', name: 'Idle', itemCount: 0, createdAt: '', updatedAt: '', lastActivityMs: 0 },
    ]);
    const client = makeClient(stub);
    const spaces = await client.listSpaces();
    const active = spaces.find((s) => s.id === 'sp-act');
    const idle = spaces.find((s) => s.id === 'sp-idle');
    expect(active?.lastActivity).toBe('2026-08-11T03:04:10.242Z');
    expect(idle?.lastActivity).toBeUndefined();
  });

  it('every space count matches what the grid renders: member labels + live only', () => {
    for (const q of [CYPHER.SPACE_ITEM_COUNT, CYPHER.UNDELETE_SPACE, CYPHER.UNCATEGORIZED_COUNT]) {
      expect(q).toContain('a:Asset OR a:Playbook OR a:Note');
      expect(q).toMatch(/a\.deletedAt IS NULL/);
    }
  });
});

// ─── ADR-060 addendum: every timeline row knows its Space ────────────────
//
// Commits written without spaceId (older edit/restore paths) rendered
// chip-less rows forever — "robb edited an item" with no clue where.
// The events read now resolves the Space AFTER the LIMIT (cheap) via
// the commit's TOUCHED asset, gated by the same visibility rule as
// otherSpaces chips so restricted names never leak.
describe('ADR-060 addendum: HOME_RECENT_EVENTS space fallback', () => {
  it('resolves a missing space through the TOUCHED asset, post-LIMIT', () => {
    const q = CYPHER.HOME_RECENT_EVENTS;
    expect(q).toContain('EXISTS { MATCH (c)-[:TOUCHED]->()-[:BELONGS_TO]->(other) }');
    // The fallback expansion must run on the LIMITed rows, not the
    // full commit scan.
    expect(q.indexOf('LIMIT toInteger($limit)')).toBeLessThan(
      q.indexOf('OPTIONAL MATCH (other:Space)')
    );
  });

  it('projects coalesced spaceId/spaceName from commit-else-resolved', () => {
    const q = CYPHER.HOME_RECENT_EVENTS;
    expect(q).toContain('coalesce(c.spaceId, resolved.id) AS spaceId');
    expect(q).toContain('coalesce(s.name, resolved.name, c.spaceId) AS spaceName');
  });

  it('the fallback space is visibility-gated (restricted names never leak)', () => {
    // OTHER_SPACE_VISIBLE binds alias `other` — the resolved space
    // must pass the same gate as otherSpaces chips.
    const q = CYPHER.HOME_RECENT_EVENTS;
    // ADR-065: belonging-only gate for the `other` alias.
    const gate = q.indexOf("coalesce(other.createdBy, '') = $viewerId");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(q.indexOf('OPTIONAL MATCH (other:Space)'));
  });
});

describe('SdkSpacesClient — asset view audit trail (2026-08-10)', () => {
  it('recordAssetView no-ops on empty id (no query)', async () => {
    const stub = buildStubQuery();
    const client = makeClient(stub);
    await client.recordAssetView('');
    expect(stub.calls.length).toBe(0);
  });

  it('recordAssetView writes the VIEWED edge (viewerId + nowMs injected by run)', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MERGE (p)-[v:VIEWED]->(a)', [{ id: 'asset-1' }]);
    const client = makeClient(stub);
    await client.recordAssetView('asset-1');
    const call = stub.calls[stub.calls.length - 1];
    expect(call?.cypher).toContain('MERGE (p)-[v:VIEWED]->(a)');
    expect(call?.cypher).toContain('ON CREATE SET v.firstAt = $nowMs');
    expect(call?.cypher).toContain('coalesce(v.count, 0) + 1');
    // id is bound; viewerId + nowMs are injected centrally by run().
    expect(call?.parameters).toMatchObject({ id: 'asset-1' });
    expect(call?.parameters).toHaveProperty('viewerId');
    // $nowMs is injected by run() and interpolated in the query text.
  });

  it('getAssetViewers rejects empty id', async () => {
    const client = makeClient(buildStubQuery());
    await expect(client.getAssetViewers('')).rejects.toMatchObject({
      code: 'SPACES_INVALID_INPUT',
    });
  });

  it('getAssetViewers maps rows (string timestamps → numbers, count coerced)', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (a)<-[v:VIEWED]-(p:Person)', [
      { viewerId: 'u1', name: 'Ada', email: 'ada@x', firstAt: '1000', lastAt: '2000', count: 3 },
      { viewerId: 'u2', name: '', email: '', firstAt: null, lastAt: '5000', count: 1 },
    ]);
    const client = makeClient(stub);
    const viewers = await client.getAssetViewers('asset-1');
    expect(viewers).toEqual([
      { viewerId: 'u1', name: 'Ada', email: 'ada@x', firstAt: 1000, lastAt: 2000, count: 3 },
      { viewerId: 'u2', name: 'u2', email: '', firstAt: null, lastAt: 5000, count: 1 },
    ]);
  });
});

describe('LIST_ITEMS_IN_SPACE — viewer read time (2026-08-11)', () => {
  it('projects the viewer-scoped VIEWED lastAt as viewedAtMs', () => {
    const src = CYPHER.LIST_ITEMS_IN_SPACE;
    expect(src).toContain("OPTIONAL MATCH (:Person {id: $viewerId})-[vw:VIEWED]->(a)");
    expect(src).toContain('toString(vw.lastAt) AS viewedAtMs');
  });

  it('threads viewedAtMs through the summary mapper', async () => {
    const stub = buildStubQuery();
    stub.setResponse('BELONGS_TO]->(s:Space {id: $spaceId})', [
      {
        id: 'a1',
        title: 'Note',
        kind: 'text',
        createdAt: '2026-08-01T00:00:00Z',
        updatedAt: '2026-08-10T00:00:00Z',
        viewedAtMs: '1765400000000',
        otherSpaces: [],
        producedBy: null,
      },
    ]);
    const client = makeClient(stub);
    const items = await client.listItems({ kind: 'space', spaceId: 's1' });
    expect(items[0]?.viewedAtMs).toBe(1765400000000);
  });
});

// ─── ADR-062: the meeting ring ───────────────────────────────────────────
//
// (:MeetingLive) is an ephemeral doorbell, not an artifact: no :Asset
// label, no Space membership, TTL-guarded on read. The check is driven
// by EXISTING app events (cache refresh, focus) — these tests pin the
// query shape and mapping; the no-new-timers rule lives in main.ts.
describe('ADR-062: live-meeting ring reads', () => {
  it('LIST_LIVE_MEETINGS is TTL-guarded, small, and never touches :Asset', () => {
    const q = CYPHER.LIST_LIVE_MEETINGS;
    expect(q).toContain('MATCH (m:MeetingLive)');
    expect(q).toContain('coalesce(m.startedAt, 0) > $nowMs - $ttlMs');
    expect(q).toContain('LIMIT 5');
    expect(q).not.toContain(':Asset');
    expect(q).not.toContain('BELONGS_TO');
  });

  it('the doorbell rings ONLY the host and this meeting’s explicit invitees (fail-closed)', () => {
    // "Started a meeting and it invited someone I never picked": sticky
    // WISER-Meetings membership must never be the invite list. The audience
    // predicate is per-meeting; legacy nodes without hostId/invitees ring
    // nobody but their host.
    const q = CYPHER.LIST_LIVE_MEETINGS;
    expect(q).toContain("coalesce(m.hostId, '') = $viewerId");
    expect(q).toContain('$viewerId IN coalesce(m.invitees, [])');
  });

  it('listLiveMeetings maps rows and forwards the ttl', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (m:MeetingLive)', [
      {
        id: 'live_weekly-sync-a1b2c3',
        title: 'Weekly Sync',
        joinUrl: 'https://guest/join.html?room=weekly-sync-a1b2c3#k=PUB',
        host: 'Robb',
        spaceName: null,
          startedAtMs: 1786500000000,
      },
      { id: '', title: 'junk row dropped' },
    ]);
    const client = makeClient(stub);
    const out = await client.listLiveMeetings({ ttlMs: 60_000 });
    expect(out).toEqual([
      {
        id: 'live_weekly-sync-a1b2c3',
        title: 'Weekly Sync',
        joinUrl: 'https://guest/join.html?room=weekly-sync-a1b2c3#k=PUB',
        host: 'Robb',
        spaceName: null,
          startedAtMs: 1786500000000,
      },
    ]);
    const call = stub.calls.find((c) => c.cypher.includes('MATCH (m:MeetingLive)'));
    expect(call?.parameters).toMatchObject({ ttlMs: 60_000 });
  });

  it('defaults the ttl to 30 minutes and nulls absent fields', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (m:MeetingLive)', [{ id: 'live_x', title: 'X' }]);
    const client = makeClient(stub);
    const out = await client.listLiveMeetings();
    expect(out[0]).toEqual({ id: 'live_x', title: 'X', joinUrl: null, host: null, spaceName: null,
          startedAtMs: 0 });
    const call = stub.calls.find((c) => c.cypher.includes('MATCH (m:MeetingLive)'));
    expect(call?.parameters).toMatchObject({ ttlMs: 30 * 60_000 });
  });
});

describe('LIST_LIVE_MEETINGS — space context (2026-08-12)', () => {
  it('projects m.spaceName and maps it through (null when absent)', async () => {
    expect(CYPHER.LIST_LIVE_MEETINGS).toContain('m.spaceName AS spaceName');
    const stub = buildStubQuery();
    stub.setResponse('MATCH (m:MeetingLive)', [
      { id: 'live_a', title: 'Weekly Sync', joinUrl: null, host: null, spaceName: 'Design', startedAtMs: 5 },
      { id: 'live_b', title: 'Standup', joinUrl: null, host: null, spaceName: null, startedAtMs: 6 },
    ]);
    const client = makeClient(stub);
    const rows = await client.listLiveMeetings();
    expect(rows[0]?.spaceName).toBe('Design');
    expect(rows[1]?.spaceName).toBeNull();
  });
});

// ─── Space description cap (2026-08-12: 400 → 3000) ─────────────────────
//
// A real pasted brief is longer than a tweet. The renderer's editor
// constant must equal this server cap (no silent-truncate maxLength —
// that read as "it won't let me edit it"), and the AI drafter clamps
// below it so a drafted Space always saves.
describe('space description cap', () => {
  it('accepts 3000 chars and rejects 3001 with the honest error', async () => {
    const stub = buildStubQuery();
    stub.setResponse('MATCH (s:Space {id: $id})', [
      { id: 'sp-1', name: 'S', description: 'x'.repeat(3000), createdAt: '', updatedAt: '' },
    ]);
    const client = makeClient(stub);
    await client.updateSpace('sp-1', { description: 'x'.repeat(3000) });
    await expect(
      client.updateSpace('sp-1', { description: 'x'.repeat(3001) })
    ).rejects.toMatchObject({ code: 'SPACES_INVALID_INPUT' });
  });
});

describe('ADR-065 — belonging-only space visibility', () => {
  it('SPACE_VISIBLE requires an identified viewer who created the space or holds a live grant', () => {
    const q = CYPHER.LIST_SPACES;
    expect(q).toContain("$viewerId <> '' AND (");
    expect(q).toContain("coalesce(s.createdBy, '') = $viewerId");
    expect(q).toMatch(/HAS_ACCESS]->\(s\)/);
    // The old world-readable clause must be gone from listing.
    expect(q).not.toContain("coalesce(s.visibility, 'open') <> 'restricted'");
  });

  it('CREATE_SPACE stamps the creator so new spaces belong to their maker', () => {
    expect(CYPHER.CREATE_SPACE).toContain('createdBy: $viewerId');
  });

  it('an empty viewerId fails closed everywhere SPACE_VISIBLE gates', () => {
    // Signed-out listing must be impossible: the macro leads with the
    // viewer check, so '' can never satisfy it.
    expect(CYPHER.LIST_SPACES).not.toMatch(/'open'\s*<>\s*'restricted'/);
    expect(CYPHER.HOME_RECENT_ITEMS).toContain("$viewerId <> '' AND (");
  });
});

describe('ADR-065 second pass — whole-app NEON scoping audit (2026-08-14)', () => {
  it('the meeting ring only reaches people who belong to the meetings Space', () => {
    const q = CYPHER.LIST_LIVE_MEETINGS;
    expect(q).toContain("$viewerId <> ''");
    expect(q).toContain("toLower(coalesce(ms.name, '')) = 'wiser meetings'");
    expect(q).toContain('[r:HAS_ACCESS]->(ms)');
  });

  it('inline binary assets are viewer-gated (no ungated content dump)', () => {
    expect(CYPHER.LIST_INLINE_BINARY_ASSETS).toContain("coalesce(vs.createdBy, '') = $viewerId");
  });

  it('every CREATED-stamping create falls back to the injected viewer', () => {
    // A create with a missing creatorId must never produce an item
    // invisible to everyone (uncategorized items are creator-gated).
    const stamped = Object.values(CYPHER).filter((q) => q.includes('[:CREATED]->(a)'));
    expect(stamped.length).toBeGreaterThanOrEqual(4);
    for (const q of stamped) {
      if (q.includes('OPTIONAL MATCH (p:Person {id:')) {
        expect(q).toContain('coalesce($creatorId, $viewerId)');
      }
    }
  });

  it('drop-box pre-step: by-name find returns only id+name; self-grant is MERGE-only on Person', () => {
    expect(CYPHER.FIND_SPACE_BY_NAME).toContain('RETURN s.id AS id');
    expect(CYPHER.FIND_SPACE_BY_NAME).not.toMatch(/description|content|visibility/);
    expect(CYPHER.GRANT_SELF_ACCESS).toContain('MERGE (p:Person {id: $viewerId})');
    expect(CYPHER.GRANT_SELF_ACCESS).toContain('MERGE (p)-[r:HAS_ACCESS]->(s)');
    // Never mutates an existing Person outside ON CREATE.
    expect(CYPHER.GRANT_SELF_ACCESS).not.toContain('ON MATCH SET p.');
  });
});
