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
    const src = source();
    expect(src).toMatch(/if \(spacesBootSucceeded\) return;/);
    expect(src).toMatch(/spacesBootSucceeded = true;/);
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

  it('the existing-asset search has a supersession guard too', () => {
    const body = bodyOf('async function runExistingAssetSearch');
    expect(body).toMatch(/\+\+existingSearchSeq/);
    expect(body).toMatch(/seq !== existingSearchSeq/);
  });
});
