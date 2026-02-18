/**
 * Exchange Event Bus - Shared EventEmitter that decouples exchange-bridge and hud-api.
 *
 * Both modules import this singleton instead of requiring each other directly.
 * This eliminates the circular dependency between exchange-bridge.js and hud-api.js.
 *
 * Events:
 *   exchange:lifecycle  - Task lifecycle events (queued, assigned, settled, etc.)
 *   exchange:result     - Task completion results
 *   exchange:disambig   - Disambiguation prompts
 *   exchange:needsInput - Multi-turn input requests
 *   submit:task         - Task submission requests (hud-api -> exchange-bridge)
 *   agent:hot-connect   - Connect a new/updated agent to the exchange (agent-store -> exchange-bridge)
 *   agent:disconnect    - Disconnect an agent from the exchange (agent-store -> exchange-bridge)
 *
 * Pull-based registrations (exchange-bridge registers, hud-api calls):
 *   getExchange()       - Get the exchange instance
 *   processSubmit()     - Full submission pipeline
 *   cancelTask()        - Cancel a task
 */

'use strict';

const EventEmitter = require('events');

class ExchangeEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);

    // Pull-based function registrations
    this._processSubmit = null;
    this._getExchange = null;
    this._cancelTask = null;
    this._getQueueStats = null;
  }

  /**
   * Register the exchange bridge's pull-based functions.
   * Called by exchange-bridge during initialization.
   */
  registerBridge({ processSubmit, getExchange, cancelTask, getQueueStats }) {
    this._processSubmit = processSubmit;
    this._getExchange = getExchange;
    this._cancelTask = cancelTask;
    this._getQueueStats = getQueueStats;
  }

  /** Get the exchange instance (pull-based) */
  getExchange() {
    return this._getExchange ? this._getExchange() : null;
  }

  /** Submit a task through the full pipeline (pull-based) */
  async processSubmit(text, options) {
    if (!this._processSubmit) {
      return { taskId: null, queued: false, error: 'Exchange bridge not initialized' };
    }
    return this._processSubmit(text, options);
  }

  /** Cancel a task (pull-based) */
  cancelTask(taskId) {
    if (this._cancelTask) this._cancelTask(taskId);
  }

  /** Get queue stats (pull-based) */
  getQueueStats() {
    if (this._getQueueStats) return this._getQueueStats();
    return { pending: 0, active: 0, completed: 0 };
  }
}

// Singleton
module.exports = new ExchangeEventBus();
