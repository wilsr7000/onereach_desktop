/**
 * Notification Manager
 * 
 * Manages proactive notifications that can interrupt the user.
 * Includes scheduling, do-not-disturb, and priority handling.
 * 
 * Usage:
 *   notificationManager.schedule('timer_1', 'Your timer is up!', { delay: 60000 });
 *   notificationManager.cancel('timer_1');
 */

const EventEmitter = require('events');
const { getLogQueue } = require('../../../lib/log-event-queue');
const log = getLogQueue();

// Notification priorities
const PRIORITY = {
  LOW: 1,      // Can wait, silent
  NORMAL: 2,   // Standard notification
  HIGH: 3,     // Important, should notify
  URGENT: 4    // Critical, always notify
};

class NotificationManager extends EventEmitter {
  constructor() {
    super();
    
    // Scheduled notifications: id -> { timeout, notification }
    this.scheduled = new Map();
    
    // Do not disturb
    this.doNotDisturb = false;
    this.dndEndTime = null;
    
    // Active conversation flag - don't interrupt
    this.activeConversation = false;
    this.lastActivityTime = Date.now();
    
    // Queue for notifications blocked by DND or active conversation
    this.pendingQueue = [];
    
    // Inactivity threshold for auto-delivery
    this.inactivityThreshold = 5000; // 5 seconds of inactivity
  }

  /**
   * Schedule a notification
   * @param {string} id - Unique identifier for this notification
   * @param {string} message - Message to speak
   * @param {Object} options
   * @param {number} options.delay - Ms from now (default: immediate)
   * @param {Date} options.at - Specific time to notify
   * @param {number} options.priority - PRIORITY level (default: NORMAL)
   * @param {Function} options.onDelivered - Callback when delivered
   * @param {Function} options.onCancelled - Callback when cancelled
   */
  schedule(id, message, options = {}) {
    // Cancel any existing notification with same ID
    this.cancel(id);
    
    const priority = options.priority || PRIORITY.NORMAL;
    const delay = options.delay || (options.at ? options.at.getTime() - Date.now() : 0);
    
    if (delay < 0) {
      log.info('voice', '[NotificationManager] Notification "" scheduled in past, delivering now', { v0: id });
    }
    
    const notification = {
      id,
      message,
      priority,
      scheduledFor: Date.now() + Math.max(0, delay),
      onDelivered: options.onDelivered,
      onCancelled: options.onCancelled
    };
    
    const timeout = setTimeout(() => {
      this.deliver(notification);
    }, Math.max(0, delay));
    
    this.scheduled.set(id, { timeout, notification });
    
    log.info('voice', '[NotificationManager] Scheduled "" in ms (priority: )', { v0: id, v1: delay, v2: priority });
    
    return true;
  }

  /**
   * Schedule a timer notification
   * @param {number} seconds - Duration in seconds
   * @param {string} label - Optional label for the timer
   * @returns {string} - Timer ID for cancellation
   */
  setTimer(seconds, label = '') {
    const id = `timer_${Date.now()}`;
    const message = label 
      ? `Your ${label} timer is up!`
      : `Your ${seconds} second timer is up!`;
    
    this.schedule(id, message, {
      delay: seconds * 1000,
      priority: PRIORITY.HIGH
    });
    
    return id;
  }

  /**
   * Schedule a reminder
   * @param {string} message - What to remind about
   * @param {number|Date} when - Ms delay or specific Date
   * @returns {string} - Reminder ID
   */
  setReminder(message, when) {
    const id = `reminder_${Date.now()}`;
    const options = {
      priority: PRIORITY.NORMAL
    };
    
    if (when instanceof Date) {
      options.at = when;
    } else {
      options.delay = when;
    }
    
    this.schedule(id, `Reminder: ${message}`, options);
    
    return id;
  }

  /**
   * Cancel a scheduled notification
   * @param {string} id 
   * @returns {boolean} - True if cancelled
   */
  cancel(id) {
    const entry = this.scheduled.get(id);
    if (entry) {
      clearTimeout(entry.timeout);
      this.scheduled.delete(id);
      
      if (entry.notification.onCancelled) {
        entry.notification.onCancelled();
      }
      
      log.info('voice', '[NotificationManager] Cancelled ""', { v0: id });
      return true;
    }
    
    // Also check pending queue
    const idx = this.pendingQueue.findIndex(n => n.id === id);
    if (idx >= 0) {
      const removed = this.pendingQueue.splice(idx, 1)[0];
      if (removed.onCancelled) {
        removed.onCancelled();
      }
      return true;
    }
    
    return false;
  }

  /**
   * Cancel all notifications matching a prefix
   * @param {string} prefix - ID prefix (e.g., 'timer_')
   * @returns {number} - Count cancelled
   */
  cancelAllWithPrefix(prefix) {
    let count = 0;
    for (const id of this.scheduled.keys()) {
      if (id.startsWith(prefix)) {
        this.cancel(id);
        count++;
      }
    }
    return count;
  }

