/**
 * Spaces main-process orchestration.
 *
 * Owns:
 *   - The Spaces window factory (single-instance) -- exposed via the
 *     `open()` method on `SpacesApi`.
 *   - The `lite:spaces:*` IPC handler suite (see `ipc.ts`).
 *   - The `Tools -> Spaces...` menu entry. Registers directly into the
 *     `top:tools` placeholder owned by `lite/tools/menu-builder.ts` --
 *     no cross-module imports; the parent id is the string contract.
 *
 * Per ADR-019 / Rule 11 (LITE-RULES.md), every other module imports from
 * `lite/spaces/api.ts`. This file is the implementation boundary.
 *
 * Phase 0 wiring:
 *   - `initSpaces()` opens an empty BrowserWindow when the menu fires
 *   - Data methods (`listSpaces`, `items.list`, etc.) still throw
 *     `SPACES_NOT_INITIALIZED` -- they're wired in Phase 1
 */

import { app, dialog, shell, BrowserWindow, Notification } from 'electron';
import { registry } from '../menu/registry.js';
import {
  _setSpacesApiForTesting,
  _resetSpacesApiForTesting,
  type SpacesApi,
  type SpacesItemsApi,
  type SpacesTicketsApi,
  type SpacesPlaybooksApi,
  type SpacesIdentityApi,
  type SpacesMembersApi,
  type SpacesChecklistsApi,
} from './api.js';
import { SpacesError } from './errors.js';
import { createSpacesWindow, closeSpacesWindow } from './window.js';
import { registerSpacesIpc, unregisterSpacesIpc } from './ipc.js';
import { SdkSpacesClient, hashAssetState } from './sdk-client.js';
import { getNeonApi } from '../neon/api.js';
import { getFilesApi } from '../files/api.js';
import { getAuthApi } from '../auth/api.js';
import { getKVApi } from '../kv/api.js';
import { getMainWindowApi } from '../main-window/api.js';
import { getLoggingApi } from '../logging/api.js';
import {
  SpacesCache,
  SPACES_CACHE_KEYS,
  itemsListKey,
  itemsGetKey,
  type SpacesCacheUpdate,
} from './cache.js';

/** IPC channel: broadcasts when a cached read refreshes so the renderer can re-paint. */
export const SPACES_CACHE_UPDATED_EVENT = 'lite:spaces:cache-updated';

/**
 * Cap on bytes we will inline as a data: URL. A data URL is ~33% larger
 * than the source and lives in the renderer's memory, so a huge file
 * would bloat the pane rather than help. Over the cap the pane keeps
 * its Open / Download actions and says why it isn't rendering.
 */
const MAX_INLINE_PREVIEW_BYTES = 25 * 1024 * 1024;

