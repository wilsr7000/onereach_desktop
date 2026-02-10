/**
 * TrimService - Video trimming operations with fade support
 * @module src/video/editing/TrimService
 */

import { ffmpeg, parseTime } from '../core/VideoProcessor.js';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { app } = require('electron');
const { getLogQueue } = require('../../../lib/log-event-queue');
const log = getLogQueue();

/**
 * Service for video trimming operations
 */
export class TrimService {
  constructor() {
    this.outputDir = path.join(app.getPath('userData'), 'video-exports');
    this.activeJobs = new Map();
  }

  /**
   * Trim video with optional fade effects
   * @param {string} inputPath - Path to input video
   * @param {Object} options - Trim options
   * @param {Function} progressCallback - Progress callback
   * @returns {Promise<Object>} Result with output path
   */
  async trimVideo(inputPath, options = {}, progressCallback = null) {
    const {
      startTime = 0,
      endTime = null,
      duration = null,
      outputPath = null,
      format = null,
      fadeIn = null,    // Fade in duration in seconds
      fadeOut = null    // Fade out duration in seconds
    } = options;

    const ext = format || path.extname(inputPath).slice(1) || 'mp4';
    const baseName = path.basename(inputPath, path.extname(inputPath));
    const output = outputPath || path.join(this.outputDir, `${baseName}_trimmed.${ext}`);
    const jobId = `trim_${Date.now()}`;

    // Check if we need to apply fades (requires re-encoding)
    const hasFades = fadeIn || fadeOut;

    return new Promise((resolve, reject) => {
      let command = ffmpeg(inputPath)
        .setStartTime(parseTime(startTime));

      // Calculate the output duration
      let outputDuration = null;
      if (duration) {
        outputDuration = parseTime(duration);
        command = command.setDuration(outputDuration);
      } else if (endTime) {
        outputDuration = parseTime(endTime) - parseTime(startTime);
        command = command.setDuration(outputDuration);
      }

      if (hasFades) {
        // Build video filter for fades
        const videoFilters = [];
        const audioFilters = [];

        if (fadeIn) {
          videoFilters.push(`fade=t=in:st=0:d=${fadeIn}`);
          audioFilters.push(`afade=t=in:st=0:d=${fadeIn}`);
        }

        if (fadeOut && outputDuration) {
          const fadeOutStart = outputDuration - fadeOut;
          videoFilters.push(`fade=t=out:st=${fadeOutStart}:d=${fadeOut}`);
          audioFilters.push(`afade=t=out:st=${fadeOutStart}:d=${fadeOut}`);
        }

        // Apply filters - requires re-encoding
        if (videoFilters.length > 0) {
          command = command.videoFilters(videoFilters);
        }
        if (audioFilters.length > 0) {
          command = command.audioFilters(audioFilters);
        }

        // Use reasonable encoding settings for re-encode
        command = command.outputOptions([
          '-c:v', 'libx264',
          '-preset', 'medium',
          '-crf', '23',
          '-c:a', 'aac',
          '-b:a', '192k'
        ]);
      } else {
        // No fades - use fast copy without re-encoding
        command = command.outputOptions(['-c', 'copy']);
      }

      command
        .output(output)
        .on('start', (cmd) => {
          log.info('video', '[TrimService] Trim started', { data: cmd });
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
















