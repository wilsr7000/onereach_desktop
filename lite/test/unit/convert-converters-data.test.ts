/**
 * The data converters — CSV / JSON / YAML tables, trees and blocks —
 * strategy by strategy (ADR-100). The expectations mirror the full app's
 * converter tests (test/unit/converters/{json-to-csv,csv-to-md,
 * csv-to-html,json-to-md,json-to-html,json-yaml}.test.js) plus the edge
 * cases the ports handle: empty input, ragged rows, nested objects,
 * unicode.
 */

import { describe, it, expect } from 'vitest';
import { jsonToCsv, parseJsonRows, flattenObject, escapeCsvField, formatCsvValue, selectColumns } from '../../convert/converters/json-to-csv.js';
import { csvToMd, escapeMdCell, buildMarkdownTable } from '../../convert/converters/csv-to-md.js';
import { csvToHtml, buildHtmlTable } from '../../convert/converters/csv-to-html.js';
import { jsonToMd, buildList } from '../../convert/converters/json-to-md.js';
import { jsonToHtml, buildTree, buildPretty } from '../../convert/converters/json-to-html.js';
import { jsonToYaml, yamlToJson, sortKeysDeep, parseYaml } from '../../convert/converters/json-yaml.js';

const PEOPLE = JSON.stringify([
  { name: 'Alice', age: 30, city: 'NYC' },
  { name: 'Bob', age: 25, city: 'LA' },
  { name: 'Carol', age: 28, city: 'Chicago' },
]);

describe('json-to-csv', () => {
  it('declares json → csv with the two deterministic strategies', () => {
    expect(jsonToCsv.spec.from).toEqual(['json']);
    expect(jsonToCsv.spec.to).toEqual(['csv']);
    expect(jsonToCsv.spec.strategies.map((s) => s.id)).toEqual(['flat', 'top-level']);
    expect(jsonToCsv.spec.defaultStrategy).toBe('flat');
  });
  it('flat writes a header of the keys and one row per object', async () => {
    const r = await jsonToCsv.execute(PEOPLE, 'flat', {});
    expect(r.output).toBe('name,age,city\nAlice,30,NYC\nBob,25,LA\nCarol,28,Chicago');
    expect(r.stats).toMatchObject({ rowCount: 3, columnCount: 3 });
    expect(r.warnings).toBeUndefined();
  });
  it('flat flattens nested objects with dot-notation and keeps arrays as JSON text', async () => {
    const r = await jsonToCsv.execute(JSON.stringify([{ name: 'Alice', address: { city: 'NYC', zip: '10001' }, tags: ['a', 'b'] }]), 'flat', {});
    expect(r.output).toBe('name,address.city,address.zip,tags\nAlice,NYC,10001,"[""a"",""b""]"');
  });
  it('top-level skips nested objects and arrays and says which', async () => {
    const r = await jsonToCsv.execute(JSON.stringify([{ name: 'Alice', age: 30, address: { city: 'NYC' } }]), 'top-level', {});
    expect(r.output).toBe('name,age\nAlice,30');
    expect(r.output).not.toContain('address');
    expect(r.warnings).toEqual(['Skipped 1 nested field(s): address']);
  });
  it('quotes fields with commas, quotes or line breaks', async () => {
    const r = await jsonToCsv.execute(JSON.stringify([{ name: 'Smith, John', quote: 'say "hi"', note: 'two\nlines' }]), 'flat', {});
    expect(r.output).toBe('name,quote,note\n"Smith, John","say ""hi""","two\nlines"');
    expect(escapeCsvField('plain')).toBe('plain');
  });
  it('takes the union of keys across objects, blank where a key is missing or null', async () => {
    const r = await jsonToCsv.execute(JSON.stringify([{ a: 1, b: null }, { b: true, c: 'x' }]), 'flat', {});
    expect(r.output).toBe('a,b,c\n1,,\n,true,x');
  });
  it('wraps a single object as a one-row table and warns on a single column', async () => {
    const r = await jsonToCsv.execute('{"only": "one"}', 'flat', {});
    expect(r.output).toBe('only\none');
    expect(r.stats?.['rowCount']).toBe(1);
    expect(r.warnings).toEqual(['CSV has a single column']);
  });
  it('refuses empty arrays, scalars, invalid JSON, non-object items, and objects with no scalar fields', async () => {
    await expect(jsonToCsv.execute('[]', 'flat', {})).rejects.toThrow(/empty/);
    await expect(jsonToCsv.execute('42', 'flat', {})).rejects.toThrow(/array or object/);
    await expect(jsonToCsv.execute('{not json', 'flat', {})).rejects.toThrow(/not valid JSON/);
    await expect(jsonToCsv.execute('[{"a":1}, null]', 'flat', {})).rejects.toThrow(/item 1 is null/);
    await expect(jsonToCsv.execute('[{"nested": {"a": 1}}]', 'top-level', {})).rejects.toThrow(/No columns/);
    expect(() => parseJsonRows('')).toThrow(/not valid JSON/);
  });
  it('helpers: flattenObject, formatCsvValue, selectColumns keep first-seen key order', () => {
    expect(flattenObject({ a: { b: { c: 1 } }, d: [1, { e: 2 }], f: null })).toEqual({ 'a.b.c': 1, d: '[1,{"e":2}]', f: null });
    expect(formatCsvValue(undefined)).toBe('');
    expect(formatCsvValue({ x: 1 })).toBe('{"x":1}');
    expect(formatCsvValue(false)).toBe('false');
    const cols = selectColumns([{ z: 1, a: 2 }, { m: 3 }], 'flat');
    expect(cols.headers).toEqual(['z', 'a', 'm']);
    expect(cols.rows).toEqual([[1, 2, undefined], [undefined, undefined, 3]]);
  });
  it('passes unicode through unquoted', async () => {
    const r = await jsonToCsv.execute(JSON.stringify([{ name: 'Zoë', city: '東京', mood: '🎉' }]), 'flat', {});
    expect(r.output).toBe('name,city,mood\nZoë,東京,🎉');
  });
});

