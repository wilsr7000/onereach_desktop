/**
 * The document converters — html-to-md, html-to-text, md-to-text,
 * text-to-md — strategy by strategy (ADR-100). The expectations mirror
 * the full app's converter tests, plus the edges the code exposes:
 * empty input, nested lists, entities, scripts and styles, unicode.
 */

import { describe, it, expect } from 'vitest';
import { htmlToMd, markdownIssues } from '../../convert/converters/html-to-md.js';
import { htmlToText, decodeEntities, extractMainContent, stripAllTags } from '../../convert/converters/html-to-text.js';
import { mdToText, stripInline, stripMarkdown } from '../../convert/converters/md-to-text.js';
import { textToMd, looksLikeHeading, listLine, splitParagraphs } from '../../convert/converters/text-to-md.js';

describe('html-to-md', () => {
  it('turndown renders headings, paragraphs, emphasis, links and fenced code the original way', async () => {
    const r = await htmlToMd.execute('<h1>Hello</h1><p>World</p>', 'turndown', {});
    expect(r.output).toBe('# Hello\n\nWorld');
    expect(r.stats).toMatchObject({ inputLength: 26, outputLength: 14, tagsStripped: false });
    const rich = await htmlToMd.execute(
      '<p>This is a <strong>test</strong> with <em>flair</em> and a <a href="https://x.io">link</a>.</p><pre><code class="language-js">const a = 1;\n</code></pre>',
      'turndown',
      {}
    );
    expect(rich.output).toContain('**test**');
    expect(rich.output).toContain('*flair*');
    expect(rich.output).toContain('[link](https://x.io)');
    expect(rich.output).toContain('```js\nconst a = 1;\n```');
  });
  it('clean strips scripts, styles, nav and comments before converting; tagsStripped says so', async () => {
    const html = '<script>alert("x")</script><style>body{}</style><nav>Menu</nav><!-- note --><p>Content</p>';
    const r = await htmlToMd.execute(html, 'clean', {});
    expect(r.output).toBe('Content');
    expect(r.output).not.toContain('<script>');
    expect(r.output).not.toContain('<style>');
    expect(r.stats?.['tagsStripped']).toBe(true);
    expect(r.warnings).toBeUndefined();
  });
  it('turndown keeps nav and asides but never lets script, style or title bodies leak into the text', async () => {
    const html = '<html><head><title>Page</title><script>alert("x")</script><style>body{}</style></head><body><nav>Menu</nav><p>Content</p></body></html>';
    const r = await htmlToMd.execute(html, 'turndown', {});
    expect(r.output).toBe('Menu\n\nContent');
    expect(r.stats?.['tagsStripped']).toBe(false);
  });
  it('semantic puts articles between dividers and quotes asides', async () => {
    const html = '<article><h2>Title</h2><section><p>Body</p></section><aside><p>Note</p><p>More</p></aside><figure><img src="x.png" alt="pic"><figcaption>Cap</figcaption></figure></article>';
    const r = await htmlToMd.execute(html, 'semantic', {});
    expect(r.output.startsWith('---\n\n## Title\n\nBody')).toBe(true);
    expect(r.output).toContain('> Note\n> \n> More');
    expect(r.output).toContain('![pic](x.png)\n\nCap');
    expect(r.output.endsWith('\n\n---')).toBe(true);
  });
  it('gfm (default) writes pipe tables with a delimiter row and ~~strikethrough~~; gfm: false is plain turndown', async () => {
    const html = '<table><thead><tr><th>a</th><th align="right">b</th></tr></thead><tbody><tr><td>1</td><td>2 | x</td></tr></tbody></table><p><del>gone</del> <s>old</s></p>';
    const r = await htmlToMd.execute(html, 'turndown', {});
    expect(r.output).toBe('| a | b |\n| --- | --: |\n| 1 | 2 \\| x |\n\n~~gone~~ ~~old~~');
    const plain = await htmlToMd.execute(html, 'turndown', { gfm: false });
    expect(plain.output).toBe('a\n\nb\n\n1\n\n2 | x\n\ngone old');
  });
  it('gfm invents a blank header row for a table without one and flattens cell content', async () => {
    const html = '<table><tr><td>1<br>x</td><td><p>2</p></td></tr><tr><td>3</td><td>4</td></tr></table>';
    const r = await htmlToMd.execute(html, 'turndown', {});
    expect(r.output).toBe('|  |  |\n| --- | --- |\n| 1 x | 2 |\n| 3 | 4 |');
  });
  it('nests lists with turndown\'s indentation and numbers ordered items', async () => {
    const r = await htmlToMd.execute('<ul><li>One<ul><li>Sub</li></ul></li><li>Two</li></ul><ol><li>x</li><li>y</li></ol>', 'turndown', {});
    expect(r.output).toBe('-   One\n    -   Sub\n-   Two\n\n1.  x\n2.  y');
  });
  it('decodes entities and keeps unicode', async () => {
    const r = await htmlToMd.execute('<p>a &amp; b &lt; c &copy; ü 日本 &#x1F600;</p>', 'turndown', {});
    expect(r.output).toBe('a & b < c © ü 日本 😀');
  });
  it('refuses empty input and warns when block-level markup survives', async () => {
    await expect(htmlToMd.execute('  \n ', 'turndown', {})).rejects.toThrow(/empty/);
    const r = await htmlToMd.execute('<p>&lt;div&gt;x&lt;/div&gt;</p>', 'turndown', {});
    expect(r.output).toBe('<div>x</div>');
    expect(r.warnings?.[0]).toMatch(/block-level HTML/);
    expect(markdownIssues('<script>')).toHaveLength(1);
    expect(markdownIssues('')).toEqual(['the output is empty']);
    expect(markdownIssues('# fine')).toEqual([]);
  });
});

