/**
 * TranscodeService - Video transcoding and compression
 * @module src/video/editing/TranscodeService
 */

import { ffmpeg } from '../core/VideoProcessor.js';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { app } = require('electron');

/**
 * Service for video transcoding and compression
 */
export class TranscodeService {
  constructor() {
    this.outputDir = path.join(app.getPath('userData'), 'video-exports');
    this.activeJobs = new Map();
  }

  /**
   * Transcode video to different format
   * @param {string} inputPath - Path to input video
   * @param {Object} options - Transcode options
   * @param {Function} progressCallback - Progress callback
   * @returns {Promise<Object>} Result with output path
   */
  async transcodeVideo(inputPath, options = {}, progressCallback = null) {
    const {
      format = 'mp4',
      videoCodec = null,
      audioCodec = null,
      resolution = null,
      videoBitrate = null,
      audioBitrate = null,
      fps = null,
      preset = 'medium',
      crf = 23,
      outputPath = null
    } = options;

    const baseName = path.basename(inputPath, path.extname(inputPath));
    const output = outputPath || path.join(this.outputDir, `${baseName}_transcoded.${format}`);
    const jobId = `transcode_${Date.now()}`;

    return new Promise((resolve, reject) => {
      let command = ffmpeg(inputPath);

      // Video codec
      if (videoCodec) {
        command = command.videoCodec(videoCodec);
      } else {
        // Default codecs based on format
        const defaultCodecs = {
          'mp4': 'libx264',
          'webm': 'libvpx-vp9',
          'mov': 'libx264',
          'avi': 'mpeg4',
          'mkv': 'libx264'
        };
        if (defaultCodecs[format]) {
          command = command.videoCodec(defaultCodecs[format]);
        }
      }

      // Audio codec
      if (audioCodec) {
        command = command.audioCodec(audioCodec);
      } else {
        const defaultAudioCodecs = {
          'mp4': 'aac',
          'webm': 'libopus',
          'mov': 'aac',
          'avi': 'mp3',
          'mkv': 'aac'
        };
        if (defaultAudioCodecs[format]) {
          command = command.audioCodec(defaultAudioCodecs[format]);
        }
      }

      // Resolution
      if (resolution) {
        command = command.size(resolution);
      }

      // Video bitrate
      if (videoBitrate) {
        command = command.videoBitrate(videoBitrate);
      }

      // Audio bitrate
      if (audioBitrate) {
        command = command.audioBitrate(audioBitrate);
      }

      // FPS
      if (fps) {
        command = command.fps(fps);
      }

      // Preset and CRF for h264/h265
      command = command.outputOptions([
        `-preset ${preset}`,
        `-crf ${crf}`
      ]);

      command
        .format(format)
        .output(output)
        .on('start', (cmd) => {
          console.log('[TranscodeService] Transcode started:', cmd);
          this.activeJobs.set(jobId, command);
        })
        .on('progress', (progress) => {
          if (progressCallback) {
            progressCallback({
              jobId,
              percent: progress.percent,
              timemark: progress.timemark,
              currentFps: progress.currentFps,
              targetSize: progress.targetSize
            });
          }
        })
        .on('end', () => {
          this.activeJobs.delete(jobId);
          resolve({ success: true, outputPath: output, jobId });
        })
        .on('error', (err) => {
          this.activeJobs.delete(jobId);
          reject(err);
        })
        .run();
    });
  }

  /**
   * Compress video (reduce file size)
   * @param {string} inputPath - Path to input video
   * @param {Object} options - Compression options
   * @param {Function} progressCallback - Progress callback
   * @returns {Promise<Object>} Result with output path
   */
  async compressVideo(inputPath, options = {}, progressCallback = null) {
    const {
      quality = 'medium', // low, medium, high
      maxSize = null, // Target size in MB
      outputPath = null
    } = options;

    const qualitySettings = {
      'low': { crf: 32, preset: 'fast', audioBitrate: '96k' },
      'medium': { crf: 26, preset: 'medium', audioBitrate: '128k' },
      'high': { crf: 20, preset: 'slow', audioBitrate: '192k' }
    };

    const settings = qualitySettings[quality] || qualitySettings['medium'];
    const baseName = path.basename(inputPath, path.extname(inputPath));
    const output = outputPath || path.join(this.outputDir, `${baseName}_compressed.mp4`);
    const jobId = `compress_${Date.now()}`;

    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .videoCodec('libx264')
        .audioCodec('aac')
        .audioBitrate(settings.audioBitrate)
        .outputOptions([
          `-preset ${settings.preset}`,
          `-crf ${settings.crf}`
        ])
        .output(output)
        .on('start', (cmd) => {
          console.log('[TranscodeService] Compression started:', cmd);
          this.activeJobs.set(jobId, 'compress');
        })
        .on('progress', (progress) => {
          if (progressCallback) {
            progressCallback({
              jobId,
              percent: progress.percent,
              timemark: progress.timemark
            });
          }
        })
        .on('end', () => {
          this.activeJobs.delete(jobId);
          resolve({ success: true, outputPath: output, jobId });
        })
        .on('error', (err) => {
          this.activeJobs.delete(jobId);
          reject(err);
        })
        .run();
    });
  }
}









