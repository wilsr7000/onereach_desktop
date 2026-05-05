/**
 * Bug-report modal renderer logic. Runs in the bug-report-modal
 * BrowserWindow (separate window from the main placeholder).
 *
 * Communicates with the main process via the preload-exposed bridge
 * `window.bugReport` (declared in lite/preload-lite.ts).
 *
 * Per ADR-008, redaction is mandatory and runs BEFORE the user sees
 * the payload. The payload preview shown here is already redacted.
 */

// This file is a module (the trailing `export {}` ensures it).
export {};

interface BugReportSummary {
  filePath: string;
  filename: string;
  timestamp: string;
  version: string;
  descriptionPreview: string;
  redactionBucket: 'none' | 'low' | 'medium' | 'high';
  redactionTotalCount: number;
  bytes: number;
  status: 'open' | 'resolved';
  hasNotes: boolean;
}

interface BugReportPayload {
  schemaVersion: number;
  timestamp: string;
  appTag: 'lite';
  source: string;
  version: string;
  os: { platform: string; release: string; arch: string };
  description: string;
  recentLogs: string;
  redactionTelemetry: { bucket: string; countsByKind: Record<string, number> };
  status: 'open' | 'resolved';
  notes: string;
  lastModified: string;
}

interface BugReportUpdateResult {
  payload: BugReportPayload;
  kvUpdated: boolean;
  kvError: string | null;
}

interface BugReportDeleteResult {
  kvDeleted: boolean;
  kvError: string | null;
}

interface BugReportSaveResult {
  kvWritten: boolean;
  kvError: string | null;
}

interface BugReportBridge {
  capture(userDescription: string): Promise<{
    payload: unknown;
    payloadJson: string;
    redactionStatus: 'none' | 'low' | 'medium' | 'high';
    redactionTotalCount: number;
  }>;
  save(userDescription: string): Promise<BugReportSaveResult>;
  close(): void;
  list(): Promise<BugReportSummary[]>;
  read(idOrPath: string): Promise<BugReportPayload>;
  update(timestamp: string, updates: { status?: 'open' | 'resolved'; notes?: string }): Promise<BugReportUpdateResult>;
  delete(timestamp: string): Promise<BugReportDeleteResult>;
}

// `window.lite` is declared in lite/lite-window.d.ts (shared with
// lite/placeholder.ts to avoid a TS declaration-merge conflict). We
// only declare `window.bugReport` here -- this is the only file that
// uses it so no merge conflict can arise.
/// <reference path="../lite-window.d.ts" />

declare global {
  interface Window {
    bugReport: BugReportBridge;
  }
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`Element #${id} not found`);
  return el as T;
};

const descriptionInput = $<HTMLTextAreaElement>('description');
const payloadPreview = $<HTMLPreElement>('payload-preview');
const redactionStatus = $<HTMLSpanElement>('redaction-status');
const sendBtn = $<HTMLButtonElement>('send');
const cancelBtn = $<HTMLButtonElement>('cancel');
const resultDiv = $<HTMLDivElement>('result');
const reportsCount = $<HTMLSpanElement>('reports-count');
const reportsCountNoun = $<HTMLSpanElement>('reports-count-noun');
const reportsList = $<HTMLUListElement>('reports-list');
const reportsRefreshBtn = $<HTMLButtonElement>('reports-refresh');
const searchInput = $<HTMLInputElement>('reports-search');

