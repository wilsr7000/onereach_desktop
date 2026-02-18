/**
 * PPTX Generator
 * Creates PowerPoint presentations from space assets using pptxgenjs
 */

const PptxGenJS = require('pptxgenjs');
const fs = require('fs');

class PptxGenerator {
  constructor() {
    this.defaultStyles = {
      titleFontSize: 44,
      subtitleFontSize: 24,
      bodyFontSize: 18,
      captionFontSize: 12,
      fontFace: 'Calibri',
      primaryColor: '2B579A',
      secondaryColor: '5B5B5B',
      accentColor: 'D24726',
      backgroundColor: 'FFFFFF',
    };
  }

  /**
   * Generate a PPTX presentation from space data
   * @param {Object} space - Space metadata
   * @param {Array} items - Space items
   * @param {Object} options - Generation options
   * @returns {Promise<Object>} Result with buffer
   */
  async generate(space, items, options = {}) {
    const { includeImages = true, includeMetadata = true, slidesPerItem = false } = options;

    try {
      const pptx = new PptxGenJS();

      // Set presentation properties
      pptx.author = 'Onereach.ai Smart Export';
      pptx.title = space.name;
      pptx.subject = space.description || 'Exported from Onereach.ai';
      pptx.company = 'Onereach.ai';

      // Define master slide layouts
      this.defineMasterSlides(pptx);

      // Title slide
      this.createTitleSlide(pptx, space, items);

      // Table of contents slide
      this.createTableOfContentsSlide(pptx, items);

      // Group items for slides
      const groupedItems = this.groupItemsForSlides(items, slidesPerItem);

      // Create content slides
      for (const group of groupedItems) {
        await this.createContentSlide(pptx, group, { includeImages, includeMetadata });
      }

      // Summary/closing slide
      this.createClosingSlide(pptx, space, items);

      // Generate buffer
      const buffer = await pptx.write({ outputType: 'nodebuffer' });

      return {
        success: true,
        buffer,
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        extension: 'pptx',
        filename: `${this.sanitizeFilename(space.name)}.pptx`,
      };
    } catch (error) {
      console.error('[PptxGenerator] Error generating presentation:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Define master slide layouts
   */
  defineMasterSlides(pptx) {
    // Title slide master
    pptx.defineSlideMaster({
      title: 'TITLE_SLIDE',
      background: { color: this.defaultStyles.primaryColor },
      objects: [
        {
          placeholder: {
            options: { name: 'title', type: 'title', x: 0.5, y: 2.5, w: 9, h: 1.5 },
            text: '(title)',
          },
        },
        {
          placeholder: {
            options: { name: 'subtitle', type: 'body', x: 0.5, y: 4.2, w: 9, h: 1 },
            text: '(subtitle)',
          },
        },
      ],
    });

    // Content slide master
    pptx.defineSlideMaster({
      title: 'CONTENT_SLIDE',
      background: { color: this.defaultStyles.backgroundColor },
      objects: [
        { rect: { x: 0, y: 0, w: '100%', h: 0.75, fill: { color: this.defaultStyles.primaryColor } } },
        {
          placeholder: {
            options: { name: 'title', type: 'title', x: 0.5, y: 0.15, w: 9, h: 0.5 },
            text: '(title)',
          },
        },
        {
          placeholder: {
            options: { name: 'body', type: 'body', x: 0.5, y: 1, w: 9, h: 5.5 },
            text: '(body)',
          },
        },
      ],
    });

    // Image slide master
    pptx.defineSlideMaster({
      title: 'IMAGE_SLIDE',
      background: { color: this.defaultStyles.backgroundColor },
      objects: [
        { rect: { x: 0, y: 0, w: '100%', h: 0.6, fill: { color: this.defaultStyles.primaryColor } } },
        {
          placeholder: {
            options: { name: 'title', type: 'title', x: 0.3, y: 0.1, w: 9.4, h: 0.4 },
            text: '(title)',
          },
        },
      ],
    });
  }

  /**
   * Create title slide
   */
  createTitleSlide(pptx, space, items) {
    const slide = pptx.addSlide({ masterName: 'TITLE_SLIDE' });

    // Title
    slide.addText(space.name, {
      x: 0.5,
      y: 2,
      w: 9,
      h: 1.5,
      fontSize: this.defaultStyles.titleFontSize,
      fontFace: this.defaultStyles.fontFace,
      color: 'FFFFFF',
      bold: true,
      align: 'center',
      valign: 'middle',
    });

    // Subtitle
    const subtitle = space.description || `${items.length} items collected`;
    slide.addText(subtitle, {
      x: 0.5,
      y: 3.6,
      w: 9,
      h: 0.8,
      fontSize: this.defaultStyles.subtitleFontSize,
      fontFace: this.defaultStyles.fontFace,
      color: 'FFFFFF',
      align: 'center',
      valign: 'middle',
    });

    // Date
    const date = new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    slide.addText(date, {
      x: 0.5,
      y: 5,
      w: 9,
      h: 0.5,
      fontSize: this.defaultStyles.captionFontSize,
      fontFace: this.defaultStyles.fontFace,
      color: 'CCCCCC',
      align: 'center',
    });

    // Generated by
    slide.addText('Generated by Onereach.ai', {
      x: 0.5,
      y: 6.8,
      w: 9,
      h: 0.3,
      fontSize: 10,
      fontFace: this.defaultStyles.fontFace,
      color: '999999',
      align: 'center',
    });
  }

  /**
   * Create table of contents slide
   */
  createTableOfContentsSlide(pptx, items) {
    const slide = pptx.addSlide({ masterName: 'CONTENT_SLIDE' });

    // Title
    slide.addText('Contents', {
      x: 0.5,
      y: 0.15,
      w: 9,
      h: 0.5,
      fontSize: 28,
      fontFace: this.defaultStyles.fontFace,
      color: 'FFFFFF',
      bold: true,
    });

    // Group items by type for TOC
    const groups = {};
    for (const item of items) {
      const type = item.type || 'other';
      if (!groups[type]) {
        groups[type] = 0;
      }
      groups[type]++;
    }

    // Create TOC entries
    const tocEntries = Object.entries(groups).map(([type, count]) => ({
      text: `${this.formatTypeName(type)} (${count})`,
      options: { bullet: { code: '25CF' }, indentLevel: 0 },
    }));

    if (tocEntries.length > 0) {
      slide.addText(tocEntries, {
        x: 0.5,
        y: 1.2,
        w: 9,
        h: 5,
        fontSize: this.defaultStyles.bodyFontSize,
        fontFace: this.defaultStyles.fontFace,
        color: this.defaultStyles.secondaryColor,
        valign: 'top',
      });
    }
  }

  /**
   * Create content slide
   */
  async createContentSlide(pptx, group, options) {
    const { includeImages } = options;
    const slide = pptx.addSlide({ masterName: 'CONTENT_SLIDE' });

    // Slide title
    slide.addText(group.title, {
      x: 0.5,
      y: 0.15,
      w: 9,
      h: 0.5,
      fontSize: 24,
      fontFace: this.defaultStyles.fontFace,
      color: 'FFFFFF',
      bold: true,
    });

    let yPos = 1.1;
    const maxY = 6.5;

    for (const item of group.items) {
      if (yPos >= maxY) break;

      // Handle different item types
      switch (item.type) {
        case 'text':
        case 'html':
          yPos = this.addTextContent(slide, item, yPos, maxY);
          break;

        case 'image':
          if (includeImages) {
            yPos = await this.addImageContent(slide, item, yPos);
          }
          break;

        case 'file':
          yPos = this.addFileReference(slide, item, yPos);
          break;

        case 'url':
        case 'link':
          yPos = this.addLinkContent(slide, item, yPos);
          break;

        default:
          if (item.content) {
            yPos = this.addTextContent(slide, item, yPos, maxY);
          }
      }
    }
  }

  /**
   * Add text content to slide
   */
  addTextContent(slide, item, yPos, maxY) {
    const content = item.content || item.plainText || '';
    if (!content) return yPos;

    // Truncate if too long for slide
    const maxChars = 500;
    const displayContent = content.length > maxChars ? content.substring(0, maxChars) + '...' : content;

    // Split into bullet points if content has newlines
    const lines = displayContent.split(/\n+/).filter((l) => l.trim());

    if (lines.length > 1) {
      const bullets = lines.slice(0, 8).map((line) => ({
        text: line.trim().substring(0, 150),
        options: { bullet: { code: '2022' }, indentLevel: 0 },
      }));

      slide.addText(bullets, {
        x: 0.5,
        y: yPos,
        w: 9,
        h: Math.min(lines.length * 0.4, maxY - yPos),
        fontSize: this.defaultStyles.bodyFontSize,
        fontFace: this.defaultStyles.fontFace,
        color: this.defaultStyles.secondaryColor,
        valign: 'top',
      });

      return yPos + Math.min(lines.length * 0.4 + 0.3, maxY - yPos);
    } else {
      slide.addText(displayContent, {
        x: 0.5,
        y: yPos,
        w: 9,
        h: 1.5,
        fontSize: this.defaultStyles.bodyFontSize,
        fontFace: this.defaultStyles.fontFace,
        color: this.defaultStyles.secondaryColor,
        valign: 'top',
      });

      return yPos + 1.7;
    }
  }

  /**
   * Add image content to slide
   */
  async addImageContent(slide, item, yPos) {
    try {
      let imageData = null;

      // Try to get image data
      if (item.dataUrl && item.dataUrl.startsWith('data:')) {
        imageData = item.dataUrl;
      } else if (item.filePath && fs.existsSync(item.filePath)) {
        imageData = item.filePath;
      } else if (item.content && item.content.startsWith('data:')) {
        imageData = item.content;
      }

      if (imageData) {
        // Add image
        slide.addImage({
          data: imageData.startsWith('data:') ? imageData : undefined,
          path: !imageData.startsWith('data:') ? imageData : undefined,
          x: 1,
          y: yPos,
          w: 8,
          h: 4,
          sizing: { type: 'contain', w: 8, h: 4 },
        });

        // Add caption
        const caption = item.fileName || item.metadata?.filename || 'Image';
        slide.addText(caption, {
          x: 1,
          y: yPos + 4.1,
          w: 8,
          h: 0.3,
          fontSize: this.defaultStyles.captionFontSize,
          fontFace: this.defaultStyles.fontFace,
          color: '888888',
          align: 'center',
          italic: true,
        });

        return yPos + 4.5;
      }
    } catch (error) {
      console.error('[PptxGenerator] Error adding image:', error);
    }

    return yPos;
  }

  /**
   * Add file reference to slide
   */
  addFileReference(slide, item, yPos) {
    const fileName = item.fileName || 'Attached File';
    const fileSize = item.fileSize ? ` (${this.formatFileSize(item.fileSize)})` : '';

    slide.addText(
      [
        { text: '📎 ', options: { fontSize: 20 } },
        { text: fileName, options: { bold: true } },
        { text: fileSize, options: { color: '888888', fontSize: 14 } },
      ],
      {
        x: 0.5,
        y: yPos,
        w: 9,
        h: 0.5,
        fontSize: this.defaultStyles.bodyFontSize,
        fontFace: this.defaultStyles.fontFace,
        color: this.defaultStyles.secondaryColor,
      }
    );

    return yPos + 0.6;
  }

  /**
   * Add link content to slide
   */
  addLinkContent(slide, item, yPos) {
    const url = item.url || item.content;
    const title = item.metadata?.title || url;

    slide.addText(
      [
        { text: '🔗 ', options: { fontSize: 18 } },
        { text: title, options: { hyperlink: { url } } },
      ],
      {
        x: 0.5,
        y: yPos,
        w: 9,
        h: 0.5,
        fontSize: this.defaultStyles.bodyFontSize,
        fontFace: this.defaultStyles.fontFace,
        color: this.defaultStyles.primaryColor,
      }
    );

    return yPos + 0.6;
  }

  /**
   * Create closing slide
   */
  createClosingSlide(pptx, space, items) {
    const slide = pptx.addSlide({ masterName: 'TITLE_SLIDE' });

    slide.addText('Thank You', {
      x: 0.5,
      y: 2.5,
      w: 9,
      h: 1,
      fontSize: 40,
      fontFace: this.defaultStyles.fontFace,
      color: 'FFFFFF',
      bold: true,
      align: 'center',
    });

    slide.addText(`This presentation was generated from "${space.name}"`, {
      x: 0.5,
      y: 3.8,
      w: 9,
      h: 0.6,
      fontSize: this.defaultStyles.subtitleFontSize,
      fontFace: this.defaultStyles.fontFace,
      color: 'CCCCCC',
      align: 'center',
    });

    slide.addText(`${items.length} items • Generated by Onereach.ai Smart Export`, {
      x: 0.5,
      y: 6.8,
      w: 9,
      h: 0.3,
      fontSize: 10,
      fontFace: this.defaultStyles.fontFace,
      color: '999999',
      align: 'center',
    });
  }

  /**
   * Group items into slides
   */
  groupItemsForSlides(items, slidesPerItem) {
    if (slidesPerItem) {
      // One item per slide
      return items.map((item) => ({
        title: this.getItemTitle(item),
        items: [item],
      }));
    }

    // Group by type
    const groups = {};
    for (const item of items) {
      const type = item.type || 'other';
      if (!groups[type]) {
        groups[type] = [];
      }
      groups[type].push(item);
    }

    // Create slide groups
    const slideGroups = [];
    for (const [type, typeItems] of Object.entries(groups)) {
      // Split large groups into multiple slides
      const maxItemsPerSlide = type === 'image' ? 1 : 5;
      for (let i = 0; i < typeItems.length; i += maxItemsPerSlide) {
        slideGroups.push({
          title: this.formatTypeName(type),
          items: typeItems.slice(i, i + maxItemsPerSlide),
        });
      }
    }

    return slideGroups;
  }

  /**
   * Get title for an item
   */
  getItemTitle(item) {
    return item.metadata?.title || item.fileName || this.formatTypeName(item.type || 'Item');
  }

  /**
   * Format type name for display
   */
  formatTypeName(type) {
    const names = {
      text: 'Text Content',
      html: 'HTML Content',
      image: 'Images',
      file: 'Files',
      url: 'Links',
      link: 'Links',
      code: 'Code Snippets',
      other: 'Other Content',
    };
    return names[type] || type.charAt(0).toUpperCase() + type.slice(1);
  }

  /**
   * Format file size
   */
  formatFileSize(bytes) {
    if (!bytes) return 'Unknown size';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round((bytes / Math.pow(1024, i)) * 100) / 100 + ' ' + sizes[i];
  }

  /**
   * Sanitize filename
   */
  sanitizeFilename(name) {
    return name.replace(/[^a-z0-9_\-]/gi, '_').substring(0, 100);
  }
}

module.exports = PptxGenerator;
