/**
 * Settings -> IDWs section.
 *
 * Unified manage-agents panel for the IDW menu's six kinds:
 * IDWs (organization specialists), External Bots, Image Creators,
 * Video Creators, Audio Generators (with sub-categories), UI Design
 * Tools.
 *
 * Layout:
 *   - Section header "Your AI Roster" with subtitle
 *   - Welcome card (visible when entry list is empty) -- inviting
 *     copy + two CTAs: "Open OAGI Store" (primary), "Add Custom
 *     Agent" (secondary)
 *   - Filter row: kind pills (All + per-kind counts)
 *   - Card-rows table: icon, label, kind pill, source pill, updated,
 *     Edit + Remove actions per row. Inline-expand Edit form. Smooth
 *     animations on add/remove.
 *   - Add form (toggled): kind dropdown + dynamic per-kind fields,
 *     URL inline validation, Save/Cancel buttons.
 *
 * Subscribes to `window.lite.idw.onChange` for live cross-window
 * updates (Catalog window installs reflect immediately here).
 *
 * Returns a disposer that clears the container + detaches the
 * change subscription on Settings window close.
 */

/// <reference path="../../lite-window.d.ts" />

import type { SectionDescriptor } from '../types.js';
// Import the preset table directly rather than through `lite/idw/api.ts`
// because api.ts pulls in `IdwStore` which uses Node built-ins
// (`node:events`, `node:crypto`) -- the renderer bundle can't resolve
// those. `bot-presets.ts` is pure data with no runtime dependencies,
// so it bundles cleanly. Main-process consumers should still go
// through `idw/api.ts`.
import { BOT_PRESETS, findBotPreset } from '../../idw/bot-presets.js';

type Kind = LiteAgentKind;

const KIND_ORDER: ReadonlyArray<Kind> = [
  'idw',
  'external-bot',
  'image-creator',
  'video-creator',
  'audio-generator',
  'ui-design-tool',
];

const KIND_LABEL: Readonly<Record<Kind, string>> = {
  idw: 'IDW',
  'external-bot': 'External Bot',
  'image-creator': 'Image Creator',
  'video-creator': 'Video Creator',
  'audio-generator': 'Audio Generator',
  'ui-design-tool': 'UI Design Tool',
};

const KIND_PLURAL: Readonly<Record<Kind, string>> = {
  idw: 'IDWs',
  'external-bot': 'External Bots',
  'image-creator': 'Image Creators',
  'video-creator': 'Video Creators',
  'audio-generator': 'Audio Generators',
  'ui-design-tool': 'UI Design Tools',
};

const KIND_EMOJI: Readonly<Record<Kind, string>> = {
  idw: '\u{1F916}',
  'external-bot': '\u{1F4AC}',
  'image-creator': '\u{1F3A8}',
  'video-creator': '\u{1F3AC}',
  'audio-generator': '\u{1F3B5}',
  'ui-design-tool': '\u{1F58C}',
};

const KIND_SUPPORTS_API_URL: Readonly<Record<Kind, boolean>> = {
  idw: false,
  'external-bot': true,
  'image-creator': true,
  'video-creator': true,
  'audio-generator': true,
  'ui-design-tool': true,
};

interface SectionState {
  container: HTMLElement;
  entries: LiteIdwEntry[];
  activeKindFilter: Kind | 'all';
  unsubscribe: (() => void) | null;
}

function idw(): LiteIdwBridge {
  const i = window.lite?.idw;
  if (i === undefined) {
    throw new Error('preload bridge `window.lite.idw` is not available');
  }
  return i;
}

export const mountIdws: SectionDescriptor['mount'] = (container) => {
  const state: SectionState = {
    container,
    entries: [],
    activeKindFilter: 'all',
    unsubscribe: null,
  };

  void initialLoad(state);

  // Subscribe to live mutations.
  try {
    state.unsubscribe = idw().onChange((entries) => {
      state.entries = [...entries];
      render(state);
    });
  } catch {
    // Bridge missing; initial load already handled the error path.
  }

  return (): void => {
    if (state.unsubscribe !== null) {
      try { state.unsubscribe(); } catch { /* best-effort */ }
      state.unsubscribe = null;
    }
    container.innerHTML = '';
  };
};

