/**
 * The Details section of the detail rail — an asset's typed fields,
 * shown and edited in place (ADR-098).
 *
 * The raw Metadata table stays for everything else; this section owns
 * the keys the kind's registry row declares (`kindFields`), renders each
 * with the control its type deserves (a select for a select, a date
 * picker for a date, "Yes/No" for a flag), and writes through the same
 * metadata callbacks the raw table uses. Link-based kinds get a Link row
 * that edits `sourceUrl` through `onSourceUrlSave`.
 *
 * Pure DOM; callbacks own the bridge. Exported for jsdom tests.
 */

import { kindFields, kindSpec, type FieldSpec } from './asset-kinds.js';
import {
  buildFieldControl,
  fieldValueToBridgeString,
  formatFieldValue,
  parseFieldInput,
  readFieldControl,
} from './asset-fields.js';

export interface DetailsItem {
  id: string;
  kind: string;
  metadata?: Record<string, unknown>;
  sourceUrl?: string;
  fileKey?: string;
}

export interface DetailsCallbacks {
  onMetadataValueEdit?: (key: string, value: string) => Promise<void>;
  onMetadataRemove?: (key: string) => Promise<void>;
  onSourceUrlSave?: (next: string) => Promise<void>;
}

/** Kinds whose address is the thing itself — the Link row leads. */
const LINK_KINDS: ReadonlySet<string> = new Set(['url', 'video', 'audio', 'image', 'presentation', 'design', 'flow', 'monitor', 'tool']);

