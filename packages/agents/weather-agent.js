/**
 * Weather Agent - A Thinking Agent
 *
 * Provides weather information from wttr.in (no API key required).
 * Calendar-aware: checks today's events for meeting/travel locations
 * and includes relevant weather for those cities.
 *
 * NEVER guesses a location - asks if missing but remembers your home location.
 *
 * Thinking Agent features:
 * - Remembers home location and favorite cities
 * - Remembers preferred units (F/C)
 * - Reviews response if location wasn't found
 * - Checks calendar for events in other cities and surfaces travel weather
 */

const https = require('https');
const { getAgentMemory } = require('../../lib/agent-memory-store');
const { getUserProfile } = require('../../lib/user-profile-store');
const { learnFromInteraction, reviewExecution } = require('../../lib/thinking-agent');
const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

/**
 * Fetch JSON from a URL using Node's https module (more reliable than
 * undici/fetch in Electron for some external HTTPS servers).
 * @param {string} url
 * @param {number} [timeoutMs=8000]
 * @returns {Promise<{ok: boolean, status: number, data: any}>}
 */
function httpsGetJson(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'curl/8.0' } }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            data: JSON.parse(body),
          });
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
    });
    req.on('error', (e) => reject(e));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

/**
 * Fallback weather via Open-Meteo (free, no API key).
 * Geocodes the location name first, then fetches current weather.
 * @param {string} location - City name
 * @param {boolean} [useCelsius=false]
 * @returns {Promise<{temp: string, feelsLike: string, desc: string, humidity: number, displayName: string} | null>}
 */
