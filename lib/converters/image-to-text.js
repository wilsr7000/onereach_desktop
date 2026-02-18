/**
 * ImageToTextAgent
 *
 * @description Converts images to text using AI vision. Supports natural
 *   language captioning, structured OCR text extraction, and exhaustive
 *   detail analysis.
 *
 * @agent converter:image-to-text
 * @from png, jpg, jpeg, webp, gif, tiff, bmp
 * @to   text
 * @modes generative
 *
 * @strategies
 *   - describe : Natural language caption of the image contents
 *   - ocr      : Structured extraction of all visible text in the image
 *   - detailed : Exhaustive analysis covering composition, subjects, colours,
 *                text, context, and spatial relationships
 *
 * @evaluation
 *   Structural checks verify the output is a non-empty string of at least
 *   10 characters. Generative quality is further judged via LLM spot-check
 *   (inherited from BaseConverterAgent).
 *
 * @input  {Buffer} Raw image bytes (any supported raster format)
 * @output {string} Text representation of the image
 *
 * @example
 *   const { ImageToTextAgent } = require('./image-to-text');
 *   const agent = new ImageToTextAgent();
 *   const result = await agent.convert(imageBuffer, { strategy: 'ocr' });
 *   // result.output -> "Invoice #12345\nDate: 2026-01-15\n..."
 *
 * @dependencies lib/ai-service.js (vision profile)
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

/**
 * System prompts tailored to each extraction strategy.
 * @private
 */
const STRATEGY_PROMPTS = {
  describe: [
    'You are an expert image analyst. Provide a concise natural language',
    'caption of the image. Focus on the main subject, setting, and any',
    'notable details. Write 1-3 sentences in plain English. Do not include',
    'any markdown formatting or prefixes.',
  ].join(' '),

  ocr: [
    'You are a precise OCR engine. Extract ALL visible text from the image',
    'exactly as it appears. Preserve line breaks, spacing, and reading order.',
    'If text is arranged in columns or tables, maintain that structure.',
    'Output ONLY the extracted text with no additional commentary.',
    'If no text is visible, respond with "[NO_TEXT_FOUND]".',
  ].join(' '),

  detailed: [
    'You are a meticulous image analyst. Provide an exhaustive description',
    'of the image covering ALL of the following aspects:',
    '1. Primary subjects and their positions',
    '2. Background and setting',
    '3. Colours, lighting, and mood',
    '4. Any visible text (transcribe exactly)',
    '5. Spatial relationships between elements',
    '6. Style or medium (photograph, illustration, screenshot, etc.)',
    '7. Notable details that might otherwise be missed',
    'Be thorough but avoid speculation. Describe only what is visible.',
  ].join(' '),
};

/**
 * User-level prompts that accompany the image for each strategy.
 * @private
 */
const USER_PROMPTS = {
  describe: 'Describe this image in 1-3 sentences.',
  ocr: 'Extract all visible text from this image.',
  detailed: 'Provide an exhaustive, detailed analysis of this image.',
};

class ImageToTextAgent extends BaseConverterAgent {
  constructor(config = {}) {
    super(config);

    this.id = 'converter:image-to-text';
    this.name = 'Image to Text Converter';
    this.description = 'Converts images to text via AI vision (captioning, OCR, detailed analysis)';
    this.from = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'tiff', 'bmp'];
    this.to = ['text'];
    this.modes = ['generative'];

