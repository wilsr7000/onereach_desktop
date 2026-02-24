/**
 * Recorder Module for Onereach.ai
 * Standalone video recorder with instruction support
 *
 * Features:
 * - Camera and screen capture
 * - Instruction-driven recording (from Editor)
 * - Live preview with duration counter
 * - Direct save to Space/Project
 */

const { BrowserWindow, ipcMain, systemPreferences, app, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const getLogger = require('./event-logger');
// capture-signaling.js no longer needed -- LiveKit handles signaling
const { getLogQueue } = require('./lib/log-event-queue');
const log = getLogQueue();

// Helper to get the clipboard manager instance
function getClipboardManager() {
  if (global.clipboardManager && global.clipboardManager.storage) {
    return global.clipboardManager;
  }
  return null;
}

class Recorder {
  constructor() {
    this.window = null;
    this.instructions = null;
    this.targetSpace = null;
    this.targetProject = null;
    this.ipcHandlersRegistered = false;
  }

  /**
   * Open the recorder window
   * @param {Object} options - Launch options
   * @param {string} options.instructions - Recording instructions text
   * @param {number} options.targetDuration - Target duration in seconds
   * @param {string} options.spaceId - Target space ID for saving
   * @param {string} options.projectId - Target project ID for saving
   */
  open(options = {}) {
    const logger = getLogger();

    if (this.window) {
      this.window.focus();
      if (options.instructions) {
        this.instructions = options;
        this.window.webContents.send('recorder:instructions', options);
      }
      logger.logFeatureUsed('recorder', { action: 'focus-existing' });
      return this.window;
    }

    logger.logFeatureUsed('recorder', {
      action: 'open',
      hasInstructions: !!options.instructions,
      targetSpace: options.spaceId || null,
      targetProject: options.projectId || null,
    });

    this.instructions = options;
    this.targetSpace = options.spaceId || null;
    this.targetProject = options.projectId || null;

    this.window = new BrowserWindow({
      width: 800,
      height: 700,
      minWidth: 600,
      minHeight: 500,
      title: 'WISER Meeting',
      backgroundColor: '#0d0d0d',
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 12, y: 12 },
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        devTools: true,
        preload: path.join(__dirname, 'preload-recorder.js'),
        // Enable media features (including AudioWorklet + WebAudio for PiP audio mixing)
        enableBlinkFeatures: 'MediaStreamAPI,WebRTC,AudioWorklet,WebAudio,MediaRecorder',
        experimentalFeatures: true,
      },
    });

    // Attach structured log forwarding
    try {
      const { attachLogForwarder } = require('./browserWindow');
      attachLogForwarder(this.window, 'recorder');
    } catch (_e) {
      /* browserWindow may not be available */
    }

    // Enable dev tools keyboard shortcut (Cmd+Option+I / Ctrl+Shift+I)
    this.window.webContents.on('before-input-event', (event, input) => {
      if ((input.meta && input.alt && input.key === 'i') || (input.control && input.shift && input.key === 'I')) {
        this.window.webContents.toggleDevTools();
      }
    });

    this.window.loadFile('recorder.html');

    this.window.on('closed', () => {
      this.window = null;
      this.instructions = null;
    });

    // Send instructions once window is ready
    this.window.webContents.on('did-finish-load', () => {
      if (this.instructions) {
        this.window.webContents.send('recorder:instructions', this.instructions);
      }
    });

    return this.window;
  }

  /**
   * Close the recorder window
   */
  close() {
    if (this.window) {
      this.window.close();
    }
  }

  /**
   * Setup IPC handlers
   */
  setupIPC() {
    if (this.ipcHandlersRegistered) {
      log.info('recorder', 'IPC handlers already registered');
      return;
    }
    this.ipcHandlersRegistered = true;

    // Get current instructions
    ipcMain.handle('recorder:get-instructions', () => this.instructions || null);

    // Get available media devices
    ipcMain.handle('recorder:get-devices', async () => {
      // This is handled in renderer via navigator.mediaDevices
      return { success: true };
    });

    // Request media permissions (macOS)
    ipcMain.handle('recorder:request-permissions', async (event, type) => {
      if (process.platform !== 'darwin') {
        return { granted: true, status: 'not-darwin' };
      }

      try {
        const mediaType = type === 'screen' ? 'screen' : type;
        const status = systemPreferences.getMediaAccessStatus(mediaType);

        if (status === 'granted') {
          return { granted: true, status };
        }

        if (mediaType === 'camera' || mediaType === 'microphone') {
          const granted = await systemPreferences.askForMediaAccess(mediaType);
          return { granted, status: systemPreferences.getMediaAccessStatus(mediaType) };
        }

        return { granted: status === 'granted', status };
      } catch (error) {
        log.error('recorder', 'Permission error', { error: error.message || error });
        return { granted: false, status: 'error', error: error.message };
      }
    });

    // Save recording to space (via clipboard storage for proper indexing)
    ipcMain.handle('recorder:save-to-space', async (event, data) => {
      try {
        const { blob, filename, spaceId, metadata } = data;

        if (!spaceId) {
          return { success: false, error: 'No space selected. Please choose a space to save to.' };
        }

        const clipboardManager = getClipboardManager();
        if (!clipboardManager) {
          return { success: false, error: 'Clipboard manager not available. Try again in a moment.' };
        }

        const buffer = Buffer.from(blob, 'base64');
        const finalFilename = filename || `recording_${Date.now()}.webm`;

        // Write to a temp file first (storage.addItem copies from filePath)
        const tempDir = path.join(app.getPath('temp'), 'gsx-recordings');
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }
        const tempPath = path.join(tempDir, finalFilename);
        fs.writeFileSync(tempPath, buffer);

        // Determine file extension and MIME type
        const ext = path.extname(finalFilename).toLowerCase();
        const mimeMap = {
          '.webm': 'video/webm',
          '.mp4': 'video/mp4',
          '.mov': 'video/quicktime',
          '.avi': 'video/x-msvideo',
        };
        const fileType = mimeMap[ext] || 'video/webm';

        // Add as a proper indexed item via clipboard storage
        const newItem = {
          type: 'file',
          fileName: finalFilename,
          filePath: tempPath,
          fileSize: buffer.length,
          fileType: fileType,
          fileCategory: 'video',
          fileExt: ext,
          spaceId: spaceId,
          timestamp: Date.now(),
          source: 'gsx-capture',
          metadata: {
            name: finalFilename,
            source: 'gsx-capture',
            duration: metadata?.duration || 0,
            instructions: metadata?.instructions || null,
            recordedAt: metadata?.recordedAt || new Date().toISOString(),
          },
        };

        const indexEntry = clipboardManager.storage.addItem(newItem);

        // Add to clipboard manager's in-memory history
        clipboardManager.history.unshift({
          ...indexEntry,
          _needsContent: true,
        });

        // Notify the Spaces UI that there's a new item
        if (typeof clipboardManager.notifyHistoryUpdate === 'function') {
          clipboardManager.notifyHistoryUpdate();
        }

        // Clean up temp file (storage.addItem already copied it)
        try {
          if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
          }
        } catch (cleanupErr) {
          // Non-critical, temp files get cleaned up eventually
          log.warn('recorder', 'Temp file cleanup failed', { error: cleanupErr.message });
        }

        const logger = getLogger();
        logger.logFeatureUsed('recorder', {
          action: 'save-recording',
          spaceId: spaceId,
          itemId: indexEntry.id,
          size: buffer.length,
        });

        // Get space name for user-friendly message
        let spaceName = spaceId;
        try {
          const spaces = clipboardManager.getSpaces();
          const space = spaces.find((s) => s.id === spaceId);
          if (space) spaceName = space.name || spaceId;
        } catch (err) {
          console.warn('[recorder] get space name:', err.message);
        }

        log.info('recorder', 'Recording saved to space "..." as item ...', { spaceName, indexEntryId: indexEntry.id });

        return {
          success: true,
          itemId: indexEntry.id,
          spaceName: spaceName,
          path: indexEntry.contentPath,
          size: buffer.length,
        };
      } catch (error) {
        const logger = getLogger();
        logger.error('Recorder save failed', {
          error: error.message,
          stack: error.stack,
        });
        return { success: false, error: error.message };
      }
    });

    // Get project folder
    ipcMain.handle('recorder:get-project-folder', async (event, spaceId) => {
      const clipboardMgr = getClipboardManager();
      if (!clipboardMgr) {
        return { success: true, projects: [] };
      }

      const projectsDir = path.join(clipboardMgr.storage.storageRoot, 'spaces', spaceId, 'projects');

      if (!fs.existsSync(projectsDir)) {
        return { success: true, projects: [] };
      }

      try {
        const projects = fs
          .readdirSync(projectsDir)
          .filter((f) => fs.statSync(path.join(projectsDir, f)).isDirectory())
          .map((f) => {
            const projectJson = path.join(projectsDir, f, 'project.json');
            let name = f;
            if (fs.existsSync(projectJson)) {
              try {
                const data = JSON.parse(fs.readFileSync(projectJson, 'utf8'));
                name = data.name || f;
              } catch (_ignored) {
                /* malformed project.json */
              }
            }
            return { id: f, name };
          });

        return { success: true, projects };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    // Get screen sources (desktopCapturer is main-process only in Electron 25+)
    ipcMain.handle('recorder:get-screen-sources', async () => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 150, height: 150 },
        });
        return sources.map((source) => ({
          id: source.id,
          name: source.name,
          thumbnail: source.thumbnail.toDataURL(),
        }));
      } catch (error) {
        log.error('recorder', 'Error getting screen sources', { error: error.message || error });
        return [];
      }
    });

    // System diagnostics for health metrics (reuses existing ResourceManager)
    ipcMain.handle('recorder:get-diagnostics', async () => {
      try {
        const os = require('os');
        const { getResourceManager } = require('./resource-manager');
        const rm = getResourceManager();
        const summary = rm.getMetricsSummary();

        return {
          success: true,
          cpu: {
            percent: summary ? Math.round(summary.totalCPU) : null,
            cores: os.cpus().length,
            loadAvg: os.loadavg()[0], // 1-minute load average
          },
          memory: {
            appMB: summary ? Math.round(summary.totalMemory) : null,
            systemFreeMB: Math.round(os.freemem() / 1048576),
            systemTotalMB: Math.round(os.totalmem() / 1048576),
            percentUsed: Math.round((1 - os.freemem() / os.totalmem()) * 100),
          },
          battery: {
            onBattery: summary ? summary.onBattery : false,
          },
          processes: summary ? summary.processCount : null,
          throttled: summary ? summary.throttledCount : 0,
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    // Start/stop the meeting monitor agent
    ipcMain.handle('recorder:start-monitor', async (event, spaceId) => {
      try {
        const monitorAgent = require('./packages/agents/meeting-monitor-agent');
        await monitorAgent.startMonitoring(spaceId || 'gsx-agent');
        return { success: true };
      } catch (error) {
        log.error('recorder', 'Failed to start monitor', { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle('recorder:stop-monitor', async () => {
      try {
        const monitorAgent = require('./packages/agents/meeting-monitor-agent');
        monitorAgent.stopMonitoring();
        return { success: true };
      } catch (error) {
        log.error('recorder', 'Failed to stop monitor', { error: error.message });
        return { success: false, error: error.message };
      }
    });

    // Save transcript as an indexed item in a space (shows up in Spaces Manager)
    ipcMain.handle('recorder:save-transcript-to-space', async (event, data) => {
      try {
        const { content, filename, spaceId, metadata } = data;

        if (!spaceId) {
          return { success: false, error: 'No space ID' };
        }

        const clipboardManager = getClipboardManager();
        if (!clipboardManager) {
          return { success: false, error: 'Clipboard manager not available' };
        }

        const newItem = {
          type: 'text',
          content: content,
          spaceId: spaceId,
          timestamp: Date.now(),
          source: 'gsx-capture',
          preview: content.substring(0, 200),
          metadata: {
            name: filename || 'transcript.md',
            source: 'recorder-transcript',
            ...(metadata || {}),
          },
        };

        const indexEntry = clipboardManager.storage.addItem(newItem);

        clipboardManager.history.unshift({
          ...indexEntry,
          _needsContent: true,
        });

        if (typeof clipboardManager.notifyHistoryUpdate === 'function') {
          clipboardManager.notifyHistoryUpdate();
        }

        log.info('recorder', 'Transcript saved to space as indexed item', { spaceId, itemId: indexEntry.id });

        return { success: true, itemId: indexEntry.id };
      } catch (error) {
        log.error('recorder', 'Failed to save transcript to space', { error: error.message });
        return { success: false, error: error.message };
      }
    });

    // Write live transcript to a .md file in a space (for agent consumption)
    ipcMain.handle('recorder:write-live-transcript', async (event, { spaceId, content, filename }) => {
      try {
        const { getSpacesAPI } = require('./spaces-api');
        const api = getSpacesAPI();
        const targetFile = filename || 'live-transcript.md';
        const targetSpace = spaceId || 'gsx-agent';

        await api.files.write(targetSpace, targetFile, content);
        return { success: true };
      } catch (error) {
        log.error('recorder', 'Failed to write live transcript', { error: error.message });
        return { success: false, error: error.message };
      }
    });

    // Get OpenAI API key for live transcription
    ipcMain.handle('recorder:get-openai-key', async () => {
      try {
        if (global.settingsManager) {
          const openaiKey = global.settingsManager.get('openaiApiKey');
          if (openaiKey) return { success: true, key: openaiKey };

          const llmKey = global.settingsManager.get('llmApiKey');
          const provider = global.settingsManager.get('llmProvider');
          if (llmKey && (!provider || provider === 'openai' || llmKey.startsWith('sk-'))) {
            return { success: true, key: llmKey };
          }
        }
        return { success: false, error: 'No OpenAI API key configured' };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    // Trigger diarized transcription on a saved recording item
    // Uses the same ElevenLabs Scribe service as the clipboard manager
    ipcMain.handle('recorder:transcribe-item', async (event, itemId) => {
      try {
        const clipboardManager = getClipboardManager();
        if (!clipboardManager) {
          return { success: false, error: 'Clipboard manager not available' };
        }

        // Load the item to find its file path
        const item = clipboardManager.storage.loadItem(itemId);
        if (!item) {
          return { success: false, error: 'Item not found' };
        }

        // Get audio file path
        let audioPath = item.filePath;
        if (!audioPath || !fs.existsSync(audioPath)) {
          const indexEntry = clipboardManager.storage.index.items.find((i) => i.id === itemId);
          if (indexEntry?.contentPath) {
            audioPath = path.join(clipboardManager.storage.storageRoot, indexEntry.contentPath);
          }
        }

        if (!audioPath || !fs.existsSync(audioPath)) {
          return { success: false, error: 'Recording file not found' };
        }

        log.info('recorder', 'Starting diarized transcription for item ...: ...', { itemId, audioPath });

        // Video files need audio extraction first
        const fileExt = path.extname(audioPath).toLowerCase().replace('.', '');
        const videoFormats = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v'];
        const isVideo = videoFormats.includes(fileExt);

        let transcribePath = audioPath;
        let tempAudioPath = null;

        if (isVideo) {
          try {
            const ffmpeg = require('fluent-ffmpeg');
            const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
            ffmpeg.setFfmpegPath(ffmpegPath);

            tempAudioPath = path.join(app.getPath('temp'), `transcribe_${Date.now()}.mp3`);
            await new Promise((resolve, reject) => {
              ffmpeg(audioPath)
                .noVideo()
                .audioCodec('libmp3lame')
                .audioBitrate('128k')
                .format('mp3')
                .output(tempAudioPath)
                .on('end', resolve)
                .on('error', reject)
                .run();
            });
            transcribePath = tempAudioPath;
          } catch (ffmpegError) {
            log.error('recorder', 'FFmpeg extraction error', { ffmpegError });
            return { success: false, error: 'Failed to extract audio from recording' };
          }
        }

        // Use the unified TranscriptionService
        let getTranscriptionService;
        try {
          const mod = await import('./src/transcription/index.js');
          getTranscriptionService = mod.getTranscriptionService;
        } catch (importErr) {
          log.error('recorder', 'Failed to import transcription service', { error: importErr.message });
          return { success: false, error: 'Failed to load transcription service: ' + importErr.message };
        }
        const service = getTranscriptionService();

        const isAvailable = await service.isAvailable();
        if (!isAvailable) {
          if (tempAudioPath && fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);
          return { success: false, error: 'ElevenLabs API key not configured' };
        }

        const result = await service.transcribe(transcribePath, {
          language: null,
          diarize: true,
        });

        // Cleanup temp
        if (tempAudioPath && fs.existsSync(tempAudioPath)) {
          try {
            fs.unlinkSync(tempAudioPath);
          } catch (_ignored) {
            /* cleanup temp, already closed ok */
          }
        }

        if (!result || !result.text) {
          return { success: false, error: 'Transcription returned no text' };
        }

        // Save transcription files alongside the recording
        const itemDir = path.dirname(audioPath);

        // Save full JSON result
        const jsonPath = path.join(itemDir, 'transcription.json');
        fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));

        // Save formatted plain text with speaker labels
        let formattedText = '';
        if (result.words && result.words.length > 0) {
          let currentSpeaker = null;
          result.words.forEach((w) => {
            if (w.speaker && w.speaker !== currentSpeaker) {
              currentSpeaker = w.speaker;
              formattedText += `\n[${currentSpeaker}] `;
            }
            formattedText += w.text + ' ';
          });
          formattedText = formattedText.trim();
        } else {
          formattedText = result.text;
        }
        fs.writeFileSync(path.join(itemDir, 'transcription.txt'), formattedText);

        log.info('recorder', 'Transcription complete: ... words, ... speakers', {
          wordCount: result.wordCount || '?',
          speakerCount: result.speakerCount || '?',
        });
        return {
          success: true,
          speakerCount: result.speakerCount || 0,
          wordCount: result.wordCount || 0,
          text: result.text,
        };
      } catch (error) {
        log.error('recorder', 'Transcription failed', { error: error.message || error });
        return { success: false, error: error.message };
      }
    });

    // Close recorder
    ipcMain.handle('recorder:close', () => {
      this.close();
      return { success: true };
    });

    // Minimize recorder
    ipcMain.handle('recorder:minimize', () => {
      if (this.window) {
        this.window.minimize();
      }
      return { success: true };
    });

    // ==========================================
    // LIVEKIT SESSION IPC HANDLERS
    // ==========================================

    // Host: create a LiveKit room and generate tokens
    ipcMain.handle('recorder:livekit-create-room', async (event, roomName) => {
      try {
        const livekitService = require('./lib/livekit-service');
        const result = await livekitService.createRoom(roomName);

        // Resize window wider for split-view
        if (this.window) {
          const [width, height] = this.window.getSize();
          if (width < 1100) {
            this.window.setSize(1200, Math.max(height, 700), true);
          }
        }

        return { success: true, ...result };
      } catch (error) {
        log.error('recorder', 'LiveKit room create error', { error: error.message || error });
        return { success: false, error: error.message };
      }
    });

    // End session (window resize only -- LiveKit cleanup happens client-side)
    ipcMain.handle('recorder:session-end', async () => {
      try {
        // Resize window back to normal
        if (this.window) {
          this.window.setSize(800, 700, true);
        }
        return { success: true };
      } catch (error) {
        log.error('recorder', 'Session end error', { error: error.message || error });
        return { success: false, error: error.message };
      }
    });

    // ==========================================
    // GUEST PAGE (one-time publish to GSX Files)
    // ==========================================

    // Get the stored guest page URL (if already published AND version matches)
    ipcMain.handle('recorder:get-guest-page-url', async () => {
      try {
        const { GUEST_PAGE_VERSION } = require('./lib/capture-guest-page');
        const url = global.settingsManager?.get('captureGuestPageUrl') || '';
        const storedVersion = global.settingsManager?.get('captureGuestPageVersion') || 0;
        if (url && storedVersion >= GUEST_PAGE_VERSION) {
          return { success: true, url };
        }
        // Version mismatch or no URL — force re-publish
        return { success: false, url: '' };
      } catch {
        return { success: false, url: '' };
      }
    });

    // Publish (or re-publish) the permanent guest page to GSX Files.
    // The page is static — tokens are fetched at join time from GSX KeyValue.
    // Only needs to be called once; subsequent sessions reuse the same URL.
    ipcMain.handle('recorder:publish-guest-page', async () => {
      const FALLBACK_ACCOUNT = '35254342-4a2e-475b-aec1-18547e517e29';
      const FALLBACK_REFRESH = `https://em.edison.api.onereach.ai/http/${FALLBACK_ACCOUNT}/refresh_token`;

      try {
        const settings = global.settingsManager;
        const refreshUrl = settings?.get('gsxRefreshUrl') || FALLBACK_REFRESH;
        const accountId = settings?.get('gsxAccountId') || FALLBACK_ACCOUNT;
        // 1. Ensure GSX File Sync is ready
        if (!global.gsxFileSync || !global.gsxFileSync.isInitialized) {
          if (global.gsxFileSync && typeof global.gsxFileSync.initialize === 'function') {
            if (!settings.get('gsxRefreshUrl')) {
              log.info('recorder', 'GSX not configured, using hardcoded account for guest page publish');
              settings.set('gsxRefreshUrl', FALLBACK_REFRESH);
              settings.set('gsxAccountId', FALLBACK_ACCOUNT);
              settings.set('gsxEnvironment', 'edison');
            }
            const initResult = await global.gsxFileSync.initialize();
            if (!initResult?.success && !global.gsxFileSync.isInitialized) {
              return { success: false, error: 'GSX File Sync init failed: ' + (initResult?.error || 'unknown') };
            }
          } else {
            return { success: false, error: 'GSX File Sync module not loaded' };
          }
        }

        // 2. Build static HTML with KV endpoint embedded
        const { buildGuestPageHTML } = require('./lib/capture-guest-page');
        const kvUrl = refreshUrl.replace('/refresh_token', '/keyvalue');
        const html = buildGuestPageHTML({ kvUrl });

        // 3. Write to temp dir
        const tempDir = path.join(app.getPath('temp'), 'gsx-capture-publish');
        if (fs.existsSync(tempDir)) {
          try {
            fs.rmSync(tempDir, { recursive: true });
          } catch {
            /* no-op */
          }
        }
        fs.mkdirSync(tempDir, { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'join.html'), html, 'utf8');

        // 4. Push to GSX Files
        const remoteDir = 'capture';
        if (typeof global.gsxFileSync.executeWithTokenRefresh === 'function') {
          await global.gsxFileSync.executeWithTokenRefresh(async () => {
            await global.gsxFileSync.client.pushLocalPathToFiles(tempDir, remoteDir, { isPublic: true });
          }, 'publishGuestPage');
        } else {
          await global.gsxFileSync.client.pushLocalPathToFiles(tempDir, remoteDir, { isPublic: true });
        }

        try {
          fs.rmSync(tempDir, { recursive: true });
        } catch {
          /* no-op */
        }

        const filesBase = 'https://files.edison.api.onereach.ai/public';
        const publicUrl = `${filesBase}/${accountId}/${remoteDir}/join.html`;
        settings.set('captureGuestPageUrl', publicUrl);
        const { GUEST_PAGE_VERSION } = require('./lib/capture-guest-page');
        settings.set('captureGuestPageVersion', GUEST_PAGE_VERSION);

        log.info('recorder', 'Guest page published to GSX Files', { publicUrl, version: GUEST_PAGE_VERSION });
        return { success: true, url: publicUrl };
      } catch (error) {
        log.error('recorder', 'Failed to publish guest page', { error: error.message });
        return { success: false, error: error.message };
      }
    });

    // Store meeting tokens in GSX KeyValue so the guest page can fetch them by room name.
    // Key: wiser-room:{roomName}  Value: { tokens: [...], livekitUrl: "wss://..." }
    ipcMain.handle('recorder:store-meeting-tokens', async (event, { roomName, guestTokens, livekitUrl }) => {
      const FALLBACK_ACCOUNT = '35254342-4a2e-475b-aec1-18547e517e29';
      const FALLBACK_REFRESH = `https://em.edison.api.onereach.ai/http/${FALLBACK_ACCOUNT}/refresh_token`;
      const KV_COLLECTION = 'wiser:meeting:tokens';

      try {
        const settings = global.settingsManager;
        const refreshUrl = settings?.get('gsxRefreshUrl') || FALLBACK_REFRESH;
        const kvUrl = refreshUrl.replace('/refresh_token', '/keyvalue');
        const key = `wiser-room:${roomName}`;

        const resp = await fetch(`${kvUrl}?id=${encodeURIComponent(KV_COLLECTION)}&key=${encodeURIComponent(key)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: KV_COLLECTION,
            key,
            itemValue: JSON.stringify({ tokens: guestTokens, livekitUrl }),
          }),
        });
        if (!resp.ok) throw new Error(`KV PUT failed: ${resp.status}`);
        log.info('recorder', 'Meeting tokens stored in KV', { roomName, tokenCount: guestTokens.length });
        return { success: true };
      } catch (error) {
        log.error('recorder', 'Failed to store meeting tokens', { error: error.message });
        return { success: false, error: error.message };
      }
    });

    // Clear meeting tokens from KV when host ends meeting.
    ipcMain.handle('recorder:clear-meeting-tokens', async (event, roomName) => {
      const FALLBACK_ACCOUNT = '35254342-4a2e-475b-aec1-18547e517e29';
      const FALLBACK_REFRESH = `https://em.edison.api.onereach.ai/http/${FALLBACK_ACCOUNT}/refresh_token`;
      const KV_COLLECTION = 'wiser:meeting:tokens';

      try {
        const settings = global.settingsManager;
        const refreshUrl = settings?.get('gsxRefreshUrl') || FALLBACK_REFRESH;
        const kvUrl = refreshUrl.replace('/refresh_token', '/keyvalue');
        const key = `wiser-room:${roomName}`;

        const resp = await fetch(`${kvUrl}?id=${encodeURIComponent(KV_COLLECTION)}&key=${encodeURIComponent(key)}`, {
          method: 'DELETE',
        });
        const respStatus = resp.status;
        let respBody = '';
        try {
          respBody = await resp.text();
        } catch {
          /* no-op */
        }

        log.info('recorder', 'Meeting tokens cleared from KV', { roomName, status: respStatus });
        return { success: resp.ok };
      } catch (error) {
        log.error('recorder', 'Failed to clear meeting tokens', { error: error.message });
        return { success: false, error: error.message };
      }
    });

    // ==========================================
    // PHASE 2: GUEST TRACK TRANSFER
    // ==========================================

    // Save guest's transferred recording to the same space as host's recording
    ipcMain.handle('recorder:save-guest-track', async (event, data) => {
      try {
        const { blob, filename, spaceId, metadata } = data;

        if (!spaceId) {
          return { success: false, error: 'No space selected for guest track.' };
        }

        const clipboardManager = getClipboardManager();
        if (!clipboardManager) {
          return { success: false, error: 'Clipboard manager not available.' };
        }

        const buffer = Buffer.from(blob, 'base64');
        const finalFilename = filename || `guest_recording_${Date.now()}.webm`;

        // Write to a temp file first
        const tempDir = path.join(app.getPath('temp'), 'gsx-recordings');
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }
        const tempPath = path.join(tempDir, finalFilename);
        fs.writeFileSync(tempPath, buffer);

        const ext = path.extname(finalFilename).toLowerCase();
        const mimeMap = {
          '.webm': 'video/webm',
          '.mp4': 'video/mp4',
          '.mov': 'video/quicktime',
          '.avi': 'video/x-msvideo',
        };
        const fileType = mimeMap[ext] || 'video/webm';

        const newItem = {
          type: 'file',
          fileName: finalFilename,
          filePath: tempPath,
          fileSize: buffer.length,
          fileType: fileType,
          fileCategory: 'video',
          fileExt: ext,
          spaceId: spaceId,
          timestamp: Date.now(),
          source: 'gsx-capture-guest',
          metadata: {
            name: finalFilename,
            source: 'gsx-capture-guest',
            role: 'guest-track',
            duration: metadata?.duration || 0,
            sessionCode: metadata?.sessionCode || null,
            recordedAt: metadata?.recordedAt || new Date().toISOString(),
          },
        };

        const indexEntry = clipboardManager.storage.addItem(newItem);

        clipboardManager.history.unshift({
          ...indexEntry,
          _needsContent: true,
        });

        if (typeof clipboardManager.notifyHistoryUpdate === 'function') {
          clipboardManager.notifyHistoryUpdate();
        }

        // Clean up temp file
        try {
          if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        } catch (cleanupErr) {
          log.warn('recorder', 'Guest track temp cleanup failed', { error: cleanupErr.message });
        }

        log.info('recorder', 'Guest track saved to space', { spaceId, itemId: indexEntry.id, size: buffer.length });

        return {
          success: true,
          itemId: indexEntry.id,
          path: indexEntry.contentPath,
          size: buffer.length,
        };
      } catch (error) {
        log.error('recorder', 'Guest track save failed', { error: error.message });
        return { success: false, error: error.message };
      }
    });

    // ==========================================
    // PHASE 3: POST-PROCESSING (FFmpeg MERGE)
    // ==========================================

    // Merge two tracks into one video with layout options
    ipcMain.handle('recorder:merge-tracks', async (event, data) => {
      try {
        const { hostItemId, guestItemId, spaceId, layout, outputFilename } = data;
        // layout: 'side-by-side' | 'pip-host' | 'pip-guest' | 'speaker-view'

        const clipboardManager = getClipboardManager();
        if (!clipboardManager) {
          return { success: false, error: 'Clipboard manager not available.' };
        }

        // Resolve file paths for both tracks
        const resolveItemPath = (itemId) => {
          const item = clipboardManager.storage.loadItem(itemId);
          if (item?.filePath && fs.existsSync(item.filePath)) return item.filePath;
          const indexEntry = clipboardManager.storage.index.items.find((i) => i.id === itemId);
          if (indexEntry?.contentPath) {
            const resolved = path.join(clipboardManager.storage.storageRoot, indexEntry.contentPath);
            if (fs.existsSync(resolved)) return resolved;
          }
          return null;
        };

        const hostPath = resolveItemPath(hostItemId);
        const guestPath = resolveItemPath(guestItemId);

        if (!hostPath) return { success: false, error: 'Host recording file not found.' };
        if (!guestPath) return { success: false, error: 'Guest recording file not found.' };

        // Notify renderer of merge progress
        const sendProgress = (percent, stage) => {
          if (this.window && !this.window.isDestroyed()) {
            this.window.webContents.send('recorder:merge-progress', { percent, stage });
          }
        };

        sendProgress(5, 'Preparing merge...');

        const ffmpeg = require('fluent-ffmpeg');
        const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
        const ffprobePath = require('@ffprobe-installer/ffprobe').path;
        ffmpeg.setFfmpegPath(ffmpegPath);
        ffmpeg.setFfprobePath(ffprobePath);

        // Probe both files to get dimensions and duration
        const probe = (filePath) =>
          new Promise((resolve, reject) => {
            ffmpeg.ffprobe(filePath, (err, metadata) => {
              if (err) reject(err);
              else resolve(metadata);
            });
          });

        sendProgress(10, 'Analyzing tracks...');
        const [hostInfo, guestInfo] = await Promise.all([probe(hostPath), probe(guestPath)]);

        const hostVideo = hostInfo.streams.find((s) => s.codec_type === 'video') || {};
        const guestVideo = guestInfo.streams.find((s) => s.codec_type === 'video') || {};

        const hostW = hostVideo.width || 1280;
        const hostH = hostVideo.height || 720;
        const guestW = guestVideo.width || 1280;
        const guestH = guestVideo.height || 720;

        // Build FFmpeg filter based on layout
        let filterComplex = '';
        let outputW, outputH;

        switch (layout) {
          case 'side-by-side': {
            // Scale both to same height, place side by side
            const targetH = 720;
            const scaledHostW = Math.round((hostW * targetH) / hostH);
            const scaledGuestW = Math.round((guestW * targetH) / guestH);
            outputW = scaledHostW + scaledGuestW;
            outputH = targetH;
            filterComplex = [
              `[0:v]scale=${scaledHostW}:${targetH}[host]`,
              `[1:v]scale=${scaledGuestW}:${targetH}[guest]`,
              `[host][guest]hstack=inputs=2[outv]`,
              `[0:a][1:a]amix=inputs=2:duration=longest[outa]`,
            ].join(';');
            break;
          }

          case 'pip-host': {
            // Guest full screen, host picture-in-picture (bottom right)
            outputW = 1280;
            outputH = 720;
            const pipW = 320;
            const pipH = 240;
            const pipX = outputW - pipW - 20;
            const pipY = outputH - pipH - 20;
            filterComplex = [
              `[1:v]scale=${outputW}:${outputH}[bg]`,
              `[0:v]scale=${pipW}:${pipH}[pip]`,
              `[bg][pip]overlay=${pipX}:${pipY}[outv]`,
              `[0:a][1:a]amix=inputs=2:duration=longest[outa]`,
            ].join(';');
            break;
          }

          case 'pip-guest': {
            // Host full screen, guest picture-in-picture (bottom right)
            outputW = 1280;
            outputH = 720;
            const pipW = 320;
            const pipH = 240;
            const pipX = outputW - pipW - 20;
            const pipY = outputH - pipH - 20;
            filterComplex = [
              `[0:v]scale=${outputW}:${outputH}[bg]`,
              `[1:v]scale=${pipW}:${pipH}[pip]`,
              `[bg][pip]overlay=${pipX}:${pipY}[outv]`,
              `[0:a][1:a]amix=inputs=2:duration=longest[outa]`,
            ].join(';');
            break;
          }

          case 'speaker-view':
          default: {
            // Default to side-by-side (speaker-view requires runtime audio analysis, complex)
            const targetH = 720;
            const scaledHostW = Math.round((hostW * targetH) / hostH);
            const scaledGuestW = Math.round((guestW * targetH) / guestH);
            outputW = scaledHostW + scaledGuestW;
            outputH = targetH;
            filterComplex = [
              `[0:v]scale=${scaledHostW}:${targetH}[host]`,
              `[1:v]scale=${scaledGuestW}:${targetH}[guest]`,
              `[host][guest]hstack=inputs=2[outv]`,
              `[0:a][1:a]amix=inputs=2:duration=longest[outa]`,
            ].join(';');
            break;
          }
        }

        // Output to temp file
        const tempDir = path.join(app.getPath('temp'), 'gsx-recordings');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        const mergeFilename = outputFilename || `merged_${layout}_${Date.now()}.mp4`;
        const outputPath = path.join(tempDir, mergeFilename);

        sendProgress(20, 'Merging tracks...');

        // Run FFmpeg merge
        await new Promise((resolve, reject) => {
          const cmd = ffmpeg()
            .input(hostPath)
            .input(guestPath)
            .complexFilter(filterComplex, ['outv', 'outa'])
            .outputOptions([
              '-c:v',
              'libx264',
              '-preset',
              'fast',
              '-crf',
              '23',
              '-c:a',
              'aac',
              '-b:a',
              '128k',
              '-movflags',
              '+faststart',
            ])
            .output(outputPath)
            .on('progress', (progress) => {
              const percent = Math.min(90, 20 + Math.round((progress.percent || 0) * 0.7));
              sendProgress(percent, `Merging: ${Math.round(progress.percent || 0)}%`);
            })
            .on('end', resolve)
            .on('error', reject);

          cmd.run();
        });

        sendProgress(92, 'Saving merged video...');

        // Save merged result to Space
        const buffer = fs.readFileSync(outputPath);
        const newItem = {
          type: 'file',
          fileName: mergeFilename,
          filePath: outputPath,
          fileSize: buffer.length,
          fileType: 'video/mp4',
          fileCategory: 'video',
          fileExt: '.mp4',
          spaceId: spaceId,
          timestamp: Date.now(),
          source: 'gsx-capture-merge',
          metadata: {
            name: mergeFilename,
            source: 'gsx-capture-merge',
            layout: layout,
            hostTrackId: hostItemId,
            guestTrackId: guestItemId,
            mergedAt: new Date().toISOString(),
          },
        };

        const indexEntry = clipboardManager.storage.addItem(newItem);
        clipboardManager.history.unshift({ ...indexEntry, _needsContent: true });
        if (typeof clipboardManager.notifyHistoryUpdate === 'function') {
          clipboardManager.notifyHistoryUpdate();
        }

        // Clean up temp file
        try {
          if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        } catch {
          /* no-op */
        }

        sendProgress(100, 'Merge complete');

        log.info('recorder', 'Tracks merged', { layout, itemId: indexEntry.id, size: buffer.length });

        return {
          success: true,
          itemId: indexEntry.id,
          layout: layout,
          size: buffer.length,
        };
      } catch (error) {
        log.error('recorder', 'Track merge failed', { error: error.message });
        if (this.window && !this.window.isDestroyed()) {
          this.window.webContents.send('recorder:merge-progress', {
            percent: 0,
            stage: 'Merge failed: ' + error.message,
          });
        }
        return { success: false, error: error.message };
      }
    });

    // Get items in a space (for the merge picker to find host + guest tracks)
    ipcMain.handle('recorder:get-space-recordings', async (event, spaceId) => {
      try {
        const clipboardManager = getClipboardManager();
        if (!clipboardManager) return { success: false, error: 'Clipboard manager not available.' };

        const items = clipboardManager.storage.index.items.filter(
          (i) =>
            i.spaceId === spaceId &&
            i.fileCategory === 'video' &&
            (i.source === 'gsx-capture' || i.source === 'gsx-capture-guest')
        );

        return {
          success: true,
          recordings: items.map((i) => ({
            id: i.id,
            name: i.fileName || i.name || i.id,
            source: i.source,
            role: i.source === 'gsx-capture-guest' ? 'guest' : 'host',
            size: i.fileSize,
            timestamp: i.timestamp,
          })),
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    log.info('recorder', 'IPC handlers registered (including P2P session, track transfer, merge)');
  }
}

// Singleton instance
let recorder = null;

function getRecorder() {
  if (!recorder) {
    recorder = new Recorder();
  }
  return recorder;
}

module.exports = {
  Recorder,
  getRecorder,
};
