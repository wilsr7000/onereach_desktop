/**
 * LineScriptPanel.js - Main UI for Enhanced Line Script System
 * 
 * Features:
 * - Adaptive view modes (Spotting, Edit, Review, Export)
 * - Template-based rendering (Podcast, Product, Promo, Learning)
 * - Auto-scroll during playback
 * - Screenplay-style formatting
 * - Marker integration with visual feedback
 */

import { ContentTemplates, getTemplate, getAllTemplates } from './ContentTemplates.js';

/**
 * View modes for the Line Script panel
 */
export const VIEW_MODES = {
  SPOTTING: 'spotting',   // Minimal UI, large timecode, voice status - for marking while watching
  EDIT: 'edit',           // Full controls, metadata fields - for editing markers
  REVIEW: 'review',       // Thumbnails, quick preview - for reviewing marked content
  EXPORT: 'export'        // EDL format, technical notes - for export preparation
};

/**
 * LineScriptPanel - Main UI Component
 */
export class LineScriptPanel {
  constructor(appContext) {
    this.app = appContext;
    
    // Template management
    this.contentTemplates = new ContentTemplates();
    this.currentTemplateId = 'podcast';
    
    // View mode
    this.viewMode = VIEW_MODES.SPOTTING;
    this.modeLocked = false;
    
    // Content state
    this.words = [];
    this.markers = [];
    this.dialogueBlocks = [];
    this.speakers = [];
    this.transcriptSegments = [];
    
    // UI state
    this.visible = false;
    this.autoScroll = true;
    this.currentTime = 0;
    this.isPlaying = false;
    this.highlightedWordIndex = -1;
    this.renderedRangeStart = -1;
    this.renderedRangeEnd = -1;
    
    // Pending range marker
    this.pendingInPoint = null;
    
    // AI metadata generation state
    this.aiGenerating = false;
    this.aiProgress = { current: 0, total: 0 };
    
    // DOM elements
    this.container = null;
    this.contentArea = null;
    this.headerArea = null;
    this.footerArea = null;
    this.modeIndicator = null;
    
    // Event emitter for cross-view sync
    this.eventListeners = {};
    
    // Bind methods
    this.handleTimeUpdate = this.handleTimeUpdate.bind(this);
    this.handlePlayStateChange = this.handlePlayStateChange.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleMarkerAdded = this.handleMarkerAdded.bind(this);
  }

  /**
   * Get the video element - handles different property names in appContext vs main app
   * @returns {HTMLVideoElement|null}
   */
  getVideo() {
    // Try appContext.videoPlayer first (how LineScriptBridge sets it up)
    if (this.app.videoPlayer) {
      return this.app.videoPlayer;
    }
    // Then try this.app.video (legacy)
    if (this.app.video) {
      return this.app.video;
    }
    // Then try main app's video element
    const mainApp = this.app.app;
    if (mainApp?.video) {
      return mainApp.video;
    }
    // Finally try DOM lookup
    return document.getElementById('videoPlayer');
  }

  /**
   * Initialize the panel
   */
  init() {
    this.container = document.getElementById('lineScriptPanel') || 
                     document.getElementById('storyBeatsEditorContainer');
    
    // #region agent log
    console.log('[DEBUG-H4] init() called', {foundContainer: !!this.container, containerId: this.container?.id});
    // #endregion
    
    if (!this.container) {
      console.warn('[LineScriptPanel] Container not found');
      return;
    }
    
    // Load initial data
    this.loadTranscriptData();
    this.loadMarkers();
    
    // Setup event listeners
    this.setupEventListeners();
    
    // Initial render
    this.render();
    
    console.log('[LineScriptPanel] Initialized with template:', this.currentTemplateId);
  }

  /**
   * Setup event listeners
   */
  setupEventListeners() {
    // Store bound handlers so they can be removed later
    this._boundHandlePlay = () => this.handlePlayStateChange(true);
    this._boundHandlePause = () => this.handlePlayStateChange(false);
    
    // Video time updates
    const video = this.getVideo();
    if (video) {
      video.addEventListener('timeupdate', this.handleTimeUpdate);
      video.addEventListener('play', this._boundHandlePlay);
      video.addEventListener('pause', this._boundHandlePause);
    }
    
    // Keyboard shortcuts
    document.addEventListener('keydown', this.handleKeyDown);
    
    // Marker events from MarkerManager
    if (this.app.markerManager) {
      // Subscribe to marker changes
      this.subscribeToMarkerChanges();
    }
  }

  /**
   * Subscribe to marker manager changes
   */
  subscribeToMarkerChanges() {
    // If MarkerManager has event emitter, subscribe
    const markerManager = this.app.markerManager;
    if (markerManager && typeof markerManager.on === 'function') {
      markerManager.on('markerAdded', this.handleMarkerAdded);
      markerManager.on('markerUpdated', () => this.loadMarkers());
      markerManager.on('markerDeleted', () => this.loadMarkers());
    }
  }

  /**
   * Handle marker added event
   * @param {Object} marker - Added marker
   */
  handleMarkerAdded(marker) {
    this.loadMarkers();
    this.showMarkerFeedback(marker);
  }

  /**
   * Show visual feedback when marker is added
   * @param {Object} marker - Marker that was added
   */
  showMarkerFeedback(marker) {
    const template = this.contentTemplates.getCurrent();
    const markerType = template.markerTypes.find(m => m.id === marker.markerType);
    
    if (markerType) {
      this.showToast(`${markerType.icon} ${markerType.name} added`, 'success');
    } else {
      this.showToast('📍 Marker added', 'success');
    }
  }

