/**
 * HTML → Markdown through `turndown` (ported from lib/converters/html-to-md.js,
 * ADR-100). Strategies: turndown (the library with atx headings, fenced
 * code, `-` bullets and `*`/`**` emphasis), semantic (article, section,
 * aside and figure keep their structure — dividers, spacing, a quote),
 * clean (scripts, styles, nav, header, footer, asides, iframes, noscript
 * and comments stripped before conversion). Beyond the original: the
 * `gfm` option (on by default) adds GitHub tables and ~~strikethrough~~,
 * which turndown's CommonMark rules lack, and script, style and title
 * bodies never reach the text (turndown alone emits them as prose).
 */

import TurndownService from 'turndown';
import { MARKUP_INPUT_BYTES, type Converter, type ExecuteResult } from '../types.js';
import { removeNonContent } from './html-to-text.js';

/** A turndown with the original's settings; script, style and title bodies removed rather than rendered as text. */
export function createTurndown(): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    strongDelimiter: '**',
  });
  service.remove(['script', 'style', 'title']);
  return service;
}

/** The original's semantic rules: article between dividers, section and figure spaced, aside quoted. */
export function addSemanticRules(service: TurndownService): void {
  service.addRule('article', { filter: 'article', replacement: (content) => '\n\n---\n\n' + content.trim() + '\n\n---\n\n' });
  service.addRule('section', { filter: 'section', replacement: (content) => '\n\n' + content.trim() + '\n\n' });
  service.addRule('aside', {
    filter: 'aside',
    replacement: (content) =>
      '\n\n' +
      content
        .trim()
        .split('\n')
        .map((l) => '> ' + l)
        .join('\n') +
      '\n\n',
  });
  service.addRule('figure', { filter: 'figure', replacement: (content) => '\n\n' + content.trim() + '\n\n' });
}

function isElement(node: Node): node is Element {
  return node.nodeType === 1;
}

function elementChildren(node: Node): Element[] {
  const out: Element[] = [];
  const children = node.childNodes;
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (child !== undefined && isElement(child)) out.push(child);
  }
  return out;
}

function closest(node: Node, name: string): Node | null {
  let at: Node | null = node.parentNode;
  while (at !== null && at.nodeName !== name) at = at.parentNode;
  return at;
}

/** The first <tr> of a table in document order, whether it sits in thead, tbody, tfoot or the table itself. */
function firstRow(table: Node): Node | null {
  for (const child of elementChildren(table)) {
    if (child.nodeName === 'TR') return child;
    if (child.nodeName === 'THEAD' || child.nodeName === 'TBODY' || child.nodeName === 'TFOOT') {
      const row = elementChildren(child).find((c) => c.nodeName === 'TR');
      if (row !== undefined) return row;
    }
  }
  return null;
}

function alignMarker(cell: Element): string {
  switch ((cell.getAttribute('align') ?? '').toLowerCase()) {
    case 'left':
      return ':--';
    case 'right':
      return '--:';
    case 'center':
      return ':-:';
    default:
      return '---';
  }
}

function tableCell(content: string, node: Node): string {
  const parent = node.parentNode;
  const index = parent === null ? 0 : elementChildren(parent).findIndex((c) => c === node);
  const text = content
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ')
    .replace(/\|/g, '\\|');
  return (index <= 0 ? '| ' : ' ') + text + ' |';
}

/** Rows one per line; the table's first row is the header (a blank one is invented when it holds <td>s), followed by the delimiter row. */
function tableRow(content: string, node: Node): string {
  const cells = elementChildren(node).filter((c) => c.nodeName === 'TH' || c.nodeName === 'TD');
  if (cells.length === 0) return '';
  const table = closest(node, 'TABLE');
  if (table === null || firstRow(table) !== node) return '\n' + content;
  const delimiter = '\n' + cells.map((c, i) => (i === 0 ? '| ' : ' ') + alignMarker(c) + ' |').join('');
  const isHeading = node.parentNode?.nodeName === 'THEAD' || cells.every((c) => c.nodeName === 'TH');
  if (isHeading) return '\n' + content + delimiter;
  const blank = '\n' + cells.map((_c, i) => (i === 0 ? '|  |' : '  |')).join('');
  return blank + delimiter + '\n' + content;
}