async function fetchOpenMeteo(location, useCelsius = false) {
  try {
    // 1. Geocode
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
    const geo = await httpsGetJson(geoUrl, 5000);
    if (!geo.ok || !geo.data.results || geo.data.results.length === 0) return null;
    const { latitude, longitude, name: cityName } = geo.data.results[0];

    // 2. Current weather
    const unit = useCelsius ? 'celsius' : 'fahrenheit';
    const wxUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code&temperature_unit=${unit}`;
    const wx = await httpsGetJson(wxUrl, 5000);
    if (!wx.ok || !wx.data.current) return null;

    const c = wx.data.current;
    const wmoDesc = wmoCodeToDescription(c.weather_code);
    return {
      temp: String(Math.round(c.temperature_2m)),
      feelsLike: String(Math.round(c.apparent_temperature)),
      desc: wmoDesc,
      humidity: c.relative_humidity_2m,
      displayName: cityName || location,
    };
  } catch (_) {
    return null;
  }
}

/** Convert WMO weather code to a human-readable description */
function wmoCodeToDescription(code) {
  const map = {
    0: 'clear sky',
    1: 'mainly clear',
    2: 'partly cloudy',
    3: 'overcast',
    45: 'foggy',
    48: 'depositing rime fog',
    51: 'light drizzle',
    53: 'moderate drizzle',
    55: 'dense drizzle',
    61: 'slight rain',
    63: 'moderate rain',
    65: 'heavy rain',
    71: 'slight snow',
    73: 'moderate snow',
    75: 'heavy snow',
    77: 'snow grains',
    80: 'slight rain showers',
    81: 'moderate rain showers',
    82: 'violent rain showers',
    85: 'slight snow showers',
    86: 'heavy snow showers',
    95: 'thunderstorm',
    96: 'thunderstorm with slight hail',
    99: 'thunderstorm with heavy hail',
  };
  return map[code] || 'unknown conditions';
}

// Lazy-loaded calendar store for event-aware weather
let _calendarStore = null;
function getCalStore() {
  if (!_calendarStore) {
    try {
      const { getCalendarStore } = require('../../lib/calendar-store');
      _calendarStore = getCalendarStore();
    } catch (_) {
      // Calendar store not available -- calendar-aware weather disabled
    }
  }
  return _calendarStore;
}

// Agent configuration
const THINKING_CONFIG = {
  agentName: 'Weather Agent',
  capabilities: ['Current weather', 'Temperature', 'Humidity', 'Weather conditions', 'Calendar-aware travel weather'],
  useMemory: true,
  maxRetries: 1,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true if the location string is a video call link, not a physical place.
 */
function isVideoCallLink(location) {
  if (!location) return true;
  const lower = location.toLowerCase();
  return (
    lower.includes('http') ||
    lower.includes('zoom.') ||
    lower.includes('meet.google') ||
    lower.includes('teams.microsoft') ||
    lower.includes('webex')
  );
}

/**
 * Returns true if the location is too generic to produce meaningful weather.
 * Examples: "Office", "Room 3", "Conference Room", "TBD"
 */
function isGenericLocation(location) {
  if (!location || location.trim().length < 3) return true;
  const lower = location.trim().toLowerCase();
  const generic = [
    'office',
    'room',
    'conference',
    'meeting room',
    'tbd',
    'tba',
    'virtual',
    'online',
    'remote',
    'phone',
    'call',
    'home',
    'desk',
    'lobby',
    'reception',
    'building',
    'hq',
    'headquarters',
  ];
  // Exact match or starts-with (e.g. "Room 3", "Conference Room B")
  return generic.some((g) => lower === g || lower.startsWith(g + ' '));
}

/**
 * Strip trailing punctuation that speech-to-text often appends.
 * "Berkeley." → "Berkeley", "New York?" → "New York"
 */
function cleanLocation(loc) {
  if (!loc) return '';
  return loc
    .trim()
    .replace(/[.,!?;:]+$/, '')
    .trim();
}

/**
 * Returns true if a string looks like a city/place name rather than a room,
 * device, or generic label that another agent may have saved to the profile.
 * Rejects values like "Living room", "Office", "My desk", "Kitchen", etc.
 */
function _looksLikeCity(value) {
  if (!value || value.trim().length < 2) return false;
  const lower = value.trim().toLowerCase();

  // Reject common non-city values that other agents might save to the profile
  const notCities = [
    'living room',
    'bedroom',
    'kitchen',
    'bathroom',
    'garage',
    'basement',
    'office',
    'desk',
    'couch',
    'sofa',
    'bed',
    'room',
    'upstairs',
    'downstairs',
    'home',
    'house',
    'apartment',
    'condo',
    'work',
    'school',
    'here',
    'there',
    'inside',
    'outside',
    'unknown',
    'none',
    'n/a',
    'tbd',
  ];
  if (notCities.includes(lower)) return false;

  // Reject if it starts with a non-city prefix
  const badPrefixes = ['my ', 'the ', 'in ', 'at '];
  for (const prefix of badPrefixes) {
    if (lower.startsWith(prefix)) {
      const rest = lower.slice(prefix.length);
      if (notCities.includes(rest)) return false;
    }
  }

  return true;
}

// ── Agent Definition ────────────────────────────────────────────────────────

const weatherAgent = {
  id: 'weather-agent',
  name: 'Weather Agent',
  description:
    'Provides weather with calendar awareness - knows your location and checks if upcoming events need travel weather',
  voice: 'verse', // Natural, conversational - see VOICE-GUIDE.md
  acks: ['Let me check the forecast.', 'Checking the weather.'],
  categories: ['system', 'weather'],
  keywords: ['weather', 'temperature', 'forecast', 'rain', 'sunny', 'cloudy', 'cold', 'hot', 'humid'],
  executionType: 'action',
  estimatedExecutionMs: 3000,
  dataSources: ['wttr-in', 'calendar-store', 'user-profile'],

  /**
   * Briefing contribution: current weather + travel weather from calendar.
   * Priority 2 = appears after time/date in the daily brief.
   */
  async getBriefing() {
    try {
      const result = await this.execute({ content: 'current weather', metadata: {} });
      let content = result?.success ? result.message : null;

      // Check calendar for travel weather (separate from the main execute path
      // so the briefing always gets travel info even for bare requests)
      if (!content) {
        const travelWeather = await this._getCalendarWeather(null, {});
        if (travelWeather) {
          return { section: 'Weather', priority: 2, content: travelWeather };
        }
      }

      if (content) {
        return { section: 'Weather', priority: 2, content };
      }
    } catch (_e) {
      // Weather unavailable
    }
    return { section: 'Weather', priority: 2, content: "Weather data isn't available right now." };
  },

  prompt: `Weather Agent provides current weather conditions using live data from wttr.in.

HIGH CONFIDENCE (0.85+) for:
- "What's the weather?" / "How's the weather?" -- current conditions
- "Is it going to rain?" / "Will it rain today?" -- weather forecast
- "Temperature outside" / "How cold is it?" -- temperature check
- "What's the weather in NYC?" -- weather for a specific location
- Any question about weather conditions, temperature, rain, snow, wind, humidity, forecast
- "Do I need an umbrella?" / "Should I bring a jacket?" -- weather-based advice

This agent has LIVE weather data and is calendar-aware -- it checks your schedule
for meetings in other cities and includes that weather automatically.

LOW CONFIDENCE (0.00) -- do NOT bid on:
- General knowledge questions: "What causes rain?" (search agent)
- Calendar/schedule: "What's happening today?" (calendar agent)
- Time queries: "What time is it?" (time agent)`,

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
      this.memory.updateSection(
        'Learned Preferences',
        `- Home Location: *Not set - will ask*
- Units: Fahrenheit
- Include Humidity: When high (>70%)`
      );
    }

    if (!sections.includes('Favorite Locations')) {
      this.memory.updateSection(
        'Favorite Locations',
        `*Add your frequently checked cities here*
- Home: (set your home city)
- Work: (set your work city)`
      );
    }

    if (this.memory.isDirty()) {
      this.memory.save();
    }
  },

  // No bid() method. Routing is 100% LLM-based via unified-bidder.js.
  // NEVER add keyword/regex bidding here. See .cursorrules.

  /**
   * Execute the task with thinking pattern
   */
  async execute(task, _context) {
    try {
      // 1. Initialize memory
      if (!this.memory) {
        await this.initialize();
      }

      // 2. Handle pending location answer
      if (task.context?.pendingState === 'awaiting_location') {
        const location = cleanLocation(task.context?.userInput || task.content || '');
        if (!location) {
          return {
            success: true,
            needsInput: {
              prompt: "I didn't catch a city name. What city would you like the weather for?",
              field: 'location',
              agentId: this.id,
              context: { pendingState: 'awaiting_location', saveAsHome: true },
            },
          };
        }
        return this._fetchWeather(location, task, { saveAsHome: task.context?.saveAsHome });
      }

      // 3. Get preferences (check agent memory first, then global user profile)
      const prefs = this.memory.parseSectionAsKeyValue('Learned Preferences') || {};
      let homeLocation = prefs['Home Location'];
      const useCelsius = prefs['Units']?.toLowerCase().includes('celsius');

      // Fallback to global user profile for home location
      if (!homeLocation || homeLocation === '*Not set - will ask*') {
        try {
          const profile = getUserProfile();
          if (!profile.isLoaded()) await profile.load();
          const profileFacts = profile.getFacts('Locations');

          // Check Home City first (set by weather agent), then City, then Home.
          // Do NOT read 'Weather Location' -- that field may contain stale IP-geolocated data.
          const candidates = [profileFacts['Home City'], profileFacts['City'], profileFacts['Home']];

          for (const candidate of candidates) {
            if (candidate && !candidate.includes('not yet learned') && _looksLikeCity(candidate)) {
              homeLocation = candidate;
              break;
            }
          }
        } catch (_ignored) {
          /* profile/home city lookup optional */
        }
      }

      // 4. Try to get location from task content
      let location = cleanLocation(this.extractLocation(task.content));

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
              saveAsHome: true,
            },
          },
        };
      }

      // 7. Fetch weather for requested location
      const options = { useCelsius, saveAsHome: !homeLocation || homeLocation === '*Not set - will ask*' };
      const result = await this._fetchWeather(location, task, options);

      // 8. Append calendar travel weather for bare weather requests
      //    (skip if user asked for a specific city -- they know what they want)
      if (result.success && !this.extractLocation(task.content)) {
        const travelWeather = await this._getCalendarWeather(location, options);
        if (travelWeather) {
          result.message += '. ' + travelWeather;
        }
      }

      return result;
    } catch (error) {
      log.error('agent', 'Weather agent error', { error: error.message });
      return {
        success: false,
        message: "Weather service isn't available right now.",
      };
    }
  },

  // ── wttr.in API ─────────────────────────────────────────────────────────────

  /**
   * Fetch weather from wttr.in and build a human-readable message.
   * No API key required.
   */
  async _fetchWeather(location, task, options = {}) {
    // Clean and guard: strip trailing punctuation from STT, reject empty strings
    location = cleanLocation(location);
    if (!location) {
      return {
        success: false,
        message: 'I need a city name to check the weather.',
      };
    }

    const useCelsius = options.useCelsius || false;
    const unitLabel = useCelsius ? 'C' : 'F';

    try {
      const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1`;
      const { ok, status, data } = await httpsGetJson(url);

      if (!ok) {
        if (status === 404) {
          const review = await reviewExecution(
            task,
            { success: false, message: `Location "${location}" not found` },
            `Get weather for ${location}`,
            THINKING_CONFIG
          );
          return {
            success: false,
            message: review.message || `I couldn't find weather for "${location}". Is that spelled correctly?`,
          };
        }
        throw new Error(`wttr.in error: ${status}`);
      }

      const current = data.current_condition?.[0];
      if (!current) {
        throw new Error('No current_condition in wttr.in response');
      }

      const temp = useCelsius ? current.temp_C : current.temp_F;
      const feelsLike = useCelsius ? current.FeelsLikeC : current.FeelsLikeF;
      const desc = (current.weatherDesc?.[0]?.value || 'unknown conditions').toLowerCase();
      const humidity = parseInt(current.humidity, 10);
      const areaName = data.nearest_area?.[0]?.areaName?.[0]?.value || location;

      // Use the user's requested location name in the message (not wttr.in's nearest
      // weather station name, which can be a random suburb). Fall back to areaName
      // only if the user's query was very generic.
      const displayName = location || areaName;

      // Build response
      let message = `It's ${temp}°${unitLabel} and ${desc} in ${displayName}`;

      if (Math.abs(parseInt(feelsLike, 10) - parseInt(temp, 10)) >= 5) {
        message += `, feels like ${feelsLike}°${unitLabel}`;
      }

      if (humidity > 70) {
        message += `. Humidity is ${humidity}%`;
      }

      // Learn from interaction -- save the user's location name, not wttr.in's areaName
      const learnedPrefs = {};
      if (options.saveAsHome) {
        learnedPrefs['Home Location'] = displayName;
      }

      await learnFromInteraction(
        this.memory,
        task,
        { success: true, message },
        {
          learnedPreferences: Object.keys(learnedPrefs).length > 0 ? learnedPrefs : undefined,
        }
      );

      // Also save to global user profile (cross-agent memory)
      // Write to 'Home City' (weather-specific) rather than 'Home' which other agents
      // may overwrite with non-city values like "Living room".
      if (options.saveAsHome && displayName && _looksLikeCity(displayName)) {
        try {
          const profile = getUserProfile();
          if (!profile.isLoaded()) await profile.load();
          profile.updateFact('Home City', displayName);
          await profile.save();
        } catch (err) {
          console.warn('[weather-agent] save home city:', err.message);
        }
      }

      return { success: true, message };
    } catch (error) {
      log.info('agent', 'wttr.in failed, trying Open-Meteo fallback', {
        location,
        error: error.message,
      });

      // Fallback: Open-Meteo (free, no API key)
      try {
        const om = await fetchOpenMeteo(location, useCelsius);
        if (om) {
          let message = `It's ${om.temp}°${unitLabel} and ${om.desc} in ${om.displayName}`;
          if (Math.abs(parseInt(om.feelsLike, 10) - parseInt(om.temp, 10)) >= 5) {
            message += `, feels like ${om.feelsLike}°${unitLabel}`;
          }
          if (om.humidity > 70) {
            message += `. Humidity is ${om.humidity}%`;
          }

          if (options.saveAsHome && om.displayName && _looksLikeCity(om.displayName)) {
            try {
              const profile = getUserProfile();
              if (!profile.isLoaded()) await profile.load();
              profile.updateFact('Home City', om.displayName);
              await profile.save();
            } catch (err) {
              console.warn('[weather-agent] save home city (fallback):', err.message);
            }
          }

          return { success: true, message };
        }
      } catch (_fallbackErr) {
        // Both sources failed
      }

      log.error('agent', 'Weather fetch error (all sources)', {
        location,
        error: error.message,
        code: error.code || error.cause?.code || undefined,
      });
      return {
        success: false,
        message: "Weather service isn't available right now.",
      };
    }
  },

  /**
   * Lightweight weather-data-only fetch for a single location.
   * Returns a plain object (not a user message) or null on failure.
   * Used by _getCalendarWeather to fetch multiple cities in parallel.
   */
  async _fetchWeatherData(location, useCelsius = false) {
    // Clean and guard: strip trailing punctuation, reject empty
    location = cleanLocation(location);
    if (!location) return null;

    try {
      const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1`;
      const { ok, data } = await httpsGetJson(url, 5000);
      if (!ok) throw new Error('wttr.in not ok');

      const current = data.current_condition?.[0];
      if (!current) throw new Error('no current_condition');

      return {
        temp: useCelsius ? current.temp_C : current.temp_F,
        feelsLike: useCelsius ? current.FeelsLikeC : current.FeelsLikeF,
        desc: (current.weatherDesc?.[0]?.value || 'unknown').toLowerCase(),
        humidity: parseInt(current.humidity, 10),
        areaName: location, // Use the requested name, not wttr.in's nearest station
        unitLabel: useCelsius ? 'C' : 'F',
      };
    } catch (_) {
      // Fallback: Open-Meteo
      const om = await fetchOpenMeteo(location, useCelsius).catch((err) => {
        console.warn('[weather-agent] fetchOpenMeteo fallback:', err.message);
        return null;
      });
      if (om) {
        return {
          temp: om.temp,
          feelsLike: om.feelsLike,
          desc: om.desc,
          humidity: om.humidity,
          areaName: om.displayName || location,
          unitLabel: useCelsius ? 'C' : 'F',
        };
      }
      return null;
    }
  },

  // ── Calendar-Aware Weather ────────────────────────────────────────────────

  /**
   * Check today's calendar events for physical locations and return a
   * weather summary for cities that differ from the user's home location.
   *
   * Flow:
   *  1. Pull today's events from the calendar store
   *  2. Filter to events with real physical locations (skip Zoom/generic)
   *  3. Use AI (fast) to extract city names from address strings
   *  4. Deduplicate against home location
   *  5. Fetch weather for up to 3 unique cities in parallel
   *  6. Compose a sentence like:
   *     "For your 2pm Design Review in San Francisco, expect 58°F and fog"
   *
   * @param {string|null} homeLocation - User's home city to skip
   * @param {Object} options - { useCelsius }
   * @returns {string|null} Travel weather sentence(s), or null
   */
  async _getCalendarWeather(homeLocation, options = {}) {
    try {
      const store = getCalStore();
      if (!store) return null;

      const events = store.getEventsToday();
      if (!events || events.length === 0) return null;

      // Collect events with real physical locations
      const eventLocations = [];
      for (const event of events) {
        if (!event.location) continue;
        if (isVideoCallLink(event.location)) continue;
        if (isGenericLocation(event.location)) continue;
        eventLocations.push({
          location: event.location,
          title: event.title || 'event',
          startTime: event.startTime,
        });
      }
      if (eventLocations.length === 0) return null;

      // Ask AI to extract city names from the raw location strings
      const uniqueLocationStrings = [...new Set(eventLocations.map((e) => e.location))];
      let cityMap = {};

      try {
        cityMap = await ai.json(
          `Extract the city name (or nearest well-known city) from each location string below.
Return a JSON object mapping each original string to its city name.
If you cannot determine a city, map it to null.

Locations:
${uniqueLocationStrings.map((l, i) => `${i + 1}. "${l}"`).join('\n')}`,
          { profile: 'fast' }
        );
      } catch (_) {
        // AI unavailable -- use location strings as-is (wttr.in is decent at parsing)
        for (const loc of uniqueLocationStrings) {
          cityMap[loc] = loc;
        }
      }

      // Deduplicate cities and skip the user's home city
      const homeLower = (homeLocation || '').toLowerCase().trim();
      const seenCities = new Set();
      const citiesToFetch = [];

      for (const city of Object.values(cityMap)) {
        if (!city) continue;
        const key = city.toLowerCase().trim();
        if (key === homeLower) continue;
        if (seenCities.has(key)) continue;
        seenCities.add(key);
        citiesToFetch.push(city);
      }

      if (citiesToFetch.length === 0) return null;

      // Fetch weather for up to 3 cities in parallel
      const useCelsius = options.useCelsius || false;
      const weatherResults = await Promise.all(
        citiesToFetch.slice(0, 3).map((city) => this._fetchWeatherData(city, useCelsius))
      );

      // Build human-readable summaries
      const summaries = [];
      for (let i = 0; i < citiesToFetch.length && i < 3; i++) {
        const city = citiesToFetch[i];
        const weather = weatherResults[i];
        if (!weather) continue;

        // Find the first event in this city for context
        const matchingEvent = eventLocations.find((e) => {
          const mapped = cityMap[e.location];
          return mapped && mapped.toLowerCase().trim() === city.toLowerCase().trim();
        });

        let timeStr = '';
        if (matchingEvent?.startTime) {
          const d = new Date(matchingEvent.startTime);
          timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        }

        const eventTitle = matchingEvent?.title || '';

        let summary = 'For your';
        if (timeStr) summary += ` ${timeStr}`;
        if (eventTitle) summary += ` ${eventTitle}`;
        summary += ` in ${weather.areaName}, expect ${weather.temp}°${weather.unitLabel} and ${weather.desc}`;

        summaries.push(summary);
      }

      return summaries.length > 0 ? summaries.join('. ') : null;
    } catch (error) {
      log.warn('agent', 'Calendar weather check failed', { error: error.message });
      return null;
    }
  },

  // ── Utilities ─────────────────────────────────────────────────────────────

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
   * Always available -- wttr.in requires no API key
   */
  isAvailable() {
    return true;
  },
};

module.exports = weatherAgent;
