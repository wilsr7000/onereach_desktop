/**
 * PlanningPanel - Sidebar panel for pre-production planning
 * 
 * Manages characters, scenes, locations, and story beats before
 * generating the Line Script. Data flows into StoryBeatsEditor,
 * MarkerManager, and TranscriptionService.
 * 
 * @module src/video-editor/planning/PlanningPanel
 */

export class PlanningPanel {
  constructor(appContext) {
    this.app = appContext;
    this.visible = false;
    this.activeTab = 'characters';
    
    // Planning data
    this.planning = {
      characters: [],
      scenes: [],
      locations: [],
      storyBeats: []
    };
    
    // Selection state
    this.selectedCharacterId = null;
    this.selectedSceneId = null;
    this.selectedLocationId = null;
    this.selectedBeatId = null;
    
    // ID counters
    this.nextCharacterId = 1;
    this.nextSceneId = 1;
    this.nextLocationId = 1;
    this.nextBeatId = 1;
    
    // Default colors for characters
    this.characterColors = [
      '#8b5cf6', // Purple
      '#22c55e', // Green
      '#f59e0b', // Amber
      '#ef4444', // Red
      '#3b82f6', // Blue
      '#ec4899', // Pink
      '#14b8a6', // Teal
      '#f97316'  // Orange
    ];
    
    // DOM references
    this.sidebar = null;
    this.tabContents = {};
    
    // Bind methods
    this.toggle = this.toggle.bind(this);
    this.switchTab = this.switchTab.bind(this);
  }

  /**
   * Initialize the planning panel
   */
  init() {
    this.sidebar = document.getElementById('planningSidebar');
    
    if (!this.sidebar) {
      console.warn('[PlanningPanel] Sidebar element not found');
      return;
    }
    
    // Get tab content containers
    this.tabContents = {
      characters: document.getElementById('planningCharactersTab'),
      scenes: document.getElementById('planningScenesTab'),
      locations: document.getElementById('planningLocationsTab'),
      beats: document.getElementById('planningBeatsTab')
    };
    
    // Load planning data from current version if available
    this.loadFromVersion();
    
    // Initial render
    this.renderAll();
    
    console.log('[PlanningPanel] Initialized');
  }

  /**
   * Toggle panel visibility
   */
  toggle() {
    this.visible = !this.visible;
    
    if (this.sidebar) {
      this.sidebar.classList.toggle('hidden', !this.visible);
    }
    
    // Update toggle button state
    const toggleBtn = document.getElementById('planningToggleBtn');
    if (toggleBtn) {
      toggleBtn.classList.toggle('active', this.visible);
    }
    
    console.log('[PlanningPanel] Visibility:', this.visible);
  }

  /**
   * Show the panel
   */
  show() {
    if (!this.visible) {
      this.toggle();
    }
  }

  /**
   * Hide the panel
   */
  hide() {
    if (this.visible) {
      this.toggle();
    }
  }

  /**
   * Switch active tab
   * @param {string} tabName - Tab to switch to
   */
  switchTab(tabName) {
    if (!this.tabContents[tabName]) return;
    
    this.activeTab = tabName;
    
    // Update tab buttons
    document.querySelectorAll('.planning-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.tab === tabName);
    });
    
