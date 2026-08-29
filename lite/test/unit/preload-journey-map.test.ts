/**
 * The `window.journeySpaces` bridge handed to the hosted Journey Map
 * Builder (ADR-072 phase 2).
 *
 * This is the one place a page we do not build talks to the graph, so
 * the bridge is the blast radius. `spaces-journey-asset.test.ts` scans
 * the source for channel names — good, and it stops there. What it can't
 * see is what the functions DO: whether an error envelope becomes an
 * exception inside someone else's app, whether a Space's full record
 * leaks through `listSpaces`, whether `listJourneys` actually filters to
 * journeys, whether a junk push from the main process reaches the page.
 *
 * Every method is driven here against a scripted IPC layer, and every
 * channel it reaches is checked at RUNTIME against the allow-list.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
  type Handler = (payload?: unknown) => unknown;
  const state = {
    exposed: null as Record<string, unknown> | null,
    invokes: [] as Array<{ channel: string; payload: unknown }>,
    replies: new Map<string, Handler>(),
    listeners: new Map<string, Array<(event: unknown, payload: unknown) => void>>(),
  };
  return { state };
});

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: Record<string, unknown>): void => {
      if (key === 'journeySpaces') h.state.exposed = api;
    },
  },
  ipcRenderer: {
    invoke: (channel: string, payload?: unknown): Promise<unknown> => {
      h.state.invokes.push({ channel, payload });
      const reply = h.state.replies.get(channel);
      return Promise.resolve(reply === undefined ? { ok: false } : reply(payload));
    },
    on: (channel: string, fn: (event: unknown, payload: unknown) => void): void => {
      const arr = h.state.listeners.get(channel) ?? [];
      arr.push(fn);
      h.state.listeners.set(channel, arr);
    },
  },
}));

/** Channels the Builder is allowed to reach. Anything else is a breach. */
const ALLOWED_CHANNELS = [
  'lite:spaces:listSpaces',
  'lite:spaces:items:list',
  'lite:spaces:items:get',
  'lite:spaces:journeys:create',
  'lite:spaces:items:update',
  'lite:journey-map:takeTarget',
];

interface JourneyBridge {
  available: boolean;
  listSpaces(): Promise<Array<{ id: string; name: string }>>;
  listAssets(
    spaceId?: string
  ): Promise<Array<{ id: string; title: string; kind: string; spaceId: string; updatedAt?: string }>>;
  listJourneys(
    spaceId?: string
  ): Promise<Array<{ id: string; title: string; spaceId?: string; updatedAt?: string }>>;
  load(
    itemId: string
  ): Promise<{ id: string; title: string; content: string; description?: string } | null>;
  save(spaceId: string, draft: unknown): Promise<{ ok: boolean; id?: string; error?: string }>;
  update(
    itemId: string,
    patch: { title?: string; content?: string; description?: string }
  ): Promise<{ ok: boolean; error?: string }>;
  openTarget(): Promise<string | null>;
  onOpenTarget(fn: (itemId: string) => void): void;
}

let bridge: JourneyBridge;

beforeEach(async () => {
  vi.resetModules();
  h.state.exposed = null;
  h.state.invokes = [];
  h.state.replies = new Map();
  h.state.listeners = new Map();
  await import('../../preload-journey-map.js');
  if (h.state.exposed === null) throw new Error('the preload exposed no journeySpaces bridge');
  bridge = h.state.exposed as unknown as JourneyBridge;
});

/** Script one channel's envelope. */
const reply = (channel: string, value: unknown): void => {
  h.state.replies.set(channel, () => value);
};