/** GitHub flavour on top of turndown's CommonMark set: ~~strikethrough~~ and pipe tables (cells flattened to one line, pipes escaped). */
export function addGfmRules(service: TurndownService): void {
  service.addRule('strikethrough', { filter: ['del', 's', 'strike'], replacement: (content) => '~~' + content + '~~' });
  service.addRule('tableSection', { filter: ['thead', 'tbody', 'tfoot'], replacement: (content) => content });
  service.addRule('tableCaption', { filter: 'caption', replacement: (content) => '\n\n' + content.trim() + '\n\n' });
  service.addRule('tableCell', { filter: ['th', 'td'], replacement: tableCell });
  service.addRule('tableRow', { filter: 'tr', replacement: tableRow });
  service.addRule('table', { filter: 'table', replacement: (content) => '\n\n' + content.trim() + '\n\n' });
}

const BLOCK_TAG = /<\/?(?:div|table|thead|tbody|tr|td|th|ul|ol|li|p|h[1-6]|blockquote|pre|form|section|article|nav|header|footer|main|aside)\b[^>]*>/i;

/** The original's structural checks, as warnings: empty output, block-level or script/style tags that survived. */
export function markdownIssues(output: string): string[] {
  if (output.trim().length === 0) return ['the output is empty'];
  const warnings: string[] = [];
  if (BLOCK_TAG.test(output)) warnings.push('block-level HTML tags remain in the output (the source had escaped markup)');
  if (/<script[^<>]*>/i.test(output) || /<style[^<>]*>/i.test(output)) warnings.push('script or style tags remain in the output; the "clean" strategy strips them first');
  return warnings;
}

export const htmlToMd: Converter = {
  spec: {
    id: 'html-to-md',
    title: 'HTML to Markdown',
    description: 'Markdown from HTML through turndown: plain, with HTML5 sectioning kept as structure, or with page boilerplate stripped first.',
    from: ['html'],
    to: ['md'],
    engine: 'turndown',
    maxInputBytes: MARKUP_INPUT_BYTES,
    strategies: [
      { id: 'turndown', description: 'Turndown with atx headings, fenced code, dash bullets and asterisk emphasis.', when: 'The input is clean HTML content without much boilerplate.' },
      { id: 'semantic', description: 'Articles sit between dividers, sections and figures get their own spacing, asides become quotes.', when: 'The input uses article, section, aside or figure elements.' },
      { id: 'clean', description: 'Scripts, styles, nav, header, footer, asides, iframes, noscript and comments are stripped first.', when: 'The input is a raw web page with navigation, ads and scripts around the content.' },
    ],
    defaultStrategy: 'turndown',
    options: [
      { name: 'gfm', type: 'boolean', description: 'GitHub tables (| a | b |) and ~~strikethrough~~ on top of turndown\'s CommonMark rules; false reproduces the original converter.', default: true },
    ],
  },
  async execute(input, strategy, options): Promise<ExecuteResult> {
    if (input.trim().length === 0) throw new Error('HTML input is empty');
    const service = createTurndown();
    if (options['gfm'] !== false) addGfmRules(service);
    if (strategy === 'semantic') addSemanticRules(service);
    const html = strategy === 'clean' ? removeNonContent(input) : input;
    const output = service.turndown(html).replace(/\n{3,}/g, '\n\n').trim();
    const warnings = markdownIssues(output);
    return {
      output,
      stats: { inputLength: input.length, outputLength: output.length, tagsStripped: strategy === 'clean' },
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },
};
