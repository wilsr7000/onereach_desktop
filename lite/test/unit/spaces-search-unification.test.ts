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

  it('the sidebar is a global entry into the ONE engine — no second implementation', () => {
    const markup = html();
    // 2026-08-20: "Search all spaces with agentic should also be in the
    // left panel." The input filters space names as you type; Enter and
    // Ask AI route content search through the shared engine, results in
    // the main pane. The retired sidebar results tree stays retired.
    // 2026-09-01 organization pass: the box moved from a collapsed
    // sidebar section to the command bar at the top of the window — one
    // global search, always visible, same ids, same wiring.
    expect(markup).toContain('class="spaces-header-search"');
    expect(markup).toContain('id="spaces-sidebar-search-input"');
    expect(markup).toContain('spaces-sidebar-search-ai');
    expect(markup).not.toContain('data-side-section="search"');
    expect(markup).not.toContain('spaces-search-results');
    const src = source();
    const wire = src.slice(
      src.indexOf('function wireSidebarSearch'),
      src.indexOf('function wireSidebarSearch') + 2600
    );
    expect(wire).toContain("state.itemsSearchScope = 'all'");
    expect(wire).toContain('runItemsSearch()');
    expect(wire).toContain('runAgenticItemsSearch()');
  });

  it('the space view search sits ABOVE the assets, not in the header', () => {
    const src = source();
    // 2026-08-20: "It should be placed above the assets."
    const contents = src.slice(
      src.indexOf('function appendSpaceContents'),
      src.indexOf('function appendSpaceContents') + 1200
    );
    expect(contents).toContain('buildContentSearchControls()');
    // The header keeps a box ONLY for Home (no contents region there).
    const header = src.slice(
      src.indexOf('function buildSpaceHeader'),
      src.indexOf('function buildSpaceHeader') + 3000
    );
    expect(header).toContain('if (state.activeScopeId === HOME_SCOPE_ID) {');
  });

  it('agentic search is a tier of the same box, and scope switches supersede in-flight walks', () => {
    const src = source();
    const runner = src.slice(
      src.indexOf('async function runAgenticItemsSearch'),
      src.indexOf('async function runAgenticItemsSearch') + 2600
    );
    // Same seq guard as the instant tier — one supersession discipline.
    expect(runner).toContain('const seq = ++itemsSearchSeq;');
    expect(runner).toContain('if (seq !== itemsSearchSeq) return;');
    // Scope switch supersedes anything in flight (the "search shows up
    // when you select a space" report).
    const scope = src.slice(
      src.indexOf('function setActiveScope'),
      src.indexOf('function setActiveScope') + 2600
    );
    expect(scope).toContain('itemsSearchSeq++;');
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

  it('Home can search too — its box lives in the header (no contents region)', () => {
    const src = source();
    const guard = src.indexOf(
      '// The content search lives ABOVE THE ASSETS for space views'
    );
    expect(guard, 'the placement comment anchors the Home-only branch').toBeGreaterThan(-1);
    const homeBox = src.slice(guard, guard + 2600);
    // Home renders the box in its header; space views render theirs
    // above the assets via buildContentSearchControls.
    expect(homeBox).toContain('if (state.activeScopeId === HOME_SCOPE_ID) {');
    expect(homeBox).toContain('Search all spaces…');
  });

  it('⌘F reaches the content search, falling back to the filter', () => {
    const src = source();
    const at = src.indexOf('function expandAndFocusSearch');
    const body = src.slice(at, at + 700);
    expect(body).toContain("getElementById('spaces-items-search-input')");
    expect(body).toContain("getElementById('spaces-sidebar-search-input')");
  });
});
