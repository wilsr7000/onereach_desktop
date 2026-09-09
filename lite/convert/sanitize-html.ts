/**
 * HTML sanitiser for converter output (ADR-100 Amendment 1).
 *
 * marked renders the raw HTML inside Markdown verbatim and has no
 * sanitiser of its own (marked 17 dropped it), so md-to-html carried
 * `<script>` and `onerror=` straight through — into a self-opening page
 * for the styled strategy. This is an allowlist pass over the rendered
 * HTML: known elements keep known attributes; links, images and cites
 * keep http(s), mailto, tel and relative URLs (images also data:image);
 * everything else goes — scripts, styles, frames, forms, event handlers,
 * inline styles, unknown elements (their text stays), comments, and any
 * `<` that does not parse as a tag (it becomes `&lt;`).
 *
 * Linear, by construction: one walk, quote-aware, and a tag that runs
 * into the next `<` is abandoned there, so no region is scanned twice.
 * Output that needed no change is byte-identical to the input. The
 * case fold used for matching is ASCII-only and length-stable, so an
 * offset found in the folded copy always lands on the same character
 * of the original (a `toLowerCase()` copy grows on U+0130 and let a
 * tag through behind a run of İ).
 */

import { decodeEntities } from './html-entities.js';
import { ForwardSearch, asciiLower, findClosingTag } from './scan.js';

const GLOBAL_ATTRS: ReadonlySet<string> = new Set(['class', 'id', 'title', 'lang', 'dir', 'align']);

