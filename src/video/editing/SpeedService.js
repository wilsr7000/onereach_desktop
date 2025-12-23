/**
 * SpeedService - Video speed and reverse operations
 * @module src/video/editing/SpeedService
 */

import { ffmpeg } from '../core/VideoProcessor.js';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { app } = require('electron');

/**
 * Service for video speed manipulation
 */
export class SpeedService {
  constructor() {
    this.outputDir = path.join(app.getPath('userData'), 'video-exports');
    this.activeJobs = new Map();
  }

  /**
   * Change video speed (speed up or slow down)
   * @param {string} inputPath - Path to input video
   * @param {Object} options - Speed options
   * @param {Function} progressCallback - Progress callback
   * @returns {Promise<Object>} Result with output path
   */
  async changeSpeed(inputPath, options = {}, progressCallback = null) {
    const {
      speed = 1.0, // 0.5 = half speed, 2.0 = double speed
      preservePitch = true, // Keep audio pitch when changing speed
      outputPath = null
    } = options;

    const baseName = path.basename(inputPath, path.extname(inputPath));
    const speedLabel = speed > 1 ? `${speed}x_fast` : `${speed}x_slow`;
    const output = outputPath || path.join(this.outputDir, `${baseName}_${speedLabel}.mp4`);
    const jobId = `speed_${Date.now()}`;

    return new Promise((resolve, reject) => {
      // Calculate filter values
      // For video: setpts=PTS/speed (higher speed = lower PTS multiplier)
      const videoSpeed = 1 / speed;
      
      // Build audio tempo filters
      // atempo only accepts values between 0.5 and 2.0
      // So we need to chain multiple atempo filters for extreme speeds
      const audioFilters = this.buildTempoFilters(speed);
      const audioFilterString = audioFilters.join(',');

      let command = ffmpeg(inputPath);
      
      // Apply video speed filter
      command = command.videoFilters(`setpts=${videoSpeed}*PTS`);
      
      // Apply audio speed filter (if video has audio)
      command = command.audioFilters(audioFilterString);
      
      command
        .videoCodec('libx264')
        .audioCodec('aac')
        .outputOptions(['-preset', 'medium', '-crf', '23'])
        .output(output)
        .on('start', (cmd) => {
          console.log('[SpeedService] Speed change started:', cmd);
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
          resolve({ success: true, outputPath: output, jobId, speed });
        })
        .on('error', (err) => {
          this.activeJobs.delete(jobId);
          reject(err);
        })
        .run();
    });
  }

  /**
   * Build audio tempo filters for a given speed
   * atempo only accepts 0.5 to 2.0, so chain filters for extreme speeds
   * @param {number} speed - Target speed
   * @returns {Array} Array of atempo filter strings
   */
  buildTempoFilters(speed) {
    const audioFilters = [];
    let remainingSpeed = speed;
    
    while (remainingSpeed > 2.0) {
      audioFilters.push('atempo=2.0');
      remainingSpeed /= 2.0;
    }
    while (remainingSpeed < 0.5) {
      audioFilters.push('atempo=0.5');
      remainingSpeed /= 0.5;
    }
    audioFilters.push(`atempo=${remainingSpeed}`);
    
    return audioFilters;
  }

  /**
   * Reverse video (play backwards)
   * @param {string} inputPath - Path to input video
   * @param {Object} options - Reverse options
   * @param {Function} progressCallback - Progress callback
   * @returns {Promise<Object>} Result with output path
   */
  async reverseVideo(inputPath, options = {}, progressCallback = null) {
    const {
      includeAudio = true,
      outputPath = null
    } = options;

    const baseName = path.basename(inputPath, path.extname(inputPath));
    const output = outputPath || path.join(this.outputDir, `${baseName}_reversed.mp4`);
    const jobId = `reverse_${Date.now()}`;

    return new Promise((resolve, reject) => {
      let command = ffmpeg(inputPath)
        .videoFilters('reverse');
      
      if (includeAudio) {
        command = command.audioFilters('areverse');
      } else {
        command = command.noAudio();
      }
      
      command
        .videoCodec('libx264')
        .audioCodec('aac')
        .outputOptions(['-preset', 'medium', '-crf', '23'])
        .output(output)
        .on('start', (cmd) => {
          console.log('[SpeedService] Reverse started:', cmd);
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
















