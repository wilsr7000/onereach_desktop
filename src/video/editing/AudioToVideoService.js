/**
 * AudioToVideoService - Create video from audio with visual backgrounds
 * @module src/video/editing/AudioToVideoService
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
 * Service for creating videos from audio files
 */
export class AudioToVideoService {
  constructor() {
    this.outputDir = path.join(app.getPath('userData'), 'video-exports');
    this.activeJobs = new Map();
    this.ensureDirectory();
  }

  ensureDirectory() {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * Create video from audio with various background options
   * @param {string} audioPath - Path to audio file
   * @param {Object} options - Creation options
   * @param {Function} progressCallback - Progress callback
   * @returns {Promise<Object>} Result with output path
   */
  async createVideoFromAudio(audioPath, options = {}, progressCallback = null) {
    const {
      type = 'color', // 'color', 'image', 'slideshow'
      color = '#1a1a2e',
      imagePath = null,
      imagePaths = null,
      resolution = '1920x1080',
      transitionDuration = 1,
      outputPath = null
    } = options;

    const baseName = path.basename(audioPath, path.extname(audioPath));
    const output = outputPath || path.join(this.outputDir, `${baseName}_video.mp4`);
    const jobId = `audio2video_${Date.now()}`;

    log.info('video', '[AudioToVideoService] Creating video from audio:', { v0: audioPath });
    log.info('video', '[AudioToVideoService] Type: , Resolution:', { v0: type, v1: resolution });

    // Get audio duration first
    const duration = await this.getAudioDuration(audioPath);
    log.info('video', '[AudioToVideoService] Audio duration: s', { v0: duration });

    try {
      switch (type) {
        case 'color':
          return await this.createFromColor(audioPath, output, {
            color,
            resolution,
            duration,
            jobId,
            progressCallback
          });
        
        case 'image':
          return await this.createFromImage(audioPath, imagePath, output, {
            resolution,
            duration,
            jobId,
            progressCallback
          });
        
        case 'slideshow':
          return await this.createFromSlideshow(audioPath, imagePaths, output, {
            resolution,
            duration,
            transitionDuration,
            jobId,
            progressCallback
          });
        
        default:
          throw new Error(`Unknown video type: ${type}`);
      }
    } catch (error) {
      log.error('video', '[AudioToVideoService] Error', { error: error });
      throw error;
    }
  }

  /**
   * Get audio duration using ffprobe
   */
  async getAudioDuration(audioPath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(audioPath, (err, metadata) => {
        if (err) reject(err);
        else resolve(metadata.format.duration || 0);
      });
    });
  }

  /**
   * Create video with solid color background
   */
  async createFromColor(audioPath, outputPath, options) {
    const { color, resolution, duration, jobId, progressCallback } = options;
    const [width, height] = resolution.split('x').map(Number);

    // Convert hex color to FFmpeg format
    const ffColor = color.replace('#', '0x');

    return new Promise((resolve, reject) => {
      const command = ffmpeg()
        // Generate color video using lavfi
        .input(`color=c=${ffColor}:s=${width}x${height}:r=30:d=${duration}`)
        .inputFormat('lavfi')
        // Add audio
        .input(audioPath)
        .outputOptions([
          '-c:v', 'libx264',
          '-preset', 'medium',
          '-crf', '23',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-shortest',
          '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart'
        ])
        .output(outputPath)
        .on('start', (cmd) => {
          log.info('video', '[AudioToVideoService] FFmpeg command', { data: cmd });
          this.activeJobs.set(jobId, command);
        })
        .on('progress', (progress) => {
          if (progressCallback) {
            progressCallback({
              percent: progress.percent || 0,
              currentTime: progress.timemark
            });
          }
        })
        .on('end', () => {
          this.activeJobs.delete(jobId);
          log.info('video', '[AudioToVideoService] Video created', { data: outputPath });
          resolve({
            success: true,
            outputPath,
            duration,
            type: 'color'
          });
        })
        .on('error', (err) => {
          this.activeJobs.delete(jobId);
          reject(err);
        });

      command.run();
    });
  }

  /**
   * Create video with static image background
   */
  async createFromImage(audioPath, imagePath, outputPath, options) {
    const { resolution, duration, jobId, progressCallback } = options;
    const [width, height] = resolution.split('x').map(Number);

    if (!imagePath || !fs.existsSync(imagePath)) {
      throw new Error('Image file not found: ' + imagePath);
    }

    return new Promise((resolve, reject) => {
      const command = ffmpeg()
        // Loop image for duration
        .input(imagePath)
        .inputOptions(['-loop', '1'])
        // Add audio
        .input(audioPath)
        .outputOptions([
          '-c:v', 'libx264',
          '-preset', 'medium',
          '-crf', '23',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-t', String(duration),
          '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`,
          '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart'
        ])
        .output(outputPath)
        .on('start', (cmd) => {
          log.info('video', '[AudioToVideoService] FFmpeg command', { data: cmd });
          this.activeJobs.set(jobId, command);
        })
        .on('progress', (progress) => {
          if (progressCallback) {
            progressCallback({
              percent: progress.percent || 0,
              currentTime: progress.timemark
            });
          }
        })
        .on('end', () => {
          this.activeJobs.delete(jobId);
          log.info('video', '[AudioToVideoService] Video created', { data: outputPath });
          resolve({
            success: true,
            outputPath,
            duration,
            type: 'image'
          });
        })
        .on('error', (err) => {
          this.activeJobs.delete(jobId);
          reject(err);
        });

      command.run();
    });
  }

  /**
   * Create video with slideshow of images
   */
  async createFromSlideshow(audioPath, imagePaths, outputPath, options) {
    const { resolution, duration, transitionDuration, jobId, progressCallback } = options;
    const [width, height] = resolution.split('x').map(Number);

    if (!imagePaths || imagePaths.length === 0) {
      throw new Error('No images provided for slideshow');
    }

    // Validate images exist
    for (const imgPath of imagePaths) {
      if (!fs.existsSync(imgPath)) {
        throw new Error('Image file not found: ' + imgPath);
      }
    }

    // Calculate display time per image
    const imageCount = imagePaths.length;
    const displayTime = duration / imageCount;
    
    log.info('video', '[AudioToVideoService] Creating slideshow: images, s each', { v0: imageCount, v1: displayTime.toFixed(2) });

    // Create concat file for slideshow
    const concatFile = path.join(this.outputDir, `slideshow_${jobId}.txt`);
    const concatContent = imagePaths.map(imgPath => 
      `file '${imgPath.replace(/'/g, "'\\''")}'`
    ).join('\n');
    fs.writeFileSync(concatFile, concatContent);

    return new Promise((resolve, reject) => {
      // Use complex filter for crossfade transitions
      const command = ffmpeg()
        .input(concatFile)
        .inputOptions([
          '-f', 'concat',
          '-safe', '0',
          '-r', `1/${displayTime}` // Frame rate to match display time
        ])
        .input(audioPath)
        .outputOptions([
          '-c:v', 'libx264',
          '-preset', 'medium',
          '-crf', '23',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-t', String(duration),
          '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,fps=30`,
          '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart'
        ])
        .output(outputPath)
        .on('start', (cmd) => {
          log.info('video', '[AudioToVideoService] FFmpeg command', { data: cmd });
          this.activeJobs.set(jobId, command);
        })
        .on('progress', (progress) => {
          if (progressCallback) {
            progressCallback({
              percent: progress.percent || 0,
              currentTime: progress.timemark
            });
          }
        })
        .on('end', () => {
          this.activeJobs.delete(jobId);
          // Cleanup temp file
          try { fs.unlinkSync(concatFile); } catch (e) {}
          log.info('video', '[AudioToVideoService] Slideshow created', { data: outputPath });
          resolve({
            success: true,
            outputPath,
            duration,
            type: 'slideshow',
            imageCount
          });
        })
        .on('error', (err) => {
          this.activeJobs.delete(jobId);
          // Cleanup temp file
          try { fs.unlinkSync(concatFile); } catch (e) {}
          reject(err);
        });

      command.run();
    });
  }

  /**
   * Cancel an active job
   */
  cancelJob(jobId) {
    const command = this.activeJobs.get(jobId);
    if (command) {
      command.kill('SIGKILL');
      this.activeJobs.delete(jobId);
      return true;
    }
    return false;
  }
}


















