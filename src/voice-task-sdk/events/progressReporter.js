/**
 * Progress Reporter
 * 
 * Allows agents to report progress updates during long-running operations.
 * The Router can listen to these events and speak updates to the user.
 * 
 * Usage:
 *   progressReporter.report('media-agent', 'Searching for jazz music...');
 *   progressReporter.report('media-agent', 'Found 5 results, picking best match...');
 */

const EventEmitter = require('events');
const { getLogQueue } = require('../../../lib/log-event-queue');
const log = getLogQueue();

class ProgressReporter extends EventEmitter {
  constructor() {
    super();
    this.lastReportTime = new Map(); // agentId -> timestamp
    this.minInterval = 2000; // Minimum ms between progress reports per agent
  }

  /**
   * Report progress from an agent
   * @param {string} agentId - Which agent is reporting
   * @param {string} message - Progress message to speak
   * @param {Object} options - Optional settings
   * @param {boolean} options.force - Bypass throttle
   * @param {string} options.type - Type: 'searching', 'processing', 'waiting', 'info'
   */
  report(agentId, message, options = {}) {
    const now = Date.now();
    const lastReport = this.lastReportTime.get(agentId) || 0;

    // Throttle unless forced
    if (!options.force && (now - lastReport) < this.minInterval) {
      log.info('voice', '[ProgressReporter] Throttled: -', { v0: agentId, v1: message });
      return false;
    }

    this.lastReportTime.set(agentId, now);

    const event = {
      agentId,
      message,
      type: options.type || 'info',
      timestamp: now
    };

    log.info('voice', '[ProgressReporter] :', { v0: agentId, v1: message });
    this.emit('progress', event);
    
    return true;
  }

  /**
   * Report that an agent is starting work
   * @param {string} agentId 
   * @param {string} taskDescription 
   */
  started(agentId, taskDescription) {
    return this.report(agentId, taskDescription, { type: 'searching', force: true });
  }

  /**
   * Report that an agent completed work
   * @param {string} agentId 
   */
  completed(agentId) {
    this.lastReportTime.delete(agentId);
    this.emit('completed', { agentId, timestamp: Date.now() });
  }

  /**
   * Report that an agent failed
   * @param {string} agentId 
   * @param {string} reason 
   */
  failed(agentId, reason) {
    this.lastReportTime.delete(agentId);
    this.emit('failed', { agentId, reason, timestamp: Date.now() });
  }

  /**
   * Clear throttle for an agent (useful after long pauses)
   * @param {string} agentId 
   */
  clearThrottle(agentId) {
    this.lastReportTime.delete(agentId);
  }

  /**
   * Set minimum interval between reports
   * @param {number} ms 
   */
  setMinInterval(ms) {
    this.minInterval = ms;
  }
}

// Singleton instance
const progressReporter = new ProgressReporter();

module.exports = progressReporter;
