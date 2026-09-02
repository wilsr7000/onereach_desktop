/**
 * Visibility-gate inventory (from the 2026-08-07 external Spaces
 * review, item 2: "five leaky read paths bypass visibility").
 *
 * The review was right, and the fix landed piecemeal across two
 * sessions — which is exactly how it regresses: the next query someone
 * adds won't carry a predicate, no test will notice, and a restricted
 * Space's tickets or playbook leak again. This test turns the review
 * into an invariant: EVERY read query in the Cypher surface either
 * contains a visibility predicate or appears below with a written
 * justification. A new ungated read fails until its author chooses.
 *
 * Exemptions are not a loophole — each one names the reason gating
 * would be WORSE. The headline case: FIND_ASSET_BY_FILE_KEY is the
 * orphan-cleanup ambiguity guard; gated, a restricted-space asset
 * becomes invisible to the guard, which then concludes "no asset
 * references this key" and DELETES THE FILE. A blind gate there turns
 * a read leak into data loss.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Queries allowed to run ungated, each with its load-bearing reason. */
const EXEMPT: Record<string, string> = {
  FIND_ASSET_BY_FILE_KEY:
    'orphan-cleanup ambiguity guard (main-process internal): gating it makes ' +
    'restricted assets invisible to the guard, which then deletes their file',
  SPACE_ITEM_COUNT:
    'hard-delete pre-flight (internal to the delete flow); the delete ' +
    'mutations themselves carry SPACE_VISIBLE',
  FIND_SPACE_BY_NAME:
    'ADR-065 feedback drop-box pre-step (main-process internal, never on ' +
    'IPC): finds ONE Space by exact name returning id+name only, so a ' +
    'first-time reporter can be granted membership before the gated flows ' +
    'run. Gating it would orphan every non-member filing.',
  AGENT_LIBRARY_SEARCH:
    'account-wide agent directory by design — the add-from-library picker ' +
    'must list every agent in the account',
  MEMBER_LIBRARY_SEARCH:
    'account-wide people/agent directory by design — the add-member picker ' +
    'must list people you could grant access to',
  HOME_AGENTS_SAMPLE:
    'account-wide agent sample for the Home card — :Agent nodes are not ' +
    'space-scoped; the agent directory is deliberately account-visible',
  GET_AGENT_ENDPOINTS:
    'feeds createAgentFromLibrary only (library semantics above); not ' +
    'exposed as a renderer read',
  SPACE_EXISTS_BY_ID:
    'boolean existence pre-flight used by internal flows; returns no ' +
    'content beyond "a row exists"',
  FIND_AGENT_ASSET_IN_SPACE:
    'idempotency pre-flight inside createAgentFromLibrary — returns only an ' +
    'existing tile id so re-picking an agent focuses it instead of minting a ' +
    'twin; gating it would create duplicate tiles',
  LEARN_OTHER_MEMBERS:
    'returns a single aggregate count of other members, no identities',
};

// The three ADR-051 macros, plus the ADR-065 inline fail-closed
// signature — a query carrying the viewer-required clause is gated by
// construction even when its alias forces the predicate inline.
const GATE_MARKERS = ['SPACE_VISIBLE', 'ASSET_VISIBLE', 'OTHER_SPACE_VISIBLE', "$viewerId <> ''"];
const WRITE_MARKERS = [/\bMERGE\b/, /\bCREATE\b/, /\bSET\b/, /\bDETACH\b/, /\bDELETE\b/];

function loadSource(): string {
  const candidates = ['lite/spaces/sdk-client.ts', 'spaces/sdk-client.ts'].map((p) =>
    path.resolve(p)
  );
  const found = candidates.find((p) => fs.existsSync(p));
  expect(found, `sdk-client.ts not found in: ${candidates.join(', ')}`).toBeDefined();
  return fs.readFileSync(found as string, 'utf8');
}

interface Query {
  name: string;
  body: string;
}

/** Every `NAME: \`...\`` template entry in the file. */
function extractQueries(src: string): Query[] {
  const out: Query[] = [];
  const re = /\n\s{2}([A-Z][A-Z0-9_]+): `/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const start = m.index + m[0].length;
    const end = src.indexOf('`', start);
    if (end === -1) continue;
    out.push({ name: m[1] as string, body: src.slice(start, end) });
  }
  return out;
}

