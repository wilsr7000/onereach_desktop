/**
 * AudioScrubber - Real-time audio scrubbing while dragging playhead
 * 
 * Features:
 * - Plays short audio snippets at the current position
 * - Smooth scrubbing experience
 * - Debounced to avoid audio glitches
 */

export class AudioScrubber {
  constructor(audioContext, audioBuffer) {
    this.ctx = audioContext;
    this.buffer = audioBuffer;
    this.scrubSource = null;
    this.scrubGain = null;
    this.lastScrubTime = -1;
    this.scrubDuration = 0.05; // 50ms snippet
    this.minScrubDistance = 0.01; // Minimum time change to trigger new scrub
    this.isEnabled = true;
    
    this._initGain();
    
    console.log('[AudioScrubber] Initialized');
  }
  
  /**
   * Initialize the gain node for scrub audio
   */
  _initGain() {
    if (!this.ctx) return;
    
    this.scrubGain = this.ctx.createGain();
    this.scrubGain.gain.value = 0.7; // Slightly quieter for scrubbing
    this.scrubGain.connect(this.ctx.destination);
  }
  
  /**
   * Update the audio buffer (when track changes)
   */
  setBuffer(audioBuffer) {
    this.buffer = audioBuffer;
    console.log('[AudioScrubber] Buffer updated');
  }
  
  /**
   * Scrub audio at the specified time position
   * @param {number} time - Time position in seconds
   */
  scrub(time) {
    if (!this.isEnabled || !this.buffer || !this.ctx || !this.scrubGain) return;
    
    // Don't re-trigger if same position (debounce)
    if (Math.abs(time - this.lastScrubTime) < this.minScrubDistance) return;
    this.lastScrubTime = time;
    
    // Ensure audio context is running
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    
    // Stop previous scrub source
    if (this.scrubSource) {
      try {
        this.scrubSource.stop();
      } catch (e) {
        // Ignore - source may already be stopped
      }
      this.scrubSource = null;
    }
    
    // Create new source for scrub
    try {
      this.scrubSource = this.ctx.createBufferSource();
      this.scrubSource.buffer = this.buffer;
      this.scrubSource.connect(this.scrubGain);
      
      // Clamp time to valid range
      const safeTime = Math.max(0, Math.min(time, this.buffer.duration - this.scrubDuration));
      
      // Play short snippet at position
      this.scrubSource.start(0, safeTime, this.scrubDuration);
      
    } catch (error) {
      console.warn('[AudioScrubber] Scrub error:', error.message);
    }
  }
  
  /**
   * Stop scrubbing
   */
  stop() {
    if (this.scrubSource) {
      try {
        this.scrubSource.stop();
      } catch (e) {
        // Ignore - source may already be stopped
      }
      this.scrubSource = null;
    }
    this.lastScrubTime = -1;
  }
  
  /**
   * Enable/disable scrubbing
   */
  setEnabled(enabled) {
    this.isEnabled = enabled;
    if (!enabled) {
      this.stop();
    }
    console.log('[AudioScrubber] Enabled:', enabled);
  }
  
  /**
   * Set scrub volume
   * @param {number} volume - Volume level (0.0 to 1.0)
   */
  setVolume(volume) {
    if (this.scrubGain) {
      this.scrubGain.gain.value = Math.max(0, Math.min(1, volume));
    }
  }
  
  /**
   * Set scrub snippet duration
   * @param {number} duration - Duration in seconds (default 0.05)
   */
  setScrubDuration(duration) {
    this.scrubDuration = Math.max(0.01, Math.min(0.2, duration));
  }
  
  /**
   * Dispose of resources
   */
  dispose() {
    this.stop();
    
    if (this.scrubGain) {
      this.scrubGain.disconnect();
      this.scrubGain = null;
    }
    
    this.buffer = null;
    this.ctx = null;
    
    console.log('[AudioScrubber] Disposed');
  }
}









