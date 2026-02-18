/**
 * MicrophoneManager.js - Unified Microphone Access
 *
 * Based on the working Voice Mode implementation from preload.js
 * Provides centralized mic access with proper async cleanup.
 *
 * Features:
 * - Single source of truth for microphone state
 * - Consumer tracking (know what's using the mic)
 * - Proper async cleanup (prevents "Cannot Control Mic" errors)
 * - Conflict detection (warn if mic already in use)
 */

const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();
class MicrophoneManager {
  constructor() {
    // Stream and audio context
    this.stream = null;
    this.audioContext = null;
    this.source = null;
    this.processor = null;

    // Consumer tracking
    this.activeConsumer = null;
    this.acquiredAt = null;

    // Default constraints (from working voice mode implementation)
    this.defaultConstraints = {
      channelCount: 1,
      sampleRate: 24000,
      echoCancellation: true,
      noiseSuppression: true,
    };
  }

  /**
   * Acquire microphone access
   * @param {string} consumerId - Identifier for the consumer (e.g., 'voice-mode', 'recorder')
   * @param {object} constraints - Audio constraints (merged with defaults)
   * @returns {object|null} { stream, audioContext } or null if mic is in use
   */
  async acquire(consumerId, constraints = {}) {
    // Check if already in use by different consumer
    if (this.stream && this.activeConsumer !== consumerId) {
      log.warn('voice', '[MicManager] Mic already in use by "", requested by ""', {
        v0: this.activeConsumer,
        v1: consumerId,
      });
      return null;
    }

    // Already acquired by this consumer
    if (this.stream && this.activeConsumer === consumerId) {
      log.info('voice', '[MicManager] Mic already held by ""', { v0: consumerId });
      return { stream: this.stream, audioContext: this.audioContext };
    }

    try {
      // Merge constraints with defaults
      const audioConstraints = {
        ...this.defaultConstraints,
        ...constraints,
      };

      const sampleRate = audioConstraints.sampleRate || 24000;

      // Acquire stream (matches working voice mode pattern)
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
      });

      // Create audio context
      this.audioContext = new AudioContext({ sampleRate });

      // Track consumer
      this.activeConsumer = consumerId;
      this.acquiredAt = Date.now();

      log.info('voice', '[MicManager] 🎤 Mic acquired by ""', { v0: consumerId });

      return { stream: this.stream, audioContext: this.audioContext };
    } catch (error) {
      log.error('voice', '[MicManager] Failed to acquire mic for "":', { v0: consumerId, arg0: error });
      throw error;
    }
  }

  /**
   * Create audio processor for streaming
   * Mirrors the voice mode's audio processing setup
   * @param {function} onAudioData - Callback receiving base64-encoded audio chunks
   * @returns {object} { processor, source }
   */
  createProcessor(onAudioData) {
    if (!this.stream || !this.audioContext) {
      throw new Error('[MicManager] Must acquire mic before creating processor');
    }

    this.source = this.audioContext.createMediaStreamSource(this.stream);
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

    this.processor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);

      // Convert Float32 to Int16 (matches voice mode implementation)
      const int16Data = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        const s = Math.max(-1, Math.min(1, inputData[i]));
        int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }

      // Convert to base64
      const uint8Array = new Uint8Array(int16Data.buffer);
      let binary = '';
      for (let i = 0; i < uint8Array.length; i++) {
        binary += String.fromCharCode(uint8Array[i]);
      }
      const base64 = btoa(binary);

      onAudioData(base64);
    };

    this.source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);

    return { processor: this.processor, source: this.source };
  }

  /**
   * Release microphone - MUST be awaited for proper cleanup
   * Mirrors the working voice mode stop() function
   * @param {string} consumerId - Must match the consumer that acquired
   */
  async release(consumerId) {
    // Verify ownership
    if (this.activeConsumer !== consumerId) {
      if (this.activeConsumer) {
        log.warn('voice', '[MicManager] "" tried to release mic owned by ""', {
          v0: consumerId,
          v1: this.activeConsumer,
        });
      }
      return;
    }

    // Cleanup in proper order (matches voice mode pattern)
    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }

    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }

    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }

    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }

    const duration = this.acquiredAt ? Date.now() - this.acquiredAt : 0;
    this.activeConsumer = null;
    this.acquiredAt = null;

    log.info('voice', '[MicManager] 🎤 Mic released by "" (held for ms)', { v0: consumerId, v1: duration });
  }

  /**
   * Force release - for emergency cleanup (e.g., window close)
   * Use with caution - prefer release() with proper consumer ID
   */
  async forceRelease() {
    const consumer = this.activeConsumer || 'unknown';
    log.warn('voice', '[MicManager] Force releasing mic (was held by "")', { v0: consumer });

    if (this.processor) this.processor.disconnect();
    if (this.source) this.source.disconnect();
    if (this.audioContext) await this.audioContext.close();
    if (this.stream) this.stream.getTracks().forEach((track) => track.stop());

    this.processor = null;
    this.source = null;
    this.audioContext = null;
    this.stream = null;
    this.activeConsumer = null;
    this.acquiredAt = null;
  }

  /**
   * Check if mic is currently in use
   * @returns {boolean}
   */
  isInUse() {
    return !!this.stream;
  }

  /**
   * Get the current consumer holding the mic
   * @returns {string|null}
   */
  getActiveConsumer() {
    return this.activeConsumer;
  }

  /**
   * Get mic status for debugging
   * @returns {object}
   */
  getStatus() {
    return {
      inUse: this.isInUse(),
      consumer: this.activeConsumer,
      acquiredAt: this.acquiredAt,
      duration: this.acquiredAt ? Date.now() - this.acquiredAt : null,
      hasStream: !!this.stream,
      hasAudioContext: !!this.audioContext,
      hasProcessor: !!this.processor,
    };
  }
}

// Singleton instance
const microphoneManager = new MicrophoneManager();

// Export for Node.js (main process) and browser (renderer)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MicrophoneManager, microphoneManager };
}

// Also make available globally in browser context
if (typeof window !== 'undefined') {
  window.MicrophoneManager = MicrophoneManager;
  window.microphoneManager = microphoneManager;
}
