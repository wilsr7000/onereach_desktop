/**
 * OAGI Store catalog renderer.
 *
 * Loaded into the catalog window (`idw-store.html`). Calls
 * `window.lite.neon.query(...)` to fetch the catalog from the OAGI
 * graph, `window.lite.idw.list()` to know what's already installed,
 * and `window.lite.idw.add(...)` to install a card.
 *
 * Subscribes to the `lite:idw:changed` IPC broadcast (re-exposed as
 * `window.lite.idw.onChange` in the preload) so install-state badges
 * stay live when the user adds/removes from the Settings -> IDWs
 * section in another window.
 *
 * Loaded as an external script (not inline) so the strict CSP
 * `script-src 'self'` allows execution.
 */

/// <reference path="../lite-window.d.ts" />

// File is a module so esbuild treats it as ESM input.
export {};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type Kind =
  | 'idw'
  | 'external-bot'
  | 'image-creator'
  | 'video-creator'
  | 'audio-generator'
  | 'ui-design-tool';

const KIND_ORDER: ReadonlyArray<Kind> = [
  'idw',
  'external-bot',
  'image-creator',
  'video-creator',
  'audio-generator',
  'ui-design-tool',
];

const KIND_LABEL: Readonly<Record<Kind, string>> = {
  idw: 'IDWs',
  'external-bot': 'External Bots',
  'image-creator': 'Image Creators',
  'video-creator': 'Video Creators',
  'audio-generator': 'Audio Generators',
  'ui-design-tool': 'UI Design Tools',
};

const KIND_LABEL_SINGULAR: Readonly<Record<Kind, string>> = {
  idw: 'IDW',
  'external-bot': 'External Bot',
  'image-creator': 'Image Creator',
  'video-creator': 'Video Creator',
  'audio-generator': 'Audio Generator',
  'ui-design-tool': 'UI Design Tool',
};

const KIND_DEFAULT_EMOJI: Readonly<Record<Kind, string>> = {
  idw: '\u{1F916}',
  'external-bot': '\u{1F4AC}',
  'image-creator': '\u{1F3A8}',
  'video-creator': '\u{1F3AC}',
  'audio-generator': '\u{1F3B5}',
  'ui-design-tool': '\u{1F58C}',
};

interface CatalogEntry {
  /** Graph node id (used as `storeMetadata.catalogId`). */
  id: string;
  kind: Kind;
  name: string;
  description: string;
  developer: string;
  category: string;
  url: string;
  apiUrl?: string;
  iconName?: string;
  thumbnailUrl?: string;
  version?: string;
  audioSubCategory?: 'music' | 'effects' | 'narration' | 'custom';
}

interface InstalledMap {
  /** catalogId -> { id, version } */
  byCatalogId: Map<string, { id: string; version: string | undefined }>;
}

let catalog: CatalogEntry[] = [];
let installed: InstalledMap = { byCatalogId: new Map() };
let activeKindFilter: Kind | 'all' = 'all';
let searchQuery = '';
let unsubscribeChange: (() => void) | null = null;
const installInflight = new Set<string>();

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function bootstrap(): void {
  const closeBtn = document.getElementById('close-btn');
  if (closeBtn !== null) {
    closeBtn.addEventListener('click', () => window.close());
  }

  const manageAgentsBtn = document.getElementById('manage-agents-btn');
  if (manageAgentsBtn !== null) {
    manageAgentsBtn.addEventListener('click', () => {
      if (window.lite?.settings?.open !== undefined) {
        void window.lite.settings.open('idws');
      } else {
        showToast('Manage Agents is unavailable. Restart the app to recover.', 'error');
      }
    });
  }

  const searchInput = document.getElementById('search-input') as HTMLInputElement | null;
  if (searchInput !== null) {
    searchInput.addEventListener('input', () => {
      searchQuery = searchInput.value.trim().toLowerCase();
      render();
    });
  }

  // Subscribe to live install-state updates from other windows.
  if (window.lite?.idw?.onChange !== undefined) {
    unsubscribeChange = window.lite.idw.onChange(() => {
      void refreshInstalled().then(() => render());
    });
  }
  window.addEventListener('beforeunload', () => {
    if (unsubscribeChange !== null) {
      try { unsubscribeChange(); } catch { /* best-effort */ }
      unsubscribeChange = null;
    }
  });

  void initialLoad();
}

