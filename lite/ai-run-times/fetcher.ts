/**
 * RSS feed + article HTML fetching for AI Run Times.
 *
 * Uses Node `fetch` (Electron has native fetch). Two operations:
 *
 *  1. `fetchAndParseFeed(url)` -- GET the feed URL, parse the XML
 *     (no DOM in main process, so we use a small regex parser
 *     scoped to the RSS subset uxmag.com / WordPress feeds emit).
 *  2. `fetchArticleContent(url)` -- GET the article HTML and return
 *     the raw bytes verbatim plus a coarse word-count for reading-
 *     time UX. **Extraction happens in the renderer** (see
 *     `article-extractor.ts`) using `DOMParser` and the same
 *     selector cascade the full app uses; the main process never
 *     parses article HTML now that we ship raw bytes through IPC.
 *     Mirrors the full app's `Flipboard-IDW-Feed/uxmag-script.js`
 *     pattern.
 *
 * Both follow up to 5 redirects, time out after 15s, and surface
 * `AiRunTimesError` with `ART_FEED_FETCH_FAILED` /
 * `ART_ARTICLE_FETCH_FAILED` on failure.
 *
 * Pure functions where possible -- the only IO is `fetch`, which
 * tests can override via `_setFetchImplForTesting`.
 *
 * @internal
 */

import {
  AiRunTimesError,
  AI_RUN_TIMES_ERROR_CODES,
} from './errors.js';
import { READING_TIME_WPM, type Article } from './types.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 5;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let fetchImpl: typeof fetch = ((...args) => fetch(...args)) as typeof fetch;

/** @internal -- override fetch for tests. */
export function _setFetchImplForTesting(impl: typeof fetch): void {
  fetchImpl = impl;
}
/** @internal -- restore native fetch. */
export function _resetFetchImplForTesting(): void {
  fetchImpl = ((...args) => fetch(...args)) as typeof fetch;
}

// ─── feed fetching ──────────────────────────────────────────────────────

export interface FetchFeedOptions {
  url: string;
  feedId: string;
  timeoutMs?: number;
}

/** Result: parsed articles in feed order. */
export async function fetchAndParseFeed(opts: FetchFeedOptions): Promise<Article[]> {
  const xml = await getWithRedirects(opts.url, {
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    accept: 'application/rss+xml, application/xml, text/xml, */*',
    onError: (err, status) => feedFetchError(opts.url, err, status),
  });
  return parseRssFeed(xml, opts.feedId);
}

// ─── article fetching ───────────────────────────────────────────────────

export interface FetchArticleOptions {
  url: string;
  timeoutMs?: number;
}

export interface FetchArticleResult {
  html: string;
  wordCount: number;
  readingTimeMinutes: number;
}

export async function fetchArticleContent(opts: FetchArticleOptions): Promise<FetchArticleResult> {
  const html = await getWithRedirects(opts.url, {
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    onError: (err, status) => articleFetchError(opts.url, err, status),
  });
  // Ship the raw HTML untouched -- the renderer parses it with
  // `DOMParser` and applies the source-specific selector cascade
  // (see `article-extractor.ts`). The main process used to run a
  // regex extractor here, but it picked the wrong block on most
  // modern templates and produced noticeably worse output than the
  // full app. Word count is computed from a coarse text strip so
  // reading-time UX still works without a renderer round-trip.
  const wordCount = countWords(html);
  return {
    html,
    wordCount,
    readingTimeMinutes: Math.max(1, Math.round(wordCount / READING_TIME_WPM)),
  };
}

// ─── shared HTTP helper ─────────────────────────────────────────────────

interface GetOptions {
  timeoutMs: number;
  accept: string;
  onError: (err: unknown, status?: number) => AiRunTimesError;
}

