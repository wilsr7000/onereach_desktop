/**
 * Download → Save to Space picker — renderer entry point.
 *
 * Runs inside the dedicated picker BrowserWindow spawned by
 * `picker-window.ts`. The window URL carries `?dl=<downloadId>` so this
 * renderer knows which captured download to bootstrap against.
 *
 * Flow:
 *   1. Read `?dl=` from `window.location.search`.
 *   2. Call `window.lite.downloadPicker.bootstrap(downloadId)` to fetch
 *      the captured-file summary + spaces list (+ default pick).
 *   3. Render the file card and the searchable spaces list.
 *   4. Wire mouse + keyboard selection.
 *   5. On Save  -> `resolve(downloadId, { spaceId, spaceName })`.
 *      On Cancel/Esc/close -> `resolve(downloadId, null)`.
 *
 * No SDK access here -- everything goes through the preload bridge
 * (`window.lite.downloadPicker.*`). Renderer has zero Node integration.
 */

/// <reference path="../lite-window.d.ts" />

type PickerSpaceView = {
  id: string;
  name: string;
  color?: string;
  itemCount?: number;
};

type PickerBootstrapView = {
  download: {
    fileName: string;
    mimeType: string;
    kind:
      | 'document'
      | 'image'
      | 'url'
      | 'text'
      | 'audio'
      | 'video'
      | 'other';
    totalBytes: number;
    source: string;
  };
  spaces: PickerSpaceView[];
  defaultSpaceId?: string;
};

type PickerResultView = {
  spaceId: string;
  spaceName: string;
};

interface LiteDownloadPickerBridge {
  bootstrap(downloadId: string): Promise<PickerBootstrapView>;
  resolve(downloadId: string, result: PickerResultView | null): Promise<{ ok: true }>;
}

interface LiteWindowWithPicker {
  downloadPicker?: LiteDownloadPickerBridge;
}

// ─── Bootstrap ─────────────────────────────────────────────────────────────

const downloadId = readDownloadIdFromQuery();
let allSpaces: PickerSpaceView[] = [];
let filteredSpaces: PickerSpaceView[] = [];
let selectedSpaceId: string | null = null;
let downloadFileName = '';
/** Guarded so we only resolve once -- multiple click paths converge here. */
let didResolve = false;

const els = {
  sub: document.getElementById('picker-sub') as HTMLElement | null,
  fileName: document.getElementById('picker-file-name') as HTMLElement | null,
  fileMeta: document.getElementById('picker-file-meta-line') as HTMLElement | null,
  fileKind: document.getElementById('picker-file-kind') as HTMLElement | null,
  search: document.getElementById('picker-search') as HTMLInputElement | null,
  list: document.getElementById('picker-list') as HTMLElement | null,
  empty: document.getElementById('picker-list-empty') as HTMLElement | null,
  error: document.getElementById('picker-error') as HTMLElement | null,
  cancelBtn: document.getElementById('picker-cancel') as HTMLButtonElement | null,
  saveBtn: document.getElementById('picker-save') as HTMLButtonElement | null,
};

void boot();