// ---------------------------------------------------------------------------
// Initial load
// ---------------------------------------------------------------------------

async function initialLoad(state: SectionState): Promise<void> {
  let bridge: LiteIdwBridge;
  try {
    bridge = idw();
  } catch (err) {
    renderBridgeMissing(state, (err as Error).message);
    return;
  }
  try {
    state.entries = await bridge.list();
  } catch (err) {
    renderError(state, (err as Error).message);
    return;
  }
  render(state);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render(state: SectionState): void {
  const totalCount = state.entries.length;
  if (totalCount === 0) {
    renderEmpty(state);
    return;
  }

  const filtered =
    state.activeKindFilter === 'all'
      ? state.entries
      : state.entries.filter((e) => e.kind === state.activeKindFilter);

  state.container.innerHTML = `
    <div class="idw-card">
      <div class="idw-status-row">
        <span class="idw-status-pill ok">${escapeHtml(String(totalCount))} installed</span>
        <span class="idw-status-help">
          IDWs are the specialists you work with. Add ones from your organization's OAGI Store, or define a custom agent with a chat URL.
        </span>
      </div>

      <div class="idw-actions-row">
        <button type="button" id="idw-open-store" class="btn-primary">Open OAGI Store</button>
        <button type="button" id="idw-add-custom" class="btn-secondary">Add Custom Agent</button>
      </div>

      <div class="idw-filter-row" id="idw-filter-row" role="tablist" aria-label="Filter by kind"></div>

      <div class="idw-add-form-wrap" id="idw-add-form-wrap" hidden></div>

      <div class="idw-table" id="idw-table">
        ${filtered.map((e) => renderRow(e)).join('')}
      </div>

      <div id="idw-banner" class="banner" style="display:none;"></div>
    </div>
  `;

  buildFilterPills(state);
  wireActions(state);
}

function renderEmpty(state: SectionState): void {
  state.container.innerHTML = `
    <div class="idw-card">
      <div class="idw-welcome">
        <div class="idw-welcome-title">Start your journey as a product expert</div>
        <p class="idw-welcome-body">
          Install IDWs to add specialist agents to your top-of-window IDW menu. Browse what
          your organization has published in the OAGI Store, or define a custom agent with a
          chat URL.
        </p>
        <div class="idw-welcome-actions">
          <button type="button" id="idw-open-store" class="btn-primary">Open OAGI Store</button>
          <button type="button" id="idw-add-custom" class="btn-secondary">Add Custom Agent</button>
        </div>
      </div>
      <div class="idw-add-form-wrap" id="idw-add-form-wrap" hidden></div>
      <div id="idw-banner" class="banner" style="display:none;"></div>
    </div>
  `;
  wireActions(state);
}

function renderRow(entry: LiteIdwEntry): string {
  const kind = entry.kind;
  const sourceLabel = entry.source === 'store' ? 'Store' : 'Manual';
  const updated = formatDate(entry.updatedAt);
  const icon = renderRowIcon(entry);
  return `
    <div class="idw-row" data-id="${escapeAttr(entry.id)}">
      <div class="idw-row-summary">
        <div class="idw-row-icon">${icon}</div>
        <div class="idw-row-text">
          <div class="idw-row-label">${escapeHtml(entry.label)}</div>
          <div class="idw-row-url">${escapeHtml(entry.url)}</div>
        </div>
        <span class="idw-pill" data-kind="${kind}">${escapeHtml(KIND_LABEL[kind])}</span>
        <span class="idw-pill idw-pill-source">${escapeHtml(sourceLabel)}</span>
        <span class="idw-row-updated">${escapeHtml(updated)}</span>
        <div class="idw-row-actions">
          <button type="button" class="idw-link-button" data-action="edit" data-id="${escapeAttr(entry.id)}">Edit</button>
          <button type="button" class="idw-link-button danger" data-action="remove" data-id="${escapeAttr(entry.id)}">Remove</button>
        </div>
      </div>
      <div class="idw-row-edit" hidden></div>
    </div>
  `;
}

function renderRowIcon(entry: LiteIdwEntry): string {
  if (typeof entry.thumbnailUrl === 'string' && entry.thumbnailUrl.length > 0) {
    return `<img class="idw-row-icon-img" src="${escapeAttr(entry.thumbnailUrl)}" alt="" data-fallback="${escapeAttr(KIND_EMOJI[entry.kind])}" />`;
  }
  return `<span aria-hidden="true">${escapeHtml(KIND_EMOJI[entry.kind])}</span>`;
}

function buildFilterPills(state: SectionState): void {
  const row = el<HTMLElement>(state.container, 'idw-filter-row');
  if (row === null) return;

  const counts = new Map<Kind, number>();
  for (const k of KIND_ORDER) counts.set(k, 0);
  for (const e of state.entries) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);

  const total = state.entries.length;
  row.innerHTML = '';
  row.appendChild(buildPill(state, 'all', 'All', total));
  for (const k of KIND_ORDER) {
    const c = counts.get(k) ?? 0;
    if (c === 0) continue;
    row.appendChild(buildPill(state, k, KIND_PLURAL[k], c));
  }
}

