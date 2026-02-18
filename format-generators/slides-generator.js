/**
 * Web Slides Generator
 * Creates interactive HTML-based presentations (like reveal.js)
 */

class SlidesGenerator {
  constructor() {
    this.defaultOptions = {
      theme: 'dark',
      transition: 'slide',
      includeImages: true,
      autoSlide: false,
      showProgress: true,
      showSlideNumber: true,
    };
  }

  /**
   * Generate web slides from space data
   * @param {Object} space - Space metadata
   * @param {Array} items - Space items
   * @param {Object} options - Generation options
   * @returns {Promise<Object>} Result with HTML content
   */
  async generate(space, items, options = {}) {
    const opts = { ...this.defaultOptions, ...options };

    try {
      // Group items into slides
      const slides = this.createSlides(space, items, opts);

      // Generate HTML
      const html = this.generateHTML(space, slides, opts);

      return {
        success: true,
        content: html,
        buffer: Buffer.from(html, 'utf-8'),
        mimeType: 'text/html',
        extension: 'html',
        filename: `${this.sanitizeFilename(space.name)}_slides.html`,
      };
    } catch (error) {
      console.error('[SlidesGenerator] Error generating slides:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Create slides from items
   */
  createSlides(space, items, _options) {
    const slides = [];

    // Title slide
    slides.push({
      type: 'title',
      title: space.name,
      subtitle: space.description || `${items.length} items collected`,
      date: new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
    });

    // Table of contents slide
    const typeGroups = this.groupItemsByType(items);
    slides.push({
      type: 'toc',
      title: 'Contents',
      items: Object.entries(typeGroups).map(([type, items]) => ({
        name: this.formatTypeName(type),
        count: items.length,
      })),
    });

    // Content slides
    for (const [type, typeItems] of Object.entries(typeGroups)) {
      // Section divider
      slides.push({
        type: 'section',
        title: this.formatTypeName(type),
        count: typeItems.length,
      });

      // Individual content slides
      const maxItemsPerSlide = type === 'image' ? 1 : 4;
      for (let i = 0; i < typeItems.length; i += maxItemsPerSlide) {
        const slideItems = typeItems.slice(i, i + maxItemsPerSlide);
        slides.push({
          type: 'content',
          contentType: type,
          items: slideItems,
        });
      }
    }

    // Closing slide
    slides.push({
      type: 'closing',
      title: 'Thank You',
      subtitle: `Generated from "${space.name}"`,
      footer: `${items.length} items • Onereach.ai Smart Export`,
    });

    return slides;
  }

  /**
   * Generate HTML for slides presentation
   */
  generateHTML(space, slides, options) {
    const { theme, showProgress, showSlideNumber, autoSlide } = options;

    const isDark = theme === 'dark';
    const bgColor = isDark ? '#0f0f0f' : '#ffffff';
    const textColor = isDark ? '#fafafa' : '#1a1a1a';
    const accentColor = '#6366f1';
    const mutedColor = isDark ? '#888888' : '#666666';

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${this.escapeHtml(space.name)} - Presentation</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <style>
        *, *::before, *::after {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        :root {
            --bg: ${bgColor};
            --text: ${textColor};
            --accent: ${accentColor};
            --muted: ${mutedColor};
            --slide-width: 100vw;
            --slide-height: 100vh;
        }

        html, body {
            width: 100%;
            height: 100%;
            overflow: hidden;
            font-family: 'DM Sans', -apple-system, sans-serif;
            background: var(--bg);
            color: var(--text);
        }

        .presentation {
            width: 100%;
            height: 100%;
            position: relative;
        }

        .slides-container {
            width: 100%;
            height: 100%;
            overflow: hidden;
            position: relative;
        }

        .slide {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            padding: 60px;
            opacity: 0;
            transform: translateX(100%);
            transition: all 0.5s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .slide.active {
            opacity: 1;
            transform: translateX(0);
        }

        .slide.prev {
            transform: translateX(-100%);
        }

        /* Title slide */
        .slide-title h1 {
            font-size: clamp(2.5rem, 6vw, 5rem);
            font-weight: 700;
            text-align: center;
            margin-bottom: 24px;
            background: linear-gradient(135deg, var(--accent) 0%, #a855f7 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }

        .slide-title .subtitle {
            font-size: clamp(1rem, 2vw, 1.5rem);
            color: var(--muted);
            text-align: center;
            max-width: 600px;
        }

        .slide-title .date {
            position: absolute;
            bottom: 60px;
            font-size: 0.875rem;
            color: var(--muted);
        }

        /* TOC slide */
        .slide-toc h2 {
            font-size: 2.5rem;
            margin-bottom: 40px;
            color: var(--accent);
        }

        .toc-list {
            list-style: none;
            display: flex;
            flex-direction: column;
            gap: 16px;
        }

        .toc-item {
            display: flex;
            align-items: center;
            gap: 16px;
            font-size: 1.25rem;
        }

        .toc-bullet {
            width: 12px;
            height: 12px;
            background: var(--accent);
            border-radius: 50%;
        }

        .toc-count {
            color: var(--muted);
            font-size: 0.875rem;
            margin-left: 8px;
        }

        /* Section slide */
        .slide-section {
            background: linear-gradient(135deg, var(--accent) 0%, #a855f7 100%);
        }

        .slide-section h2 {
            font-size: clamp(2rem, 5vw, 4rem);
            color: white;
            text-align: center;
        }

        .slide-section .count {
            font-size: 1.25rem;
            color: rgba(255,255,255,0.7);
            margin-top: 16px;
        }

        /* Content slide */
        .slide-content {
            align-items: flex-start;
            padding: 80px;
        }

        .content-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 24px;
            width: 100%;
            max-width: 1200px;
        }

        .content-item {
            background: ${isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)'};
            border-radius: 12px;
            padding: 24px;
            border: 1px solid ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'};
        }

        .content-item h3 {
            font-size: 1rem;
            font-weight: 600;
            margin-bottom: 12px;
            color: var(--accent);
        }

        .content-item p {
            font-size: 0.9rem;
            line-height: 1.6;
            color: var(--muted);
        }

        .content-item.image-item {
            text-align: center;
        }

        .content-item img {
            max-width: 100%;
            max-height: 60vh;
            border-radius: 8px;
            object-fit: contain;
        }

        .content-item .caption {
            font-size: 0.75rem;
            color: var(--muted);
            margin-top: 12px;
        }

        /* Closing slide */
        .slide-closing h2 {
            font-size: 3rem;
            margin-bottom: 24px;
        }

        .slide-closing .subtitle {
            color: var(--muted);
            font-size: 1.25rem;
        }

        .slide-closing .footer {
            position: absolute;
            bottom: 60px;
            font-size: 0.75rem;
            color: var(--muted);
        }

        /* Navigation */
        .nav-controls {
            position: fixed;
            bottom: 20px;
            left: 50%;
            transform: translateX(-50%);
            display: flex;
            gap: 12px;
            z-index: 100;
        }

        .nav-btn {
            width: 48px;
            height: 48px;
            border: none;
            background: ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'};
            color: var(--text);
            border-radius: 50%;
            cursor: pointer;
            font-size: 1.25rem;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s;
        }

        .nav-btn:hover {
            background: var(--accent);
            color: white;
        }

        .nav-btn:disabled {
            opacity: 0.3;
            cursor: not-allowed;
        }

        /* Progress bar */
        ${
          showProgress
            ? `
        .progress-bar {
            position: fixed;
            top: 0;
            left: 0;
            height: 3px;
            background: var(--accent);
            transition: width 0.3s ease;
            z-index: 100;
        }
        `
            : ''
        }

        /* Slide number */
        ${
          showSlideNumber
            ? `
        .slide-number {
            position: fixed;
            bottom: 20px;
            right: 20px;
            font-size: 0.875rem;
            color: var(--muted);
            font-family: 'JetBrains Mono', monospace;
        }
        `
            : ''
        }

        /* Keyboard hints */
        .keyboard-hint {
            position: fixed;
            bottom: 20px;
            left: 20px;
            font-size: 0.75rem;
            color: var(--muted);
            opacity: 0.5;
        }

        @media (max-width: 768px) {
            .slide {
                padding: 40px 24px;
            }
            
            .slide-content {
                padding: 60px 24px;
            }

            .nav-controls {
                bottom: 10px;
            }
        }
    </style>
</head>
<body>
    <div class="presentation">
        ${showProgress ? '<div class="progress-bar" id="progressBar"></div>' : ''}
        
        <div class="slides-container" id="slidesContainer">
            ${slides.map((slide, i) => this.renderSlide(slide, i)).join('\n')}
        </div>

        <div class="nav-controls">
            <button class="nav-btn" id="prevBtn" onclick="prevSlide()">←</button>
            <button class="nav-btn" id="nextBtn" onclick="nextSlide()">→</button>
        </div>

        ${showSlideNumber ? '<div class="slide-number" id="slideNumber">1 / ' + slides.length + '</div>' : ''}
        <div class="keyboard-hint">Use ← → keys to navigate</div>
    </div>

    <script>
        let currentSlide = 0;
        const totalSlides = ${slides.length};
        const slides = document.querySelectorAll('.slide');
        const progressBar = document.getElementById('progressBar');
        const slideNumber = document.getElementById('slideNumber');
        const prevBtn = document.getElementById('prevBtn');
        const nextBtn = document.getElementById('nextBtn');

        function updateSlide() {
            slides.forEach((slide, i) => {
                slide.classList.remove('active', 'prev');
                if (i === currentSlide) {
                    slide.classList.add('active');
                } else if (i < currentSlide) {
                    slide.classList.add('prev');
                }
            });

            ${
              showProgress
                ? `
            const progress = ((currentSlide + 1) / totalSlides) * 100;
            progressBar.style.width = progress + '%';
            `
                : ''
            }

            ${
              showSlideNumber
                ? `
            slideNumber.textContent = (currentSlide + 1) + ' / ' + totalSlides;
            `
                : ''
            }

            prevBtn.disabled = currentSlide === 0;
            nextBtn.disabled = currentSlide === totalSlides - 1;
        }

        function nextSlide() {
            if (currentSlide < totalSlides - 1) {
                currentSlide++;
                updateSlide();
            }
        }

        function prevSlide() {
            if (currentSlide > 0) {
                currentSlide--;
                updateSlide();
            }
        }

        // Keyboard navigation
        document.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter') {
                nextSlide();
            } else if (e.key === 'ArrowLeft' || e.key === 'Backspace') {
                prevSlide();
            } else if (e.key === 'Home') {
                currentSlide = 0;
                updateSlide();
            } else if (e.key === 'End') {
                currentSlide = totalSlides - 1;
                updateSlide();
            }
        });

        // Touch/swipe support
        let touchStartX = 0;
        document.addEventListener('touchstart', (e) => {
            touchStartX = e.touches[0].clientX;
        });

        document.addEventListener('touchend', (e) => {
            const touchEndX = e.changedTouches[0].clientX;
            const diff = touchStartX - touchEndX;
            if (Math.abs(diff) > 50) {
                if (diff > 0) nextSlide();
                else prevSlide();
            }
        });

        // Initialize
        updateSlide();

        ${
          autoSlide
            ? `
        // Auto-advance slides
        setInterval(() => {
            if (currentSlide < totalSlides - 1) {
                nextSlide();
            }
        }, 5000);
        `
            : ''
        }
    </script>
</body>
</html>`;
  }

  /**
   * Render a single slide
   */
  renderSlide(slide, index) {
    switch (slide.type) {
      case 'title':
        return `
          <div class="slide slide-title ${index === 0 ? 'active' : ''}">
            <h1>${this.escapeHtml(slide.title)}</h1>
            <p class="subtitle">${this.escapeHtml(slide.subtitle)}</p>
            <span class="date">${this.escapeHtml(slide.date)}</span>
          </div>`;

      case 'toc':
        return `
          <div class="slide slide-toc">
            <h2>${this.escapeHtml(slide.title)}</h2>
            <ul class="toc-list">
              ${slide.items
                .map(
                  (item) => `
                <li class="toc-item">
                  <span class="toc-bullet"></span>
                  ${this.escapeHtml(item.name)}
                  <span class="toc-count">(${item.count})</span>
                </li>
              `
                )
                .join('')}
            </ul>
          </div>`;

      case 'section':
        return `
          <div class="slide slide-section">
            <h2>${this.escapeHtml(slide.title)}</h2>
            <span class="count">${slide.count} items</span>
          </div>`;

      case 'content':
        return `
          <div class="slide slide-content">
            <div class="content-grid">
              ${slide.items.map((item) => this.renderContentItem(item, slide.contentType)).join('')}
            </div>
          </div>`;

      case 'closing':
        return `
          <div class="slide slide-closing">
            <h2>${this.escapeHtml(slide.title)}</h2>
            <p class="subtitle">${this.escapeHtml(slide.subtitle)}</p>
            <span class="footer">${this.escapeHtml(slide.footer)}</span>
          </div>`;

      default:
        return '';
    }
  }

  /**
   * Render content item
   */
  renderContentItem(item, type) {
    const title = item.metadata?.title || item.fileName || 'Untitled';

    switch (type) {
      case 'image':
        const imageSrc = item.dataUrl || item.filePath || '';
        return `
          <div class="content-item image-item">
            ${imageSrc ? `<img src="${this.escapeHtml(imageSrc)}" alt="${this.escapeHtml(title)}">` : ''}
            <p class="caption">${this.escapeHtml(title)}</p>
          </div>`;

      case 'text':
      case 'html':
        const content = (item.content || item.plainText || '').substring(0, 200);
        return `
          <div class="content-item">
            <p>${this.escapeHtml(content)}${content.length >= 200 ? '...' : ''}</p>
          </div>`;

      case 'url':
      case 'link':
        const url = item.url || item.content;
        return `
          <div class="content-item">
            <h3>${this.escapeHtml(item.metadata?.title || 'Link')}</h3>
            <p><a href="${this.escapeHtml(url)}" target="_blank">${this.escapeHtml(url)}</a></p>
          </div>`;

      case 'file':
        return `
          <div class="content-item">
            <h3>📎 ${this.escapeHtml(item.fileName || 'File')}</h3>
            <p>${item.fileSize ? this.formatFileSize(item.fileSize) : ''}</p>
          </div>`;

      default:
        return `
          <div class="content-item">
            <p>${this.escapeHtml((item.content || '').substring(0, 150))}</p>
          </div>`;
    }
  }

  /**
   * Group items by type
   */
  groupItemsByType(items) {
    const groups = {};
    for (const item of items) {
      const type = item.type || 'other';
      if (!groups[type]) {
        groups[type] = [];
      }
      groups[type].push(item);
    }
    return groups;
  }

  /**
   * Format type name
   */
  formatTypeName(type) {
    const names = {
      text: 'Text Content',
      html: 'HTML Content',
      image: 'Images',
      file: 'Files',
      url: 'Links',
      link: 'Links',
      code: 'Code',
      other: 'Other',
    };
    return names[type] || type.charAt(0).toUpperCase() + type.slice(1);
  }

  /**
   * Format file size
   */
  formatFileSize(bytes) {
    if (!bytes) return '';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round((bytes / Math.pow(1024, i)) * 100) / 100 + ' ' + sizes[i];
  }

  /**
   * Escape HTML
   */
  escapeHtml(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /**
   * Sanitize filename
   */
  sanitizeFilename(name) {
    return name.replace(/[^a-z0-9_\-]/gi, '_').substring(0, 100);
  }
}

module.exports = SlidesGenerator;
