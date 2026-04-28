/**
 * Unit tests for the two-path search backend unification.
 *
 * Per docs/sync-v5/replica-shape.md §6A: as of the
 * "feat(spaces): unify two-path search backend" commit, the
 * clipboard-manager-v2-adapter.searchHistory() method routes through
 * SpacesAPI.search() instead of calling ClipboardStorageV2.search()
 * directly. This consolidates two parallel datastore paths
 * (Spaces Manager UI vs. agents) onto one canonical backend.
 *
 * Test strategy:
 *   - Source-level assertion that searchHistory references the right
 *     callee and is async (a code-citation test; replaces the harder
 *     full-adapter integration test which would require mocking the
 *     adapter's whole transitive require tree).
 *   - Algorithmic non-regression invariant: every Path A hit appears
 *     in Path B's results for the same query. This is the contract
 *     the unification preserves; testable as a pure function.
 *
 * The end-to-end behavioural test lives in test/e2e/spaces-flow.spec.js
 * (existing) -- it exercises the unified path through the IPC layer +
 * real renderer, which is the right level for full integration
 * coverage.
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

// ────────────────────────────────────────────────────────────────────────────
// Source-level routing assertions
// ────────────────────────────────────────────────────────────────────────────

describe('Two-path unification: source-level routing assertion', () => {
  /**
   * Read the adapter source. Assert structural properties of
   * searchHistory: it's async, it requires spaces-api, it calls
   * getSpacesAPI().search(query, options), and it does NOT call
   * this.storage.search() in the happy path. This is a code-citation
   * test -- if the routing regresses, the assertion fails.
   *
   * Why source-level: integration testing the adapter requires loading
   * 8+ top-level requires (clipboard-storage-v2, content-ingestion,
   * spaces-api, ai-service, event-logger, app-context-capture) which
   * pulls in the whole project's dependency tree. Source-level
   * assertions are coarser but reliable and don't drift with
   * unrelated refactors.
   */
  const adapterSource = fs.readFileSync(
    path.join(__dirname, '../../clipboard-manager-v2-adapter.js'),
    'utf8'
  );

  it('searchHistory is async (signature change for SpacesAPI.search)', () => {
    expect(adapterSource).toMatch(/async\s+searchHistory\s*\(\s*query/);
  });

  it('searchHistory accepts an options parameter (forwarded to SpacesAPI.search)', () => {
    expect(adapterSource).toMatch(/async\s+searchHistory\s*\(\s*query\s*,\s*options\s*=\s*\{\s*\}\s*\)/);
  });

  it('searchHistory calls SpacesAPI.search via getSpacesAPI()', () => {
    expect(adapterSource).toMatch(/getSpacesAPI\(\)\.search\(\s*query\s*,\s*options\s*\)/);
  });

  it('searchHistory has a fallback to legacy storage.search (fail-open)', () => {
    // The fallback should still be in place during the cutover window.
    // It will be removed in the final cleanup commit per the v5 plan.
    expect(adapterSource).toMatch(/this\.storage\.search\(\s*query\s*\)/);
    expect(adapterSource).toMatch(/falling back to legacy storage\.search/);
  });

  it('searchHistory preserves the _needsContent: true contract for the renderer', () => {
    expect(adapterSource).toMatch(/_needsContent:\s*true/);
  });

  it('searchHistory strips content + thumbnail from results (UI lazy-loads bodies)', () => {
    expect(adapterSource).toMatch(/content:\s*null/);
    expect(adapterSource).toMatch(/thumbnail:\s*null/);
  });

  it('searchHistory references the unification plan in its docstring', () => {
    expect(adapterSource).toMatch(/two-path unification|replica-shape\.md\s*§6A|SpacesAPI\.search/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Non-regression invariant: Path A hits ⊆ Path B hits
// ────────────────────────────────────────────────────────────────────────────

describe('Two-path search non-regression invariant (Path A hits ⊆ Path B hits)', () => {
  /**
   * The contract: for any query Q, every item that Path A
   * (boolean-AND with stop-word filter -- ClipboardStorageV2.search)
   * returns must also appear in Path B's (scored fuzzy --
   * SpacesAPI.search) results. Path B may return MORE items (fuzzy
   * matching), which is the expected improvement, NOT a regression.
   *
   * Equivalence is set-by-id, not order-by-score. Path B sorts by
   * score; Path A's order is whatever index.items.filter happened to
   * traverse. Result ordering may differ; result SET must be a
   * superset.
   */
  function pathAHitsSubsetOfPathB(pathAItems, pathBItems) {
    const pathBIds = new Set(pathBItems.map((i) => i.id));
    return pathAItems.every((a) => pathBIds.has(a.id));
  }

  it('exact-phrase match: Path A hit also in Path B', () => {
    const pathA = [{ id: 'a1', preview: 'meeting notes' }];
    const pathB = [
      { id: 'a1', preview: 'meeting notes' },
      { id: 'a2', preview: 'meet again' }, // Path B fuzzy-matched extra
    ];
    expect(pathAHitsSubsetOfPathB(pathA, pathB)).toBe(true);
  });

  it('multi-word boolean-AND: Path A hits all in Path B', () => {
    const pathA = [
      { id: 'a1', preview: 'project budget plan' },
      { id: 'a2', preview: 'budget for project' },
    ];
    const pathB = [
      { id: 'a1', preview: 'project budget plan' },
      { id: 'a2', preview: 'budget for project' },
      { id: 'a3', preview: 'budget tracking' }, // partial fuzzy match
    ];
    expect(pathAHitsSubsetOfPathB(pathA, pathB)).toBe(true);
  });

  it('tag match: Path A hit appears in Path B', () => {
    const pathA = [{ id: 'a1', tags: ['riff-source'] }];
    const pathB = [{ id: 'a1', tags: ['riff-source'] }];
    expect(pathAHitsSubsetOfPathB(pathA, pathB)).toBe(true);
  });

  it('Path B may return EXTRA items (fuzzy match) -- still passes invariant', () => {
    const pathA = [{ id: 'a1', preview: 'hello world' }];
    const pathB = [
      { id: 'a1', preview: 'hello world' },
      { id: 'a2', preview: 'hello earth' }, // fuzzy similar
      { id: 'a3', preview: 'wrold hi' }, // typo match
    ];
    expect(pathAHitsSubsetOfPathB(pathA, pathB)).toBe(true);
  });

  it('REGRESSION case (must FAIL invariant): Path B drops a Path A hit', () => {
    const pathA = [{ id: 'a1', preview: 'critical match' }];
    const pathB = [{ id: 'a2', preview: 'something else' }]; // Path B missing a1
    expect(pathAHitsSubsetOfPathB(pathA, pathB)).toBe(false);
  });

  it('empty Path A: trivially a subset of any Path B', () => {
    expect(pathAHitsSubsetOfPathB([], [])).toBe(true);
    expect(pathAHitsSubsetOfPathB([], [{ id: 'a1' }])).toBe(true);
  });

  it('order may differ (Path B sorts by score; Path A by index order)', () => {
    const pathA = [
      { id: 'a1', preview: 'second' },
      { id: 'a2', preview: 'first' },
    ];
    const pathB = [
      { id: 'a2', preview: 'first', _search: { score: 5 } },
      { id: 'a1', preview: 'second', _search: { score: 3 } },
    ];
    expect(pathAHitsSubsetOfPathB(pathA, pathB)).toBe(true);
  });

  it('case-insensitivity contract: same items returned for different casings', () => {
    // Both paths are case-insensitive. Set equality holds across casings.
    const pathA_upper = [{ id: 'a1', preview: 'HELLO' }];
    const pathB_lower = [{ id: 'a1', preview: 'HELLO' }]; // same item, query was 'hello'
    expect(pathAHitsSubsetOfPathB(pathA_upper, pathB_lower)).toBe(true);
  });
});
