/**
 * VideoProcessor - Core video processing utilities and FFmpeg setup
 * @module src/video/core/VideoProcessor
 */

import ffmpegLib from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';

// Electron needs to be required, not imported, when used in ES modules
const require = createRequire(import.meta.url);
const { app } = require('electron');

// Set FFmpeg paths
ffmpegLib.setFfmpegPath(ffmpegInstaller.path);
ffmpegLib.setFfprobePath(ffprobeInstaller.path);

// Export ffmpeg instance for use by other services
export const ffmpeg = ffmpegLib;

/**
 * Format duration from seconds to HH:MM:SS
 * @param {number} seconds - Duration in seconds
 * @returns {string} Formatted duration string
 */
export function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '00:00:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Format time for display (M:SS or H:MM:SS)
 * @param {number} seconds - Time in seconds
 * @returns {string} Formatted time string
 */
export function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(2, '0')}`;
}

/**
 * Parse time string to seconds
 * @param {string|number} timeStr - Time string (HH:MM:SS, MM:SS, or seconds)
 * @returns {number} Time in seconds
 */
export function parseTime(timeStr) {
  if (typeof timeStr === 'number') return timeStr;
  if (!timeStr) return 0;
  
  const parts = timeStr.split(':').map(Number);
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return parseFloat(timeStr) || 0;
}

/**
 * Resample array to target length (for waveform data)
 * @param {Array} arr - Source array
 * @param {number} targetLength - Desired output length
 * @returns {Array} Resampled array
 */
export function resampleArray(arr, targetLength) {
  if (!arr || arr.length === 0) return new Array(targetLength).fill(0);
  if (arr.length === targetLength) return arr;
  
  const result = [];
  const ratio = arr.length / targetLength;
  
  for (let i = 0; i < targetLength; i++) {
    const srcIndex = Math.floor(i * ratio);
    const nextIndex = Math.min(srcIndex + Math.ceil(ratio), arr.length - 1);
    
    // Take max value in range for peaks
    let maxVal = 0;
    for (let j = srcIndex; j <= nextIndex; j++) {
      maxVal = Math.max(maxVal, arr[j] || 0);
    }
    result.push(maxVal);
  }
  
  return result;
}

/**
 * VideoProcessor - Core class for video processing operations
 */
export class VideoProcessor {
  constructor() {
    this.activeJobs = new Map();
    this.outputDir = path.join(app.getPath('userData'), 'video-exports');
    this.thumbnailDir = path.join(app.getPath('userData'), 'video-thumbnails');
    
    // Ensure directories exist
    this.ensureDirectories();
    
    console.log('[VideoProcessor] Initialized');
    console.log('[VideoProcessor] FFmpeg path:', ffmpegInstaller.path);
    console.log('[VideoProcessor] FFprobe path:', ffprobeInstaller.path);
    console.log('[VideoProcessor] Output dir:', this.outputDir);
  }

  /**
   * Ensure output directories exist
   */
  ensureDirectories() {
    [this.outputDir, this.thumbnailDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  /**
   * Get video metadata/info
   * @param {string} inputPath - Path to video file
   * @returns {Promise<Object>} Video metadata
   */
  getVideoInfo(inputPath) {
    return new Promise((resolve, reject) => {
      // Validate input path
      if (!inputPath) {
        reject(new Error('No video path provided'));
        return;
      }

      // Check if file exists
      if (!fs.existsSync(inputPath)) {
        reject(new Error(`Video file does not exist: ${inputPath}`));
        return;
      }

      // Check if it's a file (not a directory)
      const stats = fs.statSync(inputPath);
      if (!stats.isFile()) {
        reject(new Error(`Path is not a file: ${inputPath}`));
        return;
      }

      console.log('[VideoProcessor] Getting info for:', inputPath);

      ffmpegLib.ffprobe(inputPath, (err, metadata) => {
        if (err) {
          console.error('[VideoProcessor] FFprobe error:', err);
          reject(new Error(`Failed to analyze video: ${err.message}`));
          return;
        }

        const videoStream = metadata.streams.find(s => s.codec_type === 'video');
        const audioStream = metadata.streams.find(s => s.codec_type === 'audio');

        resolve({
          duration: metadata.format.duration,
          durationFormatted: formatDuration(metadata.format.duration),
          size: metadata.format.size,
          bitrate: metadata.format.bit_rate,
          format: metadata.format.format_name,
          video: videoStream ? {
            codec: videoStream.codec_name,
            width: videoStream.width,
            height: videoStream.height,
            fps: videoStream.r_frame_rate ? eval(videoStream.r_frame_rate) : null,
            aspectRatio: videoStream.display_aspect_ratio
          } : null,
          audio: audioStream ? {
            codec: audioStream.codec_name,
            channels: audioStream.channels,
            sampleRate: audioStream.sample_rate,
            bitrate: audioStream.bit_rate
          } : null,
          raw: metadata
        });
      });
    });
  }

  /**
   * Cancel an active job
   * @param {string} jobId - Job identifier
   * @returns {boolean} Whether job was cancelled
   */
  cancelJob(jobId) {
    const job = this.activeJobs.get(jobId);
    if (job) {
      job.kill('SIGKILL');
      this.activeJobs.delete(jobId);
      return true;
    }
    return false;
  }

  /**
   * Get list of exported files
   * @returns {Array} List of exported file info objects
   */
  getExportedFiles() {
    if (!fs.existsSync(this.outputDir)) return [];

    return fs.readdirSync(this.outputDir)
      .filter(f => !f.startsWith('.') && !f.endsWith('.txt'))
      .map(f => {
        const filePath = path.join(this.outputDir, f);
        const stats = fs.statSync(filePath);
        return {
          name: f,
          path: filePath,
          size: stats.size,
          created: stats.birthtime,
          modified: stats.mtime
        };
      })
      .sort((a, b) => b.modified - a.modified);
  }

  /**
   * Format duration - instance method wrapper
   */
  formatDuration(seconds) {
    return formatDuration(seconds);
  }

  /**
   * Parse time - instance method wrapper
   */
  parseTime(timeStr) {
    return parseTime(timeStr);
  }
}






