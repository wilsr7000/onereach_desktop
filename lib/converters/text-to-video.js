/**
 * TextToVideoConverter
 *
 * @description Converts text content to video using a multi-stage generative
 *   pipeline. The primary strategy (narrated-slides) splits text into sections,
 *   generates TTS audio narration for each, creates placeholder image frames,
 *   and stitches everything together with FFmpeg into a final video file.
 *
 * @agent converter:text-to-video
 * @from text
 * @to   mp4, webm
 *
 * @modes generative
 *
 * @strategies
 *   - narrated-slides -- Split text into sections, generate TTS audio per
 *                        section, create a placeholder title-card image for
 *                        each, then stitch audio + images into a video via
 *                        FFmpeg. Fully implemented.
 *   - animated        -- Motion-graphics style video with animated text and
 *                        transitions. (Placeholder -- not yet implemented.)
 *   - presenter       -- AI avatar presenting the content on camera.
 *                        (Placeholder -- not yet implemented.)
 *
 * @evaluation
 *   Structural: output must be a non-empty Buffer or a valid file path
 *   pointing to a non-empty video file.
 *
 * @input  {string} Plain text or Markdown content to convert into a video.
 * @output {Buffer} Video buffer in the target format (mp4 or webm).
 *
 * @example
 *   const { TextToVideoConverter } = require('./text-to-video');
 *   const converter = new TextToVideoConverter();
 *   const result = await converter.convert(
 *     'Welcome to our product demo. Today we will cover three features...',
 *     { targetFormat: 'mp4' }
 *   );
 *   // result.output is a Buffer containing MP4 video data
 *
 * @dependencies
 *   - lib/ai-service.js (tts method -- OpenAI TTS for narration)
 *   - FFmpeg (must be available on PATH for video stitching)
 *   - os.tmpdir() for temporary working files
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const execFileAsync = promisify(execFile);
const writeFileAsync = promisify(fs.writeFile);
const readFileAsync = promisify(fs.readFile);
const mkdirAsync = promisify(fs.mkdir);
const unlinkAsync = promisify(fs.unlink);
const readdirAsync = promisify(fs.readdir);

// Default TTS voice for narration
const DEFAULT_VOICE = 'alloy';

// Default TTS speed
const DEFAULT_SPEED = 1.0;

// Frame rate for the generated video
const DEFAULT_FPS = 24;

// Default image dimensions for slide frames
const SLIDE_WIDTH = 1920;
const SLIDE_HEIGHT = 1080;

// Maximum sections to split text into (prevents runaway generation)
const MAX_SECTIONS = 30;

class TextToVideoConverter extends BaseConverterAgent {
  /**
   * @param {Object} [config]
   * @param {Object} [config.ai] - AI service override (testing)
   * @param {string} [config.ffmpegPath] - Path to FFmpeg binary (default: 'ffmpeg')
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:text-to-video';
    this.name = 'Text to Video Converter';
    this.description = 'Converts text to video using TTS narration and image slides via FFmpeg';

    this.from = ['text'];
    this.to = ['mp4', 'webm'];
    this.modes = ['generative'];

    this._ffmpegPath = config.ffmpegPath || 'ffmpeg';

    this.strategies = [
      {
        id: 'narrated-slides',
        description: 'Split text into sections, generate TTS audio per section, create slide frames, stitch with FFmpeg',
        when: 'General-purpose text-to-video; presentations, explainers, narrated content',
        engine: 'ai-tts + ffmpeg',
        mode: 'generative',
        speed: 'slow',
        quality: 'Clear narrated slideshow with title cards per section',
      },
      {
        id: 'animated',
        description: 'Motion graphics with animated text and transitions',
        when: 'Marketing content, social media videos, dynamic text animation',
        engine: 'ffmpeg-drawtext',
        mode: 'generative',
        speed: 'slow',
        quality: 'Animated text with transitions (placeholder)',
      },
      {
        id: 'presenter',
        description: 'AI avatar presenting the content on camera',
        when: 'Training videos, personalized messages, talking-head style content',
        engine: 'ai-avatar',
        mode: 'generative',
        speed: 'slow',
        quality: 'AI presenter video (placeholder)',
      },
    ];
  }

  // ===========================================================================
  // EXECUTE
  // ===========================================================================

  /**
   * Generate a video from text using the chosen strategy.
   *
   * @param {string} input - Text content to convert to video
   * @param {string} strategy - 'narrated-slides' | 'animated' | 'presenter'
   * @param {Object} [options]
   * @param {string} [options.targetFormat] - 'mp4' or 'webm' (default 'mp4')
   * @param {string} [options.voice]       - TTS voice ID (default 'alloy')
   * @param {number} [options.speed]       - TTS speed multiplier (default 1.0)
   * @param {number} [options.fps]         - Frame rate (default 24)
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const startTime = Date.now();

    if (typeof input !== 'string' || input.trim().length === 0) {
      throw new Error('Input must be a non-empty text string');
    }

    const targetFormat = (options.targetFormat || 'mp4').toLowerCase();
    if (!this.to.includes(targetFormat)) {
      throw new Error(`Unsupported target format: ${targetFormat}. Supported: ${this.to.join(', ')}`);
    }

    switch (strategy) {
      case 'narrated-slides':
        return this._narratedSlides(input, targetFormat, options, startTime);

      case 'animated':
        throw new Error(
          'The "animated" strategy is not yet implemented. ' +
          'It will support motion graphics with animated text and transitions in a future release. ' +
          'Please use the "narrated-slides" strategy instead.'
        );

      case 'presenter':
        throw new Error(
          'The "presenter" strategy is not yet implemented. ' +
          'It will support AI avatar video generation in a future release. ' +
          'Please use the "narrated-slides" strategy instead.'
        );

      default:
        throw new Error(`Unknown strategy: ${strategy}`);
    }
  }

  // ===========================================================================
  // NARRATED SLIDES PIPELINE
  // ===========================================================================

  /**
   * Full narrated-slides pipeline:
   *   1. Split text into logical sections
   *   2. Generate TTS audio for each section
   *   3. Create placeholder slide images for each section
   *   4. Get audio duration for each section
   *   5. Stitch slides + audio into a video with FFmpeg
   *   6. Read the final video file and return as Buffer
   *
   * @private
   * @param {string} input - Full text content
   * @param {string} targetFormat - 'mp4' | 'webm'
   * @param {Object} options - Conversion options
   * @param {number} startTime - Timestamp for duration tracking
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async _narratedSlides(input, targetFormat, options, startTime) {
    if (!this._ai || typeof this._ai.tts !== 'function') {
      throw new Error('AI service with tts() is required for narrated-slides video generation');
    }

    // Verify FFmpeg is available
    await this._verifyFfmpeg();

    // Create a temp working directory
    const workDir = path.join(os.tmpdir(), `text-to-video-${uuidv4()}`);
    await mkdirAsync(workDir, { recursive: true });

    try {
      // Step 1: Split text into sections
      const sections = this._splitIntoSections(input);
      this.logger.log('converter:execute:progress', {
        message: `Split text into ${sections.length} sections`,
        sectionCount: sections.length,
      });

      const voice = options.voice || DEFAULT_VOICE;
      const speed = options.speed || DEFAULT_SPEED;
      const fps = options.fps || DEFAULT_FPS;

      const slideData = [];

      // Steps 2-3: Generate audio and slides for each section
      for (let i = 0; i < sections.length; i++) {
        const section = sections[i];
        const sectionIndex = String(i).padStart(3, '0');

        this.logger.log('converter:execute:progress', {
          message: `Processing section ${i + 1}/${sections.length}`,
          section: i + 1,
          total: sections.length,
        });

        // Generate TTS audio
        const audioPath = path.join(workDir, `audio_${sectionIndex}.mp3`);
        const audioBuffer = await this._generateTTS(section.text, voice, speed);
        await writeFileAsync(audioPath, audioBuffer);

        // Create slide image (PNG title card)
        const slidePath = path.join(workDir, `slide_${sectionIndex}.png`);
        await this._createSlideImage(slidePath, section.title, section.text, i + 1, sections.length);

        // Get audio duration via FFprobe
        const duration = await this._getAudioDuration(audioPath);

        slideData.push({
          index: i,
          audioPath,
          slidePath,
          duration,
          title: section.title,
        });
      }

      // Step 4: Stitch into final video
      const outputPath = path.join(workDir, `output.${targetFormat}`);
      await this._stitchVideo(slideData, outputPath, targetFormat, fps);

      // Step 5: Read the final video into a Buffer
      const videoBuffer = await readFileAsync(outputPath);

      return {
        output: videoBuffer,
        metadata: {
          format: targetFormat,
          strategy: 'narrated-slides',
          sectionCount: sections.length,
          voice,
          speed,
          fps,
          totalDuration: slideData.reduce((sum, s) => sum + s.duration, 0),
          outputSize: videoBuffer.length,
        },
        duration: Date.now() - startTime,
        strategy: 'narrated-slides',
      };
    } finally {
      // Clean up temp directory
      await this._cleanupDir(workDir);
    }
  }

  // ===========================================================================
  // PIPELINE HELPERS
  // ===========================================================================

  /**
   * Split text into logical sections for individual slides.
   * Splits on double-newlines, Markdown headings, or numbered sections.
   * Each section gets a generated title.
   *
   * @private
   * @param {string} text - Full input text
   * @returns {{ title: string, text: string }[]}
   */
  _splitIntoSections(text) {
    // Try splitting by Markdown headings first
    const headingPattern = /^#{1,3}\s+(.+)$/gm;
    const headings = [...text.matchAll(headingPattern)];

    let sections = [];

    if (headings.length >= 2) {
      // Split by headings
      for (let i = 0; i < headings.length; i++) {
        const start = headings[i].index;
        const end = i + 1 < headings.length ? headings[i + 1].index : text.length;
        const sectionText = text.substring(start, end).trim();
        const title = headings[i][1].trim();
        const body = sectionText.replace(/^#{1,3}\s+.+\n?/, '').trim();
        if (body.length > 0) {
          sections.push({ title, text: body });
        }
      }

      // Check if there's content before the first heading
      const preHeading = text.substring(0, headings[0].index).trim();
      if (preHeading.length > 20) {
        sections.unshift({ title: 'Introduction', text: preHeading });
      }
    } else {
      // Split by double newlines (paragraphs)
      const paragraphs = text
        .split(/\n{2,}/)
        .map(p => p.trim())
        .filter(p => p.length > 0);

      // Group short paragraphs together (at least ~100 chars per slide)
      let currentGroup = [];
      let currentLen = 0;
      const TARGET_LEN = 200;

      for (const para of paragraphs) {
        currentGroup.push(para);
        currentLen += para.length;

        if (currentLen >= TARGET_LEN) {
          const combined = currentGroup.join('\n\n');
          const title = this._extractTitle(combined, sections.length + 1);
          sections.push({ title, text: combined });
          currentGroup = [];
          currentLen = 0;
        }
      }

      // Flush remaining
      if (currentGroup.length > 0) {
        const combined = currentGroup.join('\n\n');
        const title = this._extractTitle(combined, sections.length + 1);
        sections.push({ title, text: combined });
      }
    }

    // Enforce max sections
    if (sections.length > MAX_SECTIONS) {
      sections = sections.slice(0, MAX_SECTIONS);
    }

    // Ensure at least one section
    if (sections.length === 0) {
      sections.push({ title: 'Content', text: text.trim() });
    }

    return sections;
  }

  /**
   * Extract a short title from section text for the slide header.
   * Takes the first sentence or first N words.
   * @private
   */
  _extractTitle(text, sectionNum) {
    // First sentence
    const sentenceMatch = text.match(/^(.{10,80}?[.!?])\s/);
    if (sentenceMatch) {
      return sentenceMatch[1];
    }
    // First N words
    const words = text.split(/\s+/).slice(0, 8);
    if (words.length > 0) {
      return words.join(' ') + (text.split(/\s+/).length > 8 ? '...' : '');
    }
    return `Section ${sectionNum}`;
  }

  /**
   * Generate TTS audio for a text section.
   * @private
   * @param {string} text - Section text
   * @param {string} voice - TTS voice ID
   * @param {number} speed - Speech speed
   * @returns {Promise<Buffer>}
   */
  async _generateTTS(text, voice, speed) {
    const result = await this._ai.tts(text, {
      voice,
      speed,
      responseFormat: 'mp3',
      model: 'tts-1',
      feature: 'converter-text-to-video-narration',
    });

    const audioBuffer = result.audioBuffer || result;

    if (!Buffer.isBuffer(audioBuffer)) {
      throw new Error('TTS did not return an audio buffer');
    }

    return audioBuffer;
  }

  /**
   * Create a slide image (PNG) with title text and body preview.
   * Uses FFmpeg's lavfi (color + drawtext) to create a simple title card.
   *
   * @private
   * @param {string} outputPath - File path for the slide PNG
   * @param {string} title - Slide title
   * @param {string} body - Slide body text (truncated for display)
   * @param {number} slideNum - Current slide number
   * @param {number} totalSlides - Total slide count
   */
  async _createSlideImage(outputPath, title, body, slideNum, totalSlides) {
    // Sanitize text for FFmpeg drawtext filter
    const safeTitle = this._sanitizeForDrawtext(title).substring(0, 80);
    const safeBody = this._sanitizeForDrawtext(body).substring(0, 300);
    const slideLabel = `${slideNum} / ${totalSlides}`;

    try {
      await execFileAsync(this._ffmpegPath, [
        '-f', 'lavfi',
        '-i', `color=c=#1a1a2e:s=${SLIDE_WIDTH}x${SLIDE_HEIGHT}:d=1`,
        '-vf', [
          `drawtext=text='${safeTitle}':fontcolor=white:fontsize=56:x=(w-text_w)/2:y=h/4`,
          `drawtext=text='${safeBody}':fontcolor=#cccccc:fontsize=28:x=100:y=h/2:enable='between(t,0,1)'`,
          `drawtext=text='${slideLabel}':fontcolor=#666666:fontsize=24:x=(w-text_w)/2:y=h-80`,
        ].join(','),
        '-frames:v', '1',
        '-y',
        outputPath,
      ], { timeout: 30000 });
    } catch (err) {
      // Fallback: create a minimal 1x1 pixel PNG expanded to slide size
      // This keeps the pipeline running even if drawtext fails
      this.logger.log('converter:execute:warn', {
        message: `Slide image creation failed, using minimal fallback: ${err.message}`,
      });
      await execFileAsync(this._ffmpegPath, [
        '-f', 'lavfi',
        '-i', `color=c=#1a1a2e:s=${SLIDE_WIDTH}x${SLIDE_HEIGHT}:d=1`,
        '-frames:v', '1',
        '-y',
        outputPath,
      ], { timeout: 15000 });
    }
  }

  /**
   * Get the duration of an audio file in seconds using FFprobe.
   * @private
   * @param {string} audioPath
   * @returns {Promise<number>} Duration in seconds
   */
  async _getAudioDuration(audioPath) {
    try {
      const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'quiet',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        audioPath,
      ], { timeout: 10000 });

      const duration = parseFloat(stdout.trim());
      return isNaN(duration) ? 5 : duration;
    } catch {
      // Default to 5 seconds if ffprobe fails
      return 5;
    }
  }

  /**
   * Stitch slide images and audio segments into a final video using FFmpeg.
   *
   * Creates a concat demuxer file listing each segment, then uses FFmpeg
   * to produce the final output.
   *
   * @private
   * @param {{ audioPath: string, slidePath: string, duration: number }[]} slides
   * @param {string} outputPath - Final video output path
   * @param {string} format - 'mp4' | 'webm'
   * @param {number} fps - Frame rate
   */
  async _stitchVideo(slides, outputPath, format, fps) {
    const workDir = path.dirname(outputPath);

    // Step 1: Create individual video segments (image + audio)
    const segmentPaths = [];

    for (let i = 0; i < slides.length; i++) {
      const slide = slides[i];
      const segPath = path.join(workDir, `segment_${String(i).padStart(3, '0')}.${format}`);
      segmentPaths.push(segPath);

      const args = [
        '-loop', '1',
        '-i', slide.slidePath,
        '-i', slide.audioPath,
        '-c:v', format === 'webm' ? 'libvpx-vp9' : 'libx264',
        '-tune', 'stillimage',
        '-c:a', format === 'webm' ? 'libopus' : 'aac',
        '-b:a', '192k',
        '-pix_fmt', 'yuv420p',
        '-r', String(fps),
        '-shortest',
        '-y',
        segPath,
      ];

      // libx264 specific flags
      if (format === 'mp4') {
        args.splice(args.indexOf('-c:v') + 2, 0, '-preset', 'ultrafast');
      }

      await execFileAsync(this._ffmpegPath, args, { timeout: 120000 });
    }

    // Step 2: Create concat demuxer file
    const concatFilePath = path.join(workDir, 'concat.txt');
    const concatContent = segmentPaths
      .map(p => `file '${p.replace(/'/g, "'\\''")}'`)
      .join('\n');
    await writeFileAsync(concatFilePath, concatContent);

    // Step 3: Concatenate all segments
    await execFileAsync(this._ffmpegPath, [
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFilePath,
      '-c', 'copy',
      '-y',
      outputPath,
    ], { timeout: 300000 });
  }

  // ===========================================================================
  // STRUCTURAL CHECKS
  // ===========================================================================

  /**
   * Verify the output is a non-empty Buffer (or filepath pointing to a
   * non-empty file). Video files should always be at least several KB.
   *
   * @param {string} input - Original text input
   * @param {*} output - Conversion output
   * @param {string} strategy - Strategy that was used
   * @returns {Promise<import('./base-converter-agent').EvaluationIssue[]>}
   */
  async _structuralChecks(input, output, strategy) {
    const issues = [];

    // Handle filepath output
    if (typeof output === 'string') {
      try {
        const stat = fs.statSync(output);
        if (stat.size === 0) {
          issues.push({
            code: 'OUTPUT_FILE_EMPTY',
            severity: 'error',
            message: 'Output video file is empty (0 bytes)',
            fixable: true,
          });
        }
        return issues;
      } catch {
        issues.push({
          code: 'OUTPUT_FILE_MISSING',
          severity: 'error',
          message: `Output file path does not exist: ${output}`,
          fixable: true,
        });
        return issues;
      }
    }

    // Handle Buffer output
    if (!Buffer.isBuffer(output)) {
      issues.push({
        code: 'OUTPUT_NOT_BUFFER',
        severity: 'error',
        message: `Expected output to be a Buffer or filepath, got ${typeof output}`,
        fixable: true,
      });
      return issues;
    }

    if (output.length === 0) {
      issues.push({
        code: 'OUTPUT_EMPTY',
        severity: 'error',
        message: 'Video generation produced an empty buffer',
        fixable: true,
      });
      return issues;
    }

    // A valid video should be at least a few KB
    if (output.length < 1024) {
      issues.push({
        code: 'VIDEO_TOO_SMALL',
        severity: 'warning',
        message: `Video buffer is only ${output.length} bytes; expected at least 1 KB for a valid video`,
        fixable: false,
      });
    }

    return issues;
  }

  // ===========================================================================
  // UTILITY HELPERS
  // ===========================================================================

  /**
   * Verify that FFmpeg is available on the system.
   * @private
   */
  async _verifyFfmpeg() {
    try {
      await execFileAsync(this._ffmpegPath, ['-version'], { timeout: 5000 });
    } catch {
      throw new Error(
        'FFmpeg is not available. Install FFmpeg and ensure it is on your PATH ' +
        'to use text-to-video conversion. (brew install ffmpeg)'
      );
    }
  }

  /**
   * Sanitize text for use in FFmpeg's drawtext filter.
   * Escapes characters that have special meaning.
   * @private
   * @param {string} text
   * @returns {string}
   */
  _sanitizeForDrawtext(text) {
    return text
      .replace(/\\/g, '\\\\\\\\')
      .replace(/'/g, "\u2019")          // Replace apostrophes with typographic
      .replace(/:/g, '\\:')
      .replace(/\n/g, ' ')
      .replace(/\r/g, '')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .replace(/%/g, '%%');
  }

  /**
   * Clean up a temporary working directory.
   * @private
   * @param {string} dirPath
   */
  async _cleanupDir(dirPath) {
    try {
      const files = await readdirAsync(dirPath);
      for (const file of files) {
        try {
          await unlinkAsync(path.join(dirPath, file));
        } catch {
          // Ignore individual file cleanup errors
        }
      }
      fs.rmdirSync(dirPath);
    } catch {
      // Non-critical: temp dir cleanup failure
    }
  }

  /**
   * Override input description for LLM planning context.
   * @override
   */
  _describeInput(input, metadata = {}) {
    if (typeof input === 'string') {
      const wordCount = input.split(/\s+/).length;
      const hasHeadings = /^#{1,3}\s/m.test(input);
      return `Text content (${input.length} chars, ~${wordCount} words, ${hasHeadings ? 'has' : 'no'} headings). Preview: "${input.substring(0, 150)}..."`;
    }
    return super._describeInput(input, metadata);
  }
}

module.exports = { TextToVideoConverter };
