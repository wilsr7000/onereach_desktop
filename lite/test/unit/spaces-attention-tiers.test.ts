/**
 * ADR-069 — attention tiers for the Spaces sidebar.
 *
 * The sidebar is a WORKING SET, not an inventory: pinned Spaces are the
 * human's override, activity ranks the rest, the long tail folds behind
 * More…, and ⌘K jumps anywhere. These tests pin the pure pieces — the
 * Cypher contract for the PINNED edge, the palette ranking, and the
 * machine-name detector that drives the rename nudge.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { CYPHER } from '../../spaces/sdk-client.js';
import {
  spacesPaletteEntries,
  looksMachineNamed,
  sortSpaces,
  buildSpaceRow,
  buildSpaceContextEntries,
} from '../../spaces/spaces.js';
import type { Space } from '../../spaces/types.js';

describe('CYPHER — PINNED edge contract (ADR-069)', () => {
  it('LIST_SPACES returns the viewer pin flag from the PINNED edge', () => {
    expect(CYPHER.LIST_SPACES).toMatch(/OPTIONAL MATCH \(:Person \{id: \$viewerId\}\)-\[pin:PINNED\]->\(s\)/);
    expect(CYPHER.LIST_SPACES).toMatch(/pin IS NOT NULL AS pinned/);
  });

  it('PIN_SPACE MATCHes the Person (never mints a bare node) and MERGEs idempotently', () => {
    expect(CYPHER.PIN_SPACE).toMatch(/MATCH \(p:Person \{id: \$viewerId\}\)/);
    expect(CYPHER.PIN_SPACE).not.toMatch(/MERGE \(p:Person/);
    expect(CYPHER.PIN_SPACE).toMatch(/MERGE \(p\)-\[r:PINNED\]->\(s\)/);
    expect(CYPHER.PIN_SPACE).toMatch(/ON CREATE SET r\.pinnedAt/);
    // Pin respects visibility: you can only pin what you can see.
    expect(CYPHER.PIN_SPACE).toMatch(/s\.deletedAt IS NULL/);
  });

  it('UNPIN_SPACE deletes only the viewer edge, never the Space', () => {
    expect(CYPHER.UNPIN_SPACE).toMatch(/\[r:PINNED\]/);
    expect(CYPHER.UNPIN_SPACE).toMatch(/DELETE r/);
    expect(CYPHER.UNPIN_SPACE).not.toMatch(/DETACH DELETE/);
    expect(CYPHER.UNPIN_SPACE).not.toMatch(/DELETE s/);
  });
});

const mkSpace = (over: Partial<Space> & { id: string }): Space => ({
  name: over.id,
  ...over,
});

describe('spacesPaletteEntries — ⌘K ranking', () => {
  const spaces: Space[] = [
    mkSpace({ id: 'a', name: 'Alpha Team', lastActivity: '2026-08-17T10:00:00Z' }),
    mkSpace({ id: 'b', name: 'Beta Ops', lastActivity: '2026-08-16T10:00:00Z' }),
    mkSpace({ id: 'c', name: 'Cold Archive', lastActivity: '2026-01-01T10:00:00Z', pinned: true }),
    mkSpace({ id: 'd', name: 'Delta Alpha', lastActivity: '2026-08-15T10:00:00Z' }),
  ];

  it('with no query: pinned first, then activity order', () => {
    const ids = spacesPaletteEntries(spaces, '').map((s) => s.id);
    expect(ids).toEqual(['c', 'a', 'b', 'd']);
  });

  it('query: prefix matches beat substring matches, order preserved within groups', () => {
    const ids = spacesPaletteEntries(spaces, 'alpha').map((s) => s.id);
    // 'Alpha Team' starts with the query; 'Delta Alpha' merely contains it.
    expect(ids).toEqual(['a', 'd']);
  });

  it('query is case-insensitive and trims', () => {
    expect(spacesPaletteEntries(spaces, '  BETA ').map((s) => s.id)).toEqual(['b']);
  });

  it('no matches yields empty, never throws', () => {
    expect(spacesPaletteEntries(spaces, 'zzz')).toEqual([]);
    expect(spacesPaletteEntries([], 'anything')).toEqual([]);
  });

  it('caps the list at 12 for keyboard reach', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      mkSpace({ id: `s${i}`, name: `Space Number ${i}` })
    );
    expect(spacesPaletteEntries(many, '').length).toBe(12);
  });
});

describe('looksMachineNamed — the rename-nudge detector', () => {
  it('flags the shapes machine writers actually mint', () => {
    expect(looksMachineNamed('Space a7671f80')).toBe(true);
    expect(looksMachineNamed('Space 0f0f0f0f')).toBe(true);
    expect(looksMachineNamed('space-deadbeef01')).toBe(true);
    expect(looksMachineNamed('28f443a4-a37f-4e9d-8cdc-01630c686ede')).toBe(true);
    expect(looksMachineNamed('0ba77511702c3ac2cad379fcaa805d30')).toBe(true);
    expect(looksMachineNamed('')).toBe(true);
    expect(looksMachineNamed('   ')).toBe(true);
  });

  it('never nags a real name (false positives are the failure mode)', () => {
    expect(looksMachineNamed('WISER Playbooks')).toBe(false);
    expect(looksMachineNamed('Ops Incident Response')).toBe(false);
    expect(looksMachineNamed('KEYS')).toBe(false);
    expect(looksMachineNamed('Space Race')).toBe(false); // 'Race' is not hex
    expect(looksMachineNamed('Feedback')).toBe(false);
    expect(looksMachineNamed('deadline planning')).toBe(false); // hex-ish word, has more
  });
});

describe('rename nudge — real row DOM', () => {
  it('a machine-named space row carries the name? affordance', () => {
    const row = buildSpaceRow(
      { id: 's1', name: 'Space a7671f80' } as never,
      false
    );
    const nudge = row.querySelector('.spaces-row-name-nudge');
    expect(nudge).not.toBeNull();
    expect(nudge?.textContent).toBe('name?');
  });

  it('a human-named space row stays clean', () => {
    const row = buildSpaceRow({ id: 's1', name: 'WISER Playbooks' } as never, false);
    expect(row.querySelector('.spaces-row-name-nudge')).toBeNull();
  });
});

describe('context menu — pin entry (ADR-069)', () => {
  const noop = (): void => {};
  const handlers = {
    share: noop, unshare: noop, addPeople: noop, upload: noop, rename: noop,
    editObjective: noop, convertShared: noop, convertUser: noop, setPlaybook: noop, deleteSpace: noop,
    togglePin: noop,
  };

  it('unpinned space offers Pin to sidebar; pinned offers Unpin', () => {
    const labels = (space: object): string[] =>
      buildSpaceContextEntries(space as never, handlers)
        .map((e) => ('label' in e ? (e as { label: string }).label : ''));
    expect(labels({ id: 's1', name: 'S', visibility: 'open' })).toContain('Pin to sidebar');
    expect(labels({ id: 's1', name: 'S', visibility: 'open', pinned: true })).toContain(
      'Unpin from sidebar'
    );
  });

  it('the pin entry fires its handler', () => {
    let fired = 0;
    const entries = buildSpaceContextEntries(
      { id: 's1', name: 'S', visibility: 'open' } as never,
      { ...handlers, togglePin: () => { fired += 1; } }
    );
    const pin = entries.find(
      (e) => e.type === 'action' && e.label === 'Pin to sidebar'
    );
    if (pin?.type !== 'action') throw new Error('pin entry missing');
    pin.run();
    expect(fired).toBe(1);
  });
});

describe('sortSpaces recent mode still anchors the tiers (ADR-060)', () => {
  it('ranks by lastActivity descending with missing stamps sinking', () => {
    const ids = sortSpaces(
      [
        mkSpace({ id: 'old', name: 'Old', lastActivity: '2026-01-01T00:00:00Z' }),
        mkSpace({ id: 'nostamp', name: 'No Stamp' }),
        mkSpace({ id: 'fresh', name: 'Fresh', lastActivity: '2026-08-17T00:00:00Z' }),
      ],
      'recent'
    ).map((s) => s.id);
    expect(ids).toEqual(['fresh', 'old', 'nostamp']);
  });
});
