/**
 * ADR-098 — typed field values: one formatter, one parser, one
 * control builder, so the dialog, the Details section, and the tile
 * facts agree on what a duration or a date looks like.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import {
  buildFieldControl,
  fieldValueToBridgeString,
  formatDuration,
  formatFieldValue,
  fromDatetimeLocalValue,
  parseDuration,
  parseFieldInput,
  readFieldControl,
  toDatetimeLocalValue,
} from '../../spaces/asset-fields.js';
import type { FieldSpec } from '../../spaces/asset-kinds.js';

describe('durations', () => {
  it('formats seconds the way a person says them', () => {
    expect(formatDuration(42)).toBe('42s');
    expect(formatDuration(200)).toBe('3m 20s');
    expect(formatDuration(2700)).toBe('45m');
    expect(formatDuration(3900)).toBe('1h 05m');
  });
  it('parses colons, units, and bare minutes', () => {
    expect(parseDuration('3:20')).toBe(200);
    expect(parseDuration('1:02:03')).toBe(3723);
    expect(parseDuration('1h 5m')).toBe(3900);
    expect(parseDuration('45m')).toBe(2700);
    expect(parseDuration('90s')).toBe(90);
    expect(parseDuration('45')).toBe(2700);
    expect(parseDuration('soon')).toBeNull();
    expect(parseDuration('')).toBeNull();
  });
});

describe('formatFieldValue', () => {
  const select: FieldSpec = { key: 'k', label: 'K', type: 'select', options: [{ value: 'mcp', label: 'MCP server' }] };
  it('renders option labels, booleans, lists, numbers, durations, dates', () => {
    expect(formatFieldValue(select, 'mcp')).toBe('MCP server');
    expect(formatFieldValue(select, 'zzz')).toBe('zzz');
    expect(formatFieldValue({ key: 'b', label: 'B', type: 'boolean' }, true)).toBe('Yes');
    expect(formatFieldValue({ key: 'b', label: 'B', type: 'boolean' }, 'false')).toBe('No');
    expect(formatFieldValue({ key: 'l', label: 'L', type: 'list' }, ['a', 'b'])).toBe('a, b');
    expect(formatFieldValue({ key: 'n', label: 'N', type: 'number' }, 3.14159)).toBe('3.14');
    expect(formatFieldValue({ key: 'n', label: 'N', type: 'number' }, 7)).toBe('7');
    expect(formatFieldValue({ key: 'd', label: 'D', type: 'duration' }, 2700)).toBe('45m');
    expect(formatFieldValue({ key: 't', label: 'T', type: 'datetime' }, '2026-09-09T17:00:00.000Z')).toMatch(/2026/);
    expect(formatFieldValue({ key: 't', label: 'T', type: 'text' }, null)).toBe('');
  });
});

describe('parseFieldInput', () => {
  it('coerces by type and clears on blank', () => {
    expect(parseFieldInput({ key: 'n', label: 'N', type: 'number' }, '1,200')).toBe(1200);
    expect(parseFieldInput({ key: 'n', label: 'N', type: 'number' }, 'x')).toBeNull();
    expect(parseFieldInput({ key: 'b', label: 'B', type: 'boolean' }, 'yes')).toBe(true);
    expect(parseFieldInput({ key: 'b', label: 'B', type: 'boolean' }, 'off')).toBe(false);
    expect(parseFieldInput({ key: 'l', label: 'L', type: 'list' }, 'a, b,,c')).toEqual(['a', 'b', 'c']);
    expect(parseFieldInput({ key: 'u', label: 'U', type: 'url' }, 'example.com/x')).toBe('https://example.com/x');
    expect(parseFieldInput({ key: 'd', label: 'D', type: 'duration' }, '1h')).toBe(3600);
    expect(parseFieldInput({ key: 't', label: 'T', type: 'text' }, '   ')).toBeNull();
  });
  it('datetime round-trips through the local control value', () => {
    const local = toDatetimeLocalValue('2026-09-09T17:00:00.000Z');
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    const iso = fromDatetimeLocalValue(local);
    expect(new Date(iso).getTime()).toBe(new Date('2026-09-09T17:00:00.000Z').getTime());
    expect(parseFieldInput({ key: 't', label: 'T', type: 'datetime' }, local)).toBe(iso);
    expect(fromDatetimeLocalValue('')).toBe('');
  });
  it('bridge strings: lists join, null clears', () => {
    expect(fieldValueToBridgeString(['a', 'b'])).toBe('a, b');
    expect(fieldValueToBridgeString(null)).toBe('');
    expect(fieldValueToBridgeString(42)).toBe('42');
  });
});

describe('buildFieldControl', () => {
  it('builds the control each type deserves, pre-filled', () => {
    const sel = buildFieldControl({ key: 'k', label: 'K', type: 'select', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }, 'b', { className: 'c' });
    expect(sel).toBeInstanceOf(HTMLSelectElement);
    expect(readFieldControl(sel)).toBe('b');
    expect(sel.querySelectorAll('option').length).toBe(3); // blank + 2
    const bool = buildFieldControl({ key: 'b', label: 'B', type: 'boolean' }, false, { className: 'c' });
    expect(readFieldControl(bool)).toBe('false');
    const dt = buildFieldControl({ key: 't', label: 'T', type: 'datetime' }, '2026-09-09T17:00:00.000Z', { className: 'c', id: 'x' });
    expect((dt as HTMLInputElement).type).toBe('datetime-local');
    expect(dt.id).toBe('x');
    const dur = buildFieldControl({ key: 'd', label: 'D', type: 'duration' }, 2700, { className: 'c' });
    expect(readFieldControl(dur)).toBe('45m');
    const ta = buildFieldControl({ key: 'm', label: 'M', type: 'multiline' }, 'hi', { className: 'c' });
    expect(ta).toBeInstanceOf(HTMLTextAreaElement);
    const list = buildFieldControl({ key: 'l', label: 'L', type: 'list' }, ['a', 'b'], { className: 'c' });
    expect(readFieldControl(list)).toBe('a, b');
  });
});
