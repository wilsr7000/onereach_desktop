/**
 * Article DOM extractor.
 *
 * Pure function: takes raw HTML + the article's source URL, returns
 * the cleaned article body HTML, an optional hero image URL, and the
 * extracted word count.
 *
 * Mirrors the full app's logic in
 * `Flipboard-IDW-Feed/uxmag-script.js:openArticle` — DOMParser-based
 * parsing with a source-specific selector cascade, OneReach vs UXMag
 * paths, and a final paragraphs-by-density fallback.
 *
 * Designed for the renderer (uses `DOMParser`, which only exists in
 * the browser). Main process never calls this — it just hands raw
 * HTML to the renderer via the IPC bridge.
 */

/** Generic content-container selectors, applied to any source. */
const GENERIC_CONTAINER_SELECTORS: ReadonlyArray<string> = [
  'article',
  '[role="main"]',
  'main article',
  'main',
  '[itemprop="articleBody"]',
  '.entry-content',
  '.post-content',
  '.article-body',
  '.article-content',
  '.content-body',
  '.td-post-content',
];

/** OneReach-specific selectors (in order of preference). */
const ONEREACH_CONTAINER_SELECTORS: ReadonlyArray<string> = [
  '.wp-block-post-content',
  '.post-content',
  '.blog-content',
  '.article-content',
  '.content-wrapper',
  'article .entry-content',
  '.single-post .entry-content',
  '.post-body',
  'main .content',
  '.page-content',
  '[itemprop="articleBody"]',
  '.entry-content',
  'main article',
];

/** UXMag-specific selectors (Elementor-based). */
const UXMAG_CONTAINER_SELECTORS: ReadonlyArray<string> = [
  '[data-widget_type="theme-post-content.default"] .elementor-widget-container',
  '.elementor-widget-theme-post-content .elementor-widget-container',
  '.entry-content',
  '.post-content',
  '.content-area .content',
  'article .content',
  '.single-post .content',
  'article',
  '.content',
  'main',
];

/** Selectors removed from the chosen article element before render. */
const UNWANTED_SELECTORS_GENERIC: ReadonlyArray<string> = [
  'script',
  'style',
  'noscript',
  'iframe',
  'nav',
  'aside',
  'form',
  'header',
  'footer',
  '.sidebar',
  '.navigation',
  '.nav',
  '.menu',
  '.ads',
  '.advertisement',
  '.social-share',
  '.related-posts',
  '.comments',
  '.comment-form',
  '.breadcrumb',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="complementary"]',
  '.cookie-banner',
  '[class*="consent"]',
];

/** Additional WordPress-block-specific cruft for OneReach. */
const UNWANTED_SELECTORS_ONEREACH: ReadonlyArray<string> = [
  '.sharedaddy',
  '.jp-relatedposts',
  '.post-navigation',
  '.entry-meta',
  '.entry-footer',
  '.author-bio',
  '.newsletter-signup',
  '.cta-section',
  '.promotion',
  '.wp-block-button',
  '.wp-block-buttons',
  '.post-tags',
  '.post-categories',
  '.share-buttons',
];

/** When the chosen container has further inner-content wrappers, drill in. */
const ONEREACH_INNER_CONTAINER_SELECTORS: ReadonlyArray<string> = [
  '.wp-block-group__inner-container',
  '.entry-content-inner',
  '.post-content-inner',
];

export interface ArticleExtractionResult {
  /** The cleaned article body HTML, ready to insert via innerHTML. */
  contentHtml: string;
  /** First-choice hero image: og:image / twitter:image / link rel=image_src. May be null. */
  heroImageUrl: string | null;
  /** Plain-text word count of `contentHtml`. */
  wordCount: number;
  /** Estimated reading time, minimum 1. */
  readingTimeMinutes: number;
  /** Author meta from the page (when present), trimmed; null if not found. */
  author: string | null;
  /** Page <title> text, trimmed; null if not found. */
  pageTitle: string | null;
  /**
   * The selector that produced the body. Useful for telemetry +
   * "this site has a unique layout we don't support yet" debugging.
   * Null when we fell back to body / paragraph density.
   */
  matchedSelector: string | null;
}