describe('csv-to-md', () => {
  const CSV = 'name,age,city\nAlice,30,New York\nBob,25,Los Angeles\nCarol,28,Chicago';
  it('declares csv, tsv → md with simple and aligned (summary was the model strategy)', () => {
    expect(csvToMd.spec.from).toEqual(['csv', 'tsv']);
    expect(csvToMd.spec.to).toEqual(['md']);
    expect(csvToMd.spec.strategies.map((s) => s.id)).toEqual(['simple', 'aligned']);
  });
  it('simple produces a pipe table with a --- separator row', async () => {
    const r = await csvToMd.execute(CSV, 'simple', {});
    expect(r.output).toContain('| name');
    expect(r.output).toContain('| ---');
    expect(r.output).toContain('| Alice');
    const lines = r.output.split('\n');
    expect(lines.length).toBe(5);
    expect(lines[0]).toBe('| name | age | city |');
    expect(lines[1]).toBe('| --- | --- | --- |');
    expect(lines[2]).toBe('| Alice | 30 | New York |');
    expect(r.stats).toMatchObject({ rowCount: 3, columnCount: 3, delimiter: ',' });
  });
  it('aligned pads every column to its widest cell', async () => {
    const r = await csvToMd.execute(CSV, 'aligned', {});
    const lines = r.output.split('\n');
    expect(lines[1]).toMatch(/^\| -+ \| -+ \| -+ \|$/);
    expect(lines[0]).toBe(`| ${'name'.padEnd(5)} | age | ${'city'.padEnd(11)} |`);
    expect(lines[1]).toBe(`| ${'-'.repeat(5)} | ${'-'.repeat(3)} | ${'-'.repeat(11)} |`);
    expect(lines[2]).toBe(`| Alice | ${'30'.padEnd(3)} | ${'New York'.padEnd(11)} |`);
    expect(new Set(lines.map((l) => l.length)).size).toBe(1);
  });
  it('escapes pipes and turns line breaks into <br> so a quoted field cannot break the table', async () => {
    const r = await csvToMd.execute('a,b\n"x|y","line1\nline2"', 'simple', {});
    expect(r.output.split('\n')[2]).toBe('| x\\|y | line1<br>line2 |');
    expect(escapeMdCell('p|q\r\nr')).toBe('p\\|q<br>r');
  });
  it('reads TSV by detection or an explicit delimiter', async () => {
    const detected = await csvToMd.execute('a\tb\n1\t2', 'simple', {});
    expect(detected.output).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(detected.stats?.['delimiter']).toBe('tab');
    const explicit = await csvToMd.execute('a;b\n1;2', 'simple', { delimiter: ';' });
    expect(explicit.output).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |');
  });
  it('fills short rows, drops extra fields, and warns about the ragged ones', async () => {
    const r = await csvToMd.execute('a,b\n1\n2,3,4', 'simple', {});
    expect(r.output.split('\n').slice(2)).toEqual(['| 1 |  |', '| 2 | 3 |']);
    expect(r.warnings).toEqual(['2 row(s) have a different number of fields than the header']);
  });
  it('refuses a header-only or empty file', async () => {
    await expect(csvToMd.execute('a,b\n', 'simple', {})).rejects.toThrow(/header row/);
    await expect(csvToMd.execute('', 'simple', {})).rejects.toThrow(/header row/);
  });
  it('keeps unicode cells intact (widths count code units)', async () => {
    const r = await csvToMd.execute('name,city\nZoë,東京\nBob,🎉', 'aligned', {});
    expect(r.output.split('\n')[2]).toBe(`| ${'Zoë'.padEnd(4)} | ${'東京'.padEnd(4)} |`);
    expect(buildMarkdownTable(['h'], [['v']], false)).toBe('| h |\n| --- |\n| v |');
  });
});

