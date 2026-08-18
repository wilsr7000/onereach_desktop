/**
 * Regression tests for the 2026-08-06 pre-release review fixes.
 *
 * Two flavors, deliberately:
 *
 *   1. BEHAVIORAL — the tile preview loaders are reachable from jsdom
 *      through `buildItemCard` (no IntersectionObserver there, so the
 *      load is eager), so the negative cache and in-flight dedup are
 *      exercised for real by counting bridge calls.
 *
 *   2. WIRING — the state-machine functions (`setActiveScope`,
 *      `submitNewAsset`, boot handlers) need the full preload bridge,
 *      so those invariants are asserted against the SOURCE, matching
 *      the convention in `spaces-sharing-ui.test.ts`. These are weaker
 *      than behavioral tests — they prove the call is still wired, not
 *      that it behaves — but they do catch a silent refactor drop,
 *      which is how each of these bugs shipped in the first place.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../../spaces/spaces.js';

interface Handle {
  buildItemCard(item: unknown, active: boolean): HTMLElement;
}

function handle(): Handle {
  const w = window as unknown as { __spacesRendererForTesting?: Handle };
  if (w.__spacesRendererForTesting === undefined) {
    throw new Error('renderer test handle missing');
  }
  return w.__spacesRendererForTesting;
}

function item(overrides: Record<string, unknown>): unknown {
  return {
    id: `i-${Math.random().toString(36).slice(2)}`,
    title: 'Asset',
    kind: 'document',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    otherSpaces: [],
    producedBy: null,
    ...overrides,
  };
}

/** Install a bridge whose readFileData is counted + controllable. */
function installBridge(impl: () => Promise<unknown>): { calls: () => number } {
  let calls = 0;
  (window as unknown as { lite?: unknown }).lite = {
    spaces: {
      items: {
        readFileData: async (): Promise<unknown> => {
          calls++;
          return impl();
        },
      },
    },
  };
  return { calls: () => calls };
}

const tick = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
};

afterEach(() => {
  delete (window as unknown as { lite?: unknown }).lite;
});

beforeEach(() => {
  document.body.innerHTML = '';
});

// ─── Behavioral: negative cache + in-flight dedup ───────────────────────

describe('tile preview loaders — failure handling (review F1/F3)', () => {
  it('does NOT refetch a PDF whose read failed (negative cache)', async () => {
    // The bug: a broken key / over-cap file re-downloaded the WHOLE
    // file on every grid rebuild (≥1/min from background refresh) —
    // measured at ~GBs/hour for one oversized video.
    const key = `lite-spaces/assets/neg-${Date.now()}-broken.pdf`;
    const bridge = installBridge(async () => ({ ok: false, error: { message: 'HTTP 404' } }));

    handle().buildItemCard(item({ title: 'broken.pdf', fileKey: key }), false);
    await tick();
    expect(bridge.calls()).toBe(1);

    // Simulate the grid rebuilding: a brand-new card for the same key.
    handle().buildItemCard(item({ title: 'broken.pdf', fileKey: key }), false);
    await tick();
    expect(bridge.calls(), 'second rebuild must not refetch a known-bad key').toBe(1);
  });

  it('does NOT refetch an over-cap file (null value is a failure too)', async () => {
    const key = `lite-spaces/assets/cap-${Date.now()}-huge.pdf`;
    const bridge = installBridge(async () => ({ ok: true, value: null }));

    handle().buildItemCard(item({ title: 'huge.pdf', fileKey: key }), false);
    await tick();
    handle().buildItemCard(item({ title: 'huge.pdf', fileKey: key }), false);
    await tick();
    expect(bridge.calls()).toBe(1);
  });

  it('dedups concurrent loads of the same key (in-flight guard)', async () => {
    const key = `lite-spaces/assets/flight-${Date.now()}-doc.pdf`;
    let release: (v: unknown) => void = () => undefined;
    const gate = new Promise((r) => {
      release = r;
    });
    const bridge = installBridge(async () => {
      await gate;
      return { ok: false, error: { message: 'nope' } };
    });

    // Two renders straddling a frame — both fire before the first settles.
    handle().buildItemCard(item({ title: 'doc.pdf', fileKey: key }), false);
    handle().buildItemCard(item({ title: 'doc.pdf', fileKey: key }), false);
    expect(bridge.calls(), 'the second render must reuse the in-flight load').toBe(1);
    release(undefined);
    await tick();
  });

  it('caches the EMPTY verdict for a text file with no readable content', async () => {
    // An empty / binary-masquerading text file yielded excerpt '' and
    // was never cached → full refetch (up to 25MB) per rebuild.
    const key = `lite-spaces/assets/empty-${Date.now()}-notes.md`;
    const emptyDataUrl = `data:text/markdown;base64,${Buffer.from('   ', 'utf8').toString('base64')}`;
    const bridge = installBridge(async () => ({ ok: true, value: { dataUrl: emptyDataUrl } }));

    handle().buildItemCard(item({ title: 'notes.md', fileKey: key }), false);
    await tick();
    handle().buildItemCard(item({ title: 'notes.md', fileKey: key }), false);
    await tick();
    expect(bridge.calls()).toBe(1);
  });

  it('still renders a successful text preview and serves later cards from cache', async () => {
    const key = `lite-spaces/assets/ok-${Date.now()}-notes.md`;
    const dataUrl = `data:text/markdown;base64,${Buffer.from('# Hello there', 'utf8').toString('base64')}`;
    const bridge = installBridge(async () => ({ ok: true, value: { dataUrl } }));

    const first = handle().buildItemCard(item({ title: 'notes.md', fileKey: key }), false);
    await tick();
    expect(first.querySelector('.spaces-card-excerpt')?.textContent).toContain('# Hello there');

    const second = handle().buildItemCard(item({ title: 'notes.md', fileKey: key }), false);
    await tick();
    expect(bridge.calls(), 'cache hit — no second fetch').toBe(1);
    expect(second.querySelector('.spaces-card-excerpt')?.textContent).toContain('# Hello there');
  });
});

