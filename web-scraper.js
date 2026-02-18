/**
 * Web Scraper Utility
 *
 * Scrapes HTML content and extracts data from web pages.
 * Uses the browser-automation service (Playwright) under the hood,
 * sharing the managed browser instance with the browser agent.
 *
 * Previously used Puppeteer -- now consolidated onto Playwright
 * via lib/browser-automation.js for a single browser dependency.
 */

const browserAutomation = require('./lib/browser-automation');

class WebScraper {
  constructor(options = {}) {
    this.defaultOptions = {
      timeout: 30000,
      waitUntil: 'load',
      ...options,
    };
  }

  /**
   * Initialize the browser instance (auto-starts via browser-automation)
   */
  async init() {
    const status = browserAutomation.status();
    if (!status.running) {
      await browserAutomation.start({ headless: true });
    }
    return this;
  }

  /**
   * Navigate to a URL in a new tab, run a callback, then close the tab.
   * @param {string} url - URL to navigate to
   * @param {Object} opts - Options
   * @param {Function} callback - async (tabId) => result
   * @returns {Promise<any>}
   */
  async _withTab(url, opts, callback) {
    await this.init();

    const tabResult = await browserAutomation.openTab(url);
    if (!tabResult.success) {
      throw new Error(`Failed to open tab: ${tabResult.error}`);
    }
    const tabId = tabResult.tabId;

    try {
      // Wait for additional conditions
      if (opts.delay) {
        await browserAutomation.waitFor({ timeout: opts.delay });
      }
      if (opts.waitForSelector) {
        await browserAutomation.waitFor({ selector: opts.waitForSelector, timeout: opts.timeout || 30000 });
      }

      return await callback(tabId);
    } finally {
      await browserAutomation.closeTab(tabId);
    }
  }

  /**
   * Get full HTML content of a page
   * @param {string} url - URL to scrape
   * @param {Object} options - Scrape options
   * @returns {Promise<string>} - Full HTML content
   */
  async getHTML(url, options = {}) {
    const opts = { ...this.defaultOptions, ...options };

    return this._withTab(url, opts, async () => {
      console.log(`[Scraper] Fetching HTML: ${url}`);
      const result = await browserAutomation.evaluate('document.documentElement.outerHTML');
      if (!result.success) throw new Error(result.error);
      console.log(`[Scraper] Got ${result.result?.length || 0} characters`);
      return result.result;
    });
  }

  /**
   * Get text content of a page (no HTML tags)
   * @param {string} url - URL to scrape
   * @param {Object} options - Scrape options
   * @returns {Promise<string>} - Text content
   */
  async getText(url, options = {}) {
    const opts = { ...this.defaultOptions, ...options };

    return this._withTab(url, opts, async () => {
      console.log(`[Scraper] Fetching text: ${url}`);
      const result = await browserAutomation.evaluate(`(() => {
                const scripts = document.querySelectorAll('script, style, noscript');
                scripts.forEach(el => el.remove());
                return document.body.innerText;
            })()`);
      if (!result.success) throw new Error(result.error);
      console.log(`[Scraper] Got ${result.result?.length || 0} characters of text`);
      return result.result;
    });
  }

  /**
   * Extract specific elements using CSS selectors
   * @param {string} url - URL to scrape
   * @param {string|Array<string>} selectors - CSS selector(s)
   * @param {Object} options - Scrape options
   * @returns {Promise<Object>} - Extracted content
   */
  async extract(url, selectors, options = {}) {
    const opts = { ...this.defaultOptions, ...options };
    const selectorArray = Array.isArray(selectors) ? selectors : [selectors];

    return this._withTab(url, opts, async () => {
      console.log(`[Scraper] Extracting from: ${url}`);
      const result = await browserAutomation.evaluate(`((sels) => {
                const output = {};
                sels.forEach(sel => {
                    const elements = document.querySelectorAll(sel);
                    output[sel] = Array.from(elements).map(el => ({
                        text: el.innerText?.trim(),
                        html: el.innerHTML,
                        href: el.href || null,
                        src: el.src || null,
                        alt: el.alt || null,
                        title: el.title || null,
                        className: el.className || null,
                        id: el.id || null,
                        tagName: el.tagName.toLowerCase(),
                        attributes: Object.fromEntries(
                            Array.from(el.attributes).map(attr => [attr.name, attr.value])
                        )
                    }));
                });
                return output;
            })(${JSON.stringify(selectorArray)})`);
      if (!result.success) throw new Error(result.error);
      return result.result;
    });
  }

