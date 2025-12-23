/**
 * ThumbnailService - Thumbnail generation operations
 * @module src/video/core/ThumbnailService
 */

import { ffmpeg } from './VideoProcessor.js';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { app } = require('electron');

/**
 * Service for generating video thumbnails
 */
export class ThumbnailService {
  constructor() {
    this.thumbnailDir = path.join(app.getPath('userData'), 'video-thumbnails');
    this.ensureDirectory();
  }

  /**
   * Ensure thumbnail directory exists
   */
  ensureDirectory() {
    if (!fs.existsSync(this.thumbnailDir)) {
      fs.mkdirSync(this.thumbnailDir, { recursive: true });
    }
  }

  /**
   * Generate multiple thumbnails from video
   * @param {string} inputPath - Path to video file
   * @param {Object} options - Thumbnail options
   * @returns {Promise<Array>} Array of generated thumbnail paths
   */
  async generateThumbnails(inputPath, options = {}) {
    const {
      count = 1,
      timestamps = null, // Array of specific timestamps like ['00:00:05', '00:00:10']
      size = '320x180',
      filename = 'thumb_%i.png'
    } = options;

    const outputFolder = options.outputFolder || this.thumbnailDir;
    const baseName = path.basename(inputPath, path.extname(inputPath));

    return new Promise((resolve, reject) => {
      const thumbs = [];
      
      const command = ffmpeg(inputPath)
        .on('filenames', (filenames) => {
          filenames.forEach(f => thumbs.push(path.join(outputFolder, f)));
        })
        .on('end', () => {
          resolve(thumbs);
        })
        .on('error', (err) => {
          reject(err);
        });

      if (timestamps) {
        command.screenshots({
          timestamps: timestamps,
          folder: outputFolder,
          filename: `${baseName}_${filename}`,
          size: size
        });
      } else {
        command.screenshots({
          count: count,
          folder: outputFolder,
          filename: `${baseName}_${filename}`,
          size: size
        });
      }
    });
  }

