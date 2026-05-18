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
import type {
  DiscoveryQueryResult,
  DiscoveryResults,
} from './discovery-format.js';

// ─── Home view (chunk 3o) ───────────────────────────────────────────────

/**
 * Synthetic id for the Home scope. Distinguished from
 * `UNCATEGORIZED_SPACE_ID` so the scope discriminator can branch
 * cleanly. Used as `data-scope-id` on the sidebar Home row.
 */
const HOME_SCOPE_ID = '__home__';

/** Cache window for Home SDK responses. Per Q-Home-3 default (60s). */
const HOME_CACHE_TTL_MS = 60_000;

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
    }
  >;
  /** Polling timer handle for the active scope (Tier 3c). */
  pollTimer: number | null;
  /** Sprint 3 — current items-search query (debounced, then filters list). */
  itemsSearchQuery: string;
  /** Debounce timer for itemsSearchQuery. */
  itemsSearchTimer: number | null;
  /** Sprint 3 — last fetched search results (when query is non-empty). */
  itemsSearchResults: RendererItemSummary[] | null;
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
  sortMode: 'name',
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
  itemsSearchTimer: null,
  itemsSearchResults: null,
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

function markVisitNow(): void {
  try {
    localStorage.setItem(STORAGE_LAST_VISIT_KEY, String(Date.now()));
  } catch {
    // best-effort
  }
}

// ─── Bootstrap ──────────────────────────────────────────────────────────

function init(): void {
  applyActiveRow(state.activeScopeId);
  wireSidebarClicks();
  wireSidebarSearch();
  wireSidebarSort();
  wireMutationsUI();
  // Home is the default scope -- show its region, hide the items
  // region. This ensures first paint matches state even if
  // `setActiveScope` never runs.
  applyScopeRegions(state.activeScopeId);
  void initialLoad();
}

async function initialLoad(): Promise<void> {
  // Sidebar always loads (Spaces list + Uncategorized count); Home
  // and items load based on the active scope. Home is the default.
  // Identity prefetch (Phase 4 v2) runs in parallel — its failure is
  // soft: the renderer still works without a stashed Person id, just
  // with anonymous attribution.
  const sidebarWork: Array<Promise<void>> = [
    loadSpaces(),
    loadUncategorizedCount(),
    loadCurrentUser(),
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
async function loadCurrentUser(): Promise<void> {
  const w = window as unknown as {
    lite?: {
      auth?: {
        getSession(env: string): Promise<{ session: { accountId: string; email?: string } | null }>;
      };
      spaces?: {
        identity?: {
          getOrCreatePerson(input: {
            id: string;
            name?: string;
            email?: string;
          }): Promise<{ ok: true; value: { id: string; name: string; email?: string } } | { ok: false }>;
        };
      };
    };
  };
  const auth = w.lite?.auth;
  const identity = w.lite?.spaces?.identity;
  if (auth === undefined || identity === undefined) return;
  try {
    // Lite ships only the 'edison' environment in v1; if more land we
    // can read the active env from settings.
    const res = await auth.getSession('edison');
    const session = res.session;
    if (session === null) return;
    const email = typeof session.email === 'string' ? session.email.trim().toLowerCase() : '';
    const id = email.length > 0 ? email : session.accountId;
    const name = personNameFromEmail(email) ?? session.accountId;
    const upsertPayload: { id: string; name: string; email?: string } = {
      id,
      name,
    };
    if (email.length > 0) upsertPayload.email = email;
    const envelope = await identity.getOrCreatePerson(upsertPayload);
    if (envelope.ok === false) return;
    state.currentUser = {
      id: envelope.value.id,
      name: envelope.value.name.length > 0 ? envelope.value.name : name,
      ...(envelope.value.email !== undefined ? { email: envelope.value.email } : {}),
    };
  } catch {
    // Soft failure: keep currentUser null and proceed.
  }
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
  } catch (err) {
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
  } catch {
    renderUncategorizedCount(null);
  }
}

// ─── Sidebar search + sort (Phase 1f) ──────────────────────────────────

function wireSidebarSearch(): void {
  const input = document.getElementById('spaces-sidebar-search-input');
  if (!(input instanceof HTMLInputElement)) return;
  input.addEventListener('input', () => {
    state.searchQuery = input.value;
    applySidebarFilter();
  });
}

function wireSidebarSort(): void {
  const select = document.getElementById('spaces-sidebar-sort-select');
  if (!(select instanceof HTMLSelectElement)) return;
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
  }
}

async function loadItems(): Promise<void> {
  state.loadingItems = true;
  state.items = [];
  renderItemList({ loading: true });
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
    if (envelope.ok === false) {
      state.loadingItems = false;
      renderItemList({ error: envelope.error.message });
      return;
    }
    state.items = envelope.value.filter(isWellFormedItem);
    state.loadingItems = false;
    renderItemList({});
  } catch (err) {
    state.loadingItems = false;
    renderItemList({ error: messageFrom(err) });
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
    renderItemList({});
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
    state.spaceEvents.error = messageFrom(err);
  } finally {
    state.spaceEvents.loading = false;
    // Bail if the user switched scope mid-flight.
    if (state.spaceEventsForScopeId === spaceId) renderItemList({});
  }
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
    // Phase 3c: per-asset activity log. Loads in the background and
    // populates the activity slot. Failures degrade silently — the
    // user still sees the asset; we don't surface a banner for a
    // missing-or-failing activity stream.
    void loadItemActivity(itemId);
  } catch (err) {
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
  } catch {
    // Soft failure: activity slot stays empty.
  }
}


async function resolveAndInjectFileUrl(
  itemId: string,
  item: RendererItem
): Promise<void> {
  const bridge = window.lite?.spaces;
  if (bridge === undefined) return;
  if (typeof item.fileKey !== 'string' || item.fileKey.length === 0) return;
  try {
    const envelope = await bridge.items.resolveFileUrl(item.fileKey);
    // Bail if the user switched items mid-flight.
    if (state.activeItemId !== itemId) return;
    if (envelope.ok === false) return;
    const url = envelope.value;
    if (typeof url !== 'string' || url.length === 0) return;
    injectBinaryPreview(item, url);
  } catch {
    // Soft failure: no preview, no banner. The item is still readable.
  }
}

