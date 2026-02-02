/**
 * VideoEditorIPC - IPC handler registration for video editor
 * @module src/video/ipc/VideoEditorIPC
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { ipcMain, shell } = require('electron');

/**
 * Register all video editor IPC handlers
 * @param {Object} videoEditor - VideoEditor instance
 * @param {BrowserWindow} mainWindow - Main window for progress events
 */
export function setupVideoEditorIPC(videoEditor, mainWindow) {
  // Prevent duplicate registration
  if (videoEditor.ipcHandlersRegistered) {
    console.log('[VideoEditorIPC] IPC handlers already registered, skipping');
    return;
  }
  videoEditor.ipcHandlersRegistered = true;

  console.log('[VideoEditorIPC] Registering IPC handlers...');

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
      console.log('[VideoEditorIPC] Generating waveform for:', videoPath);
      return await videoEditor.generateWaveformData(videoPath, options);
    } catch (error) {
      console.error('[VideoEditorIPC] Waveform error:', error);
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
      console.log('[VideoEditorIPC] Waveform cache saved:', cachePath);
      return { success: true, cachePath };
    } catch (error) {
      console.error('[VideoEditorIPC] Save waveform cache error:', error);
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
      console.log('[VideoEditorIPC] Waveform cache loaded:', cachePath);
      return { exists: true, ...cacheData };
    } catch (error) {
      console.error('[VideoEditorIPC] Load waveform cache error:', error);
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
      console.log('[VideoEditorIPC] Waveform image saved:', imagePath);
      return { success: true, imagePath };
    } catch (error) {
      console.error('[VideoEditorIPC] Save waveform image error:', error);
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
      console.log('[VideoEditorIPC] Waveform image loaded:', imagePath);
      return { exists: true, dataUrl };
    } catch (error) {
      console.error('[VideoEditorIPC] Load waveform image error:', error);
      return { exists: false, error: error.message };
    }
  });

  // Delete all waveform cache files for a video
  ipcMain.handle('video-editor:delete-waveform-cache', async (event, videoPath) => {
    try {
      const path = await import('path');
      const fs = await import('fs/promises');
      const fsSync = await import('fs');

      const videoDir = path.dirname(videoPath);
      const videoName = path.basename(videoPath, path.extname(videoPath));
      
      // Find all waveform cache files for this video
      const files = await fs.readdir(videoDir);
      const cacheFiles = files.filter(f => 
        f.startsWith(`.${videoName}.waveform-`) && 
        (f.endsWith('.json') || f.endsWith('.png'))
      );
      
      let deleted = 0;
      for (const file of cacheFiles) {
        const filePath = path.join(videoDir, file);
        try {
          await fs.unlink(filePath);
          deleted++;
          console.log('[VideoEditorIPC] Deleted waveform cache:', file);
        } catch (e) {
          console.warn('[VideoEditorIPC] Could not delete:', file, e.message);
        }
      }
      
      console.log('[VideoEditorIPC] Deleted', deleted, 'waveform cache files');
      return { success: true, deleted };
    } catch (error) {
      console.error('[VideoEditorIPC] Delete waveform cache error:', error);
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
      console.log('[VideoEditorIPC] Thumbnail cache saved:', cachePath);
      return { success: true, cachePath };
    } catch (error) {
      console.error('[VideoEditorIPC] Save thumbnail cache error:', error);
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
      console.log('[VideoEditorIPC] Thumbnail cache loaded:', cachePath);
      return { exists: true, ...cacheData };
    } catch (error) {
      console.error('[VideoEditorIPC] Load thumbnail cache error:', error);
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
      console.log('[VideoEditorIPC] Thumbnail strip saved:', imagePath);
      return { success: true, imagePath };
    } catch (error) {
      console.error('[VideoEditorIPC] Save thumbnail strip error:', error);
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
      console.log('[VideoEditorIPC] Thumbnail strip loaded:', imagePath);
      return { exists: true, dataUrl };
    } catch (error) {
      console.error('[VideoEditorIPC] Load thumbnail strip error:', error);
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
        console.log('[VideoEditorIPC] Audio cache found:', cachePath);
        return { exists: true, path: cachePath, size: stats.size };
      } catch {
        return { exists: false };
      }
    } catch (error) {
      console.error('[VideoEditorIPC] Check audio cache error:', error);
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
        console.log('[VideoEditorIPC] Using cached audio:', cachePath);
        return { success: true, path: cachePath, cached: true, size: stats.size };
      } catch {
        // Cache miss - need to extract
      }
      
      console.log('[VideoEditorIPC] Cache miss, extracting audio to:', cachePath);
      
      // Extract audio using codec copy for speed (no re-encoding)
      const result = await videoEditor.extractAudio(videoPath, {
        outputPath: cachePath,
        format: 'aac',
        codec: 'copy'  // Fast - just copy audio stream
      }, (progress) => {
        mainWindow?.webContents.send('video-editor:extraction-progress', progress);
      });
      
      if (result.error) {
        // If codec copy fails (incompatible format), try with re-encoding
        console.log('[VideoEditorIPC] Codec copy failed, re-encoding...');
        const reencodeResult = await videoEditor.extractAudio(videoPath, {
          outputPath: cachePath,
          format: 'aac',
          audioBitrate: '192k'
        }, (progress) => {
          mainWindow?.webContents.send('video-editor:extraction-progress', progress);
        });
        
        if (reencodeResult.error) {
          return { success: false, error: reencodeResult.error };
        }
      }
      
      const stats = await fs.stat(cachePath);
      console.log('[VideoEditorIPC] Audio extracted and cached:', cachePath);
      return { success: true, path: cachePath, cached: false, size: stats.size };
      
    } catch (error) {
      console.error('[VideoEditorIPC] Extract audio cached error:', error);
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
      console.log('[VideoEditorIPC] Transcribe range called:', videoPath, options);
      
      // Progress callback to send updates to renderer
      const onChunkComplete = (progressData) => {
        try {
          event.sender.send('video-editor:transcription-progress', progressData);
        } catch (e) {
          console.warn('[VideoEditorIPC] Could not send progress:', e.message);
        }
      };
      
      return await videoEditor.transcribeRange(videoPath, { ...options, onChunkComplete });
    } catch (error) {
      console.error('[VideoEditorIPC] Transcribe error:', error);
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
      
      console.log('[VideoEditorIPC] Generating scene description with', provider, model);
      
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
      
      if (provider === 'anthropic' || apiKey.startsWith('sk-ant-')) {
        // Use Anthropic Claude
        const https = await import('https');
        
        const requestBody = JSON.stringify({
          model: model,
          max_tokens: 500,
          messages: [{
            role: 'user',
            content: prompt
          }]
        });
        
        const response = await new Promise((resolve, reject) => {
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
              try {
                resolve(JSON.parse(data));
              } catch (e) {
                reject(new Error('Invalid response from Anthropic API'));
              }
            });
          });
          
          req.on('error', reject);
          req.write(requestBody);
          req.end();
        });
        
        if (response.error) {
          throw new Error(response.error.message || 'Anthropic API error');
        }
        
        description = response.content?.[0]?.text?.trim() || '';
        
      } else {
        // Use OpenAI
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: model.startsWith('gpt') ? model : 'gpt-4o-mini',
            messages: [{
              role: 'user',
              content: prompt
            }],
            max_tokens: 500
          })
        });
        
        const result = await response.json();
        
        if (result.error) {
          throw new Error(result.error.message || 'OpenAI API error');
        }
        
        description = result.choices?.[0]?.message?.content?.trim() || '';
      }
      
      if (!description) {
        throw new Error('Empty response from LLM');
      }
      
      console.log('[VideoEditorIPC] Generated description:', description.substring(0, 100) + '...');
      
      return { success: true, description };
      
    } catch (error) {
      console.error('[VideoEditorIPC] Generate scene description error:', error);
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
      console.log('[VideoEditorIPC] Creating video from audio:', audioPath);
      return await videoEditor.createVideoFromAudio(audioPath, options, (progress) => {
        mainWindow?.webContents.send('video-editor:progress', progress);
      });
    } catch (error) {
      console.error('[VideoEditorIPC] Audio-to-video error:', error);
      return { error: error.message };
    }
  });

  // Select single image file
  ipcMain.handle('video-editor:select-image', async (event) => {
    try {
      const { dialog } = await import('electron');
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select Image',
        filters: [
          { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] }
        ],
        properties: ['openFile']
      });
      
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true };
      }
      
      return { filePath: result.filePaths[0] };
    } catch (error) {
      console.error('[VideoEditorIPC] Select image error:', error);
      return { error: error.message };
    }
  });

  // Select multiple image files
  ipcMain.handle('video-editor:select-images', async (event) => {
    try {
      const { dialog } = await import('electron');
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select Images for Slideshow',
        filters: [
          { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] }
        ],
        properties: ['openFile', 'multiSelections']
      });
      
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true };
      }
      
      return { filePaths: result.filePaths };
    } catch (error) {
      console.error('[VideoEditorIPC] Select images error:', error);
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
      console.error('[VideoEditorIPC] Check ElevenLabs key error:', error);
      return { hasKey: false, error: error.message };
    }
  });

  ipcMain.handle('video-editor:replace-audio-elevenlabs', async (event, videoPath, options) => {
    try {
      return await videoEditor.replaceAudioWithElevenLabs(videoPath, options, (progress) => {
        mainWindow?.webContents.send('video-editor:progress', progress);
      });
    } catch (error) {
      console.error('[VideoEditorIPC] ElevenLabs error:', error);
      return { error: error.message };
    }
  });

  // Generate ElevenLabs audio only (non-destructive - no video processing)
  ipcMain.handle('video-editor:generate-elevenlabs-audio', async (event, options) => {
    try {
      console.log('[VideoEditorIPC] Generating ElevenLabs audio only:', options.text?.substring(0, 50));
      return await videoEditor.generateElevenLabsAudioOnly(options, (progress) => {
        mainWindow?.webContents.send('video-editor:progress', progress);
      });
    } catch (error) {
      console.error('[VideoEditorIPC] ElevenLabs generate error:', error);
      return { error: error.message };
    }
  });

  // Export video with all audio replacements applied at once
  ipcMain.handle('video-editor:export-with-audio-replacements', async (event, videoPath, replacements) => {
    try {
      console.log('[VideoEditorIPC] Exporting with', replacements.length, 'audio replacements');
      return await videoEditor.exportWithAudioReplacements(videoPath, replacements, (progress) => {
        mainWindow?.webContents.send('video-editor:progress', progress);
      });
    } catch (error) {
      console.error('[VideoEditorIPC] Export with replacements error:', error);
      return { error: error.message };
    }
  });

  // ==================== ELEVENLABS NEW APIS ====================

  // Generate sound effect from text prompt
  ipcMain.handle('video-editor:generate-sfx', async (event, options) => {
    try {
      console.log('[VideoEditorIPC] Generating SFX:', options.prompt?.substring(0, 50));
      const audioPath = await videoEditor.elevenLabsService.generateSoundEffect(
        options.prompt,
        { durationSeconds: options.durationSeconds, promptInfluence: options.promptInfluence },
        { projectId: options.projectId }
      );
      return { success: true, audioPath };
    } catch (error) {
      console.error('[VideoEditorIPC] Generate SFX error:', error);
      return { success: false, error: error.message };
    }
  });

  // Generate music from text prompt using Eleven Music
  ipcMain.handle('video-editor:generate-music', async (event, options) => {
    try {
      console.log('[VideoEditorIPC] Generating music:', options.prompt?.substring(0, 50));
      const audioPath = await videoEditor.elevenLabsService.generateMusic(
        options.prompt,
        { 
          durationMs: options.durationMs, 
          instrumental: options.instrumental !== false,
          modelId: options.modelId 
        },
        { projectId: options.projectId }
      );
      return { success: true, audioPath };
    } catch (error) {
      console.error('[VideoEditorIPC] Generate music error:', error);
      return { success: false, error: error.message };
    }
  });

  // Get music composition plan/suggestions
  ipcMain.handle('video-editor:get-music-plan', async (event, options) => {
    try {
      console.log('[VideoEditorIPC] Getting music plan:', options.prompt?.substring(0, 50));
      const plan = await videoEditor.elevenLabsService.getMusicCompositionPlan(
        options.prompt,
        { durationMs: options.durationMs }
      );
      return { success: true, plan };
    } catch (error) {
      console.error('[VideoEditorIPC] Get music plan error:', error);
      return { success: false, error: error.message };
    }
  });

  // Get AI-generated audio suggestions (music or SFX) for a marker
  ipcMain.handle('video-editor:get-audio-suggestions', async (event, options) => {
    try {
      const { marker, type, apiKey } = options;
      console.log('[VideoEditorIPC] Getting audio suggestions for:', marker?.name, 'type:', type);
      
      // Use OpenAI to generate suggestions
      const { getOpenAIAPI } = require('../../../openai-api.js');
      const openaiAPI = getOpenAIAPI();
      
      const suggestions = await openaiAPI.generateAudioSuggestions(
        marker,
        type,
        apiKey,
        { projectId: options.projectId }
      );
      
      return { success: true, suggestions };
    } catch (error) {
      console.error('[VideoEditorIPC] Get audio suggestions error:', error);
      return { success: false, error: error.message };
    }
  });

  // Speech-to-Speech voice transformation
  ipcMain.handle('video-editor:speech-to-speech', async (event, options) => {
    try {
      console.log('[VideoEditorIPC] Speech-to-Speech:', options.audioPath);
      const audioPath = await videoEditor.elevenLabsService.speechToSpeech(
        options.audioPath,
        options.voiceId,
        { stability: options.stability, similarityBoost: options.similarityBoost },
        { projectId: options.projectId }
      );
      return { success: true, audioPath };
    } catch (error) {
      console.error('[VideoEditorIPC] Speech-to-Speech error:', error);
      return { success: false, error: error.message };
    }
  });

  // Audio isolation (remove background noise)
  ipcMain.handle('video-editor:isolate-audio', async (event, audioPath, options = {}) => {
    try {
      console.log('[VideoEditorIPC] Isolating audio:', audioPath);
      const isolatedPath = await videoEditor.elevenLabsService.isolateAudio(
        audioPath,
        { projectId: options.projectId }
      );
      return { success: true, audioPath: isolatedPath };
    } catch (error) {
      console.error('[VideoEditorIPC] Isolate audio error:', error);
      return { success: false, error: error.message };
    }
  });

  // Create dubbing project
  ipcMain.handle('video-editor:create-dubbing', async (event, options) => {
    try {
      console.log('[VideoEditorIPC] Creating dubbing project:', options.videoPath);
      const result = await videoEditor.elevenLabsService.createDubbingProject(
        options.videoPath,
        options.targetLanguages,
        {
          sourceLanguage: options.sourceLanguage,
          numSpeakers: options.numSpeakers,
          watermark: options.watermark,
          projectName: options.projectName
        },
        { projectId: options.projectId }
      );
      return { success: true, ...result };
    } catch (error) {
      console.error('[VideoEditorIPC] Create dubbing error:', error);
      return { success: false, error: error.message };
    }
  });

  // Get dubbing project status
  ipcMain.handle('video-editor:get-dubbing-status', async (event, dubbingId) => {
    try {
      const result = await videoEditor.elevenLabsService.getDubbingStatus(dubbingId);
      return { success: true, ...result };
    } catch (error) {
      console.error('[VideoEditorIPC] Get dubbing status error:', error);
      return { success: false, error: error.message };
    }
  });

  // Download dubbed audio
  ipcMain.handle('video-editor:download-dubbed-audio', async (event, dubbingId, languageCode) => {
    try {
      const audioPath = await videoEditor.elevenLabsService.downloadDubbedAudio(dubbingId, languageCode);
      return { success: true, audioPath };
    } catch (error) {
      console.error('[VideoEditorIPC] Download dubbed audio error:', error);
      return { success: false, error: error.message };
    }
  });

  // List all available voices (dynamic)
  ipcMain.handle('video-editor:list-voices', async () => {
    try {
      const voices = await videoEditor.elevenLabsService.listVoices();
      return { success: true, voices };
    } catch (error) {
      console.error('[VideoEditorIPC] List voices error:', error);
      return { success: false, error: error.message };
    }
  });

  // Get user subscription info (quota/limits)
  ipcMain.handle('video-editor:get-subscription', async () => {
    try {
      const subscription = await videoEditor.elevenLabsService.getUserSubscription();
      return { success: true, subscription };
    } catch (error) {
      console.error('[VideoEditorIPC] Get subscription error:', error);
      return { success: false, error: error.message };
    }
  });

  // Get user info
  ipcMain.handle('video-editor:get-user-info', async () => {
    try {
      const user = await videoEditor.elevenLabsService.getUserInfo();
      return { success: true, user };
    } catch (error) {
      console.error('[VideoEditorIPC] Get user info error:', error);
      return { success: false, error: error.message };
    }
  });

  // Get usage statistics
  ipcMain.handle('video-editor:get-usage-stats', async (event, options = {}) => {
    try {
      const stats = await videoEditor.elevenLabsService.getUsageStats(options);
      return { success: true, stats };
    } catch (error) {
      console.error('[VideoEditorIPC] Get usage stats error:', error);
      return { success: false, error: error.message };
    }
  });

  // ==================== ELEVENLABS SCRIBE TRANSCRIPTION ====================

  // Transcribe audio using ElevenLabs Scribe (replaces Whisper for transcription)
  ipcMain.handle('video-editor:transcribe-scribe', async (event, audioPath, options = {}) => {
    try {
      console.log('[VideoEditorIPC] Transcribe with Scribe called:', audioPath);
      const result = await videoEditor.elevenLabsService.transcribeAudio(audioPath, options);
      console.log('[VideoEditorIPC] Scribe transcription complete, words:', result.words?.length || 0);
      return { success: true, ...result };
    } catch (error) {
      console.error('[VideoEditorIPC] Scribe transcription error:', error);
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
      console.error('[VideoEditorIPC] Edit list error:', error);
      return { error: error.message };
    }
  });

  ipcMain.handle('video-editor:finalize-workflow', async (event, spaceItemId, editedVideoPath, scenes) => {
    try {
      // Note: clipboardManager needs to be passed from main.js
      const clipboardManager = global.clipboardManager;
      return await videoEditor.finalizeVideoWorkflow(spaceItemId, editedVideoPath, scenes, clipboardManager);
    } catch (error) {
      console.error('[VideoEditorIPC] Finalize error:', error);
      return { error: error.message };
    }
  });

  ipcMain.handle('video-editor:detect-scenes', async (event, videoPath, options) => {
    try {
      return await videoEditor.detectScenes(videoPath, options);
    } catch (error) {
      console.error('[VideoEditorIPC] Scene detection error:', error);
      return { error: error.message };
    }
  });

  // ==================== TRANSLATION PIPELINE ====================

  ipcMain.handle('video-editor:translate-with-quality', async (event, sourceText, options) => {
    try {
      return await videoEditor.translateWithQualityLoop(sourceText, options);
    } catch (error) {
      console.error('[VideoEditorIPC] Translation error:', error);
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
      console.error('[VideoEditorIPC] Translation error:', error);
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
      console.error('[VideoEditorIPC] Evaluation error:', error);
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
        metadata
      };
    } catch (error) {
      console.error('[VideoEditorIPC] Get space video error:', error);
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
      console.error('[VideoEditorIPC] Save scenes error:', error);
      return { error: error.message };
    }
  });

  // ==================== RELEASE & VERSIONING ====================

  // Get release options for current project
  ipcMain.handle('video-editor:get-release-options', async (event) => {
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
      console.error('[VideoEditorIPC] Get release options error:', error);
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
      console.error('[VideoEditorIPC] Release current video error:', error);
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
      console.error('[VideoEditorIPC] Release branch error:', error);
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
      console.error('[VideoEditorIPC] Get upload service status error:', error);
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
      console.error('[VideoEditorIPC] Authenticate upload service error:', error);
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
      console.error('[VideoEditorIPC] Create project error:', error);
      return { error: error.message };
    }
  });

  // Get all projects
  ipcMain.handle('video-editor:get-projects', async (event) => {
    try {
      const { VersionManager } = await import('../versioning/VersionManager.js');
      const versionManager = new VersionManager();
      return versionManager.getAllProjects();
    } catch (error) {
      console.error('[VideoEditorIPC] Get projects error:', error);
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
        forkFromVersion
      });
    } catch (error) {
      console.error('[VideoEditorIPC] Create branch error:', error);
      return { error: error.message };
    }
  });

  // Get branches
  ipcMain.handle('video-editor:get-branches', async (event) => {
    try {
      const { VersionManager } = await import('../versioning/VersionManager.js');
      const versionManager = new VersionManager();
      
      const projectPath = global.currentVideoProjectPath;
      if (!projectPath) {
        return [];
      }
      
      return versionManager.getBranches(projectPath);
    } catch (error) {
      console.error('[VideoEditorIPC] Get branches error:', error);
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
      console.error('[VideoEditorIPC] Save version error:', error);
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
      console.error('[VideoEditorIPC] Load EDL error:', error);
      return { error: error.message };
    }
  });

  // ==================== ELEVENLABS STUDIO PROJECTS ====================

  // Create a Studio project
  ipcMain.handle('video-editor:elevenlabs-create-studio-project', async (event, name, options = {}) => {
    try {
      console.log('[VideoEditorIPC] Creating ElevenLabs Studio project:', name);
      const result = await videoEditor.elevenLabsService.createStudioProject(name, options);
      return { success: true, ...result };
    } catch (error) {
      console.error('[VideoEditorIPC] Create Studio project error:', error);
      return { success: false, error: error.message };
    }
  });

  // Get a Studio project
  ipcMain.handle('video-editor:elevenlabs-get-studio-project', async (event, projectId) => {
    try {
      const result = await videoEditor.elevenLabsService.getStudioProject(projectId);
      return { success: true, project: result };
    } catch (error) {
      console.error('[VideoEditorIPC] Get Studio project error:', error);
      return { success: false, error: error.message };
    }
  });

  // List Studio projects
  ipcMain.handle('video-editor:elevenlabs-list-studio-projects', async () => {
    try {
      const projects = await videoEditor.elevenLabsService.listStudioProjects();
      return { success: true, projects };
    } catch (error) {
      console.error('[VideoEditorIPC] List Studio projects error:', error);
      return { success: false, error: error.message };
    }
  });

  // Delete a Studio project
  ipcMain.handle('video-editor:elevenlabs-delete-studio-project', async (event, projectId) => {
    try {
      console.log('[VideoEditorIPC] Deleting ElevenLabs Studio project:', projectId);
      await videoEditor.elevenLabsService.deleteStudioProject(projectId);
      return { success: true };
    } catch (error) {
      console.error('[VideoEditorIPC] Delete Studio project error:', error);
      return { success: false, error: error.message };
    }
  });

  // ==================== ELEVENLABS VOICE CLONING ====================

  // Clone a voice from audio samples
  ipcMain.handle('video-editor:elevenlabs-clone-voice', async (event, name, audioFilePaths, options = {}) => {
    try {
      console.log('[VideoEditorIPC] Cloning voice:', name, 'with', audioFilePaths.length, 'samples');
      const result = await videoEditor.elevenLabsService.cloneVoice(name, audioFilePaths, options);
      return { success: true, ...result };
    } catch (error) {
      console.error('[VideoEditorIPC] Clone voice error:', error);
      return { success: false, error: error.message };
    }
  });

  // Delete a voice
  ipcMain.handle('video-editor:elevenlabs-delete-voice', async (event, voiceId) => {
    try {
      console.log('[VideoEditorIPC] Deleting voice:', voiceId);
      await videoEditor.elevenLabsService.deleteVoice(voiceId);
      return { success: true };
    } catch (error) {
      console.error('[VideoEditorIPC] Delete voice error:', error);
      return { success: false, error: error.message };
    }
  });

  // Edit voice settings
  ipcMain.handle('video-editor:elevenlabs-edit-voice', async (event, voiceId, updates) => {
    try {
      console.log('[VideoEditorIPC] Editing voice:', voiceId);
      const result = await videoEditor.elevenLabsService.editVoice(voiceId, updates);
      return { success: true, voice: result };
    } catch (error) {
      console.error('[VideoEditorIPC] Edit voice error:', error);
      return { success: false, error: error.message };
    }
  });

  // Get voice details
  ipcMain.handle('video-editor:elevenlabs-get-voice', async (event, voiceId) => {
    try {
      const result = await videoEditor.elevenLabsService.getVoice(voiceId);
      return { success: true, voice: result };
    } catch (error) {
      console.error('[VideoEditorIPC] Get voice error:', error);
      return { success: false, error: error.message };
    }
  });

  // ==================== ELEVENLABS VOICE DESIGN ====================

  // Design a voice from parameters
  ipcMain.handle('video-editor:elevenlabs-design-voice', async (event, options = {}) => {
    try {
      console.log('[VideoEditorIPC] Designing voice:', options.gender, options.age, options.accent);
      const result = await videoEditor.elevenLabsService.designVoice(options);
      return { success: true, ...result };
    } catch (error) {
      console.error('[VideoEditorIPC] Design voice error:', error);
      return { success: false, error: error.message };
    }
  });

  // Save a designed voice to library
  ipcMain.handle('video-editor:elevenlabs-save-designed-voice', async (event, generatedVoiceId, name, description = '') => {
    try {
      console.log('[VideoEditorIPC] Saving designed voice:', name);
      const result = await videoEditor.elevenLabsService.saveDesignedVoice(generatedVoiceId, name, description);
      return { success: true, ...result };
    } catch (error) {
      console.error('[VideoEditorIPC] Save designed voice error:', error);
      return { success: false, error: error.message };
    }
  });

  // ==================== ELEVENLABS LANGUAGE DETECTION ====================

  // Detect language in audio
  ipcMain.handle('video-editor:elevenlabs-detect-language', async (event, audioPath) => {
    try {
      console.log('[VideoEditorIPC] Detecting language in:', audioPath);
      const result = await videoEditor.elevenLabsService.detectLanguage(audioPath);
      return { success: true, ...result };
    } catch (error) {
      console.error('[VideoEditorIPC] Detect language error:', error);
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
      console.error('[VideoEditorIPC] List models error:', error);
      return { success: false, error: error.message };
    }
  });

  // ==================== ELEVENLABS STREAMING TTS ====================

  // Generate audio with streaming
  ipcMain.handle('video-editor:elevenlabs-generate-stream', async (event, text, voice, options = {}) => {
    try {
      console.log('[VideoEditorIPC] Generating audio stream:', text.substring(0, 50) + '...');
      const outputPath = await videoEditor.elevenLabsService.generateAudioStream(text, voice, options, (chunk) => {
        // Send audio chunks to renderer for real-time playback if needed
        mainWindow?.webContents.send('video-editor:audio-stream-chunk', chunk);
      });
      return { success: true, audioPath: outputPath };
    } catch (error) {
      console.error('[VideoEditorIPC] Generate stream error:', error);
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
      console.error('[VideoEditorIPC] Get history error:', error);
      return { success: false, error: error.message };
    }
  });

  // Get a specific history item
  ipcMain.handle('video-editor:elevenlabs-get-history-item', async (event, historyItemId) => {
    try {
      const result = await videoEditor.elevenLabsService.getHistoryItem(historyItemId);
      return { success: true, item: result };
    } catch (error) {
      console.error('[VideoEditorIPC] Get history item error:', error);
      return { success: false, error: error.message };
    }
  });

  // Get audio for a history item
  ipcMain.handle('video-editor:elevenlabs-get-history-audio', async (event, historyItemId) => {
    try {
      console.log('[VideoEditorIPC] Getting history audio:', historyItemId);
      const audioPath = await videoEditor.elevenLabsService.getHistoryItemAudio(historyItemId);
      return { success: true, audioPath };
    } catch (error) {
      console.error('[VideoEditorIPC] Get history audio error:', error);
      return { success: false, error: error.message };
    }
  });

  // Delete a history item
  ipcMain.handle('video-editor:elevenlabs-delete-history-item', async (event, historyItemId) => {
    try {
      console.log('[VideoEditorIPC] Deleting history item:', historyItemId);
      await videoEditor.elevenLabsService.deleteHistoryItem(historyItemId);
      return { success: true };
    } catch (error) {
      console.error('[VideoEditorIPC] Delete history item error:', error);
      return { success: false, error: error.message };
    }
  });

  // Delete multiple history items
  ipcMain.handle('video-editor:elevenlabs-delete-history-items', async (event, historyItemIds) => {
    try {
      console.log('[VideoEditorIPC] Deleting', historyItemIds.length, 'history items');
      await videoEditor.elevenLabsService.deleteHistoryItems(historyItemIds);
      return { success: true };
    } catch (error) {
      console.error('[VideoEditorIPC] Delete history items error:', error);
      return { success: false, error: error.message };
    }
  });

  // ==================== LINE SCRIPT SYSTEM ====================

  // Capture a frame at a specific time
  ipcMain.handle('video-editor:capture-frame-at-time', async (event, videoPath, timestamp, options = {}) => {
    try {
      console.log('[VideoEditorIPC] Capturing frame at:', timestamp);
      
      const { width = 640, format = 'base64' } = options;
      
      // Use thumbnail service to capture frame
      const thumbnail = await videoEditor.generateSingleThumbnail(videoPath, timestamp, { width });
      
      if (format === 'base64') {
        return { success: true, frameBase64: thumbnail, timestamp };
      }
      
      return { success: true, framePath: thumbnail, timestamp };
    } catch (error) {
      console.error('[VideoEditorIPC] Capture frame error:', error);
      return { success: false, error: error.message };
    }
  });

  // Analyze scene with GPT Vision
  ipcMain.handle('video-editor:analyze-scene-with-vision', async (event, options) => {
    try {
      const { 
        transcript, 
        speaker, 
        startTime, 
        endTime, 
        frameBase64, 
        prompt, 
        templateId 
      } = options;

      console.log('[VideoEditorIPC] Analyzing scene with vision:', { startTime, endTime, templateId });

      // Get API key from settings
      const { getSettingsManager } = await import('../../../settings-manager.js');
      const settingsManager = getSettingsManager();
      const apiKey = settingsManager.get('llmApiKey');
      const provider = settingsManager.get('llmProvider') || 'openai';

      if (!apiKey) {
        return { success: false, error: 'No LLM API key configured.' };
      }

      // Build prompt for vision analysis
      const fullPrompt = prompt || `Analyze this video frame in context of the transcript.
        
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

      // Call OpenAI Vision API
      if (provider === 'openai' && frameBase64) {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'gpt-4o',
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: fullPrompt },
                  {
                    type: 'image_url',
                    image_url: {
                      url: frameBase64.startsWith('data:') ? frameBase64 : `data:image/png;base64,${frameBase64}`
                    }
                  }
                ]
              }
            ],
            max_tokens: 1000
          })
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error?.message || 'Vision API error');
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '';

        // Try to parse JSON from response
        try {
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return { success: true, ...parsed };
          }
        } catch (parseError) {
          // Return as text if not valid JSON
          return { 
            success: true, 
            sceneHeading: 'Scene Analysis',
            visualDescription: content 
          };
        }

        return { success: true, visualDescription: content };
      }

      // Fallback: text-only analysis
      return { 
        success: true, 
        sceneHeading: speaker ? `${speaker} speaks` : 'Scene',
        visualDescription: 'Vision analysis requires OpenAI API with image support',
        mood: 'neutral'
      };

    } catch (error) {
      console.error('[VideoEditorIPC] Analyze scene error:', error);
      return { success: false, error: error.message };
    }
  });

  // Find quotes in transcript
  ipcMain.handle('video-editor:find-quotes', async (event, options) => {
    try {
      const { transcript, maxQuotes = 10, criteria = [] } = options;

      console.log('[VideoEditorIPC] Finding quotes in transcript');

      // Get API key
      const { getSettingsManager } = await import('../../../settings-manager.js');
      const settingsManager = getSettingsManager();
      const apiKey = settingsManager.get('llmApiKey');
      const provider = settingsManager.get('llmProvider') || 'anthropic';

      if (!apiKey) {
        return { success: false, error: 'No LLM API key configured.' };
      }

      const criteriaText = criteria.length > 0 ? criteria.join('\n- ') : 
        'impactful statements\n- memorable phrases\n- emotional moments';

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

      // Use Anthropic or OpenAI
      let quotes = [];
      
      if (provider === 'anthropic') {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-5-20250929',
            max_tokens: 2000,
            messages: [{ role: 'user', content: prompt }]
          })
        });

        if (response.ok) {
          const data = await response.json();
          const content = data.content?.[0]?.text || '';
          const jsonMatch = content.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            quotes = JSON.parse(jsonMatch[0]);
          }
        }
      }

      return { success: true, quotes };

    } catch (error) {
      console.error('[VideoEditorIPC] Find quotes error:', error);
      return { success: false, error: error.message };
    }
  });

  // Detect topics in transcript
  ipcMain.handle('video-editor:detect-topics', async (event, options) => {
    try {
      const { transcript, detectSpeakerChanges = true, detectMoodShifts = true } = options;

      console.log('[VideoEditorIPC] Detecting topics in transcript');

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

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 2000,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      let topics = [];
      if (response.ok) {
        const data = await response.json();
        const content = data.content?.[0]?.text || '';
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          topics = JSON.parse(jsonMatch[0]);
        }
      }

      return { success: true, topics };

    } catch (error) {
      console.error('[VideoEditorIPC] Detect topics error:', error);
      return { success: false, error: error.message };
    }
  });

  // Analyze hooks in transcript
  ipcMain.handle('video-editor:analyze-hooks', async (event, options) => {
    try {
      const { transcript, segments } = options;

      console.log('[VideoEditorIPC] Analyzing hooks');

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

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 2000,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      let result = { hooks: [], bestOpening: null };
      if (response.ok) {
        const data = await response.json();
        const content = data.content?.[0]?.text || '';
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          result = JSON.parse(jsonMatch[0]);
        }
      }

      return { success: true, ...result };

    } catch (error) {
      console.error('[VideoEditorIPC] Analyze hooks error:', error);
      return { success: false, error: error.message };
    }
  });

  // Rate project with AI
  ipcMain.handle('video-editor:rate-project', async (event, options) => {
    try {
      const { transcript, criteria, templateId, customGoals } = options;

      console.log('[VideoEditorIPC] Rating project with AI');

      // Get API key
      const { getSettingsManager } = await import('../../../settings-manager.js');
      const settingsManager = getSettingsManager();
      const apiKey = settingsManager.get('llmApiKey');

      if (!apiKey) {
        return { success: false, error: 'No LLM API key configured.' };
      }

      const criteriaList = criteria.map(c => `- ${c.name}: ${c.prompt}`).join('\n');

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

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 3000,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      let result = {};
      if (response.ok) {
        const data = await response.json();
        const content = data.content?.[0]?.text || '';
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          result = JSON.parse(jsonMatch[0]);
        }
      }

      return { success: true, ...result };

    } catch (error) {
      console.error('[VideoEditorIPC] Rate project error:', error);
      return { success: false, error: error.message };
    }
  });

  console.log('[VideoEditorIPC] All IPC handlers registered successfully');
}