describe('html-to-text', () => {
  const SAMPLE = '<html><body><h1>Title</h1><p>Hello <strong>world</strong>, this is a test.</p><ul><li>One</li><li>Two</li></ul></body></html>';
  it('strip removes every tag and keeps the words', async () => {
    const r = await htmlToText.execute('<p>Hello <b>world</b></p>', 'strip', {});
    expect(r.output).not.toMatch(/<[^>]+>/);
    expect(r.output).toBe('Hello world');
    expect(r.stats).toMatchObject({ inputLength: 25, outputLength: 11, compressionRatio: 0.44 });
    expect(r.warnings).toBeUndefined();
  });
  it('strip drops scripts, styles and comments with their bodies', async () => {
    const r = await htmlToText.execute('<script>alert("x")</script><style>p{}</style><!-- c --><p>Kept</p>', 'strip', {});
    expect(r.output).toBe('Kept');
  });
  it('readable keeps paragraph breaks, dashes list items, drops nav and footer', async () => {
    const r = await htmlToText.execute('<p>Paragraph one.</p><p>Paragraph two.</p>', 'readable', {});
    expect(r.output).toBe('Paragraph one.\n\nParagraph two.');
    expect(r.output).toMatch(/Paragraph one\.\s+Paragraph two\./);
    const full = await htmlToText.execute('<nav>Menu</nav>' + SAMPLE + '<footer>Foot</footer>', 'readable', {});
    expect(full.output).toBe('Title\n\nHello world, this is a test.\n\n- One\n\n- Two');
    const hr = await htmlToText.execute('<p>a<br>b</p><hr><p>c</p>', 'readable', {});
    expect(hr.output).toBe('a\nb\n\n---\nc');
  });
  it('article extracts the article region and ignores nav and footer', async () => {
    const html = '<html><nav>Menu</nav><article><p>Main content here.</p></article><footer>Footer</footer></html>';
    const r = await htmlToText.execute(html, 'article', {});
    expect(r.output).toBe('Main content here.');
    expect(r.output).not.toContain('Menu');
    expect(r.output).not.toContain('Footer');
  });
  it('extractMainContent falls back from article to main, role="main", body, then the whole input', () => {
    expect(extractMainContent('<main class="m">M</main><body>B</body>')).toBe('M');
    expect(extractMainContent('<div id="x" role="main">R</div>')).toBe('R');
    expect(extractMainContent('<body lang="en">B</body>')).toBe('B');
    expect(extractMainContent('<p>whole</p>')).toBe('<p>whole</p>');
  });
  it('decodes named, decimal, hex and astral entities and keeps unicode', () => {
    expect(decodeEntities('&lt;b&gt; &amp; &quot;q&quot; &#39;s&#39; &copy; &#169; &#x1F600; &hellip; ü 日本')).toBe('<b> & "q" \'s\' © © 😀 … ü 日本');
    expect(decodeEntities('&#99999999;')).toBe('&#99999999;');
    expect(stripAllTags('<p>a &nbsp;&nbsp; b\t\tc</p>')).toBe('a b c');
  });
  it('warns when decoded markup or undecoded entities remain, and refuses empty input', async () => {
    const r = await htmlToText.execute('<p>&lt;b&gt;bold&lt;/b&gt; &euro;</p>', 'strip', {});
    expect(r.output).toBe('<b>bold</b> &euro;');
    expect(r.warnings).toEqual(['HTML tags remain in the output (the source had escaped markup)']);
    const entity = await htmlToText.execute('<p>&amp;amp;</p>', 'strip', {});
    expect(entity.warnings).toEqual(['undecoded HTML entities remain in the output']);
    const empty = await htmlToText.execute('<script>only()</script>', 'strip', {});
    expect(empty.output).toBe('');
    expect(empty.warnings).toEqual(['the output is empty']);
    await expect(htmlToText.execute('', 'strip', {})).rejects.toThrow(/empty/);
  });
});

