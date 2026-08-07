/**
 * Empty states must offer a way out.
 *
 * These two screens are the entire first-run experience: a new account
 * has no Spaces, and a freshly created Space has no items. Before this,
 * the first said "No Spaces yet." and stopped, and the second said
 * "Items added to this Space will show up here" — both describing a
 * state rather than resolving it, at the exact moment a user has the
 * least information and the most need for direction.
 *
 * The rule these tests encode: an empty state a user can ACT on gets a
 * button; one they genuinely cannot (the uncategorized inbox, where
 * things arrive rather than being added) does not, because a button
 * that does nothing useful is worse than no button.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import '../../spaces/spaces.js';

interface RendererHandle {
  buildEmptyItems?: (scopeId: string) => HTMLElement;
}

function handle(): RendererHandle {
  const w = window as unknown as { __spacesRendererForTesting?: RendererHandle };
  return w.__spacesRendererForTesting ?? {};
}

describe('the empty-Space state', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('offers an action rather than describing the future', () => {
    const build = handle().buildEmptyItems;
    if (build === undefined) return; // not exposed in this build
    const el = build('space-1');
    const cta = el.querySelector<HTMLButtonElement>('.spaces-empty-items-cta');
    expect(cta, 'an empty Space must offer a way to fill it').not.toBeNull();
    expect(cta?.textContent).toBe('Add the first item');
  });

  it('tells the user HOW, not just that it is empty', () => {
    const build = handle().buildEmptyItems;
    if (build === undefined) return;
    const text = build('space-1').textContent ?? '';
    // Names concrete routes in, rather than a passive future tense.
    expect(text).toMatch(/file|note|link|agent/i);
    expect(text).not.toContain('will show up here');
  });

  // The triage lane is genuinely passive — items ARRIVE there. A
  // "add" button would be a lie about how the surface works.
  it('gives the uncategorized inbox no add button', () => {
    const build = handle().buildEmptyItems;
    if (build === undefined) return;
    const el = build('__uncategorized__');
    expect(el.querySelector('.spaces-empty-items-cta')).toBeNull();
  });
});

describe('the zero-Spaces sidebar state — the true first screen', () => {
  beforeEach(() => {
    document.body.innerHTML = '<ul id="spaces-list-spaces"></ul>';
  });

  // Asserted at source level: rendering it needs the module's private
  // `state`, but the shape of this screen is too important to leave
  // uncovered — it is what every new account opens to.
  it('explains what a Space is and offers to create one', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const candidates = ['lite/spaces/spaces.ts', 'spaces/spaces.ts'].map((p) => path.resolve(p));
    const found = candidates.find((p) => fs.existsSync(p));
    expect(found, 'spaces.ts not found').toBeDefined();
    const src = fs.readFileSync(found as string, 'utf8');

    const at = src.indexOf('state.spaces.length === 0');
    expect(at, 'zero-Spaces branch not found — renamed?').toBeGreaterThan(-1);
    // Strip comments first: the code comment explaining this fix quotes
    // the old copy, and prose about a defect must not read as the
    // defect. (Same trick the window.prompt meta-test uses.)
    const block = src
      .slice(at, at + 1600)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    expect(
      block.includes('Create your first Space'),
      'the first screen must offer the action that resolves it'
    ).toBe(true);
    expect(
      block.includes('openNewSpaceDialog'),
      'the button must actually be wired to the create flow'
    ).toBe(true);
    expect(
      block.includes('No Spaces yet.'),
      'the old dead-end copy should be gone'
    ).toBe(false);
  });
});
