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

// Omnical API endpoints
const OMNICAL_API_URL = 'https://em.edison.api.onereach.ai/http/35254342-4a2e-475b-aec1-18547e517e29/omnical';
const OMNICAL_ADD_EVENT_URL = 'https://em.edison.api.onereach.ai/http/35254342-4a2e-475b-aec1-18547e517e29/omnical_event';
const OMNICAL_DELETE_EVENT_URL = 'https://em.edison.api.onereach.ai/http/35254342-4a2e-475b-aec1-18547e517e29/omnicaldelete';
const OMNICAL_DETAILS_URL = 'https://em.edison.api.onereach.ai/http/35254342-4a2e-475b-aec1-18547e517e29/omnical_details';

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
    'Proactive meeting reminders',
    'Add/create new calendar events',
    'Delete/cancel/remove calendar events',
    'Get detailed event information (attendees, description, location, etc.)'
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
  "action": "today" | "tomorrow" | "week" | "next_meeting" | "availability" | "time_period" | "specific_day" | "add_event" | "delete_event" | "event_details" | "find_availability" | "clarify",
  "timeframe": "today" | "tomorrow" | "this_week" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday" | null,
  "timePeriod": "morning" | "afternoon" | "evening" | null,
  "specificTime": "3pm" | null,
  "eventDetails": {
    "title": "Event title if creating",
    "date": "YYYY-MM-DD format",
    "time": "HH:MM 24-hour format",
    "duration": "e.g. 30m, 1h, 90m",
    "location": "optional location",
    "description": "optional description",
    "guests": "comma-delimited email addresses (e.g. 'john@example.com,sarah@example.com')"
  },
  "deleteDetails": {
    "searchText": "Event title or partial match to find",
    "date": "YYYY-MM-DD format if specified",
    "eventId": "Google Calendar event ID if known",
    "calendarId": "Google Calendar ID, defaults to 'primary'"
  },
  "detailsQuery": {
    "searchText": "Event title or partial match to find",
    "date": "YYYY-MM-DD format if specified",
    "infoRequested": "what info user wants: 'attendees' | 'location' | 'description' | 'time' | 'all'"
  },
  "availabilityQuery": {
    "contactName": "Name of person to check availability with",
    "date": "YYYY-MM-DD format if specified, null for today",
    "duration": "Meeting duration in minutes (default 60)"
  },
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
- "add dentist appointment tomorrow at 2pm" → action: "add_event", eventDetails: {title: "dentist appointment", date: "[tomorrow's date]", time: "14:00", duration: "60m"}, needsClarification: false
- "schedule a meeting with John on Friday at 10am for 30 minutes" → action: "add_event", eventDetails: {title: "meeting with John", date: "[Friday's date]", time: "10:00", duration: "30m"}, needsClarification: false
- "put lunch with Sarah on my calendar Thursday noon" → action: "add_event", eventDetails: {title: "lunch with Sarah", date: "[Thursday's date]", time: "12:00", duration: "60m"}, needsClarification: false
- "schedule team sync tomorrow 3pm and invite john@acme.com and sarah@acme.com" → action: "add_event", eventDetails: {title: "team sync", date: "[tomorrow's date]", time: "15:00", duration: "60m", guests: "john@acme.com,sarah@acme.com"}, needsClarification: false
- "set up a call with John and Sarah on Monday at 2pm" → action: "add_event", eventDetails: {title: "call with John and Sarah", date: "[Monday's date]", time: "14:00", duration: "60m", guests: "John,Sarah"}, needsClarification: false

EXAMPLES - EVENT DETAILS (NO CLARIFICATION NEEDED):
- "who's attending the team meeting?" → action: "event_details", detailsQuery: {searchText: "team meeting", infoRequested: "attendees"}, needsClarification: false
- "where is my dentist appointment?" → action: "event_details", detailsQuery: {searchText: "dentist appointment", infoRequested: "location"}, needsClarification: false
- "tell me more about the 3pm meeting" → action: "event_details", detailsQuery: {searchText: "3pm", infoRequested: "all"}, needsClarification: false
- "what time is the standup tomorrow?" → action: "event_details", detailsQuery: {searchText: "standup", date: "[tomorrow's date]", infoRequested: "time"}, needsClarification: false

EXAMPLES - DELETE EVENT (NO CLARIFICATION NEEDED):
- "delete the dentist appointment" → action: "delete_event", deleteDetails: {searchText: "dentist appointment"}, needsClarification: false
- "cancel my meeting with John tomorrow" → action: "delete_event", deleteDetails: {searchText: "meeting with John", date: "[tomorrow's date]"}, needsClarification: false
- "remove the 3pm meeting" → action: "delete_event", deleteDetails: {searchText: "3pm"}, needsClarification: false

EXAMPLES - FIND MUTUAL AVAILABILITY (NO CLARIFICATION NEEDED):
- "what's a good time to meet with Josh?" → action: "find_availability", availabilityQuery: {contactName: "Josh", date: null, duration: 60}, needsClarification: false
- "when can I book something with Sarah tomorrow?" → action: "find_availability", availabilityQuery: {contactName: "Sarah", date: "[tomorrow's date]", duration: 60}, needsClarification: false
- "find time with John on Friday for 30 minutes" → action: "find_availability", availabilityQuery: {contactName: "John", date: "[Friday's date]", duration: 30}, needsClarification: false
- "when are Josh and I both free Monday?" → action: "find_availability", availabilityQuery: {contactName: "Josh", date: "[Monday's date]", duration: 60}, needsClarification: false
- "check Josh's availability this week" → action: "find_availability", availabilityQuery: {contactName: "Josh", date: null, duration: 60}, needsClarification: false

