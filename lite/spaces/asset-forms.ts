/**
 * The Add-asset dialog's kind picker and per-kind form (ADR-098).
 *
 * Step one: "What are you adding?" — every creatable kind as a card,
 * grouped the way people think (Write / Files / Links / Capabilities /
 * Structured), filterable by typing, walkable with the arrow keys.
 * Step two: the form the chosen kind needs — paste, upload, link, or
 * typed fields — generated from its registry row, with the kind's
 * optional details folded under a disclosure so the common path stays
 * one field and one body.
 *
 * spaces.ts owns the dialog (open / close / submit / the hand-built
 * panes for text, upload, agent, knowledge, existing). This module
 * owns the picker, the generated pane, the draft it produces, and the
 * metadata a body implies (line counts, rows, tokens, turns). Pure DOM
 * plus module state for the draft; exported for jsdom tests.
 */

import {
  ASSET_KINDS,
  FAMILY_LABELS,
  FAMILY_ORDER,
  LANGUAGE_BY_EXTENSION,
  creatableKinds,
  fileExtension,
  inferKindFromFile,
  kindGlyph,
  kindSpec,
  sniffJsonKind,
  type AssetFamily,
  type AssetKindSpec,
  type CreateMode,
  type FieldSpec,
} from './asset-kinds.js';
import { describeLink, linkMetadata, normalizeHttpUrl, titleFromUrl, type LinkInfo } from './link-embeds.js';
import { buildFieldControl, fieldValueToBridgeString, parseFieldInput, readFieldControl } from './asset-fields.js';
import {
  extractFontFamilies,
  extractHexColors,
  flattenColors,
  flattenTypography,
  parseConversation,
  parseDelimitedHead,
  parseNotebook,
} from './asset-previews.js';

// ─── Picker ───────────────────────────────────────────────────────────

export const EXISTING_MODE = 'existing';

export interface PickerOptions {
  onPick: (mode: string) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Cards that match a typed filter: label, hint, id, aliases. */
export function pickerMatches(spec: AssetKindSpec, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  if (spec.label.toLowerCase().includes(q) || spec.id.includes(q) || spec.hint.toLowerCase().includes(q)) return true;
  return spec.aliases.some((a) => a.includes(q));
}

/**
 * Render the picker into `container`: a filter box, the family groups,
 * and the "already in your account" card. Roving focus: arrows move
 * between visible cards, Enter / Space pick, typing anywhere narrows.
 */
export function renderKindPicker(container: HTMLElement, opts: PickerOptions): void {
  container.replaceChildren();
  container.classList.add('spaces-kindpicker');

  const filterRow = el('div', 'spaces-kindpicker-filter-row');
  const filter = document.createElement('input');
  // A text input with a searchbox role, not type=search: the window
  // owns exactly one search box (the command bar's) and tests count it.
  filter.type = 'text';
  filter.setAttribute('role', 'searchbox');
  filter.className = 'spaces-new-asset-input spaces-kindpicker-filter';
  filter.placeholder = 'What are you adding? Type to narrow — slides, video, tool…';
  filter.setAttribute('aria-label', 'Filter asset kinds');
  filter.autocomplete = 'off';
  filterRow.appendChild(filter);
  container.appendChild(filterRow);

  const groups = el('div', 'spaces-kindpicker-groups');
  const cards: HTMLButtonElement[] = [];
  const families: AssetFamily[] = FAMILY_ORDER.filter((f) => f !== 'system');
  for (const family of families) {
    const specs = creatableKinds().filter((s) => s.family === family);
    if (specs.length === 0) continue;
    const group = el('section', 'spaces-kindpicker-group');
    group.setAttribute('data-family', family);
    group.appendChild(el('h3', 'spaces-kindpicker-group-title', FAMILY_LABELS[family]));
    const grid = el('div', 'spaces-kindpicker-grid');
    grid.setAttribute('role', 'listbox');
    for (const spec of specs) {
      const card = buildKindCard(spec);
      card.addEventListener('click', () => opts.onPick(spec.id));
      cards.push(card);
      grid.appendChild(card);
    }
    group.appendChild(grid);
    groups.appendChild(group);
  }
  // Existing asset — not a kind, a source.
  const existingGroup = el('section', 'spaces-kindpicker-group is-existing');
  existingGroup.setAttribute('data-family', 'existing');
  existingGroup.appendChild(el('h3', 'spaces-kindpicker-group-title', 'Already in your account'));
  const existingGrid = el('div', 'spaces-kindpicker-grid');
  const existingCard = el('button', 'spaces-kindpicker-card is-existing');
  existingCard.type = 'button';
  existingCard.setAttribute('data-kind', EXISTING_MODE);
  existingCard.appendChild(el('span', 'spaces-kindpicker-card-glyph', '⧉'));
  const existingText = el('span', 'spaces-kindpicker-card-text');
  existingText.appendChild(el('span', 'spaces-kindpicker-card-label', 'Existing asset'));
  existingText.appendChild(el('span', 'spaces-kindpicker-card-hint', 'File something from another Space here too'));
  existingCard.appendChild(existingText);
  existingCard.addEventListener('click', () => opts.onPick(EXISTING_MODE));
  cards.push(existingCard);
  existingGrid.appendChild(existingCard);
  existingGroup.appendChild(existingGrid);
  groups.appendChild(existingGroup);
  container.appendChild(groups);

  const empty = el('p', 'spaces-kindpicker-empty', 'Nothing matches. Try "file" for anything else.');
  empty.hidden = true;
  container.appendChild(empty);

  const visible = (): HTMLButtonElement[] => cards.filter((c) => !c.hidden);
  const applyFilter = (): void => {
    const q = filter.value;
    let any = false;
    for (const card of cards) {
      const id = card.getAttribute('data-kind') ?? '';
      const match = id === EXISTING_MODE ? /exist|already|other space|reuse/i.test(q) || q.trim().length === 0 : pickerMatches(kindSpec(id), q);
      card.hidden = !match;
      if (match) any = true;
    }
    for (const group of Array.from(groups.querySelectorAll<HTMLElement>('.spaces-kindpicker-group'))) {
      group.hidden = Array.from(group.querySelectorAll<HTMLButtonElement>('.spaces-kindpicker-card')).every((c) => c.hidden);
    }
    empty.hidden = any;
    const first = visible()[0];
    for (const c of cards) c.tabIndex = -1;
    if (first !== undefined) first.tabIndex = 0;
  };
  filter.addEventListener('input', applyFilter);
  filter.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      const v = visible();
      if (v.length === 1 && v[0] !== undefined) {
        ev.preventDefault();
        v[0].click();
      } else if (v.length > 1 && v[0] !== undefined) {
        ev.preventDefault();
        v[0].focus();
      }
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      visible()[0]?.focus();
    }
  });
  groups.addEventListener('keydown', (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLButtonElement) || !target.classList.contains('spaces-kindpicker-card')) return;
    const v = visible();
    const i = v.indexOf(target);
    if (i < 0) return;
    const columns = columnsOf(target);
    let next: HTMLButtonElement | undefined;
    switch (ev.key) {
      case 'ArrowRight': next = v[i + 1]; break;
      case 'ArrowLeft': next = v[i - 1]; break;
      case 'ArrowDown': next = v[i + columns] ?? v[v.length - 1]; break;
      case 'ArrowUp': next = i - columns >= 0 ? v[i - columns] : undefined; break;
      case 'Home': next = v[0]; break;
      case 'End': next = v[v.length - 1]; break;
      case 'Enter':
      case ' ':
        ev.preventDefault();
        target.click();
        return;
      default:
        // Any printable key goes back to the filter so typing keeps narrowing.
        if (ev.key.length === 1 && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
          filter.focus();
        }
        return;
    }
    if (ev.key === 'ArrowUp' && next === undefined) {
      ev.preventDefault();
      filter.focus();
      return;
    }
    if (next !== undefined) {
      ev.preventDefault();
      for (const c of cards) c.tabIndex = -1;
      next.tabIndex = 0;
      next.focus();
    }
  });
  applyFilter();
}

