/**
 * VideoEditorIPC - IPC handler registration for video editor
 * @module src/video/ipc/VideoEditorIPC
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { ipcMain, shell } = require('electron');
const ai = require('../../../lib/ai-service');
const { getLogQueue } = require('../../../lib/log-event-queue');
const log = getLogQueue();

/**
 * Register all video editor IPC handlers
 * @param {Object} videoEditor - VideoEditor instance
 * @param {BrowserWindow} mainWindow - Main window for progress events
 */
export function setupVideoEditorIPC(videoEditor, mainWindow) {
  // Prevent duplicate registration
  if (videoEditor.ipcHandlersRegistered) {
    log.info('video', 'IPC handlers already registered, skipping');
    return;
  }
  videoEditor.ipcHandlersRegistered = true;

  log.info('video', 'Registering IPC handlers');

  // ==================== CORE OPERATIONS ====================

  // Get video info
  ipcMain.handle('video-editor:get-info', async (event, videoPath) => {
    try {
      return await videoEditor.getVideoInfo(videoPath);
    } catch (error) {
      return { error: error.message };
    }
  });

  // ==================== THUMBNAILS ====================

  ipcMain.handle('video-editor:generate-thumbnails', async (event, videoPath, options) => {
    try {
      return await videoEditor.generateThumbnails(videoPath, options);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('video-editor:generate-thumbnail', async (event, videoPath, timestamp) => {
    try {
      return await videoEditor.generateSingleThumbnail(videoPath, timestamp);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('video-editor:timeline-thumbnails', async (event, videoPath, options) => {
    try {
      return await videoEditor.generateTimelineThumbnails(videoPath, options);
    } catch (error) {
      return { error: error.message };
    }
  });

  // ==================== WAVEFORM ====================

  ipcMain.handle('video-editor:waveform', async (event, videoPath, options) => {
    try {
      log.info('video', 'Generating waveform', { videoPath });
      return await videoEditor.generateWaveformData(videoPath, options);
    } catch (error) {
      log.error('video', 'Waveform error', { error: error.message });
      return { error: error.message };
    }
  });

  // Save waveform cache to disk (peaks data as JSON)
  ipcMain.handle('video-editor:save-waveform-cache', async (event, videoPath, cacheData) => {
    try {
      const path = await import('path');
      const fs = await import('fs/promises');

      const videoDir = path.dirname(videoPath);
      const videoName = path.basename(videoPath, path.extname(videoPath));
      const cachePath = path.join(videoDir, `.${videoName}.waveform-cache.json`);

      await fs.writeFile(cachePath, JSON.stringify(cacheData), 'utf8');
      log.info('video', 'Waveform cache saved', { cachePath });
      return { success: true, cachePath };
    } catch (error) {
      log.error('video', 'Save waveform cache error', { error: error.message });
      return { error: error.message };
    }
  });

  // Load waveform cache from disk
  ipcMain.handle('video-editor:load-waveform-cache', async (event, videoPath) => {
    try {
      const path = await import('path');
      const fs = await import('fs/promises');

      const videoDir = path.dirname(videoPath);
      const videoName = path.basename(videoPath, path.extname(videoPath));
      const cachePath = path.join(videoDir, `.${videoName}.waveform-cache.json`);

      // Check if cache exists
      try {
        await fs.access(cachePath);
      } catch {
        return { exists: false };
      }

      const data = await fs.readFile(cachePath, 'utf8');
      const cacheData = JSON.parse(data);
      log.info('video', 'Waveform cache loaded', { cachePath });
      return { exists: true, ...cacheData };
    } catch (error) {
      log.error('video', 'Load waveform cache error', { error: error.message });
      return { exists: false, error: error.message };
    }
  });

  // Save rendered waveform image to disk
  ipcMain.handle('video-editor:save-waveform-image', async (event, videoPath, imageKey, dataUrl) => {
    try {
      const path = await import('path');
      const fs = await import('fs/promises');

      const videoDir = path.dirname(videoPath);
      const videoName = path.basename(videoPath, path.extname(videoPath));
      const imagePath = path.join(videoDir, `.${videoName}.waveform-${imageKey}.png`);

      // Convert dataURL to buffer
      const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
      await fs.writeFile(imagePath, base64Data, 'base64');
      log.info('video', 'Waveform image saved', { imagePath });
      return { success: true, imagePath };
    } catch (error) {
      log.error('video', 'Save waveform image error', { error: error.message });
      return { error: error.message };
    }
  });

  // Load rendered waveform image from disk
  ipcMain.handle('video-editor:load-waveform-image', async (event, videoPath, imageKey) => {
    try {
      const path = await import('path');
      const fs = await import('fs/promises');

      const videoDir = path.dirname(videoPath);
      const videoName = path.basename(videoPath, path.extname(videoPath));
      const imagePath = path.join(videoDir, `.${videoName}.waveform-${imageKey}.png`);

      // Check if image exists
      try {
        await fs.access(imagePath);
      } catch {
        return { exists: false };
      }

      const imageBuffer = await fs.readFile(imagePath);
      const dataUrl = `data:image/png;base64,${imageBuffer.toString('base64')}`;
      log.info('video', 'Waveform image loaded', { imagePath });
      return { exists: true, dataUrl };
    } catch (error) {
      log.error('video', 'Load waveform image error', { error: error.message });
      return { exists: false, error: error.message };
    }
  });

  // Delete all waveform cache files for a video
  ipcMain.handle('video-editor:delete-waveform-cache', async (event, videoPath) => {
    try {
      const path = await import('path');
      const fs = await import('fs/promises');

      const videoDir = path.dirname(videoPath);
      const videoName = path.basename(videoPath, path.extname(videoPath));

      // Find all waveform cache files for this video
      const files = await fs.readdir(videoDir);
      const cacheFiles = files.filter(
        (f) => f.startsWith(`.${videoName}.waveform-`) && (f.endsWith('.json') || f.endsWith('.png'))
      );

      let deleted = 0;
      for (const file of cacheFiles) {
        const filePath = path.join(videoDir, file);
        try {
          await fs.unlink(filePath);
          deleted++;
          log.info('video', 'Deleted waveform cache file', { file });
        } catch (e) {
          log.warn('video', 'Could not delete waveform cache file', { file, error: e.message });
        }
      }

      log.info('video', 'Deleted waveform cache files', { deleted });
      return { success: true, deleted };
    } catch (error) {
      log.error('video', 'Delete waveform cache error', { error: error.message });
      return { error: error.message };
    }
  });

  // ==================== THUMBNAIL CACHE ====================

  // Save thumbnail cache metadata to disk
  ipcMain.handle('video-editor:save-thumbnail-cache', async (event, videoPath, cacheData) => {
    try {
      const path = await import('path');
      const fs = await import('fs/promises');

      const videoDir = path.dirname(videoPath);
      const videoName = path.basename(videoPath, path.extname(videoPath));
      const cachePath = path.join(videoDir, `.${videoName}.thumbnail-cache.json`);

      await fs.writeFile(cachePath, JSON.stringify(cacheData), 'utf8');
      log.info('video', 'Thumbnail cache saved', { cachePath });
      return { success: true, cachePath };
    } catch (error) {
      log.error('video', 'Save thumbnail cache error', { error: error.message });
      return { error: error.message };
    }
  });

  // Load thumbnail cache from disk
  ipcMain.handle('video-editor:load-thumbnail-cache', async (event, videoPath) => {
    try {
      const path = await import('path');
      const fs = await import('fs/promises');

      const videoDir = path.dirname(videoPath);
      const videoName = path.basename(videoPath, path.extname(videoPath));
      const cachePath = path.join(videoDir, `.${videoName}.thumbnail-cache.json`);

      // Check if cache exists
      try {
        await fs.access(cachePath);
      } catch {
        return { exists: false };
      }

      const data = await fs.readFile(cachePath, 'utf8');
      const cacheData = JSON.parse(data);
      log.info('video', 'Thumbnail cache loaded', { cachePath });
      return { exists: true, ...cacheData };
    } catch (error) {
      log.error('video', 'Load thumbnail cache error', { error: error.message });
      return { exists: false, error: error.message };
    }
  });

  // Save thumbnail strip image to disk (actual JPEG image)
  ipcMain.handle('video-editor:save-thumbnail-strip', async (event, videoPath, tierName, dataUrl) => {
    try {
      const path = await import('path');
      const fs = await import('fs/promises');

      const videoDir = path.dirname(videoPath);
      const videoName = path.basename(videoPath, path.extname(videoPath));
      const imagePath = path.join(videoDir, `.${videoName}.thumbstrip-${tierName}.jpg`);

      // Convert dataURL to buffer
      const base64Data = dataUrl.replace(/^data:image\/jpeg;base64,/, '').replace(/^data:image\/png;base64,/, '');
      await fs.writeFile(imagePath, base64Data, 'base64');
      log.info('video', 'Thumbnail strip saved', { imagePath });
      return { success: true, imagePath };
    } catch (error) {
      log.error('video', 'Save thumbnail strip error', { error: error.message });
      return { error: error.message };
    }
  });

  // Load thumbnail strip image from disk
  ipcMain.handle('video-editor:load-thumbnail-strip', async (event, videoPath, tierName) => {
    try {
      const path = await import('path');
      const fs = await import('fs/promises');

      const videoDir = path.dirname(videoPath);
      const videoName = path.basename(videoPath, path.extname(videoPath));
      const imagePath = path.join(videoDir, `.${videoName}.thumbstrip-${tierName}.jpg`);

      // Check if image exists
      try {
        await fs.access(imagePath);
      } catch {
        return { exists: false };
      }

      const imageBuffer = await fs.readFile(imagePath);
      const dataUrl = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;
      log.info('video', 'Thumbnail strip loaded', { imagePath });
      return { exists: true, dataUrl };
    } catch (error) {
      log.error('video', 'Load thumbnail strip error', { error: error.message });
      return { exists: false, error: error.message };
    }
  });

  // ==================== EDITING OPERATIONS ====================

  ipcMain.handle('video-editor:trim', async (event, videoPath, options) => {
    try {
      return await videoEditor.trimVideo(videoPath, options, (progress) => {
        mainWindow?.webContents.send('video-editor:progress', progress);
      });
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('video-editor:transcode', async (event, videoPath, options) => {
    try {
      return await videoEditor.transcodeVideo(videoPath, options, (progress) => {
        mainWindow?.webContents.send('video-editor:progress', progress);
      });
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('video-editor:extract-audio', async (event, videoPath, options) => {
    try {
      return await videoEditor.extractAudio(videoPath, options, (progress) => {
        mainWindow?.webContents.send('video-editor:progress', progress);
      });
    } catch (error) {
      return { error: error.message };
    }
  });

  // ==================== AUDIO CACHE FOR GUIDE/MASTER TRACKS ====================

  // Check if cached audio exists for a video
  ipcMain.handle('video-editor:check-audio-cache', async (event, videoPath) => {
    try {
      const path = await import('path');
      const fs = await import('fs/promises');

      const videoDir = path.dirname(videoPath);
      const videoName = path.basename(videoPath, path.extname(videoPath));
      const cachePath = path.join(videoDir, `.${videoName}-audio-cache.aac`);

      try {
        const stats = await fs.stat(cachePath);
        log.info('video', 'Audio cache found', { cachePath });
        return { exists: true, path: cachePath, size: stats.size };
      } catch {
        return { exists: false };
      }
    } catch (error) {
      log.error('video', 'Check audio cache error', { error: error.message });
      return { exists: false, error: error.message };
    }
  });

  // Extract audio with caching (check cache first, extract if missing)
  ipcMain.handle('video-editor:extract-audio-cached', async (event, videoPath) => {
    try {
      const path = await import('path');
      const fs = await import('fs/promises');

      const videoDir = path.dirname(videoPath);
      const videoName = path.basename(videoPath, path.extname(videoPath));
      const cachePath = path.join(videoDir, `.${videoName}-audio-cache.aac`);

      // Check if cache exists
      try {
        const stats = await fs.stat(cachePath);
        log.info('video', 'Using cached audio', { cachePath });
        return { success: true, path: cachePath, cached: true, size: stats.size };
      } catch {
        // Cache miss - need to extract
      }

      log.info('video', 'Cache miss, extracting audio to', { cachePath });

      // Extract audio using codec copy for speed (no re-encoding)
      const result = await videoEditor.extractAudio(
        videoPath,
        {
          outputPath: cachePath,
          format: 'aac',
          codec: 'copy', // Fast - just copy audio stream
        },
        (progress) => {
          mainWindow?.webContents.send('video-editor:extraction-progress', progress);
        }
      );

      if (result.error) {
        // If codec copy fails (incompatible format), try with re-encoding
        log.info('video', 'Codec copy failed, re-encoding...');
        const reencodeResult = await videoEditor.extractAudio(
          videoPath,
          {
            outputPath: cachePath,
            format: 'aac',
            audioBitrate: '192k',
          },
          (progress) => {
            mainWindow?.webContents.send('video-editor:extraction-progress', progress);
          }
        );

        if (reencodeResult.error) {
          return { success: false, error: reencodeResult.error };
        }
      }

      const stats = await fs.stat(cachePath);
      log.info('video', 'Audio extracted and cached', { cachePath });
      return { success: true, path: cachePath, cached: false, size: stats.size };
    } catch (error) {
      log.error('video', 'Extract audio cached error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // ==================== END AUDIO CACHE ====================

  ipcMain.handle('video-editor:compress', async (event, videoPath, options) => {
    try {
      return await videoEditor.compressVideo(videoPath, options, (progress) => {
        mainWindow?.webContents.send('video-editor:progress', progress);
      });
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('video-editor:change-speed', async (event, videoPath, options) => {
    try {
      return await videoEditor.changeSpeed(videoPath, options, (progress) => {
        mainWindow?.webContents.send('video-editor:progress', progress);
      });
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('video-editor:reverse', async (event, videoPath, options) => {
    try {
      return await videoEditor.reverseVideo(videoPath, options, (progress) => {
        mainWindow?.webContents.send('video-editor:progress', progress);
      });
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('video-editor:splice', async (event, videoPath, options) => {
    try {
      return await videoEditor.spliceVideo(videoPath, options, (progress) => {
        mainWindow?.webContents.send('video-editor:progress', progress);
      });
    } catch (error) {
      return { error: error.message };
    }
  });

  // ==================== EXPORT OPERATIONS ====================

  ipcMain.handle('video-editor:export-playlist', async (event, videoPath, options) => {
    try {
      return await videoEditor.exportPlaylist(videoPath, options);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('video-editor:build-playlist-ai', async (event, options) => {
    try {
      return await videoEditor.buildPlaylistWithAI(options);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('video-editor:transcribe-range', async (event, videoPath, options) => {
    // Uses OpenAI Whisper API for transcription with word-level timestamps
    // Sends progress updates as each chunk completes
    try {
      log.info('video', 'Transcribe range called', { videoPath, options });

      // Progress callback to send updates to renderer
      const onChunkComplete = (progressData) => {
        try {
          event.sender.send('video-editor:transcription-progress', progressData);
        } catch (e) {
          log.warn('video', 'Could not send progress', { error: e.message });
        }
      };

      return await videoEditor.transcribeRange(videoPath, { ...options, onChunkComplete });
    } catch (error) {
      log.error('video', 'Transcribe error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // Generate scene description from transcript using LLM
  ipcMain.handle('video-editor:generate-scene-description', async (event, options) => {
    try {
      const { transcript, timeContext, videoName, existingDescription } = options;

      if (!transcript || transcript.trim().length === 0) {
        return { success: false, error: 'No transcript provided' };
      }

      // Get API key from settings
      const { getSettingsManager } = await import('../../../settings-manager.js');
      const settingsManager = getSettingsManager();
      const apiKey = settingsManager.get('llmApiKey');
      const provider = settingsManager.get('llmProvider') || 'anthropic';
      const model = settingsManager.get('llmModel') || 'claude-sonnet-4-5-20250929';

      if (!apiKey) {
        return { success: false, error: 'No LLM API key configured. Please set your API key in Settings.' };
      }

      log.info('video', 'Generating scene description', { provider, model });

      // Build prompt
      const prompt = `You are a professional video editor's assistant. Analyze the following transcript from a video segment and write a concise, descriptive scene description.

Video: ${videoName}
${timeContext}

Transcript:
"${transcript}"

${existingDescription ? `\nExisting description (enhance or replace):\n"${existingDescription}"` : ''}

Write a brief (1-3 sentences) scene description that:
- Describes what's happening in this segment
- Captures the key topic, action, or moment
- Is suitable for use as a scene marker description in video editing software
- Focuses on the essence/purpose of this segment

Respond with ONLY the description text, no quotes or additional formatting.`;

      let description;

      // Use centralized AI service
      const result = await ai.chat({
        profile: provider === 'anthropic' || apiKey.startsWith('sk-ant-') ? 'standard' : 'fast',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 500,
        feature: 'video-editor-ipc',
      });

      description = result.content.trim();

      if (!description) {
        throw new Error('Empty response from LLM');
      }

      log.info('video', 'Generated scene description', { descriptionPreview: description.substring(0, 100) });

      return { success: true, description };
    } catch (error) {
      log.error('video', 'Generate scene description error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('video-editor:generate-screengrabs', async (event, videoPath, options) => {
    try {
      return await videoEditor.generateRangeScreengrabs(videoPath, options);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('video-editor:open-folder', async (event, folderPath) => {
    try {
      await shell.openPath(folderPath);
      return { success: true };
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('video-editor:watermark', async (event, videoPath, watermarkPath, options) => {
    try {
      return await videoEditor.addWatermark(videoPath, watermarkPath, options, (progress) => {
        mainWindow?.webContents.send('video-editor:progress', progress);
      });
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('video-editor:concatenate', async (event, videoPaths, options) => {
    try {
      return await videoEditor.concatenateVideos(videoPaths, options, (progress) => {
        mainWindow?.webContents.send('video-editor:progress', progress);
      });
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('video-editor:slideshow', async (event, imagePaths, options) => {
    try {
      return await videoEditor.createSlideshow(imagePaths, options, (progress) => {
        mainWindow?.webContents.send('video-editor:progress', progress);
      });
    } catch (error) {
      return { error: error.message };
    }
  });

  // ==================== AUDIO-TO-VIDEO ====================

  ipcMain.handle('video-editor:create-video-from-audio', async (event, audioPath, options) => {
    try {
      log.info('video', 'Creating video from audio', { audioPath });
      return await videoEditor.createVideoFromAudio(audioPath, options, (progress) => {
        mainWindow?.webContents.send('video-editor:progress', progress);
      });
    } catch (error) {
      log.error('video', 'Audio-to-video error', { error: error.message });
      return { error: error.message };
    }
  });

  // Select single image file
  ipcMain.handle('video-editor:select-image', async (_event) => {
    try {
      const { dialog } = await import('electron');
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select Image',
        filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] }],
        properties: ['openFile'],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true };
      }

      return { filePath: result.filePaths[0] };
    } catch (error) {
      log.error('video', 'Select image error', { error: error.message });
      return { error: error.message };
    }
  });

  // Select multiple image files
  ipcMain.handle('video-editor:select-images', async (_event) => {
    try {
      const { dialog } = await import('electron');
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select Images for Slideshow',
        filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] }],
        properties: ['openFile', 'multiSelections'],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true };
      }

      return { filePaths: result.filePaths };
    } catch (error) {
      log.error('video', 'Select images error', { error: error.message });
      return { error: error.message };
    }
  });

  // ==================== ELEVENLABS ====================

  ipcMain.handle('video-editor:check-elevenlabs-key', async () => {
    try {
      // Check environment variable first
      if (process.env.ELEVENLABS_API_KEY) {
        return { hasKey: true };
      }

      // Check settings manager
      const { getSettingsManager } = await import('../../../settings-manager.js');
      const settingsManager = getSettingsManager();
      const apiKey = settingsManager.get('elevenLabsApiKey');

      return { hasKey: !!apiKey && apiKey.trim() !== '' };
    } catch (error) {
      log.error('video', 'Check ElevenLabs key error', { error: error.message });
      return { hasKey: false, error: error.message };
    }
  });

  ipcMain.handle('video-editor:replace-audio-elevenlabs', async (event, videoPath, options) => {
    try {
      return await videoEditor.replaceAudioWithElevenLabs(videoPath, options, (progress) => {
        mainWindow?.webContents.send('video-editor:progress', progress);
      });
    } catch (error) {
      log.error('video', 'ElevenLabs error', { error: error.message });
      return { error: error.message };
    }
  });

  // Generate ElevenLabs audio only (non-destructive - no video processing)
  ipcMain.handle('video-editor:generate-elevenlabs-audio', async (event, options) => {
    try {
      log.info('video', 'Generating ElevenLabs audio only', { textPreview: options.text?.substring(0, 50) });
      return await videoEditor.generateElevenLabsAudioOnly(options, (progress) => {
        mainWindow?.webContents.send('video-editor:progress', progress);
      });
    } catch (error) {
      log.error('video', 'ElevenLabs generate error', { error: error.message });
      return { error: error.message };
    }
  });

  // Export video with all audio replacements applied at once
  ipcMain.handle('video-editor:export-with-audio-replacements', async (event, videoPath, replacements) => {
    try {
      log.info('video', 'Exporting with audio replacements', { count: replacements.length });
      return await videoEditor.exportWithAudioReplacements(videoPath, replacements, (progress) => {
        mainWindow?.webContents.send('video-editor:progress', progress);
      });
    } catch (error) {
      log.error('video', 'Export with replacements error', { error: error.message });
      return { error: error.message };
    }
  });

  // ==================== ELEVENLABS NEW APIS ====================

  // Generate sound effect from text prompt
  ipcMain.handle('video-editor:generate-sfx', async (event, options) => {
    try {
      log.info('video', 'Generating SFX', { promptPreview: options.prompt?.substring(0, 50) });
      const audioPath = await videoEditor.elevenLabsService.generateSoundEffect(
        options.prompt,
        { durationSeconds: options.durationSeconds, promptInfluence: options.promptInfluence },
        { projectId: options.projectId }
      );
      return { success: true, audioPath };
    } catch (error) {
      log.error('video', 'Generate SFX error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // Generate music from text prompt using Eleven Music
  ipcMain.handle('video-editor:generate-music', async (event, options) => {
    try {
      log.info('video', 'Generating music', { promptPreview: options.prompt?.substring(0, 50) });
      const audioPath = await videoEditor.elevenLabsService.generateMusic(
        options.prompt,
        {
          durationMs: options.durationMs,
          instrumental: options.instrumental !== false,
          modelId: options.modelId,
        },
        { projectId: options.projectId }
      );
      return { success: true, audioPath };
    } catch (error) {
      log.error('video', 'Generate music error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // Get music composition plan/suggestions
  ipcMain.handle('video-editor:get-music-plan', async (event, options) => {
    try {
      log.info('video', 'Getting music plan', { promptPreview: options.prompt?.substring(0, 50) });
      const plan = await videoEditor.elevenLabsService.getMusicCompositionPlan(options.prompt, {
        durationMs: options.durationMs,
      });
      return { success: true, plan };
    } catch (error) {
      log.error('video', 'Get music plan error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // Get AI-generated audio suggestions (music or SFX) for a marker
  ipcMain.handle('video-editor:get-audio-suggestions', async (event, options) => {
    try {
      const { marker, type } = options;
      log.info('video', 'Getting audio suggestions', { markerName: marker?.name, type });

      // Use centralized AI service instead of deprecated openai-api.js
      const ai = require('../../../lib/ai-service');

      const duration = marker.duration || marker.outTime - marker.inTime || 10;
      const durationStr = duration.toFixed(1);
      const context = {
        name: marker.name || 'Untitled Scene',
        description: marker.description || '',
        transcription: marker.transcription || '',
        tags: (marker.tags || []).join(', '),
        duration: durationStr,
      };

      const prompt =
        type === 'music'
          ? `You are a professional music supervisor for film and video. Based on the scene context below, suggest 5 different music options that would work well as background music.\n\nSCENE CONTEXT:\n- Scene Name: ${context.name}\n- Description: ${context.description || 'No description provided'}\n- Transcript/Dialogue: ${context.transcription || 'No dialogue'}\n- Tags: ${context.tags || 'None'}\n- Duration: ${context.duration} seconds\n\nGenerate 5 diverse music suggestions. Each suggestion should be distinctly different in style, mood, or genre.\n\nRespond with valid JSON only:\n{"suggestions":[{"id":1,"title":"Short title","prompt":"Detailed prompt for AI music generation","description":"Why this works","genre":"Genre","mood":"Mood","tempo":"slow|medium|fast","instrumental":true}]}`
          : `You are a professional sound designer for film and video. Based on the scene context below, suggest 5 different sound effect options.\n\nSCENE CONTEXT:\n- Scene Name: ${context.name}\n- Description: ${context.description || 'No description provided'}\n- Transcript/Dialogue: ${context.transcription || 'No dialogue'}\n- Tags: ${context.tags || 'None'}\n- Duration: ${context.duration} seconds\n\nGenerate 5 diverse sound effect suggestions.\n\nRespond with valid JSON only:\n{"suggestions":[{"id":1,"title":"Short title","prompt":"Detailed sound description","description":"Why this works","category":"Category","layers":["layer1"]}]}`;

      const result = await ai.json(prompt, {
        profile: 'fast',
        maxTokens: 2000,
        feature: 'video-audio-suggestions',
      });

      const suggestions = result.suggestions || [];
      return { success: true, suggestions };
    } catch (error) {
      log.error('video', 'Get audio suggestions error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // Speech-to-Speech voice transformation
  ipcMain.handle('video-editor:speech-to-speech', async (event, options) => {
    try {
      log.info('video', 'Speech-to-Speech', { audioPath: options.audioPath });
      const audioPath = await videoEditor.elevenLabsService.speechToSpeech(
        options.audioPath,
        options.voiceId,
        { stability: options.stability, similarityBoost: options.similarityBoost },
        { projectId: options.projectId }
      );
      return { success: true, audioPath };
    } catch (error) {
      log.error('video', 'Speech-to-Speech error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // Audio isolation (remove background noise)
  ipcMain.handle('video-editor:isolate-audio', async (event, audioPath, options = {}) => {
    try {
      log.info('video', 'Isolating audio', { audioPath });
      const isolatedPath = await videoEditor.elevenLabsService.isolateAudio(audioPath, {
        projectId: options.projectId,
      });
      return { success: true, audioPath: isolatedPath };
    } catch (error) {
      log.error('video', 'Isolate audio error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // Create dubbing project
  ipcMain.handle('video-editor:create-dubbing', async (event, options) => {
    try {
      log.info('video', 'Creating dubbing project', { videoPath: options.videoPath });
      const result = await videoEditor.elevenLabsService.createDubbingProject(
        options.videoPath,
        options.targetLanguages,
        {
          sourceLanguage: options.sourceLanguage,
          numSpeakers: options.numSpeakers,
          watermark: options.watermark,
          projectName: options.projectName,
        },
        { projectId: options.projectId }
      );
      return { success: true, ...result };
    } catch (error) {
      log.error('video', 'Create dubbing error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // Get dubbing project status
  ipcMain.handle('video-editor:get-dubbing-status', async (event, dubbingId) => {
    try {
      const result = await videoEditor.elevenLabsService.getDubbingStatus(dubbingId);
      return { success: true, ...result };
    } catch (error) {
      log.error('video', 'Get dubbing status error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // Download dubbed audio
  ipcMain.handle('video-editor:download-dubbed-audio', async (event, dubbingId, languageCode) => {
    try {
      const audioPath = await videoEditor.elevenLabsService.downloadDubbedAudio(dubbingId, languageCode);
      return { success: true, audioPath };
    } catch (error) {
      log.error('video', 'Download dubbed audio error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // List all available voices (dynamic)
  ipcMain.handle('video-editor:list-voices', async () => {
    try {
      const voices = await videoEditor.elevenLabsService.listVoices();
      return { success: true, voices };
    } catch (error) {
      log.error('video', 'List voices error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // Get user subscription info (quota/limits)
  ipcMain.handle('video-editor:get-subscription', async () => {
    try {
      const subscription = await videoEditor.elevenLabsService.getUserSubscription();
      return { success: true, subscription };
    } catch (error) {
      log.error('video', 'Get subscription error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // Get user info
  ipcMain.handle('video-editor:get-user-info', async () => {
    try {
      const user = await videoEditor.elevenLabsService.getUserInfo();
      return { success: true, user };
    } catch (error) {
      log.error('video', 'Get user info error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // Get usage statistics
  ipcMain.handle('video-editor:get-usage-stats', async (event, options = {}) => {
    try {
      const stats = await videoEditor.elevenLabsService.getUsageStats(options);
      return { success: true, stats };
    } catch (error) {
      log.error('video', 'Get usage stats error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // ==================== ELEVENLABS SCRIBE TRANSCRIPTION ====================

  // Transcribe audio using ElevenLabs Scribe (replaces Whisper for transcription)
  ipcMain.handle('video-editor:transcribe-scribe', async (event, audioPath, options = {}) => {
    try {
      log.info('video', 'Transcribe with Scribe called', { audioPath });
      const result = await videoEditor.elevenLabsService.transcribeAudio(audioPath, options);
      log.info('video', 'Scribe transcription complete', { wordCount: result.words?.length || 0 });
      return { success: true, ...result };
    } catch (error) {
      log.error('video', 'Scribe transcription error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // ==================== JOB MANAGEMENT ====================

  ipcMain.handle('video-editor:cancel', async (event, jobId) => {
    return videoEditor.cancelJob(jobId);
  });

  ipcMain.handle('video-editor:get-exports', async () => {
    return videoEditor.getExportedFiles();
  });

  ipcMain.handle('video-editor:get-output-dir', async () => {
    return videoEditor.outputDir;
  });

  ipcMain.handle('video-editor:reveal-file', async (event, filePath) => {
    try {
      shell.showItemInFolder(filePath);
      return { success: true };
    } catch (error) {
      return { error: error.message };
    }
  });

  // ==================== TWO-STEP WORKFLOW ====================

  ipcMain.handle('video-editor:process-edit-list', async (event, videoPath, editList, options) => {
    try {
      return await videoEditor.processEditList(videoPath, editList, options, (progress) => {
        mainWindow?.webContents.send('video-editor:progress', progress);
      });
    } catch (error) {
      log.error('video', 'Edit list error', { error: error.message });
      return { error: error.message };
    }
  });

  ipcMain.handle('video-editor:finalize-workflow', async (event, spaceItemId, editedVideoPath, scenes) => {
    try {
      // Note: clipboardManager needs to be passed from main.js
      const clipboardManager = global.clipboardManager;
      return await videoEditor.finalizeVideoWorkflow(spaceItemId, editedVideoPath, scenes, clipboardManager);
    } catch (error) {
      log.error('video', 'Finalize error', { error: error.message });
      return { error: error.message };
    }
  });

  ipcMain.handle('video-editor:detect-scenes', async (event, videoPath, options) => {
    try {
      return await videoEditor.detectScenes(videoPath, options);
    } catch (error) {
      log.error('video', 'Scene detection error', { error: error.message });
      return { error: error.message };
    }
  });

  // ==================== TRANSLATION PIPELINE ====================

  ipcMain.handle('video-editor:translate-with-quality', async (event, sourceText, options) => {
    try {
      return await videoEditor.translateWithQualityLoop(sourceText, options);
    } catch (error) {
      log.error('video', 'Translation error', { error: error.message });
      return { error: error.message };
    }
  });

  ipcMain.handle('video-editor:translate-text', async (event, sourceText, options) => {
    try {
      const { openaiKey } = videoEditor.getApiKeys ? videoEditor.getApiKeys() : {};
      if (!openaiKey) {
        return { error: 'OpenAI API key not configured' };
      }
      return await videoEditor.translateText(sourceText, options, openaiKey);
    } catch (error) {
      log.error('video', 'Translation error', { error: error.message });
      return { error: error.message };
    }
  });

  ipcMain.handle('video-editor:evaluate-translation', async (event, sourceText, translatedText, options) => {
    try {
      const { openaiKey, anthropicKey } = videoEditor.getApiKeys ? videoEditor.getApiKeys() : {};
      if (!openaiKey && !anthropicKey) {
        return { error: 'No API key configured for evaluation' };
      }
      return await videoEditor.evaluateTranslation(sourceText, translatedText, options, anthropicKey || openaiKey);
    } catch (error) {
      log.error('video', 'Evaluation error', { error: error.message });
      return { error: error.message };
    }
  });

  // ==================== SPACE VIDEO OPERATIONS ====================

  ipcMain.handle('video-editor:get-space-video', async (event, itemId) => {
    try {
      const clipboardManager = global.clipboardManager;
      if (!clipboardManager) {
        return { error: 'Clipboard manager not available' };
      }

      const item = clipboardManager.storage.loadItem(itemId);
      if (!item) {
        return { error: 'Item not found' };
      }

      // Get video path and metadata
      const videoPath = item.content;
      const metadataPath = item.metadataPath
        ? require('path').join(clipboardManager.storage.storageRoot, item.metadataPath)
        : null;

      let metadata = {};
      if (metadataPath && require('fs').existsSync(metadataPath)) {
        metadata = JSON.parse(require('fs').readFileSync(metadataPath, 'utf8'));
      }

      return {
        success: true,
        videoPath,
        scenes: metadata.scenes || [],
        metadata,
      };
    } catch (error) {
      log.error('video', 'Get space video error', { error: error.message });
      return { error: error.message };
    }
  });

  ipcMain.handle('video-editor:save-scenes-only', async (event, itemId, scenes) => {
    try {
      const clipboardManager = global.clipboardManager;
      if (!clipboardManager) {
        return { error: 'Clipboard manager not available' };
      }

      const item = clipboardManager.storage.loadItem(itemId);
      if (!item) {
        return { error: 'Item not found' };
      }

      // Update metadata with scenes
      const metadataPath = require('path').join(clipboardManager.storage.storageRoot, item.metadataPath);
      let metadata = {};
      if (require('fs').existsSync(metadataPath)) {
        metadata = JSON.parse(require('fs').readFileSync(metadataPath, 'utf8'));
      }

      metadata.scenes = scenes;
      metadata.scenesUpdatedAt = new Date().toISOString();

      require('fs').writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

      return { success: true, scenesCount: scenes.length };
    } catch (error) {
      log.error('video', 'Save scenes error', { error: error.message });
      return { error: error.message };
    }
  });

  // ==================== RELEASE & VERSIONING ====================

  // Get release options for current project
  ipcMain.handle('video-editor:get-release-options', async (_event) => {
    try {
      const { ReleaseManager } = await import('../release/ReleaseManager.js');
      const releaseManager = new ReleaseManager();

      // Get current project path from global state
      const projectPath = global.currentVideoProjectPath;
      if (!projectPath) {
        return { branches: [], summary: { totalBranches: 0 } };
      }

      return await releaseManager.getReleaseOptions(projectPath);
    } catch (error) {
      log.error('video', 'Get release options error', { error: error.message });
      return { error: error.message };
    }
  });

  // Release current video (without project/branch system)
  ipcMain.handle('video-editor:release-current-video', async (event, videoPath, destination, metadata) => {
    try {
      const { ReleaseManager } = await import('../release/ReleaseManager.js');
      const releaseManager = new ReleaseManager();

      // For current video release, we use a simplified flow
      const result = await releaseManager._releaseVideoDirectly(videoPath, destination, metadata, (progress) => {
        mainWindow?.webContents.send('video-editor:release-progress', progress);
      });

      return result;
    } catch (error) {
      log.error('video', 'Release current video error', { error: error.message });
      return { error: error.message };
    }
  });

  // Release a specific branch
  ipcMain.handle('video-editor:release-branch', async (event, branchId, destination, metadata) => {
    try {
      const { ReleaseManager } = await import('../release/ReleaseManager.js');
      const releaseManager = new ReleaseManager();

      const projectPath = global.currentVideoProjectPath;
      if (!projectPath) {
        return { error: 'No project loaded' };
      }

      const result = await releaseManager.startRelease(projectPath, branchId, destination, metadata, (progress) => {
        mainWindow?.webContents.send('video-editor:release-progress', progress);
      });

      return result;
    } catch (error) {
      log.error('video', 'Release branch error', { error: error.message });
      return { error: error.message };
    }
  });

  // Get upload service status (YouTube/Vimeo)
  ipcMain.handle('video-editor:get-upload-service-status', async (event, service) => {
    try {
      if (service === 'youtube') {
        const { YouTubeUploader } = await import('../release/YouTubeUploader.js');
        const uploader = new YouTubeUploader();
        return await uploader.getConnectionStatus();
      } else if (service === 'vimeo') {
        const { VimeoUploader } = await import('../release/VimeoUploader.js');
        const uploader = new VimeoUploader();
        return await uploader.getConnectionStatus();
      }
      return { error: 'Unknown service' };
    } catch (error) {
      log.error('video', 'Get upload service status error', { error: error.message });
      return { error: error.message };
    }
  });

  // Authenticate upload service
  ipcMain.handle('video-editor:authenticate-upload-service', async (event, service) => {
    try {
      if (service === 'youtube') {
        const { YouTubeUploader } = await import('../release/YouTubeUploader.js');
        const uploader = new YouTubeUploader();
        return await uploader.authenticate();
      } else if (service === 'vimeo') {
        const { VimeoUploader } = await import('../release/VimeoUploader.js');
        const uploader = new VimeoUploader();
        return await uploader.authenticate();
      }
      return { error: 'Unknown service' };
    } catch (error) {
      log.error('video', 'Authenticate upload service error', { error: error.message });
      return { error: error.message };
    }
  });

  // ==================== VERSION MANAGEMENT ====================

  // Create new project
  ipcMain.handle('video-editor:create-project', async (event, sourceVideoPath, projectName) => {
    try {
      const { VersionManager } = await import('../versioning/VersionManager.js');
      const versionManager = new VersionManager();
      const result = await versionManager.createProject(sourceVideoPath, projectName);
      global.currentVideoProjectPath = result.projectPath;
      return result;
    } catch (error) {
      log.error('video', 'Create project error', { error: error.message });
      return { error: error.message };
    }
  });

  // Get all projects
  ipcMain.handle('video-editor:get-projects', async (_event) => {
    try {
      const { VersionManager } = await import('../versioning/VersionManager.js');
      const versionManager = new VersionManager();
      return versionManager.getAllProjects();
    } catch (error) {
      log.error('video', 'Get projects error', { error: error.message });
      return { error: error.message };
    }
  });

  // Create branch
  ipcMain.handle('video-editor:create-branch', async (event, name, type, forkFromBranch, forkFromVersion) => {
    try {
      const { VersionManager } = await import('../versioning/VersionManager.js');
      const versionManager = new VersionManager();

      const projectPath = global.currentVideoProjectPath;
      if (!projectPath) {
        return { error: 'No project loaded' };
      }

      return await versionManager.createBranch(projectPath, {
        name,
        type,
        forkFromBranch,
        forkFromVersion,
      });
    } catch (error) {
      log.error('video', 'Create branch error', { error: error.message });
      return { error: error.message };
    }
  });

  // Get branches
  ipcMain.handle('video-editor:get-branches', async (_event) => {
    try {
      const { VersionManager } = await import('../versioning/VersionManager.js');
      const versionManager = new VersionManager();

      const projectPath = global.currentVideoProjectPath;
      if (!projectPath) {
        return [];
      }

      return versionManager.getBranches(projectPath);
    } catch (error) {
      log.error('video', 'Get branches error', { error: error.message });
      return { error: error.message };
    }
  });

  // Save version
  ipcMain.handle('video-editor:save-version', async (event, branchId, edlData, message) => {
    try {
      const { VersionManager } = await import('../versioning/VersionManager.js');
      const versionManager = new VersionManager();

      const projectPath = global.currentVideoProjectPath;
      if (!projectPath) {
        return { error: 'No project loaded' };
      }

      return await versionManager.saveVersion(projectPath, branchId, edlData, message);
    } catch (error) {
      log.error('video', 'Save version error', { error: error.message });
      return { error: error.message };
    }
  });

  // Load EDL
  ipcMain.handle('video-editor:load-edl', async (event, branchId, version) => {
    try {
      const { VersionManager } = await import('../versioning/VersionManager.js');
      const versionManager = new VersionManager();

      const projectPath = global.currentVideoProjectPath;
      if (!projectPath) {
        return { error: 'No project loaded' };
      }

      return versionManager.loadEDL(projectPath, branchId, version);
    } catch (error) {
      log.error('video', 'Load EDL error', { error: error.message });
      return { error: error.message };
    }
  });

  // ==================== ELEVENLABS STUDIO PROJECTS ====================

  // Create a Studio project
  ipcMain.handle('video-editor:elevenlabs-create-studio-project', async (event, name, options = {}) => {
    try {
      log.info('video', 'Creating ElevenLabs Studio project', { name });
      const result = await videoEditor.elevenLabsService.createStudioProject(name, options);
      return { success: true, ...result };
    } catch (error) {
      log.error('video', 'Create Studio project error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // Get a Studio project
  ipcMain.handle('video-editor:elevenlabs-get-studio-project', async (event, projectId) => {
    try {
      const result = await videoEditor.elevenLabsService.getStudioProject(projectId);
      return { success: true, project: result };
    } catch (error) {
      log.error('video', 'Get Studio project error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // List Studio projects
  ipcMain.handle('video-editor:elevenlabs-list-studio-projects', async () => {
    try {
      const projects = await videoEditor.elevenLabsService.listStudioProjects();
      return { success: true, projects };
    } catch (error) {
      log.error('video', 'List Studio projects error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // Delete a Studio project
  ipcMain.handle('video-editor:elevenlabs-delete-studio-project', async (event, projectId) => {
    try {
      log.info('video', 'Deleting ElevenLabs Studio project', { projectId });
      await videoEditor.elevenLabsService.deleteStudioProject(projectId);
      return { success: true };
    } catch (error) {
      log.error('video', 'Delete Studio project error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // ==================== ELEVENLABS VOICE CLONING ====================

  // Clone a voice from audio samples
  ipcMain.handle('video-editor:elevenlabs-clone-voice', async (event, name, audioFilePaths, options = {}) => {
    try {
      log.info('video', 'Cloning voice', { name, sampleCount: audioFilePaths.length });
      const result = await videoEditor.elevenLabsService.cloneVoice(name, audioFilePaths, options);
      return { success: true, ...result };
    } catch (error) {
      log.error('video', 'Clone voice error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // Delete a voice
  ipcMain.handle('video-editor:elevenlabs-delete-voice', async (event, voiceId) => {
    try {
      log.info('video', 'Deleting voice', { voiceId });
      await videoEditor.elevenLabsService.deleteVoice(voiceId);
      return { success: true };
    } catch (error) {
      log.error('video', 'Delete voice error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // Edit voice settings
  ipcMain.handle('video-editor:elevenlabs-edit-voice', async (event, voiceId, updates) => {
    try {
      log.info('video', 'Editing voice', { voiceId });
      const result = await videoEditor.elevenLabsService.editVoice(voiceId, updates);
      return { success: true, voice: result };
    } catch (error) {
      log.error('video', 'Edit voice error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // Get voice details
  ipcMain.handle('video-editor:elevenlabs-get-voice', async (event, voiceId) => {
    try {
      const result = await videoEditor.elevenLabsService.getVoice(voiceId);
      return { success: true, voice: result };
    } catch (error) {
      log.error('video', 'Get voice error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // ==================== ELEVENLABS VOICE DESIGN ====================

  // Design a voice from parameters
  ipcMain.handle('video-editor:elevenlabs-design-voice', async (event, options = {}) => {
    try {
      log.info('video', 'Designing voice', { gender: options.gender, age: options.age, accent: options.accent });
      const result = await videoEditor.elevenLabsService.designVoice(options);
      return { success: true, ...result };
    } catch (error) {
      log.error('video', 'Design voice error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // Save a designed voice to library
  ipcMain.handle(
    'video-editor:elevenlabs-save-designed-voice',
    async (event, generatedVoiceId, name, description = '') => {
      try {
        log.info('video', 'Saving designed voice', { name });
        const result = await videoEditor.elevenLabsService.saveDesignedVoice(generatedVoiceId, name, description);
        return { success: true, ...result };
      } catch (error) {
        log.error('video', 'Save designed voice error', { error: error.message });
        return { success: false, error: error.message };
      }
    }
  );

  // ==================== ELEVENLABS LANGUAGE DETECTION ====================

  // Detect language in audio
  ipcMain.handle('video-editor:elevenlabs-detect-language', async (event, audioPath) => {
    try {
      log.info('video', 'Detecting language in', { audioPath });
      const result = await videoEditor.elevenLabsService.detectLanguage(audioPath);
      return { success: true, ...result };
    } catch (error) {
      log.error('video', 'Detect language error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // ==================== ELEVENLABS MODELS ====================

  // List available models
  ipcMain.handle('video-editor:elevenlabs-list-models', async () => {
    try {
      const models = await videoEditor.elevenLabsService.listModels();
      return { success: true, models };
    } catch (error) {
      log.error('video', 'List models error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // ==================== ELEVENLABS STREAMING TTS ====================

  // Generate audio with streaming
  ipcMain.handle('video-editor:elevenlabs-generate-stream', async (event, text, voice, options = {}) => {
    try {
      log.info('video', 'Generating audio stream', { textPreview: text.substring(0, 50) });
      const outputPath = await videoEditor.elevenLabsService.generateAudioStream(text, voice, options, (chunk) => {
        // Send audio chunks to renderer for real-time playback if needed
        mainWindow?.webContents.send('video-editor:audio-stream-chunk', chunk);
      });
      return { success: true, audioPath: outputPath };
    } catch (error) {
      log.error('video', 'Generate stream error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // ==================== ELEVENLABS HISTORY ====================

  // Get generation history
  ipcMain.handle('video-editor:elevenlabs-get-history', async (event, options = {}) => {
    try {
      const result = await videoEditor.elevenLabsService.getHistory(options);
      return { success: true, ...result };
    } catch (error) {
      log.error('video', 'Get history error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // Get a specific history item
  ipcMain.handle('video-editor:elevenlabs-get-history-item', async (event, historyItemId) => {
    try {
      const result = await videoEditor.elevenLabsService.getHistoryItem(historyItemId);
      return { success: true, item: result };
    } catch (error) {
      log.error('video', 'Get history item error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // Get audio for a history item
  ipcMain.handle('video-editor:elevenlabs-get-history-audio', async (event, historyItemId) => {
    try {
      log.info('video', 'Getting history audio', { historyItemId });
      const audioPath = await videoEditor.elevenLabsService.getHistoryItemAudio(historyItemId);
      return { success: true, audioPath };
    } catch (error) {
      log.error('video', 'Get history audio error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // Delete a history item
  ipcMain.handle('video-editor:elevenlabs-delete-history-item', async (event, historyItemId) => {
    try {
      log.info('video', 'Deleting history item', { historyItemId });
      await videoEditor.elevenLabsService.deleteHistoryItem(historyItemId);
      return { success: true };
    } catch (error) {
      log.error('video', 'Delete history item error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // Delete multiple history items
  ipcMain.handle('video-editor:elevenlabs-delete-history-items', async (event, historyItemIds) => {
    try {
      log.info('video', 'Deleting history items', { count: historyItemIds.length });
      await videoEditor.elevenLabsService.deleteHistoryItems(historyItemIds);
      return { success: true };
    } catch (error) {
      log.error('video', 'Delete history items error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // ==================== LINE SCRIPT SYSTEM ====================

  // Capture a frame at a specific time
  ipcMain.handle('video-editor:capture-frame-at-time', async (event, videoPath, timestamp, options = {}) => {
    try {
      log.info('video', 'Capturing frame at', { timestamp });

      const { width = 640, format = 'base64' } = options;

      // Use thumbnail service to capture frame
      const thumbnail = await videoEditor.generateSingleThumbnail(videoPath, timestamp, { width });

      if (format === 'base64') {
        return { success: true, frameBase64: thumbnail, timestamp };
      }

      return { success: true, framePath: thumbnail, timestamp };
    } catch (error) {
      log.error('video', 'Capture frame error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // Analyze scene with GPT Vision
  ipcMain.handle('video-editor:analyze-scene-with-vision', async (event, options) => {
    try {
      const { transcript, speaker, startTime, endTime, frameBase64, prompt, templateId } = options;

      log.info('video', 'Analyzing scene with vision', { startTime, endTime, templateId });

      // Get API key from settings
      const { getSettingsManager } = await import('../../../settings-manager.js');
      const settingsManager = getSettingsManager();
      const apiKey = settingsManager.get('llmApiKey');
      const provider = settingsManager.get('llmProvider') || 'openai';

      if (!apiKey) {
        return { success: false, error: 'No LLM API key configured.' };
      }

      // Build prompt for vision analysis
      const fullPrompt =
        prompt ||
        `Analyze this video frame in context of the transcript.
        
Speaker: ${speaker || 'Unknown'}
Transcript: "${transcript}"

Provide analysis in JSON format:
{
  "sceneHeading": "Brief scene description",
  "visualDescription": "What's happening visually",
  "mood": "emotional tone",
  "topics": ["topic1", "topic2"],
  "keyMoments": []
}`;

      // Call Vision API
      if (provider === 'openai' && frameBase64) {
        const imageData = frameBase64.startsWith('data:') ? frameBase64 : `data:image/png;base64,${frameBase64}`;
        const result = await ai.vision(imageData, fullPrompt, {
          profile: 'fast',
          maxTokens: 1000,
          feature: 'video-editor-ipc',
        });

        const content = result.content || '';

        // Try to parse JSON from response
        try {
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return { success: true, ...parsed };
          }
        } catch (_parseError) {
          // Return as text if not valid JSON
          return {
            success: true,
            sceneHeading: 'Scene Analysis',
            visualDescription: content,
          };
        }

        return { success: true, visualDescription: content };
      }

      // Fallback: text-only analysis
      return {
        success: true,
        sceneHeading: speaker ? `${speaker} speaks` : 'Scene',
        visualDescription: 'Vision analysis requires OpenAI API with image support',
        mood: 'neutral',
      };
    } catch (error) {
      log.error('video', 'Analyze scene error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // Find quotes in transcript
  ipcMain.handle('video-editor:find-quotes', async (event, options) => {
    try {
      const { transcript, maxQuotes = 10, criteria = [] } = options;

      log.info('video', 'Finding quotes in transcript');

      // Get API key
      const { getSettingsManager } = await import('../../../settings-manager.js');
      const settingsManager = getSettingsManager();
      const apiKey = settingsManager.get('llmApiKey');
      const provider = settingsManager.get('llmProvider') || 'anthropic';

      if (!apiKey) {
        return { success: false, error: 'No LLM API key configured.' };
      }

      const criteriaText =
        criteria.length > 0 ? criteria.join('\n- ') : 'impactful statements\n- memorable phrases\n- emotional moments';

      const prompt = `Find the ${maxQuotes} most quotable moments in this transcript.

Look for:
- ${criteriaText}

Transcript:
"${transcript}"

Return JSON array of quotes:
[
  {
    "text": "The exact quote",
    "score": 8,
    "reason": "Why this is quotable",
    "suggestedUse": "social clip|audiogram|pull quote"
  }
]`;

      // Use centralized AI service
      let quotes = [];

      try {
        const result = await ai.chat({
          profile: provider === 'anthropic' ? 'standard' : 'fast',
          messages: [{ role: 'user', content: prompt }],
          maxTokens: 2000,
          feature: 'video-editor-ipc',
        });

        const content = result.content || '';
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          quotes = JSON.parse(jsonMatch[0]);
        }
      } catch (err) {
        log.warn('video', 'Find quotes error', { error: err.message });
      }

      return { success: true, quotes };
    } catch (error) {
      log.error('video', 'Find quotes error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // Detect topics in transcript
  ipcMain.handle('video-editor:detect-topics', async (event, options) => {
    try {
      const { transcript } = options;

      log.info('video', 'Detecting topics in transcript');

      // Get API key
      const { getSettingsManager } = await import('../../../settings-manager.js');
      const settingsManager = getSettingsManager();
      const apiKey = settingsManager.get('llmApiKey');

      if (!apiKey) {
        return { success: false, error: 'No LLM API key configured.' };
      }

      const prompt = `Analyze this transcript and identify distinct topic segments.

Transcript:
"${transcript}"

For each topic segment, provide:
- title: Brief topic title
- summary: 1-2 sentence summary
- keywords: Key terms

Return JSON array:
[
  {
    "title": "Topic title",
    "summary": "What's discussed",
    "keywords": ["word1", "word2"]
  }
]`;

      let topics = [];
      try {
        const result = await ai.chat({
          profile: 'standard',
          messages: [{ role: 'user', content: prompt }],
          maxTokens: 2000,
          feature: 'video-editor-ipc',
        });

        const content = result.content || '';
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          topics = JSON.parse(jsonMatch[0]);
        }
      } catch (err) {
        log.warn('video', 'Detect topics error', { error: err.message });
      }

      return { success: true, topics };
    } catch (error) {
      log.error('video', 'Detect topics error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // Analyze hooks in transcript
  ipcMain.handle('video-editor:analyze-hooks', async (event, options) => {
    try {
      const { transcript } = options;

      log.info('video', 'Analyzing hooks');

      // Get API key
      const { getSettingsManager } = await import('../../../settings-manager.js');
      const settingsManager = getSettingsManager();
      const apiKey = settingsManager.get('llmApiKey');

      if (!apiKey) {
        return { success: false, error: 'No LLM API key configured.' };
      }

      const prompt = `Analyze this transcript for hook-worthy moments that could grab viewer attention.

Rate each potential hook on:
- Curiosity gap (makes viewer want more)
- Energy level
- Pattern interrupt (unexpected)
- Emotional impact

Transcript:
"${transcript}"

Return JSON:
{
  "hooks": [
    {
      "text": "The hook text",
      "score": 8,
      "type": "curiosity|energy|pattern-interrupt|emotional",
      "suggestedUse": "opening|teaser|highlight"
    }
  ],
  "bestOpening": "The best hook to use as opening"
}`;

      let result = { hooks: [], bestOpening: null };
      try {
        const aiResult = await ai.chat({
          profile: 'standard',
          messages: [{ role: 'user', content: prompt }],
          maxTokens: 2000,
          feature: 'video-editor-ipc',
        });

        const content = aiResult.content || '';
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          result = JSON.parse(jsonMatch[0]);
        }
      } catch (err) {
        log.warn('video', 'Analyze hooks error', { error: err.message });
      }

      return { success: true, ...result };
    } catch (error) {
      log.error('video', 'Analyze hooks error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // Rate project with AI
  ipcMain.handle('video-editor:rate-project', async (event, options) => {
    try {
      const { transcript, criteria, customGoals } = options;

      log.info('video', 'Rating project with AI');

      // Get API key
      const { getSettingsManager } = await import('../../../settings-manager.js');
      const settingsManager = getSettingsManager();
      const apiKey = settingsManager.get('llmApiKey');

      if (!apiKey) {
        return { success: false, error: 'No LLM API key configured.' };
      }

      const criteriaList = criteria.map((c) => `- ${c.name}: ${c.prompt}`).join('\n');

      const prompt = `Rate this video content on the following criteria (1-10 scale):

${criteriaList}

${customGoals ? `Project Goals: ${customGoals}` : ''}

Transcript:
"${transcript.substring(0, 5000)}..."

For each criterion, provide:
- Score (1-10)
- Positives (what works well)
- Issues (what could improve)
- Suggestions

Return JSON:
{
  "scores": {
    "criterion_id": {
      "score": 7,
      "positives": ["..."],
      "issues": ["..."],
      "suggestions": ["..."]
    }
  },
  "overallScore": 7.5,
  "improvements": {
    "immediate": ["..."],
    "content": ["..."]
  },
  "nextTime": {
    "whatWorked": ["..."],
    "tryNext": ["..."]
  }
}`;

      let result = {};
      try {
        const aiResult = await ai.chat({
          profile: 'standard',
          messages: [{ role: 'user', content: prompt }],
          maxTokens: 3000,
          feature: 'video-editor-ipc',
        });

        const content = aiResult.content || '';
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          result = JSON.parse(jsonMatch[0]);
        }
      } catch (err) {
        log.warn('video', 'Rate project error', { error: err.message });
      }

      return { success: true, ...result };
    } catch (error) {
      log.error('video', 'Rate project error', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  log.info('video', 'All IPC handlers registered successfully');
}