  /**
   * Load transcript data
   */
  loadTranscriptData() {
    // #region agent log
    console.log('[DEBUG-H1] loadTranscriptData ENTRY', {hasAppApp: !!this.app?.app, appContextKeys: this.app ? Object.keys(this.app) : null});
    // #endregion
    
    // Get transcript from app context - check both the appContext and the main app object
    // The main app (this.app.app) has the live data, appContext may have stale snapshot
    const mainApp = this.app.app || this.app;
    
    // #region agent log
    console.log('[DEBUG-H2] Checking transcript sources', {mainAppTeleprompterWords: mainApp.teleprompterWords?.length || 0, mainAppTranscriptSegments: mainApp.transcriptSegments?.length || 0, appContextTeleprompterWords: this.app.teleprompterWords?.length || 0, appContextTranscriptSegments: this.app.transcriptSegments?.length || 0});
    // #endregion
    
    // Priority 1: Live teleprompter words from main app
    if (mainApp.teleprompterWords?.length > 0) {
      this.words = [...mainApp.teleprompterWords];
      console.log('[LineScriptPanel] Loaded', this.words.length, 'words from main app teleprompterWords');
    } 
    // Priority 2: Live transcript segments from main app
    else if (mainApp.transcriptSegments?.length > 0) {
      this.transcriptSegments = mainApp.transcriptSegments;
      this.words = this.expandTranscriptToWords(this.transcriptSegments);
      console.log('[LineScriptPanel] Loaded', this.words.length, 'words from main app transcriptSegments');
    }
    // Priority 3: Check appContext snapshot (fallback)
    else if (this.app.teleprompterWords?.length > 0) {
      this.words = [...this.app.teleprompterWords];
      console.log('[LineScriptPanel] Loaded', this.words.length, 'words from appContext teleprompterWords');
    } else if (this.app.transcriptSegments?.length > 0) {
      this.transcriptSegments = this.app.transcriptSegments;
      this.words = this.expandTranscriptToWords(this.transcriptSegments);
      console.log('[LineScriptPanel] Loaded', this.words.length, 'words from appContext transcriptSegments');
    } else {
      this.words = [];
      console.log('[LineScriptPanel] No transcript data available');
    }
    
    // #region agent log
    console.log('[DEBUG-H2] loadTranscriptData EXIT', {wordsCount: this.words?.length || 0, speakersCount: this.speakers?.length || 0});
    // #endregion
    
    // Get speakers from main app or appContext
    this.speakers = mainApp.speakers || this.app.speakers || [];
    
    // Parse dialogue blocks
    this.parseDialogueBlocks();
  }

  /**
   * Expand transcript segments into words with timing
   * @param {Array} segments - Transcript segments
   * @returns {Array} Words with timing
   */
  expandTranscriptToWords(segments) {
    const words = [];
    
    segments.forEach(segment => {
      const text = (segment.text || segment.word || '').trim();
      const startTime = segment.start || 0;
      const endTime = segment.end || (startTime + 1);
      const speaker = segment.speaker || null;
      
      if (!text.includes(' ')) {
        if (text.length > 0) {
          words.push({ text, start: startTime, end: endTime, speaker });
        }
        return;
      }
      
      const segmentWords = text.split(/\s+/).filter(w => w.length > 0);
      const segmentDuration = endTime - startTime;
      const wordDuration = segmentDuration / segmentWords.length;
      
      segmentWords.forEach((word, i) => {
        words.push({
          text: word,
          start: startTime + (i * wordDuration),
          end: startTime + ((i + 1) * wordDuration),
          speaker
        });
      });
    });
    
    return words;
  }

  /**
   * Parse dialogue blocks from words
   */
  parseDialogueBlocks() {
    this.dialogueBlocks = [];
    
    if (this.words.length === 0) return;
    
    const WORDS_PER_BLOCK = 25;
    let blockWords = [];
    let blockStartIdx = 0;
    let currentSpeaker = null;
    
    this.words.forEach((word, idx) => {
      // Check for speaker change
      const speakerChanged = word.speaker !== currentSpeaker && word.speaker;
      
      if (speakerChanged && blockWords.length > 0) {
        // Save current block
        this.dialogueBlocks.push({
          speaker: currentSpeaker,
          text: blockWords.join(' '),
          wordStartIdx: blockStartIdx,
          wordEndIdx: idx - 1,
          startTime: this.words[blockStartIdx].start,
          endTime: this.words[idx - 1].end
        });
        
        blockWords = [];
        blockStartIdx = idx;
      }
      
      if (word.speaker) {
        currentSpeaker = word.speaker;
        if (!this.speakers.includes(word.speaker)) {
          this.speakers.push(word.speaker);
        }
      }
      
      blockWords.push(word.text);
      
      // Create block at sentence end or word limit
      const isEndOfSentence = /[.!?]$/.test(word.text);
      const isLastWord = idx === this.words.length - 1;
      const isBlockFull = blockWords.length >= WORDS_PER_BLOCK;
      
      if ((isEndOfSentence && blockWords.length >= 8) || isBlockFull || isLastWord) {
        this.dialogueBlocks.push({
          speaker: currentSpeaker,
          text: blockWords.join(' '),
          wordStartIdx: blockStartIdx,
          wordEndIdx: idx,
          startTime: this.words[blockStartIdx].start,
          endTime: word.end
        });
        blockWords = [];
        blockStartIdx = idx + 1;
      }
    });
  }

  /**
   * Load markers from marker manager
   */
  loadMarkers() {
    const markerManager = this.app.markerManager;
    if (markerManager) {
      this.markers = markerManager.getAll() || [];
    } else {
      this.markers = this.app.markers || [];
    }
    
    // Sort by time
    this.markers.sort((a, b) => {
      const aTime = a.type === 'range' ? a.inTime : (a.time || 0);
      const bTime = b.type === 'range' ? b.inTime : (b.time || 0);
      return aTime - bTime;
    });
    
    // Re-render if visible
    if (this.visible) {
      this.render();
    }
  }

  /**
   * Handle video time update
   * @param {Event} e - Time update event
   */
  handleTimeUpdate(e) {
    this.currentTime = e.target.currentTime;
    
    // Update word highlighting
    this.updateWordHighlight();
    
    // Auto-scroll if enabled
    if (this.autoScroll && this.isPlaying) {
      this.scrollToCurrentTime();
    }
    
    // Update timecode display
    this.updateTimecodeDisplay();
  }

  /**
   * Handle play state change
   * @param {boolean} playing - Is playing
   */
  handlePlayStateChange(playing) {
    this.isPlaying = playing;
    
    // Auto-switch to spotting mode when playing
    if (playing && !this.modeLocked) {
      this.setViewMode(VIEW_MODES.SPOTTING);
    }
  }

  /**
   * Handle keyboard shortcuts
   * @param {KeyboardEvent} e - Keyboard event
   */
  handleKeyDown(e) {
    if (!this.visible) return;
    
    // Don't capture if typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    
    const template = this.contentTemplates.getCurrent();
    const shortcut = template.keyboardShortcuts[e.key.toLowerCase()];
    
    if (shortcut) {
      e.preventDefault();
      this.executeAction(shortcut.action);
      return;
    }
    
    // Global shortcuts
    switch (e.key.toLowerCase()) {
      case ' ':
        e.preventDefault();
        this.togglePlayPause();
        break;
      case 'escape':
        this.cancelPendingRange();
        break;
    }
  }

  /**
   * Execute an action from keyboard/voice command
   * @param {string} action - Action name
   */
  executeAction(action) {
    const time = this.currentTime;
    
    switch (action) {
      case 'addPointMarker':
        this.addMarker('spot', time);
        break;
      case 'setInPoint':
        this.setInPoint(time);
        break;
      case 'setOutPoint':
        this.setOutPoint(time);
        break;
      case 'undoLastMarker':
        this.undoLastMarker();
        break;
      default:
        // Template-specific marker types
        if (action.startsWith('add') && action.endsWith('Marker')) {
          const markerType = action.replace('add', '').replace('Marker', '').toLowerCase();
          this.addMarker('spot', time, { markerType });
        }
    }
  }

