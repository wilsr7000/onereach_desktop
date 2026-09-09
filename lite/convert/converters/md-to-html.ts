/**
 * Markdown → HTML through `marked` (ported from lib/converters/md-to-html.js,
 * ADR-100). Strategies: standard (CommonMark-ish, no extensions),
 * enhanced (GitHub flavour: tables, task lists, soft breaks become
 * <br>), styled (a complete HTML page with a readable stylesheet).
 */

import { marked } from 'marked';
import type { Converter, ExecuteResult } from '../types.js';

export const PAGE_STYLE = `  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    line-height: 1.6;
    max-width: 800px;
    margin: 0 auto;
    padding: 2rem;
    color: #24292e;
    background: #fff;
  }
  h1, h2, h3, h4, h5, h6 { margin-top: 1.5em; margin-bottom: 0.5em; font-weight: 600; }
  h1 { font-size: 2em; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
  h2 { font-size: 1.5em; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
  p { margin: 0.5em 0 1em; }
  code { background: #f6f8fa; padding: 0.2em 0.4em; border-radius: 3px; font-size: 0.9em; }
  pre { background: #f6f8fa; padding: 1em; border-radius: 6px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 4px solid #dfe2e5; margin: 0; padding: 0 1em; color: #6a737d; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #dfe2e5; padding: 0.5em 1em; text-align: left; }
  th { background: #f6f8fa; font-weight: 600; }
  img { max-width: 100%; height: auto; }
  a { color: #0366d6; text-decoration: none; }
  a:hover { text-decoration: underline; }
  ul, ol { padding-left: 2em; }
  hr { border: none; border-top: 1px solid #eaecef; margin: 2em 0; }`;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The first H1's text, else the first non-empty line, for the page title. */
export function titleFromMarkdown(md: string): string {
  const h1 = /^\s*#\s+(.+?)\s*#*\s*$/m.exec(md);
  if (h1 !== null && h1[1] !== undefined) return h1[1].trim();
  const line = md.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? 'Document';
  return line.replace(/^[#>*_-\s]+/, '').slice(0, 120) || 'Document';
}

export function wrapPage(body: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${PAGE_STYLE}
</style>
</head>
<body>
${body}
</body>
</html>`;
}

export const mdToHtml: Converter = {
  spec: {
    id: 'md-to-html',
    title: 'Markdown to HTML',
    description: 'Renders Markdown as HTML: plain, GitHub-flavoured, or a complete styled page.',
    from: ['md'],
    to: ['html'],
    engine: 'marked',
    strategies: [
      { id: 'standard', description: 'Markdown without extensions.', when: 'The source is plain Markdown and the HTML goes into another page.' },
      { id: 'enhanced', description: 'GitHub flavour: tables, task lists, strikethrough, line breaks kept.', when: 'The source uses tables or task lists, or was written for GitHub.' },
      { id: 'styled', description: 'A complete HTML document with a readable stylesheet.', when: 'The result should open on its own in a browser.' },
    ],
    defaultStrategy: 'enhanced',
    options: [{ name: 'title', type: 'string', description: 'Page title for the styled strategy (defaults to the first heading).' }],
  },
  async execute(input, strategy, options): Promise<ExecuteResult> {
    const gfm = strategy !== 'standard';
    const body = marked.parse(input, { async: false, gfm, breaks: gfm }) as string;
    const output = strategy === 'styled' ? wrapPage(body, typeof options['title'] === 'string' && options['title'].length > 0 ? options['title'] : titleFromMarkdown(input)) : body;
    const headings = (body.match(/<h[1-6][\s>]/gi) ?? []).length;
    return { output, stats: { headings, isDocument: strategy === 'styled' } };
  },
};