/** HTML escape -- safe for renderer interpolation since CSP disallows inline. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let captureDebounce: number | null = null;

async function refreshPreview(): Promise<void> {
  const desc = descriptionInput.value;
  try {
    const result = await window.bugReport.capture(desc);
    payloadPreview.textContent = result.payloadJson;
    if (result.redactionTotalCount === 0) {
      redactionStatus.textContent = 'no secrets detected';
      redactionStatus.classList.remove('has-redactions');
      redactionStatus.classList.add('no-redactions');
    } else {
      redactionStatus.textContent = `${result.redactionTotalCount} pattern${result.redactionTotalCount === 1 ? '' : 's'} masked (${result.redactionStatus})`;
      redactionStatus.classList.add('has-redactions');
      redactionStatus.classList.remove('no-redactions');
    }
  } catch (err) {
    payloadPreview.textContent = `(failed to load preview: ${(err as Error).message})`;
  }
}

function scheduleRefresh(): void {
  if (captureDebounce !== null) {
    window.clearTimeout(captureDebounce);
  }
  captureDebounce = window.setTimeout(() => {
    captureDebounce = null;
    void refreshPreview();
  }, 200);
}

descriptionInput.addEventListener('input', scheduleRefresh);

sendBtn.addEventListener('click', async () => {
  sendBtn.disabled = true;
  cancelBtn.disabled = true;
  try {
    await window.bugReport.save(descriptionInput.value);
    resultDiv.textContent = 'Bug report sent. Thanks.';
    resultDiv.classList.remove('hidden', 'error');
    // Refresh the list so the user immediately sees their just-filed report
    void refreshReportsList();
    // Auto-close after a beat so the user sees the success message
    window.setTimeout(() => window.bugReport.close(), 2500);
  } catch (err) {
    resultDiv.textContent = `Save failed: ${(err as Error).message}`;
    resultDiv.classList.remove('hidden');
    resultDiv.classList.add('error');
    sendBtn.disabled = false;
    cancelBtn.disabled = false;
  }
});

cancelBtn.addEventListener('click', () => {
  window.bugReport.close();
});

// No keyboard shortcuts (per .cursorrules "Keyboard Shortcuts" policy).
// Cancel and Send are reachable via mouse / button focus only until the
// user explicitly asks for shortcuts.

// ---------------------------------------------------------------------------
// Previous reports list
// ---------------------------------------------------------------------------

let cachedSummaries: BugReportSummary[] = [];

function formatTimestamp(iso: string): string {
  // Best-effort: show as local time, or fall back to raw ISO.
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Cache the raw summaries; render derives from this + current search query.
 */
function setSummaries(summaries: BugReportSummary[]): void {
  cachedSummaries = summaries;
  rerender();
}

function rerender(): void {
  const query = searchInput.value.trim().toLowerCase();
  const filtered = query === '' ? cachedSummaries : cachedSummaries.filter(matchesQuery(query));

  // Header count reflects FILTERED total when searching, raw total otherwise.
  reportsCount.textContent = String(filtered.length);
  reportsCountNoun.textContent = filtered.length === 1 ? 'report' : 'reports';

  if (cachedSummaries.length === 0) {
    reportsList.innerHTML =
      '<li class="reports-empty">No reports yet. Be the first to file one below.</li>';
    return;
  }
  if (filtered.length === 0) {
    reportsList.innerHTML = `<li class="reports-empty">No matches for "${esc(query)}". Try a different search, or file a new bug below.</li>`;
    return;
  }
  reportsList.innerHTML = filtered.map(renderRow).join('');
}

function matchesQuery(query: string): (s: BugReportSummary) => boolean {
  return (s) => {
    if (s.descriptionPreview.toLowerCase().includes(query)) return true;
    if (s.status.toLowerCase().includes(query)) return true;
    if (s.version.toLowerCase().includes(query)) return true;
    if (s.timestamp.toLowerCase().includes(query)) return true;
    return false;
  };
}

function renderRow(s: BugReportSummary): string {
  const preview = s.descriptionPreview.trim() === '' ? '(no description)' : s.descriptionPreview;
  const truncated = s.descriptionPreview.length === 100 ? '...' : '';
  const redactionBadge =
    s.redactionTotalCount > 0
      ? `<span class="report-redaction bucket-${s.redactionBucket}">${s.redactionTotalCount} masked</span>`
      : `<span class="report-redaction bucket-none">clean</span>`;
  const statusBadge = `<span class="report-status status-${s.status}">${s.status}</span>`;
  const notesMarker = s.hasNotes ? `<span class="report-notes-marker">notes</span>` : '';
  return `
    <li data-path="${esc(s.filePath)}" data-timestamp="${esc(s.timestamp)}">
      <div class="report-meta">
        <span class="report-meta-time">${esc(formatTimestamp(s.timestamp))}</span>
        <span class="report-badges">${statusBadge}${redactionBadge}</span>
      </div>
      <div class="report-preview">${esc(preview)}${truncated}</div>
      <div class="report-meta" style="margin-top:6px;margin-bottom:0">
        <span class="report-meta-aux">v${esc(s.version)} - ${formatBytes(s.bytes)}</span>
        ${notesMarker}
      </div>
    </li>
  `;
}