function columnsOf(card: HTMLElement): number {
  const grid = card.parentElement;
  if (grid === null) return 4;
  const style = typeof getComputedStyle === 'function' ? getComputedStyle(grid) : null;
  const cols = style !== null ? style.gridTemplateColumns.split(' ').filter((c) => c.trim().length > 0).length : 0;
  return cols > 0 ? cols : 4;
}

function buildKindCard(spec: AssetKindSpec): HTMLButtonElement {
  const card = el('button', 'spaces-kindpicker-card');
  card.type = 'button';
  card.setAttribute('data-kind', spec.id);
  card.setAttribute('role', 'option');
  card.style.setProperty('--tile-accent', spec.accent);
  card.title = spec.hint;
  card.appendChild(el('span', 'spaces-kindpicker-card-glyph', spec.glyph));
  const text = el('span', 'spaces-kindpicker-card-text');
  text.appendChild(el('span', 'spaces-kindpicker-card-label', spec.label));
  text.appendChild(el('span', 'spaces-kindpicker-card-hint', spec.hint));
  card.appendChild(text);
  return card;
}

/** The slim bar above a kind's form: glyph, label, hint, Change. */
export function renderKindBar(container: HTMLElement, mode: string, onChange: () => void): void {
  container.replaceChildren();
  container.classList.add('spaces-kindbar');
  const isExisting = mode === EXISTING_MODE;
  const spec = isExisting ? null : kindSpec(mode);
  const glyph = el('span', 'spaces-kindbar-glyph', isExisting ? '⧉' : (spec?.glyph ?? '▪'));
  glyph.setAttribute('aria-hidden', 'true');
  if (spec !== null) glyph.style.setProperty('--tile-accent', spec.accent);
  container.appendChild(glyph);
  const text = el('span', 'spaces-kindbar-text');
  text.appendChild(el('span', 'spaces-kindbar-label', isExisting ? 'Existing asset' : (spec?.label ?? mode)));
  text.appendChild(el('span', 'spaces-kindbar-hint', isExisting ? 'Search every Space you can see' : (spec?.hint ?? '')));
  container.appendChild(text);
  const change = el('button', 'spaces-kindbar-change', 'Change');
  change.type = 'button';
  change.setAttribute('aria-label', 'Choose a different kind');
  change.addEventListener('click', onChange);
  container.appendChild(change);
}

// ─── Generated pane ───────────────────────────────────────────────────

/** Kinds that use a hand-built pane instead of a generated one. */
export function builtinPaneFor(mode: string): string | null {
  if (mode === EXISTING_MODE) return EXISTING_MODE;
  const spec = kindSpec(mode);
  return spec.create?.pane ?? null;
}

