/**
 * BranchRenderer - Render video from branch EDL
 * Takes EDL + source video and renders final output
 * @module src/video/versioning/BranchRenderer
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const ffmpegStatic = require('@ffmpeg-installer/ffmpeg');
const ffprobeStatic = require('@ffprobe-installer/ffprobe');
const ffmpegLib = require('fluent-ffmpeg');

// Set FFmpeg paths
ffmpegLib.setFfmpegPath(ffmpegStatic.path);
ffmpegLib.setFfprobePath(ffprobeStatic.path);

const { app } = require('electron');

import { SEGMENT_TYPES } from './EDLManager.js';

/**
 * Service for rendering videos from branch EDLs
 */
export class BranchRenderer {
  constructor() {
    this.outputDir = path.join(app.getPath('userData'), 'video-exports');
    this.tempDir = path.join(app.getPath('userData'), 'video-temp');
    this.activeJobs = new Map();
    
    this.ensureDirectories();
  }

  /**
   * Ensure required directories exist
   */
  ensureDirectories() {
    [this.outputDir, this.tempDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  /**
   * Render a branch version to video file
   * @param {string} projectPath - Path to project
   * @param {Object} edl - EDL data to render
   * @param {Object} options - Render options
   * @param {Function} progressCallback - Progress callback
   * @returns {Promise<Object>} Render result with output path
   */
  async renderBranch(projectPath, edl, options = {}, progressCallback = null) {
    const {
      outputPath = null,
      format = 'mp4',
      quality = 'high',
      resolution = null
    } = options;

    const sourceVideoPath = path.join(projectPath, edl.sourceVideo);
    
    if (!fs.existsSync(sourceVideoPath)) {
      throw new Error(`Source video not found: ${sourceVideoPath}`);
    }

    const jobId = `render_${Date.now()}`;
    const baseName = path.basename(sourceVideoPath, path.extname(sourceVideoPath));
    const output = outputPath || path.join(this.outputDir, `${baseName}_rendered_${Date.now()}.${format}`);

    // Get include segments
    const segments = (edl.segments || []).filter(
      seg => seg.type === SEGMENT_TYPES.INCLUDE
    ).sort((a, b) => a.startTime - b.startTime);

    if (segments.length === 0) {
      throw new Error('No segments to render');
    }

    console.log(`[BranchRenderer] Rendering ${segments.length} segments from: ${sourceVideoPath}`);

    try {
      if (progressCallback) {
        progressCallback({ status: 'Preparing render...', percent: 0 });
      }

      // If single segment with no effects, do simple trim
      if (segments.length === 1 && !this._hasEffects(edl)) {
        return await this._renderSimpleTrim(
          sourceVideoPath, 
          segments[0], 
          output, 
          { format, quality, resolution },
          progressCallback
        );
      }

      // Multiple segments - need to concatenate
      return await this._renderConcatenation(
        sourceVideoPath,
        segments,
        edl,
        output,
        { format, quality, resolution },
        progressCallback
      );

    } catch (error) {
      console.error('[BranchRenderer] Render failed:', error);
      throw error;
    }
  }

  /**
   * Render a simple trim (single segment, no effects)
   * @private
   */
  async _renderSimpleTrim(sourcePath, segment, outputPath, options, progressCallback) {
    const { format, quality, resolution } = options;

    return new Promise((resolve, reject) => {
      let command = ffmpegLib(sourcePath)
        .setStartTime(segment.startTime);

      if (segment.endTime) {
        command = command.setDuration(segment.endTime - segment.startTime);
      }

      // Apply quality settings
      command = this._applyQualitySettings(command, quality, format);

      // Apply resolution if specified
      if (resolution) {
        command = command.size(resolution);
      }

      command
        .output(outputPath)
        .on('start', (cmd) => {
          console.log('[BranchRenderer] Simple trim started');
        })
        .on('progress', (progress) => {
          if (progressCallback) {
            progressCallback({
              status: 'Rendering...',
              percent: Math.min(95, progress.percent || 0)
            });
          }
        })
        .on('end', () => {
          if (progressCallback) {
            progressCallback({ status: 'Complete!', percent: 100 });
          }
          console.log('[BranchRenderer] Simple trim complete:', outputPath);
          resolve({
            success: true,
            outputPath: outputPath,
            duration: segment.endTime - segment.startTime
          });
        })
        .on('error', (err) => {
          reject(err);
        })
        .run();
    });
  }

  /**
   * Render multiple segments by concatenation
   * @private
   */
  async _renderConcatenation(sourcePath, segments, edl, outputPath, options, progressCallback) {
    const { format, quality, resolution } = options;
    const tempDir = path.join(this.tempDir, `render_${Date.now()}`);
    
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      const segmentFiles = [];
      const totalSegments = segments.length;

      // Extract each segment
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const segmentPath = path.join(tempDir, `segment_${String(i).padStart(3, '0')}.${format}`);

        if (progressCallback) {
          const basePercent = (i / totalSegments) * 70;
          progressCallback({
            status: `Extracting segment ${i + 1}/${totalSegments}...`,
            percent: basePercent
          });
        }

        await this._extractSegment(sourcePath, segment, segmentPath, { quality, resolution });
        segmentFiles.push(segmentPath);
      }

      if (progressCallback) {
        progressCallback({ status: 'Concatenating segments...', percent: 75 });
      }

      // Create concat list file
      const listPath = path.join(tempDir, 'concat_list.txt');
      const listContent = segmentFiles.map(f => `file '${f}'`).join('\n');
      fs.writeFileSync(listPath, listContent);

      // Concatenate all segments
      await new Promise((resolve, reject) => {
        ffmpegLib()
          .input(listPath)
          .inputOptions(['-f', 'concat', '-safe', '0'])
          .outputOptions(['-c', 'copy'])
          .output(outputPath)
          .on('progress', (progress) => {
            if (progressCallback) {
              progressCallback({
                status: 'Finalizing...',
                percent: 75 + (progress.percent || 0) * 0.2
              });
            }
          })
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      // Apply effects if any
      if (this._hasEffects(edl)) {
        if (progressCallback) {
          progressCallback({ status: 'Applying effects...', percent: 95 });
        }
        await this._applyEffects(outputPath, edl.effects);
      }

      // Cleanup temp files
      this._cleanupTempDir(tempDir);

      if (progressCallback) {
        progressCallback({ status: 'Complete!', percent: 100 });
      }

      // Calculate total duration
      const totalDuration = segments.reduce((sum, seg) => {
        return sum + ((seg.endTime || 0) - (seg.startTime || 0));
      }, 0);

      console.log('[BranchRenderer] Concatenation complete:', outputPath);
      
      return {
        success: true,
        outputPath: outputPath,
        segmentCount: segments.length,
        duration: totalDuration
      };

    } catch (error) {
      this._cleanupTempDir(tempDir);
      throw error;
    }
  }

  /**
   * Extract a single segment from source video
   * @private
   */
  _extractSegment(sourcePath, segment, outputPath, options) {
    const { quality, resolution } = options;

    return new Promise((resolve, reject) => {
      let command = ffmpegLib(sourcePath)
        .setStartTime(segment.startTime);

      if (segment.endTime) {
        command = command.setDuration(segment.endTime - segment.startTime);
      }

      // Apply quality settings
      command = this._applyQualitySettings(command, quality, path.extname(outputPath).slice(1));

      // Apply resolution if specified
      if (resolution) {
        command = command.size(resolution);
      }

      command
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
  }

  /**
   * Apply quality settings to FFmpeg command
   * @private
   */
  _applyQualitySettings(command, quality, format) {
    const settings = {
      high: { crf: 18, preset: 'slow', audioBitrate: '320k' },
      medium: { crf: 23, preset: 'medium', audioBitrate: '192k' },
      low: { crf: 28, preset: 'fast', audioBitrate: '128k' }
    };

    const s = settings[quality] || settings.medium;

    if (format === 'mp4' || format === 'mov') {
      return command.outputOptions([
        '-c:v', 'libx264',
        '-crf', String(s.crf),
        '-preset', s.preset,
        '-c:a', 'aac',
        '-b:a', s.audioBitrate
      ]);
    } else if (format === 'webm') {
      return command.outputOptions([
        '-c:v', 'libvpx-vp9',
        '-crf', String(s.crf),
        '-b:v', '0',
        '-c:a', 'libopus',
        '-b:a', s.audioBitrate
      ]);
    }

    return command;
  }

  /**
   * Check if EDL has any effects to apply
   * @private
   */
  _hasEffects(edl) {
    if (!edl.effects) return false;
    
    return edl.effects.fadeIn || 
           edl.effects.fadeOut || 
           (edl.effects.speed && edl.effects.speed !== 1.0) ||
           edl.effects.reversed;
  }

  /**
   * Apply effects to rendered video
   * @private
   */
  async _applyEffects(videoPath, effects) {
    if (!effects) return;

    const tempOutput = videoPath.replace(/(\.\w+)$/, '_temp$1');
    
    // Build filter chain
    const videoFilters = [];
    const audioFilters = [];

    if (effects.fadeIn) {
      videoFilters.push(`fade=t=in:st=0:d=${effects.fadeIn}`);
      audioFilters.push(`afade=t=in:st=0:d=${effects.fadeIn}`);
    }

    if (effects.fadeOut) {
      // Need to get video duration for fade out
      const duration = await this._getVideoDuration(videoPath);
      const fadeStart = duration - effects.fadeOut;
      videoFilters.push(`fade=t=out:st=${fadeStart}:d=${effects.fadeOut}`);
      audioFilters.push(`afade=t=out:st=${fadeStart}:d=${effects.fadeOut}`);
    }

    if (effects.speed && effects.speed !== 1.0) {
      videoFilters.push(`setpts=${1/effects.speed}*PTS`);
      audioFilters.push(`atempo=${effects.speed}`);
    }

    if (videoFilters.length === 0 && audioFilters.length === 0) {
      return;
    }

    // Apply filters
    await new Promise((resolve, reject) => {
      let command = ffmpegLib(videoPath);

      if (videoFilters.length > 0) {
        command = command.videoFilters(videoFilters);
      }
      if (audioFilters.length > 0) {
        command = command.audioFilters(audioFilters);
      }

      if (effects.reversed) {
        command = command.outputOptions(['-vf', 'reverse', '-af', 'areverse']);
      }

      command
        .outputOptions(['-c:v', 'libx264', '-c:a', 'aac'])
        .output(tempOutput)
        .on('end', () => {
          // Replace original with effected version
          fs.unlinkSync(videoPath);
          fs.renameSync(tempOutput, videoPath);
          resolve();
        })
        .on('error', reject)
        .run();
    });
  }

  /**
   * Get video duration
   * @private
   */
  _getVideoDuration(videoPath) {
    return new Promise((resolve, reject) => {
      ffmpegLib.ffprobe(videoPath, (err, metadata) => {
        if (err) reject(err);
        else resolve(metadata.format.duration);
      });
    });
  }

  /**
   * Cleanup temporary directory
   * @private
   */
  _cleanupTempDir(tempDir) {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch (e) {
      console.warn('[BranchRenderer] Cleanup error:', e);
    }
  }

  /**
   * Get render progress for active job
   * @param {string} jobId - Job ID
   * @returns {Object|null} Progress info
   */
  getJobProgress(jobId) {
    return this.activeJobs.get(jobId) || null;
  }

  /**
   * Cancel an active render job
   * @param {string} jobId - Job ID to cancel
   * @returns {boolean} Whether job was cancelled
   */
  cancelJob(jobId) {
    const job = this.activeJobs.get(jobId);
    if (job && job.command) {
      job.command.kill('SIGKILL');
      this.activeJobs.delete(jobId);
      return true;
    }
    return false;
  }

  /**
   * Preview render settings without actually rendering
   * @param {Object} edl - EDL data
   * @param {Object} options - Render options
   * @returns {Object} Preview info
   */
  previewRender(edl, options = {}) {
    const segments = (edl.segments || []).filter(
      seg => seg.type === SEGMENT_TYPES.INCLUDE
    );

    const totalDuration = segments.reduce((sum, seg) => {
      return sum + ((seg.endTime || 0) - (seg.startTime || 0));
    }, 0);

    const estimatedSize = this._estimateFileSize(totalDuration, options.quality || 'medium');

    return {
      segmentCount: segments.length,
      totalDuration: totalDuration,
      formattedDuration: this._formatDuration(totalDuration),
      hasEffects: this._hasEffects(edl),
      effects: edl.effects || {},
      estimatedSize: estimatedSize,
      estimatedSizeFormatted: this._formatFileSize(estimatedSize)
    };
  }

  /**
   * Estimate file size based on duration and quality
   * @private
   */
  _estimateFileSize(duration, quality) {
    // Rough estimates in bytes per second
    const bitrateByQuality = {
      high: 5000000,   // ~5 Mbps
      medium: 2500000, // ~2.5 Mbps
      low: 1000000     // ~1 Mbps
    };

    const bitrate = bitrateByQuality[quality] || bitrateByQuality.medium;
    return Math.round((duration * bitrate) / 8);
  }

  /**
   * Format duration as HH:MM:SS
   * @private
   */
  _formatDuration(seconds) {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hrs > 0) {
      return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }

  /**
   * Format file size
   * @private
   */
  _formatFileSize(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    
    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }
}







