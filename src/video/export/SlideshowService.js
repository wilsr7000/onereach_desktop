/**
 * SlideshowService - Create video slideshows from images
 * @module src/video/export/SlideshowService
 */

import { ffmpeg } from '../core/VideoProcessor.js';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { app } = require('electron');

/**
 * Service for creating video slideshows from images
 */
export class SlideshowService {
  constructor() {
    this.outputDir = path.join(app.getPath('userData'), 'video-exports');
    this.activeJobs = new Map();
  }

  /**
   * Create video from images (slideshow)
   * @param {Array} imagePaths - Array of image file paths
   * @param {Object} options - Slideshow options
   * @param {Function} progressCallback - Progress callback
   * @returns {Promise<Object>} Result with output path
   */
  async createSlideshow(imagePaths, options = {}, progressCallback = null) {
    const {
      duration = 3, // seconds per image
      fps = 30,
      transition = 'fade',
      audioPath = null,
      outputPath = null,
      resolution = '1920x1080'
    } = options;

    if (!imagePaths || imagePaths.length === 0) {
      throw new Error('No images provided');
    }

    const output = outputPath || path.join(this.outputDir, `slideshow_${Date.now()}.mp4`);
    const jobId = `slideshow_${Date.now()}`;

    return new Promise((resolve, reject) => {
      // Create a temporary file list for FFmpeg
      const listFile = path.join(this.outputDir, `filelist_${jobId}.txt`);
      const listContent = imagePaths.map(p => `file '${p}'\nduration ${duration}`).join('\n');
      fs.writeFileSync(listFile, listContent);

      let command = ffmpeg()
        .input(listFile)
        .inputOptions(['-f concat', '-safe 0'])
        .videoCodec('libx264')
        .outputOptions([
          `-vf scale=${resolution.replace('x', ':')}:force_original_aspect_ratio=decrease,pad=${resolution.replace('x', ':')}:(ow-iw)/2:(oh-ih)/2`,
          '-pix_fmt yuv420p',
          `-r ${fps}`,
          '-preset medium',
          '-crf 23'
        ]);

      if (audioPath && fs.existsSync(audioPath)) {
        command = command.input(audioPath).audioCodec('aac');
      }

      command
        .output(output)
        .on('start', (cmd) => {
          console.log('[SlideshowService] Slideshow creation started:', cmd);
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
          // Clean up temp file
          if (fs.existsSync(listFile)) fs.unlinkSync(listFile);
          resolve({ success: true, outputPath: output, jobId, imageCount: imagePaths.length });
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
   * Create slideshow with crossfade transitions
   * @param {Array} imagePaths - Array of image file paths
   * @param {Object} options - Slideshow options
   * @param {Function} progressCallback - Progress callback
   * @returns {Promise<Object>} Result with output path
   */
  async createSlideshowWithTransitions(imagePaths, options = {}, progressCallback = null) {
    const {
      duration = 3, // seconds per image
      transitionDuration = 1, // seconds for crossfade
      fps = 30,
      audioPath = null,
      outputPath = null,
      resolution = '1920x1080'
    } = options;

    if (!imagePaths || imagePaths.length === 0) {
      throw new Error('No images provided');
    }

    const output = outputPath || path.join(this.outputDir, `slideshow_${Date.now()}.mp4`);
    const jobId = `slideshow_xfade_${Date.now()}`;

    // For crossfade, we need a complex filter
    const [width, height] = resolution.split('x').map(Number);
    
    return new Promise((resolve, reject) => {
      let command = ffmpeg();
      
      // Add each image as input
      imagePaths.forEach(imgPath => {
        command = command.input(imgPath).inputOptions([`-loop 1`, `-t ${duration}`]);
      });

      // Build complex filter for crossfades
      const filters = [];
      const n = imagePaths.length;
      
      // Scale all inputs
      for (let i = 0; i < n; i++) {
        filters.push(`[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`);
      }

      // Create crossfade chain
      if (n > 1) {
        let prev = 'v0';
        for (let i = 1; i < n; i++) {
          const offset = (i * duration) - (i * transitionDuration);
          const next = i === n - 1 ? 'outv' : `cf${i}`;
          filters.push(`[${prev}][v${i}]xfade=transition=fade:duration=${transitionDuration}:offset=${offset}[${next}]`);
          prev = next;
        }
      } else {
        filters.push('[v0]copy[outv]');
      }

      command
        .complexFilter(filters.join(';'), 'outv')
        .videoCodec('libx264')
        .outputOptions([
          '-pix_fmt yuv420p',
          `-r ${fps}`,
          '-preset medium',
          '-crf 23'
        ]);

      if (audioPath && fs.existsSync(audioPath)) {
        command = command.input(audioPath).audioCodec('aac');
      }

      command
        .output(output)
        .on('start', (cmd) => {
          console.log('[SlideshowService] Crossfade slideshow started');
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
          resolve({ success: true, outputPath: output, jobId, imageCount: imagePaths.length });
        })
        .on('error', (err) => {
          this.activeJobs.delete(jobId);
          reject(err);
        })
        .run();
    });
  }
}
















