/**
 * StoryBeatsEditor - Comprehensive Line Script Editor
 * 
 * Full screenplay/lined script format with:
 * - Multiple templates (Podcast, Learning, Promo, Highlight, Dynamic)
 * - Scene headers (INT/EXT, location, time of day)
 * - Character cues and dialogue
 * - Action/stage directions
 * - Parentheticals (actor direction)
 * - Coverage tracking (vertical lines, shot designations)
 * - Take information and circle takes
 * - Director's notes and script supervisor notes
 * - Technical info (camera, sound, lighting)
 * - Timing (scene duration, running time)
 * - Editorial guidance (cut points, sync refs)
 */

// LINE SCRIPT TEMPLATES
const LINE_SCRIPT_TEMPLATES = {
  podcast: {
    id: 'podcast',
    name: 'Podcast',
    icon: '🎙️',
    description: 'Interview/conversation format with speaker turns',
    config: {
      showIntExt: false,
      showTimeOfDay: false,
      showCoverage: false,
      showTechnical: false,
      showTakes: false,
      sceneLabel: 'SEGMENT',
      speakerStyle: 'conversation',  // Side-by-side speaker labels
      showTimecodes: true,
      showRunningTime: true,
      showWordCount: true,
      emphasisElements: ['speakers', 'timing', 'topics'],
      dialogueWidth: 'wide',
    }
  },
  learning: {
    id: 'learning',
    name: 'Learning Video',
    icon: '📚',
    description: 'Educational content with chapters and key points',
    config: {
      showIntExt: false,
      showTimeOfDay: false,
      showCoverage: false,
      showTechnical: false,
      showTakes: false,
      sceneLabel: 'CHAPTER',
      speakerStyle: 'instructor',  // Single speaker with content blocks
      showTimecodes: true,
      showRunningTime: true,
      showKeyPoints: true,
      showObjectives: true,
      emphasisElements: ['chapters', 'keyPoints', 'duration'],
      dialogueWidth: 'medium',
    }
  },
  promo: {
    id: 'promo',
    name: 'Promotional Video',
    icon: '📣',
    description: 'Marketing/commercial format with shots and hooks',
    config: {
      showIntExt: true,
      showTimeOfDay: true,
      showCoverage: true,
      showTechnical: true,
      showTakes: true,
      sceneLabel: 'SHOT',
      speakerStyle: 'voiceover',  // VO labels
      showTimecodes: true,
      showRunningTime: true,
      showHooks: true,
      showCTA: true,
      emphasisElements: ['visuals', 'hooks', 'cta', 'branding'],
      dialogueWidth: 'narrow',
    }
  },
  highlight: {
    id: 'highlight',
    name: 'Highlight Reel',
    icon: '🎬',
    description: 'Best moments compilation with timestamps',
    config: {
      showIntExt: false,
      showTimeOfDay: false,
      showCoverage: true,
      showTechnical: false,
      showTakes: false,
      sceneLabel: 'HIGHLIGHT',
      speakerStyle: 'minimal',  // Just timestamps and content
      showTimecodes: true,
      showRunningTime: true,
      showMomentType: true,  // Best quote, funny, dramatic, etc.
      showSource: true,  // Original source reference
      emphasisElements: ['moments', 'impact', 'timing'],
      dialogueWidth: 'wide',
    }
  },
  dynamic: {
    id: 'dynamic',
    name: 'Dynamic Learning',
    icon: '⚡',
    description: 'Story beats list with interactive checkpoints',
    config: {
      showIntExt: false,
      showTimeOfDay: false,
      showCoverage: false,
      showTechnical: false,
      showTakes: false,
      sceneLabel: 'BEAT',
      speakerStyle: 'beat',  // Story beat format
      showTimecodes: true,
      showRunningTime: true,
      showCheckpoints: true,
      showQuizPoints: true,
      showInteractivity: true,
      emphasisElements: ['beats', 'checkpoints', 'engagement'],
      dialogueWidth: 'medium',
      listView: true,  // Compact list of beats
    }
  }
};

export class StoryBeatsEditor {
  constructor(appContext) {
    this.app = appContext;
    
    // Template state
    this.templates = LINE_SCRIPT_TEMPLATES;
    this.selectedTemplate = 'podcast';  // Default template
    
    // Core transcript state
    this.words = [];           // Words with timing from transcript
    this.markers = [];         // Markers/story beats (drive scenes)
    this.dialogueBlocks = [];  // Parsed dialogue with speakers
    this.speakers = [];        // Identified speakers
    this.selection = null;     // Current text selection
    this.edits = [];           // Pending edits queue
    this.visible = false;
    
    // Script metadata state
    this.scriptTitle = '';
    this.scriptRevision = 'WHITE';  // Revision color
    this.scriptDate = new Date().toISOString().split('T')[0];
    this.pageNumber = 1;
    this.runningTime = 0;
    
    // Scene-level notes (keyed by marker ID)
    this.sceneNotes = {};      // { markerId: { location, timeOfDay, intExt, description } }
    this.directorNotes = {};   // { markerId: [{ note, timestamp }] }
    this.supervisorNotes = {}; // { markerId: [{ type, note, timestamp }] }
    
    // Coverage tracking
    this.coverage = {};        // { markerId: [{ shotId, setup, startTime, endTime, covered }] }
    this.takes = {};           // { markerId: [{ takeNum, circled, print, notes, duration }] }
    
    // Technical notes
    this.technicalNotes = {};  // { markerId: { camera, lens, lighting, sound } }
    
    // Editorial guidance
    this.editorialNotes = {};  // { markerId: [{ cutPoint, syncRef, vfxNote }] }
    
    // DOM references
    this.container = null;
    this.editorContent = null;
    this.toolbar = null;
    this.miniTimeline = null;
    
    // Bind methods
    this.handleWordClick = this.handleWordClick.bind(this);
    this.handleWordMouseDown = this.handleWordMouseDown.bind(this);
    this.handleWordMouseUp = this.handleWordMouseUp.bind(this);
    this.handleDocumentMouseUp = this.handleDocumentMouseUp.bind(this);
    this.clearSelection = this.clearSelection.bind(this);
  }

  /**
   * Get current template configuration
   */
  getTemplate() {
    return this.templates[this.selectedTemplate] || this.templates.podcast;
  }

  /**
   * Set selected template and re-render
   */
  setTemplate(templateId) {
    if (this.templates[templateId]) {
      this.selectedTemplate = templateId;
      this.render();
      console.log('[LineScript] Template changed to:', templateId);
    }
  }

  /**
   * Initialize the editor
   */
  init() {
    this.container = document.getElementById('storyBeatsEditorContainer');
    this.editorContent = document.getElementById('storyBeatsEditorContent');
    
    if (!this.container || !this.editorContent) {
      console.warn('[StoryBeatsEditor] Container not found');
      return;
    }
    
    // Load transcript data with speaker identification
    this.loadTranscriptWithSpeakers();
    
    // Load markers (these drive scene headers)
    this.loadMarkers();
    
    // Parse dialogue blocks from transcript
    this.parseDialogueBlocks();
    
    // Render the editor
    this.render();
    
    // Setup event listeners
    this.setupEventListeners();
    
    console.log('[StoryBeatsEditor] Initialized:', this.words.length, 'words,', 
                this.markers.length, 'scenes,', this.speakers.length, 'speakers');
  }

  /**
   * Load transcript with speaker identification
   */
  loadTranscriptWithSpeakers() {
    // Try to get speaker-identified transcript first
    if (this.app.teleprompterWords?.length > 0) {
      this.words = [...this.app.teleprompterWords];
    } else if (this.app.transcriptSegments?.length > 0) {
      this.words = this.expandTranscriptToWords(this.app.transcriptSegments);
    } else {
      this.words = [];
    }
    
    // Load speaker list from metadata if available
    this.speakers = this.app.speakers || [];
    
    // Check if we have speaker-identified transcript text
    this.speakersIdentified = !!this.app.speakersIdentified;
    this.rawTranscript = this.app.rawTranscript || '';
  }

  /**
   * Parse dialogue blocks from speaker-identified transcript
   * Format: **[Speaker Name]**: dialogue text
   */
  parseDialogueBlocks() {
    this.dialogueBlocks = [];
    
    // If we have speaker-identified raw transcript, parse it
    if (this.rawTranscript && this.speakersIdentified) {
      const speakerPattern = /\*\*\[([^\]]+)\]\*\*:?\s*/g;
      const lines = this.rawTranscript.split('\n').filter(l => l.trim());
      
      let currentSpeaker = null;
      let currentText = [];
      let blockStart = 0;
      
      lines.forEach((line, lineIdx) => {
        const match = line.match(/^\*\*\[([^\]]+)\]\*\*:?\s*(.*)$/);
        
        if (match) {
          // Save previous block
          if (currentSpeaker && currentText.length > 0) {
            this.dialogueBlocks.push({
              speaker: currentSpeaker,
              text: currentText.join(' '),
              lineStart: blockStart,
              lineEnd: lineIdx - 1
            });
          }
          
          currentSpeaker = match[1].trim();
          currentText = match[2] ? [match[2].trim()] : [];
          blockStart = lineIdx;
          
          // Track unique speakers
          if (!this.speakers.includes(currentSpeaker)) {
            this.speakers.push(currentSpeaker);
          }
        } else if (currentSpeaker) {
          currentText.push(line.trim());
        }
      });
      
      // Save final block
      if (currentSpeaker && currentText.length > 0) {
        this.dialogueBlocks.push({
          speaker: currentSpeaker,
          text: currentText.join(' '),
          lineStart: blockStart,
          lineEnd: lines.length - 1
        });
      }
      
