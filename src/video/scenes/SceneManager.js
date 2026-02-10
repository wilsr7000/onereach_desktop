/**
 * SceneManager - Process edit lists and finalize video workflows
 * @module src/video/scenes/SceneManager
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
 * Service for managing scene/edit workflows
 */
export class SceneManager {
  constructor() {
    this.outputDir = path.join(app.getPath('userData'), 'video-exports');
    this.videoProcessor = new VideoProcessor();
  }

  /**
   * Process edit list - combine multiple segments into a single video
   * This is the "edit and re-record" step
   * @param {string} inputPath - Source video path
   * @param {Array} editList - Array of segments: [{startTime, endTime, label?}]
   * @param {Object} options - Output options
   * @param {Function} progressCallback - Progress callback
   * @returns {Promise<Object>} Resolves with output path
   */
  async processEditList(inputPath, editList, options = {}, progressCallback = null) {
    const {
      outputPath = null,
      format = 'mp4',
      quality = 'high',
      preserveQuality = true
    } = options;

    if (!editList || editList.length === 0) {
      throw new Error('Edit list is empty - no segments to process');
    }

    // Sort segments by start time
    const sortedSegments = [...editList].sort((a, b) => a.startTime - b.startTime);

    // Validate segments
    this.validateSegments(sortedSegments);

    const baseName = path.basename(inputPath, path.extname(inputPath));
    const output = outputPath || path.join(this.outputDir, `${baseName}_edited_${Date.now()}.${format}`);
    const jobId = `edit_${Date.now()}`;

    log.info('video', '[SceneManager] Processing edit list with segments', { v0: editList.length });

    // Create temp directory for segment files
    const tempDir = path.join(this.outputDir, `temp_edit_${jobId}`);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    try {
      const segmentFiles = await this.extractSegments(
        inputPath, sortedSegments, tempDir, 
        quality, preserveQuality, progressCallback, jobId
      );

      if (progressCallback) {
        progressCallback({ jobId, phase: 'merging', percent: 60, message: 'Merging segments...' });
      }

      // Concatenate all segments
      await this.concatenateSegments(segmentFiles, output, tempDir, progressCallback, jobId);

      // Cleanup temp files
      this.cleanupTempDir(tempDir, segmentFiles);

      // Get output file info
      const outputInfo = await this.videoProcessor.getVideoInfo(output);

      log.info('video', '[SceneManager] Edit complete:', { v0: output });

      return {
        success: true,
        outputPath: output,
        jobId,
        segmentCount: editList.length,
        duration: outputInfo.duration,
        durationFormatted: outputInfo.durationFormatted,
        fileSize: outputInfo.size
      };

    } catch (error) {
      this.cleanupTempDir(tempDir, []);
      throw error;
    }
  }