function buildPill(state: SectionState, value: Kind | 'all', label: string, count: number): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'idw-filter-pill' + (value === state.activeKindFilter ? ' active' : '');
  btn.dataset['kind'] = value;
  const labelSpan = document.createElement('span');
  labelSpan.textContent = label;
  btn.appendChild(labelSpan);
  const countSpan = document.createElement('span');
  countSpan.className = 'idw-filter-pill-count';
  countSpan.textContent = String(count);
  btn.appendChild(countSpan);
  btn.addEventListener('click', () => {
    state.activeKindFilter = value;
    render(state);
  });
  return btn;
}

// ---------------------------------------------------------------------------
// Actions wiring
// ---------------------------------------------------------------------------

function wireActions(state: SectionState): void {
  const openStoreBtn = el<HTMLButtonElement>(state.container, 'idw-open-store');
  if (openStoreBtn !== null) {
    openStoreBtn.addEventListener('click', () => {
      void idw().openStore().catch(() => {
        showBanner(state, 'Could not open the OAGI Store window.', 'error');
      });
    });
  }
  const addCustomBtn = el<HTMLButtonElement>(state.container, 'idw-add-custom');
  if (addCustomBtn !== null) {
    addCustomBtn.addEventListener('click', () => toggleAddForm(state));
  }

  // Wire row Edit/Remove buttons.
  for (const btn of Array.from(state.container.querySelectorAll<HTMLButtonElement>('button[data-action]'))) {
    const action = btn.dataset['action'];
    const id = btn.dataset['id'];
    if (typeof action !== 'string' || typeof id !== 'string') continue;
    btn.addEventListener('click', () => {
      if (action === 'edit') openInlineEdit(state, id);
      else if (action === 'remove') void removeFlow(state, id);
    });
  }

  // Installed entries can outlive catalog metadata. If a stored image URL
  // goes stale, fall back to the same kind marker the row would use without
  // a thumbnail instead of leaving a broken image glyph in Settings.
  for (const img of Array.from(state.container.querySelectorAll<HTMLImageElement>('img.idw-row-icon-img'))) {
    img.addEventListener('error', () => {
      const fallback = img.dataset['fallback'] ?? '';
      const span = document.createElement('span');
      span.setAttribute('aria-hidden', 'true');
      span.textContent = fallback;
      img.replaceWith(span);
    }, { once: true });
  }
}

// ---------------------------------------------------------------------------
// Add form
// ---------------------------------------------------------------------------

function toggleAddForm(state: SectionState): void {
  const wrap = el<HTMLElement>(state.container, 'idw-add-form-wrap');
  if (wrap === null) return;
  if (!wrap.hasAttribute('hidden')) {
    wrap.setAttribute('hidden', '');
    wrap.innerHTML = '';
    return;
  }
  wrap.removeAttribute('hidden');
  wrap.innerHTML = renderAddForm();
  wireFormFields(state, wrap, null);
  // Focus the first visible input for quick keyboard entry.
  const first = wrap.querySelector<HTMLInputElement>('input[name="label"]');
  if (first !== null) first.focus();
}

