/**
 * Format Generators Index
 * Central registry for all document format generators
 */

const DocxGenerator = require('./docx-generator');
const PptxGenerator = require('./pptx-generator');
const XlsxGenerator = require('./xlsx-generator');
const MarkdownGenerator = require('./markdown-generator');
const CsvGenerator = require('./csv-generator');
const TxtGenerator = require('./txt-generator');
const SlidesGenerator = require('./slides-generator');

// Format metadata for UI
const FORMAT_METADATA = {
  pdf: {
    name: 'PDF Document',
    extension: 'pdf',
    mimeType: 'application/pdf',
    icon: '📄',
    category: 'documents',
    description: 'Professional PDF document with formatting preserved',
    supportsImages: true,
    supportsStyles: true,
  },
  docx: {
    name: 'Word Document',
    extension: 'docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    icon: '📝',
    category: 'documents',
    description: 'Editable Word document for Microsoft Office or Google Docs',
    supportsImages: true,
    supportsStyles: true,
  },
  txt: {
    name: 'Plain Text',
    extension: 'txt',
    mimeType: 'text/plain',
    icon: '📃',
    category: 'documents',
    description: 'Simple plain text file, universally compatible',
    supportsImages: false,
    supportsStyles: false,
  },
  pptx: {
    name: 'PowerPoint',
    extension: 'pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    icon: '📊',
    category: 'presentations',
    description: 'PowerPoint presentation with slides and bullet points',
    supportsImages: true,
    supportsStyles: true,
  },
  slides: {
    name: 'Web Slides',
    extension: 'html',
    mimeType: 'text/html',
    icon: '🎭',
    category: 'presentations',
    description: 'Interactive web-based presentation',
    supportsImages: true,
    supportsStyles: true,
  },
  xlsx: {
    name: 'Excel Spreadsheet',
    extension: 'xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    icon: '📈',
    category: 'data',
    description: 'Excel spreadsheet with structured data tables',
    supportsImages: false,
    supportsStyles: true,
  },
  csv: {
    name: 'CSV Data',
    extension: 'csv',
    mimeType: 'text/csv',
    icon: '📋',
    category: 'data',
    description: 'Comma-separated values for data import/export',
    supportsImages: false,
    supportsStyles: false,
  },
  html: {
    name: 'Web Page',
    extension: 'html',
    mimeType: 'text/html',
    icon: '🌐',
    category: 'web',
    description: 'Standalone web page with embedded styles',
    supportsImages: true,
    supportsStyles: true,
  },
  markdown: {
    name: 'Markdown',
    extension: 'md',
    mimeType: 'text/markdown',
    icon: '✍️',
    category: 'web',
    description: 'Portable markdown for documentation and wikis',
    supportsImages: true,
    supportsStyles: false,
  },
};

// Generator instances (lazy loaded)
let generators = {};

/**
 * Get a generator instance for a specific format
 * @param {string} format - The format type
 * @returns {Object} Generator instance
 */
function getGenerator(format) {
  if (!generators[format]) {
    switch (format) {
      case 'docx':
        generators[format] = new DocxGenerator();
        break;
      case 'pptx':
        generators[format] = new PptxGenerator();
        break;
      case 'xlsx':
        generators[format] = new XlsxGenerator();
        break;
      case 'markdown':
        generators[format] = new MarkdownGenerator();
        break;
      case 'csv':
        generators[format] = new CsvGenerator();
        break;
      case 'txt':
        generators[format] = new TxtGenerator();
        break;
      case 'slides':
        generators[format] = new SlidesGenerator();
        break;
      case 'pdf':
      case 'html':
        // These are handled by existing generators
        return null;
      default:
        throw new Error(`Unknown format: ${format}`);
    }
  }
  return generators[format];
}

/**
 * Generate a document in the specified format
 * @param {string} format - Target format
 * @param {Object} space - Space data
 * @param {Array} items - Space items
 * @param {Object} options - Generation options
 * @returns {Promise<Object>} Generation result
 */
async function generateDocument(format, space, items, options = {}) {
  const generator = getGenerator(format);

  if (!generator) {
    throw new Error(`No generator available for format: ${format}`);
  }

  return generator.generate(space, items, options);
}

/**
 * Get metadata for a format
 * @param {string} format - Format type
 * @returns {Object} Format metadata
 */
function getFormatMetadata(format) {
  return FORMAT_METADATA[format] || null;
}

/**
 * Get all available formats
 * @returns {Array} Array of format metadata objects
 */
function getAllFormats() {
  return Object.entries(FORMAT_METADATA).map(([key, value]) => ({
    id: key,
    ...value,
  }));
}

/**
 * Get formats by category
 * @param {string} category - Category name
 * @returns {Array} Array of format metadata objects
 */
function getFormatsByCategory(category) {
  return getAllFormats().filter((f) => f.category === category);
}

module.exports = {
  getGenerator,
  generateDocument,
  getFormatMetadata,
  getAllFormats,
  getFormatsByCategory,
  FORMAT_METADATA,
  // Export individual generators for direct access
  DocxGenerator,
  PptxGenerator,
  XlsxGenerator,
  MarkdownGenerator,
  CsvGenerator,
  TxtGenerator,
  SlidesGenerator,
};
