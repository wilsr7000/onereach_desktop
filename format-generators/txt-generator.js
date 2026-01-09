/**
 * TXT Generator
 * Creates plain text files from space assets
 */

class TxtGenerator {
  constructor() {
    this.defaultOptions = {
      includeMetadata: true,
      lineWidth: 80,
      includeSeparators: true
    };
  }

  /**
   * Generate a plain text file from space data
   * @param {Object} space - Space metadata
   * @param {Array} items - Space items
   * @param {Object} options - Generation options
   * @returns {Promise<Object>} Result with content
   */
  async generate(space, items, options = {}) {
    const opts = { ...this.defaultOptions, ...options };

    try {
      const sections = [];
      const { lineWidth, includeSeparators, includeMetadata } = opts;

      // Title block
      sections.push(this.createTitleBlock(space, lineWidth));

      // Summary
      sections.push(this.createSummaryBlock(space, items, lineWidth));

      // Separator
      if (includeSeparators) {
        sections.push('='.repeat(lineWidth));
        sections.push('');
      }

      // Content by type
      const groupedItems = this.groupItemsByType(items);
      for (const [type, typeItems] of Object.entries(groupedItems)) {
        sections.push(this.createTypeSection(type, typeItems, opts));
      }

      // Footer
      sections.push(this.createFooter(lineWidth));

      const content = sections.join('\n');

      return {
        success: true,
        content,
        buffer: Buffer.from(content, 'utf-8'),
        mimeType: 'text/plain',
        extension: 'txt',
        filename: `${this.sanitizeFilename(space.name)}.txt`
      };

    } catch (error) {
      console.error('[TxtGenerator] Error generating text file:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Create title block
   */
  createTitleBlock(space, lineWidth) {
    const border = '='.repeat(lineWidth);
    const title = this.centerText(space.name.toUpperCase(), lineWidth);
    
    let block = `${border}\n${title}\n`;
    
    if (space.description) {
      block += this.centerText(space.description, lineWidth) + '\n';
    }
    
    block += border + '\n';
    return block;
  }

  /**
   * Create summary block
   */
  createSummaryBlock(space, items, lineWidth) {
    const date = new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    const typeGroups = this.groupItemsByType(items);
    const typeSummary = Object.entries(typeGroups)
      .map(([type, items]) => `  - ${this.formatTypeName(type)}: ${items.length}`)
      .join('\n');

    return `
DOCUMENT INFORMATION
--------------------
Generated: ${date}
Total Items: ${items.length}
Space ID: ${space.id || 'N/A'}

CONTENTS BY TYPE:
${typeSummary}

`;
  }

  /**
   * Create section for a specific type
   */
  createTypeSection(type, items, options) {
    const { lineWidth, includeSeparators, includeMetadata } = options;
    
    let section = '';
    
    // Section header
    const sectionTitle = this.formatTypeName(type).toUpperCase();
    section += `\n${sectionTitle}\n`;
    section += '-'.repeat(sectionTitle.length) + '\n\n';

    // Items
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      section += this.formatItem(item, type, i + 1, options);
      
      if (includeSeparators && i < items.length - 1) {
        section += '\n' + '-'.repeat(40) + '\n\n';
      }
    }

    return section;
  }

  /**
   * Format a single item
   */
  formatItem(item, type, index, options) {
    const { lineWidth, includeMetadata } = options;
    let text = '';

    // Item header
    const title = item.metadata?.title || item.fileName || `Item ${index}`;
    text += `[${index}] ${title}\n`;

    // Content based on type
    switch (type) {
      case 'text':
      case 'html':
        const content = item.content || item.plainText || '';
        text += '\n' + this.wrapText(content, lineWidth) + '\n';
        break;

      case 'image':
        const imageName = item.fileName || item.metadata?.filename || 'Image';
        text += `\n    File: ${imageName}\n`;
        if (item.metadata?.dimensions) {
          text += `    Dimensions: ${item.metadata.dimensions.width}x${item.metadata.dimensions.height}\n`;
        }
        if (item.fileSize) {
          text += `    Size: ${this.formatFileSize(item.fileSize)}\n`;
        }
        if (item.filePath) {
          text += `    Path: ${item.filePath}\n`;
        }
        break;

      case 'file':
        text += `\n    File: ${item.fileName || 'Unknown'}\n`;
        text += `    Type: ${item.fileType || item.fileExt || 'Unknown'}\n`;
        if (item.fileSize) {
          text += `    Size: ${this.formatFileSize(item.fileSize)}\n`;
        }
        if (item.filePath) {
          text += `    Path: ${item.filePath}\n`;
        }
        break;

      case 'url':
      case 'link':
        const url = item.url || item.content;
        text += `\n    URL: ${url}\n`;
        if (item.metadata?.description) {
          text += `\n    ${this.wrapText(item.metadata.description, lineWidth - 4)}\n`;
        }
        break;

      case 'code':
        text += '\n    ```\n';
        const codeLines = (item.content || '').split('\n');
        for (const line of codeLines) {
          text += `    ${line}\n`;
        }
        text += '    ```\n';
        break;

      default:
        if (item.content) {
          text += '\n' + this.wrapText(item.content, lineWidth) + '\n';
        }
    }

    // Metadata
    if (includeMetadata) {
      const metaParts = [];
      
      if (item.timestamp) {
        metaParts.push(`Date: ${new Date(item.timestamp).toLocaleString()}`);
      }
      
      if (item.tags?.length) {
        metaParts.push(`Tags: ${item.tags.join(', ')}`);
      }

      if (item.source) {
        metaParts.push(`Source: ${item.source}`);
      }

      if (metaParts.length > 0) {
        text += '\n    ' + metaParts.join(' | ') + '\n';
      }
    }

    text += '\n';
    return text;
  }

  /**
   * Create footer
   */
  createFooter(lineWidth) {
    const border = '='.repeat(lineWidth);
    const footer = this.centerText('Generated by Onereach.ai Smart Export', lineWidth);
    const date = this.centerText(new Date().toISOString(), lineWidth);
    
    return `\n${border}\n${footer}\n${date}\n${border}\n`;
  }

  /**
   * Center text within width
   */
  centerText(text, width) {
    if (text.length >= width) return text;
    const padding = Math.floor((width - text.length) / 2);
    return ' '.repeat(padding) + text;
  }

  /**
   * Wrap text to specified width
   */
  wrapText(text, width) {
    if (!text) return '';
    
    const words = text.replace(/\s+/g, ' ').trim().split(' ');
    const lines = [];
    let currentLine = '';

    for (const word of words) {
      if (currentLine.length + word.length + 1 <= width) {
        currentLine += (currentLine ? ' ' : '') + word;
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }
    
    if (currentLine) lines.push(currentLine);
    return lines.join('\n');
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
      code: 'Code Snippets',
      other: 'Other Items'
    };
    return names[type] || type.charAt(0).toUpperCase() + type.slice(1);
  }

  /**
   * Format file size
   */
  formatFileSize(bytes) {
    if (!bytes) return 'Unknown';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
  }

  /**
   * Sanitize filename
   */
  sanitizeFilename(name) {
    return name.replace(/[^a-z0-9_\-]/gi, '_').substring(0, 100);
  }
}

module.exports = TxtGenerator;



