/**
 * @vitest-environment jsdom
 *
 * ADR-072 phase 2 — a journey map is an ASSET, reachable like one.
 *
 * The first phase made journeys writable (Planning → compose → save).
 * That left them creatable from exactly one menu and openable in
 * nothing: the real Builder had no way to read or write the Space, so a
 * journey in NEON was a dead end. This file pins the round-trip:
 *
 *   1. create one from the Space that will hold it (right-click),
 *   2. open an existing one in the Builder (detail-pane bridge),
 *   3. the Builder's bridge can list / load / save / update — and can
 *      reach NOTHING else.
 *
 * (3) is the load-bearing one. The Builder is hosted content; the day
 * that preload grows a general graph call, a page we don't build gets
 * the run of the graph.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

function read(...candidates: string[]): string {
  const found = candidates.map((p) => resolve(p)).find((p) => existsSync(p));
  if (found === undefined) throw new Error(`not found: ${candidates.join(', ')}`);
  return readFileSync(found, 'utf8');
}

const renderer = (): string => read('spaces/spaces.ts', 'lite/spaces/spaces.ts');
const preload = (): string => read('preload-journey-map.ts', 'lite/preload-journey-map.ts');
const windowSrc = (): string => read('journey-map-window.ts', 'lite/journey-map-window.ts');

describe('creating a journey from the Space that will hold it', () => {
  it('the space right-click offers New journey map…', async () => {
    const mod = await import('../../spaces/spaces.js');
    const noop = (): void => undefined;
    let fired = 0;
    const entries = mod.buildSpaceContextEntries(
      { id: 's1', name: 'S', visibility: 'open', kind: 'user' } as never,
      {
        share: noop, unshare: noop, addPeople: noop, upload: noop, rename: noop,
        editObjective: noop, convertShared: noop, convertUser: noop, setPlaybook: noop,
        newJourney: () => { fired += 1; },
        sendToMemory: noop,
        deleteSpace: noop, togglePin: noop,
      }
    );
    const entry = entries.find((e) => e.type === 'action' && e.label === 'New journey map…');
    expect(entry, 'New journey map… missing from the space menu').toBeDefined();
    if (entry?.type !== 'action') throw new Error('not an action');
    entry.run();
    expect(fired).toBe(1);
  });

  it('the composer files into the Space that was RIGHT-CLICKED, not the active one', () => {
    const s = renderer();
    // A menu on space B that saves into space A is a data-loss bug that
    // looks like a no-op. The parameter is the fix; pin both halves.
    expect(s).toContain('openJourneyComposer(targetSpaceId?: string)');
    expect(s).toContain('const spaceId = targetSpaceId ?? state.activeScopeId');
    expect(s).toContain('void openJourneyComposer(space.id)');
  });
});

describe('opening an existing journey in the Builder', () => {
  it('the detail pane offers the bridge for journeys, mirroring WISER', () => {
    const s = renderer();
    const i = s.indexOf("if (item.kind === 'journey') {");
    expect(i, 'no journey branch in the detail pane').toBeGreaterThan(-1);
    const block = s.slice(i, i + 1200);
    expect(block).toContain('journeyOpenBridge()');
    expect(block).toContain('Open in Journey Map Builder');
    expect(block).toContain('openJourney(item.id)');
  });

  it('the bridge is optional — an older preload hides the button, never throws', () => {
    const s = renderer();
    const i = s.indexOf('function journeyOpenBridge(');
    expect(i).toBeGreaterThan(-1);
    const block = s.slice(i, i + 400);
    expect(block).toContain("typeof spaces.openJourneyMap !== 'function'");
    expect(block).toContain('return null');
  });

  it('the target survives a window that is already open', () => {
    const s = windowSrc();
    // Focusing an open window without forwarding the id would silently
    // ignore the second click.
    expect(s).toContain("win.webContents.send('lite:journey-map:target'");
    // ...and reading it clears it, so a later plain open is plain.
    const i = s.indexOf('export function takeJourneyTarget(');
    expect(i).toBeGreaterThan(-1);
    expect(s.slice(i, i + 220)).toContain('pendingTargetId = null');
  });
});

describe('the Builder bridge is narrow by construction', () => {
  const ALLOWED = [
    'lite:spaces:listSpaces',
    'lite:spaces:items:list',
    'lite:spaces:items:get',
    'lite:spaces:journeys:create',
    'lite:spaces:items:update',
    'lite:journey-map:takeTarget',
    'lite:journey-map:target',
  ];

  it('exposes journeySpaces — never the full lite bridge', () => {
    const s = preload();
    expect(s).toContain("exposeInMainWorld('journeySpaces'");
    expect(s).not.toContain("exposeInMainWorld('lite'");
  });

  it('every channel it can reach is on the allow-list', () => {
    const s = preload();
    const channels = [...s.matchAll(/'(lite:[a-zA-Z:.-]+)'/g)].map((m) => m[1] as string);
    expect(channels.length).toBeGreaterThan(4); // the detector itself
    const extra = channels.filter((c) => !ALLOWED.includes(c));
    expect(
      [...new Set(extra)],
      'the Journey Map bridge reached a channel outside its allow-list'
    ).toEqual([]);
  });

  it('the window attaches THIS preload, and stays sandboxed', () => {
    const s = windowSrc();
    expect(s).toContain("preload: join(__dirname, 'preload-journey-map.js')");
    expect(s).toContain('sandbox: true');
    expect(s).toContain('nodeIntegration: false');
    expect(s).toContain('contextIsolation: true');
  });

  it('journeys stay a first-class item kind (the tile/preview contract)', async () => {
    const types = await import('../../spaces/types.js');
    expect(types.ITEM_KINDS).toContain('journey');
  });
});