/** Words-per-minute target for reading-time calc. Matches main-side constant. */
const READING_TIME_WPM = 220;

/**
 * Run the extractor against `rawHtml`. `sourceUrl` is consulted to
 * decide whether to apply the OneReach- or UXMag-specific cascade
 * before falling through to the generic chain.
 */
export function extractArticle(rawHtml: string, sourceUrl: string): ArticleExtractionResult {
  const parser = new DOMParser();
  const doc = parser.parseFromString(rawHtml, 'text/html');

  const isOneReach = /onereach\.ai/i.test(sourceUrl);
  const isUxMag = /uxmag\.com/i.test(sourceUrl);

  const cascade: ReadonlyArray<string> = isOneReach
    ? [...ONEREACH_CONTAINER_SELECTORS, ...GENERIC_CONTAINER_SELECTORS]
    : isUxMag
      ? [...UXMAG_CONTAINER_SELECTORS, ...GENERIC_CONTAINER_SELECTORS]
      : GENERIC_CONTAINER_SELECTORS;

  let articleEl: Element | null = null;
  let matchedSelector: string | null = null;
  for (const sel of cascade) {
    const candidate = doc.querySelector(sel);
    if (candidate !== null && hasSubstantialText(candidate)) {
      articleEl = candidate;
      matchedSelector = sel;
      break;
    }
  }

  // OneReach often nests the real content one level deeper; drill in.
  if (articleEl !== null && isOneReach) {
    for (const sel of ONEREACH_INNER_CONTAINER_SELECTORS) {
      const inner = articleEl.querySelector(sel);
      if (inner !== null && hasSubstantialText(inner)) {
        articleEl = inner;
        break;
      }
    }
  }

  // Build a working copy so we can mutate without touching the
  // parser's tree (paranoia: callers may keep references).
  const workingHtml =
    articleEl !== null
      ? articleEl.innerHTML
      : extractByParagraphDensity(doc) ?? doc.body?.innerHTML ?? '';

  // Apply the unwanted-selector cleanup in a fresh container.
  const tempDiv = doc.createElement('div');
  tempDiv.innerHTML = workingHtml;
  const unwanted = isOneReach
    ? [...UNWANTED_SELECTORS_GENERIC, ...UNWANTED_SELECTORS_ONEREACH]
    : UNWANTED_SELECTORS_GENERIC;
  for (const sel of unwanted) {
    try {
      tempDiv.querySelectorAll(sel).forEach((el) => el.remove());
    } catch {
      // Selector may be invalid in odd DOMParser implementations; skip.
    }
  }

  // Strip WordPress block-comment markup ("<!-- wp:paragraph -->").
  // innerHTML round-trip removes regular HTML comments naturally on
  // serialization in some DOMs, but be explicit.
  let contentHtml = tempDiv.innerHTML
    .replace(/<!--\s*wp:[^>]*-->/g, '')
    .replace(/<!--\s*\/wp:[^>]*-->/g, '')
    // Drop inline event handlers as a defense-in-depth measure (CSP
    // already blocks scripts; this neutralizes inline handlers in case
    // the renderer ever loosens script-src).
    .replace(/\son\w+="[^"]*"/gi, '')
    .replace(/\son\w+='[^']*'/gi, '');

  // Drop empty/whitespace-only <p> elements after the cleanup pass.
  contentHtml = contentHtml.replace(/<p[^>]*>\s*<\/p>/gi, '');

  const wordCount = countWordsInHtml(contentHtml);
  const readingTimeMinutes = Math.max(1, Math.round(wordCount / READING_TIME_WPM));

  return {
    contentHtml,
    heroImageUrl: pickHeroImageUrl(doc),
    wordCount,
    readingTimeMinutes,
    author: pickAuthor(doc),
    pageTitle: doc.title?.trim().length > 0 ? doc.title.trim() : null,
    matchedSelector,
  };
}

