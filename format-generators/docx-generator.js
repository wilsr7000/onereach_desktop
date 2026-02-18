/**
 * DOCX Generator
 * Creates Word documents from space assets using the docx library
 */

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  BorderStyle,
  ImageRun,
  ExternalHyperlink,
  TableOfContents,
  PageBreak,
  Header,
  Footer,
  PageNumber,
} = require('docx');
const fs = require('fs');

class DocxGenerator {
  constructor() {
    this.defaultStyles = {
      titleSize: 56, // 28pt
      heading1Size: 48, // 24pt
      heading2Size: 36, // 18pt
      bodySize: 24, // 12pt
      captionSize: 20, // 10pt
      fontFamily: 'Calibri',
      headingFont: 'Calibri Light',
      primaryColor: '2B579A', // Word blue
      secondaryColor: '5B5B5B',
    };
  }

  /**
   * Generate a DOCX document from space data
   * @param {Object} space - Space metadata
   * @param {Array} items - Space items
   * @param {Object} options - Generation options
   * @returns {Promise<Object>} Result with buffer
   */
  async generate(space, items, options = {}) {
    const { includeImages = true, includeMetadata = true, includeTableOfContents = false } = options;

    try {
      // Build document sections
      const sections = [];

      // Title section
      sections.push(this.createTitleParagraph(space.name));

      if (space.description) {
        sections.push(this.createSubtitleParagraph(space.description));
      }

      sections.push(this.createMetadataParagraph(space, items));

      // Table of contents (if requested)
      if (includeTableOfContents) {
        sections.push(new Paragraph({ text: '' })); // Spacer
        sections.push(
          new Paragraph({
            children: [new TextRun({ text: 'Table of Contents', bold: true, size: this.defaultStyles.heading1Size })],
            heading: HeadingLevel.HEADING_1,
          })
        );
        sections.push(
          new TableOfContents('Table of Contents', {
            hyperlink: true,
            headingStyleRange: '1-3',
          })
        );
        sections.push(new Paragraph({ children: [new PageBreak()] }));
      }

      // Group items by type for organized output
      const groupedItems = this.groupItemsByType(items);

      // Process each group
      for (const [type, typeItems] of Object.entries(groupedItems)) {
        // Section header
        sections.push(
          new Paragraph({
            children: [
              new TextRun({ text: this.formatTypeName(type), bold: true, size: this.defaultStyles.heading1Size }),
            ],
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 400, after: 200 },
          })
        );

        // Process items in this group
        for (const item of typeItems) {
          const itemParagraphs = await this.processItem(item, { includeImages, includeMetadata });
          sections.push(...itemParagraphs);
        }
      }

      // Create the document
      const doc = new Document({
        creator: 'Onereach.ai Smart Export',
        title: space.name,
        description: space.description || 'Exported from Onereach.ai',
        styles: {
          default: {
            document: {
              run: {
                font: this.defaultStyles.fontFamily,
                size: this.defaultStyles.bodySize,
              },
            },
          },
          paragraphStyles: [
            {
              id: 'Title',
              name: 'Title',
              basedOn: 'Normal',
              next: 'Normal',
              run: {
                font: this.defaultStyles.headingFont,
                size: this.defaultStyles.titleSize,
                bold: true,
                color: this.defaultStyles.primaryColor,
              },
              paragraph: {
                spacing: { after: 300 },
              },
            },
            {
              id: 'Heading1',
              name: 'Heading 1',
              basedOn: 'Normal',
              next: 'Normal',
              run: {
                font: this.defaultStyles.headingFont,
                size: this.defaultStyles.heading1Size,
                bold: true,
                color: this.defaultStyles.primaryColor,
              },
              paragraph: {
                spacing: { before: 400, after: 200 },
              },
            },
            {
              id: 'Heading2',
              name: 'Heading 2',
              basedOn: 'Normal',
              next: 'Normal',
              run: {
                font: this.defaultStyles.headingFont,
                size: this.defaultStyles.heading2Size,
                bold: true,
                color: this.defaultStyles.secondaryColor,
              },
              paragraph: {
                spacing: { before: 300, after: 150 },
              },
            },
          ],
        },
        sections: [
          {
            properties: {
              page: {
                margin: {
                  top: 1440, // 1 inch
                  right: 1440,
                  bottom: 1440,
                  left: 1440,
                },
              },
            },
            headers: {
              default: new Header({
                children: [
                  new Paragraph({
                    children: [new TextRun({ text: space.name, italics: true, size: 18, color: '888888' })],
                    alignment: AlignmentType.RIGHT,
                  }),
                ],
              }),
            },
            footers: {
              default: new Footer({
                children: [
                  new Paragraph({
                    children: [
                      new TextRun({ text: 'Page ', size: 18 }),
                      new TextRun({ children: [PageNumber.CURRENT], size: 18 }),
                      new TextRun({ text: ' of ', size: 18 }),
                      new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18 }),
                      new TextRun({ text: '  •  Generated by Onereach.ai', size: 18, color: '888888' }),
                    ],
                    alignment: AlignmentType.CENTER,
                  }),
                ],
              }),
            },
            children: sections,
          },
        ],
      });

      // Generate buffer
      const buffer = await Packer.toBuffer(doc);

      return {
        success: true,
        buffer,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        extension: 'docx',
        filename: `${this.sanitizeFilename(space.name)}.docx`,
      };
    } catch (error) {
      console.error('[DocxGenerator] Error generating document:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Create the title paragraph
   */
  createTitleParagraph(title) {
    return new Paragraph({
      children: [
        new TextRun({
          text: title,
          bold: true,
          size: this.defaultStyles.titleSize,
          font: this.defaultStyles.headingFont,
          color: this.defaultStyles.primaryColor,
        }),
      ],
      spacing: { after: 200 },
    });
  }

  /**
   * Create subtitle paragraph
   */
  createSubtitleParagraph(subtitle) {
    return new Paragraph({
      children: [
        new TextRun({
          text: subtitle,
          size: this.defaultStyles.heading2Size,
          color: this.defaultStyles.secondaryColor,
          italics: true,
        }),
      ],
      spacing: { after: 300 },
    });
  }

  /**
   * Create metadata paragraph
   */
  createMetadataParagraph(space, items) {
    const date = new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    return new Paragraph({
      children: [
        new TextRun({
          text: `Generated on ${date}  •  ${items.length} items`,
          size: this.defaultStyles.captionSize,
          color: '888888',
        }),
      ],
      spacing: { after: 400 },
      border: {
        bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC' },
      },
    });
  }

  /**
   * Process a single item into paragraphs
   */
  async processItem(item, options) {
    const paragraphs = [];
    const { includeImages, includeMetadata } = options;

    // Item title/header
    if (item.metadata?.title || item.fileName) {
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: item.metadata?.title || item.fileName || 'Untitled',
              bold: true,
              size: this.defaultStyles.heading2Size,
            }),
          ],
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 300, after: 100 },
        })
      );
    }

    // Content based on type
    switch (item.type) {
      case 'text':
      case 'html':
        paragraphs.push(...this.processTextContent(item.content || item.plainText || ''));
        break;

      case 'image':
        if (includeImages) {
          const imageParagraph = await this.processImage(item);
          if (imageParagraph) {
            paragraphs.push(imageParagraph);
          }
        }
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: `[Image: ${item.fileName || item.metadata?.filename || 'Untitled'}]`,
                italics: true,
                size: this.defaultStyles.captionSize,
                color: '666666',
              }),
            ],
            spacing: { after: 200 },
          })
        );
        break;

      case 'file':
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({ text: '📎 ', size: this.defaultStyles.bodySize }),
              new TextRun({
                text: item.fileName || 'Attached File',
                bold: true,
                size: this.defaultStyles.bodySize,
              }),
              new TextRun({
                text: item.fileSize ? ` (${this.formatFileSize(item.fileSize)})` : '',
                size: this.defaultStyles.captionSize,
                color: '888888',
              }),
            ],
            spacing: { after: 200 },
          })
        );
        break;

      case 'url':
      case 'link':
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({ text: '🔗 ', size: this.defaultStyles.bodySize }),
              new ExternalHyperlink({
                children: [
                  new TextRun({
                    text: item.metadata?.title || item.content || item.url,
                    style: 'Hyperlink',
                  }),
                ],
                link: item.url || item.content,
              }),
            ],
            spacing: { after: 200 },
          })
        );
        break;

      default:
        if (item.content) {
          paragraphs.push(...this.processTextContent(item.content));
        }
    }

    // Metadata footer
    if (includeMetadata && (item.timestamp || item.tags?.length)) {
      const metaParts = [];

      if (item.timestamp) {
        metaParts.push(new Date(item.timestamp).toLocaleString());
      }

      if (item.tags?.length) {
        metaParts.push(`Tags: ${item.tags.join(', ')}`);
      }

      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: metaParts.join('  •  '),
              size: this.defaultStyles.captionSize,
              color: '999999',
              italics: true,
            }),
          ],
          spacing: { after: 300 },
        })
      );
    }

    return paragraphs;
  }

  /**
   * Process text content into paragraphs
   */
  processTextContent(content) {
    if (!content) return [];

    // Split by double newlines for paragraphs
    const paragraphs = content.split(/\n\n+/).filter((p) => p.trim());

    return paragraphs.map(
      (text) =>
        new Paragraph({
          children: [
            new TextRun({
              text: text.trim(),
              size: this.defaultStyles.bodySize,
            }),
          ],
          spacing: { after: 200 },
        })
    );
  }

  /**
   * Process an image item
   */
  async processImage(item) {
    try {
      let imageData = null;

      // Try to get image data from various sources
      if (item.dataUrl && item.dataUrl.startsWith('data:')) {
        // Extract base64 from data URL
        const base64Match = item.dataUrl.match(/^data:image\/\w+;base64,(.+)$/);
        if (base64Match) {
          imageData = Buffer.from(base64Match[1], 'base64');
        }
      } else if (item.filePath && fs.existsSync(item.filePath)) {
        imageData = fs.readFileSync(item.filePath);
      } else if (item.content && item.content.startsWith('data:')) {
        const base64Match = item.content.match(/^data:image\/\w+;base64,(.+)$/);
        if (base64Match) {
          imageData = Buffer.from(base64Match[1], 'base64');
        }
      }

      if (!imageData) {
        return null;
      }

      // Calculate dimensions (max width 500px, maintain aspect ratio)
      const maxWidth = 500;
      let width = item.metadata?.dimensions?.width || maxWidth;
      let height = item.metadata?.dimensions?.height || 300;

      if (width > maxWidth) {
        const ratio = maxWidth / width;
        width = maxWidth;
        height = Math.round(height * ratio);
      }

      return new Paragraph({
        children: [
          new ImageRun({
            data: imageData,
            transformation: {
              width,
              height,
            },
          }),
        ],
        spacing: { after: 100 },
      });
    } catch (error) {
      console.error('[DocxGenerator] Error processing image:', error);
      return null;
    }
  }

  /**
   * Group items by their type
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

    // Sort groups by importance
    const sortOrder = ['text', 'html', 'image', 'file', 'url', 'link', 'code', 'other'];
    const sortedGroups = {};

    for (const type of sortOrder) {
      if (groups[type]) {
        sortedGroups[type] = groups[type];
      }
    }

    // Add any remaining types
    for (const [type, items] of Object.entries(groups)) {
      if (!sortedGroups[type]) {
        sortedGroups[type] = items;
      }
    }

    return sortedGroups;
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
      other: 'Other Items',
    };
    return names[type] || type.charAt(0).toUpperCase() + type.slice(1);
  }

  /**
   * Format file size for display
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

module.exports = DocxGenerator;
