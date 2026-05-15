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
  },
};

// ─── Bootstrap ──────────────────────────────────────────────────────────

function init(): void {
  applyActiveRow(state.activeScopeId);
  wireSidebarClicks();
  wireSidebarSearch();
  wireSidebarSort();
  // Home is the default scope -- show its region, hide the items
  // region. This ensures first paint matches state even if
  // `setActiveScope` never runs.
  applyScopeRegions(state.activeScopeId);
  void initialLoad();
}

async function initialLoad(): Promise<void> {
  // Sidebar always loads (Spaces list + Uncategorized count); Home
  // and items load based on the active scope. Home is the default.
  const sidebarWork: Array<Promise<void>> = [
    loadSpaces(),
    loadUncategorizedCount(),
  ];
  if (state.activeScopeId === HOME_SCOPE_ID) {
    sidebarWork.push(loadHome());
  } else {
    sidebarWork.push(loadItems());
  }
  await Promise.all(sidebarWork);
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
  } catch (err) {
    state.loadingDetail = false;
    renderDetail({ error: messageFrom(err) });
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

export function buildBinaryPreview(
  item: RendererItem,
  url: string
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'spaces-detail-preview';
  wrap.setAttribute('data-kind', item.kind);
  if (item.kind === 'image') {
    const img = document.createElement('img');
    img.src = url;
    img.alt = item.title.length > 0 ? item.title : 'Item preview';
    img.loading = 'lazy';
    img.className = 'spaces-detail-image';
    wrap.appendChild(img);
    return wrap;
  }
  // Non-image binary: render a download link so the user can fetch
  // the file in their browser of choice. We deliberately don't auto-
  // play audio / video here -- that's a future micro-phase decision.
  const label = document.createElement('span');
  label.className = 'spaces-detail-label';
  label.textContent = item.kind === 'audio'
    ? 'Audio file'
    : item.kind === 'video'
    ? 'Video file'
    : 'File';
  wrap.appendChild(label);
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.className = 'spaces-detail-download';
  link.textContent = 'Download';
  wrap.appendChild(link);
  return wrap;
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
  if (scopeId === HOME_SCOPE_ID) {
    void loadHome();
  } else {
    void loadItems();
  }
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

  const count = document.createElement('span');
  count.className = 'spaces-row-count';
  count.textContent =
    typeof space.itemCount === 'number' ? formatCount(space.itemCount) : '';
  li.appendChild(count);

  return li;
}

// ─── Item card list ─────────────────────────────────────────────────────

interface RenderItemListOpts {
  loading?: boolean;
  error?: string;
}

function renderItemList(opts: RenderItemListOpts): void {
  const main = document.getElementById('spaces-main');
  if (main === null) return;
  const wrap = ensureItemsRegion(main);
  wrap.replaceChildren();

  // Toolbar (Phase 2f): refresh button + count summary. Always
  // rendered above the items area so the user has a consistent
  // affordance during loading / empty / populated states.
  wrap.appendChild(buildItemsToolbar({ busy: opts.loading === true }));

  if (opts.error !== undefined) {
    wrap.appendChild(buildBanner('error', opts.error));
    return;
  }
  if (opts.loading === true) {
    wrap.appendChild(buildBanner('info', 'Loading items…'));
    return;
  }
  if (state.items.length === 0) {
    wrap.appendChild(buildEmptyItemsState(state.activeScopeId));
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'spaces-card-grid';
  grid.id = 'spaces-card-grid';
  for (const item of state.items) {
    grid.appendChild(buildItemCard(item, item.id === state.activeItemId));
  }
  wrap.appendChild(grid);
  wireCardClicks(grid);
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

function wireCardClicks(grid: HTMLElement): void {
  grid.addEventListener('click', (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const card = target.closest<HTMLElement>('.spaces-card');
    if (card === null) return;
    const itemId = card.getAttribute('data-item-id');
    if (typeof itemId !== 'string' || itemId.length === 0) return;
    // Toggle: clicking the active card collapses the detail rail.
    if (itemId === state.activeItemId) {
      state.activeItemId = null;
      applyActiveCard(grid, null);
      showDetailRail(false);
      return;
    }
    applyActiveCard(grid, itemId);
    void loadItemDetail(itemId);
  });
}

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
  aside.appendChild(buildDetailPane(opts.item, () => {
    state.activeItemId = null;
    const grid = document.getElementById('spaces-card-grid');
    if (grid !== null) applyActiveCard(grid, null);
    showDetailRail(false);
  }));
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

export function buildDetailPane(
  item: RendererItem,
  onClose: () => void
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'spaces-detail-pane';

  const header = document.createElement('div');
  header.className = 'spaces-detail-head';

  const kind = document.createElement('span');
  kind.className = `spaces-card-kind spaces-card-kind-${item.kind}`;
  kind.textContent = kindLabel(item.kind);
  header.appendChild(kind);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'spaces-detail-close';
  closeBtn.setAttribute('aria-label', 'Close detail');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => onClose());
  header.appendChild(closeBtn);

  wrap.appendChild(header);

  const title = document.createElement('h2');
  title.className = 'spaces-detail-title';
  title.textContent = item.title.length > 0 ? item.title : '(untitled)';
  wrap.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'spaces-detail-meta';
  meta.textContent = `Updated ${formatRelativeTime(item.updatedAt)}`;
  wrap.appendChild(meta);

  if (item.otherSpaces.length > 0) {
    const chips = document.createElement('div');
    chips.className = 'spaces-detail-chips';
    for (const chip of item.otherSpaces) {
      chips.appendChild(buildSpaceChip(chip));
    }
    wrap.appendChild(chips);
  }

  if (item.producedBy !== null) {
    const prov = document.createElement('div');
    prov.className = 'spaces-detail-provenance';
    prov.textContent = `Produced by ${item.producedBy.name} (${item.producedBy.kind})`;
    wrap.appendChild(prov);
  }

  if (typeof item.content === 'string' && item.content.length > 0) {
    const content = document.createElement('div');
    content.className = 'spaces-detail-content';
    const pre = document.createElement('pre');
    pre.textContent = item.content;
    content.appendChild(pre);
    wrap.appendChild(content);
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
    wrap.appendChild(sourceWrap);
  }

  return wrap;
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
  // Always render once up-front so skeletons appear if cache is empty,
  // or stale data shows immediately if cache is present.
  renderHome();

  const now = Date.now();
  const fresh = (entry: HomeCacheEntry<unknown>): boolean =>
    entry.value !== null && now - entry.fetchedAt < HOME_CACHE_TTL_MS;

  // Fire one query per stale/empty cache slot. Each query mutates its
  // own cache entry and re-renders that card on completion.
  const work: Array<Promise<void>> = [];
  if (!fresh(state.home.counts)) work.push(refreshCounts());
  if (!fresh(state.home.contributors)) work.push(refreshContributors());
  if (!fresh(state.home.agents)) work.push(refreshAgents());
  if (!fresh(state.home.permission)) work.push(refreshPermission());
  if (!fresh(state.home.recentItems)) work.push(refreshRecentItems());
  await Promise.all(work);
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
    const envelope = await bridge.recentItems({ limit: 3 });
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

/**
 * Render all 5 cards from current state. Idempotent; safe to call
 * repeatedly (e.g. after each query lands). The whole region is
 * rebuilt rather than diffed because (a) 5 cards is cheap and
 * (b) avoiding a diff library keeps the bundle slim.
 */
function renderHome(): void {
  const region = document.getElementById('spaces-home-region');
  if (region === null) return;
  region.replaceChildren();

  const greeting = document.createElement('div');
  greeting.className = 'spaces-home-greeting';
  greeting.textContent = 'Your data room';
  region.appendChild(greeting);

  region.appendChild(buildHomeCounts());
  region.appendChild(buildHomeContributors());
  region.appendChild(buildHomeAgents());
  const permissionCard = buildHomePermission();
  if (permissionCard !== null) region.appendChild(permissionCard);
  region.appendChild(buildHomeRecent());
}

// ─── Card 1: Your data room at a glance ─────────────────────────────────

export function buildHomeCounts(): HTMLElement {
  const card = document.createElement('article');
  card.className = 'home-card home-card-counts';

  const header = document.createElement('div');
  header.className = 'home-card-header';
  const title = document.createElement('h3');
  title.className = 'home-card-title';
  title.textContent = 'Your data room';
  header.appendChild(title);
  card.appendChild(header);

  const entry = state.home.counts;
  if (entry.error !== null && entry.value === null) {
    card.appendChild(buildCardError(entry.error));
    return card;
  }

  const counts = entry.value;
  if (counts === null) {
    // Skeleton: three big-number tiles.
    card.appendChild(buildCountsSkeleton());
    card.classList.add('is-loading');
    return card;
  }

  const totalIsZero =
    counts.spaces === 0 &&
    counts.assets === 0 &&
    counts.people === 0 &&
    counts.agents === 0;
  if (totalIsZero) {
    card.appendChild(buildEmpty('Your data room is empty.', 'Create your first Space →'));
    return card;
  }

  const grid = document.createElement('div');
  grid.className = 'home-counts';
  grid.appendChild(buildCountTile('Spaces', counts.spaces));
  grid.appendChild(buildCountTile('Assets', counts.assets));
  grid.appendChild(buildCountTile('People', counts.people));
  card.appendChild(grid);

  const footer = document.createElement('div');
  footer.className = 'home-counts-footer';
  const strong = document.createElement('span');
  strong.className = 'home-counts-footer-strong';
  strong.textContent = String(counts.agents);
  footer.appendChild(document.createTextNode('Plus '));
  footer.appendChild(strong);
  footer.appendChild(
    document.createTextNode(
      counts.agents === 1 ? ' agent available to your account' : ' agents available to your account'
    )
  );
  card.appendChild(footer);

  return card;
}

export function buildCountTile(label: string, value: number): HTMLElement {
  const tile = document.createElement('div');
  tile.className = 'home-count-tile';
  const v = document.createElement('div');
  v.className = 'home-count-value';
  v.textContent = formatBigNumber(value);
  tile.appendChild(v);
  const l = document.createElement('div');
  l.className = 'home-count-label';
  l.textContent = label;
  tile.appendChild(l);
  // Tufte-style sparkline: synthesised from the count itself for v1
  // (real time-series ships with v2's auto-metadata work). The line
  // shows a gentle upward curve weighted by the value so users get a
  // visual cue without false precision.
  tile.appendChild(buildSparkline(value));
  return tile;
}

/**
 * Render a 30-point sparkline as inline SVG. v1 synthesises the
 * series from the count so the visual reads "growing → here we are";
 * v2 will derive real daily buckets from `:Asset.createdAt`.
 *
 * Pure builder: no DOM lookups, deterministic for a given count.
 * Exported for jsdom tests.
 */
export function buildSparkline(value: number): SVGElement {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'home-sparkline');
  svg.setAttribute('viewBox', '0 0 100 18');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svgNS, 'path');
  path.setAttribute('d', sparklinePath(value));
  svg.appendChild(path);
  return svg as unknown as SVGElement;
}

/**
 * Compute a smooth-ish path string for the synthesised sparkline.
 * Returns an SVG path `d` attribute. For value=0 returns a flat line
 * along the baseline.
 */
export function sparklinePath(value: number): string {
  const points = 30;
  const w = 100;
  const h = 18;
  const baseline = h - 1;
  if (value <= 0) {
    return `M0,${baseline} L${w},${baseline}`;
  }
  // Map value to a 0-1 "intensity" with diminishing returns past 100.
  const intensity = Math.min(1, Math.log10(value + 1) / 2.5);
  const peakHeight = baseline - intensity * (h - 2);
  const segments: string[] = [];
  for (let i = 0; i < points; i++) {
    const x = (i / (points - 1)) * w;
    // Slight wave pattern that trends upward; makes the sparkline
    // read as "active growth" rather than a perfect curve.
    const t = i / (points - 1);
    const trend = peakHeight + (baseline - peakHeight) * (1 - Math.pow(t, 1.4));
    const wiggle = Math.sin(i * 0.6) * 0.6;
    const y = Math.max(1, Math.min(baseline, trend + wiggle));
    segments.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(2)}`);
  }
  return segments.join(' ');
}

function buildCountsSkeleton(): HTMLElement {
  const grid = document.createElement('div');
  grid.className = 'home-counts';
  for (let i = 0; i < 3; i++) {
    const tile = document.createElement('div');
    tile.className = 'home-count-tile';
    const num = document.createElement('div');
    num.className = 'home-skeleton home-skeleton-number';
    tile.appendChild(num);
    const label = document.createElement('div');
    label.className = 'home-skeleton home-skeleton-line is-short';
    tile.appendChild(label);
    grid.appendChild(tile);
  }
  return grid;
}

// ─── Card 2: Recent activity ────────────────────────────────────────────

export function buildHomeContributors(): HTMLElement {
  const card = document.createElement('article');
  card.className = 'home-card home-card-contributors';

  const header = document.createElement('div');
  header.className = 'home-card-header';
  const title = document.createElement('h3');
  title.className = 'home-card-title';
  title.textContent = 'Recent activity';
  header.appendChild(title);
  card.appendChild(header);

  const entry = state.home.contributors;
  if (entry.error !== null && entry.value === null) {
    card.appendChild(buildCardError(entry.error));
    return card;
  }

  const contributors = entry.value;
  if (contributors === null) {
    card.appendChild(buildLinesSkeleton(4));
    card.classList.add('is-loading');
    return card;
  }

  if (contributors.length === 0) {
    card.appendChild(
      buildEmpty('No activity yet this week.', 'Activity from people and agents will appear here.')
    );
    return card;
  }

  const list = document.createElement('div');
  list.className = 'home-contributors';
  for (const c of contributors) {
    list.appendChild(buildContributorRow(c));
  }
  card.appendChild(list);

  const footer = document.createElement('div');
  footer.className = 'home-card-header';
  const seeAll = document.createElement('button');
  seeAll.type = 'button';
  seeAll.className = 'home-card-action';
  seeAll.textContent = 'See timeline →';
  seeAll.addEventListener('click', () => {
    void openEventsModal();
  });
  footer.appendChild(seeAll);
  card.appendChild(footer);

  return card;
}

export function buildContributorRow(c: RendererContributor): HTMLElement {
  const row = document.createElement('div');
  row.className = 'home-contributor-row';
  const name = document.createElement('div');
  name.className = 'home-contributor-name';
  name.textContent = c.displayName.length > 0 ? c.displayName : c.author;
  row.appendChild(name);
  const summary = document.createElement('div');
  summary.className = 'home-contributor-summary';
  summary.textContent = `${formatCount(c.events)} ${c.events === 1 ? 'item' : 'items'} ${formatRecency(c.lastEventAt)}`;
  row.appendChild(summary);
  return row;
}

// ─── Card 3: Agents in your account ─────────────────────────────────────

export function buildHomeAgents(): HTMLElement {
  const card = document.createElement('article');
  card.className = 'home-card home-card-agents';

  const header = document.createElement('div');
  header.className = 'home-card-header';
  const title = document.createElement('h3');
  title.className = 'home-card-title';
  title.textContent = 'Agents in your account';
  header.appendChild(title);
  card.appendChild(header);

  const entry = state.home.agents;
  if (entry.error !== null && entry.value === null) {
    card.appendChild(buildCardError(entry.error));
    return card;
  }

  const agents = entry.value;
  if (agents === null) {
    card.appendChild(buildLinesSkeleton(3));
    card.classList.add('is-loading');
    return card;
  }

  if (agents.length === 0) {
    card.appendChild(buildEmpty('No agents enabled for your account yet.', ''));
    return card;
  }

  const list = document.createElement('div');
  list.className = 'home-agents';
  for (const a of agents) {
    list.appendChild(buildAgentRow(a));
  }
  card.appendChild(list);

  const totalAgents = state.home.counts.value?.agents ?? agents.length;
  const remaining = Math.max(0, totalAgents - agents.length);
  if (remaining > 0) {
    const footer = document.createElement('div');
    footer.className = 'home-card-header';
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'home-card-action';
    more.textContent = `+ ${formatCount(remaining)} more — see all →`;
    more.addEventListener('click', () => {
      void openAgentsModal();
    });
    footer.appendChild(more);
    card.appendChild(footer);
  }

  return card;
}

export function buildAgentRow(a: RendererAgentSummary): HTMLElement {
  const row = document.createElement('div');
  row.className = 'home-agent-row';
  const icon = document.createElement('span');
  icon.className = 'home-agent-icon';
  row.appendChild(icon);
  const text = document.createElement('div');
  const name = document.createElement('span');
  name.className = 'home-agent-name';
  name.textContent = a.name;
  text.appendChild(name);
  if (a.description.length > 0) {
    const desc = document.createElement('span');
    desc.className = 'home-agent-description';
    desc.textContent = a.description;
    text.appendChild(desc);
  }
  row.appendChild(text);
  return row;
}

// ─── Card 4: Your view ──────────────────────────────────────────────────

export function buildHomePermission(): HTMLElement | null {
  const entry = state.home.permission;
  // Hide the card entirely while loading the first time AND when
  // visibleSpaceCount is 0 (the empty story is told by Card 1).
  if (entry.value === null && !entry.loading) return null;
  if (entry.value !== null && entry.value.visibleSpaceCount === 0) return null;

  const card = document.createElement('article');
  card.className = 'home-card home-card-permission';

  const header = document.createElement('div');
  header.className = 'home-card-header';
  const title = document.createElement('h3');
  title.className = 'home-card-title';
  title.textContent = 'Your view';
  header.appendChild(title);
  card.appendChild(header);

  if (entry.error !== null && entry.value === null) {
    card.appendChild(buildCardError(entry.error));
    return card;
  }

  if (entry.value === null) {
    const skeleton = document.createElement('div');
    skeleton.className = 'home-skeleton home-skeleton-line is-medium';
    card.appendChild(skeleton);
    card.classList.add('is-loading');
    return card;
  }

  const text = document.createElement('div');
  text.className = 'home-permission-text';
  if (
    typeof entry.value.totalSpaceCount === 'number' &&
    entry.value.totalSpaceCount > entry.value.visibleSpaceCount
  ) {
    text.textContent = `You can see ${entry.value.visibleSpaceCount} of ${entry.value.totalSpaceCount} Spaces in this account.`;
  } else {
    text.textContent = `You can see ${entry.value.visibleSpaceCount} ${entry.value.visibleSpaceCount === 1 ? 'Space' : 'Spaces'} in this account.`;
  }
  card.appendChild(text);

  return card;
}

// ─── Card 5: Just added ─────────────────────────────────────────────────

export function buildHomeRecent(): HTMLElement {
  const card = document.createElement('article');
  card.className = 'home-card home-card-recent';

  const header = document.createElement('div');
  header.className = 'home-card-header';
  const title = document.createElement('h3');
  title.className = 'home-card-title';
  title.textContent = 'Just added';
  header.appendChild(title);
  card.appendChild(header);

  const entry = state.home.recentItems;
  if (entry.error !== null && entry.value === null) {
    card.appendChild(buildCardError(entry.error));
    return card;
  }

  const items = entry.value;
  if (items === null) {
    card.appendChild(buildLinesSkeleton(3));
    card.classList.add('is-loading');
    return card;
  }

  if (items.length === 0) {
    card.appendChild(buildEmpty('Nothing added recently.', 'Drop a file in to get started.'));
    return card;
  }

  const list = document.createElement('div');
  list.className = 'home-recent-list';
  for (const item of items) {
    list.appendChild(buildRecentItemRow(item));
  }
  card.appendChild(list);

  return card;
}

export function buildRecentItemRow(item: RendererItemSummary): HTMLElement {
  const row = document.createElement('div');
  row.className = 'home-recent-row';
  row.setAttribute('role', 'button');
  row.setAttribute('tabindex', '0');
  row.setAttribute('data-item-id', item.id);

  const title = document.createElement('div');
  title.className = 'home-recent-title';
  title.textContent = item.title.length > 0 ? item.title : '(untitled)';
  row.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'home-recent-meta';
  const spaceChip = item.otherSpaces[0];
  if (spaceChip !== undefined) {
    const space = document.createElement('span');
    space.className = 'home-recent-space-name';
    space.textContent = `in ${spaceChip.name}`;
    meta.appendChild(space);
    meta.appendChild(document.createTextNode(' · '));
  }
  meta.appendChild(document.createTextNode(formatRecency(item.updatedAt || item.createdAt)));
  row.appendChild(meta);

  row.addEventListener('click', () => {
    if (typeof spaceChip?.id === 'string' && spaceChip.id.length > 0) {
      setActiveScope(spaceChip.id);
      // The items list will pick up; the existing `loadItemDetail` is
      // wired separately. v1 navigates to the Space; opening the
      // detail rail directly is a future enhancement.
    } else {
      setActiveScope(UNCATEGORIZED_SPACE_ID);
    }
  });

  return row;
}

// ─── Modals (used by Card 2 + Card 3 "see all") ─────────────────────────

async function openEventsModal(): Promise<void> {
  const bridge = window.lite?.spaces?.home;
  if (bridge === undefined) return;
  const modal = mountModal('Recent activity (last 100 events)');
  const body = modal.querySelector<HTMLElement>('.home-modal-body');
  if (body === null) return;
  body.appendChild(buildLinesSkeleton(8));
  try {
    const envelope = await bridge.recentEvents({ limit: 100 });
    body.replaceChildren();
    if (envelope.ok === false) {
      body.appendChild(buildCardError(envelope.error.message));
      return;
    }
    const events = envelope.value;
    if (events.length === 0) {
      body.appendChild(buildEmpty('No recent events.', ''));
      return;
    }
    for (const e of events) {
      const row = document.createElement('div');
      row.className = 'home-modal-row';
      const top = document.createElement('div');
      top.className = 'home-modal-row-title';
      top.textContent = `${e.author} · ${e.kind}`;
      row.appendChild(top);
      const meta = document.createElement('div');
      meta.className = 'home-modal-row-meta';
      const parts: string[] = [];
      if (typeof e.spaceName === 'string' && e.spaceName.length > 0) {
        parts.push(`in ${e.spaceName}`);
      }
      parts.push(formatRecency(e.timestamp));
      meta.textContent = parts.join(' · ');
      row.appendChild(meta);
      body.appendChild(row);
    }
  } catch (err) {
    body.replaceChildren();
    body.appendChild(buildCardError(messageFrom(err)));
  }
}

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
  buildBinaryPreview,
  buildItemsToolbar,
  formatCount,
  formatRelativeTime,
  normalizeSearchQuery,
  matchesSearchQuery,
  sortSpaces,
  // Home (chunk 3o) builders + helpers
  buildHomeCounts,
  buildHomeContributors,
  buildHomeAgents,
  buildHomePermission,
  buildHomeRecent,
  buildCountTile,
  buildContributorRow,
  buildAgentRow,
  buildRecentItemRow,
  buildSparkline,
  sparklinePath,
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
    };
    init();
    // Allow the fire-and-forget initialLoad() to flush.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  },
};

// ─── Boot ───────────────────────────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