  /**
   * Add a marker at the specified time
   * @param {string} type - 'spot' or 'range'
   * @param {number} time - Time in seconds
   * @param {Object} metadata - Additional metadata
   */
  addMarker(type, time, metadata = {}) {
    const markerManager = this.app.markerManager;
    if (!markerManager) {
      console.warn('[LineScriptPanel] MarkerManager not available');
      return;
    }
    
    const template = this.contentTemplates.getCurrent();
    const markerTypeDef = template.markerTypes.find(m => m.id === metadata.markerType);
    
    const name = metadata.name || (markerTypeDef ? markerTypeDef.name : 'Marker');
    const color = metadata.color || (markerTypeDef ? markerTypeDef.color : '#4a9eff');
    
    if (type === 'spot') {
      const marker = markerManager.addSpotMarker(time, name, color, {
        ...metadata,
        source: 'linescript',
        templateId: this.currentTemplateId
      });
      
      this.showMarkerFeedback(marker);
    }
    
    this.loadMarkers();
    this.emit('markerAdded', { type, time, metadata });
  }

  /**
   * Set IN point for range marker
   * @param {number} time - Time in seconds
   */
  setInPoint(time) {
    this.pendingInPoint = time;
    this.showToast('◀ IN point set', 'info');
    this.updatePendingRangeUI();
  }

  /**
   * Set OUT point and complete range marker
   * @param {number} time - Time in seconds
   */
  setOutPoint(time) {
    if (this.pendingInPoint === null) {
      this.showToast('Set IN point first', 'warning');
      return;
    }
    
    const inTime = this.pendingInPoint;
    const outTime = time;
    
    if (outTime <= inTime) {
      this.showToast('OUT must be after IN', 'error');
      return;
    }
    
    const markerManager = this.app.markerManager;
    if (markerManager) {
      const template = this.contentTemplates.getCurrent();
      const marker = markerManager.addRangeMarker(inTime, outTime, 'Scene', template.primaryColor, {
        source: 'linescript',
        templateId: this.currentTemplateId
      });
      
      this.showMarkerFeedback(marker);
    }
    
    this.pendingInPoint = null;
    this.loadMarkers();
    this.updatePendingRangeUI();
  }

  /**
   * Cancel pending range marker
   */
  cancelPendingRange() {
    if (this.pendingInPoint !== null) {
      this.pendingInPoint = null;
      this.showToast('Range cancelled', 'info');
      this.updatePendingRangeUI();
    }
  }

  /**
   * Undo last marker
   */
  undoLastMarker() {
    const markerManager = this.app.markerManager;
    if (!markerManager || this.markers.length === 0) return;
    
    const lastMarker = this.markers[this.markers.length - 1];
    markerManager.deleteMarker(lastMarker.id);
    this.loadMarkers();
    this.showToast('↩️ Marker removed', 'info');
  }

  /**
   * Toggle play/pause
   */
  togglePlayPause() {
    const video = this.getVideo();
    if (video) {
      if (video.paused) {
        video.play();
      } else {
        video.pause();
      }
    }
  }

  /**
   * Set current template
   * @param {string} templateId - Template ID
   */
  setTemplate(templateId) {
    if (this.contentTemplates.setCurrent(templateId)) {
      this.currentTemplateId = templateId;
      this.render();
      this.emit('templateChanged', { templateId });
      console.log('[LineScriptPanel] Template changed to:', templateId);
    }
  }

  /**
   * Set view mode
   * @param {string} mode - View mode
   */
  setViewMode(mode) {
    if (this.modeLocked) return;
    
    if (Object.values(VIEW_MODES).includes(mode)) {
      this.viewMode = mode;
      this.updateModeUI();
      this.emit('modeChanged', { mode });
    }
  }

  /**
   * Lock current mode
   * @param {boolean} locked - Lock state
   */
  lockMode(locked = true) {
    this.modeLocked = locked;
    this.updateModeUI();
  }

  /**
   * Show the panel
   */
  show() {
    // #region agent log
    console.log('[DEBUG-H3,H4] show() called', {hasContainer: !!this.container, containerId: this.container?.id});
    // #endregion
    
    this.visible = true;
    if (this.container) {
      this.container.classList.remove('hidden');
    }
    this.loadTranscriptData();
    this.loadMarkers();
    this.render();
  }

  /**
   * Hide the panel
   */
  hide() {
    this.visible = false;
    if (this.container) {
      this.container.classList.add('hidden');
    }
  }

  /**
   * Toggle visibility
   */
  toggle() {
    if (this.visible) {
      this.hide();
    } else {
      this.show();
    }
  }

  /**
   * Render the panel
   */
  render() {
    // #region agent log
    console.log('[DEBUG-H5] render() called', {hasContainer: !!this.container, wordsCount: this.words?.length || 0, viewMode: this.viewMode, visible: this.visible});
    // #endregion
    
    if (!this.container) return;
    
    const template = this.contentTemplates.getCurrent();
    
    let html = '';
    
    // Header with template selector and mode indicator
    html += this.renderHeader(template);
    
    // Main content area
    html += '<div class="linescript-content">';
    
    if (this.words.length === 0 && this.dialogueBlocks.length === 0) {
      html += this.renderEmptyState();
    } else {
      // Render based on view mode
      switch (this.viewMode) {
        case VIEW_MODES.SPOTTING:
          html += this.renderSpottingMode(template);
          break;
        case VIEW_MODES.EDIT:
          html += this.renderEditMode(template);
          break;
        case VIEW_MODES.REVIEW:
          html += this.renderReviewMode(template);
          break;
        case VIEW_MODES.EXPORT:
          html += this.renderExportMode(template);
          break;
        default:
          html += this.renderSpottingMode(template);
      }
    }
    
    html += '</div>';
    
    // Footer with stats and controls
    html += this.renderFooter(template);
    
    this.container.innerHTML = html;
    
    // Attach event listeners
    this.attachEventListeners();
    
    // Cache DOM references
    this.contentArea = this.container.querySelector('.linescript-content');
    this.headerArea = this.container.querySelector('.linescript-header');
    this.footerArea = this.container.querySelector('.linescript-footer');
    this.modeIndicator = this.container.querySelector('.mode-indicator');
  }

