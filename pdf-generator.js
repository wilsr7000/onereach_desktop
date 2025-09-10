const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');

class PDFGenerator {
  constructor() {
    this.browser = null;
    this.styleGuideCSS = this.loadStyleGuideCSS();
  }
  
  loadStyleGuideCSS() {
    try {
      const cssPath = path.join(__dirname, 'smart-export-styles.css');
      return fsSync.readFileSync(cssPath, 'utf8');
    } catch (error) {
      console.error('Error loading style guide CSS:', error);
      // Return the existing hardcoded CSS as fallback
      return this.getFallbackStyles();
    }
  }

  async initialize() {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
    }
  }

  async generateSpacePDF(space, items, options = {}) {
    await this.initialize();
    
    const {
      outputPath,
      includeMetadata = true,
      includeTimestamps = true,
      includeTags = true,
      pageSize = 'A4',
      margin = { top: '20mm', right: '20mm', bottom: '20mm', left: '20mm' }
    } = options;

    const page = await this.browser.newPage();
    
    try {
      // Generate HTML content for the space with embedded styles
      const htmlContent = this.generateSpaceHTML(space, items, {
        includeMetadata,
        includeTimestamps,
        includeTags,
        embedStyles: true  // Add flag to embed styles
      });

      // Set the HTML content
      await page.setContent(htmlContent, { waitUntil: 'networkidle' });

      // Generate PDF
      const pdfBuffer = await page.pdf({
        path: outputPath,
        format: pageSize,
        margin,
        printBackground: true,
        preferCSSPageSize: false
      });

      return {
        success: true,
        path: outputPath,
        buffer: pdfBuffer,
        pageCount: await this.estimatePageCount(pdfBuffer)
      };
    } catch (error) {
      console.error('Error generating PDF:', error);
      return {
        success: false,
        error: error.message
      };
    } finally {
      await page.close();
    }
  }

  getFallbackStyles() {
    // Return fallback CSS if the file can't be loaded
    return `
      /* Smart Export Style Guide - Based on Journey Map Design */

      :root {
        /* Color Palette */
        --bg-primary: #F5F2ED; /* Warm beige/cream background */
        --text-primary: #2C2C2C; /* Dark charcoal for main text */
        --text-secondary: #5A5A5A; /* Medium gray for secondary text */
        --accent-line: #D4D4D4; /* Light gray for lines and borders */
        --accent-dot: #8B8B8B; /* Medium gray for dots and markers */
        
        /* Typography */
        --font-serif: 'Crimson Text', 'Georgia', 'Times New Roman', serif;
        --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        --font-mono: 'Courier New', Courier, monospace;
        
        /* Spacing */
        --spacing-xs: 0.25rem;
        --spacing-sm: 0.5rem;
        --spacing-md: 1rem;
        --spacing-lg: 2rem;
        --spacing-xl: 3rem;
        --spacing-xxl: 4rem;
        
        /* Font Sizes */
        --text-xs: 0.75rem;
        --text-sm: 0.875rem;
        --text-base: 1rem;
        --text-lg: 1.125rem;
        --text-xl: 1.5rem;
        --text-2xl: 2rem;
        --text-3xl: 2.5rem;
        --text-4xl: 3rem;
      }

      /* Base Document Styles */
      .smart-export-document {
        background-color: var(--bg-primary);
        color: var(--text-primary);
        font-family: var(--font-serif);
        line-height: 1.6;
        padding: var(--spacing-xxl);
        max-width: 1200px;
        margin: 0 auto;
        min-height: 100vh;
      }

      /* Header Styles */
      .document-header {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        margin-bottom: var(--spacing-xxl);
        padding-bottom: var(--spacing-lg);
        border-bottom: 1px solid var(--accent-line);
      }

      .document-title {
        font-family: var(--font-serif);
        font-size: var(--text-4xl);
        font-weight: 400;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        margin: 0;
      }

      .document-meta {
        text-align: right;
        font-family: var(--font-serif);
        font-size: var(--text-lg);
      }

      .document-date {
        display: block;
        margin-bottom: var(--spacing-xs);
      }

      .document-context {
        display: block;
        font-style: italic;
      }

      /* Section Headers */
      .section-header {
        font-family: var(--font-serif);
        font-size: var(--text-xl);
        font-weight: 400;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        margin-top: var(--spacing-xl);
        margin-bottom: var(--spacing-lg);
        position: relative;
      }

      .section-header::after {
        content: '';
        position: absolute;
        bottom: -8px;
        left: 0;
        width: 60px;
        height: 1px;
        background-color: var(--accent-line);
      }

      /* Body Text */
      .body-text {
        font-family: var(--font-serif);
        font-size: var(--text-base);
        line-height: 1.8;
        margin-bottom: var(--spacing-md);
        color: var(--text-primary);
      }

      .emphasized-text {
        font-style: italic;
        font-size: var(--text-lg);
        margin: var(--spacing-lg) 0;
        color: var(--text-secondary);
      }

      /* Card/Box Styles */
      .content-card {
        background-color: transparent;
        border: 1px solid var(--accent-line);
        padding: var(--spacing-lg);
        margin-bottom: var(--spacing-lg);
        position: relative;
      }

      .card-title {
        font-family: var(--font-serif);
        font-size: var(--text-lg);
        font-weight: 400;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: var(--spacing-md);
      }

      /* List Styles */
      .styled-list {
        list-style: none;
        padding: 0;
        margin: var(--spacing-md) 0;
      }

      .styled-list li {
        position: relative;
        padding-left: var(--spacing-lg);
        margin-bottom: var(--spacing-sm);
        font-family: var(--font-serif);
        line-height: 1.8;
      }

      .styled-list li::before {
        content: '•';
        position: absolute;
        left: 0;
        color: var(--accent-dot);
      }

      /* Navigation */
      .document-navigation {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-top: var(--spacing-xxl);
        padding-top: var(--spacing-lg);
        border-top: 1px solid var(--accent-line);
      }

      .page-indicator {
        font-family: var(--font-serif);
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }

      /* Quote/Callout Styles */
      .quote-block {
        margin: var(--spacing-xl) var(--spacing-lg);
        padding-left: var(--spacing-lg);
        border-left: 2px solid var(--accent-line);
        font-style: italic;
        font-size: var(--text-lg);
        line-height: 1.8;
        color: var(--text-secondary);
      }

      /* Table Styles */
      .styled-table {
        width: 100%;
        border-collapse: collapse;
        margin: var(--spacing-lg) 0;
        font-family: var(--font-serif);
      }

      .styled-table th {
        text-align: left;
        padding: var(--spacing-md);
        border-bottom: 2px solid var(--accent-line);
        font-weight: 400;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-size: var(--text-sm);
      }

      .styled-table td {
        padding: var(--spacing-md);
        border-bottom: 1px solid var(--accent-line);
      }

      /* Custom Elements for Smart Export */
      .insight-card {
        background-color: transparent;
        border: 1px solid var(--accent-line);
        padding: var(--spacing-lg);
        margin-bottom: var(--spacing-lg);
        border-radius: 0;
      }

      .metric-display {
        font-family: var(--font-mono);
        font-size: var(--text-3xl);
        color: var(--text-primary);
        text-align: center;
        margin: var(--spacing-lg) 0;
      }

      .metric-label {
        font-family: var(--font-serif);
        font-size: var(--text-sm);
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: var(--text-secondary);
        text-align: center;
        margin-top: var(--spacing-sm);
      }

      /* Utility Classes */
      .text-center { text-align: center; }
      .text-right { text-align: right; }
      .text-muted { color: var(--text-secondary); }
      .mt-sm { margin-top: var(--spacing-sm); }
      .mt-md { margin-top: var(--spacing-md); }
      .mt-lg { margin-top: var(--spacing-lg); }
      .mt-xl { margin-top: var(--spacing-xl); }
      .mb-sm { margin-bottom: var(--spacing-sm); }
      .mb-md { margin-bottom: var(--spacing-md); }
      .mb-lg { margin-bottom: var(--spacing-lg); }
      .mb-xl { margin-bottom: var(--spacing-xl); }

      /* Print Styles */
      @media print {
        .smart-export-document {
          background-color: white;
          padding: 2cm;
        }
        
        .document-navigation {
          display: none;
        }
        
        .page-break {
          page-break-after: always;
        }
      }

      /* Responsive Design */
      @media (max-width: 768px) {
        .smart-export-document {
          padding: var(--spacing-lg);
        }
        
        .document-header {
          flex-direction: column;
          align-items: flex-start;
        }
        
        .document-meta {
          text-align: left;
          margin-top: var(--spacing-md);
        }
        
        .document-title {
          font-size: var(--text-2xl);
        }
      }
    `;
  }

  generateSpaceHTML(space, items, options) {
    const { includeMetadata, includeTimestamps, includeTags, embedStyles = false } = options;
    
    console.log('[PDFGenerator] Generating HTML for space:', space);
    console.log('[PDFGenerator] Number of items:', items.length);
    if (items.length > 0) {
      console.log('[PDFGenerator] First item sample:', items[0]);
    }
    
    // Use embedded styles if requested (for PDF/export) or link to external CSS (for preview)
    const stylesSection = embedStyles ? 
      `<style>${this.styleGuideCSS}</style>` : 
      '<link rel="stylesheet" href="smart-export-styles.css">';
    
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${space.name} - Space Export</title>
  
  <!-- Google Fonts for Journey Map style -->
  <link href="https://fonts.googleapis.com/css2?family=Crimson+Text:ital,wght@0,400;0,600;1,400;1,600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  
  <!-- Smart Export Styles -->
  ${stylesSection}
  
  <style>
    /* Additional print-specific styles */
    @media print {
      .smart-export-document {
        padding: 20mm;
      }
      
      .item {
        page-break-inside: avoid;
      }
    }
  </style>
</head>
<body>
  <div class="smart-export-document">
    <header class="document-header">
      <h1 class="document-title">${this.escapeHtml(space.name)}</h1>
      <div class="document-meta">
        <span class="document-date">${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
        <span class="document-context">Context: ${items.length} items exported</span>
      </div>
    </header>
    
    ${this.generateNotebookHTML(space)}
    
    <section>
      <h2 class="section-header">Items</h2>
      ${items.map(item => this.generateItemHTML(item, { includeMetadata, includeTimestamps, includeTags })).join('')}
    </section>
    
    <div class="document-navigation">
      <span class="page-indicator">Generated from Onereach.ai</span>
    </div>
  </div>
</body>
</html>
    `;
  }

  generateNotebookHTML(space) {
    if (!space.notebook) return '';
    
    const { description, objective, instructions, tags, links } = space.notebook;
    
    if (!description && !objective && !instructions) return '';
    
    return `
      <section class="content-card mb-xl">
        <h2 class="section-header">Space Notebook</h2>
        ${description ? `
          <div class="mb-md">
            <h3 class="card-title">Description</h3>
            <p class="body-text">${this.escapeHtml(description)}</p>
          </div>
        ` : ''}
        ${objective ? `
          <div class="mb-md">
            <h3 class="card-title">Objective</h3>
            <p class="body-text">${this.escapeHtml(objective)}</p>
          </div>
        ` : ''}
        ${instructions ? `
          <div class="mb-md">
            <h3 class="card-title">Instructions</h3>
            <p class="body-text">${this.escapeHtml(instructions)}</p>
          </div>
        ` : ''}
        ${tags && tags.length > 0 ? `
          <div class="mb-md">
            <h3 class="card-title">Tags</h3>
            <ul class="styled-list">
              ${tags.map(tag => `<li>${this.escapeHtml(tag)}</li>`).join('')}
            </ul>
          </div>
        ` : ''}
        ${links && links.length > 0 ? `
          <div>
            <h3 class="card-title">Related Links</h3>
            <ul class="styled-list">
              ${links.map(link => `<li><a href="${this.escapeHtml(link)}">${this.escapeHtml(link)}</a></li>`).join('')}
            </ul>
          </div>
        ` : ''}
      </section>
    `;
  }

  generateItemHTML(item, options) {
    const { includeMetadata, includeTimestamps, includeTags } = options;
    
    // Determine the appropriate card class based on item type
    const cardClass = item.type === 'insight' || item.type === 'summary' ? 'insight-card' : 'content-card';
    
    return `
      <div class="${cardClass}">
        <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: var(--spacing-md);">
          <span class="text-muted" style="font-size: var(--text-sm); text-transform: uppercase; letter-spacing: 0.05em;">${item.type}</span>
          ${includeTimestamps ? `<span class="text-muted" style="font-size: var(--text-sm);">${new Date(item.timestamp).toLocaleString()}</span>` : ''}
        </div>
        <div class="mb-md">
          ${this.generateItemContent(item)}
        </div>
        ${includeMetadata && (item.metadata || item.tags) ? `
          <div style="border-top: 1px solid var(--accent-line); padding-top: var(--spacing-md);">
            ${item.metadata?.description ? `<p class="body-text text-muted mb-sm"><strong>Description:</strong> ${this.escapeHtml(item.metadata.description)}</p>` : ''}
            ${item.metadata?.notes ? `<p class="body-text text-muted mb-sm"><strong>Notes:</strong> ${this.escapeHtml(item.metadata.notes)}</p>` : ''}
            ${includeTags && item.tags && item.tags.length > 0 ? `
              <div style="margin-top: var(--spacing-sm);">
                ${item.tags.map(tag => `<span style="display: inline-block; padding: 2px 8px; margin-right: 5px; background: var(--accent-line); color: var(--text-secondary); border-radius: 12px; font-size: var(--text-xs);">${this.escapeHtml(tag)}</span>`).join('')}
              </div>
            ` : ''}
          </div>
        ` : ''}
      </div>
    `;
  }

  generateItemContent(item) {
    switch (item.type) {
      case 'text':
        return `<div class="body-text">${this.escapeHtml(item.content)}</div>`;
      
      case 'html':
        return `<div class="body-text">${this.escapeHtml(item.plainText || item.content)}</div>`;
      
      case 'image':
        // Check for image data in various possible locations
        const imageData = item.dataUrl || item.content || item.thumbnail;
        if (imageData && imageData.startsWith('data:image')) {
          return `<img src="${imageData}" style="max-width: 100%; height: auto; border-radius: 4px;" alt="${this.escapeHtml(item.fileName || 'Image')}">`;
        }
        return `<div class="body-text text-muted" style="font-family: var(--font-mono);">Image: ${this.escapeHtml(item.fileName || 'Unnamed image')}</div>`;
      
      case 'file':
        return `<div class="body-text text-muted" style="font-family: var(--font-mono);">File: ${this.escapeHtml(item.fileName)} (${this.formatFileSize(item.fileSize)})</div>`;
      
      default:
        return `<div class="body-text text-muted">Unknown content type</div>`;
    }
  }

  escapeHtml(text) {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  formatFileSize(bytes) {
    if (!bytes) return 'Unknown size';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
  }

  async estimatePageCount(pdfBuffer) {
    // Simple estimation based on buffer size
    // This is a rough estimate and may not be accurate
    const avgBytesPerPage = 50000; // Rough estimate
    return Math.max(1, Math.ceil(pdfBuffer.length / avgBytesPerPage));
  }

  async cleanup() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
  
  /**
   * Generate PDF from HTML string
   * @param {string} html - The HTML content
   * @param {string} outputPath - The output file path
   * @returns {Promise<void>}
   */
  async generatePDFFromHTML(html, outputPath) {
    if (!this.browser) {
      await this.initialize();
    }
    
    const page = await this.browser.newPage();
    
    try {
      // Set content
      await page.setContent(html, {
        waitUntil: 'networkidle'
      });
      
      // Wait a bit for any dynamic content
      await page.waitForTimeout(1000);
      
      // Generate PDF with proper settings
      await page.pdf({
        path: outputPath,
        format: 'A4',
        margin: {
          top: '1in',
          right: '1in',
          bottom: '1in',
          left: '1in'
        },
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: `
          <div style="font-size: 10px; width: 100%; text-align: center; color: #666;">
            <span class="title"></span>
          </div>
        `,
        footerTemplate: `
          <div style="font-size: 10px; width: 100%; text-align: center; color: #666;">
            Page <span class="pageNumber"></span> of <span class="totalPages"></span>
          </div>
        `
      });
      
      console.log('PDF generated from HTML:', outputPath);
    } finally {
      await page.close();
    }
  }
}

module.exports = PDFGenerator; 