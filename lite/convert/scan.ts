/**
 * Linear text scanning (ADR-100 Amendment 1).
 *
 * The converters used to strip tags and markers with regexes shaped
 * `<tag[\s\S]*?</tag>`, `<[^>]+>` and `\[([^\]]*)\]\(…\)`. When the
 * opener repeats and the closer never comes, every start rescans to the
 * end: quadratic. The release review measured 24 s on 1 MB of `<script`
 * and 27 s on 400 KB of `![` — hours at the input cap, in a process
 * that answers one client and cannot be interrupted.
 *
 * Everything here walks the text once. Openers are found with indexOf
 * from a cursor that only moves forward, and a closer that was not found
 * once is not looked for again ({@link ForwardSearch}), so the total work
 * is proportional to the input whatever it contains.
 */

/** indexOf with memory: each needle is searched forward once. */
export class ForwardSearch {
  private readonly memo = new Map<string, { at: number; from: number }>();

  constructor(private readonly text: string) {}

  /**
   * The first `needle` at or after `from`. A hit is remembered and reused
   * while `from` stays at or before it; a miss is remembered for every
   * later `from`, which is what keeps repeated openers linear.
   */
  indexOf(needle: string, from: number): number {
    const m = this.memo.get(needle);
    if (m !== undefined && from >= m.from) {
      if (m.at === -1) return -1;
      if (m.at >= from) return m.at;
    }
    const at = this.text.indexOf(needle, from);
    this.memo.set(needle, { at, from });
    return at;
  }
}

function isNameChar(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 45; // a-z 0-9 -
}

function isLetter(code: number): boolean {
  return code >= 97 && code <= 122;
}

/** The lowercase tag name starting at `at` (after `<` or `</`), or '' when there is none. */
export function tagNameAt(lower: string, at: number): string {
  if (at >= lower.length || !isLetter(lower.charCodeAt(at))) return '';
  let j = at + 1;
  while (j < lower.length && isNameChar(lower.charCodeAt(j))) j += 1;
  return lower.slice(at, j);
}

/** True when the character at `at` ends a tag name: whitespace, `>`, `/` or the end of the text. */
export function isNameEnd(text: string, at: number): boolean {
  if (at >= text.length) return true;
  const c = text.charCodeAt(at);
  return c === 62 || c === 47 || c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
}

export interface TagToken {
  /** Lowercase element name; '' for `<!…>`, `<?…>` and other non-elements. */
  name: string;
  closing: boolean;
  /** Offset of `<`. */
  start: number;
  /** Offset after `>`. */
  end: number;
}

/**
 * Every `<…>` run, in order, the way `<[^>]+>` saw them: from a `<` to
 * the first `>` after it (so `<a <b>` is one tag, as the regex had it);
 * a `<` with no `>` anywhere after it is text, and so is `<>`.
 */
export function forEachTag(html: string, onTag: (tag: TagToken) => void, onText: (start: number, end: number) => void): void {
  const lower = html.toLowerCase();
  const search = new ForwardSearch(lower);
  let i = 0;
  while (i < html.length) {
    const lt = search.indexOf('<', i);
    if (lt === -1) break;
    const gt = search.indexOf('>', lt + 1);
    if (gt === -1) break;
    if (gt === lt + 1) {
      // `<>` is text
      onText(i, lt + 2);
      i = lt + 2;
      continue;
    }
    if (lt > i) onText(i, lt);
    const closing = lower.charCodeAt(lt + 1) === 47;
    onTag({ name: tagNameAt(lower, closing ? lt + 2 : lt + 1), closing, start: lt, end: gt + 1 });
    i = gt + 1;
  }
  if (i < html.length) onText(i, html.length);
}

/** Every tag replaced by what `replacement` returns ('' strips it); text kept. */
export function replaceTags(html: string, replacement: (tag: TagToken) => string): string {
  if (!html.includes('<')) return html;
  const parts: string[] = [];
  forEachTag(
    html,
    (tag) => {
      const r = replacement(tag);
      if (r.length > 0) parts.push(r);
    },
    (start, end) => parts.push(html.slice(start, end))
  );
  return parts.join('');
}

