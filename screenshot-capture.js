/**
 * Screenshot Capture Utility
 * Captures screenshots from URLs using Puppeteer (headless Chrome)
 */

const puppeteer = require('puppeteer');

class ScreenshotCapture {
  constructor(options = {}) {
    this.browser = null;
    this.defaultOptions = {
      width: 1280,
      height: 800,
      fullPage: false,
      format: 'png', // 'png' or 'jpeg'
      quality: 80, // Only for jpeg
      timeout: 30000, // 30 seconds
      waitUntil: 'networkidle2', // 'load', 'domcontentloaded', 'networkidle0', 'networkidle2'
      ...options,
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
          '--disable-gpu',
        ],
      });
      console.log('[Screenshot] Browser initialized');
    }
    return this;
  }

  /**
   * Capture a screenshot from a URL
   * @param {string} url - The URL to capture
   * @param {Object} options - Override default options
   * @returns {Promise<Buffer|string>} - Screenshot buffer or file path
   */
  async capture(url, options = {}) {
    const opts = { ...this.defaultOptions, ...options };

    if (!this.browser) {
      await this.init();
    }

    const page = await this.browser.newPage();

    try {
      // Set viewport
      await page.setViewport({
        width: opts.width,
        height: opts.height,
        deviceScaleFactor: opts.deviceScaleFactor || 1,
      });

      // Set user agent if provided
      if (opts.userAgent) {
        await page.setUserAgent(opts.userAgent);
      }

      // Navigate to URL
      console.log(`[Screenshot] Navigating to: ${url}`);
      await page.goto(url, {
        waitUntil: opts.waitUntil,
        timeout: opts.timeout,
      });

      // Wait for additional time if specified
      if (opts.delay) {
        await new Promise((resolve) => {
          setTimeout(resolve, opts.delay);
        });
      }

      // Wait for selector if specified
      if (opts.waitForSelector) {
        await page.waitForSelector(opts.waitForSelector, { timeout: opts.timeout });
      }

      // Prepare screenshot options
      const screenshotOpts = {
        type: opts.format,
        fullPage: opts.fullPage,
        omitBackground: opts.transparent || false,
      };

      if (opts.format === 'jpeg') {
        screenshotOpts.quality = opts.quality;
      }

      // Capture specific element if selector provided
      if (opts.selector) {
        const element = await page.$(opts.selector);
        if (element) {
          screenshotOpts.clip = await element.boundingBox();
        }
      }

      // Save to file or return buffer
      if (opts.outputPath) {
        screenshotOpts.path = opts.outputPath;
        await page.screenshot(screenshotOpts);
        console.log(`[Screenshot] Saved to: ${opts.outputPath}`);
        return opts.outputPath;
      } else {
        const buffer = await page.screenshot(screenshotOpts);
        console.log(`[Screenshot] Captured ${buffer.length} bytes`);
        return buffer;
      }
    } finally {
      await page.close();
    }
  }

  /**
   * Capture screenshot and return as base64
   * @param {string} url - The URL to capture
   * @param {Object} options - Override default options
   * @returns {Promise<string>} - Base64 encoded image
   */
  async captureAsBase64(url, options = {}) {
    const buffer = await this.capture(url, options);
    const format = options.format || this.defaultOptions.format;
    const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
  }

  /**
   * Capture multiple URLs
   * @param {Array<{url: string, options?: Object}>} urls - Array of URL configs
   * @returns {Promise<Array>} - Array of results
   */
  async captureMultiple(urls) {
    const results = [];
    for (const item of urls) {
      try {
        const result = await this.capture(item.url, item.options || {});
        results.push({ url: item.url, success: true, result });
      } catch (error) {
        results.push({ url: item.url, success: false, error: error.message });
      }
    }
    return results;
  }

  /**
   * Capture screenshot with different viewport sizes (responsive)
   * @param {string} url - The URL to capture
   * @param {Array<{name: string, width: number, height: number}>} viewports - Viewport configs
   * @param {Object} options - Additional options
   * @returns {Promise<Array>} - Array of results with viewport info
   */
  async captureResponsive(url, viewports = null, options = {}) {
    const defaultViewports = [
      { name: 'desktop', width: 1920, height: 1080 },
      { name: 'laptop', width: 1366, height: 768 },
      { name: 'tablet', width: 768, height: 1024 },
      { name: 'mobile', width: 375, height: 667 },
    ];

    const vps = viewports || defaultViewports;
    const results = [];

    for (const vp of vps) {
      try {
        const result = await this.capture(url, {
          ...options,
          width: vp.width,
          height: vp.height,
        });
        results.push({ viewport: vp.name, width: vp.width, height: vp.height, success: true, result });
      } catch (error) {
        results.push({ viewport: vp.name, width: vp.width, height: vp.height, success: false, error: error.message });
      }
    }

    return results;
  }

  /**
   * Generate a thumbnail from a URL
   * @param {string} url - The URL to capture
   * @param {Object} options - Thumbnail options
   * @returns {Promise<Buffer>} - Thumbnail buffer
   */
  async captureThumbnail(url, options = {}) {
    const thumbOpts = {
      width: options.width || 320,
      height: options.height || 240,
      format: 'jpeg',
      quality: options.quality || 70,
      ...options,
    };
    return this.capture(url, thumbOpts);
  }

  /**
   * Close the browser instance
   */
  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      console.log('[Screenshot] Browser closed');
    }
  }
}

// Singleton instance for easy use
let instance = null;

/**
 * Get or create singleton instance
 */
function getScreenshotCapture(options = {}) {
  if (!instance) {
    instance = new ScreenshotCapture(options);
  }
  return instance;
}

/**
 * Quick capture function (convenience method)
 * @param {string} url - URL to capture
 * @param {Object} options - Capture options
 * @returns {Promise<Buffer|string>}
 */
async function captureScreenshot(url, options = {}) {
  const capture = getScreenshotCapture();
  await capture.init();
  return capture.capture(url, options);
}

/**
 * Quick capture to base64 (convenience method)
 * @param {string} url - URL to capture
 * @param {Object} options - Capture options
 * @returns {Promise<string>} - Base64 data URL
 */
async function captureScreenshotBase64(url, options = {}) {
  const capture = getScreenshotCapture();
  await capture.init();
  return capture.captureAsBase64(url, options);
}

module.exports = {
  ScreenshotCapture,
  getScreenshotCapture,
  captureScreenshot,
  captureScreenshotBase64,
};
