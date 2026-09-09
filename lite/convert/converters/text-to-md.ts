/**
 * Plain text → Markdown (ported from lib/converters/text-to-md.js, ADR-100).
 * Strategies: minimal (the original's — paragraphs split on blank lines,
 * nothing else touched) and structure (deterministic here where the
 * original asked a model: headings, lists and rules are read off the
 * text's own shape; words are never changed, only syntax is added). The
 * original's `rich` strategy was generative and has no port.
 *
 * Structure heuristics: a line over ==== / ---- is a heading; a lone
 * short line in CAPITALS or Title Case that heads something (another
 * paragraph, or a list in the same paragraph) is a heading — the first
 * block of the document gets #, later ones ##; lines opening with a
 * bullet glyph (• - * + – —) become "- " items and "1." / "1)" / "(1)"
 * lines keep their number; deeper indentation nests; a line of --- === ***
 * is a rule. Everything else stays a paragraph, line breaks intact.
 */

import type { Converter, ExecuteResult } from '../types.js';

const BULLET = /^([ \t]*)[•·◦▪▫●○■□‣⁃*+\-–—]\s+(\S.*)$/;
const ORDERED = /^([ \t]*)\(?(\d{1,3})[.)]\s+(\S.*)$/;
const UNDERLINE = /^\s*(?:={3,}|-{3,})\s*$/;
const RULE = /^\s*(?:[-_*=—─]\s*){3,}$/;

interface ListLine {
  indent: number;
  marker: string;
  text: string;
}

interface Segment {
  kind: 'text' | 'list';
  lines: string[];
}

export interface StructureResult {
  output: string;
  paragraphs: number;
  headings: number;
  listItems: number;
}

function indentWidth(ws: string): number {
  return ws.replace(/\t/g, '  ').length;
}

/** The list item a line opens, or null: "- text" → marker "-", "3) text" → marker "3.". */
export function listLine(line: string): ListLine | null {
  const ordered = ORDERED.exec(line);
  if (ordered !== null) return { indent: indentWidth(ordered[1] ?? ''), marker: `${ordered[2] ?? '1'}.`, text: (ordered[3] ?? '').trimEnd() };
  const bullet = BULLET.exec(line);
  if (bullet !== null) return { indent: indentWidth(bullet[1] ?? ''), marker: '-', text: (bullet[2] ?? '').trimEnd() };
  return null;
}

/** True when a plain-text line reads as a heading: short, no closing punctuation, not a list item, key: value or URL, in CAPITALS or Title Case. */
export function looksLikeHeading(line: string): boolean {
  const s = line.trim();
  if (s.length === 0 || s.length > 80 || !/\p{L}/u.test(s)) return false;
  if (/[.,;:!?]$/.test(s) || /^[^:]{1,40}:\s+\S/.test(s) || /^(?:https?:\/\/|www\.)/i.test(s)) return false;
  if (RULE.test(s) || listLine(s) !== null) return false;
  const words = s.split(/\s+/);
  if (words.length > 10) return false;
  const letters = s.replace(/\P{L}/gu, '');
  if (letters === letters.toUpperCase()) return true;
  const capitalised = (w: string): boolean => /^\P{L}*\p{Lu}/u.test(w);
  return capitalised(words[0] ?? '') && words.every((w) => w.replace(/\P{L}/gu, '').length < 4 || capitalised(w));
}

/** Paragraphs as arrays of lines: CRLF folded, split on blank (or whitespace-only) lines, blank edges dropped. */
export function splitParagraphs(text: string): string[][] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n(?:[ \t]*\n)+/)
    .map((chunk) => {
      const lines = chunk.split('\n');
      while (lines.length > 0 && (lines[0] ?? '').trim().length === 0) lines.shift();
      while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim().length === 0) lines.pop();
      return lines;
    })
    .filter((lines) => lines.length > 0);
}

/** The original's minimal strategy: paragraphs split on blank lines, each trimmed, rejoined with one blank line. */
export function minimalConvert(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join('\n\n');
}

function segment(lines: string[]): Segment[] {
  const segments: Segment[] = [];
  for (const line of lines) {
    const current = segments[segments.length - 1];
    if (listLine(line) !== null) {
      if (current !== undefined && current.kind === 'list') current.lines.push(line);
      else segments.push({ kind: 'list', lines: [line] });
    } else if (current !== undefined && (current.kind === 'text' || /^\s/.test(line))) {
      current.lines.push(line);
    } else {
      segments.push({ kind: 'text', lines: [line] });
    }
  }
  return segments;
}