/**
 * Substantial-text gate. Mirrors the full app's "did this selector
 * actually find a body, or just an empty wrapper?" check.
 */
function hasSubstantialText(el: Element): boolean {
  const text = (el.textContent ?? '').trim();
  return text.length >= 400;
}

/**
 * Final fallback when no container selector matched: collect every
 * `<p>` outside obvious chrome (sidebar/nav/footer) and return them
 * as one block. Mirrors the full app's `substantialParagraphs` path.
 *
 * Typed against `Element` rather than `HTMLElement` so the function
 * works under either a real browser DOM (renderer) or a jsdom one
 * (tests) without depending on the global `HTMLElement` constructor
 * being defined for `instanceof` checks.
 */
function extractByParagraphDensity(doc: Document): string | null {
  const paragraphs = doc.querySelectorAll('p');
  const substantial: Element[] = [];
  for (const p of Array.from(paragraphs)) {
    const text = p.textContent?.trim() ?? '';
    if (text.length < 50) continue;
    if (
      p.closest('.sidebar') !== null ||
      p.closest('.navigation') !== null ||
      p.closest('nav') !== null ||
      p.closest('footer') !== null ||
      p.closest('.footer') !== null ||
      p.closest('aside') !== null
    ) {
      continue;
    }
    substantial.push(p);
  }
  if (substantial.length === 0) return null;
  return substantial.map((p) => p.outerHTML).join('\n');
}

/**
 * Hero image: prefer Open Graph / Twitter card. Falls back to
 * `<link rel="image_src">` and finally to the first reasonable
 * `<img>` in the document head/body. Returns null when nothing's
 * usable.
 */
function pickHeroImageUrl(doc: Document): string | null {
  const sources: ReadonlyArray<{ attr: 'content' | 'href'; sel: string }> = [
    { attr: 'content', sel: 'meta[property="og:image"]' },
    { attr: 'content', sel: 'meta[name="og:image"]' },
    { attr: 'content', sel: 'meta[property="og:image:url"]' },
    { attr: 'content', sel: 'meta[name="twitter:image"]' },
    { attr: 'content', sel: 'meta[name="twitter:image:src"]' },
    { attr: 'href', sel: 'link[rel="image_src"]' },
  ];
  for (const src of sources) {
    const el = doc.querySelector(src.sel);
    const value = el?.getAttribute(src.attr) ?? null;
    if (value !== null && /^https?:\/\//i.test(value)) return value;
  }
  return null;
}

/**
 * Author from common meta tags. The full app pulls from the RSS feed
 * already, so this is a fallback when the feed didn't carry an
 * author.
 */
function pickAuthor(doc: Document): string | null {
  const sources: ReadonlyArray<{ attr: 'content'; sel: string }> = [
    { attr: 'content', sel: 'meta[name="author"]' },
    { attr: 'content', sel: 'meta[property="article:author"]' },
    { attr: 'content', sel: 'meta[name="byl"]' },
  ];
  for (const src of sources) {
    const el = doc.querySelector(src.sel);
    const value = el?.getAttribute(src.attr)?.trim() ?? null;
    if (value !== null && value.length > 0) return value;
  }
  return null;
}

/**
 * Plain-text word counter for the renderer. Mirrors the main-process
 * `countWords` in fetcher.ts — keeps reading-time consistent whether
 * computed in main or in renderer.
 */
function countWordsInHtml(html: string): number {
  if (html.length === 0) return 0;
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/[‘’“”]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .trim();
  if (text.length === 0) return 0;
  return text.split(/\s+/).length;
}

/** @internal -- exposed so the unit test can reach private helpers. */
export const _internals = {
  hasSubstantialText,
  extractByParagraphDensity,
  pickHeroImageUrl,
  pickAuthor,
  countWordsInHtml,
};
