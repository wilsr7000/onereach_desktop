/**
 * RecorderUI - Recorder UI handling
 * @module src/recorder/ui/RecorderUI
 */

/**
 * Recorder UI class
 */
export class RecorderUI {
  constructor() {
    this.elements = {};
    this.cacheElements();
  }

  /**
   * Cache DOM elements
   */
  cacheElements() {
    this.elements = {
      preview: document.getElementById('preview'),
      cameraPreview: document.getElementById('cameraPreview'),
      screenPreview: document.getElementById('screenPreview'),
      recordBtn: document.getElementById('recordBtn'),
      stopBtn: document.getElementById('stopBtn'),
      pauseBtn: document.getElementById('pauseBtn'),
      cameraBtn: document.getElementById('cameraBtn'),
      screenBtn: document.getElementById('screenBtn'),
      duration: document.getElementById('duration'),
      status: document.getElementById('status'),
      modeSelect: document.getElementById('modeSelect'),
      saveDialog: document.getElementById('saveDialog'),
      playback: document.getElementById('playbackVideo')
    };
  }

  /**
   * Show preview
   * @param {MediaStream} stream - Stream to preview
   * @param {string} type - 'camera' or 'screen'
   */
  showPreview(stream, type = 'camera') {
    const element = type === 'camera' 
      ? this.elements.cameraPreview 
      : this.elements.screenPreview;
    
    if (element) {
      element.srcObject = stream;
      element.play().catch(e => window.logging.warn('recorder', 'Preview autoplay blocked'));
    }
  }

  /**
   * Hide preview
   * @param {string} type - 'camera' or 'screen'
   */
  hidePreview(type = 'camera') {
    const element = type === 'camera' 
      ? this.elements.cameraPreview 
      : this.elements.screenPreview;
    
    if (element) {
      element.srcObject = null;
    }
  }

  /**
   * Update recording state UI
   * @param {boolean} isRecording - Recording state
   * @param {boolean} isPaused - Paused state
   */
  updateRecordingState(isRecording, isPaused = false) {
    if (this.elements.recordBtn) {
      this.elements.recordBtn.disabled = isRecording;
      this.elements.recordBtn.classList.toggle('hidden', isRecording);
    }
    
    if (this.elements.stopBtn) {
      this.elements.stopBtn.disabled = !isRecording;
      this.elements.stopBtn.classList.toggle('hidden', !isRecording);
    }
    
    if (this.elements.pauseBtn) {
      this.elements.pauseBtn.disabled = !isRecording;
      this.elements.pauseBtn.textContent = isPaused ? '▶ Resume' : '⏸ Pause';
    }
    
    if (this.elements.status) {
      this.elements.status.textContent = isRecording 
        ? (isPaused ? 'Paused' : 'Recording')
        : 'Ready';
      this.elements.status.classList.toggle('recording', isRecording && !isPaused);
    }
  }

  /**
   * Update duration display
   * @param {number} seconds - Duration in seconds
   */
  updateDuration(seconds) {
    if (this.elements.duration) {
      this.elements.duration.textContent = this.formatTime(seconds);
    }
  }

  /**
   * Show save dialog with recorded video
   * @param {Blob} blob - Recorded video blob
   */
  showSaveDialog(blob) {
    if (this.elements.playback && blob) {
      this.elements.playback.src = URL.createObjectURL(blob);
    }
    
    if (this.elements.saveDialog) {
      this.elements.saveDialog.classList.remove('hidden');
    }
  }

  /**
   * Hide save dialog
   */
  hideSaveDialog() {
    if (this.elements.saveDialog) {
      this.elements.saveDialog.classList.add('hidden');
    }
    
    if (this.elements.playback) {
      URL.revokeObjectURL(this.elements.playback.src);
      this.elements.playback.src = '';
    }
  }

  /**
   * Format time helper
   * @param {number} seconds - Seconds
   * @returns {string} Formatted time
   */
  formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * Get selected mode
   * @returns {string} Recording mode
   */
  get mode() {
    return this.elements.modeSelect?.value || 'camera';
  }
}
