  /**
   * Generate a single thumbnail at a specific time
   * @param {string} inputPath - Path to video file
   * @param {string} timestamp - Time position (default: '00:00:01')
   * @param {string} outputPath - Optional output path
   * @returns {Promise<string>} Path to generated thumbnail
   */
  async generateSingleThumbnail(inputPath, timestamp = '00:00:01', outputPath = null) {
    const baseName = path.basename(inputPath, path.extname(inputPath));
    const output = outputPath || path.join(this.thumbnailDir, `${baseName}_preview.png`);

    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .screenshots({
          timestamps: [timestamp],
          folder: path.dirname(output),
          filename: path.basename(output),
          size: '640x360'
        })
        .on('end', () => resolve(output))
        .on('error', reject);
    });
  }

  /**
   * Generate timeline thumbnails for scrubbing/preview
   * OPTIMIZED: Uses parallel processing and fast I-frame seeking
   * @param {string} inputPath - Path to video file
   * @param {Object} options - Thumbnail options
   * @returns {Promise<Array>} Array of thumbnail paths
   */
  async generateTimelineThumbnails(inputPath, options = {}) {
    const {
      count = 10,
      width = 160,
      height = 90
    } = options;

    const baseName = path.basename(inputPath, path.extname(inputPath));
    const outputFolder = path.join(this.thumbnailDir, baseName);
    const cacheFile = path.join(outputFolder, `cache_${count}.json`);

    // Check cache first
    if (fs.existsSync(cacheFile)) {
      try {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        // Verify all files exist
        if (cached.thumbnails && cached.thumbnails.every(f => fs.existsSync(f))) {
          console.log(`[ThumbnailService] Using cached ${count} thumbnails`);
          return cached.thumbnails;
        }
      } catch (e) {
        // Cache invalid, regenerate
      }
    }

    if (!fs.existsSync(outputFolder)) {
      fs.mkdirSync(outputFolder, { recursive: true });
    }

    // Get video info first - check if it has a video stream
    const { duration, hasVideo } = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(inputPath, (err, metadata) => {
        if (err) reject(err);
        else {
          const videoStream = metadata.streams.find(s => s.codec_type === 'video');
          resolve({
            duration: metadata.format.duration || 0,
            hasVideo: !!videoStream
          });
        }
      });
    });

    // Return empty array for audio-only files
    if (!hasVideo) {
      console.log('[ThumbnailService] Audio-only file detected, skipping thumbnail generation');
      return [];
    }

    if (!duration) {
      return [];
    }

    console.log(`[ThumbnailService] Generating ${count} timeline thumbnails (parallel)...`);
    const startTime = Date.now();

    // Calculate timestamps
    const interval = duration / count;
    const timestamps = [];
    for (let i = 0; i < count; i++) {
      timestamps.push(i * interval);
    }

    // Generate thumbnails in parallel batches (4 at a time to avoid overwhelming system)
    const batchSize = 4;
    const thumbnails = new Array(count);
    
    for (let batch = 0; batch < Math.ceil(count / batchSize); batch++) {
      const batchStart = batch * batchSize;
      const batchEnd = Math.min(batchStart + batchSize, count);
      
      const promises = [];
      for (let i = batchStart; i < batchEnd; i++) {
        const time = timestamps[i];
        const outputPath = path.join(outputFolder, `timeline_${String(i + 1).padStart(3, '0')}.jpg`);
        
        // Skip if already exists (incremental generation)
        if (fs.existsSync(outputPath)) {
          thumbnails[i] = outputPath;
          continue;
        }
        
        const promise = new Promise((resolve) => {
          ffmpeg(inputPath)
            .seekInput(time)  // Fast seek BEFORE input (I-frame seeking)
            .frames(1)
            .outputOptions([
              '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`,
              '-q:v', '5'  // Lower quality for speed (2=best, 31=worst)
            ])
            .output(outputPath)
            .on('end', () => {
              thumbnails[i] = outputPath;
              resolve();
            })
            .on('error', (err) => {
              console.warn(`[ThumbnailService] Failed to generate thumbnail ${i}:`, err.message);
              resolve(); // Don't fail entire batch
            })
            .run();
        });
        promises.push(promise);
      }
      
      await Promise.all(promises);
    }

    // Filter out failed thumbnails
    const validThumbnails = thumbnails.filter(t => t && fs.existsSync(t));
    
    // Cache results
    try {
      fs.writeFileSync(cacheFile, JSON.stringify({ thumbnails: validThumbnails, count, duration }));
    } catch (e) {
      // Non-critical
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[ThumbnailService] Generated ${validThumbnails.length} thumbnails in ${elapsed}s`);

    return validThumbnails;
  }

  /**
   * Generate multiple screen grabs from a time range
   * Evenly distributed across the time range
   * @param {string} inputPath - Path to video file
   * @param {Object} options - Screengrab options
   * @returns {Promise<Object>} Result with frames array
   */
  async generateRangeScreengrabs(inputPath, options = {}) {
    const {
      startTime = 0,
      endTime,
      count = 5,
      outputDir = null,
      prefix = 'frame'
    } = options;

    // Get video info if endTime not specified
    let duration;
    if (!endTime) {
      const info = await this.getVideoInfo(inputPath);
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

    console.log(`[ThumbnailService] Generating ${count} screengrabs`);

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
              '-vf', 'scale=1920:-1',  // Full HD width, maintain aspect ratio
              '-q:v', '2'  // High quality JPEG
            ])
            .output(outputPath)
            .on('end', resolve)
            .on('error', reject)
            .run();
        });

        results.push({
          index: i + 1,
          time: time,
          timeFormatted: this.formatTime(time),
          path: outputPath,
          filename: path.basename(outputPath)
        });

      } catch (error) {
        console.error(`[ThumbnailService] Error generating frame at ${time}:`, error);
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
   * Format time helper
   * @param {number} seconds - Time in seconds
   * @returns {string} Formatted time string
   */
  formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);
    
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(2, '0')}`;
  }
}









