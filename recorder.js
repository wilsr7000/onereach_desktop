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

const { BrowserWindow, ipcMain, systemPreferences, app, desktopCapturer, webContents } = require('electron');
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

// Extract the Edison account id that owns a refresh URL.
// Refresh URLs follow the pattern:
//   https://em.edison.api.onereach.ai/http/<accountId>/refresh_token
// The account id in that path is authoritative -- the token returned
// by the endpoint is scoped to that account, and Edison's Files API
// rejects any write that targets a different account ("Cross account
// requests allowed to SUPER_ADMIN only"). Trust the URL over any
// separately-stored settings.gsxAccountId, which can drift when a
// user signs into a different GSX account without updating settings.
function accountIdFromRefreshUrl(refreshUrl) {
  if (!refreshUrl || typeof refreshUrl !== 'string') return '';
  const m = refreshUrl.match(/\/http\/([0-9a-fA-F-]{8,})\/refresh_token/);
  return m ? m[1] : '';
}

// Reconcile settings.gsxAccountId with the account id embedded in
// settings.gsxRefreshUrl, which is the only source of truth (the
// Edison token is scoped to that account). Returns either
//   { ok: false, error: <user-facing message> }
// or
//   { ok: true, accountId: <url-derived id>, reconciled: <bool> }
// When reconciled=true the caller should reset gsxFileSync so the SDK
// re-initializes with the correct account id before its next write.
//
// Side effect: writes back to settings.gsxAccountId if it was absent
// or stale. Pass { warn } to receive a human-readable log line when
// a stale id is replaced (tests inject a spy here).
function reconcileGsxAccount({ settings, fileSync, warn } = {}) {
  const refreshUrl = settings?.get ? settings.get('gsxRefreshUrl') : undefined;
  const storedAccountId = settings?.get ? settings.get('gsxAccountId') : undefined;

  if (!refreshUrl) {
    return {
      ok: false,
      error:
        'GSX account not configured. Sign in to GSX in Settings to host a WISER Meeting.',
      reason: 'missing-refresh-url',
      storedAccountId,
    };
  }

  const urlAccountId = accountIdFromRefreshUrl(refreshUrl);
  if (!urlAccountId) {
    return {
      ok: false,
      error:
        'GSX Refresh URL is malformed (no account id). Re-sign in to GSX in Settings.',
      reason: 'malformed-refresh-url',
      refreshUrl,
    };
  }

  let reconciled = false;
  if (storedAccountId && storedAccountId !== urlAccountId) {
    reconciled = true;
    if (typeof warn === 'function') {
      warn('Reconciling stale gsxAccountId with refresh URL', {
        storedAccountId,
        urlAccountId,
      });
    }
    settings.set('gsxAccountId', urlAccountId);
    // Force the Files SDK to re-init so it binds to the right account
    // before the next write. Leave the mutation to the caller-owned
    // object so tests can observe the reset.
    if (fileSync) {
      fileSync.isInitialized = false;
      fileSync.client = null;
    }
  } else if (!storedAccountId) {
    settings.set('gsxAccountId', urlAccountId);
  }

  return { ok: true, accountId: urlAccountId, reconciled, refreshUrl };
}

// GSX KeyValue collection that holds joinable meeting-token payloads.
const KV_COLLECTION = 'wiser:meeting:tokens';

// Room names are derived from space names and embedded in KV keys; keep
// them to a strict slug so they can't smuggle query/path syntax into the
// KV endpoint.
const ROOM_NAME_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

// Sanitize a renderer-supplied filename: strip any directory components,
// then restrict to a safe charset (dots survive, so extensions stay
// intact). Returns '' when nothing usable remains so callers can apply
// their own fallback name.
function sanitizeFilename(name) {
  const base = path.basename(String(name || ''));
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!safe || /^\.+$/.test(safe)) return '';
  return safe;
}

// Normalize a renderer-supplied recording payload to a Buffer. Binary
// payloads (ArrayBuffer/TypedArray) arrive intact over structured-clone
// IPC and avoid base64's 33% inflation; legacy callers still send base64
// strings.
function payloadToBuffer(blob) {
  if (Buffer.isBuffer(blob)) return blob;
  if (blob instanceof ArrayBuffer) return Buffer.from(blob);
  if (ArrayBuffer.isView(blob)) return Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  return Buffer.from(blob, 'base64');
}