  /**
   * Validate segment list
   * @private
   */
  validateSegments(segments) {
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.startTime >= seg.endTime) {
        throw new Error(`Invalid segment ${i + 1}: startTime must be less than endTime`);
      }
      if (i > 0 && seg.startTime < segments[i - 1].endTime) {
        throw new Error(`Segments ${i} and ${i + 1} overlap`);
      }
    }
  }

  /**
   * Extract segments from video
   * @private
   */
  async extractSegments(inputPath, segments, tempDir, quality, preserveQuality, progressCallback, jobId) {
    const segmentFiles = [];
    const totalSegments = segments.length;

    for (let i = 0; i < totalSegments; i++) {
      const seg = segments[i];
      const segmentPath = path.join(tempDir, `segment_${String(i).padStart(3, '0')}.mp4`);
      const duration = seg.endTime - seg.startTime;

      if (progressCallback) {
        progressCallback({
          jobId,
          phase: 'extracting',
          segment: i + 1,
          totalSegments,
          percent: (i / totalSegments) * 50,
          message: `Extracting segment ${i + 1}/${totalSegments}`
        });
      }

      await new Promise((resolve, reject) => {
        let cmd = ffmpeg(inputPath)
          .setStartTime(seg.startTime)
          .setDuration(duration);

        const outputOptions = this.getEncodingOptions(quality, preserveQuality);
        cmd = cmd.outputOptions(outputOptions);

        cmd.output(segmentPath)
          .on('end', () => {
            log.info('video', '[SceneManager] Segment / extracted', { v0: i + 1, v1: totalSegments });
            resolve();
          })
          .on('error', reject)
          .run();
      });

      segmentFiles.push(segmentPath);
    }

    return segmentFiles;
  }

  /**
   * Get encoding options based on quality settings
   * @private
   */
  getEncodingOptions(quality, preserveQuality) {
    if (preserveQuality) {
      return [
        '-c:v', 'libx264',
        '-c:a', 'aac',
        '-avoid_negative_ts', 'make_zero',
        '-preset', 'fast',
        '-crf', '18'
      ];
    }

    const qualitySettings = {
      'low': { crf: 28, preset: 'fast' },
      'medium': { crf: 23, preset: 'medium' },
      'high': { crf: 18, preset: 'slow' }
    };
    const settings = qualitySettings[quality] || qualitySettings.high;

    return [
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-avoid_negative_ts', 'make_zero',
      '-preset', settings.preset,
      '-crf', String(settings.crf)
    ];
  }

  /**
   * Concatenate segment files
   * @private
   */
  async concatenateSegments(segmentFiles, output, tempDir, progressCallback, jobId) {
    const listPath = path.join(tempDir, 'concat_list.txt');
    const listContent = segmentFiles.map(f => `file '${f}'`).join('\n');
    fs.writeFileSync(listPath, listContent);

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(listPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions(['-c', 'copy'])
        .output(output)
        .on('progress', (progress) => {
          if (progressCallback) {
            progressCallback({
              jobId,
              phase: 'merging',
              percent: 60 + (progress.percent || 0) * 0.4,
              message: 'Merging segments...'
            });
          }
        })
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
  }

  /**
   * Finalize video workflow - replace original and save scenes
   * @param {string} spaceItemId - Clipboard item ID of original video
   * @param {string} editedVideoPath - Path to edited video
   * @param {Array} scenes - Scene list to save
   * @param {Object} clipboardManager - Reference to clipboard manager
   * @returns {Promise<Object>} Finalization result
   */
  async finalizeVideoWorkflow(spaceItemId, editedVideoPath, scenes, clipboardManager) {
    if (!clipboardManager) {
      throw new Error('Clipboard manager reference required');
    }

    if (!fs.existsSync(editedVideoPath)) {
      throw new Error('Edited video file not found');
    }

    log.info('video', '[SceneManager] Finalizing workflow for item:', { v0: spaceItemId });

    // Get the original item
    const item = clipboardManager.storage.loadItem(spaceItemId);
    if (!item) {
      throw new Error('Original video item not found in space');
    }

    // Get the original file path in storage
    const originalPath = item.content;
    const itemDir = path.dirname(originalPath);

    // Backup original
    const backupPath = originalPath + '.backup';
    if (fs.existsSync(originalPath)) {
      fs.copyFileSync(originalPath, backupPath);
      log.info('video', '[SceneManager] Backed up original to:', { v0: backupPath });
    }

    // Copy edited video to replace original
    fs.copyFileSync(editedVideoPath, originalPath);
    log.info('video', '[SceneManager] Replaced video with edited version');

    // Update metadata with scenes
    await this.updateSceneMetadata(item, scenes, clipboardManager);

    // Get new video info
    const newInfo = await this.videoProcessor.getVideoInfo(originalPath);

    // Update index entry
    this.updateIndexEntry(spaceItemId, newInfo, clipboardManager);

    return {
      success: true,
      itemId: spaceItemId,
      scenesCount: scenes.length,
      newDuration: newInfo.duration,
      newDurationFormatted: newInfo.durationFormatted,
      newFileSize: newInfo.size,
      backupPath: backupPath
    };
  }

  /**
   * Update scene metadata
   * @private
   */
  async updateSceneMetadata(item, scenes, clipboardManager) {
    const metadataPath = path.join(clipboardManager.storage.storageRoot, item.metadataPath);
    let metadata = {};
    if (fs.existsSync(metadataPath)) {
      metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    }

    // Validate and add scenes
    const validatedScenes = scenes.map((scene, index) => ({
      id: scene.id || index + 1,
      name: scene.name || `Scene ${index + 1}`,
      inTime: scene.inTime,
      outTime: scene.outTime,
      description: scene.description || '',
      tags: scene.tags || [],
      transcription: scene.transcription || ''
    }));

    metadata.scenes = validatedScenes;
    metadata.scenesUpdatedAt = new Date().toISOString();
    metadata.editedAt = new Date().toISOString();
    metadata.editedFrom = 'video-editor-workflow';

    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
    log.info('video', '[SceneManager] Saved scenes to metadata', { v0: validatedScenes.length });
  }

  /**
   * Update index entry with new file info
   * @private
   */
  updateIndexEntry(spaceItemId, newInfo, clipboardManager) {
    const indexEntry = clipboardManager.storage.index.items.find(i => i.id === spaceItemId);
    if (indexEntry) {
      indexEntry.fileSize = newInfo.size;
      indexEntry.timestamp = Date.now();
      clipboardManager.storage.saveIndex();
    }
  }

  /**
   * Save scenes only (without re-encoding video)
   * @param {string} itemId - Clipboard item ID
   * @param {Array} scenes - Scene list to save
   * @param {Object} clipboardManager - Reference to clipboard manager
   * @returns {Promise<Object>} Save result
   */
  async saveScenesOnly(itemId, scenes, clipboardManager) {
    if (!clipboardManager) {
      throw new Error('Clipboard manager reference required');
    }

    const item = clipboardManager.storage.loadItem(itemId);
    if (!item) {
      throw new Error('Video item not found');
    }

    await this.updateSceneMetadata(item, scenes, clipboardManager);

    return {
      success: true,
      itemId,
      scenesCount: scenes.length
    };
  }

  /**
   * Clean up temporary directory
   * @private
   */
  cleanupTempDir(tempDir, segmentFiles) {
    try {
      segmentFiles.forEach(f => {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      });
      
      const listPath = path.join(tempDir, 'concat_list.txt');
      if (fs.existsSync(listPath)) fs.unlinkSync(listPath);
      
      if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
    } catch (e) {
      log.warn('video', '[SceneManager] Cleanup error', { data: e });
    }
  }
}
















