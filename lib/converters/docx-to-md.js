/**
 * DocxToMdAgent
 *
 * @description Converts DOCX (Word) files to Markdown. Uses mammoth to extract
 *   HTML from the DOCX, then TurndownService to convert HTML to Markdown.
 *   Supports standard conversion, direct extraction, and AI-enhanced semantic
 *   post-processing for cleaner output.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/docx-to-md
 *
 * @strategies
 *   - mammoth-md : Convert DOCX to HTML via mammoth, then to Markdown via turndown
 *   - direct     : Extract raw text from DOCX and apply basic Markdown formatting
 *   - semantic   : mammoth-md pipeline followed by AI post-processing for cleanup
 *
 * @example
 *   const { DocxToMdAgent } = require('./docx-to-md');
 *   const agent = new DocxToMdAgent();
 *   const result = await agent.convert(docxBuffer);
 *   // result.output => '# Document Title\n\nParagraph text here...'
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

class DocxToMdAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:docx-to-md';
    this.name = 'DOCX to Markdown';
    this.description = 'Converts DOCX (Word) files to Markdown using mammoth and turndown';
    this.from = ['docx'];
    this.to = ['md', 'markdown'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'mammoth-md',
        description: 'Convert DOCX to HTML via mammoth, then to Markdown via TurndownService',
        when: 'Standard conversion for well-formed Word documents',
        engine: 'mammoth + turndown',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Good fidelity for typical Word documents with headings, lists, and tables',
      },
      {
        id: 'direct',
        description: 'Extract raw text and apply basic Markdown formatting heuristics',
        when: 'Document is simple or mammoth/turndown pipeline produces artifacts',
        engine: 'mammoth',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Basic Markdown from raw text; loses complex formatting',
      },
      {
        id: 'semantic',
        description: 'mammoth-md pipeline followed by AI post-processing for cleaner output',
        when: 'Output needs polishing, deduplication, or structural improvements',
        engine: 'mammoth + turndown + AI',
        mode: 'symbolic',
        speed: 'medium',
        quality: 'Highest quality with AI cleanup of artifacts and formatting',
      },
    ];
  }

  /**
   * Execute the DOCX-to-Markdown conversion.
   *
   * @param {Buffer} input - DOCX file buffer to convert
   * @param {string} strategy - Strategy ID: 'mammoth-md' | 'direct' | 'semantic'
   * @param {Object} [options] - Additional conversion options
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, _options = {}) {
    const start = Date.now();
    let output;

    switch (strategy) {
      case 'direct': {
        output = await this._executeDirect(input);
        break;
      }
      case 'semantic': {
        output = await this._executeSemantic(input);
        break;
      }
      case 'mammoth-md':
      default: {
        output = await this._executeMammothMd(input);
        break;
      }
    }

    return {
      output,
      metadata: {
        strategy,
        inputLength: input.length,
        outputLength: output.length,
        mimeType: 'text/markdown',
        extension: 'md',
      },
      duration: Date.now() - start,
      strategy,
    };
  }

  /**
   * mammoth-md: DOCX -> HTML (mammoth) -> Markdown (turndown).
   * @private
   */
  async _executeMammothMd(input) {
    const mammoth = require('mammoth');
    const TurndownService = require('turndown');

    const result = await mammoth.convertToHtml({ buffer: input });
    const html = result.value;

    const turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
      emDelimiter: '*',
      strongDelimiter: '**',
    });

    let md = turndown.turndown(html);
    md = md.replace(/\n{3,}/g, '\n\n').trim();

    return md;
  }

  /**
   * Direct: extract raw text and apply basic Markdown formatting.
   * @private
   */
  async _executeDirect(input) {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer: input });
    const text = result.value;

    // Apply basic Markdown heuristics
    const lines = text.split('\n');
    const mdLines = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.length === 0) {
        mdLines.push('');
        continue;
      }

      // Detect possible headings: short lines followed by blank lines
      const nextLine = lines[i + 1]?.trim() || '';
      const prevLine = lines[i - 1]?.trim() || '';
      const isShort = line.length < 80;
      const followedByBlank = nextLine.length === 0;
      const precededByBlank = prevLine.length === 0 || i === 0;

      if (isShort && followedByBlank && precededByBlank && !line.includes('.')) {
        // Likely a heading
        mdLines.push(`## ${line}`);
      } else {
        mdLines.push(line);
      }
    }

    return mdLines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Semantic: run mammoth-md pipeline, then AI post-processing.
   * @private
   */
  async _executeSemantic(input) {
    let md = await this._executeMammothMd(input);

    if (this._ai) {
      try {
        const cleaned = await this._ai.complete(
          `Clean up the following Markdown that was converted from a Word document.
Fix any conversion artifacts, ensure consistent heading levels, remove duplicate content,
and improve formatting. Preserve all original content and meaning.
Return ONLY the cleaned Markdown, no explanation.

${md.substring(0, 8000)}`,
          { profile: 'fast', feature: 'converter-docx-semantic', temperature: 0.2 }
        );
        if (cleaned && cleaned.trim().length > 0) {
          md = cleaned.trim();
        }
      } catch (_err) {
        // Fall back to uncleaned version
      }
    }

    return md;
  }

  /**
   * Structural checks for DOCX-to-Markdown conversion output.
   *
   * Validates that the output is a non-empty string containing Markdown syntax.
   *
   * @param {Buffer} input - Original DOCX buffer
   * @param {*} output - Conversion output to validate
   * @param {string} strategy - Strategy that was used
   * @returns {Promise<import('./base-converter-agent').EvaluationIssue[]>}
   */
  async _structuralChecks(input, output, _strategy) {
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

    // Check for Markdown content indicators
    const hasMarkdown =
      /^#{1,6}\s/m.test(output) || /\*\*[^*]+\*\*/m.test(output) || /^[-*]\s/m.test(output) || /^\d+\.\s/m.test(output);

    if (!hasMarkdown && output.length > 100) {
      issues.push({
        code: 'NO_MARKDOWN_SYNTAX',
        severity: 'warning',
        message: 'Output does not contain recognizable Markdown syntax (headings, bold, lists)',
        fixable: true,
        suggestedStrategy: 'direct',
      });
    }

    return issues;
  }
}

module.exports = { DocxToMdAgent };
