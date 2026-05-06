/**
 * Article extractor unit tests.
 *
 * Drives the renderer-side `extractArticle()` against fixture HTML
 * that mirrors what real OneReach + UXMag + generic publisher pages
 * actually emit. The vitest project's default environment is
 * `node`, so we install a `DOMParser` polyfill backed by jsdom for
 * just this file -- mirrors what the renderer ships in production.
 *
 * The fixtures are inlined rather than loaded from disk -- keeps
 * the test self-contained and easy to extend.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// jsdom ships its own JS but no .d.ts -- the package stays as untyped
// runtime dep for the lite tests. The minimal shape we use is the
// JSDOM constructor + its `window.DOMParser` accessor.
// @ts-expect-error -- no @types/jsdom installed; runtime-only import
import { JSDOM } from 'jsdom';
import { extractArticle } from '../../ai-run-times/article-extractor.js';

// Install a DOMParser polyfill backed by jsdom. The renderer has the
// browser's native DOMParser; Node doesn't, so tests use jsdom.
let originalDOMParser: typeof globalThis.DOMParser | undefined;
beforeAll(() => {
  originalDOMParser = globalThis.DOMParser;
  const { DOMParser: JsdomDOMParser } = new JSDOM('').window;
  // jsdom's DOMParser has a slightly stricter type than the lib.dom.d.ts
  // global, but the runtime shape is compatible (parseFromString returns
  // a Document). Cast through unknown to satisfy strict TS.
  globalThis.DOMParser = JsdomDOMParser as unknown as typeof globalThis.DOMParser;
});
afterAll(() => {
  if (originalDOMParser !== undefined) {
    globalThis.DOMParser = originalDOMParser;
  } else {
    // @ts-expect-error -- restoring undefined to a global
    delete globalThis.DOMParser;
  }
});

// ─── fixtures ──────────────────────────────────────────────────────────────

/**
 * UXMag-style article. Elementor wraps the post-content widget;
 * the full app's selector chain hits
 * `[data-widget_type="theme-post-content.default"] .elementor-widget-container`.
 */
const UXMAG_HTML = `
<!DOCTYPE html>
<html>
<head>
  <title>The Hidden Cost of Conversational AI - UX Magazine</title>
  <meta property="og:image" content="https://uxmag.com/og/conversational-cost.jpg" />
  <meta name="author" content="Jane Doe" />
</head>
<body>
  <header class="site-header">
    <nav class="primary-nav">
      <a href="/">Home</a>
      <a href="/articles">Articles</a>
    </nav>
  </header>
  <aside class="sidebar">
    <div class="ad">Buy our newsletter!</div>
  </aside>
  <main>
    <article class="post-12345 post type-post">
      <div class="elementor-element" data-widget_type="theme-post-content.default">
        <div class="elementor-widget-container">
          <h2>Introduction</h2>
          <p>Conversational AI promised to flatten the org chart. ${'And so it did. '.repeat(40)}</p>
          <p>Yet the long tail of edge cases tells a different story. ${'Each new utterance reveals another seam. '.repeat(20)}</p>
          <h2>Where the costs hide</h2>
          <p>Consider, for instance, the cost of correction. ${'Every fallback to a human costs more than a successful turn. '.repeat(20)}</p>
          <ul>
            <li>Brittle intent classification</li>
            <li>Leaky context windows</li>
            <li>Unmeasured drift</li>
          </ul>
          <p>The pattern repeats across every deployment we audited. ${'There is no escape via more training data alone. '.repeat(20)}</p>
        </div>
      </div>
    </article>
  </main>
  <footer class="site-footer">
    <p>&copy; UX Magazine 2026</p>
    <div class="social-share"><a href="#twitter">Twitter</a></div>
  </footer>
  <script>window.__data = { user: 'tracked' };</script>
</body>
</html>
`;

/**
 * OneReach.ai article -- WordPress block editor output. The full
 * app's chain prefers `.wp-block-post-content` and drills into
 * `.wp-block-group__inner-container` when nested.
 */
