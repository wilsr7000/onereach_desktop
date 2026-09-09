/**
 * Every shipped converter, strategy by strategy (ADR-100). The
 * expectations mirror the full app's converter tests so a port that
 * drifts from the original semantics fails here.
 */

import { describe, it, expect } from 'vitest';
import { csvToJson, parseDelimited, inferType, resolveDelimiter } from '../../convert/converters/csv-to-json.js';
import { mdToHtml, titleFromMarkdown } from '../../convert/converters/md-to-html.js';

const CSV = 'name,age,active\nAlice,30,true\nBob,25,false\n';

describe('csv-to-json', () => {
  it('auto-type infers numbers and booleans', async () => {
    const r = await csvToJson.execute(CSV, 'auto-type', { indent: 2 });
    const parsed = JSON.parse(r.output) as Array<Record<string, unknown>>;
    expect(parsed[0]).toEqual({ name: 'Alice', age: 30, active: true });
    expect(parsed[1]?.['active']).toBe(false);
    expect(r.stats).toMatchObject({ rowCount: 2, columnCount: 3, delimiter: ',' });
  });
  it('string-only keeps every value a string', async () => {
    const r = await csvToJson.execute(CSV, 'string-only', {});
    const parsed = JSON.parse(r.output) as Array<Record<string, unknown>>;
    expect(parsed[0]?.['age']).toBe('30');
    expect(typeof parsed[0]?.['active']).toBe('string');
  });
  it('nested groups rows by the first column', async () => {
    const r = await csvToJson.execute('category,item,qty\nfruit,apple,3\nfruit,pear,1\nveg,leek,2\n', 'nested', {});
    const parsed = JSON.parse(r.output) as { groupedBy: string; groups: Record<string, unknown[]> };
    expect(parsed.groupedBy).toBe('category');
    expect(parsed.groups['fruit']).toHaveLength(2);
    expect(parsed.groups['veg']).toHaveLength(1);
  });
  it('handles quoted fields with commas, newlines, and doubled quotes; skips blank lines', () => {
    const rows = parseDelimited('a,b\n"x, y","say ""hi"""\n\n"multi\nline",z\r\n');
    expect(rows).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['multi\nline', 'z']]);
  });
  it('detects tabs and semicolons, honours an explicit delimiter, and compacts on indent 0', async () => {
    expect(resolveDelimiter('a\tb\n1\t2', undefined)).toBe('\t');
    expect(resolveDelimiter('a;b\n1;2', undefined)).toBe(';');
    expect(resolveDelimiter('a,b', '|')).toBe('|');
    const r = await csvToJson.execute('a\tb\n1\t2\n', 'auto-type', { indent: 0 });
    expect(r.output).toBe('[{"a":1,"b":2}]');
    expect(r.stats?.['delimiter']).toBe('tab');
  });
  it('warns on ragged rows and refuses a header-only file', async () => {
    const r = await csvToJson.execute('a,b\n1\n', 'auto-type', {});
    expect(r.warnings?.[0]).toMatch(/1 row/);
    await expect(csvToJson.execute('a,b\n', 'auto-type', {})).rejects.toThrow(/header row/);
  });
  it('inferType: ints, floats, booleans, null words, leading-zero strings stay strings', () => {
    expect(inferType('42')).toBe(42);
    expect(inferType('3.5')).toBe(3.5);
    expect(inferType('TRUE')).toBe(true);
    expect(inferType('null')).toBeNull();
    expect(inferType('')).toBeNull();
    expect(inferType('007')).toBe(7);
    expect(inferType('1e5')).toBe('1e5');
  });
});

describe('md-to-html', () => {
  const MD = '# Title\n\nSome *text* with a [link](https://x.io).\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
  it('standard renders headings, emphasis, links — no tables', async () => {
    const r = await mdToHtml.execute(MD, 'standard', {});
    expect(r.output).toContain('<h1>Title</h1>');
    expect(r.output).toContain('<em>text</em>');
    expect(r.output).toContain('href="https://x.io"');
    expect(r.output).not.toContain('<table>');
    expect(r.stats?.['headings']).toBe(1);
  });
  it('enhanced renders GitHub tables and keeps line breaks', async () => {
    // A blank line first: GFM continues a table until one (a pipe-less line is still a row).
    const r = await mdToHtml.execute(MD + '\nline one\nline two\n', 'enhanced', {});
    expect(r.output).toContain('<table>');
    expect(r.output).toContain('<br>');
  });
  it('styled wraps a full page with a title from the first heading, escaped', async () => {
    const r = await mdToHtml.execute('# A <b>title</b>\n\nbody', 'styled', {});
    expect(r.output.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(r.output).toContain('<title>A &lt;b&gt;title&lt;/b&gt;</title>');
    expect(r.output).toContain('<style>');
    expect(r.stats?.['isDocument']).toBe(true);
    const custom = await mdToHtml.execute('plain', 'styled', { title: 'Report' });
    expect(custom.output).toContain('<title>Report</title>');
  });
  it('titleFromMarkdown falls back to the first line, then "Document"', () => {
    expect(titleFromMarkdown('# Hello ##')).toBe('Hello');
    expect(titleFromMarkdown('\n\nfirst line here\nmore')).toBe('first line here');
    expect(titleFromMarkdown('')).toBe('Document');
  });
});
