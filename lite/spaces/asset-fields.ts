/**
 * Typed field values — format for display, parse from an input, and
 * build the matching control (ADR-098).
 *
 * One place decides what a `duration` looks like ("1h 05m"), what a
 * `datetime` control returns (an ISO string, never the browser's local
 * form), and how a `list` is typed (comma-separated) — so the Add-asset
 * form, the Details section, the tile facts, and the tests agree.
 *
 * DOM-building helpers live here too; the module is renderer-side. The
 * registry (`asset-kinds.ts`) stays pure and is imported by main.
 */

import type { FieldSpec } from './asset-kinds.js';

/** Metadata values the bag can hold (mirrors `MetadataValue` in types.ts). */
export type FieldValue = string | number | boolean | null | Array<string | number | boolean | null>;

// ─── Formatting ───────────────────────────────────────────────────────

/** Seconds → "42s", "3m 20s", "45m", "1h 05m". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return sec === 0 ? `${m}m` : `${m}m ${sec}s`;
}

/** ISO / epoch-ms → "Sep 9, 2026, 10:00 AM" in the viewer's locale. */
export function formatDateTime(value: unknown): string {
  const d = typeof value === 'number' ? new Date(value) : typeof value === 'string' ? new Date(value) : null;
  if (d === null || Number.isNaN(d.getTime())) return typeof value === 'string' ? value : '';
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** A field's stored value as the rail shows it. Empty string when unset. */
export function formatFieldValue(field: FieldSpec, value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  switch (field.type) {
    case 'select': {
      const s = String(value);
      const opt = field.options?.find((o) => o.value === s);
      return opt !== undefined ? opt.label : s;
    }
    case 'boolean':
      return value === true || value === 'true' ? 'Yes' : value === false || value === 'false' ? 'No' : String(value);
    case 'datetime':
      return formatDateTime(value);
    case 'duration': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? formatDuration(n) : String(value);
    }
    case 'list':
      return Array.isArray(value) ? value.map((v) => String(v)).join(', ') : String(value);
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? (Number.isInteger(n) ? String(n) : n.toFixed(2)) : String(value);
    }
    default:
      return Array.isArray(value) ? value.map((v) => String(v)).join(', ') : String(value);
  }
}

// ─── Parsing ──────────────────────────────────────────────────────────

/**
 * "1h 5m", "45m", "3:20", "1:02:03", "90s", or a bare number — bare
 * numbers are MINUTES (what a person types for a meeting), never
 * seconds. Returns seconds, or null when unreadable.
 */
export function parseDuration(raw: string): number | null {
  const t = raw.trim().toLowerCase();
  if (t.length === 0) return null;
  const colon = /^(\d{1,3}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (colon !== null) {
    const a = Number(colon[1]);
    const b = Number(colon[2]);
    const c = colon[3] !== undefined ? Number(colon[3]) : null;
    return c !== null ? a * 3600 + b * 60 + c : a * 60 + b;
  }
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 60);
  let total = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    matched = true;
    const n = Number(m[1]);
    const unit = (m[2] ?? '')[0];
    total += unit === 'h' ? n * 3600 : unit === 'm' ? n * 60 : n;
  }
  return matched ? Math.round(total) : null;
}

