/**
 * MdToTextAgent
 *
 * @description Converts Markdown content to plain text by stripping formatting.
 *   Supports simple regex stripping, readable conversion that preserves
 *   visual structure through spacing and capitalization, and outline mode
 *   that extracts only headings and first sentences.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/md-to-text
 *
 * @strategies
 *   - strip    : Regex-based removal of all Markdown syntax
 *   - readable : Preserves structure via caps headings, blank line spacing
 *   - outline  : Extracts only headings and first sentence after each heading
 *
 * @example
 *   const { MdToTextAgent } = require('./md-to-text');
 *   const agent = new MdToTextAgent();
 *   const result = await agent.convert('# Hello\n\n**Bold** text here');
 *   // result.output => 'Hello\n\nBold text here'
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

class MdToTextAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:md-to-text';
    this.name = 'Markdown to Plain Text';
    this.description = 'Converts Markdown content to plain text by stripping formatting';
    this.from = ['md', 'markdown'];
    this.to = ['text'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'strip',
        description: 'Regex-based removal of all Markdown syntax characters',
        when: 'You need clean text with no formatting artifacts at all',
        engine: 'regex',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Clean plain text, loses all structure',
      },
      {
        id: 'readable',
        description: 'Preserves visual structure via capitalized headings and blank line spacing',
        when: 'Output needs to be human-readable while still being plain text',
        engine: 'regex',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Readable plain text with visual hierarchy',
      },
      {
        id: 'outline',
        description: 'Extracts only headings and the first sentence after each heading',
        when: 'You need a summary or table of contents from the document',
        engine: 'regex',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Compact outline suitable for summaries',
      },
    ];
  }

  /**
   * Execute the Markdown-to-text conversion.
   *
   * @param {string} input - Markdown content to convert
   * @param {string} strategy - Strategy ID: 'strip' | 'readable' | 'outline'
   * @param {Object} [options] - Additional conversion options
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const start = Date.now();
    let output;

    switch (strategy) {
      case 'strip': {
        output = this._stripMarkdown(input);
        break;
      }

      case 'readable': {
        output = this._readableConvert(input);
        break;
      }

      case 'outline': {
        output = this._outlineConvert(input);
        break;
      }

      default: {
        output = this._stripMarkdown(input);
        break;
      }
    }

    return {
      output,
      metadata: {
        strategy,
        inputLength: input.length,
        outputLength: output.length,
        compressionRatio: input.length > 0 ? (output.length / input.length).toFixed(2) : '0',
      },
      duration: Date.now() - start,
      strategy,
    };
  }

  /**
   * Strip all Markdown syntax using regex patterns.
   *
   * @param {string} text - Markdown content
   * @returns {string} Plain text with all formatting removed
   * @private
   */
  _stripMarkdown(text) {
    let result = text;

    // Remove code blocks (fenced)
    result = result.replace(/```[\s\S]*?```/g, (match) => {
      // Keep the code content, strip the fences
      return match.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
    });

    // Remove inline code
    result = result.replace(/`([^`]+)`/g, '$1');

    // Remove images (keep alt text)
    result = result.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');

    // Remove links (keep text)
    result = result.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

    // Remove reference links
    result = result.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1');

    // Remove heading markers
    result = result.replace(/^#{1,6}\s+/gm, '');

    // Remove bold/italic
    result = result.replace(/\*\*\*(.+?)\*\*\*/g, '$1');
    result = result.replace(/\*\*(.+?)\*\*/g, '$1');
    result = result.replace(/\*(.+?)\*/g, '$1');
    result = result.replace(/___(.+?)___/g, '$1');
    result = result.replace(/__(.+?)__/g, '$1');
    result = result.replace(/_(.+?)_/g, '$1');

    // Remove strikethrough
    result = result.replace(/~~(.+?)~~/g, '$1');

    // Remove horizontal rules
    result = result.replace(/^[-*_]{3,}\s*$/gm, '');

    // Remove blockquote markers
    result = result.replace(/^>\s?/gm, '');

    // Remove unordered list markers
    result = result.replace(/^[\s]*[-*+]\s+/gm, '');

    // Remove ordered list markers
    result = result.replace(/^[\s]*\d+\.\s+/gm, '');

    // Remove HTML tags
    result = result.replace(/<[^>]+>/g, '');

    // Remove reference definitions
    result = result.replace(/^\[[^\]]*\]:\s+.*$/gm, '');

    // Collapse multiple blank lines
    result = result.replace(/\n{3,}/g, '\n\n');

    return result.trim();
  }

  /**
   * Convert Markdown to readable plain text preserving structure.
   *
   * Headings become CAPITALIZED, blank lines preserved for visual hierarchy.
   *
   * @param {string} text - Markdown content
   * @returns {string} Readable plain text
   * @private
   */
  _readableConvert(text) {
    const lines = text.split('\n');
    const output = [];

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];

      // Convert headings to CAPS with surrounding blank lines
      const headingMatch = line.match(/^(#{1,6})\s+(.*)/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const title = this._stripInline(headingMatch[2]).toUpperCase();
        if (level <= 2) {
          output.push('');
          output.push(title);
          output.push('='.repeat(Math.min(title.length, 60)));
          output.push('');
        } else {
          output.push('');
          output.push(title);
          output.push('');
        }
        continue;
      }

      // Convert code fences to indented blocks
      if (/^```/.test(line)) {
        // Find matching closing fence
        let j = i + 1;
        while (j < lines.length && !/^```/.test(lines[j])) {
          output.push('    ' + lines[j]);
          j++;
        }
        i = j; // Skip past closing fence
        continue;
      }

      // Convert blockquotes
      if (/^>\s?/.test(line)) {
        line = '  | ' + line.replace(/^>\s?/, '');
      }

      // Convert list items (preserve indentation)
      const listMatch = line.match(/^(\s*)[-*+]\s+(.*)/);
      if (listMatch) {
        line = listMatch[1] + '- ' + this._stripInline(listMatch[2]);
      }

      const orderedMatch = line.match(/^(\s*)\d+\.\s+(.*)/);
      if (orderedMatch) {
        line = orderedMatch[1] + '- ' + this._stripInline(orderedMatch[2]);
      }

      // Remove horizontal rules
      if (/^[-*_]{3,}\s*$/.test(line)) {
        output.push('');
        continue;
      }

      // Strip remaining inline markdown
      line = this._stripInline(line);
      output.push(line);
    }

    return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /**
   * Extract an outline: headings and the first sentence after each.
   *
   * @param {string} text - Markdown content
   * @returns {string} Outline text
   * @private
   */
  _outlineConvert(text) {
    const lines = text.split('\n');
    const output = [];
    let lastWasHeading = false;
    let capturedSentence = false;

    for (const line of lines) {
      const headingMatch = line.match(/^(#{1,6})\s+(.*)/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const indent = '  '.repeat(level - 1);
        const title = this._stripInline(headingMatch[2]);
        output.push(indent + title);
        lastWasHeading = true;
        capturedSentence = false;
        continue;
      }

      // After a heading, capture the first non-empty sentence
      if (lastWasHeading && !capturedSentence) {
        const trimmed = line.trim();
        if (trimmed.length > 0 && !/^[-*_]{3,}/.test(trimmed) && !/^```/.test(trimmed)) {
          const clean = this._stripInline(trimmed);
          // Extract first sentence (up to period, question mark, or exclamation)
          const sentenceMatch = clean.match(/^[^.!?]*[.!?]/);
          const sentence = sentenceMatch ? sentenceMatch[0].trim() : clean;
          const level = output.length > 0 ? (output[output.length - 1].match(/^(\s*)/)[1].length / 2) + 1 : 1;
          const indent = '  '.repeat(level);
          output.push(indent + '> ' + sentence);
          capturedSentence = true;
          lastWasHeading = false;
        }
      }
    }

    return output.join('\n').trim();
  }

  /**
   * Strip inline Markdown formatting (bold, italic, code, links, images).
   *
   * @param {string} text - Text with inline Markdown
   * @returns {string} Text with inline formatting removed
   * @private
   */
  _stripInline(text) {
    return text
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')       // Images
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')         // Links
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')        // Reference links
      .replace(/`([^`]+)`/g, '$1')                     // Inline code
      .replace(/\*\*\*(.+?)\*\*\*/g, '$1')             // Bold+italic
      .replace(/\*\*(.+?)\*\*/g, '$1')                 // Bold
      .replace(/\*(.+?)\*/g, '$1')                     // Italic
      .replace(/___(.+?)___/g, '$1')                   // Bold+italic (underscore)
      .replace(/__(.+?)__/g, '$1')                     // Bold (underscore)
      .replace(/_(.+?)_/g, '$1')                       // Italic (underscore)
      .replace(/~~(.+?)~~/g, '$1');                    // Strikethrough
  }

  /**
   * Structural checks for Markdown-to-text conversion output.
   *
   * Validates that the output is a non-empty string. For the 'strip' strategy,
   * also verifies that no Markdown syntax remains.
   *
   * @param {string} input - Original Markdown input
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
        message: 'Text output is empty',
        fixable: true,
      });
      return issues;
    }

    // For strip strategy, check that markdown syntax is gone
    if (strategy === 'strip') {
      // Check for remaining heading markers
      if (/^#{1,6}\s/m.test(output)) {
        issues.push({
          code: 'REMAINING_HEADINGS',
          severity: 'warning',
          message: 'Output still contains Markdown heading markers',
          fixable: true,
        });
      }

      // Check for remaining bold/italic markers
      if (/\*\*[^*]+\*\*/.test(output) || /__[^_]+__/.test(output)) {
        issues.push({
          code: 'REMAINING_EMPHASIS',
          severity: 'warning',
          message: 'Output still contains Markdown bold/italic markers',
          fixable: true,
        });
      }

      // Check for remaining link syntax
      if (/\[[^\]]+\]\([^)]+\)/.test(output)) {
        issues.push({
          code: 'REMAINING_LINKS',
          severity: 'warning',
          message: 'Output still contains Markdown link syntax',
          fixable: true,
        });
      }

      // Check for remaining code fences
      if (/^```/m.test(output)) {
        issues.push({
          code: 'REMAINING_CODE_FENCES',
          severity: 'warning',
          message: 'Output still contains code fence markers',
          fixable: true,
        });
      }
    }

    return issues;
  }
}

module.exports = { MdToTextAgent };