async function boot(): Promise<void> {
  // Wire static handlers first so user clicks during a slow bootstrap
  // still get treated as a cancel (rather than appear inert).
  wireStaticHandlers();

  if (downloadId === null) {
    showFatal('No download id provided to the picker window.');
    return;
  }

  const bridge = getBridge();
  if (bridge === null) {
    showFatal(
      'Picker bridge unavailable. The preload script may have failed to load.'
    );
    return;
  }

  try {
    const bootstrap = await bridge.bootstrap(downloadId);
    renderBootstrap(bootstrap);
  } catch (err) {
    showFatal(
      `Failed to load picker data: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function readDownloadIdFromQuery(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const dl = params.get('dl');
    return dl !== null && dl.length > 0 ? dl : null;
  } catch {
    return null;
  }
}

function getBridge(): LiteDownloadPickerBridge | null {
  const lite = (window as unknown as { lite?: LiteWindowWithPicker }).lite;
  if (lite === undefined) return null;
  return lite.downloadPicker ?? null;
}

// ─── Rendering ─────────────────────────────────────────────────────────────

function renderBootstrap(payload: PickerBootstrapView): void {
  downloadFileName = payload.download.fileName;
  allSpaces = payload.spaces;
  filteredSpaces = allSpaces;
  selectedSpaceId =
    payload.defaultSpaceId !== undefined && hasSpace(payload.defaultSpaceId)
      ? payload.defaultSpaceId
      : (allSpaces[0]?.id ?? null);

  renderFileCard(payload.download);
  renderList();
  updateSaveButton();

  if (els.search !== null) {
    els.search.focus();
  }
}

function renderFileCard(d: PickerBootstrapView['download']): void {
  if (els.fileName !== null) {
    els.fileName.textContent = d.fileName;
    els.fileName.title = d.fileName;
  }
  if (els.fileKind !== null) {
    els.fileKind.textContent = labelForKind(d.kind);
  }
  if (els.fileMeta !== null) {
    const sizeText = d.totalBytes > 0 ? formatBytes(d.totalBytes) : 'Unknown size';
    const mimeText = d.mimeType.length > 0 ? d.mimeType : 'application/octet-stream';
    els.fileMeta.textContent = `${sizeText} · ${mimeText} · from ${d.source}`;
  }
  if (els.sub !== null) {
    els.sub.textContent = 'Captured download — pick a destination';
  }
}

function renderList(): void {
  const list = els.list;
  const empty = els.empty;
  if (list === null) return;

  // Always clear children before re-rendering. Cheap for <= a few
  // hundred spaces, which is well above any realistic account.
  list.innerHTML = '';

  if (filteredSpaces.length === 0) {
    if (empty !== null) {
      empty.textContent =
        allSpaces.length === 0
          ? 'No spaces available. Create one in the Spaces window first.'
          : 'No spaces match your search.';
      list.appendChild(empty);
    }
    return;
  }

  for (const sp of filteredSpaces) {
    const row = document.createElement('div');
    row.className = 'picker-list-row';
    row.setAttribute('role', 'option');
    row.dataset['spaceId'] = sp.id;
    if (sp.id === selectedSpaceId) {
      row.classList.add('is-active');
      row.setAttribute('aria-selected', 'true');
    }

    const dot = document.createElement('span');
    dot.className = 'picker-list-dot';
    if (typeof sp.color === 'string' && sp.color.length > 0) {
      dot.style.background = sp.color;
    }

    const name = document.createElement('span');
    name.className = 'picker-list-name';
    name.textContent = sp.name;
    name.title = sp.name;

    const count = document.createElement('span');
    count.className = 'picker-list-count';
    if (typeof sp.itemCount === 'number' && sp.itemCount >= 0) {
      count.textContent = String(sp.itemCount);
    }

    row.appendChild(dot);
    row.appendChild(name);
    row.appendChild(count);

    row.addEventListener('click', () => selectSpace(sp.id));
    row.addEventListener('dblclick', () => {
      selectSpace(sp.id);
      void confirmSave();
    });

    list.appendChild(row);
  }
}

function selectSpace(spaceId: string): void {
  if (spaceId === selectedSpaceId) return;
  selectedSpaceId = spaceId;
  // Update only the affected rows without rebuilding the entire list,
  // so the user's scroll position is preserved on long space lists.
  const rows = els.list?.querySelectorAll<HTMLElement>('.picker-list-row');
  if (rows === undefined) return;
  rows.forEach((row) => {
    const isMatch = row.dataset['spaceId'] === spaceId;
    row.classList.toggle('is-active', isMatch);
    if (isMatch) {
      row.setAttribute('aria-selected', 'true');
    } else {
      row.removeAttribute('aria-selected');
    }
  });
  updateSaveButton();
}

function updateSaveButton(): void {
  if (els.saveBtn === null) return;
  els.saveBtn.disabled = selectedSpaceId === null;
}

function hasSpace(id: string): boolean {
  return allSpaces.some((sp) => sp.id === id);
}

function findSpace(id: string): PickerSpaceView | undefined {
  return allSpaces.find((sp) => sp.id === id);
}

// ─── User input ────────────────────────────────────────────────────────────

function wireStaticHandlers(): void {
  if (els.search !== null) {
    els.search.addEventListener('input', onSearchChange);
  }
  if (els.cancelBtn !== null) {
    els.cancelBtn.addEventListener('click', () => {
      void cancel();
    });
  }
  if (els.saveBtn !== null) {
    els.saveBtn.addEventListener('click', () => {
      void confirmSave();
    });
  }

  // Global keyboard shortcuts: Esc cancels, Enter confirms (when a
  // space is selected), Arrow up/down navigates the list. Wiring at
  // the document level so the shortcuts work regardless of which
  // element has focus (search box, list, button).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      void cancel();
      return;
    }
    if (e.key === 'Enter') {
      // Only treat Enter as Save when a space is selected AND the
      // event didn't originate on the Cancel button (where Enter
      // means "cancel"). The Save button's own click handler covers
      // the case where Save itself is focused.
      const target = e.target as HTMLElement | null;
      if (target?.id === 'picker-cancel') return;
      if (selectedSpaceId !== null) {
        e.preventDefault();
        void confirmSave();
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // Skip nav when focus is on the buttons — let native focus
      // movement handle that.
      const target = e.target as HTMLElement | null;
      if (
        target?.id === 'picker-cancel' ||
        target?.id === 'picker-save'
      ) {
        return;
      }
      e.preventDefault();
      moveSelection(e.key === 'ArrowDown' ? 1 : -1);
    }
  });
}

function onSearchChange(): void {
  const q = (els.search?.value ?? '').trim().toLowerCase();
  if (q.length === 0) {
    filteredSpaces = allSpaces;
  } else {
    filteredSpaces = allSpaces.filter((sp) =>
      sp.name.toLowerCase().includes(q)
    );
  }

  // Keep the current selection if it's still in the filtered set;
  // otherwise pick the first visible row so Enter still works.
  if (
    selectedSpaceId === null ||
    !filteredSpaces.some((sp) => sp.id === selectedSpaceId)
  ) {
    selectedSpaceId = filteredSpaces[0]?.id ?? null;
  }

  renderList();
  updateSaveButton();
}

function moveSelection(delta: 1 | -1): void {
  if (filteredSpaces.length === 0) return;
  const idx =
    selectedSpaceId === null
      ? -1
      : filteredSpaces.findIndex((sp) => sp.id === selectedSpaceId);
  let next = idx + delta;
  if (next < 0) next = filteredSpaces.length - 1;
  if (next >= filteredSpaces.length) next = 0;
  const target = filteredSpaces[next];
  if (target === undefined) return;
  selectSpace(target.id);

  // Make sure the newly-selected row is visible in the scroll
  // viewport. Cheap enough to call on every key.
  const row = els.list?.querySelector<HTMLElement>(
    `.picker-list-row[data-space-id="${cssEscape(target.id)}"]`
  );
  row?.scrollIntoView({ block: 'nearest' });
}

// ─── Resolve ───────────────────────────────────────────────────────────────

async function confirmSave(): Promise<void> {
  if (didResolve) return;
  if (selectedSpaceId === null) return;
  const space = findSpace(selectedSpaceId);
  if (space === undefined) return;
  didResolve = true;
  setBusy(true);
  const bridge = getBridge();
  if (bridge === null || downloadId === null) {
    showError('Picker bridge unavailable.');
    didResolve = false;
    setBusy(false);
    return;
  }
  try {
    await bridge.resolve(downloadId, {
      spaceId: space.id,
      spaceName: space.name,
    });
    // Main process closes the window on resolve; no need to do anything
    // here. Leave the busy state up so any frame between resolve and
    // window-destroy shows the in-flight UI.
  } catch (err) {
    didResolve = false;
    setBusy(false);
    showError(
      `Failed to save: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function cancel(): Promise<void> {
  if (didResolve) return;
  didResolve = true;
  const bridge = getBridge();
  if (bridge === null || downloadId === null) {
    // No bridge means we can't tell main anything; just close the
    // window. Main's `closed` handler will treat the close as a cancel.
    window.close();
    return;
  }
  try {
    await bridge.resolve(downloadId, null);
  } catch {
    // best-effort -- worst case main never hears the resolve, but the
    // window's `closed` handler will fire on close() anyway.
  }
  window.close();
}

function setBusy(busy: boolean): void {
  if (els.saveBtn !== null) {
    els.saveBtn.disabled = busy || selectedSpaceId === null;
    els.saveBtn.textContent = busy ? 'Saving…' : 'Save';
  }
  if (els.cancelBtn !== null) {
    els.cancelBtn.disabled = busy;
  }
  if (els.search !== null) {
    els.search.disabled = busy;
  }
}

function showError(message: string): void {
  if (els.error === null) return;
  els.error.textContent = message;
  els.error.hidden = false;
}

function showFatal(message: string): void {
  showError(message);
  if (els.saveBtn !== null) els.saveBtn.disabled = true;
  if (els.search !== null) els.search.disabled = true;
  // Override the file-name placeholder so the user isn't left looking
  // at "Loading…" when the bootstrap fails. Use the captured filename
  // when we have it; otherwise leave the placeholder out entirely.
  if (els.fileName !== null && downloadFileName.length === 0) {
    els.fileName.textContent = 'Captured file';
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function labelForKind(kind: PickerBootstrapView['download']['kind']): string {
  switch (kind) {
    case 'document':
      return 'DOC';
    case 'image':
      return 'IMG';
    case 'url':
      return 'URL';
    case 'text':
      return 'TXT';
    case 'audio':
      return 'AUD';
    case 'video':
      return 'VID';
    default:
      return 'FILE';
  }
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  // Two decimals for KB+ so size jumps look readable; integer for
  // raw bytes to avoid "342.00 B".
  const formatted = i === 0 ? String(Math.round(v)) : v.toFixed(2);
  return `${formatted} ${units[i] ?? 'B'}`;
}

/**
 * Lightweight CSS.escape() polyfill for the small subset of
 * characters that show up in space ids (uuids, slugs). Modern
 * Electron supports CSS.escape natively; this guards the test/
 * sandbox renderers that may not.
 */
function cssEscape(value: string): string {
  if (typeof (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS?.escape === 'function') {
    return (
      globalThis as { CSS: { escape: (v: string) => string } }
    ).CSS.escape(value);
  }
  return value.replace(/(["\\\[\]])/g, '\\$1');
}
