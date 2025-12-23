/**
 * ScreengrabService - Generate screengrabs from video
 * @module src/video/export/ScreengrabService
 */

import { ffmpeg } from '../core/VideoProcessor.js';
import { VideoProcessor, formatTime } from '../core/VideoProcessor.js';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { app } = require('electron');

/**
 * Service for generating video screengrabs
 */
export class ScreengrabService {
  constructor() {
    this.outputDir = path.join(app.getPath('userData'), 'video-exports');
    this.thumbnailDir = path.join(app.getPath('userData'), 'video-thumbnails');
    this.videoProcessor = new VideoProcessor();
  }

  /**
   * Generate multiple screen grabs from a range
   * Evenly distributed across the time range
   * @param {string} inputPath - Path to video file
   * @param {Object} options - Screengrab options
   * @returns {Promise<Object>} Result with frames array
   */
  async generateScreengrabs(inputPath, options = {}) {
    const {
      startTime = 0,
      endTime = null,
      count = 5,
      outputDir = null,
      prefix = 'frame',
      quality = 2, // JPEG quality (1-31, lower is better)
      width = 1920
    } = options;

    // Get video info if endTime not specified
    let duration;
    if (!endTime) {
      const info = await this.videoProcessor.getVideoInfo(inputPath);
      duration = info.duration - startTime;
    } else {
      duration = endTime - startTime;
    }

    // Calculate the time interval between captures
    const interval = count > 1 ? duration / (count - 1) : 0;
    
    // Generate list of timestamps
    const timestamps = [];
    for (let i = 0; i < count; i++) {
      const time = startTime + (interval * i);
      timestamps.push(time);
    }

    // Ensure output directory exists
    const grabsDir = outputDir || path.join(this.thumbnailDir, `grabs_${Date.now()}`);
    if (!fs.existsSync(grabsDir)) {
      fs.mkdirSync(grabsDir, { recursive: true });
    }

    console.log(`[ScreengrabService] Generating ${count} screengrabs`);

    const results = [];
    
    // Generate each screengrab
    for (let i = 0; i < timestamps.length; i++) {
      const time = timestamps[i];
      const outputPath = path.join(grabsDir, `${prefix}_${String(i + 1).padStart(3, '0')}.jpg`);
      
      try {
        await new Promise((resolve, reject) => {
          ffmpeg(inputPath)
            .seekInput(time)
            .frames(1)
            .outputOptions([
              '-vf', `scale=${width}:-1`,
              '-q:v', String(quality)
            ])
            .output(outputPath)
            .on('end', resolve)
            .on('error', reject)
            .run();
        });

        results.push({
          index: i + 1,
          time: time,
          timeFormatted: formatTime(time),
          path: outputPath,
          filename: path.basename(outputPath)
        });

        console.log(`[ScreengrabService] Generated frame ${i + 1}/${count} at ${formatTime(time)}`);
      } catch (error) {
        console.error(`[ScreengrabService] Error generating frame at ${time}:`, error);
      }
    }

    return {
      success: true,
      outputDir: grabsDir,
      count: results.length,
      frames: results,
      startTime,
      endTime: startTime + duration,
      duration
    };
  }

  /**
   * Generate screengrabs at specific timestamps
   * @param {string} inputPath - Path to video file
   * @param {Array} timestamps - Array of timestamps in seconds
   * @param {Object} options - Screengrab options
   * @returns {Promise<Object>} Result with frames array
   */
  async generateScreengrabsAtTimestamps(inputPath, timestamps, options = {}) {
    const {
      outputDir = null,
      prefix = 'frame',
      quality = 2,
      width = 1920
    } = options;

    const grabsDir = outputDir || path.join(this.thumbnailDir, `grabs_${Date.now()}`);
    if (!fs.existsSync(grabsDir)) {
      fs.mkdirSync(grabsDir, { recursive: true });
    }

    const results = [];

    for (let i = 0; i < timestamps.length; i++) {
      const time = timestamps[i];
      const outputPath = path.join(grabsDir, `${prefix}_${String(i + 1).padStart(3, '0')}.jpg`);

      try {
        await new Promise((resolve, reject) => {
          ffmpeg(inputPath)
            .seekInput(time)
            .frames(1)
            .outputOptions([
              '-vf', `scale=${width}:-1`,
              '-q:v', String(quality)
            ])
            .output(outputPath)
            .on('end', resolve)
            .on('error', reject)
            .run();
        });

        results.push({
          index: i + 1,
          time: time,
          timeFormatted: formatTime(time),
          path: outputPath,
          filename: path.basename(outputPath)
        });
      } catch (error) {
        console.error(`[ScreengrabService] Error at timestamp ${time}:`, error);
      }
    }

    return {
      success: true,
      outputDir: grabsDir,
      count: results.length,
      frames: results
    };
  }
}
















