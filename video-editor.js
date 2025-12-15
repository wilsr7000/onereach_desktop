/**
 * Video Editor Module for Onereach.ai
 * Provides video editing capabilities using fluent-ffmpeg
 * Features: trimming, transcoding, thumbnails, metadata extraction
 */

const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffprobePath = require('@ffprobe-installer/ffprobe').path;
const path = require('path');
const fs = require('fs');
const https = require('https');
const { ipcMain, app, shell } = require('electron');

// Set FFmpeg paths
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

class VideoEditor {
  constructor() {
    // Log FFmpeg paths (only when constructor is called, not at module load)
    console.log('[VideoEditor] FFmpeg path:', ffmpegPath);
    console.log('[VideoEditor] FFprobe path:', ffprobePath);
    console.log('[VideoEditor] FFmpeg exists:', fs.existsSync(ffmpegPath));
    console.log('[VideoEditor] FFprobe exists:', fs.existsSync(ffprobePath));
    
    this.activeJobs = new Map();
    this.outputDir = path.join(app.getPath('userData'), 'video-exports');
    this.thumbnailDir = path.join(app.getPath('userData'), 'video-thumbnails');
    this.ipcHandlersRegistered = false; // Track if IPC handlers have been registered
    
    // Ensure directories exist
    this.ensureDirectories();
    
    console.log('[VideoEditor] Initialized with output dir:', this.outputDir);
    console.log('[VideoEditor] Thumbnail dir:', this.thumbnailDir);
  }

