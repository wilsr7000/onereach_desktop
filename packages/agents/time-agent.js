/**
 * Time Agent
 * 
 * Answers time and date questions from the system clock.
 * Grounded to actual system time - never hallucinates.
 */

const timeAgent = {
  id: 'time-agent',
  name: 'Time Agent',
  description: 'Answers time and date questions from the system clock',
  categories: ['system', 'time'],
  keywords: ['time', 'clock', 'hour', 'minute', 'date', 'day', 'month', 'year', 'today', 'what day'],
  
  /**
   * Bid on a task
   * @param {Object} task - { content, ... }
   * @returns {Object|null} - { confidence } or null to not bid
   */
  bid(task) {
    if (!task?.content) return null;
    
    const lower = task.content.toLowerCase();
    
    // Don't bid if this is a weather/forecast query (search-agent handles these)
    const weatherKeywords = ['weather', 'temperature', 'forecast', 'rain', 'snow', 'sunny', 'cloudy', 'humid', 'cold', 'hot', 'warm'];
    if (weatherKeywords.some(k => lower.includes(k))) {
      return null;  // Let search-agent handle weather
    }
    
    const timeKeywords = ['time', 'clock', 'hour', 'date', 'day', 'month', 'year', 'today', 'what day'];
    
    // Check for time/date keywords
    const hasKeyword = timeKeywords.some(k => lower.includes(k));
    
    // Also check for question patterns
    const isTimeQuestion = /what('s| is) the (time|date|day)/i.test(lower) ||
                          /what (time|date|day) is it/i.test(lower) ||
                          /tell me the (time|date)/i.test(lower);
    
    if (hasKeyword || isTimeQuestion) {
      return { confidence: 0.95 };  // High confidence - grounded source
    }
    
    return null;
  },
  
  /**
   * Execute the task
   * @param {Object} task - { content, context, ... }
   * @returns {Object} - { success, message }
   */
  async execute(task) {
    const now = new Date();
    const lower = task.content.toLowerCase();
    
    try {
      // Date questions
      if (lower.includes('date') || lower.includes('today') || 
          /what day is (it|today)/i.test(lower) || 
          lower.includes('what day')) {
        
        const formatted = now.toLocaleDateString('en-US', { 
          weekday: 'long', 
          month: 'long', 
          day: 'numeric', 
          year: 'numeric' 
        });
        
        return { 
          success: true, 
          message: `It's ${formatted}` 
        };
      }
      
      // Day of week
      if (lower.includes('day of the week') || lower.includes('what day of')) {
        const dayName = now.toLocaleDateString('en-US', { weekday: 'long' });
        return { 
          success: true, 
          message: `It's ${dayName}` 
        };
      }
      
      // Month
      if (lower.includes('month') && !lower.includes('date')) {
        const monthName = now.toLocaleDateString('en-US', { month: 'long' });
        return { 
          success: true, 
          message: `It's ${monthName}` 
        };
      }
      
      // Year
      if (lower.includes('year') && !lower.includes('date')) {
        return { 
          success: true, 
          message: `It's ${now.getFullYear()}` 
        };
      }
      
      // Default: time
      const time = now.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit', 
        hour12: true 
      });
      
      return { 
        success: true, 
        message: `It's ${time}` 
      };
      
    } catch (error) {
      console.error('[TimeAgent] Error:', error);
      return { 
        success: false, 
        message: "I couldn't get the time right now" 
      };
    }
  }
};

module.exports = timeAgent;