const ONEREACH_HTML = `
<!DOCTYPE html>
<html>
<head>
  <title>Why Strangler Patterns Won the Decade</title>
  <meta property="og:image" content="https://onereach.ai/og/strangler.jpg" />
</head>
<body>
  <div class="wp-site-blocks">
    <header>
      <nav class="navigation">Site nav</nav>
    </header>
    <main>
      <article class="single-post post-9876">
        <div class="entry-meta">
          <span>Posted in: Engineering</span>
        </div>
        <div class="wp-block-post-content">
          <!-- wp:group {"layout":{"type":"constrained"}} -->
          <div class="wp-block-group">
            <div class="wp-block-group__inner-container">
              <p>Migration projects fail in two ways: ${'all-at-once and slowly. '.repeat(40)}</p>
              <p>The strangler pattern, named for the fig that grows around its host, ${'lets a new system replace an old one without a big-bang cutover. '.repeat(25)}</p>
              <h2>Why it took so long</h2>
              <p>${'The pattern dates to 2004 but only became mainstream when CI/CD got cheap. '.repeat(15)}</p>
              <p>${'Continuous deployment removed the gate that had made big-bang feel safer. '.repeat(15)}</p>
            </div>
          </div>
          <!-- /wp:group -->
          <div class="wp-block-buttons">
            <a class="wp-block-button" href="#share">Share</a>
          </div>
          <div class="sharedaddy">Share this!</div>
          <div class="jp-relatedposts">Related: ...</div>
        </div>
        <footer class="entry-footer">
          <span class="post-tags">tags: engineering</span>
        </footer>
      </article>
    </main>
    <footer class="site-footer">Footer</footer>
  </div>
</body>
</html>
`;

/**
 * Generic site with semantic `<article>` and proper og:image.
 * Should match cleanly without any source-specific path.
 */
const GENERIC_HTML = `
<!DOCTYPE html>
<html>
<head>
  <title>Generic Article Title</title>
  <meta property="og:image" content="https://example.com/og.jpg" />
</head>
<body>
  <header><nav>Nav</nav></header>
  <article>
    <h1>Generic Article Title</h1>
    <p>${'This is the body of a generic article. '.repeat(40)}</p>
    <p>${'Another paragraph for length. '.repeat(20)}</p>
  </article>
  <footer>Footer</footer>
</body>
</html>
`;

/**
 * Pathological: page with no semantic markup, just a flat soup of
 * `<p>`. The full app's "substantialParagraphs" fallback should
 * recover the body.
 */
const PARAGRAPH_SOUP_HTML = `
<!DOCTYPE html>
<html>
<head><title>Paragraph Soup</title></head>
<body>
  <div class="sidebar"><p>${'Short sidebar nav. '.repeat(2)}</p></div>
  <p>${'A long paragraph of body content that should be picked up. '.repeat(10)}</p>
  <p>${'A second long paragraph in the open body. '.repeat(10)}</p>
  <p>${'Yet another body paragraph. '.repeat(10)}</p>
  <footer><p>Short footer.</p></footer>
</body>
</html>
`;

// ─── tests ─────────────────────────────────────────────────────────────────

describe('extractArticle - UXMag fixture', () => {
  it('selects the Elementor theme-post-content widget container', () => {
    const out = extractArticle(UXMAG_HTML, 'https://uxmag.com/articles/some-post');
    expect(out.matchedSelector).toBe(
      '[data-widget_type="theme-post-content.default"] .elementor-widget-container'
    );
  });

  it('preserves article content (h2 + paragraphs + ul)', () => {
    const out = extractArticle(UXMAG_HTML, 'https://uxmag.com/articles/some-post');
    expect(out.contentHtml).toContain('Introduction');
    expect(out.contentHtml).toContain('Where the costs hide');
    expect(out.contentHtml).toContain('Brittle intent classification');
    expect(out.contentHtml).toContain('<p>');
    expect(out.contentHtml).toContain('<ul>');
  });

  it('strips nav/sidebar/footer/script blocks', () => {
    const out = extractArticle(UXMAG_HTML, 'https://uxmag.com/articles/some-post');
    expect(out.contentHtml).not.toContain('Buy our newsletter!');
    expect(out.contentHtml).not.toContain('Site Header');
    expect(out.contentHtml).not.toContain('window.__data');
    expect(out.contentHtml).not.toContain('UX Magazine 2026');
    expect(out.contentHtml).not.toContain('class="social-share"');
  });

  it('extracts og:image as hero', () => {
    const out = extractArticle(UXMAG_HTML, 'https://uxmag.com/articles/some-post');
    expect(out.heroImageUrl).toBe('https://uxmag.com/og/conversational-cost.jpg');
  });

  it('extracts author from <meta name="author">', () => {
    const out = extractArticle(UXMAG_HTML, 'https://uxmag.com/articles/some-post');
    expect(out.author).toBe('Jane Doe');
  });

  it('reports a non-trivial reading time', () => {
    const out = extractArticle(UXMAG_HTML, 'https://uxmag.com/articles/some-post');
    expect(out.wordCount).toBeGreaterThan(200);
    expect(out.readingTimeMinutes).toBeGreaterThanOrEqual(1);
  });
});

