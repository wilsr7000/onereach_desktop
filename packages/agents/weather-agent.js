/**
 * Weather Agent - A Thinking Agent
 * 
 * Provides weather information from OpenWeather API.
 * NEVER guesses a location - asks if missing but remembers your home location.
 * 
 * Thinking Agent features:
 * - Remembers home location and favorite cities
 * - Remembers preferred units (F/C)
 * - Reviews response if location wasn't found
 */

const { getAgentMemory } = require('../../lib/agent-memory-store');
const { 
  learnFromInteraction,
  reviewExecution 
} = require('../../lib/thinking-agent');

// Agent configuration
const THINKING_CONFIG = {
  agentName: 'Weather Agent',
  capabilities: ['Current weather', 'Temperature', 'Humidity', 'Weather conditions'],
  useMemory: true,
  maxRetries: 1 // Retry once if location not found
};

const weatherAgent = {
  id: 'weather-agent',
  name: 'Weather Agent',
  description: 'Provides weather - remembers your home location and preferred units',
  categories: ['system', 'weather'],
  keywords: ['weather', 'temperature', 'forecast', 'rain', 'sunny', 'cloudy', 'cold', 'hot', 'humid'],
  
  // Memory instance
  memory: null,
  
  /**
   * Initialize memory
   */
  async initialize() {
    if (!this.memory) {
      this.memory = getAgentMemory('weather-agent', { displayName: 'Weather Agent' });
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
      this.memory.updateSection('Learned Preferences', `- Home Location: *Not set - will ask*
- Units: Fahrenheit
- Include Humidity: When high (>70%)`);
    }
    
    if (!sections.includes('Favorite Locations')) {
      this.memory.updateSection('Favorite Locations', `*Add your frequently checked cities here*
- Home: (set your home city)
- Work: (set your work city)`);
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
    const weatherKeywords = ['weather', 'temperature', 'forecast', 'rain', 'sunny', 'cloudy', 'cold', 'hot', 'humid', 'degrees'];
    
    if (weatherKeywords.some(k => lower.includes(k))) {
      if (!this._getApiKey()) {
        console.warn('[WeatherAgent] No API key configured - not bidding');
        return null;
      }
      return { confidence: 0.9, reasoning: 'Weather query' };
    }
    
    return null;
  },
  
  /**
   * Get API key
   */
  _getApiKey() {
    if (global.settingsManager) {
      const key = global.settingsManager.get('openweatherApiKey');
      if (key) return key;
    }
    return process.env.OPENWEATHER_API_KEY;
  },
  
  /**
   * Execute the task with thinking pattern
   */
  async execute(task, context = {}) {
    try {
      // 1. Initialize memory
      if (!this.memory) {
        await this.initialize();
      }
      
      // 2. Handle pending location answer
      if (task.context?.pendingState === 'awaiting_location') {
        const location = task.context?.userInput || task.content;
        return this._fetchWeather(location, task);
      }
      
      // 3. Get preferences
      const prefs = this.memory.parseSectionAsKeyValue('Learned Preferences') || {};
      const homeLocation = prefs['Home Location'];
      const useCelsius = prefs['Units']?.toLowerCase().includes('celsius');
      
      // 4. Try to get location from task content
      let location = this.extractLocation(task.content);
      
      // 5. If no location in request, check for "home" or use home location
      if (!location) {
        const lower = task.content.toLowerCase();
        
        // Check for "at home", "here", etc.
        if (lower.includes('home') || lower.includes('here') || lower.includes('my area')) {
          if (homeLocation && homeLocation !== '*Not set - will ask*') {
            location = homeLocation;
          }
        }
        
        // For bare "weather" requests, use home if set
        if (!location && homeLocation && homeLocation !== '*Not set - will ask*') {
          location = homeLocation;
        }
      }
      
      // 6. If still no location, ask
      if (!location) {
        return {
          success: true,
          needsInput: {
            prompt: "What city would you like the weather for? I'll remember it as your home location.",
            field: 'location',
            agentId: this.id,
            context: {
              pendingState: 'awaiting_location',
              saveAsHome: true
            }
          }
        };
      }
      
      // 7. Fetch weather
      return this._fetchWeather(location, task, { useCelsius, saveAsHome: !homeLocation || homeLocation === '*Not set - will ask*' });
      
    } catch (error) {
      console.error('[WeatherAgent] Error:', error);
      return { 
        success: false, 
        message: "Weather service isn't available right now" 
      };
    }
  },
  
  /**
   * Fetch weather from API
   */
  async _fetchWeather(location, task, options = {}) {
    const apiKey = this._getApiKey();
    
    if (!apiKey) {
      return { 
        success: false, 
        message: "Weather service isn't configured. Please add an OpenWeather API key in settings." 
      };
    }
    
    const units = options.useCelsius ? 'metric' : 'imperial';
    const unitLabel = options.useCelsius ? 'C' : 'F';
    
    try {
      const response = await fetch(
        `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(location)}&appid=${apiKey}&units=${units}`
      );
      
      if (!response.ok) {
        if (response.status === 404) {
          // Review with AI to suggest corrections
          const review = await reviewExecution(
            task,
            { success: false, message: `Location "${location}" not found` },
            `Get weather for ${location}`,
            THINKING_CONFIG
          );
          
          return { 
            success: false, 
            message: review.message || `I couldn't find weather for "${location}". Is that spelled correctly?` 
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
      let message = `It's ${temp}°${unitLabel} and ${desc} in ${location}`;
      
      if (Math.abs(feelsLike - temp) >= 5) {
        message += `, feels like ${feelsLike}°${unitLabel}`;
      }
      
      if (humidity > 70) {
        message += `. Humidity is ${humidity}%`;
      }
      
      // Learn from interaction
      const learnedPrefs = {};
      if (options.saveAsHome) {
        learnedPrefs['Home Location'] = location;
      }
      
      await learnFromInteraction(this.memory, task, { success: true, message }, {
        learnedPreferences: Object.keys(learnedPrefs).length > 0 ? learnedPrefs : undefined
      });
      
      return { success: true, message };
      
    } catch (error) {
      console.error('[WeatherAgent] API Error:', error);
      return { 
        success: false, 
        message: "Weather service isn't available right now" 
      };
    }
  },
  
  /**
   * Extract location from the task content
   */
  extractLocation(text) {
    if (!text) return null;
    
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
        if (location && !['today', 'tomorrow', 'now', 'outside'].includes(location.toLowerCase())) {
          return location;
        }
      }
    }
    
    return null;
  },
  
  /**
   * Check if agent is available
   */
  isAvailable() {
    return !!this._getApiKey();
  }
};

module.exports = weatherAgent;
