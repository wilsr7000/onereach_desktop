/**
 * Journey Map Builder bridge (ADR-072 phase 2, 2026-08-18).
 *
 * The Builder is a hosted app (deployed to edison public files) opened
 * in its own window. It must SAVE INTO and LOAD FROM Spaces — journeys
 * belong in NEON as ordinary assets, not in a private store only that
 * app can read — so this preload exposes exactly the four calls that
 * requires and nothing else.
 *
 * Deliberately NOT `window.lite`: the hosted app gets a narrow, purpose-
 * built surface (`window.journeySpaces`) the same way the riff window
 * gets only `window.ai`. It cannot reach auth, files, settings, the
 * updater, or arbitrary graph queries — a compromised or careless
 * hosted page can create and read journey assets, and that is the whole
 * blast radius.
 *
 * Feature-detect on the app side: `if (window.journeySpaces) { … }`,
 * falling back to its own storage when opened in a plain browser.
 *
 * @internal
 */

import { contextBridge, ipcRenderer } from 'electron';

/** Envelope shape shared with the rest of the Spaces IPC surface. */
interface Envelope<T> {
  ok: boolean;
  value?: T;
  error?: { message: string; code?: string };
}

const SPACES_LIST = 'lite:spaces:listSpaces';
const ITEMS_LIST = 'lite:spaces:items:list';
const ITEMS_GET = 'lite:spaces:items:get';
const JOURNEYS_CREATE = 'lite:spaces:journeys:create';
const ITEMS_UPDATE = 'lite:spaces:items:update';

contextBridge.exposeInMainWorld('journeySpaces', {
  /** Marks the bridge present so the app can feature-detect. */
  available: true,

  /** Spaces the signed-in person belongs to (id + name only, from the graph). */
  listSpaces: async (): Promise<Array<{ id: string; name: string }>> => {
    const env = (await ipcRenderer.invoke(SPACES_LIST)) as Envelope<
      Array<{ id: string; name: string }>
    >;
    if (env.ok !== true || env.value === undefined) return [];
    return env.value.map((s) => ({ id: s.id, name: s.name }));
  },

  /**
   * Journey maps in a Space — or across every Space the person can
   * see, when spaceId is omitted. Returns summaries; call `load` for
   * the content.
   *
   * Lite's list channel is per-scope with no "everything" mode, so the
   * omitted case fans out over the Space list. Each row carries its
   * `spaceId` because the Builder needs it to save back into the same
   * Space it opened from.
   */
  listJourneys: async (
    spaceId?: string
  ): Promise<Array<{ id: string; title: string; spaceId: string; updatedAt?: string }>> => {
    const inSpace = async (id: string): Promise<
      Array<{ id: string; title: string; spaceId: string; updatedAt?: string }>
    > => {
      const env = (await ipcRenderer.invoke(ITEMS_LIST, { scopeId: id })) as Envelope<
        Array<{ id: string; title: string; kind: string; updatedAt?: string }>
      >;
      if (env.ok !== true || env.value === undefined) return [];
      return env.value
        .filter((i) => i.kind === 'journey')
        .map((i) => ({
          id: i.id,
          title: i.title,
          spaceId: id,
          ...(i.updatedAt !== undefined ? { updatedAt: i.updatedAt } : {}),
        }));
    };

    if (typeof spaceId === 'string' && spaceId.length > 0) return inSpace(spaceId);

    const env = (await ipcRenderer.invoke(SPACES_LIST)) as Envelope<Array<{ id: string }>>;
    if (env.ok !== true || env.value === undefined) return [];
    const perSpace = await Promise.all(env.value.map((s) => inSpace(s.id)));
    return perSpace.flat();
  },

  /** One journey's full record, including its markdown `content`. */
  load: async (
    itemId: string
  ): Promise<{ id: string; title: string; content: string; description?: string } | null> => {
    const env = (await ipcRenderer.invoke(ITEMS_GET, { id: itemId })) as Envelope<{
      id: string;
      title: string;
      content?: string;
      description?: string;
    } | null>;
    if (env.ok !== true || env.value === null || env.value === undefined) return null;
    return {
      id: env.value.id,
      title: env.value.title,
      content: env.value.content ?? '',
      ...(env.value.description !== undefined ? { description: env.value.description } : {}),
    };
  },

  /**
   * Create a journey asset in a Space from the Builder's structured
   * draft ({title, journey, phases[{name, touchpoints[…]}]}). Lite
   * sanitizes and serializes it to the registered markdown shape, so
   * both surfaces write journeys the same way.
   */
  save: async (
    spaceId: string,
    draft: unknown
  ): Promise<{ ok: boolean; id?: string; error?: string }> => {
    const env = (await ipcRenderer.invoke(JOURNEYS_CREATE, { spaceId, draft })) as Envelope<{
      id: string;
    }>;
    if (env.ok !== true) return { ok: false, error: env.error?.message ?? 'save failed' };
    return { ok: true, ...(env.value?.id !== undefined ? { id: env.value.id } : {}) };
  },

  /**
   * The journey the user asked to open, when the Builder was launched
   * from a journey asset ("Open in Journey Map Builder"). Returns null
   * on a plain open. Reading it CONSUMES it, so a later reload starts
   * clean rather than reopening a journey the user has moved on from.
   */
  openTarget: async (): Promise<string | null> => {
    const id = (await ipcRenderer.invoke('lite:journey-map:takeTarget')) as string | null;
    return typeof id === 'string' && id.length > 0 ? id : null;
  },

  /**
   * Fires when the user clicks "Open in Journey Map Builder" on another
   * journey while this window is already open.
   */
  onOpenTarget: (fn: (itemId: string) => void): void => {
    ipcRenderer.on('lite:journey-map:target', (_e, payload: { itemId?: string }) => {
      if (typeof payload?.itemId === 'string' && payload.itemId.length > 0) fn(payload.itemId);
    });
  },

  /** Update an existing journey's title/content in place (versioned by Lite). */
  update: async (
    itemId: string,
    patch: { title?: string; content?: string; description?: string }
  ): Promise<{ ok: boolean; error?: string }> => {
    const env = (await ipcRenderer.invoke(ITEMS_UPDATE, { id: itemId, patch })) as Envelope<unknown>;
    if (env.ok !== true) return { ok: false, error: env.error?.message ?? 'update failed' };
    return { ok: true };
  },
});
