/**
 * Seed script registry -- the deterministic, versioned starting points
 * for GSX UI navigation.
 *
 * Seeds are conservative by design: mostly navigate + assert, with
 * selector guesses carrying text fallbacks. When GSX's UI drifts and a
 * seed fails, the repair loop (see `repair.ts` + `store.ts`) generates
 * a `learned` variant from a live page snapshot -- the seed itself is
 * never mutated, so there is always a known-good(ish) floor to fall
 * back to when a learned variant rots.
 *
 * URL templates use `{env}` and `{accountId}` built-ins (substituted at
 * run time from the signed-in session, mirroring
 * `lite/main-window/home-url-store.ts`'s `{accountId}` idiom).
 *
 * @internal -- consumers list/fetch scripts via `api.ts`.
 */

import type { GsxScript } from './types.js';

/** Studio origin template every seed resolves against. */
export const GSX_STUDIO_ORIGIN_TEMPLATE = 'https://studio.{env}.onereach.ai';

/**
 * The built-in deterministic scripts. Frozen: `saveScript` refuses
 * writes to these ids with source `seed` -- learned variants shadow
 * them instead.
 */
export const GSX_SEED_SCRIPTS: ReadonlyArray<GsxScript> = [
  {
    id: 'designer.open',
    title: 'Open GSX Designer',
    description:
      'Open the GSX studio root for the signed-in account and verify the app shell rendered.',
    version: 1,
    source: 'seed',
    steps: [
      { kind: 'navigate', url: `${GSX_STUDIO_ORIGIN_TEMPLATE}/?accountId={accountId}` },
      { kind: 'waitFor', selector: '#app, #root, [data-app], main', timeoutMs: 20_000 },
      { kind: 'assertUrl', pattern: 'studio\\.[a-z-]+\\.onereach\\.ai' },
      {
        kind: 'assertVisible',
        selector: 'nav, [role="navigation"], [class*="nav"], [class*="sidebar"]',
        description: 'Studio navigation chrome is visible',
        timeoutMs: 15_000,
      },
    ],
  },
  {
    id: 'flows.list',
    title: 'Open the Flows list',
    description: 'Navigate to the studio Flows view and verify a flow list rendered.',
    version: 1,
    source: 'seed',
    steps: [
      { kind: 'navigate', url: `${GSX_STUDIO_ORIGIN_TEMPLATE}/flows?accountId={accountId}` },
      { kind: 'waitFor', selector: '#app, #root, main', timeoutMs: 20_000 },
      { kind: 'assertUrl', pattern: '/flows' },
      {
        kind: 'assertVisible',
        selector: '[class*="flow"], [data-testid*="flow"], table, [role="list"]',
        description: 'A flows collection is visible',
        timeoutMs: 15_000,
      },
    ],
  },
  {
    id: 'flows.open-by-name',
    title: 'Open a flow by name',
    description:
      'From the Flows list, click the flow whose visible name matches {flowName} and verify the designer canvas opened.',
    version: 1,
    source: 'seed',
    params: ['flowName'],
    steps: [
      { kind: 'navigate', url: `${GSX_STUDIO_ORIGIN_TEMPLATE}/flows?accountId={accountId}` },
      { kind: 'waitFor', selector: '#app, #root, main', timeoutMs: 20_000 },
      {
        kind: 'click',
        selector: '[data-flow-name="{flowName}"]',
        textFallback: ['{flowName}'],
        timeoutMs: 15_000,
      },
      { kind: 'wait', ms: 1_000 },
      {
        kind: 'assertVisible',
        selector: '[class*="canvas"], [class*="designer"], [class*="editor"], svg',
        description: 'A designer canvas/editor surface is visible',
        timeoutMs: 20_000,
      },
    ],
  },
  {
    id: 'files.open',
    title: 'Open GSX Files',
    description: 'Navigate to the studio Files view for the signed-in account.',
    version: 1,
    source: 'seed',
    steps: [
      { kind: 'navigate', url: `${GSX_STUDIO_ORIGIN_TEMPLATE}/files?accountId={accountId}` },
      { kind: 'waitFor', selector: '#app, #root, main', timeoutMs: 20_000 },
      { kind: 'assertUrl', pattern: '/files' },
    ],
  },
];

/** Fast lookup of a seed by id. */
export function findSeedScript(id: string): GsxScript | null {
  return GSX_SEED_SCRIPTS.find((s) => s.id === id) ?? null;
}