describe('the surface the Builder sees', () => {
  it('announces itself so the app can feature-detect and fall back', () => {
    expect(bridge.available).toBe(true);
  });

  it('is exactly the journey calls plus read-only asset access', () => {
    // `listAssets` was added deliberately (2026-08): a journey is built
    // FROM something — a research doc, a transcript — and while this
    // bridge returned journeys only, "Import from Spaces" showed an
    // empty list in any Space that held research. The widening is READ
    // side only; the write surface below is unchanged.
    expect(Object.keys(h.state.exposed ?? {}).sort()).toEqual([
      'available',
      'listAssets',
      'listJourneys',
      'listSpaces',
      'load',
      'onOpenTarget',
      'openTarget',
      'save',
      'update',
    ]);
  });

  it('can still only WRITE journeys — reading more did not widen writing', () => {
    // The property that made the wider read acceptable. If a general
    // create/update/delete ever appears here, a page we do not build can
    // rewrite the graph.
    const writers = Object.keys(h.state.exposed ?? {}).filter((k) =>
      /^(save|update|create|delete|remove|write|put|post)/i.test(k)
    );
    expect(writers.sort()).toEqual(['save', 'update']);
  });
});

describe('listSpaces', () => {
  it('returns only id and name — a Space record does not leak wholesale', async () => {
    reply('lite:spaces:listSpaces', {
      ok: true,
      value: [
        {
          id: 's1',
          name: 'Ops',
          visibility: 'private',
          members: ['robb@onereach.com'],
          objective: 'internal only',
        },
      ],
    });
    expect(await bridge.listSpaces()).toEqual([{ id: 's1', name: 'Ops' }]);
  });

  it('answers with an empty list when the call fails, never an exception', async () => {
    reply('lite:spaces:listSpaces', { ok: false, error: { message: 'not signed in' } });
    await expect(bridge.listSpaces()).resolves.toEqual([]);
    reply('lite:spaces:listSpaces', { ok: true }); // ok but valueless
    await expect(bridge.listSpaces()).resolves.toEqual([]);
  });
});

describe('listJourneys', () => {
  const mixed = {
    ok: true,
    value: [
      { id: 'a', title: 'Onboarding', kind: 'journey', updatedAt: '2026-08-18T00:00:00Z' },
      { id: 'b', title: 'Q3 plan', kind: 'note' },
      { id: 'c', title: 'Renewal', kind: 'journey' },
      { id: 'd', title: 'Deck', kind: 'file' },
    ],
  };

  it('returns journeys and nothing else', async () => {
    reply('lite:spaces:items:list', mixed);
    const out = await bridge.listJourneys('s1');
    expect(out.map((j) => j.id)).toEqual(['a', 'c']);
  });

  it('scopes to the Space it was asked about, and stamps it on each result', async () => {
    reply('lite:spaces:items:list', mixed);
    const out = await bridge.listJourneys('s1');
    // The main handler reads `scopeId` (spaces/ipc.ts) — a payload
    // keyed `spaceId` is silently ignored and lists nothing.
    expect(h.state.invokes.at(-1)).toEqual({
      channel: 'lite:spaces:items:list',
      payload: { scopeId: 's1' },
    });
    expect(out.every((j) => j.spaceId === 's1')).toBe(true);
  });

  it('fans out over every Space when asked across all of them', async () => {
    // Lite's list channel is per-scope with no "everything" mode, so
    // the all-Spaces case walks the Space list. Each row still carries
    // the Space it came from — the Builder needs it to save back.
    reply('lite:spaces:listSpaces', { ok: true, value: [{ id: 's1' }, { id: 's2' }] });
    reply('lite:spaces:items:list', mixed);
    const out = await bridge.listJourneys();
    expect(new Set(out.map((j) => j.spaceId))).toEqual(new Set(['s1', 's2']));
  });

  it('omits updatedAt rather than reporting an undefined date', async () => {
    reply('lite:spaces:items:list', mixed);
    const out = await bridge.listJourneys('s1');
    expect(out[0]?.updatedAt).toBe('2026-08-18T00:00:00Z');
    expect(out[1] !== undefined && 'updatedAt' in out[1]).toBe(false);
  });

  it('is empty, not broken, when the Space cannot be read', async () => {
    reply('lite:spaces:items:list', { ok: false, error: { message: 'forbidden' } });
    await expect(bridge.listJourneys('s1')).resolves.toEqual([]);
  });
});

