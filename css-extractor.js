/**
 * CSS Extractor Utility
 * Extracts CSS from web pages - inline styles, stylesheets, and computed styles
 */

const puppeteer = require('puppeteer');
const https = require('https');
const http = require('http');

class CSSExtractor {
    constructor(options = {}) {
        this.browser = null;
        this.defaultOptions = {
            timeout: 30000,
            waitUntil: 'networkidle2',
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
                    '--disable-dev-shm-usage'
                ]
            });
            console.log('[CSSExtractor] Browser initialized');
        }
        return this;
    }

    /**
     * Fetch CSS content from a URL
     */
    async fetchCSS(cssUrl) {
        return new Promise((resolve, reject) => {
            const protocol = cssUrl.startsWith('https') ? https : http;
            
            protocol.get(cssUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                    'Accept': 'text/css,*/*'
                },
                timeout: 10000
            }, (response) => {
                if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                    this.fetchCSS(response.headers.location).then(resolve).catch(reject);
                    return;
                }

                if (response.statusCode !== 200) {
                    reject(new Error(`HTTP ${response.statusCode}`));
                    return;
                }

                let data = '';
                response.on('data', chunk => data += chunk);
                response.on('end', () => resolve(data));
                response.on('error', reject);
            }).on('error', reject);
        });
    }

    /**
     * Extract all CSS from a page
     * @param {string} url - URL to extract CSS from
     * @param {Object} options - Extraction options
     * @returns {Promise<Object>} - Extracted CSS
     */
    async extractAll(url, options = {}) {
        const opts = { ...this.defaultOptions, ...options };

        if (!this.browser) {
            await this.init();
        }

        const page = await this.browser.newPage();

        try {
            console.log(`[CSSExtractor] Loading: ${url}`);
            
            // Track loaded stylesheets
            const stylesheetUrls = [];
            page.on('response', async (response) => {
                const contentType = response.headers()['content-type'] || '';
                if (contentType.includes('text/css') || response.url().endsWith('.css')) {
                    stylesheetUrls.push(response.url());
                }
            });

            await page.goto(url, {
                waitUntil: opts.waitUntil,
                timeout: opts.timeout
            });

            // Extract inline styles and stylesheet links
            const pageCSS = await page.evaluate(() => {
                const result = {
                    inlineStyles: [],
                    styleTags: [],
                    linkedStylesheets: [],
                    importedStylesheets: []
                };

                // Get <style> tags
                document.querySelectorAll('style').forEach((style, index) => {
                    result.styleTags.push({
                        index,
                        content: style.textContent,
                        media: style.media || 'all'
                    });
                });

                // Get <link rel="stylesheet"> tags
                document.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
                    result.linkedStylesheets.push({
                        href: link.href,
                        media: link.media || 'all',
                        title: link.title || null
                    });
                });

                // Get inline styles from elements
                document.querySelectorAll('[style]').forEach(el => {
                    const style = el.getAttribute('style');
                    if (style && style.trim()) {
                        result.inlineStyles.push({
                            tag: el.tagName.toLowerCase(),
                            id: el.id || null,
                            class: el.className || null,
                            style: style.trim()
                        });
                    }
                });

                return result;
            });

            // Fetch external stylesheet contents
            console.log(`[CSSExtractor] Found ${pageCSS.linkedStylesheets.length} linked stylesheets`);
            
            const externalCSS = [];
            for (const sheet of pageCSS.linkedStylesheets) {
                try {
                    console.log(`[CSSExtractor] Fetching: ${sheet.href.substring(0, 60)}...`);
                    const content = await this.fetchCSS(sheet.href);
                    externalCSS.push({
                        url: sheet.href,
                        media: sheet.media,
                        content,
                        size: content.length
                    });
                } catch (error) {
                    externalCSS.push({
                        url: sheet.href,
                        media: sheet.media,
                        error: error.message
                    });
                }
            }

            // Combine all CSS
            let combinedCSS = '';
            
            // Add external stylesheets
            externalCSS.forEach(sheet => {
                if (sheet.content) {
                    combinedCSS += `/* === ${sheet.url} === */\n`;
                    combinedCSS += sheet.content + '\n\n';
                }
            });

            // Add style tags
            pageCSS.styleTags.forEach(style => {
                combinedCSS += `/* === Inline <style> tag #${style.index} === */\n`;
                combinedCSS += style.content + '\n\n';
            });

            return {
                url,
                styleTags: pageCSS.styleTags,
                linkedStylesheets: externalCSS,
                inlineStyles: pageCSS.inlineStyles,
                combined: combinedCSS,
                stats: {
                    styleTagCount: pageCSS.styleTags.length,
                    linkedStylesheetCount: externalCSS.length,
                    inlineStyleCount: pageCSS.inlineStyles.length,
                    totalSize: combinedCSS.length
                }
            };

        } finally {
            await page.close();
        }
    }

    /**
     * Extract only external stylesheets
     * @param {string} url - URL to extract from
     * @param {Object} options - Options
     * @returns {Promise<Array>} - Array of stylesheet objects
     */
    async extractStylesheets(url, options = {}) {
        const result = await this.extractAll(url, options);
        return result.linkedStylesheets;
    }

    /**
     * Extract computed styles for specific elements
     * @param {string} url - URL to extract from
     * @param {string|Array} selectors - CSS selector(s)
     * @param {Object} options - Options
     * @returns {Promise<Object>} - Computed styles per selector
     */
    async extractComputedStyles(url, selectors, options = {}) {
        const opts = { ...this.defaultOptions, ...options };

        if (!this.browser) {
            await this.init();
        }

        const page = await this.browser.newPage();

        try {
            await page.goto(url, {
                waitUntil: opts.waitUntil,
                timeout: opts.timeout
            });

            const selectorArray = Array.isArray(selectors) ? selectors : [selectors];

            const computedStyles = await page.evaluate((sels) => {
                const result = {};

                sels.forEach(sel => {
                    const elements = document.querySelectorAll(sel);
                    result[sel] = Array.from(elements).map(el => {
                        const computed = getComputedStyle(el);
                        const styles = {};

                        // Get all computed properties
                        for (let i = 0; i < computed.length; i++) {
                            const prop = computed[i];
                            styles[prop] = computed.getPropertyValue(prop);
                        }

                        return {
                            tag: el.tagName.toLowerCase(),
                            id: el.id || null,
                            class: el.className || null,
                            styles
                        };
                    });
                });

                return result;
            }, selectorArray);

            return computedStyles;

        } finally {
            await page.close();
        }
    }

    /**
     * Extract CSS variables (custom properties)
     * @param {string} url - URL to extract from
     * @param {Object} options - Options
     * @returns {Promise<Object>} - CSS variables
     */
    async extractCSSVariables(url, options = {}) {
        const opts = { ...this.defaultOptions, ...options };

        if (!this.browser) {
            await this.init();
        }

        const page = await this.browser.newPage();

        try {
            await page.goto(url, {
                waitUntil: opts.waitUntil,
                timeout: opts.timeout
            });

            const variables = await page.evaluate(() => {
                const result = {
                    root: {},
                    all: []
                };

                // Get :root variables
                const rootStyles = getComputedStyle(document.documentElement);
                const rootCSS = document.styleSheets;

                // Parse all stylesheets for CSS variables
                for (const sheet of rootCSS) {
                    try {
                        for (const rule of sheet.cssRules) {
                            if (rule.style) {
                                for (let i = 0; i < rule.style.length; i++) {
                                    const prop = rule.style[i];
                                    if (prop.startsWith('--')) {
                                        const value = rule.style.getPropertyValue(prop);
                                        result.all.push({
                                            name: prop,
                                            value: value.trim(),
                                            selector: rule.selectorText
                                        });

                                        if (rule.selectorText === ':root') {
                                            result.root[prop] = value.trim();
                                        }
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        // Cross-origin stylesheets will throw
                    }
                }

                return result;
            });

            return variables;

        } finally {
            await page.close();
        }
    }

    /**
     * Extract color palette from CSS
     * @param {string} url - URL to extract from
     * @param {Object} options - Options
     * @returns {Promise<Object>} - Color palette
     */
    async extractColors(url, options = {}) {
        const result = await this.extractAll(url, options);
        
        const colorRegex = /#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\)|(?:^|\s)(aliceblue|antiquewhite|aqua|aquamarine|azure|beige|bisque|black|blanchedalmond|blue|blueviolet|brown|burlywood|cadetblue|chartreuse|chocolate|coral|cornflowerblue|cornsilk|crimson|cyan|darkblue|darkcyan|darkgoldenrod|darkgray|darkgreen|darkgrey|darkkhaki|darkmagenta|darkolivegreen|darkorange|darkorchid|darkred|darksalmon|darkseagreen|darkslateblue|darkslategray|darkslategrey|darkturquoise|darkviolet|deeppink|deepskyblue|dimgray|dimgrey|dodgerblue|firebrick|floralwhite|forestgreen|fuchsia|gainsboro|ghostwhite|gold|goldenrod|gray|green|greenyellow|grey|honeydew|hotpink|indianred|indigo|ivory|khaki|lavender|lavenderblush|lawngreen|lemonchiffon|lightblue|lightcoral|lightcyan|lightgoldenrodyellow|lightgray|lightgreen|lightgrey|lightpink|lightsalmon|lightseagreen|lightskyblue|lightslategray|lightslategrey|lightsteelblue|lightyellow|lime|limegreen|linen|magenta|maroon|mediumaquamarine|mediumblue|mediumorchid|mediumpurple|mediumseagreen|mediumslateblue|mediumspringgreen|mediumturquoise|mediumvioletred|midnightblue|mintcream|mistyrose|moccasin|navajowhite|navy|oldlace|olive|olivedrab|orange|orangered|orchid|palegoldenrod|palegreen|paleturquoise|palevioletred|papayawhip|peachpuff|peru|pink|plum|powderblue|purple|rebeccapurple|red|rosybrown|royalblue|saddlebrown|salmon|sandybrown|seagreen|seashell|sienna|silver|skyblue|slateblue|slategray|slategrey|snow|springgreen|steelblue|tan|teal|thistle|tomato|turquoise|violet|wheat|white|whitesmoke|yellow|yellowgreen)(?:\s|$|;)/gi;

        const colors = new Map();
        const matches = result.combined.matchAll(colorRegex);

        for (const match of matches) {
            const color = match[0].trim().replace(/;$/, '');
            if (color && !color.includes('inherit') && !color.includes('transparent') && !color.includes('currentColor')) {
                colors.set(color.toLowerCase(), (colors.get(color.toLowerCase()) || 0) + 1);
            }
        }

        // Sort by frequency
        const sortedColors = Array.from(colors.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([color, count]) => ({ color, count }));

        return {
            total: sortedColors.length,
            colors: sortedColors
        };
    }

    /**
     * Extract font information
     * @param {string} url - URL to extract from
     * @param {Object} options - Options
     * @returns {Promise<Object>} - Font information
     */
    async extractFonts(url, options = {}) {
        const result = await this.extractAll(url, options);

        const fontFamilyRegex = /font-family\s*:\s*([^;]+)/gi;
        const fontFaceRegex = /@font-face\s*\{[^}]+\}/gi;

        const fontFamilies = new Set();
        const fontFaces = [];

        // Extract font-family declarations
        let match;
        while ((match = fontFamilyRegex.exec(result.combined)) !== null) {
            const families = match[1].split(',').map(f => f.trim().replace(/['"]/g, ''));
            families.forEach(f => fontFamilies.add(f));
        }

        // Extract @font-face rules
        const faceMatches = result.combined.matchAll(fontFaceRegex);
        for (const faceMatch of faceMatches) {
            fontFaces.push(faceMatch[0]);
        }

        return {
            families: Array.from(fontFamilies),
            fontFaces: fontFaces,
            stats: {
                familyCount: fontFamilies.size,
                fontFaceCount: fontFaces.length
            }
        };
    }

    /**
     * Close the browser instance
     */
    async close() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            console.log('[CSSExtractor] Browser closed');
        }
    }
}

// Singleton instance
let instance = null;

function getCSSExtractor(options = {}) {
    if (!instance) {
        instance = new CSSExtractor(options);
    }
    return instance;
}

// Convenience functions
async function extractCSS(url, options = {}) {
    const extractor = getCSSExtractor();
    await extractor.init();
    return extractor.extractAll(url, options);
}

async function extractCSSVariables(url, options = {}) {
    const extractor = getCSSExtractor();
    await extractor.init();
    return extractor.extractCSSVariables(url, options);
}

async function extractColors(url, options = {}) {
    const extractor = getCSSExtractor();
    await extractor.init();
    return extractor.extractColors(url, options);
}

async function extractFonts(url, options = {}) {
    const extractor = getCSSExtractor();
    await extractor.init();
    return extractor.extractFonts(url, options);
}

module.exports = {
    CSSExtractor,
    getCSSExtractor,
    extractCSS,
    extractCSSVariables,
    extractColors,
    extractFonts
};

