/**
 * SceneDetector - Auto-detect scene boundaries in video
 * @module src/video/scenes/SceneDetector
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
 * Service for automatic scene detection
 */
export class SceneDetector {
  constructor() {
    this.outputDir = path.join(app.getPath('userData'), 'video-exports');
    this.videoProcessor = new VideoProcessor();
  }

  /**
   * Auto-detect scene boundaries using audio silence and video changes
   * Useful as a starting point for manual scene markup
   * @param {string} inputPath - Path to video file
   * @param {Object} options - Detection options
   * @returns {Promise<Object>} Detection result with scenes array
   */
  async detectScenes(inputPath, options = {}) {
    const {
      minSceneDuration = 5, // Minimum scene duration in seconds
      silenceThreshold = -30, // dB threshold for silence detection
      silenceDuration = 0.5 // Minimum silence duration to mark as scene break
    } = options;

    log.info('video', '[SceneDetector] Detecting scenes in:', { v0: inputPath });

    const info = await this.videoProcessor.getVideoInfo(inputPath);
    const duration = info.duration;

    // Use FFmpeg's silencedetect filter to find silent points
    const tempFile = path.join(this.outputDir, `silence_${Date.now()}.txt`);

    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .audioFilters(`silencedetect=noise=${silenceThreshold}dB:d=${silenceDuration}`)
        .outputOptions(['-f', 'null'])
        .output('-')
        .on('stderr', (line) => {
          // FFmpeg outputs silence detection to stderr
          fs.appendFileSync(tempFile, line + '\n');
        })
        .on('end', () => {
          try {
            let silencePoints = [];
            
            if (fs.existsSync(tempFile)) {
              const content = fs.readFileSync(tempFile, 'utf8');
              
              // Parse silence_start and silence_end from FFmpeg output
              const startMatches = content.matchAll(/silence_start:\s*([\d.]+)/g);
              const endMatches = content.matchAll(/silence_end:\s*([\d.]+)/g);
              
              const starts = [...startMatches].map(m => parseFloat(m[1]));
              const ends = [...endMatches].map(m => parseFloat(m[1]));
              
              // Combine into silence periods
              for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
                silencePoints.push({
                  start: starts[i],
                  end: ends[i],
                  midpoint: (starts[i] + ends[i]) / 2
                });
              }
              
              fs.unlinkSync(tempFile);
            }

            // Generate scene boundaries from silence points
            const scenes = this.buildScenesFromSilence(silencePoints, duration, minSceneDuration);

            log.info('video', '[SceneDetector] Detected scenes', { v0: scenes.length });

            resolve({
              success: true,
              scenes,
              totalDuration: duration,
              silencePoints: silencePoints.length
            });

          } catch (error) {
            reject(error);
          }
        })
        .on('error', (err) => {
          if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
          reject(err);
        })
        .run();
    });
  }

  /**
   * Build scenes from silence points
   * @private
   */
  buildScenesFromSilence(silencePoints, duration, minSceneDuration) {
    const scenes = [];
    let sceneStart = 0;
    let sceneId = 1;

    for (const silence of silencePoints) {
      const sceneEnd = silence.midpoint;
      const sceneDuration = sceneEnd - sceneStart;
      
      // Only create scene if it meets minimum duration
      if (sceneDuration >= minSceneDuration) {
        scenes.push({
          id: sceneId++,
          name: `Scene ${scenes.length + 1}`,
          inTime: sceneStart,
          outTime: sceneEnd,
          duration: sceneDuration,
          description: '',
          tags: [],
          autoDetected: true
        });
        sceneStart = sceneEnd;
      }
    }

    // Add final scene if there's remaining content
    if (duration - sceneStart >= minSceneDuration) {
      scenes.push({
        id: sceneId++,
        name: `Scene ${scenes.length + 1}`,
        inTime: sceneStart,
        outTime: duration,
        duration: duration - sceneStart,
        description: '',
        tags: [],
        autoDetected: true
      });
    }

    // If no scenes detected, create one for the whole video
    if (scenes.length === 0) {
      scenes.push({
        id: 1,
        name: 'Full Video',
        inTime: 0,
        outTime: duration,
        duration: duration,
        description: '',
        tags: [],
        autoDetected: true
      });
    }

    return scenes;
  }

  /**
   * Detect scenes using visual changes (more computationally intensive)
   * @param {string} inputPath - Path to video file
   * @param {Object} options - Detection options
   * @returns {Promise<Object>} Detection result
   */
  async detectVisualScenes(inputPath, options = {}) {
    const {
      threshold = 0.4, // Scene change threshold (0-1)
      minSceneDuration = 3
    } = options;

    const info = await this.videoProcessor.getVideoInfo(inputPath);
    const duration = info.duration;

    return new Promise((resolve, reject) => {
      const sceneChanges = [];
      
      ffmpeg(inputPath)
        .videoFilters(`select='gt(scene,${threshold})',showinfo`)
        .outputOptions(['-f', 'null'])
        .output('-')
        .on('stderr', (line) => {
          // Parse pts_time from showinfo output
          const match = line.match(/pts_time:([\d.]+)/);
          if (match) {
            sceneChanges.push(parseFloat(match[1]));
          }
        })
        .on('end', () => {
          const scenes = this.buildScenesFromChanges(sceneChanges, duration, minSceneDuration);
          
          resolve({
            success: true,
            scenes,
            totalDuration: duration,
            changePoints: sceneChanges.length
          });
        })
        .on('error', reject)
        .run();
    });
  }

  /**
   * Build scenes from visual change points
   * @private
   */
  buildScenesFromChanges(changePoints, duration, minSceneDuration) {
    const scenes = [];
    let sceneStart = 0;

    for (const changePoint of changePoints) {
      const sceneDuration = changePoint - sceneStart;
      
      if (sceneDuration >= minSceneDuration) {
        scenes.push({
          id: scenes.length + 1,
          name: `Scene ${scenes.length + 1}`,
          inTime: sceneStart,
          outTime: changePoint,
          duration: sceneDuration,
          description: '',
          tags: [],
          autoDetected: true,
          method: 'visual'
        });
        sceneStart = changePoint;
      }
    }

    // Add final scene
    if (duration - sceneStart >= minSceneDuration) {
      scenes.push({
        id: scenes.length + 1,
        name: `Scene ${scenes.length + 1}`,
        inTime: sceneStart,
        outTime: duration,
        duration: duration - sceneStart,
        description: '',
        tags: [],
        autoDetected: true,
        method: 'visual'
      });
    }

    return scenes;
  }
}
















