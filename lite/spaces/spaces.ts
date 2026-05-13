/**
 * Spaces window renderer.
 *
 * Phase 1 + Phase 2 scope (this file):
 *   - Sidebar `:Space` list populated from `listSpaces()` + Uncategorized
 *     count from `getUncategorizedCount()`.
 *   - Main pane renders `items.list(scope)` as cards.
 *   - Right rail renders `items.get(id)` when a card is clicked.
 *   - Item cards carry multi-Space chips (rendered from
 *     `ItemSummary.otherSpaces` projected by Cypher).
 *
 * Phase 0.5 discovery panel kept as a collapsible diagnostic at the
 * bottom of the page so the verification queries stay one click away
 * for the dev team without crowding out the production UX.
 *
 * Pure DOM-construction helpers (`buildSpaceRow`, `buildItemCard`,
 * `buildSpaceChip`, `buildDetailPane`) are exported via the
 * `__spacesRendererForTesting` window-global escape hatch so jsdom
 * tests can exercise them without booting the whole renderer. The
 * production code path uses the same functions internally.
 *
 * Built as an IIFE bundle by esbuild. Talks to the main process via
 * the preload bridge (`window.lite.spaces.*`).
 */

import { UNCATEGORIZED_SPACE_ID } from './scope.js';
import {
  discoveryResultsToMarkdown,
  type DiscoveryQueryResult,
  type DiscoveryResults,
} from './discovery-format.js';

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

// ─── State ──────────────────────────────────────────────────────────────

export type SpacesSortMode = 'name' | 'recent';

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
}

const state: SpacesRendererState = {
  activeScopeId: UNCATEGORIZED_SPACE_ID,
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
};

// ─── Bootstrap ──────────────────────────────────────────────────────────

function init(): void {
  applyActiveRow(state.activeScopeId);
  wireSidebarClicks();
  wireSidebarSearch();
  wireSidebarSort();
  wireDiscoveryPanel();
  void initialLoad();
}

async function initialLoad(): Promise<void> {
  await Promise.all([loadSpaces(), loadUncategorizedCount(), loadItems()]);
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
  // Switching scope clears the open detail rail.
  state.activeItemId = null;
  showDetailRail(false);
  void loadItems();
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

// ─── Discovery panel (unchanged from Phase 0.5) ─────────────────────────

function wireDiscoveryPanel(): void {
  const runBtn = document.getElementById('spaces-discovery-run');
  const copyBtn = document.getElementById('spaces-discovery-copy');
  if (runBtn instanceof HTMLButtonElement) {
    runBtn.addEventListener('click', () => void runDiscovery());
  }
  if (copyBtn instanceof HTMLButtonElement) {
    copyBtn.addEventListener('click', () => void copyMarkdown());
  }
}

async function runDiscovery(): Promise<void> {
  if (state.discoveryInFlight) return;
  state.discoveryInFlight = true;
  setRunButton({ busy: true });
  showDiscoverySummary({
    kind: 'info',
    text: 'Running Q1–Q4 against the configured Neon endpoint…',
  });
  clearDiscoveryResults();
  try {
    const bridge = window.lite?.spaces;
    if (bridge === undefined) {
      showDiscoverySummary({
        kind: 'failure',
        text: 'Spaces bridge is unavailable. Reload the window.',
      });
      return;
    }
    const envelope = await bridge.runDiscovery();
    if (envelope.ok === false) {
      showDiscoverySummary({
        kind: 'failure',
        text: `Discovery failed before any query ran: [${envelope.error.code}] ${envelope.error.message}`,
      });
      return;
    }
    const value = envelope.value as unknown as DiscoveryResults;
    state.lastDiscovery = value;
    renderDiscoveryResults(value);
    showDiscoverySummary(buildDiscoverySummary(value));
    setCopyButtonEnabled(true);
  } catch (err) {
    showDiscoverySummary({
      kind: 'failure',
      text: `Discovery threw at the bridge: ${messageFrom(err)}`,
    });
  } finally {
    state.discoveryInFlight = false;
    setRunButton({ busy: false });
  }
}

async function copyMarkdown(): Promise<void> {
  if (state.lastDiscovery === null) return;
  const md = discoveryResultsToMarkdown(state.lastDiscovery);
  try {
    await navigator.clipboard.writeText(md);
    flashCopyButton('Copied');
  } catch {
    flashCopyButton('Copy failed');
  }
}

function setRunButton(opts: { busy: boolean }): void {
  const runBtn = document.getElementById('spaces-discovery-run');
  if (!(runBtn instanceof HTMLButtonElement)) return;
  runBtn.disabled = opts.busy;
  runBtn.textContent = opts.busy ? 'Running…' : 'Run Discovery';
}

function setCopyButtonEnabled(enabled: boolean): void {
  const copyBtn = document.getElementById('spaces-discovery-copy');
  if (!(copyBtn instanceof HTMLButtonElement)) return;
  copyBtn.disabled = !enabled;
}

function flashCopyButton(label: string): void {
  const copyBtn = document.getElementById('spaces-discovery-copy');
  if (!(copyBtn instanceof HTMLButtonElement)) return;
  const original = copyBtn.textContent;
  copyBtn.textContent = label;
  setTimeout(() => {
    copyBtn.textContent = original;
  }, 1500);
}

type DiscoverySummaryKind = 'info' | 'success' | 'warning' | 'failure';

function showDiscoverySummary(opts: {
  kind: DiscoverySummaryKind;
  text: string;
}): void {
  const summary = document.getElementById('spaces-discovery-summary');
  if (summary === null) return;
  summary.hidden = false;
  summary.classList.remove('is-warning', 'is-failure');
  if (opts.kind === 'warning') summary.classList.add('is-warning');
  if (opts.kind === 'failure') summary.classList.add('is-failure');
  summary.textContent = opts.text;
}

function clearDiscoveryResults(): void {
  const container = document.getElementById('spaces-discovery-results');
  if (container !== null) container.replaceChildren();
}

function renderDiscoveryResults(results: DiscoveryResults): void {
  const container = document.getElementById('spaces-discovery-results');
  if (container === null) return;
  container.replaceChildren();
  for (const r of results.results) {
    container.appendChild(buildDiscoveryCard(r));
  }
}

function buildDiscoveryCard(r: DiscoveryQueryResult): HTMLElement {
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

function buildDiscoverySummary(results: DiscoveryResults): {
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
    state.activeScopeId = UNCATEGORIZED_SPACE_ID;
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
