/**
 * QueueManager - Manages clip queue
 * @module src/agentic-player/services/QueueManager
 */

/**
 * Queue manager class
 */
export class QueueManager {
  constructor() {
    this.queue = [];
    this.history = [];
    this.endSignaled = false;
  }

  /**
   * Add clips to queue
   * @param {Array} clips - Clips to add
   */
  addClips(clips) {
    if (!clips || clips.length === 0) return;
    
    this.queue.push(...clips);
    console.log(`[QueueManager] Added ${clips.length} clips (total: ${this.queue.length})`);
  }

  /**
   * Get and remove next clip from queue
   * @returns {Object|null} Next clip or null
   */
  getNext() {
    if (this.queue.length === 0) return null;
    
    const clip = this.queue.shift();
    this.history.push(clip);
    return clip;
  }

  /**
   * Peek at next clip without removing
   * @returns {Object|null} Next clip or null
   */
  peekNext() {
    return this.queue.length > 0 ? this.queue[0] : null;
  }

  /**
   * Mark end of stream
   */
  signalEnd() {
    this.endSignaled = true;
    console.log('[QueueManager] End signaled');
  }

  /**
   * Check if should prefetch more clips
   * @param {number} threshold - Prefetch threshold
   * @returns {boolean} True if should prefetch
   */
  shouldPrefetch(threshold) {
    return this.queue.length <= threshold && !this.endSignaled;
  }

  /**
   * Check if queue is empty and ended
   * @returns {boolean} True if playback complete
   */
  isComplete() {
    return this.queue.length === 0 && this.endSignaled;
  }

  /**
   * Reset queue
   */
  reset() {
    this.queue = [];
    this.history = [];
    this.endSignaled = false;
  }

  /**
   * Get queue length
   */
  get length() {
    return this.queue.length;
  }

  /**
   * Get history length
   */
  get historyLength() {
    return this.history.length;
  }

  /**
   * Get current clip (last in history)
   */
  get currentClip() {
    return this.history.length > 0 ? this.history[this.history.length - 1] : null;
  }
}
















