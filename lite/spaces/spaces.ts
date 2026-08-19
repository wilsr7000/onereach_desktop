/**
 * Spaces window renderer.
 *
 * Phase 1 + Phase 2 scope:
 *   - Sidebar `:Space` list populated from `listSpaces()` + Uncategorized
 *     count from `getUncategorizedCount()`.
 *   - Main pane renders `items.list(scope)` as cards when a Space or
 *     Uncategorized is the active scope.
 *   - Right rail renders `items.get(id)` when a card is clicked.
 *   - Item cards carry multi-Space chips (rendered from
 *     `ItemSummary.otherSpaces` projected by Cypher).
 *
 * Chunk 3o (Home view) adds:
 *   - Home as the default scope (sidebar item, default activeScopeId).
 *   - 5-card news feed in the main pane: data-room-at-a-glance,
 *     recent activity, agents sample, permissions, just-added.
 *   - Replaces the Phase 0.5 Discovery panel (which moves to
 *     Settings -> Diagnostics for engineer access).
 *   - Stale-while-revalidate cache: 60s window per query (Q-Home-3).
 *
 * Pure DOM-construction helpers (`buildSpaceRow`, `buildItemCard`,
 * `buildSpaceChip`, `buildDetailPane`, plus the new `buildHome*`
 * builders) are exported via the `__spacesRendererForTesting`
 * window-global escape hatch so jsdom tests can exercise them
 * without booting the whole renderer.
 *
 * Built as an IIFE bundle by esbuild. Talks to the main process via
 * the preload bridge (`window.lite.spaces.*`).
 */

import { UNCATEGORIZED_SPACE_ID } from './scope.js';
import { bootRenderer } from '../renderer-boot.js';
import type {
  DiscoveryQueryResult,
  DiscoveryResults,
} from './discovery-format.js';
import {
  extractMetadataFromFile,
  extractMetadataFromText,
} from './metadata-extractor.js';
import { shouldInlineTextFile, decodeDataUrlText, isTextLikeFile } from './text-asset.js';
import {
  convertTranscript,
  detectTranscriptFormat,
  parseTranscriptTilePreview,
} from './transcript.js';

// ─── Home view (chunk 3o) ───────────────────────────────────────────────

/**
 * Synthetic id for the Home scope. Distinguished from
 * `UNCATEGORIZED_SPACE_ID` so the scope discriminator can branch
 * cleanly. Used as `data-scope-id` on the sidebar Home row.
 */
import {
  CHECKLIST_MANIFESTO,
  COACH_ALL_CLEAR,
  lintChecklistDraft,
} from './checklist-manifesto.js';
import {
  renderInlineMarkdown,
  renderMarkdown,
  buildHexMazeLogo,
} from './render-shared.js';

// Moved to render-shared.ts (2026-08-07) so the main window's Learning
// Center shares them; re-exported so existing imports/tests hold.
export { renderInlineMarkdown, renderMarkdown, buildHexMazeLogo };

const HOME_SCOPE_ID = '__home__';

/** Cache window for Home SDK responses. Per Q-Home-3 default (60s). */
const HOME_CACHE_TTL_MS = 60_000;

/**
 * Space-objective length cap — MUST equal `MAX_SPACE_DESC_LENGTH` in
 * lite/spaces/types.ts (the server-side validator). Pinned equal by a
 * renderer test so the two can never drift. Raised 400 -> 3000
 * (2026-08-12): real pasted briefs are longer than a tweet.
 */
export const SPACE_OBJECTIVE_MAX = 3000;

// ─── Domain shapes ───────────────────────────────────────────────────────
//
// `LiteSpace`, `LiteSpaceChipRef`, `LiteSpaceItemSummary`, `LiteSpaceItem`
// are ambient globals declared in lite-window.d.ts -- they mirror the
// `Space` / `ItemSummary` / `Item` types in lite/spaces/types.ts. Using
// the ambients here keeps the renderer bundle decoupled from the
// main-process module while staying type-safe at the bridge boundary.

type RendererSpace = LiteSpace;
type RendererSpaceChipRef = LiteSpaceChipRef;
type RendererItemSummary = LiteSpaceItemSummary;
type RendererItem = LiteSpaceItem;

// Home view types (chunk 3o). Mirror the bridge-side types in
// lite-window.d.ts; aliased here for renderer-local readability.
type RendererEntityCounts = LiteSpacesEntityCountsView;
type RendererContributor = LiteSpacesContributorView;
type RendererAgentSummary = LiteSpacesAgentSummaryView;
type RendererPermissionSummary = LiteSpacesPermissionSummaryView;
type RendererEvent = LiteSpacesEventView;

/**
 * Home filter modes. Apply to the unified timeline:
 *   - 'all'    -- show every row (default)
 *   - 'people' -- producer is a Person, or author doesn't look agent-y
 *   - 'agents' -- producer is an Agent, or author contains 'agent'/'bot'
 *   - '24h'    -- timestamp within the last 24 hours
 *   - '7d'     -- timestamp within the last 7 days
 *
 * Filters compose with the timeline merge: we filter the merged
 * chronological list, not the underlying query results.
 */
export type HomeFilter = 'all' | 'people' | 'agents' | '24h' | '7d';

/**
 * One unified row in the Home timeline. Both events (commits) and
 * items (newly added assets) project into this shape so the renderer
 * has one row builder and one filter rule. Source-tagged so the
 * filter can branch (e.g. "Mine" vs "Agents") and the row chrome can
 * vary (items get an excerpt; events don't).
 */
export interface TimelineRow {
  kind: 'item' | 'event';
  id: string;
  /** Producer display string (raw `:Commit.author` or `:Person.name`). */
  author: string;
  /** Verb phrase: "added", "updated", "produced", or a freeform commit kind. */
  verb: string;
  /** Object phrase: item title for items; "Audit_2026Q1.docx" or fallback for events. */
  object: string;
  /** Space chip (when known). */
  space?: RendererSpaceChipRef;
  /** ISO timestamp used for sort + filter. */
  timestamp: string;
  /** Excerpt: items only (events don't have one). */
  excerpt?: string;
  /** Whether the producer was an Agent (drives icon + 'Agents' filter). */
  fromAgent: boolean;
  /** Pass-through item id when `kind === 'item'`, for click-to-open. */
  itemId?: string;
  /** Pass-through space id for click-to-open. */
  spaceId?: string;
}

// ─── State ──────────────────────────────────────────────────────────────

export type SpacesSortMode = 'name' | 'recent';

/**
 * Per-card cache entry. `value` is the last successful response;
 * `fetchedAt` is the epoch ms when it landed. The renderer treats
 * an entry as fresh while `Date.now() - fetchedAt < HOME_CACHE_TTL_MS`.
 */
interface HomeCacheEntry<T> {
  value: T | null;
  fetchedAt: number;
  loading: boolean;
  error: string | null;
}

interface HomeCardCache {
  counts: HomeCacheEntry<RendererEntityCounts>;
  contributors: HomeCacheEntry<RendererContributor[]>;
  agents: HomeCacheEntry<RendererAgentSummary[]>;
  permission: HomeCacheEntry<RendererPermissionSummary>;
  recentItems: HomeCacheEntry<RendererItemSummary[]>;
  /**
   * `:Commit` events powering the unified timeline. Fetched at
   * `limit: 50` so the merged-with-items feed has enough material
   * for filter chips to feel responsive.
   */
  events: HomeCacheEntry<RendererEvent[]>;
}

function emptyCacheEntry<T>(): HomeCacheEntry<T> {
  return { value: null, fetchedAt: 0, loading: false, error: null };
}

interface SpacesRendererState {
  activeScopeId: string;
  spaces: RendererSpace[];
  uncategorizedCount: number;
  items: RendererItemSummary[];
  activeItemId: string | null;
  loadingSpaces: boolean;
  loadingItems: boolean;
  loadingDetail: boolean;
  searchQuery: string;
  sortMode: SpacesSortMode;
  lastDiscovery: DiscoveryResults | null;
  discoveryInFlight: boolean;
  /** Home view cache. Per Q-Home-3 (60s stale-while-revalidate). */
  home: HomeCardCache;
  /** Active filter for the unified timeline (shared by Home + Space). */
  homeFilter: HomeFilter;
  /**
   * Space-scoped event cache. When the user clicks a real Space, the
   * renderer fetches commits filtered to `spaceId` via
   * `recentEvents({ spaceId })` and stashes them here. Items for the
   * same Space already live in `state.items` (populated by
   * `loadItems()`); the merged timeline reads from both.
   *
   * `forScopeId` is the cache-validity key — we drop stale data when
   * the user navigates to a different Space.
   */
  spaceEvents: HomeCacheEntry<RendererEvent[]>;
  spaceEventsForScopeId: string | null;
  /**
   * Render-time markers from `localStorage` (preferences live device-
   * locally so they don't round-trip the network). `welcomeDismissed`
   * gates the first-run welcome card; `lastVisitMs` powers the
   * "since you last visited" hairline; `currentVisitMs` is set once
   * per Spaces-window open so the hairline keeps reading "since X"
   * even as the user clicks around within this session.
   */
  welcomeDismissed: boolean;
  lastVisitMs: number | null;
  currentVisitMs: number;
  /**
   * Phase 4 v2 — identity. Stashed once on boot from
   * `bridge.auth.getSession()` + `bridge.spaces.identity.getOrCreatePerson()`.
   * Null until the prefetch resolves, which is fine — every code path
   * that consumes it (attribution, assignee) tolerates null.
   */
  currentUser: { id: string; name: string; email?: string } | null;
  /**
   * Shared-space dashboard caches. Keyed by spaceId so a navigation
   * away + back paints the prior view instantly while the refresh
   * runs in the background.
   */
  sharedDashboards: Map<
    string,
    {
      playbook: RendererItem | null;
      tickets: RendererItem[];
      members: ReadonlyArray<LiteSpacesMemberView>;
      fetchedAt: number;
      /**
       * Per-section load failures (2026-08-08 release review). A failed
       * read keeps the prior section data and records the message here,
       * so the dashboard renders an error banner instead of passing off
       * "the query failed" as "no tickets" / "no members" — on a
       * multi-user surface those read as facts about the team.
       */
      errors?: { playbook?: string; tickets?: string; members?: string };
    }
  >;
  /** Polling timer handle for the active scope (Tier 3c). */
  pollTimer: number | null;
  /** Sprint 3 — current items-search query (debounced, then filters list). */
  itemsSearchQuery: string;
  /**
   * Scope of the ONE content search (2026-08-19). 'space' searches the
   * active Space, 'all' searches every Space the viewer can see. Home
   * forces 'all' — it isn't a Space, so there is nothing to narrow to.
   */
  itemsSearchScope: 'space' | 'all';
  /** Debounce timer for itemsSearchQuery. */
  itemsSearchTimer: number | null;
  /** Sprint 3 — last fetched search results (when query is non-empty). */
  itemsSearchResults: RendererItemSummary[] | null;
  /**
   * Bulk-select state. Holds the ids of items the user has Cmd/Ctrl-
   * clicked. Empty Set = no selection active = toolbar hidden. The
   * timeline / card builders read this to render the row's selected
   * state; the toolbar reads it to render its "Move N" / "Delete N"
   * labels.
   */
  selectedItemIds: Set<string>;
}

const state: SpacesRendererState = {
  activeScopeId: HOME_SCOPE_ID,
  spaces: [],
  uncategorizedCount: 0,
  items: [],
  activeItemId: null,
  loadingSpaces: true,
  loadingItems: false,
  loadingDetail: false,
  searchQuery: '',
  // ADR-069 — activity is the resting order (data speaks); A→Z stays
  // one select away for people who think alphabetically.
  sortMode: 'recent',
  lastDiscovery: null,
  discoveryInFlight: false,
  home: {
    counts: emptyCacheEntry<RendererEntityCounts>(),
    contributors: emptyCacheEntry<RendererContributor[]>(),
    agents: emptyCacheEntry<RendererAgentSummary[]>(),
    permission: emptyCacheEntry<RendererPermissionSummary>(),
    recentItems: emptyCacheEntry<RendererItemSummary[]>(),
    events: emptyCacheEntry<RendererEvent[]>(),
  },
  homeFilter: 'all',
  spaceEvents: emptyCacheEntry<RendererEvent[]>(),
  spaceEventsForScopeId: null,
  welcomeDismissed: readWelcomeDismissed(),
  lastVisitMs: readLastVisitMs(),
  currentVisitMs: Date.now(),
  currentUser: null,
  sharedDashboards: new Map(),
  pollTimer: null,
  itemsSearchQuery: '',
  itemsSearchScope: 'space',
  itemsSearchTimer: null,
  itemsSearchResults: null,
  selectedItemIds: new Set<string>(),
};

// ─── Home preferences (localStorage) ────────────────────────────────────
//
// Renderer-side preferences live in localStorage so they don't pay the
// KV round-trip. These keys are scoped to this device intentionally
// -- "have you seen the welcome" and "when did you last visit" are
// per-device signals, not per-account ones.

const STORAGE_WELCOME_KEY = 'lite-spaces-home.welcome-seen';
const STORAGE_LAST_VISIT_KEY = 'lite-spaces-home.last-visit';

function readWelcomeDismissed(): boolean {
  try {
    return localStorage.getItem(STORAGE_WELCOME_KEY) === '1';
  } catch {
    // localStorage may be disabled in some sandboxes; default to
    // "not dismissed" so the welcome card still renders.
    return false;
  }
}

function readLastVisitMs(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_LAST_VISIT_KEY);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function markWelcomeSeen(): void {
  try {
    localStorage.setItem(STORAGE_WELCOME_KEY, '1');
  } catch {
    // best-effort
  }
}

export function markVisitNow(): void {
  try {
    localStorage.setItem(STORAGE_LAST_VISIT_KEY, String(Date.now()));
  } catch {
    // best-effort
  }
}

// ─── Bootstrap ──────────────────────────────────────────────────────────

function init(): void {
  // Opaque identity cover FIRST — anonymous eyes never see the shared
  // account's content, not even for one paint (2026-08-13).
  mountIdentityBootGate();
  applyActiveRow(state.activeScopeId);
  wireSidebarClicks();
  wireSidebarSections();
  wireSidebarToolbar();
  wireSidebarSearch();
  wireSidebarSort();
  wireMutationsUI();
  wireCacheUpdates();
  // Home is the default scope -- show its region, hide the items
  // region. This ensures first paint matches state even if
  // `setActiveScope` never runs.
  applyScopeRegions(state.activeScopeId);
  void initialLoad();
}

/**
 * Subscribe to main-process cache-refresh broadcasts and trigger the
 * matching local re-fetch. Three sources fire these events:
 *   1. App-launch pre-warm completing.
 *   2. The background refresh timer (~60s cadence).
 *   3. Post-mutation invalidation (each write nukes the read cache;
 *      the next read repopulates and fires this event).
 *
 * The renderer's reload functions all call through `window.lite.spaces.*`,
 * which is now cache-fronted, so the re-fetch is essentially free --
 * the bridge call returns the already-refreshed cached value.
 *
 * Idempotent: calling `init()` twice (e.g. via reinitForTesting) only
 * subscribes once because the previous subscription is dropped on the
 * second call via `cacheUpdateUnsubscribe`.
 */
let cacheUpdateUnsubscribe: (() => void) | null = null;
/** Guards against overlapping refreshes (focus + click racing). */
let refreshInFlight = false;
/** Epoch ms of the last focus-triggered refresh. */
let lastFocusRefreshAt = 0;
/** Don't refetch more than once per this window on focus. */
const FOCUS_REFRESH_THROTTLE_MS = 10_000;
function wireCacheUpdates(): void {
  if (cacheUpdateUnsubscribe !== null) {
    try {
      cacheUpdateUnsubscribe();
    } catch {
      /* best-effort */
    }
    cacheUpdateUnsubscribe = null;
  }
  const sub = window.lite?.spaces?.onCacheUpdate;
  if (typeof sub !== 'function') return; // bridge not present (test env)
  cacheUpdateUnsubscribe = sub((update) => {
    // Every event is a health heartbeat for the staleness watchdog…
    markCacheBroadcast();
    // …but repaints happen only when the data actually differs —
    // the periodic graph poll must never flicker an unchanged page
    // (2026-08-18). Missing flag (older main) = assume changed.
    if (update.changed === false) return;
    routeCacheUpdate(update.key);
  });
}

function routeCacheUpdate(key: string): void {
  // listSpaces / uncategorizedCount -- sidebar.
  if (key === 'spaces.listSpaces') {
    void loadSpaces();
    return;
  }
  if (key === 'spaces.uncategorizedCount') {
    void loadUncategorizedCount();
    return;
  }
  // Any home-view key -- reload Home if it's the active scope.
  if (key.startsWith('spaces.home.')) {
    if (state.activeScopeId === HOME_SCOPE_ID) {
      void loadHome();
    }
    return;
  }
  // items.list:<scopeId> -- reload items only if it's the active scope.
  if (key.startsWith('spaces.items.list:')) {
    const scopeId = key.slice('spaces.items.list:'.length);
    const activeMatches =
      (scopeId === '__uncategorized__' && state.activeScopeId === UNCATEGORIZED_SPACE_ID) ||
      scopeId === state.activeScopeId;
    if (activeMatches) void loadItems();
    return;
  }
  // items.get:<id> -- reload detail rail only if the item is open.
  if (key.startsWith('spaces.items.get:')) {
    const itemId = key.slice('spaces.items.get:'.length);
    if (itemId === state.activeItemId) void loadItemDetail(itemId);
    return;
  }
  // tickets / playbooks / members per-space -- only refresh if it's the
  // active scope. The dashboard renderer keys off state.activeScopeId
  // for its own data so a generic loadItems() is enough.
  if (
    key.startsWith('spaces.tickets.list:') ||
    key.startsWith('spaces.playbooks.current:') ||
    key.startsWith('spaces.members.list:')
  ) {
    const scopeId = key.split(':')[1] ?? '';
    if (scopeId === state.activeScopeId) void loadItems();
  }
}

async function initialLoad(): Promise<void> {
  // Sidebar always loads (Spaces list + Uncategorized count); Home
  // and items load based on the active scope. Home is the default.
  // Identity prefetch (Phase 4 v2) runs in parallel — its failure is
  // soft: the renderer still works without a stashed Person id, just
  // with anonymous attribution.
  // Identity settles the boot gate the moment it resolves — it never
  // waits on the data loads (and they never wait on it).
  const identityWork = loadCurrentUser().then((status) => {
    settleIdentityGate(status);
  });
  const sidebarWork: Array<Promise<void>> = [
    loadSpaces(),
    loadUncategorizedCount(),
    identityWork,
  ];
  if (state.activeScopeId === HOME_SCOPE_ID) {
    sidebarWork.push(loadHome());
  } else {
    sidebarWork.push(loadItems());
  }
  await Promise.all(sidebarWork);
}

/**
 * Resolve "who am I" from the Auth bridge, then MERGE a :Person row
 * with that id so every subsequent `[:CREATED]` / `[:LAST_EDITED]` /
 * `[:ASSIGNED_TO]` MERGE finds a row to link.
 *
 * Soft-fails: missing bridge, signed-out user, or upsert failure all
 * leave `state.currentUser` null. The SDK's "anonymous edit" path
 * runs in that case.
 */
/**
 * Identity-gate outcome of the boot person-bootstrap (2026-08-13).
 * 'ok'          — session with a usable email; Person ensured.
 * 'no-session'  — nobody is signed in: the gate must demand sign-in.
 * 'no-email'    — signed in but the session carries no email and no
 *                 attribution email is stored: the gate asks for one.
 * 'soft-error'  — infrastructure hiccup (bridge missing, IPC threw):
 *                 never lock the app on these, keep legacy behavior.
 */
export type IdentityStatus = 'ok' | 'no-session' | 'no-email' | 'soft-error';

async function loadCurrentUser(): Promise<IdentityStatus> {
  const w = window as unknown as {
    lite?: {
      auth?: {
        getSession(env: string): Promise<{
          session: {
            accountId: string;
            email?: string;
            gsxMultiUserId?: string;
            gsxUserId?: string;
            gsxEmail?: string;
          } | null;
        }>;
      };
      spaces?: {
        identity?: {
          attributionEmailGet(): Promise<
            { ok: true; value: string | null } | { ok: false }
          >;
          getOrCreatePerson(input: {
            id: string;
            name?: string;
            email?: string;
            gsxMultiUserId?: string;
            gsxAccountId?: string;
            gsxUserId?: string;
            gsxEmail?: string;
          }): Promise<{ ok: true; value: { id: string; name: string; email?: string } } | { ok: false }>;
        };
      };
    };
  };
  const auth = w.lite?.auth;
  const identity = w.lite?.spaces?.identity;
  if (auth === undefined || identity === undefined) return 'soft-error';
  try {
    // Lite ships only the 'edison' environment in v1; if more land we
    // can read the active env from settings.
    const res = await auth.getSession('edison');
    const session = res.session;
    if (session === null) return 'no-session';
    let email = typeof session.email === 'string' ? session.email.trim().toLowerCase() : '';
    if (email.length === 0) {
      // Some sign-in flows never put an email in the or-cookie
      // (verified live on this install). Fall back to the
      // user-declared attribution email (Settings → Account) before
      // giving up — never manufacture a UUID Person.
      const fallback = await identity.attributionEmailGet();
      if (fallback.ok && fallback.value !== null) {
        email = fallback.value;
      }
    }
    if (email.length === 0) {
      // Still "skipping person bootstrap" — never manufacture a UUID
      // Person; the identity gate takes over and asks for the email.
      console.warn('[spaces] no email in session; skipping person bootstrap — gate takes over');
      return 'no-email';
    }
    const id = email;
    const name = personNameFromEmail(email) ?? email;
    // ADR-068 — log the GSX identity on the Person. accountId is the GSX
    // primary account; gsxMultiUserId is the canonical per-human id.
    const upsertPayload: {
      id: string;
      name: string;
      email?: string;
      gsxMultiUserId?: string;
      gsxAccountId?: string;
      gsxUserId?: string;
      gsxEmail?: string;
    } = {
      id,
      name,
      email,
      ...(typeof session.gsxMultiUserId === 'string' ? { gsxMultiUserId: session.gsxMultiUserId } : {}),
      ...(typeof session.accountId === 'string' ? { gsxAccountId: session.accountId } : {}),
      ...(typeof session.gsxUserId === 'string' ? { gsxUserId: session.gsxUserId } : {}),
      ...(typeof session.gsxEmail === 'string' ? { gsxEmail: session.gsxEmail } : {}),
    };
    const envelope = await identity.getOrCreatePerson(upsertPayload);
    if (envelope.ok === false) return 'soft-error';
    state.currentUser = {
      id: envelope.value.id,
      name: envelope.value.name.length > 0 ? envelope.value.name : name,
      ...(envelope.value.email !== undefined ? { email: envelope.value.email } : {}),
    };
    return 'ok';
  } catch (err) {
    window.logging?.warn?.('spaces', 'loadCurrentUser failed', { error: messageFrom(err) });
    // Soft failure: keep currentUser null and proceed.
    return 'soft-error';
  }
}

// ─── Identity gate (2026-08-13) ─────────────────────────────────────────
//
// A fresh install must know WHO is working before Spaces shows the
// shared account's content: sign in with GSX right away, and the
// Person is created in the graph on first sign-in (unless one
// exists — `getOrCreatePerson` is a MERGE). The overlay mounts opaque
// before first paint so anonymous eyes never see data, then either
// dissolves (identity ok) or becomes the sign-in wall.

let identityGateEl: HTMLElement | null = null;
let identityGateWatchdog: number | null = null;

/** Opaque cover, mounted synchronously in init() before any paint. */
export function mountIdentityBootGate(): void {
  if (identityGateEl !== null) return;
  const gate = document.createElement('div');
  gate.className = 'spaces-identity-gate';
  document.body.appendChild(gate);
  identityGateEl = gate;
  // Never lock the app on infrastructure silence: if identity hasn't
  // resolved in 8s, fall back to legacy (ungated) behavior and log.
  identityGateWatchdog = window.setTimeout(() => {
    window.logging?.warn?.('spaces', 'identity gate watchdog fired — settling soft');
    settleIdentityGate('soft-error');
  }, 8000);
}

/** Resolve the boot cover into: gone (ok/soft) or a sign-in wall. */
export function settleIdentityGate(status: IdentityStatus): void {
  if (identityGateWatchdog !== null) {
    window.clearTimeout(identityGateWatchdog);
    identityGateWatchdog = null;
  }
  const gate = identityGateEl;
  if (gate === null || !gate.isConnected) return;
  if (status === 'ok' || status === 'soft-error') {
    gate.remove();
    identityGateEl = null;
    return;
  }
  gate.replaceChildren(buildIdentityGatePanel(status));
}

/** The wall itself. Exported for tests. */
export function buildIdentityGatePanel(kind: 'no-session' | 'no-email'): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'spaces-identity-gate-panel';

  const title = document.createElement('h2');
  title.className = 'spaces-identity-gate-title';
  title.textContent = kind === 'no-session' ? 'Sign in to Spaces' : 'Confirm your email';
  panel.appendChild(title);

  const body = document.createElement('p');
  body.className = 'spaces-identity-gate-body';
  body.textContent =
    kind === 'no-session'
      ? 'Spaces is a shared workspace, so it needs to know who you are. Sign in with your GSX account — your user is created in the graph the first time.'
      : 'You are signed in, but the session has no email address. Enter your work email so your work is attributed to you.';
  panel.appendChild(body);

  const error = document.createElement('p');
  error.className = 'spaces-identity-gate-error';
  error.hidden = true;

  if (kind === 'no-session') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'spaces-identity-gate-signin';
    btn.textContent = 'Sign in with GSX';
    btn.addEventListener('click', () => {
      void (async (): Promise<void> => {
        const identity = (
          window as unknown as {
            lite?: { spaces?: { identity?: { requestSignIn(): Promise<
              { ok: true; value: { email: string | null; accountId: string | null } } | { ok: false; error: { message: string } }
            > } } };
          }
        ).lite?.spaces?.identity;
        if (identity === undefined) return;
        btn.disabled = true;
        btn.textContent = 'Opening GSX sign-in…';
        error.hidden = true;
        try {
          const res = await identity.requestSignIn();
          if (res.ok === true) {
            // Reload boots clean with the session present; the Person
            // MERGE (or the no-email wall) happens on the way back in.
            window.location.reload();
            return;
          }
          error.textContent = res.error.message;
          error.hidden = false;
        } catch (err) {
          error.textContent = messageFrom(err);
          error.hidden = false;
        }
        btn.disabled = false;
        btn.textContent = 'Sign in with GSX';
      })();
    });
    panel.appendChild(btn);
  } else {
    const input = document.createElement('input');
    input.type = 'email';
    input.className = 'spaces-identity-gate-email';
    input.placeholder = 'you@company.com';
    input.autocomplete = 'email';
    panel.appendChild(input);

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'spaces-identity-gate-signin';
    save.textContent = 'Continue';
    const submit = (): void => {
      void (async (): Promise<void> => {
        const value = input.value.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
          error.textContent = 'Enter a valid email address.';
          error.hidden = false;
          return;
        }
        const identity = (
          window as unknown as {
            lite?: { spaces?: { identity?: { attributionEmailSet(email: string | null): Promise<
              { ok: true; value: string | null } | { ok: false; error: { message: string } }
            > } } };
          }
        ).lite?.spaces?.identity;
        if (identity === undefined) return;
        save.disabled = true;
        error.hidden = true;
        try {
          const res = await identity.attributionEmailSet(value);
          if (res.ok === true) {
            window.location.reload();
            return;
          }
          error.textContent = res.error.message;
          error.hidden = false;
        } catch (err) {
          error.textContent = messageFrom(err);
          error.hidden = false;
        }
        save.disabled = false;
      })();
    };
    save.addEventListener('click', submit);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') submit();
    });
    panel.appendChild(save);
    queueMicrotask(() => input.focus());
  }

  panel.appendChild(error);
  return panel;
}

/**
 * Derive a friendly display name from an email's local part:
 * "robb.wilson@onereach.ai" → "Robb Wilson". Returns null on bad input
 * so the caller can fall back to the accountId.
 */
function personNameFromEmail(email: string): string | null {
  if (email.length === 0) return null;
  const atIdx = email.indexOf('@');
  if (atIdx <= 0) return null;
  const local = email.slice(0, atIdx);
  return local
    .split(/[._-]/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

async function loadSpaces(): Promise<void> {
  state.loadingSpaces = true;
  const bridge = window.lite?.spaces;
  if (bridge === undefined) {
    state.loadingSpaces = false;
    renderSpaceListError('Bridge unavailable. Reload the window.');
    return;
  }
  try {
    const envelope = await bridge.listSpaces();
    state.loadingSpaces = false;
    if (envelope.ok === false) {
      renderSpaceListError(envelope.error.message);
      return;
    }
    state.spaces = envelope.value.filter(isWellFormedSpace);
    renderSpaceList();
    markSpacesBootSucceeded();
  } catch (err) {
    window.logging?.error?.('spaces', 'loadSpaces failed', { error: messageFrom(err) });
    if (isServiceDegraded()) {
      // The pulse banner owns the outage story; keep last-good content
      // instead of painting this pane red.
      state.loadingSpaces = false;
      return;
    }
    state.loadingSpaces = false;
    renderSpaceListError(messageFrom(err));
  }
}

async function loadUncategorizedCount(): Promise<void> {
  const bridge = window.lite?.spaces;
  if (bridge === undefined) return;
  try {
    const envelope = await bridge.getUncategorizedCount();
    if (envelope.ok === false) {
      renderUncategorizedCount(null);
      return;
    }
    state.uncategorizedCount = envelope.value;
    renderUncategorizedCount(envelope.value);
  } catch (err) {
    window.logging?.warn?.('spaces', 'loadUncategorizedCount failed', { error: messageFrom(err) });
    renderUncategorizedCount(null);
  }
}

// ─── Sidebar search + sort (Phase 1f) ──────────────────────────────────

function wireSidebarSearch(): void {
  const input = document.getElementById('spaces-sidebar-search-input');
  if (!(input instanceof HTMLInputElement)) return;
  input.addEventListener('input', () => {
    state.searchQuery = input.value;
    // A FILTER, not a search (2026-08-19). This box used to do both:
    // narrow the nav by Space name AND run a debounced cross-space item
    // search whose results landed in a cramped sidebar tree. Content
    // search now lives in the main pane with a scope control, so this
    // box does the one thing its position implies — narrow the list
    // below it.
    applySidebarFilter();
  });
  input.addEventListener('keydown', (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    if (input.value.length > 0) {
      input.value = '';
      state.searchQuery = '';
      applySidebarFilter();
      event.stopPropagation();
      return;
    }
    setSectionCollapsed('search', true);
  });
}

function wireSidebarSort(): void {
  const select = document.getElementById('spaces-sidebar-sort-select');
  if (!(select instanceof HTMLSelectElement)) return;
  // ADR-069 — the select must reflect the state default ('recent':
  // data speaks; alphabetical is a choice, not the resting order).
  select.value = state.sortMode;
  select.addEventListener('change', () => {
    const value = select.value;
    if (value === 'name' || value === 'recent') {
      state.sortMode = value;
      renderSpaceList();
    }
  });
}

function applySidebarFilter(): void {
  const query = normalizeSearchQuery(state.searchQuery);
  // Uncategorized: always pinned. Hidden ONLY when the user types
  // a non-matching string. An empty query keeps it visible.
  const intakeRow = document.querySelector<HTMLElement>(
    `.spaces-row[data-scope-id="${UNCATEGORIZED_SPACE_ID}"]`
  );
  if (intakeRow !== null) {
    const intakeVisible = query.length === 0 || matchesSearchQuery('Uncategorized', query);
    intakeRow.classList.toggle('is-hidden', !intakeVisible);
  }
  // Spaces list rows.
  const rows = Array.from(
    document.querySelectorAll<HTMLElement>('#spaces-list-spaces .spaces-row')
  );
  for (const row of rows) {
    const name = row.querySelector<HTMLElement>('.spaces-row-name')?.textContent ?? '';
    const visible = query.length === 0 || matchesSearchQuery(name, query);
    row.classList.toggle('is-hidden', !visible);
    // A filtered-out Space also hides its expanded item tree (the
    // holder is the row's immediate sibling, see buildSpaceChildren).
    const holder = row.nextElementSibling;
    if (holder instanceof HTMLElement && holder.classList.contains('spaces-tree-children-holder')) {
      holder.classList.toggle('is-hidden', !visible);
    }
  }
}

// ─── VS Code-style sidebar (WISER Playbooks parity, 2026-08-07) ────────
//
// The sidebar mirrors the WISER Playbooks explorer: collapsible
// chevroned sections (Search / Recent / Intake / Spaces), a global
// search that spans Space names AND item content, and per-Space item
// trees that expand in place. Section collapse state persists per
// install so the sidebar opens the way the user left it.

const SIDEBAR_COLLAPSE_KEY = 'lite.spaces.sidebar.collapsed';

/** Sections collapsed by default on first run: search stays tucked away. */
const SIDEBAR_DEFAULT_COLLAPSED: Record<string, boolean> = {
  search: true,
  recent: false,
  intake: false,
  spaces: false,
};

function readCollapsedSections(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_COLLAPSE_KEY);
    if (raw === null) return { ...SIDEBAR_DEFAULT_COLLAPSED };
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') {
      return { ...SIDEBAR_DEFAULT_COLLAPSED };
    }
    return { ...SIDEBAR_DEFAULT_COLLAPSED, ...(parsed as Record<string, boolean>) };
  } catch {
    return { ...SIDEBAR_DEFAULT_COLLAPSED };
  }
}

function persistCollapsedSections(map: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSE_KEY, JSON.stringify(map));
  } catch {
    // best-effort — a full quota just means the state doesn't stick
  }
}

function applySectionCollapsed(section: HTMLElement, collapsed: boolean): void {
  section.classList.toggle('is-collapsed', collapsed);
  const toggle = section.querySelector<HTMLElement>('[data-side-toggle]');
  if (toggle !== null) toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}

function setSectionCollapsed(name: string, collapsed: boolean): void {
  const section = document.querySelector<HTMLElement>(
    `.spaces-side-section[data-side-section="${name}"]`
  );
  if (section === null) return;
  applySectionCollapsed(section, collapsed);
  const map = readCollapsedSections();
  map[name] = collapsed;
  persistCollapsedSections(map);
}

function wireSidebarSections(): void {
  const map = readCollapsedSections();
  const sections = Array.from(
    document.querySelectorAll<HTMLElement>('.spaces-side-section[data-side-section]')
  );
  for (const section of sections) {
    const name = section.getAttribute('data-side-section') ?? '';
    applySectionCollapsed(section, map[name] === true);
  }
  // Delegated toggle clicks (headers are buttons; the Spaces header's
  // sort <select> lives OUTSIDE the button so it never toggles).
  const sidebar = document.getElementById('spaces-sidebar');
  if (sidebar === null) return;
  sidebar.addEventListener('click', (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const toggle = target.closest<HTMLElement>('[data-side-toggle]');
    if (toggle === null) return;
    const name = toggle.getAttribute('data-side-toggle') ?? '';
    const section = toggle.closest<HTMLElement>('.spaces-side-section');
    if (section === null || name.length === 0) return;
    setSectionCollapsed(name, !section.classList.contains('is-collapsed'));
  });
  // role="button" rows (Space rows, Recent rows, tree items, search
  // results) promised keyboard activation but were mouse-only
  // (2026-08-08 review): synthesize a click on Enter/Space so every
  // focusable row actually activates.
  sidebar.addEventListener('keydown', (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.getAttribute('role') !== 'button') return;
    if (target instanceof HTMLButtonElement) return; // real buttons work
    event.preventDefault();
    target.click();
  });
}

function expandAndFocusSearch(): void {
  // ⌘F means "search content", and content search lives in the main
  // pane now. The sidebar box is a nav FILTER, not a search.
  const input = document.getElementById('spaces-items-search-input');
  if (input instanceof HTMLInputElement) {
    input.focus();
    input.select();
    return;
  }
  // No main-pane box on this surface — fall back to the sidebar filter.
  setSectionCollapsed('search', false);
  const filter = document.getElementById('spaces-sidebar-search-input');
  if (filter instanceof HTMLInputElement) {
    filter.focus();
    filter.select();
  }
}

function wireSidebarToolbar(): void {
  const searchToggle = document.getElementById('spaces-sidebar-search-toggle');
  if (searchToggle !== null) {
    searchToggle.addEventListener('click', () => {
      const section = document.querySelector<HTMLElement>(
        '.spaces-side-section[data-side-section="search"]'
      );
      if (section !== null && !section.classList.contains('is-collapsed')) {
        setSectionCollapsed('search', true);
        return;
      }
      expandAndFocusSearch();
    });
  }
  const newSpace = document.getElementById('spaces-action-new-space');
  if (newSpace !== null) {
    newSpace.addEventListener('click', () => openNewSpaceDialog());
  }
  const collapseAll = document.getElementById('spaces-sidebar-collapse-all');
  if (collapseAll !== null) {
    collapseAll.addEventListener('click', () => {
      for (const name of ['pinned', 'search', 'recent', 'intake', 'spaces']) {
        setSectionCollapsed(name, true);
      }
    });
  }
  // ⌘F / Ctrl+F — the VS Code reflex. Search here means the sidebar
  // search, not a find-in-page (the window has no such affordance).
  // ⌘K / Ctrl+K — ADR-069 jump palette: past a certain scale humans
  // don't scan menus, they type three letters.
  document.addEventListener('keydown', (event: KeyboardEvent): void => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      expandAndFocusSearch();
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openSpacesPalette();
    }
  });
}

// ─── Recent section — the five most recently touched Spaces ────────────

const RECENT_SPACES_LIMIT = 5;

/**
 * Only accept plain CSS color VALUES for graph-controlled colors: hex,
 * rgb/rgba, hsl/hsla, or a bare color keyword. A shared-graph writer
 * could otherwise store `url("https://…")` and turn every sidebar
 * render into a remote beacon (CSP allows img-src https:) —
 * 2026-08-08 review.
 */
export function safeCssColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (v.length === 0 || v.length > 64) return null;
  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return v;
  if (/^(rgb|rgba|hsl|hsla)\(\s*[\d.,%\s/]+\)$/.test(v)) return v;
  if (/^[a-zA-Z]{3,24}$/.test(v)) return v;
  return null;
}

/**
 * RECENT is a flat jump list (ADR-071): rows never expand — the item
 * tree lives solely in the Spaces section's ONE open space. Recent's
 * job is "get me back there", not a second explorer.
 */
function renderRecentSpaces(): void {
  const list = document.getElementById('spaces-list-recent');
  if (list === null) return;
  list.replaceChildren();
  const recent = sortSpaces(state.spaces, 'recent').slice(0, RECENT_SPACES_LIMIT);
  if (recent.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'spaces-side-tree-empty';
    empty.textContent = 'Nothing yet';
    list.appendChild(empty);
    return;
  }
  for (const space of recent) {
    const li = document.createElement('li');
    li.className = 'spaces-row spaces-row-recent';
    li.setAttribute('data-scope-id', space.id);
    li.setAttribute('role', 'button');
    li.setAttribute('tabindex', '0');
    li.addEventListener('contextmenu', (ev) => openSpaceContextMenu(ev, space));
    const dot = document.createElement('span');
    dot.className = 'spaces-row-dot';
    const safeColor = safeCssColor(space.color);
    if (safeColor !== null) {
      dot.style.background = safeColor;
    }
    li.appendChild(dot);
    const name = document.createElement('span');
    name.className = 'spaces-row-name';
    name.textContent = space.name.length > 0 ? space.name : '(unnamed)';
    li.appendChild(name);
    list.appendChild(li);
  }
}

// ─── ADR-069 — Pinned tier, jump palette, machine-name nudge ───────────

/**
 * The human's chosen working set: pinned Spaces stay visible no matter
 * how quiet they go. Section stays `hidden` until the first pin so an
 * empty header never takes sidebar room.
 */
function renderPinnedSpaces(): void {
  const section = document.querySelector<HTMLElement>('[data-side-section="pinned"]');
  const list = document.getElementById('spaces-list-pinned');
  if (section === null || list === null) return;
  const pinned = state.spaces.filter((s) => s.pinned === true);
  if (pinned.length === 0) {
    section.hidden = true;
    list.replaceChildren();
    return;
  }
  section.hidden = false;
  list.replaceChildren();
  const ordered = sortSpaces(pinned, 'name');
  for (const space of ordered) {
    const li = document.createElement('li');
    li.className = 'spaces-row spaces-row-pinned';
    li.setAttribute('data-scope-id', space.id);
    li.setAttribute('role', 'button');
    li.setAttribute('tabindex', '0');
    li.addEventListener('contextmenu', (ev) => openSpaceContextMenu(ev, space));
    const dot = document.createElement('span');
    dot.className = 'spaces-row-dot';
    const safeColor = safeCssColor(space.color);
    if (safeColor !== null) dot.style.background = safeColor;
    li.appendChild(dot);
    const name = document.createElement('span');
    name.className = 'spaces-row-name';
    name.textContent = space.name.length > 0 ? space.name : '(unnamed)';
    li.appendChild(name);
    list.appendChild(li);
  }
}

/**
 * A Space name that no human ever chose: empty, a bare uuid/hex blob,
 * or the "Space a7671f80" shape machine writers mint. Pure; pinned by
 * unit tests — widen carefully, a false positive nags a real name.
 */
export function looksMachineNamed(name: string): boolean {
  const n = name.trim();
  if (n.length === 0) return true;
  if (/^space[\s_-]*[0-9a-f]{6,}$/i.test(n)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(n)) return true;
  if (/^[0-9a-f]{16,}$/i.test(n)) return true;
  return false;
}

/**
 * Jump-palette candidate list. Pure. Ranking: with no query, pinned
 * Spaces lead and the rest follow in activity order (the working set);
 * with a query, name-prefix matches beat substring matches, each group
 * keeping that same underlying order. Capped for keyboard reach.
 */
export function spacesPaletteEntries(
  spaces: ReadonlyArray<RendererSpace>,
  query: string
): RendererSpace[] {
  const ranked = sortSpaces(spaces, 'recent');
  const base = [
    ...ranked.filter((s) => s.pinned === true),
    ...ranked.filter((s) => s.pinned !== true),
  ];
  const q = query.trim().toLowerCase();
  if (q.length === 0) return base.slice(0, 12);
  const starts: RendererSpace[] = [];
  const contains: RendererSpace[] = [];
  for (const s of base) {
    const name = (s.name ?? '').toLowerCase();
    if (name.startsWith(q)) starts.push(s);
    else if (name.includes(q)) contains.push(s);
  }
  return [...starts, ...contains].slice(0, 12);
}

let paletteEl: HTMLElement | null = null;

function closeSpacesPalette(): void {
  if (paletteEl !== null) {
    paletteEl.remove();
    paletteEl = null;
  }
}

/**
 * ⌘K jump-to-space. Portaled to <body> (same technique as the wizard
 * typeahead — fixed position, above menus/toast, below the identity
 * gate). Type to filter, ↑/↓ to move, Enter to jump, Esc to close.
 */
function openSpacesPalette(): void {
  closeSpacesPalette();
  const overlay = document.createElement('div');
  overlay.className = 'spaces-palette-backdrop';
  overlay.addEventListener('mousedown', (ev) => {
    if (ev.target === overlay) closeSpacesPalette();
  });

  const panel = document.createElement('div');
  panel.className = 'spaces-palette';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Jump to space');

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'spaces-palette-input';
  input.placeholder = 'Jump to space…';
  input.setAttribute('aria-label', 'Type a space name');
  panel.appendChild(input);

  const list = document.createElement('ul');
  list.className = 'spaces-palette-list';
  panel.appendChild(list);

  let selected = 0;
  let entries: RendererSpace[] = [];

  const paint = (): void => {
    entries = spacesPaletteEntries(state.spaces, input.value);
    if (selected >= entries.length) selected = Math.max(0, entries.length - 1);
    list.replaceChildren();
    if (entries.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'spaces-palette-empty';
      empty.textContent = 'No matching spaces';
      list.appendChild(empty);
      return;
    }
    entries.forEach((space, index) => {
      const li = document.createElement('li');
      li.className = 'spaces-palette-row';
      if (index === selected) li.classList.add('is-selected');
      const dot = document.createElement('span');
      dot.className = 'spaces-row-dot';
      const safeColor = safeCssColor(space.color);
      if (safeColor !== null) dot.style.background = safeColor;
      li.appendChild(dot);
      const name = document.createElement('span');
      name.className = 'spaces-palette-name';
      name.textContent = space.name.length > 0 ? space.name : '(unnamed)';
      li.appendChild(name);
      if (space.pinned === true) {
        const pin = document.createElement('span');
        pin.className = 'spaces-palette-pin';
        pin.textContent = '⤒';
        pin.title = 'Pinned';
        li.appendChild(pin);
      }
      li.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        jumpTo(space);
      });
      list.appendChild(li);
    });
  };

  const jumpTo = (space: RendererSpace): void => {
    closeSpacesPalette();
    setActiveScope(space.id);
  };

  input.addEventListener('input', () => {
    selected = 0;
    paint();
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      closeSpacesPalette();
      return;
    }
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      selected = Math.min(selected + 1, Math.max(0, entries.length - 1));
      paint();
      return;
    }
    if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      selected = Math.max(selected - 1, 0);
      paint();
      return;
    }
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const space = entries[selected];
      if (space !== undefined) jumpTo(space);
    }
  });

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  paletteEl = overlay;
  paint();
  input.focus();
}

// ─── Global search — Space names + item content, grouped results ───────

/** Debounce for the cross-space item search (the name filter is live). */




/** Compact monochrome glyph per item kind for tree + result rows. */
export function itemKindGlyph(kind: string): string {
  switch (kind) {
    case 'ticket': return '◫';
    case 'agent': return '✦';
    case 'playbook': return '▤';
    case 'transcript': return '“';
    case 'journey': return '➔';
    case 'knowledge': return '◆';
    case 'image': return '▣';
    case 'video': return '▶';
    case 'audio': return '♪';
    case 'doc': return '▤';
    case 'app': return '⌘';
    default: return '▪';
  }
}


// ─── Per-Space item trees — the explorer expansion ─────────────────────

/**
 * ADR-071 — exclusive expansion: at most ONE space tree is open, ever.
 * Clicking a space opens it and closes whichever was open (selection IS
 * the expansion); null = everything collapsed, the resting state.
 * Supersedes the 2026-08-08 open-by-default explorer AND ADR-069's
 * light-based tiering attempt — the user's eye couldn't separate
 * opacity levels ("maybe they only expand when clicked and collapse
 * when others are clicked"). Structure carries the hierarchy now.
 */
let expandedSpaceId: string | null = null;

/** Remove a row's is-expanded state and its adjacent children holder. */
function collapseTreeRow(row: HTMLElement): void {
  row.classList.remove('is-expanded');
  const holder = row.nextElementSibling;
  if (
    holder instanceof HTMLElement &&
    holder.classList.contains('spaces-tree-children-holder')
  ) {
    holder.remove();
  }
}

/** Collapse whichever tree is open, wherever its row(s) live. */
function collapseExpandedTree(): void {
  if (expandedSpaceId === null) return;
  const safeId = expandedSpaceId.replace(/"/g, '\\"');
  const rows = document.querySelectorAll<HTMLElement>(
    `.spaces-row[data-scope-id="${safeId}"]`
  );
  for (const row of Array.from(rows)) collapseTreeRow(row);
  expandedSpaceId = null;
}

/**
 * Boot-burst consolidation (2026-08-17, "why 30 requests"): defer a
 * tree's items fetch until its holder is actually VISIBLE. Trees render
 * open by default, so the old immediate fetch fired one items.list per
 * space the moment the sidebar painted — most of them below the fold.
 * On-screen trees still hydrate instantly (the observer fires in the
 * same frame); off-screen ones hydrate on scroll. Environments without
 * IntersectionObserver (jsdom) fall back to the immediate fetch.
 * Exported for tests.
 */
export function whenTreeVisible(el: HTMLElement, hydrate: () => void): void {
  const IO = (window as { IntersectionObserver?: typeof IntersectionObserver })
    .IntersectionObserver;
  if (IO === undefined) {
    hydrate();
    return;
  }
  // Once-guard independent of observer semantics: hydrating twice is
  // the exact double-fetch this helper exists to prevent.
  let hydratedOnce = false;
  const observer = new IO(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          observer.disconnect();
          if (!hydratedOnce) {
            hydratedOnce = true;
            hydrate();
          }
          return;
        }
      }
    },
    // Hydrate a little before the tree scrolls into view so the
    // "Loading…" flash is rare in normal scrolling.
    { rootMargin: '200px' }
  );
  observer.observe(el);
}

function buildSpaceChildren(spaceId: string): HTMLLIElement {
  const holder = document.createElement('li');
  holder.className = 'spaces-tree-children-holder';
  holder.setAttribute('data-parent-space', spaceId);
  const ul = document.createElement('ul');
  ul.className = 'spaces-side-tree spaces-tree-children';
  const loading = document.createElement('li');
  loading.className = 'spaces-side-tree-empty';
  loading.textContent = 'Loading…';
  ul.appendChild(loading);
  holder.appendChild(ul);
  whenTreeVisible(holder, () => void loadSpaceChildren(spaceId, ul));
  return holder;
}

async function loadSpaceChildren(spaceId: string, ul: HTMLUListElement): Promise<void> {
  const bridge = window.lite?.spaces;
  if (bridge === undefined) return;
  try {
    // Same call shape as the main grid ON PURPOSE: the per-scope cache
    // key ignores opts and stores the last caller's fetcher, so a
    // custom {limit:30} here poisoned the shared entry and the 60s
    // refresh re-ran it — truncating the OPEN grid to 30 items while
    // the user watched (2026-08-08 review, HIGH). The tree caps
    // client-side instead.
    const envelope = await bridge.items.list(spaceId);
    if (!ul.isConnected) return; // re-render replaced the tree
    ul.replaceChildren();
    if (envelope.ok === false) {
      const err = document.createElement('li');
      err.className = 'spaces-side-tree-empty';
      err.textContent = 'Couldn’t load items';
      ul.appendChild(err);
      return;
    }
    const window30 = (envelope.value as RendererItemSummary[]).slice(0, 30);
    // "Hide in this space" is a local view preference (no backend) —
    // filter here and surface a chip so hidden items are recoverable.
    const items = window30.filter((i) => !isItemHiddenInSpace(spaceId, i.id));
    const hiddenCount = window30.length - items.length;
    if (window30.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'spaces-side-tree-empty';
      empty.textContent = 'Empty';
      ul.appendChild(empty);
      return;
    }
    for (const item of items) {
      const li = document.createElement('li');
      li.className = 'spaces-tree-item';
      li.setAttribute('data-item-id', item.id);
      li.setAttribute('role', 'button');
      li.setAttribute('tabindex', '0');
      const glyph = document.createElement('span');
      glyph.className = 'spaces-tree-item-glyph';
      glyph.textContent = itemKindGlyph(item.kind);
      li.appendChild(glyph);
      const title = document.createElement('span');
      title.className = 'spaces-tree-item-title';
      title.textContent = generateItemTitle(item);
      li.appendChild(title);
      li.addEventListener('click', () => {
        setActiveScope(spaceId);
        void loadItemDetail(item.id);
        // Focus the tile too: immediately when the grid is already
        // painted (same-Space selection — the unchanged-refresh guard
        // means no repaint will come), else after the next paint.
        if (!focusItemTile(item.id)) {
          pendingTileFocusId = item.id;
        }
      });
      li.addEventListener('contextmenu', (ev) =>
        openItemContextMenu(ev, { id: item.id, title: item.title }, spaceId)
      );
      ul.appendChild(li);
    }
    if (hiddenCount > 0) {
      const chip = document.createElement('li');
      chip.className = 'spaces-side-tree-empty spaces-tree-hidden-chip';
      chip.textContent = `${hiddenCount} hidden — click to show`;
      chip.setAttribute('role', 'button');
      chip.setAttribute('tabindex', '0');
      chip.addEventListener('click', () => {
        clearHiddenItemsInSpace(spaceId);
        showToast('Hidden items restored');
        void loadSpaceChildren(spaceId, ul);
        if (state.activeScopeId === spaceId) renderItemList({});
      });
      ul.appendChild(chip);
    }
  } catch (loadErr) {
    window.logging?.warn?.('spaces', 'sidebar space-children load failed', { error: messageFrom(loadErr) });
    if (!ul.isConnected) return;
    ul.replaceChildren();
    const err = document.createElement('li');
    err.className = 'spaces-side-tree-empty';
    err.textContent = 'Couldn’t load items';
    ul.appendChild(err);
  }
}

// ─── Sidebar context menus (right-click, 2026-08-08) ───────────────────
//
// One generic anchored menu serves both targets: Space rows (share /
// unshare / upload / rename / info / convert) and item tree rows
// (add-to / move-to / remove-from space, hide). Entries are built as
// pure descriptors so tests can pin the menu logic without DOM.
//
// "Share" and "Unshare" are the ADR-051 visibility axis ('open' ↔
// 'restricted'); "Convert" is the kind axis (user ↔ shared). They are
// deliberately separate menu entries — collapsing them into one
// toggle is how access bugs get invented.

export type CtxEntry =
  | {
      type: 'action';
      label: string;
      danger?: boolean;
      disabled?: boolean;
      checked?: boolean;
      run: () => void;
    }
  | { type: 'submenu'; label: string; children: CtxEntry[] }
  | { type: 'info'; label: string; value: string }
  | { type: 'separator' };

/** Hidden-items view preference: spaceId → item ids. Local, per install. */
const HIDDEN_ITEMS_KEY = 'lite.spaces.hiddenItems';

export function readHiddenItems(): Record<string, string[]> {
  try {
    const raw = window.localStorage.getItem(HIDDEN_ITEMS_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return {};
    return parsed as Record<string, string[]>;
  } catch {
    return {};
  }
}

export function isItemHiddenInSpace(spaceId: string, itemId: string): boolean {
  const map = readHiddenItems();
  return Array.isArray(map[spaceId]) && map[spaceId].includes(itemId);
}

export function setItemHiddenInSpace(spaceId: string, itemId: string, hidden: boolean): void {
  const map = readHiddenItems();
  const current = Array.isArray(map[spaceId]) ? map[spaceId] : [];
  const next = hidden
    ? current.includes(itemId)
      ? current
      : [...current, itemId]
    : current.filter((id) => id !== itemId);
  if (next.length === 0) {
    delete map[spaceId];
  } else {
    map[spaceId] = next;
  }
  try {
    window.localStorage.setItem(HIDDEN_ITEMS_KEY, JSON.stringify(map));
  } catch {
    // best-effort view preference
  }
}

export function clearHiddenItemsInSpace(spaceId: string): void {
  const map = readHiddenItems();
  delete map[spaceId];
  try {
    window.localStorage.setItem(HIDDEN_ITEMS_KEY, JSON.stringify(map));
  } catch {
    // best-effort
  }
}

/** Menu descriptor for a Space row. Pure — pins share/convert states. */
export function buildSpaceContextEntries(
  space: RendererSpace,
  handlers: {
    share: () => void;
    unshare: () => void;
    addPeople: () => void;
    upload: () => void;
    rename: () => void;
    editObjective: () => void;
    convertShared: () => void;
    convertUser: () => void;
    setPlaybook: () => void;
    newJourney: () => void;
    deleteSpace: () => void;
    togglePin: () => void;
  }
): CtxEntry[] {
  const isOpen = space.visibility !== 'restricted';
  const isShared = space.kind === 'shared';
  return [
    {
      type: 'action',
      label: 'Share — visible to account',
      checked: isOpen,
      disabled: isOpen,
      run: handlers.share,
    },
    {
      type: 'action',
      label: 'Unshare — members only',
      checked: !isOpen,
      disabled: !isOpen,
      run: handlers.unshare,
    },
    { type: 'separator' },
    // ADR-069 — the human's override in the attention tiers: a pinned
    // Space stays in the sidebar's working set no matter how quiet it
    // goes. Per-viewer graph edge; follows you across devices.
    {
      type: 'action',
      label: space.pinned === true ? 'Unpin from sidebar' : 'Pin to sidebar',
      run: handlers.togglePin,
    },
    // The graph-backed member picker — the answer to "how do I add
    // somebody to an existing space" (2026-08-12 user report).
    { type: 'action', label: 'Add people…', run: handlers.addPeople },
    { type: 'action', label: 'Upload file…', run: handlers.upload },
    { type: 'action', label: 'Rename', run: handlers.rename },
    // Same inline editor the description click opens — this entry is
    // the discoverable route ("how do I redo the description after
    // creation", 2026-08-13 user report).
    { type: 'action', label: 'Edit description…', run: handlers.editObjective },
    // Designating the plan was reachable ONLY by selecting the asset and
    // using the detail-pane button (2026-08-18 user report: "how does a
    // user assign a current playbook to the space?"). Here it's one
    // right-click.
    { type: 'action', label: 'Set current playbook…', run: handlers.setPlaybook },
    // ADR-072 — a journey map is an ordinary asset, so it is created
    // from the Space that will hold it, not only from the Planning
    // menu. Same right-click reachability the playbook got.
    { type: 'action', label: 'New journey map…', run: handlers.newJourney },
    { type: 'separator' },
    {
      type: 'submenu',
      label: 'Convert',
      children: [
        {
          type: 'action',
          label: 'Shared space (AI-managed)',
          checked: isShared,
          disabled: isShared,
          run: handlers.convertShared,
        },
        {
          type: 'action',
          label: 'User-managed space',
          checked: !isShared,
          disabled: !isShared,
          run: handlers.convertUser,
        },
      ],
    },
    { type: 'separator' },
    // Delete lived only in the row "⋯" menu after the action
    // consolidation moved everything else here — the discoverable
    // gesture lacked it ("Can I not delete spaces?", 2026-08-16).
    // Soft delete + confirm + undo; assets move to Uncategorized.
    { type: 'action', label: 'Delete space…', run: handlers.deleteSpace },
    { type: 'separator' },
    {
      type: 'submenu',
      label: 'Info',
      children: [
        { type: 'info', label: 'Kind', value: isShared ? 'Shared (AI-managed)' : 'User-managed' },
        { type: 'info', label: 'Visibility', value: isOpen ? 'Open to account' : 'Members only' },
        {
          type: 'info',
          label: 'Items',
          value: typeof space.itemCount === 'number' ? String(space.itemCount) : '—',
        },
        {
          type: 'info',
          label: 'Created',
          value: space.createdAt !== undefined && space.createdAt.length > 0
            ? formatRelativeTime(space.createdAt)
            : '—',
        },
      ],
    },
    {
      type: 'info',
      label: 'Last updated',
      value: space.updatedAt !== undefined && space.updatedAt.length > 0
        ? formatRelativeTime(space.updatedAt)
        : '—',
    },
  ];
}

/** Menu descriptor for an item row inside a Space's tree. Pure. */
export function buildItemContextEntries(
  _item: { id: string; title: string },
  inSpaceId: string,
  allSpaces: ReadonlyArray<RendererSpace>,
  handlers: {
    addTo: (toSpaceId: string) => void;
    moveTo: (toSpaceId: string) => void;
    removeFrom: () => void;
    hide: () => void;
  }
): CtxEntry[] {
  const others = allSpaces.filter((s) => s.id !== inSpaceId);
  const toEntries = (run: (id: string) => void): CtxEntry[] =>
    others.length === 0
      ? [{ type: 'info', label: 'No other spaces', value: '' }]
      : others.map((s) => ({
          type: 'action' as const,
          label: s.name.length > 0 ? s.name : '(unnamed)',
          run: () => run(s.id),
        }));
  return [
    { type: 'submenu', label: 'Add to space', children: toEntries(handlers.addTo) },
    { type: 'submenu', label: 'Move to space', children: toEntries(handlers.moveTo) },
    { type: 'action', label: 'Remove from this space', danger: true, run: handlers.removeFrom },
    { type: 'separator' },
    { type: 'action', label: 'Hide in this space', run: handlers.hide },
  ];
}

let ctxMenuEl: HTMLDivElement | null = null;

function closeContextMenu(): void {
  if (ctxMenuEl !== null) {
    ctxMenuEl.remove();
    ctxMenuEl = null;
  }
}

function buildCtxEntryRows(host: HTMLElement, entries: CtxEntry[]): void {
  for (const entry of entries) {
    if (entry.type === 'separator') {
      const hr = document.createElement('div');
      hr.className = 'spaces-ctx-separator';
      host.appendChild(hr);
      continue;
    }
    if (entry.type === 'info') {
      const row = document.createElement('div');
      row.className = 'spaces-ctx-info';
      const label = document.createElement('span');
      label.className = 'spaces-ctx-info-label';
      label.textContent = entry.label;
      row.appendChild(label);
      const value = document.createElement('span');
      value.className = 'spaces-ctx-info-value';
      value.textContent = entry.value;
      row.appendChild(value);
      host.appendChild(row);
      continue;
    }
    if (entry.type === 'submenu') {
      // The flyout holds real <button> children, so the parent stays a
      // div — but a focusable one, so keyboard users can reach it (the
      // flyout opens on :focus-within alongside :hover).
      const row = document.createElement('div');
      row.className = 'spaces-ctx-item spaces-ctx-item-submenu';
      row.tabIndex = 0;
      row.setAttribute('role', 'menuitem');
      row.setAttribute('aria-haspopup', 'menu');
      const label = document.createElement('span');
      label.textContent = entry.label;
      row.appendChild(label);
      const arrow = document.createElement('span');
      arrow.className = 'spaces-ctx-submenu-arrow';
      arrow.textContent = '▸';
      row.appendChild(arrow);
      const fly = document.createElement('div');
      fly.className = 'spaces-ctx-flyout';
      buildCtxEntryRows(fly, entry.children);
      row.appendChild(fly);
      host.appendChild(row);
      continue;
    }
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'spaces-ctx-item';
    if (entry.danger === true) row.classList.add('is-danger');
    if (entry.disabled === true) {
      row.classList.add('is-disabled');
      // A real disabled state — no tab stop, no phantom focus ring.
      row.disabled = true;
    }
    const check = document.createElement('span');
    check.className = 'spaces-ctx-check';
    check.textContent = entry.checked === true ? '✓' : '';
    row.appendChild(check);
    const label = document.createElement('span');
    label.textContent = entry.label;
    row.appendChild(label);
    if (entry.disabled !== true) {
      const runFn = entry.run;
      row.addEventListener('click', () => {
        closeContextMenu();
        runFn();
      });
    }
    host.appendChild(row);
  }
}

export function openContextMenu(x: number, y: number, entries: CtxEntry[]): void {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'spaces-ctx-menu';
  buildCtxEntryRows(menu, entries);
  document.body.appendChild(menu);
  ctxMenuEl = menu;
  // Clamp into the viewport once measured.
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(4, Math.round(left))}px`;
  menu.style.top = `${Math.max(4, Math.round(top))}px`;
  // Flyout submenus open rightward by default; flip when there is no
  // room so they don't clip off-screen.
  if (left + rect.width + 280 > window.innerWidth) {
    menu.classList.add('is-flyout-left');
  }
  window.setTimeout(() => {
    document.addEventListener('click', closeContextMenu, { once: true });
    document.addEventListener('contextmenu', closeContextMenu, { once: true });
  }, 0);
  document.addEventListener(
    'keydown',
    (ev) => {
      if (ev.key === 'Escape') closeContextMenu();
    },
    { once: true }
  );
}

function openSpaceContextMenu(event: MouseEvent, space: RendererSpace): void {
  event.preventDefault();
  event.stopPropagation();
  const bridge = window.lite?.spaces;
  const entries = buildSpaceContextEntries(space, {
    share: () => {
      void (async () => {
        if (bridge === undefined) return;
        // The old copy claimed this made the Space "visible to the
        // account". Since ADR-065 that is FALSE: visibility is governed
        // solely by creator + [:HAS_ACCESS] membership, and this flag
        // is carried for join/discovery semantics not yet designed.
        // Saying so beats a confident lie on a security-shaped control
        // (2026-08-18 user question: "what does open to account do?").
        const ok = await askToConfirm(
          'Mark as open?',
          'Who can see this Space is decided by MEMBERSHIP — the people you add, ' +
            'plus you as its creator. Marking it open records the intent, but on ' +
            'its own it does NOT let anyone else see it.\n\n' +
            'To actually share it, use "Add people…".',
          'Mark as open'
        );
        if (!ok) return;
        const envelope = await bridge.updateSpace(space.id, { visibility: 'open' });
        showToast(
          envelope.ok
            ? `"${space.name}" marked open — add people to share it`
            : envelope.error.message
        );
        if (envelope.ok) await loadSpaces();
      })();
    },
    unshare: () => {
      void (async () => {
        if (bridge === undefined) return;
        const envelope = await bridge.updateSpace(space.id, { visibility: 'restricted' });
        showToast(
          envelope.ok
            ? `"${space.name}" is now members-only (you keep access)`
            : envelope.error.message
        );
        if (envelope.ok) await loadSpaces();
      })();
    },
    addPeople: () => {
      void openAddMemberPrompt(space.id, async () => {
        await loadSpaces();
      });
    },
    upload: () => {
      setActiveScope(space.id);
      openNewAssetDialog();
      switchNewAssetMode('upload');
    },
    rename: () => startInlineRename(space.id),
    editObjective: () => {
      // Already on this space's header → open the editor in place.
      const mounted = document.querySelector<HTMLElement>(
        `.spaces-view-header-sub[data-space-id="${CSS.escape(space.id)}"]`
      );
      if (mounted !== null) {
        mounted.click();
        return;
      }
      // Otherwise navigate there; the latch opens the editor on mount.
      requestObjectiveEdit(space.id);
      setActiveScope(space.id);
    },
    convertShared: () => void toggleSpaceKind(space.id),
    convertUser: () => void toggleSpaceKind(space.id),
    setPlaybook: () => {
      void openSetPlaybookPicker(space.id, space.name);
    },
    newJourney: () => {
      void openJourneyComposer(space.id);
    },
    deleteSpace: () => {
      void performSoftDelete(space.id);
    },
    togglePin: () => {
      void (async () => {
        if (bridge === undefined) return;
        const next = space.pinned !== true;
        const envelope = await bridge.pinSpace(space.id, next);
        showToast(
          envelope.ok
            ? next
              ? `Pinned "${space.name}"`
              : `Unpinned "${space.name}"`
            : envelope.error.message
        );
        if (envelope.ok) await loadSpaces();
      })();
    },
  });
  openContextMenu(event.clientX, event.clientY, entries);
}

function openItemContextMenu(
  event: MouseEvent,
  item: { id: string; title: string },
  inSpaceId: string
): void {
  event.preventDefault();
  event.stopPropagation();
  const bridge = window.lite?.spaces;
  const entries = buildItemContextEntries(item, inSpaceId, state.spaces, {
    addTo: (toSpaceId) => {
      void (async () => {
        if (bridge === undefined) return;
        const envelope = await bridge.items.addToSpace(item.id, toSpaceId);
        showToast(envelope.ok ? `Added "${item.title}"` : envelope.error.message);
        if (envelope.ok) {
          refreshSpaceTree(toSpaceId);
          if (state.activeScopeId === toSpaceId) void loadItems();
        }
      })();
    },
    moveTo: (toSpaceId) => {
      void (async () => {
        if (bridge === undefined) return;
        const envelope = await bridge.items.moveToSpace(item.id, inSpaceId, toSpaceId);
        showToast(envelope.ok ? `Moved "${item.title}"` : envelope.error.message);
        if (envelope.ok) {
          refreshSpaceTree(inSpaceId);
          refreshSpaceTree(toSpaceId);
          if (state.activeScopeId === inSpaceId || state.activeScopeId === toSpaceId) {
            void loadItems();
          }
        }
      })();
    },
    removeFrom: () => {
      void (async () => {
        if (bridge === undefined) return;
        const envelope = await bridge.items.removeFromSpace(item.id, inSpaceId);
        showToast(envelope.ok ? `Removed "${item.title}"` : envelope.error.message);
        if (envelope.ok) {
          refreshSpaceTree(inSpaceId);
          if (state.activeScopeId === inSpaceId) void loadItems();
        }
      })();
    },
    hide: () => {
      setItemHiddenInSpace(inSpaceId, item.id, true);
      showToast('Hidden in this space (sidebar + grid) — click the "hidden" chip to undo');
      refreshSpaceTree(inSpaceId);
      if (state.activeScopeId === inSpaceId) renderItemList({});
    },
  });
  openContextMenu(event.clientX, event.clientY, entries);
}

/**
 * Re-fetch one Space's rendered trees in place. A Space can hold more
 * than one tree at once — the SPACES section and the RECENT section
 * each render their own holder — so this refreshes every match, not
 * querySelector's first (which is RECENT's invisible copy when that
 * section is collapsed; refreshing only it left the visible tree
 * stale — 2026-08-08 drive).
 */
function refreshSpaceTree(spaceId: string): void {
  const holders = document.querySelectorAll<HTMLElement>(
    `.spaces-tree-children-holder[data-parent-space="${spaceId}"]`
  );
  for (const holder of Array.from(holders)) {
    const ul = holder.querySelector('ul');
    if (ul instanceof HTMLUListElement) void loadSpaceChildren(spaceId, ul);
  }
}

export function toggleSpaceTree(spaceId: string, row: HTMLElement): void {
  // ADR-071 — exclusive: re-toggling the open space closes it; opening
  // a different one closes the previous first. All in place, no repaint.
  if (expandedSpaceId === spaceId) {
    collapseExpandedTree();
    return;
  }
  collapseExpandedTree();
  expandedSpaceId = spaceId;
  row.classList.add('is-expanded');
  row.insertAdjacentElement('afterend', buildSpaceChildren(spaceId));
}

/**
 * Monotonic sequence for loadItems. Concurrent reloads happen by design
 * (create-flow refresh, enrich-completion refresh, cache-updated
 * broadcast) — only the LATEST call may paint, and earlier in-flight
 * responses are dropped. Driven-release-pass hardening (2026-08-05):
 * an interleaved reload briefly painted "No items" right after an
 * upload until a manual Refresh.
 */
let loadItemsSeq = 0;

/**
 * Fingerprint of the item list AS RENDERED. `renderItemList` tears the
 * whole grid down with `replaceChildren()`, so a background refresh
 * that returns identical data still destroys and rebuilds every tile —
 * PDF <embed>s re-instantiate, frame grabs and thumbnails re-decode,
 * and the user sees the grid flash. Polling runs every 15s and the
 * main-process cache broadcasts every 60s, so this was a visible blink
 * on a timer ("why is spaces keep refreshing or flashing?",
 * 2026-08-07). Comparing this signature lets an unchanged refresh be a
 * no-op.
 */
function itemListSignature(items: ReadonlyArray<RendererItemSummary>): string {
  return items
    .map((i) => `${i.id}:${i.updatedAt}:${i.kind}:${i.title}`)
    .join('|');
}

/** Signature of the grid currently on screen (null = nothing painted). */
let renderedItemsSignature: string | null = null;
/** Scope the painted grid belongs to — a scope switch must always repaint. */
let renderedItemsScopeId: string | null = null;

async function loadItems(): Promise<void> {
  const seq = ++loadItemsSeq;
  state.loadingItems = true;
  // Only paint the loading state when there is nothing to look at yet.
  // Tearing down a populated grid to show "loading" is what made a
  // silent background refresh flash.
  if (state.items.length === 0) {
    renderItemList({ loading: true });
  }
  const bridge = window.lite?.spaces;
  if (bridge === undefined) {
    state.loadingItems = false;
    renderItemList({ error: 'Bridge unavailable. Reload the window.' });
    return;
  }
  // Kick off the scoped events fetch in parallel for real Spaces.
  // Uncategorized has no `spaceId`, so the SDK has no edge to filter
  // on — we skip the events query there (Uncategorized timeline is
  // items-only).
  if (
    state.activeScopeId !== UNCATEGORIZED_SPACE_ID &&
    state.activeScopeId !== HOME_SCOPE_ID
  ) {
    void loadSpaceEvents(state.activeScopeId);
  } else {
    // Clear the events cache so an Uncategorized view doesn't see
    // leftover Space-scoped rows.
    state.spaceEvents = emptyCacheEntry<RendererEvent[]>();
    state.spaceEventsForScopeId = null;
  }
  try {
    const envelope = await bridge.items.list(state.activeScopeId);
    if (seq !== loadItemsSeq) return; // superseded by a newer reload
    if (envelope.ok === false) {
      state.loadingItems = false;
      // Keep the current list on a transient failure — a visible error
      // banner over an intact list beats blanking the pane.
      if (state.items.length > 0) {
        showToast(envelope.error.message);
        renderItemList({});
      } else {
        renderItemList({ error: envelope.error.message });
      }
      return;
    }
    const next = envelope.value.filter(isWellFormedItem);
    const nextSignature = itemListSignature(next);
    const unchanged =
      renderedItemsSignature === nextSignature &&
      renderedItemsScopeId === state.activeScopeId &&
      state.itemsSearchResults === null;
    state.items = next;
    state.loadingItems = false;
    // A refresh that changed nothing must not repaint: rebuilding the
    // grid re-instantiates every PDF embed / frame grab / thumbnail.
    if (unchanged) return;
    renderItemList({});
  } catch (err) {
    if (seq !== loadItemsSeq) return; // superseded by a newer reload
    window.logging?.error?.('spaces', 'loadItems failed', { scope: state.activeScopeId, error: messageFrom(err) });
    state.loadingItems = false;
    if (state.items.length > 0) {
      showToast(messageFrom(err));
      renderItemList({});
    } else {
      renderItemList({ error: messageFrom(err) });
    }
  }
}

/**
 * Fetch commit events scoped to a single Space. Mirrors the Home
 * timeline's `refreshEvents` shape so the merged-timeline pipeline
 * (mergeTimeline + filterTimeline + buildTimelineRow) reuses without
 * branching.
 *
 * Caches against `state.spaceEventsForScopeId` so a re-click on the
 * same Space within the 60s TTL serves from memory.
 */
async function loadSpaceEvents(spaceId: string): Promise<void> {
  const bridge = window.lite?.spaces?.home;
  if (bridge === undefined) return;
  const now = Date.now();
  const fresh =
    state.spaceEventsForScopeId === spaceId &&
    state.spaceEvents.value !== null &&
    now - state.spaceEvents.fetchedAt < HOME_CACHE_TTL_MS;
  if (fresh) {
    // Cache hit — the events already on screen ARE these events, so a
    // repaint would only tear the grid down and rebuild it (each
    // rebuild re-instantiates PDF embeds, frame grabs and thumbnails).
    if (renderedItemsSignature === null) renderItemList({});
    return;
  }
  // New scope → invalidate the previous Space's cache entry.
  if (state.spaceEventsForScopeId !== spaceId) {
    state.spaceEvents = emptyCacheEntry<RendererEvent[]>();
    state.spaceEventsForScopeId = spaceId;
  }
  state.spaceEvents.loading = true;
  state.spaceEvents.error = null;
  try {
    const envelope = await bridge.recentEvents({ limit: 50, spaceId });
    if (envelope.ok === false) {
      state.spaceEvents.error = envelope.error.message;
    } else {
      state.spaceEvents.value = envelope.value;
      state.spaceEvents.fetchedAt = Date.now();
    }
  } catch (err) {
    window.logging?.warn?.('spaces', 'loadSpaceEvents failed', { error: messageFrom(err) });
    state.spaceEvents.error = messageFrom(err);
  } finally {
    state.spaceEvents.loading = false;
    // Bail if the user switched scope mid-flight, and only repaint
    // when the events actually changed — polling refetches these every
    // 15s and an identical result used to rebuild the entire grid.
    const nextEventsSignature = eventsSignature(state.spaceEvents.value);
    if (
      state.spaceEventsForScopeId === spaceId &&
      (nextEventsSignature !== renderedEventsSignature ||
        renderedItemsSignature === null)
    ) {
      renderedEventsSignature = nextEventsSignature;
      renderItemList({});
    } else {
      renderedEventsSignature = nextEventsSignature;
    }
  }
}

/** Fingerprint of the scoped events list, for the same reason. */
function eventsSignature(events: ReadonlyArray<RendererEvent> | null): string {
  if (events === null) return '';
  return events.map((e) => `${e.id}:${e.timestamp}`).join('|');
}

/** Events signature currently reflected on screen. */
let renderedEventsSignature = '';

// ─── Asset view audit (2026-08-10) ─────────────────────────────────────
// Record "who viewed what, when" to the graph on asset open, deduped so
// a burst of re-renders is one view. window.lite.spaces.items.recordView
// writes a (:Person)-[:VIEWED]->(:Asset) edge server-side.
const RECORD_VIEW_DEDUPE_MS = 60_000;
const recentlyRecordedViews = new Map<string, number>();
function recordAssetViewOnce(itemId: string): void {
  if (typeof itemId !== 'string' || itemId.length === 0) return;
  const now = Date.now();
  const last = recentlyRecordedViews.get(itemId) ?? 0;
  if (now - last < RECORD_VIEW_DEDUPE_MS) return;
  recentlyRecordedViews.set(itemId, now);
  const record = window.lite?.spaces?.items?.recordView;
  if (typeof record !== 'function') return;
  void record(itemId).catch((err: unknown) => {
    window.logging?.warn?.('spaces', 'recordView failed', {
      itemId,
      error: messageFrom(err),
    });
  });
}

async function loadItemDetail(itemId: string): Promise<void> {
  state.loadingDetail = true;
  state.activeItemId = itemId;
  renderDetail({ loading: true });
  showDetailRail(true);
  const bridge = window.lite?.spaces;
  if (bridge === undefined) {
    state.loadingDetail = false;
    renderDetail({ error: 'Bridge unavailable. Reload the window.' });
    return;
  }
  try {
    const envelope = await bridge.items.get(itemId);
    if (envelope.ok === false) {
      state.loadingDetail = false;
      renderDetail({ error: envelope.error.message });
      return;
    }
    const item = envelope.value;
    state.loadingDetail = false;
    if (item === null) {
      renderDetail({ error: 'Item not found or no longer visible.' });
      return;
    }
    // Render the pane immediately with whatever metadata we have so the
    // user sees structure right away. If the item carries a binary
    // fileKey, resolve the signed URL in the background and patch the
    // pane with the preview / link when it lands.
    renderDetail({ item });
    if (typeof item.fileKey === 'string' && item.fileKey.length > 0) {
      void resolveAndInjectFileUrl(itemId, item);
    }
    // Audit trail (2026-08-10): record who looked at this asset, when,
    // in the graph. Deduped per asset within a short window so
    // re-renders don't inflate the count; fire-and-forget, never blocks.
    recordAssetViewOnce(itemId);
    // Phase 3c: per-asset activity log. Loads in the background and
    // populates the activity slot. Failures degrade silently — the
    // user still sees the asset; we don't surface a banner for a
    // missing-or-failing activity stream.
    void loadItemActivity(itemId);
    // Audit trail: who has viewed this asset (2026-08-10).
    void loadItemViewers(itemId);
    // ADR-057: version history, same lazy/soft-fail posture.
    void loadItemHistory(itemId);
  } catch (err) {
    window.logging?.error?.('spaces', 'loadItemDetail failed', { itemId, error: messageFrom(err) });
    state.loadingDetail = false;
    renderDetail({ error: messageFrom(err) });
  }
}

/**
 * Fetch the per-asset activity log via the bridge and inject it into
 * the `[data-activity-slot]` placeholder on the active detail pane.
 * Soft-fails: any error (bridge missing, envelope.ok=false, network)
 * leaves the slot empty rather than surfacing a banner.
 *
 * Bails when the user switched items mid-flight (the slot's
 * `data-activity-slot` attribute disambiguates which item the cached
 * payload belongs to).
 */
async function loadItemActivity(itemId: string): Promise<void> {
  const bridge = window.lite?.spaces;
  if (bridge === undefined) return;
  try {
    const envelope = await bridge.items.recentCommits(itemId, { limit: 20 });
    if (envelope.ok === false) return;
    if (state.activeItemId !== itemId) return;
    const slot = document.querySelector<HTMLElement>(
      `[data-activity-slot="${cssEscape(itemId)}"]`
    );
    if (slot === null) return;
    slot.replaceChildren(buildDetailActivity(envelope.value));
  } catch (err) {
    window.logging?.warn?.('spaces', 'loadItemActivity failed', { error: messageFrom(err) });
    // Soft failure: activity slot stays empty.
  }
}

/**
 * Load an asset's viewers (audit trail) into its detail-pane slot.
 * Same lazy / soft-fail posture as the activity log — a missing or
 * failing viewers stream just leaves the slot empty.
 */
async function loadItemViewers(itemId: string): Promise<void> {
  const bridge = window.lite?.spaces;
  const fn = bridge?.items?.viewers;
  if (bridge === undefined || typeof fn !== 'function') return;
  try {
    const envelope = await fn(itemId);
    if (envelope.ok === false) return;
    if (state.activeItemId !== itemId) return;
    const slot = document.querySelector<HTMLElement>(
      `[data-viewers-slot="${cssEscape(itemId)}"]`
    );
    if (slot === null) return;
    const rows = Array.isArray(envelope.value) ? (envelope.value as RendererAssetViewer[]) : [];
    slot.replaceChildren(buildDetailViewers(rows));
  } catch (err) {
    window.logging?.warn?.('spaces', 'loadItemViewers failed', { error: messageFrom(err) });
  }
}

interface RendererAssetViewer {
  viewerId: string;
  name: string;
  email: string;
  firstAt: number | null;
  lastAt: number | null;
  count: number;
}

/** Render the "Viewed by" list. Empty input renders nothing. */
export function buildDetailViewers(rows: ReadonlyArray<RendererAssetViewer>): HTMLElement {
  const section = document.createElement('section');
  section.className = 'spaces-detail-viewers';
  if (rows.length === 0) return section; // nothing viewed yet → render empty

  const heading = document.createElement('div');
  heading.className = 'spaces-detail-viewers-heading';
  heading.textContent = `Viewed by ${rows.length}`;
  section.appendChild(heading);

  const list = document.createElement('ul');
  list.className = 'spaces-detail-viewers-list';
  for (const v of rows.slice(0, 50)) {
    const li = document.createElement('li');
    li.className = 'spaces-detail-viewers-row';
    const name = document.createElement('span');
    name.className = 'spaces-detail-viewers-name';
    name.textContent = v.name.length > 0 ? v.name : v.viewerId;
    const when = document.createElement('span');
    when.className = 'spaces-detail-viewers-when';
    const last = typeof v.lastAt === 'number' ? new Date(v.lastAt) : null;
    const whenText =
      last !== null && !Number.isNaN(last.getTime()) ? last.toLocaleString() : '';
    when.textContent =
      v.count > 1 ? `${whenText} · ${v.count}×` : whenText;
    li.append(name, when);
    list.appendChild(li);
  }
  section.appendChild(list);
  return section;
}


// ─── Version history (ADR-057) ─────────────────────────────────────────

interface RendererAssetVersion {
  seq: number;
  title: string;
  editedBy?: string;
  editedAt: string;
  changeSummary?: string;
  restoredFromSeq?: number;
  currentMatchesSeq?: number;
  hasContent: boolean;
  description?: string;
  content?: string;
  fileKey?: string;
  mimeType?: string;
}

/**
 * Narrow view of the item-versioning bridge methods. The full typed
 * surface lands with the concurrent session's versioning wiring; until
 * then this lets HEAD compile and run without shipping half-wired code.
 */
type ItemVersioningBridge = {
  versions?: (id: string, limit: number) => Promise<{ ok: boolean; value?: unknown; error?: { message: string } }>;
  getVersion?: (id: string, seq: number) => Promise<{ ok: boolean; value?: unknown; error?: { message: string } }>;
  restoreVersion?: (id: string, seq: number, editorId?: string) => Promise<{ ok: boolean; value?: unknown; error?: { message: string } }>;
};

/**
 * Narrow view of the Spaces↔WISER bridge (`spaces.openWiser`). Same
 * defensive shape as ItemVersioningBridge: the renderer keeps working
 * against older preloads that don't expose the method yet.
 */
type WiserOpenBridge = {
  openWiser?: (riffId: string | null) => Promise<{ ok: true }>;
};

function wiserOpenBridge(): ((riffId: string | null) => Promise<{ ok: true }>) | null {
  const spaces = window.lite?.spaces as unknown as WiserOpenBridge | undefined;
  if (spaces === undefined || typeof spaces.openWiser !== 'function') return null;
  return spaces.openWiser.bind(spaces);
}

/**
 * Narrow view of the Spaces↔Journey Map Builder bridge
 * (`spaces.openJourneyMap`). Same defensive shape as the WISER one.
 */
type JourneyOpenBridge = {
  openJourneyMap?: (itemId: string | null) => Promise<{ ok: true }>;
};

function journeyOpenBridge(): ((itemId: string | null) => Promise<{ ok: true }>) | null {
  const spaces = window.lite?.spaces as unknown as JourneyOpenBridge | undefined;
  if (spaces === undefined || typeof spaces.openJourneyMap !== 'function') return null;
  return spaces.openJourneyMap.bind(spaces);
}

/**
 * Open a playbook asset in WISER Playbooks — deep-linked to the actual
 * playbook when the asset carries a riff id in metadata (riffId /
 * wiserRiffId, the keys a WISER export writes); the app opens plainly
 * otherwise. Fire-and-forget: failures log, never block the grid.
 */
async function openPlaybookInWiser(itemId: string): Promise<void> {
  const openWiser = wiserOpenBridge();
  if (openWiser === null) return;
  let riffId: string | null = null;
  try {
    const envelope = await window.lite?.spaces?.items.get(itemId);
    if (envelope !== undefined && envelope.ok === true && envelope.value !== null) {
      const meta = (envelope.value.metadata ?? {}) as Record<string, unknown>;
      riffId =
        typeof meta.riffId === 'string' && meta.riffId.length > 0
          ? meta.riffId
          : typeof meta.wiserRiffId === 'string' && meta.wiserRiffId.length > 0
            ? meta.wiserRiffId
            : null;
    }
  } catch {
    /* metadata lookup is best-effort — open the app plainly */
  }
  try {
    await openWiser(riffId);
  } catch (err) {
    window.logging?.warn?.('spaces', 'openPlaybookInWiser failed', {
      itemId,
      error: messageFrom(err),
    });
  }
}

function itemVersioningBridge(): ItemVersioningBridge | null {
  const items = window.lite?.spaces?.items as unknown as ItemVersioningBridge | undefined;
  if (items === undefined || typeof items.versions !== 'function') return null;
  return items;
}

async function loadItemHistory(itemId: string): Promise<void> {
  const vb = itemVersioningBridge();
  if (vb?.versions === undefined) return;
  try {
    const envelope = (await vb.versions(itemId, 50)) as
      | { ok: true; value: RendererAssetVersion[] }
      | { ok: false; error: { message: string } };
    if (envelope.ok === false) {
      window.logging?.warn?.('spaces', 'version history load failed', {
        itemId,
        error: envelope.error.message,
      });
      return;
    }
    if (state.activeItemId !== itemId) return;
    const slot = document.querySelector<HTMLElement>(
      `[data-history-slot="${cssEscape(itemId)}"]`
    );
    if (slot === null) return;
    const versions = envelope.value as RendererAssetVersion[];
    if (versions.length === 0) {
      slot.replaceChildren(); // no history yet — stay invisible
      return;
    }
    slot.replaceChildren(buildDetailHistory(itemId, versions));
  } catch (err) {
    window.logging?.warn?.('spaces', 'version history load threw', {
      itemId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** History section: current marker + one row per prior snapshot. */
/** Collapse preference — one global toggle, remembered per install. */
const HISTORY_COLLAPSED_KEY = 'lite.spaces.detail.history.collapsed';

function historyStartsCollapsed(): boolean {
  try {
    // Collapsed by default: the pane stays calm, and the summary line
    // carries the glanceable facts (count · last updated · last change).
    return window.localStorage.getItem(HISTORY_COLLAPSED_KEY) !== 'expanded';
  } catch {
    return true;
  }
}

function persistHistoryCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(HISTORY_COLLAPSED_KEY, collapsed ? 'collapsed' : 'expanded');
  } catch {
    // preference only
  }
}

export function buildDetailHistory(
  itemId: string,
  versions: ReadonlyArray<RendererAssetVersion>
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'spaces-detail-history';
  if (historyStartsCollapsed()) section.classList.add('is-collapsed');

  // Header: chevron + label + collapsed-mode summary (count · last
  // updated · latest change one-liner). The whole header toggles.
  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'spaces-history-header';
  header.setAttribute(
    'aria-expanded',
    section.classList.contains('is-collapsed') ? 'false' : 'true'
  );

  const chevron = document.createElement('span');
  chevron.className = 'spaces-history-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '▸';
  header.appendChild(chevron);

  const label = document.createElement('span');
  label.className = 'spaces-history-label';
  label.textContent = 'History';
  header.appendChild(label);

  const newest = versions[0];
  const meta = document.createElement('span');
  meta.className = 'spaces-history-meta';
  const parts: string[] = [`${versions.length} version${versions.length === 1 ? '' : 's'}`];
  if (newest !== undefined && newest.editedAt.length > 0) {
    parts.push(formatRelativeTime(newest.editedAt));
  }
  meta.textContent = parts.join(' · ');
  header.appendChild(meta);

  // The latest change description rides the collapsed header — the
  // "what just happened" at a glance. Hidden when expanded (the rows
  // carry it there).
  if (newest !== undefined) {
    const latest = document.createElement('span');
    latest.className = 'spaces-history-latest';
    latest.textContent =
      typeof newest.changeSummary === 'string' && newest.changeSummary.length > 0
        ? newest.changeSummary
        : typeof newest.restoredFromSeq === 'number'
          ? `Restored v${newest.restoredFromSeq}`
          : '';
    if (latest.textContent.length > 0) header.appendChild(latest);
  }

  header.addEventListener('click', () => {
    const collapsed = section.classList.toggle('is-collapsed');
    header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    persistHistoryCollapsed(collapsed);
  });
  section.appendChild(header);

  const body = document.createElement('div');
  body.className = 'spaces-history-body-wrap';

  const list = document.createElement('ul');
  list.className = 'spaces-history-list';

  // "Current" pseudo-row so the newest state reads as the live one.
  const currentLi = document.createElement('li');
  currentLi.className = 'spaces-history-row is-current';
  const curGlyph = document.createElement('span');
  curGlyph.className = 'spaces-history-glyph';
  curGlyph.textContent = '●';
  currentLi.appendChild(curGlyph);
  const curBody = document.createElement('div');
  curBody.className = 'spaces-history-body';
  const curTop = document.createElement('div');
  curTop.className = 'spaces-history-top';
  const curTag = document.createElement('span');
  curTag.className = 'spaces-history-seq';
  curTag.textContent = 'Current';
  curTop.appendChild(curTag);
  curBody.appendChild(curTop);
  currentLi.appendChild(curBody);
  list.appendChild(currentLi);

  for (const v of versions) {
    list.appendChild(buildHistoryRow(itemId, v));
  }
  body.appendChild(list);
  section.appendChild(body);
  return section;
}

/** Minimal monochrome glyph per row: ✎ edit, ↺ restore, ● current. */
function historyGlyphFor(v: RendererAssetVersion): string {
  return typeof v.restoredFromSeq === 'number' ? '↺' : '✎';
}

export function buildHistoryRow(itemId: string, v: RendererAssetVersion): HTMLElement {
  const li = document.createElement('li');
  li.className = 'spaces-history-row';

  const dot = document.createElement('span');
  dot.className = 'spaces-history-glyph';
  dot.textContent = historyGlyphFor(v);
  li.appendChild(dot);

  const body = document.createElement('div');
  body.className = 'spaces-history-body';

  const top = document.createElement('div');
  top.className = 'spaces-history-top';
  const seq = document.createElement('span');
  seq.className = 'spaces-history-seq';
  seq.textContent = `v${v.seq}`;
  top.appendChild(seq);
  if (typeof v.editedBy === 'string' && v.editedBy.length > 0) {
    const who = document.createElement('span');
    who.className = 'spaces-history-who';
    who.textContent = v.editedBy;
    top.appendChild(who);
  }
  if (v.editedAt.length > 0) {
    const when = document.createElement('span');
    when.className = 'spaces-history-when';
    when.textContent = formatRelativeTime(v.editedAt);
    when.title = v.editedAt;
    top.appendChild(when);
  }
  if (typeof v.restoredFromSeq === 'number') {
    const badge = document.createElement('span');
    badge.className = 'spaces-history-badge';
    badge.textContent = `↩ restored v${v.restoredFromSeq}`;
    top.appendChild(badge);
  }
  if (typeof v.currentMatchesSeq === 'number') {
    const badge = document.createElement('span');
    badge.className = 'spaces-history-badge spaces-history-badge-dupe';
    badge.textContent = `= v${v.currentMatchesSeq}`;
    badge.title = `The state after this edit matched version ${v.currentMatchesSeq} exactly.`;
    top.appendChild(badge);
  }
  body.appendChild(top);

  // AI change summary (async — may be absent on a just-made version).
  const summary = document.createElement('div');
  summary.className = 'spaces-history-summary';
  if (typeof v.changeSummary === 'string' && v.changeSummary.length > 0) {
    summary.textContent = v.changeSummary;
  } else {
    summary.classList.add('is-pending');
    summary.textContent =
      typeof v.title === 'string' && v.title.length > 0 ? `"${v.title}"` : 'Edited';
  }
  body.appendChild(summary);

  const actions = document.createElement('div');
  actions.className = 'spaces-history-actions';
  const viewBtn = document.createElement('button');
  viewBtn.type = 'button';
  viewBtn.className = 'spaces-history-action';
  viewBtn.textContent = 'View';
  viewBtn.addEventListener('click', () => void openVersionViewer(itemId, v.seq));
  actions.appendChild(viewBtn);
  const restoreBtn = document.createElement('button');
  restoreBtn.type = 'button';
  restoreBtn.className = 'spaces-history-action spaces-history-action-restore';
  restoreBtn.textContent = 'Restore';
  restoreBtn.addEventListener('click', () => void restoreVersion(itemId, v.seq));
  actions.appendChild(restoreBtn);
  body.appendChild(actions);

  li.appendChild(body);
  return li;
}

async function openVersionViewer(itemId: string, seq: number): Promise<void> {
  const vb = itemVersioningBridge();
  if (vb?.getVersion === undefined) {
    showToast('Version history needs a newer build of Lite.');
    return;
  }
  let version: RendererAssetVersion | null = null;
  try {
    const envelope = (await vb.getVersion(itemId, seq)) as
      | { ok: true; value: RendererAssetVersion | null }
      | { ok: false; error: { message: string } };
    if (envelope.ok === false) {
      showToast(`Couldn't load version: ${envelope.error.message}`);
      return;
    }
    version = envelope.value as RendererAssetVersion | null;
  } catch (err) {
    showToast(`Couldn't load version: ${messageFrom(err)}`);
    return;
  }
  if (version === null) {
    showToast('That version is no longer available.');
    return;
  }
  const backdrop = document.createElement('div');
  backdrop.className = 'spaces-version-viewer-backdrop';
  const panel = document.createElement('div');
  panel.className = 'spaces-version-viewer';

  const head = document.createElement('div');
  head.className = 'spaces-version-viewer-head';
  const title = document.createElement('div');
  title.className = 'spaces-version-viewer-title';
  title.textContent = `v${version.seq} · ${version.title || '(untitled)'}`;
  head.appendChild(title);
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'spaces-version-viewer-close';
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', 'Close version viewer');
  head.appendChild(closeBtn);
  panel.appendChild(head);

  if (typeof version.changeSummary === 'string' && version.changeSummary.length > 0) {
    const sum = document.createElement('div');
    sum.className = 'spaces-version-viewer-summary';
    sum.textContent = version.changeSummary;
    panel.appendChild(sum);
  }

  const bodyEl = document.createElement('div');
  bodyEl.className = 'spaces-version-viewer-body';
  const content = version.content ?? version.description ?? '';
  if (content.length > 0) {
    const pre = document.createElement('pre');
    pre.className = 'spaces-version-viewer-content';
    pre.textContent = content;
    bodyEl.appendChild(pre);
  } else {
    const empty = document.createElement('div');
    empty.className = 'spaces-version-viewer-empty';
    empty.textContent = version.hasContent
      ? 'This version has content that is not inline-viewable.'
      : 'This version has no text content.';
    bodyEl.appendChild(empty);
  }
  panel.appendChild(bodyEl);

  const foot = document.createElement('div');
  foot.className = 'spaces-version-viewer-foot';
  const restoreThis = document.createElement('button');
  restoreThis.type = 'button';
  restoreThis.className = 'spaces-version-viewer-restore';
  restoreThis.textContent = `Restore v${version.seq}`;
  const seqToRestore = version.seq;
  restoreThis.addEventListener('click', () => {
    backdrop.remove();
    void restoreVersion(itemId, seqToRestore);
  });
  foot.appendChild(restoreThis);
  panel.appendChild(foot);

  // Escape must survive earlier keydowns ({once:true} was consumed by
  // the FIRST key of any kind — Tab while reading killed Escape), and
  // the listener must die with the viewer however it closes.
  const onKeydown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') dismiss();
  };
  const dismiss = (): void => {
    document.removeEventListener('keydown', onKeydown);
    backdrop.remove();
  };
  closeBtn.addEventListener('click', dismiss);
  backdrop.addEventListener('click', (ev) => {
    if (ev.target === backdrop) dismiss();
  });
  document.addEventListener('keydown', onKeydown);

  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);
}

async function restoreVersion(itemId: string, seq: number): Promise<void> {
  const vb = itemVersioningBridge();
  if (vb?.restoreVersion === undefined) {
    showToast('Version history needs a newer build of Lite.');
    return;
  }
  const ok = await askToConfirm(
    `Restore version ${seq}?`,
    'This makes that version the current one. Your present state is saved as a new version first, so nothing is lost — you can restore back to it.',
    `Restore v${seq}`
  );
  if (!ok) return;
  try {
    const editorId = readCurrentEditorId();
    const envelope = (await vb.restoreVersion(
      itemId,
      seq,
      editorId ?? undefined
    )) as { ok: true; value?: unknown } | { ok: false; error: { message: string } };
    if (envelope.ok === false) {
      showToast(`Restore failed: ${envelope.error.message}`);
      return;
    }
    showToast(`Restored to v${seq}`);
    await loadItemDetail(itemId);
  } catch (err) {
    showToast(`Restore failed: ${messageFrom(err)}`);
  }
}

async function resolveAndInjectFileUrl(
  itemId: string,
  item: RendererItem
): Promise<void> {
  if (typeof item.fileKey !== 'string' || item.fileKey.length === 0) return;

  // Fast path: when the producer wrote an already-dereferenceable
  // HTTP(S) URL into `:Asset.url`, render it directly. The Files
  // module's signer is for storage keys (`s3://`, `gs://`, plain
  // bucket paths) -- it has nothing to add for full URLs. Skipping
  // the bridge call means image / video / audio / PDF previews land
  // synchronously without a round-trip.
  if (/^https?:\/\//i.test(item.fileKey)) {
    injectBinaryPreview(item, item.fileKey);
    return;
  }

  const bridge = window.lite?.spaces;
  if (bridge === undefined) {
    swapPreviewToUnavailable(item, 'Bridge unavailable. Reload the window.');
    return;
  }
  const isPdf = (item.mimeType ?? '').toLowerCase() === 'application/pdf';
  if (isPdf) {
    // PDFs want BOTH: the bytes (inline render) and the signed URL
    // (browser-facing actions). Fetch in parallel; either may fail
    // independently and the viewer degrades explicitly.
    try {
      const [dataEnv, urlEnv] = await Promise.all([
        bridge.items.readFileData(item.fileKey),
        bridge.items.resolveFileUrl(item.fileKey),
      ]);
      if (state.activeItemId !== itemId) return;
      const dataUrl = dataEnv.ok === true && dataEnv.value !== null ? dataEnv.value.dataUrl : null;
      const remoteUrl = urlEnv.ok === true && typeof urlEnv.value === 'string' ? urlEnv.value : null;
      injectPdfViewer(item, dataUrl, remoteUrl);
    } catch (err) {
      window.logging?.warn?.('spaces', 'detail PDF preview failed', { itemId: item.id, error: messageFrom(err) });
      swapPreviewToUnavailable(item, (err as Error).message);
    }
    return;
  }

  // Text-like GSX files (markdown / code / CSV / plain text) with no
  // inline content: read the bytes through the authenticated bridge,
  // decode, and feed the SAME renderer the inline path uses — so an
  // uploaded .md renders as Markdown with the "✎ Edit" affordance
  // instead of degrading to a bare download link. First save writes the
  // text into graph `content` (text belongs in the graph; the original
  // upload stays in GSX untouched).
  const textLang = detectTextPreviewLanguage(item.mimeType, item.title);
  const mimeIsText = (item.mimeType ?? '').toLowerCase().startsWith('text/');
  const hasInline = typeof item.content === 'string' && item.content.length > 0;
  if (!hasInline && (textLang !== null || mimeIsText)) {
    try {
      const env = await bridge.items.readFileData(item.fileKey);
      if (state.activeItemId !== itemId) return;
      const dataUrl = env.ok === true && env.value !== null ? env.value.dataUrl : null;
      const text = dataUrl !== null ? decodeDataUrlText(dataUrl) : null;
      if (text !== null) {
        injectTextPreview(item, text, textLang);
        return;
      }
      // Over the read cap or genuinely binary: fall through to the
      // generic signed-URL preview below.
    } catch {
      /* fall through to the generic preview */
    }
  }
  try {
    const envelope = await bridge.items.resolveFileUrl(item.fileKey);
    // Bail if the user switched items mid-flight.
    if (state.activeItemId !== itemId) return;
    if (envelope.ok === false) {
      swapPreviewToUnavailable(item, envelope.error.message);
      return;
    }
    const url = envelope.value;
    if (typeof url !== 'string' || url.length === 0) {
      // Resolver returned null -- the fileKey doesn't map to a
      // signed-download URL (e.g. the producer wrote a placeholder
      // `s3://...` path that the Files module can't sign). Tell the
      // user honestly rather than rendering an invisible empty space.
      swapPreviewToUnavailable(item, null);
      return;
    }
    injectBinaryPreview(item, url);
  } catch (err) {
    window.logging?.warn?.('spaces', 'detail file preview failed', { itemId: item.id, error: messageFrom(err) });
    // Soft failure: keep the rail readable, swap the placeholder to
    // the unavailable state so the user knows the attempt happened.
    swapPreviewToUnavailable(item, (err as Error).message);
  }
}

/**
 * Render an image preview (`kind=image`) or a binary download link
 * (any other kind with a fileKey) into the active detail pane. Called
 * after the URL resolves; replaces the upfront placeholder slot so
 * the preview lands in the same position regardless of when it
 * arrives.
 */
function injectPdfViewer(
  item: RendererItem,
  dataUrl: string | null,
  remoteUrl: string | null
): void {
  const pane = document.querySelector<HTMLElement>(
    '#spaces-detail .spaces-detail-pane'
  );
  if (pane === null) return;
  const next = document.createElement('div');
  next.className = 'spaces-detail-preview';
  next.setAttribute('data-kind', item.kind);
  next.appendChild(buildPdfViewer(item, dataUrl, remoteUrl));
  const existing = pane.querySelector('.spaces-detail-preview');
  if (existing !== null) existing.replaceWith(next);
  else pane.appendChild(next);
}

/**
 * Swap the file-preview placeholder for a rendered TEXT preview — the
 * same dispatch the inline-content path uses (Markdown with edit, CSV
 * table, syntax-highlighted code). Used for text files that live in
 * GSX (uploaded before inline routing, or over the inline size cap).
 */
function injectTextPreview(
  item: RendererItem,
  text: string,
  language: string | null
): void {
  const pane = document.querySelector<HTMLElement>(
    '#spaces-detail .spaces-detail-pane'
  );
  if (pane === null) return;
  let next: HTMLElement;
  if (language === 'csv' || language === 'tsv') {
    next = buildCsvPreview(text);
  } else if (language !== null && language !== 'markdown') {
    next = buildCodePreview(text, language);
  } else {
    next = buildDetailContent(text, 'rendered', {
      onSave: (nextText: string) => commitItemUpdate(item.id, { content: nextText }),
    });
  }
  const existing = pane.querySelector('.spaces-detail-preview');
  if (existing !== null) {
    existing.replaceWith(next);
  } else {
    pane.appendChild(next);
  }
}

function injectBinaryPreview(item: RendererItem, url: string): void {
  const pane = document.querySelector<HTMLElement>(
    '#spaces-detail .spaces-detail-pane'
  );
  if (pane === null) return;
  const next = buildBinaryPreview(item, url);
  // Replace the placeholder (or any prior preview) in place.
  const existing = pane.querySelector('.spaces-detail-preview');
  if (existing !== null) {
    existing.replaceWith(next);
  } else {
    pane.appendChild(next);
  }
}

/**
 * Swap the upfront preview placeholder to an "unavailable" state.
 * Renders a small block explaining that the file couldn't be resolved
 * and showing the raw `fileKey` so a data producer can see exactly
 * which property would need to be fixed.
 */
function swapPreviewToUnavailable(item: RendererItem, reason: string | null): void {
  const pane = document.querySelector<HTMLElement>(
    '#spaces-detail .spaces-detail-pane'
  );
  if (pane === null) return;
  const existing = pane.querySelector('.spaces-detail-preview');
  const next = buildPreviewUnavailable(item, reason);
  if (existing !== null) {
    existing.replaceWith(next);
  } else {
    pane.appendChild(next);
  }
}

/**
 * Build an inline preview for a binary asset. Dispatches on
 * `item.kind` and `item.mimeType` so audio/video get players, PDFs
 * embed, and unknown binaries fall back to a download link.
 *
 * Sprint 2: extended from image-only to a kind/MIME-aware dispatch.
 */
/**
 * Detect a base64 data URL (e.g. `data:application/pdf;base64,JVBER…`).
 * Used by `buildDetailPane` to route in-app uploads (which stash the
 * file as a data URL in `Item.content` until a real Files-API upload
 * lands) through the binary-preview path instead of the Markdown
 * renderer. Strict — only recognizes the `;base64,` form to avoid
 * collisions with arbitrary `data:` strings inside markdown.
 */
export function isBase64DataUrl(s: string): boolean {
  if (typeof s !== 'string' || s.length < 16) return false;
  if (!s.startsWith('data:')) return false;
  // The MIME and ;base64, marker must appear within the first ~120
  // chars; longer prefixes are almost certainly not actual data URLs.
  const head = s.slice(0, 120);
  return head.includes(';base64,');
}

export function buildBinaryPreview(
  item: RendererItem,
  url: string
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'spaces-detail-preview';
  wrap.setAttribute('data-kind', item.kind);
  const mime = typeof item.mimeType === 'string' ? item.mimeType.toLowerCase() : '';

  // ── Image ───────────────────────────────────────────────────────────
  if (item.kind === 'image' || mime.startsWith('image/')) {
    const img = document.createElement('img');
    img.alt = item.title.length > 0 ? item.title : 'Item preview';
    img.loading = 'lazy';
    img.className = 'spaces-detail-image';
    img.addEventListener('error', () => {
      img.remove();
      const note = document.createElement('p');
      note.className = 'spaces-detail-preview-note';
      note.textContent = 'This image could not be loaded from storage.';
      wrap.prepend(note);
    });
    img.src = url;
    wrap.appendChild(img);
    appendDownloadLink(wrap, url, 'Download');
    return wrap;
  }

  // ── Audio player ────────────────────────────────────────────────────
  if (item.kind === 'audio' || mime.startsWith('audio/')) {
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = url;
    audio.className = 'spaces-detail-audio';
    wrap.appendChild(audio);
    appendDownloadLink(wrap, url, 'Download audio');
    return wrap;
  }

  // ── Video player ────────────────────────────────────────────────────
  if (item.kind === 'video' || mime.startsWith('video/')) {
    const video = document.createElement('video');
    video.controls = true;
    video.preload = 'metadata';
    video.src = url;
    video.className = 'spaces-detail-video';
    wrap.appendChild(video);
    appendDownloadLink(wrap, url, 'Download video');
    return wrap;
  }

  // ── PDF ──────────────────────────────────────────────────────────────
  if (mime === 'application/pdf') {
    // Delegates to buildPdfViewer: inline <embed> when we hold the
    // BYTES (data: URL -- the async path fetches them via
    // items.readFileData because the CSP blocks a renderer fetch and
    // signed URLs embed as a blank white slab), plus the action row
    // (Open in browser / Download / Copy link). With only a remote
    // URL, the viewer renders the document card + actions instead.
    if (url.startsWith('data:')) {
      wrap.appendChild(buildPdfViewer(item, url, null));
      return wrap;
    }
    wrap.appendChild(buildPdfViewer(item, null, url));
    return wrap;
  }

  // ── Fallback: generic file download ────────────────────────────────
  const label = document.createElement('span');
  label.className = 'spaces-detail-label';
  label.textContent = mime.length > 0 ? mime : 'File';
  wrap.appendChild(label);
  appendDownloadLink(wrap, url, 'Download');
  return wrap;
}

function appendDownloadLink(parent: HTMLElement, url: string, text: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.className = 'spaces-detail-download';
  link.textContent = text;
  parent.appendChild(link);
}

/**
 * Clean dark "PDF document" card for remote PDFs that the embedded
 * viewer can't reliably display inline. A red PDF chip + filename +
 * size + an "Open PDF" button — intentional and never a blank white
 * slab. Opens the signed URL externally (where the OS PDF viewer
 * renders it correctly).
 */
/**
 * PDF preview with the full action row the detail pane owes the user:
 * render inline when we hold the bytes, and ALWAYS offer
 * Open in browser / Download / Copy link.
 *
 * `dataUrl` — base64 bytes fetched through items.readFileData (main
 * process; the renderer cannot fetch cross-origin under this CSP).
 * `remoteUrl` — the signed short-TTL URL, used by the browser-facing
 * actions. Either may be null:
 *   - dataUrl only  → inline viewer; Open-in-browser hidden.
 *   - remoteUrl only → document card + actions (bytes unavailable).
 *   - neither       → explicit "couldn't be read" message — the
 *     NoSuchKey case where storage lost the object but the graph node
 *     still points at it. Never a silent blank.
 *
 * Pure DOM; exported for the asset-matrix tests.
 */
export function buildPdfViewer(
  item: RendererItem,
  dataUrl: string | null,
  remoteUrl: string | null
): HTMLElement {
  const box = document.createElement('div');
  box.className = 'spaces-detail-pdf-viewer';

  if (dataUrl !== null) {
    const embed = document.createElement('embed');
    embed.src = dataUrl;
    embed.type = 'application/pdf';
    embed.className = 'spaces-detail-pdf';
    box.appendChild(embed);
  } else if (remoteUrl !== null) {
    box.appendChild(buildPdfCard(item, remoteUrl));
  } else {
    const note = document.createElement('p');
    note.className = 'spaces-detail-pdf-note';
    // Honest wording (2026-08-18): a failed READ is usually the app's
    // reach (network/discovery), not the file's existence — "may have
    // been removed" sent the user hunting a deletion that never
    // happened. Say what we know, offer the retry.
    note.textContent =
      'This file couldn’t be loaded right now — storage may be unreachable, or the file may have been removed. Reopening the asset retries.';
    box.appendChild(note);
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'spaces-detail-pdf-retry';
    retry.textContent = 'Try again';
    retry.addEventListener('click', () => {
      if (state.activeItemId !== null) void loadItemDetail(state.activeItemId);
    });
    box.appendChild(retry);
  }

  const actions = document.createElement('div');
  actions.className = 'spaces-detail-pdf-actions';

  if (remoteUrl !== null) {
    const open = document.createElement('a');
    open.className = 'spaces-detail-pdf-action';
    open.href = remoteUrl;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    open.textContent = 'Open in browser';
    actions.appendChild(open);
  }

  if (dataUrl !== null) {
    const dl = document.createElement('a');
    dl.className = 'spaces-detail-pdf-action';
    dl.href = dataUrl;
    dl.download = item.title.length > 0 ? `${item.title.replace(/\.pdf$/i, '')}.pdf` : 'document.pdf';
    dl.textContent = 'Download';
    actions.appendChild(dl);
  }

  if (remoteUrl !== null) {
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'spaces-detail-pdf-action';
    copy.textContent = 'Copy link';
    copy.addEventListener('click', () => {
      void navigator.clipboard
        .writeText(remoteUrl)
        .then(() => showToast('Link copied — note it expires after a short while'))
        .catch(() => showToast('Couldn’t copy the link'));
    });
    actions.appendChild(copy);
  }

  if (actions.children.length > 0) box.appendChild(actions);
  return box;
}

function buildPdfCard(
  item: { title: string; size?: number },
  url: string
): HTMLElement {
  const card = document.createElement('div');
  card.className = 'spaces-detail-pdf-card';

  const icon = document.createElement('div');
  icon.className = 'spaces-detail-pdf-card-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = 'PDF';
  card.appendChild(icon);

  const meta = document.createElement('div');
  meta.className = 'spaces-detail-pdf-card-meta';
  const name = document.createElement('div');
  name.className = 'spaces-detail-pdf-card-name';
  name.textContent = item.title.length > 0 ? item.title : 'PDF document';
  meta.appendChild(name);
  const sub = document.createElement('div');
  sub.className = 'spaces-detail-pdf-card-sub';
  sub.textContent =
    typeof item.size === 'number' && item.size > 0
      ? `PDF · ${formatBytes(item.size)}`
      : 'PDF document';
  meta.appendChild(sub);
  card.appendChild(meta);

  const open = document.createElement('a');
  open.className = 'spaces-detail-pdf-card-open';
  open.href = url;
  open.target = '_blank';
  open.rel = 'noopener noreferrer';
  open.textContent = 'Open PDF';
  card.appendChild(open);

  return card;
}

/**
 * Upfront placeholder rendered in the detail rail while the file URL
 * resolves. Replaced by `buildBinaryPreview` on success or
 * `buildPreviewUnavailable` on failure. Shares the `.spaces-detail-
 * preview` class so the swap targets the same slot.
 *
 * Pure; exported for tests.
 */
export function buildPreviewPlaceholder(item: {
  kind?: string;
  mimeType?: string;
}): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'spaces-detail-preview spaces-detail-preview-loading';
  wrap.setAttribute('data-state', 'loading');
  const label = document.createElement('div');
  label.className = 'spaces-detail-preview-loading-label';
  const kind = typeof item.kind === 'string' ? item.kind : '';
  const mime = typeof item.mimeType === 'string' ? item.mimeType : '';
  // Friendly kind-aware copy. Avoids the dread "Loading…" by naming
  // what's being fetched.
  let text = 'Loading preview…';
  if (kind === 'image' || mime.startsWith('image/')) text = 'Loading image…';
  else if (kind === 'video' || mime.startsWith('video/')) text = 'Loading video…';
  else if (kind === 'audio' || mime.startsWith('audio/')) text = 'Loading audio…';
  else if (mime === 'application/pdf') text = 'Loading PDF…';
  else if (kind === 'document') text = 'Loading document…';
  label.textContent = text;
  wrap.appendChild(label);
  return wrap;
}

/**
 * Replacement for the placeholder when the file URL doesn't resolve.
 * Names the kind, surfaces the raw `fileKey` so a data producer can
 * see exactly which path failed, and (when available) includes the
 * reason. Stays in the same slot as the placeholder.
 *
 * Pure; exported for tests.
 */
export function buildPreviewUnavailable(
  item: { kind?: string; fileKey?: string; mimeType?: string },
  reason: string | null
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'spaces-detail-preview spaces-detail-preview-unavailable';
  wrap.setAttribute('data-state', 'unavailable');

  const headline = document.createElement('p');
  headline.className = 'spaces-detail-preview-unavailable-headline';
  const kind = typeof item.kind === 'string' ? item.kind : '';
  const mime = typeof item.mimeType === 'string' ? item.mimeType : '';
  if (kind === 'image' || mime.startsWith('image/')) {
    headline.textContent = 'Image preview unavailable.';
  } else if (kind === 'video' || mime.startsWith('video/')) {
    headline.textContent = 'Video preview unavailable.';
  } else if (kind === 'audio' || mime.startsWith('audio/')) {
    headline.textContent = 'Audio preview unavailable.';
  } else if (mime === 'application/pdf') {
    headline.textContent = 'PDF preview unavailable.';
  } else {
    headline.textContent = 'File preview unavailable.';
  }
  wrap.appendChild(headline);

  const sub = document.createElement('p');
  sub.className = 'spaces-detail-preview-unavailable-sub';
  sub.textContent =
    reason !== null && reason.length > 0
      ? `The Files module couldn’t resolve a download URL: ${reason}`
      : 'The Files module returned no URL — the underlying file may not exist at the recorded path.';
  wrap.appendChild(sub);

  // Show the raw fileKey verbatim so a producer reading the screen
  // can see exactly which property points at a missing file.
  if (typeof item.fileKey === 'string' && item.fileKey.length > 0) {
    const key = document.createElement('code');
    key.className = 'spaces-detail-preview-unavailable-key';
    key.textContent = item.fileKey;
    wrap.appendChild(key);
  }

  return wrap;
}

/**
 * Render code with a deliberately-simple highlighter. v1 doesn't
 * pull in a full syntax-highlight library — instead it preserves
 * monospace formatting, highlights line numbers, and color-codes
 * strings / keywords for a handful of common languages.
 *
 * Sprint 2: used for text/document items whose mimeType signals a
 * code or JSON payload (and via the detail-content toggle for any
 * text item the user wants to read as code).
 */
export function buildCodePreview(source: string, language: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'spaces-detail-code-preview';
  wrap.setAttribute('data-language', language);

  const header = document.createElement('div');
  header.className = 'spaces-detail-code-header';
  const langLabel = document.createElement('span');
  langLabel.className = 'spaces-detail-code-lang';
  langLabel.textContent = language;
  header.appendChild(langLabel);
  wrap.appendChild(header);

  const pre = document.createElement('pre');
  pre.className = 'spaces-detail-code-block';
  const code = document.createElement('code');
  code.className = `language-${language}`;
  const lines = source.split('\n');
  lines.forEach((line, idx) => {
    const lineEl = document.createElement('span');
    lineEl.className = 'spaces-detail-code-line';
    const num = document.createElement('span');
    num.className = 'spaces-detail-code-line-number';
    num.textContent = String(idx + 1);
    num.setAttribute('aria-hidden', 'true');
    lineEl.appendChild(num);
    const content = document.createElement('span');
    content.className = 'spaces-detail-code-line-content';
    content.textContent = line;
    lineEl.appendChild(content);
    code.appendChild(lineEl);
  });
  pre.appendChild(code);
  wrap.appendChild(pre);
  return wrap;
}

/**
 * Build a table preview for CSV / TSV. Renders the first ~200 rows
 * as an HTML table; larger files get a "showing N of M rows" footer.
 * Auto-detects the delimiter from the first line.
 */
export function buildCsvPreview(source: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'spaces-detail-csv-preview';

  if (source.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'spaces-detail-csv-empty';
    empty.textContent = '(empty CSV)';
    wrap.appendChild(empty);
    return wrap;
  }

  const allLines = source.split(/\r?\n/).filter((l) => l.length > 0);
  if (allLines.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'spaces-detail-csv-empty';
    empty.textContent = '(empty CSV)';
    wrap.appendChild(empty);
    return wrap;
  }

  // Delimiter detection: tab beats comma when both are present.
  const firstLine = allLines[0] ?? '';
  const delimiter = firstLine.includes('\t') ? '\t' : ',';

  const MAX_ROWS = 200;
  const lines = allLines.slice(0, MAX_ROWS);
  const truncated = allLines.length > MAX_ROWS;

  const table = document.createElement('table');
  table.className = 'spaces-detail-csv-table';
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  const headers = parseCsvLine(lines[0] ?? '', delimiter);
  for (const h of headers) {
    const th = document.createElement('th');
    th.textContent = h;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (let i = 1; i < lines.length; i++) {
    const row = document.createElement('tr');
    const cells = parseCsvLine(lines[i] ?? '', delimiter);
    for (let j = 0; j < headers.length; j++) {
      const td = document.createElement('td');
      td.textContent = cells[j] ?? '';
      row.appendChild(td);
    }
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);

  if (truncated) {
    const footer = document.createElement('p');
    footer.className = 'spaces-detail-csv-footer';
    footer.textContent = `Showing ${MAX_ROWS} of ${allLines.length} rows. Download for full data.`;
    wrap.appendChild(footer);
  }
  return wrap;
}

/**
 * Parse a single CSV/TSV line with minimal quoted-field handling.
 * Quoted fields can contain the delimiter and escaped quotes (""),
 * but the parser deliberately stays simple — for "full" CSV (RFC 4180
 * compliance, multi-line fields) the user can download and use a
 * proper tool.
 */
function parseCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        out.push(current);
        current = '';
      } else if (ch !== undefined) {
        current += ch;
      }
    }
  }
  out.push(current);
  return out;
}

/**
 * Detect a "language" hint from a MIME type or filename. Used by the
 * text-content preview path to pick code highlighting vs Markdown vs
 * CSV table.
 *
 * Returns one of:
 *   - 'csv' / 'tsv'   → CSV/TSV table preview
 *   - 'json' / 'yaml' / 'xml' / 'js' / 'ts' / 'py' / 'sql' / 'sh'
 *     → code block with that language tag
 *   - 'markdown'      → Markdown renderer
 *   - null            → no special preview (renderer's normal text path)
 */
export function detectTextPreviewLanguage(
  mimeType: string | undefined,
  title: string | undefined
): string | null {
  const mime = (mimeType ?? '').toLowerCase();
  const name = (title ?? '').toLowerCase();
  if (mime === 'text/csv' || name.endsWith('.csv')) return 'csv';
  if (mime === 'text/tab-separated-values' || name.endsWith('.tsv')) return 'tsv';
  if (mime === 'application/json' || name.endsWith('.json')) return 'json';
  if (mime === 'application/yaml' || mime === 'application/x-yaml' ||
      name.endsWith('.yaml') || name.endsWith('.yml')) return 'yaml';
  if (mime === 'application/xml' || mime === 'text/xml' || name.endsWith('.xml')) return 'xml';
  if (name.endsWith('.js') || name.endsWith('.mjs') || name.endsWith('.cjs')) return 'js';
  if (name.endsWith('.ts') || name.endsWith('.tsx')) return 'ts';
  if (name.endsWith('.py')) return 'py';
  if (name.endsWith('.sql')) return 'sql';
  if (name.endsWith('.sh') || name.endsWith('.bash') || name.endsWith('.zsh')) return 'sh';
  if (mime === 'text/html' || name.endsWith('.html') || name.endsWith('.htm')) return 'html';
  if (name.endsWith('.mmd') || name.endsWith('.mermaid')) return 'mermaid';
  if (mime === 'text/markdown' || name.endsWith('.md') || name.endsWith('.markdown')) return 'markdown';
  return null;
}

// ─── Scope wiring ───────────────────────────────────────────────────────

function wireSidebarClicks(): void {
  const sidebar = document.getElementById('spaces-sidebar');
  if (sidebar === null) return;
  sidebar.addEventListener('click', (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const row = target.closest<HTMLElement>('.spaces-row');
    if (row === null) return;
    const scopeId = row.getAttribute('data-scope-id');
    if (typeof scopeId !== 'string' || scopeId.length === 0) return;
    setActiveScope(scopeId);
  });
}

function setActiveScope(scopeId: string): void {
  if (scopeId === state.activeScopeId) return;
  state.activeScopeId = scopeId;
  applyActiveRow(scopeId);
  // ADR-071 — selection IS the expansion: the activated space's tree
  // opens and whatever was open closes; non-space scopes close all.
  syncExclusiveExpansion(scopeId);
  applyScopeRegions(scopeId);
  // Switching scope clears the open detail rail.
  state.activeItemId = null;
  showDetailRail(false);
  // Clear the previous scope's items IMMEDIATELY: the keep-on-error
  // behavior in loadItems must only ever preserve the SAME scope's
  // list — without this, Space A's grid renders under Space B's
  // header during the fetch and sticks there if the fetch fails.
  state.items = [];
  renderedItemsSignature = null;
  renderedItemsScopeId = null;
  pendingTileFocusId = null;
  // Sprint 3: clear any active items search on scope switch.
  state.itemsSearchQuery = '';
  state.itemsSearchResults = null;
  if (state.itemsSearchTimer !== null) {
    window.clearTimeout(state.itemsSearchTimer);
    state.itemsSearchTimer = null;
  }
  if (scopeId === HOME_SCOPE_ID) {
    void loadHome();
  } else {
    void loadItems();
  }
  // Phase 4 v2: (re)start the polling timer for the new scope.
  schedulePolling(scopeId);
}

/**
 * Polling cadence for shared spaces. Every N seconds we re-fetch the
 * dashboard cache so the user sees ticket updates from other
 * collaborators (and agents) without a manual refresh.
 *
 * 15 seconds is a deliberate trade-off: fast enough that "I just
 * changed a ticket; the other tab sees it within a few seconds" feels
 * snappy, slow enough that we don't hammer the graph for users
 * staring at one space all day.
 */
const SHARED_SPACE_POLL_MS = 15_000;

function schedulePolling(scopeId: string): void {
  if (state.pollTimer !== null) {
    window.clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  const space = state.spaces.find((s) => s.id === scopeId);
  if (space === undefined || space.kind !== 'shared') return;
  state.pollTimer = window.setInterval(() => {
    if (state.activeScopeId !== scopeId) return;
    void loadSharedSpaceDashboard(scopeId);
  }, SHARED_SPACE_POLL_MS);
}

/**
 * Toggle visibility of the Home region vs. the items region based on
 * the active scope. Both regions live in the DOM at all times; the
 * `hidden` attribute toggle lets each keep its own state without
 * tearing down + rebuilding on every scope switch.
 */
function applyScopeRegions(scopeId: string): void {
  const homeRegion = document.getElementById('spaces-home-region');
  const itemsRegion = document.getElementById('spaces-items-region');
  const showHome = scopeId === HOME_SCOPE_ID;
  if (homeRegion !== null) homeRegion.hidden = !showHome;
  if (itemsRegion !== null) itemsRegion.hidden = showHome;
}

function applyActiveRow(scopeId: string): void {
  const rows = Array.from(document.querySelectorAll<HTMLElement>('.spaces-row'));
  for (const row of rows) {
    const id = row.getAttribute('data-scope-id');
    row.classList.toggle('is-active', id === scopeId);
  }
}

/**
 * ADR-071 — make the activated scope the ONE expanded space, in place.
 * Non-space scopes (Home, Uncategorized) collapse everything. A space
 * whose row is folded behind More… just records the intent; the next
 * paint that renders the row honors it.
 */
function syncExclusiveExpansion(scopeId: string): void {
  const isSpace = state.spaces.some((s) => s.id === scopeId);
  if (!isSpace) {
    collapseExpandedTree();
    return;
  }
  if (expandedSpaceId === scopeId) return;
  collapseExpandedTree();
  expandedSpaceId = scopeId;
  const safeId = scopeId.replace(/"/g, '\\"');
  const row = document.querySelector<HTMLElement>(
    `#spaces-list-spaces .spaces-row[data-scope-id="${safeId}"]`
  );
  if (row !== null) {
    row.classList.add('is-expanded');
    row.insertAdjacentElement('afterend', buildSpaceChildren(scopeId));
  }
}

// ─── Sidebar rendering ──────────────────────────────────────────────────

/**
 * Fingerprint of the sidebar AS RENDERED (2026-08-08 review, perf):
 * every re-render destroyed each expanded tree, painted "Loading…",
 * and refired one items.list per expanded Space — and the sidebar
 * re-renders at least every 60s from the cache broadcast. Unchanged
 * data now skips the rebuild entirely (expansion toggles mutate the
 * DOM in place, so they never need a repaint and stay OUT of the
 * signature).
 */
let renderedSpacesSignature: string | null = null;

// ADR-069 — drawer state for the Spaces section. Session-sticky: an
// explicit More… stays open for the window's lifetime (repaints must
// not silently re-fold the list the user just expanded).
const SPACES_ACTIVE_LIMIT = 8;
const SPACES_FOLD_SLACK = 2;
let spacesDrawerOpen = false;

function buildSpacesDrawerRow(hiddenCount: number, opensDrawer: boolean): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'spaces-drawer-row';
  li.setAttribute('role', 'button');
  li.setAttribute('tabindex', '0');
  li.textContent = opensDrawer
    ? `More… ${hiddenCount} space${hiddenCount === 1 ? '' : 's'}`
    : 'Show fewer';
  const toggle = (): void => {
    spacesDrawerOpen = opensDrawer;
    renderedSpacesSignature = null;
    renderSpaceList();
  };
  li.addEventListener('click', toggle);
  li.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      toggle();
    }
  });
  return li;
}

function spacesSidebarSignature(): string {
  const rows = sortSpaces(state.spaces, state.sortMode)
    .map(
      (s) =>
        `${s.id}:${s.updatedAt ?? ''}:${s.lastActivity ?? ''}:${s.name}:${s.itemCount ?? 0}:${s.visibility ?? ''}:${s.kind ?? ''}:${s.pinned === true ? 'P' : ''}`
    )
    .join('|');
  // Drawer state is part of the paint (ADR-069): toggling More… must
  // repaint even when the data itself didn't change.
  return `${state.sortMode}§${spacesDrawerOpen ? 'open' : 'closed'}§${rows}`;
}

function renderSpaceList(): void {
  const nextSignature = spacesSidebarSignature();
  if (nextSignature === renderedSpacesSignature) return;
  renderedSpacesSignature = nextSignature;
  const list = document.getElementById('spaces-list-spaces');
  if (list === null) return;
  list.replaceChildren();
  if (state.spaces.length === 0) {
    // This is the FIRST screen a new user sees, and it used to say
    // "No Spaces yet." and stop — a dead end at the exact moment
    // someone most needs to be told what to do. It now says what a
    // Space is for and offers the one action that resolves the state.
    const hint = document.createElement('li');
    hint.className = 'spaces-empty-hint';
    hint.id = 'spaces-empty-hint';

    const line = document.createElement('p');
    line.className = 'spaces-empty-hint-line';
    line.textContent = 'Spaces are where you and your agents keep work together.';
    hint.appendChild(line);

    const cta = document.createElement('button');
    cta.type = 'button';
    cta.className = 'spaces-empty-hint-cta';
    cta.textContent = 'Create your first Space';
    cta.addEventListener('click', () => openNewSpaceDialog());
    hint.appendChild(cta);

    list.appendChild(hint);
    // RECENT/PINNED must not keep rows for Spaces that no longer exist
    // (2026-08-08 review): refresh them on this branch too.
    renderRecentSpaces();
    renderPinnedSpaces();
    return;
  }
  // Sort BEFORE row construction so the DOM order matches state.
  // Uncategorized is its own pinned row in a separate list and isn't
  // touched by the sort.
  const ordered = sortSpaces(state.spaces, state.sortMode);
  // ADR-069 — the More… drawer: past the threshold the list shows the
  // working set and folds the long tail behind one row, instead of the
  // sidebar growing without bound. Never fold when the tail would be
  // tiny (a "More… (1)" row costs more than it saves).
  const folded =
    !spacesDrawerOpen && ordered.length > SPACES_ACTIVE_LIMIT + SPACES_FOLD_SLACK;
  const visible = folded ? ordered.slice(0, SPACES_ACTIVE_LIMIT) : ordered;
  for (const space of visible) {
    const row = buildSpaceRow(space, space.id === state.activeScopeId);
    list.appendChild(row);
    // ADR-071 — exclusive expansion: only the ONE open space renders
    // its tree; a re-render reproduces the current open state exactly.
    if (expandedSpaceId === space.id) {
      list.appendChild(buildSpaceChildren(space.id));
    }
  }
  if (folded) {
    list.appendChild(buildSpacesDrawerRow(ordered.length - SPACES_ACTIVE_LIMIT, true));
  } else if (spacesDrawerOpen && ordered.length > SPACES_ACTIVE_LIMIT + SPACES_FOLD_SLACK) {
    list.appendChild(buildSpacesDrawerRow(0, false));
  }
  // The Recent + Pinned sections mirror the same state; keep in lockstep.
  renderRecentSpaces();
  renderPinnedSpaces();
  // Re-apply any standing search filter so a load doesn't break the
  // currently-typed query.
  applySidebarFilter();
}

/**
 * Pure sort for the Spaces sidebar. Stable across re-renders. Exposed
 * as an export so jsdom tests can pin the rule without driving the
 * DOM.
 *
 *   - `name`: case-insensitive ascending by display name.
 *   - `recent`: descending by `updatedAt` (falls back to `createdAt`
 *     when updatedAt is absent). Items missing both fall to the end
 *     so partial graph data doesn't push them above well-formed ones.
 */
export function sortSpaces(
  spaces: ReadonlyArray<RendererSpace>,
  mode: SpacesSortMode
): RendererSpace[] {
  const copy = [...spaces];
  if (mode === 'recent') {
    copy.sort((a, b) => {
      // ADR-060: prefer the graph-level activity key (newest member
      // create/edit by ANY writer) so another app's or person's change
      // floats the Space; fall back to the node's own stamps for rows
      // from older SDKs.
      const ta = parseTimestamp(a.lastActivity ?? a.updatedAt ?? a.createdAt);
      const tb = parseTimestamp(b.lastActivity ?? b.updatedAt ?? b.createdAt);
      if (ta === null && tb === null) return 0;
      if (ta === null) return 1;
      if (tb === null) return -1;
      return tb - ta;
    });
    return copy;
  }
  copy.sort((a, b) => {
    const na = (a.name ?? '').toLowerCase();
    const nb = (b.name ?? '').toLowerCase();
    if (na < nb) return -1;
    if (na > nb) return 1;
    return 0;
  });
  return copy;
}

function parseTimestamp(iso: string | undefined): number | null {
  if (typeof iso !== 'string' || iso.length === 0) return null;
  // Defense in depth: the SDK normalizes graph timestamps to ISO, but
  // other writers put epoch millis on these fields. Date.parse returns
  // NaN for those, which used to sink GSX-written Spaces to the bottom
  // of the "recently updated" sort no matter how fresh they were.
  const trimmed = iso.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n < 1e12 ? n * 1000 : n;
  }
  const t = Date.parse(trimmed);
  return Number.isFinite(t) ? t : null;
}

function renderSpaceListError(message: string): void {
  // An error paint invalidates the fingerprint so recovery repaints.
  renderedSpacesSignature = null;
  const list = document.getElementById('spaces-list-spaces');
  if (list === null) return;
  list.replaceChildren();
  const hint = document.createElement('li');
  hint.className = 'spaces-empty-hint spaces-empty-hint-error';
  hint.textContent = `Couldn't load Spaces: ${message}`;
  list.appendChild(hint);
}

function renderUncategorizedCount(count: number | null): void {
  const target = document.querySelector<HTMLElement>(
    '[data-count-target="uncategorized"]'
  );
  if (target === null) return;
  target.textContent = count === null ? '—' : formatCount(count);
  // Toggle the pulse animation on the intake dot only when count > 0.
  const dot = document.querySelector<HTMLElement>(
    '.spaces-row-intake .spaces-row-dot-intake'
  );
  if (dot !== null) {
    dot.classList.toggle('has-count', typeof count === 'number' && count > 0);
  }
}

export function buildSpaceRow(space: RendererSpace, active: boolean): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'spaces-row spaces-row-space';
  if (active) li.classList.add('is-active');
  // Shared spaces get an opt-in class for CSS hooks (accent color,
  // sparkle dot, etc.) so the renderer doesn't need to drop in extra
  // child elements when the space is user-managed.
  if (space.kind === 'shared') li.classList.add('is-shared');
  li.setAttribute('data-scope-id', space.id);
  li.setAttribute('role', 'button');
  li.setAttribute('tabindex', '0');

  // Explorer chevron (WISER-parity): expands the Space's item tree in
  // place. stopPropagation so the row's scope activation doesn't fire.
  const expand = document.createElement('button');
  expand.type = 'button';
  expand.className = 'spaces-row-expand';
  expand.setAttribute('aria-label', `Show items in ${space.name}`);
  expand.textContent = '▸';
  if (expandedSpaceId === space.id) li.classList.add('is-expanded');
  expand.addEventListener('click', (ev) => {
    ev.stopPropagation();
    toggleSpaceTree(space.id, li);
  });
  li.appendChild(expand);

  // Right-click → space context menu (share / upload / rename / info /
  // convert). The ⋯ trigger keeps its click menu; this is the fast path.
  li.addEventListener('contextmenu', (ev) => openSpaceContextMenu(ev, space));

  const dot = document.createElement('span');
  dot.className = 'spaces-row-dot';
  if (typeof space.color === 'string' && space.color.length > 0) {
    { const c = safeCssColor(space.color); if (c !== null) dot.style.background = c; }
  }
  li.appendChild(dot);

  const name = document.createElement('span');
  name.className = 'spaces-row-name';
  name.textContent = space.name.length > 0 ? space.name : '(unnamed)';
  li.appendChild(name);

  // Shared-space badge (Phase 4). A small "AI" pill next to the name so
  // users instantly see which Spaces are AI-managed. Skipped for
  // user-managed spaces so the sidebar stays clean.
  if (space.kind === 'shared') {
    const badge = document.createElement('span');
    badge.className = 'spaces-row-kind-badge';
    badge.setAttribute('aria-label', 'AI-managed shared space');
    badge.title = 'Shared space — AI-managed';
    badge.textContent = 'AI';
    li.appendChild(badge);
  }

  // ADR-069 — machine-named nudge: a Space nobody ever named gets a
  // quiet "name?" affordance that opens the existing inline rename.
  // One click retires the "Space a7671f80" clutter at its source.
  if (looksMachineNamed(space.name)) {
    const nudge = document.createElement('button');
    nudge.type = 'button';
    nudge.className = 'spaces-row-name-nudge';
    nudge.textContent = 'name?';
    nudge.title = 'This space never got a real name — click to rename it';
    nudge.setAttribute('aria-label', `Rename ${space.name}`);
    nudge.addEventListener('click', (ev) => {
      ev.stopPropagation();
      startInlineRename(space.id);
    });
    li.appendChild(nudge);
  }

  // ADR-051: members-only spaces get a lock pill so it's obvious at a
  // glance which Spaces are gated. Open spaces stay clean.
  if (space.visibility === 'restricted') {
    const lock = document.createElement('span');
    lock.className = 'spaces-row-lock-badge';
    lock.setAttribute('aria-label', 'Members-only space');
    lock.title = 'Members only — visible to people and agents with access';
    lock.textContent = '🔒';
    li.appendChild(lock);
  }

  const count = document.createElement('span');
  count.className = 'spaces-row-count';
  count.textContent =
    typeof space.itemCount === 'number' ? formatCount(space.itemCount) : '';
  li.appendChild(count);

  // Hover-revealed "⋯" trigger for the rename/delete menu (Phase 3a).
  // Click handler stops propagation so the row's own activation
  // doesn't fire; the click is wired globally by `wireMutationsUI()`
  // via the `data-row-menu-trigger` attribute selector so per-row
  // listeners don't leak across renders.
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'spaces-row-menu-trigger';
  trigger.setAttribute('aria-label', `Open menu for ${space.name || 'this space'}`);
  trigger.setAttribute('data-row-menu-trigger', space.id);
  trigger.textContent = '⋯';
  li.appendChild(trigger);

  return li;
}

// ─── Item card list ─────────────────────────────────────────────────────

interface RenderItemListOpts {
  loading?: boolean;
  error?: string;
}

/**
 * Render the Space-scoped view: header + filter chips + unified
 * timeline (items + events). Replaces the prior card-grid view so
 * every non-Home scope feels like "channel-but-better" (the same
 * timeline chrome that Home uses, scoped to one Space).
 *
 * Uncategorized: timeline shows items only (no Space-scoped events
 * make sense for the synthetic intake zone). Real Spaces: timeline
 * shows merged events + items.
 */
function renderItemList(opts: RenderItemListOpts): void {
  const main = document.getElementById('spaces-main');
  if (main === null) return;
  const wrap = ensureItemsRegion(main);
  wrap.replaceChildren();
  // Record what this paint represents so a later unchanged refresh can
  // skip the teardown (see itemListSignature). Loading / error paints
  // and search results clear it, because the grid then does not
  // represent the plain item list.
  const paintingPlainList =
    opts.loading !== true &&
    opts.error === undefined &&
    state.itemsSearchResults === null;
  renderedItemsSignature = paintingPlainList ? itemListSignature(state.items) : null;
  renderedItemsScopeId = paintingPlainList ? state.activeScopeId : null;

  // Phase 4 v2: shared-space dashboard layout dispatch. When the active
  // scope is a shared space, render the playbook + tickets dashboard
  // instead of the standard timeline. We fall back to the timeline
  // path on error / loading so the user always sees structure.
  const activeSpace = state.spaces.find((s) => s.id === state.activeScopeId);
  if (
    activeSpace !== undefined &&
    activeSpace.kind === 'shared' &&
    opts.error === undefined
  ) {
    renderSharedSpaceDashboard(wrap, activeSpace, opts.loading === true);
    return;
  }

  // Header: Space name + description + refresh affordance. Lives
  // outside the timeline so a refresh doesn't cause the header to
  // shimmer.
  wrap.appendChild(buildSpaceHeader({ busy: opts.loading === true }));

  if (opts.error !== undefined) {
    wrap.appendChild(buildBanner('error', opts.error));
    return;
  }

  // Every Space shows its contents — see appendSpaceContents.
  appendSpaceContents(wrap, opts);
}

/**
 * The Space CONTENTS grid: filter chips, hidden-items chip, bulk bar,
 * recency bands, and the asset tiles themselves.
 *
 * Extracted 2026-08-18 (user: "I click on data bricks space and see no
 * assets in the middle panel"). A shared Space rendered the ops
 * dashboard INSTEAD of its contents, so four playbooks sitting in the
 * space were unreachable from the space's own view. A Space is a
 * container; its view must always show what is in it. One function, so
 * both kinds get the SAME tiles, filters, and affordances rather than a
 * lookalike second implementation that drifts.
 */
function appendSpaceContents(wrap: HTMLElement, opts: RenderItemListOpts): void {
  // Sprint 3: when a search is active, replace the timeline with a
  // search-result list. The search bypasses the timeline merge entirely
  // — it's a direct asset hit-list, not a chronological feed.
  if (state.itemsSearchResults !== null) {
    const heading = document.createElement('h3');
    heading.className = 'spaces-items-search-heading';
    heading.textContent = `Search results for "${state.itemsSearchQuery}"`;
    wrap.appendChild(heading);
    if (state.itemsSearchResults.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'spaces-items-search-empty';
      empty.textContent = 'No assets match this search.';
      wrap.appendChild(empty);
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'spaces-card-grid';
    grid.id = 'spaces-card-grid';
    for (const item of state.itemsSearchResults) {
      grid.appendChild(buildItemCard(item, item.id === state.activeItemId));
    }
    wrap.appendChild(grid);
    return;
  }

  // Filter chips: shared with Home so the user's "Agents-only" or
  // "24h" preference survives a scope switch. Applies to assets in
  // the grid below — events are NOT rendered in the per-Space view
  // anymore (they're an activity feed, not an asset surface).
  wrap.appendChild(buildFilterChips());

  // Per-Space view used to merge events + items into a chat-style
  // timeline. The user pushed back: "they look like Slack messages
  // vs assets." So this view is now an asset-first grid — content-
  // forward tiles built by `buildItemCard`. Events stay on Home,
  // which is the dedicated activity surface.
  const scopeVisibleItems = state.items.filter(
    (i) => !isItemHiddenInSpace(state.activeScopeId, i.id)
  );
  const gridHiddenCount = state.items.length - scopeVisibleItems.length;
  const filteredItems = filterItemsByHomeFilter(
    scopeVisibleItems,
    state.homeFilter,
    Date.now()
  );

  if (opts.loading === true && state.items.length === 0) {
    wrap.appendChild(buildTimelineSkeleton(6));
    return;
  }

  // "Hide in this space" chip — hidden items stay one click away.
  if (gridHiddenCount > 0) {
    const hiddenChip = document.createElement('button');
    hiddenChip.type = 'button';
    hiddenChip.className = 'spaces-grid-hidden-chip';
    hiddenChip.textContent = `${gridHiddenCount} hidden — show`;
    hiddenChip.addEventListener('click', () => {
      clearHiddenItemsInSpace(state.activeScopeId);
      showToast('Hidden items restored');
      renderItemList({});
      refreshSpaceTree(state.activeScopeId);
    });
    wrap.appendChild(hiddenChip);
  }

  if (filteredItems.length === 0) {
    // Distinguish "nothing here" from "nothing matches this filter":
    // a Space with items but a People/Agents/24h chip that excludes
    // them all must not read "empty / add the first item" (2026-08-08).
    if (scopeVisibleItems.length > 0 && state.homeFilter !== 'all') {
      wrap.appendChild(buildFilteredEmptyState());
    } else {
      wrap.appendChild(buildEmptyItemsState(state.activeScopeId));
    }
    return;
  }

  // Bulk-select toolbar -- only when at least one item is selected.
  // Lives above the grid so move/delete actions read top-to-bottom.
  const bulkBar = buildBulkSelectToolbar();
  if (bulkBar !== null) wrap.appendChild(bulkBar);

  const grid = document.createElement('div');
  grid.className = 'spaces-card-grid';
  grid.id = 'spaces-card-grid';
  grid.setAttribute('aria-label', 'Assets');
  // Recency organization (2026-08-11): the server orders by updatedAt
  // DESC, but that ORDER BY compares mixed-format timestamp STRINGS
  // (ISO vs epoch-ms across writers) — re-sort on parsed time so the
  // bands below are always coherent. Stable, so equal stamps keep
  // server order.
  const nowMs = Date.now();
  const recencySorted = [...filteredItems].sort(
    (a, b) => (itemLastEditMs(b) ?? -1) - (itemLastEditMs(a) ?? -1)
  );
  const recencyRules = planRecencyRules(recencySorted, nowMs);
  let ruleCursor = 0;
  recencySorted.forEach((item, index) => {
    if (ruleCursor < recencyRules.length && recencyRules[ruleCursor]?.index === index) {
      const rule = document.createElement('div');
      rule.className = 'spaces-grid-recency-rule';
      rule.setAttribute('role', 'separator');
      rule.textContent = recencyRules[ruleCursor]!.label;
      grid.appendChild(rule);
      ruleCursor += 1;
    }
    grid.appendChild(buildItemCard(item, item.id === state.activeItemId));
  });
  wrap.appendChild(grid);

  // A sidebar selection made before this paint (scope switch = async
  // fetch) is honored now that the tile exists.
  if (pendingTileFocusId !== null && focusItemTile(pendingTileFocusId)) {
    pendingTileFocusId = null;
  }

  // End-of-feed cue when nothing is filtered out.
  if (filteredItems.length >= 5 && filteredItems.length === state.items.length) {
    const tail = document.createElement('div');
    tail.className = 'home-timeline-tail';
    tail.textContent = 'You are all caught up.';
    wrap.appendChild(tail);
  }
}

/**
 * Filter items by the same HomeFilter rules `filterTimeline` applies
 * to timeline rows, but operating directly on item summaries. The
 * per-Space view doesn't render events anymore, so the timeline
 * adapter is no longer worth the round-trip.
 *
 * - `all` — pass through.
 * - `people` / `agents` — branch on `producedBy.kind === 'Agent'`.
 * - `24h` / `week` — branch on `updatedAt` falling inside the window.
 */
export function filterItemsByHomeFilter(
  items: ReadonlyArray<RendererItemSummary>,
  filter: HomeFilter,
  nowMs: number
): RendererItemSummary[] {
  if (filter === 'all') return [...items];
  if (filter === 'people') {
    return items.filter((i) => i.producedBy?.kind !== 'Agent');
  }
  if (filter === 'agents') {
    return items.filter((i) => i.producedBy?.kind === 'Agent');
  }
  const horizonMs =
    filter === '24h' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  const cutoff = nowMs - horizonMs;
  return items.filter((i) => {
    const t = Date.parse(i.updatedAt || i.createdAt);
    return Number.isFinite(t) && t >= cutoff;
  });
}

/**
 * Per-Space header: name + optional description + refresh button.
 * Pulled into its own pure builder so jsdom tests can exercise the
 * pattern (name resolution, fallback for missing description) without
 * driving the full renderer.
 */
// ─── Shared-space dashboard (Phase 4 v2) ────────────────────────────────

/**
 * Render the shared-space dashboard: header (with member chips +
 * "+ Member" affordance), playbook block at top, tickets grouped by
 * status below, plus a "+ Ticket" CTA.
 *
 * Uses cached dashboard state when available so navigation in/out of a
 * shared space paints instantly. The fresh fetch fires in the
 * background and re-paints when it lands.
 */
function renderSharedSpaceDashboard(
  wrap: HTMLElement,
  space: RendererSpace,
  busy: boolean
): void {
  wrap.appendChild(buildSpaceHeader({ busy }));

  // Member chips row.
  const cached = state.sharedDashboards.get(space.id);
  wrap.appendChild(buildSharedMembersRow(space, cached?.members ?? [], cached?.errors?.members));

  // Dashboard body — playbook block + tickets section.
  const body = document.createElement('div');
  body.className = 'spaces-shared-dashboard';
  body.setAttribute('data-space-id', space.id);

  // Playbook section
  body.appendChild(
    buildSharedDashboardPlaybook(space, cached?.playbook ?? null, cached?.errors?.playbook)
  );

  // Tickets section
  body.appendChild(
    buildSharedDashboardTickets(
      space,
      cached?.tickets ?? [],
      busy && cached === undefined,
      cached?.errors?.tickets
    )
  );

  // Checklists section (ADR-055 addendum, 2026-08-08): the Space's
  // checklist LIBRARY — the reusable, versioned team artifacts. Runs
  // still happen on tickets at their pause points; this is where the
  // artifacts themselves are created, revised, and retired.
  body.appendChild(buildSharedDashboardChecklists(space));

  // CONTENTS — the same grid a user Space shows, same tiles, same
  // filters (2026-08-18). Before this, a shared Space replaced its
  // contents with the ops dashboard, so anything that wasn't a ticket,
  // a checklist, or THE designated playbook simply had no home in the
  // main pane. The ops sections are an ADDITION for shared spaces, not
  // a substitute for the space itself.
  const contents = document.createElement('section');
  contents.className = 'spaces-shared-section spaces-shared-section-contents';
  const contentsHeading = document.createElement('h3');
  contentsHeading.className = 'spaces-shared-section-heading';
  contentsHeading.textContent = 'Contents';
  contents.appendChild(contentsHeading);
  appendSpaceContents(contents, { loading: busy });
  body.appendChild(contents);

  wrap.appendChild(body);

  // Fire-and-forget refresh — ONLY when the cache is stale. Rendering
  // must never unconditionally trigger a fetch: this function is
  // re-entered by the repaint at the end of that very fetch.
  if (sharedDashboardIsStale(space.id)) {
    void loadSharedSpaceDashboard(space.id);
  }
}

function buildSharedMembersRow(
  space: RendererSpace,
  members: ReadonlyArray<LiteSpacesMemberView>,
  loadError?: string
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'spaces-shared-members';
  const label = document.createElement('span');
  label.className = 'spaces-shared-members-label';
  label.textContent = 'Members';
  row.appendChild(label);
  // A failed read is NOT an empty list — "No members yet" on a shared
  // surface reads as a fact about the team. Banner instead; any chips
  // below it are the last good (possibly stale) data.
  if (loadError !== undefined) {
    row.appendChild(buildBanner('error', `Couldn't load members: ${loadError}`));
  }
  if (members.length === 0) {
    if (loadError === undefined) {
      const empty = document.createElement('span');
      empty.className = 'spaces-shared-members-empty';
      empty.textContent = 'No members yet';
      row.appendChild(empty);
    }
  } else {
    for (const m of members) {
      row.appendChild(buildMemberChip(space.id, m));
    }
  }
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'spaces-shared-members-add';
  addBtn.textContent = '+ Member';
  addBtn.setAttribute('data-space-id', space.id);
  addBtn.addEventListener('click', () => {
    void openAddMemberPrompt(space.id);
  });
  row.appendChild(addBtn);
  return row;
}

// ─── Access duration (ADR-052) ───────────────────────────────────────
//
// The mental model we present is "who can see this, and until when" —
// not the five mechanisms underneath (bucket privacy, file TTL, link
// expiry, Space visibility, grant expiry). A member row answers the
// second half of that question in words, or says nothing at all when
// access is permanent.

/** Access-duration presets. `''` is permanent. */
const ACCESS_PRESETS: ReadonlyArray<{ value: string; ms: number; label: string }> = [
  { value: '24h', ms: 24 * 60 * 60 * 1000, label: '24 hours' },
  { value: '7d', ms: 7 * 24 * 60 * 60 * 1000, label: '7 days' },
  { value: '30d', ms: 30 * 24 * 60 * 60 * 1000, label: '30 days' },
  { value: '90d', ms: 90 * 24 * 60 * 60 * 1000, label: '90 days' },
];

/** Resolve a preset to an absolute instant, or null for permanent. */
export function accessPresetToIso(value: string, now: number = Date.now()): string | null {
  const preset = ACCESS_PRESETS.find((p) => p.value === value);
  return preset === undefined ? null : new Date(now + preset.ms).toISOString();
}

export type AccessState = 'permanent' | 'active' | 'soon' | 'expired';

/**
 * Classify a grant. `expired` is a first-class state rather than an
 * absence: the member stays listed so the owner can see WHY someone
 * lost access, instead of silently vanishing from the list.
 */
export function accessState(
  member: { accessExpiresAt?: string },
  now: number = Date.now()
): AccessState {
  const raw = member.accessExpiresAt;
  if (typeof raw !== 'string' || raw.trim().length === 0) return 'permanent';
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return 'permanent';
  if (at <= now) return 'expired';
  return at - now <= 24 * 60 * 60 * 1000 ? 'soon' : 'active';
}

/**
 * Label for a grant.
 *
 * Relative when it's urgent ("expires in 6h" — you need to act), and
 * absolute once it's far enough out ("until 14 Aug" — you're planning
 * around a date). A single format would be wrong at one end or the
 * other. Permanent says nothing at all: the common case shouldn't add
 * visual noise to every row.
 */
export function accessLabel(
  member: { accessExpiresAt?: string },
  now: number = Date.now()
): string {
  const state = accessState(member, now);
  if (state === 'permanent') return '';
  if (state === 'expired') return 'access expired';
  const at = Date.parse(member.accessExpiresAt as string);
  const ms = at - now;
  if (ms <= 48 * 60 * 60 * 1000) {
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `expires in ${Math.max(1, mins)}m`;
    return `expires in ${Math.round(mins / 60)}h`;
  }
  const d = new Date(at);
  const MONTHS = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  return `until ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ''}`;
}

/**
 * Ask for an access duration. Resolves `undefined` when cancelled —
 * distinct from `null`, which means "permanent".
 *
 * This was a `window.prompt()`, which Electron renderers DO NOT
 * SUPPORT — the app just toasted "prompt() is not supported" and the
 * whole flow dead-ended (found in the 2026-08-06 driven pass). It is
 * now a small inline popover built from the same ACCESS_PRESETS.
 */
function promptAccessDuration(who: string): Promise<string | null | undefined> {
  return new Promise((resolve) => {
    document.querySelector('.spaces-access-popover-backdrop')?.remove();
    let settled = false;
    const finish = (value: string | null | undefined): void => {
      if (settled) return;
      settled = true;
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') finish(undefined);
    };

    const backdrop = document.createElement('div');
    backdrop.className = 'spaces-member-picker-backdrop spaces-access-popover-backdrop';
    const panel = document.createElement('div');
    panel.className = 'spaces-member-picker spaces-access-popover';

    const head = document.createElement('div');
    head.className = 'spaces-member-picker-head';
    const title = document.createElement('span');
    title.textContent = `Access for ${who}`;
    head.appendChild(title);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'spaces-member-picker-close';
    close.setAttribute('aria-label', 'Cancel');
    close.textContent = '×';
    close.addEventListener('click', () => finish(undefined));
    head.appendChild(close);
    panel.appendChild(head);

    const list = document.createElement('div');
    list.className = 'spaces-member-picker-results';
    const choices: Array<{ label: string; value: string | null }> = [
      { label: 'Permanent', value: null },
      ...ACCESS_PRESETS.map((p) => ({ label: p.label, value: p.value })),
    ];
    for (const choice of choices) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'spaces-member-picker-row';
      const name = document.createElement('span');
      name.className = 'spaces-member-picker-name';
      name.textContent = choice.label;
      row.appendChild(name);
      row.addEventListener('click', () => {
        finish(choice.value === null ? null : accessPresetToIso(choice.value));
      });
      list.appendChild(row);
    }
    panel.appendChild(list);

    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    backdrop.addEventListener('click', (ev) => {
      if (ev.target === backdrop) finish(undefined);
    });
    document.addEventListener('keydown', onKey);
  });
}

/**
 * ADR-074 — flip a member between read-only and full access. Confirms
 * in BOTH directions: restricting takes something away, and granting
 * write hands someone the ability to change or delete this Space's
 * contents. Neither should happen on an unexplained click.
 */
async function changeMemberRole(
  spaceId: string,
  member: LiteSpacesMemberView,
  next: 'reader' | 'writer',
  refresh?: () => Promise<void>
): Promise<void> {
  const bridge = window.lite?.spaces;
  if (bridge === undefined) return;
  const who = member.name.length > 0 ? member.name : member.id;
  const ok = await askToConfirm(
    next === 'reader' ? `Make ${who} read-only?` : `Let ${who} make changes?`,
    next === 'reader'
      ? `${who} keeps seeing everything in this Space, but can no longer add, ` +
        'edit or delete anything in it. You can undo this at any time.'
      : `${who} will be able to add, edit and delete this Space's contents — ` +
        'including things other people put here.',
    next === 'reader' ? 'Make read-only' : 'Allow edits'
  );
  if (!ok) return;
  try {
    const envelope = await bridge.members.add(spaceId, member.id, { role: next });
    if (envelope.ok === false) {
      showToast(envelope.error.message);
      return;
    }
    showToast(next === 'reader' ? `${who} is now read-only` : `${who} can make changes`);
    if (refresh !== undefined) await refresh();
    else await loadSharedSpaceDashboard(spaceId);
  } catch (err) {
    window.logging?.error?.('spaces', 'changeMemberRole failed', {
      spaceId,
      error: messageFrom(err),
    });
    showToast(messageFrom(err));
  }
}

/** Change (or renew) a member's access duration. */
async function changeMemberAccess(
  spaceId: string,
  member: LiteSpacesMemberView,
  refresh?: () => Promise<void>
): Promise<void> {
  const bridge = window.lite?.spaces;
  if (bridge === undefined) return;
  const who = member.name.length > 0 ? member.name : member.id;
  const choice = await promptAccessDuration(who);
  if (choice === undefined) return;
  // A duration change is an ACCESS change: shortening one silently
  // schedules a revoke, and post-ADR-065 membership is the only thing
  // granting visibility. Confirm when access will end (2026-08-18
  // confirm audit); "permanent" needs no warning.
  if (choice !== null) {
    const ok = await askToConfirm(
      `Limit ${who}'s access?`,
      `${who} loses access to this Space when it expires (${accessLabel({ accessExpiresAt: choice })}). ` +
        'Nothing is deleted, and you can extend or renew at any time.',
      'Set duration'
    );
    if (!ok) return;
  }
  try {
    const envelope = await bridge.members.add(spaceId, member.id, { expiresAt: choice });
    if (envelope.ok === false) {
      showToast(envelope.error.message);
      return;
    }
    showToast(
      choice === null
        ? `${who} now has permanent access`
        : `${who}: ${accessLabel({ accessExpiresAt: choice })}`
    );
    if (refresh !== undefined) await refresh();
    else await loadSharedSpaceDashboard(spaceId);
  } catch (err) {
    window.logging?.error?.('spaces', 'changeMemberAccess failed', { spaceId, memberId: member.id, error: messageFrom(err) });
    showToast(messageFrom(err));
  }
}

function buildMemberChip(
  spaceId: string,
  member: LiteSpacesMemberView,
  refresh?: () => Promise<void>
): HTMLElement {
  const chip = document.createElement('span');
  chip.className = 'spaces-shared-member-chip';
  chip.setAttribute('data-member-kind', member.kind);
  chip.setAttribute('data-member-id', member.id);
  const name = document.createElement('span');
  name.className = 'spaces-shared-member-chip-name';
  name.textContent = member.name.length > 0 ? member.name : member.id;
  chip.appendChild(name);
  const kindEl = document.createElement('span');
  kindEl.className = 'spaces-shared-member-chip-kind';
  kindEl.textContent = member.kind;
  chip.appendChild(kindEl);

  // Access duration. Always clickable — permanent renders as a quiet
  // "∞" affordance rather than nothing, so adding a deadline is
  // discoverable instead of hidden behind a menu nobody opens.
  const state = accessState(member);
  chip.setAttribute('data-access', state);
  const access = document.createElement('button');
  access.type = 'button';
  access.className = `spaces-member-access spaces-member-access-${state}`;
  const label = accessLabel(member);
  access.textContent = state === 'permanent' ? '∞' : label;
  access.title =
    state === 'permanent'
      ? `${member.name || member.id} has permanent access — click to set a time limit`
      : state === 'expired'
        ? `Access ended — click to renew`
        : `Access ${label} — click to change`;
  access.setAttribute('aria-label', access.title);
  access.addEventListener('click', () => {
    void changeMemberAccess(spaceId, member, refresh);
  });
  chip.appendChild(access);

  // ADR-074 — read-only members. Same affordance grammar as access
  // duration: the CURRENT state is the button, clicking flips it. A
  // writer shows nothing loud (writing is the norm); a reader wears a
  // visible "read-only" pill so the restriction is never a surprise.
  const role = member.role === 'reader' ? 'reader' : 'writer';
  const roleBtn = document.createElement('button');
  roleBtn.type = 'button';
  roleBtn.className = `spaces-member-role spaces-member-role-${role}`;
  roleBtn.textContent = role === 'reader' ? 'read-only' : '✎';
  roleBtn.title =
    role === 'reader'
      ? `${member.name || member.id} can see everything here but change nothing — click to allow edits`
      : `${member.name || member.id} can add and change things — click to make read-only`;
  roleBtn.setAttribute('aria-label', roleBtn.title);
  roleBtn.addEventListener('click', () => {
    void changeMemberRole(spaceId, member, role === 'reader' ? 'writer' : 'reader', refresh);
  });
  chip.appendChild(roleBtn);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'spaces-shared-member-chip-remove';
  remove.textContent = '×';
  remove.setAttribute('aria-label', `Remove ${member.name}`);
  remove.addEventListener('click', () => {
    void removeMember(spaceId, member.id, refresh, member.name);
  });
  chip.appendChild(remove);
  return chip;
}

function buildSharedDashboardPlaybook(
  space: RendererSpace,
  playbook: RendererItem | null,
  loadError?: string
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'spaces-shared-section spaces-shared-section-playbook';

  const heading = document.createElement('h3');
  heading.className = 'spaces-shared-section-heading';
  // "Current playbook", never bare "Playbook" (2026-08-18): a Space can
  // hold many playbook-kind assets while designating none of them, so a
  // section titled "Playbook" saying "No playbook set" reads as a flat
  // contradiction to someone looking straight at one.
  heading.textContent = 'Current playbook';
  section.appendChild(heading);

  if (loadError !== undefined) {
    section.appendChild(buildBanner('error', `Couldn't load the playbook: ${loadError}`));
  }

  if (playbook === null) {
    // Only claim "no playbook" when the read actually succeeded — a
    // failed read already rendered its banner above.
    if (loadError === undefined) {
      const empty = document.createElement('div');
      empty.className = 'spaces-shared-playbook-empty';
      const msg = document.createElement('p');
      // Name the REAL path and the REAL button. The old copy ("add a
      // plan… promote it") invented two words the UI never uses and told
      // people who already had playbooks here to go make one.
      msg.textContent =
        'This space hasn\u2019t chosen a current playbook yet. Open an asset here \u2014 ' +
        'a playbook or any other \u2014 and choose \u201cSet as playbook\u201d to make it ' +
        'the plan agents work against.';
      empty.appendChild(msg);
      section.appendChild(empty);
    }
    return section;
  }

  // Playbook card: title (click to open detail) + excerpt + footnote.
  const card = document.createElement('article');
  card.className = 'spaces-shared-playbook-card';
  card.setAttribute('data-item-id', playbook.id);
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');
  card.addEventListener('click', () => void loadItemDetail(playbook.id));
  // Parity with grid tiles: double-click opens the instrument.
  card.addEventListener('dblclick', () => {
    void openPlaybookInWiser(playbook.id);
  });
  card.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      void loadItemDetail(playbook.id);
    }
  });

  const title = document.createElement('h4');
  title.className = 'spaces-shared-playbook-card-title';
  title.textContent = generateItemTitle(playbook);
  card.appendChild(title);

  const playbookExcerpt = tileExcerptText(playbook.excerpt);
  if (playbookExcerpt !== null) {
    const excerpt = document.createElement('p');
    excerpt.className = 'spaces-shared-playbook-card-excerpt';
    excerpt.textContent = playbookExcerpt;
    card.appendChild(excerpt);
  }

  const footnote = document.createElement('p');
  footnote.className = 'spaces-shared-playbook-card-footnote';
  footnote.textContent = 'Edit in the Playbook tool; changes flow in automatically.';
  card.appendChild(footnote);

  section.appendChild(card);
  // Suppress unused-param warning while keeping the signature stable
  // for tests that pass `space`.
  void space;
  return section;
}

function buildSharedDashboardTickets(
  space: RendererSpace,
  tickets: ReadonlyArray<RendererItem>,
  loading: boolean,
  loadError?: string
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'spaces-shared-section spaces-shared-section-tickets';

  const headingRow = document.createElement('div');
  headingRow.className = 'spaces-shared-section-heading-row';
  const heading = document.createElement('h3');
  heading.className = 'spaces-shared-section-heading';
  heading.textContent = 'Tickets';
  headingRow.appendChild(heading);

  const addTicket = document.createElement('button');
  addTicket.type = 'button';
  addTicket.className = 'spaces-shared-add-ticket-button';
  addTicket.textContent = '+ Ticket';
  addTicket.setAttribute('data-space-id', space.id);
  addTicket.addEventListener('click', () => {
    void openCreateTicketPrompt(space.id);
  });
  headingRow.appendChild(addTicket);
  section.appendChild(headingRow);

  if (loadError !== undefined) {
    section.appendChild(buildBanner('error', `Couldn't load tickets: ${loadError}`));
  }

  if (loading && tickets.length === 0) {
    const placeholder = document.createElement('div');
    placeholder.className = 'spaces-shared-tickets-loading';
    placeholder.textContent = 'Loading tickets…';
    section.appendChild(placeholder);
    return section;
  }

  if (tickets.length === 0) {
    // A failed read must not masquerade as an empty board — the banner
    // above already told the truth; stale groups (if any) render below.
    if (loadError === undefined) {
      const empty = document.createElement('p');
      empty.className = 'spaces-shared-tickets-empty';
      empty.textContent = 'No tickets yet. Click "+ Ticket" to create one.';
      section.appendChild(empty);
    }
    return section;
  }

  // Group by status, render each non-empty group as a sub-section.
  const groups: Record<RendererTicketStatus, RendererItem[]> = {
    open: [],
    in_progress: [],
    blocked: [],
    done: [],
  };
  for (const t of tickets) {
    const status = t.ticket?.status ?? 'open';
    if (isRendererTicketStatus(status)) groups[status].push(t);
  }
  for (const status of TICKET_STATUSES_ORDERED) {
    const group = groups[status];
    if (group.length === 0) continue;
    const sub = document.createElement('div');
    sub.className = 'spaces-shared-tickets-group';
    sub.setAttribute('data-status', status);
    const groupHeading = document.createElement('h4');
    groupHeading.className = 'spaces-shared-tickets-group-heading';
    groupHeading.textContent = `${TICKET_STATUS_LABELS[status]} (${group.length})`;
    sub.appendChild(groupHeading);
    for (const ticket of group) {
      sub.appendChild(buildTicketCard(ticket));
    }
    section.appendChild(sub);
  }
  return section;
}

/**
 * Compact ticket card for the dashboard. Click → detail pane.
 * Status pill click → cycles status without opening the detail pane
 * (Tier 1d).
 */
function buildTicketCard(ticket: RendererItem): HTMLElement {
  const card = document.createElement('article');
  card.className = 'spaces-shared-ticket-card';
  card.setAttribute('data-item-id', ticket.id);
  const status = ticket.ticket?.status ?? 'open';
  if (isRendererTicketStatus(status)) card.setAttribute('data-status', status);

  // Status pill (clickable for quick-cycle)
  const pill = buildTicketStatusPill(status);
  pill.classList.add('spaces-shared-ticket-card-pill');
  pill.setAttribute('role', 'button');
  pill.setAttribute('tabindex', '0');
  pill.title = 'Click to cycle status';
  pill.addEventListener('click', (ev) => {
    ev.stopPropagation();
    void cycleTicketStatus(ticket);
  });
  pill.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      ev.stopPropagation();
      void cycleTicketStatus(ticket);
    }
  });
  card.appendChild(pill);

  // Title (clickable → detail pane)
  const title = document.createElement('h5');
  title.className = 'spaces-shared-ticket-card-title';
  title.textContent = generateItemTitle(ticket);
  card.appendChild(title);

  // Assignee footer (compact)
  const footer = document.createElement('div');
  footer.className = 'spaces-shared-ticket-card-footer';
  const assignee = ticket.ticket?.assignee ?? null;
  if (assignee !== null) {
    const chip = document.createElement('span');
    chip.className = 'spaces-shared-ticket-card-assignee';
    chip.setAttribute('data-assignee-kind', assignee.kind);
    chip.textContent = assignee.name.length > 0 ? assignee.name : assignee.id;
    footer.appendChild(chip);
  }
  if (ticket.ticket?.priority !== undefined) {
    const pri = document.createElement('span');
    pri.className = 'spaces-shared-ticket-card-priority';
    pri.setAttribute('data-priority', ticket.ticket.priority);
    pri.textContent = ticket.ticket.priority;
    footer.appendChild(pri);
  }
  card.appendChild(footer);

  // Open detail on title click (avoiding the pill).
  card.addEventListener('click', (ev) => {
    if (ev.target instanceof Element && ev.target.closest('.spaces-shared-ticket-card-pill') !== null) {
      return;
    }
    void loadItemDetail(ticket.id);
  });
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');
  card.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      void loadItemDetail(ticket.id);
    }
  });

  return card;
}

/**
 * Loader for the shared-space dashboard cache.
 *
 * Failure honesty (2026-08-08 release review): a failed section read
 * used to be mapped to `[]` / `null` and the catch was swallowed — a
 * failing members query rendered as "No members yet" on a multi-user
 * surface. Now each failed section keeps its prior cached data (stale
 * beats blank), records the message in `errors`, and logs; the section
 * builders render a distinct error banner from it.
 */
/**
 * Spaces whose dashboard fetch is in flight. WITHOUT this, the render
 * path is an infinite network loop: renderSharedSpaceDashboard fires
 * loadSharedSpaceDashboard, which on BOTH success and failure calls
 * renderItemList, which re-dispatches to renderSharedSpaceDashboard,
 * which fires the fetch again — three (now four) Neon queries per
 * lap, at network speed, for as long as a shared Space is on screen.
 * Reported live 2026-08-17 as "connection issues to NEON" + climbing
 * bandwidth + having to force-quit; the 503s were self-inflicted.
 */
const sharedDashboardInFlight = new Set<string>();

/** Don't refetch a dashboard more often than this (ms). */
const SHARED_DASHBOARD_TTL_MS = 30_000;

/** True when the cached dashboard is missing or older than the TTL. */
function sharedDashboardIsStale(spaceId: string): boolean {
  const cached = state.sharedDashboards.get(spaceId);
  if (cached === undefined) return true;
  return Date.now() - cached.fetchedAt > SHARED_DASHBOARD_TTL_MS;
}

async function loadSharedSpaceDashboard(spaceId: string): Promise<void> {
  const bridge = window.lite?.spaces;
  if (bridge === undefined) return;
  // Re-entrancy guard: the render→fetch→render cycle above means this
  // can be called again while the first call is still awaiting.
  if (sharedDashboardInFlight.has(spaceId)) return;
  sharedDashboardInFlight.add(spaceId);
  const prior = state.sharedDashboards.get(spaceId);
  try {
    const [playbookRes, ticketsRes, membersRes] = await Promise.all([
      bridge.playbooks.current(spaceId),
      bridge.tickets.list(spaceId),
      bridge.members.list(spaceId),
    ]);
    if (state.activeScopeId !== spaceId) return; // user navigated away

    const errors: { playbook?: string; tickets?: string; members?: string } = {};

    let playbook: RendererItem | null = prior?.playbook ?? null;
    if (playbookRes.ok === true) {
      playbook = playbookRes.value !== null ? (playbookRes.value as RendererItem) : null;
    } else {
      errors.playbook = playbookRes.error.message;
      window.logging?.warn?.('spaces', 'shared-dashboard playbook load failed', {
        spaceId,
        message: playbookRes.error.message,
      });
    }

    let tickets: RendererItem[] = prior?.tickets ?? [];
    if (ticketsRes.ok === true) {
      tickets = ticketsRes.value as RendererItem[];
    } else {
      errors.tickets = ticketsRes.error.message;
      window.logging?.warn?.('spaces', 'shared-dashboard tickets load failed', {
        spaceId,
        message: ticketsRes.error.message,
      });
    }

    let members: ReadonlyArray<LiteSpacesMemberView> = prior?.members ?? [];
    if (membersRes.ok === true) {
      members = membersRes.value as LiteSpacesMemberView[];
    } else {
      errors.members = membersRes.error.message;
      window.logging?.warn?.('spaces', 'shared-dashboard members load failed', {
        spaceId,
        message: membersRes.error.message,
      });
    }

    state.sharedDashboards.set(spaceId, {
      playbook,
      tickets,
      members,
      fetchedAt: Date.now(),
      ...(Object.keys(errors).length > 0 ? { errors } : {}),
    });
    // Re-render only if we're still viewing this scope.
    if (state.activeScopeId === spaceId) {
      renderItemList({});
    }
  } catch (err) {
    // Whole-fetch failure (the bridge itself rejected). Keep prior
    // data, flag every section, and repaint so the banners show.
    // (Merge note: subsumes the observability chip's warn-only catch —
    // this logs at error AND keeps stale data visible.)
    const message = messageFrom(err);
    window.logging?.error?.('spaces', 'shared-dashboard load threw', { spaceId, message });
    if (state.activeScopeId !== spaceId) return;
    state.sharedDashboards.set(spaceId, {
      playbook: prior?.playbook ?? null,
      tickets: prior?.tickets ?? [],
      members: prior?.members ?? [],
      fetchedAt: Date.now(),
      errors: { playbook: message, tickets: message, members: message },
    });
    renderItemList({});
  } finally {
    sharedDashboardInFlight.delete(spaceId);
  }
}

async function cycleTicketStatus(ticket: RendererItem): Promise<void> {
  const current = ticket.ticket?.status ?? 'open';
  const idx = TICKET_STATUSES_ORDERED.indexOf(current as RendererTicketStatus);
  const next = TICKET_STATUSES_ORDERED[(idx + 1) % TICKET_STATUSES_ORDERED.length];
  if (next === undefined) return;
  const bridge = window.lite?.spaces;
  if (bridge === undefined) return;
  try {
    const envelope = await bridge.tickets.update(ticket.id, { status: next });
    if (envelope.ok === false) {
      showToast(envelope.error.message);
      return;
    }
    // Refresh the dashboard for the active space (the ticket may have
    // moved between status groups).
    if (state.activeScopeId !== '') {
      await loadSharedSpaceDashboard(state.activeScopeId);
    }
  } catch (err) {
    window.logging?.error?.('spaces', 'cycleTicketStatus failed', { ticketId: ticket.id, error: messageFrom(err) });
    showToast(messageFrom(err));
  }
}

/**
 * Ask for a single line of text in an inline panel. Resolves null when
 * cancelled. Electron renderers do not implement `window.prompt` at
 * all (it toasts "prompt() is not supported"), so every text prompt in
 * this renderer goes through here.
 */
/**
 * Inline confirmation for a consequential action.
 *
 * Same panel language as `askForText` rather than `window.confirm`: a
 * system dialog reads as an app error, and this needs to read as a
 * decision. `body` is rendered as paragraphs so the consequence can be
 * stated in sentences instead of crammed into a title.
 *
 * Resolves true only on the explicit confirm — Escape, the backdrop,
 * the close button and Cancel all resolve false, so the safe answer is
 * the one every accidental interaction produces.
 */
function askToConfirm(
  title: string,
  body: string,
  confirmLabel: string,
  /**
   * Optional rich detail rendered under the body — lets a confirm show
   * WHAT is about to be saved (ADR-072's journey preview) instead of
   * asking the user to approve a thing they cannot see.
   */
  detail?: HTMLElement
): Promise<boolean> {
  return new Promise((resolve) => {
    document.querySelector('.spaces-confirm-backdrop')?.remove();
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') finish(false);
    };

    const backdrop = document.createElement('div');
    backdrop.className = 'spaces-member-picker-backdrop spaces-confirm-backdrop';
    const panel = document.createElement('div');
    panel.className = 'spaces-member-picker spaces-confirm-panel';
    panel.setAttribute('role', 'alertdialog');
    panel.setAttribute('aria-label', title);

    const head = document.createElement('div');
    head.className = 'spaces-member-picker-head';
    const heading = document.createElement('span');
    heading.textContent = title;
    head.appendChild(heading);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'spaces-member-picker-close';
    close.setAttribute('aria-label', 'Cancel');
    close.textContent = '×';
    close.addEventListener('click', () => finish(false));
    head.appendChild(close);
    panel.appendChild(head);

    const text = document.createElement('div');
    text.className = 'spaces-confirm-body';
    for (const para of body.split('\n\n')) {
      if (para.trim().length === 0) continue;
      const p = document.createElement('p');
      p.textContent = para;
      text.appendChild(p);
    }
    panel.appendChild(text);
    if (detail !== undefined) {
      const scroll = document.createElement('div');
      scroll.className = 'spaces-confirm-detail';
      scroll.appendChild(detail);
      panel.appendChild(scroll);
    }

    const actions = document.createElement('div');
    actions.className = 'spaces-text-prompt-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'spaces-new-asset-button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => finish(false));
    actions.appendChild(cancel);
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'spaces-new-asset-button spaces-confirm-go';
    go.textContent = confirmLabel;
    go.addEventListener('click', () => finish(true));
    actions.appendChild(go);
    panel.appendChild(actions);

    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    backdrop.addEventListener('click', (ev) => {
      if (ev.target === backdrop) finish(false);
    });
    document.addEventListener('keydown', onKey);
    // Focus Cancel, not the confirm: a stray Enter should not widen
    // who can see a restricted asset.
    cancel.focus();
  });
}

function askForText(title: string, placeholder = ''): Promise<string | null> {
  return new Promise((resolve) => {
    document.querySelector('.spaces-text-prompt-backdrop')?.remove();
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') finish(null);
    };

    const backdrop = document.createElement('div');
    backdrop.className = 'spaces-member-picker-backdrop spaces-text-prompt-backdrop';
    const panel = document.createElement('div');
    panel.className = 'spaces-member-picker spaces-access-popover';

    const head = document.createElement('div');
    head.className = 'spaces-member-picker-head';
    const heading = document.createElement('span');
    heading.textContent = title;
    head.appendChild(heading);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'spaces-member-picker-close';
    close.setAttribute('aria-label', 'Cancel');
    close.textContent = '×';
    close.addEventListener('click', () => finish(null));
    head.appendChild(close);
    panel.appendChild(head);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'spaces-new-asset-input';
    input.placeholder = placeholder;
    input.autocomplete = 'off';
    panel.appendChild(input);

    const actions = document.createElement('div');
    actions.className = 'spaces-text-prompt-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'spaces-new-asset-button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => finish(null));
    actions.appendChild(cancel);
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'spaces-new-asset-button is-primary';
    ok.textContent = 'Create';
    ok.addEventListener('click', () => finish(input.value));
    actions.appendChild(ok);
    panel.appendChild(actions);

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') finish(input.value);
    });

    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    backdrop.addEventListener('click', (ev) => {
      if (ev.target === backdrop) finish(null);
    });
    document.addEventListener('keydown', onKey);
    input.focus();
  });
}

/** Inline "+ Ticket" UI. */
async function openCreateTicketPrompt(spaceId: string): Promise<void> {
  const title = await askForText('New ticket', 'Ticket title');
  if (title === null) return;
  const trimmed = title.trim();
  if (trimmed.length === 0) return;
  const bridge = window.lite?.spaces;
  if (bridge === undefined) return;
  try {
    const envelope = await bridge.tickets.create(spaceId, { title: trimmed });
    if (envelope.ok === false) {
      showToast(envelope.error.message);
      return;
    }
    showToast(`Created ticket "${trimmed}"`);
    await loadSharedSpaceDashboard(spaceId);
  } catch (err) {
    window.logging?.error?.('spaces', 'createTicket failed', { spaceId, error: messageFrom(err) });
    showToast(messageFrom(err));
  }
}

/**
 * "Set current playbook…" picker (2026-08-18). Until now the ONLY way
 * to designate a plan was to find the asset, select it, and use the
 * detail-pane button — archaeology, not an affordance. This lists the
 * Space's assets (playbook-shaped first, the current one marked) and
 * designates the chosen one.
 *
 * Works on any Space from the sidebar's right-click, including one that
 * isn't the active scope, so it fetches rather than reading `state`.
 */
async function openSetPlaybookPicker(spaceId: string, spaceName: string): Promise<void> {
  const bridge = window.lite?.spaces;
  if (bridge === undefined) return;
  document.querySelector('.spaces-member-picker-backdrop')?.remove();

  const backdrop = document.createElement('div');
  backdrop.className = 'spaces-member-picker-backdrop';
  const panel = document.createElement('div');
  panel.className = 'spaces-member-picker';
  const head = document.createElement('div');
  head.className = 'spaces-member-picker-head';
  const title = document.createElement('span');
  title.textContent = `Current playbook — ${spaceName}`;
  head.appendChild(title);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'spaces-member-picker-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';
  const dismiss = (): void => backdrop.remove();
  close.addEventListener('click', dismiss);
  head.appendChild(close);
  panel.appendChild(head);

  const list = document.createElement('div');
  list.className = 'spaces-member-picker-list';
  const loading = document.createElement('p');
  loading.className = 'spaces-member-picker-empty';
  loading.textContent = 'Loading assets…';
  list.appendChild(loading);
  panel.appendChild(list);
  backdrop.appendChild(panel);
  backdrop.addEventListener('click', (ev) => {
    if (ev.target === backdrop) dismiss();
  });
  document.body.appendChild(backdrop);

  let items: RendererItemSummary[] = [];
  let currentId: string | null = null;
  try {
    const [listed, current] = await Promise.all([
      bridge.items.list(spaceId),
      bridge.playbooks.current(spaceId),
    ]);
    if (listed.ok === true) items = listed.value as RendererItemSummary[];
    if (current.ok === true && current.value !== null) {
      currentId = (current.value as { id?: string }).id ?? null;
    }
  } catch (err) {
    window.logging?.warn?.('spaces', 'playbook picker load failed', {
      spaceId,
      error: messageFrom(err),
    });
  }

  list.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'spaces-member-picker-empty';
    empty.textContent = 'This Space has no assets yet — add one first.';
    list.appendChild(empty);
    return;
  }

  // Playbook-shaped assets lead: they're what a user is looking for.
  // Any kind remains selectable — promoting a note IS the feature.
  const ordered = [...items].sort((a, b) => {
    const ap = a.kind === 'playbook' ? 0 : 1;
    const bp = b.kind === 'playbook' ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a.title.localeCompare(b.title);
  });

  for (const item of ordered) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'spaces-member-picker-row';
    const name = document.createElement('span');
    name.className = 'spaces-member-picker-name';
    name.textContent = item.title.length > 0 ? item.title : '(untitled)';
    row.appendChild(name);
    const meta = document.createElement('span');
    meta.className = 'spaces-member-picker-email';
    meta.textContent = item.id === currentId ? 'current playbook' : kindLabel(item.kind);
    row.appendChild(meta);
    if (item.id === currentId) {
      row.disabled = true;
      row.classList.add('is-current');
    } else {
      row.addEventListener('click', () => {
        dismiss();
        void setSpacePlaybook(spaceId, item.id, item.title);
      });
    }
    list.appendChild(row);
  }
}

/** Designate an asset as the Space's current playbook (picker path). */
async function setSpacePlaybook(
  spaceId: string,
  itemId: string,
  title: string
): Promise<void> {
  const bridge = window.lite?.spaces;
  if (bridge === undefined) return;
  try {
    const envelope = await bridge.playbooks.set(spaceId, itemId);
    if (envelope.ok === false) {
      showToast(envelope.error.message);
      return;
    }
    showToast(`"${title}" is now the current playbook`);
    if (state.activeScopeId === spaceId) {
      await Promise.all([loadItems(), loadSharedSpaceDashboard(spaceId)]);
    }
  } catch (err) {
    window.logging?.error?.('spaces', 'setSpacePlaybook failed', {
      spaceId,
      error: messageFrom(err),
    });
    showToast(messageFrom(err));
  }
}

/**
 * Add-member picker — replaces the old raw window.prompt. Lists the
 * account's people + agents pulled from the graph (searchable), with
 * an invite-by-email row for addresses not in the graph yet. Adding a
 * member grants `[:HAS_ACCESS]` (they see the Space + its graph).
 */
async function openAddMemberPrompt(
  spaceId: string,
  refresh?: () => Promise<void>
): Promise<void> {
  document.querySelector('.spaces-member-picker-backdrop')?.remove();

  const backdrop = document.createElement('div');
  backdrop.className = 'spaces-member-picker-backdrop';
  const panel = document.createElement('div');
  panel.className = 'spaces-member-picker';

  const head = document.createElement('div');
  head.className = 'spaces-member-picker-head';
  const title = document.createElement('span');
  title.textContent = 'People';
  head.appendChild(title);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'spaces-member-picker-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';
  head.appendChild(close);
  panel.appendChild(head);

  const search = document.createElement('input');
  search.type = 'text';
  search.className = 'spaces-new-asset-input';
  search.placeholder = 'Search people and agents in your account…';
  search.autocomplete = 'off';
  panel.appendChild(search);

  // Who's already in — visible up top, removable in place. Feeds the
  // exclusion set so search never re-offers an existing member.
  const currentIds = new Set<string>();
  const currentSection = document.createElement('div');
  currentSection.className = 'spaces-member-current';
  panel.insertBefore(currentSection, search);
  const renderCurrent = async (): Promise<void> => {
    const bridge2 = window.lite?.spaces;
    if (bridge2 === undefined) return;
    try {
      const envelope = await bridge2.members.list(spaceId);
      if (envelope.ok !== true) return;
      currentIds.clear();
      currentSection.replaceChildren();
      const members = envelope.value;
      if (members.length === 0) return;
      const heading = document.createElement('div');
      heading.className = 'spaces-member-current-title';
      heading.textContent = `In this space · ${members.length}`;
      currentSection.appendChild(heading);
      for (const member of members) {
        currentIds.add(member.id.toLowerCase());
        const row = document.createElement('div');
        row.className = 'spaces-member-current-row';
        row.appendChild(buildPersonAvatar(member, 'md'));
        const nameEl = document.createElement('span');
        nameEl.className = 'spaces-member-current-name';
        nameEl.textContent = member.name;
        row.appendChild(nameEl);
        if (member.kind === 'Agent') {
          const kindEl = document.createElement('span');
          kindEl.className = 'spaces-member-current-kind';
          kindEl.textContent = 'agent';
          row.appendChild(kindEl);
        }
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'spaces-member-current-remove';
        removeBtn.textContent = '×';
        removeBtn.title = `Remove ${member.name}`;
        removeBtn.addEventListener('click', () => {
          void (async (): Promise<void> => {
            const env2 = await bridge2.members.remove(spaceId, member.id);
            if (env2.ok === false) {
              showToast(env2.error.message);
              return;
            }
            showToast(`Removed ${member.name}`);
            await renderCurrent();
            void runSearch(search.value.trim());
            if (refresh !== undefined) await refresh();
          })();
        });
        row.appendChild(removeBtn);
        currentSection.appendChild(row);
      }
    } catch {
      /* section is progressive enhancement */
    }
  };
  void renderCurrent();

  const results = document.createElement('div');
  results.className = 'spaces-member-picker-results';
  panel.appendChild(results);

  // ADR-052 access duration. This used to call window.prompt(), which
  // Electron renderers do not support at all ("prompt() is not
  // supported" — caught by the 2026-08-06 driven pass), so the choice
  // lives inline in the picker.
  const accessRow = document.createElement('div');
  accessRow.className = 'spaces-member-picker-access';
  const accessLabelEl = document.createElement('label');
  accessLabelEl.className = 'spaces-member-picker-access-label';
  accessLabelEl.htmlFor = 'spaces-member-picker-duration';
  accessLabelEl.textContent = 'Access';
  accessRow.appendChild(accessLabelEl);
  const durationSelect = document.createElement('select');
  durationSelect.id = 'spaces-member-picker-duration';
  durationSelect.className = 'spaces-member-picker-duration';
  const permanent = document.createElement('option');
  permanent.value = '';
  permanent.textContent = 'Permanent';
  durationSelect.appendChild(permanent);
  for (const preset of ACCESS_PRESETS) {
    const opt = document.createElement('option');
    opt.value = preset.value;
    opt.textContent = preset.label;
    durationSelect.appendChild(opt);
  }
  accessRow.appendChild(durationSelect);
  panel.appendChild(accessRow);

  const hint = document.createElement('p');
  hint.className = 'spaces-member-picker-hint';
  hint.textContent = 'Members get access to this Space and its graph.';
  panel.appendChild(hint);

  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);

  const dispose = (): void => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') dispose();
  };
  document.addEventListener('keydown', onKey);
  close.addEventListener('click', dispose);
  backdrop.addEventListener('click', (ev) => {
    if (ev.target === backdrop) dispose();
  });

  const addMember = async (memberId: string, isNewEmail: boolean): Promise<void> => {
    const bridge = window.lite?.spaces;
    if (bridge === undefined) return;
    try {
      if (isNewEmail) {
        await bridge.identity.getOrCreatePerson({ id: memberId, email: memberId });
      }
      // Ask for a duration at the moment of granting. Defaults to
      // permanent (least surprise), but putting the question here means
      // time-limited access is a first-class choice rather than
      // something you have to remember to go back and set.
      const expiresAt = accessPresetToIso(durationSelect.value);
      const envelope = await bridge.members.add(spaceId, memberId, { expiresAt });
      if (envelope.ok === false) {
        showToast(envelope.error.message);
        return;
      }
      const added = envelope.value.name || memberId;
      showToast(
        expiresAt === null
          ? `Added ${added}`
          : `Added ${added} · ${accessLabel({ accessExpiresAt: expiresAt })}`
      );
      // Stay open: adding several people is the common case. The
      // member appears above; the search resets for the next pick.
      await renderCurrent();
      search.value = '';
      void runSearch('');
      search.focus();
      if (refresh !== undefined) await refresh();
      else await loadSharedSpaceDashboard(spaceId);
      return;
    } catch (err) {
      window.logging?.error?.('spaces', 'addMember failed', { spaceId, error: messageFrom(err) });
      showToast(messageFrom(err));
    }
  };

  let searchSeq = 0;
  const runSearch = async (q: string): Promise<void> => {
    const bridge = window.lite?.spaces;
    if (bridge === undefined) return;
    const seq = ++searchSeq;
    results.replaceChildren(buildAgentLibraryStatus('Searching…'));
    try {
      const envelope = await bridge.members.searchLibrary(q, 25);
      if (seq !== searchSeq) return; // superseded by a newer keystroke
      results.replaceChildren();
      const entries = machineNamedLast(
        (envelope.ok === true ? envelope.value : []).filter(
          // Graph-only, and never re-offer an existing member (they're
          // listed above with a remove control instead).
          (entry) => !currentIds.has(entry.id.toLowerCase())
        )
      );
      for (const entry of entries) {
        results.appendChild(
          buildMemberPickerRow(entry, () => void addMember(entry.id, false))
        );
      }
      if (results.childElementCount === 0) {
        results.appendChild(
          buildAgentLibraryStatus(
            q.trim().length > 0
              ? `No one matching “${q.trim()}” — people must already exist in the account.`
              : 'Everyone in the account is already here.'
          )
        );
      }
    } catch (err) {
      if (seq !== searchSeq) return;
      window.logging?.warn?.('spaces', 'member search failed', { error: messageFrom(err) });
      results.replaceChildren(buildAgentLibraryStatus(messageFrom(err)));
    }
  };

  let debounce: number | null = null;
  search.addEventListener('input', () => {
    if (debounce !== null) window.clearTimeout(debounce);
    debounce = window.setTimeout(() => {
      debounce = null;
      void runSearch(search.value);
    }, 250);
  });

  search.focus();
  void runSearch('');
}

/** One selectable row of the add-member picker. Exported for tests. */
export function buildMemberPickerRow(
  entry: { kind: 'Person' | 'Agent'; id: string; name: string; email: string },
  onPick: () => void
): HTMLElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'spaces-member-picker-row';
  row.setAttribute('data-member-id', entry.id);
  const kind = document.createElement('span');
  kind.className = `spaces-member-picker-kind spaces-member-picker-kind-${entry.kind.toLowerCase()}`;
  kind.textContent = entry.kind === 'Agent' ? 'AGENT' : 'PERSON';
  row.appendChild(kind);
  const name = document.createElement('span');
  name.className = 'spaces-member-picker-name';
  name.textContent = entry.name.length > 0 ? entry.name : entry.id;
  row.appendChild(name);
  const idHint = entry.email.length > 0 ? entry.email : entry.id;
  if (idHint !== name.textContent) {
    const sub = document.createElement('span');
    sub.className = 'spaces-member-picker-id';
    sub.textContent = idHint;
    row.appendChild(sub);
  }
  row.addEventListener('click', onPick);
  return row;
}

async function removeMember(
  spaceId: string,
  memberId: string,
  refresh?: () => Promise<void>,
  memberName?: string
): Promise<void> {
  const bridge = window.lite?.spaces;
  if (bridge === undefined) return;
  // Revoking access was a SILENT one-click action (2026-08-18 audit):
  // no confirm, no undo, and — post ADR-065 — membership is the ONLY
  // thing granting visibility, so this is the single most consequential
  // control in the pane. It now says what it takes away.
  const who = memberName !== undefined && memberName.length > 0 ? memberName : 'this member';
  const ok = await askToConfirm(
    `Remove ${who}?`,
    `${who} loses access to this Space and everything in it. ` +
      'Nothing is deleted, and you can add them again — but they will not ' +
      'see the Space until you do.',
    'Remove'
  );
  if (!ok) return;
  try {
    const envelope = await bridge.members.remove(spaceId, memberId);
    if (envelope.ok === false) {
      showToast(envelope.error.message);
      return;
    }
    showToast('Member removed');
    if (refresh !== undefined) await refresh();
    else await loadSharedSpaceDashboard(spaceId);
  } catch (err) {
    window.logging?.error?.('spaces', 'removeMember failed', { spaceId, memberId, error: messageFrom(err) });
    showToast(messageFrom(err));
  }
}

/**
 * ADR-051 — the per-space visibility option. A toggle chip flips the
 * Space between 'open' (account-wide — the default every pre-existing
 * Space keeps) and 'restricted' (members-only). Restricting a Space
 * auto-grants the current user access server-side, and surfaces the
 * member strip here so access can be managed on any Space kind (the
 * shared dashboard keeps its own richer row).
 */
function buildSpaceVisibilityRow(space: RendererSpace): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'spaces-visibility-row';

  const restricted = space.visibility === 'restricted';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = restricted
    ? 'spaces-visibility-toggle is-restricted'
    : 'spaces-visibility-toggle';
  // State is carried by the ::before dot (amber = restricted) plus
  // these words. The old 🔓/🔒 pair was indistinguishable at 11px.
  toggle.textContent = restricted ? 'Members only' : 'Open to account';
  // ADR-065: membership decides visibility, not this flag. The old
  // tooltip promised account-wide sight in both directions — a
  // security-shaped claim the code has not honoured since 2026-08-13.
  toggle.title = restricted
    ? 'Members only. Visibility is granted by adding people — use "Add people…".'
    : 'Marked open. People still only see this Space once you add them ("Add people…").';
  toggle.addEventListener('click', () => {
    void toggleSpaceVisibility(space);
  });
  wrap.appendChild(toggle);

  if (restricted) {
    const strip = document.createElement('div');
    strip.className = 'spaces-visibility-members';
    strip.textContent = 'Loading members…';
    wrap.appendChild(strip);
    void populateVisibilityMembers(strip, space);
  }
  return wrap;
}

async function toggleSpaceVisibility(space: RendererSpace): Promise<void> {
  const bridge = window.lite?.spaces;
  if (bridge === undefined) return;
  const next = space.visibility === 'restricted' ? 'open' : 'restricted';
  try {
    const envelope = await bridge.updateSpace(space.id, { visibility: next });
    if (envelope.ok === false) {
      showToast(envelope.error.message);
      return;
    }
    showToast(
      next === 'restricted'
        ? '🔒 Members only — you were added as a member.'
        : '🔓 Open to everyone in the account.'
    );
    // Refresh sidebar + the active view (the header rebuilds with it).
    await loadSpaces();
    await loadItems();
  } catch (err) {
    window.logging?.error?.('spaces', 'toggleSpaceVisibility failed', { spaceId: space.id, error: messageFrom(err) });
    showToast(messageFrom(err));
  }
}

async function populateVisibilityMembers(
  strip: HTMLElement,
  space: RendererSpace
): Promise<void> {
  const bridge = window.lite?.spaces;
  if (bridge === undefined) {
    strip.textContent = '';
    return;
  }
  const refresh = async (): Promise<void> => {
    await populateVisibilityMembers(strip, space);
  };
  try {
    const envelope = await bridge.members.list(space.id);
    if (envelope.ok === false) {
      strip.textContent = '';
      return;
    }
    strip.textContent = '';
    const label = document.createElement('span');
    label.className = 'spaces-shared-members-label';
    label.textContent = 'Members';
    strip.appendChild(label);
    for (const m of envelope.value) {
      strip.appendChild(buildMemberChip(space.id, m, refresh));
    }
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'spaces-shared-members-add';
    addBtn.textContent = '+ Member';
    addBtn.addEventListener('click', () => {
      void openAddMemberPrompt(space.id, refresh);
    });
    strip.appendChild(addBtn);
  } catch (err) {
    window.logging?.warn?.('spaces', 'populateVisibilityMembers failed', { error: messageFrom(err) });
    strip.textContent = '';
  }
}

/** Events shown inline before the "Show all" expander. */
const HEADER_ACTIVITY_ROWS = 3;
/** Session-sticky: an explicit expand survives repaints, per Space. */
const expandedActivityScopes = new Set<string>();

/**
 * What has happened in this Space — a dense, one-line-per-event list in
 * the header's orientation zone, beside People.
 *
 * History: the per-Space view once merged events INTO the asset grid as
 * chat-style rows and the user rejected it — "they look like Slack
 * messages vs assets" — so events were removed from Spaces entirely and
 * exiled to Home. But Home's activity cannot be scoped to a Space, so
 * "what happened here?" became unanswerable anywhere in the app. The
 * objection was to chat rows CROWDING assets, not to the information.
 *
 * So: events keep their own zone and their own shape. One muted line
 * each (author · verb · object · when) — no dots, no excerpts, no space
 * chip (we are IN the space), nothing that reads as a message. Three by
 * default so assets are never pushed down; "Show all" expands in place.
 * Same rule the People strip follows: show what fits, collapse the rest.
 */
function buildSpaceActivityStrip(): HTMLElement {
  const scopeId = state.activeScopeId;
  const wrap = document.createElement('div');
  wrap.className = 'spaces-view-header-activity';

  const label = document.createElement('span');
  label.className = 'spaces-view-header-activity-label';
  label.textContent = 'Activity';
  wrap.appendChild(label);

  const list = document.createElement('div');
  list.className = 'spaces-view-header-activity-list';
  wrap.appendChild(list);

  const events = state.spaceEventsForScopeId === scopeId ? state.spaceEvents.value : null;

  // A failed read is not an empty history — say which one it is.
  if (events === null) {
    const note = document.createElement('span');
    note.className = 'spaces-view-header-activity-note';
    note.textContent =
      state.spaceEvents.error !== null && state.spaceEventsForScopeId === scopeId
        ? "Couldn't load activity"
        : 'Loading…';
    list.appendChild(note);
    return wrap;
  }
  if (events.length === 0) {
    const note = document.createElement('span');
    note.className = 'spaces-view-header-activity-note';
    note.textContent = 'Nothing yet';
    list.appendChild(note);
    return wrap;
  }

  const expanded = expandedActivityScopes.has(scopeId);
  const shown = expanded ? events : events.slice(0, HEADER_ACTIVITY_ROWS);
  for (const e of shown) {
    const line = document.createElement('div');
    line.className = 'spaces-view-header-activity-line';
    if (looksLikeAgentAuthor(e.author)) line.classList.add('is-agent');
    const who = document.createElement('span');
    who.className = 'spaces-view-header-activity-who';
    who.textContent = prettyAuthor(e.author);
    line.appendChild(who);
    const what = document.createElement('span');
    what.className = 'spaces-view-header-activity-what';
    what.textContent = ` ${deriveVerb(e.kind)} ${deriveObject(e.kind)}`;
    line.appendChild(what);
    const when = document.createElement('span');
    when.className = 'spaces-view-header-activity-when';
    when.textContent = formatRecency(e.timestamp);
    line.appendChild(when);
    list.appendChild(line);
  }

  if (events.length > HEADER_ACTIVITY_ROWS) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'spaces-view-header-activity-toggle';
    toggle.textContent = expanded ? 'Show less' : `Show all ${events.length}`;
    toggle.addEventListener('click', () => {
      if (expanded) expandedActivityScopes.delete(scopeId);
      else expandedActivityScopes.add(scopeId);
      // Header-local swap: rebuild this strip in place rather than
      // repainting the grid (which would re-instantiate every preview).
      const next = buildSpaceActivityStrip();
      wrap.replaceWith(next);
    });
    wrap.appendChild(toggle);
  }
  return wrap;
}

function buildSpaceHeader(opts: { busy: boolean }): HTMLElement {
  const header = document.createElement('header');
  header.className = 'spaces-view-header';

  const titleWrap = document.createElement('div');
  titleWrap.className = 'spaces-view-header-title-wrap';

  const title = document.createElement('h2');
  title.className = 'spaces-view-header-title';
  if (state.activeScopeId === UNCATEGORIZED_SPACE_ID) {
    title.textContent = 'Uncategorized';
  } else {
    const space = state.spaces.find((s) => s.id === state.activeScopeId);
    title.textContent =
      space !== undefined && space.name.length > 0 ? space.name : '(unnamed Space)';
  }
  titleWrap.appendChild(title);

  // Description / "objective" row. Real Spaces get a click-to-edit
  // affordance; Uncategorized + Home get a fixed one-liner.
  if (state.activeScopeId === UNCATEGORIZED_SPACE_ID) {
    const sub = document.createElement('p');
    sub.className = 'spaces-view-header-sub';
    sub.textContent = 'Items that arrive without a Space land here for triage.';
    titleWrap.appendChild(sub);
  } else if (state.activeScopeId === HOME_SCOPE_ID) {
    // Home doesn't get a description editor — it isn't a Space.
  } else {
    const space = state.spaces.find((s) => s.id === state.activeScopeId);
    if (space !== undefined) {
      titleWrap.appendChild(buildSpaceObjectiveRow(space));
      // ADR-051: per-space visibility control + (when restricted) the
      // member management strip, on every Space kind.
      titleWrap.appendChild(buildSpaceVisibilityRow(space));
      // Who's in it, always visible (2026-08-12 UX pass).
      titleWrap.appendChild(buildSpaceMembersStrip(space));
      // What's happened in it, always visible (2026-08-19).
      titleWrap.appendChild(buildSpaceActivityStrip());
    }
  }

  header.appendChild(titleWrap);

  // Actions row -- holds search + New + Refresh. Stacked under the
  // title/description (rather than sharing one flex row with them)
  // so a long Space description never gets crushed into a single
  // narrow column by the buttons' natural width.
  const actions = document.createElement('div');
  actions.className = 'spaces-view-header-actions';

  // THE content search (2026-08-19). One box, in the wide pane where
  // results have room, with scope as a CONTROL rather than as a second
  // input somewhere else. Previously the narrow sidebar hosted the BROAD
  // cross-space search (results crammed into a tree, hidden behind a
  // collapsed section) while this wide pane hosted the narrowest one —
  // the scopes were inverted and neither box was "the" search. Home gets
  // it too now: Home is not a Space, so it simply searches everything.
  {
    const onHome = state.activeScopeId === HOME_SCOPE_ID;
    const searchWrap = document.createElement('div');
    searchWrap.className = 'spaces-items-search-wrap';

    const scopedToSpace = state.itemsSearchScope === 'space' && !onHome;
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'spaces-items-search';
    search.id = 'spaces-items-search-input';
    search.placeholder = scopedToSpace ? 'Search this space…' : 'Search all spaces…';
    search.setAttribute(
      'aria-label',
      scopedToSpace ? 'Search assets in this space' : 'Search assets in all spaces'
    );
    search.value = state.itemsSearchQuery;
    search.addEventListener('input', () => {
      onItemsSearchChange(search.value);
    });
    searchWrap.appendChild(search);

    // Scope toggle — only meaningful when there IS a space to narrow to.
    if (!onHome) {
      const scope = document.createElement('div');
      scope.className = 'spaces-items-search-scope';
      scope.setAttribute('role', 'group');
      scope.setAttribute('aria-label', 'Search scope');
      const options: ReadonlyArray<{ key: 'space' | 'all'; label: string }> = [
        { key: 'space', label: 'This space' },
        { key: 'all', label: 'All spaces' },
      ];
      for (const opt of options) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'spaces-items-search-scope-btn';
        btn.textContent = opt.label;
        const on = state.itemsSearchScope === opt.key;
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        if (on) btn.classList.add('is-on');
        btn.addEventListener('click', () => {
          if (state.itemsSearchScope === opt.key) return;
          state.itemsSearchScope = opt.key;
          // Re-run against the new scope when a query is standing —
          // the seq guard supersedes whatever the old scope had in
          // flight. Otherwise just repaint so the toggle reflects it.
          if (state.itemsSearchQuery.trim().length > 0) void runItemsSearch();
          else renderItemList({});
        });
        scope.appendChild(btn);
      }
      searchWrap.appendChild(scope);
    }
    actions.appendChild(searchWrap);
  }

  // Sprint 1: "+ New" button to open the new-asset modal. Available
  // everywhere except Home (the news-feed view doesn't have a "create
  // here" semantic — assets need a target scope).
  if (state.activeScopeId !== HOME_SCOPE_ID) {
    const newBtn = document.createElement('button');
    newBtn.type = 'button';
    newBtn.className = 'spaces-items-new';
    newBtn.title = 'Add an asset to this space';
    newBtn.setAttribute('aria-label', 'Add new asset');
    newBtn.textContent = '+ New';
    newBtn.addEventListener('click', () => openNewAssetDialog(null));
    actions.appendChild(newBtn);
  }

  // Refresh affordance (replaces the prior toolbar refresh button).
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'spaces-items-refresh';
  refresh.id = 'spaces-items-refresh';
  refresh.title = 'Refresh items + activity';
  refresh.setAttribute('aria-label', 'Refresh');
  refresh.disabled = opts.busy;
  refresh.textContent = opts.busy ? 'Refreshing…' : '↻ Refresh';
  refresh.addEventListener('click', () => {
    if (state.loadingItems) return;
    void loadItems();
  });
  actions.appendChild(refresh);

  header.appendChild(actions);

  return header;
}

/**
 * Per-Space objective row -- the description-line under the title.
 *
 * Behavior:
 *   - When the space has a description, renders it as flowing prose
 *     with a click target that swaps in an editor.
 *   - When the space has no description, renders a muted placeholder
 *     ("Add an objective for this space…") that doubles as the click
 *     target.
 *   - Editor is a `<textarea>` with Cmd/Ctrl+Enter to save, Esc to
 *     cancel; Save / Cancel buttons mirror the keyboard affordances.
 *
 * The "objective" framing matches the user-facing language used in
 * Spaces — describes the purpose of the space, edited in-place so
 * adoption follows naturally from a click.
 */
/** "Robb Wilson" -> "RW"; emails use the local part ("robb.w" -> "RW"). */
// Graph hygiene guard: entities named by a raw id (account UUIDs from
// system writers) are real nodes but meaningless picks — sort them last
// so humans always lead the list.
export const machineNamedLast = <T extends { name: string }>(entries: T[]): T[] => {
  const uuidish = (s: string): boolean =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim());
  return [...entries].sort((a, b) => Number(uuidish(a.name)) - Number(uuidish(b.name)));
};

/**
 * Display name for the header People strip. Real name when we have one,
 * else the id (which is an email under ADR-068); the @domain is trimmed
 * because a header chip has no room for it and the avatar's tooltip
 * already carries the full value.
 */
export function personShortName(member: { id: string; name: string }): string {
  const raw = (member.name.trim().length > 0 ? member.name : member.id).trim();
  const at = raw.indexOf('@');
  // A leading '@' leaves nothing to show — fall back rather than
  // rendering a bare domain as if it were somebody's name.
  const short = (at >= 0 ? raw.slice(0, at) : raw).trim();
  return short.length > 0 ? short : member.id;
}

export function personInitials(name: string): string {
  const clean = name.includes('@') ? name.split('@')[0] ?? name : name;
  const parts = clean
    .split(/[\s._-]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return (parts[0] ?? '?').slice(0, 2).toUpperCase();
  return ((parts[0]?.[0] ?? '') + (parts[parts.length - 1]?.[0] ?? '')).toUpperCase();
}

/** Deterministic avatar hue from an id — stable across paints. */
export function avatarHue(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return ((hash % 360) + 360) % 360;
}

function buildPersonAvatar(member: { id: string; name: string }, size: 'sm' | 'md'): HTMLElement {
  const el = document.createElement('span');
  el.className = `spaces-avatar spaces-avatar-${size}`;
  el.textContent = personInitials(member.name);
  el.title = member.name;
  // Only the hue is data; saturation/lightness are design decisions
  // owned by .spaces-avatar in spaces.css via --avatar-hue.
  el.style.setProperty('--avatar-hue', String(avatarHue(member.id)));
  return el;
}

/**
 * Who's in this Space, at a glance — an avatar strip on EVERY space
 * header ("needs to be more obvious who is part of it", 2026-08-12).
 * Async-populated; clicking anywhere opens the People panel.
 */
/** Show real names on the header strip up to this many people. */
const HEADER_MEMBER_NAMES_MAX = 7;

function buildSpaceMembersStrip(space: RendererSpace): HTMLElement {
  const strip = document.createElement('button');
  strip.type = 'button';
  strip.className = 'spaces-view-header-members';
  strip.title = 'People in this space — click to manage';
  strip.addEventListener('click', () => {
    void openAddMemberPrompt(space.id, async () => {
      await loadSpaces();
    });
  });
  const label = document.createElement('span');
  label.className = 'spaces-view-header-members-label';
  label.textContent = 'People';
  strip.appendChild(label);
  const holder = document.createElement('span');
  holder.className = 'spaces-view-header-members-avatars';
  strip.appendChild(holder);
  const summary = document.createElement('span');
  summary.className = 'spaces-view-header-members-summary';
  summary.textContent = '…';
  strip.appendChild(summary);

  void (async (): Promise<void> => {
    const bridge = window.lite?.spaces;
    if (bridge === undefined) return;
    try {
      const envelope = await bridge.members.list(space.id);
      if (envelope.ok !== true) {
        summary.textContent = '';
        return;
      }
      const members = envelope.value;
      holder.replaceChildren();
      // Names, not just faces (2026-08-19: "I want to see the names of
      // the people in the space without clicking unless it a large
      // number like more than 7"). A small team is the interesting case
      // and it fits — so spell it out. Past the threshold names stop
      // fitting on a header line, so fall back to stacked avatars plus a
      // count, and the People panel carries the full roster.
      const named = members.length > 0 && members.length <= HEADER_MEMBER_NAMES_MAX;
      if (named) {
        for (const member of members) {
          const person = document.createElement('span');
          person.className = 'spaces-view-header-member';
          person.appendChild(buildPersonAvatar(member, 'sm'));
          const nameEl = document.createElement('span');
          nameEl.className = 'spaces-view-header-member-name';
          nameEl.textContent = personShortName(member);
          person.appendChild(nameEl);
          holder.appendChild(person);
        }
      } else {
        for (const member of members.slice(0, 8)) {
          holder.appendChild(buildPersonAvatar(member, 'sm'));
        }
        if (members.length > 8) {
          const more = document.createElement('span');
          more.className = 'spaces-avatar spaces-avatar-sm spaces-avatar-more';
          more.textContent = `+${members.length - 8}`;
          holder.appendChild(more);
        }
      }
      // With names on screen the count is noise; keep it only when the
      // roster is collapsed to faces (or empty).
      summary.textContent = named
        ? ''
        : members.length === 0
          ? 'Nobody yet — add people'
          : `${members.length} ${members.length === 1 ? 'person' : 'people'}`;
    } catch {
      summary.textContent = '';
    }
  })();
  return strip;
}

// One-shot latch: "open the objective editor as soon as this space's
// header renders." Set by the context menu (which may navigate first),
// consumed by buildSpaceObjectiveRow on mount. Exported for tests.
export const pendingObjectiveEdit: { spaceId: string | null } = { spaceId: null };
export function requestObjectiveEdit(spaceId: string): void {
  pendingObjectiveEdit.spaceId = spaceId;
}
export function consumeObjectiveEdit(spaceId: string): boolean {
  if (pendingObjectiveEdit.spaceId !== spaceId) return false;
  pendingObjectiveEdit.spaceId = null;
  return true;
}

function buildSpaceObjectiveRow(space: RendererSpace): HTMLElement {
  const sub = document.createElement('p');
  sub.className = 'spaces-view-header-sub';
  sub.setAttribute('data-space-id', space.id);

  const hasDescription =
    typeof space.description === 'string' && space.description.length > 0;
  if (hasDescription) {
    sub.textContent = space.description ?? '';
    sub.title = 'Click to edit the objective for this space';
    // Visible affordance: a pencil chip that fades in on hover/focus —
    // "click to edit" must be discoverable, not tooltip-only lore.
    const editChip = document.createElement('span');
    editChip.className = 'spaces-view-header-sub-edit';
    editChip.textContent = '✎ Edit';
    editChip.setAttribute('aria-hidden', 'true');
    sub.appendChild(editChip);
  } else {
    sub.textContent = 'Add an objective for this space…';
    sub.classList.add('spaces-view-header-sub-placeholder');
    sub.title = 'Click to add an objective for this space';
  }

  if (consumeObjectiveEdit(space.id)) {
    // Deferred one tick so the row is appended before the editor swaps in.
    queueMicrotask(() => enterSpaceObjectiveEdit(sub, space));
  }

  // Keyboard path: the row is a click target, so it must be focusable
  // and Enter/Space must work — the global focus ring then applies.
  sub.tabIndex = 0;
  sub.setAttribute('role', 'button');
  sub.addEventListener('click', () => {
    enterSpaceObjectiveEdit(sub, space);
  });
  sub.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      enterSpaceObjectiveEdit(sub, space);
    }
  });

  return sub;
}

/**
 * Swap the rendered description for an inline textarea editor. Anchored
 * on the existing `<p>` so the layout doesn't shift on enter/exit.
 */
function enterSpaceObjectiveEdit(
  anchor: HTMLElement,
  space: RendererSpace
): void {
  if (!anchor.isConnected) return;

  const original = anchor.textContent ?? '';
  const startingValue =
    typeof space.description === 'string' ? space.description : '';

  const editor = document.createElement('div');
  editor.className = 'spaces-view-header-objective-editor';
  editor.setAttribute('data-space-id', space.id);

  const textarea = document.createElement('textarea');
  textarea.className = 'spaces-view-header-objective-input';
  textarea.value = startingValue;
  textarea.placeholder =
    'What is this space for? (e.g. "Weekly UX research findings for the redesign.")';
  // Room for a real pasted brief, not two cramped lines.
  textarea.rows = 5;
  // NO maxLength attribute: it silently truncated large pastes
  // mid-sentence, which read as "it won't let me edit it" (2026-08-12
  // bug report). Over-limit text stays intact in the editor; the live
  // counter + the commit guard below give honest feedback instead.
  textarea.spellcheck = true;
  editor.appendChild(textarea);

  const counter = document.createElement('span');
  counter.className = 'spaces-view-header-objective-counter';
  const renderCount = (): void => {
    const len = textarea.value.trim().length;
    counter.textContent = `${len.toLocaleString()} / ${SPACE_OBJECTIVE_MAX.toLocaleString()}`;
    counter.classList.toggle('is-over', len > SPACE_OBJECTIVE_MAX);
  };
  renderCount();
  textarea.addEventListener('input', renderCount);

  const actions = document.createElement('div');
  actions.className = 'spaces-view-header-objective-actions';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'spaces-view-header-objective-save';
  saveBtn.textContent = 'Save';
  actions.appendChild(saveBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'spaces-view-header-objective-cancel';
  cancelBtn.textContent = 'Cancel';
  actions.appendChild(cancelBtn);

  const hint = document.createElement('span');
  hint.className = 'spaces-view-header-objective-hint';
  hint.textContent = '⌘↵ Save · Esc Cancel';
  actions.appendChild(hint);
  actions.appendChild(counter);

  editor.appendChild(actions);

  anchor.replaceWith(editor);
  // Defer focus until after the DOM swap so cursors land predictably.
  textarea.focus();
  textarea.select();

  let didSettle = false;

  const restorePlain = (description: string): void => {
    if (didSettle) return;
    didSettle = true;
    const restored = buildSpaceObjectiveRow({
      ...space,
      description,
    });
    if (editor.isConnected) {
      editor.replaceWith(restored);
    }
  };

  const cancelEdit = (): void => {
    restorePlain(startingValue);
    // Restore original text rendering (handles the empty-state path).
    void original;
  };

  const commit = async (): Promise<void> => {
    if (didSettle) return;
    const next = textarea.value.trim();
    if (next === startingValue.trim()) {
      cancelEdit();
      return;
    }
    if (next.length > SPACE_OBJECTIVE_MAX) {
      showToast(
        `Objective is too long (${next.length.toLocaleString()} chars; max ${SPACE_OBJECTIVE_MAX.toLocaleString()}). Your text is untouched — trim and save again.`
      );
      return;
    }
    const bridge = window.lite?.spaces;
    if (bridge === undefined) {
      showToast('Bridge unavailable.');
      cancelEdit();
      return;
    }
    textarea.disabled = true;
    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const envelope = await bridge.updateSpace(space.id, {
        description: next,
      });
      if (envelope.ok === false) {
        showToast(envelope.error.message);
        textarea.disabled = false;
        saveBtn.disabled = false;
        cancelBtn.disabled = false;
        saveBtn.textContent = 'Save';
        return;
      }
      // Mutation already nuked the read cache server-side; pull a fresh
      // listSpaces so any other affordance (sidebar / row metadata)
      // sees the new value too.
      await loadSpaces();
      restorePlain(envelope.value.description ?? next);
      showToast('Objective updated.');
    } catch (err) {
      window.logging?.error?.('spaces', 'space objective save failed', { error: messageFrom(err) });
      showToast(messageFrom(err));
      textarea.disabled = false;
      saveBtn.disabled = false;
      cancelBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  };

  saveBtn.addEventListener('click', () => {
    void commit();
  });
  cancelBtn.addEventListener('click', () => {
    cancelEdit();
  });
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void commit();
    }
  });
}

interface ItemsToolbarOpts {
  busy: boolean;
}

export function buildItemsToolbar(opts: ItemsToolbarOpts): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'spaces-items-toolbar';

  const summary = document.createElement('span');
  summary.className = 'spaces-items-summary';
  // Caller renders before items are guaranteed in state; safe to read.
  summary.textContent =
    state.items.length === 0
      ? ''
      : `${state.items.length} item${state.items.length === 1 ? '' : 's'}`;
  bar.appendChild(summary);

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'spaces-items-refresh';
  refreshBtn.id = 'spaces-items-refresh';
  refreshBtn.title = 'Refresh items for this Space';
  refreshBtn.setAttribute('aria-label', 'Refresh items');
  refreshBtn.disabled = opts.busy;
  // The two-state label keeps the affordance obvious while a fetch
  // is in flight; the icon character is a clockwise circular arrow.
  refreshBtn.textContent = opts.busy ? 'Refreshing…' : '↻ Refresh';
  refreshBtn.addEventListener('click', () => {
    if (state.loadingItems) return;
    void loadItems();
  });
  bar.appendChild(refreshBtn);

  return bar;
}

function ensureItemsRegion(main: HTMLElement): HTMLElement {
  let region = document.getElementById('spaces-items-region');
  if (region === null) {
    region = document.createElement('section');
    region.id = 'spaces-items-region';
    region.className = 'spaces-items-region';
    // Insert before the discovery section if present; otherwise append.
    const discovery = document.getElementById('spaces-discovery');
    if (discovery !== null) main.insertBefore(region, discovery);
    else main.appendChild(region);
  }
  // Phase 1+: collapse the Phase 0 empty-state hero. The empty-items
  // state below covers the "no items" condition explicitly.
  const phase0Empty = main.querySelector('.spaces-empty-state');
  if (phase0Empty !== null) phase0Empty.remove();
  return region;
}

// ─── Bulk-select toolbar ────────────────────────────────────────────────
//
// Selection is opt-in via Cmd/Ctrl-click on a timeline row. Once one or
// more rows are selected, the toolbar slides in above the timeline with:
//   - selection summary: "N items selected"
//   - Move to … (select)
//   - Delete (button) — confirms via native dialog, runs delete in
//     parallel with the same soft-delete defaults as single delete
//   - Clear (button) — drops the selection without acting on anything
//
// Implementation is intentionally minimal: each bulk action loops over
// the selected ids and calls the existing single-item bridge methods,
// then reloads the items list once. We don't introduce a bulk RPC at
// the SDK layer yet — the per-item methods are cheap and the parallel
// fan-out keeps the UI snappy without complicating the platform.

/**
 * Render the bulk-select toolbar when one or more items are selected.
 * Returns `null` when the selection is empty so callers can short-circuit.
 *
 * Reads from `state.selectedItemIds`. Each action drops back through
 * `loadItems()` so the timeline re-paints from the freshly-fetched
 * server state and the selection clears.
 */
export function buildBulkSelectToolbar(): HTMLElement | null {
  if (state.selectedItemIds.size === 0) return null;

  const bar = document.createElement('div');
  bar.className = 'spaces-bulk-toolbar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Bulk actions');

  const count = state.selectedItemIds.size;
  const summary = document.createElement('span');
  summary.className = 'spaces-bulk-summary';
  summary.textContent = `${count} selected`;
  bar.appendChild(summary);

  // ── Move to <space> ────────────────────────────────────────────────
  const moveWrap = document.createElement('span');
  moveWrap.className = 'spaces-bulk-action-wrap';
  const moveLabel = document.createElement('label');
  moveLabel.className = 'spaces-bulk-action-label';
  moveLabel.textContent = 'Move to';
  moveWrap.appendChild(moveLabel);

  const moveSelect = document.createElement('select');
  moveSelect.className = 'spaces-bulk-move-select';
  moveSelect.setAttribute('aria-label', `Move ${count} items to a space`);
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Choose a space…';
  placeholder.selected = true;
  moveSelect.appendChild(placeholder);
  const fromSpaceId =
    state.activeScopeId !== HOME_SCOPE_ID &&
    state.activeScopeId !== UNCATEGORIZED_SPACE_ID
      ? state.activeScopeId
      : null;
  for (const space of state.spaces) {
    if (space.id === fromSpaceId) continue;
    const opt = document.createElement('option');
    opt.value = space.id;
    opt.textContent = space.name.length > 0 ? space.name : '(unnamed)';
    if (space.kind === 'shared') opt.textContent += ' (shared)';
    moveSelect.appendChild(opt);
  }
  moveSelect.addEventListener('change', () => {
    const target = moveSelect.value;
    if (target.length === 0) return;
    moveSelect.disabled = true;
    void performBulkMove(target, fromSpaceId, moveSelect);
  });
  moveWrap.appendChild(moveSelect);
  bar.appendChild(moveWrap);

  // ── Delete N ──────────────────────────────────────────────────────
  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'spaces-bulk-delete';
  deleteBtn.textContent = `Delete ${count}`;
  deleteBtn.title = `Soft-delete ${count} item${count === 1 ? '' : 's'}`;
  deleteBtn.addEventListener('click', () => {
    void performBulkDelete(deleteBtn);
  });
  bar.appendChild(deleteBtn);

  // ── Clear ─────────────────────────────────────────────────────────
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'spaces-bulk-clear';
  clearBtn.textContent = 'Clear';
  clearBtn.title = 'Clear selection (Esc)';
  clearBtn.addEventListener('click', () => {
    clearBulkSelection();
  });
  bar.appendChild(clearBtn);

  return bar;
}

/**
 * Toggle the row's selection state. Idempotent. Re-renders the items
 * region so the toolbar updates and the row shows its selected styling.
 */
function toggleBulkSelection(itemId: string): void {
  if (state.selectedItemIds.has(itemId)) {
    state.selectedItemIds.delete(itemId);
  } else {
    state.selectedItemIds.add(itemId);
  }
  renderItemList({});
}

function clearBulkSelection(): void {
  if (state.selectedItemIds.size === 0) return;
  state.selectedItemIds.clear();
  renderItemList({});
}

async function performBulkMove(
  toSpaceId: string,
  fromSpaceId: string | null,
  selectEl: HTMLSelectElement
): Promise<void> {
  const bridge = window.lite?.spaces;
  if (bridge === undefined) {
    showToast('Bridge unavailable.');
    selectEl.disabled = false;
    return;
  }
  const ids = Array.from(state.selectedItemIds);
  // Union-rule guardrail: bulk move can expose MANY restricted assets
  // in one change event, so confirm before any write happens.
  const exposed = ids.filter((id) => {
    const space = state.spaces.find((s) => s.id === toSpaceId);
    return (
      space !== undefined &&
      wouldExposeRestrictedItem(currentSpaceIdsFor(id), space, state.spaces)
    );
  });
  if (exposed.length > 0) {
    const target = state.spaces.find((s) => s.id === toSpaceId);
    const ok = await askToConfirm(
      'Make these visible to everyone?',
      `${exposed.length} of ${ids.length} selected ${exposed.length === 1 ? 'item is' : 'items are'} ` +
        `in members-only Spaces. Moving ${exposed.length === 1 ? 'it' : 'them'} to ` +
        `"${target?.name ?? toSpaceId}" makes ${exposed.length === 1 ? 'it' : 'them'} ` +
        `visible to everyone in the account.`,
      'Move anyway'
    );
    if (!ok) {
      selectEl.value = '';
      selectEl.disabled = false;
      return;
    }
  }
  let succeeded = 0;
  const failures: string[] = [];
  // Run in parallel — the per-item Cypher writes are independent.
  await Promise.all(
    ids.map(async (id) => {
      try {
        const envelope = await bridge.items.moveToSpace(id, fromSpaceId, toSpaceId);
        if (envelope.ok === false) {
          failures.push(envelope.error.message);
        } else {
          succeeded += 1;
        }
      } catch (err) {
        window.logging?.error?.('spaces', 'bulk move item failed', { error: messageFrom(err) });
        failures.push(messageFrom(err));
      }
    })
  );
  state.selectedItemIds.clear();
  await loadItems();
  if (failures.length === 0) {
    showToast(`Moved ${succeeded} item${succeeded === 1 ? '' : 's'}.`);
  } else if (succeeded > 0) {
    showToast(
      `Moved ${succeeded} of ${ids.length}; ${failures.length} failed (${failures[0]}).`
    );
  } else {
    showToast(`Move failed: ${failures[0] ?? 'unknown error'}`);
  }
}

async function performBulkDelete(btn: HTMLButtonElement): Promise<void> {
  const ids = Array.from(state.selectedItemIds);
  const count = ids.length;
  // Native confirm keeps the surface area small; a future iteration
  // could swap in a custom modal with an undo countdown.
  const ok = window.confirm(
    `Delete ${count} item${count === 1 ? '' : 's'}?\n\n` +
      'They will be soft-deleted (hidden from listings) and can be restored from the asset menu.'
  );
  if (!ok) return;
  const bridge = window.lite?.spaces;
  if (bridge === undefined) {
    showToast('Bridge unavailable.');
    return;
  }
  btn.disabled = true;
  let succeeded = 0;
  const failures: string[] = [];
  await Promise.all(
    ids.map(async (id) => {
      try {
        const envelope = await bridge.items.delete(id, { soft: true });
        if (envelope.ok === false) {
          failures.push(envelope.error.message);
        } else {
          succeeded += 1;
        }
      } catch (err) {
        window.logging?.error?.('spaces', 'bulk delete item failed', { error: messageFrom(err) });
        failures.push(messageFrom(err));
      }
    })
  );
  state.selectedItemIds.clear();
  await loadItems();
  if (failures.length === 0) {
    showToast(`Deleted ${succeeded} item${succeeded === 1 ? '' : 's'}.`);
  } else if (succeeded > 0) {
    showToast(
      `Deleted ${succeeded} of ${ids.length}; ${failures.length} failed (${failures[0]}).`
    );
  } else {
    showToast(`Delete failed: ${failures[0] ?? 'unknown error'}`);
  }
}

// `wireCardClicks` removed when the per-Space view switched from the
// card grid to the timeline (timeline rows wire their own clicks via
// `buildTimelineRow`). `applyActiveCard` survives because the close-
// detail-rail path still calls it through the legacy ID-grid
// selector — harmless and idempotent.

/**
 * Explorer-selection → tile focus id awaiting the next grid paint.
 * Set when the sidebar selects an asset whose Space isn't painted yet
 * (scope switch = async fetch); consumed by renderItemList.
 */
let pendingTileFocusId: string | null = null;

/**
 * Focus an asset's TILE in the middle grid: move the is-active class
 * and scroll the card into view. Pure DOM — deliberately not a grid
 * rebuild, so it composes with the unchanged-refresh guard (which
 * skips repaints when data didn't change; selecting an asset in the
 * SAME Space must still move the highlight — found live 2026-08-08:
 * "when I select an asset in the left menu it does not focus it in
 * the tile middle menu"). Returns true when the tile existed.
 */
export function focusItemTile(itemId: string): boolean {
  const region = document.getElementById('spaces-items-region');
  if (region === null) return false;
  let found: HTMLElement | null = null;
  for (const card of Array.from(region.querySelectorAll<HTMLElement>('.spaces-card'))) {
    const isTarget = card.getAttribute('data-item-id') === itemId;
    card.classList.toggle('is-active', isTarget);
    if (isTarget) found = card;
  }
  if (found === null) return false;
  try {
    found.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } catch {
    /* jsdom / detached — the class toggle already happened */
  }
  return true;
}

function applyActiveCard(grid: HTMLElement, itemId: string | null): void {
  for (const card of Array.from(grid.querySelectorAll<HTMLElement>('.spaces-card'))) {
    const id = card.getAttribute('data-item-id');
    card.classList.toggle('is-active', id === itemId && itemId !== null);
  }
}

/**
 * Build an asset tile — content-forward, NOT chat-row-shaped.
 *
 * The tile is two stacked regions:
 *
 *   ┌─────────────────────────┐
 *   │   [content-shaped       │  ← spaces-card-preview
 *   │      preview surface]   │     (image / paper / waveform / etc.)
 *   ├─────────────────────────┤
 *   │ Title …          ✎       │  ← spaces-card-meta
 *   │ Doc · 3h ago             │     (kind label + relative time)
 *   └─────────────────────────┘
 *
 * The preview region is what makes the asset *look like the asset it
 * is*: an image tile shows the actual thumbnail, a doc shows the
 * excerpt as typeset paragraph text (paper-style), audio shows a
 * waveform glyph, a URL shows the host. No "Produced by …" line, no
 * Space chips, no kind pill above the title — those were the parts
 * that made every asset read like a chat message.
 *
 * Class names `spaces-card`, `spaces-card-title`, `spaces-card-kind`,
 * `spaces-card-time`, `spaces-card-excerpt`, `spaces-card-kind-<kind>`,
 * `is-active`, and the `data-item-id` attribute are preserved so the
 * existing wiring + tests still find the right hooks.
 */
// ─── Service pulse: the calm outage banner (2026-08-17) ───────────────
// An outage used to paint every pane red at once. The contract now:
// panes keep last-good content (the cache serves stale), ONE amber
// banner explains, errors hush while degraded, and recovery heals
// silently (+refresh). The pulse arrives from main (the KV circuit
// breaker is the producer) over lite:health:pulse.

export interface RendererServicePulse {
  status: 'ok' | 'degraded';
  services: Array<{ service: string; reason: string; downSinceMs: number }>;
  degradedSinceMs: number | null;
}

let servicePulseDegraded = false;

/** True while the backend is having a moment — error paths soften. */
export function isServiceDegraded(): boolean {
  return servicePulseDegraded;
}

/** @internal test seam */
export function _setServiceDegradedForTesting(v: boolean): void {
  servicePulseDegraded = v;
}

/**
 * The one calm banner. Amber, not red; explains what the user sees
 * (recent data), what the app is doing (retrying), and offers a quiet
 * "Report issue" that opens the feedback modal prefilled with context.
 */
export function buildServicePulseBanner(
  pulse: RendererServicePulse,
  onReport?: () => void
): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'spaces-pulse-banner';
  bar.setAttribute('role', 'status');

  const dot = document.createElement('span');
  dot.className = 'spaces-pulse-dot';
  bar.appendChild(dot);

  const text = document.createElement('span');
  text.className = 'spaces-pulse-text';
  const since =
    pulse.degradedSinceMs !== null ? formatRelativeTime(new Date(pulse.degradedSinceMs).toISOString()) : '';
  text.textContent =
    `OneReach is having a moment${since.length > 0 ? ` (since ${since})` : ''} — ` +
    'showing recent data, retrying automatically.';
  bar.appendChild(text);

  const report = document.createElement('button');
  report.type = 'button';
  report.className = 'spaces-pulse-report';
  report.textContent = 'Report issue';
  report.addEventListener('click', () => {
    if (onReport !== undefined) {
      onReport();
      return;
    }
    const reasons = pulse.services.map((sv) => `${sv.service}: ${sv.reason}`).join('; ');
    void window.lite?.bugReport?.open?.(
      `[outage] Service degraded${since.length > 0 ? ` since ${since}` : ''} — ${reasons}. ` +
        'What I was doing when I hit it: '
    );
  });
  bar.appendChild(report);
  return bar;
}

/** Start of the current/most-recent degraded episode (for toast gating). */
let lastDegradedSinceMs: number | null = null;

/** Mount/unmount the banner + drive the degraded flag. Called at init. */
function attachServicePulse(): void {
  const health = window.lite?.health;
  if (health === undefined || typeof health.onPulse !== 'function') return;
  const apply = (raw: unknown): void => {
    const pulse = raw as RendererServicePulse;
    const wasDegraded = servicePulseDegraded;
    servicePulseDegraded = pulse.status === 'degraded';
    document.getElementById('spaces-pulse-banner-host')?.remove();
    if (servicePulseDegraded) {
      const host = document.createElement('div');
      host.id = 'spaces-pulse-banner-host';
      host.appendChild(buildServicePulseBanner(pulse));
      document.body.appendChild(host);
    } else if (wasDegraded) {
      // Recovery: refresh quietly. The toast only fires after an
      // outage a user actually noticed (≥60s) — flap cycles used to
      // announce "Back online" every few minutes on a lossy network.
      const downFor =
        typeof lastDegradedSinceMs === 'number' ? Date.now() - lastDegradedSinceMs : 0;
      if (downFor >= 60_000) showToast('Back online — refreshing');
      void loadSpaces();
    }
    lastDegradedSinceMs =
      pulse.status === 'degraded' && typeof pulse.degradedSinceMs === 'number'
        ? pulse.degradedSinceMs
        : lastDegradedSinceMs;
  };
  health.onPulse(apply);
  void health.getPulse?.().then((p: unknown) => apply(p)).catch(() => undefined);
}

// ─── ADR-072: journey maps (Planning) ──────────────────────────────────
//
// Ported from the main app's WISER discovery template, where journeys
// lived in an in-memory Map that never persisted. Here the composer
// drafts with AI, shows the map BEFORE anything is written, and saves
// it as an ordinary `journey` asset — so the existing journey tile,
// version history, download and the view audit all apply unchanged.

interface RendererJourneyDraft {
  title: string;
  journey: string;
  phases: Array<{
    name: string;
    touchpoints: Array<{
      action: string;
      emotion: string;
      thought: string;
      agentOpportunity: string;
      delegationConfidence: string;
    }>;
  }>;
}

/**
 * Read-only preview of a drafted journey: phases as a numbered spine,
 * each touchpoint showing the moment, the feeling, and the agent
 * hand-off with its confidence. Pure — no bridge calls.
 */
export function buildJourneyPreview(draft: RendererJourneyDraft): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'spaces-journey-preview';

  if (draft.journey.length > 0) {
    const sub = document.createElement('p');
    sub.className = 'spaces-journey-preview-sub';
    sub.textContent = draft.journey;
    wrap.appendChild(sub);
  }

  draft.phases.forEach((phase, i) => {
    const sec = document.createElement('section');
    sec.className = 'spaces-journey-phase';
    const h = document.createElement('div');
    h.className = 'spaces-journey-phase-name';
    h.textContent = `${i + 1}. ${phase.name}`;
    sec.appendChild(h);
    for (const tp of phase.touchpoints) {
      const row = document.createElement('div');
      row.className = 'spaces-journey-touchpoint';
      const act = document.createElement('div');
      act.className = 'spaces-journey-action';
      act.textContent = tp.action;
      row.appendChild(act);
      if (tp.emotion.length > 0 || tp.thought.length > 0) {
        const feel = document.createElement('div');
        feel.className = 'spaces-journey-feel';
        const bits: string[] = [];
        if (tp.emotion.length > 0) bits.push(tp.emotion);
        if (tp.thought.length > 0) bits.push(`\u201C${tp.thought}\u201D`);
        feel.textContent = bits.join(' · ');
        row.appendChild(feel);
      }
      if (tp.agentOpportunity.length > 0) {
        const agent = document.createElement('div');
        agent.className = 'spaces-journey-agent';
        const chip = document.createElement('span');
        chip.className = `spaces-journey-confidence conf-${tp.delegationConfidence.toLowerCase()}`;
        chip.textContent = tp.delegationConfidence;
        agent.appendChild(chip);
        const text = document.createElement('span');
        text.textContent = tp.agentOpportunity;
        agent.appendChild(text);
        row.appendChild(agent);
      }
      sec.appendChild(row);
    }
    wrap.appendChild(sec);
  });
  return wrap;
}

/**
 * The Journey map composer. Asks what journey to map, drafts it,
 * previews it, and (on Save) writes it into a Space as an ordinary
 * `journey` asset.
 *
 * `targetSpaceId` names the Space explicitly — the right-click entry
 * passes the Space that was clicked, which is not always the active
 * scope. Omitted (the Planning menu) it falls back to the active one.
 */
export async function openJourneyComposer(targetSpaceId?: string): Promise<void> {
  const bridge = window.lite?.spaces;
  const journeys = bridge?.journeys;
  if (bridge === undefined || journeys === undefined) {
    showToast('Journey maps need a newer app build');
    return;
  }
  const spaceId = targetSpaceId ?? state.activeScopeId;
  const space = state.spaces.find((sp) => sp.id === spaceId);
  if (space === undefined) {
    showToast('Open a Space first — the journey map is saved into it');
    return;
  }
  const subject = await askForText(
    'New journey map',
    'Whose journey, doing what? e.g. "a new admin setting up their first agent"'
  );
  if (subject === null || subject.trim().length === 0) return;

  showToast('Mapping the journey…');
  let draft: RendererJourneyDraft;
  try {
    const envelope = await journeys.draft(subject.trim());
    if (envelope.ok !== true) {
      showToast(envelope.error.message);
      return;
    }
    draft = envelope.value as RendererJourneyDraft;
  } catch (err) {
    showToast(messageFrom(err));
    return;
  }

  const ok = await askToConfirm(
    draft.title,
    `${draft.phases.length} phases · ` +
      `${draft.phases.reduce((n, p) => n + p.touchpoints.length, 0)} touchpoints. ` +
      `Save to "${space.name}"?`,
    'Save',
    buildJourneyPreview(draft)
  );
  if (!ok) return;

  try {
    const envelope = await journeys.create(spaceId, draft);
    if (envelope.ok !== true) {
      showToast(envelope.error.message);
      return;
    }
    showToast(`Saved "${draft.title}"`);
    await loadItems();
  } catch (err) {
    showToast(messageFrom(err));
  }
}

// ─── Recency organization (2026-08-11) ─────────────────────────────────
// "Subtle organize by last edit time": the grid is already served
// newest-edit-first; these helpers make that order LEGIBLE — thin
// full-width rules where the recency band changes (Today / Yesterday /
// This week / This month / Older), and an explicit "edited … · read …"
// line on each card. Rules render only when the grid spans 2+ bands,
// so a uniformly-fresh Space stays clean.

/** The card's organizing instant: last edit, falling back to creation. */
export function itemLastEditMs(item: {
  updatedAt?: string;
  createdAt?: string;
}): number | null {
  return (
    parseTimestamp(item.updatedAt ?? '') ?? parseTimestamp(item.createdAt ?? '')
  );
}

/** Calendar-local recency band for a timestamp. */
export function recencyBucketLabel(tsMs: number | null, nowMs: number): string {
  if (tsMs === null) return 'Older';
  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (tsMs >= startOfToday) return 'Today';
  if (tsMs >= startOfToday - 86_400_000) return 'Yesterday';
  if (tsMs >= startOfToday - 6 * 86_400_000) return 'This week';
  if (tsMs >= startOfToday - 29 * 86_400_000) return 'This month';
  return 'Older';
}

/**
 * Plan the divider rows for a recency-sorted item list: one entry per
 * band CHANGE (including index 0), or NONE when everything falls in a
 * single band. Pure — the grid loop consumes it.
 */
export function planRecencyRules(
  items: ReadonlyArray<{ updatedAt?: string; createdAt?: string }>,
  nowMs: number
): Array<{ index: number; label: string }> {
  const rules: Array<{ index: number; label: string }> = [];
  let prev: string | null = null;
  items.forEach((item, index) => {
    const label = recencyBucketLabel(itemLastEditMs(item), nowMs);
    if (label !== prev) {
      rules.push({ index, label });
      prev = label;
    }
  });
  return rules.length > 1 ? rules : [];
}

/** ms-epoch variant of formatRelativeTime. */
function formatRelativeMs(ms: number): string {
  return formatRelativeTime(new Date(ms).toISOString());
}

export function buildItemCard(
  item: RendererItemSummary,
  active: boolean
): HTMLElement {
  const card = document.createElement('article');
  card.className = `spaces-card spaces-card-${item.kind}`;
  if (active) card.classList.add('is-active');
  // Bulk-select visual: mirror the selection set so the toolbar's
  // selected items read as selected tiles (Cmd/Ctrl-click toggles).
  if (state.selectedItemIds.has(item.id)) card.classList.add('is-selected');
  card.setAttribute('data-item-id', item.id);
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');
  // Playbooks open in the instrument: double-click jumps straight into
  // WISER Playbooks (deep-linked when the asset knows its riff id).
  // Single click keeps the detail-pane behavior below.
  if (item.kind === 'playbook') {
    card.addEventListener('dblclick', () => {
      void openPlaybookInWiser(item.id);
    });
  }
  // Accessible name folds in the badge meaning, since the badges
  // themselves live inside the aria-hidden preview.
  const isNew = isNewSinceLastVisit(item);
  const byAgent = item.producedBy?.kind === 'Agent';
  card.setAttribute(
    'aria-label',
    generateItemTitle(item) +
      (isNew ? ', new' : '') +
      (byAgent ? `, produced by ${item.producedBy?.name ?? 'an agent'}` : '')
  );
  // Mouse-over: surface the asset's objective / AI summary / tags from
  // its metadata without opening the detail pane.
  const hover = buildTileHoverText(item);
  if (hover !== null) card.title = hover;

  // Click → open the detail pane. Cmd/Ctrl-click → toggle bulk
  // selection without opening the pane (parity with the former
  // timeline-row behavior). Keyboard: Enter / Space opens the pane,
  // since the tile is role="button". Without this wiring the tile
  // would be inert — `buildItemCard` is a pure builder and there is
  // no delegated click handler on the grid/region.
  card.addEventListener('click', (ev) => {
    if (ev.metaKey || ev.ctrlKey) {
      ev.preventDefault();
      toggleBulkSelection(item.id);
      return;
    }
    void loadItemDetail(item.id);
  });
  card.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      void loadItemDetail(item.id);
    }
  });

  // Top: content-shaped preview. Decorative; the title below carries
  // the accessible label, so the preview is aria-hidden. Status badges
  // (New / AI) overlay the preview's top-left corner.
  const preview = buildAssetTilePreview(item);
  const badges = buildTileBadgeStack(isNew, byAgent);
  if (badges !== null) {
    // `has-badges` lets text/doc/ticket previews reserve top padding so
    // the badge row doesn't cover the first line of the excerpt.
    preview.classList.add('has-badges');
    preview.appendChild(badges);
  }
  card.appendChild(preview);

  // Bottom: title + tight meta line.
  const meta = document.createElement('div');
  meta.className = 'spaces-card-meta';

  const titleRow = document.createElement('div');
  titleRow.className = 'spaces-card-title-row';

  const title = document.createElement('h3');
  title.className = 'spaces-card-title';
  // generateItemTitle returns the real title when it's a normal human
  // string, or a derived one ("Image · 5b4375", "sunset · example.com",
  // …) when the title was missing or hash-shaped. Never empty.
  title.textContent = generateItemTitle(item);
  titleRow.appendChild(title);

  // Hover-reveal pencil. Click opens the detail pane (which has the
  // inline title editor) — the pencil is a visual cue that the title
  // is editable, not a separate action target.
  const editHint = document.createElement('span');
  editHint.className = 'spaces-card-edit-hint';
  editHint.setAttribute('aria-hidden', 'true');
  editHint.textContent = '✎';
  titleRow.appendChild(editHint);

  meta.appendChild(titleRow);

  const metaRow = document.createElement('div');
  metaRow.className = 'spaces-card-meta-row';

  const kind = document.createElement('span');
  kind.className = `spaces-card-kind spaces-card-kind-${item.kind}`;
  kind.textContent = kindLabel(item.kind);
  metaRow.appendChild(kind);

  const dot = document.createElement('span');
  dot.className = 'spaces-card-meta-sep';
  dot.setAttribute('aria-hidden', 'true');
  dot.textContent = '·';
  metaRow.appendChild(dot);

  const time = document.createElement('span');
  time.className = 'spaces-card-time';
  // Label the instant so it reads unambiguously: "edited 2h ago"
  // (or "created" when it has never been edited since creation), and
  // — when the viewer has opened this asset — "· read 5m ago" from
  // their own VIEWED audit edge. Hover carries the absolute time.
  const neverEdited =
    item.updatedAt === item.createdAt || item.updatedAt === undefined || item.updatedAt === '';
  const editStamp = neverEdited ? item.createdAt : item.updatedAt;
  time.textContent = `${neverEdited ? 'created' : 'edited'} ${formatRelativeTime(editStamp)}`;
  {
    const abs = parseTimestamp(editStamp ?? '');
    if (abs !== null) time.title = new Date(abs).toLocaleString();
  }
  metaRow.appendChild(time);
  if (typeof item.viewedAtMs === 'number' && item.viewedAtMs > 0) {
    const sepR = document.createElement('span');
    sepR.className = 'spaces-card-meta-sep';
    sepR.setAttribute('aria-hidden', 'true');
    sepR.textContent = '·';
    metaRow.appendChild(sepR);
    const read = document.createElement('span');
    read.className = 'spaces-card-time spaces-card-read';
    read.textContent = `read ${formatRelativeMs(item.viewedAtMs)}`;
    read.title = new Date(item.viewedAtMs).toLocaleString();
    metaRow.appendChild(read);
  }

  // Multi-space indicator: signals an asset filed in more than the
  // current Space. Quiet "⧉ N" with the space names in the tooltip.
  if (item.otherSpaces.length > 0) {
    const sep2 = document.createElement('span');
    sep2.className = 'spaces-card-meta-sep';
    sep2.setAttribute('aria-hidden', 'true');
    sep2.textContent = '·';
    metaRow.appendChild(sep2);

    const spaces = document.createElement('span');
    spaces.className = 'spaces-card-spaces';
    spaces.textContent = `⧉ ${item.otherSpaces.length}`;
    const names = item.otherSpaces
      .map((s) => friendlySpaceName(s.name))
      .join(', ');
    spaces.title = `Also in: ${names}`;
    spaces.setAttribute(
      'aria-label',
      `also in ${item.otherSpaces.length} other space${item.otherSpaces.length === 1 ? '' : 's'}`
    );
    metaRow.appendChild(spaces);
  }

  meta.appendChild(metaRow);

  // Public / expiring pills. A file being world-readable must be
  // visible at a glance in the grid, not only after opening the item.
  const sharingBadges = buildSharingBadges(item as { metadata?: Record<string, unknown> });
  if (sharingBadges !== null) {
    const row = document.createElement('div');
    row.className = 'spaces-card-share-row';
    row.appendChild(sharingBadges);
    meta.appendChild(row);
  }

  card.appendChild(meta);

  return card;
}

/**
 * Compose the tile mouse-over from the asset's metadata: the
 * user-authored `objective` (or AI's), the AI summary, the
 * description, and up to 6 tags. Returns null when there's nothing —
 * no title attribute gets set, so no empty tooltip. Exported for tests.
 */
export function buildTileHoverText(item: RendererItemSummary): string | null {
  const meta = (item.metadata ?? {}) as Record<string, unknown>;
  const pick = (k: string): string | null => {
    const v = meta[k];
    return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
  };
  const lines: string[] = [];
  const objective = pick('objective') ?? pick('ai_objective');
  if (objective !== null) lines.push(`Objective: ${objective}`);
  const summary = pick('ai_summary');
  if (summary !== null && summary !== objective) lines.push(`Summary: ${summary}`);
  const description = (item.description ?? '').trim();
  if (description.length > 0 && description !== objective) lines.push(description);
  const tags = meta['ai_tags'];
  if (Array.isArray(tags)) {
    const t = tags.filter((x): x is string => typeof x === 'string').slice(0, 6);
    if (t.length > 0) lines.push(`Tags: ${t.join(', ')}`);
  }
  if (lines.length === 0) return null;
  return lines.join('\n\n');
}

/**
 * True when the asset was created/updated since the user's last visit.
 * Returns false on the first-ever visit (`lastVisitMs === null`) — with
 * no baseline, everything would read as "new", which is noise.
 */
function isNewSinceLastVisit(item: RendererItemSummary): boolean {
  const lastVisit = state.lastVisitMs;
  if (lastVisit === null) return false;
  const t = Date.parse(item.updatedAt || item.createdAt);
  return Number.isFinite(t) && t > lastVisit;
}

/**
 * Build the preview-corner status badge stack. Returns null when there
 * are no badges so the caller can skip appending. The badges are
 * visual-only (the card's aria-label already conveys "new" / "by
 * agent"), so the stack is aria-hidden.
 */
function buildTileBadgeStack(isNew: boolean, byAgent: boolean): HTMLElement | null {
  if (!isNew && !byAgent) return null;
  const stack = document.createElement('div');
  stack.className = 'spaces-card-badges';
  stack.setAttribute('aria-hidden', 'true');
  if (isNew) {
    const b = document.createElement('span');
    b.className = 'spaces-card-badge spaces-card-badge-new';
    b.textContent = 'New';
    stack.appendChild(b);
  }
  if (byAgent) {
    const b = document.createElement('span');
    b.className = 'spaces-card-badge spaces-card-badge-agent';
    b.textContent = '✨ AI';
    stack.appendChild(b);
  }
  return stack;
}

/**
 * Dispatcher for the per-kind tile preview. Each branch builds a
 * visually distinct surface that reads as "the thing it is" — the
 * shape of the preview encodes the asset kind, so the kind label
 * underneath can recede instead of competing for attention.
 */
function buildAssetTilePreview(item: RendererItemSummary): HTMLElement {
  const preview = document.createElement('div');
  preview.className = `spaces-card-preview spaces-card-preview-${item.kind}`;
  preview.setAttribute('aria-hidden', 'true');

  switch (item.kind) {
    case 'image':
      buildImageTilePreview(item, preview);
      break;
    case 'audio':
      buildAudioTilePreview(preview);
      break;
    case 'video':
      buildVideoTilePreview(item, preview);
      break;
    case 'url':
      buildUrlTilePreview(item, preview);
      break;
    case 'playbook':
      buildPlaybookTilePreview(item, preview);
      break;
    case 'transcript':
      buildTranscriptTilePreview(item, preview);
      break;
    case 'knowledge':
      buildKnowledgeTilePreview(item, preview);
      break;
    case 'journey':
      buildJourneyTilePreview(item, preview);
      break;
    case 'ticket':
      buildTicketTilePreview(item, preview);
      break;
    case 'agent':
      buildAgentTilePreview(item, preview);
      break;
    case 'document':
    case 'text':
    case 'other':
    default:
      buildTextTilePreview(item, preview);
      break;
  }
  return preview;
}

/**
 * Lazy thumbnail observer. An image-heavy Space would otherwise fire
 * one `resolveFileUrl` (signed-URL mint, typically a network call)
 * per tile the instant the grid renders — a thundering herd where
 * off-screen tiles compete with the ones the user can actually see,
 * and images pop in out of order. Instead we resolve a tile's URL
 * only once it scrolls within ~300px of the viewport.
 *
 * Lazily constructed (and null in jsdom / SSR where IntersectionObserver
 * doesn't exist) so tests fall back to the eager path.
 */
let tileImageObserver: IntersectionObserver | null = null;
let tileImageObserverTried = false;

function getTileImageObserver(): IntersectionObserver | null {
  if (tileImageObserverTried) return tileImageObserver;
  tileImageObserverTried = true;
  if (typeof IntersectionObserver === 'undefined') {
    tileImageObserver = null;
    return null;
  }
  tileImageObserver = new IntersectionObserver(
    (entries, observer) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target as HTMLElement;
        observer.unobserve(el);
        const key = el.getAttribute('data-thumb-key');
        if (key !== null && key.length > 0) loadTileThumbnail(el, key);
        const pdfKey = el.getAttribute('data-pdf-key');
        if (pdfKey !== null && pdfKey.length > 0) loadTilePdfPreview(el, pdfKey);
        const textKey = el.getAttribute('data-text-key');
        if (textKey !== null && textKey.length > 0) loadTileTextPreview(el, textKey);
        const videoKey = el.getAttribute('data-video-key');
        if (videoKey !== null && videoKey.length > 0) loadTileVideoFrame(el, videoKey);
      }
    },
    { rootMargin: '300px' }
  );
  return tileImageObserver;
}

/**
 * Image tile: shows a soft placeholder until the bridge resolves the
 * fileKey to a signed URL, then swaps in the real `<img>`. Resolution
 * is deferred until the tile nears the viewport (see
 * `getTileImageObserver`). Best-effort — when there's no bridge
 * (jsdom tests) or no fileKey, the placeholder is what the tile
 * renders permanently.
 */
function buildImageTilePreview(
  item: RendererItemSummary,
  preview: HTMLElement
): void {
  preview.classList.add('is-loading');
  const glyph = document.createElement('span');
  glyph.className = 'spaces-card-glyph spaces-card-glyph-image';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = '◾';
  preview.appendChild(glyph);

  if (typeof item.fileKey !== 'string' || item.fileKey.length === 0) return;
  // Fast path: producer wrote an already-dereferenceable URL — no
  // bridge round-trip, so no reason to defer.
  if (/^https?:\/\//i.test(item.fileKey)) {
    swapTilePreviewToImage(preview, item.fileKey);
    return;
  }

  // Stash the key on the element and defer the signed-URL mint until
  // the tile scrolls into view. When IntersectionObserver isn't
  // available (jsdom), resolve eagerly so the behavior degrades to
  // the previous always-load path.
  preview.setAttribute('data-thumb-key', item.fileKey);
  const observer = getTileImageObserver();
  if (observer === null) {
    loadTileThumbnail(preview, item.fileKey);
    return;
  }
  observer.observe(preview);
}

/** Resolve a stashed fileKey to a signed URL and swap in the image. */
function loadTileThumbnail(preview: HTMLElement, key: string): void {
  const bridge = window.lite?.spaces;
  if (bridge === undefined) return;
  void bridge.items
    .resolveFileUrl(key)
    .then((env) => {
      if (env.ok === false) return;
      const url = env.value;
      if (typeof url !== 'string' || url.length === 0) return;
      swapTilePreviewToImage(preview, url);
    })
    .catch(() => undefined);
}

function swapTilePreviewToImage(preview: HTMLElement, url: string): void {
  preview.classList.remove('is-loading');
  preview.removeAttribute('data-thumb-key');
  preview.replaceChildren();
  const img = document.createElement('img');
  img.className = 'spaces-card-image';
  img.alt = '';
  img.loading = 'lazy';
  img.addEventListener('error', () => {
    // A minted URL whose object is gone/expired must not render
    // Chromium's torn-photo glyph — show a clean placeholder instead.
    preview.replaceChildren();
    preview.classList.add('spaces-card-preview-imgfail');
    const glyph = document.createElement('span');
    glyph.className = 'spaces-card-imgfail-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = '⛰';
    preview.appendChild(glyph);
  });
  img.src = url;
  preview.appendChild(img);
}

/**
 * Audio tile: five CSS-only waveform bars + a centered play glyph.
 * Reads as "this is audio" without any real audio file or computed
 * waveform — pure ornament that says "play me."
 */
function buildAudioTilePreview(preview: HTMLElement): void {
  const wave = document.createElement('span');
  wave.className = 'spaces-card-wave';
  // Exactly 9 bars — the CSS shapes the envelope via :nth-child, so
  // the count here must stay in sync with the nth-child rules in
  // spaces.css (.spaces-card-wave-bar:nth-child(1..9)).
  for (let i = 0; i < 9; i++) {
    const bar = document.createElement('span');
    bar.className = 'spaces-card-wave-bar';
    wave.appendChild(bar);
  }
  preview.appendChild(wave);
  const play = document.createElement('span');
  play.className = 'spaces-card-play';
  play.setAttribute('aria-hidden', 'true');
  play.textContent = '▶';
  preview.appendChild(play);
}

/**
 * Video tile: centered large play glyph on a darker surface.
 * Distinct from audio (no waveform) and from generic "other" file
 * tiles. When real frame thumbnails arrive in the summary payload
 * later this can swap in a poster `<img>`.
 */
function buildVideoTilePreview(
  item: RendererItemSummary,
  preview: HTMLElement
): void {
  const play = document.createElement('span');
  play.className = 'spaces-card-play spaces-card-play-large';
  play.setAttribute('aria-hidden', 'true');
  play.textContent = '▶';
  preview.appendChild(play);

  // Frame grab: lazily fetch the bytes (within the inline cap), seek a
  // muted off-screen <video>, and paint a real frame behind the play
  // glyph. Data URLs keep the canvas untainted (signed URLs would need
  // CORS headers GSX doesn't send). Oversized or undecodable videos
  // keep the plain play tile.
  if (typeof item.fileKey !== 'string' || item.fileKey.length === 0) return;
  preview.setAttribute('data-video-key', item.fileKey);
  const observer = getTileImageObserver();
  if (observer === null) {
    loadTileVideoFrame(preview, item.fileKey);
    return;
  }
  observer.observe(preview);
}

/**
 * Frame-grab cache — rendered JPEG data URLs keyed by fileKey, so grid
 * re-renders don't re-decode the video. Entries are ~50–150KB.
 */
const tileVideoFrameCache = new Map<string, string>();
const TILE_VIDEO_CACHE_MAX_ENTRIES = 60;

function loadTileVideoFrame(preview: HTMLElement, key: string): void {
  const cached = tileVideoFrameCache.get(key);
  if (cached !== undefined) {
    swapTilePreviewToVideoFrame(preview, cached);
    return;
  }
  if (tilePreviewFailedKeys.has(key) || tileLoadsInFlight.has(key)) return;
  const bridge = window.lite?.spaces;
  if (bridge === undefined) return;
  tileLoadsInFlight.add(key);
  void bridge.items
    .readFileData(key)
    .then(async (env) => {
      const dataUrl = env.ok === true && env.value !== null ? env.value.dataUrl : null;
      if (typeof dataUrl !== 'string' || dataUrl.length === 0) {
        tileLoadsInFlight.delete(key);
        // Over-cap or missing — do NOT redownload the whole file on
        // every grid rebuild (measured ~GBs/hour for one big video).
        tilePreviewFailedKeys.add(key);
        return;
      }
      const frame = await grabVideoFrame(dataUrl);
      tileLoadsInFlight.delete(key);
      if (frame === null) {
        tilePreviewFailedKeys.add(key);
        return;
      }
      if (tileVideoFrameCache.size >= TILE_VIDEO_CACHE_MAX_ENTRIES) {
        const oldest = tileVideoFrameCache.keys().next().value;
        if (oldest !== undefined) tileVideoFrameCache.delete(oldest);
      }
      tileVideoFrameCache.set(key, frame);
      swapTilePreviewToVideoFrame(preview, frame);
    })
    .catch(() => {
      tileLoadsInFlight.delete(key);
      tilePreviewFailedKeys.add(key);
    });
}

/**
 * Decode a video data URL off-screen and rasterize one early frame to
 * a JPEG data URL. Resolves null on any decode/seek/canvas failure —
 * callers keep the plain play tile. Exported for tests (jsdom can't
 * decode video, so tests exercise the failure path; the success path
 * is covered by the driven live check).
 */
export function grabVideoFrame(
  dataUrl: string,
  timeoutMs = 10_000
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: string | null): void => {
      if (settled) return;
      settled = true;
      video.removeAttribute('src');
      try {
        video.load();
      } catch {
        /* detached cleanup only */
      }
      resolve(result);
    };
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    const timer = window.setTimeout(() => done(null), timeoutMs);
    video.addEventListener('error', () => {
      window.clearTimeout(timer);
      done(null);
    });
    video.addEventListener('loadeddata', () => {
      // Seek past the first frame — openings are often black.
      const target = Number.isFinite(video.duration)
        ? Math.min(1, video.duration / 10)
        : 0;
      try {
        video.currentTime = target;
      } catch {
        window.clearTimeout(timer);
        done(null);
      }
    });
    video.addEventListener('seeked', () => {
      window.clearTimeout(timer);
      try {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (w <= 0 || h <= 0) {
          done(null);
          return;
        }
        const scale = Math.min(1, 640 / w);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        const ctx = canvas.getContext('2d');
        if (ctx === null) {
          done(null);
          return;
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        done(canvas.toDataURL('image/jpeg', 0.82));
      } catch {
        done(null);
      }
    });
    video.src = dataUrl;
  });
}

/** Paint the grabbed frame behind the (kept) play glyph. */
function swapTilePreviewToVideoFrame(preview: HTMLElement, frameUrl: string): void {
  preview.removeAttribute('data-video-key');
  const stale = preview.querySelector('.spaces-card-video-frame');
  if (stale !== null) stale.remove();
  const img = document.createElement('img');
  img.className = 'spaces-card-image spaces-card-video-frame';
  img.src = frameUrl;
  img.alt = '';
  preview.insertBefore(img, preview.firstChild);
  preview.classList.add('has-video-frame');
}

/**
 * URL tile: host name on a soft "card" surface. Reads as a bookmark.
 */
function buildUrlTilePreview(
  item: RendererItemSummary,
  preview: HTMLElement
): void {
  const host = document.createElement('span');
  host.className = 'spaces-card-url-host';
  const sourceUrl = item.sourceUrl;
  if (typeof sourceUrl === 'string' && sourceUrl.length > 0) {
    try {
      const parsed = new URL(sourceUrl);
      host.textContent = parsed.hostname.replace(/^www\./, '');
    } catch {
      host.textContent = sourceUrl;
    }
  } else {
    host.textContent = 'Link';
  }
  preview.appendChild(host);
}

/**
 * Playbook tile: four stacked rule lines — reads as a ruled notebook
 * page. Distinct enough from generic doc tiles to be scan-able.
 */
/**
 * Playbook tile — the special one. A playbook is the plan that drives
 * a shared Space, so its tile reads as a miniature plan: a ★ PLAYBOOK
 * header chip, then the first steps parsed out of the excerpt as a
 * numbered checklist. Falls back to the excerpt as prose, then to the
 * abstract plan-lines ornament when there's nothing to parse.
 */
function buildPlaybookTilePreview(
  item: RendererItemSummary,
  preview: HTMLElement
): void {
  preview.classList.add('spaces-card-playbook-hero');
  const detailed = parsePlaybookStepsDetailed(item.contentHead ?? item.excerpt);
  const withBoxes = detailed.filter((s) => s.done !== null);
  const doneCount = withBoxes.filter((s) => s.done === true).length;

  const head = document.createElement('span');
  head.className = 'spaces-card-playbook-head';
  head.setAttribute('aria-hidden', 'true');
  const star = document.createElement('span');
  star.className = 'spaces-card-playbook-star';
  star.textContent = '★';
  head.appendChild(star);
  const label = document.createElement('span');
  label.className = 'spaces-card-playbook-label';
  label.textContent = 'PLAYBOOK';
  head.appendChild(label);
  // Right-aligned pill: live progress when the steps carry checkboxes,
  // plain step count otherwise. The playbook is the plan that RUNS —
  // its tile should say how far it has run.
  if (detailed.length > 0) {
    const pill = document.createElement('span');
    pill.className = 'spaces-card-playbook-pill';
    pill.textContent =
      withBoxes.length > 0
        ? `${doneCount}/${withBoxes.length}`
        : `${detailed.length} step${detailed.length === 1 ? '' : 's'}`;
    if (withBoxes.length > 0 && doneCount === withBoxes.length) {
      pill.classList.add('is-complete');
    }
    head.appendChild(pill);
  }
  preview.appendChild(head);

  // Progress bar under the header — only when there is real progress
  // data (checkboxes). A plan with no boxes shows no fake meter.
  if (withBoxes.length > 0) {
    const bar = document.createElement('span');
    bar.className = 'spaces-card-playbook-progress';
    const fill = document.createElement('span');
    fill.className = 'spaces-card-playbook-progress-fill';
    fill.style.width = `${Math.round((doneCount / withBoxes.length) * 100)}%`;
    bar.appendChild(fill);
    preview.appendChild(bar);
  }

  // Description line — the author's one-liner about the plan, marked
  // with the pen glyph so it reads as "written by someone."
  const description = (item.description ?? '').trim();
  if (description.length > 0) {
    const desc = document.createElement('span');
    desc.className = 'spaces-card-playbook-desc';
    const pen = document.createElement('span');
    pen.className = 'spaces-card-playbook-desc-pen';
    pen.textContent = '✎';
    desc.appendChild(pen);
    const text = document.createElement('span');
    text.className = 'spaces-card-playbook-desc-text';
    text.textContent = description;
    desc.appendChild(text);
    preview.appendChild(desc);
  }

  // Steps come from the content head when present — `excerpt` prefers
  // the description, and a described playbook must not lose its plan.
  if (detailed.length > 0) {
    const list = document.createElement('span');
    list.className = 'spaces-card-playbook-steps';
    const shown = detailed.slice(0, 4);
    for (let i = 0; i < shown.length; i++) {
      const step = shown[i];
      if (step === undefined) continue;
      const row = document.createElement('span');
      row.className = 'spaces-card-playbook-step';
      if (step.done === true) row.classList.add('is-done');
      const marker = document.createElement('span');
      marker.className = 'spaces-card-playbook-step-marker';
      marker.textContent = step.done === true ? '✓' : String(i + 1);
      row.appendChild(marker);
      const text = document.createElement('span');
      text.className = 'spaces-card-playbook-step-text';
      text.textContent = step.text;
      row.appendChild(text);
      list.appendChild(row);
    }
    if (detailed.length > shown.length) {
      const more = document.createElement('span');
      more.className = 'spaces-card-playbook-more';
      more.textContent = `+${detailed.length - shown.length} more`;
      list.appendChild(more);
    }
    preview.appendChild(list);
    return;
  }

  // Prose fallback — skipped when it would just repeat the
  // description line rendered above.
  const excerpt = tileExcerptText(item.excerpt);
  if (excerpt !== null && excerpt !== description) {
    const paper = document.createElement('p');
    paper.className = 'spaces-card-excerpt';
    paper.textContent = excerpt;
    preview.appendChild(paper);
    return;
  }

  for (let i = 0; i < 4; i++) {
    const line = document.createElement('span');
    line.className = 'spaces-card-playbook-line';
    line.style.setProperty('--line-index', String(i));
    preview.appendChild(line);
  }
}

/**
 * Transcript tile — the conversation, at a glance. A ❝ TRANSCRIPT
 * chip, the ✎ description when the author wrote one, then the first
 * turns parsed from the converted-Markdown content head as
 * speaker-labeled rows, with a participants footer. Falls back to the
 * plain excerpt, then to the doc glyph.
 */
function buildTranscriptTilePreview(
  item: RendererItemSummary,
  preview: HTMLElement
): void {
  const head = document.createElement('span');
  head.className = 'spaces-card-transcript-head';
  head.setAttribute('aria-hidden', 'true');
  const mark = document.createElement('span');
  mark.className = 'spaces-card-transcript-mark';
  mark.textContent = '❝';
  head.appendChild(mark);
  const label = document.createElement('span');
  label.className = 'spaces-card-transcript-label';
  label.textContent = 'TRANSCRIPT';
  head.appendChild(label);
  preview.appendChild(head);

  const description = (item.description ?? '').trim();
  if (description.length > 0) {
    const desc = document.createElement('span');
    desc.className = 'spaces-card-playbook-desc';
    const pen = document.createElement('span');
    pen.className = 'spaces-card-playbook-desc-pen';
    pen.textContent = '✎';
    desc.appendChild(pen);
    const text = document.createElement('span');
    text.className = 'spaces-card-playbook-desc-text';
    text.textContent = description;
    desc.appendChild(text);
    preview.appendChild(desc);
  }

  const parsed = parseTranscriptTilePreview(item.contentHead);
  if (parsed.turns.length > 0) {
    const list = document.createElement('span');
    list.className = 'spaces-card-transcript-turns';
    for (const turn of parsed.turns.slice(0, 3)) {
      const row = document.createElement('span');
      row.className = 'spaces-card-transcript-turn';
      const who = document.createElement('span');
      who.className = 'spaces-card-transcript-speaker';
      who.textContent = turn.speaker;
      row.appendChild(who);
      const said = document.createElement('span');
      said.className = 'spaces-card-transcript-text';
      said.textContent = turn.text;
      row.appendChild(said);
      list.appendChild(row);
    }
    if (parsed.participants.length > 0) {
      const foot = document.createElement('span');
      foot.className = 'spaces-card-transcript-foot';
      foot.textContent = `${parsed.participants.length} ${
        parsed.participants.length === 1 ? 'person' : 'people'
      }`;
      list.appendChild(foot);
    }
    preview.appendChild(list);
    return;
  }

  const excerpt = tileExcerptText(item.excerpt);
  if (excerpt !== null && excerpt !== description) {
    const paper = document.createElement('p');
    paper.className = 'spaces-card-excerpt';
    paper.textContent = excerpt;
    preview.appendChild(paper);
    return;
  }

  if (description.length === 0) {
    const glyph = document.createElement('span');
    glyph.className = 'spaces-card-glyph spaces-card-glyph-doc';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = '¶';
    preview.appendChild(glyph);
  }
}

/**
 * Knowledge-model tile — the hexagon mark with a KNOWLEDGE MODEL chip,
 * the ✎ description, and what it knows: domain chips parsed from the
 * content's bullet lines plus the intro prose. Reads as "a mind with
 * named domains," not a document.
 */
function buildKnowledgeTilePreview(
  item: RendererItemSummary,
  preview: HTMLElement
): void {
  const logo = buildHexMazeLogo();
  logo.classList.add('spaces-card-knowledge-hex');
  preview.appendChild(logo);

  const head = document.createElement('span');
  head.className = 'spaces-card-knowledge-head';
  head.setAttribute('aria-hidden', 'true');
  const mark = document.createElement('span');
  mark.className = 'spaces-card-knowledge-mark';
  mark.textContent = '⬡';
  head.appendChild(mark);
  const label = document.createElement('span');
  label.className = 'spaces-card-knowledge-label';
  label.textContent = 'KNOWLEDGE MODEL';
  head.appendChild(label);
  preview.appendChild(head);

  const description = (item.description ?? '').trim();
  if (description.length > 0) {
    const desc = document.createElement('span');
    desc.className = 'spaces-card-playbook-desc';
    const pen = document.createElement('span');
    pen.className = 'spaces-card-playbook-desc-pen';
    pen.textContent = '✎';
    desc.appendChild(pen);
    const text = document.createElement('span');
    text.className = 'spaces-card-playbook-desc-text';
    text.textContent = description;
    desc.appendChild(text);
    preview.appendChild(desc);
  }

  const parsed = parseKnowledgePreview(item.contentHead ?? item.excerpt);
  if (parsed.intro.length > 0) {
    const intro = document.createElement('p');
    intro.className = 'spaces-card-knowledge-intro';
    intro.textContent = parsed.intro;
    preview.appendChild(intro);
  }
  if (parsed.domains.length > 0) {
    const chips = document.createElement('span');
    chips.className = 'spaces-card-knowledge-domains';
    for (const domain of parsed.domains.slice(0, 4)) {
      const chip = document.createElement('span');
      chip.className = 'spaces-card-knowledge-domain';
      chip.textContent = domain;
      chips.appendChild(chip);
    }
    if (parsed.domains.length > 4) {
      const more = document.createElement('span');
      more.className = 'spaces-card-knowledge-more';
      more.textContent = `+${parsed.domains.length - 4}`;
      chips.appendChild(more);
    }
    preview.appendChild(chips);
  }
}

/**
 * Split a knowledge model's content head into intro prose + domain
 * chips (its bullet lines, markers stripped). Exported for tests.
 */
export function parseKnowledgePreview(
  head: string | undefined
): { intro: string; domains: string[] } {
  if (typeof head !== 'string' || head.trim().length === 0) {
    return { intro: '', domains: [] };
  }
  const lines = head.split(/\r?\n/);
  const domains: string[] = [];
  const intro: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const bullet = /^[-*•]\s+(.+)$/.exec(line);
    if (bullet !== null) {
      const text = (bullet[1] ?? '').replace(/\*\*/g, '').trim();
      if (text.length > 0 && text.length <= 60) domains.push(text);
      continue;
    }
    if (intro.length < 2 && !line.startsWith('#')) {
      intro.push(line.replace(/\*\*/g, ''));
    }
  }
  // Drop a cap-truncated final domain (mid-word cut).
  if (head.length >= 278 && domains.length > 0 && !/[\s.!?)]$/.test(head)) {
    domains.pop();
  }
  return { intro: intro.join(' ').slice(0, 160), domains };
}

/**
 * Journey-map / service-blueprint tile — a JOURNEY chip and the stages
 * parsed from the content rendered as a connected left-to-right flow.
 */
function buildJourneyTilePreview(
  item: RendererItemSummary,
  preview: HTMLElement
): void {
  const head = document.createElement('span');
  head.className = 'spaces-card-journey-head';
  head.setAttribute('aria-hidden', 'true');
  const mark = document.createElement('span');
  mark.className = 'spaces-card-journey-mark';
  mark.textContent = '⇢';
  head.appendChild(mark);
  const label = document.createElement('span');
  label.className = 'spaces-card-journey-label';
  label.textContent = 'JOURNEY';
  head.appendChild(label);
  preview.appendChild(head);

  const description = (item.description ?? '').trim();
  if (description.length > 0) {
    const desc = document.createElement('span');
    desc.className = 'spaces-card-playbook-desc';
    const pen = document.createElement('span');
    pen.className = 'spaces-card-playbook-desc-pen';
    pen.textContent = '✎';
    desc.appendChild(pen);
    const text = document.createElement('span');
    text.className = 'spaces-card-playbook-desc-text';
    text.textContent = description;
    desc.appendChild(text);
    preview.appendChild(desc);
  }

  // Stages share the playbook step grammar (numbered / bulleted /
  // "Stage N:"-style headings all parse).
  const stages = parsePlaybookSteps(item.contentHead ?? item.excerpt);
  if (stages.length > 0) {
    const flow = document.createElement('span');
    flow.className = 'spaces-card-journey-flow';
    const shown = stages.slice(0, 4);
    for (let i = 0; i < shown.length; i++) {
      if (i > 0) {
        const arrow = document.createElement('span');
        arrow.className = 'spaces-card-journey-arrow';
        arrow.textContent = '→';
        flow.appendChild(arrow);
      }
      const stage = document.createElement('span');
      stage.className = 'spaces-card-journey-stage';
      stage.textContent = shortStageLabel(shown[i] ?? '');
      flow.appendChild(stage);
    }
    if (stages.length > shown.length) {
      const more = document.createElement('span');
      more.className = 'spaces-card-journey-more';
      more.textContent = `+${stages.length - shown.length}`;
      flow.appendChild(more);
    }
    preview.appendChild(flow);
    return;
  }

  const excerpt = tileExcerptText(item.excerpt);
  if (excerpt !== null && excerpt !== description) {
    const paper = document.createElement('p');
    paper.className = 'spaces-card-excerpt';
    paper.textContent = excerpt;
    preview.appendChild(paper);
  }
}

/** First clause of a stage line, tightened for a flow chip. */
export function shortStageLabel(stage: string): string {
  const clause = stage.split(/[.:—–-]\s/)[0] ?? stage;
  const words = clause.trim().split(/\s+/).slice(0, 3).join(' ');
  return words.length > 24 ? `${words.slice(0, 23)}…` : words;
}

/**
 * Pull step lines out of a playbook excerpt. Recognizes the shapes
 * plans are actually written in — numbered lists, bullets, task-list
 * checkboxes, and "Step N:" headings — strips the markers, and drops
 * markdown heading noise. The last line is dropped when the excerpt
 * was cut mid-line by the summary's 280-char cap (no trailing
 * terminator), so tiles never show a half word. Exported for tests.
 */
/** A playbook step with its checkbox state: true/false, null = no box. */
export interface PlaybookStep {
  text: string;
  done: boolean | null;
}

export function parsePlaybookStepsDetailed(
  excerpt: string | undefined
): PlaybookStep[] {
  if (typeof excerpt !== 'string' || excerpt.trim().length === 0) return [];
  // "Cut by the 280-char summary cap" needs BOTH signals: at/near the
  // cap AND no clean terminator — otherwise a short complete list
  // that simply lacks trailing punctuation loses its last step.
  const truncated = excerpt.length >= 278 && !/[\s.!?:;)\]]$/.test(excerpt);
  const lines = excerpt.split(/\r?\n/);
  const steps: Array<{ text: string; done: boolean | null; line: number }> = [];
  // Checkbox captured separately so the tile can render REAL progress
  // ("playbook tiles should be very special", 2026-08-08).
  const STEP_RE = /^\s*(?:(?:\d+[.)])|(?:[-*•]\s*(?:\[([ xX])\])?)|(?:#{1,4}\s*step\s*\d*[:.]?))\s*(.+)$/i;
  for (let i = 0; i < lines.length; i++) {
    const m = STEP_RE.exec(lines[i] ?? '');
    if (m === null) continue;
    const text = (m[2] ?? '').replace(/\*\*/g, '').trim();
    if (text.length === 0) continue;
    const box = m[1];
    const done = box === undefined ? null : box.toLowerCase() === 'x';
    steps.push({ text, done, line: i });
  }
  if (steps.length === 0) return [];
  // Drop a final step that sits on the excerpt's cut-off last line.
  const last = steps[steps.length - 1];
  if (truncated && last !== undefined && last.line === lines.length - 1) {
    steps.pop();
  }
  return steps.map((s) => ({ text: s.text, done: s.done }));
}

export function parsePlaybookSteps(excerpt: string | undefined): string[] {
  return parsePlaybookStepsDetailed(excerpt).map((s) => s.text);
}

/**
 * Ticket tile: hash glyph + truncated excerpt. The excerpt carries
 * the body so the tile reads as a sticky-note, not a generic icon.
 */
function buildTicketTilePreview(
  item: RendererItemSummary,
  preview: HTMLElement
): void {
  const tag = document.createElement('span');
  tag.className = 'spaces-card-ticket-tag';
  tag.setAttribute('aria-hidden', 'true');
  tag.textContent = '#';
  preview.appendChild(tag);
  const ticketExcerpt = tileExcerptText(item.excerpt);
  if (ticketExcerpt !== null) {
    const body = document.createElement('p');
    body.className = 'spaces-card-excerpt';
    body.textContent = ticketExcerpt;
    preview.appendChild(body);
  }
}

/**
 * Text / document tile: renders the excerpt as typeset paragraph
 * text on a paper-style surface. This is the move that flips a
 * text asset from "row with an icon" to "a document you can read
 * a few lines of." When there's no excerpt at all, falls back to
 * a quiet `¶` glyph so the tile still says "document."
 */
function buildTextTilePreview(
  item: RendererItemSummary,
  preview: HTMLElement
): void {
  const excerpt = tileExcerptText(item.excerpt);
  if (excerpt !== null) {
    const paper = document.createElement('p');
    paper.className = 'spaces-card-excerpt';
    paper.textContent = excerpt;
    preview.appendChild(paper);
    return;
  }
  // Binary-backed doc with nothing to excerpt: PDFs get a real
  // first-page preview and text-like files fetch a text excerpt
  // (both lazy, same near-viewport gate as image thumbnails); other
  // files get a file-card with the extension so the tile never reads
  // as an empty grey rectangle.
  if (typeof item.fileKey === 'string' && item.fileKey.length > 0) {
    if (isPdfTitle(item.title)) {
      preview.classList.add('is-loading');
      swapTilePreviewToFileBadge(preview, item.title, { keepLoading: true });
      preview.setAttribute('data-pdf-key', item.fileKey);
      const observer = getTileImageObserver();
      if (observer === null) {
        loadTilePdfPreview(preview, item.fileKey);
        return;
      }
      observer.observe(preview);
      return;
    }
    if (isTextLikeFile(item.title, '')) {
      preview.classList.add('is-loading');
      swapTilePreviewToFileBadge(preview, item.title, { keepLoading: true });
      preview.setAttribute('data-text-key', item.fileKey);
      const observer = getTileImageObserver();
      if (observer === null) {
        loadTileTextPreview(preview, item.fileKey);
        return;
      }
      observer.observe(preview);
      return;
    }
    swapTilePreviewToFileBadge(preview, item.title);
    return;
  }
  const glyph = document.createElement('span');
  glyph.className = 'spaces-card-glyph spaces-card-glyph-doc';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = '¶';
  preview.appendChild(glyph);
}

/** True when the title names a PDF (summaries don't carry mimeType). */
export function isPdfTitle(title: string): boolean {
  return typeof title === 'string' && title.trim().toLowerCase().endsWith('.pdf');
}

/**
 * Uppercase extension badge for a file title ("PDF", "DOCX"); "FILE"
 * when the title has no usable extension. Exported for tests.
 */
export function fileExtBadge(title: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec((title ?? '').trim());
  const ext = m?.[1] ?? '';
  return ext.length > 0 ? ext.toUpperCase() : 'FILE';
}

/**
 * Tile PDF bytes cache — re-renders (refresh, enrich completion,
 * selection changes) rebuild every card, and re-fetching a PDF's
 * bytes each time would hammer GSX. Keyed by fileKey; evicted
 * oldest-first once the stored data URLs exceed ~24M chars (~18MB).
 */
const tilePdfDataCache = new Map<string, string>();
const TILE_PDF_CACHE_MAX_CHARS = 24_000_000;

/**
 * Negative cache: fileKeys whose preview fetch/decodes FAILED (404
 * key, over the inline cap, undecodable). Without it every grid
 * rebuild (≥1/min from background refresh, ×3 renders per burst)
 * re-downloads the entire file just to fail again — a >25MB video
 * tile was measured at ~GBs/hour of silent egress. Per-session;
 * a manual app restart retries.
 */
const tilePreviewFailedKeys = new Set<string>();

/** In-flight dedup: keys currently being fetched by ANY tile loader. */
const tileLoadsInFlight = new Set<string>();

function tilePdfCachePut(key: string, dataUrl: string): void {
  tilePdfDataCache.delete(key);
  tilePdfDataCache.set(key, dataUrl);
  let total = 0;
  for (const v of tilePdfDataCache.values()) total += v.length;
  for (const k of tilePdfDataCache.keys()) {
    if (total <= TILE_PDF_CACHE_MAX_CHARS) break;
    // Never evict the entry we just inserted — a single over-cap
    // dataUrl would otherwise evict ITSELF and re-download on every
    // grid rebuild forever.
    if (k === key) break;
    const v = tilePdfDataCache.get(k);
    tilePdfDataCache.delete(k);
    total -= v?.length ?? 0;
  }
}

/**
 * Resolve a PDF tile's bytes to a data URL and swap in the embedded
 * first-page preview; on any failure (404 key, over the inline cap,
 * no bridge) the tile keeps the extension badge.
 */
function loadTilePdfPreview(preview: HTMLElement, key: string): void {
  const cached = tilePdfDataCache.get(key);
  if (cached !== undefined) {
    swapTilePreviewToPdf(preview, cached);
    return;
  }
  if (tilePreviewFailedKeys.has(key) || tileLoadsInFlight.has(key)) {
    preview.classList.remove('is-loading');
    return;
  }
  const bridge = window.lite?.spaces;
  if (bridge === undefined) {
    preview.classList.remove('is-loading');
    return;
  }
  tileLoadsInFlight.add(key);
  void bridge.items
    .readFileData(key)
    .then((env) => {
      tileLoadsInFlight.delete(key);
      const dataUrl = env.ok === true && env.value !== null ? env.value.dataUrl : null;
      if (typeof dataUrl !== 'string' || dataUrl.length === 0) {
        tilePreviewFailedKeys.add(key);
        preview.classList.remove('is-loading');
        return;
      }
      tilePdfCachePut(key, dataUrl);
      swapTilePreviewToPdf(preview, dataUrl);
    })
    .catch(() => {
      tileLoadsInFlight.delete(key);
      tilePreviewFailedKeys.add(key);
      preview.classList.remove('is-loading');
    });
}

function swapTilePreviewToPdf(preview: HTMLElement, dataUrl: string): void {
  preview.classList.remove('is-loading');
  preview.removeAttribute('data-pdf-key');
  preview.replaceChildren();
  const embed = document.createElement('embed');
  embed.className = 'spaces-card-pdf-embed';
  embed.type = 'application/pdf';
  // PDF open params suppress the viewer chrome inside the tile; the
  // embed is pointer-events:none so the card's click still opens the
  // detail pane.
  embed.src = `${dataUrl}#toolbar=0&navpanes=0&scrollbar=0&view=Fit`;
  embed.setAttribute('aria-hidden', 'true');
  preview.appendChild(embed);
}

function swapTilePreviewToFileBadge(
  preview: HTMLElement,
  title: string,
  opts: { keepLoading?: boolean } = {}
): void {
  if (opts.keepLoading !== true) preview.classList.remove('is-loading');
  preview.replaceChildren();
  const card = document.createElement('span');
  card.className = 'spaces-card-filecard';
  card.setAttribute('aria-hidden', 'true');
  const glyph = document.createElement('span');
  glyph.className = 'spaces-card-glyph spaces-card-glyph-doc';
  glyph.textContent = '¶';
  card.appendChild(glyph);
  const badge = fileExtBadge(title);
  const ext = document.createElement('span');
  ext.className = 'spaces-card-filecard-ext';
  ext.setAttribute('data-family', fileExtFamily(badge));
  ext.textContent = badge;
  card.appendChild(ext);
  preview.appendChild(card);
}

/**
 * Coarse family for an extension badge so CSS can tint it (Word-blue,
 * sheet-green, deck-orange). Exported for tests.
 */
export function fileExtFamily(ext: string): string {
  const e = (ext ?? '').toLowerCase();
  if (e === 'doc' || e === 'docx' || e === 'rtf' || e === 'odt' || e === 'pages') return 'word';
  if (e === 'xls' || e === 'xlsx' || e === 'ods' || e === 'numbers') return 'sheet';
  if (e === 'ppt' || e === 'pptx' || e === 'odp' || e === 'key') return 'deck';
  if (e === 'zip' || e === 'tar' || e === 'gz' || e === '7z' || e === 'rar') return 'archive';
  return 'generic';
}

/**
 * Tile text-excerpt cache — decoded first-lines of GSX-resident text
 * files (md/txt/html/code), keyed by fileKey. Entries are tiny
 * (≤300 chars), so a simple size cap is enough.
 */
const tileTextExcerptCache = new Map<string, string>();
const TILE_TEXT_CACHE_MAX_ENTRIES = 300;
const TILE_TEXT_EXCERPT_CHARS = 300;

/**
 * Fetch a text-like file's bytes, decode to UTF-8, and swap the tile
 * to a paper-style excerpt — the same look inline text assets get.
 * Any failure (404 key, over the inline cap, binary masquerading as
 * text) keeps the extension badge.
 */
function loadTileTextPreview(preview: HTMLElement, key: string): void {
  const cached = tileTextExcerptCache.get(key);
  if (cached !== undefined) {
    if (cached.length > 0) swapTilePreviewToTextExcerpt(preview, cached);
    else preview.classList.remove('is-loading');
    return;
  }
  if (tilePreviewFailedKeys.has(key) || tileLoadsInFlight.has(key)) {
    preview.classList.remove('is-loading');
    return;
  }
  const bridge = window.lite?.spaces;
  if (bridge === undefined) {
    preview.classList.remove('is-loading');
    return;
  }
  tileLoadsInFlight.add(key);
  void bridge.items
    .readFileData(key)
    .then((env) => {
      tileLoadsInFlight.delete(key);
      const dataUrl = env.ok === true && env.value !== null ? env.value.dataUrl : null;
      const text = dataUrl !== null ? decodeDataUrlText(dataUrl) : null;
      const excerpt = text !== null ? text.trim().slice(0, TILE_TEXT_EXCERPT_CHARS) : '';
      // Cache EMPTY verdicts too — an empty/binary-masquerading file
      // must not refetch its full bytes on every rebuild.
      if (tileTextExcerptCache.size >= TILE_TEXT_CACHE_MAX_ENTRIES) {
        const oldest = tileTextExcerptCache.keys().next().value;
        if (oldest !== undefined) tileTextExcerptCache.delete(oldest);
      }
      tileTextExcerptCache.set(key, excerpt);
      if (excerpt.length === 0) {
        preview.classList.remove('is-loading');
        return;
      }
      swapTilePreviewToTextExcerpt(preview, excerpt);
    })
    .catch(() => {
      tileLoadsInFlight.delete(key);
      tilePreviewFailedKeys.add(key);
      preview.classList.remove('is-loading');
    });
}

function swapTilePreviewToTextExcerpt(preview: HTMLElement, excerpt: string): void {
  preview.classList.remove('is-loading');
  preview.removeAttribute('data-text-key');
  preview.replaceChildren();
  const paper = document.createElement('p');
  paper.className = 'spaces-card-excerpt';
  paper.textContent = excerpt;
  preview.appendChild(paper);
}

/**
 * Normalize a summary excerpt for tile display. Returns null for
 * missing/blank excerpts and for legacy base64 data-URL stubs (inline
 * binary content predating ADR-050) so tiles never print base64 soup.
 */
/**
 * Strip the loudest markdown syntax so a tile excerpt reads as prose,
 * not source. Found in the 2026-08-08 function sweep: a text/idea/doc
 * asset whose content led with `**Type:** …` or `# Heading` showed the
 * literal `**` / `#` in its tile. Conservative — it unwraps the marks
 * that look like noise (emphasis, headings, inline code, list bullets,
 * blockquotes, link syntax) and leaves the words alone.
 */
export function stripMarkdownForExcerpt(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')      // fenced code blocks
    .replace(/`([^`]+)`/g, '$1')           // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → text
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')    // ATX headings
    .replace(/^\s{0,3}>\s?/gm, '')         // blockquotes
    .replace(/^\s{0,3}[-*+]\s+(?:\[[ xX]\]\s*)?/gm, '') // list bullets + task boxes
    .replace(/^\s{0,3}\d+[.)]\s+/gm, '')   // ordered list markers
    .replace(/\*\*([^*]+)\*\*/g, '$1')     // bold
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2') // italic (single *)
    .replace(/__([^_]+)__/g, '$1')         // bold underscore
    .replace(/\s*\n\s*/g, ' ')            // collapse lines
    .replace(/\s{2,}/g, ' ')               // collapse runs
    .trim();
}

export function tileExcerptText(excerpt: string | undefined): string | null {
  if (typeof excerpt !== 'string') return null;
  const raw = excerpt.trim();
  if (raw.length === 0) return null;
  if (raw.startsWith('data:')) return null;
  const cleaned = stripMarkdownForExcerpt(raw);
  return cleaned.length > 0 ? cleaned : null;
}


/**
 * The OneReach hexagon-maze mark, recreated as inline SVG: concentric
 * hexagon rings with maze-like gaps around a dotted isometric cube.
 * Vector so it stays crisp at tile size and tints per kind via
 * `currentColor`. Swap point for the real raster asset: replace this
 * builder's output with an <img> once the PNG lands in the repo.
 */

/**
 * Agent tile v2 — the hexagon mark as the visual anchor, an AGENT chip
 * with the behavioral type, reachability chips (MCP/API/SKILL), and a
 * description/OKF snippet. Library-added and OKF-pasted agents render
 * identically.
 */
function buildAgentTilePreview(item: RendererItemSummary, preview: HTMLElement): void {
  const logo = buildHexMazeLogo();
  logo.classList.add('spaces-card-agent-hex');
  preview.appendChild(logo);

  const head = document.createElement('span');
  head.className = 'spaces-card-agent-head';
  head.setAttribute('aria-hidden', 'true');
  const mark = document.createElement('span');
  mark.className = 'spaces-card-agent-mark';
  mark.textContent = '◈';
  head.appendChild(mark);
  const label = document.createElement('span');
  label.className = 'spaces-card-agent-label';
  label.textContent = 'AGENT';
  head.appendChild(label);
  const agentType = (item.agentType ?? '').trim();
  if (agentType.length > 0 && agentType !== 'other') {
    const type = document.createElement('span');
    type.className = 'spaces-card-agent-type';
    type.textContent = agentType;
    head.appendChild(type);
  }
  preview.appendChild(head);

  const endpoints = item.agentEndpoints ?? [];
  if (endpoints.length > 0) {
    const chips = document.createElement('span');
    chips.className = 'spaces-card-agent-endpoints';
    const seen = new Set<string>();
    for (const ep of endpoints) {
      if (seen.has(ep.kind)) continue;
      seen.add(ep.kind);
      const chip = document.createElement('span');
      chip.className = `spaces-card-agent-endpoint spaces-card-agent-endpoint-${ep.kind}`;
      chip.textContent = ep.kind === 'api' ? 'RESTful' : ep.kind.toUpperCase();
      chips.appendChild(chip);
    }
    preview.appendChild(chips);
  }

  const excerpt = tileExcerptText(item.excerpt);
  if (excerpt !== null) {
    const body = document.createElement('p');
    body.className = 'spaces-card-excerpt spaces-card-agent-okf';
    body.textContent = excerpt;
    preview.appendChild(body);
  }
}

/**
 * Detail-pane block for an agent: a header showing the agent type +
 * "OKF definition" label, then the OKF text rendered as a monospace
 * structured-text block (reusing the code-preview renderer).
 */
function buildAgentOkfBlock(item: RendererItem, okf: string): HTMLElement {
  const section = document.createElement('section');
  section.className = 'spaces-detail-agent';

  const head = document.createElement('div');
  head.className = 'spaces-detail-agent-head';
  const typeBadge = document.createElement('span');
  typeBadge.className = 'spaces-detail-agent-type';
  const t =
    typeof item.agentType === 'string' && item.agentType.length > 0
      ? item.agentType
      : 'agent';
  typeBadge.textContent = `◈ ${t.charAt(0).toUpperCase()}${t.slice(1)} agent`;
  head.appendChild(typeBadge);
  const okfLabel = document.createElement('span');
  okfLabel.className = 'spaces-detail-agent-okf-label';
  okfLabel.textContent = 'OKF definition';
  head.appendChild(okfLabel);
  section.appendChild(head);

  // Reachability: where the agent runs (MCP/API/Skill) + its channels.
  const endpoints = Array.isArray(item.agentEndpoints) ? item.agentEndpoints : [];
  if (endpoints.length > 0) {
    const reach = document.createElement('div');
    reach.className = 'spaces-detail-agent-reach';
    const reachLabel = document.createElement('div');
    reachLabel.className = 'spaces-detail-agent-reach-label';
    reachLabel.textContent = 'Reachable via';
    reach.appendChild(reachLabel);
    for (const ep of endpoints) {
      const row = document.createElement('div');
      row.className = 'spaces-detail-endpoint';
      const kind = document.createElement('span');
      kind.className = 'spaces-detail-endpoint-kind';
      kind.textContent = String(ep.kind).toUpperCase();
      row.appendChild(kind);
      const url = document.createElement('span');
      url.className = 'spaces-detail-endpoint-url';
      url.textContent = ep.url;
      url.title = ep.url;
      row.appendChild(url);
      const channels = Array.isArray(ep.channels) ? ep.channels : [];
      if (channels.length > 0) {
        const chWrap = document.createElement('span');
        chWrap.className = 'spaces-detail-endpoint-channels';
        for (const ch of channels) {
          const chip = document.createElement('span');
          chip.className = 'spaces-detail-endpoint-channel';
          chip.textContent = ch;
          chWrap.appendChild(chip);
        }
        row.appendChild(chWrap);
      }
      reach.appendChild(row);
    }
    section.appendChild(reach);
  }

  // OKF is structured YAML/MD text — render in the monospace code block.
  section.appendChild(buildCodePreview(okf, 'yaml'));
  return section;
}

export function buildSpaceChip(chip: RendererSpaceChipRef): HTMLElement {
  const el = document.createElement('span');
  el.className = 'spaces-chip';
  el.setAttribute('data-chip-id', chip.id);

  const dot = document.createElement('span');
  dot.className = 'spaces-chip-dot';
  if (typeof chip.color === 'string' && chip.color.length > 0) {
    { const c = safeCssColor(chip.color); if (c !== null) dot.style.background = c; }
  }
  el.appendChild(dot);

  const label = document.createElement('span');
  label.className = 'spaces-chip-name';
  // Treat hash / UUID-shaped names the same as missing names so a
  // chip never reads as "402abae35ea49651...". The data-side fix is
  // for producers to write real names; this is the renderer's guard
  // until that backfills.
  label.textContent = friendlySpaceName(chip.name);
  el.appendChild(label);

  return el;
}

/** Empty state for "items exist, but this FILTER matches none." */
function buildFilteredEmptyState(): HTMLElement {
  const box = document.createElement('div');
  box.className = 'spaces-empty-items';
  const mark = document.createElement('span');
  mark.className = 'spaces-empty-items-mark';
  mark.setAttribute('aria-hidden', 'true');
  mark.textContent = '⌇';
  box.appendChild(mark);
  const line = document.createElement('p');
  line.className = 'spaces-empty-items-line';
  line.textContent = 'Nothing matches that filter — yet.';
  box.appendChild(line);
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'spaces-empty-items-cta';
  clear.textContent = 'Show all';
  clear.addEventListener('click', () => {
    state.homeFilter = 'all';
    renderItemList({});
    const chips = document.querySelectorAll<HTMLElement>('.spaces-filter-chip');
    for (const chip of Array.from(chips)) {
      chip.classList.toggle('is-active', chip.getAttribute('data-filter') === 'all');
    }
  });
  box.appendChild(clear);
  return box;
}

function buildEmptyItemsState(scopeId: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'spaces-empty-items';
  const mark = document.createElement('span');
  mark.className = 'spaces-empty-items-mark';
  mark.setAttribute('aria-hidden', 'true');
  mark.textContent = scopeId === UNCATEGORIZED_SPACE_ID ? '✽' : '✎';
  wrap.appendChild(mark);
  const title = document.createElement('h2');
  title.className = 'spaces-empty-items-title';
  title.textContent =
    scopeId === UNCATEGORIZED_SPACE_ID
      ? 'Nothing waiting — all clear'
      : 'A blank Space, waiting for you';
  wrap.appendChild(title);
  const body = document.createElement('p');
  body.className = 'spaces-empty-items-body';
  body.textContent =
    scopeId === UNCATEGORIZED_SPACE_ID
      ? 'Items that arrive without a home land here for triage. When an agent drops new output into the graph, it shows up in this list.'
      : 'Drop in a file, paste a note or a link, or point an agent at it. Whatever you add stays findable — forever.';
  wrap.appendChild(body);

  // The uncategorized lane is genuinely passive — things ARRIVE there,
  // you don't add to it — so it keeps the descriptive copy and gets no
  // button. A real Space is the opposite: this is the moment to offer
  // the action rather than describe a future in which it happened.
  if (scopeId !== UNCATEGORIZED_SPACE_ID) {
    const cta = document.createElement('button');
    cta.type = 'button';
    cta.className = 'spaces-empty-items-cta';
    cta.textContent = 'Add the first item';
    cta.addEventListener('click', () => openNewAssetDialog());
    wrap.appendChild(cta);
  }
  return wrap;
}

function buildBanner(kind: 'info' | 'error', message: string): HTMLElement {
  const div = document.createElement('div');
  div.className = `spaces-banner spaces-banner-${kind}`;
  div.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  div.textContent = message;
  return div;
}

// ─── Detail rail ────────────────────────────────────────────────────────

interface RenderDetailOpts {
  loading?: boolean;
  error?: string;
  item?: RendererItem;
}

function renderDetail(opts: RenderDetailOpts): void {
  const aside = document.getElementById('spaces-detail');
  if (aside === null) return;
  aside.replaceChildren();
  if (opts.error !== undefined) {
    aside.appendChild(buildBanner('error', opts.error));
    return;
  }
  if (opts.loading === true) {
    aside.appendChild(buildBanner('info', 'Loading…'));
    return;
  }
  if (opts.item === undefined) return;
  const item = opts.item;
  const onClose = (): void => {
    state.activeItemId = null;
    const grid = document.getElementById('spaces-card-grid');
    if (grid !== null) applyActiveCard(grid, null);
    showDetailRail(false);
  };
  // Phase 3b edit callbacks. Each routes through the bridge and
  // re-fetches the item so the renderer state reflects the updated
  // server-side projection (timestamps, lastEditedBy, tags).
  const editCallbacks: RendererDetailEditCallbacks = {
    onTitleSave: (next) => commitItemUpdate(item.id, { title: next }),
    onTypeChange: (next) => commitItemUpdate(item.id, { type: next }),
    onTagAdd: (tag) => commitTagAdd(item.id, tag),
    onTagRemove: (tag) => commitTagRemove(item.id, tag),
    onMetadataAdd: (key, value) => commitMetadataAdd(item.id, key, value),
    onMetadataValueEdit: (key, value) => commitMetadataAdd(item.id, key, value),
    onMetadataRemove: (key) => commitMetadataRemove(item.id, key),
    // Only expose Auto-fill when the AI bridge is present.
    ...(window.lite?.ai !== undefined
      ? { onMetadataAutoFill: () => autoFillMetadata(item.id) }
      : {}),
    onContentSave: (next) => commitItemUpdate(item.id, { content: next }),
    onDescriptionSave: (next) =>
      commitItemUpdate(item.id, { description: next }),
  };
  aside.appendChild(buildDetailPane(item, onClose, 'rendered', editCallbacks));

  // Phase 4 v2: "Set as playbook" affordance. Show when:
  //  - The active scope is a shared space
  //  - The item isn't already a playbook (no point re-promoting)
  //  - The item is textual content (document / text / playbook itself
  //    after a demotion path; we keep the check loose so promoting
  //    any asset works — the SDK rewrites `a.type`)
  const activeSpace = state.spaces.find((s) => s.id === state.activeScopeId);
  if (activeSpace?.kind === 'shared') {
    // Gate on "is this ALREADY the current playbook?", never on "is this
    // playbook-shaped?" (2026-08-18, Data Bricks): the space held four
    // WISER-authored :Playbook assets and designated none, yet selecting
    // any of them HID this button — the one action the empty state told
    // the user to take. Being a playbook and being THE playbook are
    // different facts.
    const currentPlaybookId =
      state.sharedDashboards.get(activeSpace.id)?.playbook?.id ?? null;
    if (item.id !== currentPlaybookId) {
      aside.appendChild(
        buildSetAsPlaybookAffordance(activeSpace.id, item.id, item.kind === 'playbook')
      );
    }
  }

  // Sprint 3: Move + Add-to-another-space affordances. Only shown
  // outside Home (Home view doesn't have a meaningful "current space").
  if (state.activeScopeId !== HOME_SCOPE_ID) {
    const currentSpaceId =
      state.activeScopeId !== UNCATEGORIZED_SPACE_ID ? state.activeScopeId : null;
    aside.appendChild(buildMoveToSpaceAffordance(item, currentSpaceId));
    aside.appendChild(buildSpaceMembershipPanel(item));
    const sharing = buildSharingStatus(item);
    if (sharing !== null) {
      aside.appendChild(sharing);
      // Correct the badge against the bucket's real schedule. Async and
      // best-effort: the stamped value renders immediately so the pane
      // never waits on a network call to show what it already knows.
      void refreshExpiryFromBucket(item, sharing);
    }
  }

  // Sprint 1: Delete affordance at the bottom of the detail pane.
  aside.appendChild(buildAssetDeleteAffordance(item.id, item.title));
}

/**
 * Multi-space membership panel.
 *
 * An item can live in many Spaces (the graph MERGEs one `[:BELONGS_TO]`
 * edge per Space), but the UI only offered a one-at-a-time dropdown, so
 * filing into three Spaces meant three separate trips through a select
 * you had to already know the contents of.
 *
 * This is the whole picture in one place: every Space as a checkbox
 * with current membership pre-ticked, and — at the top — Claude's
 * shortlist of Spaces this item probably belongs in, each with a short
 * reason drawn from the Space's own name + description. Suggestions are
 * an accelerant: they can only ever name Spaces that are already in the
 * list, and the full list is always there whether AI is configured or
 * not.
 */
function buildSpaceMembershipPanel(item: RendererItem): HTMLElement {
  const wrap = document.createElement('section');
  wrap.className = 'spaces-detail-membership';

  const label = document.createElement('span');
  label.className = 'spaces-detail-label';
  label.textContent = 'In spaces';
  wrap.appendChild(label);

  const memberIds = new Set<string>(
    (item.otherSpaces ?? []).map((c) => c.id).filter((x): x is string => typeof x === 'string')
  );
  // The scope we're viewing from is a membership too when it's a real Space.
  if (
    state.activeScopeId !== HOME_SCOPE_ID &&
    state.activeScopeId !== UNCATEGORIZED_SPACE_ID &&
    typeof state.activeScopeId === 'string'
  ) {
    memberIds.add(state.activeScopeId);
  }

  // Suggestions slot — filled asynchronously; absent until it resolves
  // so the panel never shows an empty "Suggested" heading.
  const suggestions = document.createElement('div');
  suggestions.className = 'spaces-membership-suggestions';
  suggestions.hidden = true;
  wrap.appendChild(suggestions);

  const list = document.createElement('div');
  list.className = 'spaces-membership-list';
  for (const space of state.spaces) {
    list.appendChild(buildMembershipRow(item, space, memberIds.has(space.id)));
  }
  wrap.appendChild(list);

  void loadSpaceSuggestions(item, memberIds, suggestions);
  return wrap;
}

/** One Space row: a checkbox that adds/removes membership on toggle. */
function buildMembershipRow(
  item: RendererItem,
  space: RendererSpace,
  isMember: boolean
): HTMLElement {
  const row = document.createElement('label');
  row.className = 'spaces-membership-row';
  row.setAttribute('data-space-id', space.id);

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'spaces-membership-check';
  box.checked = isMember;
  box.setAttribute('aria-label', `${isMember ? 'Remove from' : 'Add to'} ${space.name}`);
  box.addEventListener('change', () => {
    void toggleSpaceMembership(item.id, space, box);
  });
  row.appendChild(box);

  if (typeof space.color === 'string' && space.color.length > 0) {
    const dot = document.createElement('span');
    dot.className = 'spaces-membership-dot';
    { const c = safeCssColor(space.color); if (c !== null) dot.style.background = c; }
    row.appendChild(dot);
  }

  const name = document.createElement('span');
  name.className = 'spaces-membership-name';
  name.textContent = space.name.length > 0 ? space.name : '(unnamed)';
  row.appendChild(name);

  // Which Spaces are members-only has to be visible AT THE MOMENT OF
  // CHOOSING, not just in the warning afterwards -- otherwise the only
  // signal that a choice matters is the dialog telling you off.
  if (isRestrictedSpace(space)) {
    const lock = document.createElement('span');
    lock.className = 'spaces-membership-lock';
    lock.textContent = '🔒';
    lock.title = 'Members-only — only people with access can see this Space';
    lock.setAttribute('aria-label', 'members-only space');
    row.appendChild(lock);
  }

  if (space.kind === 'shared') {
    const badge = document.createElement('span');
    badge.className = 'spaces-membership-kind';
    badge.textContent = 'shared';
    row.appendChild(badge);
  }
  return row;
}

/**
 * Add or remove one membership. Optimistic: the checkbox already shows
 * the new state, so on failure we put it back and say why -- rather
 * than silently diverging from the graph.
 */
// ─── The union-rule guardrail ────────────────────────────────────────
//
// Asset visibility is a UNION: an item is visible if ANY Space it
// belongs to is visible. The Cypher says so outright —
//
//   "An item in both a restricted space and an open one is visible —
//    it genuinely lives in the open space."
//
// That was defensible when filing into a second Space meant hunting
// through a dropdown. It is not defensible now: the membership panel
// makes it one click, and the AI suggester actively proposes Spaces.
// So the single most likely way to leak a restricted asset is to
// accept a helpful suggestion.
//
// The rule itself stays — an item really does live in the open Space,
// and silently refusing would be worse. What changes is that the
// consequence is stated BEFORE it happens, and only in the case where
// it actually changes who can see the thing.

/** True when this Space is members-only. */
export function isRestrictedSpace(space: { visibility?: string } | undefined): boolean {
  return space?.visibility === 'restricted';
}

/**
 * Would adding this item to `target` widen who can see it?
 *
 * Only when the item is currently in at least one Space and EVERY one
 * of them is restricted, and the target is open. If the item already
 * sits in any open Space, or is uncategorized, its visibility is
 * already account-wide and this add changes nothing about exposure.
 */
export function wouldExposeRestrictedItem(
  currentSpaceIds: ReadonlySet<string>,
  target: { id: string; visibility?: string },
  allSpaces: ReadonlyArray<{ id: string; visibility?: string }>
): boolean {
  if (isRestrictedSpace(target)) return false;
  if (currentSpaceIds.size === 0) return false;
  const byId = new Map(allSpaces.map((s) => [s.id, s]));
  let known = 0;
  for (const id of currentSpaceIds) {
    const space = byId.get(id);
    // An unknown Space is one we cannot prove is restricted. Treat it
    // as open: better to skip the warning than to cry wolf on an item
    // that was already public, which trains people to click through.
    if (space === undefined) return false;
    if (!isRestrictedSpace(space)) return false;
    known += 1;
  }
  return known > 0;
}

/** Copy for the exposure confirmation. Names the consequence, not the rule. */
export function exposureWarningText(
  itemTitle: string,
  targetName: string,
  restrictedNames: ReadonlyArray<string>
): string {
  const from =
    restrictedNames.length === 1
      ? `“${restrictedNames[0]}”`
      : `${restrictedNames.length} members-only spaces`;
  return (
    `“${itemTitle}” is currently only in ${from}, so only people with access can see it.\n\n` +
    `Adding it to “${targetName}” makes it visible to everyone in the account — ` +
    `it stays in ${restrictedNames.length === 1 ? 'the members-only space' : 'those spaces'} too, ` +
    `but that no longer limits who can see it.`
  );
}

/** Space ids the item currently belongs to, from the rendered checkboxes. */
function currentSpaceIdsFor(itemId: string): ReadonlySet<string> {
  const ids = new Set<string>();
  const item = state.items.find((i) => i.id === itemId);
  for (const c of item?.otherSpaces ?? []) {
    if (typeof c.id === 'string') ids.add(c.id);
  }
  if (
    state.activeScopeId !== HOME_SCOPE_ID &&
    state.activeScopeId !== UNCATEGORIZED_SPACE_ID &&
    typeof state.activeScopeId === 'string' &&
    state.activeScopeId.length > 0
  ) {
    ids.add(state.activeScopeId);
  }
  return ids;
}

/** Display title for an item id, for use in confirmation copy. */
function itemTitleFor(itemId: string): string {
  const item = state.items.find((i) => i.id === itemId);
  const title = item?.title ?? '';
  return title.length > 0 ? title : 'This item';
}

async function toggleSpaceMembership(
  itemId: string,
  space: RendererSpace,
  box: HTMLInputElement
): Promise<void> {
  const bridge = window.lite?.spaces;
  if (bridge === undefined) return;
  const wantMember = box.checked;

  // Union-rule guardrail: adding a restricted-only item to an open
  // Space makes it visible account-wide. Say so before it happens.
  if (wantMember) {
    const currentIds = currentSpaceIdsFor(itemId);
    if (wouldExposeRestrictedItem(currentIds, space, state.spaces)) {
      const restrictedNames = [...currentIds]
        .map((id) => state.spaces.find((s) => s.id === id))
        .filter((s): s is RendererSpace => s !== undefined)
        .map((s) => (s.name.length > 0 ? s.name : '(unnamed)'));
      const title = itemTitleFor(itemId);
      const ok = await askToConfirm(
        'Make this visible to everyone?',
        exposureWarningText(title, space.name, restrictedNames),
        'Add anyway'
      );
      if (!ok) {
        box.checked = false;
        return;
      }
    }
  }

  box.disabled = true;
  try {
    const envelope = wantMember
      ? await bridge.items.addToSpace(itemId, space.id)
      : await bridge.items.removeFromSpace(itemId, space.id);
    if (envelope.ok === false) {
      box.checked = !wantMember;
      showToast(envelope.error.message);
      return;
    }
    showToast(wantMember ? `Added to ${space.name}` : `Removed from ${space.name}`);
    // Refresh counts + chips without collapsing the pane.
    void loadSpaces();
    void loadItems();
  } catch (err) {
    window.logging?.error?.('spaces', 'toggleSpaceMembership failed', { error: messageFrom(err) });
    box.checked = !wantMember;
    showToast(messageFrom(err));
  } finally {
    box.disabled = false;
  }
}

/**
 * Ask Claude which Spaces this item belongs in and render the shortlist
 * above the full list. Entirely best-effort: no AI key, a provider
 * error, or an empty shortlist all leave the panel exactly as it was.
 */
async function loadSpaceSuggestions(
  item: RendererItem,
  memberIds: ReadonlySet<string>,
  host: HTMLElement
): Promise<void> {
  const ai = window.lite?.ai;
  if (ai === undefined || typeof ai.suggestSpaces !== 'function') return;
  // An item living only in members-only Spaces is deliberately
  // limited. Because visibility is a UNION, suggesting an open Space
  // for it would be recommending the exposure -- the guardrail on the
  // checkbox would then have to argue against our own suggestion. So
  // for a restricted-only item, only other restricted Spaces are
  // offered. The user can still tick an open one by hand and confirm.
  const restrictedOnly =
    memberIds.size > 0 &&
    [...memberIds].every((id) =>
      isRestrictedSpace(state.spaces.find((s) => s.id === id))
    );

  // Only offer Spaces it is NOT already in -- suggesting a Space you
  // are already filed under is noise.
  const candidates = state.spaces
    .filter((sp) => !memberIds.has(sp.id))
    .filter((sp) => !restrictedOnly || isRestrictedSpace(sp))
    .map((sp) => ({
      id: sp.id,
      name: sp.name,
      ...(typeof sp.description === 'string' && sp.description.length > 0
        ? { description: sp.description }
        : {}),
    }));
  if (candidates.length === 0) return;

  try {
    const envelope = await ai.suggestSpaces(
      {
        title: item.title,
        kind: item.kind,
        ...(typeof item.content === 'string' && item.content.length > 0
          ? { text: item.content }
          : typeof item.excerpt === 'string'
            ? { text: item.excerpt }
            : {}),
      },
      candidates
    );
    if (envelope.ok === false) return;
    const list = envelope.value.suggestions;
    if (list.length === 0) return;
    // The pane may have moved on while we waited.
    if (state.activeItemId !== item.id) return;

    const heading = document.createElement('div');
    heading.className = 'spaces-membership-suggest-heading';
    heading.textContent = 'Suggested';
    host.appendChild(heading);

    for (const s of list) {
      // Validate against the CANDIDATES we sent, not all visible
      // Spaces: a hallucinated / echoed id that happens to name a real
      // open Space would otherwise render an Add button that exposes a
      // restricted asset (2026-08-07 review).
      const space = candidates.find((sp) => sp.id === s.spaceId);
      if (space === undefined) continue; // defensive: never render a phantom
      host.appendChild(buildSuggestionRow(item, space, s.reason));
    }
    host.hidden = host.children.length === 0;
  } catch (err) {
    window.logging?.warn?.('spaces', 'space suggestions load failed', { error: messageFrom(err) });
    /* suggestions are optional -- stay silent */
  }
}

/** A suggested Space: name, why, and a one-click Add. */
function buildSuggestionRow(
  item: RendererItem,
  space: RendererSpace,
  reason: string
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'spaces-membership-suggestion';

  const text = document.createElement('div');
  text.className = 'spaces-membership-suggestion-text';

  const name = document.createElement('span');
  name.className = 'spaces-membership-suggestion-name';
  name.textContent = space.name;
  text.appendChild(name);

  if (reason.length > 0) {
    const why = document.createElement('span');
    why.className = 'spaces-membership-suggestion-why';
    why.textContent = reason;
    text.appendChild(why);
  }
  row.appendChild(text);

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'spaces-membership-suggestion-add';
  add.textContent = 'Add';
  add.addEventListener('click', () => {
    add.disabled = true;
    void (async () => {
      const bridge = window.lite?.spaces;
      if (bridge === undefined) return;
      // A model-suggested destination is still a destination: run the
      // union-rule guardrail before filing a restricted-only asset
      // into an open Space (2026-08-07 review — this path skipped it).
      if (!(await confirmExposureIfNeeded(item.id, space.id))) {
        add.disabled = false;
        return;
      }
      try {
        const envelope = await bridge.items.addToSpace(item.id, space.id);
        if (envelope.ok === false) {
          showToast(envelope.error.message);
          add.disabled = false;
          return;
        }
        showToast(`Added to ${space.name}`);
        row.remove();
        // Tick the matching checkbox in the full list below.
        const box = document.querySelector<HTMLInputElement>(
          `.spaces-membership-row[data-space-id="${cssEscape(space.id)}"] .spaces-membership-check`
        );
        if (box !== null) box.checked = true;
        void loadSpaces();
        void loadItems();
      } catch (err) {
        window.logging?.error?.('spaces', 'suggestion add failed', { error: messageFrom(err) });
        showToast(messageFrom(err));
        add.disabled = false;
      }
    })();
  });
  row.appendChild(add);
  return row;
}

/**
 * Sprint 3 — "Move to…" picker. Renders a select with every visible
 * Space; choosing one moves the asset (drops [:BELONGS_TO] to the
 * current scope when applicable, MERGEs new one to the target).
 */
function buildMoveToSpaceAffordance(
  item: RendererItem,
  currentSpaceId: string | null
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'spaces-detail-move-wrap';
  const label = document.createElement('span');
  label.className = 'spaces-detail-label';
  label.textContent = 'Move to';
  wrap.appendChild(label);

  const select = document.createElement('select');
  select.className = 'spaces-detail-move-select';
  select.setAttribute('aria-label', 'Move to space');
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Choose a space…';
  placeholder.selected = true;
  select.appendChild(placeholder);
  for (const space of state.spaces) {
    if (space.id === currentSpaceId) continue;
    const opt = document.createElement('option');
    opt.value = space.id;
    opt.textContent = space.name.length > 0 ? space.name : '(unnamed)';
    if (space.kind === 'shared') opt.textContent += ' (shared)';
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    const toSpaceId = select.value;
    if (toSpaceId.length === 0) return;
    select.disabled = true;
    void performMoveAsset(item.id, currentSpaceId, toSpaceId, select);
  });
  wrap.appendChild(select);
  return wrap;
}

/**
 * Union-rule guardrail, shared by EVERY path that can put a
 * restricted-only asset into an open Space. The membership checkbox
 * had this; "Move to…", bulk move, and the AI-suggestion Add did not
 * — so the adjacent checkbox warned while the select next to it
 * exposed the asset silently (2026-08-07 review). Returns true when
 * the caller may proceed.
 */
async function confirmExposureIfNeeded(
  itemId: string,
  toSpaceId: string,
  currentIds?: ReadonlySet<string>
): Promise<boolean> {
  const space = state.spaces.find((s) => s.id === toSpaceId);
  if (space === undefined) return true;
  const ids = currentIds ?? currentSpaceIdsFor(itemId);
  if (!wouldExposeRestrictedItem(ids, space, state.spaces)) return true;
  const restrictedNames = [...ids]
    .map((id) => state.spaces.find((s) => s.id === id))
    .filter((s): s is RendererSpace => s !== undefined)
    .map((s) => (s.name.length > 0 ? s.name : '(unnamed)'));
  return askToConfirm(
    'Make this visible to everyone?',
    exposureWarningText(itemTitleFor(itemId), space.name, restrictedNames),
    'Move anyway'
  );
}

async function performMoveAsset(
  itemId: string,
  fromSpaceId: string | null,
  toSpaceId: string,
  select: HTMLSelectElement
): Promise<void> {
  const bridge = window.lite?.spaces;
  if (bridge === undefined) {
    showToast('Bridge unavailable.');
    select.disabled = false;
    return;
  }
  if (!(await confirmExposureIfNeeded(itemId, toSpaceId))) {
    select.value = '';
    select.disabled = false;
    return;
  }
  try {
    const envelope = await bridge.items.moveToSpace(itemId, fromSpaceId, toSpaceId);
    if (envelope.ok === false) {
      showToast(envelope.error.message);
      select.disabled = false;
      return;
    }
    const targetSpace = state.spaces.find((s) => s.id === toSpaceId);
    showToast(`Moved to ${targetSpace?.name ?? toSpaceId}`);
    // If the user was viewing the source space, the asset just left
    // it — re-render the list. Otherwise just refresh the detail pane.
    if (state.activeScopeId === fromSpaceId) {
      await loadItems();
    }
    await loadItemDetail(itemId);
  } catch (err) {
    window.logging?.error?.('spaces', 'moveAsset failed', { itemId, toSpaceId, error: messageFrom(err) });
    showToast(messageFrom(err));
    select.disabled = false;
  }
}


/**
 * Sprint 1 — "Delete asset" button. Sits at the bottom of the detail
 * pane below other affordances. Clicking soft-deletes the asset with
 * an undo toast; no confirm step (the toast is the undo).
 */
function buildAssetDeleteAffordance(itemId: string, title: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'spaces-detail-delete-wrap';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'spaces-detail-delete';
  btn.textContent = 'Delete asset';
  btn.title = 'Soft-delete (reversible via Undo)';
  btn.addEventListener('click', () => {
    btn.disabled = true;
    void performAssetSoftDelete(itemId, title);
  });
  wrap.appendChild(btn);
  return wrap;
}

/**
 * "Set as playbook" button rendered below the detail pane on shared
 * spaces. Promotes the current asset (any kind) via
 * `bridge.playbooks.set` and refreshes the dashboard cache.
 */
function buildSetAsPlaybookAffordance(
  spaceId: string,
  itemId: string,
  alreadyPlaybook = false
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'spaces-detail-set-playbook-wrap';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'spaces-detail-set-playbook';
  // An asset that is already playbook-shaped isn't being "promoted" —
  // it's being designated. Say the true thing in each case.
  btn.textContent = alreadyPlaybook ? 'Make this the current playbook' : 'Set as playbook';
  btn.title = alreadyPlaybook
    ? 'Make this the plan agents work against for this space'
    : 'Promote this asset to be the current playbook for this space';
  btn.addEventListener('click', () => {
    void (async () => {
      // Designating a playbook REDIRECTS the agents working this Space
      // — the highest-consequence action on the detail pane, and it
      // fired on a single unexplained click (2026-08-18 confirm audit).
      const ok = await askToConfirm(
        'Make this the current playbook?',
        'Agents working this Space switch to this plan. The previous playbook ' +
          'stays in the Space and keeps its tickets — you can switch back at ' +
          'any time.',
        'Set as playbook'
      );
      if (!ok) return;
      await promoteToPlaybook(spaceId, itemId, btn);
    })();
  });
  wrap.appendChild(btn);
  return wrap;
}

async function promoteToPlaybook(
  spaceId: string,
  itemId: string,
  btn: HTMLButtonElement
): Promise<void> {
  const bridge = window.lite?.spaces;
  if (bridge === undefined) return;
  btn.disabled = true;
  btn.textContent = 'Promoting…';
  try {
    const envelope = await bridge.playbooks.set(spaceId, itemId);
    if (envelope.ok === false) {
      btn.textContent = 'Set as playbook';
      btn.disabled = false;
      showToast(envelope.error.message);
      return;
    }
    showToast('Set as playbook');
    // Refresh both the detail pane (item kind has flipped to 'playbook')
    // and the dashboard cache.
    await Promise.all([
      loadItemDetail(itemId),
      loadSharedSpaceDashboard(spaceId),
    ]);
  } catch (err) {
    window.logging?.error?.('spaces', 'promoteToPlaybook failed', { spaceId, itemId, error: messageFrom(err) });
    btn.textContent = 'Set as playbook';
    btn.disabled = false;
    showToast(messageFrom(err));
  }
}

interface RendererDetailEditCallbacks {
  onMetadataAdd: (key: string, value: string) => Promise<void>;
  onMetadataRemove: (key: string) => Promise<void>;
  /** Replace a metadata value in place. Called from the click-to-edit
   *  affordance on the value cell. The string is re-coerced server-side
   *  the same way `onMetadataAdd` coerces (numeric → number, etc). */
  onMetadataValueEdit: (key: string, value: string) => Promise<void>;
  /** Auto-fill metadata via Claude 4.8. Optional -- only wired when the
   *  AI bridge (`window.lite.ai`) is present. */
  onMetadataAutoFill?: () => Promise<void>;
  onTitleSave: (next: string) => Promise<void>;
  onTypeChange: (next: string) => Promise<void>;
  onTagAdd: (tag: string) => Promise<void>;
  onTagRemove: (tag: string) => Promise<void>;
  /** Save the Markdown / text content body. Triggered by the Edit
   *  affordance in the detail content block. */
  onContentSave: (next: string) => Promise<void>;
  /** Save the asset description. Empty string clears it. Reaches every
   *  kind via the meta strip's editable subtitle row. */
  onDescriptionSave: (next: string) => Promise<void>;
}

/**
 * Commit an item update through the bridge. After a successful
 * write the renderer re-fetches the item so the detail pane reflects
 * the new server state. Errors surface as a thrown promise so the
 * editable widget can rollback.
 */
async function commitItemUpdate(
  itemId: string,
  patch: { title?: string; description?: string; content?: string; type?: string }
): Promise<void> {
  const bridge = window.lite?.spaces;
  if (bridge === undefined) throw new Error('Bridge unavailable');
  const editorId = readCurrentEditorId();
  const envelope = await bridge.items.update(itemId, {
    ...patch,
    ...(editorId !== null ? { editorId } : {}),
  } as Parameters<typeof bridge.items.update>[1]);
  if (envelope.ok === false) {
    throw new Error(envelope.error.message);
  }
  // Refresh by re-running loadItemDetail so the pane re-paints with
  // the freshly-fetched Item (including the new updatedAt / lastEditedBy).
  await loadItemDetail(itemId);
}

async function commitTagAdd(itemId: string, tag: string): Promise<void> {
  const bridge = window.lite?.spaces;
  if (bridge === undefined) throw new Error('Bridge unavailable');
  const envelope = await bridge.items.addTag(itemId, tag);
  if (envelope.ok === false) throw new Error(envelope.error.message);
  await loadItemDetail(itemId);
}

async function commitTagRemove(itemId: string, tag: string): Promise<void> {
  const bridge = window.lite?.spaces;
  if (bridge === undefined) throw new Error('Bridge unavailable');
  const envelope = await bridge.items.removeTag(itemId, tag);
  if (envelope.ok === false) throw new Error(envelope.error.message);
  await loadItemDetail(itemId);
}

/**
 * Metadata sprint — patch one key/value pair into the bag. The value
 * string is coerced into a primitive when possible: "true"/"false" →
 * booleans, numeric strings → numbers, "null" → null, comma-separated
 * lists → arrays of primitives.
 */
async function commitMetadataAdd(
  itemId: string,
  key: string,
  value: string
): Promise<void> {
  const bridge = window.lite?.spaces;
  if (bridge === undefined) throw new Error('Bridge unavailable');
  const coerced = coerceMetadataValue(value);
  // `LiteItemMetadata` is stricter (primitive | primitive[]) than the
  // coerceMetadataValue return type. The runtime guarantees the
  // coerced value IS a metadata value; the cast pins the type for the
  // bridge call site.
  const patch: Parameters<typeof bridge.items.patchMetadata>[1] = {
    [key]: coerced as LiteMetadataValue,
  };
  const envelope = await bridge.items.patchMetadata(itemId, patch);
  if (envelope.ok === false) throw new Error(envelope.error.message);
  await loadItemDetail(itemId);
}

async function commitMetadataRemove(itemId: string, key: string): Promise<void> {
  const bridge = window.lite?.spaces;
  if (bridge === undefined) throw new Error('Bridge unavailable');
  const envelope = await bridge.items.removeMetadataKey(itemId, key);
  if (envelope.ok === false) throw new Error(envelope.error.message);
  await loadItemDetail(itemId);
}

/**
 * Manual "✨ Auto-fill metadata" action. Asks the main process to run
 * Claude over the asset and persist `ai_*` metadata, then refreshes the
 * detail pane. Surfaces a toast on success and (re-)throws on failure so
 * the button restores its label.
 */
async function autoFillMetadata(itemId: string): Promise<void> {
  const ai = window.lite?.ai;
  if (ai === undefined) throw new Error('AI is not available');
  const envelope = await ai.enrichAsset(itemId);
  if (envelope.ok === false) {
    showToast(envelope.error.message);
    throw new Error(envelope.error.message);
  }
  const n = Object.keys(envelope.value.written).length;
  showToast(`✨ Added ${n} metadata field${n === 1 ? '' : 's'}`);
  await loadItemDetail(itemId);
}

/**
 * Renderer-side eligibility for auto-on-create enrichment: only fire when
 * Claude has something to read (text body, an image, or a PDF). This is a
 * token-saving pre-check before the IPC round-trip; the main-side
 * `enrichAsset` itself never gates (the manual button always runs).
 */
function isAutoEnrichEligibleRenderer(opts: {
  kind: string;
  mimeType?: string;
  hasContent: boolean;
}): boolean {
  if (opts.hasContent) return true;
  if (opts.kind === 'image') return true;
  const mime = (opts.mimeType ?? '').toLowerCase();
  if (mime === 'application/pdf') return true;
  // Uploaded text-like files (.txt/.md/.csv/.json/code) store their bytes
  // as a base64 data-URL, so hasContent is false at this layer -- but the
  // enricher decodes the data-URL back to text, so they ARE enrichable.
  if (mime.startsWith('text/') || /(json|csv|xml|yaml|markdown|javascript|ecmascript|typescript|html)/.test(mime)) {
    return true;
  }
  return false;
}

/**
 * Background auto-enrichment fired right after an asset is created.
 * Best-effort + silent: skips when AI isn't configured (so we never
 * toast a "not configured" error on every create), and swallows
 * failures. On success it refreshes the item list so the new metadata
 * is reflected.
 */
async function autoEnrichOnCreate(
  itemId: string,
  opts: { kind: string; mimeType?: string; hasContent: boolean }
): Promise<void> {
  const ai = window.lite?.ai;
  if (ai === undefined) return;
  if (!isAutoEnrichEligibleRenderer(opts)) return;
  try {
    const has = await ai.hasKey();
    if (!has.ok || !has.value.hasKey) return; // not configured -> stay silent
    const envelope = await ai.enrichAsset(itemId);
    if (envelope.ok) {
      showToast('✨ Metadata added automatically');
      await loadItems();
    }
  } catch (err) {
    window.logging?.warn?.('spaces', 'auto-enrich on create failed', { error: messageFrom(err) });
    // best-effort: a failed auto-enrich never disrupts the create flow.
  }
}

/**
 * Coerce a string typed by the user in the metadata editor into a
 * MetadataValue. Heuristic, not strict — the goal is to give power
 * users smart defaults while keeping the input field plain text.
 */
function coerceMetadataValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  // Number coercion — accept ints, floats, scientific notation.
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return n;
  }
  // Array literal: comma-separated values inside [].
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* fall through to string */
    }
  }
  return trimmed;
}

/**
 * Best-effort `:Person.id` for the current editor. Reads from the
 * prefetched `state.currentUser` (populated on boot by
 * `loadCurrentUser()`). Returns null when not yet resolved or signed
 * out — the SDK then falls into the "anonymous edit" path.
 */
function readCurrentEditorId(): string | null {
  return state.currentUser?.id ?? null;
}

/** Display name for activity attribution; null when identity unknown. */
function readCurrentEditorName(): string | null {
  const name = state.currentUser?.name ?? '';
  return name.length > 0 ? name : null;
}

function showDetailRail(show: boolean): void {
  const layout = document.querySelector<HTMLElement>('.spaces-layout');
  const aside = document.getElementById('spaces-detail');
  if (aside !== null) {
    if (show) aside.removeAttribute('hidden');
    else aside.setAttribute('hidden', '');
  }
  if (layout !== null) layout.classList.toggle('has-detail', show);
}

/**
 * Detail pane preview mode for text-kind items.
 * - `'rendered'` — show the content as Markdown-rendered HTML.
 * - `'source'` — show the raw text in a `<pre>`.
 */
export type DetailPreviewMode = 'rendered' | 'source';

/**
 * Build the per-item detail pane. Replaces the cramped right-rail
 * preview with a proper asset view: kind badge + filename, meta strip
 * (size · date · author · last-edited-by), tag chips, Markdown-aware
 * content body with preview/source toggle, and type-specific
 * subsections.
 *
 * Pure-ish: any DOM the caller passes is owned by the caller; we
 * just construct a wrapper they append. The preview-mode toggle
 * holds state INSIDE the returned subtree (no external state needed)
 * so re-rendering the pane on data refresh resets the toggle
 * sensibly (rendered is the default; users who flipped to source
 * see it return to rendered, which is fine for a refresh-driven UI).
 */
/**
 * Phase 3b edit callbacks. When passed to `buildDetailPane`, the
 * pane gains in-place edit affordances:
 *   - Title becomes click-to-edit (Enter / blur saves; Esc cancels)
 *   - A "Reclassify" dropdown appears in the header
 *   - Tag chips gain × delete buttons; an "+ Add tag" input is appended
 *
 * When `edit` is undefined the pane is fully read-only (current Phase A
 * behavior). Each callback returns a Promise; the renderer shows a
 * pending UI state while it resolves and re-throws errors as inline
 * messages so the user can retry.
 */
export interface DetailEditCallbacks {
  onTitleSave?: (next: string) => Promise<void>;
  onTypeChange?: (next: string) => Promise<void>;
  onTagAdd?: (tag: string) => Promise<void>;
  onTagRemove?: (tag: string) => Promise<void>;
  /** Metadata sprint — add a new key/value pair. */
  onMetadataAdd?: (key: string, value: string) => Promise<void>;
  /** Metadata sprint — overwrite the value at an existing key. Powers the
   *  click-to-edit affordance on the `<dd>` cell. Re-uses the same
   *  coercion path as `onMetadataAdd` (numeric strings → numbers,
   *  "true"/"false" → booleans, comma-separated → arrays). */
  onMetadataValueEdit?: (key: string, value: string) => Promise<void>;
  /** Metadata sprint — remove a key. */
  onMetadataRemove?: (key: string) => Promise<void>;
  /**
   * Save the Markdown / text content body. When provided, the detail
   * content block grows an "Edit" affordance that swaps the rendered
   * Markdown for a textarea + Save/Cancel buttons.
   */
  onContentSave?: (next: string) => Promise<void>;
  /**
   * Save the asset description (the short prose blurb under the meta
   * strip). When provided, the detail rail grows a click-to-edit
   * description block that reaches every kind — captions for images,
   * summaries for videos, notes on tickets, abstracts on PDFs.
   * Pass an empty string to clear.
   */
  onDescriptionSave?: (next: string) => Promise<void>;
}

const EDITABLE_ITEM_KINDS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'document', label: 'Doc' },
  { id: 'image', label: 'Image' },
  { id: 'url', label: 'URL' },
  { id: 'text', label: 'Text' },
  { id: 'audio', label: 'Audio' },
  { id: 'video', label: 'Video' },
  { id: 'agent', label: 'Agent' },
  { id: 'transcript', label: 'Transcript' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'journey', label: 'Journey' },
  { id: 'other', label: 'Other' },
];

/**
 * A safe, extension-bearing filename for downloading an item. Uses the
 * friendly title, strips filesystem-hostile chars, and appends an
 * extension inferred from mimeType (preferred) or kind.
 */
export function downloadFilenameForItem(item: RendererItem): string {
  const base =
    generateItemTitle(item)
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'asset';
  const mime = typeof item.mimeType === 'string' ? item.mimeType.toLowerCase() : '';
  const byMime: Record<string, string> = {
    'text/markdown': 'md',
    'text/plain': 'txt',
    'text/html': 'html',
    'application/json': 'json',
    'text/csv': 'csv',
    'application/pdf': 'pdf',
  };
  let ext = byMime[mime] ?? '';
  if (ext === '' && mime.includes('/')) ext = mime.split('/')[1]?.split(';')[0] ?? '';
  if (ext === '') {
    // Inline knowledge/playbook/transcript/text render as markdown.
    ext = ['knowledge', 'playbook', 'transcript', 'journey'].includes(item.kind)
      ? 'md'
      : 'txt';
  }
  return /\.[a-z0-9]{1,8}$/i.test(base) ? base : `${base}.${ext}`;
}

/** Trigger a browser download of a Blob/URL as `filename`. */
function triggerDownload(href: string, filename: string, revoke: boolean): void {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.rel = 'noopener noreferrer';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (revoke) setTimeout(() => URL.revokeObjectURL(href), 4000);
}

/**
 * Build the detail-header Download button, or null when there is
 * genuinely nothing to download (no inline content AND no file). Inline
 * content saves client-side; binary items resolve the signed URL.
 */
export function buildDetailDownloadButton(item: RendererItem): HTMLButtonElement | null {
  const hasInline = typeof item.content === 'string' && item.content.length > 0;
  const hasFile = typeof item.fileKey === 'string' && item.fileKey.length > 0;
  if (!hasInline && !hasFile) return null;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'spaces-detail-download-btn';
  btn.setAttribute('aria-label', 'Download this asset');
  btn.title = 'Download';
  btn.textContent = '⤓';

  btn.addEventListener('click', () => {
    // Prefer real file bytes when this is a binary asset; else save the
    // inline content the pane is showing.
    if (hasFile) {
      void downloadBinaryItem(item, btn);
      return;
    }
    try {
      const mime =
        typeof item.mimeType === 'string' && item.mimeType.length > 0
          ? item.mimeType
          : 'text/markdown';
      const blob = new Blob([item.content ?? ''], { type: mime });
      const url = URL.createObjectURL(blob);
      triggerDownload(url, downloadFilenameForItem(item), true);
    } catch (err) {
      window.logging?.warn?.('spaces', 'inline download failed', {
        itemId: item.id,
        error: messageFrom(err),
      });
    }
  });
  return btn;
}

/** Resolve a binary item's signed URL and save it. Soft-fails to inline. */
async function downloadBinaryItem(item: RendererItem, btn: HTMLButtonElement): Promise<void> {
  const bridge = window.lite?.spaces;
  const key = item.fileKey;
  if (bridge === undefined || typeof key !== 'string' || key.length === 0) return;
  // Already an absolute URL (some producers store the URL as the key).
  if (/^https?:\/\//i.test(key)) {
    triggerDownload(key, downloadFilenameForItem(item), false);
    return;
  }
  const prev = btn.textContent;
  btn.textContent = '…';
  btn.disabled = true;
  try {
    const envelope = await bridge.items.resolveFileUrl(key);
    if (envelope.ok === true && typeof envelope.value === 'string' && envelope.value.length > 0) {
      triggerDownload(envelope.value, downloadFilenameForItem(item), false);
    } else if (typeof item.content === 'string' && item.content.length > 0) {
      // Fall back to the inline content if the signed URL can't mint.
      const blob = new Blob([item.content], { type: item.mimeType ?? 'text/plain' });
      const url = URL.createObjectURL(blob);
      triggerDownload(url, downloadFilenameForItem(item), true);
    } else {
      window.logging?.warn?.('spaces', 'download: no signed url', { itemId: item.id });
    }
  } catch (err) {
    window.logging?.warn?.('spaces', 'binary download failed', {
      itemId: item.id,
      error: messageFrom(err),
    });
  } finally {
    btn.textContent = prev;
    btn.disabled = false;
  }
}

export function buildDetailPane(
  item: RendererItem,
  onClose: () => void,
  initialMode: DetailPreviewMode = 'rendered',
  edit?: DetailEditCallbacks
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'spaces-detail-pane';

  // ── Header: kind badge (or reclassify dropdown) + close button ───────
  const header = document.createElement('div');
  header.className = 'spaces-detail-head';

  if (edit?.onTypeChange !== undefined) {
    header.appendChild(buildKindReclassify(item, edit.onTypeChange));
  } else {
    const kind = document.createElement('span');
    kind.className = `spaces-card-kind spaces-card-kind-${item.kind}`;
    kind.textContent = kindLabel(item.kind);
    header.appendChild(kind);
  }

  // MIME-type hint when present (e.g. "image/png"). Sits next to the
  // kind badge in a muted style — useful when the canonical `a.type`
  // collapsed to 'other' but the MIME tells the real story.
  if (typeof item.mimeType === 'string' && item.mimeType.length > 0) {
    const mime = document.createElement('span');
    mime.className = 'spaces-detail-mime';
    mime.textContent = friendlyMime(item.mimeType);
    // The raw type is still available on hover for anyone debugging.
    mime.title = item.mimeType;
    header.appendChild(mime);
  }

  // Universal download: EVERY asset can be saved. Inline-content items
  // (text / markdown / knowledge / playbook / transcript) download
  // client-side as a file; binary items resolve their signed URL. This
  // is the header's job so it's discoverable on every kind, not buried
  // in a preview (2026-08-10 — "no way to download an asset").
  const dlBtn = buildDetailDownloadButton(item);
  if (dlBtn !== null) header.appendChild(dlBtn);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'spaces-detail-close';
  closeBtn.setAttribute('aria-label', 'Close detail');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => onClose());
  header.appendChild(closeBtn);

  wrap.appendChild(header);

  // ── Spaces↔WISER bridge (playbooks only) ─────────────────────────
  // One click from the asset to the instrument. If the asset carries a
  // riff id in metadata (riffId / wiserRiffId — written by WISER
  // exports), the window deep-links straight to that playbook via
  // ?riff=<id>; otherwise it opens the app plainly. Hidden entirely
  // when the preload doesn't expose the bridge.
  if (item.kind === 'playbook') {
    const openWiser = wiserOpenBridge();
    if (openWiser !== null) {
      const meta = (item.metadata ?? {}) as Record<string, unknown>;
      const riffId =
        typeof meta.riffId === 'string' && meta.riffId.length > 0
          ? meta.riffId
          : typeof meta.wiserRiffId === 'string' && meta.wiserRiffId.length > 0
            ? meta.wiserRiffId
            : null;
      const bridgeRow = document.createElement('div');
      bridgeRow.className = 'spaces-detail-wiser';
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'spaces-detail-wiser-btn';
      openBtn.textContent =
        riffId !== null ? 'Open in WISER Playbooks' : 'Open WISER Playbooks';
      openBtn.title =
        riffId !== null
          ? 'Open this playbook in WISER Playbooks'
          : 'Open WISER Playbooks (this asset has no linked riff id)';
      openBtn.addEventListener('click', () => {
        void openWiser(riffId).catch((err: unknown) => {
          window.logging?.warn?.('spaces', 'openWiser failed', {
            itemId: item.id,
            error: messageFrom(err),
          });
        });
      });
      bridgeRow.appendChild(openBtn);
      wrap.appendChild(bridgeRow);
    }
  }

  // ── Spaces↔Journey Map Builder bridge (journeys only) ────────────
  // The mirror of the WISER row above: a journey asset opens in the
  // real Builder, which reads and writes it back through the same
  // Space. Hidden when the preload doesn't expose the bridge.
  if (item.kind === 'journey') {
    const openJourney = journeyOpenBridge();
    if (openJourney !== null) {
      const bridgeRow = document.createElement('div');
      bridgeRow.className = 'spaces-detail-wiser';
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'spaces-detail-wiser-btn';
      openBtn.textContent = 'Open in Journey Map Builder';
      openBtn.title = 'Open this journey map in the Journey Map Builder';
      openBtn.addEventListener('click', () => {
        void openJourney(item.id).catch((err: unknown) => {
          window.logging?.warn?.('spaces', 'openJourneyMap failed', {
            itemId: item.id,
            error: messageFrom(err),
          });
        });
      });
      bridgeRow.appendChild(openBtn);
      wrap.appendChild(bridgeRow);
    }
  }

  // ── Title (click-to-edit when callback is present) ───────────────────
  // The displayed value is always `generateItemTitle(item)` so the
  // detail rail never shows an opaque hex id even when the underlying
  // `:Asset.name`/`:Asset.title` is unset. If the user opens the
  // editor the field pre-populates with the generated title; saving
  // unchanged is a no-op (per `buildEditableTitle.commit`), so the
  // user can accept the generated label by editing then re-saving.
  const displayTitle = generateItemTitle(item);
  if (edit?.onTitleSave !== undefined) {
    wrap.appendChild(buildEditableTitle(displayTitle, edit.onTitleSave));
  } else {
    const title = document.createElement('h2');
    title.className = 'spaces-detail-title';
    title.textContent = displayTitle;
    wrap.appendChild(title);
  }

  // ── Identity line: ONE "who · when" surface near the title.
  //    The attribution chip ("Created by … / Last edited by … · 3h")
  //    is the primary identity; the meta strip carries the
  //    complementary "Updated … · size". When the chip renders we
  //    suppress the meta strip's redundant producer line so the
  //    producer name isn't printed twice — that stacked who/when text
  //    was the heaviness in the old layout.
  const chip = buildAttributionChip(item);
  if (chip !== null) wrap.appendChild(chip);
  wrap.appendChild(buildDetailMeta(item, { suppressProvenance: chip !== null }));

  // ── HERO: the asset itself ───────────────────────────────────────────
  // A preview should lead with the content, not with six lines of
  // metadata. The file preview + content body now sit directly under
  // the identity line; description / tags / spaces / metadata flow
  // below as supporting detail.

  // File preview slot (binary assets). For items with a fileKey we
  // render a placeholder block upfront so the user sees "loading" /
  // "unavailable" feedback; `resolveAndInjectFileUrl` swaps in the
  // real preview (image / audio / video / PDF embed / download link).
  if (typeof item.fileKey === 'string' && item.fileKey.length > 0) {
    wrap.appendChild(buildPreviewPlaceholder(item));
  }

  // Content body — kind-aware preview dispatch.
  const hasContent =
    typeof item.content === 'string' && item.content.length > 0;
  if (hasContent) {
    const content = item.content as string;
    // Agents lead with their OKF definition rendered as structured text.
    if (item.kind === 'agent') {
      wrap.appendChild(buildAgentOkfBlock(item, content));
    } else if (isBase64DataUrl(content)) {
    // Inline uploads stash the file's bytes as a base64 data URL in
    // `content` (no Files-API upload yet — that's a future
    // enhancement). Route those straight to the binary preview so
    // PDFs / images / audio / video render via <embed> / <img> /
    // <audio> / <video> instead of dumping the base64 blob into the
    // Markdown renderer.
      wrap.appendChild(buildBinaryPreview(item, content));
    } else {
      const language = detectTextPreviewLanguage(item.mimeType, item.title);
      if (language === 'csv' || language === 'tsv') {
        wrap.appendChild(buildCsvPreview(content));
      } else if (language !== null && language !== 'markdown') {
        // Code-like content: render as syntax-highlighted block.
        wrap.appendChild(buildCodePreview(content, language));
      } else {
        // Markdown / unspecified text: existing Markdown renderer.
        // When the pane was wired with edit callbacks, pass the
        // content-save callback so the block grows an "✎ Edit"
        // affordance for in-place Markdown editing.
        wrap.appendChild(
          buildDetailContent(
            content,
            initialMode,
            edit?.onContentSave !== undefined
              ? { onSave: edit.onContentSave }
              : {}
          )
        );
      }
    }
  }

  // Type-specific subsection (source link, audio/video player).
  const subsection = buildDetailTypeBlock(item);
  if (subsection !== null) wrap.appendChild(subsection);

  // Empty-content hint: when the asset has nothing renderable -- no
  // inline content, no fileKey preview, no sourceUrl, no type-specific
  // block -- show an honest empty state explaining what's missing for
  // this kind, so the rail doesn't read as "click did nothing."
  const hasFilePreview =
    typeof item.fileKey === 'string' && item.fileKey.length > 0;
  if (!hasContent && !hasFilePreview && subsection === null) {
    wrap.appendChild(buildDetailEmptyContentHint(item));
  }

  // ── Supporting detail (below the hero) ───────────────────────────────

  // Description: prose blurb / caption / abstract. Click-to-edit when
  // editable; reaches every kind via the same affordance (captions on
  // images, summaries on videos, abstracts on PDFs, notes on tickets).
  const descBlock = buildEditableDescription(item, edit?.onDescriptionSave);
  if (descBlock !== null) wrap.appendChild(descBlock);

  // Tag chips (with × buttons + "+ Add tag" when editable).
  const tagsRow = buildDetailTags(item.tags ?? [], edit);
  if (tagsRow.children.length > 0) wrap.appendChild(tagsRow);

  // Space-membership chips.
  if (item.otherSpaces.length > 0) {
    const chips = document.createElement('div');
    chips.className = 'spaces-detail-chips';
    for (const chip of item.otherSpaces) {
      chips.appendChild(buildSpaceChip(chip));
    }
    wrap.appendChild(chips);
  }

  // Metadata section: always rendered so users can add fields even
  // when the bag is empty.
  wrap.appendChild(buildDetailMetadata(item, edit));

  // ── Activity slot (Phase 3c): empty container that `loadItemActivity`
  //    populates with `buildDetailActivity(events)` once the per-asset
  //    commit log loads. Carries the item id so the loader can confirm
  //    the user hasn't switched items mid-flight.
  const activitySlot = document.createElement('section');
  activitySlot.className = 'spaces-detail-activity-slot';
  activitySlot.setAttribute('data-activity-slot', item.id);
  wrap.appendChild(activitySlot);

  // ── Viewed-by slot (2026-08-10): who has looked at this asset, from
  //    the graph audit trail. Empty until `loadItemViewers` fills it.
  const viewersSlot = document.createElement('section');
  viewersSlot.className = 'spaces-detail-viewers-slot';
  viewersSlot.setAttribute('data-viewers-slot', item.id);
  wrap.appendChild(viewersSlot);

  // ── History slot (ADR-057): version list, lazy-loaded. Empty (hidden)
  //    until the loader confirms the asset actually has snapshots.
  const historySlot = document.createElement('section');
  historySlot.className = 'spaces-detail-history-slot';
  historySlot.setAttribute('data-history-slot', item.id);
  wrap.appendChild(historySlot);

  return wrap;
}

/**
 * Metadata-sprint detail block. Renders the item's `metadata` bag as
 * a key/value table with a "+ Add field" affordance below. Each row
 * has a × delete button when an `onMetadataKeyRemove` callback is
 * provided (i.e. the pane is in editable mode).
 *
 * Pure DOM construction — the actual writes live in the renderer's
 * state-machine wrapper (`commitMetadataPatch`).
 */
export interface DetailMetadataCallbacks {
  /** Called when the user adds a new key/value pair. */
  onMetadataAdd?: (key: string, value: string) => Promise<void>;
  /** Called when the user overwrites the value at an existing key.
   *  Powers the click-to-edit affordance on the value cell. */
  onMetadataValueEdit?: (key: string, value: string) => Promise<void>;
  /** Called when the user removes a key. */
  onMetadataRemove?: (key: string) => Promise<void>;
  /** Called when the user clicks "Auto-fill metadata" (Claude 4.8).
   *  Present only when the AI bridge is available. */
  onMetadataAutoFill?: () => Promise<void>;
}

export function buildDetailMetadata(
  item: RendererItem,
  edit?: DetailMetadataCallbacks
): HTMLElement {
  const wrap = document.createElement('section');
  wrap.className = 'spaces-detail-metadata';
  wrap.setAttribute('data-item-id', item.id);

  const headingRow = document.createElement('div');
  headingRow.className = 'spaces-detail-metadata-heading-row';
  const heading = document.createElement('h3');
  heading.className = 'spaces-detail-metadata-heading';
  heading.textContent = 'Metadata';
  headingRow.appendChild(heading);
  // "✨ Auto-fill metadata" (Claude 4.8) lives in the heading row so it's
  // reachable whether or not the asset already has metadata.
  if (edit?.onMetadataAutoFill !== undefined) {
    headingRow.appendChild(buildAutoFillButton(edit.onMetadataAutoFill));
  }
  wrap.appendChild(headingRow);

  const meta = item.metadata ?? {};
  const keys = Object.keys(meta);
  if (keys.length === 0 && edit?.onMetadataAdd === undefined) {
    const empty = document.createElement('p');
    empty.className = 'spaces-detail-metadata-empty';
    empty.textContent = 'No metadata recorded for this asset.';
    wrap.appendChild(empty);
    return wrap;
  }

  if (keys.length > 0) {
    const table = document.createElement('dl');
    table.className = 'spaces-detail-metadata-table';
    for (const key of keys.sort()) {
      const value = meta[key];
      const row = document.createElement('div');
      row.className = 'spaces-detail-metadata-row';
      row.setAttribute('data-key', key);

      const dt = document.createElement('dt');
      dt.className = 'spaces-detail-metadata-key';
      dt.textContent = key;
      row.appendChild(dt);

      const dd = document.createElement('dd');
      dd.className = 'spaces-detail-metadata-value';
      dd.textContent = formatMetadataValue(value);
      row.appendChild(dd);

      // Click-to-edit on the value cell. Calls `onMetadataValueEdit`
      // which goes through the same coercion path as `onMetadataAdd`
      // (numeric strings → numbers, "true"/"false" → booleans, etc).
      if (edit?.onMetadataValueEdit !== undefined) {
        const onEdit = edit.onMetadataValueEdit;
        dd.classList.add('is-editable');
        dd.title = 'Click to edit';
        dd.setAttribute('role', 'button');
        dd.setAttribute('tabindex', '0');
        const startEdit = (): void => {
          enterMetadataValueEdit(dd, key, value, onEdit);
        };
        dd.addEventListener('click', startEdit);
        dd.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            startEdit();
          }
        });
      }

      if (edit?.onMetadataRemove !== undefined) {
        const onRemove = edit.onMetadataRemove;
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'spaces-detail-metadata-remove';
        x.setAttribute('aria-label', `Remove ${key}`);
        x.title = `Remove "${key}"`;
        x.textContent = '×';
        x.addEventListener('click', () => {
          x.disabled = true;
          row.classList.add('is-removing');
          onRemove(key).catch((err) => {
            window.logging?.error?.('spaces', 'metadata remove failed', { key, error: messageFrom(err) });
            x.disabled = false;
            row.classList.remove('is-removing');
          });
        });
        row.appendChild(x);
      }
      table.appendChild(row);
    }
    wrap.appendChild(table);
  }

  if (edit?.onMetadataAdd !== undefined) {
    wrap.appendChild(buildAddMetadataAffordance(edit.onMetadataAdd));
  }
  return wrap;
}

/**
 * "✨ Auto-fill metadata" button. Calls the Claude-backed enrichment
 * callback; shows an in-flight state and restores on completion. The
 * callback itself refreshes the detail pane on success, so this button's
 * node may be replaced out from under it — guard every DOM touch.
 */
function buildAutoFillButton(onAutoFill: () => Promise<void>): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'spaces-detail-metadata-autofill';
  button.textContent = '✨ Auto-fill';
  button.setAttribute('aria-label', 'Auto-fill metadata with AI');
  button.title = 'Use Claude to generate a summary, tags, topics, and more';
  button.addEventListener('click', () => {
    if (button.disabled) return;
    button.disabled = true;
    const original = button.textContent;
    button.textContent = '✨ Extracting…';
    void onAutoFill()
      .catch((err) => {
        window.logging?.warn?.('spaces', 'metadata auto-fill failed', { error: messageFrom(err) });
        // Errors surface as a toast inside the callback; nothing to do
        // here beyond restoring the button if it's still mounted.
      })
      .finally(() => {
        if (button.isConnected) {
          button.disabled = false;
          button.textContent = original;
        }
      });
  });
  return button;
}

/** Compact display formatter — keeps the value column readable. */
function formatMetadataValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') {
    // Trim trailing zeros after a decimal point so "1.5" beats "1.5000".
    return Number.isInteger(v) ? String(v) : Number(v.toFixed(4)).toString();
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    if (v.length <= 5) return v.map((x) => formatMetadataValue(x)).join(', ');
    return `${v.slice(0, 5).map((x) => formatMetadataValue(x)).join(', ')} … (+${v.length - 5})`;
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * "+ Add field" affordance for the metadata table. Swaps to two
 * inputs (key + value) when clicked. Enter commits via onAdd; Esc
 * cancels.
 */
function buildAddMetadataAffordance(
  onAdd: (key: string, value: string) => Promise<void>
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'spaces-detail-metadata-add-wrap';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'spaces-detail-metadata-add';
  button.textContent = '+ Add field';
  wrap.appendChild(button);

  const enter = (): void => {
    const form = document.createElement('div');
    form.className = 'spaces-detail-metadata-add-form';

    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.className = 'spaces-detail-metadata-add-key';
    keyInput.placeholder = 'key';
    keyInput.maxLength = 64;

    const valueInput = document.createElement('input');
    valueInput.type = 'text';
    valueInput.className = 'spaces-detail-metadata-add-value';
    valueInput.placeholder = 'value';
    valueInput.maxLength = 400;

    const commit = async (): Promise<void> => {
      const key = keyInput.value.trim();
      const value = valueInput.value.trim();
      if (key.length === 0 || value.length === 0) {
        wrap.replaceChildren(button);
        return;
      }
      keyInput.disabled = true;
      valueInput.disabled = true;
      wrap.classList.add('is-saving');
      try {
        await onAdd(key, value);
      } catch (err) {
        window.logging?.error?.('spaces', 'metadata add failed', { key, error: messageFrom(err) });
        keyInput.disabled = false;
        valueInput.disabled = false;
        wrap.classList.remove('is-saving');
        return;
      }
      wrap.classList.remove('is-saving');
      wrap.replaceChildren(button);
    };
    const cancel = (): void => {
      wrap.replaceChildren(button);
    };
    keyInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        valueInput.focus();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        cancel();
      }
    });
    valueInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        void commit();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        cancel();
      }
    });
    form.appendChild(keyInput);
    form.appendChild(valueInput);
    wrap.replaceChildren(form);
    keyInput.focus();
  };
  button.addEventListener('click', enter);
  return wrap;
}

/**
 * Reclassify dropdown. Renders the current kind as a `<select>`
 * styled to match the read-only kind pill. Change → invokes the
 * onTypeChange callback; while pending, the select is disabled.
 */
export function buildKindReclassify(
  item: RendererItem,
  onTypeChange: (next: string) => Promise<void>
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = `spaces-detail-reclassify spaces-card-kind spaces-card-kind-${item.kind}`;
  wrap.setAttribute('data-current-kind', item.kind);

  const select = document.createElement('select');
  select.className = 'spaces-detail-reclassify-select';
  select.setAttribute('aria-label', 'Reclassify item');
  for (const k of EDITABLE_ITEM_KINDS) {
    const opt = document.createElement('option');
    opt.value = k.id;
    opt.textContent = k.label;
    if (k.id === item.kind) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    const next = select.value;
    if (next === item.kind) return;
    select.disabled = true;
    wrap.classList.add('is-saving');
    onTypeChange(next)
      .catch((err) => {
        window.logging?.error?.('spaces', 'kind reclassify failed', { itemId: item.id, error: messageFrom(err) });
        // Rollback the select on error so the user sees the prior
        // kind. The state-machine wrapper logs the failure via
        // the bridge's normalized error envelope.
        select.value = item.kind;
      })
      .finally(() => {
        select.disabled = false;
        wrap.classList.remove('is-saving');
      });
  });
  wrap.appendChild(select);
  return wrap;
}

/**
 * Click-to-edit title. Plain `<h2>` until clicked, then swaps to an
 * `<input>` with the current text pre-selected. Enter or blur saves
 * via `onTitleSave`; Esc reverts. Pure DOM construction (no module
 * state); the save callback owns the side-effecting bridge call.
 */
export function buildEditableTitle(
  initial: string,
  onTitleSave: (next: string) => Promise<void>
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'spaces-detail-title-wrap';

  const display = document.createElement('h2');
  display.className = 'spaces-detail-title is-editable';
  display.setAttribute('role', 'button');
  display.setAttribute('tabindex', '0');
  display.setAttribute('title', 'Click to rename');
  display.textContent = initial.length > 0 ? initial : '(untitled)';

  let current = initial;
  let editing = false;

  const enterEdit = (): void => {
    if (editing) return;
    editing = true;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'spaces-detail-title-input';
    input.value = current;
    input.maxLength = 200;
    input.setAttribute('aria-label', 'Edit title');
    wrap.replaceChildren(input);
    input.focus();
    input.select();

    const commit = async (): Promise<void> => {
      const next = input.value.trim();
      if (next.length === 0 || next === current) {
        // Empty or unchanged → bail without a network call.
        editing = false;
        display.textContent = current.length > 0 ? current : '(untitled)';
        wrap.replaceChildren(display);
        return;
      }
      input.disabled = true;
      wrap.classList.add('is-saving');
      try {
        await onTitleSave(next);
        current = next;
        display.textContent = next;
      } catch (err) {
        window.logging?.error?.('spaces', 'title save failed', { error: messageFrom(err) });
        // Leave the prior value visible and the input populated so
        // the user can retry without retyping.
        input.disabled = false;
        wrap.classList.remove('is-saving');
        return;
      }
      editing = false;
      wrap.classList.remove('is-saving');
      wrap.replaceChildren(display);
    };

    const cancel = (): void => {
      editing = false;
      wrap.replaceChildren(display);
    };

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        void commit();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        cancel();
      }
    });
    input.addEventListener('blur', () => void commit());
  };

  display.addEventListener('click', enterEdit);
  display.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      enterEdit();
    }
  });
  wrap.appendChild(display);
  return wrap;
}

/**
 * Editable asset-description block. Behaviour parallels
 * `buildEditableTitle` but in textarea form:
 *   - Read mode (callback present, has description): prose paragraph
 *     with a click target that swaps in the editor.
 *   - Read mode (callback present, no description): muted placeholder
 *     ("Add a description…") that also doubles as the click target.
 *   - Read-only mode (no callback): renders the paragraph when there's
 *     a description; returns `null` (caller omits the block) when not.
 *
 * The editor uses Cmd/Ctrl+Enter to save and Esc to cancel, mirroring
 * the space-objective editor + the Markdown content editor so the
 * keyboard shortcuts are uniform across in-place editors.
 */
export function buildEditableDescription(
  item: RendererItem,
  onSave?: (next: string) => Promise<void>
): HTMLElement | null {
  // `description` isn't on the canonical RendererItem (LiteSpaceItem) —
  // some producers project it onto Item.metadata or Item.excerpt
  // instead. We read it via a structural cast so typecheck stays clean
  // and the runtime branch handles "undefined" gracefully.
  const desc = (item as { description?: unknown }).description;
  const initial = typeof desc === 'string' ? desc : '';
  const editable = typeof onSave === 'function';

  if (!editable && initial.length === 0) return null;

  const wrap = document.createElement('div');
  wrap.className = 'spaces-detail-description-wrap';

  const display = document.createElement('p');
  display.className = 'spaces-detail-description';
  if (initial.length > 0) {
    display.textContent = initial;
  } else {
    display.textContent = 'Add a description…';
    display.classList.add('is-placeholder');
  }
  if (editable) {
    display.classList.add('is-editable');
    display.setAttribute('role', 'button');
    display.setAttribute('tabindex', '0');
    display.title =
      initial.length > 0 ? 'Click to edit description' : 'Click to add a description';
  }

  let current = initial;
  let editing = false;

  const enterEdit = (): void => {
    if (!editable || editing) return;
    editing = true;
    const editor = document.createElement('div');
    editor.className = 'spaces-detail-description-editor';

    const textarea = document.createElement('textarea');
    textarea.className = 'spaces-detail-description-input';
    textarea.value = current;
    textarea.rows = 3;
    // Description field is capped at 1000 chars in the SDK's
    // validateUpdatePatch (matches MAX_ITEM_DESCRIPTION_LENGTH).
    textarea.maxLength = 1000;
    textarea.placeholder =
      'What is this asset about? Captions, abstracts, notes, context — anything that helps you (or another agent) find it later.';
    textarea.spellcheck = true;
    editor.appendChild(textarea);

    const actions = document.createElement('div');
    actions.className = 'spaces-detail-description-actions';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'spaces-detail-description-save';
    saveBtn.textContent = 'Save';
    actions.appendChild(saveBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'spaces-detail-description-cancel';
    cancelBtn.textContent = 'Cancel';
    actions.appendChild(cancelBtn);

    const hint = document.createElement('span');
    hint.className = 'spaces-detail-description-hint';
    hint.textContent = '⌘↵ Save · Esc Cancel';
    actions.appendChild(hint);

    editor.appendChild(actions);
    wrap.replaceChildren(editor);
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    const restoreDisplay = (value: string): void => {
      current = value;
      if (value.length > 0) {
        display.textContent = value;
        display.classList.remove('is-placeholder');
        display.title = 'Click to edit description';
      } else {
        display.textContent = 'Add a description…';
        display.classList.add('is-placeholder');
        display.title = 'Click to add a description';
      }
      editing = false;
      wrap.replaceChildren(display);
    };

    const cancel = (): void => {
      restoreDisplay(current);
    };

    const commit = async (): Promise<void> => {
      const next = textarea.value.trim();
      if (next === current.trim()) {
        cancel();
        return;
      }
      textarea.disabled = true;
      saveBtn.disabled = true;
      cancelBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        await onSave!(next);
        restoreDisplay(next);
      } catch (err) {
        window.logging?.error?.('spaces', 'description save failed', { error: messageFrom(err) });
        // Leave the editor open with the typed text intact so the user
        // can retry without retyping. The bridge surface logs the
        // failure via the normalized error envelope.
        textarea.disabled = false;
        saveBtn.disabled = false;
        cancelBtn.disabled = false;
        saveBtn.textContent = 'Save';
      }
    };

    saveBtn.addEventListener('click', () => {
      void commit();
    });
    cancelBtn.addEventListener('click', cancel);
    textarea.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        cancel();
        return;
      }
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault();
        void commit();
      }
    });
  };

  if (editable) {
    display.addEventListener('click', enterEdit);
    display.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        enterEdit();
      }
    });
  }

  wrap.appendChild(display);
  return wrap;
}

/**
 * In-place metadata value editor. Swaps the `<dd>` cell for an input
 * pre-populated with the current value. Enter saves; Esc cancels. The
 * value flows through the same coercion path as `onMetadataAdd`
 * (numeric strings → numbers, "true"/"false" → booleans, comma
 * separated → arrays).
 */
function enterMetadataValueEdit(
  dd: HTMLElement,
  key: string,
  currentValue: unknown,
  onEdit: (key: string, value: string) => Promise<void>
): void {
  // If a previous edit on this row is in flight we'd overwrite its
  // pending state — guard by checking for an existing input child.
  if (dd.querySelector('input') !== null) return;

  const initial = formatMetadataValue(currentValue);
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'spaces-detail-metadata-value-input';
  input.value = initial === '—' ? '' : initial;
  input.maxLength = 400;
  input.setAttribute('aria-label', `Edit value for ${key}`);

  const oldContent = dd.textContent ?? '';
  dd.textContent = '';
  dd.appendChild(input);
  input.focus();
  input.select();

  const restore = (text: string): void => {
    dd.textContent = text;
  };

  const cancel = (): void => {
    restore(oldContent);
  };

  const commit = async (): Promise<void> => {
    const next = input.value.trim();
    if (next === initial.trim() || next.length === 0) {
      cancel();
      return;
    }
    input.disabled = true;
    dd.classList.add('is-saving');
    try {
      await onEdit(key, next);
      // The renderer re-paints from the freshly-fetched item; this DOM
      // node is about to be replaced. Leaving the input in place is
      // fine — the parent <dd> goes away on the re-render.
    } catch (err) {
      window.logging?.error?.('spaces', 'metadata value save failed', { error: messageFrom(err) });
      input.disabled = false;
      dd.classList.remove('is-saving');
      // Leave the input populated so the user can retry without
      // retyping. The bridge surface logged the failure already.
    }
  };

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      void commit();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      cancel();
    }
  });
  // Blur outside the row → cancel rather than commit so accidental
  // clicks elsewhere don't write a partial value. The user must
  // explicitly press Enter to save.
  input.addEventListener('blur', () => {
    if (!input.isConnected) return;
    // Defer to the next tick so a click on a different chrome element
    // (the × delete button, say) doesn't race the blur handler.
    setTimeout(() => {
      if (input.isConnected) cancel();
    }, 50);
  });
}

/** Meta strip: relative time · size · producer · last-edited-by. */
export function buildDetailMeta(
  item: RendererItem,
  opts: { suppressProvenance?: boolean } = {}
): HTMLElement {
  const meta = document.createElement('div');
  meta.className = 'spaces-detail-meta';

  const parts: string[] = [];
  parts.push(`Updated ${formatRelativeTime(item.updatedAt)}`);
  if (typeof item.size === 'number' && item.size > 0) {
    parts.push(formatBytes(item.size));
  }
  meta.appendChild(document.createTextNode(parts.join(' · ')));

  // Provenance + last-edited-by on a second line so the primary
  // updated/size info reads clean.
  //
  // `suppressProvenance` is set by `buildDetailPane` when the
  // attribution chip is already rendered above this strip — otherwise
  // the producer name prints twice ("Created by X" in the chip AND
  // "Produced by X (Agent)" here), which is the stacked who/when text
  // that made the preview read heavy. Standalone callers (and the
  // builder's own unit tests) keep the default — provenance shown.
  if (
    opts.suppressProvenance !== true &&
    (item.producedBy !== null || (item.lastEditedBy ?? null) !== null)
  ) {
    const provLine = document.createElement('div');
    provLine.className = 'spaces-detail-provenance';
    const segments: string[] = [];
    if (item.producedBy !== null) {
      segments.push(`Produced by ${item.producedBy.name} (${item.producedBy.kind})`);
    }
    const edited = item.lastEditedBy ?? null;
    if (edited !== null && edited.id !== item.producedBy?.id) {
      segments.push(`Last edited by ${edited.name}`);
    }
    provLine.textContent = segments.join(' · ');
    meta.appendChild(provLine);
  }
  return meta;
}

/**
 * Tag chip row. Phase A renders read-only chips; Phase B adds × delete
 * buttons + an "+ Add tag" input when `edit` callbacks are supplied.
 *
 * When neither tags NOR an `onTagAdd` callback are present, returns
 * an empty container (caller can skip appending).
 */
export function buildDetailTags(
  tags: ReadonlyArray<string>,
  edit?: DetailEditCallbacks
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'spaces-detail-tags';
  for (const tag of tags) {
    if (typeof tag !== 'string' || tag.trim().length === 0) continue;
    const chip = document.createElement('span');
    chip.className = 'spaces-detail-tag';

    const label = document.createElement('span');
    label.className = 'spaces-detail-tag-label';
    label.textContent = tag.trim();
    chip.appendChild(label);

    if (edit?.onTagRemove !== undefined) {
      const cb = edit.onTagRemove;
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'spaces-detail-tag-remove';
      x.setAttribute('aria-label', `Remove tag ${tag.trim()}`);
      x.title = `Remove "${tag.trim()}"`;
      x.textContent = '×';
      x.addEventListener('click', () => {
        x.disabled = true;
        chip.classList.add('is-removing');
        cb(tag.trim()).catch((err) => {
          window.logging?.error?.('spaces', 'tag remove failed', { error: messageFrom(err) });
          x.disabled = false;
          chip.classList.remove('is-removing');
        });
      });
      chip.appendChild(x);
    }
    row.appendChild(chip);
  }

  if (edit?.onTagAdd !== undefined) {
    row.appendChild(buildAddTagAffordance(edit.onTagAdd));
  }
  return row;
}

/** "+ Add tag" affordance — button that swaps to an input on click. */
function buildAddTagAffordance(onAdd: (tag: string) => Promise<void>): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'spaces-detail-tag-add-wrap';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'spaces-detail-tag-add';
  button.textContent = '+ Add tag';
  button.addEventListener('click', () => enterAddMode());
  wrap.appendChild(button);

  const enterAddMode = (): void => {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'spaces-detail-tag-input';
    input.maxLength = 60;
    input.placeholder = 'tag name';
    input.setAttribute('aria-label', 'New tag');
    wrap.replaceChildren(input);
    input.focus();

    const commit = async (): Promise<void> => {
      const next = input.value.trim();
      if (next.length === 0) {
        wrap.replaceChildren(button);
        return;
      }
      input.disabled = true;
      wrap.classList.add('is-saving');
      try {
        await onAdd(next);
      } catch (err) {
        window.logging?.error?.('spaces', 'tag add failed', { error: messageFrom(err) });
        input.disabled = false;
        wrap.classList.remove('is-saving');
        return;
      }
      wrap.classList.remove('is-saving');
      wrap.replaceChildren(button);
    };

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        void commit();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        wrap.replaceChildren(button);
      }
    });
    input.addEventListener('blur', () => {
      // Only commit if there's something to commit; otherwise just
      // collapse back to the button. Prevents a stray empty save on
      // every blur.
      if (input.value.trim().length === 0) {
        wrap.replaceChildren(button);
      } else {
        void commit();
      }
    });
  };
  return wrap;
}

/**
 * Content body for text/document kinds. Renders Markdown by default
 * (the `'rendered'` mode) with a toggle to flip to raw `'source'`.
 * For non-text kinds the caller typically skips this; we still
 * render gracefully if `content` is present.
 */
export function buildDetailContent(
  source: string,
  initialMode: DetailPreviewMode,
  opts: { onSave?: (next: string) => Promise<void> } = {}
): HTMLElement {
  const block = document.createElement('div');
  block.className = 'spaces-detail-content-block';
  block.setAttribute('data-mode', initialMode);

  // Toggle row: Rendered / Source / (optional) Edit.
  const toggleRow = document.createElement('div');
  toggleRow.className = 'spaces-detail-content-toggle';

  const renderedBtn = document.createElement('button');
  renderedBtn.type = 'button';
  renderedBtn.className =
    'spaces-detail-toggle-btn' + (initialMode === 'rendered' ? ' is-active' : '');
  renderedBtn.textContent = 'Rendered';
  renderedBtn.setAttribute('data-mode', 'rendered');

  const sourceBtn = document.createElement('button');
  sourceBtn.type = 'button';
  sourceBtn.className =
    'spaces-detail-toggle-btn' + (initialMode === 'source' ? ' is-active' : '');
  sourceBtn.textContent = 'Source';
  sourceBtn.setAttribute('data-mode', 'source');

  toggleRow.appendChild(renderedBtn);
  toggleRow.appendChild(sourceBtn);

  // Edit affordance (appears when an `onSave` callback is supplied).
  // Clicking it swaps the body for a Markdown textarea + Save/Cancel.
  let editBtn: HTMLButtonElement | null = null;
  if (opts.onSave !== undefined) {
    editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'spaces-detail-toggle-btn spaces-detail-edit-btn';
    editBtn.textContent = '✎ Edit';
    editBtn.title = 'Edit the Markdown content';
    editBtn.setAttribute('aria-label', 'Edit content');
    toggleRow.appendChild(editBtn);
  }

  block.appendChild(toggleRow);

  const body = document.createElement('div');
  body.className = 'spaces-detail-content';
  body.appendChild(initialMode === 'rendered' ? renderMarkdown(source) : renderSource(source));
  block.appendChild(body);

  const setMode = (next: DetailPreviewMode): void => {
    block.setAttribute('data-mode', next);
    renderedBtn.classList.toggle('is-active', next === 'rendered');
    sourceBtn.classList.toggle('is-active', next === 'source');
    body.replaceChildren(next === 'rendered' ? renderMarkdown(source) : renderSource(source));
  };
  renderedBtn.addEventListener('click', () => setMode('rendered'));
  sourceBtn.addEventListener('click', () => setMode('source'));

  if (editBtn !== null && opts.onSave !== undefined) {
    const onSave = opts.onSave;
    editBtn.addEventListener('click', () => {
      enterContentEditMode(block, toggleRow, body, source, onSave);
    });
  }

  return block;
}

/**
 * Swap the detail-content body for a Markdown textarea + Save / Cancel
 * row. Cancel restores the original rendered view (unsaved edits
 * discarded); Save calls the supplied `onSave` callback. On a
 * successful save the parent will trigger a `loadItemDetail` refresh
 * which re-paints the whole rail with the freshly-fetched content --
 * so we don't need to manually update the rendered view; the rail
 * just re-mounts. On error, the textarea stays open with an inline
 * message so the user can retry.
 */
function enterContentEditMode(
  block: HTMLElement,
  toggleRow: HTMLElement,
  body: HTMLElement,
  source: string,
  onSave: (next: string) => Promise<void>
): void {
  block.setAttribute('data-mode', 'edit');
  // Hide the rendered/source toggle while editing -- a "you're
  // editing right now" indicator is more useful than the toggle.
  toggleRow.hidden = true;

  body.replaceChildren();

  const textarea = document.createElement('textarea');
  textarea.className = 'spaces-detail-content-textarea';
  textarea.value = source;
  textarea.setAttribute('aria-label', 'Edit Markdown content');
  textarea.spellcheck = true;
  body.appendChild(textarea);

  // Auto-size to content. Recompute on every keystroke so the editor
  // grows with the document rather than stuck at a fixed height.
  const autoSize = (): void => {
    textarea.style.height = 'auto';
    // +2 to dodge a 1-row scrollbar flicker on some platforms. Capped
    // at 640px so a long document scrolls inside the editor instead of
    // pushing the save/cancel actions below the fold.
    textarea.style.height = `${Math.min(textarea.scrollHeight + 2, 640)}px`;
  };
  // Defer until the element is in the DOM so scrollHeight is correct.
  requestAnimationFrame(autoSize);
  textarea.addEventListener('input', autoSize);

  const errorEl = document.createElement('div');
  errorEl.className = 'spaces-detail-content-edit-error';
  errorEl.hidden = true;

  const actions = document.createElement('div');
  actions.className = 'spaces-detail-content-edit-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'spaces-detail-content-edit-cancel';
  cancelBtn.textContent = 'Cancel';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'spaces-detail-content-edit-save';
  saveBtn.textContent = 'Save';

  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);

  body.appendChild(errorEl);
  body.appendChild(actions);

  const exitToRendered = (renderSource_: string): void => {
    toggleRow.hidden = false;
    block.setAttribute('data-mode', 'rendered');
    body.replaceChildren(renderMarkdown(renderSource_));
  };

  cancelBtn.addEventListener('click', () => {
    exitToRendered(source);
  });

  // Ctrl+Enter / Cmd+Enter saves; Escape cancels. Keyboard shortcuts
  // match what most Markdown editors do, so muscle memory carries over.
  textarea.addEventListener('keydown', (ev: KeyboardEvent) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
      ev.preventDefault();
      saveBtn.click();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      cancelBtn.click();
    }
  });

  saveBtn.addEventListener('click', () => {
    void (async () => {
      const next = textarea.value;
      saveBtn.disabled = true;
      cancelBtn.disabled = true;
      textarea.disabled = true;
      saveBtn.textContent = 'Saving…';
      errorEl.hidden = true;
      errorEl.textContent = '';
      try {
        await onSave(next);
        // commitItemUpdate re-paints the whole rail via loadItemDetail,
        // so this block is typically replaced. If somehow it's still
        // mounted (callback was a no-op stub, e.g. in tests), drop
        // back into rendered view with the new content.
        if (block.isConnected) {
          exitToRendered(next);
        }
      } catch (err) {
        window.logging?.error?.('spaces', 'content save failed', { error: messageFrom(err) });
        errorEl.textContent = (err as Error).message;
        errorEl.hidden = false;
        saveBtn.disabled = false;
        cancelBtn.disabled = false;
        textarea.disabled = false;
        saveBtn.textContent = 'Save';
        textarea.focus();
      }
    })();
  });

  textarea.focus();
  // Cursor at the end so Cmd+End-style editors continue typing.
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

function renderSource(source: string): HTMLElement {
  const pre = document.createElement('pre');
  pre.className = 'spaces-detail-source-pre';
  pre.textContent = source;
  return pre;
}

/**
 * Empty-content hint -- shown in the detail rail when an asset has no
 * inline content, no binary fileKey, and no sourceUrl. Instead of
 * rendering a silent gap (which the user reads as "click did
 * nothing"), this block names what's missing for the asset's kind
 * and -- in dev -- offers a hint about which graph property would
 * surface here.
 *
 * Pure; exported for tests.
 */
export function buildDetailEmptyContentHint(item: {
  kind?: string;
}): HTMLElement {
  const wrap = document.createElement('section');
  wrap.className = 'spaces-detail-empty';
  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-live', 'polite');

  const headline = document.createElement('p');
  headline.className = 'spaces-detail-empty-headline';

  const sub = document.createElement('p');
  sub.className = 'spaces-detail-empty-sub';

  const kind = typeof item.kind === 'string' ? item.kind : '';
  switch (kind) {
    case 'text':
    case 'document':
      headline.textContent = 'No text content saved for this item.';
      sub.textContent =
        'Once a transcript, note, or document body lands on this asset (graph property `:Asset.content`), it appears here.';
      break;
    case 'image':
      headline.textContent = 'No image attached.';
      sub.textContent =
        'When an image fileKey is set (graph property `:Asset.url`), a preview appears here.';
      break;
    case 'video':
      headline.textContent = 'No video attached.';
      sub.textContent =
        'When a video fileKey is set, a player appears here.';
      break;
    case 'audio':
      headline.textContent = 'No audio attached.';
      sub.textContent =
        'When an audio fileKey is set, a player appears here.';
      break;
    case 'url':
      headline.textContent = 'No external URL saved.';
      sub.textContent =
        'When `:Asset.sourceUrl` is set, the link appears here.';
      break;
    default:
      headline.textContent = 'This asset has no content yet.';
      sub.textContent =
        'Add a transcript, file, or link to make it useful. Authors and tags can be set independently.';
      break;
  }

  wrap.appendChild(headline);
  wrap.appendChild(sub);
  return wrap;
}

/**
 * Attribution chip (Phase 3c). Renders a single high-visibility line
 * summarizing the most relevant attribution for the asset:
 *
 *   - If `lastEditedBy` is set AND distinct from `producedBy`:
 *       "Last edited by [name] · [recency]"
 *   - Else if `producedBy` is set:
 *       "Created by [name] · [recency]"
 *   - Else: returns `null` (caller skips).
 *
 * The chip is purely visual: it duplicates information already in the
 * meta strip, but in a denser, more prominent style — surfacing the
 * "who" front-and-center for the collaborative use case.
 */
/**
 * A MIME type as a person would say it.
 *
 * The detail header showed `application/pdf` next to the kind badge —
 * accurate, and the wrong register for a header a non-engineer reads.
 * The raw value stays on the element's `title`, so nothing is lost for
 * anyone debugging a mis-typed asset.
 *
 * Falls back to the subtype in caps (`image/webp` -> `WEBP`), so an
 * unmapped format still reads as a format rather than a slash-pair.
 */
export function friendlyMime(raw: string | null | undefined): string {
  const mime = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (mime.length === 0) return '';
  const KNOWN: Record<string, string> = {
    'application/pdf': 'PDF',
    'text/markdown': 'Markdown',
    'text/plain': 'Text',
    'text/csv': 'CSV',
    'text/html': 'HTML',
    'application/json': 'JSON',
    'application/zip': 'ZIP',
    'application/msword': 'Word',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word',
    'application/vnd.ms-excel': 'Excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel',
    'application/vnd.ms-powerpoint': 'PowerPoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint',
  };
  const known = KNOWN[mime];
  if (known !== undefined) return known;
  const subtype = mime.split('/')[1] ?? '';
  if (subtype.length === 0) return mime.toUpperCase();
  // Strip vendor/suffix noise: `svg+xml` -> `SVG`, `x-wav` -> `WAV`.
  const cleaned = subtype.split('+')[0]?.replace(/^x-/, '') ?? subtype;
  return cleaned.toUpperCase();
}

/**
 * A display name that is safe to print, or the established  placeholder.
 *
 * Upstream producers have historically written a missing `name` as the
 * entity's own id (documented in LITE-PUNCH-LIST — it is how a Space
 * shipped to production named `402abae35ea49651576e3a8d61f3ee3a`). The
 * detail pane's identity line is the most prominent text on the pane,
 * so a raw GUID there is the single least-clean thing in the UI.
 *
 * Anything that looks like an identifier rather than a name — a UUID, a
 * long hex blob, or a string with no letters at all — is treated as
 * absent. Deliberately conservative: real names with digits or hyphens
 * ("Anne-Marie", "R2") must survive.
 */
export function displayPersonName(raw: string | null | undefined): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name.length === 0) return '(unknown)';
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const hexBlob = /^[0-9a-f]{24,}$/i;
  const hasLetter = /\p{L}/u.test(name);
  if (uuid.test(name) || hexBlob.test(name) || !hasLetter) return '(unknown)';
  return name;
}

export function buildAttributionChip(item: RendererItem): HTMLElement | null {
  const editor = item.lastEditedBy ?? null;
  const producer = item.producedBy;
  const editorDistinct = editor !== null && editor.id !== producer?.id;
  // Names arrive from the graph, where upstream producers historically
  // defaulted a missing `name` to the entity's own id — see
  // LITE-PUNCH-LIST. The renderer must not print that back at the user.

  let label: string;
  let name: string;
  let timeIso: string;
  if (editorDistinct) {
    label = 'Last edited by';
    name = displayPersonName(editor.name);
    timeIso = item.updatedAt;
  } else if (producer !== null) {
    label = 'Created by';
    name = displayPersonName(producer.name);
    timeIso = item.createdAt;
  } else {
    return null;
  }

  const chip = document.createElement('div');
  chip.className = 'spaces-detail-attribution-chip';

  const dot = document.createElement('span');
  dot.className = 'spaces-detail-attribution-dot';
  dot.setAttribute('aria-hidden', 'true');
  chip.appendChild(dot);

  const labelEl = document.createElement('span');
  labelEl.className = 'spaces-detail-attribution-label';
  labelEl.textContent = label;
  chip.appendChild(labelEl);

  chip.appendChild(document.createTextNode(' '));

  const nameEl = document.createElement('span');
  nameEl.className = 'spaces-detail-attribution-name';
  nameEl.textContent = name;
  chip.appendChild(nameEl);

  // Recency suffix; skipped when the timestamp is empty / unparseable
  // so we never render an awkward " · " trailing chip.
  const recency = formatRelativeTime(timeIso);
  if (recency.length > 0) {
    const sep = document.createElement('span');
    sep.className = 'spaces-detail-attribution-sep';
    sep.textContent = ' · ';
    chip.appendChild(sep);
    const timeEl = document.createElement('span');
    timeEl.className = 'spaces-detail-attribution-time';
    timeEl.textContent = recency;
    chip.appendChild(timeEl);
  }

  return chip;
}

/**
 * Activity log (Phase 3c). Renders a compact list of commits referencing
 * the current asset. Pure — the caller injects the event payload from a
 * separate bridge fetch. Empty input → returns an "empty state" line
 * so the slot stays visually anchored (instead of jumping when activity
 * lands).
 *
 * Each row: `[dot] [author] [verb] · [recency]`. We don't repeat the
 * object — every row is implicitly about THIS asset.
 */
export function buildDetailActivity(
  events: ReadonlyArray<RendererEvent>
): HTMLElement {
  const section = document.createElement('div');
  section.className = 'spaces-detail-activity';

  const heading = document.createElement('h3');
  heading.className = 'spaces-detail-activity-heading';
  heading.textContent = 'Activity';
  section.appendChild(heading);

  if (events.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'spaces-detail-activity-empty';
    empty.textContent = 'No recent activity recorded for this asset.';
    section.appendChild(empty);
    return section;
  }

  const list = document.createElement('ol');
  list.className = 'spaces-detail-activity-list';
  for (const ev of events) {
    list.appendChild(buildActivityRow(ev));
  }
  section.appendChild(list);
  return section;
}

/** One row of the per-asset activity log. */
function buildActivityRow(ev: RendererEvent): HTMLElement {
  const row = document.createElement('li');
  row.className = 'spaces-detail-activity-row';
  row.setAttribute('data-row-id', ev.id);

  const dot = document.createElement('span');
  dot.className = 'spaces-detail-activity-dot';
  dot.setAttribute('aria-hidden', 'true');
  row.appendChild(dot);

  const body = document.createElement('div');
  body.className = 'spaces-detail-activity-body';

  const headline = document.createElement('div');
  headline.className = 'spaces-detail-activity-headline';

  const authorEl = document.createElement('span');
  authorEl.className = 'spaces-detail-activity-author';
  const authorRaw = typeof ev.author === 'string' ? ev.author.trim() : '';
  authorEl.textContent = authorRaw.length > 0 ? prettyAuthor(authorRaw) : 'Someone';
  headline.appendChild(authorEl);

  const verbEl = document.createElement('span');
  verbEl.className = 'spaces-detail-activity-verb';
  verbEl.textContent = ` ${deriveVerb(ev.kind)}`;
  headline.appendChild(verbEl);

  body.appendChild(headline);

  const meta = document.createElement('div');
  meta.className = 'spaces-detail-activity-meta';
  const recency = formatRelativeTime(ev.timestamp);
  meta.textContent = recency.length > 0 ? recency : ev.timestamp;
  body.appendChild(meta);

  row.appendChild(body);
  return row;
}

// ─── Phase 4: shared-space primitives (ticket + playbook) ───────────────

type RendererTicketStatus = 'open' | 'in_progress' | 'done' | 'blocked';

const TICKET_STATUSES_ORDERED: ReadonlyArray<RendererTicketStatus> = [
  'open',
  'in_progress',
  'done',
  'blocked',
];

/** User-facing label for each ticket status; matches the SDK enum. */
const TICKET_STATUS_LABELS: Readonly<Record<RendererTicketStatus, string>> = {
  open: 'Open',
  in_progress: 'In progress',
  done: 'Done',
  blocked: 'Blocked',
};

/**
 * A reusable status pill — single span styled by `data-status`.
 * Used in both ticket cards and the ticket detail block.
 */
export function buildTicketStatusPill(status: RendererTicketStatus): HTMLElement {
  const pill = document.createElement('span');
  pill.className = 'spaces-ticket-status-pill';
  pill.setAttribute('data-status', status);
  pill.textContent = TICKET_STATUS_LABELS[status] ?? status;
  return pill;
}

/**
 * Ticket detail block. Surfaces status (editable when callback supplied),
 * priority, assignee, and a link back to the source playbook. Renders
 * only when `Item.kind === 'ticket'` AND `Item.ticket` is populated;
 * the caller (`buildDetailTypeBlock`) gates on those conditions.
 */
export interface DetailTicketCallbacks {
  /** Called when the user picks a new status from the dropdown. */
  onStatusChange?: (next: RendererTicketStatus) => Promise<void>;
  /** Called when the user clicks the "View playbook" link. */
  onOpenPlaybook?: (playbookId: string) => void;
}

// ─── Ticket checklists (ADR-055) ─────────────────────────────────────
//
// Pre-flight and post-flight checklists on a ticket, run in place.
// A required preflight gates the ticket out of `open`; a required
// postflight gates it out of `done` — the gate itself lives in the
// SDK; this section is where the run happens, at the pause point.

/** Progress label: "3/7". */
export function checklistProgressLabel(link: {
  checkedIndexes: number[];
  checklist: { items: Array<{ text: string; optional?: boolean }> };
}): string {
  const items = link.checklist.items;
  const requiredIdx = items
    .map((item, i) => (item.optional === true ? -1 : i))
    .filter((i) => i >= 0);
  // No optional items → the familiar "3/7".
  if (requiredIdx.length === items.length) {
    return `${link.checkedIndexes.length}/${items.length}`;
  }
  const checked = new Set(link.checkedIndexes);
  const requiredDone = requiredIdx.filter((i) => checked.has(i)).length;
  const optionalDone = link.checkedIndexes.length - requiredDone;
  return `${requiredDone}/${requiredIdx.length} required · ${optionalDone} optional done`;
}

/**
 * Parse the create-panel's items textarea: one item per line, a `!`
 * prefix marks a killer item. Blank lines dropped.
 */
export function parseChecklistDraft(raw: string): Array<{ text: string; killer?: boolean }> {
  const out: Array<{ text: string; killer?: boolean }> = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('!')) {
      const text = trimmed.slice(1).trim();
      if (text.length > 0) out.push({ text, killer: true });
    } else {
      out.push({ text: trimmed });
    }
  }
  return out;
}

function buildTicketChecklistsSection(item: RendererItem): HTMLElement {
  const wrap = document.createElement('section');
  wrap.className = 'spaces-ticket-checklists';

  const head = document.createElement('div');
  head.className = 'spaces-ticket-checklists-head';
  const label = document.createElement('span');
  label.className = 'spaces-detail-label';
  label.textContent = 'Checklists';
  head.appendChild(label);
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'spaces-checklist-add-btn';
  add.textContent = '+ Attach';
  add.addEventListener('click', () => {
    void openAttachChecklistPanel(item, () => reload());
  });
  head.appendChild(add);
  wrap.appendChild(head);

  const list = document.createElement('div');
  list.className = 'spaces-ticket-checklists-list';
  wrap.appendChild(list);

  const reload = async (): Promise<void> => {
    const bridge = window.lite?.spaces;
    if (bridge?.checklists === undefined) return;
    try {
      const envelope = await bridge.checklists.forTicket(item.id);
      if (envelope.ok === false) return;
      list.replaceChildren();
      const links = envelope.value;
      if (links.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'spaces-checklist-empty';
        empty.textContent =
          'No checklists. Attach a pre-flight (gates starting) or post-flight (gates done).';
        list.appendChild(empty);
        return;
      }
      for (const link of links) {
        list.appendChild(buildChecklistRunCard(item, link, reload));
      }
    } catch (err) {
      window.logging?.warn?.('spaces', 'ticket checklists load failed', { error: messageFrom(err) });
      /* soft — the ticket pane still works without checklists */
    }
  };
  void reload();
  return wrap;
}

function buildChecklistRunCard(
  item: RendererItem,
  link: LiteTicketChecklistView,
  reload: () => Promise<void>
): HTMLElement {
  const card = document.createElement('div');
  card.className = `spaces-checklist-card${link.complete ? ' is-complete' : ''}`;

  const head = document.createElement('div');
  head.className = 'spaces-checklist-card-head';

  const phase = document.createElement('span');
  phase.className = `spaces-checklist-phase spaces-checklist-phase-${link.phase}`;
  phase.textContent = link.phase === 'preflight' ? 'PRE-FLIGHT' : 'POST-FLIGHT';
  head.appendChild(phase);

  const name = document.createElement('span');
  name.className = 'spaces-checklist-name';
  name.textContent = link.checklist.name;
  head.appendChild(name);

  if (link.obligation === 'required') {
    const req = document.createElement('span');
    req.className = 'spaces-checklist-required';
    req.textContent = 'required';
    req.title =
      link.phase === 'preflight'
        ? 'Must be complete before this ticket can start'
        : 'Must be complete before this ticket can be done';
    head.appendChild(req);
  } else if (link.obligation === 'recommended') {
    const rec = document.createElement('span');
    rec.className = 'spaces-checklist-recommended';
    rec.textContent = 'recommended';
    head.appendChild(rec);
  }

  const progress = document.createElement('span');
  progress.className = 'spaces-checklist-progress';
  progress.textContent = checklistProgressLabel(link);
  head.appendChild(progress);

  card.appendChild(head);

  // Pause point + mode — the doctrine, visible at the point of use.
  const meta = document.createElement('div');
  meta.className = 'spaces-checklist-meta';
  meta.textContent = `${link.checklist.mode} · ${link.checklist.pausePoint}`;
  card.appendChild(meta);

  const items = document.createElement('div');
  items.className = 'spaces-checklist-items';
  const checked = new Set(link.checkedIndexes);
  link.checklist.items.forEach((spec, index) => {
    const wrap = document.createElement('div');
    wrap.className = 'spaces-checklist-item-wrap';
    const row = document.createElement('label');
    row.className = `spaces-checklist-item${spec.killer === true ? ' is-killer' : ''}${spec.optional === true ? ' is-optional' : ''}`;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = checked.has(index);
    box.addEventListener('change', () => {
      void toggleChecklistItem(item, link, index, box, reload);
    });
    row.appendChild(box);
    const text = document.createElement('span');
    text.className = 'spaces-checklist-item-text';
    text.textContent = spec.text;
    if (spec.killer === true) {
      text.title = 'Killer item — the step most dangerous to skip';
    }
    row.appendChild(text);
    if (spec.optional === true) {
      const badge = document.createElement('span');
      badge.className = 'spaces-checklist-item-optional';
      badge.textContent = 'optional';
      badge.title = 'Does not count toward completing this checklist';
      row.appendChild(badge);
    }
    wrap.appendChild(row);
    if (typeof spec.more === 'string' && spec.more.length > 0) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'spaces-checklist-item-more-toggle';
      toggle.textContent = 'more ▸';
      row.appendChild(toggle);
      const more = document.createElement('p');
      more.className = 'spaces-checklist-item-more';
      more.textContent = spec.more;
      more.hidden = true;
      wrap.appendChild(more);
      toggle.addEventListener('click', (ev) => {
        // Inside a <label>: don't let the accordion toggle the checkbox.
        ev.preventDefault();
        ev.stopPropagation();
        more.hidden = !more.hidden;
        toggle.textContent = more.hidden ? 'more ▸' : 'more ▾';
      });
    }
    items.appendChild(wrap);
  });
  card.appendChild(items);
  return card;
}

async function toggleChecklistItem(
  item: RendererItem,
  link: LiteTicketChecklistView,
  index: number,
  box: HTMLInputElement,
  reload: () => Promise<void>
): Promise<void> {
  const bridge = window.lite?.spaces;
  if (bridge?.checklists === undefined) return;
  box.disabled = true;
  try {
    const envelope = await bridge.checklists.setItem({
      ticketId: item.id,
      checklistId: link.checklist.id,
      phase: link.phase,
      itemIndex: index,
      checked: box.checked,
    });
    if (envelope.ok === false) {
      box.checked = !box.checked;
      showToast(envelope.error.message);
      return;
    }
    if (envelope.value.complete) {
      showToast(`“${link.checklist.name}” complete`);
    }
    await reload();
  } catch (err) {
    window.logging?.error?.('spaces', 'checklist item toggle failed', { error: messageFrom(err) });
    box.checked = !box.checked;
    showToast(messageFrom(err));
  } finally {
    box.disabled = false;
  }
}

/** Attach-or-create panel, in the house inline-panel shell. */
// ─── Checklist library (Space manager, ADR-055 addendum) ───────────────

/**
 * Checklist library cache. This section is rebuilt on EVERY dashboard
 * render, so an uncached fetch here added a fourth Neon query to the
 * render→fetch→render loop (2026-08-17 bandwidth incident). Same TTL
 * contract as the dashboard itself; mutations pass force=true.
 */
const checklistLibraryCache = new Map<
  string,
  { items: LiteChecklistView[]; fetchedAt: number }
>();
const checklistLibraryInFlight = new Set<string>();

/** The Space's checklist library: list, view items, new, edit, delete. */
export function buildSharedDashboardChecklists(space: RendererSpace): HTMLElement {
  const section = document.createElement('section');
  section.className = 'spaces-dashboard-section spaces-checklist-library';

  const head = document.createElement('div');
  head.className = 'spaces-dashboard-section-head';
  const title = document.createElement('h3');
  title.className = 'spaces-dashboard-section-title';
  title.textContent = 'Checklists';
  head.appendChild(title);
  const newBtn = document.createElement('button');
  newBtn.type = 'button';
  newBtn.className = 'spaces-items-new spaces-checklist-new';
  newBtn.textContent = '+ New checklist';
  newBtn.addEventListener('click', () => {
    // A throw here used to mean "nothing happened" with no trace.
    try {
      openChecklistEditorPanel({ spaceId: space.id, onSaved: () => refresh(true) });
      if (document.querySelector('.spaces-checklist-editor') === null) {
        window.logging?.warn?.('spaces', 'checklist editor did not mount', { spaceId: space.id });
        showToast('Couldn’t open the checklist editor — see Help → Report issue.');
      }
    } catch (err) {
      window.logging?.error?.('spaces', 'checklist editor threw', {
        spaceId: space.id,
        error: messageFrom(err),
      });
      showToast(`Couldn’t open the checklist editor: ${messageFrom(err)}`);
    }
  });
  head.appendChild(newBtn);
  section.appendChild(head);

  const host = document.createElement('div');
  host.className = 'spaces-checklist-library-list';
  host.textContent = 'Loading…';
  section.appendChild(host);

  const paint = (lists: LiteChecklistView[]): void => {
    host.replaceChildren();
    if (lists.length === 0) {
      const none = document.createElement('p');
      none.className = 'spaces-checklist-empty';
      none.textContent =
        'No checklists yet. A checklist is a reusable, versioned artifact that runs on tickets at a pause point.';
      host.appendChild(none);
      return;
    }
    for (const c of lists) {
      host.appendChild(buildChecklistLibraryCard(space, c, () => refresh(true)));
    }
  };

  const refresh = (force = false): void => {
    // Bridge check FIRST: a cached list must never mask a missing
    // bridge, or a torn build silently shows stale checklists that
    // cannot be opened, created, or run.
    if (window.lite?.spaces?.checklists === undefined) {
      // The kernel lacks the checklists bridge (older/torn build) —
      // say so instead of spinning "Loading…" forever (2026-08-08).
      host.textContent = 'Checklists need a newer build of Lite — update to enable them.';
      return;
    }
    const cached = checklistLibraryCache.get(space.id);
    if (force) {
      checklistLibraryCache.delete(space.id);
    } else if (
      cached !== undefined &&
      Date.now() - cached.fetchedAt <= SHARED_DASHBOARD_TTL_MS
    ) {
      paint(cached.items);
      return;
    }
    if (checklistLibraryInFlight.has(space.id)) return;
    checklistLibraryInFlight.add(space.id);
    void (async () => {
      const bridge = window.lite?.spaces;
      if (bridge?.checklists === undefined) {
        // Re-checked for type narrowing; the guard above already
        // handled the user-facing message.
        checklistLibraryInFlight.delete(space.id);
        return;
      }
      try {
        const envelope = await bridge.checklists.list(space.id);
        const lists = envelope.ok === true ? envelope.value : [];
        checklistLibraryCache.set(space.id, { items: lists, fetchedAt: Date.now() });
        paint(lists);
      } catch (err) {
        window.logging?.warn?.('spaces', 'checklist library load failed', { error: messageFrom(err) });
        host.textContent = 'Could not load checklists.';
      } finally {
        checklistLibraryInFlight.delete(space.id);
      }
    })();
  };
  refresh();
  return section;
}

function buildChecklistLibraryCard(
  space: RendererSpace,
  c: LiteChecklistView,
  onChanged: () => void
): HTMLElement {
  const card = document.createElement('div');
  card.className = 'spaces-checklist-lib-card';

  const top = document.createElement('div');
  top.className = 'spaces-checklist-card-top';

  const name = document.createElement('button');
  name.type = 'button';
  name.className = 'spaces-checklist-card-name';
  name.textContent = c.name;
  name.title = 'Show items';
  top.appendChild(name);

  const meta = document.createElement('span');
  meta.className = 'spaces-checklist-card-meta';
  const killers = c.items.filter((i) => i.killer === true).length;
  meta.textContent =
    `${c.mode} · ${c.items.length} item${c.items.length === 1 ? '' : 's'}` +
    `${killers > 0 ? ` (${killers} killer)` : ''} · v${c.version}` +
    `${typeof c.usedByCount === 'number' && c.usedByCount > 0 ? ` · on ${c.usedByCount} ticket${c.usedByCount === 1 ? '' : 's'}` : ''}`;
  top.appendChild(meta);

  const actions = document.createElement('span');
  actions.className = 'spaces-checklist-card-actions';
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'spaces-checklist-card-btn';
  edit.textContent = 'Edit';
  edit.addEventListener('click', () => {
    openChecklistEditorPanel({ spaceId: space.id, existing: c, onSaved: onChanged });
  });
  actions.appendChild(edit);
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'spaces-checklist-card-btn spaces-checklist-card-del';
  del.textContent = 'Delete';
  del.addEventListener('click', () => {
    void (async () => {
      const ok = await askToConfirm(
        `Delete "${c.name}"?`,
        typeof c.usedByCount === 'number' && c.usedByCount > 0
          ? `It is attached to ${c.usedByCount} ticket${c.usedByCount === 1 ? '' : 's'} — the delete will be refused until it is detached everywhere.`
          : 'It is not attached to any ticket. This permanently removes the checklist definition.',
        'Delete'
      );
      if (!ok) return;
      const bridge = window.lite?.spaces;
      if (bridge?.checklists === undefined) return;
      const envelope = await bridge.checklists.remove(c.id);
      if (envelope.ok === false) {
        showToast(envelope.error.message);
        return;
      }
      showToast(`Deleted "${c.name}"`);
      onChanged();
    })();
  });
  actions.appendChild(del);
  top.appendChild(actions);
  card.appendChild(top);

  const pause = document.createElement('div');
  pause.className = 'spaces-checklist-card-pause';
  pause.textContent = `Pause point: ${c.pausePoint}`;
  card.appendChild(pause);

  // Items expand/collapse (read-only view — running happens on tickets).
  const items = document.createElement('ol');
  items.className = 'spaces-checklist-card-items';
  items.hidden = true;
  for (const item of c.items) {
    const li = document.createElement('li');
    li.className = 'spaces-checklist-card-item';
    li.classList.toggle('is-killer', item.killer === true);
    li.classList.toggle('is-optional', item.optional === true);
    const text = document.createElement('span');
    text.textContent = item.text;
    li.appendChild(text);
    if (item.optional === true) {
      const badge = document.createElement('span');
      badge.className = 'spaces-checklist-item-optional';
      badge.textContent = 'optional';
      li.appendChild(badge);
    }
    if (typeof item.more === 'string' && item.more.length > 0) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'spaces-checklist-item-more-toggle';
      toggle.textContent = 'more ▸';
      li.appendChild(toggle);
      const more = document.createElement('p');
      more.className = 'spaces-checklist-item-more';
      more.textContent = item.more;
      more.hidden = true;
      li.appendChild(more);
      toggle.addEventListener('click', () => {
        more.hidden = !more.hidden;
        toggle.textContent = more.hidden ? 'more ▸' : 'more ▾';
      });
    }
    items.appendChild(li);
  }
  card.appendChild(items);
  name.addEventListener('click', () => {
    items.hidden = !items.hidden;
  });

  return card;
}

/**
 * One editor for BOTH create and revise. On revise, the panel says so
 * plainly: saving bumps the version and RESETS every attached ticket's
 * run state (a check against v1's items says nothing about v2's).
 */
export function openChecklistEditorPanel(opts: {
  spaceId: string;
  existing?: LiteChecklistView;
  onSaved: () => void;
}): void {
  const bridge = window.lite?.spaces;
  if (bridge?.checklists === undefined) {
    // NEVER fail a click silently (2026-08-18: "clicked new checklist
    // and nothing happened"). Say what's wrong and leave a log line.
    window.logging?.warn?.('spaces', 'checklist editor blocked — no checklists bridge', {
      hasLite: window.lite !== undefined,
      hasSpaces: bridge !== undefined,
    });
    showToast('Checklists need a newer build of Lite — update to enable them.');
    return;
  }
  const { existing } = opts;

  document.querySelector('.spaces-checklist-editor-backdrop')?.remove();
  const backdrop = document.createElement('div');
  backdrop.className = 'spaces-member-picker-backdrop spaces-checklist-editor-backdrop';
  const panel = document.createElement('div');
  panel.className = 'spaces-member-picker spaces-checklist-editor';

  const head = document.createElement('div');
  head.className = 'spaces-member-picker-head';
  const heading = document.createElement('span');
  heading.textContent = existing === undefined ? 'New checklist' : `Revise "${existing.name}"`;
  head.appendChild(heading);
  const helpBtn = document.createElement('button');
  helpBtn.type = 'button';
  helpBtn.className = 'spaces-checklist-help-btn';
  helpBtn.setAttribute('aria-label', 'The Checklist Manifesto — what makes a great checklist');
  helpBtn.textContent = '? Manifesto';
  head.appendChild(helpBtn);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'spaces-member-picker-close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Cancel');
  close.addEventListener('click', () => backdrop.remove());
  head.appendChild(close);
  panel.appendChild(head);

  // ── The manifesto drawer: the principles this editor coaches by. ──
  const drawer = document.createElement('div');
  drawer.className = 'spaces-checklist-manifesto';
  drawer.hidden = true;
  const drawerIntro = document.createElement('p');
  drawerIntro.className = 'spaces-checklist-manifesto-intro';
  drawerIntro.textContent =
    'Eight principles, learned the hard way in aviation and surgery: experts fail by skipping, and a short, precise, anchored checklist is the cheapest defense ever invented.';
  drawer.appendChild(drawerIntro);
  for (const principle of CHECKLIST_MANIFESTO) {
    const details = document.createElement('details');
    details.className = 'spaces-checklist-manifesto-principle';
    const summary = document.createElement('summary');
    const t = document.createElement('strong');
    t.textContent = principle.title;
    summary.appendChild(t);
    const r = document.createElement('span');
    r.className = 'spaces-checklist-manifesto-rule';
    r.textContent = ` — ${principle.rule}`;
    summary.appendChild(r);
    details.appendChild(summary);
    const why = document.createElement('p');
    why.className = 'spaces-checklist-manifesto-why';
    why.textContent = principle.why;
    details.appendChild(why);
    const good = document.createElement('p');
    good.className = 'spaces-checklist-manifesto-good';
    good.textContent = `✓ ${principle.good}`;
    details.appendChild(good);
    const bad = document.createElement('p');
    bad.className = 'spaces-checklist-manifesto-bad';
    bad.textContent = `✗ ${principle.bad}`;
    details.appendChild(bad);
    drawer.appendChild(details);
  }
  panel.appendChild(drawer);
  helpBtn.addEventListener('click', () => {
    drawer.hidden = !drawer.hidden;
    helpBtn.classList.toggle('is-open', !drawer.hidden);
  });

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'spaces-checklist-editor-name';
  nameInput.placeholder = 'Checklist name';
  nameInput.value = existing?.name ?? '';
  panel.appendChild(nameInput);

  const modeSel = document.createElement('select');
  modeSel.className = 'spaces-share-select';
  for (const [v, l] of [
    ['DO-CONFIRM', 'DO-CONFIRM — work from memory, pause, confirm'],
    ['READ-DO', 'READ-DO — read each item and do it'],
  ] as const) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = l;
    modeSel.appendChild(o);
  }
  modeSel.value = existing?.mode ?? 'DO-CONFIRM';
  panel.appendChild(modeSel);

  const pauseInput = document.createElement('input');
  pauseInput.type = 'text';
  pauseInput.className = 'spaces-checklist-editor-pause';
  pauseInput.placeholder = 'Pause point — WHEN it runs ("before merge")';
  pauseInput.value = existing?.pausePoint ?? '';
  panel.appendChild(pauseInput);

  // ── AI draft box: describe it, review the rows it fills in. ──
  const aiRow = document.createElement('div');
  aiRow.className = 'spaces-checklist-ai-row';
  const aiInput = document.createElement('input');
  aiInput.type = 'text';
  aiInput.className = 'spaces-checklist-ai-input';
  aiInput.placeholder = 'Describe it and let AI draft — e.g. "pre-release checks for our Electron app"';
  aiRow.appendChild(aiInput);
  const aiBtn = document.createElement('button');
  aiBtn.type = 'button';
  aiBtn.className = 'spaces-checklist-ai-btn';
  aiBtn.textContent = '✦ Draft with AI';
  aiRow.appendChild(aiBtn);
  panel.appendChild(aiRow);

  // ── Structured item rows. ──
  const itemsHost = document.createElement('div');
  itemsHost.className = 'spaces-checklist-editor-rows';
  panel.appendChild(itemsHost);

  interface RowRefs {
    wrap: HTMLElement;
    text: HTMLInputElement;
    req: HTMLSelectElement;
    killer: HTMLInputElement;
    more: HTMLTextAreaElement;
  }
  const rows: RowRefs[] = [];

  // ── The live coach: holds the draft to the manifesto on every edit.
  //    Guidance only — the save button never gates on it.
  const coach = document.createElement('div');
  coach.className = 'spaces-checklist-coach';
  const meter = document.createElement('span');
  meter.className = 'spaces-checklist-meter';
  const runCoach = (): void => {
    const items = rows.map((r) => ({
      text: r.text.value,
      killer: r.killer.checked,
      optional: r.req.value === 'optional',
    }));
    const filled = items.filter((i) => i.text.trim().length > 0);
    meter.textContent = `${filled.length} item${filled.length === 1 ? '' : 's'}`;
    meter.classList.toggle('is-over', filled.length > 9);
    coach.replaceChildren();
    if (filled.length === 0) {
      coach.hidden = true;
      return;
    }
    coach.hidden = false;
    const findings = lintChecklistDraft({
      pausePoint: pauseInput.value,
      items,
    });
    if (findings.length === 0) {
      const ok = document.createElement('span');
      ok.className = 'spaces-checklist-coach-clear';
      ok.textContent = `✓ ${COACH_ALL_CLEAR}`;
      coach.appendChild(ok);
      return;
    }
    for (const finding of findings.slice(0, 2)) {
      const line = document.createElement('span');
      line.className = `spaces-checklist-coach-line is-${finding.severity}`;
      line.textContent = finding.message;
      coach.appendChild(line);
    }
  };

  const addItemRow = (seed?: {
    text?: string;
    killer?: boolean;
    optional?: boolean;
    more?: string;
  }): void => {
    const wrap = document.createElement('div');
    wrap.className = 'spaces-checklist-editor-row';

    const line = document.createElement('div');
    line.className = 'spaces-checklist-editor-row-line';

    const text = document.createElement('input');
    text.type = 'text';
    text.className = 'spaces-checklist-editor-row-text';
    text.placeholder = 'One-line verification…';
    text.value = seed?.text ?? '';
    line.appendChild(text);

    const req = document.createElement('select');
    req.className = 'spaces-share-select spaces-checklist-editor-row-req';
    for (const [v, l] of [
      ['required', 'Required'],
      ['optional', 'Optional'],
    ] as const) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = l;
      req.appendChild(o);
    }
    req.value = seed?.optional === true ? 'optional' : 'required';
    line.appendChild(req);

    const killerLabel = document.createElement('label');
    killerLabel.className = 'spaces-checklist-editor-row-killer';
    const killer = document.createElement('input');
    killer.type = 'checkbox';
    killer.checked = seed?.killer === true;
    killerLabel.append(killer, document.createTextNode(' killer'));
    line.appendChild(killerLabel);
    // Killer implies required — mirror the SDK rule in the UI.
    killer.addEventListener('change', () => {
      if (killer.checked) req.value = 'required';
    });
    req.addEventListener('change', () => {
      if (req.value === 'optional') killer.checked = false;
    });

    const moreToggle = document.createElement('button');
    moreToggle.type = 'button';
    moreToggle.className = 'spaces-checklist-editor-row-moretoggle';
    moreToggle.textContent = 'more ▸';
    line.appendChild(moreToggle);

    // Reorder: order is meaning in a checklist — killers early, the
    // pause-point flow top to bottom.
    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'spaces-checklist-editor-row-move';
    upBtn.setAttribute('aria-label', 'Move item up');
    upBtn.textContent = '↑';
    upBtn.addEventListener('click', () => {
      const at = rows.findIndex((r) => r.wrap === wrap);
      if (at <= 0) return;
      const prev = rows[at - 1];
      if (prev === undefined) return;
      rows.splice(at, 1);
      rows.splice(at - 1, 0, { wrap, text, req, killer, more });
      prev.wrap.before(wrap);
    });
    line.appendChild(upBtn);
    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'spaces-checklist-editor-row-move';
    downBtn.setAttribute('aria-label', 'Move item down');
    downBtn.textContent = '↓';
    downBtn.addEventListener('click', () => {
      const at = rows.findIndex((r) => r.wrap === wrap);
      if (at < 0 || at >= rows.length - 1) return;
      const next = rows[at + 1];
      if (next === undefined) return;
      rows.splice(at, 1);
      rows.splice(at + 1, 0, { wrap, text, req, killer, more });
      next.wrap.after(wrap);
    });
    line.appendChild(downBtn);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'spaces-checklist-editor-row-remove';
    removeBtn.setAttribute('aria-label', 'Remove item');
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
      const at = rows.findIndex((r) => r.wrap === wrap);
      if (at >= 0) rows.splice(at, 1);
      wrap.remove();
      runCoach();
    });
    line.appendChild(removeBtn);
    text.addEventListener('input', () => runCoach());
    req.addEventListener('change', () => runCoach());
    killer.addEventListener('change', () => runCoach());

    wrap.appendChild(line);

    const more = document.createElement('textarea');
    more.className = 'spaces-checklist-editor-row-more';
    more.placeholder = 'Optional detail readers can expand — why this matters, how to verify.';
    more.value = seed?.more ?? '';
    more.hidden = !(seed?.more !== undefined && seed.more.length > 0);
    wrap.appendChild(more);
    moreToggle.addEventListener('click', () => {
      more.hidden = !more.hidden;
      moreToggle.textContent = more.hidden ? 'more ▸' : 'more ▾';
    });
    if (!more.hidden) moreToggle.textContent = 'more ▾';

    itemsHost.appendChild(wrap);
    rows.push({ wrap, text, req, killer, more });
  };

  const setRows = (
    items: Array<{ text: string; killer?: boolean; optional?: boolean; more?: string }>
  ): void => {
    rows.splice(0, rows.length);
    itemsHost.replaceChildren();
    for (const item of items) addItemRow(item);
    if (items.length === 0) addItemRow();
  };

  setRows(existing?.items ?? []);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'spaces-checklist-editor-add';
  addBtn.textContent = '+ Add item';
  addBtn.addEventListener('click', () => {
    addItemRow();
    runCoach();
  });
  const addRow = document.createElement('div');
  addRow.className = 'spaces-checklist-editor-addrow';
  addRow.appendChild(addBtn);
  addRow.appendChild(meter);
  panel.appendChild(addRow);
  panel.appendChild(coach);
  pauseInput.addEventListener('input', () => runCoach());
  runCoach();

  const collectItems = (): Array<{
    text: string;
    killer?: boolean;
    optional?: boolean;
    more?: string;
  }> =>
    rows
      .map((r) => ({
        text: r.text.value.trim(),
        ...(r.killer.checked ? { killer: true } : {}),
        ...(r.req.value === 'optional' && !r.killer.checked ? { optional: true } : {}),
        ...(r.more.value.trim().length > 0 ? { more: r.more.value.trim() } : {}),
      }))
      .filter((item) => item.text.length > 0);

  aiBtn.addEventListener('click', () => {
    void (async () => {
      const prompt = aiInput.value.trim();
      if (prompt.length === 0) {
        showToast('Describe the checklist first.');
        return;
      }
      aiBtn.disabled = true;
      aiBtn.textContent = 'Drafting…';
      try {
        const envelope = await bridge.checklists.draft(prompt);
        if (envelope.ok === false) {
          showToast(envelope.error.message);
          return;
        }
        const draft = envelope.value as {
          name: string;
          mode: 'DO-CONFIRM' | 'READ-DO';
          pausePoint: string;
          items: Array<{ text: string; killer?: boolean; optional?: boolean; more?: string }>;
        };
        // Prefill for review — the human saves, never the model.
        if (nameInput.value.trim().length === 0) nameInput.value = draft.name;
        modeSel.value = draft.mode;
        if (pauseInput.value.trim().length === 0) pauseInput.value = draft.pausePoint;
        setRows(draft.items);
        showToast('Draft ready — review and save.');
      } finally {
        aiBtn.disabled = false;
        aiBtn.textContent = '✦ Draft with AI';
      }
    })();
  });

  if (existing !== undefined) {
    const warn = document.createElement('p');
    warn.className = 'spaces-checklist-editor-warn';
    warn.textContent =
      `Saving creates v${existing.version + 1} and resets the run state on every attached ticket — a revised checklist must be re-run.`;
    panel.appendChild(warn);
  }

  const foot = document.createElement('div');
  foot.className = 'spaces-checklist-editor-foot';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'spaces-items-new';
  save.textContent = existing === undefined ? 'Create checklist' : 'Save revision';
  save.addEventListener('click', () => {
    void (async () => {
      save.disabled = true;
      const items = collectItems();
      const common = {
        name: nameInput.value.trim(),
        mode: modeSel.value === 'READ-DO' ? ('READ-DO' as const) : ('DO-CONFIRM' as const),
        pausePoint: pauseInput.value.trim(),
        items,
      };
      const envelope =
        existing === undefined
          ? await bridge.checklists.create({ spaceId: opts.spaceId, ...common })
          : await bridge.checklists.update({ id: existing.id, ...common });
      save.disabled = false;
      if (envelope.ok === false) {
        showToast(envelope.error.message);
        return;
      }
      backdrop.remove();
      showToast(existing === undefined ? 'Checklist created' : 'Revision saved — runs reset');
      opts.onSaved();
    })();
  });
  foot.appendChild(save);
  panel.appendChild(foot);

  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);
  nameInput.focus();
}

async function openAttachChecklistPanel(
  item: RendererItem,
  onDone: () => Promise<void>
): Promise<void> {
  const bridge = window.lite?.spaces;
  if (bridge?.checklists === undefined) return;
  const spaceId =
    state.activeScopeId !== HOME_SCOPE_ID && state.activeScopeId !== UNCATEGORIZED_SPACE_ID
      ? state.activeScopeId
      : '';
  if (spaceId === '') {
    showToast('Open the ticket from inside its Space to attach checklists.');
    return;
  }

  document.querySelector('.spaces-checklist-panel-backdrop')?.remove();
  const backdrop = document.createElement('div');
  backdrop.className = 'spaces-member-picker-backdrop spaces-checklist-panel-backdrop';
  const panel = document.createElement('div');
  panel.className = 'spaces-member-picker spaces-checklist-panel';

  const head = document.createElement('div');
  head.className = 'spaces-member-picker-head';
  const heading = document.createElement('span');
  heading.textContent = 'Attach a checklist';
  head.appendChild(heading);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'spaces-member-picker-close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Cancel');
  close.addEventListener('click', () => backdrop.remove());
  head.appendChild(close);
  panel.appendChild(head);

  // Phase + obligation selectors — the relationship params, chosen at
  // the moment of attaching.
  const controls = document.createElement('div');
  controls.className = 'spaces-checklist-panel-controls';
  const phaseSel = document.createElement('select');
  phaseSel.className = 'spaces-share-select';
  for (const [v, l] of [
    ['preflight', 'Pre-flight — before work starts'],
    ['postflight', 'Post-flight — before done'],
  ] as const) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = l;
    phaseSel.appendChild(o);
  }
  const oblSel = document.createElement('select');
  oblSel.className = 'spaces-share-select';
  for (const [v, l] of [
    ['required', 'Required — gates the ticket'],
    ['recommended', 'Recommended'],
    ['optional', 'Optional'],
  ] as const) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = l;
    oblSel.appendChild(o);
  }
  controls.append(phaseSel, oblSel);
  panel.appendChild(controls);

  const listHost = document.createElement('div');
  listHost.className = 'spaces-checklist-panel-list';
  listHost.textContent = 'Loading…';
  panel.appendChild(listHost);

  const attach = async (checklistId: string): Promise<void> => {
    const envelope = await bridge.checklists.attach({
      ticketId: item.id,
      checklistId,
      phase: phaseSel.value === 'postflight' ? 'postflight' : 'preflight',
      obligation:
        oblSel.value === 'required' || oblSel.value === 'optional'
          ? (oblSel.value as 'required' | 'optional')
          : 'recommended',
    });
    if (envelope.ok === false) {
      showToast(envelope.error.message);
      return;
    }
    backdrop.remove();
    showToast('Checklist attached');
    await onDone();
  };

  try {
    const envelope = await bridge.checklists.list(spaceId);
    listHost.replaceChildren();
    const lists = envelope.ok === true ? envelope.value : [];
    if (lists.length === 0) {
      const none = document.createElement('p');
      none.className = 'spaces-checklist-empty';
      none.textContent = 'No checklists in this Space yet — create the first below.';
      listHost.appendChild(none);
    }
    for (const c of lists) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'spaces-member-picker-row spaces-checklist-pick-row';
      const nm = document.createElement('span');
      nm.className = 'spaces-member-picker-name';
      nm.textContent = `${c.name} · ${c.items.length} items`;
      row.appendChild(nm);
      const pp = document.createElement('span');
      pp.className = 'spaces-checklist-pick-pause';
      pp.textContent = c.pausePoint;
      row.appendChild(pp);
      row.addEventListener('click', () => void attach(c.id));
      listHost.appendChild(row);
    }
  } catch (err) {
    window.logging?.warn?.('spaces', 'attach-checklist list load failed', { error: messageFrom(err) });
    listHost.textContent = 'Could not load checklists.';
  }

  // Inline create: name, mode, pause point, one item per line (`!` = killer).
  const createWrap = document.createElement('div');
  createWrap.className = 'spaces-checklist-create';
  const nameIn = document.createElement('input');
  nameIn.type = 'text';
  nameIn.className = 'spaces-new-asset-input';
  nameIn.placeholder = 'New checklist name';
  const modeSel = document.createElement('select');
  modeSel.className = 'spaces-share-select';
  for (const [v, l] of [
    ['DO-CONFIRM', 'DO-CONFIRM — work, then confirm'],
    ['READ-DO', 'READ-DO — read each step, do it'],
  ] as const) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = l;
    modeSel.appendChild(o);
  }
  const pauseIn = document.createElement('input');
  pauseIn.type = 'text';
  pauseIn.className = 'spaces-new-asset-input';
  pauseIn.placeholder = 'Pause point — when does this run? ("before merge")';
  const itemsIn = document.createElement('textarea');
  itemsIn.className = 'spaces-new-asset-textarea spaces-checklist-items-input';
  itemsIn.rows = 5;
  itemsIn.placeholder = 'One item per line. Prefix with ! for a killer item.\n!Backups verified\nRelease notes written';
  const createBtn = document.createElement('button');
  createBtn.type = 'button';
  createBtn.className = 'spaces-new-asset-button is-primary';
  createBtn.textContent = 'Create & attach';
  createBtn.addEventListener('click', () => {
    void (async () => {
      const items = parseChecklistDraft(itemsIn.value);
      const created = await bridge.checklists.create({
        spaceId,
        name: nameIn.value,
        mode: modeSel.value === 'READ-DO' ? 'READ-DO' : 'DO-CONFIRM',
        pausePoint: pauseIn.value,
        items,
      });
      if (created.ok === false) {
        showToast(created.error.message);
        return;
      }
      await attach(created.value.id);
    })();
  });
  createWrap.append(nameIn, modeSel, pauseIn, itemsIn, createBtn);
  panel.appendChild(createWrap);

  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', (ev) => {
    if (ev.target === backdrop) backdrop.remove();
  });
}

export function buildDetailTicketBlock(
  item: RendererItem,
  cb?: DetailTicketCallbacks
): HTMLElement {
  const t = item.ticket;
  const status: RendererTicketStatus =
    t !== undefined && isRendererTicketStatus(t.status) ? t.status : 'open';

  const wrap = document.createElement('div');
  wrap.className = 'spaces-detail-ticket';

  // ── Status row ───────────────────────────────────────────────────────
  const statusRow = document.createElement('div');
  statusRow.className = 'spaces-detail-ticket-row spaces-detail-ticket-row-status';
  const statusLabel = document.createElement('span');
  statusLabel.className = 'spaces-detail-label';
  statusLabel.textContent = 'Status';
  statusRow.appendChild(statusLabel);

  if (cb?.onStatusChange !== undefined) {
    const onStatusChange = cb.onStatusChange;
    const select = document.createElement('select');
    select.className = 'spaces-detail-ticket-status-select';
    select.setAttribute('aria-label', 'Ticket status');
    for (const s of TICKET_STATUSES_ORDERED) {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = TICKET_STATUS_LABELS[s];
      if (s === status) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      const next = select.value as RendererTicketStatus;
      if (next === status) return;
      select.disabled = true;
      wrap.classList.add('is-saving');
      onStatusChange(next)
        .catch((err) => {
          window.logging?.error?.('spaces', 'ticket status change failed', { error: messageFrom(err) });
          select.value = status;
        })
        .finally(() => {
          select.disabled = false;
          wrap.classList.remove('is-saving');
        });
    });
    statusRow.appendChild(select);
  } else {
    statusRow.appendChild(buildTicketStatusPill(status));
  }
  wrap.appendChild(statusRow);

  // ── Priority (read-only chip; v1) ────────────────────────────────────
  if (t?.priority !== undefined) {
    const pri = document.createElement('div');
    pri.className = 'spaces-detail-ticket-row';
    const priLabel = document.createElement('span');
    priLabel.className = 'spaces-detail-label';
    priLabel.textContent = 'Priority';
    pri.appendChild(priLabel);
    const priChip = document.createElement('span');
    priChip.className = 'spaces-detail-ticket-priority';
    priChip.setAttribute('data-priority', t.priority);
    priChip.textContent = t.priority;
    pri.appendChild(priChip);
    wrap.appendChild(pri);
  }

  // ── Assignee (read-only chip; v1) ────────────────────────────────────
  const assigneeRow = document.createElement('div');
  assigneeRow.className = 'spaces-detail-ticket-row';
  const assigneeLabel = document.createElement('span');
  assigneeLabel.className = 'spaces-detail-label';
  assigneeLabel.textContent = 'Assignee';
  assigneeRow.appendChild(assigneeLabel);
  const assigneeChip = document.createElement('span');
  assigneeChip.className = 'spaces-detail-ticket-assignee';
  if (t?.assignee !== null && t?.assignee !== undefined) {
    assigneeChip.classList.add('is-assigned');
    assigneeChip.setAttribute('data-assignee-kind', t.assignee.kind);
    assigneeChip.textContent = `${t.assignee.name} (${t.assignee.kind})`;
  } else {
    assigneeChip.textContent = 'Unassigned';
  }
  assigneeRow.appendChild(assigneeChip);
  wrap.appendChild(assigneeRow);

  // ── Source playbook link ─────────────────────────────────────────────
  if (typeof t?.playbookId === 'string' && t.playbookId.length > 0) {
    const pbId = t.playbookId;
    const pbRow = document.createElement('div');
    pbRow.className = 'spaces-detail-ticket-row';
    const pbLabel = document.createElement('span');
    pbLabel.className = 'spaces-detail-label';
    pbLabel.textContent = 'From playbook';
    pbRow.appendChild(pbLabel);

    const onOpen = cb?.onOpenPlaybook;
    if (onOpen !== undefined) {
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'spaces-detail-ticket-playbook-link';
      link.textContent = 'View playbook';
      link.setAttribute('data-playbook-id', pbId);
      link.addEventListener('click', () => onOpen(pbId));
      pbRow.appendChild(link);
    } else {
      const idEl = document.createElement('span');
      idEl.className = 'spaces-detail-ticket-playbook-link is-readonly';
      idEl.textContent = pbId;
      pbRow.appendChild(idEl);
    }
    wrap.appendChild(pbRow);
  }


  // ADR-055 — pre/post-flight checklists run from the ticket pane.
  wrap.appendChild(buildTicketChecklistsSection(item));
  return wrap;
}

function isRendererTicketStatus(v: unknown): v is RendererTicketStatus {
  return (
    v === 'open' || v === 'in_progress' || v === 'done' || v === 'blocked'
  );
}

/**
 * Playbook detail block. Surfaces a "Playbook" banner identifying the
 * asset as the plan that drives the shared space. Planning + ticket
 * decomposition happen UPSTREAM in the Playbook tool — this view is
 * read-only here; users edit the playbook over there.
 */
export function buildDetailPlaybookBlock(item: RendererItem): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'spaces-detail-playbook';
  wrap.setAttribute('data-item-id', item.id);

  const banner = document.createElement('div');
  banner.className = 'spaces-detail-playbook-banner';
  const icon = document.createElement('span');
  icon.className = 'spaces-detail-playbook-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '★';
  banner.appendChild(icon);
  const label = document.createElement('span');
  label.className = 'spaces-detail-playbook-label';
  label.textContent = 'Playbook';
  banner.appendChild(label);
  const hint = document.createElement('span');
  hint.className = 'spaces-detail-playbook-hint';
  hint.textContent = 'Drives the work in this shared space';
  banner.appendChild(hint);
  wrap.appendChild(banner);

  // Footnote pointing users to the Playbook tool for edits — keeps
  // the contract explicit: this surface is consumer-side; planning
  // happens elsewhere.
  const footnote = document.createElement('p');
  footnote.className = 'spaces-detail-playbook-footnote';
  footnote.textContent = 'Edit the plan in the Playbook tool; changes flow in automatically.';
  wrap.appendChild(footnote);

  return wrap;
}

/**
 * Type-specific subsection for items beyond the generic content body.
 * Returns `null` when nothing extra is needed (image preview is
 * handled by the post-fetch `injectBinaryPreview` path).
 */
function buildDetailTypeBlock(item: RendererItem): HTMLElement | null {
  if (item.kind === 'ticket') {
    return buildDetailTicketBlock(item);
  }
  if (item.kind === 'playbook') {
    return buildDetailPlaybookBlock(item);
  }
  if (typeof item.sourceUrl === 'string' && item.sourceUrl.length > 0) {
    const sourceWrap = document.createElement('div');
    sourceWrap.className = 'spaces-detail-source';
    const label = document.createElement('span');
    label.className = 'spaces-detail-label';
    label.textContent = 'Source';
    const link = document.createElement('a');
    link.href = item.sourceUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = item.sourceUrl;
    sourceWrap.appendChild(label);
    sourceWrap.appendChild(link);
    return sourceWrap;
  }
  return null;
}

// ─── Minimal Markdown renderer (pure, exported for tests) ───────────────
//
// Handles the common Markdown subset:
//   - ATX headers (#, ##, ###)
//   - **bold**, *italic*, `code` inline
//   - ``` fenced code blocks
//   - [text](url) links (rel=noopener)
//   - * / - / 1. lists (one level deep)
//   - blank-line paragraph breaks
//
// HTML in the source is escaped first to prevent XSS via injection.
// Returning an HTMLElement (not innerHTML) means renderer consumers
// don't see a `dangerouslySetInnerHTML`-shaped API.



/**
 * Apply inline Markdown to an already HTML-escaped string.
 *
 * Code spans are extracted into placeholders BEFORE bold / italic /
 * link replacements so we never interpret formatting inside `` `…` ``.
 * Placeholders are unique sentinel strings (` CS<n> `) that
 * can't collide with user content (NUL is forbidden in source) — they
 * survive the other passes intact and we restore them at the end.
 */

/**
 * Render a Markdown source string into a DOM element. Pure; the
 * returned element is unparented and safe to append anywhere.
 *
 * Exported for jsdom tests. The implementation is deliberately
 * minimal: it covers what users typically write in inline notes
 * without pulling in a 30KB library.
 */

/**
 * Compact byte formatter (1.2 KB, 3.4 MB). Pure; exported for tests.
 *   - 0–999  B
 *   - 1.0–999.9 KB (one decimal)
 *   - 1.0+ MB (one decimal)
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1000) return `${Math.floor(n)} B`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)} KB`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  return `${(n / 1_000_000_000).toFixed(1)} GB`;
}

// ─── Home view (chunk 3o) ───────────────────────────────────────────────
//
// Five cards, one orchestrator. Each card has its own cache entry; the
// orchestrator fires all 6 SDK calls in parallel via Promise.all,
// renders skeletons immediately, and patches each card as its
// response lands.
//
// Per Q-Home-3, cache is stale-while-revalidate with a 60s window
// (HOME_CACHE_TTL_MS). On a Home view focus with fresh cache, render
// directly from cache without a network call. On stale or missing
// cache, render from cache (if present) immediately AND kick off a
// refresh.

/**
 * Top-level Home loader. Renders the 5 cards (using cache if fresh,
 * skeletons + parallel fetches otherwise).
 */
async function loadHome(): Promise<void> {
  // Stamp this visit so subsequent re-loads (e.g. after sidebar nav
  // back to Home) still read "since your previous arrival" rather
  // than "0 new" because we wrote the timestamp right before the
  // next read. The current-visit-ms in state captures the moment
  // this session started; the localStorage write happens at the end
  // so the NEXT session sees this session's timestamp.
  renderHome();

  const now = Date.now();
  const fresh = (entry: HomeCacheEntry<unknown>): boolean =>
    entry.value !== null && now - entry.fetchedAt < HOME_CACHE_TTL_MS;

  // The timeline is the centerpiece, so its two sources fire first.
  // Counts / agents / contributors / permission feed the secondary
  // context column; they're best-effort and fail soft.
  const work: Array<Promise<void>> = [];
  if (!fresh(state.home.events)) work.push(refreshEvents());
  if (!fresh(state.home.recentItems)) work.push(refreshRecentItems());
  if (!fresh(state.home.contributors)) work.push(refreshContributors());
  if (!fresh(state.home.permission)) work.push(refreshPermission());
  if (!fresh(state.home.counts)) work.push(refreshCounts());
  if (!fresh(state.home.agents)) work.push(refreshAgents());
  await Promise.all(work);

  // Persist "you were last here" AFTER the timeline lands so the
  // "since" computation in this session keeps using the previous
  // visit's timestamp.
  markVisitNow();
}



export async function refreshCounts(): Promise<void> {
  const bridge = window.lite?.spaces?.home;
  if (bridge === undefined) return;
  state.home.counts.loading = true;
  state.home.counts.error = null;
  renderHome();
  try {
    const envelope = await bridge.entityCounts();
    if (envelope.ok === false) {
      state.home.counts.error = envelope.error.message;
    } else {
      state.home.counts.value = envelope.value;
      state.home.counts.fetchedAt = Date.now();
    }
  } catch (err) {
    window.logging?.warn?.('spaces', 'home counts load failed', { error: messageFrom(err) });
    state.home.counts.error = messageFrom(err);
  } finally {
    state.home.counts.loading = false;
    renderHome();
  }
}

export async function refreshContributors(): Promise<void> {
  const bridge = window.lite?.spaces?.home;
  if (bridge === undefined) return;
  state.home.contributors.loading = true;
  state.home.contributors.error = null;
  renderHome();
  try {
    const envelope = await bridge.topContributors({ window: 'week', limit: 4 });
    if (envelope.ok === false) {
      state.home.contributors.error = envelope.error.message;
    } else {
      state.home.contributors.value = envelope.value;
      state.home.contributors.fetchedAt = Date.now();
    }
  } catch (err) {
    window.logging?.warn?.('spaces', 'home contributors load failed', { error: messageFrom(err) });
    state.home.contributors.error = messageFrom(err);
  } finally {
    state.home.contributors.loading = false;
    renderHome();
  }
}

export async function refreshAgents(): Promise<void> {
  const bridge = window.lite?.spaces?.home;
  if (bridge === undefined) return;
  state.home.agents.loading = true;
  state.home.agents.error = null;
  renderHome();
  try {
    const envelope = await bridge.agentsSample({ limit: 3 });
    if (envelope.ok === false) {
      state.home.agents.error = envelope.error.message;
    } else {
      state.home.agents.value = envelope.value;
      state.home.agents.fetchedAt = Date.now();
    }
  } catch (err) {
    window.logging?.warn?.('spaces', 'home agents load failed', { error: messageFrom(err) });
    state.home.agents.error = messageFrom(err);
  } finally {
    state.home.agents.loading = false;
    renderHome();
  }
}

export async function refreshPermission(): Promise<void> {
  const bridge = window.lite?.spaces?.home;
  if (bridge === undefined) return;
  state.home.permission.loading = true;
  state.home.permission.error = null;
  renderHome();
  try {
    const envelope = await bridge.permissionSummary();
    if (envelope.ok === false) {
      state.home.permission.error = envelope.error.message;
    } else {
      state.home.permission.value = envelope.value;
      state.home.permission.fetchedAt = Date.now();
    }
  } catch (err) {
    window.logging?.warn?.('spaces', 'home permission load failed', { error: messageFrom(err) });
    state.home.permission.error = messageFrom(err);
  } finally {
    state.home.permission.loading = false;
    renderHome();
  }
}

export async function refreshRecentItems(): Promise<void> {
  const bridge = window.lite?.spaces?.home;
  if (bridge === undefined) return;
  state.home.recentItems.loading = true;
  state.home.recentItems.error = null;
  renderHome();
  try {
    // Timeline-first: pull 25 instead of 3 so the merged feed has
    // enough material for filter chips ("24h" / "7d" / "agents")
    // to feel responsive without re-fetching.
    const envelope = await bridge.recentItems({ limit: 25 });
    if (envelope.ok === false) {
      state.home.recentItems.error = envelope.error.message;
    } else {
      state.home.recentItems.value = envelope.value as RendererItemSummary[];
      state.home.recentItems.fetchedAt = Date.now();
    }
  } catch (err) {
    window.logging?.warn?.('spaces', 'home recent-items load failed', { error: messageFrom(err) });
    state.home.recentItems.error = messageFrom(err);
  } finally {
    state.home.recentItems.loading = false;
    renderHome();
  }
}

export async function refreshEvents(): Promise<void> {
  const bridge = window.lite?.spaces?.home;
  if (bridge === undefined) return;
  state.home.events.loading = true;
  state.home.events.error = null;
  renderHome();
  try {
    const envelope = await bridge.recentEvents({ limit: 50 });
    if (envelope.ok === false) {
      state.home.events.error = envelope.error.message;
    } else {
      state.home.events.value = envelope.value;
      state.home.events.fetchedAt = Date.now();
    }
  } catch (err) {
    window.logging?.warn?.('spaces', 'home events load failed', { error: messageFrom(err) });
    state.home.events.error = messageFrom(err);
  } finally {
    state.home.events.loading = false;
    renderHome();
  }
}

/**
 * Render the Home view: timeline-first.
 *
 * The mental model is "channel-but-better." A Slack channel works
 * because the message timeline IS the home; users don't navigate
 * through summary cards to reach what they came for. Spaces does the
 * same: the unified timeline (events + recently-added items) is the
 * centerpiece, with a small context column for the durable signals
 * (active contributors, ACL transparency) that Slack lacks.
 *
 *   ┌────────────────────────────────────────────────┐
 *   │ Welcome card (one-shot, dismissible)           │
 *   ├────────────────────────────────────────────────┤
 *   │ Since you last visited: N new ·············    │
 *   ├──────────────────────────────────┬─────────────┤
 *   │ [All] [People] [Agents] [24h] [7d] │           │
 *   │                                    │ Active    │
 *   │ TIMELINE                           │ this week │
 *   │ ...                                │           │
 *   │                                    │ About     │
 *   │                                    │ this view │
 *   └────────────────────────────────────┴───────────┘
 *
 * Idempotent. Safe to call after each query lands.
 */
function renderHome(): void {
  const region = document.getElementById('spaces-home-region');
  if (region === null) return;
  region.replaceChildren();

  // First-run welcome (one-shot, persisted to localStorage). Renders
  // ABOVE the hairline so the page reads top-down: "what is this →
  // what's new → what's happening."
  if (!state.welcomeDismissed) {
    region.appendChild(buildWelcomeCard());
  }

  // "Since you last visited" hairline. Hidden on first-ever visit
  // (lastVisitMs === null) -- nothing to compare against.
  const hairline = buildSinceLastVisit();
  if (hairline !== null) region.appendChild(hairline);

  // Two-column body: timeline (primary, left) + context (secondary,
  // right). Stacks vertically below 880px viewport via CSS.
  const body = document.createElement('div');
  body.className = 'home-body';

  const primary = document.createElement('div');
  primary.className = 'home-primary';
  primary.appendChild(buildFilterChips());
  primary.appendChild(buildHomeTimeline());
  body.appendChild(primary);

  body.appendChild(buildHomeContext());

  region.appendChild(body);
}

// ─── Welcome card (one-shot) ────────────────────────────────────────────

/**
 * First-run welcome card. Explains what a Space is in the user's own
 * frame ("project place, channel-but-better"). Dismissed permanently
 * via localStorage so returning users don't see it every visit.
 *
 * Pure builder; exported for jsdom tests.
 */
export function buildWelcomeCard(): HTMLElement {
  const card = document.createElement('article');
  card.className = 'home-welcome';
  card.setAttribute('role', 'region');
  card.setAttribute('aria-label', 'Welcome to Spaces');

  const title = document.createElement('h2');
  title.className = 'home-welcome-title';
  title.textContent = 'Welcome to Spaces';
  card.appendChild(title);

  const body = document.createElement('p');
  body.className = 'home-welcome-body';
  body.textContent =
    'Spaces are the project places where you and your AI agents work together. Think of each Space as a channel — but assets you put in stay findable forever, not buried by time. The timeline below shows what is happening across every Space you can see.';
  card.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'home-welcome-actions';
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'home-welcome-dismiss';
  dismiss.textContent = 'Got it';
  dismiss.addEventListener('click', () => {
    markWelcomeSeen();
    state.welcomeDismissed = true;
    renderHome();
  });
  actions.appendChild(dismiss);
  card.appendChild(actions);

  return card;
}

// ─── Since-you-last-visited hairline ────────────────────────────────────

/**
 * Compute a friendly "since" string for the hairline header. Pure;
 * exported for tests.
 *
 *   - `null` (first-ever visit): null
 *   - within 5 min of last visit: null (don't nag on rapid re-opens)
 *   - within 24h: "Welcome back — last here 3h ago"
 *   - within 7d:  "Welcome back — last here yesterday"
 *   - older:      "Welcome back — last here 2w ago"
 */
export function formatSinceLastVisit(
  lastVisitMs: number | null,
  nowMs: number
): string | null {
  if (lastVisitMs === null) return null;
  const diff = nowMs - lastVisitMs;
  // Suppress on rapid re-opens (e.g. tab switching).
  if (diff < 5 * 60_000) return null;
  return `Welcome back — last here ${formatRecency(lastVisitMs)}.`;
}

/**
 * Count rows in the unified timeline that arrived after `sinceMs`.
 * Used to suffix the hairline with "X new since…" when fresh data
 * is available. Returns 0 when nothing landed.
 */
export function countTimelineSince(
  rows: ReadonlyArray<TimelineRow>,
  sinceMs: number
): number {
  let n = 0;
  for (const row of rows) {
    const t = Date.parse(row.timestamp);
    if (Number.isFinite(t) && t > sinceMs) n++;
  }
  return n;
}

export function buildSinceLastVisit(): HTMLElement | null {
  const friendly = formatSinceLastVisit(state.lastVisitMs, state.currentVisitMs);
  if (friendly === null) return null;

  const row = document.createElement('div');
  row.className = 'home-hairline';

  const left = document.createElement('span');
  left.className = 'home-hairline-text';
  left.textContent = friendly;
  row.appendChild(left);

  // Right-side new-count badge. Computed only if events + items have
  // landed; null/loading caches are silent.
  if (
    state.lastVisitMs !== null &&
    (state.home.events.value !== null || state.home.recentItems.value !== null)
  ) {
    const merged = mergeTimeline(
      state.home.events.value ?? [],
      state.home.recentItems.value ?? []
    );
    const newCount = countTimelineSince(merged, state.lastVisitMs);
    if (newCount > 0) {
      const badge = document.createElement('span');
      badge.className = 'home-hairline-badge';
      badge.textContent =
        newCount === 1 ? '1 new since then' : `${formatBigNumber(newCount)} new since then`;
      row.appendChild(badge);
    }
  }

  return row;
}

// ─── Filter chips ───────────────────────────────────────────────────────

const FILTER_LABELS: ReadonlyArray<{ id: HomeFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'people', label: 'People' },
  { id: 'agents', label: 'Agents' },
  { id: '24h', label: 'Last 24h' },
  { id: '7d', label: 'Last 7 days' },
];

/**
 * Render the filter-chip row. Each chip toggles `state.homeFilter`
 * and re-renders the timeline. Exported for jsdom tests.
 */
export function buildFilterChips(active?: HomeFilter): HTMLElement {
  const a = active ?? state.homeFilter;
  const row = document.createElement('div');
  row.className = 'home-filter-chips';
  row.setAttribute('role', 'tablist');
  row.setAttribute('aria-label', 'Filter timeline');

  for (const { id, label } of FILTER_LABELS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'home-filter-chip' + (id === a ? ' is-active' : '');
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', id === a ? 'true' : 'false');
    btn.setAttribute('data-filter', id);
    btn.textContent = label;
    btn.addEventListener('click', () => {
      if (state.homeFilter === id) return;
      state.homeFilter = id;
      renderHome();
    });
    row.appendChild(btn);
  }
  return row;
}

// ─── Unified timeline (events + items merged chronologically) ───────────

/**
 * Heuristic: does this author string look agent-y? Used by both the
 * `agents` filter and the row icon. Lower-cased substring search
 * against common agent / bot tokens; not authoritative (real agent
 * identity lands in 3n/3m), just good-enough until then.
 *
 * Pure; exported for tests.
 */
export function looksLikeAgentAuthor(author: string): boolean {
  if (typeof author !== 'string' || author.length === 0) return false;
  const a = author.toLowerCase();
  return (
    a.includes('agent') ||
    a.includes('bot') ||
    a.endsWith('.ai') ||
    a.includes('autoscript') ||
    a.includes('worker')
  );
}

/**
 * Heuristic: does this string look like an opaque id (hash / UUID /
 * long alphanumeric blob) rather than something a human typed?
 *
 *   "5b4375227558baa82b0846ff0a8d8490" (32 char hex)      -> true
 *   "402abae3-5ea4-9651-5760-deadbeefcafe" (UUID)         -> true
 *   "402abae35ea49651576deadbeefcafe11" (UUID-ish, dashed) -> true
 *   "Quarterly audit"                                    -> false
 *   "doc-with-words.pdf"                                 -> false
 *
 * Used to decide whether to render the raw string verbatim or to fall
 * back to a kind-driven label like "an image" / "Unnamed space". The
 * rule errs on the side of false-negatives (preserve real titles)
 * over false-positives (hide a real title), so short / spaced strings
 * always pass through.
 *
 * Pure; exported for tests.
 */
export function looksLikeIdString(value: string): boolean {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (s.length < 16) return false;
  if (/\s/.test(s)) return false;
  // Strip dashes (UUIDs sometimes carry them) and inspect remainder.
  const stripped = s.replace(/-/g, '');
  if (stripped.length < 16) return false;
  // Hex-only: classic MD5/SHA-1/SHA-256 hash shapes.
  if (/^[0-9a-f]+$/i.test(stripped) && stripped.length >= 16) return true;
  // Lowercase alphanumeric with no spaces and at least 24 chars --
  // covers base36/base58 ids without false-positiving things like
  // "QuarterlyAuditQ4" (mixed case).
  if (/^[a-z0-9]+$/i.test(stripped) && stripped.length >= 24) {
    // Reject if it contains BOTH letters AND digits AND a vowel run --
    // those are likely human-typed identifiers like "auditQ42026".
    const hasVowelRun = /[aeiou]{2,}/i.test(stripped);
    if (hasVowelRun && stripped.length < 32) return false;
    return true;
  }
  return false;
}

/**
 * Pick a friendly label for a timeline row's object when the raw
 * title looks like an opaque id. Falls back to a kind-aware noun
 * ("an image", "a document") so the row reads as "Someone added an
 * image" rather than "Someone added 5b43752275...".
 *
 * Pure; exported for tests.
 */
export function friendlyObjectForItem(rawTitle: string, kind: string): string {
  const trimmed = typeof rawTitle === 'string' ? rawTitle.trim() : '';
  if (trimmed.length > 0 && !looksLikeIdString(trimmed)) return trimmed;
  switch (kind) {
    case 'document':
      return 'a document';
    case 'image':
      return 'an image';
    case 'url':
      return 'a link';
    case 'text':
      return 'a note';
    case 'audio':
      return 'an audio clip';
    case 'video':
      return 'a video';
    default:
      return 'an item';
  }
}

/**
 * Pick a friendly Space display name. If the raw name is missing or
 * looks like an id, fall back to "Unnamed space" so chips don't show
 * a 32-char hex string in place of a human label.
 *
 * Pure; exported for tests.
 */
export function friendlySpaceName(rawName: string): string {
  const trimmed = typeof rawName === 'string' ? rawName.trim() : '';
  if (trimmed.length === 0) return 'Unnamed space';
  if (looksLikeIdString(trimmed)) return 'Unnamed space';
  return trimmed;
}

/**
 * Shape `generateItemTitle` consumes. Defined here (rather than reusing
 * `RendererItemSummary`) so tests can pass a minimal record without
 * filling in unrelated fields like `otherSpaces` or `producedBy`.
 */
export interface GenerateItemTitleInput {
  title?: string;
  kind?: string;
  id?: string;
  sourceUrl?: string;
  fileKey?: string;
  excerpt?: string;
}

/**
 * Derive a human-readable title for an item when the raw `title` field
 * is missing or hash-shaped (the Cypher `coalesce(a.name, a.title, a.id)`
 * fallback often returns the asset's hex id verbatim).
 *
 * Generation strategy, in priority order:
 *   1. Real title (non-empty, doesn't look like an id) — used as-is.
 *   2. URL items with `sourceUrl` — pull a meaningful path segment
 *      ("sunset" from "/photos/sunset.jpg") and tag with the host
 *      ("sunset · photos.example.com"), or fall back to "Link · <host>".
 *   3. File-backed items with `fileKey` — humanize the last path
 *      segment ("quarterly-audit-q4.pdf" → "Quarterly audit q4"),
 *      stripping the extension and underscores / dashes.
 *   4. Text-kind items with an `excerpt` — take the first ~6 words and
 *      ellipsize, so a note shows its opening line as its label.
 *   5. Last resort — "<Kind> · <short-id>" where `<short-id>` is the
 *      first 6 characters of the asset id (stripping UUID dashes
 *      first). Always returns something; never empty.
 *
 * Pure; exported for tests.
 */
export function generateItemTitle(item: GenerateItemTitleInput): string {
  // 1. Real, human-shaped title wins.
  const rawTitle = typeof item.title === 'string' ? item.title.trim() : '';
  if (rawTitle.length > 0 && !looksLikeIdString(rawTitle)) return rawTitle;

  const kind = typeof item.kind === 'string' ? item.kind : '';
  const kindLabelText = kindLabel(kind);

  // 2. URL items: synthesize from the source URL.
  if (typeof item.sourceUrl === 'string' && item.sourceUrl.length > 0) {
    const urlTitle = titleFromUrl(item.sourceUrl, kindLabelText);
    if (urlTitle !== null) return urlTitle;
  }

  // 3. File-backed items: derive from `fileKey` path segment.
  if (typeof item.fileKey === 'string' && item.fileKey.length > 0) {
    const fileTitle = titleFromFileKey(item.fileKey);
    if (fileTitle !== null) return fileTitle;
  }

  // 4. Text-kind items: lift the first sentence of the excerpt.
  if (kind === 'text' && typeof item.excerpt === 'string') {
    const excerptTitle = titleFromExcerpt(item.excerpt);
    if (excerptTitle !== null) return excerptTitle;
  }

  // 5. Last resort: "<Kind> · <short-id>". The kind label always exists
  // (`kindLabel('whatever')` returns "Other") so this path never produces
  // an empty string; the short id is omitted only if no id is present.
  const shortId = typeof item.id === 'string' ? shortenIdForTitle(item.id) : '';
  return shortId.length > 0 ? `${kindLabelText} · ${shortId}` : kindLabelText;
}

/**
 * Try to compose a title from a URL. Returns `null` when the URL isn't
 * parseable or when nothing meaningful can be lifted from it. Strategy:
 *   - If the path has a non-id, non-empty trailing segment, humanize
 *     and pair it with the host: "sunset · photos.example.com".
 *   - Otherwise return "<Kind> · <host>" so the row still reads as
 *     "from somewhere" rather than collapsing to a hex id.
 */
function titleFromUrl(rawUrl: string, kindLabelText: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.replace(/^www\./i, '');
  const segments = parsed.pathname.split('/').filter((s) => s.length > 0);
  // Look from the back of the path for a meaningful segment.
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const raw = decodeURIComponent(segments[i] ?? '');
    const noExt = raw.replace(/\.[a-z0-9]{1,5}$/i, '');
    if (noExt.length === 0) continue;
    if (looksLikeIdString(noExt)) continue;
    const humanized = noExt.replace(/[-_]+/g, ' ').trim();
    if (humanized.length === 0) continue;
    return `${humanized} · ${host}`;
  }
  if (host.length === 0) return null;
  return `${kindLabelText} · ${host}`;
}

/**
 * Lift a title from a `fileKey` (typically a path-like string). Drops
 * the extension, humanizes separators, and rejects the whole thing if
 * the cleaned name still looks like an id.
 */
function titleFromFileKey(fileKey: string): string | null {
  const segments = fileKey.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  const last = segments[segments.length - 1] ?? '';
  const noExt = last.replace(/\.[a-z0-9]{1,5}$/i, '');
  if (noExt.length === 0) return null;
  if (looksLikeIdString(noExt)) return null;
  const humanized = noExt.replace(/[-_]+/g, ' ').trim();
  if (humanized.length === 0) return null;
  return humanized.charAt(0).toUpperCase() + humanized.slice(1);
}

/**
 * Use the first few words of an excerpt as a title surrogate. Caps at
 * 6 words and appends an ellipsis when the excerpt was longer.
 */
function titleFromExcerpt(excerpt: string): string | null {
  const cleaned = excerpt.trim().replace(/\s+/g, ' ');
  if (cleaned.length === 0) return null;
  if (looksLikeIdString(cleaned)) return null;
  const words = cleaned.split(' ');
  const slice = words.slice(0, 6).join(' ').replace(/[.,;:!?]+$/, '');
  return words.length > 6 ? `${slice}…` : slice;
}

/**
 * Take a short, scannable prefix of an asset id. Strips UUID dashes
 * first so e.g. `402abae3-5ea4-9651-...` collapses to `402aba` (more
 * entropy than `402aba` from the dashed form).
 */
function shortenIdForTitle(rawId: string): string {
  const stripped = rawId.replace(/-/g, '');
  return stripped.slice(0, 6);
}

/**
 * Pretty-print a raw `:Commit.author` string into something a human
 * wants to read.
 *
 * Edison's commit log writes whatever the producer hands it: machine
 * IDs (`device_mac.lan_mnc5mu8m`), email-shaped identifiers
 * (`robb+admin/onereach@onereach.com`), agent names (`Audit Agent`),
 * service principals (`bot-worker-42`). This heuristic doesn't try
 * to resolve identities to `:Person` / `:Agent` nodes (that's a
 * Phase 4+ concern); it just translates the most-common gnarly
 * shapes into something readable, and falls back to the raw author
 * when no rule fits.
 *
 *   device_mac.lan_xxx               -> "Local device"
 *   service-account.lite.local_xxx   -> "Service account"
 *   robb+admin/onereach@onereach.com -> "robb"
 *   robb@onereach.com                -> "robb"
 *   Audit Agent                      -> "Audit Agent"
 *   ""                               -> "Someone"
 *
 * Pure; exported for tests.
 */
export function prettyAuthor(raw: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) return 'Someone';
  const author = raw.trim();
  // Machine / device identifiers — collapse to a generic label so the
  // hex/UUID tail doesn't dominate the headline.
  if (/^device[._-]/i.test(author)) return 'Local device';
  if (/^service[._-]?account/i.test(author)) return 'Service account';
  if (/^system[._-]/i.test(author)) return 'System';
  // Email-shaped → take the local part, drop +tags / role tails.
  const at = author.indexOf('@');
  if (at > 0) {
    const local = author.slice(0, at);
    // Strip role tails: "robb+admin/onereach" → "robb"
    const beforeRole = local.split('/')[0] ?? local;
    const beforePlus = (beforeRole.split('+')[0] ?? beforeRole).trim();
    if (beforePlus.length > 0) return beforePlus;
  }
  return author;
}

/**
 * Merge events + items into a unified chronological timeline.
 * Items dedupe against events when an event was emitted for the same
 * item-creation (matched on item.id appearing in event.kind / id).
 * Pure; exported for tests.
 */
export function mergeTimeline(
  events: ReadonlyArray<RendererEvent>,
  items: ReadonlyArray<RendererItemSummary>
): TimelineRow[] {
  const rows: TimelineRow[] = [];

  for (const item of items) {
    const space = item.otherSpaces[0];
    const row: TimelineRow = {
      kind: 'item',
      id: `item:${item.id}`,
      // Items carry a structured `producedBy` (Person|Agent) when the
      // schema has the edge; for now just pretty-print whatever name
      // is there so device-shaped values still read clean.
      author: prettyAuthor(item.producedBy?.name ?? ''),
      verb: 'added',
      // Hash-shaped or missing titles get a real generated title --
      // "Image · 5b4375", "sunset · photos.example.com", "Quarterly
      // audit q4" etc. -- so the row reads as "added Image · 5b4375"
      // rather than "added 5b4375227558...". Real titles pass through.
      object: generateItemTitle(item),
      timestamp: item.updatedAt || item.createdAt,
      fromAgent: item.producedBy?.kind === 'Agent',
      itemId: item.id,
    };
    if (space !== undefined) {
      row.space = space;
      row.spaceId = space.id;
    }
    if (typeof item.excerpt === 'string' && item.excerpt.length > 0) {
      row.excerpt = item.excerpt;
    }
    rows.push(row);
  }

  for (const e of events) {
    // Soft de-dup: if an item with the same trailing id segment is
    // already in the rows from `items`, skip the event (the item row
    // is richer).
    const isItemEvent = rows.some((r) => r.kind === 'item' && e.id.endsWith(r.itemId ?? '___'));
    if (isItemEvent) continue;

    const space: RendererSpaceChipRef | undefined =
      typeof e.spaceId === 'string' && e.spaceId.length > 0
        ? {
            id: e.spaceId,
            // Apply the same friendly-name guard so events whose
            // server-side Space-name fallback collapsed to the id
            // render as "Unnamed space" instead of a hash.
            name: friendlySpaceName(
              typeof e.spaceName === 'string' && e.spaceName.length > 0
                ? e.spaceName
                : ''
            ),
          }
        : undefined;

    const row: TimelineRow = {
      kind: 'event',
      id: `event:${e.id}`,
      // Source-of-truth author lives on the event; the renderer
      // pretty-prints it so headlines read naturally even when the
      // raw value is a device ID or an email with role tails. The
      // `looksLikeAgentAuthor` flag is computed against the RAW
      // author (the heuristic relies on substrings the pretty-print
      // might strip).
      author: prettyAuthor(e.author),
      verb: deriveVerb(e.kind),
      object: deriveObject(e.kind),
      timestamp: e.timestamp,
      fromAgent: looksLikeAgentAuthor(e.author),
    };
    if (space !== undefined) {
      row.space = space;
      row.spaceId = space.id;
    }
    rows.push(row);
  }

  rows.sort((a, b) => {
    const ta = Date.parse(a.timestamp);
    const tb = Date.parse(b.timestamp);
    const na = Number.isFinite(ta) ? ta : 0;
    const nb = Number.isFinite(tb) ? tb : 0;
    return nb - na;
  });
  return rows;
}

/**
 * Translate a commit `kind` string ("item:added", "item:updated",
 * "auth.refresh", etc.) into a friendly verb phrase. Returns the
 * raw kind when no friendly form is known so we never lose signal.
 */
function deriveVerb(kind: string): string {
  if (typeof kind !== 'string' || kind.length === 0) return 'recorded';
  const lower = kind.toLowerCase();
  if (lower.includes('add')) return 'added';
  if (lower.includes('create')) return 'created';
  if (lower.includes('update')) return 'updated';
  if (lower.includes('delete') || lower.includes('remove')) return 'removed';
  if (lower.includes('produce')) return 'produced';
  if (lower.includes('share')) return 'shared';
  return kind;
}

function deriveObject(kind: string): string {
  if (typeof kind !== 'string' || kind.length === 0) return 'an event';
  // "item:added" -> "an item"; "space:created" -> "a Space"
  const before = kind.split(':')[0]?.toLowerCase() ?? '';
  if (before === 'item' || before === 'asset') return 'an item';
  if (before === 'space') return 'a Space';
  if (before === 'agent') return 'an agent';
  if (before === 'comment' || before === 'message') return 'a comment';
  return 'an event';
}

/** Time bucket categories used by `bucketTimelineByDate`. */
export type TimelineBucketKey = 'today' | 'yesterday' | 'thisWeek' | 'older';

/** One bucket of rows in chronological order, newest first. */
export interface TimelineBucket {
  key: TimelineBucketKey;
  label: string;
  rows: TimelineRow[];
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Group a chronologically-sorted timeline into Today / Yesterday /
 * This week / Older buckets so the renderer can insert sticky-ish
 * section headers and break the wall-of-rows feel.
 *
 * Buckets are derived from the row's `timestamp` against `nowMs`:
 *   - Today:       within the calendar-day window of nowMs (rolling 24h
 *                  rather than literal midnight so timezone math stays
 *                  local-time-free)
 *   - Yesterday:   24-48h before nowMs
 *   - This week:   2-7 days before nowMs
 *   - Older:       7+ days, plus anything with an unparseable timestamp
 *
 * Empty buckets are dropped from the output so the renderer doesn't
 * paint headers with nothing under them. Bucket order is fixed
 * (Today first, Older last) regardless of input.
 *
 * Pure; exported for tests.
 */
export function bucketTimelineByDate(
  rows: ReadonlyArray<TimelineRow>,
  nowMs: number
): TimelineBucket[] {
  const buckets: Record<TimelineBucketKey, TimelineRow[]> = {
    today: [],
    yesterday: [],
    thisWeek: [],
    older: [],
  };
  for (const row of rows) {
    const t = Date.parse(row.timestamp);
    const ageMs = Number.isFinite(t) ? nowMs - t : Number.POSITIVE_INFINITY;
    if (ageMs < ONE_DAY_MS) buckets.today.push(row);
    else if (ageMs < 2 * ONE_DAY_MS) buckets.yesterday.push(row);
    else if (ageMs < 7 * ONE_DAY_MS) buckets.thisWeek.push(row);
    else buckets.older.push(row);
  }
  const out: TimelineBucket[] = [];
  if (buckets.today.length > 0) out.push({ key: 'today', label: 'Today', rows: buckets.today });
  if (buckets.yesterday.length > 0)
    out.push({ key: 'yesterday', label: 'Yesterday', rows: buckets.yesterday });
  if (buckets.thisWeek.length > 0)
    out.push({ key: 'thisWeek', label: 'This week', rows: buckets.thisWeek });
  if (buckets.older.length > 0) out.push({ key: 'older', label: 'Older', rows: buckets.older });
  return out;
}

/**
 * Apply the active filter to a merged timeline. Pure; exported for
 * tests.
 */
export function filterTimeline(
  rows: ReadonlyArray<TimelineRow>,
  filter: HomeFilter,
  nowMs: number
): TimelineRow[] {
  if (filter === 'all') return [...rows];
  if (filter === 'people') return rows.filter((r) => !r.fromAgent);
  if (filter === 'agents') return rows.filter((r) => r.fromAgent);
  const horizonMs = filter === '24h' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  const cutoff = nowMs - horizonMs;
  return rows.filter((r) => {
    const t = Date.parse(r.timestamp);
    return Number.isFinite(t) && t >= cutoff;
  });
}

/**
 * Build the full timeline region: header, list (or skeleton/empty/
 * error), end-of-feed cue. Wires click on each row to navigate to the
 * relevant Space (and item, for item-kind rows).
 */
export function buildHomeTimeline(): HTMLElement {
  const region = document.createElement('section');
  region.className = 'home-timeline';
  region.setAttribute('aria-label', 'Activity timeline');

  const eventsEntry = state.home.events;
  const itemsEntry = state.home.recentItems;

  // Error: both queries failed, no cached data.
  if (
    eventsEntry.error !== null &&
    itemsEntry.error !== null &&
    eventsEntry.value === null &&
    itemsEntry.value === null
  ) {
    region.appendChild(buildCardError(eventsEntry.error));
    return region;
  }

  // Initial load: neither query has resolved yet.
  if (eventsEntry.value === null && itemsEntry.value === null) {
    region.appendChild(buildTimelineSkeleton(8));
    region.classList.add('is-loading');
    return region;
  }

  const merged = mergeTimeline(
    eventsEntry.value ?? [],
    itemsEntry.value ?? []
  );
  const filtered = filterTimeline(merged, state.homeFilter, Date.now());

  if (filtered.length === 0) {
    region.appendChild(buildTimelineEmpty(state.homeFilter, merged.length > 0));
    return region;
  }

  // Time-bucket the rows into Today / Yesterday / This week / Older
  // groups so the wall-of-rows breaks into scannable sections. Each
  // bucket prints its header before its rows; empty buckets are
  // dropped so we never paint a header with nothing under it.
  const buckets = bucketTimelineByDate(filtered, Date.now());
  const list = document.createElement('div');
  list.className = 'home-timeline-list';
  for (const bucket of buckets) {
    list.appendChild(buildTimelineBucketHeader(bucket.label));
    for (const row of bucket.rows) {
      list.appendChild(buildTimelineRow(row));
    }
  }
  region.appendChild(list);

  // End-of-feed cue (only when not actively filtering away rows).
  if (filtered.length >= 5 && filtered.length === merged.length) {
    const tail = document.createElement('div');
    tail.className = 'home-timeline-tail';
    tail.textContent = 'You are all caught up.';
    region.appendChild(tail);
  }

  return region;
}

/**
 * Sticky-ish section header for a timeline bucket ("Today", "This week",
 * etc.). Tiny, subdued -- the goal is to break the row monotony, not
 * to compete with the row content for attention.
 */
function buildTimelineBucketHeader(label: string): HTMLElement {
  const header = document.createElement('div');
  header.className = 'home-timeline-bucket-header';
  header.setAttribute('role', 'separator');
  header.setAttribute('aria-label', label);
  header.textContent = label;
  return header;
}

function buildTimelineEmpty(filter: HomeFilter, hasUnfilteredRows: boolean): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'home-timeline-empty';
  if (hasUnfilteredRows) {
    wrap.textContent =
      filter === '24h'
        ? 'Nothing in the last 24 hours. Try "Last 7 days" or "All".'
        : filter === '7d'
          ? 'Nothing in the last 7 days. Try "All".'
          : filter === 'people'
            ? 'No people-driven activity here. Switch to "Agents" or "All".'
            : 'No agent-driven activity here. Switch to "People" or "All".';
    return wrap;
  }
  wrap.appendChild(
    document.createTextNode(
      'Nothing has happened in your Spaces yet. When you or an agent adds an item, it shows up here.'
    )
  );
  return wrap;
}

function buildTimelineSkeleton(rows: number): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'home-timeline-list';
  for (let i = 0; i < rows; i++) {
    const row = document.createElement('div');
    row.className = 'home-timeline-row is-skeleton';
    const meta = document.createElement('div');
    meta.className = 'home-skeleton home-skeleton-line is-short';
    row.appendChild(meta);
    const title = document.createElement('div');
    title.className = 'home-skeleton home-skeleton-line';
    row.appendChild(title);
    wrap.appendChild(row);
  }
  return wrap;
}

/**
 * Build a single timeline row.
 *
 * Visual: `[icon] [author] [verb] [object]` followed by a meta line
 * (`in [Space] · [recency]`) and an optional excerpt for item rows.
 *
 * Click navigates to the Space (and opens the item in the detail
 * rail when `itemId` is present). Pure DOM construction; the click
 * handler reaches out via `setActiveScope` + `loadItemDetail` which
 * are module-private but in the same renderer bundle.
 */
export function buildTimelineRow(row: TimelineRow): HTMLElement {
  const el = document.createElement('article');
  el.className = `home-timeline-row home-timeline-row-${row.kind}`;
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.setAttribute('data-row-id', row.id);
  if (row.fromAgent) el.classList.add('is-agent');

  // Bulk-select: a row that's part of the current selection set
  // gets the `is-selected` modifier. The renderer reads this every
  // re-paint so toggling state and re-rendering is enough to update
  // visual state without touching the row's instance fields.
  const itemIdForSelection =
    row.kind === 'item' && typeof row.itemId === 'string' ? row.itemId : null;
  if (itemIdForSelection !== null && state.selectedItemIds.has(itemIdForSelection)) {
    el.classList.add('is-selected');
  }

  // Icon: dot whose color signals the producer kind. Agent rows
  // get a square-ish accent, person rows get a circle. (Subtle;
  // accessibility cue is still the text.)
  const dot = document.createElement('span');
  dot.className = 'home-timeline-dot';
  dot.setAttribute('aria-hidden', 'true');
  el.appendChild(dot);

  const body = document.createElement('div');
  body.className = 'home-timeline-body';

  const headline = document.createElement('div');
  headline.className = 'home-timeline-headline';

  const authorEl = document.createElement('span');
  authorEl.className = 'home-timeline-author';
  authorEl.textContent = row.author.length > 0 ? row.author : 'Someone';
  headline.appendChild(authorEl);

  const verbEl = document.createElement('span');
  verbEl.className = 'home-timeline-verb';
  verbEl.textContent = ` ${row.verb} `;
  headline.appendChild(verbEl);

  const objectEl = document.createElement('span');
  objectEl.className = 'home-timeline-object';
  objectEl.textContent = row.object;
  headline.appendChild(objectEl);

  body.appendChild(headline);

  // Meta line: Space chip + recency.
  const meta = document.createElement('div');
  meta.className = 'home-timeline-meta';
  if (row.space !== undefined) {
    const inEl = document.createElement('span');
    inEl.className = 'home-timeline-meta-prefix';
    inEl.textContent = 'in ';
    meta.appendChild(inEl);
    meta.appendChild(buildSpaceChip(row.space));
    meta.appendChild(document.createTextNode(' · '));
  }
  const ts = document.createElement('span');
  ts.className = 'home-timeline-recency';
  ts.textContent = formatRecency(row.timestamp);
  meta.appendChild(ts);
  body.appendChild(meta);

  if (typeof row.excerpt === 'string' && row.excerpt.length > 0) {
    const ex = document.createElement('p');
    ex.className = 'home-timeline-excerpt';
    ex.textContent = row.excerpt;
    body.appendChild(ex);
  }

  el.appendChild(body);

  el.addEventListener('click', (ev) => {
    // Cmd / Ctrl click — toggle bulk-selection without opening the
    // detail rail or switching scope. Only available on item rows
    // (event rows have no asset to act on).
    if ((ev.metaKey || ev.ctrlKey) && itemIdForSelection !== null) {
      ev.preventDefault();
      toggleBulkSelection(itemIdForSelection);
      return;
    }
    // Always open the detail rail when the row represents an item --
    // the user explicitly clicked an asset and expects to see its
    // preview. Previously this branch only fired when the row had a
    // `spaceId`, so clicking an item that wasn't filed into any Space
    // dumped the user into the (often empty) Uncategorized pane with
    // no detail visible. Now the detail rail opens regardless.
    if (row.kind === 'item' && typeof row.itemId === 'string' && row.itemId.length > 0) {
      void loadItemDetail(row.itemId);
    }
    // Switch scope only when we have a real Space -- gives the user
    // context for where the asset lives. For unfiled items we leave
    // the user in their current scope (typically Home) so the main
    // pane stays useful while the detail rail shows the asset; we no
    // longer auto-warp into Uncategorized just because the asset
    // hasn't been filed yet.
    if (typeof row.spaceId === 'string' && row.spaceId.length > 0) {
      setActiveScope(row.spaceId);
    }
  });

  return el;
}

// ─── Context column (secondary right rail of Home) ──────────────────────

/**
 * The small right-rail context column. Holds the durable signals
 * that don't belong in the timeline: who's been active this week,
 * how the user's view is scoped, and a peek at available agents.
 * Each block is independent — none blocks the timeline.
 */
export function buildHomeContext(): HTMLElement {
  const aside = document.createElement('aside');
  aside.className = 'home-context';
  aside.setAttribute('aria-label', 'Spaces context');

  aside.appendChild(buildContextActiveContributors());
  aside.appendChild(buildContextAboutThisView());
  aside.appendChild(buildContextAgentsPeek());

  return aside;
}

function buildContextActiveContributors(): HTMLElement {
  const section = document.createElement('section');
  section.className = 'home-context-section';

  const title = document.createElement('h4');
  title.className = 'home-context-title';
  title.textContent = 'Active this week';
  section.appendChild(title);

  const entry = state.home.contributors;
  if (entry.error !== null && entry.value === null) {
    section.appendChild(buildCardError(entry.error));
    return section;
  }
  const contributors = entry.value;
  if (contributors === null) {
    section.appendChild(buildLinesSkeleton(3));
    return section;
  }
  if (contributors.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'home-context-empty';
    empty.textContent = 'No activity yet this week.';
    section.appendChild(empty);
    return section;
  }
  const list = document.createElement('ul');
  list.className = 'home-context-list';
  for (const c of contributors) {
    const li = document.createElement('li');
    li.className = 'home-context-row';
    const name = document.createElement('span');
    name.className = 'home-context-row-name';
    const rawName = c.displayName.length > 0 ? c.displayName : c.author;
    name.textContent = prettyAuthor(rawName);
    li.appendChild(name);
    const count = document.createElement('span');
    count.className = 'home-context-row-count';
    count.textContent = String(c.events);
    li.appendChild(count);
    list.appendChild(li);
  }
  section.appendChild(list);
  return section;
}

function buildContextAboutThisView(): HTMLElement {
  const section = document.createElement('section');
  section.className = 'home-context-section';

  const title = document.createElement('h4');
  title.className = 'home-context-title';
  title.textContent = 'About this view';
  section.appendChild(title);

  const permEntry = state.home.permission;
  const countsEntry = state.home.counts;

  if (permEntry.value === null && permEntry.error === null) {
    section.appendChild(buildLinesSkeleton(2));
    return section;
  }
  if (permEntry.value === null) {
    section.appendChild(buildCardError(permEntry.error ?? 'Permission unavailable'));
    return section;
  }

  const visible = permEntry.value.visibleSpaceCount;
  const total = permEntry.value.totalSpaceCount;
  const acl = document.createElement('p');
  acl.className = 'home-context-text';
  if (typeof total === 'number' && total > visible) {
    acl.textContent = `You can see ${visible} of ${total} Spaces in this account.`;
  } else {
    acl.textContent =
      visible === 1
        ? 'You can see 1 Space in this account.'
        : `You can see all ${visible} Spaces in this account.`;
  }
  section.appendChild(acl);

  if (countsEntry.value !== null) {
    const summary = document.createElement('p');
    summary.className = 'home-context-text home-context-text-dim';
    summary.textContent = `${formatBigNumber(countsEntry.value.assets)} ${
      countsEntry.value.assets === 1 ? 'item' : 'items'
    } across ${formatBigNumber(countsEntry.value.people)} ${
      countsEntry.value.people === 1 ? 'person' : 'people'
    } and ${formatBigNumber(countsEntry.value.agents)} ${
      countsEntry.value.agents === 1 ? 'agent' : 'agents'
    }.`;
    section.appendChild(summary);
  }

  return section;
}

function buildContextAgentsPeek(): HTMLElement {
  const section = document.createElement('section');
  section.className = 'home-context-section';

  const title = document.createElement('h4');
  title.className = 'home-context-title';
  title.textContent = 'Agents in your account';
  section.appendChild(title);

  const entry = state.home.agents;
  if (entry.error !== null && entry.value === null) {
    section.appendChild(buildCardError(entry.error));
    return section;
  }
  const agents = entry.value;
  if (agents === null) {
    section.appendChild(buildLinesSkeleton(3));
    return section;
  }
  if (agents.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'home-context-empty';
    empty.textContent = 'No agents enabled yet.';
    section.appendChild(empty);
    return section;
  }
  const list = document.createElement('ul');
  list.className = 'home-context-list';
  for (const a of agents) {
    const li = document.createElement('li');
    li.className = 'home-context-row';
    const name = document.createElement('span');
    name.className = 'home-context-row-name';
    name.textContent = a.name;
    li.appendChild(name);
    list.appendChild(li);
  }
  section.appendChild(list);
  const totalAgents = state.home.counts.value?.agents ?? agents.length;
  const remaining = Math.max(0, totalAgents - agents.length);
  if (remaining > 0) {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'home-context-action';
    action.textContent = `+ ${remaining} more — see all`;
    action.addEventListener('click', () => {
      void openAgentsModal();
    });
    section.appendChild(action);
  }
  return section;
}

// ─── Modals (agents "see all") ──────────────────────────────────────────
//
// The timeline-first redesign promoted the unified event/item feed
// to the primary Home surface, so the old "See full timeline →"
// events modal is gone (its content IS the page now). The agents
// "see all" modal stays for the right-rail context column.

async function openAgentsModal(): Promise<void> {
  const bridge = window.lite?.spaces?.home;
  if (bridge === undefined) return;
  const modal = mountModal('All agents in your account');
  const body = modal.querySelector<HTMLElement>('.home-modal-body');
  if (body === null) return;
  body.appendChild(buildLinesSkeleton(8));
  try {
    const envelope = await bridge.agentsSample({ limit: 200 });
    body.replaceChildren();
    if (envelope.ok === false) {
      body.appendChild(buildCardError(envelope.error.message));
      return;
    }
    const agents = envelope.value;
    if (agents.length === 0) {
      body.appendChild(buildEmpty('No agents enabled for your account yet.', ''));
      return;
    }
    for (const a of agents) {
      const row = document.createElement('div');
      row.className = 'home-modal-row';
      const top = document.createElement('div');
      top.className = 'home-modal-row-title';
      top.textContent = a.name;
      row.appendChild(top);
      if (a.description.length > 0) {
        const meta = document.createElement('div');
        meta.className = 'home-modal-row-meta';
        meta.textContent = a.description;
        row.appendChild(meta);
      }
      body.appendChild(row);
    }
  } catch (err) {
    window.logging?.warn?.('spaces', 'agents modal load failed', { error: messageFrom(err) });
    body.replaceChildren();
    body.appendChild(buildCardError(messageFrom(err)));
  }
}

function mountModal(title: string): HTMLElement {
  const existing = document.querySelector<HTMLElement>('.home-modal-backdrop');
  if (existing !== null) existing.remove();
  const backdrop = document.createElement('div');
  backdrop.className = 'home-modal-backdrop';
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
  const modal = document.createElement('div');
  modal.className = 'home-modal';
  const header = document.createElement('div');
  header.className = 'home-modal-header';
  const h = document.createElement('h3');
  h.className = 'home-modal-title';
  h.textContent = title;
  header.appendChild(h);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'home-modal-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';
  close.addEventListener('click', () => backdrop.remove());
  header.appendChild(close);
  modal.appendChild(header);
  const body = document.createElement('div');
  body.className = 'home-modal-body';
  modal.appendChild(body);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  return modal;
}

// ─── Home shared building blocks ────────────────────────────────────────

function buildEmpty(message: string, cta: string): HTMLElement {
  const div = document.createElement('div');
  div.className = 'home-card-empty';
  div.appendChild(document.createTextNode(message));
  if (cta.length > 0) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'home-card-empty-cta';
    button.textContent = cta;
    div.appendChild(document.createTextNode(' '));
    div.appendChild(button);
  }
  return div;
}

function buildCardError(message: string): HTMLElement {
  const div = document.createElement('div');
  div.className = 'home-card-error';
  div.textContent = message;
  return div;
}

function buildLinesSkeleton(rows: number): HTMLElement {
  const wrap = document.createElement('div');
  for (let i = 0; i < rows; i++) {
    const line = document.createElement('div');
    line.className = 'home-skeleton home-skeleton-line';
    if (i % 2 === 1) line.classList.add('is-medium');
    wrap.appendChild(line);
  }
  return wrap;
}

/** Compact-format big numbers (e.g. 1.2k, 3.4M). */
export function formatBigNumber(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.floor(n / 1000)}k`;
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.floor(n / 1_000_000)}M`;
}

/**
 * Friendly relative time string. Returns "today", "yesterday",
 * "3d ago", "2w ago", or the date for older. Pure for tests.
 */
export function formatRecency(value: string | number): string {
  let ms: number;
  if (typeof value === 'number' && Number.isFinite(value)) {
    ms = value;
  } else if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      ms = parsed;
    } else {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) ms = numeric;
      else return '';
    }
  } else {
    return '';
  }
  const diffMs = Date.now() - ms;
  if (!Number.isFinite(diffMs) || diffMs < 0) return 'just now';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr === 1 ? '1h ago' : `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day === 0) return 'today';
  if (day === 1) return 'yesterday';
  if (day < 7) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w ago`;
  try {
    return new Date(ms).toLocaleDateString();
  } catch {
    return '';
  }
}

// ─── Discovery panel (moved to Settings → Diagnostics in chunk 3o) ──────
//
// The Discovery panel is no longer rendered in the Spaces window.
// Engineers reach the runner through Settings → Diagnostics, which
// uses the discovery-format helpers below + the bridge IPC. The
// helpers stay here because the Settings section's "Show raw
// discovery queries" toggle re-uses them.

type DiscoverySummaryKind = 'info' | 'success' | 'warning' | 'failure';

export function buildDiscoveryCard(r: DiscoveryQueryResult): HTMLElement {
  const card = document.createElement('article');
  card.className = 'spaces-discovery-card';
  const head = document.createElement('div');
  head.className = 'spaces-discovery-card-head';
  const title = document.createElement('h4');
  title.className = 'spaces-discovery-card-title';
  title.textContent = r.title;
  head.appendChild(title);
  const gatingPill = document.createElement('span');
  gatingPill.className =
    'spaces-discovery-pill ' +
    (r.gating === 'GATING'
      ? 'spaces-discovery-pill-gating'
      : 'spaces-discovery-pill-informational');
  gatingPill.textContent = r.gating;
  head.appendChild(gatingPill);
  const statusPill = document.createElement('span');
  statusPill.className =
    'spaces-discovery-pill ' +
    (r.ok ? 'spaces-discovery-pill-status-ok' : 'spaces-discovery-pill-status-fail');
  statusPill.textContent = r.ok ? 'OK' : 'FAILED';
  head.appendChild(statusPill);
  card.appendChild(head);
  const rationale = document.createElement('p');
  rationale.className = 'spaces-discovery-rationale';
  rationale.textContent = r.rationale;
  card.appendChild(rationale);
  if (r.summary !== undefined) {
    const summary = document.createElement('div');
    summary.className = 'spaces-discovery-summary-line';
    summary.textContent = r.summary;
    card.appendChild(summary);
  }
  const meta = document.createElement('div');
  meta.className = 'spaces-discovery-meta';
  meta.textContent = `${r.id} · ${r.durationMs}ms · ${r.rows.length} row(s)`;
  card.appendChild(meta);
  if (r.notes.length > 0) {
    const notes = document.createElement('ul');
    notes.className = 'spaces-discovery-notes';
    for (const note of r.notes) {
      const li = document.createElement('li');
      li.textContent = note;
      notes.appendChild(li);
    }
    card.appendChild(notes);
  }
  if (r.ok) {
    if (r.rows.length > 0) {
      const rowsPre = document.createElement('pre');
      rowsPre.className = 'spaces-discovery-rows';
      rowsPre.textContent = JSON.stringify(r.rows, null, 2);
      card.appendChild(rowsPre);
    }
  } else if (r.error !== undefined) {
    const errBox = document.createElement('div');
    errBox.className = 'spaces-discovery-error';
    errBox.textContent = `[${r.error.code}] ${r.error.message}`;
    card.appendChild(errBox);
  }
  return card;
}

export function buildDiscoverySummary(results: DiscoveryResults): {
  kind: DiscoverySummaryKind;
  text: string;
} {
  const total = results.results.length;
  const passed = results.results.filter((r) => r.ok).length;
  const failedGating = results.results.filter(
    (r) => !r.ok && r.gating === 'GATING'
  ).length;
  const failedInfo = results.results.filter(
    (r) => !r.ok && r.gating === 'INFORMATIONAL'
  ).length;
  if (failedGating > 0) {
    return {
      kind: 'failure',
      text: `Discovery complete — ${passed}/${total} passed, ${failedGating} GATING failure(s). Resolve gating items before Phase 2 design lock.`,
    };
  }
  if (failedInfo > 0) {
    return {
      kind: 'warning',
      text: `Discovery complete — ${passed}/${total} passed, ${failedInfo} INFORMATIONAL failure(s). Note results and continue.`,
    };
  }
  return {
    kind: 'success',
    text: `Discovery complete — all ${total} queries passed. Capture the Markdown export and resolve Q5/Q6 with the Edison team.`,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

const KIND_LABELS: Readonly<Record<string, string>> = {
  document: 'Doc',
  image: 'Image',
  url: 'URL',
  text: 'Text',
  audio: 'Audio',
  video: 'Video',
  playbook: 'Playbook',
  ticket: 'Ticket',
  agent: 'Agent',
  transcript: 'Transcript',
  knowledge: 'Knowledge',
  journey: 'Journey',
  other: 'Other',
};

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? 'Other';
}

/**
 * Lower-case + strip whitespace so the comparison is forgiving without
 * being unicode-fancy. The Spaces filter is a quick keyboard helper,
 * not a search engine.
 */
export function normalizeSearchQuery(q: string): string {
  return typeof q === 'string' ? q.trim().toLowerCase() : '';
}

/**
 * Substring match on a normalized query. Returns true when the query
 * is empty (so an empty box matches everything) or the name contains
 * the query. Pulled into its own function so tests can pin the rule
 * without driving the DOM.
 */
export function matchesSearchQuery(name: string, query: string): boolean {
  const q = normalizeSearchQuery(query);
  if (q.length === 0) return true;
  if (typeof name !== 'string') return false;
  return name.toLowerCase().includes(q);
}

export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.floor(n / 1000)}k`;
}

export function formatRelativeTime(iso: string): string {
  if (typeof iso !== 'string' || iso.length === 0) return '';
  // Route through parseTimestamp so epoch-millis values (written by
  // GSX / WISER Playbooks) render as a date instead of leaking the raw
  // number into the UI, which is what `return iso` used to do.
  const t = parseTimestamp(iso);
  if (t === null) return iso;
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  const d = new Date(t);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function isWellFormedSpace(v: unknown): v is RendererSpace {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r['id'] === 'string' && typeof r['name'] === 'string';
}

function isWellFormedItem(v: unknown): v is RendererItemSummary {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r['id'] === 'string' && typeof r['title'] === 'string';
}

function messageFrom(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── Test escape hatch ──────────────────────────────────────────────────

(window as unknown as {
  __spacesRendererForTesting?: unknown;
}).__spacesRendererForTesting = {
  focusItemTile,
  safeCssColor,
  stripMarkdownForExcerpt,
  buildSpaceRow,
  buildItemCard,
  buildSpaceChip,
  buildDetailPane,
  buildDetailMeta,
  buildDetailTags,
  buildDetailContent,
  buildEditableTitle,
  buildEditableDescription,
  buildKindReclassify,
  buildAttributionChip,
  buildDetailActivity,
  buildTicketStatusPill,
  buildDetailTicketBlock,
  buildDetailPlaybookBlock,
  buildDetailMetadata,
  buildCodePreview,
  buildCsvPreview,
  detectTextPreviewLanguage,
  isBase64DataUrl,
  isPdfTitle,
  fileExtBadge,
  fileExtFamily,
  tileExcerptText,
  parsePlaybookSteps,
  grabVideoFrame,
  buildHexMazeLogo,
  parseKnowledgePreview,
  shortStageLabel,
  buildAgentLibraryRow,
  buildTileHoverText,
  buildMemberPickerRow,
  buildExistingAssetRow,
  // Shared-dashboard sections (2026-08-08 review: error-state honesty).
  buildSharedMembersRow,
  buildSharedDashboardPlaybook,
  buildSharedDashboardTickets,
  renderMarkdown,
  renderInlineMarkdown,
  formatBytes,
  buildBinaryPreview,
  buildPdfViewer,
  buildItemsToolbar,
  buildBulkSelectToolbar,
  formatCount,
  formatRelativeTime,
  normalizeSearchQuery,
  matchesSearchQuery,
  sortSpaces,
  composeSpaceDescription,
  normalizeWizardPerson,
  // Home (chunk 3o) — timeline-first builders + pure helpers.
  buildWelcomeCard,
  buildFilterChips,
  buildTimelineRow,
  mergeTimeline,
  filterTimeline,
  filterItemsByHomeFilter,
  formatSinceLastVisit,
  countTimelineSince,
  looksLikeAgentAuthor,
  prettyAuthor,
  // Noise-reduction helpers used by mergeTimeline + buildSpaceChip to
  // hide hash/UUID-shaped fallback strings (Phase 3 / "calm spaces").
  looksLikeIdString,
  friendlyObjectForItem,
  friendlySpaceName,
  generateItemTitle,
  bucketTimelineByDate,
  buildDetailEmptyContentHint,
  buildPreviewPlaceholder,
  buildPreviewUnavailable,
  formatBigNumber,
  formatRecency,
  HOME_SCOPE_ID,
  /**
   * Re-run the renderer's boot sequence. Tests use this to drive a
   * scenario by:
   *   1. building the DOM scaffold,
   *   2. installing a `window.lite.spaces` stub bridge,
   *   3. calling `reinitForTesting()` and awaiting the returned promise.
   * Production never calls this -- the IIFE boot path on
   * `DOMContentLoaded` handles the only legitimate init.
   */
  async reinitForTesting(): Promise<void> {
    state.activeScopeId = HOME_SCOPE_ID;
    state.spaces = [];
    state.uncategorizedCount = 0;
    state.items = [];
    state.activeItemId = null;
    state.searchQuery = '';
    state.loadingSpaces = true;
    state.loadingItems = false;
    state.loadingDetail = false;
    state.lastDiscovery = null;
    state.discoveryInFlight = false;
    state.home = {
      counts: emptyCacheEntry<RendererEntityCounts>(),
      contributors: emptyCacheEntry<RendererContributor[]>(),
      agents: emptyCacheEntry<RendererAgentSummary[]>(),
      permission: emptyCacheEntry<RendererPermissionSummary>(),
      recentItems: emptyCacheEntry<RendererItemSummary[]>(),
      events: emptyCacheEntry<RendererEvent[]>(),
    };
    state.homeFilter = 'all';
    state.welcomeDismissed = readWelcomeDismissed();
    state.lastVisitMs = readLastVisitMs();
    state.currentVisitMs = Date.now();
    init();
    // Allow the fire-and-forget initialLoad() to flush.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  },
};

// ─── Mutations UI (Phase 3a) ────────────────────────────────────────────
//
// Wires the three mutation surfaces:
//   1. "+ New Space" header button → modal → createSpace
//   2. Per-row ⋯ menu → Rename (inline input) / Delete (soft + undo toast)
//   3. Toast at bottom with Undo for soft-delete reversal (undeleteSpace)
//
// All bridge calls are best-effort with inline error display. The
// global state.spaces is refreshed via loadSpaces() after every
// successful mutation so the sidebar reflects ground truth -- we don't
// optimistic-update local state because the server-assigned id /
// timestamps come back in the response we'd have to merge anyway.

interface RowMenuState {
  spaceId: string | null;
  triggerEl: HTMLButtonElement | null;
}

const rowMenuState: RowMenuState = {
  spaceId: null,
  triggerEl: null,
};

interface ToastState {
  hideTimer: ReturnType<typeof setTimeout> | null;
  /** Undo handler for the currently-shown toast, if any. */
  onUndo: (() => void) | null;
}

const toastState: ToastState = {
  hideTimer: null,
  onUndo: null,
};

/** Wire the mutation surfaces. Called once from `init()`. */
function wireMutationsUI(): void {
  wireNewSpaceButton();
  wireNewSharedSpaceButton();
  wireRefreshButton();
  wireRefreshOnFocus();
  wireStalenessWatchdog();
  wireNewSpaceDialog();
  wireRowMenuTriggers();
  wireRowMenu();
  wireToast();
  wireNewAssetDialog();
  wireDragDropAssetUpload();
}

// ─── "+ New Space" guided wizard ────────────────────────────────────────
//
// AI-driven Space creation. The "+ New Space" (and "+ Shared") buttons open
// a 4-step wizard that captures the metadata the old name-only dialog
// skipped: a purpose, 3-5 high-level objectives, and people to add up
// front. Step 2 offers an optional "Draft with AI" action that calls
// window.lite.ai (Claude API or a OneReach flow) to turn a rough purpose
// into a polished description + objectives the user can edit. AI is
// strictly optional -- the wizard works end-to-end with manual entry when
// no provider is configured.
//
// Objectives are folded into the Space `description` (the only metadata
// text field the data model exposes today) via composeSpaceDescription;
// people are added via identity.getOrCreatePerson + members.add.

interface WizardPerson {
  name: string;
  email: string;
}

interface NewSpaceWizardState {
  step: 1 | 2 | 3 | 4;
  name: string;
  purpose: string;
  description: string;
  objectives: string[];
  people: WizardPerson[];
  shared: boolean;
  aiConfigured: boolean;
  aiProvider: 'claude' | 'onereach-flow' | null;
  busy: boolean;
}

const WIZARD_STEP_LABELS: Record<NewSpaceWizardState['step'], string> = {
  1: 'Basics',
  2: 'Purpose & objectives',
  3: 'People',
  4: 'Review',
};

const MAX_WIZARD_OBJECTIVES = 6;

let newSpaceWizard: NewSpaceWizardState | null = null;

/**
 * Pull fresh data from the graph on demand.
 *
 * Spaces can be created OUTSIDE this app — in WISER Playbooks, or by an
 * agent writing straight to the graph. Those writes don't invalidate
 * our cache, so until now the only path to seeing them was waiting on
 * the background refresh timer, with no way to force it. This is that
 * way.
 */
async function refreshFromGraph(trigger: 'button' | 'focus'): Promise<void> {
  const bridge = window.lite?.spaces;
  if (bridge === undefined || typeof bridge.refresh !== 'function') return;
  if (refreshInFlight) return; // coalesce: focus + click can race
  refreshInFlight = true;
  const button = document.getElementById('spaces-refresh-button');
  if (button instanceof HTMLButtonElement) {
    button.disabled = true;
    button.classList.add('is-refreshing');
  }
  try {
    // A hung IPC would leave refreshInFlight stuck true forever,
    // silently disabling focus-refresh AND the staleness watchdog
    // (observed live 2026-08-17: exactly one watchdog attempt, then
    // nothing). The race guarantees the flag always clears.
    const result = await Promise.race([
      bridge.refresh(),
      new Promise<{ ok: false; error: { message: string } }>((resolve) => {
        setTimeout(() => resolve({ ok: false, error: { message: 'refresh timed out' } }), 20_000);
      }),
    ]);
    if (result.ok === false && trigger === 'button') {
      showToast(`Couldn't refresh: ${result.error.message}`);
      return;
    }
    // The main process broadcasts cache-updated per key, which routes
    // to loadSpaces()/loadItems(). Reload the sidebar directly too so a
    // manual click always repaints even if a broadcast is missed.
    await loadSpaces();
    void loadUncategorizedCount();
    if (state.activeScopeId === HOME_SCOPE_ID) void loadHome();
    else void loadItems();
  } catch (err) {
    window.logging?.warn?.('spaces', 'refreshFromGraph failed', { trigger, error: messageFrom(err) });
    if (trigger === 'button') showToast(`Couldn't refresh: ${(err as Error).message}`);
  } finally {
    refreshInFlight = false;
    if (button instanceof HTMLButtonElement) {
      button.disabled = false;
      button.classList.remove('is-refreshing');
    }
  }
}

function wireRefreshButton(): void {
  const button = document.getElementById('spaces-refresh-button');
  if (button === null) return;
  button.addEventListener('click', () => {
    void refreshFromGraph('button');
  });
}

/**
 * Refresh when the window regains focus. This is what makes the
 * cross-app flow feel right: create a Space in WISER Playbooks, click
 * back to Spaces, and it's there. Throttled so alt-tabbing doesn't
 * hammer the graph.
 */
function wireRefreshOnFocus(): void {
  window.addEventListener('focus', () => {
    const now = Date.now();
    if (now - lastFocusRefreshAt < FOCUS_REFRESH_THROTTLE_MS) return;
    lastFocusRefreshAt = now;
    void refreshFromGraph('focus');
  });
  // Focus only fires on TRANSITIONS — a window sitting frontmost never
  // re-triggers it. visibilitychange covers un-minimize / space-switch
  // arrivals that don't change focus (2026-08-16: a member grant never
  // surfaced in an already-open window).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const now = Date.now();
    if (now - lastFocusRefreshAt < FOCUS_REFRESH_THROTTLE_MS) return;
    lastFocusRefreshAt = now;
    void refreshFromGraph('focus');
  });
}

// ─── Staleness watchdog (2026-08-16) ────────────────────────────────────
//
// The 60s background cache refresh fails SILENTLY when the graph
// endpoint flakes (Edison 503s observed live): the cache serves stale
// data, no broadcast arrives, and an open window can miss changes made
// from other machines — "I added a user to a Space but it didn't show
// up until they reopened Spaces." The watchdog makes that state
// visible and self-healing: if no cache-updated broadcast lands for
// 3× the refresh interval while the page is visible, show a subtle
// hint and force a refresh; any successful update clears it.

/** Epoch ms of the last cache-updated broadcast (any key). */
let lastCacheBroadcastAt = Date.now();
/** 3× the main-process refresh interval (60s). */
const STALE_AFTER_MS = 180_000;
const WATCHDOG_TICK_MS = 30_000;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;

function markCacheBroadcast(): void {
  lastCacheBroadcastAt = Date.now();
  const hint = document.getElementById('spaces-stale-hint');
  if (hint !== null) hint.remove();
}

function showStaleHint(): void {
  if (document.getElementById('spaces-stale-hint') !== null) return;
  const sidebar = document.getElementById('spaces-sidebar');
  if (sidebar === null) return;
  const hint = document.createElement('div');
  hint.id = 'spaces-stale-hint';
  hint.className = 'spaces-stale-hint';
  hint.setAttribute('role', 'status');
  hint.textContent = 'Having trouble reaching the graph — data may be out of date. Retrying…';
  sidebar.appendChild(hint);
}

function wireStalenessWatchdog(): void {
  if (watchdogTimer !== null) clearInterval(watchdogTimer);
  lastCacheBroadcastAt = Date.now();
  watchdogTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastCacheBroadcastAt < STALE_AFTER_MS) return;
    showStaleHint();
    // Self-heal: force a real refetch (throttle-free — the watchdog
    // itself ticks at 30s, and refreshFromGraph coalesces in-flight).
    void refreshFromGraph('focus');
  }, WATCHDOG_TICK_MS);
}

function wireNewSharedSpaceButton(): void {
  const button = document.getElementById('spaces-new-shared-button');
  if (button === null) return;
  button.addEventListener('click', () => {
    openNewSpaceDialog({ shared: true });
  });
}

function wireNewSpaceButton(): void {
  const button = document.getElementById('spaces-new-button');
  if (button === null) return;
  button.addEventListener('click', () => {
    openNewSpaceDialog();
  });
}

function openNewSpaceDialog(opts: { shared?: boolean } = {}): void {
  const backdrop = document.getElementById('spaces-new-dialog-backdrop');
  const host = document.getElementById('spaces-new-wizard');
  if (backdrop === null || host === null) return;
  newSpaceWizard = {
    step: 1,
    name: '',
    purpose: '',
    description: '',
    objectives: [],
    people: [],
    shared: opts.shared === true,
    aiConfigured: false,
    aiProvider: null,
    busy: false,
  };
  backdrop.hidden = false;
  backdrop.setAttribute('aria-hidden', 'false');
  renderNewSpaceWizard();
  requestAnimationFrame(() => {
    const first = document.getElementById('spaces-new-name-input');
    if (first instanceof HTMLInputElement) first.focus();
  });
  // Probe AI availability in the background and refresh the step-2
  // affordance when it resolves. Never blocks the wizard.
  const aiBridge = window.lite?.ai;
  if (aiBridge !== undefined) {
    void aiBridge
      .getStatus()
      .then((res) => {
        if (newSpaceWizard === null || res.ok === false) return;
        newSpaceWizard.aiConfigured = res.value.configured;
        newSpaceWizard.aiProvider = res.value.provider;
        if (newSpaceWizard.step === 2) renderNewSpaceWizard();
      })
      .catch(() => {
        /* status probe is best-effort */
      });
  }
}

function closeNewSpaceDialog(): void {
  const backdrop = document.getElementById('spaces-new-dialog-backdrop');
  newSpaceWizard = null;
  if (backdrop === null) return;
  backdrop.hidden = true;
  backdrop.setAttribute('aria-hidden', 'true');
}

function wireNewSpaceDialog(): void {
  const backdrop = document.getElementById('spaces-new-dialog-backdrop');
  if (backdrop !== null) {
    // Click on the dim area (NOT the modal itself) closes the dialog,
    // unless a request is in flight.
    backdrop.addEventListener('click', (ev) => {
      if (ev.target === backdrop && newSpaceWizard !== null && newSpaceWizard.busy === false) {
        closeNewSpaceDialog();
      }
    });
  }
  // Single Enter-to-advance handler (attached once; reads live state).
  const host = document.getElementById('spaces-new-wizard');
  if (host !== null) {
    host.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      const w = newSpaceWizard;
      if (w === null || w.busy) return;
      const target = ev.target;
      if (target instanceof HTMLTextAreaElement) return; // newline in textareas
      if (!(target instanceof HTMLInputElement)) return;
      ev.preventDefault();
      if (w.step === 4) void createSpaceFromWizard();
      else handleWizardNext();
    });
  }
  // Esc closes the wizard (when not busy); otherwise falls through to the
  // existing row-menu / bulk-selection handling.
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (newSpaceWizard !== null) {
      if (newSpaceWizard.busy === false) closeNewSpaceDialog();
      return;
    }
    if (rowMenuState.spaceId !== null) {
      closeRowMenu();
      return;
    }
    if (state.selectedItemIds.size > 0) clearBulkSelection();
  });
}

// ── Pure helpers (exported for tests via __spacesRendererForTesting) ──────

/**
 * Fold the polished description and objectives into a single Space
 * `description` string -- the only metadata text field the data model
 * exposes today. Objectives render as a bulleted block beneath the
 * purpose. Empty objectives are dropped.
 */
function composeSpaceDescription(description: string, objectives: string[]): string {
  const desc = description.trim();
  const objs = objectives.map((o) => o.trim()).filter((o) => o.length > 0);
  if (objs.length === 0) return desc;
  const block = `Objectives:\n${objs.map((o) => `• ${o}`).join('\n')}`;
  return desc.length > 0 ? `${desc}\n\n${block}` : block;
}

/**
 * Turn a wizard person row into an identity-upsert payload, or null when
 * the row is blank. The id is the email when present (stable per person),
 * otherwise a slug + random suffix.
 */
function normalizeWizardPerson(
  p: WizardPerson
): { identity: { id: string; name?: string; email?: string } } | null {
  const name = p.name.trim();
  const email = p.email.trim();
  if (name.length === 0 && email.length === 0) return null;
  const id = email.length > 0 ? email.toLowerCase() : `person-${slugify(name)}-${randomSuffix()}`;
  const identity: { id: string; name?: string; email?: string } = { id };
  if (name.length > 0) identity.name = name;
  if (email.length > 0) identity.email = email;
  return { identity };
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'person';
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

// ── DOM construction ──────────────────────────────────────────────────────

function wizEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className !== undefined) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function renderNewSpaceWizard(): void {
  const w = newSpaceWizard;
  const host = document.getElementById('spaces-new-wizard');
  if (w === null || host === null) return;
  host.replaceChildren();

  const head = wizEl('div', 'spaces-wizard-head');
  const title = wizEl('h2', 'spaces-wizard-title', w.shared ? 'New shared space' : 'New space');
  title.id = 'spaces-new-dialog-title';
  head.appendChild(title);
  const steps = wizEl('div', 'spaces-wizard-steps');
  steps.setAttribute('aria-hidden', 'true');
  ([1, 2, 3, 4] as const).forEach((n) => {
    const pill = wizEl('span', 'spaces-wizard-step-pill', String(n));
    if (n === w.step) pill.classList.add('is-active');
    else if (n < w.step) pill.classList.add('is-done');
    steps.appendChild(pill);
  });
  head.appendChild(steps);
  host.appendChild(head);

  host.appendChild(
    wizEl('p', 'spaces-modal-help', `Step ${w.step} of 4 · ${WIZARD_STEP_LABELS[w.step]}`)
  );

  const body = wizEl('div', 'spaces-wizard-body');
  if (w.step === 1) body.appendChild(buildWizardStepBasics(w));
  else if (w.step === 2) body.appendChild(buildWizardStepDetails(w));
  else if (w.step === 3) body.appendChild(buildWizardStepPeople(w));
  else body.appendChild(buildWizardStepReview(w));
  host.appendChild(body);

  const error = wizEl('div', 'spaces-modal-error');
  error.id = 'spaces-new-error';
  error.hidden = true;
  host.appendChild(error);

  const foot = wizEl('div', 'spaces-wizard-foot');
  const left = wizEl('button', 'spaces-modal-button', w.step === 1 ? 'Cancel' : 'Back');
  left.type = 'button';
  left.disabled = w.busy;
  left.addEventListener('click', () => {
    if (w.step === 1) closeNewSpaceDialog();
    else handleWizardBack();
  });
  foot.appendChild(left);

  const rightLabel = w.step === 4 ? (w.busy ? 'Creating…' : 'Create space') : 'Next';
  const right = wizEl('button', 'spaces-modal-button spaces-modal-button-primary', rightLabel);
  right.type = 'button';
  right.disabled = w.busy;
  right.addEventListener('click', () => {
    if (w.step === 4) void createSpaceFromWizard();
    else handleWizardNext();
  });
  foot.appendChild(right);
  host.appendChild(foot);
}

function buildWizardStepBasics(w: NewSpaceWizardState): HTMLElement {
  const step = wizEl('div', 'spaces-wizard-step');

  const nameField = wizEl('div', 'spaces-wizard-field');
  const nameLabel = wizEl('label', 'spaces-modal-label', 'Name');
  nameLabel.setAttribute('for', 'spaces-new-name-input');
  const nameInput = wizEl('input', 'spaces-modal-input');
  nameInput.id = 'spaces-new-name-input';
  nameInput.type = 'text';
  nameInput.value = w.name;
  nameInput.placeholder = 'e.g. Quarterly Audit';
  nameInput.maxLength = 80;
  nameInput.autocomplete = 'off';
  nameInput.spellcheck = false;
  nameField.append(nameLabel, nameInput);

  const purposeField = wizEl('div', 'spaces-wizard-field');
  const purposeLabel = wizEl('label', 'spaces-modal-label', 'What is this Space for?');
  purposeLabel.setAttribute('for', 'spaces-new-purpose-input');
  const purposeInput = wizEl('textarea', 'spaces-modal-input spaces-wizard-textarea');
  purposeInput.id = 'spaces-new-purpose-input';
  purposeInput.value = w.purpose;
  purposeInput.rows = 3;
  purposeInput.placeholder =
    'A sentence or two about the purpose — the AI can polish this and suggest objectives next.';
  const hint = wizEl(
    'p',
    'spaces-wizard-hint',
    'Optional, but it powers the AI draft on the next step.'
  );
  purposeField.append(purposeLabel, purposeInput, hint);

  step.append(nameField, purposeField);
  return step;
}

function buildWizardStepDetails(w: NewSpaceWizardState): HTMLElement {
  const step = wizEl('div', 'spaces-wizard-step');

  if (window.lite?.ai !== undefined) {
    const aiBox = wizEl('div', 'spaces-wizard-ai');
    const aiBtn = wizEl('button', 'spaces-wizard-ai-btn', w.busy ? 'Drafting…' : '✨ Draft with AI');
    aiBtn.type = 'button';
    aiBtn.disabled = w.busy || !w.aiConfigured;
    aiBtn.addEventListener('click', () => {
      void handleDraftWithAi();
    });
    const providerLabel =
      w.aiProvider === 'claude' ? 'Claude' : w.aiProvider === 'onereach-flow' ? 'OneReach flow' : null;
    const hint = wizEl(
      'span',
      'spaces-wizard-hint',
      w.aiConfigured
        ? `Turns your purpose into a polished description + objectives${providerLabel !== null ? ` (via ${providerLabel})` : ''}.`
        : 'Connect a Claude API key or a OneReach flow to enable AI drafting (see lite/ai/README.md). You can still fill these in manually.'
    );
    aiBox.append(aiBtn, hint);
    step.appendChild(aiBox);
  }

  const descField = wizEl('div', 'spaces-wizard-field');
  const descLabel = wizEl('label', 'spaces-modal-label', 'Description');
  descLabel.setAttribute('for', 'spaces-new-desc-input');
  const descInput = wizEl('textarea', 'spaces-modal-input spaces-wizard-textarea');
  descInput.id = 'spaces-new-desc-input';
  descInput.rows = 3;
  descInput.value = w.description.length > 0 ? w.description : w.purpose;
  descInput.placeholder = "A clear statement of the Space's purpose.";
  descField.append(descLabel, descInput);
  step.appendChild(descField);

  const objField = wizEl('div', 'spaces-wizard-field');
  objField.appendChild(wizEl('label', 'spaces-modal-label', 'High-level objectives'));
  const list = wizEl('div', 'spaces-wizard-rows');
  list.id = 'spaces-new-objectives';
  const objs = w.objectives.length > 0 ? w.objectives : [''];
  objs.forEach((obj, i) => list.appendChild(buildObjectiveRow(obj, i)));
  objField.appendChild(list);
  const addBtn = wizEl('button', 'spaces-wizard-add', '+ Add objective');
  addBtn.type = 'button';
  addBtn.disabled = w.busy;
  addBtn.addEventListener('click', () => {
    captureNewSpaceStep();
    if (newSpaceWizard === null || newSpaceWizard.objectives.length >= MAX_WIZARD_OBJECTIVES) return;
    newSpaceWizard.objectives.push('');
    renderNewSpaceWizard();
    focusLast('#spaces-new-objectives .spaces-wizard-row-input');
  });
  objField.appendChild(addBtn);
  step.appendChild(objField);

  return step;
}

function buildObjectiveRow(value: string, index: number): HTMLElement {
  const row = wizEl('div', 'spaces-wizard-row');
  const input = wizEl('input', 'spaces-modal-input spaces-wizard-row-input');
  input.type = 'text';
  input.value = value;
  input.placeholder = 'e.g. Centralize vendor contracts';
  const remove = wizEl('button', 'spaces-wizard-row-remove', '×');
  remove.type = 'button';
  remove.title = 'Remove objective';
  remove.setAttribute('aria-label', 'Remove objective');
  remove.addEventListener('click', () => {
    captureNewSpaceStep();
    if (newSpaceWizard === null) return;
    newSpaceWizard.objectives.splice(index, 1);
    renderNewSpaceWizard();
  });
  row.append(input, remove);
  return row;
}

function buildWizardStepPeople(w: NewSpaceWizardState): HTMLElement {
  const step = wizEl('div', 'spaces-wizard-step');
  step.appendChild(
    wizEl(
      'p',
      'spaces-modal-help',
      'Add people to this Space now, or skip and add them later. A name or an email is enough.'
    )
  );
  const list = wizEl('div', 'spaces-wizard-rows');
  list.id = 'spaces-new-people';
  const people = w.people.length > 0 ? w.people : [{ name: '', email: '' }];
  people.forEach((p, i) => list.appendChild(buildPersonRow(p, i)));
  step.appendChild(list);
  const addBtn = wizEl('button', 'spaces-wizard-add', '+ Add person');
  addBtn.type = 'button';
  addBtn.disabled = w.busy;
  addBtn.addEventListener('click', () => {
    captureNewSpaceStep();
    if (newSpaceWizard === null) return;
    newSpaceWizard.people.push({ name: '', email: '' });
    renderNewSpaceWizard();
    focusLast('#spaces-new-people .spaces-wizard-person-name');
  });
  step.appendChild(addBtn);
  return step;
}

/**
 * People-only view of the member library for the wizard typeahead:
 * agents don't belong in the "add people" step. Exported for tests.
 */
export function personTypeaheadEntries(
  entries: ReadonlyArray<{ kind: string; id: string; name: string; email: string }>
): Array<{ id: string; name: string; email: string }> {
  const seen = new Set<string>();
  const out: Array<{ id: string; name: string; email: string }> = [];
  for (const e of entries) {
    if (e.kind !== 'Person') continue;
    const key = e.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: e.id, name: e.name, email: e.email });
  }
  return out;
}

/**
 * Graph-backed typeahead for a wizard person input: focus shows the
 * account's people immediately (empty query returns the library
 * head), typing filters, clicking fills the row. Free text remains
 * valid — the dropdown assists, it never gates.
 */
function attachPersonTypeahead(
  input: HTMLInputElement,
  // Kept for call-site symmetry; the panel is portaled to <body> now.
  _host: HTMLElement,
  onPick: (person: { id: string; name: string; email: string }) => void
): void {
  let panel: HTMLDivElement | null = null;
  let seq = 0;
  let debounce: number | null = null;

  const closePanel = (): void => {
    panel?.remove();
    panel = null;
  };

  const renderPanel = (people: Array<{ id: string; name: string; email: string }>): void => {
    closePanel();
    if (people.length === 0) return;
    panel = document.createElement('div');
    panel.className = 'spaces-wizard-typeahead';
    for (const person of people) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'spaces-wizard-typeahead-row';
      const nameEl = document.createElement('span');
      nameEl.className = 'spaces-wizard-typeahead-name';
      nameEl.textContent = person.name;
      row.appendChild(nameEl);
      if (person.email.length > 0 && person.email !== person.name) {
        const emailEl = document.createElement('span');
        emailEl.className = 'spaces-wizard-typeahead-email';
        emailEl.textContent = person.email;
        row.appendChild(emailEl);
      }
      // mousedown, not click: it fires before the input's blur.
      row.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        closePanel();
        onPick(person);
      });
      panel.appendChild(row);
    }
    // Portal to <body> with fixed positioning: the wizard body is an
    // overflow-y:auto region, so an absolutely-positioned child panel
    // gets clipped at its bottom edge (worst on the last person row —
    // the common case). Fixed + measured placement escapes the clip.
    panel.style.position = 'fixed';
    panel.style.visibility = 'hidden';
    document.body.appendChild(panel);
    const inputRect = input.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    panel.style.left = `${Math.round(inputRect.left)}px`;
    panel.style.width = `${Math.round(inputRect.width)}px`;
    const fitsBelow = inputRect.bottom + 4 + panelRect.height <= window.innerHeight - 8;
    panel.style.top = fitsBelow
      ? `${Math.round(inputRect.bottom + 4)}px`
      : `${Math.max(8, Math.round(inputRect.top - 4 - panelRect.height))}px`;
    panel.style.visibility = '';
  };

  const search = (q: string): void => {
    const bridge = window.lite?.spaces;
    if (bridge === undefined) return;
    const mySeq = ++seq;
    void (async (): Promise<void> => {
      try {
        const envelope = await bridge.members.searchLibrary(q, 8);
        if (mySeq !== seq) return;
        if (envelope.ok !== true) return;
        renderPanel(personTypeaheadEntries(envelope.value));
      } catch {
        /* typeahead is assistance; silence is fine */
      }
    })();
  };

  input.addEventListener('focus', () => search(input.value.trim()));
  input.addEventListener('input', () => {
    if (debounce !== null) window.clearTimeout(debounce);
    debounce = window.setTimeout(() => search(input.value.trim()), 180);
  });
  input.addEventListener('blur', () => {
    // Delay so a mousedown pick on the panel lands first.
    window.setTimeout(closePanel, 150);
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closePanel();
  });
}

function buildPersonRow(p: WizardPerson, index: number): HTMLElement {
  const row = wizEl('div', 'spaces-wizard-row');
  const name = wizEl('input', 'spaces-modal-input spaces-wizard-person-name');
  name.type = 'text';
  name.value = p.name;
  name.placeholder = 'Name';
  name.setAttribute('data-person-field', 'name');
  const email = wizEl('input', 'spaces-modal-input spaces-wizard-person-email');
  email.type = 'email';
  email.value = p.email;
  email.placeholder = 'Email';
  email.setAttribute('data-person-field', 'email');
  const remove = wizEl('button', 'spaces-wizard-row-remove', '×');
  remove.type = 'button';
  remove.title = 'Remove person';
  remove.setAttribute('aria-label', 'Remove person');
  remove.addEventListener('click', () => {
    captureNewSpaceStep();
    if (newSpaceWizard === null) return;
    newSpaceWizard.people.splice(index, 1);
    renderNewSpaceWizard();
  });
  row.append(name, email, remove);
  // Graph-backed dropdown: focus either field to see the account's
  // people; picking one fills both fields (2026-08-12 user request).
  const pick = (person: { id: string; name: string; email: string }): void => {
    captureNewSpaceStep();
    if (newSpaceWizard === null) return;
    const entry = newSpaceWizard.people[index];
    if (entry === undefined) return;
    entry.name = person.name;
    entry.email = person.email.length > 0 ? person.email : person.id;
    renderNewSpaceWizard();
  };
  attachPersonTypeahead(name, row, pick);
  attachPersonTypeahead(email, row, pick);
  return row;
}

function buildWizardStepReview(w: NewSpaceWizardState): HTMLElement {
  const step = wizEl('div', 'spaces-wizard-step spaces-wizard-review');
  step.appendChild(buildReviewRow('Name', w.name.trim().length > 0 ? w.name.trim() : '—'));
  if (w.shared) step.appendChild(buildReviewRow('Kind', 'Shared · AI-managed'));

  const desc = (w.description.trim().length > 0 ? w.description : w.purpose).trim();
  step.appendChild(buildReviewRow('Description', desc.length > 0 ? desc : '—'));

  const objs = w.objectives.map((o) => o.trim()).filter((o) => o.length > 0);
  step.appendChild(buildReviewListRow('Objectives', objs, '—'));

  const people = w.people
    .map(normalizeWizardPerson)
    .filter((p): p is NonNullable<ReturnType<typeof normalizeWizardPerson>> => p !== null)
    .map((p) => {
      const id = p.identity;
      if (id.name !== undefined && id.email !== undefined) return `${id.name} · ${id.email}`;
      return id.name ?? id.email ?? id.id;
    });
  step.appendChild(buildReviewListRow('People', people, 'None yet'));

  return step;
}

function buildReviewRow(label: string, value: string): HTMLElement {
  const row = wizEl('div', 'spaces-wizard-review-row');
  row.appendChild(wizEl('span', 'spaces-wizard-review-label', label));
  row.appendChild(wizEl('span', 'spaces-wizard-review-value', value));
  return row;
}

function buildReviewListRow(label: string, values: string[], emptyText: string): HTMLElement {
  const row = wizEl('div', 'spaces-wizard-review-row');
  row.appendChild(wizEl('span', 'spaces-wizard-review-label', label));
  if (values.length === 0) {
    row.appendChild(wizEl('span', 'spaces-wizard-review-value', emptyText));
  } else {
    const ul = wizEl('ul', 'spaces-wizard-review-list');
    values.forEach((v) => ul.appendChild(wizEl('li', undefined, v)));
    row.appendChild(ul);
  }
  return row;
}

function focusLast(selector: string): void {
  const nodes = document.querySelectorAll(selector);
  const last = nodes[nodes.length - 1];
  if (last instanceof HTMLElement) last.focus();
}

// ── State capture + navigation ────────────────────────────────────────────

function captureNewSpaceStep(): void {
  const w = newSpaceWizard;
  if (w === null) return;
  if (w.step === 1) {
    const name = document.getElementById('spaces-new-name-input');
    const purpose = document.getElementById('spaces-new-purpose-input');
    if (name instanceof HTMLInputElement) w.name = name.value;
    if (purpose instanceof HTMLTextAreaElement) w.purpose = purpose.value;
  } else if (w.step === 2) {
    const desc = document.getElementById('spaces-new-desc-input');
    if (desc instanceof HTMLTextAreaElement) w.description = desc.value;
    const list = document.getElementById('spaces-new-objectives');
    if (list !== null) {
      w.objectives = Array.from(list.querySelectorAll('.spaces-wizard-row-input')).map((el) =>
        el instanceof HTMLInputElement ? el.value : ''
      );
    }
  } else if (w.step === 3) {
    const list = document.getElementById('spaces-new-people');
    if (list !== null) {
      w.people = Array.from(list.querySelectorAll('.spaces-wizard-row')).map((row) => {
        const nameEl = row.querySelector('[data-person-field="name"]');
        const emailEl = row.querySelector('[data-person-field="email"]');
        return {
          name: nameEl instanceof HTMLInputElement ? nameEl.value : '',
          email: emailEl instanceof HTMLInputElement ? emailEl.value : '',
        };
      });
    }
  }
}

function handleWizardNext(): void {
  const w = newSpaceWizard;
  if (w === null) return;
  captureNewSpaceStep();
  if (w.step === 1 && w.name.trim().length === 0) {
    showWizardError('Please enter a name.');
    const name = document.getElementById('spaces-new-name-input');
    if (name instanceof HTMLInputElement) name.focus();
    return;
  }
  if (w.step < 4) {
    w.step = (w.step + 1) as NewSpaceWizardState['step'];
    renderNewSpaceWizard();
  }
}

function handleWizardBack(): void {
  const w = newSpaceWizard;
  if (w === null) return;
  captureNewSpaceStep();
  if (w.step > 1) {
    w.step = (w.step - 1) as NewSpaceWizardState['step'];
    renderNewSpaceWizard();
  }
}

function setWizardBusy(busy: boolean): void {
  if (newSpaceWizard === null) return;
  newSpaceWizard.busy = busy;
  renderNewSpaceWizard();
}

function showWizardError(message: string): void {
  const error = document.getElementById('spaces-new-error');
  if (error === null) return;
  error.textContent = message;
  error.hidden = false;
}

async function handleDraftWithAi(): Promise<void> {
  const w = newSpaceWizard;
  if (w === null) return;
  captureNewSpaceStep();
  const aiBridge = window.lite?.ai;
  if (aiBridge === undefined) {
    showWizardError('AI assist is unavailable in this build.');
    return;
  }
  const purpose = (w.description.trim().length > 0 ? w.description : w.purpose).trim();
  if (purpose.length === 0) {
    showWizardError('Add a sentence about the purpose first, then draft with AI.');
    const desc = document.getElementById('spaces-new-desc-input');
    if (desc instanceof HTMLTextAreaElement) desc.focus();
    return;
  }
  setWizardBusy(true);
  try {
    const name = w.name.trim();
    const res = await aiBridge.spaceAssist(purpose, name.length > 0 ? name : undefined);
    if (newSpaceWizard === null) return;
    newSpaceWizard.busy = false;
    if (res.ok === false) {
      renderNewSpaceWizard();
      const remediation = res.error.remediation;
      showWizardError(
        remediation !== undefined && remediation.length > 0
          ? `${res.error.message} ${remediation}`
          : res.error.message
      );
      return;
    }
    newSpaceWizard.description = res.value.description;
    newSpaceWizard.objectives = res.value.objectives.slice(0, MAX_WIZARD_OBJECTIVES);
    renderNewSpaceWizard();
  } catch (err) {
    window.logging?.error?.('spaces', 'wizard AI draft failed', { error: messageFrom(err) });
    if (newSpaceWizard !== null) {
      newSpaceWizard.busy = false;
      renderNewSpaceWizard();
    }
    showWizardError(messageFrom(err));
  }
}

async function createSpaceFromWizard(): Promise<void> {
  const w = newSpaceWizard;
  if (w === null) return;
  captureNewSpaceStep();
  const name = w.name.trim();
  if (name.length === 0) {
    w.step = 1;
    renderNewSpaceWizard();
    showWizardError('Please enter a name.');
    return;
  }
  const bridge = window.lite?.spaces;
  if (bridge === undefined) {
    showWizardError('Bridge unavailable. Reload the window.');
    return;
  }
  setWizardBusy(true);
  try {
    const description = composeSpaceDescription(
      w.description.trim().length > 0 ? w.description : w.purpose,
      w.objectives
    );
    const created = await bridge.createSpace(
      description.length > 0 ? { name, description } : { name }
    );
    if (created.ok === false) {
      setWizardBusy(false);
      showWizardError(created.error.message);
      return;
    }
    const createdId = (created.value as { id?: unknown }).id;
    const id = typeof createdId === 'string' ? createdId : null;

    // A create that "succeeded" without a usable id is the Edison
    // empty-200 shape — the write may not have landed, and every
    // follow-up (shared flip, member adds, navigation) would silently
    // no-op while the toast claimed success (2026-08-08 logging
    // review, P0). Fail loudly instead; the sidebar refresh on the
    // next open shows the truth either way.
    if (id === null) {
      setWizardBusy(false);
      window.logging?.error?.('spaces', 'wizard create returned no id', { name });
      showWizardError(
        `Creating "${name}" did not confirm. Check the sidebar after a refresh — it may or may not exist — and try again if it doesn't.`
      );
      return;
    }

    // Flip to a shared (AI-managed) space when requested. Soft-fail with
    // a trace: the space exists either way; the user can re-flip via the
    // row menu — but the toast must not claim "shared" when it isn't.
    let sharedFlipFailed = false;
    if (w.shared) {
      try {
        const flipped = await bridge.setSpaceKind(id, 'shared');
        if (flipped.ok === false) sharedFlipFailed = true;
      } catch {
        sharedFlipFailed = true;
      }
      if (sharedFlipFailed) {
        window.logging?.warn?.('spaces', 'wizard shared-flip failed', { id, name });
      }
    }

    // Add people up front. Per-person soft-fail; we report the tally.
    let peopleAdded = 0;
    let peopleFailed = 0;
    {
      for (const row of w.people) {
        const person = normalizeWizardPerson(row);
        if (person === null) continue;
        try {
          const upserted = await bridge.identity.getOrCreatePerson(person.identity);
          if (upserted.ok === false) {
            peopleFailed += 1;
            continue;
          }
          const added = await bridge.members.add(id, upserted.value.id);
          if (added.ok === false) peopleFailed += 1;
          else peopleAdded += 1;
        } catch (err) {
          window.logging?.warn?.('spaces', 'wizard member add failed', { error: messageFrom(err) });
          peopleFailed += 1;
        }
      }
    }

    const wasShared = w.shared && !sharedFlipFailed;
    closeNewSpaceDialog();
    await loadSpaces();
    let toast = wasShared ? `Created shared space "${name}"` : `Created "${name}"`;
    if (sharedFlipFailed) {
      toast += " · couldn't switch it to shared — use the row menu to retry";
    }
    if (peopleAdded > 0) {
      toast += ` · ${peopleAdded} ${peopleAdded === 1 ? 'person' : 'people'} added`;
    }
    if (peopleFailed > 0) {
      toast += ` · ${peopleFailed} couldn't be added`;
    }
    showToast(toast);
    setActiveScope(id);
  } catch (err) {
    window.logging?.error?.('spaces', 'wizard create failed', { error: messageFrom(err) });
    setWizardBusy(false);
    showWizardError(messageFrom(err));
  }
}

function showDialogError(el: HTMLElement, message: string): void {
  el.textContent = message;
  el.hidden = false;
}

// ─── Per-row ⋯ menu ─────────────────────────────────────────────────────

function wireRowMenuTriggers(): void {
  const sidebar = document.getElementById('spaces-sidebar');
  if (sidebar === null) return;
  // Delegated click handler: catches every ⋯ press across re-renders
  // without per-row listener bookkeeping. `stopPropagation` keeps the
  // existing `wireSidebarClicks` row-activation logic from firing.
  sidebar.addEventListener('click', (ev: MouseEvent) => {
    const target = ev.target;
    if (!(target instanceof HTMLElement)) return;
    if (!target.matches('[data-row-menu-trigger]')) return;
    ev.stopPropagation();
    const spaceId = target.getAttribute('data-row-menu-trigger');
    if (typeof spaceId !== 'string' || spaceId.length === 0) return;
    openRowMenu(spaceId, target as HTMLButtonElement);
  });
}

function openRowMenu(spaceId: string, triggerEl: HTMLButtonElement): void {
  const menu = document.getElementById('spaces-row-menu');
  if (menu === null) return;
  // If the menu is already open for this same trigger, treat the
  // click as a toggle and close it.
  if (rowMenuState.spaceId === spaceId && menu.hidden === false) {
    closeRowMenu();
    return;
  }
  closeRowMenu();
  rowMenuState.spaceId = spaceId;
  rowMenuState.triggerEl = triggerEl;
  triggerEl.classList.add('is-open');
  triggerEl.setAttribute('aria-expanded', 'true');
  // Phase 4 v2: flip the shared-toggle label to match the space's
  // current kind so users see "Make shared" / "Make user-managed".
  const space = state.spaces.find((s) => s.id === spaceId);
  const sharedLabel = menu.querySelector<HTMLElement>('[data-toggle-shared-label]');
  if (sharedLabel !== null) {
    sharedLabel.textContent = space?.kind === 'shared' ? 'Make user-managed' : 'Make shared';
  }
  // Position relative to the trigger, then clamp into the viewport
  // (mirrors openContextMenu) — a ⋯ on the last visible row would
  // otherwise open the fixed-position menu off the bottom edge.
  const rect = triggerEl.getBoundingClientRect();
  menu.hidden = false;
  menu.setAttribute('aria-hidden', 'false');
  const menuRect = menu.getBoundingClientRect();
  const top = Math.min(rect.bottom + 4, window.innerHeight - menuRect.height - 8);
  const left = Math.min(rect.left - 100, window.innerWidth - menuRect.width - 8);
  menu.style.top = `${Math.max(4, Math.round(top))}px`;
  menu.style.left = `${Math.max(4, Math.round(left))}px`;
}

function closeRowMenu(): void {
  const menu = document.getElementById('spaces-row-menu');
  if (rowMenuState.triggerEl !== null) {
    rowMenuState.triggerEl.classList.remove('is-open');
    rowMenuState.triggerEl.setAttribute('aria-expanded', 'false');
  }
  rowMenuState.spaceId = null;
  rowMenuState.triggerEl = null;
  if (menu !== null) {
    menu.hidden = true;
    menu.setAttribute('aria-hidden', 'true');
  }
}

function wireRowMenu(): void {
  const menu = document.getElementById('spaces-row-menu');
  if (menu === null) return;
  menu.addEventListener('click', (ev: MouseEvent) => {
    const target = ev.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.getAttribute('data-action');
    const spaceId = rowMenuState.spaceId;
    if (typeof spaceId !== 'string' || spaceId.length === 0) return;
    closeRowMenu();
    if (action === 'rename') {
      startInlineRename(spaceId);
    } else if (action === 'delete') {
      void performSoftDelete(spaceId);
    } else if (action === 'toggle-shared') {
      void toggleSpaceKind(spaceId);
    }
  });
  // Outside-click closes the menu.
  document.addEventListener('click', (ev: MouseEvent) => {
    if (rowMenuState.spaceId === null) return;
    const target = ev.target;
    if (!(target instanceof Element)) return;
    if (target.closest('#spaces-row-menu') !== null) return;
    if (target.matches('[data-row-menu-trigger]')) return;
    closeRowMenu();
  });
}

// ─── Inline rename ──────────────────────────────────────────────────────

function startInlineRename(spaceId: string): void {
  const row = document.querySelector<HTMLElement>(
    `.spaces-row-space[data-scope-id="${cssEscape(spaceId)}"]`
  );
  if (row === null) return;
  const nameEl = row.querySelector<HTMLElement>('.spaces-row-name');
  if (nameEl === null) return;
  const currentName = nameEl.textContent ?? '';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'spaces-row-rename-input';
  input.value = currentName === '(unnamed)' ? '' : currentName;
  input.maxLength = 80;
  // Clicking inside the input must not bubble up to the sidebar's
  // row-activation handler.
  input.addEventListener('click', (ev) => ev.stopPropagation());
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      void commitRename(spaceId, input.value, currentName, input);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      cancelRename(input, nameEl, currentName);
    }
  });
  input.addEventListener('blur', () => {
    // Commit on blur if the value changed; otherwise cancel.
    if (input.value.trim() !== currentName.trim() && input.value.trim().length > 0) {
      void commitRename(spaceId, input.value, currentName, input);
    } else {
      cancelRename(input, nameEl, currentName);
    }
  });
  nameEl.replaceWith(input);
  input.focus();
  input.select();
}

async function commitRename(
  spaceId: string,
  newName: string,
  oldName: string,
  inputEl: HTMLInputElement
): Promise<void> {
  const trimmed = newName.trim();
  if (trimmed.length === 0 || trimmed === oldName.trim()) {
    cancelRename(inputEl, null, oldName);
    return;
  }
  const bridge = window.lite?.spaces;
  if (bridge === undefined) {
    showToast('Bridge unavailable.');
    cancelRename(inputEl, null, oldName);
    return;
  }
  inputEl.disabled = true;
  try {
    const envelope = await bridge.renameSpace(spaceId, trimmed);
    if (envelope.ok === false) {
      showToast(envelope.error.message);
      cancelRename(inputEl, null, oldName);
      return;
    }
    await loadSpaces();
    showToast(`Renamed to "${trimmed}"`);
  } catch (err) {
    window.logging?.error?.('spaces', 'space rename failed', { error: messageFrom(err) });
    showToast(messageFrom(err));
    cancelRename(inputEl, null, oldName);
  }
}

function cancelRename(
  inputEl: HTMLInputElement,
  nameEl: HTMLElement | null,
  oldName: string
): void {
  // Restore the original <span> in place of the <input>.
  if (!inputEl.isConnected) return;
  const restored =
    nameEl ??
    (() => {
      const span = document.createElement('span');
      span.className = 'spaces-row-name';
      span.textContent = oldName.length > 0 ? oldName : '(unnamed)';
      return span;
    })();
  inputEl.replaceWith(restored);
}

/**
 * CSS.escape isn't always typed; provide a tiny fallback for the
 * single use site above.
 */
function cssEscape(s: string): string {
  if (typeof (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS?.escape === 'function') {
    return (globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS.escape(s);
  }
  return s.replace(/["\\]/g, '\\$&');
}

// ─── Toggle space kind (Phase 4 v2) ─────────────────────────────────────

async function toggleSpaceKind(spaceId: string): Promise<void> {
  const space = state.spaces.find((s) => s.id === spaceId);
  if (space === undefined) {
    showToast('Space not found.');
    return;
  }
  const bridge = window.lite?.spaces;
  if (bridge === undefined) {
    showToast('Bridge unavailable.');
    return;
  }
  const nextKind: 'user' | 'shared' = space.kind === 'shared' ? 'user' : 'shared';
  // Converting changes what the Space IS: a shared space is worked by
  // AGENTS against its current playbook and renders as a dashboard; a
  // user-managed space is a folder you curate. Nothing is deleted
  // either way, but people deserve to know which mode they're entering
  // (2026-08-18 confirm audit).
  const ok = await askToConfirm(
    nextKind === 'shared' ? 'Make this a shared space?' : 'Make this user-managed?',
    nextKind === 'shared'
      ? 'Agents work this Space against its current playbook, and it renders as a ' +
        'dashboard of tickets instead of an asset grid. Your assets stay exactly ' +
        'where they are — you can convert back at any time.'
      : 'This Space goes back to a plain asset grid that you curate by hand. ' +
        'Agents stop working it, its tickets and playbook stay in place, and you ' +
        'can convert back at any time.',
    nextKind === 'shared' ? 'Make shared' : 'Make user-managed'
  );
  if (!ok) return;
  try {
    const envelope = await bridge.setSpaceKind(spaceId, nextKind);
    if (envelope.ok === false) {
      showToast(envelope.error.message);
      return;
    }
    showToast(
      nextKind === 'shared'
        ? `"${space.name}" is now a shared space`
        : `"${space.name}" is now user-managed`
    );
    await loadSpaces();
    // If the user is currently viewing this space, re-render so the
    // dashboard layout swaps in/out immediately.
    if (state.activeScopeId === spaceId) {
      renderItemList({});
    }
  } catch (err) {
    window.logging?.error?.('spaces', 'toggleSpaceKind failed', { error: messageFrom(err) });
    showToast(messageFrom(err));
  }
}

// ─── Delete + undo toast ────────────────────────────────────────────────

async function performSoftDelete(spaceId: string): Promise<void> {
  const space = state.spaces.find((s) => s.id === spaceId);
  const displayName = space?.name && space.name.length > 0 ? space.name : 'space';
  const bridge = window.lite?.spaces;
  if (bridge === undefined) {
    showToast('Bridge unavailable.');
    return;
  }
  // Deleting used to be a single unconfirmed menu click, and it takes
  // the Space's assets out of view with it. Say exactly what happens
  // to them (nothing is destroyed; they move to Uncategorized) and
  // make the user confirm.
  const count = space?.itemCount ?? 0;
  const ok = await askToConfirm(
    `Delete "${displayName}"?`,
    count > 0
      ? `${count} ${count === 1 ? 'asset' : 'assets'} will move to Uncategorized — ` +
        `nothing is deleted, and files stay in storage. Undo restores the Space with its assets.`
      : 'The Space is empty. Undo restores it.',
    'Delete'
  );
  if (!ok) return;
  try {
    const envelope = await bridge.deleteSpace(spaceId, { soft: true });
    if (envelope.ok === false) {
      showToast(envelope.error.message);
      return;
    }
    // If we just deleted the active space, jump back to Home so the
    // main pane isn't pointed at a non-existent scope.
    if (state.activeScopeId === spaceId) {
      setActiveScope(HOME_SCOPE_ID);
    }
    await loadSpaces();
    const movedNote =
      (space?.itemCount ?? 0) > 0 ? ' · assets moved to Uncategorized' : '';
    showToast(`Deleted "${displayName}"${movedNote}`, {
      undoLabel: 'Undo',
      onUndo: () => void performUndoDelete(spaceId, displayName),
    });
  } catch (err) {
    window.logging?.error?.('spaces', 'space delete failed', { spaceId, error: messageFrom(err) });
    showToast(messageFrom(err));
  }
}

async function performUndoDelete(spaceId: string, displayName: string): Promise<void> {
  const bridge = window.lite?.spaces;
  if (bridge === undefined) return;
  try {
    const envelope = await bridge.undeleteSpace(spaceId);
    if (envelope.ok === false) {
      showToast(envelope.error.message);
      return;
    }
    await loadSpaces();
    showToast(`Restored "${displayName}"`);
  } catch (err) {
    window.logging?.error?.('spaces', 'space undelete failed', { spaceId, error: messageFrom(err) });
    showToast(messageFrom(err));
  }
}

// ─── Toast (Phase 3a) ───────────────────────────────────────────────────

interface ShowToastOpts {
  undoLabel?: string;
  onUndo?: () => void;
  /** Milliseconds before auto-hide. Default 6000. */
  durationMs?: number;
}

function showToast(message: string, opts: ShowToastOpts = {}): void {
  const toast = document.getElementById('spaces-toast');
  const messageEl = document.getElementById('spaces-toast-message');
  const action = document.getElementById('spaces-toast-action');
  if (toast === null || messageEl === null || !(action instanceof HTMLButtonElement)) return;
  // Clear any prior auto-hide timer.
  if (toastState.hideTimer !== null) {
    clearTimeout(toastState.hideTimer);
    toastState.hideTimer = null;
  }
  toastState.onUndo = opts.onUndo ?? null;
  messageEl.textContent = message;
  if (typeof opts.undoLabel === 'string' && opts.onUndo !== undefined) {
    action.textContent = opts.undoLabel;
    action.hidden = false;
  } else {
    action.hidden = true;
    action.textContent = '';
  }
  toast.classList.remove('is-leaving');
  toast.hidden = false;
  const duration = typeof opts.durationMs === 'number' && opts.durationMs > 0
    ? opts.durationMs
    : 6000;
  toastState.hideTimer = setTimeout(() => hideToast(), duration);
}

function hideToast(): void {
  const toast = document.getElementById('spaces-toast');
  if (toast === null) return;
  toast.classList.add('is-leaving');
  // Let the leaving animation play, then hard-hide.
  window.setTimeout(() => {
    toast.hidden = true;
    toast.classList.remove('is-leaving');
  }, 200);
  if (toastState.hideTimer !== null) {
    clearTimeout(toastState.hideTimer);
    toastState.hideTimer = null;
  }
  toastState.onUndo = null;
}

function wireToast(): void {
  const action = document.getElementById('spaces-toast-action');
  if (!(action instanceof HTMLButtonElement)) return;
  action.addEventListener('click', () => {
    const handler = toastState.onUndo;
    hideToast();
    if (handler !== null) handler();
  });
}

// ─── Sprint 3: items-region search ─────────────────────────────────────

function onItemsSearchChange(query: string): void {
  state.itemsSearchQuery = query;
  if (state.itemsSearchTimer !== null) {
    window.clearTimeout(state.itemsSearchTimer);
    state.itemsSearchTimer = null;
  }
  // Debounce 200ms — feels live but doesn't hammer the graph on every
  // keystroke.
  state.itemsSearchTimer = window.setTimeout(() => {
    void runItemsSearch();
  }, 200);
}

/**
 * Supersedes in-flight searches. Carried over from the global search
 * this box replaced (2026-08-08: "honest search clears") — clearing the
 * box or switching scope must not let an older response paint over the
 * result. Now the ONLY search, so the hazard is front and centre.
 */
let itemsSearchSeq = 0;

async function runItemsSearch(): Promise<void> {
  const query = state.itemsSearchQuery.trim();
  const seq = ++itemsSearchSeq;
  if (query.length === 0) {
    state.itemsSearchResults = null;
    renderItemList({});
    return;
  }
  const bridge = window.lite?.spaces;
  if (bridge === undefined) return;
  // Scope is a property of the one search box, not of where you typed.
  const scopedToSpace =
    state.itemsSearchScope === 'space' &&
    state.activeScopeId !== HOME_SCOPE_ID &&
    state.activeScopeId !== UNCATEGORIZED_SPACE_ID;
  const spaceId = scopedToSpace ? state.activeScopeId : undefined;
  try {
    const envelope = await bridge.items.search({
      query,
      ...(spaceId !== undefined ? { spaceId } : {}),
      limit: 50,
    });
    if (seq !== itemsSearchSeq) return; // superseded — never paint stale
    if (envelope.ok === false) {
      state.itemsSearchResults = [];
      renderItemList({ error: envelope.error.message });
      return;
    }
    state.itemsSearchResults = envelope.value as RendererItemSummary[];
    renderItemList({});
  } catch (err) {
    if (seq !== itemsSearchSeq) return;
    window.logging?.warn?.('spaces', 'items search failed', { error: messageFrom(err) });
    state.itemsSearchResults = [];
    renderItemList({ error: messageFrom(err) });
  }
}

// ─── Sprint 1: new-asset modal + drag-drop upload + delete action ───────

let newAssetMode: 'text' | 'upload' | 'agent' | 'knowledge' | 'existing' = 'text';
let newAssetFile: File | null = null;

/** The reachability endpoint kinds shown in the add-agent dialog. */
const AGENT_ENDPOINT_KINDS = ['mcp', 'api', 'skill'] as const;
type AgentEndpointKindUi = (typeof AGENT_ENDPOINT_KINDS)[number];

interface AgentEndpointDraft {
  kind: AgentEndpointKindUi;
  url: string;
  channels: string[];
}

/**
 * Read the MCP/API/Skill URL + channels fields from the add-agent dialog.
 * A row contributes an endpoint only when its URL is non-empty; channels
 * are a trimmed, comma-split, de-duplicated list.
 */
function collectAgentEndpoints(): AgentEndpointDraft[] {
  const out: AgentEndpointDraft[] = [];
  for (const kind of AGENT_ENDPOINT_KINDS) {
    const urlEl = document.getElementById(`spaces-new-asset-agent-${kind}-url`);
    const chEl = document.getElementById(`spaces-new-asset-agent-${kind}-channels`);
    const url = urlEl instanceof HTMLInputElement ? urlEl.value.trim() : '';
    if (url.length === 0) continue;
    const raw = chEl instanceof HTMLInputElement ? chEl.value : '';
    const channels: string[] = [];
    const seen = new Set<string>();
    for (const piece of raw.split(',')) {
      const c = piece.trim();
      if (c.length === 0) continue;
      const key = c.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      channels.push(c);
    }
    out.push({ kind, url, channels });
  }
  return out;
}

/** Blank the six add-agent reachability inputs (called on dialog reset). */
function clearAgentEndpointFields(): void {
  for (const kind of AGENT_ENDPOINT_KINDS) {
    for (const suffix of ['url', 'channels'] as const) {
      const el = document.getElementById(`spaces-new-asset-agent-${kind}-${suffix}`);
      if (el instanceof HTMLInputElement) el.value = '';
    }
  }
}

/**
 * Toggle the "Transcript detected" hint under the paste textarea.
 * Creates the hint element on first use; removes it when the text no
 * longer detects as a transcript.
 */
function updateTranscriptHint(format: string | null): void {
  const pane = document.querySelector<HTMLElement>('[data-asset-pane="text"]');
  if (pane === null) return;
  let hint = pane.querySelector<HTMLElement>('.spaces-new-asset-transcript-hint');
  if (format === null) {
    if (hint !== null) hint.remove();
    return;
  }
  if (hint === null) {
    hint = document.createElement('div');
    hint.className = 'spaces-new-asset-transcript-hint';
    pane.appendChild(hint);
  }
  hint.textContent = `❝ Transcript detected (${format}) — it will be formatted as Markdown turns on create.`;
}

function wireNewAssetDialog(): void {
  const form = document.getElementById('spaces-new-asset-form');
  const cancel = document.getElementById('spaces-new-asset-cancel');
  const close = document.getElementById('spaces-new-asset-close');
  const backdrop = document.getElementById('spaces-new-asset-backdrop');
  const tabs = document.querySelectorAll<HTMLButtonElement>('[data-asset-tab]');
  const fileInput = document.getElementById('spaces-new-asset-file-input');
  const dropzone = document.getElementById('spaces-new-asset-dropzone');

  wireShareControls();

  if (form instanceof HTMLFormElement) {
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      void submitNewAsset();
    });
  }
  if (cancel !== null) {
    cancel.addEventListener('click', () => closeNewAssetDialog());
  }
  if (close !== null) {
    close.addEventListener('click', () => closeNewAssetDialog());
  }
  if (backdrop !== null) {
    backdrop.addEventListener('click', (ev) => {
      if (ev.target === backdrop) closeNewAssetDialog();
    });
  }
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const mode = tab.getAttribute('data-asset-tab');
      if (mode !== 'text' && mode !== 'upload' && mode !== 'agent' && mode !== 'knowledge' && mode !== 'existing') return;
      switchNewAssetMode(mode);
    });
  });
  if (fileInput instanceof HTMLInputElement) {
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0] ?? null;
      handleNewAssetFileSelection(file);
    });
  }
  // Existing-assets tab: global search across every visible Space,
  // per-row Add files the asset into the current Space (multi-space).
  const existingSearch = document.getElementById('spaces-new-asset-existing-search');
  if (existingSearch instanceof HTMLInputElement) {
    let existingDebounce: number | null = null;
    existingSearch.addEventListener('input', () => {
      if (existingDebounce !== null) window.clearTimeout(existingDebounce);
      existingDebounce = window.setTimeout(() => {
        existingDebounce = null;
        void runExistingAssetSearch(existingSearch.value.trim());
      }, 250);
    });
  }

  // Agent-library picker: source toggle + debounced search.
  document.querySelectorAll<HTMLElement>('[data-agent-source]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-agent-source');
      if (mode === 'library' || mode === 'okf') switchAgentSourceMode(mode);
    });
  });
  const agentSearch = document.getElementById('spaces-new-asset-agent-search');
  if (agentSearch instanceof HTMLInputElement) {
    agentSearch.addEventListener('input', () => {
      if (agentLibrarySearchTimer !== null) window.clearTimeout(agentLibrarySearchTimer);
      agentLibrarySearchTimer = window.setTimeout(() => {
        agentLibrarySearchTimer = null;
        void runAgentLibrarySearch(agentSearch.value.trim());
      }, 250);
    });
  }

  // Live transcript hint on the paste tab: when the pasted text looks
  // like a transcript, tell the user it will be formatted (debounced —
  // detection scans every line).
  const contentInput = document.getElementById('spaces-new-asset-content-input');
  if (contentInput instanceof HTMLTextAreaElement) {
    let hintTimer: number | null = null;
    contentInput.addEventListener('input', () => {
      if (hintTimer !== null) window.clearTimeout(hintTimer);
      hintTimer = window.setTimeout(() => {
        hintTimer = null;
        const format = detectTranscriptFormat(contentInput.value);
        updateTranscriptHint(format);
      }, 250);
    });
  }
  // Dropzone drag-drop (modal-scoped — separate from the items-region
  // dropzone which opens the modal in the first place).
  if (dropzone !== null) {
    dropzone.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      dropzone.classList.add('is-drag-target');
    });
    dropzone.addEventListener('dragleave', () => {
      dropzone.classList.remove('is-drag-target');
    });
    dropzone.addEventListener('drop', (ev) => {
      ev.preventDefault();
      dropzone.classList.remove('is-drag-target');
      const file = ev.dataTransfer?.files?.[0] ?? null;
      handleNewAssetFileSelection(file);
    });
  }
  // Esc closes when open.
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    const bd = document.getElementById('spaces-new-asset-backdrop');
    if (bd !== null && bd.hidden === false) {
      closeNewAssetDialog();
    }
  });
}

// ─── Sharing status (read side) ──────────────────────────────────────
//
// A file being public is invisible unless we SAY so. These read the
// stamps `create-binary.ts` writes (`metadata.fileIsPublic` /
// `metadata.fileExpiresAt`) so the state a user chose at upload stays
// visible afterwards, on the tile and in the detail pane.

/** True when the asset's bytes live in the public bucket. */
export function itemIsPublic(item: { metadata?: Record<string, unknown> } | null): boolean {
  return item?.metadata?.['fileIsPublic'] === true;
}

/** The asset's expiry as an ISO string, or null when it never expires. */
export function itemExpiresAt(item: { metadata?: Record<string, unknown> } | null): string | null {
  const raw = item?.metadata?.['fileExpiresAt'];
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : raw;
}

/**
 * Compact relative expiry, e.g. "expires in 3h". Past expiries read as
 * "expired" rather than a negative duration -- the bucket may not have
 * collected it yet, and "expires in -2h" is nonsense to a reader.
 */
export function formatExpiry(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const ms = at - now;
  if (ms <= 0) return 'expired';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `expires in ${Math.max(1, mins)}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `expires in ${hours}h`;
  return `expires in ${Math.round(hours / 24)}d`;
}

/** True when an expiry is close enough to warrant the urgent styling. */
export function expiresSoon(iso: string, now: number = Date.now()): boolean {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return false;
  return at - now <= 24 * 60 * 60 * 1000;
}

/** Small pills for a tile: public and/or expiring. */
export function buildSharingBadges(item: {
  metadata?: Record<string, unknown>;
}): DocumentFragment | null {
  const isPublic = itemIsPublic(item);
  const expiry = itemExpiresAt(item);
  if (!isPublic && expiry === null) return null;
  const frag = document.createDocumentFragment();
  if (isPublic) {
    const pill = document.createElement('span');
    pill.className = 'spaces-public-badge';
    pill.textContent = 'Public';
    pill.title = 'Anyone with the link can open this file';
    frag.appendChild(pill);
  }
  if (expiry !== null) {
    const pill = document.createElement('span');
    pill.className = `spaces-expiry-badge${expiresSoon(expiry) ? ' is-soon' : ''}`;
    pill.textContent = formatExpiry(expiry);
    pill.title = `Automatically deleted at ${expiry}`;
    frag.appendChild(pill);
  }
  return frag;
}

/**
 * Reconcile our stamp against the bucket's authoritative TTL.
 *
 * `metadata.fileExpiresAt` records only what LITE asked for at upload.
 * The bucket is the thing that actually deletes, and it reports its
 * schedule on every read — so where the two disagree, the bucket wins
 * and the difference is worth saying out loud rather than papering
 * over. An expiry we never stamped means something outside this app
 * scheduled the file for deletion, which is precisely the shape of a
 * file disappearing with no explanation.
 */
export function reconcileExpiry(
  stamped: string | null,
  bucket: string | null
): { effective: string | null; note: string | null } {
  if (bucket === null && stamped === null) return { effective: null, note: null };
  if (bucket === null) {
    // We believe there is a TTL; the bucket says there isn't. The file
    // will outlive what the UI promised.
    return {
      effective: null,
      note: 'No expiry is actually set on the file — it will not auto-delete.',
    };
  }
  if (stamped === null) {
    return {
      effective: bucket,
      note: 'This expiry was set outside Onereach.ai Lite.',
    };
  }
  const same = Math.abs(Date.parse(bucket) - Date.parse(stamped)) < 60_000;
  return {
    effective: bucket,
    note: same ? null : 'The file’s actual expiry differs from what was requested.',
  };
}

/**
 * Ask the bucket for the real schedule and correct the badge in place.
 * Soft: on any failure the stamped value stands.
 */
async function refreshExpiryFromBucket(
  item: RendererItem,
  host: HTMLElement
): Promise<void> {
  const bridge = window.lite?.spaces;
  const key = typeof item.fileKey === 'string' ? item.fileKey : '';
  if (bridge === undefined || key.length === 0) return;
  if (typeof bridge.items.getFileExpiry !== 'function') return;
  try {
    const envelope = await bridge.items.getFileExpiry(key);
    if (envelope.ok === false || envelope.value === null) return;
    const { effective, note } = reconcileExpiry(
      itemExpiresAt(item as { metadata?: Record<string, unknown> }),
      envelope.value.expiresAt
    );
    const badge = host.querySelector('.spaces-expiry-badge');
    if (effective === null) {
      badge?.remove();
    } else if (badge !== null) {
      badge.textContent = formatExpiry(effective);
      badge.classList.toggle('is-soon', expiresSoon(effective));
      (badge as HTMLElement).title = `Automatically deleted at ${effective}`;
    }
    if (note !== null) {
      const existing = host.querySelector('.spaces-share-note');
      if (existing === null) {
        const el = document.createElement('span');
        el.className = 'spaces-share-sub spaces-share-note';
        el.textContent = note;
        host.appendChild(el);
      }
    }
  } catch {
    // The stamped value stands — this only ever enriches the badge.
  }
}

/** Detail-pane sharing summary. Null when there is nothing to say. */
function buildSharingStatus(item: { metadata?: Record<string, unknown> }): HTMLElement | null {
  const badges = buildSharingBadges(item);
  if (badges === null) return null;
  const wrap = document.createElement('div');
  wrap.className = 'spaces-share spaces-share-status';
  if (itemIsPublic(item)) wrap.classList.add('is-public');
  const row = document.createElement('div');
  row.className = 'spaces-share-row';
  const copy = document.createElement('div');
  copy.className = 'spaces-share-copy';
  const title = document.createElement('span');
  title.className = 'spaces-share-title';
  title.textContent = 'Sharing';
  const sub = document.createElement('span');
  sub.className = 'spaces-share-sub';
  sub.textContent = itemIsPublic(item)
    ? 'Anyone with the link can open this file.'
    : 'Only people in this account can open it.';
  copy.append(title, sub);
  const pills = document.createElement('div');
  pills.className = 'spaces-share-pills';
  pills.appendChild(badges);
  row.append(copy, pills);
  wrap.appendChild(row);
  return wrap;
}

// ─── Sharing controls (visibility + auto-delete) ─────────────────────
//
// Private is the default and the UI SAYS SO in words, rather than
// leaving the user to infer it from an unchecked box. Turning a file
// public is the deliberate act, so that is where the consequence
// ("anyone with the link") is spelled out.

/**
 * Confirmation copy after a create.
 *
 * States the consequence rather than the setting: "anyone with the
 * link" beats "isPublic: true". A private upload with no expiry gets
 * the plain message — no ceremony for the default case.
 */
export function buildCreatedToast(
  title: string,
  isPublic: boolean,
  expiresAt: string | undefined,
  now: number = Date.now()
): string {
  const parts: string[] = [];
  if (isPublic) parts.push('public — anyone with the link can open it');
  if (expiresAt !== undefined) parts.push(formatExpiry(expiresAt, now));
  return parts.length === 0 ? `Created "${title}"` : `Created "${title}" · ${parts.join(' · ')}`;
}

/** Expiry presets, in the order they appear. Value '' means never. */
const EXPIRY_PRESETS: ReadonlyArray<{ value: string; ms: number; label: string }> = [
  { value: '1h', ms: 60 * 60 * 1000, label: 'in 1 hour' },
  { value: '24h', ms: 24 * 60 * 60 * 1000, label: 'in 24 hours' },
  { value: '7d', ms: 7 * 24 * 60 * 60 * 1000, label: 'in 7 days' },
  { value: '30d', ms: 30 * 24 * 60 * 60 * 1000, label: 'in 30 days' },
];

/**
 * Resolve a preset to an absolute ISO timestamp.
 *
 * Absolute, not relative: the value is computed when the user submits,
 * so a dialog left open for an hour still means "24h from upload", and
 * the main process receives an unambiguous instant rather than a
 * duration it would have to interpret.
 */
export function expiryPresetToIso(value: string, now: number = Date.now()): string | undefined {
  const preset = EXPIRY_PRESETS.find((p) => p.value === value);
  if (preset === undefined) return undefined;
  return new Date(now + preset.ms).toISOString();
}

/** Human label for a preset, used in the sub-line. */
export function expiryPresetLabel(value: string): string {
  const preset = EXPIRY_PRESETS.find((p) => p.value === value);
  return preset === undefined ? 'Kept until you delete it.' : `Deleted automatically ${preset.label}.`;
}

/** Reflect the visibility switch into copy, colour, and the warning. */
function renderShareState(isPublic: boolean): void {
  const wrap = document.querySelector('.spaces-share');
  const title = document.getElementById('spaces-share-title');
  const sub = document.getElementById('spaces-share-sub');
  const warn = document.getElementById('spaces-share-warn');
  const toggle = document.getElementById('spaces-new-asset-public');
  if (wrap instanceof HTMLElement) wrap.classList.toggle('is-public', isPublic);
  if (title !== null) title.textContent = isPublic ? 'Public' : 'Private';
  if (sub !== null) {
    sub.textContent = isPublic
      ? 'Anyone with the link can open it.'
      : 'Only people in this account can open it.';
  }
  if (warn !== null) warn.hidden = !isPublic;
  if (toggle !== null) toggle.setAttribute('aria-checked', isPublic ? 'true' : 'false');
}

/** True when the user has switched this upload to public. */
function isNewAssetPublic(): boolean {
  const toggle = document.getElementById('spaces-new-asset-public');
  return toggle !== null && toggle.getAttribute('aria-checked') === 'true';
}

/** The chosen expiry as an absolute ISO string, or undefined for never. */
function newAssetExpiryIso(): string | undefined {
  const select = document.getElementById('spaces-new-asset-expiry');
  if (!(select instanceof HTMLSelectElement)) return undefined;
  return expiryPresetToIso(select.value);
}

/**
 * Put the sharing controls back to the safe defaults.
 *
 * Called on EVERY dialog open. The new-asset dialog is reused, so
 * without this a "public" choice from one upload silently carries into
 * the next — publishing a file the user never meant to share.
 */
export function resetShareControls(): void {
  renderShareState(false);
  const select = document.getElementById('spaces-new-asset-expiry');
  if (select instanceof HTMLSelectElement) select.value = '';
  const sub = document.getElementById('spaces-expiry-sub');
  if (sub !== null) sub.textContent = expiryPresetLabel('');
}

function wireShareControls(): void {
  const toggle = document.getElementById('spaces-new-asset-public');
  if (toggle !== null) {
    toggle.addEventListener('click', () => {
      renderShareState(!isNewAssetPublic());
    });
    // role="switch" must respond to Space/Enter like a native control.
    toggle.addEventListener('keydown', (ev) => {
      if (ev.key !== ' ' && ev.key !== 'Enter') return;
      ev.preventDefault();
      renderShareState(!isNewAssetPublic());
    });
  }
  const select = document.getElementById('spaces-new-asset-expiry');
  if (select instanceof HTMLSelectElement) {
    select.addEventListener('change', () => {
      const sub = document.getElementById('spaces-expiry-sub');
      if (sub !== null) sub.textContent = expiryPresetLabel(select.value);
    });
  }
}

function handleNewAssetFileSelection(file: File | null): void {
  newAssetFile = file;
  const chip = document.getElementById('spaces-new-asset-file-hint');
  if (chip !== null) {
    if (file !== null) {
      chip.hidden = false;
      chip.innerHTML = '';
      const name = document.createElement('span');
      name.className = 'spaces-new-asset-file-chip-name';
      name.textContent = file.name;
      const meta = document.createElement('span');
      meta.className = 'spaces-new-asset-file-chip-meta';
      meta.textContent = `${formatBytes(file.size)}${file.type.length > 0 ? ` · ${file.type}` : ''}`;
      chip.appendChild(name);
      chip.appendChild(meta);
    } else {
      chip.hidden = true;
      chip.replaceChildren();
    }
  }
  // Auto-fill the title with the filename if empty.
  const titleInput = document.getElementById('spaces-new-asset-title-input');
  if (
    file !== null &&
    titleInput instanceof HTMLInputElement &&
    titleInput.value.trim().length === 0
  ) {
    titleInput.value = file.name;
  }
}

function switchNewAssetMode(mode: 'text' | 'upload' | 'agent' | 'knowledge' | 'existing'): void {
  newAssetMode = mode;
  document.querySelectorAll<HTMLElement>('[data-asset-tab]').forEach((tab) => {
    const isActive = tab.getAttribute('data-asset-tab') === mode;
    tab.classList.toggle('is-active', isActive);
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  document.querySelectorAll<HTMLElement>('[data-asset-pane]').forEach((pane) => {
    pane.hidden = pane.getAttribute('data-asset-pane') !== mode;
  });
  // First visit to the Agent tab primes the library with the
  // alphabetical head so the picker never opens empty.
  if (mode === 'agent' && !agentLibraryLoadedOnce) {
    agentLibraryLoadedOnce = true;
    void runAgentLibrarySearch('');
  }
  // The Existing tab adds per-row (no Create step) — the submit button
  // is meaningless there, so disable it for the duration.
  const submit = document.getElementById('spaces-new-asset-submit');
  if (submit instanceof HTMLButtonElement) submit.disabled = mode === 'existing';
  if (mode === 'existing') {
    const search = document.getElementById('spaces-new-asset-existing-search');
    if (search instanceof HTMLInputElement && search.value.trim().length === 0) {
      const results = document.getElementById('spaces-new-asset-existing-results');
      results?.replaceChildren(
        buildAgentLibraryStatus('Type to search assets across every Space you can see.')
      );
    }
  }
}

// ─── Agent library picker ───────────────────────────────────────────────

type AgentSourceMode = 'library' | 'okf';
let agentSourceMode: AgentSourceMode = 'library';
let agentLibrarySelection: { id: string; name: string } | null = null;
let agentLibraryLoadedOnce = false;
let agentLibrarySearchTimer: number | null = null;
let agentLibrarySearchSeq = 0;

function switchAgentSourceMode(mode: AgentSourceMode): void {
  agentSourceMode = mode;
  document
    .querySelectorAll<HTMLElement>('[data-agent-source]')
    .forEach((btn) => {
      const active = btn.getAttribute('data-agent-source') === mode;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', String(active));
    });
  document
    .querySelectorAll<HTMLElement>('[data-agent-source-pane]')
    .forEach((pane) => {
      pane.hidden = pane.getAttribute('data-agent-source-pane') !== mode;
    });
}

async function runAgentLibrarySearch(q: string): Promise<void> {
  const results = document.getElementById('spaces-new-asset-agent-results');
  const bridge = window.lite?.spaces;
  if (results === null || bridge === undefined) return;
  const seq = ++agentLibrarySearchSeq;
  results.replaceChildren(buildAgentLibraryStatus('Searching the library…'));
  try {
    const envelope = await bridge.items.agentLibrarySearch(q, 25);
    if (seq !== agentLibrarySearchSeq) return; // superseded (slow prime vs typed query)
    if (envelope.ok === false) {
      results.replaceChildren(buildAgentLibraryStatus(envelope.error.message));
      return;
    }
    // A selection pointing outside the new result set would be
    // invisible yet still drive Create — drop it.
    if (
      agentLibrarySelection !== null &&
      !envelope.value.some((e) => e.id === agentLibrarySelection?.id)
    ) {
      agentLibrarySelection = null;
    }
    renderAgentLibraryResults(results, envelope.value);
  } catch (err) {
    if (seq !== agentLibrarySearchSeq) return;
    window.logging?.warn?.('spaces', 'agent library search failed', { error: messageFrom(err) });
    results.replaceChildren(buildAgentLibraryStatus(messageFrom(err)));
  }
}

function buildAgentLibraryStatus(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'spaces-agent-results-status';
  el.textContent = text;
  return el;
}

function renderAgentLibraryResults(
  container: HTMLElement,
  entries: Array<{ id: string; name: string; description: string; agentType: string }>
): void {
  container.replaceChildren();
  if (entries.length === 0) {
    container.appendChild(buildAgentLibraryStatus('No agents matched.'));
    return;
  }
  for (const entry of entries) {
    container.appendChild(buildAgentLibraryRow(entry));
  }
}

/** One selectable library row: name + type badge + description snippet. */
export function buildAgentLibraryRow(entry: {
  id: string;
  name: string;
  description: string;
  agentType: string;
}): HTMLElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'spaces-agent-result';
  row.setAttribute('role', 'option');
  row.setAttribute('data-agent-id', entry.id);
  if (agentLibrarySelection?.id === entry.id) row.classList.add('is-selected');

  const top = document.createElement('span');
  top.className = 'spaces-agent-result-top';
  const name = document.createElement('span');
  name.className = 'spaces-agent-result-name';
  name.textContent = entry.name;
  top.appendChild(name);
  const type = document.createElement('span');
  type.className = 'spaces-agent-result-type';
  type.textContent = entry.agentType;
  top.appendChild(type);
  row.appendChild(top);

  if (entry.description.trim().length > 0) {
    const desc = document.createElement('span');
    desc.className = 'spaces-agent-result-desc';
    desc.textContent = entry.description;
    row.appendChild(desc);
  }

  row.addEventListener('click', () => {
    agentLibrarySelection = { id: entry.id, name: entry.name };
    const container = row.parentElement;
    container
      ?.querySelectorAll('.spaces-agent-result.is-selected')
      .forEach((el) => el.classList.remove('is-selected'));
    row.classList.add('is-selected');
  });
  return row;
}

// ─── Existing-asset picker (the "Existing" tab) ─────────────────────────

let existingSearchSeq = 0;

async function runExistingAssetSearch(q: string): Promise<void> {
  const results = document.getElementById('spaces-new-asset-existing-results');
  const bridge = window.lite?.spaces;
  if (results === null || bridge === undefined) return;
  if (q.length === 0) {
    results.replaceChildren(
      buildAgentLibraryStatus('Type to search assets across every Space you can see.')
    );
    return;
  }
  const seq = ++existingSearchSeq;
  results.replaceChildren(buildAgentLibraryStatus('Searching all Spaces…'));
  try {
    const envelope = await bridge.items.search({ query: q, limit: 25 });
    if (seq !== existingSearchSeq) return; // superseded
    if (envelope.ok === false) {
      results.replaceChildren(buildAgentLibraryStatus(envelope.error.message));
      return;
    }
    const rows = envelope.value as RendererItemSummary[];
    const currentSpaceId =
      state.activeScopeId !== HOME_SCOPE_ID &&
      state.activeScopeId !== UNCATEGORIZED_SPACE_ID
        ? state.activeScopeId
        : '';
    results.replaceChildren();
    for (const row of rows) {
      results.appendChild(buildExistingAssetRow(row, currentSpaceId));
    }
    if (results.childElementCount === 0) {
      results.appendChild(buildAgentLibraryStatus('No assets matched.'));
    }
  } catch (err) {
    if (seq !== existingSearchSeq) return;
    window.logging?.warn?.('spaces', 'existing-asset search failed', { error: messageFrom(err) });
    results.replaceChildren(buildAgentLibraryStatus(messageFrom(err)));
  }
}

/**
 * One search result in the Existing tab: kind + title + where it
 * lives, with an Add button that files it into the current Space
 * (multi-space — the asset stays everywhere it already is). Exported
 * for tests.
 */
export function buildExistingAssetRow(
  item: RendererItemSummary,
  currentSpaceId: string
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'spaces-existing-row';
  row.setAttribute('data-item-id', item.id);

  const main = document.createElement('div');
  main.className = 'spaces-existing-row-main';
  const top = document.createElement('span');
  top.className = 'spaces-agent-result-top';
  const name = document.createElement('span');
  name.className = 'spaces-agent-result-name';
  name.textContent = generateItemTitle(item);
  top.appendChild(name);
  const kind = document.createElement('span');
  kind.className = 'spaces-agent-result-type';
  kind.textContent = kindLabel(item.kind);
  top.appendChild(kind);
  main.appendChild(top);
  const inSpaces = item.otherSpaces.map((s) => friendlySpaceName(s.name)).join(', ');
  if (inSpaces.length > 0) {
    const sub = document.createElement('span');
    sub.className = 'spaces-agent-result-desc';
    sub.textContent = `In: ${inSpaces}`;
    main.appendChild(sub);
  }
  row.appendChild(main);

  const alreadyHere =
    currentSpaceId !== '' && item.otherSpaces.some((s) => s.id === currentSpaceId);
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'spaces-existing-row-add';
  add.textContent = alreadyHere ? 'Added ✓' : '+ Add';
  add.disabled = alreadyHere || currentSpaceId === '';
  if (currentSpaceId === '') add.title = 'Open a Space first';
  add.addEventListener('click', () => {
    add.disabled = true;
    add.textContent = 'Adding…';
    const bridge = window.lite?.spaces;
    if (bridge === undefined) return;
    void bridge.items
      .addToSpace(item.id, currentSpaceId)
      .then(async (envelope) => {
        if (envelope.ok === false) {
          showToast(envelope.error.message);
          add.disabled = false;
          add.textContent = '+ Add';
          return;
        }
        add.textContent = 'Added ✓';
        showToast(`Added "${generateItemTitle(item)}" to this Space`);
        await loadItems();
      })
      .catch((err) => {
        window.logging?.error?.('spaces', 'add existing asset failed', { error: messageFrom(err) });
        showToast(messageFrom(err));
        add.disabled = false;
        add.textContent = '+ Add';
      });
  });
  row.appendChild(add);
  return row;
}

function resetAgentLibraryPicker(): void {
  agentLibrarySelection = null;
  const search = document.getElementById('spaces-new-asset-agent-search');
  if (search instanceof HTMLInputElement) search.value = '';
  const results = document.getElementById('spaces-new-asset-agent-results');
  if (results !== null) {
    results
      .querySelectorAll('.spaces-agent-result.is-selected')
      .forEach((el) => el.classList.remove('is-selected'));
  }
  switchAgentSourceMode('library');
}

function openNewAssetDialog(presetFile: File | null = null): void {
  const backdrop = document.getElementById('spaces-new-asset-backdrop');
  const titleInput = document.getElementById('spaces-new-asset-title-input');
  const contentInput = document.getElementById('spaces-new-asset-content-input');
  const fileInput = document.getElementById('spaces-new-asset-file-input');
  const error = document.getElementById('spaces-new-asset-error');
  if (backdrop === null || !(titleInput instanceof HTMLInputElement)) return;

  backdrop.hidden = false;
  backdrop.setAttribute('aria-hidden', 'false');
  titleInput.value = '';
  if (contentInput instanceof HTMLTextAreaElement) contentInput.value = '';
  if (fileInput instanceof HTMLInputElement) fileInput.value = '';
  const agentInput = document.getElementById('spaces-new-asset-agent-input');
  if (agentInput instanceof HTMLTextAreaElement) agentInput.value = '';
  clearAgentEndpointFields();
  resetAgentLibraryPicker();
  const knowledgeInput = document.getElementById('spaces-new-asset-knowledge-input');
  if (knowledgeInput instanceof HTMLTextAreaElement) knowledgeInput.value = '';
  const knowledgeEndpoint = document.getElementById('spaces-new-asset-knowledge-endpoint');
  if (knowledgeEndpoint instanceof HTMLInputElement) knowledgeEndpoint.value = '';
  const existingSearch = document.getElementById('spaces-new-asset-existing-search');
  if (existingSearch instanceof HTMLInputElement) existingSearch.value = '';
  document.getElementById('spaces-new-asset-existing-results')?.replaceChildren();
  updateTranscriptHint(null);
  // Sharing goes back to private + no expiry on EVERY open. Carrying a
  // previous "public" choice into the next upload is how a file gets
  // published by accident.
  resetShareControls();
  // Reset the file chip (and clear stashed file).
  handleNewAssetFileSelection(null);
  if (error !== null) {
    error.hidden = true;
    error.textContent = '';
  }
  // If a file was preset (via items-region drag-drop), switch to upload
  // mode and seed the chip + title.
  if (presetFile !== null) {
    handleNewAssetFileSelection(presetFile);
    switchNewAssetMode('upload');
  } else {
    switchNewAssetMode('text');
  }
  requestAnimationFrame(() => titleInput.focus());
}

function closeNewAssetDialog(): void {
  const backdrop = document.getElementById('spaces-new-asset-backdrop');
  if (backdrop === null) return;
  backdrop.hidden = true;
  backdrop.setAttribute('aria-hidden', 'true');
  newAssetFile = null;
}

async function submitNewAsset(): Promise<void> {
  // The Existing tab adds assets per-row; there is nothing to submit.
  if (newAssetMode === 'existing') return;
  const titleInput = document.getElementById('spaces-new-asset-title-input');
  const contentInput = document.getElementById('spaces-new-asset-content-input');
  const error = document.getElementById('spaces-new-asset-error');
  const submit = document.getElementById('spaces-new-asset-submit');
  if (!(titleInput instanceof HTMLInputElement) || error === null) return;
  const title = titleInput.value.trim();
  // Agents may omit the title — the AI suggests a name during conversion.
  if (title.length === 0 && newAssetMode !== 'agent') {
    showDialogError(error, 'Please enter a title.');
    return;
  }
  const bridge = window.lite?.spaces;
  if (bridge === undefined) {
    showDialogError(error, 'Bridge unavailable. Reload the window.');
    return;
  }
  if (submit instanceof HTMLButtonElement) submit.disabled = true;

  // Resolve the target space — the active scope, unless it's Home, in
  // which case we drop the asset into Uncategorized intake.
  const spaceId =
    state.activeScopeId === HOME_SCOPE_ID ||
    state.activeScopeId === UNCATEGORIZED_SPACE_ID
      ? ''
      : state.activeScopeId;

  // Captured on success so we can fire background Claude enrichment after
  // the dialog closes (auto-on-create). `null` until a create succeeds.
  let createdEnrich:
    | { id: string; kind: string; mimeType?: string; hasContent: boolean }
    | null = null;

  try {
    const creatorId = readCurrentEditorId();
    const creatorName = readCurrentEditorName();
    if (newAssetMode === 'agent') {
      // Agents must live in a real Space (not Home / Uncategorized).
      if (spaceId === '') {
        showDialogError(error, 'Open a Space first, then add the agent.');
        if (submit instanceof HTMLButtonElement) submit.disabled = false;
        return;
      }
      // Library mode: reference the selected graph :Agent directly — no
      // AI conversion; endpoints from the reachability inputs attach to
      // the existing agent.
      if (agentSourceMode === 'library') {
        if (agentLibrarySelection === null) {
          showDialogError(error, 'Pick an agent from the library first.');
          if (submit instanceof HTMLButtonElement) submit.disabled = false;
          return;
        }
        const endpoints = collectAgentEndpoints();
        const envelope = await bridge.items.createAgentFromLibrary({
          spaceId,
          agentId: agentLibrarySelection.id,
          ...(endpoints.length > 0 ? { endpoints } : {}),
          ...(creatorId !== null ? { creatorId } : {}),
          ...(creatorName !== null ? { creatorName } : {}),
        });
        if (envelope.ok === false) {
          showDialogError(error, envelope.error.message);
          if (submit instanceof HTMLButtonElement) submit.disabled = false;
          return;
        }
        const pickedName = agentLibrarySelection.name;
        const libraryAgentId = envelope.value.id;
        closeNewAssetDialog();
        showToast(`Added agent "${pickedName}" from the library`);
        await loadItems();
        // Agents were the ONE create path that never enriched: both
        // agent sub-paths return early, before the shared
        // autoEnrichOnCreate call at the end of this function (audit
        // 2026-08-17: agent 0/1 had ai_*, while knowledge/journey/
        // document/upload/paste all did). An agent's OKF body is
        // exactly what a "what does this agent do?" summary should be
        // built from, so enrich it like any other content asset.
        void autoEnrichOnCreate(libraryAgentId, { kind: 'agent', hasContent: true });
        return;
      }
      const agentInput = document.getElementById('spaces-new-asset-agent-input');
      const source =
        agentInput instanceof HTMLTextAreaElement ? agentInput.value.trim() : '';
      if (source.length === 0) {
        showDialogError(error, 'Paste an OKF URL or the agent definition text.');
        if (submit instanceof HTMLButtonElement) submit.disabled = false;
        return;
      }
      const ai = window.lite?.ai;
      if (ai === undefined || typeof ai.convertToOkf !== 'function') {
        showDialogError(error, 'AI is not available. Add an Anthropic key in Settings → AI.');
        if (submit instanceof HTMLButtonElement) submit.disabled = false;
        return;
      }
      const isUrl = /^https?:\/\//i.test(source);
      const originalLabel =
        submit instanceof HTMLButtonElement ? submit.textContent : null;
      if (submit instanceof HTMLButtonElement) submit.textContent = 'Converting…';
      const converted = await ai.convertToOkf(source, isUrl);
      if (submit instanceof HTMLButtonElement && originalLabel !== null) {
        submit.textContent = originalLabel;
      }
      if (converted.ok === false) {
        showDialogError(error, converted.error.message);
        if (submit instanceof HTMLButtonElement) submit.disabled = false;
        return;
      }
      const okf = converted.value;
      const agentName =
        title.length > 0 ? title : okf.name.length > 0 ? okf.name : 'Agent';
      const endpoints = collectAgentEndpoints();
      const envelope = await bridge.items.createAgent({
        spaceId,
        name: agentName,
        okf: okf.okf,
        agentType: okf.agentType,
        ...(endpoints.length > 0 ? { endpoints } : {}),
        ...(isUrl ? { sourceUrl: source } : {}),
        ...(creatorId !== null ? { creatorId } : {}),
          ...(creatorName !== null ? { creatorName } : {}),
      });
      if (envelope.ok === false) {
        showDialogError(error, envelope.error.message);
        if (submit instanceof HTMLButtonElement) submit.disabled = false;
        return;
      }
      const createdAgentId = envelope.value.id;
      closeNewAssetDialog();
      showToast(`Added agent "${agentName}"`);
      await loadItems();
      // Same as the library path above — the OKF text is the content
      // Claude should summarize.
      void autoEnrichOnCreate(createdAgentId, { kind: 'agent', hasContent: true });
      return;
    }
    if (newAssetMode === 'knowledge') {
      const knowledgeInput = document.getElementById('spaces-new-asset-knowledge-input');
      const endpointInput = document.getElementById('spaces-new-asset-knowledge-endpoint');
      const body =
        knowledgeInput instanceof HTMLTextAreaElement ? knowledgeInput.value.trim() : '';
      if (body.length === 0) {
        showDialogError(error, "Describe what the model knows — that's the asset.");
        if (submit instanceof HTMLButtonElement) submit.disabled = false;
        return;
      }
      const endpoint =
        endpointInput instanceof HTMLInputElement ? endpointInput.value.trim() : '';
      const envelope = await bridge.items.create({
        spaceId,
        title,
        kind: 'knowledge',
        content: body,
        mimeType: 'text/markdown',
        metadata: {
          ...(endpoint.length > 0 ? { knowledge_endpoint: endpoint } : {}),
        },
        ...(creatorId !== null ? { creatorId } : {}),
          ...(creatorName !== null ? { creatorName } : {}),
      });
      if (envelope.ok === false) {
        showDialogError(error, envelope.error.message);
        if (submit instanceof HTMLButtonElement) submit.disabled = false;
        return;
      }
      createdEnrich = {
        id: envelope.value.id,
        kind: 'knowledge',
        mimeType: 'text/markdown',
        hasContent: true,
      };
    } else if (newAssetMode === 'upload' && newAssetFile !== null) {
      const file = newAssetFile;
      // Auto-extract metadata before upload — image dimensions, audio/
      // video duration, PDF page count, CSV row/col, etc. Best-effort
      // (returns {} on failure). See lite/spaces/metadata-extractor.ts.
      const metadata = await extractMetadataFromFile(file);

      // Text-like files (markdown, code, CSV, plain text) up to 512 KB
      // become inline graph `content` instead of GSX binaries: the
      // platform stores text in the graph, and the detail pane's
      // Markdown/code renderer + "✎ Edit" affordance work immediately.
      // Larger or non-text files take the GSX path below (ADR-050).
      if (shouldInlineTextFile(file.name, file.type, file.size)) {
        const text = await file.text();
        // Transcript intake: .vtt/.srt exports and speaker-labeled
        // text convert to consistent Markdown and land as kind
        // 'transcript'. Gated to dialogue-plausible EXTENSIONS —
        // YAML/JSON/code files with repeated `key: value` lines can
        // false-positive the speaker-line detector, and conversion
        // rewrites content irreversibly (the paste path keeps its
        // live hint as the consent surface).
        const transcriptEligible = /\.(vtt|srt|txt|text|md|markdown)$/i.test(file.name);
        const transcript = transcriptEligible ? convertTranscript(text) : null;
        const content = transcript !== null ? transcript.markdown : text;
        const kind = transcript !== null ? 'transcript' : 'document';
        const mimeType =
          transcript !== null ? 'text/markdown' : file.type !== '' ? file.type : '';
        const meta: Record<string, unknown> = {
          ...(metadata as Record<string, unknown>),
          ...(transcript !== null
            ? {
                transcript_format: transcript.format,
                transcript_turns: transcript.turnCount,
                ...(transcript.speakers.length > 0
                  ? { transcript_speakers: transcript.speakers }
                  : {}),
              }
            : {}),
        };
        const envelope = await bridge.items.create({
          spaceId,
          title,
          kind,
          content,
          ...(mimeType !== '' ? { mimeType } : {}),
          metadata: meta,
          ...(creatorId !== null ? { creatorId } : {}),
          ...(creatorName !== null ? { creatorName } : {}),
        });
        if (envelope.ok === false) {
          showDialogError(error, envelope.error.message);
          if (submit instanceof HTMLButtonElement) submit.disabled = false;
          return;
        }
        if (transcript !== null) {
          showToast(
            `Transcript formatted — ${transcript.turnCount} turns${
              transcript.speakers.length > 0
                ? `, ${transcript.speakers.length} speakers`
                : ''
            }`
          );
        }
        createdEnrich = {
          id: envelope.value.id,
          kind,
          ...(mimeType !== '' ? { mimeType } : {}),
          hasContent: content.trim().length > 0,
        };
      } else {
      // GSX-first (ADR-050): raw bytes cross the bridge; the main
      // process uploads them to the account's GSX bucket and stores
      // only the fileKey on the graph node. This is what makes the
      // asset readable from every app on the account.
      const bytes = await file.arrayBuffer();
      const kind = inferKindFromMime(file.type) as
        | 'image'
        | 'video'
        | 'audio'
        | 'document'
        | 'other';
      // Sharing choices. Both are opt-in; omitted entirely when the
      // user left the defaults alone, so a private upload sends no
      // visibility flag at all and cannot be misread downstream.
      const isPublic = isNewAssetPublic();
      const expiresAt = newAssetExpiryIso();
      const envelope = await bridge.items.createBinary({
        spaceId,
        title,
        kind,
        fileName: file.name,
        mimeType: file.type,
        bytes,
        metadata: metadata as Record<string, unknown>,
        ...(creatorId !== null ? { creatorId } : {}),
          ...(creatorName !== null ? { creatorName } : {}),
        ...(isPublic ? { isPublic: true } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      });
      if (envelope.ok === false) {
        showDialogError(error, envelope.error.message);
        if (submit instanceof HTMLButtonElement) submit.disabled = false;
        return;
      }
      // hasContent: false — binary payload lives in GSX, not inline;
      // image/PDF enrich eligibility is driven by kind + mimeType and
      // the enricher downloads via the fileKey.
      createdEnrich = { id: envelope.value.id, kind, mimeType: file.type, hasContent: false };
      }
    } else {
      const raw =
        contentInput instanceof HTMLTextAreaElement ? contentInput.value : '';
      // Transcript intake (paste path): detected transcripts convert
      // to Markdown turns and land as kind 'transcript'.
      const transcript = convertTranscript(raw);
      const content = transcript !== null ? transcript.markdown : raw;
      const kind = transcript !== null ? 'transcript' : 'text';
      // Auto-extract metadata for text-mode (paste) as well — word
      // count, line count, CSV/JSON shape if the title hints at it.
      const language = detectTextPreviewLanguage(undefined, title);
      const meta: Record<string, unknown> = {
        ...(extractMetadataFromText(content, {
          ...(language !== null ? { language } : {}),
        }) as Record<string, unknown>),
        ...(transcript !== null
          ? {
              transcript_format: transcript.format,
              transcript_turns: transcript.turnCount,
              ...(transcript.speakers.length > 0
                ? { transcript_speakers: transcript.speakers }
                : {}),
            }
          : {}),
      };
      const envelope = await bridge.items.create({
        spaceId,
        title,
        kind,
        content,
        ...(transcript !== null ? { mimeType: 'text/markdown' } : {}),
        metadata: meta,
        ...(creatorId !== null ? { creatorId } : {}),
          ...(creatorName !== null ? { creatorName } : {}),
      });
      if (envelope.ok === false) {
        showDialogError(error, envelope.error.message);
        if (submit instanceof HTMLButtonElement) submit.disabled = false;
        return;
      }
      if (transcript !== null) {
        showToast(
          `Transcript formatted — ${transcript.turnCount} turns${
            transcript.speakers.length > 0
              ? `, ${transcript.speakers.length} speakers`
              : ''
          }`
        );
      }
      createdEnrich = {
        id: envelope.value.id,
        kind,
        hasContent: content.trim().length > 0,
      };
    }
    // Capture the sharing choices BEFORE the dialog resets them, so the
    // confirmation can restate what was actually done. Publishing a
    // file is worth confirming in words -- a bare "Created" leaves the
    // user with no signal that the thing is now world-readable.
    const sharedPublicly = newAssetMode === 'upload' && isNewAssetPublic();
    const sharedExpiry = newAssetMode === 'upload' ? newAssetExpiryIso() : undefined;
    closeNewAssetDialog();
    showToast(buildCreatedToast(title, sharedPublicly, sharedExpiry));
    await loadItems();
    // Fire Claude enrichment in the background (no await) so the create
    // flow stays snappy. Silent when AI isn't configured.
    if (createdEnrich !== null) {
      const enrich = createdEnrich;
      void autoEnrichOnCreate(enrich.id, {
        kind: enrich.kind,
        ...(enrich.mimeType !== undefined ? { mimeType: enrich.mimeType } : {}),
        hasContent: enrich.hasContent,
      });
    }
  } catch (err) {
    window.logging?.error?.('spaces', 'new asset submit failed', { error: messageFrom(err) });
    showDialogError(error, messageFrom(err));
  } finally {
    if (submit instanceof HTMLButtonElement) submit.disabled = false;
  }
}

function inferKindFromMime(mime: string): string {
  if (typeof mime !== 'string' || mime.length === 0) return 'other';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf' || mime.startsWith('text/')) return 'document';
  return 'other';
}

/**
 * Drag-and-drop upload: dropping files onto the items region opens
 * the new-asset modal pre-populated with the first dropped file.
 * Multi-file drop is supported but only the first file is loaded —
 * batch upload is a future enhancement.
 */
function wireDragDropAssetUpload(): void {
  const region = document.getElementById('spaces-items-region');
  if (region === null) return;
  let dragDepth = 0;
  region.addEventListener('dragenter', (ev) => {
    ev.preventDefault();
    dragDepth += 1;
    region.classList.add('is-drag-target');
  });
  region.addEventListener('dragleave', () => {
    dragDepth -= 1;
    if (dragDepth <= 0) {
      dragDepth = 0;
      region.classList.remove('is-drag-target');
    }
  });
  region.addEventListener('dragover', (ev) => {
    ev.preventDefault();
  });
  region.addEventListener('drop', (ev) => {
    ev.preventDefault();
    dragDepth = 0;
    region.classList.remove('is-drag-target');
    const file = ev.dataTransfer?.files?.[0] ?? null;
    if (file === null) return;
    openNewAssetDialog(file);
  });
}

/**
 * Sprint 1 — soft-delete an asset with an undo toast. Mirrors the
 * existing space-soft-delete UX so the user gets a 6s window to
 * recover from accidental deletes.
 */
async function performAssetSoftDelete(itemId: string, title: string): Promise<void> {
  const bridge = window.lite?.spaces;
  if (bridge === undefined) {
    showToast('Bridge unavailable.');
    return;
  }
  try {
    const envelope = await bridge.items.delete(itemId, { soft: true });
    if (envelope.ok === false) {
      showToast(envelope.error.message);
      return;
    }
    // Close the detail rail if this item was open.
    if (state.activeItemId === itemId) {
      state.activeItemId = null;
      showDetailRail(false);
    }
    await loadItems();
    showToast(`Deleted "${title}"`, {
      undoLabel: 'Undo',
      onUndo: () => {
        void performAssetRestore(itemId, title);
      },
    });
  } catch (err) {
    window.logging?.error?.('spaces', 'asset delete failed', { itemId, error: messageFrom(err) });
    showToast(messageFrom(err));
  }
}

async function performAssetRestore(itemId: string, title: string): Promise<void> {
  const bridge = window.lite?.spaces;
  if (bridge === undefined) return;
  try {
    const envelope = await bridge.items.restore(itemId);
    if (envelope.ok === false) {
      showToast(envelope.error.message);
      return;
    }
    await loadItems();
    showToast(`Restored "${title}"`);
  } catch (err) {
    window.logging?.error?.('spaces', 'asset restore failed', { itemId, error: messageFrom(err) });
    showToast(messageFrom(err));
  }
}

// ─── Boot ───────────────────────────────────────────────────────────────
//
// Shared crash surface (`lite/renderer-boot.ts`): fatal-error banner +
// window error/unhandledrejection listeners. First successful paint is
// marked in `loadSpaces()` after the first space-list render -- past
// that point, uncaught errors reach the central log via console.error
// but never blank a working app.

let markSpacesBootSucceeded: () => void = () => undefined;

bootRenderer({
  scope: 'spaces',
  title: 'Spaces failed to load',
  init: (ctx) => {
    markSpacesBootSucceeded = ctx.markBootSucceeded;
    attachServicePulse();
    // ADR-072 — Planning → New Journey Map… opens the composer here.
    window.lite?.spaces?.journeys?.onNewJourney?.(() => {
      void openJourneyComposer();
    });
    return init();
  },
});
