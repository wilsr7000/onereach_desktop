/**
 * Weather Agent
 * 
 * Provides weather information from OpenWeather API.
 * NEVER guesses a location - always asks if missing.
 */

const weatherAgent = {
  id: 'weather-agent',
  name: 'Weather Agent',
  description: 'Provides weather from OpenWeather API',
  categories: ['system', 'weather'],
  keywords: ['weather', 'temperature', 'forecast', 'rain', 'sunny', 'cloudy', 'cold', 'hot', 'humid'],
  
  /**
   * Bid on a task
   * @param {Object} task - { content, ... }
   * @returns {Object|null} - { confidence } or null to not bid
   */
  bid(task) {
    if (!task?.content) return null;
    
    const lower = task.content.toLowerCase();
    const weatherKeywords = ['weather', 'temperature', 'forecast', 'rain', 'sunny', 'cloudy', 'cold', 'hot', 'humid', 'degrees'];
    
    if (weatherKeywords.some(k => lower.includes(k))) {
      // Only bid if API key is configured
      if (!process.env.OPENWEATHER_API_KEY) {
        console.warn('[WeatherAgent] No API key configured - not bidding');
        return null;
      }
      return { confidence: 0.9 };
    }
    
    return null;
  },
  
  /**
   * Execute the task
   * @param {Object} task - { content, context, ... }
   * @returns {Object} - { success, message, needsInput? }
   */
  async execute(task, context = {}) {
    const apiKey = process.env.OPENWEATHER_API_KEY;
    
    if (!apiKey) {
      return { 
        success: false, 
        message: "Weather service isn't configured" 
      };
    }
    
    // Try to get location from: 1) task content, 2) context answer, 3) configured default
    const location = this.extractLocation(task.content) 
      || context?.location  // Filled in from pendingQuestion answer
      || context?.defaultLocation;  // Only if explicitly configured by user
    
    // NEVER guess a location - always ask if missing
    if (!location) {
      return {
        success: false,
        needsInput: {
          prompt: "What city would you like the weather for?",
          field: 'location',
          agentId: 'weather-agent',
          taskId: task.id
        }
      };
    }
    
    try {
      const response = await fetch(
        `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(location)}&appid=${apiKey}&units=imperial`
      );
      
      if (!response.ok) {
        if (response.status === 404) {
          return { 
            success: false, 
            message: `I couldn't find weather for "${location}". Is that spelled correctly?` 
          };
        }
        throw new Error(`API error: ${response.status}`);
      }
      
      const data = await response.json();
      
      const temp = Math.round(data.main.temp);
      const feelsLike = Math.round(data.main.feels_like);
      const desc = data.weather[0].description;
      const humidity = data.main.humidity;
      
      // Build response
      let message = `It's ${temp} degrees and ${desc} in ${location}`;
      
      // Add feels like if significantly different
      if (Math.abs(feelsLike - temp) >= 5) {
        message += `, feels like ${feelsLike}`;
      }
      
      // Add humidity if high
      if (humidity > 70) {
        message += `. Humidity is ${humidity}%`;
      }
      
      return { 
        success: true, 
        message 
      };
      
    } catch (error) {
      console.error('[WeatherAgent] Error:', error);
      return { 
        success: false, 
        message: "Weather service isn't available right now" 
      };
    }
  },
  
  /**
   * Extract location from the task content
   * @param {string} text
   * @returns {string|null}
   */
  extractLocation(text) {
    if (!text) return null;
    
    // Common patterns for location extraction
    const patterns = [
      /weather\s+(?:in|for|at)\s+(.+?)(?:\?|$)/i,
      /temperature\s+(?:in|for|at)\s+(.+?)(?:\?|$)/i,
      /(?:how's|what's|how is|what is)\s+(?:the\s+)?weather\s+(?:in|for|at|like in)\s+(.+?)(?:\?|$)/i,
      /(?:is it|will it)\s+(?:raining|sunny|cold|hot)\s+(?:in|at)\s+(.+?)(?:\?|$)/i,
    ];
    
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        const location = match[1].trim();
        // Filter out common non-locations
        if (location && !['today', 'tomorrow', 'now', 'outside'].includes(location.toLowerCase())) {
          return location;
        }
      }
    }
    
    return null;
  },
  
  /**
   * Check if agent is available (has API key)
   * @returns {boolean}
   */
  isAvailable() {
    return !!process.env.OPENWEATHER_API_KEY;
  }
};

module.exports = weatherAgent;