async function getWithRedirects(
  url: string,
  opts: GetOptions,
  redirectCount = 0
): Promise<string> {
  if (redirectCount > DEFAULT_MAX_REDIRECTS) {
    throw opts.onError(new Error(`too many redirects (${DEFAULT_MAX_REDIRECTS})`));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: opts.accept,
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw opts.onError(err);
  }
  clearTimeout(timer);

  if (response.status >= 300 && response.status < 400) {
    const loc = response.headers.get('location');
    if (loc !== null && loc.length > 0) {
      const next = resolveRedirect(url, loc);
      return getWithRedirects(next, opts, redirectCount + 1);
    }
  }
  if (!response.ok) {
    throw opts.onError(new Error(`HTTP ${response.status}`), response.status);
  }
  return response.text();
}

function resolveRedirect(from: string, location: string): string {
  if (/^https?:\/\//i.test(location)) return location;
  try {
    const base = new URL(from);
    if (location.startsWith('/')) return `${base.protocol}//${base.host}${location}`;
    return new URL(location, base).toString();
  } catch {
    return location;
  }
}

function feedFetchError(url: string, cause: unknown, status?: number): AiRunTimesError {
  return new AiRunTimesError({
    code: AI_RUN_TIMES_ERROR_CODES.FEED_FETCH_FAILED,
    message: `Failed to fetch feed: ${url}`,
    context: { url, ...(typeof status === 'number' ? { status } : {}) },
    ...(typeof status === 'number' ? { status } : {}),
    cause,
    remediation: 'Check the feed URL in Settings -> AI Run Times. Verify your network.',
  });
}

function articleFetchError(url: string, cause: unknown, status?: number): AiRunTimesError {
  return new AiRunTimesError({
    code: AI_RUN_TIMES_ERROR_CODES.ARTICLE_FETCH_FAILED,
    message: `Failed to fetch article: ${url}`,
    context: { url, ...(typeof status === 'number' ? { status } : {}) },
    ...(typeof status === 'number' ? { status } : {}),
    cause,
    remediation: 'Open the original article in your browser to verify it is reachable.',
  });
}

// ─── RSS parsing ────────────────────────────────────────────────────────

const ITEM_RE = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
const TITLE_RE = /<title\b[^>]*>([\s\S]*?)<\/title>/i;
const LINK_RE = /<link\b[^>]*>([\s\S]*?)<\/link>/i;
const DESC_RE = /<description\b[^>]*>([\s\S]*?)<\/description>/i;
const CONTENT_RE = /<content:encoded\b[^>]*>([\s\S]*?)<\/content:encoded>/i;
const PUBDATE_RE = /<pubDate\b[^>]*>([\s\S]*?)<\/pubDate>/i;
const AUTHOR_RE = /<(?:dc:creator|author)\b[^>]*>([\s\S]*?)<\/(?:dc:creator|author)>/i;
const CATEGORY_RE = /<category\b[^>]*>([\s\S]*?)<\/category>/gi;
const MEDIA_THUMB_RE = /<media:(?:thumbnail|content)\b[^>]*url="([^"]+)"/i;
const ENCLOSURE_RE = /<enclosure\b[^>]*url="([^"]+)"[^>]*type="image/i;
const IMG_SRC_RE = /<img\b[^>]*src="([^"]+)"/i;

/**
 * Parse an RSS 2.0 feed into Article tiles. The parser is regex-based
 * (main process has no DOM) and tuned for the WordPress feed shape
 * (uxmag.com is WordPress). It tolerates absent fields by emitting
 * empty / null values.
 */
