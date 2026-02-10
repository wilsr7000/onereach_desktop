/**
 * Help Agent - A Thinking Agent
 * 
 * Lists available capabilities and provides guidance.
 * 
 * Thinking Agent features:
 * - Remembers recently asked topics
 * - Tracks skill level (beginner/advanced) to adjust responses
 * - Can ask clarifying questions for vague help requests
 */

const { getAgentMemory } = require('../../lib/agent-memory-store');
const { learnFromInteraction } = require('../../lib/thinking-agent');
const ai = require('../../lib/ai-service');

const helpAgent = {
  id: 'help-agent',
  name: 'Help Agent',
  description: 'Lists available capabilities - remembers your skill level',
  voice: 'alloy',  // Neutral, helpful - see VOICE-GUIDE.md
  categories: ['system', 'help'],
  keywords: ['help', 'what can you do', 'capabilities', 'commands', 'how do i', 'what do you'],
  executionType: 'informational',  // Describes features, no side effects -- can fast-path in bid
  
  prompt: `Help Agent lists the app's capabilities and explains how to use features.

HIGH CONFIDENCE (0.85+) for:
- "What can you do?" / "What are your capabilities?"
- "Help" / "Help me" / "I need help"
- "What features does this app have?"
- "Show me what agents are available"
- "How do I use the time agent?" / "How do I check weather?"

LOW CONFIDENCE (0.00) -- do NOT bid on:
- Actual task requests: "What time is it?" (time agent handles that)
- Weather/music/spelling requests (those agents handle them directly)
- Greetings: "Hello" / "Good morning" (smalltalk agent)
- Any request that asks for an ACTION rather than information about capabilities

HALLUCINATION GUARD:
NEVER state facts that are not in your context window.
You do NOT know the current time, date, day of week, weather, calendar events, or any real-world data.
If someone asks a factual question (time, date, weather, schedule, news), do NOT guess.
Instead bid 0.00 so the correct agent handles it.
The ONLY facts you may state are those present in the conversation history or user profile provided in your context. Everything else is a guess and will damage user trust.`,
  
  // Memory instance
  memory: null,
  
  /**
   * Initialize memory
   */
  async initialize() {
    if (!this.memory) {
      this.memory = getAgentMemory('help-agent', { displayName: 'Help Agent' });
      await this.memory.load();
      this._ensureMemorySections();
    }
    return this.memory;
  },
  
  /**
   * Ensure required memory sections exist
   */
  _ensureMemorySections() {
    const sections = this.memory.getSectionNames();
    
    if (!sections.includes('Learned Preferences')) {
      this.memory.updateSection('Learned Preferences', `- Skill Level: Beginner
- Preferred Detail: Concise
- Last Topic: None`);
    }
    
    if (!sections.includes('Topics Asked')) {
      this.memory.updateSection('Topics Asked', `*Topics you've asked about will appear here*`);
    }
    
    if (this.memory.isDirty()) {
      this.memory.save();
    }
  },
  
  // No bid() method. Routing is 100% LLM-based via unified-bidder.js.
  // NEVER add keyword/regex bidding here. See .cursorrules.
  
  /**
   * Execute the task
   */
  async execute(task, context = {}) {
    // Initialize memory
    if (!this.memory) {
      await this.initialize();
    }
    
    const lower = task.content.toLowerCase();
    const prefs = this.memory.parseSectionAsKeyValue('Learned Preferences') || {};
    const skillLevel = prefs['Skill Level'] || 'Beginner';
    const isAdvanced = skillLevel.toLowerCase() === 'advanced';
    
    // Handle pending clarification
    if (task.context?.pendingState === 'awaiting_topic') {
      const topic = task.context?.userInput || task.content;
      return this._getHelpForTopic(topic, isAdvanced);
    }
    
    // Vague help request - ask what they need help with
    if (/^help[\s!.,?]*$/i.test(lower) || lower === 'help me') {
      return {
        success: true,
        needsInput: {
          prompt: "What would you like help with? I can help with time, weather, music, or just tell you what I can do.",
          agentId: this.id,
          context: { pendingState: 'awaiting_topic' }
        }
      };
    }
    
    // Specific topic help
    const result = this._getHelpForTopic(lower, isAdvanced);
    
    // Learn from interaction
    await learnFromInteraction(this.memory, task, result, {
      learnedPreferences: { 'Last Topic': this._extractTopic(lower) }
    });
    
    // Track topic in history
    const topic = this._extractTopic(lower);
    if (topic) {
      const timestamp = new Date().toISOString().split('T')[0];
      this.memory.appendToSection('Topics Asked', `- ${timestamp}: ${topic}`, 20);
      await this.memory.save();
    }
    
    return result;
  },
  
  /**
   * Extract topic from query
   */
  _extractTopic(lower) {
    if (lower.includes('time') || lower.includes('date')) return 'time';
    if (lower.includes('weather')) return 'weather';
    if (lower.includes('music') || lower.includes('play') || lower.includes('volume')) return 'music';
    if (lower.includes('undo') || lower.includes('cancel') || lower.includes('repeat')) return 'commands';
    return 'general';
  },
  
  /**
   * Get help for a specific topic
   */
  _getHelpForTopic(topic, isAdvanced) {
    const lower = topic.toLowerCase();
    
    // Time help
    if (lower.includes('time') || lower.includes('date')) {
      const basic = "Just ask 'what time is it' or 'what's the date' and I'll tell you.";
      const advanced = basic + " I remember your preferred format - you can change it in my memory file.";
      return { success: true, message: isAdvanced ? advanced : basic };
    }
    
    // Weather help
    if (lower.includes('weather')) {
      const basic = "Say 'what's the weather in' followed by a city name. I'll remember your home city.";
      const advanced = basic + " I support both Fahrenheit and Celsius - set your preference in my memory.";
      return { success: true, message: isAdvanced ? advanced : basic };
    }
    
    // Music help
    if (lower.includes('music') || lower.includes('play') || lower.includes('volume')) {
      const basic = "You can say 'play music', 'pause', 'skip', 'next', 'volume up', 'volume down'. I'll ask about your mood to pick good music.";
      const advanced = basic + " I learn your preferences over time and can route to specific AirPlay speakers.";
      return { success: true, message: isAdvanced ? advanced : basic };
    }
    
    // Commands help
    if (lower.includes('undo') || lower.includes('cancel') || lower.includes('repeat') || lower.includes('command')) {
      return { 
        success: true, 
        message: "Say 'cancel' to stop what I'm doing, 'repeat' to hear my last response again, or 'undo' within 60 seconds to reverse an action."
      };
    }
    
    // General help
    const capabilities = [
      "I can help you with several things.",
      "Ask me the time or date.",
      "Check the weather in any city.",
      "Control your music: play, pause, skip, or adjust volume.",
      "I learn your preferences over time - you can edit my memory in the GSX Agent space."
    ];
    
    return { success: true, message: capabilities.join(' ') };
  }
};

module.exports = helpAgent;