function renderAddForm(): string {
  return `
    <form class="idw-form" id="idw-add-form">
      <div class="idw-form-title">Add Custom Agent</div>

      <div class="idw-form-field">
        <label for="idw-form-kind">Kind</label>
        <select id="idw-form-kind" name="kind">
          ${KIND_ORDER.map((k) => `<option value="${k}">${escapeHtml(KIND_LABEL[k])}</option>`).join('')}
        </select>
      </div>

      <div class="idw-form-field" data-show-when="botType" hidden>
        <label for="idw-form-botType">Bot type</label>
        <select id="idw-form-botType" name="botType">
          ${BOT_PRESETS.map((p) => `<option value="${escapeAttr(p.id)}">${escapeHtml(p.label)}</option>`).join('')}
        </select>
        <div class="idw-form-help">Pick a well-known bot to pre-fill Label and URL, or choose Custom.</div>
      </div>

      <div class="idw-form-field">
        <label for="idw-form-label">Label</label>
        <input type="text" id="idw-form-label" name="label" placeholder="e.g. ChatGPT" autocomplete="off" />
        <div class="idw-form-help" data-help="label">Shown in the IDW menu and this table.</div>
      </div>

      <div class="idw-form-field">
        <label for="idw-form-url">URL</label>
        <input type="text" id="idw-form-url" name="url" placeholder="https://..." autocomplete="off" spellcheck="false" />
        <div class="idw-form-help" data-help="url">Must start with http:// or https://.</div>
      </div>

      <div class="idw-form-field" data-show-when="apiUrl" hidden>
        <label for="idw-form-apiUrl">API documentation URL (optional)</label>
        <input type="text" id="idw-form-apiUrl" name="apiUrl" placeholder="https://..." autocomplete="off" spellcheck="false" />
      </div>

      <div class="idw-form-field" data-show-when="environment" hidden>
        <label for="idw-form-environment">Environment</label>
        <select id="idw-form-environment" name="environment">
          <option value="">(none)</option>
          <option value="production">production</option>
          <option value="staging">staging</option>
          <option value="edison">edison</option>
          <option value="custom">custom</option>
        </select>
      </div>

      <div class="idw-form-field" data-show-when="audio" hidden>
        <label for="idw-form-audio">Audio sub-category</label>
        <select id="idw-form-audio" name="audioSubCategory">
          <option value="music">Music</option>
          <option value="effects">Sound Effects</option>
          <option value="narration">Narration</option>
          <option value="custom">Custom</option>
        </select>
      </div>

      <div class="idw-form-field">
        <label for="idw-form-description">Description (optional)</label>
        <input type="text" id="idw-form-description" name="description" placeholder="Short description shown in the Settings table." autocomplete="off" />
      </div>

      <div class="idw-form-actions">
        <button type="submit" class="btn-primary" id="idw-form-save">Save</button>
        <button type="button" class="btn-secondary" id="idw-form-cancel">Cancel</button>
      </div>

      <div class="idw-form-error" id="idw-form-error" hidden></div>
    </form>
  `;
}

