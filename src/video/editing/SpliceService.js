/**
 * SpliceService - Video splicing (removing sections)
 * @module src/video/editing/SpliceService
 */

import { ffmpeg } from '../core/VideoProcessor.js';
import { VideoProcessor } from '../core/VideoProcessor.js';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { app } = require('electron');
const { getLogQueue } = require('../../../lib/log-event-queue');
const log = getLogQueue();

/**
 * Service for video splicing operations
 */
export class SpliceService {
  constructor() {
    this.outputDir = path.join(app.getPath('userData'), 'video-exports');
    this.activeJobs = new Map();
    this.videoProcessor = new VideoProcessor();
  }

  /**
   * Splice video - remove a section from the middle
   * Keeps everything before cutStart and after cutEnd
   * @param {string} inputPath - Path to input video
   * @param {Object} options - Splice options
   * @param {Function} progressCallback - Progress callback
   * @returns {Promise<Object>} Result with output path
   */
  async spliceVideo(inputPath, options = {}, progressCallback = null) {
    const {
      cutStart, // Start time of section to remove
      cutEnd, // End time of section to remove
      outputPath = null,
    } = options;

    if (cutStart === undefined || cutEnd === undefined) {
      throw new Error('cutStart and cutEnd are required');
    }

    if (cutStart >= cutEnd) {
      throw new Error('cutStart must be less than cutEnd');
    }

    const baseName = path.basename(inputPath, path.extname(inputPath));
    const output = outputPath || path.join(this.outputDir, `${baseName}_spliced.mp4`);
    const jobId = `splice_${Date.now()}`;

    // Get video duration first
    const info = await this.videoProcessor.getVideoInfo(inputPath);
    const duration = info.duration;

    // Create temp files for the two parts
    const tempPart1 = path.join(this.outputDir, `temp_part1_${jobId}.mp4`);
    const tempPart2 = path.join(this.outputDir, `temp_part2_${jobId}.mp4`);
    const tempList = path.join(this.outputDir, `temp_list_${jobId}.txt`);

    try {
      // Part 1: From beginning to cutStart
      if (cutStart > 0) {
        await new Promise((resolve, reject) => {
          ffmpeg(inputPath)
            .setStartTime(0)
            .setDuration(cutStart)
            .outputOptions(['-c', 'copy', '-avoid_negative_ts', 'make_zero'])
            .output(tempPart1)
            .on('end', resolve)
            .on('error', reject)
            .run();
        });
      }

      // Part 2: From cutEnd to end
      if (cutEnd < duration) {
        await new Promise((resolve, reject) => {
          ffmpeg(inputPath)
            .setStartTime(cutEnd)
            .outputOptions(['-c', 'copy', '-avoid_negative_ts', 'make_zero'])
            .output(tempPart2)
            .on('end', resolve)
            .on('error', reject)
            .run();
        });
      }

      // Create concat list
      let listContent = '';
      if (cutStart > 0 && fs.existsSync(tempPart1)) {
        listContent += `file '${tempPart1}'\n`;
      }
      if (cutEnd < duration && fs.existsSync(tempPart2)) {
        listContent += `file '${tempPart2}'\n`;
      }

      if (!listContent) {
        throw new Error('Nothing left after splice - entire video would be removed');
      }

      fs.writeFileSync(tempList, listContent);

      // Concatenate the parts
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(tempList)
          .inputOptions(['-f', 'concat', '-safe', '0'])
          .outputOptions(['-c', 'copy'])
          .output(output)
          .on('start', (cmd) => {
            log.info('video', '[SpliceService] Splice concatenation started', { data: cmd });
            this.activeJobs.set(jobId, { cancel: () => {} });
          })
          .on('progress', (progress) => {
            if (progressCallback) {
              progressCallback({
                jobId,
                percent: progress.percent,
                timemark: progress.timemark,
              });
            }
          })
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      // Cleanup temp files
      this.cleanupTempFiles([tempPart1, tempPart2, tempList]);
      this.activeJobs.delete(jobId);

      const removedDuration = cutEnd - cutStart;
      return {
        success: true,
        outputPath: output,
        jobId,
        removedDuration,
        newDuration: duration - removedDuration,
      };
    } catch (error) {
      this.activeJobs.delete(jobId);
      this.cleanupTempFiles([tempPart1, tempPart2, tempList]);
      throw error;
    }
  }

  /**
   * Remove a section from video (alias for spliceVideo)
   * @param {string} inputPath - Path to input video
   * @param {Object} options - Options
   * @param {Function} progressCallback - Progress callback
   * @returns {Promise<Object>} Result
   */
  async removeSection(inputPath, options, progressCallback) {
    return this.spliceVideo(inputPath, options, progressCallback);
  }

  /**
   * Cleanup temporary files
   * @param {Array} files - Array of file paths to delete
   */
  cleanupTempFiles(files) {
    files.forEach((f) => {
      if (f && fs.existsSync(f)) {
        try {
          fs.unlinkSync(f);
        } catch (_e) {
          log.warn('video', '[SpliceService] Failed to delete temp file', { data: f });
        }
      }
    });
  }
}