function messageFrom(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Build the section, or null when the kind declares no fields and has
 * no link row — a text note gets nothing extra above its metadata.
 */
export function buildKindDetails(item: DetailsItem, edit?: DetailsCallbacks): HTMLElement | null {
  const fields = kindFields(item.kind).filter((f) => f.createOnly !== true);
  const wantsLink = LINK_KINDS.has(item.kind);
  if (fields.length === 0 && !wantsLink) return null;
  const meta = item.metadata ?? {};

  const section = document.createElement('section');
  section.className = 'spaces-detail-kinddetails';
  section.setAttribute('data-kind', item.kind);

  const headingRow = document.createElement('div');
  headingRow.className = 'spaces-detail-metadata-heading-row';
  const heading = document.createElement('h3');
  heading.className = 'spaces-detail-metadata-heading';
  heading.textContent = `${kindSpec(item.kind).label} details`;
  headingRow.appendChild(heading);
  section.appendChild(headingRow);

  const table = document.createElement('dl');
  table.className = 'spaces-detail-kinddetails-table';

  if (wantsLink) table.appendChild(buildLinkRow(item, edit));

  for (const field of fields) {
    table.appendChild(buildFieldRow(field, meta[field.key], edit));
  }
  section.appendChild(table);
  return section;
}

function buildLinkRow(item: DetailsItem, edit?: DetailsCallbacks): HTMLElement {
  const row = document.createElement('div');
  row.className = 'spaces-detail-kinddetails-row is-link';
  row.setAttribute('data-key', 'sourceUrl');
  const dt = document.createElement('dt');
  dt.className = 'spaces-detail-kinddetails-key';
  dt.textContent = 'Link';
  row.appendChild(dt);
  const dd = document.createElement('dd');
  dd.className = 'spaces-detail-kinddetails-value';
  const url = typeof item.sourceUrl === 'string' ? item.sourceUrl.trim() : '';
  if (url.length > 0) {
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = url;
    a.title = url;
    dd.appendChild(a);
  } else {
    dd.textContent = '—';
    dd.classList.add('is-empty');
  }
  row.appendChild(dd);
  if (edit?.onSourceUrlSave !== undefined) {
    const onSave = edit.onSourceUrlSave;
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'spaces-detail-kinddetails-edit';
    editBtn.textContent = url.length > 0 ? 'Edit' : 'Set';
    editBtn.setAttribute('aria-label', 'Edit link');
    editBtn.addEventListener('click', () => {
      startEdit(row, dd, editBtn, url, { key: 'sourceUrl', label: 'Link', type: 'url' }, async (raw) => {
        const t = raw.trim();
        if (t.length > 0 && !/^https?:\/\//i.test(t)) {
          await onSave(`https://${t}`);
        } else {
          await onSave(t);
        }
      });
    });
    row.appendChild(editBtn);
  }
  return row;
}

function buildFieldRow(field: FieldSpec, value: unknown, edit?: DetailsCallbacks): HTMLElement {
  const row = document.createElement('div');
  row.className = `spaces-detail-kinddetails-row is-${field.type}${field.readOnly === true ? ' is-readonly' : ''}`;
  row.setAttribute('data-key', field.key);

  const dt = document.createElement('dt');
  dt.className = 'spaces-detail-kinddetails-key';
  dt.textContent = field.label;
  if (field.hint !== undefined) dt.title = field.hint;
  row.appendChild(dt);

  const dd = document.createElement('dd');
  dd.className = 'spaces-detail-kinddetails-value';
  const text = formatFieldValue(field, value);
  if (text.length > 0) {
    if (field.type === 'url' && /^https?:\/\//i.test(text)) {
      const a = document.createElement('a');
      a.href = text;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = text;
      dd.appendChild(a);
    } else {
      dd.textContent = text;
    }
  } else {
    dd.textContent = field.readOnly === true ? 'Not recorded' : '—';
    dd.classList.add('is-empty');
  }
  row.appendChild(dd);

  const editable = field.readOnly !== true && edit?.onMetadataValueEdit !== undefined;
  if (editable && edit?.onMetadataValueEdit !== undefined) {
    const onEdit = edit.onMetadataValueEdit;
    const onRemove = edit.onMetadataRemove;
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'spaces-detail-kinddetails-edit';
    editBtn.textContent = text.length > 0 ? 'Edit' : 'Set';
    editBtn.setAttribute('aria-label', `Edit ${field.label}`);
    editBtn.addEventListener('click', () => {
      startEdit(row, dd, editBtn, value, field, async (raw) => {
        const parsed = parseFieldInput(field, raw);
        if (parsed === null) {
          if (raw.trim().length > 0) throw new Error(`Could not read “${raw.trim()}” as a ${field.type}.`);
          if (onRemove !== undefined && value !== undefined && value !== null && value !== '') {
            await onRemove(field.key);
          }
          return;
        }
        await onEdit(field.key, fieldValueToBridgeString(parsed));
      });
    });
    row.appendChild(editBtn);
  }
  return row;
}

/**
 * Swap the value cell for the field's control with Save / Cancel.
 * Enter saves (Cmd/Ctrl+Enter in a textarea), Escape cancels, a select
 * or date saves on change. Errors show inline and keep the control.
 */
function startEdit(
  row: HTMLElement,
  dd: HTMLElement,
  editBtn: HTMLButtonElement,
  current: unknown,
  field: FieldSpec,
  commit: (raw: string) => Promise<void>
): void {
  if (row.classList.contains('is-editing')) return;
  row.classList.add('is-editing');
  editBtn.hidden = true;
  const control = buildFieldControl(field, current, { className: 'spaces-detail-kinddetails-control' });
  const box = document.createElement('div');
  box.className = 'spaces-detail-kinddetails-editor';
  box.appendChild(control);
  const actions = document.createElement('div');
  actions.className = 'spaces-detail-kinddetails-actions';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'spaces-detail-kinddetails-save';
  save.textContent = 'Save';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'spaces-detail-kinddetails-cancel';
  cancel.textContent = 'Cancel';
  actions.appendChild(save);
  actions.appendChild(cancel);
  box.appendChild(actions);
  const error = document.createElement('p');
  error.className = 'spaces-detail-kinddetails-error';
  error.hidden = true;
  box.appendChild(error);

  const original = dd;
  dd.replaceWith(box);

  const finish = (): void => {
    box.replaceWith(original);
    row.classList.remove('is-editing');
    editBtn.hidden = false;
  };
  let busy = false;
  const doSave = (): void => {
    if (busy) return;
    busy = true;
    save.disabled = true;
    error.hidden = true;
    commit(readFieldControl(control))
      .then(() => {
        // The parent refreshes the rail on success; if it did not
        // (tests, or a no-op), restore the static cell.
        if (box.isConnected) finish();
      })
      .catch((err: unknown) => {
        error.textContent = messageFrom(err);
        error.hidden = false;
        busy = false;
        save.disabled = false;
      });
  };
  save.addEventListener('click', doSave);
  cancel.addEventListener('click', finish);
  control.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      finish();
    } else if (ev.key === 'Enter' && (!(control instanceof HTMLTextAreaElement) || ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      doSave();
    }
  });
  if (control instanceof HTMLSelectElement) control.addEventListener('change', doSave);
  if (control instanceof HTMLInputElement && control.type === 'datetime-local') control.addEventListener('change', doSave);
  if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
    control.focus();
    control.select();
  } else {
    control.focus();
  }
}