function wireFormFields(state: SectionState, wrap: HTMLElement, editingEntry: LiteIdwEntry | null): void {
  const form = wrap.querySelector<HTMLFormElement>('#idw-add-form');
  if (form === null) return;
  const kindSelect = wrap.querySelector<HTMLSelectElement>('select[name="kind"]');
  const updateVisibility = (kind: Kind): void => {
    for (const field of Array.from(wrap.querySelectorAll<HTMLElement>('[data-show-when]'))) {
      const show = shouldShowField(kind, field.dataset['showWhen'] ?? '');
      if (show) field.removeAttribute('hidden');
      else field.setAttribute('hidden', '');
    }
  };

  if (editingEntry !== null) {
    // Pre-populate.
    if (kindSelect !== null) {
      kindSelect.value = editingEntry.kind;
      kindSelect.disabled = true; // kind cannot change on update
    }
    setInputValue(wrap, 'label', editingEntry.label);
    setInputValue(wrap, 'url', editingEntry.url);
    setInputValue(wrap, 'apiUrl', editingEntry.apiUrl ?? '');
    setInputValue(wrap, 'description', editingEntry.description ?? '');
    setInputValue(wrap, 'environment', editingEntry.environment ?? '');
    setInputValue(wrap, 'audioSubCategory', editingEntry.audio?.subCategory ?? 'music');
    setInputValue(wrap, 'botType', editingEntry.botType ?? 'custom');
  }

  if (kindSelect !== null) {
    updateVisibility(kindSelect.value as Kind);
    kindSelect.addEventListener('change', () => {
      const newKind = kindSelect.value as Kind;
      updateVisibility(newKind);
      // Switching to External Bot should immediately suggest the
      // current Bot type's defaults so the user sees a useful pre-fill
      // without having to re-pick from the dropdown.
      if (newKind === 'external-bot') {
        applyBotTypePreset(wrap);
      }
    });
  }

  // Bot type select: auto-fill Label and URL from the chosen preset.
  const botTypeSelect = wrap.querySelector<HTMLSelectElement>('select[name="botType"]');
  if (botTypeSelect !== null) {
    botTypeSelect.addEventListener('change', () => applyBotTypePreset(wrap));
  }

  // Once the user types into Label or URL, clear the "preset-set"
  // marker so subsequent preset picks do not overwrite their input.
  const labelEl = wrap.querySelector<HTMLInputElement>('input[name="label"]');
  if (labelEl !== null) {
    labelEl.addEventListener('input', () => {
      delete labelEl.dataset['presetSet'];
    });
  }
  const urlInputForFlag = wrap.querySelector<HTMLInputElement>('input[name="url"]');
  if (urlInputForFlag !== null) {
    urlInputForFlag.addEventListener('input', () => {
      delete urlInputForFlag.dataset['presetSet'];
    });
  }

  const cancel = wrap.querySelector<HTMLButtonElement>('#idw-form-cancel');
  if (cancel !== null) {
    cancel.addEventListener('click', (ev) => {
      ev.preventDefault();
      if (editingEntry !== null) {
        // Inline edit: collapse the row.
        const row = state.container.querySelector<HTMLElement>(`.idw-row[data-id="${cssEscape(editingEntry.id)}"] .idw-row-edit`);
        if (row !== null) {
          row.setAttribute('hidden', '');
          row.innerHTML = '';
        }
      } else {
        toggleAddForm(state);
      }
    });
  }

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    void handleFormSubmit(state, wrap, editingEntry);
  });

  // URL inline validation.
  const urlInput = wrap.querySelector<HTMLInputElement>('input[name="url"]');
  const urlHelp = wrap.querySelector<HTMLElement>('[data-help="url"]');
  if (urlInput !== null && urlHelp !== null) {
    urlInput.addEventListener('input', () => {
      const v = urlInput.value.trim();
      const valid = v.length === 0 || isValidHttpUrl(v);
      if (valid) {
        urlInput.classList.remove('invalid');
        urlHelp.textContent = 'Must start with http:// or https://.';
        urlHelp.classList.remove('invalid');
      } else {
        urlInput.classList.add('invalid');
        urlHelp.textContent = 'URL must be a valid http:// or https:// address.';
        urlHelp.classList.add('invalid');
      }
    });
  }
}