async function initialLoad(): Promise<void> {
  const content = document.getElementById('content');
  if (content === null) return;
  // Show skeleton immediately so the empty pane doesn't flash.
  content.innerHTML = renderSkeleton();

  // 1. Check OAGI status before issuing the catalog query.
  const neon = window.lite?.neon;
  if (neon === undefined) {
    showError('OAGI bridge unavailable. Restart the app to recover.');
    return;
  }
  let status: LiteNeonStatus;
  try {
    status = await neon.status();
  } catch (err) {
    showError(`Could not read OAGI status: ${(err as Error).message}`);
    return;
  }
  if (!status.ready) {
    renderConfigureOagi();
    return;
  }

  // 2. Fetch installed list (so cards render with correct badges).
  await refreshInstalled();

  // 3. Fetch catalog from Neon. The query is tuned to fit inside the
  // Edison `/omnidata/neon` flow's ~29s server-side budget:
  //   - Multi-label match `(n:IDW|Agent)` uses label indexes (OR forces
  //     a full scan); requires Neo4j 5 (Aura default).
  //   - No `ORDER BY` -- sorting forces full materialization on the
  //     server; we sort alphabetically client-side below.
  //   - `LIMIT 500` is a safety cap so a runaway dataset can't blow the
  //     timeout. 500 fits a comfortable catalog page; raise once the
  //     Edison flow exposes pagination.
  try {
    const result = await neon.query(
      'MATCH (n:IDW|Agent) WHERE n.active = true OR n.active IS NULL RETURN n, labels(n) AS nodeLabels LIMIT 500',
      {}
    );
    const records: NeonRecordLike[] = (result.records ?? []) as NeonRecordLike[];
    catalog = records.map(mapRecordToEntry).filter((e): e is CatalogEntry => e !== null);
    catalog.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  } catch (err) {
    const parsed = neon.parseError(err);
    if (parsed !== null) {
      showError(`${parsed.message} ${parsed.remediation}`.trim());
    } else {
      showError(`OAGI query failed: ${(err as Error).message}`);
    }
    return;
  }

  // Build kind pills (now that we know counts), then render.
  buildKindPills();
  render();
}

async function refreshInstalled(): Promise<void> {
  if (window.lite?.idw === undefined) {
    installed = { byCatalogId: new Map() };
    return;
  }
  try {
    const list = await window.lite.idw.list();
    const map = new Map<string, { id: string; version: string | undefined }>();
    for (const entry of list) {
      const catalogId = entry.storeMetadata?.catalogId;
      if (typeof catalogId === 'string' && catalogId.length > 0) {
        map.set(catalogId, { id: entry.id, version: entry.storeMetadata?.version });
      }
    }
    installed = { byCatalogId: map };
  } catch {
    installed = { byCatalogId: new Map() };
  }
}

// ---------------------------------------------------------------------------
// Filters + render
// ---------------------------------------------------------------------------

function buildKindPills(): void {
  const container = document.getElementById('kind-pills');
  if (container === null) return;

  const counts = new Map<Kind, number>();
  for (const k of KIND_ORDER) counts.set(k, 0);
  for (const e of catalog) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);

  container.innerHTML = '';
  container.appendChild(buildPill('all', 'All', catalog.length));
  for (const k of KIND_ORDER) {
    const c = counts.get(k) ?? 0;
    if (c === 0) continue;
    container.appendChild(buildPill(k, KIND_LABEL[k], c));
  }
}