/** Is this kind served by the generated pane (not a built-in one)? */
export function isRegistryMode(mode: string): boolean {
  if (mode === EXISTING_MODE) return false;
  const spec = kindSpec(mode);
  return spec.create !== null && spec.create.pane === undefined;
}

interface PaneState {
  kind: string;
  mode: CreateMode;
  file: File | null;
  link: LinkInfo | null;
}

let pane: PaneState | null = null;
let paneRoot: HTMLElement | null = null;

export interface PaneOptions {
  /** A file landed (drop or browse) — the dialog may retitle. */
  onFile?: (file: File | null) => void;
  /** The typed link looks like another kind — offer the switch. */
  onSuggestKind?: (kind: string) => void;
  /** The upload sharing controls to adopt while in upload mode. */
  shareControls?: HTMLElement | null;
  /** Where the share controls go back when the pane is torn down. */
  shareControlsHome?: HTMLElement | null;
}

let paneOptions: PaneOptions = {};

/** The pane's current create mode (paste / upload / link / form). */
export function registryMode(): CreateMode | null {
  return pane?.mode ?? null;
}

export function registryFile(): File | null {
  return pane?.file ?? null;
}

export function registryLink(): LinkInfo | null {
  return pane?.link ?? null;
}

/**
 * Build the pane for `kind` into `container`. Idempotent: rebuilding
 * for the same kind resets the draft (the dialog just opened or the
 * kind changed).
 */
export function renderRegistryPane(container: HTMLElement, kind: string, opts: PaneOptions = {}): void {
  tearDownRegistryPane();
  paneOptions = opts;
  paneRoot = container;
  container.replaceChildren();
  const spec = kindSpec(kind);
  const create = spec.create;
  if (create === null) return;
  const modes = create.modes;
  const initial: CreateMode = modes[0] ?? 'paste';
  pane = { kind, mode: initial, file: null, link: null };

  const root = el('div', 'spaces-kindform');
  root.setAttribute('data-kind', kind);

  if (modes.length > 1) {
    const modeRow = el('div', 'spaces-agent-source-toggle spaces-kindform-modes');
    modeRow.setAttribute('role', 'tablist');
    modeRow.setAttribute('aria-label', 'How to add it');
    for (const m of modes) {
      const btn = el('button', `spaces-agent-source-btn${m === initial ? ' is-active' : ''}`, MODE_LABELS[m]);
      btn.type = 'button';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('data-kindform-mode-btn', m);
      btn.setAttribute('aria-selected', m === initial ? 'true' : 'false');
      btn.addEventListener('click', () => switchRegistryMode(m));
      modeRow.appendChild(btn);
    }
    root.appendChild(modeRow);
  }

  for (const m of modes) {
    const block = el('div', 'spaces-kindform-mode');
    block.setAttribute('data-kindform-mode', m);
    block.hidden = m !== initial;
    switch (m) {
      case 'paste':
        buildPasteBlock(block, spec);
        break;
      case 'upload':
        buildUploadBlock(block, spec);
        break;
      case 'link':
        buildLinkBlock(block, spec);
        break;
      case 'form':
        buildFormBlock(block, spec);
        break;
      default:
        break;
    }
    root.appendChild(block);
  }

  // Optional details for non-form kinds: the editable fields, folded.
  const optional = spec.fields.filter((f) => f.readOnly !== true && f.required !== true);
  if (!modes.includes('form') && optional.length > 0) {
    const more = document.createElement('details');
    more.className = 'spaces-kindform-more';
    const summary = document.createElement('summary');
    summary.textContent = `${spec.label} details`;
    summary.appendChild(el('span', 'spaces-kindform-more-hint', 'optional — editable later in the rail'));
    more.appendChild(summary);
    const grid = el('div', 'spaces-kindform-fields');
    for (const f of optional) grid.appendChild(buildFieldRow(f, kind));
    more.appendChild(grid);
    root.appendChild(more);
  }

  container.appendChild(root);
  if (initial === 'upload') adoptShareControls(root);
}

const MODE_LABELS: Readonly<Record<CreateMode, string>> = {
  paste: 'Paste',
  upload: 'Upload',
  link: 'Link',
  form: 'Details',
};