EXAMPLES - CLARIFICATION NEEDED:
- "check my calendar" (no time at all) → needsClarification: true
- "am I free" (no time specified) → needsClarification: true
- "add a meeting" (no title, date, or time) → needsClarification: true, clarificationPrompt: "What would you like to call this event and when should I schedule it?"
- "delete my meeting" (too vague, multiple possible matches) → needsClarification: true, clarificationPrompt: "Which meeting would you like me to delete?"`;

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

// Track recent task executions to detect duplicates
const _recentExecutions = new Map(); // taskId -> timestamp
const EXECUTION_DEDUP_WINDOW_MS = 2000; // Ignore duplicate within 2 seconds

const calendarAgent = {
  id: 'calendar-agent',
  name: 'Calendar Agent',
  description: 'Answers calendar and meeting questions - shows your schedule, checks availability, creates and deletes events, and provides proactive reminders',
  voice: 'coral',  // Professional, clear - see VOICE-GUIDE.md
  acks: ["Let me check your calendar.", "Checking your schedule."],
  categories: ['system', 'calendar'],
  keywords: [
    'calendar', 'meeting', 'meetings', 'schedule', 'event', 'events', 
    'appointment', 'busy', 'free', 'available', 'availability',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'today', 'tomorrow', 'happening', 'going on', 'scheduled', 'planned',
    'add', 'create', 'book', 'set up', 'schedule a', 'put on', 'block', 'reserve',
    'delete', 'cancel', 'remove', 'clear', 'drop', 'get rid of',
    'details', 'attendees', 'who is', 'where is', 'more info', 'tell me about'
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
- Event creation: "add a meeting", "schedule an appointment", "create an event", "book time", "put X on my calendar"
- Event deletion: "delete the meeting", "cancel my appointment", "remove the event", "clear my calendar"
- Event details: "tell me more about the meeting", "who's attending", "where is the meeting", "what's the meeting about"

CRITICAL PATTERNS THIS AGENT HANDLES:
- "What's happening [day name]?" - e.g., "What's happening Monday?"
- "What's going on [time]?" - e.g., "What's going on tomorrow?"
- "Anything on [day]?" - e.g., "Anything on Friday?"
- Questions about any specific day of the week (Monday through Sunday)
- Questions about today, tomorrow, this week, this morning, this afternoon
- Event creation: "Add [event] to my calendar", "Schedule [meeting] for [time]", "Create an event for [date]"

If the user asks about what's happening on ANY day or time period, this is a calendar query. Day names like Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday are strong calendar signals.

If the user wants to ADD, CREATE, BOOK, or SCHEDULE something on the calendar, this agent handles it.
If the user wants to DELETE, CANCEL, REMOVE, or CLEAR an event from the calendar, this agent handles it.`,
  
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
  _initializing: false, // Guard against concurrent initialization
  
  /**
   * Initialize memory and start proactive features
   */
  async initialize() {
    // Guard against concurrent initialization
    if (this._initializing) {
      console.log('[CalendarAgent] Initialize already in progress, waiting...');
      while (this._initializing) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return this.memory;
    }
    
    // Guard against re-initialization when already initialized
    if (this.memory && this._pollerInterval) {
      console.log('[CalendarAgent] Already initialized, skipping');
      return this.memory;
    }
    
    this._initializing = true;
    console.log('[CalendarAgent] Initializing...');
    
    try {
      if (!this.memory) {
        this.memory = getAgentMemory('calendar-agent', { displayName: 'Calendar Agent' });
        await this.memory.load();
        this._ensureMemorySections();
        console.log('[CalendarAgent] Memory loaded');
      }
      
      // Clear cache on initialize to force fresh data fetch
      this._cache.events = null;
      this._cache.fetchedAt = 0;
      
      // Start meeting poller for proactive reminders
      this._startMeetingPoller();
      
      console.log('[CalendarAgent] Initialization complete');
      return this.memory;
    } finally {
      this._initializing = false;
    }
  },
  
  /**
   * Ensure required memory sections exist with full structure
   */
  _ensureMemorySections() {
    const sections = this.memory.getSectionNames();
    
    // Contacts - for looking up email addresses by name (with optional calendar API)
    if (!sections.includes('Contacts')) {
      this.memory.updateSection('Contacts', `*Add contacts here in format: Name: email@example.com*
*Optionally add calendar API URL to check availability: Name: email | calendar: URL*
*Example:*
*- John Smith: john.smith@company.com*
*- Sarah Jones: sarah@example.org | calendar: https://em.edison.api.onereach.ai/.../sarah-omnical*`);
    }
    
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
   * Get contacts from memory
   * @returns {Object} - Map of name (lowercase) to { email, calendarUrl? }
   */
  _getContacts() {
    if (!this.memory || !this.memory.isLoaded()) {
      return {};
    }
    
    const contactsSection = this.memory.getSection('Contacts');
    if (!contactsSection) {
      return {};
    }
    
    const contacts = {};
    const lines = contactsSection.split('\n');
    
    for (const line of lines) {
      // Skip comment lines (starting with *)
      if (line.trim().startsWith('*')) continue;
      
      // Parse formats:
      // "- Name: email" or "Name: email" (basic)
      // "- Name: email | calendar: URL" (with calendar API)
      
      // First check for calendar URL format
      const calendarMatch = line.match(/^-?\s*(.+?):\s*([^\s|]+@[^\s|]+)\s*\|\s*calendar:\s*(\S+)/i);
      if (calendarMatch) {
        const name = calendarMatch[1].trim().toLowerCase();
        const email = calendarMatch[2].trim();
        const calendarUrl = calendarMatch[3].trim();
        contacts[name] = { email, calendarUrl };
        continue;
      }
      
      // Fallback to basic format (email only)
      const basicMatch = line.match(/^-?\s*(.+?):\s*([^\s|]+@[^\s|]+)/i);
      if (basicMatch) {
        const name = basicMatch[1].trim().toLowerCase();
        const email = basicMatch[2].trim();
        contacts[name] = { email, calendarUrl: null };
      }
    }
    
    return contacts;
  },
  
  /**
   * Look up a contact by name (partial match supported)
   * @param {string} name - Name to search for
   * @returns {Object|null} - { name, email, calendarUrl? } or null if not found
   */
  _lookupContact(name) {
    const contacts = this._getContacts();
    const searchName = name.toLowerCase().trim();
    
    // Try exact match first
    if (contacts[searchName]) {
      const contact = contacts[searchName];
      return { name: searchName, email: contact.email, calendarUrl: contact.calendarUrl };
    }
    
    // Try partial match (first name or last name)
    for (const [contactName, contactInfo] of Object.entries(contacts)) {
      const nameParts = contactName.split(/\s+/);
      if (nameParts.some(part => part === searchName) || 
          contactName.includes(searchName)) {
        return { name: contactName, email: contactInfo.email, calendarUrl: contactInfo.calendarUrl };
      }
    }
    
    return null;
  },
  
  /**
   * Resolve guest names to emails using contacts
   * @param {string|Array} guests - Guest names/emails
   * @returns {Object} - { resolved: [emails], unresolved: [names] }
   */
  _resolveGuests(guests) {
    const resolved = [];
    const unresolved = [];
    
    let guestList = [];
    if (Array.isArray(guests)) {
      guestList = guests;
    } else if (typeof guests === 'string') {
      guestList = guests.split(',').map(g => g.trim()).filter(g => g.length > 0);
    }
    
    for (const guest of guestList) {
      // If it's already an email, use it directly
      if (guest.includes('@')) {
        resolved.push(guest);
      } else {
        // Try to look up the name
        const contact = this._lookupContact(guest);
        if (contact) {
          resolved.push(contact.email);
        } else {
          unresolved.push(guest);
        }
      }
    }
    
    return { resolved, unresolved };
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
  
  // ==================== DATA-AWARE BIDDING ====================
  
  /**
   * Bid on a task - uses cached data for context-aware bidding
   * 
   * This is data-aware: we check our cache to see if we have
   * relevant data before bidding. "Anything urgent?" only gets a high
   * bid if we actually HAVE an imminent meeting.
   * 
   * @param {Object} task - The task to bid on
   * @returns {Object|null} - { confidence, reasoning } or null to defer to unified bidder
   */
  bid(task) {
    const content = (task.content || task.phrase || '').toLowerCase();
    
    // Quick check: is this even calendar-related?
    const calendarSignals = [
      'calendar', 'meeting', 'schedule', 'event', 'appointment',
      'busy', 'free', 'available', 'urgent', 'important',
      'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
      'today', 'tomorrow', 'week', 'happening', 'going on'
    ];
    
    // Event creation signals
    const eventCreationSignals = [
      'add', 'create', 'book', 'set up', 'put on', 'block', 'reserve'
    ];
    const hasCreationSignal = eventCreationSignals.some(s => content.includes(s));
    
    // Event deletion signals
    const eventDeletionSignals = [
      'delete', 'cancel', 'remove', 'clear', 'drop', 'get rid of'
    ];
    const hasDeletionSignal = eventDeletionSignals.some(s => content.includes(s));
    
    // Check for event deletion with calendar context
    if (hasDeletionSignal && (content.includes('calendar') || content.includes('meeting') || 
        content.includes('event') || content.includes('appointment') || content.includes('the'))) {
      return {
        confidence: 0.90,
        reasoning: 'Event deletion request detected'
      };
    }
    
    // Check for event creation with calendar context
    if (hasCreationSignal && (content.includes('calendar') || content.includes('meeting') || 
        content.includes('event') || content.includes('appointment'))) {
      return {
        confidence: 0.90,
        reasoning: 'Event creation request detected'
      };
    }
    
    const hasCalendarSignal = calendarSignals.some(s => content.includes(s));
    
    // If no calendar signals, let unified bidder handle
    if (!hasCalendarSignal) {
      return null;
    }
    
    // Data-aware bidding based on cache
    const events = this._cache.events || [];
    const now = new Date();
    
    // Find upcoming events (next 24 hours)
    const upcomingEvents = events.filter(e => {
      const start = new Date(e.start?.dateTime || e.start?.date);
      return start > now && start <= new Date(now.getTime() + 24 * 60 * 60 * 1000);
    });
    
    // Find imminent meeting (next 30 minutes)
    const imminentMeeting = events.find(e => {
      const start = new Date(e.start?.dateTime || e.start?.date);
      const minutesUntil = (start - now) / 60000;
      return minutesUntil > 0 && minutesUntil <= 30;
    });
    
    // "Anything urgent?" type queries - bid based on actual data
    if (content.includes('urgent') || content.includes('important') || content.includes('coming up')) {
      if (imminentMeeting) {
        const start = new Date(imminentMeeting.start?.dateTime || imminentMeeting.start?.date);
        const minutesUntil = Math.round((start - now) / 60000);
        return {
          confidence: 0.92,
          reasoning: `Meeting "${imminentMeeting.summary}" in ${minutesUntil} minutes`
        };
      } else if (upcomingEvents.length > 0) {
        return {
          confidence: 0.75,
          reasoning: `${upcomingEvents.length} event${upcomingEvents.length > 1 ? 's' : ''} in next 24 hours`
        };
      } else {
        // We're the right agent for calendar stuff, but nothing urgent
        return {
          confidence: 0.60,
          reasoning: 'Calendar agent - no imminent meetings'
        };
      }
    }
    
    // Day-specific queries (Monday, Tuesday, etc.)
    const dayNames = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const mentionedDay = dayNames.find(d => content.includes(d));
    if (mentionedDay || content.includes('today') || content.includes('tomorrow') || content.includes('week')) {
      // Get events for that specific timeframe
      const dayEvents = this._getEventsForQueryTimeframe(events, content);
      if (dayEvents.length > 0) {
        return {
          confidence: 0.88,
          reasoning: `${dayEvents.length} event${dayEvents.length > 1 ? 's' : ''} found for requested timeframe`
        };
      } else {
        return {
          confidence: 0.80,
          reasoning: 'Calendar query - checking schedule'
        };
      }
    }
    
    // Generic calendar query
    if (upcomingEvents.length > 0) {
      return {
        confidence: 0.80,
        reasoning: `${upcomingEvents.length} upcoming event${upcomingEvents.length > 1 ? 's' : ''}`
      };
    }
    
    return {
      confidence: 0.70,
      reasoning: 'Calendar agent - schedule appears clear'
    };
  },
  
  /**
   * Helper to get events for a query timeframe (for bidding)
   */
  _getEventsForQueryTimeframe(events, query) {
    const now = new Date();
    const lower = query.toLowerCase();
    
    let startDate = new Date(now);
    let endDate = new Date(now);
    
    if (lower.includes('today')) {
      startDate.setHours(0, 0, 0, 0);
      endDate.setHours(23, 59, 59, 999);
    } else if (lower.includes('tomorrow')) {
      startDate.setDate(startDate.getDate() + 1);
      startDate.setHours(0, 0, 0, 0);
      endDate.setDate(endDate.getDate() + 1);
      endDate.setHours(23, 59, 59, 999);
    } else if (lower.includes('week')) {
      endDate.setDate(endDate.getDate() + 7);
    } else {
      // Day of week
      const dayMap = { 'sunday': 0, 'monday': 1, 'tuesday': 2, 'wednesday': 3, 'thursday': 4, 'friday': 5, 'saturday': 6 };
      const day = Object.keys(dayMap).find(d => lower.includes(d));
      if (day) {
        const targetDay = dayMap[day];
        const currentDay = now.getDay();
        let daysUntil = targetDay - currentDay;
        if (daysUntil <= 0) daysUntil += 7;
        startDate.setDate(startDate.getDate() + daysUntil);
        startDate.setHours(0, 0, 0, 0);
        endDate = new Date(startDate);
        endDate.setHours(23, 59, 59, 999);
      }
    }
    
    return events.filter(e => {
      const eventStart = new Date(e.start?.dateTime || e.start?.date);
      return eventStart >= startDate && eventStart <= endDate;
    });
  },
  
  // ==================== EXECUTION ====================
  
  /**
   * Execute the task with full agentic capabilities
   */
  async execute(task) {
    // ==================== DUPLICATE EXECUTION DETECTION ====================
    const taskKey = `${task.id}_${task.content?.slice(0, 50)}`;
    const now = Date.now();
    const lastExecution = _recentExecutions.get(taskKey);
    
    if (lastExecution && (now - lastExecution) < EXECUTION_DEDUP_WINDOW_MS) {
      console.warn(`[CalendarAgent] DUPLICATE EXECUTION DETECTED for task ${task.id}, skipping (${now - lastExecution}ms since last)`);
      return { success: true, message: "Already processing this request." };
    }
    _recentExecutions.set(taskKey, now);
    
    // Clean up old entries
    for (const [key, timestamp] of _recentExecutions) {
      if (now - timestamp > EXECUTION_DEDUP_WINDOW_MS * 5) {
        _recentExecutions.delete(key);
      }
    }
    
    console.log(`[CalendarAgent] Execute called for task ${task.id}: "${task.content?.slice(0, 50)}..."`);
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'calendar-agent.js:800',message:'Agent execute called',data:{taskContent:task.content?.slice(0,100)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'ALL'})}).catch(()=>{});
    // #endregion
    
    try {
      // Initialize memory and poller
      if (!this.memory) {
        await this.initialize();
      }
      
      const context = getTimeContext();
      
      // ==================== MULTI-TURN STATE HANDLING ====================
      // Check if this is a follow-up response to a previous needsInput
      const calendarState = task.context?.calendarState;
      if (calendarState) {
        console.log(`[CalendarAgent] Handling multi-turn state: ${calendarState}`);
        
        switch (calendarState) {
          case 'awaiting_delete_selection':
            return this._handleDeleteSelection(task);
          
          case 'awaiting_details_selection':
            return this._handleDetailsSelection(task);
          
          case 'awaiting_guest_emails':
            return this._handleGuestEmailsResponse(task);
          
          case 'awaiting_event_details':
            return this._handleEventDetailsResponse(task, context);
          
          case 'awaiting_time':
            return this._handleTimeResponse(task);
          
          case 'awaiting_timeframe':
            return this._handleTimeframeResponse(task);
          
          case 'awaiting_contact_name':
            return this._handleContactNameResponse(task);
          
          case 'awaiting_schedule_confirmation':
            return this._handleScheduleConfirmation(task);
          
          default:
            console.log(`[CalendarAgent] Unknown calendar state: ${calendarState}, processing as new request`);
        }
      }
      
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
    
    // Format events for LLM - separate past and future events clearly
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    
    // Separate past and future events
    const futureEvents = [];
    const pastEvents = [];
    
    events.forEach(e => {
      const start = new Date(e.start?.dateTime || e.start?.date);
      if (start >= startOfToday) {
        futureEvents.push(e);
      } else {
        pastEvents.push(e);
      }
    });
    
    // Sort future events by date
    futureEvents.sort((a, b) => {
      return new Date(a.start?.dateTime || a.start?.date) - new Date(b.start?.dateTime || b.start?.date);
    });
    
    console.log(`[CalendarAgent] Events: ${futureEvents.length} future, ${pastEvents.length} past (${events.length} total)`);
    
    // Format future events for LLM with full details
    const formatEvent = (e) => {
      const start = new Date(e.start?.dateTime || e.start?.date);
      const dayName = start.toLocaleDateString('en-US', { weekday: 'long' });
      const date = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const time = e.start?.dateTime 
        ? start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        : 'All day';
      
      let eventLine = `- ${dayName}, ${date} at ${time}: "${e.summary}"`;
      
      // Add attendees if present
      if (e.attendees && e.attendees.length > 0) {
        const attendeeNames = e.attendees.map(a => a.displayName || a.email?.split('@')[0] || 'Unknown').slice(0, 5);
        eventLine += ` [Attendees: ${attendeeNames.join(', ')}${e.attendees.length > 5 ? ` +${e.attendees.length - 5} more` : ''}]`;
      }
      
      // Add location if present
      if (e.location) {
        if (e.location.includes('http') || e.location.includes('meet.google') || e.location.includes('zoom')) {
          eventLine += ' [Video call]';
        } else {
          eventLine += ` [Location: ${e.location.slice(0, 50)}]`;
        }
      }
      
      // Add description snippet if present
      if (e.description) {
        const descSnippet = e.description.replace(/\n/g, ' ').slice(0, 80);
        eventLine += ` [Notes: ${descSnippet}${e.description.length > 80 ? '...' : ''}]`;
      }
      
      return eventLine;
    };
    
    const futureEventsText = futureEvents.map(formatEvent).join('\n');
    
    // Build the events section - only show future events
    let eventsSection;
    if (futureEvents.length > 0) {
      eventsSection = futureEventsText;
    } else if (pastEvents.length > 0) {
      eventsSection = `No upcoming events scheduled.\n(Note: Calendar has ${pastEvents.length} past events but no future events - the calendar data may need to be refreshed)`;
    } else {
      eventsSection = 'No events found in calendar';
    }
    
    const systemPrompt = `You are a helpful calendar assistant. Answer the user's question about their calendar OR help them create new events.

CURRENT DATE/TIME (USE THIS AS YOUR REFERENCE):
- TODAY is ${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
- Current time: ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
- Part of day: ${context.partOfDay}

UPCOMING CALENDAR EVENTS:
${eventsSection}

CRITICAL INSTRUCTIONS FOR QUERIES:
- ONLY refer to events listed above - do NOT make up or hallucinate events
- If there are no upcoming events listed, tell the user their calendar is clear
- When user asks about a day (e.g., "Tuesday"), look for that day in the events list
- Always use the FULL date with year when answering (e.g., "Tuesday, February 3, 2026")
- Answer the user's question directly and concisely
- Keep responses brief and conversational (1-3 sentences for simple queries)
- If the note mentions calendar data may need refreshing, you can mention this to the user
- Use natural language, not bullet points for voice responses

CRITICAL INSTRUCTIONS FOR EVENT CREATION:
- If the user wants to ADD, CREATE, SCHEDULE, or BOOK an event, respond with a special JSON format
- Extract: title, date (YYYY-MM-DD), time (HH:MM in 24-hour), duration (e.g., "30m", "1h"), location, description, guests
- For relative dates like "tomorrow" or "next Tuesday", calculate the actual date based on TODAY
- If missing required info (title, date, time), ask for clarification
- Default duration is 60m if not specified
- GUESTS: If the user mentions inviting people, extract NAMES or email addresses as a comma-delimited string
  - Names will be looked up in the contacts list (e.g., "John, Sarah" or "John Smith")
  - Email addresses can be used directly (e.g., "john@example.com")
  - Mix of both is fine (e.g., "John, sarah@example.com")
- Respond with JSON: {"action":"add_event","eventDetails":{"title":"...","date":"YYYY-MM-DD","time":"HH:MM","duration":"60m","location":"","description":"","guests":""}}

CRITICAL INSTRUCTIONS FOR EVENT DELETION:
- If the user wants to DELETE, CANCEL, REMOVE, or CLEAR an event, respond with a special JSON format
- Extract: searchText (event name/title to search for), date (YYYY-MM-DD if specified)
- Look at the UPCOMING CALENDAR EVENTS list to find matching events
- If you find a clear match, include the event details in your response
- For relative dates like "tomorrow", calculate the actual date based on TODAY
- Respond with JSON: {"action":"delete_event","deleteDetails":{"searchText":"...","date":"YYYY-MM-DD or null"}}
- If the request is too vague and matches multiple events, ask which one to delete

CRITICAL INSTRUCTIONS FOR EVENT DETAILS:
- If the user wants more information about an event (attendees, location, description), respond with a special JSON format
- Extract: searchText (event name/title), date if specified, and what info they want
- Respond with JSON: {"action":"event_details","detailsQuery":{"searchText":"...","date":"YYYY-MM-DD or null","infoRequested":"attendees|location|description|time|all"}}

If this is NOT an event creation, deletion, or details request, respond with normal text (not JSON)`;

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
      
      // Check if this is an event creation/deletion response (JSON format)
      if (answer.startsWith('{') && answer.includes('"action"')) {
        try {
          const parsed = JSON.parse(answer);
          if (parsed.action === 'add_event' && parsed.eventDetails) {
            console.log('[CalendarAgent] Detected event creation request:', parsed.eventDetails);
            return this._createEvent(parsed.eventDetails);
          }
          if (parsed.action === 'delete_event' && parsed.deleteDetails) {
            console.log('[CalendarAgent] Detected event deletion request:', parsed.deleteDetails);
            return this._deleteEvent(parsed.deleteDetails, futureEvents);
          }
          if (parsed.action === 'event_details' && parsed.detailsQuery) {
            console.log('[CalendarAgent] Detected event details request:', parsed.detailsQuery);
            return this._getEventDetails(parsed.detailsQuery, futureEvents);
          }
        } catch (parseErr) {
          // Not valid JSON, treat as normal response
          console.log('[CalendarAgent] Response looked like JSON but failed to parse:', parseErr.message);
        }
      }
      
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
      
      case 'add_event':
        // Handle event creation
        if (aiResult.eventDetails) {
          return this._createEvent(aiResult.eventDetails);
        }
        return {
          success: true,
          needsInput: {
            prompt: 'What would you like to call this event and when should I schedule it?',
            agentId: this.id,
            context: {
              calendarState: 'awaiting_event_details',
              originalRequest: 'add event'
            }
          }
        };
      
      case 'delete_event':
        // Handle event deletion
        if (aiResult.deleteDetails) {
          return this._deleteEvent(aiResult.deleteDetails, events);
        }
        return {
          success: true,
          needsInput: {
            prompt: 'Which event would you like me to delete?',
            agentId: this.id,
            context: {
              calendarState: 'awaiting_delete_details',
              originalRequest: 'delete event'
            }
          }
        };
      
      case 'event_details':
        // Handle event details query
        if (aiResult.detailsQuery) {
          return this._getEventDetails(aiResult.detailsQuery, events);
        }
        return {
          success: true,
          needsInput: {
            prompt: 'Which event would you like more details about?',
            agentId: this.id,
            context: {
              calendarState: 'awaiting_details_query',
              originalRequest: 'event details'
            }
          }
        };
      
      case 'find_availability':
        // Handle mutual availability check with a contact
        if (aiResult.availabilityQuery) {
          return this._handleFindAvailability(aiResult.availabilityQuery);
        }
        return {
          success: true,
          needsInput: {
            prompt: 'Who would you like to check availability with?',
            agentId: this.id,
            context: {
              calendarState: 'awaiting_contact_name',
              originalRequest: 'find availability'
            }
          }
        };
      
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
   * Handle event details clarification response
   */
  async _handleEventDetailsResponse(task, context) {
    const userResponse = task.context?.userInput || task.content;
    
    // Use AI to parse the event details from user's natural language response
    return this._askLLMAboutCalendar(
      `Add this to my calendar: ${userResponse}`,
      await this._fetchEvents(),
      context
    );
  },
  
  /**
   * Handle guest email clarification response
   */
  async _handleGuestEmailsResponse(task) {
    const userResponse = task.context?.userInput || task.content;
    const pendingEvent = task.context?.pendingEvent;
    const resolvedGuests = task.context?.resolvedGuests || [];
    const unresolvedNames = task.context?.unresolvedNames || [];
    
    if (!pendingEvent) {
      return { success: false, message: "I lost track of the event details. Please try again." };
    }
    
    // Parse the emails from user's response
    const newEmails = userResponse.split(',').map(e => e.trim()).filter(e => e.includes('@'));
    
    if (newEmails.length === 0) {
      return {
        success: true,
        needsInput: {
          prompt: `I need valid email addresses for ${unresolvedNames.join(', ')}. Please provide them.`,
          agentId: this.id,
          context: task.context
        }
      };
    }
    
    // Combine resolved guests with new emails
    const allGuests = [...resolvedGuests, ...newEmails];
    
    // Optionally learn new contacts
    if (newEmails.length === unresolvedNames.length && this.memory) {
      // Associate each unresolved name with its corresponding email
      for (let i = 0; i < unresolvedNames.length; i++) {
        const name = unresolvedNames[i];
        const email = newEmails[i];
        this._learnContact(name, email);
      }
    }
    
    // Create the event with all guests
    return this._createEvent({
      ...pendingEvent,
      guests: allGuests.join(',')
    });
  },
  
  /**
   * Handle delete event selection (when multiple events match)
   */
  async _handleDeleteSelection(task) {
    const userResponse = (task.context?.userInput || task.content).toLowerCase();
    const matches = task.context?.matches || [];
    
    if (matches.length === 0) {
      return { success: false, message: "I lost track of the events. Please try again." };
    }
    
    console.log(`[CalendarAgent] Handling delete selection: "${userResponse}" from ${matches.length} matches`);
    
    // Try to find a match based on user's response
    let selectedEvent = null;
    
    // Check for date references like "february 3rd", "the 3rd", "tuesday"
    const dateMatch = userResponse.match(/(?:february|feb|jan|january|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|october|oct|november|nov|december|dec)?\s*(\d+)(?:st|nd|rd|th)?/i);
    if (dateMatch) {
      const dayNum = parseInt(dateMatch[1]);
      // Find event on that day
      for (const match of matches) {
        // We need to fetch the full event to get the date
        const events = await this._fetchEvents();
        const fullEvent = events.find(e => e.id === match.id);
        if (fullEvent) {
          const eventDate = new Date(fullEvent.start?.dateTime || fullEvent.start?.date);
          if (eventDate.getDate() === dayNum) {
            selectedEvent = fullEvent;
            break;
          }
        }
      }
    }
    
    // Check for "first", "second", "1", "2", etc.
    if (!selectedEvent) {
      const positionMatch = userResponse.match(/\b(first|1|one|second|2|two|third|3|three|fourth|4|four|fifth|5|five)\b/i);
      if (positionMatch) {
        const positionMap = { 'first': 0, '1': 0, 'one': 0, 'second': 1, '2': 1, 'two': 1, 'third': 2, '3': 2, 'three': 2, 'fourth': 3, '4': 3, 'four': 3, 'fifth': 4, '5': 4, 'five': 4 };
        const idx = positionMap[positionMatch[1].toLowerCase()];
        if (idx !== undefined && idx < matches.length) {
          const events = await this._fetchEvents();
          selectedEvent = events.find(e => e.id === matches[idx].id);
        }
      }
    }
    
    // Check for title match
    if (!selectedEvent) {
      for (const match of matches) {
        if (userResponse.includes(match.summary.toLowerCase())) {
          const events = await this._fetchEvents();
          selectedEvent = events.find(e => e.id === match.id);
          break;
        }
      }
    }
    
    // If still no match and user said something affirmative with only one logical choice
    if (!selectedEvent && matches.length > 0) {
      // If response contains "that one" or "yes" and we're talking about a specific date, use first match
      if (userResponse.includes('that one') || userResponse.includes('yes') || userResponse.includes('the one')) {
        const events = await this._fetchEvents();
        selectedEvent = events.find(e => e.id === matches[0].id);
      }
    }
    
    if (!selectedEvent) {
      // Still couldn't determine - ask again
      const matchList = matches.slice(0, 5).map((m, i) => `${i + 1}. "${m.summary}"`).join(', ');
      return {
        success: true,
        needsInput: {
          prompt: `I'm not sure which one you mean. Please say the number: ${matchList}`,
          agentId: this.id,
          context: {
            calendarState: 'awaiting_delete_selection',
            matches: matches
          }
        }
      };
    }
    
    // Delete the selected event
    return this._deleteEvent({ eventId: selectedEvent.id }, null);
  },
  
  /**
   * Handle details selection (when multiple events match)
   */
  async _handleDetailsSelection(task) {
    const userResponse = (task.context?.userInput || task.content).toLowerCase();
    const matches = task.context?.matches || [];
    const infoRequested = task.context?.infoRequested || 'all';
    
    if (matches.length === 0) {
      return { success: false, message: "I lost track of the events. Please try again." };
    }
    
    // Similar logic to delete selection
    let selectedEvent = null;
    const events = await this._fetchEvents();
    
    // Check for position references
    const positionMatch = userResponse.match(/\b(first|1|one|second|2|two|third|3|three)\b/i);
    if (positionMatch) {
      const positionMap = { 'first': 0, '1': 0, 'one': 0, 'second': 1, '2': 1, 'two': 1, 'third': 2, '3': 2, 'three': 2 };
      const idx = positionMap[positionMatch[1].toLowerCase()];
      if (idx !== undefined && idx < matches.length) {
        selectedEvent = events.find(e => e.id === matches[idx].id);
      }
    }
    
    // Check for title match
    if (!selectedEvent) {
      for (const match of matches) {
        if (userResponse.includes(match.summary.toLowerCase())) {
          selectedEvent = events.find(e => e.id === match.id);
          break;
        }
      }
    }
    
    if (!selectedEvent && matches.length > 0) {
      selectedEvent = events.find(e => e.id === matches[0].id);
    }
    
    if (!selectedEvent) {
      return { success: false, message: "I couldn't find that event. Please try again." };
    }
    
    return this._getEventDetails({ eventId: selectedEvent.id, infoRequested }, events);
  },
  
  /**
   * Handle contact name response for availability check
   */
  async _handleContactNameResponse(task) {
    const userResponse = task.context?.userInput || task.content;
    const duration = task.context?.duration || 60;
    
    // Use the user's response as the contact name
    return this._handleFindAvailability({
      contactName: userResponse.trim(),
      date: null,
      duration: duration
    });
  },
  
  /**
   * Handle schedule confirmation response
   */
  async _handleScheduleConfirmation(task) {
    const userResponse = (task.context?.userInput || task.content).toLowerCase();
    const contactEmail = task.context?.contactEmail;
    const contactName = task.context?.contactName;
    const date = task.context?.date;
    const duration = task.context?.duration || 60;
    
    // Check if user confirmed
    if (userResponse.includes('yes') || userResponse.includes('sure') || userResponse.includes('ok') || userResponse.includes('schedule')) {
      // User wants to schedule - ask for time
      return {
        success: true,
        needsInput: {
          prompt: `What time would you like to schedule the meeting with ${contactName}?`,
          agentId: this.id,
          context: {
            calendarState: 'awaiting_event_details',
            pendingEvent: {
              title: `Meeting with ${contactName}`,
              date: date,
              duration: `${duration}m`,
              guests: contactEmail
            }
          }
        }
      };
    }
    
    return { success: true, message: "OK, I won't schedule anything." };
  },
  
  /**
   * Learn a new contact and save to memory
   */
  async _learnContact(name, email) {
    if (!this.memory) return;
    
    const entry = `- ${name}: ${email}`;
    const currentContacts = this.memory.getSection('Contacts') || '';
    
    // Check if contact already exists
    if (currentContacts.toLowerCase().includes(name.toLowerCase())) {
      return; // Already have this contact
    }
    
    // Remove placeholder text if present
    let updatedContacts = currentContacts;
    if (currentContacts.includes('*Add contacts here')) {
      updatedContacts = entry;
    } else {
      updatedContacts = currentContacts + '\n' + entry;
    }
    
    this.memory.updateSection('Contacts', updatedContacts);
    await this.memory.save();
    console.log(`[CalendarAgent] Learned new contact: ${name} -> ${email}`);
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
   * Fetch events from the omnical API, enriched with full details
   * @param {boolean} includeDetails - Whether to fetch full details for each event (default: true)
   */
  async _fetchEvents(includeDetails = true) {
    const now = Date.now();
    
    // Return cached events if still valid
    if (this._cache.events && (now - this._cache.fetchedAt) < CACHE_TTL_MS) {
      console.log('[CalendarAgent] Using cached events');
      return this._cache.events;
    }
    
    try {
      // Build date range (start of today to 2 weeks out)
      const startDate = new Date();
      startDate.setHours(0, 0, 0, 0);
      const endDate = new Date(startDate.getTime() + 14 * 24 * 60 * 60 * 1000);
      
      // Format dates as "Mon DD YYYY" for the timeInterpreter
      const formatDate = (d) => {
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return `${months[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`;
      };
      
      console.log(`[CalendarAgent] Fetching events from omnical API`);
      console.log(`[CalendarAgent] Date range: ${formatDate(startDate)} to ${formatDate(endDate)}`);
      
      // API requires POST with JSON body containing ALL fields (even empty ones)
      const requestBody = {
        method: '',
        startDate: formatDate(startDate),
        endDate: formatDate(endDate),
        startTime: '',
        endTime: '',
        searchText: '',
        timeZone: 'America/Los_Angeles'
      };
      
      const response = await fetch(OMNICAL_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });
      
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }
      
      const data = await response.json();
      
      // Handle "not found" response (empty calendar)
      if (data?.result === 'not found') {
        console.log('[CalendarAgent] No events found in calendar');
        this._cache.events = [];
        this._cache.fetchedAt = now;
        return [];
      }
      
      // Ensure we have an array
      let events = Array.isArray(data) ? data : [];
      
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'calendar-agent.js:1555',message:'List API response',data:{eventCount:events.length,firstEventKeys:events[0]?Object.keys(events[0]):[],firstEventHasAttendees:!!events[0]?.attendees},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'C'})}).catch(()=>{});
      // #endregion
      
      // Enrich events with full details (attendees, description, etc.)
      if (includeDetails && events.length > 0) {
        console.log(`[CalendarAgent] Fetching details for ${events.length} events...`);
        events = await this._enrichEventsWithDetails(events);
      }
      
      // Log first few event dates to debug
      if (events.length > 0) {
        const sample = events.slice(0, 3).map(e => {
          const d = e.start?.dateTime || e.start?.date;
          const attendeeCount = e.attendees?.length || 0;
          return `${e.summary?.slice(0, 20)}: ${d} (${attendeeCount} attendees)`;
        });
        console.log(`[CalendarAgent] Sample events returned:`, sample);
      }
      
      // Cache the enriched events
      this._cache.events = events;
      this._cache.fetchedAt = now;
      
      console.log(`[CalendarAgent] Fetched ${events.length} events with details`);
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
  
  /**
   * Fetch events from a specific calendar API URL (for checking contact availability)
   * @param {string} apiUrl - The calendar API URL for the contact
   * @param {string} startDate - Start date string (e.g., "Feb 3 2025")
   * @param {string} endDate - End date string (e.g., "Feb 3 2025")
   * @returns {Array} - List of events from the contact's calendar
   */
  async _fetchEventsFromUrl(apiUrl, startDate, endDate) {
    try {
      console.log(`[CalendarAgent] Fetching events from external calendar: ${apiUrl}`);
      console.log(`[CalendarAgent] Date range: ${startDate} to ${endDate}`);
      
      // API requires POST with JSON body containing ALL fields
      const requestBody = {
        method: '',
        startDate: startDate,
        endDate: endDate,
        startTime: '',
        endTime: '',
        searchText: '',
        timeZone: 'America/Los_Angeles'
      };
      
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });
      
      if (!response.ok) {
        throw new Error(`External calendar API error: ${response.status}`);
      }
      
      const data = await response.json();
      
      // Handle "not found" response (empty calendar)
      if (data?.result === 'not found') {
        console.log('[CalendarAgent] No events found in external calendar');
        return [];
      }
      
      // Ensure we have an array
      const events = Array.isArray(data) ? data : [];
      console.log(`[CalendarAgent] Fetched ${events.length} events from external calendar`);
      
      return events;
      
    } catch (error) {
      console.error('[CalendarAgent] Failed to fetch external calendar:', error);
      throw error;
    }
  },

  /**
   * Check a contact's calendar availability
   * @param {string} contactName - Name of the contact to check
   * @param {string} startDate - Start date string
   * @param {string} endDate - End date string
   * @returns {Object} - { events, calendarUrl } or { available: null, reason }
   */
  async _checkContactAvailability(contactName, startDate, endDate) {
    const contact = this._lookupContact(contactName);
    
    if (!contact) {
      return { available: null, reason: `I don't have ${contactName} in my contacts.` };
    }
    
    if (!contact.calendarUrl) {
      return { 
        available: null, 
        reason: `I don't have calendar access for ${contact.name}. I can still invite them by email (${contact.email}), but I can't check their availability.`,
        contact: contact
      };
    }
    
    try {
      const events = await this._fetchEventsFromUrl(contact.calendarUrl, startDate, endDate);
      return { events, calendarUrl: contact.calendarUrl, contact };
    } catch (error) {
      return { 
        available: null, 
        reason: `Failed to access ${contact.name}'s calendar: ${error.message}`,
        contact: contact
      };
    }
  },

  /**
   * Find mutual availability between user and a contact
   * @param {string} contactName - Name of the contact
   * @param {Date} date - The date to check
   * @param {number} duration - Meeting duration in minutes (default: 60)
   * @returns {Object} - { success, freeSlots, message }
   */
  async _findMutualAvailability(contactName, date, duration = 60) {
    // Format date for API
    const formatDate = (d) => {
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return `${months[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`;
    };
    
    const dateStr = formatDate(date);
    console.log(`[CalendarAgent] Finding mutual availability with ${contactName} on ${dateStr}`);
    
    // Check contact's calendar access
    const contactResult = await this._checkContactAvailability(contactName, dateStr, dateStr);
    if (contactResult.available === null) {
      return { success: false, message: contactResult.reason, contact: contactResult.contact };
    }
    
    // Get user's events for the day
    // We need to filter the cached events to just this date
    const userEvents = await this._fetchEvents();
    const dateStart = new Date(date);
    dateStart.setHours(0, 0, 0, 0);
    const dateEnd = new Date(date);
    dateEnd.setHours(23, 59, 59, 999);
    
    const userEventsOnDate = userEvents.filter(event => {
      const eventStart = new Date(event.start?.dateTime || event.start?.date);
      return eventStart >= dateStart && eventStart <= dateEnd;
    });
    
    console.log(`[CalendarAgent] User has ${userEventsOnDate.length} events, contact has ${contactResult.events.length} events on ${dateStr}`);
    
    // Find free slots
    const freeSlots = this._findOverlappingFreeSlots(userEventsOnDate, contactResult.events, date, duration);
    
    return { 
      success: true, 
      freeSlots, 
      contact: contactResult.contact,
      userEventCount: userEventsOnDate.length,
      contactEventCount: contactResult.events.length
    };
  },

  /**
   * Find overlapping free time slots between two calendars
   * @param {Array} userEvents - User's events for the day
   * @param {Array} contactEvents - Contact's events for the day
   * @param {Date} date - The date to check
   * @param {number} duration - Required meeting duration in minutes
   * @returns {Array} - List of free slots { start, end, formatted }
   */
  _findOverlappingFreeSlots(userEvents, contactEvents, date, duration) {
    // Working hours: 9 AM to 6 PM
    const workStart = 9 * 60; // Minutes from midnight
    const workEnd = 18 * 60;
    
    // Helper to convert time to minutes from midnight
    const toMinutes = (dateTime) => {
      const d = new Date(dateTime);
      return d.getHours() * 60 + d.getMinutes();
    };
    
    // Helper to format time
    const formatTime = (minutes) => {
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;
      const ampm = hours >= 12 ? 'PM' : 'AM';
      const hour12 = hours > 12 ? hours - 12 : (hours === 0 ? 12 : hours);
      return mins === 0 ? `${hour12}:00 ${ampm}` : `${hour12}:${mins.toString().padStart(2, '0')} ${ampm}`;
    };
    
    // Collect all busy periods from both calendars
    const busyPeriods = [];
    
    const addBusyPeriod = (event) => {
      if (!event.start?.dateTime) return; // Skip all-day events for now
      const start = toMinutes(event.start.dateTime);
      const end = event.end?.dateTime ? toMinutes(event.end.dateTime) : start + 60;
      busyPeriods.push({ start, end });
    };
    
    userEvents.forEach(addBusyPeriod);
    contactEvents.forEach(addBusyPeriod);
    
    // Sort by start time and merge overlapping periods
    busyPeriods.sort((a, b) => a.start - b.start);
    const mergedBusy = [];
    for (const period of busyPeriods) {
      if (mergedBusy.length === 0 || period.start > mergedBusy[mergedBusy.length - 1].end) {
        mergedBusy.push({ ...period });
      } else {
        mergedBusy[mergedBusy.length - 1].end = Math.max(mergedBusy[mergedBusy.length - 1].end, period.end);
      }
    }
    
    // Find free slots within working hours
    const freeSlots = [];
    let currentTime = workStart;
    
    for (const busy of mergedBusy) {
      // Skip busy periods outside working hours
      if (busy.end <= workStart) continue;
      if (busy.start >= workEnd) break;
      
      // Check if there's a gap before this busy period
      const gapEnd = Math.min(busy.start, workEnd);
      if (gapEnd - currentTime >= duration) {
        freeSlots.push({
          start: currentTime,
          end: gapEnd,
          formatted: `${formatTime(currentTime)} - ${formatTime(gapEnd)}`
        });
      }
      
      currentTime = Math.max(currentTime, busy.end);
    }
    
    // Check if there's time after the last busy period
    if (workEnd - currentTime >= duration) {
      freeSlots.push({
        start: currentTime,
        end: workEnd,
        formatted: `${formatTime(currentTime)} - ${formatTime(workEnd)}`
      });
    }
    
    console.log(`[CalendarAgent] Found ${freeSlots.length} mutual free slots of ${duration}+ minutes`);
    return freeSlots;
  },

  /**
   * Enrich events with full details from the details API
   * Fetches details in parallel for speed, with a concurrency limit
   * @param {Array} events - Basic event list
   * @returns {Array} - Events enriched with full details
   */
  async _enrichEventsWithDetails(events) {
    const CONCURRENCY_LIMIT = 5; // Fetch 5 at a time to avoid overwhelming the API
    const enrichedEvents = [];
    
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'calendar-agent.js:1583',message:'_enrichEventsWithDetails called',data:{eventCount:events.length,firstEventId:events[0]?.id},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'C'})}).catch(()=>{});
    // #endregion
    
    // Process events in batches
    for (let i = 0; i < events.length; i += CONCURRENCY_LIMIT) {
      const batch = events.slice(i, i + CONCURRENCY_LIMIT);
      
      const detailPromises = batch.map(async (event) => {
        try {
          const requestBody = {
            CalendarId: 'primary',
            eventId: event.id
          };
          
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'calendar-agent.js:1598',message:'Details API request',data:{eventId:event.id,requestBody},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
          // #endregion
          
          const response = await fetch(OMNICAL_DETAILS_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
          });
          
          if (response.ok) {
            const details = await response.json();
            
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'calendar-agent.js:1612',message:'Details API response',data:{eventId:event.id,responseKeys:Object.keys(details),hasEventProp:!!details.event,hasAttendees:!!details.attendees,rawResponseSample:JSON.stringify(details).slice(0,500)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
            // #endregion
            
            // Check if response has nested 'event' property
            const eventData = details.event || details;
            
            // Merge details with the basic event, preferring details
            const merged = { ...event, ...eventData };
            
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'calendar-agent.js:1622',message:'Event merged',data:{eventId:event.id,hasAttendeesAfterMerge:!!merged.attendees,attendeeCount:merged.attendees?.length||0},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'C'})}).catch(()=>{});
            // #endregion
            
            return merged;
          }
          
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'calendar-agent.js:1630',message:'Details API failed',data:{eventId:event.id,status:response.status},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
          // #endregion
          
          // If details fetch fails, return the basic event
          return event;
        } catch (err) {
          console.warn(`[CalendarAgent] Failed to fetch details for event ${event.id}:`, err.message);
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'calendar-agent.js:1640',message:'Details API error',data:{eventId:event.id,error:err.message},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
          // #endregion
          return event;
        }
      });
      
      const batchResults = await Promise.all(detailPromises);
      enrichedEvents.push(...batchResults);
    }
    
    return enrichedEvents;
  },
  
  /**
   * Create a new calendar event via the Omni Calendar Add Event API
   * 
   * @param {Object} eventDetails - Event details
   * @param {string} eventDetails.title - Event title/summary (required)
   * @param {string} eventDetails.date - Date in YYYY-MM-DD format (required)
   * @param {string} eventDetails.time - Time in HH:MM 24-hour format (required)
   * @param {string} eventDetails.duration - Duration like "30m", "1h", "90m" (default: "60m")
   * @param {string} eventDetails.location - Optional location
   * @param {string} eventDetails.description - Optional description
   * @returns {Promise<Object>} - { success, message, event? }
   */
  async _createEvent(eventDetails) {
    try {
      const { title, date, time, duration = '60m', location = '', description = '', guests = '' } = eventDetails;
      
      // Validate required fields
      if (!title || !date || !time) {
        return {
          success: false,
          message: "I need the event title, date, and time to create a calendar event."
        };
      }
      
      // Resolve guests - look up names in contacts, pass through emails
      let guestList = [];
      if (guests) {
        const { resolved, unresolved } = this._resolveGuests(guests);
        
        // If there are unresolved names, ask for their emails
        if (unresolved.length > 0) {
          const nameList = unresolved.join(', ');
          return {
            success: true,
            needsInput: {
              prompt: `I don't have email addresses for: ${nameList}. Please provide their email${unresolved.length > 1 ? 's' : ''} (comma-separated if multiple).`,
              agentId: this.id,
              context: {
                calendarState: 'awaiting_guest_emails',
                pendingEvent: { title, date, time, duration, location, description },
                resolvedGuests: resolved,
                unresolvedNames: unresolved
              }
            }
          };
        }
        
        guestList = resolved;
      }
      
      // Build request body matching the API spec
      const requestBody = {
        title,
        description,
        startDate: date,
        startTime: time,
        eventDuration: duration,
        location,
        guests: guestList,
        timeZone: 'America/Los_Angeles'
      };
      
      console.log('[CalendarAgent] Creating event:', requestBody);
      
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'calendar-agent.js:1700',message:'Create event API request',data:{requestBody,guestListType:Array.isArray(guestList)?'array':'other',guestCount:guestList.length},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'D'})}).catch(()=>{});
      // #endregion
      
      const response = await fetch(OMNICAL_ADD_EVENT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error('[CalendarAgent] Create event API error:', response.status, errorText);
        
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'calendar-agent.js:1717',message:'Create event API failed',data:{status:response.status,errorText},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'E'})}).catch(()=>{});
        // #endregion
        
        if (response.status === 500) {
          return {
            success: false,
            message: `Failed to create event: ${errorText || 'Server error'}`
          };
        }
        if (response.status === 404) {
          return {
            success: false,
            message: "Calendar service not found. Please check API configuration."
          };
        }
        
        throw new Error(`API error: ${response.status}`);
      }
      
      const createdEvent = await response.json();
      console.log('[CalendarAgent] Event created:', createdEvent);
      
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'calendar-agent.js:1740',message:'Create event API success',data:{responseKeys:Object.keys(createdEvent||{}),hasId:!!createdEvent?.id,responseSample:JSON.stringify(createdEvent).slice(0,500)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'E'})}).catch(()=>{});
      // #endregion
      
      // Invalidate cache so next fetch gets the new event
      this._cache.events = null;
      this._cache.fetchedAt = 0;
      
      // Format confirmation message
      const eventDate = new Date(`${date}T${time}`);
      const formattedDate = eventDate.toLocaleDateString('en-US', { 
        weekday: 'long', 
        month: 'long', 
        day: 'numeric' 
      });
      const formattedTime = eventDate.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit' 
      });
      
      let message = `Done! I've added "${title}" to your calendar for ${formattedDate} at ${formattedTime}`;
      if (duration !== '60m') {
        message += ` (${duration})`;
      }
      if (location) {
        message += ` at ${location}`;
      }
      if (guestList.length > 0) {
        message += `. Invitations sent to ${guestList.length} guest${guestList.length > 1 ? 's' : ''}`;
      }
      message += '.';
      
      return {
        success: true,
        message,
        event: createdEvent
      };
      
    } catch (error) {
      console.error('[CalendarAgent] Failed to create event:', error);
      return {
        success: false,
        message: "Sorry, I couldn't create that event. Please try again."
      };
    }
  },
  
  /**
   * Delete a calendar event via the Omni Calendar Delete API
   * 
   * API: POST /omnicaldelete
   * Body: { calendarId: string, eventId: string }
   * Response: 200 with boolean true, 404 with {"result":"not found"}, 500 with error string
   * 
   * @param {Object} deleteDetails - Details to identify the event
   * @param {string} deleteDetails.searchText - Event title or partial match
   * @param {string} deleteDetails.date - Optional date to narrow search (YYYY-MM-DD)
   * @param {string} deleteDetails.eventId - Optional direct event ID
   * @param {string} deleteDetails.calendarId - Optional calendar ID (defaults to "primary")
   * @param {Array} events - Current cached events for matching
   * @returns {Promise<Object>} - { success, message }
   */
  async _deleteEvent(deleteDetails, events = null) {
    try {
      const { searchText, date, eventId, calendarId = 'primary' } = deleteDetails;
      
      // If we have a direct eventId, use it
      let targetEventId = eventId;
      let targetEvent = null;
      
      // Otherwise, search for matching event
      if (!targetEventId && searchText) {
        // Fetch events if not provided
        if (!events) {
          events = await this._fetchEvents();
        }
        
        if (!events || events.length === 0) {
          return {
            success: false,
            message: "You don't have any events to delete."
          };
        }
        
        const searchLower = searchText.toLowerCase();
        
        // Filter by date if provided
        let candidateEvents = events;
        if (date) {
          const targetDate = new Date(date);
          candidateEvents = events.filter(e => {
            const eventDate = new Date(e.start?.dateTime || e.start?.date);
            return eventDate.toDateString() === targetDate.toDateString();
          });
        }
        
        // Search for matching event by title
        const matches = candidateEvents.filter(e => {
          const title = (e.summary || '').toLowerCase();
          return title.includes(searchLower) || searchLower.includes(title);
        });
        
        if (matches.length === 0) {
          return {
            success: false,
            message: `I couldn't find an event matching "${searchText}".`
          };
        }
        
        if (matches.length > 1) {
          // Multiple matches - ask for clarification
          const matchList = matches.slice(0, 5).map(e => {
            const start = new Date(e.start?.dateTime || e.start?.date);
            const day = start.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
            const time = e.start?.dateTime 
              ? start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
              : 'all day';
            return `"${e.summary}" on ${day} at ${time}`;
          }).join(', ');
          
          return {
            success: true,
            needsInput: {
              prompt: `I found multiple events: ${matchList}. Which one would you like me to delete?`,
              agentId: this.id,
              context: {
                calendarState: 'awaiting_delete_selection',
                matches: matches.map(e => ({ id: e.id, summary: e.summary })),
                originalSearch: searchText
              }
            }
          };
        }
        
        targetEvent = matches[0];
        targetEventId = targetEvent.id;
      }
      
      if (!targetEventId) {
        return {
          success: false,
          message: "I need to know which event to delete. Please specify the event name or date."
        };
      }
      
      console.log('[CalendarAgent] Deleting event:', targetEventId, 'from calendar:', calendarId);
      
      const deleteRequestBody = {
        calendarId: calendarId,
        eventId: targetEventId
      };
      
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'calendar-agent.js:1878',message:'Delete API request',data:{requestBody:deleteRequestBody,url:OMNICAL_DELETE_EVENT_URL},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A'})}).catch(()=>{});
      // #endregion
      
      // Call the delete API - requires both calendarId and eventId
      const response = await fetch(OMNICAL_DELETE_EVENT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(deleteRequestBody)
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error('[CalendarAgent] Delete event API error:', response.status, errorText);
        
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'calendar-agent.js:1895',message:'Delete API failed',data:{status:response.status,errorText},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A'})}).catch(()=>{});
        // #endregion
        
        if (response.status === 500) {
          return {
            success: false,
            message: `Failed to delete event: ${errorText || 'Server error'}`
          };
        }
        if (response.status === 404) {
          // API returns {"result":"not found"} for 404
          return {
            success: false,
            message: "That event wasn't found. It may have already been deleted."
          };
        }
        
        throw new Error(`API error: ${response.status}`);
      }
      
      // Success response is boolean true
      const result = await response.json();
      console.log('[CalendarAgent] Event deleted successfully, result:', result);
      
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'calendar-agent.js:1920',message:'Delete API success',data:{result,resultType:typeof result},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A'})}).catch(()=>{});
      // #endregion
      
      // Invalidate cache
      this._cache.events = null;
      this._cache.fetchedAt = 0;
      
      // Format confirmation message
      const eventName = targetEvent?.summary || 'The event';
      let message = `Done! I've deleted "${eventName}" from your calendar.`;
      
      return {
        success: true,
        message
      };
      
    } catch (error) {
      console.error('[CalendarAgent] Failed to delete event:', error);
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'calendar-agent.js:1940',message:'Delete API exception',data:{error:error.message},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A'})}).catch(()=>{});
      // #endregion
      return {
        success: false,
        message: "Sorry, I couldn't delete that event. Please try again."
      };
    }
  },
  
  /**
   * Get detailed information about a calendar event via the Omni Calendar Details API
   * 
   * API: POST /omnical_details
   * Body: { CalendarId: string, eventId: string }
   * Response: 200 with event object
   * 
   * @param {Object} detailsQuery - Query to identify the event
   * @param {string} detailsQuery.searchText - Event title or partial match
   * @param {string} detailsQuery.date - Optional date to narrow search (YYYY-MM-DD)
   * @param {string} detailsQuery.eventId - Optional direct event ID
   * @param {string} detailsQuery.calendarId - Optional calendar ID (defaults to "primary")
   * @param {string} detailsQuery.infoRequested - What info to return: 'attendees', 'location', 'description', 'time', 'all'
   * @param {Array} events - Current cached events for matching
   * @returns {Promise<Object>} - { success, message }
   */
  async _getEventDetails(detailsQuery, events = null) {
    try {
      const { searchText, date, eventId, calendarId = 'primary', infoRequested = 'all' } = detailsQuery;
      
      let targetEventId = eventId;
      let targetEvent = null;
      
      // Search for matching event if no direct ID
      if (!targetEventId && searchText) {
        if (!events) {
          events = await this._fetchEvents();
        }
        
        if (!events || events.length === 0) {
          return {
            success: false,
            message: "You don't have any events to look up."
          };
        }
        
        const searchLower = searchText.toLowerCase();
        
        // Filter by date if provided
        let candidateEvents = events;
        if (date) {
          const targetDate = new Date(date);
          candidateEvents = events.filter(e => {
            const eventDate = new Date(e.start?.dateTime || e.start?.date);
            return eventDate.toDateString() === targetDate.toDateString();
          });
        }
        
        // Search for matching event by title
        const matches = candidateEvents.filter(e => {
          const title = (e.summary || '').toLowerCase();
          return title.includes(searchLower) || searchLower.includes(title);
        });
        
        if (matches.length === 0) {
          return {
            success: false,
            message: `I couldn't find an event matching "${searchText}".`
          };
        }
        
        if (matches.length > 1) {
          const matchList = matches.slice(0, 5).map(e => {
            const start = new Date(e.start?.dateTime || e.start?.date);
            const day = start.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
            const time = e.start?.dateTime 
              ? start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
              : 'all day';
            return `"${e.summary}" on ${day} at ${time}`;
          }).join(', ');
          
          return {
            success: true,
            needsInput: {
              prompt: `I found multiple events: ${matchList}. Which one would you like details about?`,
              agentId: this.id,
              context: {
                calendarState: 'awaiting_details_selection',
                matches: matches.map(e => ({ id: e.id, summary: e.summary })),
                originalSearch: searchText,
                infoRequested
              }
            }
          };
        }
        
        targetEvent = matches[0];
        targetEventId = targetEvent.id;
      }
      
      if (!targetEventId) {
        return {
          success: false,
          message: "I need to know which event you want details about."
        };
      }
      
      console.log('[CalendarAgent] Getting details for event:', targetEventId);
      
      const detailsRequestBody = {
        CalendarId: calendarId,
        eventId: targetEventId
      };
      
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'calendar-agent.js:2050',message:'GetDetails API request',data:{requestBody:detailsRequestBody},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
      // #endregion
      
      // Call the details API
      const response = await fetch(OMNICAL_DETAILS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(detailsRequestBody)
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error('[CalendarAgent] Get details API error:', response.status, errorText);
        
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'calendar-agent.js:2070',message:'GetDetails API failed',data:{status:response.status,errorText},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
        // #endregion
        
        if (response.status === 404) {
          return {
            success: false,
            message: "That event wasn't found."
          };
        }
        
        throw new Error(`API error: ${response.status}`);
      }
      
      const eventDetails = await response.json();
      console.log('[CalendarAgent] Event details retrieved:', eventDetails);
      
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'calendar-agent.js:2088',message:'GetDetails API success',data:{responseKeys:Object.keys(eventDetails||{}),hasEventProp:!!eventDetails?.event,hasAttendees:!!eventDetails?.attendees,responseSample:JSON.stringify(eventDetails).slice(0,500)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
      // #endregion
      
      // Format response based on what info was requested
      return this._formatEventDetails(eventDetails, infoRequested);
      
    } catch (error) {
      console.error('[CalendarAgent] Failed to get event details:', error);
      return {
        success: false,
        message: "Sorry, I couldn't get the event details. Please try again."
      };
    }
  },
  
  /**
   * Format event details for the response
   */
  _formatEventDetails(event, infoRequested) {
    const title = event.summary || 'Untitled event';
    const parts = [];
    
    // Time info
    if (infoRequested === 'all' || infoRequested === 'time') {
      const start = new Date(event.start?.dateTime || event.start?.date);
      const end = new Date(event.end?.dateTime || event.end?.date);
      const dayName = start.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
      
      if (event.start?.dateTime) {
        const startTime = start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        const endTime = end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        parts.push(`scheduled for ${dayName} from ${startTime} to ${endTime}`);
      } else {
        parts.push(`an all-day event on ${dayName}`);
      }
    }
    
    // Location
    if (infoRequested === 'all' || infoRequested === 'location') {
      if (event.location) {
        if (event.location.includes('http')) {
          parts.push('it\'s a video call');
        } else {
          parts.push(`located at ${event.location}`);
        }
      } else if (infoRequested === 'location') {
        parts.push('no location specified');
      }
    }
    
    // Attendees
    if (infoRequested === 'all' || infoRequested === 'attendees') {
      if (event.attendees && event.attendees.length > 0) {
        const attendeeNames = event.attendees.map(a => {
          if (a.displayName) return a.displayName;
          if (a.email) return a.email.split('@')[0];
          return 'Unknown';
        });
        
        if (attendeeNames.length === 1) {
          parts.push(`${attendeeNames[0]} is attending`);
        } else if (attendeeNames.length <= 3) {
          parts.push(`attendees: ${attendeeNames.join(', ')}`);
        } else {
          parts.push(`${attendeeNames.length} attendees including ${attendeeNames.slice(0, 2).join(', ')}`);
        }
      } else if (infoRequested === 'attendees') {
        parts.push('no attendees listed');
      }
    }
    
    // Description
    if (infoRequested === 'all' || infoRequested === 'description') {
      if (event.description) {
        // Truncate long descriptions
        const desc = event.description.length > 200 
          ? event.description.slice(0, 200) + '...'
          : event.description;
        parts.push(`description: "${desc}"`);
      } else if (infoRequested === 'description') {
        parts.push('no description');
      }
    }
    
    // Build the message
    let message;
    if (parts.length === 0) {
      message = `"${title}" - that's all the information I have.`;
    } else if (infoRequested === 'all') {
      message = `"${title}" is ${parts.join('. ')}.`;
    } else {
      message = `For "${title}": ${parts.join('. ')}.`;
    }
    
    return {
      success: true,
      message,
      eventDetails: event
    };
  },
  
  /**
   * Handle finding mutual availability with a contact
   * @param {Object} availabilityQuery - { contactName, date, duration }
   * @returns {Object} - { success, message }
   */
  async _handleFindAvailability(availabilityQuery) {
    try {
      const { contactName, date, duration = 60 } = availabilityQuery;
      
      if (!contactName) {
        return {
          success: true,
          needsInput: {
            prompt: 'Who would you like to check availability with?',
            agentId: this.id,
            context: {
              calendarState: 'awaiting_contact_name',
              duration
            }
          }
        };
      }
      
      // Parse date - default to today if not specified
      let targetDate;
      if (date) {
        targetDate = new Date(date);
      } else {
        targetDate = new Date();
      }
      
      console.log(`[CalendarAgent] Finding availability with ${contactName} on ${targetDate.toDateString()}`);
      
      // Find mutual availability
      const result = await this._findMutualAvailability(contactName, targetDate, duration);
      
      if (!result.success) {
        // If contact doesn't have calendar access, offer to invite them anyway
        if (result.contact) {
          return {
            success: true,
            message: result.message,
            needsInput: {
              prompt: `Would you like me to schedule a meeting and invite ${result.contact.name} anyway?`,
              agentId: this.id,
              context: {
                calendarState: 'awaiting_schedule_confirmation',
                contactEmail: result.contact.email,
                contactName: result.contact.name,
                date: targetDate.toISOString().split('T')[0],
                duration
              }
            }
          };
        }
        return { success: false, message: result.message };
      }
      
      // Format the free slots nicely
      if (result.freeSlots.length === 0) {
        const dayName = targetDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
        return {
          success: true,
          message: `Unfortunately, you and ${result.contact.name} don't have any overlapping free time on ${dayName} (during working hours 9 AM - 6 PM). You have ${result.userEventCount} meetings and they have ${result.contactEventCount}. Would you like me to check another day?`
        };
      }
      
      const dayName = targetDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
      const slotList = result.freeSlots.map(slot => slot.formatted).join(', ');
      
      let message;
      if (result.freeSlots.length === 1) {
        message = `You and ${result.contact.name} are both free on ${dayName} at ${slotList}. Would you like me to schedule a meeting?`;
      } else {
        message = `You and ${result.contact.name} are both free on ${dayName} at these times: ${slotList}. Which time works for you?`;
      }
      
      return {
        success: true,
        message,
        freeSlots: result.freeSlots,
        contact: result.contact
      };
      
    } catch (error) {
      console.error('[CalendarAgent] Failed to find availability:', error);
      return {
        success: false,
        message: `Sorry, I had trouble checking availability: ${error.message}`
      };
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
