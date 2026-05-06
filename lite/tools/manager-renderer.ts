/**
 * Tools manager renderer.
 *
 * Loaded into the manager window (`tools-manager.html`). Calls
 * `window.lite.tools.{list,add,update,remove}` for CRUD; subscribes to
 * `window.lite.tools.onChange` so edits made elsewhere reflect live.
 *
 * Loaded as an external script (not inline) so the strict CSP
 * `script-src 'self'` allows execution.
 */

/// <reference path="../lite-window.d.ts" />

export {};

interface ToolEntryView {
  id: string;
  label: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

let entries: ToolEntryView[] = [];
let editingId: string | null = null;
let unsubscribeChange: (() => void) | null = null;

// ───── DOM helpers ─────────────────────────────────────────────────────────

function $<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ───── Bootstrap ───────────────────────────────────────────────────────────

function bootstrap(): void {
  const closeBtn = $('close-btn');
  closeBtn?.addEventListener('click', () => window.close());

  const cancelBtn = $('cancel-btn');
  cancelBtn?.addEventListener('click', () => exitEditMode());

  const form = $<HTMLFormElement>('tool-form');
  form?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    void onSubmit();
  });

  // Live updates from any other window (e.g. menu click that adds via
  // some future flow). Tools is the only writer right now, but keep
  // the bridge wired for symmetry with IDW.
  if (window.lite?.tools?.onChange !== undefined) {
    unsubscribeChange = window.lite.tools.onChange((newEntries) => {
      entries = newEntries;
      renderList();
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
  if (window.lite?.tools === undefined) {
    showToast('Tools bridge unavailable. Restart the app to recover.', 'error');
    return;
  }
  try {
    entries = await window.lite.tools.list();
    renderList();
  } catch (err) {
    showToast(`Could not load tools: ${(err as Error).message}`, 'error');
  }
}

// ───── List render ─────────────────────────────────────────────────────────

function renderList(): void {
  const container = $('tool-list');
  const summary = $('list-summary');
  if (container === null) return;

  if (entries.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        No tools yet. Add one with the form on the left and it'll show up in the Tools menu.
      </div>
    `;
    if (summary !== null) summary.textContent = 'No tools yet.';
    return;
  }

  if (summary !== null) {
    summary.textContent = `${entries.length} tool${entries.length === 1 ? '' : 's'}.`;
  }

  container.innerHTML = entries
    .map(
      (entry) => `
      <div class="tool-row${entry.id === editingId ? ' editing' : ''}" data-id="${escapeHtml(entry.id)}">
        <div class="tool-row-text">
          <div class="tool-row-label">${escapeHtml(entry.label)}</div>
          <div class="tool-row-url" title="${escapeHtml(entry.url)}">${escapeHtml(entry.url)}</div>
        </div>
        <div class="tool-row-actions">
          <button type="button" class="btn-icon edit-btn" data-id="${escapeHtml(entry.id)}">Edit</button>
          <button type="button" class="btn-danger delete-btn" data-id="${escapeHtml(entry.id)}">Delete</button>
        </div>
      </div>
    `
    )
    .join('');

  for (const btn of Array.from(container.querySelectorAll<HTMLButtonElement>('.edit-btn'))) {
    btn.addEventListener('click', () => {
      const id = btn.dataset['id'];
      if (typeof id === 'string') startEdit(id);
    });
  }
  for (const btn of Array.from(container.querySelectorAll<HTMLButtonElement>('.delete-btn'))) {
    btn.addEventListener('click', () => {
      const id = btn.dataset['id'];
      if (typeof id === 'string') void onDelete(id);
    });
  }
}

// ───── Form ────────────────────────────────────────────────────────────────

function startEdit(id: string): void {
  const entry = entries.find((e) => e.id === id);
  if (entry === undefined) return;
  editingId = id;

  const idInput = $<HTMLInputElement>('tool-id');
  const labelInput = $<HTMLInputElement>('tool-label');
  const urlInput = $<HTMLInputElement>('tool-url');
  const formTitle = $('form-title');
  const formSubtitle = $('form-subtitle');
  const saveBtn = $<HTMLButtonElement>('save-btn');
  const cancelBtn = $<HTMLButtonElement>('cancel-btn');

  if (idInput !== null) idInput.value = id;
  if (labelInput !== null) labelInput.value = entry.label;
  if (urlInput !== null) urlInput.value = entry.url;
  if (formTitle !== null) formTitle.textContent = 'Edit tool';
  if (formSubtitle !== null) formSubtitle.textContent = 'Update the label or URL, then click Save.';
  if (saveBtn !== null) saveBtn.textContent = 'Save changes';
  if (cancelBtn !== null) cancelBtn.hidden = false;

  clearFieldError('label');
  clearFieldError('url');
  labelInput?.focus();
  renderList();
}

function exitEditMode(): void {
  editingId = null;

  const idInput = $<HTMLInputElement>('tool-id');
  const labelInput = $<HTMLInputElement>('tool-label');
  const urlInput = $<HTMLInputElement>('tool-url');
  const formTitle = $('form-title');
  const formSubtitle = $('form-subtitle');
  const saveBtn = $<HTMLButtonElement>('save-btn');
  const cancelBtn = $<HTMLButtonElement>('cancel-btn');

  if (idInput !== null) idInput.value = '';
  if (labelInput !== null) labelInput.value = '';
  if (urlInput !== null) urlInput.value = '';
  if (formTitle !== null) formTitle.textContent = 'Add a tool';
  if (formSubtitle !== null) formSubtitle.textContent = 'Both fields are required.';
  if (saveBtn !== null) saveBtn.textContent = 'Add tool';
  if (cancelBtn !== null) cancelBtn.hidden = true;

  clearFieldError('label');
  clearFieldError('url');
  renderList();
}

async function onSubmit(): Promise<void> {
  if (window.lite?.tools === undefined) {
    showToast('Tools bridge unavailable.', 'error');
    return;
  }

  const labelInput = $<HTMLInputElement>('tool-label');
  const urlInput = $<HTMLInputElement>('tool-url');
  const saveBtn = $<HTMLButtonElement>('save-btn');
  const label = (labelInput?.value ?? '').trim();
  const url = (urlInput?.value ?? '').trim();

  clearFieldError('label');
  clearFieldError('url');

  let valid = true;
  if (label.length === 0) {
    setFieldError('label', 'Label is required.');
    valid = false;
  }
  if (url.length === 0) {
    setFieldError('url', 'URL is required.');
    valid = false;
  } else {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        setFieldError('url', 'URL must start with http:// or https://.');
        valid = false;
      }
    } catch {
      setFieldError('url', 'Enter a valid URL (e.g. https://example.com).');
      valid = false;
    }
  }
  if (!valid) return;

  if (saveBtn !== null) saveBtn.disabled = true;
  try {
    if (editingId !== null) {
      const updated = await window.lite.tools.update(editingId, { label, url });
      showToast(`Updated: ${updated.label}`, 'success');
    } else {
      const added = await window.lite.tools.add({ label, url });
      showToast(`Added: ${added.label}`, 'success');
    }
    // Refresh from server-of-truth (the broadcast may already have
    // updated us; this is a belt-and-suspenders pull).
    entries = await window.lite.tools.list();
    exitEditMode();
    renderList();
  } catch (err) {
    const parsed =
      window.lite?.tools?.parseError !== undefined ? window.lite.tools.parseError(err) : null;
    if (parsed !== null) {
      // Surface field-level errors when we can; otherwise toast.
      if (parsed.code === 'TOOLS_INVALID_INPUT') {
        setFieldError('label', `${parsed.message} ${parsed.remediation}`.trim());
      } else if (parsed.code === 'TOOLS_INVALID_URL') {
        setFieldError('url', `${parsed.message} ${parsed.remediation}`.trim());
      } else {
        showToast(`${parsed.message} ${parsed.remediation}`.trim(), 'error');
      }
    } else {
      showToast(`Save failed: ${(err as Error).message}`, 'error');
    }
  } finally {
    if (saveBtn !== null) saveBtn.disabled = false;
  }
}

async function onDelete(id: string): Promise<void> {
  if (window.lite?.tools === undefined) return;
  const entry = entries.find((e) => e.id === id);
  const name = entry?.label ?? 'this tool';
  // Soft confirm via window.confirm -- the manager window has no
  // custom modal yet; keep the surface tight.
  // eslint-disable-next-line no-alert
  if (!window.confirm(`Delete ${name}? This cannot be undone.`)) return;
  try {
    await window.lite.tools.remove(id);
    if (editingId === id) exitEditMode();
    entries = await window.lite.tools.list();
    renderList();
    showToast(`Deleted: ${name}`, 'success');
  } catch (err) {
    const parsed =
      window.lite?.tools?.parseError !== undefined ? window.lite.tools.parseError(err) : null;
    const msg =
      parsed !== null ? `${parsed.message} ${parsed.remediation}`.trim() : (err as Error).message;
    showToast(msg, 'error');
  }
}

// ───── Inline field errors ─────────────────────────────────────────────────

function setFieldError(field: 'label' | 'url', message: string): void {
  const el = $(`${field}-error`);
  const input = $<HTMLInputElement>(`tool-${field}`);
  if (el !== null) {
    el.textContent = message;
    el.classList.add('visible');
  }
  if (input !== null) input.setAttribute('aria-invalid', 'true');
}

function clearFieldError(field: 'label' | 'url'): void {
  const el = $(`${field}-error`);
  const input = $<HTMLInputElement>(`tool-${field}`);
  if (el !== null) {
    el.textContent = '';
    el.classList.remove('visible');
  }
  input?.removeAttribute('aria-invalid');
}

// ───── Toast ───────────────────────────────────────────────────────────────

function showToast(message: string, kind: 'success' | 'error' | 'info'): void {
  const stack = $('toast-stack');
  if (stack === null) return;
  const toast = document.createElement('div');
  toast.className = `toast ${kind}`;
  toast.textContent = message;
  stack.appendChild(toast);
  window.setTimeout(() => toast.classList.add('show'), 16);
  window.setTimeout(() => {
    toast.classList.remove('show');
    window.setTimeout(() => {
      if (toast.parentNode === stack) stack.removeChild(toast);
    }, 220);
  }, 3000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
