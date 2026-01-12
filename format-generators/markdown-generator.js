/**
 * Markdown Generator
 * Creates Markdown documents from space assets
 */

const fs = require('fs');
const path = require('path');

class MarkdownGenerator {
  constructor() {
    this.defaultOptions = {
      includeImages: true,
      includeMetadata: true,
      includeTableOfContents: true,
      useGitHubFlavor: true
    };
  }

  /**
   * Generate a Markdown document from space data
   * @param {Object} space - Space metadata
   * @param {Array} items - Space items
   * @param {Object} options - Generation options
   * @returns {Promise<Object>} Result with content
   */
  async generate(space, items, options = {}) {
    const opts = { ...this.defaultOptions, ...options };

    try {
      const sections = [];

      // Title and frontmatter
      sections.push(this.generateFrontmatter(space));
      sections.push(this.generateTitle(space));

      // Description
      if (space.description) {
        sections.push(`> ${space.description}\n`);
      }

      // Metadata
      sections.push(this.generateMetadataSection(space, items));

      // Table of contents
      if (opts.includeTableOfContents) {
        sections.push(this.generateTableOfContents(items));
      }

      // Content sections
      const groupedItems = this.groupItemsByType(items);
      for (const [type, typeItems] of Object.entries(groupedItems)) {
        sections.push(this.generateTypeSection(type, typeItems, opts));
      }

      // Footer
      sections.push(this.generateFooter(space));

      const content = sections.filter(s => s).join('\n');

      return {
        success: true,
        content,
        buffer: Buffer.from(content, 'utf-8'),
        mimeType: 'text/markdown',
        extension: 'md',
        filename: `${this.sanitizeFilename(space.name)}.md`
      };

    } catch (error) {
      console.error('[MarkdownGenerator] Error generating markdown:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Generate YAML frontmatter
   */
  generateFrontmatter(space) {
    const date = new Date().toISOString().split('T')[0];
    return `---
title: "${space.name}"
date: ${date}
generator: Onereach.ai Smart Export
---

`;
  }

  /**
   * Generate main title
   */
  generateTitle(space) {
    return `# ${space.name}\n`;
  }

  /**
   * Generate metadata section
   */
  generateMetadataSection(space, items) {
    const date = new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    const typeGroups = this.groupItemsByType(items);
    const typeSummary = Object.entries(typeGroups)
      .map(([type, items]) => `${items.length} ${this.formatTypeName(type).toLowerCase()}`)
      .join(', ');

    return `
**Generated:** ${date}  
**Items:** ${items.length} (${typeSummary})  
**Space ID:** \`${space.id || 'N/A'}\`

---

`;
  }

  /**
   * Generate table of contents
   */
  generateTableOfContents(items) {
    const typeGroups = this.groupItemsByType(items);
    const tocEntries = Object.keys(typeGroups)
      .map(type => {
        const anchor = this.formatTypeName(type).toLowerCase().replace(/\s+/g, '-');
        return `- [${this.formatTypeName(type)}](#${anchor})`;
      })
      .join('\n');

    return `## Table of Contents

${tocEntries}

---

`;
  }

  /**
   * Generate section for a specific type
   */
  generateTypeSection(type, items, options) {
    const sectionTitle = this.formatTypeName(type);
    let section = `## ${sectionTitle}\n\n`;

    for (const item of items) {
      section += this.generateItemMarkdown(item, type, options);
    }

    return section + '\n';
  }

  /**
   * Generate markdown for a single item
   */
  generateItemMarkdown(item, type, options) {
    let md = '';
    const { includeImages, includeMetadata } = options;

    // Item header
    const title = item.metadata?.title || item.fileName || 'Untitled';
    if (title !== 'Untitled') {
      md += `### ${this.escapeMarkdown(title)}\n\n`;
    }

    // Content based on type
    switch (type) {
      case 'text':
        md += this.formatTextContent(item.content || '');
        break;

      case 'html':
        // Convert HTML to markdown-friendly format
        md += this.formatTextContent(item.plainText || item.content || '');
        break;

      case 'image':
        if (includeImages) {
          const imagePath = item.filePath || item.url || '';
          const altText = item.fileName || item.metadata?.filename || 'Image';
          
          if (imagePath) {
            md += `![${this.escapeMarkdown(altText)}](${imagePath})\n\n`;
          } else {
            md += `*[Image: ${this.escapeMarkdown(altText)}]*\n\n`;
          }
          
          // Add caption
          if (item.metadata?.description) {
            md += `*${this.escapeMarkdown(item.metadata.description)}*\n\n`;
          }
        }
        break;

      case 'file':
        const fileName = item.fileName || 'Attached File';
        const fileSize = item.fileSize ? ` (${this.formatFileSize(item.fileSize)})` : '';
        md += `📎 **${this.escapeMarkdown(fileName)}**${fileSize}\n\n`;
        if (item.filePath) {
          md += `  Path: \`${item.filePath}\`\n\n`;
        }
        break;

      case 'url':
      case 'link':
        const url = item.url || item.content;
        const linkTitle = item.metadata?.title || url;
        md += `🔗 [${this.escapeMarkdown(linkTitle)}](${url})\n\n`;
        if (item.metadata?.description) {
          md += `> ${this.escapeMarkdown(item.metadata.description)}\n\n`;
        }
        break;

      case 'code':
        const lang = item.metadata?.language || '';
        md += '```' + lang + '\n';
        md += item.content || '';
        md += '\n```\n\n';
        break;

      default:
        if (item.content) {
          md += this.formatTextContent(item.content);
        }
    }

    // Metadata footer
    if (includeMetadata) {
      const metaParts = [];
      
      if (item.timestamp) {
        metaParts.push(`📅 ${new Date(item.timestamp).toLocaleString()}`);
      }
      
      if (item.tags?.length) {
        metaParts.push(`🏷️ ${item.tags.map(t => `\`${t}\``).join(' ')}`);
      }

      if (item.source) {
        metaParts.push(`📌 ${item.source}`);
      }

      if (metaParts.length > 0) {
        md += `\n*${metaParts.join(' • ')}*\n`;
      }
    }

    md += '\n---\n\n';
    return md;
  }

  /**
   * Format text content with proper markdown
   */
  formatTextContent(content) {
    if (!content) return '';

    // Split into paragraphs
    const paragraphs = content.split(/\n\n+/);
    
    return paragraphs
      .map(p => {
        // Check if it looks like a list
        if (p.match(/^[\-\*\•]\s/m)) {
          return p.split('\n')
            .map(line => {
              const listMatch = line.match(/^[\-\*\•]\s*(.+)/);
              if (listMatch) {
                return `- ${listMatch[1]}`;
              }
              return line;
            })
            .join('\n');
        }
        
        // Check if it looks like a numbered list
        if (p.match(/^\d+[\.\)]\s/m)) {
          return p.split('\n')
            .map((line, i) => {
              const numMatch = line.match(/^\d+[\.\)]\s*(.+)/);
              if (numMatch) {
                return `${i + 1}. ${numMatch[1]}`;
              }
              return line;
            })
            .join('\n');
        }

        return p.trim();
      })
      .filter(p => p)
      .join('\n\n') + '\n\n';
  }

  /**
   * Generate footer
   */
  generateFooter(space) {
    const date = new Date().toISOString();
    return `
---

<sub>Generated by [Onereach.ai](https://onereach.ai) Smart Export on ${date}</sub>
`;
  }

  /**
   * Group items by type
   */
  groupItemsByType(items) {
    const groups = {};
    const typeOrder = ['text', 'html', 'image', 'file', 'url', 'link', 'code', 'other'];
    
    for (const item of items) {
      const type = item.type || 'other';
      if (!groups[type]) {
        groups[type] = [];
      }
      groups[type].push(item);
    }

    // Sort by type order
    const sortedGroups = {};
    for (const type of typeOrder) {
      if (groups[type]) {
        sortedGroups[type] = groups[type];
      }
    }
    
    // Add remaining types
    for (const [type, items] of Object.entries(groups)) {
      if (!sortedGroups[type]) {
        sortedGroups[type] = items;
      }
    }

    return sortedGroups;
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
   * Escape special markdown characters
   */
  escapeMarkdown(text) {
    if (!text) return '';
    return text
      .replace(/\\/g, '\\\\')
      .replace(/\*/g, '\\*')
      .replace(/_/g, '\\_')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
      .replace(/#/g, '\\#')
      .replace(/\+/g, '\\+')
      .replace(/\-/g, '\\-')
      .replace(/\./g, '\\.')
      .replace(/!/g, '\\!');
  }

  /**
   * Format file size
   */
  formatFileSize(bytes) {
    if (!bytes) return 'Unknown size';
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

module.exports = MarkdownGenerator;




