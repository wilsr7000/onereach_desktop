/**
 * Speech Queue
 *
 * Manages a queue of speech requests to prevent overlapping audio.
 * Only one speech can be active at a time.
 *
 * Features:
 * - FIFO queue for speech requests
 * - Cancellation support (cancel current, cancel all)
 * - Priority levels (urgent messages can skip queue)
 * - Timeout protection
 */

const EventEmitter = require('events');
const { getLogQueue } = require('../../../lib/log-event-queue');
const log = getLogQueue();

// Priority levels
const PRIORITY = {
  LOW: 0,
  NORMAL: 1,
  HIGH: 2,
  URGENT: 3, // Skips queue, cancels current speech
};

class SpeechQueue extends EventEmitter {
  constructor(options = {}) {
    super();

    // Queue of pending speech items
    this.queue = [];

    // Currently speaking item
    this.currentItem = null;

    // Reference to the speech function (injected)
    this.speakFn = options.speakFn || null;

    // Reference to cancel function (injected)
    this.cancelFn = options.cancelFn || null;

    // Is speech currently in progress?
    this.isSpeaking = false;

    // Timeout for speech completion (prevent hanging)
    this.speechTimeout = options.speechTimeout || 30000; // 30 seconds max

    // Current timeout handle
    this.timeoutHandle = null;

    // Waiting for speech to complete
    this.completionResolver = null;

    log.info('voice', 'SpeechQueue initialized');
  }

  /**
   * Set the speak function
   * @param {Function} fn - Async function that speaks text
   */
  setSpeakFunction(fn) {
    this.speakFn = fn;
  }

  /**
   * Set the cancel function
   * @param {Function} fn - Function that cancels current speech
   */
  setCancelFunction(fn) {
    this.cancelFn = fn;
  }

