/**
 * ADR-074 — read-only members: the WRITE-side inventory.
 *
 * `[:HAS_ACCESS]` grants sight; `role` on that edge decides whether the
 * holder may also change things. A permission enforced on 38 of 39
 * queries is not a permission — it is a false sense of one — so this
 * file is the write-side mirror of the read-side visibility inventory:
 * every mutating Cypher constant must carry `SPACE_WRITABLE` or appear
 * in EXEMPT with a reason. Adding an unguarded mutation fails HERE.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

function sdkSource(): string {
  const found = ['spaces/sdk-client.ts', 'lite/spaces/sdk-client.ts']
    .map((p) => resolve(p))
    .find((p) => existsSync(p));
  if (found === undefined) throw new Error('sdk-client.ts not found');
  return readFileSync(found, 'utf8');
}

/**
 * Mutations that deliberately carry no Space write-guard, each with the
 * reason. Shrinking this list is progress; growing it needs a reason
 * that survives review.
 */
const EXEMPT: Record<string, string> = {
  CREATE_SPACE:
    'creates the Space itself — there is no Space yet to hold a grant, and the ' +
    'creator becomes its writer by definition (s.createdBy)',
  GRANT_SELF_ACCESS:
    'the identity gate stamping the signed-in person onto a Space they are ' +
    'filing into; guarding it with membership would be circular',
  RECORD_ASSET_VIEW:
    'an audit write about the VIEWER, not the content: a reader reading is ' +
    'exactly what read-only permits, and the edge is viewer-scoped',
  ENSURE_CHECKLIST_SCHEMA: 'registry documentation, not user data',
  ENSURE_ACCESS_ROLE_SCHEMA: 'registry documentation, not user data',
  UPSERT_PERSON: 'identity plumbing — a Person node is not Space content',
  ENSURE_MEETINGS_SPACE: 'bootstrap of the shared meetings Space',
  PIN_SPACE:
    'a pin is a per-viewer preference edge, not Space content — a reader ' +
    'organising their own sidebar changes nothing anyone else sees',
  UNPIN_SPACE: 'the inverse of PIN_SPACE; same reasoning',
  ENSURE_VERSION_SCHEMA: 'registry documentation, not user data',
  MERGE_PERSON: 'identity plumbing — a Person node is not Space content',
  CREATE_ASSET_UNCATEGORIZED:
    'creates the viewer\'s OWN uncategorized asset, which belongs to no Space ' +
    'yet: there is no grant to check, and ASSET_WRITABLE would be circular ' +
    '(the node does not exist when the guard would run). Filing it INTO a ' +
    'Space goes through ADD_ASSET_TO_SPACE, which is guarded',
  CREATE_AGENT_ENDPOINT:
    'binds an endpoint to an :Agent node by id, with no Space in scope. The ' +
    'agent ASSET creation that precedes it (CREATE_AGENT / ' +
    'CREATE_AGENT_FROM_LIBRARY) is guarded, so a reader cannot reach this ' +
    'with an agent they were able to create. TODO(ADR-074 phase 2): gate on ' +
    'the agent\'s owning Space once agents carry one reliably',
  CREATE_AGENT_ENDPOINT_MERGED: 'same as CREATE_AGENT_ENDPOINT',
};

/** Cypher constants whose body mutates the graph. */
function writeQueries(src: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const re = /\n {2}([A-Z][A-Z0-9_]*): `\n([\s\S]*?)\n {2}`,/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const name = m[1] as string;
    const body = m[2] as string;
    // A write is anything that changes graph state.
    if (/\b(SET|MERGE|CREATE|DELETE|DETACH DELETE|REMOVE)\b/.test(body)) {
      // MERGE inside a read's OPTIONAL MATCH chain is rare; require a
      // real mutation verb at statement start to avoid false positives.
      if (/(^|\n)\s*(SET|MERGE|CREATE|DELETE|DETACH DELETE|REMOVE)\b/.test(body)) {
        out.push({ name, body });
      }
    }
  }
  return out;
}

describe('ADR-074 — every graph WRITE is role-gated or justified', () => {
  const src = sdkSource();
  const writes = writeQueries(src);

  it('finds the write surface at all (guards the detector itself)', () => {
    // If this collapses to a handful, the regex broke and every
    // assertion below would pass vacuously.
    expect(writes.length).toBeGreaterThan(15);
    expect(writes.map((w) => w.name)).toContain('CREATE_ASSET');
  });

  it('ASSET_WRITABLE mirrors it at the asset level (sight is not enough)', () => {
    const i = src.indexOf('const ASSET_WRITABLE');
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(i, i + 900);
    expect(block).toContain('BELONGS_TO');
    expect(block).toContain("coalesce(wr.role, 'writer') <> 'reader'");
  });

  it('SPACE_WRITABLE requires a live, non-reader grant (or being the creator)', () => {
    const i = src.indexOf('const SPACE_WRITABLE');
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(i, i + 700);
    expect(block).toContain("coalesce(s.createdBy, '') = $viewerId"); // creator always writes
    expect(block).toContain('HAS_ACCESS');
    expect(block).toContain("coalesce(w.role, 'writer') <> 'reader'"); // absent role = writer
    expect(block).toContain('$viewerId <> '); // signed out writes nothing
  });

  it('no unguarded mutation ships without a written exemption', () => {
    const unguarded = writes
      .filter((w) => !w.body.includes('SPACE_WRITABLE') && !w.body.includes('ASSET_WRITABLE'))
      .map((w) => w.name)
      .filter((name) => !(name in EXEMPT));
    expect(
      unguarded,
      `unguarded write queries (add SPACE_WRITABLE, or EXEMPT them with a reason): ${unguarded.join(', ')}`
    ).toEqual([]);
  });

  it('the load-bearing mutations are guarded by name', () => {
    const byName = new Map(writes.map((w) => [w.name, w.body]));
    for (const name of [
      'CREATE_ASSET',
      'UPDATE_SPACE',
      'RENAME_SPACE',
      'SOFT_DELETE_SPACE',
      'SET_SPACE_KIND',
      'SET_CURRENT_PLAYBOOK',
      'ADD_SPACE_MEMBER',
      'REMOVE_SPACE_MEMBER',
    ]) {
      expect(byName.get(name), `${name} missing from the write surface`).toBeDefined();
      expect(byName.get(name), `${name} is not role-gated`).toContain('SPACE_WRITABLE');
    }
  });

  it('a reader cannot be silently promoted: role writes need explicit intent', () => {
    const i = src.indexOf('ADD_SPACE_MEMBER: `');
    const block = src.slice(i, i + 1600);
    // Same three-intent discipline as expiry: absent leaves the role.
    expect(block).toContain('$writeRole');
    expect(block).toContain('SET r.role = $role');
  });

  it('the role contract is published to the graph schema registry', () => {
    expect(src).toContain('ENSURE_ACCESS_ROLE_SCHEMA');
    const i = src.indexOf('ENSURE_ACCESS_ROLE_SCHEMA: `');
    const block = src.slice(i, i + 400);
    expect(block).toContain("MERGE (rt:Schema {entity: '_RelationshipTypes'})");
    expect(block).toContain('hasAccessRoleValues');
  });
});