function buildPill(value: Kind | 'all', label: string, count: number): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'filter-pill';
  if (value === activeKindFilter) btn.classList.add('active');
  btn.dataset['kind'] = value;
  const labelSpan = document.createElement('span');
  labelSpan.textContent = label;
  btn.appendChild(labelSpan);
  const countSpan = document.createElement('span');
  countSpan.className = 'pill-count';
  countSpan.textContent = String(count);
  btn.appendChild(countSpan);
  btn.addEventListener('click', () => {
    activeKindFilter = value;
    // Re-render pills (swap active class) + content.
    buildKindPills();
    render();
  });
  return btn;
}

function render(): void {
  const content = document.getElementById('content');
  if (content === null) return;

  if (catalog.length === 0) {
    renderEmptyCatalog();
    return;
  }

  const visible = catalog.filter((e) => {
    if (activeKindFilter !== 'all' && e.kind !== activeKindFilter) return false;
    if (searchQuery.length === 0) return true;
    const haystack = `${e.name} ${e.description} ${e.developer} ${e.category}`.toLowerCase();
    return haystack.includes(searchQuery);
  });

  if (visible.length === 0) {
    content.innerHTML = `
      <div class="empty-state">
        <div class="empty-title">No agents match your filter</div>
        <div class="empty-body">Try a different search or clear the kind filter.</div>
      </div>
    `;
    return;
  }

  // Group visible entries by kind for section rendering.
  const byKind = new Map<Kind, CatalogEntry[]>();
  for (const k of KIND_ORDER) byKind.set(k, []);
  for (const e of visible) (byKind.get(e.kind) as CatalogEntry[]).push(e);

  const sections: string[] = [];
  for (const k of KIND_ORDER) {
    const items = byKind.get(k) ?? [];
    if (items.length === 0) continue;
    sections.push(renderSection(k, items));
  }

  content.innerHTML = sections.join('\n');

  // Wire install buttons.
  for (const btn of Array.from(content.querySelectorAll<HTMLButtonElement>('button.install-btn'))) {
    btn.addEventListener('click', () => {
      const catalogId = btn.dataset['catalogId'];
      if (typeof catalogId !== 'string') return;
      const entry = catalog.find((c) => c.id === catalogId);
      if (entry === undefined) return;
      void installFlow(entry, btn);
    });
  }
}

function renderSection(kind: Kind, items: CatalogEntry[]): string {
  const accent = `var(--accent-${kind})`;
  const cards = items.map((e) => renderCard(e)).join('\n');
  return `
    <div class="section-block">
      <div class="section-header">
        <span class="section-accent-bar" style="background:${accent};"></span>
        <span class="section-title">${escapeHtml(KIND_LABEL[kind])}</span>
        <span class="section-count">(${items.length})</span>
      </div>
      <div class="card-grid">${cards}</div>
    </div>
  `;
}

