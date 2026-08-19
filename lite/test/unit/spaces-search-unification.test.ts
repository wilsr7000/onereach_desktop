/**
 * One content search, in the wide pane, with scope as a control
 * (2026-08-19). User: "search feel in a strange place UX wise."
 *
 * Before: three affordances with inverted scopes — ⌘K jumped to spaces,
 * the NARROW sidebar ran the BROAD cross-space item search into a
 * cramped tree (hidden behind a collapsed section), and the WIDE main
 * pane ran the narrowest per-space search. The sidebar box also did
 * double duty as a nav filter, rearranging the tree as you typed.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';

const source = (): string => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('node:path') as typeof import('node:path');
  const found = ['spaces/spaces.ts', 'lite/spaces/spaces.ts']
    .map((r) => path.resolve(r))
    .find((f) => fs.existsSync(f));
  return fs.readFileSync(found as string, 'utf8');
};

const html = (): string => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('node:path') as typeof import('node:path');
  const found = ['spaces/spaces.html', 'lite/spaces/spaces.html']
    .map((r) => path.resolve(r))
    .find((f) => fs.existsSync(f));
  return fs.readFileSync(found as string, 'utf8');
};

describe('there is exactly one content search', () => {
  it('the sidebar box no longer searches content — it filters names', () => {
    const src = source();
    // The whole global-search machinery is gone, not merely unwired.
    for (const dead of [
      'scheduleGlobalItemSearch',
      'runGlobalItemSearch',
      'renderGlobalSearchResults',
      'globalSearchSeq',
    ]) {
      expect(src, `${dead} should be retired`).not.toContain(dead);
    }
    // …and its results tree is gone from the markup.
    expect(html()).not.toContain('spaces-search-results');
  });

  it('the sidebar box is labelled as the filter it is', () => {
    const markup = html();
    expect(markup).toContain('Filter spaces by name…');
    expect(markup).toContain('>Filter</span>');
    expect(markup).not.toContain('Search spaces + items…');
  });

  it('scope is a control on the one box, not a second box elsewhere', () => {
    const src = source();
    expect(src).toMatch(/itemsSearchScope: 'space' \| 'all';/);
    expect(src).toContain("state.itemsSearchScope === 'space' &&");
    expect(src).toContain('spaces-items-search-scope');
    // Both scopes are offered by name.
    expect(src).toContain('This space');
    expect(src).toContain('All spaces');
  });

  it('Home can search too — it just has nothing to narrow to', () => {
    const src = source();
    const at = src.indexOf('const onHome = state.activeScopeId === HOME_SCOPE_ID;');
    expect(at, 'the search box should no longer be skipped on Home').toBeGreaterThan(-1);
    const body = src.slice(at, at + 2200);
    // The toggle is suppressed on Home, but the input is not.
    expect(body).toContain('if (!onHome)');
    expect(body).toContain('Search all spaces…');
  });

  it('⌘F reaches the content search, falling back to the filter', () => {
    const src = source();
    const at = src.indexOf('function expandAndFocusSearch');
    const body = src.slice(at, at + 700);
    expect(body).toContain("getElementById('spaces-items-search-input')");
    expect(body).toContain("getElementById('spaces-sidebar-search-input')");
  });
});
