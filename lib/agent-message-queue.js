/**
 * Agent Message Queue
 * 
 * Allows agents to queue proactive messages that will be spoken
 * when the system is idle (user not speaking, no TTS in progress).
 * 
 * Features:
 * - Priority levels (urgent, normal, low)
 * - Message expiration (maxAge)
 * - Speaks when safe (idle detection)
 * - Per-agent message management
 * 
 * Usage:
 *   const { getAgentMessageQueue } = require('./lib/agent-message-queue');
 *   const queue = getAgentMessageQueue();
 *   queue.enqueue('timer-agent', 'Your timer is done!', 'urgent');
 */

const EventEmitter = require('events');

// Priority levels
const PRIORITY = {
  LOW: 0,
  NORMAL: 1,
  HIGH: 2,
  URGENT: 3
};

// Default configuration
const DEFAULT_CONFIG = {
  maxQueueSize: 50,           // Max messages in queue
  defaultMaxAgeMs: 60000,     // Default message expiration (60s)
  pollIntervalMs: 1000,       // How often to check if we can speak
  minIdleMs: 2000,            // Min idle time before speaking
};

class AgentMessageQueue extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.queue = [];
    this.isProcessing = false;
    this.pollInterval = null;
    this.lastActivityTime = Date.now();
    
    // Speak function (injected)
    this.speakFn = null;
    
    // State check function (injected)
    this.canSpeakFn = null;
    
    console.log('[AgentMessageQueue] Initialized');
  }
  
  /**
   * Set the speak function
   * @param {Function} fn - Async function that speaks text
   */
  setSpeakFunction(fn) {
    this.speakFn = fn;
  }
  
  /**
   * Set the canSpeak check function
   * @param {Function} fn - Function that returns true if safe to speak
   */
  setCanSpeakFunction(fn) {
    this.canSpeakFn = fn;
  }
  
  /**
   * Record user/system activity (resets idle timer)
   */
  recordActivity() {
    this.lastActivityTime = Date.now();
  }
  
  /**
   * Check if the system is idle enough to speak
   * @returns {boolean}
   */
  isIdle() {
    const idleTime = Date.now() - this.lastActivityTime;
    return idleTime >= this.config.minIdleMs;
  }
  
  /**
   * Check if it's safe to speak a proactive message
   * @returns {boolean}
   */
  canSpeak() {
    // Check injected function first
    if (this.canSpeakFn && typeof this.canSpeakFn === 'function') {
      try {
        if (!this.canSpeakFn()) return false;
      } catch (e) {
        console.warn('[AgentMessageQueue] canSpeakFn error:', e.message);
      }
    }
    
    // Check idle time
    return this.isIdle();
  }
  
  /**
   * Enqueue a message from an agent
   * @param {string} agentId - Agent that's sending the message
   * @param {string} message - The message to speak
   * @param {string} priority - 'urgent', 'high', 'normal', 'low'
   * @param {Object} options - { maxAgeMs, metadata }
   * @returns {string} - Message ID
   */
  enqueue(agentId, message, priority = 'normal', options = {}) {
    if (!message || message.trim() === '') {
      console.log('[AgentMessageQueue] Ignoring empty message');
      return null;
    }
    
    // Convert string priority to number
    const priorityNum = typeof priority === 'string' 
      ? PRIORITY[priority.toUpperCase()] ?? PRIORITY.NORMAL
      : priority;
    
    const id = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const maxAgeMs = options.maxAgeMs ?? this.config.defaultMaxAgeMs;
    
    const item = {
      id,
      agentId,
      message: message.trim(),
      priority: priorityNum,
      createdAt: Date.now(),
      expiresAt: Date.now() + maxAgeMs,
      metadata: options.metadata || {}
    };
    
    // Check queue size
    if (this.queue.length >= this.config.maxQueueSize) {
      // Remove lowest priority, oldest message
      this.queue.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
      const removed = this.queue.shift();
      console.log(`[AgentMessageQueue] Queue full, removed: ${removed.id}`);
    }
    
    // Insert by priority
    this.insertByPriority(item);
    
    console.log(`[AgentMessageQueue] Enqueued from ${agentId}: "${message.slice(0, 40)}..." (priority: ${priorityNum})`);
    
    // Start polling if not already
    this.startPolling();
    
    // Emit event
    this.emit('message_queued', item);
    
    return id;
  }
  
  /**
   * Insert item by priority (higher first)
   * @private
   */
  insertByPriority(item) {
    let insertIndex = this.queue.length;
    
    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i].priority < item.priority) {
        insertIndex = i;
        break;
      }
    }
    
    this.queue.splice(insertIndex, 0, item);
  }
  
  /**
   * Remove expired messages
   * @private
   */
  removeExpired() {
    const now = Date.now();
    const before = this.queue.length;
    
    this.queue = this.queue.filter(item => {
      if (item.expiresAt <= now) {
        console.log(`[AgentMessageQueue] Message expired: ${item.id}`);
        this.emit('message_expired', item);
        return false;
      }
      return true;
    });
    
    if (this.queue.length < before) {
      console.log(`[AgentMessageQueue] Removed ${before - this.queue.length} expired messages`);
    }
  }
  
  /**
   * Process the next message if safe
   * @private
   */
  async processNext() {
    if (this.isProcessing) return;
    if (this.queue.length === 0) {
      this.stopPolling();
      return;
    }
    
    // Remove expired messages first
    this.removeExpired();
    
    if (this.queue.length === 0) {
      this.stopPolling();
      return;
    }
    
    // Check if we can speak
    if (!this.canSpeak()) {
      return;
    }
    
    // Check if speak function is available
    if (!this.speakFn) {
      console.warn('[AgentMessageQueue] No speak function configured');
      return;
    }
    
    this.isProcessing = true;
    
    // Get next message (highest priority)
    const item = this.queue.shift();
    
    console.log(`[AgentMessageQueue] Speaking message from ${item.agentId}: "${item.message.slice(0, 40)}..."`);
    this.emit('message_speaking', item);
    
    try {
      await this.speakFn(item.message);
      
      console.log(`[AgentMessageQueue] Message delivered: ${item.id}`);
      this.emit('message_delivered', item);
      
    } catch (error) {
      console.error(`[AgentMessageQueue] Speak error:`, error.message);
      this.emit('message_failed', { item, error });
    } finally {
      this.isProcessing = false;
      this.recordActivity(); // Reset idle timer after speaking
    }
  }
  
  /**
   * Start polling for safe-to-speak moments
   * @private
   */
  startPolling() {
    if (this.pollInterval) return;
    
    console.log('[AgentMessageQueue] Starting poll');
    this.pollInterval = setInterval(() => {
      this.processNext();
    }, this.config.pollIntervalMs);
  }
  
  /**
   * Stop polling
   * @private
   */
  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      console.log('[AgentMessageQueue] Stopped poll (queue empty)');
    }
  }
  
  /**
   * Clear all messages from a specific agent
   * @param {string} agentId - Agent ID to clear
   * @returns {number} - Number of messages removed
   */
  clearAgent(agentId) {
    const before = this.queue.length;
    this.queue = this.queue.filter(item => item.agentId !== agentId);
    const removed = before - this.queue.length;
    
    if (removed > 0) {
      console.log(`[AgentMessageQueue] Cleared ${removed} messages from ${agentId}`);
    }
    
    return removed;
  }
  
  /**
   * Clear all messages
   */
  clearAll() {
    const count = this.queue.length;
    this.queue = [];
    this.stopPolling();
    
    console.log(`[AgentMessageQueue] Cleared all ${count} messages`);
    this.emit('cleared');
    
    return count;
  }
  
  /**
   * Get queue status
   * @returns {Object}
   */
  getStatus() {
    return {
      queueLength: this.queue.length,
      isProcessing: this.isProcessing,
      isPolling: !!this.pollInterval,
      isIdle: this.isIdle(),
      canSpeak: this.canSpeak(),
      queue: this.queue.map(item => ({
        id: item.id,
        agentId: item.agentId,
        message: item.message.slice(0, 30),
        priority: item.priority,
        expiresIn: item.expiresAt - Date.now()
      }))
    };
  }
  
  /**
   * Get pending messages for an agent
   * @param {string} agentId - Agent ID
   * @returns {Array}
   */
  getAgentMessages(agentId) {
    return this.queue.filter(item => item.agentId === agentId);
  }
  
  /**
   * Shutdown the queue
   */
  shutdown() {
    this.stopPolling();
    this.clearAll();
    this.removeAllListeners();
    console.log('[AgentMessageQueue] Shutdown complete');
  }
}

// Singleton instance
let instance = null;

/**
 * Get the singleton agent message queue
 * @returns {AgentMessageQueue}
 */
function getAgentMessageQueue() {
  if (!instance) {
    instance = new AgentMessageQueue();
  }
  return instance;
}

/**
 * Reset the singleton (for testing)
 */
function resetAgentMessageQueue() {
  if (instance) {
    instance.shutdown();
    instance = null;
  }
}

module.exports = {
  AgentMessageQueue,
  getAgentMessageQueue,
  resetAgentMessageQueue,
  PRIORITY
};
