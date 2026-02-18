// Cross-platform helper to convert file path to file:// URL
// Works on both Windows (C:\path\to\file) and Unix (/path/to/file)
function pathToFileUrl(filePath) {
  if (!filePath) return '';
  // Already a file:// URL
  if (filePath.startsWith('file://')) return filePath;
  // Already a data: URL
  if (filePath.startsWith('data:')) return filePath;

  // Normalize backslashes to forward slashes (Windows paths)
  let normalized = filePath.replace(/\\/g, '/');

  // Handle Windows drive letters (C: -> /C:)
  if (/^[a-zA-Z]:/.test(normalized)) {
    normalized = '/' + normalized;
  }

  // Encode special characters in path components, but preserve slashes
  const encoded = normalized
    .split('/')
    .map(
      (component) => encodeURIComponent(component).replace(/%3A/g, ':') // Keep colons for drive letters
    )
    .join('/');

  return 'file://' + encoded;
}

// Video Editor Application
const app = {
  videoPath: null,
  videoInfo: null,
  isPlaying: false,
  currentJobId: null,
  currentTab: 'edit',
  currentMode: 'edit', // 'edit' or 'mark'
  currentLayout: 'edit', // 'edit' or 'beats'
  selectedSpace: null,
  trimStart: 0,
  trimEnd: 0,
  quality: 'medium',
  audioMuted: false,
  audioDetached: false,
  videoDetached: false, // Whether video is playing in a detached window
  detachedCleanupFns: [], // Cleanup functions for detached window event listeners
  audioContext: null,
  audioBuffer: null,
  currentSpeed: 1.0,
  timelineZoom: 1,
  timelineScrollOffset: 0,
  maxZoom: 20,
  minZoom: 1,
  markers: [],
  nextMarkerId: 1,
  markerColors: ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'],
  pendingRangeMarker: null, // For tracking incomplete range markers (IN set, waiting for OUT)
  draggingMarker: null, // { id, type: 'spot'|'range-in'|'range-out'|'range-move', startX, startTime }

  // Multi-source video system (for multi-camera/multi-take editing)
  videoSources: [], // Array of video source objects: { id, path, fileName, duration, metadata }
  videoClips: [], // Array of video clips on timeline: { id, sourceId, name, timelineStart, sourceIn, sourceOut, duration }
  activeSourceId: null, // Currently playing source in video player
  nextVideoSourceId: 1, // Counter for generating unique source IDs
  nextVideoClipId: 1, // Counter for generating unique clip IDs
  currentTimelinePosition: 0, // Current position on the unified timeline (spans all clips)

  // Playlist
  playlist: [],
  playlistPlaying: false,
  playlistCurrentIndex: -1,

  // Space tracking (for Save to Space)
  spaceItemId: null, // Set when video is loaded from a Space
  spaceItemName: null,

  // Project/Version System
  currentProjectId: null,
  currentVersionId: null,
  projectData: null, // Full project object
  versionData: null, // Full version object
  versionTree: null, // VersionTree instance for UI rendering
  versionDropdownOpen: false,
  branchSourceVersionId: null, // For branch modal

  // Planning data for Line Script
  planning: null, // { characters, scenes, locations, storyBeats }
  planningPanel: null, // PlanningPanel instance

  // Transcript segments for waveform display
  transcriptSegments: null, // Array of { start, end, text } for displaying words on waveform
  pendingTranscriptText: null, // Raw transcript text pending segment creation (after video loads)
  transcriptSource: null, // 'whisper' | 'youtube' | 'evenly-distributed' | null - tracks accuracy

  // Word selection state for speaker reassignment (click and drag)
  wordSelectionStart: null, // Starting word index for selection
  wordSelectionEnd: null, // Ending word index for selection
  isSelectingWords: false, // Whether user is currently dragging to select

  // HARDENED SETTING: Words on waveform are DISABLED by default
  // This clutters the visualization - teleprompter is the proper place for words
  // To enable: set this to true (not recommended)
  showWordsOnWaveform: false,

  // Web Audio API for smooth scrubbing
  audioContext: null,
  audioBuffer: null,
  audioSource: null,
  audioGain: null,
  scrubAudioPath: null,
  isAudioLoaded: false,
  lastPlayedWord: null, // Track last played word to avoid repeats

  // Clip selection for right-click edit menu
  selectedClip: null, // 'video' or null

  // Fade effects (in seconds)
  fades: {
    fadeIn: null, // duration in seconds, or null
    fadeOut: null, // duration in seconds, or null
  },

  // Slice markers (visual cut points)
  sliceMarkers: [], // array of time positions

  // Segments derived from slice markers
  segments: [], // [{id, startTime, endTime}]
  selectedSegment: null, // Currently selected segment ID

  // Thumbnail cache for different zoom levels
  thumbnailCache: {}, // { zoomLevel: [thumbnailPaths] }

  // ==================== HARDENED UNDO/SAVE SYSTEM ====================
  // This system is designed to NEVER lose user work

  undoStack: [], // Stack of previous states
  redoStack: [], // Stack of states undone (for redo)
  maxUndoStates: 100, // Maximum number of undo states to keep
  isUndoRedoing: false, // Flag to prevent recursive undo pushes during restore
  isDirty: false, // Has unsaved changes
  lastSaveTime: 0, // Timestamp of last successful save
  saveRetryCount: 0, // Number of save retry attempts
  maxSaveRetries: 3, // Maximum retry attempts
  pendingSaveTimeout: null, // Debounce timeout for saves
  saveDebounceMs: 2000, // Debounce delay (2 seconds)
  emergencySaveInterval: null, // Periodic backup interval
  _lastSavedStateHash: null, // Hash of last saved state to detect changes

  /**
   * Initialize the hardened save system
   * Call this during app initialization
   */
  initSaveSystem() {
    console.log('[SaveSystem] Initializing hardened save system...');

    // 1. Restore undo stack from localStorage if available
    this._restoreUndoStackFromStorage();

    // 2. Set up beforeunload handler to save on close
    window.addEventListener('beforeunload', (e) => {
      if (this.isDirty) {
        // Force synchronous save attempt
        this._emergencySave();

        // Show browser warning
        e.preventDefault();
        e.returnValue = 'You have unsaved changes. Are you sure you want to leave?';
        return e.returnValue;
      }
    });

    // 3. Set up visibility change handler (save when tab becomes hidden)
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.isDirty) {
        console.log('[SaveSystem] Tab hidden - saving work...');
        this._immediateSave();
      }
    });

    // 4. Set up periodic emergency backup (every 10 seconds)
    this.emergencySaveInterval = setInterval(() => {
      this._periodicBackup();
    }, 10000);

    // 5. Update UI
    this._updateUndoRedoButtons();
    this._updateSaveIndicator('saved');

    console.log('[SaveSystem] Save system initialized');
  },

  /**
   * Mark state as dirty (has unsaved changes)
   * This should be called by ALL operations that modify state
   */
  markDirty(actionName = 'Edit') {
    this.isDirty = true;
    this._updateSaveIndicator('unsaved');
    console.log(`[SaveSystem] State marked dirty: ${actionName}`);

    // Schedule debounced save
    this._scheduleSave();
  },

  /**
   * Push current state to undo stack before making a change
   * Call this BEFORE any state-modifying operation
   * @param {string} actionName - Description of the action (for debugging)
   */
  pushUndoState(actionName = 'Unknown action') {
    if (this.isUndoRedoing) return; // Don't push during undo/redo operations

    const state = this._captureUndoState();
    state.actionName = actionName;
    state.timestamp = Date.now();

    this.undoStack.push(state);

    // Limit stack size
    if (this.undoStack.length > this.maxUndoStates) {
      this.undoStack.shift(); // Remove oldest
    }

    // Clear redo stack when new action is performed
    this.redoStack = [];

    // Mark dirty and schedule save
    this.markDirty(actionName);

    // Persist undo stack to localStorage for crash recovery
    this._persistUndoStackToStorage();

    this._updateUndoRedoButtons();
    console.log(`[Undo] Pushed state: "${actionName}" (stack size: ${this.undoStack.length})`);
  },

  /**
   * Capture current editor state for undo
   */
  _captureUndoState() {
    return {
      markers: JSON.parse(JSON.stringify(this.markers || [])),
      audioTracks: JSON.parse(JSON.stringify(this.audioTracks || [])),
      beats: JSON.parse(JSON.stringify(this.beats || [])),
      playlist: JSON.parse(JSON.stringify(this.playlist || [])),
      transcriptSegments: JSON.parse(JSON.stringify(this.transcriptSegments || [])),
      sliceMarkers: JSON.parse(JSON.stringify(this.sliceMarkers || [])),
      fades: JSON.parse(JSON.stringify(this.fades || { fadeIn: null, fadeOut: null })),
      trimStart: this.trimStart,
      trimEnd: this.trimEnd,
      nextMarkerId: this.nextMarkerId,
      nextTrackId: this.nextTrackId,
      // Multi-source video state
      videoSources: JSON.parse(JSON.stringify(this.videoSources || [])),
      videoClips: JSON.parse(JSON.stringify(this.videoClips || [])),
      activeSourceId: this.activeSourceId,
      nextVideoSourceId: this.nextVideoSourceId,
      nextVideoClipId: this.nextVideoClipId,
    };
  },

  /**
   * Restore a captured state
   */
  _restoreUndoState(state) {
    if (!state) return;

    this.isUndoRedoing = true;

    try {
      // Restore all state properties
      this.markers = JSON.parse(JSON.stringify(state.markers || []));
      this.audioTracks = JSON.parse(JSON.stringify(state.audioTracks || []));
      this.beats = JSON.parse(JSON.stringify(state.beats || []));
      this.playlist = JSON.parse(JSON.stringify(state.playlist || []));
      this.transcriptSegments = JSON.parse(JSON.stringify(state.transcriptSegments || []));
      this.sliceMarkers = JSON.parse(JSON.stringify(state.sliceMarkers || []));
      this.fades = JSON.parse(JSON.stringify(state.fades || { fadeIn: null, fadeOut: null }));
      this.trimStart = state.trimStart ?? 0;
      this.trimEnd = state.trimEnd ?? 0;
      this.nextMarkerId = state.nextMarkerId ?? this.nextMarkerId;
      this.nextTrackId = state.nextTrackId ?? this.nextTrackId;

      // Restore multi-source video state
      if (state.videoSources) {
        this.videoSources = JSON.parse(JSON.stringify(state.videoSources));
      }
      if (state.videoClips) {
        this.videoClips = JSON.parse(JSON.stringify(state.videoClips));
      }
      if (state.activeSourceId !== undefined) {
        this.activeSourceId = state.activeSourceId;
      }
      if (state.nextVideoSourceId !== undefined) {
        this.nextVideoSourceId = state.nextVideoSourceId;
      }
      if (state.nextVideoClipId !== undefined) {
        this.nextVideoClipId = state.nextVideoClipId;
      }

      // Re-render affected UI
      this.renderMarkers && this.renderMarkers();
      this.updateMarkersPanel && this.updateMarkersPanel();
      this.renderBeats && this.renderBeats();
      this.updateSliceMarkers && this.updateSliceMarkers();
      this.renderVideoSources && this.renderVideoSources();
      this.renderVideoClips && this.renderVideoClips();

      // Re-render audio tracks (clear container and re-render each)
      this._renderAllAudioTracks();

      // Mark dirty and save
      this.markDirty('Undo/Redo');
    } finally {
      this.isUndoRedoing = false;
    }
  },

  /**
   * Clear and re-render all audio tracks (for undo/redo)
   */
  _renderAllAudioTracks() {
    const container = document.getElementById('audioTracksContainer');
    if (!container) return;

    // Remove all track rows except the "Add Track" row
    const existingTracks = container.querySelectorAll('.audio-track-row:not(#addTrackRow)');
    existingTracks.forEach((el) => el.remove());

    // Re-render each track (except original which is handled separately)
    this.audioTracks.forEach((track) => {
      if (track.type !== 'original' && this.renderAudioTrack) {
        this.renderAudioTrack(track);
      }
    });

    // Render clips after a delay to ensure DOM is ready
    setTimeout(() => {
      this.audioTracks.forEach((track) => {
        if (track.clips && track.clips.length > 0) {
          // For speaker tracks, use the speaker clip renderer
          if (
            track.type === 'speaker' &&
            this.adrManager &&
            typeof this.adrManager._renderSpeakerClips === 'function'
          ) {
            this.adrManager._renderSpeakerClips(track.id, track.clips, track.color || '#4a9eff');
          } else {
            // Handle other clip types
            track.clips.forEach((clip) => {
              if (clip.type === 'visual-reference' || clip.isVisualOnly) {
                if (this.adrManager && typeof this.adrManager._renderVisualClip === 'function') {
                  this.adrManager._renderVisualClip(track.id, clip);
                }
              } else if (clip.type === 'adr' || clip.type === 'elevenlabs') {
                if (this.adrManager && typeof this.adrManager._renderADRClip === 'function') {
                  this.adrManager._renderADRClip(track.id, clip);
                }
              } else if (clip.type === 'room-tone') {
                if (this.adrManager && typeof this.adrManager._renderFillClip === 'function') {
                  this.adrManager._renderFillClip(track.id, clip);
                }
              } else if (this.renderTrackClips) {
                this.renderTrackClips(track.id);
              }
            });
          }
        }
      });
    }, 100);

    console.log('[Undo] Re-rendered', this.audioTracks.length, 'audio tracks');
  },

  /**
   * Undo last action
   */
  undo() {
    if (this.undoStack.length === 0) {
      this.showToast && this.showToast('info', 'Nothing to undo');
      return;
    }

    // Save current state to redo stack first
    const currentState = this._captureUndoState();
    currentState.actionName = 'Before undo';
    this.redoStack.push(currentState);

    // Pop and restore previous state
    const previousState = this.undoStack.pop();
    this._restoreUndoState(previousState);

    // Persist changes
    this._persistUndoStackToStorage();

    this._updateUndoRedoButtons();
    this.showToast && this.showToast('success', `Undid: ${previousState.actionName}`);
    console.log(`[Undo] Restored state: "${previousState.actionName}"`);
  },

  /**
   * Redo previously undone action
   */
  redo() {
    if (this.redoStack.length === 0) {
      this.showToast && this.showToast('info', 'Nothing to redo');
      return;
    }

    // Save current state to undo stack
    const currentState = this._captureUndoState();
    currentState.actionName = 'Before redo';
    this.undoStack.push(currentState);

    // Pop and restore redo state
    const redoState = this.redoStack.pop();
    this._restoreUndoState(redoState);

    // Persist changes
    this._persistUndoStackToStorage();

    this._updateUndoRedoButtons();
    this.showToast && this.showToast('success', 'Redone');
    console.log('[Undo] Redo applied');
  },

  /**
   * Update undo/redo button states
   */
  _updateUndoRedoButtons() {
    const undoBtn = document.querySelector('[onclick="app.undo()"]');
    const redoBtn = document.querySelector('[onclick="app.redo()"]');

    if (undoBtn) {
      undoBtn.disabled = this.undoStack.length === 0;
      undoBtn.style.opacity = this.undoStack.length === 0 ? '0.4' : '1';
      undoBtn.title =
        this.undoStack.length > 0
          ? `Undo: ${this.undoStack[this.undoStack.length - 1]?.actionName || 'last action'}`
          : 'Nothing to undo';
    }
    if (redoBtn) {
      redoBtn.disabled = this.redoStack.length === 0;
      redoBtn.style.opacity = this.redoStack.length === 0 ? '0.4' : '1';
    }
  },

  // ==================== SAVE PERSISTENCE ====================

  /**
   * Schedule a debounced save (prevents too many saves)
   */
  _scheduleSave() {
    if (this.pendingSaveTimeout) {
      clearTimeout(this.pendingSaveTimeout);
    }

    this.pendingSaveTimeout = setTimeout(() => {
      this._immediateSave();
    }, this.saveDebounceMs);
  },

  /**
   * Perform immediate save with retry logic
   */
  async _immediateSave() {
    if (!this.currentVersionId && !this.spaceItemId) {
      // No project/space to save to - save to localStorage only
      this._saveToLocalStorage();
      return;
    }

    this._updateSaveIndicator('saving');

    try {
      // Save to project system if available
      if (this.saveCurrentVersion) {
        await this.saveCurrentVersion();
      }

      // Save full project state to Space (comprehensive save)
      if (this.spaceItemId) {
        await this.saveFullProjectToSpace();
      }

      this.isDirty = false;
      this.lastSaveTime = Date.now();
      this.saveRetryCount = 0;
      this._lastSavedStateHash = this._getStateHash();
      this._updateSaveIndicator('saved');

      console.log('[SaveSystem] Save successful (Space + Project)');
    } catch (error) {
      console.error('[SaveSystem] Save failed:', error);
      if (window.api && window.api.log) {
        window.api.log.error('Video editor save failed', {
          error: error.message,
          operation: 'saveProject',
        });
      }
      this._handleSaveError(error);
    }
  },

  /**
   * Handle save errors with retry logic
   */
  async _handleSaveError(_error) {
    this.saveRetryCount++;

    if (this.saveRetryCount <= this.maxSaveRetries) {
      console.log(`[SaveSystem] Retrying save (attempt ${this.saveRetryCount}/${this.maxSaveRetries})...`);
      this._updateSaveIndicator('retrying');

      // Exponential backoff: 1s, 2s, 4s
      const delay = Math.pow(2, this.saveRetryCount - 1) * 1000;

      setTimeout(() => {
        this._immediateSave();
      }, delay);
    } else {
      // Max retries exceeded - save to localStorage as emergency backup
      console.error('[SaveSystem] Max retries exceeded, saving to localStorage...');
      this._emergencySave();
      this._updateSaveIndicator('error');
      this.showToast && this.showToast('error', 'Save failed - work backed up locally. Please try again.');
    }
  },

  /**
   * Emergency save to localStorage (for crash recovery)
   */
  _emergencySave() {
    try {
      const state = this._captureUndoState();
      state.videoPath = this.videoPath;
      state.projectId = this.currentProjectId;
      state.versionId = this.currentVersionId;
      state.spaceItemId = this.spaceItemId;
      state.timestamp = Date.now();

      localStorage.setItem('videoEditor_emergencyBackup', JSON.stringify(state));
      console.log('[SaveSystem] Emergency backup saved to localStorage');
    } catch (error) {
      console.error('[SaveSystem] Emergency save failed:', error);
      if (window.api && window.api.log) {
        window.api.log.error('Video editor emergency save failed', {
          error: error.message,
          operation: 'emergencySave',
        });
      }
    }
  },

  /**
   * Save current state to localStorage (additional backup)
   */
  _saveToLocalStorage() {
    try {
      const key = `videoEditor_backup_${this.videoPath || 'unsaved'}`;
      const state = this._captureUndoState();
      state.timestamp = Date.now();

      localStorage.setItem(key, JSON.stringify(state));
      this.isDirty = false;
      this._updateSaveIndicator('saved');
    } catch (error) {
      console.error('[SaveSystem] localStorage save failed:', error);
    }
  },

  /**
   * Periodic backup (called every 10 seconds)
   */
  _periodicBackup() {
    const currentHash = this._getStateHash();

    // Only backup if state has changed
    if (currentHash !== this._lastSavedStateHash) {
      console.log('[SaveSystem] Periodic backup triggered...');

      // Save to localStorage as backup
      this._emergencySave();

      // If dirty, also try to save to project
      if (this.isDirty) {
        this._immediateSave();
      }
    }
  },

  /**
   * Get a simple hash of current state for change detection
   */
  _getStateHash() {
    const state = {
      markers: this.markers?.length || 0,
      tracks: this.audioTracks?.length || 0,
      beats: this.beats?.length || 0,
      trim: `${this.trimStart}-${this.trimEnd}`,
    };
    return JSON.stringify(state);
  },

  /**
   * Persist undo stack to localStorage for crash recovery
   */
  _persistUndoStackToStorage() {
    try {
      // Only keep last 10 undo states in localStorage (to save space)
      const recentStates = this.undoStack.slice(-10);
      localStorage.setItem('videoEditor_undoStack', JSON.stringify(recentStates));
    } catch (error) {
      console.warn('[SaveSystem] Could not persist undo stack:', error);
    }
  },

  /**
   * Restore undo stack from localStorage (on app start)
   */
  _restoreUndoStackFromStorage() {
    try {
      const saved = localStorage.getItem('videoEditor_undoStack');
      if (saved) {
        const states = JSON.parse(saved);
        if (Array.isArray(states) && states.length > 0) {
          console.log(`[SaveSystem] Restored ${states.length} undo states from storage`);
          // Don't auto-restore - just make available for manual recovery
          this._recoveryStates = states;
        }
      }

      // Check for emergency backup
      const emergency = localStorage.getItem('videoEditor_emergencyBackup');
      if (emergency) {
        const backup = JSON.parse(emergency);
        const age = Date.now() - (backup.timestamp || 0);
        const ageMinutes = Math.round(age / 60000);

        if (age < 24 * 60 * 60 * 1000) {
          // Less than 24 hours old
          console.log(`[SaveSystem] Found emergency backup from ${ageMinutes} minutes ago`);
          this._emergencyBackup = backup;
        }
      }
    } catch (error) {
      console.warn('[SaveSystem] Could not restore undo stack:', error);
    }
  },

  /**
   * Recover from emergency backup (called by user)
   */
  recoverFromBackup() {
    if (!this._emergencyBackup) {
      this.showToast && this.showToast('info', 'No backup available');
      return false;
    }

    const backup = this._emergencyBackup;
    const age = Date.now() - (backup.timestamp || 0);
    const ageMinutes = Math.round(age / 60000);

    if (confirm(`Recover from backup made ${ageMinutes} minutes ago?\n\nThis will replace your current work.`)) {
      this._restoreUndoState(backup);
      localStorage.removeItem('videoEditor_emergencyBackup');
      this._emergencyBackup = null;
      this.showToast && this.showToast('success', 'Recovered from backup');
      return true;
    }

    return false;
  },

  /**
   * Update save status indicator in UI
   */
  _updateSaveIndicator(status) {
    // Create indicator if it doesn't exist
    let indicator = document.getElementById('saveIndicator');
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.id = 'saveIndicator';
      indicator.style.cssText = `
            position: fixed;
            bottom: 10px;
            right: 10px;
            padding: 6px 12px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: 500;
            z-index: 9999;
            display: flex;
            align-items: center;
            gap: 6px;
            transition: all 0.3s ease;
          `;
      document.body.appendChild(indicator);
    }

    const statusConfig = {
      saved: {
        bg: 'rgba(34, 197, 94, 0.2)',
        border: 'rgba(34, 197, 94, 0.4)',
        color: '#22c55e',
        icon: '✓',
        text: 'Saved',
      },
      unsaved: {
        bg: 'rgba(234, 179, 8, 0.2)',
        border: 'rgba(234, 179, 8, 0.4)',
        color: '#eab308',
        icon: '●',
        text: 'Unsaved changes',
      },
      saving: {
        bg: 'rgba(59, 130, 246, 0.2)',
        border: 'rgba(59, 130, 246, 0.4)',
        color: '#3b82f6',
        icon: '↻',
        text: 'Saving...',
      },
      retrying: {
        bg: 'rgba(249, 115, 22, 0.2)',
        border: 'rgba(249, 115, 22, 0.4)',
        color: '#f97316',
        icon: '↻',
        text: `Retrying save (${this.saveRetryCount}/${this.maxSaveRetries})...`,
      },
      error: {
        bg: 'rgba(239, 68, 68, 0.2)',
        border: 'rgba(239, 68, 68, 0.4)',
        color: '#ef4444',
        icon: '✗',
        text: 'Save failed - backed up locally',
      },
    };

    const config = statusConfig[status] || statusConfig.saved;

    indicator.style.background = config.bg;
    indicator.style.border = `1px solid ${config.border}`;
    indicator.style.color = config.color;
    indicator.innerHTML = `<span style="font-size: 14px;">${config.icon}</span> ${config.text}`;

    // Auto-hide "Saved" indicator after 3 seconds
    if (status === 'saved') {
      setTimeout(() => {
        if (indicator.innerHTML.includes('Saved')) {
          indicator.style.opacity = '0.5';
        }
      }, 3000);
    } else {
      indicator.style.opacity = '1';
    }
  },
  // ==================== END HARDENED UNDO/SAVE SYSTEM ====================

  // Clip selection
  selectClip(clipType, event) {
    this.selectedClip = clipType;
    // Update visual selection
    document.querySelectorAll('.timeline-clip').forEach((el) => {
      el.classList.toggle('selected', el.id === 'videoClip' && clipType === 'video');
    });

    // Also seek to clicked position (don't stop propagation, let seekToPosition handle it)
    if (event && clipType === 'video') {
      this.seekToPosition(event);
    }
  },

  // Deselect clip when clicking elsewhere
  deselectClip() {
    this.selectedClip = null;
    document.querySelectorAll('.timeline-clip').forEach((el) => {
      el.classList.remove('selected');
    });
  },

  // Slice at playhead - adds visual cut marker
  sliceAtPlayhead() {
    const video = document.getElementById('videoPlayer');
    if (!video || !video.duration) return;

    const time = video.currentTime;
    // Don't add duplicate markers at same position
    if (this.sliceMarkers.some((t) => Math.abs(t - time) < 0.1)) {
      this.showToast('info', 'Slice marker already exists here');
      return;
    }

    // Push undo state BEFORE making changes
    this.pushUndoState(`Add slice at ${this.formatTime(time)}`);

    this.sliceMarkers.push(time);
    this.sliceMarkers.sort((a, b) => a - b);
    this.computeSegments();
    this.renderClipOverlays();
    this.renderSegments();
    this.showToast('success', `Slice marker added at ${this.formatTime(time)}`);
  },

  // Compute segments from slice markers
  computeSegments() {
    const video = document.getElementById('videoPlayer');
    const duration = video?.duration || this.videoInfo?.duration || 0;
    if (duration <= 0) {
      this.segments = [];
      return;
    }

    // Create segments from slice markers
    // Segments: [0, marker1], [marker1, marker2], ... [markerN, duration]
    const markers = [0, ...this.sliceMarkers, duration];
    this.segments = [];

    for (let i = 0; i < markers.length - 1; i++) {
      this.segments.push({
        id: `seg-${i}`,
        index: i,
        startTime: markers[i],
        endTime: markers[i + 1],
        deleted: false, // For tracking deleted segments
      });
    }

    // Clear selection if selected segment no longer exists
    if (this.selectedSegment) {
      const exists = this.segments.some((s) => s.id === this.selectedSegment);
      if (!exists) this.selectedSegment = null;
    }
  },

  // Select a segment by ID
  selectSegment(segmentId, event) {
    if (event) event.stopPropagation();

    this.selectedSegment = segmentId;
    this.renderSegments();

    // Update UI to show segment is selected
    const segment = this.segments.find((s) => s.id === segmentId);
    if (segment) {
      this.showToast(
        'info',
        `Segment selected: ${this.formatTime(segment.startTime)} - ${this.formatTime(segment.endTime)}`
      );
    }
  },

  // Deselect segment
  deselectSegment() {
    this.selectedSegment = null;
    this.renderSegments();
  },

  // Delete selected segment or marker
  deleteSelectedSegment() {
    // First check if a marker is selected
    if (this.selectedMarker) {
      this.deleteMarker(this.selectedMarker);
      this.selectedMarker = null;
      return;
    }

    // Then check if a segment is selected
    if (this.selectedSegment) {
      const segment = this.segments.find((s) => s.id === this.selectedSegment);
      if (segment) {
        // Mark segment as deleted (for visual feedback)
        segment.deleted = true;
        this.showToast(
          'success',
          `Segment removed: ${this.formatTime(segment.startTime)} - ${this.formatTime(segment.endTime)}`
        );
        this.selectedSegment = null;
        this.renderSegments();
      }
    } else {
      this.showToast('info', 'No segment selected');
    }
  },

  // Cut head - set trim start to playhead
  cutHead() {
    const video = document.getElementById('videoPlayer');
    if (!video || !video.duration) return;

    this.trimStart = video.currentTime;
    if (this.trimEnd && this.trimStart >= this.trimEnd) {
      this.trimEnd = 0; // Clear end if invalid
    }

    // Update UI
    const trimStartInput = document.getElementById('trimStart');
    if (trimStartInput) {
      trimStartInput.value = this.formatTime(this.trimStart);
    }

    this.updateTrimRegion();
    this.renderClipOverlays();
    this.showToast('success', `Cut head: keeping from ${this.formatTime(this.trimStart)}`);
  },

  // Cut tail - set trim end to playhead
  cutTail() {
    const video = document.getElementById('videoPlayer');
    if (!video || !video.duration) return;

    this.trimEnd = video.currentTime;
    if (this.trimStart >= this.trimEnd) {
      this.trimStart = 0; // Clear start if invalid
    }

    // Update UI
    const trimEndInput = document.getElementById('trimEnd');
    if (trimEndInput) {
      trimEndInput.value = this.formatTime(this.trimEnd);
    }

    this.updateTrimRegion();
    this.renderClipOverlays();
    this.showToast('success', `Cut tail: keeping until ${this.formatTime(this.trimEnd)}`);
  },

  // Add fade in effect
  addFadeIn() {
    const video = document.getElementById('videoPlayer');
    if (!video || !video.duration) return;

    // Toggle: if already set, remove it; otherwise set to 1 second
    if (this.fades.fadeIn) {
      this.fades.fadeIn = null;
      this.showToast('info', 'Fade in removed');
    } else {
      this.fades.fadeIn = 1.0; // 1 second fade
      this.showToast('success', 'Fade in added (1s)');
    }

    this.renderClipOverlays();
  },

  // Add fade out effect
  addFadeOut() {
    const video = document.getElementById('videoPlayer');
    if (!video || !video.duration) return;

    // Toggle: if already set, remove it; otherwise set to 1 second
    if (this.fades.fadeOut) {
      this.fades.fadeOut = null;
      this.showToast('info', 'Fade out removed');
    } else {
      this.fades.fadeOut = 1.0; // 1 second fade
      this.showToast('success', 'Fade out added (1s)');
    }

    this.renderClipOverlays();
  },

  // Reset all edits
  resetAllEdits() {
    this.trimStart = 0;
    this.trimEnd = 0;
    this.fades.fadeIn = null;
    this.fades.fadeOut = null;
    this.sliceMarkers = [];

    // Update UI
    const trimStartInput = document.getElementById('trimStart');
    const trimEndInput = document.getElementById('trimEnd');
    if (trimStartInput) trimStartInput.value = '00:00:00';
    if (trimEndInput) trimEndInput.value = '00:00:00';

    this.updateTrimRegion();
    this.renderClipOverlays();
    this.showToast('success', 'All edits cleared');
  },

  // Render fade overlays and slice markers on the clip
  renderClipOverlays() {
    const video = document.getElementById('videoPlayer');
    const clipEl = document.getElementById('videoClip');
    if (!clipEl || !video || !video.duration) return;

    // Remove existing overlays
    clipEl.querySelectorAll('.fade-overlay, .slice-marker').forEach((el) => el.remove());

    const duration = video.duration;

    // Render fade in overlay
    if (this.fades.fadeIn) {
      const fadeInWidth = (this.fades.fadeIn / duration) * 100;
      const fadeInEl = document.createElement('div');
      fadeInEl.className = 'fade-overlay fade-in';
      fadeInEl.style.width = `${fadeInWidth}%`;
      fadeInEl.innerHTML = `<span class="fade-label">Fade In</span>`;
      clipEl.appendChild(fadeInEl);
    }

    // Render fade out overlay
    if (this.fades.fadeOut) {
      const fadeOutWidth = (this.fades.fadeOut / duration) * 100;
      const fadeOutEl = document.createElement('div');
      fadeOutEl.className = 'fade-overlay fade-out';
      fadeOutEl.style.width = `${fadeOutWidth}%`;
      fadeOutEl.innerHTML = `<span class="fade-label">Fade Out</span>`;
      clipEl.appendChild(fadeOutEl);
    }

    // Render slice markers
    this.sliceMarkers.forEach((time, index) => {
      const position = (time / duration) * 100;
      const markerEl = document.createElement('div');
      markerEl.className = 'slice-marker';
      markerEl.style.left = `${position}%`;
      markerEl.title = `Slice at ${this.formatTime(time)} (click to remove)`;
      markerEl.onclick = (e) => {
        e.stopPropagation();
        this.removeSliceMarker(index);
      };
      clipEl.appendChild(markerEl);
    });
  },

  // Remove a slice marker
  removeSliceMarker(index) {
    const time = this.sliceMarkers[index];
    this.sliceMarkers.splice(index, 1);
    this.computeSegments();
    this.renderClipOverlays();
    this.renderSegments();
    this.showToast('info', `Slice marker removed at ${this.formatTime(time)}`);
  },

  // Render segment overlays on the video track
  renderSegments() {
    const video = document.getElementById('videoPlayer');
    const clipEl = document.getElementById('videoClip');
    if (!clipEl || !video || !video.duration) return;

    // Remove existing segment overlays
    clipEl.querySelectorAll('.segment-overlay').forEach((el) => el.remove());

    // If no segments or only one segment (no slices), don't render
    if (this.segments.length <= 1) return;

    const duration = video.duration;

    // Render each segment as a selectable overlay
    this.segments.forEach((segment, index) => {
      if (segment.deleted) return; // Skip deleted segments

      const startPercent = (segment.startTime / duration) * 100;
      const endPercent = (segment.endTime / duration) * 100;
      const widthPercent = endPercent - startPercent;

      const segEl = document.createElement('div');
      segEl.className = 'segment-overlay';
      segEl.dataset.segmentId = segment.id;
      segEl.style.left = `${startPercent}%`;
      segEl.style.width = `${widthPercent}%`;

      // Add selection state
      if (this.selectedSegment === segment.id) {
        segEl.classList.add('selected');
      }

      // Segment label
      const labelEl = document.createElement('span');
      labelEl.className = 'segment-label';
      labelEl.textContent = `${index + 1}`;
      segEl.appendChild(labelEl);

      // Click to select
      segEl.addEventListener('click', (e) => {
        e.stopPropagation();
        this.selectSegment(segment.id, e);
      });

      // Right-click for context menu (handled by handleContextMenu)
      segEl.addEventListener('contextmenu', (e) => {
        e.stopPropagation();
        this.selectSegment(segment.id, e);
        // Context menu will be triggered by the main handler
      });

      clipEl.appendChild(segEl);
    });
  },

  // Toggle collapsible section
  toggleSection(sectionId) {
    const section = document.getElementById(sectionId);
    if (section) {
      section.classList.toggle('collapsed');
    }
  },

  // Initialize
  async init() {
    // Bind drag handlers
    this.handleMarkerDrag = this._handleMarkerDrag.bind(this);
    this.handleMarkerDragEnd = this._handleMarkerDragEnd.bind(this);

    this.setupEventListeners();
    this.setupDragDrop();
    this.setupProgressListener();
    this.setupContextMenu();
    this.setupScrollScrub();
    this.setupTimelineScrubbing();
    this.setupTimelineZoom();
    this.loadSpaces();
    this.loadExports();

    // Log feature initialization
    if (window.api && window.api.logFeatureUsed) {
      window.api.logFeatureUsed('video-editor', { status: 'initialized' });
    }

    // Setup quality preset buttons
    document.querySelectorAll('.preset-btn[data-quality]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.preset-btn[data-quality]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.quality = btn.dataset.quality;
      });
    });

    // Set initial mode and layout
    this.setMode('edit');
    this.switchLayout('edit');

    // Initialize ADR Track Manager
    this.initADRManager();

    // Initialize Planning Panel
    this.initPlanningPanel();

    // Initialize hardened save system (CRITICAL - protects user work)
    this.initSaveSystem();

    // Check for crash recovery
    if (this._emergencyBackup) {
      const age = Date.now() - (this._emergencyBackup.timestamp || 0);
      const ageMinutes = Math.round(age / 60000);
      this.showToast(
        'warning',
        `Found unsaved work from ${ageMinutes} min ago. Type app.recoverFromBackup() in console to restore.`
      );
    }
  },

  // Initialize Planning Panel
  async initPlanningPanel() {
    try {
      const { PlanningPanel } = await import('./src/video-editor/planning/index.js');
      this.planningPanel = new PlanningPanel(this);
      this.planningPanel.init();
      console.log('[Video Editor] Planning panel initialized');
    } catch (error) {
      console.warn('[Video Editor] PlanningPanel not found:', error.message);
    }
  },

  // Toggle Planning Panel visibility
  togglePlanningPanel() {
    if (this.planningPanel) {
      this.planningPanel.toggle();
    }
  },

  // Switch Planning Panel tab
  switchPlanningTab(tabName) {
    if (this.planningPanel) {
      this.planningPanel.switchTab(tabName);
    }
  },

  // Add planning character
  addPlanningCharacter() {
    if (this.planningPanel) {
      this.planningPanel.addCharacter();
    }
  },

  // Add planning scene
  addPlanningScene() {
    if (this.planningPanel) {
      this.planningPanel.addScene();
    }
  },

  // Add planning location
  addPlanningLocation() {
    if (this.planningPanel) {
      this.planningPanel.addLocation();
    }
  },

  // Add planning story beat
  addPlanningBeat() {
    if (this.planningPanel) {
      this.planningPanel.addStoryBeat();
    }
  },

  // Generate markers from planning scenes
  generateMarkersFromScenes() {
    if (this.planningPanel) {
      this.planningPanel.generateMarkersFromScenes();
    }
  },

  // Import planning data
  importPlanning() {
    if (this.planningPanel) {
      this.planningPanel.importPlanning();
    }
  },

  // Export planning data
  exportPlanning() {
    if (this.planningPanel) {
      this.planningPanel.exportPlanning();
    }
  },

  // Initialize ADR (Automated Dialogue Replacement) Track Manager
  initADRManager() {
    if (typeof ADRTrackManager !== 'undefined') {
      this.adrManager = new ADRTrackManager(this);
      this.trackContextMenu = new TrackContextMenu(this, this.adrManager);
      console.log('[Video Editor] ADR module initialized');
    } else {
      console.warn('[Video Editor] ADRTrackManager not found - adr-track-manager.js may not be loaded');
    }

    // Initialize Multi-Track Audio Manager
    this.initMultiTrackAudio();
  },

  // Initialize Multi-Track Audio Manager for multi-track playback
  async initMultiTrackAudio() {
    try {
      const { MultiTrackAudioManager } = await import('./src/video-editor/audio/index.js');
      this.multiTrackAudio = new MultiTrackAudioManager(this);
      console.log('[Video Editor] Multi-track audio manager initialized');
    } catch (error) {
      console.warn('[Video Editor] MultiTrackAudioManager not found:', error.message);
    }
  },

  // Mode Switching
  setMode(mode) {
    this.currentMode = mode;
    document.body.setAttribute('data-mode', mode);

    const modeTitle = document.getElementById('modeTitle');
    const modeIndicator = document.getElementById('modeIndicator');

    // Switch sidebar tab and update header based on mode
    if (mode === 'edit') {
      this.switchTab('edit');
      if (modeTitle) modeTitle.textContent = 'Edit Mode';
      if (modeIndicator) {
        modeIndicator.textContent = '✂';
        modeIndicator.style.color = '#4a9eff';
      }
    } else if (mode === 'annotate') {
      this.switchTab('scenes');
      if (modeTitle) modeTitle.textContent = 'Annotate Mode';
      if (modeIndicator) {
        modeIndicator.textContent = '◆';
        modeIndicator.style.color = '#8b5cf6';
      }
    }
  },

  // Layout Switching (Edit / Line Script / Story Beats)
  switchLayout(layout) {
    this.currentLayout = layout;
    document.body.setAttribute('data-layout', layout);

    // Update layout nav buttons
    document.getElementById('layoutEditBtn').classList.toggle('active', layout === 'edit');
    document.getElementById('layoutLineScriptBtn')?.classList.toggle('active', layout === 'linescript');
    document.getElementById('layoutBeatsBtn').classList.toggle('active', layout === 'beats');

    // Show/hide Line Script panel
    const lineScriptPanel = document.getElementById('lineScriptPanel');
    if (lineScriptPanel) {
      lineScriptPanel.classList.toggle('hidden', layout !== 'linescript');
    }

    // Update mode based on layout
    if (layout === 'edit') {
      this.setMode('edit');
    } else if (layout === 'linescript') {
      this.setMode('annotate'); // Line Script uses annotate mode for marking
      // Initialize Line Script if available
      if (this.lineScriptPanel) {
        this.lineScriptPanel.show();
      }
    } else if (layout === 'beats') {
      this.setMode('annotate');
    }

    console.log('[VideoEditor] Switched to layout:', layout);
  },

  // Line Script Mode Switching
  setLineScriptMode(mode) {
    if (!this.lineScriptPanel) return;
    this.lineScriptPanel.setMode(mode);
  },

  // Toggle Line Script Mode Lock
  toggleLineScriptModeLock() {
    if (!this.adaptiveModeManager) return;
    const locked = this.adaptiveModeManager.toggleLock();
    const btn = document.getElementById('lineScriptModeLockBtn');
    if (btn) {
      btn.textContent = locked ? '🔒' : '🔓';
    }
  },

  // Voice Spotting Toggle
  toggleVoiceSpotting() {
    if (!this.voiceSpottingController) {
      this.showToast('Voice commands not available', 'warning');
      return;
    }

    if (this.voiceSpottingController.isActive) {
      this.voiceSpottingController.stop();
      document.getElementById('voiceSpottingBtn')?.classList.remove('active');
      document.getElementById('voiceSpottingStatus')?.classList.add('hidden');
    } else {
      this.voiceSpottingController.start();
      document.getElementById('voiceSpottingBtn')?.classList.add('active');
      document.getElementById('voiceSpottingStatus')?.classList.remove('hidden');
    }
  },

  // Generate Line Script AI Metadata
  async generateLineScriptAI() {
    if (!this.lineScriptAI) {
      this.showToast('AI generation not available', 'warning');
      return;
    }

    try {
      await this.lineScriptAI.startProcessing();
    } catch (error) {
      console.error('[VideoEditor] AI generation error:', error);
      if (window.api && window.api.log) {
        window.api.log.error('Video editor AI generation failed', {
          error: error.message,
          operation: 'aiGeneration',
        });
      }
      this.showToast('AI generation failed: ' + error.message, 'error');
    }
  },

  // Export Line Script
  exportLineScript(formatId = null, templateId = null) {
    if (!this.lineScriptPanel) return;

    // Use provided format or fall back to selected
    const format = formatId || this._selectedExportFormat || 'youtube-chapters';
    const template = templateId || this.storyBeatsEditor?.selectedTemplate || 'learning';

    // Generate export content
    this.generateExportContent(format, template)
      .then((content) => {
        if (content) {
          this.downloadExport(content, format);
        }
      })
      .catch((err) => {
        this.showToast('Export failed: ' + err.message, 'error');
      });
  },

  // Copy Line Script to Clipboard
  copyLineScriptToClipboard(formatId = null, templateId = null) {
    if (!this.lineScriptPanel) return;

    const format = formatId || this._selectedExportFormat || 'youtube-chapters';
    const template = templateId || this.storyBeatsEditor?.selectedTemplate || 'learning';

    this.generateExportContent(format, template)
      .then((content) => {
        if (content && navigator.clipboard) {
          navigator.clipboard.writeText(content);
          this.showToast('Copied to clipboard!', 'success');
        }
      })
      .catch((err) => {
        this.showToast('Copy failed: ' + err.message, 'error');
      });
  },

  // Generate export content based on format
  async generateExportContent(formatId, templateId) {
    const data = {
      title: this.projectTitle || 'Video Project',
      markers: this.markers,
      topics: this.markers.filter((m) => m.markerType === 'chapter' || m.type === 'range'),
      duration: this.videoDuration,
      transcriptSegments: this.transcriptSegments,
      speakers: this.transcriptSpeakers,
    };

    // Use ExportPresets if available via bridge
    if (window.ExportPresets) {
      const presets = new window.ExportPresets(this);
      return presets.generateExport(formatId, templateId, data);
    }

    // Fallback implementations for learning exports
    switch (formatId) {
      case 'youtube-chapters':
        return this.generateYouTubeChapters(data);
      case 'course-outline':
        return this.generateCourseOutline(data);
      case 'study-guide':
        return this.generateStudyGuide(data);
      case 'flashcards':
        return this.generateFlashcards(data);
      case 'quiz-questions':
        return this.generateQuizQuestions(data);
      default:
        return this.generateYouTubeChapters(data);
    }
  },

  // Generate YouTube chapters
  generateYouTubeChapters(data) {
    const chapters = data.markers
      .filter((m) => m.markerType === 'chapter' || m.type === 'range')
      .sort((a, b) => (a.inTime || a.time) - (b.inTime || b.time));

    if (chapters.length === 0) {
      return '0:00 Introduction\n';
    }

    return chapters
      .map((ch) => {
        const time = ch.inTime || ch.time || 0;
        const mins = Math.floor(time / 60);
        const secs = Math.floor(time % 60);
        const timestamp = `${mins}:${secs.toString().padStart(2, '0')}`;
        return `${timestamp} ${ch.name || 'Chapter'}`;
      })
      .join('\n');
  },

  // Generate course outline
  generateCourseOutline(data) {
    let md = `# Course Outline: ${data.title}\n\n`;
    md += `Total Duration: ${this.formatTime(data.duration)}\n\n`;

    const keyPoints = data.markers.filter((m) => m.markerType === 'keypoint');
    if (keyPoints.length) {
      md += `## Learning Objectives\n\n`;
      keyPoints.slice(0, 5).forEach((kp, i) => {
        md += `${i + 1}. ${kp.name}\n`;
      });
      md += '\n';
    }

    md += `## Course Structure\n\n`;
    const chapters = data.markers.filter((m) => m.markerType === 'chapter' || m.type === 'range');
    chapters.forEach((ch, i) => {
      md += `### ${i + 1}. ${ch.name || 'Chapter ' + (i + 1)}\n`;
      md += `*${this.formatTime(ch.inTime || ch.time)}*\n`;
      if (ch.description) md += `\n${ch.description}\n`;
      md += '\n';
    });

    return md;
  },

  // Generate study guide
  generateStudyGuide(data) {
    let md = `# Study Guide: ${data.title}\n\n`;

    const concepts = data.markers.filter((m) => m.markerType === 'concept' || m.markerType === 'keypoint');
    if (concepts.length) {
      md += `## Key Concepts\n\n`;
      concepts.forEach((concept) => {
        md += `### ${concept.name}\n`;
        md += `*Timestamp: ${this.formatTime(concept.time || concept.inTime)}*\n\n`;
        if (concept.description) md += `${concept.description}\n\n`;
      });
    }

    const examples = data.markers.filter((m) => m.markerType === 'example');
    if (examples.length) {
      md += `## Examples\n\n`;
      examples.forEach((ex) => {
        md += `- **${ex.name}** at ${this.formatTime(ex.time || ex.inTime)}\n`;
      });
      md += '\n';
    }

    const quizPoints = data.markers.filter((m) => m.markerType === 'quiz');
    if (quizPoints.length) {
      md += `## Review Questions\n\n`;
      quizPoints.forEach((quiz, i) => {
        md += `${i + 1}. ${quiz.name || 'Question ' + (i + 1)}\n`;
      });
    }

    return md;
  },

  // Generate flashcards (Anki CSV format)
  generateFlashcards(data) {
    let csv = 'Front,Back,Tags\n';

    data.markers
      .filter((m) => m.markerType === 'keypoint' || m.markerType === 'concept')
      .forEach((marker) => {
        const front = `What is ${marker.name.toLowerCase()}?`.replace(/,/g, ';');
        const back = (marker.description || marker.name).replace(/,/g, ';').replace(/\n/g, ' ');
        const tags = [data.title || 'course', marker.markerType].join(' ');
        csv += `"${front}","${back}","${tags}"\n`;
      });

    return csv;
  },

  // Generate quiz questions (JSON format)
  generateQuizQuestions(data) {
    const questions = data.markers
      .filter((m) => m.markerType === 'quiz')
      .map((marker, i) => ({
        id: `q-${i}`,
        type: 'open',
        question: marker.name || `Explain the concept at ${this.formatTime(marker.time)}`,
        timestamp: marker.time || marker.inTime,
        hints: marker.description ? [marker.description] : [],
      }));

    return JSON.stringify({ questions, courseTitle: data.title }, null, 2);
  },

  // Download export file
  downloadExport(content, formatId) {
    const formats = {
      'youtube-chapters': { ext: 'txt', mime: 'text/plain' },
      'course-outline': { ext: 'md', mime: 'text/markdown' },
      'study-guide': { ext: 'md', mime: 'text/markdown' },
      flashcards: { ext: 'csv', mime: 'text/csv' },
      'quiz-questions': { ext: 'json', mime: 'application/json' },
    };

    const format = formats[formatId] || formats['youtube-chapters'];
    const filename = `${this.projectTitle || 'export'}_${formatId}.${format.ext}`;

    const blob = new Blob([content], { type: format.mime });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    this.showToast(`Downloaded ${filename}`, 'success');
  },

  // Export all formats
  exportAllFormats() {
    const formats = ['youtube-chapters', 'course-outline', 'study-guide', 'flashcards', 'quiz-questions'];
    const template = this.storyBeatsEditor?.selectedTemplate || 'learning';

    formats.forEach((formatId) => {
      this.generateExportContent(formatId, template).then((content) => {
        if (content) {
          this.downloadExport(content, formatId);
        }
      });
    });

    this.showToast('Exporting all formats...', 'info');
  },

  // Preview export format
  previewExport(formatId, templateId) {
    this._selectedExportFormat = formatId;

    this.generateExportContent(formatId, templateId).then((content) => {
      const preview = document.getElementById('lineScriptExportPreview');
      if (preview) {
        preview.textContent = content?.substring(0, 1000) || 'No content generated';
        if (content?.length > 1000) {
          preview.textContent += '\n\n... (truncated for preview)';
        }
      }
    });
  },

  // Open Recorder
  async openRecorder() {
    try {
      // Prepare recording instructions if we have a video loaded
      const options = {};

      if (this.videoPath) {
        options.instructions = `Record a segment to replace or add to: ${this.videoPath.split('/').pop()}`;
        if (this.selectedSpace) {
          options.spaceId = this.selectedSpace.id || this.selectedSpace;
        }
      }

      // Call IPC to open recorder
      if (window.videoEditor && window.videoEditor.openRecorder) {
        const result = await window.videoEditor.openRecorder(options);
        if (result.success) {
          this.showToast('Recorder opened', 'info');
        } else {
          throw new Error(result.error || 'Failed to open recorder');
        }
      } else {
        console.warn('[VideoEditor] Recorder API not available');
        this.showToast('Recorder not available', 'error');
      }
    } catch (error) {
      console.error('[VideoEditor] Error opening recorder:', error);
      if (window.api && window.api.log) {
        window.api.log.error('Video editor open recorder failed', {
          error: error.message,
          operation: 'openRecorder',
        });
      }
      this.showToast('Failed to open recorder: ' + error.message, 'error');
    }
  },

  // Setup event listeners
  setupEventListeners() {
    const video = document.getElementById('videoPlayer');

    video.addEventListener('timeupdate', () => {
      // Update timeline position based on current clip + video time
      if (this.videoClips.length > 0 && this.activeSourceId) {
        const activeClip = this.videoClips.find((c) => c.sourceId === this.activeSourceId);
        if (activeClip) {
          const offsetIntoClip = video.currentTime - activeClip.sourceIn;
          this.currentTimelinePosition = activeClip.timelineStart + offsetIntoClip;
        }
      } else {
        // Legacy single video mode
        this.currentTimelinePosition = video.currentTime;
      }

      this.updateTimeDisplay();
      this.updateAudioPlayhead();
      this.updateTeleprompterHighlight(video.currentTime);

      // Multi-source: Check if we need to switch sources at clip boundaries
      this.checkClipBoundaries();
    });
    video.addEventListener('loadedmetadata', () => this.onVideoLoaded());
    video.addEventListener('play', () => {
      this.isPlaying = true;
      this.updatePlayButtonIcon(true);
    });
    video.addEventListener('pause', () => {
      this.isPlaying = false;
      this.updatePlayButtonIcon(false);
    });
    video.addEventListener('ended', () => {
      this.isPlaying = false;
      this.updatePlayButtonIcon(false);
    });

    // Sync seek to detached window when timeline is clicked/scrubbed
    video.addEventListener('seeked', () => {
      if (this.videoDetached) {
        this.syncToDetachedWindow();
      }
    });

    // Volume slider
    document.getElementById('volumeSlider').addEventListener('input', (e) => {
      video.volume = e.target.value;
      this.updateMuteIcon();
    });

    // Trim inputs
    document.getElementById('trimStart').addEventListener('change', (e) => {
      this.trimStart = this.parseTime(e.target.value);
      this.updateTrimRegion();
    });
    document.getElementById('trimEnd').addEventListener('change', (e) => {
      this.trimEnd = this.parseTime(e.target.value);
      this.updateTrimRegion();
    });

    // Splice inputs
    document.getElementById('spliceStart').addEventListener('change', () => {
      this.updateSplicePreview();
    });
    document.getElementById('spliceEnd').addEventListener('change', () => {
      this.updateSplicePreview();
    });
  },

  // Setup drag and drop
  setupDragDrop() {
    const dropZone = document.getElementById('dropZone');

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((eventName) => {
      dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    });

    ['dragenter', 'dragover'].forEach((eventName) => {
      dropZone.addEventListener(eventName, () => dropZone.classList.add('drag-over'));
    });

    ['dragleave', 'drop'].forEach((eventName) => {
      dropZone.addEventListener(eventName, () => dropZone.classList.remove('drag-over'));
    });

    dropZone.addEventListener('drop', (e) => {
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        const file = files[0];
        if (file.type.startsWith('video/') || this.isVideoFile(file.name)) {
          this.loadVideo(file.path);
        } else {
          this.showToast('error', 'Please drop a video file');
        }
      }
    });
  },

  isVideoFile(filename) {
    const videoExtensions = ['.mp4', '.avi', '.mov', '.wmv', '.flv', '.mkv', '.webm', '.m4v', '.mpg', '.mpeg'];
    return videoExtensions.some((ext) => filename.toLowerCase().endsWith(ext));
  },

  // Setup progress listener
  setupProgressListener() {
    if (window.videoEditor) {
      window.videoEditor.onProgress((progress) => {
        this.updateProgress(progress);
      });

      // Listen for file load requests (from Spaces)
      window.videoEditor.onLoadFile((filePath) => {
        console.log('[VideoEditor] Received load file request:', filePath);
        if (filePath) {
          this.loadVideo(filePath);
        }
      });
    }
  },

  // Marker Functions
  editingMarkerId: null,
  selectedMarkerColor: null,
  selectedMarkerType: 'spot',
  rangeInTime: 0,
  rangeOutTime: 0,
  selectedMarkerForDetails: null,
  metadataExpanded: true,

  toggleMetadataSection() {
    this.metadataExpanded = !this.metadataExpanded;
    document.getElementById('metadataContent').classList.toggle('collapsed', !this.metadataExpanded);
    document.getElementById('metadataToggle').classList.toggle('collapsed', !this.metadataExpanded);
  },

  async transcribeMarkerRange() {
    if (!this.videoPath) {
      this.showToast('error', 'No video loaded');
      return;
    }

    const btn = document.getElementById('transcribeRangeBtn');
    const status = document.getElementById('transcriptionStatus');
    const textarea = document.getElementById('markerTranscription');

    // Determine the time range based on marker type
    let startTime, endTime;

    if (this.selectedMarkerType === 'range') {
      startTime = this.rangeInTime;
      endTime = this.rangeOutTime;
    } else {
      // For spot markers, transcribe 10 seconds around the marker
      const spotTime = parseFloat(document.getElementById('markerModal').dataset.time);
      startTime = Math.max(0, spotTime - 5);
      const video = document.getElementById('videoPlayer');
      endTime = Math.min(video.duration, spotTime + 5);
    }

    const duration = endTime - startTime;

    // Show loading state
    btn.disabled = true;
    btn.innerHTML = '⏳ Loading...';
    status.classList.remove('hidden');
    status.innerHTML = `Checking for existing transcription...`;

    try {
      // FIRST: Try to get transcription from Space metadata (if video loaded from Space)
      if (this.spaceItemId) {
        console.log('[Transcription] Checking Space for existing transcription:', this.spaceItemId);
        status.innerHTML = `📚 Fetching transcription from Space...`;

        const transcriptResult = await window.clipboard.getTranscription(this.spaceItemId);

        if (transcriptResult?.success && transcriptResult.transcription) {
          console.log('[Transcription] Found existing transcription:', transcriptResult.transcription.length, 'chars');

          // Check if we have timecoded segments in metadata
          const metadataResult = await window.clipboard.getMetadata(this.spaceItemId);

          console.log('[Transcription] Metadata result:', metadataResult ? 'found' : 'not found');

          // Check multiple possible locations for segments
          const segments = metadataResult?.transcriptSegments || metadataResult?.transcript?.segments || null;

          if (segments && segments.length > 0) {
            console.log('[Transcription] Found', segments.length, 'timecoded segments');

            // Filter segments that overlap with our range
            const relevantSegments = segments.filter((seg) => {
              const segStart = seg.start || 0;
              const segEnd = seg.end !== undefined ? seg.end : seg.start + (seg.duration || 5);
              // Segment overlaps if it starts before range ends AND ends after range starts
              return segStart < endTime && segEnd > startTime;
            });

            console.log(
              '[Transcription] Filtered to',
              relevantSegments.length,
              'relevant segments for range:',
              startTime,
              '-',
              endTime
            );

            if (relevantSegments.length > 0) {
              // Extract text from relevant segments
              const extractedText = relevantSegments.map((seg) => seg.text).join(' ');

              console.log('[Transcription] Extracted text length:', extractedText.length);

              textarea.value = extractedText;
              status.innerHTML = `✅ Extracted from ${relevantSegments.length} segments (${this.formatTime(startTime)} → ${this.formatTime(endTime)})`;
              this.showToast('success', 'Transcription loaded from Space!');
              this.updateElevenLabsButton(); // Show ElevenLabs button if range marker

              btn.disabled = false;
              btn.innerHTML = '🎤 Auto-Transcribe';
              return; // Success! No need to call OpenAI
            }
          } else {
            console.log('[Transcription] No segments found in metadata');
          }

          // Try plain text transcription if segments not available
          if (transcriptResult.transcription) {
            // No segments, but we have plain text - extract rough portion
            console.log('[Transcription] Using plain text transcription (no timecodes)');
            const fullDuration = this.videoInfo?.duration || 1;
            const startRatio = startTime / fullDuration;
            const endRatio = endTime / fullDuration;
            const transcriptLength = transcriptResult.transcription.length;

            const startChar = Math.floor(startRatio * transcriptLength);
            const endChar = Math.floor(endRatio * transcriptLength);
            const extractedText = transcriptResult.transcription.substring(startChar, endChar);

            if (extractedText.trim()) {
              textarea.value = extractedText;
              status.innerHTML = `✅ Estimated portion from full transcription (approximate)`;
              this.showToast('success', 'Transcription loaded from Space (estimated)!');
              this.updateElevenLabsButton();

              btn.disabled = false;
              btn.innerHTML = '🎤 Auto-Transcribe';
              return;
            }
          }
        }

        console.log('[Transcription] No existing transcription found in Space, falling back to OpenAI');
      }

      // FALLBACK: Use OpenAI Whisper to transcribe
      status.innerHTML = `🎤 Transcribing audio (${this.formatTime(startTime)} → ${this.formatTime(endTime)})...`;
      btn.innerHTML = '⏳ Transcribing...';

      const result = await window.videoEditor.transcribeRange(this.videoPath, {
        startTime,
        endTime,
        language: 'en',
      });

      if (!result.success) {
        throw new Error(result.error);
      }

      // Fill in the transcription
      textarea.value = result.transcription;
      status.innerHTML = `✅ Transcribed ${this.formatTime(duration)} of audio`;
      this.showToast('success', 'Transcription complete!');
      this.updateElevenLabsButton(); // Show ElevenLabs button if range marker
    } catch (error) {
      console.error('[Transcription] Error:', error);
      if (window.api && window.api.log) {
        window.api.log.error('Video editor transcription failed', {
          error: error.message,
          operation: 'transcription',
        });
      }
      status.innerHTML = `❌ ${error.message}`;
      this.showToast('error', 'Transcription failed: ' + error.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '🎤 Auto-Transcribe';
    }
  },

  // Screen Grabs
  currentScreengrabsDir: null,
  currentScreengrabs: [],

  async generateMarkerScreengrabs() {
    if (!this.videoPath) {
      this.showToast('error', 'No video loaded');
      return;
    }

    const count = parseInt(document.getElementById('screenGrabCount').value) || 5;

    if (count < 1 || count > 50) {
      this.showToast('error', 'Please enter a number between 1 and 50');
      return;
    }

    // Determine the time range based on marker type
    let startTime, endTime;

    if (this.selectedMarkerType === 'range') {
      startTime = this.rangeInTime;
      endTime = this.rangeOutTime;
    } else {
      // For spot markers, capture around the marker time
      const spotTime = parseFloat(document.getElementById('markerModal').dataset.time);
      const video = document.getElementById('videoPlayer');
      // Capture 10 seconds centered on the spot
      startTime = Math.max(0, spotTime - 5);
      endTime = Math.min(video.duration, spotTime + 5);
    }

    const duration = endTime - startTime;
    const btn = document.getElementById('generateGrabsBtn');

    btn.disabled = true;
    btn.innerHTML = '⏳ Generating...';

    this.showToast('info', `Generating ${count} frames from ${this.formatTime(duration)} of video...`);

    try {
      const result = await window.videoEditor.generateScreengrabs(this.videoPath, {
        startTime,
        endTime,
        count,
        prefix: 'frame',
      });

      if (!result.success) {
        throw new Error(result.error);
      }

      this.currentScreengrabsDir = result.outputDir;
      this.currentScreengrabs = result.frames;

      // Display the screengrabs
      this.displayScreengrabs(result.frames);

      this.showToast('success', `Generated ${result.count} screen grabs!`);
    } catch (error) {
      console.error('[ScreenGrabs] Error:', error);
      if (window.api && window.api.log) {
        window.api.log.error('Video editor screen grabs failed', {
          error: error.message,
          operation: 'screenGrabs',
        });
      }
      this.showToast('error', 'Failed to generate screen grabs: ' + error.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '📸 Generate';
    }
  },

  displayScreengrabs(frames) {
    const preview = document.getElementById('screengrabsPreview');
    const grid = document.getElementById('screengrabsGrid');
    const count = document.getElementById('screengrabsCount');

    if (!frames || frames.length === 0) {
      preview.classList.add('hidden');
      return;
    }

    // Build grid HTML
    grid.innerHTML = frames
      .map(
        (frame, i) => `
          <div class="screengrab-item" onclick="app.showScreengrabFull(${i})" title="Click to view full size">
            <img src="${pathToFileUrl(frame.path)}" alt="Frame ${frame.index}">
            <div class="screengrab-time">${frame.timeFormatted}</div>
          </div>
        `
      )
      .join('');

    count.textContent = `${frames.length} frames captured`;
    preview.classList.remove('hidden');
  },

  showScreengrabFull(index) {
    const frame = this.currentScreengrabs[index];
    if (!frame) return;

    // Create modal
    const modal = document.createElement('div');
    modal.className = 'screengrab-modal';
    modal.innerHTML = `
          <button class="screengrab-modal-close" onclick="this.parentElement.remove()">✕</button>
          <img src="${pathToFileUrl(frame.path)}" alt="Frame ${frame.index}">
          <div class="screengrab-modal-info">Frame ${frame.index} at ${frame.timeFormatted}</div>
        `;

    // Close on click outside
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });

    // Close on escape
    const escHandler = (e) => {
      if (e.key === 'Escape') {
        modal.remove();
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);

    document.body.appendChild(modal);
  },

  async openScreengrabsFolder() {
    if (this.currentScreengrabsDir) {
      await window.videoEditor.openExportFolder(this.currentScreengrabsDir);
    }
  },

  // Generate screengrabs for a marker by ID
  async generateScreengrabsForMarker(markerId, count = 5) {
    const marker = this.markers.find((m) => m.id === markerId);
    if (!marker) return;

    if (!this.videoPath) {
      this.showToast('error', 'No video loaded');
      return;
    }

    // Prompt for count
    const inputCount = prompt('How many screen grabs?', '5');
    if (!inputCount) return;

    count = parseInt(inputCount);
    if (isNaN(count) || count < 1 || count > 50) {
      this.showToast('error', 'Please enter a number between 1 and 50');
      return;
    }

    let startTime, endTime;

    if (marker.type === 'range') {
      startTime = marker.inTime;
      endTime = marker.outTime;
    } else {
      startTime = Math.max(0, marker.time - 5);
      const video = document.getElementById('videoPlayer');
      endTime = Math.min(video.duration, marker.time + 5);
    }

    const duration = endTime - startTime;

    this.showProgress('Generating Screen Grabs...', `Capturing ${count} frames from ${this.formatTime(duration)}`);

    try {
      const result = await window.videoEditor.generateScreengrabs(this.videoPath, {
        startTime,
        endTime,
        count,
        prefix: `marker_${markerId}_frame`,
      });

      this.hideProgress();

      if (!result.success) {
        throw new Error(result.error);
      }

      // Store screengrabs with marker
      marker.screengrabs = result.frames;
      marker.screengrabsDir = result.outputDir;
      marker.modifiedAt = new Date().toISOString();

      // Re-render
      this.renderMarkers();

      // Open the folder
      await window.videoEditor.openExportFolder(result.outputDir);

      this.showToast('success', `Generated ${result.count} screen grabs!`);
    } catch (error) {
      this.hideProgress();
      console.error('[ScreenGrabs] Error:', error);
      this.showToast('error', 'Failed to generate screen grabs: ' + error.message);
    }
  },

  // Transcribe a marker by ID (from details panel)
  // Update ElevenLabs button visibility in modal
  updateElevenLabsButton() {
    const elevenLabsSection = document.getElementById('elevenLabsSection');
    const rerecordSection = document.getElementById('adrRerecordSection');
    const transcription = document.getElementById('markerTranscription')?.value || '';
    const hasTranscription = transcription && transcription.trim() !== '';
    const isRange = this.selectedMarkerType === 'range';

    console.log('[ADR Buttons] Update:', {
      hasTranscription,
      isRange,
      transcriptionLength: transcription.length,
      markerType: this.selectedMarkerType,
    });

    // Show Re-record with AI button (new ADR workflow) when there's transcription
    if (rerecordSection) {
      if (hasTranscription && isRange) {
        rerecordSection.classList.remove('hidden');
      } else {
        rerecordSection.classList.add('hidden');
      }
    }

    // Keep legacy ElevenLabs button visible but de-emphasized
    if (elevenLabsSection) {
      if (hasTranscription && isRange) {
        elevenLabsSection.classList.remove('hidden');
      } else {
        elevenLabsSection.classList.add('hidden');
      }
    }
  },

  // Replace audio from modal (while creating/editing marker) - NON-DESTRUCTIVE
  async replaceAudioWithElevenLabsFromModal() {
    if (!this.videoPath) {
      this.showToast('error', 'No video loaded');
      return;
    }

    // Check if ElevenLabs API key is configured
    const keyCheck = await window.videoEditor.checkElevenLabsApiKey();
    if (!keyCheck.hasKey) {
      this.showElevenLabsKeyMissingAlert();
      return;
    }

    const transcription = document.getElementById('markerTranscription').value;
    if (!transcription || transcription.trim() === '') {
      this.showToast('error', 'Please add transcription first');
      return;
    }

    const markerName = document.getElementById('markerNameInput').value || 'Untitled Range';

    // Get range times
    const startTime = this.rangeInTime;
    const endTime = this.rangeOutTime;

    // Check budget before proceeding
    const shouldProceed = await this.confirmAICost(
      'elevenlabs',
      { text: transcription, characters: transcription.length },
      `Generate AI Voice for "${markerName}"`
    );
    if (!shouldProceed) {
      return;
    }

    try {
      this.showToast('info', 'Generating AI voice...', 3000);
      this.showProgress('AI Voice Generation', 'Calling ElevenLabs API...');

      // Generate audio only (non-destructive) - no video re-encoding!
      const result = await window.videoEditor.generateElevenLabsAudio({
        text: transcription,
        voice: 'Rachel', // TODO: add voice selector
      });

      this.hideProgress();

      if (result.error) {
        throw new Error(result.error);
      }

      // Add to voice overlay track (non-destructive!)
      await this.addAudioOverlay({
        name: markerName,
        path: result.audioPath,
        startTime,
        endTime,
        text: transcription,
        type: 'elevenlabs',
        markerId: this.editingMarkerId,
      });

      this.showToast('success', `Voice overlay added for "${markerName}"! Export when ready.`);

      // If editing existing marker, update it
      if (this.editingMarkerId) {
        const marker = this.markers.find((m) => m.id === this.editingMarkerId);
        if (marker) {
          marker.elevenLabsAudio = true;
          marker.elevenLabsGeneratedAt = new Date().toISOString();
          marker.hasOverlay = true;
          marker.modifiedAt = new Date().toISOString();
          this.renderMarkers();
        }
      }

      // Keep modal open so user can make more edits
      this.showToast('info', 'Add more replacements, then export all at once!', 5000);
    } catch (error) {
      this.hideProgress();
      console.error('[VideoEditor] ElevenLabs error:', error);
      if (window.api && window.api.log) {
        window.api.log.error('Video editor ElevenLabs generation failed', {
          error: error.message,
          operation: 'elevenLabsGenerate',
        });
      }
      this.showToast('error', 'Failed to generate audio: ' + error.message);
    }
  },

  // Add audio overlay to a voice track (non-destructive)
  async addAudioOverlay(options) {
    const { name, path, startTime, endTime, text, type, markerId } = options;

    // Find or create voice/AI track
    let voiceTrack = this.audioTracks.find((t) => t.type === 'voice');
    if (!voiceTrack) {
      this.addAudioTrack('voice');
      voiceTrack = this.audioTracks.find((t) => t.type === 'voice');
    }

    if (!voiceTrack) {
      throw new Error('Could not create voice track');
    }

    // Add clip to track
    const clip = {
      id: `clip-${Date.now()}`,
      name,
      path,
      startTime,
      endTime,
      duration: endTime - startTime,
      text,
      type,
      markerId,
      createdAt: new Date().toISOString(),
    };

    voiceTrack.clips.push(clip);
    this.renderTrackClips(voiceTrack.id);

    // Store in audio replacements array for export
    if (!this.audioReplacements) {
      this.audioReplacements = [];
    }
    this.audioReplacements.push(clip);

    console.log('[AudioOverlay] Added overlay:', clip);
    this.saveProject();
    this.updateAudioReplacementsCount();

    return clip;
  },

  // Get all pending audio replacements
  getAudioReplacements() {
    return this.audioReplacements || [];
  },

  // Export video with all audio replacements applied
  async exportWithAudioReplacements() {
    const replacements = this.getAudioReplacements();

    if (replacements.length === 0) {
      this.showToast('warning', 'No audio replacements to export');
      return;
    }

    const confirmed = confirm(
      `Export video with ${replacements.length} audio replacement(s)?\n\n` +
        replacements
          .map((r) => `• ${r.name} (${this.formatTime(r.startTime)} - ${this.formatTime(r.endTime)})`)
          .join('\n') +
        '\n\nThis will create a new video file with all replacements applied.'
    );

    if (!confirmed) return;

    try {
      this.showProgress('Exporting Video', `Applying ${replacements.length} audio replacements...`);

      const result = await window.videoEditor.exportWithAudioReplacements(this.videoPath, replacements);

      this.hideProgress();

      if (result.error) {
        throw new Error(result.error);
      }

      this.showToast('success', `Exported! Saved to: ${result.outputPath}`);

      // Ask if user wants to load the new video
      const loadNew = confirm('Export complete! Would you like to load the new video?');
      if (loadNew) {
        this.loadVideo(result.outputPath);
        // Clear replacements since they're now baked in
        this.audioReplacements = [];
        this.updateAudioReplacementsCount();
      }
    } catch (error) {
      this.hideProgress();
      console.error('[VideoEditor] Export error:', error);
      if (window.api && window.api.log) {
        window.api.log.error('Video editor export failed', {
          error: error.message,
          operation: 'export',
        });
      }
      this.showToast('error', 'Export failed: ' + error.message);
    }
  },

  // Clear all pending audio replacements
  clearAudioReplacements() {
    if (!this.audioReplacements || this.audioReplacements.length === 0) {
      this.showToast('info', 'No replacements to clear');
      return;
    }

    const confirmed = confirm(`Clear ${this.audioReplacements.length} audio replacement(s)?`);
    if (!confirmed) return;

    // Remove from voice track
    const voiceTrack = this.audioTracks.find((t) => t.type === 'voice');
    if (voiceTrack) {
      voiceTrack.clips = voiceTrack.clips.filter((c) => c.type !== 'elevenlabs');
      this.renderTrackClips(voiceTrack.id);
    }

    this.audioReplacements = [];
    this.showToast('success', 'Cleared all audio replacements');
    this.saveProject();
    this.updateAudioReplacementsCount();
  },

  async replaceAudioWithElevenLabs(markerId) {
    const marker = this.markers.find((m) => m.id === markerId);
    if (!marker) {
      this.showToast('error', 'Marker not found');
      return;
    }

    if (!this.videoPath) {
      this.showToast('error', 'No video loaded');
      return;
    }

    // Check if ElevenLabs API key is configured
    const keyCheck = await window.videoEditor.checkElevenLabsApiKey();
    if (!keyCheck.hasKey) {
      this.showElevenLabsKeyMissingAlert();
      return;
    }

    if (!marker.transcription || marker.transcription.trim() === '') {
      this.showToast('error', 'No transcription found. Please transcribe this range first.');
      return;
    }

    if (marker.type !== 'range') {
      this.showToast('error', 'Only range markers can have audio replaced');
      return;
    }

    // Check budget before proceeding
    const shouldProceed = await this.confirmAICost(
      'elevenlabs',
      { text: marker.transcription, characters: marker.transcription.length },
      `Generate AI Voice for "${marker.name}"`
    );
    if (!shouldProceed) {
      return;
    }

    try {
      this.showToast('info', 'Generating AI voice...', 3000);
      this.showProgress('AI Voice Generation', 'Calling ElevenLabs API...');

      // Generate audio only (non-destructive) - no video re-encoding!
      const result = await window.videoEditor.generateElevenLabsAudio({
        text: marker.transcription,
        voice: 'Rachel',
      });

      this.hideProgress();

      if (result.error) {
        throw new Error(result.error);
      }

      // Add to voice overlay track (non-destructive!)
      await this.addAudioOverlay({
        name: marker.name,
        path: result.audioPath,
        startTime: marker.inTime,
        endTime: marker.outTime,
        text: marker.transcription,
        type: 'elevenlabs',
        markerId: marker.id,
      });

      // Update marker metadata
      marker.elevenLabsAudio = true;
      marker.elevenLabsGeneratedAt = new Date().toISOString();
      marker.hasOverlay = true;
      marker.modifiedAt = new Date().toISOString();
      this.renderMarkers();

      const replacementCount = this.getAudioReplacements().length;
      this.showToast('success', `Voice overlay added! (${replacementCount} total) - Export when ready.`);
    } catch (error) {
      this.hideProgress();
      console.error('[VideoEditor] ElevenLabs error:', error);
      if (window.api && window.api.log) {
        window.api.log.error('Video editor ElevenLabs overlay failed', {
          error: error.message,
          operation: 'elevenLabsOverlay',
        });
      }
      this.showToast('error', 'Failed to generate audio: ' + error.message);
    }
  },

  async transcribeMarkerById(markerId) {
    const marker = this.markers.find((m) => m.id === markerId);
    if (!marker) return;

    if (!this.videoPath) {
      this.showToast('error', 'No video loaded');
      return;
    }

    let startTime, endTime;

    if (marker.type === 'range') {
      startTime = marker.inTime;
      endTime = marker.outTime;
    } else {
      // For spot markers, transcribe 10 seconds around the marker
      startTime = Math.max(0, marker.time - 5);
      const video = document.getElementById('videoPlayer');
      endTime = Math.min(video.duration, marker.time + 5);
    }

    const duration = endTime - startTime;

    this.showProgress('Transcribing...', `Processing ${this.formatTime(duration)} of audio`);

    try {
      const result = await window.videoEditor.transcribeRange(this.videoPath, {
        startTime,
        endTime,
        language: 'en',
      });

      this.hideProgress();

      if (!result.success) {
        throw new Error(result.error);
      }

      // Update the marker with transcription
      marker.transcription = result.transcription;
      marker.modifiedAt = new Date().toISOString();

      // Re-render
      this.renderMarkers();

      this.showToast('success', 'Transcription saved to marker!');
    } catch (error) {
      this.hideProgress();
      console.error('[Transcription] Error:', error);
      this.showToast('error', 'Transcription failed: ' + error.message);
    }
  },

  addMarkerAtPlayhead() {
    if (!this.videoPath) return;
    const video = document.getElementById('videoPlayer');
    this.showMarkerModal(video.currentTime);
  },

  // Auto-generate reel markers every 10 minutes
  // Creates range markers named "Reel 1", "Reel 2", etc.
  generateReelMarkers(duration) {
    const REEL_DURATION = 600; // 10 minutes in seconds
    const numReels = Math.ceil(duration / REEL_DURATION);

    // Don't create reels for very short videos
    if (numReels < 1) return;

    console.log(`[VideoEditor] Auto-generating ${numReels} reel marker(s) for ${this.formatTime(duration)} video`);

    // Reel colors - alternating for visual distinction
    const reelColors = ['#3b82f6', '#8b5cf6', '#06b6d4', '#22c55e', '#f97316', '#ec4899'];

    const newMarkerIds = [];

    for (let i = 0; i < numReels; i++) {
      const inTime = i * REEL_DURATION;
      const outTime = Math.min((i + 1) * REEL_DURATION, duration);

      // Skip if reel would be very short (less than 30 seconds)
      if (outTime - inTime < 30) continue;

      const marker = {
        id: this.nextMarkerId++,
        name: `Reel ${i + 1}`,
        type: 'range',
        inTime: inTime,
        outTime: outTime,
        duration: outTime - inTime,
        color: reelColors[i % reelColors.length],
        description: 'Generating description...',
        transcription: '',
        tags: ['reel', 'auto-generated'],
        notes: '',
        thumbnails: [],
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
      };

      this.markers.push(marker);
      newMarkerIds.push(marker.id);
    }

    // Render the markers immediately
    this.renderMarkers();
    this.renderScenesList();

    if (numReels > 0) {
      this.showToast('info', `Created ${numReels} reel marker${numReels > 1 ? 's' : ''} - generating descriptions...`);

      // Generate descriptions and thumbnails asynchronously
      this.enrichReelMarkers(newMarkerIds);
    }
  },

  // Enrich reel markers with descriptions from transcript and thumbnails
  async enrichReelMarkers(markerIds) {
    const videoName = this.videoPath ? this.videoPath.split('/').pop() : 'Video';
    let enrichedCount = 0;

    for (const markerId of markerIds) {
      const marker = this.markers.find((m) => m.id === markerId);
      if (!marker) continue;

      try {
        // Get transcript text for this time range
        const transcriptText = this.getTranscriptForRange(marker.inTime, marker.outTime);

        if (transcriptText && transcriptText.length > 20) {
          // Store the transcription
          marker.transcription = transcriptText;

          // Generate description using LLM
          const timeContext = `Time: ${this.formatTime(marker.inTime)} - ${this.formatTime(marker.outTime)}`;
          const result = await window.videoEditor.generateSceneDescription({
            transcript: transcriptText,
            timeContext: timeContext,
            videoName: videoName,
            existingDescription: '',
          });

          if (result.success && result.description) {
            marker.description = result.description;
            enrichedCount++;
            console.log(
              `[VideoEditor] Generated description for ${marker.name}:`,
              result.description.substring(0, 50) + '...'
            );
          } else {
            marker.description = `${marker.name}: ${this.formatTime(marker.inTime)} - ${this.formatTime(marker.outTime)}`;
          }
        } else {
          marker.description = `${marker.name}: ${this.formatTime(marker.inTime)} - ${this.formatTime(marker.outTime)}`;
        }

        // Generate thumbnails for this marker (3 frames: start, middle, end)
        try {
          const thumbTimes = [marker.inTime + 2, marker.inTime + marker.duration / 2, marker.outTime - 2];

          const thumbnails = [];
          for (const time of thumbTimes) {
            if (time >= marker.inTime && time <= marker.outTime) {
              const thumb = await window.videoEditor.generateThumbnail(this.videoPath, time);
              if (thumb && !thumb.error) {
                thumbnails.push(thumb);
              }
            }
          }
          marker.thumbnails = thumbnails;
        } catch (thumbErr) {
          console.warn(`[VideoEditor] Could not generate thumbnails for ${marker.name}:`, thumbErr.message);
        }

        marker.modifiedAt = new Date().toISOString();
      } catch (error) {
        console.warn(`[VideoEditor] Could not enrich marker ${marker.name}:`, error.message);
        marker.description = `${marker.name}: ${this.formatTime(marker.inTime)} - ${this.formatTime(marker.outTime)}`;
      }

      // Update UI after each marker
      this.renderScenesList();
    }

    if (enrichedCount > 0) {
      this.showToast('success', `Generated descriptions for ${enrichedCount} reel${enrichedCount > 1 ? 's' : ''}`);

      // Auto-save if this is a Space video
      if (this.spaceItemId) {
        this.saveMarkersToSpace();
      }
    }
  },

  // Get transcript text for a specific time range
  getTranscriptForRange(startTime, endTime) {
    if (!this.transcriptSegments || this.transcriptSegments.length === 0) {
      return '';
    }

    const words = [];
    for (const segment of this.transcriptSegments) {
      const segStart = segment.start || 0;
      const segEnd = segment.end || segStart + 1;

      // Check if segment overlaps with the range
      if (segEnd >= startTime && segStart <= endTime) {
        words.push(segment.text || segment.word || '');
      }
    }

    return words.join(' ').trim();
  },

  // Mark Range IN - first point of a range marker
  markRangeIn() {
    if (!this.videoPath) return;
    const video = document.getElementById('videoPlayer');
    const time = video.currentTime;

    this.pendingRangeMarker = {
      inTime: time,
      color: this.markerColors[Math.floor(Math.random() * this.markerColors.length)],
    };

    // Show indicator
    document.getElementById('pendingInTime').textContent = this.formatTime(time);
    document.getElementById('pendingRangeIndicator').classList.remove('hidden');

    this.showToast('info', `Range IN set at ${this.formatTime(time)} - now set OUT point`);
  },

  // Mark Range OUT - complete the range marker
  markRangeOut() {
    if (!this.videoPath) return;
    const video = document.getElementById('videoPlayer');
    const outTime = video.currentTime;

    if (!this.pendingRangeMarker) {
      // No IN point set, start a new range
      this.markRangeIn();
      return;
    }

    const inTime = this.pendingRangeMarker.inTime;

    if (outTime <= inTime) {
      this.showToast('error', 'OUT point must be after IN point');
      return;
    }

    // Show modal to name the range
    this.rangeInTime = inTime;
    this.rangeOutTime = outTime;
    this.selectedMarkerColor = this.pendingRangeMarker.color;
    this.selectedMarkerType = 'range';

    this.showMarkerModal(inTime, null, 'range');

    // Hide indicator
    document.getElementById('pendingRangeIndicator').classList.add('hidden');
    this.pendingRangeMarker = null;
  },

  cancelPendingRange() {
    this.pendingRangeMarker = null;
    document.getElementById('pendingRangeIndicator').classList.add('hidden');
    this.showToast('info', 'Range marker cancelled');
  },

  setMarkerType(type) {
    this.selectedMarkerType = type;

    // Update UI
    document.querySelectorAll('.marker-type-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.type === type);
    });

    // Show/hide time inputs
    document.getElementById('spotTimeGroup').classList.toggle('hidden', type === 'range');
    document.getElementById('rangeTimeGroup').classList.toggle('hidden', type === 'spot');

    // Show/hide ADR actions section (only for range markers)
    const adrSection = document.getElementById('adrActionsSection');
    if (adrSection) {
      adrSection.classList.toggle('hidden', type === 'spot');
    }

    // Update ElevenLabs button visibility (only shows for range markers with transcription)
    this.updateElevenLabsButton();
  },

  setRangeInNow() {
    const video = document.getElementById('videoPlayer');
    this.rangeInTime = video.currentTime;
    document.getElementById('rangeInDisplay').textContent = this.formatTime(this.rangeInTime);
    this.updateRangeDuration();
  },

  setRangeOutNow() {
    const video = document.getElementById('videoPlayer');
    this.rangeOutTime = video.currentTime;
    document.getElementById('rangeOutDisplay').textContent = this.formatTime(this.rangeOutTime);
    this.updateRangeDuration();
  },

  updateRangeDuration() {
    const duration = Math.max(0, this.rangeOutTime - this.rangeInTime);
    document.getElementById('rangeDuration').textContent = `Duration: ${this.formatTime(duration)}`;
  },

  showMarkerModal(time, editMarker = null, forceType = null) {
    this.editingMarkerId = editMarker?.id || null;
    this.selectedMarkerColor = editMarker?.color || this.markerColors[0];
    this.selectedMarkerType = forceType || editMarker?.type || 'spot';

    // Set range times
    if (editMarker?.type === 'range') {
      this.rangeInTime = editMarker.inTime;
      this.rangeOutTime = editMarker.outTime;
    } else if (this.selectedMarkerType === 'range') {
      // Keep the values set by markRangeOut
    } else {
      this.rangeInTime = time;
      this.rangeOutTime = time + 5; // Default 5 second range
    }

    // Update modal
    document.getElementById('markerModalTitle').textContent = editMarker ? 'Edit Marker' : 'Add Marker';
    document.getElementById('markerNameInput').value = editMarker?.name || '';
    document.getElementById('markerTimeDisplay').textContent = this.formatTime(time);
    document.getElementById('saveMarkerBtn').textContent = editMarker ? 'Save Changes' : 'Add Marker';

    // Update range displays
    document.getElementById('rangeInDisplay').textContent = this.formatTime(this.rangeInTime);
    document.getElementById('rangeOutDisplay').textContent = this.formatTime(this.rangeOutTime);
    this.updateRangeDuration();

    // Store time for save
    document.getElementById('markerModal').dataset.time = time;

    // Set marker type
    this.setMarkerType(this.selectedMarkerType);

    // Hide type selector when editing (can't change type)
    document.getElementById('markerTypeGroup').style.display = editMarker ? 'none' : 'block';

    // Populate metadata fields
    document.getElementById('markerDescription').value = editMarker?.description || '';
    document.getElementById('markerTranscription').value = editMarker?.transcription || '';
    document.getElementById('markerTags').value = editMarker?.tags?.join(', ') || '';
    document.getElementById('markerNotes').value = editMarker?.notes || '';

    // Show/hide ElevenLabs button based on transcription and marker type
    this.updateElevenLabsButton();

    // Show created/modified dates
    if (editMarker?.createdAt) {
      document.getElementById('markerCreated').textContent = new Date(editMarker.createdAt).toLocaleString();
    } else {
      document.getElementById('markerCreated').textContent = 'Now';
    }
    if (editMarker?.modifiedAt) {
      document.getElementById('markerModified').textContent = new Date(editMarker.modifiedAt).toLocaleString();
    } else {
      document.getElementById('markerModified').textContent = '-';
    }

    // Build color picker
    const colorPicker = document.getElementById('markerColorPicker');
    colorPicker.innerHTML = this.markerColors
      .map(
        (color) => `
          <div class="marker-color-option ${color === this.selectedMarkerColor ? 'selected' : ''}" 
               style="background: ${color};" 
               data-color="${color}"
               onclick="app.selectMarkerColor('${color}')"></div>
        `
      )
      .join('');

    // Show modal
    document.getElementById('markerModalBackdrop').classList.remove('hidden');
    document.getElementById('markerModal').classList.remove('hidden');

    // Focus input
    setTimeout(() => document.getElementById('markerNameInput').focus(), 100);
  },

  closeMarkerModal() {
    document.getElementById('markerModalBackdrop').classList.add('hidden');
    document.getElementById('markerModal').classList.add('hidden');
    this.editingMarkerId = null;
  },

  selectMarkerColor(color) {
    this.selectedMarkerColor = color;
    document.querySelectorAll('.marker-color-option').forEach((el) => {
      el.classList.toggle('selected', el.dataset.color === color);
    });
  },

  saveMarker() {
    const modal = document.getElementById('markerModal');
    const name = document.getElementById('markerNameInput').value.trim() || `Scene ${this.markers.length + 1}`;
    const color = this.selectedMarkerColor;
    const type = this.selectedMarkerType;

    // Get metadata
    const description = document.getElementById('markerDescription').value.trim();
    const transcription = document.getElementById('markerTranscription').value.trim();
    const tagsInput = document.getElementById('markerTags').value.trim();
    const tags = tagsInput
      ? tagsInput
          .split(',')
          .map((t) => t.trim())
          .filter((t) => t)
      : [];
    const notes = document.getElementById('markerNotes').value.trim();
    const now = new Date().toISOString();

    // Push undo state BEFORE making changes
    this.pushUndoState(this.editingMarkerId ? `Edit marker "${name}"` : `Add marker "${name}"`);

    if (this.editingMarkerId) {
      // Edit existing marker
      const marker = this.markers.find((m) => m.id === this.editingMarkerId);
      if (marker) {
        marker.name = name;
        marker.color = color;
        marker.description = description;
        marker.transcription = transcription;
        marker.tags = tags;
        marker.notes = notes;
        marker.modifiedAt = now;
        if (marker.type === 'range') {
          marker.inTime = this.rangeInTime;
          marker.outTime = this.rangeOutTime;
          marker.duration = this.rangeOutTime - this.rangeInTime;
        }
      }
    } else {
      // Add new marker
      const baseMarker = {
        id: this.nextMarkerId++,
        name: name,
        color: color,
        description: description,
        transcription: transcription,
        tags: tags,
        notes: notes,
        createdAt: now,
        modifiedAt: now,
      };

      if (type === 'spot') {
        const time = parseFloat(modal.dataset.time);
        this.markers.push({
          ...baseMarker,
          type: 'spot',
          time: time,
        });
      } else {
        // Range marker
        if (this.rangeOutTime <= this.rangeInTime) {
          this.showToast('error', 'OUT point must be after IN point');
          return;
        }
        this.markers.push({
          ...baseMarker,
          type: 'range',
          inTime: this.rangeInTime,
          outTime: this.rangeOutTime,
          duration: this.rangeOutTime - this.rangeInTime,
        });
      }

      // Sort markers by time (use inTime for ranges)
      this.markers.sort((a, b) => {
        const timeA = a.type === 'range' ? a.inTime : a.time;
        const timeB = b.type === 'range' ? b.inTime : b.time;
        return timeA - timeB;
      });
    }

    this.closeMarkerModal();
    this.renderMarkers();
    this.renderScenesList();

    // Refresh teleprompter to show marker indicators
    if (this.teleprompterVisible && this.teleprompterWords.length > 0) {
      this.renderTeleprompterWords();
    }

    this.showToast('success', this.editingMarkerId ? 'Marker updated' : 'Marker added');
  },

  deleteMarker(id) {
    const marker = this.markers.find((m) => m.id === id);
    const markerName = marker?.name || 'marker';

    // Push undo state BEFORE deleting
    this.pushUndoState(`Delete marker "${markerName}"`);

    this.markers = this.markers.filter((m) => m.id !== id);
    this.renderMarkers();
    this.renderScenesList();

    // Refresh teleprompter to remove marker indicators
    if (this.teleprompterVisible && this.teleprompterWords.length > 0) {
      this.renderTeleprompterWords();
    }

    this.showToast('success', 'Marker deleted');
  },

  clearAllMarkers() {
    if (this.markers.length === 0) return;
    if (confirm('Delete all markers?')) {
      // Push undo state BEFORE clearing
      this.pushUndoState(`Clear all markers (${this.markers.length})`);

      this.markers = [];
      this.renderMarkers();
      this.renderScenesList();

      // Refresh teleprompter to remove marker indicators
      if (this.teleprompterVisible && this.teleprompterWords.length > 0) {
        this.renderTeleprompterWords();
      }

      this.showToast('success', 'All markers cleared');
    }
  },

  // ==================== ADR WORKFLOW ====================

  /**
   * Insert Silence - Mark dead space region for ADR workflow
   * Called from the range marker modal
   */
  insertSilence() {
    if (!this.adrManager) {
      console.error('[App] ADR Manager not initialized');
      this.showToast('error', 'ADR system not available');
      return;
    }

    // Validate range times
    if (!this.rangeInTime || !this.rangeOutTime) {
      this.showToast('error', 'Please set IN and OUT points');
      return;
    }

    if (this.rangeOutTime <= this.rangeInTime) {
      this.showToast('error', 'OUT point must be after IN point');
      return;
    }

    // Get the marker name for labeling the silence region
    const name = document.getElementById('markerNameInput').value.trim() || 'Silence';

    // Call ADR Manager to insert silence
    const region = this.adrManager.insertSilence(this.rangeInTime, this.rangeOutTime, name);

    if (region) {
      // Also save the marker itself (optional - for reference)
      const transcription = document.getElementById('markerTranscription').value.trim();
      if (transcription) {
        // Store original transcription for reference
        region.originalTranscription = transcription;
      }

      // Close modal after inserting silence
      this.closeMarkerModal();
    }
  },

  /**
   * Re-record with AI - Full ADR workflow
   * Inserts silence + generates ElevenLabs audio + adds to ADR track
   */
  async rerecordWithAI() {
    if (!this.adrManager) {
      console.error('[App] ADR Manager not initialized');
      this.showToast('error', 'ADR system not available');
      return;
    }

    // Validate range times
    if (!this.rangeInTime || !this.rangeOutTime) {
      this.showToast('error', 'Please set IN and OUT points');
      return;
    }

    if (this.rangeOutTime <= this.rangeInTime) {
      this.showToast('error', 'OUT point must be after IN point');
      return;
    }

    // Get transcription text
    const transcription = document.getElementById('markerTranscription').value.trim();
    if (!transcription) {
      this.showToast('error', 'Please enter transcription text');
      return;
    }

    // Get marker name
    const name = document.getElementById('markerNameInput').value.trim() || 'ADR Clip';

    // Get selected voice from dropdown
    const voiceSelect = document.getElementById('elevenLabsVoiceSelect');
    const voice = voiceSelect ? voiceSelect.value : 'Rachel';

    console.log('[App] Re-recording with AI:', {
      name,
      voice,
      duration: this.formatTime(this.rangeOutTime - this.rangeInTime),
      textLength: transcription.length,
    });

    // Call ADR Manager to perform full workflow
    const clip = await this.adrManager.rerecordWithAI(this.rangeInTime, this.rangeOutTime, transcription, name, voice);

    if (clip) {
      // Close modal after successful re-record
      this.closeMarkerModal();
    }
  },

  renderMarkers() {
    // Render markers on timeline track
    const track = document.getElementById('markersTrack');
    const video = document.getElementById('videoPlayer');

    if (!track || !video || !video.duration) {
      if (track) track.innerHTML = '';
      return;
    }

    const zoom = this.timelineZoom;
    track.style.width = `calc((100% - 108px) * ${zoom})`;

    track.innerHTML = this.markers
      .map((marker) => {
        if (marker.type === 'range') {
          // Range marker - show as a region
          const startPercent = (marker.inTime / video.duration) * 100;
          const endPercent = (marker.outTime / video.duration) * 100;
          const width = endPercent - startPercent;
          const duration = marker.outTime - marker.inTime;
          return `
              <div class="marker-range" style="left: ${startPercent}%; width: ${width}%; background: ${marker.color};" 
                   data-id="${marker.id}"
                   onmousedown="app.startDragRangeMove(event, ${marker.id})"
                   onclick="event.stopPropagation(); app.goToMarker(${marker.id})"
                   oncontextmenu="event.preventDefault(); event.stopPropagation(); app.showMarkerContextMenu(event, ${marker.id})">
                <div class="marker-range-handle left" onmousedown="event.stopPropagation(); app.startDragRangeIn(event, ${marker.id})"></div>
                <div class="marker-range-label">${marker.name} (${this.formatTime(duration)})</div>
                <div class="marker-range-handle right" onmousedown="event.stopPropagation(); app.startDragRangeOut(event, ${marker.id})"></div>
              </div>
              <div class="marker" style="left: ${startPercent}%; background: ${marker.color}; cursor: ew-resize;" 
                   data-id="${marker.id}-in"
                   onmousedown="app.startDragRangeIn(event, ${marker.id})">
                <div class="marker-flag" style="background: ${marker.color};">▶</div>
                <div class="marker-label">IN: ${marker.name} (${this.formatTime(marker.inTime)})</div>
              </div>
              <div class="marker" style="left: ${endPercent}%; background: ${marker.color}; cursor: ew-resize;" 
                   data-id="${marker.id}-out"
                   onmousedown="app.startDragRangeOut(event, ${marker.id})">
                <div class="marker-flag" style="background: ${marker.color};">◀</div>
                <div class="marker-label">OUT: ${marker.name} (${this.formatTime(marker.outTime)})</div>
              </div>
            `;
        } else {
          // Spot marker - single point
          const percent = (marker.time / video.duration) * 100;
          return `
              <div class="marker" style="left: ${percent}%; background: ${marker.color}; cursor: ew-resize;" 
                   data-id="${marker.id}"
                   onmousedown="app.startDragSpot(event, ${marker.id})"
                   onclick="event.stopPropagation(); app.goToMarker(${marker.id})"
                   oncontextmenu="event.preventDefault(); event.stopPropagation(); app.showMarkerContextMenu(event, ${marker.id})">
                <div class="marker-flag" style="background: ${marker.color};">●</div>
                <div class="marker-label">${marker.name} (${this.formatTime(marker.time)})</div>
              </div>
            `;
        }
      })
      .join('');

    // Render markers list in sidebar
    const list = document.getElementById('markersList');
    const count = document.getElementById('markersCount');
    count.textContent = this.markers.length;

    if (this.markers.length === 0) {
      list.innerHTML = '<div class="markers-empty">No markers yet.<br>Click "Add Marker" or press <kbd>N</kbd></div>';
      return;
    }

    list.innerHTML = this.markers
      .map((marker, index) => {
        const hasMetadata = marker.description || marker.transcription || (marker.tags && marker.tags.length > 0);
        const metaIcon = hasMetadata ? '📝' : '';

        if (marker.type === 'range') {
          const duration = marker.outTime - marker.inTime;
          return `
              <div class="marker-item" data-id="${marker.id}" onclick="app.showMarkerDetails(${marker.id})">
                <div class="marker-color-dot" style="background: ${marker.color}; border-radius: 2px; width: 16px;"></div>
                <div class="marker-item-info">
                  <div class="marker-item-name">${index + 1}. ${marker.name} <span style="opacity: 0.5">↔️</span> ${metaIcon}</div>
                  <div class="marker-item-time">${this.formatTime(marker.inTime)} → ${this.formatTime(marker.outTime)} (${this.formatTime(duration)})</div>
                </div>
                <div class="marker-item-actions">
                  <button class="marker-action-btn" onclick="event.stopPropagation(); app.goToMarker(${marker.id})" title="Go to IN">▶</button>
                  <button class="marker-action-btn" onclick="event.stopPropagation(); app.goToMarkerEnd(${marker.id})" title="Go to OUT">⏭</button>
                  <button class="marker-action-btn" onclick="event.stopPropagation(); app.editMarker(${marker.id})" title="Edit">✏️</button>
                  <button class="marker-action-btn delete" onclick="event.stopPropagation(); app.deleteMarker(${marker.id})" title="Delete">🗑️</button>
                </div>
              </div>
            `;
        } else {
          return `
              <div class="marker-item" data-id="${marker.id}" onclick="app.showMarkerDetails(${marker.id})">
                <div class="marker-color-dot" style="background: ${marker.color};"></div>
                <div class="marker-item-info">
                  <div class="marker-item-name">${index + 1}. ${marker.name} <span style="opacity: 0.5">📍</span> ${metaIcon}</div>
                  <div class="marker-item-time">${this.formatTime(marker.time)}</div>
                </div>
                <div class="marker-item-actions">
                  <button class="marker-action-btn" onclick="event.stopPropagation(); app.goToMarker(${marker.id})" title="Go to marker">▶</button>
                  <button class="marker-action-btn" onclick="event.stopPropagation(); app.editMarker(${marker.id})" title="Edit">✏️</button>
                  <button class="marker-action-btn delete" onclick="event.stopPropagation(); app.deleteMarker(${marker.id})" title="Delete">🗑️</button>
                </div>
              </div>
            `;
        }
      })
      .join('');

    // Update details panel if visible
    if (this.selectedMarkerForDetails) {
      this.showMarkerDetails(this.selectedMarkerForDetails);
    }

    // Update scenes list if on scenes tab
    if (this.currentTab === 'scenes') {
      this.renderScenesList();
    }

    // Render marker range overlays on all tracks
    this.renderMarkerRangeOverlays();
  },

  // Update markers panel (called after loading scenes from space)
  updateMarkersPanel() {
    // This is handled by renderMarkers() which updates the markers panel
    // This function exists for compatibility with loadScenesFromSpace
  },

  // Render marker range overlays on all timeline tracks
  renderMarkerRangeOverlays() {
    const video = document.getElementById('videoPlayer');
    const markersTrack = document.getElementById('markersTrack');

    if (!video || !video.duration || !markersTrack) {
      return;
    }

    // Get only range markers
    const rangeMarkers = this.markers.filter((m) => m.type === 'range');

    // Clear overlays if no range markers
    const clearOverlays = () => {
      ['videoTrackOverlays', 'audioTrackOverlays'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
      });
      const timelineContent = document.getElementById('timelineContent');
      if (timelineContent) {
        timelineContent.querySelectorAll('.marker-range-overlay-container').forEach((c) => (c.innerHTML = ''));
      }
    };

    if (rangeMarkers.length === 0) {
      clearOverlays();
      return;
    }

    // Get the markers track rect to calculate aligned positions
    const markersTrackRect = markersTrack.getBoundingClientRect();

    // Generate overlay HTML with pixel positions aligned to markers track
    const generateOverlayHtml = (markers, duration, containerRect) => {
      // Calculate the horizontal offset between markers track and this container
      const offsetX = markersTrackRect.left - containerRect.left;

      return markers
        .map((marker) => {
          // Calculate position on markers track (where the marker visually appears)
          const startOnMarkersTrack = (marker.inTime / duration) * markersTrackRect.width;
          const endOnMarkersTrack = (marker.outTime / duration) * markersTrackRect.width;
          const widthPx = endOnMarkersTrack - startOnMarkersTrack;

          // Adjust start position by the offset to align with markers track
          const startPx = startOnMarkersTrack + offsetX;

          return `
              <div class="marker-range-overlay" 
                   style="left: ${startPx}px; width: ${widthPx}px; background: ${marker.color};"
                   data-marker-id="${marker.id}"
                   onclick="app.goToMarker(${marker.id})"
                   title="${marker.name} (${this.formatTime(marker.inTime)} - ${this.formatTime(marker.outTime)})">
              </div>
            `;
        })
        .join('');
    };

    // Video track overlays
    const videoOverlays = document.getElementById('videoTrackOverlays');
    const videoClip = document.getElementById('videoClip');
    if (videoOverlays && videoClip) {
      const clipRect = videoClip.getBoundingClientRect();
      videoOverlays.innerHTML = generateOverlayHtml(rangeMarkers, video.duration, clipRect);
    }

    // Audio track overlays (original A1)
    const audioOverlays = document.getElementById('audioTrackOverlays');
    const audioClip = document.querySelector('#audioTrack .timeline-clip');
    if (audioOverlays && audioClip) {
      const clipRect = audioClip.getBoundingClientRect();
      audioOverlays.innerHTML = generateOverlayHtml(rangeMarkers, video.duration, clipRect);
    }

    // Dynamic audio tracks
    const timelineContent = document.getElementById('timelineContent');
    if (timelineContent) {
      const dynamicOverlayContainers = timelineContent.querySelectorAll(
        '.marker-range-overlay-container:not(#videoTrackOverlays):not(#audioTrackOverlays)'
      );
      dynamicOverlayContainers.forEach((container) => {
        const parentClip = container.closest('.timeline-clip') || container.closest('.timeline-track');
        if (parentClip) {
          const clipRect = parentClip.getBoundingClientRect();
          container.innerHTML = generateOverlayHtml(rangeMarkers, video.duration, clipRect);
        }
      });
    }
  },

  showMarkerDetails(markerId) {
    const marker = this.markers.find((m) => m.id === markerId);
    if (!marker) return;

    this.selectedMarkerForDetails = markerId;

    // Highlight in list
    document.querySelectorAll('.marker-item').forEach((el) => el.classList.remove('active'));
    const listItem = document.querySelector(`.marker-item[data-id="${markerId}"]`);
    if (listItem) listItem.classList.add('active');

    // Get or create details panel
    let panel = document.getElementById('markerDetailsPanel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'markerDetailsPanel';
      panel.className = 'marker-details-panel';
      document.getElementById('markersPanel').appendChild(panel);
    }

    // Build timecode display
    let timecodeHtml;
    if (marker.type === 'range') {
      const duration = marker.outTime - marker.inTime;
      timecodeHtml = `
            <div class="marker-timecode-display">
              <span class="tc-in">IN: ${this.formatTime(marker.inTime)}</span>
              <span>→</span>
              <span class="tc-out">OUT: ${this.formatTime(marker.outTime)}</span>
              <span class="tc-duration">${this.formatTime(duration)}</span>
            </div>
          `;
    } else {
      timecodeHtml = `
            <div class="marker-timecode-display">
              <span class="tc-in">Time: ${this.formatTime(marker.time)}</span>
            </div>
          `;
    }

    // Build tags display
    const tagsHtml =
      marker.tags && marker.tags.length > 0
        ? `<div class="marker-tags">${marker.tags.map((t) => `<span class="marker-tag">${t}</span>`).join('')}</div>`
        : '<span style="color: var(--text-muted); font-style: italic;">No tags</span>';

    panel.innerHTML = `
          <div class="marker-details-header">
            <div class="marker-details-title">
              <div class="marker-color-dot" style="background: ${marker.color};"></div>
              ${marker.name}
            </div>
            <button class="marker-details-close" onclick="app.closeMarkerDetails()">✕</button>
          </div>
          <div class="marker-details-content">
            <div class="marker-detail-row">
              <div class="marker-detail-label">Timecode</div>
              ${timecodeHtml}
            </div>
            
            ${
              marker.description
                ? `
              <div class="marker-detail-row">
                <div class="marker-detail-label">Description</div>
                <div class="marker-detail-value">${marker.description}</div>
              </div>
            `
                : ''
            }
            
            ${
              marker.transcription
                ? `
              <div class="marker-detail-row">
                <div class="marker-detail-label">Transcription</div>
                <div class="marker-detail-value transcription">"${marker.transcription}"</div>
              </div>
            `
                : ''
            }
            
            <div class="marker-detail-row">
              <div class="marker-detail-label">Tags</div>
              <div class="marker-detail-value">${tagsHtml}</div>
            </div>
            
            ${
              marker.notes
                ? `
              <div class="marker-detail-row">
                <div class="marker-detail-label">Notes</div>
                <div class="marker-detail-value" style="color: var(--text-muted); font-style: italic;">${marker.notes}</div>
              </div>
            `
                : ''
            }
            
            <div class="marker-detail-row" style="display: flex; gap: 16px; margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border-color);">
              <div>
                <div class="marker-detail-label">Created</div>
                <div class="marker-detail-value mono">${marker.createdAt ? new Date(marker.createdAt).toLocaleDateString() : '-'}</div>
              </div>
              <div>
                <div class="marker-detail-label">Modified</div>
                <div class="marker-detail-value mono">${marker.modifiedAt ? new Date(marker.modifiedAt).toLocaleDateString() : '-'}</div>
              </div>
            </div>
            
            <div style="display: flex; gap: 8px; margin-top: 12px;">
              <button class="btn btn-secondary" style="flex: 1;" onclick="app.goToMarker(${marker.id})">▶ Go to</button>
              <button class="btn btn-ghost" style="flex: 1;" onclick="app.editMarker(${marker.id})">✏️ Edit</button>
            </div>
            ${
              marker.type === 'range'
                ? `
              <div style="display: flex; gap: 8px; margin-top: 8px;">
                <button class="btn btn-ghost" style="flex: 1;" onclick="app.transcribeMarkerById(${marker.id})">
                  🎤 Transcribe
                </button>
                <button class="btn btn-ghost" style="flex: 1;" onclick="app.generateScreengrabsForMarker(${marker.id})">
                  📸 Screen Grabs
                </button>
              </div>
              ${
                marker.transcription
                  ? `
              <div style="margin-top: 8px;">
                <button class="btn btn-primary" style="width: 100%;" onclick="app.replaceAudioWithElevenLabs(${marker.id})">
                  🎙️ Replace Audio with ElevenLabs
                </button>
              </div>
              `
                  : ''
              }
            `
                : ''
            }
          </div>
        `;

    panel.style.display = 'block';
  },

  closeMarkerDetails() {
    this.selectedMarkerForDetails = null;
    const panel = document.getElementById('markerDetailsPanel');
    if (panel) panel.style.display = 'none';
    document.querySelectorAll('.marker-item').forEach((el) => el.classList.remove('active'));
  },

  // Scenes Tab Functions
  sceneThumbnails: {}, // Cache of scene thumbnails by marker id

  renderScenesList() {
    const list = document.getElementById('scenesList');
    const count = document.getElementById('scenesCount');
    if (!list) return;

    count.textContent = this.markers.length;

    if (this.markers.length === 0) {
      list.innerHTML = `
            <div class="scenes-empty">
              <div class="scenes-empty-icon"><svg viewBox="0 0 24 24" width="40" height="40" stroke="currentColor" fill="none" stroke-width="1"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg></div>
              <div class="scenes-empty-text">No annotations yet</div>
              <div class="scenes-empty-hint">Add markers to create scenes</div>
              <button class="btn btn-secondary" style="margin-top: 12px;" onclick="app.addMarkerAtPlayhead()" ${!this.videoPath ? 'disabled' : ''}>
                + Add First Scene
              </button>
            </div>
          `;
      return;
    }

    list.innerHTML = this.markers
      .map((marker, index) => {
        const thumbnailSrc = this.sceneThumbnails[marker.id];
        const thumbnailHtml = thumbnailSrc
          ? `<img src="${pathToFileUrl(thumbnailSrc)}" alt="${marker.name}">`
          : `<span class="scene-thumbnail-placeholder"><svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" fill="none" stroke-width="1.5"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/></svg></span>`;

        const typeIcon = marker.type === 'range' ? '↔️' : '📍';

        let timeHtml;
        if (marker.type === 'range') {
          const duration = marker.outTime - marker.inTime;
          timeHtml = `${this.formatTime(marker.inTime)} → ${this.formatTime(marker.outTime)} <span class="duration">(${this.formatTime(duration)})</span>`;
        } else {
          timeHtml = this.formatTime(marker.time);
        }

        // Meta icons
        const hasDescription = marker.description ? '📝' : '';
        const hasTranscription = marker.transcription ? '🎤' : '';
        const hasTags = marker.tags?.length > 0 ? '🏷️' : '';
        const hasScreengrabs = marker.screengrabs?.length > 0 ? '📸' : '';

        return `
            <div class="scene-card" data-id="${marker.id}" 
                 draggable="true"
                 ondragstart="app.onSceneDragStart(event, ${marker.id})"
                 ondragend="app.onSceneDragEnd(event)"
                 onclick="app.showSceneDetails(${marker.id})"
                 oncontextmenu="event.preventDefault(); app.showSceneContextMenu(event, ${marker.id})">
              <div class="scene-color-bar" style="background: ${marker.color};"></div>
              <div class="scene-thumbnail">
                ${thumbnailHtml}
                <span class="scene-type-badge">${typeIcon}</span>
              </div>
              <div class="scene-info">
                <div class="scene-number">Scene ${index + 1}</div>
                <div class="scene-title">${marker.name}</div>
                <div class="scene-time">${timeHtml}</div>
                ${
                  hasDescription || hasTranscription || hasTags || hasScreengrabs
                    ? `
                  <div class="scene-meta-icons">
                    ${hasDescription ? `<span class="scene-meta-icon" title="Has description">${hasDescription}</span>` : ''}
                    ${hasTranscription ? `<span class="scene-meta-icon" title="Has transcription">${hasTranscription}</span>` : ''}
                    ${hasTags ? `<span class="scene-meta-icon" title="Has tags">${hasTags}</span>` : ''}
                    ${hasScreengrabs ? `<span class="scene-meta-icon" title="Has screengrabs">${hasScreengrabs}</span>` : ''}
                  </div>
                `
                    : ''
                }
              </div>
              <button class="scene-add-btn" onclick="event.stopPropagation(); app.addToPlaylist(${marker.id})" title="Add to Playlist">
                ${this.playlist.some((p) => p.markerId === marker.id) ? '✓' : '+'}
              </button>
            </div>
          `;
      })
      .join('');

    // Generate thumbnails for scenes that don't have them
    this.generateMissingSceneThumbnails();
  },

  async generateMissingSceneThumbnails() {
    if (!this.videoPath) return;

    for (const marker of this.markers) {
      if (!this.sceneThumbnails[marker.id]) {
        const time = marker.type === 'range' ? marker.inTime : marker.time;
        try {
          const result = await window.videoEditor.generateThumbnail(this.videoPath, this.formatTimeForFFmpeg(time));
          if (result && !result.error && result.outputPath) {
            this.sceneThumbnails[marker.id] = result.outputPath;

            // Update just this thumbnail in the DOM
            const card = document.querySelector(`.scene-card[data-id="${marker.id}"] .scene-thumbnail`);
            if (card) {
              const img = card.querySelector('img');
              if (img) {
                img.src = `${pathToFileUrl(result.outputPath)}?t=${Date.now()}`;
              } else {
                card.innerHTML = `<img src="${pathToFileUrl(result.outputPath)}"><span class="scene-type-badge">${marker.type === 'range' ? '↔️' : '📍'}</span>`;
              }
            }
          }
        } catch (error) {
          console.error(`[Scenes] Error generating thumbnail for marker ${marker.id}:`, error);
        }
      }
    }
  },

  async generateAllSceneThumbnails() {
    if (!this.videoPath || this.markers.length === 0) {
      this.showToast('info', 'No story beats to refresh');
      return;
    }

    this.showToast('info', 'Refreshing thumbnails...');
    this.sceneThumbnails = {}; // Clear cache
    await this.generateMissingSceneThumbnails();
    this.showToast('success', 'Thumbnails refreshed');
  },

  formatTimeForFFmpeg(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  },

  showSceneDetails(markerId) {
    const marker = this.markers.find((m) => m.id === markerId);
    if (!marker) return;

    const index = this.markers.indexOf(marker) + 1;
    const details = document.getElementById('sceneDetails');
    const content = document.getElementById('sceneDetailsContent');
    const title = document.getElementById('sceneDetailsTitle');

    title.textContent = marker.name;

    // Highlight card
    document.querySelectorAll('.scene-card').forEach((el) => el.classList.remove('active'));
    const card = document.querySelector(`.scene-card[data-id="${markerId}"]`);
    if (card) card.classList.add('active');

    // Build timecode
    let timecodeHtml;
    if (marker.type === 'range') {
      const duration = marker.outTime - marker.inTime;
      timecodeHtml = `
            <span class="in">IN: ${this.formatTime(marker.inTime)}</span>
            <span class="out">OUT: ${this.formatTime(marker.outTime)}</span>
            <span class="duration">${this.formatTime(duration)}</span>
          `;
    } else {
      timecodeHtml = `<span class="in">Time: ${this.formatTime(marker.time)}</span>`;
    }

    // Thumbnail
    const thumbnailSrc = this.sceneThumbnails[marker.id];
    const thumbnailHtml = thumbnailSrc
      ? `<img src="${pathToFileUrl(thumbnailSrc)}" alt="${marker.name}">`
      : `<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-muted);">No thumbnail</div>`;

    // Tags
    const tagsHtml =
      marker.tags?.length > 0
        ? marker.tags.map((t) => `<span class="marker-tag">${t}</span>`).join('')
        : '<span style="color: var(--text-muted); font-style: italic;">No tags</span>';

    content.innerHTML = `
          <div class="scene-details-thumbnail" onclick="app.goToMarker(${marker.id})" style="cursor: pointer;" title="Click to go to this scene">
            ${thumbnailHtml}
          </div>
          
          <div class="scene-details-section">
            <div class="scene-details-label">Scene ${index} • ${marker.type === 'range' ? 'Range' : 'Spot'}</div>
            <div class="scene-details-timecode">${timecodeHtml}</div>
          </div>
          
          ${
            marker.description
              ? `
            <div class="scene-details-section">
              <div class="scene-details-label">Description</div>
              <div class="scene-details-value">${marker.description}</div>
            </div>
          `
              : ''
          }
          
          ${
            marker.transcription
              ? `
            <div class="scene-details-section">
              <div class="scene-details-label">Transcription</div>
              <div class="scene-details-transcription">"${marker.transcription}"</div>
            </div>
          `
              : ''
          }
          
          <div class="scene-details-section">
            <div class="scene-details-label">Tags</div>
            <div class="marker-tags">${tagsHtml}</div>
          </div>
          
          ${
            marker.notes
              ? `
            <div class="scene-details-section">
              <div class="scene-details-label">Notes</div>
              <div class="scene-details-value" style="color: var(--text-muted); font-style: italic;">${marker.notes}</div>
            </div>
          `
              : ''
          }
          
          <div class="scene-details-section" style="display: flex; gap: 16px;">
            <div>
              <div class="scene-details-label">Created</div>
              <div class="scene-details-value" style="font-family: 'JetBrains Mono', monospace; font-size: 11px;">${marker.createdAt ? new Date(marker.createdAt).toLocaleDateString() : '-'}</div>
            </div>
            <div>
              <div class="scene-details-label">Modified</div>
              <div class="scene-details-value" style="font-family: 'JetBrains Mono', monospace; font-size: 11px;">${marker.modifiedAt ? new Date(marker.modifiedAt).toLocaleDateString() : '-'}</div>
            </div>
          </div>
          
          <div class="scene-details-actions">
            <button class="btn btn-secondary" onclick="app.goToMarker(${marker.id})">▶ Go to Scene</button>
            <button class="btn btn-ghost" onclick="app.editMarker(${marker.id})">✏️ Edit</button>
            ${
              marker.type === 'range'
                ? `
              <button class="btn btn-ghost" onclick="app.transcribeMarkerById(${marker.id})">🎤 Transcribe</button>
              <button class="btn btn-ghost" onclick="app.generateScreengrabsForMarker(${marker.id})">📸 Grabs</button>
            `
                : ''
            }
          </div>
          
          <button class="btn btn-ghost" style="width: 100%; margin-top: 12px; color: var(--error);" onclick="app.deleteMarker(${marker.id}); app.closeSceneDetails();">
            🗑️ Delete Scene
          </button>
        `;

    details.classList.remove('hidden');
  },

  closeSceneDetails() {
    document.getElementById('sceneDetails').classList.add('hidden');
    document.querySelectorAll('.scene-card').forEach((el) => el.classList.remove('active'));
  },

  // Export scenes for Agentic Player
  exportToAgenticPlayer() {
    if (this.markers.length === 0) {
      this.showToast('error', 'No story beats to export');
      return;
    }

    const videoFileName = this.videoPath ? this.videoPath.split('/').pop() : 'main.mp4';

    const exportData = {
      config: {
        title: videoFileName.replace(/\.[^.]+$/, ''),
        defaultVideo: `videos/${videoFileName}`,
        exportedAt: new Date().toISOString(),
      },
      scenes: this.markers.map((marker, _index) => {
        const scene = {
          id: marker.id,
          name: marker.name,
          type: marker.type,
          videoSrc: `videos/${videoFileName}`,
          color: marker.color,
        };

        if (marker.type === 'range') {
          scene.inTime = marker.inTime;
          scene.outTime = marker.outTime;
        } else {
          scene.time = marker.time;
          scene.inTime = Math.max(0, marker.time - 2.5);
          scene.outTime = marker.time + 2.5;
        }

        if (marker.description) scene.description = marker.description;
        if (marker.transcription) scene.transcription = marker.transcription;
        if (marker.tags && marker.tags.length > 0) scene.tags = marker.tags;
        if (marker.notes) scene.notes = marker.notes;

        return scene;
      }),
    };

    // Create and download the JSON file
    const jsonStr = JSON.stringify(exportData, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = 'scenes.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    this.showToast('success', `Exported ${this.markers.length} story beats for Agentic Player`);
  },

  // Scene context menu
  showSceneContextMenu(event, markerId) {
    const marker = this.markers.find((m) => m.id === markerId);
    if (!marker) return;

    const index = this.markers.indexOf(marker) + 1;
    const isRange = marker.type === 'range';

    const inPlaylist = this.playlist.some((p) => p.markerId === markerId);

    const items = [
      { type: 'header', label: `Scene ${index}: ${marker.name}` },
      { icon: '▶️', label: 'Go to Scene', action: () => this.goToMarker(markerId) },
      { icon: '👁️', label: 'View Details', action: () => this.showSceneDetails(markerId) },
      { type: 'divider' },
      {
        icon: inPlaylist ? '✓' : '➕',
        label: inPlaylist ? 'In Playlist' : 'Add to Playlist',
        action: () => this.addToPlaylist(markerId),
        disabled: inPlaylist,
      },
      { type: 'divider' },
      { type: 'header', label: 'Edit Metadata' },
      { icon: '✏️', label: 'Edit All Properties', action: () => this.editMarker(markerId) },
      { icon: '🏷️', label: 'Edit Name', action: () => this.quickEditSceneName(markerId) },
      { icon: '📝', label: 'Edit Description', action: () => this.quickEditSceneDescription(markerId) },
      { icon: '🏷️', label: 'Edit Tags', action: () => this.quickEditSceneTags(markerId) },
      { type: 'divider' },
      { type: 'header', label: 'Generate' },
      { icon: '🎤', label: 'Auto-Transcribe', action: () => this.transcribeMarkerById(markerId), disabled: !isRange },
      { icon: '📸', label: 'Capture Frames', action: () => this.generateScreengrabsForMarker(markerId) },
      { icon: '🖼️', label: 'Refresh Thumbnail', action: () => this.refreshSceneThumbnail(markerId) },
      { type: 'divider' },
      { icon: '🎨', label: 'Change Color', action: () => this.showColorPicker(markerId) },
      { type: 'divider' },
      { icon: '🗑️', label: 'Delete Scene', action: () => this.deleteMarker(markerId), danger: true },
    ];

    this.showCustomContextMenu(event.clientX, event.clientY, items);
  },

  showCustomContextMenu(x, y, items) {
    const menu = document.getElementById('contextMenu');
    const menuItems = document.getElementById('contextMenuItems');
    menu.setAttribute('role', 'menu');

    let html = '';
    for (const item of items) {
      if (item.type === 'divider') {
        html += '<div class="context-menu-divider"></div>';
      } else if (item.type === 'header') {
        html += `<div class="context-menu-header">${item.label}</div>`;
      } else {
        const disabledClass = item.disabled ? 'disabled' : '';
        const dangerClass = item.danger ? 'danger' : '';
        html += `
              <div class="context-menu-item ${disabledClass} ${dangerClass}" role="menuitem" tabindex="${item.disabled ? -1 : 0}" data-action-id="${Math.random()}">
                <span class="context-menu-item-icon">${item.icon}</span>
                <span class="context-menu-item-label">${item.label}</span>
              </div>
            `;
      }
    }

    menuItems.innerHTML = html;

    // Add click handlers
    const menuItemEls = menuItems.querySelectorAll('.context-menu-item');
    let actionIndex = 0;
    for (const item of items) {
      if (item.type !== 'divider' && item.type !== 'header') {
        const el = menuItemEls[actionIndex];
        if (el && item.action && !item.disabled) {
          el.addEventListener('click', () => {
            item.action();
            this.hideContextMenu();
          });
          el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              el.click();
            } else if (e.key === 'Escape') {
              this.hideContextMenu();
            }
          });
        }
        actionIndex++;
      }
    }

    // Position and show menu with smart positioning
    this.positionContextMenu(menu, x, y);
    const first = menuItems.querySelector('.context-menu-item:not(.disabled)');
    if (first) first.focus();
  },

  // Quick edit functions
  quickEditSceneName(markerId) {
    const marker = this.markers.find((m) => m.id === markerId);
    if (!marker) return;

    const newName = prompt('Scene Name:', marker.name);
    if (newName !== null && newName.trim()) {
      marker.name = newName.trim();
      marker.modifiedAt = new Date().toISOString();
      this.renderMarkers();
      this.renderScenesList();
      this.showToast('success', 'Story beat name updated');
    }
  },

  quickEditSceneDescription(markerId) {
    const marker = this.markers.find((m) => m.id === markerId);
    if (!marker) return;

    const newDesc = prompt('Description:', marker.description || '');
    if (newDesc !== null) {
      marker.description = newDesc.trim();
      marker.modifiedAt = new Date().toISOString();
      this.renderMarkers();
      this.renderScenesList();
      this.showToast('success', 'Description updated');
    }
  },

  quickEditSceneTags(markerId) {
    const marker = this.markers.find((m) => m.id === markerId);
    if (!marker) return;

    const currentTags = marker.tags?.join(', ') || '';
    const newTags = prompt('Tags (comma separated):', currentTags);
    if (newTags !== null) {
      marker.tags = newTags
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t);
      marker.modifiedAt = new Date().toISOString();
      this.renderMarkers();
      this.renderScenesList();
      this.showToast('success', 'Tags updated');
    }
  },

  async refreshSceneThumbnail(markerId) {
    const marker = this.markers.find((m) => m.id === markerId);
    if (!marker || !this.videoPath) return;

    const time = marker.type === 'range' ? marker.inTime : marker.time;

    try {
      delete this.sceneThumbnails[markerId]; // Clear cached thumbnail
      const result = await window.videoEditor.generateThumbnail(this.videoPath, this.formatTimeForFFmpeg(time));

      if (result && !result.error && result.outputPath) {
        this.sceneThumbnails[markerId] = result.outputPath;
        this.renderScenesList();
        this.showToast('success', 'Thumbnail refreshed');
      }
    } catch (_error) {
      this.showToast('error', 'Failed to refresh thumbnail');
    }
  },

  // Scene drag to playlist
  draggingSceneId: null,

  onSceneDragStart(event, markerId) {
    this.draggingSceneId = markerId;
    event.target.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('text/plain', markerId.toString());
  },

  onSceneDragEnd(event) {
    this.draggingSceneId = null;
    event.target.classList.remove('dragging');
    document.getElementById('playlistPanel').classList.remove('drag-over');
  },

  onPlaylistDragOverFromScene(event) {
    if (this.draggingSceneId !== null) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      document.getElementById('playlistPanel').classList.add('drag-over');
    }
  },

  onPlaylistDragLeave(event) {
    // Only remove if leaving the playlist panel entirely
    if (!event.currentTarget.contains(event.relatedTarget)) {
      document.getElementById('playlistPanel').classList.remove('drag-over');
    }
  },

  onPlaylistDropFromScene(event) {
    event.preventDefault();
    document.getElementById('playlistPanel').classList.remove('drag-over');

    const markerId = parseInt(event.dataTransfer.getData('text/plain'));
    if (markerId && !isNaN(markerId)) {
      this.addToPlaylist(markerId);
    }

    this.draggingSceneId = null;
  },

  // Playlist Functions
  addToPlaylist(markerId) {
    const marker = this.markers.find((m) => m.id === markerId);
    if (!marker) return;

    // Check if already in playlist
    if (this.playlist.some((p) => p.markerId === markerId)) {
      this.showToast('info', 'Scene already in playlist');
      return;
    }

    // Calculate duration
    let duration;
    if (marker.type === 'range') {
      duration = marker.outTime - marker.inTime;
    } else {
      // For spot markers, use 5 seconds
      duration = 5;
    }

    this.playlist.push({
      markerId: markerId,
      name: marker.name,
      color: marker.color,
      type: marker.type,
      inTime: marker.type === 'range' ? marker.inTime : Math.max(0, marker.time - 2.5),
      outTime: marker.type === 'range' ? marker.outTime : marker.time + 2.5,
      duration: duration,
    });

    this.renderPlaylist();
    this.showToast('success', `Added "${marker.name}" to playlist`);
  },

  removeFromPlaylist(index) {
    this.playlist.splice(index, 1);
    this.renderPlaylist();
  },

  clearPlaylist() {
    if (this.playlist.length === 0) return;
    if (confirm('Clear entire playlist?')) {
      this.playlist = [];
      this.playlistPlaying = false;
      this.playlistCurrentIndex = -1;
      this.renderPlaylist();
      this.showToast('success', 'Playlist cleared');
    }
  },

  shufflePlaylist() {
    if (this.playlist.length < 2) return;

    // Fisher-Yates shuffle
    for (let i = this.playlist.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.playlist[i], this.playlist[j]] = [this.playlist[j], this.playlist[i]];
    }

    this.renderPlaylist();
    this.showToast('success', 'Playlist shuffled');
  },

  movePlaylistItem(fromIndex, toIndex) {
    const item = this.playlist.splice(fromIndex, 1)[0];
    this.playlist.splice(toIndex, 0, item);
    this.renderPlaylist();
  },

  renderPlaylist() {
    const container = document.getElementById('playlistItems');
    const countEl = document.getElementById('playlistCount');
    const durationEl = document.getElementById('playlistDuration');
    const playBtn = document.getElementById('playlistPlayBtn');
    const exportBtn = document.getElementById('exportPlaylistBtn');
    const clearBtn = document.getElementById('clearPlaylistBtn');
    const shuffleBtn = document.getElementById('shufflePlaylistBtn');

    countEl.textContent = this.playlist.length;

    // Calculate total duration
    const totalDuration = this.playlist.reduce((sum, item) => sum + item.duration, 0);
    durationEl.textContent = this.formatTime(totalDuration);

    // Enable/disable buttons
    const hasItems = this.playlist.length > 0;
    playBtn.disabled = !hasItems;
    exportBtn.disabled = !hasItems;
    clearBtn.disabled = !hasItems;
    shuffleBtn.disabled = this.playlist.length < 2;

    if (this.playlist.length === 0) {
      container.innerHTML = `
            <div class="playlist-empty">
              Drag story beats here or right-click → "Add to Playlist"
            </div>
          `;
      return;
    }

    container.innerHTML = this.playlist
      .map(
        (item, index) => `
          <div class="playlist-item ${this.playlistCurrentIndex === index ? 'playing' : ''}" 
               data-index="${index}"
               draggable="true"
               ondragstart="app.onPlaylistDragStart(event, ${index})"
               ondragover="app.onPlaylistDragOver(event)"
               ondrop="app.onPlaylistDrop(event, ${index})"
               onclick="app.playPlaylistItem(${index})">
            <span class="playlist-item-drag">⋮⋮</span>
            <span class="playlist-item-number">${index + 1}</span>
            <div class="playlist-item-color" style="background: ${item.color};"></div>
            <div class="playlist-item-info">
              <div class="playlist-item-name">${item.name}</div>
              <div class="playlist-item-time">${this.formatTime(item.inTime)} → ${this.formatTime(item.outTime)} (${this.formatTime(item.duration)})</div>
            </div>
            <button class="playlist-item-remove" onclick="event.stopPropagation(); app.removeFromPlaylist(${index})" title="Remove">✕</button>
          </div>
        `
      )
      .join('');
  },

  // Drag and drop for playlist reordering
  playlistDragIndex: null,

  onPlaylistDragStart(event, index) {
    this.playlistDragIndex = index;
    event.target.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
  },

  onPlaylistDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  },

  onPlaylistDrop(event, dropIndex) {
    event.preventDefault();

    if (this.playlistDragIndex !== null && this.playlistDragIndex !== dropIndex) {
      this.movePlaylistItem(this.playlistDragIndex, dropIndex);
    }

    this.playlistDragIndex = null;
    document.querySelectorAll('.playlist-item').forEach((el) => el.classList.remove('dragging'));
  },

  // Playlist playback
  togglePlaylistPlayback() {
    if (this.playlistPlaying) {
      this.stopPlaylistPlayback();
    } else {
      this.startPlaylistPlayback();
    }
  },

  startPlaylistPlayback() {
    if (this.playlist.length === 0) return;

    this.playlistPlaying = true;
    this.playlistCurrentIndex = 0;

    const playBtn = document.getElementById('playlistPlayBtn');
    playBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><rect x="4" y="4" width="16" height="16"/></svg> Stop';
    playBtn.classList.add('playing');

    this.playCurrentPlaylistItem();
    this.renderPlaylist();
  },

  stopPlaylistPlayback() {
    this.playlistPlaying = false;
    this.playlistCurrentIndex = -1;

    const video = document.getElementById('videoPlayer');
    video.pause();

    const playBtn = document.getElementById('playlistPlayBtn');
    playBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M5 3l14 9-14 9V3z"/></svg> Play All';
    playBtn.classList.remove('playing');

    this.renderPlaylist();
  },

  playPlaylistItem(index) {
    if (index < 0 || index >= this.playlist.length) return;

    this.playlistCurrentIndex = index;
    this.playCurrentPlaylistItem();
    this.renderPlaylist();
  },

  playCurrentPlaylistItem() {
    if (this.playlistCurrentIndex < 0 || this.playlistCurrentIndex >= this.playlist.length) {
      this.stopPlaylistPlayback();
      return;
    }

    const item = this.playlist[this.playlistCurrentIndex];
    const video = document.getElementById('videoPlayer');

    video.currentTime = item.inTime;
    video.play();

    // Set up listener to detect when we reach the out point
    this.setupPlaylistEndListener(item.outTime);
  },

  setupPlaylistEndListener(outTime) {
    const video = document.getElementById('videoPlayer');

    // Remove any existing listener
    if (this.playlistTimeUpdateHandler) {
      video.removeEventListener('timeupdate', this.playlistTimeUpdateHandler);
    }

    this.playlistTimeUpdateHandler = () => {
      if (!this.playlistPlaying) return;

      if (video.currentTime >= outTime - 0.1) {
        // Move to next item
        this.playlistCurrentIndex++;

        if (this.playlistCurrentIndex >= this.playlist.length) {
          // End of playlist
          this.stopPlaylistPlayback();
          this.showToast('success', 'Playlist complete');
        } else {
          // Play next item
          this.playCurrentPlaylistItem();
          this.renderPlaylist();
        }
      }
    };

    video.addEventListener('timeupdate', this.playlistTimeUpdateHandler);
  },

  // AI Playlist Builder
  aiBuilderExpanded: true,

  toggleAIBuilder() {
    this.aiBuilderExpanded = !this.aiBuilderExpanded;
    document.getElementById('aiBuilderContent').classList.toggle('collapsed', !this.aiBuilderExpanded);
    document.getElementById('aiBuilderToggle').classList.toggle('collapsed', !this.aiBuilderExpanded);
  },

  async buildPlaylistWithAI() {
    const prompt = document.getElementById('aiPlaylistPrompt').value.trim();

    if (!prompt) {
      this.showToast('error', 'Please enter a prompt describing the playlist you want');
      return;
    }

    if (this.markers.length === 0) {
      this.showToast('error', 'No story beats available. Add some markers first.');
      return;
    }

    const keepOrder = document.getElementById('aiKeepOrder').checked;
    const includeAll = document.getElementById('aiIncludeAll').checked;

    const btn = document.getElementById('aiBuilderBtn');
    const status = document.getElementById('aiBuilderStatus');

    btn.disabled = true;
    btn.innerHTML = '⏳ Thinking...';
    status.className = 'ai-builder-status loading';
    status.textContent = 'Analyzing your story beats...';
    status.classList.remove('hidden');

    try {
      // Build scene data for AI
      const scenesData = this.markers.map((marker, index) => {
        const duration = marker.type === 'range' ? marker.outTime - marker.inTime : 5;

        return {
          id: marker.id,
          index: index + 1,
          name: marker.name,
          type: marker.type,
          duration: duration,
          durationFormatted: this.formatTime(duration),
          timeIn: marker.type === 'range' ? this.formatTime(marker.inTime) : this.formatTime(marker.time),
          timeOut: marker.type === 'range' ? this.formatTime(marker.outTime) : null,
          description: marker.description || '',
          transcription: marker.transcription || '',
          tags: marker.tags || [],
          notes: marker.notes || '',
        };
      });

      // Call AI to build playlist
      const result = await window.videoEditor.buildPlaylistWithAI({
        prompt,
        scenes: scenesData,
        keepOrder,
        includeAll,
      });

      if (!result.success) {
        throw new Error(result.error);
      }

      // Clear existing playlist and add AI selections
      this.playlist = [];

      for (const selectedId of result.selectedSceneIds) {
        const marker = this.markers.find((m) => m.id === selectedId);
        if (marker) {
          this.addToPlaylist(marker.id);
        }
      }

      status.className = 'ai-builder-status success';
      status.textContent = `✓ Created playlist with ${result.selectedSceneIds.length} story beats${result.reasoning ? ': ' + result.reasoning : ''}`;

      this.renderPlaylist();
      this.showToast('success', `AI created a playlist with ${result.selectedSceneIds.length} story beats!`);
    } catch (error) {
      console.error('[AI Playlist] Error:', error);
      status.className = 'ai-builder-status error';
      status.textContent = '✕ ' + error.message;
      this.showToast('error', 'AI playlist failed: ' + error.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '✨ Build with AI';
    }
  },

  // Export playlist as a single video
  async exportPlaylist() {
    if (this.playlist.length === 0) {
      this.showToast('error', 'Playlist is empty');
      return;
    }

    if (!this.videoPath) {
      this.showToast('error', 'No video loaded');
      return;
    }

    const totalDuration = this.playlist.reduce((sum, item) => sum + item.duration, 0);

    if (
      !confirm(
        `Export playlist as single video?\n\n${this.playlist.length} story beats, ${this.formatTime(totalDuration)} total duration`
      )
    ) {
      return;
    }

    this.showProgress('Exporting Playlist...', 'Creating video from story beats');

    try {
      // Build segments array for concatenation
      const segments = this.playlist.map((item) => ({
        startTime: item.inTime,
        endTime: item.outTime,
      }));

      const result = await window.videoEditor.exportPlaylist(this.videoPath, { segments });

      this.hideProgress();

      if (result.error) {
        throw new Error(result.error);
      }

      this.showToast('success', 'Playlist exported successfully!');
      this.loadExports();
    } catch (error) {
      this.hideProgress();
      this.showToast('error', 'Export failed: ' + error.message);
    }
  },

  // Save scenes (and optionally edited video) back to Space
  async saveToSpace() {
    if (!this.spaceItemId) {
      this.showToast('error', 'Video was not loaded from a Space');
      return;
    }

    if (this.markers.length === 0) {
      this.showToast('warning', 'No story beats to save. Add some markers first.');
      return;
    }

    // Convert markers to scenes format
    const scenes = this.markers.map((marker, index) => ({
      id: marker.id || index + 1,
      name: marker.name || `Scene ${index + 1}`,
      inTime: marker.type === 'range' ? marker.timeIn : marker.time,
      outTime: marker.type === 'range' ? marker.timeOut : marker.time + 5, // Default 5s for spot markers
      description: marker.description || '',
      transcription: marker.transcription || '',
      tags: marker.tags || [],
      notes: marker.notes || '',
    }));

    try {
      this.showProgress('Saving to Space...', 'Updating scene metadata');

      // Save scenes only (no video re-encoding)
      const result = await window.videoEditor.saveScenesOnly(this.spaceItemId, scenes);

      this.hideProgress();

      if (!result.success) {
        throw new Error(result.error || 'Failed to save');
      }

      this.showToast('success', `Saved ${result.scenesCount} story beats to Space!`);
    } catch (error) {
      this.hideProgress();
      this.showToast('error', 'Save failed: ' + error.message);
    }
  },

  // Silent save markers to Space (no UI feedback) - used for auto-save
  async saveMarkersToSpace() {
    if (!this.spaceItemId || this.markers.length === 0) {
      return { success: false, error: 'No Space or markers' };
    }

    // Convert markers to scenes format
    const scenes = this.markers.map((marker, index) => ({
      id: marker.id || index + 1,
      name: marker.name || `Scene ${index + 1}`,
      inTime: marker.type === 'range' ? marker.inTime : marker.time,
      outTime: marker.type === 'range' ? marker.outTime : marker.time + 5,
      description: marker.description || '',
      transcription: marker.transcription || '',
      tags: marker.tags || [],
      notes: marker.notes || '',
      markerType: marker.markerType || 'scene',
      color: marker.color || null,
      completed: marker.completed || false,
    }));

    try {
      const result = await window.videoEditor.saveScenesOnly(this.spaceItemId, scenes);
      return result;
    } catch (error) {
      console.error('[VideoEditor] saveMarkersToSpace error:', error);
      if (window.api && window.api.log) {
        window.api.log.error('Video editor save markers failed', {
          error: error.message,
          operation: 'saveMarkersToSpace',
        });
      }
      return { success: false, error: error.message };
    }
  },

  /**
   * Save full project state to Space storage
   * Includes markers, audio tracks, translations, learning data, etc.
   */
  async saveFullProjectToSpace() {
    if (!this.spaceItemId) {
      console.log('[SpaceStorage] No Space item to save to');
      return { success: false, error: 'No Space item' };
    }

    if (!window.clipboard?.updateMetadata) {
      console.log('[SpaceStorage] clipboard.updateMetadata not available');
      return { success: false, error: 'Storage API not available' };
    }

    try {
      // Build comprehensive project state
      const projectState = {
        // Project metadata
        projectVersion: '2.0',
        lastSaved: new Date().toISOString(),
        editorVersion: '2.3.0',

        // Video metadata
        videoPath: this.videoPath,
        videoDuration: this.videoDuration,

        // Markers (with learning-specific fields)
        markers: this.markers.map((m) => ({
          ...m,
          markerType: m.markerType || 'scene',
          completed: m.completed || false,
        })),

        // Audio tracks (multi-track audio)
        audioTracks:
          this.audioTracks?.map((track) => ({
            id: track.id,
            name: track.name,
            type: track.type,
            volume: track.volume,
            pan: track.pan,
            muted: track.muted,
            solo: track.solo,
            clips:
              track.clips?.map((clip) => ({
                id: clip.id,
                name: clip.name,
                path: clip.path,
                startTime: clip.startTime,
                endTime: clip.endTime,
                type: clip.type,
                source: clip.source,
              })) || [],
          })) || [],

        // Translation state
        translations: this.translationHistory || [],
        currentLanguage: this.currentTranslationLanguage,

        // Transcription
        transcriptSegments: this.transcriptSegments,
        transcriptSpeakers: this.transcriptSpeakers,
        transcriptSource: this.transcriptSource,
        speakerNames: this.speakerNames,
        speakerRoles: this.speakerRoles,

        // Learning workflow data
        learningProgress: {
          completedChapters: this.markers.filter((m) => m.markerType === 'chapter' && m.completed).map((m) => m.id),
          completedCheckpoints: this.markers.filter((m) => m.completed).map((m) => m.id),
          totalChapters: this.markers.filter((m) => m.markerType === 'chapter').length,
          lastPosition: this.video?.currentTime || 0,
        },

        // Story beats / template
        selectedTemplate: this.storyBeatsEditor?.selectedTemplate || 'learning',

        // Edit history (last 10 for crash recovery)
        recentUndoStates: this.undoStack?.slice(-10) || [],

        // Playlist/export queue
        playlist: this.playlist || [],

        // Budget tracking (if applicable)
        budgetData: this.budgetData || null,
      };

      // Save to Space metadata
      await window.clipboard.updateMetadata(this.spaceItemId, {
        videoEditorProject: projectState,
        projectLastSaved: projectState.lastSaved,
      });

      // Also save scenes separately (for backward compatibility)
      if (this.markers.length > 0) {
        await this.saveMarkersToSpace();
      }

      console.log('[SpaceStorage] Full project saved successfully');
      return { success: true, timestamp: projectState.lastSaved };
    } catch (error) {
      console.error('[SpaceStorage] Save error:', error);
      return { success: false, error: error.message };
    }
  },

  /**
   * Load full project state from Space storage
   */
  async loadProjectFromSpace() {
    if (!this.spaceItemId) {
      console.log('[SpaceStorage] No Space item to load from');
      return { success: false, error: 'No Space item' };
    }

    if (!window.clipboard?.getMetadata) {
      console.log('[SpaceStorage] clipboard.getMetadata not available');
      return { success: false, error: 'Storage API not available' };
    }

    try {
      const metadata = await window.clipboard.getMetadata(this.spaceItemId);

      if (!metadata?.videoEditorProject) {
        console.log('[SpaceStorage] No saved project found in Space');
        return { success: false, error: 'No project data found' };
      }

      const project = metadata.videoEditorProject;
      console.log('[SpaceStorage] Loading project from:', project.lastSaved);

      // Restore markers (with learning fields)
      if (project.markers && project.markers.length > 0) {
        this.markers = project.markers;
        this.renderMarkers();
      }

      // Restore audio tracks
      if (project.audioTracks && project.audioTracks.length > 0) {
        this.audioTracks = project.audioTracks;
        this.renderAudioTracks?.();
      }

      // Restore transcription
      if (project.transcriptSegments) {
        this.transcriptSegments = project.transcriptSegments;
        this.transcriptSpeakers = project.transcriptSpeakers;
        this.transcriptSource = project.transcriptSource;
        this.speakerNames = project.speakerNames || {};
        this.speakerRoles = project.speakerRoles || {};
      }

      // Restore translations
      if (project.translations) {
        this.translationHistory = project.translations;
        this.currentTranslationLanguage = project.currentLanguage;
      }

      // Restore learning progress
      if (project.learningProgress) {
        // Mark chapters as completed
        project.learningProgress.completedChapters?.forEach((chapterId) => {
          const marker = this.markers.find((m) => m.id === chapterId);
          if (marker) marker.completed = true;
        });

        // Seek to last position if user wants
        if (project.learningProgress.lastPosition > 0) {
          const resumePrompt = `Resume from ${this.formatTime(project.learningProgress.lastPosition)}?`;
          if (confirm(resumePrompt)) {
            const video = document.getElementById('videoPlayer');
            if (video) video.currentTime = project.learningProgress.lastPosition;
          }
        }
      }

      // Restore template selection
      if (project.selectedTemplate && this.storyBeatsEditor) {
        this.storyBeatsEditor.setTemplate(project.selectedTemplate);
      }

      // Restore playlist
      if (project.playlist) {
        this.playlist = project.playlist;
      }

      console.log('[SpaceStorage] Project loaded successfully');
      this.showToast?.('success', 'Project restored from Space');

      return {
        success: true,
        project: project,
        lastSaved: project.lastSaved,
      };
    } catch (error) {
      console.error('[SpaceStorage] Load error:', error);
      return { success: false, error: error.message };
    }
  },

  // Save edited video and scenes back to Space (replaces original)
  async saveEditedVideoToSpace() {
    if (!this.spaceItemId) {
      this.showToast('error', 'Video was not loaded from a Space');
      return;
    }

    if (this.playlist.length === 0 && this.markers.length === 0) {
      this.showToast('warning', 'No edits or story beats to save.');
      return;
    }

    // If there's a playlist, use it as the edit list
    // Otherwise just save scenes
    if (this.playlist.length === 0) {
      return this.saveToSpace();
    }

    const totalDuration = this.playlist.reduce((sum, item) => sum + item.duration, 0);

    if (
      !confirm(
        `Save edited video back to Space?\n\nThis will:\n• Create a new video from ${this.playlist.length} story beats (${this.formatTime(totalDuration)})\n• Replace the original video (backup will be created)\n• Save story beat markers to metadata\n\nContinue?`
      )
    ) {
      return;
    }

    try {
      // Step 1: Process edit list
      this.showProgress('Processing Video...', 'Combining selected segments');

      const editList = this.playlist.map((item) => ({
        startTime: item.inTime,
        endTime: item.outTime,
      }));

      const editResult = await window.videoEditor.processEditList(this.videoPath, editList, {
        quality: 'high',
      });

      if (!editResult.success) {
        throw new Error(editResult.error || 'Failed to process video');
      }

      // Step 2: Finalize workflow (replace + save scenes)
      this.showProgress('Saving to Space...', 'Replacing original and saving story beats');

      // Convert markers to scenes (adjust times for new video)
      const scenes = this.playlist.map((item, index) => {
        // Calculate new times based on cumulative duration
        let newInTime = 0;
        for (let i = 0; i < index; i++) {
          newInTime += this.playlist[i].outTime - this.playlist[i].inTime;
        }
        const duration = item.outTime - item.inTime;

        return {
          id: index + 1,
          name: item.name || `Scene ${index + 1}`,
          inTime: newInTime,
          outTime: newInTime + duration,
          description: item.description || '',
          transcription: item.transcription || '',
          tags: item.tags || [],
        };
      });

      const finalResult = await window.videoEditor.finalizeWorkflow(this.spaceItemId, editResult.outputPath, scenes);

      this.hideProgress();

      if (!finalResult.success) {
        throw new Error(finalResult.error || 'Failed to save to space');
      }

      this.showToast(
        'success',
        `Video saved to Space! (${finalResult.scenesCount} story beats, ${this.formatTime(finalResult.newDuration)})`
      );

      // Clear playlist since it's been saved
      this.clearPlaylist();

      // Reload the video from the space
      this.loadVideoFromSpace(this.spaceItemId);
    } catch (error) {
      this.hideProgress();
      this.showToast('error', 'Save failed: ' + error.message);
    }
  },

  showColorPicker(markerId) {
    const marker = this.markers.find((m) => m.id === markerId);
    if (!marker) return;

    // Create a simple color picker modal
    const colors = this.markerColors;
    const currentColor = marker.color;

    const modal = document.createElement('div');
    modal.className = 'marker-modal-backdrop';
    modal.style.cssText =
      'position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 2999; display: flex; align-items: center; justify-content: center;';

    modal.innerHTML = `
          <div style="background: var(--bg-surface); border-radius: 12px; padding: 20px; min-width: 280px;">
            <div style="font-size: 14px; font-weight: 600; margin-bottom: 16px;">Choose Color</div>
            <div style="display: flex; gap: 10px; flex-wrap: wrap; justify-content: center;">
              ${colors
                .map(
                  (color) => `
                <div class="color-option" data-color="${color}" 
                     style="width: 36px; height: 36px; border-radius: 50%; background: ${color}; cursor: pointer; 
                            border: 3px solid ${color === currentColor ? 'white' : 'transparent'};
                            box-shadow: ${color === currentColor ? '0 0 0 2px var(--accent-primary)' : 'none'};">
                </div>
              `
                )
                .join('')}
            </div>
            <div style="display: flex; gap: 8px; margin-top: 20px; justify-content: flex-end;">
              <button class="btn btn-ghost" onclick="this.closest('.marker-modal-backdrop').remove()">Cancel</button>
            </div>
          </div>
        `;

    // Add click handlers for colors
    modal.querySelectorAll('.color-option').forEach((el) => {
      el.addEventListener('click', () => {
        marker.color = el.dataset.color;
        marker.modifiedAt = new Date().toISOString();
        this.renderMarkers();
        this.renderScenesList();
        modal.remove();
        this.showToast('success', 'Color updated');
      });
    });

    // Close on backdrop click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });

    document.body.appendChild(modal);
  },

  goToMarker(id) {
    const marker = this.markers.find((m) => m.id === id);
    if (!marker) return;

    const video = document.getElementById('videoPlayer');
    // For range markers, go to IN point; for spot markers, go to time
    video.currentTime = marker.type === 'range' ? marker.inTime : marker.time;

    // Highlight the marker
    document.querySelectorAll('.marker').forEach((el) => el.classList.remove('selected'));
    document.querySelectorAll('.marker-range').forEach((el) => el.classList.remove('selected'));
    document.querySelectorAll('.marker-item').forEach((el) => el.classList.remove('active'));

    const markerEl = document.querySelector(`.marker[data-id="${id}"]`);
    const rangeEl = document.querySelector(`.marker-range[data-id="${id}"]`);
    const listItem = document.querySelector(`.marker-item[data-id="${id}"]`);

    if (markerEl) markerEl.classList.add('selected');
    if (rangeEl) rangeEl.classList.add('selected');
    if (listItem) listItem.classList.add('active');
  },

  goToMarkerEnd(id) {
    const marker = this.markers.find((m) => m.id === id);
    if (!marker || marker.type !== 'range') return;

    const video = document.getElementById('videoPlayer');
    video.currentTime = marker.outTime;
  },

  editMarker(id) {
    const marker = this.markers.find((m) => m.id === id);
    if (!marker) return;
    this.showMarkerModal(marker.time, marker);
  },

  goToPrevMarker() {
    if (this.markers.length === 0) return;
    const video = document.getElementById('videoPlayer');
    const currentTime = video.currentTime;

    // Get marker time (use inTime for ranges)
    const getMarkerTime = (m) => (m.type === 'range' ? m.inTime : m.time);

    // Find the previous marker (with small tolerance)
    for (let i = this.markers.length - 1; i >= 0; i--) {
      if (getMarkerTime(this.markers[i]) < currentTime - 0.5) {
        this.goToMarker(this.markers[i].id);
        return;
      }
    }

    // If no previous, go to last marker
    this.goToMarker(this.markers[this.markers.length - 1].id);
  },

  goToNextMarker() {
    if (this.markers.length === 0) return;
    const video = document.getElementById('videoPlayer');
    const currentTime = video.currentTime;

    // Get marker time (use inTime for ranges)
    const getMarkerTime = (m) => (m.type === 'range' ? m.inTime : m.time);

    // Find the next marker
    for (let i = 0; i < this.markers.length; i++) {
      if (getMarkerTime(this.markers[i]) > currentTime + 0.5) {
        this.goToMarker(this.markers[i].id);
        return;
      }
    }

    // If no next, go to first marker
    this.goToMarker(this.markers[0].id);
  },

  handleMarkerTrackClick(event) {
    // Don't add marker if we were dragging
    if (this.wasDragging) {
      this.wasDragging = false;
      return;
    }

    if (!this.videoPath) return;
    const video = document.getElementById('videoPlayer');
    if (!video || !video.duration) return;

    // If clicking on track (not a marker), add a marker at that position
    const track = event.currentTarget;
    const rect = track.getBoundingClientRect();
    const percent = (event.clientX - rect.left) / rect.width;
    const time = (percent * video.duration) / this.timelineZoom;

    this.showMarkerModal(time);
  },

  // Right-click on markers track to create a splice/beat
  handleMarkerTrackContextMenu(event) {
    event.preventDefault();

    if (!this.videoPath) return;
    const video = document.getElementById('videoPlayer');
    if (!video || !video.duration) return;

    // Get time from click position
    const track = document.getElementById('markersTrack');
    const rect = track.getBoundingClientRect();
    const percent = (event.clientX - rect.left) / rect.width;
    const time = (percent * video.duration) / this.timelineZoom;

    // Store context
    this.contextData = { spliceTime: time };

    // Show splice menu
    const items = [
      { type: 'header', label: `At ${this.formatTime(time)}` },
      { icon: '✂️', label: 'Splice Here (Create Beat)', action: 'spliceHere' },
      { icon: '📍', label: 'Add Spot Marker', action: 'addSpotMarker' },
      { type: 'divider' },
      { icon: '↔️', label: 'Create Range Beat...', action: 'createRangeBeat' },
    ];

    const menu = document.getElementById('contextMenu');
    const menuItems = document.getElementById('contextMenuItems');
    menu.setAttribute('role', 'menu');

    let html = '';
    for (const item of items) {
      if (item.type === 'divider') {
        html += '<div class="context-menu-divider"></div>';
      } else if (item.type === 'header') {
        html += `<div class="context-menu-header">${item.label}</div>`;
      } else {
        html += `
              <div class="context-menu-item" role="menuitem" tabindex="0" data-action="${item.action}">
                <span class="context-menu-item-icon">${item.icon}</span>
                <span class="context-menu-item-label">${item.label}</span>
              </div>
            `;
      }
    }

    menuItems.innerHTML = html;

    // Add click handlers
    menuItems.querySelectorAll('.context-menu-item').forEach((item) => {
      item.addEventListener('click', () => {
        const action = item.dataset.action;
        if (action === 'spliceHere') this.spliceAtTime(time);
        else if (action === 'addSpotMarker') this.showMarkerModal(time);
        else if (action === 'createRangeBeat') this.startRangeBeatCreation(time);
        this.hideContextMenu();
      });
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          item.click();
        } else if (e.key === 'Escape') {
          this.hideContextMenu();
        }
      });
    });

    // Position and show menu with smart positioning
    this.positionContextMenu(menu, event.clientX, event.clientY);
    const first = menuItems.querySelector('.context-menu-item:not(.disabled)');
    if (first) first.focus();
  },

  // Quick splice - creates a range beat from current position
  spliceAtTime(time) {
    const video = document.getElementById('videoPlayer');
    if (!video || !video.duration) return;

    // Create a 5-second range beat centered on the time
    const halfDuration = 2.5;
    const inTime = Math.max(0, time - halfDuration);
    const outTime = Math.min(video.duration, time + halfDuration);

    const marker = {
      id: this.nextMarkerId++,
      name: `Beat ${this.markers.length + 1}`,
      type: 'range',
      inTime: inTime,
      outTime: outTime,
      color: this.markerColors[this.markers.length % this.markerColors.length],
      description: '',
      transcription: '',
    };

    this.markers.push(marker);
    this.renderMarkers();
    this.showToast('success', `Beat created: ${this.formatTime(inTime)} - ${this.formatTime(outTime)}`);

    // Select and edit the new beat
    this.editMarker(marker.id);
  },

  // Start range beat creation (sets IN point, waits for OUT)
  startRangeBeatCreation(inTime) {
    this.pendingRangeMarker = {
      inTime: inTime,
      color: this.markerColors[this.markers.length % this.markerColors.length],
    };
    this.showToast('info', `IN point set at ${this.formatTime(inTime)}. Right-click to set OUT point.`);

    // Show pending indicator
    const indicator = document.getElementById('pendingRangeIndicator');
    const inTimeEl = document.getElementById('pendingInTime');
    if (indicator && inTimeEl) {
      inTimeEl.textContent = this.formatTime(inTime);
      indicator.classList.remove('hidden');
    }
  },

  // Drag functions for markers
  wasDragging: false,

  startDragSpot(event, markerId) {
    event.preventDefault();
    event.stopPropagation();

    const marker = this.markers.find((m) => m.id === markerId);
    if (!marker) return;

    this.draggingMarker = {
      id: markerId,
      type: 'spot',
      startX: event.clientX,
      startTime: marker.time,
    };

    // Add dragging class
    const el = document.querySelector(`.marker[data-id="${markerId}"]`);
    if (el) el.classList.add('dragging');

    // Add global listeners
    document.addEventListener('mousemove', this.handleMarkerDrag);
    document.addEventListener('mouseup', this.handleMarkerDragEnd);
  },

  startDragRangeIn(event, markerId) {
    event.preventDefault();
    event.stopPropagation();

    const marker = this.markers.find((m) => m.id === markerId);
    if (!marker || marker.type !== 'range') return;

    this.draggingMarker = {
      id: markerId,
      type: 'range-in',
      startX: event.clientX,
      startTime: marker.inTime,
    };

    const el = document.querySelector(`.marker[data-id="${markerId}-in"]`);
    if (el) el.classList.add('dragging');

    document.addEventListener('mousemove', this.handleMarkerDrag);
    document.addEventListener('mouseup', this.handleMarkerDragEnd);
  },

  startDragRangeOut(event, markerId) {
    event.preventDefault();
    event.stopPropagation();

    const marker = this.markers.find((m) => m.id === markerId);
    if (!marker || marker.type !== 'range') return;

    this.draggingMarker = {
      id: markerId,
      type: 'range-out',
      startX: event.clientX,
      startTime: marker.outTime,
    };

    const el = document.querySelector(`.marker[data-id="${markerId}-out"]`);
    if (el) el.classList.add('dragging');

    document.addEventListener('mousemove', this.handleMarkerDrag);
    document.addEventListener('mouseup', this.handleMarkerDragEnd);
  },

  startDragRangeMove(event, markerId) {
    // Only start move if not clicking on handles
    if (event.target.classList.contains('marker-range-handle')) return;

    event.preventDefault();
    event.stopPropagation();

    const marker = this.markers.find((m) => m.id === markerId);
    if (!marker || marker.type !== 'range') return;

    this.draggingMarker = {
      id: markerId,
      type: 'range-move',
      startX: event.clientX,
      startInTime: marker.inTime,
      startOutTime: marker.outTime,
      duration: marker.outTime - marker.inTime,
    };

    const el = document.querySelector(`.marker-range[data-id="${markerId}"]`);
    if (el) el.classList.add('dragging');

    document.addEventListener('mousemove', this.handleMarkerDrag);
    document.addEventListener('mouseup', this.handleMarkerDragEnd);
  },

  handleMarkerDrag: null, // Will be bound in init
  handleMarkerDragEnd: null, // Will be bound in init

  _handleMarkerDrag(event) {
    if (!this.draggingMarker) return;

    const track = document.getElementById('markersTrack');
    const video = document.getElementById('videoPlayer');
    if (!track || !video || !video.duration) return;

    const rect = track.getBoundingClientRect();
    const trackWidth = rect.width;
    const deltaX = event.clientX - this.draggingMarker.startX;
    const deltaTime = (deltaX / trackWidth) * video.duration;

    const marker = this.markers.find((m) => m.id === this.draggingMarker.id);
    if (!marker) return;

    switch (this.draggingMarker.type) {
      case 'spot':
        marker.time = Math.max(0, Math.min(video.duration, this.draggingMarker.startTime + deltaTime));
        break;

      case 'range-in':
        const newInTime = Math.max(0, Math.min(marker.outTime - 0.1, this.draggingMarker.startTime + deltaTime));
        marker.inTime = newInTime;
        break;

      case 'range-out':
        const newOutTime = Math.max(
          marker.inTime + 0.1,
          Math.min(video.duration, this.draggingMarker.startTime + deltaTime)
        );
        marker.outTime = newOutTime;
        break;

      case 'range-move':
        let newIn = this.draggingMarker.startInTime + deltaTime;
        let newOut = this.draggingMarker.startOutTime + deltaTime;

        // Clamp to video bounds
        if (newIn < 0) {
          newIn = 0;
          newOut = this.draggingMarker.duration;
        }
        if (newOut > video.duration) {
          newOut = video.duration;
          newIn = video.duration - this.draggingMarker.duration;
        }

        marker.inTime = newIn;
        marker.outTime = newOut;
        break;
    }

    // Re-render to update positions
    this.renderMarkers();

    // Re-apply dragging class after re-render
    if (this.draggingMarker.type === 'spot') {
      const el = document.querySelector(`.marker[data-id="${marker.id}"]`);
      if (el) el.classList.add('dragging');
    } else if (this.draggingMarker.type === 'range-in') {
      const el = document.querySelector(`.marker[data-id="${marker.id}-in"]`);
      if (el) el.classList.add('dragging');
    } else if (this.draggingMarker.type === 'range-out') {
      const el = document.querySelector(`.marker[data-id="${marker.id}-out"]`);
      if (el) el.classList.add('dragging');
    } else if (this.draggingMarker.type === 'range-move') {
      const el = document.querySelector(`.marker-range[data-id="${marker.id}"]`);
      if (el) el.classList.add('dragging');
    }
  },

  _handleMarkerDragEnd(event) {
    if (!this.draggingMarker) return;

    // Check if we actually moved
    const deltaX = Math.abs(event.clientX - this.draggingMarker.startX);
    if (deltaX > 5) {
      this.wasDragging = true;
    }

    // Remove dragging classes
    document.querySelectorAll('.marker.dragging, .marker-range.dragging').forEach((el) => {
      el.classList.remove('dragging');
    });

    // Sort markers by time after drag
    this.markers.sort((a, b) => {
      const timeA = a.type === 'range' ? a.inTime : a.time;
      const timeB = b.type === 'range' ? b.inTime : b.time;
      return timeA - timeB;
    });

    this.draggingMarker = null;

    // Remove listeners
    document.removeEventListener('mousemove', this.handleMarkerDrag);
    document.removeEventListener('mouseup', this.handleMarkerDragEnd);

    // Re-render with sorted order
    this.renderMarkers();

    this.showToast('success', 'Marker moved');
  },

  showMarkerContextMenu(event, markerId) {
    const marker = this.markers.find((m) => m.id === markerId);
    if (!marker) return;

    // Store for context menu actions
    this.contextData = { markerId, marker };

    // Determine if this is a range marker (beat) with more options
    const isRange = marker.type === 'range';
    const hasTranscription = marker.transcription && marker.transcription.length > 0;

    // Build context menu items
    const items = [
      { type: 'header', label: marker.name },
      { icon: '▶️', label: 'Go to Beat', action: 'goToMarker' },
      { icon: '✏️', label: 'Edit Beat', action: 'editMarker' },
    ];

    // Add beat-specific actions for range markers
    if (isRange) {
      items.push({ type: 'divider' });
      items.push({ type: 'header', label: 'Content' });
      items.push({
        icon: '🎤',
        label: hasTranscription ? 'Re-transcribe' : 'Transcribe',
        action: 'transcribeBeat',
      });
      items.push({
        icon: '✂️',
        label: 'Extract & Split Range',
        action: 'extractSplitRange',
      });

      items.push({ type: 'divider' });
      items.push({ type: 'header', label: 'Timing Adjustments' });
      items.push({ icon: '🖼️➕', label: 'Stretch Picture', action: 'stretchPicture' });
      items.push({ icon: '🖼️➖', label: 'Shrink Picture', action: 'shrinkPicture' });
      items.push({ icon: '🔊➕', label: 'Stretch Audio', action: 'stretchAudio' });
      items.push({ icon: '🔊➖', label: 'Shrink Audio', action: 'shrinkAudio' });

      items.push({ type: 'divider' });
      items.push({ type: 'header', label: 'AI Generation' });
      items.push({ icon: '🎬', label: 'Insert AI Video', action: 'insertAIVideo' });
      items.push({ icon: '🎙️', label: 'Insert AI Audio', action: 'insertAIAudio' });
      items.push({ icon: '🌍', label: 'Dub to Track...', action: 'dubToTrack' });
      items.push({ type: 'divider' });
      items.push({ icon: '🎵', label: 'Generate Music', action: 'generateMusic' });
      items.push({ icon: '🔊', label: 'Add Sound Effect', action: 'addSoundEffect' });
    }

    items.push({ type: 'divider' });
    items.push({ icon: '🗑️', label: 'Delete Beat', action: 'deleteMarkerCtx', danger: true });

    const menu = document.getElementById('contextMenu');
    const menuItems = document.getElementById('contextMenuItems');
    menu.setAttribute('role', 'menu');

    let html = '';
    for (const item of items) {
      if (item.type === 'divider') {
        html += '<div class="context-menu-divider"></div>';
      } else if (item.type === 'header') {
        html += `<div class="context-menu-header">${item.label}</div>`;
      } else {
        const dangerClass = item.danger ? 'danger' : '';
        html += `
              <div class="context-menu-item ${dangerClass}" role="menuitem" tabindex="0" data-action="${item.action}">
                <span class="context-menu-item-icon">${item.icon}</span>
                <span class="context-menu-item-label">${item.label}</span>
              </div>
            `;
      }
    }

    menuItems.innerHTML = html;

    // Add click handlers
    menuItems.querySelectorAll('.context-menu-item').forEach((item) => {
      item.addEventListener('click', () => {
        const action = item.dataset.action;
        this.executeBeatAction(action, markerId, marker);
        this.hideContextMenu();
      });
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          item.click();
        } else if (e.key === 'Escape') {
          this.hideContextMenu();
        }
      });
    });

    // Position and show menu with smart positioning
    this.positionContextMenu(menu, event.clientX, event.clientY);
    const first = menuItems.querySelector('.context-menu-item:not(.disabled)');
    if (first) first.focus();
  },

  // Show teleprompter/transcript context menu (right-click on toggle button)
  showTeleprompterContextMenu(event) {
    const menu = document.getElementById('contextMenu');
    const menuItems = document.getElementById('contextMenuItems');
    const hasVideo = !!this.videoPath;
    // Check transcriptSegments (raw) or teleprompterWords (expanded)
    const words = this.teleprompterWords || this.transcriptSegments || [];
    const hasTranscription = words.length > 0;
    // Check for speaker data - supports multiple naming conventions
    const wordsWithSpeakers = words.filter((w) => w.speaker || w.speakerId || w.speaker_id);
    const hasSpeakers =
      hasTranscription &&
      (wordsWithSpeakers.length > 0 || (this.transcriptSpeakers && this.transcriptSpeakers.length > 1));

    // Debug logging
    console.log('[ContextMenu] hasTranscription:', hasTranscription, 'words:', words.length);
    console.log('[ContextMenu] transcriptSpeakers:', this.transcriptSpeakers);
    console.log('[ContextMenu] wordsWithSpeakers:', wordsWithSpeakers.length);
    console.log('[ContextMenu] hasSpeakers:', hasSpeakers);
    if (words.length > 0) {
      console.log('[ContextMenu] First word sample:', JSON.stringify(words[0]));
    }

    const items = [
      { type: 'header', label: '📜 Transcript' },
      { icon: '🎤', label: 'Transcribe Video', action: 'transcribeForWaveform', disabled: !hasVideo },
      { icon: '👥', label: 'Identify Speakers', action: 'identifySpeakers', disabled: !hasSpeakers },
      { type: 'divider' },
      { type: 'header', label: 'Sync Adjustment' },
      { type: 'divider' },
      { icon: '👁️', label: 'Show/Hide Transcript', action: 'toggleTeleprompter' },
    ];

    // Build menu HTML
    let html = '';
    for (const item of items) {
      if (item.type === 'divider') {
        html += '<div class="context-menu-divider"></div>';
      } else if (item.type === 'header') {
        html += `<div class="context-menu-header">${item.label}</div>`;
      } else {
        const disabledClass = item.disabled ? 'disabled' : '';
        html += `
              <div class="context-menu-item ${disabledClass}" role="menuitem" tabindex="${item.disabled ? -1 : 0}" data-action="${item.action}">
                <span class="context-menu-item-icon">${item.icon}</span>
                <span class="context-menu-item-label">${item.label}</span>
              </div>
            `;
      }
    }

    menuItems.innerHTML = html;

    // Add click handlers
    menuItems.querySelectorAll('.context-menu-item').forEach((item) => {
      item.addEventListener('click', () => {
        const action = item.dataset.action;
        if (!item.classList.contains('disabled')) {
          this.executeContextAction(action);
        }
        this.hideContextMenu();
      });
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          item.click();
        } else if (e.key === 'Escape') {
          this.hideContextMenu();
        }
      });
    });

    // Position and show menu
    this.positionContextMenu(menu, event.clientX, event.clientY);
    const first = menuItems.querySelector('.context-menu-item:not(.disabled)');
    if (first) first.focus();
  },

  // Execute beat context menu actions
  executeBeatAction(action, markerId, _marker) {
    switch (action) {
      case 'goToMarker':
        this.goToMarker(markerId);
        break;
      case 'editMarker':
        this.editMarker(markerId);
        break;
      case 'deleteMarkerCtx':
        this.deleteMarker(markerId);
        break;
      case 'transcribeBeat':
        this.transcribeBeatSegment(markerId);
        break;
      case 'stretchPicture':
        this.adjustBeatTiming(markerId, 'picture', 'stretch');
        break;
      case 'shrinkPicture':
        this.adjustBeatTiming(markerId, 'picture', 'shrink');
        break;
      case 'stretchAudio':
        this.adjustBeatTiming(markerId, 'audio', 'stretch');
        break;
      case 'shrinkAudio':
        this.adjustBeatTiming(markerId, 'audio', 'shrink');
        break;
      case 'insertAIVideo':
        this.showAIVideoPanel(markerId);
        break;
      case 'insertAIAudio':
        this.showAIAudioPanel(markerId);
        break;
      case 'dubToTrack':
        this.dubRangeToTrack(markerId);
        break;
      case 'extractSplitRange':
        this.extractAndSplitRange(markerId);
        break;
      case 'generateMusic':
        this.showAudioSuggestionModal(markerId, 'music');
        break;
      case 'addSoundEffect':
        this.showAudioSuggestionModal(markerId, 'sfx');
        break;
    }
  },

  // Extract and split a range - creates cuts at both ends and extracts the segment
  async extractAndSplitRange(markerId) {
    const marker = this.markers.find((m) => m.id === markerId);
    if (!marker || marker.type !== 'range') {
      this.showToast('error', 'Please select a range marker');
      return;
    }

    const inTime = marker.inTime;
    const outTime = marker.outTime;
    const duration = outTime - inTime;

    // Show options dialog
    const dialog = document.createElement('div');
    dialog.className = 'modal-backdrop';
    dialog.innerHTML = `
          <div class="modal-content" style="max-width: 400px;">
            <div class="modal-header">
              <h3>✂️ Extract & Split Range</h3>
              <button class="modal-close" onclick="this.closest('.modal-backdrop').remove()">×</button>
            </div>
            <div class="modal-body">
              <p style="margin-bottom: 15px;">
                <strong>${marker.name}</strong><br>
                ${this.formatTime(inTime)} → ${this.formatTime(outTime)} (${this.formatTime(duration)})
              </p>
              
              <div class="form-group" style="margin-bottom: 15px;">
                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                  <input type="checkbox" id="extractSplitCuts" checked>
                  <span>Add cut markers at range boundaries</span>
                </label>
              </div>
              
              <div class="form-group" style="margin-bottom: 15px;">
                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                  <input type="checkbox" id="extractSplitExport" checked>
                  <span>Export range as separate clip</span>
                </label>
              </div>
              
              <div class="form-group" style="margin-bottom: 15px;">
                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                  <input type="checkbox" id="extractSplitRemove">
                  <span>Mark range for removal (ripple delete)</span>
                </label>
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn btn-secondary" onclick="this.closest('.modal-backdrop').remove()">Cancel</button>
              <button class="btn btn-primary" id="extractSplitConfirm">Extract & Split</button>
            </div>
          </div>
        `;
    document.body.appendChild(dialog);

    // Handle confirm
    document.getElementById('extractSplitConfirm').onclick = async () => {
      const addCuts = document.getElementById('extractSplitCuts').checked;
      const exportClip = document.getElementById('extractSplitExport').checked;
      const markForRemoval = document.getElementById('extractSplitRemove').checked;

      dialog.remove();

      try {
        this.showProgress('Processing...', `Extracting range "${marker.name}"`);

        // Step 1: Add cut markers at boundaries
        if (addCuts) {
          // Check if cut markers already exist at these positions
          const tolerance = 0.1; // 100ms tolerance
          const hasInCut = this.cuts.some((c) => Math.abs(c - inTime) < tolerance);
          const hasOutCut = this.cuts.some((c) => Math.abs(c - outTime) < tolerance);

          if (!hasInCut) {
            this.cuts.push(inTime);
            console.log('[Extract] Added cut at in point:', this.formatTime(inTime));
          }
          if (!hasOutCut) {
            this.cuts.push(outTime);
            console.log('[Extract] Added cut at out point:', this.formatTime(outTime));
          }

          // Sort cuts
          this.cuts.sort((a, b) => a - b);
          this.renderCutMarkers();
        }

        // Step 2: Export the segment as a separate clip
        if (exportClip) {
          this.updateProgress(30, 'Extracting video segment...');

          const result = await window.videoEditor.trim(this.videoPath, {
            startTime: inTime,
            endTime: outTime,
          });

          if (result.error) {
            throw new Error(result.error);
          }

          console.log('[Extract] Exported segment to:', result.outputPath);
          this.updateProgress(80, 'Segment exported!');

          // Show the exported file
          if (result.outputPath) {
            await window.videoEditor.revealFile(result.outputPath);
          }
        }

        // Step 3: Mark for removal (add to removed segments)
        if (markForRemoval) {
          // Add to removed segments list (used by edit list)
          if (!this.removedSegments) {
            this.removedSegments = [];
          }
          this.removedSegments.push({
            start: inTime,
            end: outTime,
            reason: `Extracted: ${marker.name}`,
          });

          // Update visual indicator (mark the range as removed)
          marker.removed = true;
          marker.color = '#ff4444'; // Red to indicate removal
          this.renderMarkers();

          console.log('[Extract] Marked range for removal');
        }

        this.hideProgress();

        // Build success message
        let message = `Range "${marker.name}" processed:`;
        if (addCuts) message += ' cuts added';
        if (exportClip) message += ', clip exported';
        if (markForRemoval) message += ', marked for removal';

        this.showToast('success', message);
      } catch (error) {
        console.error('[Extract] Error:', error);
        this.hideProgress();
        this.showToast('error', `Extract failed: ${error.message}`);
      }
    };
  },

  // Transcribe a beat segment
  async transcribeBeatSegment(markerId) {
    const marker = this.markers.find((m) => m.id === markerId);
    if (!marker || marker.type !== 'range') return;

    this.showProgress('Transcribing...', `Transcribing ${marker.name}`);

    try {
      const result = await window.videoEditor.transcribeRange(this.videoPath, {
        startTime: marker.inTime,
        endTime: marker.outTime,
        language: 'en',
      });

      this.hideProgress();

      if (result.error) {
        throw new Error(result.error);
      }

      // Update marker with transcription
      marker.transcription = result.transcription || '';
      this.renderMarkers();

      this.showToast('success', 'Beat transcribed!');

      // Open edit modal to show transcription
      this.editMarker(markerId);
    } catch (error) {
      this.hideProgress();
      this.showToast('error', 'Transcription failed: ' + error.message);
    }
  },

  // Adjust beat timing (stretch/shrink picture or audio)
  adjustBeatTiming(markerId, type, direction) {
    const marker = this.markers.find((m) => m.id === markerId);
    if (!marker || marker.type !== 'range') return;

    const video = document.getElementById('videoPlayer');
    if (!video || !video.duration) return;

    // Calculate adjustment (10% by default)
    const duration = marker.outTime - marker.inTime;
    const adjustment = duration * 0.1;

    if (direction === 'stretch') {
      // Stretch: extend the out time
      marker.outTime = Math.min(video.duration, marker.outTime + adjustment);

      // Store timing adjustment metadata
      if (!marker.timingAdjustments) marker.timingAdjustments = {};
      marker.timingAdjustments[type] = (marker.timingAdjustments[type] || 1.0) * 1.1;

      this.showToast('success', `${type === 'picture' ? 'Picture' : 'Audio'} stretched by 10%`);
    } else {
      // Shrink: reduce the out time (minimum 1 second)
      const newOut = marker.outTime - adjustment;
      if (newOut - marker.inTime >= 1.0) {
        marker.outTime = newOut;

        if (!marker.timingAdjustments) marker.timingAdjustments = {};
        marker.timingAdjustments[type] = (marker.timingAdjustments[type] || 1.0) * 0.9;

        this.showToast('success', `${type === 'picture' ? 'Picture' : 'Audio'} shrunk by 10%`);
      } else {
        this.showToast('warning', 'Cannot shrink further (minimum 1 second)');
        return;
      }
    }

    this.renderMarkers();
  },

  // Show AI Video generation panel for a beat
  showAIVideoPanel(markerId) {
    const marker = this.markers.find((m) => m.id === markerId);
    if (!marker) return;

    // Store context for the panel
    this.aiGenerationContext = { markerId, marker, type: 'video' };

    // Use the existing AI video panel if available, or show a modal
    if (typeof this.openAIVideoPanel === 'function') {
      // Use existing panel
      this.selectedRegion = {
        start: marker.inTime,
        end: marker.outTime,
      };
      this.openAIVideoPanel();
    } else {
      // Fallback: show toast with instructions
      const prompt = `Generate a ${this.formatTime(marker.outTime - marker.inTime)} video segment for: ${marker.name}. ${marker.description || ''}`;
      navigator.clipboard.writeText(prompt);
      this.showToast('info', 'AI Video prompt copied! Use Kling.ai, Runway, or similar to generate, then import.');
    }
  },

  // Show AI Audio generation panel for a beat
  showAIAudioPanel(markerId) {
    const marker = this.markers.find((m) => m.id === markerId);
    if (!marker) return;

    // Store context for the panel
    this.aiGenerationContext = { markerId, marker, type: 'audio' };

    // Use the existing audio sweetening panel if available
    if (typeof this.openAudioSweeteningPanel === 'function') {
      this.selectedRegion = {
        start: marker.inTime,
        end: marker.outTime,
      };
      this.openAudioSweeteningPanel();
    } else {
      // Fallback: show toast with instructions
      const prompt = `Generate audio for: ${marker.name}. Duration: ${this.formatTime(marker.outTime - marker.inTime)}. ${marker.transcription || marker.description || ''}`;
      navigator.clipboard.writeText(prompt);
      this.showToast('info', 'AI Audio prompt copied! Use ElevenLabs or similar to generate, then import.');
    }
  },

  // ==================== AI AUDIO GENERATION (Music & SFX) ====================

  // Show audio suggestion modal for music or sound effects
  async showAudioSuggestionModal(markerId, type = 'music') {
    const marker = this.markers.find((m) => m.id === markerId);
    if (!marker || marker.type !== 'range') {
      this.showToast('error', 'Please select a range marker');
      return;
    }

    const duration = marker.outTime - marker.inTime;
    const durationMs = Math.round(duration * 1000);
    const typeLabel = type === 'music' ? 'Music' : 'Sound Effect';
    const typeIcon = type === 'music' ? '🎵' : '🔊';

    // Create modal
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.id = 'audioSuggestionModal';
    modal.innerHTML = `
          <div class="modal-content" style="max-width: 600px;">
            <div class="modal-header">
              <h3>${typeIcon} Generate ${typeLabel} for "${marker.name}"</h3>
              <button class="modal-close" onclick="this.closest('.modal-backdrop').remove()">×</button>
            </div>
            <div class="modal-body">
              <div style="margin-bottom: 15px; padding: 12px; background: rgba(255,255,255,0.05); border-radius: 8px;">
                <div style="display: flex; gap: 20px; font-size: 13px; color: rgba(255,255,255,0.7);">
                  <span><strong>Duration:</strong> ${this.formatTime(duration)}</span>
                  <span><strong>Description:</strong> ${marker.description || 'No description'}</span>
                </div>
                ${marker.transcription ? `<div style="margin-top: 8px; font-size: 12px; color: rgba(255,255,255,0.5);"><strong>Transcript:</strong> "${marker.transcription.substring(0, 100)}${marker.transcription.length > 100 ? '...' : ''}"</div>` : ''}
              </div>

              <div id="audioSuggestionsContainer" style="margin-bottom: 15px;">
                <div style="text-align: center; padding: 30px; color: rgba(255,255,255,0.5);">
                  <div class="spinner" style="margin: 0 auto 10px;"></div>
                  Analyzing scene and generating suggestions...
                </div>
              </div>

              <div class="form-group" style="margin-bottom: 15px;">
                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                  <input type="checkbox" id="audioInstrumentalOnly" ${type === 'music' ? 'checked' : ''} ${type === 'sfx' ? 'disabled' : ''}>
                  <span>Instrumental only (no vocals)</span>
                </label>
              </div>

              <div class="form-group" style="margin-bottom: 15px;">
                <label style="font-size: 13px; margin-bottom: 5px; display: block;">Custom prompt (optional):</label>
                <textarea id="audioCustomPrompt" rows="2" style="width: 100%; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; padding: 8px; color: white; resize: vertical;" placeholder="Edit or write your own prompt..."></textarea>
              </div>
            </div>
            <div class="modal-footer" style="display: flex; justify-content: space-between; align-items: center;">
              <button class="btn btn-secondary" onclick="this.closest('.modal-backdrop').remove()">Cancel</button>
              <div style="display: flex; gap: 10px;">
                <button class="btn btn-secondary" id="audioPreviewBtn" disabled style="display: none;">Preview</button>
                <button class="btn btn-primary" id="audioGenerateBtn" disabled>
                  <span id="audioGenerateBtnText">Generate ${typeLabel}</span>
                </button>
              </div>
            </div>
          </div>
        `;
    document.body.appendChild(modal);

    // Store context
    this.audioGenerationContext = { markerId, marker, type, durationMs };

    // Fetch suggestions from OpenAI
    await this.fetchAudioSuggestions(marker, type, durationMs);
  },

  // Fetch AI-generated audio suggestions
  async fetchAudioSuggestions(marker, type, _durationMs) {
    const container = document.getElementById('audioSuggestionsContainer');
    if (!container) return;

    try {
      // Get API key from settings
      const apiKey = this.openaiApiKey || localStorage.getItem('openai_api_key');
      if (!apiKey) {
        container.innerHTML = `
              <div style="text-align: center; padding: 20px; color: #ef4444;">
                OpenAI API key required for suggestions.<br>
                <small>Set it in Settings > AI Services</small>
              </div>
              <div class="form-group" style="margin-top: 15px;">
                <label style="font-size: 13px;">Or enter a prompt manually:</label>
              </div>
            `;
        document.getElementById('audioGenerateBtn').disabled = false;
        return;
      }

      // Call backend for suggestions
      const result = await window.videoEditor.getAudioSuggestions({
        marker: {
          name: marker.name,
          description: marker.description || '',
          transcription: marker.transcription || '',
          tags: marker.tags || [],
          duration: marker.outTime - marker.inTime,
        },
        type: type,
        apiKey: apiKey,
      });

      if (!result.success || !result.suggestions || result.suggestions.length === 0) {
        throw new Error(result.error || 'No suggestions returned');
      }

      // Render suggestions
      this.renderAudioSuggestions(result.suggestions, type);
    } catch (error) {
      console.error('[AudioSuggestions] Error:', error);
      container.innerHTML = `
            <div style="text-align: center; padding: 20px; color: #f59e0b;">
              Could not generate suggestions: ${error.message}<br>
              <small>You can still enter a custom prompt below.</small>
            </div>
          `;
      document.getElementById('audioGenerateBtn').disabled = false;
    }
  },

  // Render audio suggestions in the modal
  renderAudioSuggestions(suggestions, type) {
    const container = document.getElementById('audioSuggestionsContainer');
    if (!container) return;

    const typeLabel = type === 'music' ? 'music' : 'sound effect';

    container.innerHTML = `
          <label style="font-size: 13px; margin-bottom: 10px; display: block;">Select a ${typeLabel} style:</label>
          <div class="audio-suggestions-list" style="display: flex; flex-direction: column; gap: 8px;">
            ${suggestions
              .map(
                (s, i) => `
              <label class="audio-suggestion-item" style="display: flex; align-items: flex-start; gap: 10px; padding: 12px; background: rgba(255,255,255,0.05); border: 2px solid transparent; border-radius: 8px; cursor: pointer; transition: all 0.2s;">
                <input type="radio" name="audioSuggestion" value="${i}" style="margin-top: 3px;" ${i === 0 ? 'checked' : ''}>
                <div style="flex: 1;">
                  <div style="font-weight: 500; margin-bottom: 4px;">${s.title || `Option ${i + 1}`}</div>
                  <div style="font-size: 12px; color: rgba(255,255,255,0.6); margin-bottom: 4px;">${s.description || ''}</div>
                  <div style="font-size: 11px; color: rgba(255,255,255,0.4);">
                    ${type === 'music' ? `${s.genre || ''} • ${s.mood || ''} • ${s.tempo || ''}` : `${s.category || ''} • ${s.intensity || ''}`}
                  </div>
                </div>
              </label>
            `
              )
              .join('')}
          </div>
        `;

    // Store suggestions for later use
    this.audioSuggestions = suggestions;

    // Enable generate button
    document.getElementById('audioGenerateBtn').disabled = false;

    // Add selection handlers
    container.querySelectorAll('input[name="audioSuggestion"]').forEach((radio) => {
      radio.addEventListener('change', (e) => {
        const idx = parseInt(e.target.value);
        const suggestion = suggestions[idx];
        if (suggestion) {
          document.getElementById('audioCustomPrompt').value = suggestion.prompt || '';
          // Highlight selected
          container.querySelectorAll('.audio-suggestion-item').forEach((item, itemIdx) => {
            item.style.borderColor = itemIdx === idx ? '#3b82f6' : 'transparent';
            item.style.background = itemIdx === idx ? 'rgba(59, 130, 246, 0.1)' : 'rgba(255,255,255,0.05)';
          });
        }
      });
    });

    // Trigger first selection
    const firstRadio = container.querySelector('input[name="audioSuggestion"]:checked');
    if (firstRadio) {
      firstRadio.dispatchEvent(new Event('change'));
    }

    // Setup generate button
    document.getElementById('audioGenerateBtn').onclick = () => this.generateSelectedAudio();
  },

  // Generate the selected audio
  async generateSelectedAudio() {
    const ctx = this.audioGenerationContext;
    if (!ctx) return;

    const customPrompt = document.getElementById('audioCustomPrompt')?.value?.trim();
    const selectedRadio = document.querySelector('input[name="audioSuggestion"]:checked');
    const selectedIdx = selectedRadio ? parseInt(selectedRadio.value) : 0;
    const suggestion = this.audioSuggestions?.[selectedIdx];

    // Use custom prompt if provided, otherwise use selected suggestion
    const prompt = customPrompt || suggestion?.prompt || '';
    if (!prompt) {
      this.showToast('error', 'Please enter or select a prompt');
      return;
    }

    const instrumental = document.getElementById('audioInstrumentalOnly')?.checked ?? true;
    const btn = document.getElementById('audioGenerateBtn');
    const btnText = document.getElementById('audioGenerateBtnText');

    try {
      btn.disabled = true;
      btnText.textContent = 'Generating...';

      let result;
      if (ctx.type === 'music') {
        result = await window.videoEditor.generateMusic({
          prompt: prompt,
          durationMs: ctx.durationMs,
          instrumental: instrumental,
        });
      } else {
        result = await window.videoEditor.generateSFX({
          prompt: prompt,
          durationSeconds: ctx.durationMs / 1000,
          promptInfluence: 0.7,
        });
      }

      if (!result.success) {
        throw new Error(result.error || 'Generation failed');
      }

      // Success - insert audio into timeline
      this.showToast('success', `${ctx.type === 'music' ? 'Music' : 'Sound effect'} generated!`);

      // Insert the audio at the marker's position
      await this.insertGeneratedAudio(result.audioPath, ctx.marker, ctx.type);

      // Close modal
      document.getElementById('audioSuggestionModal')?.remove();
    } catch (error) {
      console.error('[GenerateAudio] Error:', error);
      this.showToast('error', `Generation failed: ${error.message}`);
      btn.disabled = false;
      btnText.textContent = `Generate ${ctx.type === 'music' ? 'Music' : 'Sound Effect'}`;
    }
  },

  // Insert generated audio into the timeline as a new track
  async insertGeneratedAudio(audioPath, marker, type) {
    const trackName = type === 'music' ? `Music: ${marker.name}` : `SFX: ${marker.name}`;

    // Check if we have the ADR track manager for multi-track support
    if (this.adrManager && typeof this.adrManager.createTrack === 'function') {
      try {
        // Create a new audio track for the generated audio
        const trackId = this.adrManager.createTrack(trackName, { type: type });

        // Add segment to the track
        this.adrManager.addSegment(trackId, {
          start: marker.inTime,
          end: marker.outTime,
          audioPath: audioPath,
          name: marker.name,
          type: type,
        });

        this.showToast('success', `Added to track: ${trackName}`);
        this.renderAudioTracks?.();
        return;
      } catch (e) {
        console.warn('[InsertAudio] ADR manager error:', e);
      }
    }

    // Fallback: Add to audioTracks array if available
    if (this.audioTracks) {
      const newTrack = {
        id: `${type}_${Date.now()}`,
        name: trackName,
        type: type,
        segments: [
          {
            start: marker.inTime,
            end: marker.outTime,
            audioPath: audioPath,
            name: marker.name,
          },
        ],
        volume: 0.8,
        muted: false,
        solo: false,
      };
      this.audioTracks.push(newTrack);
      this.renderAudioTracks?.();
      this.showToast('success', `Added new track: ${trackName}`);
      return;
    }

    // Last resort: just inform user of the file location
    this.showToast('info', `Audio saved to: ${audioPath}`);
  },

  // ==================== DUBBING WORKFLOW ====================

  // Supported dubbing languages
  dubbingLanguages: [
    { code: 'es', name: 'Spanish' },
    { code: 'fr', name: 'French' },
    { code: 'de', name: 'German' },
    { code: 'it', name: 'Italian' },
    { code: 'pt', name: 'Portuguese' },
    { code: 'pl', name: 'Polish' },
    { code: 'ja', name: 'Japanese' },
    { code: 'zh', name: 'Chinese' },
    { code: 'ko', name: 'Korean' },
    { code: 'hi', name: 'Hindi' },
    { code: 'ar', name: 'Arabic' },
    { code: 'ru', name: 'Russian' },
    { code: 'nl', name: 'Dutch' },
    { code: 'tr', name: 'Turkish' },
    { code: 'sv', name: 'Swedish' },
    { code: 'id', name: 'Indonesian' },
    { code: 'fil', name: 'Filipino' },
    { code: 'vi', name: 'Vietnamese' },
    { code: 'uk', name: 'Ukrainian' },
    { code: 'el', name: 'Greek' },
    { code: 'cs', name: 'Czech' },
    { code: 'fi', name: 'Finnish' },
    { code: 'ro', name: 'Romanian' },
    { code: 'da', name: 'Danish' },
    { code: 'bg', name: 'Bulgarian' },
    { code: 'ms', name: 'Malay' },
    { code: 'sk', name: 'Slovak' },
    { code: 'hr', name: 'Croatian' },
    { code: 'ta', name: 'Tamil' },
  ],

  // Show dubbing dialog for a marked range
  async dubRangeToTrack(markerId) {
    const marker = this.markers.find((m) => m.id === markerId);
    if (!marker || marker.type !== 'range') {
      this.showToast('error', 'Please select a range marker for dubbing');
      return;
    }

    console.log('[Dubbing] Starting dub for marker:', marker.name, 'Range:', marker.inTime, '-', marker.outTime);

    // Create language selection dialog
    const dialog = document.createElement('div');
    dialog.className = 'modal-backdrop';
    dialog.id = 'dubbingDialog';
    dialog.innerHTML = `
          <div class="modal" style="max-width: 400px;">
            <div class="modal-header">
              <h3>🌍 Dub Range to Track</h3>
              <button class="modal-close" onclick="document.getElementById('dubbingDialog').remove()">×</button>
            </div>
            <div class="modal-body">
              <p style="margin-bottom: 12px; color: #888;">
                Range: <strong>${marker.name}</strong><br>
                Duration: <strong>${this.formatTime(marker.outTime - marker.inTime)}</strong>
              </p>
              
              <label style="display: block; margin-bottom: 8px; font-weight: 500;">Target Language:</label>
              <select id="dubbingLanguageSelect" class="input" style="width: 100%; padding: 8px; background: #2a2a2a; border: 1px solid #444; border-radius: 6px; color: #fff;">
                ${this.dubbingLanguages.map((lang) => `<option value="${lang.code}">${lang.name}</option>`).join('')}
              </select>
              
              <div style="margin-top: 16px; padding: 12px; background: rgba(59, 130, 246, 0.1); border-radius: 8px; border: 1px solid rgba(59, 130, 246, 0.3);">
                <p style="margin: 0; font-size: 12px; color: #60a5fa;">
                  ℹ️ ElevenLabs Dubbing will translate and voice-match the audio, preserving speaker characteristics.
                </p>
              </div>
            </div>
            <div class="modal-footer" style="display: flex; gap: 8px; justify-content: flex-end;">
              <button class="btn btn-secondary" onclick="document.getElementById('dubbingDialog').remove()">Cancel</button>
              <button class="btn btn-primary" id="startDubbingBtn">
                <span>🎙️ Start Dubbing</span>
              </button>
            </div>
          </div>
        `;

    document.body.appendChild(dialog);

    // Handle start dubbing button
    document.getElementById('startDubbingBtn').onclick = async () => {
      const languageCode = document.getElementById('dubbingLanguageSelect').value;
      const languageName = this.dubbingLanguages.find((l) => l.code === languageCode)?.name || languageCode;

      dialog.remove();

      // Start the dubbing workflow
      await this.executeDubbingWorkflow(marker, languageCode, languageName);
    };
  },

  // Execute the dubbing workflow with progress
  async executeDubbingWorkflow(marker, languageCode, languageName) {
    console.log('[Dubbing] Starting workflow for', marker.name, 'to', languageName);

    // Show progress modal
    const progressModal = this.showDubbingProgress(`Dubbing "${marker.name}" to ${languageName}...`);

    try {
      // Step 1: Extract video segment for the range
      this.updateDubbingProgress(progressModal, 10, 'Extracting video segment...');

      const segmentPath = await this.extractVideoSegment(marker.inTime, marker.outTime);
      console.log('[Dubbing] Extracted segment:', segmentPath);

      // Step 2: Create dubbing project
      this.updateDubbingProgress(progressModal, 20, 'Creating dubbing project...');

      const createResult = await window.videoEditor.createDubbing({
        videoPath: segmentPath,
        targetLanguages: [languageCode],
        sourceLanguage: 'en', // Assume English source
        numSpeakers: 0, // Auto-detect
      });

      if (!createResult.success) {
        throw new Error(createResult.error || 'Failed to create dubbing project');
      }

      const dubbingId = createResult.dubbing_id;
      console.log('[Dubbing] Project created:', dubbingId);

      // Step 3: Poll for completion
      this.updateDubbingProgress(progressModal, 30, 'Processing dubbing (this may take a few minutes)...');

      const pollResult = await this.pollDubbingStatus(dubbingId, progressModal);

      if (pollResult.status !== 'dubbed') {
        throw new Error(`Dubbing failed with status: ${pollResult.status}`);
      }

      console.log('[Dubbing] Dubbing complete!');

      // Step 4: Download dubbed audio
      this.updateDubbingProgress(progressModal, 90, 'Downloading dubbed audio...');

      const downloadResult = await window.videoEditor.downloadDubbedAudio(dubbingId, languageCode);

      if (!downloadResult.success) {
        throw new Error(downloadResult.error || 'Failed to download dubbed audio');
      }

      const dubbedAudioPath = downloadResult.audioPath;
      console.log('[Dubbing] Audio downloaded:', dubbedAudioPath);

      // Step 5: Add to track
      this.updateDubbingProgress(progressModal, 95, 'Adding to track...');

      await this.addDubbedAudioToTrack(dubbedAudioPath, marker, languageName);

      // Done!
      this.updateDubbingProgress(progressModal, 100, 'Complete!');

      setTimeout(() => {
        progressModal.remove();
        this.showToast('success', `✅ Dubbed to ${languageName} and added to track!`);
      }, 500);
    } catch (error) {
      console.error('[Dubbing] Error:', error);
      progressModal.remove();
      this.showToast('error', `Dubbing failed: ${error.message}`);
    }
  },

  // Extract video segment for dubbing
  async extractVideoSegment(startTime, endTime) {
    // Use the trim functionality to extract segment
    const result = await window.videoEditor.trim(this.videoPath, {
      startTime: startTime,
      endTime: endTime,
    });

    if (result.error) {
      throw new Error(result.error || 'Failed to extract video segment');
    }

    return result.outputPath;
  },

  // Poll dubbing status until complete
  async pollDubbingStatus(dubbingId, progressModal) {
    const maxAttempts = 120; // 10 minutes max (5s intervals)
    const pollInterval = 5000; // 5 seconds

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const result = await window.videoEditor.getDubbingStatus(dubbingId);

      if (!result.success) {
        throw new Error(result.error || 'Failed to get dubbing status');
      }

      const status = result.status;
      console.log('[Dubbing] Poll attempt', attempt + 1, '- Status:', status);

      // Update progress (30% to 85% during polling)
      const pollProgress = 30 + Math.min(55, (attempt / maxAttempts) * 60);

      if (status === 'dubbed') {
        return result;
      } else if (status === 'failed' || status === 'error') {
        throw new Error(`Dubbing failed: ${result.error || 'Unknown error'}`);
      }

      // Status is still processing
      const statusMessages = {
        dubbing: 'Generating dubbed audio...',
        transcribing: 'Transcribing original audio...',
        translating: 'Translating to target language...',
        rendering: 'Rendering final audio...',
        processing: 'Processing...',
      };

      const statusMsg = statusMessages[status] || `Status: ${status}...`;
      this.updateDubbingProgress(progressModal, pollProgress, statusMsg);

      // Wait before next poll
      await new Promise((resolve) => {
        setTimeout(resolve, pollInterval);
      });
    }

    throw new Error('Dubbing timed out after 10 minutes');
  },

  // Add dubbed audio to a new or existing dub track
  async addDubbedAudioToTrack(audioPath, marker, languageName) {
    // Find or create a dub track
    let dubTrack = this.audioTracks.find((t) => t.type === 'dub' || t.name?.toLowerCase().includes('dub'));

    if (!dubTrack) {
      // Create a new dub track
      const trackId = `A${this.nextTrackId++}`;
      dubTrack = {
        id: trackId,
        type: 'dub',
        name: 'Dub',
        muted: false,
        solo: false,
        volume: 1.0,
        clips: [],
      };
      this.audioTracks.push(dubTrack);
      this.renderAudioTrack(dubTrack);
      console.log('[Dubbing] Created new Dub track:', trackId);
    }

    // Add clip to the track
    const clip = {
      id: `dub-${Date.now()}`,
      name: `${marker.name} (${languageName})`,
      path: audioPath,
      startTime: marker.inTime,
      endTime: marker.outTime,
      duration: marker.outTime - marker.inTime,
      type: 'dub',
      language: languageName,
      sourceMarkerId: marker.id,
    };

    this.addClipToTrack(dubTrack.id, clip);
    console.log('[Dubbing] Added clip to track:', clip.name);

    // Associate with marker
    marker.dubbedClipId = clip.id;
    marker.dubbedLanguage = languageName;
  },

  // Show dubbing progress modal
  showDubbingProgress(title) {
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.id = 'dubbingProgressModal';
    modal.innerHTML = `
          <div class="modal" style="max-width: 400px;">
            <div class="modal-header">
              <h3>🌍 ${title}</h3>
            </div>
            <div class="modal-body">
              <div class="progress-container" style="margin: 16px 0;">
                <div class="progress-bar" style="width: 100%; height: 8px; background: #333; border-radius: 4px; overflow: hidden;">
                  <div id="dubbingProgressFill" style="width: 0%; height: 100%; background: linear-gradient(90deg, #3b82f6, #8b5cf6); transition: width 0.3s ease;"></div>
                </div>
              </div>
              <p id="dubbingProgressText" style="text-align: center; color: #888; margin: 0;">Starting...</p>
            </div>
          </div>
        `;

    document.body.appendChild(modal);
    return modal;
  },

  // Update dubbing progress
  updateDubbingProgress(modal, percent, message) {
    if (!modal) return;

    const fill = modal.querySelector('#dubbingProgressFill');
    const text = modal.querySelector('#dubbingProgressText');

    if (fill) fill.style.width = `${percent}%`;
    if (text) text.textContent = message;

    console.log('[Dubbing] Progress:', percent + '%', '-', message);
  },

  // Timeline Zoom Functions
  setupTimelineZoom() {
    const wrapper = document.getElementById('timelineScrollWrapper');
    const ruler = document.getElementById('timelineRuler');

    // Sync ruler scroll with timeline scroll
    if (wrapper) {
      wrapper.addEventListener('scroll', () => {
        if (ruler) {
          ruler.scrollLeft = wrapper.scrollLeft;
        }
      });
    }

    // Pinch-to-zoom on timeline (using ctrl+scroll)
    const timeline = document.getElementById('timeline');
    if (timeline) {
      timeline.addEventListener(
        'wheel',
        (e) => {
          // Ctrl/Cmd + scroll = zoom
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            const delta = e.deltaY > 0 ? -0.5 : 0.5;
            this.setZoom(this.timelineZoom + delta);
          }
        },
        { passive: false }
      );
    }
  },

  setZoom(value) {
    const zoom = Math.max(this.minZoom, Math.min(this.maxZoom, parseFloat(value)));
    const oldZoom = this.timelineZoom;
    this.timelineZoom = zoom;
    this.zoom = zoom; // Also set for waveform tier selection

    // Update slider position
    const slider = document.getElementById('zoomSlider');
    if (slider && parseFloat(slider.value) !== zoom) {
      slider.value = zoom;
    }

    // Update zoom level display
    const zoomLevel = document.getElementById('zoomLevel');
    if (zoomLevel) {
      zoomLevel.textContent = zoom >= 10 ? `${Math.round(zoom)}x` : `${zoom.toFixed(1)}x`;
    }

    // Update preset button states
    document.querySelectorAll('.zoom-preset-btn').forEach((btn) => {
      const presetZoom = parseFloat(btn.dataset.zoom);
      btn.classList.toggle('active', Math.abs(presetZoom - zoom) < 0.1);
    });

    // Apply zoom to timeline content
    const content = document.getElementById('timelineContent');
    if (content) {
      content.style.width = 100 * zoom + '%';
    }

    // Update ruler
    this.updateTimelineRuler();

    // Regenerate waveform if zoom tier changed (debounced)
    const oldTier = this.waveformTierDefs.find((t) => oldZoom <= t.maxZoom);
    const newTier = this.waveformTierDefs.find((t) => zoom <= t.maxZoom);
    if (oldTier?.samplesPerSec !== newTier?.samplesPerSec) {
      this.debouncedWaveformRegenerate();
    }

    // Update markers
    this.renderMarkers();

    // Update segments if they exist
    if (this.segments && this.segments.length > 1) {
      this.renderSegments();
    }

    // Always reload thumbnails on zoom (debounced) - they adapt to visible width
    this.debouncedThumbnailReload();

    // Keep playhead centered during zoom
    this.scrollToPlayhead();
  },

  // Debounced thumbnail update - rescales the strip on zoom
  debouncedThumbnailReload() {
    const container = document.getElementById('timelineThumbnails');

    if (container) {
      container.classList.add('zooming');
    }

    clearTimeout(this._thumbnailReloadTimeout);
    this._thumbnailReloadTimeout = setTimeout(() => {
      if (container) {
        container.classList.remove('zooming');
      }

      if (this.thumbnailStrip && this.thumbnailStripDuration) {
        this.applyThumbnailStrip(container, this.thumbnailStripDuration);
      } else {
        this.loadTimelineThumbnails();
      }
    }, 150);
  },

  setZoomPreset(zoom) {
    this.setZoom(zoom);
  },

  zoomIn() {
    this.setZoom(this.timelineZoom + 1);
  },

  zoomOut() {
    this.setZoom(this.timelineZoom - 1);
  },

  fitToView() {
    this.setZoom(1);
    const wrapper = document.getElementById('timelineScrollWrapper');
    if (wrapper) wrapper.scrollLeft = 0;
  },

  scrollToPlayhead() {
    const video = document.getElementById('videoPlayer');
    const wrapper = document.getElementById('timelineScrollWrapper');
    if (!video || !wrapper || !video.duration) return;

    const percent = video.currentTime / video.duration;
    const contentWidth = wrapper.scrollWidth;
    const viewportWidth = wrapper.clientWidth;
    const playheadPosition = percent * contentWidth;

    // Only scroll if playhead is outside visible area
    const scrollLeft = wrapper.scrollLeft;
    const scrollRight = scrollLeft + viewportWidth;

    if (playheadPosition < scrollLeft || playheadPosition > scrollRight) {
      wrapper.scrollLeft = playheadPosition - viewportWidth / 2;
    }
  },

  /**
   * Updates the timeline ruler with smart interval calculation.
   *
   * CRITICAL: This function must be called AFTER video.duration is available
   * (i.e., after the 'loadedmetadata' event via onVideoLoaded()).
   *
   * The ruler marks use percentage positioning (left: X%) which automatically
   * aligns with the rulerMarks element width. All click/seek calculations
   * must use rulerMarks.getBoundingClientRect() to match this coordinate system.
   */
  updateTimelineRuler() {
    const video = document.getElementById('videoPlayer');
    const rulerMarks = document.getElementById('rulerMarks');

    if (!video || !rulerMarks || !video.duration) return;

    const duration = video.duration;
    const zoom = this.timelineZoom;

    // Get actual ruler width to calculate optimal interval
    const ruler = document.getElementById('timelineRuler');
    let rulerWidth = ruler ? ruler.offsetWidth * zoom : 0;

    // Fallback if ruler not yet laid out (first load)
    if (rulerWidth < 100) {
      const viewportWidth = window.innerWidth - 200;
      rulerWidth = Math.max(800, viewportWidth) * zoom;
    }

    // Target: labels should be ~80-150 pixels apart for readability
    const targetLabelSpacing = 100; // pixels between labels
    const numLabelsTarget = Math.max(2, Math.floor(rulerWidth / targetLabelSpacing));
    const idealInterval = duration / numLabelsTarget;

    // Standard intervals in seconds (from smallest to largest)
    const standardIntervals = [
      1, // 1 second
      2, // 2 seconds
      5, // 5 seconds
      10, // 10 seconds
      15, // 15 seconds
      30, // 30 seconds
      60, // 1 minute
      120, // 2 minutes
      300, // 5 minutes
      600, // 10 minutes
      900, // 15 minutes
      1800, // 30 minutes
      3600, // 1 hour
    ];

    // Find the best standard interval (closest to ideal but not smaller)
    let interval = standardIntervals[standardIntervals.length - 1];
    for (const std of standardIntervals) {
      if (std >= idealInterval * 0.7) {
        // Allow slightly smaller for better fit
        interval = std;
        break;
      }
    }

    // Ensure we don't have too many or too few labels
    const numLabels = Math.ceil(duration / interval);
    if (numLabels < 2 && duration > 0) {
      // Very short video or very zoomed out - just show start and end
      interval = duration;
    } else if (numLabels > 50) {
      // Too many labels - increase interval
      const idx = standardIntervals.indexOf(interval);
      if (idx < standardIntervals.length - 1) {
        interval = standardIntervals[idx + 1];
      }
    }

    // Determine minor tick interval (half or quarter of major)
    let minorInterval = interval / 2;
    if (interval >= 60) minorInterval = interval / 4; // More minor ticks for minute+ intervals
    const showMinorTicks = rulerWidth / (duration / minorInterval) > 20; // Only if >20px apart

    let html = '';

    // Generate marks
    for (let time = 0; time <= duration; time += minorInterval) {
      const percent = (time / duration) * 100;
      const isMajor = Math.abs(time % interval) < 0.001 || Math.abs((time % interval) - interval) < 0.001;

      if (isMajor) {
        const label = this.formatTime(time);
        html += `
              <div class="ruler-mark" style="left: ${percent}%;">
                <span class="ruler-mark-label">${label}</span>
                <div class="ruler-mark-line major"></div>
              </div>
            `;
      } else if (showMinorTicks) {
        html += `
              <div class="ruler-mark" style="left: ${percent}%;">
                <div class="ruler-mark-line minor"></div>
              </div>
            `;
      }
    }

    // Always show end time if not already shown
    const lastMajorTime = Math.floor(duration / interval) * interval;
    if (duration - lastMajorTime > interval * 0.1) {
      const endPercent = 100;
      html += `
            <div class="ruler-mark" style="left: ${endPercent}%;">
              <span class="ruler-mark-label">${this.formatTime(duration)}</span>
              <div class="ruler-mark-line major"></div>
            </div>
          `;
    }

    rulerMarks.innerHTML = html;

    // Scale the ruler container (ruler already defined above)
    if (ruler) {
      ruler.style.width = `calc(100% - 108px)`;
      ruler.style.overflow = 'hidden';
      rulerMarks.style.width = 100 * zoom + '%';
    }
  },

  // ========== Web Audio API Scrubbing ==========

  // Initialize Web Audio context
  async initAudioContext() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this.audioGain = this.audioContext.createGain();
      this.audioGain.connect(this.audioContext.destination);
    }
    // Resume if suspended (browser autoplay policy)
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
  },

  // Load audio for scrubbing - checks if already loaded by waveform generation
  async loadScrubAudio(_videoPath) {
    // Skip if already loaded (waveform generation already decoded the audio)
    if (this.isAudioLoaded && this.audioBuffer) {
      console.log('[Scrub] Audio already loaded from waveform, skipping duplicate decode');
      return;
    }

    const video = document.getElementById('videoPlayer');
    if (!video || !video.src) return;

    try {
      console.log('[Scrub] Loading audio from video for Web Audio scrubbing...');

      // Initialize audio context
      await this.initAudioContext();

      // Fetch the video file and decode audio
      const response = await fetch(video.src);
      if (!response.ok) {
        throw new Error('Failed to fetch video: ' + response.status);
      }

      const arrayBuffer = await response.arrayBuffer();
      this.audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);

      this.isAudioLoaded = true;
      console.log(
        '[Scrub] Audio loaded! Duration:',
        this.audioBuffer.duration.toFixed(2),
        's, Sample rate:',
        this.audioBuffer.sampleRate
      );
      this.showToast('success', 'Audio scrubbing ready');
    } catch (err) {
      console.error('[Scrub] Failed to load audio:', err);
      this.isAudioLoaded = false;
    }
  },

  // Play audio from a specific position using Web Audio API
  playScrubAudio(startTime, duration = 0.15, playbackRate = 1.0) {
    if (!this.audioBuffer || !this.audioContext) {
      console.log('[Scrub] playScrubAudio - No audio buffer or context:', {
        hasBuffer: !!this.audioBuffer,
        hasContext: !!this.audioContext,
      });
      return;
    }

    // Resume context if suspended (browser autoplay policy)
    if (this.audioContext.state === 'suspended') {
      console.log('[Scrub] Resuming suspended audio context');
      this.audioContext.resume();
    }

    // Stop any currently playing scrub audio
    this.stopScrubAudio();

    try {
      // Create a new source node (they're one-shot, can't be reused)
      this.audioSource = this.audioContext.createBufferSource();
      this.audioSource.buffer = this.audioBuffer;
      this.audioSource.playbackRate.value = playbackRate;

      // Connect through gain node (ensure volume is up)
      this.audioGain.gain.value = 1.0;
      this.audioSource.connect(this.audioGain);

      // Clamp start time to valid range
      const safeStart = Math.max(0, Math.min(startTime, this.audioBuffer.duration - 0.01));
      const safeDuration = Math.min(duration, this.audioBuffer.duration - safeStart);

      console.log(
        '[Scrub] Playing audio:',
        safeStart.toFixed(2) + 's',
        'duration:',
        safeDuration.toFixed(2) + 's',
        'context state:',
        this.audioContext.state
      );

      // Start playback from position
      this.audioSource.start(0, safeStart, safeDuration);
    } catch (err) {
      console.warn('[Scrub] Audio play error:', err);
    }
  },

  // Stop scrub audio
  stopScrubAudio() {
    if (this.audioSource) {
      try {
        this.audioSource.stop();
      } catch (_e) {
        // Already stopped
      }
      this.audioSource = null;
    }
  },

  // Scroll wheel video scrubbing with Web Audio
  setupScrollScrub() {
    const videoContainer = document.getElementById('videoContainer');
    const timeline = document.getElementById('timeline');

    // Scrub state
    this.lastScrubTime = 0;
    this.scrubAccumulator = 0;

    const handleScroll = (e) => {
      if (!this.videoPath) return;

      const video = document.getElementById('videoPlayer');
      if (!video || !video.duration) return;

      e.preventDefault();

      // Initialize audio context on first interaction (browser policy)
      if (!this.audioContext) {
        this.initAudioContext();
      }

      // Calculate time step based on scroll intensity
      // Smaller = finer control, larger = faster scrubbing
      const scrollIntensity = Math.abs(e.deltaY);
      let timeStep = 0.05; // 50ms default step

      if (e.altKey) {
        timeStep = 0.02; // Fine: 20ms (hear individual sounds)
      } else if (e.shiftKey) {
        timeStep = 0.2; // Fast: 200ms
      } else if (scrollIntensity > 50) {
        timeStep = 0.1; // Faster scrolling = bigger steps
      }

      // Direction: negative deltaY = scroll up = forward
      const direction = e.deltaY < 0 ? 1 : -1;
      const newTime = Math.max(0, Math.min(video.duration, video.currentTime + timeStep * direction));

      // Update video position
      video.currentTime = newTime;
      this.updateTimeDisplay(); // This now handles playhead positioning correctly

      // Play audio snippet at new position using Web Audio API
      if (this.isAudioLoaded) {
        // Use word-aligned if transcript available, otherwise fixed snippets
        if (this.transcriptSegments && this.transcriptSegments.length > 0) {
          this.playWordAtTime(newTime);
        } else {
          const snippetDuration = e.altKey ? 0.25 : 0.15;
          console.log('[Scrub] Playing snippet at', newTime.toFixed(2));
          this.playScrubAudio(newTime, snippetDuration, 1.0);
        }
      } else {
        console.log('[Scrub] Audio not loaded - isAudioLoaded:', this.isAudioLoaded);
      }
    };

    // Add scroll listeners to video and timeline
    if (videoContainer) {
      videoContainer.addEventListener('wheel', handleScroll, { passive: false });
    }
    if (timeline) {
      timeline.addEventListener('wheel', handleScroll, { passive: false });
    }
  },

  // Context Menu Setup
  setupContextMenu() {
    const menu = document.getElementById('contextMenu');

    // Hide menu on click outside
    document.addEventListener(
      'click',
      (e) => {
        const containsMenu = !!(menu && menu.contains(e.target));
        const closestMenu = !!e?.target?.closest?.('#contextMenu') || !!e?.target?.closest?.('.context-menu');
        const shortcutsPanel = document.getElementById('shortcutsPanel');
        const inShortcuts = shortcutsPanel && shortcutsPanel.contains(e.target);
        if (containsMenu || closestMenu || inShortcuts) return;
        this.hideContextMenu();
        this.hideShortcutsPanel();
      },
      true
    );
    document.addEventListener('contextmenu', (e) => this.handleContextMenu(e));

    // Global keyboard shortcuts - Loupedeck compatible
    document.addEventListener('keydown', (e) => this.handleGlobalShortcut(e));
  },

  // Centralized keyboard shortcut handler - works globally for Loupedeck
  handleGlobalShortcut(e) {
    // Don't handle shortcuts when typing in inputs (unless it's a function key or Escape)
    const isInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable;
    const isFunctionKey = e.key.startsWith('F') && e.key.length <= 3;
    const isEscape = e.key === 'Escape';

    // Always allow Escape
    if (isEscape) {
      this.hideContextMenu();
      this.hideShortcutsPanel();
      this.closeMarkerModal();
      return;
    }

    // Allow function keys even in inputs for Loupedeck
    if (isInput && !isFunctionKey) return;

    const hasVideo = !!this.videoPath;
    const video = document.getElementById('videoPlayer');

    // Build modifier string
    const mods = [];
    if (e.metaKey) mods.push('Cmd');
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');

    // Get the key name
    let keyName = e.key;

    // Normalize numpad keys
    if (e.code.startsWith('Numpad')) {
      keyName = e.code; // Use 'Numpad0', 'Numpad+', etc.
    }

    // Build full shortcut string for lookup
    const shortcutKey = mods.length > 0 ? `${mods.join('+')}+${keyName}` : keyName;
    const shortcutKeyLower = mods.length > 0 ? `${mods.join('+')}+${keyName.toLowerCase()}` : keyName.toLowerCase();

    // Look up in registry
    const shortcut =
      this.keyboardShortcuts[shortcutKey] ||
      this.keyboardShortcuts[shortcutKeyLower] ||
      this.keyboardShortcuts[keyName];

    if (shortcut) {
      e.preventDefault();
      this.executeGlobalAction(shortcut.action, hasVideo, video);
      return;
    }

    // Fallback for common shortcuts not in registry
    if (hasVideo && video) {
      switch (e.key) {
        case ' ':
          e.preventDefault();
          this.togglePlay();
          return;
        case 'ArrowLeft':
          e.preventDefault();
          if (e.shiftKey) {
            this.skipBack();
          } else {
            video.currentTime = Math.max(0, video.currentTime - 1);
          }
          return;
        case 'ArrowRight':
          e.preventDefault();
          if (e.shiftKey) {
            this.skipForward();
          } else {
            video.currentTime = Math.min(video.duration, video.currentTime + 1);
          }
          return;
        case 'Home':
          e.preventDefault();
          video.currentTime = 0;
          return;
        case 'End':
          e.preventDefault();
          video.currentTime = video.duration;
          return;
      }
    }
  },

  // Execute action from global shortcut - Loupedeck compatible
  executeGlobalAction(action, hasVideo, video) {
    const actions = {
      // Playback
      togglePlay: () => hasVideo && this.togglePlay(),
      skipBack: () => hasVideo && this.skipBack(),
      skipForward: () => hasVideo && this.skipForward(),
      stepBack: () => hasVideo && video && (video.currentTime = Math.max(0, video.currentTime - 1)),
      stepForward: () => hasVideo && video && (video.currentTime = Math.min(video.duration, video.currentTime + 1)),
      goToStart: () => hasVideo && video && (video.currentTime = 0),
      goToEnd: () => hasVideo && video && (video.currentTime = video.duration),
      toggleMute: () => hasVideo && this.toggleMute(),
      slowDown: () => hasVideo && this.setSpeedPreset(Math.max(0.25, this.currentSpeed - 0.25)),
      speedUp: () => hasVideo && this.setSpeedPreset(Math.min(4, this.currentSpeed + 0.25)),
      speedNormal: () => hasVideo && this.setSpeedPreset(1),

      // Speed presets (number keys)
      setSpeed025: () => hasVideo && this.setSpeedPreset(0.25),
      setSpeed05: () => hasVideo && this.setSpeedPreset(0.5),
      setSpeed075: () => hasVideo && this.setSpeedPreset(0.75),
      setSpeed1: () => hasVideo && this.setSpeedPreset(1),
      setSpeed125: () => hasVideo && this.setSpeedPreset(1.25),
      setSpeed15: () => hasVideo && this.setSpeedPreset(1.5),
      setSpeed175: () => hasVideo && this.setSpeedPreset(1.75),
      setSpeed2: () => hasVideo && this.setSpeedPreset(2),
      setSpeed3: () => hasVideo && this.setSpeedPreset(3),

      // Editing
      undo: () => this.undo(),
      redo: () => this.redo(),
      setTrimStart: () => hasVideo && this.setTrimStart(),
      setTrimEnd: () => hasVideo && this.setTrimEnd(),
      markRangeIn: () => hasVideo && this.markRangeIn(),
      markRangeOut: () => hasVideo && this.markRangeOut(),
      setSpliceStart: () => hasVideo && this.setSpliceStart(),
      setSpliceEnd: () => hasVideo && this.setSpliceEnd(),
      sliceAtPlayhead: () => hasVideo && this.sliceAtPlayhead(),
      cutHead: () => hasVideo && this.cutHead(),
      cutTail: () => hasVideo && this.cutTail(),
      deleteSelection: () => hasVideo && this.deleteSelectedSegment(),
      trimVideo: () => hasVideo && this.trimVideo(),
      spliceVideo: () => hasVideo && this.spliceVideo(),

      // Markers
      addMarkerAtPlayhead: () => hasVideo && this.addMarkerAtPlayhead(),
      goToPrevMarker: () => hasVideo && this.goToPrevMarker(),
      goToNextMarker: () => hasVideo && this.goToNextMarker(),
      clearAllMarkers: () => hasVideo && this.clearAllMarkers(),

      // Timeline
      zoomIn: () => this.zoomIn(),
      zoomOut: () => this.zoomOut(),
      fitToView: () => this.fitToView(),
      toggleAudioScrub: () => hasVideo && this.toggleAudioScrub(),
      splitClipAtPlayhead: () => hasVideo && this.splitMasterClipAtPlayhead(),

      // Numpad jumps
      jumpTo10Percent: () => hasVideo && video && (video.currentTime = video.duration * 0.1),
      jumpTo20Percent: () => hasVideo && video && (video.currentTime = video.duration * 0.2),
      jumpTo30Percent: () => hasVideo && video && (video.currentTime = video.duration * 0.3),
      jumpTo40Percent: () => hasVideo && video && (video.currentTime = video.duration * 0.4),
      jumpTo50Percent: () => hasVideo && video && (video.currentTime = video.duration * 0.5),
      jumpTo60Percent: () => hasVideo && video && (video.currentTime = video.duration * 0.6),
      jumpTo70Percent: () => hasVideo && video && (video.currentTime = video.duration * 0.7),
      jumpTo80Percent: () => hasVideo && video && (video.currentTime = video.duration * 0.8),
      jumpTo90Percent: () => hasVideo && video && (video.currentTime = video.duration * 0.9),

      // Effects
      fadeIn: () => hasVideo && this.addFadeIn(),
      fadeOut: () => hasVideo && this.addFadeOut(),

      // View
      toggleTeleprompter: () => hasVideo && this.toggleTeleprompter(),
      toggleFullscreen: () => hasVideo && this.toggleFullscreen(),
      showShortcutsPanel: () => this.toggleShortcutsPanel(),
      closeAll: () => {
        this.hideContextMenu();
        this.hideShortcutsPanel();
      },
      switchToEditMode: () => this.setMode('edit'),
      switchToAnnotateMode: () => this.setMode('annotate'),
      switchToBeatsLayout: () => this.switchLayout('beats'),

      // File
      openFile: () => this.openFile(),
      showExportOptions: () => hasVideo && this.showExportOptions(),
      saveToSpace: () => hasVideo && this.saveToSpace(),

      // Audio
      toggleAudioMute: () => hasVideo && this.toggleAudioMute(),
      detachAudio: () => hasVideo && this.detachAudio(),
      extractAudio: () => hasVideo && this.extractAudio(),

      // Tools
      transcribeVideo: () => hasVideo && this.transcribeForWaveform(),
      captureFrame: () => hasVideo && this.captureCurrentFrame(),
      togglePIP: () => hasVideo && this.togglePictureInPicture(),

      // ElevenLabs AI
      generateAIVoice: () => {
        return hasVideo && this.showGenerateAIVoiceDialog();
      },
      speechToSpeech: () => hasVideo && this.showSpeechToSpeechDialog(),
      isolateVocals: () => hasVideo && this.isolateVocalsAction(),
      cloneVoice: () => hasVideo && this.showCloneVoiceDialog(),
      generateSFX: () => {
        return this.showGenerateSFXDialog();
      },
      dubRegion: () => hasVideo && this.showDubRegionDialog(),
      dubEntireVideo: () => hasVideo && this.showDubVideoDialog(),
      addSFXAtPlayhead: () => this.showGenerateSFXDialog(),
      showUsageStats: () => this.showElevenLabsUsageStats(),
    };

    if (actions[action]) {
      actions[action]();
    } else {
      console.warn('[Shortcut] Unknown action:', action);
    }
  },

  // Show keyboard shortcuts panel - Loupedeck friendly
  showShortcutsPanel() {
    const panel = document.getElementById('shortcutsPanel');
    const content = document.getElementById('shortcutsPanelContent');

    // Build shortcuts by category, grouping alternate keys
    const categories = {};
    const actionKeys = {}; // Track all keys for each action

    for (const [key, info] of Object.entries(this.keyboardShortcuts)) {
      const actionId = `${info.category}:${info.label}`;
      if (!actionKeys[actionId]) {
        actionKeys[actionId] = { ...info, keys: [] };
      }
      actionKeys[actionId].keys.push(key);
    }

    // Group by category
    for (const [_actionId, info] of Object.entries(actionKeys)) {
      if (!categories[info.category]) {
        categories[info.category] = [];
      }
      categories[info.category].push(info);
    }

    let html = `
          <div style="padding: 8px; margin-bottom: 8px; background: rgba(139, 92, 246, 0.1); border-radius: 6px; border: 1px solid rgba(139, 92, 246, 0.2);">
            <div style="font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.9); margin-bottom: 4px;">🎛️ Loupedeck Ready</div>
            <div style="font-size: 10px; color: rgba(255,255,255,0.6);">Function keys (F1-F12) and numpad keys can be assigned to Loupedeck buttons.</div>
          </div>
        `;

    const order = [
      'Playback',
      'Editing',
      'Markers',
      'Effects',
      'Timeline',
      'Audio',
      'ElevenLabs',
      'Tools',
      'View',
      'File',
    ];

    for (const cat of order) {
      if (!categories[cat]) continue;
      html += `<div class="shortcuts-group">
            <div class="shortcuts-group-title">${cat}</div>`;

      for (const shortcut of categories[cat]) {
        // Format keys - show primary and function key alternate
        const formattedKeys = shortcut.keys.map((k) => this.formatShortcutKey(k));
        const primaryKey = formattedKeys[0];
        const altKeys = formattedKeys.slice(1).filter((k) => k.startsWith('F') || k.includes('Num'));

        html += `<div class="shortcut-row">
              <span class="shortcut-action">${shortcut.label}</span>
              <div class="shortcut-keys">
                <span class="shortcut-key">${primaryKey}</span>
                ${altKeys.length > 0 ? `<span class="shortcut-key" style="background: rgba(139, 92, 246, 0.15); color: rgba(167, 139, 250, 0.9);">${altKeys[0]}</span>` : ''}
              </div>
            </div>`;
      }
      html += '</div>';
    }

    content.innerHTML = html;
    panel.classList.add('visible');
  },

  hideShortcutsPanel() {
    const panel = document.getElementById('shortcutsPanel');
    if (panel) panel.classList.remove('visible');
  },

  toggleShortcutsPanel() {
    const panel = document.getElementById('shortcutsPanel');
    if (panel && panel.classList.contains('visible')) {
      this.hideShortcutsPanel();
    } else {
      this.showShortcutsPanel();
    }
  },

  // Format shortcut key for display
  formatShortcutKey(key) {
    return key
      .replace('Cmd+', '⌘')
      .replace('Ctrl+', '⌃')
      .replace('Shift+', '⇧')
      .replace('Alt+', '⌥')
      .replace('ArrowLeft', '←')
      .replace('ArrowRight', '→')
      .replace('ArrowUp', '↑')
      .replace('ArrowDown', '↓')
      .replace('Delete', '⌫')
      .replace('Backspace', '⌫')
      .replace('Escape', 'Esc')
      .replace(' ', '␣')
      .replace('Numpad', 'Num')
      .replace('NumpadAdd', 'Num+')
      .replace('NumpadSubtract', 'Num-');
  },

  // Global keyboard shortcuts registry - Loupedeck compatible
  // All shortcuts work globally regardless of focus/context
  keyboardShortcuts: {
    // ═══════════════════════════════════════════════════════════════
    // PLAYBACK - Transport controls
    // ═══════════════════════════════════════════════════════════════
    ' ': { action: 'togglePlay', label: 'Play / Pause', category: 'Playback' },
    k: { action: 'togglePlay', label: 'Play / Pause', category: 'Playback' },
    F5: { action: 'togglePlay', label: 'Play / Pause', category: 'Playback' },

    ArrowLeft: { action: 'stepBack', label: 'Step Back 1s', category: 'Playback' },
    'Shift+ArrowLeft': { action: 'skipBack', label: 'Skip Back 10s', category: 'Playback' },
    F1: { action: 'skipBack', label: 'Skip Back 10s', category: 'Playback' },

    ArrowRight: { action: 'stepForward', label: 'Step Forward 1s', category: 'Playback' },
    'Shift+ArrowRight': { action: 'skipForward', label: 'Skip Forward 10s', category: 'Playback' },
    F2: { action: 'skipForward', label: 'Skip Forward 10s', category: 'Playback' },

    j: { action: 'slowDown', label: 'Decrease Speed', category: 'Playback' },
    F3: { action: 'slowDown', label: 'Decrease Speed', category: 'Playback' },

    l: { action: 'speedUp', label: 'Increase Speed', category: 'Playback' },
    F4: { action: 'speedUp', label: 'Increase Speed', category: 'Playback' },

    'Shift+k': { action: 'speedNormal', label: 'Normal Speed (1x)', category: 'Playback' },
    'Shift+F5': { action: 'speedNormal', label: 'Normal Speed (1x)', category: 'Playback' },

    Home: { action: 'goToStart', label: 'Go to Start', category: 'Playback' },
    End: { action: 'goToEnd', label: 'Go to End', category: 'Playback' },

    m: { action: 'toggleMute', label: 'Toggle Mute', category: 'Playback' },
    F9: { action: 'toggleMute', label: 'Toggle Mute', category: 'Playback' },

    // ═══════════════════════════════════════════════════════════════
    // EDITING - Cut, trim, splice
    // ═══════════════════════════════════════════════════════════════
    i: { action: 'setTrimStart', label: 'Set In Point', category: 'Editing' },
    F6: { action: 'setTrimStart', label: 'Set In Point', category: 'Editing' },

    o: { action: 'setTrimEnd', label: 'Set Out Point', category: 'Editing' },
    F7: { action: 'setTrimEnd', label: 'Set Out Point', category: 'Editing' },

    'Shift+i': { action: 'markRangeIn', label: 'Mark Range In', category: 'Editing' },
    'Shift+F6': { action: 'markRangeIn', label: 'Mark Range In', category: 'Editing' },

    'Shift+o': { action: 'markRangeOut', label: 'Mark Range Out', category: 'Editing' },
    'Shift+F7': { action: 'markRangeOut', label: 'Mark Range Out', category: 'Editing' },

    '[': { action: 'setSpliceStart', label: 'Set Splice Start', category: 'Editing' },
    ']': { action: 'setSpliceEnd', label: 'Set Splice End', category: 'Editing' },

    c: { action: 'sliceAtPlayhead', label: 'Cut / Slice', category: 'Editing' },
    F8: { action: 'sliceAtPlayhead', label: 'Cut / Slice', category: 'Editing' },

    q: { action: 'cutHead', label: 'Trim Head (Ripple Delete Start)', category: 'Editing' },
    'Shift+F1': { action: 'cutHead', label: 'Trim Head', category: 'Editing' },

    w: { action: 'cutTail', label: 'Trim Tail (Ripple Delete End)', category: 'Editing' },
    'Shift+F2': { action: 'cutTail', label: 'Trim Tail', category: 'Editing' },

    Delete: { action: 'deleteSelection', label: 'Delete Selection', category: 'Editing' },
    Backspace: { action: 'deleteSelection', label: 'Delete Selection', category: 'Editing' },

    x: { action: 'trimVideo', label: 'Apply Trim', category: 'Editing' },
    'Shift+x': { action: 'spliceVideo', label: 'Apply Splice', category: 'Editing' },

    'Cmd+z': { action: 'undo', label: 'Undo', category: 'Editing' },
    'Ctrl+z': { action: 'undo', label: 'Undo', category: 'Editing' },
    'Cmd+Shift+z': { action: 'redo', label: 'Redo', category: 'Editing' },
    'Ctrl+Shift+z': { action: 'redo', label: 'Redo', category: 'Editing' },
    'Ctrl+y': { action: 'redo', label: 'Redo', category: 'Editing' },

    // ═══════════════════════════════════════════════════════════════
    // MARKERS - Story beats and navigation
    // ═══════════════════════════════════════════════════════════════
    n: { action: 'addMarkerAtPlayhead', label: 'Add Marker', category: 'Markers' },
    F10: { action: 'addMarkerAtPlayhead', label: 'Add Marker', category: 'Markers' },

    ',': { action: 'goToPrevMarker', label: 'Previous Marker', category: 'Markers' },
    F11: { action: 'goToPrevMarker', label: 'Previous Marker', category: 'Markers' },

    '.': { action: 'goToNextMarker', label: 'Next Marker', category: 'Markers' },
    F12: { action: 'goToNextMarker', label: 'Next Marker', category: 'Markers' },

    'Shift+n': { action: 'markRangeIn', label: 'Start Range Marker', category: 'Markers' },
    'Shift+F10': { action: 'clearAllMarkers', label: 'Clear All Markers', category: 'Markers' },

    // ═══════════════════════════════════════════════════════════════
    // TIMELINE - Zoom and view
    // ═══════════════════════════════════════════════════════════════
    '=': { action: 'zoomIn', label: 'Zoom In', category: 'Timeline' },
    '+': { action: 'zoomIn', label: 'Zoom In', category: 'Timeline' },
    'Numpad+': { action: 'zoomIn', label: 'Zoom In', category: 'Timeline' },

    '-': { action: 'zoomOut', label: 'Zoom Out', category: 'Timeline' },
    _: { action: 'zoomOut', label: 'Zoom Out', category: 'Timeline' },
    'Numpad-': { action: 'zoomOut', label: 'Zoom Out', category: 'Timeline' },

    0: { action: 'fitToView', label: 'Fit to View', category: 'Timeline' },
    Numpad0: { action: 'fitToView', label: 'Fit to View', category: 'Timeline' },

    s: { action: 'splitClipAtPlayhead', label: 'Split Clip at Playhead', category: 'Audio Editing' },
    'Shift+s': { action: 'toggleAudioScrub', label: 'Toggle Audio Scrub', category: 'Timeline' },

    // Numpad for quick time jumps
    Numpad1: { action: 'jumpTo10Percent', label: 'Jump to 10%', category: 'Timeline' },
    Numpad2: { action: 'jumpTo20Percent', label: 'Jump to 20%', category: 'Timeline' },
    Numpad3: { action: 'jumpTo30Percent', label: 'Jump to 30%', category: 'Timeline' },
    Numpad4: { action: 'jumpTo40Percent', label: 'Jump to 40%', category: 'Timeline' },
    Numpad5: { action: 'jumpTo50Percent', label: 'Jump to 50%', category: 'Timeline' },
    Numpad6: { action: 'jumpTo60Percent', label: 'Jump to 60%', category: 'Timeline' },
    Numpad7: { action: 'jumpTo70Percent', label: 'Jump to 70%', category: 'Timeline' },
    Numpad8: { action: 'jumpTo80Percent', label: 'Jump to 80%', category: 'Timeline' },
    Numpad9: { action: 'jumpTo90Percent', label: 'Jump to 90%', category: 'Timeline' },

    // ═══════════════════════════════════════════════════════════════
    // EFFECTS - Fades and speed
    // ═══════════════════════════════════════════════════════════════
    'Alt+f': { action: 'fadeIn', label: 'Add/Remove Fade In', category: 'Effects' },
    'Alt+g': { action: 'fadeOut', label: 'Add/Remove Fade Out', category: 'Effects' },

    1: { action: 'setSpeed025', label: 'Speed 0.25x', category: 'Effects' },
    2: { action: 'setSpeed05', label: 'Speed 0.5x', category: 'Effects' },
    3: { action: 'setSpeed075', label: 'Speed 0.75x', category: 'Effects' },
    4: { action: 'setSpeed1', label: 'Speed 1x (Normal)', category: 'Effects' },
    5: { action: 'setSpeed125', label: 'Speed 1.25x', category: 'Effects' },
    6: { action: 'setSpeed15', label: 'Speed 1.5x', category: 'Effects' },
    7: { action: 'setSpeed175', label: 'Speed 1.75x', category: 'Effects' },
    8: { action: 'setSpeed2', label: 'Speed 2x', category: 'Effects' },
    9: { action: 'setSpeed3', label: 'Speed 3x', category: 'Effects' },

    // ═══════════════════════════════════════════════════════════════
    // VIEW - Panels and display
    // ═══════════════════════════════════════════════════════════════
    t: { action: 'toggleTeleprompter', label: 'Toggle Transcript', category: 'View' },
    f: { action: 'toggleFullscreen', label: 'Toggle Fullscreen', category: 'View' },
    '?': { action: 'showShortcutsPanel', label: 'Show Shortcuts', category: 'View' },
    Escape: { action: 'closeAll', label: 'Close Panels/Menus', category: 'View' },

    'Alt+1': { action: 'switchToEditMode', label: 'Edit Mode', category: 'View' },
    'Alt+2': { action: 'switchToAnnotateMode', label: 'Annotate Mode', category: 'View' },
    'Alt+3': { action: 'switchToBeatsLayout', label: 'Story Beats View', category: 'View' },

    // ═══════════════════════════════════════════════════════════════
    // FILE - Open, save, export
    // ═══════════════════════════════════════════════════════════════
    'Cmd+o': { action: 'openFile', label: 'Open File', category: 'File' },
    'Ctrl+o': { action: 'openFile', label: 'Open File', category: 'File' },

    'Cmd+e': { action: 'showExportOptions', label: 'Export', category: 'File' },
    'Ctrl+e': { action: 'showExportOptions', label: 'Export', category: 'File' },

    'Cmd+s': { action: 'saveToSpace', label: 'Save to Space', category: 'File' },
    'Ctrl+s': { action: 'saveToSpace', label: 'Save to Space', category: 'File' },

    // ═══════════════════════════════════════════════════════════════
    // AUDIO - Audio track controls
    // ═══════════════════════════════════════════════════════════════
    'Alt+m': { action: 'toggleAudioMute', label: 'Mute Audio Track', category: 'Audio' },
    'Alt+d': { action: 'detachAudio', label: 'Detach Audio', category: 'Audio' },
    'Alt+e': { action: 'extractAudio', label: 'Extract Audio to MP3', category: 'Audio' },

    // ═══════════════════════════════════════════════════════════════
    // TOOLS - Quick tools
    // ═══════════════════════════════════════════════════════════════
    'Alt+t': { action: 'transcribeVideo', label: 'Transcribe Video', category: 'Tools' },
    'Alt+c': { action: 'captureFrame', label: 'Capture Frame', category: 'Tools' },
    'Alt+p': { action: 'togglePIP', label: 'Picture in Picture', category: 'Tools' },

    // ═══════════════════════════════════════════════════════════════
    // ELEVENLABS AI - Voice & Audio AI Features
    // ═══════════════════════════════════════════════════════════════
    'Alt+v': { action: 'generateAIVoice', label: 'Generate AI Voice', category: 'ElevenLabs' },
    'Shift+F3': { action: 'generateAIVoice', label: 'Generate AI Voice', category: 'ElevenLabs' },

    'Alt+r': { action: 'speechToSpeech', label: 'Transform Voice (STS)', category: 'ElevenLabs' },
    'Shift+F5': { action: 'speechToSpeech', label: 'Transform Voice', category: 'ElevenLabs' },

    'Alt+i': { action: 'isolateVocals', label: 'Isolate Vocals', category: 'ElevenLabs' },
    'Shift+F4': { action: 'isolateVocals', label: 'Isolate Vocals', category: 'ElevenLabs' },

    'Alt+k': { action: 'cloneVoice', label: 'Clone Voice', category: 'ElevenLabs' },
    'Shift+F8': { action: 'cloneVoice', label: 'Clone Voice', category: 'ElevenLabs' },

    'Alt+b': { action: 'dubRegion', label: 'Dub Selected Region', category: 'ElevenLabs' },
    'Shift+F9': { action: 'dubRegion', label: 'Dub Region', category: 'ElevenLabs' },

    'Alt+x': { action: 'generateSFX', label: 'Generate Sound Effect', category: 'ElevenLabs' },
    'Shift+F11': { action: 'generateSFX', label: 'Generate SFX', category: 'ElevenLabs' },

    'Alt+Shift+b': { action: 'dubEntireVideo', label: 'Dub Entire Video', category: 'ElevenLabs' },

    'Alt+s': { action: 'addSFXAtPlayhead', label: 'Add SFX at Playhead', category: 'ElevenLabs' },

    'Alt+u': { action: 'showUsageStats', label: 'Show ElevenLabs Usage', category: 'ElevenLabs' },
  },

  // Context menu definitions for different areas
  getContextMenuItems(context, _contextData = {}) {
    const hasVideo = !!this.videoPath;
    const video = document.getElementById('videoPlayer');
    const isPlaying = video && !video.paused;
    const isMuted = video && video.muted;
    const menus = {
      // ═══════════════════════════════════════════════
      // VIDEO TRACK - Video editing options
      // ═══════════════════════════════════════════════
      videoTrack: [
        { type: 'header', label: 'Edit' },
        { icon: '✂', label: 'Cut at Playhead', action: 'sliceAtPlayhead', shortcut: 'C' },
        { icon: '◀', label: 'Trim Head', action: 'cutHead', shortcut: 'Q' },
        { icon: '▶', label: 'Trim Tail', action: 'cutTail', shortcut: 'W' },
        { type: 'divider' },
        { type: 'header', label: 'Effects' },
        { icon: '↗', label: this.fades.fadeIn ? '− Fade In' : '+ Fade In', action: 'fadeIn' },
        { icon: '↘', label: this.fades.fadeOut ? '− Fade Out' : '+ Fade Out', action: 'fadeOut' },
        { type: 'divider' },
        { type: 'header', label: 'Speed' },
        { icon: '½', label: '0.5× Slow', action: 'speedSlow', shortcut: 'J' },
        { icon: '1', label: '1× Normal', action: 'speedNormal', shortcut: '⇧K' },
        { icon: '2', label: '2× Fast', action: 'speedFast', shortcut: 'L' },
        { type: 'divider' },
        { type: 'header', label: 'AI' },
        { icon: '✦', label: 'AI Video Replace', action: 'insertAIVideoAtPlayhead' },
        { icon: '🌐', label: 'Dub to Language...', action: 'dubEntireVideo', shortcut: '⌥⇧B' },
        { icon: '⊡', label: 'Capture Frame', action: 'captureFrame' },
        { type: 'divider' },
        { icon: '↺', label: 'Reset Edits', action: 'resetAllEdits', danger: true },
      ],

      // ═══════════════════════════════════════════════
      // AUDIO TRACK - Audio editing options
      // ═══════════════════════════════════════════════
      audioTrack: [
        { type: 'header', label: 'Track' },
        { icon: '📋', label: 'Duplicate Track', action: 'duplicateTrack', shortcut: '⌘D' },
        {
          icon: this.audioMuted ? '◉' : '○',
          label: this.audioMuted ? 'Unmute' : 'Mute',
          action: 'toggleAudioMute',
          shortcut: 'M',
        },
        { icon: '⊘', label: 'Detach Audio', action: 'detachAudio', disabled: this.audioDetached },
        { type: 'divider' },
        { type: 'header', label: 'Volume' },
        { icon: '▬', label: 'Normalize', action: 'normalizeAudio' },
        { icon: '−', label: 'Reduce −6dB', action: 'reduceVolume' },
        { icon: '+', label: 'Boost +6dB', action: 'boostVolume' },
        { type: 'divider' },
        { type: 'header', label: 'Effects' },
        { icon: '↗', label: 'Fade In', action: 'audioFadeIn' },
        { icon: '↘', label: 'Fade Out', action: 'audioFadeOut' },
        { icon: '⌀', label: 'Silence Region', action: 'silenceSection' },
        { type: 'divider' },
        { type: 'header', label: 'ElevenLabs AI' },
        { icon: '🎙', label: 'Generate AI Voice', action: 'generateAIVoice', shortcut: '⌥V' },
        { icon: '🔄', label: 'Transform Voice', action: 'speechToSpeech', shortcut: '⌥R' },
        { icon: '🎚', label: 'Isolate Vocals', action: 'isolateVocals', shortcut: '⌥I' },
        { icon: '👤', label: 'Clone Voice', action: 'cloneVoice', shortcut: '⌥K' },
        { icon: '🔊', label: 'Generate SFX', action: 'generateSFX', shortcut: '⌥X' },
        { type: 'divider' },
        { icon: '♪', label: 'Add Music', action: 'addBackgroundMusic' },
        { icon: '◎', label: 'Add SFX', action: 'addSoundEffect' },
        { type: 'divider' },
        { icon: '↓', label: 'Extract MP3', action: 'extractAudio' },
      ],

      // ═══════════════════════════════════════════════
      // MARKERS TRACK - Story beats options
      // ═══════════════════════════════════════════════
      markersTrack: [
        { type: 'header', label: 'Create' },
        { icon: '+', label: 'Add Marker', action: 'addSpotMarker', shortcut: 'N' },
        { icon: '⟷', label: 'Create Range', action: 'createRangeBeat', shortcut: '⇧I/O' },
        { type: 'divider' },
        { type: 'header', label: 'Navigate' },
        { icon: '◀', label: 'Prev Marker', action: 'prevMarker', shortcut: ',', disabled: this.markers.length === 0 },
        { icon: '▶', label: 'Next Marker', action: 'nextMarker', shortcut: '.', disabled: this.markers.length === 0 },
        { type: 'divider' },
        { type: 'header', label: 'AI' },
        { icon: '🔊', label: 'Add SFX Here', action: 'addSFXAtPlayhead', shortcut: '⌥S' },
        { icon: '🎙', label: 'Dub Region', action: 'dubRegion', shortcut: '⌥B' },
        { type: 'divider' },
        { icon: '⋯', label: `All (${this.markers.length})`, action: 'showBeatsList' },
        { icon: '×', label: 'Clear All', action: 'clearAllBeats', danger: true, disabled: this.markers.length === 0 },
      ],

      // ═══════════════════════════════════════════════
      // TELEPROMPTER - Transcript controls
      // ═══════════════════════════════════════════════
      teleprompter: [
        { type: 'header', label: 'Transcript' },
        { icon: '◉', label: 'Transcribe', action: 'transcribeForWaveform', disabled: !hasVideo },
        { type: 'divider' },
        { icon: '×', label: 'Hide', action: 'toggleTeleprompter', shortcut: 'T' },
      ],

      // ═══════════════════════════════════════════════
      // VIDEO PLAYER - Playback controls
      // ═══════════════════════════════════════════════
      video: [
        { type: 'header', label: 'Playback' },
        {
          icon: isPlaying ? '⏸' : '▶',
          label: isPlaying ? 'Pause' : 'Play',
          action: 'togglePlay',
          shortcut: 'Space',
          disabled: !hasVideo,
        },
        { icon: '◀◀', label: 'Back 10s', action: 'skipBack', shortcut: '⇧←', disabled: !hasVideo },
        { icon: '▶▶', label: 'Forward 10s', action: 'skipForward', shortcut: '⇧→', disabled: !hasVideo },
        { type: 'divider' },
        {
          icon: isMuted ? '🔇' : '🔊',
          label: isMuted ? 'Unmute' : 'Mute',
          action: 'toggleMute',
          shortcut: 'M',
          disabled: !hasVideo,
        },
        { type: 'divider' },
        { icon: '⊡', label: 'Capture Frame', action: 'captureFrame', disabled: !hasVideo },
        { icon: '⧉', label: 'PiP Mode', action: 'togglePIP', disabled: !hasVideo },
        { icon: '⛶', label: 'Fullscreen', action: 'toggleFullscreen', shortcut: 'F', disabled: !hasVideo },
      ],

      // ═══════════════════════════════════════════════
      // TIMELINE - Zoom and navigation
      // ═══════════════════════════════════════════════
      timeline: [
        { type: 'header', label: 'View' },
        { icon: '+', label: 'Zoom In', action: 'zoomIn', shortcut: '+' },
        { icon: '−', label: 'Zoom Out', action: 'zoomOut', shortcut: '−' },
        { icon: '◻', label: 'Fit View', action: 'fitToView', shortcut: '0' },
        { type: 'divider' },
        { type: 'header', label: 'Trim' },
        { icon: '[', label: 'Set In', action: 'setTrimStart', shortcut: 'I' },
        { icon: ']', label: 'Set Out', action: 'setTrimEnd', shortcut: 'O' },
        { icon: '↺', label: 'Reset', action: 'resetTrim' },
      ],

      // Export item context
      export: [
        { icon: '▶', label: 'Load', action: 'loadExport' },
        { icon: '⬔', label: 'Reveal', action: 'revealExport' },
        { type: 'divider' },
        { icon: '×', label: 'Delete', action: 'deleteExport', danger: true },
      ],

      // Default/generic context
      default: [
        { icon: '⬆', label: 'Open Video', action: 'openFile', shortcut: '⌘O' },
        { icon: '↓', label: 'Export', action: 'showExportOptions', shortcut: '⌘E', disabled: !hasVideo },
        { type: 'divider' },
        { icon: '⌨', label: 'Shortcuts', action: 'showShortcutsPanel', shortcut: '?' },
      ],
    };

    return menus[context] || menus['default'];
  },

  handleContextMenu(e) {
    // Determine context based on clicked element
    const target = e.target;
    let context = 'default';
    let contextData = {};

    const video = document.getElementById('videoPlayer');
    const hasVideo = !!this.videoPath;

    // Get time at click position for timeline areas
    // CRITICAL: Must use rulerMarks for coordinate calculations to match ruler display
    const getTimeAtClick = (_trackEl) => {
      if (!video || !video.duration) return null;
      const rulerMarks = document.getElementById('rulerMarks');
      if (!rulerMarks) return null;
      const rulerRect = rulerMarks.getBoundingClientRect();
      const percent = (e.clientX - rulerRect.left) / rulerRect.width;
      return Math.max(0, Math.min(video.duration, percent * video.duration));
    };

    // ═══════════════════════════════════════════════
    // DETECT CONTEXT AREA
    // ═══════════════════════════════════════════════

    // Empty State - Video Placeholder (no video loaded)
    if (
      !hasVideo &&
      (target.closest('#videoPlaceholder') || target.closest('.video-placeholder') || target.closest('.drop-zone'))
    ) {
      // Show spaces menu
      this.showSpacesContextMenu(e.clientX, e.clientY);
      e.preventDefault();
      return;
    }

    // Teleprompter / Transcript area
    if (target.closest('#teleprompterContainer') || target.closest('.teleprompter-container')) {
      context = 'teleprompter';
      contextData.time = video?.currentTime || 0;
    }

    // Video Player
    else if (target.closest('#videoPlayer') || target.closest('#videoContainer')) {
      context = 'video';
      contextData.time = video?.currentTime || 0;
    }

    // Video Track / Video Clip
    else if (
      target.closest('#videoClip') ||
      target.closest('.timeline-clip:not(.audio)') ||
      (target.closest('#timelineTrack') && !target.closest('.audio-track'))
    ) {
      context = 'videoTrack';
      this.selectClip('video');
      const track = target.closest('#timelineTrack') || target.closest('.timeline-track');
      contextData.time = getTimeAtClick(track) || video?.currentTime || 0;

      // Seek to clicked position for better context
      if (video && contextData.time !== null) {
        video.currentTime = contextData.time;
      }
    }

    // Track Label - Try TrackContextMenu first, fall back to audioTrack menu
    else if (
      target.closest('.track-label') &&
      (target.closest('#audioTrackContainer') || target.closest('.audio-track'))
    ) {
      // Get the track ID from the parent container
      const trackContainer = target.closest('#audioTrackContainer') || target.closest('.audio-track');
      const trackId = trackContainer?.dataset?.trackId || 'A1';

      // Try to use TrackContextMenu if available and it can find the track
      if (this.trackContextMenu && this.adrManager?.findTrack(trackId)) {
        // TrackContextMenu will handle it via its own event listener
        // Just return here to let it work
        return;
      }

      // Fallback: Show audioTrack context menu
      context = 'audioTrack';
      contextData.trackId = trackId;
    }

    // Audio Track (waveform area, not track labels)
    else if (
      target.closest('#audioTrack') ||
      target.closest('#audioTrackContainer') ||
      target.closest('.audio-track') ||
      target.closest('.timeline-clip.audio')
    ) {
      context = 'audioTrack';
      const track = target.closest('#audioTrack') || target.closest('.audio-track');
      contextData.time = getTimeAtClick(track) || video?.currentTime || 0;

      // Seek to clicked position
      if (video && contextData.time !== null) {
        video.currentTime = contextData.time;
      }
    }

    // Markers Track - handled by its own handler, but fallback here
    else if (target.closest('#markersTrack') || target.closest('.markers-track')) {
      context = 'markersTrack';
      const track = document.getElementById('markersTrack');
      contextData.time = getTimeAtClick(track) || video?.currentTime || 0;
      contextData.spliceTime = contextData.time;
    }

    // Timeline general area (ruler, etc)
    else if (target.closest('#timeline') || target.closest('.timeline')) {
      context = 'timeline';
    }

    // Export items
    else if (target.closest('.export-item')) {
      context = 'export';
      contextData.path = target.closest('.export-item').dataset?.path;
    }

    // Store context data for actions
    this.contextData = contextData;

    // Show the appropriate menu
    this.showContextMenu(e.clientX, e.clientY, context);
    e.preventDefault();
  },

  showContextMenu(x, y, context) {
    const menu = document.getElementById('contextMenu');
    const menuItems = document.getElementById('contextMenuItems');
    const items = this.getContextMenuItems(context);
    menu.setAttribute('role', 'menu');

    // Build menu HTML
    let html = '';
    for (const item of items) {
      if (item.type === 'divider') {
        html += '<div class="context-menu-divider"></div>';
      } else if (item.type === 'header') {
        html += `<div class="context-menu-header">${item.label}</div>`;
      } else {
        const disabledClass = item.disabled ? 'disabled' : '';
        const dangerClass = item.danger ? 'danger' : '';
        html += `
              <div class="context-menu-item ${disabledClass} ${dangerClass}" role="menuitem" tabindex="${item.disabled ? -1 : 0}" data-action="${item.action}">
                <span class="context-menu-item-icon">${item.icon}</span>
                <span class="context-menu-item-label">${item.label}</span>
                ${item.shortcut ? `<span class="context-menu-item-shortcut">${item.shortcut}</span>` : ''}
              </div>
            `;
      }
    }

    menuItems.innerHTML = html;

    // Add click handlers
    menuItems.querySelectorAll('.context-menu-item').forEach((item) => {
      item.addEventListener('click', (_e) => {
        const action = item.dataset.action;
        if (action && !item.classList.contains('disabled')) {
          this.executeContextAction(action);
        }
        this.hideContextMenu();
      });
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          item.click();
        } else if (e.key === 'Escape') {
          this.hideContextMenu();
        }
      });
    });

    // Position and show menu with smart positioning
    this.positionContextMenu(menu, x, y);
    const first = menuItems.querySelector('.context-menu-item:not(.disabled)');
    if (first) first.focus();
  },

  // Smart positioning for the context menu - ensures never cut off by screen edges
  positionContextMenu(menu, x, y) {
    const minMargin = 12; // Minimum distance from screen edges
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Reset any previous inline constraints (CSS handles defaults)
    menu.style.maxHeight = '';
    menu.style.maxWidth = '';

    // Show off-screen to measure natural size
    menu.style.left = '-9999px';
    menu.style.top = '-9999px';
    menu.classList.add('visible');

    // Force layout recalc and get menu dimensions
    const rect = menu.getBoundingClientRect();
    let mw = rect.width;
    let mh = rect.height;

    // Ensure minimum menu width for readability
    if (mw < 180) mw = 200;

    // Calculate usable viewport area (with margins)
    const usableWidth = vw - minMargin * 2;
    // If menu is wider than usable width, constrain it
    if (mw > usableWidth) {
      menu.style.maxWidth = `${usableWidth}px`;
      mw = usableWidth;
    }

    // Calculate available space in each direction from click point
    const spaceRight = vw - x - minMargin;
    const spaceLeft = x - minMargin;
    const spaceBelow = vh - y - minMargin;
    const spaceAbove = y - minMargin;

    let finalX, finalY;
    let originX = 'left',
      originY = 'top';

    // HORIZONTAL POSITIONING
    // Priority: 1) Show to right of cursor, 2) Show to left of cursor, 3) Fit in viewport
    if (mw <= spaceRight) {
      finalX = x;
      originX = 'left';
    } else if (mw <= spaceLeft) {
      finalX = x - mw;
      originX = 'right';
    } else {
      // Not enough space either side - center or fit where possible
      finalX = Math.max(minMargin, Math.min(x, vw - mw - minMargin));
      originX = 'center';
    }

    // VERTICAL POSITIONING
    // Priority: 1) Show below cursor, 2) Show above cursor, 3) Constrain with scroll
    let constrainedHeight = mh;

    if (mh <= spaceBelow) {
      // Enough space below - show there
      finalY = y;
      originY = 'top';
    } else if (mh <= spaceAbove) {
      // Enough space above - flip to above
      finalY = y - mh;
      originY = 'bottom';
    } else {
      // Menu taller than available space - must constrain height
      // Choose direction with most space
      if (spaceBelow >= spaceAbove) {
        // More space below - show there with constrained height
        constrainedHeight = Math.max(150, spaceBelow - 10); // Leave small gap
        finalY = y;
        originY = 'top';
      } else {
        // More space above - show there with constrained height
        constrainedHeight = Math.max(150, spaceAbove - 10);
        finalY = minMargin; // Start from top margin
        originY = 'bottom';
      }

      // Apply constrained height
      menu.style.maxHeight = `${constrainedHeight}px`;
      mh = constrainedHeight;
    }

    // FINAL CLAMPING - absolutely ensure menu stays within viewport
    finalX = Math.max(minMargin, Math.min(finalX, vw - mw - minMargin));
    finalY = Math.max(minMargin, Math.min(finalY, vh - mh - minMargin));

    // Set transform origin for animation direction
    menu.style.transformOrigin = `${originX} ${originY}`;

    // Apply final position
    menu.style.left = `${Math.round(finalX)}px`;
    menu.style.top = `${Math.round(finalY)}px`;

    // Debug logging
    console.log('[ContextMenu] Position:', {
      click: { x, y },
      final: { x: Math.round(finalX), y: Math.round(finalY) },
      menu: { w: Math.round(mw), h: Math.round(mh), constrained: constrainedHeight !== rect.height },
      viewport: { w: vw, h: vh },
      space: { below: Math.round(spaceBelow), above: Math.round(spaceAbove) },
    });
  },

  // Spaces context menu for empty state
  async showSpacesContextMenu(x, y) {
    const menu = document.getElementById('contextMenu');
    const menuItems = document.getElementById('contextMenuItems');

    // Store original click position for repositioning after content loads
    this._menuClickPos = { x, y };

    // Show loading state
    menuItems.innerHTML = `
          <div class="context-menu-header">📁 Your Spaces</div>
          <div class="context-menu-item disabled">
            <span class="context-menu-item-icon">⏳</span>
            <span class="context-menu-item-label">Loading spaces...</span>
          </div>
        `;

    this.positionContextMenu(menu, x, y);

    try {
      // Fetch spaces
      if (!window.spaces) {
        menuItems.innerHTML = `
              <div class="context-menu-header">📁 Open Video</div>
              <div class="context-menu-item" data-action="openFile">
                <span class="context-menu-item-icon">📂</span>
                <span class="context-menu-item-label">Choose from Computer...</span>
              </div>
              <div class="context-menu-divider"></div>
              <div class="context-menu-item disabled">
                <span class="context-menu-item-icon">⚠️</span>
                <span class="context-menu-item-label">Spaces not available</span>
              </div>
            `;
        this.addSpacesMenuHandlers(menuItems);
        // Reposition after content change
        this.positionContextMenu(menu, x, y);
        return;
      }

      const spaces = await window.spaces.getAll();

      let html = `
            <div class="context-menu-header">📁 Open Video</div>
            <div class="context-menu-item" data-action="openFile">
              <span class="context-menu-item-icon">💻</span>
              <span class="context-menu-item-label">From Computer...</span>
            </div>
            <div class="context-menu-divider"></div>
            <div class="context-menu-header">☁️ From Space</div>
          `;

      if (!spaces || spaces.length === 0) {
        html += `
              <div class="context-menu-item disabled">
                <span class="context-menu-item-icon">📭</span>
                <span class="context-menu-item-label">No spaces found</span>
              </div>
            `;
      } else {
        // Show spaces as expandable items
        spaces.forEach((space) => {
          html += `
                <div class="context-menu-item space-menu-item" data-space-id="${space.id}" data-space-name="${space.name}">
                  <span class="context-menu-item-icon">📁</span>
                  <span class="context-menu-item-label">${space.name}</span>
                  <span class="context-menu-item-shortcut">${space.itemCount || 0} items →</span>
                </div>
              `;
        });
      }

      menuItems.innerHTML = html;
      this.addSpacesMenuHandlers(menuItems);

      // CRITICAL: Reposition menu after content loads (menu is now taller)
      this.positionContextMenu(menu, x, y);
    } catch (error) {
      console.error('Error loading spaces for context menu:', error);
      menuItems.innerHTML = `
            <div class="context-menu-header">📁 Open Video</div>
            <div class="context-menu-item" data-action="openFile">
              <span class="context-menu-item-icon">📂</span>
              <span class="context-menu-item-label">Choose from Computer...</span>
            </div>
            <div class="context-menu-divider"></div>
            <div class="context-menu-item disabled">
              <span class="context-menu-item-icon">❌</span>
              <span class="context-menu-item-label">Error loading spaces</span>
            </div>
          `;
      this.addSpacesMenuHandlers(menuItems);
      // Reposition after content change
      this.positionContextMenu(menu, x, y);
    }
  },

  // Add click handlers for spaces menu
  addSpacesMenuHandlers(menuItems) {
    // Open file action
    menuItems.querySelectorAll('[data-action="openFile"]').forEach((item) => {
      item.addEventListener('click', () => {
        this.hideContextMenu();
        this.openFile();
      });
    });

    // Space items - load videos from space
    const spaceEls = menuItems.querySelectorAll('.space-menu-item');
    spaceEls.forEach((item) => {
      item.addEventListener('click', async () => {
        const spaceId = item.dataset.spaceId;
        const spaceName = item.dataset.spaceName;
        await this.showSpaceVideosMenu(spaceId, spaceName);
      });
    });
  },

  // Show projects from a space in the context menu
  async showSpaceVideosMenu(spaceId, spaceName) {
    const menu = document.getElementById('contextMenu');
    const menuItems = document.getElementById('contextMenuItems');

    // Store for later use
    this._currentSpaceId = spaceId;
    this._currentSpaceName = spaceName;

    // Get current menu position for repositioning
    const menuRect = menu.getBoundingClientRect();
    const menuX = this._menuClickPos?.x || menuRect.left;
    const menuY = this._menuClickPos?.y || menuRect.top;

    // Show loading
    menuItems.innerHTML = `
          <div class="context-menu-header">📁 ${spaceName}</div>
          <div class="context-menu-item" data-action="backToSpaces">
            <span class="context-menu-item-icon">←</span>
            <span class="context-menu-item-label">Back to Spaces</span>
          </div>
          <div class="context-menu-divider"></div>
          <div class="context-menu-item disabled">
            <span class="context-menu-item-icon">⏳</span>
            <span class="context-menu-item-label">Loading projects...</span>
          </div>
        `;

    try {
      // Load projects for this space
      const projects = await window.projectAPI.getProjectsBySpace(spaceId);
      console.log('[showSpaceVideosMenu] Projects for space', spaceId, ':', projects);

      let html = `
            <div class="context-menu-header">📁 ${spaceName}</div>
            <div class="context-menu-item" data-action="backToSpaces">
              <span class="context-menu-item-icon">←</span>
              <span class="context-menu-item-label">Back to Spaces</span>
            </div>
            <div class="context-menu-divider"></div>
            <div class="context-menu-item" data-action="createProject">
              <span class="context-menu-item-icon">➕</span>
              <span class="context-menu-item-label">Create New Project</span>
            </div>
          `;

      if (projects && projects.length > 0) {
        html += `<div class="context-menu-divider"></div>`;
        projects.forEach((project) => {
          const versionCount = project.versions?.length || 0;
          const assetCount = project.assets?.length || 0;
          html += `
                <div class="context-menu-item project-menu-item" data-project-id="${project.id}" data-project-name="${this.escapeHtml(project.name)}">
                  <span class="context-menu-item-icon">🎬</span>
                  <span class="context-menu-item-label">${this.escapeHtml(project.name)}</span>
                  <span class="context-menu-item-shortcut">${versionCount}v ${assetCount}a</span>
                  <button class="context-menu-delete-btn" data-project-id="${project.id}" title="Delete project">🗑️</button>
                </div>
              `;
        });
      } else {
        html += `
              <div class="context-menu-divider"></div>
              <div class="context-menu-item disabled">
                <span class="context-menu-item-icon">📭</span>
                <span class="context-menu-item-label">No projects yet</span>
              </div>
            `;
      }

      menuItems.innerHTML = html;

      // Back button handler
      menuItems.querySelectorAll('[data-action="backToSpaces"]').forEach((item) => {
        item.addEventListener('click', async () => {
          const rect = menu.getBoundingClientRect();
          await this.showSpacesContextMenu(rect.left, rect.top);
        });
      });

      // Create project handler
      menuItems.querySelectorAll('[data-action="createProject"]').forEach((item) => {
        item.addEventListener('click', () => {
          this.hideContextMenu();
          this.showCreateProjectModal();
        });
      });

      // Project item handlers (click to open)
      menuItems.querySelectorAll('.project-menu-item').forEach((item) => {
        item.addEventListener('click', (e) => {
          // Don't open if clicking the delete button
          if (e.target.classList.contains('context-menu-delete-btn')) return;
          const projectId = item.dataset.projectId;
          this.hideContextMenu();
          this.openProject(projectId);
        });
      });

      // Delete button handlers in context menu
      menuItems.querySelectorAll('.context-menu-delete-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const projectId = btn.dataset.projectId;
          this.hideContextMenu();
          await this.deleteProject(projectId);
        });
      });

      // CRITICAL: Reposition menu after content loads
      this.positionContextMenu(menu, menuX, menuY);
    } catch (error) {
      console.error('Error loading space projects:', error);
      menuItems.innerHTML = `
            <div class="context-menu-header">📁 ${spaceName}</div>
            <div class="context-menu-item" data-action="backToSpaces">
              <span class="context-menu-item-icon">←</span>
              <span class="context-menu-item-label">Back to Spaces</span>
            </div>
            <div class="context-menu-divider"></div>
            <div class="context-menu-item" data-action="createProject">
              <span class="context-menu-item-icon">➕</span>
              <span class="context-menu-item-label">Create New Project</span>
            </div>
            <div class="context-menu-divider"></div>
            <div class="context-menu-item disabled">
              <span class="context-menu-item-icon">❌</span>
              <span class="context-menu-item-label">Error loading projects</span>
            </div>
          `;

      menuItems.querySelectorAll('[data-action="backToSpaces"]').forEach((item) => {
        item.addEventListener('click', async () => {
          const rect = menu.getBoundingClientRect();
          await this.showSpacesContextMenu(rect.left, rect.top);
        });
      });

      menuItems.querySelectorAll('[data-action="createProject"]').forEach((item) => {
        item.addEventListener('click', () => {
          this.hideContextMenu();
          this.showCreateProjectModal();
        });
      });

      // Reposition after error content
      this.positionContextMenu(menu, menuX, menuY);
    }
  },

  hideContextMenu() {
    const menu = document.getElementById('contextMenu');
    menu.classList.remove('visible');
  },

  executeContextAction(action) {
    const actions = {
      // ─── Playback ───
      togglePlay: () => this.togglePlay(),
      skipBack: () => this.skipBack(),
      skipForward: () => this.skipForward(),
      toggleMute: () => this.toggleMute(),
      togglePIP: () => this.togglePictureInPicture(),
      toggleFullscreen: () => this.toggleFullscreen(),

      // ─── Trim/Edit ───
      setTrimStart: () => this.setTrimStart(),
      setTrimEnd: () => this.setTrimEnd(),
      setSpliceStart: () => this.setSpliceStart(),
      setSpliceEnd: () => this.setSpliceEnd(),
      resetTrim: () => this.resetTrimPoints(),
      sliceAtPlayhead: () => this.sliceAtPlayhead(),
      cutHead: () => this.cutHead(),
      cutTail: () => this.cutTail(),
      trimHead: () => this.trimHeadAtPlayhead(),
      trimTail: () => this.trimTailAtPlayhead(),
      resetAllEdits: () => this.resetAllEdits(),
      deleteSelection: () => this.deleteSelectedSegment(),

      // ─── Video Effects ───
      fadeIn: () => this.addFadeIn(),
      fadeOut: () => this.addFadeOut(),
      speedSlow: () => this.setPlaybackSpeed(0.5),
      speedFast: () => this.setPlaybackSpeed(2.0),
      speedNormal: () => this.setPlaybackSpeed(1.0),

      // ─── Audio ───
      duplicateTrack: () => {
        // Try to use ADR manager's duplicate function
        const trackId = this.contextData?.trackId || 'A1';
        if (this.adrManager && typeof this.adrManager.duplicateTrack === 'function') {
          this.adrManager.duplicateTrack(trackId);
        } else {
          this.showToast('info', 'Track duplication coming soon');
        }
      },
      toggleAudioMute: () => this.toggleAudioMute(),
      detachAudio: () => this.detachAudio(),
      extractAudio: () => this.extractAudio(),
      normalizeAudio: () => this.showToast('info', 'Audio normalization coming soon'),
      reduceVolume: () => this.adjustVolume(-0.2),
      boostVolume: () => this.adjustVolume(0.2),
      audioFadeIn: () => this.showToast('info', 'Audio fade in coming soon'),
      audioFadeOut: () => this.showToast('info', 'Audio fade out coming soon'),
      silenceSection: () => this.showToast('info', 'Silence section coming soon'),

      // ─── AI Generation ───
      insertAIVideoAtPlayhead: () => {
        if (typeof this.openAIVideoPanel === 'function') {
          this.selectedRegion = { start: this.contextData?.time || 0, end: (this.contextData?.time || 0) + 5 };
          this.openAIVideoPanel();
        } else {
          this.showToast('info', 'AI Video generation - copy prompt and use external service');
        }
      },
      generateAIVoiceover: () => {
        if (typeof this.openAudioSweeteningPanel === 'function') {
          this.openAudioSweeteningPanel();
        } else {
          this.showToast('info', 'AI Voiceover generation coming soon');
        }
      },
      addBackgroundMusic: () => {
        if (typeof this.openAudioSweeteningPanel === 'function') {
          this.openAudioSweeteningPanel();
        } else {
          this.showToast('info', 'Background music library coming soon');
        }
      },
      addSoundEffect: () => {
        if (typeof this.openAudioSweeteningPanel === 'function') {
          this.openAudioSweeteningPanel();
        } else {
          this.showToast('info', 'Sound effects library coming soon');
        }
      },

      // ─── Markers/Beats ───
      addMarker: () => this.addMarkerAtPlayhead(),
      prevMarker: () => this.goToPrevMarker(),
      nextMarker: () => this.goToNextMarker(),
      spliceHere: () => this.spliceAtTime(this.contextData?.spliceTime || this.contextData?.time || 0),
      addSpotMarker: () => this.showMarkerModal(this.contextData?.time || 0),
      createRangeBeat: () => this.startRangeBeatCreation(this.contextData?.time || 0),
      showBeatsList: () => {
        this.setMode('annotate');
        this.switchTab('scenes');
      },
      clearAllBeats: () => {
        if (confirm('Delete all beats? This cannot be undone.')) {
          this.markers = [];
          this.renderMarkers();
          this.showToast('success', 'All beats cleared');
        }
      },

      // ─── View ───
      zoomIn: () => this.zoomIn(),
      zoomOut: () => this.zoomOut(),
      fitToView: () => this.fitToView(),
      captureFrame: () => this.captureCurrentFrame(),
      showShortcutsPanel: () => this.showShortcutsPanel(),

      // ─── Teleprompter/Transcript ───
      transcribeForWaveform: () => this.transcribeForWaveform(),
      identifySpeakers: () => this.identifySpeakersFromTranscript(),

      resetTranscriptSync: () => this.resetTranscriptSyncAll(),
      toggleTeleprompter: () => this.toggleTeleprompter(),

      // ─── File ───
      openFile: () => this.openFile(),
      showExportOptions: () => this.showExportOptions(),
      openSettings: () => this.showToast('info', 'Settings coming soon'),
      loadExport: () => {
        if (this.contextData?.path) this.loadVideo(this.contextData.path);
      },
      revealExport: () => {
        if (this.contextData?.path) this.revealFile(this.contextData.path);
      },
      deleteExport: () => {
        if (this.contextData?.path) this.showToast('info', 'Delete feature coming soon');
      },

      // ─── ElevenLabs AI ───
      generateAIVoice: () => this.showGenerateAIVoiceDialog(),
      speechToSpeech: () => this.showSpeechToSpeechDialog(),
      isolateVocals: () => this.isolateVocalsAction(),
      cloneVoice: () => this.showCloneVoiceDialog(),
      generateSFX: () => this.showGenerateSFXDialog(),
      dubRegion: () => this.showDubRegionDialog(),
      dubEntireVideo: () => this.showDubVideoDialog(),
      addSFXAtPlayhead: () => this.showGenerateSFXDialog(),
      showUsageStats: () => this.showElevenLabsUsageStats(),
    };

    if (actions[action]) {
      actions[action]();
    } else {
      console.warn('Unknown context action:', action);
    }
  },

  // Set playback speed
  setPlaybackSpeed(speed) {
    const video = document.getElementById('videoPlayer');
    if (video) {
      video.playbackRate = speed;
      this.currentSpeed = speed;
      this.showToast('success', `Playback speed: ${speed}x`);
    }
  },

  // Adjust volume
  adjustVolume(delta) {
    const video = document.getElementById('videoPlayer');
    if (video) {
      video.volume = Math.max(0, Math.min(1, video.volume + delta));
      this.showToast('success', `Volume: ${Math.round(video.volume * 100)}%`);
    }
  },

  // Toggle Picture-in-Picture
  async togglePictureInPicture() {
    const video = document.getElementById('videoPlayer');
    if (!video) return;

    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (document.pictureInPictureEnabled) {
        await video.requestPictureInPicture();
      }
    } catch (_err) {
      this.showToast('error', 'Picture-in-Picture not supported');
    }
  },

  // Toggle fullscreen
  toggleFullscreen() {
    const container = document.getElementById('videoContainer');
    if (!container) return;

    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      container.requestFullscreen();
    }
  },

  // Reset trim points
  resetTrimPoints() {
    this.trimStart = 0;
    this.trimEnd = 0;
    this.trimActive = false;
    document.getElementById('trimStart').value = '00:00:00';
    document.getElementById('trimEnd').value = '00:00:00';
    this.updateTrimRegion();
    this.showToast('success', 'Trim region cleared');
  },

  // Trim head - remove everything before current playhead
  async trimHeadAtPlayhead() {
    if (!this.videoPath) return;

    const video = document.getElementById('videoPlayer');
    const currentTime = video.currentTime;

    if (currentTime < 0.5) {
      this.showToast('warning', 'Playhead is at the start - nothing to trim');
      return;
    }

    const duration = video.duration;
    const removeTime = currentTime;

    if (
      !confirm(
        `Trim HEAD: Remove ${this.formatTime(removeTime)} from the beginning?\n\nThis will create a new video starting at ${this.formatTime(currentTime)}.`
      )
    ) {
      return;
    }

    this.showProgress('Trimming Head...', `Removing first ${this.formatTime(removeTime)}`);

    try {
      const result = await window.videoEditor.trim(this.videoPath, {
        startTime: currentTime,
        endTime: duration,
      });

      this.hideProgress();

      if (result.error) {
        throw new Error(result.error);
      }

      this.showToast('success', `Trimmed ${this.formatTime(removeTime)} from head!`);
      this.loadExports();
    } catch (error) {
      this.hideProgress();
      this.showToast('error', 'Trim failed: ' + error.message);
    }
  },

  // Trim tail - remove everything after current playhead
  async trimTailAtPlayhead() {
    if (!this.videoPath) return;

    const video = document.getElementById('videoPlayer');
    const currentTime = video.currentTime;
    const duration = video.duration;

    if (currentTime > duration - 0.5) {
      this.showToast('warning', 'Playhead is at the end - nothing to trim');
      return;
    }

    const removeTime = duration - currentTime;

    if (
      !confirm(
        `Trim TAIL: Remove ${this.formatTime(removeTime)} from the end?\n\nThis will create a new video ending at ${this.formatTime(currentTime)}.`
      )
    ) {
      return;
    }

    this.showProgress('Trimming Tail...', `Removing last ${this.formatTime(removeTime)}`);

    try {
      const result = await window.videoEditor.trim(this.videoPath, {
        startTime: 0,
        endTime: currentTime,
      });

      this.hideProgress();

      if (result.error) {
        throw new Error(result.error);
      }

      this.showToast('success', `Trimmed ${this.formatTime(removeTime)} from tail!`);
      this.loadExports();
    } catch (error) {
      this.hideProgress();
      this.showToast('error', 'Trim failed: ' + error.message);
    }
  },

  // Capture current frame as image
  async captureCurrentFrame() {
    if (!this.videoPath) return;

    const video = document.getElementById('videoPlayer');
    const timestamp = this.formatTime(video.currentTime);

    try {
      const result = await window.videoEditor.generateThumbnail(this.videoPath, timestamp);
      if (result && !result.error) {
        this.showToast('success', 'Frame captured!');
      } else {
        throw new Error(result?.error || 'Failed to capture');
      }
    } catch (error) {
      this.showToast('error', 'Failed to capture frame: ' + error.message);
    }
  },

  // Open file dialog
  async openFile() {
    try {
      const result = await window.videoEditor.openFile();
      if (result && result.filePaths && result.filePaths.length > 0) {
        // Clear space tracking when opening a file directly
        this.spaceItemId = null;
        this.spaceItemName = null;
        this.transcriptSegments = null; // Clear transcript data
        this.transcriptSource = null; // Clear source tracking
        this.updateSaveToSpaceButton();

        this.loadVideo(result.filePaths[0]);
      }
    } catch (error) {
      console.error('Error opening file:', error);
      this.showToast('error', 'Failed to open file');
    }
  },

  // ==================== VIDEO SOURCE MANAGEMENT ====================

  /**
   * Add a video source to the project
   * @param {string} filePath - Path to video file
   * @param {object} options - Additional options { addToTimeline: boolean }
   * @returns {object} - Created source object
   */
  async addVideoSource(filePath, options = {}) {
    const { addToTimeline = true } = options;

    try {
      // Get video info
      const videoInfo = await window.videoEditor.getInfo(filePath);

      if (videoInfo.error) {
        throw new Error(videoInfo.error);
      }

      // Check if source already exists
      const existingSource = this.videoSources.find((s) => s.path === filePath);
      if (existingSource) {
        console.log('[VideoSources] Source already exists:', existingSource.id);
        if (addToTimeline) {
          this.addVideoClipFromSource(existingSource.id);
        }
        return existingSource;
      }

      // Create source object
      const fileName = filePath.split('/').pop();
      const source = {
        id: `source_${this.nextVideoSourceId++}`,
        path: filePath,
        fileName: fileName,
        duration: videoInfo.duration,
        metadata: videoInfo,
      };

      this.videoSources.push(source);
      console.log('[VideoSources] Added source:', source.id, fileName);

      // Render sources panel
      this.renderVideoSources();

      // Add clip to timeline if requested
      if (addToTimeline) {
        this.addVideoClipFromSource(source.id);
      }

      return source;
    } catch (error) {
      console.error('[VideoSources] Error adding source:', error);
      this.showToast('error', 'Failed to add video: ' + error.message);
      throw error;
    }
  },

  /**
   * Remove a video source (and all clips using it)
   * @param {string} sourceId - Source ID to remove
   */
  removeVideoSource(sourceId) {
    const source = this.videoSources.find((s) => s.id === sourceId);
    if (!source) return;

    // Remove all clips using this source
    const clipsToRemove = this.videoClips.filter((c) => c.sourceId === sourceId);
    clipsToRemove.forEach((clip) => this.removeVideoClip(clip.id));

    // Remove source
    this.videoSources = this.videoSources.filter((s) => s.id !== sourceId);

    console.log('[VideoSources] Removed source:', sourceId);
    this.renderVideoSources();
    this.showToast('info', `Removed ${source.fileName}`);
  },

  /**
   * Add a video clip to the timeline from a source
   * @param {string} sourceId - Source ID
   * @param {number} timelineStart - Optional timeline start position (defaults to end of timeline)
   * @returns {object} - Created clip object
   */
  addVideoClipFromSource(sourceId, timelineStart = null) {
    const source = this.videoSources.find((s) => s.id === sourceId);
    if (!source) {
      console.error('[VideoClips] Source not found:', sourceId);
      return null;
    }

    // Calculate timeline position
    if (timelineStart === null) {
      // Place at end of timeline
      if (this.videoClips.length === 0) {
        timelineStart = 0;
      } else {
        const lastClip = this.videoClips[this.videoClips.length - 1];
        timelineStart = lastClip.timelineStart + lastClip.duration;
      }
    }

    // Create clip object
    const clip = {
      id: `clip_${this.nextVideoClipId++}`,
      sourceId: sourceId,
      name: source.fileName,
      timelineStart: timelineStart,
      sourceIn: 0,
      sourceOut: source.duration,
      duration: source.duration,
    };

    this.videoClips.push(clip);

    // Sort clips by timeline position
    this.videoClips.sort((a, b) => a.timelineStart - b.timelineStart);

    console.log('[VideoClips] Added clip:', clip.id, 'from', sourceId, 'at', timelineStart);

    // Render timeline
    this.renderVideoClips();

    // If this is the first clip, load the source into the player
    if (this.videoClips.length === 1) {
      this.switchToSource(sourceId);
    }

    return clip;
  },

  /**
   * Remove a video clip from the timeline
   * @param {string} clipId - Clip ID to remove
   */
  removeVideoClip(clipId) {
    const clip = this.videoClips.find((c) => c.id === clipId);
    if (!clip) return;

    this.videoClips = this.videoClips.filter((c) => c.id !== clipId);

    console.log('[VideoClips] Removed clip:', clipId);
    this.renderVideoClips();

    // If no clips left, clear the player
    if (this.videoClips.length === 0) {
      this.clearVideoPlayer();
    }
  },

  /**
   * Get the video clip at a specific timeline position
   * @param {number} time - Timeline time in seconds
   * @returns {object|null} - Clip object or null
   */
  getVideoClipAtTime(time) {
    for (const clip of this.videoClips) {
      const clipEnd = clip.timelineStart + clip.duration;
      if (time >= clip.timelineStart && time < clipEnd) {
        return clip;
      }
    }
    return null;
  },

  /**
   * Check if playhead has crossed clip boundaries and switch sources if needed
   * Called during playback (timeupdate event)
   */
  checkClipBoundaries() {
    if (this.videoClips.length === 0) return;

    const video = document.getElementById('videoPlayer');
    if (!video || video.paused) return;

    // Calculate current timeline position (not video.currentTime, which is source-relative)
    const currentClip = this.getVideoClipAtTime(this.currentTimelinePosition || 0);

    if (!currentClip) return;

    // If we're in a different clip than the active source, switch
    if (currentClip.sourceId !== this.activeSourceId) {
      console.log('[Playback] Switching to clip:', currentClip.id, 'source:', currentClip.sourceId);

      // Calculate offset into the new clip
      const offsetIntoClip = (this.currentTimelinePosition || 0) - currentClip.timelineStart;
      const sourceTime = currentClip.sourceIn + offsetIntoClip;

      // Switch source and seek to the right position
      this.switchToSource(currentClip.sourceId, sourceTime);

      // Resume playback if it was playing
      if (!video.paused) {
        video.play().catch((err) => console.error('[Playback] Resume error:', err));
      }
    }
  },

  /**
   * Split a video clip at the current playhead position
   * @param {string} clipId - Clip ID to split (optional, uses clip at playhead if not provided)
   */
  splitVideoClipAtPlayhead(clipId = null) {
    const video = document.getElementById('videoPlayer');
    if (!video) return;

    const playheadTime = this.currentTimelinePosition || video.currentTime;

    // Find the clip to split
    let clip;
    if (clipId) {
      clip = this.videoClips.find((c) => c.id === clipId);
    } else {
      clip = this.getVideoClipAtTime(playheadTime);
    }

    if (!clip) {
      this.showToast('warning', 'No clip at playhead position');
      return;
    }

    // Check if playhead is actually inside the clip (not at edges)
    const clipEnd = clip.timelineStart + clip.duration;
    if (playheadTime <= clip.timelineStart || playheadTime >= clipEnd) {
      this.showToast('warning', 'Playhead must be inside the clip');
      return;
    }

    // Calculate split point
    const offsetIntoClip = playheadTime - clip.timelineStart;
    const splitSourceTime = clip.sourceIn + offsetIntoClip;

    // Create two new clips
    const clip1 = {
      id: `${clip.id}_a`,
      sourceId: clip.sourceId,
      name: `${clip.name} (1)`,
      timelineStart: clip.timelineStart,
      sourceIn: clip.sourceIn,
      sourceOut: splitSourceTime,
      duration: offsetIntoClip,
    };

    const clip2 = {
      id: `${clip.id}_b`,
      sourceId: clip.sourceId,
      name: `${clip.name} (2)`,
      timelineStart: playheadTime,
      sourceIn: splitSourceTime,
      sourceOut: clip.sourceOut,
      duration: clip.duration - offsetIntoClip,
    };

    // Replace original clip with two new clips
    const clipIndex = this.videoClips.findIndex((c) => c.id === clip.id);
    this.videoClips.splice(clipIndex, 1, clip1, clip2);

    console.log('[VideoClips] Split clip:', clip.id, 'into', clip1.id, 'and', clip2.id);
    this.renderVideoClips();
    this.showToast('success', 'Clip split');
  },

  /**
   * Trim a video clip's in/out points
   * @param {string} clipId - Clip ID
   * @param {number} newIn - New source in point (null to keep existing)
   * @param {number} newOut - New source out point (null to keep existing)
   */
  trimVideoClip(clipId, newIn = null, newOut = null) {
    const clip = this.videoClips.find((c) => c.id === clipId);
    if (!clip) return;

    const source = this.videoSources.find((s) => s.id === clip.sourceId);
    if (!source) return;

    // Update in/out points
    if (newIn !== null) {
      clip.sourceIn = Math.max(0, Math.min(newIn, source.duration));
    }
    if (newOut !== null) {
      clip.sourceOut = Math.max(clip.sourceIn, Math.min(newOut, source.duration));
    }

    // Recalculate duration
    clip.duration = clip.sourceOut - clip.sourceIn;

    // Shift subsequent clips
    this.compactClipsOnTimeline();

    console.log('[VideoClips] Trimmed clip:', clipId);
    this.renderVideoClips();
  },

  /**
   * Move a video clip to a new timeline position
   * @param {string} clipId - Clip ID
   * @param {number} newTimelineStart - New timeline start position
   */
  moveVideoClip(clipId, newTimelineStart) {
    const clip = this.videoClips.find((c) => c.id === clipId);
    if (!clip) return;

    clip.timelineStart = Math.max(0, newTimelineStart);

    // Re-sort clips
    this.videoClips.sort((a, b) => a.timelineStart - b.timelineStart);

    console.log('[VideoClips] Moved clip:', clipId, 'to', newTimelineStart);
    this.renderVideoClips();
  },

  /**
   * Compact clips on timeline (remove gaps)
   */
  compactClipsOnTimeline() {
    let currentTime = 0;
    this.videoClips.forEach((clip) => {
      clip.timelineStart = currentTime;
      currentTime += clip.duration;
    });
  },

  /**
   * Export multi-source video (concatenate all clips)
   */
  async exportMultiSourceVideo() {
    if (this.videoClips.length === 0) {
      this.showToast('error', 'No video clips to export');
      return;
    }

    try {
      this.showProgress('Exporting multi-source video...', 0);

      console.log('[Export] Exporting', this.videoClips.length, 'clips');

      // Prepare clips and sources data
      const clips = this.videoClips.map((clip) => ({
        id: clip.id,
        sourceId: clip.sourceId,
        sourceIn: clip.sourceIn,
        sourceOut: clip.sourceOut,
        duration: clip.duration,
        timelineStart: clip.timelineStart,
      }));

      const sources = this.videoSources.map((source) => ({
        id: source.id,
        path: source.path,
      }));

      // Export
      const result = await window.videoEditor.concatenateClips(clips, sources, {
        format: 'mp4',
        quality: 'medium',
      });

      this.hideProgress();

      if (result.success) {
        this.showToast('success', `Exported ${result.clipsProcessed} clips!`);
        this.loadExports();
      } else {
        throw new Error(result.error || 'Export failed');
      }
    } catch (error) {
      this.hideProgress();
      console.error('[Export] Multi-source export error:', error);
      this.showToast('error', 'Export failed: ' + error.message);
    }
  },

  /**
   * Switch the video player to a specific source
   * @param {string} sourceId - Source ID to switch to
   * @param {number} startTime - Optional start time within the source
   */
  async switchToSource(sourceId, startTime = 0) {
    const source = this.videoSources.find((s) => s.id === sourceId);
    if (!source) {
      console.error('[VideoSources] Cannot switch to source:', sourceId);
      return;
    }

    console.log('[VideoSources] Switching to source:', sourceId, source.fileName);

    this.activeSourceId = sourceId;
    this.videoPath = source.path;
    this.videoInfo = source.metadata;

    // Update video player
    const video = document.getElementById('videoPlayer');
    video.src = pathToFileUrl(source.path);

    // Set start time
    if (startTime > 0) {
      video.currentTime = startTime;
    }

    // Update UI
    document.getElementById('fileName').textContent = source.fileName;

    return source;
  },

  /**
   * Clear the video player
   */
  clearVideoPlayer() {
    const video = document.getElementById('videoPlayer');
    video.src = '';
    this.videoPath = null;
    this.videoInfo = null;
    this.activeSourceId = null;

    document.getElementById('fileName').textContent = 'No video loaded';
  },

  /**
   * Render video sources panel
   */
  renderVideoSources() {
    const container = document.getElementById('videoSourcesList');
    if (!container) return;

    if (this.videoSources.length === 0) {
      container.innerHTML = '<div class="empty-state">No video sources. Click + to add.</div>';
      return;
    }

    container.innerHTML = this.videoSources
      .map(
        (source) => `
          <div class="video-source-item" data-source-id="${source.id}">
            <div class="video-source-icon">📹</div>
            <div class="video-source-info">
              <div class="video-source-name" title="${source.fileName}">${source.fileName}</div>
              <div class="video-source-duration">${this.formatTime(source.duration)}</div>
            </div>
            <div class="video-source-actions">
              <button class="btn-icon" onclick="app.addVideoClipFromSource('${source.id}')" title="Add to timeline">
                ➕
              </button>
              <button class="btn-icon" onclick="app.removeVideoSource('${source.id}')" title="Remove source">
                🗑️
              </button>
            </div>
          </div>
        `
      )
      .join('');
  },

  /**
   * Open file dialog to add a video source
   */
  async addVideoSourceDialog() {
    try {
      const result = await window.videoEditor.openFile();
      if (result && result.filePaths && result.filePaths.length > 0) {
        const filePath = result.filePaths[0];
        await this.addVideoSource(filePath, { addToTimeline: true });
        this.showToast('success', `Added ${filePath.split('/').pop()}`);
      }
    } catch (error) {
      console.error('[VideoSources] Error adding source:', error);
      this.showToast('error', 'Failed to add video source');
    }
  },

  /**
   * Render video clips on the timeline
   */
  renderVideoClips() {
    const track = document.getElementById('videoTrack');
    if (!track) {
      console.warn('[VideoClips] Video track element not found');
      return;
    }

    // Clear existing clips
    track.innerHTML = '';

    if (this.videoClips.length === 0) {
      // Show placeholder
      const placeholder = document.createElement('div');
      placeholder.className = 'timeline-clip-placeholder';
      placeholder.textContent = 'Drag video sources here or click + to add';
      track.appendChild(placeholder);
      return;
    }

    // Calculate total timeline duration
    const totalDuration = this.videoClips.reduce((max, clip) => Math.max(max, clip.timelineStart + clip.duration), 0);

    // Render each clip
    this.videoClips.forEach((clip) => {
      const source = this.videoSources.find((s) => s.id === clip.sourceId);
      if (!source) return;

      const clipEl = document.createElement('div');
      clipEl.className = 'timeline-clip video-clip';
      clipEl.dataset.clipId = clip.id;
      clipEl.dataset.sourceId = clip.sourceId;

      // Calculate position and width as percentages
      const leftPercent = (clip.timelineStart / totalDuration) * 100;
      const widthPercent = (clip.duration / totalDuration) * 100;

      clipEl.style.left = `${leftPercent}%`;
      clipEl.style.width = `${widthPercent}%`;

      clipEl.innerHTML = `
            <div class="timeline-thumbnails" id="clip-thumbnails-${clip.id}"></div>
            <span class="timeline-clip-name">${clip.name}</span>
            <div class="marker-range-overlay-container"></div>
          `;

      // Add click handler
      clipEl.onclick = (e) => this.selectVideoClip(clip.id, e);

      track.appendChild(clipEl);
    });

    // Update track info
    const trackInfo = document.querySelector('#videoTrack').closest('.timeline-row').querySelector('.track-clip-count');
    if (trackInfo) {
      trackInfo.textContent = `${this.videoClips.length} Clip${this.videoClips.length !== 1 ? 's' : ''}`;
    }
  },

  /**
   * Select a video clip
   * @param {string} clipId - Clip ID
   * @param {Event} event - Click event
   */
  selectVideoClip(clipId, event) {
    const clip = this.videoClips.find((c) => c.id === clipId);
    if (!clip) return;

    // Visual selection
    document.querySelectorAll('.video-clip').forEach((el) => {
      el.classList.toggle('selected', el.dataset.clipId === clipId);
    });

    // Switch to this source if needed
    if (clip.sourceId !== this.activeSourceId) {
      this.switchToSource(clip.sourceId, clip.sourceIn);
    }

    // Seek to clip start on timeline
    const video = document.getElementById('videoPlayer');
    if (video) {
      const offset = event ? this.getTimeFromClickPosition(event) : 0;
      video.currentTime = clip.sourceIn + offset;
    }
  },

  // Load video (modified to support multi-source mode)
  async loadVideo(filePath, options = {}) {
    const {
      addToSources = false, // If true, add to sources and create clip instead of replacing
      _replaceCurrent = true, // If false with addToSources=true, keeps existing clips
    } = options;

    // NEW BEHAVIOR: Add to sources instead of replacing
    if (addToSources) {
      try {
        await this.addVideoSource(filePath, { addToTimeline: true });
        return;
      } catch (error) {
        console.error('[LoadVideo] Failed to add source:', error);
        return;
      }
    }

    // LEGACY BEHAVIOR: Replace current video (backwards compatible)
    this.videoPath = filePath;

    // Clear waveform cache for new video
    this.clearWaveformCache();

    // Show loading
    document.getElementById('fileName').textContent = 'Loading...';

    // Log feature usage
    if (window.api && window.api.logFeatureUsed) {
      window.api.logFeatureUsed('video-editor', {
        action: 'load-video',
        hasPath: !!filePath,
      });
    }

    try {
      // Get video info
      this.videoInfo = await window.videoEditor.getInfo(filePath);

      if (this.videoInfo.error) {
        throw new Error(this.videoInfo.error);
      }

      // Check if this is an audio-only file (no video stream)
      if (!this.videoInfo.video && this.videoInfo.audio) {
        console.log('[VideoEditor] Audio-only file detected:', filePath);
        this.pendingAudioFile = filePath;
        this.showAudioOnlyModal();
        return; // Wait for user choice
      }

      // Update UI
      const fileName = filePath.split('/').pop();
      document.getElementById('fileName').textContent = fileName;

      // Load video player
      const video = document.getElementById('videoPlayer');
      video.src = pathToFileUrl(filePath);

      // Show video player, hide placeholder
      document.getElementById('videoPlaceholder').classList.add('hidden');
      video.classList.remove('hidden');
      document.getElementById('videoControls').classList.remove('hidden');
      document.getElementById('timeline').classList.remove('hidden');

      // Enable buttons (with null checks since some may be removed)
      const enableBtn = (id) => {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = false;
      };
      enableBtn('exportBtn');
      enableBtn('releaseBtn');
      enableBtn('trimBtn');
      enableBtn('transcodeBtn');
      enableBtn('extractAudioBtn');
      enableBtn('compressBtn');
      enableBtn('thumbnailBtn');
      enableBtn('transcribeBtn');
      enableBtn('applySpeedBtn');
      enableBtn('reverseBtn');
      enableBtn('spliceBtn');
      enableBtn('setSpliceStartBtn');
      enableBtn('setSpliceEndBtn');
      enableBtn('addMarkerBtn');
      enableBtn('prevMarkerBtn');
      enableBtn('nextMarkerBtn');
      enableBtn('markInBtn');
      enableBtn('markOutBtn');

      // Reset splice (with null checks)
      const spliceStart = document.getElementById('spliceStart');
      const spliceEnd = document.getElementById('spliceEnd');
      const splicePreview = document.getElementById('splicePreview');
      if (spliceStart) spliceStart.value = '00:00:00';
      if (spliceEnd) spliceEnd.value = '00:00:00';
      if (splicePreview) splicePreview.style.display = 'none';
      this.spliceStart = 0;
      this.spliceEnd = 0;

      // Reset speed to 1x
      this.currentSpeed = 1.0;
      const speedSlider = document.getElementById('speedSlider');
      const speedValue = document.getElementById('speedValue');
      if (speedSlider) speedSlider.value = 1;
      if (speedValue) speedValue.textContent = '1.00';
      document.querySelectorAll('.speed-btn').forEach((btn) => {
        btn.classList.toggle('active', parseFloat(btn.dataset.speed) === 1);
      });

      // Update video info panel
      this.displayVideoInfo();

      // Generate timeline thumbnails
      this.loadTimelineThumbnails();

      // Update timeline ruler and reset zoom
      this.fitToView();
      this.updateTimelineRuler();

      // Re-update ruler after layout settles (first load timing issue)
      requestAnimationFrame(() => {
        this.updateTimelineRuler();
      });

      // Only clear markers if NOT loading from a Space or Project (state is set before loadVideo is called)
      if (!this.spaceItemId && !this._loadingFromProject) {
        // Clear markers for new video (not from Space or Project)
        this.markers = [];
        this.pendingRangeMarker = null;
        this.sceneThumbnails = {}; // Clear scene thumbnails cache
        this.transcriptSegments = null; // Clear transcript for fresh video
        this.transcriptSource = null;
        document.getElementById('pendingRangeIndicator').classList.add('hidden');
        this.renderMarkers();
      } else {
        // Preserve Space/Project scenes but clear pending marker
        this.pendingRangeMarker = null;
        document.getElementById('pendingRangeIndicator').classList.add('hidden');
        // Re-render markers after video is ready to ensure proper positioning
        this.renderMarkers();
      }

      this.showToast('success', 'Video loaded successfully');

      // Extract audio for Web Audio scrubbing (in background)
      this.loadScrubAudio(filePath);
    } catch (error) {
      console.error('Error loading video:', error);
      document.getElementById('fileName').textContent = 'Error loading video';
      this.showToast('error', 'Failed to load video: ' + error.message);
    }
  },

  // On video loaded
  async onVideoLoaded() {
    const video = document.getElementById('videoPlayer');
    // Don't set trim region by default - keep it hidden
    this.trimStart = 0;
    this.trimEnd = 0; // 0 means no active trim
    this.trimActive = false;

    document.getElementById('trimStart').value = '00:00:00';
    document.getElementById('trimEnd').value = '00:00:00';
    document.getElementById('duration').textContent = this.formatTime(video.duration);
    document.getElementById('timelineEnd').textContent = this.formatTime(video.duration);

    // ==================== PRELOADER ====================
    // Check for missing assets and prompt user to generate them
    if (window.VideoEditorPreloader && this.videoPath) {
      try {
        const preloadResult = await window.VideoEditorPreloader.checkAndPrompt(
          this.videoPath,
          {
            transcriptSegments: this.transcriptSegments,
            transcriptSource: this.transcriptSource,
            duration: video.duration,
            spaceItemId: this.spaceItemId,
          },
          {
            onTranscriptGenerated: (segments, source) => {
              console.log('[Preloader] Transcript generated:', segments.length, 'segments');
              this.transcriptSegments = segments;
              this.transcriptSource = source || 'elevenlabs-scribe';
              // Update teleprompter if visible
              if (this.teleprompterVisible) {
                this.initTeleprompter();
              }
            },
            onWaveformGenerated: (cache) => {
              console.log('[Preloader] Waveform cache generated');
              this.waveformCache = cache;
              // Refresh waveform display
              this.updateWaveform();
            },
            onThumbnailsGenerated: (strips) => {
              console.log('[Preloader] Thumbnail strips generated');
              // Strips will be used by loadTimelineThumbnails
              this._preloadedThumbnails = strips;
            },
          }
        );
        console.log(
          '[Preloader] Result:',
          preloadResult.skipped ? 'skipped' : `generated: ${preloadResult.generated.join(', ')}`
        );
      } catch (err) {
        console.warn('[Preloader] Error:', err);
        // Continue loading even if preloader fails
      }
    }
    // ==================== END PRELOADER ====================

    // Load thumbnails now that we have duration available
    // (loadVideo() calls this too early, before duration is known)
    this.loadTimelineThumbnails();

    // Auto-zoom to show first 10 minutes for long videos
    // This makes it easier to work with long recordings
    // BUT cap at a safe zoom level to prevent memory issues with canvas
    const TEN_MINUTES = 600; // seconds (10 min)

    if (video.duration > TEN_MINUTES) {
      // Use time-based zoom to show exactly 10 minutes
      // setZoomToTime handles all the zoom calculation and UI updates
      if (typeof this.setZoomToTime === 'function') {
        console.log(`[VideoEditor] Auto-zooming to show 10 minutes for ${this.formatTime(video.duration)} video`);
        this.setZoomToTime(TEN_MINUTES);
      } else {
        // Fallback to old method if setZoomToTime not available yet
        const idealZoom = video.duration / TEN_MINUTES;
        const autoZoom = Math.min(idealZoom, 6, this.maxZoom);
        this.setZoom(autoZoom);
      }
    } else {
      // For shorter videos, fit to view
      if (typeof this.setZoomToTime === 'function') {
        this.setZoomToTime(0); // 0 = Fit
      } else {
        this.setZoom(1);
      }
    }

    // Reset scroll to beginning
    this.timelineScrollOffset = 0;
    const timelineWrapper = document.getElementById('timelineWrapper');
    if (timelineWrapper) {
      timelineWrapper.scrollLeft = 0;
    }

    // Update timeline ruler now that duration is available
    this.updateTimelineRuler();

    // DISABLED:         // Auto-generate reel markers for long videos (10+ minutes)
    // DISABLED:         // For Space videos: generate AND auto-save if no existing scenes
    // DISABLED:         // For local files: just generate (no save)
    // DISABLED:         if (video.duration >= 600 && this.markers.length === 0) {
    // DISABLED:           this.generateReelMarkers(video.duration);
    // DISABLED:
    // DISABLED:           // Auto-save to Space if this is a Space video (so markers persist)
    // DISABLED:           if (this.spaceItemId && this.markers.length > 0) {
    // DISABLED:             console.log('[VideoEditor] Auto-saving generated markers to Space...');
    // DISABLED:             this.saveMarkersToSpace().then(() => {
    // DISABLED:               console.log('[VideoEditor] Markers auto-saved to Space');
    // DISABLED:             }).catch(err => {
    // DISABLED:               console.warn('[VideoEditor] Failed to auto-save markers:', err.message);
    // DISABLED:             });
    // DISABLED:           }
    // DISABLED: }

    this.updateTrimRegion();

    // NOTE: Don't auto-create project here - let users create projects manually
    // from the Media tab. This allows "quick edit" mode without project structure.
    // Projects are created when user clicks "Create Project" in the UI.

    // Reset audio state
    this.audioDetached = false;
    this.audioMuted = false;
    document.getElementById('audioTrack').classList.remove('detached');
    document.getElementById('detachAudioBtn').disabled = false;
    document.getElementById('detachAudioBtn').style.opacity = '1';
    document.getElementById('audioMuteBtn').textContent = '🔊';
    document.getElementById('audioMuteBtn').classList.remove('muted');

    // Create approximate transcript segments if we have pending text
    // Now we have the correct video duration
    if (this.pendingTranscriptText && video.duration > 0) {
      console.log('[VideoEditor] Creating transcript segments with duration:', video.duration.toFixed(2) + 's');
      const words = this.pendingTranscriptText.split(/\s+/).filter((w) => w.length > 0);
      const wordDuration = video.duration / words.length;

      this.transcriptSegments = words.map((word, i) => ({
        text: word,
        start: i * wordDuration,
        end: (i + 1) * wordDuration,
      }));
      this.transcriptSource = 'evenly-distributed'; // Mark as inaccurate

      console.log(
        '[VideoEditor] Created',
        this.transcriptSegments.length,
        'segments,',
        (wordDuration * 1000).toFixed(0) + 'ms per word (EVENLY DISTRIBUTED - NOT SYNCED)'
      );

      // Clear pending text
      this.pendingTranscriptText = null;

      // Auto-show teleprompter when transcript is available
      this.teleprompterVisible = true;
      const teleprompterContainer = document.getElementById('teleprompterContainer');
      const toggleBtn = document.getElementById('teleprompterToggleBtn');
      teleprompterContainer?.classList.remove('hidden');
      toggleBtn?.classList.add('active');
      this.initTeleprompter();
    }

    // Generate audio waveform - use requestAnimationFrame + timeout for better DOM timing
    // This ensures the layout has settled before we read element dimensions
    requestAnimationFrame(() => {
      setTimeout(() => {
        console.log('[VideoEditor] Generating waveform after DOM settle');
        this.generateAudioWaveform();

        // Update transcribe button state if transcription exists
        const btn = document.getElementById('waveformTranscribeBtn');
        if (btn && this.transcriptSegments?.length > 0) {
          btn.textContent = `✓ ${this.transcriptSegments.length} words`;
          btn.classList.add('transcribed');
        } else if (btn) {
          btn.textContent = '🎤 Transcribe';
          btn.classList.remove('transcribed');
          btn.disabled = false;

          // Encourage transcription for videos without transcript
          // Show a subtle prompt after a delay
          setTimeout(() => {
            if (!this.transcriptSegments || this.transcriptSegments.length === 0) {
              this.showToast(
                'info',
                '💡 Tip: Transcribe your video for searchable text and story beats! Click 🎤 on the audio track.',
                6000
              );
            }
          }, 3000);
        }
      }, 200); // Increased from 100ms to 200ms for better DOM timing
    });

    // Initialize Guide + Master audio track architecture
    // This checks for cached audio and extracts in background if needed
    if (this.videoPath && video.duration > 0) {
      this.initializeAudioTracks(this.videoPath, video.duration);
    }

    // Initialize multi-track audio for playback
    this.loadMultiTrackAudio();
  },

  // Load audio for all tracks into the multi-track audio manager
  async loadMultiTrackAudio() {
    if (!this.multiTrackAudio) {
      console.log('[MultiTrackAudio] Manager not initialized yet, skipping');
      return;
    }

    try {
      // For Guide track: Audio comes from video element, no need to load
      const guideTrack = this.getGuideTrack?.();
      if (guideTrack) {
        console.log('[MultiTrackAudio] Guide track uses video element audio');
      }

      // For Master track: Load from extracted audio file
      const masterTrack = this.getMasterTrack?.();
      if (masterTrack && masterTrack.audioPath) {
        await this.multiTrackAudio.loadTrackAudio(masterTrack.id, masterTrack.audioPath, {
          volume: masterTrack.volume || 1.0,
          muted: masterTrack.muted || false,
          solo: masterTrack.solo || false,
        });
      }

      // Legacy: Load audio for the original track (A1) if it exists
      const originalTrack = this.audioTracks.find((t) => t.id === 'A1' || t.type === 'original');
      if (originalTrack) {
        await this.multiTrackAudio.loadTrackAudio(originalTrack.id, null, {
          volume: originalTrack.volume || 1.0,
          muted: originalTrack.muted || false,
          solo: originalTrack.solo || false,
        });
      }

      // Load audio for any other tracks that have clips with audio paths
      for (const track of this.audioTracks) {
        if (track.id === 'A1' || track.type === 'original' || track.type === 'guide' || track.type === 'master')
          continue;

        // For duplicated tracks that reference the original, share the audio buffer
        if (track.sourceTrackId || track.type === 'working' || track.type === 'guide') {
          await this.multiTrackAudio.loadTrackAudio(track.id, null, {
            volume: track.volume || 1.0,
            muted: track.muted || false,
            solo: track.solo || false,
          });
        }
        // TODO: Load audio from track clips for ADR/voice tracks
      }

      console.log('[MultiTrackAudio] Loaded audio for', this.multiTrackAudio.trackAudio.size, 'tracks');
    } catch (error) {
      console.warn('[MultiTrackAudio] Failed to load track audio:', error.message);
    }
  },

  // Display video info
  displayVideoInfo() {
    if (!this.videoInfo) return;

    const infoSection = document.getElementById('videoInfoSection');
    const infoGrid = document.getElementById('videoInfo');

    const info = this.videoInfo;
    let html = '';

    html += this.createInfoItem('Duration', info.durationFormatted);
    html += this.createInfoItem('Size', this.formatBytes(info.size));

    if (info.video) {
      html += this.createInfoItem('Resolution', `${info.video.width}×${info.video.height}`);
      html += this.createInfoItem('Codec', info.video.codec);
      html += this.createInfoItem('FPS', Math.round(info.video.fps));
    }

    if (info.audio) {
      html += this.createInfoItem('Audio', `${info.audio.codec} ${info.audio.channels}ch`);
    }

    infoGrid.innerHTML = html;
    infoSection.style.display = 'block';
  },

  createInfoItem(label, value) {
    return `<div class="info-item"><span class="info-label">${label}</span><span class="info-value">${value}</span></div>`;
  },

  // ==================== AUDIO-ONLY FILE HANDLING ====================

  pendingAudioFile: null,
  isAudioOnlyMode: false,
  selectedVideoColor: '#1a1a2e',

  showAudioOnlyModal() {
    document.getElementById('audioOnlyModal').style.display = 'flex';
    document.getElementById('addVideoOptions').style.display = 'none';
    document.getElementById('colorPickerSection').style.display = 'none';
    document.getElementById('fileName').textContent = this.pendingAudioFile?.split('/').pop() || 'Audio file';
  },

  closeAudioOnlyModal() {
    document.getElementById('audioOnlyModal').style.display = 'none';
    this.pendingAudioFile = null;
    document.getElementById('fileName').textContent = 'No file loaded';
  },

  // Continue with audio-only mode (waveform visualization)
  async useAudioOnlyMode() {
    document.getElementById('audioOnlyModal').style.display = 'none';

    if (!this.pendingAudioFile) return;

    this.isAudioOnlyMode = true;
    const filePath = this.pendingAudioFile;
    this.pendingAudioFile = null;

    // Continue loading as audio-only
    await this.loadAudioOnly(filePath);
  },

  // Load audio-only file with special UI handling
  async loadAudioOnly(filePath) {
    this.videoPath = filePath;

    try {
      // Update UI for audio-only mode
      const fileName = filePath.split('/').pop();
      document.getElementById('fileName').textContent = `🎵 ${fileName}`;

      // Hide video player, show audio placeholder
      const video = document.getElementById('videoPlayer');
      const placeholder = document.getElementById('videoPlaceholder');

      // Create audio-only placeholder with PROMINENT transcription CTA
      placeholder.innerHTML = `
            <div class="audio-only-display" style="
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: center;
              width: 100%;
              height: 100%;
              background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
              color: white;
              text-align: center;
              padding: 20px;
            ">
              <div style="font-size: 64px; margin-bottom: 16px; animation: pulse 2s infinite;">🎵</div>
              <div style="font-size: 18px; font-weight: 600; margin-bottom: 8px;">${fileName}</div>
              <div style="font-size: 14px; color: rgba(255,255,255,0.7); margin-bottom: 24px;">
                ${this.videoInfo.durationFormatted} • ${this.videoInfo.audio?.codec || 'Audio'} • ${this.videoInfo.audio?.channels || 2}ch
              </div>
              
              <!-- TRANSCRIPTION CTA - The cornerstone feature -->
              <div id="audioTranscriptionCTA" style="
                background: linear-gradient(135deg, rgba(139, 92, 246, 0.3) 0%, rgba(99, 102, 241, 0.3) 100%);
                border: 2px solid rgba(139, 92, 246, 0.5);
                border-radius: 16px;
                padding: 24px 32px;
                max-width: 400px;
                margin-bottom: 16px;
              ">
                <div style="font-size: 28px; margin-bottom: 12px;">🎤</div>
                <div style="font-size: 16px; font-weight: 600; margin-bottom: 8px; color: #a78bfa;">
                  Transcribe Your Audio
                </div>
                <div style="font-size: 13px; color: rgba(255,255,255,0.8); margin-bottom: 16px; line-height: 1.5;">
                  Unlock the full power of your audio with AI transcription.<br>
                  Get word-level timestamps, searchable text, and story beats.
                </div>
                <button onclick="app.transcribeForWaveform()" style="
                  background: linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%);
                  color: white;
                  border: none;
                  padding: 12px 32px;
                  border-radius: 8px;
                  font-size: 14px;
                  font-weight: 600;
                  cursor: pointer;
                  display: flex;
                  align-items: center;
                  gap: 8px;
                  margin: 0 auto;
                  transition: transform 0.2s, box-shadow 0.2s;
                " onmouseover="this.style.transform='scale(1.05)'; this.style.boxShadow='0 4px 20px rgba(139,92,246,0.4)';"
                   onmouseout="this.style.transform='scale(1)'; this.style.boxShadow='none';">
                  <span>🎤</span> Transcribe Now
                </button>
              </div>
              
              <div style="font-size: 11px; color: rgba(255,255,255,0.4);">
                Audio-Only Mode • Press <kbd style="background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 3px;">T</kbd> to toggle transcript
              </div>
            </div>
          `;
      placeholder.classList.remove('hidden');
      video.classList.add('hidden');

      // Use audio element instead of video for playback
      let audioEl = document.getElementById('audioOnlyPlayer');
      if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.id = 'audioOnlyPlayer';
        audioEl.style.display = 'none';
        document.body.appendChild(audioEl);
      }
      audioEl.src = pathToFileUrl(filePath);

      // Sync audio element with video controls
      this.setupAudioOnlyControls(audioEl);

      // Show controls and timeline
      document.getElementById('videoControls').classList.remove('hidden');
      document.getElementById('timeline').classList.remove('hidden');

      // Enable buttons
      const enableBtn = (id) => {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = false;
      };
      enableBtn('exportBtn');
      enableBtn('releaseBtn');
      enableBtn('extractAudioBtn');
      enableBtn('compressBtn');
      enableBtn('transcribeBtn');
      enableBtn('addMarkerBtn');
      enableBtn('prevMarkerBtn');
      enableBtn('nextMarkerBtn');
      enableBtn('markInBtn');
      enableBtn('markOutBtn');

      // Hide video-only features
      const hideVideoOnlySection = (id) => {
        const section = document.getElementById(id);
        if (section) section.style.display = 'none';
      };
      hideVideoOnlySection('trimSection');
      hideVideoOnlySection('spliceSection');
      hideVideoOnlySection('convertSection');
      hideVideoOnlySection('thumbnailBtn');

      // Update video info panel (audio-focused)
      this.displayVideoInfo();

      // Update timeline - hide video track, emphasize audio
      document.getElementById('videoClip').style.opacity = '0.3';
      document.getElementById('videoClip').innerHTML = `
            <div style="
              display: flex;
              align-items: center;
              justify-content: center;
              height: 100%;
              color: var(--text-muted);
              font-size: 11px;
            ">
              No Video Track
            </div>
          `;

      // Update timeline
      this.fitToView();
      this.updateTimelineRuler();

      // Generate waveform
      setTimeout(() => {
        this.generateAudioWaveform();
      }, 100);

      this.showToast('success', 'Audio loaded in audio-only mode');

      // Load audio for Web Audio scrubbing
      this.loadScrubAudio(filePath);

      // STRONGLY ENCOURAGE TRANSCRIPTION - show after a brief delay
      setTimeout(() => {
        this.showTranscriptionPrompt();
      }, 1500);
    } catch (error) {
      console.error('Error loading audio:', error);
      this.showToast('error', 'Failed to load audio: ' + error.message);
    }
  },

  // Setup controls for audio-only playback
  setupAudioOnlyControls(audioEl) {
    const video = document.getElementById('videoPlayer');

    // Override video player methods to use audio element
    this._originalVideoElement = video;
    this._audioOnlyElement = audioEl;

    // Sync time updates
    audioEl.addEventListener('timeupdate', () => {
      const currentTime = audioEl.currentTime;
      document.getElementById('currentTime').textContent = this.formatTime(currentTime);
      this.updatePlayhead(currentTime, audioEl.duration);
      this.updateWaveformPlayhead();

      // Update transcript/teleprompter
      if (this.teleprompterVisible && this.transcriptSegments) {
        this.updateTeleprompterHighlight(currentTime);
      }
    });

    audioEl.addEventListener('loadedmetadata', () => {
      document.getElementById('duration').textContent = this.formatTime(audioEl.duration);
      document.getElementById('timelineEnd').textContent = this.formatTime(audioEl.duration);
      this.updateTimelineRuler();
    });

    audioEl.addEventListener('play', () => {
      this.isPlaying = true;
      this.updatePlayButtonIcon(true);
    });

    audioEl.addEventListener('pause', () => {
      this.isPlaying = false;
      this.updatePlayButtonIcon(false);
    });

    audioEl.addEventListener('ended', () => {
      this.isPlaying = false;
      this.updatePlayButtonIcon(false);
    });
  },

  // Get the active media element (video or audio)
  getMediaElement() {
    if (this.isAudioOnlyMode && this._audioOnlyElement) {
      return this._audioOnlyElement;
    }
    return document.getElementById('videoPlayer');
  },

  showAddVideoOptions() {
    document.getElementById('addVideoOptions').style.display = 'block';
  },

  hideAddVideoOptions() {
    document.getElementById('addVideoOptions').style.display = 'none';
    document.getElementById('colorPickerSection').style.display = 'none';
  },

  async addVideoFromImage() {
    document.getElementById('audioOnlyModal').style.display = 'none';

    try {
      const result = await window.videoEditor.selectImage();
      if (result && result.filePath) {
        this.showToast('info', 'Creating video from image + audio...');
        await this.createVideoFromAudioAndImage(this.pendingAudioFile, result.filePath);
      }
    } catch (error) {
      console.error('Error selecting image:', error);
      this.showToast('error', 'Failed to select image');
      this.showAudioOnlyModal();
    }
  },

  addVideoFromColor() {
    document.getElementById('colorPickerSection').style.display = 'block';
  },

  selectVideoColor(color) {
    this.selectedVideoColor = color;
    // Update visual selection
    document.querySelectorAll('.color-preset').forEach((el) => {
      el.style.borderColor = el.dataset.color === color ? 'var(--accent)' : 'var(--border-color)';
    });
  },

  async createVideoFromColor() {
    document.getElementById('audioOnlyModal').style.display = 'none';

    this.showToast('info', 'Creating video with color background...');

    try {
      const result = await window.videoEditor.createVideoFromAudio(this.pendingAudioFile, {
        type: 'color',
        color: this.selectedVideoColor,
        resolution: '1920x1080',
      });

      if (result && result.outputPath) {
        this.pendingAudioFile = null;
        this.showToast('success', 'Video created successfully!');
        this.loadVideo(result.outputPath);
      } else {
        throw new Error(result?.error || 'Failed to create video');
      }
    } catch (error) {
      console.error('Error creating video from color:', error);
      this.showToast('error', 'Failed to create video: ' + error.message);
    }
  },

  async addVideoFromSlideshow() {
    document.getElementById('audioOnlyModal').style.display = 'none';

    try {
      const result = await window.videoEditor.selectImages();
      if (result && result.filePaths && result.filePaths.length > 0) {
        this.showToast('info', `Creating slideshow from ${result.filePaths.length} images...`);
        await this.createVideoFromAudioAndSlideshow(this.pendingAudioFile, result.filePaths);
      }
    } catch (error) {
      console.error('Error selecting images:', error);
      this.showToast('error', 'Failed to select images');
      this.showAudioOnlyModal();
    }
  },

  async createVideoFromAudioAndImage(audioPath, imagePath) {
    try {
      const result = await window.videoEditor.createVideoFromAudio(audioPath, {
        type: 'image',
        imagePath: imagePath,
        resolution: '1920x1080',
      });

      if (result && result.outputPath) {
        this.pendingAudioFile = null;
        this.showToast('success', 'Video created successfully!');
        this.loadVideo(result.outputPath);
      } else {
        throw new Error(result?.error || 'Failed to create video');
      }
    } catch (error) {
      console.error('Error creating video from image:', error);
      this.showToast('error', 'Failed to create video: ' + error.message);
    }
  },

  async createVideoFromAudioAndSlideshow(audioPath, imagePaths) {
    try {
      const result = await window.videoEditor.createVideoFromAudio(audioPath, {
        type: 'slideshow',
        imagePaths: imagePaths,
        resolution: '1920x1080',
        transitionDuration: 1, // 1 second crossfade between images
      });

      if (result && result.outputPath) {
        this.pendingAudioFile = null;
        this.showToast('success', 'Slideshow video created successfully!');
        this.loadVideo(result.outputPath);
      } else {
        throw new Error(result?.error || 'Failed to create slideshow');
      }
    } catch (error) {
      console.error('Error creating slideshow:', error);
      this.showToast('error', 'Failed to create slideshow: ' + error.message);
    }
  },

  // Show transcription prompt (for audio-only and video files without transcript)
  showTranscriptionPrompt() {
    // Don't show if already transcribed
    if (this.transcriptSegments && this.transcriptSegments.length > 0) {
      return;
    }

    // Show a more prominent toast for audio files
    if (this.isAudioOnlyMode) {
      this.showToast('info', '🎤 Transcription recommended! Click the button above or press T to begin.', 5000);
    }
  },

  // Hide the transcription CTA (called after transcription completes)
  hideTranscriptionCTA() {
    const cta = document.getElementById('audioTranscriptionCTA');
    if (cta) {
      cta.style.transition = 'opacity 0.3s, transform 0.3s';
      cta.style.opacity = '0';
      cta.style.transform = 'scale(0.95)';
      setTimeout(() => {
        cta.style.display = 'none';
      }, 300);
    }
  },

  // Update audio placeholder to show transcription status
  updateAudioPlaceholderForTranscript() {
    const placeholder = document.getElementById('videoPlaceholder');
    if (!placeholder || !this.isAudioOnlyMode) return;

    const cta = document.getElementById('audioTranscriptionCTA');
    if (cta && this.transcriptSegments && this.transcriptSegments.length > 0) {
      // Replace CTA with transcript info
      cta.innerHTML = `
            <div style="font-size: 28px; margin-bottom: 12px;">✅</div>
            <div style="font-size: 16px; font-weight: 600; margin-bottom: 8px; color: #22c55e;">
              Transcribed!
            </div>
            <div style="font-size: 13px; color: rgba(255,255,255,0.8); margin-bottom: 12px;">
              ${this.transcriptSegments.length} words • ${this.transcriptSource || 'AI'} transcription
            </div>
            <button onclick="app.toggleTeleprompter()" style="
              background: transparent;
              color: #22c55e;
              border: 1px solid #22c55e;
              padding: 8px 20px;
              border-radius: 6px;
              font-size: 13px;
              cursor: pointer;
            ">
              Show Transcript (T)
            </button>
          `;
      cta.style.borderColor = 'rgba(34, 197, 94, 0.5)';
      cta.style.background = 'linear-gradient(135deg, rgba(34, 197, 94, 0.2) 0%, rgba(22, 163, 74, 0.2) 100%)';
    }
  },

  // ==================== END AUDIO-ONLY FILE HANDLING ====================

  // Thumbnail strips for different zoom tiers
  thumbnailStrips: {}, // { tier1: dataURL, tier2: dataURL, ... }
  thumbnailStripCounts: {}, // { tier1: count, tier2: count, ... }
  thumbnailStripDuration: 0, // Video duration
  currentThumbnailTier: null, // Currently displayed tier

  // Zoom tier definitions: { maxZoom, thumbCount }
  // Formula: thumbCount = (baseWidth * zoom) / idealThumbWidth
  // Where idealThumbWidth = containerHeight * (16/9) ≈ 50 * 1.78 = 89px
  // baseWidth ≈ 1300px
  // Simplified to 2 tiers: quick preview + full detail
  // Browser interpolation handles zoom scaling well
  zoomTiers: [
    { name: 'preview', maxZoom: 5, count: 50 }, // Quick load, overview
    { name: 'detail', maxZoom: Infinity, count: 300 }, // Full detail for all zoom levels
  ],

  // Get the appropriate tier for current zoom
  getTierForZoom(zoom) {
    for (const tier of this.zoomTiers) {
      if (zoom <= tier.maxZoom) return tier;
    }
    return this.zoomTiers[this.zoomTiers.length - 1];
  },

  // Load timeline thumbnails - generates strips for all tiers
  async loadTimelineThumbnails() {
    const container = document.getElementById('timelineThumbnails');
    const clip = document.getElementById('videoClip');
    if (!container || !clip) {
      console.warn('[Thumbnails] Container or clip element not found, retrying in 200ms');
      // Retry once after DOM settles
      if (!this._thumbnailRetryCount) {
        this._thumbnailRetryCount = 1;
        setTimeout(() => {
          this._thumbnailRetryCount = 0;
          this.loadTimelineThumbnails();
        }, 200);
      } else {
        console.error('[Thumbnails] Retry failed - DOM elements not found');
        this._thumbnailRetryCount = 0;
      }
      return;
    }

    if (!this.videoPath) {
      console.warn('[Thumbnails] No video path set');
      return;
    }

    const video = document.getElementById('videoPlayer');
    const duration = this.videoInfo?.duration || video?.duration || 0;

    if (!duration || duration <= 0 || isNaN(duration)) {
      console.warn('[Thumbnails] Invalid duration:', duration, '- waiting for video metadata');
      // Duration might not be available yet, retry when video loads
      return;
    }

    console.log(
      '[Thumbnails] Starting load for',
      this.videoPath?.split('/').pop(),
      'duration:',
      duration.toFixed(2) + 's'
    );

    // Check if we already have strips in memory for this video
    const cacheKey = `${this.videoPath}_strips`;
    if (this.thumbnailCache[cacheKey] && this.thumbnailStripDuration === duration) {
      this.thumbnailStrips = this.thumbnailCache[cacheKey].strips;
      this.thumbnailStripCounts = this.thumbnailCache[cacheKey].counts;
      this.applyThumbnailStrip(container, duration);
      return;
    }

    container.classList.add('loading');
    this.thumbnailStripDuration = duration;

    // Try to load pre-saved strip IMAGES from disk first (fastest)
    try {
      console.log('[Thumbnails] Checking for saved strip images for:', this.videoPath);
      let loadedAny = false;

      for (const tier of this.zoomTiers) {
        try {
          console.log(`[Thumbnails] Trying to load ${tier.name} strip...`);
          const result = await window.videoEditor.loadThumbnailStrip(this.videoPath, tier.name);
          console.log(`[Thumbnails] Load result for ${tier.name}:`, result?.exists, result?.error);

          if (result && result.exists && result.dataUrl) {
            this.thumbnailStrips[tier.name] = result.dataUrl;
            // Estimate count from image width (each thumb is 160px)
            const img = new Image();
            await new Promise((resolve, reject) => {
              img.onload = resolve;
              img.onerror = reject;
              img.src = result.dataUrl;
            });
            this.thumbnailStripCounts[tier.name] = Math.round(img.width / 160);
            loadedAny = true;
            console.log(
              `[Thumbnails] Loaded ${tier.name} strip from disk: ${this.thumbnailStripCounts[tier.name]} frames`
            );
          }
        } catch (e) {
          console.log(`[Thumbnails] Failed to load ${tier.name}:`, e.message);
        }
      }

      if (loadedAny) {
        // Cache in memory
        this.thumbnailCache[cacheKey] = {
          strips: this.thumbnailStrips,
          counts: this.thumbnailStripCounts,
        };
        this.applyThumbnailStrip(container, duration);
        container.classList.remove('loading');
        console.log('[Thumbnails] ✓ Loaded from saved strip images');
        return;
      } else {
        console.log('[Thumbnails] No cached strips found, will generate new ones');
      }
    } catch (e) {
      console.log('[Thumbnails] Error checking cache:', e.message);
    }

    // Fallback: Check JSON cache with thumbnail paths
    try {
      const diskCache = await window.videoEditor.loadThumbnailCache(this.videoPath);
      if (diskCache && diskCache.exists && diskCache.tiers) {
        console.log('[Thumbnails] Found path cache, rebuilding strips...');

        // Build strips from cached thumbnail paths
        let loadedAny = false;
        for (const tierName of Object.keys(diskCache.tiers)) {
          const paths = diskCache.tiers[tierName];
          if (paths && paths.length > 0) {
            try {
              await this.createThumbnailStrip(tierName, paths, true); // true = save to disk
              loadedAny = true;
              console.log(`[Thumbnails] Rebuilt ${tierName} from cached paths`);
            } catch (e) {
              console.warn(`[Thumbnails] Failed to rebuild ${tierName}:`, e);
            }
          }
        }

        if (loadedAny) {
          // Cache in memory
          this.thumbnailCache[cacheKey] = {
            strips: this.thumbnailStrips,
            counts: this.thumbnailStripCounts,
          };
          this.applyThumbnailStrip(container, duration);
          container.classList.remove('loading');
          return;
        }
      }
    } catch (_e) {
      console.log('[Thumbnails] No path cache found, will generate from scratch');
    }

    // Generate strips for each tier (and save to disk)
    console.log(`[Thumbnails] Generating strips for ${this.zoomTiers.length} zoom tiers`);

    const generatedTiers = {};
    const generatedCounts = {};

    try {
      // Start with tier1 immediately so user sees something
      const tier1 = this.zoomTiers[0];
      const tier1Thumbs = await window.videoEditor.getTimelineThumbnails(this.videoPath, { count: tier1.count });
      if (tier1Thumbs && !tier1Thumbs.error && tier1Thumbs.length > 0) {
        await this.createThumbnailStrip(tier1.name, tier1Thumbs, true); // Save to disk
        generatedTiers[tier1.name] = tier1Thumbs;
        generatedCounts[tier1.name] = tier1Thumbs.length;
        this.applyThumbnailStrip(container, duration);
      }

      // Generate other tiers in background
      for (let i = 1; i < this.zoomTiers.length; i++) {
        const tier = this.zoomTiers[i];
        // Cap count based on duration (no point having more thumbs than seconds)
        const count = Math.min(tier.count, Math.ceil(duration));
        const thumbs = await window.videoEditor.getTimelineThumbnails(this.videoPath, { count });
        if (thumbs && !thumbs.error && thumbs.length > 0) {
          await this.createThumbnailStrip(tier.name, thumbs, true); // Save to disk
          generatedTiers[tier.name] = thumbs;
          generatedCounts[tier.name] = thumbs.length;
          console.log(`[Thumbnails] ${tier.name} ready: ${thumbs.length} frames`);
        }
      }

      // Cache in memory
      this.thumbnailCache[cacheKey] = {
        strips: this.thumbnailStrips,
        counts: this.thumbnailStripCounts,
      };

      // Save paths to disk cache (as backup)
      try {
        await window.videoEditor.saveThumbnailCache(this.videoPath, {
          tiers: generatedTiers,
          counts: generatedCounts,
          duration: duration,
          generatedAt: new Date().toISOString(),
        });
        console.log('[Thumbnails] Saved cache metadata to disk');
      } catch (e) {
        console.warn('[Thumbnails] Failed to save cache metadata:', e);
      }

      // Apply best tier for current zoom
      this.applyThumbnailStrip(container, duration);
    } catch (error) {
      console.error('[Thumbnails] Error:', error);
    } finally {
      container.classList.remove('loading');
    }
  },

  // Create a strip for a specific tier
  async createThumbnailStrip(tierName, thumbnailPaths, saveToDisk = false) {
    const thumbWidth = 160;
    const thumbHeight = 90;

    const canvas = document.createElement('canvas');
    canvas.width = thumbWidth * thumbnailPaths.length;
    canvas.height = thumbHeight;
    const ctx = canvas.getContext('2d');

    const loadImage = (src) =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = pathToFileUrl(src);
      });

    for (let i = 0; i < thumbnailPaths.length; i++) {
      try {
        const img = await loadImage(thumbnailPaths[i]);
        ctx.drawImage(img, i * thumbWidth, 0, thumbWidth, thumbHeight);
      } catch (_e) {
        ctx.fillStyle = '#2a4a6a';
        ctx.fillRect(i * thumbWidth, 0, thumbWidth, thumbHeight);
      }
    }

    const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
    this.thumbnailStrips[tierName] = dataUrl;
    this.thumbnailStripCounts[tierName] = thumbnailPaths.length;
    console.log(`[Thumbnails] Created ${tierName} strip: ${canvas.width}x${canvas.height}px`);

    // Save strip image to disk for faster loading next time
    if (saveToDisk && this.videoPath) {
      try {
        await window.videoEditor.saveThumbnailStrip(this.videoPath, tierName, dataUrl);
        console.log(`[Thumbnails] Saved ${tierName} strip to disk`);
      } catch (e) {
        console.warn(`[Thumbnails] Failed to save ${tierName} strip:`, e);
      }
    }
  },

  // Apply the appropriate strip for current zoom
  applyThumbnailStrip(container, _duration) {
    if (!container) {
      console.warn('[Thumbnails] applyThumbnailStrip called with no container');
      return;
    }

    const tier = this.getTierForZoom(this.timelineZoom);
    const strip = this.thumbnailStrips[tier.name];
    const count = this.thumbnailStripCounts[tier.name];

    // Fall back to any available strip if preferred tier not ready
    let activeTier = tier.name;
    let activeStrip = strip;
    let activeCount = count;

    if (!activeStrip) {
      for (const t of this.zoomTiers) {
        if (this.thumbnailStrips[t.name]) {
          activeTier = t.name;
          activeStrip = this.thumbnailStrips[t.name];
          activeCount = this.thumbnailStripCounts[t.name];
          break;
        }
      }
    }

    if (!activeStrip) {
      console.warn('[Thumbnails] No thumbnail strip available to apply');
      return;
    }

    console.log('[Thumbnails] Applying strip:', activeTier, 'with', activeCount, 'frames');

    const clip = container.parentElement;
    const clipWidth = clip?.offsetWidth || 800;
    const containerHeight = container.offsetHeight || 50;

    // Each thumbnail in the strip is 160x90 (16:9 aspect ratio)
    // The strip image dimensions: (160 * activeCount) x 90
    //
    // To display without stretching while filling the timeline:
    // - Height must match container height
    // - Width scales proportionally to maintain 16:9 per thumbnail

    const thumbAspect = 160 / 90;
    const scaledThumbWidth = containerHeight * thumbAspect; // Width of one thumb at container height
    const naturalStripWidth = scaledThumbWidth * activeCount;

    // Scale factor to fit the clip width
    // If naturalStripWidth < clipWidth, thumbnails would be too narrow (gaps at end)
    // If naturalStripWidth > clipWidth, thumbnails extend past visible area (ok, they scroll)
    //
    // For timeline alignment, we want the strip to match the clip width
    // But to avoid excessive stretching, limit the stretch ratio
    const maxStretch = 1.5; // Don't stretch thumbnails more than 50%
    const minStretch = 0.7; // Don't compress more than 30%

    let bgWidth = clipWidth;
    let bgHeight = containerHeight;

    const stretchRatio = clipWidth / naturalStripWidth;

    if (stretchRatio > maxStretch) {
      // Would stretch too much - use natural width, thumbnails won't fill timeline
      bgWidth = naturalStripWidth;
      console.log(`[Thumbnails] Limiting stretch: ${stretchRatio.toFixed(2)}x → using natural width`);
    } else if (stretchRatio < minStretch) {
      // Would compress too much - use natural width
      bgWidth = naturalStripWidth;
      console.log(`[Thumbnails] Limiting compression: ${stretchRatio.toFixed(2)}x → using natural width`);
    }

    container.style.backgroundImage = `url(${activeStrip})`;
    container.style.backgroundSize = `${bgWidth}px ${bgHeight}px`;
    container.style.backgroundRepeat = 'no-repeat';
    container.style.backgroundPosition = 'left center';
    container.innerHTML = '';

    this.currentThumbnailTier = activeTier;
  },

  /**
   * Update time display and playhead position.
   *
   * CRITICAL ALIGNMENT: Playhead position must be calculated using rulerMarks
   * coordinate system, then converted to the clip's coordinate space.
   * This ensures the playhead aligns with the ruler timecode display.
   *
   * Formula: playheadLeft = rulerX + rulerRect.left - clipRect.left
   * Where rulerX = (currentTime / duration) * rulerRect.width
   */
  updateTimeDisplay() {
    const video = document.getElementById('videoPlayer');
    // When detached, use the time from detached window (video.currentTime stays frozen)
    const currentTime =
      this.videoDetached && this.detachedVideoTime !== undefined ? this.detachedVideoTime : video.currentTime;
    const duration = video.duration || 0;

    document.getElementById('currentTime').textContent = this.formatTime(currentTime);

    // IMPORTANT: Calculate playhead position using ruler coordinate system
    const rulerMarks = document.getElementById('rulerMarks');
    const clip = document.getElementById('videoClip');
    const playhead = document.getElementById('playhead');
    const progress = document.getElementById('timelineProgress');
    const globalPlayhead = document.getElementById('globalPlayhead');
    const timelineContent = document.getElementById('timelineContent');
    const trackLabel = document.querySelector('.track-label');

    if (rulerMarks && clip && duration > 0) {
      const rulerRect = rulerMarks.getBoundingClientRect();
      const clipRect = clip.getBoundingClientRect();

      // Calculate position on ruler, then convert to clip's coordinate space
      const rulerX = (currentTime / duration) * rulerRect.width;
      const playheadLeft = rulerX + rulerRect.left - clipRect.left;

      playhead.style.left = `${playheadLeft}px`;
      progress.style.width = `${playheadLeft}px`;

      // Update global playhead position (spans all tracks)
      if (globalPlayhead && timelineContent) {
        const contentRect = timelineContent.getBoundingClientRect();
        const globalLeft = rulerX + rulerRect.left - contentRect.left;
        globalPlayhead.style.left = `${globalLeft}px`;
        globalPlayhead.style.marginLeft = '0'; // Remove margin since we're calculating exact position
      }
    } else {
      const percent = (currentTime / duration) * 100;
      playhead.style.left = `${percent}%`;
      progress.style.width = `${percent}%`;

      // Fallback for global playhead
      if (globalPlayhead) {
        const trackLabelWidth = trackLabel ? trackLabel.getBoundingClientRect().width : 120;
        globalPlayhead.style.left = `calc(${trackLabelWidth}px + ${percent}%)`;
        globalPlayhead.style.marginLeft = '0';
      }
    }
  },

  // Update trim region visualization
  updateTrimRegion() {
    const video = document.getElementById('videoPlayer');
    const duration = video.duration || this.videoInfo?.duration || 0;

    const region = document.getElementById('trimRegion');
    const startMarker = document.getElementById('trimMarkerStart');
    const endMarker = document.getElementById('trimMarkerEnd');

    // Update selected region and show action bar
    this.updateSelectedRegion();

    // Hide trim region if not active (trimEnd is 0 or equals duration with trimStart at 0)
    const noTrim = !this.trimActive || this.trimEnd === 0 || (this.trimStart === 0 && this.trimEnd >= duration);

    if (noTrim || duration === 0) {
      region.style.display = 'none';
      startMarker.style.display = 'none';
      endMarker.style.display = 'none';
      return;
    }

    region.style.display = 'block';
    startMarker.style.display = 'block';
    endMarker.style.display = 'block';

    const startPercent = (this.trimStart / duration) * 100;
    const endPercent = (this.trimEnd / duration) * 100;

    region.style.left = `${startPercent}%`;
    region.style.width = `${endPercent - startPercent}%`;
    startMarker.style.left = `${startPercent}%`;
    endMarker.style.left = `${endPercent}%`;
  },

  // Playback controls
  togglePlay() {
    const media = this.getMediaElement();
    if (!media) return;

    // When detached, the detached window is the actual player.
    if (this.videoDetached) {
      const playing = !(this.detachedVideoPlaying === true);
      window.videoEditor
        .syncPlayback({
          currentTime: media.currentTime,
          playing,
          playbackRate: media.playbackRate,
        })
        .catch((err) => console.warn('[video-editor-app] syncPlayback to detached:', err.message));
      this.detachedVideoPlaying = playing;
      return;
    }

    const hasSource = !!(media.currentSrc || media.src);
    if (!hasSource) return;

    if (media.paused) {
      media.play().catch((err) => console.warn('[video-editor-app] media.play:', err.message));
    } else {
      media.pause();
    }
  },

  skipBack() {
    const media = this.getMediaElement();
    if (!media) return;
    media.currentTime = Math.max(0, media.currentTime - 10);
    this.syncToDetachedWindow();
  },

  skipForward() {
    const media = this.getMediaElement();
    if (!media) return;
    media.currentTime = Math.min(media.duration, media.currentTime + 10);
    this.syncToDetachedWindow();
  },

  toggleMute() {
    // With Guide+Master architecture, toggling mute toggles the Guide track
    const guideTrack = this.getGuideTrack?.();
    if (guideTrack) {
      this.toggleGuideTrackMute();
    } else {
      // Fallback: toggle video mute directly
      const media = this.getMediaElement();
      if (!media) return;
      media.muted = !media.muted;
      this.updateMuteIcon();
    }
  },

  updateMuteIcon() {
    const media = this.getMediaElement();
    if (!media) return;
    const muteBtn = document.getElementById('muteBtn');
    if (media.muted || media.volume === 0) {
      muteBtn.textContent = '🔇';
    } else if (media.volume < 0.5) {
      muteBtn.textContent = '🔉';
    } else {
      muteBtn.textContent = '🔊';
    }
  },

  // Update play button icon (SVG-based to match HTML)
  updatePlayButtonIcon(isPlaying) {
    const playBtn = document.getElementById('playBtn');
    if (!playBtn) return;

    if (isPlaying) {
      // Pause icon (two vertical bars)
      playBtn.innerHTML =
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
    } else {
      // Play icon (triangle pointing right)
      playBtn.innerHTML =
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    }
  },

  // ============================================
  // AUDIO WAVEFORM - Web Audio API + ffmpeg.wasm
  // ============================================

  // Tiered waveform cache - different resolutions for different zoom levels
  waveformTiers: null, // { tier1: peaks[], tier2: peaks[], ... }
  waveformImages: null, // { bars_50: dataURL, mirror_50: dataURL, ... } - cached rendered images
  waveformMasterPeaks: null, // Full resolution peaks (500/sec)
  waveformCachePath: null,
  waveformDuration: 0,

  // Waveform tier definitions (samples per second for each zoom level)
  waveformTierDefs: [
    { maxZoom: 1, samplesPerSec: 50 }, // Fit view - low detail
    { maxZoom: 2, samplesPerSec: 100 }, // 2x zoom
    { maxZoom: 5, samplesPerSec: 200 }, // 5x zoom
    { maxZoom: 10, samplesPerSec: 350 }, // 10x zoom
    { maxZoom: 20, samplesPerSec: 500 }, // 15x-20x zoom - full detail
  ],

  // Note: audioBuffer is used for spectrogram (set by extractAudioPeaksWebAudio)
  audioContext: null,
  waveformType: 'spectrogram', // 'bars', 'line', 'mirror', 'spectrogram' - spectrum is default

  // Open waveform settings modal
  openWaveformSettings() {
    const modal = document.getElementById('waveformSettingsModal');
    if (modal) {
      modal.style.display = 'flex';
      // Add visible class for CSS animation
      requestAnimationFrame(() => {
        modal.classList.add('visible');
      });
      // Update active state
      document.querySelectorAll('.waveform-option-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.type === this.waveformType);
      });
      // Close on click outside
      modal.onclick = (e) => {
        if (e.target === modal) this.closeWaveformSettings();
      };
      console.log('[Waveform] Settings modal opened');
    }
  },

  // ============================================
  // DETACHABLE VIDEO PLAYER
  // ============================================

  async detachVideoPlayer() {
    if (this.videoDetached || !this.videoPath) {
      console.log('[VideoEditor] Cannot detach - already detached or no video');
      return;
    }

    const video = document.getElementById('videoPlayer');
    if (!video) return;

    try {
      // Setup listeners BEFORE detaching to avoid race condition
      // where detached window sends updates before we're ready to receive them
      this.setupDetachedListeners();

      // Detach to new window
      // Use video.src which has the proper file:// protocol
      const videoSrc = video.src || pathToFileUrl(this.videoPath);
      const wasPlaying = !video.paused;
      const playbackRate = video.playbackRate || 1;
      const result = await window.videoEditor.detachVideoPlayer(videoSrc, video.currentTime, wasPlaying, playbackRate);

      if (result.success) {
        this.videoDetached = true;
        this.detachedVideoPlaying = wasPlaying; // Preserve original play state

        // Store video state for later restoration
        this.detachedVideoSrc = videoSrc;
        this.detachedVideoTime = video.currentTime;

        // Pause the main window video so audio/video doesn't double-play.
        // NOTE: We intentionally keep `video.src` loaded so the main UI can still scrub/seek
        // and drive the detached window (clearing src breaks the timeline/playhead controls).
        video.pause();

        // Hide the video in main window
        const videoContainer = document.getElementById('videoContainer');
        if (videoContainer) {
          videoContainer.classList.add('video-detached');
        }

        // Update the detach button to show "attach" icon (arrow pointing into window)
        const detachBtn = document.getElementById('detachVideoBtn');
        if (detachBtn) {
          detachBtn.innerHTML =
            '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><polyline points="9 12 12 15 15 12"/><line x1="12" y1="8" x2="12" y2="15"/></svg>';
          detachBtn.title = 'Attach video (bring back to main window)';
          detachBtn.classList.add('attached-mode');
        }

        // Force an initial teleprompter highlight update
        if (this.teleprompterVisible && this.teleprompterWords) {
          this.updateTeleprompterHighlight(video.currentTime);
        }

        console.log('[VideoEditor] Video player detached (main video paused, teleprompter synced)');
      } else {
        // Detach failed - cleanup listeners
        this.detachedCleanupFns.forEach((fn) => fn());
        this.detachedCleanupFns = [];
      }
    } catch (error) {
      console.error('[VideoEditor] Error detaching video:', error);
      if (window.api && window.api.log) {
        window.api.log.error('Video editor detach video failed', {
          error: error.message,
          operation: 'detachVideo',
        });
      }
      // Cleanup listeners on error
      this.detachedCleanupFns.forEach((fn) => fn());
      this.detachedCleanupFns = [];
    }
  },

  async attachVideoPlayer() {
    if (!this.videoDetached) {
      console.log('[VideoEditor] Cannot attach - not detached');
      return;
    }

    try {
      // Close detached window
      await window.videoEditor.attachVideoPlayer();

      // Will be handled by onPlayerAttached listener
    } catch (error) {
      console.error('[VideoEditor] Error attaching video:', error);
      if (window.api && window.api.log) {
        window.api.log.error('Video editor attach video failed', {
          error: error.message,
          operation: 'attachVideo',
        });
      }
      // Force cleanup
      this.handlePlayerAttached();
    }
  },

  handlePlayerAttached() {
    this.videoDetached = false;

    // Cleanup listeners
    this.detachedCleanupFns.forEach((fn) => fn());
    this.detachedCleanupFns = [];

    // Restore video source in main window
    const video = document.getElementById('videoPlayer');
    if (video && this.detachedVideoSrc) {
      video.src = this.detachedVideoSrc;
      video.load();
      // Restore position after video loads
      video.addEventListener(
        'loadedmetadata',
        () => {
          if (this.detachedVideoTime) {
            video.currentTime = this.detachedVideoTime;
          }
        },
        { once: true }
      );
      console.log('[VideoEditor] Restored main video source');
    }

    // Clear stored state
    this.detachedVideoSrc = null;
    this.detachedVideoTime = null;

    // Show the video in main window
    const videoContainer = document.getElementById('videoContainer');
    if (videoContainer) {
      videoContainer.classList.remove('video-detached');
    }

    // Update the detach button to show "detach" icon (arrow pointing out of window)
    const detachBtn = document.getElementById('detachVideoBtn');
    if (detachBtn) {
      detachBtn.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><polyline points="9 12 12 9 15 12"/><line x1="12" y1="9" x2="12" y2="16"/></svg>';
      detachBtn.title = 'Detach video to separate window';
      detachBtn.classList.remove('attached-mode');
    }

    console.log('[VideoEditor] Video player attached');
  },

  setupDetachedListeners() {
    // Clean up any existing listeners first to avoid duplicates
    if (this.detachedCleanupFns && this.detachedCleanupFns.length > 0) {
      this.detachedCleanupFns.forEach((fn) => fn());
      this.detachedCleanupFns = [];
    }

    // Listen for detached window close
    const cleanupAttached = window.videoEditor.onPlayerAttached(() => {
      this.handlePlayerAttached();
    });
    this.detachedCleanupFns.push(cleanupAttached);

    // Listen for time updates from detached window
    const cleanupTime = window.videoEditor.onDetachedTimeUpdate((currentTime) => {
      // Store the time from detached player
      this.detachedVideoTime = currentTime;

      // Debug: log detached time updates (every second)
      if (this._lastDetachedLogTime === undefined || Math.abs(currentTime - this._lastDetachedLogTime) > 1) {
        console.log(
          '[DetachedSync] Time update:',
          currentTime.toFixed(2),
          'teleprompterVisible:',
          this.teleprompterVisible,
          'words:',
          this.teleprompterWords?.length || 0,
          'DOM words:',
          document.querySelectorAll('.teleprompter-word').length
        );
        this._lastDetachedLogTime = currentTime;
      }

      // Update teleprompter highlighting to stay in sync with detached video
      // Force update even if teleprompter module thinks it shouldn't (detached mode)
      if (this.teleprompterWords && this.teleprompterWords.length > 0) {
        this.updateTeleprompterHighlight(currentTime);
      }

      // Also update waveform playhead for visual consistency
      this.updateWaveformPlayhead();

      // Update time display and audio playhead
      this.updateTimeDisplay();
      this.updateAudioPlayhead();
    });
    this.detachedCleanupFns.push(cleanupTime);

    // Listen for play state changes from detached window
    const cleanupPlay = window.videoEditor.onDetachedPlayState((playing) => {
      this.detachedVideoPlaying = !!playing;
      console.log('[DetachedSync] Play state:', playing ? 'playing' : 'paused');
    });
    this.detachedCleanupFns.push(cleanupPlay);

    console.log('[DetachedSync] Listeners set up, ready to receive time updates');
  },

  toggleDetachVideo() {
    if (this.videoDetached) {
      this.attachVideoPlayer();
    } else {
      this.detachVideoPlayer();
    }
  },

  // Sync state to detached window (called when seek in main window)
  // NOTE: This only syncs TIME, not play state. Use togglePlay for play/pause.
  syncToDetachedWindow() {
    if (!this.videoDetached) return;

    const video = document.getElementById('videoPlayer');
    if (!video) return;

    // Only sync currentTime - preserve whatever play state the detached window has.
    // Main video is always paused when detached, so we use stored detachedVideoPlaying.
    window.videoEditor
      .syncPlayback({
        currentTime: video.currentTime,
        playing: this.detachedVideoPlaying === true,
        playbackRate: video.playbackRate,
      })
      .catch((err) => console.warn('[video-editor-app] syncPlayback (syncToDetached):', err.message));
  },

  // Close waveform settings modal
  closeWaveformSettings() {
    const modal = document.getElementById('waveformSettingsModal');
    if (modal) {
      modal.classList.remove('visible');
      // Wait for animation to complete before hiding
      setTimeout(() => {
        modal.style.display = 'none';
      }, 200);
    }
  },

  // Set waveform visualization type
  setWaveformType(type) {
    this.waveformType = type;

    // Update modal button states
    document.querySelectorAll('.waveform-option-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.type === type);
    });

    // Expand track for spectrogram
    const audioTrack = document.getElementById('audioTrackContainer');
    if (audioTrack) {
      audioTrack.classList.toggle('expanded', type === 'spectrogram');
    }

    // Close modal after selection
    this.closeWaveformSettings();

    // Redraw waveform with new type
    this.generateAudioWaveform();
  },

  // Transcribe audio to show words on waveform
  async transcribeForWaveform() {
    if (!this.videoPath) return;

    const btn = document.getElementById('waveformTranscribeBtn');
    const teleprompterBtn = document.querySelector('.teleprompter-transcribe-btn');
    btn.textContent = '⏳ 0%';
    btn.disabled = true;
    if (teleprompterBtn) {
      teleprompterBtn.textContent = '⏳';
      teleprompterBtn.disabled = true;
    }

    // Listen for progress updates to update teleprompter live
    let removeProgressListener = null;
    if (window.videoEditor.onTranscriptionProgress) {
      removeProgressListener = window.videoEditor.onTranscriptionProgress((progress) => {
        console.log(
          `[Waveform] Chunk ${progress.chunkIndex + 1}/${progress.totalChunks} complete: ${progress.chunkWords.length} words`
        );

        // Update button with progress
        const pct = Math.round(progress.progress);
        btn.textContent = `⏳ ${pct}%`;

        // Update transcript segments with all words so far
        if (progress.allWords && progress.allWords.length > 0) {
          this.transcriptSegments = progress.allWords.map((w) => ({
            text: w.text,
            start: w.start,
            end: w.end,
          }));
          this.transcriptSource = 'elevenlabs-scribe'; // Mark as Scribe (in progress)

          // Refresh teleprompter live if visible
          if (this.teleprompterVisible) {
            this.initTeleprompter();
          }
        }
      });
    }

    try {
      // First, extract audio from video for transcription
      btn.textContent = '⏳ Extracting...';
      const audioResult = await window.videoEditor.extractAudio(this.videoPath, {
        format: 'mp3',
        startTime: 0,
        duration: this.videoInfo?.duration || null,
      });

      if (!audioResult.outputPath) {
        throw new Error('Failed to extract audio for transcription');
      }

      btn.textContent = '⏳ Transcribing...';

      // Use ElevenLabs Scribe for transcription (replaces Whisper)
      const result = await window.videoEditor.transcribeScribe(audioResult.outputPath, {
        languageCode: 'en',
        temperature: 0,
      });

      // Clean up progress listener
      if (removeProgressListener) {
        removeProgressListener();
      }

      console.log('[Waveform] Scribe transcription result:', result);

      if (result.success && (result.transcription || result.text)) {
        const transcriptText = result.transcription || result.text;

        // Store detected speakers
        this.transcriptSpeakers = result.speakers || [];
        console.log(
          '[Waveform] Detected speakers:',
          this.transcriptSpeakers.length > 0 ? this.transcriptSpeakers.join(', ') : 'none'
        );

        // Parse the transcription into segments with proper timestamps
        if (result.segments && result.segments.length > 0) {
          // Use segments with real timestamps from Scribe
          this.transcriptSegments = result.segments;
          this.transcriptSource = 'elevenlabs-scribe'; // ElevenLabs Scribe with accurate timestamps
          console.log('[Waveform] Using', result.segments.length, 'timed segments (ElevenLabs Scribe)');
        } else if (result.words && result.words.length > 0) {
          // Scribe word-level timestamps format
          this.transcriptSegments = result.words.map((w) => ({
            text: w.word || w.text,
            start: w.start,
            end: w.end,
            speakerId: w.speaker_id || w.speakerId,
          }));
          this.transcriptSource = 'elevenlabs-scribe'; // ElevenLabs Scribe with accurate timestamps
          console.log('[Waveform] Using', result.words.length, 'word timestamps (ElevenLabs Scribe)');
        } else {
          // Fallback: Create approximate segments from text (not accurate)
          console.warn('[Waveform] No timed segments - using even distribution (inaccurate)');
          const words = transcriptText.split(/\s+/).filter((w) => w.length > 0);
          const duration = this.videoInfo?.duration || 60;
          const wordDuration = duration / words.length;

          this.transcriptSegments = words.map((word, i) => ({
            text: word,
            start: i * wordDuration,
            end: (i + 1) * wordDuration,
          }));
          this.transcriptSource = 'evenly-distributed'; // Inaccurate fallback
        }

        // Update button state with speaker count
        const speakerInfo = this.transcriptSpeakers.length > 1 ? ` (${this.transcriptSpeakers.length} speakers)` : '';
        btn.textContent = `✓ ${this.transcriptSegments.length} words${speakerInfo}`;
        btn.classList.add('transcribed');
        btn.disabled = false;
        if (teleprompterBtn) {
          teleprompterBtn.textContent = '🎤';
          teleprompterBtn.disabled = false;
        }

        // Save transcription back to Space if this video is from a Space
        if (this.spaceItemId && window.clipboard?.updateMetadata) {
          try {
            const saveResult = await window.clipboard.updateMetadata(this.spaceItemId, {
              transcriptSegments: this.transcriptSegments,
              transcriptSpeakers: this.transcriptSpeakers,
              transcript: transcriptText,
              transcriptionSource: this.transcriptSource,
              transcriptionDate: new Date().toISOString(),
              language: result.language,
            });

            console.log('[Waveform] Saved transcription to Space item:', this.spaceItemId, saveResult);
          } catch (saveError) {
            console.warn('[Waveform] Could not save transcription to Space:', saveError.message);
          }
        }

        // Redraw waveform with words
        this.generateAudioWaveform();

        // Reinitialize teleprompter if visible
        if (this.teleprompterVisible) {
          this.initTeleprompter();
        }

        // Update audio-only placeholder if in audio mode
        if (this.isAudioOnlyMode) {
          this.updateAudioPlaceholderForTranscript();
        }

        // Auto-show teleprompter after transcription
        if (!this.teleprompterVisible) {
          this.toggleTeleprompter();
        }

        // Refresh Story Beats editor if it exists (so "Generate Script" works)
        if (this.storyBeatsEditor) {
          this.initStoryBeatsEditor?.();
          console.log('[Waveform] Refreshed Story Beats editor with new transcript');
        }

        this.showToast('success', `Transcribed ${this.transcriptSegments.length} words!`);
      } else {
        throw new Error(result.error || 'Transcription failed');
      }
    } catch (error) {
      // Clean up progress listener on error
      if (removeProgressListener) {
        removeProgressListener();
      }
      console.error('[Waveform] Transcription failed:', error);
      btn.textContent = '🎤 Transcribe';
      btn.disabled = false;
      if (teleprompterBtn) {
        teleprompterBtn.textContent = '🎤';
        teleprompterBtn.disabled = false;
      }
      btn.disabled = false;
      this.showToast('error', 'Transcription failed: ' + error.message);
    }
  },

  // Identify speaker names from existing transcription using LLM
  async identifySpeakersFromTranscript() {
    // Use teleprompterWords (expanded) or transcriptSegments (raw)
    const words = this.teleprompterWords || this.transcriptSegments || [];

    if (words.length === 0) {
      this.showToast('warning', 'No transcription available. Please transcribe first.');
      return;
    }

    // Check if we have speaker information
    const hasSpeakers =
      words.some((w) => w.speaker || w.speakerId || w.speaker_id) ||
      (this.transcriptSpeakers && this.transcriptSpeakers.length > 1);

    if (!hasSpeakers) {
      this.showToast('warning', 'No speaker diarization data found. Re-transcribe with speaker detection enabled.');
      return;
    }

    this.showToast('info', '👥 Identifying speakers (using AI + web search)...', 8000);

    try {
      // Build transcription result object for the API
      const transcriptionResult = {
        success: true,
        text: words.map((w) => w.text).join(' '),
        words: words.map((w) => ({
          text: w.text,
          start: w.start,
          end: w.end,
          speaker: w.speaker || w.speakerId || w.speaker_id,
        })),
        speakers: this.transcriptSpeakers || [
          ...new Set(words.map((w) => w.speaker || w.speakerId || w.speaker_id).filter(Boolean)),
        ],
        speakerCount:
          this.transcriptSpeakers?.length ||
          [...new Set(words.map((w) => w.speaker || w.speakerId || w.speaker_id).filter(Boolean))].length,
      };

      // Call the speaker identification API with video title for web search
      const result = await window.videoEditor.identifySpeakers(transcriptionResult, {
        context: 'video recording',
        videoTitle: this.videoInfo?.title || this.videoPath?.split('/').pop() || null, // Pass video title for web search
        expectedNames: [], // Could be populated from user input in future
      });

      if (result.success && result.speakerMap && Object.keys(result.speakerMap).length > 0) {
        // Store the speaker names
        this.speakerNames = result.speakerMap;
        this.speakerRoles = result.roles || {};

        // Update teleprompterWords (the rendered words) with speaker names
        if (this.teleprompterWords) {
          this.teleprompterWords = this.teleprompterWords.map((w) => ({
            ...w,
            speakerName:
              w.speaker || w.speakerId ? result.speakerMap[w.speaker || w.speakerId] || w.speaker || w.speakerId : null,
          }));
        }

        // Also update transcriptSegments (the raw segments)
        if (this.transcriptSegments) {
          this.transcriptSegments = this.transcriptSegments.map((w) => ({
            ...w,
            speakerName:
              w.speaker || w.speakerId ? result.speakerMap[w.speaker || w.speakerId] || w.speaker || w.speakerId : null,
          }));
        }

        // Refresh teleprompter to show names
        if (this.teleprompterVisible) {
          this.initTeleprompter();
        }

        // Show success with identified names
        const names = Object.values(result.speakerMap).join(', ');
        const confidence = result.confidence ? ` (${Math.round(result.confidence * 100)}% confident)` : '';
        const webSearchNote = result.webSearchUsed ? ' 🔍' : '';
        this.showToast('success', `👥 Identified: ${names}${confidence}${webSearchNote}`, 6000);

        // Log reasoning for debugging
        if (result.reasoning) {
          console.log('[SpeakerID] Reasoning:', result.reasoning);
        }
        if (result.clues) {
          console.log('[SpeakerID] Clues found:', result.clues);
        }
        if (result.webSearchUsed) {
          console.log('[SpeakerID] Web search was used');
          if (result.sourcesUsed?.length > 0) {
            console.log('[SpeakerID] Sources:', result.sourcesUsed);
          }
        }

        // Save to Space if applicable
        if (this.spaceItemId && window.clipboard?.updateMetadata) {
          try {
            await window.clipboard.updateMetadata(this.spaceItemId, {
              speakerNames: result.speakerMap,
              speakerRoles: result.roles,
              speakerIdentificationDate: new Date().toISOString(),
            });
            console.log('[SpeakerID] Saved speaker names to Space item');
          } catch (saveError) {
            console.warn('[SpeakerID] Could not save to Space:', saveError.message);
          }
        }
      } else {
        const errorMsg = result.error || 'Could not identify speakers from the conversation';
        this.showToast('warning', `👥 ${errorMsg}`, 4000);
      }
    } catch (error) {
      console.error('[SpeakerID] Error:', error);
      this.showToast('error', 'Speaker identification failed: ' + error.message);
    }
  },

  // ============================================
  // SPEAKER EDITING SYSTEM
  // ============================================

  // Show speaker edit dropdown when clicking on a speaker label
  showSpeakerEditDropdown(event, speakerId) {
    event.stopPropagation();

    // Close any existing dropdown
    this.closeSpeakerEditDropdown();

    // Get all unique speakers from the transcript
    const words = this.teleprompterWords || this.transcriptSegments || [];
    const allSpeakers = [...new Set(words.map((w) => w.speaker || w.speakerId || w.speaker_id).filter(Boolean))];

    // Create dropdown element
    const dropdown = document.createElement('div');
    dropdown.id = 'speakerEditDropdown';
    dropdown.className = 'speaker-edit-dropdown';

    // Get current display name
    const currentName = this.speakerNames?.[speakerId] || this.formatSpeakerDisplayName(speakerId);

    // Build dropdown content
    dropdown.innerHTML = `
          <div class="speaker-edit-header">
            <span class="speaker-edit-title">Edit Speaker</span>
            <span class="speaker-edit-current">${currentName}</span>
          </div>
          
          <div class="speaker-edit-section">
            <div class="speaker-edit-label">Rename Speaker</div>
            <div class="speaker-edit-rename-row">
              <input type="text" 
                     id="speakerRenameInput" 
                     class="speaker-edit-input" 
                     placeholder="${currentName}"
                     value="${this.speakerNames?.[speakerId] || ''}"
                     data-speaker-id="${speakerId}">
              <button class="speaker-edit-btn primary" onclick="app.renameSpeaker('${speakerId}')">
                Save
              </button>
            </div>
          </div>
          
          <div class="speaker-edit-section">
            <div class="speaker-edit-label">Change Speaker ID</div>
            <div class="speaker-edit-subtitle">Reassign all text from this speaker to another</div>
            <div class="speaker-edit-options">
              ${allSpeakers
                .filter((s) => s !== speakerId)
                .map((s) => {
                  const name = this.speakerNames?.[s] || this.formatSpeakerDisplayName(s);
                  return `<button class="speaker-option-btn" onclick="app.changeSpeaker('${speakerId}', '${s}')">
                    <span class="speaker-option-dot" style="background: ${this.getSpeakerColor(s, allSpeakers)}"></span>
                    ${name}
                  </button>`;
                })
                .join('')}
              ${allSpeakers.length <= 1 ? '<div class="speaker-edit-empty">No other speakers</div>' : ''}
            </div>
          </div>
          
          <div class="speaker-edit-section">
            <div class="speaker-edit-label">Add New Speaker</div>
            <div class="speaker-edit-rename-row">
              <input type="text" 
                     id="newSpeakerNameInput" 
                     class="speaker-edit-input" 
                     placeholder="New speaker name">
              <button class="speaker-edit-btn" onclick="app.addNewSpeaker()">
                Add
              </button>
            </div>
          </div>
          
          <div class="speaker-edit-footer">
            <button class="speaker-edit-btn cancel" onclick="app.closeSpeakerEditDropdown()">Cancel</button>
          </div>
        `;

    // Position dropdown near the clicked element
    const rect = event.target.getBoundingClientRect();
    dropdown.style.position = 'fixed';
    dropdown.style.left = `${Math.min(rect.left, window.innerWidth - 300)}px`;
    dropdown.style.top = `${rect.bottom + 4}px`;
    dropdown.style.zIndex = '10000';

    document.body.appendChild(dropdown);

    // Focus the rename input
    setTimeout(() => {
      const input = document.getElementById('speakerRenameInput');
      if (input) {
        input.focus();
        input.select();
      }
    }, 50);

    // Close on outside click
    setTimeout(() => {
      document.addEventListener(
        'click',
        (this._closeSpeakerDropdownHandler = (e) => {
          if (!dropdown.contains(e.target)) {
            this.closeSpeakerEditDropdown();
          }
        })
      );
    }, 100);

    // Handle Enter key for rename
    dropdown.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const renameInput = document.getElementById('speakerRenameInput');
        const newSpeakerInput = document.getElementById('newSpeakerNameInput');
        if (document.activeElement === renameInput) {
          this.renameSpeaker(speakerId);
        } else if (document.activeElement === newSpeakerInput) {
          this.addNewSpeaker();
        }
      } else if (e.key === 'Escape') {
        this.closeSpeakerEditDropdown();
      }
    });
  },

  // Close the speaker edit dropdown
  closeSpeakerEditDropdown() {
    const dropdown = document.getElementById('speakerEditDropdown');
    if (dropdown) {
      dropdown.remove();
    }
    if (this._closeSpeakerDropdownHandler) {
      document.removeEventListener('click', this._closeSpeakerDropdownHandler);
      this._closeSpeakerDropdownHandler = null;
    }
  },

  // Get speaker color based on index
  getSpeakerColor(speakerId, allSpeakers) {
    const speakerColors = ['#4a9eff', '#22c55e', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4'];
    const index = allSpeakers.indexOf(speakerId);
    return speakerColors[index % speakerColors.length];
  },

  // Format speaker ID for display (e.g., "speaker_0" -> "Speaker 1")
  formatSpeakerDisplayName(speakerId) {
    if (!speakerId) return 'Unknown';
    const match = speakerId.match(/speaker[_\s]?(\d+)/i);
    if (match) {
      return `Speaker ${parseInt(match[1], 10) + 1}`;
    }
    return speakerId;
  },

  // Rename a speaker (change display name only)
  async renameSpeaker(speakerId) {
    const input = document.getElementById('speakerRenameInput');
    const newName = input?.value?.trim();

    if (!newName) {
      this.showToast('warning', 'Please enter a name');
      return;
    }

    // Initialize speakerNames if needed
    if (!this.speakerNames) {
      this.speakerNames = {};
    }

    const oldName = this.speakerNames[speakerId] || this.formatSpeakerDisplayName(speakerId);
    this.speakerNames[speakerId] = newName;

    console.log(`[SpeakerEdit] Renamed ${speakerId}: "${oldName}" → "${newName}"`);

    // Update words with new speaker name
    if (this.teleprompterWords) {
      this.teleprompterWords = this.teleprompterWords.map((w) => {
        if ((w.speaker || w.speakerId) === speakerId) {
          return { ...w, speakerName: newName };
        }
        return w;
      });
    }
    if (this.transcriptSegments) {
      this.transcriptSegments = this.transcriptSegments.map((w) => {
        if ((w.speaker || w.speakerId || w.speaker_id) === speakerId) {
          return { ...w, speakerName: newName };
        }
        return w;
      });
    }

    // Refresh teleprompter display
    this.initTeleprompter();

    // Save to Space
    await this.saveSpeakerChanges();

    this.closeSpeakerEditDropdown();
    this.showToast('success', `Renamed to "${newName}"`);
  },

  // Change speaker assignment (move all words from one speaker to another)
  async changeSpeaker(fromSpeakerId, toSpeakerId) {
    console.log(`[SpeakerEdit] Changing speaker: ${fromSpeakerId} → ${toSpeakerId}`);

    let wordsChanged = 0;

    // Update teleprompterWords
    if (this.teleprompterWords) {
      this.teleprompterWords = this.teleprompterWords.map((w) => {
        const currentSpeaker = w.speaker || w.speakerId || w.speaker_id;
        if (currentSpeaker === fromSpeakerId) {
          wordsChanged++;
          const newName = this.speakerNames?.[toSpeakerId] || null;
          return {
            ...w,
            speaker: toSpeakerId,
            speakerId: toSpeakerId,
            speakerName: newName,
          };
        }
        return w;
      });
    }

    // Update transcriptSegments
    if (this.transcriptSegments) {
      this.transcriptSegments = this.transcriptSegments.map((w) => {
        const currentSpeaker = w.speaker || w.speakerId || w.speaker_id;
        if (currentSpeaker === fromSpeakerId) {
          const newName = this.speakerNames?.[toSpeakerId] || null;
          return {
            ...w,
            speaker: toSpeakerId,
            speakerId: toSpeakerId,
            speaker_id: toSpeakerId,
            speakerName: newName,
          };
        }
        return w;
      });
    }

    // Update transcriptSpeakers list (remove the old speaker if no words left)
    if (this.transcriptSpeakers) {
      const remainingWords = (this.teleprompterWords || []).filter((w) => (w.speaker || w.speakerId) === fromSpeakerId);
      if (remainingWords.length === 0) {
        this.transcriptSpeakers = this.transcriptSpeakers.filter((s) => s !== fromSpeakerId);
        // Also remove from speakerNames
        if (this.speakerNames) {
          delete this.speakerNames[fromSpeakerId];
        }
      }
    }

    // Refresh teleprompter display
    this.initTeleprompter();

    // Save to Space
    await this.saveSpeakerChanges();

    this.closeSpeakerEditDropdown();

    const toName = this.speakerNames?.[toSpeakerId] || this.formatSpeakerDisplayName(toSpeakerId);
    this.showToast('success', `Moved ${wordsChanged} words to ${toName}`);
  },

  // Add a new speaker to the system
  async addNewSpeaker() {
    const input = document.getElementById('newSpeakerNameInput');
    const newName = input?.value?.trim();

    if (!newName) {
      this.showToast('warning', 'Please enter a speaker name');
      return;
    }

    // Generate new speaker ID
    const existingSpeakers = this.transcriptSpeakers || [];
    let maxNum = -1;
    existingSpeakers.forEach((s) => {
      const match = s.match(/speaker[_\s]?(\d+)/i);
      if (match) {
        maxNum = Math.max(maxNum, parseInt(match[1], 10));
      }
    });
    const newSpeakerId = `speaker_${maxNum + 1}`;

    // Add to transcriptSpeakers
    if (!this.transcriptSpeakers) {
      this.transcriptSpeakers = [];
    }
    this.transcriptSpeakers.push(newSpeakerId);

    // Add to speakerNames
    if (!this.speakerNames) {
      this.speakerNames = {};
    }
    this.speakerNames[newSpeakerId] = newName;

    console.log(`[SpeakerEdit] Added new speaker: ${newSpeakerId} = "${newName}"`);

    // Refresh teleprompter display
    this.initTeleprompter();

    // Save to Space
    await this.saveSpeakerChanges();

    this.closeSpeakerEditDropdown();
    this.showToast('success', `Added speaker "${newName}"`);
  },

  // Change speaker for a specific word (used when right-clicking individual words)
  async changeWordSpeaker(wordIndex, newSpeakerId) {
    if (!this.teleprompterWords || !this.teleprompterWords[wordIndex]) {
      return;
    }

    const word = this.teleprompterWords[wordIndex];
    const oldSpeakerId = word.speaker || word.speakerId;

    console.log(`[SpeakerEdit] Changing word ${wordIndex} ("${word.text}") from ${oldSpeakerId} to ${newSpeakerId}`);

    // Update the word
    const newName = this.speakerNames?.[newSpeakerId] || null;
    this.teleprompterWords[wordIndex] = {
      ...word,
      speaker: newSpeakerId,
      speakerId: newSpeakerId,
      speakerName: newName,
    };

    // Also update in transcriptSegments if it exists
    if (this.transcriptSegments) {
      // Find matching segment by time
      const segment = this.transcriptSegments.find(
        (s) => Math.abs(s.start - word.start) < 0.1 && s.text?.includes(word.text)
      );
      if (segment) {
        segment.speaker = newSpeakerId;
        segment.speakerId = newSpeakerId;
        segment.speaker_id = newSpeakerId;
        segment.speakerName = newName;
      }
    }

    // Refresh teleprompter display
    this.initTeleprompter();

    // Save changes
    await this.saveSpeakerChanges();
  },

  // Save speaker changes to Space metadata
  async saveSpeakerChanges() {
    if (!this.spaceItemId || !window.clipboard?.updateMetadata) {
      console.log('[SpeakerEdit] No Space item to save to');
      return;
    }

    try {
      await window.clipboard.updateMetadata(this.spaceItemId, {
        speakerNames: this.speakerNames || {},
        speakerRoles: this.speakerRoles || {},
        transcriptSpeakers: this.transcriptSpeakers || [],
        speakerEditDate: new Date().toISOString(),
      });
      console.log('[SpeakerEdit] Saved speaker changes to Space');
    } catch (error) {
      console.warn('[SpeakerEdit] Could not save to Space:', error.message);
    }
  },

  // Show context menu for changing a specific word's speaker
  showWordSpeakerContextMenu(event, wordIndex) {
    event.preventDefault();
    event.stopPropagation();

    // Close any existing context menu
    this.closeWordSpeakerContextMenu();

    const word = this.teleprompterWords?.[wordIndex];
    if (!word) return;

    const currentSpeakerId = word.speaker || word.speakerId;
    const allSpeakers = this.transcriptSpeakers || [
      ...new Set((this.teleprompterWords || []).map((w) => w.speaker || w.speakerId).filter(Boolean)),
    ];

    const menu = document.createElement('div');
    menu.id = 'wordSpeakerContextMenu';
    menu.className = 'word-speaker-context-menu';

    menu.innerHTML = `
          <div class="word-speaker-header">Change speaker for: "${word.text}"</div>
          <div class="word-speaker-options">
            ${allSpeakers
              .map((s) => {
                const name = this.speakerNames?.[s] || this.formatSpeakerDisplayName(s);
                const isSelected = s === currentSpeakerId;
                return `<button class="word-speaker-option ${isSelected ? 'selected' : ''}" 
                              onclick="app.changeWordSpeaker(${wordIndex}, '${s}'); app.closeWordSpeakerContextMenu();">
                <span class="speaker-option-dot" style="background: ${this.getSpeakerColor(s, allSpeakers)}"></span>
                ${name}
                ${isSelected ? ' ✓' : ''}
              </button>`;
              })
              .join('')}
          </div>
        `;

    // Position at click location
    menu.style.position = 'fixed';
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    menu.style.zIndex = '10001';

    document.body.appendChild(menu);

    // Close on outside click
    setTimeout(() => {
      document.addEventListener(
        'click',
        (this._closeWordContextHandler = () => {
          this.closeWordSpeakerContextMenu();
        })
      );
    }, 100);
  },

  // Close word speaker context menu
  closeWordSpeakerContextMenu() {
    const menu = document.getElementById('wordSpeakerContextMenu');
    if (menu) menu.remove();
    if (this._closeWordContextHandler) {
      document.removeEventListener('click', this._closeWordContextHandler);
      this._closeWordContextHandler = null;
    }
  },

  // ============================================
  // WORD RANGE SELECTION FOR SPEAKER CHANGES
  // ============================================

  // Start word selection on mousedown
  startWordSelection(event, wordIndex) {
    // Only start selection on left mouse button
    if (event.button !== 0) return;

    event.preventDefault();
    event.stopPropagation();

    this.wordSelectionStart = wordIndex;
    this.wordSelectionEnd = wordIndex;
    this.isSelectingWords = true;

    // Clear any existing selection highlight
    this.clearWordSelectionHighlight();

    // Highlight the starting word
    this.updateWordSelectionHighlight();

    console.log('[WordSelection] Started at word', wordIndex);
  },

  // Extend selection as mouse moves over words
  extendWordSelection(event, wordIndex) {
    if (!this.isSelectingWords) return;

    // Update end index
    this.wordSelectionEnd = wordIndex;

    // Update visual highlight
    this.updateWordSelectionHighlight();
  },

  // Complete selection on mouseup
  completeWordSelection(event, endIndex) {
    if (!this.isSelectingWords) return;

    this.isSelectingWords = false;
    this.wordSelectionEnd = endIndex;

    const startIdx = Math.min(this.wordSelectionStart, this.wordSelectionEnd);
    const endIdx = Math.max(this.wordSelectionStart, this.wordSelectionEnd);

    console.log('[WordSelection] Completed: words', startIdx, 'to', endIdx);

    // If more than one word selected, show speaker change popup
    // For single word, use regular click behavior (seek)
    if (startIdx !== endIdx) {
      this.showSpeakerChangePopup(startIdx, endIdx, event);
    } else {
      // Single word click - seek to time
      const word = this.teleprompterWords?.[startIdx];
      if (word) {
        const video = document.getElementById('videoPlayer');
        if (video) {
          video.currentTime = word.start;
        }
      }
      this.clearWordSelectionHighlight();
      this.wordSelectionStart = null;
      this.wordSelectionEnd = null;
    }
  },

  // Update visual highlight for selected words
  updateWordSelectionHighlight() {
    if (this.wordSelectionStart === null) return;

    const startIdx = Math.min(this.wordSelectionStart, this.wordSelectionEnd ?? this.wordSelectionStart);
    const endIdx = Math.max(this.wordSelectionStart, this.wordSelectionEnd ?? this.wordSelectionStart);

    // Remove existing highlights
    document.querySelectorAll('.teleprompter-word.word-selected').forEach((el) => {
      el.classList.remove('word-selected');
    });

    // Add highlight to selected range
    document.querySelectorAll('.teleprompter-word').forEach((el) => {
      const idx = parseInt(el.dataset.index);
      if (idx >= startIdx && idx <= endIdx) {
        el.classList.add('word-selected');
      }
    });
  },

  // Clear word selection highlight
  clearWordSelectionHighlight() {
    document.querySelectorAll('.teleprompter-word.word-selected').forEach((el) => {
      el.classList.remove('word-selected');
    });
  },

  // Cancel ongoing word selection (e.g., on Escape)
  cancelWordSelection() {
    this.isSelectingWords = false;
    this.wordSelectionStart = null;
    this.wordSelectionEnd = null;
    this.clearWordSelectionHighlight();
    this.closeSpeakerChangePopup();
  },

  // Setup global listeners for word selection
  setupWordSelectionListeners() {
    // Only setup once
    if (this._wordSelectionListenersSetup) return;
    this._wordSelectionListenersSetup = true;

    // Handle mouseup anywhere to complete selection
    document.addEventListener('mouseup', (e) => {
      if (!this.isSelectingWords) return;

      // If released on a word, that handler will take care of it
      // If released outside words, complete with current end index
      if (!e.target.closest('.teleprompter-word')) {
        if (this.wordSelectionStart !== null && this.wordSelectionEnd !== null) {
          const startIdx = Math.min(this.wordSelectionStart, this.wordSelectionEnd);
          const endIdx = Math.max(this.wordSelectionStart, this.wordSelectionEnd);

          this.isSelectingWords = false;

          if (startIdx !== endIdx) {
            this.showSpeakerChangePopup(startIdx, endIdx, e);
          } else {
            this.clearWordSelectionHighlight();
            this.wordSelectionStart = null;
            this.wordSelectionEnd = null;
          }
        }
      }
    });

    // Cancel on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && (this.isSelectingWords || this.wordSelectionStart !== null)) {
        this.cancelWordSelection();
      }
    });

    console.log('[WordSelection] Global listeners setup');
  },

  // Show popup to change speaker for selected word range
  showSpeakerChangePopup(startIndex, endIndex, event) {
    // Close any existing popup
    this.closeSpeakerChangePopup();

    const startIdx = Math.min(startIndex, endIndex);
    const endIdx = Math.max(startIndex, endIndex);
    const wordCount = endIdx - startIdx + 1;

    // Get selected text preview
    const selectedWords = this.teleprompterWords.slice(startIdx, endIdx + 1);
    const selectedText = selectedWords.map((w) => w.text).join(' ');
    const previewText = selectedText.length > 50 ? selectedText.slice(0, 50) + '...' : selectedText;

    // Get all speakers
    const allSpeakers = this.transcriptSpeakers || [
      ...new Set((this.teleprompterWords || []).map((w) => w.speaker || w.speakerId).filter(Boolean)),
    ];

    // Determine current speaker(s) in selection
    const speakersInSelection = [...new Set(selectedWords.map((w) => w.speaker || w.speakerId).filter(Boolean))];
    const currentSpeaker = speakersInSelection.length === 1 ? speakersInSelection[0] : null;

    // Check if speaker tracks exist
    const hasSpeakerTracks = this.audioTracks?.some((t) => t.type === 'speaker');

    const popup = document.createElement('div');
    popup.id = 'speakerChangePopup';
    popup.className = 'speaker-change-popup';

    popup.innerHTML = `
          <div class="speaker-change-popup-header">
            Change Speaker
            <small>${wordCount} words selected: "${previewText}"</small>
          </div>
          <div class="speaker-change-popup-options">
            ${allSpeakers
              .map((s) => {
                const name = this.speakerNames?.[s] || this.formatSpeakerDisplayName(s);
                const isSelected = s === currentSpeaker;
                const color = this.getSpeakerColor(s, allSpeakers);
                return `<button class="speaker-change-option ${isSelected ? 'selected' : ''}" 
                              data-speaker-id="${s}"
                              onclick="app.selectSpeakerForRange('${s}')">
                <span class="speaker-dot" style="background: ${color}"></span>
                ${name}
                ${isSelected ? ' (current)' : ''}
              </button>`;
              })
              .join('')}
            <button class="speaker-change-option" data-speaker-id="new"
                    onclick="app.addNewSpeakerFromSelection()">
              <span class="speaker-dot" style="background: #666; border: 1px dashed #999;"></span>
              + Add New Speaker
            </button>
          </div>
          ${
            hasSpeakerTracks
              ? `
          <div class="speaker-change-update-clips">
            <input type="checkbox" id="updateClipsCheckbox" checked>
            <label for="updateClipsCheckbox">Update speaker tracks after change</label>
          </div>
          `
              : ''
          }
          <div class="speaker-change-popup-actions">
            <button class="speaker-change-btn cancel" onclick="app.closeSpeakerChangePopup()">Cancel</button>
            <button class="speaker-change-btn primary" id="applySelectionBtn" disabled
                    onclick="app.applyRangeSpeakerChange()">Apply</button>
          </div>
        `;

    // Position near the event
    const x = event?.clientX || window.innerWidth / 2;
    const y = event?.clientY || window.innerHeight / 2;
    popup.style.left = `${Math.min(x, window.innerWidth - 300)}px`;
    popup.style.top = `${Math.min(y + 10, window.innerHeight - 300)}px`;

    document.body.appendChild(popup);

    // Store selection info for later
    this._pendingSpeakerChange = {
      startIndex: startIdx,
      endIndex: endIdx,
      selectedSpeaker: null,
    };

    // Close on click outside
    setTimeout(() => {
      document.addEventListener(
        'click',
        (this._closeSpeakerPopupHandler = (e) => {
          if (!popup.contains(e.target)) {
            this.closeSpeakerChangePopup();
          }
        })
      );
      document.addEventListener(
        'keydown',
        (this._escapeSpeakerPopupHandler = (e) => {
          if (e.key === 'Escape') {
            this.closeSpeakerChangePopup();
          }
        })
      );
    }, 100);
  },

  // Close speaker change popup
  closeSpeakerChangePopup() {
    const popup = document.getElementById('speakerChangePopup');
    if (popup) popup.remove();

    if (this._closeSpeakerPopupHandler) {
      document.removeEventListener('click', this._closeSpeakerPopupHandler);
      this._closeSpeakerPopupHandler = null;
    }
    if (this._escapeSpeakerPopupHandler) {
      document.removeEventListener('keydown', this._escapeSpeakerPopupHandler);
      this._escapeSpeakerPopupHandler = null;
    }

    // Clear selection state
    this.wordSelectionStart = null;
    this.wordSelectionEnd = null;
    this.clearWordSelectionHighlight();
    this._pendingSpeakerChange = null;
  },

  // Select a speaker in the popup
  selectSpeakerForRange(speakerId) {
    if (!this._pendingSpeakerChange) return;

    this._pendingSpeakerChange.selectedSpeaker = speakerId;

    // Update UI
    const popup = document.getElementById('speakerChangePopup');
    if (popup) {
      popup.querySelectorAll('.speaker-change-option').forEach((opt) => {
        opt.classList.toggle('selected', opt.dataset.speakerId === speakerId);
      });

      // Enable apply button
      const applyBtn = popup.querySelector('#applySelectionBtn');
      if (applyBtn) applyBtn.disabled = false;
    }
  },

  // Add new speaker from selection popup
  async addNewSpeakerFromSelection() {
    const name = prompt('Enter new speaker name:');
    if (!name?.trim()) return;

    // Generate new speaker ID
    const existingSpeakers = this.transcriptSpeakers || [];
    let maxNum = -1;
    existingSpeakers.forEach((s) => {
      const match = s.match(/speaker_?(\d+)/i);
      if (match) maxNum = Math.max(maxNum, parseInt(match[1]));
    });
    const newSpeakerId = `speaker_${maxNum + 1}`;

    // Add to speakers list
    if (!this.transcriptSpeakers) this.transcriptSpeakers = [];
    this.transcriptSpeakers.push(newSpeakerId);

    // Add to speaker names
    if (!this.speakerNames) this.speakerNames = {};
    this.speakerNames[newSpeakerId] = name.trim();

    console.log('[SpeakerSelection] Added new speaker:', newSpeakerId, '=', name);

    // Select this speaker and apply
    this._pendingSpeakerChange.selectedSpeaker = newSpeakerId;
    await this.applyRangeSpeakerChange();
  },

  // Change speaker for a range of words
  async changeRangeSpeaker(startIndex, endIndex, newSpeakerId) {
    console.log(`[SpeakerEdit] Changing words ${startIndex}-${endIndex} to speaker ${newSpeakerId}`);

    if (!this.teleprompterWords) {
      console.error('[SpeakerEdit] No teleprompter words available');
      return;
    }

    const newSpeakerName = this.speakerNames?.[newSpeakerId] || null;
    let changedCount = 0;

    // Update teleprompterWords
    for (let i = startIndex; i <= endIndex && i < this.teleprompterWords.length; i++) {
      const word = this.teleprompterWords[i];
      const oldSpeaker = word.speaker || word.speakerId;

      if (oldSpeaker !== newSpeakerId) {
        this.teleprompterWords[i] = {
          ...word,
          speaker: newSpeakerId,
          speakerId: newSpeakerId,
          speakerName: newSpeakerName,
          _previousSpeaker: oldSpeaker, // Keep track for potential undo
        };
        changedCount++;
      }
    }

    // Also update transcriptSegments if they exist
    if (this.transcriptSegments) {
      for (let i = startIndex; i <= endIndex && i < this.teleprompterWords.length; i++) {
        const word = this.teleprompterWords[i];

        // Find matching segment by time
        const segment = this.transcriptSegments.find(
          (s) => Math.abs(s.start - word.start) < 0.1 && (s.text?.includes(word.text) || s.word === word.text)
        );

        if (segment) {
          segment.speaker = newSpeakerId;
          segment.speakerId = newSpeakerId;
          segment.speaker_id = newSpeakerId;
          segment.speakerName = newSpeakerName;
        }
      }
    }

    console.log(`[SpeakerEdit] Changed ${changedCount} words to speaker ${newSpeakerId}`);

    // Refresh teleprompter display
    this.renderTeleprompterWords();

    // Save changes
    await this.saveSpeakerChanges();

    return changedCount;
  },

  // Apply the speaker change to the selected range
  async applyRangeSpeakerChange() {
    if (!this._pendingSpeakerChange?.selectedSpeaker) {
      this.showToast('error', 'Please select a speaker');
      return;
    }

    const { startIndex, endIndex, selectedSpeaker } = this._pendingSpeakerChange;

    // Check if we should update clips
    const updateClipsCheckbox = document.getElementById('updateClipsCheckbox');
    const shouldUpdateClips = updateClipsCheckbox?.checked ?? false;

    // Apply the change
    await this.changeRangeSpeaker(startIndex, endIndex, selectedSpeaker);

    // Update clips if requested
    if (shouldUpdateClips && this.adrManager) {
      await this.adrManager.updateSpeakerClipsAfterCorrection();
    }

    // Close popup and clear selection
    this.closeSpeakerChangePopup();

    this.showToast(
      'success',
      `Changed ${endIndex - startIndex + 1} words to ${this.speakerNames?.[selectedSpeaker] || this.formatSpeakerDisplayName(selectedSpeaker)}`
    );
  },

  // ============================================
  // END SPEAKER EDITING SYSTEM
  // ============================================

  // forceRegenerate: if true, skip all caches (memory and disk) and regenerate from scratch
  async generateAudioWaveform(forceRegenerate = false) {
    if (forceRegenerate) {
      console.log('[Waveform] Force regeneration requested - clearing all caches');
      this.clearWaveformCache();
    }

    if (!this.videoPath) return;

    const canvas = document.getElementById('audioWaveform');
    if (!canvas) {
      console.error('[Waveform] Canvas element not found');
      return;
    }
    const ctx = canvas.getContext('2d');

    // Get ruler dimensions FIRST to determine proper canvas size for alignment
    const rulerMarks = document.getElementById('rulerMarks');
    const audioClip = canvas.closest('.timeline-clip');

    // Use fallback values if DOM isn't ready yet
    // Default height is 60px (matches inline style on canvas)
    let height = canvas.offsetHeight || 60;
    const duration = this.videoInfo?.duration || 0;

    // Fallback width based on typical timeline width
    let rulerWidth = canvas.offsetWidth || 800;
    let offsetX = 0;

    if (rulerMarks && audioClip) {
      const rulerRect = rulerMarks.getBoundingClientRect();
      const clipRect = audioClip.getBoundingClientRect();
      // Only use ruler dimensions if they are valid (> 0)
      if (rulerRect.width > 0) {
        rulerWidth = rulerRect.width;
      }
      offsetX = rulerRect.left - clipRect.left;
    }

    // Set canvas width to match ruler width for perfect alignment
    // Cap at 8000px to prevent memory issues (with retina = 16000px which is safe)
    const maxCanvasWidth = 8000;
    const targetWidth = Math.min(Math.ceil(rulerWidth), maxCanvasWidth);

    // Safety check - if width is unreasonable, retry after delay
    if (targetWidth <= 0 || !isFinite(targetWidth)) {
      console.warn('[Waveform] Invalid target width:', targetWidth, 'rulerWidth:', rulerWidth, '- retrying in 500ms');
      // Retry once after DOM has had more time to settle
      if (!this._waveformRetryCount) {
        this._waveformRetryCount = 1;
        setTimeout(() => {
          this._waveformRetryCount = 0;
          this.generateAudioWaveform(forceRegenerate);
        }, 500);
      } else {
        console.error('[Waveform] Retry failed - using minimum fallback width');
        this._waveformRetryCount = 0;
      }
      return;
    }

    // Set canvas size for retina display
    canvas.width = targetWidth * 2;
    canvas.height = height * 2;
    ctx.scale(2, 2);

    const width = targetWidth;

    // Recalculate offset after sizing canvas to ruler
    if (rulerMarks && audioClip) {
      const rulerRect = rulerMarks.getBoundingClientRect();
      const clipRect = audioClip.getBoundingClientRect();
      offsetX = rulerRect.left - clipRect.left;
    }

    // Log alignment info
    const widthDiff = Math.abs(width - rulerWidth);
    if (widthDiff > 2) {
      console.log(
        '[Waveform] Canvas sized to ruler. Target:',
        rulerWidth.toFixed(0),
        'Actual:',
        width,
        '(capped at',
        maxCanvasWidth + ')'
      );
    } else {
      console.log(
        '[Waveform] Perfect alignment. Canvas:',
        width,
        'Ruler:',
        rulerWidth.toFixed(0),
        'Offset:',
        offsetX.toFixed(1)
      );
    }

    // Store alignment info for drawing functions
    const alignInfo = { rulerWidth: width, offsetX, canvasWidth: width };

    // Get current zoom level to select appropriate tier
    const currentZoom = this.zoom || 1;
    const tier = this.waveformTierDefs?.find((t) => currentZoom <= t.maxZoom) ||
      this.waveformTierDefs?.[this.waveformTierDefs.length - 1] || { samplesPerSec: 100 }; // Fallback

    // Cap samples to what we can actually display (max 2 samples per pixel for detail)
    // This prevents memory issues with very long videos
    const maxSamples = width * 2;
    const rawSamples = Math.floor(duration * tier.samplesPerSec);
    const numSamples = Math.min(maxSamples, Math.max(width, rawSamples));
    console.log('[Waveform] Zoom', currentZoom + 'x, samples:', numSamples, '(capped from', rawSamples + ')');

    // Check for cached rendered image first (instant display) - skip if forceRegenerate
    const imageKey = `${this.waveformType}_${tier.samplesPerSec}`;

    if (!forceRegenerate) {
      // 1. Check memory cache first
      if (this.waveformCachePath === this.videoPath && this.waveformImages?.[imageKey]) {
        const img = new Image();
        img.onload = () => {
          ctx.drawImage(img, 0, 0, width, height);
          canvas.classList.remove('loading');
          canvas.classList.add('ready');
          console.log('[Waveform] Used memory cached image:', imageKey);
        };
        img.src = this.waveformImages[imageKey];
        return;
      }

      // 2. Check disk cache
      if (window.videoEditor?.loadWaveformImage) {
        try {
          const diskCache = await window.videoEditor.loadWaveformImage(this.videoPath, imageKey);
          if (diskCache.exists && diskCache.dataUrl) {
            const img = new Image();
            img.onload = () => {
              ctx.drawImage(img, 0, 0, width, height);
              canvas.classList.remove('loading');
              canvas.classList.add('ready');
              // Store in memory cache too
              if (!this.waveformImages) this.waveformImages = {};
              this.waveformImages[imageKey] = diskCache.dataUrl;
              this.waveformCachePath = this.videoPath;
              console.log('[Waveform] Loaded from disk cache:', imageKey);
            };
            img.src = diskCache.dataUrl;
            return;
          }
        } catch (e) {
          console.log('[Waveform] Disk cache not available:', e.message);
        }
      }
    } else {
      console.log('[Waveform] Skipping cache checks due to force regeneration');
    }

    // Show loading state with ghost waveform
    canvas.classList.add('loading');
    canvas.classList.remove('ready');
    this.drawWaveformLoading(ctx, width, height, 'Analyzing audio...');

    try {
      let peaks = null;
      let method = 'unknown';

      // Check if we have cached peak data for this tier
      const tierKey = `tier_${tier.samplesPerSec}`;

      if (this.waveformCachePath === this.videoPath && this.waveformTiers?.[tierKey]) {
        // Use cached tier peaks
        peaks = this.waveformTiers[tierKey];
        method = 'cached';
        console.log('[Waveform] Using cached peaks:', tierKey, 'with', peaks.length, 'samples');
      } else {
        // Need to generate - first get master peaks if not cached
        if (this.waveformCachePath !== this.videoPath || !this.waveformMasterPeaks) {
          // Reset cache for new video
          this.waveformTiers = {};
          this.waveformImages = {};
          this.waveformMasterPeaks = null;
          this.waveformCachePath = this.videoPath;
          this.waveformDuration = duration;

          // Try to load master peaks from disk cache first
          let loadedFromDisk = false;
          if (window.videoEditor?.loadWaveformCache) {
            try {
              const diskCache = await window.videoEditor.loadWaveformCache(this.videoPath);
              if (diskCache.exists && diskCache.masterPeaks) {
                this.waveformMasterPeaks = new Float32Array(diskCache.masterPeaks);
                method = 'disk-cache';
                loadedFromDisk = true;
                console.log('[Waveform] Loaded master peaks from disk:', this.waveformMasterPeaks.length);
              }
            } catch (_e) {
              console.log('[Waveform] No disk cache available');
            }
          }

          if (!loadedFromDisk) {
            // Generate master peaks at highest resolution (capped for performance)
            // Max 50,000 samples even for very long videos - still good detail
            const rawMasterSamples = Math.floor(duration * 500);
            const masterSamples = Math.min(50000, rawMasterSamples);
            console.log('[Waveform] Generating master peaks:', masterSamples, '(capped from', rawMasterSamples + ')');

            try {
              this.waveformMasterPeaks = await this.extractAudioPeaksWebAudio(masterSamples);
              method = 'webaudio';
              console.log('[Waveform] Master peaks generated:', this.waveformMasterPeaks.length);
            } catch (e) {
              console.warn('[Waveform] Web Audio failed:', e.message);
              try {
                this.waveformMasterPeaks = await this.extractAudioPeaksFromVideo(masterSamples);
                method = 'video-element';
              } catch (e2) {
                console.warn('[Waveform] Video element failed:', e2.message);
                const result = await window.videoEditor.getWaveform(this.videoPath, { samples: masterSamples });
                if (result.error) throw new Error(result.error);
                this.waveformMasterPeaks = result.peaks || [];
                method = 'ffmpeg';
              }
            }

            // Save master peaks to disk for future use
            if (window.videoEditor?.saveWaveformCache && this.waveformMasterPeaks) {
              window.videoEditor
                .saveWaveformCache(this.videoPath, {
                  masterPeaks: Array.from(this.waveformMasterPeaks),
                  duration: duration,
                  timestamp: Date.now(),
                })
                .then((result) => {
                  if (result.success) console.log('[Waveform] Master peaks saved to disk');
                })
                .catch((err) => console.warn('[Waveform] Could not save peaks to disk:', err.message));
            }
          }
        }

        // Downsample master to current tier resolution
        peaks = this.downsamplePeaks(this.waveformMasterPeaks, numSamples);
        this.waveformTiers[tierKey] = peaks;
        method = method || 'downsampled';
        console.log('[Waveform] Created tier:', tierKey, 'with', peaks.length, 'samples from master');
      }

      // Stop loading animation before drawing
      this.stopWaveformLoadingAnimation();

      // Mark as ready (triggers CSS fade-in)
      canvas.classList.remove('loading');
      canvas.classList.add('ready');

      // Draw the waveform based on selected type (with ruler alignment)
      switch (this.waveformType) {
        case 'line':
          this.drawWaveformLine(ctx, width, height, peaks, duration, method, alignInfo);
          break;
        case 'mirror':
          this.drawWaveformMirror(ctx, width, height, peaks, duration, method, alignInfo);
          break;
        case 'spectrogram':
          await this.drawSpectrogram(ctx, width, height, duration, method, alignInfo);
          break;
        default:
          this.drawWaveform(ctx, width, height, peaks, duration, method, alignInfo);
      }

      // Cache the rendered image for instant future use
      try {
        if (!this.waveformImages) this.waveformImages = {};
        const dataUrl = canvas.toDataURL('image/png');
        this.waveformImages[imageKey] = dataUrl;
        console.log('[Waveform] Cached in memory:', imageKey);

        // Also save to disk for persistence
        if (window.videoEditor?.saveWaveformImage) {
          window.videoEditor
            .saveWaveformImage(this.videoPath, imageKey, dataUrl)
            .then((result) => {
              if (result.success) {
                console.log('[Waveform] Saved to disk:', imageKey);
              }
            })
            .catch((err) => console.warn('[Waveform] Disk save failed:', err.message));
        }
      } catch (cacheErr) {
        console.warn('[Waveform] Could not cache image:', cacheErr.message);
      }
    } catch (error) {
      console.error('[Waveform] All methods failed:', error);
      this.drawWaveformError(ctx, width, height, 'Could not analyze audio');
    }
  },

  // Extract audio peaks using Web Audio API
  // Also stores the AudioBuffer for scrubbing (share decode, don't decode twice!)
  async extractAudioPeaksWebAudio(numSamples) {
    const video = document.getElementById('videoPlayer');
    if (!video?.src) throw new Error('No video source');

    // SAFETY: Skip Web Audio decoding for videos longer than 30 minutes
    // Decoding 1hr of audio can use 1GB+ of RAM and crash the renderer
    const MAX_DURATION_FOR_DECODE = 1800; // 30 minutes in seconds
    if (video.duration > MAX_DURATION_FOR_DECODE) {
      console.warn(
        '[Waveform] Video too long for Web Audio decode (' +
          Math.round(video.duration / 60) +
          ' min), using FFmpeg instead'
      );
      throw new Error('Video too long for client-side decode');
    }

    // Initialize shared audio context if needed
    await this.initAudioContext();

    try {
      // Fetch and decode the audio
      const response = await fetch(video.src);
      if (!response.ok) throw new Error('Fetch failed');

      const arrayBuffer = await response.arrayBuffer();
      const decodedBuffer = await this.audioContext.decodeAudioData(arrayBuffer);

      console.log('[Waveform] Decoded audio:', {
        duration: decodedBuffer.duration.toFixed(2) + 's',
        sampleRate: decodedBuffer.sampleRate,
        channels: decodedBuffer.numberOfChannels,
      });

      // IMPORTANT: Store for scrubbing - no need to decode again!
      this.audioBuffer = decodedBuffer;
      this.isAudioLoaded = true;
      console.log('[Scrub] Audio buffer shared from waveform decode');
      this.showToast('success', 'Audio scrubbing ready');

      // Get channel data (mono mix if stereo)
      let channelData;
      if (decodedBuffer.numberOfChannels === 1) {
        channelData = decodedBuffer.getChannelData(0);
      } else {
        // Mix stereo to mono
        const left = decodedBuffer.getChannelData(0);
        const right = decodedBuffer.getChannelData(1);
        channelData = new Float32Array(left.length);
        for (let i = 0; i < left.length; i++) {
          channelData[i] = (left[i] + right[i]) / 2;
        }
      }

      // Calculate peaks
      return this.calculatePeaks(channelData, numSamples);
    } catch (err) {
      console.error('[Waveform] Decode failed:', err);
      throw err;
    }
  },

  // Extract audio peaks directly from video element using MediaElementSourceNode
  async extractAudioPeaksFromVideo(numSamples) {
    const video = document.getElementById('videoPlayer');
    if (!video) throw new Error('No video element');

    return new Promise((resolve, reject) => {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;

      try {
        const source = audioCtx.createMediaElementSource(video);
        source.connect(analyser);
        analyser.connect(audioCtx.destination);

        const peaks = [];
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        const duration = video.duration;
        const interval = duration / numSamples;
        let currentSample = 0;

        const collectSample = () => {
          if (currentSample >= numSamples) {
            source.disconnect();
            audioCtx.close();
            resolve(peaks);
            return;
          }

          analyser.getByteTimeDomainData(dataArray);

          // Calculate peak from waveform data
          let max = 0;
          for (let i = 0; i < bufferLength; i++) {
            const val = Math.abs(dataArray[i] - 128) / 128;
            if (val > max) max = val;
          }

          peaks.push(max);
          currentSample++;

          video.currentTime = currentSample * interval;
        };

        video.addEventListener('seeked', collectSample, { once: false });
        video.currentTime = 0;
      } catch (e) {
        audioCtx.close();
        reject(e);
      }
    });
  },

  // Calculate peaks from raw audio data
  // Returns high-resolution peak data for word-gap visibility
  calculatePeaks(channelData, numSamples) {
    const samplesPerPeak = Math.max(1, Math.floor(channelData.length / numSamples));
    const peaks = new Float32Array(numSamples);

    // First pass: collect raw peaks
    for (let i = 0; i < numSamples; i++) {
      const start = i * samplesPerPeak;
      const end = Math.min(start + samplesPerPeak, channelData.length);

      let max = 0;
      for (let j = start; j < end; j++) {
        const abs = Math.abs(channelData[j]);
        if (abs > max) max = abs;
      }
      peaks[i] = max;
    }

    // Find the 95th percentile for normalization (ignores rare spikes)
    const sorted = Array.from(peaks).sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 1;
    const normalizer = p95 > 0.01 ? p95 : 1;

    // Normalize: scale so typical peaks hit ~0.8, preserving quiet sections
    for (let i = 0; i < numSamples; i++) {
      peaks[i] = Math.min(1, (peaks[i] / normalizer) * 0.8);
    }

    console.log('[Waveform] Peak stats: p95=' + p95.toFixed(4) + ', samples=' + numSamples);
    return peaks;
  },

  // Draw the waveform visualization (bars mode - default)
  // alignInfo: { rulerWidth, offsetX, canvasWidth } - for accurate time alignment
  drawWaveform(ctx, width, height, peaks, duration, method, alignInfo = {}) {
    ctx.clearRect(0, 0, width, height);

    // Use ruler width for time-accurate positioning, with offset
    const { rulerWidth = width, offsetX = 0 } = alignInfo;

    // High resolution bars - thinner for more detail
    const barWidth = 2;
    const gap = 1;
    const totalBarWidth = barWidth + gap;
    // Calculate number of bars based on ruler width for accurate time mapping
    const numBars = Math.min(peaks.length, Math.floor(rulerWidth / totalBarWidth));
    const peaksPerBar = peaks.length / numBars;

    // Purple gradient
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(139, 92, 246, 0.9)');
    gradient.addColorStop(0.5, 'rgba(99, 102, 241, 0.85)');
    gradient.addColorStop(1, 'rgba(139, 92, 246, 0.9)');
    ctx.fillStyle = gradient;

    // Draw mirrored waveform bars with max-pooling (preserves peaks for word gaps)
    for (let i = 0; i < numBars; i++) {
      // Use max of all peaks in this bar's range (preserves word gap visibility)
      const startPeak = Math.floor(i * peaksPerBar);
      const endPeak = Math.floor((i + 1) * peaksPerBar);
      let maxPeak = 0;
      for (let j = startPeak; j < endPeak && j < peaks.length; j++) {
        if (peaks[j] > maxPeak) maxPeak = peaks[j];
      }
      const barHeight = Math.max(1, maxPeak * height * 0.9);
      // Apply offset for ruler alignment
      const x = i * totalBarWidth + offsetX;
      const y = (height - barHeight) / 2;

      // Skip bars that would be outside canvas bounds
      if (x < 0 || x > width) continue;

      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, barHeight, 1);
      ctx.fill();
    }

    // Center line
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    // DISABLED: Transcript words on waveform - clutters the visualization
    // if (this.transcriptSegments?.length > 0 && duration > 0) {
    //   this.drawTranscriptOnWaveform(ctx, width, height, duration, alignInfo);
    // }

    this.drawWaveformStatus(ctx, width, height, method);
  },

  // Draw LINE waveform - continuous line showing actual audio shape
  // alignInfo: { rulerWidth, offsetX, canvasWidth } - for accurate time alignment
  drawWaveformLine(ctx, width, height, peaks, duration, method, alignInfo = {}) {
    ctx.clearRect(0, 0, width, height);

    // Use ruler width for time-accurate positioning
    const { rulerWidth = width, offsetX = 0 } = alignInfo;

    const centerY = height / 2;
    const amplitude = height * 0.4;

    // Draw background gradient
    const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
    bgGrad.addColorStop(0, 'rgba(99, 102, 241, 0.1)');
    bgGrad.addColorStop(0.5, 'rgba(99, 102, 241, 0.05)');
    bgGrad.addColorStop(1, 'rgba(99, 102, 241, 0.1)');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

    // Draw the waveform as a filled area
    ctx.beginPath();
    ctx.moveTo(offsetX, centerY);

    // Top line - use rulerWidth for time-accurate positioning
    for (let i = 0; i < peaks.length; i++) {
      const x = (i / peaks.length) * rulerWidth + offsetX;
      const y = centerY - peaks[i] * amplitude;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }

    // Bottom line (mirror)
    for (let i = peaks.length - 1; i >= 0; i--) {
      const x = (i / peaks.length) * rulerWidth + offsetX;
      const y = centerY + peaks[i] * amplitude;
      ctx.lineTo(x, y);
    }

    ctx.closePath();

    // Fill with gradient
    const fillGrad = ctx.createLinearGradient(0, 0, 0, height);
    fillGrad.addColorStop(0, 'rgba(139, 92, 246, 0.6)');
    fillGrad.addColorStop(0.5, 'rgba(99, 102, 241, 0.8)');
    fillGrad.addColorStop(1, 'rgba(139, 92, 246, 0.6)');
    ctx.fillStyle = fillGrad;
    ctx.fill();

    // Draw center line detail
    ctx.strokeStyle = 'rgba(139, 92, 246, 0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < peaks.length; i++) {
      const x = (i / peaks.length) * rulerWidth + offsetX;
      const y = centerY - peaks[i] * amplitude * 0.5;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    // Center line
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(width, centerY);
    ctx.stroke();

    // DISABLED: Transcript words on waveform - clutters the visualization
    // if (this.transcriptSegments?.length > 0 && duration > 0) {
    //   this.drawTranscriptOnWaveform(ctx, width, height, duration, alignInfo);
    // }

    this.drawWaveformStatus(ctx, width, height, method);
  },

  // Draw MIRROR waveform - traditional Pro Tools style (shows word gaps clearly)
  // alignInfo: { rulerWidth, offsetX, canvasWidth } - for accurate time alignment
  drawWaveformMirror(ctx, width, height, peaks, duration, method, alignInfo = {}) {
    ctx.clearRect(0, 0, width, height);

    // Use ruler width for time-accurate positioning
    const { rulerWidth = width, offsetX = 0 } = alignInfo;

    const centerY = height / 2;
    const amplitude = height * 0.45;

    // Down-sample peaks to ruler width using max-pooling for time-accurate display
    const displayPeaks = [];
    const displayWidth = Math.ceil(rulerWidth);
    const peaksPerPixel = peaks.length / displayWidth;
    for (let x = 0; x < displayWidth; x++) {
      const startPeak = Math.floor(x * peaksPerPixel);
      const endPeak = Math.floor((x + 1) * peaksPerPixel);
      let maxPeak = 0;
      for (let j = startPeak; j < endPeak && j < peaks.length; j++) {
        if (peaks[j] > maxPeak) maxPeak = peaks[j];
      }
      displayPeaks.push(maxPeak);
    }

    // Draw waveform envelope
    ctx.beginPath();

    // Top envelope - apply offset for ruler alignment
    for (let i = 0; i < displayPeaks.length; i++) {
      const x = i + offsetX;
      const y = centerY - displayPeaks[i] * amplitude;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }

    // Connect to bottom
    ctx.lineTo(rulerWidth + offsetX, centerY);

    // Bottom envelope (mirror)
    for (let i = displayPeaks.length - 1; i >= 0; i--) {
      const x = i + offsetX;
      const y = centerY + displayPeaks[i] * amplitude;
      ctx.lineTo(x, y);
    }

    ctx.closePath();

    // Gradient fill
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(16, 185, 129, 0.7)');
    gradient.addColorStop(0.3, 'rgba(99, 102, 241, 0.8)');
    gradient.addColorStop(0.5, 'rgba(139, 92, 246, 0.9)');
    gradient.addColorStop(0.7, 'rgba(99, 102, 241, 0.8)');
    gradient.addColorStop(1, 'rgba(16, 185, 129, 0.7)');
    ctx.fillStyle = gradient;
    ctx.fill();

    // Add glow effect
    ctx.shadowColor = 'rgba(139, 92, 246, 0.5)';
    ctx.shadowBlur = 10;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Center line
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(width, centerY);
    ctx.stroke();
    ctx.setLineDash([]);

    // DISABLED: Transcript words on waveform - clutters the visualization
    // if (this.transcriptSegments?.length > 0 && duration > 0) {
    //   this.drawTranscriptOnWaveform(ctx, width, height, duration, alignInfo);
    // }

    this.drawWaveformStatus(ctx, width, height, method);
  },

  // Draw SPECTROGRAM - fast amplitude-based heat map visualization
  // alignInfo: { rulerWidth, offsetX, canvasWidth } - for accurate time alignment
  async drawSpectrogram(ctx, width, height, duration, method, alignInfo = {}) {
    console.log('[Spectrogram] Starting fast draw:', { width, height, duration, hasAudioBuffer: !!this.audioBuffer });

    // Reset transform to draw spectrogram at actual pixel level
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // Get actual canvas pixel dimensions
    const canvas = ctx.canvas;
    const actualWidth = canvas.width;
    const actualHeight = canvas.height;

    ctx.clearRect(0, 0, actualWidth, actualHeight);

    try {
      const audioBuffer = this.audioBuffer;

      if (!audioBuffer) {
        // For long videos, don't attempt to load audio buffer (too memory-intensive)
        // Fall back to non-spectrogram waveform display
        const MAX_DURATION_FOR_SPECTROGRAM = 1800; // 30 minutes
        if (duration > MAX_DURATION_FOR_SPECTROGRAM) {
          console.log(
            '[Spectrogram] Video too long (' + Math.round(duration / 60) + ' min), falling back to simple waveform'
          );
          ctx.restore();
          // Draw a simple bars waveform instead using cached peaks
          if (this.waveformMasterPeaks?.length > 0) {
            const peaks = this.downsamplePeaks(this.waveformMasterPeaks, width);
            this.drawWaveform(ctx, width, height, peaks, duration, 'fallback', alignInfo);
          } else {
            ctx.fillStyle = 'rgba(139, 92, 246, 0.3)';
            ctx.fillRect(0, 0, width, height);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
            ctx.font = '11px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Waveform not available for long videos', width / 2, height / 2);
          }
          return;
        }

        console.log('[Spectrogram] No audioBuffer, attempting to load...');
        ctx.restore();
        ctx.fillStyle = 'rgba(139, 92, 246, 0.2)';
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Loading audio...', width / 2, height / 2);

        try {
          await this.extractAudioPeaksWebAudio(width);
          if (this.audioBuffer) {
            setTimeout(() => this.drawSpectrogram(ctx, width, height, duration, method, alignInfo), 100);
          }
        } catch (e) {
          console.warn('[Spectrogram] Could not load audio:', e.message);
          ctx.fillStyle = 'rgba(139, 92, 246, 0.3)';
          ctx.fillRect(0, 0, width, height);
          ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
          ctx.font = '11px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('Using simple waveform', width / 2, height / 2);
        }
        return;
      }

      // Safety check: cap canvas dimensions to prevent memory crash
      const MAX_SPECTROGRAM_WIDTH = 8000;
      const MAX_SPECTROGRAM_HEIGHT = 400;
      const drawWidth = Math.min(actualWidth, MAX_SPECTROGRAM_WIDTH);
      const drawHeight = Math.min(actualHeight, MAX_SPECTROGRAM_HEIGHT);

      if (actualWidth > MAX_SPECTROGRAM_WIDTH || actualHeight > MAX_SPECTROGRAM_HEIGHT) {
        console.warn(
          '[Spectrogram] Canvas too large, capping:',
          actualWidth,
          'x',
          actualHeight,
          '→',
          drawWidth,
          'x',
          drawHeight
        );
      }

      console.log('[Spectrogram] Drawing amplitude heat map at', drawWidth, 'x', drawHeight);

      const channelData = audioBuffer.getChannelData(0);
      const totalSamples = channelData.length;

      // Pre-generate color lookup (256 colors) - cool to hot gradient
      const colors = new Array(256);
      for (let i = 0; i < 256; i++) {
        const t = i / 255;
        let r, g, b;
        if (t < 0.2) {
          r = 15;
          g = 15;
          b = Math.floor(40 + t * 5 * 120);
        } else if (t < 0.4) {
          r = Math.floor((t - 0.2) * 5 * 80);
          g = Math.floor((t - 0.2) * 5 * 150);
          b = 160;
        } else if (t < 0.6) {
          r = 80;
          g = 150 + Math.floor((t - 0.4) * 5 * 105);
          b = Math.floor(160 - (t - 0.4) * 5 * 160);
        } else if (t < 0.8) {
          r = 80 + Math.floor((t - 0.6) * 5 * 175);
          g = 255;
          b = 0;
        } else {
          r = 255;
          g = Math.floor(255 - (t - 0.8) * 5 * 100);
          b = Math.floor((t - 0.8) * 5 * 80);
        }
        colors[i] = { r, g, b };
      }

      // Create image data at capped size to prevent memory issues
      const imageData = ctx.createImageData(drawWidth, drawHeight);
      const data = imageData.data;

      // Fill with dark background first
      for (let i = 0; i < data.length; i += 4) {
        data[i] = 15;
        data[i + 1] = 15;
        data[i + 2] = 35;
        data[i + 3] = 255;
      }

      // Sample stride - process fewer samples for speed
      const stride = Math.max(1, Math.floor(totalSamples / (drawWidth * 64)));

      // First pass: find max amplitude for normalization
      let globalMax = 0;
      for (let i = 0; i < totalSamples; i += stride * 10) {
        const amp = Math.abs(channelData[i]);
        if (amp > globalMax) globalMax = amp;
      }
      if (globalMax < 0.001) globalMax = 1; // Prevent division by zero

      // Process each column - simple amplitude visualization with vertical spread
      for (let x = 0; x < drawWidth; x++) {
        const sampleStart = Math.floor((x / drawWidth) * totalSamples);
        const sampleEnd = Math.floor(((x + 1) / drawWidth) * totalSamples);

        // Get peak and average amplitude for this time slice
        let peak = 0;
        let sum = 0;
        let count = 0;
        for (let i = sampleStart; i < sampleEnd; i += stride) {
          const amp = Math.abs(channelData[i] || 0);
          if (amp > peak) peak = amp;
          sum += amp;
          count++;
        }
        const avg = count > 0 ? sum / count : 0;

        // Normalize
        const normPeak = peak / globalMax;
        const normAvg = avg / globalMax;

        // Draw vertical bar with gradient based on amplitude
        // Higher amplitude = taller and brighter bar from bottom
        const barHeight = Math.floor(normPeak * drawHeight * 0.9);

        for (let y = 0; y < barHeight; y++) {
          const screenY = drawHeight - 1 - y;
          // Color intensity based on position in bar and average amplitude
          const yRatio = y / barHeight;
          const intensity = (normAvg * 0.5 + yRatio * 0.5) * normPeak;
          const colorIdx = Math.min(255, Math.floor(intensity * 255));
          const color = colors[colorIdx];

          const idx = (screenY * drawWidth + x) * 4;
          data[idx] = color.r;
          data[idx + 1] = color.g;
          data[idx + 2] = color.b;
          data[idx + 3] = 255;
        }
      }

      // If we capped the drawing size, we need to scale the imageData to fill the canvas
      if (drawWidth < actualWidth || drawHeight < actualHeight) {
        // Create a temporary canvas to hold the drawn spectrogram
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = drawWidth;
        tempCanvas.height = drawHeight;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.putImageData(imageData, 0, 0);

        // Now draw the temp canvas scaled up to fill the actual canvas
        ctx.drawImage(tempCanvas, 0, 0, drawWidth, drawHeight, 0, 0, actualWidth, actualHeight);
        console.log('[Spectrogram] Scaled from', drawWidth, 'x', drawHeight, 'to', actualWidth, 'x', actualHeight);
      } else {
        ctx.putImageData(imageData, 0, 0);
      }

      // Restore transform for text drawing
      ctx.restore();

      console.log('[Spectrogram] Draw complete');

      // Draw amplitude scale label (using CSS dimensions)
      ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('High', 4, 12);
      ctx.fillText('Low', 4, height - 4);

      console.log('[Spectrogram] Done!');

      // DISABLED: Transcript words on waveform - clutters the visualization
      // if (this.transcriptSegments?.length > 0 && duration > 0) {
      //   this.drawTranscriptOnWaveform(ctx, width, height, duration, alignInfo);
      // }

      this.drawWaveformStatus(ctx, width, height, 'spectrogram');
    } catch (error) {
      console.error('[Spectrogram] Error:', error);
      ctx.restore(); // Restore transform on error
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = 'rgba(239, 68, 68, 0.3)';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Spectrogram error', width / 2, height / 2);
    }
  },

  // Generate color map for spectrogram
  generateSpectrogramColors() {
    const colors = [];
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let r, g, b;

      if (t < 0.25) {
        // Black to blue
        r = 0;
        g = 0;
        b = Math.floor(t * 4 * 180);
      } else if (t < 0.5) {
        // Blue to cyan
        r = 0;
        g = Math.floor((t - 0.25) * 4 * 255);
        b = 180;
      } else if (t < 0.75) {
        // Cyan to yellow
        r = Math.floor((t - 0.5) * 4 * 255);
        g = 255;
        b = Math.floor(180 - (t - 0.5) * 4 * 180);
      } else {
        // Yellow to red/white
        r = 255;
        g = Math.floor(255 - (t - 0.75) * 4 * 128);
        b = Math.floor((t - 0.75) * 4 * 128);
      }

      colors.push(`rgb(${r}, ${g}, ${b})`);
    }
    return colors;
  },

  // Simple DFT computation (for spectrogram)
  computeSimpleDFT(samples, numBins) {
    const magnitudes = new Float32Array(numBins);
    const N = samples.length;

    for (let k = 0; k < numBins; k++) {
      let real = 0;
      let imag = 0;

      for (let n = 0; n < N; n++) {
        const angle = (-2 * Math.PI * k * n) / N;
        real += samples[n] * Math.cos(angle);
        imag += samples[n] * Math.sin(angle);
      }

      magnitudes[k] = Math.sqrt(real * real + imag * imag) / N;
    }

    return magnitudes;
  },

  // Parse CSS color string to RGB values
  parseColor(color) {
    if (color.startsWith('rgb')) {
      const match = color.match(/(\d+),\s*(\d+),\s*(\d+)/);
      if (match) {
        return { r: parseInt(match[1]), g: parseInt(match[2]), b: parseInt(match[3]) };
      }
    }
    return { r: 0, g: 0, b: 0 };
  },

  // Draw status indicator for waveform
  drawWaveformStatus(ctx, width, height, method) {
    let statusText = '';
    if (this.transcriptSegments?.length > 0) {
      statusText = `✓ ${this.transcriptSegments.length} words`;
    } else {
      const methodLabels = {
        webaudio: '✓ HD Audio',
        'video-element': '✓ Live',
        cached: '✓ Cached',
        ffmpeg: '✓ FFmpeg',
        spectrogram: '✓ Spectrum',
      };
      statusText = methodLabels[method] || '';
    }

    if (statusText) {
      // Background for readability
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      const textWidth = ctx.measureText(statusText).width;
      ctx.fillRect(width - textWidth - 16, 2, textWidth + 12, 16);

      ctx.fillStyle = 'rgba(16, 185, 129, 0.9)';
      ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(statusText, width - 8, 13);
    }
  },

  // Draw ghost/skeleton waveform that pulses while loading
  waveformLoadingAnimation: null,
  drawWaveformLoading(ctx, width, height, _message) {
    // Cancel any existing animation
    if (this.waveformLoadingAnimation) {
      cancelAnimationFrame(this.waveformLoadingAnimation);
    }

    let pulsePhase = 0;

    const animate = () => {
      ctx.clearRect(0, 0, width, height);

      // Generate ghost waveform pattern (consistent shape, pulsing opacity)
      const barWidth = 2;
      const gap = 1;
      const totalBarWidth = barWidth + gap;
      const barCount = Math.floor(width / totalBarWidth);

      // Pulse effect
      const pulseAlpha = 0.15 + Math.sin(pulsePhase) * 0.1;

      // Draw ghost bars with realistic-looking pattern
      for (let i = 0; i < barCount; i++) {
        const x = i * totalBarWidth;

        // Create realistic waveform shape using multiple sine waves
        const t = i / barCount;
        const wave1 = Math.sin(t * Math.PI * 8) * 0.3;
        const wave2 = Math.sin(t * Math.PI * 23) * 0.2;
        const wave3 = Math.sin(t * Math.PI * 47) * 0.15;
        const envelope = Math.sin(t * Math.PI) * 0.5 + 0.5; // Fade at edges

        const amplitude = (0.3 + wave1 + wave2 + wave3) * envelope;
        const barHeight = Math.max(2, amplitude * height * 0.85);
        const y = (height - barHeight) / 2;

        // Ghost purple color with pulse
        ctx.fillStyle = `rgba(139, 92, 246, ${pulseAlpha})`;
        ctx.fillRect(x, y, barWidth, barHeight);
      }

      // Center line (ghost)
      ctx.strokeStyle = `rgba(255, 255, 255, ${pulseAlpha * 0.5})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
      ctx.stroke();

      // Subtle loading indicator in corner
      ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'left';
      const dots = '●'.repeat((Math.floor(pulsePhase * 2) % 3) + 1);
      ctx.fillText('Loading ' + dots, 8, height - 6);

      pulsePhase += 0.08;
      this.waveformLoadingAnimation = requestAnimationFrame(animate);
    };

    animate();
  },

  // Stop loading animation
  stopWaveformLoadingAnimation() {
    if (this.waveformLoadingAnimation) {
      cancelAnimationFrame(this.waveformLoadingAnimation);
      this.waveformLoadingAnimation = null;
    }
  },

  // Draw error state
  drawWaveformError(ctx, width, height, message) {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(239, 68, 68, 0.3)';
    ctx.fillRect(0, height * 0.35, width, height * 0.3);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(message, width / 2, height / 2 + 4);
  },

  // Debounced waveform regeneration for zoom changes
  waveformRegenerateTimeout: null,
  debouncedWaveformRegenerate() {
    if (this.waveformRegenerateTimeout) {
      clearTimeout(this.waveformRegenerateTimeout);
    }
    this.waveformRegenerateTimeout = setTimeout(() => {
      console.log('[Waveform] Regenerating for new zoom tier');
      this.generateAudioWaveform();
    }, 150);
  },

  // Downsample peaks array using max-pooling (preserves peaks for word gaps)
  downsamplePeaks(masterPeaks, targetCount) {
    if (!masterPeaks || masterPeaks.length <= targetCount) {
      return masterPeaks;
    }

    const result = new Float32Array(targetCount);
    const ratio = masterPeaks.length / targetCount;

    for (let i = 0; i < targetCount; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.floor((i + 1) * ratio);
      let max = 0;
      for (let j = start; j < end && j < masterPeaks.length; j++) {
        if (masterPeaks[j] > max) max = masterPeaks[j];
      }
      result[i] = max;
    }

    return result;
  },

  // Clear waveform cache (call when loading new video)
  clearWaveformCache() {
    this.waveformTiers = null;
    this.waveformImages = null; // Clear rendered image cache too
    this.waveformMasterPeaks = null;
    this.waveformCachePath = null;
    this.waveformDuration = 0;
  },

  // Force regenerate waveform from scratch (clears memory AND disk caches)
  async forceRegenerateWaveform() {
    console.log('[Waveform] Force regenerating waveform - clearing all caches...');

    // Clear memory cache
    this.clearWaveformCache();

    // Clear disk cache
    if (this.videoPath && window.videoEditor?.deleteWaveformCache) {
      try {
        const result = await window.videoEditor.deleteWaveformCache(this.videoPath);
        console.log('[Waveform] Disk cache cleared:', result);
      } catch (e) {
        console.warn('[Waveform] Could not clear disk cache:', e.message);
      }
    }

    // Regenerate with force flag (skips any remaining cache checks)
    return this.generateAudioWaveform(true);
  },

  // Draw transcript words on the waveform
  // alignInfo: { rulerWidth, offsetX, canvasWidth } - for accurate time alignment
  //
  // ⚠️  HARDENED: This feature is DISABLED by default (showWordsOnWaveform = false)
  // Words on waveform clutter the visualization. Use teleprompter instead.
  // This guard ensures words won't appear even if call sites are accidentally restored.
  drawTranscriptOnWaveform(ctx, width, height, duration, alignInfo = {}) {
    // HARDENED GUARD - prevents words on waveform unless explicitly enabled
    if (!this.showWordsOnWaveform) return;

    if (!this.transcriptSegments || this.transcriptSegments.length === 0) return;

    // Use ruler width for time-accurate positioning
    const { rulerWidth = width, offsetX = 0 } = alignInfo;

    ctx.save();

    // First, expand sentence segments into individual words if needed
    const words = this.expandTranscriptToWords(this.transcriptSegments);

    console.log('[VideoEditor] Drawing', words.length, 'words on waveform');

    // Settings for word display
    ctx.font = 'bold 10px system-ui, -apple-system, sans-serif';
    ctx.textBaseline = 'middle';

    // Track last word end to prevent overlap
    let lastWordEndX = -100;
    const minGap = 4; // Minimum pixels between words

    // Draw each word
    words.forEach((wordData, index) => {
      const startTime = wordData.start || 0;
      const text = (wordData.text || '').trim();

      if (!text || text.length === 0) return;

      // Calculate position on the waveform using ruler width for time accuracy
      const startX = (startTime / duration) * rulerWidth + offsetX;
      // Skip if would overlap with previous word
      if (startX < lastWordEndX + minGap) return;

      // Measure text
      const textWidth = ctx.measureText(text).width;

      // Draw background pill for readability
      const padding = 4;
      const pillWidth = textWidth + padding * 2;
      const pillHeight = 14;
      const pillX = startX;
      const pillY = height - pillHeight - 3;

      // Alternate colors for visual rhythm
      const colors = [
        'rgba(99, 102, 241, 0.9)', // indigo
        'rgba(139, 92, 246, 0.9)', // purple
        'rgba(79, 70, 229, 0.9)', // violet
      ];
      ctx.fillStyle = colors[index % colors.length];

      // Draw pill background
      ctx.beginPath();
      ctx.roundRect(pillX, pillY, pillWidth, pillHeight, 4);
      ctx.fill();

      // Draw the word text
      ctx.fillStyle = 'rgba(255, 255, 255, 1)';
      ctx.textAlign = 'left';
      ctx.fillText(text, pillX + padding, pillY + pillHeight / 2 + 1);

      // Update last word position
      lastWordEndX = pillX + pillWidth;
    });

    ctx.restore();
  },

  // Expand transcript segments into individual words with timing
  // Preserves speakerId from diarization
  expandTranscriptToWords(segments) {
    const words = [];

    segments.forEach((segment) => {
      const text = (segment.text || segment.word || '').trim();
      const startTime = segment.start || 0;
      const endTime = segment.end || startTime + 1;
      // Preserve speaker ID from segment (supports multiple naming conventions)
      const speakerId = segment.speakerId || segment.speaker_id || segment.speaker || null;

      // If this is already a single word (no spaces), use it directly
      if (!text.includes(' ')) {
        if (text.length > 0) {
          words.push({
            text: text,
            start: startTime,
            end: endTime,
            speakerId: speakerId,
          });
        }
        return;
      }

      // Split sentence into words and distribute timing
      const segmentWords = text.split(/\s+/).filter((w) => w.length > 0);
      const segmentDuration = endTime - startTime;
      const wordDuration = segmentDuration / segmentWords.length;

      segmentWords.forEach((word, i) => {
        words.push({
          text: word,
          start: startTime + i * wordDuration,
          end: startTime + (i + 1) * wordDuration,
          speakerId: speakerId, // All words from this segment have the same speaker
        });
      });
    });

    return words;
  },

  // ============================================
  // TELEPROMPTER - Live transcript display
  // ============================================

  teleprompterVisible: true, // Show by default when transcript available
  teleprompterExpanded: false,
  teleprompterWords: [], // Cached expanded words with timing
  transcriptSyncOffset: 0, // Offset in seconds to adjust transcript timing (+ = earlier, - = later)
  transcriptSyncRate: 1.0, // Rate multiplier for drift correction (< 1 = compress, > 1 = stretch)

  // Adjust transcript sync offset (in seconds)
  adjustTranscriptSync(delta) {
    this.transcriptSyncOffset += delta;
    // Clamp to reasonable range (-10s to +10s)
    this.transcriptSyncOffset = Math.max(-10, Math.min(10, this.transcriptSyncOffset));

    console.log('[Teleprompter] Sync offset:', this.transcriptSyncOffset.toFixed(2) + 's');

    // Update the sync label
    this.updateSyncLabel();

    // Update highlight immediately
    const video = document.getElementById('videoPlayer');
    if (video) {
      this.updateTeleprompterHighlight(video.currentTime);
    }
  },

  // Reset transcript sync offset
  resetTranscriptSync() {
    this.transcriptSyncOffset = 0;
    console.log('[Teleprompter] Sync offset reset to 0');

    // Update the sync label
    this.updateSyncLabel();
    this.showToast('info', 'Sync reset');

    const video = document.getElementById('videoPlayer');
    if (video) {
      this.updateTeleprompterHighlight(video.currentTime);
    }
  },

  // Update the sync offset label
  updateSyncLabel() {
    const label = document.getElementById('syncOffsetLabel');
    if (label) {
      const offset = this.transcriptSyncOffset;
      const rate = this.transcriptSyncRate;
      // Show both offset and rate if rate is not 1.0
      if (rate !== 1.0) {
        label.textContent = `${offset >= 0 ? '+' : ''}${offset.toFixed(1)}s @ ${(rate * 100).toFixed(0)}%`;
      } else {
        label.textContent = `${offset >= 0 ? '+' : ''}${offset.toFixed(1)}s`;
      }
      // Highlight when adjusted
      label.style.color = offset === 0 && rate === 1.0 ? '' : 'rgba(147, 112, 219, 0.9)';
    }
  },

  // Adjust sync rate to fix drift (timestamps multiplied by this rate)
  adjustTranscriptSyncRate(delta) {
    this.transcriptSyncRate += delta;
    // Clamp to wide range (50% to 200%)
    this.transcriptSyncRate = Math.max(0.5, Math.min(2.0, this.transcriptSyncRate));

    console.log('[Teleprompter] Sync rate:', (this.transcriptSyncRate * 100).toFixed(1) + '%');

    // Update the sync label
    this.updateSyncLabel();

    // Update highlight immediately
    const video = document.getElementById('videoPlayer');
    if (video) {
      this.updateTeleprompterHighlight(video.currentTime);
    }
  },

  // Reset all sync adjustments
  resetTranscriptSyncAll() {
    this.transcriptSyncOffset = 0;
    this.transcriptSyncRate = 1.0;
    this.syncCalibrationPoint = null;
    console.log('[Teleprompter] Sync reset to defaults');

    this.updateSyncLabel();
    this.showToast('info', 'Sync reset');

    const video = document.getElementById('videoPlayer');
    if (video) {
      this.updateTeleprompterHighlight(video.currentTime);
    }
  },

  // Two-point calibration for drift correction
  // Step 1: At video start, call calibrateSync(1) when a word is spoken
  // Step 2: Later in video, call calibrateSync(2) when another word is spoken
  syncCalibrationPoint: null,

  calibrateSyncPoint(pointNum) {
    const video = document.getElementById('videoPlayer');
    if (!video) return;

    const currentVideoTime = video.currentTime;

    // Find the currently highlighted word
    const currentWord = document.querySelector('.teleprompter-word.current');
    if (!currentWord) {
      this.showToast('error', 'Play video until a word is highlighted, then calibrate');
      return;
    }

    const transcriptTime = parseFloat(currentWord.dataset.start);

    if (pointNum === 1) {
      // First calibration point
      this.syncCalibrationPoint = {
        videoTime: currentVideoTime,
        transcriptTime: transcriptTime,
      };
      this.showToast(
        'info',
        `Point 1 set at ${this.formatTime(currentVideoTime)}. Now go later in video and press Alt+2`
      );
      console.log('[Teleprompter] Calibration point 1:', this.syncCalibrationPoint);
    } else if (pointNum === 2 && this.syncCalibrationPoint) {
      // Second calibration point - calculate rate and offset
      const p1 = this.syncCalibrationPoint;
      const p2 = { videoTime: currentVideoTime, transcriptTime: transcriptTime };

      console.log('[Teleprompter] Calibration point 2:', p2);

      // Solve: transcriptTime = videoTime * rate + offset
      // p1.transcriptTime = p1.videoTime * rate + offset
      // p2.transcriptTime = p2.videoTime * rate + offset
      // Subtracting: (p2.t - p1.t) = (p2.v - p1.v) * rate

      const deltaTranscript = p2.transcriptTime - p1.transcriptTime;
      const deltaVideo = p2.videoTime - p1.videoTime;

      if (Math.abs(deltaVideo) < 5) {
        this.showToast('error', 'Points too close together. Go at least 30 seconds apart.');
        return;
      }

      const newRate = deltaTranscript / deltaVideo;
      const newOffset = p1.transcriptTime - p1.videoTime * newRate;

      // Clamp to wide range
      this.transcriptSyncRate = Math.max(0.5, Math.min(2.0, newRate));
      this.transcriptSyncOffset = Math.max(-60, Math.min(60, newOffset));

      console.log(
        '[Teleprompter] Calibrated: rate=' +
          this.transcriptSyncRate.toFixed(3) +
          ', offset=' +
          this.transcriptSyncOffset.toFixed(2)
      );

      this.updateSyncLabel();
      this.updateTeleprompterHighlight(video.currentTime);

      this.showToast(
        'success',
        `Calibrated! Rate: ${(this.transcriptSyncRate * 100).toFixed(0)}%, Offset: ${this.transcriptSyncOffset.toFixed(1)}s`
      );
      this.syncCalibrationPoint = null;
    } else {
      this.showToast('info', 'Press Alt+1 at video start, then Alt+2 later to calibrate');
    }
  },

  // Toggle teleprompter visibility
  toggleTeleprompter() {
    const container = document.getElementById('teleprompterContainer');
    const toggleBtn = document.getElementById('teleprompterToggleBtn');

    // If trying to show teleprompter but no transcript exists, prompt for transcription
    if (!this.teleprompterVisible && (!this.transcriptSegments || this.transcriptSegments.length === 0)) {
      // Show a helpful message and suggest transcription
      this.showToast('info', '📝 No transcript available. Starting transcription...', 3000);
      this.transcribeForWaveform();
      return;
    }

    this.teleprompterVisible = !this.teleprompterVisible;

    if (this.teleprompterVisible) {
      container.classList.remove('hidden');
      toggleBtn?.classList.add('active');
      this.initTeleprompter();
    } else {
      container.classList.add('hidden');
      toggleBtn?.classList.remove('active');
    }
  },

  // Toggle teleprompter size
  toggleTeleprompterSize() {
    this.teleprompterExpanded = !this.teleprompterExpanded;
    const container = document.getElementById('teleprompterContainer');
    container.classList.toggle('expanded', this.teleprompterExpanded);
  },

  // Initialize teleprompter with transcript data
  initTeleprompter() {
    const wordsContainer = document.getElementById('teleprompterWords');

    // Check if we have transcript segments
    if (!this.transcriptSegments || this.transcriptSegments.length === 0) {
      wordsContainer.innerHTML = `
            <div class="teleprompter-empty">
              <span>No transcript</span>
              <button onclick="app.transcribeFullVideoForTeleprompter()">🎤 Transcribe</button>
            </div>
          `;
      return;
    }

    // Expand segments to individual words
    this.teleprompterWords = this.expandTranscriptToWords(this.transcriptSegments);

    // Log timing info to verify segments have real timestamps
    if (this.teleprompterWords.length > 0) {
      const first = this.teleprompterWords[0];
      const last = this.teleprompterWords[this.teleprompterWords.length - 1];
      console.log(
        '[Teleprompter] Loaded',
        this.teleprompterWords.length,
        'words (source:',
        this.transcriptSource + ')'
      );
      console.log('[Teleprompter] Time range:', first.start?.toFixed(1) + 's -', last.end?.toFixed(1) + 's');
    }

    // Render words
    this.renderTeleprompterWords();

    // Setup global listeners for word selection (drag to select)
    this.setupWordSelectionListeners();

    // Show warning if not Whisper-generated (timing may be inaccurate)
    this.updateTranscriptSourceIndicator();

    // Update highlighting for current time and scroll to it
    const video = document.getElementById('videoPlayer');
    if (video) {
      const currentTime = video.currentTime;
      console.log('[Teleprompter] Scrolling to current time:', currentTime.toFixed(1) + 's');

      // Use requestAnimationFrame to ensure DOM is ready
      requestAnimationFrame(() => {
        this.updateTeleprompterHighlight(currentTime);

        // Force scroll to current word if not found by highlight
        this.scrollTeleprompterToTime(currentTime);
      });
    }
  },

  // Update the transcript source indicator (warning for non-accurate sources)
  updateTranscriptSourceIndicator() {
    const container = document.getElementById('teleprompterContainer');
    if (!container) return;

    // Remove existing indicator
    let indicator = container.querySelector('.transcript-source-indicator');
    if (indicator) {
      indicator.remove();
    }

    // No warning needed for accurate AI transcripts (ElevenLabs Scribe or Whisper)
    if (this.transcriptSource === 'elevenlabs-scribe' || this.transcriptSource === 'whisper') {
      return; // No warning needed for accurate transcripts
    }

    // Create warning indicator
    indicator = document.createElement('div');
    indicator.className = 'transcript-source-indicator';

    if (this.transcriptSource === 'evenly-distributed' || this.transcriptSource === 'pending-evenly-distributed') {
      indicator.innerHTML = `
            <span class="indicator-warning">⚠️ Timing not synced</span>
            <button class="indicator-action" onclick="app.transcribeForWaveform()" title="Re-transcribe with ElevenLabs Scribe for accurate timing">
              🎤 Fix with AI
            </button>
          `;
      indicator.title =
        'Transcript timing is evenly distributed and may not match the audio. Click to re-transcribe with ElevenLabs Scribe for accurate word-level timestamps.';
    } else if (this.transcriptSource === 'youtube') {
      indicator.innerHTML = `
            <span class="indicator-info">📺 YouTube captions</span>
            <button class="indicator-action" onclick="app.transcribeForWaveform()" title="Re-transcribe with ElevenLabs Scribe for more accurate timing">
              🎤 Improve
            </button>
          `;
      indicator.title =
        'Using YouTube auto-captions. Timing may be slightly off. Click to re-transcribe with ElevenLabs Scribe for word-level accuracy.';
    } else {
      indicator.innerHTML = `
            <span class="indicator-unknown">❓ Unknown source</span>
            <button class="indicator-action" onclick="app.transcribeForWaveform()" title="Re-transcribe with ElevenLabs Scribe for accurate timing">
              🎤 Transcribe
            </button>
          `;
      indicator.title = 'Transcript source unknown. Click to re-transcribe with ElevenLabs Scribe for accurate timing.';
    }

    container.appendChild(indicator);
  },

  // Scroll teleprompter to show words at a specific time
  scrollTeleprompterToTime(targetTime) {
    if (!this.teleprompterWords || this.teleprompterWords.length === 0) return;

    // Find the word closest to targetTime
    let closestIndex = 0;
    let closestDiff = Infinity;

    this.teleprompterWords.forEach((word, index) => {
      const diff = Math.abs(word.start - targetTime);
      if (diff < closestDiff) {
        closestDiff = diff;
        closestIndex = index;
      }
    });

    // Scroll to that word using horizontal scroll
    const wordEl = document.querySelector(`.teleprompter-word[data-index="${closestIndex}"]`);
    if (wordEl) {
      this.scrollTeleprompterToWord(wordEl);
      console.log('[Teleprompter] Scrolled to word', closestIndex, ':', this.teleprompterWords[closestIndex].text);
    }
  },

  // Render teleprompter words
  // Uses windowing for large transcripts to prevent memory crashes
  renderTeleprompterWords() {
    const wordsContainer = document.getElementById('teleprompterWords');

    if (!this.teleprompterWords || this.teleprompterWords.length === 0) {
      wordsContainer.innerHTML = '<div class="teleprompter-empty">No words to display</div>';
      return;
    }

    // PERFORMANCE: For very large transcripts, only render a window around current time
    // This prevents DOM overload (15,000+ elements can crash the renderer)
    const MAX_RENDERED_WORDS = 2000; // Safe limit for DOM
    const WINDOW_SIZE = 500; // Words before and after current position

    let wordsToRender = this.teleprompterWords;
    let startIndex = 0;

    if (this.teleprompterWords.length > MAX_RENDERED_WORDS) {
      const video = document.getElementById('videoPlayer');
      const currentTime = video?.currentTime || 0;

      // Find current word index
      let currentIndex = this.teleprompterWords.findIndex((w) => w.start <= currentTime && w.end >= currentTime);
      if (currentIndex === -1) {
        // Find closest word
        currentIndex = this.teleprompterWords.findIndex((w) => w.start > currentTime) - 1;
        if (currentIndex < 0) currentIndex = 0;
      }

      // Calculate window
      startIndex = Math.max(0, currentIndex - WINDOW_SIZE);
      const endIndex = Math.min(this.teleprompterWords.length, currentIndex + WINDOW_SIZE);
      wordsToRender = this.teleprompterWords.slice(startIndex, endIndex);

      // Track window center for re-render detection
      this._lastTeleprompterWindowCenter = currentIndex;

      console.log(
        `[Teleprompter] Rendering ${wordsToRender.length} of ${this.teleprompterWords.length} words (window: ${startIndex}-${endIndex})`
      );
    }

    // Build a map of markers for quick lookup
    const markerMap = this.buildMarkerTimeMap();

    // Speaker color mapping (6 distinct colors)
    const speakerColors = [
      '#4a9eff', // Blue
      '#22c55e', // Green
      '#f59e0b', // Orange
      '#ec4899', // Pink
      '#8b5cf6', // Purple
      '#06b6d4', // Cyan
    ];

    // Build speaker index map for consistent coloring
    const speakerIndexMap = {};
    let speakerCount = 0;
    wordsToRender.forEach((word) => {
      const spkId = word.speakerId || word.speaker;
      if (spkId && !speakerIndexMap.hasOwnProperty(spkId)) {
        speakerIndexMap[spkId] = speakerCount++;
      }
    });

    let lastSpeakerId = null;

    wordsContainer.innerHTML = wordsToRender
      .map((word, localIndex) => {
        const index = startIndex + localIndex;
        const startTime = this.formatTime(word.start);
        const endTime = this.formatTime(word.end);
        const duration = ((word.end - word.start) * 1000).toFixed(0);

        // Check if word falls within any marker
        const markerInfo = this.getMarkerForTime(word.start, word.end, markerMap);
        let markerClass = '';
        let markerStyle = '';
        let markerTitle = '';
        let markerDataAttrs = '';

        if (markerInfo) {
          if (markerInfo.type === 'range') {
            markerClass = 'in-marker-range';
            markerStyle = `border-bottom: 2px solid ${markerInfo.color};`;
            markerTitle = ` | 📍 ${markerInfo.name}`;
            markerDataAttrs = `data-marker-id="${markerInfo.id}" data-marker-name="${markerInfo.name.replace(/"/g, '&quot;')}"`;
          } else if (markerInfo.type === 'spot') {
            markerClass = 'at-marker-point';
            markerStyle = `background: ${markerInfo.color}40;`;
            markerTitle = ` | 📌 ${markerInfo.name}`;
            markerDataAttrs = `data-marker-id="${markerInfo.id}" data-marker-name="${markerInfo.name.replace(/"/g, '&quot;')}"`;
          }
        }

        // Speaker information - subtle, only at transitions
        const speakerId = word.speakerId || word.speaker;
        let speakerLabel = '';
        let speakerClass = '';
        let isTransition = false;

        if (speakerId) {
          const speakerIndex = speakerIndexMap[speakerId] || 0;
          const speakerColor = speakerColors[speakerIndex % speakerColors.length];
          speakerClass = `speaker-${speakerIndex % 6}`;

          // Only add speaker label at actual speaker changes
          if (speakerId !== lastSpeakerId) {
            isTransition = true;
            // Use identified speaker name if available, otherwise fallback to S1, S2, etc.
            let displayName;
            if (this.speakerNames && this.speakerNames[speakerId]) {
              displayName = this.speakerNames[speakerId];
            } else if (word.speakerName) {
              displayName = word.speakerName;
            } else {
              const displayNum = speakerId.replace(/speaker_?/i, '');
              displayName = `S${parseInt(displayNum) + 1}`;
            }
            speakerLabel = `<span class="teleprompter-speaker-label clickable" 
                style="background: rgba(0,0,0,0.4); color: ${speakerColor};" 
                onclick="event.stopPropagation(); app.showSpeakerEditDropdown(event, '${speakerId}')"
                title="Click to edit speaker">${displayName}</span>`;
          }
          lastSpeakerId = speakerId;
        }

        // Add transition class only to first word of speaker change
        const transitionClass = isTransition ? 'speaker-transition' : '';

        return `${speakerLabel}<span class="teleprompter-word ${markerClass} ${speakerClass} ${transitionClass}"
                data-index="${index}"
                data-start="${word.start}"
                data-end="${word.end}"
                data-timecode="${startTime}"
                data-speaker="${speakerId || ''}"
                ${markerDataAttrs}
                style="${markerStyle}; user-select: none;"
                onmousedown="app.startWordSelection(event, ${index})"
                onmouseover="app.extendWordSelection(event, ${index})"
                onmouseup="app.completeWordSelection(event, ${index})"
                ondblclick="app.editMarkerFromTeleprompter(${markerInfo?.id || 'null'})"
                oncontextmenu="app.showWordSpeakerContextMenu(event, ${index})"
                title="${startTime} → ${endTime} (${duration}ms)${markerTitle}${speakerId ? ' | Drag to select, Right-click to change speaker' : ''}">${word.text}</span>`;
      })
      .join('');

    // Add marker indicators at marker boundaries
    this.addMarkerIndicatorsToTeleprompter();

    // Add speaker legend if there are multiple speakers
    this.addSpeakerLegendToTeleprompter(speakerIndexMap, speakerColors);

    // Add insertion cursor for between-word hover
    this.setupTeleprompterInsertionCursor();
  },

  // Add speaker legend to teleprompter - subtle, only if 2+ speakers
  addSpeakerLegendToTeleprompter(speakerIndexMap, speakerColors) {
    const container = document.getElementById('teleprompterContainer');
    if (!container) return;

    // Remove existing legend
    const existingLegend = container.querySelector('.teleprompter-speaker-legend');
    if (existingLegend) {
      existingLegend.remove();
    }

    // Only show if there are 2+ speakers (no need for legend with single speaker)
    const speakers = Object.keys(speakerIndexMap);
    if (speakers.length < 2) return;

    // Create minimal legend
    const legend = document.createElement('div');
    legend.className = 'teleprompter-speaker-legend';

    // Check if we have identified speaker names
    const hasIdentifiedNames = this.speakerNames && Object.keys(this.speakerNames).length > 0;

    speakers.forEach((speakerId) => {
      const index = speakerIndexMap[speakerId];
      const color = speakerColors[index % speakerColors.length];

      // Use identified name if available, otherwise fallback to S1, S2, etc.
      let displayName;
      if (hasIdentifiedNames && this.speakerNames[speakerId]) {
        displayName = this.speakerNames[speakerId];
      } else {
        const displayNum = speakerId.replace(/speaker_?/i, '');
        displayName = `S${parseInt(displayNum) + 1}`;
      }

      legend.innerHTML += `
            <div class="speaker-legend-item clickable" 
                 title="Click to edit ${speakerId}"
                 onclick="event.stopPropagation(); app.showSpeakerEditDropdown(event, '${speakerId}')">
              <span class="speaker-legend-dot" style="background: ${color}"></span>
              <span>${displayName}</span>
            </div>
          `;
    });

    // Add "Identify" button if speakers not identified yet
    if (!hasIdentifiedNames && speakers.length >= 2) {
      legend.innerHTML += `
            <button class="speaker-legend-identify-btn" onclick="app.identifySpeakersFromTranscript()" title="Use AI to identify speaker names">
              👥 Identify
            </button>
          `;
    }

    container.appendChild(legend);
  },

  // Build a time-indexed map of markers for quick lookup
  buildMarkerTimeMap() {
    const map = { ranges: [], spots: [] };

    for (const marker of this.markers) {
      if (marker.type === 'range') {
        map.ranges.push({
          id: marker.id,
          name: marker.name,
          type: 'range',
          inTime: marker.inTime,
          outTime: marker.outTime,
          color: marker.color,
        });
      } else {
        map.spots.push({
          id: marker.id,
          name: marker.name,
          type: 'spot',
          time: marker.time,
          color: marker.color,
        });
      }
    }

    return map;
  },

  // Check if a word time falls within any marker
  getMarkerForTime(wordStart, wordEnd, markerMap) {
    // Check ranges first (higher priority visual)
    for (const range of markerMap.ranges) {
      if (wordStart >= range.inTime && wordEnd <= range.outTime) {
        return range;
      }
    }

    // Check spot markers (word contains the marker time)
    for (const spot of markerMap.spots) {
      if (wordStart <= spot.time && wordEnd >= spot.time) {
        return spot;
      }
    }

    return null;
  },

  // Add visual marker indicators (brackets/pins) at marker boundaries
  addMarkerIndicatorsToTeleprompter() {
    const wordsContainer = document.getElementById('teleprompterWords');
    if (!wordsContainer) return;

    // Find first and last words for each range marker to add brackets
    for (const marker of this.markers) {
      if (marker.type === 'range') {
        // Find first word in range
        const firstWord = wordsContainer.querySelector(`.teleprompter-word[data-marker-id="${marker.id}"]`);
        if (firstWord) {
          firstWord.classList.add('marker-range-start');
          firstWord.style.setProperty('--marker-color', marker.color);
        }

        // Find last word in range
        const markerWords = wordsContainer.querySelectorAll(`.teleprompter-word[data-marker-id="${marker.id}"]`);
        if (markerWords.length > 0) {
          const lastWord = markerWords[markerWords.length - 1];
          lastWord.classList.add('marker-range-end');
          lastWord.style.setProperty('--marker-color', marker.color);
        }
      } else if (marker.type === 'spot') {
        // Add pin icon to spot marker words
        const spotWord = wordsContainer.querySelector(`.teleprompter-word[data-marker-id="${marker.id}"]`);
        if (spotWord) {
          spotWord.classList.add('marker-spot-word');
        }
      }
    }
  },

  // Double-click on a marker indicator in teleprompter to edit it
  editMarkerFromTeleprompter(markerId) {
    if (!markerId) return;
    const marker = this.markers.find((m) => m.id === markerId);
    if (marker) {
      // Use the marker's time for spot markers, or inTime for ranges
      const time = marker.type === 'range' ? marker.inTime : marker.time;
      this.showMarkerModal(time, marker);
    }
  },

  // Handle click on a teleprompter word
  handleTeleprompterWordClick(event, startTime, endTime) {
    event.stopPropagation();

    // If in range marking mode, complete the range at end of this word
    if (this.teleprompterRangeStart) {
      this.completeTeleprompterRangeMarker(endTime);
      return;
    }

    // Otherwise, seek to word start
    this.seekToWord(startTime);
  },

  // State for teleprompter range marker creation
  teleprompterRangeStart: null, // { time, x } - when waiting for range end

  // Setup the insertion cursor that appears between words on hover
  setupTeleprompterInsertionCursor() {
    const container = document.getElementById('teleprompterContainer');
    const content = document.getElementById('teleprompterContent');
    const wordsContainer = document.getElementById('teleprompterWords');
    if (!container || !wordsContainer) return;

    // Create or get cursor element
    let cursor = container.querySelector('.teleprompter-cursor');
    if (!cursor) {
      cursor = document.createElement('div');
      cursor.className = 'teleprompter-cursor';
      cursor.innerHTML = `
            <div class="cursor-line"></div>
            <div class="cursor-timecode"></div>
            <div class="cursor-hint">Click to mark</div>
          `;
      container.appendChild(cursor);
    }

    // Create or get range indicator (shows pending range start)
    let rangeIndicator = container.querySelector('.teleprompter-range-indicator');
    if (!rangeIndicator) {
      rangeIndicator = document.createElement('div');
      rangeIndicator.className = 'teleprompter-range-indicator';
      rangeIndicator.innerHTML = `
            <div class="range-start-line"></div>
            <div class="range-start-label">IN</div>
          `;
      container.appendChild(rangeIndicator);
    }

    // Remove any existing listener
    if (this._teleprompterMouseMove) {
      (content || wordsContainer).removeEventListener('mousemove', this._teleprompterMouseMove);
    }

    // Track mouse position to show cursor between/near words
    this._teleprompterMouseMove = (e) => {
      const words = wordsContainer.querySelectorAll('.teleprompter-word');
      if (words.length === 0) {
        cursor.style.display = 'none';
        return;
      }

      const mouseX = e.clientX;
      const containerRect = container.getBoundingClientRect();

      // Check if mouse is directly over a word
      const isOverWord = e.target && e.target.classList && e.target.classList.contains('teleprompter-word');

      if (isOverWord) {
        // Over a word - hide cursor (word itself handles highlighting)
        cursor.style.display = 'none';
        return;
      }

      // Find the gap the mouse is in, or the closest edge
      let cursorTime = null;
      let cursorX = null;

      // Check each word to find gaps
      for (let i = 0; i < words.length; i++) {
        const wordRect = words[i].getBoundingClientRect();
        const wordStart = parseFloat(words[i].dataset.start);
        const wordEnd = parseFloat(words[i].dataset.end);

        // Before first word
        if (i === 0 && mouseX < wordRect.left) {
          cursorTime = wordStart;
          cursorX = wordRect.left - containerRect.left;
          break;
        }

        // After this word, before next word (the gap)
        if (i < words.length - 1) {
          const nextRect = words[i + 1].getBoundingClientRect();
          const nextStart = parseFloat(words[i + 1].dataset.start);

          // Is mouse in the gap between this word and next?
          if (mouseX >= wordRect.right && mouseX <= nextRect.left) {
            // Interpolate time based on position in gap
            const gapWidth = nextRect.left - wordRect.right;
            const gapProgress = gapWidth > 0 ? (mouseX - wordRect.right) / gapWidth : 0.5;
            cursorTime = wordEnd + (nextStart - wordEnd) * gapProgress;
            cursorX = mouseX - containerRect.left;
            break;
          }
        }

        // After last word
        if (i === words.length - 1 && mouseX > wordRect.right) {
          cursorTime = wordEnd;
          cursorX = wordRect.right - containerRect.left;
          break;
        }
      }

      if (cursorTime !== null && cursorX !== null) {
        cursor.style.display = 'flex';
        cursor.style.left = `${cursorX}px`;
        cursor.querySelector('.cursor-timecode').textContent = this.formatTime(cursorTime);
        cursor.dataset.time = cursorTime;

        // Update hint based on state
        const hint = cursor.querySelector('.cursor-hint');
        if (this.teleprompterRangeStart) {
          hint.textContent = 'Click for OUT';
          cursor.classList.add('range-end-mode');
        } else {
          hint.textContent = 'Click to mark';
          cursor.classList.remove('range-end-mode');
        }
      } else {
        cursor.style.display = 'none';
      }
    };

    // Click handler for creating markers
    const handleCursorClick = (e) => {
      const time = parseFloat(cursor.dataset.time);
      if (isNaN(time)) return;

      e.stopPropagation();

      if (this.teleprompterRangeStart) {
        // Complete the range marker
        this.completeTeleprompterRangeMarker(time);
      } else {
        // Show marker type menu
        this.showTeleprompterMarkerMenu(e, time);
      }
    };

    cursor.onclick = handleCursorClick;

    // Listen on the content area (wider than just words)
    (content || wordsContainer).addEventListener('mousemove', this._teleprompterMouseMove);

    // Hide cursor when leaving (but keep range indicator if active)
    container.addEventListener('mouseleave', () => {
      cursor.style.display = 'none';
    });

    // ESC to cancel range marker
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.teleprompterRangeStart) {
        this.cancelTeleprompterRangeMarker();
      }
    });
  },

  // Show menu for marker type selection
  showTeleprompterMarkerMenu(event, time) {
    const menu = document.getElementById('contextMenu');
    const menuItems = document.getElementById('contextMenuItems');

    menuItems.innerHTML = `
          <div class="context-menu-header">📍 Add Marker at ${this.formatTime(time)}</div>
          <div class="context-menu-item" data-action="addPointMarker">
            <span class="context-menu-item-icon">📍</span>
            <span class="context-menu-item-label">Point Marker</span>
          </div>
          <div class="context-menu-item" data-action="startRangeMarker">
            <span class="context-menu-item-icon">↔️</span>
            <span class="context-menu-item-label">Start Range (IN)</span>
          </div>
          <div class="context-menu-divider"></div>
          <div class="context-menu-item" data-action="seekToTime">
            <span class="context-menu-item-icon">▶️</span>
            <span class="context-menu-item-label">Seek Here</span>
          </div>
        `;

    // Add click handlers
    menuItems.querySelectorAll('.context-menu-item').forEach((item) => {
      item.addEventListener('click', () => {
        const action = item.dataset.action;
        this.hideContextMenu();

        switch (action) {
          case 'addPointMarker':
            this.addTeleprompterPointMarker(time);
            break;
          case 'startRangeMarker':
            this.startTeleprompterRangeMarker(time);
            break;
          case 'seekToTime':
            this.seekToWord(time);
            break;
        }
      });
    });

    this.positionContextMenu(menu, event.clientX, event.clientY);
  },

  // Add a point marker from teleprompter
  addTeleprompterPointMarker(time) {
    // Get words around this time for context
    const nearbyWords = this.getWordsAroundTime(time, 3);
    const context = nearbyWords.map((w) => w.text).join(' ');

    // Seek to the marker time
    this.seekToWord(time);

    // Open the marker modal pre-filled for a point marker
    this.showMarkerModalForPoint(time, context);
  },

  // Show marker modal pre-filled for a point marker from teleprompter
  showMarkerModalForPoint(time, contextText) {
    const modal = document.getElementById('markerModal');
    const backdrop = document.getElementById('markerModalBackdrop');

    // Reset form
    this.editingMarkerId = null;
    this.selectedMarkerType = 'spot';

    // Store time on modal for saveMarker to use
    modal.dataset.time = time;

    // Update modal title
    document.getElementById('markerModalTitle').textContent = 'Add Point Marker';
    document.getElementById('saveMarkerBtn').textContent = 'Add Marker';

    // Set marker type to spot
    document.querySelectorAll('.marker-type-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.type === 'spot');
    });

    // Show type selector
    const typeGroup = document.getElementById('markerTypeGroup');
    if (typeGroup) typeGroup.style.display = 'block';

    // Show spot time group, hide range time group
    const spotTimeGroup = document.getElementById('spotTimeGroup');
    if (spotTimeGroup) spotTimeGroup.classList.remove('hidden');

    const rangeTimeGroup = document.getElementById('rangeTimeGroup');
    if (rangeTimeGroup) rangeTimeGroup.classList.add('hidden');

    // Update spot time display
    document.getElementById('markerTimeDisplay').textContent = this.formatTime(time);

    // Pre-fill fields
    document.getElementById('markerNameInput').value = '';
    document.getElementById('markerNameInput').placeholder = `Point at ${this.formatTime(time)}`;
    document.getElementById('markerDescription').value = contextText ? `"${contextText}"` : '';
    document.getElementById('markerTags').value = 'teleprompter';
    document.getElementById('markerNotes').value = '';

    // Clear transcription for point markers
    const transcriptionField = document.getElementById('markerTranscription');
    if (transcriptionField) {
      transcriptionField.value = '';
    }

    // Select a color
    this.selectedMarkerColor = this.markerColors[this.markers.length % this.markerColors.length];
    document.querySelectorAll('.color-option').forEach((opt) => {
      opt.classList.toggle('selected', opt.dataset.color === this.selectedMarkerColor);
    });

    // Hide ElevenLabs section for point markers
    const elevenLabsSection = document.getElementById('elevenLabsSection');
    if (elevenLabsSection) {
      elevenLabsSection.classList.add('hidden');
    }

    // Show modal
    modal.classList.remove('hidden');
    backdrop.classList.remove('hidden');

    // Focus the name field
    setTimeout(() => {
      document.getElementById('markerNameInput').focus();
    }, 100);
  },

  // Start a range marker from teleprompter
  startTeleprompterRangeMarker(time) {
    const container = document.getElementById('teleprompterContainer');
    const rangeIndicator = container?.querySelector('.teleprompter-range-indicator');

    this.teleprompterRangeStart = { time };

    // Show range indicator
    if (rangeIndicator) {
      // Calculate position from time
      const wordsContainer = document.getElementById('teleprompterWords');
      const words = wordsContainer?.querySelectorAll('.teleprompter-word');
      let indicatorX = 0;

      if (words) {
        for (const word of words) {
          const wordStart = parseFloat(word.dataset.start);
          if (wordStart >= time) {
            const rect = word.getBoundingClientRect();
            const containerRect = container.getBoundingClientRect();
            indicatorX = rect.left - containerRect.left;
            break;
          }
        }
      }

      rangeIndicator.style.left = `${indicatorX}px`;
      rangeIndicator.style.display = 'flex';
    }

    // Add visual class to container
    container?.classList.add('range-marking-mode');

    this.showToast(
      'info',
      `IN point set at ${this.formatTime(time)}. Click again for OUT point, or press ESC to cancel.`
    );
  },

  // Complete the range marker
  completeTeleprompterRangeMarker(outTime) {
    if (!this.teleprompterRangeStart) return;

    const inTime = this.teleprompterRangeStart.time;

    // Ensure in < out
    const startTime = Math.min(inTime, outTime);
    const endTime = Math.max(inTime, outTime);

    if (endTime - startTime < 0.5) {
      this.showToast('error', 'Range too short. Try a wider selection.');
      return;
    }

    // Get words in range for context
    const rangeWords = this.getWordsInRange(startTime, endTime);
    const context = rangeWords.map((w) => w.text).join(' ');

    // Clean up range marking UI first
    this.cancelTeleprompterRangeMarker();

    // Seek to start
    this.seekToWord(startTime);

    // Open the marker modal with pre-filled data
    this.showMarkerModalForRange(startTime, endTime, context);
  },

  // Show marker modal pre-filled for a range from teleprompter
  showMarkerModalForRange(inTime, outTime, transcriptText) {
    const modal = document.getElementById('markerModal');
    const backdrop = document.getElementById('markerModalBackdrop');

    // Reset form
    this.editingMarkerId = null;
    this.selectedMarkerType = 'range';
    this.rangeInTime = inTime;
    this.rangeOutTime = outTime;

    // Update modal title
    document.getElementById('markerModalTitle').textContent = 'Add Scene Marker';
    document.getElementById('saveMarkerBtn').textContent = 'Add Marker';

    // Set marker type to range
    document.querySelectorAll('.marker-type-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.type === 'range');
    });

    // Hide type selector since we know it's a range
    const typeGroup = document.getElementById('markerTypeGroup');
    if (typeGroup) typeGroup.style.display = 'none';

    // Show range time group (hide spot time group)
    const spotTimeGroup = document.getElementById('spotTimeGroup');
    if (spotTimeGroup) spotTimeGroup.classList.add('hidden');

    const rangeTimeGroup = document.getElementById('rangeTimeGroup');
    if (rangeTimeGroup) {
      rangeTimeGroup.classList.remove('hidden');
      document.getElementById('rangeInDisplay').textContent = this.formatTime(inTime);
      document.getElementById('rangeOutDisplay').textContent = this.formatTime(outTime);
      const durationEl = document.getElementById('rangeDuration');
      if (durationEl) durationEl.textContent = `Duration: ${this.formatTime(outTime - inTime)}`;
    }

    // Pre-fill fields
    document.getElementById('markerNameInput').value = ''; // User should name it
    document.getElementById('markerNameInput').placeholder = `Scene at ${this.formatTime(inTime)}`;
    document.getElementById('markerDescription').value = '';
    document.getElementById('markerTags').value = 'teleprompter';
    document.getElementById('markerNotes').value = '';

    // Pre-fill transcription with the words from the range
    const transcriptionField = document.getElementById('markerTranscription');
    if (transcriptionField) {
      transcriptionField.value = transcriptText || '';
    }

    // Select a color
    this.selectedMarkerColor = this.markerColors[this.markers.length % this.markerColors.length];
    document.querySelectorAll('.color-option').forEach((opt) => {
      opt.classList.toggle('selected', opt.dataset.color === this.selectedMarkerColor);
    });

    // Show ElevenLabs section if transcription available
    const elevenLabsSection = document.getElementById('elevenLabsSection');
    if (elevenLabsSection) {
      elevenLabsSection.classList.toggle('hidden', !transcriptText);
    }

    // Show modal
    modal.classList.remove('hidden');
    backdrop.classList.remove('hidden');

    // Focus the name field
    setTimeout(() => {
      document.getElementById('markerNameInput').focus();
    }, 100);
  },

  // Cancel range marker creation
  cancelTeleprompterRangeMarker() {
    this.teleprompterRangeStart = null;

    const container = document.getElementById('teleprompterContainer');
    const rangeIndicator = container?.querySelector('.teleprompter-range-indicator');

    if (rangeIndicator) {
      rangeIndicator.style.display = 'none';
    }

    container?.classList.remove('range-marking-mode');
  },

  // Get words around a specific time
  getWordsAroundTime(time, count = 3) {
    if (!this.teleprompterWords) return [];

    // Find the closest word
    let closestIndex = 0;
    let closestDiff = Infinity;

    this.teleprompterWords.forEach((word, i) => {
      const diff = Math.abs(word.start - time);
      if (diff < closestDiff) {
        closestDiff = diff;
        closestIndex = i;
      }
    });

    // Get words before and after
    const startIndex = Math.max(0, closestIndex - count);
    const endIndex = Math.min(this.teleprompterWords.length, closestIndex + count + 1);

    return this.teleprompterWords.slice(startIndex, endIndex);
  },

  // Get words in a time range
  getWordsInRange(startTime, endTime) {
    if (!this.teleprompterWords) return [];

    return this.teleprompterWords.filter((word) => word.start >= startTime && word.end <= endTime);
  },

  // Track last rendered window for windowing optimization
  _lastTeleprompterWindowCenter: 0,

  // Update teleprompter word highlighting based on current time
  updateTeleprompterHighlight(currentTime) {
    if (!this.teleprompterVisible || !this.teleprompterWords) {
      // Debug: log why we're returning early
      if (this.videoDetached) {
        console.log(
          '[TeleprompterHighlight] Skipping - visible:',
          this.teleprompterVisible,
          'words:',
          this.teleprompterWords?.length
        );
      }
      return;
    }

    // Apply sync adjustments:
    // 1. Rate adjustment scales the video time to match transcript timing
    //    If rate < 1, transcript is too spread out, so we compress video time
    //    If rate > 1, transcript is too compressed, so we stretch video time
    // 2. Offset shifts everything by a fixed amount
    const adjustedTime = currentTime * this.transcriptSyncRate + this.transcriptSyncOffset;

    // For large transcripts with windowing: check if we need to re-render
    const MAX_RENDERED_WORDS = 2000;
    const WINDOW_THRESHOLD = 300; // Re-render if moved 300 words from window center

    if (this.teleprompterWords.length > MAX_RENDERED_WORDS) {
      // Find current word index in full array
      let currentIndex = this.teleprompterWords.findIndex((w) => w.start <= adjustedTime && w.end >= adjustedTime);
      if (currentIndex === -1) {
        currentIndex = this.teleprompterWords.findIndex((w) => w.start > adjustedTime) - 1;
        if (currentIndex < 0) currentIndex = 0;
      }

      // Check if we've moved far from the last rendered window
      if (Math.abs(currentIndex - this._lastTeleprompterWindowCenter) > WINDOW_THRESHOLD) {
        console.log(
          `[Teleprompter] Re-rendering window (moved from ${this._lastTeleprompterWindowCenter} to ${currentIndex})`
        );
        this._lastTeleprompterWindowCenter = currentIndex;
        this.renderTeleprompterWords();
        return; // Will call updateTeleprompterHighlight again after render
      }
    }

    const words = document.querySelectorAll('.teleprompter-word');
    let currentWordElement = null;

    // Debug: log word count when detached
    if (this.videoDetached && this._lastWordCountLog !== words.length) {
      console.log('[TeleprompterHighlight] DOM words:', words.length, 'adjustedTime:', adjustedTime.toFixed(2));
      this._lastWordCountLog = words.length;
    }

    words.forEach((wordEl, _index) => {
      const start = parseFloat(wordEl.dataset.start);
      const end = parseFloat(wordEl.dataset.end);

      // Remove all classes first
      wordEl.classList.remove('current', 'spoken', 'upcoming');

      if (adjustedTime >= start && adjustedTime < end) {
        // Current word being spoken
        wordEl.classList.add('current');
        currentWordElement = wordEl;
      } else if (adjustedTime >= end) {
        // Already spoken
        wordEl.classList.add('spoken');
      } else if (adjustedTime < start && adjustedTime >= start - 3) {
        // Upcoming (within 3 seconds)
        wordEl.classList.add('upcoming');
      }
    });

    // Debug: log when current word is found (throttled)
    if (this.videoDetached && currentWordElement) {
      const wordText = currentWordElement.textContent;
      if (this._lastHighlightedWord !== wordText) {
        console.log('[TeleprompterHighlight] Current word:', wordText, 'at', adjustedTime.toFixed(2));
        this._lastHighlightedWord = wordText;
      }
    }

    // Horizontal scroll to center current word
    if (currentWordElement) {
      this.scrollTeleprompterToWord(currentWordElement);
    }
  },

  // Smooth horizontal scroll to center a word
  scrollTeleprompterToWord(wordElement) {
    const container = document.getElementById('teleprompterContent');
    if (!container || !wordElement) return;

    const containerWidth = container.offsetWidth;
    const wordLeft = wordElement.offsetLeft;
    const wordWidth = wordElement.offsetWidth;

    // Position word slightly left of center (30% from left) so user sees more upcoming words
    const targetScroll = wordLeft - containerWidth * 0.3 + wordWidth / 2;

    // Smooth scroll
    container.scrollTo({
      left: targetScroll,
      behavior: 'smooth',
    });
  },

  // Seek to a specific word's start time
  seekToWord(startTime) {
    const video = document.getElementById('videoPlayer');
    if (video) {
      video.currentTime = startTime;
      this.updateTeleprompterHighlight(startTime);
    }
  },

  // Transcribe full video for teleprompter using ElevenLabs Scribe
  async transcribeFullVideoForTeleprompter() {
    if (!this.videoPath) {
      this.showToast('error', 'No video loaded');
      return;
    }

    this.showProgress('Extracting audio...', 'Preparing for transcription');

    try {
      // Extract audio first
      const audioResult = await window.videoEditor.extractAudio(this.videoPath, {
        format: 'mp3',
        startTime: 0,
        duration: this.videoInfo?.duration || null,
      });

      if (!audioResult.outputPath) {
        throw new Error('Failed to extract audio for transcription');
      }

      this.showProgress('Transcribing with AI...', 'Using ElevenLabs Scribe');

      // Use ElevenLabs Scribe for transcription
      const result = await window.videoEditor.transcribeScribe(audioResult.outputPath, {
        languageCode: 'en',
        temperature: 0,
      });

      this.hideProgress();

      if (!result.success) {
        throw new Error(result.error || 'Transcription failed');
      }

      const transcriptText = result.transcription || result.text;

      // Store detected speakers
      this.transcriptSpeakers = result.speakers || [];
      console.log(
        '[Teleprompter] Detected speakers:',
        this.transcriptSpeakers.length > 0 ? this.transcriptSpeakers.join(', ') : 'none'
      );

      if (transcriptText) {
        // Use word-level timestamps from Scribe if available
        if (result.words && result.words.length > 0) {
          this.transcriptSegments = result.words.map((w) => ({
            text: w.word || w.text,
            start: w.start,
            end: w.end,
            speakerId: w.speaker_id || w.speakerId,
          }));
          this.transcriptSource = 'elevenlabs-scribe';
          console.log('[Teleprompter] Using', result.words.length, 'ElevenLabs Scribe word timestamps');
        } else if (result.segments && result.segments.length > 0) {
          this.transcriptSegments = result.segments;
          this.transcriptSource = 'elevenlabs-scribe';
          console.log('[Teleprompter] Using', result.segments.length, 'ElevenLabs Scribe segments');
        } else {
          // Fallback: distribute evenly (not accurate)
          const words = transcriptText.split(/\s+/).filter((w) => w.length > 0);
          const duration = this.videoInfo?.duration || 60;
          const wordDuration = duration / words.length;

          this.transcriptSegments = words.map((word, i) => ({
            text: word,
            start: i * wordDuration,
            end: (i + 1) * wordDuration,
          }));
          this.transcriptSource = 'evenly-distributed';
          console.warn('[Teleprompter] Using evenly distributed timing (not accurate)');
        }

        // Save transcription back to Space if this video is from a Space
        if (this.spaceItemId && window.clipboard?.updateMetadata) {
          try {
            await window.clipboard.updateMetadata(this.spaceItemId, {
              transcriptSegments: this.transcriptSegments,
              transcriptSpeakers: this.transcriptSpeakers,
              transcript: transcriptText,
              transcriptionSource: this.transcriptSource,
              transcriptionDate: new Date().toISOString(),
              language: result.language,
            });
            console.log('[Teleprompter] Saved transcription to Space item:', this.spaceItemId);
          } catch (saveError) {
            console.warn('[Teleprompter] Could not save transcription to Space:', saveError.message);
          }
        }

        // Reinitialize teleprompter
        this.initTeleprompter();

        // Also update waveform
        this.generateAudioWaveform();

        this.showToast('success', `Transcribed ${this.transcriptSegments.length} words!`);
      }
    } catch (error) {
      this.hideProgress();
      this.showToast('error', 'Transcription failed: ' + error.message);
    }
  },

  updateAudioPlayhead() {
    const video = document.getElementById('videoPlayer');
    const playhead = document.getElementById('audioPlayhead');
    const rulerMarks = document.getElementById('rulerMarks');
    const audioClip = playhead?.parentElement;

    if (!video.duration || !playhead) return;

    // When detached, use the time from detached window (video.currentTime stays frozen)
    const currentTime =
      this.videoDetached && this.detachedVideoTime !== undefined ? this.detachedVideoTime : video.currentTime;

    // Align with ruler coordinate system
    if (rulerMarks && audioClip) {
      const rulerRect = rulerMarks.getBoundingClientRect();
      const clipRect = audioClip.getBoundingClientRect();
      const rulerX = (currentTime / video.duration) * rulerRect.width;
      const playheadLeft = rulerX + rulerRect.left - clipRect.left;
      playhead.style.left = `${playheadLeft}px`;
    } else {
      const percent = (currentTime / video.duration) * 100;
      playhead.style.left = `${percent}%`;
    }
  },

  // Calculate time from mouse position on timeline
  getTimeFromMouseEvent(event) {
    const video = document.getElementById('videoPlayer');
    const rulerMarks = document.getElementById('rulerMarks');

    if (!video?.duration || !rulerMarks) return null;

    const rulerRect = rulerMarks.getBoundingClientRect();
    const x = event.clientX - rulerRect.left;
    const percent = Math.max(0, Math.min(1, x / rulerRect.width));
    return percent * video.duration;
  },

  // Format time for display (with frames)
  formatTimeWithFrames(time) {
    const hours = Math.floor(time / 3600);
    const mins = Math.floor((time % 3600) / 60);
    const secs = Math.floor(time % 60);
    const frames = Math.floor((time % 1) * 30); // Assuming 30fps

    if (hours > 0) {
      return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}:${frames.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}:${frames.toString().padStart(2, '0')}`;
  },

  // Show floating time tooltip (shared for both video and audio tracks)
  showFloatingTimeTooltip(event) {
    const tooltip = document.getElementById('floatingTimeTooltip');
    const timeText = document.getElementById('floatingTimeText');

    if (!tooltip) return;

    const time = this.getTimeFromMouseEvent(event);
    if (time === null) return;

    timeText.textContent = this.formatTimeWithFrames(time);

    // Position tooltip above cursor using fixed positioning
    tooltip.style.left = `${event.clientX}px`;
    tooltip.style.top = `${event.clientY - 40}px`;
    tooltip.style.display = 'block';
  },

  // Hide floating time tooltip
  hideFloatingTimeTooltip() {
    const tooltip = document.getElementById('floatingTimeTooltip');
    if (tooltip) tooltip.style.display = 'none';
  },

  // Aliases for backward compatibility
  showTimelineTime(event) {
    this.showFloatingTimeTooltip(event);
  },

  hideTimelineTime() {
    this.hideFloatingTimeTooltip();
  },

  showWaveformTime(event) {
    this.showFloatingTimeTooltip(event);
  },

  hideWaveformTime() {
    this.hideFloatingTimeTooltip();
  },

  // Seek video from waveform click
  seekFromWaveform(event) {
    // Don't seek if clicking on buttons
    if (event.target.closest('button')) return;

    const video = document.getElementById('videoPlayer');
    const rulerMarks = document.getElementById('rulerMarks');

    if (!video?.duration || !rulerMarks) return;

    const rulerRect = rulerMarks.getBoundingClientRect();
    const x = event.clientX - rulerRect.left;
    const percent = Math.max(0, Math.min(1, x / rulerRect.width));
    const time = percent * video.duration;

    video.currentTime = time;
    console.log('[Waveform] Seeked to:', this.formatTime(time));
  },

  toggleAudioMute() {
    const video = document.getElementById('videoPlayer');
    const btn = document.getElementById('audioMuteBtn');

    this.audioMuted = !this.audioMuted;
    video.muted = this.audioMuted;

    btn.textContent = this.audioMuted ? '🔇' : '🔊';
    btn.classList.toggle('muted', this.audioMuted);

    // Also update main mute button
    this.updateMuteIcon();

    this.showToast(this.audioMuted ? 'warning' : 'success', this.audioMuted ? 'Audio muted' : 'Audio unmuted');
  },

  async detachAudio() {
    if (!this.videoPath) {
      this.showToast('error', 'No video loaded');
      return;
    }

    if (this.audioDetached) {
      this.showToast('warning', 'Audio already detached');
      return;
    }

    this.showProgress('Extracting Audio...', 'Separating audio track from video');

    try {
      const result = await window.videoEditor.extractAudio(this.videoPath, {
        format: 'mp3',
        audioBitrate: '192k',
      });

      this.hideProgress();

      if (result.error) {
        throw new Error(result.error);
      }

      // Mark audio as detached
      this.audioDetached = true;
      document.getElementById('audioTrack').classList.add('detached');
      document.getElementById('detachAudioBtn').disabled = true;
      document.getElementById('detachAudioBtn').style.opacity = '0.5';

      this.showToast('success', `Audio extracted to: ${result.outputPath.split('/').pop()}`);
      this.loadExports();
    } catch (error) {
      this.hideProgress();
      this.showToast('error', 'Failed to extract audio: ' + error.message);
    }
  },

  // ==================== MULTI-TRACK SYSTEM ====================
  // Guide Track: Synced to video, mute-only, uses video's embedded audio
  // Master Track: Independent, editable, uses extracted audio file
  audioTracks: [
    {
      id: 'guide',
      type: 'guide',
      name: 'Guide',
      syncedToVideo: true,
      locked: true,
      muted: false,
      solo: false,
      volume: 1.0,
    },
  ],
  nextTrackId: 2,

  // Extracted audio cache for Master track
  extractedAudioPath: null,
  isExtractingAudio: false,
  extractionProgress: 0,

  toggleAddTrackMenu(event) {
    event.stopPropagation();
    const menu = document.getElementById('addTrackMenu');

    menu.classList.toggle('visible');

    // Close menu when clicking outside
    const closeMenu = (e) => {
      if (!menu.contains(e.target)) {
        menu.classList.remove('visible');
        document.removeEventListener('click', closeMenu);
      }
    };

    setTimeout(() => {
      document.addEventListener('click', closeMenu);
    }, 10);
  },

  addAudioTrack(type) {
    const trackId = `A${this.nextTrackId++}`;
    const typeNames = {
      voice: 'Voice',
      dub: 'Dub',
      music: 'Music',
      sfx: 'SFX',
      ambience: 'Ambience',
      blank: 'Blank',
    };

    const track = {
      id: trackId,
      type: type,
      name: typeNames[type] || 'Audio',
      muted: false,
      solo: false,
      volume: 1.0,
      clips: [],
    };

    this.audioTracks.push(track);

    try {
      this.renderAudioTrack(track);
    } catch (renderError) {
      console.error('[AudioTrack] Render error:', renderError);
    }

    // Hide menu
    document.getElementById('addTrackMenu').classList.remove('visible');

    this.showToast('success', `Added ${track.name} track`);
  },

  // ==================== GUIDE + MASTER AUDIO ARCHITECTURE ====================

  /**
   * Initialize audio tracks for a video
   * Creates Guide track (synced to video) and starts Master track extraction
   */
  async initializeAudioTracks(videoPath, videoDuration) {
    console.log('[AudioTracks] Initializing for:', videoPath);

    // Reset tracks to just Guide
    this.audioTracks = [
      {
        id: 'guide',
        type: 'guide',
        name: 'Guide',
        syncedToVideo: true,
        locked: true,
        muted: false,
        solo: false,
        volume: 1.0,
      },
    ];
    this.extractedAudioPath = null;

    // Render Guide track
    this.renderAudioTracks();

    // Start smart extraction (check cache first)
    await this.smartExtractAudio(videoPath, videoDuration);
  },

  /**
   * Smart audio extraction with caching
   * Checks cache first, extracts in background if needed
   */
  async smartExtractAudio(videoPath, videoDuration) {
    if (!videoPath) return;

    console.log('[AudioTracks] Smart extraction starting...');

    try {
      // Check if cached audio exists
      const cacheResult = await window.videoEditor.checkAudioCache(videoPath);

      if (cacheResult.exists) {
        // Cache hit - use cached audio immediately
        console.log('[AudioTracks] Cache hit, using:', cacheResult.path);
        this.extractedAudioPath = cacheResult.path;
        this.createMasterTrack(cacheResult.path, videoDuration);
        return;
      }

      // Cache miss - start background extraction
      console.log('[AudioTracks] Cache miss, extracting in background...');
      this.startBackgroundExtraction(videoPath, videoDuration);
    } catch (error) {
      console.error('[AudioTracks] Smart extraction error:', error);
      this.showToast('warning', 'Audio extraction unavailable');
    }
  },

  /**
   * Start background audio extraction (non-blocking)
   */
  async startBackgroundExtraction(videoPath, videoDuration) {
    if (this.isExtractingAudio) {
      console.log('[AudioTracks] Extraction already in progress');
      return;
    }

    this.isExtractingAudio = true;
    this.extractionProgress = 0;
    this.showExtractionProgress(true, 0, 'Preparing audio...');

    // Register progress listener
    const cleanup = window.videoEditor.onExtractionProgress((progress) => {
      this.extractionProgress = progress.percent || 0;
      this.showExtractionProgress(true, this.extractionProgress, 'Extracting audio...');
    });

    try {
      const result = await window.videoEditor.extractAudioCached(videoPath);

      if (result.success) {
        this.extractedAudioPath = result.path;
        console.log('[AudioTracks] Extraction complete:', result.path, result.cached ? '(cached)' : '(extracted)');

        // Create Master track with extracted audio
        this.createMasterTrack(result.path, videoDuration);

        if (!result.cached) {
          this.showToast('success', 'Audio ready for editing');
        }
      } else {
        console.error('[AudioTracks] Extraction failed:', result.error);
        this.showToast('error', 'Audio extraction failed');
      }
    } catch (error) {
      console.error('[AudioTracks] Background extraction error:', error);
      this.showToast('error', 'Audio extraction failed');
    } finally {
      cleanup();
      this.isExtractingAudio = false;
      this.showExtractionProgress(false);
    }
  },

  /**
   * Create the Master track with extracted audio
   */
  createMasterTrack(audioPath, videoDuration) {
    console.log('[AudioTracks] Creating Master track');

    // Check if Master track already exists
    const existingMaster = this.audioTracks.find((t) => t.type === 'master');
    if (existingMaster) {
      existingMaster.audioPath = audioPath;
      console.log('[AudioTracks] Updated existing Master track');
      return existingMaster;
    }

    const masterTrack = {
      id: 'master',
      type: 'master',
      name: 'Master',
      syncedToVideo: false,
      locked: false,
      muted: false,
      solo: false,
      volume: 1.0,
      audioPath: audioPath,
      clips: [
        {
          id: 'master-full',
          sourceIn: 0,
          sourceOut: videoDuration || 0,
          timelineStart: 0,
          fadeIn: 0,
          fadeOut: 0,
        },
      ],
    };

    // Insert after Guide track
    const guideIndex = this.audioTracks.findIndex((t) => t.type === 'guide');
    if (guideIndex >= 0) {
      this.audioTracks.splice(guideIndex + 1, 0, masterTrack);
    } else {
      this.audioTracks.push(masterTrack);
    }

    // Render the new track
    this.renderAudioTrack(masterTrack);

    // Load audio into Web Audio for playback
    if (this.multiTrackAudio && audioPath) {
      this.multiTrackAudio.loadTrackFromFile?.('master', audioPath);
    }

    console.log('[AudioTracks] Master track created');
    return masterTrack;
  },

  /**
   * Get the Guide track
   */
  getGuideTrack() {
    return this.audioTracks.find((t) => t.type === 'guide');
  },

  /**
   * Get the Master track
   */
  getMasterTrack() {
    return this.audioTracks.find((t) => t.type === 'master');
  },

  /**
   * Toggle Guide track mute (controls video.muted)
   */
  toggleGuideTrackMute() {
    const guide = this.getGuideTrack();
    if (!guide) return;

    guide.muted = !guide.muted;

    // Guide track controls video's embedded audio
    // BUT: In multi-track mode, video is already muted - this has no effect
    if (video) {
      video.muted = guide.muted;
    }

    // Update UI
    const btn = document.querySelector('#track-guide .track-action-btn[title="Mute"]');
    if (btn) {
      btn.classList.toggle('muted', guide.muted);
    }

    this.audioMuted = guide.muted;
    this.updateMuteIcon();

    console.log('[AudioTracks] Guide muted:', guide.muted);
    this.showToast(guide.muted ? 'warning' : 'success', `Guide ${guide.muted ? 'muted' : 'unmuted'}`);
  },

  /**
   * Split the Master track clip at the playhead
   */
  splitMasterClipAtPlayhead() {
    const video = document.getElementById('videoPlayer');
    if (!video) return;

    const playheadTime = video.currentTime;
    const masterTrack = this.getMasterTrack();

    if (!masterTrack || !masterTrack.clips || masterTrack.clips.length === 0) {
      this.showToast('warning', 'No Master track to split');
      return;
    }

    // Find the clip at the playhead position
    const clipIndex = masterTrack.clips.findIndex((clip) => {
      const clipStart = clip.timelineStart ?? 0;
      const clipDuration = (clip.sourceOut ?? 0) - (clip.sourceIn ?? 0);
      const clipEnd = clipStart + clipDuration;
      return playheadTime >= clipStart && playheadTime < clipEnd;
    });

    if (clipIndex === -1) {
      this.showToast('warning', 'Playhead is not over a clip');
      return;
    }

    // Push undo state before splitting
    this.pushUndoState('Split Audio Clip');

    const clip = masterTrack.clips[clipIndex];
    const clipStart = clip.timelineStart ?? 0;
    const relativeTime = playheadTime - clipStart;

    // Create two new clips from the split
    const clip1 = {
      ...clip,
      id: `${clip.id}-a`,
      sourceOut: clip.sourceIn + relativeTime,
    };

    const clip2 = {
      ...clip,
      id: `${clip.id}-b`,
      sourceIn: clip.sourceIn + relativeTime,
      timelineStart: playheadTime,
    };

    // Replace original clip with two new clips
    masterTrack.clips.splice(clipIndex, 1, clip1, clip2);

    // Re-render the track
    this.renderTrackClips('master');

    console.log('[AudioTracks] Split clip at', this.formatTime(playheadTime));
    this.showToast('success', 'Audio clip split');
  },

  /**
   * Create a crossfade between two adjacent clips
   * @param {string} trackId - Track ID containing the clips
   * @param {string} clipAId - ID of the first clip
   * @param {string} clipBId - ID of the second clip (must be adjacent to clipA)
   * @param {number} duration - Crossfade duration in seconds (default 0.5)
   */
  createCrossfade(trackId, clipAId, clipBId, duration = 0.5) {
    const track = this.audioTracks.find((t) => t.id === trackId);
    if (!track || !track.clips) {
      this.showToast('error', 'Track not found');
      return;
    }

    const clipA = track.clips.find((c) => c.id === clipAId);
    const clipB = track.clips.find((c) => c.id === clipBId);

    if (!clipA || !clipB) {
      this.showToast('error', 'Clips not found');
      return;
    }

    // Ensure clips are adjacent (clipB follows clipA)
    const clipAEnd = (clipA.timelineStart ?? 0) + ((clipA.sourceOut ?? 0) - (clipA.sourceIn ?? 0));
    const clipBStart = clipB.timelineStart ?? 0;

    if (Math.abs(clipAEnd - clipBStart) > 0.1) {
      // Move clipB to be adjacent if not already
      clipB.timelineStart = clipAEnd;
    }

    // Push undo state
    this.pushUndoState('Create Crossfade');

    // Set fade out on clip A
    clipA.fadeOut = duration;

    // Set fade in on clip B
    clipB.fadeIn = duration;

    // Overlap clips for crossfade
    clipB.timelineStart -= duration;

    // Re-render
    this.renderTrackClips(trackId);

    console.log('[AudioTracks] Created crossfade:', duration, 's');
    this.showToast('success', `Created ${duration}s crossfade`);
  },

  /**
   * Remove crossfade from clips
   */
  removeCrossfade(trackId, clipId) {
    const track = this.audioTracks.find((t) => t.id === trackId);
    if (!track || !track.clips) return;

    const clip = track.clips.find((c) => c.id === clipId);
    if (!clip) return;

    this.pushUndoState('Remove Crossfade');

    clip.fadeIn = 0;
    clip.fadeOut = 0;

    this.renderTrackClips(trackId);
    this.showToast('success', 'Crossfade removed');
  },

  /**
   * Export video with mixed audio from all tracks
   * @param {object} options - Export options
   */
  async exportWithMixedAudio(options = {}) {
    const video = document.getElementById('videoPlayer');
    if (!video || !this.videoPath) {
      this.showToast('error', 'No video loaded');
      return;
    }

    const {
      outputPath = null,
      _format = 'mp4',
      videoCodec = 'copy',
      audioCodec = 'aac',
      audioBitrate = '192k',
    } = options;

    // Determine output path
    let finalOutputPath = outputPath;
    if (!finalOutputPath) {
      const result = await window.videoEditor.saveFile({
        title: 'Export Video with Mixed Audio',
        defaultPath: this.videoPath.replace(/\.[^.]+$/, '-mixed.mp4'),
        filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'webm'] }],
      });
      if (!result || result.canceled) return;
      finalOutputPath = result.filePath;
    }

    this.showProgress('Mixing audio...', 10);

    try {
      // Get video duration
      const duration = video.duration;

      // Check if we have tracks with audio to mix
      const tracksWithAudio = this.audioTracks.filter(
        (t) => t.type !== 'guide' && !t.muted && (t.type === 'master' || t.clips?.length > 0)
      );

      if (tracksWithAudio.length === 0 && !this.extractedAudioPath) {
        // No tracks to mix - just export with original audio
        this.showProgress('Exporting...', 30);
        await window.videoEditor.trim(this.videoPath, {
          outputPath: finalOutputPath,
          start: 0,
          end: duration,
        });
        this.hideProgress();
        this.showToast('success', 'Video exported');
        return finalOutputPath;
      }

      // Render mixed audio
      this.showProgress('Rendering audio mix...', 30);

      // Get source buffer
      const _masterTrack = this.getMasterTrack();
      let sourceBuffer = null;
      if (this.multiTrackAudio) {
        const masterData = this.multiTrackAudio.trackAudio?.get('master');
        sourceBuffer = masterData?.buffer || this.audioBuffer;
      }

      if (!sourceBuffer && this.extractedAudioPath) {
        // Load audio buffer from extracted file
        const response = await fetch(pathToFileUrl(this.extractedAudioPath));
        const arrayBuffer = await response.arrayBuffer();
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        sourceBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      }

      if (!sourceBuffer) {
        throw new Error('No audio source available for mixing');
      }

      // Render mixed audio
      const mixedBuffer = await this.multiTrackAudio.renderMixedAudio(this.audioTracks, duration, sourceBuffer);

      // Convert to WAV
      this.showProgress('Converting audio...', 50);
      const wavData = this.multiTrackAudio.audioBufferToWav(mixedBuffer);

      // Save temp WAV file
      const tempWavPath = finalOutputPath.replace(/\.[^.]+$/, '-temp-mix.wav');
      await window.videoEditor.writeFile(tempWavPath, new Uint8Array(wavData));

      // Combine video + mixed audio
      this.showProgress('Combining video and audio...', 70);
      await window.videoEditor.combineVideoAudio({
        videoInput: this.videoPath,
        audioInput: tempWavPath,
        output: finalOutputPath,
        videoCodec,
        audioCodec,
        audioBitrate,
      });

      // Clean up temp file
      await window.videoEditor.deleteFile(tempWavPath);

      this.hideProgress();
      this.showToast('success', 'Video exported with mixed audio');

      return finalOutputPath;
    } catch (error) {
      this.hideProgress();
      console.error('[Export] Mixed audio export failed:', error);
      this.showToast('error', 'Export failed: ' + error.message);
      return null;
    }
  },

  /**
   * Show/hide extraction progress indicator
   */
  showExtractionProgress(show, percent = 0, message = '') {
    let indicator = document.getElementById('extractionProgress');

    if (!indicator && show) {
      // Create indicator if it doesn't exist
      indicator = document.createElement('div');
      indicator.id = 'extractionProgress';
      indicator.className = 'extraction-progress';
      indicator.innerHTML = `
            <span class="extraction-message">Preparing audio...</span>
            <progress class="extraction-bar" value="0" max="100"></progress>
          `;

      // Insert near audio tracks
      const container = document.getElementById('audioTracksContainer');
      if (container) {
        container.parentNode.insertBefore(indicator, container);
      }
    }

    if (indicator) {
      indicator.style.display = show ? 'flex' : 'none';
      if (show) {
        const progressBar = indicator.querySelector('.extraction-bar');
        const messageEl = indicator.querySelector('.extraction-message');
        if (progressBar) progressBar.value = percent;
        if (messageEl) messageEl.textContent = message;
      }
    }
  },

  // ==================== END GUIDE + MASTER ARCHITECTURE ====================

  /**
   * Find existing track by name or create a new one
   * Used by Change Language and Change Voice features
   * @param {string} trackName - Name of the track (e.g., "Dub: Spanish" or "Voice: Rachel")
   * @param {string} trackType - Type of track ('dub' or 'voice')
   * @returns {object} The existing or newly created track
   */
  findOrCreateTrack(trackName, trackType) {
    // Search existing tracks by name
    let track = this.audioTracks?.find((t) => t.name === trackName);

    if (!track) {
      // Create ONE new track
      const trackId = `A${this.nextTrackId++}`;
      track = {
        id: trackId,
        type: trackType,
        name: trackName,
        muted: false,
        solo: false,
        volume: 1.0,
        clips: [],
      };
      this.audioTracks.push(track);
      this.renderAudioTrack(track);
      console.log('[VideoEditor] Created new track:', trackName, trackId);
    } else {
      console.log('[VideoEditor] Found existing track:', trackName, track.id);
    }

    return track;
  },

  renderAudioTrack(track) {
    const container = document.getElementById('audioTracksContainer');
    const addTrackRow = document.getElementById('addTrackRow');

    if (!container) {
      console.error('[AudioTrack] Container not found!');
      return;
    }

    // GUARD: Check if track element already exists - don't render duplicates
    const existingEl = document.getElementById(`track-${track.id}`);
    if (existingEl) {
      console.log('[AudioTrack] Track already rendered, skipping:', track.id);
      return;
    }

    const trackEl = document.createElement('div');
    trackEl.className = 'timeline-row audio audio-track';
    trackEl.id = `track-${track.id}`;
    trackEl.dataset.trackId = track.id;

    // Determine track badge and styling based on type
    const isGuide = track.type === 'guide';
    const isMaster = track.type === 'master';
    const isOriginal = track.type === 'original';
    const isLocked = track.locked;

    // Badge class for styling
    let badgeClass = '';
    if (isGuide) badgeClass = 'guide';
    else if (isMaster) badgeClass = 'master';
    else if (isOriginal) badgeClass = 'audio';

    // Type badge for non-standard tracks
    const showTypeBadge = !isGuide && !isMaster && !isOriginal;
    const typeBadgeClass = showTypeBadge ? `track-type-badge ${track.type}` : '';

    // Track icon
    const trackIcon = isGuide ? '🔗' : isMaster ? '🎚️' : '';

    // Clip count (Guide has no clips)
    const clipCount = track.clips?.length || 0;
    const clipCountText = isGuide ? 'Synced to Video' : `${clipCount} Clips`;

    // Controls based on track type
    const showSolo = !isGuide; // Guide track doesn't solo
    const showDelete = !isGuide && !isMaster && !isOriginal; // Can't delete system tracks
    const showVolume = isMaster; // Master has volume slider

    trackEl.innerHTML = `
          <div class="track-label ${isLocked ? 'locked' : ''}">
            <div class="track-label-header">
              ${trackIcon ? `<span class="track-icon">${trackIcon}</span>` : ''}
              <span class="track-badge ${badgeClass}">${track.id}</span>
              ${showTypeBadge ? `<span class="${typeBadgeClass}">${track.type.toUpperCase()}</span>` : ''}
              <div class="track-info">
                <span class="track-name">${track.name}</span>
                <span class="track-clip-count">${clipCountText}</span>
              </div>
            </div>
            <div class="track-controls">
              <button class="track-action-btn ${track.muted ? 'muted' : ''}" 
                      onclick="app.toggleTrackMute('${track.id}')" 
                      title="Mute">M</button>
              ${
                showSolo
                  ? `
              <button class="track-action-btn ${track.solo ? 'solo' : ''}" 
                      onclick="app.toggleTrackSolo('${track.id}')" 
                      title="Solo">S</button>
              `
                  : ''
              }
              ${
                showVolume
                  ? `
              <input type="range" class="track-volume-slider" 
                     min="0" max="1" step="0.01" value="${track.volume || 1}"
                     onchange="app.setTrackVolume('${track.id}', this.value)"
                     title="Volume">
              `
                  : ''
              }
              ${
                showDelete
                  ? `
              <button class="track-action-btn" 
                      onclick="app.removeTrack('${track.id}')" 
                      title="Delete Track" style="color: var(--error);">×</button>
              `
                  : ''
              }
            </div>
          </div>
          <div class="timeline-track ${isGuide ? 'guide-track' : ''}" id="trackContent-${track.id}" 
               ${
                 !isGuide
                   ? `ondragover="app.handleTrackDragOver(event, '${track.id}')"
               ondrop="app.handleTrackDrop(event, '${track.id}')"
               ondragleave="app.handleTrackDragLeave(event)"`
                   : ''
               }
               onclick="app.seekToPosition(event)">
            ${
              isGuide
                ? `
              <div class="guide-track-indicator">
                <span>🔗 Synced to Video - Mute only</span>
              </div>
            `
                : `
              <div class="track-empty-state" id="trackEmpty-${track.id}">
                ${isMaster ? 'Master audio track - split and edit here' : 'Drop audio files here or use AI to generate'}
              </div>
            `
            }
            <div class="track-drop-indicator" id="dropIndicator-${track.id}"></div>
            <!-- Marker Range Overlays -->
            <div class="marker-range-overlay-container" id="trackOverlays-${track.id}"></div>
          </div>
        `;

    // Insert before the add track row
    container.parentNode.insertBefore(trackEl, addTrackRow);

    // Attach context menu to new track label (not for Guide)
    if (this.trackContextMenu && !isGuide) {
      const label = trackEl.querySelector('.track-label');
      if (label) {
        this.trackContextMenu.attachToLabel(label, track.id);
      }
    }

    // Update marker range overlays to include the new track
    this.renderMarkerRangeOverlays();
  },

  /**
   * Set track volume
   */
  setTrackVolume(trackId, volume) {
    const track = this.audioTracks.find((t) => t.id === trackId);
    if (!track) return;

    track.volume = parseFloat(volume);

    if (this.multiTrackAudio) {
      this.multiTrackAudio.setTrackVolume(trackId, track.volume);
    }

    console.log('[AudioTracks] Volume set:', trackId, track.volume);
  },

  /**
   * Render all audio tracks (called when tracks are reset or loaded)
   */
  renderAudioTracks() {
    const container = document.getElementById('audioTracksContainer');
    if (!container) {
      console.error('[AudioTracks] Container not found');
      return;
    }

    // Clear existing track elements (except add track row)
    const existingTracks = container.parentNode.querySelectorAll('.audio-track');
    existingTracks.forEach((el) => el.remove());

    // Render each track
    for (const track of this.audioTracks) {
      this.renderAudioTrack(track);
    }

    console.log('[AudioTracks] Rendered', this.audioTracks.length, 'tracks');
  },

  toggleTrackMute(trackId) {
    const track = this.audioTracks.find((t) => t.id === trackId);
    if (!track) return;

    // Handle Guide track specially - controls video's embedded audio
    if (track.type === 'guide') {
      this.toggleGuideTrackMute();
      return;
    }

    track.muted = !track.muted;
    console.log('[AudioTracks] Track mute toggled:', trackId, track.type, '->', track.muted);

    // Update button UI
    const btn =
      document.querySelector(`#track-${trackId} .track-action-btn[title="Mute"]`) ||
      document.getElementById('audioMuteBtn');
    if (btn) {
      btn.classList.toggle('muted', track.muted);
    }

    // Update multi-track audio manager (handles actual audio for Master and other tracks)
    if (this.multiTrackAudio && track.type !== 'guide') {
      this.multiTrackAudio.setTrackMute(trackId, track.muted);
    }

    // Update audioMuted state for the original track (legacy)
    if (track.type === 'original') {
      this.audioMuted = track.muted;
      this.updateMuteIcon();

      // Only directly mute video if multi-track is NOT active
      const multiTrackActive = this.multiTrackAudio?.isActive();
      if (!multiTrackActive) {
        const video = document.getElementById('videoPlayer');
        video.muted = track.muted;
      }
    }

    this.showToast(track.muted ? 'warning' : 'success', `${track.name} ${track.muted ? 'muted' : 'unmuted'}`);
  },

  toggleTrackSolo(trackId) {
    const track = this.audioTracks.find((t) => t.id === trackId);
    if (!track) return;

    track.solo = !track.solo;

    // Update button UI
    const btn = document.querySelector(`#track-${trackId} .track-action-btn[title="Solo"]`);
    if (btn) {
      btn.classList.toggle('solo', track.solo);
    }

    // Update multi-track audio manager (handles solo logic internally)
    if (this.multiTrackAudio) {
      this.multiTrackAudio.toggleTrackSolo(trackId);
    }

    // Update UI for other tracks based on solo state
    if (track.solo) {
      this.audioTracks.forEach((t) => {
        if (t.id !== trackId) {
          const muteBtn = document.querySelector(`#track-${t.id} .track-action-btn[title="Mute"]`);
          if (muteBtn) muteBtn.classList.add('muted');
        }
      });
    } else {
      // If no tracks have solo, restore original mute states
      const hasSoloTracks = this.audioTracks.some((t) => t.solo);
      if (!hasSoloTracks) {
        this.audioTracks.forEach((t) => {
          const muteBtn = document.querySelector(`#track-${t.id} .track-action-btn[title="Mute"]`);
          if (muteBtn) muteBtn.classList.toggle('muted', t.muted);
        });
      }
    }

    // Update video mute state based on original track's effective state
    const originalTrack = this.audioTracks.find((t) => t.type === 'original');
    if (originalTrack) {
      const video = document.getElementById('videoPlayer');
      // Mute video if original track is muted OR if there are solo tracks and original isn't one of them
      const hasSoloTracks = this.audioTracks.some((t) => t.solo);
      const shouldMute = originalTrack.muted || (hasSoloTracks && !originalTrack.solo);
      video.muted = shouldMute;
      this.audioMuted = shouldMute;
      this.updateMuteIcon();
    }

    this.showToast('info', `${track.name} ${track.solo ? 'soloed' : 'unsolo'}`);
  },

  removeTrack(trackId) {
    const trackIndex = this.audioTracks.findIndex((t) => t.id === trackId);
    if (trackIndex === -1) return;

    const track = this.audioTracks[trackIndex];
    if (track.type === 'original') {
      this.showToast('error', 'Cannot remove original audio track');
      return;
    }

    // Remove from multi-track audio manager
    if (this.multiTrackAudio) {
      this.multiTrackAudio.removeTrack(trackId);
    }

    // Remove from DOM
    const trackEl = document.getElementById(`track-${trackId}`);
    if (trackEl) {
      trackEl.remove();
    }

    // Remove from array
    this.audioTracks.splice(trackIndex, 1);

    this.showToast('success', `Removed ${track.name} track`);
  },

  addClipToTrack(trackId, clip) {
    const track = this.audioTracks.find((t) => t.id === trackId);
    if (!track) return;

    track.clips.push(clip);
    this.renderTrackClips(trackId);
  },

  renderTrackClips(trackId) {
    const track = this.audioTracks.find((t) => t.id === trackId);
    if (!track) return;

    const container = document.getElementById(`trackContent-${trackId}`);
    const emptyState = document.getElementById(`trackEmpty-${trackId}`);

    if (!container) return;

    // Remove existing clips (but keep empty state and drop indicator)
    container.querySelectorAll('.audio-clip').forEach((el) => el.remove());

    if (track.clips.length === 0) {
      if (emptyState) emptyState.style.display = 'flex';
      return;
    }

    if (emptyState) emptyState.style.display = 'none';

    // Render clips
    const duration = this.videoInfo?.duration || 100;

    track.clips.forEach((clip, index) => {
      const clipEl = document.createElement('div');
      clipEl.className = 'audio-clip';
      clipEl.dataset.clipIndex = index;
      clipEl.style.left = `${(clip.startTime / duration) * 100}%`;
      clipEl.style.width = `${((clip.endTime - clip.startTime) / duration) * 100}%`;
      clipEl.style.background = this.getTrackColor(track.type);

      clipEl.innerHTML = `
            <div class="audio-clip-name">${clip.name || 'Clip'}</div>
          `;

      container.appendChild(clipEl);
    });

    // Update clip count
    const countEl = document.querySelector(`#track-${trackId} .track-clip-count`);
    if (countEl) {
      countEl.textContent = `${track.clips.length} Clip${track.clips.length !== 1 ? 's' : ''}`;
    }
  },

  getTrackColor(type) {
    const colors = {
      original: 'var(--accent-tertiary)',
      voice: '#8b5cf6',
      music: '#22c55e',
      sfx: '#f97316',
      ambience: '#06b6d4',
    };
    return colors[type] || 'var(--accent-secondary)';
  },

  handleTrackDragOver(event, trackId) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';

    const track = document.getElementById(`trackContent-${trackId}`);
    if (track) {
      track.classList.add('drag-over');

      // Position drop indicator
      const rect = track.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const indicator = document.getElementById(`dropIndicator-${trackId}`);
      if (indicator) {
        indicator.style.left = `${x}px`;
      }
    }
  },

  handleTrackDragLeave(event) {
    const track = event.currentTarget;
    if (track) {
      track.classList.remove('drag-over');
    }
  },

  handleTrackDrop(event, trackId) {
    event.preventDefault();

    const track = document.getElementById(`trackContent-${trackId}`);
    if (track) {
      track.classList.remove('drag-over');
    }

    // Handle dropped files
    const files = event.dataTransfer.files;
    if (files.length > 0) {
      for (const file of files) {
        if (file.type.startsWith('audio/')) {
          // Calculate start time based on drop position
          const rect = track.getBoundingClientRect();
          const x = event.clientX - rect.left;
          const percent = x / rect.width;
          const startTime = percent * (this.videoInfo?.duration || 0);

          this.addClipToTrack(trackId, {
            name: file.name,
            path: file.path,
            startTime: startTime,
            endTime: startTime + 10, // Default 10 second duration
            type: 'import',
          });

          this.showToast('success', `Added ${file.name} to track`);
        }
      }
    }
  },
  // ==================== END MULTI-TRACK SYSTEM ====================

  // ==================== TRANSLATION PANEL ====================
  translationSegments: [], // { id, start, end, status: 'empty'|'marked'|'working'|'approved', sourceText, translation, audioPath }
  currentSegmentIndex: -1,

  translationState: {
    isOpen: false,
    sourceText: '',
    translatedText: '',
    evaluation: null,
    iterations: [],
    currentIteration: 0,
    maxIterations: 5,
    segmentStart: 0,
    segmentEnd: 0,
    audioPath: null,
  },

  markTranslationSegment(start, end) {
    const segment = {
      id: `seg-${this.translationSegments.length + 1}`,
      start: start,
      end: end,
      status: 'marked',
      sourceText: '',
      translation: null,
      audioPath: null,
    };

    this.translationSegments.push(segment);
    this.renderTranslationSegments();
    this.currentSegmentIndex = this.translationSegments.length - 1;

    return segment;
  },

  renderTranslationSegments() {
    // Add visual overlay on timeline showing segments
    let container = document.getElementById('translationSegmentsLayer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'translationSegmentsLayer';
      container.className = 'translation-segments-layer';

      const timelineTrack = document.getElementById('timelineTrack');
      if (timelineTrack) {
        timelineTrack.appendChild(container);
      }
    }

    const duration = this.videoInfo?.duration || 0;
    if (duration === 0) return;

    container.innerHTML = '';

    this.translationSegments.forEach((segment, index) => {
      const segEl = document.createElement('div');
      segEl.className = `translation-segment ${segment.status}`;
      segEl.style.left = `${(segment.start / duration) * 100}%`;
      segEl.style.width = `${((segment.end - segment.start) / duration) * 100}%`;

      let label = '';
      if (segment.status === 'approved') label = '✓';
      else if (segment.status === 'working') label = '...';
      else if (segment.status === 'marked') label = (index + 1).toString();

      segEl.innerHTML = `<span class="translation-segment-label">${label}</span>`;
      container.appendChild(segEl);
    });
  },

  navigateToSegment(direction) {
    if (this.translationSegments.length === 0) return;

    if (direction === 'next') {
      this.currentSegmentIndex = Math.min(this.currentSegmentIndex + 1, this.translationSegments.length - 1);
    } else if (direction === 'prev') {
      this.currentSegmentIndex = Math.max(this.currentSegmentIndex - 1, 0);
    }

    const segment = this.translationSegments[this.currentSegmentIndex];
    if (segment) {
      // Seek to segment
      const video = document.getElementById('videoPlayer');
      if (video) {
        video.currentTime = segment.start;
      }

      // Open translation panel for this segment
      this.openTranslationPanel(segment.sourceText, segment.start, segment.end);
    }
  },

  openTranslationPanel(sourceText = '', startTime = 0, endTime = 0) {
    this.translationState.sourceText = sourceText;
    this.translationState.segmentStart = startTime;
    this.translationState.segmentEnd = endTime;
    this.translationState.iterations = [];
    this.translationState.currentIteration = 0;
    this.translationState.translatedText = '';
    this.translationState.evaluation = null;
    this.translationState.audioPath = null;

    // Update UI
    document.getElementById('translationSourceText').textContent =
      sourceText || 'Select a region on the timeline to translate';
    document.getElementById('translationOutput').textContent = 'Click "Translate" to generate';
    document.getElementById('translationIteration').textContent = 'Iteration 0/5';
    document.getElementById('qualitySection').style.display = 'none';
    document.getElementById('audioSection').style.display = 'none';
    document.getElementById('applySection').style.display = 'none';
    document.getElementById('improvementSuggestions').style.display = 'none';
    document.getElementById('audioPreviewSection').style.display = 'none';
    document.getElementById('retryTranslateBtn').disabled = true;

    // Show panel
    document.getElementById('translationPanel').classList.add('open');
    this.translationState.isOpen = true;
  },

  closeTranslationPanel() {
    document.getElementById('translationPanel').classList.remove('open');
    this.translationState.isOpen = false;
  },

  async startTranslation() {
    const sourceText = document.getElementById('translationSourceText').textContent.trim();
    if (!sourceText || sourceText === 'Select a region on the timeline to translate') {
      this.showToast('error', 'No text to translate');
      return;
    }

    const sourceLanguage = document.getElementById('sourceLanguage').value;
    const targetLanguage = document.getElementById('targetLanguage').value;
    const duration = this.translationState.segmentEnd - this.translationState.segmentStart;

    // Update segment status to working
    const segment = this.translationSegments[this.currentSegmentIndex];
    if (segment) {
      segment.status = 'working';
      this.renderTranslationSegments();
    }

    document.getElementById('translateBtn').disabled = true;
    document.getElementById('translateBtn').textContent = '⏳ Translating...';

    try {
      const result = await window.videoEditor.translateWithQuality(sourceText, {
        sourceLanguage,
        targetLanguage,
        sourceDuration: duration > 0 ? duration : null,
        videoContext: 'professional video',
        maxIterations: 5,
        qualityThreshold: 9.0,
      });

      if (result.success || result.translation) {
        this.translationState.translatedText = result.translation;
        this.translationState.evaluation = result.evaluation;
        this.translationState.iterations = result.iterations || [];
        this.translationState.currentIteration = result.iterations?.length || 1;

        // Update UI
        document.getElementById('translationOutput').textContent = result.translation;
        document.getElementById('translationIteration').textContent =
          `Iteration ${this.translationState.currentIteration}/${this.translationState.maxIterations}`;

        // Show quality scores
        this.updateQualityScores(result.evaluation);
        document.getElementById('qualitySection').style.display = 'block';

        // Show audio section if score is good enough
        if (result.evaluation.composite >= 8.0) {
          document.getElementById('audioSection').style.display = 'block';
        }

        // Show improvements if not passing
        if (!result.evaluation.pass && result.evaluation.improvements?.length > 0) {
          this.showImprovementSuggestions(result.evaluation.improvements);
        }

        this.showToast('success', `Translation complete! Score: ${result.evaluation.composite}/10`);
      } else {
        throw new Error(result.error || 'Translation failed');
      }
    } catch (error) {
      this.showToast('error', 'Translation failed: ' + error.message);
      console.error('[Translation] Error:', error);
    } finally {
      document.getElementById('translateBtn').disabled = false;
      document.getElementById('translateBtn').textContent = '🌐 Translate';
      document.getElementById('retryTranslateBtn').disabled = false;
    }
  },

  updateQualityScores(evaluation) {
    if (!evaluation || !evaluation.scores) return;

    const scores = evaluation.scores;

    // Update score bars and values
    const updateScore = (id, score) => {
      const value = score?.score || 0;
      const percent = (value / 10) * 100;
      const fill = document.getElementById(id);
      const valEl = document.getElementById(id + 'Val');
      if (fill) {
        fill.style.width = `${percent}%`;
        fill.style.background = value >= 9 ? 'var(--success)' : value >= 7 ? 'var(--warning)' : 'var(--error)';
      }
      if (valEl) valEl.textContent = value.toFixed(1);
    };

    updateScore('scoreAccuracy', scores.accuracy);
    updateScore('scoreFluency', scores.fluency);
    updateScore('scoreAdequacy', scores.adequacy);
    updateScore('scoreCultural', scores.cultural_fit);
    updateScore('scoreTiming', scores.timing_fit);

    // Update composite
    const composite = document.getElementById('compositeScore');
    if (composite) {
      composite.textContent = evaluation.composite.toFixed(1);
      composite.style.color =
        evaluation.composite >= 9 ? 'var(--success)' : evaluation.composite >= 7 ? 'var(--warning)' : 'var(--error)';
    }
  },

  showImprovementSuggestions(improvements) {
    const container = document.getElementById('suggestionsList');
    const section = document.getElementById('improvementSuggestions');

    if (container && improvements.length > 0) {
      container.innerHTML = improvements.map((imp, _i) => `<div style="margin-bottom: 4px;">• ${imp}</div>`).join('');
      section.style.display = 'block';
    } else {
      section.style.display = 'none';
    }
  },

  async retryTranslation() {
    if (this.translationState.currentIteration >= this.translationState.maxIterations) {
      this.showToast('warning', 'Maximum iterations reached');
      return;
    }
    await this.startTranslation();
  },

  applyImprovements() {
    // The improvements are already applied in the retry
    this.retryTranslation();
  },

  skipImprovements() {
    // Show audio section even without perfect score
    document.getElementById('audioSection').style.display = 'block';
    document.getElementById('improvementSuggestions').style.display = 'none';
    this.showToast('info', 'Proceeding with current translation');
  },

  async generateTranslationAudio() {
    const text = this.translationState.translatedText;
    if (!text) {
      this.showToast('error', 'No translation to generate audio for');
      return;
    }

    // Check if ElevenLabs API key is configured
    const keyCheck = await window.videoEditor.checkElevenLabsApiKey();
    if (!keyCheck.hasKey) {
      this.showElevenLabsKeyMissingAlert();
      return;
    }

    const voice = document.getElementById('voiceSelect').value;
    const speed = parseFloat(document.getElementById('voiceSpeed').value);

    this.showToast('info', 'Generating audio with ElevenLabs...');
    this.showProgress('Translation Audio', 'Generating AI voice... (long videos may take several minutes)');

    try {
      // Use existing ElevenLabs integration
      const result = await window.videoEditor.replaceAudioWithElevenLabs(this.videoPath, {
        text: text,
        voiceId: voice,
        startTime: this.translationState.segmentStart,
        endTime: this.translationState.segmentEnd,
        speed: speed,
        previewOnly: true, // Just generate, don't replace yet
      });

      if (result.success && result.audioPath) {
        this.translationState.audioPath = result.audioPath;

        // Show preview
        const audio = document.getElementById('translationAudioPreview');
        audio.src = pathToFileUrl(result.audioPath);
        document.getElementById('audioPreviewSection').style.display = 'block';

        // Update duration info
        const sourceDuration = this.translationState.segmentEnd - this.translationState.segmentStart;
        document.getElementById('sourceDuration').textContent = sourceDuration.toFixed(1) + 's';

        audio.onloadedmetadata = () => {
          const genDuration = audio.duration;
          document.getElementById('generatedDuration').textContent = genDuration.toFixed(1) + 's';
          const delta = genDuration - sourceDuration;
          document.getElementById('durationDelta').textContent = (delta >= 0 ? '+' : '') + delta.toFixed(1) + 's';
        };

        // Show apply button
        document.getElementById('applySection').style.display = 'block';

        this.showToast('success', 'Audio generated! Preview and apply.');
      } else {
        throw new Error(result.error || 'Audio generation failed');
      }
    } catch (error) {
      this.showToast('error', 'Audio generation failed: ' + error.message);
      console.error('[Translation] Audio error:', error);
    }
  },

  async applyTranslationToTimeline() {
    if (!this.translationState.audioPath) {
      this.showToast('error', 'No audio to apply');
      return;
    }

    const timingFix = document.querySelector('input[name="timingFix"]:checked')?.value || 'none';

    // Update segment status to approved
    const segment = this.translationSegments[this.currentSegmentIndex];
    if (segment) {
      segment.status = 'approved';
      segment.translation = this.translationState.translatedText;
      segment.audioPath = this.translationState.audioPath;
      this.renderTranslationSegments();
      this.updateSegmentNav();
    }

    // Add to the voice track
    const voiceTrack = this.audioTracks.find((t) => t.type === 'voice');
    if (!voiceTrack) {
      // Create a voice track if none exists
      this.addAudioTrack('voice');
    }

    const track = this.audioTracks.find((t) => t.type === 'voice') || this.audioTracks[1];

    if (track) {
      this.addClipToTrack(track.id, {
        name: 'Translation',
        path: this.translationState.audioPath,
        startTime: this.translationState.segmentStart,
        endTime: this.translationState.segmentEnd,
        type: 'translation',
        timingFix: timingFix,
        sourceText: this.translationState.sourceText,
        translatedText: this.translationState.translatedText,
        score: this.translationState.evaluation?.composite,
      });
    }

    this.closeTranslationPanel();
    this.showToast('success', 'Translation applied to timeline!');

    // Auto-advance to next unapproved segment if available
    const nextUnapproved = this.translationSegments.findIndex(
      (s, i) => i > this.currentSegmentIndex && s.status !== 'approved'
    );

    if (nextUnapproved !== -1) {
      setTimeout(() => {
        this.currentSegmentIndex = nextUnapproved - 1; // navigateToSegment will increment
        this.navigateToSegment('next');
      }, 500);
    }
  },
  // ==================== END TRANSLATION PANEL ====================

  // ==================== AI VIDEO REPLACEMENT PANEL ====================
  aiVideoState: {
    isOpen: false,
    segmentStart: 0,
    segmentEnd: 0,
    description: '',
    generatedPrompt: '',
    uploadedVideoPath: null,
  },

  openAIVideoPanel(startTime = 0, endTime = 0) {
    this.aiVideoState.segmentStart = startTime;
    this.aiVideoState.segmentEnd = endTime;
    this.aiVideoState.uploadedVideoPath = null;

    // Update UI with segment info
    const duration = endTime - startTime;
    document.getElementById('aiVideoRegion').textContent =
      `${this.formatTime(startTime)} - ${this.formatTime(endTime)}`;
    document.getElementById('aiVideoDuration').textContent = duration.toFixed(1) + 's';

    // Get resolution from video info
    if (this.videoInfo) {
      document.getElementById('aiVideoResolution').textContent = `${this.videoInfo.width}×${this.videoInfo.height}`;
    }

    // Reset form
    document.getElementById('aiVideoDescription').value = '';
    document.getElementById('aiVideoPrompt').textContent = 'Enter a description above, then click "Generate Prompt"';
    document.getElementById('aiVideoPreviewSection').style.display = 'none';

    // Show panel
    document.getElementById('aiVideoPanel').classList.add('open');
    this.aiVideoState.isOpen = true;
  },

  closeAIVideoPanel() {
    document.getElementById('aiVideoPanel').classList.remove('open');
    this.aiVideoState.isOpen = false;
  },

  async generateVideoPrompt() {
    const description = document.getElementById('aiVideoDescription').value.trim();
    if (!description) {
      this.showToast('error', 'Please enter a description first');
      return;
    }

    const duration = this.aiVideoState.segmentEnd - this.aiVideoState.segmentStart;
    const resolution = this.videoInfo ? `${this.videoInfo.width}x${this.videoInfo.height}` : '1920x1080';
    const aspectRatio = this.videoInfo ? (this.videoInfo.width / this.videoInfo.height).toFixed(2) : '16:9';

    // Generate optimized prompt using AI
    try {
      const _settingsPath = await window.videoEditor.getInfo(this.videoPath); // Just to check API access

      // For now, create a structured prompt based on best practices
      const optimizedPrompt = this.createOptimizedVideoPrompt(description, duration, resolution, aspectRatio);

      document.getElementById('aiVideoPrompt').textContent = optimizedPrompt;
      this.aiVideoState.generatedPrompt = optimizedPrompt;

      this.showToast('success', 'Prompt generated! Copy and use in your preferred AI service.');
    } catch (_error) {
      // If AI is not available, use template-based prompt
      const optimizedPrompt = this.createOptimizedVideoPrompt(description, duration, resolution, aspectRatio);
      document.getElementById('aiVideoPrompt').textContent = optimizedPrompt;
      this.aiVideoState.generatedPrompt = optimizedPrompt;
    }
  },

  createOptimizedVideoPrompt(description, duration, resolution, aspectRatio) {
    // Enhance the user's description with technical specs and style hints
    const durationHint =
      duration < 5 ? '3-5 seconds' : duration < 10 ? '7-10 seconds' : duration < 20 ? '15-20 seconds' : '25-30 seconds';

    const styleHints = [
      'cinematic quality',
      'professional video style',
      'smooth camera movement',
      'high production value',
    ].join(', ');

    return `${description}, ${styleHints}, ${aspectRatio === '16:9' ? 'widescreen 16:9 aspect ratio' : `${aspectRatio} aspect ratio`}, ${resolution} resolution, ${durationHint} duration, seamless loop-friendly`;
  },

  copyVideoPrompt() {
    const prompt = this.aiVideoState.generatedPrompt || document.getElementById('aiVideoPrompt').textContent;

    if (prompt && prompt !== 'Enter a description above, then click "Generate Prompt"') {
      navigator.clipboard
        .writeText(prompt)
        .then(() => {
          this.showToast('success', 'Prompt copied to clipboard!');
        })
        .catch(() => {
          this.showToast('error', 'Failed to copy prompt');
        });
    } else {
      this.showToast('error', 'No prompt to copy');
    }
  },

  openVideoService(service) {
    // Copy prompt to clipboard first
    const prompt = this.aiVideoState.generatedPrompt;
    if (prompt) {
      navigator.clipboard
        .writeText(prompt)
        .catch((err) => console.warn('[video-editor-app] clipboard.writeText:', err.message));
    }

    const services = {
      kling: 'https://klingai.com/',
      veo: 'https://deepmind.google/technologies/veo/',
      runway: 'https://runwayml.com/',
      pika: 'https://pika.art/',
      luma: 'https://lumalabs.ai/dream-machine',
      sora: 'https://openai.com/sora',
    };

    const url = services[service];
    if (url && window.electron) {
      window.electron.openExternal(url);
      this.showToast('info', `Opening ${service}... Prompt copied to clipboard!`);
    }
  },

  handleAIVideoDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    document.getElementById('aiVideoUploadZone').classList.add('drag-over');
  },

  handleAIVideoDragLeave(_event) {
    document.getElementById('aiVideoUploadZone').classList.remove('drag-over');
  },

  handleAIVideoDrop(event) {
    event.preventDefault();
    document.getElementById('aiVideoUploadZone').classList.remove('drag-over');

    const files = event.dataTransfer.files;
    if (files.length > 0) {
      const file = files[0];
      if (file.type.startsWith('video/')) {
        this.processUploadedVideo(file);
      } else {
        this.showToast('error', 'Please drop a video file');
      }
    }
  },

  handleAIVideoUpload(event) {
    const file = event.target.files[0];
    if (file) {
      this.processUploadedVideo(file);
    }
  },

  processUploadedVideo(file) {
    // Show preview
    const preview = document.getElementById('aiVideoPreview');
    const url = URL.createObjectURL(file);
    preview.src = url;

    this.aiVideoState.uploadedVideoPath = file.path || url;
    this.aiVideoState.uploadedFileName = file.name;

    document.getElementById('aiVideoPreviewSection').style.display = 'block';

    this.showToast('success', `Loaded: ${file.name}`);
  },

  cancelAIVideoUpload() {
    document.getElementById('aiVideoPreviewSection').style.display = 'none';
    document.getElementById('aiVideoPreview').src = '';
    this.aiVideoState.uploadedVideoPath = null;
  },

  async applyAIVideoToTimeline() {
    if (!this.aiVideoState.uploadedVideoPath) {
      this.showToast('error', 'No video uploaded');
      return;
    }

    if (!this.videoPath) {
      this.showToast('error', 'No source video loaded');
      return;
    }

    // Get the region to replace
    const startTime = this.trimStartTime || 0;
    const endTime = this.trimEndTime || this.videoDuration;

    if (startTime >= endTime) {
      this.showToast('error', 'Invalid region selected. Please set trim markers.');
      return;
    }

    this.showProgress('Replacing Video Segment...', `Splicing ${this.formatTime(endTime - startTime)} of content`);

    try {
      // Call the video editor backend to splice in the new video
      const result = await window.videoEditor.replaceVideoSegment(this.videoPath, {
        replacementPath: this.aiVideoState.uploadedVideoPath,
        startTime: startTime,
        endTime: endTime,
        fitMode: 'scale', // Scale replacement to match original video dimensions
      });

      this.hideProgress();

      if (result.success) {
        this.showToast('success', `Video segment replaced! New file: ${result.outputPath}`);

        // Ask user if they want to load the new video
        if (confirm('Video segment replaced successfully!\n\nWould you like to load the new video now?')) {
          // Load the new video
          await this.loadVideo(result.outputPath);
        }

        this.closeAIVideoPanel();
      } else {
        throw new Error(result.error || 'Unknown error');
      }
    } catch (error) {
      this.hideProgress();
      console.error('[AIVideo] Replace segment error:', error);
      this.showToast('error', `Failed to replace video: ${error.message}`);
    }
  },
  // ==================== END AI VIDEO REPLACEMENT PANEL ====================

  // ==================== STORY BEATS SYSTEM ====================
  // NOTE: Story Beats functionality has been extracted to video-editor-beats.js
  // The mixin is automatically merged via Object.assign() at the end of this file
  // See video-editor-beats.js for: switchBeatsTab, addNewBeat, renderBeatList,
  // selectBeat, saveBeat, deleteBeat, transcribeBeat, renderBeatGraph,
  // exportBeatsJSON, formatTimecodeWithFrames, exportFullTranscript, etc.
  // ==================== END STORY BEATS SYSTEM ====================

  // ==================== AUDIO SWEETENING PANEL ====================
  recentAudioFiles: [],

  openAudioSweeteningPanel() {
    document.getElementById('audioSweeteningPanel').classList.add('open');
    this.loadRecentAudioFiles();
  },

  closeAudioSweeteningPanel() {
    document.getElementById('audioSweeteningPanel').classList.remove('open');
  },

  async searchElevenLabsSFX(event) {
    const query = event.target.value.trim();
    if (query.length < 2) return;

    // Show search suggestion UI
    console.log('[AudioSweetening] Preparing to generate SFX for:', query);

    // Store the search query for when user clicks Generate
    this._pendingSFXQuery = query;

    // Show a "Generate" button if not already visible
    const searchContainer = event.target.closest('.sfx-search');
    if (searchContainer) {
      let generateBtn = searchContainer.querySelector('.sfx-generate-btn');
      if (!generateBtn) {
        generateBtn = document.createElement('button');
        generateBtn.className = 'sfx-generate-btn btn-primary';
        generateBtn.textContent = '🔊 Generate SFX';
        generateBtn.onclick = () => this.generateCustomSFX(query);
        searchContainer.appendChild(generateBtn);
      }
    }
  },

  // Generate custom SFX from text description
  async generateCustomSFX(description) {
    if (!description || description.trim().length < 3) {
      this.showToast('error', 'Please enter a sound effect description');
      return;
    }

    this.showToast('info', `Generating "${description}" with ElevenLabs...`);

    try {
      const result = await window.videoEditor.generateSFX({
        text: description,
        promptInfluence: 0.3,
      });

      if (result.success) {
        await this.addGeneratedSFXToTimeline(result.outputPath, description, result.duration);
        this.showToast('success', `SFX generated and added to timeline`);
      } else {
        throw new Error(result.error || 'Failed to generate SFX');
      }
    } catch (error) {
      console.error('[AudioSweetening] SFX generation error:', error);
      this.showToast('error', `SFX generation failed: ${error.message}`);
    }
  },

  async addSFXToTrack(sfxType) {
    // Map sfxType to descriptive prompts for ElevenLabs
    const sfxPrompts = {
      whoosh: 'fast whoosh sound effect, swoosh, transition',
      click: 'crisp button click sound effect, UI click',
      notification: 'soft notification chime, alert sound',
      ding: 'single bright ding bell sound effect',
      pop: 'satisfying pop sound effect',
      swoosh: 'smooth swoosh transition sound',
      beep: 'electronic beep sound effect',
      chime: 'pleasant chime sound effect',
      thud: 'deep thud impact sound effect',
      sparkle: 'magical sparkle shimmer sound effect',
    };

    const prompt = sfxPrompts[sfxType.toLowerCase()] || sfxType;

    this.showToast('info', `Generating ${sfxType} sound effect with ElevenLabs...`);

    try {
      // Call ElevenLabs API to generate the sound
      const result = await window.videoEditor.generateSFX({
        text: prompt,
        durationSeconds: sfxType === 'notification' ? 2 : 1,
        promptInfluence: 0.4,
      });

      if (result.success) {
        await this.addGeneratedSFXToTimeline(result.outputPath, sfxType, result.duration);
        this.showToast('success', `Added ${sfxType} SFX to timeline`);
      } else {
        throw new Error(result.error || 'Unknown error');
      }
    } catch (error) {
      console.error('[AudioSweetening] SFX generation error:', error);
      this.showToast('error', `Failed to generate ${sfxType}: ${error.message}`);
    }
  },

  // Helper to add generated SFX to the timeline
  async addGeneratedSFXToTimeline(audioPath, name, duration) {
    const video = document.getElementById('videoPlayer');
    const currentTime = video?.currentTime || 0;

    // Find or create SFX track
    let sfxTrack = this.audioTracks.find((t) => t.type === 'sfx');
    if (!sfxTrack) {
      this.addAudioTrack('sfx');
      sfxTrack = this.audioTracks.find((t) => t.type === 'sfx');
    }

    if (sfxTrack) {
      const clipDuration = duration || 1;
      this.addClipToTrack(sfxTrack.id, {
        name: name,
        path: audioPath,
        startTime: currentTime,
        endTime: currentTime + clipDuration,
        type: 'sfx',
        source: 'elevenlabs',
      });

      // Add to recent files
      this.recentAudioFiles = this.recentAudioFiles || [];
      this.recentAudioFiles.unshift({
        name: name,
        path: audioPath,
        type: 'sfx',
        source: 'elevenlabs',
        addedAt: Date.now(),
      });
      // Keep only last 10
      this.recentAudioFiles = this.recentAudioFiles.slice(0, 10);
    }
  },

  handleAudioDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    event.currentTarget.classList.add('drag-over');
  },

  handleAudioDragLeave(event) {
    event.currentTarget.classList.remove('drag-over');
  },

  handleAudioDrop(event) {
    event.preventDefault();
    event.currentTarget.classList.remove('drag-over');

    const files = Array.from(event.dataTransfer.files).filter((f) => f.type.startsWith('audio/'));
    if (files.length > 0) {
      this.importAudioFiles(files);
    }
  },

  handleAudioImport(event) {
    const files = Array.from(event.target.files);
    if (files.length > 0) {
      this.importAudioFiles(files);
    }
    event.target.value = ''; // Reset input
  },

  importAudioFiles(files) {
    const video = document.getElementById('videoPlayer');
    const currentTime = video?.currentTime || 0;

    files.forEach((file) => {
      // Add to recent files
      this.recentAudioFiles.unshift({
        name: file.name,
        path: file.path || URL.createObjectURL(file),
        size: file.size,
        type: file.type,
        addedAt: Date.now(),
      });

      // Keep only last 10
      this.recentAudioFiles = this.recentAudioFiles.slice(0, 10);

      // Determine track type based on filename
      let trackType = 'sfx';
      const name = file.name.toLowerCase();
      if (name.includes('music') || name.includes('song') || name.includes('track')) {
        trackType = 'music';
      } else if (name.includes('ambient') || name.includes('background')) {
        trackType = 'ambience';
      }

      // Find or create appropriate track
      let track = this.audioTracks.find((t) => t.type === trackType);
      if (!track) {
        this.addAudioTrack(trackType);
        track = this.audioTracks.find((t) => t.type === trackType);
      }

      if (track) {
        this.addClipToTrack(track.id, {
          name: file.name,
          path: file.path || URL.createObjectURL(file),
          startTime: currentTime,
          endTime: currentTime + 10, // Default duration, will be updated when loaded
          type: 'import',
        });
      }
    });

    this.loadRecentAudioFiles();
    this.showToast('success', `Imported ${files.length} audio file${files.length > 1 ? 's' : ''}`);
  },

  loadRecentAudioFiles() {
    const container = document.getElementById('recentAudioList');
    if (!container) return;

    if (this.recentAudioFiles.length === 0) {
      container.innerHTML = `
            <div style="font-size: 11px; color: var(--text-muted); padding: 8px; text-align: center;">
              No recent audio files
            </div>
          `;
      return;
    }

    container.innerHTML = this.recentAudioFiles
      .map(
        (file) => `
          <div style="display: flex; align-items: center; gap: 8px; padding: 6px; background: var(--bg-surface); border-radius: 4px; cursor: pointer;"
               onclick="app.addRecentAudioToTrack('${file.name}')">
            <span style="font-size: 14px;">🎵</span>
            <div style="flex: 1; min-width: 0;">
              <div style="font-size: 11px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                ${file.name}
              </div>
              <div style="font-size: 10px; color: var(--text-muted);">
                ${this.formatFileSize(file.size)}
              </div>
            </div>
            <button class="btn btn-ghost" style="padding: 4px; font-size: 10px;" onclick="event.stopPropagation(); app.addRecentAudioToTrack('${file.name}')">
              +
            </button>
          </div>
        `
      )
      .join('');
  },

  addRecentAudioToTrack(fileName) {
    const file = this.recentAudioFiles.find((f) => f.name === fileName);
    if (!file) return;

    this.importAudioFiles([
      {
        name: file.name,
        path: file.path,
        size: file.size,
        type: file.type,
      },
    ]);
  },

  formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  },
  // ==================== END AUDIO SWEETENING PANEL ====================

  // ==================== ELEVENLABS AI FUNCTIONS ====================
  elevenLabsVoices: [], // Cache for dynamic voice list

  /**
   * Build voice options HTML for dropdowns, including both API voices and custom voices
   * @returns {string} HTML string of option elements
   */
  _buildVoiceOptions() {
    // Start with ElevenLabs API voices or fallback defaults
    let options =
      this.elevenLabsVoices.length > 0
        ? this.elevenLabsVoices.map((v) => `<option value="${v.voice_id}">${v.name}</option>`).join('')
        : `<option value="21m00Tcm4TlvDq8ikWAM">Rachel</option>
             <option value="AZnzlk1XvdvUeBnXmlld">Domi</option>
             <option value="EXAVITQu4vr4xnSDxMaL">Bella</option>
             <option value="ErXwobaYiN019PkySvjV">Antoni</option>
             <option value="TxGEqnHWrfWFTfGW9XjX">Josh</option>`;

    // Add custom voices section if any exist
    if (this.customVoices && this.customVoices.length > 0) {
      options += '<option disabled>─────── Custom Voices ───────</option>';
      options += this.customVoices.map((v) => `<option value="${v.id}">${v.name} (Custom)</option>`).join('');
    }

    return options;
  },

  // Show Generate AI Voice Dialog (TTS)
  async showGenerateAIVoiceDialog() {
    // Load voices if not cached
    if (this.elevenLabsVoices.length === 0) {
      try {
        const result = await window.videoEditor.listVoices();
        if (result.success && result.voices) {
          this.elevenLabsVoices = result.voices;
        }
      } catch (e) {
        console.warn('[ElevenLabs] Could not fetch voices:', e.message);
      }
    }

    const video = document.getElementById('videoPlayer');
    const currentTime = video?.currentTime || 0;

    // Build voice options (includes both API voices and custom voices)
    const voiceOptions = this._buildVoiceOptions();

    const html = `
          <div class="modal-backdrop" id="aiVoiceModal">
            <div class="modal" style="width: 400px;">
              <div class="modal-header">
                <span>🎙️ Generate AI Voice</span>
                <button class="modal-close" onclick="app.closeModal('aiVoiceModal')">×</button>
              </div>
              <div class="modal-body" style="display: flex; flex-direction: column; gap: 12px;">
                <div>
                  <label style="font-size: 11px; color: var(--text-muted);">Text to speak</label>
                  <textarea id="aiVoiceText" rows="4" style="width: 100%; margin-top: 4px; padding: 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-surface); color: var(--text); resize: vertical;" placeholder="Enter the text you want to convert to speech..."></textarea>
                </div>
                <div>
                  <label style="font-size: 11px; color: var(--text-muted);">Voice</label>
                  <select id="aiVoiceSelect" style="width: 100%; margin-top: 4px; padding: 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-surface); color: var(--text);">
                    ${voiceOptions}
                  </select>
                </div>
                <div>
                  <label style="font-size: 11px; color: var(--text-muted);">Insert at: ${this.formatTime(currentTime)}</label>
                </div>
              </div>
              <div class="modal-footer">
                <button class="btn btn-secondary" onclick="app.closeModal('aiVoiceModal')">Cancel</button>
                <button class="btn btn-primary" onclick="app.generateAIVoiceFromDialog()">Generate</button>
              </div>
            </div>
          </div>
        `;

    document.body.insertAdjacentHTML('beforeend', html);
  },

  async generateAIVoiceFromDialog() {
    const text = document.getElementById('aiVoiceText')?.value?.trim();
    const voiceId = document.getElementById('aiVoiceSelect')?.value;

    if (!text) {
      this.showToast('error', 'Please enter text to generate');
      return;
    }

    this.closeModal('aiVoiceModal');
    this.showProgress('Generating Voice...', 'Calling ElevenLabs API');

    try {
      const result = await window.videoEditor.generateElevenLabsAudio({
        text,
        voice: voiceId,
        projectId: this.currentProject?.id,
      });

      this.hideProgress();

      if (result.error) {
        throw new Error(result.error);
      }

      // Add to audio track
      this.addGeneratedAudioToTrack(result.audioPath, 'AI Voice');
      this.showToast('success', 'AI Voice generated and added to timeline');
    } catch (error) {
      this.hideProgress();
      this.showToast('error', `Voice generation failed: ${error.message}`);
    }
  },

  // Show Speech-to-Speech Dialog
  async showSpeechToSpeechDialog() {
    if (!this.videoPath) {
      this.showToast('error', 'Load a video first');
      return;
    }

    // Load voices if not cached
    if (this.elevenLabsVoices.length === 0) {
      try {
        const result = await window.videoEditor.listVoices();
        if (result.success && result.voices) {
          this.elevenLabsVoices = result.voices;
        }
      } catch (e) {
        console.warn('[ElevenLabs] Could not fetch voices:', e.message);
      }
    }

    // Build voice options (includes both API voices and custom voices)
    const voiceOptions = this._buildVoiceOptions();

    const html = `
          <div class="modal-backdrop" id="stsModal">
            <div class="modal" style="width: 400px;">
              <div class="modal-header">
                <span>🔄 Transform Voice (Speech-to-Speech)</span>
                <button class="modal-close" onclick="app.closeModal('stsModal')">×</button>
              </div>
              <div class="modal-body" style="display: flex; flex-direction: column; gap: 12px;">
                <p style="font-size: 12px; color: var(--text-muted);">
                  Transform the audio from the selected region into a different voice while preserving emotion and timing.
                </p>
                <div>
                  <label style="font-size: 11px; color: var(--text-muted);">Target Voice</label>
                  <select id="stsVoiceSelect" style="width: 100%; margin-top: 4px; padding: 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-surface); color: var(--text);">
                    ${voiceOptions}
                  </select>
                </div>
                <div style="display: flex; gap: 12px;">
                  <div style="flex: 1;">
                    <label style="font-size: 11px; color: var(--text-muted);">Stability</label>
                    <input type="range" id="stsStability" min="0" max="1" step="0.1" value="0.5" style="width: 100%;">
                  </div>
                  <div style="flex: 1;">
                    <label style="font-size: 11px; color: var(--text-muted);">Similarity</label>
                    <input type="range" id="stsSimilarity" min="0" max="1" step="0.1" value="0.75" style="width: 100%;">
                  </div>
                </div>
              </div>
              <div class="modal-footer">
                <button class="btn btn-secondary" onclick="app.closeModal('stsModal')">Cancel</button>
                <button class="btn btn-primary" onclick="app.executeSpeechToSpeech()">Transform</button>
              </div>
            </div>
          </div>
        `;

    document.body.insertAdjacentHTML('beforeend', html);
  },

  async executeSpeechToSpeech() {
    const voiceId = document.getElementById('stsVoiceSelect')?.value;
    const stability = parseFloat(document.getElementById('stsStability')?.value || 0.5);
    const similarity = parseFloat(document.getElementById('stsSimilarity')?.value || 0.75);

    this.closeModal('stsModal');
    this.showProgress('Transforming Voice...', 'Extracting audio and processing');

    try {
      // First extract audio from video
      const extractResult = await window.videoEditor.extractAudio(this.videoPath, {
        startTime: this.selectedRegion.active ? this.selectedRegion.start : 0,
        endTime: this.selectedRegion.active ? this.selectedRegion.end : undefined,
      });

      if (extractResult.error) {
        throw new Error(extractResult.error);
      }

      this.showProgress('Transforming Voice...', 'Calling ElevenLabs API');

      // Call Speech-to-Speech API
      const result = await window.videoEditor.speechToSpeech({
        audioPath: extractResult.outputPath,
        voiceId,
        stability,
        similarityBoost: similarity,
        projectId: this.currentProject?.id,
      });

      this.hideProgress();

      if (!result.success) {
        throw new Error(result.error || 'Speech-to-Speech failed');
      }

      this.addGeneratedAudioToTrack(result.audioPath, 'Transformed Voice');
      this.showToast('success', 'Voice transformed and added to timeline');
    } catch (error) {
      this.hideProgress();
      this.showToast('error', `Voice transformation failed: ${error.message}`);
    }
  },

  // Isolate Vocals Action
  async isolateVocalsAction() {
    if (!this.videoPath) {
      this.showToast('error', 'Load a video first');
      return;
    }

    this.showProgress('Isolating Vocals...', 'Extracting audio');

    try {
      // First extract audio from video
      const extractResult = await window.videoEditor.extractAudio(this.videoPath, {
        startTime: this.selectedRegion.active ? this.selectedRegion.start : 0,
        endTime: this.selectedRegion.active ? this.selectedRegion.end : undefined,
      });

      if (extractResult.error) {
        throw new Error(extractResult.error);
      }

      this.showProgress('Isolating Vocals...', 'Processing with ElevenLabs');

      // Call Audio Isolation API
      const result = await window.videoEditor.isolateAudio(extractResult.outputPath, {
        projectId: this.currentProject?.id,
      });

      this.hideProgress();

      if (!result.success) {
        throw new Error(result.error || 'Audio isolation failed');
      }

      this.addGeneratedAudioToTrack(result.audioPath, 'Isolated Vocals');
      this.showToast('success', 'Vocals isolated and added to timeline');
    } catch (error) {
      this.hideProgress();
      this.showToast('error', `Vocal isolation failed: ${error.message}`);
    }
  },

  // Show Clone Voice Dialog
  showCloneVoiceDialog() {
    if (!this.videoPath) {
      this.showToast('error', 'Load a video first');
      return;
    }

    const html = `
          <div class="modal-backdrop" id="cloneVoiceModal">
            <div class="modal" style="width: 400px;">
              <div class="modal-header">
                <span>👤 Clone Voice</span>
                <button class="modal-close" onclick="app.closeModal('cloneVoiceModal')">×</button>
              </div>
              <div class="modal-body" style="display: flex; flex-direction: column; gap: 12px;">
                <p style="font-size: 12px; color: var(--text-muted);">
                  Create a custom voice from the selected audio region. Best results with 30-60 seconds of clear speech.
                </p>
                <div>
                  <label style="font-size: 11px; color: var(--text-muted);">Voice Name</label>
                  <input type="text" id="cloneVoiceName" style="width: 100%; margin-top: 4px; padding: 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-surface); color: var(--text);" placeholder="My Custom Voice">
                </div>
                <div>
                  <label style="font-size: 11px; color: var(--text-muted);">Description</label>
                  <textarea id="cloneVoiceDesc" rows="2" style="width: 100%; margin-top: 4px; padding: 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-surface); color: var(--text); resize: vertical;" placeholder="Optional description..."></textarea>
                </div>
                ${
                  this.selectedRegion.active
                    ? `
                  <div style="font-size: 11px; color: var(--text-success);">
                    ✓ Using selected region: ${this.formatTime(this.selectedRegion.start)} - ${this.formatTime(this.selectedRegion.end)}
                  </div>
                `
                    : `
                  <div style="font-size: 11px; color: var(--text-warning);">
                    ⚠ No region selected. Will use entire video audio.
                  </div>
                `
                }
              </div>
              <div class="modal-footer">
                <button class="btn btn-secondary" onclick="app.closeModal('cloneVoiceModal')">Cancel</button>
                <button class="btn btn-primary" onclick="app.executeCloneVoice()">Clone Voice</button>
              </div>
            </div>
          </div>
        `;

    document.body.insertAdjacentHTML('beforeend', html);
  },

  async executeCloneVoice() {
    const name = document.getElementById('cloneVoiceName')?.value?.trim() || `Voice_${Date.now()}`;
    const description = document.getElementById('cloneVoiceDesc')?.value?.trim() || '';

    this.closeModal('cloneVoiceModal');
    this.showProgress('Cloning Voice...', 'Extracting audio sample');

    try {
      // Extract audio from selected region or full video
      const extractResult = await window.videoEditor.extractAudio(this.videoPath, {
        startTime: this.selectedRegion.active ? this.selectedRegion.start : 0,
        endTime: this.selectedRegion.active ? this.selectedRegion.end : undefined,
      });

      if (extractResult.error) {
        throw new Error(extractResult.error);
      }

      this.showProgress('Cloning Voice...', 'Creating custom voice');

      const result = await window.videoEditor.createCustomVoice({
        name,
        description,
        audioPath: extractResult.outputPath,
        projectId: this.currentProject?.id,
      });

      this.hideProgress();

      if (result.error) {
        throw new Error(result.error);
      }

      // Refresh voice list
      this.elevenLabsVoices = [];

      this.showToast('success', `Voice "${name}" created successfully!`);
    } catch (error) {
      this.hideProgress();
      this.showToast('error', `Voice cloning failed: ${error.message}`);
    }
  },

  // Show Generate SFX Dialog
  showGenerateSFXDialog() {
    const video = document.getElementById('videoPlayer');
    const currentTime = video?.currentTime || 0;

    const html = `
          <div class="modal-backdrop" id="sfxModal">
            <div class="modal" style="width: 400px;">
              <div class="modal-header">
                <span>🔊 Generate Sound Effect</span>
                <button class="modal-close" onclick="app.closeModal('sfxModal')">×</button>
              </div>
              <div class="modal-body" style="display: flex; flex-direction: column; gap: 12px;">
                <div>
                  <label style="font-size: 11px; color: var(--text-muted);">Describe the sound effect</label>
                  <textarea id="sfxPrompt" rows="3" style="width: 100%; margin-top: 4px; padding: 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-surface); color: var(--text); resize: vertical;" placeholder="e.g., Heavy wooden door creaking open, footsteps on gravel, car engine starting..."></textarea>
                </div>
                <div>
                  <label style="font-size: 11px; color: var(--text-muted);">Duration (seconds)</label>
                  <input type="number" id="sfxDuration" value="5" min="0.5" max="22" step="0.5" style="width: 100%; margin-top: 4px; padding: 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-surface); color: var(--text);">
                </div>
                <div>
                  <label style="font-size: 11px; color: var(--text-muted);">Insert at: ${this.formatTime(currentTime)}</label>
                </div>
              </div>
              <div class="modal-footer">
                <button class="btn btn-secondary" onclick="app.closeModal('sfxModal')">Cancel</button>
                <button class="btn btn-primary" onclick="app.executeGenerateSFX()">Generate</button>
              </div>
            </div>
          </div>
        `;

    document.body.insertAdjacentHTML('beforeend', html);
  },

  async executeGenerateSFX() {
    const prompt = document.getElementById('sfxPrompt')?.value?.trim();
    const duration = parseFloat(document.getElementById('sfxDuration')?.value || 5);

    if (!prompt) {
      this.showToast('error', 'Please describe the sound effect');
      return;
    }

    this.closeModal('sfxModal');
    this.showProgress('Generating SFX...', 'Calling ElevenLabs API');

    try {
      const result = await window.videoEditor.generateSFX({
        prompt,
        durationSeconds: duration,
        promptInfluence: 0.5,
        projectId: this.currentProject?.id,
      });

      this.hideProgress();

      if (!result.success) {
        throw new Error(result.error || 'SFX generation failed');
      }

      this.addGeneratedAudioToTrack(result.audioPath, prompt.substring(0, 30));
      this.showToast('success', 'Sound effect generated and added to timeline');
    } catch (error) {
      this.hideProgress();
      this.showToast('error', `SFX generation failed: ${error.message}`);
    }
  },

  // Show Dub Region Dialog
  showDubRegionDialog() {
    if (!this.selectedRegion.active) {
      this.showToast('error', 'Select a region on the timeline first (use I and O keys)');
      return;
    }

    this.showDubDialog('region');
  },

  // Show Dub Entire Video Dialog
  showDubVideoDialog() {
    if (!this.videoPath) {
      this.showToast('error', 'Load a video first');
      return;
    }

    this.showDubDialog('video');
  },

  showDubDialog(mode) {
    const languages = [
      { code: 'es', name: 'Spanish' },
      { code: 'fr', name: 'French' },
      { code: 'de', name: 'German' },
      { code: 'it', name: 'Italian' },
      { code: 'pt', name: 'Portuguese' },
      { code: 'pl', name: 'Polish' },
      { code: 'hi', name: 'Hindi' },
      { code: 'zh', name: 'Chinese' },
      { code: 'ja', name: 'Japanese' },
      { code: 'ko', name: 'Korean' },
      { code: 'ar', name: 'Arabic' },
      { code: 'ru', name: 'Russian' },
    ];

    const languageCheckboxes = languages
      .map(
        (l) => `
          <label style="display: flex; align-items: center; gap: 6px; font-size: 12px;">
            <input type="checkbox" class="dub-language" value="${l.code}">
            ${l.name}
          </label>
        `
      )
      .join('');

    const html = `
          <div class="modal-backdrop" id="dubModal">
            <div class="modal" style="width: 450px;">
              <div class="modal-header">
                <span>🌐 ${mode === 'video' ? 'Dub Entire Video' : 'Dub Selected Region'}</span>
                <button class="modal-close" onclick="app.closeModal('dubModal')">×</button>
              </div>
              <div class="modal-body" style="display: flex; flex-direction: column; gap: 12px;">
                <p style="font-size: 12px; color: var(--text-muted);">
                  Automatically translate and dub ${mode === 'video' ? 'the entire video' : 'the selected region'} into other languages.
                </p>
                <div>
                  <label style="font-size: 11px; color: var(--text-muted);">Source Language</label>
                  <select id="dubSourceLang" style="width: 100%; margin-top: 4px; padding: 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-surface); color: var(--text);">
                    <option value="en">English</option>
                    <option value="auto">Auto-detect</option>
                  </select>
                </div>
                <div>
                  <label style="font-size: 11px; color: var(--text-muted); margin-bottom: 8px; display: block;">Target Languages</label>
                  <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;">
                    ${languageCheckboxes}
                  </div>
                </div>
                <div>
                  <label style="font-size: 11px; color: var(--text-muted);">Number of Speakers</label>
                  <select id="dubSpeakers" style="width: 100%; margin-top: 4px; padding: 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-surface); color: var(--text);">
                    <option value="1">1 Speaker</option>
                    <option value="2">2 Speakers</option>
                    <option value="3">3+ Speakers</option>
                  </select>
                </div>
              </div>
              <div class="modal-footer">
                <button class="btn btn-secondary" onclick="app.closeModal('dubModal')">Cancel</button>
                <button class="btn btn-primary" onclick="app.executeDubbing('${mode}')">Start Dubbing</button>
              </div>
            </div>
          </div>
        `;

    document.body.insertAdjacentHTML('beforeend', html);
  },

  async executeDubbing(_mode) {
    const selectedLanguages = Array.from(document.querySelectorAll('.dub-language:checked')).map((el) => el.value);
    const sourceLanguage = document.getElementById('dubSourceLang')?.value || 'en';
    const numSpeakers = parseInt(document.getElementById('dubSpeakers')?.value || 1);

    if (selectedLanguages.length === 0) {
      this.showToast('error', 'Select at least one target language');
      return;
    }

    this.closeModal('dubModal');
    this.showProgress('Starting Dubbing...', 'Creating dubbing project');

    try {
      const result = await window.videoEditor.createDubbing({
        videoPath: this.videoPath,
        targetLanguages: selectedLanguages,
        sourceLanguage,
        numSpeakers,
        projectName: `Dub_${Date.now()}`,
        projectId: this.currentProject?.id,
      });

      if (!result.success) {
        throw new Error(result.error || 'Failed to create dubbing project');
      }

      // Store dubbing ID for status polling
      this.currentDubbingId = result.dubbing_id;

      this.showProgress('Dubbing in Progress...', 'This may take several minutes');

      // Poll for status
      await this.pollDubbingStatus(result.dubbing_id, selectedLanguages);
    } catch (error) {
      this.hideProgress();
      this.showToast('error', `Dubbing failed: ${error.message}`);
    }
  },

  async pollDubbingStatus(dubbingId, targetLanguages) {
    const maxAttempts = 120; // 10 minutes at 5s intervals
    let attempts = 0;

    const poll = async () => {
      try {
        const status = await window.videoEditor.getDubbingStatus(dubbingId);

        if (!status.success) {
          throw new Error(status.error || 'Failed to get status');
        }

        if (status.status === 'dubbed') {
          // Download all dubbed audio files
          this.showProgress('Downloading Dubbed Audio...', 'Fetching audio files');

          for (const lang of targetLanguages) {
            const audioResult = await window.videoEditor.downloadDubbedAudio(dubbingId, lang);
            if (audioResult.success) {
              this.addGeneratedAudioToTrack(audioResult.audioPath, `Dubbed (${lang.toUpperCase()})`);
            }
          }

          this.hideProgress();
          this.showToast('success', 'Dubbing complete! Audio tracks added to timeline');
          return;
        } else if (status.status === 'failed') {
          throw new Error('Dubbing failed on the server');
        }

        attempts++;
        if (attempts >= maxAttempts) {
          throw new Error('Dubbing timed out. Check ElevenLabs dashboard for status.');
        }

        // Update progress
        this.showProgress(
          'Dubbing in Progress...',
          `Status: ${status.status} (${Math.round((attempts / maxAttempts) * 100)}%)`
        );

        // Poll again in 5 seconds
        setTimeout(poll, 5000);
      } catch (error) {
        this.hideProgress();
        this.showToast('error', `Dubbing error: ${error.message}`);
      }
    };

    poll();
  },

  // Show ElevenLabs Usage Stats
  async showElevenLabsUsageStats() {
    this.showProgress('Loading...', 'Fetching ElevenLabs usage data');

    try {
      const [subscriptionResult, usageResult] = await Promise.all([
        window.videoEditor.getSubscription(),
        window.videoEditor.getUsageStats(),
      ]);

      this.hideProgress();

      const subscription = subscriptionResult.success ? subscriptionResult.subscription : null;
      const usage = usageResult.success ? usageResult.stats : null;

      const html = `
            <div class="modal-backdrop" id="usageModal">
              <div class="modal" style="width: 450px;">
                <div class="modal-header">
                  <span>📊 ElevenLabs Usage</span>
                  <button class="modal-close" onclick="app.closeModal('usageModal')">×</button>
                </div>
                <div class="modal-body" style="display: flex; flex-direction: column; gap: 16px;">
                  ${
                    subscription
                      ? `
                    <div style="padding: 12px; background: var(--bg-surface); border-radius: 8px;">
                      <div style="font-size: 14px; font-weight: 600; margin-bottom: 8px;">Subscription</div>
                      <div style="font-size: 12px; color: var(--text-muted);">Plan: ${subscription.tier || 'Unknown'}</div>
                      <div style="font-size: 12px; color: var(--text-muted);">Characters Used: ${subscription.character_count?.toLocaleString() || 0} / ${subscription.character_limit?.toLocaleString() || '∞'}</div>
                      ${
                        subscription.character_limit
                          ? `
                        <div style="margin-top: 8px; height: 8px; background: var(--bg); border-radius: 4px; overflow: hidden;">
                          <div style="height: 100%; width: ${Math.min(100, (subscription.character_count / subscription.character_limit) * 100)}%; background: var(--accent);"></div>
                        </div>
                        <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">
                          ${Math.round((subscription.character_count / subscription.character_limit) * 100)}% used
                        </div>
                      `
                          : ''
                      }
                    </div>
                  `
                      : `
                    <div style="padding: 12px; background: var(--bg-surface); border-radius: 8px; color: var(--text-warning);">
                      Could not fetch subscription info
                    </div>
                  `
                  }
                  ${
                    usage
                      ? `
                    <div style="padding: 12px; background: var(--bg-surface); border-radius: 8px;">
                      <div style="font-size: 14px; font-weight: 600; margin-bottom: 8px;">Recent Usage</div>
                      <div style="font-size: 12px; color: var(--text-muted);">
                        Total characters this period: ${usage.total_characters?.toLocaleString() || 0}
                      </div>
                    </div>
                  `
                      : ''
                  }
                </div>
                <div class="modal-footer">
                  <button class="btn btn-primary" onclick="app.closeModal('usageModal')">Close</button>
                </div>
              </div>
            </div>
          `;

      document.body.insertAdjacentHTML('beforeend', html);
    } catch (error) {
      this.hideProgress();
      this.showToast('error', `Failed to load usage stats: ${error.message}`);
    }
  },

  // Helper: Add generated audio to timeline track
  addGeneratedAudioToTrack(audioPath, name) {
    const video = document.getElementById('videoPlayer');
    const currentTime = video?.currentTime || 0;

    // Find or create appropriate track
    let track = this.audioTracks?.find((t) => t.type === 'sfx' || t.type === 'voiceover');
    if (!track && typeof this.addAudioTrack === 'function') {
      this.addAudioTrack('sfx');
      track = this.audioTracks?.find((t) => t.type === 'sfx');
    }

    if (track && typeof this.addClipToTrack === 'function') {
      this.addClipToTrack(track.id, {
        name: name,
        path: audioPath,
        startTime: currentTime,
        endTime: currentTime + 5, // Will be updated when loaded
        type: 'generated',
      });

      if (typeof this.renderAudioTracks === 'function') {
        this.renderAudioTracks();
      }
    }
  },

  // Helper: Close modal
  closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.remove();
    }
  },
  // ==================== END ELEVENLABS AI FUNCTIONS ====================

  // ==================== TIMELINE ACTION BAR ====================
  selectedRegion: { start: 0, end: 0, active: false },

  showTimelineActions() {
    // Show action buttons when a region is selected
    const actionBar = document.getElementById('timelineActionBar');
    if (actionBar && this.selectedRegion.active) {
      actionBar.style.display = 'flex';

      // Position it near the selected region
      const duration = this.selectedRegion.end - this.selectedRegion.start;
      const durationText = document.getElementById('regionDurationText');
      if (durationText) {
        durationText.textContent = `${this.formatTime(this.selectedRegion.start)} - ${this.formatTime(this.selectedRegion.end)} (${duration.toFixed(1)}s)`;
      }
    } else if (actionBar) {
      actionBar.style.display = 'none';
    }
  },

  updateSelectedRegion() {
    // Update selected region based on trim markers
    if (this.trimStart !== this.trimEnd) {
      this.selectedRegion = {
        start: this.trimStart,
        end: this.trimEnd,
        active: true,
      };
      this.showTimelineActions();
    } else {
      this.selectedRegion.active = false;
      this.showTimelineActions();
    }
  },

  openTranslationForRegion() {
    if (!this.selectedRegion.active) {
      this.showToast('error', 'Select a region on the timeline first');
      return;
    }

    // Check if segment already exists for this region (avoid duplicates)
    let segment = this.translationSegments.find(
      (s) => Math.abs(s.start - this.selectedRegion.start) < 0.1 && Math.abs(s.end - this.selectedRegion.end) < 0.1
    );

    if (segment) {
      // Use existing segment
      this.currentSegmentIndex = this.translationSegments.indexOf(segment);
    } else {
      // Mark this as a new translation segment
      segment = this.markTranslationSegment(this.selectedRegion.start, this.selectedRegion.end);
    }

    // Get transcription for this region if available
    let sourceText = segment.sourceText || '';
    if (!sourceText && this.transcriptSegments) {
      const segments = this.transcriptSegments.filter(
        (seg) => seg.start >= this.selectedRegion.start && seg.end <= this.selectedRegion.end
      );
      sourceText = segments.map((s) => s.text).join(' ');
      segment.sourceText = sourceText;
    }

    // Update segment nav
    this.updateSegmentNav();

    this.openTranslationPanel(sourceText, this.selectedRegion.start, this.selectedRegion.end);
  },

  updateSegmentNav() {
    const navEl = document.getElementById('segmentNav');
    if (!navEl) return;

    if (this.translationSegments.length > 0) {
      navEl.style.display = 'flex';

      const approved = this.translationSegments.filter((s) => s.status === 'approved').length;
      document.getElementById('segmentNavText').textContent =
        `Segment ${this.currentSegmentIndex + 1} of ${this.translationSegments.length}`;
      document.getElementById('approvedSegmentsCount').textContent = approved;
    } else {
      navEl.style.display = 'none';
    }
  },

  openAIVideoForRegion() {
    if (!this.selectedRegion.active) {
      this.showToast('error', 'Select a region on the timeline first');
      return;
    }

    this.openAIVideoPanel(this.selectedRegion.start, this.selectedRegion.end);
  },
  // ==================== END TIMELINE ACTION BAR ====================

  // ==================== PROJECT MANAGEMENT ====================
  currentProject: null,
  autoSaveInterval: null,

  // Get current edit state for saving to version
  getCurrentEditState() {
    // Serialize audioTracks to ensure they're JSON-safe (no DOM refs, functions, etc.)
    const serializedTracks = (this.audioTracks || []).map((track) => ({
      id: track.id,
      type: track.type || 'original',
      name: track.name || `Track ${track.id}`,
      muted: track.muted || false,
      solo: track.solo || false,
      volume: typeof track.volume === 'number' ? track.volume : 1.0,
      clips: (track.clips || []).map((clip) => ({
        id: clip.id,
        type: clip.type,
        name: clip.name,
        path: clip.path,
        startTime: clip.startTime,
        endTime: clip.endTime,
        duration: clip.duration,
        text: clip.text,
        voice: clip.voice,
        voiceId: clip.voiceId,
        voiceName: clip.voiceName,
        language: clip.language,
        speakerId: clip.speakerId,
        sourceTrackId: clip.sourceTrackId,
        isVisualOnly: clip.isVisualOnly,
        createdAt: clip.createdAt,
      })),
      color: track.color,
      speakerId: track.speakerId,
      sourceTrackId: track.sourceTrackId,
      deadSpaceRegions: track.deadSpaceRegions,
      roomTonePath: track.roomTonePath,
      roomToneDuration: track.roomToneDuration,
    }));

    console.log('[getCurrentEditState] Serializing', serializedTracks.length, 'tracks, nextTrackId:', this.nextTrackId);

    return {
      markers: this.markers || [],
      audioTracks: serializedTracks,
      nextTrackId: this.nextTrackId || 2, // CRITICAL: Save nextTrackId to prevent duplicate IDs
      beats: this.beats || [],
      playlist: this.playlist || [],
      timeline: {
        zoom: this.timelineZoom,
        scrollOffset: this.timelineScrollOffset,
      },
      transcriptSegments: this.transcriptSegments || [],
      transcriptSource: this.transcriptSource || null, // Save transcript source to avoid regeneration
      fades: this.fades || { fadeIn: 0, fadeOut: 0 },
      trimStart: this.trimStart || 0,
      trimEnd: this.trimEnd || 0,
      planning: this.planningPanel?.getPlanningData() || this.planning || null, // Save planning data
      customVoices: this.customVoices || [], // Save custom ElevenLabs voices
    };
  },

  // Apply version state to editor
  applyVersionState(versionData) {
    if (!versionData) return;

    // Apply markers
    if (versionData.markers) {
      this.markers = versionData.markers;
      this.nextMarkerId = Math.max(...this.markers.map((m) => m.id), 0) + 1;
      this.renderMarkers();
      this.updateMarkersPanel();
    }

    // Apply audio tracks - ALWAYS ensure A1 original track exists
    const defaultA1 = {
      id: 'A1',
      type: 'original',
      name: 'Original',
      muted: false,
      solo: false,
      volume: 1.0,
      clips: [],
    };

    // CRITICAL: Clear existing rendered track elements before restoring
    const container = document.getElementById('audioTracksContainer');
    if (container) {
      const existingTrackRows = container.querySelectorAll('.audio-track-row:not(#addTrackRow)');
      existingTrackRows.forEach((el) => el.remove());
      console.log('[applyVersionState] Cleared', existingTrackRows.length, 'existing track elements');
    }

    if (versionData.audioTracks && versionData.audioTracks.length > 0) {
      // Version has saved audio tracks
      const hasA1 = versionData.audioTracks.some((t) => t.id === 'A1');
      if (hasA1) {
        this.audioTracks = versionData.audioTracks;
      } else {
        // Prepend the default A1 original track if missing from saved data
        this.audioTracks = [defaultA1, ...versionData.audioTracks];
      }

      // CRITICAL: Restore nextTrackId to prevent duplicate IDs
      if (typeof versionData.nextTrackId === 'number' && versionData.nextTrackId > 1) {
        this.nextTrackId = versionData.nextTrackId;
      } else {
        // Calculate nextTrackId from existing track IDs as fallback
        const maxId = Math.max(
          ...this.audioTracks.map((t) => {
            const num = parseInt(t.id.replace('A', ''), 10);
            return isNaN(num) ? 0 : num;
          })
        );
        this.nextTrackId = Math.max(this.nextTrackId || 2, maxId + 1);
      }
      console.log('[applyVersionState] Restored nextTrackId to:', this.nextTrackId);

      // Render non-original tracks
      this.audioTracks.forEach((track) => {
        if (track.type !== 'original') {
          this.renderAudioTrack(track);
        }
      });

      // Render clips after a delay to ensure DOM is ready and original waveform exists
      setTimeout(() => {
        this.audioTracks.forEach((track) => {
          if (track.clips && track.clips.length > 0) {
            // For speaker tracks, use the speaker clip renderer
            if (
              track.type === 'speaker' &&
              this.adrManager &&
              typeof this.adrManager._renderSpeakerClips === 'function'
            ) {
              this.adrManager._renderSpeakerClips(track.id, track.clips, track.color || '#4a9eff');
            } else {
              // Handle other clip types
              track.clips.forEach((clip) => {
                if (clip.type === 'visual-reference' || clip.isVisualOnly) {
                  if (this.adrManager && typeof this.adrManager._renderVisualClip === 'function') {
                    this.adrManager._renderVisualClip(track.id, clip);
                  }
                } else if (clip.type === 'adr' || clip.type === 'elevenlabs') {
                  // ADR clips - render using ADR clip renderer
                  if (this.adrManager && typeof this.adrManager._renderADRClip === 'function') {
                    this.adrManager._renderADRClip(track.id, clip);
                  }
                } else if (clip.type === 'room-tone') {
                  // Fill/room tone clips
                  if (this.adrManager && typeof this.adrManager._renderFillClip === 'function') {
                    this.adrManager._renderFillClip(track.id, clip);
                  }
                } else if (this.renderTrackClips) {
                  // Fallback: use general track clip renderer
                  this.renderTrackClips(track.id);
                }
              });
            }
          }
        });
        console.log('[applyVersionState] Rendered clips for all tracks');
      }, 500);
    } else {
      // No saved audio tracks or empty array - ensure A1 exists
      if (!this.audioTracks || this.audioTracks.length === 0) {
        this.audioTracks = [defaultA1];
      } else if (!this.audioTracks.some((t) => t.id === 'A1')) {
        this.audioTracks = [defaultA1, ...this.audioTracks];
      }
      // Ensure nextTrackId is at least 2
      if (!this.nextTrackId || this.nextTrackId < 2) {
        this.nextTrackId = 2;
      }
    }

    console.log(
      '[ProjectManager] Audio tracks after load:',
      this.audioTracks.map((t) => t.id),
      'nextTrackId:',
      this.nextTrackId
    );

    // Apply beats
    if (versionData.beats) {
      this.beats = versionData.beats;
      if (typeof this.renderBeatList === 'function') {
        this.renderBeatList();
      }
    }

    // Apply playlist
    if (versionData.playlist) {
      this.playlist = versionData.playlist;
      this.renderPlaylist();
    }

    // Apply timeline settings
    if (versionData.timeline) {
      this.timelineZoom = versionData.timeline.zoom || 1;
      this.timelineScrollOffset = versionData.timeline.scrollOffset || 0;
    }

    // Apply transcript segments AND source (important to prevent regeneration)
    if (versionData.transcriptSegments && versionData.transcriptSegments.length > 0) {
      this.transcriptSegments = versionData.transcriptSegments;
      // Also restore the transcript source to prevent preloader from prompting regeneration
      this.transcriptSource = versionData.transcriptSource || 'elevenlabs-scribe';
      console.log(
        '[ProjectManager] Loaded',
        this.transcriptSegments.length,
        'transcript segments from version (source:',
        this.transcriptSource + ')'
      );

      // Show and initialize teleprompter with restored transcript
      this.teleprompterVisible = true;
      const teleprompterContainer = document.getElementById('teleprompterContainer');
      const toggleBtn = document.getElementById('teleprompterToggleBtn');
      teleprompterContainer?.classList.remove('hidden');
      toggleBtn?.classList.add('active');
      // Defer initTeleprompter to after video loads (needs video duration)
      setTimeout(() => {
        if (this.transcriptSegments && this.transcriptSegments.length > 0) {
          this.initTeleprompter();
        }
      }, 500);
    } else {
      console.log('[ProjectManager] No transcript segments in version data');
    }

    // Apply fades
    if (versionData.fades) {
      this.fades = versionData.fades;
    }

    // Apply trim points
    if (versionData.trimStart !== undefined) {
      this.trimStart = versionData.trimStart;
      document.getElementById('trimStart').value = this.formatTime(this.trimStart);
    }
    if (versionData.trimEnd !== undefined) {
      this.trimEnd = versionData.trimEnd;
      document.getElementById('trimEnd').value = this.formatTime(this.trimEnd);
    }

    // Apply planning data
    if (versionData.planning) {
      this.planning = versionData.planning;
      if (this.planningPanel) {
        this.planningPanel.setPlanningData(versionData.planning);
      }
      console.log('[ProjectManager] Loaded planning data:', {
        characters: versionData.planning.characters?.length || 0,
        scenes: versionData.planning.scenes?.length || 0,
      });
    }

    // Apply custom voices
    if (versionData.customVoices && versionData.customVoices.length > 0) {
      this.customVoices = versionData.customVoices;
      console.log('[ProjectManager] Loaded', this.customVoices.length, 'custom voices');
    }

    console.log('[ProjectManager] Applied version state');
  },

  // Save current state to version via IPC
  async saveCurrentVersion() {
    if (!this.currentVersionId) return;

    try {
      const state = this.getCurrentEditState();
      const result = await window.projectAPI.updateVersion(this.currentVersionId, state);
      console.log('[ProjectManager] Version saved:', this.currentVersionId);
      return result;
    } catch (error) {
      console.error('[ProjectManager] Error saving version:', error);
    }
  },

  // Load projects for space
  async loadProjectsForSpace(spaceId) {
    console.log('[ProjectManager] Loading projects for space:', spaceId);
    try {
      const projects = await window.projectAPI.getProjectsBySpace(spaceId);
      console.log('[ProjectManager] Found', projects?.length || 0, 'projects');
      this.renderProjectList(projects);

      // Show projects section
      document.getElementById('spaceProjectsSection').style.display = 'block';
      document.getElementById('projectDetailsSection').style.display = 'none';
    } catch (error) {
      console.error('[ProjectManager] Error loading projects:', error);
      this.showToast('error', 'Failed to load projects');
    }
  },

  // Render project list in sidebar
  renderProjectList(projects) {
    const container = document.getElementById('projectList');
    if (!projects || projects.length === 0) {
      container.innerHTML = `
            <div style="text-align: center; padding: 20px 10px;">
              <div style="font-size: 32px; margin-bottom: 8px;">📁</div>
              <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 12px;">No projects in this space yet</p>
              <button class="btn btn-secondary" onclick="app.showCreateProjectModal()" style="width: 100%;">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 6px;"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                Create First Project
              </button>
            </div>
          `;
      return;
    }

    container.innerHTML = projects
      .map(
        (project) => `
          <div class="project-item ${project.id === this.currentProjectId ? 'active' : ''}" 
               data-project-id="${project.id}"
               onclick="app.selectProject('${project.id}')">
            <div class="project-item-icon">🎬</div>
            <div class="project-item-info">
              <div class="project-item-name">${this.escapeHtml(project.name)}</div>
              <div class="project-item-meta">${project.versions?.length || 0} versions, ${project.assets?.length || 0} assets</div>
            </div>
            <div class="project-item-actions">
              <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); app.renameProject('${project.id}')" title="Rename">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
              </button>
              <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); app.deleteProject('${project.id}')" title="Delete">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
              </button>
            </div>
          </div>
        `
      )
      .join('');
  },

  // Open a project from context menu - loads default version into editor
  async openProject(projectId) {
    try {
      console.log('[openProject] Opening project:', projectId);
      const project = await window.projectAPI.getProject(projectId);
      console.log('[openProject] Got project:', project);

      if (!project) {
        this.showToast('error', 'Project not found');
        return;
      }

      this.currentProjectId = projectId;
      this.projectData = project;

      // Get the default version or first version
      const versions = await window.projectAPI.getProjectVersions(projectId);
      console.log('[openProject] Versions:', versions);
      const defaultVersionId = project.defaultVersion || (versions.length > 0 ? versions[0].id : null);
      console.log('[openProject] Default version ID:', defaultVersionId);

      if (defaultVersionId) {
        // Load the version into editor
        await this.loadVersion(defaultVersionId);
        this.showToast('success', `Opened project: ${project.name}`);
      } else {
        // No versions - show project but prompt to add a video
        this.showToast('info', 'Project has no versions yet. Add a video to get started.');
      }

      // Update UI
      this.updateVersionUI();
    } catch (error) {
      console.error('[openProject] Error:', error);
      this.showToast('error', 'Failed to open project');
    }
  },

  // Select a project and show its details (for sidebar view)
  async selectProject(projectId) {
    try {
      const project = await window.projectAPI.getProject(projectId);
      if (!project) {
        this.showToast('error', 'Project not found');
        return;
      }

      this.projectData = project;

      // Get versions for this project
      const versions = await window.projectAPI.getProjectVersions(projectId);

      // Show project details section
      document.getElementById('spaceProjectsSection').style.display = 'none';
      document.getElementById('projectDetailsSection').style.display = 'block';
      document.getElementById('projectDetailsTitle').textContent = project.name;

      // Render versions list
      this.renderProjectVersionsList(versions);

      // Render assets list
      this.renderProjectAssetsList(project.assets || []);
    } catch (error) {
      console.error('[ProjectManager] Error selecting project:', error);
      this.showToast('error', 'Failed to load project');
    }
  },

  // Render versions list in project details
  renderProjectVersionsList(versions) {
    const container = document.getElementById('projectVersionsList');
    if (!versions || versions.length === 0) {
      container.innerHTML = '<p style="color: var(--text-muted); font-size: 11px;">No versions yet</p>';
      return;
    }

    container.innerHTML = versions
      .map(
        (version) => `
          <div class="project-version-item ${version.id === this.currentVersionId ? 'active' : ''}"
               data-version-id="${version.id}"
               onclick="app.loadVersion('${version.id}')">
            <span class="project-version-icon">${version.parentVersionId ? '📄' : '📁'}</span>
            <span class="project-version-name">${this.escapeHtml(version.name)}</span>
            ${version.id === this.projectData?.defaultVersion ? '<span class="project-version-badge">default</span>' : ''}
          </div>
        `
      )
      .join('');
  },

  // Render assets list in project details
  renderProjectAssetsList(assets) {
    const container = document.getElementById('projectAssetsList');
    if (!assets || assets.length === 0) {
      container.innerHTML = '<p style="color: var(--text-muted); font-size: 11px;">No assets yet</p>';
      return;
    }

    const typeIcons = { video: '🎬', audio: '🎵', image: '🖼️' };

    container.innerHTML = assets
      .map(
        (asset) => `
          <div class="project-asset-item" data-asset-id="${asset.id}">
            <span class="project-asset-icon">${typeIcons[asset.type] || '📄'}</span>
            <span class="project-asset-name">${this.escapeHtml(asset.name)}</span>
          </div>
        `
      )
      .join('');
  },

  // Close project details and go back to project list
  closeProjectDetails() {
    document.getElementById('projectDetailsSection').style.display = 'none';
    document.getElementById('spaceProjectsSection').style.display = 'block';
  },

  // Load a version and switch to it
  async loadVersion(versionId) {
    try {
      console.log('[loadVersion] Loading version:', versionId, 'for project:', this.projectData?.id);

      // Save current version first if we have one
      if (this.currentVersionId) {
        await this.saveCurrentVersion();
      }

      // Load the new version
      const result = await window.projectAPI.loadSession(this.projectData?.id || this.currentProjectId, versionId);
      console.log('[loadVersion] Session result:', result);
      console.log('[loadVersion] Primary asset:', result?.primaryAsset);

      if (!result) {
        this.showToast('error', 'Failed to load version');
        return;
      }

      this.currentProjectId = result.project.id;
      this.currentVersionId = result.version.id;
      this.projectData = result.project;
      this.versionData = result.version;

      // IMPORTANT: Apply version state BEFORE loading video to avoid race condition
      // where video's loadedmetadata event fires before transcriptSegments is set
      this.applyVersionState(result.version);

      // Load the primary video asset if available
      if (result.primaryAsset?.path) {
        console.log('[loadVersion] Loading video from path:', result.primaryAsset.path);

        // Set up state for preprocessing - use asset ID as fallback space item ID
        // This ensures the preloader can cache assets properly
        if (!this.spaceItemId) {
          this.spaceItemId = result.primaryAsset.id || `asset-${Date.now()}`;
          this.spaceItemName = result.primaryAsset.name || 'Video';
          console.log('[loadVersion] Set spaceItemId for preprocessing:', this.spaceItemId);
        }

        // Set flag to prevent loadVideo from clearing markers/state
        this._loadingFromProject = true;
        await this.loadVideo(result.primaryAsset.path);
        this._loadingFromProject = false;
      } else {
        console.log('[loadVersion] No primary asset path found');

        // Check if project has any video assets we can use
        const projectAssets = result.project?.assets || [];
        const videoAssets = projectAssets.filter((a) => a.type === 'video' && a.path);
        console.log('[loadVersion] Project has', videoAssets.length, 'video assets');

        if (videoAssets.length > 0) {
          // Use the first video asset and update version to link it
          const firstVideo = videoAssets[0];
          console.log('[loadVersion] Using first video asset:', firstVideo.path);

          // Set up state for preprocessing
          this.spaceItemId = firstVideo.id || `asset-${Date.now()}`;
          this.spaceItemName = firstVideo.name || 'Video';
          console.log('[loadVersion] Set spaceItemId for preprocessing:', this.spaceItemId);

          this._loadingFromProject = true;
          await this.loadVideo(firstVideo.path);
          this._loadingFromProject = false;

          // Update version to link this asset
          await window.projectAPI.updateVersion(result.version.id, {
            primaryVideoAssetId: firstVideo.id,
          });
        } else {
          // No video assets in project - prompt user to select one
          console.log('[loadVersion] No video assets in project, prompting user to add one');
          this.showToast('info', 'This project has no video. Please select a video to work with.');

          // Show the add video prompt
          this.promptAddVideoToProject(result.project.id, result.version.id);
        }
      }

      // Update UI
      this.updateVersionUI();
      this.startAutoSave();

      this.showToast('success', `Loaded: ${result.version.name}`);
      console.log('[loadVersion] Successfully loaded version:', versionId);
    } catch (error) {
      console.error('[loadVersion] Error loading version:', error);
      this.showToast('error', 'Failed to load version');
    }
  },

  // Update version-related UI elements
  updateVersionUI() {
    // Show/hide version selector
    const selector = document.getElementById('versionSelector');
    if (selector) {
      selector.style.display = this.currentVersionId ? 'block' : 'none';
    }

    // Update current version name
    const nameEl = document.getElementById('currentVersionName');
    if (nameEl && this.versionData) {
      nameEl.textContent = this.versionData.name;
    }

    // Update dropdown if open
    if (this.versionDropdownOpen) {
      this.renderVersionDropdown();
    }
  },

  // Toggle version dropdown
  toggleVersionDropdown() {
    this.versionDropdownOpen = !this.versionDropdownOpen;
    const dropdown = document.getElementById('versionDropdown');

    if (this.versionDropdownOpen) {
      this.renderVersionDropdown();
      dropdown.classList.add('show');

      // Close on outside click
      setTimeout(() => {
        document.addEventListener('click', this.closeVersionDropdownHandler);
      }, 0);
    } else {
      dropdown.classList.remove('show');
      document.removeEventListener('click', this.closeVersionDropdownHandler);
    }
  },

  closeVersionDropdownHandler: function (e) {
    if (!e.target.closest('.version-selector')) {
      app.toggleVersionDropdown();
    }
  },

  // Render version dropdown list
  async renderVersionDropdown() {
    if (!this.currentProjectId) return;

    const container = document.getElementById('versionDropdownList');

    try {
      const tree = await window.projectAPI.getVersionTree(this.currentProjectId);

      // Use VersionTree to render
      if (window.VersionTree) {
        const versionTree = new window.VersionTree(tree);
        container.innerHTML = versionTree.renderDropdownList(this.currentVersionId);
      } else {
        // Fallback simple render
        const versions = await window.projectAPI.getProjectVersions(this.currentProjectId);
        container.innerHTML = versions
          .map(
            (v) => `
              <div class="version-dropdown-item ${v.id === this.currentVersionId ? 'selected' : ''}"
                   onclick="app.switchToVersion('${v.id}')">
                <span class="version-dropdown-name">${this.escapeHtml(v.name)}</span>
                ${v.id === this.currentVersionId ? '<span class="version-dropdown-check">✓</span>' : ''}
              </div>
            `
          )
          .join('');
      }
    } catch (error) {
      console.error('[ProjectManager] Error rendering version dropdown:', error);
      container.innerHTML = '<p style="color: var(--text-muted); padding: 8px;">Error loading versions</p>';
    }
  },

  // Switch to a different version
  async switchToVersion(versionId) {
    if (versionId === this.currentVersionId) {
      this.toggleVersionDropdown();
      return;
    }

    // Close dropdown
    if (this.versionDropdownOpen) {
      this.toggleVersionDropdown();
    }

    await this.loadVersion(versionId);
  },

  // Show version tree modal
  async showVersionTreeModal() {
    if (!this.currentProjectId) {
      this.showToast('error', 'No project loaded');
      return;
    }

    // Close dropdown if open
    if (this.versionDropdownOpen) {
      this.toggleVersionDropdown();
    }

    document.getElementById('versionTreeModal').style.display = 'flex';
    await this.renderVersionTree();
  },

  closeVersionTreeModal() {
    document.getElementById('versionTreeModal').style.display = 'none';
  },

  // Render version tree in modal
  async renderVersionTree() {
    const container = document.getElementById('versionTreeContainer');

    try {
      const tree = await window.projectAPI.getVersionTree(this.currentProjectId);

      if (window.VersionTree) {
        const versionTree = new window.VersionTree(tree);
        container.innerHTML = versionTree.renderHTML({
          selectedVersionId: this.currentVersionId,
          onVersionClick: 'app.selectVersionFromTree',
          onBranchClick: 'app.branchVersion',
          onDeleteClick: 'app.confirmDeleteVersion',
        });
      } else {
        container.innerHTML = '<p style="color: var(--text-muted);">Version tree not available</p>';
      }
    } catch (error) {
      console.error('[ProjectManager] Error rendering version tree:', error);
      container.innerHTML = '<p style="color: var(--text-muted);">Error loading version tree</p>';
    }
  },

  // Select version from tree view
  async selectVersionFromTree(versionId) {
    this.closeVersionTreeModal();
    await this.switchToVersion(versionId);
  },

  // Show create project modal
  async showCreateProjectModal() {
    const spaceId = this._currentSpaceId || this.selectedSpace?.id;
    console.log('[showCreateProjectModal] Opening modal for space:', spaceId);

    document.getElementById('newProjectName').value = '';
    this._selectedProjectVideos = []; // Store selected video IDs

    const modal = document.getElementById('createProjectModal');
    modal.style.display = 'flex';
    modal.classList.add('visible');
    document.getElementById('newProjectName').focus();

    // Load videos from space
    await this.loadSpaceVideosForProject(spaceId);
  },

  // Load videos from space for project creation
  async loadSpaceVideosForProject(spaceId) {
    const container = document.getElementById('spaceVideosList');
    container.innerHTML = '<p style="color: var(--text-muted); font-size: 12px; margin: 0;">Loading videos...</p>';

    try {
      if (!spaceId) {
        container.innerHTML = '<p style="color: var(--text-muted); font-size: 12px; margin: 0;">No space selected</p>';
        return;
      }

      const result = await window.spaces.getItems(spaceId);
      // Handle both { success, items } format and raw array format
      const items = result && result.items ? result.items : Array.isArray(result) ? result : [];
      const videos = items.filter(
        (item) => item.fileType === 'video' || (item.fileName && this.isVideoFile(item.fileName))
      );

      console.log('[loadSpaceVideosForProject] Found videos:', videos.length);

      if (videos.length === 0) {
        container.innerHTML = `
              <p style="color: var(--text-muted); font-size: 12px; margin: 0; text-align: center; padding: 20px 0;">
                📭 No videos in this space yet
              </p>
            `;
        return;
      }

      container.innerHTML = videos
        .map((video) => {
          const name = video.fileName || video.name || 'Untitled';
          const size = this.formatBytes(video.fileSize || video.size || 0);
          return `
              <label class="video-checkbox-item" style="display: flex; align-items: center; padding: 8px; cursor: pointer; border-radius: 4px; margin-bottom: 4px; transition: background 0.15s;">
                <input type="checkbox" class="project-video-checkbox" data-video-id="${video.id}" style="margin-right: 10px; width: 16px; height: 16px; cursor: pointer;">
                <span style="flex: 1; font-size: 12px; color: var(--text-primary);">🎬 ${this.escapeHtml(name)}</span>
                <span style="font-size: 11px; color: var(--text-muted);">${size}</span>
              </label>
            `;
        })
        .join('');

      // Add hover effect via JS since we can't easily add CSS
      container.querySelectorAll('.video-checkbox-item').forEach((item) => {
        item.addEventListener('mouseenter', () => (item.style.background = 'rgba(255,255,255,0.05)'));
        item.addEventListener('mouseleave', () => (item.style.background = 'transparent'));
      });

      // Track checkbox changes
      container.querySelectorAll('.project-video-checkbox').forEach((checkbox) => {
        checkbox.addEventListener('change', () => {
          this.updateSelectedVideos();
        });
      });
    } catch (error) {
      console.error('[loadSpaceVideosForProject] Error:', error);
      container.innerHTML = '<p style="color: var(--text-muted); font-size: 12px; margin: 0;">Error loading videos</p>';
    }
  },

  // Update selected videos list
  updateSelectedVideos() {
    const checkboxes = document.querySelectorAll('.project-video-checkbox:checked');
    this._selectedProjectVideos = Array.from(checkboxes).map((cb) => ({
      id: cb.dataset.videoId,
    }));
    console.log('[updateSelectedVideos] Selected:', this._selectedProjectVideos.length, 'videos');
  },

  closeCreateProjectModal() {
    const modal = document.getElementById('createProjectModal');
    modal.classList.remove('visible');
    modal.style.display = 'none';
    this._selectedProjectVideos = [];
  },

  // Prompt user to add a video to an existing project
  async promptAddVideoToProject(projectId, _versionId) {
    console.log('[promptAddVideoToProject] Prompting for project:', projectId);

    // Get the space for this project
    const project = await window.projectAPI.getProject(projectId);
    const spaceId = project?.spaceId || 'default';

    // Use the existing modal system instead of prompt()
    this.showAddVideoToProjectModal(projectId, spaceId);
  },

  // Show modal to add video to project
  async showAddVideoToProjectModal(projectId, spaceId) {
    console.log('[showAddVideoToProjectModal] Project:', projectId, 'Space:', spaceId);

    // Get videos from the space
    const result = await window.spaces.getItems(spaceId);
    // Handle both { success, items } format and raw array format
    const items = result && result.items ? result.items : Array.isArray(result) ? result : [];
    const videos = items.filter(
      (item) => item.fileType === 'video' || (item.fileName && this.isVideoFile(item.fileName))
    );

    if (videos.length === 0) {
      this.showToast('info', 'No videos found in this space. Add videos to the space first.');
      return;
    }

    // Create modal HTML
    const modalHtml = `
          <div id="addVideoModal" class="modal-overlay">
            <div class="modal" style="max-width: 600px; max-height: 80vh; display: flex; flex-direction: column;">
              <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid #3a3a3a;">
                <h2 style="margin: 0; font-size: 16px; font-weight: 600; color: #ddd;">Add Video to Project</h2>
                <button style="background: none; border: none; color: #999; font-size: 24px; cursor: pointer; padding: 0; line-height: 1;" onclick="app.closeAddVideoModal()" title="Close">&times;</button>
              </div>
              <div style="overflow-y: auto; flex: 1; margin-bottom: 16px;">
                <p style="margin-bottom: 16px; color: #999; font-size: 13px;">Select a video from this space to add to your project:</p>
                <div id="addVideoList" style="display: flex; flex-direction: column; gap: 8px;">
                  ${videos
                    .map(
                      (video) => `
                    <div class="video-option" data-video-id="${video.id}" 
                         style="padding: 12px; border: 1px solid #3a3a3a; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 12px; transition: all 0.2s; background: #2a2a2a;"
                         onmouseover="this.style.borderColor='#64c8ff'; this.style.backgroundColor='#333'"
                         onmouseout="this.style.borderColor='#3a3a3a'; this.style.backgroundColor='#2a2a2a'"
                         onclick="app.selectVideoForProject('${video.id}')">
                      <div style="font-size: 24px;">🎬</div>
                      <div style="flex: 1;">
                        <div style="font-weight: 500; margin-bottom: 4px; color: #ddd;">${video.fileName || video.name || 'Untitled'}</div>
                        ${video.metadata?.duration ? `<div style="font-size: 12px; color: #888;">Duration: ${this.formatDuration(video.metadata.duration)}</div>` : ''}
                      </div>
                    </div>
                  `
                    )
                    .join('')}
                </div>
              </div>
              <div style="display: flex; justify-content: flex-end; padding-top: 12px; border-top: 1px solid #3a3a3a;">
                <button style="padding: 8px 16px; background: #3a3a3a; border: none; border-radius: 4px; color: #ddd; cursor: pointer; font-size: 13px;" onclick="app.closeAddVideoModal()">Cancel</button>
              </div>
            </div>
          </div>
        `;

    // Add modal to page
    document.body.insertAdjacentHTML('beforeend', modalHtml);

    // Store project ID for later
    this.pendingProjectId = projectId;

    // Add visible class after a small delay to trigger CSS transition
    setTimeout(() => {
      const modal = document.getElementById('addVideoModal');
      if (modal) {
        modal.classList.add('visible');
      }
    }, 10);
  },

  closeAddVideoModal() {
    const modal = document.getElementById('addVideoModal');
    if (modal) {
      // Remove visible class to trigger fade-out transition
      modal.classList.remove('visible');
      // Wait for transition to complete before removing from DOM
      setTimeout(() => {
        modal.remove();
      }, 200);
    }
    this.pendingProjectId = null;
  },

  async selectVideoForProject(videoId) {
    console.log('[selectVideoForProject] Video:', videoId, 'Project:', this.pendingProjectId);

    if (!this.pendingProjectId) {
      console.error('[selectVideoForProject] No pending project ID');
      return;
    }

    const projectId = this.pendingProjectId;
    this.closeAddVideoModal();

    try {
      // Get the video path
      const pathResult = await window.spaces.getVideoPath(videoId);
      if (!pathResult.success || !pathResult.filePath) {
        this.showToast('error', pathResult.error || 'Could not get video path');
        return;
      }

      // Add video as asset to project
      const asset = await window.projectAPI.addAsset(projectId, pathResult.filePath, 'video');
      console.log('[selectVideoForProject] Added asset:', asset);

      this.showToast('success', 'Video added to project');

      // Reload the project to show the new asset
      await this.openProject(projectId);
    } catch (error) {
      console.error('[selectVideoForProject] Error:', error);
      this.showToast('error', 'Failed to add video: ' + error.message);
    }
  },

  // Confirm and create new project
  async confirmCreateProject() {
    const name = document.getElementById('newProjectName').value.trim();
    const selectedVideos = this._selectedProjectVideos || [];

    if (!name) {
      this.showToast('error', 'Please enter a project name');
      return;
    }

    // Use the space ID from sidebar selection OR context menu selection
    const spaceId = this.selectedSpace?.id || this._currentSpaceId || 'default';
    console.log('[confirmCreateProject] Creating project in space:', spaceId, 'with', selectedVideos.length, 'videos');

    // Warn if no videos selected
    if (selectedVideos.length === 0) {
      console.warn('[confirmCreateProject] No videos selected - project will be created without a primary video');
      this.showToast('warning', 'Creating project without a video. You can add one later.');
    }

    try {
      // Get the actual file path for the first video from the space
      let initialVideoPath = null;
      let primaryVideoId = null;

      if (selectedVideos.length > 0) {
        primaryVideoId = selectedVideos[0].id;
        console.log('[confirmCreateProject] Getting path for primary video:', primaryVideoId);
        const pathResult = await window.spaces.getVideoPath(primaryVideoId);
        console.log('[confirmCreateProject] getVideoPath result:', pathResult);
        if (pathResult.success && pathResult.filePath) {
          initialVideoPath = pathResult.filePath;
          console.log('[confirmCreateProject] Primary video path:', initialVideoPath);
        } else {
          console.error('[confirmCreateProject] Failed to get video path:', pathResult?.error);
          this.showToast('warning', 'Could not link video to project: ' + (pathResult?.error || 'Unknown error'));
        }
      }

      const result = await window.projectAPI.createProject({
        name,
        spaceId,
        initialVideoPath,
      });

      // Add additional videos as assets
      if (selectedVideos.length > 1) {
        for (let i = 1; i < selectedVideos.length; i++) {
          const video = selectedVideos[i];
          const pathResult = await window.spaces.getVideoPath(video.id);
          if (pathResult.success && pathResult.filePath) {
            await window.projectAPI.addAssetToProject(result.project.id, pathResult.filePath, 'video');
          }
        }
      }

      this.closeCreateProjectModal();

      // Load the new project
      this.currentProjectId = result.project.id;
      this.currentVersionId = result.version.id;
      this.projectData = await window.projectAPI.getProject(result.project.id); // Refresh to get all assets
      this.versionData = result.version;

      // Load primary video using loadVideoFromSpace (handles transcripts, scenes, etc.)
      if (primaryVideoId) {
        console.log('[confirmCreateProject] Loading video from space:', primaryVideoId);
        await this.loadVideoFromSpace(primaryVideoId);
      }

      // Update UI
      this.updateVersionUI();
      this.startAutoSave();

      // Refresh project list in sidebar if visible
      const refreshSpaceId = this.selectedSpace?.id || this._currentSpaceId;
      if (refreshSpaceId) {
        this.loadProjectsForSpace(refreshSpaceId);
      }

      const videoCount = selectedVideos.length;
      this.showToast(
        'success',
        `Created project: ${name}${videoCount > 0 ? ` with ${videoCount} video${videoCount > 1 ? 's' : ''}` : ''}`
      );
    } catch (error) {
      console.error('[ProjectManager] Error creating project:', error);
      this.showToast('error', 'Failed to create project');
    }
  },

  // Create a new version (blank)
  async createNewVersion() {
    if (!this.currentProjectId) {
      this.showToast('error', 'No project loaded');
      return;
    }

    const name = prompt('Enter version name:', `Version ${Date.now()}`);
    if (!name) return;

    try {
      // Save current version first
      if (this.currentVersionId) {
        await this.saveCurrentVersion();
      }

      const version = await window.projectAPI.createVersion(this.currentProjectId, { name });

      // Switch to the new version
      await this.loadVersion(version.id);

      // Refresh tree if modal is open
      if (document.getElementById('versionTreeModal').style.display === 'flex') {
        await this.renderVersionTree();
      }

      this.showToast('success', `Created version: ${name}`);
    } catch (error) {
      console.error('[ProjectManager] Error creating version:', error);
      this.showToast('error', 'Failed to create version');
    }
  },

  // Create new version in project details view
  async createNewVersionInProject() {
    if (!this.projectData?.id) return;

    const name = prompt('Enter version name:', `Version ${Date.now()}`);
    if (!name) return;

    try {
      await window.projectAPI.createVersion(this.projectData.id, { name });

      // Refresh versions list
      const versions = await window.projectAPI.getProjectVersions(this.projectData.id);
      this.renderProjectVersionsList(versions);

      this.showToast('success', `Created version: ${name}`);
    } catch (error) {
      console.error('[ProjectManager] Error creating version:', error);
      this.showToast('error', 'Failed to create version');
    }
  },

  // Branch from current version
  branchFromCurrent() {
    if (!this.currentVersionId) {
      this.showToast('error', 'No version loaded');
      return;
    }
    this.branchVersion(this.currentVersionId);
  },

  // Show branch version modal
  branchVersion(sourceVersionId) {
    this.branchSourceVersionId = sourceVersionId;

    // Update modal info
    const version = this.versionData?.id === sourceVersionId ? this.versionData : null;
    document.getElementById('branchSourceInfo').textContent = version
      ? `Branch from "${version.name}"`
      : 'Create a new branch from this version';
    document.getElementById('branchVersionName').value = '';

    document.getElementById('branchVersionModal').style.display = 'flex';
    document.getElementById('branchVersionName').focus();
  },

  closeBranchVersionModal() {
    document.getElementById('branchVersionModal').style.display = 'none';
    this.branchSourceVersionId = null;
  },

  // Confirm branch creation
  async confirmBranchVersion() {
    const name = document.getElementById('branchVersionName').value.trim();

    if (!name) {
      this.showToast('error', 'Please enter a version name');
      return;
    }

    if (!this.branchSourceVersionId) {
      this.showToast('error', 'No source version selected');
      return;
    }

    try {
      const newVersion = await window.projectAPI.branchVersion(this.branchSourceVersionId, name);

      this.closeBranchVersionModal();

      // Switch to the new version
      await this.loadVersion(newVersion.id);

      // Refresh tree if modal is open
      if (document.getElementById('versionTreeModal').style.display === 'flex') {
        await this.renderVersionTree();
      }

      this.showToast('success', `Branched: ${name}`);
    } catch (error) {
      console.error('[ProjectManager] Error branching version:', error);
      this.showToast('error', 'Failed to branch version');
    }
  },

  // Confirm delete version
  async confirmDeleteVersion(versionId) {
    // Don't allow deleting if it's the only version
    const versions = await window.projectAPI.getProjectVersions(this.currentProjectId);
    if (versions.length <= 1) {
      this.showToast('error', 'Cannot delete the only version');
      return;
    }

    const version = versions.find((v) => v.id === versionId);
    if (!confirm(`Delete version "${version?.name || versionId}"?\n\nThis cannot be undone.`)) {
      return;
    }

    try {
      await window.projectAPI.deleteVersion(versionId);

      // If we deleted the current version, switch to another
      if (versionId === this.currentVersionId) {
        const remaining = versions.filter((v) => v.id !== versionId);
        if (remaining.length > 0) {
          await this.loadVersion(remaining[0].id);
        }
      }

      // Refresh tree
      await this.renderVersionTree();

      this.showToast('success', 'Version deleted');
    } catch (error) {
      console.error('[ProjectManager] Error deleting version:', error);
      this.showToast('error', 'Failed to delete version');
    }
  },

  // Add asset to current project
  async addAssetToProject() {
    if (!this.projectData?.id) {
      this.showToast('error', 'No project selected');
      return;
    }

    try {
      const result = await window.videoEditor.openFile();
      if (!result?.path) return;

      // Determine asset type
      const ext = result.path.split('.').pop().toLowerCase();
      const audioExts = ['mp3', 'wav', 'aac', 'm4a', 'ogg'];
      const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp'];

      let type = 'video';
      if (audioExts.includes(ext)) type = 'audio';
      else if (imageExts.includes(ext)) type = 'image';

      await window.projectAPI.addAsset(this.projectData.id, result.path, type);

      // Refresh project data
      const project = await window.projectAPI.getProject(this.projectData.id);
      this.projectData = project;
      this.renderProjectAssetsList(project.assets);

      this.showToast('success', 'Asset added');
    } catch (error) {
      console.error('[ProjectManager] Error adding asset:', error);
      this.showToast('error', 'Failed to add asset');
    }
  },

  // Delete a project
  async deleteProject(projectId) {
    const project = await window.projectAPI.getProject(projectId);
    if (
      !confirm(`Delete project "${project?.name || projectId}"?\n\nThis will delete all versions and cannot be undone.`)
    ) {
      return;
    }

    try {
      await window.projectAPI.deleteProject(projectId);

      // Clear if it was the current project
      if (projectId === this.currentProjectId) {
        this.currentProjectId = null;
        this.currentVersionId = null;
        this.projectData = null;
        this.versionData = null;
        this.updateVersionUI();
      }

      // Refresh project list (check both sidebar selection and context menu space)
      const spaceId = this.selectedSpace?.id || this._currentSpaceId;
      if (spaceId) {
        this.loadProjectsForSpace(spaceId);
      }

      // Close project details section if open and go back to project list
      const projectDetailsSection = document.getElementById('projectDetailsSection');
      if (projectDetailsSection && projectDetailsSection.style.display !== 'none') {
        this.closeProjectDetails();
      }

      this.showToast('success', 'Project deleted');
    } catch (error) {
      console.error('[ProjectManager] Error deleting project:', error);
      this.showToast('error', 'Failed to delete project');
    }
  },

  // Rename project
  async renameProject(projectId) {
    const project = await window.projectAPI.getProject(projectId);
    const newName = prompt('Enter new name:', project?.name || '');
    if (!newName || newName === project?.name) return;

    try {
      await window.projectAPI.renameProject(projectId, newName);

      // Refresh project list
      if (this.selectedSpace?.id) {
        this.loadProjectsForSpace(this.selectedSpace.id);
      }

      this.showToast('success', 'Project renamed');
    } catch (error) {
      console.error('[ProjectManager] Error renaming project:', error);
      this.showToast('error', 'Failed to rename project');
    }
  },

  // Legacy project methods (for backwards compatibility)
  async createProject(videoPath, spaceId) {
    try {
      const result = await window.projectAPI.createProject({
        name: videoPath
          .split('/')
          .pop()
          .replace(/\.[^.]+$/, ''),
        spaceId: spaceId || 'default',
        initialVideoPath: videoPath,
      });

      this.currentProject = result.project;
      this.currentProjectId = result.project.id;
      this.currentVersionId = result.version.id;
      this.projectData = result.project;
      this.versionData = result.version;

      await this.registerProjectForBudget();
      this.startAutoSave();
      this.projectBudgetEstimates = this.getDefaultBudgetEstimates();
      this.saveBudgetEstimates();
      this.updateVersionUI();

      console.log('[ProjectManager] Created project:', result.project.id);
      return this.currentProject;
    } catch (error) {
      console.error('[ProjectManager] Error creating project:', error);
      return null;
    }
  },

  async saveProject() {
    if (!this.currentVersionId) return;

    try {
      await this.saveCurrentVersion();
      console.log('[ProjectManager] Project saved');
      return { success: true };
    } catch (error) {
      console.error('[ProjectManager] Save error:', error);
      return { success: false, error: error.message };
    }
  },

  async loadProject(projectId) {
    try {
      const result = await window.projectAPI.loadSession(projectId);

      this.currentProject = result.project;
      this.currentProjectId = result.project.id;
      this.currentVersionId = result.version.id;
      this.projectData = result.project;
      this.versionData = result.version;

      // IMPORTANT: Apply version state BEFORE loading video to avoid race condition
      // where video's loadedmetadata event fires before transcriptSegments is set
      this.applyVersionState(result.version);

      if (result.primaryAsset?.path) {
        console.log('[loadProject] Loading video from path:', result.primaryAsset.path);

        // Set up state for preprocessing
        if (!this.spaceItemId) {
          this.spaceItemId = result.primaryAsset.id || `asset-${Date.now()}`;
          this.spaceItemName = result.primaryAsset.name || 'Video';
          console.log('[loadProject] Set spaceItemId for preprocessing:', this.spaceItemId);
        }

        // Set flag to prevent loadVideo from clearing markers/state
        this._loadingFromProject = true;
        await this.loadVideo(result.primaryAsset.path);
        this._loadingFromProject = false;
      } else {
        console.log('[loadProject] No primary asset path found');

        // Check if project has any video assets we can use
        const projectAssets = result.project?.assets || [];
        const videoAssets = projectAssets.filter((a) => a.type === 'video' && a.path);
        console.log('[loadProject] Project has', videoAssets.length, 'video assets');

        if (videoAssets.length > 0) {
          // Use the first video asset and update version to link it
          const firstVideo = videoAssets[0];
          console.log('[loadProject] Using first video asset:', firstVideo.path);

          // Set up state for preprocessing
          this.spaceItemId = firstVideo.id || `asset-${Date.now()}`;
          this.spaceItemName = firstVideo.name || 'Video';
          console.log('[loadProject] Set spaceItemId for preprocessing:', this.spaceItemId);

          this._loadingFromProject = true;
          await this.loadVideo(firstVideo.path);
          this._loadingFromProject = false;

          // Update version to link this asset
          await window.projectAPI.updateVersion(result.version.id, {
            primaryVideoAssetId: firstVideo.id,
          });
        } else {
          // No video assets in project - prompt user to select one
          console.log('[loadProject] No video assets in project, prompting user to add one');
          this.showToast('info', 'This project has no video. Please select a video to work with.');

          // Show the add video prompt
          this.promptAddVideoToProject(result.project.id, result.version.id);
        }
      }

      this.startAutoSave();
      await this.loadProjectBudget();
      this.updateVersionUI();

      this.showToast('success', 'Project loaded');
      console.log('[ProjectManager] Project loaded:', projectId);
      return { success: true, project: this.currentProject };
    } catch (error) {
      console.error('[ProjectManager] Load error:', error);
      this.showToast('error', 'Failed to load project');
      return { success: false, error: error.message };
    }
  },

  startAutoSave() {
    // Clear existing interval
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
    }

    // Auto-save every 10 seconds (more frequent to protect user work)
    this.autoSaveInterval = setInterval(() => {
      if (this.currentVersionId && this.isDirty) {
        console.log('[AutoSave] Triggered - saving dirty state...');
        this._immediateSave();
      }
    }, 10000);

    console.log('[AutoSave] Started with 10 second interval');
  },

  stopAutoSave() {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
      this.autoSaveInterval = null;
    }
  },

  exportTranslations() {
    // Export translation data for project save
    return this.audioTracks
      .filter((t) => t.type === 'voice')
      .flatMap((t) => t.clips.filter((c) => c.type === 'translation'))
      .map((clip) => ({
        regionStart: clip.startTime,
        regionEnd: clip.endTime,
        sourceText: clip.sourceText,
        translatedText: clip.translatedText,
        audioPath: clip.path,
        score: clip.score,
        timingFix: clip.timingFix,
      }));
  },

  async exportProjectToSpace() {
    if (!this.currentProject && !this.projectData) {
      this.showToast('error', 'No project to export');
      return;
    }

    const project = this.projectData || this.currentProject;

    try {
      // Export beats.json
      const beatsData = this.exportBeatsJSON();
      const beatsJSON = JSON.stringify(beatsData, null, 2);

      // Export edit-session.json
      const sessionData = {
        projectId: project.id,
        versionId: this.currentVersionId,
        sourceVideo: this.videoPath,
        tracks: this.audioTracks,
        translations: this.exportTranslations(),
        modifiedAt: new Date().toISOString(),
      };
      const sessionJSON = JSON.stringify(sessionData, null, 2);

      // Download as files
      this.downloadJSON(beatsJSON, `beats-${project.id}.json`);
      this.downloadJSON(sessionJSON, `edit-session-${project.id}.json`);

      this.showToast('success', 'Project exported');
    } catch (error) {
      console.error('[ProjectManager] Export error:', error);
      this.showToast('error', 'Export failed');
    }
  },

  downloadJSON(jsonString, filename) {
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },

  // Escape HTML helper
  escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },
  // ==================== END PROJECT MANAGEMENT ====================

  // Splice Functions
  spliceStart: 0,
  spliceEnd: 0,

  setSpliceStart() {
    const video = document.getElementById('videoPlayer');
    this.spliceStart = video.currentTime;
    document.getElementById('spliceStart').value = this.formatTime(video.currentTime);
    this.updateSplicePreview();
    this.showToast('success', 'Splice IN point set');
  },

  setSpliceEnd() {
    const video = document.getElementById('videoPlayer');
    this.spliceEnd = video.currentTime;
    document.getElementById('spliceEnd').value = this.formatTime(video.currentTime);
    this.updateSplicePreview();
    this.showToast('success', 'Splice OUT point set');
  },

  updateSplicePreview() {
    const startInput = document.getElementById('spliceStart').value;
    const endInput = document.getElementById('spliceEnd').value;

    this.spliceStart = this.parseTime(startInput);
    this.spliceEnd = this.parseTime(endInput);

    const video = document.getElementById('videoPlayer');
    const duration = video.duration || 0;

    const preview = document.getElementById('splicePreview');

    if (this.spliceStart > 0 || this.spliceEnd > 0) {
      const removeTime = Math.max(0, this.spliceEnd - this.spliceStart);
      const resultTime = Math.max(0, duration - removeTime);

      document.getElementById('spliceRemoveTime').textContent = this.formatTime(removeTime);
      document.getElementById('spliceResultTime').textContent = this.formatTime(resultTime);
      preview.style.display = 'block';
    } else {
      preview.style.display = 'none';
    }
  },

  async spliceVideo() {
    if (!this.videoPath) {
      this.showToast('error', 'No video loaded');
      return;
    }

    const startInput = document.getElementById('spliceStart').value;
    const endInput = document.getElementById('spliceEnd').value;

    const cutStart = this.parseTime(startInput);
    const cutEnd = this.parseTime(endInput);

    if (cutStart >= cutEnd) {
      this.showToast('error', 'Cut start must be before cut end');
      return;
    }

    const removeTime = cutEnd - cutStart;
    this.showProgress('Splicing Video...', `Removing ${this.formatTime(removeTime)} from video`);

    try {
      const result = await window.videoEditor.splice(this.videoPath, {
        cutStart: cutStart,
        cutEnd: cutEnd,
      });

      this.hideProgress();

      if (result.error) {
        throw new Error(result.error);
      }

      this.showToast(
        'success',
        `Removed ${this.formatTime(removeTime)} - new duration: ${this.formatTime(result.newDuration)}`
      );
      this.loadExports();

      // Reset splice inputs
      document.getElementById('spliceStart').value = '00:00:00';
      document.getElementById('spliceEnd').value = '00:00:00';
      document.getElementById('splicePreview').style.display = 'none';
      this.spliceStart = 0;
      this.spliceEnd = 0;
    } catch (error) {
      this.hideProgress();
      this.showToast('error', 'Failed to splice: ' + error.message);
    }
  },

  // Speed Control Functions
  setSpeedPreset(speed) {
    this.currentSpeed = speed;
    const speedSlider = document.getElementById('speedSlider');
    const speedValue = document.getElementById('speedValue');
    if (speedSlider) speedSlider.value = speed;
    if (speedValue) speedValue.textContent = speed.toFixed(2);

    // Update active button
    document.querySelectorAll('.speed-btn').forEach((btn) => {
      btn.classList.toggle('active', parseFloat(btn.dataset.speed) === speed);
    });

    // Preview speed (change video playback rate)
    const video = document.getElementById('videoPlayer');
    video.playbackRate = speed;
  },

  updateSpeedValue(value) {
    const speed = parseFloat(value);
    this.currentSpeed = speed;
    const speedValue = document.getElementById('speedValue');
    if (speedValue) speedValue.textContent = speed.toFixed(2);

    // Update button states
    document.querySelectorAll('.speed-btn').forEach((btn) => {
      btn.classList.toggle('active', parseFloat(btn.dataset.speed) === speed);
    });

    // Preview speed
    const video = document.getElementById('videoPlayer');
    video.playbackRate = speed;
  },

  async applySpeed() {
    if (!this.videoPath) {
      this.showToast('error', 'No video loaded');
      return;
    }

    if (this.currentSpeed === 1.0) {
      this.showToast('warning', 'Speed is already 1x (no change needed)');
      return;
    }

    const speedLabel = this.currentSpeed > 1 ? `${this.currentSpeed}x faster` : `${this.currentSpeed}x slower`;
    this.showProgress('Changing Speed...', `Making video ${speedLabel}`);

    try {
      const result = await window.videoEditor.changeSpeed(this.videoPath, {
        speed: this.currentSpeed,
      });

      this.hideProgress();

      if (result.error) {
        throw new Error(result.error);
      }

      this.showToast('success', `Video speed changed to ${this.currentSpeed}x!`);
      this.loadExports();
    } catch (error) {
      this.hideProgress();
      this.showToast('error', 'Failed to change speed: ' + error.message);
    }
  },

  async reverseVideo() {
    if (!this.videoPath) {
      this.showToast('error', 'No video loaded');
      return;
    }

    this.showProgress('Reversing Video...', 'Playing video backwards');

    try {
      const result = await window.videoEditor.reverse(this.videoPath, {
        includeAudio: true,
      });

      this.hideProgress();

      if (result.error) {
        throw new Error(result.error);
      }

      this.showToast('success', 'Video reversed successfully!');
      this.loadExports();
    } catch (error) {
      this.hideProgress();
      this.showToast('error', 'Failed to reverse video: ' + error.message);
    }
  },

  // Set trim points
  setTrimStart() {
    const video = document.getElementById('videoPlayer');

    // Push undo state BEFORE making changes
    this.pushUndoState(`Set trim start to ${this.formatTime(video.currentTime)}`);

    this.trimStart = video.currentTime;
    document.getElementById('trimStart').value = this.formatTime(video.currentTime);
    this.updateTrimRegion();
    this.showToast('success', 'Trim start set');
  },

  setTrimEnd() {
    const video = document.getElementById('videoPlayer');

    // Push undo state BEFORE making changes
    this.pushUndoState(`Set trim end to ${this.formatTime(video.currentTime)}`);

    this.trimEnd = video.currentTime;
    document.getElementById('trimEnd').value = this.formatTime(video.currentTime);
    this.updateTrimRegion();
    this.showToast('success', 'Trim end set');
  },

  // Audio scrubbing state
  isScrubbing: false,
  scrubAudioEnabled: true,
  lastScrubTime: 0,
  scrubTimeout: null,
  wasPlaying: false,

  /**
   * Seek to position on timeline click.
   *
   * CRITICAL ALIGNMENT: Must use rulerMarks.getBoundingClientRect() for calculations.
   * The ruler marks element is the source of truth for timeline positioning.
   * DO NOT use videoClip, timelineTrack, or timelineContent for click calculations
   * as they have different widths than the ruler.
   */
  seekToPosition(event) {
    // Don't seek if clicking on buttons
    if (event.target.closest('button')) return;

    if (this.isScrubbing) return;

    const rulerMarks = document.getElementById('rulerMarks');
    const video = document.getElementById('videoPlayer');
    if (!rulerMarks || !video || !video.duration) return;

    // IMPORTANT: Use rulerMarks for coordinate calculations - it matches the timecode display
    const rulerRect = rulerMarks.getBoundingClientRect();
    const clickX = event.clientX - rulerRect.left;
    const percent = Math.max(0, Math.min(1, clickX / rulerRect.width));

    video.currentTime = percent * video.duration;

    // Trigger audio scrub on click
    if (this.scrubAudioEnabled && !video.muted) {
      this.playAudioScrub();
    }

    this.updateTimeDisplay();
  },

  // Setup timeline scrubbing with audio
  setupTimelineScrubbing() {
    const track = document.getElementById('timelineTrack');
    const audioTrack = document.getElementById('audioTrack');
    const video = document.getElementById('videoPlayer');

    if (!track) return;

    const startScrub = (e) => {
      // Don't start scrubbing if clicking on buttons
      if (e.target?.closest('button')) return;

      if (!this.videoPath || !video.duration) return;
      this.isScrubbing = true;
      this.wasPlaying = !video.paused;
      video.pause();
      document.body.style.cursor = 'ew-resize';
      this.handleScrubMove(e);
    };

    const moveScrub = (e) => {
      if (!this.isScrubbing) return;
      this.handleScrubMove(e);
    };

    const endScrub = () => {
      if (!this.isScrubbing) return;
      this.isScrubbing = false;
      document.body.style.cursor = '';
      video.pause(); // Ensure paused after scrub

      // Resume if was playing
      if (this.wasPlaying) {
        video.play();
      }
    };

    // Mouse events
    track.addEventListener('mousedown', startScrub);
    if (audioTrack) audioTrack.addEventListener('mousedown', startScrub);
    document.addEventListener('mousemove', moveScrub);
    document.addEventListener('mouseup', endScrub);

    // Touch events for mobile
    track.addEventListener('touchstart', (e) => {
      e.preventDefault();
      startScrub(e.touches[0]);
    });
    document.addEventListener('touchmove', (e) => {
      if (this.isScrubbing) {
        e.preventDefault();
        moveScrub(e.touches[0]);
      }
    });
    document.addEventListener('touchend', endScrub);
  },

  /**
   * Handle scrub/drag on timeline.
   * CRITICAL: Uses rulerMarks for coordinate calculations to match ruler display.
   */
  handleScrubMove(e) {
    const rulerMarks = document.getElementById('rulerMarks');
    const video = document.getElementById('videoPlayer');

    if (!rulerMarks || !video || !video.duration) return;

    // IMPORTANT: Use rulerMarks for coordinate calculations
    const rulerRect = rulerMarks.getBoundingClientRect();
    const scrubPercent = Math.max(0, Math.min(1, (e.clientX - rulerRect.left) / rulerRect.width));
    const newTime = scrubPercent * video.duration;

    // Update video position
    video.currentTime = newTime;

    // Play audio scrub using Web Audio API (smooth, sample-accurate)
    if (this.isAudioLoaded) {
      // Use word-aligned scrubbing if transcript available
      if (this.transcriptSegments && this.transcriptSegments.length > 0) {
        this.playWordAtTime(newTime);
      } else {
        // Fallback: only play if moved enough (reduces choppy overlapping)
        const timeDiff = Math.abs(newTime - (this.lastScrubTime || 0));
        if (timeDiff > 0.05) {
          this.playScrubAudio(newTime, 0.2, 1.0);
          this.lastScrubTime = newTime;
        }
      }
    }

    // Update display
    this.updateTimeDisplay();

    // Update teleprompter highlight during scrub
    this.updateTeleprompterHighlight(newTime);

    // Playhead position is updated by updateTimeDisplay() called above
  },

  // Word-aligned audio scrubbing - plays entire words for clear syllables
  playWordAtTime(time) {
    if (!this.transcriptSegments || !this.audioBuffer) {
      console.log('[Scrub] playWordAtTime - missing:', {
        hasSegments: !!this.transcriptSegments,
        hasAudioBuffer: !!this.audioBuffer,
      });
      // Fallback to regular scrub
      this.playScrubAudio(time, 0.2, 1.0);
      return;
    }

    // Find the word segment at or near this time
    const word = this.transcriptSegments.find((seg) => time >= seg.start && time <= seg.end);

    // If not inside a word, find the nearest upcoming word
    const nearestWord = word || this.transcriptSegments.find((seg) => seg.start > time);

    if (nearestWord && nearestWord !== this.lastPlayedWord) {
      this.lastPlayedWord = nearestWord;

      // Play from word start to word end (the whole word)
      const wordDuration = nearestWord.end - nearestWord.start;

      // Add small padding for natural sound
      const startTime = Math.max(0, nearestWord.start - 0.02);
      const duration = Math.min(wordDuration + 0.04, 0.8); // Cap at 800ms for long words

      console.log(
        '[Scrub] Playing word:',
        nearestWord.text,
        'at',
        startTime.toFixed(2),
        'for',
        duration.toFixed(2) + 's'
      );
      this.playScrubAudio(startTime, duration, 1.0);
    }
  },

  // Legacy playAudioScrub - now uses Web Audio
  playAudioScrub() {
    // Use Web Audio instead - this is now handled in handleScrubMove
    const video = document.getElementById('videoPlayer');
    if (!video || !this.isAudioLoaded) return;
    this.playScrubAudio(video.currentTime, 0.1, 1.0);
  },

  // Clean up old timeout-based scrub stop (kept for compatibility)
  stopLegacyScrub() {
    if (this.scrubTimeout) {
      clearTimeout(this.scrubTimeout);
      this.scrubTimeout = null;
    }
  },

  // Toggle audio scrubbing
  toggleAudioScrub() {
    this.scrubAudioEnabled = !this.scrubAudioEnabled;
    this.showToast('info', `Audio scrubbing ${this.scrubAudioEnabled ? 'enabled' : 'disabled'}`);
  },

  // Processing functions
  async trimVideo() {
    if (!this.videoPath) return;

    const hasFades = this.fades.fadeIn || this.fades.fadeOut;
    const message = hasFades ? 'Exporting with effects...' : 'Cutting your selected segment';
    this.showProgress('Processing Video...', message);

    try {
      const result = await window.videoEditor.trim(this.videoPath, {
        startTime: this.trimStart,
        endTime: this.trimEnd || this.videoInfo?.duration,
        fadeIn: this.fades.fadeIn,
        fadeOut: this.fades.fadeOut,
      });

      this.hideProgress();

      if (result.error) {
        throw new Error(result.error);
      }

      this.showToast('success', hasFades ? 'Video exported with effects!' : 'Video trimmed successfully!');
      this.loadExports();
    } catch (error) {
      this.hideProgress();
      this.showToast('error', 'Export failed: ' + error.message);
    }
  },

  async transcodeVideo() {
    if (!this.videoPath) return;

    const format = document.getElementById('outputFormat').value;
    const resolution = document.getElementById('resolution').value;

    this.showProgress('Converting Video...', `Converting to ${format.toUpperCase()}`);

    try {
      const qualitySettings = {
        high: { crf: 18, preset: 'slow' },
        medium: { crf: 23, preset: 'medium' },
        low: { crf: 28, preset: 'fast' },
        custom: { crf: 23, preset: 'medium' },
      };

      const settings = qualitySettings[this.quality];

      const result = await window.videoEditor.transcode(this.videoPath, {
        format: format,
        resolution: resolution || null,
        ...settings,
      });

      this.hideProgress();

      if (result.error) {
        throw new Error(result.error);
      }

      this.showToast('success', 'Video converted successfully!');
      this.loadExports();
    } catch (error) {
      this.hideProgress();
      this.showToast('error', 'Conversion failed: ' + error.message);
    }
  },

  async extractAudio() {
    if (!this.videoPath) return;

    this.showProgress('Extracting Audio...', 'Creating audio file from video');

    try {
      const result = await window.videoEditor.extractAudio(this.videoPath, {
        format: 'mp3',
        audioBitrate: '192k',
      });

      this.hideProgress();

      if (result.error) {
        throw new Error(result.error);
      }

      this.showToast('success', 'Audio extracted successfully!');
      this.loadExports();
    } catch (error) {
      this.hideProgress();
      this.showToast('error', 'Extraction failed: ' + error.message);
    }
  },

  async compressVideo() {
    if (!this.videoPath) return;

    this.showProgress('Compressing Video...', 'Reducing file size');

    try {
      const result = await window.videoEditor.compress(this.videoPath, {
        quality: 'medium',
      });

      this.hideProgress();

      if (result.error) {
        throw new Error(result.error);
      }

      this.showToast('success', 'Video compressed successfully!');
      this.loadExports();
    } catch (error) {
      this.hideProgress();
      this.showToast('error', 'Compression failed: ' + error.message);
    }
  },

  async transcribeVideo() {
    if (!this.videoPath) return;

    this.showProgress('Transcribing...', 'Using AI to transcribe audio');

    try {
      const result = await window.videoEditor.transcribeRange(this.videoPath, {
        startTime: 0,
        endTime: this.videoInfo?.duration || null,
        language: 'en',
      });

      this.hideProgress();

      if (result.error) {
        throw new Error(result.error);
      }

      // Show transcription in a toast and copy to clipboard
      this.showToast('success', 'Transcription complete! Copied to clipboard.');
      if (result.transcription) {
        navigator.clipboard.writeText(result.transcription);
        console.log('Transcription:', result.transcription);
      }
    } catch (error) {
      this.hideProgress();
      this.showToast('error', 'Transcription failed: ' + error.message);
    }
  },

  async generateThumbnails() {
    if (!this.videoPath) return;

    this.showProgress('Generating Thumbnails...', 'Creating preview images');

    try {
      const result = await window.videoEditor.generateThumbnails(this.videoPath, {
        count: 5,
        size: '640x360',
      });

      this.hideProgress();

      if (result.error) {
        throw new Error(result.error);
      }

      this.showToast('success', `Generated ${result.length} thumbnails!`);
    } catch (error) {
      this.hideProgress();
      this.showToast('error', 'Thumbnail generation failed: ' + error.message);
    }
  },

  // Progress modal
  showProgress(title, subtitle) {
    document.getElementById('progressTitle').textContent = title;
    document.getElementById('progressSubtitle').textContent = subtitle;
    document.getElementById('progressFill').style.width = '0%';
    document.getElementById('progressPercent').textContent = '0%';
    document.getElementById('progressStatus').textContent = 'Starting...';
    document.getElementById('progressModal').classList.add('visible');
  },

  updateProgress(progress) {
    const percent = Math.round(progress.percent || 0);
    document.getElementById('progressFill').style.width = `${percent}%`;
    document.getElementById('progressPercent').textContent = `${percent}%`;

    // Show status message (prefer progress.status, fallback to timemark)
    const statusText = progress.status || progress.timemark || 'Processing...';
    document.getElementById('progressStatus').textContent = statusText;

    // Also update the subtitle if there's detailed status
    if (progress.status) {
      document.getElementById('progressSubtitle').textContent = progress.status;
    }

    this.currentJobId = progress.jobId;
  },

  hideProgress() {
    document.getElementById('progressModal').classList.remove('visible');
    this.currentJobId = null;
  },

  async cancelJob() {
    if (this.currentJobId) {
      await window.videoEditor.cancelJob(this.currentJobId);
      this.hideProgress();
      this.showToast('warning', 'Operation cancelled');
    }
  },

  // ==================== BUDGET MANAGEMENT ====================

  /**
   * Get cost estimate for an AI operation
   * @param {string} provider - 'openai' | 'elevenlabs' | 'anthropic'
   * @param {Object} params - Parameters for estimation (text, characters, etc.)
   * @returns {Promise<Object>} Cost estimate with budget status
   */
  async getAICostEstimate(provider, params) {
    try {
      if (window.budgetAPI) {
        return await window.budgetAPI.estimateCost(provider, params);
      }
      return { cost: 0, allowed: true, warning: null };
    } catch (error) {
      console.error('[Budget] Error getting cost estimate:', error);
      return { cost: 0, allowed: true, warning: null };
    }
  },

  /**
   * Show cost confirmation dialog before AI operations
   * @param {string} provider - Provider name
   * @param {Object} params - Parameters for estimation
   * @param {string} operationName - Human-readable operation name
   * @returns {Promise<boolean>} True if user confirms, false otherwise
   */
  async confirmAICost(provider, params, operationName) {
    try {
      const estimate = await this.getAICostEstimate(provider, params);

      // If budget check fails, show error and return false
      if (!estimate.allowed) {
        this.showToast('error', `Budget exceeded: ${estimate.message}`);
        const openDashboard = confirm(
          `${estimate.message}\n\nWould you like to open the Budget Dashboard to adjust your limits?`
        );
        if (openDashboard && window.budgetAPI) {
          window.budgetAPI.openDashboard();
        }
        return false;
      }

      // Show warning if approaching budget limit
      if (estimate.warning) {
        this.showToast('warning', estimate.warning);
      }

      // For significant costs, ask for confirmation
      if (estimate.cost > 0.01) {
        const confirmed = confirm(
          `${operationName}\n\n` +
            `Estimated cost: ${estimate.formattedCost}\n` +
            `Remaining budget: $${estimate.remaining?.global?.toFixed(2) || 'N/A'}\n\n` +
            `Do you want to proceed?`
        );
        return confirmed;
      }

      return true;
    } catch (error) {
      console.error('[Budget] Error in cost confirmation:', error);
      // Don't block operations if budget system has issues
      return true;
    }
  },

  /**
   * Register current video project for budget tracking
   */
  async registerProjectForBudget() {
    if (this.currentProject && window.budgetAPI) {
      try {
        await window.budgetAPI.registerProject(this.currentProject.id, this.currentProject.name);
      } catch (error) {
        console.error('[Budget] Error registering project:', error);
      }
    }
  },

  /**
   * Get current project ID for budget tracking
   */
  getCurrentProjectId() {
    return this.currentProject?.id || null;
  },

  /**
   * Open the budget dashboard
   */
  openBudgetDashboard() {
    if (window.budgetAPI) {
      window.budgetAPI.openDashboard();
    } else {
      this.showToast('error', 'Budget API not available');
    }
  },

  // Project budget estimates (stored per project)
  projectBudgetEstimates: [],

  // Budget categories
  BUDGET_CATEGORIES: {
    voice: { name: 'Voice Generation', icon: '🎙️', provider: 'elevenlabs' },
    transcription: { name: 'Transcription', icon: '📝', provider: 'openai' },
    translation: { name: 'Translation', icon: '🌐', provider: 'anthropic' },
    description: { name: 'Scene Descriptions', icon: '🎬', provider: 'anthropic' },
    sfx: { name: 'Sound Effects', icon: '🔊', provider: 'elevenlabs' },
    dubbing: { name: 'Dubbing', icon: '🎭', provider: 'elevenlabs' },
  },

  /**
   * Load budget data for the current project
   */
  async loadProjectBudget() {
    if (!this.currentProject) return;

    try {
      // Load estimates from localStorage
      const key = `budget-${this.currentProject.id}`;
      const saved = localStorage.getItem(key);
      this.projectBudgetEstimates = saved ? JSON.parse(saved) : this.getDefaultBudgetEstimates();

      // Load actual costs from budget API
      let actuals = {};
      if (window.budgetAPI) {
        const costs = await window.budgetAPI.getProjectCosts(this.currentProject.id);
        actuals = costs?.byProvider || {};
      }

      this.renderBudgetPanel(actuals);
    } catch (error) {
      console.error('[Budget] Error loading project budget:', error);
    }
  },

  /**
   * Get default budget estimates
   */
  getDefaultBudgetEstimates() {
    return Object.keys(this.BUDGET_CATEGORIES).map((cat) => ({
      category: cat,
      amount: 0,
      description: '',
      units: '',
    }));
  },

  /**
   * Save budget estimates for current project
   */
  saveBudgetEstimates() {
    if (!this.currentProject) return;
    const key = `budget-${this.currentProject.id}`;
    localStorage.setItem(key, JSON.stringify(this.projectBudgetEstimates));
  },

  /**
   * Render the budget panel in the sidebar
   */
  async renderBudgetPanel(actuals = {}) {
    const lineItemsEl = document.getElementById('budgetLineItems');
    const estimatedTotalEl = document.getElementById('budgetEstimatedTotal');
    const actualTotalEl = document.getElementById('budgetActualTotal');
    const varianceTextEl = document.getElementById('budgetVarianceText');
    const varianceBarEl = document.getElementById('budgetVarianceBar');
    const activityEl = document.getElementById('budgetRecentActivity');

    if (!lineItemsEl) return;

    // Calculate totals
    let totalEstimated = 0;
    let totalActual = 0;

    // Map provider costs to categories
    const actualsByCategory = {};
    const providerToCategory = {
      elevenlabs: ['voice', 'sfx', 'dubbing'],
      openai: ['transcription'],
      anthropic: ['translation', 'description'],
    };

    Object.entries(actuals).forEach(([provider, data]) => {
      const cats = providerToCategory[provider] || [];
      const costPerCat = (data.cost || 0) / (cats.length || 1);
      cats.forEach((cat) => {
        actualsByCategory[cat] = (actualsByCategory[cat] || 0) + costPerCat;
      });
    });

    // Render line items
    const html = this.projectBudgetEstimates
      .map((est) => {
        const cat = this.BUDGET_CATEGORIES[est.category];
        const actual = actualsByCategory[est.category] || 0;
        const estimated = est.amount || 0;
        const variance = estimated - actual;

        totalEstimated += estimated;
        totalActual += actual;

        const varianceClass =
          variance > 0 ? 'color: var(--success)' : variance < 0 ? 'color: var(--error)' : 'color: var(--text-muted)';
        const varianceText =
          variance !== 0 ? (variance > 0 ? `↓$${variance.toFixed(2)}` : `↑$${Math.abs(variance).toFixed(2)}`) : '—';

        return `
            <div style="display: flex; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border-color); cursor: pointer;" onclick="app.editBudgetLineItem('${est.category}')">
              <span style="width: 24px;">${cat.icon}</span>
              <div style="flex: 1; min-width: 0;">
                <div style="font-weight: 500; font-size: 11px;">${cat.name}</div>
                <div style="font-size: 10px; color: var(--text-muted);">${est.units || 'Click to set estimate'}</div>
              </div>
              <div style="text-align: right; font-size: 11px;">
                <div>$${estimated.toFixed(2)} / $${actual.toFixed(2)}</div>
                <div style="${varianceClass}; font-size: 10px;">${varianceText}</div>
              </div>
            </div>
          `;
      })
      .join('');

    lineItemsEl.innerHTML = html || '<p style="color: var(--text-muted); font-size: 11px;">No line items</p>';

    // Update totals
    if (estimatedTotalEl) estimatedTotalEl.textContent = `$${totalEstimated.toFixed(2)}`;
    if (actualTotalEl) actualTotalEl.textContent = `$${totalActual.toFixed(2)}`;

    // Update variance
    const totalVariance = totalEstimated - totalActual;
    if (varianceTextEl) {
      varianceTextEl.textContent =
        totalVariance >= 0 ? `$${totalVariance.toFixed(2)} under` : `$${Math.abs(totalVariance).toFixed(2)} over`;
      varianceTextEl.style.color = totalVariance >= 0 ? 'var(--success)' : 'var(--error)';
    }

    if (varianceBarEl) {
      const percent = totalEstimated > 0 ? Math.min(100, (totalActual / totalEstimated) * 100) : 0;
      varianceBarEl.style.width = `${percent}%`;
      varianceBarEl.style.background =
        percent > 100 ? 'var(--error)' : percent > 75 ? 'var(--warning)' : 'var(--success)';
    }

    // Load recent activity
    if (activityEl && window.budgetAPI) {
      try {
        const usage = await window.budgetAPI.getUsageHistory({
          limit: 5,
          projectId: this.currentProject?.id,
        });

        if (usage && usage.length > 0) {
          activityEl.innerHTML = usage
            .map((entry) => {
              const date = new Date(entry.timestamp);
              const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              return `
                  <div style="display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid var(--border-color);">
                    <span style="color: var(--text-muted);">${timeStr}</span>
                    <span>${entry.operation}</span>
                    <span style="color: var(--accent);">$${entry.cost.toFixed(4)}</span>
                  </div>
                `;
            })
            .join('');
        } else {
          activityEl.innerHTML = '<p style="color: var(--text-muted);">No activity yet</p>';
        }
      } catch (e) {
        console.error('[Budget] Error loading activity:', e);
      }
    }
  },

  /**
   * Add a new budget line item
   */
  addBudgetLineItem() {
    this.editBudgetLineItem(null);
  },

  /**
   * Edit a budget line item
   */
  editBudgetLineItem(category) {
    const estimate = category ? this.projectBudgetEstimates.find((e) => e.category === category) : null;

    const categories = Object.entries(this.BUDGET_CATEGORIES)
      .map(
        ([key, cat]) => `<option value="${key}" ${category === key ? 'selected' : ''}>${cat.icon} ${cat.name}</option>`
      )
      .join('');

    const html = `
          <div style="padding: 16px;">
            <h3 style="margin-bottom: 16px; font-size: 14px;">Edit Budget Estimate</h3>
            <div style="margin-bottom: 12px;">
              <label style="display: block; font-size: 11px; color: var(--text-muted); margin-bottom: 4px;">Category</label>
              <select id="budgetEditCategory" style="width: 100%; padding: 8px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 4px; color: var(--text-primary);">
                ${categories}
              </select>
            </div>
            <div style="margin-bottom: 12px;">
              <label style="display: block; font-size: 11px; color: var(--text-muted); margin-bottom: 4px;">Estimated Amount ($)</label>
              <input type="number" id="budgetEditAmount" step="0.01" min="0" value="${estimate?.amount || ''}" style="width: 100%; padding: 8px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 4px; color: var(--text-primary);">
            </div>
            <div style="margin-bottom: 12px;">
              <label style="display: block; font-size: 11px; color: var(--text-muted); margin-bottom: 4px;">Units/Description</label>
              <input type="text" id="budgetEditUnits" placeholder="e.g., 5000 chars, 10 minutes" value="${estimate?.units || ''}" style="width: 100%; padding: 8px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 4px; color: var(--text-primary);">
            </div>
            <div style="display: flex; gap: 8px;">
              <button class="btn btn-secondary" style="flex: 1;" onclick="app.closeBudgetEditModal()">Cancel</button>
              <button class="btn btn-primary" style="flex: 1;" onclick="app.saveBudgetLineItemEdit()">Save</button>
            </div>
          </div>
        `;

    // Create modal
    let modal = document.getElementById('budgetEditModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'budgetEditModal';
      modal.style.cssText =
        'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 10000;';
      document.body.appendChild(modal);
    }

    modal.innerHTML = `<div style="background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 8px; width: 320px;">${html}</div>`;
    modal.style.display = 'flex';
  },

  /**
   * Close budget edit modal
   */
  closeBudgetEditModal() {
    const modal = document.getElementById('budgetEditModal');
    if (modal) modal.style.display = 'none';
  },

  /**
   * Save budget line item edit
   */
  async saveBudgetLineItemEdit() {
    const category = document.getElementById('budgetEditCategory')?.value;
    const amount = parseFloat(document.getElementById('budgetEditAmount')?.value) || 0;
    const units = document.getElementById('budgetEditUnits')?.value || '';

    if (!category) return;

    const existingIndex = this.projectBudgetEstimates.findIndex((e) => e.category === category);
    if (existingIndex >= 0) {
      this.projectBudgetEstimates[existingIndex] = { category, amount, units };
    } else {
      this.projectBudgetEstimates.push({ category, amount, units });
    }

    this.saveBudgetEstimates();
    this.closeBudgetEditModal();

    // Reload actuals and re-render
    let actuals = {};
    if (window.budgetAPI && this.currentProject) {
      const costs = await window.budgetAPI.getProjectCosts(this.currentProject.id);
      actuals = costs?.byProvider || {};
    }
    this.renderBudgetPanel(actuals);
    this.showToast('success', 'Budget estimate saved');
  },

  // ==================== END BUDGET MANAGEMENT ====================

  // Tab switching
  switchTab(tabName) {
    this.currentTab = tabName;

    document.querySelectorAll('.sidebar-tab').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.tab === tabName);
    });

    document.getElementById('editTab').classList.toggle('hidden', tabName !== 'edit');
    document.getElementById('sourcesTab')?.classList.toggle('hidden', tabName !== 'sources');
    document.getElementById('scenesTab').classList.toggle('hidden', tabName !== 'scenes');
    document.getElementById('spacesTab').classList.toggle('hidden', tabName !== 'spaces');
    document.getElementById('budgetTab')?.classList.toggle('hidden', tabName !== 'budget');
    document.getElementById('exportsTab').classList.toggle('hidden', tabName !== 'exports');

    // Load budget data when switching to budget tab
    if (tabName === 'budget') {
      this.loadProjectBudget();
    }

    // Render scenes list when switching to scenes tab
    if (tabName === 'scenes') {
      this.renderScenesList();
    }

    // Render sources when switching to sources tab
    if (tabName === 'sources') {
      this.renderVideoSources();
    }
  },

  // Load spaces
  async loadSpaces() {
    try {
      if (!window.spaces) {
        document.getElementById('spacesList').innerHTML =
          '<p style="color: var(--text-muted); font-size: 13px;">Spaces not available</p>';
        return;
      }

      const spaces = await window.spaces.getAll();
      const list = document.getElementById('spacesList');

      if (!spaces || spaces.length === 0) {
        list.innerHTML = '<p style="color: var(--text-muted); font-size: 13px;">No spaces found</p>';
        return;
      }

      list.innerHTML = spaces
        .map(
          (space) => `
            <div class="space-item" onclick="app.selectSpace('${space.id}', '${space.name}')" data-space-id="${space.id}">
              <div class="space-icon">📁</div>
              <div class="space-info">
                <div class="space-name">${space.name}</div>
                <div class="space-count">${space.itemCount || 0} items</div>
              </div>
            </div>
          `
        )
        .join('');
    } catch (error) {
      console.error('Error loading spaces:', error);
    }
  },

  async selectSpace(spaceId, spaceName) {
    this.selectedSpace = { id: spaceId, name: spaceName };

    // Update active state
    document.querySelectorAll('.space-item').forEach((item) => {
      item.classList.toggle('active', item.dataset.spaceId === spaceId);
    });

    // Load projects for this space (new project-based flow)
    try {
      await this.loadProjectsForSpace(spaceId);
    } catch (error) {
      console.error('Error loading projects:', error);
    }

    // Also load videos from space (legacy support)
    try {
      const result = await window.spaces.getItems(spaceId);
      // Handle both { success, items } format and raw array format
      const items = result && result.items ? result.items : Array.isArray(result) ? result : [];
      const videos = items.filter(
        (item) => item.fileType === 'video' || (item.fileName && this.isVideoFile(item.fileName))
      );

      const section = document.getElementById('spaceVideosSection');
      const container = document.getElementById('spaceVideos');

      if (videos.length === 0) {
        container.innerHTML = '<p style="color: var(--text-muted); font-size: 13px;">No videos in this space</p>';
        section.style.display = 'none'; // Hide if no legacy videos
      } else {
        container.innerHTML = videos
          .map(
            (video) => `
              <div class="video-item" onclick="app.loadVideoFromSpace('${video.id}')" data-video-id="${video.id}">
                <div class="video-thumb">🎬</div>
                <div class="video-info">
                  <div class="video-name">${video.fileName || video.name}</div>
                  <div class="video-meta">${this.formatBytes(video.fileSize || video.size)}</div>
                </div>
              </div>
            `
          )
          .join('');
        section.style.display = 'block';
      }
    } catch (error) {
      console.error('Error loading space videos:', error);
    }
  },

  async loadVideoFromSpace(videoId) {
    if (!videoId) {
      this.showToast('error', 'Invalid video ID');
      return;
    }

    try {
      // Get the actual file path from the backend
      console.log('[VideoEditor] Getting path for video:', videoId);

      // Try new Spaces API first if available
      let result;
      if (window.spaces.api) {
        try {
          // Use the new unified video path getter
          result = await window.spaces.api.getVideoPath(videoId);
          console.log('[VideoEditor] Retrieved video via Spaces API:', result);
        } catch (apiError) {
          console.warn('[VideoEditor] Spaces API failed, falling back to legacy method:', apiError);
          // Fall back to legacy method
          result = await window.spaces.getVideoPath(videoId);
        }
      } else {
        // Use legacy method
        result = await window.spaces.getVideoPath(videoId);
      }

      if (!result.success || !result.filePath) {
        this.showToast('error', result.error || 'Video file not found');
        return;
      }

      console.log('[VideoEditor] Loading video from path:', result.filePath);

      // Track that this video is from a Space (for Save to Space feature)
      this.spaceItemId = videoId;
      this.spaceItemName = result.fileName || 'Video';

      // Load existing scenes if any
      if (result.scenes && result.scenes.length > 0) {
        console.log('[VideoEditor] Loading existing scenes:', result.scenes.length);
        this.loadScenesFromSpace(result.scenes);
      }

      // Load transcription segments for waveform word display and teleprompter
      this.transcriptSegments = null; // Reset first
      this.transcriptSource = null; // Reset source tracking
      this.pendingTranscriptText = null; // Store raw text for deferred segment creation
      try {
        const transcriptResult = await window.clipboard.getTranscription(videoId);
        console.log('[VideoEditor] Transcription result:', {
          success: transcriptResult?.success,
          hasTranscription: !!transcriptResult?.transcription,
          source: transcriptResult?.source,
          hasSegments: !!transcriptResult?.segments,
          transcriptLength: transcriptResult?.transcription?.length,
        });

        if (transcriptResult?.success && transcriptResult.transcription) {
          // First check if segments are returned directly from getTranscription
          let segments = transcriptResult.segments;
          let detectedSource = transcriptResult.source || 'unknown';

          // If no segments, check metadata
          if (!segments || segments.length === 0) {
            console.log('[VideoEditor] No segments from getTranscription, checking metadata...');
            const metadataResult = await window.clipboard.getMetadata(videoId);
            console.log('[VideoEditor] Metadata keys:', Object.keys(metadataResult || {}));
            segments =
              metadataResult?.transcriptSegments ||
              metadataResult?.transcript?.segments ||
              metadataResult?.words ||
              null;
            // Check for accurate transcription source in metadata
            if (
              metadataResult?.transcriptionSource === 'elevenlabs-scribe' ||
              metadataResult?.transcriptionSource === 'whisper'
            ) {
              detectedSource = metadataResult.transcriptionSource;
            }
            if (segments) {
              console.log('[VideoEditor] Found segments in metadata:', segments.length);
            }
          }

          if (segments && segments.length > 0) {
            this.transcriptSegments = segments;
            this.transcriptSource = detectedSource;

            // Also load speaker information from metadata
            const metadataForSpeakers = await window.clipboard.getMetadata(videoId);
            if (metadataForSpeakers?.transcriptSpeakers) {
              this.transcriptSpeakers = metadataForSpeakers.transcriptSpeakers;
              console.log('[VideoEditor] Loaded speakers from metadata:', this.transcriptSpeakers.join(', '));
            }
            if (metadataForSpeakers?.speakerNames) {
              this.speakerNames = metadataForSpeakers.speakerNames;
              console.log('[VideoEditor] Loaded speaker names from metadata:', JSON.stringify(this.speakerNames));
            }
            if (metadataForSpeakers?.speakerRoles) {
              this.speakerRoles = metadataForSpeakers.speakerRoles;
            }

            // Log timing info to verify these are real timestamps
            const first = segments[0];
            const last = segments[segments.length - 1];
            console.log(
              '[VideoEditor] Loaded',
              segments.length,
              'timed transcript segments (source:',
              detectedSource + ')'
            );
            console.log(
              '[VideoEditor] Segment timing range:',
              (first.start || 0).toFixed(1) + 's -',
              (last.end || last.start || 0).toFixed(1) + 's'
            );
            console.log('[VideoEditor] First segment:', JSON.stringify(first));

            // Auto-show teleprompter when transcript is available
            this.teleprompterVisible = true;
            const teleprompterContainer = document.getElementById('teleprompterContainer');
            const toggleBtn = document.getElementById('teleprompterToggleBtn');
            teleprompterContainer?.classList.remove('hidden');
            toggleBtn?.classList.add('active');
            this.initTeleprompter();
          } else {
            // No timed segments - store the raw text to create segments after video loads
            // This ensures we have the correct video duration
            console.log('[VideoEditor] No timed segments found, deferring segment creation until video loads');
            console.log('[VideoEditor] WARNING: Segments will be evenly distributed (not synced to audio)');
            this.pendingTranscriptText = transcriptResult.transcription;
            this.transcriptSource = 'pending-evenly-distributed';
          }
        }
      } catch (e) {
        console.log('[VideoEditor] Could not load transcript segments:', e.message);
      }

      this.loadVideo(result.filePath);
      this.switchTab('edit');

      // Show save button
      this.updateSaveToSpaceButton();

      // Try to load full project state from Space (includes audio tracks, translations, learning progress)
      try {
        const projectResult = await this.loadProjectFromSpace();
        if (projectResult.success) {
          console.log('[VideoEditor] Full project state restored from Space');
        }
      } catch (_projectError) {
        // Non-fatal - the video is still loaded, just without full project state
        console.log('[VideoEditor] No saved project state found (this is normal for new videos)');
      }
    } catch (error) {
      console.error('[VideoEditor] Error loading video from space:', error);
      if (window.api && window.api.log) {
        window.api.log.error('Video editor load from space failed', {
          error: error.message,
          operation: 'loadVideoFromSpace',
        });
      }
      this.showToast('error', 'Failed to load video: ' + error.message);
    }
  },

  // Load scenes from space metadata into markers
  loadScenesFromSpace(scenes) {
    // Clear existing markers
    this.markers = [];
    this.nextMarkerId = 1;

    scenes.forEach((scene) => {
      this.markers.push({
        id: this.nextMarkerId++,
        type: 'range',
        name: scene.name || `Scene ${scene.id}`,
        time: scene.inTime,
        inTime: scene.inTime,
        outTime: scene.outTime,
        color: scene.color || this.markerColors[(scene.id - 1) % this.markerColors.length],
        description: scene.description || '',
        transcription: scene.transcription || '',
        tags: scene.tags || [],
        notes: scene.notes || '',
        // Learning-specific fields
        markerType: scene.markerType || 'scene',
        completed: scene.completed || false,
        // Timestamps
        created: scene.created || new Date().toISOString(),
        modified: new Date().toISOString(),
      });
    });

    this.renderMarkers();
    this.updateMarkersPanel();
  },

  // Update the Save to Space button visibility
  updateSaveToSpaceButton() {
    const saveBtn = document.getElementById('saveToSpaceBtn');
    if (saveBtn) {
      saveBtn.style.display = this.spaceItemId ? 'inline-flex' : 'none';
      saveBtn.disabled = !this.spaceItemId;
    }
  },

  // Load exports
  async loadExports() {
    try {
      const exports = await window.videoEditor.getExports();
      const list = document.getElementById('exportsList');

      if (!exports || exports.length === 0) {
        list.innerHTML = '<p style="color: var(--text-muted); font-size: 13px;">No exports yet</p>';
        return;
      }

      list.innerHTML = exports
        .slice(0, 20)
        .map(
          (file) => `
            <div class="export-item">
              <div class="export-icon">📹</div>
              <div class="export-info">
                <div class="export-name">${file.name}</div>
                <div class="export-size">${this.formatBytes(file.size)}</div>
              </div>
              <div class="export-actions">
                <button class="export-action-btn" onclick="app.loadVideo('${file.path}')" title="Load">▶</button>
                <button class="export-action-btn" onclick="app.revealFile('${file.path}')" title="Show in Finder">📂</button>
              </div>
            </div>
          `
        )
        .join('');
    } catch (error) {
      console.error('Error loading exports:', error);
    }
  },

  async revealFile(filePath) {
    try {
      await window.videoEditor.revealFile(filePath);
    } catch (error) {
      console.error('Error revealing file:', error);
    }
  },

  async openExportFolder() {
    try {
      const dir = await window.videoEditor.getOutputDir();
      await window.videoEditor.revealFile(dir);
    } catch (error) {
      console.error('Error opening export folder:', error);
    }
  },

  showExportOptions() {
    // Check for ADR workflow tracks
    const hasWorkingTrack = this.adrManager?.hasWorkingTrack();
    const hasADRTrack = this.adrManager?.hasADRTrack();
    const hasFillTrack = !!this.adrManager?.findTrackByType('fill');
    const hasADRChanges = hasWorkingTrack || hasADRTrack;

    // Check for legacy audio replacements
    const replacements = this.getAudioReplacements();

    if (hasADRChanges) {
      // ADR workflow is being used
      const workingTrack = this.adrManager.findTrackByType('working');
      const adrTrack = this.adrManager.findTrackByType('adr');
      const deadSpaceCount = workingTrack?.deadSpaceRegions?.length || 0;
      const adrClipsCount = adrTrack?.clips?.length || 0;

      let message = 'Export with ADR (Automated Dialogue Replacement)?\n\n';
      message += 'Your changes:\n';
      if (deadSpaceCount > 0) message += `• ${deadSpaceCount} silence region(s)\n`;
      if (adrClipsCount > 0) message += `• ${adrClipsCount} ADR clip(s)\n`;
      if (hasFillTrack) message += `• Room tone fill track\n`;
      message += '\nClick OK to export with ADR applied.\nClick Cancel for quick export (original audio).';

      const choice = confirm(message);

      if (choice) {
        this.exportWithADR();
      } else {
        this.transcodeVideo();
      }
    } else if (replacements.length > 0) {
      // Legacy workflow
      const choice = confirm(
        `You have ${replacements.length} pending audio replacement(s):\n\n` +
          replacements
            .map((r) => `• ${r.name} (${this.formatTime(r.startTime)} - ${this.formatTime(r.endTime)})`)
            .join('\n') +
          '\n\nClick OK to export with all replacements applied.\nClick Cancel to export original video without replacements.'
      );

      if (choice) {
        this.exportWithAudioReplacements();
      } else {
        this.transcodeVideo();
      }
    } else {
      // No changes, just transcode
      this.transcodeVideo();
    }
  },

  /**
   * Export with ADR workflow
   */
  async exportWithADR() {
    if (!this.adrManager) {
      this.showToast('error', 'ADR system not available');
      return;
    }

    try {
      const result = await this.adrManager.exportWithADRTracks();

      if (result && result.outputPath) {
        // Add to exports list
        this.loadExports();

        // Show success with option to reveal
        const reveal = confirm(`Export complete!\n\n${result.filename}\n\nClick OK to reveal in Finder.`);
        if (reveal) {
          await window.videoEditor.revealFile(result.outputPath);
        }
      }
    } catch (error) {
      console.error('[App] ADR export error:', error);
      this.showToast('error', 'Export failed: ' + error.message);
    }
  },

  // Show count of pending audio replacements in UI
  updateAudioReplacementsCount() {
    const count = this.getAudioReplacements().length;
    const badge = document.getElementById('audioReplacementsBadge');
    if (badge) {
      badge.textContent = count;
      badge.style.display = count > 0 ? 'inline-block' : 'none';
    }

    // Also update export button text if there are replacements
    const exportBtn = document.getElementById('exportBtn');
    if (exportBtn) {
      exportBtn.textContent = count > 0 ? `Export (${count})` : 'Export';
    }
  },

  // ==================== RELEASE METHODS ====================

  // Release state
  releaseState: {
    selectedBranch: null,
    selectedDestination: 'space',
    isReleasing: false,
  },

  /**
   * Show release options modal
   */
  async showReleaseOptions() {
    if (!this.videoPath) {
      this.showToast('error', 'No video loaded');
      return;
    }

    const modal = document.getElementById('releaseModal');
    if (!modal) return;

    // Reset state
    this.releaseState.selectedBranch = null;
    this.releaseState.selectedDestination = 'space';
    this.releaseState.isReleasing = false;

    // Populate branches
    await this.populateReleaseBranches();

    // Reset destination selection
    document.querySelectorAll('.release-dest-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.dest === 'space');
      btn.style.borderColor = btn.dataset.dest === 'space' ? 'var(--accent)' : 'var(--border-color)';
    });

    // Set default metadata
    const fileName = this.videoPath
      ? this.videoPath
          .split('/')
          .pop()
          .replace(/\.[^/.]+$/, '')
      : 'Untitled';
    document.getElementById('releaseTitle').value = fileName;
    document.getElementById('releaseDescription').value = '';
    document.getElementById('releaseTags').value = '';
    document.getElementById('releasePrivacy').value = 'private';

    // Show modal
    modal.style.display = 'flex';

    // Hide progress section
    document.getElementById('releaseProgressSection').style.display = 'none';
    document.getElementById('startReleaseBtn').disabled = false;
  },

  /**
   * Close release modal
   */
  closeReleaseModal() {
    const modal = document.getElementById('releaseModal');
    if (modal) {
      modal.style.display = 'none';
    }
  },

  /**
   * Populate release branches list
   */
  async populateReleaseBranches() {
    const container = document.getElementById('releaseBranchList');
    if (!container) return;

    try {
      // Get release options from backend
      const releaseOptions = await window.videoEditor.getReleaseOptions();

      if (!releaseOptions || !releaseOptions.branches || releaseOptions.branches.length === 0) {
        // If no project branches, show current video as a single option
        container.innerHTML = this.renderCurrentVideoAsReleaseBranch();
        this.releaseState.selectedBranch = 'current';
        return;
      }

      // Render branches
      container.innerHTML = releaseOptions.branches
        .map((branch) => {
          const statusClass =
            branch.state === 'ready' ? 'ready' : branch.state === 'needs_render' ? 'needs-render' : 'unsaved';
          const statusLabel = branch.stateLabel || branch.state;
          const icon = this.getBranchTypeIcon(branch.type);

          return `
              <div class="release-branch-item" data-branch="${branch.id}" onclick="app.selectReleaseBranch('${branch.id}')">
                <span class="release-branch-icon">${icon}</span>
                <div class="release-branch-info">
                  <div class="release-branch-name">${branch.name}</div>
                  <div class="release-branch-meta">v${branch.version || '1.0'} • ${branch.type}</div>
                </div>
                <span class="release-branch-status ${statusClass}">${statusLabel}</span>
              </div>
            `;
        })
        .join('');

      // Select first ready branch by default
      const firstReady = releaseOptions.branches.find((b) => b.canRelease);
      if (firstReady) {
        this.selectReleaseBranch(firstReady.id);
      }
    } catch (error) {
      console.warn('[Release] Could not get release options:', error);
      // Fallback to current video
      container.innerHTML = this.renderCurrentVideoAsReleaseBranch();
      this.releaseState.selectedBranch = 'current';
    }
  },

  /**
   * Render current video as a release branch option
   */
  renderCurrentVideoAsReleaseBranch() {
    const fileName = this.videoPath ? this.videoPath.split('/').pop() : 'Current Video';
    const duration = this.videoDuration ? this.formatTime(this.videoDuration) : '00:00';

    return `
          <div class="release-branch-item selected" data-branch="current" onclick="app.selectReleaseBranch('current')">
            <span class="release-branch-icon">🎬</span>
            <div class="release-branch-info">
              <div class="release-branch-name">${fileName}</div>
              <div class="release-branch-meta">${duration}</div>
            </div>
            <span class="release-branch-status ready">Ready</span>
          </div>
        `;
  },

  /**
   * Get icon for branch type
   */
  getBranchTypeIcon(type) {
    const icons = {
      main: '🎬',
      directors: '🎥',
      social: '📱',
      extended: '➕',
      trailer: '🎞️',
      custom: '✨',
    };
    return icons[type] || '📁';
  },

  /**
   * Select a branch for release
   */
  selectReleaseBranch(branchId) {
    this.releaseState.selectedBranch = branchId;

    // Update UI
    document.querySelectorAll('.release-branch-item').forEach((item) => {
      const isSelected = item.dataset.branch === branchId;
      item.classList.toggle('selected', isSelected);
    });
  },

  /**
   * Select release destination
   */
  selectReleaseDestination(destination) {
    this.releaseState.selectedDestination = destination;

    // Update UI
    document.querySelectorAll('.release-dest-btn').forEach((btn) => {
      const isSelected = btn.dataset.dest === destination;
      btn.classList.toggle('active', isSelected);
      btn.style.borderColor = isSelected ? 'var(--accent)' : 'var(--border-color)';
    });

    // Update privacy options visibility
    const privacyGroup = document.getElementById('releasePrivacyGroup');
    if (privacyGroup) {
      privacyGroup.style.display = destination === 'youtube' || destination === 'vimeo' ? 'block' : 'none';
    }

    // Update destination status
    this.updateReleaseDestStatus(destination);
  },

  /**
   * Update destination status text
   */
  async updateReleaseDestStatus(destination) {
    const statusEl = document.getElementById('releaseDestStatus');
    if (!statusEl) return;

    if (destination === 'youtube' || destination === 'vimeo') {
      try {
        const status = await window.videoEditor.getUploadServiceStatus(destination);
        if (status.authenticated) {
          const name = status.channel?.title || status.user?.name || 'Connected';
          statusEl.innerHTML = `<span style="color: var(--success);">✓</span> Connected as ${name}`;
        } else if (status.configured) {
          statusEl.innerHTML = `<a href="#" onclick="app.connectUploadService('${destination}'); return false;" style="color: var(--accent);">Connect ${destination} Account</a>`;
        } else {
          statusEl.innerHTML = `Browser upload (no API configured)`;
        }
      } catch (_e) {
        statusEl.innerHTML = `Browser upload fallback`;
      }
    } else {
      statusEl.innerHTML = '';
    }
  },

  /**
   * Connect to upload service (YouTube/Vimeo)
   */
  async connectUploadService(service) {
    try {
      this.showToast('info', `Connecting to ${service}...`);
      const result = await window.videoEditor.authenticateUploadService(service);
      if (result.success) {
        this.showToast('success', `Connected to ${service}!`);
        this.updateReleaseDestStatus(service);
      }
    } catch (error) {
      this.showToast('error', `Failed to connect: ${error.message}`);
    }
  },

  /**
   * Start the release process
   */
  async startRelease() {
    if (this.releaseState.isReleasing) return;

    const branchId = this.releaseState.selectedBranch;
    const destination = this.releaseState.selectedDestination;

    if (!branchId) {
      this.showToast('error', 'Please select a version to release');
      return;
    }

    // Gather metadata
    const metadata = {
      title: document.getElementById('releaseTitle').value || 'Untitled',
      description: document.getElementById('releaseDescription').value || '',
      tags: document
        .getElementById('releaseTags')
        .value.split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      privacyStatus: document.getElementById('releasePrivacy').value || 'private',
    };

    // Show progress
    this.releaseState.isReleasing = true;
    document.getElementById('releaseProgressSection').style.display = 'block';
    document.getElementById('startReleaseBtn').disabled = true;
    this.updateReleaseProgress('Preparing release...', 0);

    try {
      let result;

      if (branchId === 'current') {
        // Release current video directly
        result = await window.videoEditor.releaseCurrentVideo(this.videoPath, destination, metadata, (progress) =>
          this.updateReleaseProgress(progress.status, progress.percent)
        );
      } else {
        // Release specific branch
        result = await window.videoEditor.releaseBranch(branchId, destination, metadata, (progress) =>
          this.updateReleaseProgress(progress.status, progress.percent)
        );
      }

      this.updateReleaseProgress('Release complete!', 100);

      // Show success message
      if (result.success) {
        let message = `Released to ${destination}!`;
        if (result.url) {
          message += ` URL: ${result.url}`;
        }
        this.showToast('success', message);

        // Close modal after short delay
        setTimeout(() => {
          this.closeReleaseModal();
        }, 1500);
      }
    } catch (error) {
      console.error('[Release] Error:', error);
      this.showToast('error', 'Release failed: ' + error.message);
      this.updateReleaseProgress('Release failed', 0);
    } finally {
      this.releaseState.isReleasing = false;
      document.getElementById('startReleaseBtn').disabled = false;
    }
  },

  /**
   * Update release progress UI
   */
  updateReleaseProgress(status, percent) {
    const statusEl = document.getElementById('releaseProgressStatus');
    const barEl = document.getElementById('releaseProgressBar');
    const percentEl = document.getElementById('releaseProgressPercent');

    if (statusEl) statusEl.textContent = status;
    if (barEl) barEl.style.width = `${percent}%`;
    if (percentEl) percentEl.textContent = `${Math.round(percent)}%`;
  },

  /**
   * Enable/disable release button based on video state
   */
  updateReleaseButton() {
    const releaseBtn = document.getElementById('releaseBtn');
    if (releaseBtn) {
      releaseBtn.disabled = !this.videoPath;
    }
  },

  // ==================== END RELEASE METHODS ====================

  // Utility functions
  formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '00:00:00';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  },

  parseTime(timeStr) {
    if (typeof timeStr === 'number') return timeStr;
    const parts = timeStr.split(':').map(Number);
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    return parseFloat(timeStr) || 0;
  },

  formatBytes(bytes) {
    if (!bytes) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
  },

  // Show alert when ElevenLabs API key is missing
  showElevenLabsKeyMissingAlert() {
    const message = `ElevenLabs API Key Not Configured

To use AI voice generation, you need to set up your ElevenLabs API key:

1. Go to elevenlabs.io and create an account (free tier available)
2. Navigate to: Profile Settings → API Keys
3. Copy your API key
4. In this app, go to Settings (⚙️ in the toolbar)
5. Scroll to "AI Voice Generation (ElevenLabs)"
6. Paste your API key and save

Direct link: https://elevenlabs.io/app/settings/api-keys`;

    alert(message);
    this.showToast('info', 'Open Settings to add your ElevenLabs API key');
  },

  // Toast notifications
  showToast(type, message) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icons = {
      success: '✅',
      error: '❌',
      warning: '⚠️',
    };

    toast.innerHTML = `
          <span class="toast-icon">${icons[type]}</span>
          <span class="toast-message">${message}</span>
        `;

    container.appendChild(toast);

    setTimeout(() => toast.classList.add('visible'), 10);

    setTimeout(() => {
      toast.classList.remove('visible');
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  },
};

// ==================== MIXIN INTEGRATION ====================
// Merge external modules into the app object
// Story Beats module (video-editor-beats.js)
if (window.VideoEditorBeats && window.VideoEditorBeats.mixin) {
  Object.assign(app, window.VideoEditorBeats.mixin);
  console.log('[VideoEditor] Story Beats module integrated');
}
// ==================== END MIXIN INTEGRATION ====================

// Expose app on window so module scripts can integrate safely.
// Note: top-level `const app = {}` works for inline handlers, but isn't a window property.
window.app = app;

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
  app.init();

  // Add event listener to transcription textarea to update ElevenLabs button
  const transcriptionField = document.getElementById('markerTranscription');
  if (transcriptionField) {
    transcriptionField.addEventListener('input', () => {
      app.updateElevenLabsButton();
    });
  }
});