describe('md-to-text', () => {
  const SAMPLE = '# Hello World\n\nThis is **bold** and *italic* text.\n\n- Item one\n- Item two\n\n[A link](http://example.com)';
  it('strip removes every marker and keeps the words', async () => {
    const r = await mdToText.execute(SAMPLE, 'strip', {});
    expect(r.output).toBe('Hello World\n\nThis is bold and italic text.\n\nItem one\nItem two\n\nA link');
    expect(r.output).not.toContain('#');
    expect(r.output).not.toContain('*');
    expect(r.output).not.toContain('[');
    expect(r.stats).toMatchObject({ inputLength: SAMPLE.length, outputLength: r.output.length, compressionRatio: Number((r.output.length / SAMPLE.length).toFixed(2)) });
    expect(r.warnings).toBeUndefined();
  });
  it('strip keeps fenced and inline code content, image alt text, nested list words; drops rules, quotes, tags and reference definitions', () => {
    expect(stripMarkdown('```js\nconst a = 1;\n```\n\nuse `x`')).toBe('const a = 1;\n\nuse x');
    expect(stripMarkdown('![alt text](i.png) and [ref][1]\n\n[1]: http://x')).toBe('alt text and ref');
    expect(stripMarkdown('- a\n  - b\n1. c\n\n---\n\n> quoted <b>tag</b> ~~gone~~ ___all___')).toBe('a\nb\nc\n\nquoted tag gone all');
  });
  it('readable capitalises headings over a rule, dashes lists, bars quotes and indents code', async () => {
    const r = await mdToText.execute(SAMPLE, 'readable', {});
    expect(r.output).toBe('HELLO WORLD\n===========\n\nThis is bold and italic text.\n\n- Item one\n- Item two\n\nA link');
    const more = await mdToText.execute('### Deep *one*\n\n> quoted\n\n1. first\n  - nested\n\n---\n\n```js\nconst a = 1;\n```', 'readable', {});
    expect(more.output).toBe('DEEP ONE\n\n  | quoted\n\n- first\n  - nested\n\n    const a = 1;');
  });
  it('outline lists headings by depth with the first sentence under each, skipping lists, rules and fences', async () => {
    const r = await mdToText.execute(SAMPLE, 'outline', {});
    expect(r.output).toBe('Hello World\n  > This is bold and italic text.');
    expect(r.output).not.toContain('Item one');
    // Only the fence lines are skipped (the original's rule), so the fence sits after a captured sentence here.
    const deep = await mdToText.execute('# Top\n\n---\n\nFirst sentence! Second.\n\n## Sub\nSub sentence.\n```\ncode\n```\n### Leaf\nNo period here\n\n#### Bare', 'outline', {});
    expect(deep.output).toBe('Top\n  > First sentence!\n  Sub\n    > Sub sentence.\n    Leaf\n      > No period here\n      Bare');
  });
  it('stripInline handles every inline form; unicode passes through; empty input is refused; surviving markers warn', async () => {
    expect(stripInline('**b** *i* ***bi*** __b__ _i_ ~~s~~ `c` [l](u) ![a](u) [r][1] 日本')).toBe('b i bi b i s c l a r 日本');
    await expect(mdToText.execute('\n\n', 'strip', {})).rejects.toThrow(/empty/);
    const r = await mdToText.execute('**unterminated', 'strip', {});
    expect(r.output).toBe('**unterminated');
    expect(r.warnings).toBeUndefined();
    const link = await mdToText.execute('[a]( b )', 'strip', {});
    expect(link.output).toBe('a');
    const only = await mdToText.execute('---', 'strip', {});
    expect(only.warnings).toEqual(['the output is empty']);
  });
});

