/**
 * AudioExtractor - Extract audio from video files
 * @module src/video/audio/AudioExtractor
 */

import { ffmpeg } from '../core/VideoProcessor.js';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { app } = require('electron');

/**
 * Service for extracting audio from video files
 */
export class AudioExtractor {
  constructor() {
    this.outputDir = path.join(app.getPath('userData'), 'video-exports');
    this.activeJobs = new Map();
  }

  /**
   * Extract audio from video
   * @param {string} inputPath - Path to input video
   * @param {Object} options - Extraction options
   * @param {Function} progressCallback - Progress callback
   * @returns {Promise<Object>} Result with output path
   */
  async extractAudio(inputPath, options = {}, progressCallback = null) {
    const {
      format = 'mp3',
      audioBitrate = '192k',
      outputPath = null
    } = options;

    const baseName = path.basename(inputPath, path.extname(inputPath));
    const output = outputPath || path.join(this.outputDir, `${baseName}_audio.${format}`);
    const jobId = `extract_audio_${Date.now()}`;

    return new Promise((resolve, reject) => {
      const command = ffmpeg(inputPath)
        .noVideo()
        .audioCodec(format === 'mp3' ? 'libmp3lame' : 'aac')
        .audioBitrate(audioBitrate)
        .format(format)
        .output(output)
        .on('start', (cmd) => {
          console.log('[AudioExtractor] Audio extraction started:', cmd);
          this.activeJobs.set(jobId, command);
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

  /**
   * Extract audio from a specific time range
   * @param {string} inputPath - Path to input video
   * @param {Object} options - Extraction options with time range
   * @param {Function} progressCallback - Progress callback
   * @returns {Promise<Object>} Result with output path
   */
  async extractAudioRange(inputPath, options = {}, progressCallback = null) {
    const {
      startTime = 0,
      endTime = null,
      duration = null,
      format = 'mp3',
      audioBitrate = '128k',
      outputPath = null
    } = options;

    const baseName = path.basename(inputPath, path.extname(inputPath));
    const output = outputPath || path.join(this.outputDir, `${baseName}_audio_range.${format}`);
    const jobId = `extract_range_${Date.now()}`;

    return new Promise((resolve, reject) => {
      let command = ffmpeg(inputPath)
        .setStartTime(startTime);

      if (duration) {
        command = command.duration(duration);
      } else if (endTime) {
        command = command.duration(endTime - startTime);
      }

      command
        .noVideo()
        .audioCodec(format === 'mp3' ? 'libmp3lame' : 'aac')
        .audioBitrate(audioBitrate)
        .format(format)
        .output(output)
        .on('start', (cmd) => {
          console.log('[AudioExtractor] Range extraction started:', cmd);
          this.activeJobs.set(jobId, command);
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
