function renderCard(entry: CatalogEntry): string {
  const installedRecord = installed.byCatalogId.get(entry.id);
  const isInstalled = installedRecord !== undefined;
  const hasUpdate =
    isInstalled &&
    typeof entry.version === 'string' &&
    entry.version.length > 0 &&
    installedRecord?.version !== entry.version;

  const accent = `var(--accent-${entry.kind})`;
  const iconHtml =
    typeof entry.thumbnailUrl === 'string' && entry.thumbnailUrl.length > 0
      ? `<img class="card-icon-img" src="${escapeAttr(entry.thumbnailUrl)}" alt="" />`
      : `<span aria-hidden="true">${escapeHtml(KIND_DEFAULT_EMOJI[entry.kind])}</span>`;

  let actionHtml: string;
  if (isInstalled && !hasUpdate) {
    actionHtml = `
      <span class="card-status-badge installed" aria-label="Installed">
        <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 8l3.5 3.5L13 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        Installed
      </span>
    `;
  } else if (hasUpdate) {
    actionHtml = `
      <span class="card-status-badge update">Update available</span>
      <button type="button" class="btn-primary install-btn" data-catalog-id="${escapeAttr(entry.id)}">Update</button>
    `;
  } else {
    actionHtml = `<button type="button" class="btn-primary install-btn" data-catalog-id="${escapeAttr(entry.id)}">Add to my IDWs</button>`;
  }

  const developer =
    entry.developer.length > 0
      ? `<div class="card-developer">${escapeHtml(entry.developer)}</div>`
      : '';
  const category =
    entry.category.length > 0
      ? `<span class="pill pill-category">${escapeHtml(entry.category)}</span>`
      : '';

  return `
    <div class="card" data-catalog-id="${escapeAttr(entry.id)}">
      <div class="card-accent" style="--accent:${accent};"></div>
      <div class="card-body">
        <div class="card-head">
          <div class="card-icon">${iconHtml}</div>
          <div class="card-headtext">
            <div class="card-name">${escapeHtml(entry.name)}</div>
            ${developer}
          </div>
        </div>
        <div class="card-description">${escapeHtml(entry.description || `${KIND_LABEL_SINGULAR[entry.kind]} -- no description provided.`)}</div>
        <div class="card-meta">
          <span class="pill" data-kind="${entry.kind}">${escapeHtml(KIND_LABEL_SINGULAR[entry.kind])}</span>
          ${category}
        </div>
        <div class="card-actions">${actionHtml}</div>
      </div>
    </div>
  `;
}

function renderConfigureOagi(): void {
  const content = document.getElementById('content');
  if (content === null) return;
  content.innerHTML = `
    <div class="empty-state">
      <svg class="empty-illustration" viewBox="0 0 220 140" fill="none" aria-hidden="true">
        <rect x="14" y="20" width="192" height="100" rx="10" stroke="currentColor" stroke-width="1.5" opacity="0.4"/>
        <ellipse cx="110" cy="50" rx="34" ry="10" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
        <path d="M76 50V90C76 96 91 101 110 101C129 101 144 96 144 90V50" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
        <path d="M76 70C76 76 91 81 110 81C129 81 144 76 144 70" stroke="currentColor" stroke-width="1.5" opacity="0.4"/>
      </svg>
      <div class="empty-title">Connect to OAGI to browse your organization's agents</div>
      <div class="empty-body">
        OAGI is your Organization System Twin -- the data fabric that holds your organization's
        published IDWs and agents. Configure your OAGI connection in Settings and the catalog
        will populate here.
      </div>
      <div class="empty-actions">
        <button type="button" id="empty-configure" class="btn-primary">Configure OAGI</button>
      </div>
    </div>
  `;
  const btn = document.getElementById('empty-configure');
  if (btn !== null) {
    btn.addEventListener('click', () => {
      if (window.lite?.settings?.open !== undefined) {
        void window.lite.settings.open('oagi');
      }
    });
  }
}

function renderEmptyCatalog(): void {
  const content = document.getElementById('content');
  if (content === null) return;
  content.innerHTML = `
    <div class="empty-state">
      <svg class="empty-illustration" viewBox="0 0 220 140" fill="none" aria-hidden="true">
        <circle cx="110" cy="70" r="50" stroke="currentColor" stroke-width="1.5" opacity="0.35"/>
        <path d="M82 70h56M110 42v56" stroke="currentColor" stroke-width="1.5" opacity="0.5" stroke-linecap="round"/>
      </svg>
      <div class="empty-title">No agents in your organization's OAGI yet</div>
      <div class="empty-body">
        Ask your administrator to publish the first one. Or, while you wait, add a custom agent
        from Settings -> IDWs.
      </div>
      <div class="empty-actions">
        <button type="button" id="empty-open-settings" class="btn-secondary">Add a custom agent</button>
      </div>
    </div>
  `;
  const btn = document.getElementById('empty-open-settings');
  if (btn !== null) {
    btn.addEventListener('click', () => {
      if (window.lite?.settings?.open !== undefined) {
        void window.lite.settings.open('idws');
      }
    });
  }
}

