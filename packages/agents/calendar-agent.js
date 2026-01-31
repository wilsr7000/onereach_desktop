/**
 * Calendar Agent - A Fully Agentic Thinking Agent
 * 
 * Answers calendar and meeting questions by fetching from the omnical API.
 * 
 * Fully Agentic Features:
 * - AI reasoning to understand ambiguous queries
 * - Multi-turn clarification conversations
 * - Proactive meeting reminders (polls every 5 min, notifies before meetings)
 * - Learns patterns and preferences stored in Spaces markdown
 * - Time-of-day aware responses
 */

const { getAgentMemory } = require('../../lib/agent-memory-store');
const { 
  learnFromInteraction,
  getTimeContext,
  callOpenAI,
  checkPreferencesAndClarify
} = require('../../lib/thinking-agent');
const { getCircuit } = require('./circuit-breaker');

// Omnical API endpoint
const OMNICAL_API_URL = 'https://em.edison.api.onereach.ai/http/35254342-4a2e-475b-aec1-18547e517e29/omnical';

// Circuit breaker for AI calls
const calendarCircuit = getCircuit('calendar-agent-ai', {
  failureThreshold: 3,
  resetTimeout: 30000,
  windowMs: 60000
});

// Agent configuration
const THINKING_CONFIG = {
  agentName: 'Calendar Agent',
  capabilities: [
    'Check calendar for today/tomorrow/this week',
    'Find next meeting',
    'Check availability at specific times',
    'List meetings by time period',
    'Proactive meeting reminders'
  ],
  useMemory: true,
  useAIClarification: true,
  maxRetries: 1,
  errorMessage: "I couldn't access your calendar right now.",
  
  // Clarification rules for when AI is unavailable
  clarificationRules: [
    {
      keywords: ['calendar', 'schedule', 'meetings'],
      preferenceKey: 'defaultTimeframe',
      question: 'For today, tomorrow, or this week?',
      options: ['today', 'tomorrow', 'this week']
    },
    {
      keywords: ['free', 'available', 'busy'],
      preferenceKey: 'checkTime',
      question: 'What time are you checking for?',
      extractPattern: /at (\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i
    }
  ]
};

// Cache configuration
const CACHE_TTL_MS = 60000; // 1 minute cache

// Poller configuration
const POLLER_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_REMINDER_MINUTES = 15;

/**
 * Get OpenAI API key
 */
function getOpenAIApiKey() {
  if (global.settingsManager) {
    const openaiKey = global.settingsManager.get('openaiApiKey');
    if (openaiKey) return openaiKey;
    const provider = global.settingsManager.get('llmProvider');
    const llmKey = global.settingsManager.get('llmApiKey');
    if (provider === 'openai' && llmKey) return llmKey;
  }
  return process.env.OPENAI_API_KEY;
}

/**
 * AI-driven calendar query understanding
 * Takes a raw user request and uses LLM to understand what they want
 * 
 * @param {string} userRequest - Raw user request text
 * @param {Object} context - { partOfDay, memory, events, conversationHistory }
 * @returns {Promise<Object>} - { action, timeframe, specificTime, needsClarification, clarificationPrompt, message }
 */
async function aiUnderstandCalendarRequest(userRequest, context) {
  const apiKey = getOpenAIApiKey();
  
  if (!apiKey) {
    console.log('[CalendarAgent] No API key, falling back to pattern matching');
    return null;
  }
  
  const { partOfDay, memory, events, conversationHistory } = context;
  
  // Build events summary for context
  let eventsContext = 'No calendar data available';
  if (events && events.length > 0) {
    const now = new Date();
    const todayEvents = events.filter(e => {
      const start = new Date(e.start?.dateTime || e.start?.date);
      return start.toDateString() === now.toDateString();
    });
    const upcomingCount = events.filter(e => new Date(e.start?.dateTime || e.start?.date) > now).length;
    
    eventsContext = `Today: ${todayEvents.length} events. Total upcoming: ${upcomingCount} events.`;
    if (todayEvents.length > 0) {
      const nextToday = todayEvents[0];
      eventsContext += ` Next today: "${nextToday.summary}" at ${new Date(nextToday.start?.dateTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
    }
  }

  const systemPrompt = `You are an AI assistant helping understand calendar queries. Interpret what the user wants to know.

CURRENT CONTEXT:
- Time of day: ${partOfDay}
- Current time: ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
- Calendar status: ${eventsContext}
${conversationHistory ? `- Recent conversation:\n${conversationHistory}` : ''}

USER PREFERENCES (from memory):
${memory || 'No preferences learned yet.'}

CRITICAL RULES - WHEN TO NOT ASK FOR CLARIFICATION:
- If the user mentions ANY day (Monday, Tuesday, today, tomorrow, etc.) - just show events for that day
- If the user asks "what's happening" or "what's going on" with ANY time reference - show events
- If the user mentions "this week" or "next week" - show week view
- "What's going on Monday?" means "Show me Monday's events" - NO clarification needed

ONLY ask for clarification when:
- No time/day reference at all AND the request is truly ambiguous (e.g., just "check calendar")
- Availability check with no time specified (e.g., "am I free" with no time)

Respond with JSON:
{
  "understood": true/false,
  "action": "today" | "tomorrow" | "week" | "next_meeting" | "availability" | "time_period" | "specific_day" | "clarify",
  "timeframe": "today" | "tomorrow" | "this_week" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday" | null,
  "timePeriod": "morning" | "afternoon" | "evening" | null,
  "specificTime": "3pm" | null,
  "needsClarification": true/false,
  "clarificationPrompt": "Question to ask if clarification needed",
  "reasoning": "Brief explanation of understanding"
}

EXAMPLES - NO CLARIFICATION NEEDED:
- "what's going on Monday?" → action: "specific_day", timeframe: "monday", needsClarification: false
- "what's happening Tuesday?" → action: "specific_day", timeframe: "tuesday", needsClarification: false
- "anything on Friday?" → action: "specific_day", timeframe: "friday", needsClarification: false
- "what meetings do I have today" → action: "today", needsClarification: false
- "when is my next meeting" → action: "next_meeting", needsClarification: false
- "am I free at 3pm" → action: "availability", specificTime: "3pm", needsClarification: false
- "this morning" → action: "time_period", timePeriod: "morning", needsClarification: false
- "what's this week look like" → action: "week", timeframe: "this_week", needsClarification: false

EXAMPLES - CLARIFICATION NEEDED:
- "check my calendar" (no time at all) → needsClarification: true
- "am I free" (no time specified) → needsClarification: true`;

  const userPrompt = `User request: "${userRequest}"

What calendar information does the user want?`;

  try {
    const result = await calendarCircuit.execute(async () => {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.3,
          max_tokens: 300,
          response_format: { type: 'json_object' }
        })
      });
      
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }
      
      return response.json();
    });
    
    const content = result.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('No content in AI response');
    }
    
    const parsed = JSON.parse(content);
    console.log('[CalendarAgent] AI understood request:', parsed.reasoning);
    
    // Track cost
    if (global.budgetManager) {
      global.budgetManager.trackUsage({
        model: 'gpt-4o-mini',
        inputTokens: result.usage?.prompt_tokens || 0,
        outputTokens: result.usage?.completion_tokens || 0,
        feature: 'calendar-agent-understanding'
      });
    }
    
    return parsed;
    
  } catch (error) {
    console.warn('[CalendarAgent] AI understanding failed:', error.message);
    return null;
  }
}

const calendarAgent = {
  id: 'calendar-agent',
  name: 'Calendar Agent',
  description: 'Answers calendar and meeting questions - shows your schedule and availability with proactive reminders',
  categories: ['system', 'calendar'],
  keywords: [
    'calendar', 'meeting', 'meetings', 'schedule', 'event', 'events', 
    'appointment', 'busy', 'free', 'available', 'availability',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'today', 'tomorrow', 'happening', 'going on', 'scheduled', 'planned'
  ],
  
  // Prompt for LLM evaluation
  prompt: `Calendar Agent handles ALL calendar, meeting, and scheduling requests.

HIGH CONFIDENCE (0.85+) for:
- Calendar queries: "what's on my calendar", "check my schedule"
- Meeting queries: "when is my next meeting", "do I have meetings today"
- Availability: "am I free", "am I busy", "available at 3pm"
- Time periods: "this morning", "this afternoon", "tomorrow", "this week"
- Day-specific: "what's happening Monday", "anything on Tuesday", "what do I have Friday"
- Generic schedule: "what's happening", "what's going on", "anything scheduled", "what do I have"

CRITICAL PATTERNS THIS AGENT HANDLES:
- "What's happening [day name]?" - e.g., "What's happening Monday?"
- "What's going on [time]?" - e.g., "What's going on tomorrow?"
- "Anything on [day]?" - e.g., "Anything on Friday?"
- Questions about any specific day of the week (Monday through Sunday)
- Questions about today, tomorrow, this week, this morning, this afternoon

If the user asks about what's happening on ANY day or time period, this is a calendar query. Day names like Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday are strong calendar signals.`,
  
  // Memory instance
  memory: null,
  
  // Cache for calendar events
  _cache: {
    events: null,
    fetchedAt: 0,
  },
  
  // Poller state
  _pollerInterval: null,
  _scheduledReminders: new Map(), // eventId -> notificationId
  
  /**
   * Initialize memory and start proactive features
   */
  async initialize() {
    if (!this.memory) {
      this.memory = getAgentMemory('calendar-agent', { displayName: 'Calendar Agent' });
      await this.memory.load();
      this._ensureMemorySections();
    }
    
    // Start meeting poller for proactive reminders
    this._startMeetingPoller();
    
    return this.memory;
  },
  
  /**
   * Ensure required memory sections exist with full structure
   */
  _ensureMemorySections() {
    const sections = this.memory.getSectionNames();
    
    // Notification Preferences
    if (!sections.includes('Notification Preferences')) {
      this.memory.updateSection('Notification Preferences', `- Reminder Time: 15 minutes before
- Morning Briefing: Disabled
- Quiet Hours: 10 PM - 7 AM`);
    }
    
    // Display Preferences
    if (!sections.includes('Display Preferences')) {
      this.memory.updateSection('Display Preferences', `- Time Format: 12-hour
- Show Attendees: Only when asked
- Show Location: Always
- Meeting Detail Level: Summary`);
    }
    
    // Learned Patterns
    if (!sections.includes('Learned Patterns')) {
      this.memory.updateSection('Learned Patterns', `*Will be populated as you use the calendar agent*`);
    }
    
    // Recent Queries (for learning)
    if (!sections.includes('Recent Queries')) {
      this.memory.updateSection('Recent Queries', `*No queries yet*`);
    }
    
    if (this.memory.isDirty()) {
      this.memory.save();
    }
  },
  
  /**
   * Get preferences from memory
   */
  _getPreferences() {
    const defaults = {
      reminderTime: 15,
      timeFormat: '12-hour',
      showAttendees: false,
      showLocation: true,
      defaultTimeframe: null
    };
    
    if (!this.memory || !this.memory.isLoaded()) {
      return defaults;
    }
    
    const notifPrefs = this.memory.parseSectionAsKeyValue('Notification Preferences') || {};
    const displayPrefs = this.memory.parseSectionAsKeyValue('Display Preferences') || {};
    const patterns = this.memory.parseSectionAsKeyValue('Learned Patterns') || {};
    
    // Parse reminder time
    const reminderMatch = notifPrefs['Reminder Time']?.match(/(\d+)/);
    if (reminderMatch) {
      defaults.reminderTime = parseInt(reminderMatch[1]);
    }
    
    defaults.timeFormat = displayPrefs['Time Format'] || '12-hour';
    defaults.showAttendees = displayPrefs['Show Attendees']?.toLowerCase() === 'always';
    defaults.showLocation = displayPrefs['Show Location']?.toLowerCase() !== 'never';
    defaults.defaultTimeframe = patterns['Default Timeframe'] || null;
    
    return defaults;
  },
  
  // ==================== PROACTIVE MEETING REMINDERS ====================
  
  /**
   * Start the meeting poller for proactive reminders
   */
  _startMeetingPoller() {
    if (this._pollerInterval) {
      return; // Already running
    }
    
    console.log('[CalendarAgent] Starting meeting poller (every 5 minutes)');
    
    // Check immediately
    this._checkUpcomingMeetings();
    
    // Then check every 5 minutes
    this._pollerInterval = setInterval(() => {
      this._checkUpcomingMeetings();
    }, POLLER_INTERVAL_MS);
  },
  
  /**
   * Stop the meeting poller
   */
  _stopMeetingPoller() {
    if (this._pollerInterval) {
      clearInterval(this._pollerInterval);
      this._pollerInterval = null;
      console.log('[CalendarAgent] Meeting poller stopped');
    }
  },
  
  /**
   * Check for upcoming meetings and schedule reminders
   */
  async _checkUpcomingMeetings() {
    try {
      const events = await this._fetchEvents();
      if (!events || events.length === 0) return;
      
      const now = new Date();
      const prefs = this._getPreferences();
      const reminderMs = prefs.reminderTime * 60 * 1000;
      
      // Look for meetings in the next hour
      const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);
      
      const upcomingMeetings = events.filter(e => {
        const start = new Date(e.start?.dateTime || e.start?.date);
        return start > now && start <= oneHourFromNow;
      });
      
      // Get notification manager
      let notificationManager;
      try {
        notificationManager = require('../../src/voice-task-sdk/notifications/notificationManager');
      } catch (e) {
        console.warn('[CalendarAgent] Notification manager not available');
        return;
      }
      
      for (const meeting of upcomingMeetings) {
        const eventId = meeting.id;
        const start = new Date(meeting.start?.dateTime || meeting.start?.date);
        const timeUntilStart = start - now;
        
        // Skip if we already scheduled a reminder for this event
        if (this._scheduledReminders.has(eventId)) {
          continue;
        }
        
        // Calculate when to send reminder
        const reminderTime = timeUntilStart - reminderMs;
        
        // If reminder time is in the past or within 30 seconds, skip
        if (reminderTime < 30000) {
          continue;
        }
        
        // Schedule the reminder
        const notificationId = `calendar-${eventId}`;
        const formattedTime = start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        const message = `Your meeting "${meeting.summary}" starts at ${formattedTime}`;
        
        console.log(`[CalendarAgent] Scheduling reminder for "${meeting.summary}" in ${Math.round(reminderTime / 60000)} minutes`);
        
        notificationManager.schedule(notificationId, message, {
          delay: reminderTime,
          priority: 3, // HIGH priority
          onDelivered: () => {
            console.log(`[CalendarAgent] Reminder delivered for "${meeting.summary}"`);
          }
        });
        
        this._scheduledReminders.set(eventId, notificationId);
      }
      
    } catch (error) {
      console.error('[CalendarAgent] Error checking upcoming meetings:', error);
    }
  },
  
  // ==================== BIDDING ====================
  
  /**
   * Bid on a task
   */
  bid(task) {
    if (!task?.content) return null;

    const lower = task.content.toLowerCase();

    // Don't bid on time-only queries (let time-agent handle those)
    if (/^what('s| is) the time/i.test(lower) || /^what time is it/i.test(lower)) {
      return null;
    }

    // Calendar-specific keywords
    const calendarKeywords = [
      'calendar', 'meeting', 'meetings', 'schedule', 'event', 'events',
      'appointment', 'appointments', 'busy', 'free', 'available', 'availability'
    ];
    
    // Day names - if someone asks about a specific day, likely calendar related
    const dayNames = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    
    // Time period keywords
    const timePeriodKeywords = ['today', 'tomorrow', 'this week', 'next week', 'this morning', 'this afternoon'];

    // Calendar question patterns
    const calendarPatterns = [
      /what('s| is) on my (calendar|schedule)/i,
      /when('s| is) my next (meeting|appointment|event)/i,
      /do i have (any )?(meetings|events|appointments)/i,
      /am i (free|busy|available)/i,
      /what (meetings|events|appointments) do i have/i,
      /check my (calendar|schedule)/i,
      /my (calendar|schedule|meetings)/i,
      /what('s| is|'s) happening/i,  // "what's happening Monday"
      /what('s| is) going on/i,       // "what's going on tomorrow"
      /anything (on|happening|scheduled|planned)/i,  // "anything on Monday"
      /what do i have/i,              // "what do I have Monday"
    ];

    const hasKeyword = calendarKeywords.some(k => lower.includes(k));
    const matchesPattern = calendarPatterns.some(p => p.test(lower));
    const hasDayName = dayNames.some(d => lower.includes(d));
    const hasTimePeriod = timePeriodKeywords.some(t => lower.includes(t));
    
    // High confidence if calendar keyword or matches explicit pattern
    if (hasKeyword || matchesPattern) {
      return { confidence: 0.92, reasoning: 'Calendar/meeting query' };
    }
    
    // Medium-high confidence if asking about a specific day with context
    if (hasDayName && (matchesPattern || /what|any|do i/i.test(lower))) {
      return { confidence: 0.88, reasoning: 'Day-specific schedule query' };
    }
    
    // Medium confidence if just a day name with a question word
    if (hasDayName && /^(what|how|any)/i.test(lower)) {
      return { confidence: 0.85, reasoning: 'Day name with question' };
    }
    
    // Time period with question
    if (hasTimePeriod && /^(what|how|any)/i.test(lower)) {
      return { confidence: 0.85, reasoning: 'Time period schedule query' };
    }

    return null;
  },
  
  // ==================== EXECUTION ====================
  
  /**
   * Execute the task with full agentic capabilities
   */
  async execute(task) {
    try {
      // Initialize memory and poller
      if (!this.memory) {
        await this.initialize();
      }
      
      const context = getTimeContext();
      
      // Fetch calendar events
      const events = await this._fetchEvents();
      
      if (!events || events.length === 0) {
        const result = { success: true, message: "Your calendar is clear - no upcoming events." };
        await this._recordQuery(task.content, result.message);
        return result;
      }
      
      // ==================== SIMPLE LLM APPROACH ====================
      // Feed the events directly to the LLM and let it answer
      console.log('[CalendarAgent] Asking LLM to answer calendar question with', events.length, 'events');
      const result = await this._askLLMAboutCalendar(task.content, events, context);
      
      // Learn from this interaction
      await this._learnFromQuery(task.content, result, context);
      
      return result;
      
    } catch (error) {
      console.error('[CalendarAgent] Error:', error);
      return { 
        success: false, 
        message: THINKING_CONFIG.errorMessage 
      };
    }
  },
  
  /**
   * Simple LLM approach - feed events and let LLM answer
   */
  async _askLLMAboutCalendar(userQuestion, events, context) {
    const apiKey = getOpenAIApiKey();
    
    if (!apiKey) {
      console.log('[CalendarAgent] No API key, cannot use LLM');
      return { success: false, message: "I need an API key to check your calendar." };
    }
    
    // Format events for LLM (include all relevant info)
    const now = new Date();
    const eventsText = events.map(e => {
      const start = new Date(e.start?.dateTime || e.start?.date);
      const dayName = start.toLocaleDateString('en-US', { weekday: 'long' });
      const date = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const time = e.start?.dateTime 
        ? start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        : 'All day';
      return `- ${dayName}, ${date} at ${time}: "${e.summary}"`;
    }).join('\n');
    
    const systemPrompt = `You are a helpful calendar assistant. Answer the user's question about their calendar.

CURRENT DATE/TIME:
- Today is ${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
- Current time: ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
- Part of day: ${context.partOfDay}

CALENDAR EVENTS (next 2 weeks):
${eventsText || 'No events found'}

INSTRUCTIONS:
- Answer the user's question directly and concisely
- For "what's happening Monday" type questions, list the events for that day
- Keep responses brief and conversational (1-3 sentences for simple queries)
- If no events match the query, say so clearly
- Use natural language, not bullet points for voice responses`;

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userQuestion }
          ],
          temperature: 0.7,
          max_tokens: 200
        })
      });
      
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }
      
      const data = await response.json();
      const answer = data.choices?.[0]?.message?.content?.trim();
      
      if (!answer) {
        throw new Error('No response from LLM');
      }
      
      // Track cost
      if (global.budgetManager) {
        global.budgetManager.trackUsage({
          model: 'gpt-4o-mini',
          inputTokens: data.usage?.prompt_tokens || 0,
          outputTokens: data.usage?.completion_tokens || 0,
          context: 'calendar-query'
        });
      }
      
      console.log('[CalendarAgent] LLM response:', answer);
      return { success: true, message: answer };
      
    } catch (error) {
      console.error('[CalendarAgent] LLM error:', error);
      return { success: false, message: "Sorry, I couldn't check your calendar right now." };
    }
  },
  
  /**
   * Execute based on AI's understanding (legacy - kept for fallback)
   */
  async _executeAIAction(aiResult, events) {
    switch (aiResult.action) {
      case 'today':
        return this._getEventsForDay(events, 'today');
      
      case 'tomorrow':
        return this._getEventsForDay(events, 'tomorrow');
      
      case 'week':
        return this._getEventsForWeek(events);
      
      case 'next_meeting':
        return this._getNextMeeting(events);
      
      case 'availability':
        if (aiResult.specificTime) {
          return this._checkAvailability(events, `at ${aiResult.specificTime}`);
        }
        return this._checkAvailability(events, '');
      
      case 'time_period':
        if (aiResult.timePeriod) {
          return this._getEventsForTimePeriod(events, aiResult.timePeriod);
        }
        return this._getEventsForDay(events, 'today');
      
      case 'specific_day':
        // Handle day-of-week queries (Monday, Tuesday, etc.)
        if (aiResult.timeframe) {
          return this._getEventsForTimeframe(events, aiResult.timeframe);
        }
        return this._getEventsForDay(events, 'today');
      
      default:
        // If timeframe is set, use it (handles cases where action might be 'clarify' but we have a day)
        if (aiResult.timeframe && !aiResult.needsClarification) {
          return this._getEventsForTimeframe(events, aiResult.timeframe);
        }
        // Fallback to today's events
        return this._getEventsForDay(events, 'today');
    }
  },
  
  /**
   * Execute based on pattern matching (fallback when AI unavailable)
   */
  async _executePatternMatch(lower, events, context) {
    // Check for "next meeting" query
    if (lower.includes('next meeting') || lower.includes('next appointment') || lower.includes('next event')) {
      return this._getNextMeeting(events);
    }
    
    // Check for availability query with specific time
    if ((lower.includes('free') || lower.includes('busy') || lower.includes('available')) && 
        /at \d/.test(lower)) {
      return this._checkAvailability(events, lower);
    }
    
    // Check for general availability - needs clarification
    if (lower.includes('free') || lower.includes('busy') || lower.includes('available')) {
      return {
        success: true,
        needsInput: {
          prompt: 'What time are you checking for?',
          agentId: this.id,
          context: {
            calendarState: 'awaiting_time',
            originalRequest: lower
          }
        }
      };
    }
    
    // Check for specific day queries
    if (lower.includes('today')) {
      return this._getEventsForDay(events, 'today');
    }
    if (lower.includes('tomorrow')) {
      return this._getEventsForDay(events, 'tomorrow');
    }
    if (lower.includes('this week') || lower.includes('week')) {
      return this._getEventsForWeek(events);
    }
    if (lower.includes('this morning') || lower.includes('morning')) {
      return this._getEventsForTimePeriod(events, 'morning');
    }
    if (lower.includes('this afternoon') || lower.includes('afternoon')) {
      return this._getEventsForTimePeriod(events, 'afternoon');
    }
    
    // Vague request - check learned default or ask
    const prefs = this._getPreferences();
    if (prefs.defaultTimeframe) {
      if (prefs.defaultTimeframe === 'today') {
        return this._getEventsForDay(events, 'today');
      } else if (prefs.defaultTimeframe === 'tomorrow') {
        return this._getEventsForDay(events, 'tomorrow');
      } else if (prefs.defaultTimeframe === 'this week') {
        return this._getEventsForWeek(events);
      }
    }
    
    // No learned preference - ask for clarification
    return {
      success: true,
      needsInput: {
        prompt: 'For today, tomorrow, or this week?',
        options: ['today', 'tomorrow', 'this week'],
        agentId: this.id,
        context: {
          calendarState: 'awaiting_timeframe',
          originalRequest: lower
        }
      }
    };
  },
  
  // ==================== MULTI-TURN HANDLERS ====================
  
  /**
   * Handle timeframe clarification response
   */
  async _handleTimeframeResponse(task) {
    const input = (task.context?.userInput || task.content).toLowerCase().trim();
    const events = await this._fetchEvents();
    
    if (!events || events.length === 0) {
      return { success: true, message: "Your calendar is clear - no upcoming events." };
    }
    
    let result;
    if (input.includes('today') || input === '1' || input === 'one') {
      result = this._getEventsForDay(events, 'today');
      await this._updateLearnedPattern('Default Timeframe', 'today');
    } else if (input.includes('tomorrow') || input === '2' || input === 'two') {
      result = this._getEventsForDay(events, 'tomorrow');
      await this._updateLearnedPattern('Default Timeframe', 'tomorrow');
    } else if (input.includes('week') || input === '3' || input === 'three') {
      result = this._getEventsForWeek(events);
      await this._updateLearnedPattern('Default Timeframe', 'this week');
    } else {
      // Try to parse as a day name
      const dayMatch = input.match(/(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i);
      if (dayMatch) {
        result = this._getEventsForDayName(events, dayMatch[1]);
      } else {
        // Default to today
        result = this._getEventsForDay(events, 'today');
      }
    }
    
    await this._recordQuery(`${task.context?.originalRequest} -> ${input}`, result.message);
    return result;
  },
  
  /**
   * Handle time clarification response
   */
  async _handleTimeResponse(task) {
    const input = (task.context?.userInput || task.content).toLowerCase().trim();
    const events = await this._fetchEvents();
    
    if (!events || events.length === 0) {
      return { success: true, message: "Your calendar is clear - you're free!" };
    }
    
    // Try to extract time from input
    const result = this._checkAvailability(events, `at ${input}`);
    await this._recordQuery(`availability at ${input}`, result.message);
    return result;
  },
  
  /**
   * Handle AI clarification response
   */
  async _handleAIClarificationResponse(task, context) {
    const userResponse = task.context?.userInput || task.content;
    const originalRequest = task.context?.originalRequest || '';
    
    // Combine for better context
    const combinedRequest = `${originalRequest} - ${userResponse}`;
    
    // Fetch events
    const events = await this._fetchEvents();
    if (!events || events.length === 0) {
      return { success: true, message: "Your calendar is clear - no upcoming events." };
    }
    
    // Try AI again with clarified request
    const aiContext = {
      partOfDay: context.partOfDay,
      memory: this.memory ? this._getMemoryContext() : null,
      events,
      conversationHistory: `Original request: ${originalRequest}\nClarification: ${userResponse}`
    };
    
    const aiResult = await aiUnderstandCalendarRequest(combinedRequest, aiContext);
    
    if (aiResult && !aiResult.needsClarification) {
      const result = await this._executeAIAction(aiResult, events);
      await this._recordQuery(combinedRequest, result.message);
      return result;
    }
    
    // Still can't understand - fall back to pattern matching on response
    const result = await this._executePatternMatch(userResponse.toLowerCase(), events, context);
    await this._recordQuery(combinedRequest, result.message);
    return result;
  },
  
  // ==================== LEARNING ====================
  
  /**
   * Get memory context for AI
   */
  _getMemoryContext() {
    const sections = [];
    
    const notifPrefs = this.memory.getSection('Notification Preferences');
    if (notifPrefs) sections.push(`Notification Preferences:\n${notifPrefs}`);
    
    const displayPrefs = this.memory.getSection('Display Preferences');
    if (displayPrefs) sections.push(`Display Preferences:\n${displayPrefs}`);
    
    const patterns = this.memory.getSection('Learned Patterns');
    if (patterns && !patterns.includes('*Will be populated')) {
      sections.push(`Learned Patterns:\n${patterns}`);
    }
    
    return sections.join('\n\n');
  },
  
  /**
   * Record a query for learning
   */
  async _recordQuery(query, response) {
    if (!this.memory) return;
    
    const timestamp = new Date().toISOString().split('T')[0];
    const entry = `- ${timestamp}: "${query.slice(0, 40)}..." -> ${response.slice(0, 50)}...`;
    
    this.memory.appendToSection('Recent Queries', entry, 20);
    await this.memory.save();
  },
  
  /**
   * Update a learned pattern
   */
  async _updateLearnedPattern(key, value) {
    if (!this.memory) return;
    
    const patterns = this.memory.parseSectionAsKeyValue('Learned Patterns') || {};
    patterns[key] = value;
    
    const lines = Object.entries(patterns)
      .filter(([k]) => !k.startsWith('*'))
      .map(([k, v]) => `- ${k}: ${v}`);
    
    if (lines.length > 0) {
      this.memory.updateSection('Learned Patterns', lines.join('\n'));
      await this.memory.save();
      console.log(`[CalendarAgent] Learned pattern: ${key} = ${value}`);
    }
  },
  
  /**
   * Learn from a query interaction
   */
  async _learnFromQuery(query, result, context) {
    if (!this.memory) return;
    
    // Record the query
    await this._recordQuery(query, result.message);
    
    // Analyze patterns
    const lower = query.toLowerCase();
    
    // Learn time-of-day patterns
    if (lower.includes('today') || lower.includes('tomorrow') || lower.includes('week')) {
      const timePattern = lower.includes('today') ? 'today' : 
                         lower.includes('tomorrow') ? 'tomorrow' : 'week';
      
      // Track if user consistently asks for same timeframe at this time of day
      const patternKey = `${context.partOfDay} preference`;
      const patterns = this.memory.parseSectionAsKeyValue('Learned Patterns') || {};
      
      if (!patterns[patternKey]) {
        await this._updateLearnedPattern(patternKey, `Usually asks about ${timePattern}`);
      }
    }
    
    // Use the shared learning function
    await learnFromInteraction(this.memory, { content: query }, result, {
      useAILearning: false
    });
  },
  
  // ==================== EVENT FETCHING ====================
  
  /**
   * Fetch events from the omnical API
   */
  async _fetchEvents() {
    const now = Date.now();
    
    // Return cached events if still valid
    if (this._cache.events && (now - this._cache.fetchedAt) < CACHE_TTL_MS) {
      console.log('[CalendarAgent] Using cached events');
      return this._cache.events;
    }
    
    try {
      console.log('[CalendarAgent] Fetching events from omnical API');
      const response = await fetch(OMNICAL_API_URL);
      
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }
      
      const events = await response.json();
      
      // Cache the events
      this._cache.events = events;
      this._cache.fetchedAt = now;
      
      console.log(`[CalendarAgent] Fetched ${events.length} events`);
      return events;
      
    } catch (error) {
      console.error('[CalendarAgent] Failed to fetch events:', error);
      // Return cached events if available, even if stale
      if (this._cache.events) {
        console.log('[CalendarAgent] Returning stale cached events');
        return this._cache.events;
      }
      throw error;
    }
  },
  
  // ==================== EVENT FORMATTING ====================
  
  /**
   * Get the next upcoming meeting
   */
  _getNextMeeting(events) {
    const now = new Date();
    const prefs = this._getPreferences();
    
    // Filter to future events and sort by start time
    const futureEvents = events
      .filter(e => {
        const start = new Date(e.start?.dateTime || e.start?.date);
        return start > now;
      })
      .sort((a, b) => {
        const aStart = new Date(a.start?.dateTime || a.start?.date);
        const bStart = new Date(b.start?.dateTime || b.start?.date);
        return aStart - bStart;
      });
    
    if (futureEvents.length === 0) {
      return { success: true, message: "You don't have any upcoming meetings." };
    }
    
    const next = futureEvents[0];
    const startTime = new Date(next.start?.dateTime || next.start?.date);
    const timeUntil = this._formatTimeUntil(startTime);
    const formattedTime = this._formatEventTime(next, prefs);
    
    let message = `Your next meeting is "${next.summary}" ${timeUntil}, at ${formattedTime}`;
    
    // Add location if enabled
    if (prefs.showLocation) {
      if (next.location && next.location.includes('http')) {
        message += ". It's a video call.";
      } else if (next.location) {
        message += ` at ${next.location}`;
      }
    }
    
    // Add attendees if enabled
    if (prefs.showAttendees && next.attendees && next.attendees.length > 0) {
      const attendeeCount = next.attendees.length;
      message += ` with ${attendeeCount} attendee${attendeeCount > 1 ? 's' : ''}`;
    }
    
    return { success: true, message };
  },
  
  /**
   * Check availability at a specific time or generally
   */
  _checkAvailability(events, query) {
    const now = new Date();
    
    // Check if asking about a specific time
    const timeMatch = query.match(/at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    
    if (timeMatch) {
      let hours = parseInt(timeMatch[1]);
      const minutes = parseInt(timeMatch[2]) || 0;
      const ampm = timeMatch[3]?.toLowerCase();
      
      // Handle 12-hour format
      if (ampm === 'pm' && hours !== 12) hours += 12;
      if (ampm === 'am' && hours === 12) hours = 0;
      // If no am/pm and hours <= 6, assume PM for business hours
      if (!ampm && hours >= 1 && hours <= 6) hours += 12;
      
      const checkTime = new Date(now);
      checkTime.setHours(hours, minutes, 0, 0);
      
      // If the time is earlier today, assume they mean tomorrow
      if (checkTime < now) {
        checkTime.setDate(checkTime.getDate() + 1);
      }
      
      const conflictingEvent = events.find(e => {
        const start = new Date(e.start?.dateTime || e.start?.date);
        const end = new Date(e.end?.dateTime || e.end?.date);
        return checkTime >= start && checkTime < end;
      });
      
      const formattedTime = checkTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      
      if (conflictingEvent) {
        return { 
          success: true, 
          message: `No, you have "${conflictingEvent.summary}" at ${formattedTime}.` 
        };
      } else {
        return { success: true, message: `Yes, you're free at ${formattedTime}.` };
      }
    }
    
    // General availability check - look for current meeting
    const currentMeeting = events.find(e => {
      const start = new Date(e.start?.dateTime || e.start?.date);
      const end = new Date(e.end?.dateTime || e.end?.date);
      return now >= start && now < end;
    });
    
    if (currentMeeting) {
      const end = new Date(currentMeeting.end?.dateTime || currentMeeting.end?.date);
      const endsAt = end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      return { 
        success: true, 
        message: `You're currently in "${currentMeeting.summary}" until ${endsAt}.` 
      };
    }
    
    // Find next meeting
    const nextMeeting = events
      .filter(e => new Date(e.start?.dateTime || e.start?.date) > now)
      .sort((a, b) => new Date(a.start?.dateTime) - new Date(b.start?.dateTime))[0];
    
    if (nextMeeting) {
      const startTime = new Date(nextMeeting.start?.dateTime || nextMeeting.start?.date);
      const timeUntil = this._formatTimeUntil(startTime);
      return { 
        success: true, 
        message: `You're free right now. Your next meeting "${nextMeeting.summary}" is ${timeUntil}.` 
      };
    }
    
    return { success: true, message: "You're free - no upcoming meetings." };
  },
  
  /**
   * Get events for any timeframe (routes to appropriate handler)
   */
  _getEventsForTimeframe(events, timeframe) {
    const tf = timeframe.toLowerCase();
    
    // Handle standard timeframes
    if (tf === 'today') {
      return this._getEventsForDay(events, 'today');
    }
    if (tf === 'tomorrow') {
      return this._getEventsForDay(events, 'tomorrow');
    }
    if (tf === 'this_week' || tf === 'this week') {
      return this._getEventsForWeek(events);
    }
    
    // Handle day names (monday, tuesday, etc.)
    const dayNames = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    if (dayNames.includes(tf)) {
      return this._getEventsForDayName(events, tf);
    }
    
    // Default to today
    return this._getEventsForDay(events, 'today');
  },
  
  /**
   * Get events for a specific day
   */
  _getEventsForDay(events, day) {
    const now = new Date();
    let targetDate = new Date(now);
    
    if (day === 'tomorrow') {
      targetDate.setDate(targetDate.getDate() + 1);
    }
    
    const dayStart = new Date(targetDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(targetDate);
    dayEnd.setHours(23, 59, 59, 999);
    
    const dayEvents = events.filter(e => {
      const start = new Date(e.start?.dateTime || e.start?.date);
      return start >= dayStart && start <= dayEnd;
    }).sort((a, b) => {
      return new Date(a.start?.dateTime || a.start?.date) - new Date(b.start?.dateTime || b.start?.date);
    });
    
    const dayLabel = day === 'today' ? 'today' : 'tomorrow';
    
    if (dayEvents.length === 0) {
      return { success: true, message: `You have no events ${dayLabel}.` };
    }
    
    const prefs = this._getPreferences();
    
    if (dayEvents.length === 1) {
      const e = dayEvents[0];
      const time = this._formatEventTime(e, prefs);
      return { success: true, message: `You have one meeting ${dayLabel}: "${e.summary}" at ${time}.` };
    }
    
    // Multiple events
    const eventList = dayEvents.slice(0, 5).map(e => {
      const time = this._formatEventTime(e, prefs);
      return `"${e.summary}" at ${time}`;
    }).join(', ');
    
    const count = dayEvents.length;
    const more = count > 5 ? ` and ${count - 5} more` : '';
    
    return { 
      success: true, 
      message: `You have ${count} meetings ${dayLabel}: ${eventList}${more}.` 
    };
  },
  
  /**
   * Get events for a specific day name (Monday, Tuesday, etc.)
   */
  _getEventsForDayName(events, dayName) {
    const now = new Date();
    const dayMap = {
      'sunday': 0, 'monday': 1, 'tuesday': 2, 'wednesday': 3,
      'thursday': 4, 'friday': 5, 'saturday': 6
    };
    
    const targetDayNum = dayMap[dayName.toLowerCase()];
    const currentDayNum = now.getDay();
    
    let daysUntil = targetDayNum - currentDayNum;
    if (daysUntil <= 0) daysUntil += 7; // Next week if today or past
    
    const targetDate = new Date(now);
    targetDate.setDate(targetDate.getDate() + daysUntil);
    
    const dayStart = new Date(targetDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(targetDate);
    dayEnd.setHours(23, 59, 59, 999);
    
    console.log(`[CalendarAgent] Looking for ${dayName}: ${targetDate.toDateString()} (${daysUntil} days from today)`);
    console.log(`[CalendarAgent] Date range: ${dayStart.toISOString()} to ${dayEnd.toISOString()}`);
    
    // Debug: show first few event dates
    if (events.length > 0) {
      const sampleDates = events.slice(0, 5).map(e => {
        const d = new Date(e.start?.dateTime || e.start?.date);
        return `${e.summary?.slice(0, 20)}: ${d.toDateString()}`;
      });
      console.log(`[CalendarAgent] Sample events:`, sampleDates);
    }
    
    const dayEvents = events.filter(e => {
      const start = new Date(e.start?.dateTime || e.start?.date);
      return start >= dayStart && start <= dayEnd;
    }).sort((a, b) => {
      return new Date(a.start?.dateTime || a.start?.date) - new Date(b.start?.dateTime || b.start?.date);
    });
    
    console.log(`[CalendarAgent] Found ${dayEvents.length} events for ${dayName}`);
    
    const dayLabel = dayName.charAt(0).toUpperCase() + dayName.slice(1);
    
    if (dayEvents.length === 0) {
      return { success: true, message: `You have no events on ${dayLabel}.` };
    }
    
    const prefs = this._getPreferences();
    
    if (dayEvents.length === 1) {
      const e = dayEvents[0];
      const time = this._formatEventTime(e, prefs);
      return { success: true, message: `On ${dayLabel} you have: "${e.summary}" at ${time}.` };
    }
    
    const eventList = dayEvents.slice(0, 5).map(e => {
      const time = this._formatEventTime(e, prefs);
      return `"${e.summary}" at ${time}`;
    }).join(', ');
    
    const count = dayEvents.length;
    const more = count > 5 ? ` and ${count - 5} more` : '';
    
    return { 
      success: true, 
      message: `On ${dayLabel} you have ${count} meetings: ${eventList}${more}.` 
    };
  },
  
  /**
   * Get events for the current week
   */
  _getEventsForWeek(events) {
    const now = new Date();
    const weekEnd = new Date(now);
    weekEnd.setDate(weekEnd.getDate() + 7);
    
    const weekEvents = events.filter(e => {
      const start = new Date(e.start?.dateTime || e.start?.date);
      return start >= now && start <= weekEnd;
    }).sort((a, b) => {
      return new Date(a.start?.dateTime || a.start?.date) - new Date(b.start?.dateTime || b.start?.date);
    });
    
    if (weekEvents.length === 0) {
      return { success: true, message: "You have no events this week." };
    }
    
    if (weekEvents.length <= 3) {
      const eventList = weekEvents.map(e => {
        const time = this._formatEventTimeWithDay(e);
        return `"${e.summary}" ${time}`;
      }).join(', ');
      
      return { success: true, message: `This week you have: ${eventList}.` };
    }
    
    // Summarize by day count
    const byDay = {};
    weekEvents.forEach(e => {
      const start = new Date(e.start?.dateTime || e.start?.date);
      const dayKey = start.toLocaleDateString('en-US', { weekday: 'long' });
      byDay[dayKey] = (byDay[dayKey] || 0) + 1;
    });
    
    const summary = Object.entries(byDay)
      .map(([day, count]) => `${count} on ${day}`)
      .join(', ');
    
    return { 
      success: true, 
      message: `You have ${weekEvents.length} meetings this week: ${summary}.` 
    };
  },
  
  /**
   * Get events for a time period (morning/afternoon/evening)
   */
  _getEventsForTimePeriod(events, period) {
    const now = new Date();
    const periodStart = new Date(now);
    const periodEnd = new Date(now);
    
    if (period === 'morning') {
      periodStart.setHours(0, 0, 0, 0);
      periodEnd.setHours(12, 0, 0, 0);
    } else if (period === 'afternoon') {
      periodStart.setHours(12, 0, 0, 0);
      periodEnd.setHours(18, 0, 0, 0);
    } else { // evening
      periodStart.setHours(18, 0, 0, 0);
      periodEnd.setHours(23, 59, 59, 999);
    }
    
    const periodEvents = events.filter(e => {
      const start = new Date(e.start?.dateTime || e.start?.date);
      return start >= periodStart && start < periodEnd && start.toDateString() === now.toDateString();
    }).sort((a, b) => {
      return new Date(a.start?.dateTime || a.start?.date) - new Date(b.start?.dateTime || b.start?.date);
    });
    
    if (periodEvents.length === 0) {
      return { success: true, message: `You have no meetings this ${period}.` };
    }
    
    const prefs = this._getPreferences();
    
    const eventList = periodEvents.map(e => {
      const time = this._formatEventTime(e, prefs);
      return `"${e.summary}" at ${time}`;
    }).join(', ');
    
    return { 
      success: true, 
      message: `This ${period} you have: ${eventList}.` 
    };
  },
  
  /**
   * Get upcoming events
   */
  _getUpcomingEvents(events, limit = 3) {
    const now = new Date();
    
    const upcoming = events
      .filter(e => new Date(e.start?.dateTime || e.start?.date) > now)
      .sort((a, b) => new Date(a.start?.dateTime) - new Date(b.start?.dateTime))
      .slice(0, limit);
    
    if (upcoming.length === 0) {
      return { success: true, message: "You don't have any upcoming events." };
    }
    
    const eventList = upcoming.map(e => {
      const time = this._formatEventTimeWithDay(e);
      return `"${e.summary}" ${time}`;
    }).join(', ');
    
    return { 
      success: true, 
      message: `Your upcoming events: ${eventList}.` 
    };
  },
  
  // ==================== TIME FORMATTING ====================
  
  /**
   * Format event time (just time)
   */
  _formatEventTime(event, prefs = {}) {
    const start = new Date(event.start?.dateTime || event.start?.date);
    
    // Check if it's an all-day event
    if (!event.start?.dateTime) {
      return 'all day';
    }
    
    const use24Hour = prefs.timeFormat === '24-hour';
    return start.toLocaleTimeString('en-US', { 
      hour: use24Hour ? '2-digit' : 'numeric', 
      minute: '2-digit',
      hour12: !use24Hour
    });
  },
  
  /**
   * Format event time with day
   */
  _formatEventTimeWithDay(event) {
    const start = new Date(event.start?.dateTime || event.start?.date);
    const now = new Date();
    
    // Check if today
    if (start.toDateString() === now.toDateString()) {
      return `today at ${this._formatEventTime(event)}`;
    }
    
    // Check if tomorrow
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    if (start.toDateString() === tomorrow.toDateString()) {
      return `tomorrow at ${this._formatEventTime(event)}`;
    }
    
    // Other day
    const dayName = start.toLocaleDateString('en-US', { weekday: 'long' });
    return `on ${dayName} at ${this._formatEventTime(event)}`;
  },
  
  /**
   * Format time until an event
   */
  _formatTimeUntil(date) {
    const now = new Date();
    const diffMs = date - now;
    const diffMins = Math.round(diffMs / 60000);
    
    if (diffMins < 1) return 'starting now';
    if (diffMins < 60) return `in ${diffMins} minute${diffMins === 1 ? '' : 's'}`;
    
    const diffHours = Math.round(diffMins / 60);
    if (diffHours < 24) return `in ${diffHours} hour${diffHours === 1 ? '' : 's'}`;
    
    const diffDays = Math.round(diffHours / 24);
    if (diffDays === 1) return 'tomorrow';
    
    return `in ${diffDays} days`;
  },
  
  // ==================== CLEANUP ====================
  
  /**
   * Cleanup when agent is unloaded
   */
  cleanup() {
    this._stopMeetingPoller();
    
    // Cancel any scheduled reminders
    try {
      const notificationManager = require('../../src/voice-task-sdk/notifications/notificationManager');
      for (const [eventId, notificationId] of this._scheduledReminders) {
        notificationManager.cancel(notificationId);
      }
    } catch (e) {
      // Notification manager may not be available
    }
    
    this._scheduledReminders.clear();
  }
};

module.exports = calendarAgent;
