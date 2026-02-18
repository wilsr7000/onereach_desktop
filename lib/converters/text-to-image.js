/**
 * TextToImageConverter
 *
 * @description Converts text content to images using generative AI. Supports
 *   literal image generation (matching text exactly), artistic/creative
 *   interpretation, and technical diagram generation.
 *
 * @agent converter:text-to-image
 * @from text
 * @to   png, jpg, webp
 *
 * @modes generative
 *
 * @strategies
 *   - literal   -- Generate an image that visually matches the text description
 *                  as faithfully as possible.
 *   - artistic  -- Creative, stylized interpretation of the text content with
 *                  artistic license for composition, colour palette, and mood.
 *   - diagram   -- Generate a technical diagram, flowchart, or schematic that
 *                  represents the structure described in the text.
 *
 * @evaluation
 *   Structural: output must be a non-empty Buffer larger than 1 KB (a valid
 *   image is always at least a few KB). Generative quality is further judged
 *   via the inherited LLM spot-check from BaseConverterAgent.
 *
 * @input  {string} Plain text description or content to convert into an image.
 * @output {Buffer} Image buffer in the target format (png, jpg, or webp).
 *
 * @example
 *   const { TextToImageConverter } = require('./text-to-image');
 *   const converter = new TextToImageConverter();
 *   const result = await converter.convert('A serene mountain lake at sunset', {
 *     targetFormat: 'png',
 *   });
 *   // result.output is a Buffer containing PNG image data
 *
 * @dependencies
 *   - lib/ai-service.js (imageGenerate or chat with vision profile)
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

// Minimum valid image size in bytes (1 KB)
const MIN_IMAGE_BYTES = 1024;

/**
 * System prompts tailored to each generation strategy.
 * Used when falling back to chat-based generation.
 * @private
 */
const STRATEGY_PROMPTS = {
  literal: [
    'Generate an image that faithfully and literally matches the following',
    'description. Focus on accuracy and precision. Every element mentioned in',
    'the text should be visually represented exactly as described, with no',
    'artistic embellishment or creative reinterpretation.',
  ].join(' '),

  artistic: [
    'Create an artistic, visually striking interpretation of the following',
    'text. You have creative license over composition, colour palette, style,',
    'and mood. The image should capture the essence and emotion of the text',
    'rather than a literal depiction. Aim for a polished, gallery-quality result.',
  ].join(' '),

  diagram: [
    'Generate a clean, professional technical diagram that represents the',
    'structure, flow, or relationships described in the following text.',
    'Use clear labels, arrows, boxes, and standard diagramming conventions.',
    'The diagram should be immediately understandable by a technical audience.',
    'Use a white background with dark lines and minimal colour.',
  ].join(' '),
};

/**
 * Quality hints per strategy for DALL-E generation.
 * @private
 */
const QUALITY_MAP = {
  literal: 'standard',
  artistic: 'hd',
  diagram: 'standard',
};