  /**
   * Render header with template selector
   * @param {Object} template - Current template
   * @returns {string} HTML
   */
  renderHeader(template) {
    const allTemplates = getAllTemplates();
    const runningTime = this.words.length > 0 ? this.words[this.words.length - 1].end : 0;
    
    return `
      <div class="linescript-header" style="--template-color: ${template.primaryColor}">
        <div class="header-top">
          <div class="template-selector">
            <span class="template-label">Template:</span>
            <div class="template-buttons">
              ${allTemplates.map(t => `
                <button class="template-btn ${t.id === this.currentTemplateId ? 'active' : ''}"
                        data-template="${t.id}"
                        title="${t.description}"
                        style="${t.id === this.currentTemplateId ? `--btn-color: ${t.primaryColor}` : ''}">
                  <span class="template-icon">${t.icon}</span>
                  <span class="template-name">${t.name}</span>
                </button>
              `).join('')}
            </div>
          </div>
          
          <div class="mode-controls">
            <div class="mode-indicator ${this.viewMode}">
              ${this.getModeIcon(this.viewMode)} ${this.viewMode.toUpperCase()}
              ${this.modeLocked ? '🔒' : ''}
            </div>
            <div class="mode-buttons">
              ${Object.values(VIEW_MODES).map(mode => `
                <button class="mode-btn ${mode === this.viewMode ? 'active' : ''}"
                        data-mode="${mode}"
                        title="${this.getModeDescription(mode)}">
                  ${this.getModeIcon(mode)}
                </button>
              `).join('')}
              <button class="mode-lock-btn ${this.modeLocked ? 'locked' : ''}"
                      title="Lock mode">
                ${this.modeLocked ? '🔒' : '🔓'}
              </button>
            </div>
          </div>
        </div>
        
        <div class="header-stats">
          <div class="stat">
            <span class="stat-icon">${template.icon}</span>
            <span class="stat-value">${template.name}</span>
          </div>
          <div class="stat">
            <span class="stat-icon">📝</span>
            <span class="stat-value">${this.words.length}</span>
            <span class="stat-label">words</span>
          </div>
          <div class="stat">
            <span class="stat-icon">📍</span>
            <span class="stat-value">${this.markers.length}</span>
            <span class="stat-label">markers</span>
          </div>
          <div class="stat">
            <span class="stat-icon">⏱️</span>
            <span class="stat-value">${this.formatTime(runningTime)}</span>
          </div>
          <div class="stat">
            <span class="stat-icon">👥</span>
            <span class="stat-value">${this.speakers.length}</span>
            <span class="stat-label">speakers</span>
          </div>
        </div>
        
        ${this.pendingInPoint !== null ? `
          <div class="pending-range-indicator">
            ◀ IN: ${this.formatTimecode(this.pendingInPoint)} - Waiting for OUT point...
          </div>
        ` : ''}
      </div>
    `;
  }

