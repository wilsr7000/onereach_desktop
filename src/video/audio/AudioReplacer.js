/**
 * AudioReplacer - Replace audio segments in video
 * @module src/video/audio/AudioReplacer
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
 * Service for replacing audio in video files
 */
export class AudioReplacer {
  constructor() {
    this.outputDir = path.join(app.getPath('userData'), 'video-exports');
    this.activeJobs = new Map();
    this.videoProcessor = new VideoProcessor();
  }

  /**
   * Replace audio segment in video
   * @param {string} videoPath - Path to video file
   * @param {string} audioPath - Path to new audio file
   * @param {number} startTime - Start time of segment
   * @param {number} endTime - End time of segment
   * @param {string} outputPath - Output path
   * @param {Function} progressCallback - Progress callback
   * @returns {Promise<Object>} Result with output path
   */
  async replaceAudioSegment(videoPath, audioPath, startTime, endTime, outputPath, progressCallback = null) {
    const jobId = `audio_replace_${Date.now()}`;
    const duration = endTime - startTime;

    // Get video info for progress calculations
    const videoInfo = await this.videoProcessor.getVideoInfo(videoPath);
    const totalDuration = videoInfo.duration;

    log.info('video', 'AudioReplacer video duration', { totalDuration, minutes: (totalDuration / 60).toFixed(1) });

    // Get audio duration to check if it matches the video segment
    const audioInfo = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(audioPath, (err, metadata) => {
        if (err) reject(err);
        else resolve(metadata);
      });
    });

    const audioDuration = audioInfo.format.duration;
    log.info('video', 'AudioReplacer segment info', {
      segmentDuration: duration,
      generatedAudioDuration: audioDuration,
    });

    const tempDir = path.join(this.outputDir, `temp_${Date.now()}`);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const videoOnly = path.join(tempDir, 'video_only.mp4');
    const audioBefore = path.join(tempDir, 'audio_before.mp3');
    const audioAfter = path.join(tempDir, 'audio_after.mp3');
    const audioNew = path.join(tempDir, 'audio_new.mp3');
    const audioFinal = path.join(tempDir, 'audio_final.mp3');

    try {
      // Step 1: Extract video without audio (use -c:v copy for speed!)
      log.info('video', 'AudioReplacer step 1/3: extracting video track');
      if (progressCallback) {
        progressCallback({
          jobId,
          status: 'Extracting video track (this may take a while for long videos)...',
          percent: 5,
        });
      }

      await new Promise((resolve, reject) => {
        ffmpeg(videoPath)
          .noAudio()
          .videoCodec('copy') // Just copy, don't re-encode!
          .output(videoOnly)
          .on('start', (cmd) => {
            log.info('video', 'AudioReplacer FFmpeg command', { cmd });
          })
          .on('progress', (progress) => {
            if (progressCallback && progress.percent) {
              progressCallback({
                jobId,
                status: `Extracting video track... ${Math.round(progress.percent)}%`,
                percent: 5 + progress.percent * 0.15,
                timemark: progress.timemark,
              });
            }
          })
          .on('end', () => {
            log.info('video', 'AudioReplacer video track extracted');
            resolve();
          })
          .on('error', reject)
          .run();
      });

      // Step 2: Build audio track
      log.info('video', 'AudioReplacer step 2/3: building audio track');
      if (progressCallback) {
        progressCallback({
          jobId,
          status: 'Building audio track...',
          percent: 25,
        });
      }

      await this.buildReplacedAudioTrack(
        videoPath,
        audioPath,
        startTime,
        endTime,
        audioBefore,
        audioAfter,
        audioNew,
        audioFinal,
        progressCallback,
        totalDuration
      );

      // Step 3: Merge video and new audio
      log.info('video', 'AudioReplacer step 3/3: merging video and audio');
      if (progressCallback) {
        progressCallback({
          jobId,
          status: 'Merging video and audio (final step)...',
          percent: 60,
        });
      }

      await new Promise((resolve, reject) => {
        ffmpeg(videoOnly)
          .input(audioFinal)
          .audioCodec('aac')
          .videoCodec('copy') // Just copy video, don't re-encode!
          .output(outputPath)
          .on('start', (cmd) => {
            log.info('video', 'AudioReplacer merging video and audio', { cmd });
            this.activeJobs.set(jobId, 'merge');
          })
          .on('progress', (progress) => {
            if (progressCallback) {
              const percent = progress.percent || 0;
              progressCallback({
                jobId,
                status: `Merging audio and video... ${Math.round(percent)}%`,
                percent: 60 + percent * 0.4,
                timemark: progress.timemark,
              });
            }
          })
          .on('end', () => {
            log.info('video', 'AudioReplacer merge complete');
            resolve();
          })
          .on('error', reject)
          .run();
      });

      // Clean up temp files
      this.cleanupTempDir(tempDir);
      this.activeJobs.delete(jobId);

      log.info('video', 'AudioReplacer audio replacement complete', { outputPath });
      return { success: true, outputPath, jobId };
    } catch (error) {
      log.error('video', 'AudioReplacer error', { error: error.message });
      this.cleanupTempDir(tempDir);
      this.activeJobs.delete(jobId);
      throw error;
    }
  }

  /**
   * Build audio track with replaced segment
   * @private
   */
  async buildReplacedAudioTrack(
    videoPath,
    newAudioPath,
    startTime,
    endTime,
    audioBeforePath,
    audioAfterPath,
    audioNewPath,
    outputPath,
    progressCallback = null,
    totalDuration = null
  ) {
    if (!totalDuration) {
      const videoInfo = await this.videoProcessor.getVideoInfo(videoPath);
      totalDuration = videoInfo.duration;
    }

    log.info('video', 'AudioReplacer building audio track', {
      hasBefore: startTime > 0.1,
      hasAfter: endTime < totalDuration - 0.1,
    });

    const promises = [];

    // Audio before (if startTime > 0)
    if (startTime > 0.1) {
      log.info('video', 'AudioReplacer extracting audio before segment', { from: 0, to: startTime });
      if (progressCallback) {
        progressCallback({
          status: 'Extracting audio before segment...',
          percent: 30,
        });
      }
      promises.push(
        new Promise((resolve, reject) => {
          ffmpeg(videoPath)
            .setStartTime(0)
            .setDuration(startTime)
            .noVideo()
            .audioCodec('libmp3lame')
            .output(audioBeforePath)
            .on('end', () => {
              log.info('video', 'AudioReplacer audio before extracted');
              resolve();
            })
            .on('error', reject)
            .run();
        })
      );
    }

    // Adjust new audio duration to match segment
    const segmentDuration = endTime - startTime;

    const newAudioInfo = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(newAudioPath, (err, metadata) => {
        if (err) reject(err);
        else resolve(metadata);
      });
    });

    const generatedDuration = newAudioInfo.format.duration;
    const tempoRatio = generatedDuration / segmentDuration;

    // Only adjust tempo if there's a significant difference (>5%)
    if (Math.abs(tempoRatio - 1.0) > 0.05) {
      const audioFilter = this.buildTempoFilter(tempoRatio);

      promises.push(
        new Promise((resolve, reject) => {
          ffmpeg(newAudioPath)
            .audioCodec('libmp3lame')
            .audioFilters(audioFilter)
            .output(audioNewPath)
            .on('end', resolve)
            .on('error', reject)
            .run();
        })
      );
    } else {
      // Duration is close enough, just copy the file
      promises.push(
        new Promise((resolve, reject) => {
          try {
            fs.copyFileSync(newAudioPath, audioNewPath);
            resolve();
          } catch (err) {
            reject(err);
          }
        })
      );
    }

    // Audio after (if endTime < total duration)
    if (endTime < totalDuration - 0.1) {
      log.info('video', 'AudioReplacer extracting audio after segment', { from: endTime, to: totalDuration });
      if (progressCallback) {
        progressCallback({
          status: 'Extracting audio after segment...',
          percent: 40,
        });
      }
      promises.push(
        new Promise((resolve, reject) => {
          ffmpeg(videoPath)
            .setStartTime(endTime)
            .noVideo()
            .audioCodec('libmp3lame')
            .output(audioAfterPath)
            .on('end', () => {
              log.info('video', 'AudioReplacer audio after extracted');
              resolve();
            })
            .on('error', reject)
            .run();
        })
      );
    }

    await Promise.all(promises);

    log.info('video', 'AudioReplacer concatenating audio segments');
    if (progressCallback) {
      progressCallback({
        status: 'Concatenating audio segments...',
        percent: 50,
      });
    }

    // Concatenate audio segments
    return this.concatenateAudioSegments(
      [audioBeforePath, audioNewPath, audioAfterPath],
      outputPath,
      startTime > 0.1,
      endTime < totalDuration - 0.1
    );
  }

  /**
   * Build tempo filter string for audio speed adjustment
   * @private
   */
  buildTempoFilter(tempoRatio) {
    // atempo must be between 0.5 and 2.0, so we might need multiple filters
    const tempoFilters = [];
    let currentRatio = tempoRatio;

    while (currentRatio > 2.0) {
      tempoFilters.push('atempo=2.0');
      currentRatio /= 2.0;
    }
    while (currentRatio < 0.5) {
      tempoFilters.push('atempo=0.5');
      currentRatio /= 0.5;
    }
    if (currentRatio !== 1.0) {
      tempoFilters.push(`atempo=${currentRatio.toFixed(3)}`);
    }

    return tempoFilters.join(',');
  }

  /**
   * Concatenate audio segments
   * @private
   */
  async concatenateAudioSegments(paths, outputPath, hasBefore, hasAfter) {
    const [audioBeforePath, audioNewPath, audioAfterPath] = paths;

    return new Promise((resolve, reject) => {
      const inputs = [];
      if (hasBefore && fs.existsSync(audioBeforePath)) inputs.push(audioBeforePath);
      if (fs.existsSync(audioNewPath)) inputs.push(audioNewPath);
      if (hasAfter && fs.existsSync(audioAfterPath)) inputs.push(audioAfterPath);

      if (inputs.length === 0) {
        reject(new Error('No audio segments to concatenate'));
        return;
      }

      if (inputs.length === 1) {
        fs.copyFileSync(inputs[0], outputPath);
        resolve();
        return;
      }

      // Create concat file list
      const concatFile = path.join(path.dirname(outputPath), 'concat.txt');
      const concatContent = inputs.map((f) => `file '${f}'`).join('\n');
      fs.writeFileSync(concatFile, concatContent);

      ffmpeg()
        .input(concatFile)
        .inputOptions(['-f concat', '-safe 0'])
        .audioCodec('libmp3lame')
        .output(outputPath)
        .on('end', () => {
          fs.unlinkSync(concatFile);
          resolve();
        })
        .on('error', (err) => {
          if (fs.existsSync(concatFile)) fs.unlinkSync(concatFile);
          reject(err);
        })
        .run();
    });
  }

  /**
   * Clean up temporary directory
   * @private
   */
  cleanupTempDir(tempDir) {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch (e) {
      log.warn('video', 'AudioReplacer failed to clean temp dir', { error: e.message });
    }
  }
}