    this.strategies = [
      {
        id: 'describe',
        description: 'Natural language caption of the image',
        when: 'A brief human-readable summary is needed',
        engine: 'ai-vision',
        mode: 'generative',
        speed: 'medium',
        quality: 'Concise 1-3 sentence caption',
      },
      {
        id: 'ocr',
        description: 'Structured extraction of all visible text',
        when: 'The image contains text (documents, signs, screenshots) that must be captured verbatim',
        engine: 'ai-vision',
        mode: 'generative',
        speed: 'medium',
        quality: 'High-fidelity text extraction preserving layout',
      },
      {
        id: 'detailed',
        description: 'Exhaustive visual analysis of composition, subjects, colours, and context',
        when: 'Maximum detail is required for indexing, accessibility, or downstream reasoning',
        engine: 'ai-vision',
        mode: 'generative',
        speed: 'slow',
        quality: 'Comprehensive multi-paragraph description',
      },
    ];
  }

  // ===========================================================================
  // EXECUTE
  // ===========================================================================

  /**
   * Process an image through AI vision with the chosen strategy prompt.
   *
   * @param {Buffer} input - Source image bytes
   * @param {string} strategy - 'describe' | 'ocr' | 'detailed'
   * @param {Object} [options]
   * @param {string} [options.customPrompt] - Override the default user prompt
   * @param {number} [options.maxTokens]    - Limit response length
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    if (!this._ai) {
      throw new Error('AI service is not available. Cannot perform vision analysis.');
    }
    if (!Buffer.isBuffer(input) && typeof input !== 'string') {
      throw new Error('Input must be a Buffer (image bytes) or a base64 string');
    }
    if (Buffer.isBuffer(input) && input.length === 0) {
      throw new Error('Input image buffer is empty');
    }

    const start = Date.now();

    // Prepare image data for the vision API
    const imageData = Buffer.isBuffer(input) ? input.toString('base64') : input;

    const systemPrompt = STRATEGY_PROMPTS[strategy];
    if (!systemPrompt) {
      throw new Error(`Unknown strategy: ${strategy}. Expected one of: ${Object.keys(STRATEGY_PROMPTS).join(', ')}`);
    }

    const userPrompt = options.customPrompt || USER_PROMPTS[strategy];

    const visionResult = await this._ai.vision(imageData, userPrompt, {
      profile: 'vision',
      system: systemPrompt,
      maxTokens: options.maxTokens || this._maxTokensForStrategy(strategy),
      temperature: strategy === 'ocr' ? 0 : 0.3,
      feature: `converter-image-to-text-${strategy}`,
    });

    // ai.vision may return a string directly or a result object
    const text =
      typeof visionResult === 'string'
        ? visionResult
        : visionResult?.content || visionResult?.text || String(visionResult);

    return {
      output: text.trim(),
      metadata: {
        strategy,
        charCount: text.trim().length,
        wordCount: text.trim().split(/\s+/).length,
        inputSize: Buffer.isBuffer(input) ? input.length : imageData.length,
      },
      duration: Date.now() - start,
      strategy,
    };
  }

  // ===========================================================================
  // STRUCTURAL CHECKS
  // ===========================================================================

  /**
   * Verify the text output meets minimum expectations.
   *
   * @param {Buffer} input
   * @param {string} output
   * @param {string} strategy
   * @returns {Promise<import('./base-converter-agent').EvaluationIssue[]>}
   */
  async _structuralChecks(input, output, strategy) {
    const issues = [];

    if (typeof output !== 'string') {
      issues.push({
        code: 'NOT_STRING',
        severity: 'error',
        message: `Output is ${typeof output}, expected string`,
        fixable: true,
      });
      return issues;
    }

    if (output.trim().length === 0) {
      issues.push({
        code: 'EMPTY_TEXT',
        severity: 'error',
        message: 'Vision analysis returned empty text',
        fixable: true,
      });
      return issues;
    }

    if (output.trim().length < 10) {
      issues.push({
        code: 'TEXT_TOO_SHORT',
        severity: 'error',
        message: `Output is only ${output.trim().length} characters (minimum 10)`,
        fixable: true,
        suggestedStrategy: strategy === 'describe' ? 'detailed' : undefined,
      });
    }

    // OCR-specific: warn if the model returned a refusal instead of text
    if (strategy === 'ocr') {
      const refusalPatterns = [/i cannot/i, /i'm unable/i, /i can't/i, /sorry,?\s+i/i, /as an ai/i];
      const isRefusal = refusalPatterns.some((p) => p.test(output.substring(0, 100)));
      if (isRefusal && !output.includes('[NO_TEXT_FOUND]')) {
        issues.push({
          code: 'POSSIBLE_REFUSAL',
          severity: 'warning',
          message: 'Output may be a model refusal rather than extracted text',
          fixable: true,
          suggestedStrategy: 'ocr',
        });
      }
    }

    // Detailed strategy should produce substantial output
    if (strategy === 'detailed' && output.trim().length < 100) {
      issues.push({
        code: 'DETAIL_TOO_SHORT',
        severity: 'warning',
        message: `Detailed analysis is only ${output.trim().length} characters; expected comprehensive output`,
        fixable: true,
      });
    }

    return issues;
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  /**
   * Return sensible max token limits per strategy.
   * @private
   */
  _maxTokensForStrategy(strategy) {
    switch (strategy) {
      case 'describe':
        return 300;
      case 'ocr':
        return 2000;
      case 'detailed':
        return 2000;
      default:
        return 1000;
    }
  }

  /**
   * Override input description for LLM planning context.
   * @override
   */
  _describeInput(input, metadata = {}) {
    if (Buffer.isBuffer(input)) {
      const kb = (input.length / 1024).toFixed(1);
      return `Image buffer (${kb} KB) to be analysed for text content. ${metadata.mimeType || ''} ${metadata.fileName || ''}`.trim();
    }
    if (typeof input === 'string') {
      return `Base64-encoded image string (${(input.length / 1024).toFixed(1)} KB encoded)`;
    }
    return super._describeInput(input, metadata);
  }
}

module.exports = { ImageToTextAgent };
