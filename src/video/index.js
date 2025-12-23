/**
 * Video Editor Module - Main Entry Point
 * Coordinates all video editing services
 * @module src/video
 */

// Core services
import { VideoProcessor, formatDuration, formatTime, parseTime } from './core/VideoProcessor.js';
import { ThumbnailService } from './core/ThumbnailService.js';
import { WaveformService } from './core/WaveformService.js';

// Editing services
import { TrimService } from './editing/TrimService.js';
import { TranscodeService } from './editing/TranscodeService.js';
import { SpliceService } from './editing/SpliceService.js';
import { ConcatenateService } from './editing/ConcatenateService.js';
import { WatermarkService } from './editing/WatermarkService.js';
import { SpeedService } from './editing/SpeedService.js';
import { AudioToVideoService } from './editing/AudioToVideoService.js';

// Audio services
import { AudioExtractor } from './audio/AudioExtractor.js';
import { AudioReplacer } from './audio/AudioReplacer.js';
import { ElevenLabsService } from './audio/ElevenLabsService.js';

// Scene services
import { SceneDetector } from './scenes/SceneDetector.js';
import { SceneManager } from './scenes/SceneManager.js';

// Translation services
import { TranslationPipeline } from './translation/TranslationPipeline.js';
import { TranslationEvaluator } from './translation/TranslationEvaluator.js';

// Export services
import { PlaylistExporter } from './export/PlaylistExporter.js';
import { ScreengrabService } from './export/ScreengrabService.js';
import { SlideshowService } from './export/SlideshowService.js';

// Versioning services
import { VersionManager, BRANCH_TYPES, BRANCH_TYPE_INFO } from './versioning/VersionManager.js';
import { EDLManager, SEGMENT_TYPES } from './versioning/EDLManager.js';
import { BranchRenderer } from './versioning/BranchRenderer.js';

// Release services
import { ReleaseManager, RELEASE_DESTINATION, RELEASE_STATUS } from './release/ReleaseManager.js';
import { ProjectStateDetector, RELEASE_STATE } from './release/ProjectStateDetector.js';
import { YouTubeUploader, YOUTUBE_PRIVACY, YOUTUBE_CATEGORIES } from './release/YouTubeUploader.js';
import { VimeoUploader, VIMEO_PRIVACY } from './release/VimeoUploader.js';

// IPC setup
import { setupVideoEditorIPC } from './ipc/VideoEditorIPC.js';

/**
 * VideoEditor - Main coordinator class
 * Provides a unified API for all video editing operations
 */
export class VideoEditor {
  constructor() {
    // Core
    this.processor = new VideoProcessor();
    this.thumbnails = new ThumbnailService();
    this.waveform = new WaveformService();
    
    // Editing
    this.trim = new TrimService();
    this.transcode = new TranscodeService();
    this.splice = new SpliceService();
    this.concatenate = new ConcatenateService();
    this.watermark = new WatermarkService();
    this.speed = new SpeedService();
    this.audioToVideo = new AudioToVideoService();
    
    // Audio
    this.audioExtractor = new AudioExtractor();
    this.audioReplacer = new AudioReplacer();
    this.elevenLabs = new ElevenLabsService();
    
    // Scenes
    this.sceneDetector = new SceneDetector();
    this.sceneManager = new SceneManager();
    
    // Translation
    this.translation = new TranslationPipeline();
    this.translationEvaluator = new TranslationEvaluator();
    
    // Export
    this.playlist = new PlaylistExporter();
    this.screengrabs = new ScreengrabService();
    this.slideshow = new SlideshowService();
    
    // State
    this.ipcHandlersRegistered = false;
    this.outputDir = this.processor.outputDir;
    this.thumbnailDir = this.processor.thumbnailDir;
    this.activeJobs = this.processor.activeJobs;

    console.log('[VideoEditor] Initialized with modular architecture');
  }

  // ==================== CORE OPERATIONS ====================

  async getVideoInfo(inputPath) {
    return this.processor.getVideoInfo(inputPath);
  }

  // ==================== THUMBNAIL OPERATIONS ====================

  async generateThumbnails(inputPath, options) {
    return this.thumbnails.generateThumbnails(inputPath, options);
  }

  async generateSingleThumbnail(inputPath, timestamp, outputPath) {
    return this.thumbnails.generateSingleThumbnail(inputPath, timestamp, outputPath);
  }

  async generateTimelineThumbnails(inputPath, options) {
    return this.thumbnails.generateTimelineThumbnails(inputPath, options);
  }