  /**
   * Extract structured data (JSON-LD, microdata, Open Graph)
   * @param {string} url - URL to scrape
   * @param {Object} options - Scrape options
   * @returns {Promise<Object>} - Structured data
   */
  async getStructuredData(url, options = {}) {
    const opts = { ...this.defaultOptions, ...options };

    return this._withTab(url, opts, async () => {
      console.log(`[Scraper] Getting structured data: ${url}`);
      const result = await browserAutomation.evaluate(`(() => {
                const result = {
                    jsonLd: [],
                    openGraph: {},
                    twitter: {},
                    meta: {}
                };

                // JSON-LD
                document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
                    try { result.jsonLd.push(JSON.parse(script.textContent)); } catch (_ignored) { /* malformed JSON-LD in page */ }
                });

                // Open Graph
                document.querySelectorAll('meta[property^="og:"]').forEach(meta => {
                    const prop = meta.getAttribute('property').replace('og:', '');
                    result.openGraph[prop] = meta.getAttribute('content');
                });

                // Twitter Cards
                document.querySelectorAll('meta[name^="twitter:"]').forEach(meta => {
                    const prop = meta.getAttribute('name').replace('twitter:', '');
                    result.twitter[prop] = meta.getAttribute('content');
                });

                // Standard meta tags
                result.meta.title = document.title;
                result.meta.description = document.querySelector('meta[name="description"]')?.content;
                result.meta.keywords = document.querySelector('meta[name="keywords"]')?.content;
                result.meta.author = document.querySelector('meta[name="author"]')?.content;
                result.meta.canonical = document.querySelector('link[rel="canonical"]')?.href;

                return result;
            })()`);
      if (!result.success) throw new Error(result.error);
      return result.result;
    });
  }

  /**
   * Extract all links from a page
   * @param {string} url - URL to scrape
   * @param {Object} options - Scrape options
   * @returns {Promise<Array>} - Array of links
   */
  async getLinks(url, options = {}) {
    const opts = { ...this.defaultOptions, ...options };

    return this._withTab(url, opts, async () => {
      console.log(`[Scraper] Getting links: ${url}`);
      const result = await browserAutomation.evaluate(`((baseUrl) => {
                return Array.from(document.querySelectorAll('a[href]')).map(a => {
                    let href = a.href;
                    try { href = new URL(a.getAttribute('href'), baseUrl).href; } catch (_ignored) { /* malformed href, keep original */ }
                    return {
                        href: href,
                        text: a.innerText?.trim(),
                        title: a.title || null,
                        rel: a.rel || null,
                        target: a.target || null,
                        isExternal: !href.startsWith(new URL(baseUrl).origin)
                    };
                }).filter(link => link.href && !link.href.startsWith('javascript:'));
            })(${JSON.stringify(url)})`);
      if (!result.success) throw new Error(result.error);
      console.log(`[Scraper] Found ${result.result?.length || 0} links`);
      return result.result;
    });
  }

