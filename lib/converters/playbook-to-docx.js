/**
 * PlaybookToDocxAgent
 *
 * @description Converts a structured Playbook object into a DOCX document
 *   using the `docx` npm package. The framework is rendered as a formatted
 *   table and the content is added as styled paragraphs.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/playbook-to-docx
 *
 * @agent converter:playbook-to-docx
 * @from playbook
 * @to   docx
 *
 * @modes symbolic
 *
 * @strategies
 *   - formal   : Professional document with formal heading styles and framework table
 *   - template : Corporate template with branded header/footer and structured sections
 *   - compact  : Minimal document with concise framework summary and content
 *
 * @evaluation
 *   Structural: output must be a Buffer starting with PK magic bytes (ZIP/DOCX).
 *
 * @input  {Object} Playbook object with title, content, framework, doFramework.
 * @output {Buffer} DOCX binary buffer.
 *
 * @example
 *   const { PlaybookToDocxAgent } = require('./playbook-to-docx');
 *   const agent = new PlaybookToDocxAgent();
 *   const result = await agent.convert(playbookObj);
 *   // result.output is a Buffer containing DOCX data
 *   require('fs').writeFileSync('playbook.docx', result.output);
 *
 * @dependencies
 *   - docx (DOCX generation)
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

/** PK magic bytes for ZIP-based formats (DOCX, PPTX, XLSX) */
const PK_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

class PlaybookToDocxAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:playbook-to-docx';
    this.name = 'Playbook to DOCX';
    this.description = 'Converts a structured Playbook into a Word document with framework table';
    this.from = ['playbook'];
    this.to = ['docx'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'formal',
        description: 'Professional document with formal heading styles and framework table',
        when: 'Output is for professional or academic distribution',
        engine: 'docx',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Clean, professional formatting with structured framework table',
      },
      {
        id: 'template',
        description: 'Corporate template with branded header/footer and structured sections',
        when: 'Output needs corporate branding or template compliance',
        engine: 'docx',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Template-based with header, footer, and section breaks',
      },
      {
        id: 'compact',
        description: 'Minimal document with concise framework summary and content',
        when: 'Brief output needed; internal use or quick reference',
        engine: 'docx',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Concise and minimal; framework as brief summary paragraph',
      },
    ];
  }

  // ===========================================================================
  // EXECUTE
  // ===========================================================================

  /**
   * Convert a Playbook object into a DOCX buffer.
   *
   * @param {Object} input - Playbook object
   * @param {string} strategy - Strategy ID: 'formal' | 'template' | 'compact'
   * @param {Object} [options] - Additional options
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, _options = {}) {
    const startTime = Date.now();

    if (!input || typeof input !== 'object') {
      throw new Error('Input must be a Playbook object');
    }

    const docx = require('docx');
    const { Document, Packer, Paragraph, TextRun, AlignmentType, Header, Footer } = docx;

    const title = input.title || 'Untitled Playbook';
    const content = input.content || '';
    const framework = input.framework || {};
    const doFramework = input.doFramework || {};
    const keywords = input.keywords || [];

    let children;

    switch (strategy) {
      case 'formal':
        children = this._buildFormal(title, content, framework, doFramework, keywords, docx);
        break;
      case 'template':
        children = this._buildTemplate(title, content, framework, doFramework, keywords, docx);
        break;
      case 'compact':
        children = this._buildCompact(title, content, framework, doFramework, keywords, docx);
        break;
      default:
        children = this._buildFormal(title, content, framework, doFramework, keywords, docx);
    }

    const docConfig = {
      sections: [
        {
          properties: {},
          children,
        },
      ],
    };

    // Add header/footer for template strategy
    if (strategy === 'template') {
      docConfig.sections[0].headers = {
        default: new Header({
          children: [
            new Paragraph({
              children: [new TextRun({ text: title, size: 18, color: '666666', italics: true })],
              alignment: AlignmentType.RIGHT,
            }),
          ],
        }),
      };
      docConfig.sections[0].footers = {
        default: new Footer({
          children: [
            new Paragraph({
              children: [new TextRun({ text: 'Playbook | Confidential', size: 16, color: '999999' })],
              alignment: AlignmentType.CENTER,
            }),
          ],
        }),
      };
    }

    const doc = new Document(docConfig);
    const buffer = await Packer.toBuffer(doc);

    return {
      output: buffer,
      metadata: {
        strategy,
        title,
        size: buffer.length,
        format: 'docx',
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
   * Validate DOCX output.
   *
   * @param {Object} input - Original Playbook
   * @param {Buffer} output - DOCX buffer
   * @param {string} strategy - Strategy used
   * @returns {Promise<import('./base-converter-agent').EvaluationIssue[]>}
   */
  async _structuralChecks(input, output, _strategy) {
    const issues = [];

    if (!Buffer.isBuffer(output)) {
      issues.push({
        code: 'OUTPUT_NOT_BUFFER',
        severity: 'error',
        message: `Expected DOCX buffer, got ${typeof output}`,
        fixable: true,
      });
      return issues;
    }

    if (output.length === 0) {
      issues.push({
        code: 'OUTPUT_EMPTY',
        severity: 'error',
        message: 'DOCX buffer is empty',
        fixable: true,
      });
      return issues;
    }

    // Check PK magic bytes (ZIP/DOCX signature)
    if (output.length < 4 || output.compare(PK_MAGIC, 0, 4, 0, 4) !== 0) {
      issues.push({
        code: 'INVALID_MAGIC_BYTES',
        severity: 'error',
        message: 'DOCX output does not start with PK magic bytes (not a valid ZIP/DOCX)',
        fixable: true,
      });
    }

    // Sanity: DOCX should be at least a few KB
    if (output.length < 1024) {
      issues.push({
        code: 'DOCX_TOO_SMALL',
        severity: 'warning',
        message: `DOCX is suspiciously small (${output.length} bytes)`,
        fixable: false,
      });
    }

    return issues;
  }

  // ===========================================================================
  // STRATEGY BUILDERS
  // ===========================================================================

  /**
   * Build formal document elements.
   * @private
   */
  _buildFormal(title, content, framework, doFramework, keywords, docx) {
    const { Paragraph, TextRun, HeadingLevel } = docx;
    const children = [];

    // Title
    children.push(
      new Paragraph({
        text: title,
        heading: HeadingLevel.TITLE,
        spacing: { after: 300 },
      })
    );

    // Keywords
    if (keywords.length > 0) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: 'Keywords: ', bold: true, size: 20 }),
            new TextRun({ text: keywords.join(', '), size: 20, italics: true, color: '666666' }),
          ],
          spacing: { after: 200 },
        })
      );
    }

    // Framework heading
    children.push(
      new Paragraph({
        text: 'Framework Analysis',
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 400, after: 200 },
      })
    );

    // Framework table
    children.push(this._buildFrameworkTable(framework, docx));

    // Personas
    if (doFramework?.personas?.length > 0) {
      children.push(
        new Paragraph({
          text: 'Personas',
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 400, after: 200 },
        })
      );

      for (const persona of doFramework.personas) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({ text: persona.name || 'Unnamed', bold: true, size: 24 }),
              ...(persona.isPrimary
                ? [new TextRun({ text: ' (Primary)', italics: true, size: 20, color: '0066CC' })]
                : []),
            ],
            spacing: { before: 200 },
          })
        );
        if (persona.description) {
          children.push(new Paragraph({ text: persona.description, spacing: { after: 100 } }));
        }
        for (const bg of persona.background || []) {
          children.push(
            new Paragraph({
              children: [new TextRun({ text: `  - ${bg}`, size: 20 })],
            })
          );
        }
      }
    }

    // Content heading
    children.push(
      new Paragraph({
        text: 'Content',
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 400, after: 200 },
      })
    );

    // Content paragraphs
    children.push(...this._contentToParagraphs(content, docx));

    return children;
  }

  /**
   * Build template-style document elements.
   * @private
   */
  _buildTemplate(title, content, framework, doFramework, keywords, docx) {
    const { Paragraph, TextRun, HeadingLevel } = docx;
    const children = [];

    // Title page
    children.push(new Paragraph({ spacing: { before: 4000 } }));
    children.push(
      new Paragraph({
        text: title,
        heading: HeadingLevel.TITLE,
        alignment: docx.AlignmentType.CENTER,
        spacing: { after: 300 },
      })
    );
    children.push(
      new Paragraph({
        children: [new TextRun({ text: 'Playbook Document', size: 28, color: '666666', italics: true })],
        alignment: docx.AlignmentType.CENTER,
        spacing: { after: 200 },
      })
    );
    children.push(
      new Paragraph({
        children: [new TextRun({ text: new Date().toLocaleDateString(), size: 20, color: '999999' })],
        alignment: docx.AlignmentType.CENTER,
      })
    );

    // Section: Framework
    children.push(
      new Paragraph({
        text: 'Framework Analysis',
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 600, after: 200 },
      })
    );
    children.push(this._buildFrameworkTable(framework, docx));

    // Section: Content
    children.push(
      new Paragraph({
        text: 'Content',
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 400, after: 200 },
      })
    );
    children.push(...this._contentToParagraphs(content, docx));

    return children;
  }

  /**
   * Build compact document elements.
   * @private
   */
  _buildCompact(title, content, framework, doFramework, keywords, docx) {
    const { Paragraph, TextRun, HeadingLevel } = docx;
    const children = [];

    // Title
    children.push(
      new Paragraph({
        text: title,
        heading: HeadingLevel.HEADING_1,
        spacing: { after: 200 },
      })
    );

    // Framework summary as a single paragraph
    const fwSummary = this._frameworkSummary(framework);
    if (fwSummary) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: 'Framework: ', bold: true, size: 20 }),
            new TextRun({ text: fwSummary, size: 20, color: '444444' }),
          ],
          spacing: { after: 200 },
        })
      );
    }

    // Content
    children.push(...this._contentToParagraphs(content, docx));

    return children;
  }

  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================

  /**
   * Build a DOCX table from the framework object.
   * @private
   */
  _buildFrameworkTable(framework, docx) {
    const { Table, TableRow, TableCell, Paragraph, TextRun, WidthType } = docx;

    const rows = [];

    const makeRow = (label, value) => {
      return new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: label, bold: true, size: 20 })] })],
            width: { size: 25, type: WidthType.PERCENTAGE },
            shading: { fill: 'F5F5F5' },
          }),
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: value || 'N/A', size: 20 })] })],
            width: { size: 75, type: WidthType.PERCENTAGE },
          }),
        ],
      });
    };

    if (framework.who) {
      rows.push(makeRow('WHO - Primary', framework.who.primary));
      rows.push(makeRow('WHO - Context', framework.who.context));
      rows.push(makeRow('WHO - Characteristics', (framework.who.characteristics || []).join(', ')));
    }
    if (framework.why) {
      rows.push(makeRow('WHY - Core Value', framework.why.coreValue));
      rows.push(makeRow('WHY - Emotional Hook', framework.why.emotionalHook));
      rows.push(makeRow('WHY - Practical Benefit', framework.why.practicalBenefit));
    }
    if (framework.what) {
      rows.push(makeRow('WHAT - Primary Action', framework.what.primaryAction));
      rows.push(makeRow('WHAT - Success', framework.what.successLooksLike));
      rows.push(makeRow('WHAT - Failure', framework.what.failureLooksLike));
    }
    if (framework.where) {
      rows.push(makeRow('WHERE - Platform', framework.where.platform));
      rows.push(makeRow('WHERE - Format', framework.where.format));
      rows.push(makeRow('WHERE - Distribution', framework.where.distribution));
    }
    if (framework.when?.raw) {
      rows.push(makeRow('WHEN', framework.when.raw));
    }

    if (rows.length === 0) {
      rows.push(makeRow('Framework', 'No framework data available'));
    }

    return new Table({
      rows,
      width: { size: 100, type: WidthType.PERCENTAGE },
    });
  }

  /**
   * Convert content string into DOCX Paragraph elements.
   * @private
   */
  _contentToParagraphs(content, docx) {
    const { Paragraph, TextRun, HeadingLevel } = docx;
    const paragraphs = [];
    const lines = (content || '').split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Headings
      const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const headingMap = {
          1: HeadingLevel.HEADING_1,
          2: HeadingLevel.HEADING_2,
          3: HeadingLevel.HEADING_3,
          4: HeadingLevel.HEADING_4,
          5: HeadingLevel.HEADING_5,
          6: HeadingLevel.HEADING_6,
        };
        paragraphs.push(
          new Paragraph({
            text: headingMatch[2],
            heading: headingMap[level] || HeadingLevel.HEADING_3,
            spacing: { before: 200, after: 100 },
          })
        );
        continue;
      }

      // List items
      if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        paragraphs.push(
          new Paragraph({
            children: [new TextRun({ text: `  ${trimmed}`, size: 22 })],
            spacing: { after: 50 },
          })
        );
        continue;
      }

      // Regular paragraphs
      paragraphs.push(
        new Paragraph({
          children: [new TextRun({ text: trimmed, size: 22 })],
          spacing: { after: 100 },
        })
      );
    }

    return paragraphs;
  }

  /**
   * Create a brief framework summary string.
   * @private
   */
  _frameworkSummary(fw) {
    const parts = [];
    if (fw.who?.primary) parts.push(`For ${fw.who.primary}`);
    if (fw.why?.coreValue) parts.push(`because ${fw.why.coreValue}`);
    if (fw.what?.primaryAction) parts.push(`to ${fw.what.primaryAction}`);
    if (fw.where?.platform) parts.push(`on ${fw.where.platform}`);
    return parts.join(', ') || '';
  }
}

module.exports = { PlaybookToDocxAgent };