class TextToImageConverter extends BaseConverterAgent {
  /**
   * @param {Object} [config]
   * @param {Object} [config.ai] - AI service override (testing)
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:text-to-image';
    this.name = 'Text to Image Converter';
    this.description = 'Converts text descriptions to images using generative AI';

    this.from = ['text'];
    this.to = ['png', 'jpg', 'webp'];
    this.modes = ['generative'];

    this.strategies = [
      {
        id: 'literal',
        description: 'Generate an image matching the text description exactly',
        when: 'User wants a faithful, literal visual representation of their text',
        engine: 'ai-image-generation',
        mode: 'generative',
        speed: 'medium',
        quality: 'Accurate, precise depiction of every element described',
      },
      {
        id: 'artistic',
        description: 'Creative, stylized interpretation of the text',
        when: 'Creative content, mood pieces, or when visual style matters more than precision',
        engine: 'ai-image-generation',
        mode: 'generative',
        speed: 'medium',
        quality: 'Visually striking, gallery-quality artistic interpretation',
      },
      {
        id: 'diagram',
        description: 'Technical diagram, flowchart, or schematic from text',
        when: 'Text describes a system, process, or structure that benefits from diagramming',
        engine: 'ai-image-generation',
        mode: 'generative',
        speed: 'medium',
        quality: 'Clean, professional diagram with labels and arrows',
      },
    ];
  }

  // ===========================================================================
  // EXECUTE
  // ===========================================================================

  /**
   * Generate an image from text using the chosen strategy.
   *
   * Attempts the following in order:
   *   1. ai.imageGenerate() -- DALL-E direct generation (preferred)
   *   2. ai.imageEdit()     -- if available as a fallback
   *   3. ai.chat() with vision profile -- last-resort descriptive fallback
   *
   * @param {string} input - Text description to convert to an image
   * @param {string} strategy - 'literal' | 'artistic' | 'diagram'
   * @param {Object} [options]
   * @param {string} [options.targetFormat] - 'png', 'jpg', or 'webp' (default 'png')
   * @param {string} [options.size]         - Image dimensions (default '1024x1024')
   * @param {string} [options.model]        - Model override (default 'dall-e-3')
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const startTime = Date.now();

    if (!this._ai) {
      throw new Error('AI service is required for text-to-image conversion');
    }

    if (typeof input !== 'string' || input.trim().length === 0) {
      throw new Error('Input must be a non-empty text string');
    }

    const targetFormat = (options.targetFormat || 'png').toLowerCase();
    if (!this.to.includes(targetFormat)) {
      throw new Error(`Unsupported target format: ${targetFormat}. Supported: ${this.to.join(', ')}`);
    }

    const size = options.size || '1024x1024';
    const model = options.model || 'dall-e-3';
    const prompt = this._buildPrompt(input, strategy);
    const quality = QUALITY_MAP[strategy] || 'standard';

    let imageBuffer;

    // -------------------------------------------------------------------
    // Strategy 1: ai.imageGenerate() -- preferred path (DALL-E)
    // -------------------------------------------------------------------
    if (typeof this._ai.imageGenerate === 'function') {
      try {
        const result = await this._ai.imageGenerate(prompt, {
          model,
          size,
          quality,
          responseFormat: 'b64_json',
          feature: `converter-text-to-image-${strategy}`,
        });

        if (result && result.images && result.images.length > 0) {
          const b64 = result.images[0].b64_json || result.images[0].url;
          if (b64 && !b64.startsWith('http')) {
            imageBuffer = Buffer.from(b64, 'base64');
          } else if (b64) {
            // URL-based result -- we return the URL as metadata and try to
            // fetch the image bytes (non-critical if it fails)
            imageBuffer = await this._fetchImageUrl(b64);
          }
        }
      } catch (err) {
        this.logger.log('converter:execute:warn', {
          message: `imageGenerate failed, trying fallback: ${err.message}`,
          error: err.message,
        });
      }
    }

    // -------------------------------------------------------------------
    // Strategy 2: ai.imageEdit() -- fallback if imageGenerate unavailable
    // -------------------------------------------------------------------
    if (!imageBuffer && typeof this._ai.imageEdit === 'function') {
      try {
        const result = await this._ai.imageEdit(prompt, {
          model,
          size,
          feature: `converter-text-to-image-${strategy}`,
        });

        if (result && Buffer.isBuffer(result)) {
          imageBuffer = result;
        } else if (result && result.b64_json) {
          imageBuffer = Buffer.from(result.b64_json, 'base64');
        }
      } catch (err) {
        this.logger.log('converter:execute:warn', {
          message: `imageEdit fallback failed: ${err.message}`,
          error: err.message,
        });
      }
    }

    // -------------------------------------------------------------------
    // Strategy 3: ai.chat() with image generation prompt -- last resort
    // -------------------------------------------------------------------
    if (!imageBuffer) {
      try {
        const chatResult = await this._ai.chat({
          profile: 'powerful',
          feature: `converter-text-to-image-${strategy}`,
          temperature: 0.7,
          system: STRATEGY_PROMPTS[strategy] || STRATEGY_PROMPTS.literal,
          messages: [
            {
              role: 'user',
              content: `Generate an image based on this description. If you cannot generate an image directly, describe in detail what the image should look like so it can be generated separately.\n\nDescription: ${input}`,
            },
          ],
          maxTokens: 1000,
        });

        const content = chatResult?.content || '';

        // If the chat returned base64 image data (unlikely but possible)
        if (content.length > 1000 && /^[A-Za-z0-9+/=]+$/.test(content.trim())) {
          imageBuffer = Buffer.from(content.trim(), 'base64');
        }

        // If we still don't have a buffer, throw to surface the issue clearly
        if (!imageBuffer) {
          throw new Error(
            'Image generation is not available through any AI service method. ' +
              'Ensure ai.imageGenerate() is configured (requires DALL-E API access).'
          );
        }
      } catch (chatErr) {
        throw new Error(
          `Text-to-image conversion failed: no image generation method available. ` +
            `Tried imageGenerate, imageEdit, and chat fallback. Last error: ${chatErr.message}`
        );
      }
    }

    return {
      output: imageBuffer,
      metadata: {
        format: targetFormat,
        strategy,
        model,
        size,
        quality,
        promptLength: prompt.length,
        inputLength: input.length,
        outputSize: imageBuffer.length,
      },
      duration: Date.now() - startTime,
      strategy,
    };
  }

  // ===========================================================================
  // STRUCTURAL CHECKS
  // ===========================================================================

  /**
   * Verify the output is a non-empty Buffer larger than 1 KB.
   * A valid image (even a tiny one) will always exceed 1 KB.
   *
   * @param {string} input - Original text input
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
        message: `Expected output to be a Buffer, got ${typeof output}`,
        fixable: true,
      });
      return issues;
    }

    if (output.length === 0) {
      issues.push({
        code: 'OUTPUT_EMPTY',
        severity: 'error',
        message: 'Image generation produced an empty buffer',
        fixable: true,
      });
      return issues;
    }

    if (output.length < MIN_IMAGE_BYTES) {
      issues.push({
        code: 'IMAGE_TOO_SMALL',
        severity: 'error',
        message: `Image buffer is only ${output.length} bytes (minimum ${MIN_IMAGE_BYTES} bytes / 1 KB for a valid image)`,
        fixable: true,
      });
    }

    // Quick magic-byte sniff for common image formats
    const header = output.slice(0, 8);
    const isPNG = header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47;
    const isJPEG = header[0] === 0xff && header[1] === 0xd8;
    const isWEBP =
      header.length >= 8 &&
      header[0] === 0x52 &&
      header[1] === 0x49 &&
      header[2] === 0x46 &&
      header[3] === 0x46 &&
      output.length >= 12 &&
      output[8] === 0x57 &&
      output[9] === 0x45 &&
      output[10] === 0x42 &&
      output[11] === 0x50;

    if (!isPNG && !isJPEG && !isWEBP) {
      issues.push({
        code: 'UNKNOWN_IMAGE_FORMAT',
        severity: 'warning',
        message: 'Output buffer does not start with PNG, JPEG, or WebP magic bytes',
        fixable: false,
      });
    }

    return issues;
  }

  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================

  /**
   * Build the generation prompt by combining strategy context with user input.
   * @private
   * @param {string} input - User text
   * @param {string} strategy - Strategy ID
   * @returns {string} Full prompt for image generation
   */
  _buildPrompt(input, strategy) {
    const strategyPrefix = STRATEGY_PROMPTS[strategy] || '';
    // For DALL-E, the prompt should be concise and descriptive
    const trimmedInput = input.length > 3000 ? input.substring(0, 3000) + '...' : input;
    return `${strategyPrefix}\n\n${trimmedInput}`.trim();
  }

  /**
   * Attempt to fetch image bytes from a URL.
   * Returns null on failure instead of throwing.
   * @private
   * @param {string} url - Image URL
   * @returns {Promise<Buffer|null>}
   */
  async _fetchImageUrl(url) {
    try {
      const https = require('https');
      const http = require('http');
      const client = url.startsWith('https') ? https : http;

      return new Promise((resolve) => {
        const req = client.get(url, { timeout: 30000 }, (res) => {
          if (res.statusCode !== 200) {
            resolve(null);
            return;
          }
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', () => resolve(null));
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => {
          req.destroy();
          resolve(null);
        });
      });
    } catch {
      return null;
    }
  }

  /**
   * Override input description for LLM planning context.
   * @override
   */
  _describeInput(input, metadata = {}) {
    if (typeof input === 'string') {
      const wordCount = input.split(/\s+/).length;
      const preview = input.substring(0, 150);
      return `Text description (${input.length} chars, ~${wordCount} words). Preview: "${preview}..."`;
    }
    return super._describeInput(input, metadata);
  }
}

module.exports = { TextToImageConverter };