/** Items re-marked ("- " / "n. "), nested three spaces per two of source indent; indented non-item lines stay as continuations. */
export function renderList(lines: string[]): { text: string; items: number } {
  const parsed = lines.map((l) => listLine(l));
  const indents = parsed.flatMap((p) => (p === null ? [] : [p.indent]));
  const base = indents.length > 0 ? Math.min(...indents) : 0;
  let items = 0;
  const out = lines.map((raw, i) => {
    const item = parsed[i];
    if (item === null || item === undefined) return '  ' + raw.trim();
    items += 1;
    const level = Math.max(0, Math.floor((item.indent - base) / 2));
    return '   '.repeat(level) + item.marker + ' ' + item.text;
  });
  return { text: out.join('\n'), items };
}

/** The structure strategy: headings, lists and rules detected from the text's shape; every word kept. */
export function structureConvert(text: string): StructureResult {
  const paragraphs = splitParagraphs(text);
  const blocks: string[] = [];
  let paragraphCount = 0;
  let headings = 0;
  let listItems = 0;
  const pushHeading = (title: string, level?: number): void => {
    const hashes = level !== undefined ? level : blocks.length === 0 ? 1 : 2;
    blocks.push('#'.repeat(hashes) + ' ' + title.trim());
    headings += 1;
  };
  paragraphs.forEach((para, index) => {
    const last = index === paragraphs.length - 1;
    let lines = para;
    const first = lines[0];
    const second = lines[1];
    if (first !== undefined && second !== undefined && UNDERLINE.test(second) && !RULE.test(first) && listLine(first) === null) {
      pushHeading(first, second.trim().startsWith('=') ? 1 : 2);
      lines = lines.slice(2);
      if (lines.length === 0) return;
    }
    const only = lines[0];
    if (lines.length === 1 && only !== undefined && RULE.test(only)) {
      blocks.push('---');
      return;
    }
    const segments = segment(lines);
    segments.forEach((seg, i) => {
      if (seg.kind === 'list') {
        const list = renderList(seg.lines);
        blocks.push(list.text);
        listItems += list.items;
        return;
      }
      const line = seg.lines[0];
      const single = seg.lines.length === 1 && line !== undefined;
      const headsSomething = segments[i + 1]?.kind === 'list' || (segments.length === 1 && !last);
      if (single && headsSomething && looksLikeHeading(line)) {
        pushHeading(line);
        return;
      }
      blocks.push(seg.lines.map((l) => l.trimEnd()).join('\n').trim());
      paragraphCount += 1;
    });
  });
  return { output: blocks.join('\n\n'), paragraphs: paragraphCount, headings, listItems };
}

export const textToMd: Converter = {
  spec: {
    id: 'text-to-md',
    title: 'Text to Markdown',
    description: 'Markdown from plain text: paragraphs split on blank lines, or headings, lists and rules detected from the shape of the text.',
    from: ['text'],
    to: ['md'],
    engine: 'pure',
    strategies: [
      { id: 'minimal', description: 'Paragraphs split on blank lines; nothing else is touched.', when: 'The text is already laid out and must not be reinterpreted.' },
      { id: 'structure', description: 'Headings (underlined, CAPITALS, Title Case), bullet and numbered lists, nesting and rules detected; words never change.', when: 'The text has implicit structure — notes, minutes, outlines — that Markdown should show.' },
    ],
    defaultStrategy: 'structure',
  },
  async execute(input, strategy, _options): Promise<ExecuteResult> {
    if (input.trim().length === 0) throw new Error('text input is empty');
    const warnings: string[] = [];
    let output: string;
    let stats: Record<string, number>;
    if (strategy === 'structure') {
      const r = structureConvert(input);
      output = r.output;
      stats = { paragraphs: r.paragraphs, headings: r.headings, listItems: r.listItems };
      if (r.headings === 0 && r.listItems === 0) warnings.push('no headings or lists were detected; the output is paragraphs only');
    } else {
      output = minimalConvert(input);
      stats = { paragraphs: output.length > 0 ? output.split('\n\n').length : 0 };
    }
    if (output.length < input.length * 0.5) warnings.push(`the output is much shorter than the input (${output.length} vs ${input.length} characters)`);
    return {
      output,
      stats: { inputLength: input.length, outputLength: output.length, ...stats },
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },
};