// Format a seconds offset as hh:mm:ss for transcript timecodes.
function formatTimecode(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hh = String(Math.floor(total / 3600)).padStart(2, '0');
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

class Recorder {
  constructor() {
    this.window = null;
    this.instructions = null;
    this.targetSpace = null;
    this.targetProject = null;
    this.ipcHandlersRegistered = false;
    this._pendingScreenSourceId = null;
    // Room names whose tokens are currently stored in GSX KV; cleaned up
    // on clear-meeting-tokens and (best-effort) on app quit.
    this._activeKvRooms = new Set();
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
      // A relaunch can re-target the existing window to a new space/project
      if (options.spaceId) this.targetSpace = options.spaceId;
      if (options.projectId) this.targetProject = options.projectId;
      if (options.instructions) {
        this.instructions = options;
      }
      if (options.instructions || options.spaceId || options.projectId) {
        // Same channel/shape as the did-finish-load delivery below, so the
        // renderer can update its target space without a reload.
        this.window.webContents.send('recorder:instructions', options);
      }
      logger.logFeatureUsed('recorder', {
        action: 'focus-existing',
        targetSpace: options.spaceId || null,
        targetProject: options.projectId || null,
      });
      return this.window;
    }

    logger.logFeatureUsed('recorder', {
      action: 'open',
      hasInstructions: !!options.instructions,
      targetSpace: options.spaceId || null,
      targetProject: options.projectId || null,
    });

    this.instructions = options.instructions ? options : null;
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
        // sandbox:false lets preload-recorder.js require('./preload-hud-api')
        // so the full agentHUD surface is exposed instead of no-op stubs.
        // contextIsolation stays on, so the renderer remains isolated from
        // the preload; the recorder is already a privileged renderer
        // (AudioWorklet, MediaRecorder, setDisplayMediaRequestHandler).
        sandbox: false,
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

    // Screen capture: setDisplayMediaRequestHandler replaces the deprecated
    // getUserMedia({ chromeMediaSource: 'desktop' }) approach that produces
    // blank frames in Electron 25+. The renderer calls setScreenShareSource(id)
    // before getDisplayMedia() so the handler knows which source to provide.
    this._pendingScreenSourceId = null;
    this.window.webContents.session.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
        let video;
        if (this._pendingScreenSourceId) {
          video = sources.find((s) => s.id === this._pendingScreenSourceId) || sources[0];
          this._pendingScreenSourceId = null;
        } else if (this._isRecorderRequest(request)) {
          // No source was picked: only the recorder window itself may fall
          // back to the primary screen (its own share flows rely on it).
          // The handler lives on the shared default session, so any other
          // window's request without an explicit source is denied.
          video = sources[0];
        } else {
          callback({});
          return;
        }
        if (!video) {
          callback({});
          return;
        }
        const response = { video };
        if (request.audioRequested) response.audio = 'loopback';
        callback(response);
      } catch (error) {
        log.error('recorder', 'Display media handler error', { error: error.message });
        callback({});
      }
    });

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
    if (this.window && !this.window.isDestroyed()) {
      this.window.close();
    }
  }

  /**
   * True when a display-media request originates from the recorder window
   * itself. The request handler is registered on the shared default
   * session, so other windows' getDisplayMedia() calls can land in it too.
   */
  _isRecorderRequest(request) {
    if (!this.window || this.window.isDestroyed()) return false;
    try {
      const requester = request && request.frame ? webContents.fromFrame(request.frame) : null;
      return !!requester && requester.id === this.window.webContents.id;
    } catch {
      return false;
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

        const buffer = payloadToBuffer(blob);
        if (!buffer || buffer.length < 256) {
          return {
            success: false,
            error: 'Recording was empty (no audio or video captured). Check camera/mic permissions and that no other app is using them.',
          };
        }
        const finalFilename = sanitizeFilename(filename) || `recording_${Date.now()}.webm`;

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

    // Tell the display-media handler which source to provide on the next getDisplayMedia() call
    ipcMain.handle('recorder:set-screen-source', (event, sourceId) => {
      this._pendingScreenSourceId = sourceId;
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

    // ==========================================
    // MEETING OBJECT CRUD
    // ==========================================

    ipcMain.handle('recorder:create-meeting', async (event, { spaceId, templateId, options }) => {
      try {
        const { createFromTemplate, createMeetingObject, toSpaceItem, validate } = require('./lib/meeting/meeting-schema');
        const { getTemplate } = require('./lib/meeting/meeting-templates');

        let meeting;
        if (templateId) {
          meeting = createFromTemplate(templateId, { ...options, spaceId }, getTemplate);
        } else {
          meeting = createMeetingObject({ ...options, spaceId });
        }

        const { valid, errors } = validate(meeting);
        if (!valid) {
          return { success: false, error: 'Validation failed: ' + errors.join(', ') };
        }

        const clipboardManager = getClipboardManager();
        if (!clipboardManager) {
          return { success: false, error: 'Storage not available' };
        }

        const spaceItem = toSpaceItem(meeting);
        await clipboardManager.addToHistory(spaceItem);
        const savedItem = clipboardManager.history?.[0];

        log.info('recorder', 'Meeting object created', { meetingId: meeting.id, spaceId, templateId });
        return { success: true, meeting, itemId: savedItem?.id };
      } catch (error) {
        log.error('recorder', 'Failed to create meeting object', { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle('recorder:get-meetings', async (event, { spaceId, limit }) => {
      try {
        const { getSpacesAPI } = require('./spaces-api');
        const api = getSpacesAPI();
        const { fromSpaceItem } = require('./lib/meeting/meeting-schema');

        const items = await api.items.list(spaceId, {
          tags: ['wiser-meeting'],
          includeContent: true,
          limit: limit || 50,
        });

        const meetings = (items || [])
          .map(item => {
            const meeting = fromSpaceItem(item);
            return meeting ? { ...meeting, _itemId: item.id } : null;
          })
          .filter(Boolean);

        return { success: true, meetings };
      } catch (error) {
        log.error('recorder', 'Failed to get meetings', { error: error.message });
        return { success: false, error: error.message, meetings: [] };
      }
    });

    ipcMain.handle('recorder:update-meeting', async (event, { spaceId, itemId, meeting }) => {
      try {
        const { getSpacesAPI } = require('./spaces-api');
        const api = getSpacesAPI();

        await api.items.update(spaceId, itemId, {
          content: JSON.stringify(meeting, null, 2),
          metadata: {
            status: meeting.status,
            meetingId: meeting.id,
          },
        });

        log.info('recorder', 'Meeting object updated', { meetingId: meeting.id, status: meeting.status });
        return { success: true };
      } catch (error) {
        log.error('recorder', 'Failed to update meeting', { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle('recorder:get-templates', async (event, { spaceId } = {}) => {
      try {
        const { getAllTemplates, mergeTemplates } = require('./lib/meeting/meeting-templates');

        let customTemplates = [];
        let suggestedIds = [];
        let pastAttendees = [];

        if (spaceId) {
          const { getSpacesAPI } = require('./spaces-api');
          const api = getSpacesAPI();

          // Load custom templates from this space
          try {
            const { customTemplateFromSpaceItem } = require('./lib/meeting/meeting-templates');
            const tplItems = await api.items.list(spaceId, {
              tags: ['wiser-template'],
              includeContent: true,
            });
            customTemplates = (tplItems || []).map(customTemplateFromSpaceItem).filter(Boolean);
          } catch { /* no custom templates */ }

          // Analyze space content to suggest templates
          try {
            const allItems = await api.items.list(spaceId, { limit: 30 });
            const meetingItems = (allItems || []).filter(i => (i.tags || []).includes('wiser-meeting'));
            const fileItems = (allItems || []).filter(i => i.type === 'file');
            const textItems = (allItems || []).filter(i => i.type === 'text' && !(i.tags || []).includes('wiser-meeting'));

            const hasScreenRecordings = fileItems.some(i => (i.fileName || '').includes('screen'));
            const hasCameraRecordings = fileItems.some(i =>
              (i.fileType || '').startsWith('video/') && !(i.fileName || '').includes('screen')
            );
            const hasTranscripts = textItems.some(i =>
              (i.metadata?.source === 'recorder-transcript') || (i.tags || []).includes('transcript')
            );

            // Extract past meeting templates and attendees
            const pastTemplateIds = [];
            for (const mi of meetingItems) {
              try {
                const { fromSpaceItem } = require('./lib/meeting/meeting-schema');
                const m = fromSpaceItem(mi);
                if (m?.templateId) pastTemplateIds.push(m.templateId);
                if (m?.contacts) {
                  for (const c of m.contacts) {
                    if (!c.email) continue;
                    const existing = pastAttendees.find(a => a.email === c.email);
                    if (existing) {
                      existing.meetingCount += 1;
                    } else {
                      pastAttendees.push({
                        email: c.email,
                        displayName: c.displayName || c.email,
                        meetingCount: 1,
                      });
                    }
                  }
                }
              } catch {}
            }

            // Heuristic ranking (no LLM cost)
            const scores = {};
            const templates = getAllTemplates();
            for (const t of templates) {
              let score = 0;
              if (pastTemplateIds.includes(t.id)) score += 5;
              if (hasScreenRecordings && (t.captureMode === 'both' || t.screenShare)) score += 3;
              if (hasCameraRecordings && t.captureMode === 'camera') score += 2;
              if (hasTranscripts && t.ai?.transcription) score += 1;
              if (meetingItems.length > 3 && t.category === 'live') score += 2;
              if (meetingItems.length === 0 && t.id === 'quick-touch-base') score += 3;
              if (fileItems.length > 5 && t.id === 'share-screen') score += 2;
              scores[t.id] = score;
            }

            suggestedIds = Object.entries(scores)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 3)
              .filter(([, s]) => s > 0)
              .map(([id]) => id);

          } catch (e) {
            log.warn('recorder', 'Template suggestion analysis failed', { error: e.message });
          }
        }

        const all = mergeTemplates(customTemplates);
        const byCategory = { live: [], async: [], broadcast: [] };
        for (const t of all) {
          if (byCategory[t.category]) byCategory[t.category].push(t);
        }

        return { success: true, templates: all, byCategory, suggestedIds, pastAttendees };
      } catch (error) {
        log.error('recorder', 'Failed to get templates', { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle('recorder:complete-meeting', async (event, { spaceId, itemId, meetingId, participants, transcriptItemId, recordingItemIds }) => {
      try {
        const { getSpacesAPI } = require('./spaces-api');
        const api = getSpacesAPI();
        const { fromSpaceItem, completeMeeting } = require('./lib/meeting/meeting-schema');

        const item = await api.items.get(spaceId, itemId);
        if (!item) {
          return { success: false, error: 'Meeting item not found' };
        }

        let meeting = fromSpaceItem(item);
        if (!meeting || meeting.id !== meetingId) {
          return { success: false, error: 'Meeting ID mismatch' };
        }

        // Record the artifacts the agent captured so the meeting object links
        // to its transcript + recordings (drives post-meeting analysis and the
        // meeting->transcript / meeting->recording graph edges applied on sync).
        meeting = completeMeeting(meeting, {
          participants,
          transcriptItemId: transcriptItemId || undefined,
          recordingItemIds: Array.isArray(recordingItemIds) && recordingItemIds.length ? recordingItemIds : undefined,
        });

        await api.items.update(spaceId, itemId, {
          content: JSON.stringify(meeting, null, 2),
          metadata: { status: 'completed' },
        });

        // ADR-061 — mirror the completed meeting into the SHARED account
        // graph so it appears in Lite Spaces. Fire-and-forget by
        // contract: the bridge never throws, and a graph outage must
        // never block meeting completion.
        try {
          const { pushMeetingToSharedGraph } = require('./lib/meeting/meeting-graph-bridge');
          let transcriptText = (meeting.during?.transcript?.live || []).join('\n');
          if (!transcriptText && meeting.post?.transcriptItemId) {
            try {
              const tItem = await api.items.get(spaceId, meeting.post.transcriptItemId);
              if (tItem?.content) transcriptText = tItem.content;
            } catch {}
          }
          void pushMeetingToSharedGraph({
            meeting,
            transcriptText,
            recordingItemIds: meeting.post?.recordingItemIds,
            log,
          });
        } catch (bridgeError) {
          log.warn('recorder', 'meeting graph bridge unavailable', { error: bridgeError.message });
        }

        log.info('recorder', 'Meeting completed', { meetingId, duration: meeting.during.actualDuration });
        return { success: true, meeting };
      } catch (error) {
        log.error('recorder', 'Failed to complete meeting', { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle('recorder:post-meeting-analyze', async (event, { spaceId, itemId, meetingId }) => {
      try {
        const { getSpacesAPI } = require('./spaces-api');
        const api = getSpacesAPI();
        const { fromSpaceItem } = require('./lib/meeting/meeting-schema');

        const item = await api.items.get(spaceId, itemId);
        if (!item) return { success: false, error: 'Meeting not found' };

        let meeting = fromSpaceItem(item);
        if (!meeting) return { success: false, error: 'Invalid meeting data' };

        const transcriptText = (meeting.during?.transcript?.live || []).join('\n');
        if (!transcriptText && !meeting.post?.transcriptItemId) {
          log.info('recorder', 'No transcript for post-meeting analysis', { meetingId });
          return { success: true, skipped: true, reason: 'no transcript' };
        }

        let fullTranscript = transcriptText;
        if (!fullTranscript && meeting.post?.transcriptItemId) {
          try {
            const tItem = await api.items.get(spaceId, meeting.post.transcriptItemId);
            if (tItem?.content) fullTranscript = tItem.content;
          } catch {}
        }

        if (!fullTranscript || fullTranscript.length < 50) {
          return { success: true, skipped: true, reason: 'transcript too short' };
        }

        const ai = require('./lib/ai-service');
        const attendeeNames = (meeting.contacts || []).map(c => c.displayName).filter(Boolean).join(', ');
        const duration = meeting.during?.actualDuration || 0;

        const analysis = await ai.json(
          `Analyze this meeting transcript and extract structured results.

Meeting: ${meeting.calendar?.vevent?.summary || 'Meeting'}
Duration: ${duration} minutes
Participants: ${attendeeNames || 'Unknown'}

Transcript:
${fullTranscript.slice(0, 8000)}

Respond with JSON:
{
  "actionItems": [{ "text": "...", "assignee": "name or null", "deadline": null }],
  "decisions": ["..."],
  "summary": "2-3 sentence summary",
  "vibeScore": {
    "score": 1-10,
    "factors": ["..."],
    "positiveSignals": ["..."],
    "ruptures": []
  }
}`,
          { profile: 'standard', feature: 'post-meeting-analysis', maxTokens: 1500 }
        );

        if (analysis) {
          meeting.post.actionItems = analysis.actionItems || [];
          meeting.post.decisions = analysis.decisions || [];
          meeting.post.summary = analysis.summary || null;
          meeting.post.vibeScore = analysis.vibeScore || null;
          meeting.post.checkpoints.summarized = true;
          meeting.post.checkpoints.allItemsAssigned = (analysis.actionItems || []).every(a => a.assignee);

          await api.items.update(spaceId, itemId, {
            content: JSON.stringify(meeting, null, 2),
            metadata: { status: 'completed', analyzed: true },
          });

          // ADR-061 — re-push to the shared graph now that the summary /
          // action items / decisions exist; every bridge write is an
          // id-keyed MERGE, so this only enriches the same nodes.
          try {
            const { pushMeetingToSharedGraph } = require('./lib/meeting/meeting-graph-bridge');
            void pushMeetingToSharedGraph({
              meeting,
              transcriptText: fullTranscript,
              recordingItemIds: meeting.post?.recordingItemIds,
              log,
            });
          } catch (bridgeError) {
            log.warn('recorder', 'meeting graph bridge unavailable', { error: bridgeError.message });
          }

          log.info('recorder', 'Post-meeting analysis complete', {
            meetingId,
            actionItems: (analysis.actionItems || []).length,
            vibeScore: analysis.vibeScore?.score,
          });
        }

        return { success: true, meeting };
      } catch (error) {
        log.error('recorder', 'Post-meeting analysis failed', { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle('recorder:save-custom-template', async (event, { spaceId, meeting, name, description, scope }) => {
      try {
        const { createCustomTemplate, customTemplateToSpaceItem } = require('./lib/meeting/meeting-templates');

        const template = createCustomTemplate({ meeting, name, description, scope });
        const spaceItem = customTemplateToSpaceItem(template, spaceId);

        const clipboardManager = getClipboardManager();
        if (!clipboardManager) {
          return { success: false, error: 'Storage not available' };
        }

        await clipboardManager.addToHistory(spaceItem);
        log.info('recorder', 'Custom template saved', { templateId: template.id, name, scope });
        return { success: true, template };
      } catch (error) {
        log.error('recorder', 'Failed to save custom template', { error: error.message });
        return { success: false, error: error.message };
      }
    });

    // ==========================================
    // MEETING OVERLAYS
    // ==========================================

    ipcMain.handle('recorder:push-overlay', (event, overlay) => {
      if (this.window && !this.window.isDestroyed()) {
        this.window.webContents.send('recorder:overlay', overlay);
      }
      return { success: true };
    });

    // Get OpenAI API key for live transcription
    ipcMain.handle('recorder:get-openai-key', async () => {
      try {
        if (global.settingsManager) {
          const openaiKey = global.settingsManager.get('openaiApiKey');
          if (openaiKey) return { success: true, key: openaiKey };

          const llmKey = global.settingsManager.get('llmApiKey');
          const provider = global.settingsManager.get('llmProvider');
          // Only fall back to the generic LLM key when it plausibly belongs
          // to OpenAI: provider unset or 'openai', and not an Anthropic
          // 'sk-ant-' key (which also starts with 'sk-').
          if (llmKey && (!provider || provider === 'openai') && !llmKey.startsWith('sk-ant-')) {
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
      let tempAudioPath = null;
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
          return { success: false, error: 'ElevenLabs API key not configured' };
        }

        const result = await service.transcribe(transcribePath, {
          language: null,
          diarize: true,
        });

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
              // Timecode each speaker turn from its first word's start (seconds)
              formattedText += `\n[${formatTimecode(w.start)}] [${currentSpeaker}] `;
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
      } finally {
        // Extracted-audio temp file must be removed on every exit path
        if (tempAudioPath && fs.existsSync(tempAudioPath)) {
          try {
            fs.unlinkSync(tempAudioPath);
          } catch (_ignored) {
            /* best-effort temp cleanup */
          }
        }
      }
    });

    // ==========================================
    // MEETING COST TALLY
    // ==========================================

    // Live transcription talks to the realtime API over a direct WebSocket,
    // bypassing ai-service -- so its spend never reached the budget manager.
    // The renderer forwards the usage block from each
    // conversation.item.input_audio_transcription.completed event here, and we
    // record it like any other AI call (priced by pricing-config's
    // gpt-realtime-whisper entry). This both fixes the budget blind spot and
    // feeds the in-meeting running cost tally.
    ipcMain.handle('recorder:track-transcription-usage', async (event, u = {}) => {
      try {
        const { getBudgetManager } = require('./budget-manager');
        const result = getBudgetManager().trackUsage({
          provider: 'openai',
          model: u.model || 'gpt-realtime-whisper',
          inputTokens: u.inputTextTokens || 0,
          outputTokens: u.outputTokens || 0,
          spaceId: u.spaceId || null,
          feature: 'meeting-transcription',
          operation: 'realtime-transcription',
          options: {
            inputAudioTokens: u.inputAudioTokens || 0,
            cachedInputTokens: u.cachedInputTokens || 0,
          },
        });
        return { success: true, cost: result?.entry?.cost || 0 };
      } catch (error) {
        log.warn('recorder', 'track-transcription-usage failed', { error: error.message });
        return { success: false, error: error.message };
      }
    });

    // Running total of AI spend since the meeting started (transcription usage
    // recorded above + note agents + post-meeting analysis -- everything the
    // budget manager saw since `sinceIso`).
    ipcMain.handle('recorder:get-meeting-cost', async (event, { sinceIso } = {}) => {
      try {
        const { getBudgetManager } = require('./budget-manager');
        const entries = getBudgetManager().getUsageHistory({ startDate: sinceIso || new Date(0).toISOString() });
        let total = 0;
        const byFeature = {};
        for (const e of entries) {
          total += e.cost || 0;
          byFeature[e.feature || 'other'] = (byFeature[e.feature || 'other'] || 0) + (e.cost || 0);
        }
        return { success: true, total, calls: entries.length, byFeature };
      } catch (error) {
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
      if (this.window && !this.window.isDestroyed()) {
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
        const livekitService = require('./lib/meeting/livekit-service');
        const result = await livekitService.createRoom(roomName);

        // ADR-062 — announce the live meeting as an ephemeral ring
        // signal in the shared graph so Lite clients ring with a Join
        // link. Fire-and-forget: a graph outage must never block the
        // room. The join URL is composed main-side from the published
        // guest page + this install's link-signing public key — the
        // same pieces the renderer's "copy room link" uses.
        void (async () => {
          try {
            const bridge = require('./lib/meeting/meeting-graph-bridge');
            const guestUrl = global.settingsManager?.get('captureGuestPageUrl') || '';
            let joinUrl = null;
            if (guestUrl) {
              const { getPublicKeyB64u } = require('./lib/meeting/meeting-link-keys');
              const pub = await getPublicKeyB64u().catch(() => null);
              joinUrl = `${guestUrl}?room=${encodeURIComponent(roomName)}${pub ? `#k=${pub}` : ''}`;
            }
            this._lastLiveRoomName = roomName;
            // ADR-064 — presence facet: hosting a meeting is the most
            // "who's doing what" fact there is. Identity-gated inside.
            const presenceEmail = global.settingsManager?.get('userEmail');
            if (presenceEmail) {
              const presence = require('./lib/presence-beacon');
              void presence.beat({
                personId: presenceEmail,
                appId: 'onereach-desktop',
                appName: 'Onereach.ai',
                facets: {
                  tool: 'meeting',
                  meetingRoom: roomName,
                  lastAction: `started meeting “${require('./lib/meeting/meeting-graph-bridge').prettyRoomTitle(roomName)}”`,
                },
                log,
              });
            }
            // Organized participants become MEMBERS of the shared "WISER
            // Meetings" Space before the live signal goes out — ADR-065 rings
            // members only, so this grant IS the invite reaching Lite users.
            // Without it, "invite Erika" only ever edited the local draft.
            const invitees = (this.instructions && Array.isArray(this.instructions.participants)
              ? this.instructions.participants
              : []
            )
              .map((p) => (p && typeof p.email === 'string' ? p.email : null))
              .filter(Boolean);
            if (invitees.length > 0) {
              await bridge
                .grantMeetingRingAccess(invitees, {
                  log,
                  grantedBy: global.settingsManager?.get('userEmail') || 'host',
                })
                .catch(() => {});
            }

            await bridge.announceMeetingLive({
              roomName,
              joinUrl,
              title: bridge.prettyRoomTitle(roomName),
              host: global.settingsManager?.get('userDisplayName') || null,
              // Lets ring surfaces (Lite tab label) lead with the space.
              spaceId: this.targetSpace || null,
              log,
            });
          } catch (ringError) {
            log.warn('recorder', 'meeting ring announce unavailable', { error: ringError.message });
          }
        })();

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
        // ADR-062 — tear the ring signal down eagerly (TTL is the
        // backstop for crashed hosts). Fire-and-forget.
        if (this._lastLiveRoomName) {
          const room = this._lastLiveRoomName;
          this._lastLiveRoomName = null;
          try {
            const { endMeetingLive } = require('./lib/meeting/meeting-graph-bridge');
            void endMeetingLive(room, { log });
            // ADR-064 — clear the meeting facet (null removes it).
            const presenceEmail = global.settingsManager?.get('userEmail');
            if (presenceEmail) {
              const presence = require('./lib/presence-beacon');
              void presence.beat({
                personId: presenceEmail,
                appId: 'onereach-desktop',
                appName: 'Onereach.ai',
                facets: { tool: null, meetingRoom: null, lastAction: 'ended a meeting' },
                log,
              });
            }
          } catch (ringError) {
            log.warn('recorder', 'meeting ring teardown unavailable', { error: ringError.message });
          }
        }
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

    // Get the stored guest page URL (if already published AND version matches
    // AND it was published to the currently signed-in GSX account)
    ipcMain.handle('recorder:get-guest-page-url', async () => {
      try {
        const { GUEST_PAGE_VERSION } = require('./lib/meeting/capture-guest-page');
        const url = global.settingsManager?.get('captureGuestPageUrl') || '';
        const storedVersion = global.settingsManager?.get('captureGuestPageVersion') || 0;
        if (url && storedVersion >= GUEST_PAGE_VERSION) {
          // The published URL embeds the owning account id
          // (.../public/{accountId}/capture/join.html). If the signed-in
          // GSX account changed since publish, force a re-publish instead
          // of handing out another account's page.
          const currentAccountId = accountIdFromRefreshUrl(global.settingsManager?.get('gsxRefreshUrl'));
          const urlMatch = url.match(/\/public\/([^/]+)\//);
          const urlAccountId = urlMatch ? urlMatch[1] : '';
          if (currentAccountId && urlAccountId === currentAccountId) {
            return { success: true, url };
          }
          log.warn('recorder', 'Cached guest page URL belongs to a different account; forcing re-publish', {
            urlAccountId,
            currentAccountId,
          });
          return { success: false, url: '' };
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
    //
    // Publishes to the *authenticated user's own* GSX account. There is no
    // hardcoded fallback account: the Edison Files API rejects cross-account
    // writes ("Cross account requests allowed to SUPER_ADMIN only"), so any
    // attempt to publish to a shared account fails for non-admin users.
    ipcMain.handle('recorder:publish-guest-page', async () => {
      try {
        const settings = global.settingsManager;
        const reconcile = reconcileGsxAccount({
          settings,
          fileSync: global.gsxFileSync,
          warn: (msg, meta) => log.warn('recorder', msg, meta),
        });
        if (!reconcile.ok) {
          log.warn('recorder', 'Publish guest page aborted', {
            reason: reconcile.reason,
          });
          return { success: false, error: reconcile.error };
        }
        const accountId = reconcile.accountId;
        const refreshUrl = reconcile.refreshUrl;

        // 1. Ensure GSX File Sync is ready (uses the authenticated user's account)
        if (!global.gsxFileSync || !global.gsxFileSync.isInitialized) {
          if (global.gsxFileSync && typeof global.gsxFileSync.initialize === 'function') {
            const initResult = await global.gsxFileSync.initialize();
            if (!initResult?.success && !global.gsxFileSync.isInitialized) {
              return { success: false, error: 'GSX File Sync init failed: ' + (initResult?.error || 'unknown') };
            }
          } else {
            return { success: false, error: 'GSX File Sync module not loaded' };
          }
        }

        // 2. Build static HTML with KV endpoint embedded
        const { buildGuestPageHTML } = require('./lib/meeting/capture-guest-page');
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
        const { GUEST_PAGE_VERSION } = require('./lib/meeting/capture-guest-page');
        settings.set('captureGuestPageVersion', GUEST_PAGE_VERSION);

        log.info('recorder', 'Guest page published to GSX Files', { publicUrl, version: GUEST_PAGE_VERSION });
        return { success: true, url: publicUrl };
      } catch (error) {
        log.error('recorder', 'Failed to publish guest page', { error: error.message });
        return { success: false, error: error.message };
      }
    });

    // Store meeting tokens in GSX KeyValue so the guest page can fetch them by room name.
    // Key: wiser-room:{roomName}  Value: { v: 2, payload: "<json>", sig: "<b64url>" }
    // Writes to the authenticated user's own KV store -- no hardcoded fallback account.
    //
    // The KV endpoint accepts unauthenticated writes, so the stored value is
    // signed with the install's ECDSA keypair; the guest page only trusts
    // payloads that verify against the public key carried in the join link
    // (#k=...). An attacker overwriting the KV entry can deny a join, but
    // can no longer redirect guests' camera/mic streams to their own SFU.
    /**
     * Build, sign, and PUT the wiser-room KV payload. `expiresAt` must
     * stay the ORIGINAL value across roster republishes — the roster
     * must never extend a meeting link's life. Returns the joinKey.
     */
    this._writeSignedRoomPayload = async ({ kvUrl, roomName, guestTokens, livekitUrl, expiresAt, participants }) => {
      const linkKeys = require('./lib/meeting/meeting-link-keys');
      const key = `wiser-room:${roomName}`;
      const payload = JSON.stringify({
        v: 2,
        roomName,
        tokens: guestTokens,
        livekitUrl,
        issuedAt: Date.now(),
        // Guest page must refuse rooms whose host is long gone
        expiresAt,
        // Lobby roster (v17): who is in the room right now, names only.
        participants: Array.isArray(participants)
          ? participants.map((n) => String(n).slice(0, 60)).slice(0, 24)
          : [],
      });
      const sig = await linkKeys.signPayload(payload);
      const joinKey = await linkKeys.getPublicKeyB64u();
      const resp = await fetch(`${kvUrl}?id=${encodeURIComponent(KV_COLLECTION)}&key=${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: KV_COLLECTION,
          key,
          itemValue: JSON.stringify({ v: 2, payload, sig }),
        }),
      });
      if (!resp.ok) throw new Error(`KV PUT failed: ${resp.status}`);
      return joinKey;
    };

    /** roomName -> interval handle for the roster republish loop. */
    this._rosterLoops = this._rosterLoops || new Map();

    this._stopRosterRepublish = (roomName) => {
      const t = this._rosterLoops.get(roomName);
      if (t) { clearInterval(t); this._rosterLoops.delete(roomName); }
    };

    this._startRosterRepublish = ({ kvUrl, roomName, guestTokens, livekitUrl, expiresAt }) => {
      this._stopRosterRepublish(roomName);
      let lastRoster = '';
      const timer = setInterval(() => {
        void (async () => {
          try {
            if (Date.now() > expiresAt) { this._stopRosterRepublish(roomName); return; }
            const livekitService = require('./lib/meeting/livekit-service');
            const parts = await livekitService.listParticipants(roomName);
            if (parts === null) return; // quiet skip — roster is garnish
            const names = parts.map((p) => p.name || p.identity).filter((n) => n.length > 0);
            const fingerprint = names.slice().sort().join('|');
            if (fingerprint === lastRoster) return; // no churn, no rewrite
            lastRoster = fingerprint;
            await this._writeSignedRoomPayload({
              kvUrl, roomName, guestTokens, livekitUrl, expiresAt, participants: names,
            });
            log.info('recorder', 'Roster republished to KV', { roomName, count: names.length });
          } catch (err) {
            log.warn('recorder', 'Roster republish skipped', { roomName, error: err.message });
          }
        })();
      }, 8000);
      if (typeof timer.unref === 'function') timer.unref();
      this._rosterLoops.set(roomName, timer);
    };

    ipcMain.handle('recorder:store-meeting-tokens', async (event, { roomName, guestTokens, livekitUrl } = {}) => {
      try {
        if (typeof roomName !== 'string' || !ROOM_NAME_RE.test(roomName)) {
          return { success: false, error: 'Invalid room name.' };
        }
        if (
          !Array.isArray(guestTokens) ||
          guestTokens.length === 0 ||
          !guestTokens.every((t) => typeof t === 'string' && t.length > 0)
        ) {
          return { success: false, error: 'Guest tokens must be a non-empty array of strings.' };
        }
        if (typeof livekitUrl !== 'string' || !/^wss:\/\//.test(livekitUrl)) {
          return { success: false, error: 'livekitUrl must be a wss:// URL.' };
        }

        const reconcile = reconcileGsxAccount({
          settings: global.settingsManager,
          fileSync: global.gsxFileSync,
          warn: (msg, meta) => log.warn('recorder', msg, meta),
        });
        if (!reconcile.ok) {
          log.warn('recorder', 'Store meeting tokens aborted', { reason: reconcile.reason });
          return { success: false, error: reconcile.error };
        }
        const kvUrl = reconcile.refreshUrl.replace('/refresh_token', '/keyvalue');
        const key = `wiser-room:${roomName}`;

        const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
        const joinKey = await this._writeSignedRoomPayload({
          kvUrl, roomName, guestTokens, livekitUrl, expiresAt, participants: [],
        });
        this._activeKvRooms.add(roomName);
        // Lobby roster (guest page v17): republish the signed payload
        // with the CURRENT participant list so guests see who's in the
        // room BEFORE joining. Server API is the truth; loop is quiet
        // best-effort and stops on clear-meeting-tokens / quit.
        this._startRosterRepublish({ kvUrl, roomName, guestTokens, livekitUrl, expiresAt });
        log.info('recorder', 'Meeting tokens stored in KV (signed)', { roomName, tokenCount: guestTokens.length });
        return { success: true, joinKey };
      } catch (error) {
        log.error('recorder', 'Failed to store meeting tokens', { error: error.message });
        return { success: false, error: error.message };
      }
    });

    // Public half of the install's payload-signing keypair, appended to
    // join links as #k=... so the guest page can verify KV payloads.
    // Safe to hand out: holders can verify payloads, never forge them.
    ipcMain.handle('recorder:get-meeting-link-key', async () => {
      try {
        const joinKey = await require('./lib/meeting/meeting-link-keys').getPublicKeyB64u();
        return { success: true, joinKey };
      } catch (error) {
        log.error('recorder', 'Failed to get meeting link key', { error: error.message });
        return { success: false, error: error.message };
      }
    });

    // Clear meeting tokens from KV when host ends meeting.
    // Uses the authenticated user's own KV store -- no hardcoded fallback account.
    ipcMain.handle('recorder:clear-meeting-tokens', async (event, roomName) => {
      try {
        if (typeof roomName !== 'string' || !ROOM_NAME_RE.test(roomName)) {
          return { success: false, error: 'Invalid room name.' };
        }

        const reconcile = reconcileGsxAccount({
          settings: global.settingsManager,
          fileSync: global.gsxFileSync,
          warn: (msg, meta) => log.warn('recorder', msg, meta),
        });
        if (!reconcile.ok) {
          log.warn('recorder', 'Clear meeting tokens aborted', { roomName, reason: reconcile.reason });
          return { success: false, error: reconcile.error };
        }
        const kvUrl = reconcile.refreshUrl.replace('/refresh_token', '/keyvalue');
        const key = `wiser-room:${roomName}`;

        const resp = await fetch(`${kvUrl}?id=${encodeURIComponent(KV_COLLECTION)}&key=${encodeURIComponent(key)}`, {
          method: 'DELETE',
        });
        this._activeKvRooms.delete(roomName);
        this._stopRosterRepublish(roomName);
        const respStatus = resp.status;
        let _respBody = '';
        try {
          _respBody = await resp.text();
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

    // Best-effort KV cleanup on quit so meetings ended by quitting the app
    // don't linger as joinable zombies. Fire-and-forget: quit is not
    // blocked on the DELETE round-trips.
    app.on('before-quit', () => {
      if (!this._activeKvRooms || this._activeKvRooms.size === 0) return;
      const refreshUrl = global.settingsManager?.get('gsxRefreshUrl');
      if (!refreshUrl) return;
      const kvUrl = refreshUrl.replace('/refresh_token', '/keyvalue');
      for (const roomName of this._activeKvRooms) {
        const key = `wiser-room:${roomName}`;
        fetch(`${kvUrl}?id=${encodeURIComponent(KV_COLLECTION)}&key=${encodeURIComponent(key)}`, {
          method: 'DELETE',
        }).catch(() => {});
      }
      this._activeKvRooms.clear();
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

        const buffer = payloadToBuffer(blob);
        const finalFilename = sanitizeFilename(filename) || `guest_recording_${Date.now()}.webm`;

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
      let outputPath = null;
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

        // amix requires every mapped input to actually carry audio; tracks
        // recorded without a mic (or screen-only captures) often have none.
        // both -> amix, one -> pass that stream through, none -> video only.
        const hostHasAudio = hostInfo.streams.some((s) => s.codec_type === 'audio');
        const guestHasAudio = guestInfo.streams.some((s) => s.codec_type === 'audio');
        let audioFilter = null;
        if (hostHasAudio && guestHasAudio) {
          audioFilter = '[0:a][1:a]amix=inputs=2:duration=longest[outa]';
        } else if (hostHasAudio) {
          audioFilter = '[0:a]anull[outa]';
        } else if (guestHasAudio) {
          audioFilter = '[1:a]anull[outa]';
        }

        // Build FFmpeg filter based on layout
        let filterParts = [];
        let outputW, outputH;

        switch (layout) {
          case 'side-by-side': {
            // Scale both to same height, place side by side
            const targetH = 720;
            const scaledHostW = Math.round((hostW * targetH) / hostH);
            const scaledGuestW = Math.round((guestW * targetH) / guestH);
            outputW = scaledHostW + scaledGuestW;
            outputH = targetH;
            filterParts = [
              `[0:v]scale=${scaledHostW}:${targetH}[host]`,
              `[1:v]scale=${scaledGuestW}:${targetH}[guest]`,
              `[host][guest]hstack=inputs=2[outv]`,
            ];
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
            filterParts = [
              `[1:v]scale=${outputW}:${outputH}[bg]`,
              `[0:v]scale=${pipW}:${pipH}[pip]`,
              `[bg][pip]overlay=${pipX}:${pipY}[outv]`,
            ];
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
            filterParts = [
              `[0:v]scale=${outputW}:${outputH}[bg]`,
              `[1:v]scale=${pipW}:${pipH}[pip]`,
              `[bg][pip]overlay=${pipX}:${pipY}[outv]`,
            ];
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
            filterParts = [
              `[0:v]scale=${scaledHostW}:${targetH}[host]`,
              `[1:v]scale=${scaledGuestW}:${targetH}[guest]`,
              `[host][guest]hstack=inputs=2[outv]`,
            ];
            break;
          }
        }

        if (audioFilter) filterParts.push(audioFilter);
        const filterComplex = filterParts.join(';');
        const outputLabels = audioFilter ? ['outv', 'outa'] : ['outv'];

        // Output to temp file
        const tempDir = path.join(app.getPath('temp'), 'gsx-recordings');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        const mergeFilename =
          sanitizeFilename(outputFilename || `merged_${layout}_${Date.now()}.mp4`) || `merged_${Date.now()}.mp4`;
        outputPath = path.join(tempDir, mergeFilename);

        sendProgress(20, 'Merging tracks...');

        // Run FFmpeg merge
        await new Promise((resolve, reject) => {
          const cmd = ffmpeg()
            .input(hostPath)
            .input(guestPath)
            .complexFilter(filterComplex, outputLabels)
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
        // Don't leave a partial output file behind on FFmpeg failure
        try {
          if (outputPath && fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        } catch {
          /* no-op */
        }
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
  // Exported for unit tests
  _accountIdFromRefreshUrl: accountIdFromRefreshUrl,
  _reconcileGsxAccount: reconcileGsxAccount,
};
