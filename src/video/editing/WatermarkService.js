/**
 * WatermarkService - Add watermarks/overlays to video
 * @module src/video/editing/WatermarkService
 */

import { ffmpeg } from '../core/VideoProcessor.js';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { app } = require('electron');
const { getLogQueue } = require('../../../lib/log-event-queue');
const log = getLogQueue();

/**
 * Service for adding watermarks to videos
 */
export class WatermarkService {
  constructor() {
    this.outputDir = path.join(app.getPath('userData'), 'video-exports');
    this.activeJobs = new Map();
  }

  /**
   * Add watermark to video
   * @param {string} inputPath - Path to input video
   * @param {string} watermarkPath - Path to watermark image
   * @param {Object} options - Watermark options
   * @param {Function} progressCallback - Progress callback
   * @returns {Promise<Object>} Result with output path
   */
  async addWatermark(inputPath, watermarkPath, options = {}, progressCallback = null) {
    const {
      position = 'bottomright', // topleft, topright, bottomleft, bottomright, center
      opacity = 0.8,
      scale = 0.15, // Relative to video width
      margin = 10,
      outputPath = null,
    } = options;

    const baseName = path.basename(inputPath, path.extname(inputPath));
    const output = outputPath || path.join(this.outputDir, `${baseName}_watermarked.mp4`);
    const jobId = `watermark_${Date.now()}`;

    // Position mapping
    const positionMap = {
      topleft: `${margin}:${margin}`,
      topright: `main_w-overlay_w-${margin}:${margin}`,
      bottomleft: `${margin}:main_h-overlay_h-${margin}`,
      bottomright: `main_w-overlay_w-${margin}:main_h-overlay_h-${margin}`,
      center: '(main_w-overlay_w)/2:(main_h-overlay_h)/2',
    };

    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .input(watermarkPath)
        .complexFilter([
          `[1:v]scale=iw*${scale}:-1,format=rgba,colorchannelmixer=aa=${opacity}[wm]`,
          `[0:v][wm]overlay=${positionMap[position] || positionMap['bottomright']}`,
        ])
        .videoCodec('libx264')
        .audioCodec('copy')
        .outputOptions(['-preset medium', '-crf 23'])
        .output(output)
        .on('start', (cmd) => {
          log.info('video', '[WatermarkService] Watermark started', { data: cmd });
          this.activeJobs.set(jobId, {});
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
   * Add text overlay to video
   * @param {string} inputPath - Path to input video
   * @param {string} text - Text to overlay
   * @param {Object} options - Text options
   * @param {Function} progressCallback - Progress callback
   * @returns {Promise<Object>} Result with output path
   */
  async addTextOverlay(inputPath, text, options = {}, progressCallback = null) {
    const {
      position = 'bottom',
      fontSize = 24,
      fontColor = 'white',
      backgroundColor = 'black@0.5',
      outputPath = null,
    } = options;

    const baseName = path.basename(inputPath, path.extname(inputPath));
    const output = outputPath || path.join(this.outputDir, `${baseName}_text.mp4`);
    const jobId = `text_${Date.now()}`;

    // Position mapping for drawtext filter
    const positionMap = {
      top: 'x=(w-text_w)/2:y=20',
      bottom: 'x=(w-text_w)/2:y=h-th-20',
      center: 'x=(w-text_w)/2:y=(h-text_h)/2',
    };

    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .videoFilters([
          `drawtext=text='${text}':fontsize=${fontSize}:fontcolor=${fontColor}:box=1:boxcolor=${backgroundColor}:${positionMap[position] || positionMap['bottom']}`,
        ])
        .videoCodec('libx264')
        .audioCodec('copy')
        .outputOptions(['-preset medium', '-crf 23'])
        .output(output)
        .on('start', (cmd) => {
          log.info('video', '[WatermarkService] Text overlay started', { data: cmd });
          this.activeJobs.set(jobId, {});
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