const ELEMENT_ATTRS: Readonly<Record<string, readonly string[]>> = {
  a: ['href', 'name', 'rel'],
  img: ['src', 'alt', 'width', 'height'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan', 'scope'],
  ol: ['start', 'type', 'reversed'],
  li: ['value'],
  input: ['type', 'checked', 'disabled'],
  details: ['open'],
  col: ['span'],
  colgroup: ['span'],
  q: ['cite'],
  blockquote: ['cite'],
  del: ['cite', 'datetime'],
  ins: ['cite', 'datetime'],
  time: ['datetime'],
};

/** Elements that survive, with their text. */
export const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set([
  'a', 'abbr', 'article', 'aside', 'b', 'big', 'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'col', 'colgroup',
  'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'i', 'img', 'input', 'ins', 'kbd', 'li', 'main', 'mark', 'nav', 'ol', 'p', 'pre', 'q', 's', 'samp', 'section',
  'small', 'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr',
  'tt', 'u', 'ul', 'var', 'wbr',
]);

/** Elements removed together with everything inside them. */
export const DROPPED_WITH_CONTENT: ReadonlySet<string> = new Set([
  'script', 'style', 'template', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'svg', 'math',
  'head', 'title', 'xmp', 'plaintext', 'textarea', 'select', 'button', 'form',
]);

const URL_ATTRS: ReadonlySet<string> = new Set(['href', 'src', 'cite']);
const SAFE_PREFIXES = ['http://', 'https://', 'mailto:', 'tel:'];
const DATA_IMAGE = /^data:image\/(?:png|gif|jpeg|jpg|webp|bmp);base64,[a-z0-9+/=]*$/i;

/** Control characters and spaces removed, as browsers do before reading a URL's scheme. */
function stripUrlNoise(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c <= 0x20 || (c >= 0x7f && c <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

interface Attribute {
  name: string;
  /** The value as written, quotes included when quoted; null for a bare attribute. */
  raw: string | null;
  value: string;
}

interface ParsedTag {
  name: string;
  closing: boolean;
  attrs: Attribute[];
  /** Offset after `>`. */
  end: number;
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
}

function isLetter(code: number): boolean {
  return code >= 97 && code <= 122;
}

function isNameChar(code: number): boolean {
  return isLetter(code) || (code >= 48 && code <= 57) || code === 45 || code === 58; // a-z 0-9 - :
}

/**
 * The tag at `lt`, or null when it is not one: no name, no `>` before the
 * text ends, a `<` inside it, an unterminated quote. Quote-aware, so a `>`
 * inside a quoted value does not end the tag.
 */
function parseTag(html: string, lower: string, lt: number): ParsedTag | null {
  const len = html.length;
  let j = lt + 1;
  let closing = false;
  if (html.charCodeAt(j) === 47) {
    closing = true;
    j += 1;
  }
  const nameStart = j;
  if (j >= len || !isLetter(lower.charCodeAt(j))) return null;
  while (j < len && isNameChar(lower.charCodeAt(j))) j += 1;
  const name = lower.slice(nameStart, j);
  const attrs: Attribute[] = [];
  for (;;) {
    while (j < len && isSpace(html.charCodeAt(j))) j += 1;
    if (j >= len) return null;
    const c = html.charCodeAt(j);
    if (c === 62) return { name, closing, attrs, end: j + 1 }; // >
    if (c === 47) {
      j += 1;
      continue;
    }
    if (c === 60) return null; // < : ran into the next tag
    const an = j;
    while (j < len) {
      const k = html.charCodeAt(j);
      if (isSpace(k) || k === 61 || k === 62 || k === 47 || k === 60) break;
      j += 1;
    }
    if (j === an) {
      j += 1; // a stray quote or similar where a name should be
      continue;
    }
    const attrName = lower.slice(an, j);
    while (j < len && isSpace(html.charCodeAt(j))) j += 1;
    let raw: string | null = null;
    let value = '';
    if (html.charCodeAt(j) === 61) {
      j += 1;
      while (j < len && isSpace(html.charCodeAt(j))) j += 1;
      const q = html.charCodeAt(j);
      if (q === 34 || q === 39) {
        const endq = html.indexOf(String.fromCharCode(q), j + 1);
        if (endq === -1) return null;
        raw = html.slice(j, endq + 1);
        value = html.slice(j + 1, endq);
        j = endq + 1;
      } else {
        const vs = j;
        while (j < len) {
          const k = html.charCodeAt(j);
          if (isSpace(k) || k === 62 || k === 60) break;
          j += 1;
        }
        if (html.charCodeAt(j) === 60) return null;
        value = html.slice(vs, j);
        raw = `"${value.replace(/"/g, '&quot;')}"`;
      }
    }
    attrs.push({ name: attrName, raw, value });
  }
}

/** A URL a link or image may keep: http(s), mailto, tel, relative, an anchor; images also data:image. */
export function isSafeUrl(rawValue: string, allowDataImage = false): boolean {
  const cleaned = stripUrlNoise(decodeEntities(rawValue));
  const lower = cleaned.toLowerCase();
  if (SAFE_PREFIXES.some((p) => lower.startsWith(p))) return true;
  if (allowDataImage && DATA_IMAGE.test(cleaned)) return true;
  if (lower.startsWith('#') || lower.startsWith('/') || lower.startsWith('?') || lower.startsWith('./') || lower.startsWith('../')) return true;
  // A bare relative reference: nothing that could be a scheme, and no entity we did not decode (&colon; and friends) before the path.
  const head = lower.split(/[/?#]/, 1)[0] ?? '';
  return !head.includes(':') && !head.includes('&');
}

function attrValue(tag: ParsedTag, name: string): string | null {
  const a = tag.attrs.find((x) => x.name === name);
  return a === undefined ? null : a.value;
}

function renderTag(tag: ParsedTag): string {
  const allowed = ELEMENT_ATTRS[tag.name] ?? [];
  let out = `<${tag.name}`;
  for (const a of tag.attrs) {
    if (!GLOBAL_ATTRS.has(a.name) && !allowed.includes(a.name)) continue;
    if (URL_ATTRS.has(a.name) && !isSafeUrl(a.value, tag.name === 'img' && a.name === 'src')) continue;
    out += a.raw === null ? ` ${a.name}` : ` ${a.name}=${a.raw}`;
  }
  return `${out}>`;
}

/** The allowlist pass. Text is kept as written (it is already HTML text); only tags are judged. */
export function sanitizeHtml(html: string): string {
  if (!html.includes('<')) return html;
  const len = html.length;
  // Length-stable fold: offsets found in `lower` index `html` (see asciiLower).
  const lower = asciiLower(html);
  const search = new ForwardSearch(lower);
  const parts: string[] = [];
  let i = 0;
  while (i < len) {
    const lt = search.indexOf('<', i);
    if (lt === -1) {
      parts.push(html.slice(i));
      break;
    }
    parts.push(html.slice(i, lt));
    if (lower.startsWith('<!--', lt)) {
      const end = search.indexOf('-->', lt + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (lower.startsWith('<!', lt) || lower.startsWith('<?', lt)) {
      const end = search.indexOf('>', lt);
      i = end === -1 ? len : end + 1;
      continue;
    }
    const tag = parseTag(html, lower, lt);
    if (tag === null) {
      parts.push('&lt;');
      i = lt + 1;
      continue;
    }
    i = tag.end;
    if (tag.closing) {
      if (ALLOWED_ELEMENTS.has(tag.name)) parts.push(`</${tag.name}>`);
      continue;
    }
    if (DROPPED_WITH_CONTENT.has(tag.name)) {
      const close = findClosingTag(lower, search, tag.name, tag.end);
      i = close === -1 ? len : close;
      continue;
    }
    if (!ALLOWED_ELEMENTS.has(tag.name)) continue;
    if (tag.name === 'input' && (attrValue(tag, 'type') ?? '').trim().toLowerCase() !== 'checkbox') continue;
    parts.push(renderTag(tag));
  }
  return parts.join('');
}
