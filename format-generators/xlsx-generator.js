/**
 * XLSX Generator
 * Creates Excel spreadsheets from space assets using exceljs
 */

const ExcelJS = require('exceljs');

class XlsxGenerator {
  constructor() {
    this.defaultStyles = {
      headerFill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2B579A' } },
      headerFont: { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 },
      bodyFont: { size: 11 },
      alternateFill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } },
    };
  }

  /**
   * Generate an XLSX spreadsheet from space data
   * @param {Object} space - Space metadata
   * @param {Array} items - Space items
   * @param {Object} options - Generation options
   * @returns {Promise<Object>} Result with buffer
   */
  async generate(space, items, options = {}) {
    const { includeMetadata = true, separateSheets = true, includeStats = true } = options;

    try {
      const workbook = new ExcelJS.Workbook();

      // Set workbook properties
      workbook.creator = 'Onereach.ai Smart Export';
      workbook.lastModifiedBy = 'Onereach.ai';
      workbook.created = new Date();
      workbook.modified = new Date();
      workbook.title = space.name;

      // Create summary sheet
      if (includeStats) {
        this.createSummarySheet(workbook, space, items);
      }

      // Create main data sheet with all items
      this.createItemsSheet(workbook, items, includeMetadata);

      // Create separate sheets by type if requested
      if (separateSheets) {
        const groupedItems = this.groupItemsByType(items);
        for (const [type, typeItems] of Object.entries(groupedItems)) {
          if (typeItems.length > 0) {
            this.createTypeSheet(workbook, type, typeItems, includeMetadata);
          }
        }
      }

      // Generate buffer
      const buffer = await workbook.xlsx.writeBuffer();

      return {
        success: true,
        buffer: Buffer.from(buffer),
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        extension: 'xlsx',
        filename: `${this.sanitizeFilename(space.name)}.xlsx`,
      };
    } catch (error) {
      console.error('[XlsxGenerator] Error generating spreadsheet:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Create summary sheet with statistics
   */
  createSummarySheet(workbook, space, items) {
    const sheet = workbook.addWorksheet('Summary', {
      properties: { tabColor: { argb: 'FF2B579A' } },
    });

    // Title
    sheet.mergeCells('A1:D1');
    const titleCell = sheet.getCell('A1');
    titleCell.value = space.name;
    titleCell.font = { bold: true, size: 18, color: { argb: 'FF2B579A' } };
    titleCell.alignment = { horizontal: 'center' };

    // Description
    if (space.description) {
      sheet.mergeCells('A2:D2');
      const descCell = sheet.getCell('A2');
      descCell.value = space.description;
      descCell.font = { italic: true, size: 12, color: { argb: 'FF666666' } };
      descCell.alignment = { horizontal: 'center' };
    }

    // Stats section
    let row = 5;
    sheet.getCell(`A${row}`).value = 'Statistics';
    sheet.getCell(`A${row}`).font = { bold: true, size: 14 };
    row++;

    // Count by type
    const typeGroups = this.groupItemsByType(items);
    const stats = [
      ['Total Items', items.length],
      ['Generated Date', new Date().toLocaleDateString()],
      ['Space ID', space.id || 'N/A'],
      ['', ''], // Spacer
      ['Items by Type', ''],
    ];

    for (const [type, typeItems] of Object.entries(typeGroups)) {
      stats.push([`  ${this.formatTypeName(type)}`, typeItems.length]);
    }

    stats.forEach(([label, value], i) => {
      sheet.getCell(`A${row + i}`).value = label;
      sheet.getCell(`B${row + i}`).value = value;
      if (label && !label.startsWith('  ')) {
        sheet.getCell(`A${row + i}`).font = { bold: true };
      }
    });

    // Set column widths
    sheet.getColumn('A').width = 25;
    sheet.getColumn('B').width = 30;
    sheet.getColumn('C').width = 20;
    sheet.getColumn('D').width = 20;
  }

  /**
   * Create main items sheet
   */
  createItemsSheet(workbook, items, includeMetadata) {
    const sheet = workbook.addWorksheet('All Items', {
      properties: { tabColor: { argb: 'FF22C55E' } },
    });

    // Define columns
    const columns = [
      { header: 'ID', key: 'id', width: 15 },
      { header: 'Type', key: 'type', width: 12 },
      { header: 'Content', key: 'content', width: 50 },
      { header: 'File Name', key: 'fileName', width: 25 },
      { header: 'Created', key: 'timestamp', width: 20 },
    ];

    if (includeMetadata) {
      columns.push(
        { header: 'Tags', key: 'tags', width: 20 },
        { header: 'Source', key: 'source', width: 15 },
        { header: 'URL', key: 'url', width: 35 }
      );
    }

    sheet.columns = columns;

    // Style header row
    const headerRow = sheet.getRow(1);
    headerRow.eachCell((cell) => {
      cell.fill = this.defaultStyles.headerFill;
      cell.font = this.defaultStyles.headerFont;
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    headerRow.height = 25;

    // Add data rows
    items.forEach((item, index) => {
      const rowData = {
        id: item.id || `item-${index + 1}`,
        type: item.type || 'unknown',
        content: this.truncateContent(item.content || item.plainText || ''),
        fileName: item.fileName || item.metadata?.filename || '',
        timestamp: item.timestamp ? new Date(item.timestamp).toLocaleString() : '',
      };

      if (includeMetadata) {
        rowData.tags = item.tags?.join(', ') || '';
        rowData.source = item.source || '';
        rowData.url = item.url || item.metadata?.url || '';
      }

      const row = sheet.addRow(rowData);

      // Alternate row colors
      if (index % 2 === 1) {
        row.eachCell((cell) => {
          cell.fill = this.defaultStyles.alternateFill;
        });
      }

      // Set row height based on content
      row.height = 20;
    });

    // Add filters
    sheet.autoFilter = {
      from: 'A1',
      to: `${String.fromCharCode(64 + columns.length)}1`,
    };

    // Freeze header row
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }

  /**
   * Create sheet for a specific item type
   */
  createTypeSheet(workbook, type, items, includeMetadata) {
    const sheetName = this.formatTypeName(type).substring(0, 31); // Excel limit
    const tabColors = {
      text: 'FF3B82F6',
      html: 'FF8B5CF6',
      image: 'FFF59E0B',
      file: 'FF64748B',
      url: 'FF22C55E',
      link: 'FF22C55E',
      code: 'FFEF4444',
    };

    const sheet = workbook.addWorksheet(sheetName, {
      properties: { tabColor: { argb: tabColors[type] || 'FF888888' } },
    });

    // Define type-specific columns
    let columns = [];

    switch (type) {
      case 'text':
      case 'html':
        columns = [
          { header: 'ID', key: 'id', width: 15 },
          { header: 'Content', key: 'content', width: 60 },
          { header: 'Length', key: 'length', width: 10 },
          { header: 'Created', key: 'timestamp', width: 20 },
        ];
        break;

      case 'image':
        columns = [
          { header: 'ID', key: 'id', width: 15 },
          { header: 'File Name', key: 'fileName', width: 30 },
          { header: 'Dimensions', key: 'dimensions', width: 15 },
          { header: 'File Size', key: 'fileSize', width: 12 },
          { header: 'File Path', key: 'filePath', width: 40 },
          { header: 'Created', key: 'timestamp', width: 20 },
        ];
        break;

      case 'file':
        columns = [
          { header: 'ID', key: 'id', width: 15 },
          { header: 'File Name', key: 'fileName', width: 35 },
          { header: 'File Type', key: 'fileType', width: 15 },
          { header: 'File Size', key: 'fileSize', width: 12 },
          { header: 'File Path', key: 'filePath', width: 40 },
          { header: 'Created', key: 'timestamp', width: 20 },
        ];
        break;

      case 'url':
      case 'link':
        columns = [
          { header: 'ID', key: 'id', width: 15 },
          { header: 'Title', key: 'title', width: 35 },
          { header: 'URL', key: 'url', width: 50 },
          { header: 'Created', key: 'timestamp', width: 20 },
        ];
        break;

      default:
        columns = [
          { header: 'ID', key: 'id', width: 15 },
          { header: 'Content', key: 'content', width: 50 },
          { header: 'Created', key: 'timestamp', width: 20 },
        ];
    }

    if (includeMetadata) {
      columns.push({ header: 'Tags', key: 'tags', width: 25 });
    }

    sheet.columns = columns;

    // Style header
    const headerRow = sheet.getRow(1);
    headerRow.eachCell((cell) => {
      cell.fill = this.defaultStyles.headerFill;
      cell.font = this.defaultStyles.headerFont;
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    headerRow.height = 25;

    // Add data
    items.forEach((item, index) => {
      const rowData = this.getTypeSpecificRowData(type, item, index);
      if (includeMetadata) {
        rowData.tags = item.tags?.join(', ') || '';
      }

      const row = sheet.addRow(rowData);
      if (index % 2 === 1) {
        row.eachCell((cell) => {
          cell.fill = this.defaultStyles.alternateFill;
        });
      }
      row.height = 20;

      // Make URLs clickable
      if (rowData.url) {
        const urlCell = row.getCell('url');
        urlCell.value = { text: rowData.url, hyperlink: rowData.url };
        urlCell.font = { color: { argb: 'FF0066CC' }, underline: true };
      }
    });

    // Freeze header
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }

  /**
   * Get type-specific row data
   */
  getTypeSpecificRowData(type, item, index) {
    const base = {
      id: item.id || `item-${index + 1}`,
      timestamp: item.timestamp ? new Date(item.timestamp).toLocaleString() : '',
    };

    switch (type) {
      case 'text':
      case 'html':
        return {
          ...base,
          content: this.truncateContent(item.content || item.plainText || '', 500),
          length: (item.content || item.plainText || '').length,
        };

      case 'image':
        return {
          ...base,
          fileName: item.fileName || item.metadata?.filename || 'Untitled',
          dimensions: item.metadata?.dimensions
            ? `${item.metadata.dimensions.width}x${item.metadata.dimensions.height}`
            : 'N/A',
          fileSize: item.fileSize ? this.formatFileSize(item.fileSize) : 'N/A',
          filePath: item.filePath || '',
        };

      case 'file':
        return {
          ...base,
          fileName: item.fileName || 'Untitled',
          fileType: item.fileType || item.fileExt || 'Unknown',
          fileSize: item.fileSize ? this.formatFileSize(item.fileSize) : 'N/A',
          filePath: item.filePath || '',
        };

      case 'url':
      case 'link':
        return {
          ...base,
          title: item.metadata?.title || item.content || 'Untitled',
          url: item.url || item.content || '',
        };

      default:
        return {
          ...base,
          content: this.truncateContent(item.content || '', 300),
        };
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
      text: 'Text',
      html: 'HTML',
      image: 'Images',
      file: 'Files',
      url: 'URLs',
      link: 'Links',
      code: 'Code',
      other: 'Other',
    };
    return names[type] || type.charAt(0).toUpperCase() + type.slice(1);
  }

  /**
   * Truncate content for display
   */
  truncateContent(content, maxLength = 300) {
    if (!content) return '';
    // Clean up content - remove excessive whitespace
    const cleaned = content.replace(/\s+/g, ' ').trim();
    if (cleaned.length <= maxLength) return cleaned;
    return cleaned.substring(0, maxLength) + '...';
  }

  /**
   * Format file size
   */
  formatFileSize(bytes) {
    if (!bytes) return 'N/A';
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

module.exports = XlsxGenerator;