describe('csv-to-html', () => {
  const SAMPLE = 'name,age,city\nAlice,30,New York\nBob,25,Los Angeles';
  it('declares csv, tsv → html with table, styled, sortable', () => {
    expect(csvToHtml.spec.from).toEqual(['csv', 'tsv']);
    expect(csvToHtml.spec.to).toEqual(['html']);
    expect(csvToHtml.spec.strategies.map((s) => s.id)).toEqual(['table', 'styled', 'sortable']);
  });
  it('table is a bare semantic table with thead/tbody', async () => {
    const r = await csvToHtml.execute(SAMPLE, 'table', {});
    expect(r.output.startsWith('<table>\n  <thead>')).toBe(true);
    expect(r.output).toContain('<tbody>');
    expect(r.output).toContain('<th>name</th>');
    expect(r.output).toContain('<td>Alice</td>');
    expect(r.output).not.toContain('<!DOCTYPE');
    expect(r.stats).toMatchObject({ rowCount: 2, columnCount: 3, isDocument: false });
  });
  it('styled wraps the table in a full document with CSS and a title', async () => {
    const r = await csvToHtml.execute(SAMPLE, 'styled', {});
    expect(r.output.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(r.output).toContain('<style>');
    expect(r.output).toContain('<table>');
    expect(r.output.trimEnd().endsWith('</html>')).toBe(true);
    expect(r.output).toContain('<title>CSV Data Table</title>');
    expect(r.output).not.toContain('<script>');
    expect(r.stats?.['isDocument']).toBe(true);
    const titled = await csvToHtml.execute(SAMPLE, 'styled', { title: 'Q3 <numbers>' });
    expect(titled.output).toContain('<title>Q3 &lt;numbers&gt;</title>');
  });
  it('sortable adds the click-to-sort script and pointer headers', async () => {
    const r = await csvToHtml.execute(SAMPLE, 'sortable', {});
    expect(r.output).toContain('<script>');
    expect(r.output).toContain('addEventListener');
    expect(r.output).toContain('cursor:pointer');
    expect(r.output).toContain('thead th::after');
  });
  it('escapes markup in cells and headers', async () => {
    const r = await csvToHtml.execute('a&b,"<tag>"\n"say ""hi""",x', 'table', {});
    expect(r.output).toContain('<th>a&amp;b</th>');
    expect(r.output).toContain('<th>&lt;tag&gt;</th>');
    expect(r.output).toContain('<td>say &quot;hi&quot;</td>');
    expect(r.output).not.toContain('<tag>');
  });
  it('reads TSV, fills ragged rows and warns, refuses a header-only file', async () => {
    const r = await csvToHtml.execute('a\tb\n1\n', 'table', {});
    expect(r.output).toContain('<td>1</td>\n      <td></td>');
    expect(r.warnings?.[0]).toMatch(/1 row/);
    expect(r.stats?.['delimiter']).toBe('tab');
    await expect(csvToHtml.execute('a,b', 'table', {})).rejects.toThrow(/header row/);
    expect(buildHtmlTable(['h'], [['v']], true)).toContain('<th style="cursor:pointer;user-select:none">h</th>');
  });
  it('unicode survives the table', async () => {
    const r = await csvToHtml.execute('name\n東京 🎉', 'table', {});
    expect(r.output).toContain('<td>東京 🎉</td>');
  });
});

describe('json-to-md', () => {
  it('declares json → md with table, yaml-block, list', () => {
    expect(jsonToMd.spec.from).toEqual(['json']);
    expect(jsonToMd.spec.to).toEqual(['md']);
    expect(jsonToMd.spec.strategies.map((s) => s.id)).toEqual(['table', 'yaml-block', 'list']);
  });
  it('table renders an array of objects as a pipe table, trailing newline', async () => {
    const r = await jsonToMd.execute(JSON.stringify([{ name: 'Alice', age: 30 }, { name: 'Bob', age: 25 }]), 'table', {});
    expect(r.output).toBe('| name | age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |\n');
    expect(r.stats).toMatchObject({ rowCount: 2, columnCount: 2, isTable: true });
  });
  it('table takes the union of keys, JSON for objects in cells, blank for null, and escapes pipes', async () => {
    const r = await jsonToMd.execute(JSON.stringify([{ a: 1, b: { x: 1 } }, { a: null, c: 'p|q' }]), 'table', {});
    expect(r.output).toBe('| a | b | c |\n| --- | --- | --- |\n| 1 | {"x":1} |  |\n|  |  | p\\|q |\n');
  });
  it('table falls back: empty array → note, keyless data → JSON block', async () => {
    expect((await jsonToMd.execute('[]', 'table', {})).output).toBe('*Empty array*\n');
    const r = await jsonToMd.execute('[1, 2]', 'table', {});
    expect(r.output).toBe('```json\n[\n  1,\n  2\n]\n```\n');
    expect(r.stats?.['isTable']).toBe(false);
  });
  it('yaml-block wraps js-yaml output in a fenced block', async () => {
    const r = await jsonToMd.execute(JSON.stringify({ key: 'value', list: [1, 2] }), 'yaml-block', {});
    expect(r.output).toBe('```yaml\nkey: value\nlist:\n  - 1\n  - 2\n```\n');
    expect(r.stats?.['lines']).toBe(6);
  });
  it('list renders nested bullets with keys in bold and nulls in italics', async () => {
    const r = await jsonToMd.execute(JSON.stringify({ person: { name: 'Alice', age: 30 }, tags: ['x', { deep: true }], none: null }), 'list', {});
    expect(r.output).toBe(
      ['- **person**:', '  - **name**: Alice', '  - **age**: 30', '- **tags**:', '  - x', '  -', '    - **deep**: true', '- **none**: *null*'].join('\n')
    );
    expect(r.stats?.['entries']).toBe(3);
    expect(buildList(5)).toBe('- 5');
    expect(buildList(null)).toBe('- *null*');
    expect(buildList({ empty: {} })).toBe('- **empty**:');
  });
  it('accepts any JSON value, refuses invalid JSON', async () => {
    expect((await jsonToMd.execute('"hi"', 'list', {})).output).toBe('- hi');
    await expect(jsonToMd.execute('', 'table', {})).rejects.toThrow(/not valid JSON/);
  });
  it('unicode passes through every strategy', async () => {
    const input = JSON.stringify({ city: '東京', mood: '🎉' });
    for (const s of ['table', 'yaml-block', 'list']) {
      const r = await jsonToMd.execute(input, s, {});
      expect(r.output).toContain('東京');
      expect(r.output).toContain('🎉');
    }
  });
});

describe('json-to-html', () => {
  it('declares json → html with table, tree, pretty', () => {
    expect(jsonToHtml.spec.from).toEqual(['json']);
    expect(jsonToHtml.spec.to).toEqual(['html']);
    expect(jsonToHtml.spec.strategies.map((s) => s.id)).toEqual(['table', 'tree', 'pretty']);
  });
  it('table renders an array of objects with th/td', async () => {
    const r = await jsonToHtml.execute(JSON.stringify([{ name: 'Alice', age: 30 }]), 'table', {});
    expect(r.output).toBe('<table>\n<thead><tr><th>name</th><th>age</th></tr></thead>\n<tbody><tr><td>Alice</td><td>30</td></tr></tbody>\n</table>');
    expect(r.stats).toMatchObject({ rowCount: 1, columnCount: 2 });
  });
  it('escapes HTML entities in data values', async () => {
    const r = await jsonToHtml.execute(JSON.stringify([{ name: '<script>alert("xss")</script>' }]), 'table', {});
    expect(r.output).not.toContain('<script>');
    expect(r.output).toContain('&lt;script&gt;');
  });
  it('table: union of keys, JSON for nested values, "Empty array" for []', async () => {
    const r = await jsonToHtml.execute(JSON.stringify([{ a: 1 }, { b: { c: 2 } }]), 'table', {});
    expect(r.output).toContain('<tr><td>1</td><td></td></tr>\n<tr><td></td><td>{"c":2}</td></tr>');
    expect((await jsonToHtml.execute('[]', 'table', {})).output).toBe('<table><tbody><tr><td>Empty array</td></tr></tbody></table>');
  });
  it('tree renders nested lists with a class per value type', async () => {
    const r = await jsonToHtml.execute(JSON.stringify({ root: { child: 'value', n: 1, ok: false, nil: null, list: [] } }), 'tree', {});
    expect(r.output.startsWith('<ul class="json-object">')).toBe(true);
    expect(r.output).toContain('<span class="json-key">root</span>');
    expect(r.output).toContain('<span class="json-str">"value"</span>');
    expect(r.output).toContain('<span class="json-num">1</span>');
    expect(r.output).toContain('<span class="json-bool">false</span>');
    expect(r.output).toContain('<span class="json-null">null</span>');
    expect(r.output).toContain('<span class="json-bracket">[]</span>');
    expect(r.stats?.['nodes']).toBe(6);
    expect(buildTree(['<a>'])).toBe('<ul class="json-array">\n  <li>  <span class="json-str">"&lt;a&gt;"</span></li>\n</ul>');
    expect(buildTree({})).toBe('<span class="json-bracket">{}</span>');
  });
  it('pretty wraps formatted JSON in a pre block with highlight spans', async () => {
    const r = await jsonToHtml.execute(JSON.stringify({ key: 'value', n: 2.5, ok: true, nil: null }), 'pretty', {});
    expect(r.output.startsWith('<pre class="json-pretty"><code>')).toBe(true);
    expect(r.output).toContain('<span class="json-key">"key"</span>: <span class="json-str">"value"</span>');
    expect(r.output).toContain('<span class="json-num">2.5</span>');
    expect(r.output).toContain('<span class="json-bool">true</span>');
    expect(r.output).toContain('<span class="json-null">null</span>');
    expect(r.stats?.['lines']).toBe(6);
    expect(buildPretty('<b>')).toBe('<pre class="json-pretty"><code>"&lt;b&gt;"</code></pre>');
  });
  it('refuses invalid JSON; unicode passes through', async () => {
    await expect(jsonToHtml.execute('{', 'pretty', {})).rejects.toThrow(/not valid JSON/);
    const r = await jsonToHtml.execute(JSON.stringify({ city: '東京 🎉' }), 'tree', {});
    expect(r.output).toContain('"東京 🎉"');
  });
});

describe('json-yaml', () => {
  const JSON_IN = '{"name": "Alice", "age": 30, "active": true}';
  it('exports one converter per direction over js-yaml, sharing standard and ordered', () => {
    expect(jsonToYaml.spec).toMatchObject({ id: 'json-to-yaml', from: ['json'], to: ['yaml'], engine: 'js-yaml', defaultStrategy: 'standard' });
    expect(yamlToJson.spec).toMatchObject({ id: 'yaml-to-json', from: ['yaml'], to: ['json'], engine: 'js-yaml', defaultStrategy: 'standard' });
    expect(jsonToYaml.spec.strategies.map((s) => s.id)).toEqual(['standard', 'ordered']);
    expect(yamlToJson.spec.strategies.map((s) => s.id)).toEqual(['standard', 'ordered']);
  });
  it('json → yaml standard keeps key order', async () => {
    const r = await jsonToYaml.execute(JSON_IN, 'standard', {});
    expect(r.output).toBe('name: Alice\nage: 30\nactive: true\n');
    expect(r.stats).toMatchObject({ kind: 'object', entries: 3, sorted: false });
    const list = await jsonToYaml.execute('[1, "two"]', 'standard', {});
    expect(list.output).toBe('- 1\n- two\n');
    expect(list.stats).toMatchObject({ kind: 'array', entries: 2 });
    // Keys that YAML 1.1 reads as booleans are quoted so they survive a round trip.
    expect((await jsonToYaml.execute('{"y": 1, "on": 2}', 'standard', {})).output).toBe("'y': 1\n'on': 2\n");
  });
  it('json → yaml ordered sorts keys at every level', async () => {
    const r = await jsonToYaml.execute('{"zebra": 1, "apple": {"x": 2, "list": [{"b": 1, "a": 2}]}, "mango": 3}', 'ordered', {});
    expect(r.output).toBe('apple:\n  list:\n    - a: 2\n      b: 1\n  x: 2\nmango: 3\nzebra: 1\n');
    expect(r.stats?.['sorted']).toBe(true);
  });
  it('yaml → json standard and ordered', async () => {
    const r = await yamlToJson.execute('name: Alice\nage: 30', 'standard', {});
    expect(r.output).toBe('{\n  "name": "Alice",\n  "age": 30\n}');
    expect(JSON.parse(r.output)).toEqual({ name: 'Alice', age: 30 });
    const ordered = await yamlToJson.execute('b: 1\na:\n  z: 1\n  y: 2', 'ordered', { indent: 0 });
    expect(ordered.output).toBe('{"a":{"y":2,"z":1},"b":1}');
  });
  it('honours indent and lineWidth', async () => {
    expect((await jsonToYaml.execute('{"a":{"b":1}}', 'standard', { indent: 4 })).output).toBe('a:\n    b: 1\n');
    const words = 'word '.repeat(40).trim();
    const long = JSON.stringify({ text: words });
    expect((await jsonToYaml.execute(long, 'standard', {})).output.split('\n').length).toBeGreaterThan(2);
    expect((await jsonToYaml.execute(long, 'standard', { lineWidth: -1 })).output).toBe(`text: ${words}\n`);
    expect((await yamlToJson.execute('a: 1', 'standard', { indent: 4 })).output).toBe('{\n    "a": 1\n}');
  });
  it('round-trips json → yaml → json', async () => {
    const yaml = (await jsonToYaml.execute(JSON_IN, 'standard', {})).output;
    const back = (await yamlToJson.execute(yaml, 'standard', {})).output;
    expect(JSON.parse(back)).toEqual(JSON.parse(JSON_IN));
  });
  it('sortKeysDeep sorts nested objects, recurses arrays, leaves scalars and dates alone', () => {
    expect(Object.keys(sortKeysDeep({ zebra: 1, apple: 2, mango: 3 }) as object)).toEqual(['apple', 'mango', 'zebra']);
    expect(JSON.stringify(sortKeysDeep([{ b: 1, a: [{ d: 1, c: 2 }] }]))).toBe('[{"a":[{"c":2,"d":1}],"b":1}]');
    const d = new Date(0);
    expect(sortKeysDeep(d)).toBe(d);
    expect(sortKeysDeep('s')).toBe('s');
  });
  it('yaml timestamps become ISO strings, also under ordered', async () => {
    const r = await yamlToJson.execute('when: 2020-01-02', 'ordered', { indent: 0 });
    expect(r.output).toBe('{"when":"2020-01-02T00:00:00.000Z"}');
  });
  it('refuses invalid JSON, invalid YAML, empty input, several documents; a null or comment-only document is null with a warning', async () => {
    await expect(jsonToYaml.execute('{oops', 'standard', {})).rejects.toThrow(/not valid JSON/);
    await expect(yamlToJson.execute('a: [', 'standard', {})).rejects.toThrow(/not valid YAML/);
    await expect(yamlToJson.execute('   \n', 'standard', {})).rejects.toThrow(/empty/);
    const comment = await yamlToJson.execute('# just a comment', 'standard', {});
    expect(comment.output).toBe('null');
    expect(comment.warnings).toEqual(['YAML document parsed to null']);
    await expect(yamlToJson.execute('a: 1\n---\nb: 2', 'standard', {})).rejects.toThrow(/not valid YAML/);
    expect(() => parseYaml('a: [')).toThrow(/not valid YAML/);
    const nul = await yamlToJson.execute('~', 'standard', {});
    expect(nul.output).toBe('null');
    expect(nul.warnings).toEqual(['YAML document parsed to null']);
  });
  it('unicode survives both directions', async () => {
    const y = await jsonToYaml.execute(JSON.stringify({ name: 'Zoë', city: '東京', mood: '🎉' }), 'standard', {});
    expect(y.output).toBe('name: Zoë\ncity: 東京\nmood: 🎉\n');
    const j = await yamlToJson.execute('name: Zoë\ncity: 東京', 'standard', { indent: 0 });
    expect(j.output).toBe('{"name":"Zoë","city":"東京"}');
  });
});
