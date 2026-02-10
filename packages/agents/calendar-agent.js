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
const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();
const { renderAgentUI } = require('../../lib/agent-ui-renderer');

// Local calendar store: persistent events, recurring, conflicts, briefs
const { getCalendarStore } = require('../../lib/calendar-store');

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
    'Create recurring events (daily, weekly, biweekly, monthly, yearly, weekdays)',
    'Delete/cancel/remove calendar events: "cancel the standup", "delete my 3pm meeting", "remove the team sync"',
    'Skip or modify a single occurrence of a recurring event',
    'Get detailed event information (attendees, description, location, etc.)',
    'Resolve calendar conflicts for a time period (cancel, move, or skip overlapping events)',
    'Morning brief: time, date, weather, full day rundown with conflicts, back-to-back, free time, recurring vs one-off',
    'Find free time slots within working hours',
    'Suggest alternative meeting times when there are conflicts',
    'Week overview with busiest day, free days, total meeting count',
    'Tomorrow preview and end-of-day lookahead',
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
 * AI-driven calendar query understanding
 * Takes a raw user request and uses LLM to understand what they want
 * 
 * @param {string} userRequest - Raw user request text
 * @param {Object} context - { partOfDay, memory, events, conversationHistory }
 * @returns {Promise<Object>} - { action, timeframe, specificTime, needsClarification, clarificationPrompt, message }
 */
