/**
 * SessionManager - Manages player session lifecycle
 * @module src/agentic-player/core/SessionManager
 */

const { getLogQueue } = require('../../../lib/log-event-queue');
const log = getLogQueue();
/**
 * Generate unique session ID
 * @returns {string} Session ID
 */
export function generateSessionId() {
  return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Session manager class
 */
export class SessionManager {
  constructor() {
    this.session = this.createEmptySession();
  }

  /**
   * Create empty session object
   * @returns {Object} Empty session
   */
  createEmptySession() {
    return {
      id: null,
      active: false,
      prompt: '',
      timeLimit: 0,
      timeWatched: 0,
      watchedIds: []
    };
  }

  /**
   * Start a new session
   * @param {string} prompt - User prompt
   * @param {number} timeLimit - Time limit in seconds (0 for unlimited)
   * @returns {Object} Session object
   */
  start(prompt, timeLimit = 0) {
    this.session = {
      id: generateSessionId(),
      active: true,
      prompt: prompt,
      timeLimit: timeLimit,
      timeWatched: 0,
      watchedIds: []
    };

    log.info('agent', '[SessionManager] Started:', { v0: this.session.id });
    return this.session;
  }

  /**
   * End current session
   * @param {string} reason - Reason for ending
   */
  end(reason = 'Session ended') {
    this.session.active = false;
    log.info('agent', '[SessionManager] Ended:', { v0: reason });
  }

  /**
   * Mark a clip as watched
   * @param {string} clipId - Clip ID
   */
  markWatched(clipId) {
    if (clipId && !this.session.watchedIds.includes(clipId)) {
      this.session.watchedIds.push(clipId);
    }
  }

  /**
   * Add watched time
   * @param {number} duration - Duration in seconds
   */
  addWatchedTime(duration) {
    this.session.timeWatched += duration;
  }

  /**
   * Check if time limit reached
   * @returns {boolean} True if limit reached
   */
  isTimeLimitReached() {
    return this.session.timeLimit > 0 && 
           this.session.timeWatched >= this.session.timeLimit;
  }

  /**
   * Get session data for API request
   * @param {number} queueLength - Current queue length
   * @returns {Object} Session data
   */
  getApiPayload(queueLength) {
    return {
      sessionId: this.session.id,
      prompt: this.session.prompt,
      watchedIds: this.session.watchedIds,
      timeWatched: this.session.timeWatched,
      timeLimit: this.session.timeLimit,
      queueLength
    };
  }

  /**
   * Check if session is active
   * @returns {boolean} Active state
   */
  get isActive() {
    return this.session.active;
  }

  /**
   * Get current session
   * @returns {Object} Session
   */
  get current() {
    return this.session;
  }
}
