  /**
   * Add text to the speech queue
   * @param {string} text - Text to speak
   * @param {Object} options - { priority, metadata }
   * @returns {Promise<boolean>} - Resolves when speech completes
   */
  async enqueue(text, options = {}) {
    if (!text || text.trim() === '') {
      log.info('voice', 'SpeechQueue ignoring empty text');
      return true;
    }

    const priority = options.priority ?? PRIORITY.NORMAL;
    const id = `speech_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const item = {
      id,
      text: text.trim(),
      priority,
      metadata: options.metadata || {},
      createdAt: Date.now(),
    };

    log.info('voice', 'SpeechQueue enqueuing', { text: text.substring(0, 50), priority });

    // URGENT priority: Cancel current speech and skip queue
    if (priority === PRIORITY.URGENT) {
      log.info('voice', 'SpeechQueue URGENT: cancelling current and skipping queue');

      // Cancel current speech if any
      if (this.isSpeaking) {
        await this.cancelCurrent();
      }

      // Clear lower priority items from queue
      this.queue = this.queue.filter((q) => q.priority >= PRIORITY.URGENT);

      // Add to front of queue
      this.queue.unshift(item);
    } else {
      // Normal priority: Add to queue based on priority
      this.insertByPriority(item);
    }

    // Start processing if not already
    this.processNext();

    // Return a promise that resolves when THIS item completes
    return new Promise((resolve) => {
      item.resolve = resolve;
    });
  }

  /**
   * Insert item into queue by priority (higher priority first)
   */
  insertByPriority(item) {
    // Find position to insert
    let insertIndex = this.queue.length;

    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i].priority < item.priority) {
        insertIndex = i;
        break;
      }
    }

    this.queue.splice(insertIndex, 0, item);
    log.info('voice', 'SpeechQueue queue size updated', { queueSize: this.queue.length });
  }

  /**
   * Process the next item in the queue
   */
  async processNext() {
    // Already speaking, wait for completion
    if (this.isSpeaking) {
      return;
    }

    // Nothing in queue
    if (this.queue.length === 0) {
      log.info('voice', 'SpeechQueue queue empty');
      this.emit('queue_empty');
      return;
    }

    // Check if speak function is available
    if (!this.speakFn) {
      log.error('voice', 'SpeechQueue no speak function configured');
      return;
    }

    // Get next item
    this.currentItem = this.queue.shift();
    this.isSpeaking = true;

    log.info('voice', 'SpeechQueue speaking', { text: this.currentItem.text.substring(0, 50) });
    this.emit('speech_start', this.currentItem);

    // Set timeout protection
    this.timeoutHandle = setTimeout(() => {
      log.warn('voice', 'SpeechQueue speech timeout, forcing completion');
      this.onSpeechComplete(false);
    }, this.speechTimeout);

    try {
      // Call the speak function with text and metadata (e.g., voice)
      const success = await this.speakFn(this.currentItem.text, this.currentItem.metadata);

      // Don't call onSpeechComplete here - wait for audio_done event
      // The caller should call markComplete() when audio finishes
      if (!success) {
        log.warn('voice', 'SpeechQueue speak function returned false');
        this.onSpeechComplete(false);
      }
    } catch (err) {
      log.error('voice', 'SpeechQueue speech error', { error: err.message });
      this.onSpeechComplete(false);
    }
  }

  /**
   * Mark current speech as complete
   * Call this when audio playback finishes
   */
  markComplete() {
    if (this.isSpeaking) {
      log.info('voice', 'SpeechQueue speech marked complete');
      this.onSpeechComplete(true);
    }
  }

  /**
   * Internal: Handle speech completion
   */
  onSpeechComplete(success) {
    // Clear timeout
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }

    // Resolve the promise for this item
    if (this.currentItem?.resolve) {
      this.currentItem.resolve(success);
    }

    // Emit completion event
    this.emit('speech_complete', {
      item: this.currentItem,
      success,
    });

    // Clear current item
    this.currentItem = null;
    this.isSpeaking = false;

    // Process next item
    setImmediate(() => this.processNext());
  }

  /**
   * Cancel current speech
   * @returns {Promise<boolean>}
   */
  async cancelCurrent() {
    if (!this.isSpeaking) {
      return true;
    }

    log.info('voice', 'SpeechQueue cancelling current speech');

    if (this.cancelFn) {
      try {
        await this.cancelFn();
      } catch (err) {
        log.warn('voice', 'SpeechQueue cancel error', { error: err.message });
      }
    }

    // Force completion
    this.onSpeechComplete(false);

    return true;
  }

  /**
   * Cancel all pending speech (current + queue)
   */
  async cancelAll() {
    log.info('voice', 'SpeechQueue cancelling all', { pending: this.queue.length });

    // Resolve all pending items as cancelled
    for (const item of this.queue) {
      if (item.resolve) {
        item.resolve(false);
      }
    }

    // Clear queue
    this.queue = [];

    // Cancel current
    await this.cancelCurrent();

    this.emit('cancelled');
  }

  /**
   * Check if there's any pending or active speech
   * Use this before disconnecting to prevent cutting off speech
   * @returns {boolean}
   */
  hasPendingOrActiveSpeech() {
    return this.isSpeaking || this.queue.length > 0;
  }

  /**
   * Get queue length
   * @returns {number}
   */
  getQueueLength() {
    return this.queue.length;
  }

  /**
   * Get queue status
   */
  getStatus() {
    return {
      isSpeaking: this.isSpeaking,
      currentItem: this.currentItem
        ? {
            id: this.currentItem.id,
            text: this.currentItem.text.substring(0, 50),
            priority: this.currentItem.priority,
          }
        : null,
      queueLength: this.queue.length,
      queue: this.queue.map((item) => ({
        id: item.id,
        text: item.text.substring(0, 30),
        priority: item.priority,
      })),
    };
  }

  /**
   * Clear the queue (but don't cancel current speech)
   */
  clearQueue() {
    log.info('voice', 'SpeechQueue clearing queue', { items: this.queue.length });

    for (const item of this.queue) {
      if (item.resolve) {
        item.resolve(false);
      }
    }

    this.queue = [];
  }
}

// Singleton instance
let instance = null;

function getSpeechQueue() {
  if (!instance) {
    instance = new SpeechQueue();
  }
  return instance;
}

module.exports = {
  SpeechQueue,
  getSpeechQueue,
  PRIORITY,
};
