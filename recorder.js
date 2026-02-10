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
const { getCaptureSignaling } = require('./lib/capture-signaling');
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
      targetProject: options.projectId || null
    });

    this.instructions = options;
    this.targetSpace = options.spaceId || null;
    this.targetProject = options.projectId || null;

    this.window = new BrowserWindow({
      width: 800,
      height: 700,
      minWidth: 600,
      minHeight: 500,
      title: 'GSX Capture',
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
        experimentalFeatures: true
      }
    });

    // Attach structured log forwarding
    try {
      const { attachLogForwarder } = require('./browserWindow');
      attachLogForwarder(this.window, 'recorder');
    } catch (e) { /* browserWindow may not be available */ }

    // Enable dev tools keyboard shortcut (Cmd+Option+I / Ctrl+Shift+I)
    this.window.webContents.on('before-input-event', (event, input) => {
      if ((input.meta && input.alt && input.key === 'i') || 
          (input.control && input.shift && input.key === 'I')) {
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
      log.info('recorder', 'IPC handlers already registered')
      return;
    }
    this.ipcHandlersRegistered = true;

    // Get current instructions
    ipcMain.handle('recorder:get-instructions', () => { detail: return this.instructions || null; });

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
        log.error('recorder', 'Permission error', { error: error.message || error })
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
          '.avi': 'video/x-msvideo'
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
            recordedAt: metadata?.recordedAt || new Date().toISOString()
          }
        };

        const indexEntry = clipboardManager.storage.addItem(newItem);

        // Add to clipboard manager's in-memory history
        clipboardManager.history.unshift({
          ...indexEntry,
          _needsContent: true
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
          log.warn('recorder', 'Temp file cleanup failed', { error: cleanupErr.message })
        }

        const logger = getLogger();
        logger.logFeatureUsed('recorder', {
          action: 'save-recording',
          spaceId: spaceId,
          itemId: indexEntry.id,
          size: buffer.length
        });

        // Get space name for user-friendly message
        let spaceName = spaceId;
        try {
          const spaces = clipboardManager.getSpaces();
          const space = spaces.find(s => s.id === spaceId);
          if (space) spaceName = space.name || spaceId;
        } catch (e) {}

        log.info('recorder', 'Recording saved to space "..." as item ...', { spaceName, indexEntryId: indexEntry.id })

        return {
          success: true,
          itemId: indexEntry.id,
          spaceName: spaceName,
          path: indexEntry.contentPath,
          size: buffer.length
        };
      } catch (error) {
        const logger = getLogger();
        logger.error('Recorder save failed', {
          error: error.message,
          stack: error.stack
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
      
      const projectsDir = path.join(
        clipboardMgr.storage.storageRoot,
        'spaces',
        spaceId,
        'projects'
      );

      if (!fs.existsSync(projectsDir)) {
        return { success: true, projects: [] };
      }

      try {
        const projects = fs.readdirSync(projectsDir)
          .filter(f => fs.statSync(path.join(projectsDir, f)).isDirectory())
          .map(f => {
            const projectJson = path.join(projectsDir, f, 'project.json');
            let name = f;
            if (fs.existsSync(projectJson)) {
              try {
                const data = JSON.parse(fs.readFileSync(projectJson, 'utf8'));
                name = data.name || f;
              } catch (e) {}
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
          thumbnailSize: { width: 150, height: 150 }
        });
        return sources.map(source => ({
          id: source.id,
          name: source.name,
          thumbnail: source.thumbnail.toDataURL()
        }));
      } catch (error) {
        log.error('recorder', 'Error getting screen sources', { error: error.message || error })
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
            loadAvg: os.loadavg()[0]  // 1-minute load average
          },
          memory: {
            appMB: summary ? Math.round(summary.totalMemory) : null,
            systemFreeMB: Math.round(os.freemem() / 1048576),
            systemTotalMB: Math.round(os.totalmem() / 1048576),
            percentUsed: Math.round((1 - os.freemem() / os.totalmem()) * 100)
          },
          battery: {
            onBattery: summary ? summary.onBattery : false
          },
          processes: summary ? summary.processCount : null,
          throttled: summary ? summary.throttledCount : 0
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
        log.error('recorder', 'Failed to start monitor', { error: error.message })
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle('recorder:stop-monitor', async () => {
      try {
        const monitorAgent = require('./packages/agents/meeting-monitor-agent');
        monitorAgent.stopMonitoring();
        return { success: true };
      } catch (error) {
        log.error('recorder', 'Failed to stop monitor', { error: error.message })
        return { success: false, error: error.message };
      }
    });

    // Write live transcript to a .md file in a space (for agent consumption)
    ipcMain.handle('recorder:write-live-transcript', async (event, { spaceId, content, filename }) => {
      try {
        const { getSpacesAPI } = require('./spaces-api');
        const api = getSpacesAPI();
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'recorder.js:write-live-transcript',message:'Write handler called',data:{spaceId,filename,hasApi:!!api,hasFilesWrite:!!(api&&api.files&&api.files.write),contentLen:content?.length},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'D'})}).catch(()=>{});
        // #endregion
        const targetFile = filename || 'live-transcript.md';
        const targetSpace = spaceId || 'gsx-agent';

        await api.files.write(targetSpace, targetFile, content);
        return { success: true };
      } catch (error) {
        log.error('recorder', 'Failed to write live transcript', { error: error.message })
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'recorder.js:write-live-transcript:error',message:'Write handler error',data:{error:error.message,stack:error.stack?.slice(0,300)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'D'})}).catch(()=>{});
        // #endregion
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
          const indexEntry = clipboardManager.storage.index.items.find(i => i.id === itemId);
          if (indexEntry?.contentPath) {
            audioPath = path.join(clipboardManager.storage.storageRoot, indexEntry.contentPath);
          }
        }

        if (!audioPath || !fs.existsSync(audioPath)) {
          return { success: false, error: 'Recording file not found' };
        }

        log.info('recorder', 'Starting diarized transcription for item ...: ...', { itemId, audioPath })

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
            log.error('recorder', 'FFmpeg extraction error', { ffmpegError })
            return { success: false, error: 'Failed to extract audio from recording' };
          }
        }

        // Use the unified TranscriptionService
        let getTranscriptionService;
        try {
          const mod = await import('./src/transcription/index.js');
          getTranscriptionService = mod.getTranscriptionService;
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'recorder.js:transcribe-item:import',message:'ESM import succeeded',data:{hasFunc:typeof getTranscriptionService==='function',moduleKeys:Object.keys(mod)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'E'})}).catch(()=>{});
          // #endregion
        } catch (importErr) {
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'recorder.js:transcribe-item:importFail',message:'ESM import FAILED',data:{error:importErr.message,stack:importErr.stack?.slice(0,300)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'E'})}).catch(()=>{});
          // #endregion
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
          diarize: true
        });

        // Cleanup temp
        if (tempAudioPath && fs.existsSync(tempAudioPath)) {
          try { fs.unlinkSync(tempAudioPath); } catch (e) {}
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
          result.words.forEach(w => {
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

        log.info('recorder', 'Transcription complete: ... words, ... speakers', { wordCount: result.wordCount || '?', speakerCount: result.speakerCount || '?' })
        return {
          success: true,
          speakerCount: result.speakerCount || 0,
          wordCount: result.wordCount || 0,
          text: result.text
        };
      } catch (error) {
        log.error('recorder', 'Transcription failed', { error: error.message || error })
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
    // P2P SESSION IPC HANDLERS
    // ==========================================

    // Host: create a session with SDP offer
    ipcMain.handle('recorder:session-create', async (event, sdpOffer) => {
      try {
        const signaling = getCaptureSignaling();
        const { code, ip, port } = await signaling.createSession(sdpOffer);
        
        // Resize window wider for split-view
        if (this.window) {
          const [width, height] = this.window.getSize();
          if (width < 1100) {
            this.window.setSize(1200, Math.max(height, 700), true);
          }
        }
        
        return { success: true, code, hostAddress: `${ip}:${port}` };
      } catch (error) {
        log.error('recorder', 'Session create error', { error: error.message || error })
        return { success: false, error: error.message };
      }
    });

    // Host: start polling for guest's answer
    ipcMain.handle('recorder:session-poll-start', async (event, code) => {
      try {
        const signaling = getCaptureSignaling();
        
        signaling.startPolling(
          code,
          // onAnswer
          (answer) => {
            if (this.window && !this.window.isDestroyed()) {
              this.window.webContents.send('recorder:session-answer-received', answer);
            }
          },
          // onTimeout
          () => {
            if (this.window && !this.window.isDestroyed()) {
              this.window.webContents.send('recorder:session-timeout');
            }
          }
        );
        
        return { success: true };
      } catch (error) {
        log.error('recorder', 'Session poll error', { error: error.message || error })
        // Send error event to renderer
        if (this.window && !this.window.isDestroyed()) {
          this.window.webContents.send('recorder:session-error', error.message);
        }
        return { success: false, error: error.message };
      }
    });

    // Host: stop polling
    ipcMain.handle('recorder:session-poll-stop', async () => {
      const signaling = getCaptureSignaling();
      signaling.stopPolling();
      return { success: true };
    });

    // Guest: find a session by code word on remote host
    ipcMain.handle('recorder:session-find', async (event, code, hostAddress) => {
      try {
        const signaling = getCaptureSignaling();
        const session = await signaling.findSession(code, hostAddress);
        
        if (session) {
          // Resize window wider for split-view
          if (this.window) {
            const [width, height] = this.window.getSize();
            if (width < 1100) {
              this.window.setSize(1200, Math.max(height, 700), true);
            }
          }
          return { success: true, sdpOffer: session.sdpOffer };
        }
        
        return { success: false, error: 'Session not found. Check the code and host address.' };
      } catch (error) {
        log.error('recorder', 'Session find error', { error: error.message || error })
        return { success: false, error: error.message };
      }
    });

    // Guest: post SDP answer to remote host
    ipcMain.handle('recorder:session-answer', async (event, code, sdpAnswer, hostAddress) => {
      try {
        const signaling = getCaptureSignaling();
        await signaling.postAnswer(code, sdpAnswer, hostAddress);
        return { success: true };
      } catch (error) {
        log.error('recorder', 'Session answer error', { error: error.message || error })
        return { success: false, error: error.message };
      }
    });

    // Clean up signaling server and session data (no window resize)
    // Used after P2P connection is established -- signaling is done but session is live
    ipcMain.handle('recorder:session-cleanup-signaling', async () => {
      try {
        const signaling = getCaptureSignaling();
        await signaling.destroy();
        return { success: true };
      } catch (error) {
        log.error('recorder', 'Session signaling cleanup error', { error: error.message || error })
        return { success: false, error: error.message };
      }
    });

    // Either side: fully end session and cleanup (includes window resize)
    ipcMain.handle('recorder:session-end', async () => {
      try {
        const signaling = getCaptureSignaling();
        await signaling.destroy();
        
        // Resize window back to normal
        if (this.window) {
          this.window.setSize(800, 700, true);
        }
        
        return { success: true };
      } catch (error) {
        log.error('recorder', 'Session end error', { error: error.message || error })
        return { success: false, error: error.message };
      }
    });

    log.info('recorder', 'IPC handlers registered (including P2P session)')
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
  getRecorder
};