async function handleFormSubmit(state: SectionState, wrap: HTMLElement, editing: LiteIdwEntry | null): Promise<void> {
  const errorEl = wrap.querySelector<HTMLElement>('#idw-form-error');
  const saveBtn = wrap.querySelector<HTMLButtonElement>('#idw-form-save');
  if (saveBtn !== null) saveBtn.disabled = true;
  if (errorEl !== null) {
    errorEl.setAttribute('hidden', '');
    errorEl.textContent = '';
  }

  const kindRaw = readInputValue(wrap, 'kind');
  if (!(KIND_ORDER as readonly string[]).includes(kindRaw)) {
    showFormError(errorEl, 'Choose a kind.');
    if (saveBtn !== null) saveBtn.disabled = false;
    return;
  }
  const kind = kindRaw as Kind;
  const label = readInputValue(wrap, 'label').trim();
  const url = readInputValue(wrap, 'url').trim();
  const apiUrl = readInputValue(wrap, 'apiUrl').trim();
  const environment = readInputValue(wrap, 'environment').trim();
  const description = readInputValue(wrap, 'description').trim();
  const audioSub = readInputValue(wrap, 'audioSubCategory').trim();
  const botType = readInputValue(wrap, 'botType').trim();

  if (label.length === 0) {
    showFormError(errorEl, 'Label is required.');
    if (saveBtn !== null) saveBtn.disabled = false;
    return;
  }
  if (!isValidHttpUrl(url)) {
    showFormError(errorEl, 'URL must be a valid http:// or https:// address.');
    if (saveBtn !== null) saveBtn.disabled = false;
    return;
  }

  try {
    if (editing !== null) {
      // Update path.
      const patch: Partial<LiteIdwEntry> = {
        label,
        url,
      };
      if (apiUrl.length > 0 || (KIND_SUPPORTS_API_URL[kind] && editing.apiUrl !== undefined)) {
        patch.apiUrl = apiUrl;
      }
      if (description.length > 0 || editing.description !== undefined) {
        patch.description = description;
      }
      if (kind === 'idw') {
        patch.environment = environment;
      }
      if (kind === 'audio-generator') {
        patch.audio = { subCategory: audioSub as LiteAudioSubCategory };
      }
      if (kind === 'external-bot' && botType.length > 0) {
        patch.botType = botType as LiteBotType;
      }
      await idw().update(editing.id, patch);
      // Collapse inline edit.
      const row = state.container.querySelector<HTMLElement>(
        `.idw-row[data-id="${cssEscape(editing.id)}"] .idw-row-edit`
      );
      if (row !== null) {
        row.setAttribute('hidden', '');
        row.innerHTML = '';
      }
      showBanner(state, `Updated: ${label}`, 'success');
    } else {
      // Add path.
      const payload: LiteIdwAddInput = {
        kind,
        label,
        url,
        source: 'manual',
      };
      if (apiUrl.length > 0) payload.apiUrl = apiUrl;
      if (description.length > 0) payload.description = description;
      if (kind === 'idw' && environment.length > 0) payload.environment = environment;
      if (kind === 'audio-generator') {
        payload.audio = { subCategory: audioSub as LiteAudioSubCategory };
      }
      if (kind === 'external-bot' && botType.length > 0) {
        payload.botType = botType as LiteBotType;
      }
      await idw().add(payload);
      // Close add form.
      toggleAddForm(state);
      showBanner(state, `Added: ${label}`, 'success');
    }
  } catch (err) {
    const parsed = idw().parseError(err);
    const msg = parsed !== null ? `${parsed.message} ${parsed.remediation}`.trim() : (err as Error).message;
    showFormError(errorEl, msg);
    if (saveBtn !== null) saveBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Inline edit
// ---------------------------------------------------------------------------

function openInlineEdit(state: SectionState, id: string): void {
  const entry = state.entries.find((e) => e.id === id);
  if (entry === undefined) return;
  const editWrap = state.container.querySelector<HTMLElement>(
    `.idw-row[data-id="${cssEscape(id)}"] .idw-row-edit`
  );
  if (editWrap === null) return;
  if (!editWrap.hasAttribute('hidden')) {
    // Already open -- collapse.
    editWrap.setAttribute('hidden', '');
    editWrap.innerHTML = '';
    return;
  }
  editWrap.removeAttribute('hidden');
  editWrap.innerHTML = renderAddForm();
  // Mutate the title for clarity.
  const title = editWrap.querySelector<HTMLElement>('.idw-form-title');
  if (title !== null) title.textContent = `Edit: ${entry.label}`;
  wireFormFields(state, editWrap, entry);
}

// ---------------------------------------------------------------------------
// Remove flow
// ---------------------------------------------------------------------------

async function removeFlow(state: SectionState, id: string): Promise<void> {
  const entry = state.entries.find((e) => e.id === id);
  if (entry === undefined) return;
  const confirmed = window.confirm(`Remove ${entry.label}?`);
  if (!confirmed) return;
  // Optimistic row-remove animation: collapse the row before the
  // backend finishes, then onChange will repopulate the table fresh.
  const row = state.container.querySelector<HTMLElement>(
    `.idw-row[data-id="${cssEscape(id)}"]`
  );
  if (row !== null) {
    row.classList.add('removing');
  }
  try {
    await idw().remove(id);
    showBanner(state, `Removed: ${entry.label}`, 'success');
  } catch (err) {
    const parsed = idw().parseError(err);
    const msg = parsed !== null ? `${parsed.message} ${parsed.remediation}`.trim() : (err as Error).message;
    showBanner(state, msg, 'error');
    // Roll back optimistic collapse.
    if (row !== null) row.classList.remove('removing');
  }
}

// ---------------------------------------------------------------------------
// Error / fallback rendering
// ---------------------------------------------------------------------------

function renderBridgeMissing(state: SectionState, message: string): void {
  state.container.innerHTML = `
    <div class="idw-card">
      <div class="banner error">IDW settings are unavailable: ${escapeHtml(message)}</div>
    </div>
  `;
}

function renderError(state: SectionState, message: string): void {
  state.container.innerHTML = `
    <div class="idw-card">
      <div class="banner error">Could not load IDWs: ${escapeHtml(message)}</div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

function shouldShowField(kind: Kind, condition: string): boolean {
  switch (condition) {
    case 'apiUrl':
      return KIND_SUPPORTS_API_URL[kind];
    case 'environment':
      return kind === 'idw';
    case 'audio':
      return kind === 'audio-generator';
    case 'botType':
      return kind === 'external-bot';
    default:
      return true;
  }
}

/**
 * Apply the currently-selected `botType` preset to the Label and URL
 * fields. Overwrites a field only when it's blank or was last set by
 * a previous preset pick (marked with `data-preset-set="true"`).
 * Custom and unknown presets are no-ops.
 */
function applyBotTypePreset(wrap: HTMLElement): void {
  const sel = wrap.querySelector<HTMLSelectElement>('select[name="botType"]');
  if (sel === null) return;
  const preset = findBotPreset(sel.value);
  if (preset === null || preset.id === 'custom') return;

  const labelEl = wrap.querySelector<HTMLInputElement>('input[name="label"]');
  if (labelEl !== null) {
    if (labelEl.value.trim() === '' || labelEl.dataset['presetSet'] === 'true') {
      labelEl.value = preset.defaultEntryLabel;
      labelEl.dataset['presetSet'] = 'true';
    }
  }

  const urlEl = wrap.querySelector<HTMLInputElement>('input[name="url"]');
  if (urlEl !== null) {
    if (urlEl.value.trim() === '' || urlEl.dataset['presetSet'] === 'true') {
      urlEl.value = preset.defaultUrl;
      urlEl.dataset['presetSet'] = 'true';
      urlEl.classList.remove('invalid');
      const urlHelp = wrap.querySelector<HTMLElement>('[data-help="url"]');
      if (urlHelp !== null) {
        urlHelp.textContent = 'Must start with http:// or https://.';
        urlHelp.classList.remove('invalid');
      }
    }
  }
}

function el<T extends HTMLElement = HTMLElement>(container: HTMLElement, id: string): T | null {
  const node = container.querySelector(`#${id}`) ?? document.getElementById(id);
  return node as T | null;
}

function setInputValue(wrap: HTMLElement, name: string, value: string): void {
  const input = wrap.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`);
  if (input !== null) input.value = value;
}

function readInputValue(wrap: HTMLElement, name: string): string {
  const input = wrap.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`);
  return input !== null ? input.value : '';
}

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function showBanner(state: SectionState, text: string, kind: 'success' | 'error' | 'info'): void {
  const banner = el<HTMLElement>(state.container, 'idw-banner');
  if (banner === null) return;
  banner.textContent = text;
  banner.classList.remove('info', 'success', 'error');
  banner.classList.add(kind);
  banner.style.display = '';
  // Auto-dismiss success banners.
  if (kind === 'success') {
    window.setTimeout(() => {
      banner.style.display = 'none';
    }, 3000);
  }
}

function showFormError(el: HTMLElement | null, message: string): void {
  if (el === null) return;
  el.textContent = message;
  el.removeAttribute('hidden');
}

function formatDate(epochOrIso: string): string {
  if (typeof epochOrIso !== 'string' || epochOrIso.length === 0) return '';
  const d = new Date(epochOrIso);
  if (Number.isNaN(d.getTime())) return epochOrIso;
  // Compact: "May 4, 17:42"
  try {
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return d.toISOString();
  }
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

function cssEscape(s: string): string {
  // Minimal CSS attribute selector escape -- allows letters, numbers,
  // dash, underscore, slash. Other chars are escaped with backslash.
  return s.replace(/([^a-zA-Z0-9\-_/])/g, '\\$1');
}
