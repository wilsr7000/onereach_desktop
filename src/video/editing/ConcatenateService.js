/**
 * ConcatenateService - Video concatenation operations
 * @module src/video/editing/ConcatenateService
 */

import { ffmpeg } from '../core/VideoProcessor.js';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { app } = require('electron');
const { getLogQueue } = require('../../../lib/log-event-queue');
const log = getLogQueue();

/**
 * Service for concatenating multiple videos
 */
export class ConcatenateService {
  constructor() {
    this.outputDir = path.join(app.getPath('userData'), 'video-exports');
    this.activeJobs = new Map();
  }

  /**
   * Concatenate multiple videos into one
   * @param {Array} inputPaths - Array of video file paths
   * @param {Object} options - Concatenation options
   * @param {Function} progressCallback - Progress callback
   * @returns {Promise<Object>} Result with output path
   */
  async concatenateVideos(inputPaths, options = {}, progressCallback = null) {
    const {
      outputPath = null,
      format = 'mp4'
    } = options;

    if (!inputPaths || inputPaths.length === 0) {
      throw new Error('No input paths provided');
    }

    const output = outputPath || path.join(this.outputDir, `merged_${Date.now()}.${format}`);
    const jobId = `concat_${Date.now()}`;

    return new Promise((resolve, reject) => {
      // Create temporary file list
      const listFile = path.join(this.outputDir, `concat_${jobId}.txt`);
      const listContent = inputPaths.map(p => `file '${p}'`).join('\n');
      fs.writeFileSync(listFile, listContent);

      ffmpeg()
        .input(listFile)
        .inputOptions(['-f concat', '-safe 0'])
        .outputOptions(['-c copy'])
        .output(output)
        .on('start', (cmd) => {
          log.info('video', '[ConcatenateService] Concatenation started', { data: cmd });
          this.activeJobs.set(jobId, {});
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
          fs.unlinkSync(listFile);
          resolve({ success: true, outputPath: output, jobId });
        })
        .on('error', (err) => {
          this.activeJobs.delete(jobId);
          if (fs.existsSync(listFile)) fs.unlinkSync(listFile);
          reject(err);
        })
        .run();
    });
  }

  /**
   * Merge videos with re-encoding (for different formats/codecs)
   * @param {Array} inputPaths - Array of video file paths
   * @param {Object} options - Merge options
   * @param {Function} progressCallback - Progress callback
   * @returns {Promise<Object>} Result with output path
   */
  async mergeVideos(inputPaths, options = {}, progressCallback = null) {
    const {
      outputPath = null,
      format = 'mp4',
      videoCodec = 'libx264',
      audioCodec = 'aac',
      preset = 'medium',
      crf = 23
    } = options;

    if (!inputPaths || inputPaths.length === 0) {
      throw new Error('No input paths provided');
    }

    const output = outputPath || path.join(this.outputDir, `merged_${Date.now()}.${format}`);
    const jobId = `merge_${Date.now()}`;

    return new Promise((resolve, reject) => {
      // Create temporary file list
      const listFile = path.join(this.outputDir, `merge_${jobId}.txt`);
      const listContent = inputPaths.map(p => `file '${p}'`).join('\n');
      fs.writeFileSync(listFile, listContent);

      ffmpeg()
        .input(listFile)
        .inputOptions(['-f concat', '-safe 0'])
        .videoCodec(videoCodec)
        .audioCodec(audioCodec)
        .outputOptions([
          `-preset ${preset}`,
          `-crf ${crf}`
        ])
        .output(output)
        .on('start', (cmd) => {
          log.info('video', '[ConcatenateService] Merge started', { data: cmd });
          this.activeJobs.set(jobId, {});
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
          fs.unlinkSync(listFile);
          resolve({ success: true, outputPath: output, jobId });
        })
        .on('error', (err) => {
          this.activeJobs.delete(jobId);
          if (fs.existsSync(listFile)) fs.unlinkSync(listFile);
          reject(err);
        })
        .run();
    });
  }
}
















