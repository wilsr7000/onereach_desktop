/**
 * PptxToMdAgent
 *
 * @description Converts PPTX (PowerPoint) files to Markdown by parsing the
 *   underlying ZIP structure and extracting text from slide XML files.
 *   Formats the extracted content as Markdown with headings for each slide.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/pptx-to-md
 *
 * @strategies
 *   - flat      : Extracts all text in order as a flat Markdown document
 *   - sectioned : Creates a Markdown heading (##) for each slide
 *   - enhanced  : AI describes image placeholders and enriches slide content
 *
 * @example
 *   const { PptxToMdAgent } = require('./pptx-to-md');
 *   const agent = new PptxToMdAgent();
 *   const result = await agent.convert(pptxBuffer);
 *   // result.output => '## Slide 1: Welcome\n\nContent here...'
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

class PptxToMdAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:pptx-to-md';
    this.name = 'PPTX to Markdown';
    this.description = 'Converts PPTX (PowerPoint) files to Markdown with slide-based sections';
    this.from = ['pptx'];
    this.to = ['md', 'markdown'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'flat',
        description: 'Extracts all slide text in order as a flat Markdown document',
        when: 'Need a simple text-only Markdown extraction without slide structure',
        engine: 'adm-zip / xml-regex',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Simple flat Markdown from slide text',
      },
      {
        id: 'sectioned',
        description: 'Creates a Markdown heading for each slide with content beneath',
        when: 'Want to preserve the slide-by-slide structure in Markdown form',
        engine: 'adm-zip / xml-regex',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Well-structured Markdown with per-slide sections',
      },
      {
        id: 'enhanced',
        description: 'AI enriches the Markdown by describing image references and improving flow',
        when: 'Presentation has images or needs polished Markdown output',
        engine: 'adm-zip / xml-regex + AI',
        mode: 'symbolic',
        speed: 'medium',
        quality: 'Highest quality with AI-enhanced descriptions',
      },
    ];
  }

  /**
   * Execute the PPTX-to-Markdown conversion.
   *
   * @param {Buffer} input - PPTX file buffer to convert
   * @param {string} strategy - Strategy ID: 'flat' | 'sectioned' | 'enhanced'
   * @param {Object} [options] - Additional conversion options
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const start = Date.now();
    let output;

    const slideData = this._extractSlideData(input);

    switch (strategy) {
      case 'flat': {
        output = this._buildFlat(slideData);
        break;
      }
      case 'enhanced': {
        output = await this._buildEnhanced(slideData, input);
        break;
      }
      case 'sectioned':
      default: {
        output = this._buildSectioned(slideData);
        break;
      }
    }

    return {
      output,
      metadata: {
        strategy,
        inputLength: input.length,
        outputLength: output.length,
        slideCount: slideData.length,
        mimeType: 'text/markdown',
        extension: 'md',
      },
      duration: Date.now() - start,
      strategy,
    };
  }

  /**
   * Flat: join all slide text as a single Markdown document.
   * @private
   */
  _buildFlat(slideData) {
    const parts = [];
    for (const slide of slideData) {
      if (slide.text.length > 0) {
        parts.push(slide.text.join('\n'));
      }
    }
    return parts.join('\n\n').trim();
  }

  /**
   * Sectioned: create a Markdown heading for each slide.
   * @private
   */
  _buildSectioned(slideData) {
    const parts = [];
    for (let i = 0; i < slideData.length; i++) {
      const slide = slideData[i];
      if (slide.text.length === 0) continue;

      // Use first line as heading if possible
      const firstLine = slide.text[0];
      const remaining = slide.text.slice(1);

      const heading = `## Slide ${i + 1}: ${firstLine}`;
      const body = remaining.map(line => {
        // If line looks like a bullet point, format it as one
        if (line.match(/^[-]/) || line.length < 120) {
          return `- ${line.replace(/^[-*]\s*/, '')}`;
        }
        return line;
      }).join('\n');

      parts.push(`${heading}\n\n${body}`);

      if (slide.hasImages) {
        parts.push('*[This slide contains images]*');
      }
    }
    return parts.join('\n\n---\n\n').trim();
  }

  /**
   * Enhanced: AI enriches the Markdown output.
   * @private
   */
  async _buildEnhanced(slideData, buffer) {
    let md = this._buildSectioned(slideData);

    if (this._ai) {
      try {
        const enhanced = await this._ai.complete(
          `Improve the following Markdown that was extracted from a PowerPoint presentation.
Clean up formatting, ensure consistent heading levels, and for any "[This slide contains images]"
markers, add a brief note about what type of visual might be there based on context.
Return ONLY the improved Markdown.

${md.substring(0, 8000)}`,
          { profile: 'fast', feature: 'converter-pptx-enhance', temperature: 0.3 }
        );
        if (enhanced && enhanced.trim().length > 0) {
          md = enhanced.trim();
        }
      } catch (_err) {
        // Fall back to un-enhanced version
      }
    }

    return md;
  }

  /**
   * Extract text and image metadata from each slide in the PPTX.
   * @private
   */
  _extractSlideData(buffer) {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();

    const slideEntries = entries
      .filter(e => /^ppt\/slides\/slide\d+\.xml$/i.test(e.entryName))
      .sort((a, b) => {
        const numA = parseInt(a.entryName.match(/slide(\d+)/)[1], 10);
        const numB = parseInt(b.entryName.match(/slide(\d+)/)[1], 10);
        return numA - numB;
      });

    const slideData = [];
    for (const entry of slideEntries) {
      const xml = entry.getData().toString('utf8');
      const textParts = this._extractTextFromXml(xml);
      const hasImages = /<a:blip/i.test(xml) || /<p:pic/i.test(xml);

      slideData.push({
        text: textParts,
        hasImages,
      });
    }

    return slideData;
  }

  /**
   * Extract text content from XML by matching <a:t> tags.
   * Groups text by <a:p> paragraph boundaries.
   * @private
   */
  _extractTextFromXml(xml) {
    const paragraphs = [];
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
   * Structural checks for PPTX-to-Markdown conversion output.
   *
   * Validates that the output is a non-empty string containing Markdown headings.
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
        message: 'Markdown output is empty',
        fixable: true,
      });
      return issues;
    }

    // For sectioned and enhanced, check for Markdown headings
    if (strategy !== 'flat') {
      if (!/^#{1,6}\s/m.test(output)) {
        issues.push({
          code: 'NO_MARKDOWN_HEADINGS',
          severity: 'warning',
          message: 'Output does not contain Markdown headings (expected ## per slide)',
          fixable: true,
          suggestedStrategy: 'sectioned',
        });
      }
    }

    return issues;
  }
}

module.exports = { PptxToMdAgent };
