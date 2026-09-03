/**
 * ADR-085 — nested Spaces in the renderer: the context-menu entry and the
 * Inside / Contains chip row (pure DOM builder).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { buildSpaceContextEntries, renderNestingChips } from '../../spaces/spaces.js';

const handlers = () => {
  const h = (): void => undefined;
  return {
    share: h, unshare: h, addPeople: h, upload: h, rename: h, editObjective: h, convertShared: h,
    convertUser: h, setPlaybook: h, newJourney: h, sendToMemory: h, deleteSpace: h, togglePin: h,
    nestInside: h,
  };
};

describe('space menu', () => {
  it('offers "Put inside a Space…" and it is wired', () => {
    let fired = 0;
    const entries = buildSpaceContextEntries(
      { id: 's1', name: 'X', visibility: 'open', kind: 'user' } as never,
      { ...handlers(), nestInside: () => void (fired += 1) }
    );
    const entry = entries.find((e) => e.type === 'action' && e.label === 'Put inside a Space…');
    expect(entry).toBeDefined();
    (entry as { run: () => void }).run();
    expect(fired).toBe(1);
  });
});

describe('renderNestingChips', () => {
  const noop = { open: (): void => undefined, unnest: (): void => undefined, toggleInherit: (): void => undefined };

  it('stays hidden with nothing to show', () => {
    const row = document.createElement('div');
    renderNestingChips(row, [], [], noop);
    expect(row.hidden).toBe(true);
    expect(row.childElementCount).toBe(0);
  });

  it('renders Inside and Contains groups, marks inheritance, and the parent chip toggles it', () => {
    const row = document.createElement('div');
    const calls: string[] = [];
    renderNestingChips(
      row,
      [{ id: 'p1', name: 'Parent One', color: '#3f78c0', inheritsPermissions: true, inheritsUntil: new Date(Date.now() + 6 * 3600 * 1000).toISOString() }],
      [{ id: 'c1', name: 'Child One', inheritsPermissions: false }],
      {
        open: (id) => calls.push(`open:${id}`),
        unnest: (childId, parentId) => calls.push(`unnest:${childId}>${parentId}`),
        toggleInherit: (parentId, next) => calls.push(`inherit:${parentId}=${String(next)}`),
      }
    );
    expect(row.hidden).toBe(false);
    const labels = Array.from(row.querySelectorAll('.spaces-nesting-label')).map((l) => l.textContent);
    expect(labels).toEqual(['Inside', 'Contains']);
    const parent = row.querySelector('.spaces-nesting-chip-parent') as HTMLElement;
    const child = row.querySelector('.spaces-nesting-chip-child') as HTMLElement;
    expect(parent.querySelector('.spaces-nesting-inherit')?.textContent).toMatch(/^inherits · expires in/);
    expect(child.querySelector('.spaces-nesting-inherit')?.textContent).toBe('own permissions');
    expect((child.querySelector('.spaces-nesting-inherit') as HTMLButtonElement).disabled).toBe(true);
    (parent.querySelector('.spaces-nesting-inherit') as HTMLButtonElement).click();
    (parent.querySelector('.spaces-nesting-chip-name') as HTMLButtonElement).click();
    (parent.querySelector('.spaces-nesting-remove') as HTMLButtonElement).click();
    (child.querySelector('.spaces-nesting-remove') as HTMLButtonElement).click();
    expect(calls).toEqual(['inherit:p1=false', 'open:p1', 'unnest:__viewed__>p1', 'unnest:c1>__viewed__']);
  });
});
