/**
 * TeleprompterMarkers - Marker integration for teleprompter
 * Handles creating markers from teleprompter, range selection, and marker display
 */
export class TeleprompterMarkers {
  constructor(appContext) {
    this.app = appContext;
    
    // State for range marker creation
    this.rangeStart = null;  // { time } when waiting for range end
  }

  /**
   * Build a time-indexed map of markers for quick lookup
   */
  buildMarkerTimeMap() {
    const map = { ranges: [], spots: [] };
    
    for (const marker of (this.app.markers || [])) {
      if (marker.type === 'range') {
        map.ranges.push({
          id: marker.id,
          name: marker.name,
          type: 'range',
          inTime: marker.inTime,
          outTime: marker.outTime,
          color: marker.color
        });
      } else {
        map.spots.push({
          id: marker.id,
          name: marker.name,
          type: 'spot',
          time: marker.time,
          color: marker.color
        });
      }
    }
    
    return map;
  }

  /**
   * Check if a word time falls within any marker
   */
  getMarkerForTime(wordStart, wordEnd, markerMap) {
    // Check ranges first (higher priority)
    for (const range of markerMap.ranges) {
      if (wordStart >= range.inTime && wordEnd <= range.outTime) {
        return range;
      }
    }
    
    // Check spot markers
    for (const spot of markerMap.spots) {
      if (wordStart <= spot.time && wordEnd >= spot.time) {
        return spot;
      }
    }
    
    return null;
  }

  /**
   * Add visual marker indicators at marker boundaries in teleprompter
   */
  addMarkerIndicators() {
    const wordsContainer = document.getElementById('teleprompterWords');
    if (!wordsContainer) return;
    
    for (const marker of (this.app.markers || [])) {
      if (marker.type === 'range') {
        // Find first word in range
        const firstWord = wordsContainer.querySelector(
          `.teleprompter-word[data-marker-id="${marker.id}"]`
        );
        if (firstWord) {
          firstWord.classList.add('marker-range-start');
          firstWord.style.setProperty('--marker-color', marker.color);
        }
        
        // Find last word in range
        const markerWords = wordsContainer.querySelectorAll(
          `.teleprompter-word[data-marker-id="${marker.id}"]`
        );
        if (markerWords.length > 0) {
          const lastWord = markerWords[markerWords.length - 1];
          lastWord.classList.add('marker-range-end');
          lastWord.style.setProperty('--marker-color', marker.color);
        }
      } else if (marker.type === 'spot') {
        const spotWord = wordsContainer.querySelector(
          `.teleprompter-word[data-marker-id="${marker.id}"]`
        );
        if (spotWord) {
          spotWord.classList.add('marker-spot-word');
        }
      }
    }
  }

  /**
   * Handle click on a teleprompter word
   */
  handleWordClick(event, startTime, endTime) {
    event.stopPropagation();
    
    // If in range marking mode, complete the range
    if (this.rangeStart) {
      this.completeRangeMarker(endTime);
      return;
    }
    
    // Otherwise, seek to word
    this.app.teleprompter?.seekToTime(startTime);
  }

  /**
   * Handle click on cursor (between words)
   */
  handleCursorClick(event, time) {
    if (this.rangeStart) {
      this.completeRangeMarker(time);
    } else {
      this.showMarkerMenu(event, time);
    }
  }

  /**
   * Double-click to edit a marker from teleprompter word
   */
  editMarkerFromWord(markerId) {
    if (!markerId) return;
    const marker = this.app.markers?.find(m => m.id === markerId);
    if (marker) {
      const time = marker.type === 'range' ? marker.inTime : marker.time;
      this.app.showMarkerModal(time, marker);
    }
  }

