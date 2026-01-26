/**
 * Help Agent
 * 
 * Lists available capabilities and provides guidance.
 * Can discover capabilities from the agent registry.
 */

const helpAgent = {
  id: 'help-agent',
  name: 'Help Agent',
  description: 'Lists available capabilities',
  categories: ['system', 'help'],
  keywords: ['help', 'what can you do', 'capabilities', 'commands', 'how do i', 'what do you'],
  
  /**
   * Bid on a task
   * @param {Object} task - { content, ... }
   * @returns {Object|null} - { confidence } or null to not bid
   */
  bid(task) {
    if (!task?.content) return null;
    
    const lower = task.content.toLowerCase();
    
    // Help keywords
    if (lower.includes('help') || 
        lower.includes('what can you do') ||
        lower.includes('capabilities') ||
        lower.includes('commands') ||
        /what (do you|can you)/.test(lower)) {
      return { confidence: 0.95 };
    }
    
    return null;
  },
  
  /**
   * Execute the task
   * @param {Object} task - { content, context, ... }
   * @returns {Object} - { success, message }
   */
  async execute(task, context = {}) {
    const lower = task.content.toLowerCase();
    
    // Build capabilities list
    const capabilities = [
      "I can help you with several things.",
      "Ask me the time or date.",
      "Check the weather in any city.",
      "Control your music: play, pause, skip, or adjust volume.",
      "Say 'cancel' to stop, 'repeat' to hear again, or 'undo' to reverse."
    ];
    
    // If they asked about specific capability
    if (lower.includes('time') || lower.includes('date')) {
      return {
        success: true,
        message: "Just ask 'what time is it' or 'what's the date' and I'll tell you."
      };
    }
    
    if (lower.includes('weather')) {
      return {
        success: true,
        message: "Say 'what's the weather in' followed by a city name, and I'll check for you."
      };
    }
    
    if (lower.includes('music') || lower.includes('play') || lower.includes('volume')) {
      return {
        success: true,
        message: "You can say 'play music', 'pause', 'skip', 'next', 'volume up', 'volume down', or 'volume' followed by a number."
      };
    }
    
    if (lower.includes('undo') || lower.includes('cancel') || lower.includes('repeat')) {
      return {
        success: true,
        message: "Say 'cancel' to stop what I'm doing, 'repeat' to hear my last response again, or 'undo' within 60 seconds to reverse an action like volume change."
      };
    }
    
    // General help
    return { 
      success: true, 
      message: capabilities.join(' ') 
    };
  }
};

module.exports = helpAgent;
