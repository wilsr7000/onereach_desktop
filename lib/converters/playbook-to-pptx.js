/**
 * PlaybookToPptxAgent
 *
 * @description Converts a structured Playbook object into a PowerPoint
 *   presentation using the `pptxgenjs` library. Each framework pillar can
 *   be rendered as its own slide, or the LLM can structure a narrative flow.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/playbook-to-pptx
 *
 * @agent converter:playbook-to-pptx
 * @from playbook
 * @to   pptx
 *
 * @modes generative
 *
 * @strategies
 *   - framework-slides : One slide per framework pillar (WHO, WHY, WHAT, WHERE) + title + summary
 *   - narrative         : AI-structured story flow across slides
 *   - executive         : Condensed executive summary presentation
 *
 * @evaluation
 *   Structural: output must be a Buffer starting with PK magic bytes (ZIP/PPTX).
 *
 * @input  {Object} Playbook object with title, content, framework, doFramework.
 * @output {Buffer} PPTX binary buffer.
 *
 * @example
 *   const { PlaybookToPptxAgent } = require('./playbook-to-pptx');
 *   const agent = new PlaybookToPptxAgent();
 *   const result = await agent.convert(playbookObj);
 *   // result.output is a Buffer containing PPTX data
 *   require('fs').writeFileSync('playbook.pptx', result.output);
const { getLogQueue } = require('./../log-event-queue');
const log = getLogQueue();
 *
 * @dependencies
 *   - pptxgenjs (PowerPoint generation)
 *   - lib/ai-service.js (for narrative/executive strategy)
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

/** PK magic bytes for ZIP-based formats */
const PK_MAGIC = Buffer.from([0x50, 0x4B, 0x03, 0x04]);

/** Color palette for framework pillar slides */
const PILLAR_COLORS = {
  who: { bg: '1565C0', accent: '90CAF9', text: 'FFFFFF' },
  why: { bg: '2E7D32', accent: 'A5D6A7', text: 'FFFFFF' },
  what: { bg: 'E65100', accent: 'FFCC80', text: 'FFFFFF' },
  where: { bg: '6A1B9A', accent: 'CE93D8', text: 'FFFFFF' },
  when: { bg: '37474F', accent: '90A4AE', text: 'FFFFFF' },
  title: { bg: '0D47A1', accent: '1976D2', text: 'FFFFFF' },
  summary: { bg: '263238', accent: '546E7A', text: 'FFFFFF' },
};

class PlaybookToPptxAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:playbook-to-pptx';
    this.name = 'Playbook to PPTX';
    this.description = 'Converts a structured Playbook into a PowerPoint presentation';
    this.from = ['playbook'];
    this.to = ['pptx'];
    this.modes = ['generative'];

    this.strategies = [
      {
        id: 'framework-slides',
        description: 'One slide per framework pillar: title, WHO, WHY, WHAT, WHERE, content summary',
        when: 'Framework data is rich; need visual breakdown of each pillar',
        engine: 'pptxgenjs',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Structured, pillar-by-pillar framework presentation',
      },
      {
        id: 'narrative',
        description: 'AI-structured narrative flow across slides with storytelling arc',
        when: 'Presentation needs a compelling narrative; audience engagement is key',
        engine: 'pptxgenjs + llm',
        mode: 'generative',
        speed: 'medium',
        quality: 'Narrative-driven presentation with AI-crafted slide structure',
      },
      {
        id: 'executive',
        description: 'Condensed executive summary in 3-4 slides',
        when: 'Brief overview for executives; time-constrained presentations',
        engine: 'pptxgenjs + llm',
        mode: 'generative',
        speed: 'medium',
        quality: 'Concise, high-impact executive summary',
      },
    ];
  }

  // ===========================================================================
  // EXECUTE
  // ===========================================================================

  /**
   * Convert a Playbook object into a PPTX buffer.
   *
   * @param {Object} input - Playbook object
   * @param {string} strategy - Strategy ID: 'framework-slides' | 'narrative' | 'executive'
   * @param {Object} [options] - Additional options
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const startTime = Date.now();

    if (!input || typeof input !== 'object') {
      throw new Error('Input must be a Playbook object');
    }

    const PptxGenJS = require('pptxgenjs');
    const pptx = new PptxGenJS();

    const title = input.title || 'Untitled Playbook';
    const content = input.content || '';
    const framework = input.framework || {};
    const doFramework = input.doFramework || {};
    const keywords = input.keywords || [];

    pptx.layout = 'LAYOUT_WIDE';
    pptx.author = 'Playbook Converter';
    pptx.title = title;

    switch (strategy) {
      case 'framework-slides':
        this._buildFrameworkSlides(pptx, title, content, framework, doFramework, keywords);
        break;
      case 'narrative':
        await this._buildNarrativeSlides(pptx, title, content, framework, doFramework, keywords);
        break;
      case 'executive':
        await this._buildExecutiveSlides(pptx, title, content, framework, doFramework, keywords);
        break;
      default:
        this._buildFrameworkSlides(pptx, title, content, framework, doFramework, keywords);
    }

    // Generate buffer
    const arrayBuffer = await pptx.write({ outputType: 'nodebuffer' });
    const buffer = Buffer.isBuffer(arrayBuffer) ? arrayBuffer : Buffer.from(arrayBuffer);

    return {
      output: buffer,
      metadata: {
        strategy,
        title,
        size: buffer.length,
        format: 'pptx',
        slideCount: pptx.slides?.length || 0,
        hasFramework: !!input.framework,
      },
      duration: Date.now() - startTime,
      strategy,
    };
  }

  // ===========================================================================
  // STRUCTURAL CHECKS
  // ===========================================================================

  /**
   * Validate PPTX output.
   *
   * @param {Object} input - Original Playbook
   * @param {Buffer} output - PPTX buffer
   * @param {string} strategy - Strategy used
   * @returns {Promise<import('./base-converter-agent').EvaluationIssue[]>}
   */
  async _structuralChecks(input, output, strategy) {
    const issues = [];

    if (!Buffer.isBuffer(output)) {
      issues.push({
        code: 'OUTPUT_NOT_BUFFER',
        severity: 'error',
        message: `Expected PPTX buffer, got ${typeof output}`,
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

    // Check PK magic bytes
    if (output.length < 4 || output.compare(PK_MAGIC, 0, 4, 0, 4) !== 0) {
      issues.push({
        code: 'INVALID_MAGIC_BYTES',
        severity: 'error',
        message: 'PPTX output does not start with PK magic bytes (not a valid ZIP/PPTX)',
        fixable: true,
      });
    }

    // Sanity: PPTX should be at least a few KB
    if (output.length < 2048) {
      issues.push({
        code: 'PPTX_TOO_SMALL',
        severity: 'warning',
        message: `PPTX is suspiciously small (${output.length} bytes)`,
        fixable: false,
      });
    }

    return issues;
  }

  // ===========================================================================
  // STRATEGY BUILDERS
  // ===========================================================================

  /**
   * Build one slide per framework pillar.
   * @private
   */
  _buildFrameworkSlides(pptx, title, content, framework, doFramework, keywords) {
    // Slide 1: Title
    const titleSlide = pptx.addSlide();
    titleSlide.background = { color: PILLAR_COLORS.title.bg };
    titleSlide.addText(title, {
      x: 0.8, y: 1.5, w: '85%', h: 1.5,
      fontSize: 36, color: PILLAR_COLORS.title.text,
      bold: true, align: 'left',
    });
    if (keywords.length > 0) {
      titleSlide.addText(keywords.join(' | '), {
        x: 0.8, y: 3.2, w: '85%', h: 0.6,
        fontSize: 14, color: PILLAR_COLORS.title.accent,
        italic: true,
      });
    }

    // Slide 2: WHO
    if (framework.who) {
      const whoSlide = pptx.addSlide();
      whoSlide.background = { color: PILLAR_COLORS.who.bg };
      whoSlide.addText('WHO', { x: 0.8, y: 0.4, w: 3, fontSize: 32, color: PILLAR_COLORS.who.text, bold: true });
      whoSlide.addText(framework.who.primary || 'N/A', {
        x: 0.8, y: 1.2, w: '85%', h: 1,
        fontSize: 24, color: PILLAR_COLORS.who.text,
      });
      const whoDetails = [
        framework.who.context ? `Context: ${framework.who.context}` : '',
        (framework.who.characteristics || []).length > 0 ? `Traits: ${framework.who.characteristics.join(', ')}` : '',
        (framework.who.notFor || []).length > 0 ? `Not for: ${framework.who.notFor.join(', ')}` : '',
      ].filter(Boolean).join('\n');
      if (whoDetails) {
        whoSlide.addText(whoDetails, {
          x: 0.8, y: 2.5, w: '85%', h: 2,
          fontSize: 16, color: PILLAR_COLORS.who.accent, lineSpacingMultiple: 1.5,
        });
      }
    }

    // Slide 3: WHY
    if (framework.why) {
      const whySlide = pptx.addSlide();
      whySlide.background = { color: PILLAR_COLORS.why.bg };
      whySlide.addText('WHY', { x: 0.8, y: 0.4, w: 3, fontSize: 32, color: PILLAR_COLORS.why.text, bold: true });
      whySlide.addText(framework.why.coreValue || 'N/A', {
        x: 0.8, y: 1.2, w: '85%', h: 1,
        fontSize: 24, color: PILLAR_COLORS.why.text,
      });
      const whyDetails = [
        framework.why.emotionalHook ? `Emotional Hook: ${framework.why.emotionalHook}` : '',
        framework.why.practicalBenefit ? `Practical Benefit: ${framework.why.practicalBenefit}` : '',
        framework.why.uniqueAngle ? `Unique Angle: ${framework.why.uniqueAngle}` : '',
      ].filter(Boolean).join('\n');
      if (whyDetails) {
        whySlide.addText(whyDetails, {
          x: 0.8, y: 2.5, w: '85%', h: 2,
          fontSize: 16, color: PILLAR_COLORS.why.accent, lineSpacingMultiple: 1.5,
        });
      }
    }

    // Slide 4: WHAT
    if (framework.what) {
      const whatSlide = pptx.addSlide();
      whatSlide.background = { color: PILLAR_COLORS.what.bg };
      whatSlide.addText('WHAT', { x: 0.8, y: 0.4, w: 3, fontSize: 32, color: PILLAR_COLORS.what.text, bold: true });
      whatSlide.addText(framework.what.primaryAction || 'N/A', {
        x: 0.8, y: 1.2, w: '85%', h: 1,
        fontSize: 24, color: PILLAR_COLORS.what.text,
      });
      const whatDetails = [
        framework.what.successLooksLike ? `Success: ${framework.what.successLooksLike}` : '',
        framework.what.failureLooksLike ? `Failure: ${framework.what.failureLooksLike}` : '',
        (framework.what.secondaryActions || []).length > 0 ? `Also: ${framework.what.secondaryActions.join(', ')}` : '',
      ].filter(Boolean).join('\n');
      if (whatDetails) {
        whatSlide.addText(whatDetails, {
          x: 0.8, y: 2.5, w: '85%', h: 2,
          fontSize: 16, color: PILLAR_COLORS.what.accent, lineSpacingMultiple: 1.5,
        });
      }
    }

    // Slide 5: WHERE
    if (framework.where) {
      const whereSlide = pptx.addSlide();
      whereSlide.background = { color: PILLAR_COLORS.where.bg };
      whereSlide.addText('WHERE', { x: 0.8, y: 0.4, w: 3, fontSize: 32, color: PILLAR_COLORS.where.text, bold: true });
      whereSlide.addText(framework.where.platform || 'N/A', {
        x: 0.8, y: 1.2, w: '85%', h: 1,
        fontSize: 24, color: PILLAR_COLORS.where.text,
      });
      const whereDetails = [
        framework.where.format ? `Format: ${framework.where.format}` : '',
        framework.where.distribution ? `Distribution: ${framework.where.distribution}` : '',
        framework.where.consumptionContext ? `Context: ${framework.where.consumptionContext}` : '',
      ].filter(Boolean).join('\n');
      if (whereDetails) {
        whereSlide.addText(whereDetails, {
          x: 0.8, y: 2.5, w: '85%', h: 2,
          fontSize: 16, color: PILLAR_COLORS.where.accent, lineSpacingMultiple: 1.5,
        });
      }
    }

    // Slide 6: Content Summary
    const summarySlide = pptx.addSlide();
    summarySlide.background = { color: PILLAR_COLORS.summary.bg };
    summarySlide.addText('Content Summary', { x: 0.8, y: 0.4, w: 8, fontSize: 28, color: PILLAR_COLORS.summary.text, bold: true });
    const truncContent = content.length > 800 ? content.substring(0, 800) + '...' : content;
    summarySlide.addText(truncContent, {
      x: 0.8, y: 1.3, w: '85%', h: 4,
      fontSize: 14, color: PILLAR_COLORS.summary.accent,
      lineSpacingMultiple: 1.4,
      valign: 'top',
    });
  }

  /**
   * Build narrative slides using AI to structure the story.
   * @private
   */
  async _buildNarrativeSlides(pptx, title, content, framework, doFramework, keywords) {
    if (!this._ai) {
      // Fallback to framework-slides
      this._buildFrameworkSlides(pptx, title, content, framework, doFramework, keywords);
      return;
    }

    try {
      const slideStructure = await this._ai.json(
        `You are creating a narrative presentation structure.

Title: ${title}
Content preview: ${content.substring(0, 1000)}
Framework WHO: ${framework.who?.primary || 'N/A'}
Framework WHY: ${framework.why?.coreValue || 'N/A'}
Framework WHAT: ${framework.what?.primaryAction || 'N/A'}

Create a 5-7 slide narrative. Return JSON:
{
  "slides": [
    { "title": "slide title", "body": "slide body text (2-3 sentences)", "type": "title|content|conclusion" }
  ]
}`,
        { profile: 'fast', feature: 'converter-pptx-narrative', temperature: 0.5 }
      );

      if (slideStructure?.slides?.length > 0) {
        for (let i = 0; i < slideStructure.slides.length; i++) {
          const s = slideStructure.slides[i];
          const slide = pptx.addSlide();
          const colors = i === 0 ? PILLAR_COLORS.title : PILLAR_COLORS.summary;
          slide.background = { color: colors.bg };
          slide.addText(s.title || `Slide ${i + 1}`, {
            x: 0.8, y: 0.5, w: '85%', fontSize: 28, color: colors.text, bold: true,
          });
          slide.addText(s.body || '', {
            x: 0.8, y: 1.8, w: '85%', h: 3.5,
            fontSize: 18, color: colors.accent, lineSpacingMultiple: 1.5, valign: 'top',
          });
        }
        return;
      }
    } catch (err) {
      console.warn('[playbook-to-pptx] Narrative AI failed, falling back:', err.message);
    }

    // Fallback
    this._buildFrameworkSlides(pptx, title, content, framework, doFramework, keywords);
  }

  /**
   * Build executive summary slides using AI.
   * @private
   */
  async _buildExecutiveSlides(pptx, title, content, framework, doFramework, keywords) {
    if (!this._ai) {
      this._buildFrameworkSlides(pptx, title, content, framework, doFramework, keywords);
      return;
    }

    try {
      const execStructure = await this._ai.json(
        `Create a 3-4 slide executive summary presentation.

Title: ${title}
WHO: ${framework.who?.primary || 'N/A'} - ${framework.who?.context || ''}
WHY: ${framework.why?.coreValue || 'N/A'}
WHAT: ${framework.what?.primaryAction || 'N/A'}
WHERE: ${framework.where?.platform || 'N/A'}
Content preview: ${content.substring(0, 500)}

Return JSON:
{
  "slides": [
    { "title": "slide title", "bullets": ["bullet 1", "bullet 2", "bullet 3"], "type": "title|overview|detail|conclusion" }
  ]
}`,
        { profile: 'fast', feature: 'converter-pptx-executive', temperature: 0.3 }
      );

      if (execStructure?.slides?.length > 0) {
        for (let i = 0; i < execStructure.slides.length; i++) {
          const s = execStructure.slides[i];
          const slide = pptx.addSlide();
          const colors = i === 0 ? PILLAR_COLORS.title : PILLAR_COLORS.summary;
          slide.background = { color: colors.bg };
          slide.addText(s.title || `Slide ${i + 1}`, {
            x: 0.8, y: 0.5, w: '85%', fontSize: 28, color: colors.text, bold: true,
          });
          const bulletsText = (s.bullets || []).map(b => `  ${b}`).join('\n');
          slide.addText(bulletsText, {
            x: 0.8, y: 1.8, w: '85%', h: 3.5,
            fontSize: 18, color: colors.accent, lineSpacingMultiple: 1.6, valign: 'top',
          });
        }
        return;
      }
    } catch (err) {
      console.warn('[playbook-to-pptx] Executive AI failed, falling back:', err.message);
    }

    this._buildFrameworkSlides(pptx, title, content, framework, doFramework, keywords);
  }
}

module.exports = { PlaybookToPptxAgent };
