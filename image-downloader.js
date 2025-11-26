/**
 * Image Downloader Utility
 * Downloads main images from a web page to a specified directory
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

class ImageDownloader {
    constructor(options = {}) {
        this.browser = null;
        this.defaultOptions = {
            timeout: 30000,
            waitUntil: 'networkidle2',
            minWidth: 200,      // Minimum image width to consider "main"
            minHeight: 200,     // Minimum image height to consider "main"
            maxImages: 20,      // Maximum number of images to download
            loadLazyImages: true,
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
            console.log('[ImageDownloader] Browser initialized');
        }
        return this;
    }

    /**
     * Download a single image from URL
     * @param {string} imageUrl - URL of the image
     * @param {string} outputPath - Path to save the image
     * @returns {Promise<Object>} - Download result
     */
    async downloadImage(imageUrl, outputPath) {
        return new Promise((resolve, reject) => {
            const protocol = imageUrl.startsWith('https') ? https : http;
            
            const request = protocol.get(imageUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                    'Accept': 'image/*,*/*'
                },
                timeout: 15000
            }, (response) => {
                // Handle redirects
                if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                    this.downloadImage(response.headers.location, outputPath)
                        .then(resolve)
                        .catch(reject);
                    return;
                }

                if (response.statusCode !== 200) {
                    reject(new Error(`HTTP ${response.statusCode}`));
                    return;
                }

                const contentType = response.headers['content-type'] || '';
                if (!contentType.includes('image')) {
                    reject(new Error('Not an image: ' + contentType));
                    return;
                }

                const fileStream = fs.createWriteStream(outputPath);
                response.pipe(fileStream);

                fileStream.on('finish', () => {
                    fileStream.close();
                    const stats = fs.statSync(outputPath);
                    resolve({
                        success: true,
                        path: outputPath,
                        size: stats.size,
                        contentType
                    });
                });

                fileStream.on('error', (err) => {
                    fs.unlink(outputPath, () => {});
                    reject(err);
                });
            });

            request.on('error', reject);
            request.on('timeout', () => {
                request.destroy();
                reject(new Error('Request timeout'));
            });
        });
    }

    /**
     * Get file extension from URL or content type
     */
    getExtension(url, contentType = '') {
        // Try to get from URL
        const urlPath = new URL(url).pathname;
        const ext = path.extname(urlPath).toLowerCase();
        if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp'].includes(ext)) {
            return ext;
        }

        // Try from content type
        if (contentType.includes('jpeg') || contentType.includes('jpg')) return '.jpg';
        if (contentType.includes('png')) return '.png';
        if (contentType.includes('gif')) return '.gif';
        if (contentType.includes('webp')) return '.webp';
        if (contentType.includes('svg')) return '.svg';

        return '.jpg'; // Default
    }

    /**
     * Generate safe filename from URL
     */
    generateFilename(url, index) {
        try {
            const urlObj = new URL(url);
            let name = path.basename(urlObj.pathname).replace(/[^a-zA-Z0-9.-]/g, '_');
            if (!name || name === '_' || name.length > 50) {
                name = `image_${index}`;
            }
            // Remove extension if present (we'll add it later)
            name = name.replace(/\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i, '');
            return name;
        } catch {
            return `image_${index}`;
        }
    }

    /**
     * Download main images from a web page
     * @param {string} url - URL to scrape images from
     * @param {string} outputDir - Directory to save images
     * @param {Object} options - Download options
     * @returns {Promise<Object>} - Download results
     */
    async downloadFromPage(url, outputDir, options = {}) {
        const opts = { ...this.defaultOptions, ...options };

        if (!this.browser) {
            await this.init();
        }

        // Create output directory if it doesn't exist
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
            console.log(`[ImageDownloader] Created directory: ${outputDir}`);
        }

        const page = await this.browser.newPage();
        
        try {
            console.log(`[ImageDownloader] Loading page: ${url}`);
            await page.goto(url, {
                waitUntil: opts.waitUntil,
                timeout: opts.timeout
            });

            // Scroll to load lazy images
            if (opts.loadLazyImages) {
                console.log('[ImageDownloader] Scrolling to load lazy images...');
                await page.evaluate(async () => {
                    await new Promise(resolve => {
                        let totalHeight = 0;
                        const distance = 400;
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

            // Wait for images to load
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Get all images with their dimensions
            const images = await page.evaluate((minW, minH, baseUrl) => {
                const imgs = [];
                const seen = new Set();

                // Get regular img tags
                document.querySelectorAll('img').forEach(img => {
                    let src = img.src || img.dataset.src || img.dataset.lazySrc || img.dataset.original;
                    if (!src) return;

                    // Make absolute URL
                    try {
                        src = new URL(src, baseUrl).href;
                    } catch { return; }

                    // Skip data URLs, tiny images, icons
                    if (src.startsWith('data:')) return;
                    if (seen.has(src)) return;
                    seen.add(src);

                    const width = img.naturalWidth || img.width || 0;
                    const height = img.naturalHeight || img.height || 0;

                    // Check if it's likely a main image
                    const isMain = (
                        (width >= minW && height >= minH) ||
                        img.classList.contains('hero') ||
                        img.classList.contains('main') ||
                        img.classList.contains('featured') ||
                        img.closest('article') !== null ||
                        img.closest('main') !== null ||
                        img.closest('[class*="content"]') !== null
                    );

                    imgs.push({
                        src,
                        width,
                        height,
                        alt: img.alt || '',
                        isMain,
                        area: width * height
                    });
                });

                // Get background images from key elements
                document.querySelectorAll('[style*="background-image"], .hero, .banner, .featured-image').forEach(el => {
                    const style = getComputedStyle(el);
                    const bgImage = style.backgroundImage;
                    if (bgImage && bgImage !== 'none') {
                        const match = bgImage.match(/url\(["']?(.+?)["']?\)/);
                        if (match) {
                            let src = match[1];
                            try {
                                src = new URL(src, baseUrl).href;
                            } catch { return; }

                            if (!src.startsWith('data:') && !seen.has(src)) {
                                seen.add(src);
                                const rect = el.getBoundingClientRect();
                                imgs.push({
                                    src,
                                    width: rect.width,
                                    height: rect.height,
                                    alt: '',
                                    isMain: true,
                                    area: rect.width * rect.height,
                                    isBackground: true
                                });
                            }
                        }
                    }
                });

                return imgs;
            }, opts.minWidth, opts.minHeight, url);

            console.log(`[ImageDownloader] Found ${images.length} images total`);

            // Filter and sort images
            let mainImages = images
                .filter(img => {
                    // Filter out small images, icons, tracking pixels
                    if (img.width > 0 && img.width < opts.minWidth) return false;
                    if (img.height > 0 && img.height < opts.minHeight) return false;
                    if (img.src.includes('icon') && !img.src.includes('logo')) return false;
                    // Keep logos - they're often important branding
                    if (img.src.includes('avatar')) return false;
                    if (img.src.includes('sprite')) return false;
                    if (img.src.includes('tracking')) return false;
                    if (img.src.includes('pixel')) return false;
                    if (img.src.includes('badge')) return false;
                    return true;
                })
                .sort((a, b) => {
                    // Prioritize "main" images, then by area
                    if (a.isMain && !b.isMain) return -1;
                    if (!a.isMain && b.isMain) return 1;
                    return b.area - a.area;
                })
                .slice(0, opts.maxImages);

            console.log(`[ImageDownloader] Downloading ${mainImages.length} main images...`);

            // Download images
            const results = {
                url,
                outputDir,
                downloaded: [],
                failed: [],
                total: mainImages.length
            };

            for (let i = 0; i < mainImages.length; i++) {
                const img = mainImages[i];
                const filename = this.generateFilename(img.src, i + 1);
                const ext = this.getExtension(img.src);
                const outputPath = path.join(outputDir, `${filename}${ext}`);

                try {
                    console.log(`[ImageDownloader] ${i + 1}/${mainImages.length}: ${filename}${ext}`);
                    const result = await this.downloadImage(img.src, outputPath);
                    results.downloaded.push({
                        ...result,
                        originalUrl: img.src,
                        alt: img.alt,
                        width: img.width,
                        height: img.height
                    });
                } catch (error) {
                    console.log(`[ImageDownloader] Failed: ${error.message}`);
                    results.failed.push({
                        url: img.src,
                        error: error.message
                    });
                }
            }

            console.log(`[ImageDownloader] Done: ${results.downloaded.length} downloaded, ${results.failed.length} failed`);
            return results;

        } finally {
            await page.close();
        }
    }

    /**
     * Close the browser instance
     */
    async close() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            console.log('[ImageDownloader] Browser closed');
        }
    }
}

// Singleton instance
let instance = null;

function getImageDownloader(options = {}) {
    if (!instance) {
        instance = new ImageDownloader(options);
    }
    return instance;
}

/**
 * Download main images from a URL to a directory
 * @param {string} url - Web page URL
 * @param {string} outputDir - Directory to save images
 * @param {Object} options - Options: minWidth, minHeight, maxImages, loadLazyImages
 * @returns {Promise<Object>} - Download results
 */
async function downloadImages(url, outputDir, options = {}) {
    const downloader = getImageDownloader();
    await downloader.init();
    return downloader.downloadFromPage(url, outputDir, options);
}

module.exports = {
    ImageDownloader,
    getImageDownloader,
    downloadImages
};