/**
 * Render an image preview (`kind=image`) or a binary download link
 * (any other kind with a fileKey) into the active detail pane. Called
 * after the URL resolves; idempotent if the user re-opens the same
 * item, since each render rebuilds the pane.
 */
function injectBinaryPreview(item: RendererItem, url: string): void {
  const pane = document.querySelector<HTMLElement>(
    '#spaces-detail .spaces-detail-pane'
  );
  if (pane === null) return;
  // Drop any existing preview block so re-resolutions don't stack.
  const existing = pane.querySelector('.spaces-detail-preview');
  if (existing !== null) existing.remove();
  pane.appendChild(buildBinaryPreview(item, url));
}

/**
 * Build an inline preview for a binary asset. Dispatches on
 * `item.kind` and `item.mimeType` so audio/video get players, PDFs
 * embed, and unknown binaries fall back to a download link.
 *
 * Sprint 2: extended from image-only to a kind/MIME-aware dispatch.
 */
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
    img.src = url;
    img.alt = item.title.length > 0 ? item.title : 'Item preview';
    img.loading = 'lazy';
    img.className = 'spaces-detail-image';
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

  // ── PDF inline embed ────────────────────────────────────────────────
  if (mime === 'application/pdf') {
    const embed = document.createElement('embed');
    embed.src = url;
    embed.type = 'application/pdf';
    embed.className = 'spaces-detail-pdf';
    wrap.appendChild(embed);
    appendDownloadLink(wrap, url, 'Download PDF');
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
  applyScopeRegions(scopeId);
  // Switching scope clears the open detail rail.
  state.activeItemId = null;
  showDetailRail(false);
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

// ─── Sidebar rendering ──────────────────────────────────────────────────

function renderSpaceList(): void {
  const list = document.getElementById('spaces-list-spaces');
  if (list === null) return;
  list.replaceChildren();
  if (state.spaces.length === 0) {
    const hint = document.createElement('li');
    hint.className = 'spaces-empty-hint';
    hint.id = 'spaces-empty-hint';
    hint.textContent = 'No Spaces yet.';
    list.appendChild(hint);
    return;
  }
  // Sort BEFORE row construction so the DOM order matches state.
  // Uncategorized is its own pinned row in a separate list and isn't
  // touched by the sort.
  const ordered = sortSpaces(state.spaces, state.sortMode);
  for (const space of ordered) {
    list.appendChild(buildSpaceRow(space, space.id === state.activeScopeId));
  }
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
      const ta = parseTimestamp(a.updatedAt ?? a.createdAt);
      const tb = parseTimestamp(b.updatedAt ?? b.createdAt);
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
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function renderSpaceListError(message: string): void {
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

  const dot = document.createElement('span');
  dot.className = 'spaces-row-dot';
  if (typeof space.color === 'string' && space.color.length > 0) {
    dot.style.background = space.color;
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
  // "24h" preference survives a scope switch.
  wrap.appendChild(buildFilterChips());

  // Build the timeline rows from items + (scope-matching) events.
  // For Uncategorized, the events array is empty by design.
  const events =
    state.spaceEventsForScopeId === state.activeScopeId &&
    state.spaceEvents.value !== null
      ? state.spaceEvents.value
      : [];
  const merged = mergeTimeline(events, state.items);
  const filtered = filterTimeline(merged, state.homeFilter, Date.now());

  if (opts.loading === true && state.items.length === 0) {
    wrap.appendChild(buildTimelineSkeleton(6));
    return;
  }

  if (filtered.length === 0) {
    wrap.appendChild(buildEmptyItemsState(state.activeScopeId));
    return;
  }

  const list = document.createElement('div');
  list.className = 'home-timeline-list';
  list.setAttribute('aria-label', 'Activity timeline');
  for (const row of filtered) {
    list.appendChild(buildTimelineRow(row));
  }
  wrap.appendChild(list);

  // End-of-feed cue when nothing is filtered out.
  if (filtered.length >= 5 && filtered.length === merged.length) {
    const tail = document.createElement('div');
    tail.className = 'home-timeline-tail';
    tail.textContent = 'You are all caught up.';
    wrap.appendChild(tail);
  }
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
  wrap.appendChild(buildSharedMembersRow(space, cached?.members ?? []));

  // Dashboard body — playbook block + tickets section.
  const body = document.createElement('div');
  body.className = 'spaces-shared-dashboard';
  body.setAttribute('data-space-id', space.id);

  // Playbook section
  body.appendChild(buildSharedDashboardPlaybook(space, cached?.playbook ?? null));

  // Tickets section
  body.appendChild(
    buildSharedDashboardTickets(space, cached?.tickets ?? [], busy && cached === undefined)
  );

  wrap.appendChild(body);

  // Fire-and-forget refresh.
  void loadSharedSpaceDashboard(space.id);
}

function buildSharedMembersRow(
  space: RendererSpace,
  members: ReadonlyArray<LiteSpacesMemberView>
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'spaces-shared-members';
  const label = document.createElement('span');
  label.className = 'spaces-shared-members-label';
  label.textContent = 'Members';
  row.appendChild(label);
  if (members.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'spaces-shared-members-empty';
    empty.textContent = 'No members yet';
    row.appendChild(empty);
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

function buildMemberChip(spaceId: string, member: LiteSpacesMemberView): HTMLElement {
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
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'spaces-shared-member-chip-remove';
  remove.textContent = '×';
  remove.setAttribute('aria-label', `Remove ${member.name}`);
  remove.addEventListener('click', () => {
    void removeMember(spaceId, member.id);
  });
  chip.appendChild(remove);
  return chip;
}

function buildSharedDashboardPlaybook(
  space: RendererSpace,
  playbook: RendererItem | null
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'spaces-shared-section spaces-shared-section-playbook';

  const heading = document.createElement('h3');
  heading.className = 'spaces-shared-section-heading';
  heading.textContent = 'Playbook';
  section.appendChild(heading);

  if (playbook === null) {
    const empty = document.createElement('div');
    empty.className = 'spaces-shared-playbook-empty';
    const msg = document.createElement('p');
    msg.textContent =
      'No playbook set. Add a plan to this space and promote it to playbook.';
    empty.appendChild(msg);
    section.appendChild(empty);
    return section;
  }

  // Playbook card: title (click to open detail) + excerpt + footnote.
  const card = document.createElement('article');
  card.className = 'spaces-shared-playbook-card';
  card.setAttribute('data-item-id', playbook.id);
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');
  card.addEventListener('click', () => void loadItemDetail(playbook.id));
  card.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      void loadItemDetail(playbook.id);
    }
  });

  const title = document.createElement('h4');
  title.className = 'spaces-shared-playbook-card-title';
  title.textContent = playbook.title.length > 0 ? playbook.title : '(untitled)';
  card.appendChild(title);

  if (typeof playbook.excerpt === 'string' && playbook.excerpt.length > 0) {
    const excerpt = document.createElement('p');
    excerpt.className = 'spaces-shared-playbook-card-excerpt';
    excerpt.textContent = playbook.excerpt;
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
  loading: boolean
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

  if (loading && tickets.length === 0) {
    const placeholder = document.createElement('div');
    placeholder.className = 'spaces-shared-tickets-loading';
    placeholder.textContent = 'Loading tickets…';
    section.appendChild(placeholder);
    return section;
  }

  if (tickets.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'spaces-shared-tickets-empty';
    empty.textContent = 'No tickets yet. Click "+ Ticket" to create one.';
    section.appendChild(empty);
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
  title.textContent = ticket.title.length > 0 ? ticket.title : '(untitled)';
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

/** Loader for the shared-space dashboard cache. */
async function loadSharedSpaceDashboard(spaceId: string): Promise<void> {
  const bridge = window.lite?.spaces;
  if (bridge === undefined) return;
  try {
    const [playbookRes, ticketsRes, membersRes] = await Promise.all([
      bridge.playbooks.current(spaceId),
      bridge.tickets.list(spaceId),
      bridge.members.list(spaceId),
    ]);
    if (state.activeScopeId !== spaceId) return; // user navigated away

    const playbook =
      playbookRes.ok === true && playbookRes.value !== null
        ? (playbookRes.value as RendererItem)
        : null;
    const tickets =
      ticketsRes.ok === true ? (ticketsRes.value as RendererItem[]) : [];
    const members =
      membersRes.ok === true
        ? (membersRes.value as LiteSpacesMemberView[])
        : [];
    state.sharedDashboards.set(spaceId, {
      playbook,
      tickets,
      members,
      fetchedAt: Date.now(),
    });
    // Re-render only if we're still viewing this scope.
    if (state.activeScopeId === spaceId) {
      renderItemList({});
    }
  } catch {
    // Soft fail. The dashboard renders with empty caches; user can refresh.
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
    showToast(messageFrom(err));
  }
}

/** Simple prompt-based "+ Ticket" UI. */
async function openCreateTicketPrompt(spaceId: string): Promise<void> {
  const title = window.prompt('Ticket title?');
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
    showToast(messageFrom(err));
  }
}

async function openAddMemberPrompt(spaceId: string): Promise<void> {
  const id = window.prompt('Add member by id (email for a Person, agent id for an Agent)');
  if (id === null) return;
  const trimmed = id.trim().toLowerCase();
  if (trimmed.length === 0) return;
  const bridge = window.lite?.spaces;
  if (bridge === undefined) return;
  try {
    // First, ensure a :Person exists for an email-shaped id. Agents
    // are assumed to exist via the upstream agent registry.
    if (trimmed.includes('@')) {
      await bridge.identity.getOrCreatePerson({ id: trimmed, email: trimmed });
    }
    const envelope = await bridge.members.add(spaceId, trimmed);
    if (envelope.ok === false) {
      showToast(envelope.error.message);
      return;
    }
    showToast(`Added ${envelope.value.name || trimmed}`);
    await loadSharedSpaceDashboard(spaceId);
  } catch (err) {
    showToast(messageFrom(err));
  }
}

async function removeMember(spaceId: string, memberId: string): Promise<void> {
  const bridge = window.lite?.spaces;
  if (bridge === undefined) return;
  try {
    const envelope = await bridge.members.remove(spaceId, memberId);
    if (envelope.ok === false) {
      showToast(envelope.error.message);
      return;
    }
    showToast('Member removed');
    await loadSharedSpaceDashboard(spaceId);
  } catch (err) {
    showToast(messageFrom(err));
  }
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

  // Optional description (real Spaces only — Uncategorized has a
  // fixed one-liner below the title).
  if (state.activeScopeId === UNCATEGORIZED_SPACE_ID) {
    const sub = document.createElement('p');
    sub.className = 'spaces-view-header-sub';
    sub.textContent = 'Items that arrive without a Space land here for triage.';
    titleWrap.appendChild(sub);
  } else {
    const space = state.spaces.find((s) => s.id === state.activeScopeId);
    if (
      space !== undefined &&
      typeof space.description === 'string' &&
      space.description.length > 0
    ) {
      const sub = document.createElement('p');
      sub.className = 'spaces-view-header-sub';
      sub.textContent = space.description;
      titleWrap.appendChild(sub);
    }
  }

  header.appendChild(titleWrap);

  // Sprint 3: items-scoped search input. Available everywhere except
  // Home (Home has its own discovery affordances).
  if (state.activeScopeId !== HOME_SCOPE_ID) {
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'spaces-items-search';
    search.id = 'spaces-items-search-input';
    search.placeholder = 'Search this space…';
    search.setAttribute('aria-label', 'Search assets in this space');
    search.value = state.itemsSearchQuery;
    search.addEventListener('input', () => {
      onItemsSearchChange(search.value);
    });
    header.appendChild(search);
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
    header.appendChild(newBtn);
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
  header.appendChild(refresh);

  return header;
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

// `wireCardClicks` removed when the per-Space view switched from the
// card grid to the timeline (timeline rows wire their own clicks via
// `buildTimelineRow`). `applyActiveCard` survives because the close-
// detail-rail path still calls it through the legacy ID-grid
// selector — harmless and idempotent.

function applyActiveCard(grid: HTMLElement, itemId: string | null): void {
  for (const card of Array.from(grid.querySelectorAll<HTMLElement>('.spaces-card'))) {
    const id = card.getAttribute('data-item-id');
    card.classList.toggle('is-active', id === itemId && itemId !== null);
  }
}

export function buildItemCard(
  item: RendererItemSummary,
  active: boolean
): HTMLElement {
  const card = document.createElement('article');
  card.className = 'spaces-card';
  if (active) card.classList.add('is-active');
  card.setAttribute('data-item-id', item.id);
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');

  const head = document.createElement('div');
  head.className = 'spaces-card-head';

  const kind = document.createElement('span');
  kind.className = `spaces-card-kind spaces-card-kind-${item.kind}`;
  kind.textContent = kindLabel(item.kind);
  head.appendChild(kind);

  const time = document.createElement('span');
  time.className = 'spaces-card-time';
  time.textContent = formatRelativeTime(item.updatedAt);
  head.appendChild(time);

  card.appendChild(head);

  const title = document.createElement('h3');
  title.className = 'spaces-card-title';
  title.textContent = item.title.length > 0 ? item.title : '(untitled)';
  card.appendChild(title);

  if (typeof item.excerpt === 'string' && item.excerpt.length > 0) {
    const excerpt = document.createElement('p');
    excerpt.className = 'spaces-card-excerpt';
    excerpt.textContent = item.excerpt;
    card.appendChild(excerpt);
  }

  if (item.otherSpaces.length > 0) {
    const chipRow = document.createElement('div');
    chipRow.className = 'spaces-card-chips';
    for (const chip of item.otherSpaces) {
      chipRow.appendChild(buildSpaceChip(chip));
    }
    card.appendChild(chipRow);
  }

  if (item.producedBy !== null) {
    const provenance = document.createElement('div');
    provenance.className = 'spaces-card-provenance';
    provenance.textContent = `Produced by ${item.producedBy.name} (${item.producedBy.kind})`;
    card.appendChild(provenance);
  }

  return card;
}

export function buildSpaceChip(chip: RendererSpaceChipRef): HTMLElement {
  const el = document.createElement('span');
  el.className = 'spaces-chip';
  el.setAttribute('data-chip-id', chip.id);

  const dot = document.createElement('span');
  dot.className = 'spaces-chip-dot';
  if (typeof chip.color === 'string' && chip.color.length > 0) {
    dot.style.background = chip.color;
  }
  el.appendChild(dot);

  const label = document.createElement('span');
  label.className = 'spaces-chip-name';
  label.textContent = chip.name.length > 0 ? chip.name : '(unnamed)';
  el.appendChild(label);

  return el;
}

function buildEmptyItemsState(scopeId: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'spaces-empty-items';
  const title = document.createElement('h2');
  title.className = 'spaces-empty-items-title';
  title.textContent =
    scopeId === UNCATEGORIZED_SPACE_ID
      ? 'Nothing waiting for triage'
      : 'No items in this Space yet';
  wrap.appendChild(title);
  const body = document.createElement('p');
  body.className = 'spaces-empty-items-body';
  body.textContent =
    scopeId === UNCATEGORIZED_SPACE_ID
      ? 'Items that arrive without being filed land here. When an agent drops new output into the graph, you will see it appear in this list.'
      : 'Items added to this Space will show up here.';
  wrap.appendChild(body);
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
  };
  aside.appendChild(buildDetailPane(item, onClose, 'rendered', editCallbacks));

  // Phase 4 v2: "Set as playbook" affordance. Show when:
  //  - The active scope is a shared space
  //  - The item isn't already a playbook (no point re-promoting)
  //  - The item is textual content (document / text / playbook itself
  //    after a demotion path; we keep the check loose so promoting
  //    any asset works — the SDK rewrites `a.type`)
  const activeSpace = state.spaces.find((s) => s.id === state.activeScopeId);
  if (activeSpace?.kind === 'shared' && item.kind !== 'playbook') {
    aside.appendChild(buildSetAsPlaybookAffordance(activeSpace.id, item.id));
  }

  // Sprint 3: Move + Add-to-another-space affordances. Only shown
  // outside Home (Home view doesn't have a meaningful "current space").
  if (state.activeScopeId !== HOME_SCOPE_ID) {
    const currentSpaceId =
      state.activeScopeId !== UNCATEGORIZED_SPACE_ID ? state.activeScopeId : null;
    aside.appendChild(buildMoveToSpaceAffordance(item, currentSpaceId));
    aside.appendChild(buildAddToSpaceAffordance(item));
  }

  // Sprint 1: Delete affordance at the bottom of the detail pane.
  aside.appendChild(buildAssetDeleteAffordance(item.id, item.title));
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
    showToast(messageFrom(err));
    select.disabled = false;
  }
}

/**
 * Sprint 3 — "Add to another space" picker. Mirrors `moveTo` but
 * MERGEs an additional edge without dropping the existing one.
 * Multi-space membership.
 */
function buildAddToSpaceAffordance(item: RendererItem): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'spaces-detail-add-to-space-wrap';
  const label = document.createElement('span');
  label.className = 'spaces-detail-label';
  label.textContent = 'Add to space';
  wrap.appendChild(label);

  const select = document.createElement('select');
  select.className = 'spaces-detail-add-to-space-select';
  select.setAttribute('aria-label', 'Add to another space');
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Pick another space…';
  placeholder.selected = true;
  select.appendChild(placeholder);
  const alreadyIn = new Set<string>(item.otherSpaces.map((s) => s.id));
  if (state.activeScopeId !== HOME_SCOPE_ID && state.activeScopeId !== UNCATEGORIZED_SPACE_ID) {
    alreadyIn.add(state.activeScopeId);
  }
  for (const space of state.spaces) {
    if (alreadyIn.has(space.id)) continue;
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
    void performAddToSpace(item.id, toSpaceId, select);
  });
  wrap.appendChild(select);
  return wrap;
}

async function performAddToSpace(
  itemId: string,
  toSpaceId: string,
  select: HTMLSelectElement
): Promise<void> {
  const bridge = window.lite?.spaces;
  if (bridge === undefined) return;
  try {
    const envelope = await bridge.items.addToSpace(itemId, toSpaceId);
    if (envelope.ok === false) {
      showToast(envelope.error.message);
      select.disabled = false;
      return;
    }
    const space = state.spaces.find((s) => s.id === toSpaceId);
    showToast(`Added to ${space?.name ?? toSpaceId}`);
    await loadItemDetail(itemId);
  } catch (err) {
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
function buildSetAsPlaybookAffordance(spaceId: string, itemId: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'spaces-detail-set-playbook-wrap';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'spaces-detail-set-playbook';
  btn.textContent = 'Set as playbook';
  btn.title = 'Promote this asset to be the current playbook for this space';
  btn.addEventListener('click', () => {
    void promoteToPlaybook(spaceId, itemId, btn);
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
    btn.textContent = 'Set as playbook';
    btn.disabled = false;
    showToast(messageFrom(err));
  }
}

interface RendererDetailEditCallbacks {
  onTitleSave: (next: string) => Promise<void>;
  onTypeChange: (next: string) => Promise<void>;
  onTagAdd: (tag: string) => Promise<void>;
  onTagRemove: (tag: string) => Promise<void>;
}

/**
 * Commit an item update through the bridge. After a successful
 * write the renderer re-fetches the item so the detail pane reflects
 * the new server state. Errors surface as a thrown promise so the
 * editable widget can rollback.
 */
async function commitItemUpdate(
  itemId: string,
  patch: { title?: string; description?: string; type?: string }
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
 * Best-effort `:Person.id` for the current editor. Reads from the
 * prefetched `state.currentUser` (populated on boot by
 * `loadCurrentUser()`). Returns null when not yet resolved or signed
 * out — the SDK then falls into the "anonymous edit" path.
 */
function readCurrentEditorId(): string | null {
  return state.currentUser?.id ?? null;
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
}

const EDITABLE_ITEM_KINDS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'document', label: 'Doc' },
  { id: 'image', label: 'Image' },
  { id: 'url', label: 'URL' },
  { id: 'text', label: 'Text' },
  { id: 'audio', label: 'Audio' },
  { id: 'video', label: 'Video' },
  { id: 'other', label: 'Other' },
];

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
    mime.textContent = item.mimeType;
    header.appendChild(mime);
  }

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'spaces-detail-close';
  closeBtn.setAttribute('aria-label', 'Close detail');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => onClose());
  header.appendChild(closeBtn);

  wrap.appendChild(header);

  // ── Title (click-to-edit when callback is present) ───────────────────
  if (edit?.onTitleSave !== undefined) {
    wrap.appendChild(buildEditableTitle(item.title, edit.onTitleSave));
  } else {
    const title = document.createElement('h2');
    title.className = 'spaces-detail-title';
    title.textContent = item.title.length > 0 ? item.title : '(untitled)';
    wrap.appendChild(title);
  }

  // ── Attribution chip (Phase 3c): prominent "Created by …" /
  //    "Last edited by …" near the title. Skipped silently when there's
  //    no meaningful attribution data on the item.
  const chip = buildAttributionChip(item);
  if (chip !== null) wrap.appendChild(chip);

  // ── Meta strip: time + size + producer + last-edited-by ──────────────
  wrap.appendChild(buildDetailMeta(item));

  // ── Space chips ──────────────────────────────────────────────────────
  if (item.otherSpaces.length > 0) {
    const chips = document.createElement('div');
    chips.className = 'spaces-detail-chips';
    for (const chip of item.otherSpaces) {
      chips.appendChild(buildSpaceChip(chip));
    }
    wrap.appendChild(chips);
  }

  // ── Tag chips (with × buttons + "+ Add tag" when editable) ───────────
  const tagsRow = buildDetailTags(item.tags ?? [], edit);
  if (tagsRow.children.length > 0) wrap.appendChild(tagsRow);

  // ── Content body — Sprint 2: kind-aware preview dispatch ────────────
  if (typeof item.content === 'string' && item.content.length > 0) {
    const language = detectTextPreviewLanguage(item.mimeType, item.title);
    if (language === 'csv' || language === 'tsv') {
      wrap.appendChild(buildCsvPreview(item.content));
    } else if (language !== null && language !== 'markdown') {
      // Code-like content: render as syntax-highlighted block.
      wrap.appendChild(buildCodePreview(item.content, language));
    } else {
      // Markdown / unspecified text: existing Markdown renderer.
      wrap.appendChild(buildDetailContent(item.content, initialMode));
    }
  }

  // ── Type-specific subsection (source link, audio/video player) ───────
  const subsection = buildDetailTypeBlock(item);
  if (subsection !== null) wrap.appendChild(subsection);

  // ── Activity slot (Phase 3c): empty container that `loadItemActivity`
  //    populates with `buildDetailActivity(events)` once the per-asset
  //    commit log loads. Carries the item id so the loader can confirm
  //    the user hasn't switched items mid-flight.
  const activitySlot = document.createElement('section');
  activitySlot.className = 'spaces-detail-activity-slot';
  activitySlot.setAttribute('data-activity-slot', item.id);
  wrap.appendChild(activitySlot);

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
      .catch(() => {
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
      } catch {
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

/** Meta strip: relative time · size · producer · last-edited-by. */
export function buildDetailMeta(item: RendererItem): HTMLElement {
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
  if (item.producedBy !== null || (item.lastEditedBy ?? null) !== null) {
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
        cb(tag.trim()).catch(() => {
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
      } catch {
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
  initialMode: DetailPreviewMode
): HTMLElement {
  const block = document.createElement('div');
  block.className = 'spaces-detail-content-block';
  block.setAttribute('data-mode', initialMode);

  // Toggle row.
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
  return block;
}

function renderSource(source: string): HTMLElement {
  const pre = document.createElement('pre');
  pre.className = 'spaces-detail-source-pre';
  pre.textContent = source;
  return pre;
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
export function buildAttributionChip(item: RendererItem): HTMLElement | null {
  const editor = item.lastEditedBy ?? null;
  const producer = item.producedBy;
  const editorDistinct = editor !== null && editor.id !== producer?.id;

  let label: string;
  let name: string;
  let timeIso: string;
  if (editorDistinct) {
    label = 'Last edited by';
    name = editor.name.length > 0 ? editor.name : '(unknown)';
    timeIso = item.updatedAt;
  } else if (producer !== null) {
    label = 'Created by';
    name = producer.name.length > 0 ? producer.name : '(unknown)';
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
        .catch(() => {
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

const MARKDOWN_ESCAPE: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => MARKDOWN_ESCAPE[ch] ?? ch);
}

/**
 * Apply inline Markdown to an already HTML-escaped string.
 *
 * Code spans are extracted into placeholders BEFORE bold / italic /
 * link replacements so we never interpret formatting inside `` `…` ``.
 * Placeholders are unique sentinel strings (` CS<n> `) that
 * can't collide with user content (NUL is forbidden in source) — they
 * survive the other passes intact and we restore them at the end.
 */
export function renderInlineMarkdown(escapedSource: string): string {
  const codeSpans: string[] = [];
  // 1. Extract code spans into placeholders.
  let out = escapedSource.replace(/`([^`]+)`/g, (_m, code) => {
    const idx = codeSpans.length;
    codeSpans.push(`<code>${code}</code>`);
    return ` CS${idx} `;
  });
  // 2. Bold then italic so **x** parses before *x*.
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\s][^*]*[^*\s]|[^*\s])\*/g, '$1<em>$2</em>');
  // 3. Links: [text](url). URL must be http(s) for safety; mailto OK.
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
    (_m, text, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`
  );
  // 4. Restore code-span placeholders.
  out = out.replace(/ CS(\d+) /g, (_m, n) => codeSpans[Number(n)] ?? '');
  return out;
}

/**
 * Render a Markdown source string into a DOM element. Pure; the
 * returned element is unparented and safe to append anywhere.
 *
 * Exported for jsdom tests. The implementation is deliberately
 * minimal: it covers what users typically write in inline notes
 * without pulling in a 30KB library.
 */
export function renderMarkdown(source: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'spaces-markdown';
  if (typeof source !== 'string' || source.length === 0) return wrap;

  const lines = source.split(/\r?\n/);
  let i = 0;
  let buf: string[] = []; // accumulating paragraph lines

  const flushParagraph = (): void => {
    if (buf.length === 0) return;
    const text = buf.join(' ').trim();
    buf = [];
    if (text.length === 0) return;
    const p = document.createElement('p');
    p.innerHTML = renderInlineMarkdown(escapeHtml(text));
    wrap.appendChild(p);
  };

  while (i < lines.length) {
    const line = lines[i] ?? '';
    // Fenced code block: ``` start … ``` end.
    if (line.trim().startsWith('```')) {
      flushParagraph();
      const fenceLang = line.trim().slice(3);
      i++;
      const codeLines: string[] = [];
      while (i < lines.length && !((lines[i] ?? '').trim().startsWith('```'))) {
        codeLines.push(lines[i] ?? '');
        i++;
      }
      if (i < lines.length) i++; // consume closing fence
      const pre = document.createElement('pre');
      pre.className = 'spaces-markdown-code';
      if (fenceLang.length > 0) pre.setAttribute('data-lang', fenceLang);
      const code = document.createElement('code');
      code.textContent = codeLines.join('\n');
      pre.appendChild(code);
      wrap.appendChild(pre);
      continue;
    }
    // ATX headers.
    const headerMatch = /^(#{1,3})\s+(.+)$/.exec(line);
    if (headerMatch !== null) {
      flushParagraph();
      const level = (headerMatch[1] ?? '#').length;
      const text = (headerMatch[2] ?? '').trim();
      const h = document.createElement(`h${level}` as 'h1' | 'h2' | 'h3');
      h.innerHTML = renderInlineMarkdown(escapeHtml(text));
      wrap.appendChild(h);
      i++;
      continue;
    }
    // List (one level): collect contiguous list lines.
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      flushParagraph();
      const isOrdered = /^\s*\d+\./.test(line);
      const list = document.createElement(isOrdered ? 'ol' : 'ul');
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i] ?? '')) {
        const li = document.createElement('li');
        const stripped = (lines[i] ?? '').replace(/^\s*([-*]|\d+\.)\s+/, '');
        li.innerHTML = renderInlineMarkdown(escapeHtml(stripped));
        list.appendChild(li);
        i++;
      }
      wrap.appendChild(list);
      continue;
    }
    // Blank line ends a paragraph.
    if (line.trim().length === 0) {
      flushParagraph();
      i++;
      continue;
    }
    buf.push(line);
    i++;
  }
  flushParagraph();
  return wrap;
}

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

async function refreshCounts(): Promise<void> {
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
    state.home.counts.error = messageFrom(err);
  } finally {
    state.home.counts.loading = false;
    renderHome();
  }
}

async function refreshContributors(): Promise<void> {
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
    state.home.contributors.error = messageFrom(err);
  } finally {
    state.home.contributors.loading = false;
    renderHome();
  }
}

async function refreshAgents(): Promise<void> {
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
    state.home.agents.error = messageFrom(err);
  } finally {
    state.home.agents.loading = false;
    renderHome();
  }
}

async function refreshPermission(): Promise<void> {
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
    state.home.permission.error = messageFrom(err);
  } finally {
    state.home.permission.loading = false;
    renderHome();
  }
}

async function refreshRecentItems(): Promise<void> {
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
    state.home.recentItems.error = messageFrom(err);
  } finally {
    state.home.recentItems.loading = false;
    renderHome();
  }
}

