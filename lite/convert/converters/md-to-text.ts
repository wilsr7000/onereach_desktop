/**
 * Markdown → plain text (ported from lib/converters/md-to-text.js, ADR-100).
 * Strategies: strip (every marker removed, the words kept), readable
 * (headings in capitals over a rule, lists dashed, quotes barred, code
 * indented), outline (headings indented by depth, each followed by the
 * first sentence under it). Pure text work.
 *
 * Amendment 1: images, links, reference links and tags are removed in
 * linear passes (lite/convert/scan.ts); the `\[([^\]]*)\]\(…\)` regexes
 * rescanned from every `[` that had no `]` and took 27 s on 400 KB.
 */

import { TEXT_SCAN_INPUT_BYTES, type Converter, type ExecuteResult } from '../types.js';
import { replaceBracketed, stripTags } from '../scan.js';

/** Images keep their alt text, links and reference links their text — in the order the regexes ran. */
export function stripLinks(text: string): string {
  const images = replaceBracketed(text, '![', ']', '(', ')');
  const links = replaceBracketed(images, '[', ']', '(', ')');
  return replaceBracketed(links, '[', ']', '[', ']');
}

/** Inline formatting removed: images and links keep their text, code its content, emphasis and strikethrough their words. */
export function stripInline(text: string): string {
  return stripLinks(text)
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/___(.+?)___/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/~~(.+?)~~/g, '$1');
}

/** Every Markdown marker removed; fenced code keeps its content, lists their words, blank runs collapse. */
export function stripMarkdown(text: string): string {
  let result = text;
  result = result.replace(/```[\s\S]*?```/g, (block) => block.replace(/^```\w*\n?/, '').replace(/\n?```$/, ''));
  result = result.replace(/`([^`]+)`/g, '$1');
  result = stripLinks(result);
  result = result.replace(/^#{1,6}\s+/gm, '');
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, '$1');
  result = result.replace(/\*\*(.+?)\*\*/g, '$1');
  result = result.replace(/\*(.+?)\*/g, '$1');
  result = result.replace(/___(.+?)___/g, '$1');
  result = result.replace(/__(.+?)__/g, '$1');
  result = result.replace(/_(.+?)_/g, '$1');
  result = result.replace(/~~(.+?)~~/g, '$1');
  result = result.replace(/^[-*_]{3,}\s*$/gm, '');
  result = result.replace(/^>\s?/gm, '');
  // The original's `^[\s]*` let \s cross newlines and ate the blank line before a list; [ \t]* keeps the paragraph break.
  result = result.replace(/^[ \t]*[-*+]\s+/gm, '');
  result = result.replace(/^[ \t]*\d+\.\s+/gm, '');
  result = stripTags(result);
  result = result.replace(/^\[[^\]\n]*\]:\s+.*$/gm, '');
  result = result.replace(/\n{3,}/g, '\n\n');
  return result.trim();
}

/** Headings become CAPITALS (h1/h2 over a rule of =), fences indent their code, quotes get a bar, lists a dash. */
export function readableConvert(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i] ?? '';
    const heading = /^(#{1,6})\s+(.*)/.exec(line);
    if (heading !== null) {
      const level = (heading[1] ?? '').length;
      const title = stripInline(heading[2] ?? '').toUpperCase();
      out.push('', title);
      if (level <= 2) out.push('='.repeat(Math.min(title.length, 60)));
      out.push('');
      continue;
    }
    if (/^```/.test(line)) {
      let j = i + 1;
      while (j < lines.length && !/^```/.test(lines[j] ?? '')) {
        out.push('    ' + (lines[j] ?? ''));
        j += 1;
      }
      i = j;
      continue;
    }
    if (/^>\s?/.test(line)) line = '  | ' + line.replace(/^>\s?/, '');
    const bullet = /^(\s*)[-*+]\s+(.*)/.exec(line);
    if (bullet !== null) line = (bullet[1] ?? '') + '- ' + stripInline(bullet[2] ?? '');
    const ordered = /^(\s*)\d+\.\s+(.*)/.exec(line);
    if (ordered !== null) line = (ordered[1] ?? '') + '- ' + stripInline(ordered[2] ?? '');
    if (/^[-*_]{3,}\s*$/.test(line)) {
      out.push('');
      continue;
    }
    out.push(stripInline(line));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Headings indented two spaces per level, each followed by the first sentence beneath it as a quoted line. */
export function outlineConvert(text: string): string {
  const out: string[] = [];
  let lastWasHeading = false;
  let captured = false;
  for (const line of text.split('\n')) {
    const heading = /^(#{1,6})\s+(.*)/.exec(line);
    if (heading !== null) {
      const level = (heading[1] ?? '').length;
      out.push('  '.repeat(level - 1) + stripInline(heading[2] ?? ''));
      lastWasHeading = true;
      captured = false;
      continue;
    }
    if (!lastWasHeading || captured) continue;
    const trimmed = line.trim();
    if (trimmed.length === 0 || /^[-*_]{3,}/.test(trimmed) || /^```/.test(trimmed)) continue;
    const clean = stripInline(trimmed);
    const sentence = /^[^.!?]*[.!?]/.exec(clean);
    const first = sentence !== null ? sentence[0].trim() : clean;
    const previous = out[out.length - 1];
    const level = previous === undefined ? 1 : (/^(\s*)/.exec(previous)?.[1]?.length ?? 0) / 2 + 1;
    out.push('  '.repeat(level) + '> ' + first);
    captured = true;
    lastWasHeading = false;
  }
  return out.join('\n').trim();
}

/** The original's structural checks for the strip strategy, as warnings: markers that survived. */
export function strippedIssues(output: string): string[] {
  const warnings: string[] = [];
  if (/^#{1,6}\s/m.test(output)) warnings.push('heading markers remain in the output');
  if (/\*\*[^*]+\*\*/.test(output) || /__[^_]+__/.test(output)) warnings.push('bold or italic markers remain in the output');
  if (/\[[^\[\]]+\]\([^()]+\)/.test(output)) warnings.push('link syntax remains in the output');
  return warnings;
}

export const mdToText: Converter = {
  spec: {
    id: 'md-to-text',
    title: 'Markdown to text',
    description: 'Plain text from Markdown: markers stripped, structure kept with capitals and spacing, or an outline of headings.',
    from: ['md'],
    to: ['text'],
    engine: 'pure',
    maxInputBytes: TEXT_SCAN_INPUT_BYTES,
    strategies: [
      { id: 'strip', description: 'Every marker removed; the words and paragraph breaks stay.', when: 'Clean text with no formatting artefacts is wanted.' },
      { id: 'readable', description: 'Headings in capitals over a rule, lists dashed, quotes barred, code indented.', when: 'Someone will read the text and the hierarchy should still show.' },
      { id: 'outline', description: 'Headings indented by depth, each with the first sentence beneath it.', when: 'A table of contents or a quick summary of the document is wanted.' },
    ],
    defaultStrategy: 'strip',
  },
  async execute(input, strategy, _options): Promise<ExecuteResult> {
    if (input.trim().length === 0) throw new Error('Markdown input is empty');
    let output: string;
    switch (strategy) {
      case 'readable':
        output = readableConvert(input);
        break;
      case 'outline':
        output = outlineConvert(input);
        break;
      case 'strip':
      default:
        output = stripMarkdown(input);
        break;
    }
    const warnings = output.trim().length === 0 ? ['the output is empty'] : strategy === 'strip' ? strippedIssues(output) : [];
    return {
      output,
      stats: { inputLength: input.length, outputLength: output.length, compressionRatio: Number((output.length / input.length).toFixed(2)) },
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },
};