function showError(message: string): void {
  const content = document.getElementById('content');
  if (content === null) return;
  content.innerHTML = `
    <div class="empty-state">
      <div class="empty-title">Could not load the catalog</div>
      <div class="banner error" style="margin-top:12px;">${escapeHtml(message)}</div>
    </div>
  `;
}

function renderSkeleton(): string {
  const cards: string[] = [];
  for (let i = 0; i < 6; i++) {
    cards.push(`
      <div class="skeleton-card">
        <div class="skeleton-bar skeleton-accent"></div>
        <div class="skeleton-bar skeleton-row"></div>
        <div class="skeleton-bar skeleton-row short"></div>
        <div class="skeleton-bar skeleton-row tall"></div>
        <div class="skeleton-bar skeleton-row short" style="margin-bottom:14px;"></div>
      </div>
    `);
  }
  return `<div class="skeleton-grid">${cards.join('')}</div>`;
}

// ---------------------------------------------------------------------------
// Install flow
// ---------------------------------------------------------------------------

async function installFlow(entry: CatalogEntry, btn: HTMLButtonElement): Promise<void> {
  if (window.lite?.idw === undefined) {
    showToast('IDW bridge unavailable.', 'error');
    return;
  }
  if (installInflight.has(entry.id)) return;
  installInflight.add(entry.id);
  const originalLabel = btn.textContent ?? 'Add';
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>Installing...</span>`;
  try {
    const storeMetadata: LiteIdwStoreMetadata = {
      catalogId: entry.id,
      installedAt: new Date().toISOString(),
    };
    if (typeof entry.developer === 'string' && entry.developer.length > 0) {
      storeMetadata.developer = entry.developer;
    }
    if (typeof entry.version === 'string' && entry.version.length > 0) {
      storeMetadata.version = entry.version;
    }
    const payload: LiteIdwAddInput = {
      kind: entry.kind,
      label: entry.name,
      url: entry.url,
      source: 'store',
      description: entry.description,
      category: entry.category,
      storeMetadata,
    };
    if (typeof entry.iconName === 'string' && entry.iconName.length > 0) {
      payload.iconName = entry.iconName;
    }
    if (typeof entry.thumbnailUrl === 'string' && entry.thumbnailUrl.length > 0) {
      payload.thumbnailUrl = entry.thumbnailUrl;
    }
    if (typeof entry.apiUrl === 'string' && entry.apiUrl.length > 0) {
      payload.apiUrl = entry.apiUrl;
    }
    if (entry.kind === 'audio-generator' && entry.audioSubCategory !== undefined) {
      payload.audio = { subCategory: entry.audioSubCategory };
    }
    const result = await window.lite.idw.add(payload);
    showToast(
      result.wasUpdate ? `Updated: ${entry.name}` : `Installed: ${entry.name}`,
      'success'
    );
    await refreshInstalled();
    render();
  } catch (err) {
    const parsed = window.lite?.idw?.parseError !== undefined ? window.lite.idw.parseError(err) : null;
    const msg = parsed !== null ? `${parsed.message} ${parsed.remediation}`.trim() : (err as Error).message;
    showToast(msg, 'error');
    btn.disabled = false;
    btn.textContent = originalLabel;
  } finally {
    installInflight.delete(entry.id);
  }
}

// ---------------------------------------------------------------------------
// Toast helpers
// ---------------------------------------------------------------------------

function showToast(message: string, kind: 'success' | 'error' | 'info'): void {
  const stack = document.getElementById('toast-stack');
  if (stack === null) return;
  const toast = document.createElement('div');
  toast.className = `toast ${kind}`;
  toast.textContent = message;
  stack.appendChild(toast);
  // Trigger transition after attach.
  window.setTimeout(() => toast.classList.add('show'), 16);
  // Auto-dismiss after 3s.
  window.setTimeout(() => {
    toast.classList.remove('show');
    window.setTimeout(() => {
      if (toast.parentNode === stack) stack.removeChild(toast);
    }, 220);
  }, 3000);
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

interface NeonRecordLike {
  n?: { id?: unknown; labels?: unknown; properties?: unknown };
  nodeLabels?: unknown;
}

function mapRecordToEntry(record: NeonRecordLike): CatalogEntry | null {
  const node = record.n;
  if (node === undefined || node === null || typeof node !== 'object') return null;
  const props = (node as { properties?: unknown }).properties;
  if (props === undefined || props === null || typeof props !== 'object') return null;
  const p = props as Record<string, unknown>;

  // Determine kind: explicit `kind` property wins; fallback to label
  // (`IDW` -> 'idw', `Agent` -> 'external-bot' default).
  const labels = Array.isArray(record.nodeLabels) ? (record.nodeLabels as string[]) : [];
  const explicitKind = typeof p['kind'] === 'string' ? (p['kind'] as string) : null;
  const kind = normalizeKind(explicitKind, labels);
  if (kind === null) return null;

  const id =
    typeof p['id'] === 'string'
      ? (p['id'] as string)
      : typeof (node as { id?: unknown }).id === 'string'
        ? ((node as { id: string }).id)
        : '';
  if (id.length === 0) return null;

  const url =
    typeof p['url'] === 'string' && (p['url'] as string).length > 0
      ? (p['url'] as string)
      : typeof p['chatUrl'] === 'string' && (p['chatUrl'] as string).length > 0
        ? (p['chatUrl'] as string)
        : '';
  if (url.length === 0) return null;

  const name = typeof p['name'] === 'string' ? (p['name'] as string) : id;
  const description = typeof p['description'] === 'string' ? (p['description'] as string) : '';
  const developer = typeof p['developer'] === 'string' ? (p['developer'] as string) : '';
  const category = typeof p['category'] === 'string' ? (p['category'] as string) : '';
  const apiUrl = typeof p['apiEndpoint'] === 'string' ? (p['apiEndpoint'] as string) : undefined;
  const iconName = typeof p['iconName'] === 'string' ? (p['iconName'] as string) : undefined;
  const thumbnailUrl =
    typeof p['thumbnailUrl'] === 'string'
      ? (p['thumbnailUrl'] as string)
      : typeof p['imageUrl'] === 'string'
        ? (p['imageUrl'] as string)
        : undefined;
  const version = typeof p['version'] === 'string' ? (p['version'] as string) : undefined;
  const audioSubRaw = typeof p['audioSubCategory'] === 'string' ? (p['audioSubCategory'] as string) : undefined;
  const audioSubCategory =
    audioSubRaw === 'music' || audioSubRaw === 'effects' || audioSubRaw === 'narration' || audioSubRaw === 'custom'
      ? audioSubRaw
      : undefined;

  const entry: CatalogEntry = {
    id,
    kind,
    name,
    description,
    developer,
    category,
    url,
  };
  if (apiUrl !== undefined) entry.apiUrl = apiUrl;
  if (iconName !== undefined) entry.iconName = iconName;
  if (thumbnailUrl !== undefined) entry.thumbnailUrl = thumbnailUrl;
  if (version !== undefined) entry.version = version;
  if (audioSubCategory !== undefined) entry.audioSubCategory = audioSubCategory;
  return entry;
}

function normalizeKind(explicit: string | null, labels: string[]): Kind | null {
  if (explicit !== null && (KIND_ORDER as readonly string[]).includes(explicit)) {
    return explicit as Kind;
  }
  if (labels.includes('IDW')) return 'idw';
  if (labels.includes('Agent')) return 'external-bot';
  return null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