// ─── Wiring: invariants a refactor could silently drop ──────────────────

describe('review-fix wiring invariants (source-level)', () => {
  const source = (): string => {
    // cwd differs between running from lite/ and from the repo root.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('node:path') as typeof import('node:path');
    const candidates = [
      path.resolve('spaces/spaces.ts'),
      path.resolve('lite/spaces/spaces.ts'),
    ];
    const found = candidates.find((p) => fs.existsSync(p));
    if (found === undefined) throw new Error(`spaces.ts not found: ${candidates.join(', ')}`);
    return fs.readFileSync(found, 'utf8');
  };

  const bodyOf = (fnDecl: string, chars = 2500): string => {
    const src = source();
    const start = src.indexOf(fnDecl);
    expect(start, `${fnDecl} not found — renamed?`).toBeGreaterThan(-1);
    return src.slice(start, start + chars);
  };

  it('setActiveScope clears state.items (no cross-scope item leak)', () => {
    // The bug: Space A's grid rendered under Space B's header during
    // the fetch, and STUCK there permanently if B's fetch failed —
    // the user could open items that are not in the space shown.
    expect(
      /state\.items\s*=\s*\[\]/.test(bodyOf('function setActiveScope')),
      'setActiveScope must clear items, or the previous scope leaks into the new one'
    ).toBe(true);
  });

  it('the upload path only converts transcripts for dialogue-shaped extensions', () => {
    // The bug: a YAML/JSON file with repeated `key: value` lines could
    // detect as a transcript and be irreversibly rewritten on upload.
    const body = bodyOf('async function submitNewAsset', 12_000);
    expect(body).toMatch(/transcriptEligible/);
    expect(body).toMatch(/vtt\|srt\|txt\|text\|md\|markdown/);
  });

  it('the fatal overlay is gated to boot failures only', () => {
    // The gate itself now lives in the SHARED boot guard
    // (lite/renderer-boot.ts, extracted 2026-08-08 so every renderer
    // gets it); spaces.ts's contract is (a) boot through it and
    // (b) mark first paint after the first space-list render.
    const src = source();
    expect(src).toMatch(/bootRenderer\(\{/);
    expect(src).toMatch(/markSpacesBootSucceeded = ctx\.markBootSucceeded;/);
    expect(src).toMatch(/markSpacesBootSucceeded\(\);/);

    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const helper = [path.resolve('renderer-boot.ts'), path.resolve('lite/renderer-boot.ts')].find(
      (p) => fs.existsSync(p)
    );
    expect(helper, 'renderer-boot.ts not found — moved?').toBeDefined();
    const helperSrc = fs.readFileSync(helper as string, 'utf8');
    expect(helperSrc).toMatch(/if \(bootSucceeded\) return;/);
  });

  it('the agent-library search has a supersession guard', () => {
    // A slow priming query could land AFTER a typed query and
    // overwrite its results.
    const body = bodyOf('async function runAgentLibrarySearch');
    expect(body).toMatch(/\+\+agentLibrarySearchSeq/);
    expect(body).toMatch(/seq !== agentLibrarySearchSeq/);
    // …and a selection outside the new result set is dropped, so an
    // invisible pick can't silently drive Create.
    expect(body).toMatch(/agentLibrarySelection = null/);
  });

  it('no window.prompt survives in the Spaces renderer', () => {
    // Electron renderers do not implement prompt() at all — the app
    // toasts "prompt() is not supported" and the flow dead-ends. Two
    // member-access paths shipped this way and were caught only by
    // clicking (2026-08-06 driven pass).
    // Strip comments first — the fix notes MENTION window.prompt() in
    // prose, and a doc comment is not a call.
    const code = source()
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const hits = [...code.matchAll(/window\.prompt\s*\(/g)];
    expect(
      hits.length,
      'window.prompt is a no-op in Electron — use askForText / an inline panel instead'
    ).toBe(0);
  });

  it('EVERY exposure path runs the union-rule guardrail', () => {
    // 2026-08-07 review: the membership checkbox warned before making
    // a restricted-only asset account-visible, but "Move to…", bulk
    // move, and the AI-suggestion Add — rendered right next to it —
    // wrote silently. One shared helper now covers all of them.
    const src = source();
    expect(src).toMatch(/async function confirmExposureIfNeeded\(/);
    for (const fn of [
      'async function performMoveAsset',
      'async function performBulkMove',
    ]) {
      const body = bodyOf(fn, 3000);
      expect(
        /confirmExposureIfNeeded|wouldExposeRestrictedItem/.test(body),
        `${fn} must run the exposure guardrail before writing`
      ).toBe(true);
    }
    // The AI-suggestion Add button sits inside buildSuggestionRow.
    expect(bodyOf('function buildSuggestionRow', 3000)).toMatch(
      /confirmExposureIfNeeded/
    );
  });

  it('AI suggestions are validated against the candidates actually offered', () => {
    // Validating against every visible Space let a hallucinated/echoed
    // id resolve to a real OPEN Space and render an Add button.
    const src = source();
    expect(src).toMatch(/candidates\.find\(\(sp\) => sp\.id === s\.spaceId\)/);
    expect(src).not.toMatch(/state\.spaces\.find\(\(sp\) => sp\.id === s\.spaceId\)/);
  });

  it('an unchanged background refresh does not repaint the grid', () => {
    // "why is spaces keep refreshing or flashing?" (2026-08-07):
    // renderItemList tears the whole grid down with replaceChildren(),
    // so polling (15s) + the main-process cache broadcast (60s) rebuilt
    // every tile on a timer — re-instantiating PDF embeds and
    // re-decoding frame grabs and thumbnails. Unchanged data must be a
    // no-op now.
    const src = source();
    expect(src).toMatch(/function itemListSignature\(/);
    expect(src).toMatch(/let renderedItemsSignature/);
    const body = bodyOf('async function loadItems', 3500);
    expect(body).toMatch(/const unchanged =/);
    expect(body, 'an unchanged refresh must return before renderItemList').toMatch(
      /if \(unchanged\) return;/
    );
    // The loading paint must not tear down a populated grid either.
    expect(body).toMatch(/if \(state\.items\.length === 0\) \{\s*\n\s*renderItemList\(\{ loading: true \}\);/);
  });

  it('the scoped-events refetch only repaints when events changed', () => {
    const body = bodyOf('async function loadSpaceEvents', 2600);
    expect(body).toMatch(/eventsSignature\(/);
    expect(body).toMatch(/renderedEventsSignature/);
  });

  it('a scope switch always invalidates the paint fingerprint', () => {
    const body = bodyOf('function setActiveScope', 1600);
    expect(body).toMatch(/renderedItemsSignature = null/);
  });

  it('the identity bootstrap never manufactures a UUID-named Person', () => {
    // Found live: a session without email upserted Person{id: accountId,
    // name: accountId, email: ''} — every asset then read "Created by
    // (unknown)" and the Home timeline said "Someone added".
    const body = bodyOf('async function loadCurrentUser', 2200);
    expect(body).toMatch(/if \(email\.length === 0\) \{/);
    expect(body).toMatch(/skipping person bootstrap/);
    // The accountId-as-id fallback must be gone.
    expect(body).not.toMatch(/email\.length > 0 \? email : session\.accountId/);
  });

  it('creates carry creatorName so activity attributes a real person', () => {
    const src = source();
    expect(src).toMatch(/function readCurrentEditorName/);
    expect(src).toMatch(/\.\.\.\(creatorName !== null \? \{ creatorName \} : \{\}\),/);
  });

  it('the console forwarder drops the known PDF-plugin sandbox noise', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('node:path') as typeof import('node:path');
    const candidates = [path.resolve('spaces/window.ts'), path.resolve('lite/spaces/window.ts')];
    const found = candidates.find((p) => fs.existsSync(p));
    expect(found).toBeDefined();
    const src = fs.readFileSync(found as string, 'utf8');
    expect(src).toMatch(/sourceId \?\? ''\)\.includes\('sandbox_bundle'\)\) return;/);
  });

  it('explorer selection focuses the tile without a grid rebuild', () => {
    // "when I select an asset in the left menu it does not focus it in
    // the tile middle menu" (2026-08-08). Same-Space selections get no
    // repaint (the unchanged-refresh guard), so the focus must be a
    // targeted class toggle + scroll, and a scope-switch selection must
    // be honored by the NEXT paint via pendingTileFocusId.
    const src = source();
    expect(src).toMatch(/export function focusItemTile\(/);
    const explorerClick = src.indexOf('setActiveScope(spaceId);\n        void loadItemDetail(item.id);');
    expect(explorerClick).toBeGreaterThan(-1);
    expect(src.slice(explorerClick, explorerClick + 500)).toContain('focusItemTile(item.id)');
    expect(src.slice(explorerClick, explorerClick + 500)).toContain('pendingTileFocusId = item.id');
    // renderItemList honors the pending focus after painting.
    const render = bodyOf('function renderItemList', 9000);
    expect(render).toContain('pendingTileFocusId !== null && focusItemTile(pendingTileFocusId)');
  });

  it('focusItemTile moves is-active and reports absence honestly', () => {
    document.body.innerHTML = `
      <section id="spaces-items-region">
        <article class="spaces-card is-active" data-item-id="a"></article>
        <article class="spaces-card" data-item-id="b"></article>
      </section>`;
    const w = window as unknown as {
      __spacesRendererForTesting?: { focusItemTile?: (id: string) => boolean };
    };
    const focus = w.__spacesRendererForTesting?.focusItemTile;
    expect(focus, 'focusItemTile must be on the test handle').toBeDefined();
    if (focus === undefined) return;
    expect(focus('b')).toBe(true);
    expect(
      document.querySelector('[data-item-id="b"]')?.classList.contains('is-active')
    ).toBe(true);
    expect(
      document.querySelector('[data-item-id="a"]')?.classList.contains('is-active')
    ).toBe(false);
    expect(focus('missing')).toBe(false);
  });

  it('RECENT is a flat jump list — no trees, no chevrons (ADR-071)', () => {
    // Supersedes the 2026-08-08 expanded-by-default rule: the item tree
    // lives solely in the Spaces section's ONE open space. Recent rows
    // only jump; a second explorer was half the sidebar's busy-ness.
    const body = bodyOf('function renderRecentSpaces', 3500);
    expect(body).toContain('spaces-row-recent');
    expect(body).not.toContain('buildSpaceChildren');
    expect(body).not.toContain('collapsedRecentTrees');
    expect(body).not.toContain('spaces-row-expand');
  });

  it('sidebar review fixes: cache-safe trees, quiet re-renders, honest search clears', () => {
    const src = source();
    // F1 HIGH: the tree must share the grid's exact call shape — a
    // custom {limit:30} poisoned the shared per-scope cache and
    // truncated the OPEN grid to 30 items on the next refresh.
    const tree = bodyOf('async function loadSpaceChildren', 2200);
    expect(tree).not.toContain('{ limit: 30 }');
    expect(tree).toContain('.slice(0, 30)');
    // F2: unchanged space data must not rebuild the sidebar (每 60s the
    // cache broadcast fired a full teardown + one IPC per expanded tree).
    expect(src).toMatch(/let renderedSpacesSignature/);
    const render = bodyOf('function renderSpaceList(): void {', 400);
    expect(render).toContain('if (nextSignature === renderedSpacesSignature) return;');
    // F3: both clear paths supersede in-flight searches.
    const sched = bodyOf('function scheduleGlobalItemSearch', 900);
    expect(sched).toMatch(/globalSearchSeq\+\+;[\s\S]{0,120}renderGlobalSearchResults\(null\)/);
    // F4: keyboard activation for role=button rows.
    expect(src).toContain("if (event.key !== 'Enter' && event.key !== ' ') return;");
    // Scope switch cancels a stale pending tile focus.
    expect(bodyOf('function setActiveScope', 1800)).toContain('pendingTileFocusId = null;');
  });

  it('graph-controlled colors cannot become network beacons', () => {
    const w = window as unknown as {
      __spacesRendererForTesting?: { safeCssColor?: (v: unknown) => string | null };
    };
    const safe = w.__spacesRendererForTesting?.safeCssColor;
    expect(safe, 'safeCssColor must be on the test handle').toBeDefined();
    if (safe === undefined) return;
    expect(safe('#8b5cf6')).toBe('#8b5cf6');
    expect(safe('rgb(1, 2, 3)')).toBe('rgb(1, 2, 3)');
    expect(safe('rebeccapurple')).toBe('rebeccapurple');
    expect(safe('url("https://attacker.example/beacon")')).toBeNull();
    expect(safe('red; background-image: url(https://x)')).toBeNull();
    expect(safe(12)).toBeNull();
    expect(safe('a'.repeat(80))).toBeNull();
    // No raw graph-color assignment may remain.
    const src = source();
    expect(src).not.toMatch(/style\.background = (space|chip)\.color/);
  });

  it('tile excerpts strip markdown noise so tiles read as prose', async () => {
    // 2026-08-08 sweep, found live: a `**Type:** …` / `# Heading`
    // asset showed literal ** and # in its tile.
    const mod = await import('../../spaces/spaces.js') as unknown as {
      stripMarkdownForExcerpt(t: string): string;
      tileExcerptText(e: string | undefined): string | null;
    };
    expect(mod.stripMarkdownForExcerpt('**Type:** Feature request')).toBe('Type: Feature request');
    expect(mod.stripMarkdownForExcerpt('# Heading\n- one\n- two')).toBe('Heading one two');
    expect(mod.stripMarkdownForExcerpt('see `code` and [a link](http://x)')).toBe('see code and a link');
    // data: stubs still rejected.
    expect(mod.tileExcerptText('data:image/png;base64,AAAA')).toBeNull();
    // plain prose passes through unchanged.
    expect(mod.tileExcerptText('Just a normal note.')).toBe('Just a normal note.');
  });

  it('the sweep fixes are wired into the renderer', () => {
    const src = source();
    // Filtered-empty vs truly-empty are distinct states now.
    expect(src).toContain('function buildFilteredEmptyState');
    expect(src).toMatch(/scopeVisibleItems\.length > 0 && state\.homeFilter !== 'all'/);
    // Checklists library says so instead of spinning forever.
    expect(src).toContain('Checklists need a newer build of Lite');
    // Image tiles + detail get an error fallback.
    expect(src).toMatch(/img\.addEventListener\('error'/);
    // Sidebar surfaces route titles through the hash-id guard.
    const tree = bodyOf('async function loadSpaceChildren', 2400);
    expect(tree).toContain('generateItemTitle(item)');
  });

  it('cross-machine staleness: watchdog + visibilitychange are wired', () => {
    // 2026-08-16: "I added a user to a space but it did not show up in
    // their spaces manager until they reopened Spaces." Two gaps: the
    // 60s cache refresh fails silently when the graph flakes, and
    // focus-refresh only fires on focus TRANSITIONS. The watchdog
    // surfaces the silence and self-heals; visibilitychange covers
    // arrivals that never change focus.
    const src = source();
    expect(src).toMatch(/function wireStalenessWatchdog/);
    expect(src).toMatch(/markCacheBroadcast\(\);\s*\n\s*routeCacheUpdate\(update\.key\);/);
    expect(src).toMatch(/document\.addEventListener\('visibilitychange'/);
    expect(src).toMatch(/wireStalenessWatchdog\(\);/);
    const start = src.indexOf('function wireStalenessWatchdog');
    const body = src.slice(start, start + 900);
    expect(body).toContain("refreshFromGraph('focus')");
  });

  it('refreshFromGraph cannot wedge its coalescing flag on a hung IPC', () => {
    // 2026-08-17: one hung bridge.refresh() left refreshInFlight true
    // forever — focus-refresh and the staleness watchdog both dead
    // silently. The Promise.race guarantees the finally clears it.
    const body = bodyOf('async function refreshFromGraph', 2200);
    expect(body).toMatch(/Promise\.race\(/);
    expect(body).toMatch(/refresh timed out/);
  });

  it('the existing-asset search has a supersession guard too', () => {
    const body = bodyOf('async function runExistingAssetSearch');
    expect(body).toMatch(/\+\+existingSearchSeq/);
    expect(body).toMatch(/seq !== existingSearchSeq/);
  });
});

describe('checklist progress label (required-aware)', () => {
  it('familiar when uniform, required-aware when mixed', async () => {
    const mod = await import('../../spaces/spaces.js');
    const label = (mod as unknown as {
      checklistProgressLabel(l: unknown): string;
    }).checklistProgressLabel;
    expect(
      label({ checkedIndexes: [0, 2], checklist: { items: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] } })
    ).toBe('2/3');
    expect(
      label({
        checkedIndexes: [0, 1],
        checklist: {
          items: [{ text: 'a' }, { text: 'b', optional: true }, { text: 'c' }],
        },
      })
    ).toBe('1/2 required · 1 optional done');
  });
});

// ─── Shared-dashboard error states (2026-08-08 review) ───────────────────
//
// The bug: loadSharedSpaceDashboard mapped failed tickets/members reads
// to [] and swallowed the catch — a failing members query rendered as
// "No members yet" on a multi-user surface. The builders now take the
// recorded per-section error and render a distinct banner; the empty-
// state copy is reserved for reads that actually succeeded.

interface DashboardBuilders {
  buildSharedMembersRow(space: unknown, members: unknown[], loadError?: string): HTMLElement;
  buildSharedDashboardPlaybook(
    space: unknown,
    playbook: unknown,
    loadError?: string
  ): HTMLElement;
  buildSharedDashboardTickets(
    space: unknown,
    tickets: unknown[],
    loading: boolean,
    loadError?: string
  ): HTMLElement;
}

function dashboardBuilders(): DashboardBuilders {
  return handle() as unknown as DashboardBuilders;
}

const SPACE = { id: 'sp-err', name: 'Team Space' };

describe('shared-dashboard sections — a failed read is not an empty list', () => {
  it('members: error renders a banner, never "No members yet"', () => {
    const row = dashboardBuilders().buildSharedMembersRow(SPACE, [], 'HTTP 500');
    const banner = row.querySelector('.spaces-banner-error');
    expect(banner?.textContent).toContain("Couldn't load members");
    expect(banner?.textContent).toContain('HTTP 500');
    expect(row.textContent).not.toContain('No members yet');
  });

  it('members: a successful empty read keeps the familiar empty state', () => {
    const row = dashboardBuilders().buildSharedMembersRow(SPACE, []);
    expect(row.querySelector('.spaces-banner-error')).toBeNull();
    expect(row.textContent).toContain('No members yet');
  });

  it('tickets: error renders a banner, never "No tickets yet"', () => {
    const section = dashboardBuilders().buildSharedDashboardTickets(
      SPACE,
      [],
      false,
      'query failed'
    );
    const banner = section.querySelector('.spaces-banner-error');
    expect(banner?.textContent).toContain("Couldn't load tickets");
    expect(section.textContent).not.toContain('No tickets yet');
  });

  it('tickets: a successful empty read keeps the CTA empty state', () => {
    const section = dashboardBuilders().buildSharedDashboardTickets(SPACE, [], false);
    expect(section.querySelector('.spaces-banner-error')).toBeNull();
    expect(section.textContent).toContain('No tickets yet');
  });

  it('playbook: error renders a banner, never the "No playbook set" coaching', () => {
    const section = dashboardBuilders().buildSharedDashboardPlaybook(SPACE, null, 'nope');
    const banner = section.querySelector('.spaces-banner-error');
    expect(banner?.textContent).toContain("Couldn't load the playbook");
    expect(section.textContent).not.toContain('No playbook set');
  });

  it('playbook: a successful null read keeps the coaching empty state', () => {
    const section = dashboardBuilders().buildSharedDashboardPlaybook(SPACE, null);
    expect(section.querySelector('.spaces-banner-error')).toBeNull();
    expect(section.textContent).toContain('No playbook set');
  });
});

describe('loadSharedSpaceDashboard wiring (source-level)', () => {
  const source = (): string => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('node:path') as typeof import('node:path');
    const candidates = [path.resolve('spaces/spaces.ts'), path.resolve('lite/spaces/spaces.ts')];
    const found = candidates.find((p) => fs.existsSync(p));
    if (found === undefined) throw new Error(`spaces.ts not found: ${candidates.join(', ')}`);
    return fs.readFileSync(found, 'utf8');
  };

  it('records per-section envelope failures, logs them, and keeps prior data', () => {
    const src = source();
    const start = src.indexOf('async function loadSharedSpaceDashboard');
    expect(start, 'loader not found — renamed?').toBeGreaterThan(-1);
    const body = src.slice(start, start + 4000);
    // Each failed section records its message instead of faking [].
    expect(body).toMatch(/errors\.playbook = playbookRes\.error\.message/);
    expect(body).toMatch(/errors\.tickets = ticketsRes\.error\.message/);
    expect(body).toMatch(/errors\.members = membersRes\.error\.message/);
    // …logs it…
    expect(body).toMatch(/'shared-dashboard tickets load failed'/);
    expect(body).toMatch(/'shared-dashboard members load failed'/);
    // …keeps the last good data (stale beats blank on a shared surface)…
    expect(body).toMatch(/prior\?\.tickets \?\? \[\]/);
    expect(body).toMatch(/prior\?\.members \?\? \[\]/);
    // …and the catch is no longer silent.
    expect(body).toMatch(/'shared-dashboard load threw'/);
  });
});

describe('shared-dashboard fetch loop (2026-08-17 bandwidth incident)', () => {
  const source = (): string => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('node:path') as typeof import('node:path');
    const found = ['spaces/spaces.ts', 'lite/spaces/spaces.ts']
      .map((r) => path.resolve(r))
      .find((f) => fs.existsSync(f));
    if (found === undefined) throw new Error('spaces.ts not found');
    return fs.readFileSync(found, 'utf8');
  };

  it('rendering never unconditionally triggers a dashboard fetch', () => {
    // The loop: renderSharedSpaceDashboard → loadSharedSpaceDashboard →
    // (success AND failure) renderItemList → renderSharedSpaceDashboard →
    // fetch again. Three-to-four Neon queries per lap at network speed,
    // for as long as a shared Space is on screen. Reported live as
    // "connection issues to NEON" + rising bandwidth + forced quit.
    const src = source();
    const start = src.indexOf('function renderSharedSpaceDashboard');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}', start));
    // The fetch must be INSIDE the staleness guard, not beside it.
    expect(body).toMatch(
      /if \(sharedDashboardIsStale\(space\.id\)\) \{\s*\n\s*void loadSharedSpaceDashboard\(space\.id\);/
    );
  });

  it('the loader is re-entrancy guarded and always releases', () => {
    const src = source();
    const start = src.indexOf('async function loadSharedSpaceDashboard');
    const body = src.slice(start, src.indexOf('\nasync function cycleTicketStatus', start));
    expect(body).toContain('sharedDashboardInFlight.has(spaceId)');
    expect(body).toContain('sharedDashboardInFlight.add(spaceId)');
    // Released in a finally so a throw can't wedge the guard forever.
    expect(body).toMatch(/finally \{\s*\n\s*sharedDashboardInFlight\.delete\(spaceId\);/);
  });

  it('the checklist library is cached, not refetched per render', () => {
    const src = source();
    expect(src).toContain('checklistLibraryCache');
    expect(src).toContain('checklistLibraryInFlight');
    const start = src.indexOf('export function buildSharedDashboardChecklists');
    const body = src.slice(start, start + 3000);
    // Serves from cache inside the TTL…
    expect(body).toContain('SHARED_DASHBOARD_TTL_MS');
    // …and mutations force a refetch rather than showing stale data.
    expect(body).toContain('refresh(true)');
  });
});
