/**
 * MarkerManager - CRUD operations and data model for markers
 * Handles marker creation, editing, deletion, and sorting
 * 
 * Extended for Line Script System with:
 * - Event emitter for cross-view sync
 * - Content-type specific marker types
 * - Line Script metadata fields
 */

/**
 * Line Script marker types by content template
 */
export const LINE_SCRIPT_MARKER_TYPES = {
  // Universal types
  spot: { id: 'spot', name: 'Marker', icon: '📍' },
  range: { id: 'range', name: 'Scene', icon: '🎬' },
  
  // Podcast types
  quote: { id: 'quote', name: 'Quote', icon: '💬', template: 'podcast' },
  topic: { id: 'topic', name: 'Topic', icon: '📌', template: 'podcast' },
  clip: { id: 'clip', name: 'Clip', icon: '✂️', template: 'podcast' },
  'speaker-change': { id: 'speaker-change', name: 'Speaker', icon: '👤', template: 'podcast' },
  
  // Product types
  feature: { id: 'feature', name: 'Feature', icon: '⭐', template: 'product' },
  demo: { id: 'demo', name: 'Demo', icon: '🎬', template: 'product' },
  broll: { id: 'broll', name: 'B-Roll', icon: '🎥', template: 'product' },
  testimonial: { id: 'testimonial', name: 'Testimonial', icon: '💬', template: 'product' },
  
  // Promo types
  hook: { id: 'hook', name: 'Hook', icon: '🎣', template: 'promo' },
  beat: { id: 'beat', name: 'Beat', icon: '💥', template: 'promo' },
  transition: { id: 'transition', name: 'Transition', icon: '➡️', template: 'promo' },
  logo: { id: 'logo', name: 'Logo', icon: '🏷️', template: 'promo' },
  
  // Learning types
  chapter: { id: 'chapter', name: 'Chapter', icon: '📖', template: 'learning' },
  keypoint: { id: 'keypoint', name: 'Key Point', icon: '💡', template: 'learning' },
  quiz: { id: 'quiz', name: 'Quiz', icon: '❓', template: 'learning' },
  concept: { id: 'concept', name: 'Concept', icon: '🧠', template: 'learning' },
  example: { id: 'example', name: 'Example', icon: '📝', template: 'learning' },
  
  // Analysis types
  zzz: { id: 'zzz', name: 'ZZZ', icon: '💤', template: 'analysis' },
  highlight: { id: 'highlight', name: 'Highlight', icon: '⭐' },
  cta: { id: 'cta', name: 'CTA', icon: '📢' }
};

export class MarkerManager {
  constructor(appContext) {
    this.app = appContext;
    
    // State
    this.markers = [];
    this.nextMarkerId = 1;
    this.colors = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];
    
    // Editing state
    this.editingMarkerId = null;
    this.selectedColor = this.colors[0];
    this.selectedType = 'spot';
    this.rangeInTime = 0;
    this.rangeOutTime = 5;
    
    // Pending range marker
    this.pendingRangeMarker = null;
    
    // Event emitter for cross-view sync
    this.eventListeners = {};
    