  /**
   * Render spotting mode (minimal UI for marking while watching)
   * @param {Object} template - Current template
   * @returns {string} HTML
   */
  renderSpottingMode(template) {
    return `
      <div class="linescript-spotting-mode">
        <div class="spotting-timecode">
          <span class="timecode-current">${this.formatTimecode(this.currentTime)}</span>
          <span class="timecode-total">/ ${this.formatTimecode(this.words.length > 0 ? this.words[this.words.length - 1].end : 0)}</span>
        </div>
        
        <div class="spotting-transcript">
          ${this.renderScrollingTranscript(template)}
        </div>
        
        <div class="spotting-markers-preview">
          ${this.renderMiniMarkerTimeline(template)}
        </div>
        
        <div class="spotting-shortcuts">
          <div class="shortcut-group">
            <span class="shortcut-label">Quick Marks:</span>
            ${Object.entries(template.keyboardShortcuts).slice(0, 4).map(([key, config]) => `
              <span class="shortcut-key" title="${config.label}">
                <kbd>${key.toUpperCase()}</kbd>
              </span>
            `).join('')}
          </div>
          <div class="shortcut-group">
            <span class="shortcut-label">Range:</span>
            <span class="shortcut-key"><kbd>I</kbd> In</span>
            <span class="shortcut-key"><kbd>O</kbd> Out</span>
          </div>
          <div class="shortcut-group">
            <span class="shortcut-key"><kbd>Space</kbd> Play/Pause</span>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Render scrolling transcript for spotting mode
   * @param {Object} template - Current template
   * @returns {string} HTML
   */
  renderScrollingTranscript(template) {
    const currentWordIdx = this.findWordIndexAtTime(this.currentTime);
    const contextWords = 15;
    const startIdx = Math.max(0, currentWordIdx - contextWords);
    const endIdx = Math.min(this.words.length, currentWordIdx + contextWords);
    
    // Track the rendered range to avoid unnecessary re-renders
    this.renderedRangeStart = startIdx;
    this.renderedRangeEnd = endIdx;
    this.highlightedWordIndex = currentWordIdx;
    
    const visibleWords = this.words.slice(startIdx, endIdx);
    
    return `
      <div class="scrolling-transcript">
        ${visibleWords.map((word, idx) => {
          const absoluteIdx = startIdx + idx;
          const isCurrent = absoluteIdx === currentWordIdx;
          const isPast = absoluteIdx < currentWordIdx;
          const marker = this.getMarkerAtTime(word.start);
          
          return `
            <span class="transcript-word ${isCurrent ? 'current' : ''} ${isPast ? 'past' : ''}"
                  data-word-idx="${absoluteIdx}"
                  data-time="${word.start}"
                  ${marker ? `style="border-bottom: 2px solid ${marker.color}"` : ''}>
              ${this.escapeHtml(word.text)}
            </span>
          `;
        }).join(' ')}
      </div>
    `;
  }

  /**
   * Render mini marker timeline
   * @param {Object} template - Current template
   * @returns {string} HTML
   */
  renderMiniMarkerTimeline(template) {
    const totalDuration = this.words.length > 0 ? this.words[this.words.length - 1].end : 1;
    
    return `
      <div class="mini-timeline">
        <div class="timeline-track">
          ${this.markers.map(marker => {
            const position = ((marker.type === 'range' ? marker.inTime : marker.time) / totalDuration) * 100;
            const width = marker.type === 'range' ? ((marker.outTime - marker.inTime) / totalDuration) * 100 : 0.5;
            
            return `
              <div class="timeline-marker ${marker.type}"
                   style="left: ${position}%; width: ${width}%; background: ${marker.color || template.primaryColor}"
                   title="${marker.name}">
              </div>
            `;
          }).join('')}
          <div class="timeline-playhead" style="left: ${(this.currentTime / totalDuration) * 100}%"></div>
        </div>
      </div>
    `;
  }

  /**
   * Render edit mode (full controls for editing markers)
   * @param {Object} template - Current template
   * @returns {string} HTML
   */
  renderEditMode(template) {
    return `
      <div class="linescript-edit-mode">
        <div class="edit-sidebar">
          <div class="marker-types-panel">
            <h3>Marker Types</h3>
            <div class="marker-type-buttons">
              ${template.markerTypes.map(mt => `
                <button class="marker-type-btn" 
                        data-marker-type="${mt.id}"
                        style="--marker-color: ${mt.color}">
                  <span class="marker-icon">${mt.icon}</span>
                  <span class="marker-name">${mt.name}</span>
                </button>
              `).join('')}
            </div>
          </div>
          
          <div class="markers-list-panel">
            <h3>Markers (${this.markers.length})</h3>
            <div class="markers-list">
              ${this.markers.map(marker => this.renderMarkerListItem(marker, template)).join('')}
            </div>
          </div>
        </div>
        
        <div class="edit-main">
          ${this.renderScreenplayFormat(template)}
        </div>
      </div>
    `;
  }

  /**
   * Render screenplay format content
   * @param {Object} template - Current template
   * @returns {string} HTML
   */
  renderScreenplayFormat(template) {
    let html = '<div class="screenplay-content">';
    let lineNumber = 1;
    let sceneNumber = 0;
    let lastMarkerId = null;
    
    this.dialogueBlocks.forEach((block, blockIdx) => {
      const blockTime = block.startTime;
      
      // Check for scene marker
      const sceneMarker = this.getMarkerAtTime(blockTime);
      if (sceneMarker && sceneMarker.type === 'range' && sceneMarker.id !== lastMarkerId) {
        sceneNumber++;
        html += this.renderSceneHeader(sceneMarker, sceneNumber, template);
        lastMarkerId = sceneMarker.id;
      }
      
      // Render speaker cue
      if (block.speaker) {
        html += this.renderSpeakerCue(block.speaker, lineNumber, template);
        lineNumber++;
      }
      
      // Render dialogue lines
      const lines = this.splitTextIntoLines(block.text, template.ui.dialogueWidth === 'wide' ? 70 : 50);
      lines.forEach((lineText, lineIdx) => {
        const lineTime = this.interpolateTime(block, lineIdx, lines.length);
        html += this.renderDialogueLine(lineNumber, lineTime, lineText, block.speaker, template);
        lineNumber++;
      });
      
      html += '<div class="block-spacer"></div>';
    });
    
    html += '</div>';
    return html;
  }

  /**
   * Render scene header
   * @param {Object} marker - Scene marker
   * @param {number} sceneNumber - Scene number
   * @param {Object} template - Current template
   * @returns {string} HTML
   */
  renderSceneHeader(marker, sceneNumber, template) {
    const duration = (marker.outTime - marker.inTime).toFixed(1);
    
    return `
      <div class="scene-header" data-marker-id="${marker.id}" style="--scene-color: ${marker.color}">
        <div class="scene-slugline">
          <span class="scene-number">${sceneNumber}</span>
          <span class="scene-name">${this.escapeHtml(marker.name || 'Scene')}</span>
          <span class="scene-duration">${duration}s</span>
        </div>
        <div class="scene-timecode">
          ${this.formatTimecode(marker.inTime)} → ${this.formatTimecode(marker.outTime)}
        </div>
        ${marker.description ? `<div class="scene-description">${this.escapeHtml(marker.description)}</div>` : ''}
      </div>
    `;
  }

  /**
   * Render speaker cue
   * @param {string} speaker - Speaker name
   * @param {number} lineNumber - Line number
   * @param {Object} template - Current template
   * @returns {string} HTML
   */
  renderSpeakerCue(speaker, lineNumber, template) {
    const speakerIdx = this.speakers.indexOf(speaker);
    const speakerClass = speakerIdx >= 0 ? `speaker-${speakerIdx % 6}` : '';
    
    return `
      <div class="speaker-cue ${speakerClass}" data-line="${lineNumber}">
        <span class="speaker-avatar">${speaker.charAt(0).toUpperCase()}</span>
        <span class="speaker-name">${this.escapeHtml(speaker)}</span>
      </div>
    `;
  }

  /**
   * Render dialogue line
   * @param {number} lineNumber - Line number
   * @param {number} time - Time in seconds
   * @param {string} text - Line text
   * @param {string} speaker - Speaker name
   * @param {Object} template - Current template
   * @returns {string} HTML
   */
  renderDialogueLine(lineNumber, time, text, speaker, template) {
    const speakerIdx = speaker ? this.speakers.indexOf(speaker) : -1;
    const speakerClass = speakerIdx >= 0 ? `speaker-${speakerIdx % 6}` : '';
    const marker = this.getMarkerAtTime(time);
    const markerStyle = marker ? `border-left: 3px solid ${marker.color}` : '';
    
    return `
      <div class="dialogue-line ${speakerClass}" data-line="${lineNumber}" data-time="${time}" style="${markerStyle}">
        <span class="line-number">${lineNumber}</span>
        <span class="line-timecode">${this.formatTimecode(time)}</span>
        <span class="line-text">${this.escapeHtml(text)}</span>
      </div>
    `;
  }

  /**
   * Render marker list item
   * @param {Object} marker - Marker object
   * @param {Object} template - Current template
   * @returns {string} HTML
   */
  renderMarkerListItem(marker, template) {
    const time = marker.type === 'range' ? marker.inTime : marker.time;
    const markerTypeDef = template.markerTypes.find(m => m.id === marker.markerType);
    const icon = markerTypeDef?.icon || '📍';
    
    return `
      <div class="marker-list-item" data-marker-id="${marker.id}" style="--marker-color: ${marker.color}">
        <span class="marker-icon">${icon}</span>
        <span class="marker-name">${this.escapeHtml(marker.name || 'Marker')}</span>
        <span class="marker-time">${this.formatTimecode(time)}</span>
        <button class="marker-goto-btn" data-time="${time}" title="Go to">▶</button>
        <button class="marker-delete-btn" data-marker-id="${marker.id}" title="Delete">✕</button>
      </div>
    `;
  }

  /**
   * Render review mode
   * @param {Object} template - Current template
   * @returns {string} HTML
   */
  renderReviewMode(template) {
    return `
      <div class="linescript-review-mode">
        <h3>Review Markers</h3>
        <div class="review-grid">
          ${this.markers.map(marker => this.renderReviewCard(marker, template)).join('')}
        </div>
        ${this.markers.length === 0 ? '<p class="empty-message">No markers to review. Add markers in Spotting or Edit mode.</p>' : ''}
      </div>
    `;
  }

  /**
   * Render review card for a marker
   * @param {Object} marker - Marker object
   * @param {Object} template - Current template
   * @returns {string} HTML
   */
  renderReviewCard(marker, template) {
    const time = marker.type === 'range' ? marker.inTime : marker.time;
    const duration = marker.type === 'range' ? (marker.outTime - marker.inTime).toFixed(1) + 's' : '';
    const transcript = this.getTranscriptForTime(time, marker.type === 'range' ? marker.outTime : time + 5);
    
    return `
      <div class="review-card" data-marker-id="${marker.id}" style="--card-color: ${marker.color}">
        <div class="card-header">
          <span class="card-name">${this.escapeHtml(marker.name || 'Marker')}</span>
          <span class="card-time">${this.formatTimecode(time)} ${duration}</span>
        </div>
        <div class="card-preview">
          <div class="card-thumbnail" data-time="${time}">▶</div>
          <div class="card-transcript">${this.escapeHtml(transcript.slice(0, 100))}${transcript.length > 100 ? '...' : ''}</div>
        </div>
        <div class="card-actions">
          <button class="card-btn play" data-time="${time}">▶ Play</button>
          <button class="card-btn edit" data-marker-id="${marker.id}">✏️ Edit</button>
          <button class="card-btn export" data-marker-id="${marker.id}">📤 Export</button>
        </div>
      </div>
    `;
  }

  /**
   * Render export mode
   * @param {Object} template - Current template
   * @returns {string} HTML
   */
  renderExportMode(template) {
    // Get export formats from the ExportPresets module if available
    const formats = this.app?.app?.EXPORT_FORMATS?.[this.currentTemplate] || {};
    const formatList = Object.values(formats).length > 0 
      ? Object.values(formats)
      : template.exports || [];
    
    return `
      <div class="linescript-export-mode" id="lineScriptExportView">
        <h3>Export Options</h3>
        <div class="export-formats" id="lineScriptExportFormats">
          ${formatList.map(exp => `
            <button class="export-btn" data-format="${exp.id}">
              <span class="export-icon">${exp.icon}</span>
              <span class="export-name">${exp.name}</span>
              <span class="export-format">.${exp.extension || exp.format || 'txt'}</span>
            </button>
          `).join('')}
        </div>
        
        <div class="export-preview">
          <h4>Preview</h4>
          <pre class="export-preview-content" id="lineScriptExportPreview">Select an export format to preview...</pre>
        </div>
        
        <div class="export-actions">
          <button class="btn btn-primary export-download" onclick="app?.exportLineScript?.(app?._selectedExportFormat)">
            📥 Download Export
          </button>
          <button class="btn btn-secondary export-copy" onclick="app?.copyLineScriptToClipboard?.(app?._selectedExportFormat)">
            📋 Copy to Clipboard
          </button>
          <button class="btn btn-ghost export-all" onclick="app?.exportAllFormats?.()">
            📦 Export All Formats
          </button>
        </div>
      </div>
    `;
  }

  /**
   * Generate export preview
   * @param {Object} exportFormat - Export format config
   * @returns {string} Preview content
   */
  generateExportPreview(exportFormat) {
    if (!exportFormat) return 'Select an export format...';
    
    switch (exportFormat.id) {
      case 'youtube-chapters':
        return this.markers
          .filter(m => m.type === 'range' || m.type === 'spot')
          .map(m => `${this.formatTimecode(m.type === 'range' ? m.inTime : m.time).replace(/\.\d$/, '')} ${m.name}`)
          .join('\n');
      
      case 'show-notes':
        return this.generateShowNotes();
      
      default:
        return JSON.stringify(this.markers.slice(0, 3), null, 2) + '\n...';
    }
  }

  /**
   * Generate show notes markdown
   * @returns {string} Show notes markdown
   */
  generateShowNotes() {
    let notes = `# Episode Notes\n\n`;
    notes += `## Timestamps\n\n`;
    
    this.markers.forEach(m => {
      const time = m.type === 'range' ? m.inTime : m.time;
      notes += `- ${this.formatTimecode(time).replace(/\.\d$/, '')} - ${m.name}\n`;
    });
    
    return notes;
  }