async function refreshEvents(): Promise<void> {
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

function buildSinceLastVisit(): HTMLElement | null {
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
      object: item.title.length > 0 ? item.title : '(untitled)',
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
            name: typeof e.spaceName === 'string' && e.spaceName.length > 0 ? e.spaceName : e.spaceId,
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
function buildHomeTimeline(): HTMLElement {
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

  const list = document.createElement('div');
  list.className = 'home-timeline-list';
  for (const row of filtered) {
    list.appendChild(buildTimelineRow(row));
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

  el.addEventListener('click', () => {
    if (typeof row.spaceId === 'string' && row.spaceId.length > 0) {
      setActiveScope(row.spaceId);
      if (typeof row.itemId === 'string' && row.itemId.length > 0) {
        void loadItemDetail(row.itemId);
      }
    } else if (row.kind === 'item') {
      // Item not in any Space → take the user to Uncategorized so
      // they can see it in context.
      setActiveScope(UNCATEGORIZED_SPACE_ID);
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
function buildHomeContext(): HTMLElement {
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
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
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
  buildSpaceRow,
  buildItemCard,
  buildSpaceChip,
  buildDetailPane,
  buildDetailMeta,
  buildDetailTags,
  buildDetailContent,
  buildEditableTitle,
  buildKindReclassify,
  buildAttributionChip,
  buildDetailActivity,
  buildTicketStatusPill,
  buildDetailTicketBlock,
  buildDetailPlaybookBlock,
  buildCodePreview,
  buildCsvPreview,
  detectTextPreviewLanguage,
  renderMarkdown,
  renderInlineMarkdown,
  formatBytes,
  buildBinaryPreview,
  buildItemsToolbar,
  formatCount,
  formatRelativeTime,
  normalizeSearchQuery,
  matchesSearchQuery,
  sortSpaces,
  // Home (chunk 3o) — timeline-first builders + pure helpers.
  buildWelcomeCard,
  buildFilterChips,
  buildTimelineRow,
  mergeTimeline,
  filterTimeline,
  formatSinceLastVisit,
  countTimelineSince,
  looksLikeAgentAuthor,
  prettyAuthor,
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
  wireNewSpaceDialog();
  wireRowMenuTriggers();
  wireRowMenu();
  wireToast();
  wireNewAssetDialog();
  wireDragDropAssetUpload();
}

// ─── "+ Shared Space" button (Phase 4 v2) ───────────────────────────────

/**
 * Flag that the next createSpace submit should flip the space to
 * `kind=shared` after creation. Read inside `submitNewSpace`. We use
 * module state rather than a query param because the dialog itself
 * is shared between flows; this lets the dialog stay generic.
 */
let pendingSharedFlip = false;

function wireNewSharedSpaceButton(): void {
  const button = document.getElementById('spaces-new-shared-button');
  if (button === null) return;
  button.addEventListener('click', () => {
    pendingSharedFlip = true;
    openNewSpaceDialog();
    // Update the dialog title so the user knows they're creating a
    // shared space (the dialog body itself is reused).
    const title = document.getElementById('spaces-new-dialog-title');
    if (title !== null) title.textContent = 'New shared space';
  });
}

// ─── "+ New Space" button + modal dialog ────────────────────────────────

function wireNewSpaceButton(): void {
  const button = document.getElementById('spaces-new-button');
  if (button === null) return;
  button.addEventListener('click', () => {
    openNewSpaceDialog();
  });
}

function openNewSpaceDialog(): void {
  const backdrop = document.getElementById('spaces-new-dialog-backdrop');
  const input = document.getElementById('spaces-new-name-input');
  const error = document.getElementById('spaces-new-error');
  if (backdrop === null || !(input instanceof HTMLInputElement) || error === null) return;
  backdrop.hidden = false;
  backdrop.setAttribute('aria-hidden', 'false');
  input.value = '';
  error.hidden = true;
  error.textContent = '';
  // Defer focus so the browser doesn't fight the modal animation.
  requestAnimationFrame(() => input.focus());
}

function closeNewSpaceDialog(): void {
  const backdrop = document.getElementById('spaces-new-dialog-backdrop');
  if (backdrop === null) return;
  backdrop.hidden = true;
  backdrop.setAttribute('aria-hidden', 'true');
  // Reset the dialog title in case it was customized for "+ Shared".
  const title = document.getElementById('spaces-new-dialog-title');
  if (title !== null) title.textContent = 'New space';
  // Clear the shared-flip flag if the user cancelled mid-flow.
  pendingSharedFlip = false;
}

function wireNewSpaceDialog(): void {
  const form = document.getElementById('spaces-new-form');
  const cancel = document.getElementById('spaces-new-cancel');
  const backdrop = document.getElementById('spaces-new-dialog-backdrop');
  if (form instanceof HTMLFormElement) {
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      void submitNewSpace();
    });
  }
  if (cancel !== null) {
    cancel.addEventListener('click', () => closeNewSpaceDialog());
  }
  if (backdrop !== null) {
    // Click on the dim area (NOT the modal itself) closes the dialog.
    backdrop.addEventListener('click', (ev) => {
      if (ev.target === backdrop) closeNewSpaceDialog();
    });
  }
  // Esc closes when the dialog is open.
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      if (backdrop !== null && backdrop.hidden === false) closeNewSpaceDialog();
      if (rowMenuState.spaceId !== null) closeRowMenu();
    }
  });
}

async function submitNewSpace(): Promise<void> {
  const input = document.getElementById('spaces-new-name-input');
  const error = document.getElementById('spaces-new-error');
  const submit = document.getElementById('spaces-new-submit');
  if (!(input instanceof HTMLInputElement) || error === null) return;
  const name = input.value.trim();
  if (name.length === 0) {
    showDialogError(error, 'Please enter a name.');
    return;
  }
  if (submit instanceof HTMLButtonElement) submit.disabled = true;
  error.hidden = true;
  error.textContent = '';
  const bridge = window.lite?.spaces;
  if (bridge === undefined) {
    showDialogError(error, 'Bridge unavailable. Reload the window.');
    if (submit instanceof HTMLButtonElement) submit.disabled = false;
    return;
  }
  try {
    const envelope = await bridge.createSpace({ name });
    if (envelope.ok === false) {
      showDialogError(error, envelope.error.message);
      if (submit instanceof HTMLButtonElement) submit.disabled = false;
      return;
    }
    // Phase 4 v2: if the user clicked "+ Shared", flip kind to shared
    // before refreshing the list so the new row paints with the badge.
    // Failure here is non-fatal — the space exists, just as a regular
    // user-managed one; the user can re-flip via the row menu.
    const createdId = (envelope.value as { id?: unknown }).id;
    if (pendingSharedFlip && typeof createdId === 'string') {
      try {
        await bridge.setSpaceKind(createdId, 'shared');
      } catch {
        // Soft fail: surface a softer toast instead of an error banner.
      }
    }
    const wasShared = pendingSharedFlip;
    pendingSharedFlip = false;
    closeNewSpaceDialog();
    await loadSpaces();
    showToast(wasShared ? `Created shared space "${name}"` : `Created "${name}"`);
    // Auto-navigate into the new space so the user lands on something useful.
    if (typeof createdId === 'string') setActiveScope(createdId);
  } catch (err) {
    showDialogError(error, messageFrom(err));
  } finally {
    if (submit instanceof HTMLButtonElement) submit.disabled = false;
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
  // Position relative to the trigger.
  const rect = triggerEl.getBoundingClientRect();
  menu.style.top = `${Math.round(rect.bottom + 4)}px`;
  menu.style.left = `${Math.round(rect.left - 100)}px`; // shift left so menu opens to the left of ⋯
  menu.hidden = false;
  menu.setAttribute('aria-hidden', 'false');
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
    showToast(`Deleted "${displayName}"`, {
      undoLabel: 'Undo',
      onUndo: () => void performUndoDelete(spaceId, displayName),
    });
  } catch (err) {
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

async function runItemsSearch(): Promise<void> {
  const query = state.itemsSearchQuery.trim();
  if (query.length === 0) {
    state.itemsSearchResults = null;
    renderItemList({});
    return;
  }
  const bridge = window.lite?.spaces;
  if (bridge === undefined) return;
  const spaceId =
    state.activeScopeId !== HOME_SCOPE_ID &&
    state.activeScopeId !== UNCATEGORIZED_SPACE_ID
      ? state.activeScopeId
      : undefined;
  try {
    const envelope = await bridge.items.search({
      query,
      ...(spaceId !== undefined ? { spaceId } : {}),
      limit: 50,
    });
    if (envelope.ok === false) {
      state.itemsSearchResults = [];
      renderItemList({ error: envelope.error.message });
      return;
    }
    state.itemsSearchResults = envelope.value as RendererItemSummary[];
    renderItemList({});
  } catch (err) {
    state.itemsSearchResults = [];
    renderItemList({ error: messageFrom(err) });
  }
}

// ─── Sprint 1: new-asset modal + drag-drop upload + delete action ───────

let newAssetMode: 'text' | 'upload' = 'text';
let newAssetFile: File | null = null;

function wireNewAssetDialog(): void {
  const form = document.getElementById('spaces-new-asset-form');
  const cancel = document.getElementById('spaces-new-asset-cancel');
  const backdrop = document.getElementById('spaces-new-asset-backdrop');
  const tabs = document.querySelectorAll<HTMLButtonElement>('[data-asset-tab]');
  const fileInput = document.getElementById('spaces-new-asset-file-input');

  if (form instanceof HTMLFormElement) {
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      void submitNewAsset();
    });
  }
  if (cancel !== null) {
    cancel.addEventListener('click', () => closeNewAssetDialog());
  }
  if (backdrop !== null) {
    backdrop.addEventListener('click', (ev) => {
      if (ev.target === backdrop) closeNewAssetDialog();
    });
  }
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const mode = tab.getAttribute('data-asset-tab');
      if (mode !== 'text' && mode !== 'upload') return;
      switchNewAssetMode(mode);
    });
  });
  if (fileInput instanceof HTMLInputElement) {
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0] ?? null;
      newAssetFile = file;
      const hint = document.getElementById('spaces-new-asset-file-hint');
      if (hint !== null) {
        hint.textContent = file !== null
          ? `${file.name} (${formatBytes(file.size)})`
          : 'No file selected.';
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

function switchNewAssetMode(mode: 'text' | 'upload'): void {
  newAssetMode = mode;
  document.querySelectorAll<HTMLElement>('[data-asset-tab]').forEach((tab) => {
    const isActive = tab.getAttribute('data-asset-tab') === mode;
    tab.classList.toggle('is-active', isActive);
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  document.querySelectorAll<HTMLElement>('[data-asset-pane]').forEach((pane) => {
    pane.hidden = pane.getAttribute('data-asset-pane') !== mode;
  });
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
  newAssetFile = null;
  const hint = document.getElementById('spaces-new-asset-file-hint');
  if (hint !== null) hint.textContent = 'No file selected.';
  if (error !== null) {
    error.hidden = true;
    error.textContent = '';
  }
  // If a file was preset (via drag-drop), switch to upload mode and stash it.
  if (presetFile !== null) {
    newAssetFile = presetFile;
    titleInput.value = presetFile.name;
    if (hint !== null) {
      hint.textContent = `${presetFile.name} (${formatBytes(presetFile.size)})`;
    }
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
  const titleInput = document.getElementById('spaces-new-asset-title-input');
  const contentInput = document.getElementById('spaces-new-asset-content-input');
  const error = document.getElementById('spaces-new-asset-error');
  const submit = document.getElementById('spaces-new-asset-submit');
  if (!(titleInput instanceof HTMLInputElement) || error === null) return;
  const title = titleInput.value.trim();
  if (title.length === 0) {
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

  try {
    const creatorId = readCurrentEditorId();
    if (newAssetMode === 'upload' && newAssetFile !== null) {
      // Upload bytes via the Files bridge, then create the asset row
      // with the resulting key. Files bridge isn't exposed on
      // window.lite directly today (it's main-only). Fall back to
      // creating the asset with the filename in `sourceUrl` as a
      // placeholder until the renderer-side files bridge lands.
      // (For v1 we'll surface the file directly via FileReader as
      // base64 in the content field — sufficient for small files.)
      const file = newAssetFile;
      const bytes = await readFileAsBase64(file);
      const payload: Parameters<typeof bridge.items.create>[0] = {
        spaceId,
        title,
        kind: inferKindFromMime(file.type) as 'image' | 'video' | 'audio' | 'document' | 'other',
        mimeType: file.type,
        size: file.size,
        content: bytes, // base64 stub for v1; replace with real upload later
        ...(creatorId !== null ? { creatorId } : {}),
      };
      const envelope = await bridge.items.create(payload);
      if (envelope.ok === false) {
        showDialogError(error, envelope.error.message);
        if (submit instanceof HTMLButtonElement) submit.disabled = false;
        return;
      }
    } else {
      const content =
        contentInput instanceof HTMLTextAreaElement ? contentInput.value : '';
      const envelope = await bridge.items.create({
        spaceId,
        title,
        kind: 'text',
        content,
        ...(creatorId !== null ? { creatorId } : {}),
      });
      if (envelope.ok === false) {
        showDialogError(error, envelope.error.message);
        if (submit instanceof HTMLButtonElement) submit.disabled = false;
        return;
      }
    }
    closeNewAssetDialog();
    showToast(`Created "${title}"`);
    await loadItems();
  } catch (err) {
    showDialogError(error, messageFrom(err));
  } finally {
    if (submit instanceof HTMLButtonElement) submit.disabled = false;
  }
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (): void => {
      const result = reader.result;
      if (typeof result === 'string') resolve(result);
      else reject(new Error('Unexpected reader result'));
    };
    reader.onerror = (): void => reject(reader.error ?? new Error('Read failed'));
    reader.readAsDataURL(file);
  });
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
    showToast(messageFrom(err));
  }
}

// ─── Boot ───────────────────────────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
