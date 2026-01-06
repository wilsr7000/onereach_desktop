/**
 * NotesPanel - Production notes management panel
 * 
 * Tabbed interface for:
 * - Director Notes - Free-form notes with timestamps
 * - Script Supervisor - Continuity, timing, technical notes
 * - Technical - Camera, lens, lighting, sound settings
 * - Takes - Take numbers, circle takes, print notes
 */

export class NotesPanel {
  constructor(appContext) {
    this.app = appContext;
    this.panelElement = null;
    this.isVisible = false;
    
    // Current state
    this.currentMarkerId = null;
    this.currentTab = 'director';
    
    // Notes data (keyed by markerId)
    this.directorNotes = {};
    this.supervisorNotes = {};
    this.technicalNotes = {};
    this.takes = {};
    
    // Create panel
    this._createPanel();
  }

  /**
   * Create the panel DOM structure
   */
  _createPanel() {
    // Check if panel already exists
    this.panelElement = document.getElementById('notesPanelOverlay');
    
    if (!this.panelElement) {
      this.panelElement = document.createElement('div');
      this.panelElement.id = 'notesPanelOverlay';
      this.panelElement.className = 'notes-panel-overlay';
      this.panelElement.innerHTML = this._getPanelHTML();
      document.body.appendChild(this.panelElement);
      
      // Add styles
      this._addStyles();
    }
    
    this._setupEventListeners();
  }

  /**
   * Get panel HTML template
   */
  _getPanelHTML() {
    return `
      <div class="notes-panel">
        <div class="notes-panel-header">
          <h3 class="notes-panel-title">
            <span class="notes-panel-icon">📝</span>
            <span id="notesPanelTitle">Scene Notes</span>
          </h3>
          <button class="notes-panel-close" data-action="close">&times;</button>
        </div>
        
        <div class="notes-panel-tabs">
          <button class="notes-tab active" data-tab="director">
            <span class="tab-icon">🎬</span>
            Director
          </button>
          <button class="notes-tab" data-tab="supervisor">
            <span class="tab-icon">📋</span>
            Script Sup
          </button>
          <button class="notes-tab" data-tab="technical">
            <span class="tab-icon">🎥</span>
            Technical
          </button>
          <button class="notes-tab" data-tab="takes">
            <span class="tab-icon">🎬</span>
            Takes
          </button>
        </div>
        
        <div class="notes-panel-content">
          <!-- Director Notes Tab -->
          <div class="notes-tab-content active" id="directorTabContent">
            <div class="notes-toolbar">
              <button class="notes-btn" id="addDirectorNote">
                <span>+ Add Note</span>
              </button>
            </div>
            <div class="notes-list" id="directorNotesList">
              <div class="notes-empty">No director notes yet</div>
            </div>
          </div>
          
          <!-- Supervisor Notes Tab -->
          <div class="notes-tab-content" id="supervisorTabContent">
            <div class="notes-toolbar">
              <button class="notes-btn" id="addSupervisorNote">
                <span>+ Add Note</span>
              </button>
              <select id="supervisorNoteType" class="notes-select">
                <option value="continuity">Continuity</option>
                <option value="timing">Timing</option>
                <option value="coverage">Coverage</option>
                <option value="pickup">Pick-up</option>
                <option value="general">General</option>
              </select>
            </div>
            <div class="notes-list" id="supervisorNotesList">
              <div class="notes-empty">No supervisor notes yet</div>
            </div>
          </div>
          
          <!-- Technical Notes Tab -->
          <div class="notes-tab-content" id="technicalTabContent">
            <div class="technical-form">
              <div class="form-group">
                <label>Camera</label>
                <input type="text" id="techCamera" class="notes-input" placeholder="e.g., ARRI Alexa Mini">
              </div>
              <div class="form-group">
                <label>Lens</label>
                <input type="text" id="techLens" class="notes-input" placeholder="e.g., 50mm f/1.4">
              </div>
              <div class="form-group">
                <label>Lighting</label>
                <textarea id="techLighting" class="notes-textarea" placeholder="Lighting setup notes..."></textarea>
              </div>
              <div class="form-group">
                <label>Sound</label>
                <input type="text" id="techSound" class="notes-input" placeholder="e.g., Boom + Lav">
              </div>
              <div class="form-group">
                <label>Frame Rate</label>
                <input type="text" id="techFrameRate" class="notes-input" placeholder="e.g., 24fps">
              </div>
              <div class="form-group">
                <label>Additional Notes</label>
                <textarea id="techNotes" class="notes-textarea" placeholder="Other technical details..."></textarea>
              </div>
            </div>
          </div>
          
          <!-- Takes Tab -->
          <div class="notes-tab-content" id="takesTabContent">
            <div class="notes-toolbar">
              <button class="notes-btn" id="addTake">
                <span>+ Add Take</span>
              </button>
            </div>
            <div class="takes-list" id="takesList">
              <div class="notes-empty">No takes recorded yet</div>
            </div>
          </div>
        </div>
        
        <div class="notes-panel-footer">
          <button class="btn btn-secondary" data-action="cancel">Cancel</button>
          <button class="btn btn-primary" data-action="save">
            <span>💾 Save Notes</span>
          </button>
        </div>
      </div>
    `;
  }