  async generateRangeScreengrabs(inputPath, options) {
    return this.screengrabs.generateScreengrabs(inputPath, options);
  }

  // ==================== WAVEFORM ====================

  async generateWaveformData(inputPath, options) {
    return this.waveform.generateWaveformData(inputPath, options);
  }

  // ==================== EDITING OPERATIONS ====================

  async trimVideo(inputPath, options, progressCallback) {
    return this.trim.trimVideo(inputPath, options, progressCallback);
  }

  async transcodeVideo(inputPath, options, progressCallback) {
    return this.transcode.transcodeVideo(inputPath, options, progressCallback);
  }

  async compressVideo(inputPath, options, progressCallback) {
    return this.transcode.compressVideo(inputPath, options, progressCallback);
  }

  async spliceVideo(inputPath, options, progressCallback) {
    return this.splice.spliceVideo(inputPath, options, progressCallback);
  }

  async concatenateVideos(inputPaths, options, progressCallback) {
    return this.concatenate.concatenateVideos(inputPaths, options, progressCallback);
  }

  async addWatermark(inputPath, watermarkPath, options, progressCallback) {
    return this.watermark.addWatermark(inputPath, watermarkPath, options, progressCallback);
  }

  async changeSpeed(inputPath, options, progressCallback) {
    return this.speed.changeSpeed(inputPath, options, progressCallback);
  }

  async reverseVideo(inputPath, options, progressCallback) {
    return this.speed.reverseVideo(inputPath, options, progressCallback);
  }

  async createVideoFromAudio(audioPath, options, progressCallback) {
    return this.audioToVideo.createVideoFromAudio(audioPath, options, progressCallback);
  }

  // ==================== AUDIO OPERATIONS ====================

  async extractAudio(inputPath, options, progressCallback) {
    return this.audioExtractor.extractAudio(inputPath, options, progressCallback);
  }

  async replaceAudioWithElevenLabs(inputPath, options, progressCallback) {
    return this.elevenLabs.replaceAudioWithElevenLabs(inputPath, options, progressCallback);
  }

  async generateElevenLabsAudio(text, voice) {
    return this.elevenLabs.generateAudio(text, voice);
  }

