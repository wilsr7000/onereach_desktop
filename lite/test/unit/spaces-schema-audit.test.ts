/**
 * ADR-083 / ADR-084 — the NEON schema audit's code-side decisions, pinned.
 *
 * ADR-083 had made sight follow the other writers' [:OWNS] edge, read as
 * per-Space membership. ADR-084 (2026-09-02) reverses that: the live
 * graph stamps OWNS on EVERY Space for EVERY account member (robb 102 of
 * 109, Rich 99 of 109, bulk-created the day each signed in), so honoring
 * it meant everyone saw everything — and it shipped in 0.0.79. Sight is
 * now EXPLICIT PERMISSION ONLY: the viewer created the Space (Lite's
 * `createdBy` or the Playbooks writer's `created_by_user`) or holds a
 * live [:HAS_ACCESS] grant. OWNS appears in no predicate, and the first
 * block below fails the build if it ever comes back.
 *
 * Two smaller contracts stay from ADR-083: GSX-Desktop's `private`
 * visibility reads as restricted (it read as OPEN), and Lite documents
 * its slice of the model in the registry without touching what other
 * writers own.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { CYPHER, SdkSpacesClient } from '../../spaces/sdk-client.js';

const sdkSource = (): string => {
  const found = ['spaces/sdk-client.ts', 'lite/spaces/sdk-client.ts']
    .map((p) => resolve(p))
    .find((p) => existsSync(p));
  if (found === undefined) throw new Error('sdk-client.ts not found');
  return readFileSync(found, 'utf8');
};

describe('sight is explicit permission only (ADR-084)', () => {
  it('[:OWNS] appears in NO runtime query — membership is not permission', () => {
    // Evaluated on the REAL exported strings — a source-only check would
    // have passed the 0.0.77 invisible-byte outage.
    const offenders = Object.entries(CYPHER)
      .filter(([, q]) => typeof q === 'string' && /\[:OWNS\]/.test(q))
      .map(([name]) => name);
    expect(offenders, 'a query still reads [:OWNS] as access').toEqual([]);
  });

  it('every visibility predicate is exactly: creator (either writer stamp) OR a live HAS_ACCESS grant — or, ADR-085, an opted-in nested chain up to a parent with that standing', () => {
    const s = sdkSource();
    for (const [name, alias] of [
      ['SPACE_VISIBLE', 's'],
      ['OTHER_SPACE_VISIBLE', 'other'],
      ['ASSET_VISIBLE', 'vs'],
    ] as const) {
      const i = s.indexOf(`const ${name} = \``);
      expect(i, `${name} missing`).toBeGreaterThan(-1);
      const body = s.slice(i, s.indexOf('`;', i));
      expect(body, `${name}: Lite creator stamp`).toContain(`coalesce(${alias}.createdBy, '') = $viewerId`);
      expect(body, `${name}: Playbooks creator stamp`).toContain(`coalesce(${alias}.created_by_user, '') = $viewerId`);
      expect(body, `${name}: explicit grant`).toContain(`HAS_ACCESS]->(${alias})`);
      expect(body, `${name}: nothing inferred`).not.toMatch(/OWNS|visibility|open/);
      expect(body, `${name}: ADR-085 nested sight (opt-in only)`).toContain('NESTED_SIGHT(');
    }
  });

  it('ADR-085: nested sight/write is a per-edge OPT-IN, bounded, broken by a deleted Space, and evaluates the PARENT explicitly', () => {
    const s = sdkSource();
    for (const name of ['NESTED_SIGHT', 'NESTED_WRITE'] as const) {
      const i = s.indexOf(`const ${name} = (alias: string): string => \``);
      expect(i, `${name} missing`).toBeGreaterThan(-1);
      const body = s.slice(i, s.indexOf('`;', i));
      expect(body, `${name}: opt-in flag on EVERY edge of the chain`).toContain('all(e IN relationships(nest_${alias}) WHERE e.inheritsPermissions = true');
      expect(body, `${name}: bounded`).toContain('[:NESTED_IN*1..6]');
      expect(body, `${name}: the opt-in may lapse (TTL, like a grant)`).toContain('(e.inheritsUntilUnixMs IS NULL OR e.inheritsUntilUnixMs > $nowMs)');
      expect(body, `${name}: a deleted Space breaks the chain`).toContain('all(n IN nodes(nest_${alias}) WHERE n.deletedAt IS NULL)');
      expect(body, `${name}: parent creator (Lite)`).toContain("coalesce(top_${alias}.createdBy, '') = $viewerId");
      expect(body, `${name}: parent creator (Playbooks)`).toContain("coalesce(top_${alias}.created_by_user, '') = $viewerId");
      expect(body, `${name}: parent live grant`).toContain('HAS_ACCESS]->(top_${alias})');
      expect(body, `${name}: nothing inferred`).not.toMatch(/OWNS|visibility|open/);
    }
    const w = s.slice(s.indexOf('const NESTED_WRITE'), s.indexOf('`;', s.indexOf('const NESTED_WRITE')));
    expect(w, 'a reader on the parent cannot write the child').toContain("<> 'reader'");
    for (const name of ['SPACE_WRITABLE', 'ASSET_WRITABLE'] as const) {
      const i = s.indexOf(`const ${name} = \``);
      expect(s.slice(i, s.indexOf('`;', i)), `${name}: ADR-085 nested write`).toContain('NESTED_WRITE(');
    }
  });

  it('the creator by EITHER stamp may write; a grant writes unless it is a reader', () => {
    const s = sdkSource();
    for (const [name, alias] of [
      ['SPACE_WRITABLE', 's'],
      ['ASSET_WRITABLE', 'ws'],
    ] as const) {
      const i = s.indexOf(`const ${name} = \``);
      const body = s.slice(i, s.indexOf('`;', i));
      expect(body, `${name}: Lite creator`).toContain(`coalesce(${alias}.createdBy, '') = $viewerId`);
      expect(body, `${name}: Playbooks creator`).toContain(`coalesce(${alias}.created_by_user, '') = $viewerId`);
      expect(body, `${name}: reader cannot write`).toContain("<> 'reader'");
      expect(body).not.toContain('OWNS');
    }
  });

  it('ASSET_WRITABLE keeps the "own uncategorized note" branch (created it, in no Space)', () => {
    const s = sdkSource();
    const i = s.indexOf('const ASSET_WRITABLE = `');
    expect(s.slice(i, s.indexOf('`;', i))).toContain('[:CREATED]->(a)');
  });

  it('the live-meetings audience uses the same two signals (OR Mobile mirrors this WHERE — keep them in step)', () => {
    expect(CYPHER.LIST_LIVE_MEETINGS).toContain("coalesce(ms.created_by_user, '') = $viewerId");
    expect(CYPHER.LIST_LIVE_MEETINGS).toContain('HAS_ACCESS]->(ms)');
    expect(CYPHER.LIST_LIVE_MEETINGS).not.toContain('OWNS');
  });

  it('the agent catalog respects asset permissions: directory entries stay, represented agents follow their asset', () => {
    // A Lite-built agent's name/description come from the asset that
    // [:REPRESENTS] it; an agent built in a restricted Space must not
    // describe itself to every member (2026-09-02, with onereach-app-d5).
    for (const [name, alias] of [
      ['HOME_AGENTS_SAMPLE', 'a'],
      ['AGENT_LIBRARY_SEARCH', 'g'],
    ] as const) {
      const q = CYPHER[name];
      expect(q, `${name}: directory entries (no representing asset) stay visible`).toContain(
        `NOT EXISTS { MATCH (:Asset)-[:REPRESENTS]->(${alias}) }`
      );
      expect(q, `${name}: a represented agent follows its asset's Space`).toContain('MATCH (rep)-[:BELONGS_TO]->(s:Space)');
      expect(q, `${name}: uses the explicit-only Space predicate`).toContain("coalesce(s.created_by_user, '') = $viewerId");
      expect(q).not.toContain('OWNS');
    }
  });

  it('the registry tells other writers the rule, in the same words', () => {
    const q = CYPHER.ENSURE_LITE_SCHEMA_ANNOTATIONS;
    expect(q).toContain('NOT permission (ADR-084)');
    expect(q, 'the nesting edge and its opt-in are documented for other writers').toContain('NESTED_IN');
    expect(q).toContain('ADR-085');
    expect(q).toContain('created_by_user');
  });
});

describe("GSX-Desktop's `private` reads as restricted", () => {
  it('a private Space never presents as open', async () => {
    const client = new SdkSpacesClient({
      query: (cypher: string): Promise<Array<Record<string, unknown>>> =>
        Promise.resolve(
          cypher.includes('MATCH (s:Space)')
            ? [
                { id: 'sp-1', name: 'KEYS', visibility: 'private', kind: 'user', itemCount: 0 },
                { id: 'sp-2', name: 'Open', visibility: 'open', kind: 'user', itemCount: 0 },
                { id: 'sp-3', name: 'Legacy', visibility: 'team', kind: 'user', itemCount: 0 },
              ]
            : []
        ),
      viewerId: () => 'robb@onereach.com',
    });
    const spaces = await client.listSpaces();
    const by = new Map(spaces.map((s) => [s.id, s.visibility]));
    expect(by.get('sp-1')).toBe('restricted'); // private → restricted
    expect(by.get('sp-2')).toBe('open');
    expect(by.get('sp-3')).toBeUndefined(); // team/org/public: renderer default (open)
  });
});

describe('registry annotations', () => {
  it('write only lite_* keys — never another writer\'s properties_def', () => {
    const q = CYPHER.ENSURE_LITE_SCHEMA_ANNOTATIONS;
    const setKeys = [...q.matchAll(/SET\s+[a-z]+\.([a-zA-Z_]+)\s*=/g)].map((m) => m[1] as string);
    const continuationKeys = [...q.matchAll(/,\s*[a-z]+\.([a-zA-Z_]+)\s*=/g)].map((m) => m[1] as string);
    const all = [...setKeys, ...continuationKeys];
    expect(all.length).toBeGreaterThanOrEqual(8);
    for (const k of all) expect(k, `non-namespaced registry key: ${k}`).toMatch(/^lite_/);
    // Other writers' documentation keys are never assigned — only
    // lite-namespaced ones (lite_relationships is ours).
    expect(q).not.toMatch(/\.(properties_def|relationships|description|version)\s*=/);
  });

  it('documents the ten relationship types the registry never mentioned, plus OWNS', () => {
    const q = CYPHER.ENSURE_LITE_SCHEMA_ANNOTATIONS;
    for (const rel of [
      'CURRENT_PLAYBOOK', 'PINNED', 'VIEWED', 'LAST_EDITED', 'TOUCHED', 'TAGGED_AS',
      'PRESENCE_OF', 'HAS_TYPE', 'REACHABLE_VIA', 'REPRESENTS', 'DECOMPOSED_FROM', 'OWNS',
    ]) {
      expect(q, `${rel} undocumented`).toContain(rel);
    }
  });

  it('runs at boot beside the other registry writes', () => {
    const found = ['spaces/main.ts', 'lite/spaces/main.ts']
      .map((p) => resolve(p))
      .find((p) => existsSync(p));
    if (found === undefined) throw new Error('main.ts not found');
    const s = readFileSync(found, 'utf8');
    expect(s).toContain('void client.ensureLiteSchemaAnnotations();');
  });
});

// ── The escape that broke the registry write ─────────────────────────
describe('no Cypher constant carries an unbalanced quote line', () => {
  it('every line of every runtime query has an even number of apostrophes', () => {
    // In a JS template literal `\'` is just `'` — the backslash never
    // reaches Cypher — so an apostrophe in prose closed a Cypher string
    // and the annotation write failed at runtime (silently: the method
    // is soft). Evaluated on the exported strings, not the source, for
    // the same reason the 0.0.77 byte test is.
    const offenders: string[] = [];
    for (const [name, query] of Object.entries(CYPHER)) {
      if (typeof query !== 'string') continue;
      query.split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, ''); // Cypher line comments may hold prose
        if ((code.match(/'/g) ?? []).length % 2 === 1) offenders.push(`${name}:${i + 1}: ${code.trim().slice(0, 80)}`);
      });
    }
    expect(offenders, 'a bare apostrophe inside a Cypher string literal').toEqual([]);
  });
});
