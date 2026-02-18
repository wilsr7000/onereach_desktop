/**
 * ContentToPptxAgent
 *
 * @description Converts text or Markdown content to PPTX (PowerPoint) format.
 *   Wraps the existing format-generators/pptx-generator when available and falls
 *   back to building presentations directly with the `pptxgenjs` npm package.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/content-to-pptx
 *
 * @strategies
 *   - auto-slides : Automatically splits content into one topic per slide
 *   - structured  : Uses AI to determine the optimal slide breakdown
 *   - visual      : Includes image/chart placeholders alongside text
 *
 * @example
 *   const { ContentToPptxAgent } = require('./content-to-pptx');
 *   const agent = new ContentToPptxAgent();
 *   const result = await agent.convert('# Quarterly Review\n\n## Revenue\nUp 12%...');
 *   // result.output => <Buffer 50 4b ...>  (PPTX file buffer)
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

class ContentToPptxAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:content-to-pptx';
    this.name = 'Content to PPTX';
    this.description = 'Converts text or Markdown content to PowerPoint PPTX format';
    this.from = ['text', 'md'];
    this.to = ['pptx'];
    this.modes = ['symbolic', 'generative'];

    this.strategies = [
      {
        id: 'auto-slides',
        description: 'Automatically splits content into one topic per slide using headings',
        when: 'Input has clear headings or sections that map naturally to slides',
        engine: 'pptxgenjs',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Good for well-structured content with headings',
      },
      {
        id: 'structured',
        description: 'AI determines the optimal slide breakdown and talking points',
        when: 'Input is unstructured or needs intelligent reorganization into slides',
        engine: 'pptxgenjs + AI',
        mode: 'generative',
        speed: 'medium',
        quality: 'Best for unstructured content needing smart slide organization',
      },
      {
        id: 'visual',
        description: 'Includes image/chart placeholder boxes alongside text on each slide',
        when: 'Presentation needs visual placeholders for later enhancement',
        engine: 'pptxgenjs',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Visual layout with placeholder areas for images and charts',
      },
    ];
  }

  /**
   * Execute the content-to-PPTX conversion.
   *
   * @param {string} input - Text or Markdown content to convert
   * @param {string} strategy - Strategy ID: 'auto-slides' | 'structured' | 'visual'
   * @param {Object} [options] - Additional conversion options
   * @param {string} [options.title] - Presentation title
   * @param {string} [options.author] - Presentation author
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const start = Date.now();
    let output;

    switch (strategy) {
      case 'structured': {
        output = await this._executeStructured(input, options);
        break;
      }
      case 'visual': {
        output = await this._executeVisual(input, options);
        break;
      }
      case 'auto-slides':
      default: {
        output = await this._executeAutoSlides(input, options);
        break;
      }
    }

    return {
      output,
      metadata: {
        strategy,
        inputLength: input.length,
        outputLength: output.length,
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        extension: 'pptx',
      },
      duration: Date.now() - start,
      strategy,
    };
  }

  /**
   * Auto-slides: split content by headings, one slide per section.
   * @private
   */
  async _executeAutoSlides(input, options) {
    // Try existing generator first
    try {
      const PptxGenerator = require('../../format-generators/pptx-generator');
      const generator = new PptxGenerator();
      const space = { name: options.title || 'Presentation', description: '' };
      const items = [{ type: 'text', content: input, metadata: {} }];
      const result = await generator.generate(space, items, {});
      if (result.success && result.buffer) {
        return result.buffer;
      }
    } catch (_ignored) {
      // Generator not available, fall back
    }

    return this._buildPptxFromSections(this._splitIntoSections(input), options);
  }

  /**
   * Structured: AI determines optimal slide breakdown.
   * @private
   */
  async _executeStructured(input, options) {
    let sections = this._splitIntoSections(input);

    if (this._ai) {
      try {
        const result = await this._ai.json(
          `You are a presentation designer. Break the following content into slides.
Return JSON: { "slides": [{ "title": "Slide Title", "bullets": ["point 1", "point 2"] }] }
Keep each slide focused on one topic. Maximum 5 bullets per slide.

Content:
${input.substring(0, 6000)}`,
          { profile: 'fast', feature: 'converter-pptx-structure', temperature: 0.3 }
        );
        if (result && Array.isArray(result.slides) && result.slides.length > 0) {
          sections = result.slides.map((s) => ({
            title: s.title || 'Slide',
            body: Array.isArray(s.bullets) ? s.bullets.join('\n') : s.body || '',
          }));
        }
      } catch (_err) {
        // Fall back to heading-based split
      }
    }

    return this._buildPptxFromSections(sections, options);
  }

  /**
   * Visual: add placeholder rectangles for images alongside text.
   * @private
   */
  async _executeVisual(input, options) {
    const PptxGenJS = require('pptxgenjs');
    const pptx = new PptxGenJS();
    pptx.author = options.author || 'Onereach.ai';
    pptx.title = options.title || 'Presentation';

    const sections = this._splitIntoSections(input);

    // Title slide
    const titleSlide = pptx.addSlide();
    titleSlide.addText(options.title || sections[0]?.title || 'Presentation', {
      x: 0.5,
      y: 1.5,
      w: 9,
      h: 1.5,
      fontSize: 36,
      bold: true,
      color: '2B579A',
      align: 'center',
    });

    // Content slides with visual placeholders
    for (const section of sections) {
      const slide = pptx.addSlide();

      // Title
      slide.addText(section.title, {
        x: 0.5,
        y: 0.3,
        w: 9,
        h: 0.8,
        fontSize: 24,
        bold: true,
        color: '2B579A',
      });

      // Text on left half
      const bodyLines = section.body.split('\n').filter((l) => l.trim());
      const bulletText = bodyLines.map((line) => ({
        text: line.replace(/^[-*]\s*/, ''),
        options: { fontSize: 14, bullet: true, color: '333333' },
      }));
      if (bulletText.length > 0) {
        slide.addText(bulletText, { x: 0.5, y: 1.3, w: 4.5, h: 4 });
      }

      // Image placeholder on right half
      slide.addShape('rect', {
        x: 5.5,
        y: 1.3,
        w: 4,
        h: 3.5,
        fill: { color: 'F0F0F0' },
        line: { color: 'CCCCCC', width: 1, dashType: 'dash' },
      });
      slide.addText('[Image Placeholder]', {
        x: 5.5,
        y: 2.5,
        w: 4,
        h: 1,
        fontSize: 12,
        color: '999999',
        align: 'center',
      });
    }

    return Buffer.from(await pptx.write({ outputType: 'nodebuffer' }));
  }

  /**
   * Build PPTX from parsed sections using pptxgenjs.
   * @private
   */
  async _buildPptxFromSections(sections, options = {}) {
    const PptxGenJS = require('pptxgenjs');
    const pptx = new PptxGenJS();
    pptx.author = options.author || 'Onereach.ai';
    pptx.title = options.title || 'Presentation';

    // Title slide
    const titleSlide = pptx.addSlide();
    titleSlide.addText(options.title || sections[0]?.title || 'Presentation', {
      x: 0.5,
      y: 1.5,
      w: 9,
      h: 1.5,
      fontSize: 36,
      bold: true,
      color: '2B579A',
      align: 'center',
    });
    titleSlide.addText(
      new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
      {
        x: 0.5,
        y: 3.2,
        w: 9,
        h: 0.5,
        fontSize: 14,
        color: '888888',
        align: 'center',
      }
    );

    // Content slides
    for (const section of sections) {
      const slide = pptx.addSlide();

      slide.addText(section.title, {
        x: 0.5,
        y: 0.3,
        w: 9,
        h: 0.8,
        fontSize: 24,
        bold: true,
        color: '2B579A',
      });

      const bodyLines = section.body.split('\n').filter((l) => l.trim());
      const bulletText = bodyLines.map((line) => ({
        text: line.replace(/^[-*]\s*/, ''),
        options: { fontSize: 16, bullet: true, color: '333333', breakLine: true },
      }));

      if (bulletText.length > 0) {
        slide.addText(bulletText, { x: 0.5, y: 1.3, w: 9, h: 4 });
      }
    }

    return Buffer.from(await pptx.write({ outputType: 'nodebuffer' }));
  }

  /**
   * Split text/Markdown content into titled sections for slides.
   * @private
   */
  _splitIntoSections(input) {
    const lines = input.split('\n');
    const sections = [];
    let currentTitle = 'Introduction';
    let currentBody = [];

    for (const line of lines) {
      const headingMatch = line.match(/^#{1,3}\s+(.+)$/);
      if (headingMatch) {
        if (currentBody.length > 0 || sections.length > 0) {
          sections.push({ title: currentTitle, body: currentBody.join('\n').trim() });
          currentBody = [];
        }
        currentTitle = headingMatch[1];
      } else {
        currentBody.push(line);
      }
    }

    // Push final section
    if (currentBody.join('').trim().length > 0 || sections.length === 0) {
      sections.push({ title: currentTitle, body: currentBody.join('\n').trim() });
    }

    return sections;
  }

  /**
   * Structural checks for content-to-PPTX conversion output.
   *
   * Validates that the output is a non-empty Buffer starting with PK (zip)
   * magic bytes, since PPTX files are ZIP archives.
   *
   * @param {string} input - Original text/Markdown input
   * @param {*} output - Conversion output to validate
   * @param {string} strategy - Strategy that was used
   * @returns {Promise<import('./base-converter-agent').EvaluationIssue[]>}
   */
  async _structuralChecks(input, output, _strategy) {
    const issues = [];

    if (!Buffer.isBuffer(output)) {
      issues.push({
        code: 'OUTPUT_NOT_BUFFER',
        severity: 'error',
        message: `Expected Buffer output, got ${typeof output}`,
        fixable: true,
      });
      return issues;
    }

    if (output.length === 0) {
      issues.push({
        code: 'OUTPUT_EMPTY',
        severity: 'error',
        message: 'PPTX buffer is empty',
        fixable: true,
      });
      return issues;
    }

    // PPTX is a ZIP archive; first two bytes must be PK (0x50 0x4B)
    if (output[0] !== 0x50 || output[1] !== 0x4b) {
      issues.push({
        code: 'INVALID_ZIP_MAGIC',
        severity: 'error',
        message: 'Output does not start with PK magic bytes (not a valid PPTX/ZIP file)',
        fixable: true,
      });
    }

    if (output.length < 100) {
      issues.push({
        code: 'OUTPUT_TOO_SMALL',
        severity: 'warning',
        message: `PPTX buffer is suspiciously small (${output.length} bytes)`,
        fixable: false,
      });
    }

    return issues;
  }
}

module.exports = { ContentToPptxAgent };