/** Minimal extension -> mime map for inlining. Defaults to octet-stream. */
function guessMimeFromKey(key: string): string {
  const lower = key.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  // Media: <video>/<audio> refuse to decode data: URLs typed
  // application/octet-stream (no content sniffing for media), so the
  // tile frame-grab and any inline player need the real type.
  if (lower.endsWith('.mp4') || lower.endsWith('.m4v')) return 'video/mp4';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.ogg') || lower.endsWith('.oga')) return 'audio/ogg';
  // Text kinds — harmless for the decoder (which ignores mime) but
  // keeps data URLs honest for anything else that reads them.
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown';
  if (lower.endsWith('.txt') || lower.endsWith('.text')) return 'text/plain';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

/**
 * ADR-057 — async AI change summary for the version that an edit just
 * created. Best-effort by contract: any failure (AI unconfigured,
 * timeout, annotate write rejected) is logged and dropped — the edit
 * and its snapshot already landed. Raced against a hard deadline so a
 * wedged model call cannot hold resources.
 */
async function annotateVersionDiff(
  client: SdkSpacesClient,
  assetId: string,
  before: Item,
  after: Item
): Promise<void> {
  const log = getLoggingApi();
  try {
    const oldContent = (before.content ?? '').slice(0, 4000);
    const newContent = (after.content ?? '').slice(0, 4000);
    const oldTitle = before.title;
    const newTitle = after.title;
    if (oldContent === newContent && oldTitle === newTitle) return; // metadata-only edit
    const call = getAiApi().chat({
      system:
        'You describe document edits for a version-history list. Respond with ' +
        'ONE sentence (max 140 chars), plain text, no quotes, starting with a ' +
        'verb. Describe the substantive change between OLD and NEW; if content ' +
        'was replaced wholesale, say what the new content is about.',
      messages: [
        {
          role: 'user',
          content:
            `OLD TITLE: ${oldTitle}\nNEW TITLE: ${newTitle}\n\n` +
            `OLD CONTENT (truncated):\n${oldContent}\n\n` +
            `NEW CONTENT (truncated):\n${newContent}`,
        },
      ],
      maxTokens: 100,
      feature: 'spaces-version-diff',
    });
    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error('version-diff timeout (45s)')), 45_000);
      if (typeof t === 'object' && 'unref' in t) t.unref();
    });
    const result = await Promise.race([call, timeout]);
    const summary = result.content.trim().replace(/\s+/g, ' ');
    if (summary.length === 0) return;
    // Pin the summary to the exact version this edit created — the
    // snapshot holds the REPLACED (before) state, so its hash is
    // before's hash.
    const prevHash = hashAssetState(
      before.title,
      before.description ?? '',
      before.content ?? '',
      before.kind
    );
    await client.describeVersion(assetId, prevHash, summary);
    if (activeCache !== null) activeCache.invalidate(() => true);
  } catch (err) {
    log.warn('spaces', 'version diff annotation skipped', {
      assetId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

let activeCache: SpacesCache | null = null;
/** Live SDK client for background jobs (GSX migration sweep). */
let activeClient: SdkSpacesClient | null = null;
/** Delayed-start handle for the boot-time GSX migration sweep. */
let gsxMigrationTimer: ReturnType<typeof setTimeout> | null = null;
let cacheUnsubscribe: (() => void) | null = null;
/**
 * Unsubscribe handle for the auth-session listener. Drops cached
 * graph results whenever the active session goes away so the next
 * user signing in doesn't paint the previous user's items for the
 * remainder of the cache TTL.
 */
let authUnsubscribe: (() => void) | null = null;
import type {
  LiveMeeting,
  Item,
  ItemSummary,
  ListOpts,
  Space,
  EntityCounts,
  Contributor,
  Event,
  AgentSummary,
  PermissionSummary,
  TopContributorsOpts,
  RecentEventsOpts,
  RecentItemsOpts,
  AgentsSampleOpts,
  CreateSpaceInput,
  DeleteSpaceOpts,
  UpdateSpaceInput,
  ItemUpdatePatch,
  RecentCommitsOpts,
  SpaceKind,
  ListTicketsOpts,
  CreateTicketInput,
  UpdateTicketPatch,
  SetPlaybookResult,
  Person,
  PersonUpsertInput,
  SpaceMember,
  AddSpaceMemberOptions,
  Checklist,
  ChecklistPhase,
  AssetVersion,
  AssetVersionSummary,
  TicketChecklist,
  CreateChecklistInput,
  UpdateChecklistInput,
  ChecklistDraft,
  ChecklistItemSpec,
  AttachChecklistInput,
  SetChecklistItemInput,
  CreateAssetInput,
  CreateBinaryAssetInput,
  CreateAgentInput,
  CreateAgentFromLibraryInput,
  AgentLibraryEntry,
  MemberLibraryEntry,
  DeleteAssetOpts,
  SearchItemsOpts,
  ItemMetadata,
  AssetViewer,
} from './types.js';
import type { SpaceScope } from './scope.js';
import { createBinaryAsset } from './create-binary.js';
import { runGsxMigration } from './gsx-migration.js';
import { readLearnProgress, writeLearnProgress } from './learn-store.js';
import { readAttributionEmail, writeAttributionEmail } from './identity-store.js';
import { sanitizeChecklistItems } from './sdk-client.js';
import { getAiApi } from '../ai/api.js';

// ─── Menu wiring ────────────────────────────────────────────────────────

/**
 * Parent id owned by `lite/tools/menu-builder.ts`. We use the string
 * literal rather than importing the constant so this module stays
 * importer-free per Rule 11 (no cross-module internal imports).
 */
/** Spaces' own top-level (2026-08-07 — promoted out of Tools). */
const SPACES_TOP_LEVEL_ID = 'top:spaces';

/** Stable id for the Tools -> Spaces... menu entry. */
const SPACES_MENU_ITEM_ID = 'tools:spaces';

/**
 * Order slot for the Spaces menu entry. The Tools menu reserves
 * `0..8999` for entries above the tail block (Manage Tools sits at
 * `9001`). We pick `50` so Spaces sorts above any user-curated tools.
 */
const SPACES_MENU_ORDER = 50;

// ─── Init / teardown ────────────────────────────────────────────────────

export interface InitSpacesOptions {
  /** Path to the bundled preload-lite.js. */
  preloadPath: string;
  /** Path to the bundled spaces.html. */
  htmlPath: string;
  /** Resolver for the parent window. Called each time Spaces opens. */
  getParentWindow: () => BrowserWindow | null;
  /** Optional logger (defaults to silent). */
  logger?: {
    info: (message: string, data?: unknown) => void;
    warn: (message: string, data?: unknown) => void;
    error: (message: string, data?: unknown) => void;
  };
}

export interface SpacesHandle {
  /** Open (or focus) the Spaces window. Convenience for menu wiring. */
  open(): void;
  /** Tear down IPC handlers + close the window. Idempotent. */
  teardown(): void;
}

let registered = false;
let initOptions: InitSpacesOptions | null = null;

/**
 * Register IPC handlers, install the Spaces menu entry, and install
 * the BrowserWindow-backed `SpacesApi` singleton. Safe to call multiple
 * times -- idempotent.
 */
export function initSpaces(opts: InitSpacesOptions): SpacesHandle {
  const log = opts.logger ?? {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  initOptions = opts;

  const handle: SpacesHandle = {
    open: (): void => {
      if (initOptions === null) {
        log.warn('open() called before init', {});
        return;
      }
      try {
        createSpacesWindow({
          parent: initOptions.getParentWindow(),
          htmlPath: initOptions.htmlPath,
          preloadPath: initOptions.preloadPath,
        });
        log.info('spaces window opened', {});
      } catch (err) {
        log.error('failed to open spaces window', { error: (err as Error).message });
      }
    },
    teardown: teardownInternal,
  };

  // Install the real API singleton -- replaces the no-op placeholder
  // that `getSpacesApi()` returns until init runs.
  const api = createPhase0Api(handle);
  _setSpacesApiForTesting(api);

  // Subscribe to cache refresh events and rebroadcast as IPC to every
  // renderer. The Spaces window listens and triggers a local re-paint
  // when a key it cares about refreshes -- so background timer
  // refreshes flow through to the UI without polling.
  if (activeCache !== null) {
    cacheUnsubscribe = activeCache.onUpdate((update) => {
      try {
        broadcastCacheUpdate(update);
      } catch (err) {
        log.warn('spaces-cache: broadcast failed', { error: (err as Error).message });
      }
    });
    // ADR-062 — piggyback the meeting-ring check on the refresh stream
    // (zero new timers) + window focus (instant when the user arrives).
    ringCacheUnsubscribe = activeCache.onUpdate(() => {
      void checkLiveMeetings(activeClient, 'cache-refresh');
    });
    ringFocusHandler = (): void => {
      void checkLiveMeetings(activeClient, 'focus');
    };
    app.on('browser-window-focus', ringFocusHandler);
    activeCache.startRefreshTimer();
  }

  // Pre-warm the cache so the renderer's first paint is instant.
  // Fire-and-forget on the next tick so the kernel boot doesn't block
  // on Neon -- the user can keep going while these settle.
  void Promise.resolve().then(() => prewarmSpacesCache(api, log));

  if (registered) return handle;

  registerSpacesIpc({ onOpen: handle.open });

  // ADR-050: lift any v1 inline-base64 asset stubs into GSX. Delayed
  // well past boot so sign-in (auto or manual) has a chance to settle;
  // the sweep aborts quietly when signed out and retries next boot.
  gsxMigrationTimer = setTimeout(() => {
    gsxMigrationTimer = null;
    const client = activeClient;
    if (client === null) return;
    void runGsxMigration({
      client,
      files: getFilesApi(),
      log: getLoggingApi(),
    }).then((r) => {
      if (r.scanned > 0 || r.aborted) {
        log.info('gsx-migrate sweep done', { ...r });
      }
    });
  }, 20_000);

  // Drop the in-memory graph cache whenever an env's session becomes
  // null (sign-out, expiry, manual revoke). Without this, signing
  // back in as a DIFFERENT user paints the previous user's home
  // feed for up to one cache TTL — measurable user-data leak across
  // accounts in the same process. The listener is process-lifetime;
  // teardown removes it.
  try {
    authUnsubscribe = getAuthApi().onSessionChanged((env, session) => {
      if (session !== null) return;
      if (activeCache === null) return;
      try {
        activeCache.invalidate(() => true);
        log.info('spaces cache invalidated on session change', { env });
      } catch (err) {
        log.warn('spaces cache invalidate threw', {
          env,
          error: (err as Error).message,
        });
      }
    });
  } catch (err) {
    log.warn('failed to subscribe to auth session changes', {
      error: (err as Error).message,
    });
  }

  // Menu placement (2026-08-07 decision, from the menu review):
  // Spaces is the platform primitive — a Space per initiative, assets,
  // agents, sharing — so it gets its own top-level between Tools (70)
  // and University (80) instead of hiding as one row inside Tools.
  registry.upsert({
    id: SPACES_TOP_LEVEL_ID,
    type: 'top-level',
    label: 'Spaces',
    order: 75,
  });
  registry.upsert({
    id: SPACES_MENU_ITEM_ID,
    type: 'item',
    parentId: SPACES_TOP_LEVEL_ID,
    label: 'Open Spaces',
    order: SPACES_MENU_ORDER,
    click: handle.open,
  });

  registered = true;
  log.info('spaces initialized', {});
  return handle;
}

function teardownInternal(): void {
  if (gsxMigrationTimer !== null) {
    clearTimeout(gsxMigrationTimer);
    gsxMigrationTimer = null;
  }
  activeClient = null;
  if (!registered) return;
  unregisterSpacesIpc();
  try {
    registry.unregister(SPACES_MENU_ITEM_ID);
  } catch {
    // best-effort
  }
  // Stop the background refresh timer and drop the cache so the next
  // initSpaces() starts fresh (e.g. across sign-out / sign-in).
  if (cacheUnsubscribe !== null) {
    try {
      cacheUnsubscribe();
    } catch {
      /* best-effort */
    }
    cacheUnsubscribe = null;
  }
  if (authUnsubscribe !== null) {
    try {
      authUnsubscribe();
    } catch {
      /* best-effort */
    }
    authUnsubscribe = null;
  }
  if (ringCacheUnsubscribe !== null) {
    try {
      ringCacheUnsubscribe();
    } catch {
      /* best-effort */
    }
    ringCacheUnsubscribe = null;
  }
  if (ringFocusHandler !== null) {
    try {
      app.removeListener('browser-window-focus', ringFocusHandler);
    } catch {
      /* best-effort */
    }
    ringFocusHandler = null;
  }
  if (activeCache !== null) {
    try {
      activeCache.stopRefreshTimer();
      activeCache.invalidate(() => true);
    } catch {
      /* best-effort */
    }
    activeCache = null;
  }
  registered = false;
  initOptions = null;
  closeSpacesWindow();
  _resetSpacesApiForTesting();
}

/** @internal -- exposed for tests. */
export function _isSpacesRegisteredForTesting(): boolean {
  return registered;
}

/** @internal -- exposed for tests so they can re-init cleanly. */
export function _resetSpacesRegistrationForTesting(): void {
  teardownInternal();
}

/** @internal -- public asset URLs do not need Files signing. */
export function _isDirectDownloadUrlForTesting(key: string): boolean {
  try {
    const url = new URL(key);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// ─── Phase 0 backing implementation ─────────────────────────────────────

/**
 * Build the Phase 0 SpacesApi. `open()` is wired to the BrowserWindow
 * factory; data methods delegate to the stub SDK client, which throws
 * `SPACES_NOT_INITIALIZED` until Phase 1 lands.
 *
 * Phase 1 replaces this with a real implementation that calls
 * `getNeonApi().query(...)` under the hood.
 */
/**
 * Span bases whose `.start` / `.finish` run at 'debug' instead of
 * 'info'. These are the read ops the SpacesCache re-runs on its 60s
 * background refresh — at idle they dominate the 200-line bug-report
 * log window without carrying signal. Mutation spans stay 'info';
 * `.fail` events are 'error' for every span, quiet or not.
 */
// ─── ADR-062: the meeting ring ───────────────────────────────────────────
//
// A live meeting rings Lite through the shared graph: the host's
// recorder announces an ephemeral (:MeetingLive) signal; we check for
// unseen signals on EXISTING app events only — the spaces cache's
// refresh stream and window focus. No timers of our own, no push
// service. Rung ids are remembered per app-run (a still-live meeting
// SHOULD ring again after a relaunch), and the read-side TTL keeps a
// crashed host from ringing anyone forever.

const RING_TTL_MS = 30 * 60_000;
/** Floor between checks — the cache stream can emit many events per tick. */
const RING_CHECK_MIN_INTERVAL_MS = 20_000;
const rungMeetingIds = new Set<string>();
let lastRingCheckMs = 0;
let ringDialogOpen = false;
let ringCacheUnsubscribe: (() => void) | null = null;
let ringFocusHandler: (() => void) | null = null;

async function checkLiveMeetings(client: SdkSpacesClient | null, reason: string): Promise<void> {
  if (client === null) return;
  const now = Date.now();
  if (now - lastRingCheckMs < RING_CHECK_MIN_INTERVAL_MS) return;
  lastRingCheckMs = now;
  let meetings: LiveMeeting[];
  try {
    meetings = await client.listLiveMeetings({ ttlMs: RING_TTL_MS });
  } catch {
    return; // ring is best-effort; the next event retries
  }
  for (const meeting of meetings) {
    if (rungMeetingIds.has(meeting.id)) continue;
    rungMeetingIds.add(meeting.id);
    void ringForMeeting(meeting, reason);
  }
}

async function ringForMeeting(meeting: LiveMeeting, reason: string): Promise<void> {
  const log = getLoggingApi();
  log.info('spaces', 'meeting ring', { id: meeting.id, title: meeting.title, reason });
  const ageMin =
    meeting.startedAtMs > 0
      ? Math.max(0, Math.round((Date.now() - meeting.startedAtMs) / 60_000))
      : 0;
  const started = ageMin < 1 ? 'just now' : `${ageMin} min ago`;
  const body =
    meeting.host !== null && meeting.host.length > 0
      ? `${meeting.host} started “${meeting.title}” ${started}`
      : `“${meeting.title}” started ${started}`;
  // OS notification when Lite is in the background — click joins.
  try {
    if (Notification.isSupported() && BrowserWindow.getFocusedWindow() === null) {
      const n = new Notification({ title: 'Meeting ringing', body });
      n.on('click', () => {
        void joinLiveMeeting(meeting);
      });
      n.show();
    }
  } catch {
    /* notification is garnish; the dialog is the ring */
  }
  if (ringDialogOpen) return;
  ringDialogOpen = true;
  try {
    shell.beep();
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Meeting ringing',
      message: `🎥 ${meeting.title}`,
      detail: `${body}. Join opens the meeting in a Lite tab.`,
      buttons: ['Join', 'Dismiss'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) await joinLiveMeeting(meeting);
  } finally {
    ringDialogOpen = false;
  }
}

async function joinLiveMeeting(meeting: LiveMeeting): Promise<void> {
  const log = getLoggingApi();
  if (meeting.joinUrl === null) {
    log.warn('spaces', 'ring join skipped — host published no guest page', { id: meeting.id });
    return;
  }
  try {
    // openTab raises the main window via the a8f1bfa raise-on-tab-open
    // machinery, so the meeting is front-and-center after one click.
    await getMainWindowApi().openTab({
      url: meeting.joinUrl,
      label: meeting.title.slice(0, 40) || 'Meeting',
    });
  } catch (err) {
    log.warn('spaces', 'ring join failed', {
      id: meeting.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const QUIET_READ_SPANS = new Set<string>([
  'spaces.meetings.live',
  'spaces.listSpaces',
  'spaces.uncategorizedCount',
  'spaces.items.list',
  'spaces.items.get',
  'spaces.learn.signals',
]);

function createPhase0Api(handle: SpacesHandle): SpacesApi {
  // Phase 1: the SDK client now executes real Cypher via the Neon
  // module. `getNeonApi()` lazily instantiates so we can pass the
  // bound `query` method without forcing the neon singleton to
  // initialize before this point.
  const client = new SdkSpacesClient({
    query: (cypher, parameters) => getNeonApi().query(cypher, parameters),
    // ADR-030: wrap each instrumented SDK op in a span so Neon-backed
    // reads/writes are traceable in /logs?category=spaces -- including
    // the boot prewarm + background refresh paths that never cross IPC.
    // Read spans run at 'debug': the 60s cache refresh re-runs every
    // cached read, and their per-tick successes were flooding the
    // 200-line bug-report window at idle. Mutations stay at 'info' and
    // every `.fail` is 'error' — failures stay loud either way.
    spanEmitter: (name, data) =>
      getLoggingApi().start(
        name,
        data,
        QUIET_READ_SPANS.has(name) ? { level: 'debug' } : undefined
      ),
    // ADR-051: the viewing :Person.id for visibility gating. Same
    // convention as the renderer's boot whoAmI probe — lowercased
    // session email, falling back to accountId; null when signed out
    // (restricted Spaces are then gated out entirely).
    viewerId: () => {
      const session = getAuthApi().getSession('edison');
      if (session === null) return null;
      const email = typeof session.email === 'string' ? session.email.trim().toLowerCase() : '';
      return email.length > 0 ? email : session.accountId;
    },
    // ADR-059 — universal notes. Note BODIES live in the shared Edison
    // KV store (the same store WISER Playbooks / OR-Mobile write);
    // inject it so :Note edits/creates keep the body in sync. The
    // account feeds the `notes:<account>` collection for Lite-born
    // notes — same identity convention as viewerId, but NOT lowercased
    // (KV collections are case-sensitive and OR-Mobile writes the
    // session email verbatim).
    noteKv: {
      get: (collection, key) => getKVApi().get(collection, key),
      set: (collection, key, value) => getKVApi().set(collection, key, value),
    },
    noteAccount: () => {
      const session = getAuthApi().getSession('edison');
      if (session === null) return null;
      const email = typeof session.email === 'string' ? session.email.trim() : '';
      return email.length > 0 ? email : session.accountId;
    },
  });
  activeClient = client;
  // ADR-055 — register the Checklist entity + relationship types in the
  // graph's (:Schema) registry. Idempotent, best-effort, non-blocking.
  void client.ensureChecklistSchema();
  // ADR-057 — register AssetVersion + HAS_VERSION the same way.
  void client.ensureVersionSchema();


  // In-process cache. Pre-warms the home-view + sidebar reads at boot
  // so the renderer's first paint is instant. Mutations invalidate
  // via `nukeReadCache(...)` below; the background refresh timer
  // (started in `initSpaces`) keeps long-running sessions fresh.
  const cache = new SpacesCache({
    ttlMs: 30_000,
    refreshIntervalMs: 60_000,
  });
  activeCache = cache;

  /**
   * Coarse invalidation -- nukes every cached read entry so the next
   * call re-fetches. Used after Space / Item mutations. The
   * refresh timer + the renderer's onCacheUpdate subscription mean
   * the data shows up within ~1 second of the mutation completing.
   *
   * Fine-grained invalidation (only the specific keys touched by the
   * mutation) is a sensible follow-up; coarse is correct and
   * simple for now.
   */
  const nukeReadCache = (): void => {
    cache.invalidate(() => true);
  };

  // ── items sub-surface ────────────────────────────────────────────────
  // Reads (list / get) go through the cache. Writes (update / addTag /
  // removeTag / create / delete / restore / move / metadata) nuke the
  // read cache so the next read sees the new state.
  const items: SpacesItemsApi = {
    list(scope: SpaceScope, opts?: ListOpts): Promise<ItemSummary[]> {
      // Cache key is per-scope (each Space + Uncategorized is its
      // own slot). Opts (limit/offset) are intentionally NOT in the
      // key for now -- v1 uses default pagination only; revisit if
      // we wire infinite scroll.
      const scopeId = scope.kind === 'uncategorized' ? '__uncategorized__' : scope.spaceId;
      return cache.getOrFetch(itemsListKey(scopeId), () => client.listItems(scope, opts));
    },
    get(id: string): Promise<Item | null> {
      if (typeof id !== 'string' || id.length === 0) {
        throw new SpacesError({
          code: 'SPACES_INVALID_INPUT',
          message: 'items.get() requires a non-empty id',
          remediation: 'Pass the canonical item id from a previous list result.',
          context: { id },
        });
      }
      return cache.getOrFetch(itemsGetKey(id), () => client.getItem(id));
    },
    async resolveFileUrl(key: string): Promise<string | null> {
      // Soft API: missing/empty key, no auth, or any Files error
      // returns null so the detail panel degrades to "no preview" --
      // never an error banner. Real callers can still inspect the
      // logging stream if they care about the failure reason.
      //
      // NOT cached -- signed URLs have short server-side TTLs and the
      // Files module already memoizes its own short-lived results.
      if (typeof key !== 'string' || key.length === 0) return null;
      if (_isDirectDownloadUrlForTesting(key)) return key;
      try {
        return await getFilesApi().getDownloadUrl(key);
      } catch {
        return null;
      }
    },
    async getFileExpiry(
      key: string
    ): Promise<{ expiresAt: string | null; source: 'bucket' } | null> {
      if (typeof key !== 'string' || key.length === 0) return null;
      try {
        const info = await getFilesApi().get(key);
        if (info === null) return null;
        const ttl = typeof info.ttl === 'string' && info.ttl.length > 0 ? info.ttl : null;
        if (ttl !== null) {
          // Logged deliberately. A scheduled deletion that Lite did not
          // set is the leading candidate for "the bytes vanished but
          // the graph node survived" -- and we had been discarding this
          // field on every read, so the evidence never reached anyone.
          getLoggingApi().info('spaces', 'file has a scheduled deletion', { key, ttl });
        }
        return { expiresAt: ttl, source: 'bucket' };
      } catch {
        return null;
      }
    },
    async readFileData(key: string): Promise<{ dataUrl: string } | null> {
      // Soft API, same contract as resolveFileUrl: any failure returns
      // null and the pane shows an explicit message. NOT cached -- the
      // bytes are large and the pane holds its own copy.
      if (typeof key !== 'string' || key.length === 0) return null;
      try {
        const bytes = await getFilesApi().download(key);
        const buf = Buffer.from(bytes);
        if (buf.byteLength > MAX_INLINE_PREVIEW_BYTES) {
          getLoggingApi().info('spaces', 'readFileData: over inline cap', {
            bytes: buf.byteLength,
            cap: MAX_INLINE_PREVIEW_BYTES,
          });
          return null;
        }
        const mime = guessMimeFromKey(key);
        return { dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
      } catch (err) {
        // The common real-world case: the object is gone from storage
        // (NoSuchKey) while the graph node still points at it.
        getLoggingApi().warn('spaces', 'readFileData failed', {
          error: (err as Error).message,
        });
        return null;
      }
    },
    async update(id: string, patch: ItemUpdatePatch): Promise<Item> {
      // ADR-057 — capture the outgoing state so the async AI change
      // summary can diff old vs new. Soft: a failed pre-read just means
      // no summary.
      let beforeForDiff: Item | null = null;
      if (typeof patch.content === 'string' || typeof patch.title === 'string') {
        try {
          beforeForDiff = await client.getItem(id);
        } catch {
          beforeForDiff = null;
        }
      }
      const result = await client.updateItem(id, patch);
      nukeReadCache();
      // Fire-and-forget AI annotation. Never blocks or fails the edit;
      // timeout-raced so a wedged model call can't leak (the
      // extractAssetMetadata hang lesson, 2026-08-08).
      if (beforeForDiff !== null) {
        void annotateVersionDiff(client, id, beforeForDiff, result);
      }
      return result;
    },
    async addTag(id: string, tag: string): Promise<string[]> {
      const result = await client.addTag(id, tag);
      nukeReadCache();
      return result;
    },
    async removeTag(id: string, tag: string): Promise<string[]> {
      const result = await client.removeTag(id, tag);
      nukeReadCache();
      return result;
    },
    recentCommits(id: string, opts?: RecentCommitsOpts): Promise<Event[]> {
      // Activity log is small + scrolls in the detail rail; skip
      // caching so it always reflects the latest commit history.
      return client.itemRecentCommits(id, opts ?? {});
    },
    recordView(id: string): Promise<void> {
      // Fire-and-forget audit write; never cached.
      return client.recordAssetView(id);
    },
    viewers(id: string): Promise<AssetViewer[]> {
      return client.getAssetViewers(id);
    },
    async create(input: CreateAssetInput): Promise<Item> {
      const result = await client.createAsset(input);
      nukeReadCache();
      return result;
    },
    async createBinary(input: CreateBinaryAssetInput): Promise<Item> {
      // GSX-first (ADR-050): bytes go to the account's file bucket,
      // the graph gets only the fileKey. Orchestration (validation,
      // upload-before-create, orphan cleanup) lives in
      // `create-binary.ts` behind an injected-deps seam so it's
      // unit-testable; this wrapper supplies the live deps + cache.
      const result = await createBinaryAsset(
        {
          files: getFilesApi(),
          createAsset: (assetInput) => client.createAsset(assetInput),
          assetExistsForFileKey: (fileKey: string) => client.assetExistsForFileKey(fileKey),
        warn: (message, data) => getLoggingApi().warn('spaces', message, data),
        },
        input
      );
      nukeReadCache();
      return result;
    },
    async createAgent(input: CreateAgentInput): Promise<Item> {
      const result = await client.createAgent(input);
      nukeReadCache();
      return result;
    },
    async searchAgentLibrary(q: string, limit?: number): Promise<AgentLibraryEntry[]> {
      return client.searchAgentLibrary(q, limit);
    },
    async createAgentFromLibrary(input: CreateAgentFromLibraryInput): Promise<Item> {
      const result = await client.createAgentFromLibrary(input);
      nukeReadCache();
      return result;
    },
    async delete(id: string, opts?: DeleteAssetOpts): Promise<void> {
      await client.deleteAsset(id, opts);
      nukeReadCache();
    },
    async restore(id: string): Promise<Item> {
      const result = await client.restoreAsset(id);
      nukeReadCache();
      return result;
    },
    async moveToSpace(
      id: string,
      fromSpaceId: string | null,
      toSpaceId: string
    ): Promise<Item> {
      const result = await client.moveAssetToSpace(id, fromSpaceId, toSpaceId);
      nukeReadCache();
      return result;
    },
    async addToSpace(id: string, toSpaceId: string): Promise<Item> {
      const result = await client.addAssetToSpace(id, toSpaceId);
      nukeReadCache();
      return result;
    },
    async removeFromSpace(id: string, spaceId: string): Promise<Item> {
      const result = await client.removeAssetFromSpace(id, spaceId);
      nukeReadCache();
      return result;
    },
    search(opts: SearchItemsOpts): Promise<ItemSummary[]> {
      // Search results depend on the query; don't cache since the
      // user is actively typing/refining.
      return client.searchItems(opts);
    },

    // ── Asset versioning (ADR-057) ──
    versions(id: string, limit?: number): Promise<AssetVersionSummary[]> {
      // History reads are infrequent and must reflect the edit that
      // just happened — no cache.
      return client.listItemVersions(id, limit);
    },
    getVersion(id: string, seq: number): Promise<AssetVersion | null> {
      return client.getItemVersion(id, seq);
    },
    async restoreVersion(id: string, seq: number, editorId?: string): Promise<Item> {
      const result = await client.restoreItemVersion(id, seq, editorId);
      nukeReadCache();
      return result;
    },
    async setMetadata(id: string, metadata: ItemMetadata): Promise<Item> {
      const result = await client.setMetadata(id, metadata);
      nukeReadCache();
      return result;
    },
    async patchMetadata(id: string, patch: ItemMetadata): Promise<Item> {
      const result = await client.patchMetadata(id, patch);
      nukeReadCache();
      return result;
    },
    async removeMetadataKey(id: string, key: string): Promise<Item> {
      const result = await client.removeMetadataKey(id, key);
      nukeReadCache();
      return result;
    },
  };

  const tickets: SpacesTicketsApi = {
    list(spaceId: string, opts?: ListTicketsOpts): Promise<Item[]> {
      return cache.getOrFetch(`spaces.tickets.list:${spaceId}`, () =>
        client.listTickets(spaceId, opts ?? {})
      );
    },
    async create(spaceId: string, input: CreateTicketInput): Promise<Item> {
      const result = await client.createTicket(spaceId, input);
      nukeReadCache();
      return result;
    },
    async update(id: string, patch: UpdateTicketPatch): Promise<Item> {
      const result = await client.updateTicket(id, patch);
      nukeReadCache();
      return result;
    },
  };

  const playbooks: SpacesPlaybooksApi = {
    current(spaceId: string): Promise<Item | null> {
      return cache.getOrFetch(`spaces.playbooks.current:${spaceId}`, () =>
        client.getCurrentPlaybook(spaceId)
      );
    },
    async set(spaceId: string, playbookId: string): Promise<SetPlaybookResult> {
      const result = await client.setCurrentPlaybook(spaceId, playbookId);
      nukeReadCache();
      return result;
    },
  };

  const identity: SpacesIdentityApi = {
    attributionEmailGet() {
      return readAttributionEmail();
    },

    attributionEmailSet(raw: string | null) {
      return writeAttributionEmail(raw);
    },

    async getOrCreatePerson(input: PersonUpsertInput): Promise<Person> {
      const result = await client.getOrCreatePerson(input);
      // Person changes can ripple into producedBy on items; nuke
      // reads so the next item fetch picks up the resolved name.
      nukeReadCache();
      return result;
    },
  };

  const checklists: SpacesChecklistsApi = {
    async create(input: CreateChecklistInput): Promise<Checklist> {
      const result = await client.createChecklist(input);
      nukeReadCache();
      return result;
    },
    list(spaceId: string): Promise<Checklist[]> {
      return client.listChecklists(spaceId);
    },
    async draft(prompt: string): Promise<ChecklistDraft> {
      const trimmed = typeof prompt === 'string' ? prompt.trim() : '';
      if (trimmed.length === 0 || trimmed.length > 2000) {
        throw new SpacesError({
          code: 'SPACES_INVALID_INPUT',
          message: 'Describe the checklist in 1–2000 characters',
          context: { op: 'checklists.draft' },
        });
      }
      const result = await getAiApi().chat({
        system: [
          'You draft operational checklists per The Checklist Manifesto.',
          'Return ONLY a JSON object: {"name": string (<=120 chars),',
          '"mode": "DO-CONFIRM"|"READ-DO", "pausePoint": string (WHEN it',
          'runs, e.g. "before merge"), "items": [{"text": string (<=200,',
          'one line), "killer"?: boolean (most dangerous to skip),',
          '"optional"?: boolean (nice-to-have; never with killer),',
          '"more"?: string (<=500, why/how detail)}]}.',
          'HARD RULES: 5–9 items ideal, NEVER more than 12. Items are',
          'verifications, not a how-to. Mark 1–3 killer items. Use',
          'optional sparingly. Every item one line, precise wording.',
        ].join(' '),
        messages: [{ role: 'user', content: trimmed }],
        jsonMode: true,
        maxTokens: 1200,
      });
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.content);
      } catch {
        throw new SpacesError({
          code: 'SPACES_INVALID_INPUT',
          message: 'The AI reply was not valid JSON — try rephrasing the prompt.',
          context: { op: 'checklists.draft' },
        });
      }
      const record = (parsed ?? {}) as Record<string, unknown>;
      const name =
        typeof record.name === 'string' && record.name.trim().length > 0
          ? record.name.trim().slice(0, 120)
          : 'Untitled checklist';
      const mode = record.mode === 'READ-DO' ? 'READ-DO' : 'DO-CONFIRM';
      const pausePoint =
        typeof record.pausePoint === 'string' ? record.pausePoint.trim().slice(0, 200) : '';
      // The sanitizer enforces doctrine (cap 12 REJECT, killer beats
      // optional, more<=500) exactly as a manual save would.
      const items = sanitizeChecklistItems(
        Array.isArray(record.items) ? (record.items as ChecklistItemSpec[]) : []
      );
      return { name, mode, pausePoint, items };
    },

    async update(input: UpdateChecklistInput): Promise<{ id: string; version: number }> {
      const result = await client.updateChecklist(input);
      nukeReadCache();
      return result;
    },
    async remove(id: string): Promise<void> {
      await client.deleteChecklist(id);
      nukeReadCache();
    },
    async attach(input: AttachChecklistInput): Promise<void> {
      await client.attachChecklist(input);
      nukeReadCache();
    },
    forTicket(ticketId: string): Promise<TicketChecklist[]> {
      return client.getTicketChecklists(ticketId);
    },
    setItem(
      input: SetChecklistItemInput
    ): Promise<{ checkedIndexes: number[]; complete: boolean }> {
      return client.setChecklistItem(input);
    },
    async detach(
      ticketId: string,
      checklistId: string,
      phase: ChecklistPhase
    ): Promise<void> {
      await client.detachChecklist(ticketId, checklistId, phase);
      nukeReadCache();
    },
  };

  const members: SpacesMembersApi = {
    list(spaceId: string): Promise<SpaceMember[]> {
      return cache.getOrFetch(`spaces.members.list:${spaceId}`, () =>
        client.listSpaceMembers(spaceId)
      );
    },
    async add(
      spaceId: string,
      memberId: string,
      opts?: AddSpaceMemberOptions
    ): Promise<SpaceMember> {
      const result = await client.addSpaceMember(spaceId, memberId, opts);
      nukeReadCache();
      return result;
    },
    async remove(spaceId: string, memberId: string): Promise<void> {
      await client.removeSpaceMember(spaceId, memberId);
      nukeReadCache();
    },
    searchLibrary(q: string, limit?: number): Promise<MemberLibraryEntry[]> {
      return client.searchMemberLibrary(q, limit);
    },
  };

  return {
    open: handle.open,
    listSpaces(): Promise<Space[]> {
      return cache.getOrFetch(SPACES_CACHE_KEYS.LIST_SPACES, () => client.listSpaces());
    },
    async refresh(): Promise<void> {
      // Nuke the whole read cache: a Space created elsewhere changes
      // the list AND the home rollups AND (potentially) any scope's
      // item list, so a targeted invalidation would leave stale
      // corners behind. Entries refetch lazily on next read; we await
      // the space list so callers can trust it landed.
      const removed = cache.invalidate(() => true);
      getLoggingApi().info('spaces', 'manual refresh -- cache invalidated', {
        invalidated: removed,
      });
      await cache.getOrFetch(SPACES_CACHE_KEYS.LIST_SPACES, () => client.listSpaces());
    },
    learnSignals() {
      return client.learnSignals();
    },

    learnProgressGet() {
      return readLearnProgress();
    },

    learnProgressSave(raw: unknown) {
      return writeLearnProgress(raw);
    },

    getUncategorizedCount(): Promise<number> {
      return cache.getOrFetch(SPACES_CACHE_KEYS.UNCATEGORIZED_COUNT, () =>
        client.getUncategorizedCount()
      );
    },
    items,
    tickets,
    playbooks,
    identity,
    members,
    checklists,
    async setSpaceKind(id: string, kind: SpaceKind): Promise<SpaceKind> {
      const result = await client.setSpaceKind(id, kind);
      nukeReadCache();
      return result;
    },

    // ─── Home view (chunk 3k + 3o) ──────────────────────────────────────
    getEntityCounts(): Promise<EntityCounts> {
      return cache.getOrFetch(SPACES_CACHE_KEYS.HOME_ENTITY_COUNTS, () =>
        client.getEntityCounts()
      );
    },
    listRecentItems(opts?: RecentItemsOpts): Promise<ItemSummary[]> {
      return cache.getOrFetch(SPACES_CACHE_KEYS.HOME_RECENT_ITEMS, () =>
        client.listRecentItems(opts)
      );
    },
    topContributors(opts?: TopContributorsOpts): Promise<Contributor[]> {
      return cache.getOrFetch(SPACES_CACHE_KEYS.HOME_TOP_CONTRIBUTORS, () =>
        client.topContributors(opts)
      );
    },
    listRecentEvents(opts?: RecentEventsOpts): Promise<Event[]> {
      return cache.getOrFetch(SPACES_CACHE_KEYS.HOME_RECENT_EVENTS, () =>
        client.listRecentEvents(opts)
      );
    },
    listAgentsSample(opts?: AgentsSampleOpts): Promise<AgentSummary[]> {
      return cache.getOrFetch(SPACES_CACHE_KEYS.HOME_AGENTS_SAMPLE, () =>
        client.listAgentsSample(opts)
      );
    },
    getPermissionSummary(): Promise<PermissionSummary> {
      return cache.getOrFetch(SPACES_CACHE_KEYS.HOME_PERMISSION_SUMMARY, () =>
        client.getPermissionSummary()
      );
    },

    // ─── Mutations (Phase 3a) ───────────────────────────────────────────
    async createSpace(input: CreateSpaceInput): Promise<Space> {
      const result = await client.createSpace(input);
      nukeReadCache();
      return result;
    },
    async renameSpace(id: string, name: string): Promise<Space> {
      const result = await client.renameSpace(id, name);
      nukeReadCache();
      return result;
    },
    async updateSpace(id: string, patch: UpdateSpaceInput): Promise<Space> {
      const result = await client.updateSpace(id, patch);
      nukeReadCache();
      return result;
    },
    async deleteSpace(id: string, opts?: DeleteSpaceOpts): Promise<void> {
      await client.deleteSpace(id, opts);
      nukeReadCache();
    },
    async undeleteSpace(id: string): Promise<Space> {
      const result = await client.undeleteSpace(id);
      nukeReadCache();
      return result;
    },
  };
}

// ─── Pre-warm + broadcast ────────────────────────────────────────────────

/**
 * Pre-warm the cache at app launch. Fires off every read the Spaces
 * window's first paint needs, in parallel, fire-and-forget. By the
 * time the user opens Tools -> Spaces..., these have usually settled,
 * so the first paint is instant.
 *
 * Soft-fails per query -- a single bad fetcher doesn't stall the others.
 */
function prewarmSpacesCache(api: SpacesApi, log: NonNullable<InitSpacesOptions['logger']>): void {
  const tasks: Array<Promise<unknown>> = [
    api.listSpaces().catch(() => undefined),
    api.getUncategorizedCount().catch(() => undefined),
    api.getEntityCounts().catch(() => undefined),
    api.listRecentItems().catch(() => undefined),
    api.topContributors().catch(() => undefined),
    api.listRecentEvents().catch(() => undefined),
    api.listAgentsSample().catch(() => undefined),
    api.getPermissionSummary().catch(() => undefined),
  ];
  void Promise.allSettled(tasks).then(() => {
    log.info('spaces-cache: pre-warm complete', {
      entries: activeCache?._sizeForTesting() ?? 0,
    });
  });
}

/**
 * Broadcast a cache-refresh event to every renderer. The Spaces
 * renderer subscribes via `window.lite.spaces.onCacheUpdate(...)` and
 * triggers a local re-fetch on receipt; the bridge call returns the
 * already-refreshed cached value, so the re-paint is free.
 */
function broadcastCacheUpdate(update: SpacesCacheUpdate): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(SPACES_CACHE_UPDATED_EVENT, update);
    } catch {
      /* best-effort -- a closed/crashed renderer shouldn't break others */
    }
  }
}