  /**
   * Render empty state
   * @returns {string} HTML
   */
  renderEmptyState() {
    return `
      <div class="linescript-empty">
        <div class="empty-icon">📝</div>
        <div class="empty-title">No Script Available</div>
        <div class="empty-text">
          Load a video with a transcript or transcribe the current video to get started.
        </div>
        <button class="btn-primary" onclick="app.transcribeForWaveform?.()">
          🎤 Transcribe Video
        </button>
      </div>
    `;
  }

  /**
   * Render footer
   * @param {Object} template - Current template
   * @returns {string} HTML
   */
  renderFooter(template) {
    return `
      <div class="linescript-footer">
        <div class="footer-controls">
          <label class="auto-scroll-toggle">
            <input type="checkbox" id="autoScrollToggle" ${this.autoScroll ? 'checked' : ''}>
            Auto-scroll
          </label>
          
          <button class="btn-sm ai-generate-btn" ${this.aiGenerating ? 'disabled' : ''}>
            ${this.aiGenerating ? '⏳ Generating...' : '🤖 Generate AI Metadata'}
          </button>
        </div>
        
        <div class="footer-info">
          <span>Template: ${template.name}</span>
          <span>•</span>
          <span>Mode: ${this.viewMode}</span>
        </div>
      </div>
    `;
  }