export function switchRegistryMode(mode: CreateMode): void {
  if (pane === null || paneRoot === null) return;
  pane.mode = mode;
  for (const btn of Array.from(paneRoot.querySelectorAll<HTMLElement>('[data-kindform-mode-btn]'))) {
    const active = btn.getAttribute('data-kindform-mode-btn') === mode;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  for (const block of Array.from(paneRoot.querySelectorAll<HTMLElement>('[data-kindform-mode]'))) {
    block.hidden = block.getAttribute('data-kindform-mode') !== mode;
  }
  const root = paneRoot.querySelector<HTMLElement>('.spaces-kindform');
  if (mode === 'upload' && root !== null) adoptShareControls(root);
  else returnShareControls();
  const focusTarget = paneRoot.querySelector<HTMLElement>(`[data-kindform-mode="${mode}"] input:not([type=file]), [data-kindform-mode="${mode}"] textarea, [data-kindform-mode="${mode}"] select`);
  focusTarget?.focus();
}

/** Put the pane away: file state cleared, share controls sent home. */
export function tearDownRegistryPane(): void {
  returnShareControls();
  pane = null;
  if (paneRoot !== null) paneRoot.replaceChildren();
  paneRoot = null;
}

function adoptShareControls(root: HTMLElement): void {
  const controls = paneOptions.shareControls ?? null;
  if (controls === null) return;
  const slot = root.querySelector<HTMLElement>('.spaces-kindform-share-slot');
  if (slot !== null && controls.parentElement !== slot) slot.appendChild(controls);
}

function returnShareControls(): void {
  const controls = paneOptions.shareControls ?? null;
  const home = paneOptions.shareControlsHome ?? null;
  if (controls === null || home === null) return;
  if (controls.parentElement !== home) home.appendChild(controls);
}

function labelRow(label: string, hint: string | undefined, forId: string): HTMLElement {
  const row = el('div', 'spaces-new-asset-label-row');
  const lab = document.createElement('label');
  lab.className = 'spaces-new-asset-label';
  lab.htmlFor = forId;
  lab.textContent = label;
  row.appendChild(lab);
  if (hint !== undefined) row.appendChild(el('span', 'spaces-new-asset-label-hint', hint));
  return row;
}

function buildPasteBlock(block: HTMLElement, spec: AssetKindSpec): void {
  const create = spec.create;
  if (create === null) return;
  const id = 'spaces-kindform-body';
  block.appendChild(labelRow(create.bodyLabel ?? 'Content', create.bodyHint, id));
  const ta = document.createElement('textarea');
  ta.id = id;
  ta.className = 'spaces-new-asset-textarea spaces-kindform-body';
  ta.rows = spec.contentIsCode ? 12 : 10;
  ta.spellcheck = !spec.contentIsCode;
  if (create.bodyPlaceholder !== undefined) ta.placeholder = create.bodyPlaceholder;
  if (spec.contentIsCode) ta.setAttribute('data-code', 'true');
  ta.addEventListener('input', () => updateBodyHint(spec, ta.value));
  block.appendChild(ta);
  const hint = el('p', 'spaces-kindform-recognised');
  hint.hidden = true;
  hint.setAttribute('data-kindform-bodyhint', '');
  block.appendChild(hint);
}

/** Live line under the body: "Recognised as CSV · 120 rows × 6 columns". */
function updateBodyHint(spec: AssetKindSpec, body: string): void {
  if (paneRoot === null) return;
  const hint = paneRoot.querySelector<HTMLElement>('[data-kindform-bodyhint]');
  if (hint === null) return;
  const text = describeBody(spec.id, body);
  hint.hidden = text === null;
  hint.textContent = text ?? '';
  // A pasted JSON that is really another kind: suggest it once.
  if (spec.id === 'data' || spec.id === 'text') {
    const sniffed = sniffJsonKind(body);
    if (sniffed !== null && sniffed !== spec.id) {
      hint.hidden = false;
      hint.replaceChildren();
      hint.appendChild(document.createTextNode(`Looks like a ${kindSpec(sniffed).label.toLowerCase()} — `));
      const btn = el('button', 'spaces-kindform-suggest', `file it as ${kindSpec(sniffed).label}`);
      btn.type = 'button';
      btn.addEventListener('click', () => paneOptions.onSuggestKind?.(sniffed));
      hint.appendChild(btn);
    }
  }
}

/** A one-line reading of a pasted body for the given kind, or null. */
export function describeBody(kind: string, body: string): string | null {
  const t = body.trim();
  if (t.length === 0) return null;
  const meta = deriveBodyMetadata(kind, t);
  switch (kind) {
    case 'code':
      return `${meta['language'] !== undefined ? `${String(meta['language'])} · ` : ''}${String(meta['lineCount'] ?? 0)} lines`;
    case 'data': {
      const rows = meta['rowCount'];
      const cols = meta['columnCount'];
      const fmt = String(meta['data_format'] ?? '').toUpperCase();
      return rows !== undefined ? `${fmt} · ${String(rows)} rows${cols !== undefined ? ` × ${String(cols)} columns` : ''}` : fmt.length > 0 ? fmt : null;
    }
    case 'styleguide':
      return `${String(meta['styleguide_colors'] ?? 0)} colours${Array.isArray(meta['styleguide_fonts']) && (meta['styleguide_fonts'] as unknown[]).length > 0 ? ` · ${(meta['styleguide_fonts'] as string[]).join(', ')}` : ''}`;
    case 'conversation':
      return `${String(meta['conversation_messages'] ?? 0)} messages${meta['conversation_provider'] !== undefined ? ` · ${String(meta['conversation_provider'])}` : ''}`;
    case 'journey':
      return `${String(meta['journey_stage_count'] ?? 0)} stages`;
    default:
      return null;
  }
}

function buildUploadBlock(block: HTMLElement, spec: AssetKindSpec): void {
  const create = spec.create;
  if (create === null) return;
  const inputId = 'spaces-kindform-file';
  const zone = document.createElement('label');
  zone.className = 'spaces-new-asset-dropzone spaces-kindform-dropzone';
  zone.htmlFor = inputId;
  zone.appendChild(el('div', 'spaces-new-asset-dropzone-icon', '↑'));
  zone.appendChild(el('p', 'spaces-new-asset-dropzone-primary', `Drop a ${spec.label.toLowerCase()} file here, or click to browse`));
  const accept = create.accept ?? '';
  zone.appendChild(el('p', 'spaces-new-asset-dropzone-hint', accept.length > 0 ? accept.replace(/,/g, ' · ') : 'Any file'));
  const input = document.createElement('input');
  input.type = 'file';
  input.id = inputId;
  input.className = 'spaces-new-asset-file-input';
  if (accept.length > 0) input.accept = accept;
  input.addEventListener('change', () => setRegistryFile(input.files?.[0] ?? null));
  zone.appendChild(input);
  block.appendChild(zone);
  const chip = el('div', 'spaces-new-asset-file-chip spaces-kindform-file-chip');
  chip.hidden = true;
  chip.setAttribute('data-kindform-filechip', '');
  block.appendChild(chip);
  const slot = el('div', 'spaces-kindform-share-slot');
  block.appendChild(slot);
}

/** A file landed in the pane (browse, drop, or the dialog's preset). */
export function setRegistryFile(file: File | null): void {
  if (pane === null || paneRoot === null) return;
  pane.file = file;
  const chip = paneRoot.querySelector<HTMLElement>('[data-kindform-filechip]');
  if (chip !== null) {
    chip.replaceChildren();
    if (file !== null) {
      chip.hidden = false;
      chip.appendChild(el('span', 'spaces-new-asset-file-chip-name', file.name));
      const bytes = file.size < 1024 ? `${file.size} B` : file.size < 1024 * 1024 ? `${(file.size / 1024).toFixed(1)} KB` : `${(file.size / (1024 * 1024)).toFixed(1)} MB`;
      chip.appendChild(el('span', 'spaces-new-asset-file-chip-meta', `${bytes}${file.type.length > 0 ? ` · ${file.type}` : ''}`));
      const implied = inferKindFromFile(file);
      if (implied !== pane.kind && implied !== 'other' && paneOptions.onSuggestKind !== undefined) {
        const onSuggest = paneOptions.onSuggestKind;
        const note = el('span', 'spaces-kindform-recognised', `Looks like a ${kindSpec(implied).label.toLowerCase()} — `);
        const btn = el('button', 'spaces-kindform-suggest', `file it as ${kindSpec(implied).label}`);
        btn.type = 'button';
        btn.addEventListener('click', () => onSuggest(implied));
        note.appendChild(btn);
        chip.appendChild(note);
      }
    } else {
      chip.hidden = true;
    }
  }
  if (file !== null && pane.mode !== 'upload') switchRegistryMode('upload');
  paneOptions.onFile?.(file);
}

function buildLinkBlock(block: HTMLElement, spec: AssetKindSpec): void {
  const create = spec.create;
  if (create === null) return;
  const id = 'spaces-kindform-link';
  block.appendChild(labelRow('Address', create.linkHint, id));
  const input = document.createElement('input');
  input.type = 'url';
  input.id = id;
  input.className = 'spaces-new-asset-input spaces-kindform-link';
  input.autocomplete = 'off';
  input.placeholder = create.linkPlaceholder ?? 'https://…';
  block.appendChild(input);
  const recognised = el('p', 'spaces-kindform-recognised');
  recognised.hidden = true;
  recognised.setAttribute('data-kindform-linkhint', '');
  block.appendChild(recognised);
  let timer: number | null = null;
  input.addEventListener('input', () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      updateLinkHint(spec, input.value);
    }, 200);
  });
  input.addEventListener('blur', () => updateLinkHint(spec, input.value));
}