async function aiUnderstandCalendarRequest(userRequest, context) {
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
  "action": "today" | "tomorrow" | "week" | "next_meeting" | "availability" | "time_period" | "specific_day" | "add_event" | "add_recurring" | "delete_event" | "event_details" | "find_availability" | "morning_brief" | "find_free_slots" | "week_summary" | "resolve_conflicts" | "clarify",
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
    "guests": "comma-delimited email addresses (e.g. 'john@example.com,sarah@example.com')",
    "recurring": {
      "pattern": "daily | weekdays | weekly | biweekly | monthly | yearly",
      "daysOfWeek": [1],
      "endDate": "YYYY-MM-DD or null for forever",
      "endAfter": "number of occurrences or null"
    }
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

EXAMPLES - RECURRING EVENTS (NO CLARIFICATION NEEDED):
- "standup every weekday at 9am" → action: "add_recurring", eventDetails: {title: "standup", time: "09:00", duration: "15m", recurring: {pattern: "weekdays"}}
- "set up a weekly sync every Monday at 2pm" → action: "add_recurring", eventDetails: {title: "weekly sync", time: "14:00", duration: "60m", recurring: {pattern: "weekly", daysOfWeek: [1]}}
- "schedule biweekly 1:1 with John every other Tuesday" → action: "add_recurring", eventDetails: {title: "1:1 with John", time: null, duration: "30m", recurring: {pattern: "biweekly", daysOfWeek: [2]}, guests: "John"}, needsClarification: true if no time given
- "monthly team review on the 15th at 3pm" → action: "add_recurring", eventDetails: {title: "team review", time: "15:00", duration: "60m", recurring: {pattern: "monthly", dayOfMonth: 15}}
- "daily check-in at 8:30am" → action: "add_recurring", eventDetails: {title: "daily check-in", time: "08:30", duration: "15m", recurring: {pattern: "daily"}}

EXAMPLES - MORNING BRIEF (NO CLARIFICATION NEEDED):
- "give me my morning brief" → action: "morning_brief"
- "what does my day look like" → action: "morning_brief"
- "run me through today" → action: "morning_brief"
- "daily rundown" → action: "morning_brief"
- "brief me on today" → action: "morning_brief"
- "how's my day" → action: "morning_brief"

EXAMPLES - FREE TIME / SMART SCHEDULING:
- "when am I free today" → action: "find_free_slots", timeframe: "today"
- "find me an open slot this week" → action: "find_free_slots", timeframe: "this_week"
- "suggest a time for a 1 hour meeting tomorrow" → action: "find_free_slots", timeframe: "tomorrow", specificTime: null, eventDetails: {duration: "60m"}
- "what's my week look like" → action: "week_summary"
- "week overview" → action: "week_summary"
- "busiest day this week" → action: "week_summary"

EXAMPLES - CONFLICT RESOLUTION:
- "any conflicts today" → action: "resolve_conflicts", timeframe: "today"
- "check for overlapping meetings this week" → action: "resolve_conflicts", timeframe: "this_week"
- "resolve my scheduling conflicts" → action: "resolve_conflicts", timeframe: "today"

EXAMPLES - CLARIFICATION NEEDED:
- "check my calendar" (no time at all) → needsClarification: true
- "am I free" (no time specified) → needsClarification: true
- "add a meeting" (no title, date, or time) → needsClarification: true, clarificationPrompt: "What would you like to call this event and when should I schedule it?"
- "delete my meeting" (too vague, multiple possible matches) → needsClarification: true, clarificationPrompt: "Which meeting would you like me to delete?"`;

  const userPrompt = `User request: "${userRequest}"

What calendar information does the user want?`;

  try {
    const result = await calendarCircuit.execute(async () => {
      return await ai.chat({
        profile: 'powerful',
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        thinking: true,
        maxTokens: 16000,
        jsonMode: true,
        feature: 'calendar-agent'
      });
    });
    
    const parsed = JSON.parse(result.content);
    log.info('agent', 'AI understood request', { reasoning: parsed.reasoning });
    
    return parsed;
    
  } catch (error) {
    log.warn('agent', 'AI understanding failed', { error: error.message });
    return null;
  }
}

// Track recent task executions to detect duplicates
const _recentExecutions = new Map(); // normalizedContent -> timestamp
const EXECUTION_DEDUP_WINDOW_MS = 5000; // Ignore duplicate within 5 seconds

const calendarAgent = {
  id: 'calendar-agent',
  name: 'Calendar Agent',
  description: 'Answers calendar and meeting questions - shows your schedule, checks availability, creates and deletes events, and provides proactive reminders',
  voice: 'coral',  // Professional, clear - see VOICE-GUIDE.md
  acks: ["Let me check your calendar.", "Checking your schedule.", "Looking at your calendar."],
  categories: ['system', 'calendar'],
  keywords: [
    'calendar', 'meeting', 'meetings', 'schedule', 'event', 'events', 
    'appointment', 'busy', 'free', 'available', 'availability',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'today', 'tomorrow', 'happening', 'going on', 'scheduled', 'planned',
    'add', 'create', 'book', 'set up', 'schedule a', 'put on', 'block', 'reserve',
    'recurring', 'every week', 'every day', 'weekly', 'daily', 'biweekly', 'monthly',
    'delete', 'cancel', 'remove', 'clear', 'drop', 'get rid of',
    'details', 'attendees', 'who is', 'where is', 'more info', 'tell me about',
    'brief', 'morning brief', 'rundown', 'day look like', 'week look like',
    'conflict', 'overlap', 'double book', 'free slot', 'open slot',
  ],
  executionType: 'action',  // Needs calendar API for data
  estimatedExecutionMs: 4000,
  dataSources: ['calendar-store', 'system-clock'],
  
  /**
   * Briefing contribution: today's schedule, conflicts, free time.
   * Priority 3 = appears after weather in the daily brief.
   */
  async getBriefing() {
    try {
      const store = this._calStore || getCalendarStore();
      const now = new Date();
      const brief = store.generateMorningBrief(now, []);
      const calendarSpeech = store.renderBriefForSpeech(brief);
      // Strip the store's own greeting (we compose our own)
      const calendarBody = calendarSpeech
        .replace(/^Good (morning|afternoon|evening)\.\s*Here'?s?\s*(your day|the rest of your day|a look at your schedule)\.?\s*/i, '')
        .trim();
      return {
        section: 'Calendar',
        priority: 3,
        content: calendarBody || 'Your calendar is clear today. No meetings scheduled.',
        data: brief,  // Structured data for the composer
      };
    } catch (e) {
      return { section: 'Calendar', priority: 3, content: 'Calendar data unavailable.' };
    }
  },
  
  // Prompt for LLM evaluation
  prompt: `Calendar Agent handles ALL calendar, meeting, and scheduling requests.

HIGH CONFIDENCE (0.85+) for:
- Calendar queries: "what's on my calendar", "check my schedule"
- Meeting queries: "when is my next meeting", "do I have meetings today"
- Availability: "am I free", "am I busy", "available at 3pm", "find free time"
- Time periods: "this morning", "this afternoon", "tomorrow", "this week"
- Day-specific: "what's happening Monday", "anything on Tuesday", "what do I have Friday"
- Generic schedule: "what's happening", "what's going on", "anything scheduled", "what do I have"
- Event creation: "add a meeting", "schedule an appointment", "create an event", "book time", "put X on my calendar"
- Recurring events: "standup every Monday at 9am", "set up a weekly sync", "schedule daily standup", "recurring meeting every Friday"
- Event deletion: "delete the meeting", "cancel my appointment", "remove the event", "clear my calendar"
- Event details: "tell me more about the meeting", "who's attending", "where is the meeting"
- Conflict resolution: "any conflicts today", "resolve scheduling conflicts", "overlapping meetings"
- Free time: "when am I free", "find me an open slot", "suggest a time for a meeting"
- Week overview: "how's my week looking", "week summary", "busiest day this week"

CRITICAL PATTERNS THIS AGENT HANDLES:
- "What's happening [day name]?" e.g. "What's happening Monday?"
- "What's going on [time]?" e.g. "What's going on tomorrow?"
- "Anything on [day]?" e.g. "Anything on Friday?"
- Questions about any specific day of the week (Monday through Sunday)
- Questions about today, tomorrow, this week, this morning, this afternoon
- "Add [event] to my calendar", "Schedule [meeting] for [time]", "Create an event for [date]"
- "Set up a [recurring] meeting every [day/week/month]"
- "Am I free at [time]", "Find me a free slot on [day]"
- DELETE/CANCEL: "cancel the standup", "delete my 3pm meeting", "remove the team sync", "cancel the test meeting", "get rid of the appointment"

IMPORTANT -- "cancel" + event noun = CALENDAR DELETE (0.90+):
When a user says "cancel the [meeting/event/appointment/standup/sync/call]", they want to DELETE that event from their calendar. This is NOT a system cancel command. "cancel" followed by a noun phrase referring to a meeting or event is ALWAYS a calendar operation. Similarly "delete the X", "remove the X", "get rid of the X".

Day names (Monday-Sunday), schedule, brief, recurring, free/busy, conflict are strong calendar signals.

LOW CONFIDENCE (0.00) -- do NOT bid on:
- Daily brief / morning brief / daily rundown / "brief me": "give me my daily brief" -> daily-brief-agent
- Current date/time only (no events): "what day is it" -> time agent
- Weather: "what's the weather" -> weather agent
- General knowledge: "who invented the calendar" -> search agent

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
      log.info('agent', 'Initialize already in progress, waiting...');
      while (this._initializing) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return this.memory;
    }
    
    // Guard against re-initialization when already initialized
    if (this.memory && this._pollerInterval) {
      log.info('agent', 'Already initialized, skipping');
      return this.memory;
    }
    
    this._initializing = true;
    log.info('agent', 'Initializing...');
    
    try {
      if (!this.memory) {
        this.memory = getAgentMemory('calendar-agent', { displayName: 'Calendar Agent' });
        await this.memory.load();
        this._ensureMemorySections();
        log.info('agent', 'Memory loaded');
      }
      
      // Clear cache on initialize to force fresh data fetch
      this._cache.events = null;
      this._cache.fetchedAt = 0;
      
      // Initialize local calendar store (persistent events, recurring, briefs)
      this._calStore = getCalendarStore();
      
      // Start meeting poller for proactive reminders
      this._startMeetingPoller();
      
      // Start morning brief scheduler
      this._calStore.startBriefScheduler((speechText, briefData) => {
        log.info('agent', 'Morning brief ready', { eventCount: briefData.summary.totalEvents });
        try {
          const { getVoiceSpeaker } = require('../../voice-speaker');
          const speaker = getVoiceSpeaker();
          if (speaker) {
            speaker.speak(speechText, { voice: this.voice || 'coral' });
          }
        } catch (_) {}
      });
      
      log.info('agent', 'Initialization complete (with CalendarStore)');
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
    
    log.info('agent', 'Starting meeting poller (every 5 minutes)');
    
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
      log.info('agent', 'Meeting poller stopped');
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
        log.warn('agent', 'Notification manager not available');
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
        
        log.info('agent', `Scheduling reminder for "${meeting.summary}" in ${Math.round(reminderTime / 60000)} minutes`);
        
        notificationManager.schedule(notificationId, message, {
          delay: reminderTime,
          priority: 1, // URGENT priority (TaskPriority.URGENT = 1)
          onDelivered: () => {
            log.info('agent', `Reminder delivered for "${meeting.summary}"`);
          }
        });
        
        this._scheduledReminders.set(eventId, notificationId);
      }
      
    } catch (error) {
      log.error('agent', 'Error checking upcoming meetings', { error });
    }
  },
  
  // ==================== DATA-AWARE BIDDING ====================
  
  // No bid() method - routing is handled entirely by the unified bidder (LLM-based).
  // The unified bidder evaluates this agent's description, capabilities, and the user's
  // intent semantically via GPT-4o-mini. No keyword matching. See unified-bidder.js.
  
  // ==================== EXECUTION ====================
  
  /**
   * Execute the task with full agentic capabilities
   * @param {Object} task - The task to execute
   * @param {Object} executionContext - Execution context with submitSubtask callback
   */
  async execute(task, executionContext = {}) {
    // ==================== DUPLICATE EXECUTION DETECTION ====================
    // Use normalized content as key (NOT task.id, which is unique per submission)
    const normalizedContent = (task.content || '').toLowerCase().replace(/[.,!?;:'"]/g, '').trim().slice(0, 100);
    const taskKey = normalizedContent;
    const now = Date.now();
    const lastExecution = _recentExecutions.get(taskKey);
    
    if (lastExecution && (now - lastExecution) < EXECUTION_DEDUP_WINDOW_MS) {
      log.warn('agent', `DUPLICATE EXECUTION DETECTED for "${normalizedContent.slice(0, 40)}...", skipping (${now - lastExecution}ms since last)`);
      return { success: true, message: "Already processing this request." };
    }
    _recentExecutions.set(taskKey, now);
    
    // Clean up old entries
    for (const [key, timestamp] of _recentExecutions) {
      if (now - timestamp > EXECUTION_DEDUP_WINDOW_MS * 5) {
        _recentExecutions.delete(key);
      }
    }
    
    log.info('agent', `Execute called for task ${task.id}: "${task.content?.slice(0, 50)}..."`);
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'calendar-agent.js:800',message:'Agent execute called',data:{taskContent:task.content?.slice(0,100)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'ALL'})}).catch(()=>{});
    // #endregion
    
    try {
      // Initialize memory and poller
      if (!this.memory) {
        await this.initialize();
      }
      
      // Store execution context for methods that need it (like _resolveConflicts)
      this._currentExecutionContext = executionContext;
      
      const context = getTimeContext();
      
      // ==================== MULTI-TURN STATE HANDLING ====================
      // Check if this is a follow-up response to a previous needsInput
      const calendarState = task.context?.calendarState;
      if (calendarState) {
        log.info('agent', `Handling multi-turn state: ${calendarState}`);
        
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
          
          case 'awaiting_recurring_details':
            return this._handleRecurringDetailsResponse(task, context);
          
          // ==================== CONFLICT RESOLUTION STATES ====================
          case 'awaiting_conflict_resolution':
            // This is a subtask asking user to cancel/move/skip a conflict
            return this._handleConflictChoice(task, executionContext);
          
          case 'awaiting_conflict_move_time':
            // User is providing a new time for moving an event
            return this._handleConflictMoveTime(task);
          
          default:
            log.info('agent', `Unknown calendar state: ${calendarState}, processing as new request`);
        }
      }
      
      // ==================== FETCH EVENTS (EXTERNAL + LOCAL) ====================
      const externalEvents = await this._fetchEvents();
      
      // Ensure CalendarStore is initialized
      if (!this._calStore) {
        this._calStore = getCalendarStore();
      }
      
      const userQuery = (task.content || '').toLowerCase().trim();
      
      // ==================== NEW ACTION ROUTING ====================
      // Check for new CalendarStore-powered actions before falling through
      // to the general LLM approach.
      
      // --- Morning Brief → handled by daily-brief-agent now ---
      // Calendar-agent's getBriefing() contributes schedule data.
      // If a brief request somehow reaches here, return the calendar contribution only.
      if (this._isBriefRequest(userQuery)) {
        const briefData = await this.getBriefing();
        const briefSpec = this._buildBriefUISpec(briefData.data);
        const briefHtml = briefSpec.events.length > 0 ? renderAgentUI(briefSpec) : undefined;
        return { success: true, message: briefData.content || 'Your calendar is clear today.', html: briefHtml };
      }
      
      // --- Week Summary ---
      if (this._isWeekSummaryRequest(userQuery)) {
        return this._handleWeekSummary(externalEvents);
      }
      
      // --- Free Slot Finder ---
      if (this._isFreeSlotRequest(userQuery)) {
        return this._handleFreeSlots(userQuery, externalEvents);
      }
      
      // --- Recurring Event Creation (detect before general LLM) ---
      if (this._isRecurringRequest(userQuery)) {
        return this._handleRecurringCreation(task, context);
      }
      
      // --- Conflict Check ---
      if (this._isConflictCheckRequest(userQuery)) {
        return this._handleConflictCheck(userQuery, externalEvents);
      }
      
      // ==================== GENERAL LLM APPROACH ====================
      // Merge local + external events and let the LLM answer
      const allEvents = externalEvents || [];
      
      if (allEvents.length === 0) {
        // Check if CalendarStore has local events for today/this week
        const localToday = this._calStore.getEventsToday();
        if (localToday.length === 0) {
          const result = { success: true, message: "Your calendar is clear - no upcoming events." };
          await this._recordQuery(task.content, result.message);
          return result;
        }
        // Fall through to general LLM approach with local events
      }
      
      log.info('agent', 'Asking LLM to answer calendar question with', { length: allEvents.length, detail: 'events' });
      const result = await this._askLLMAboutCalendar(task.content, allEvents, context);
      
      // If the LLM detected a recurring creation or local action, handle it
      if (result._localAction) {
        return this._handleLocalAction(result._localAction, externalEvents);
      }
      
      // Learn from this interaction
      await this._learnFromQuery(task.content, result, context);
      
      return result;
      
    } catch (error) {
      log.error('agent', 'Error', { error });
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
    
    log.info('agent', `Events: ${futureEvents.length} future, ${pastEvents.length} past (${events.length} total)`);
    
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

CRITICAL INSTRUCTIONS FOR CONFLICT RESOLUTION:
- If the user wants to RESOLVE CONFLICTS, FIX SCHEDULE, or CLEAR UP OVERLAPPING events, respond with a special JSON format
- This is for finding and resolving events that overlap in time
- Extract the time period: today, tomorrow, this week, a specific day, or date range
- For relative dates, calculate the actual date based on TODAY
- Respond with JSON: {"action":"resolve_conflicts","period":{"startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD"}}
- Examples of conflict resolution requests:
  - "resolve conflicts for this week" -> action: resolve_conflicts, period for this week
  - "fix my schedule for Monday" -> action: resolve_conflicts, period for Monday
  - "any overlapping meetings today?" -> action: resolve_conflicts, period for today

CRITICAL INSTRUCTIONS FOR RECURRING EVENT CREATION:
- If the user wants to create a RECURRING event (every day, every week, every Monday, etc.), respond with JSON:
  {"action":"add_recurring","eventDetails":{"title":"...","date":"YYYY-MM-DD","time":"HH:MM","duration":"30m","recurring":{"pattern":"weekly","daysOfWeek":[1]}}}
- Patterns: "daily", "weekdays", "weekly", "biweekly", "monthly", "yearly"
- daysOfWeek: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat

CRITICAL INSTRUCTIONS FOR SPECIAL ACTIONS:
- Morning brief / daily rundown / "what does my day look like" -> respond with JSON: {"action":"morning_brief"}
- Week summary / "how's my week" -> respond with JSON: {"action":"week_summary"}
- Free slots / "when am I free" -> respond with JSON: {"action":"find_free_slots","query":"original user query"}

If this is NOT one of the above special requests, respond with normal text (not JSON).`;

    try {
      const result = await ai.chat({
        profile: 'powerful',
        system: systemPrompt,
        messages: [{ role: 'user', content: userQuestion }],
        thinking: true,
        maxTokens: 16000,
        feature: 'calendar-agent'
      });
      
      const answer = result.content?.trim();
      
      if (!answer) {
        throw new Error('No response from LLM');
      }
      
      log.info('agent', 'LLM response', { answer });
      
      // Check if this is an event creation/deletion response (JSON format)
      if (answer.startsWith('{') && answer.includes('"action"')) {
        try {
          const parsed = JSON.parse(answer);
          if (parsed.action === 'add_event' && parsed.eventDetails) {
            log.info('agent', 'Detected event creation request', { eventDetails: parsed.eventDetails });
            return this._createEvent(parsed.eventDetails);
          }
          if (parsed.action === 'delete_event' && parsed.deleteDetails) {
            log.info('agent', 'Detected event deletion request', { deleteDetails: parsed.deleteDetails });
            return this._deleteEvent(parsed.deleteDetails, futureEvents);
          }
          if (parsed.action === 'event_details' && parsed.detailsQuery) {
            log.info('agent', 'Detected event details request', { detailsQuery: parsed.detailsQuery });
            return this._getEventDetails(parsed.detailsQuery, futureEvents);
          }
          if (parsed.action === 'resolve_conflicts' && parsed.period) {
            log.info('agent', 'Detected conflict resolution request', { period: parsed.period });
            // Convert period dates to Date objects
            const period = {
              startDate: new Date(parsed.period.startDate),
              endDate: new Date(parsed.period.endDate + 'T23:59:59') // End of the day
            };
            // Pass executionContext from closure (set via _askLLMAboutCalendar's caller)
            return this._resolveConflicts(period, futureEvents, this._currentExecutionContext);
          }
          // New CalendarStore-powered actions from LLM
          if (parsed.action === 'add_recurring' && parsed.eventDetails) {
            log.info('agent', 'LLM detected recurring creation request');
            return { _localAction: { type: 'recurring_create', details: parsed.eventDetails } };
          }
          if (parsed.action === 'morning_brief') {
            log.info('agent', 'LLM detected morning brief request');
            return { _localAction: { type: 'morning_brief' } };
          }
          if (parsed.action === 'week_summary') {
            log.info('agent', 'LLM detected week summary request');
            return { _localAction: { type: 'week_summary' } };
          }
          if (parsed.action === 'find_free_slots') {
            log.info('agent', 'LLM detected free slots request');
            return { _localAction: { type: 'find_free_slots', query: parsed.query || '' } };
          }
        } catch (parseErr) {
          // Not valid JSON, treat as normal response
          log.info('agent', 'Response looked like JSON but failed to parse', { message: parseErr.message });
        }
      }
      
      // Build rich UI panel alongside the LLM text answer.
      // Detect the timeframe from the user question and filter events.
      const q = userQuestion.toLowerCase();
      let relevantEvents = futureEvents;
      let uiLabel = 'Upcoming';

      const endOfToday = new Date(startOfToday);
      endOfToday.setHours(23, 59, 59, 999);
      const startOfTomorrow = new Date(startOfToday);
      startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
      const endOfTomorrow = new Date(startOfTomorrow);
      endOfTomorrow.setHours(23, 59, 59, 999);

      if (q.includes('today') || q.includes('this morning') || q.includes('this afternoon')) {
        relevantEvents = futureEvents.filter(e => new Date(e.start?.dateTime || e.start?.date) <= endOfToday);
        uiLabel = 'Today';
      } else if (q.includes('tomorrow')) {
        relevantEvents = futureEvents.filter(e => {
          const s = new Date(e.start?.dateTime || e.start?.date);
          return s >= startOfTomorrow && s <= endOfTomorrow;
        });
        uiLabel = 'Tomorrow';
      } else if (q.includes('next meeting') || q.includes('next call')) {
        relevantEvents = futureEvents.slice(0, 1);
        uiLabel = 'Next Meeting';
      } else if (q.includes('week')) {
        const weekEnd = new Date(now);
        weekEnd.setDate(weekEnd.getDate() + 7);
        relevantEvents = futureEvents.filter(e => new Date(e.start?.dateTime || e.start?.date) <= weekEnd);
        uiLabel = 'This Week';
      }

      const uiSpec = this._buildEventsUISpec(relevantEvents, uiLabel);
      const html = relevantEvents.length > 0 ? renderAgentUI(uiSpec) : undefined;

      return { success: true, message: answer, html };
      
    } catch (error) {
      log.error('agent', 'LLM error', { error });
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
      
      case 'morning_brief': {
        const briefData = await this.getBriefing();
        const briefSpec = this._buildBriefUISpec(briefData.data);
        const briefHtml = briefSpec.events.length > 0 ? renderAgentUI(briefSpec) : undefined;
        return { success: true, message: briefData.content || 'Your calendar is clear today.', html: briefHtml };
      }
      
      case 'week_summary':
        return this._handleWeekSummary(events);
      
      case 'find_free_slots':
        return this._handleFreeSlots(aiResult.timeframe || 'today', events);
      
      case 'add_recurring':
        if (aiResult.eventDetails) {
          // Already parsed -- pass through
          const store = this._calStore || getCalendarStore();
          const ed = aiResult.eventDetails;
          const startDate = ed.date || new Date().toISOString().slice(0, 10);
          const startTime = ed.time || '09:00';
          const durationMs = this._parseDuration(ed.duration || '30m');
          const startISO = new Date(`${startDate}T${startTime}:00`).toISOString();
          const endISO = new Date(new Date(startISO).getTime() + durationMs).toISOString();
          
          const { event, conflicts } = store.addEvent({
            title: ed.title,
            startTime: startISO,
            endTime: endISO,
            recurring: ed.recurring,
            guests: ed.guests ? ed.guests.split(',').map(g => g.trim()) : [],
          });
          
          const patternLabel = this._describeRecurrence(event.recurring);
          let msg = `Created recurring event "${event.title}" ${patternLabel}.`;
          if (conflicts.length > 0) {
            msg += ` Note: ${conflicts.length} conflict${conflicts.length > 1 ? 's' : ''} detected.`;
          }
          return { success: true, message: msg };
        }
        return {
          success: true,
          needsInput: {
            prompt: 'What should I call this recurring event, and how often? For example: "Team standup every weekday at 9am".',
            agentId: this.id,
            context: { calendarState: 'awaiting_recurring_details', originalRequest: 'add recurring' },
          },
        };
      
      case 'resolve_conflicts':
        return this._handleConflictCheck(aiResult.timeframe || 'today', events);
      
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
  
  // ==================== CALENDARSTORE-POWERED HANDLERS ====================
  
  /**
   * Request detection helpers (fast, no LLM call needed).
   */
  _isBriefRequest(q) {
    return /\b(morning\s*brief|daily\s*rundown|brief\s*me|run\s*me\s*through\s*today|what\s*does\s*my\s*day\s*look\s*like|how'?s\s*my\s*day|day\s*look\s*like|give\s*me\s*(?:a\s+)?(?:my\s+)?brief)\b/i.test(q);
  },
  
  _isWeekSummaryRequest(q) {
    return /\b(week\s*(?:summary|overview|look|recap)|how'?s\s*my\s*week|busiest\s*day\s*this\s*week|week\s*at\s*a\s*glance)\b/i.test(q);
  },
  
  _isFreeSlotRequest(q) {
    return /\b(when\s*am\s*i\s*free|find\s*(?:me\s+)?(?:a\s+)?(?:an\s+)?(?:free|open)\s*(?:slot|time|block)|suggest\s*a\s*time|free\s*slots?|open\s*slots?)\b/i.test(q);
  },
  
  _isRecurringRequest(q) {
    return /\b(every\s*(?:day|weekday|week|other\s*week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|month|year)|daily\s*(?:standup|check|sync|meeting)|weekly\s*(?:sync|standup|meeting|review)|biweekly|recurring|repeating)\b/i.test(q);
  },
  
  _isConflictCheckRequest(q) {
    return /\b(conflict|overlapping|double.?book|schedule\s*conflict|any\s*conflicts|resolve\s*conflict|check\s*for\s*overlap)\b/i.test(q);
  },
  
  /**
   * Week Summary handler.
   */
  async _handleWeekSummary(externalEvents) {
    const store = this._calStore || getCalendarStore();
    const summary = store.generateWeekSummary(externalEvents);
    return { success: true, message: summary };
  },
  
  /**
   * Free Slot finder handler.
   */
  async _handleFreeSlots(query, externalEvents) {
    const store = this._calStore || getCalendarStore();
    
    // Determine which day to check
    let targetDate = new Date();
    if (/tomorrow/i.test(query)) {
      targetDate = new Date(targetDate.getTime() + 86400000);
    } else if (/monday|tuesday|wednesday|thursday|friday|saturday|sunday/i.test(query)) {
      const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
      const match = query.match(/monday|tuesday|wednesday|thursday|friday|saturday|sunday/i);
      if (match) {
        const targetDay = dayNames.indexOf(match[0].toLowerCase());
        const today = targetDate.getDay();
        let diff = targetDay - today;
        if (diff <= 0) diff += 7;
        targetDate = new Date(targetDate.getTime() + diff * 86400000);
      }
    }
    
    // Parse desired duration from query
    let minDuration = 30;
    const durMatch = query.match(/(\d+)\s*(?:min|minute|hour|hr)/i);
    if (durMatch) {
      minDuration = parseInt(durMatch[1]);
      if (/hour|hr/i.test(durMatch[0])) minDuration *= 60;
    }
    
    const slots = store.getFreeSlots(targetDate, minDuration, externalEvents);
    const dayLabel = store.constructor.name ? 
      targetDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }) :
      'that day';
    
    if (slots.length === 0) {
      return { 
        success: true, 
        message: `You don't have any free blocks of ${minDuration} minutes or more on ${dayLabel}.`,
      };
    }
    
    const slotDescriptions = slots.slice(0, 4).map(s => {
      const sTime = new Date(s.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const eTime = new Date(s.end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      return `${sTime} to ${eTime} (${s.durationMinutes} minutes)`;
    });
    
    const balance = store.getDayBalance(targetDate, externalEvents);
    const intro = `On ${dayLabel} you have ${balance.freeHours} hours free during working hours.`;
    const detail = `Open blocks: ${slotDescriptions.join('; ')}.`;
    
    return {
      success: true,
      message: `${intro} ${detail}`,
      data: { type: 'free_slots', slots, balance },
    };
  },
  
  /**
   * Recurring event creation handler.
   * Uses LLM to parse the natural-language request into structured recurring event data.
   */
  async _handleRecurringCreation(task, context) {
    const store = this._calStore || getCalendarStore();
    const userRequest = task.content || '';
    
    // Use LLM to parse the recurring request
    const parsed = await this._parseRecurringWithLLM(userRequest);
    
    if (!parsed || parsed.needsClarification) {
      return {
        success: true,
        needsInput: {
          prompt: parsed?.clarificationPrompt || 'What time should this recurring event be? And which days?',
          agentId: this.id,
          context: {
            calendarState: 'awaiting_recurring_details',
            originalRequest: userRequest,
            partialEvent: parsed?.eventDetails || {},
          },
        },
      };
    }
    
    // Build the event
    const eventData = parsed.eventDetails;
    const startDate = eventData.date || new Date().toISOString().slice(0, 10);
    const startTime = eventData.time || '09:00';
    const durationMs = this._parseDuration(eventData.duration || '30m');
    
    const startISO = new Date(`${startDate}T${startTime}:00`).toISOString();
    const endISO = new Date(new Date(startISO).getTime() + durationMs).toISOString();
    
    const { event, conflicts } = store.addEvent({
      title: eventData.title,
      startTime: startISO,
      endTime: endISO,
      location: eventData.location || '',
      description: eventData.description || '',
      guests: eventData.guests ? eventData.guests.split(',').map(g => g.trim()) : [],
      recurring: eventData.recurring,
    });
    
    // Build response
    const patternLabel = this._describeRecurrence(event.recurring);
    let msg = `Created recurring event "${event.title}" ${patternLabel}`;
    if (eventData.time) {
      msg += ` at ${new Date(startISO).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
    }
    msg += '.';
    
    if (conflicts.length > 0) {
      msg += ` Note: this conflicts with ${conflicts.length} existing event${conflicts.length > 1 ? 's' : ''}.`;
      const firstConflict = conflicts[0];
      msg += ` "${firstConflict.title}" at ${new Date(firstConflict.startTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.`;
      msg += ' Would you like me to resolve these conflicts?';
    }
    
    return {
      success: true,
      message: msg,
      data: {
        type: 'recurring_created',
        event,
        conflicts,
      },
    };
  },
  
  /**
   * Conflict check handler -- finds and reports all conflicts for a day/week.
   */
  async _handleConflictCheck(query, externalEvents) {
    const store = this._calStore || getCalendarStore();
    
    // Determine period
    let targetDate = new Date();
    if (/tomorrow/i.test(query)) {
      targetDate = new Date(targetDate.getTime() + 86400000);
    }
    
    const isWeek = /week/i.test(query);
    
    if (isWeek) {
      // Check whole week
      const dayOfWeek = targetDate.getDay();
      const monday = new Date(targetDate);
      monday.setDate(monday.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
      
      let totalConflicts = 0;
      const conflictDays = [];
      
      for (let i = 0; i < 7; i++) {
        const d = new Date(monday);
        d.setDate(d.getDate() + i);
        const dayConflicts = store.findDayConflicts(d, externalEvents);
        if (dayConflicts.length > 0) {
          totalConflicts += dayConflicts.length;
          const dayName = d.toLocaleDateString('en-US', { weekday: 'long' });
          for (const c of dayConflicts) {
            conflictDays.push(`${dayName}: "${c.event1.title}" and "${c.event2.title}" overlap by ${c.overlapMinutes} minutes`);
          }
        }
      }
      
      if (totalConflicts === 0) {
        return { success: true, message: 'No scheduling conflicts this week. Your calendar is clean.' };
      }
      
      return {
        success: true,
        message: `Found ${totalConflicts} conflict${totalConflicts > 1 ? 's' : ''} this week. ${conflictDays.join('. ')}.`,
      };
    }
    
    // Single day
    const conflicts = store.findDayConflicts(targetDate, externalEvents);
    const dayLabel = targetDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    
    if (conflicts.length === 0) {
      return { success: true, message: `No conflicts on ${dayLabel}. Your schedule is clear.` };
    }
    
    const details = conflicts.map(c => 
      `"${c.event1.title}" and "${c.event2.title}" overlap by ${c.overlapMinutes} minutes around ${new Date(c.event1.startTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
    );
    
    const suggestions = store.suggestAlternatives(30, targetDate, 2);
    let suggestMsg = '';
    if (suggestions.length > 0) {
      suggestMsg = ` I can suggest moving one: ${suggestions.map(s => `${s.day} at ${s.time}`).join(' or ')}.`;
    }
    
    return {
      success: true,
      message: `${conflicts.length} conflict${conflicts.length > 1 ? 's' : ''} on ${dayLabel}. ${details.join('. ')}.${suggestMsg}`,
    };
  },
  
  /**
   * Handle local actions detected by the LLM.
   */
  async _handleLocalAction(action, externalEvents) {
    switch (action.type) {
      case 'morning_brief': {
        const briefData = await this.getBriefing();
        const briefSpec = this._buildBriefUISpec(briefData.data);
        const briefHtml = briefSpec.events.length > 0 ? renderAgentUI(briefSpec) : undefined;
        return { success: true, message: briefData.content || 'Your calendar is clear today.', html: briefHtml };
      }
      case 'week_summary':
        return this._handleWeekSummary(externalEvents);
      case 'find_free_slots':
        return this._handleFreeSlots(action.query || '', externalEvents);
      case 'resolve_conflicts':
        return this._handleConflictCheck(action.query || 'today', externalEvents);
      default:
        return { success: true, message: "I'm not sure how to handle that calendar request." };
    }
  },
  
  /**
   * Use LLM to parse a natural-language recurring event request.
   */
  async _parseRecurringWithLLM(userRequest) {
    const now = new Date();
    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    
    try {
      const result = await calendarCircuit.execute(async () => {
        return await ai.chat({
          profile: 'powerful',
          system: `You parse recurring event requests into structured JSON. Today is ${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}.

Return JSON:
{
  "eventDetails": {
    "title": "event title",
    "date": "YYYY-MM-DD (first occurrence)",
    "time": "HH:MM (24-hour) or null if not specified",
    "duration": "e.g. 15m, 30m, 1h",
    "location": "",
    "description": "",
    "guests": "comma-separated names/emails or empty",
    "recurring": {
      "pattern": "daily|weekdays|weekly|biweekly|monthly|yearly",
      "daysOfWeek": [0-6 indices, 0=Sun],
      "dayOfMonth": null,
      "interval": 1,
      "endDate": null,
      "endAfter": null
    }
  },
  "needsClarification": false,
  "clarificationPrompt": null
}

Day mapping: Sunday=0, Monday=1, Tuesday=2, Wednesday=3, Thursday=4, Friday=5, Saturday=6.
"every weekday" → pattern "weekdays".
"every other week" → pattern "biweekly".
If time is missing, set needsClarification=true.
Default duration: 30m for meetings, 15m for standups/check-ins.`,
          messages: [{ role: 'user', content: userRequest }],
          thinking: true,
          maxTokens: 16000,
          jsonMode: true,
          feature: 'calendar-recurring',
        });
      });
      
      return JSON.parse(result.content);
    } catch (err) {
      log.warn('agent', 'Failed to parse recurring request', { error: err.message });
      return null;
    }
  },
  
  /**
   * Parse a duration string like "30m", "1h", "90m" into milliseconds.
   */
  _parseDuration(dur) {
    if (!dur) return 30 * 60000;
    const match = dur.match(/(\d+)\s*(m|h|min|hour|hr)/i);
    if (!match) return 30 * 60000;
    let minutes = parseInt(match[1]);
    if (/h/i.test(match[2])) minutes *= 60;
    return minutes * 60000;
  },
  
  /**
   * Describe a recurrence pattern in natural language.
   */
  _describeRecurrence(rec) {
    if (!rec) return '';
    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    switch (rec.pattern) {
      case 'daily': return 'every day';
      case 'weekdays': return 'every weekday';
      case 'weekly':
        if (rec.daysOfWeek && rec.daysOfWeek.length > 0) {
          return `every ${rec.daysOfWeek.map(d => dayNames[d]).join(' and ')}`;
        }
        return 'every week';
      case 'biweekly':
        if (rec.daysOfWeek && rec.daysOfWeek.length > 0) {
          return `every other ${rec.daysOfWeek.map(d => dayNames[d]).join(' and ')}`;
        }
        return 'every other week';
      case 'monthly':
        if (rec.dayOfMonth) return `on the ${rec.dayOfMonth}${this._ordinalSuffix(rec.dayOfMonth)} of every month`;
        return 'every month';
      case 'yearly': return 'every year';
      default: return `on a ${rec.pattern} schedule`;
    }
  },
  
  _ordinalSuffix(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return s[(v - 20) % 10] || s[v] || s[0];
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
    
    log.info('agent', `Handling delete selection: "${userResponse}" from ${matches.length} matches`);
    
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
   * Handle follow-up response for recurring event creation (when time/details were missing).
   */
  async _handleRecurringDetailsResponse(task, context) {
    const userInput = task.context?.userInput || task.content || '';
    const partialEvent = task.context?.partialEvent || {};
    const originalRequest = task.context?.originalRequest || '';
    
    // Combine original + follow-up for LLM parsing
    const combined = `${originalRequest}. ${userInput}`;
    const parsed = await this._parseRecurringWithLLM(combined);
    
    if (!parsed || parsed.needsClarification) {
      return {
        success: true,
        needsInput: {
          prompt: parsed?.clarificationPrompt || 'I still need the time. What time should this recurring event be?',
          agentId: this.id,
          context: {
            calendarState: 'awaiting_recurring_details',
            originalRequest: combined,
            partialEvent: { ...partialEvent, ...(parsed?.eventDetails || {}) },
          },
        },
      };
    }
    
    // We have enough details now -- create the event
    const store = this._calStore || getCalendarStore();
    const eventData = { ...partialEvent, ...parsed.eventDetails };
    const startDate = eventData.date || new Date().toISOString().slice(0, 10);
    const startTime = eventData.time || '09:00';
    const durationMs = this._parseDuration(eventData.duration || '30m');
    
    const startISO = new Date(`${startDate}T${startTime}:00`).toISOString();
    const endISO = new Date(new Date(startISO).getTime() + durationMs).toISOString();
    
    const { event, conflicts } = store.addEvent({
      title: eventData.title,
      startTime: startISO,
      endTime: endISO,
      location: eventData.location || '',
      guests: eventData.guests ? eventData.guests.split(',').map(g => g.trim()) : [],
      recurring: eventData.recurring,
    });
    
    const patternLabel = this._describeRecurrence(event.recurring);
    let msg = `Created recurring event "${event.title}" ${patternLabel} at ${new Date(startISO).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.`;
    
    if (conflicts.length > 0) {
      msg += ` Heads up: conflicts with ${conflicts.length} existing event${conflicts.length > 1 ? 's' : ''}.`;
    }
    
    return { success: true, message: msg, data: { type: 'recurring_created', event, conflicts } };
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
    log.info('agent', `Learned new contact: ${name} -> ${email}`);
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
      log.info('agent', `Learned pattern: ${key} = ${value}`);
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
      log.info('agent', 'Using cached events');
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
      
      log.info('agent', `Fetching events from omnical API`);
      log.info('agent', `Date range: ${formatDate(startDate)} to ${formatDate(endDate)}`);
      
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
        log.info('agent', 'No events found in calendar');
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
        log.info('agent', `Fetching details for ${events.length} events...`);
        events = await this._enrichEventsWithDetails(events);
      }
      
      // Log first few event dates to debug
      if (events.length > 0) {
        const sample = events.slice(0, 3).map(e => {
          const d = e.start?.dateTime || e.start?.date;
          const attendeeCount = e.attendees?.length || 0;
          return `${e.summary?.slice(0, 20)}: ${d} (${attendeeCount} attendees)`;
        });
        log.info('agent', `Sample events returned`, { sample });
      }
      
      // Cache the enriched events
      this._cache.events = events;
      this._cache.fetchedAt = now;
      
      log.info('agent', `Fetched ${events.length} events with details`);
      return events;
      
    } catch (error) {
      log.error('agent', 'Failed to fetch events', { error });
      // Return cached events if available, even if stale
      if (this._cache.events) {
        log.info('agent', 'Returning stale cached events');
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
      log.info('agent', `Fetching events from external calendar: ${apiUrl}`);
      log.info('agent', `Date range: ${startDate} to ${endDate}`);
      
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
        log.info('agent', 'No events found in external calendar');
        return [];
      }
      
      // Ensure we have an array
      const events = Array.isArray(data) ? data : [];
      log.info('agent', `Fetched ${events.length} events from external calendar`);
      
      return events;
      
    } catch (error) {
      log.error('agent', 'Failed to fetch external calendar', { error });
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
    log.info('agent', `Finding mutual availability with ${contactName} on ${dateStr}`);
    
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
    
    log.info('agent', `User has ${userEventsOnDate.length} events, contact has ${contactResult.events.length} events on ${dateStr}`);
    
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
    
    log.info('agent', `Found ${freeSlots.length} mutual free slots of ${duration}+ minutes`);
    return freeSlots;
  },

  // ==================== CONFLICT RESOLUTION ====================
  
  /**
   * Find overlapping (conflicting) events within a time range
   * Two events overlap if: event1Start < event2End AND event2Start < event1End
   * 
   * @param {Array} events - Array of calendar events
   * @param {Date} startDate - Start of the range to check
   * @param {Date} endDate - End of the range to check
   * @returns {Array} - Array of conflict objects { event1, event2, overlapMinutes }
   */
  _findOverlappingEvents(events, startDate, endDate) {
    // Filter events within the date range
    const rangeEvents = events.filter(event => {
      const eventStart = new Date(event.start?.dateTime || event.start?.date);
      return eventStart >= startDate && eventStart <= endDate;
    });
    
    // Sort by start time
    rangeEvents.sort((a, b) => {
      const aStart = new Date(a.start?.dateTime || a.start?.date);
      const bStart = new Date(b.start?.dateTime || b.start?.date);
      return aStart - bStart;
    });
    
    const conflicts = [];
    
    // Check each pair for overlap
    for (let i = 0; i < rangeEvents.length - 1; i++) {
      const event1 = rangeEvents[i];
      const event1Start = new Date(event1.start?.dateTime || event1.start?.date);
      const event1End = new Date(event1.end?.dateTime || event1.end?.date || event1Start.getTime() + 3600000);
      
      for (let j = i + 1; j < rangeEvents.length; j++) {
        const event2 = rangeEvents[j];
        const event2Start = new Date(event2.start?.dateTime || event2.start?.date);
        const event2End = new Date(event2.end?.dateTime || event2.end?.date || event2Start.getTime() + 3600000);
        
        // Check for overlap: event1Start < event2End AND event2Start < event1End
        if (event1Start < event2End && event2Start < event1End) {
          // Calculate overlap duration
          const overlapStart = Math.max(event1Start.getTime(), event2Start.getTime());
          const overlapEnd = Math.min(event1End.getTime(), event2End.getTime());
          const overlapMinutes = Math.round((overlapEnd - overlapStart) / 60000);
          
          conflicts.push({
            event1: {
              id: event1.id,
              summary: event1.summary,
              start: event1.start,
              end: event1.end,
              calendarId: event1.calendarId || 'primary'
            },
            event2: {
              id: event2.id,
              summary: event2.summary,
              start: event2.start,
              end: event2.end,
              calendarId: event2.calendarId || 'primary'
            },
            overlapMinutes
          });
        }
      }
    }
    
    log.info('agent', `Found ${conflicts.length} conflicts in ${rangeEvents.length} events`);
    return conflicts;
  },

  /**
   * Resolve calendar conflicts by spawning subtasks for each conflict
   * Uses the subtask API to create independent tasks for user decisions
   * 
   * @param {Object} period - { startDate, endDate }
   * @param {Array} events - Calendar events
   * @param {Object} executionContext - Contains submitSubtask callback
   * @returns {Object} - Result with message about conflicts found
   */
  async _resolveConflicts(period, events, executionContext) {
    const { submitSubtask } = executionContext || {};
    
    if (!submitSubtask) {
      log.error('agent', 'No submitSubtask callback available');
      return {
        success: false,
        message: "I can't process conflicts right now. Please try again."
      };
    }
    
    const conflicts = this._findOverlappingEvents(events, period.startDate, period.endDate);
    
    if (conflicts.length === 0) {
      return {
        success: true,
        message: "Good news! You have no scheduling conflicts in that time period."
      };
    }
    
    log.info('agent', `Creating ${conflicts.length} subtasks for conflict resolution`);
    
    // Create one subtask per conflict
    const subtaskPromises = conflicts.map(async (conflict, index) => {
      const { event1, event2, overlapMinutes } = conflict;
      
      // Format the conflict time
      const conflictDate = new Date(event1.start?.dateTime || event1.start?.date);
      const dayName = conflictDate.toLocaleDateString('en-US', { weekday: 'long' });
      const dateStr = conflictDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const time1 = new Date(event1.start?.dateTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const time2 = new Date(event2.start?.dateTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      
      const content = `Conflict ${index + 1}: "${event1.summary}" (${time1}) overlaps with "${event2.summary}" (${time2}) on ${dayName} ${dateStr}`;
      
      const result = await submitSubtask({
        content,
        routingMode: 'locked',
        context: {
          calendarState: 'awaiting_conflict_resolution',
          conflictIndex: index,
          totalConflicts: conflicts.length,
          event1,
          event2,
          overlapMinutes,
          conflictDate: conflictDate.toISOString()
        }
      });
      
      return result;
    });
    
    await Promise.all(subtaskPromises);
    
    const periodDesc = this._formatPeriodDescription(period);
    return {
      success: true,
      message: `I found ${conflicts.length} scheduling conflict${conflicts.length > 1 ? 's' : ''} ${periodDesc}. I'll walk you through each one.`
    };
  },

  /**
   * Format a period description for user-friendly output
   */
  _formatPeriodDescription(period) {
    const now = new Date();
    const start = new Date(period.startDate);
    const end = new Date(period.endDate);
    
    // Check if it's today
    if (start.toDateString() === now.toDateString()) {
      return 'today';
    }
    
    // Check if it's tomorrow
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    if (start.toDateString() === tomorrow.toDateString()) {
      return 'tomorrow';
    }
    
    // Check if it's a single day
    if (start.toDateString() === end.toDateString()) {
      return `on ${start.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}`;
    }
    
    // It's a range
    return `this week`;
  },

  /**
   * Handle user's conflict resolution choice
   * Called when user responds to a conflict subtask with cancel/move/skip
   */
  async _handleConflictChoice(task, executionContext) {
    const { event1, event2, conflictIndex, totalConflicts } = task.context || {};
    const userResponse = (task.content || '').toLowerCase().trim();
    
    if (!event1 || !event2) {
      return {
        success: false,
        message: "I lost track of the conflict details. Let's start over."
      };
    }
    
    log.info('agent', `Handling conflict choice: "${userResponse}" for conflict ${conflictIndex + 1}/${totalConflicts}`);
    
    // Determine which event is being acted on (default to first mentioned)
    // User might say "cancel the standup" or "move the first one"
    let targetEvent = event1;
    let targetName = event1.summary.toLowerCase();
    let otherEvent = event2;
    
    // Check if user referenced the second event
    const event2Name = event2.summary.toLowerCase();
    if (userResponse.includes(event2Name) || 
        userResponse.includes('second') || 
        userResponse.includes('other') ||
        userResponse.includes('latter')) {
      targetEvent = event2;
      targetName = event2Name;
      otherEvent = event1;
    }
    
    // Parse the action
    if (userResponse.includes('cancel') || userResponse.includes('delete') || userResponse.includes('remove')) {
      // Cancel the target event
      log.info('agent', `Cancelling event: ${targetEvent.summary}`);
      const deleteResult = await this._deleteEvent({
        eventId: targetEvent.id,
        calendarId: targetEvent.calendarId || 'primary'
      });
      
      if (deleteResult.success) {
        return {
          success: true,
          message: `Done! I've cancelled "${targetEvent.summary}". Conflict ${conflictIndex + 1} of ${totalConflicts} resolved.`
        };
      } else {
        return {
          success: false,
          message: `I couldn't cancel "${targetEvent.summary}": ${deleteResult.message}`
        };
      }
    }
    
    if (userResponse.includes('move') || userResponse.includes('reschedule') || userResponse.includes('change')) {
      // Need to ask for new time
      return {
        success: true,
        needsInput: {
          prompt: `When would you like to move "${targetEvent.summary}" to?`,
          agentId: this.id,
          context: {
            calendarState: 'awaiting_conflict_move_time',
            eventToMove: targetEvent,
            conflictIndex,
            totalConflicts
          }
        }
      };
    }
    
    if (userResponse.includes('skip') || userResponse.includes('ignore') || userResponse.includes('leave') || userResponse.includes('keep')) {
      return {
        success: true,
        message: `Skipped. "${targetEvent.summary}" and "${otherEvent.summary}" will remain overlapping. Conflict ${conflictIndex + 1} of ${totalConflicts} skipped.`
      };
    }
    
    // User didn't give a clear action - prompt them
    return {
      success: true,
      needsInput: {
        prompt: `For "${event1.summary}" overlapping with "${event2.summary}": Would you like to cancel, move, or skip?`,
        agentId: this.id,
        context: task.context
      }
    };
  },

  /**
   * Handle user's response for moving a conflicting event to a new time
   */
  async _handleConflictMoveTime(task) {
    const { eventToMove, conflictIndex, totalConflicts } = task.context || {};
    const userResponse = (task.content || '').trim();
    
    if (!eventToMove) {
      return {
        success: false,
        message: "I lost track of which event to move. Let's start over."
      };
    }
    
    log.info('agent', `Moving event "${eventToMove.summary}" to new time: "${userResponse}"`);
    
    // Parse the new time from user response
    // This is simplified - in production you'd want more robust parsing
    const newTime = this._parseTimeFromResponse(userResponse, eventToMove);
    
    if (!newTime) {
      return {
        success: true,
        needsInput: {
          prompt: `I didn't understand the time "${userResponse}". Please say something like "9am" or "tomorrow at 3pm".`,
          agentId: this.id,
          context: task.context
        }
      };
    }
    
    // Calculate duration of original event
    const originalStart = new Date(eventToMove.start?.dateTime || eventToMove.start?.date);
    const originalEnd = new Date(eventToMove.end?.dateTime || eventToMove.end?.date);
    const durationMs = originalEnd - originalStart;
    const durationMinutes = Math.round(durationMs / 60000);
    
    // Create the new event
    const createResult = await this._createEvent({
      title: eventToMove.summary,
      date: newTime.toISOString().split('T')[0],
      time: newTime.toTimeString().slice(0, 5),
      duration: `${durationMinutes}m`,
      description: eventToMove.description || '',
      location: eventToMove.location || ''
    });
    
    if (!createResult.success) {
      return {
        success: false,
        message: `I couldn't create the new event: ${createResult.message}`
      };
    }
    
    // Delete the old event
    const deleteResult = await this._deleteEvent({
      eventId: eventToMove.id,
      calendarId: eventToMove.calendarId || 'primary'
    });
    
    if (!deleteResult.success) {
      return {
        success: false,
        message: `Created new event but couldn't delete the old one: ${deleteResult.message}`
      };
    }
    
    const newTimeStr = newTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const newDateStr = newTime.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    
    return {
      success: true,
      message: `Done! Moved "${eventToMove.summary}" to ${newDateStr} at ${newTimeStr}. Conflict ${conflictIndex + 1} of ${totalConflicts} resolved.`
    };
  },

  /**
   * Parse a time reference from user response
   * @param {string} response - User's response like "9am", "tomorrow at 3pm"
   * @param {Object} originalEvent - Original event for date reference
   * @returns {Date|null}
   */
  _parseTimeFromResponse(response, originalEvent) {
    const now = new Date();
    const responseLower = response.toLowerCase();
    
    // Start with the original event's date as base
    let baseDate = new Date(originalEvent.start?.dateTime || originalEvent.start?.date);
    
    // Check for day references
    if (responseLower.includes('tomorrow')) {
      baseDate = new Date(now);
      baseDate.setDate(baseDate.getDate() + 1);
    } else if (responseLower.includes('today')) {
      baseDate = new Date(now);
    } else if (responseLower.includes('same day')) {
      // Keep original date
    }
    
    // Check for day names
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    for (let i = 0; i < days.length; i++) {
      if (responseLower.includes(days[i])) {
        // Find next occurrence of this day
        const daysUntil = (i - now.getDay() + 7) % 7 || 7;
        baseDate = new Date(now);
        baseDate.setDate(baseDate.getDate() + daysUntil);
        break;
      }
    }
    
    // Parse time
    const timeMatch = responseLower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
    if (!timeMatch) {
      return null;
    }
    
    let hours = parseInt(timeMatch[1]);
    const minutes = parseInt(timeMatch[2]) || 0;
    const ampm = timeMatch[3];
    
    // Handle 12-hour format
    if (ampm === 'pm' && hours !== 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
    // If no am/pm and hours <= 6, assume PM for business hours
    if (!ampm && hours >= 1 && hours <= 6) hours += 12;
    
    baseDate.setHours(hours, minutes, 0, 0);
    
    return baseDate;
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
          log.warn('agent', `Failed to fetch details for event ${event.id}`, { error: err.message });
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
      
      log.info('agent', 'Creating event', { requestBody });
      
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
        log.error('agent', 'Create event API error', { status: response.status, errorText });
        
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
      log.info('agent', 'Event created', { createdEvent });
      
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
      log.error('agent', 'Failed to create event', { error });
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
      
      log.info('agent', 'Deleting event', { targetEventId, from_calendar: calendarId });
      
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
        log.error('agent', 'Delete event API error', { status: response.status, errorText });
        
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
      log.info('agent', 'Event deleted successfully, result', { result });
      
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
      log.error('agent', 'Failed to delete event', { error });
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
      
      log.info('agent', 'Getting details for event', { targetEventId });
      
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
        log.error('agent', 'Get details API error', { status: response.status, errorText });
        
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
      log.info('agent', 'Event details retrieved', { eventDetails });
      
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'calendar-agent.js:2088',message:'GetDetails API success',data:{responseKeys:Object.keys(eventDetails||{}),hasEventProp:!!eventDetails?.event,hasAttendees:!!eventDetails?.attendees,responseSample:JSON.stringify(eventDetails).slice(0,500)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
      // #endregion
      
      // Format response based on what info was requested
      return this._formatEventDetails(eventDetails, infoRequested);
      
    } catch (error) {
      log.error('agent', 'Failed to get event details', { error });
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
      
      log.info('agent', `Finding availability with ${contactName} on ${targetDate.toDateString()}`);
      
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
      log.error('agent', 'Failed to find availability', { error });
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
    
    // Show next meeting as a single-event panel
    const html = renderAgentUI(this._buildEventsUISpec([next], 'Next Meeting'));
    
    return { success: true, message, html };
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
    const html = renderAgentUI(this._buildEventsUISpec(dayEvents, dayLabel.charAt(0).toUpperCase() + dayLabel.slice(1)));
    
    if (dayEvents.length === 0) {
      return { success: true, message: `You have no events ${dayLabel}.`, html };
    }
    
    const prefs = this._getPreferences();
    
    if (dayEvents.length === 1) {
      const e = dayEvents[0];
      const time = this._formatEventTime(e, prefs);
      return { success: true, message: `You have one meeting ${dayLabel}: "${e.summary}" at ${time}.`, html };
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
      message: `You have ${count} meetings ${dayLabel}: ${eventList}${more}.`,
      html,
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
    
    log.info('agent', `Looking for ${dayName}: ${targetDate.toDateString()} (${daysUntil} days from today)`);
    log.info('agent', `Date range: ${dayStart.toISOString()} to ${dayEnd.toISOString()}`);
    
    // Debug: show first few event dates
    if (events.length > 0) {
      const sampleDates = events.slice(0, 5).map(e => {
        const d = new Date(e.start?.dateTime || e.start?.date);
        return `${e.summary?.slice(0, 20)}: ${d.toDateString()}`;
      });
      log.info('agent', `Sample events`, { sampleDates });
    }
    
    const dayEvents = events.filter(e => {
      const start = new Date(e.start?.dateTime || e.start?.date);
      return start >= dayStart && start <= dayEnd;
    }).sort((a, b) => {
      return new Date(a.start?.dateTime || a.start?.date) - new Date(b.start?.dateTime || b.start?.date);
    });
    
    log.info('agent', `Found ${dayEvents.length} events for ${dayName}`);
    
    const dayLabel = dayName.charAt(0).toUpperCase() + dayName.slice(1);
    const html = renderAgentUI(this._buildEventsUISpec(dayEvents, dayLabel));
    
    if (dayEvents.length === 0) {
      return { success: true, message: `You have no events on ${dayLabel}.`, html };
    }
    
    const prefs = this._getPreferences();
    
    if (dayEvents.length === 1) {
      const e = dayEvents[0];
      const time = this._formatEventTime(e, prefs);
      return { success: true, message: `On ${dayLabel} you have: "${e.summary}" at ${time}.`, html };
    }
    
    const eventList = dayEvents.slice(0, 5).map(e => {
      const time = this._formatEventTime(e, prefs);
      return `"${e.summary}" at ${time}`;
    }).join(', ');
    
    const count = dayEvents.length;
    const more = count > 5 ? ` and ${count - 5} more` : '';
    
    return { 
      success: true, 
      message: `On ${dayLabel} you have ${count} meetings: ${eventList}${more}.`,
      html,
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
    
    const html = renderAgentUI(this._buildEventsUISpec(weekEvents, 'This Week'));
    
    if (weekEvents.length === 0) {
      return { success: true, message: "You have no events this week.", html };
    }
    
    if (weekEvents.length <= 3) {
      const eventList = weekEvents.map(e => {
        const time = this._formatEventTimeWithDay(e);
        return `"${e.summary}" ${time}`;
      }).join(', ');
      
      return { success: true, message: `This week you have: ${eventList}.`, html };
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
      message: `You have ${weekEvents.length} meetings this week: ${summary}.`,
      html,
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
  },

  // ==================== HUD UI RENDERING ====================

  /**
   * Calculate importance score (1-5) for an event.
   * Factors: attendee count, duration, description presence, recurring.
   */
  _calcImportance(event) {
    let score = 1;

    // Attendee count
    const attendees = event.attendees?.length || 0;
    if (attendees >= 6) score += 2;
    else if (attendees >= 3) score += 1;

    // Duration in minutes
    const start = new Date(event.start?.dateTime || event.start?.date);
    const end = new Date(event.end?.dateTime || event.end?.date || start);
    const durationMins = (end - start) / 60000;
    if (durationMins >= 60) score += 1;

    // Has description (usually means prepared meeting)
    if (event.description && event.description.trim().length > 20) score += 1;

    // Recurring gets a slight bump (established meeting)
    if (event.recurringEventId) score += 0.5;

    return Math.min(5, Math.round(score));
  },

  /**
   * Build a declarative eventList UI spec from raw API events.
   * Returns an object suitable for renderAgentUI({ type: 'eventList', ... }).
   *
   * @param {Array} events - Raw calendar API event objects
   * @param {string} label - Panel header (e.g. "Today", "This Week")
   * @returns {Object} eventList UI spec
   */
  _buildEventsUISpec(events, label) {
    const prefs = this._getPreferences();

    const mapped = (events || []).map(e => {
      const time = this._formatEventTime(e, prefs);
      const title = e.summary || 'Untitled';
      const importance = this._calcImportance(e);
      const recurring = !!e.recurringEventId;

      // Build attendee initials array
      const attendees = (e.attendees || []).map(a => {
        const email = a.email || '';
        const name = a.displayName || email.split('@')[0] || '?';
        return { initial: name.charAt(0).toUpperCase(), name };
      });

      return {
        time,
        title,
        recurring,
        importance,
        attendees,
        actionValue: `tell me more about ${title}`,
      };
    });

    return {
      type: 'eventList',
      title: label || 'Events',
      events: mapped,
    };
  },

  /**
   * Build an eventList UI spec from CalendarStore brief data.
   * The brief's timeline uses { title, start, end, duration, isRecurring, guests }
   * which differs from the Omnical API format.
   *
   * @param {Object} briefData - Output of generateMorningBrief()
   * @returns {Object} eventList UI spec
   */
  _buildBriefUISpec(briefData) {
    if (!briefData || !briefData.timeline || briefData.timeline.length === 0) {
      return { type: 'eventList', title: 'Today', events: [] };
    }

    const mapped = briefData.timeline.map(ev => {
      // Importance heuristic from brief timeline fields
      let importance = 1;
      const guests = ev.guests || [];
      if (guests.length >= 6) importance += 2;
      else if (guests.length >= 3) importance += 1;
      if (ev.duration >= 60) importance += 1;
      if (ev.isRecurring) importance += 0.5;
      importance = Math.min(5, Math.round(importance));

      const attendees = guests.map(g => {
        const name = typeof g === 'string' ? g : (g.displayName || g.email?.split('@')[0] || '?');
        return { initial: name.charAt(0).toUpperCase(), name };
      });

      return {
        time: ev.start || '',
        title: ev.title || 'Untitled',
        recurring: !!ev.isRecurring,
        importance,
        attendees,
        actionValue: `tell me more about ${ev.title || 'this event'}`,
      };
    });

    return {
      type: 'eventList',
      title: briefData.dayLabel || 'Today',
      events: mapped,
    };
  }
};

module.exports = calendarAgent;
