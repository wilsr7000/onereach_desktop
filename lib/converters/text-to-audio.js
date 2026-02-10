/**
 * TextToAudioConverter
 *
 * @description Converts text (plain or Markdown) to spoken audio using the
 *   centralized AI service TTS endpoint. Supports standard voice synthesis,
 *   specific voice selection, and expressive mode where the content is
 *   analyzed to determine optimal tone, pacing, and emphasis.
 *
 * @agent converter:text-to-audio
 * @from text, md
 * @to   mp3, wav
 *
 * @modes generative
 *
 * @strategies
 *   - standard   -- Default TTS voice with neutral tone.
 *   - voiced     -- TTS with a user-specified voice ID.
 *   - expressive -- Analyze content to pick voice, speed, and tone.
 *
 * @evaluation
 *   Structural: output must be a non-empty Buffer with a reasonable byte
 *   size relative to the input text length.
 *   LLM spot-check: verifies audio metadata looks correct.
 *
 * @input  {string} Plain text or Markdown content.
 * @output {Buffer} Audio buffer in the target format (mp3 or wav).
 *
 * @example
 *   const { TextToAudioConverter } = require('./text-to-audio');
const { getLogQueue } = require('./../log-event-queue');
const log = getLogQueue();
 *   const converter = new TextToAudioConverter();
 *   const result = await converter.convert('Hello, welcome to the demo.', {
 *     targetFormat: 'mp3',
 *     voice: 'nova',
 *   });
 *   // result.output is a Buffer containing MP3 audio
 *
 * @dependencies
 *   - lib/ai-service.js (tts method -- OpenAI TTS)
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

// Available OpenAI TTS voices
const VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];

// Default voice
const DEFAULT_VOICE = 'alloy';

// Speed range
const MIN_SPEED = 0.25;
const MAX_SPEED = 4.0;
const DEFAULT_SPEED = 1.0;

// Rough estimate: TTS produces ~16 KB of MP3 per second at normal pace,
// and average speaking rate is ~150 words per minute (~2.5 words/sec).
// So 1 word ~ 6.4 KB of MP3. We use conservative bounds for validation.
const MIN_BYTES_PER_CHAR = 5;    // minimum expected bytes per input character
const MAX_BYTES_PER_CHAR = 500;  // maximum expected bytes per input character

class TextToAudioConverter extends BaseConverterAgent {
  /**
   * @param {Object} [config]
   * @param {Object} [config.ai] - AI service override (testing)
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:text-to-audio';
    this.name = 'Text to Audio Converter';
    this.description = 'Converts text to spoken audio using AI TTS';

    this.from = ['text', 'md'];
    this.to = ['mp3', 'wav'];
    this.modes = ['generative'];

    this.strategies = [
      {
        id: 'standard',
        description: 'Default TTS voice with neutral tone',
        when: 'General-purpose text-to-speech; no special requirements',
        engine: 'openai-tts',
        mode: 'generative',
        speed: 'fast',
        quality: 'Clear, neutral voice; good for informational content',
      },
      {
        id: 'voiced',
        description: 'TTS with a user-specified voice ID',
        when: 'User has a preferred voice; branding or character consistency',
        engine: 'openai-tts',
        mode: 'generative',
        speed: 'fast',
        quality: 'Specific voice character; same clarity as standard',
      },
      {
        id: 'expressive',
        description: 'Analyze content to determine optimal tone, pacing, and voice',
        when: 'Creative content, storytelling, emotional text, or varied material',
        engine: 'openai-tts + llm-analysis',
        mode: 'generative',
        speed: 'medium',
        quality: 'LLM-selected voice and speed tuned to content mood',
      },
    ];
  }

  // ===========================================================================
  // EXECUTE
  // ===========================================================================

  /**
   * Run the text-to-audio conversion.
   *
   * @param {string} input - Plain text or Markdown content
   * @param {string} strategy - One of 'standard' | 'voiced' | 'expressive'
   * @param {Object} [options]
   * @param {string} [options.targetFormat] - 'mp3' or 'wav'
   * @param {string} [options.voice]        - Voice ID (for 'voiced' strategy)
   * @param {number} [options.speed]        - Speech speed multiplier
   * @param {string} [options.model]        - TTS model override
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const startTime = Date.now();

    if (!this._ai || !this._ai.tts) {
      throw new Error('AI service with tts() is required for text-to-audio conversion');
    }

    if (typeof input !== 'string' || input.trim().length === 0) {
      throw new Error('Input must be a non-empty string');
    }

    const targetFormat = (options.targetFormat || 'mp3').toLowerCase();
    if (!this.to.includes(targetFormat)) {
      throw new Error(`Unsupported target format: ${targetFormat}`);
    }

    // Strip Markdown formatting for cleaner speech
    const cleanText = this._stripMarkdown(input);

    // Determine TTS parameters based on strategy
    const ttsParams = await this._resolveTTSParams(cleanText, strategy, options);

    // Call the AI service TTS endpoint
    const result = await this._ai.tts(cleanText, {
      voice: ttsParams.voice,
      speed: ttsParams.speed,
      responseFormat: targetFormat,
      model: options.model || 'tts-1',
      feature: 'converter-text-to-audio',
    });

    const audioBuffer = result.audioBuffer || result;

    if (!Buffer.isBuffer(audioBuffer)) {
      throw new Error('TTS did not return an audio buffer');
    }

    return {
      output: audioBuffer,
      metadata: {
        format: targetFormat,
        strategy,
        voice: ttsParams.voice,
        speed: ttsParams.speed,
        model: options.model || 'tts-1',
        inputLength: cleanText.length,
        inputWordCount: cleanText.split(/\s+/).length,
        size: audioBuffer.length,
        ...(ttsParams.mood ? { mood: ttsParams.mood } : {}),
      },
      duration: Date.now() - startTime,
      strategy,
    };
  }

  // ===========================================================================
  // STRUCTURAL CHECKS
  // ===========================================================================

  /**
   * Verify the output is a non-empty Buffer with reasonable size for the text.
   *
   * @param {string} input
   * @param {Buffer} output
   * @param {string} strategy
   * @returns {Promise<import('./base-converter-agent').EvaluationIssue[]>}
   */
  async _structuralChecks(input, output, strategy) {
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
        message: 'TTS produced an empty audio buffer',
        fixable: true,
      });
      return issues;
    }

    // Check size relative to input length
    const inputLen = typeof input === 'string' ? input.length : 0;
    if (inputLen > 0) {
      const bytesPerChar = output.length / inputLen;

      if (bytesPerChar < MIN_BYTES_PER_CHAR) {
        issues.push({
          code: 'AUDIO_TOO_SHORT',
          severity: 'warning',
          message: `Audio seems too short for input (${output.length} bytes for ${inputLen} chars = ${bytesPerChar.toFixed(1)} bytes/char)`,
          fixable: false,
        });
      }

      if (bytesPerChar > MAX_BYTES_PER_CHAR) {
        issues.push({
          code: 'AUDIO_TOO_LARGE',
          severity: 'warning',
          message: `Audio seems too large for input (${output.length} bytes for ${inputLen} chars = ${bytesPerChar.toFixed(1)} bytes/char)`,
          fixable: false,
        });
      }
    }

    return issues;
  }

  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================

  /**
   * Resolve TTS parameters (voice, speed) based on strategy.
   * @private
   */
  async _resolveTTSParams(text, strategy, options) {
    switch (strategy) {
      case 'standard':
        return {
          voice: DEFAULT_VOICE,
          speed: this._clampSpeed(options.speed || DEFAULT_SPEED),
        };

      case 'voiced':
        return {
          voice: this._validateVoice(options.voice || DEFAULT_VOICE),
          speed: this._clampSpeed(options.speed || DEFAULT_SPEED),
        };

      case 'expressive':
        return this._analyzeContentForTTS(text, options);

      default:
        return {
          voice: DEFAULT_VOICE,
          speed: DEFAULT_SPEED,
        };
    }
  }

  /**
   * Use LLM to analyze text content and pick optimal voice/speed/tone.
   * @private
   */
  async _analyzeContentForTTS(text, options) {
    if (!this._ai) {
      return { voice: DEFAULT_VOICE, speed: DEFAULT_SPEED };
    }

    try {
      const sample = text.substring(0, 500);
      const result = await this._ai.json(
        `You are selecting TTS voice parameters for spoken content.

Analyze this text and choose the best voice and speed:

Text: "${sample}"

Available voices:
- "alloy": Neutral, balanced, warm
- "echo": Deeper, authoritative
- "fable": Warm, expressive, storytelling
- "onyx": Deep, resonant, professional
- "nova": Bright, friendly, energetic
- "shimmer": Clear, gentle, calming

Return JSON: {
  "voice": "voice_id",
  "speed": 0.75-1.5,
  "mood": "brief mood description",
  "reasoning": "why this voice/speed"
}`,
        { profile: 'fast', feature: 'converter-tts-analysis', temperature: 0.3 }
      );

      if (result && result.voice && VOICES.includes(result.voice)) {
        return {
          voice: result.voice,
          speed: this._clampSpeed(result.speed || DEFAULT_SPEED),
          mood: result.mood || 'neutral',
        };
      }
    } catch (err) {
      console.warn('[text-to-audio] Content analysis failed, using defaults:', err.message);
    }

    return { voice: DEFAULT_VOICE, speed: DEFAULT_SPEED };
  }

  /**
   * Validate voice ID; fall back to default if unknown.
   * @private
   */
  _validateVoice(voice) {
    if (VOICES.includes(voice)) return voice;
    console.warn('[text-to-audio] Unknown voice, falling back to default:', voice, DEFAULT_VOICE);
    return DEFAULT_VOICE;
  }

  /**
   * Clamp speed to the allowed TTS range.
   * @private
   */
  _clampSpeed(speed) {
    return Math.max(MIN_SPEED, Math.min(MAX_SPEED, Number(speed) || DEFAULT_SPEED));
  }

  /**
   * Strip common Markdown formatting for cleaner speech synthesis.
   * Preserves the readable text but removes syntax characters.
   * @private
   */
  _stripMarkdown(text) {
    return text
      // Remove headers (# ## ### etc.)
      .replace(/^#{1,6}\s+/gm, '')
      // Remove bold/italic markers
      .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
      .replace(/_{1,3}([^_]+)_{1,3}/g, '$1')
      // Remove inline code
      .replace(/`([^`]+)`/g, '$1')
      // Remove code blocks
      .replace(/```[\s\S]*?```/g, '')
      // Remove links but keep text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      // Remove images
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      // Remove horizontal rules
      .replace(/^[-*_]{3,}$/gm, '')
      // Remove blockquote markers
      .replace(/^>\s+/gm, '')
      // Remove list markers
      .replace(/^[\s]*[-*+]\s+/gm, '')
      .replace(/^[\s]*\d+\.\s+/gm, '')
      // Collapse multiple newlines
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}

module.exports = { TextToAudioConverter };
