const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

class HTMLPreviewSystem {
  constructor() {
    this.thumbnailCache = new Map();
    this.chromePath = this.detectChromePath();
    this.thumbnailSize = { width: 400, height: 300 };
  }

  detectChromePath() {
    const platform = process.platform;

    const paths =
      platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
          ]
        : platform === 'win32'
          ? [
              'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
              'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
              process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
            ]
          : ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'];

    for (const chromePath of paths) {
      if (fs.existsSync(chromePath)) {
        return chromePath;
      }
    }

    return null; // Chrome not found, will fall back to SVG
  }

  // Generate thumbnail for HTML content
  async generateHTMLThumbnail(item) {
    console.log('[HTML-PREVIEW] Generating thumbnail for item:', item.id);

    // Check cache first
    if (this.thumbnailCache.has(item.id)) {
      console.log('[HTML-PREVIEW] Returning cached thumbnail');
      return this.thumbnailCache.get(item.id);
    }

    // If no Chrome, return SVG fallback
    if (!this.chromePath) {
      console.log('[HTML-PREVIEW] Chrome not found, using SVG fallback');
      return this.generateSVGFallback(item);
    }

    console.log('[HTML-PREVIEW] Chrome path:', this.chromePath);

    try {
      // Save HTML to temp file
      const tempHtmlPath = path.join(os.tmpdir(), `html-${item.id}.html`);
      const htmlContent = item.content || item.html || '';
      console.log('[HTML-PREVIEW] Writing HTML to temp file:', tempHtmlPath);
      console.log('[HTML-PREVIEW] HTML content length:', htmlContent.length);
      fs.writeFileSync(tempHtmlPath, htmlContent, 'utf8');

      // Generate thumbnail
      const tempImagePath = path.join(os.tmpdir(), `thumb-${item.id}.png`);
      console.log('[HTML-PREVIEW] Capturing screenshot to:', tempImagePath);

      await this.captureScreenshot(tempHtmlPath, tempImagePath);

      // Check if screenshot was created
      if (!fs.existsSync(tempImagePath)) {
        throw new Error('Screenshot file was not created');
      }

      console.log('[HTML-PREVIEW] Screenshot created, size:', fs.statSync(tempImagePath).size);

      // Read and convert to base64
      const imageData = fs.readFileSync(tempImagePath);
      const base64 = `data:image/png;base64,${imageData.toString('base64')}`;

      console.log('[HTML-PREVIEW] Generated PNG thumbnail, base64 length:', base64.length);

      // Cache the result
      this.thumbnailCache.set(item.id, base64);

      // Clean up temp files
      fs.unlinkSync(tempHtmlPath);
      fs.unlinkSync(tempImagePath);

      return base64;
    } catch (error) {
      console.error('[HTML-PREVIEW] Error generating HTML thumbnail:', error);
      console.error('[HTML-PREVIEW] Error details:', error.message, error.code);
      console.log('[HTML-PREVIEW] Falling back to SVG');
      return this.generateSVGFallback(item);
    }
  }

  // Capture screenshot using Chrome
  captureScreenshot(htmlPath, outputPath) {
    return new Promise((resolve, reject) => {
      const args = [
        '--headless=new',
        `--screenshot=${outputPath}`,
        `--window-size=${this.thumbnailSize.width},${this.thumbnailSize.height}`,
        '--default-background-color=ffffff',
        '--hide-scrollbars',
        '--disable-gpu',
        '--no-sandbox',
        pathToFileURL(path.resolve(htmlPath)).href,
      ];

      const command = `"${this.chromePath}" ${args.join(' ')}`;
      console.log('[HTML-PREVIEW] Executing Chrome command:', command);

      exec(command, { timeout: 10000 }, (error, stdout, stderr) => {
        if (error) {
          console.error('[HTML-PREVIEW] Chrome execution error:', error);
          console.error('[HTML-PREVIEW] Chrome stderr:', stderr);
          reject(error);
        } else if (fs.existsSync(outputPath)) {
          console.log('[HTML-PREVIEW] Screenshot successfully created');
          resolve(outputPath);
        } else {
          console.error('[HTML-PREVIEW] Screenshot file not found after Chrome execution');
          reject(new Error('Screenshot not created'));
        }
      });
    });
  }

  // Generate SVG fallback when Chrome is not available
  generateSVGFallback(item) {
    const title = item.metadata?.title || item.text || 'HTML Document';
    const preview = item.preview || item.plainText || '';

    const svg = `
<svg width="400" height="300" xmlns="http://www.w3.org/2000/svg">
  <rect width="400" height="300" fill="#f8f8f8" stroke="#ddd"/>
  <rect x="20" y="20" width="360" height="260" fill="white" stroke="#e0e0e0" rx="4"/>
  
  <!-- HTML icon -->
  <text x="200" y="60" text-anchor="middle" font-family="monospace" font-size="28" font-weight="bold" fill="#e34c26">&lt;/&gt;</text>
  
  <!-- Title -->
  <text x="200" y="100" text-anchor="middle" font-family="Arial, sans-serif" font-size="16" fill="#333">
    ${this.escapeXML(title.substring(0, 30))}
  </text>
  
  <!-- Preview text -->
  <foreignObject x="30" y="120" width="340" height="140">
    <div xmlns="http://www.w3.org/1999/xhtml" style="font-family: Arial, sans-serif; font-size: 12px; color: #666; line-height: 1.4; overflow: hidden;">
      ${this.escapeXML(preview.substring(0, 200))}...
    </div>
  </foreignObject>
</svg>`;

    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  }

  escapeXML(str) {
    return str.replace(/[<>&'"]/g, (c) => {
      switch (c) {
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '&':
          return '&amp;';
        case "'":
          return '&apos;';
        case '"':
          return '&quot;';
      }
    });
  }

  // Clear thumbnail cache for an item
  clearCache(itemId) {
    this.thumbnailCache.delete(itemId);
  }

  // Clear all cached thumbnails
  clearAllCache() {
    this.thumbnailCache.clear();
  }
}