    // Line Script marker types reference
    this.markerTypes = LINE_SCRIPT_MARKER_TYPES;
  }
  
  // ==========================================
  // Event Emitter Methods (for cross-view sync)
  // ==========================================
  
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
   * Unsubscribe from an event
   * @param {string} event - Event name
   * @param {Function} callback - Callback to remove
   */
  off(event, callback) {
    if (this.eventListeners[event]) {
      this.eventListeners[event] = this.eventListeners[event].filter(cb => cb !== callback);
    }
  }
  
  /**
   * Emit an event
   * @param {string} event - Event name
   * @param {Object} data - Event data
   */
  emit(event, data = {}) {
    if (this.eventListeners[event]) {
      this.eventListeners[event].forEach(callback => {
        try {
          callback(data);
        } catch (e) {
          window.logging.error('video', 'MarkerManager event callback error', { event, error: e.message || e });
        }
      });
    }
  }

  /**
   * Get all markers
   */
  getAll() {
    return this.markers;
  }

  /**
   * Get marker by ID
   */
  getById(id) {
    return this.markers.find(m => m.id === id);
  }

  /**
   * Add a new spot marker
   * @param {number} time - Time in seconds
   * @param {string} name - Marker name
   * @param {string} color - Marker color
   * @param {Object} metadata - Additional metadata including Line Script fields
   */
  addSpotMarker(time, name, color, metadata = {}) {
    const markerTypeInfo = this.markerTypes[metadata.markerType] || this.markerTypes.spot;
    
    const marker = {
      id: this.nextMarkerId++,
      type: 'spot',
      time: time,
      name: name || `Marker ${this.markers.length + 1}`,
      color: color || markerTypeInfo.color || this.colors[this.markers.length % this.colors.length],
      description: metadata.description || '',
      transcription: metadata.transcription || '',
      tags: metadata.tags || [],
      notes: metadata.notes || '',
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
      
      // Line Script extended fields
      markerType: metadata.markerType || 'spot',
      source: metadata.source || 'manual',  // 'manual', 'keyboard', 'voice', 'ai-suggested'
      templateId: metadata.templateId || null,
      confidence: metadata.confidence || null,
      
      // Line Script metadata object
      lineScript: metadata.lineScript || null
    };
    
    this.markers.push(marker);
    this._sort();
    
    // Emit event for cross-view sync
    this.emit('markerAdded', { marker, type: 'spot' });
    
    return marker;
  }

  /**
   * Add a new range marker
   * @param {number} inTime - IN time in seconds
   * @param {number} outTime - OUT time in seconds
   * @param {string} name - Marker name
   * @param {string} color - Marker color
   * @param {Object} metadata - Additional metadata including Line Script fields
   */
  addRangeMarker(inTime, outTime, name, color, metadata = {}) {
    if (outTime <= inTime) {
      throw new Error('OUT point must be after IN point');
    }
    
    const marker = {
      id: this.nextMarkerId++,
      type: 'range',
      inTime: inTime,
      outTime: outTime,
      duration: outTime - inTime,
      name: name || `Scene ${this.markers.length + 1}`,
      color: color || this.colors[this.markers.length % this.colors.length],
      description: metadata.description || '',
      transcription: metadata.transcription || '',
      tags: metadata.tags || [],
      notes: metadata.notes || '',
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
      
      // Line Script extended fields
      markerType: metadata.markerType || 'range',
      source: metadata.source || 'manual',
      templateId: metadata.templateId || null,
      confidence: metadata.confidence || null,
      
      // Line Script metadata object (can include AI-generated content)
      lineScript: metadata.lineScript || null
    };
    
    this.markers.push(marker);
    this._sort();
    
    // Emit event for cross-view sync
    this.emit('markerAdded', { marker, type: 'range' });
    
    return marker;
  }

  /**
   * Update an existing marker
   * @param {number} id - Marker ID
   * @param {Object} updates - Fields to update
   */
  updateMarker(id, updates) {
    const marker = this.getById(id);
    if (!marker) return null;
    
    const previousState = { ...marker };
    
    Object.assign(marker, updates, {
      modifiedAt: new Date().toISOString()
    });
    
    // Recalculate duration for range markers
    if (marker.type === 'range') {
      marker.duration = marker.outTime - marker.inTime;
    }
    
    this._sort();
    
    // Emit event for cross-view sync
    this.emit('markerUpdated', { marker, previousState, updates });
    
    return marker;
  }

  /**
   * Delete a marker
   * @param {number} id - Marker ID
   */
  deleteMarker(id) {
    const index = this.markers.findIndex(m => m.id === id);
    if (index === -1) return false;
    
    const deletedMarker = this.markers[index];
    this.markers.splice(index, 1);
    
    // Emit event for cross-view sync
    this.emit('markerDeleted', { marker: deletedMarker, id });
    
    return true;
  }

  /**
   * Clear all markers
   */
  clearAll() {
    this.markers = [];
    this.nextMarkerId = 1;
  }

  /**
   * Import markers (from Space or file)
   */
  importMarkers(markersData) {
    if (!Array.isArray(markersData)) return;
    
    this.markers = markersData.map(m => ({
      ...m,
      id: m.id || this.nextMarkerId++
    }));
    
    // Update nextMarkerId to be higher than any imported ID
    const maxId = Math.max(...this.markers.map(m => m.id), 0);
    this.nextMarkerId = maxId + 1;
    
    this._sort();
  }

  /**
   * Export markers as array
   */
  exportMarkers() {
    return [...this.markers];
  }

  /**
   * Generate automatic reel markers every N minutes
   */
  generateReelMarkers(videoDuration, intervalMinutes = 10) {
    const intervalSeconds = intervalMinutes * 60;
    let numReels = Math.floor(videoDuration / intervalSeconds);
    
    // Handle case where video is shorter than one interval
    if (numReels === 0 && videoDuration > 0) {
      numReels = 1;
    }
    
    const newMarkers = [];
    for (let i = 0; i < numReels; i++) {
      const inTime = i * intervalSeconds;
      let outTime = (i + 1) * intervalSeconds;
      
      // Make sure last reel doesn't exceed video duration
      if (outTime > videoDuration) {
        outTime = videoDuration;
      }
      
      // Skip if reel would be too short (less than 10 seconds)
      if (outTime - inTime < 10) continue;
      
      const marker = {
        id: this.nextMarkerId++,
        type: 'range',
        inTime: inTime,
        outTime: outTime,
        duration: outTime - inTime,
        name: `Reel ${i + 1}`,
        color: this.colors[i % this.colors.length],
        description: `Auto-generated ${intervalMinutes}min reel`,
        transcription: '',
        tags: ['auto-reel'],
        notes: '',
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString()
      };
      
      newMarkers.push(marker);
    }
    
    this.markers.push(...newMarkers);
    this._sort();
    
    return newMarkers.length;
  }

  /**
   * Export markers as beats JSON format
   */
  exportBeatsJSON() {
    return this.markers.map(marker => {
      const base = {
        name: marker.name,
        color: marker.color,
        description: marker.description,
        transcription: marker.transcription,
        tags: marker.tags
      };
      
      if (marker.type === 'range') {
        return {
          ...base,
          type: 'range',
          inTime: marker.inTime,
          outTime: marker.outTime,
          duration: marker.duration
        };
      } else {
        return {
          ...base,
          type: 'spot',
          time: marker.time
        };
      }
    });
  }

  /**
   * Start pending range marker (IN point)
   */
  startPendingRange(time) {
    this.pendingRangeMarker = {
      inTime: time,
      color: this.colors[Math.floor(Math.random() * this.colors.length)]
    };
    return this.pendingRangeMarker;
  }

  /**
   * Complete pending range marker (OUT point)
   */
  completePendingRange(outTime) {
    if (!this.pendingRangeMarker) return null;
    
    const inTime = this.pendingRangeMarker.inTime;
    const color = this.pendingRangeMarker.color;
    
    this.pendingRangeMarker = null;
    
    return {
      inTime,
      outTime: outTime,
      color
    };
  }

  /**
   * Cancel pending range marker
   */
  cancelPendingRange() {
    this.pendingRangeMarker = null;
  }

  /**
   * Get markers at a specific time
   */
  getMarkersAtTime(time) {
    return this.markers.filter(m => {
      if (m.type === 'range') {
        return time >= m.inTime && time <= m.outTime;
      }
      // For spots, check if within 1 second tolerance
      return Math.abs(m.time - time) < 1;
    });
  }

  /**
   * Get markers in a time range
   */
  getMarkersInRange(startTime, endTime) {
    return this.markers.filter(m => {
      if (m.type === 'range') {
        return m.inTime < endTime && m.outTime > startTime;
      }
      return m.time >= startTime && m.time <= endTime;
    });
  }

  /**
   * Internal: Sort markers by time
   */
  _sort() {
    this.markers.sort((a, b) => {
      const timeA = a.type === 'range' ? a.inTime : a.time;
      const timeB = b.type === 'range' ? b.inTime : b.time;
      return timeA - timeB;
    });
  }

  /**
   * Select a marker color
   */
  selectColor(color) {
    this.selectedColor = color;
  }

  /**
   * Set marker type for creation
   */
  setType(type) {
    this.selectedType = type;
  }

  /**
   * Set range times
   */
  setRangeTimes(inTime, outTime) {
    this.rangeInTime = inTime;
    this.rangeOutTime = outTime;
  }
  
  // ==========================================
  // Line Script Extended Methods
  // ==========================================
  
  /**
   * Get markers by marker type (Line Script feature)
   * @param {string} markerType - Marker type ID
   * @returns {Array} Markers of specified type
   */
  getByMarkerType(markerType) {
    return this.markers.filter(m => m.markerType === markerType);
  }
  
  /**
   * Get markers by source
   * @param {string} source - Source ('manual', 'keyboard', 'voice', 'ai-suggested')
   * @returns {Array} Markers from specified source
   */
  getBySource(source) {
    return this.markers.filter(m => m.source === source);
  }
  
  /**
   * Get markers by template
   * @param {string} templateId - Template ID
   * @returns {Array} Markers for specified template
   */
  getByTemplate(templateId) {
    return this.markers.filter(m => m.templateId === templateId);
  }
  
  /**
   * Get AI-generated markers
   * @returns {Array} AI-generated markers
   */
  getAIGenerated() {
    return this.markers.filter(m => 
      m.source === 'ai-suggested' || 
      (m.lineScript && m.lineScript.aiGenerated)
    );
  }
  
  /**
   * Update Line Script metadata for a marker
   * @param {number} id - Marker ID
   * @param {Object} lineScriptData - Line Script metadata
   */
  updateLineScriptData(id, lineScriptData) {
    const marker = this.getById(id);
    if (!marker) return null;
    
    marker.lineScript = {
      ...(marker.lineScript || {}),
      ...lineScriptData,
      modifiedAt: new Date().toISOString()
    };
    
    marker.modifiedAt = new Date().toISOString();
    
    this.emit('markerUpdated', { marker, updates: { lineScript: lineScriptData } });
    
    return marker;
  }
  
  /**
   * Get marker type info
   * @param {string} markerType - Marker type ID
   * @returns {Object|null} Marker type info
   */
  getMarkerTypeInfo(markerType) {
    return this.markerTypes[markerType] || null;
  }
  
  /**
   * Get all marker types for a template
   * @param {string} templateId - Template ID
   * @returns {Array} Marker types
   */
  getMarkerTypesForTemplate(templateId) {
    return Object.values(this.markerTypes).filter(
      mt => !mt.template || mt.template === templateId
    );
  }
  
  /**
   * Batch update markers (for AI-generated metadata)
   * @param {Array} updates - Array of { id, updates } objects
   */
  batchUpdate(updates) {
    const results = [];
    
    updates.forEach(({ id, updates: markerUpdates }) => {
      const result = this.updateMarker(id, markerUpdates);
      if (result) results.push(result);
    });
    
    this.emit('markersBatchUpdated', { markers: results, count: results.length });
    
    return results;
  }
  
  /**
   * Export markers with Line Script metadata
   * @returns {Array} Markers with full metadata
   */
  exportWithLineScript() {
    return this.markers.map(marker => ({
      ...marker,
      exportedAt: new Date().toISOString()
    }));
  }

  /**
   * Start recording replacement for a marker (ADR workflow)
   * Opens the recorder with IN/OUT times preset from the marker
   * @param {string} markerId - Marker ID
   */
  async startRecordReplacement(markerId) {
    const marker = this.getById(markerId);
    if (!marker) {
      window.logging.error('video', 'MarkerManager Marker not found', { error: { error: markerId } });
      this.app.showToast?.('error', 'Marker not found');
      return null;
    }

    // Get marker time range
    const inTime = marker.time || marker.inTime || 0;
    const outTime = marker.outTime || (inTime + 5); // Default 5 second duration

    window.logging.info('video', 'MarkerManager starting record replacement', { markerId, inTime, outTime, duration: outTime - inTime });

    // Check if recorder window exists
    if (window.videoEditor?.openRecorderWithPreset) {
      try {
        const result = await window.videoEditor.openRecorderWithPreset({
          mode: 'adr',
          inTime,
          outTime,
          markerId,
          markerName: marker.name || `Marker ${markerId}`,
          videoPath: this.app.videoPath,
          onComplete: (recordingPath) => {
            this._handleReplacementRecorded(markerId, recordingPath);
          }
        });

        return result;
      } catch (error) {
        window.logging.error('video', 'MarkerManager Failed to open recorder', { error: { error: error } });
        this.app.showToast?.('error', 'Failed to open recorder');
        return null;
      }
    } else {
      // Fallback: Show instructions
      this.app.showToast?.('info', `Record replacement for ${inTime.toFixed(1)}s - ${outTime.toFixed(1)}s\nUse the recorder window.`);
      
      // Store preset for later
      this._pendingRecordReplacement = {
        markerId,
        inTime,
        outTime,
        markerName: marker.name
      };

      return {
        markerId,
        inTime,
        outTime,
        pending: true
      };
    }
  }

  /**
   * Handle completed replacement recording
   */
  async _handleReplacementRecorded(markerId, recordingPath) {
    if (!recordingPath) return;

    const marker = this.getById(markerId);
    if (!marker) return;

    window.logging.info('video', 'MarkerManager replacement recorded', { markerId, recordingPath });

    // Get or create ADR track
    const adrTrack = this.app.adrManager?.ensureADRTrack?.();
    if (!adrTrack) {
      window.logging.warn('video', 'MarkerManager No ADR track available');
      return;
    }

    // Add the recording as a clip to the ADR track
    const inTime = marker.time || marker.inTime || 0;
    
    this.app.addClipToTrack?.(adrTrack.id, {
      path: recordingPath,
      name: `ADR: ${marker.name || 'Unnamed'}`,
      startTime: inTime,
      source: 'recording',
      markerId
    });

    // Update marker with replacement info
    this.updateMarker(markerId, {
      hasReplacement: true,
      replacementPath: recordingPath,
      replacementRecordedAt: new Date().toISOString()
    });

    this.app.showToast?.('success', 'Replacement recording added to ADR track');
  }

  /**
   * Get pending record replacement preset
   */
  getPendingRecordReplacement() {
    return this._pendingRecordReplacement;
  }

  /**
   * Clear pending record replacement
   */
  clearPendingRecordReplacement() {
    this._pendingRecordReplacement = null;
  }

  /**
   * Quick record at current playhead position
   * Adds recording to selected track
   * @param {string} trackId - Optional track ID (uses default ADR track if not specified)
   */
  async quickRecord(trackId = null) {
    const currentTime = this.app.video?.currentTime || 0;
    
    window.logging.info('video', 'MarkerManager starting quick record', { time: currentTime });

    // Determine target track
    const targetTrackId = trackId || this.app.adrManager?.ensureADRTrack()?.id;
    if (!targetTrackId) {
      this.app.showToast?.('error', 'No track available for recording');
      return null;
    }

    // Open recorder
    if (window.videoEditor?.openRecorderWithPreset) {
      try {
        const result = await window.videoEditor.openRecorderWithPreset({
          mode: 'voiceover',
          startTime: currentTime,
          trackId: targetTrackId,
          onComplete: (recordingPath) => {
            if (recordingPath) {
              this.app.addClipToTrack?.(targetTrackId, {
                path: recordingPath,
                name: `Recording ${new Date().toLocaleTimeString()}`,
                startTime: currentTime,
                source: 'recording'
              });
              this.app.showToast?.('success', 'Recording added to track');
            }
          }
        });

        return result;
      } catch (error) {
        window.logging.error('video', 'MarkerManager Quick record error', { error: { error: error } });
        this.app.showToast?.('error', 'Failed to start recording');
        return null;
      }
    }

    this.app.showToast?.('info', 'Open the recorder to record audio');
    return null;
  }

  /**
   * Get context menu items for a marker (includes record replacement)
   */
  getMarkerContextMenuItems(markerId) {
    const marker = this.getById(markerId);
    if (!marker) return [];

    const items = [
      { icon: '✏️', label: 'Edit Marker', action: 'edit' },
      { icon: '🎯', label: 'Go to Marker', action: 'goto' },
      { type: 'divider' },
      { icon: '🎤', label: 'Record Replacement', action: 'record-replacement', 
        description: 'Open recorder to record ADR' },
      { icon: '📥', label: 'Import Replacement', action: 'import-replacement',
        description: 'Import audio file as replacement' },
      { type: 'divider' },
      { icon: '📋', label: 'Duplicate', action: 'duplicate' },
      { icon: '🗑️', label: 'Delete', action: 'delete', danger: true }
    ];

    // Add replacement status if exists
    if (marker.hasReplacement) {
      items.splice(5, 0, {
        icon: '✅',
        label: 'Has Replacement',
        action: 'view-replacement',
        disabled: false
      });
    }

    return items;
  }

  /**
   * Handle context menu action for a marker
   */
  async handleMarkerContextAction(markerId, action) {
    switch (action) {
      case 'edit':
        this.app.markerModal?.showEditModal?.(markerId);
        break;
        
      case 'goto':
        const marker = this.getById(markerId);
        if (marker && this.app.video) {
          this.app.video.currentTime = marker.time || marker.inTime || 0;
        }
        break;
        
      case 'record-replacement':
        await this.startRecordReplacement(markerId);
        break;
        
      case 'import-replacement':
        await this._importReplacement(markerId);
        break;
        
      case 'view-replacement':
        await this._viewReplacement(markerId);
        break;
        
      case 'duplicate':
        this.duplicateMarker(markerId);
        break;
        
      case 'delete':
        if (confirm('Delete this marker?')) {
          this.deleteMarker(markerId);
        }
        break;
    }
  }

  /**
   * Import replacement audio file
   */
  async _importReplacement(markerId) {
    const marker = this.getById(markerId);
    if (!marker) return;

    try {
      const result = await window.videoEditor?.selectAudioFile?.();
      
      if (result && !result.canceled && result.filePath) {
        await this._handleReplacementRecorded(markerId, result.filePath);
      }
    } catch (error) {
      window.logging.error('video', 'MarkerManager Import replacement error', { error: { error: error } });
      this.app.showToast?.('error', 'Failed to import replacement');
    }
  }

  /**
   * View/play replacement
   */
  async _viewReplacement(markerId) {
    const marker = this.getById(markerId);
    if (!marker?.replacementPath) {
      this.app.showToast?.('info', 'No replacement recorded');
      return;
    }

    // Play the replacement audio
    this.app.showToast?.('info', `Replacement: ${marker.replacementPath}`);
  }
}


