function updateLinkHint(spec: AssetKindSpec, raw: string): void {
  if (pane === null || paneRoot === null) return;
  const hint = paneRoot.querySelector<HTMLElement>('[data-kindform-linkhint]');
  const info = raw.trim().length > 0 ? describeLink(raw) : null;
  pane.link = info;
  if (hint === null) return;
  hint.replaceChildren();
  if (info === null) {
    hint.hidden = raw.trim().length === 0;
    if (!hint.hidden) hint.textContent = 'That does not look like a web address yet.';
    return;
  }
  hint.hidden = false;
  const label = info.provider === 'link' ? info.domain : info.providerLabel;
  const plays = info.embedUrl !== null ? ' · plays inline' : '';
  hint.appendChild(document.createTextNode(`${label}${plays}`));
  if (info.kind !== spec.id && info.kind !== 'url' && paneOptions.onSuggestKind !== undefined) {
    const onSuggest = paneOptions.onSuggestKind;
    hint.appendChild(document.createTextNode(` — looks like a ${kindSpec(info.kind).label.toLowerCase()}, `));
    const btn = el('button', 'spaces-kindform-suggest', `file it as ${kindSpec(info.kind).label}`);
    btn.type = 'button';
    btn.addEventListener('click', () => onSuggest(info.kind));
    hint.appendChild(btn);
  }
}

function buildFormBlock(block: HTMLElement, spec: AssetKindSpec): void {
  const create = spec.create;
  if (create === null) return;
  const grid = el('div', 'spaces-kindform-fields');
  for (const f of spec.fields) {
    if (f.readOnly === true) continue;
    grid.appendChild(buildFieldRow(f, spec.id));
  }
  block.appendChild(grid);
  if (create.notesLabel !== undefined) {
    const id = 'spaces-kindform-notes';
    block.appendChild(labelRow(create.notesLabel, 'Markdown', id));
    const ta = document.createElement('textarea');
    ta.id = id;
    ta.className = 'spaces-new-asset-textarea spaces-kindform-notes';
    ta.rows = 6;
    if (create.notesPlaceholder !== undefined) ta.placeholder = create.notesPlaceholder;
    block.appendChild(ta);
  }
}

