/**
 * Thumbnail Pipeline
 *
 * Unified thumbnail generation for all asset types.
 * Consolidates thumbnail generation from various sources:
 * - Images: resize using nativeImage
 * - Videos: ffmpeg frame extraction
 * - PDFs: first page render
 * - HTML: Chrome screenshot
 * - Code/Text: syntax-highlighted preview
 */

const { nativeImage, app } = require('electron');
const fs = require('fs');
const path = require('path');

// Thumbnail configuration
const CONFIG = {
  maxWidth: 400,
  maxHeight: 400,
  quality: 'good',
  jpegQuality: 85,
  pngCompression: 6,
};

class ThumbnailPipeline {
  constructor(options = {}) {
    this.config = { ...CONFIG, ...options };
    this.thumbnailDir = path.join(app.getPath('userData'), 'thumbnails');
    this._ensureDir(this.thumbnailDir);

    // Cache for generated thumbnails
    this.cache = new Map();
    this.maxCacheSize = 100;
  }

  _ensureDir(dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Generate thumbnail for an item
   * @param {Object} item - Item to generate thumbnail for
   * @param {Object} options - Generation options
   * @returns {Promise<string|null>} - Base64 data URL or null
   */
  async generate(item, options = {}) {
    try {
      const type = this._determineType(item);
      console.log(`[ThumbnailPipeline] Generating thumbnail for type: ${type}, item: ${item.id || 'unknown'}`);

      switch (type) {
        case 'image':
          return await this.generateImageThumbnail(item, options);
        case 'image-file':
          return await this.generateImageFileThumbnail(item, options);
        case 'video':
          return await this.generateVideoThumbnail(item, options);
        case 'pdf':
          return await this.generatePDFThumbnail(item, options);
        case 'html':
          return await this.generateHTMLThumbnail(item, options);
        case 'code':
          return await this.generateCodeThumbnail(item, options);
        case 'text':
          return await this.generateTextThumbnail(item, options);
        default:
          return null;
      }
    } catch (error) {
      console.error(`[ThumbnailPipeline] Error generating thumbnail:`, error);
      return null;
    }
  }

  /**
   * Determine content type for thumbnail generation
   */
  _determineType(item) {
    if (item.type === 'image') return 'image';
    if (item.fileType === 'image-file') return 'image-file';
    if (item.type === 'file') {
      if (item.fileType === 'video' || item.fileCategory === 'video') return 'video';
      if (item.fileType === 'pdf' || item.fileExt === '.pdf') return 'pdf';
      if (item.fileCategory === 'code') return 'code';
      if (item.fileType === 'image-file') return 'image-file';
    }
    if (item.type === 'html' || item.html) return 'html';
    if (item.type === 'text') return 'text';
    return 'unknown';
  }

  // ==================== IMAGE THUMBNAIL ====================

  async generateImageThumbnail(item, options = {}) {
    try {
      const imageData = item.content || item.dataUrl;
      if (!imageData) return null;

      // If already small enough, return as-is
      if (imageData.length < 50000) {
        return imageData;
      }

      const image = nativeImage.createFromDataURL(imageData);
      if (image.isEmpty()) {
        console.log('[ThumbnailPipeline] Failed to create image from data URL');
        return imageData; // Return original if can't process
      }

      const size = image.getSize();
      const maxWidth = options.maxWidth || this.config.maxWidth;
      const maxHeight = options.maxHeight || this.config.maxHeight;

      // Calculate new dimensions
      let newWidth = size.width;
      let newHeight = size.height;

      if (size.width > maxWidth || size.height > maxHeight) {
        const ratio = Math.min(maxWidth / size.width, maxHeight / size.height);
        newWidth = Math.round(size.width * ratio);
        newHeight = Math.round(size.height * ratio);
      }

      // Resize
      const resized = image.resize({
        width: newWidth,
        height: newHeight,
        quality: this.config.quality,
      });

      // Convert to JPEG for smaller size
      const buffer = resized.toJPEG(this.config.jpegQuality);
      return `data:image/jpeg;base64,${buffer.toString('base64')}`;
    } catch (error) {
      console.error('[ThumbnailPipeline] Image thumbnail error:', error);
      return item.content || item.dataUrl || null;
    }
  }

  // ==================== IMAGE FILE THUMBNAIL ====================

  async generateImageFileThumbnail(item, options = {}) {
    try {
      // If we have fileData (base64), use it
      if (item.fileData) {
        const mimeType = item.mimeType || 'image/png';
        const dataUrl = `data:${mimeType};base64,${item.fileData}`;
        return await this.generateImageThumbnail({ content: dataUrl }, options);
      }

      // If we have a file path, read it
      if (item.filePath && fs.existsSync(item.filePath)) {
        const buffer = fs.readFileSync(item.filePath);
        const ext = path.extname(item.filePath).toLowerCase();
        const mimeType = this._getMimeType(ext);
        const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
        return await this.generateImageThumbnail({ content: dataUrl }, options);
      }

      return null;
    } catch (error) {
      console.error('[ThumbnailPipeline] Image file thumbnail error:', error);
      return null;
    }
  }

  // ==================== VIDEO THUMBNAIL ====================

  async generateVideoThumbnail(item, options = {}) {
    try {
      // Check if we already have a thumbnail from YouTube or elsewhere
      if (item.thumbnail) {
        return item.thumbnail;
      }

      if (item.metadata?.thumbnail) {
        return item.metadata.thumbnail;
      }

      // Try to use ffmpeg for local files
      const filePath = item.filePath || item.content;
      if (filePath && fs.existsSync(filePath)) {
        return await this._generateVideoThumbnailWithFFmpeg(filePath, options);
      }

      // Generate placeholder for videos without thumbnail
      return this._generatePlaceholder('video', item.fileName || 'Video');
    } catch (error) {
      console.error('[ThumbnailPipeline] Video thumbnail error:', error);
      return this._generatePlaceholder('video', item.fileName || 'Video');
    }
  }

  async _generateVideoThumbnailWithFFmpeg(videoPath, _options = {}) {
    try {
      const ffmpeg = require('fluent-ffmpeg');
      const os = require('os');

      const outputPath = path.join(os.tmpdir(), `thumb-${Date.now()}.jpg`);

      return new Promise((resolve, _reject) => {
        ffmpeg(videoPath)
          .screenshots({
            timestamps: ['10%'],
            filename: path.basename(outputPath),
            folder: path.dirname(outputPath),
            size: `${this.config.maxWidth}x?`,
          })
          .on('end', () => {
            if (fs.existsSync(outputPath)) {
              const buffer = fs.readFileSync(outputPath);
              const dataUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`;
              fs.unlinkSync(outputPath);
              resolve(dataUrl);
            } else {
              resolve(null);
            }
          })
          .on('error', (err) => {
            console.error('[ThumbnailPipeline] FFmpeg error:', err);
            resolve(null);
          });
      });
    } catch (error) {
      console.error('[ThumbnailPipeline] FFmpeg not available:', error);
      return null;
    }
  }

  // ==================== PDF THUMBNAIL ====================

  async generatePDFThumbnail(item, _options = {}) {
    try {
      // Generate SVG placeholder for PDF
      const fileName = item.fileName || 'Document';
      const fileSize = item.fileSize ? this._formatBytes(item.fileSize) : '';

      return this._generatePDFPlaceholder(fileName, fileSize);
    } catch (error) {
      console.error('[ThumbnailPipeline] PDF thumbnail error:', error);
      return this._generatePlaceholder('pdf', item.fileName || 'PDF');
    }
  }

  _generatePDFPlaceholder(fileName, fileSize) {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="200" height="260" viewBox="0 0 200 260">
        <defs>
          <linearGradient id="pdfGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:#dc3545;stop-opacity:1" />
            <stop offset="100%" style="stop-color:#a71d2a;stop-opacity:1" />
          </linearGradient>
        </defs>
        <rect width="200" height="260" fill="#1a1a2e" rx="8"/>
        <rect x="40" y="30" width="120" height="160" fill="url(#pdfGrad)" rx="4"/>
        <text x="100" y="120" fill="white" font-family="Arial, sans-serif" font-size="24" font-weight="bold" text-anchor="middle">PDF</text>
        <text x="100" y="220" fill="#888" font-family="Arial, sans-serif" font-size="11" text-anchor="middle">${this._escapeXml(fileName.substring(0, 25))}</text>
        <text x="100" y="240" fill="#666" font-family="Arial, sans-serif" font-size="10" text-anchor="middle">${fileSize}</text>
      </svg>
    `;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  }

  // ==================== HTML THUMBNAIL ====================

  async generateHTMLThumbnail(item, _options = {}) {
    try {
      // Use Chrome for HTML screenshots if available
      const HTMLPreviewSystem = require('./html-preview-system');
      const previewSystem = new HTMLPreviewSystem();

      const thumbnail = await previewSystem.generateHTMLThumbnail(item);
      if (thumbnail) {
        return thumbnail;
      }

      // Fallback to placeholder
      return this._generateHTMLPlaceholder(item.preview || 'HTML Document');
    } catch (error) {
      console.error('[ThumbnailPipeline] HTML thumbnail error:', error);
      return this._generateHTMLPlaceholder(item.preview || 'HTML Document');
    }
  }

  _generateHTMLPlaceholder(title) {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="200" height="150" viewBox="0 0 200 150">
        <defs>
          <linearGradient id="htmlGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:#e34c26;stop-opacity:1" />
            <stop offset="100%" style="stop-color:#f06529;stop-opacity:1" />
          </linearGradient>
        </defs>
        <rect width="200" height="150" fill="#1a1a2e" rx="8"/>
        <text x="100" y="60" fill="url(#htmlGrad)" font-family="Arial, sans-serif" font-size="28" font-weight="bold" text-anchor="middle">&lt;/&gt;</text>
        <text x="100" y="90" fill="#888" font-family="Arial, sans-serif" font-size="12" text-anchor="middle">HTML</text>
        <text x="100" y="130" fill="#666" font-family="Arial, sans-serif" font-size="10" text-anchor="middle">${this._escapeXml(title.substring(0, 30))}</text>
      </svg>
    `;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  }

  // ==================== CODE THUMBNAIL ====================

  async generateCodeThumbnail(item, _options = {}) {
    try {
      const ext = item.fileExt || '.txt';
      const language = this._getLanguageFromExt(ext);
      const preview = this._getCodePreview(item.content, 10);

      return this._generateCodePlaceholder(language, item.fileName || 'Code', preview);
    } catch (error) {
      console.error('[ThumbnailPipeline] Code thumbnail error:', error);
      return this._generatePlaceholder('code', item.fileName || 'Code');
    }
  }

  _generateCodePlaceholder(language, fileName, preview) {
    const langColors = {
      javascript: '#f7df1e',
      typescript: '#3178c6',
      python: '#3776ab',
      java: '#b07219',
      cpp: '#f34b7d',
      go: '#00add8',
      rust: '#dea584',
      ruby: '#cc342d',
      php: '#4f5d95',
      default: '#6e7681',
    };

    const color = langColors[language] || langColors.default;

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="200" height="150" viewBox="0 0 200 150">
        <rect width="200" height="150" fill="#0d1117" rx="8"/>
        <rect x="10" y="10" width="180" height="20" fill="#161b22" rx="4"/>
        <circle cx="25" cy="20" r="5" fill="#ff5f56"/>
        <circle cx="40" cy="20" r="5" fill="#ffbd2e"/>
        <circle cx="55" cy="20" r="5" fill="#27ca40"/>
        <text x="180" y="24" fill="${color}" font-family="monospace" font-size="10" text-anchor="end">${language.toUpperCase()}</text>
        <text x="15" y="55" fill="#8b949e" font-family="monospace" font-size="9">
          <tspan x="15" dy="0">${this._escapeXml(preview[0] || '')}</tspan>
          <tspan x="15" dy="12">${this._escapeXml(preview[1] || '')}</tspan>
          <tspan x="15" dy="12">${this._escapeXml(preview[2] || '')}</tspan>
          <tspan x="15" dy="12">${this._escapeXml(preview[3] || '')}</tspan>
        </text>
        <text x="100" y="140" fill="#666" font-family="Arial, sans-serif" font-size="9" text-anchor="middle">${this._escapeXml(fileName.substring(0, 25))}</text>
      </svg>
    `;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  }

  _getCodePreview(content, lines = 5) {
    if (!content) return [];
    const allLines = content.split('\n').slice(0, lines);
    return allLines.map((line) => line.substring(0, 35));
  }

  _getLanguageFromExt(ext) {
    const languages = {
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.py': 'python',
      '.java': 'java',
      '.cpp': 'cpp',
      '.c': 'cpp',
      '.h': 'cpp',
      '.go': 'go',
      '.rs': 'rust',
      '.rb': 'ruby',
      '.php': 'php',
      '.swift': 'swift',
      '.kt': 'kotlin',
    };
    return languages[ext?.toLowerCase()] || 'code';
  }

  // ==================== TEXT THUMBNAIL ====================

  async generateTextThumbnail(item, _options = {}) {
    try {
      const content = item.content || item.text || '';
      const preview = content.substring(0, 200).split('\n').slice(0, 5);

      return this._generateTextPlaceholder(item.fileName || 'Text', preview);
    } catch (error) {
      console.error('[ThumbnailPipeline] Text thumbnail error:', error);
      return this._generatePlaceholder('text', item.fileName || 'Text');
    }
  }

  _generateTextPlaceholder(fileName, preview) {
    const lines = Array.isArray(preview) ? preview : [preview];

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="200" height="150" viewBox="0 0 200 150">
        <rect width="200" height="150" fill="#1a1a2e" rx="8"/>
        <rect x="10" y="10" width="180" height="100" fill="#16213e" rx="4"/>
        <text x="20" y="35" fill="#94a3b8" font-family="Georgia, serif" font-size="10">
          <tspan x="20" dy="0">${this._escapeXml((lines[0] || '').substring(0, 40))}</tspan>
          <tspan x="20" dy="14">${this._escapeXml((lines[1] || '').substring(0, 40))}</tspan>
          <tspan x="20" dy="14">${this._escapeXml((lines[2] || '').substring(0, 40))}</tspan>
          <tspan x="20" dy="14">${this._escapeXml((lines[3] || '').substring(0, 40))}</tspan>
        </text>
        <text x="100" y="135" fill="#666" font-family="Arial, sans-serif" font-size="10" text-anchor="middle">${this._escapeXml(fileName.substring(0, 25))}</text>
      </svg>
    `;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  }

  // ==================== GENERIC PLACEHOLDER ====================

  _generatePlaceholder(type, name) {
    const icons = {
      video: '🎬',
      audio: '🎵',
      pdf: '📄',
      code: '💻',
      text: '📝',
      file: '📁',
      unknown: '📎',
    };

    const icon = icons[type] || icons.unknown;

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="200" height="150" viewBox="0 0 200 150">
        <rect width="200" height="150" fill="#1a1a2e" rx="8"/>
        <text x="100" y="70" fill="#888" font-size="40" text-anchor="middle">${icon}</text>
        <text x="100" y="110" fill="#666" font-family="Arial, sans-serif" font-size="12" text-anchor="middle">${type.toUpperCase()}</text>
        <text x="100" y="130" fill="#555" font-family="Arial, sans-serif" font-size="10" text-anchor="middle">${this._escapeXml(name.substring(0, 25))}</text>
      </svg>
    `;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  }

  // ==================== UTILITY METHODS ====================

  _getMimeType(ext) {
    const mimeTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
    };
    return mimeTypes[ext?.toLowerCase()] || 'image/png';
  }

  _formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  _escapeXml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Clear thumbnail cache
   */
  clearCache() {
    this.cache.clear();
  }
}

// Singleton instance
let instance = null;

function getThumbnailPipeline(options) {
  if (!instance) {
    instance = new ThumbnailPipeline(options);
  }
  return instance;
}

function resetThumbnailPipeline() {
  instance = null;
}

module.exports = {
  ThumbnailPipeline,
  getThumbnailPipeline,
  resetThumbnailPipeline,
  CONFIG,
};
