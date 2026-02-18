/**
 * MarkerModal - Modal UI for creating and editing markers
 * Handles form display, validation, and submission
 */
export class MarkerModal {
  constructor(appContext) {
    this.app = appContext;

    // State
    this.editingMarkerId = null;
    this.selectedColor = null;
    this.selectedType = 'spot';
    this.rangeInTime = 0;
    this.rangeOutTime = 5;
  }

  /**
   * Show marker modal for adding or editing
   */
  show(time, editMarker = null, forceType = null) {
    const manager = this.app.markerManager;
    const colors = manager?.colors || this.app.markerColors || [];

    this.editingMarkerId = editMarker?.id || null;
    this.selectedColor = editMarker?.color || colors[0];
    this.selectedType = forceType || editMarker?.type || 'spot';

    // Set range times
    if (editMarker?.type === 'range') {
      this.rangeInTime = editMarker.inTime;
      this.rangeOutTime = editMarker.outTime;
    } else if (this.selectedType === 'range') {
      // Keep existing range values (may be set by pending range)
    } else {
      this.rangeInTime = time;
      this.rangeOutTime = time + 5;
    }

    // Update modal elements
    this._updateModalElements(time, editMarker);

    // Build color picker
    this._buildColorPicker(colors);

    // Show modal
    document.getElementById('markerModalBackdrop')?.classList.remove('hidden');
    document.getElementById('markerModal')?.classList.remove('hidden');

    // Focus input
    setTimeout(() => {
      document.getElementById('markerNameInput')?.focus();
    }, 100);
  }

  /**
   * Close marker modal
   */
  close() {
    document.getElementById('markerModalBackdrop')?.classList.add('hidden');
    document.getElementById('markerModal')?.classList.add('hidden');
    this.editingMarkerId = null;
  }

  /**
   * Update modal form elements
   */
  _updateModalElements(time, editMarker) {
    const title = document.getElementById('markerModalTitle');
    const nameInput = document.getElementById('markerNameInput');
    const timeDisplay = document.getElementById('markerTimeDisplay');
    const saveBtn = document.getElementById('saveMarkerBtn');
    const typeGroup = document.getElementById('markerTypeGroup');
    const spotTimeGroup = document.getElementById('spotTimeGroup');
    const rangeTimeGroup = document.getElementById('rangeTimeGroup');
    const rangeInDisplay = document.getElementById('rangeInDisplay');
    const rangeOutDisplay = document.getElementById('rangeOutDisplay');

    // Title and button
    if (title) title.textContent = editMarker ? 'Edit Marker' : 'Add Marker';
    if (saveBtn) saveBtn.textContent = editMarker ? 'Save Changes' : 'Add Marker';

    // Name and time
    if (nameInput) nameInput.value = editMarker?.name || '';
    if (timeDisplay) timeDisplay.textContent = this.app.formatTime(time);

    // Store time for save
    const modal = document.getElementById('markerModal');
    if (modal) modal.dataset.time = time;

    // Type selector (hide when editing)
    if (typeGroup) {
      typeGroup.style.display = editMarker ? 'none' : 'block';
    }

    // Update type buttons
    document.querySelectorAll('.marker-type-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.type === this.selectedType);
    });

    // Show/hide time inputs based on type
    if (spotTimeGroup) spotTimeGroup.classList.toggle('hidden', this.selectedType === 'range');
    if (rangeTimeGroup) rangeTimeGroup.classList.toggle('hidden', this.selectedType === 'spot');

    // Range times
    if (rangeInDisplay) rangeInDisplay.textContent = this.app.formatTime(this.rangeInTime);
    if (rangeOutDisplay) rangeOutDisplay.textContent = this.app.formatTime(this.rangeOutTime);
    this._updateRangeDuration();

    // Metadata fields
    const descField = document.getElementById('markerDescription');
    const transcriptField = document.getElementById('markerTranscription');
    const tagsField = document.getElementById('markerTags');
    const notesField = document.getElementById('markerNotes');

    if (descField) descField.value = editMarker?.description || '';
    if (transcriptField) transcriptField.value = editMarker?.transcription || '';
    if (tagsField) tagsField.value = editMarker?.tags?.join(', ') || '';
    if (notesField) notesField.value = editMarker?.notes || '';

    // Dates
    const createdEl = document.getElementById('markerCreated');
    const modifiedEl = document.getElementById('markerModified');

    if (createdEl) {
      createdEl.textContent = editMarker?.createdAt ? new Date(editMarker.createdAt).toLocaleString() : 'Now';
    }
    if (modifiedEl) {
      modifiedEl.textContent = editMarker?.modifiedAt ? new Date(editMarker.modifiedAt).toLocaleString() : '-';
    }

