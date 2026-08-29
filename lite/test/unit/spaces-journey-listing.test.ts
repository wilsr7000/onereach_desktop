/**
 * A journey you create shows up in the Space.
 *
 * ADR-072's whole bet is that a journey map is an ORDINARY asset, so the
 * grid, the tile, versions and search all work with no bespoke code. The
 * flip side is that nothing about journeys is explicit in the listing
 * path — they ride on `(a:Asset)` matching the member predicate and on
 * `'journey'` being in `ITEM_KINDS`. Both are easy to break from a
 * distance: tighten the predicate, or drop a kind, and journeys quietly
 * stop appearing. Nothing throws; the Space just looks emptier.
 *
 * That already happened once in this codebase — ADR-058, where Lite read
 * only `:Asset` members and every WISER note was invisible. These tests
 * are the guard for the journey version of that bug.
 */

import { describe, it, expect } from 'vitest';
import { SdkSpacesClient, CYPHER, type SpacesQueryFn } from '../../spaces/sdk-client.js';
import { ITEM_KINDS } from '../../spaces/types.js';

interface Call {
  cypher: string;
  parameters: Record<string, unknown>;
}

/** A row shaped like the one LIST_ITEMS_IN_SPACE returns for a journey. */
const journeyRow = {
  id: 'journey-1',
  title: 'Enterprise onboarding',
  kind: 'journey',
  createdAt: '2026-08-18T10:00:00Z',
  updatedAt: '2026-08-19T09:00:00Z',
  description: '3 phases · 8 touchpoints · 8 agent hand-offs',
  contentHead: '## 1. Evaluate',
};

function stub(rows: Array<Record<string, unknown>>): { fn: SpacesQueryFn; calls: Call[] } {
  const calls: Call[] = [];
  const fn: SpacesQueryFn = async (cypher, parameters) => {
    calls.push({ cypher, parameters: (parameters ?? {}) as Record<string, unknown> });
    return rows;
  };
  return { fn, calls };
}

describe('a journey is listed like any other asset', () => {
  it('comes back from the Space with its kind intact', async () => {
    const s = stub([journeyRow]);
    const items = await new SdkSpacesClient({ query: s.fn }).listItems({
      kind: 'space',
      spaceId: 's1',
    });
    expect(items).toHaveLength(1);
    // The failure this guards: an unrecognised kind is coerced to
    // 'other', so the journey renders as a generic file — present, but
    // stripped of the tile that makes it a journey.
    expect(items[0]?.kind).toBe('journey');
    expect(items[0]?.title).toBe('Enterprise onboarding');
  });

  it('is not filtered out by the member predicate', () => {
    // Journeys are (:Asset {type:'journey'}). If this predicate ever
    // narrows to specific labels without :Asset, every journey vanishes
    // from every Space at once — the ADR-058 failure, again.
    expect(CYPHER.LIST_ITEMS_IN_SPACE).toContain('a:Asset');
    expect(CYPHER.LIST_SPACES).toContain('a:Asset');
  });

  it('keeps its markdown head, so the tile can show the stage flow', () => {
    // The listing query names the kinds whose content is worth previewing.
    // Dropping 'journey' here leaves the tile blank even though the asset
    // is fine.
    const previewed = /IN \[([^\]]*)\]/.exec(CYPHER.LIST_ITEMS_IN_SPACE)?.[1] ?? '';
    expect(previewed).toContain("'journey'");
  });

  it('counts toward the Space it belongs to', async () => {
    const s = stub([{ id: 's1', name: 'Design', itemCount: 4 }]);
    const spaces = await new SdkSpacesClient({ query: s.fn }).listSpaces();
    // A journey that lists but doesn't count makes the Space read "3
    // items" over a grid of 4 — the union in LIST_SPACES has to cover
    // :Asset for the count to agree with the contents.
    expect(spaces[0]?.itemCount).toBe(4);
    expect(s.calls[0]?.cypher).toContain('a:Asset');
  });

  it("'journey' is a kind this app knows — the enum the mapper checks", () => {
    expect(ITEM_KINDS).toContain('journey');
  });
});
