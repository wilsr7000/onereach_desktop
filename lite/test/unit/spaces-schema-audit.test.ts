/**
 * ADR-078 — the NEON schema audit's code-side decisions, pinned.
 *
 * The audit's headline: Lite's belonging predicate honored only Lite's
 * own vocabulary (createdBy / HAS_ACCESS) while the graph's other
 * writers record account membership as [:OWNS] — 313 edges — so 92 live
 * Spaces were visible to nobody in Lite (robb: 20 of 114). Sight now
 * follows OWNS; writes do not. Plus two smaller contracts: GSX-Desktop's
 * `private` visibility reads as restricted (it read as OPEN), and Lite
 * documents its slice of the model in the registry without touching
 * what other writers own.
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

const OWNS_S = "[:OWNS]->(s)";
const OWNS_OTHER = "[:OWNS]->(other)";
const OWNS_VS = "[:OWNS]->(vs)";

describe('sight follows OWNS (ADR-078)', () => {
  it('every Space-level read honors the OWNS membership signal', () => {
    // Evaluated on the REAL exported strings — a source-only check would
    // have passed the 0.0.77 invisible-byte outage.
    expect(CYPHER.LIST_SPACES).toContain(OWNS_S);
    expect(CYPHER.LIST_ITEMS_IN_SPACE).toContain(OWNS_S);
    expect(CYPHER.LIST_ITEMS_IN_SPACE).toContain(OWNS_OTHER); // the chips join
    expect(CYPHER.GET_ITEM).toContain(OWNS_VS); // ASSET_VISIBLE's space branch
  });

  it('the live-meetings audience widens the same way (mobile mirrors the WHERE)', () => {
    expect(CYPHER.LIST_LIVE_MEETINGS).toContain('[:OWNS]->(ms)');
  });

  it('OWNS grants SIGHT only — never a write', () => {
    const s = sdkSource();
    const i = s.indexOf('const SPACE_WRITABLE = `');
    // The predicate BODY only — the doc comment above SPACE_VISIBLE
    // legitimately mentions OWNS in prose.
    const block = s.slice(i, s.indexOf('`;', i));
    expect(block).not.toContain('OWNS');
    const j = s.indexOf('const ASSET_WRITABLE');
    expect(s.slice(j, j + 1200)).not.toContain('OWNS');
  });

  it('the three visibility predicates all carry the branch (no half-applied sight)', () => {
    const s = sdkSource();
    for (const [name, marker] of [
      ['SPACE_VISIBLE', OWNS_S],
      ['OTHER_SPACE_VISIBLE', OWNS_OTHER],
      ['ASSET_VISIBLE', OWNS_VS],
    ] as const) {
      const i = s.indexOf(`const ${name} = \``);
      expect(i, `${name} missing`).toBeGreaterThan(-1);
      expect(s.slice(i, i + 900), `${name} lacks the OWNS branch`).toContain(marker);
    }
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