/**
 * Backward-compatible alias used by the dual-phase load logic below.
 * Now defers to setSummaries which preserves the current search filter.
 */
function renderReportsList(summaries: BugReportSummary[]): void {
  setSummaries(summaries);
}

// Re-render on search input. Throttling not needed for typical list sizes.
searchInput.addEventListener('input', () => {
  rerender();
});

searchInput.addEventListener('keydown', (e) => {
  // Escape clears the search rather than closing the modal -- only close
  // if search is already empty.
  if (e.key === 'Escape' && searchInput.value !== '') {
    e.stopPropagation();
    searchInput.value = '';
    rerender();
  }
});

reportsList.addEventListener('click', async (e) => {
  const target = e.target as HTMLElement;
  // Don't react to clicks that originated inside an expanded section.
  // The expanded region's children handle their own events; clicking on
  // them shouldn't toggle the row closed.
  if (target.closest('.report-expanded') !== null) {
    return;
  }
  const li = target.closest('li[data-path]') as HTMLLIElement | null;
  if (li === null) return;
  const filePath = li.getAttribute('data-path');
  const timestamp = li.getAttribute('data-timestamp');
  if (filePath === null || filePath === '' || timestamp === null) return;

  // Toggle: if already expanded, close it.
  const existing = li.querySelector('.report-expanded');
  if (existing !== null) {
    existing.remove();
    return;
  }

  await expandRow(li, filePath, timestamp);
});

/** Build a small element with a label + content slot. */
function section(labelText: string, contentEl: HTMLElement): HTMLDivElement {
  const wrap = document.createElement('div');
  const label = document.createElement('div');
  label.className = 'expanded-section-label';
  label.textContent = labelText;
  wrap.appendChild(label);
  wrap.appendChild(contentEl);
  return wrap;
}

