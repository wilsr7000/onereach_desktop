/**
 * Calendar Query Agent
 *
 * Read-only calendar operations:
 *   - Check schedule for any timeframe (today, tomorrow, this week, specific date)
 *   - Find the next meeting
 *   - Check availability and free slots
 *   - Get event details, attendees, locations
 *   - Join meeting / get meeting link
 *   - Morning brief contributions
 *
 * Architecture:
 *   User query → LLM intent parse → calendar-fetch → calendar-data → calendar-format → HUD
 *   On bad results: eval → retry with corrected timeframe (max 1 retry)
 */

'use strict';

const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();
const { getAgentMemory } = require('../../lib/agent-memory-store');
const { getTimeContext } = require('../../lib/thinking-agent');
const { renderAgentUI } = require('../../lib/agent-ui-renderer');
const { getCalendarStore } = require('../../lib/calendar-store');

const { getEventsForDay, fetchEventDetails } = require('../../lib/calendar-fetch');
const { analyzeDay, getNextEvent, findFreeSlots, findConflicts } = require('../../lib/calendar-data');
const {
  extractMeetingLink,
  buildDayUISpec,
  spokenDaySummary,
  formatEventTime,
  formatEventTimeRange,
} = require('../../lib/calendar-format');

const calendarQueryAgent = {
  id: 'calendar-query-agent',
  name: 'Calendar Query',
  description:
    'Checks your calendar and schedule -- answers questions about meetings, availability, free time, and upcoming events for any time period. Can find and open meeting links.',
  voice: 'alloy',
  acks: ['Checking your calendar.', 'Let me look at your schedule.'],
  categories: ['productivity', 'calendar'],
  keywords: [
    'calendar',
    'schedule',
    'meeting',
    'meetings',
    'event',
    'events',
    'today',
    'tomorrow',
    'this week',
    'next week',
    'availability',
    'free time',
    'free slots',
    'busy',
    'what do I have',
    'next meeting',
    'join meeting',
    'meeting link',
    'zoom link',
    'how many meetings',
    'am I free',
    'calendar check',
    'what time is my',
    'when is my',
    'morning brief',
  ],
  executionType: 'action',
  estimatedExecutionMs: 3000,
  dataSources: ['calendar-api', 'calendar-store'],

  prompt: `Calendar Query Agent answers questions about the user's schedule and meetings.

HIGH CONFIDENCE (0.90+):
- "What's on my calendar today/tomorrow/this week?"
- "What meetings do I have today?"
- "When is my next meeting?"
- "Am I free at 2pm?" / "What does my afternoon look like?"
- "Do I have any conflicts this week?"
- "Join my meeting" / "Get my meeting link" / "Open the Zoom"
- "How many meetings do I have today?"
- "What's first thing tomorrow morning?"
- "Tell me about my 3pm meeting"
- "Check my schedule for Friday"

MEDIUM CONFIDENCE (0.60-0.89):
- "What's going on today?" (might be general, but calendar is a strong candidate)
- "Brief me" (daily-brief-agent should win, but calendar contributes)

LOW CONFIDENCE (below 0.60) -- do NOT bid:
- "Create a meeting" / "Add an event" → calendar-create-agent
- "Cancel my meeting" / "Delete the standup" → calendar-delete-agent
- "Move my meeting to 3pm" / "Change the location" → calendar-edit-agent
- Anything about creating, modifying, or deleting events`,

  /**
   * Briefing contribution. Accepts optional { targetDate, dateLabel } from daily-brief-agent.
   */
  async getBriefing(context = {}) {
    try {
      const store = getCalendarStore();
      const date = context?.targetDate || null;
      const label = context?.dateLabel || 'today';
      const brief = await store.generateMorningBrief(date);
      if (!brief || !brief.timeline || brief.timeline.length === 0) {
        return { section: 'Calendar', priority: 3, content: `No meetings scheduled ${label}.` };
      }
      const count = brief.timeline.length;
      const firstMeeting = brief.timeline[0];
      let content = `${count} meeting${count !== 1 ? 's' : ''} ${label}.`;
      if (firstMeeting) content += ` First: "${firstMeeting.title}" at ${firstMeeting.start}.`;
      if (brief.conflicts?.length) content += ` ${brief.conflicts.length} conflict(s).`;
      if (brief.backToBack?.length) content += ` ${brief.backToBack.length} back-to-back.`;
      return { section: 'Calendar', priority: 3, content };
    } catch (err) {
      log.error('calendar-query', 'getBriefing failed', { error: err.message });
      return { section: 'Calendar', priority: 3, content: 'Calendar unavailable.' };
    }
  },

  async execute(task) {
    const query = (task.content || task.text || task.query || '').trim();
    if (!query) return { success: false, message: 'What would you like to know about your calendar?' };

    const now = new Date();
    const _memory = getAgentMemory('calendar-query-agent');

    try {
      // Step 1: LLM parses the query into a structured intent
      const intent = await this._parseIntent(query, now);
      log.info('calendar-query', 'Parsed intent', { intent });

      // Step 2: Route to the correct handler
      switch (intent.action) {
        case 'check_schedule':
          return await this._handleCheckSchedule(intent, now, task);
        case 'next_meeting':
          return await this._handleNextMeeting(now, task);
        case 'check_availability':
          return await this._handleAvailability(intent, now, task);
        case 'event_details':
          return await this._handleEventDetails(intent, now, task);
        case 'join_meeting':
          return await this._handleJoinMeeting(intent, now, task);
        case 'conflicts':
          return await this._handleConflicts(intent, now, task);
        case 'free_slots':
          return await this._handleFreeSlots(intent, now, task);
        default:
          return await this._handleCheckSchedule({ ...intent, timeframe: intent.timeframe || 'today' }, now, task);
      }
    } catch (err) {
      log.error('calendar-query', 'Execute failed', { error: err.message, stack: err.stack });
      return { success: false, message: `I had trouble checking your calendar: ${err.message}` };
    }
  },

  // ────────────── Intent Parsing ──────────────

  async _parseIntent(query, now) {
    const timeContext = getTimeContext();
    const dateStr = now.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    const result = await ai.json(
      `Parse this calendar query into a structured intent.

CURRENT CONTEXT:
- Today: ${dateStr} (${now.toISOString().slice(0, 10)})
- Time: ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
- Time of day: ${timeContext.timeOfDay || 'day'}

USER QUERY: "${query}"

Return JSON with these fields:
{
  "action": "check_schedule" | "next_meeting" | "check_availability" | "event_details" | "join_meeting" | "conflicts" | "free_slots",
  "timeframe": "today" | "tomorrow" | "this_week" | "next_week" | "this_month" | "<day_name>" | "<YYYY-MM-DD>",
  "searchText": "<optional: specific event/meeting name to find>",
  "timeSlot": "<optional: specific time like '2pm' or '14:00' for availability checks>"
}

Rules:
- "what's on my calendar" / "what meetings" / "check my schedule" → check_schedule
- "next meeting" / "what's next" → next_meeting
- "am I free at" / "available at" / "what's at 2pm" → check_availability
- "tell me about" / "details on" / "who's in" → event_details
- "join" / "meeting link" / "zoom link" / "open the call" → join_meeting
- "conflicts" / "overlapping" / "double booked" → conflicts
- "free time" / "free slots" / "when am I free" → free_slots
- Default timeframe is "today" if not specified`,
      { profile: 'fast', feature: 'calendar-query-intent' }
    );

    return {
      action: result.action || 'check_schedule',
      timeframe: result.timeframe || 'today',
      searchText: result.searchText || null,
      timeSlot: result.timeSlot || null,
    };
  },

  // ────────────── Handlers ──────────────

  async _handleCheckSchedule(intent, now, task) {
    const { events, dateRange } = await getEventsForDay(intent.timeframe, now);
    const day = analyzeDay(events, dateRange.start, now);

    if (day.summary.total === 0) {
      return {
        success: true,
        message: `Your calendar is clear ${dateRange.label.toLowerCase()}.`,
      };
    }

    // Build HUD panel + spoken summary
    const uiSpec = buildDayUISpec(day, dateRange.label);
    const spoken = spokenDaySummary(day, dateRange.label);

    if (task.renderUI && typeof renderAgentUI === 'function') {
      try {
        renderAgentUI(uiSpec, task.windowId || task.hudWindowId);
      } catch (_e) {
        /* non-fatal */
      }
    }

    return {
      success: true,
      message: spoken,
      ui: uiSpec,
    };
  },

  async _handleNextMeeting(now, _task) {
    const { events } = await getEventsForDay('today', now);
    const next = getNextEvent(events, now);

    if (!next) {
      return { success: true, message: 'You have no more meetings today.' };
    }

    const raw = next.event;
    const title = raw.summary || 'Untitled';
    const time = formatEventTime(raw);
    const start = next.startTime || new Date(raw.start?.dateTime || raw.start?.date);
    const diffMs = start - now;
    const mins = Math.round(diffMs / 60000);

    let msg;
    if (diffMs <= 0) {
      msg = `"${title}" is happening now (started at ${time}).`;
    } else if (mins <= 5) {
      msg = `"${title}" starts in ${mins} minute${mins !== 1 ? 's' : ''}.`;
    } else if (mins <= 60) {
      msg = `Your next meeting is "${title}" at ${time} (${mins} minutes from now).`;
    } else {
      msg = `Your next meeting is "${title}" at ${time}.`;
    }

    const meetingLink = extractMeetingLink(raw);
    if (meetingLink.url && diffMs < 600000) {
      msg += ` ${meetingLink.label}: ${meetingLink.url}`;
    }

    return { success: true, message: msg };
  },

  async _handleAvailability(intent, now, _task) {
    const { events, dateRange } = await getEventsForDay(intent.timeframe, now);
    const day = analyzeDay(events, dateRange.start, now);

    if (intent.timeSlot) {
      // Check specific time
      const slotTime = this._parseTimeSlot(intent.timeSlot, dateRange.start);
      if (slotTime) {
        const busy = day.all.find((e) => {
          const s = new Date(e.event.start?.dateTime || e.event.start?.date);
          const en = new Date(e.event.end?.dateTime || e.event.end?.date);
          return slotTime >= s && slotTime < en;
        });

        if (busy) {
          return {
            success: true,
            message: `You have "${busy.event.summary}" at that time (${formatEventTimeRange(busy.event)}).`,
          };
        } else {
          return { success: true, message: `You're free at ${intent.timeSlot} ${dateRange.label.toLowerCase()}.` };
        }
      }
    }

    // General availability
    const freeSlots = day.freeSlots || [];
    if (freeSlots.length === 0) {
      return { success: true, message: `You're fully booked ${dateRange.label.toLowerCase()}.` };
    }

    const slotSummary = freeSlots
      .slice(0, 4)
      .map((s) => {
        const start = new Date(s.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        const end = new Date(s.end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        return `${start} - ${end}`;
      })
      .join(', ');

    return {
      success: true,
      message: `Free slots ${dateRange.label.toLowerCase()}: ${slotSummary}${freeSlots.length > 4 ? ` (and ${freeSlots.length - 4} more)` : ''}.`,
    };
  },

  async _handleEventDetails(intent, now, _task) {
    if (!intent.searchText) {
      return { success: false, message: 'Which event would you like details about?' };
    }

    const { events } = await getEventsForDay(intent.timeframe, now);
    const searchLower = intent.searchText.toLowerCase();
    const match = events.find((e) => {
      const title = (e.summary || '').toLowerCase();
      return title.includes(searchLower) || searchLower.includes(title);
    });

    if (!match) {
      return { success: false, message: `I couldn't find an event matching "${intent.searchText}".` };
    }

    // Fetch full details
    let detailed = match;
    try {
      detailed = await fetchEventDetails(match.id);
    } catch {
      /* use basic event */
    }

    const time = formatEventTimeRange(detailed);
    const title = detailed.summary || 'Untitled';
    const location = detailed.location || 'No location set';
    const attendees = (detailed.attendees || []).map((a) => a.displayName || a.email).join(', ') || 'Just you';
    const desc = detailed.description ? detailed.description.slice(0, 200) : 'No description';
    const meetingLink = extractMeetingLink(detailed);

    let msg = `"${title}" at ${time}. Location: ${location}. Attendees: ${attendees}.`;
    if (desc !== 'No description') msg += ` Notes: ${desc}`;
    if (meetingLink.url) msg += ` ${meetingLink.label}: ${meetingLink.url}`;

    return { success: true, message: msg };
  },

  async _handleJoinMeeting(intent, now, _task) {
    const { events } = await getEventsForDay('today', now);

    // Find current or next meeting with a link
    let target = null;

    if (intent.searchText) {
      const searchLower = intent.searchText.toLowerCase();
      target = events.find((e) => (e.summary || '').toLowerCase().includes(searchLower));
    }

    if (!target) {
      // Find current meeting
      target = events.find((e) => {
        const s = new Date(e.start?.dateTime || e.start?.date);
        const en = new Date(e.end?.dateTime || e.end?.date);
        return now >= s && now < en;
      });
    }

    if (!target) {
      // Find next meeting within 15 minutes
      target = events.find((e) => {
        const s = new Date(e.start?.dateTime || e.start?.date);
        const diff = s - now;
        return diff > 0 && diff < 900000;
      });
    }

    if (!target) {
      target = getNextEvent(events, now);
    }

    if (!target) {
      return { success: false, message: 'No upcoming meetings found.' };
    }

    // Fetch full details to get meeting links
    let detailed = target;
    try {
      detailed = await fetchEventDetails(target.id);
    } catch {
      /* use basic */
    }

    const meetingLink = extractMeetingLink(detailed);
    if (!meetingLink.url) {
      return {
        success: true,
        message: `"${detailed.summary}" doesn't have a meeting link. It might be an in-person meeting${detailed.location ? ` at ${detailed.location}` : ''}.`,
      };
    }

    return {
      success: true,
      message: `${meetingLink.label} for "${detailed.summary}": ${meetingLink.url}`,
      action: { type: 'openUrl', url: meetingLink.url },
    };
  },

  async _handleConflicts(intent, now, _task) {
    const { events, dateRange } = await getEventsForDay(intent.timeframe, now);
    const conflicts = findConflicts(events);

    if (conflicts.length === 0) {
      return { success: true, message: `No scheduling conflicts ${dateRange.label.toLowerCase()}.` };
    }

    const conflictList = conflicts
      .slice(0, 5)
      .map((c) => {
        const [a, b] = c.events;
        return `"${a.summary}" and "${b.summary}" overlap at ${formatEventTime(a)}`;
      })
      .join('; ');

    return {
      success: true,
      message: `${conflicts.length} conflict${conflicts.length > 1 ? 's' : ''} ${dateRange.label.toLowerCase()}: ${conflictList}.`,
    };
  },

  async _handleFreeSlots(intent, now, _task) {
    const { events, dateRange } = await getEventsForDay(intent.timeframe, now);
    const freeSlots = findFreeSlots(events, dateRange.start, dateRange.end);

    if (freeSlots.length === 0) {
      return { success: true, message: `You're fully booked ${dateRange.label.toLowerCase()}.` };
    }

    const slotList = freeSlots
      .slice(0, 5)
      .map((s) => {
        const start = new Date(s.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        const end = new Date(s.end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        const mins = Math.round((new Date(s.end) - new Date(s.start)) / 60000);
        return `${start}-${end} (${mins}min)`;
      })
      .join(', ');

    return {
      success: true,
      message: `Free slots ${dateRange.label.toLowerCase()}: ${slotList}.`,
    };
  },

  // ────────────── Helpers ──────────────

  _parseTimeSlot(timeStr, targetDate) {
    if (!timeStr) return null;
    const match = timeStr.match(/(\d{1,2}):?(\d{2})?\s*(am|pm)?/i);
    if (!match) return null;

    let hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2] || '0', 10);
    const period = (match[3] || '').toLowerCase();

    if (period === 'pm' && hours < 12) hours += 12;
    if (period === 'am' && hours === 12) hours = 0;

    const d = new Date(targetDate);
    d.setHours(hours, minutes, 0, 0);
    return d;
  },
};

module.exports = calendarQueryAgent;