export function parseRssFeed(xml: string, feedId: string): Article[] {
  const articles: Article[] = [];
  const items = xml.matchAll(ITEM_RE);
  for (const match of items) {
    const block = match[1] ?? '';
    const title = decodeHtml(stripCdata(TITLE_RE.exec(block)?.[1] ?? '')).trim();
    const link = decodeHtml(stripCdata(LINK_RE.exec(block)?.[1] ?? '')).trim();
    if (link.length === 0 || title.length === 0) continue;

    const description = decodeHtml(stripCdata(DESC_RE.exec(block)?.[1] ?? ''));
    const fullContent = decodeHtml(stripCdata(CONTENT_RE.exec(block)?.[1] ?? ''));
    const pubDateStr = decodeHtml(stripCdata(PUBDATE_RE.exec(block)?.[1] ?? '')).trim();
    const authorStr = decodeHtml(stripCdata(AUTHOR_RE.exec(block)?.[1] ?? '')).trim();

    const categories: string[] = [];
    for (const cat of block.matchAll(CATEGORY_RE)) {
      const text = decodeHtml(stripCdata(cat[1] ?? '')).trim();
      if (text.length > 0) categories.push(text);
    }

    const thumbnailUrl =
      MEDIA_THUMB_RE.exec(block)?.[1] ??
      ENCLOSURE_RE.exec(block)?.[1] ??
      IMG_SRC_RE.exec(fullContent.length > 0 ? fullContent : description)?.[1] ??
      null;

    const publishedAt = parsePubDate(pubDateStr);
    const id = stableArticleId(link);

    articles.push({
      id,
      feedId,
      title,
      link,
      description: description.trim(),
      thumbnailUrl,
      author: authorStr.length > 0 ? authorStr : null,
      publishedAt,
      categories,
      contentHtml: null,
      contentFetchedAt: null,
      wordCount: 0,
      readingTimeMinutes: 0,
    });
  }
  return articles;
}

function stripCdata(s: string): string {
  return s.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '');
}

/**
 * Common named HTML entities found in WordPress / RSS feeds. Not
 * exhaustive (full named-entity table is ~250+) but covers what
 * uxmag.com / typical publisher feeds emit. Numeric entities are
 * decoded by the regex below.
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '\u2026',
  mdash: '\u2014',
  ndash: '\u2013',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201C',
  rdquo: '\u201D',
  copy: '\u00A9',
  reg: '\u00AE',
  trade: '\u2122',
  laquo: '\u00AB',
  raquo: '\u00BB',
  middot: '\u00B7',
  bull: '\u2022',
  deg: '\u00B0',
  divide: '\u00F7',
  times: '\u00D7',
  hearts: '\u2665',
};

function decodeHtml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&([a-zA-Z]+);/g, (full, name) => {
      const decoded = NAMED_ENTITIES[(name as string).toLowerCase()];
      return decoded !== undefined ? decoded : full;
    });
}

function parsePubDate(s: string): string | null {
  if (s.length === 0) return null;
  const ts = Date.parse(s);
  if (Number.isNaN(ts)) return null;
  return new Date(ts).toISOString();
}

/** Stable id derived from link via SHA-1 (Node crypto). 16 hex chars. */
export function stableArticleId(link: string): string {
  // Pure-JS sha1 to avoid pulling node:crypto into bundled renderer code paths.
  // Tiny djb2-like variant truncated to 16 chars; collision risk is negligible
  // for the cache scale (low hundreds of articles).
  let h1 = 0xdeadbeef ^ 1;
  let h2 = 0x41c6ce57 ^ 1;
  for (let i = 0; i < link.length; i += 1) {
    const ch = link.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const lo = (h1 >>> 0).toString(16).padStart(8, '0');
  const hi = (h2 >>> 0).toString(16).padStart(8, '0');
  return `${lo}${hi}`;
}

// ─── article HTML word counting ─────────────────────────────────────────
//
// As of the renderer-side extractor port (matches the full app's
// DOMParser-based logic in `Flipboard-IDW-Feed/uxmag-script.js`), the
// regex-based `extractArticleContent` that used to live here is gone --
// the renderer parses raw HTML with `DOMParser` and applies the same
// selector cascade the full app uses.  Word counting still lives in
// the main process so the article tile's "X min read" badge is set
// without a renderer round-trip.

/**
 * Plain-text word count. Used for reading time. Strips HTML tags,
 * decodes entities, then splits on whitespace.
 *
 * Treats Unicode apostrophes and ASCII apostrophes alike so that
 * `It's a test` counts as 3 words regardless of whether the
 * apostrophe came in as `'` or `&rsquo;`.
 */
export function countWords(html: string): number {
  const decoded = decodeHtml(html.replace(/<[^>]+>/g, ' '));
  const text = decoded
    .replace(/[\u2018\u2019\u201C\u201D]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .trim();
  if (text.length === 0) return 0;
  return text.split(/\s+/).length;
}
