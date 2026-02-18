/**
 * ADRTrackManager - Manages ADR (Automated Dialogue Replacement) tracks
 *
 * Handles track duplication, working tracks, and ADR clip management.
 * Part of the non-destructive multi-track audio workflow.
 */

const { getLogQueue } = require('../../../lib/log-event-queue');
const log = getLogQueue();
export class ADRTrackManager {
  constructor(appContext) {
    this.app = appContext;

    // Track type constants
    this.TRACK_TYPES = {
      ORIGINAL: 'original',
      GUIDE: 'guide',
      WORKING: 'working',
      ADR: 'adr',
      FILL: 'fill',
      VOICE: 'voice',
      SFX: 'sfx',
    };

    // Dead space regions (visual-only markers for silence)
    this.deadSpaceRegions = [];
  }

  /**
   * Get all audio tracks from app
   */
  get tracks() {
    return this.app.audioTracks || [];
  }

  /**
   * Find a track by ID
   */
  findTrack(trackId) {
    return this.tracks.find((t) => t.id === trackId);
  }

  /**
   * Find a track by type
   */
  findTrackByType(type) {
    return this.tracks.find((t) => t.type === type);
  }

  /**
   * Get the guide track (original or first non-working track)
   */
  getGuideTrack() {
    return this.findTrackByType(this.TRACK_TYPES.ORIGINAL) || this.findTrackByType(this.TRACK_TYPES.GUIDE);
  }

  /**
   * Check if a working track exists
   */
  hasWorkingTrack() {
    return !!this.findTrackByType(this.TRACK_TYPES.WORKING);
  }

  /**
   * Check if an ADR track exists
   */
  hasADRTrack() {
    return !!this.findTrackByType(this.TRACK_TYPES.ADR);
  }

  /**
   * Duplicate a track
   * @param {string} trackId - ID of the track to duplicate
   * @param {object} options - Optional configuration
   * @returns {object|null} The new duplicated track or null if failed
   */
  duplicateTrack(trackId, options = {}) {
    const sourceTrack = this.findTrack(trackId);
    if (!sourceTrack) {
      log.error('video', '[ADRTrackManager] Cannot duplicate: track not found', trackId);
      this.app.showToast?.('error', 'Track not found');
      return null;
    }

    const {
      name = `${sourceTrack.name} (Copy)`,
      type = sourceTrack.type === this.TRACK_TYPES.ORIGINAL ? this.TRACK_TYPES.WORKING : sourceTrack.type,
      copyClips = true,
    } = options;

    // Generate new track ID
    const newTrackId = `A${this.app.nextTrackId++}`;

    // Create the new track
    const newTrack = {
      id: newTrackId,
      type: type,
      name: name,
      muted: false,
      solo: false,
      volume: sourceTrack.volume || 1.0,
      clips: copyClips ? this._cloneClips(sourceTrack.clips) : [],
      sourceTrackId: trackId, // Reference to original for ADR workflow
    };

    // Add to tracks array
    this.app.audioTracks.push(newTrack);

    // Render the new track in UI
    this.app.renderAudioTrack?.(newTrack);

    log.info('video', '[ADRTrackManager] Duplicated track', {
      sourceId: trackId,
      newId: newTrackId,
      type,
      name,
    });

    this.app.showToast?.('success', `Created ${name}`);

    return newTrack;
  }

  /**
   * Create a working track from the guide/original track
   * Used when inserting silence or creating ADR
   */
  ensureWorkingTrack() {
    let workingTrack = this.findTrackByType(this.TRACK_TYPES.WORKING);

    if (!workingTrack) {
      const guideTrack = this.getGuideTrack();
      if (!guideTrack) {
        log.error('video', '[ADRTrackManager] No guide track found');
        return null;
      }

      workingTrack = this.duplicateTrack(guideTrack.id, {
        name: 'Working',
        type: this.TRACK_TYPES.WORKING,
        copyClips: false, // Working track starts empty, dead space is visual-only
      });
    }

    return workingTrack;
  }

  /**
   * Create an ADR track if it doesn't exist
   */
  ensureADRTrack() {
    let adrTrack = this.findTrackByType(this.TRACK_TYPES.ADR);

    if (!adrTrack) {
      const newTrackId = `A${this.app.nextTrackId++}`;

      adrTrack = {
        id: newTrackId,
        type: this.TRACK_TYPES.ADR,
        name: 'ADR',
        muted: false,
        solo: false,
        volume: 1.0,
        clips: [],
      };

      this.app.audioTracks.push(adrTrack);
      this.app.renderAudioTrack?.(adrTrack);

      log.info('video', '[ADRTrackManager] Created ADR track', { arg0: newTrackId });
    }

    return adrTrack;
  }

  /**
   * Clone clips array (deep copy)
   */
  _cloneClips(clips) {
    if (!clips || !Array.isArray(clips)) return [];
    return clips.map((clip) => ({ ...clip }));
  }

  /**
   * Check if track can be duplicated
   */
  canDuplicate(trackId) {
    const track = this.findTrack(trackId);
    return !!track;
  }

  /**
   * Check if track can be deleted
   */
  canDelete(trackId) {
    const track = this.findTrack(trackId);
    // Can't delete original track
    return track && track.type !== this.TRACK_TYPES.ORIGINAL;
  }