  /**
   * Add component styles
   */
  _addStyles() {
    if (document.getElementById('notesPanelStyles')) return;
    
    const styleSheet = document.createElement('style');
    styleSheet.id = 'notesPanelStyles';
    styleSheet.textContent = `
      .notes-panel-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10001;
        opacity: 0;
        visibility: hidden;
        transition: opacity 0.2s, visibility 0.2s;
      }
      
      .notes-panel-overlay.visible {
        opacity: 1;
        visibility: visible;
      }
      
      .notes-panel {
        background: var(--bg-primary, #1a1a2e);
        border-radius: 12px;
        width: 90%;
        max-width: 600px;
        max-height: 80vh;
        display: flex;
        flex-direction: column;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
        border: 1px solid var(--border-color, #333);
      }
      
      .notes-panel-header {
        padding: 16px 20px;
        border-bottom: 1px solid var(--border-color, #333);
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      
      .notes-panel-title {
        margin: 0;
        font-size: 18px;
        color: var(--text-primary, #fff);
        display: flex;
        align-items: center;
        gap: 8px;
      }
      
      .notes-panel-close {
        background: none;
        border: none;
        color: var(--text-secondary, #888);
        font-size: 24px;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 4px;
      }
      
      .notes-panel-close:hover {
        background: var(--bg-hover, #333);
        color: var(--text-primary, #fff);
      }
      
      .notes-panel-tabs {
        display: flex;
        border-bottom: 1px solid var(--border-color, #333);
        padding: 0 16px;
      }
      
      .notes-tab {
        background: none;
        border: none;
        padding: 12px 16px;
        color: var(--text-secondary, #888);
        font-size: 13px;
        cursor: pointer;
        border-bottom: 2px solid transparent;
        display: flex;
        align-items: center;
        gap: 6px;
        transition: color 0.2s, border-color 0.2s;
      }
      
      .notes-tab:hover {
        color: var(--text-primary, #fff);
      }
      
      .notes-tab.active {
        color: var(--accent-color, #4a9eff);
        border-bottom-color: var(--accent-color, #4a9eff);
      }
      
      .notes-panel-content {
        flex: 1;
        overflow-y: auto;
        padding: 16px 20px;
      }
      
      .notes-tab-content {
        display: none;
      }
      
      .notes-tab-content.active {
        display: block;
      }
      
      .notes-toolbar {
        display: flex;
        gap: 8px;
        margin-bottom: 16px;
      }
      
      .notes-btn {
        padding: 8px 16px;
        border-radius: 6px;
        border: 1px solid var(--border-color, #333);
        background: var(--bg-secondary, #252540);
        color: var(--text-primary, #fff);
        font-size: 13px;
        cursor: pointer;
        transition: background 0.2s;
      }
      
      .notes-btn:hover {
        background: var(--bg-hover, #333);
      }
      
      .notes-select {
        padding: 8px 12px;
        border-radius: 6px;
        border: 1px solid var(--border-color, #333);
        background: var(--bg-secondary, #252540);
        color: var(--text-primary, #fff);
        font-size: 13px;
      }
      
      .notes-list, .takes-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      
      .notes-empty {
        text-align: center;
        color: var(--text-secondary, #888);
        padding: 40px;
        font-size: 14px;
      }
      
      .note-item {
        background: var(--bg-secondary, #252540);
        border-radius: 8px;
        padding: 12px;
        border: 1px solid var(--border-color, #333);
      }
      
      .note-item-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 8px;
      }
      
      .note-item-type {
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 4px;
        background: var(--accent-color, #4a9eff);
        color: white;
        text-transform: uppercase;
      }
      
      .note-item-time {
        font-size: 11px;
        color: var(--text-secondary, #888);
      }
      
      .note-item-text {
        font-size: 14px;
        color: var(--text-primary, #fff);
        line-height: 1.5;
      }
      
      .note-item-actions {
        display: flex;
        gap: 8px;
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid var(--border-color, #333);
      }
      
      .note-item-btn {
        background: none;
        border: none;
        color: var(--text-secondary, #888);
        cursor: pointer;
        font-size: 12px;
        padding: 4px 8px;
        border-radius: 4px;
      }
      
      .note-item-btn:hover {
        background: var(--bg-hover, #333);
        color: var(--text-primary, #fff);
      }
      
      .note-item-btn.danger:hover {
        color: #ef4444;
      }
      
      .technical-form {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      
      .form-group {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      
      .form-group label {
        font-size: 12px;
        color: var(--text-secondary, #888);
        font-weight: 500;
      }
      
      .notes-input, .notes-textarea {
        padding: 10px 12px;
        border-radius: 6px;
        border: 1px solid var(--border-color, #333);
        background: var(--bg-secondary, #252540);
        color: var(--text-primary, #fff);
        font-size: 14px;
      }
      
      .notes-textarea {
        min-height: 80px;
        resize: vertical;
      }
      
      .notes-input:focus, .notes-textarea:focus {
        outline: none;
        border-color: var(--accent-color, #4a9eff);
      }
      
      .take-item {
        background: var(--bg-secondary, #252540);
        border-radius: 8px;
        padding: 12px;
        border: 1px solid var(--border-color, #333);
        display: flex;
        align-items: center;
        gap: 12px;
      }
      
      .take-number {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        background: var(--bg-primary, #1a1a2e);
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: bold;
        font-size: 16px;
        color: var(--text-primary, #fff);
      }
      
      .take-number.circled {
        background: var(--accent-color, #4a9eff);
        color: white;
      }
      
      .take-info {
        flex: 1;
      }
      
      .take-duration {
        font-size: 14px;
        color: var(--text-primary, #fff);
      }
      
      .take-notes {
        font-size: 12px;
        color: var(--text-secondary, #888);
        margin-top: 4px;
      }
      
      .take-actions {
        display: flex;
        gap: 4px;
      }
      
      .take-action-btn {
        width: 32px;
        height: 32px;
        border-radius: 4px;
        border: 1px solid var(--border-color, #333);
        background: var(--bg-primary, #1a1a2e);
        color: var(--text-secondary, #888);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
      }
      
      .take-action-btn:hover {
        background: var(--bg-hover, #333);
        color: var(--text-primary, #fff);
      }
      
      .take-action-btn.active {
        background: var(--accent-color, #4a9eff);
        color: white;
        border-color: var(--accent-color, #4a9eff);
      }
      
      .notes-panel-footer {
        padding: 16px 20px;
        border-top: 1px solid var(--border-color, #333);
        display: flex;
        justify-content: flex-end;
        gap: 12px;
      }
      
      .notes-panel .btn {
        padding: 10px 20px;
        border-radius: 6px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.2s;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      
      .notes-panel .btn-secondary {
        background: var(--bg-secondary, #252540);
        border: 1px solid var(--border-color, #333);
        color: var(--text-primary, #fff);
      }
      
      .notes-panel .btn-primary {
        background: var(--accent-color, #4a9eff);
        border: none;
        color: white;
      }
      
      .notes-panel .btn-primary:hover {
        background: var(--accent-hover, #3a8eef);
      }
    `;
    document.head.appendChild(styleSheet);
  }

