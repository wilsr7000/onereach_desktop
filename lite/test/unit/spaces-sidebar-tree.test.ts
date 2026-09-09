/**
 * ADR-099 — nesting the sidebar can see, and archive. The tree is built
 * from one listing (`parentIds`), a parent the viewer cannot see makes
 * the child top-level, a child sits under every visible parent, archived
 * Spaces are out of the tree, and the menu offers Archive / Unarchive.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import {
  buildSpaceTree,
  buildSpaceContextEntries,
  isArchivedSpace,
  sortSpaces,
  tidyMoveTitle,
} from '../../spaces/spaces.js';

type Row = Parameters<typeof sortSpaces>[0][number];
const sp = (id: string, name: string, over: Partial<Row> = {}): Row => ({ id, name, ...over }) as Row;

describe('buildSpaceTree', () => {
  const spaces = [
    sp('grp', 'GSX Designer'),
    sp('t1', 'Tickets', { parentIds: ['grp'] }),
    sp('t2', 'Agents', { parentIds: ['grp'] }),
    sp('both', 'Shared child', { parentIds: ['grp', 'pay'] }),
    sp('pay', 'Payments'),
    sp('orphan', 'Orphan', { parentIds: ['unseen-parent'] }),
    sp('gone', 'Archived one', { parentIds: ['grp'], archivedAt: '2026-09-09T00:00:00.000Z' }),
    sp('self', 'Loop', { parentIds: ['self'] }),
  ];

  it('top level = live Spaces with no visible parent, sorted', () => {
    const tree = buildSpaceTree(spaces, 'name');
    expect(tree.topLevel.map((s) => s.id)).toEqual(['grp', 'self', 'orphan', 'pay']);
  });

  it('a child sits under every visible parent; archived Spaces are out of the tree', () => {
    const tree = buildSpaceTree(spaces, 'name');
    expect(tree.childrenOf.get('grp')?.map((s) => s.id)).toEqual(['t2', 'both', 't1']);
    expect(tree.childrenOf.get('pay')?.map((s) => s.id)).toEqual(['both']);
    expect(tree.childrenOf.has('unseen-parent')).toBe(false);
    expect([...tree.childrenOf.values()].flat().some((s) => s.id === 'gone')).toBe(false);
  });

  it('sorts within each level by the chosen mode', () => {
    const tree = buildSpaceTree(
      [sp('p', 'P'), sp('a', 'Old', { parentIds: ['p'], updatedAt: '2026-01-01T00:00:00Z' }), sp('b', 'New', { parentIds: ['p'], updatedAt: '2026-09-01T00:00:00Z' })],
      'recent'
    );
    expect(tree.childrenOf.get('p')?.map((s) => s.id)).toEqual(['b', 'a']);
  });
});

describe('isArchivedSpace', () => {
  it('reads the archive stamp', () => {
    expect(isArchivedSpace({ archivedAt: '2026-09-09T00:00:00.000Z' })).toBe(true);
    expect(isArchivedSpace({ archivedAt: '' })).toBe(false);
    expect(isArchivedSpace({})).toBe(false);
  });
});

describe('the Space menu', () => {
  const handlers = () => {
    const h = (): void => undefined;
    return {
      share: h, unshare: h, addPeople: h, upload: h, rename: h, editObjective: h, convertShared: h,
      convertUser: h, setPlaybook: h, newJourney: h, sendToMemory: h, deleteSpace: h, togglePin: h,
    };
  };
  it('offers Archive for a live Space and Unarchive for an archived one, and it is wired', () => {
    let fired = 0;
    const live = buildSpaceContextEntries(sp('s1', 'X', { visibility: 'open', kind: 'user' }), { ...handlers(), archive: () => void (fired += 1) });
    const entry = live.find((e) => e.type === 'action' && e.label === 'Archive space');
    expect(entry).toBeDefined();
    (entry as { run: () => void }).run();
    expect(fired).toBe(1);
    const archived = buildSpaceContextEntries(sp('s1', 'X', { visibility: 'open', kind: 'user', archivedAt: '2026-09-09T00:00:00.000Z' }), handlers());
    expect(archived.some((e) => e.type === 'action' && e.label === 'Unarchive space')).toBe(true);
    expect(archived.some((e) => e.type === 'action' && e.label === 'Archive space')).toBe(false);
  });
});

describe('tidyMoveTitle', () => {
  it('reads a move back in the person\'s words', () => {
    expect(
      tidyMoveTitle({ key: 'k', kind: 'nest', spaceId: 'a', spaceName: 'Tickets', parentId: 'g', parentName: 'GSX Designer', reason: 'r', evidence: [], confidence: 0.8, decision: 'undecided' })
    ).toBe('Put "Tickets" inside "GSX Designer"');
  });
});