async function expandRow(li: HTMLLIElement, filePath: string, timestamp: string): Promise<void> {
  let payload: BugReportPayload;
  try {
    payload = await window.bugReport.read(filePath);
  } catch (err) {
    const errEl = document.createElement('div');
    errEl.className = 'report-expanded';
    errEl.textContent = `(failed to load: ${(err as Error).message})`;
    li.appendChild(errEl);
    return;
  }

  const expanded = document.createElement('div');
  expanded.className = 'report-expanded';

  // -- Description (full text, not truncated) --
  const descEl = document.createElement('div');
  if (payload.description.trim() === '') {
    descEl.className = 'expanded-description empty';
    descEl.textContent = '(no description provided)';
  } else {
    descEl.className = 'expanded-description';
    descEl.textContent = payload.description;
  }
  expanded.appendChild(section('Description', descEl));

  // -- Notes editor --
  const notesWrap = document.createElement('div');
  notesWrap.className = 'report-notes-editor';
  const notesInput = document.createElement('textarea');
  notesInput.value = payload.notes;
  notesInput.placeholder = 'Add triage notes (saves on blur, redacted)...';
  const saveStatus = document.createElement('div');
  saveStatus.className = 'notes-save-status';
  saveStatus.textContent = '';
  notesInput.addEventListener('blur', async () => {
    if (notesInput.value === payload.notes) {
      saveStatus.textContent = '';
      saveStatus.className = 'notes-save-status';
      return;
    }
    notesInput.disabled = true;
    saveStatus.textContent = 'Saving...';
    saveStatus.className = 'notes-save-status';
    try {
      const result = await window.bugReport.update(timestamp, { notes: notesInput.value });
      payload.notes = result.payload.notes;
      notesInput.value = result.payload.notes;
      saveStatus.textContent = 'Saved';
      saveStatus.className = 'notes-save-status saved';
      void refreshReportsList();
      window.setTimeout(() => {
        if (saveStatus.textContent === 'Saved') {
          saveStatus.textContent = '';
          saveStatus.className = 'notes-save-status';
        }
      }, 2500);
    } catch (err) {
      saveStatus.textContent = `Save failed: ${(err as Error).message}`;
      saveStatus.className = 'notes-save-status error';
    } finally {
      notesInput.disabled = false;
    }
  });
  notesWrap.appendChild(notesInput);
  notesWrap.appendChild(saveStatus);
  expanded.appendChild(section('Notes', notesWrap));

  // -- Recent logs (only if non-empty) --
  if (payload.recentLogs.trim() !== '') {
    const logsEl = document.createElement('pre');
    logsEl.className = 'expanded-logs';
    logsEl.textContent = payload.recentLogs;
    expanded.appendChild(section('Recent logs (redacted)', logsEl));
  }

  // -- Metadata strip --
  const metaGrid = document.createElement('dl');
  metaGrid.className = 'expanded-meta-grid';
  const metaRows: Array<[string, string]> = [
    ['Filed', formatTimestamp(payload.timestamp)],
    ['Modified', formatTimestamp(payload.lastModified)],
    ['Version', `v${payload.version}`],
    ['OS', `${payload.os.platform} ${payload.os.release} (${payload.os.arch})`],
    ['Status', payload.status],
  ];
  for (const [k, v] of metaRows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    metaGrid.appendChild(dt);
    metaGrid.appendChild(dd);
  }
  expanded.appendChild(section('Details', metaGrid));

  // -- Action toolbar --
  const actions = document.createElement('div');
  actions.className = 'report-detail-actions';

  const statusBtn = document.createElement('button');
  statusBtn.className = 'ghost';
  statusBtn.type = 'button';
  const renderStatusLabel = (): void => {
    statusBtn.textContent = payload.status === 'open' ? 'Mark Resolved' : 'Reopen';
  };
  renderStatusLabel();
  statusBtn.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    statusBtn.disabled = true;
    const newStatus = payload.status === 'open' ? 'resolved' : 'open';
    try {
      const result = await window.bugReport.update(timestamp, { status: newStatus });
      payload.status = result.payload.status;
      // Update the in-place metadata row too
      const statusDD = metaGrid.querySelectorAll('dd')[4];
      if (statusDD !== undefined) statusDD.textContent = payload.status;
      renderStatusLabel();
      void refreshReportsList();
    } catch (err) {
      const errEl = document.createElement('div');
      errEl.className = 'notes-save-status error';
      errEl.textContent = `Status update failed: ${(err as Error).message}`;
      actions.appendChild(errEl);
      window.setTimeout(() => errEl.remove(), 4000);
    } finally {
      statusBtn.disabled = false;
    }
  });
  actions.appendChild(statusBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'ghost danger';
  deleteBtn.type = 'button';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    if (!window.confirm('Delete this bug report? This removes it from cloud storage.')) {
      return;
    }
    deleteBtn.disabled = true;
    try {
      await window.bugReport.delete(timestamp);
      void refreshReportsList();
    } catch (err) {
      const errEl = document.createElement('div');
      errEl.className = 'notes-save-status error';
      errEl.textContent = `Delete failed: ${(err as Error).message}`;
      actions.appendChild(errEl);
      deleteBtn.disabled = false;
    }
  });
  actions.appendChild(deleteBtn);

  expanded.appendChild(actions);
  li.appendChild(expanded);
}

/**
 * Single-phase load: KV is the only source. Show "Loading..." until the
 * list returns; render results or an error.
 */
async function refreshReportsList(): Promise<void> {
  reportsList.innerHTML = '<li class="reports-empty">Loading from cloud...</li>';
  reportsCount.textContent = '...';
  try {
    const summaries = await window.bugReport.list();
    renderReportsList(summaries);
  } catch (err) {
    reportsList.innerHTML = `<li class="reports-empty">Failed to load reports: ${esc((err as Error).message)}</li>`;
    reportsCount.textContent = '?';
  }
}

reportsRefreshBtn.addEventListener('click', () => {
  void refreshReportsList();
});

// Initial render
void refreshPreview();
void refreshReportsList();