  /**
   * Generate ElevenLabs audio only (non-destructive - no video processing)
   * Returns the path to the generated audio file
   */
  async generateElevenLabsAudioOnly(options, progressCallback) {
    const { text, voice = 'Rachel' } = options;
    
    if (progressCallback) {
      progressCallback({ status: 'Generating AI voice...', percent: 10 });
    }

    try {
      const audioPath = await this.elevenLabs.generateAudio(text, voice);
      
      if (progressCallback) {
        progressCallback({ status: 'Audio generated!', percent: 100 });
      }

      return {
        success: true,
        audioPath,
        voice,
        textLength: text.length
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Export video with all audio replacements applied at once
   * This is more efficient than re-encoding for each replacement
   */
  async exportWithAudioReplacements(videoPath, replacements, progressCallback) {
    const fs = await import('fs');
    const path = await import('path');
    const ffmpeg = (await import('fluent-ffmpeg')).default;
    
    if (!replacements || replacements.length === 0) {
      throw new Error('No audio replacements provided');
    }

    // Sort replacements by start time
    const sorted = [...replacements].sort((a, b) => a.startTime - b.startTime);
    
    console.log('[VideoEditor] Exporting with', sorted.length, 'audio replacements');

    const baseName = path.basename(videoPath, path.extname(videoPath));
    const outputPath = path.join(this.outputDir, `${baseName}_edited_${Date.now()}.mp4`);
    const tempDir = path.join(this.outputDir, `temp_export_${Date.now()}`);
    
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    try {
      // Get video info
      const videoInfo = await this.getVideoInfo(videoPath);
      const totalDuration = videoInfo.duration;

      if (progressCallback) {
        progressCallback({ status: 'Preparing audio segments...', percent: 5 });
      }

      // Build the complete audio track with replacements
      const audioSegments = [];
      let currentTime = 0;

      for (let i = 0; i < sorted.length; i++) {
        const r = sorted[i];
        
        // Audio before this replacement (from original)
        if (r.startTime > currentTime) {
          audioSegments.push({
            type: 'original',
            start: currentTime,
            end: r.startTime
          });
        }
        
        // The replacement audio
        audioSegments.push({
          type: 'replacement',
          path: r.path,
          start: r.startTime,
          end: r.endTime,
          targetDuration: r.endTime - r.startTime
        });
        
        currentTime = r.endTime;
      }

      // Audio after last replacement
      if (currentTime < totalDuration) {
        audioSegments.push({
          type: 'original',
          start: currentTime,
          end: totalDuration
        });
      }

      console.log('[VideoEditor] Audio segments:', audioSegments.length);

      // Extract each segment
      const segmentFiles = [];
      for (let i = 0; i < audioSegments.length; i++) {
        const seg = audioSegments[i];
        const segPath = path.join(tempDir, `seg_${i}.mp3`);
        
        if (progressCallback) {
          const pct = 10 + (i / audioSegments.length) * 40;
          progressCallback({ status: `Processing segment ${i + 1}/${audioSegments.length}...`, percent: pct });
        }

        if (seg.type === 'original') {
          // Extract from original video
          await new Promise((resolve, reject) => {
            ffmpeg(videoPath)
              .setStartTime(seg.start)
              .duration(seg.end - seg.start)
              .noVideo()
              .audioCodec('libmp3lame')
              .output(segPath)
              .on('end', resolve)
              .on('error', reject)
              .run();
          });
        } else {
          // Use the replacement audio (adjust speed if needed)
          const sourceInfo = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(seg.path, (err, data) => {
              if (err) reject(err);
              else resolve(data);
            });
          });
          
          const sourceDuration = sourceInfo.format.duration;
          const tempoRatio = sourceDuration / seg.targetDuration;
          
          if (Math.abs(tempoRatio - 1.0) > 0.05) {
            // Need to adjust tempo
            const filter = this._buildTempoFilter(tempoRatio);
            await new Promise((resolve, reject) => {
              ffmpeg(seg.path)
                .audioFilters(filter)
                .audioCodec('libmp3lame')
                .output(segPath)
                .on('end', resolve)
                .on('error', reject)
                .run();
            });
          } else {
            // Just copy
            fs.copyFileSync(seg.path, segPath);
          }
        }
        
        segmentFiles.push(segPath);
      }

      if (progressCallback) {
        progressCallback({ status: 'Concatenating audio...', percent: 55 });
      }

      // Concatenate all audio segments
      const concatFile = path.join(tempDir, 'concat.txt');
      const concatContent = segmentFiles.map(f => `file '${f}'`).join('\n');
      fs.writeFileSync(concatFile, concatContent);

      const finalAudio = path.join(tempDir, 'final_audio.mp3');
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(concatFile)
          .inputOptions(['-f concat', '-safe 0'])
          .audioCodec('libmp3lame')
          .output(finalAudio)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      if (progressCallback) {
        progressCallback({ status: 'Merging video and audio...', percent: 70 });
      }

      // Merge with video (copy video stream)
      await new Promise((resolve, reject) => {
        ffmpeg(videoPath)
          .input(finalAudio)
          .videoCodec('copy')
          .audioCodec('aac')
          .outputOptions(['-map 0:v:0', '-map 1:a:0'])
          .output(outputPath)
          .on('progress', (progress) => {
            if (progressCallback && progress.percent) {
              progressCallback({ 
                status: `Finalizing... ${Math.round(progress.percent)}%`, 
                percent: 70 + (progress.percent * 0.3) 
              });
            }
          })
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      // Cleanup
      fs.rmSync(tempDir, { recursive: true, force: true });

      if (progressCallback) {
        progressCallback({ status: 'Complete!', percent: 100 });
      }

      console.log('[VideoEditor] Export complete:', outputPath);

      return {
        success: true,
        outputPath,
        replacementsApplied: replacements.length
      };

    } catch (error) {
      // Cleanup on error
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
      throw error;
    }
  }

  /**
   * Build tempo filter for FFmpeg
   * @private
   */
  _buildTempoFilter(tempoRatio) {
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
    
    return tempoFilters.join(',') || 'anull';
  }

  async replaceAudioSegment(videoPath, audioPath, startTime, endTime, outputPath, progressCallback) {
    return this.audioReplacer.replaceAudioSegment(videoPath, audioPath, startTime, endTime, outputPath, progressCallback);
  }

  // ==================== SCENE OPERATIONS ====================

  async detectScenes(inputPath, options) {
    return this.sceneDetector.detectScenes(inputPath, options);
  }

  async processEditList(inputPath, editList, options, progressCallback) {
    return this.sceneManager.processEditList(inputPath, editList, options, progressCallback);
  }

  async finalizeVideoWorkflow(spaceItemId, editedVideoPath, scenes, clipboardManager) {
    return this.sceneManager.finalizeVideoWorkflow(spaceItemId, editedVideoPath, scenes, clipboardManager);
  }

  async saveScenesOnly(itemId, scenes, clipboardManager) {
    return this.sceneManager.saveScenesOnly(itemId, scenes, clipboardManager);
  }

  // ==================== TRANSLATION OPERATIONS ====================

  async translateWithQualityLoop(sourceText, options) {
    return this.translation.translateWithQualityLoop(sourceText, options);
  }

  async translateText(sourceText, options, apiKey) {
    return this.translation.translateText(sourceText, options, apiKey);
  }

  async evaluateTranslation(sourceText, translatedText, options, apiKey) {
    return this.translationEvaluator.evaluateTranslation(sourceText, translatedText, options, apiKey);
  }

  getApiKeys() {
    return this.translation.getApiKeys();
  }

  // ==================== EXPORT OPERATIONS ====================

  async exportPlaylist(inputPath, options) {
    return this.playlist.exportPlaylist(inputPath, options);
  }

  async buildPlaylistWithAI(options) {
    return this.playlist.buildPlaylistWithAI(options);
  }

  async createSlideshow(imagePaths, options, progressCallback) {
    return this.slideshow.createSlideshow(imagePaths, options, progressCallback);
  }

  // ==================== JOB MANAGEMENT ====================

  cancelJob(jobId) {
    return this.processor.cancelJob(jobId);
  }

  getExportedFiles() {
    return this.processor.getExportedFiles();
  }

  // ==================== TRANSCRIPTION ====================

  /**
   * Transcribe a range of video/audio using OpenAI Whisper
   * Returns word-level timestamps for accurate sync
   * Automatically chunks long audio files to stay under Whisper's 25MB limit
   * Sends progress updates via onChunkComplete callback
   */
  async transcribeRange(inputPath, options = {}) {
    const { app } = await import('electron');
    const fs = await import('fs');
    const path = await import('path');
    const https = await import('https');
    const ffmpeg = (await import('fluent-ffmpeg')).default;
    
    const {
      startTime = 0,
      endTime = null,
      language = 'en',
      onChunkComplete = null  // Callback for progress updates
    } = options;

    // Get video duration if endTime not specified
    let totalDuration;
    if (endTime === null) {
      const info = await this.getVideoInfo(inputPath);
      totalDuration = info.duration - startTime;
    } else {
      totalDuration = endTime - startTime;
    }

    // Get OpenAI API key
    let openaiKey = null;
    if (global.settingsManager) {
      openaiKey = global.settingsManager.get('openaiApiKey');
    }
    if (!openaiKey) {
      const settingsPath = path.join(app.getPath('userData'), 'settings.json');
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        openaiKey = settings.openaiApiKey;
      }
    }
    if (!openaiKey) {
      openaiKey = process.env.OPENAI_API_KEY;
    }
    if (!openaiKey) {
      throw new Error('OpenAI API key not configured. Please set it in Settings → API Keys → OpenAI.');
    }
    
    console.log('[VideoEditor] Using OpenAI key:', openaiKey ? `${openaiKey.substring(0, 10)}...` : 'none');

    // Calculate chunk size: ~10 minutes per chunk (128kbps * 600s = ~9.6MB, safe under 25MB)
    const CHUNK_DURATION = 600; // 10 minutes in seconds
    const numChunks = Math.ceil(totalDuration / CHUNK_DURATION);
    
    console.log(`[VideoEditor] Total duration: ${totalDuration.toFixed(0)}s, splitting into ${numChunks} chunk(s)`);

    let allWords = [];
    let fullTranscription = '';

    for (let i = 0; i < numChunks; i++) {
      const chunkStart = startTime + (i * CHUNK_DURATION);
      const chunkDuration = Math.min(CHUNK_DURATION, totalDuration - (i * CHUNK_DURATION));
      
      console.log(`[VideoEditor] Processing chunk ${i + 1}/${numChunks}: ${chunkStart.toFixed(0)}s - ${(chunkStart + chunkDuration).toFixed(0)}s`);

      // Create temp audio file for this chunk
      const tempAudioPath = path.join(this.outputDir, `temp_transcribe_${Date.now()}_chunk${i}.mp3`);

      try {
        // Extract audio for this chunk
        await new Promise((resolve, reject) => {
          ffmpeg(inputPath)
            .setStartTime(chunkStart)
            .duration(chunkDuration)
            .noVideo()
            .audioCodec('libmp3lame')
            .audioBitrate('128k')
            .format('mp3')
            .output(tempAudioPath)
            .on('end', resolve)
            .on('error', reject)
            .run();
        });

        const audioBuffer = fs.readFileSync(tempAudioPath);
        const audioSize = audioBuffer.length;
        console.log(`[VideoEditor] Chunk ${i + 1} audio: ${(audioSize / 1024 / 1024).toFixed(2)}MB`);

        // Transcribe this chunk
        const chunkResult = await this._transcribeAudioBuffer(audioBuffer, openaiKey, language);
        
        // Add words with adjusted timestamps
        let chunkWords = [];
        if (chunkResult.words) {
          chunkWords = chunkResult.words.map(w => ({
            text: w.word || w.text,
            start: (w.start || 0) + chunkStart,
            end: (w.end || w.start + 0.3) + chunkStart
          }));
          allWords.push(...chunkWords);
        }
        
        fullTranscription += (fullTranscription ? ' ' : '') + (chunkResult.text || '');
        
        // Send progress update with words so far
        if (onChunkComplete) {
          onChunkComplete({
            chunkIndex: i,
            totalChunks: numChunks,
            chunkStart,
            chunkEnd: chunkStart + chunkDuration,
            chunkWords: chunkWords,  // Just this chunk's words
            allWords: allWords,       // All words so far
            transcription: fullTranscription,
            progress: ((i + 1) / numChunks) * 100
          });
        }
        
        // Clean up temp file
        if (fs.existsSync(tempAudioPath)) {
          fs.unlinkSync(tempAudioPath);
        }
        
      } catch (chunkError) {
        // Clean up on error
        if (fs.existsSync(tempAudioPath)) {
          fs.unlinkSync(tempAudioPath);
        }
        throw chunkError;
      }
    }

    console.log(`[VideoEditor] Transcription complete: ${allWords.length} words`);

    return {
      success: true,
      transcription: fullTranscription.trim(),
      words: allWords,
      startTime,
      endTime: startTime + totalDuration,
      duration: totalDuration,
      language
    };
  }

  /**
   * Internal: Transcribe a single audio buffer using Whisper API
   */
  async _transcribeAudioBuffer(audioBuffer, openaiKey, language = 'en') {
    const https = await import('https');
    
    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
    
    const parts = [];
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="audio.mp3"\r\n` +
      `Content-Type: audio/mpeg\r\n\r\n`
    ));
    parts.push(audioBuffer);
    parts.push(Buffer.from('\r\n'));
    
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model"\r\n\r\n` +
      `whisper-1\r\n`
    ));
    
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="language"\r\n\r\n` +
      `${language}\r\n`
    ));
    
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
      `verbose_json\r\n`
    ));
    
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="timestamp_granularities[]"\r\n\r\n` +
      `word\r\n`
    ));
    
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    
    const fullBody = Buffer.concat(parts);

    const response = await new Promise((resolve, reject) => {
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

    return JSON.parse(response);
  }

  // ==================== IPC SETUP ====================

  setupIPC(mainWindow) {
    setupVideoEditorIPC(this, mainWindow);
  }
}

// Export individual services for direct access if needed
export {
  VideoProcessor,
  ThumbnailService,
  WaveformService,
  TrimService,
  TranscodeService,
  SpliceService,
  ConcatenateService,
  WatermarkService,
  SpeedService,
  AudioExtractor,
  AudioReplacer,
  ElevenLabsService,
  SceneDetector,
  SceneManager,
  TranslationPipeline,
  TranslationEvaluator,
  PlaylistExporter,
  ScreengrabService,
  SlideshowService,
  // Versioning
  VersionManager,
  BRANCH_TYPES,
  BRANCH_TYPE_INFO,
  EDLManager,
  SEGMENT_TYPES,
  BranchRenderer,
  // Release
  ReleaseManager,
  RELEASE_DESTINATION,
  RELEASE_STATUS,
  ProjectStateDetector,
  RELEASE_STATE,
  YouTubeUploader,
  YOUTUBE_PRIVACY,
  YOUTUBE_CATEGORIES,
  VimeoUploader,
  VIMEO_PRIVACY,
  // IPC & Utilities
  setupVideoEditorIPC,
  formatDuration,
  formatTime,
  parseTime
};


