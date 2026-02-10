/**
 * PptxToTextAgent
 *
 * @description Converts PPTX (PowerPoint) files to plain text by parsing the
 *   underlying ZIP structure and extracting text from slide XML files.
 *   PPTX files are ZIP archives containing XML documents; text is stored
 *   in <a:t> tags within each slide's XML.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/pptx-to-text
 *
 * @strategies
 *   - slide-text  : Extracts all text content from all slides in order
 *   - with-notes  : Includes speaker notes alongside slide text
 *   - structured  : Prefixes each section with slide numbers for reference
 *
 * @example
 *   const { PptxToTextAgent } = require('./pptx-to-text');
 *   const agent = new PptxToTextAgent();
 *   const result = await agent.convert(pptxBuffer);
 *   // result.output => 'Welcome\n\nSlide content here...'
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

class PptxToTextAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:pptx-to-text';
    this.name = 'PPTX to Text';
    this.description = 'Converts PPTX (PowerPoint) files to plain text by parsing slide XML';
    this.from = ['pptx'];
    this.to = ['text'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'slide-text',
        description: 'Extracts all text content from all slides in presentation order',
        when: 'Need simple plain text extraction of all slide content',
        engine: 'adm-zip / xml-regex',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Clean text extraction from all slides',
      },
      {
        id: 'with-notes',
        description: 'Includes speaker notes alongside slide text in the output',
        when: 'Speaker notes contain important information to preserve',
        engine: 'adm-zip / xml-regex',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Complete text including speaker notes',
      },
      {
        id: 'structured',
        description: 'Prefixes each section with slide numbers for easy reference',
        when: 'Need to maintain slide-by-slide structure with numbered references',
        engine: 'adm-zip / xml-regex',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Structured output with clear slide boundaries',
      },
    ];
  }

  /**
   * Execute the PPTX-to-text conversion.
   *
   * @param {Buffer} input - PPTX file buffer to convert
   * @param {string} strategy - Strategy ID: 'slide-text' | 'with-notes' | 'structured'
   * @param {Object} [options] - Additional conversion options
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const start = Date.now();
    let output;

    const slides = this._extractSlides(input);
    const notes = strategy === 'with-notes' ? this._extractNotes(input) : {};

    switch (strategy) {
      case 'with-notes': {
        const parts = [];
        for (let i = 0; i < slides.length; i++) {
          const slideText = slides[i].trim();
          const noteText = (notes[i] || '').trim();
          if (slideText) {
            parts.push(slideText);
          }
          if (noteText) {
            parts.push(`[Speaker Notes: ${noteText}]`);
          }
        }
        output = parts.join('\n\n');
        break;
      }
      case 'structured': {
        const parts = [];
        for (let i = 0; i < slides.length; i++) {
          const slideText = slides[i].trim();
          if (slideText) {
            parts.push(`--- Slide ${i + 1} ---\n${slideText}`);
          }
        }
        output = parts.join('\n\n');
        break;
      }
      case 'slide-text':
      default: {
        output = slides
          .map(s => s.trim())
          .filter(s => s.length > 0)
          .join('\n\n');
        break;
      }
    }

    return {
      output,
      metadata: {
        strategy,
        inputLength: input.length,
        outputLength: output.length,
        slideCount: slides.length,
        mimeType: 'text/plain',
        extension: 'txt',
      },
      duration: Date.now() - start,
      strategy,
    };
  }

  /**
   * Extract text from slide XML files inside the PPTX ZIP archive.
   * PPTX slides are stored at ppt/slides/slide1.xml, slide2.xml, etc.
   * Text content is in <a:t> XML tags.
   * @private
   */
  _extractSlides(buffer) {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();

    // Collect slide entries sorted by number
    const slideEntries = entries
      .filter(e => /^ppt\/slides\/slide\d+\.xml$/i.test(e.entryName))
      .sort((a, b) => {
        const numA = parseInt(a.entryName.match(/slide(\d+)/)[1], 10);
        const numB = parseInt(b.entryName.match(/slide(\d+)/)[1], 10);
        return numA - numB;
      });

    const slides = [];
    for (const entry of slideEntries) {
      const xml = entry.getData().toString('utf8');
      const textParts = this._extractTextFromXml(xml);
      slides.push(textParts.join('\n'));
    }

    return slides;
  }

  /**
   * Extract speaker notes from notesSlide XML files.
   * Notes are stored at ppt/notesSlides/notesSlide1.xml, etc.
   * @private
   */
  _extractNotes(buffer) {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();

    const noteEntries = entries
      .filter(e => /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(e.entryName))
      .sort((a, b) => {
        const numA = parseInt(a.entryName.match(/notesSlide(\d+)/)[1], 10);
        const numB = parseInt(b.entryName.match(/notesSlide(\d+)/)[1], 10);
        return numA - numB;
      });

    const notes = {};
    for (const entry of noteEntries) {
      const num = parseInt(entry.entryName.match(/notesSlide(\d+)/)[1], 10);
      const xml = entry.getData().toString('utf8');
      const textParts = this._extractTextFromXml(xml);
      // Filter out common placeholder text
      const filtered = textParts.filter(t =>
        t.trim().length > 0 &&
        !t.match(/^\d+$/) &&
        !t.match(/^slide\s+\d+$/i)
      );
      notes[num - 1] = filtered.join(' ');
    }

    return notes;
  }

  /**
   * Extract text content from XML by matching <a:t> tags.
   * Groups text by <a:p> paragraph boundaries.
   * @private
   */
  _extractTextFromXml(xml) {
    const paragraphs = [];
    // Split by paragraph markers <a:p>...</a:p>
    const pMatches = xml.match(/<a:p\b[^>]*>[\s\S]*?<\/a:p>/g) || [];

    for (const pXml of pMatches) {
      const textParts = [];
      const tMatches = pXml.match(/<a:t>([^<]*)<\/a:t>/g) || [];
      for (const tMatch of tMatches) {
        const text = tMatch.replace(/<\/?a:t>/g, '').trim();
        if (text.length > 0) {
          textParts.push(text);
        }
      }
      if (textParts.length > 0) {
        paragraphs.push(textParts.join(''));
      }
    }

    return paragraphs;
  }

  /**
   * Structural checks for PPTX-to-text conversion output.
   *
   * Validates that the output is a non-empty string.
   *
   * @param {Buffer} input - Original PPTX buffer
   * @param {*} output - Conversion output to validate
   * @param {string} strategy - Strategy that was used
   * @returns {Promise<import('./base-converter-agent').EvaluationIssue[]>}
   */
  async _structuralChecks(input, output, strategy) {
    const issues = [];

    if (typeof output !== 'string') {
      issues.push({
        code: 'OUTPUT_NOT_STRING',
        severity: 'error',
        message: `Expected string output, got ${typeof output}`,
        fixable: true,
      });
      return issues;
    }

    if (output.trim().length === 0) {
      issues.push({
        code: 'OUTPUT_EMPTY',
        severity: 'error',
        message: 'Text output is empty (presentation may contain only images or be blank)',
        fixable: false,
      });
    }

    return issues;
  }
}

module.exports = { PptxToTextAgent };