    // Update tab content visibility
    Object.entries(this.tabContents).forEach(([name, content]) => {
      if (content) {
        content.classList.toggle('active', name === tabName);
      }
    });
  }

  /**
   * Load planning data from current version
   */
  loadFromVersion() {
    const versionData = this.app.versionData;
    
    if (versionData?.planning) {
      this.planning = {
        characters: versionData.planning.characters || [],
        scenes: versionData.planning.scenes || [],
        locations: versionData.planning.locations || [],
        storyBeats: versionData.planning.storyBeats || []
      };
      
      // Update ID counters
      this.nextCharacterId = Math.max(1, ...this.planning.characters.map(c => c.id || 0)) + 1;
      this.nextSceneId = Math.max(1, ...this.planning.scenes.map(s => s.id || 0)) + 1;
      this.nextLocationId = Math.max(1, ...this.planning.locations.map(l => l.id || 0)) + 1;
      this.nextBeatId = Math.max(1, ...this.planning.storyBeats.map(b => b.id || 0)) + 1;
      
      console.log('[PlanningPanel] Loaded planning data:', {
        characters: this.planning.characters.length,
        scenes: this.planning.scenes.length,
        locations: this.planning.locations.length,
        storyBeats: this.planning.storyBeats.length
      });
    }
  }

  /**
   * Save planning data to app state (will be saved with version)
   */
  saveToAppState() {
    this.app.planning = this.planning;
    console.log('[PlanningPanel] Saved planning data to app state');
  }

  /**
   * Get planning data for saving
   * @returns {Object} Planning data
   */
  getPlanningData() {
    return { ...this.planning };
  }

  /**
   * Set planning data (e.g., from import)
   * @param {Object} data - Planning data to set
   */
  setPlanningData(data) {
    if (data) {
      this.planning = {
        characters: data.characters || [],
        scenes: data.scenes || [],
        locations: data.locations || [],
        storyBeats: data.storyBeats || []
      };
      this.saveToAppState();
      this.renderAll();
    }
  }

  /**
   * Render all lists
   */
  renderAll() {
    this.renderCharacters();
    this.renderScenes();
    this.renderLocations();
    this.renderStoryBeats();
  }

  // ==================== CHARACTERS ====================

  /**
   * Add a new character
   * @param {Object} data - Optional character data
   * @returns {Object} Created character
   */
  addCharacter(data = {}) {
    const colorIndex = this.planning.characters.length % this.characterColors.length;
    
    const character = {
      id: this.nextCharacterId++,
      name: data.name || `Character ${this.planning.characters.length + 1}`,
      role: data.role || '',
      color: data.color || this.characterColors[colorIndex],
      speakerIds: data.speakerIds || []
    };
    
    this.planning.characters.push(character);
    this.saveToAppState();
    this.renderCharacters();
    
    // Open edit modal
    this.editCharacter(character.id);
    
    return character;
  }

  /**
   * Update a character
   * @param {number} id - Character ID
   * @param {Object} updates - Updates to apply
   */
  updateCharacter(id, updates) {
    const character = this.planning.characters.find(c => c.id === id);
    if (character) {
      Object.assign(character, updates);
      this.saveToAppState();
      this.renderCharacters();
    }
  }

  /**
   * Delete a character
   * @param {number} id - Character ID
   */
  deleteCharacter(id) {
    const index = this.planning.characters.findIndex(c => c.id === id);
    if (index !== -1) {
      this.planning.characters.splice(index, 1);
      this.saveToAppState();
      this.renderCharacters();
    }
  }

  /**
   * Map a speaker ID to a character
   * @param {number} characterId - Character ID
   * @param {string} speakerId - ElevenLabs speaker ID
   */
  mapSpeakerToCharacter(characterId, speakerId) {
    const character = this.planning.characters.find(c => c.id === characterId);
    if (character) {
      if (!character.speakerIds.includes(speakerId)) {
        character.speakerIds.push(speakerId);
        this.saveToAppState();
        this.renderCharacters();
      }
    }
  }

  /**
   * Get character by speaker ID
   * @param {string} speakerId - Speaker ID from transcript
   * @returns {Object|null} Character or null
   */
  getCharacterBySpeakerId(speakerId) {
    return this.planning.characters.find(c => 
      c.speakerIds && c.speakerIds.includes(speakerId)
    ) || null;
  }

  /**
   * Render characters list
   */
  renderCharacters() {
    const container = document.getElementById('charactersList');
    if (!container) return;
    
    if (this.planning.characters.length === 0) {
      container.innerHTML = `
        <div class="planning-empty">
          <div class="planning-empty-icon">👤</div>
          <div class="planning-empty-text">
            No characters defined yet.<br>
            Add characters to map speaker IDs.
          </div>
        </div>
      `;
      return;
    }
    
    container.innerHTML = this.planning.characters.map(char => `
      <div class="planning-item character-item ${this.selectedCharacterId === char.id ? 'selected' : ''}"
           data-character-id="${char.id}"
           onclick="app.planningPanel.selectCharacter(${char.id})">
        <div class="planning-item-header">
          <div class="planning-item-color" style="background: ${char.color}"></div>
          <span class="planning-item-name">${this.escapeHtml(char.name)}</span>
          ${char.role ? `<span class="planning-item-badge">${this.escapeHtml(char.role)}</span>` : ''}
        </div>
        ${char.speakerIds && char.speakerIds.length > 0 ? `
          <div class="character-speaker-ids">
            ${char.speakerIds.map(id => `<span class="speaker-id-badge">Speaker ${id}</span>`).join('')}
          </div>
        ` : ''}
        <div class="planning-item-actions">
          <button class="planning-item-btn" onclick="event.stopPropagation(); app.planningPanel.editCharacter(${char.id})">Edit</button>
          <button class="planning-item-btn" onclick="event.stopPropagation(); app.planningPanel.showMapSpeakerDialog(${char.id})">Map Speaker</button>
          <button class="planning-item-btn" onclick="event.stopPropagation(); app.planningPanel.deleteCharacter(${char.id})">Delete</button>
        </div>
      </div>
    `).join('');
  }

  /**
   * Select a character
   * @param {number} id - Character ID
   */
  selectCharacter(id) {
    this.selectedCharacterId = this.selectedCharacterId === id ? null : id;
    this.renderCharacters();
  }

  /**
   * Edit a character (show modal)
   * @param {number} id - Character ID
   */
  editCharacter(id) {
    const character = this.planning.characters.find(c => c.id === id);
    if (!character) return;
    
    const name = prompt('Character name:', character.name);
    if (name !== null) {
      const role = prompt('Character role (e.g., Host, Guest, Narrator):', character.role || '');
      this.updateCharacter(id, { name, role: role || '' });
    }
  }

  /**
   * Show dialog to map speaker ID to character
   * @param {number} characterId - Character ID
   */
  showMapSpeakerDialog(characterId) {
    // Get available speaker IDs from transcript
    const speakerIds = this.getAvailableSpeakerIds();
    
    if (speakerIds.length === 0) {
      this.app.showToast?.('info', 'No speakers found in transcript. Transcribe video first.');
      return;
    }
    
    const speakerId = prompt(
      `Map speaker to character.\nAvailable speaker IDs: ${speakerIds.join(', ')}\n\nEnter speaker ID:`,
      speakerIds[0]
    );
    
    if (speakerId !== null && speakerId.trim()) {
      this.mapSpeakerToCharacter(characterId, speakerId.trim());
      this.app.showToast?.('success', `Mapped Speaker ${speakerId} to character`);
    }
  }

  /**
   * Get available speaker IDs from transcript
   * @returns {Array} Speaker IDs
   */
  getAvailableSpeakerIds() {
    const speakerIds = new Set();
    
    // Check transcriptSegments for speaker info
    if (this.app.transcriptSegments) {
      this.app.transcriptSegments.forEach(seg => {
        if (seg.speaker || seg.speakerId) {
          speakerIds.add(String(seg.speaker || seg.speakerId));
        }
      });
    }
    
    // Check teleprompter words
    if (this.app.teleprompterWords) {
      this.app.teleprompterWords.forEach(word => {
        if (word.speaker) {
          speakerIds.add(String(word.speaker));
        }
      });
    }
    
    return Array.from(speakerIds).sort();
  }

  // ==================== SCENES ====================

  /**
   * Add a new scene
   * @param {Object} data - Optional scene data
   * @returns {Object} Created scene
   */
  addScene(data = {}) {
    const scene = {
      id: this.nextSceneId++,
      title: data.title || `Scene ${this.planning.scenes.length + 1}`,
      description: data.description || '',
      intExt: data.intExt || 'INT',
      location: data.location || '',
      timeOfDay: data.timeOfDay || 'DAY',
      order: data.order ?? this.planning.scenes.length
    };
    
    this.planning.scenes.push(scene);
    this.planning.scenes.sort((a, b) => a.order - b.order);
    this.saveToAppState();
    this.renderScenes();
    
    // Open edit modal
    this.editScene(scene.id);
    
    return scene;
  }

  /**
   * Update a scene
   * @param {number} id - Scene ID
   * @param {Object} updates - Updates to apply
   */
  updateScene(id, updates) {
    const scene = this.planning.scenes.find(s => s.id === id);
    if (scene) {
      Object.assign(scene, updates);
      this.planning.scenes.sort((a, b) => a.order - b.order);
      this.saveToAppState();
      this.renderScenes();
    }
  }

  /**
   * Delete a scene
   * @param {number} id - Scene ID
   */
  deleteScene(id) {
    const index = this.planning.scenes.findIndex(s => s.id === id);
    if (index !== -1) {
      this.planning.scenes.splice(index, 1);
      // Re-order remaining scenes
      this.planning.scenes.forEach((s, i) => s.order = i);
      this.saveToAppState();
      this.renderScenes();
    }
  }

  /**
   * Move scene in order
   * @param {number} id - Scene ID
   * @param {number} direction - -1 for up, 1 for down
   */
  moveScene(id, direction) {
    const index = this.planning.scenes.findIndex(s => s.id === id);
    if (index === -1) return;
    
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= this.planning.scenes.length) return;
    
    // Swap
    [this.planning.scenes[index], this.planning.scenes[newIndex]] = 
    [this.planning.scenes[newIndex], this.planning.scenes[index]];
    
    // Update order values
    this.planning.scenes.forEach((s, i) => s.order = i);
    
    this.saveToAppState();
    this.renderScenes();
  }

  /**
   * Render scenes list
   */
  renderScenes() {
    const container = document.getElementById('scenesList');
    if (!container) return;
    
    if (this.planning.scenes.length === 0) {
      container.innerHTML = `
        <div class="planning-empty">
          <div class="planning-empty-icon">🎬</div>
          <div class="planning-empty-text">
            No scenes defined yet.<br>
            Add scenes to structure your content.
          </div>
        </div>
      `;
      return;
    }
    
    container.innerHTML = this.planning.scenes.map((scene, index) => `
      <div class="planning-item scene-item ${this.selectedSceneId === scene.id ? 'selected' : ''}"
           data-scene-id="${scene.id}"
           onclick="app.planningPanel.selectScene(${scene.id})">
        <div class="planning-item-header">
          <span class="planning-item-badge">${index + 1}</span>
          <span class="planning-item-name">${this.escapeHtml(scene.title)}</span>
        </div>
        <div class="planning-item-meta">
          <span class="scene-int-ext">${scene.intExt}.</span>
          ${scene.location ? `<span class="scene-location">${this.escapeHtml(scene.location)}</span>` : ''}
          <span class="scene-time-of-day">- ${scene.timeOfDay}</span>
        </div>
        ${scene.description ? `<div class="planning-item-meta" style="margin-top: 4px;">${this.escapeHtml(scene.description).substring(0, 60)}${scene.description.length > 60 ? '...' : ''}</div>` : ''}
        <div class="planning-item-actions">
          <button class="planning-item-btn" onclick="event.stopPropagation(); app.planningPanel.moveScene(${scene.id}, -1)" ${index === 0 ? 'disabled' : ''}>↑</button>
          <button class="planning-item-btn" onclick="event.stopPropagation(); app.planningPanel.moveScene(${scene.id}, 1)" ${index === this.planning.scenes.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="planning-item-btn" onclick="event.stopPropagation(); app.planningPanel.editScene(${scene.id})">Edit</button>
          <button class="planning-item-btn" onclick="event.stopPropagation(); app.planningPanel.deleteScene(${scene.id})">Delete</button>
        </div>
      </div>
    `).join('');
  }

  /**
   * Select a scene
   * @param {number} id - Scene ID
   */
  selectScene(id) {
    this.selectedSceneId = this.selectedSceneId === id ? null : id;
    this.renderScenes();
  }

  /**
   * Edit a scene (show modal)
   * @param {number} id - Scene ID
   */
  editScene(id) {
    const scene = this.planning.scenes.find(s => s.id === id);
    if (!scene) return;
    
    const title = prompt('Scene title:', scene.title);
    if (title !== null) {
      const intExt = prompt('INT or EXT:', scene.intExt || 'INT');
      const location = prompt('Location:', scene.location || '');
      const timeOfDay = prompt('Time of day (DAY, NIGHT, DAWN, DUSK, etc.):', scene.timeOfDay || 'DAY');
      const description = prompt('Description (optional):', scene.description || '');
      
      this.updateScene(id, {
        title,
        intExt: (intExt || 'INT').toUpperCase(),
        location: location || '',
        timeOfDay: (timeOfDay || 'DAY').toUpperCase(),
        description: description || ''
      });
    }
  }

  /**
   * Generate timeline markers from scenes
   */
  async generateMarkersFromScenes() {
    if (this.planning.scenes.length === 0) {
      this.app.showToast?.('info', 'No scenes to generate markers from');
      return;
    }
    
    const confirm = window.confirm(
      `Generate ${this.planning.scenes.length} marker(s) from scenes?\n\n` +
      'Note: You will need to set the in/out times for each marker manually.'
    );
    
    if (!confirm) return;
    
    let created = 0;
    for (const scene of this.planning.scenes) {
      const sceneHeader = `${scene.intExt}. ${scene.location || scene.title} - ${scene.timeOfDay}`;
      
      // Add as spot marker (user will convert to range and set times)
      if (this.app.addMarker) {
        this.app.addMarker({
          type: 'spot',
          time: 0, // User will position
          name: scene.title,
          description: `${sceneHeader}\n${scene.description || ''}`.trim(),
          color: '#4a9eff'
        });
        created++;
      }
    }
    
    this.app.showToast?.('success', `Created ${created} markers from scenes`);
  }

  // ==================== LOCATIONS ====================

  /**
   * Add a new location
   * @param {Object} data - Optional location data
   * @returns {Object} Created location
   */
  addLocation(data = {}) {
    const location = {
      id: this.nextLocationId++,
      name: data.name || `Location ${this.planning.locations.length + 1}`,
      intExt: data.intExt || 'INT',
      description: data.description || ''
    };
    
    this.planning.locations.push(location);
    this.saveToAppState();
    this.renderLocations();
    
    // Open edit modal
    this.editLocation(location.id);
    
    return location;
  }

  /**
   * Update a location
   * @param {number} id - Location ID
   * @param {Object} updates - Updates to apply
   */
  updateLocation(id, updates) {
    const location = this.planning.locations.find(l => l.id === id);
    if (location) {
      Object.assign(location, updates);
      this.saveToAppState();
      this.renderLocations();
    }
  }

  /**
   * Delete a location
   * @param {number} id - Location ID
   */
  deleteLocation(id) {
    const index = this.planning.locations.findIndex(l => l.id === id);
    if (index !== -1) {
      this.planning.locations.splice(index, 1);
      this.saveToAppState();
      this.renderLocations();
    }
  }

  /**
   * Render locations list
   */
  renderLocations() {
    const container = document.getElementById('locationsList');
    if (!container) return;
    
    if (this.planning.locations.length === 0) {
      container.innerHTML = `
        <div class="planning-empty">
          <div class="planning-empty-icon">📍</div>
          <div class="planning-empty-text">
            No locations defined yet.<br>
            Add locations for scene headers.
          </div>
        </div>
      `;
      return;
    }
    
    container.innerHTML = this.planning.locations.map(loc => `
      <div class="planning-item ${this.selectedLocationId === loc.id ? 'selected' : ''}"
           data-location-id="${loc.id}"
           onclick="app.planningPanel.selectLocation(${loc.id})">
        <div class="planning-item-header">
          <span class="planning-item-badge">${loc.intExt}</span>
          <span class="planning-item-name">${this.escapeHtml(loc.name)}</span>
        </div>
        ${loc.description ? `<div class="planning-item-meta">${this.escapeHtml(loc.description).substring(0, 60)}${loc.description.length > 60 ? '...' : ''}</div>` : ''}
        <div class="planning-item-actions">
          <button class="planning-item-btn" onclick="event.stopPropagation(); app.planningPanel.editLocation(${loc.id})">Edit</button>
          <button class="planning-item-btn" onclick="event.stopPropagation(); app.planningPanel.deleteLocation(${loc.id})">Delete</button>
        </div>
      </div>
    `).join('');
  }

  /**
   * Select a location
   * @param {number} id - Location ID
   */
  selectLocation(id) {
    this.selectedLocationId = this.selectedLocationId === id ? null : id;
    this.renderLocations();
  }

  /**
   * Edit a location (show modal)
   * @param {number} id - Location ID
   */
  editLocation(id) {
    const location = this.planning.locations.find(l => l.id === id);
    if (!location) return;
    
    const name = prompt('Location name:', location.name);
    if (name !== null) {
      const intExt = prompt('INT or EXT:', location.intExt || 'INT');
      const description = prompt('Description (optional):', location.description || '');
      
      this.updateLocation(id, {
        name,
        intExt: (intExt || 'INT').toUpperCase(),
        description: description || ''
      });
    }
  }

  // ==================== STORY BEATS ====================

  /**
   * Add a new story beat
   * @param {Object} data - Optional beat data
   * @returns {Object} Created beat
   */
  addStoryBeat(data = {}) {
    const beat = {
      id: this.nextBeatId++,
      title: data.title || `Beat ${this.planning.storyBeats.length + 1}`,
      description: data.description || '',
      sceneId: data.sceneId || null,
      order: data.order ?? this.planning.storyBeats.length
    };
    
    this.planning.storyBeats.push(beat);
    this.planning.storyBeats.sort((a, b) => a.order - b.order);
    this.saveToAppState();
    this.renderStoryBeats();
    
    // Open edit modal
    this.editStoryBeat(beat.id);
    
    return beat;
  }

  /**
   * Update a story beat
   * @param {number} id - Beat ID
   * @param {Object} updates - Updates to apply
   */
  updateStoryBeat(id, updates) {
    const beat = this.planning.storyBeats.find(b => b.id === id);
    if (beat) {
      Object.assign(beat, updates);
      this.planning.storyBeats.sort((a, b) => a.order - b.order);
      this.saveToAppState();
      this.renderStoryBeats();
    }
  }

  /**
   * Delete a story beat
   * @param {number} id - Beat ID
   */
  deleteStoryBeat(id) {
    const index = this.planning.storyBeats.findIndex(b => b.id === id);
    if (index !== -1) {
      this.planning.storyBeats.splice(index, 1);
      this.planning.storyBeats.forEach((b, i) => b.order = i);
      this.saveToAppState();
      this.renderStoryBeats();
    }
  }

  /**
   * Move story beat in order
   * @param {number} id - Beat ID
   * @param {number} direction - -1 for up, 1 for down
   */
  moveStoryBeat(id, direction) {
    const index = this.planning.storyBeats.findIndex(b => b.id === id);
    if (index === -1) return;
    
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= this.planning.storyBeats.length) return;
    
    [this.planning.storyBeats[index], this.planning.storyBeats[newIndex]] = 
    [this.planning.storyBeats[newIndex], this.planning.storyBeats[index]];
    
    this.planning.storyBeats.forEach((b, i) => b.order = i);
    
    this.saveToAppState();
    this.renderStoryBeats();
  }

  /**
   * Render story beats list
   */
  renderStoryBeats() {
    const container = document.getElementById('storyBeatsList');
    if (!container) return;
    
    if (this.planning.storyBeats.length === 0) {
      container.innerHTML = `
        <div class="planning-empty">
          <div class="planning-empty-icon">⭐</div>
          <div class="planning-empty-text">
            No story beats defined yet.<br>
            Add beats to outline your narrative.
          </div>
        </div>
      `;
      return;
    }
    
    container.innerHTML = this.planning.storyBeats.map((beat, index) => {
      const scene = beat.sceneId ? this.planning.scenes.find(s => s.id === beat.sceneId) : null;
      return `
        <div class="planning-item ${this.selectedBeatId === beat.id ? 'selected' : ''}"
             data-beat-id="${beat.id}"
             onclick="app.planningPanel.selectStoryBeat(${beat.id})">
          <div class="planning-item-header">
            <span class="planning-item-badge">${index + 1}</span>
            <span class="planning-item-name">${this.escapeHtml(beat.title)}</span>
          </div>
          ${scene ? `<div class="planning-item-meta">Scene: ${this.escapeHtml(scene.title)}</div>` : ''}
          ${beat.description ? `<div class="planning-item-meta">${this.escapeHtml(beat.description).substring(0, 60)}${beat.description.length > 60 ? '...' : ''}</div>` : ''}
          <div class="planning-item-actions">
            <button class="planning-item-btn" onclick="event.stopPropagation(); app.planningPanel.moveStoryBeat(${beat.id}, -1)" ${index === 0 ? 'disabled' : ''}>↑</button>
            <button class="planning-item-btn" onclick="event.stopPropagation(); app.planningPanel.moveStoryBeat(${beat.id}, 1)" ${index === this.planning.storyBeats.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="planning-item-btn" onclick="event.stopPropagation(); app.planningPanel.editStoryBeat(${beat.id})">Edit</button>
            <button class="planning-item-btn" onclick="event.stopPropagation(); app.planningPanel.deleteStoryBeat(${beat.id})">Delete</button>
          </div>
        </div>
      `;
    }).join('');
  }

  /**
   * Select a story beat
   * @param {number} id - Beat ID
   */
  selectStoryBeat(id) {
    this.selectedBeatId = this.selectedBeatId === id ? null : id;
    this.renderStoryBeats();
  }

  /**
   * Edit a story beat (show modal)
   * @param {number} id - Beat ID
   */
  editStoryBeat(id) {
    const beat = this.planning.storyBeats.find(b => b.id === id);
    if (!beat) return;
    
    const title = prompt('Beat title:', beat.title);
    if (title !== null) {
      const description = prompt('Description:', beat.description || '');
      
      // Scene selection
      let sceneId = beat.sceneId;
      if (this.planning.scenes.length > 0) {
        const sceneOptions = this.planning.scenes.map(s => `${s.id}: ${s.title}`).join('\n');
        const sceneInput = prompt(
          `Link to scene (enter scene ID or leave empty):\n${sceneOptions}`,
          beat.sceneId || ''
        );
        sceneId = sceneInput ? parseInt(sceneInput) || null : null;
      }
      
      this.updateStoryBeat(id, {
        title,
        description: description || '',
        sceneId
      });
    }
  }

  // ==================== IMPORT/EXPORT ====================

  /**
   * Export planning data to JSON
   */
  exportPlanning() {
    const data = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      planning: this.planning
    };
    
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `planning-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    this.app.showToast?.('success', 'Planning data exported');
  }

  /**
   * Import planning data from JSON
   */
  async importPlanning() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        
        if (data.planning) {
          this.setPlanningData(data.planning);
          this.app.showToast?.('success', 'Planning data imported');
        } else {
          throw new Error('Invalid planning file format');
        }
      } catch (error) {
        console.error('[PlanningPanel] Import error:', error);
        this.app.showToast?.('error', 'Failed to import planning data');
      }
    };
    
    input.click();
  }

  // ==================== UTILITIES ====================

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
}

export default PlanningPanel;