describe('extractArticle - OneReach fixture', () => {
  it('selects .wp-block-post-content via the OneReach cascade', () => {
    const out = extractArticle(ONEREACH_HTML, 'https://onereach.ai/blog/strangler');
    expect(out.matchedSelector).toBe('.wp-block-post-content');
  });

  it('drills into wp-block-group__inner-container', () => {
    const out = extractArticle(ONEREACH_HTML, 'https://onereach.ai/blog/strangler');
    // The drill-in moves the working set to the inner container,
    // so the .wp-block-group wrapper itself shouldn't appear.
    expect(out.contentHtml).not.toContain('class="wp-block-group"');
    expect(out.contentHtml).toContain('Migration projects fail');
    expect(out.contentHtml).toContain('Why it took so long');
  });

  it('strips OneReach-specific cruft (sharedaddy, jp-relatedposts, wp-block-buttons)', () => {
    const out = extractArticle(ONEREACH_HTML, 'https://onereach.ai/blog/strangler');
    expect(out.contentHtml).not.toContain('Share this!');
    expect(out.contentHtml).not.toContain('jp-relatedposts');
    expect(out.contentHtml).not.toContain('wp-block-buttons');
  });

  it('strips WordPress block comments', () => {
    const out = extractArticle(ONEREACH_HTML, 'https://onereach.ai/blog/strangler');
    expect(out.contentHtml).not.toMatch(/<!--\s*wp:/);
    expect(out.contentHtml).not.toMatch(/<!--\s*\/wp:/);
  });

  it('extracts og:image as hero', () => {
    const out = extractArticle(ONEREACH_HTML, 'https://onereach.ai/blog/strangler');
    expect(out.heroImageUrl).toBe('https://onereach.ai/og/strangler.jpg');
  });
});

describe('extractArticle - generic / fallback', () => {
  it('selects <article> on a non-OneReach non-UXMag page', () => {
    const out = extractArticle(GENERIC_HTML, 'https://example.com/post');
    expect(out.matchedSelector).toBe('article');
    expect(out.contentHtml).toContain('Generic Article Title');
    expect(out.contentHtml).toContain('This is the body');
  });

  it('falls back to substantial paragraphs when no container matches', () => {
    const out = extractArticle(PARAGRAPH_SOUP_HTML, 'https://example.com/soup');
    expect(out.matchedSelector).toBeNull();
    expect(out.contentHtml).toContain('A long paragraph of body content');
    expect(out.contentHtml).toContain('A second long paragraph');
    expect(out.contentHtml).toContain('Yet another body paragraph');
    expect(out.contentHtml).not.toContain('Short sidebar nav');
    expect(out.contentHtml).not.toContain('Short footer');
  });
});

describe('extractArticle - safety', () => {
  it('strips inline event handlers', () => {
    const html = `
      <html><body>
        <article>
          <p onclick="alert('xss')">${'Body content. '.repeat(40)}</p>
          <a href="#" onmouseover="evilFn()">link</a>
        </article>
      </body></html>
    `;
    const out = extractArticle(html, 'https://example.com/');
    expect(out.contentHtml).not.toMatch(/onclick=/i);
    expect(out.contentHtml).not.toMatch(/onmouseover=/i);
    expect(out.contentHtml).not.toMatch(/alert\(/);
  });

  it('strips <script> and <style> blocks', () => {
    const html = `
      <html><body>
        <article>
          <script>alert(1)</script>
          <style>body { color: red }</style>
          <p>${'Body content. '.repeat(40)}</p>
        </article>
      </body></html>
    `;
    const out = extractArticle(html, 'https://example.com/');
    expect(out.contentHtml).not.toContain('alert(1)');
    expect(out.contentHtml).not.toContain('color: red');
  });

  it('returns empty contentHtml without throwing on truly empty input', () => {
    const out = extractArticle('', 'https://example.com/');
    expect(out.contentHtml).toBe('');
    expect(out.heroImageUrl).toBeNull();
    expect(out.wordCount).toBe(0);
  });
});

describe('extractArticle - hero image fallbacks', () => {
  it('falls back to twitter:image when og:image is absent', () => {
    const html = `
      <html>
      <head><meta name="twitter:image" content="https://x.com/twitter.jpg" /></head>
      <body><article><p>${'Body. '.repeat(80)}</p></article></body>
      </html>
    `;
    const out = extractArticle(html, 'https://example.com/');
    expect(out.heroImageUrl).toBe('https://x.com/twitter.jpg');
  });

  it('returns null when no meta image is available', () => {
    const html = `<html><body><article><p>${'Body. '.repeat(80)}</p></article></body></html>`;
    const out = extractArticle(html, 'https://example.com/');
    expect(out.heroImageUrl).toBeNull();
  });

  it('skips non-http(s) image URLs', () => {
    const html = `
      <html>
      <head><meta property="og:image" content="data:image/png;base64,xxx" /></head>
      <body><article><p>${'Body. '.repeat(80)}</p></article></body>
      </html>
    `;
    const out = extractArticle(html, 'https://example.com/');
    expect(out.heroImageUrl).toBeNull();
  });
});
