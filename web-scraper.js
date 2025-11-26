/**
 * Web Scraper Utility
 * Scrapes HTML content and extracts data from web pages using Puppeteer
 */

const puppeteer = require('puppeteer');

class WebScraper {
    constructor(options = {}) {
        this.browser = null;
        this.defaultOptions = {
            timeout: 30000,
            waitUntil: 'networkidle2',
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            ...options
        };
    }

    /**
     * Initialize the browser instance
     */
    async init() {
        if (!this.browser) {
            this.browser = await puppeteer.launch({
                headless: 'new',
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--disable-gpu'
                ]
            });
            console.log('[Scraper] Browser initialized');
        }
        return this;
    }

    /**
     * Create a new page with default settings
     */
    async createPage(options = {}) {
        const opts = { ...this.defaultOptions, ...options };
        const page = await this.browser.newPage();
        
        if (opts.userAgent) {
            await page.setUserAgent(opts.userAgent);
        }
        
        if (opts.viewport) {
            await page.setViewport(opts.viewport);
        }
        
        // Block unnecessary resources for faster scraping
        if (opts.blockResources) {
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                const blocked = ['image', 'stylesheet', 'font', 'media'];
                if (blocked.includes(req.resourceType())) {
                    req.abort();
                } else {
                    req.continue();
                }
            });
        }
        
        return page;
    }

    /**
     * Get full HTML content of a page
     * @param {string} url - URL to scrape
     * @param {Object} options - Scrape options
     * @returns {Promise<string>} - Full HTML content
     */
    async getHTML(url, options = {}) {
        const opts = { ...this.defaultOptions, ...options };
        
        if (!this.browser) {
            await this.init();
        }

        const page = await this.createPage(opts);
        
        try {
            console.log(`[Scraper] Fetching HTML: ${url}`);
            await page.goto(url, {
                waitUntil: opts.waitUntil,
                timeout: opts.timeout
            });

            // Wait for additional conditions
            if (opts.delay) {
                await new Promise(resolve => setTimeout(resolve, opts.delay));
            }
            
            if (opts.waitForSelector) {
                await page.waitForSelector(opts.waitForSelector, { timeout: opts.timeout });
            }

            if (opts.waitForIdle) {
                await page.evaluate(() => {
                    return new Promise(resolve => {
                        let timeout;
                        const observer = new MutationObserver(() => {
                            clearTimeout(timeout);
                            timeout = setTimeout(resolve, 500);
                        });
                        observer.observe(document.body, { childList: true, subtree: true });
                        timeout = setTimeout(resolve, 2000);
                    });
                });
            }

            const html = await page.content();
            console.log(`[Scraper] Got ${html.length} characters`);
            return html;

        } finally {
            await page.close();
        }
    }

    /**
     * Get text content of a page (no HTML tags)
     * @param {string} url - URL to scrape
     * @param {Object} options - Scrape options
     * @returns {Promise<string>} - Text content
     */
    async getText(url, options = {}) {
        const opts = { ...this.defaultOptions, ...options };
        
        if (!this.browser) {
            await this.init();
        }

        const page = await this.createPage({ ...opts, blockResources: true });
        
        try {
            console.log(`[Scraper] Fetching text: ${url}`);
            await page.goto(url, {
                waitUntil: opts.waitUntil,
                timeout: opts.timeout
            });

            if (opts.waitForSelector) {
                await page.waitForSelector(opts.waitForSelector, { timeout: opts.timeout });
            }

            const text = await page.evaluate(() => {
                // Remove script and style elements
                const scripts = document.querySelectorAll('script, style, noscript');
                scripts.forEach(el => el.remove());
                return document.body.innerText;
            });

            console.log(`[Scraper] Got ${text.length} characters of text`);
            return text;

        } finally {
            await page.close();
        }
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
        
        if (!this.browser) {
            await this.init();
        }

        const page = await this.createPage(opts);
        
        try {
            console.log(`[Scraper] Extracting from: ${url}`);
            await page.goto(url, {
                waitUntil: opts.waitUntil,
                timeout: opts.timeout
            });

            if (opts.waitForSelector) {
                await page.waitForSelector(opts.waitForSelector, { timeout: opts.timeout });
            }

            // Normalize selectors to array
            const selectorArray = Array.isArray(selectors) ? selectors : [selectors];
            
            const results = await page.evaluate((sels) => {
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
            }, selectorArray);

            return results;

        } finally {
            await page.close();
        }
    }

    /**
     * Extract structured data (JSON-LD, microdata, Open Graph)
     * @param {string} url - URL to scrape
     * @param {Object} options - Scrape options
     * @returns {Promise<Object>} - Structured data
     */
    async getStructuredData(url, options = {}) {
        const opts = { ...this.defaultOptions, ...options };
        
        if (!this.browser) {
            await this.init();
        }

        const page = await this.createPage({ ...opts, blockResources: true });
        
        try {
            console.log(`[Scraper] Getting structured data: ${url}`);
            await page.goto(url, {
                waitUntil: opts.waitUntil,
                timeout: opts.timeout
            });

            const data = await page.evaluate(() => {
                const result = {
                    jsonLd: [],
                    openGraph: {},
                    twitter: {},
                    meta: {}
                };

                // JSON-LD
                document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
                    try {
                        result.jsonLd.push(JSON.parse(script.textContent));
                    } catch (e) {}
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
            });

            return data;

        } finally {
            await page.close();
        }
    }

    /**
     * Extract all links from a page
     * @param {string} url - URL to scrape
     * @param {Object} options - Scrape options
     * @returns {Promise<Array>} - Array of links
     */
    async getLinks(url, options = {}) {
        const opts = { ...this.defaultOptions, ...options };
        
        if (!this.browser) {
            await this.init();
        }

        const page = await this.createPage({ ...opts, blockResources: true });
        
        try {
            console.log(`[Scraper] Getting links: ${url}`);
            await page.goto(url, {
                waitUntil: opts.waitUntil,
                timeout: opts.timeout
            });

            const links = await page.evaluate((baseUrl) => {
                return Array.from(document.querySelectorAll('a[href]')).map(a => {
                    let href = a.href;
                    // Handle relative URLs
                    try {
                        href = new URL(a.getAttribute('href'), baseUrl).href;
                    } catch (e) {}
                    
                    return {
                        href: href,
                        text: a.innerText?.trim(),
                        title: a.title || null,
                        rel: a.rel || null,
                        target: a.target || null,
                        isExternal: !href.startsWith(new URL(baseUrl).origin)
                    };
                }).filter(link => link.href && !link.href.startsWith('javascript:'));
            }, url);

            console.log(`[Scraper] Found ${links.length} links`);
            return links;

        } finally {
            await page.close();
        }
    }

    /**
     * Extract all images from a page
     * @param {string} url - URL to scrape
     * @param {Object} options - Scrape options
     * @returns {Promise<Array>} - Array of images
     */
    async getImages(url, options = {}) {
        const opts = { ...this.defaultOptions, ...options };
        
        if (!this.browser) {
            await this.init();
        }

        const page = await this.createPage(opts);
        
        try {
            console.log(`[Scraper] Getting images: ${url}`);
            await page.goto(url, {
                waitUntil: opts.waitUntil,
                timeout: opts.timeout
            });

            // Scroll to load lazy images
            if (opts.loadLazyImages) {
                await page.evaluate(async () => {
                    await new Promise(resolve => {
                        let totalHeight = 0;
                        const distance = 300;
                        const timer = setInterval(() => {
                            window.scrollBy(0, distance);
                            totalHeight += distance;
                            if (totalHeight >= document.body.scrollHeight) {
                                clearInterval(timer);
                                window.scrollTo(0, 0);
                                setTimeout(resolve, 1000);
                            }
                        }, 100);
                    });
                });
            }

            const images = await page.evaluate((baseUrl) => {
                return Array.from(document.querySelectorAll('img')).map(img => {
                    let src = img.src || img.dataset.src || img.dataset.lazySrc;
                    try {
                        src = new URL(src, baseUrl).href;
                    } catch (e) {}
                    
                    return {
                        src: src,
                        alt: img.alt || null,
                        title: img.title || null,
                        width: img.naturalWidth || img.width || null,
                        height: img.naturalHeight || img.height || null,
                        loading: img.loading || null
                    };
                }).filter(img => img.src);
            }, url);

            console.log(`[Scraper] Found ${images.length} images`);
            return images;

        } finally {
            await page.close();
        }
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
        
        if (!this.browser) {
            await this.init();
        }

        const page = await this.createPage(opts);
        
        try {
            console.log(`[Scraper] Evaluating script on: ${url}`);
            await page.goto(url, {
                waitUntil: opts.waitUntil,
                timeout: opts.timeout
            });

            if (opts.waitForSelector) {
                await page.waitForSelector(opts.waitForSelector, { timeout: opts.timeout });
            }

            const result = await page.evaluate(script);
            return result;

        } finally {
            await page.close();
        }
    }

    /**
     * Scrape multiple pages
     * @param {Array<string>} urls - URLs to scrape
     * @param {Function} scrapeFunc - Function to call for each URL
     * @param {Object} options - Scrape options
     * @returns {Promise<Array>} - Array of results
     */
    async scrapeMultiple(urls, scrapeFunc = 'getHTML', options = {}) {
        const results = [];
        
        for (const url of urls) {
            try {
                const func = typeof scrapeFunc === 'function' 
                    ? scrapeFunc 
                    : this[scrapeFunc].bind(this);
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
     */
    async close() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            console.log('[Scraper] Browser closed');
        }
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
    extractData
};