  /**
   * Show marker type selection menu
   */
  showMarkerMenu(event, time) {
    const menu = document.getElementById('contextMenu');
    const menuItems = document.getElementById('contextMenuItems');
    
    menuItems.innerHTML = `
      <div class="context-menu-header">📍 Add Marker at ${this.app.formatTime(time)}</div>
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
    
    menuItems.querySelectorAll('.context-menu-item').forEach(item => {
      item.addEventListener('click', () => {
        const action = item.dataset.action;
        this.app.hideContextMenu();
        
        switch (action) {
          case 'addPointMarker':
            this.addPointMarker(time);
            break;
          case 'startRangeMarker':
            this.startRangeMarker(time);
            break;
          case 'seekToTime':
            this.app.teleprompter?.seekToTime(time);
            break;
        }
      });
    });
    
    this.app.positionContextMenu(menu, event.clientX, event.clientY);
  }

  /**
   * Add a point marker
   */
  addPointMarker(time) {
    // Get words around this time for context
    const nearbyWords = this.app.teleprompter?.getWordsAroundTime(time, 3) || [];
    const context = nearbyWords.map(w => w.text).join(' ');
    
    // Seek to marker time
    this.app.teleprompter?.seekToTime(time);
    
    // Open marker modal
    this.showMarkerModalForPoint(time, context);
  }

  /**
   * Show marker modal pre-filled for a point marker
   */
  showMarkerModalForPoint(time, contextText) {
    const modal = document.getElementById('markerModal');
    const backdrop = document.getElementById('markerModalBackdrop');
    
    // Reset form
    this.app.editingMarkerId = null;
    this.app.selectedMarkerType = 'spot';
    
    modal.dataset.time = time;
    
    document.getElementById('markerModalTitle').textContent = 'Add Point Marker';
    document.getElementById('saveMarkerBtn').textContent = 'Add Marker';
    
    document.querySelectorAll('.marker-type-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.type === 'spot');
    });
    
    const typeGroup = document.getElementById('markerTypeGroup');
    if (typeGroup) typeGroup.style.display = 'block';
    
    // Show spot time group, hide range time group
    const spotTimeGroup = document.getElementById('spotTimeGroup');
    if (spotTimeGroup) spotTimeGroup.classList.remove('hidden');
    
    const rangeTimeGroup = document.getElementById('rangeTimeGroup');
    if (rangeTimeGroup) rangeTimeGroup.classList.add('hidden');
    
    // Update spot time display
    document.getElementById('markerTimeDisplay').textContent = this.app.formatTime(time);
    
    document.getElementById('markerNameInput').value = '';
    document.getElementById('markerNameInput').placeholder = `Point at ${this.app.formatTime(time)}`;
    document.getElementById('markerDescription').value = contextText ? `"${contextText}"` : '';
    document.getElementById('markerTags').value = 'teleprompter';
    document.getElementById('markerNotes').value = '';
    
    const transcriptionField = document.getElementById('markerTranscription');
    if (transcriptionField) {
      transcriptionField.value = '';
    }
    
    this.app.selectedMarkerColor = this.app.markerColors[this.app.markers.length % this.app.markerColors.length];
    document.querySelectorAll('.color-option').forEach(opt => {
      opt.classList.toggle('selected', opt.dataset.color === this.app.selectedMarkerColor);
    });
    
    const elevenLabsSection = document.getElementById('elevenLabsSection');
    if (elevenLabsSection) {
      elevenLabsSection.classList.add('hidden');
    }
    
    modal.classList.remove('hidden');
    backdrop.classList.remove('hidden');
    
    setTimeout(() => {
      document.getElementById('markerNameInput').focus();
    }, 100);
  }

  /**
   * Start a range marker
   */
  startRangeMarker(time) {
    const container = document.getElementById('teleprompterContainer');
    const rangeIndicator = container?.querySelector('.teleprompter-range-indicator');
    
    this.rangeStart = { time };
    
    // Show range indicator
    if (rangeIndicator) {
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
    
    container?.classList.add('range-marking-mode');
    
    this.app.showToast('info', `IN point set at ${this.app.formatTime(time)}. Click again for OUT point, or press ESC to cancel.`);
  }

  /**
   * Complete the range marker
   */
  completeRangeMarker(outTime) {
    if (!this.rangeStart) return;
    
    const inTime = this.rangeStart.time;
    
    // Ensure in < out
    const startTime = Math.min(inTime, outTime);
    const endTime = Math.max(inTime, outTime);
    
    if (endTime - startTime < 0.5) {
      this.app.showToast('error', 'Range too short. Try a wider selection.');
      return;
    }
    
    // Get words in range
    const rangeWords = this.app.teleprompter?.getWordsInRange(startTime, endTime) || [];
    const context = rangeWords.map(w => w.text).join(' ');
    
    // Clean up
    this.cancelRangeMarker();
    
    // Seek to start
    this.app.teleprompter?.seekToTime(startTime);
    
    // Open modal
    this.showMarkerModalForRange(startTime, endTime, context);
  }

  /**
   * Show marker modal for a range
   */
  showMarkerModalForRange(inTime, outTime, transcriptText) {
    const modal = document.getElementById('markerModal');
    const backdrop = document.getElementById('markerModalBackdrop');
    
    this.app.editingMarkerId = null;
    this.app.selectedMarkerType = 'range';
    this.app.rangeInTime = inTime;
    this.app.rangeOutTime = outTime;
    
    document.getElementById('markerModalTitle').textContent = 'Add Scene Marker';
    document.getElementById('saveMarkerBtn').textContent = 'Add Marker';
    
    document.querySelectorAll('.marker-type-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.type === 'range');
    });
    
    const typeGroup = document.getElementById('markerTypeGroup');
    if (typeGroup) typeGroup.style.display = 'none';
    
    // Hide spot time group, show range time group
    const spotTimeGroup = document.getElementById('spotTimeGroup');
    if (spotTimeGroup) spotTimeGroup.classList.add('hidden');
    
    const rangeTimeGroup = document.getElementById('rangeTimeGroup');
    if (rangeTimeGroup) {
      rangeTimeGroup.classList.remove('hidden');
      document.getElementById('rangeInDisplay').textContent = this.app.formatTime(inTime);
      document.getElementById('rangeOutDisplay').textContent = this.app.formatTime(outTime);
      const durationEl = document.getElementById('rangeDuration');
      if (durationEl) durationEl.textContent = `Duration: ${this.app.formatTime(outTime - inTime)}`;
    }
    
    document.getElementById('markerNameInput').value = '';
    document.getElementById('markerNameInput').placeholder = `Scene at ${this.app.formatTime(inTime)}`;
    document.getElementById('markerDescription').value = '';
    document.getElementById('markerTags').value = 'teleprompter';
    document.getElementById('markerNotes').value = '';
    
    const transcriptionField = document.getElementById('markerTranscription');
    if (transcriptionField) {
      transcriptionField.value = transcriptText || '';
    }
    
    this.app.selectedMarkerColor = this.app.markerColors[this.app.markers.length % this.app.markerColors.length];
    document.querySelectorAll('.color-option').forEach(opt => {
      opt.classList.toggle('selected', opt.dataset.color === this.app.selectedMarkerColor);
    });
    
    const elevenLabsSection = document.getElementById('elevenLabsSection');
    if (elevenLabsSection) {
      elevenLabsSection.classList.toggle('hidden', !transcriptText);
    }
    
    modal.classList.remove('hidden');
    backdrop.classList.remove('hidden');
    
    setTimeout(() => {
      document.getElementById('markerNameInput').focus();
    }, 100);
  }

  /**
   * Cancel range marker creation
   */
  cancelRangeMarker() {
    this.rangeStart = null;
    
    const container = document.getElementById('teleprompterContainer');
    const rangeIndicator = container?.querySelector('.teleprompter-range-indicator');
    
    if (rangeIndicator) {
      rangeIndicator.style.display = 'none';
    }
    
    container?.classList.remove('range-marking-mode');
  }

  /**
   * Setup ESC key handler for canceling range
   */
  setupKeyHandler() {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.rangeStart) {
        this.cancelRangeMarker();
      }
    });
  }
}


















