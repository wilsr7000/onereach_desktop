/**
 * HTML → plain text (ported from lib/converters/html-to-text.js, ADR-100).
 * Strategies: strip (every tag removed, entities decoded, the text runs
 * together), readable (block tags become line breaks, list items get a
 * dash, boilerplate regions are dropped), article (only the <article>,
 * <main>, role="main" or <body> region, rendered the readable way).
 * Pure regex work — no DOM, no dependencies.
 */

import type { Converter, ExecuteResult } from '../types.js';

/** The named entities the original decoded; numeric references are handled in decodeEntities. */
export const HTML_ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&ndash;': '–',
  '&mdash;': '—',
  '&laquo;': '«',
  '&raquo;': '»',
  '&copy;': '©',
  '&reg;': '®',
  '&trade;': '™',
  '&hellip;': '…',
};

function codePoint(code: number, fallback: string): string {
  return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback;
}

/** Named entities from the table, then decimal (&#169;) and hex (&#x1F600;) character references. */
export function decodeEntities(text: string): string {
  let out = text;
  for (const [entity, ch] of Object.entries(HTML_ENTITIES)) out = out.split(entity).join(ch);
  out = out.replace(/&#(\d+);/g, (match, code: string) => codePoint(Number.parseInt(code, 10), match));
  out = out.replace(/&#x([0-9a-f]+);/gi, (match, code: string) => codePoint(Number.parseInt(code, 16), match));
  return out;
}

/** Scripts, styles and comments gone, every other tag removed, entities decoded, runs of spaces and tabs collapsed. */
export function stripAllTags(html: string): string {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text).replace(/[ \t]+/g, ' ').trim();
}

/** Script, style, nav, footer, header, aside, iframe, noscript and comment blocks removed. Shared with html-to-md's clean strategy. */
export function removeNonContent(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

const MAIN_REGIONS: readonly RegExp[] = [
  /<article[\s\S]*?>([\s\S]*?)<\/article>/i,
  /<main[\s\S]*?>([\s\S]*?)<\/main>/i,
  /<div[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/div>/i,
  /<body[\s\S]*?>([\s\S]*?)<\/body>/i,
];

/** The <article>, else <main>, else <div role="main">, else <body> region; the whole input when none is found. */
export function extractMainContent(html: string): string {
  for (const re of MAIN_REGIONS) {
    const m = re.exec(html);
    if (m !== null && m[1] !== undefined) return m[1];
  }
  return html;
}

/**
 * Block structure as line breaks: <br> → newline, closing block tags → blank
 * line, <hr> → ---, cell ends → tab, <li> → "- ". Then every tag is stripped,
 * lines are right-trimmed and runs of blank lines collapse to one.
 */
export function readableText(html: string): string {
  const spaced = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|h[1-6]|li|tr|blockquote|pre|section|article|aside|header|footer|main)>/gi, '\n\n')
    .replace(/<(?:hr)\s*\/?>/gi, '\n---\n')
    .replace(/<\/(?:td|th)>/gi, '\t')
    .replace(/<li[^>]*>/gi, '\n- ');
  return stripAllTags(spaced)
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
  if (/<[a-z][\s\S]*?>/i.test(output)) warnings.push('HTML tags remain in the output (the source had escaped markup)');
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
