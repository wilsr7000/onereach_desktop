/**
 * TranscriptSync - Handles transcript timing synchronization
 * Manages offset, rate adjustment, and two-point calibration
 */
const { getLogQueue } = require('../../../lib/log-event-queue');
const log = getLogQueue();
export class TranscriptSync {
  constructor(appContext) {
    this.app = appContext;
    
    // Sync state
    this.offset = 0;        // Offset in seconds (+ = earlier, - = later)
    this.rate = 1.0;        // Rate multiplier (< 1 = compress, > 1 = stretch)
    this.calibrationPoint = null; // For two-point calibration
  }

  /**
   * Adjust transcript sync offset
   * @param {number} delta - Change in seconds
   */
  adjustOffset(delta) {
    this.offset += delta;
    // Clamp to reasonable range (-60s to +60s)
    this.offset = Math.max(-60, Math.min(60, this.offset));
    
    log.info('video', 'TranscriptSync offset applied', { offset: this.offset.toFixed(2) + 's' });
    
    this.updateLabel();
    this._updateHighlight();
  }

  /**
   * Adjust sync rate (for drift correction)
   * @param {number} delta - Change in rate (e.g., 0.05)
   */
  adjustRate(delta) {
    this.rate += delta;
    // Clamp to wide range (50% to 200%)
    this.rate = Math.max(0.5, Math.min(2.0, this.rate));
    
    log.info('video', 'TranscriptSync Rate', { data: (this.rate * 100 }).toFixed(1) + '%');
    
    this.updateLabel();
    this._updateHighlight();
  }

  /**
   * Reset sync offset only
   */
  resetOffset() {
    this.offset = 0;
    log.info('video', '[TranscriptSync] Offset reset to 0');
    
    this.updateLabel();
    this.app.showToast('info', 'Sync offset reset');
    this._updateHighlight();
  }

  /**
   * Reset all sync adjustments (offset and rate)
   */
  resetAll() {
    this.offset = 0;
    this.rate = 1.0;
    this.calibrationPoint = null;
    log.info('video', '[TranscriptSync] All sync reset to defaults');
    
    this.updateLabel();
    this.app.showToast('info', 'Sync reset');
    this._updateHighlight();
  }

  /**
   * Two-point calibration for drift correction
   * Step 1: Call with pointNum=1 at video start when a word is spoken
   * Step 2: Call with pointNum=2 later in video when another word is spoken
   * @param {number} pointNum - 1 or 2
   */
  calibratePoint(pointNum) {
    const video = document.getElementById('videoPlayer');
    if (!video) return;
    
    const currentVideoTime = video.currentTime;
    
    // Find the currently highlighted word
    const currentWord = document.querySelector('.teleprompter-word.current');
    if (!currentWord) {
      this.app.showToast('error', 'Play video until a word is highlighted, then calibrate');
      return;
    }
    
    const transcriptTime = parseFloat(currentWord.dataset.start);
    
    if (pointNum === 1) {
      // First calibration point
      this.calibrationPoint = {
        videoTime: currentVideoTime,
        transcriptTime: transcriptTime
      };
      this.app.showToast('info', `Point 1 set at ${this.app.formatTime(currentVideoTime)}. Now go later in video and press Alt+2`);
      log.info('video', '[TranscriptSync] Calibration point 1', { data: this.calibrationPoint });
    } else if (pointNum === 2 && this.calibrationPoint) {
      // Second calibration point - calculate rate and offset
      const p1 = this.calibrationPoint;
      const p2 = { videoTime: currentVideoTime, transcriptTime: transcriptTime };
      
      log.info('video', '[TranscriptSync] Calibration point 2', { data: p2 });
      
      // Solve: transcriptTime = videoTime * rate + offset
      const deltaTranscript = p2.transcriptTime - p1.transcriptTime;
      const deltaVideo = p2.videoTime - p1.videoTime;
      
      if (Math.abs(deltaVideo) < 5) {
        this.app.showToast('error', 'Points too close together. Go at least 30 seconds apart.');
        return;
      }
      
      const newRate = deltaTranscript / deltaVideo;
      const newOffset = p1.transcriptTime - (p1.videoTime * newRate);
      
      // Clamp to wide range
      this.rate = Math.max(0.5, Math.min(2.0, newRate));
      this.offset = Math.max(-60, Math.min(60, newOffset));
      
      log.info('video', 'TranscriptSync Calibrated: rate=', { data: + this.rate.toFixed(3 }) + 
                  ', offset=' + this.offset.toFixed(2));
      
      this.updateLabel();
      this._updateHighlight();
      
      this.app.showToast('success', `Calibrated! Rate: ${(this.rate * 100).toFixed(0)}%, Offset: ${this.offset.toFixed(1)}s`);
      this.calibrationPoint = null;
    } else {
      this.app.showToast('info', 'Press Alt+1 at video start, then Alt+2 later to calibrate');
    }
  }

  /**
   * Apply sync adjustment to a time value
   * @param {number} videoTime - Current video time
   * @returns {number} Adjusted time for transcript lookup
   */
  adjustTime(videoTime) {
    return (videoTime * this.rate) + this.offset;
  }

  /**
   * Update the UI sync label
   */
  updateLabel() {
    const label = document.getElementById('syncOffsetLabel');
    if (label) {
      // Show both offset and rate if rate is not 1.0
      if (this.rate !== 1.0) {
        label.textContent = `${this.offset >= 0 ? '+' : ''}${this.offset.toFixed(1)}s @ ${(this.rate * 100).toFixed(0)}%`;
      } else {
        label.textContent = `${this.offset >= 0 ? '+' : ''}${this.offset.toFixed(1)}s`;
      }
      // Highlight when adjusted
      label.style.color = (this.offset === 0 && this.rate === 1.0) ? '' : 'rgba(147, 112, 219, 0.9)';
    }
  }

  /**
   * Internal: Trigger highlight update
   */
  _updateHighlight() {
    const video = document.getElementById('videoPlayer');
    if (video && this.app.teleprompter) {
      this.app.teleprompter.updateHighlight(video.currentTime);
    }
  }

  /**
   * Get current sync state (for persistence)
   */
  getState() {
    return {
      offset: this.offset,
      rate: this.rate
    };
  }

  /**
   * Restore sync state (from persistence)
   */
  setState(state) {
    if (state) {
      this.offset = state.offset || 0;
      this.rate = state.rate || 1.0;
      this.updateLabel();
    }
  }
}


