function buildFieldRow(field: FieldSpec, kind: string): HTMLElement {
  const row = el('div', `spaces-kindform-field is-${field.type}${field.required === true ? ' is-required' : ''}`);
  const id = `spaces-kindform-${kind}-${field.key}`;
  const lab = document.createElement('label');
  lab.className = 'spaces-new-asset-label';
  lab.htmlFor = id;
  lab.textContent = field.required === true ? `${field.label} *` : field.label;
  row.appendChild(lab);
  const control = buildFieldControl(field, undefined, { className: field.type === 'multiline' ? 'spaces-new-asset-textarea' : 'spaces-new-asset-input', id });
  control.setAttribute('data-kindform-field', field.key);
  row.appendChild(control);
  if (field.hint !== undefined) row.appendChild(el('span', 'spaces-new-asset-label-hint', field.hint));
  return row;
}

// ─── Draft → payload ──────────────────────────────────────────────────

export interface RegistryDraft {
  kind: string;
  mode: CreateMode;
  body: string;
  file: File | null;
  link: LinkInfo | null;
  linkRaw: string;
  notes: string;
  /** Typed fields as the user filled them (parsed). */
  fields: Record<string, string | number | boolean | Array<string | number | boolean | null> | null>;
}

/** Read the pane. Null when no registry pane is mounted. */
export function readRegistryDraft(): RegistryDraft | null {
  if (pane === null || paneRoot === null) return null;
  const body = paneRoot.querySelector<HTMLTextAreaElement>('.spaces-kindform-body')?.value ?? '';
  const linkInput = paneRoot.querySelector<HTMLInputElement>('.spaces-kindform-link');
  const linkRaw = linkInput?.value.trim() ?? '';
  const link = linkRaw.length > 0 ? describeLink(linkRaw) : null;
  const notes = paneRoot.querySelector<HTMLTextAreaElement>('.spaces-kindform-notes')?.value ?? '';
  const fields: RegistryDraft['fields'] = {};
  const spec = kindSpec(pane.kind);
  for (const control of Array.from(paneRoot.querySelectorAll<HTMLElement>('[data-kindform-field]'))) {
    const key = control.getAttribute('data-kindform-field') ?? '';
    const field = spec.fields.find((f) => f.key === key);
    if (field === undefined) continue;
    const raw = readFieldControl(control);
    if (raw.trim().length === 0) continue;
    const parsed = parseFieldInput(field, raw);
    if (parsed !== null) fields[key] = parsed;
  }
  return { kind: pane.kind, mode: pane.mode, body, file: pane.file, link, linkRaw, notes, fields };
}

/** The first problem with a draft, as a sentence, or null when it can go. */
export function validateRegistryDraft(draft: RegistryDraft): string | null {
  const spec = kindSpec(draft.kind);
  switch (draft.mode) {
    case 'paste':
      if (draft.body.trim().length === 0) return `Paste the ${(spec.create?.bodyLabel ?? 'content').toLowerCase()} first — that is the asset.`;
      break;
    case 'upload':
      if (draft.file === null) return 'Choose a file to upload.';
      break;
    case 'link':
      if (draft.linkRaw.length === 0) return 'Paste the address first.';
      if (draft.link === null) return 'That is not a web address. It needs to start with http:// or https://.';
      break;
    case 'form':
      break;
    default:
      break;
  }
  for (const f of spec.fields) {
    if (f.required === true && draft.mode === 'form' && (draft.fields[f.key] === undefined || draft.fields[f.key] === null)) {
      return `${f.label} is required.`;
    }
  }
  if (draft.kind === 'tool' && draft.mode === 'form') {
    const type = draft.fields['tool_type'];
    const endpoint = draft.fields['tool_endpoint'];
    if (type !== 'cli' && type !== 'other' && (endpoint === undefined || endpoint === null)) {
      return 'An endpoint is required for this tool type.';
    }
  }
  return null;
}

/**
 * Metadata a body implies for a kind — counts, shapes, tokens, turns.
 * Pure; keys match the registry's field keys so the Details section
 * shows them. Never throws on odd input.
 */
