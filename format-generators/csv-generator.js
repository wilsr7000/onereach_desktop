/**
 * CSV Generator
 * Creates CSV files from space assets for data export
 */

class CsvGenerator {
  constructor() {
    this.defaultOptions = {
      includeMetadata: true,
      delimiter: ',',
      quoteStrings: true,
      includeHeader: true
    };
  }

  /**
   * Generate a CSV file from space data
   * @param {Object} space - Space metadata
   * @param {Array} items - Space items
   * @param {Object} options - Generation options
   * @returns {Promise<Object>} Result with content
   */
  async generate(space, items, options = {}) {
    const opts = { ...this.defaultOptions, ...options };

    try {
      const rows = [];
      const { delimiter, quoteStrings, includeHeader, includeMetadata } = opts;

      // Define columns
      const columns = [
        { key: 'id', header: 'ID' },
        { key: 'type', header: 'Type' },
        { key: 'content', header: 'Content' },
        { key: 'fileName', header: 'File Name' },
        { key: 'fileSize', header: 'File Size' },
        { key: 'timestamp', header: 'Created' }
      ];

      if (includeMetadata) {
        columns.push(
          { key: 'tags', header: 'Tags' },
          { key: 'source', header: 'Source' },
          { key: 'url', header: 'URL' },
          { key: 'title', header: 'Title' },
          { key: 'description', header: 'Description' }
        );
      }

      // Header row
      if (includeHeader) {
        rows.push(columns.map(col => this.formatCell(col.header, quoteStrings)).join(delimiter));
      }

      // Data rows
      for (const item of items) {
        const rowData = this.extractItemData(item, columns, includeMetadata);
        const row = columns.map(col => {
          const value = rowData[col.key] ?? '';
          return this.formatCell(value, quoteStrings);
        });
        rows.push(row.join(delimiter));
      }

      const content = rows.join('\n');

      // Add BOM for Excel compatibility
      const bom = '\uFEFF';
      const contentWithBom = bom + content;

      return {
        success: true,
        content: contentWithBom,
        buffer: Buffer.from(contentWithBom, 'utf-8'),
        mimeType: 'text/csv',
        extension: 'csv',
        filename: `${this.sanitizeFilename(space.name)}.csv`
      };

    } catch (error) {
      console.error('[CsvGenerator] Error generating CSV:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Extract data from an item for CSV row
   */
  extractItemData(item, columns, includeMetadata) {
    const data = {
      id: item.id || '',
      type: item.type || 'unknown',
      content: this.cleanContent(item.content || item.plainText || ''),
      fileName: item.fileName || item.metadata?.filename || '',
      fileSize: item.fileSize ? this.formatFileSize(item.fileSize) : '',
      timestamp: item.timestamp ? new Date(item.timestamp).toISOString() : ''
    };

    if (includeMetadata) {
      data.tags = item.tags?.join('; ') || '';
      data.source = item.source || '';
      data.url = item.url || item.metadata?.url || '';
      data.title = item.metadata?.title || '';
      data.description = item.metadata?.description || '';
    }

    return data;
  }

  /**
   * Clean content for CSV
   */
  cleanContent(content) {
    if (!content) return '';
    
    // Remove binary data indicators
    if (content.startsWith('data:') || content.match(/^[A-Za-z0-9+/]{100,}={0,2}$/)) {
      return '[Binary data]';
    }

    // Clean up whitespace and limit length
    return content
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\n+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 1000);
  }

  /**
   * Format a cell value for CSV
   */
  formatCell(value, quoteStrings) {
    if (value === null || value === undefined) {
      return '';
    }

    const stringValue = String(value);

    // Always quote if contains special characters
    const needsQuotes = quoteStrings || 
      stringValue.includes(',') || 
      stringValue.includes('"') || 
      stringValue.includes('\n') ||
      stringValue.includes('\r');

    if (needsQuotes) {
      // Escape double quotes by doubling them
      const escaped = stringValue.replace(/"/g, '""');
      return `"${escaped}"`;
    }

    return stringValue;
  }

  /**
   * Format file size
   */
  formatFileSize(bytes) {
    if (!bytes) return '';
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

module.exports = CsvGenerator;