// Renderer process code for clipboard viewer
const htmlPreviewRenderer = {
  // Render HTML item with thumbnail and preview capability
  renderHTMLItem(item) {
    const thumbnail = item.thumbnail || ''; // Thumbnail should be generated by main process
    const title = item.metadata?.title || item.text || 'HTML Document';
    const hasContent = !!(item.content || item.html);

    return `
      <div class="html-item-container">
        <div class="html-thumbnail-section">
          ${
            thumbnail
              ? `<img src="${thumbnail}" class="html-thumbnail" alt="HTML Preview" />`
              : `<div class="html-thumbnail-placeholder">
              <span class="placeholder-icon">🌐</span>
              <span class="placeholder-text">HTML</span>
            </div>`
          }
        </div>
        <div class="html-info-section">
          <div class="html-title">${this.escapeHtml(title)}</div>
          <div class="html-meta">
            ${
              item.metadata?.timestamp
                ? `<span class="meta-date">${new Date(item.metadata.timestamp).toLocaleDateString()}</span>`
                : ''
            }
            ${
              hasContent
                ? `<button class="preview-btn" onclick="toggleHTMLPreview('${item.id}')">
                <span class="preview-icon">👁</span>
                <span class="preview-text">Preview</span>
              </button>`
                : '<span class="no-content">No content</span>'
            }
          </div>
        </div>
        ${
          hasContent
            ? `
          <div class="html-preview-container" id="preview-${item.id}" style="display: none;">
            <div class="preview-toolbar">
              <button onclick="openHTMLInModal('${item.id}')" title="Fullscreen">⛶</button>
              <button onclick="openHTMLInBrowser('${item.id}')" title="Open in Browser">🌐</button>
              <button onclick="copyHTMLSource('${item.id}')" title="Copy HTML">📋</button>
              <button onclick="toggleHTMLPreview('${item.id}')" title="Close">✕</button>
            </div>
            <iframe 
              class="html-preview-iframe"
              id="iframe-${item.id}"
              sandbox="allow-same-origin allow-popups-to-escape-sandbox"
            ></iframe>
          </div>
        `
            : ''
        }
      </div>
    `;
  },

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },

  // CSS styles for the HTML preview system
  getStyles() {
    return `
      /* HTML Item Container */
      .html-item-container {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 12px;
        background: rgba(255, 255, 255, 0.02);
        border-radius: 8px;
        margin: 8px 0;
      }

      /* Thumbnail Section */
      .html-thumbnail-section {
        width: 100%;
        height: 200px;
        overflow: hidden;
        border-radius: 6px;
        background: #f0f0f0;
        position: relative;
      }

      .html-thumbnail {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }

      .html-thumbnail-placeholder {
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        background: linear-gradient(135deg, #f5f5f5 0%, #e0e0e0 100%);
        color: #666;
      }

      .placeholder-icon {
        font-size: 48px;
        margin-bottom: 8px;
      }

      .placeholder-text {
        font-size: 14px;
        font-weight: 500;
      }

      /* Info Section */
      .html-info-section {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }

      .html-title {
        flex: 1;
        font-weight: 500;
        color: rgba(255, 255, 255, 0.9);
        font-size: 14px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .html-meta {
        display: flex;
        align-items: center;
        gap: 12px;
        font-size: 12px;
        color: rgba(255, 255, 255, 0.6);
      }

      .preview-btn {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 4px 12px;
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 4px;
        color: rgba(255, 255, 255, 0.8);
        cursor: pointer;
        transition: all 0.2s;
        font-size: 12px;
      }

      .preview-btn:hover {
        background: rgba(255, 255, 255, 0.15);
        color: white;
        border-color: rgba(255, 255, 255, 0.3);
      }

      /* Preview Container */
      .html-preview-container {
        width: 100%;
        margin-top: 12px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 6px;
        overflow: hidden;
        background: white;
      }

      .preview-toolbar {
        display: flex;
        gap: 8px;
        padding: 8px;
        background: rgba(0, 0, 0, 0.05);
        border-bottom: 1px solid rgba(0, 0, 0, 0.1);
        justify-content: flex-end;
      }

      .preview-toolbar button {
        padding: 4px 8px;
        background: white;
        border: 1px solid #ddd;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
        transition: all 0.2s;
      }

      .preview-toolbar button:hover {
        background: #f0f0f0;
        border-color: #bbb;
      }

      .html-preview-iframe {
        width: 100%;
        height: 500px;
        border: none;
        display: block;
      }

      /* Grid View Styles */
      .grid-view .html-item-container {
        height: 100%;
        padding: 8px;
      }

      .grid-view .html-thumbnail-section {
        height: 120px;
      }

      .grid-view .html-info-section {
        flex-direction: column;
        align-items: flex-start;
        gap: 4px;
        margin-top: 8px;
      }

      .grid-view .html-title {
        font-size: 12px;
      }

      .grid-view .preview-btn {
        padding: 2px 8px;
        font-size: 11px;
      }
    `;
  },
};

module.exports = { HTMLPreviewSystem, htmlPreviewRenderer };