export function deriveBodyMetadata(kind: string, body: string, fileName = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const t = body.trim();
  if (t.length === 0) return out;
  const lines = t.split(/\r?\n/);
  switch (kind) {
    case 'code': {
      out['lineCount'] = lines.length;
      const ext = fileExtension(fileName);
      const byExt = ext.length > 0 ? LANGUAGE_BY_EXTENSION[ext] : undefined;
      const shebang = /^#!.*\b(python|node|bash|sh|zsh|ruby|perl)\b/.exec(lines[0] ?? '');
      const guessed = byExt ?? (shebang !== null ? (shebang[1] === 'node' ? 'javascript' : shebang[1] === 'sh' || shebang[1] === 'zsh' ? 'shell' : shebang[1]) : guessLanguage(t));
      if (guessed !== null) out['language'] = guessed;
      break;
    }
    case 'data': {
      if (t.startsWith('{') || t.startsWith('[')) {
        try {
          const parsed = JSON.parse(t) as unknown;
          out['data_format'] = 'json';
          if (Array.isArray(parsed)) {
            out['rowCount'] = parsed.length;
            const first = parsed[0];
            if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
              const keys = Object.keys(first as Record<string, unknown>);
              out['columnCount'] = keys.length;
              out['headers'] = keys.slice(0, 40);
            }
          } else if (parsed !== null && typeof parsed === 'object') {
            const keys = Object.keys(parsed as Record<string, unknown>);
            out['columnCount'] = keys.length;
            out['headers'] = keys.slice(0, 40);
          }
        } catch {
          out['data_format'] = 'json';
        }
      } else {
        const ext = fileExtension(fileName);
        const delim = (lines[0] ?? '').includes('\t') ? '\t' : ',';
        out['data_format'] = ext === 'tsv' || delim === '\t' ? 'tsv' : 'csv';
        const header = parseDelimitedHead(t, 1, 200)[0] ?? [];
        out['columnCount'] = header.length;
        out['headers'] = header.slice(0, 40);
        out['rowCount'] = Math.max(0, lines.filter((l) => l.trim().length > 0).length - 1);
      }
      break;
    }
    case 'styleguide': {
      let colors = 0;
      let fonts: string[] = [];
      try {
        const parsed = JSON.parse(t) as Record<string, unknown>;
        colors = flattenColors(parsed['colors']).length;
        fonts = flattenTypography(parsed['typography']).map((x) => x.family);
      } catch {
        colors = extractHexColors(t, 64).length;
        fonts = extractFontFamilies(t);
      }
      if (colors === 0) colors = extractHexColors(t, 64).length;
      out['styleguide_colors'] = colors;
      if (fonts.length > 0) out['styleguide_fonts'] = Array.from(new Set(fonts)).slice(0, 8);
      break;
    }
    case 'conversation': {
      const turns = parseConversation(t, 5000);
      out['conversation_messages'] = turns.length;
      const provider = /chatgpt|openai/i.test(t) ? 'chatgpt' : /claude|anthropic/i.test(t) ? 'claude' : /gemini/i.test(t) ? 'gemini' : /copilot/i.test(t) ? 'copilot' : null;
      if (provider !== null) out['conversation_provider'] = provider;
      const model = /"model"\s*:\s*"([^"]{3,60})"/.exec(t);
      if (model !== null && model[1] !== undefined) out['conversation_model'] = model[1];
      break;
    }
    case 'journey':
      out['journey_stage_count'] = lines.filter((l) => /^##\s+/.test(l)).length;
      break;
    case 'notebook': {
      const nb = parseNotebook(t);
      if (nb !== null) {
        out['notebook_cells'] = nb.cells.length;
        out['notebook_code_cells'] = nb.cells.filter((c) => c.type === 'code').length;
        if (nb.kernel.length > 0) out['notebook_kernel'] = nb.kernel;
        if (nb.language.length > 0) out['notebook_language'] = nb.language;
      }
      break;
    }
    case 'flow': {
      try {
        const parsed = JSON.parse(t) as Record<string, unknown>;
        const id = parsed['flowId'] ?? parsed['id'];
        if (typeof id === 'string') out['flow_id'] = id;
        const bot = parsed['botId'];
        if (typeof bot === 'string') out['flow_bot_id'] = bot;
        const steps = countSteps(parsed);
        if (steps > 0) out['flow_step_count'] = steps;
      } catch {
        // not JSON — leave it
      }
      break;
    }
    default:
      break;
  }
  return out;
}

function countSteps(o: Record<string, unknown>): number {
  const data = (o['data'] ?? o) as Record<string, unknown>;
  const trees = data['trees'];
  if (trees !== null && typeof trees === 'object') {
    let n = 0;
    for (const tree of Object.values(trees as Record<string, unknown>)) {
      const steps = (tree as Record<string, unknown> | null)?.['steps'];
      if (Array.isArray(steps)) n += steps.length;
      else if (steps !== null && typeof steps === 'object') n += Object.keys(steps as Record<string, unknown>).length;
    }
    return n;
  }
  const steps = data['steps'];
  return Array.isArray(steps) ? steps.length : 0;
}

