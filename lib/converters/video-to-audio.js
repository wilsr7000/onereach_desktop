/**
 * VideoToAudioAgent
 *
 * @description Extracts audio tracks from video files using FFmpeg.
 *   Supports mp3, wav, and aac output. Three strategies cover different
 *   extraction needs: full-track, speech-only (with noise-reduction hint),
 *   and best-track (select highest-quality audio stream).
 *
 * @extends BaseConverterAgent
 * @see lib/converters/base-converter-agent.js
 *
 * @strategies
 *   - full-track:  Extract the entire default audio stream.
 *   - speech-only: Extract audio and apply high-pass filter to reduce
 *                  low-frequency noise (a hint for downstream speech pipelines).
 *   - best-track:  Probe all audio streams and pick the one with the
 *                  highest channel count / bitrate.
 *
 * @requirements FFmpeg must be available on PATH.
 * @module lib/converters/video-to-audio
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');
const { execFile } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

/**
 * Check whether FFmpeg is available on the system.
 * @returns {Promise<boolean>}
 */
let _ffmpegAvailable = null;
function checkFfmpeg() {
  if (_ffmpegAvailable !== null) return Promise.resolve(_ffmpegAvailable);
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-version'], (err) => {
      _ffmpegAvailable = !err;
      resolve(_ffmpegAvailable);
    });
  });
}

/**
 * Run FFmpeg with the given arguments and return a promise.
 * @param {string[]} args
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr }));
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Run ffprobe and return parsed JSON output.
 * @param {string} filePath
 * @returns {Promise<Object>}
 */
function probeFile(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      'ffprobe',
      ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', filePath],
      { maxBuffer: 5 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

/** Audio codec mapped to output format */
const AUDIO_CODECS = {
  mp3: { acodec: 'libmp3lame', quality: ['-q:a', '2'] },
  wav: { acodec: 'pcm_s16le', quality: [] },
  aac: { acodec: 'aac', quality: ['-b:a', '192k'] },
};

class VideoToAudioAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config]
   * @param {Object} [config.ai] - AI service instance (for testing)
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:video-to-audio';
    this.name = 'Video to Audio';
    this.description = 'Extract audio tracks from video files using FFmpeg';
    this.from = ['mp4', 'webm', 'mov', 'avi', 'mkv'];
    this.to = ['mp3', 'wav', 'aac'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'full-track',
        description: 'Extract the entire default audio stream',
        when: 'You need the complete audio track without modification',
        engine: 'ffmpeg',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Original quality',
      },
      {
        id: 'speech-only',
        description: 'Extract audio with high-pass filter to reduce background noise',
        when: 'Audio will be used for speech processing or transcription',
        engine: 'ffmpeg',
        mode: 'symbolic',
        speed: 'medium',
        quality: 'Speech-optimized (reduced low-frequency noise)',
      },
      {
        id: 'best-track',
        description: 'Probe all audio streams and select the highest quality one',
        when: 'Video has multiple audio tracks and you want the best one',
        engine: 'ffmpeg + ffprobe',
        mode: 'symbolic',
        speed: 'medium',
        quality: 'Best available track',
      },
    ];
  }

  /**
   * Execute audio extraction from a video file.
   *
   * @param {string} input - Absolute path to the source video file
   * @param {string} strategy - One of 'full-track', 'speech-only', 'best-track'
   * @param {Object} [options]
   * @param {string} [options.outputFormat] - Target audio format (mp3, wav, aac). Defaults to mp3.
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const available = await checkFfmpeg();
    if (!available) {
      throw new Error('FFmpeg is not installed or not available on PATH');
    }

    const outputFormat = options.outputFormat || options.to || 'mp3';
    const codec = AUDIO_CODECS[outputFormat] || AUDIO_CODECS.mp3;
    const outFile = path.join(os.tmpdir(), `audio-${uuidv4()}.${outputFormat}`);
    const startTime = Date.now();

    try {
      let args;

      switch (strategy) {
        case 'speech-only':
          args = [
            '-y',
            '-i',
            input,
            '-vn',
            '-af',
            'highpass=f=200,lowpass=f=3000',
            '-acodec',
            codec.acodec,
            ...codec.quality,
            outFile,
          ];
          break;

        case 'best-track': {
          // Probe to find the best audio stream
          let streamIndex = '0:a:0';
          try {
            const probe = await probeFile(input);
            const audioStreams = (probe.streams || []).filter((s) => s.codec_type === 'audio');
            if (audioStreams.length > 1) {
              // Pick stream with highest channel count, then highest bitrate
              const best = audioStreams.reduce((a, b) => {
                const aChannels = parseInt(a.channels, 10) || 0;
                const bChannels = parseInt(b.channels, 10) || 0;
                if (bChannels !== aChannels) return bChannels > aChannels ? b : a;
                const aBitrate = parseInt(a.bit_rate, 10) || 0;
                const bBitrate = parseInt(b.bit_rate, 10) || 0;
                return bBitrate > aBitrate ? b : a;
              });
              streamIndex = `0:${best.index}`;
            }
          } catch (_) {
            // ffprobe failed; fall through to default stream
          }
          args = ['-y', '-i', input, '-map', streamIndex, '-vn', '-acodec', codec.acodec, ...codec.quality, outFile];
          break;
        }

        default: // full-track
          args = ['-y', '-i', input, '-vn', '-acodec', codec.acodec, ...codec.quality, outFile];
          break;
      }

      await runFfmpeg(args);

      return {
        output: outFile,
        metadata: {
          strategy,
          inputPath: input,
          outputPath: outFile,
          outputFormat,
        },
        duration: Date.now() - startTime,
        strategy,
      };
    } catch (err) {
      try {
        fs.unlinkSync(outFile);
      } catch (_) {
        /* ignore */
      }
      throw new Error(`FFmpeg audio extraction failed (${strategy}): ${err.message}`);
    }
  }

  /**
   * Verify the output audio file exists and has a non-zero size.
   *
   * @param {string} input - Source video path
   * @param {string} output - Output audio file path
   * @param {string} strategy - Strategy used
   * @returns {Promise<import('./base-converter-agent').EvaluationIssue[]>}
   */
  async _structuralChecks(input, output, strategy) {
    const issues = [];

    if (typeof output !== 'string') {
      issues.push({
        code: 'OUTPUT_NOT_PATH',
        severity: 'error',
        message: 'Expected output to be a file path string',
        fixable: false,
      });
      return issues;
    }

    try {
      const stat = fs.statSync(output);
      if (stat.size === 0) {
        issues.push({
          code: 'OUTPUT_ZERO_SIZE',
          severity: 'error',
          message: 'Output audio file exists but has zero bytes',
          fixable: true,
          suggestedStrategy: strategy === 'best-track' ? 'full-track' : undefined,
        });
      }
    } catch (_err) {
      issues.push({
        code: 'OUTPUT_MISSING',
        severity: 'error',
        message: `Output audio file does not exist: ${output}`,
        fixable: true,
      });
    }

    return issues;
  }
}

module.exports = { VideoToAudioAgent };