describe('listAssets', () => {
  // The bug this exists for: a Space full of research documents showed
  // NOTHING in the Builder's import picker, because the only listing
  // call filtered everything that was not a journey — on this side of
  // the bridge, after the items had already arrived.
  const mixed = {
    ok: true,
    value: [
      { id: 'a', title: 'Onboarding', kind: 'journey', updatedAt: '2026-08-18T00:00:00Z' },
      { id: 'b', title: 'Gartner MQ 2026', kind: 'document' },
      { id: 'c', title: 'Interview notes', kind: 'text' },
      { id: 'd', title: 'Deck', kind: 'file' },
    ],
  };

  it('returns every asset, not just journeys', async () => {
    reply('lite:spaces:items:list', mixed);
    const out = await bridge.listAssets('s1');
    expect(out.map((i) => i.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('reports each asset kind, so a document is not mistaken for a journey', async () => {
    reply('lite:spaces:items:list', mixed);
    const out = await bridge.listAssets('s1');
    expect(out.map((i) => i.kind)).toEqual(['journey', 'document', 'text', 'file']);
  });

  it('stamps the Space each asset came from', async () => {
    reply('lite:spaces:items:list', mixed);
    const out = await bridge.listAssets('s1');
    expect(out.every((i) => i.spaceId === 's1')).toBe(true);
  });

  it('fans out across every Space when asked for all of them', async () => {
    reply('lite:spaces:listSpaces', { ok: true, value: [{ id: 's1' }, { id: 's2' }] });
    reply('lite:spaces:items:list', mixed);
    const out = await bridge.listAssets();
    expect(new Set(out.map((i) => i.spaceId))).toEqual(new Set(['s1', 's2']));
  });

  it('is empty, not broken, when the Space cannot be read', async () => {
    reply('lite:spaces:items:list', { ok: false, error: { message: 'forbidden' } });
    await expect(bridge.listAssets('s1')).resolves.toEqual([]);
  });

  it('leaves listJourneys narrow — it still returns journeys only', async () => {
    reply('lite:spaces:items:list', mixed);
    const out = await bridge.listJourneys('s1');
    expect(out.map((j) => j.id)).toEqual(['a']);
  });
});

describe('load', () => {
  it('returns the journey with its markdown', async () => {
    reply('lite:spaces:items:get', {
      ok: true,
      value: { id: 'a', title: 'Onboarding', content: '## 1. Discovery', description: '3 phases' },
    });
    expect(await bridge.load('a')).toEqual({
      id: 'a',
      title: 'Onboarding',
      content: '## 1. Discovery',
      description: '3 phases',
    });
  });

  it('treats a contentless journey as empty text, not undefined', async () => {
    reply('lite:spaces:items:get', { ok: true, value: { id: 'a', title: 'Empty' } });
    const out = await bridge.load('a');
    expect(out?.content).toBe('');
    expect(out !== null && 'description' in out).toBe(false);
  });

  it('returns null for a missing or unreadable journey', async () => {
    reply('lite:spaces:items:get', { ok: true, value: null });
    await expect(bridge.load('gone')).resolves.toBeNull();
    reply('lite:spaces:items:get', { ok: false, error: { message: 'nope' } });
    await expect(bridge.load('gone')).resolves.toBeNull();
  });
});

describe('save', () => {
  it('sends the draft to the Space and reports the new id', async () => {
    reply('lite:spaces:journeys:create', { ok: true, value: { id: 'new-1' } });
    const draft = { title: 'T', journey: 'J', phases: [] };
    await expect(bridge.save('s1', draft)).resolves.toEqual({ ok: true, id: 'new-1' });
    expect(h.state.invokes.at(-1)).toEqual({
      channel: 'lite:spaces:journeys:create',
      payload: { spaceId: 's1', draft },
    });
  });

  it('surfaces WHY a save failed, so the Builder can tell the user', async () => {
    reply('lite:spaces:journeys:create', {
      ok: false,
      error: { message: 'A journey map needs at least one phase with a touchpoint' },
    });
    await expect(bridge.save('s1', {})).resolves.toEqual({
      ok: false,
      error: 'A journey map needs at least one phase with a touchpoint',
    });
  });

  it('still reports a failure when the main process gives no reason', async () => {
    reply('lite:spaces:journeys:create', { ok: false });
    await expect(bridge.save('s1', {})).resolves.toEqual({ ok: false, error: 'save failed' });
  });
});

describe('update', () => {
  it('patches an existing journey in place', async () => {
    reply('lite:spaces:items:update', { ok: true });
    const patch = { title: 'Renamed', content: '## 1. New' };
    await expect(bridge.update('a', patch)).resolves.toEqual({ ok: true });
    expect(h.state.invokes.at(-1)).toEqual({
      channel: 'lite:spaces:items:update',
      payload: { id: 'a', patch },
    });
  });

  it('reports the reason a patch was refused', async () => {
    reply('lite:spaces:items:update', { ok: false, error: { message: 'read-only member' } });
    await expect(bridge.update('a', {})).resolves.toEqual({
      ok: false,
      error: 'read-only member',
    });
    reply('lite:spaces:items:update', { ok: false });
    await expect(bridge.update('a', {})).resolves.toEqual({ ok: false, error: 'update failed' });
  });
});

describe('the journey the user clicked', () => {
  it('is fetched from the main process', async () => {
    reply('lite:journey-map:takeTarget', 'journey-9');
    await expect(bridge.openTarget()).resolves.toBe('journey-9');
  });

  it('reads a plain open as no target', async () => {
    for (const value of [null, undefined, '', 42, { id: 'x' }]) {
      reply('lite:journey-map:takeTarget', value);
      await expect(bridge.openTarget()).resolves.toBeNull();
    }
  });

  it('forwards a second journey pushed at a live window', () => {
    const seen: string[] = [];
    bridge.onOpenTarget((id) => seen.push(id));
    const fire = (payload: unknown): void => {
      for (const l of h.state.listeners.get('lite:journey-map:target') ?? []) l({}, payload);
    };
    fire({ itemId: 'journey-2' });
    expect(seen).toEqual(['journey-2']);
  });

  it('ignores a malformed push instead of handing the app junk', () => {
    const seen: string[] = [];
    bridge.onOpenTarget((id) => seen.push(id));
    const fire = (payload: unknown): void => {
      for (const l of h.state.listeners.get('lite:journey-map:target') ?? []) l({}, payload);
    };
    for (const payload of [{}, { itemId: '' }, { itemId: 7 }, null, undefined]) {
      expect(() => fire(payload)).not.toThrow();
    }
    expect(seen).toEqual([]);
  });
});

describe('the allow-list holds at runtime, not just in the source', () => {
  it('every channel the bridge actually reached is sanctioned', async () => {
    for (const channel of ALLOWED_CHANNELS) reply(channel, { ok: true, value: [] });
    reply('lite:spaces:items:get', { ok: true, value: null });
    reply('lite:journey-map:takeTarget', null);

    await bridge.listSpaces();
    await bridge.listJourneys('s1');
    await bridge.listJourneys();
    await bridge.load('a');
    await bridge.save('s1', {});
    await bridge.update('a', {});
    await bridge.openTarget();
    bridge.onOpenTarget(() => undefined);

    const reached = [...new Set(h.state.invokes.map((i) => i.channel))];
    expect(reached.filter((c) => !ALLOWED_CHANNELS.includes(c))).toEqual([]);
    // And it exercised all of them — an allow-list nothing tests is a wish.
    expect(reached.sort()).toEqual([...ALLOWED_CHANNELS].sort());
    expect([...h.state.listeners.keys()]).toEqual(['lite:journey-map:target']);
  });
});