/** A cheap language guess from the text itself, for pasted code. */
export function guessLanguage(src: string): string | null {
  const head = src.slice(0, 2000);
  if (/^\s*(import\s+\w+|from\s+\w+\s+import|def\s+\w+\(|print\()/m.test(head) && !/;\s*$/m.test(head)) return 'python';
  if (/\b(interface|type)\s+\w+\s*=?\s*\{|:\s*(string|number|boolean)\b/.test(head)) return 'typescript';
  if (/\b(const|let|var|function)\b|=>/.test(head)) return 'javascript';
  if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE TABLE|WITH)\b/im.test(head)) return 'sql';
  if (/^\s*#!\/bin\/(ba|z)?sh|^\s*(echo|export|if \[)/m.test(head)) return 'shell';
  if (/^\s*<(!doctype|html|div|span|p|section)\b/i.test(head)) return 'html';
  if (/^\s*[.#]?[\w-]+\s*\{[^}]*:[^}]*\}/m.test(head)) return 'css';
  if (/^\s*[{[]/.test(head)) return 'json';
  if (/^\s*[\w-]+:\s+\S/m.test(head) && !/[;{}]/.test(head)) return 'yaml';
  if (/\bfunc\s+\w+\(|package\s+main/.test(head)) return 'go';
  if (/\bfn\s+\w+\(|let\s+mut\b/.test(head)) return 'rust';
  return null;
}

export interface CreatePayload {
  kind: string;
  title: string;
  content?: string;
  sourceUrl?: string;
  mimeType?: string;
  metadata: Record<string, unknown>;
  /** Present for upload mode — the dialog runs the one upload pipeline. */
  file?: File;
  /** True when the body is text worth summarising. */
  hasContent: boolean;
}

/**
 * Turn a draft into what `items.create` / the upload pipeline need.
 * The title falls back to the link's or file's name. The typed fields
 * the user filled ride along as metadata; derived facts join them.
 */
export function buildCreatePayload(draft: RegistryDraft, title: string): CreatePayload {
  const spec = kindSpec(draft.kind);
  const typed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(draft.fields)) {
    if (v !== null) typed[k] = v;
  }
  let finalTitle = title.trim();
  switch (draft.mode) {
    case 'paste': {
      const body = draft.body;
      const derived = deriveBodyMetadata(draft.kind, body);
      if (finalTitle.length === 0) finalTitle = titleFromBody(spec, body);
      return {
        kind: draft.kind,
        title: finalTitle,
        content: body,
        mimeType: spec.contentIsCode ? (draft.kind === 'data' && derived['data_format'] === 'json' ? 'application/json' : draft.kind === 'data' ? 'text/csv' : 'text/plain') : 'text/markdown',
        metadata: { ...derived, ...typed },
        hasContent: body.trim().length > 0,
      };
    }
    case 'upload': {
      const file = draft.file as File;
      if (finalTitle.length === 0) finalTitle = file.name;
      return { kind: draft.kind, title: finalTitle, metadata: { ...typed }, file, hasContent: false };
    }
    case 'link': {
      const info = draft.link as LinkInfo;
      // A recognised provider link rarely carries its own name in the
      // path (Slides, YouTube, Figma ids): say what it is and where
      // from; a plain link keeps its last meaningful path word.
      if (finalTitle.length === 0) finalTitle = titleFromLink(info, spec);
      const linked = linkMetadata(info);
      const meta: Record<string, unknown> = { ...linked, ...typed };
      if (draft.kind === 'monitor') meta['monitor_url'] = info.url;
      if (draft.kind === 'tool' && meta['tool_endpoint'] === undefined) meta['tool_endpoint'] = info.url;
      return { kind: draft.kind, title: finalTitle, sourceUrl: info.url, metadata: meta, hasContent: false };
    }
    case 'form':
    default: {
      const notes = draft.notes;
      const meta: Record<string, unknown> = { ...typed };
      let sourceUrl: string | undefined;
      const endpoint = draft.kind === 'tool' ? typed['tool_endpoint'] : draft.kind === 'monitor' ? typed['monitor_url'] : undefined;
      if (typeof endpoint === 'string') {
        const normalized = normalizeHttpUrl(endpoint);
        if (normalized !== null) {
          sourceUrl = normalized;
          const info = describeLink(normalized);
          if (info !== null) meta['link_domain'] = info.domain;
        }
      }
      if (finalTitle.length === 0) finalTitle = titleFromForm(draft, meta);
      return {
        kind: draft.kind,
        title: finalTitle,
        content: notes,
        mimeType: 'text/markdown',
        ...(sourceUrl !== undefined ? { sourceUrl } : {}),
        metadata: meta,
        hasContent: notes.trim().length > 0,
      };
    }
  }
}

const LINK_NOUNS: Readonly<Record<string, string>> = {
  presentation: 'deck',
  video: 'video',
  audio: 'audio',
  image: 'image',
  design: 'design',
  flow: 'flow',
  data: 'sheet',
  document: 'doc',
};

function titleFromLink(info: LinkInfo, spec: AssetKindSpec): string {
  const fromPath = titleFromUrl(info.url);
  const isDomainOnly = fromPath === info.domain;
  if (info.provider !== 'link' && info.provider !== 'github' && (isDomainOnly || info.id !== null)) {
    return `${info.providerLabel} ${LINK_NOUNS[spec.id] ?? spec.label.toLowerCase()}`;
  }
  return fromPath;
}

function titleFromBody(spec: AssetKindSpec, body: string): string {
  const first = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const cleaned = first.replace(/^#+\s*/, '').replace(/[`*_>{}\[\]]/g, '').trim();
  if (cleaned.length >= 3 && cleaned.length <= 80 && !spec.contentIsCode) return cleaned;
  const stamp = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${spec.label} · ${stamp}`;
}

function titleFromForm(draft: RegistryDraft, meta: Record<string, unknown>): string {
  const spec = kindSpec(draft.kind);
  if (draft.kind === 'tool') {
    const endpoint = meta['tool_endpoint'];
    if (typeof endpoint === 'string') return titleFromUrl(endpoint);
  }
  if (draft.kind === 'monitor') {
    const url = meta['monitor_url'];
    if (typeof url === 'string') return `Watch ${titleFromUrl(url)}`;
  }
  if (draft.kind === 'meeting') {
    const at = meta['meeting_at'];
    const d = typeof at === 'string' ? new Date(at) : null;
    if (d !== null && !Number.isNaN(d.getTime())) return `Meeting · ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  }
  const stamp = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${spec.label} · ${stamp}`;
}

/** Everything the test harness and the dialog need about the registry's picker order. */
export function pickerKindIds(): string[] {
  return [...creatableKinds().map((s) => s.id), EXISTING_MODE];
}

export { ASSET_KINDS, kindGlyph, fieldValueToBridgeString };