/** ISO string → the value a `datetime-local` input wants (local clock). */
export function toDatetimeLocalValue(value: unknown): string {
  const d = typeof value === 'number' ? new Date(value) : typeof value === 'string' && value.length > 0 ? new Date(value) : null;
  if (d === null || Number.isNaN(d.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `datetime-local` value → ISO (UTC) string, or '' when empty/invalid. */
export function fromDatetimeLocalValue(local: string): string {
  if (local.trim().length === 0) return '';
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/**
 * The raw string an input produced → the metadata value to store. The
 * bridge's own coercion (`coerceMetadataValue`) would turn "45" into a
 * number anyway; parsing here means durations and dates land in one
 * canonical shape regardless of how they were typed. Returns null for
 * "clear this field".
 */
export function parseFieldInput(field: FieldSpec, raw: string): FieldValue | null {
  const t = raw.trim();
  if (t.length === 0) return null;
  switch (field.type) {
    case 'number': {
      const n = Number(t.replace(/,/g, ''));
      return Number.isFinite(n) ? n : null;
    }
    case 'boolean':
      return /^(true|yes|on|1)$/i.test(t) ? true : /^(false|no|off|0)$/i.test(t) ? false : null;
    case 'datetime':
      return fromDatetimeLocalValue(t) || (Number.isNaN(new Date(t).getTime()) ? null : new Date(t).toISOString());
    case 'duration':
      return parseDuration(t);
    case 'list':
      return t.split(/[,\n]/).map((s) => s.trim()).filter((s) => s.length > 0);
    case 'url':
      return /^https?:\/\//i.test(t) ? t : `https://${t}`;
    default:
      return t;
  }
}

/** The string form the metadata bridge accepts for a parsed value. */
export function fieldValueToBridgeString(value: FieldValue): string {
  if (value === null) return '';
  if (Array.isArray(value)) return value.map((v) => String(v)).join(', ');
  return String(value);
}

// ─── Controls ─────────────────────────────────────────────────────────

export interface ControlOptions {
  /** Class the control wears (the dialog and the rail style differently). */
  className: string;
  /** Element id for label association (optional). */
  id?: string;
}

/** Build the input for a field, pre-filled with `current`. */
export function buildFieldControl(field: FieldSpec, current: unknown, opts: ControlOptions): HTMLElement {
  const base = opts.className;
  switch (field.type) {
    case 'select': {
      const select = document.createElement('select');
      select.className = base;
      if (opts.id !== undefined) select.id = opts.id;
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = '—';
      select.appendChild(blank);
      for (const o of field.options ?? []) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        if (current !== undefined && current !== null && String(current) === o.value) opt.selected = true;
        select.appendChild(opt);
      }
      return select;
    }
    case 'boolean': {
      const select = document.createElement('select');
      select.className = base;
      if (opts.id !== undefined) select.id = opts.id;
      for (const [value, label] of [['', '—'], ['true', 'Yes'], ['false', 'No']] as const) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        if ((current === true && value === 'true') || (current === false && value === 'false')) opt.selected = true;
        select.appendChild(opt);
      }
      return select;
    }
    case 'multiline': {
      const ta = document.createElement('textarea');
      ta.className = base;
      ta.rows = 4;
      if (opts.id !== undefined) ta.id = opts.id;
      if (field.placeholder !== undefined) ta.placeholder = field.placeholder;
      ta.value = current === undefined || current === null ? '' : String(current);
      return ta;
    }
    case 'datetime': {
      const input = document.createElement('input');
      input.type = 'datetime-local';
      input.className = base;
      if (opts.id !== undefined) input.id = opts.id;
      input.value = toDatetimeLocalValue(current);
      return input;
    }
    default: {
      const input = document.createElement('input');
      input.type = field.type === 'url' ? 'url' : field.type === 'number' ? 'text' : 'text';
      input.className = base;
      if (opts.id !== undefined) input.id = opts.id;
      input.autocomplete = 'off';
      if (field.type === 'number') input.inputMode = 'decimal';
      if (field.placeholder !== undefined) input.placeholder = field.placeholder;
      else if (field.type === 'duration') input.placeholder = '45m, 1h 05m, 3:20';
      else if (field.type === 'list') input.placeholder = 'one, two, three';
      input.value =
        current === undefined || current === null
          ? ''
          : field.type === 'duration' && typeof current === 'number'
            ? formatDuration(current)
            : Array.isArray(current)
              ? current.map((v) => String(v)).join(', ')
              : String(current);
      return input;
    }
  }
}

/** The raw string a control currently holds. */
export function readFieldControl(control: HTMLElement): string {
  if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement) {
    return control.value;
  }
  return '';
}