describe('text-to-md', () => {
  it('minimal splits paragraphs on blank lines and nothing else', async () => {
    const r = await textToMd.execute('First paragraph.\n\nSecond paragraph.', 'minimal', {});
    expect(r.output).toBe('First paragraph.\n\nSecond paragraph.');
    expect(r.stats).toMatchObject({ paragraphs: 2, inputLength: 35, outputLength: 35 });
    expect(r.warnings).toBeUndefined();
    const crlf = await textToMd.execute('  a\r\n\r\n\r\n b \r\n', 'minimal', {});
    expect(crlf.output).toBe('a\n\nb');
  });
  it('structure detects underlined, CAPITAL and Title Case headings, bullets, numbers, nesting and rules; words never change', async () => {
    const input = [
      'MEETING NOTES',
      '',
      'Agenda',
      '======',
      '',
      'Attendees:',
      '- Alice',
      '- Bob',
      '  • Bob\'s guest',
      '',
      'Actions',
      '1. Fix the build',
      '2) Ship it',
      '   continued here',
      '',
      '---',
      '',
      'Closing thoughts here. Nothing more.',
    ].join('\n');
    const r = await textToMd.execute(input, 'structure', {});
    expect(r.output).toBe(
      [
        '# MEETING NOTES',
        '',
        '# Agenda',
        '',
        'Attendees:',
        '',
        '- Alice',
        '- Bob',
        "   - Bob's guest",
        '',
        '## Actions',
        '',
        '1. Fix the build',
        '2. Ship it',
        '  continued here',
        '',
        '---',
        '',
        'Closing thoughts here. Nothing more.',
      ].join('\n')
    );
    expect(r.stats).toMatchObject({ paragraphs: 2, headings: 3, listItems: 5 });
    expect(r.warnings).toBeUndefined();
  });
  it('structure: a lone Title Case line heads the next paragraph, a trailing one does not; --- underlines make ##', async () => {
    const r = await textToMd.execute('Project Plan\n\nWe start Monday.\n\nBob', 'structure', {});
    expect(r.output).toBe('# Project Plan\n\nWe start Monday.\n\nBob');
    const sub = await textToMd.execute('Intro\n\nSection Two\n-----------\nBody line one\nbody line two', 'structure', {});
    expect(sub.output).toBe('# Intro\n\n## Section Two\n\nBody line one\nbody line two');
  });
  it('structure: unicode bullets, CRLF, and a paragraph after a list', async () => {
    const r = await textToMd.execute('Title\r\n\r\n• one\r\n• two\r\nThat is all.', 'structure', {});
    expect(r.output).toBe('# Title\n\n- one\n- two\n\nThat is all.');
    expect(r.stats).toMatchObject({ headings: 1, listItems: 2, paragraphs: 1 });
  });
  it('structure warns when nothing was detected; empty input is refused', async () => {
    const r = await textToMd.execute('Just a sentence here.', 'structure', {});
    expect(r.output).toBe('Just a sentence here.');
    expect(r.warnings).toEqual(['no headings or lists were detected; the output is paragraphs only']);
    await expect(textToMd.execute('   ', 'structure', {})).rejects.toThrow(/empty/);
  });
  it('helpers: looksLikeHeading, listLine, splitParagraphs', () => {
    expect(looksLikeHeading('MEETING NOTES')).toBe(true);
    expect(looksLikeHeading('Hello World')).toBe(true);
    expect(looksLikeHeading('Closing thoughts here')).toBe(false);
    expect(looksLikeHeading('Ends with a period.')).toBe(false);
    expect(looksLikeHeading('Name: Bob')).toBe(false);
    expect(looksLikeHeading('https://example.com')).toBe(false);
    expect(looksLikeHeading('- item')).toBe(false);
    expect(looksLikeHeading('2024')).toBe(false);
    expect(listLine('  (3) third')).toEqual({ indent: 2, marker: '3.', text: 'third' });
    expect(listLine('\t– dash')).toEqual({ indent: 2, marker: '-', text: 'dash' });
    expect(listLine('-not a bullet')).toBeNull();
    expect(splitParagraphs('\n\na\nb\n  \nc\r\n\r\n\n')).toEqual([['a', 'b'], ['c']]);
  });
});