      console.log('[StoryBeatsEditor] Parsed', this.dialogueBlocks.length, 'dialogue blocks');
    }
    
    // If no speaker-identified transcript, create blocks from words grouped by timing
    if (this.dialogueBlocks.length === 0 && this.words.length > 0) {
      this.createBlocksFromWords();
    }
  }

  /**
   * Create dialogue blocks from words (when no speaker ID available)
   */
  createBlocksFromWords() {
    if (this.words.length === 0) return;
    
    const WORDS_PER_BLOCK = 30; // Group words into blocks
    let blockWords = [];
    let blockStartIdx = 0;
    
    this.words.forEach((word, idx) => {
      blockWords.push(word.text);
      
      // Create block at sentence end or word limit
      const isEndOfSentence = /[.!?]$/.test(word.text);
      const isLastWord = idx === this.words.length - 1;
      const isBlockFull = blockWords.length >= WORDS_PER_BLOCK;
      
      if ((isEndOfSentence && blockWords.length >= 10) || isBlockFull || isLastWord) {
        this.dialogueBlocks.push({
          speaker: null, // Unknown speaker
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
   * Expand transcript segments into individual words with timing
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
   * Load markers from marker manager (these become SCENES)
   */
  loadMarkers() {
    const markerManager = this.app.markerManager;
    if (markerManager) {
      this.markers = markerManager.getAll() || [];
    } else {
      this.markers = this.app.markers || [];
    }
    
    // Sort markers by time
    this.markers.sort((a, b) => {
      const aTime = a.type === 'range' ? a.inTime : (a.time || 0);
      const bTime = b.type === 'range' ? b.inTime : (b.time || 0);
      return aTime - bTime;
    });
  }

  /**
   * Show the editor
   */
  show() {
    this.visible = true;
    if (this.container) {
      this.container.classList.remove('hidden');
    }
    this.loadTranscriptWithSpeakers();
    this.loadMarkers();
    this.parseDialogueBlocks();
    this.render();
  }

  /**
   * Hide the editor
   */
  hide() {
    this.visible = false;
    if (this.container) {
      this.container.classList.add('hidden');
    }
    this.clearSelection();
  }

  /**
   * Format time as HH:MM:SS
   */
  formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '00:00:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  /**
   * Get marker at a specific time
   */
  getMarkerAtTime(time) {
    return this.markers.find(m => {
      if (m.type === 'range') {
        return time >= m.inTime && time <= m.outTime;
      }
      return false;
    });
  }

  /**
   * Get marker that starts at or near a time
   */
  getMarkerStartingAt(time, tolerance = 0.5) {
    return this.markers.find(m => {
      if (m.type === 'range') {
        return Math.abs(m.inTime - time) <= tolerance;
      }
      return Math.abs((m.time || 0) - time) <= tolerance;
    });
  }

  /**
   * Get marker that ends at or near a time
   */
  getMarkerEndingAt(time, tolerance = 0.5) {
    return this.markers.find(m => {
      if (m.type === 'range') {
        return Math.abs(m.outTime - time) <= tolerance;
      }
      return false;
    });
  }

  /**
   * Check if a word is within a pending edit
   */
  getEditForWord(wordIndex) {
    const word = this.words[wordIndex];
    if (!word) return null;
    
    return this.edits.find(edit => {
      return word.start >= edit.startTime && word.end <= edit.endTime;
    });
  }

  /**
   * Render the full editor in COMPREHENSIVE LINE SCRIPT format
   */
  render() {
    if (!this.editorContent) return;
    
    // Calculate running time
    this.runningTime = this.words.length > 0 
      ? this.words[this.words.length - 1].end 
      : 0;
    
    // Get video/project title
    this.scriptTitle = this.app.videoInfo?.name || 
                       this.app.currentVideoMetadata?.title || 
                       'Untitled Script';
    
    // Empty state
    if (this.words.length === 0 && this.dialogueBlocks.length === 0) {
      this.editorContent.innerHTML = `
        <div class="storybeats-empty">
          <div class="storybeats-empty-icon">
            <svg viewBox="0 0 24 24" width="48" height="48" stroke="currentColor" fill="none" stroke-width="1">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="16" y1="13" x2="8" y2="13"/>
              <line x1="16" y1="17" x2="8" y2="17"/>
            </svg>
          </div>
          <div class="storybeats-empty-title">No Script Available</div>
          <div class="storybeats-empty-text">
            Load a video with a transcript or click "Generate Script" to create a line script.
            <br><br>
            <em>Tip: Use "Identify Speakers" in the Media panel to add character names.</em>
          </div>
          <button class="btn btn-secondary" onclick="app.transcribeForWaveform()" style="margin-top: 16px;">
            🎤 Generate Script
          </button>
        </div>
      `;
      return;
    }
    
    // Build comprehensive line script HTML
    let html = '';
    
    // Script Title Page / Header
    html += this.renderScriptHeader();
    
    // Main script content
    html += '<div class="storybeats-lines">';
    
    // If we have dialogue blocks with speakers, render in screenplay format
    if (this.dialogueBlocks.length > 0) {
      html += this.renderScreenplayFormat();
    } else {
      // Fall back to word-by-word rendering with scene markers
      html += this.renderWordByWordFormat();
    }
    
    html += '</div>';
    
    // Script footer with metadata
    html += this.renderScriptFooter();
    
    this.editorContent.innerHTML = html;
    
    // Attach event listeners
    this.attachWordListeners();
    this.attachNoteListeners();
    this.attachTemplateListeners();
    this.attachLearningListeners();
  }

  /**
   * Attach template selector button listeners
   */
  attachTemplateListeners() {
    this.editorContent?.querySelectorAll('.template-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const templateId = e.currentTarget.dataset.template;
        if (templateId && templateId !== this.selectedTemplate) {
          this.setTemplate(templateId);
          this.app.showToast?.('success', `Switched to ${this.templates[templateId].name} format`);
        }
      });
    });
  }

  /**
   * Render script header with title, date, revision info, and template selector
   */
  renderScriptHeader() {
    const template = this.getTemplate();
    const config = template.config;
    const totalDuration = this.formatTime(this.runningTime);
    const totalScenes = this.markers.length;
    const totalSpeakers = this.speakers.length;
    
    // Get scene label from template
    const sceneLabel = config.sceneLabel || 'SCENE';
    
    return `
      <div class="linescript-header">
        <!-- Template Selector -->
        <div class="template-selector">
          <div class="template-label">SCRIPT FORMAT</div>
          <div class="template-buttons">
            ${Object.values(this.templates).map(t => `
              <button class="template-btn ${t.id === this.selectedTemplate ? 'active' : ''}" 
                      data-template="${t.id}"
                      title="${t.description}">
                <span class="template-icon">${t.icon}</span>
                <span class="template-name">${t.name}</span>
              </button>
            `).join('')}
          </div>
        </div>
        
        <div class="linescript-title-block">
          <h1 class="linescript-title">${this.escapeHtml(this.scriptTitle)}</h1>
          <div class="linescript-meta-row">
            <span class="linescript-template-badge">
              ${template.icon} ${template.name}
            </span>
            <span class="linescript-revision" data-revision="${this.scriptRevision}">
              ${this.scriptRevision}
            </span>
            <span class="linescript-date">${this.scriptDate}</span>
            <span class="linescript-duration">⏱ ${totalDuration}</span>
          </div>
        </div>
        
        <div class="linescript-stats">
          <div class="linescript-stat">
            <span class="stat-value">${totalScenes}</span>
            <span class="stat-label">${sceneLabel}s</span>
          </div>
          <div class="linescript-stat">
            <span class="stat-value">${totalSpeakers}</span>
            <span class="stat-label">${this.getSpeakerLabel(template)}</span>
          </div>
          <div class="linescript-stat">
            <span class="stat-value">${this.words.length}</span>
            <span class="stat-label">Words</span>
          </div>
          <div class="linescript-stat">
            <span class="stat-value">${Math.ceil(this.runningTime / 60)}</span>
            <span class="stat-label">Minutes</span>
          </div>
        </div>
        
        ${this.speakers.length > 0 ? `
          <div class="linescript-cast">
            <div class="cast-label">${this.getCastLabel(template)}</div>
            <div class="cast-list">
              ${this.speakers.map((speaker, idx) => `
                <span class="cast-member speaker-${idx % 6}">${this.escapeHtml(speaker)}</span>
              `).join('')}
            </div>
          </div>
        ` : ''}
        
        <!-- Template-specific info -->
        ${this.renderTemplateInfo(template)}
      </div>
    `;
  }

  /**
   * Get speaker label based on template
   */
  getSpeakerLabel(template) {
    switch (template.id) {
      case 'podcast': return 'Speakers';
      case 'learning': return 'Instructors';
      case 'promo': return 'Voices';
      case 'highlight': return 'Featured';
      case 'dynamic': return 'Characters';
      default: return 'Speakers';
    }
  }

  /**
   * Get cast label based on template
   */
  getCastLabel(template) {
    switch (template.id) {
      case 'podcast': return 'SPEAKERS';
      case 'learning': return 'PRESENTERS';
      case 'promo': return 'TALENT';
      case 'highlight': return 'FEATURED';
      case 'dynamic': return 'CAST';
      default: return 'CAST';
    }
  }

  /**
   * Render template-specific info section
   */
  renderTemplateInfo(template) {
    const config = template.config;
    let info = '';
    
    switch (template.id) {
      case 'podcast':
        info = `
          <div class="template-info podcast-info">
            <div class="info-item">
              <span class="info-icon">🎧</span>
              <span class="info-text">Conversation format • Speaker turns highlighted</span>
            </div>
          </div>
        `;
        break;
        
      case 'learning':
        info = this.renderLearningPanels();
        break;
        
      case 'promo':
        info = `
          <div class="template-info promo-info">
            <div class="info-item">
              <span class="info-icon">🎯</span>
              <span class="info-text">Shots • Hooks • Call-to-Action markers</span>
            </div>
          </div>
        `;
        break;
        
      case 'highlight':
        info = `
          <div class="template-info highlight-info">
            <div class="info-item">
              <span class="info-icon">⭐</span>
              <span class="info-text">Best moments • Timestamps • Quick navigation</span>
            </div>
          </div>
        `;
        break;
        
      case 'dynamic':
        info = this.renderDynamicLearningPanels();
        break;
    }
    
    return info;
  }

  /**
   * Render Learning-specific panels (Key Points, Objectives, Quiz, Progress)
   * @returns {string} HTML for learning template panels
   */
  renderLearningPanels() {
    const chapters = this.getLearningMarkers('chapter');
    const keyPoints = this.getLearningMarkers('keypoint');
    const quizzes = this.getLearningMarkers('quiz');
    const concepts = this.getLearningMarkers('concept');
    const examples = this.getLearningMarkers('example');
    
    // Calculate progress stats
    const totalDuration = this.runningTime || 0;
    const completedChapters = chapters.filter(c => c.completed).length;
    const totalChapters = chapters.length;
    const progressPercent = totalChapters > 0 ? Math.round((completedChapters / totalChapters) * 100) : 0;
    
    return `
      <div class="template-info learning-info">
        <!-- Progress Tracker -->
        <div class="learning-progress-tracker">
          <div class="progress-header">
            <span class="progress-icon">📊</span>
            <span class="progress-title">Course Progress</span>
            <span class="progress-percent">${progressPercent}%</span>
          </div>
          <div class="progress-bar-container">
            <div class="progress-bar-fill" style="width: ${progressPercent}%;"></div>
          </div>
          <div class="progress-stats">
            <span>${completedChapters}/${totalChapters} chapters</span>
            <span>•</span>
            <span>${keyPoints.length} key points</span>
            <span>•</span>
            <span>${quizzes.length} quizzes</span>
          </div>
        </div>
        
        <!-- Learning Objectives Section -->
        ${chapters.length > 0 ? `
          <div class="learning-objectives-panel">
            <div class="panel-header" onclick="this.parentElement.classList.toggle('collapsed')">
              <span class="panel-icon">🎯</span>
              <span class="panel-title">Learning Objectives</span>
              <span class="panel-count">${chapters.length}</span>
              <span class="panel-toggle">▼</span>
            </div>
            <div class="panel-content">
              <ul class="objectives-list">
                ${chapters.map((ch, i) => `
                  <li class="objective-item ${ch.completed ? 'completed' : ''}">
                    <span class="objective-number">${i + 1}</span>
                    <span class="objective-text">${this.escapeHtml(ch.description || ch.name || 'Chapter ' + (i + 1))}</span>
                    <button class="objective-goto" data-time="${ch.inTime || ch.time}" title="Go to chapter">▶</button>
                  </li>
                `).join('')}
              </ul>
            </div>
          </div>
        ` : ''}
        
        <!-- Key Points Summary -->
        ${keyPoints.length > 0 ? `
          <div class="learning-keypoints-panel">
            <div class="panel-header" onclick="this.parentElement.classList.toggle('collapsed')">
              <span class="panel-icon">💡</span>
              <span class="panel-title">Key Points</span>
              <span class="panel-count">${keyPoints.length}</span>
              <span class="panel-toggle">▼</span>
            </div>
            <div class="panel-content">
              <div class="keypoints-grid">
                ${keyPoints.map((kp, i) => `
                  <div class="keypoint-card" data-marker-id="${kp.id}" style="--keypoint-color: ${kp.color || '#eab308'};">
                    <div class="keypoint-header">
                      <span class="keypoint-icon">💡</span>
                      <span class="keypoint-time">${this.formatTimecode(kp.time || kp.inTime)}</span>
                    </div>
                    <div class="keypoint-content">
                      <div class="keypoint-title">${this.escapeHtml(kp.name || 'Key Point ' + (i + 1))}</div>
                      ${kp.description ? `<div class="keypoint-desc">${this.escapeHtml(kp.description)}</div>` : ''}
                    </div>
                    <button class="keypoint-goto" data-time="${kp.time || kp.inTime}" title="Go to this point">▶</button>
                  </div>
                `).join('')}
              </div>
            </div>
          </div>
        ` : ''}
        
        <!-- Quiz Markers Section -->
        ${quizzes.length > 0 ? `
          <div class="learning-quiz-panel">
            <div class="panel-header" onclick="this.parentElement.classList.toggle('collapsed')">
              <span class="panel-icon">❓</span>
              <span class="panel-title">Knowledge Checks</span>
              <span class="panel-count">${quizzes.length}</span>
              <span class="panel-toggle">▼</span>
            </div>
            <div class="panel-content">
              <div class="quiz-list">
                ${quizzes.map((quiz, i) => `
                  <div class="quiz-item" data-marker-id="${quiz.id}">
                    <div class="quiz-number">${i + 1}</div>
                    <div class="quiz-info">
                      <div class="quiz-title">${this.escapeHtml(quiz.name || 'Quiz ' + (i + 1))}</div>
                      <div class="quiz-time">${this.formatTimecode(quiz.time || quiz.inTime)}</div>
                    </div>
                    <div class="quiz-actions">
                      <button class="quiz-goto" data-time="${quiz.time || quiz.inTime}" title="Go to quiz">▶</button>
                      <button class="quiz-preview" data-marker-id="${quiz.id}" title="Preview question">👁</button>
                    </div>
                  </div>
                `).join('')}
              </div>
            </div>
          </div>
        ` : ''}
        
        <!-- Concepts & Examples Summary -->
        ${(concepts.length > 0 || examples.length > 0) ? `
          <div class="learning-concepts-panel">
            <div class="panel-header" onclick="this.parentElement.classList.toggle('collapsed')">
              <span class="panel-icon">🧠</span>
              <span class="panel-title">Concepts & Examples</span>
              <span class="panel-count">${concepts.length + examples.length}</span>
              <span class="panel-toggle">▼</span>
            </div>
            <div class="panel-content">
              <div class="concepts-examples-list">
                ${concepts.map(c => `
                  <div class="concept-item" data-marker-id="${c.id}">
                    <span class="item-icon">🧠</span>
                    <span class="item-name">${this.escapeHtml(c.name)}</span>
                    <span class="item-time">${this.formatTimecode(c.time || c.inTime)}</span>
                    <button class="item-goto" data-time="${c.time || c.inTime}">▶</button>
                  </div>
                `).join('')}
                ${examples.map(e => `
                  <div class="example-item" data-marker-id="${e.id}">
                    <span class="item-icon">📝</span>
                    <span class="item-name">${this.escapeHtml(e.name)}</span>
                    <span class="item-time">${this.formatTimecode(e.time || e.inTime)}</span>
                    <button class="item-goto" data-time="${e.time || e.inTime}">▶</button>
                  </div>
                `).join('')}
              </div>
            </div>
          </div>
        ` : ''}
        
        <!-- Chapter Navigation -->
        ${chapters.length > 0 ? `
          <div class="learning-chapter-nav">
            <div class="chapter-nav-title">Chapter Navigation</div>
            <div class="chapter-nav-items">
              ${chapters.map((ch, i) => `
                <button class="chapter-nav-btn ${ch.completed ? 'completed' : ''}" 
                        data-time="${ch.inTime || ch.time}"
                        title="${this.escapeHtml(ch.name || 'Chapter ' + (i + 1))}">
                  <span class="chapter-num">${i + 1}</span>
                  ${ch.completed ? '<span class="chapter-check">✓</span>' : ''}
                </button>
              `).join('')}
            </div>
          </div>
        ` : ''}
        
        <!-- Empty State for Learning Template -->
        ${chapters.length === 0 && keyPoints.length === 0 ? `
          <div class="learning-empty-state">
            <div class="empty-icon">📚</div>
            <div class="empty-title">No Learning Content Marked</div>
            <div class="empty-text">
              Use keyboard shortcuts to mark learning content:
              <ul class="shortcut-list">
                <li><kbd>C</kbd> - Add Chapter</li>
                <li><kbd>K</kbd> - Add Key Point</li>
                <li><kbd>Z</kbd> - Add Quiz Point</li>
                <li><kbd>E</kbd> - Add Example</li>
              </ul>
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }

  /**
   * Get markers filtered by learning type
   * @param {string} markerType - Type of marker (chapter, keypoint, quiz, concept, example)
   * @returns {Array} Filtered markers
   */
  getLearningMarkers(markerType) {
    return this.markers.filter(m => m.markerType === markerType).sort((a, b) => {
      const aTime = a.inTime || a.time || 0;
      const bTime = b.inTime || b.time || 0;
      return aTime - bTime;
    });
  }

  /**
   * Render Dynamic Learning template panels (Checkpoints, Progress, Interactive)
   * @returns {string} HTML for dynamic learning template panels
   */
  renderDynamicLearningPanels() {
    // Get all range markers as beats
    const beats = this.markers.filter(m => m.type === 'range').sort((a, b) => {
      const aTime = a.inTime || 0;
      const bTime = b.inTime || 0;
      return aTime - bTime;
    });
    
    // Calculate checkpoint progress
    const completedBeats = beats.filter(b => b.completed).length;
    const totalBeats = beats.length;
    const progressPercent = totalBeats > 0 ? Math.round((completedBeats / totalBeats) * 100) : 0;
    
    return `
      <div class="template-info dynamic-info">
        <!-- Checkpoint Progress -->
        <div class="dynamic-progress-section">
          <div class="progress-header">
            <span class="progress-icon">⚡</span>
            <span class="progress-title">Learning Progress</span>
            <span class="progress-badge">${completedBeats}/${totalBeats}</span>
          </div>
          <div class="checkpoint-progress-bar">
            ${beats.map((beat, i) => `
              <div class="checkpoint-segment ${beat.completed ? 'completed' : ''}" 
                   style="width: ${100 / Math.max(totalBeats, 1)}%;"
                   data-beat-id="${beat.id}"
                   title="${this.escapeHtml(beat.name || 'Beat ' + (i + 1))}">
              </div>
            `).join('')}
          </div>
          <div class="progress-stats">
            <span class="stat">${progressPercent}% complete</span>
            <span class="stat">${totalBeats - completedBeats} remaining</span>
          </div>
        </div>
        
        <!-- Checkpoint List -->
        ${beats.length > 0 ? `
          <div class="dynamic-checkpoints-panel">
            <div class="panel-header" onclick="this.parentElement.classList.toggle('collapsed')">
              <span class="panel-icon">📍</span>
              <span class="panel-title">Checkpoints</span>
              <span class="panel-count">${beats.length}</span>
              <span class="panel-toggle">▼</span>
            </div>
            <div class="panel-content">
              <div class="checkpoints-list">
                ${beats.map((beat, i) => {
                  const duration = (beat.outTime || 0) - (beat.inTime || 0);
                  return `
                    <div class="checkpoint-item ${beat.completed ? 'completed' : ''}" 
                         data-beat-id="${beat.id}">
                      <div class="checkpoint-status">
                        <button class="checkpoint-toggle" data-beat-id="${beat.id}" title="Toggle complete">
                          ${beat.completed ? '✓' : (i + 1)}
                        </button>
                      </div>
                      <div class="checkpoint-info">
                        <div class="checkpoint-name">${this.escapeHtml(beat.name || 'Checkpoint ' + (i + 1))}</div>
                        <div class="checkpoint-meta">
                          <span class="checkpoint-time">${this.formatTimecode(beat.inTime)}</span>
                          <span class="checkpoint-duration">${duration.toFixed(1)}s</span>
                        </div>
                      </div>
                      <div class="checkpoint-actions">
                        <button class="checkpoint-play" data-time="${beat.inTime}" title="Play">▶</button>
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            </div>
          </div>
        ` : ''}
        
        <!-- Quick Actions -->
        <div class="dynamic-actions">
          <button class="action-btn" onclick="this.closest('.template-info').querySelectorAll('.checkpoint-toggle').forEach(b => b.click())">
            <span class="action-icon">↩️</span>
            <span class="action-text">Reset All</span>
          </button>
          <button class="action-btn" onclick="app?.exportBeatsJSON?.()">
            <span class="action-icon">📤</span>
            <span class="action-text">Export</span>
          </button>
        </div>
        
        <!-- Empty State -->
        ${beats.length === 0 ? `
          <div class="dynamic-empty-state">
            <div class="empty-icon">⚡</div>
            <div class="empty-title">No Checkpoints Yet</div>
            <div class="empty-text">
              Add story beats using <kbd>I</kbd> and <kbd>O</kbd> to mark in/out points.
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }

  /**
   * Render script footer with totals
   */
  renderScriptFooter() {
    return `
      <div class="linescript-footer">
        <div class="footer-stats">
          <span>${this.words.length} words</span>
          <span>•</span>
          <span>${this.markers.length} scenes</span>
          <span>•</span>
          <span>${this.speakers.length} speakers</span>
          <span>•</span>
          <span>Duration: ${this.formatTime(this.runningTime)}</span>
          ${this.speakersIdentified ? '<span>•</span><span class="speakers-badge">✓ Speakers ID</span>' : ''}
        </div>
        <div class="footer-page">
          Page ${this.pageNumber}
        </div>
      </div>
    `;
  }

  /**
   * Attach note button listeners
   */
  attachNoteListeners() {
    // Scene header click handlers for notes
    this.editorContent?.querySelectorAll('.scene-note-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const markerId = e.target.closest('[data-marker-id]')?.dataset.markerId;
        if (markerId) {
          this.showNotesPanel(markerId, e.target.dataset.noteType);
        }
      });
    });
  }

  /**
   * Show notes panel for a scene
   */
  showNotesPanel(markerId, noteType = 'director') {
    console.log('[LineScript] Show notes panel:', markerId, noteType);
    
    // Initialize notes panel if needed
    if (!this.notesPanel) {
      // Dynamically import NotesPanel
      import('./NotesPanel.js').then(({ NotesPanel }) => {
        this.notesPanel = new NotesPanel(this.app);
        this.notesPanel.show(markerId, noteType);
      }).catch(err => {
        console.error('[LineScript] Failed to load NotesPanel:', err);
        this.app.showToast?.('error', 'Failed to load notes panel');
      });
    } else {
      this.notesPanel.show(markerId, noteType);
    }
  }

  /**
   * Attach event listeners for Learning and Dynamic template panels
   */
  attachLearningListeners() {
    // Only attach if we're using learning or dynamic templates
    if (this.selectedTemplate !== 'learning' && this.selectedTemplate !== 'dynamic') return;
    
    // === Learning Template Listeners ===
    if (this.selectedTemplate === 'learning') {
      // Goto buttons (chapters, key points, quizzes, concepts, examples)
      this.editorContent?.querySelectorAll('.objective-goto, .keypoint-goto, .quiz-goto, .item-goto, .chapter-nav-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const time = parseFloat(btn.dataset.time);
          if (!isNaN(time)) {
            this.seekToTime(time);
            this.app.showToast?.('info', `Jumped to ${this.formatTimecode(time)}`);
          }
        });
      });
      
      // Quiz preview buttons
      this.editorContent?.querySelectorAll('.quiz-preview').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const markerId = btn.dataset.markerId;
          this.showQuizPreview(markerId);
        });
      });
      
      // Mark chapter as completed on double-click (toggle)
      this.editorContent?.querySelectorAll('.objective-item').forEach(item => {
        item.addEventListener('dblclick', (e) => {
          if (e.target.closest('.objective-goto')) return;
          item.classList.toggle('completed');
          const index = Array.from(item.parentElement.children).indexOf(item);
          const chapters = this.getLearningMarkers('chapter');
          if (chapters[index]) {
            chapters[index].completed = item.classList.contains('completed');
            this.app.showToast?.('info', chapters[index].completed ? 'Chapter marked complete' : 'Chapter marked incomplete');
          }
        });
      });
    }
    
    // === Dynamic Template Listeners ===
    if (this.selectedTemplate === 'dynamic') {
      // Checkpoint toggle buttons
      this.editorContent?.querySelectorAll('.checkpoint-toggle').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const beatId = btn.dataset.beatId;
          this.toggleCheckpointComplete(beatId);
        });
      });
      
      // Checkpoint play buttons
      this.editorContent?.querySelectorAll('.checkpoint-play').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const time = parseFloat(btn.dataset.time);
          if (!isNaN(time)) {
            this.seekToTime(time);
            this.app.showToast?.('info', `Playing from ${this.formatTimecode(time)}`);
          }
        });
      });
      
      // Checkpoint segment clicks
      this.editorContent?.querySelectorAll('.checkpoint-segment').forEach(seg => {
        seg.addEventListener('click', (e) => {
          const beatId = seg.dataset.beatId;
          const beat = this.markers.find(m => String(m.id) === String(beatId));
          if (beat) {
            this.seekToTime(beat.inTime || beat.time || 0);
          }
        });
      });
    }
    
    // === Common Listeners ===
    // Collapsible panel headers
    this.editorContent?.querySelectorAll('.panel-header').forEach(header => {
      header.style.cursor = 'pointer';
    });
  }

  /**
   * Toggle checkpoint completion status
   * @param {string} beatId - Beat/marker ID
   */
  toggleCheckpointComplete(beatId) {
    const marker = this.markers.find(m => String(m.id) === String(beatId));
    if (!marker) return;
    
    marker.completed = !marker.completed;
    
    // Update UI
    const item = this.editorContent?.querySelector(`.checkpoint-item[data-beat-id="${beatId}"]`);
    const toggle = this.editorContent?.querySelector(`.checkpoint-toggle[data-beat-id="${beatId}"]`);
    const segment = this.editorContent?.querySelector(`.checkpoint-segment[data-beat-id="${beatId}"]`);
    
    if (item) item.classList.toggle('completed', marker.completed);
    if (toggle) toggle.textContent = marker.completed ? '✓' : (this.markers.filter(m => m.type === 'range').indexOf(marker) + 1);
    if (segment) segment.classList.toggle('completed', marker.completed);
    
    // Update progress display
    const beats = this.markers.filter(m => m.type === 'range');
    const completedBeats = beats.filter(b => b.completed).length;
    const progressPercent = beats.length > 0 ? Math.round((completedBeats / beats.length) * 100) : 0;
    
    const badge = this.editorContent?.querySelector('.progress-badge');
    const statPercent = this.editorContent?.querySelector('.progress-stats .stat:first-child');
    const statRemaining = this.editorContent?.querySelector('.progress-stats .stat:last-child');
    
    if (badge) badge.textContent = `${completedBeats}/${beats.length}`;
    if (statPercent) statPercent.textContent = `${progressPercent}% complete`;
    if (statRemaining) statRemaining.textContent = `${beats.length - completedBeats} remaining`;
    
    this.app.showToast?.('info', marker.completed ? 'Checkpoint completed!' : 'Checkpoint uncompleted');
  }

  /**
   * Show quiz preview modal
   * @param {string} markerId - Marker ID of the quiz
   */
  showQuizPreview(markerId) {
    const marker = this.markers.find(m => String(m.id) === String(markerId));
    if (!marker) {
      this.app.showToast?.('error', 'Quiz not found');
      return;
    }
    
    // Simple modal preview
    const modal = document.createElement('div');
    modal.className = 'quiz-preview-modal';
    modal.innerHTML = `
      <div class="quiz-preview-overlay" onclick="this.parentElement.remove()"></div>
      <div class="quiz-preview-content">
        <div class="quiz-preview-header">
          <span class="quiz-preview-icon">❓</span>
          <span class="quiz-preview-title">Quiz Preview</span>
          <button class="quiz-preview-close" onclick="this.closest('.quiz-preview-modal').remove()">×</button>
        </div>
        <div class="quiz-preview-body">
          <div class="quiz-question">
            <strong>Question:</strong> ${this.escapeHtml(marker.name || 'No question set')}
          </div>
          ${marker.description ? `
            <div class="quiz-details">
              <strong>Details:</strong> ${this.escapeHtml(marker.description)}
            </div>
          ` : ''}
          <div class="quiz-timestamp">
            <strong>Timestamp:</strong> ${this.formatTimecode(marker.time || marker.inTime)}
          </div>
        </div>
        <div class="quiz-preview-footer">
          <button class="btn-secondary" onclick="this.closest('.quiz-preview-modal').remove()">Close</button>
          <button class="btn-primary" onclick="app?.seekToTime?.(${marker.time || marker.inTime}); this.closest('.quiz-preview-modal').remove();">Go to Quiz</button>
        </div>
      </div>
    `;
    
    // Add modal styles if not present
    if (!document.getElementById('quiz-preview-styles')) {
      const styles = document.createElement('style');
      styles.id = 'quiz-preview-styles';
      styles.textContent = `
        .quiz-preview-modal { position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 10000; display: flex; align-items: center; justify-content: center; }
        .quiz-preview-overlay { position: absolute; inset: 0; background: rgba(0,0,0,0.7); }
        .quiz-preview-content { position: relative; background: var(--bg-surface, #1e1e1e); border-radius: 12px; padding: 0; width: 400px; max-width: 90%; box-shadow: 0 20px 50px rgba(0,0,0,0.5); }
        .quiz-preview-header { display: flex; align-items: center; gap: 8px; padding: 16px; border-bottom: 1px solid var(--border-color, #333); }
        .quiz-preview-icon { font-size: 20px; }
        .quiz-preview-title { font-weight: 600; flex: 1; }
        .quiz-preview-close { background: none; border: none; color: var(--text-secondary, #888); font-size: 24px; cursor: pointer; }
        .quiz-preview-body { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
        .quiz-question { font-size: 14px; line-height: 1.5; }
        .quiz-details { font-size: 13px; color: var(--text-secondary, #888); line-height: 1.5; }
        .quiz-timestamp { font-size: 12px; color: var(--text-muted, #666); }
        .quiz-preview-footer { display: flex; gap: 8px; justify-content: flex-end; padding: 16px; border-top: 1px solid var(--border-color, #333); }
        .quiz-preview-footer button { padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; }
        .quiz-preview-footer .btn-secondary { background: var(--bg-elevated, #2a2a2a); border: 1px solid var(--border-color, #333); color: var(--text-primary, #fff); }
        .quiz-preview-footer .btn-primary { background: var(--accent-primary, #4a9eff); border: none; color: #fff; }
      `;
      document.head.appendChild(styles);
    }
    
    document.body.appendChild(modal);
  }

  /**
   * Seek video to specific time
   * @param {number} time - Time in seconds
   */
  seekToTime(time) {
    if (this.app.video) {
      this.app.video.currentTime = time;
    }
    if (this.app.seekToTime) {
      this.app.seekToTime(time);
    }
  }

  /**
   * Render screenplay format with full line script elements
   * Uses template configuration for format-specific rendering
   */
  renderScreenplayFormat() {
    const template = this.getTemplate();
    const config = template.config;
    
    // Use list view for Dynamic Learning template
    if (config.listView) {
      return this.renderBeatsList();
    }
    
    let html = '';
    let lineNumber = 1;
    let sceneNumber = 0;
    let lastMarkerId = null;
    let cumulativeTime = 0;
    
    this.dialogueBlocks.forEach((block, blockIdx) => {
      const blockTime = block.startTime || (this.words[block.wordStartIdx]?.start) || 0;
      
      // Check if a new scene/marker starts before this block
      const sceneMarker = this.getMarkerAtTime(blockTime);
      if (sceneMarker && sceneMarker.id !== lastMarkerId) {
        sceneNumber++;
        cumulativeTime = sceneMarker.inTime || blockTime;
        html += this.renderSceneByTemplate(sceneMarker, sceneNumber, cumulativeTime, template);
        lastMarkerId = sceneMarker.id;
      }
      
      // Render speaker cue based on template style
      if (block.speaker) {
        html += this.renderSpeakerByTemplate(block.speaker, lineNumber, block.parenthetical, template);
        lineNumber++;
      }
      
      // Calculate line width based on template
      const lineWidth = config.dialogueWidth === 'wide' ? 70 : 
                        config.dialogueWidth === 'narrow' ? 40 : 55;
      
      // Render dialogue lines with coverage tracking
      const dialogueLines = this.splitTextIntoLines(block.text, lineWidth);
      dialogueLines.forEach((lineText, lineIdx) => {
        const lineTime = this.interpolateTime(block, lineIdx, dialogueLines.length);
        const coverage = config.showCoverage ? this.getCoverageForTime(lineTime, lastMarkerId) : null;
        html += this.renderDialogueByTemplate(lineNumber, lineTime, lineText, block.speaker, blockIdx, coverage, template);
        lineNumber++;
      });
      
      // Add action/stage direction if present
      if (block.action) {
        html += this.renderActionLine(block.action, lineNumber);
        lineNumber++;
      }
      
      // Add spacing between dialogue blocks
      if (blockIdx < this.dialogueBlocks.length - 1) {
        html += '<div class="storybeats-block-spacer"></div>';
      }
    });
    
    return html;
  }

  /**
   * Render beats list view (for Dynamic Learning template)
   */
  renderBeatsList() {
    let html = '<div class="beats-list-view">';
    let beatNumber = 0;
    
    this.markers.forEach((marker, idx) => {
      if (marker.type === 'range') {
        beatNumber++;
        const duration = (marker.outTime || 0) - (marker.inTime || 0);
        const wordsInRange = this.getWordsInTimeRange(marker.inTime, marker.outTime);
        
        html += `
          <div class="beat-item" data-marker-id="${marker.id}" style="--beat-color: ${marker.color || '#4a9eff'};">
            <div class="beat-number">${beatNumber}</div>
            <div class="beat-content">
              <div class="beat-header">
                <span class="beat-name">${this.escapeHtml(marker.name || 'Beat ' + beatNumber)}</span>
                <span class="beat-duration">${duration.toFixed(1)}s</span>
              </div>
              <div class="beat-timecode">
                ${this.formatTimecode(marker.inTime)} → ${this.formatTimecode(marker.outTime)}
              </div>
              ${marker.description ? `<div class="beat-description">${this.escapeHtml(marker.description)}</div>` : ''}
              <div class="beat-preview">
                ${wordsInRange.slice(0, 20).map(w => w.text).join(' ')}${wordsInRange.length > 20 ? '...' : ''}
              </div>
              <div class="beat-actions">
                <button class="beat-action-btn" onclick="app.seekToTime(${marker.inTime})">▶ Play</button>
                <button class="beat-action-btn" onclick="app.editMarker('${marker.id}')">✏️ Edit</button>
              </div>
            </div>
            <div class="beat-checkpoint">
              <input type="checkbox" class="beat-checkbox" id="beat-check-${marker.id}">
              <label for="beat-check-${marker.id}">✓</label>
            </div>
          </div>
        `;
      }
    });
    
    if (beatNumber === 0) {
      html += `
        <div class="beats-empty">
          <span class="beats-empty-icon">📍</span>
          <span class="beats-empty-text">No story beats defined yet.</span>
          <span class="beats-empty-hint">Add markers to create beats.</span>
        </div>
      `;
    }
    
    html += '</div>';
    return html;
  }

  /**
   * Get words in a time range
   */
  getWordsInTimeRange(startTime, endTime) {
    return this.words.filter(w => w.start >= startTime && w.end <= endTime);
  }

  /**
   * Render scene header based on template
   */
  renderSceneByTemplate(marker, sceneNumber, cumulativeTime, template) {
    const config = template.config;
    
    // Use full scene header for promo template (has all production elements)
    if (template.id === 'promo') {
      return this.renderFullSceneHeader(marker, sceneNumber, cumulativeTime);
    }
    
    // Use template-specific scene header
    return this.renderTemplateSceneHeader(marker, sceneNumber, cumulativeTime, template);
  }

  /**
   * Render template-specific scene header
   */
  renderTemplateSceneHeader(marker, sceneNumber, cumulativeTime, template) {
    const config = template.config;
    const color = marker.color || '#4a9eff';
    const name = marker.name || `${config.sceneLabel} ${sceneNumber}`;
    const duration = (marker.outTime || 0) - (marker.inTime || 0);
    
    let headerClass = `linescript-scene template-${template.id}`;
    
    return `
      <div class="${headerClass}" data-marker-id="${marker.id}" style="--scene-color: ${color};">
        <div class="scene-slugline">
          <span class="scene-number-box">${sceneNumber}</span>
          <span class="scene-label">${config.sceneLabel}</span>
          <span class="scene-name">${this.escapeHtml(name)}</span>
          <span class="scene-duration-badge">${duration.toFixed(1)}s</span>
        </div>
        
        <div class="scene-meta-bar">
          <div class="scene-timing">
            <span class="meta-value">${this.formatTimecode(marker.inTime)} - ${this.formatTimecode(marker.outTime)}</span>
            ${config.showRunningTime ? `
              <span class="meta-separator">|</span>
              <span class="meta-label">RT:</span>
              <span class="meta-value">${this.formatTime(cumulativeTime + duration)}</span>
            ` : ''}
          </div>
        </div>
        
        ${marker.description ? `
          <div class="scene-description">${this.escapeHtml(marker.description)}</div>
        ` : ''}
      </div>
    `;
  }

  /**
   * Render speaker cue based on template style
   */
  renderSpeakerByTemplate(speaker, lineNumber, parenthetical, template) {
    const config = template.config;
    
    switch (config.speakerStyle) {
      case 'conversation':
        // Podcast style - speaker label inline
        return this.renderConversationSpeaker(speaker, lineNumber);
        
      case 'instructor':
        // Learning style - presenter label
        return this.renderInstructorSpeaker(speaker, lineNumber);
        
      case 'voiceover':
        // Promo style - VO label
        return this.renderVoiceoverSpeaker(speaker, lineNumber);
        
      case 'minimal':
        // Highlight style - minimal speaker
        return this.renderMinimalSpeaker(speaker, lineNumber);
        
      case 'beat':
        // Dynamic style - no separate speaker cue
        return '';
        
      default:
        return this.renderCharacterCue(speaker, lineNumber, parenthetical);
    }
  }

  /**
   * Get display name for a speaker (uses character mapping if available)
   * @param {string} speakerId - Speaker ID from transcript
   * @returns {Object} { name, color } - Display name and color
   */
  getCharacterForSpeaker(speakerId) {
    // Check planning data for character mapping
    const planning = this.app.planning || this.app.planningPanel?.planning;
    if (planning?.characters) {
      const character = planning.characters.find(c => 
        c.speakerIds && c.speakerIds.includes(String(speakerId))
      );
      if (character) {
        return { name: character.name, color: character.color, role: character.role };
      }
    }
    
    // Fall back to original speaker ID
    return { name: speakerId, color: null, role: null };
  }

  /**
   * Render conversation-style speaker (podcast)
   */
  renderConversationSpeaker(speaker, lineNumber) {
    const speakerIdx = this.getSpeakerIndex(speaker);
    const character = this.getCharacterForSpeaker(speaker);
    const displayName = character.name || speaker;
    const avatarStyle = character.color ? `background: ${character.color}` : '';
    
    return `
      <div class="speaker-cue conversation-style speaker-${speakerIdx}" data-line="${lineNumber}">
        <div class="speaker-avatar" style="${avatarStyle}">${displayName.charAt(0).toUpperCase()}</div>
        <div class="speaker-name">${this.escapeHtml(displayName)}</div>
      </div>
    `;
  }

  /**
   * Render instructor-style speaker (learning)
   */
  renderInstructorSpeaker(speaker, lineNumber) {
    const character = this.getCharacterForSpeaker(speaker);
    const displayName = character.name || speaker;
    const roleLabel = character.role || 'PRESENTER';
    
    return `
      <div class="speaker-cue instructor-style" data-line="${lineNumber}">
        <div class="instructor-badge">👤 ${roleLabel.toUpperCase()}</div>
        <div class="instructor-name">${this.escapeHtml(displayName)}</div>
      </div>
    `;
  }

  /**
   * Render voiceover-style speaker (promo)
   */
  renderVoiceoverSpeaker(speaker, lineNumber) {
    const character = this.getCharacterForSpeaker(speaker);
    const displayName = character.name || speaker;
    
    return `
      <div class="speaker-cue voiceover-style" data-line="${lineNumber}">
        <div class="vo-label">V.O.</div>
        <div class="vo-name">(${this.escapeHtml(displayName)})</div>
      </div>
    `;
  }

  /**
   * Render minimal speaker (highlight)
   */
  renderMinimalSpeaker(speaker, lineNumber) {
    const speakerIdx = this.getSpeakerIndex(speaker);
    const character = this.getCharacterForSpeaker(speaker);
    const displayName = character.name || speaker;
    const dotStyle = character.color ? `background: ${character.color}` : '';
    
    return `
      <div class="speaker-cue minimal-style speaker-${speakerIdx}" data-line="${lineNumber}">
        <span class="speaker-dot" style="${dotStyle}"></span>
        <span class="speaker-name">${this.escapeHtml(displayName)}</span>
      </div>
    `;
  }

  /**
   * Render dialogue line based on template
   */
  renderDialogueByTemplate(lineNumber, lineTime, text, speaker, blockIdx, coverage, template) {
    const config = template.config;
    const speakerClass = speaker ? `speaker-${this.getSpeakerIndex(speaker)}` : '';
    const templateClass = `template-${template.id}`;
    const coveredClass = coverage?.covered ? 'line-covered' : '';
    
    return `
      <div class="storybeats-line storybeats-dialogue ${speakerClass} ${templateClass} ${coveredClass}" 
           data-line="${lineNumber}" data-block="${blockIdx}">
        <div class="storybeats-line-number">${lineNumber}</div>
        ${config.showTimecodes ? `<div class="storybeats-timecode">${this.formatTimecode(lineTime)}</div>` : ''}
        <div class="storybeats-text storybeats-dialogue-text">${this.renderTextWithEdits(text)}</div>
        ${coverage?.covered ? '<div class="coverage-line"></div>' : ''}
      </div>
    `;
  }

  /**
   * Render word-by-word format (no speaker ID)
   */
  renderWordByWordFormat() {
    let html = '';
    let currentLine = [];
    let currentLineStart = 0;
    let lineNumber = 1;
    let sceneNumber = 0;
    const wordsPerLine = 10;
    
    const openMarkers = new Set();
    const renderedSceneHeaders = new Set();
    
    this.words.forEach((word, index) => {
      // Check for scene markers
      this.markers.forEach(marker => {
        if (marker.type === 'range') {
          if (!openMarkers.has(marker.id) && word.start >= marker.inTime && word.start < marker.inTime + 0.5) {
            // Flush current line
            if (currentLine.length > 0) {
              const lineTime = this.words[currentLineStart]?.start || 0;
              html += this.renderScriptLine(lineNumber, lineTime, currentLine);
              currentLine = [];
              currentLineStart = index;
              lineNumber++;
            }
            
            // Render scene header
            if (!renderedSceneHeaders.has(marker.id)) {
              sceneNumber++;
              html += this.renderSceneHeader(marker, sceneNumber);
              renderedSceneHeaders.add(marker.id);
            }
            
            openMarkers.add(marker.id);
          }
        }
      });
      
      // Render word
      const edit = this.getEditForWord(index);
      currentLine.push(this.renderWord(word, index, edit));
      
      // Check for marker ends
      this.markers.forEach(marker => {
        if (marker.type === 'range' && openMarkers.has(marker.id)) {
          if (word.end >= marker.outTime - 0.5 && word.end <= marker.outTime + 0.5) {
            currentLine.push(this.renderMarkerEnd(marker));
            openMarkers.delete(marker.id);
          }
        }
      });
      
      // Check for gap edits
      this.edits.forEach(edit => {
        if (edit.type === 'insert_gap' && Math.abs(edit.insertAfterTime - word.end) < 0.5) {
          currentLine.push(this.renderGapPlaceholder(edit));
        }
      });
      
      // Line break logic
      const isLineBreak = currentLine.length >= wordsPerLine || 
                          this.isSentenceEnd(word.text) ||
                          index === this.words.length - 1;
      
      if (isLineBreak) {
        const lineTime = this.words[currentLineStart]?.start || 0;
        html += this.renderScriptLine(lineNumber, lineTime, currentLine);
        currentLine = [];
        currentLineStart = index + 1;
        lineNumber++;
      }
    });
    
    return html;
  }

  /**
   * Render full scene header with all line script elements
   */
  renderFullSceneHeader(marker, sceneNumber, cumulativeTime) {
    const color = marker.color || '#4a9eff';
    const name = (marker.name || 'Scene').toUpperCase();
    const duration = (marker.outTime || 0) - (marker.inTime || 0);
    const timeRange = `${this.formatTimecode(marker.inTime)} - ${this.formatTimecode(marker.outTime)}`;
    
    // Get scene notes or use defaults
    const notes = this.sceneNotes[marker.id] || {};
    const intExt = notes.intExt || this.guessIntExt(marker);
    const location = notes.location || name;
    const timeOfDay = notes.timeOfDay || this.guessTimeOfDay(marker);
    const sceneType = this.getSceneType(marker);
    
    // Get director/supervisor notes
    const dirNotes = this.directorNotes[marker.id] || [];
    const supNotes = this.supervisorNotes[marker.id] || [];
    const techNotes = this.technicalNotes[marker.id] || {};
    const takes = this.takes[marker.id] || [];
    
    return `
      <div class="linescript-scene" data-marker-id="${marker.id}" style="--scene-color: ${color};">
        <!-- Scene Slugline -->
        <div class="scene-slugline">
          <span class="scene-number-box">${sceneNumber}</span>
          <span class="scene-int-ext">${intExt}.</span>
          <span class="scene-location">${this.escapeHtml(location)}</span>
          <span class="scene-time-of-day">- ${timeOfDay}</span>
          <span class="scene-number-right">${sceneNumber}</span>
        </div>
        
        <!-- Scene Meta Bar -->
        <div class="scene-meta-bar">
          <div class="scene-timing">
            <span class="meta-label">TC:</span>
            <span class="meta-value">${timeRange}</span>
            <span class="meta-separator">|</span>
            <span class="meta-label">DUR:</span>
            <span class="meta-value">${duration.toFixed(1)}s</span>
            <span class="meta-separator">|</span>
            <span class="meta-label">RT:</span>
            <span class="meta-value">${this.formatTime(cumulativeTime + duration)}</span>
          </div>
          <div class="scene-type-badge" style="background: ${color}22; color: ${color};">
            ${sceneType}
          </div>
        </div>
        
        <!-- Scene Description (if present) -->
        ${marker.description ? `
          <div class="scene-description">
            ${this.escapeHtml(marker.description)}
          </div>
        ` : ''}
        
        <!-- Notes & Technical Section (collapsible) -->
        <div class="scene-notes-section">
          <div class="notes-tabs">
            <button class="notes-tab active scene-note-btn" data-note-type="director" data-marker-id="${marker.id}">
              🎬 Director ${dirNotes.length > 0 ? `(${dirNotes.length})` : ''}
            </button>
            <button class="notes-tab scene-note-btn" data-note-type="supervisor" data-marker-id="${marker.id}">
              📋 Script Sup ${supNotes.length > 0 ? `(${supNotes.length})` : ''}
            </button>
            <button class="notes-tab scene-note-btn" data-note-type="technical" data-marker-id="${marker.id}">
              🎥 Technical
            </button>
            <button class="notes-tab scene-note-btn" data-note-type="takes" data-marker-id="${marker.id}">
              🎬 Takes ${takes.length > 0 ? `(${takes.length})` : ''}
            </button>
          </div>
          
          ${dirNotes.length > 0 ? `
            <div class="director-notes-preview">
              ${dirNotes.slice(0, 2).map(n => `
                <div class="note-item">💡 ${this.escapeHtml(n.note)}</div>
              `).join('')}
              ${dirNotes.length > 2 ? `<div class="note-more">+${dirNotes.length - 2} more</div>` : ''}
            </div>
          ` : ''}
          
          ${Object.keys(techNotes).length > 0 ? `
            <div class="tech-notes-preview">
              ${techNotes.camera ? `<span class="tech-item">📹 ${techNotes.camera}</span>` : ''}
              ${techNotes.lens ? `<span class="tech-item">🔍 ${techNotes.lens}</span>` : ''}
              ${techNotes.sound ? `<span class="tech-item">🎤 ${techNotes.sound}</span>` : ''}
            </div>
          ` : ''}
        </div>
        
        <!-- Coverage Track (visual line through covered portions) -->
        <div class="scene-coverage-track">
          ${this.renderCoverageTrack(marker.id, marker.inTime, marker.outTime)}
        </div>
      </div>
    `;
  }

  /**
   * Render coverage track visualization with interactive controls
   */
  renderCoverageTrack(markerId, startTime, endTime) {
    const coverage = this.coverage[markerId] || [];
    const duration = endTime - startTime;
    
    // Always show the track container with add button
    let html = `
      <div class="coverage-track-interactive" 
           data-marker-id="${markerId}" 
           data-start="${startTime}" 
           data-end="${endTime}"
           onclick="app.storyBeatsEditor?.handleCoverageTrackClick(event, '${markerId}', ${startTime}, ${endTime})">
    `;
    
    if (coverage.length === 0) {
      html += `
        <div class="coverage-empty-interactive">
          <span class="coverage-add-hint">Click to add coverage</span>
        </div>
      `;
    } else {
      // Render existing coverage segments
      html += coverage.map((c, index) => {
        const left = ((c.startTime - startTime) / duration) * 100;
        const width = ((c.endTime - c.startTime) / duration) * 100;
        const colorClass = this._getCoverageColorClass(c.setup);
        
        return `
          <div class="coverage-segment interactive ${c.covered ? 'covered' : ''} ${colorClass}" 
               style="left: ${left}%; width: ${width}%;"
               data-coverage-index="${index}"
               data-marker-id="${markerId}"
               onclick="event.stopPropagation(); app.storyBeatsEditor?.editCoverageSegment('${markerId}', ${index})"
               title="Shot ${c.shotId}: ${c.setup} (click to edit)">
            <div class="coverage-drag-handle left" 
                 onmousedown="event.stopPropagation(); app.storyBeatsEditor?.startCoverageDrag(event, '${markerId}', ${index}, 'left')"></div>
            <span class="shot-label">${c.shotId}</span>
            <span class="shot-setup">${c.setup || ''}</span>
            <div class="coverage-drag-handle right"
                 onmousedown="event.stopPropagation(); app.storyBeatsEditor?.startCoverageDrag(event, '${markerId}', ${index}, 'right')"></div>
          </div>
        `;
      }).join('');
    }
    
    // Add button for new coverage
    html += `
      <button class="coverage-add-btn" 
              onclick="event.stopPropagation(); app.storyBeatsEditor?.addCoverageSegment('${markerId}', ${startTime}, ${endTime})"
              title="Add new coverage segment">
        + Add Shot
      </button>
    </div>
    `;
    
    return html;
  }

  /**
   * Get color class for coverage setup type
   */
  _getCoverageColorClass(setup) {
    const setupLower = (setup || '').toLowerCase();
    if (setupLower.includes('wide') || setupLower.includes('ws')) return 'coverage-wide';
    if (setupLower.includes('medium') || setupLower.includes('ms')) return 'coverage-medium';
    if (setupLower.includes('close') || setupLower.includes('cu')) return 'coverage-close';
    if (setupLower.includes('insert') || setupLower.includes('ins')) return 'coverage-insert';
    if (setupLower.includes('ots')) return 'coverage-ots';
    return 'coverage-default';
  }

  /**
   * Handle click on coverage track to add segment at position
   */
  handleCoverageTrackClick(event, markerId, startTime, endTime) {
    // Get click position relative to track
    const track = event.currentTarget;
    const rect = track.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const trackWidth = rect.width;
    const clickPercent = clickX / trackWidth;
    
    // Calculate time at click position
    const duration = endTime - startTime;
    const clickTime = startTime + (duration * clickPercent);
    
    // Add new coverage segment at this position
    this.addCoverageSegmentAtTime(markerId, clickTime, startTime, endTime);
  }

  /**
   * Add a new coverage segment
   */
  addCoverageSegment(markerId, startTime, endTime) {
    // Prompt for shot info
    const shotId = prompt('Shot ID (e.g., 1A, 2B, etc.):', `${(this.coverage[markerId]?.length || 0) + 1}A`);
    if (!shotId) return;
    
    const setup = prompt('Shot setup (e.g., Wide, Medium, Close-up, OTS):', 'Medium');
    
    // Initialize coverage array if needed
    if (!this.coverage[markerId]) {
      this.coverage[markerId] = [];
    }
    
    // Add new segment covering the full scene by default
    this.coverage[markerId].push({
      shotId: shotId.trim(),
      setup: setup?.trim() || 'Medium',
      startTime: startTime,
      endTime: endTime,
      covered: false
    });
    
    // Re-render
    this.render();
    this.app.showToast?.('success', `Added shot ${shotId}`);
  }

  /**
   * Add coverage segment at a specific time
   */
  addCoverageSegmentAtTime(markerId, clickTime, sceneStart, sceneEnd) {
    const shotId = prompt('Shot ID:', `${(this.coverage[markerId]?.length || 0) + 1}A`);
    if (!shotId) return;
    
    const setup = prompt('Shot setup:', 'Medium');
    
    if (!this.coverage[markerId]) {
      this.coverage[markerId] = [];
    }
    
    // Create segment starting at click position with default 5 second duration
    const segmentDuration = Math.min(5, sceneEnd - clickTime);
    
    this.coverage[markerId].push({
      shotId: shotId.trim(),
      setup: setup?.trim() || 'Medium',
      startTime: clickTime,
      endTime: clickTime + segmentDuration,
      covered: false
    });
    
    // Sort by start time
    this.coverage[markerId].sort((a, b) => a.startTime - b.startTime);
    
    this.render();
    this.app.showToast?.('success', `Added shot ${shotId}`);
  }

  /**
   * Edit a coverage segment
   */
  editCoverageSegment(markerId, index) {
    const coverage = this.coverage[markerId];
    if (!coverage || !coverage[index]) return;
    
    const segment = coverage[index];
    
    // Create edit modal
    const action = prompt(
      `Shot ${segment.shotId} (${segment.setup})\n\n` +
      `Options:\n` +
      `- Enter new shot ID to rename\n` +
      `- Type 'setup' to change setup\n` +
      `- Type 'toggle' to mark as covered/uncovered\n` +
      `- Type 'delete' to remove`,
      segment.shotId
    );
    
    if (!action) return;
    
    const actionLower = action.toLowerCase().trim();
    
    if (actionLower === 'delete') {
      if (confirm(`Delete shot ${segment.shotId}?`)) {
        coverage.splice(index, 1);
        this.render();
        this.app.showToast?.('success', 'Shot deleted');
      }
    } else if (actionLower === 'toggle') {
      segment.covered = !segment.covered;
      this.render();
      this.app.showToast?.('success', `Shot ${segment.covered ? 'marked' : 'unmarked'} as covered`);
    } else if (actionLower === 'setup') {
      const newSetup = prompt('New setup:', segment.setup);
      if (newSetup) {
        segment.setup = newSetup.trim();
        this.render();
      }
    } else {
      // Treat as new shot ID
      segment.shotId = action.trim();
      this.render();
    }
  }

  /**
   * Start dragging coverage segment edge
   */
  startCoverageDrag(event, markerId, index, edge) {
    event.preventDefault();
    
    const coverage = this.coverage[markerId];
    if (!coverage || !coverage[index]) return;
    
    const segment = coverage[index];
    const track = event.target.closest('.coverage-track-interactive');
    if (!track) return;
    
    const startTime = parseFloat(track.dataset.start);
    const endTime = parseFloat(track.dataset.end);
    const duration = endTime - startTime;
    const rect = track.getBoundingClientRect();
    
    const handleMouseMove = (e) => {
      const x = e.clientX - rect.left;
      const percent = Math.max(0, Math.min(1, x / rect.width));
      const time = startTime + (duration * percent);
      
      if (edge === 'left') {
        segment.startTime = Math.min(time, segment.endTime - 0.5); // Min 0.5s duration
      } else {
        segment.endTime = Math.max(time, segment.startTime + 0.5);
      }
      
      this.render();
    };
    
    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }

  /**
   * Guess INT/EXT from marker name/tags
   */
  guessIntExt(marker) {
    const name = (marker.name || '').toLowerCase();
    const tags = (marker.tags || []).map(t => t.toLowerCase());
    
    if (name.includes('ext') || tags.includes('exterior') || tags.includes('outside')) return 'EXT';
    if (name.includes('int') || tags.includes('interior') || tags.includes('inside')) return 'INT';
    return 'INT'; // Default
  }

  /**
   * Guess time of day from marker
   */
  guessTimeOfDay(marker) {
    const name = (marker.name || '').toLowerCase();
    const tags = (marker.tags || []).map(t => t.toLowerCase());
    
    if (name.includes('night') || tags.includes('night')) return 'NIGHT';
    if (name.includes('dawn') || tags.includes('dawn')) return 'DAWN';
    if (name.includes('dusk') || tags.includes('dusk')) return 'DUSK';
    if (name.includes('evening') || tags.includes('evening')) return 'EVENING';
    if (name.includes('morning') || tags.includes('morning')) return 'MORNING';
    return 'DAY'; // Default
  }

  /**
   * Get coverage info for a specific time
   */
  getCoverageForTime(time, markerId) {
    const coverage = this.coverage[markerId] || [];
    return coverage.find(c => time >= c.startTime && time <= c.endTime);
  }

  /**
   * Render action/stage direction line
   */
  renderActionLine(action, lineNumber) {
    return `
      <div class="storybeats-action" data-line="${lineNumber}">
        <div class="storybeats-line-number">${lineNumber}</div>
        <div class="storybeats-timecode"></div>
        <div class="action-text">${this.escapeHtml(action)}</div>
      </div>
    `;
  }

  /**
   * Render CHARACTER cue with optional parenthetical
   */
  renderCharacterCue(speaker, lineNumber, parenthetical = null) {
    const character = this.getCharacterForSpeaker(speaker);
    const displayName = (character.name || speaker).toUpperCase();
    const colorStyle = character.color ? `border-left: 3px solid ${character.color}; padding-left: 8px;` : '';
    
    return `
      <div class="storybeats-character-cue" data-line="${lineNumber}" style="${colorStyle}">
        <div class="storybeats-line-number">${lineNumber}</div>
        <div class="storybeats-timecode"></div>
        <div class="storybeats-character-name">
          ${displayName}
          ${parenthetical ? `<span class="parenthetical">(${this.escapeHtml(parenthetical)})</span>` : ''}
        </div>
      </div>
    `;
  }

  /**
   * Render dialogue line with coverage indicator
   */
  renderDialogueLine(lineNumber, lineTime, text, speaker, blockIdx, coverage = null) {
    const speakerClass = speaker ? `speaker-${this.getSpeakerIndex(speaker)}` : '';
    const coveredClass = coverage?.covered ? 'line-covered' : '';
    const shotLabel = coverage?.shotId ? `<span class="line-shot-label">${coverage.shotId}</span>` : '';
    
    return `
      <div class="storybeats-line storybeats-dialogue ${speakerClass} ${coveredClass}" 
           data-line="${lineNumber}" data-block="${blockIdx}">
        <div class="storybeats-line-number">${lineNumber}</div>
        <div class="storybeats-timecode">${this.formatTimecode(lineTime)}</div>
        <div class="storybeats-text storybeats-dialogue-text">
          ${shotLabel}${this.renderTextWithEdits(text)}
        </div>
        ${coverage?.covered ? '<div class="coverage-line"></div>' : ''}
      </div>
    `;
  }

  /**
   * Render a single script line with line number
   */
  renderScriptLine(lineNumber, lineTime, words) {
    return `
      <div class="storybeats-line" data-line="${lineNumber}">
        <div class="storybeats-line-number">${lineNumber}</div>
        <div class="storybeats-timecode">${this.formatTimecode(lineTime)}</div>
        <div class="storybeats-text">${words.join(' ')}</div>
      </div>
    `;
  }

  /**
   * Render simple scene header (fallback for word-by-word mode)
   */
  renderSceneHeader(marker, sceneNumber) {
    const color = marker.color || '#4a9eff';
    const name = (marker.name || 'Scene').toUpperCase();
    const timeRange = `${this.formatTimecode(marker.inTime)} - ${this.formatTimecode(marker.outTime)}`;
    const duration = ((marker.outTime || 0) - (marker.inTime || 0)).toFixed(1);
    
    // Determine scene type from marker name/tags
    const sceneType = this.getSceneType(marker);
    
    return `
      <div class="storybeats-scene-header" style="--scene-color: ${color};" data-marker-id="${marker.id}">
        <div class="scene-header-line">
          <span class="scene-number">${sceneType} ${sceneNumber}</span>
          <span class="scene-title">${name}</span>
          <span class="scene-duration">${duration}s</span>
        </div>
        <div class="scene-header-meta">
          <span class="scene-timecode">${timeRange}</span>
          ${marker.description ? `<span class="scene-description">${marker.description}</span>` : ''}
        </div>
      </div>
    `;
  }

  /**
   * Get scene type label from marker
   */
  getSceneType(marker) {
    const name = (marker.name || '').toLowerCase();
    const tags = (marker.tags || []).map(t => t.toLowerCase());
    
    if (name.includes('reel') || tags.includes('reel')) return 'REEL';
    if (name.includes('segment') || tags.includes('segment')) return 'SEGMENT';
    if (name.includes('act') || tags.includes('act')) return 'ACT';
    if (name.includes('chapter') || tags.includes('chapter')) return 'CHAPTER';
    if (name.includes('intro') || tags.includes('intro')) return 'INTRO';
    if (name.includes('outro') || tags.includes('outro')) return 'OUTRO';
    return 'SCENE';
  }

  /**
   * Render subtle marker end notation
   */
  renderMarkerEnd(marker) {
    const color = marker.color || '#4a9eff';
    return `<span class="marker-bracket marker-end" style="color: ${color};" data-marker-id="${marker.id}">◆</span>`;
  }

  /**
   * Get speaker index for color coding
   */
  getSpeakerIndex(speaker) {
    const idx = this.speakers.indexOf(speaker);
    return idx >= 0 ? idx % 6 : 0; // 6 speaker colors
  }

  /**
   * Split text into lines of approximately n characters
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
   * Interpolate time for a line within a dialogue block
   */
  interpolateTime(block, lineIdx, totalLines) {
    const startTime = block.startTime || 0;
    const endTime = block.endTime || startTime + 5;
    const duration = endTime - startTime;
    
    return startTime + (duration * lineIdx / totalLines);
  }

  /**
   * Render text with edit markers (highlighting deletions, replacements, and insertions)
   * @param {string} text - The text to render
   * @param {number} blockStartTime - Start time of the text block
   * @param {number} blockEndTime - End time of the text block
   */
  renderTextWithEdits(text, blockStartTime = 0, blockEndTime = 0) {
    // Get edits in the time range of this text block
    const editsInRange = (this.edits || []).filter(edit => {
      if (!blockStartTime && !blockEndTime) return false;
      const editStart = edit.startTime || edit.insertAfterTime || 0;
      const editEnd = edit.endTime || editStart;
      return editStart < blockEndTime && editEnd > blockStartTime;
    });

    if (editsInRange.length === 0) {
      return this.escapeHtml(text);
    }

    // Build result with highlighting
    let result = '';
    let currentPos = 0;
    const escapedText = this.escapeHtml(text);
    const textWords = text.split(/\s+/);
    const blockDuration = blockEndTime - blockStartTime;

    // Process each edit
    for (const edit of editsInRange.sort((a, b) => (a.startTime || 0) - (b.startTime || 0))) {
      // Calculate approximate word positions based on time
      const editStartOffset = Math.max(0, (edit.startTime - blockStartTime) / blockDuration);
      const editEndOffset = Math.min(1, (edit.endTime - blockStartTime) / blockDuration);
      
      const startWordIdx = Math.floor(editStartOffset * textWords.length);
      const endWordIdx = Math.ceil(editEndOffset * textWords.length);

      // Find character positions
      let charStart = 0;
      let charEnd = escapedText.length;
      
      for (let i = 0; i < textWords.length; i++) {
        if (i === startWordIdx) {
          charStart = escapedText.indexOf(textWords[i], currentPos);
        }
        if (i === endWordIdx - 1 && textWords[i]) {
          charEnd = escapedText.indexOf(textWords[i], currentPos) + textWords[i].length;
        }
      }

      // Add text before edit
      if (charStart > currentPos) {
        result += escapedText.substring(currentPos, charStart);
      }

      // Get the text being edited
      const editedText = escapedText.substring(charStart, charEnd);

      // Apply highlighting based on edit type
      switch (edit.type) {
        case 'delete':
          result += `<span class="edit-delete" title="Deleted: ${this.escapeHtml(edit.originalText || editedText)}">${editedText}</span>`;
          break;

        case 'replace':
          result += `<span class="edit-replace" title="Will be replaced">${editedText}</span>`;
          if (edit.replacementText) {
            result += `<span class="edit-replacement-preview" title="Replacement text">[${this.escapeHtml(edit.replacementText)}]</span>`;
          }
          break;

        case 'insert_gap':
          // Insert gap markers appear after the position
          result += editedText;
          result += `<span class="edit-gap-marker" title="Gap: ${edit.gapDuration || 3}s for new content">⏸</span>`;
          break;

        default:
          result += `<span class="edit-unknown">${editedText}</span>`;
      }

      currentPos = charEnd;
    }

    // Add remaining text
    if (currentPos < escapedText.length) {
      result += escapedText.substring(currentPos);
    }

    return result || this.escapeHtml(text);
  }

  /**
   * Escape HTML entities
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Check if word ends a sentence
   */
  isSentenceEnd(text) {
    return /[.!?]$/.test(text);
  }

  /**
   * Format timecode in script format (MM:SS.f)
   */
  formatTimecode(seconds) {
    if (!seconds || isNaN(seconds)) return '00:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const f = Math.floor((seconds % 1) * 10);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${f}`;
  }

  /**
   * Render a single word element in script format
   */
  renderWord(word, index, edit = null) {
    const isSelected = this.selection && 
                       index >= this.selection.startIndex && 
                       index <= this.selection.endIndex;
    
    let classes = ['storybeats-word'];
    let styles = [];
    
    if (isSelected) {
      classes.push('selected');
    }
    
    if (edit) {
      if (edit.type === 'delete') {
        classes.push('edit-delete');
      } else if (edit.type === 'replace') {
        classes.push('edit-replace');
      }
    }
    
    // Check if within a marker for subtle underline
    const marker = this.getMarkerAtTime(word.start);
    if (marker && !isSelected && !edit) {
      styles.push(`border-bottom: 1px dotted ${marker.color || '#4a9eff'}40`);
    }
    
    const styleAttr = styles.length > 0 ? `style="${styles.join(';')}"` : '';
    
    return `<span class="${classes.join(' ')}" 
                  data-index="${index}" 
                  data-start="${word.start}" 
                  data-end="${word.end}"
                  ${styleAttr}
                  title="Line ${index + 1} • ${this.formatTimecode(word.start)}">${word.text}</span>`;
  }

  /**
   * Render gap placeholder in script format
   */
  renderGapPlaceholder(edit) {
    const duration = edit.gapDuration || 3.0;
    return `<span class="storybeats-gap" 
                  data-edit-id="${edit.id}"
                  title="Insert ${duration}s gap for new content">
              ⏸ PAUSE ${duration.toFixed(1)}s
            </span>`;
  }

  /**
   * Attach event listeners to word elements
   */
  attachWordListeners() {
    const words = this.editorContent?.querySelectorAll('.storybeats-word');
    if (!words) return;
    
    words.forEach(wordEl => {
      wordEl.addEventListener('mousedown', this.handleWordMouseDown);
      wordEl.addEventListener('mouseup', this.handleWordMouseUp);
      wordEl.addEventListener('click', this.handleWordClick);
    });
    
    // Listen for mouse up anywhere to complete selection
    document.addEventListener('mouseup', this.handleDocumentMouseUp);
  }

  /**
   * Setup global event listeners
   */
  setupEventListeners() {
    // Click outside to clear selection
    document.addEventListener('click', (e) => {
      if (!this.container?.contains(e.target) && 
          !e.target.closest('.storybeats-edit-toolbar')) {
        this.clearSelection();
      }
    });
    
    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (!this.visible) return;
      
      if (e.key === 'Escape') {
        this.clearSelection();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (this.selection) {
          e.preventDefault();
          this.deleteSelection();
        }
      }
    });
  }

  /**
   * Handle word mouse down (start selection)
   */
  handleWordMouseDown(e) {
    const wordEl = e.target;
    const index = parseInt(wordEl.dataset.index);
    
    if (isNaN(index)) return;
    
    this.selectionStart = index;
    this.isSelecting = true;
  }

  /**
   * Handle word mouse up (extend selection)
   */
  handleWordMouseUp(e) {
    if (!this.isSelecting) return;
    
    const wordEl = e.target;
    const index = parseInt(wordEl.dataset.index);
    
    if (isNaN(index)) return;
    
    this.completeSelection(this.selectionStart, index);
  }

  /**
   * Handle document mouse up (complete selection)
   */
  handleDocumentMouseUp(e) {
    if (this.isSelecting && this.selectionStart !== undefined) {
      // If we haven't completed selection on a word, use the start as single selection
      if (this.selection === null) {
        this.completeSelection(this.selectionStart, this.selectionStart);
      }
    }
    this.isSelecting = false;
  }

  /**
   * Handle word click (single word selection)
   */
  handleWordClick(e) {
    const wordEl = e.target;
    const index = parseInt(wordEl.dataset.index);
    
    if (isNaN(index)) return;
    
    // If shift key, extend selection
    if (e.shiftKey && this.selection) {
      this.completeSelection(this.selection.startIndex, index);
    } else {
      this.completeSelection(index, index);
    }
  }

  /**
   * Complete a selection
   */
  completeSelection(startIndex, endIndex) {
    // Ensure start <= end
    const start = Math.min(startIndex, endIndex);
    const end = Math.max(startIndex, endIndex);
    
    const startWord = this.words[start];
    const endWord = this.words[end];
    
    if (!startWord || !endWord) return;
    
    this.selection = {
      startIndex: start,
      endIndex: end,
      startTime: startWord.start,
      endTime: endWord.end,
      text: this.words.slice(start, end + 1).map(w => w.text).join(' ')
    };
    
    // Re-render to show selection
    this.render();
    
    // Show edit toolbar
    this.showEditToolbar();
  }

  /**
   * Clear current selection
   */
  clearSelection() {
    this.selection = null;
    this.selectionStart = undefined;
    this.isSelecting = false;
    
    // Re-render
    this.render();
    
    // Hide toolbar
    this.hideEditToolbar();
  }

  /**
   * Show the edit toolbar near the selection
   */
  showEditToolbar() {
    if (!this.selection) return;
    
    // Notify the EditToolbar component
    if (this.app.storyBeatsToolbar) {
      this.app.storyBeatsToolbar.show(this.selection);
    }
  }

  /**
   * Hide the edit toolbar
   */
  hideEditToolbar() {
    if (this.app.storyBeatsToolbar) {
      this.app.storyBeatsToolbar.hide();
    }
  }

  /**
   * Add an edit to the queue
   */
  addEdit(edit) {
    edit.id = `edit-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.edits.push(edit);
    
    // Re-render to show the edit
    this.render();
    
    // Update mini timeline
    if (this.app.storyBeatsMiniTimeline) {
      this.app.storyBeatsMiniTimeline.updatePreview(this.edits);
    }
    
    // Notify sync engine
    if (this.app.videoSyncEngine) {
      this.app.videoSyncEngine.onEditAdded(edit);
    }
    
    return edit;
  }

  /**
   * Remove an edit from the queue
   */
  removeEdit(editId) {
    this.edits = this.edits.filter(e => e.id !== editId);
    this.render();
    
    if (this.app.storyBeatsMiniTimeline) {
      this.app.storyBeatsMiniTimeline.updatePreview(this.edits);
    }
  }

  /**
   * Clear all edits
   */
  clearEdits() {
    this.edits = [];
    this.render();
    
    if (this.app.storyBeatsMiniTimeline) {
      this.app.storyBeatsMiniTimeline.updatePreview(this.edits);
    }
  }

  /**
   * Delete the current selection
   */
  deleteSelection() {
    if (!this.selection) return;
    
    const edit = {
      type: 'delete',
      startTime: this.selection.startTime,
      endTime: this.selection.endTime,
      startIndex: this.selection.startIndex,
      endIndex: this.selection.endIndex,
      originalText: this.selection.text
    };
    
    this.addEdit(edit);
    this.clearSelection();
    
    this.app.showToast?.('info', `Marked "${edit.originalText.substring(0, 30)}..." for deletion`);
  }

  /**
   * Insert a gap at the selection point
   */
  insertGapAtSelection(duration = 3.0) {
    if (!this.selection) return;
    
    const edit = {
      type: 'insert_gap',
      insertAfterTime: this.selection.endTime,
      insertAfterIndex: this.selection.endIndex,
      gapDuration: duration
    };
    
    this.addEdit(edit);
    this.clearSelection();
    
    this.app.showToast?.('info', `Inserted ${duration}s gap for new content`);
  }

  /**
   * Mark selection for replacement
   */
  replaceSelection(newText = '') {
    if (!this.selection) return;
    
    const edit = {
      type: 'replace',
      startTime: this.selection.startTime,
      endTime: this.selection.endTime,
      startIndex: this.selection.startIndex,
      endIndex: this.selection.endIndex,
      originalText: this.selection.text,
      newText: newText
    };
    
    this.addEdit(edit);
    this.clearSelection();
    
    this.app.showToast?.('info', 'Marked for replacement');
  }

  /**
   * Create a new marker from selection
   */
  createMarkerFromSelection() {
    if (!this.selection) return;
    
    // Open marker modal with the selection info
    if (this.app.markerModal) {
      this.app.markerModal.rangeInTime = this.selection.startTime;
      this.app.markerModal.rangeOutTime = this.selection.endTime;
      this.app.markerModal.selectedType = 'range';
      this.app.markerModal.show(this.selection.startTime, null, 'range');
      
      // Pre-fill transcription
      const transcriptField = document.getElementById('markerTranscription');
      if (transcriptField) {
        transcriptField.value = this.selection.text;
      }
    }
    
    this.clearSelection();
  }

  /**
   * Get all pending edits
   */
  getEdits() {
    return [...this.edits];
  }

  /**
   * Check if there are pending edits
   */
  hasEdits() {
    return this.edits.length > 0;
  }

  /**
   * Scroll to a specific time in the editor
   */
  scrollToTime(time) {
    const wordIndex = this.words.findIndex(w => w.start >= time);
    if (wordIndex === -1) return;
    
    const wordEl = this.editorContent?.querySelector(`[data-index="${wordIndex}"]`);
    if (wordEl) {
      wordEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  /**
   * Refresh the editor (reload data and re-render)
   */
  refresh() {
    this.loadTranscriptWithSpeakers();
    this.loadMarkers();
    this.parseDialogueBlocks();
    this.render();
  }
}