  /**
   * Setup event listeners
   */
  _setupEventListeners() {
    if (!this.panelElement) return;
    
    // Close and action buttons
    this.panelElement.addEventListener('click', (e) => {
      const action = e.target.dataset?.action || e.target.closest('[data-action]')?.dataset?.action;
      
      if (action === 'close' || action === 'cancel') {
        this.hide();
      } else if (action === 'save') {
        this._saveNotes();
      }
      
      // Close on backdrop click
      if (e.target === this.panelElement) {
        this.hide();
      }
    });
    
    // Tab switching
    this.panelElement.querySelectorAll('.notes-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        this._switchTab(tab.dataset.tab);
      });
    });
    
    // Add director note
    const addDirectorBtn = this.panelElement.querySelector('#addDirectorNote');
    if (addDirectorBtn) {
      addDirectorBtn.addEventListener('click', () => this._addDirectorNote());
    }
    
    // Add supervisor note
    const addSupervisorBtn = this.panelElement.querySelector('#addSupervisorNote');
    if (addSupervisorBtn) {
      addSupervisorBtn.addEventListener('click', () => this._addSupervisorNote());
    }
    
    // Add take
    const addTakeBtn = this.panelElement.querySelector('#addTake');
    if (addTakeBtn) {
      addTakeBtn.addEventListener('click', () => this._addTake());
    }
    
    // Escape to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isVisible) {
        this.hide();
      }
    });
  }

  /**
   * Show the panel for a specific marker
   * @param {string} markerId - Marker ID
   * @param {string} noteType - Initial tab to show
   */
  show(markerId, noteType = 'director') {
    this.currentMarkerId = markerId;
    
    // Get marker info
    const marker = this.app.markerManager?.getById(markerId);
    const markerName = marker?.name || `Marker ${markerId}`;
    
    // Update title
    const titleEl = this.panelElement.querySelector('#notesPanelTitle');
    if (titleEl) {
      titleEl.textContent = `Notes: ${markerName}`;
    }
    
    // Load notes for this marker
    this._loadNotes(markerId);
    
    // Switch to requested tab
    this._switchTab(noteType);
    
    // Show panel
    this.panelElement.classList.add('visible');
    this.isVisible = true;
  }

  /**
   * Hide the panel
   */
  hide() {
    this.panelElement.classList.remove('visible');
    this.isVisible = false;
    this.currentMarkerId = null;
  }

  /**
   * Switch between tabs
   */
  _switchTab(tabId) {
    this.currentTab = tabId;
    
    // Update tab buttons
    this.panelElement.querySelectorAll('.notes-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.tab === tabId);
    });
    
    // Update tab content
    this.panelElement.querySelectorAll('.notes-tab-content').forEach(content => {
      content.classList.toggle('active', content.id === `${tabId}TabContent`);
    });
  }

  /**
   * Load notes for a marker
   */
  _loadNotes(markerId) {
    // Get notes from StoryBeatsEditor if available
    const editor = this.app.storyBeatsEditor;
    
    if (editor) {
      this.directorNotes[markerId] = editor.directorNotes?.[markerId] || [];
      this.supervisorNotes[markerId] = editor.supervisorNotes?.[markerId] || [];
      this.technicalNotes[markerId] = editor.technicalNotes?.[markerId] || {};
      this.takes[markerId] = editor.takes?.[markerId] || [];
    }
    
    // Render all tabs
    this._renderDirectorNotes();
    this._renderSupervisorNotes();
    this._renderTechnicalNotes();
    this._renderTakes();
  }

  /**
   * Render director notes list
   */
  _renderDirectorNotes() {
    const list = this.panelElement.querySelector('#directorNotesList');
    if (!list) return;
    
    const notes = this.directorNotes[this.currentMarkerId] || [];
    
    if (notes.length === 0) {
      list.innerHTML = '<div class="notes-empty">No director notes yet</div>';
      return;
    }
    
    list.innerHTML = notes.map((note, index) => `
      <div class="note-item" data-index="${index}">
        <div class="note-item-header">
          <span class="note-item-type">Director</span>
          <span class="note-item-time">${this._formatTime(note.timestamp)}</span>
        </div>
        <div class="note-item-text">${this._escapeHtml(note.note)}</div>
        <div class="note-item-actions">
          <button class="note-item-btn" data-action="edit-director" data-index="${index}">Edit</button>
          <button class="note-item-btn danger" data-action="delete-director" data-index="${index}">Delete</button>
        </div>
      </div>
    `).join('');
    
    // Add click handlers
    list.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const action = e.target.dataset.action;
        const index = parseInt(e.target.dataset.index);
        
        if (action === 'edit-director') {
          this._editDirectorNote(index);
        } else if (action === 'delete-director') {
          this._deleteDirectorNote(index);
        }
      });
    });
  }

  /**
   * Render supervisor notes list
   */
  _renderSupervisorNotes() {
    const list = this.panelElement.querySelector('#supervisorNotesList');
    if (!list) return;
    
    const notes = this.supervisorNotes[this.currentMarkerId] || [];
    
    if (notes.length === 0) {
      list.innerHTML = '<div class="notes-empty">No supervisor notes yet</div>';
      return;
    }
    
    list.innerHTML = notes.map((note, index) => `
      <div class="note-item" data-index="${index}">
        <div class="note-item-header">
          <span class="note-item-type">${note.type || 'General'}</span>
          <span class="note-item-time">${this._formatTime(note.timestamp)}</span>
        </div>
        <div class="note-item-text">${this._escapeHtml(note.note)}</div>
        <div class="note-item-actions">
          <button class="note-item-btn" data-action="edit-supervisor" data-index="${index}">Edit</button>
          <button class="note-item-btn danger" data-action="delete-supervisor" data-index="${index}">Delete</button>
        </div>
      </div>
    `).join('');
    
    // Add click handlers
    list.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const action = e.target.dataset.action;
        const index = parseInt(e.target.dataset.index);
        
        if (action === 'edit-supervisor') {
          this._editSupervisorNote(index);
        } else if (action === 'delete-supervisor') {
          this._deleteSupervisorNote(index);
        }
      });
    });
  }

  /**
   * Render technical notes form
   */
  _renderTechnicalNotes() {
    const tech = this.technicalNotes[this.currentMarkerId] || {};
    
    const cameraEl = this.panelElement.querySelector('#techCamera');
    const lensEl = this.panelElement.querySelector('#techLens');
    const lightingEl = this.panelElement.querySelector('#techLighting');
    const soundEl = this.panelElement.querySelector('#techSound');
    const frameRateEl = this.panelElement.querySelector('#techFrameRate');
    const notesEl = this.panelElement.querySelector('#techNotes');
    
    if (cameraEl) cameraEl.value = tech.camera || '';
    if (lensEl) lensEl.value = tech.lens || '';
    if (lightingEl) lightingEl.value = tech.lighting || '';
    if (soundEl) soundEl.value = tech.sound || '';
    if (frameRateEl) frameRateEl.value = tech.frameRate || '';
    if (notesEl) notesEl.value = tech.notes || '';
  }

  /**
   * Render takes list
   */
  _renderTakes() {
    const list = this.panelElement.querySelector('#takesList');
    if (!list) return;
    
    const takes = this.takes[this.currentMarkerId] || [];
    
    if (takes.length === 0) {
      list.innerHTML = '<div class="notes-empty">No takes recorded yet</div>';
      return;
    }
    
    list.innerHTML = takes.map((take, index) => `
      <div class="take-item" data-index="${index}">
        <div class="take-number ${take.circled ? 'circled' : ''}">${take.takeNum}</div>
        <div class="take-info">
          <div class="take-duration">${take.duration ? this._formatDuration(take.duration) : 'No duration'}</div>
          <div class="take-notes">${this._escapeHtml(take.notes || 'No notes')}</div>
        </div>
        <div class="take-actions">
          <button class="take-action-btn ${take.circled ? 'active' : ''}" data-action="circle-take" data-index="${index}" title="Circle Take">
            ⭕
          </button>
          <button class="take-action-btn ${take.print ? 'active' : ''}" data-action="print-take" data-index="${index}" title="Print">
            🖨️
          </button>
          <button class="take-action-btn" data-action="edit-take" data-index="${index}" title="Edit">
            ✏️
          </button>
          <button class="take-action-btn" data-action="delete-take" data-index="${index}" title="Delete">
            🗑️
          </button>
        </div>
      </div>
    `).join('');
    
    // Add click handlers
    list.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const action = e.target.dataset.action;
        const index = parseInt(e.target.dataset.index);
        
        if (action === 'circle-take') {
          this._toggleCircleTake(index);
        } else if (action === 'print-take') {
          this._togglePrintTake(index);
        } else if (action === 'edit-take') {
          this._editTake(index);
        } else if (action === 'delete-take') {
          this._deleteTake(index);
        }
      });
    });
  }

  /**
   * Add a new director note
   */
  _addDirectorNote() {
    const note = prompt('Enter director note:');
    if (!note?.trim()) return;
    
    if (!this.directorNotes[this.currentMarkerId]) {
      this.directorNotes[this.currentMarkerId] = [];
    }
    
    this.directorNotes[this.currentMarkerId].push({
      note: note.trim(),
      timestamp: new Date().toISOString()
    });
    
    this._renderDirectorNotes();
  }

  /**
   * Edit a director note
   */
  _editDirectorNote(index) {
    const notes = this.directorNotes[this.currentMarkerId];
    if (!notes || !notes[index]) return;
    
    const newNote = prompt('Edit director note:', notes[index].note);
    if (newNote !== null) {
      notes[index].note = newNote.trim();
      notes[index].modifiedAt = new Date().toISOString();
      this._renderDirectorNotes();
    }
  }

  /**
   * Delete a director note
   */
  _deleteDirectorNote(index) {
    const notes = this.directorNotes[this.currentMarkerId];
    if (!notes || !notes[index]) return;
    
    if (confirm('Delete this note?')) {
      notes.splice(index, 1);
      this._renderDirectorNotes();
    }
  }

  /**
   * Add a new supervisor note
   */
  _addSupervisorNote() {
    const note = prompt('Enter supervisor note:');
    if (!note?.trim()) return;
    
    const typeSelect = this.panelElement.querySelector('#supervisorNoteType');
    const type = typeSelect?.value || 'general';
    
    if (!this.supervisorNotes[this.currentMarkerId]) {
      this.supervisorNotes[this.currentMarkerId] = [];
    }
    
    this.supervisorNotes[this.currentMarkerId].push({
      type,
      note: note.trim(),
      timestamp: new Date().toISOString()
    });
    
    this._renderSupervisorNotes();
  }

  /**
   * Edit a supervisor note
   */
  _editSupervisorNote(index) {
    const notes = this.supervisorNotes[this.currentMarkerId];
    if (!notes || !notes[index]) return;
    
    const newNote = prompt('Edit supervisor note:', notes[index].note);
    if (newNote !== null) {
      notes[index].note = newNote.trim();
      notes[index].modifiedAt = new Date().toISOString();
      this._renderSupervisorNotes();
    }
  }

  /**
   * Delete a supervisor note
   */
  _deleteSupervisorNote(index) {
    const notes = this.supervisorNotes[this.currentMarkerId];
    if (!notes || !notes[index]) return;
    
    if (confirm('Delete this note?')) {
      notes.splice(index, 1);
      this._renderSupervisorNotes();
    }
  }

  /**
   * Add a new take
   */
  _addTake() {
    if (!this.takes[this.currentMarkerId]) {
      this.takes[this.currentMarkerId] = [];
    }
    
    const takeNum = this.takes[this.currentMarkerId].length + 1;
    const notes = prompt(`Notes for Take ${takeNum}:`) || '';
    
    this.takes[this.currentMarkerId].push({
      takeNum,
      notes: notes.trim(),
      circled: false,
      print: false,
      duration: null,
      timestamp: new Date().toISOString()
    });
    
    this._renderTakes();
  }

  /**
   * Toggle circle on a take
   */
  _toggleCircleTake(index) {
    const takes = this.takes[this.currentMarkerId];
    if (!takes || !takes[index]) return;
    
    takes[index].circled = !takes[index].circled;
    this._renderTakes();
  }

  /**
   * Toggle print on a take
   */
  _togglePrintTake(index) {
    const takes = this.takes[this.currentMarkerId];
    if (!takes || !takes[index]) return;
    
    takes[index].print = !takes[index].print;
    this._renderTakes();
  }

  /**
   * Edit a take
   */
  _editTake(index) {
    const takes = this.takes[this.currentMarkerId];
    if (!takes || !takes[index]) return;
    
    const newNotes = prompt('Edit take notes:', takes[index].notes);
    if (newNotes !== null) {
      takes[index].notes = newNotes.trim();
      takes[index].modifiedAt = new Date().toISOString();
      this._renderTakes();
    }
  }

  /**
   * Delete a take
   */
  _deleteTake(index) {
    const takes = this.takes[this.currentMarkerId];
    if (!takes || !takes[index]) return;
    
    if (confirm('Delete this take?')) {
      takes.splice(index, 1);
      // Renumber remaining takes
      takes.forEach((take, i) => take.takeNum = i + 1);
      this._renderTakes();
    }
  }

  /**
   * Save all notes
   */
  _saveNotes() {
    // Collect technical notes from form
    const tech = {
      camera: this.panelElement.querySelector('#techCamera')?.value || '',
      lens: this.panelElement.querySelector('#techLens')?.value || '',
      lighting: this.panelElement.querySelector('#techLighting')?.value || '',
      sound: this.panelElement.querySelector('#techSound')?.value || '',
      frameRate: this.panelElement.querySelector('#techFrameRate')?.value || '',
      notes: this.panelElement.querySelector('#techNotes')?.value || ''
    };
    this.technicalNotes[this.currentMarkerId] = tech;
    
    // Save to StoryBeatsEditor if available
    const editor = this.app.storyBeatsEditor;
    if (editor) {
      editor.directorNotes = { ...editor.directorNotes, ...this.directorNotes };
      editor.supervisorNotes = { ...editor.supervisorNotes, ...this.supervisorNotes };
      editor.technicalNotes = { ...editor.technicalNotes, ...this.technicalNotes };
      editor.takes = { ...editor.takes, ...this.takes };
    }
    
    this.app.showToast?.('success', 'Notes saved');
    this.hide();
  }

  /**
   * Format ISO timestamp
   */
  _formatTime(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    return date.toLocaleString();
  }

  /**
   * Format duration in seconds
   */
  _formatDuration(seconds) {
    if (!seconds) return '';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * Escape HTML entities
   */
  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }
}

export default NotesPanel;