  /**
   * Attach event listeners after render
   */
  attachEventListeners() {
    // Template selector buttons
    this.container.querySelectorAll('.template-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.setTemplate(btn.dataset.template);
      });
    });
    
    // Mode buttons
    this.container.querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.setViewMode(btn.dataset.mode);
      });
    });
    
    // Mode lock button
    this.container.querySelector('.mode-lock-btn')?.addEventListener('click', () => {
      this.lockMode(!this.modeLocked);
    });
    
    // Auto-scroll toggle
    this.container.querySelector('#autoScrollToggle')?.addEventListener('change', (e) => {
      this.autoScroll = e.target.checked;
    });
    
    // Marker type buttons (edit mode)
    this.container.querySelectorAll('.marker-type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const markerType = btn.dataset.markerType;
        this.addMarker('spot', this.currentTime, { markerType });
      });
    });
    
    // Marker goto buttons
    this.container.querySelectorAll('.marker-goto-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const time = parseFloat(btn.dataset.time);
        this.seekToTime(time);
      });
    });
    
    // Marker delete buttons
    this.container.querySelectorAll('.marker-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const markerId = parseInt(btn.dataset.markerId);
        this.deleteMarker(markerId);
      });
    });
    
    // AI generate button
    this.container.querySelector('.ai-generate-btn')?.addEventListener('click', () => {
      this.emit('generateAIMetadata');
    });
    
    // Export buttons
    this.container.querySelectorAll('.export-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.handleExport(btn.dataset.format);
      });
    });
    
    // Word click for seeking
    this.container.querySelectorAll('.transcript-word, .dialogue-line').forEach(el => {
      el.addEventListener('click', () => {
        const time = parseFloat(el.dataset.time);
        if (!isNaN(time)) {
          this.seekToTime(time);
        }
      });
    });
  }

  /**
   * Delete a marker
   * @param {number} markerId - Marker ID
   */
  deleteMarker(markerId) {
    if (this.app.markerManager) {
      this.app.markerManager.deleteMarker(markerId);
      this.loadMarkers();
      this.showToast('Marker deleted', 'info');
    }
  }

  /**
   * Seek to a specific time
   * @param {number} time - Time in seconds
   */
  seekToTime(time) {
    const video = this.getVideo();
    if (video) {
      video.currentTime = time;
    }
    if (this.app.seekToTime) {
      this.app.seekToTime(time);
    }
    // Also try main app's seekTo helper
    if (this.app.seekTo) {
      this.app.seekTo(time);
    }
  }

  /**
   * Handle export action
   * @param {string} formatId - Export format ID
   */
  handleExport(formatId) {
    // Use app's export function if available
    if (this.app?.app?.previewExport) {
      this.app.app.previewExport(formatId, this.currentTemplate);
      this.app.app._selectedExportFormat = formatId;
    } else {
      this.emit('export', { formatId, markers: this.markers });
      this.showToast(`Exporting as ${formatId}...`, 'info');
    }
  }

  /**
   * Export current format
   */
  exportCurrent() {
    const formatId = this.app?.app?._selectedExportFormat || 'youtube-chapters';
    if (this.app?.app?.exportLineScript) {
      this.app.app.exportLineScript(formatId, this.currentTemplate);
    } else {
      this.emit('export', { formatId, markers: this.markers });
    }
  }

  /**
   * Copy current export to clipboard
   */
  copyToClipboard() {
    const formatId = this.app?.app?._selectedExportFormat || 'youtube-chapters';
    if (this.app?.app?.copyLineScriptToClipboard) {
      this.app.app.copyLineScriptToClipboard(formatId, this.currentTemplate);
    } else {
      // Fallback to basic copy
      const content = this.generateExportPreview({ id: formatId });
      navigator.clipboard?.writeText(content);
      this.showToast('Copied to clipboard', 'success');
    }
  }

  // Utility methods
  
  /**
   * Find word index at a given time
   * @param {number} time - Time in seconds
   * @returns {number} Word index
   */
  findWordIndexAtTime(time) {
    return this.words.findIndex(w => w.start <= time && w.end >= time);
  }

  /**
   * Get marker at a given time
   * @param {number} time - Time in seconds
   * @returns {Object|null} Marker or null
   */
  getMarkerAtTime(time) {
    return this.markers.find(m => {
      if (m.type === 'range') {
        return time >= m.inTime && time <= m.outTime;
      }
      return Math.abs((m.time || 0) - time) < 1;
    });
  }

  /**
   * Get transcript text for a time range
   * @param {number} startTime - Start time
   * @param {number} endTime - End time
   * @returns {string} Transcript text
   */
  getTranscriptForTime(startTime, endTime) {
    return this.words
      .filter(w => w.start >= startTime && w.end <= endTime)
      .map(w => w.text)
      .join(' ');
  }

  /**
   * Update word highlighting
   */
  updateWordHighlight() {
    const currentIdx = this.findWordIndexAtTime(this.currentTime);
    if (currentIdx === this.highlightedWordIndex) {
      return; // No change needed
    }
    
    // Check if current word is within the rendered range
    const isInRange = currentIdx >= this.renderedRangeStart && currentIdx < this.renderedRangeEnd;
    
    if (!isInRange && this.viewMode === VIEW_MODES.SPOTTING && this.words.length > 0) {
      // Current word is outside visible range - re-render the transcript
      const transcriptContainer = this.container?.querySelector('.spotting-transcript');
      if (transcriptContainer) {
        const template = this.contentTemplates.getCurrent();
        transcriptContainer.innerHTML = this.renderScrollingTranscript(template);
        // Re-attach click listeners for the new words
        transcriptContainer.querySelectorAll('.transcript-word').forEach(el => {
          el.addEventListener('click', () => {
            const time = parseFloat(el.dataset.time);
            if (!isNaN(time)) {
              this.seekToTime(time);
            }
          });
        });
      }
      return; // Already highlighted by re-render
    }
    
    // Update highlight in DOM
    this.container?.querySelectorAll('.transcript-word.current')?.forEach(el => {
      el.classList.remove('current');
    });
    
    // Also update past words
    this.container?.querySelectorAll('.transcript-word')?.forEach(el => {
      const wordIdx = parseInt(el.dataset.wordIdx);
      if (wordIdx < currentIdx) {
        el.classList.add('past');
      } else {
        el.classList.remove('past');
      }
    });
    
    const currentWord = this.container?.querySelector(`[data-word-idx="${currentIdx}"]`);
    if (currentWord) {
      currentWord.classList.add('current');
    }
    
    this.highlightedWordIndex = currentIdx;
  }

  /**
   * Scroll to current time
   * Only scrolls if the current word is outside the visible area
   */
  scrollToCurrentTime() {
    const currentWord = this.container?.querySelector('.transcript-word.current');
    if (!currentWord) return;
    
    // Find the scrolling container - use the spotting transcript or content area
    const scrollContainer = this.container?.querySelector('.spotting-transcript') || 
                           this.container?.querySelector('.scrolling-transcript')?.parentElement ||
                           this.contentArea;
    
    if (!scrollContainer) return;
    
    // Get the container's visible bounds
    const containerRect = scrollContainer.getBoundingClientRect();
    const wordRect = currentWord.getBoundingClientRect();
    
    // Check if the word is already visible within the container
    const isVisible = wordRect.top >= containerRect.top &&
                     wordRect.bottom <= containerRect.bottom &&
                     wordRect.left >= containerRect.left &&
                     wordRect.right <= containerRect.right;
    
    // Only scroll if the word is not visible
    if (!isVisible) {
      // Use scrollIntoView with 'nearest' to minimize scrolling
      currentWord.scrollIntoView({ 
        behavior: 'smooth', 
        block: 'nearest',
        inline: 'nearest'
      });
    }
  }

  /**
   * Update timecode display
   */
  updateTimecodeDisplay() {
    const timecodeEl = this.container?.querySelector('.timecode-current');
    if (timecodeEl) {
      timecodeEl.textContent = this.formatTimecode(this.currentTime);
    }
  }

  /**
   * Update pending range UI
   */
  updatePendingRangeUI() {
    const indicator = this.container?.querySelector('.pending-range-indicator');
    if (indicator) {
      if (this.pendingInPoint !== null) {
        indicator.style.display = 'block';
        indicator.innerHTML = `◀ IN: ${this.formatTimecode(this.pendingInPoint)} - Waiting for OUT point...`;
      } else {
        indicator.style.display = 'none';
      }
    }
  }

  /**
   * Update mode UI
   */
  updateModeUI() {
    // Re-render is simpler than DOM manipulation
    this.render();
  }

  /**
   * Split text into lines
   * @param {string} text - Text to split
   * @param {number} maxChars - Max characters per line
   * @returns {Array<string>} Lines
   */
  splitTextIntoLines(text, maxChars = 50) {
    const words = text.split(/\s+/);
    const lines = [];
    let currentLine = [];
    let currentLength = 0;
    
    words.forEach(word => {
      if (currentLength + word.length + 1 > maxChars && currentLine.length > 0) {
        lines.push(currentLine.join(' '));
        currentLine = [word];
        currentLength = word.length;
      } else {
        currentLine.push(word);
        currentLength += word.length + 1;
      }
    });
    
    if (currentLine.length > 0) {
      lines.push(currentLine.join(' '));
    }
    
    return lines;
  }

  /**
   * Interpolate time within a block
   * @param {Object} block - Dialogue block
   * @param {number} lineIdx - Line index
   * @param {number} totalLines - Total lines
   * @returns {number} Interpolated time
   */
  interpolateTime(block, lineIdx, totalLines) {
    const duration = block.endTime - block.startTime;
    return block.startTime + (duration * lineIdx / totalLines);
  }

  /**
   * Format time as HH:MM:SS
   * @param {number} seconds - Seconds
   * @returns {string} Formatted time
   */
  formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '00:00:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  /**
   * Format timecode as MM:SS.f
   * @param {number} seconds - Seconds
   * @returns {string} Formatted timecode
   */
  formatTimecode(seconds) {
    if (!seconds || isNaN(seconds)) return '00:00.0';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const f = Math.floor((seconds % 1) * 10);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${f}`;
  }

  /**
   * Escape HTML entities
   * @param {string} text - Text to escape
   * @returns {string} Escaped text
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  /**
   * Get mode icon
   * @param {string} mode - View mode
   * @returns {string} Icon
   */
  getModeIcon(mode) {
    const icons = {
      [VIEW_MODES.SPOTTING]: '🎯',
      [VIEW_MODES.EDIT]: '✏️',
      [VIEW_MODES.REVIEW]: '👁️',
      [VIEW_MODES.EXPORT]: '📤'
    };
    return icons[mode] || '📝';
  }

  /**
   * Get mode description
   * @param {string} mode - View mode
   * @returns {string} Description
   */
  getModeDescription(mode) {
    const descriptions = {
      [VIEW_MODES.SPOTTING]: 'Mark points while watching video',
      [VIEW_MODES.EDIT]: 'Edit marker details and metadata',
      [VIEW_MODES.REVIEW]: 'Review and preview markers',
      [VIEW_MODES.EXPORT]: 'Export markers and content'
    };
    return descriptions[mode] || '';
  }

  /**
   * Show toast notification
   * @param {string} message - Message
   * @param {string} type - Type (success, info, warning, error)
   */
  showToast(message, type = 'info') {
    if (this.app.showToast) {
      this.app.showToast(type, message);
    } else {
      console.log(`[LineScriptPanel] ${type}: ${message}`);
    }
  }

  // Event emitter methods
  
  /**
   * Subscribe to an event
   * @param {string} event - Event name
   * @param {Function} callback - Callback function
   */
  on(event, callback) {
    if (!this.eventListeners[event]) {
      this.eventListeners[event] = [];
    }
    this.eventListeners[event].push(callback);
  }

  /**
   * Emit an event
   * @param {string} event - Event name
   * @param {Object} data - Event data
   */
  emit(event, data = {}) {
    if (this.eventListeners[event]) {
      this.eventListeners[event].forEach(callback => callback(data));
    }
  }

  /**
   * Unsubscribe from an event
   * @param {string} event - Event name
   * @param {Function} callback - Callback function
   */
  off(event, callback) {
    if (this.eventListeners[event]) {
      this.eventListeners[event] = this.eventListeners[event].filter(cb => cb !== callback);
    }
  }

  /**
   * Called when video metadata is loaded
   * @param {Object} data - Video data with duration and path
   */
  onVideoLoaded(data) {
    console.log('[LineScriptPanel] Video loaded:', data);
    // Reload transcript data when video loads
    this.loadTranscriptData();
    if (this.visible) {
      this.render();
    }
  }

  /**
   * Called on video time update - alias for handleTimeUpdate
   * @param {number} time - Current video time in seconds
   */
  onTimeUpdate(time) {
    this.currentTime = time;
    this.updateWordHighlight();
    if (this.autoScroll && this.isPlaying) {
      this.scrollToCurrentTime();
    }
    this.updateTimecodeDisplay();
  }

  /**
   * Called on playback state change - alias for handlePlayStateChange
   * @param {boolean} playing - Whether video is playing
   */
  onPlaybackStateChange(playing) {
    this.isPlaying = playing;
    if (playing && !this.modeLocked) {
      this.setViewMode(VIEW_MODES.SPOTTING);
    }
  }

  /**
   * Called when a marker is added
   * @param {Object} marker - The added marker
   */
  onMarkerAdded(marker) {
    this.loadMarkers();
    this.showMarkerFeedback(marker);
  }

  /**
   * Called when a marker is updated
   * @param {Object} marker - The updated marker
   */
  onMarkerUpdated(marker) {
    this.loadMarkers();
  }

  /**
   * Called when a marker is deleted
   * @param {string|number} markerId - The deleted marker's ID
   */
  onMarkerDeleted(markerId) {
    this.loadMarkers();
  }

  /**
   * Load transcript - alias for loadTranscriptData for compatibility
   * @param {Object} data - Optional transcript data (ignored, always loads from app)
   */
  loadTranscript(data) {
    // Always reload from the main app to get live data
    this.loadTranscriptData();
    if (this.visible) {
      this.render();
    }
  }

  /**
   * Sync words - alias for loadTranscriptData for compatibility
   * @param {Array} words - Words array (ignored, always loads from app)
   */
  syncWords(words) {
    // Always reload from the main app to get live data
    this.loadTranscriptData();
    if (this.visible) {
      this.render();
    }
  }

  /**
   * Refresh the panel
   */
  refresh() {
    this.loadTranscriptData();
    this.loadMarkers();
    this.render();
  }

  /**
   * Destroy the panel and cleanup
   */
  destroy() {
    // Remove event listeners
    const video = this.getVideo();
    if (video) {
      video.removeEventListener('timeupdate', this.handleTimeUpdate);
      if (this._boundHandlePlay) {
        video.removeEventListener('play', this._boundHandlePlay);
      }
      if (this._boundHandlePause) {
        video.removeEventListener('pause', this._boundHandlePause);
      }
    }
    document.removeEventListener('keydown', this.handleKeyDown);
    
    // Clear bound handlers
    this._boundHandlePlay = null;
    this._boundHandlePause = null;
    
    // Clear state
    this.eventListeners = {};
    this.visible = false;
  }
}

export default LineScriptPanel;