/** `<[^>]+>` without the rescans: every tag removed, text kept. */
export function stripTags(html: string): string {
  return replaceTags(html, () => '');
}

/**
 * Whole elements removed with their content — `<script>…</script>`,
 * comments — in one pass. An element whose closer never comes is
 * dropped to the end of the text, as a browser would render it; the
 * old `<script[\s\S]*?</script>` left its body behind as text.
 */
export function removeElements(html: string, names: readonly string[], removeComments = true): string {
  if (!html.includes('<')) return html;
  const lower = html.toLowerCase();
  const search = new ForwardSearch(lower);
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const parts: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = search.indexOf('<', i);
    if (lt === -1) {
      parts.push(html.slice(i));
      i = html.length;
      break;
    }
    parts.push(html.slice(i, lt));
    if (removeComments && lower.startsWith('<!--', lt)) {
      const end = search.indexOf('-->', lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    const name = tagNameAt(lower, lt + 1);
    if (name.length > 0 && wanted.has(name) && isNameEnd(lower, lt + 1 + name.length)) {
      const close = findClosingTag(lower, search, name, lt + 1 + name.length);
      i = close === -1 ? html.length : close;
      continue;
    }
    parts.push('<');
    i = lt + 1;
  }
  return parts.join('');
}

/** Offset after the `>` of the first `</name…>` at or after `from`, or -1. */
export function findClosingTag(lower: string, search: ForwardSearch, name: string, from: number): number {
  const needle = '</' + name;
  let at = from;
  for (;;) {
    const close = search.indexOf(needle, at);
    if (close === -1) return -1;
    if (isNameEnd(lower, close + needle.length)) {
      const gt = search.indexOf('>', close);
      return gt === -1 ? lower.length : gt + 1;
    }
    at = close + 1;
  }
}

/**
 * The content of the first `<name …>…</name>` element, or null. `check`
 * can refuse an opener by its tag text (a `<div>` without role="main").
 * Linear: an opener whose `>` or closer is missing means no later
 * opener has one either, so the search stops there.
 */
export function elementContent(html: string, name: string, check?: (tagText: string) => boolean): string | null {
  const lower = html.toLowerCase();
  const search = new ForwardSearch(lower);
  const opener = '<' + name;
  let at = 0;
  for (;;) {
    const lt = search.indexOf(opener, at);
    if (lt === -1) return null;
    at = lt + 1;
    if (!isNameEnd(lower, lt + opener.length)) continue;
    const gt = search.indexOf('>', lt + opener.length);
    if (gt === -1) return null;
    if (check !== undefined && !check(html.slice(lt, gt + 1))) continue;
    const close = search.indexOf('</' + name + '>', gt + 1);
    if (close === -1) return null;
    return html.slice(gt + 1, close);
  }
}

/**
 * `open text mid open2 … close2` runs replaced by their text, the way
 * `!\[([^\]]*)\]\([^)]*\)` did it (the first `mid` after the opener, the
 * first `close2` after that), without the rescans. Used for images,
 * links and reference links in Markdown.
 */
export function replaceBracketed(text: string, open: string, mid: string, open2: string, close2: string): string {
  if (!text.includes(open)) return text;
  const search = new ForwardSearch(text);
  const parts: string[] = [];
  let i = 0;
  for (;;) {
    const p = search.indexOf(open, i);
    if (p === -1) break;
    const m = search.indexOf(mid, p + open.length);
    if (m === -1) break;
    if (text.startsWith(open2, m + mid.length)) {
      const c = search.indexOf(close2, m + mid.length + open2.length);
      if (c === -1) break;
      parts.push(text.slice(i, p), text.slice(p + open.length, m));
      i = c + close2.length;
      continue;
    }
    // Not a match at this opener; the next attempt starts one character on.
    parts.push(text.slice(i, p + 1));
    i = p + 1;
  }
  parts.push(text.slice(i));
  return parts.join('');
}
