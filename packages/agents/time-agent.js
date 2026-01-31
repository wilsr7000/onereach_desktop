/**
 * Time Agent - A Thinking Agent
 * 
 * Answers time and date questions from the system clock.
 * Grounded to actual system time - never hallucinates.
 * 
 * Thinking Agent features:
 * - Remembers preferred timezone and format
 * - Asks clarification for timezone if multiple saved
 * - Reviews response format
 */

const { getAgentMemory } = require('../../lib/agent-memory-store');
const { 
  checkPreferencesAndClarify, 
  reviewExecution, 
  learnFromInteraction,
  getTimeContext 
} = require('../../lib/thinking-agent');

// Agent configuration for thinking behavior
const THINKING_CONFIG = {
  agentName: 'Time Agent',
  capabilities: ['Tell current time', 'Tell current date', 'Tell day of week'],
  useMemory: true,
  useAIClarification: false, // Time is simple, no AI clarification needed
  clarificationRules: [
    {
      keywords: ['time in', 'what time is it in', 'time at'],
      preferenceKey: 'preferredTimezone',
      question: 'Which timezone would you like? Your saved timezones are: {options}',
      extractPattern: /time (?:in|at) (.+)/i
    }
  ],
  maxRetries: 0, // Time doesn't need retries
  errorMessage: "I couldn't get the time right now."
};

const timeAgent = {
  id: 'time-agent',
  name: 'Time Agent',
  description: 'Answers time and date questions - remembers your preferred format',
  categories: ['system', 'time'],
  keywords: ['time', 'clock', 'hour', 'minute', 'date', 'day', 'month', 'year', 'today', 'what day'],
  
  // Memory instance
  memory: null,
  
  /**
   * Initialize memory
   */
  async initialize() {
    if (!this.memory) {
      this.memory = getAgentMemory('time-agent', { displayName: 'Time Agent' });
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
      this.memory.updateSection('Learned Preferences', `- Time Format: 12-hour
- Date Format: US (Month Day, Year)
- Primary Timezone: Local`);
    }
    
    if (!sections.includes('Saved Timezones')) {
      this.memory.updateSection('Saved Timezones', `*Add your frequently used timezones here*
- Local: System default`);
    }
    
    if (this.memory.isDirty()) {
      this.memory.save();
    }
  },
  
  /**
   * Bid on a task
   */
  bid(task) {
    if (!task?.content) return null;
    
    const lower = task.content.toLowerCase();
    
    // Don't bid on weather queries
    const weatherKeywords = ['weather', 'temperature', 'forecast', 'rain', 'snow', 'sunny', 'cloudy', 'humid', 'cold', 'hot', 'warm'];
    if (weatherKeywords.some(k => lower.includes(k))) {
      return null;
    }
    
    const timeKeywords = ['time', 'clock', 'hour', 'date', 'day', 'month', 'year', 'today', 'what day'];
    const hasKeyword = timeKeywords.some(k => lower.includes(k));
    
    const isTimeQuestion = /what('s| is) the (time|date|day)/i.test(lower) ||
                          /what (time|date|day) is it/i.test(lower) ||
                          /tell me the (time|date)/i.test(lower);
    
    if (hasKeyword || isTimeQuestion) {
      return { confidence: 0.95, reasoning: 'Time/date question' };
    }
    
    return null;
  },
  
  /**
   * Execute the task with thinking pattern
   */
  async execute(task) {
    try {
      // 1. Initialize memory
      if (!this.memory) {
        await this.initialize();
      }
      
      // 2. Handle pending conversation state
      if (task.context?.pendingState === 'awaiting_timezone') {
        return this._handleTimezoneResponse(task);
      }
      
      // 3. Check for clarification needs
      const clarification = await checkPreferencesAndClarify(
        this.id,
        task,
        this.memory,
        THINKING_CONFIG
      );
      
      if (clarification.needsClarification) {
        return {
          success: true,
          needsInput: {
            prompt: clarification.question,
            agentId: this.id,
            context: {
              pendingState: 'awaiting_timezone',
              originalTask: task.content
            }
          }
        };
      }
      
      // 4. Get preferences
      const prefs = this.memory.parseSectionAsKeyValue('Learned Preferences') || {};
      const use24Hour = prefs['Time Format']?.includes('24');
      const useDateFormatEU = prefs['Date Format']?.toLowerCase().includes('eu');
      
      // 5. Execute the actual task
      const result = await this._doTask(task, { use24Hour, useDateFormatEU });
      
      // 6. Learn from interaction (record in history)
      await learnFromInteraction(this.memory, task, result, {
        useAILearning: false // Time is simple, no AI learning needed
      });
      
      return result;
      
    } catch (error) {
      console.error('[TimeAgent] Error:', error);
      return { 
        success: false, 
        message: THINKING_CONFIG.errorMessage 
      };
    }
  },
  
  /**
   * Handle timezone selection response
   */
  async _handleTimezoneResponse(task) {
    const input = task.context?.userInput || task.content;
    // For now, just return time (timezone handling can be expanded)
    return this._doTask({ content: task.context?.originalTask || 'time' }, {});
  },
  
  /**
   * Perform the actual time/date task
   */
  async _doTask(task, context) {
    const now = new Date();
    const lower = task.content.toLowerCase();
    const { use24Hour, useDateFormatEU } = context;
    
    // Date questions
    if (lower.includes('date') || lower.includes('today') || 
        /what day is (it|today)/i.test(lower) || 
        lower.includes('what day')) {
      
      const options = useDateFormatEU 
        ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }
        : { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' };
      
      const formatted = now.toLocaleDateString('en-US', options);
      return { success: true, message: `It's ${formatted}` };
    }
    
    // Day of week
    if (lower.includes('day of the week') || lower.includes('what day of')) {
      const dayName = now.toLocaleDateString('en-US', { weekday: 'long' });
      return { success: true, message: `It's ${dayName}` };
    }
    
    // Month
    if (lower.includes('month') && !lower.includes('date')) {
      const monthName = now.toLocaleDateString('en-US', { month: 'long' });
      return { success: true, message: `It's ${monthName}` };
    }
    
    // Year
    if (lower.includes('year') && !lower.includes('date')) {
      return { success: true, message: `It's ${now.getFullYear()}` };
    }
    
    // Default: time
    const timeOptions = use24Hour
      ? { hour: '2-digit', minute: '2-digit', hour12: false }
      : { hour: 'numeric', minute: '2-digit', hour12: true };
    
    const time = now.toLocaleTimeString('en-US', timeOptions);
    return { success: true, message: `It's ${time}` };
  }
};

module.exports = timeAgent;
