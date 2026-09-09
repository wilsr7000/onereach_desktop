/**
 * HTML → plain text (ported from lib/converters/html-to-text.js, ADR-100).
 * Strategies: strip (every tag removed, entities decoded, the text runs
 * together), readable (block tags become line breaks, list items get a
 * dash, boilerplate regions are dropped), article (only the <article>,
 * <main>, role="main" or <body> region, rendered the readable way).
 *
 * Amendment 1: the tag work is one linear pass (lite/convert/scan.ts);
 * the regex version rescanned from every `<script` that had no closer
 * and took minutes on a megabyte. Entities decode in one pass, so an
 * `&amp;lt;` never becomes a live `<`.
 */

import { TEXT_SCAN_INPUT_BYTES, type Converter, type ExecuteResult } from '../types.js';
import { decodeEntities, HTML_ENTITIES } from '../html-entities.js';
import { elementContent, removeElements, replaceTags, stripTags } from '../scan.js';

export { decodeEntities, HTML_ENTITIES };

/** Regions that are page furniture, not content; removed with their bodies by the readable and article strategies. */
export const NON_CONTENT_ELEMENTS: readonly string[] = ['script', 'style', 'nav', 'footer', 'header', 'aside', 'iframe', 'noscript'];

const BLOCK_CLOSERS: ReadonlySet<string> = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'blockquote', 'pre', 'section', 'article', 'aside', 'header', 'footer', 'main']);

/** Scripts, styles and comments gone, every other tag removed, entities decoded, runs of spaces and tabs collapsed. */
export function stripAllTags(html: string): string {
  const text = stripTags(removeElements(html, ['script', 'style']));
  return decodeEntities(text).replace(/[ \t]+/g, ' ').trim();
}

/** Script, style, nav, footer, header, aside, iframe, noscript and comment blocks removed. Shared with html-to-md's clean strategy. */
export function removeNonContent(html: string): string {
  return removeElements(html, NON_CONTENT_ELEMENTS);
}

const ROLE_MAIN = /role=["']main["']/i;

/** The <article>, else <main>, else <div role="main">, else <body> region; the whole input when none is found. */
export function extractMainContent(html: string): string {
  return (
    elementContent(html, 'article') ??
    elementContent(html, 'main') ??
    elementContent(html, 'div', (tag) => ROLE_MAIN.test(tag)) ??
    elementContent(html, 'body') ??
    html
  );
}

/**
 * Block structure as line breaks: <br> → newline, closing block tags → blank
 * line, <hr> → ---, cell ends → tab, <li> → "- ". Then every tag is stripped,
 * lines are right-trimmed and runs of blank lines collapse to one.
 */
export function readableText(html: string): string {
  const spaced = replaceTags(removeElements(html, ['script', 'style']), (tag) => {
    if (tag.closing) {
      if (BLOCK_CLOSERS.has(tag.name)) return '\n\n';
      if (tag.name === 'td' || tag.name === 'th') return '\t';
      return '';
    }
    if (tag.name === 'br') return '\n';
    if (tag.name === 'hr') return '\n---\n';
    if (tag.name === 'li') return '\n- ';
    return '';
  });
  return decodeEntities(spaced)
    .replace(/[ \t]+/g, ' ')
    .trim()
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The original's structural checks, as warnings: empty output, tags or entities that survived. */
export function textIssues(output: string): string[] {
  if (output.trim().length === 0) return ['the output is empty'];
  const warnings: string[] = [];
  if (/<[a-z][^<>]*>/i.test(output)) warnings.push('HTML tags remain in the output (the source had escaped markup)');
  if (/&(?:amp|lt|gt|quot|nbsp|#\d+);/i.test(output)) warnings.push('undecoded HTML entities remain in the output');
  return warnings;
}

export const htmlToText: Converter = {
  spec: {
    id: 'html-to-text',
    title: 'HTML to text',
    description: 'Plain text from HTML: every tag stripped, block structure kept as line breaks, or the article region alone.',
    from: ['html'],
    to: ['text'],
    engine: 'pure',
    maxInputBytes: TEXT_SCAN_INPUT_BYTES,
    strategies: [
      { id: 'strip', description: 'Every tag removed and entities decoded; the text runs together.', when: 'A quick text dump is enough and layout does not matter.' },
      { id: 'readable', description: 'Block tags become line breaks and list items get a dash; scripts, styles, nav, header, footer and asides are dropped.', when: 'Someone will read the text and paragraph breaks matter.' },
      { id: 'article', description: 'Only the <article>, <main>, role="main" or <body> region, rendered the readable way.', when: 'The input is a whole web page and only the story matters.' },
    ],
    defaultStrategy: 'readable',
  },
  async execute(input, strategy, _options): Promise<ExecuteResult> {
    if (input.trim().length === 0) throw new Error('HTML input is empty');
    let output: string;
    switch (strategy) {
      case 'readable':
        output = readableText(removeNonContent(input));
        break;
      case 'article':
        output = readableText(removeNonContent(extractMainContent(input)));
        break;
      case 'strip':
      default:
        output = stripAllTags(input);
        break;
    }
    const warnings = textIssues(output);
    return {
      output,
      stats: { inputLength: input.length, outputLength: output.length, compressionRatio: Number((output.length / input.length).toFixed(3)) },
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },
};
