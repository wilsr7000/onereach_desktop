/**
 * AudioToSummaryAgent
 *
 * @description Generates text summaries of audio content using transcription
 *   and LLM analysis. Transcribes the audio first (via Whisper or similar),
 *   then asks an LLM to produce a summary. Companion to VideoToSummaryAgent
 *   but without video frame analysis.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/audio-to-summary
 *
 * @agent converter:audio-to-summary
 * @from mp3, wav, aac, ogg, flac, m4a, webm
 * @to   text
 * @modes generative
 *
 * @strategies
 *   - transcript-summary : Transcribe, then summarize the full transcript
 *   - chapter-summary    : Transcribe, detect topic shifts, summarize per chapter
 *   - key-points         : Transcribe, extract bullet-point key takeaways
 *
 * @input  {Buffer} Audio file content
 * @output {string} Text summary
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');
const { getLogQueue } = require('./../log-event-queue');
const log = getLogQueue();

class AudioToSummaryAgent extends BaseConverterAgent {
  constructor(config = {}) {
    super(config);

    this.id = 'converter:audio-to-summary';
    this.name = 'Audio to Summary';
    this.description = 'Generates text summaries of audio content via transcription and LLM analysis';
    this.from = ['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a', 'webm'];
    this.to = ['text'];
    this.modes = ['generative'];

    this.strategies = [
      {
        id: 'transcript-summary',
        description: 'Transcribe the audio, then ask the LLM to summarize the full transcript',
        when: 'A concise summary of the entire audio content is needed',
        engine: 'whisper + llm',
        mode: 'generative',
        speed: 'slow',
        quality: 'Comprehensive summary covering all content',
      },
      {
        id: 'chapter-summary',
        description: 'Transcribe, detect topic shifts, and summarize per chapter/segment',
        when: 'Audio is long with distinct topics (e.g., podcast, meeting)',
        engine: 'whisper + llm',
        mode: 'generative',
        speed: 'slow',
        quality: 'Structured summary with per-chapter breakdowns',
      },
      {
        id: 'key-points',
        description: 'Transcribe and extract the most important bullet-point takeaways',
        when: 'Quick actionable takeaways are needed rather than a narrative summary',
        engine: 'whisper + llm',
        mode: 'generative',
        speed: 'medium',
        quality: 'Focused bullet-point list of key insights',
      },
    ];
  }

  /**
   * @param {Buffer} input - Audio file content
   * @param {string} strategy - 'transcript-summary' | 'chapter-summary' | 'key-points'
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy) {
    const start = Date.now();

    if (!this._ai) {
      throw new Error('AI service is required for audio-to-summary conversion');
    }

    // Step 1: Transcribe the audio
    this.logger.log('converter:execute', {
      message: 'Transcribing audio content',
      strategy,
    });

    let transcript;
    try {
      const transcriptionResult = await this._ai.transcribe(
        Buffer.isBuffer(input) ? input : Buffer.from(input),
        { responseFormat: 'verbose_json', timestampGranularities: ['word'] }
      );
      transcript = transcriptionResult.text || transcriptionResult;
    } catch (err) {
      throw new Error(`Transcription failed: ${err.message}`);
    }

    if (!transcript || transcript.trim().length === 0) {
      throw new Error('Transcription produced empty text');
    }

    this.logger.log('converter:execute', {
      message: `Transcription complete: ${transcript.length} chars`,
      transcriptLength: transcript.length,
    });

    // Step 2: Summarize via LLM based on strategy
    let summary;

    switch (strategy) {
      case 'chapter-summary': {
        const chapterResult = await this._ai.complete(
          `You are an expert content analyst. The following is a transcript from an audio recording.

Identify distinct topics or chapters in the transcript, then provide a structured summary with one section per chapter.

Format:
## Chapter 1: [Topic]
[Summary paragraph]

## Chapter 2: [Topic]
[Summary paragraph]

(Continue for each chapter detected)

TRANSCRIPT:
${transcript}`,
          { profile: 'standard', feature: 'audio-to-summary' }
        );
        summary = chapterResult;
        break;
      }

      case 'key-points': {
        const keyPointsResult = await this._ai.complete(
          `You are an expert content analyst. The following is a transcript from an audio recording.

Extract the most important key points and actionable takeaways as a bullet-point list.

Format each point as:
- **[Key Point]**: [Brief explanation]

TRANSCRIPT:
${transcript}`,
          { profile: 'standard', feature: 'audio-to-summary' }
        );
        summary = keyPointsResult;
        break;
      }

      default: { // transcript-summary
        const summaryResult = await this._ai.complete(
          `You are an expert content analyst. The following is a transcript from an audio recording.

Provide a concise, well-structured summary that captures the main topics, key points, and any conclusions or action items discussed.

TRANSCRIPT:
${transcript}`,
          { profile: 'standard', feature: 'audio-to-summary' }
        );
        summary = summaryResult;
        break;
      }
    }

    return { output: summary, duration: Date.now() - start };
  }

  async _structuralChecks(input, output) {
    const issues = [];
    if (typeof output !== 'string') {
      issues.push({
        code: 'NOT_STRING',
        severity: 'error',
        message: 'Output is not a string',
        fixable: false,
      });
    } else if (output.trim().length < 20) {
      issues.push({
        code: 'SUMMARY_TOO_SHORT',
        severity: 'warning',
        message: 'Summary is very short (< 20 chars)',
        fixable: true,
      });
    }
    return issues;
  }
}

module.exports = { AudioToSummaryAgent };