  /**
   * Attempt to deliver a notification
   * @param {Object} notification 
   */
  deliver(notification) {
    // Remove from scheduled
    this.scheduled.delete(notification.id);
    
    // Check if we can deliver now
    if (this.shouldDeliver(notification)) {
      this.doDeliver(notification);
    } else {
      // Queue for later
      log.info('voice', '[NotificationManager] Queueing "" (DND or active conversation)', { v0: notification.id });
      this.pendingQueue.push(notification);
      this.pendingQueue.sort((a, b) => b.priority - a.priority);
    }
  }

  /**
   * Check if notification should be delivered now
   * @param {Object} notification 
   * @returns {boolean}
   */
  shouldDeliver(notification) {
    // Urgent always delivers
    if (notification.priority >= PRIORITY.URGENT) {
      return true;
    }
    
    // Check DND
    if (this.doNotDisturb) {
      if (this.dndEndTime && Date.now() > this.dndEndTime) {
        this.doNotDisturb = false;
        this.dndEndTime = null;
      } else {
        return false;
      }
    }
    
    // Check active conversation
    if (this.activeConversation) {
      const inactiveFor = Date.now() - this.lastActivityTime;
      if (inactiveFor < this.inactivityThreshold) {
        return false;
      }
    }
    
    return true;
  }

  /**
   * Actually deliver the notification
   * @param {Object} notification 
   */
  doDeliver(notification) {
    log.info('voice', '[NotificationManager] Delivering "":', { v0: notification.id, v1: notification.message });
    
    this.emit('notify', {
      id: notification.id,
      message: notification.message,
      priority: notification.priority,
      timestamp: Date.now()
    });
    
    if (notification.onDelivered) {
      notification.onDelivered();
    }
  }

  /**
   * Mark that user activity occurred (delays pending notifications)
   */
  markActivity() {
    this.lastActivityTime = Date.now();
  }

  /**
   * Set active conversation state
   * @param {boolean} active 
   */
  setActiveConversation(active) {
    this.activeConversation = active;
    this.lastActivityTime = Date.now();
    
    // If conversation ended, try to deliver pending
    if (!active) {
      setTimeout(() => this.deliverPending(), this.inactivityThreshold);
    }
  }

  /**
   * Enable do not disturb
   * @param {number} duration - Optional duration in ms
   */
  enableDND(duration = null) {
    this.doNotDisturb = true;
    this.dndEndTime = duration ? Date.now() + duration : null;
    log.info('voice', `[NotificationManager] DND enabled${duration ? ` for ${duration}ms` : ''}`);
  }

  /**
   * Disable do not disturb
   */
  disableDND() {
    this.doNotDisturb = false;
    this.dndEndTime = null;
    log.info('voice', '[NotificationManager] DND disabled');
    
    // Try to deliver pending
    this.deliverPending();
  }

  /**
   * Try to deliver pending notifications
   */
  deliverPending() {
    if (this.pendingQueue.length === 0) return;
    
    // Check if we can deliver
    const canDeliver = !this.doNotDisturb && 
      (!this.activeConversation || Date.now() - this.lastActivityTime > this.inactivityThreshold);
    
    if (!canDeliver) return;
    
    // Deliver highest priority pending notification
    const notification = this.pendingQueue.shift();
    if (notification && this.shouldDeliver(notification)) {
      this.doDeliver(notification);
      
      // Schedule next delivery after a short delay
      if (this.pendingQueue.length > 0) {
        setTimeout(() => this.deliverPending(), 2000);
      }
    } else if (notification) {
      // Put it back
      this.pendingQueue.unshift(notification);
    }
  }

  /**
   * Get list of pending notifications
   * @returns {Array}
   */
  getPending() {
    const pending = [];
    
    for (const [id, entry] of this.scheduled) {
      pending.push({
        id,
        message: entry.notification.message,
        scheduledFor: entry.notification.scheduledFor,
        priority: entry.notification.priority
      });
    }
    
    for (const n of this.pendingQueue) {
      pending.push({
        id: n.id,
        message: n.message,
        priority: n.priority,
        queued: true
      });
    }
    
    return pending;
  }

  /**
   * Get status
   * @returns {Object}
   */
  getStatus() {
    return {
      scheduledCount: this.scheduled.size,
      queuedCount: this.pendingQueue.length,
      doNotDisturb: this.doNotDisturb,
      dndEndTime: this.dndEndTime,
      activeConversation: this.activeConversation,
      lastActivity: this.lastActivityTime
    };
  }
}

// Singleton instance
const notificationManager = new NotificationManager();

// Export both class and singleton
module.exports = notificationManager;
module.exports.NotificationManager = NotificationManager;
module.exports.PRIORITY = PRIORITY;