    // ElevenLabs button
    this.app.updateElevenLabsButton?.();
  }

  /**
   * Build color picker
   */
  _buildColorPicker(colors) {
    const picker = document.getElementById('markerColorPicker');
    if (!picker) return;

    picker.innerHTML = colors
      .map(
        (color) => `
      <div class="marker-color-option ${color === this.selectedColor ? 'selected' : ''}" 
           style="background: ${color};" 
           data-color="${color}"
           onclick="app.markerModal?.selectColor('${color}')"></div>
    `
      )
      .join('');
  }

  /**
   * Select a color
   */
  selectColor(color) {
    this.selectedColor = color;
    document.querySelectorAll('.marker-color-option').forEach((el) => {
      el.classList.toggle('selected', el.dataset.color === color);
    });
  }

  /**
   * Set marker type
   */
  setType(type) {
    this.selectedType = type;

    // Update UI
    document.querySelectorAll('.marker-type-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.type === type);
    });

    // Show/hide time inputs
    document.getElementById('spotTimeGroup')?.classList.toggle('hidden', type === 'range');
    document.getElementById('rangeTimeGroup')?.classList.toggle('hidden', type === 'spot');

    // ElevenLabs button
    this.app.updateElevenLabsButton?.();
  }

  /**
   * Set range IN to current time
   */
  setRangeInNow() {
    const video = document.getElementById('videoPlayer');
    if (video) {
      this.rangeInTime = video.currentTime;
      const display = document.getElementById('rangeInDisplay');
      if (display) display.textContent = this.app.formatTime(this.rangeInTime);
      this._updateRangeDuration();
    }
  }

  /**
   * Set range OUT to current time
   */
  setRangeOutNow() {
    const video = document.getElementById('videoPlayer');
    if (video) {
      this.rangeOutTime = video.currentTime;
      const display = document.getElementById('rangeOutDisplay');
      if (display) display.textContent = this.app.formatTime(this.rangeOutTime);
      this._updateRangeDuration();
    }
  }

  /**
   * Update range duration display
   */
  _updateRangeDuration() {
    const duration = Math.max(0, this.rangeOutTime - this.rangeInTime);
    const el = document.getElementById('rangeDuration');
    if (el) el.textContent = `Duration: ${this.app.formatTime(duration)}`;
  }

  /**
   * Save marker (create new or update existing)
   */
  save() {
    const modal = document.getElementById('markerModal');
    const name = document.getElementById('markerNameInput')?.value.trim();
    const description = document.getElementById('markerDescription')?.value.trim() || '';
    const transcription = document.getElementById('markerTranscription')?.value.trim() || '';
    const tagsInput = document.getElementById('markerTags')?.value.trim() || '';
    const tags = tagsInput
      ? tagsInput
          .split(',')
          .map((t) => t.trim())
          .filter((t) => t)
      : [];
    const notes = document.getElementById('markerNotes')?.value.trim() || '';

    const manager = this.app.markerManager;
    const markers = manager?.getAll() || this.app.markers || [];

    const metadata = { description, transcription, tags, notes };

    if (this.editingMarkerId) {
      // Update existing
      const marker = manager?.getById(this.editingMarkerId) || markers.find((m) => m.id === this.editingMarkerId);
      if (marker) {
        marker.name = name || marker.name;
        marker.color = this.selectedColor;
        marker.description = description;
        marker.transcription = transcription;
        marker.tags = tags;
        marker.notes = notes;
        marker.modifiedAt = new Date().toISOString();

        if (marker.type === 'range') {
          marker.inTime = this.rangeInTime;
          marker.outTime = this.rangeOutTime;
          marker.duration = this.rangeOutTime - this.rangeInTime;
        }
      }
    } else {
      // Create new
      const time = parseFloat(modal?.dataset.time || 0);

      if (this.selectedType === 'spot') {
        if (manager) {
          manager.addSpotMarker(time, name || `Scene ${markers.length + 1}`, this.selectedColor, metadata);
        } else {
          // Fallback to direct array manipulation
          const marker = {
            id: this.app.nextMarkerId++,
            type: 'spot',
            time: time,
            name: name || `Scene ${markers.length + 1}`,
            color: this.selectedColor,
            ...metadata,
            createdAt: new Date().toISOString(),
            modifiedAt: new Date().toISOString(),
          };
          markers.push(marker);
        }
      } else {
        // Range marker
        if (this.rangeOutTime <= this.rangeInTime) {
          this.app.showToast?.('error', 'OUT point must be after IN point');
          return;
        }

        if (manager) {
          manager.addRangeMarker(
            this.rangeInTime,
            this.rangeOutTime,
            name || `Scene ${markers.length + 1}`,
            this.selectedColor,
            metadata
          );
        } else {
          const marker = {
            id: this.app.nextMarkerId++,
            type: 'range',
            inTime: this.rangeInTime,
            outTime: this.rangeOutTime,
            duration: this.rangeOutTime - this.rangeInTime,
            name: name || `Scene ${markers.length + 1}`,
            color: this.selectedColor,
            ...metadata,
            createdAt: new Date().toISOString(),
            modifiedAt: new Date().toISOString(),
          };
          markers.push(marker);
        }
      }

      // Sort markers
      markers.sort((a, b) => {
        const timeA = a.type === 'range' ? a.inTime : a.time;
        const timeB = b.type === 'range' ? b.inTime : b.time;
        return timeA - timeB;
      });
    }

    this.close();

    // Re-render
    this.app.markerRenderer?.render();
    this.app.renderMarkers?.();
    this.app.renderScenesList?.();

    // Refresh teleprompter
    if (this.app.teleprompterVisible && this.app.teleprompter?.words?.length > 0) {
      this.app.teleprompter?.renderWords();
    }

    this.app.showToast?.('success', this.editingMarkerId ? 'Marker updated' : 'Marker added');
  }
}