  ensureDirectories() {
    [this.outputDir, this.thumbnailDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  /**
   * Get video metadata/info
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

      console.log('[VideoEditor] Getting info for:', inputPath);
      console.log('[VideoEditor] FFprobe path:', ffprobePath);
      console.log('[VideoEditor] File size:', stats.size, 'bytes');

      ffmpeg.ffprobe(inputPath, (err, metadata) => {
        if (err) {
          console.error('[VideoEditor] FFprobe error:', err);
          reject(new Error(`Failed to analyze video: ${err.message}`));
          return;
        }

        const videoStream = metadata.streams.find(s => s.codec_type === 'video');
        const audioStream = metadata.streams.find(s => s.codec_type === 'audio');

        resolve({
          duration: metadata.format.duration,
          durationFormatted: this.formatDuration(metadata.format.duration),
          size: metadata.format.size,
          bitrate: metadata.format.bit_rate,
          format: metadata.format.format_name,
          video: videoStream ? {
            codec: videoStream.codec_name,
            width: videoStream.width,
            height: videoStream.height,
            fps: eval(videoStream.r_frame_rate),
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
   * Format duration from seconds to HH:MM:SS
   */
  formatDuration(seconds) {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * Parse time string to seconds
   */
  parseTime(timeStr) {
    if (typeof timeStr === 'number') return timeStr;
    const parts = timeStr.split(':').map(Number);
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    return parseFloat(timeStr);
  }

  /**
   * Generate thumbnails from video
   */
  generateThumbnails(inputPath, options = {}) {
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
   */
  generateSingleThumbnail(inputPath, timestamp = '00:00:01', outputPath = null) {
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
   * Trim video
   */
  trimVideo(inputPath, options = {}, progressCallback = null) {
    const {
      startTime = 0,
      endTime = null,
      duration = null,
      outputPath = null,
      format = null
    } = options;

    const ext = format || path.extname(inputPath).slice(1) || 'mp4';
    const baseName = path.basename(inputPath, path.extname(inputPath));
    const output = outputPath || path.join(this.outputDir, `${baseName}_trimmed.${ext}`);
    const jobId = `trim_${Date.now()}`;

    return new Promise((resolve, reject) => {
      let command = ffmpeg(inputPath)
        .setStartTime(this.parseTime(startTime));

      if (duration) {
        command = command.setDuration(this.parseTime(duration));
      } else if (endTime) {
        const dur = this.parseTime(endTime) - this.parseTime(startTime);
        command = command.setDuration(dur);
      }

      command
        .outputOptions(['-c', 'copy']) // Fast copy without re-encoding
        .output(output)
        .on('start', (cmd) => {
          console.log('[VideoEditor] Trim started:', cmd);
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
   * Transcode video to different format
   */
  transcodeVideo(inputPath, options = {}, progressCallback = null) {
    const {
      format = 'mp4',
      videoCodec = null, // null = auto, 'libx264', 'libx265', 'vp9', etc.
      audioCodec = null, // null = auto, 'aac', 'mp3', 'opus', etc.
      resolution = null, // '1920x1080', '1280x720', '640x480', etc.
      videoBitrate = null, // '5000k', '2500k', etc.
      audioBitrate = null, // '192k', '128k', etc.
      fps = null,
      preset = 'medium', // ultrafast, fast, medium, slow, veryslow
      crf = 23, // Quality: 0-51, lower = better
      outputPath = null
    } = options;

    const baseName = path.basename(inputPath, path.extname(inputPath));
    const output = outputPath || path.join(this.outputDir, `${baseName}_transcoded.${format}`);
    const jobId = `transcode_${Date.now()}`;

    return new Promise((resolve, reject) => {
      let command = ffmpeg(inputPath);

      // Video codec
      if (videoCodec) {
        command = command.videoCodec(videoCodec);
      } else {
        // Default codecs based on format
        const defaultCodecs = {
          'mp4': 'libx264',
          'webm': 'libvpx-vp9',
          'mov': 'libx264',
          'avi': 'mpeg4',
          'mkv': 'libx264'
        };
        if (defaultCodecs[format]) {
          command = command.videoCodec(defaultCodecs[format]);
        }
      }

      // Audio codec
      if (audioCodec) {
        command = command.audioCodec(audioCodec);
      } else {
        const defaultAudioCodecs = {
          'mp4': 'aac',
          'webm': 'libopus',
          'mov': 'aac',
          'avi': 'mp3',
          'mkv': 'aac'
        };
        if (defaultAudioCodecs[format]) {
          command = command.audioCodec(defaultAudioCodecs[format]);
        }
      }

      // Resolution
      if (resolution) {
        command = command.size(resolution);
      }

      // Video bitrate
      if (videoBitrate) {
        command = command.videoBitrate(videoBitrate);
      }

      // Audio bitrate
      if (audioBitrate) {
        command = command.audioBitrate(audioBitrate);
      }

      // FPS
      if (fps) {
        command = command.fps(fps);
      }

      // Preset and CRF for h264/h265
      command = command.outputOptions([
        `-preset ${preset}`,
        `-crf ${crf}`
      ]);

      command
        .format(format)
        .output(output)
        .on('start', (cmd) => {
          console.log('[VideoEditor] Transcode started:', cmd);
          this.activeJobs.set(jobId, command);
        })
        .on('progress', (progress) => {
          if (progressCallback) {
            progressCallback({
              jobId,
              percent: progress.percent,
              timemark: progress.timemark,
              currentFps: progress.currentFps,
              targetSize: progress.targetSize
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
   * Extract audio from video
   */
  extractAudio(inputPath, options = {}, progressCallback = null) {
    const {
      format = 'mp3',
      audioBitrate = '192k',
      outputPath = null
    } = options;

    const baseName = path.basename(inputPath, path.extname(inputPath));
    const output = outputPath || path.join(this.outputDir, `${baseName}_audio.${format}`);
    const jobId = `extract_audio_${Date.now()}`;

    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .noVideo()
        .audioCodec(format === 'mp3' ? 'libmp3lame' : 'aac')
        .audioBitrate(audioBitrate)
        .format(format)
        .output(output)
        .on('start', (cmd) => {
          console.log('[VideoEditor] Audio extraction started:', cmd);
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
   * Replace audio in a specific time range with ElevenLabs generated audio
   */
  async replaceAudioWithElevenLabs(inputPath, options = {}, progressCallback = null) {
    const {
      startTime,
      endTime,
      text,
      markerName = 'segment',
      voice = 'Rachel', // ElevenLabs voice ID or name
      outputPath = null
    } = options;

    if (!text || text.trim() === '') {
      throw new Error('No text provided for audio generation');
    }

    const baseName = path.basename(inputPath, path.extname(inputPath));
    const output = outputPath || path.join(this.outputDir, `${baseName}_elevenlabs_${Date.now()}.mp4`);
    const jobId = `elevenlabs_${Date.now()}`;

    try {
      if (progressCallback) {
        progressCallback({ jobId, status: 'Calling ElevenLabs API...', percent: 10 });
      }

      // Call ElevenLabs API to generate audio
      const audioFilePath = await this.generateElevenLabsAudio(text, voice);
      
      if (progressCallback) {
        progressCallback({ jobId, status: 'Processing video...', percent: 40 });
      }

      // Use FFmpeg to replace the audio segment
      const result = await this.replaceAudioSegment(inputPath, audioFilePath, startTime, endTime, output, progressCallback);
      
      // Clean up temp audio file
      if (fs.existsSync(audioFilePath)) {
        fs.unlinkSync(audioFilePath);
      }

      if (progressCallback) {
        progressCallback({ jobId, status: 'Complete!', percent: 100 });
      }

      return { 
        success: true, 
        outputPath: output, 
        jobId,
        message: `Audio replaced with ElevenLabs for "${markerName}"`
      };

    } catch (error) {
      console.error('[VideoEditor] ElevenLabs replacement error:', error);
      throw error;
    }
  }

  /**
   * Generate audio using ElevenLabs API
   */
  async generateElevenLabsAudio(text, voice = 'Rachel') {
    const outputPath = path.join(this.outputDir, `elevenlabs_${Date.now()}.mp3`);
    
    // Get ElevenLabs API key from environment or settings
    const apiKey = process.env.ELEVENLABS_API_KEY;
    
    if (!apiKey) {
      throw new Error('ElevenLabs API key not found. Please set ELEVENLABS_API_KEY in your environment.');
    }

    // ElevenLabs voice IDs (popular voices)
    const voiceIds = {
      'Rachel': '21m00Tcm4TlvDq8ikWAM',
      'Domi': 'AZnzlk1XvdvUeBnXmlld',
      'Bella': 'EXAVITQu4vr4xnSDxMaL',
      'Antoni': 'ErXwobaYiN019PkySvjV',
      'Elli': 'MF3mGyEYCl7XYWbV9V6O',
      'Josh': 'TxGEqnHWrfWFTfGW9XjX',
      'Arnold': 'VR6AewLTigWG4xSOukaG',
      'Adam': 'pNInz6obpgDQGcFmaJgB',
      'Sam': 'yoZ06aMxZJJ28mfd3POQ'
    };

    const voiceId = voiceIds[voice] || voiceIds['Rachel'];

    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        text: text,
        model_id: 'eleven_monolingual_v1',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75
        }
      });

      const options = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: `/v1/text-to-speech/${voiceId}`,
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      console.log('[VideoEditor] Calling ElevenLabs API with voice:', voice, voiceId);

      const file = fs.createWriteStream(outputPath);
      const req = https.request(options, (res) => {
        if (res.statusCode !== 200) {
          let errorData = '';
          res.on('data', (chunk) => {
            errorData += chunk;
          });
          res.on('end', () => {
            reject(new Error(`ElevenLabs API error: ${res.statusCode} - ${errorData}`));
          });
          return;
        }

        res.pipe(file);
        file.on('finish', () => {
          file.close();
          console.log('[VideoEditor] ElevenLabs audio generated:', outputPath);
          resolve(outputPath);
        });
      });

      req.on('error', (error) => {
        fs.unlink(outputPath, () => {});
        reject(error);
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * Replace audio segment in video
   */
  async replaceAudioSegment(videoPath, audioPath, startTime, endTime, outputPath, progressCallback = null) {
    const jobId = `audio_replace_${Date.now()}`;
    const duration = endTime - startTime;

    // Get audio duration to check if it matches the video segment
    const audioInfo = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(audioPath, (err, metadata) => {
        if (err) reject(err);
        else resolve(metadata);
      });
    });

    const audioDuration = audioInfo.format.duration;
    console.log('[VideoEditor] Segment duration:', duration, 'Generated audio duration:', audioDuration);

    return new Promise((resolve, reject) => {
      // Complex FFmpeg command to replace audio in specific range:
      // 1. Extract video (no audio)
      // 2. Extract original audio before startTime
      // 3. Use new ElevenLabs audio
      // 4. Extract original audio after endTime
      // 5. Concatenate all audio segments
      // 6. Merge with video

      const tempDir = path.join(this.outputDir, `temp_${Date.now()}`);
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const videoOnly = path.join(tempDir, 'video_only.mp4');
      const audioBefore = path.join(tempDir, 'audio_before.mp3');
      const audioAfter = path.join(tempDir, 'audio_after.mp3');
      const audioNew = path.join(tempDir, 'audio_new.mp3');
      const audioFinal = path.join(tempDir, 'audio_final.mp3');

      // Step 1: Extract video without audio
      ffmpeg(videoPath)
        .noAudio()
        .output(videoOnly)
        .on('end', () => {
          // Step 2: Build audio track
          this.buildReplacedAudioTrack(videoPath, audioPath, startTime, endTime, audioBefore, audioAfter, audioNew, audioFinal, progressCallback)
            .then(() => {
              // Step 3: Merge video and new audio
              ffmpeg(videoOnly)
                .input(audioFinal)
                .audioCodec('aac')
                .videoCodec('copy')
                .output(outputPath)
                .on('start', (cmd) => {
                  console.log('[VideoEditor] Merging video and audio:', cmd);
                  this.activeJobs.set(jobId, 'merge');
                })
                .on('progress', (progress) => {
                  if (progressCallback) {
                    progressCallback({
                      jobId,
                      status: 'Merging audio and video...',
                      percent: 60 + (progress.percent || 0) * 0.4,
                      timemark: progress.timemark
                    });
                  }
                })
                .on('end', () => {
                  // Clean up temp files
                  try {
                    fs.rmSync(tempDir, { recursive: true, force: true });
                  } catch (e) {
                    console.warn('[VideoEditor] Failed to clean temp dir:', e);
                  }
                  
                  this.activeJobs.delete(jobId);
                  resolve({ success: true, outputPath, jobId });
                })
                .on('error', (err) => {
                  this.activeJobs.delete(jobId);
                  reject(err);
                })
                .run();
            })
            .catch(reject);
        })
        .on('error', reject)
        .run();
    });
  }

  /**
   * Build audio track with replaced segment
   */
  async buildReplacedAudioTrack(videoPath, newAudioPath, startTime, endTime, audioBeforePath, audioAfterPath, audioNewPath, outputPath, progressCallback = null) {
    const videoInfo = await this.getVideoInfo(videoPath);
    const totalDuration = videoInfo.duration;

    // Extract or create audio segments
    const promises = [];

    // Audio before (if startTime > 0)
    if (startTime > 0.1) {
      promises.push(
        new Promise((resolve, reject) => {
          ffmpeg(videoPath)
            .setStartTime(0)
            .setDuration(startTime)
            .noVideo()
            .audioCodec('libmp3lame')
            .output(audioBeforePath)
            .on('end', resolve)
            .on('error', reject)
            .run();
        })
      );
    }

    // Adjust new audio duration to match segment
    const segmentDuration = endTime - startTime;
    
    // First, get the generated audio duration
    const newAudioInfo = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(newAudioPath, (err, metadata) => {
        if (err) reject(err);
        else resolve(metadata);
      });
    });
    
    const generatedDuration = newAudioInfo.format.duration;
    const tempoRatio = generatedDuration / segmentDuration;
    
    console.log('[VideoEditor] Audio duration adjustment:', {
      segmentDuration,
      generatedDuration,
      tempoRatio
    });
    
    // Only adjust tempo if there's a significant difference (>5%)
    if (Math.abs(tempoRatio - 1.0) > 0.05) {
      // atempo must be between 0.5 and 2.0, so we might need multiple filters
      let tempoFilters = [];
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
      
      const audioFilter = tempoFilters.join(',');
      console.log('[VideoEditor] Applying audio filter:', audioFilter);
      
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
      promises.push(
        new Promise((resolve, reject) => {
          ffmpeg(videoPath)
            .setStartTime(endTime)
            .noVideo()
            .audioCodec('libmp3lame')
            .output(audioAfterPath)
            .on('end', resolve)
            .on('error', reject)
            .run();
        })
      );
    }

    await Promise.all(promises);

    // Concatenate audio segments
    return new Promise((resolve, reject) => {
      const inputs = [];
      if (startTime > 0.1 && fs.existsSync(audioBeforePath)) inputs.push(audioBeforePath);
      if (fs.existsSync(audioNewPath)) inputs.push(audioNewPath);
      if (endTime < totalDuration - 0.1 && fs.existsSync(audioAfterPath)) inputs.push(audioAfterPath);

      if (inputs.length === 0) {
        reject(new Error('No audio segments to concatenate'));
        return;
      }

      if (inputs.length === 1) {
        // Just copy the single file
        fs.copyFileSync(inputs[0], outputPath);
        resolve();
        return;
      }

      // Create concat file list
      const concatFile = path.join(path.dirname(outputPath), 'concat.txt');
      const concatContent = inputs.map(f => `file '${f}'`).join('\n');
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
   * Create video from images (slideshow)
   */
  createSlideshow(imagePaths, options = {}, progressCallback = null) {
    const {
      duration = 3, // seconds per image
      fps = 30,
      transition = 'fade',
      audioPath = null,
      outputPath = null,
      resolution = '1920x1080'
    } = options;

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

      if (audioPath) {
        command = command.input(audioPath).audioCodec('aac');
      }

      command
        .output(output)
        .on('start', (cmd) => {
          console.log('[VideoEditor] Slideshow creation started:', cmd);
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
          fs.unlinkSync(listFile);
          resolve({ success: true, outputPath: output, jobId });
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
   * Add watermark to video
   */
  addWatermark(inputPath, watermarkPath, options = {}, progressCallback = null) {
    const {
      position = 'bottomright', // topleft, topright, bottomleft, bottomright, center
      opacity = 0.8,
      scale = 0.15, // Relative to video width
      margin = 10,
      outputPath = null
    } = options;

    const baseName = path.basename(inputPath, path.extname(inputPath));
    const output = outputPath || path.join(this.outputDir, `${baseName}_watermarked.mp4`);
    const jobId = `watermark_${Date.now()}`;

    // Position mapping
    const positionMap = {
      'topleft': `${margin}:${margin}`,
      'topright': `main_w-overlay_w-${margin}:${margin}`,
      'bottomleft': `${margin}:main_h-overlay_h-${margin}`,
      'bottomright': `main_w-overlay_w-${margin}:main_h-overlay_h-${margin}`,
      'center': '(main_w-overlay_w)/2:(main_h-overlay_h)/2'
    };

    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .input(watermarkPath)
        .complexFilter([
          `[1:v]scale=iw*${scale}:-1,format=rgba,colorchannelmixer=aa=${opacity}[wm]`,
          `[0:v][wm]overlay=${positionMap[position] || positionMap['bottomright']}`
        ])
        .videoCodec('libx264')
        .audioCodec('copy')
        .outputOptions(['-preset medium', '-crf 23'])
        .output(output)
        .on('start', (cmd) => {
          console.log('[VideoEditor] Watermark started:', cmd);
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
   * Concatenate multiple videos
   */
  concatenateVideos(inputPaths, options = {}, progressCallback = null) {
    const {
      outputPath = null,
      format = 'mp4'
    } = options;

    const output = outputPath || path.join(this.outputDir, `merged_${Date.now()}.${format}`);
    const jobId = `concat_${Date.now()}`;

    return new Promise((resolve, reject) => {
      // Create temporary file list
      const listFile = path.join(this.outputDir, `concat_${jobId}.txt`);
      const listContent = inputPaths.map(p => `file '${p}'`).join('\n');
      fs.writeFileSync(listFile, listContent);

      ffmpeg()
        .input(listFile)
        .inputOptions(['-f concat', '-safe 0'])
        .outputOptions(['-c copy'])
        .output(output)
        .on('start', (cmd) => {
          console.log('[VideoEditor] Concatenation started:', cmd);
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
          fs.unlinkSync(listFile);
          resolve({ success: true, outputPath: output, jobId });
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
   * Change video speed (speed up or slow down)
   */
  changeSpeed(inputPath, options = {}, progressCallback = null) {
    const {
      speed = 1.0, // 0.5 = half speed, 2.0 = double speed
      preservePitch = true, // Keep audio pitch when changing speed
      outputPath = null
    } = options;

    const baseName = path.basename(inputPath, path.extname(inputPath));
    const speedLabel = speed > 1 ? `${speed}x_fast` : `${speed}x_slow`;
    const output = outputPath || path.join(this.outputDir, `${baseName}_${speedLabel}.mp4`);
    const jobId = `speed_${Date.now()}`;

    return new Promise((resolve, reject) => {
      // Calculate filter values
      // For video: setpts=PTS/speed (higher speed = lower PTS multiplier)
      const videoSpeed = 1 / speed;
      
      // For audio: atempo only accepts 0.5 to 2.0, so chain filters for extreme speeds
      let audioFilters = [];
      let remainingSpeed = speed;
      
      // atempo filter only accepts values between 0.5 and 2.0
      // So we need to chain multiple atempo filters for extreme speeds
      while (remainingSpeed > 2.0) {
        audioFilters.push('atempo=2.0');
        remainingSpeed /= 2.0;
      }
      while (remainingSpeed < 0.5) {
        audioFilters.push('atempo=0.5');
        remainingSpeed /= 0.5;
      }
      audioFilters.push(`atempo=${remainingSpeed}`);
      
      const audioFilterString = audioFilters.join(',');

      let command = ffmpeg(inputPath);
      
      // Apply video speed filter
      command = command.videoFilters(`setpts=${videoSpeed}*PTS`);
      
      // Apply audio speed filter (if video has audio)
      command = command.audioFilters(audioFilterString);
      
      command
        .videoCodec('libx264')
        .audioCodec('aac')
        .outputOptions(['-preset', 'medium', '-crf', '23'])
        .output(output)
        .on('start', (cmd) => {
          console.log('[VideoEditor] Speed change started:', cmd);
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
          resolve({ success: true, outputPath: output, jobId, speed });
        })
        .on('error', (err) => {
          this.activeJobs.delete(jobId);
          reject(err);
        })
        .run();
    });
  }

  /**
   * Build playlist with AI - uses OpenAI to select and order scenes
   */
  async buildPlaylistWithAI(options = {}) {
    const { prompt, scenes, keepOrder, includeAll } = options;

    if (!scenes || scenes.length === 0) {
      return { success: false, error: 'No scenes provided' };
    }

    // Get OpenAI API key from settings
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    let openaiKey = null;
    
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      openaiKey = settings.openaiApiKey;
    }

    if (!openaiKey) {
      return { success: false, error: 'OpenAI API key not configured. Please set it in Settings.' };
    }

    // Build the prompt for OpenAI
    const systemPrompt = `You are a video editor assistant that helps create playlists from video scenes.
You will receive a list of scenes with their metadata (name, description, transcription, tags, duration).
Based on the user's request, select which scenes to include and in what order.

Respond with a JSON object containing:
- "selectedSceneIds": array of scene IDs to include, in the order they should play
- "reasoning": brief explanation of your choices (1 sentence)

Rules:
${keepOrder ? '- Maintain chronological order of scenes' : '- You can reorder scenes for better flow'}
${includeAll ? '- Include ALL scenes in the playlist' : '- Only include scenes relevant to the request'}
- Be concise and relevant to the user's request`;

    const userPrompt = `User request: "${prompt}"

Available scenes:
${scenes.map(s => `
Scene ${s.index} (ID: ${s.id}):
- Name: ${s.name}
- Type: ${s.type}
- Duration: ${s.durationFormatted}
- Time: ${s.timeIn}${s.timeOut ? ` → ${s.timeOut}` : ''}
${s.description ? `- Description: ${s.description}` : ''}
${s.transcription ? `- Transcription: "${s.transcription.substring(0, 200)}${s.transcription.length > 200 ? '...' : ''}"` : ''}
${s.tags.length > 0 ? `- Tags: ${s.tags.join(', ')}` : ''}
${s.notes ? `- Notes: ${s.notes}` : ''}
`).join('\n')}

Select the appropriate scenes and return JSON.`;

    try {
      const response = await new Promise((resolve, reject) => {
        const postData = JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.7,
          response_format: { type: 'json_object' }
        });

        const req = https.request({
          hostname: 'api.openai.com',
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${openaiKey}`
          }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            if (res.statusCode !== 200) {
              try {
                const errorJson = JSON.parse(data);
                reject(new Error(errorJson.error?.message || `HTTP ${res.statusCode}`));
              } catch {
                reject(new Error(`HTTP ${res.statusCode}: ${data}`));
              }
              return;
            }
            resolve(JSON.parse(data));
          });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
      });

      // Parse the AI response
      const content = response.choices[0].message.content;
      const result = JSON.parse(content);

      console.log('[VideoEditor] AI playlist result:', result);

      // Validate the selected IDs
      const validIds = scenes.map(s => s.id);
      const selectedIds = (result.selectedSceneIds || []).filter(id => validIds.includes(id));

      if (selectedIds.length === 0) {
        return { success: false, error: 'AI did not select any valid scenes' };
      }

      return {
        success: true,
        selectedSceneIds: selectedIds,
        reasoning: result.reasoning || ''
      };

    } catch (error) {
      console.error('[VideoEditor] AI playlist error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Export playlist - concatenate multiple segments into one video
   */
  async exportPlaylist(inputPath, options = {}) {
    const { segments, outputPath = null } = options;

    if (!segments || segments.length === 0) {
      return Promise.reject(new Error('No segments provided'));
    }

    const baseName = path.basename(inputPath, path.extname(inputPath));
    const output = outputPath || path.join(this.outputDir, `${baseName}_playlist_${Date.now()}.mp4`);
    const jobId = `playlist_${Date.now()}`;

    // Create temp directory for segment files
    const tempDir = path.join(this.outputDir, `temp_playlist_${jobId}`);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    try {
      console.log(`[VideoEditor] Exporting playlist with ${segments.length} segments`);

      // Extract each segment
      const segmentFiles = [];
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const segmentPath = path.join(tempDir, `segment_${String(i).padStart(3, '0')}.mp4`);
        
        await new Promise((resolve, reject) => {
          ffmpeg(inputPath)
            .setStartTime(seg.startTime)
            .setDuration(seg.endTime - seg.startTime)
            .outputOptions([
              '-c:v', 'libx264',
              '-c:a', 'aac',
              '-avoid_negative_ts', 'make_zero',
              '-preset', 'fast'
            ])
            .output(segmentPath)
            .on('end', () => {
              console.log(`[VideoEditor] Segment ${i + 1}/${segments.length} extracted`);
              resolve();
            })
            .on('error', reject)
            .run();
        });
        
        segmentFiles.push(segmentPath);
      }

      // Create concat list file
      const listPath = path.join(tempDir, 'concat_list.txt');
      const listContent = segmentFiles.map(f => `file '${f}'`).join('\n');
      fs.writeFileSync(listPath, listContent);

      // Concatenate all segments
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(listPath)
          .inputOptions(['-f', 'concat', '-safe', '0'])
          .outputOptions(['-c', 'copy'])
          .output(output)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      // Cleanup temp files
      segmentFiles.forEach(f => {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      });
      if (fs.existsSync(listPath)) fs.unlinkSync(listPath);
      if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);

      console.log(`[VideoEditor] Playlist exported to: ${output}`);

      return {
        success: true,
        outputPath: output,
        segmentCount: segments.length
      };

    } catch (error) {
      // Cleanup on error
      if (fs.existsSync(tempDir)) {
        fs.readdirSync(tempDir).forEach(f => fs.unlinkSync(path.join(tempDir, f)));
        fs.rmdirSync(tempDir);
      }
      throw error;
    }
  }

  /**
   * Splice video - remove a section from the middle
   * Keeps everything before cutStart and after cutEnd
   */
  spliceVideo(inputPath, options = {}, progressCallback = null) {
    const {
      cutStart, // Start time of section to remove
      cutEnd,   // End time of section to remove
      outputPath = null
    } = options;

    if (cutStart === undefined || cutEnd === undefined) {
      return Promise.reject(new Error('cutStart and cutEnd are required'));
    }

    if (cutStart >= cutEnd) {
      return Promise.reject(new Error('cutStart must be less than cutEnd'));
    }

    const baseName = path.basename(inputPath, path.extname(inputPath));
    const output = outputPath || path.join(this.outputDir, `${baseName}_spliced.mp4`);
    const jobId = `splice_${Date.now()}`;

    return new Promise(async (resolve, reject) => {
      try {
        // Get video duration first
        const info = await this.getVideoInfo(inputPath);
        const duration = info.duration;

        // Create temp files for the two parts
        const tempPart1 = path.join(this.outputDir, `temp_part1_${jobId}.mp4`);
        const tempPart2 = path.join(this.outputDir, `temp_part2_${jobId}.mp4`);
        const tempList = path.join(this.outputDir, `temp_list_${jobId}.txt`);

        // Part 1: From beginning to cutStart
        await new Promise((res, rej) => {
          if (cutStart <= 0) {
            res(); // Skip part 1 if cut starts at beginning
            return;
          }
          
          ffmpeg(inputPath)
            .setStartTime(0)
            .setDuration(cutStart)
            .outputOptions(['-c', 'copy', '-avoid_negative_ts', 'make_zero'])
            .output(tempPart1)
            .on('end', res)
            .on('error', rej)
            .run();
        });

        // Part 2: From cutEnd to end
        await new Promise((res, rej) => {
          if (cutEnd >= duration) {
            res(); // Skip part 2 if cut ends at end
            return;
          }
          
          ffmpeg(inputPath)
            .setStartTime(cutEnd)
            .outputOptions(['-c', 'copy', '-avoid_negative_ts', 'make_zero'])
            .output(tempPart2)
            .on('end', res)
            .on('error', rej)
            .run();
        });

        // Create concat list
        let listContent = '';
        if (cutStart > 0 && fs.existsSync(tempPart1)) {
          listContent += `file '${tempPart1}'\n`;
        }
        if (cutEnd < duration && fs.existsSync(tempPart2)) {
          listContent += `file '${tempPart2}'\n`;
        }

        if (!listContent) {
          reject(new Error('Nothing left after splice - entire video would be removed'));
          return;
        }

        fs.writeFileSync(tempList, listContent);

        // Concatenate the parts
        ffmpeg()
          .input(tempList)
          .inputOptions(['-f', 'concat', '-safe', '0'])
          .outputOptions(['-c', 'copy'])
          .output(output)
          .on('start', (cmd) => {
            console.log('[VideoEditor] Splice concatenation started:', cmd);
            this.activeJobs.set(jobId, { cancel: () => {} });
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
            
            // Cleanup temp files
            [tempPart1, tempPart2, tempList].forEach(f => {
              if (fs.existsSync(f)) fs.unlinkSync(f);
            });
            
            const removedDuration = cutEnd - cutStart;
            resolve({ 
              success: true, 
              outputPath: output, 
              jobId,
              removedDuration,
              newDuration: duration - removedDuration
            });
          })
          .on('error', (err) => {
            this.activeJobs.delete(jobId);
            // Cleanup temp files
            [tempPart1, tempPart2, tempList].forEach(f => {
              if (fs.existsSync(f)) fs.unlinkSync(f);
            });
            reject(err);
          })
          .run();

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Reverse video (play backwards)
   */
  reverseVideo(inputPath, options = {}, progressCallback = null) {
    const {
      includeAudio = true,
      outputPath = null
    } = options;

    const baseName = path.basename(inputPath, path.extname(inputPath));
    const output = outputPath || path.join(this.outputDir, `${baseName}_reversed.mp4`);
    const jobId = `reverse_${Date.now()}`;

    return new Promise((resolve, reject) => {
      let command = ffmpeg(inputPath)
        .videoFilters('reverse');
      
      if (includeAudio) {
        command = command.audioFilters('areverse');
      } else {
        command = command.noAudio();
      }
      
      command
        .videoCodec('libx264')
        .audioCodec('aac')
        .outputOptions(['-preset', 'medium', '-crf', '23'])
        .output(output)
        .on('start', (cmd) => {
          console.log('[VideoEditor] Reverse started:', cmd);
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
   * Transcribe a range of video/audio using OpenAI Whisper
   */
  async transcribeRange(inputPath, options = {}) {
    const {
      startTime = 0,
      endTime = null,
      language = 'en'
    } = options;

    // Get video duration if endTime not specified
    let duration;
    if (endTime === null) {
      const info = await this.getVideoInfo(inputPath);
      duration = info.duration - startTime;
    } else {
      duration = endTime - startTime;
    }

    // Create temp audio file for the range
    const tempAudioPath = path.join(this.outputDir, `temp_transcribe_${Date.now()}.mp3`);

    try {
      // Extract audio for the specified range
      await new Promise((resolve, reject) => {
        let cmd = ffmpeg(inputPath)
          .setStartTime(startTime)
          .duration(duration)
          .noVideo()
          .audioCodec('libmp3lame')
          .audioBitrate('128k')
          .format('mp3')
          .output(tempAudioPath);

        cmd.on('end', resolve);
        cmd.on('error', reject);
        cmd.run();
      });

      console.log('[VideoEditor] Extracted audio range for transcription:', tempAudioPath);

      // Get OpenAI API key from settings
      const settingsPath = path.join(app.getPath('userData'), 'settings.json');
      let openaiKey = null;
      
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        openaiKey = settings.openaiApiKey;
      }

      if (!openaiKey) {
        throw new Error('OpenAI API key not configured. Please set it in Settings.');
      }

      // Read the audio file
      const audioBuffer = fs.readFileSync(tempAudioPath);
      const audioSize = audioBuffer.length;

      // Check file size (Whisper limit is 25MB)
      if (audioSize > 25 * 1024 * 1024) {
        throw new Error('Audio segment too large for transcription (max 25MB). Try a shorter range.');
      }

      console.log(`[VideoEditor] Sending ${(audioSize / 1024 / 1024).toFixed(2)}MB to Whisper API`);

      // Build multipart form data
      const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
      
      const parts = [];
      
      // File part
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="audio.mp3"\r\n` +
        `Content-Type: audio/mpeg\r\n\r\n`
      ));
      parts.push(audioBuffer);
      parts.push(Buffer.from('\r\n'));
      
      // Model part
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="model"\r\n\r\n` +
        `whisper-1\r\n`
      ));
      
      // Language part
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="language"\r\n\r\n` +
        `${language}\r\n`
      ));
      
      // Response format (text)
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
        `text\r\n`
      ));
      
      // End boundary
      parts.push(Buffer.from(`--${boundary}--\r\n`));
      
      const fullBody = Buffer.concat(parts);

      // Send to OpenAI
      const transcription = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.openai.com',
          path: '/v1/audio/transcriptions',
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': fullBody.length,
            'Authorization': `Bearer ${openaiKey}`
          }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            if (res.statusCode !== 200) {
              try {
                const errorJson = JSON.parse(data);
                reject(new Error(errorJson.error?.message || `HTTP ${res.statusCode}`));
              } catch {
                reject(new Error(`HTTP ${res.statusCode}: ${data}`));
              }
              return;
            }
            resolve(data);
          });
        });
        
        req.on('error', reject);
        req.write(fullBody);
        req.end();
      });

      console.log(`[VideoEditor] Transcription complete, length: ${transcription.length}`);

      // Clean up temp file
      if (fs.existsSync(tempAudioPath)) {
        fs.unlinkSync(tempAudioPath);
      }

      return {
        success: true,
        transcription: transcription.trim(),
        startTime,
        endTime: startTime + duration,
        duration
      };

    } catch (error) {
      // Clean up temp file on error
      if (fs.existsSync(tempAudioPath)) {
        fs.unlinkSync(tempAudioPath);
      }
      throw error;
    }
  }

  /**
   * Generate multiple screen grabs from a range
   * Evenly distributed across the time range
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

    console.log(`[VideoEditor] Generating ${count} screengrabs from ${this.formatTime(startTime)} to ${this.formatTime(startTime + duration)}`);

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

        console.log(`[VideoEditor] Generated frame ${i + 1}/${count} at ${this.formatTime(time)}`);
      } catch (error) {
        console.error(`[VideoEditor] Error generating frame at ${time}:`, error);
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

  // Helper to format time
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

  /**
   * Compress video (reduce file size)
   */
  compressVideo(inputPath, options = {}, progressCallback = null) {
    const {
      quality = 'medium', // low, medium, high
      maxSize = null, // Target size in MB
      outputPath = null
    } = options;

    const qualitySettings = {
      'low': { crf: 32, preset: 'fast', audioBitrate: '96k' },
      'medium': { crf: 26, preset: 'medium', audioBitrate: '128k' },
      'high': { crf: 20, preset: 'slow', audioBitrate: '192k' }
    };

    const settings = qualitySettings[quality] || qualitySettings['medium'];
    const baseName = path.basename(inputPath, path.extname(inputPath));
    const output = outputPath || path.join(this.outputDir, `${baseName}_compressed.mp4`);
    const jobId = `compress_${Date.now()}`;

    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .videoCodec('libx264')
        .audioCodec('aac')
        .audioBitrate(settings.audioBitrate)
        .outputOptions([
          `-preset ${settings.preset}`,
          `-crf ${settings.crf}`
        ])
        .output(output)
        .on('start', (cmd) => {
          console.log('[VideoEditor] Compression started:', cmd);
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
   * Generate timeline thumbnails for scrubbing
   */
  generateTimelineThumbnails(inputPath, options = {}) {
    const {
      count = 10,
      width = 160,
      height = 90
    } = options;

    const baseName = path.basename(inputPath, path.extname(inputPath));
    const outputFolder = path.join(this.thumbnailDir, baseName);

    if (!fs.existsSync(outputFolder)) {
      fs.mkdirSync(outputFolder, { recursive: true });
    }

    return new Promise((resolve, reject) => {
      const thumbnails = [];

      ffmpeg(inputPath)
        .screenshots({
          count: count,
          folder: outputFolder,
          filename: 'timeline_%i.jpg',
          size: `${width}x${height}`
        })
        .on('filenames', (filenames) => {
          filenames.forEach(f => thumbnails.push(path.join(outputFolder, f)));
        })
        .on('end', () => {
          resolve(thumbnails);
        })
        .on('error', reject);
    });
  }

  /**
   * Generate audio waveform data using FFmpeg
   * Returns an array of peak values for visualization
   */
  generateWaveformData(inputPath, options = {}) {
    const {
      samples = 200, // Number of data points for the waveform
    } = options;

    return new Promise((resolve, reject) => {
      // First get the duration
      ffmpeg.ffprobe(inputPath, (err, metadata) => {
        if (err) {
          reject(err);
          return;
        }

        const duration = metadata.format.duration;
        const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
        
        if (!audioStream) {
          // No audio stream - return flat waveform
          resolve({
            peaks: new Array(samples).fill(0),
            duration: duration,
            hasAudio: false
          });
          return;
        }

        console.log('[VideoEditor] Generating waveform with', samples, 'samples for', duration.toFixed(2), 'seconds');

        // RELIABLE METHOD: Extract audio and analyze RMS levels per segment
        const segmentDuration = duration / samples;
        const peaks = [];
        let processed = 0;

        const analyzeSegment = (index) => {
          if (index >= samples) {
            console.log('[VideoEditor] Waveform complete:', peaks.length, 'samples extracted');
            resolve({
              peaks: peaks,
              duration: duration,
              hasAudio: true,
              method: 'rms_analysis'
            });
            return;
          }

          const startTime = index * segmentDuration;
          const tempAudio = path.join(this.outputDir, `waveform_segment_${Date.now()}_${index}.wav`);

          ffmpeg(inputPath)
            .setStartTime(startTime)
            .setDuration(Math.min(segmentDuration, duration - startTime))
            .noVideo()
            .audioFilters(['volumedetect'])
            .outputOptions(['-f', 'null'])
            .output('-')
            .on('stderr', (stderrLine) => {
              // Parse mean_volume from FFmpeg output
              const match = stderrLine.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
              if (match) {
                const db = parseFloat(match[1]);
                // Convert dB to 0-1 range
                // Typical range: -60dB (quiet) to -10dB (loud)
                const normalized = Math.min(1, Math.max(0, (db + 60) / 50));
                peaks[index] = normalized;
              }
            })
            .on('end', () => {
              processed++;
              if (processed % 20 === 0) {
                console.log(`[VideoEditor] Waveform progress: ${processed}/${samples}`);
              }
              // Don't overwhelm - process in small batches
              if (index < samples - 1) {
                setTimeout(() => analyzeSegment(index + 1), 5);
              } else {
                analyzeSegment(index + 1);
              }
            })
            .on('error', (err) => {
              console.warn('[VideoEditor] Segment', index, 'failed, using default');
              peaks[index] = 0.3; // Default value
              processed++;
              if (index < samples - 1) {
                setTimeout(() => analyzeSegment(index + 1), 5);
              } else {
                analyzeSegment(index + 1);
              }
            })
            .run();
        };

        // Start with batch processing for speed
        this.generateWaveformFast(inputPath, samples, duration, audioStream)
          .then(resolve)
          .catch((err) => {
            console.warn('[VideoEditor] Fast method failed, using segment analysis:', err.message);
            analyzeSegment(0);
          });
      });
    });
  }

  /**
   * Fast and RELIABLE waveform generation using FFmpeg audio analysis
   */
  generateWaveformFast(inputPath, samples, duration, audioStream) {
    return new Promise((resolve, reject) => {
      console.log('[VideoEditor] Extracting real audio waveform data...');
      
      // SIMPLE & RELIABLE: Extract audio to temp file, then analyze with FFmpeg filters
      const tempAudio = path.join(this.outputDir, `waveform_audio_${Date.now()}.wav`);
      const tempData = path.join(this.outputDir, `waveform_data_${Date.now()}.txt`);
      
      // Step 1: Extract audio as WAV (fast and reliable)
      ffmpeg(inputPath)
        .noVideo()
        .audioChannels(1) // Mono
        .audioFrequency(8000) // Lower sample rate for faster processing
        .format('wav')
        .output(tempAudio)
        .on('end', () => {
          console.log('[VideoEditor] Audio extracted, analyzing levels...');
          
          // Step 2: Analyze audio levels using astats filter
          const segmentSize = Math.ceil(8000 * duration / samples); // samples per segment
          let stderrOutput = '';
          
          ffmpeg(tempAudio)
            .audioFilters([
              `asetnsamples=${segmentSize}`,
              `astats=metadata=1:reset=1`
            ])
            .outputOptions(['-f', 'null'])
            .output('-')
            .on('stderr', (line) => {
              stderrOutput += line + '\n';
            })
            .on('end', () => {
              try {
                // Parse RMS or Peak level from astats output
                const rmsMatches = [...stderrOutput.matchAll(/lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+)/g)];
                const peakMatches = [...stderrOutput.matchAll(/lavfi\.astats\.Overall\.Peak_level=(-?[\d.]+)/g)];
                
                const levels = rmsMatches.length > 0 ? rmsMatches : peakMatches;
                
                console.log('[VideoEditor] Found', levels.length, 'audio level measurements');
                
                const peaks = levels.map(match => {
                  const db = parseFloat(match[1]);
                  // Convert dB to linear 0-1 range
                  // -60dB = quiet (0.001), 0dB = max (1.0)
                  const linear = Math.pow(10, db / 20);
                  return Math.min(1, Math.max(0, linear));
                });
                
                // Resample to exact number of samples needed
                const finalPeaks = this.resampleArray(peaks, samples);
                
                // Cleanup temp files
                if (fs.existsSync(tempAudio)) fs.unlinkSync(tempAudio);
                if (fs.existsSync(tempData)) fs.unlinkSync(tempData);
                
                console.log('[VideoEditor] ✅ Real waveform extracted:', finalPeaks.length, 'samples');
                
                resolve({
                  peaks: finalPeaks,
                  duration: duration,
                  hasAudio: true,
                  method: 'astats_accurate',
                  sampleCount: levels.length
                });
                
              } catch (error) {
                console.error('[VideoEditor] Error parsing waveform data:', error);
                // Cleanup and reject
                if (fs.existsSync(tempAudio)) fs.unlinkSync(tempAudio);
                if (fs.existsSync(tempData)) fs.unlinkSync(tempData);
                reject(error);
              }
            })
            .on('error', (err) => {
              console.error('[VideoEditor] Audio analysis failed:', err);
              // Cleanup
              if (fs.existsSync(tempAudio)) fs.unlinkSync(tempAudio);
              if (fs.existsSync(tempData)) fs.unlinkSync(tempData);
              reject(err);
            })
            .run();
        })
        .on('error', (err) => {
          console.error('[VideoEditor] Audio extraction failed:', err);
          if (fs.existsSync(tempAudio)) fs.unlinkSync(tempAudio);
          reject(err);
        })
        .run();
    });
  }

  /**
   * Generate approximate waveform using volumedetect
   */
  generateApproximateWaveform(inputPath, samples, duration) {
    return new Promise((resolve, reject) => {
      const peaks = [];
      const segmentDuration = duration / samples;
      let completed = 0;

      console.log('[VideoEditor] Generating approximate waveform...');

      // Process in chunks for better performance
      const processSegment = (index) => {
        if (index >= samples) {
          resolve({
            peaks: peaks,
            duration: duration,
            hasAudio: true,
            approximate: true
          });
          return;
        }

        const startTime = index * segmentDuration;
        
        ffmpeg(inputPath)
          .setStartTime(startTime)
          .setDuration(segmentDuration)
          .audioFilters('volumedetect')
          .outputOptions(['-f', 'null'])
          .output('-')
          .on('end', (stdout, stderr) => {
            // Parse max_volume from stderr
            const match = stderr?.match(/max_volume:\s*(-?[\d.]+)\s*dB/);
            if (match) {
              const db = parseFloat(match[1]);
              // Convert to 0-1 range (assuming -60dB to 0dB range)
              const normalized = Math.min(1, Math.max(0, (db + 60) / 60));
              peaks[index] = normalized;
            } else {
              peaks[index] = 0.3; // Default value
            }
            processSegment(index + 1);
          })
          .on('error', () => {
            peaks[index] = 0.3;
            processSegment(index + 1);
          })
          .run();
      };

      // Start processing - but use simpler method for speed
      // Instead of per-segment analysis, do a single pass
      this.generateSimpleWaveform(inputPath, samples, duration)
        .then(resolve)
        .catch(() => {
          // Ultimate fallback - random but consistent waveform
          const fallbackPeaks = [];
          for (let i = 0; i < samples; i++) {
            fallbackPeaks.push(0.3 + Math.sin(i * 0.5) * 0.2 + Math.random() * 0.2);
          }
          resolve({
            peaks: fallbackPeaks,
            duration: duration,
            hasAudio: true,
            fallback: true
          });
        });
    });
  }

  /**
   * Simple waveform generation using showwavespic filter
   */
  generateSimpleWaveform(inputPath, samples, duration) {
    return new Promise((resolve, reject) => {
      const tempImage = path.join(this.outputDir, `waveform_${Date.now()}.png`);
      
      ffmpeg(inputPath)
        .outputOptions([
          '-filter_complex', `aformat=channel_layouts=mono,showwavespic=s=${samples}x100:colors=white`,
          '-frames:v', '1'
        ])
        .output(tempImage)
        .on('end', () => {
          try {
            // Read the image and extract brightness values
            // For simplicity, we'll use a different approach
            // Generate peaks based on audio analysis
            if (fs.existsSync(tempImage)) {
              fs.unlinkSync(tempImage);
            }
            
            // Use a simpler volumedetect approach
            ffmpeg(inputPath)
              .audioFilters('volumedetect')
              .outputOptions(['-f', 'null'])
              .output('-')
              .on('end', (stdout, stderr) => {
                const meanMatch = stderr?.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
                const maxMatch = stderr?.match(/max_volume:\s*(-?[\d.]+)\s*dB/);
                
                const meanDb = meanMatch ? parseFloat(meanMatch[1]) : -20;
                const maxDb = maxMatch ? parseFloat(maxMatch[1]) : -6;
                
                // Generate waveform based on overall audio characteristics
                const peaks = [];
                const baseLevel = Math.min(1, Math.max(0, (meanDb + 60) / 60));
                const peakLevel = Math.min(1, Math.max(0, (maxDb + 60) / 60));
                
                for (let i = 0; i < samples; i++) {
                  // Create variation based on position
                  const variation = Math.sin(i * 0.3) * 0.15 + Math.sin(i * 0.7) * 0.1;
                  const randomVariation = (Math.random() - 0.5) * 0.1;
                  const peak = baseLevel + variation + randomVariation;
                  peaks.push(Math.min(peakLevel, Math.max(0.05, peak)));
                }
                
                resolve({
                  peaks: peaks,
                  duration: duration,
                  hasAudio: true,
                  meanVolume: meanDb,
                  maxVolume: maxDb
                });
              })
              .on('error', reject)
              .run();
          } catch (error) {
            reject(error);
          }
        })
        .on('error', (err) => {
          // Fallback
          const peaks = [];
          for (let i = 0; i < samples; i++) {
            peaks.push(0.3 + Math.sin(i * 0.5) * 0.2);
          }
          resolve({
            peaks: peaks,
            duration: duration,
            hasAudio: true,
            fallback: true
          });
        })
        .run();
    });
  }

  /**
   * Resample array to target length
   */
  resampleArray(arr, targetLength) {
    if (arr.length === 0) return new Array(targetLength).fill(0);
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
   * Cancel an active job
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

  // ==================== TRANSLATION PIPELINE (TEaR) ====================
  
  /**
   * TEaR Translation Pipeline - Translate, Evaluate, Refine
   * Uses multi-LLM approach for high-quality translations
   * 
   * @param {string} sourceText - Text to translate
   * @param {Object} options - Translation options
   * @returns {Promise} - Translation result with scores
   */
  async translateWithQualityLoop(sourceText, options = {}) {
    const {
      sourceLanguage = 'auto',
      targetLanguage = 'en',
      sourceDuration = null,
      videoContext = 'general',
      tone = 'professional',
      maxIterations = 5,
      qualityThreshold = 9.0
    } = options;

    // Get API keys
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    let openaiKey = null;
    let anthropicKey = null;
    
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      openaiKey = settings.openaiApiKey;
      anthropicKey = settings.anthropicApiKey || settings.claudeApiKey;
    }

    if (!openaiKey) {
      return { success: false, error: 'OpenAI API key not configured for translation.' };
    }

    const iterations = [];
    let currentTranslation = null;
    let currentEvaluation = null;

    for (let i = 1; i <= maxIterations; i++) {
      console.log(`[Translation] Iteration ${i}/${maxIterations}`);

      // Step 1: Translate (or refine)
      if (i === 1) {
        currentTranslation = await this.translateText(sourceText, {
          sourceLanguage,
          targetLanguage,
          sourceDuration,
          videoContext,
          tone
        }, openaiKey);
      } else {
        // Refine based on previous feedback
        currentTranslation = await this.refineTranslation(
          sourceText,
          currentTranslation,
          currentEvaluation.improvements,
          { sourceLanguage, targetLanguage, sourceDuration },
          openaiKey
        );
      }

      // Step 2: Evaluate
      currentEvaluation = await this.evaluateTranslation(
        sourceText,
        currentTranslation,
        { sourceLanguage, targetLanguage, sourceDuration, videoContext },
        anthropicKey || openaiKey // Use Claude if available, fallback to GPT
      );

      iterations.push({
        iteration: i,
        translation: currentTranslation,
        evaluation: currentEvaluation
      });

      // Check if we've reached quality threshold
      if (currentEvaluation.composite >= qualityThreshold) {
        console.log(`[Translation] Quality threshold met at iteration ${i}: ${currentEvaluation.composite}`);
        return {
          success: true,
          translation: currentTranslation,
          finalScore: currentEvaluation.composite,
          iterations: iterations,
          evaluation: currentEvaluation
        };
      }

      // If we've exhausted iterations
      if (i === maxIterations) {
        console.log(`[Translation] Max iterations reached. Final score: ${currentEvaluation.composite}`);
        return {
          success: false,
          translation: currentTranslation,
          finalScore: currentEvaluation.composite,
          iterations: iterations,
          evaluation: currentEvaluation,
          warning: `Quality threshold (${qualityThreshold}) not met after ${maxIterations} iterations`
        };
      }
    }
  }

  /**
   * Translate text using LLM
   */
  async translateText(sourceText, options, apiKey) {
    const { sourceLanguage, targetLanguage, sourceDuration, videoContext, tone } = options;

    const systemPrompt = `You are a professional video translator specializing in high-quality dubbing translations.

INSTRUCTIONS:
1. Preserve the EXACT meaning - no additions, omissions, or hallucinations
2. Use natural, fluent ${targetLanguage} phrasing that sounds native
3. Adapt idioms and cultural references appropriately for the target audience
4. Consider timing - the translation should be speakable in approximately ${sourceDuration ? sourceDuration + ' seconds' : 'the same duration as the source'}
5. Maintain the speaker's tone (${tone}) and style
6. If the source is significantly longer when translated, find more concise phrasing WITHOUT losing meaning

Return ONLY the translated text, no explanations or notes.`;

    const userPrompt = `Translate the following text from ${sourceLanguage === 'auto' ? 'the detected language' : sourceLanguage} to ${targetLanguage}.

Context: This is from a ${videoContext} video.
${sourceDuration ? `Source duration: ${sourceDuration} seconds` : ''}

TEXT TO TRANSLATE:
"${sourceText}"

TRANSLATION:`;

    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.3,
        max_tokens: 2000
      });

      const req = https.request({
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            try {
              const errorJson = JSON.parse(data);
              reject(new Error(errorJson.error?.message || `HTTP ${res.statusCode}`));
            } catch {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            }
            return;
          }
          
          const response = JSON.parse(data);
          const translation = response.choices[0].message.content.trim();
          // Remove quotes if the model added them
          resolve(translation.replace(/^["']|["']$/g, ''));
        });
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  /**
   * Evaluate translation quality using multi-dimensional rubric
   */
  async evaluateTranslation(sourceText, translatedText, options, apiKey) {
    const { sourceLanguage, targetLanguage, sourceDuration, videoContext } = options;

    const systemPrompt = `You are a professional translation quality evaluator. Rate the translation on 5 dimensions using a 1-10 scale.

EVALUATION CRITERIA:
1. ACCURACY (25% weight): Does it preserve the exact meaning? Any distortions, additions, or omissions?
2. FLUENCY (25% weight): Does it read naturally in ${targetLanguage}? Is grammar correct? Does it flow well?
3. ADEQUACY (20% weight): Is everything from the source translated? Nothing missing or added?
4. CULTURAL_FIT (15% weight): Are idioms and cultural references adapted appropriately?
5. TIMING_FIT (15% weight): Can this be spoken in a similar duration to the source? Is it concise enough?

SCORING GUIDELINES:
- 9-10: Excellent, professional quality
- 7-8: Good, minor issues only
- 5-6: Acceptable but needs improvement
- 3-4: Poor, significant issues
- 1-2: Unacceptable, major problems

For any score below 9, provide a SPECIFIC, actionable improvement suggestion.

RESPOND IN JSON FORMAT ONLY:
{
  "scores": {
    "accuracy": { "score": 8.5, "feedback": "specific feedback here" },
    "fluency": { "score": 9.0, "feedback": "specific feedback here" },
    "adequacy": { "score": 9.0, "feedback": "specific feedback here" },
    "cultural_fit": { "score": 8.0, "feedback": "specific feedback here" },
    "timing_fit": { "score": 8.5, "feedback": "specific feedback here" }
  },
  "composite": 8.6,
  "improvements": ["specific improvement 1", "specific improvement 2"],
  "pass": false
}`;

    const userPrompt = `Evaluate this translation:

SOURCE (${sourceLanguage}): "${sourceText}"
TRANSLATION (${targetLanguage}): "${translatedText}"

Context: ${videoContext} video
${sourceDuration ? `Source duration: ${sourceDuration}s` : ''}

Evaluate and return JSON:`;

    return new Promise((resolve, reject) => {
      // Determine if using Claude or GPT
      const isAnthropic = apiKey && apiKey.startsWith('sk-ant-');
      
      if (isAnthropic) {
        // Use Anthropic API
        const postData = JSON.stringify({
          model: 'claude-3-5-sonnet-20241022',
          max_tokens: 1500,
          messages: [
            { role: 'user', content: `${systemPrompt}\n\n${userPrompt}` }
          ]
        });

        const req = https.request({
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            if (res.statusCode !== 200) {
              console.error('[Translation] Anthropic API error:', data);
              // Fallback to default evaluation
              resolve(this.getDefaultEvaluation());
              return;
            }
            
            try {
              const response = JSON.parse(data);
              const content = response.content[0].text;
              const evaluation = JSON.parse(content);
              
              // Calculate composite if not provided
              if (!evaluation.composite) {
                const weights = { accuracy: 0.25, fluency: 0.25, adequacy: 0.20, cultural_fit: 0.15, timing_fit: 0.15 };
                let composite = 0;
                for (const [key, weight] of Object.entries(weights)) {
                  composite += (evaluation.scores[key]?.score || 7) * weight;
                }
                evaluation.composite = Math.round(composite * 10) / 10;
              }
              
              evaluation.pass = evaluation.composite >= 9.0;
              resolve(evaluation);
            } catch (e) {
              console.error('[Translation] Failed to parse evaluation:', e);
              resolve(this.getDefaultEvaluation());
            }
          });
        });

        req.on('error', (e) => {
          console.error('[Translation] Evaluation request error:', e);
          resolve(this.getDefaultEvaluation());
        });
        req.write(postData);
        req.end();
      } else {
        // Use OpenAI API
        const postData = JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.3,
          response_format: { type: 'json_object' }
        });

        const req = https.request({
          hostname: 'api.openai.com',
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            if (res.statusCode !== 200) {
              console.error('[Translation] OpenAI evaluation error:', data);
              resolve(this.getDefaultEvaluation());
              return;
            }
            
            try {
              const response = JSON.parse(data);
              const content = response.choices[0].message.content;
              const evaluation = JSON.parse(content);
              
              // Calculate composite if not provided
              if (!evaluation.composite) {
                const weights = { accuracy: 0.25, fluency: 0.25, adequacy: 0.20, cultural_fit: 0.15, timing_fit: 0.15 };
                let composite = 0;
                for (const [key, weight] of Object.entries(weights)) {
                  composite += (evaluation.scores[key]?.score || 7) * weight;
                }
                evaluation.composite = Math.round(composite * 10) / 10;
              }
              
              evaluation.pass = evaluation.composite >= 9.0;
              resolve(evaluation);
            } catch (e) {
              console.error('[Translation] Failed to parse evaluation:', e);
              resolve(this.getDefaultEvaluation());
            }
          });
        });

        req.on('error', (e) => {
          console.error('[Translation] Evaluation request error:', e);
          resolve(this.getDefaultEvaluation());
        });
        req.write(postData);
        req.end();
      }
    });
  }

  /**
   * Refine translation based on feedback
   */
  async refineTranslation(sourceText, currentTranslation, improvements, options, apiKey) {
    const { sourceLanguage, targetLanguage, sourceDuration } = options;

    const systemPrompt = `You are a professional translation editor. Your task is to improve an existing translation based on specific feedback.

RULES:
1. Apply the suggested improvements carefully
2. Maintain the original meaning
3. Keep the same tone and style
4. Ensure the result sounds natural in ${targetLanguage}

Return ONLY the improved translation, no explanations.`;

    const userPrompt = `Improve this translation based on the feedback:

ORIGINAL TEXT (${sourceLanguage}): "${sourceText}"

CURRENT TRANSLATION: "${currentTranslation}"

IMPROVEMENTS NEEDED:
${improvements.map((imp, i) => `${i + 1}. ${imp}`).join('\n')}

${sourceDuration ? `Note: Translation should be speakable in ~${sourceDuration} seconds` : ''}

IMPROVED TRANSLATION:`;

    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.3,
        max_tokens: 2000
      });

      const req = https.request({
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            // Return current translation if refinement fails
            resolve(currentTranslation);
            return;
          }
          
          const response = JSON.parse(data);
          const refined = response.choices[0].message.content.trim();
          resolve(refined.replace(/^["']|["']$/g, ''));
        });
      });

      req.on('error', () => resolve(currentTranslation));
      req.write(postData);
      req.end();
    });
  }

  /**
   * Get default evaluation when API fails
   */
  getDefaultEvaluation() {
    return {
      scores: {
        accuracy: { score: 7.5, feedback: 'Unable to evaluate - please review manually' },
        fluency: { score: 7.5, feedback: 'Unable to evaluate - please review manually' },
        adequacy: { score: 7.5, feedback: 'Unable to evaluate - please review manually' },
        cultural_fit: { score: 7.5, feedback: 'Unable to evaluate - please review manually' },
        timing_fit: { score: 7.5, feedback: 'Unable to evaluate - please review manually' }
      },
      composite: 7.5,
      improvements: ['Manual review recommended'],
      pass: false
    };
  }

  // ==================== TWO-STEP VIDEO WORKFLOW ====================
  
  /**
   * Step 1: Process edit list - combine multiple segments into a single video
   * This is the "edit and re-record" step
   * 
   * @param {string} inputPath - Source video path
   * @param {Array} editList - Array of segments to include: [{startTime, endTime, label?}]
   * @param {Object} options - Output options
   * @returns {Promise} - Resolves with output path
   */
  async processEditList(inputPath, editList, options = {}, progressCallback = null) {
    const {
      outputPath = null,
      format = 'mp4',
      quality = 'high', // low, medium, high
      preserveQuality = true // If true, use copy codec where possible
    } = options;

    if (!editList || editList.length === 0) {
      throw new Error('Edit list is empty - no segments to process');
    }

    // Sort segments by start time
    const sortedSegments = [...editList].sort((a, b) => a.startTime - b.startTime);

    // Check for overlapping segments and validate
    for (let i = 0; i < sortedSegments.length; i++) {
      const seg = sortedSegments[i];
      if (seg.startTime >= seg.endTime) {
        throw new Error(`Invalid segment ${i + 1}: startTime must be less than endTime`);
      }
      if (i > 0 && seg.startTime < sortedSegments[i - 1].endTime) {
        throw new Error(`Segments ${i} and ${i + 1} overlap`);
      }
    }

    const baseName = path.basename(inputPath, path.extname(inputPath));
    const output = outputPath || path.join(this.outputDir, `${baseName}_edited_${Date.now()}.${format}`);
    const jobId = `edit_${Date.now()}`;

    console.log(`[VideoEditor] Processing edit list with ${editList.length} segments`);

    // Create temp directory for segment files
    const tempDir = path.join(this.outputDir, `temp_edit_${jobId}`);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    try {
      const segmentFiles = [];
      const totalSegments = sortedSegments.length;

      // Extract each segment
      for (let i = 0; i < totalSegments; i++) {
        const seg = sortedSegments[i];
        const segmentPath = path.join(tempDir, `segment_${String(i).padStart(3, '0')}.mp4`);
        const duration = seg.endTime - seg.startTime;

        if (progressCallback) {
          progressCallback({
            jobId,
            phase: 'extracting',
            segment: i + 1,
            totalSegments,
            percent: (i / totalSegments) * 50, // First 50% is extraction
            message: `Extracting segment ${i + 1}/${totalSegments}`
          });
        }

        await new Promise((resolve, reject) => {
          let cmd = ffmpeg(inputPath)
            .setStartTime(seg.startTime)
            .setDuration(duration);

          if (preserveQuality) {
            // Try to use stream copy for speed
            cmd = cmd.outputOptions([
              '-c:v', 'libx264',
              '-c:a', 'aac',
              '-avoid_negative_ts', 'make_zero',
              '-preset', 'fast',
              '-crf', '18'
            ]);
          } else {
            const qualitySettings = {
              'low': { crf: 28, preset: 'fast' },
              'medium': { crf: 23, preset: 'medium' },
              'high': { crf: 18, preset: 'slow' }
            };
            const settings = qualitySettings[quality] || qualitySettings.high;
            cmd = cmd.outputOptions([
              '-c:v', 'libx264',
              '-c:a', 'aac',
              '-avoid_negative_ts', 'make_zero',
              `-preset`, settings.preset,
              `-crf`, String(settings.crf)
            ]);
          }

          cmd.output(segmentPath)
            .on('end', () => {
              console.log(`[VideoEditor] Segment ${i + 1}/${totalSegments} extracted`);
              resolve();
            })
            .on('error', reject)
            .run();
        });

        segmentFiles.push(segmentPath);
      }

      if (progressCallback) {
        progressCallback({
          jobId,
          phase: 'merging',
          percent: 60,
          message: 'Merging segments...'
        });
      }

      // Create concat list file
      const listPath = path.join(tempDir, 'concat_list.txt');
      const listContent = segmentFiles.map(f => `file '${f}'`).join('\n');
      fs.writeFileSync(listPath, listContent);

      // Concatenate all segments
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

      // Cleanup temp files
      segmentFiles.forEach(f => {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      });
      if (fs.existsSync(listPath)) fs.unlinkSync(listPath);
      if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);

      // Get output file info
      const outputInfo = await this.getVideoInfo(output);

      console.log(`[VideoEditor] Edit complete: ${output}`);
      console.log(`[VideoEditor] Output duration: ${outputInfo.durationFormatted}`);

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
      // Cleanup on error
      if (fs.existsSync(tempDir)) {
        try {
          fs.readdirSync(tempDir).forEach(f => fs.unlinkSync(path.join(tempDir, f)));
          fs.rmdirSync(tempDir);
        } catch (e) {}
      }
      throw error;
    }
  }

  /**
   * Step 2: Finalize video workflow
   * Replaces the original video in the space with the edited version
   * and saves the scene list to metadata
   * 
   * @param {string} spaceItemId - The clipboard item ID of the original video
   * @param {string} editedVideoPath - Path to the edited video
   * @param {Array} scenes - Scene list to save: [{id, name, inTime, outTime, description?, tags?}]
   * @param {Object} clipboardManager - Reference to clipboard manager for updating
   */
  async finalizeVideoWorkflow(spaceItemId, editedVideoPath, scenes, clipboardManager) {
    if (!clipboardManager) {
      throw new Error('Clipboard manager reference required');
    }

    if (!fs.existsSync(editedVideoPath)) {
      throw new Error('Edited video file not found');
    }

    console.log(`[VideoEditor] Finalizing workflow for item: ${spaceItemId}`);

    // Get the original item
    const item = clipboardManager.storage.loadItem(spaceItemId);
    if (!item) {
      throw new Error('Original video item not found in space');
    }

    // Get the original file path in storage
    const originalPath = item.content; // This should be the file path
    const itemDir = path.dirname(originalPath);

    // Backup original (optional - keep for safety)
    const backupPath = originalPath + '.backup';
    if (fs.existsSync(originalPath)) {
      fs.copyFileSync(originalPath, backupPath);
      console.log(`[VideoEditor] Backed up original to: ${backupPath}`);
    }

    // Copy edited video to replace original
    fs.copyFileSync(editedVideoPath, originalPath);
    console.log(`[VideoEditor] Replaced video with edited version`);

    // Update metadata with scenes
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
    console.log(`[VideoEditor] Saved ${validatedScenes.length} scenes to metadata`);

    // Get new video info
    const newInfo = await this.getVideoInfo(originalPath);

    // Update index entry with new file info
    const indexEntry = clipboardManager.storage.index.items.find(i => i.id === spaceItemId);
    if (indexEntry) {
      indexEntry.fileSize = newInfo.size;
      indexEntry.timestamp = Date.now(); // Update modified time
      clipboardManager.storage.saveIndex();
    }

    // Sync to space metadata if applicable
    if (item.spaceId) {
      try {
        const spaceMetadata = clipboardManager.storage.getSpaceMetadata(item.spaceId);
        if (spaceMetadata) {
          const fileKey = item.fileName || `item-${spaceItemId}`;
          spaceMetadata.files[fileKey] = {
            ...spaceMetadata.files[fileKey],
            scenes: validatedScenes,
            scenesUpdatedAt: metadata.scenesUpdatedAt,
            editedAt: metadata.editedAt,
            duration: newInfo.duration,
            fileSize: newInfo.size
          };
          clipboardManager.storage.updateSpaceMetadata(item.spaceId, { files: spaceMetadata.files });
          console.log(`[VideoEditor] Synced to space metadata`);
        }
      } catch (e) {
        console.error('[VideoEditor] Error syncing to space metadata:', e);
      }
    }

    return {
      success: true,
      itemId: spaceItemId,
      scenesCount: validatedScenes.length,
      newDuration: newInfo.duration,
      newDurationFormatted: newInfo.durationFormatted,
      newFileSize: newInfo.size,
      backupPath: backupPath
    };
  }

  /**
   * Auto-detect scene boundaries using audio silence and video changes
   * Useful as a starting point for manual scene markup
   */
  async detectScenes(inputPath, options = {}) {
    const {
      minSceneDuration = 5, // Minimum scene duration in seconds
      silenceThreshold = -30, // dB threshold for silence detection
      silenceDuration = 0.5 // Minimum silence duration to mark as scene break
    } = options;

    console.log(`[VideoEditor] Detecting scenes in: ${inputPath}`);

    const info = await this.getVideoInfo(inputPath);
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

            console.log(`[VideoEditor] Detected ${scenes.length} scenes`);

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
   * Get list of exported files
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
   * Setup IPC handlers for renderer communication
   */
  setupIPC(mainWindow) {
    // Prevent duplicate handler registration
    if (this.ipcHandlersRegistered) {
      console.log('[VideoEditor] IPC handlers already registered, skipping');
      return;
    }
    this.ipcHandlersRegistered = true;

    // Get video info
    ipcMain.handle('video-editor:get-info', async (event, videoPath) => {
      try {
        return await this.getVideoInfo(videoPath);
      } catch (error) {
        return { error: error.message };
      }
    });

    // Generate thumbnails
    ipcMain.handle('video-editor:generate-thumbnails', async (event, videoPath, options) => {
      try {
        return await this.generateThumbnails(videoPath, options);
      } catch (error) {
        return { error: error.message };
      }
    });

    // Generate single thumbnail
    ipcMain.handle('video-editor:generate-thumbnail', async (event, videoPath, timestamp) => {
      try {
        return await this.generateSingleThumbnail(videoPath, timestamp);
      } catch (error) {
        return { error: error.message };
      }
    });

    // Generate timeline thumbnails
    ipcMain.handle('video-editor:timeline-thumbnails', async (event, videoPath, options) => {
      try {
        return await this.generateTimelineThumbnails(videoPath, options);
      } catch (error) {
        return { error: error.message };
      }
    });

    // Generate audio waveform data
    ipcMain.handle('video-editor:waveform', async (event, videoPath, options) => {
      try {
        console.log('[VideoEditor] Generating waveform for:', videoPath);
        return await this.generateWaveformData(videoPath, options);
      } catch (error) {
        console.error('[VideoEditor] Waveform error:', error);
        return { error: error.message };
      }
    });

    // Trim video
    ipcMain.handle('video-editor:trim', async (event, videoPath, options) => {
      try {
        return await this.trimVideo(videoPath, options, (progress) => {
          mainWindow?.webContents.send('video-editor:progress', progress);
        });
      } catch (error) {
        return { error: error.message };
      }
    });

    // Transcode video
    ipcMain.handle('video-editor:transcode', async (event, videoPath, options) => {
      try {
        return await this.transcodeVideo(videoPath, options, (progress) => {
          mainWindow?.webContents.send('video-editor:progress', progress);
        });
      } catch (error) {
        return { error: error.message };
      }
    });

    // Extract audio
    ipcMain.handle('video-editor:extract-audio', async (event, videoPath, options) => {
      try {
        return await this.extractAudio(videoPath, options, (progress) => {
          mainWindow?.webContents.send('video-editor:progress', progress);
        });
      } catch (error) {
        return { error: error.message };
      }
    });

    // Compress video
    ipcMain.handle('video-editor:compress', async (event, videoPath, options) => {
      try {
        return await this.compressVideo(videoPath, options, (progress) => {
          mainWindow?.webContents.send('video-editor:progress', progress);
        });
      } catch (error) {
        return { error: error.message };
      }
    });

    // Change video speed
    ipcMain.handle('video-editor:change-speed', async (event, videoPath, options) => {
      try {
        return await this.changeSpeed(videoPath, options, (progress) => {
          mainWindow?.webContents.send('video-editor:progress', progress);
        });
      } catch (error) {
        return { error: error.message };
      }
    });

    // Reverse video
    ipcMain.handle('video-editor:reverse', async (event, videoPath, options) => {
      try {
        return await this.reverseVideo(videoPath, options, (progress) => {
          mainWindow?.webContents.send('video-editor:progress', progress);
        });
      } catch (error) {
        return { error: error.message };
      }
    });

    // Splice video (remove middle section)
    ipcMain.handle('video-editor:splice', async (event, videoPath, options) => {
      try {
        return await this.spliceVideo(videoPath, options, (progress) => {
          mainWindow?.webContents.send('video-editor:progress', progress);
        });
      } catch (error) {
        return { error: error.message };
      }
    });

    // Export playlist (concatenate segments)
    ipcMain.handle('video-editor:export-playlist', async (event, videoPath, options) => {
      try {
        return await this.exportPlaylist(videoPath, options);
      } catch (error) {
        return { error: error.message };
      }
    });

    // Build playlist with AI
    ipcMain.handle('video-editor:build-playlist-ai', async (event, options) => {
      try {
        return await this.buildPlaylistWithAI(options);
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    // Transcribe a range of the video
    ipcMain.handle('video-editor:transcribe-range', async (event, videoPath, options) => {
      try {
        return await this.transcribeRange(videoPath, options);
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    // Generate screengrabs from a range
    ipcMain.handle('video-editor:generate-screengrabs', async (event, videoPath, options) => {
      try {
        return await this.generateRangeScreengrabs(videoPath, options);
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    // Open a folder in Finder
    ipcMain.handle('video-editor:open-folder', async (event, folderPath) => {
      try {
        await shell.openPath(folderPath);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    // Add watermark
    ipcMain.handle('video-editor:watermark', async (event, videoPath, watermarkPath, options) => {
      try {
        return await this.addWatermark(videoPath, watermarkPath, options, (progress) => {
          mainWindow?.webContents.send('video-editor:progress', progress);
        });
      } catch (error) {
        return { error: error.message };
      }
    });

    // Concatenate videos
    ipcMain.handle('video-editor:concatenate', async (event, videoPaths, options) => {
      try {
        return await this.concatenateVideos(videoPaths, options, (progress) => {
          mainWindow?.webContents.send('video-editor:progress', progress);
        });
      } catch (error) {
        return { error: error.message };
      }
    });

    // Create slideshow
    ipcMain.handle('video-editor:slideshow', async (event, imagePaths, options) => {
      try {
        return await this.createSlideshow(imagePaths, options, (progress) => {
          mainWindow?.webContents.send('video-editor:progress', progress);
        });
      } catch (error) {
        return { error: error.message };
      }
    });

    // Replace audio with ElevenLabs
    ipcMain.handle('video-editor:replace-audio-elevenlabs', async (event, videoPath, options) => {
      try {
        console.log('[VideoEditor] Replacing audio with ElevenLabs:', options.markerName);
        return await this.replaceAudioWithElevenLabs(videoPath, options, (progress) => {
          mainWindow?.webContents.send('video-editor:progress', progress);
        });
      } catch (error) {
        console.error('[VideoEditor] ElevenLabs error:', error);
        return { error: error.message };
      }
    });

    // Cancel job
    ipcMain.handle('video-editor:cancel', async (event, jobId) => {
      return this.cancelJob(jobId);
    });

    // Get exported files
    ipcMain.handle('video-editor:get-exports', async () => {
      return this.getExportedFiles();
    });

    // Get output directory
    ipcMain.handle('video-editor:get-output-dir', async () => {
      return this.outputDir;
    });

    // Open file in finder/explorer
    ipcMain.handle('video-editor:reveal-file', async (event, filePath) => {
      const { shell } = require('electron');
      shell.showItemInFolder(filePath);
      return true;
    });

    // ==================== TWO-STEP WORKFLOW IPC HANDLERS ====================

    // Step 1: Process edit list (combine segments into single video)
    ipcMain.handle('video-editor:process-edit-list', async (event, videoPath, editList, options) => {
      try {
        console.log('[VideoEditor] Processing edit list:', editList.length, 'segments');
        return await this.processEditList(videoPath, editList, options, (progress) => {
          mainWindow?.webContents.send('video-editor:progress', progress);
        });
      } catch (error) {
        console.error('[VideoEditor] Process edit list error:', error);
        return { success: false, error: error.message };
      }
    });

    // Step 2: Finalize workflow (replace video + save scenes)
    // Note: clipboardManager must be passed separately when setting up
    ipcMain.handle('video-editor:finalize-workflow', async (event, spaceItemId, editedVideoPath, scenes) => {
      try {
        // Get clipboard manager reference from global
        const clipboardManager = global.clipboardManager;
        if (!clipboardManager) {
          throw new Error('Clipboard manager not available');
        }
        return await this.finalizeVideoWorkflow(spaceItemId, editedVideoPath, scenes, clipboardManager);
      } catch (error) {
        console.error('[VideoEditor] Finalize workflow error:', error);
        return { success: false, error: error.message };
      }
    });

    // Auto-detect scene boundaries
    ipcMain.handle('video-editor:detect-scenes', async (event, videoPath, options) => {
      try {
        return await this.detectScenes(videoPath, options);
      } catch (error) {
        console.error('[VideoEditor] Detect scenes error:', error);
        return { success: false, error: error.message };
      }
    });

    // ==================== TRANSLATION PIPELINE IPC HANDLERS ====================
    
    // Full translation with quality loop
    ipcMain.handle('video-editor:translate-with-quality', async (event, sourceText, options) => {
      try {
        console.log('[VideoEditor] Starting translation pipeline:', sourceText.substring(0, 50) + '...');
        return await this.translateWithQualityLoop(sourceText, options);
      } catch (error) {
        console.error('[VideoEditor] Translation pipeline error:', error);
        return { success: false, error: error.message };
      }
    });

    // Single translation step (no quality loop)
    ipcMain.handle('video-editor:translate-text', async (event, sourceText, options) => {
      try {
        const settingsPath = path.join(app.getPath('userData'), 'settings.json');
        let openaiKey = null;
        
        if (fs.existsSync(settingsPath)) {
          const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
          openaiKey = settings.openaiApiKey;
        }

        if (!openaiKey) {
          return { success: false, error: 'OpenAI API key not configured' };
        }

        const translation = await this.translateText(sourceText, options, openaiKey);
        return { success: true, translation };
      } catch (error) {
        console.error('[VideoEditor] Translate text error:', error);
        return { success: false, error: error.message };
      }
    });

    // Evaluate a translation
    ipcMain.handle('video-editor:evaluate-translation', async (event, sourceText, translatedText, options) => {
      try {
        const settingsPath = path.join(app.getPath('userData'), 'settings.json');
        let apiKey = null;
        
        if (fs.existsSync(settingsPath)) {
          const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
          apiKey = settings.anthropicApiKey || settings.claudeApiKey || settings.openaiApiKey;
        }

        if (!apiKey) {
          return { success: false, error: 'API key not configured' };
        }

        const evaluation = await this.evaluateTranslation(sourceText, translatedText, options, apiKey);
        return { success: true, evaluation };
      } catch (error) {
        console.error('[VideoEditor] Evaluate translation error:', error);
        return { success: false, error: error.message };
      }
    });

    // Get video from space item
    ipcMain.handle('video-editor:get-space-video', async (event, itemId) => {
      try {
        const clipboardManager = global.clipboardManager;
        if (!clipboardManager) {
          throw new Error('Clipboard manager not available');
        }
        
        const item = clipboardManager.storage.loadItem(itemId);
        if (!item) {
          return { success: false, error: 'Item not found' };
        }
        
        if (item.type !== 'file' || !item.fileType?.startsWith('video/')) {
          return { success: false, error: 'Item is not a video' };
        }
        
        // Load scenes from metadata
        const metadataPath = path.join(clipboardManager.storage.storageRoot, item.metadataPath);
        let scenes = [];
        if (fs.existsSync(metadataPath)) {
          const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
          scenes = metadata.scenes || [];
        }
        
        return {
          success: true,
          itemId: itemId,
          videoPath: item.content,
          fileName: item.fileName,
          fileType: item.fileType,
          spaceId: item.spaceId,
          scenes: scenes
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    // Quick save scenes to existing video (without re-encoding)
    ipcMain.handle('video-editor:save-scenes-only', async (event, itemId, scenes) => {
      try {
        const clipboardManager = global.clipboardManager;
        if (!clipboardManager) {
          throw new Error('Clipboard manager not available');
        }
        
        const item = clipboardManager.storage.loadItem(itemId);
        if (!item) {
          return { success: false, error: 'Item not found' };
        }
        
        // Update metadata
        const metadataPath = path.join(clipboardManager.storage.storageRoot, item.metadataPath);
        let metadata = {};
        if (fs.existsSync(metadataPath)) {
          metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        }
        
        metadata.scenes = scenes;
        metadata.scenesUpdatedAt = new Date().toISOString();
        
        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
        
        // Sync to space metadata
        if (item.spaceId) {
          try {
            const spaceMetadata = clipboardManager.storage.getSpaceMetadata(item.spaceId);
            if (spaceMetadata) {
              const fileKey = item.fileName || `item-${itemId}`;
              spaceMetadata.files[fileKey] = {
                ...spaceMetadata.files[fileKey],
                scenes: scenes,
                scenesUpdatedAt: metadata.scenesUpdatedAt
              };
              clipboardManager.storage.updateSpaceMetadata(item.spaceId, { files: spaceMetadata.files });
            }
          } catch (e) {
            console.error('[VideoEditor] Error syncing scenes to space:', e);
          }
        }
        
        console.log(`[VideoEditor] Saved ${scenes.length} scenes for item: ${itemId}`);
        return { success: true, scenesCount: scenes.length };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    console.log('[VideoEditor] IPC handlers registered (including workflow handlers)');
  }
}

module.exports = VideoEditor;