  /**
   * Set track volume
   * @param {string} trackId - Track ID
   * @param {number} volume - Volume level (0-1)
   */
  setTrackVolume(trackId, volume) {
    const track = this.findTrack(trackId);
    if (!track) return;

    track.volume = Math.max(0, Math.min(1, volume));

    // Update UI
    const volumeSlider = document.querySelector(`#track-${trackId} .track-volume-slider`);
    if (volumeSlider) {
      volumeSlider.value = track.volume;
    }

    const volumeValue = document.querySelector(`#track-${trackId} .track-volume-value`);
    if (volumeValue) {
      volumeValue.textContent = this._volumeToDb(track.volume);
    }

    // Emit event
    this.app.emit?.('trackVolumeChanged', { trackId, volume: track.volume });

    log.info('video', '[ADRTrackManager] Set volume', { arg0: trackId, arg1: track.volume });
  }

  /**
   * Set track pan
   * @param {string} trackId - Track ID
   * @param {number} pan - Pan value (-1 to 1, where -1 is left, 0 is center, 1 is right)
   */
  setTrackPan(trackId, pan) {
    const track = this.findTrack(trackId);
    if (!track) return;

    track.pan = Math.max(-1, Math.min(1, pan));

    // Update UI
    const panKnob = document.querySelector(`#track-${trackId} .track-pan-knob`);
    if (panKnob) {
      panKnob.style.setProperty('--pan-rotation', `${track.pan * 135}deg`);
    }

    const panValue = document.querySelector(`#track-${trackId} .track-pan-value`);
    if (panValue) {
      panValue.textContent = this._formatPan(track.pan);
    }

    // Emit event
    this.app.emit?.('trackPanChanged', { trackId, pan: track.pan });

    log.info('video', '[ADRTrackManager] Set pan', { arg0: trackId, arg1: track.pan });
  }

  /**
   * Convert volume (0-1) to dB string
   */
  _volumeToDb(volume) {
    if (volume === 0) return '-∞ dB';
    const db = 20 * Math.log10(volume);
    return `${db.toFixed(1)} dB`;
  }

  /**
   * Format pan value for display
   */
  _formatPan(pan) {
    if (Math.abs(pan) < 0.05) return 'C';
    if (pan < 0) return `L${Math.abs(Math.round(pan * 100))}`;
    return `R${Math.round(pan * 100)}`;
  }

  /**
   * Render volume/pan controls HTML for a track
   */
  renderTrackControls(trackId) {
    const track = this.findTrack(trackId);
    if (!track) return '';

    const volume = track.volume ?? 1.0;
    const pan = track.pan ?? 0;

    return `
      <div class="track-controls">
        <div class="track-volume-control">
          <label class="track-control-label">Vol</label>
          <input type="range" 
                 class="track-volume-slider" 
                 min="0" max="1" step="0.01" 
                 value="${volume}"
                 data-track-id="${trackId}">
          <span class="track-volume-value">${this._volumeToDb(volume)}</span>
        </div>
        
        <div class="track-pan-control">
          <label class="track-control-label">Pan</label>
          <div class="track-pan-knob-wrapper">
            <div class="track-pan-knob" 
                 style="--pan-rotation: ${pan * 135}deg"
                 data-track-id="${trackId}">
              <div class="pan-knob-indicator"></div>
            </div>
          </div>
          <span class="track-pan-value">${this._formatPan(pan)}</span>
        </div>
        
        <div class="track-meter">
          <div class="track-meter-bar" data-track-id="${trackId}">
            <div class="meter-fill"></div>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Initialize event listeners for track controls
   */
  initTrackControlListeners(trackId) {
    const track = this.findTrack(trackId);
    if (!track) return;

    // Volume slider
    const volumeSlider = document.querySelector(`#track-${trackId} .track-volume-slider`);
    if (volumeSlider) {
      volumeSlider.addEventListener('input', (e) => {
        this.setTrackVolume(trackId, parseFloat(e.target.value));
      });
    }

    // Pan knob (mouse drag)
    const panKnob = document.querySelector(`#track-${trackId} .track-pan-knob`);
    if (panKnob) {
      let isDragging = false;
      let startY = 0;
      let startPan = 0;

      panKnob.addEventListener('mousedown', (e) => {
        isDragging = true;
        startY = e.clientY;
        startPan = track.pan ?? 0;
        document.body.style.cursor = 'ns-resize';
      });

      document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const deltaY = startY - e.clientY;
        const newPan = startPan + deltaY / 100;
        this.setTrackPan(trackId, newPan);
      });

      document.addEventListener('mouseup', () => {
        isDragging = false;
        document.body.style.cursor = '';
      });

      // Double-click to reset
      panKnob.addEventListener('dblclick', () => {
        this.setTrackPan(trackId, 0);
      });
    }
  }

  /**
   * Get track display info with type labels
   */
  getTrackDisplayInfo(track) {
    const typeLabels = {
      [this.TRACK_TYPES.ORIGINAL]: { label: 'Original', icon: '🎬', color: '#3b82f6' },
      [this.TRACK_TYPES.GUIDE]: { label: 'Guide', icon: '📖', color: '#8b5cf6' },
      [this.TRACK_TYPES.WORKING]: { label: 'Working', icon: '🔧', color: '#f59e0b' },
      [this.TRACK_TYPES.ADR]: { label: 'ADR', icon: '🎤', color: '#ef4444' },
      [this.TRACK_TYPES.FILL]: { label: 'Fill', icon: '📍', color: '#10b981' },
      [this.TRACK_TYPES.VOICE]: { label: 'Voice', icon: '🗣️', color: '#ec4899' },
      [this.TRACK_TYPES.SFX]: { label: 'SFX', icon: '🔊', color: '#06b6d4' },
    };

    return typeLabels[track.type] || { label: track.type || 'Audio', icon: '🎵', color: '#6b7280' };
  }
}