  /**
   * Extract all images from a page
   * @param {string} url - URL to scrape
   * @param {Object} options - Scrape options
   * @returns {Promise<Array>} - Array of images
   */
  async getImages(url, options = {}) {
    const opts = { ...this.defaultOptions, ...options };

    return this._withTab(url, opts, async () => {
      console.log(`[Scraper] Getting images: ${url}`);

      // Scroll to load lazy images if requested
      if (opts.loadLazyImages) {
        await browserAutomation.scroll('bottom');
        await browserAutomation.waitFor({ timeout: 1000 });
        await browserAutomation.scroll('top');
        await browserAutomation.waitFor({ timeout: 500 });
      }

      const result = await browserAutomation.evaluate(`((baseUrl) => {
                return Array.from(document.querySelectorAll('img')).map(img => {
                    let src = img.src || img.dataset.src || img.dataset.lazySrc;
                    try { src = new URL(src, baseUrl).href; } catch (_ignored) { /* malformed img src, keep original */ }
                    return {
                        src: src,
                        alt: img.alt || null,
                        title: img.title || null,
                        width: img.naturalWidth || img.width || null,
                        height: img.naturalHeight || img.height || null,
                        loading: img.loading || null
                    };
                }).filter(img => img.src);
            })(${JSON.stringify(url)})`);
      if (!result.success) throw new Error(result.error);
      console.log(`[Scraper] Found ${result.result?.length || 0} images`);
      return result.result;
    });
  }

  /**
   * Execute custom JavaScript on a page and return results
   * @param {string} url - URL to scrape
   * @param {Function|string} script - JavaScript to execute
   * @param {Object} options - Scrape options
   * @returns {Promise<any>} - Script result
   */
  async evaluate(url, script, options = {}) {
    const opts = { ...this.defaultOptions, ...options };
    const scriptStr = typeof script === 'function' ? `(${script})()` : script;

    return this._withTab(url, opts, async () => {
      console.log(`[Scraper] Evaluating script on: ${url}`);
      const result = await browserAutomation.evaluate(scriptStr);
      if (!result.success) throw new Error(result.error);
      return result.result;
    });
  }

  /**
   * Scrape multiple pages
   * @param {Array<string>} urls - URLs to scrape
   * @param {Function|string} scrapeFunc - Function to call for each URL
   * @param {Object} options - Scrape options
   * @returns {Promise<Array>} - Array of results
   */
  async scrapeMultiple(urls, scrapeFunc = 'getHTML', options = {}) {
    const results = [];

    for (const url of urls) {
      try {
        const func = typeof scrapeFunc === 'function' ? scrapeFunc : this[scrapeFunc].bind(this);
        const result = await func(url, options);
        results.push({ url, success: true, data: result });
      } catch (error) {
        results.push({ url, success: false, error: error.message });
      }
    }

    return results;
  }

  /**
   * Close the browser instance
   * Note: this stops the shared browser-automation service.
   * Prefer letting idle timeout handle shutdown.
   */
  async close() {
    // Don't stop the shared browser -- let idle timeout handle it.
    // Other consumers (browser agent) may still be using it.
    console.log('[Scraper] close() called -- browser managed by browser-automation service');
  }
}

// Singleton instance
let instance = null;

function getWebScraper(options = {}) {
  if (!instance) {
    instance = new WebScraper(options);
  }
  return instance;
}

// Convenience functions
async function scrapeHTML(url, options = {}) {
  const scraper = getWebScraper();
  await scraper.init();
  return scraper.getHTML(url, options);
}

async function scrapeText(url, options = {}) {
  const scraper = getWebScraper();
  await scraper.init();
  return scraper.getText(url, options);
}

async function scrapeLinks(url, options = {}) {
  const scraper = getWebScraper();
  await scraper.init();
  return scraper.getLinks(url, options);
}

async function scrapeImages(url, options = {}) {
  const scraper = getWebScraper();
  await scraper.init();
  return scraper.getImages(url, options);
}

async function extractData(url, selectors, options = {}) {
  const scraper = getWebScraper();
  await scraper.init();
  return scraper.extract(url, selectors, options);
}

module.exports = {
  WebScraper,
  getWebScraper,
  scrapeHTML,
  scrapeText,
  scrapeLinks,
  scrapeImages,
  extractData,
};