describe('every Cypher read is visibility-gated or justified', () => {
  const src = loadSource();
  const queries = extractQueries(src);

  it('found a plausible number of queries (parser sanity)', () => {
    expect(queries.length).toBeGreaterThan(30);
  });

  const reads = queries.filter(
    (q) => /\bMATCH\b/.test(q.body) && !WRITE_MARKERS.some((w) => w.test(q.body))
  );

  for (const q of reads) {
    it(`${q.name} is gated or exempt`, () => {
      const gated = GATE_MARKERS.some((g) => q.body.includes(g));
      const exempt = q.name in EXEMPT;
      expect(
        gated || exempt,
        `${q.name} reads the graph with no visibility predicate and no ` +
          `written exemption. Either add SPACE_VISIBLE/ASSET_VISIBLE, or add ` +
          `it to EXEMPT in this test with the reason gating would be worse.`
      ).toBe(true);
      // An entry that is BOTH gated and exempt means the exemption is
      // stale — prune it so the list stays honest.
      if (gated && exempt) {
        throw new Error(`${q.name} is gated now — remove its stale exemption.`);
      }
    });
  }

  it('carries no exemption for a query that no longer exists', () => {
    const names = new Set(queries.map((q) => q.name));
    const stale = Object.keys(EXEMPT).filter((n) => !names.has(n));
    expect(stale, `stale exemptions: ${stale.join(', ')}`).toEqual([]);
  });

  // The two review items fixed by name, pinned so they cannot quietly
  // regress: restricted Space names must not leak through item chips.
  it('GET_ITEM collects space chips only from visible Spaces', () => {
    const gi = queries.find((q) => q.name === 'GET_ITEM');
    expect(gi).toBeDefined();
    const body = (gi as Query).body;
    const chips = body.slice(0, body.indexOf('spacesRaw'));
    expect(
      chips.includes('SPACE_VISIBLE'),
      'the chips MATCH must be filtered, or restricted Space NAMES leak on any shared item'
    ).toBe(true);
  });

  it('LIST_ITEMS_IN_SPACE gates its other-space chips', () => {
    const li = queries.find((q) => q.name === 'LIST_ITEMS_IN_SPACE');
    expect(li).toBeDefined();
    expect((li as Query).body.includes('OTHER_SPACE_VISIBLE')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Composition pins (2026-08-31 stranger audit). The inventory above can
// only prove a predicate is PRESENT — it cannot see a predicate composed
// so it fails open. A live three-viewer probe (robb / stranger / anon)
// found HOME_RECENT_EVENTS leaking edgeless commits (author emails,
// activity kinds) to viewers with access to nothing: `s IS NULL OR
// (...visible)` let every commit with no IN_SPACE edge through. These
// pins hold the fail-closed shapes.
// ---------------------------------------------------------------------------
describe('event-feed visibility composition', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'spaces', 'sdk-client.ts'),
    'utf8'
  );

  it('HOME_RECENT_EVENTS: an edgeless commit is author-only-or-provably-visible, never public', () => {
    const q = src.slice(src.indexOf('HOME_RECENT_EVENTS: `'));
    const body = q.slice(0, q.indexOf('`,'));
    // The fail-open filter must never come back.
    expect(body).not.toMatch(/WHERE s IS NULL OR/);
    // The fail-closed branch: author match, gated on a non-empty viewer.
    expect(body).toContain("($viewerId <> '' AND toLower(coalesce(c.author, '')) = $viewerId)");
    // ...or membership in a visible space reached by id or TOUCHED contents.
    expect(body).toContain('[:TOUCHED]->()-[:BELONGS_TO]->(other)');
  });

  it('ITEM_RECENT_COMMITS: a commit never NAMES a space the viewer cannot see', () => {
    const q = src.slice(src.indexOf('ITEM_RECENT_COMMITS: `'));
    const body = q.slice(0, q.indexOf('`,'));
    expect(body).not.toContain('coalesce(s.name, c.spaceId) AS spaceName');
    expect(body).toMatch(/CASE WHEN s IS NOT NULL AND s\.deletedAt IS NULL AND/);
  });
});

// ---------------------------------------------------------------------------
// The journey-map window carries the `journeySpaces` preload bridge on
// every page it hosts, so in-window navigation must never leave the
// Builder's own deployment (2026-08-31 audit: without the guard, one
// in-window link hands the signed-in user's Spaces read/write bridge to
// an arbitrary site).
// ---------------------------------------------------------------------------
describe('journey-map window bridge containment', () => {
  const winSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'journey-map-window.ts'),
    'utf8'
  );

  it('a will-navigate guard pins the window to the Builder deployment', () => {
    expect(winSrc).toContain("webContents.on('will-navigate'");
    expect(winSrc).toContain('JOURNEY_MAP_BUILDER_ORIGIN');
    expect(winSrc).toContain('event.preventDefault()');
  });

  it('popups stay denied (OS browser only)', () => {
    expect(winSrc).toContain('setWindowOpenHandler');
    expect(winSrc).toContain("return { action: 'deny' }");
  });
});

// ---------------------------------------------------------------------------
// Sign-in identity hygiene (2026-09-01 identity audit): the spaces cache
// must be dropped on ANY change of the effective viewer, not only on
// sign-out. The old listener returned early whenever a session existed,
// so a switch straight to a different signed-in identity kept the
// previous user's cached spaces/home feed for up to one TTL.
// ---------------------------------------------------------------------------
describe('spaces cache follows the signed-in viewer', () => {
  const mainSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'spaces', 'main.ts'),
    'utf8'
  );
  it('invalidates on viewer-identity change, not merely on sign-out', () => {
    const listener = mainSrc.slice(mainSrc.indexOf('onSessionChanged((env, session)'));
    const body = listener.slice(0, listener.indexOf('} catch (err) {'));
    expect(body).not.toContain('if (session !== null) return;');
    expect(body).toContain('resolveViewerId()');
    expect(body).toContain('lastCachedViewer');
  });
});
