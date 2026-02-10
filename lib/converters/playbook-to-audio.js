/**
 * PlaybookToAudioAgent
 *
 * @description Converts a structured Playbook object into spoken audio using
 *   TTS. Builds a text script from the playbook content and framework, then
 *   passes it through the AI service TTS endpoint.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/playbook-to-audio
 *
 * @agent converter:playbook-to-audio
 * @from playbook
 * @to   mp3, wav
 *
 * @modes generative
 *
 * @strategies
 *   - narration       : Full TTS narration of the playbook content
 *   - summary         : AI-generated summary narrated via TTS
 *   - framework-first : Narrate framework pillars first, then content
 *
 * @evaluation
 *   Structural: output must be a non-empty Buffer.
 *
 * @input  {Object} Playbook object with title, content, framework.
 * @output {Buffer} Audio buffer (mp3 or wav).
 *
 * @example
 *   const { PlaybookToAudioAgent } = require('./playbook-to-audio');
 *   const agent = new PlaybookToAudioAgent();
 *   const result = await agent.convert(playbookObj, { targetFormat: 'mp3' });
 *   // result.output is a Buffer containing MP3 audio
 *
 * @dependencies
 *   - lib/ai-service.js (tts and complete methods)
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');
const { getLogQueue } = require('./../log-event-queue');
const log = getLogQueue();

/** Available OpenAI TTS voices */
const VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
const DEFAULT_VOICE = 'alloy';
const DEFAULT_SPEED = 1.0;

class PlaybookToAudioAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:playbook-to-audio';
    this.name = 'Playbook to Audio';
    this.description = 'Converts a Playbook into spoken audio using TTS';
    this.from = ['playbook'];
    this.to = ['mp3', 'wav'];
    this.modes = ['generative'];

    this.strategies = [
      {
        id: 'narration',
        description: 'Full TTS narration of the playbook content',
        when: 'Listener wants the complete content read aloud',
        engine: 'openai-tts',
        mode: 'generative',
        speed: 'medium',
        quality: 'Complete narration of all content; no framework-specific intro',
      },
      {
        id: 'summary',
        description: 'AI-generated summary narrated via TTS',
        when: 'Listener wants a brief audio overview; content is long',
        engine: 'llm + openai-tts',
        mode: 'generative',
        speed: 'medium',
        quality: 'Concise summary preserving key points; shorter audio',
      },
      {
        id: 'framework-first',
        description: 'Narrate framework pillars first, then content',
        when: 'Listener needs framework context before diving into content',
        engine: 'openai-tts',
        mode: 'generative',
        speed: 'medium',
        quality: 'Framework-oriented narration with full content follow-up',
      },
    ];
  }

  // ===========================================================================
  // EXECUTE
  // ===========================================================================

  /**
   * Convert a Playbook object into an audio buffer.
   *
   * @param {Object} input - Playbook object
   * @param {string} strategy - Strategy ID: 'narration' | 'summary' | 'framework-first'
   * @param {Object} [options] - Additional options
   * @param {string} [options.targetFormat] - 'mp3' or 'wav'
   * @param {string} [options.voice] - TTS voice ID
   * @param {number} [options.speed] - Speech speed multiplier
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const startTime = Date.now();

    if (!this._ai || !this._ai.tts) {
      throw new Error('AI service with tts() is required for playbook-to-audio conversion');
    }

    if (!input || typeof input !== 'object') {
      throw new Error('Input must be a Playbook object');
    }

    const targetFormat = (options.targetFormat || 'mp3').toLowerCase();
    const voice = this._validateVoice(options.voice || DEFAULT_VOICE);
    const speed = Math.max(0.25, Math.min(4.0, Number(options.speed) || DEFAULT_SPEED));

    const title = input.title || 'Untitled Playbook';
    const content = input.content || '';
    const framework = input.framework || {};

    // Build the text script based on strategy
    let script;

    switch (strategy) {
      case 'narration':
        script = this._buildNarrationScript(title, content);
        break;
      case 'summary':
        script = await this._buildSummaryScript(title, content, framework);
        break;
      case 'framework-first':
        script = this._buildFrameworkFirstScript(title, content, framework);
        break;
      default:
        script = this._buildNarrationScript(title, content);
    }

    // Strip Markdown formatting for cleaner speech
    const cleanScript = this._stripMarkdown(script);

    // Call TTS
    const result = await this._ai.tts(cleanScript, {
      voice,
      speed,
      responseFormat: targetFormat,
      model: options.model || 'tts-1',
      feature: 'converter-playbook-to-audio',
    });

    const audioBuffer = result.audioBuffer || result;

    if (!Buffer.isBuffer(audioBuffer)) {
      throw new Error('TTS did not return an audio buffer');
    }

    return {
      output: audioBuffer,
      metadata: {
        strategy,
        title,
        format: targetFormat,
        voice,
        speed,
        scriptLength: cleanScript.length,
        size: audioBuffer.length,
      },
      duration: Date.now() - startTime,
      strategy,
    };
  }

  // ===========================================================================
  // STRUCTURAL CHECKS
  // ===========================================================================

  /**
   * Validate audio output.
   *
   * @param {Object} input - Original Playbook
   * @param {Buffer} output - Audio buffer
   * @param {string} strategy - Strategy used
   * @returns {Promise<import('./base-converter-agent').EvaluationIssue[]>}
   */
  async _structuralChecks(input, output, strategy) {
    const issues = [];

    if (!Buffer.isBuffer(output)) {
      issues.push({
        code: 'OUTPUT_NOT_BUFFER',
        severity: 'error',
        message: `Expected audio buffer, got ${typeof output}`,
        fixable: true,
      });
      return issues;
    }

    if (output.length === 0) {
      issues.push({
        code: 'OUTPUT_EMPTY',
        severity: 'error',
        message: 'Audio buffer is empty',
        fixable: true,
      });
      return issues;
    }

    // Sanity: audio should be at least 1 KB
    if (output.length < 1024) {
      issues.push({
        code: 'AUDIO_TOO_SHORT',
        severity: 'warning',
        message: `Audio is suspiciously small (${output.length} bytes)`,
        fixable: false,
      });
    }

    return issues;
  }

  // ===========================================================================
  // SCRIPT BUILDERS
  // ===========================================================================

  /**
   * Build narration script from title and content.
   * @private
   */
  _buildNarrationScript(title, content) {
    return `${title}.\n\n${content}`;
  }

  /**
   * Build summary script using AI to summarize content.
   * @private
   */
  async _buildSummaryScript(title, content, framework) {
    if (!this._ai) {
      return this._buildNarrationScript(title, content);
    }

    try {
      const summary = await this._ai.complete(
        `Summarize the following content for audio narration. Make it conversational and clear.
Keep it to 2-3 paragraphs. Start with the title.

Title: ${title}
Content: ${content.substring(0, 3000)}`,
        { profile: 'fast', feature: 'converter-audio-summary', temperature: 0.4 }
      );

      return summary || this._buildNarrationScript(title, content);
    } catch (err) {
      console.warn('[playbook-to-audio] Summary generation failed:', err.message);
      return this._buildNarrationScript(title, content);
    }
  }

  /**
   * Build framework-first script: framework summary, then content.
   * @private
   */
  _buildFrameworkFirstScript(title, content, framework) {
    const parts = [title, ''];

    // Framework narration
    if (framework.who?.primary) {
      parts.push(`This playbook is designed for ${framework.who.primary}.`);
      if (framework.who.context) {
        parts.push(framework.who.context);
      }
    }

    if (framework.why?.coreValue) {
      parts.push(`The core value is: ${framework.why.coreValue}.`);
      if (framework.why.practicalBenefit) {
        parts.push(`The practical benefit is ${framework.why.practicalBenefit}.`);
      }
    }

    if (framework.what?.primaryAction) {
      parts.push(`The primary action is to ${framework.what.primaryAction}.`);
      if (framework.what.successLooksLike) {
        parts.push(`Success looks like: ${framework.what.successLooksLike}.`);
      }
    }

    if (framework.where?.platform) {
      parts.push(`This is intended for ${framework.where.platform}.`);
    }

    parts.push('');
    parts.push('Now, here is the full content.');
    parts.push('');
    parts.push(content);

    return parts.join('\n');
  }

  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================

  /**
   * Validate voice ID.
   * @private
   */
  _validateVoice(voice) {
    if (VOICES.includes(voice)) return voice;
    console.warn('[playbook-to-audio] Unknown voice, using default:', voice, DEFAULT_VOICE);
    return DEFAULT_VOICE;
  }

  /**
   * Strip Markdown formatting for cleaner TTS.
   * @private
   */
  _stripMarkdown(text) {
    return text
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
      .replace(/_{1,3}([^_]+)_{1,3}/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      .replace(/^[-*_]{3,}$/gm, '')
      .replace(/^>\s+/gm, '')
      .replace(/^[\s]*[-*+]\s+/gm, '')
      .replace(/^[\s]*\d+\.\s+/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}

module.exports = { PlaybookToAudioAgent };
