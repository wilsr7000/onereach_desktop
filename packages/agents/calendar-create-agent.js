/**
 * Calendar Create Agent
 *
 * Creates new calendar events with:
 *   - LLM-based detail extraction (title, date, time, duration, location, guests)
 *   - Verified creation (create → fetch → confirm it exists)
 *   - Guest resolution via contact store (fuzzy name matching → email)
 *   - Multi-turn flow for missing required fields
 *   - Recurring event support
 */

'use strict';

const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();
const { getAgentMemory } = require('../../lib/agent-memory-store');
const { getContactStore, isValidEmail } = require('../../lib/contact-store');

const { resolveEventDate, createEventVerified } = require('../../lib/calendar-fetch');
const { buildDayUISpec, confirmCreate, formatDateLabel } = require('../../lib/calendar-format');

const calendarCreateAgent = {
  id: 'calendar-create-agent',
  name: 'Calendar Create',
  description:
    'Creates new calendar events -- extracts event details from natural language, resolves guest names to emails, and verifies the event was added.',
  voice: 'alloy',
  acks: ["I'll set that up.", 'Creating the event now.'],
  categories: ['productivity', 'calendar'],
  keywords: [
    'create event',
    'add event',
    'schedule meeting',
    'book meeting',
    'set up a meeting',
    'add to calendar',
    'create a meeting',
    'new event',
    'plan a meeting',
    'schedule a call',
    'put on my calendar',
    'add a reminder',
    'make a meeting',
  ],
  executionType: 'action',
  estimatedExecutionMs: 5000,
  dataSources: ['calendar-api', 'contact-store'],

  prompt: `Calendar Create Agent creates new events on the user's calendar.

HIGH CONFIDENCE (0.90+):
- "Create a meeting with John at 3pm tomorrow"
- "Add a standup to my calendar for Monday at 9am"
- "Schedule a call with Sarah for next Friday at 2"
- "Put a lunch on my calendar tomorrow at noon"
- "Set up a weekly team sync on Tuesdays at 10am"
- "Book a meeting room for 2pm"

MEDIUM CONFIDENCE (0.60-0.89):
- "Remind me about the dentist at 4pm" (might be a reminder, not calendar)

LOW CONFIDENCE (below 0.60) -- do NOT bid:
- "What's on my calendar?" → calendar-query-agent
- "Delete the standup" → calendar-delete-agent
- "Move my meeting to 3pm" → calendar-edit-agent
- General questions about schedule or availability`,

  async execute(task) {
    const query = (task.text || task.query || '').trim();
    if (!query) return { success: false, message: 'What event would you like to create?' };

    const now = new Date();
    const _memory = getAgentMemory('calendar-create-agent');
    const context = task.context || {};

    try {
      // Multi-turn: resume from awaiting guest emails
      if (context.calendarState === 'awaiting_guest_emails') {
        return await this._resumeGuestResolution(query, context, now);
      }

      // Multi-turn: resume from awaiting missing fields
      if (context.calendarState === 'awaiting_event_fields') {
        return await this._resumeMissingFields(query, context, now);
      }

      // Step 1: Extract event details via LLM
      const details = await this._extractDetails(query, now);
      log.info('calendar-create', 'Extracted details', { details });

      // Step 2: Validate required fields, ask if missing
      if (!details.title) {
        return {
          success: true,
          needsInput: {
            prompt: 'What should I call this event?',
            agentId: this.id,
            context: { calendarState: 'awaiting_event_fields', pendingEvent: details, missingField: 'title' },
          },
        };
      }

      if (!details.date) {
        return {
          success: true,
          needsInput: {
            prompt: 'What date should I put this on?',
            agentId: this.id,
            context: { calendarState: 'awaiting_event_fields', pendingEvent: details, missingField: 'date' },
          },
        };
      }

      if (!details.time) {
        return {
          success: true,
          needsInput: {
            prompt: 'What time should the event start?',
            agentId: this.id,
            context: { calendarState: 'awaiting_event_fields', pendingEvent: details, missingField: 'time' },
          },
        };
      }

      // Step 3: Resolve date
      const resolvedDate = resolveEventDate(details.date, now);
      details.date = resolvedDate;

      // Step 4: Resolve guests
      if (details.guests && details.guests.length > 0) {
        const guestResult = this._resolveGuests(details.guests);
        if (guestResult.needsInput) {
          return {
            success: true,
            needsInput: {
              prompt: guestResult.prompt,
              agentId: this.id,
              context: {
                calendarState: 'awaiting_guest_emails',
                pendingEvent: details,
                resolvedGuests: guestResult.resolved,
                unresolvedNames: guestResult.unresolved,
              },
            },
          };
        }
        details.guests = guestResult.resolved;
      }

      // Step 5: Create with verification
      const result = await createEventVerified({
        title: details.title,
        date: details.date,
        time: details.time,
        duration: details.duration || '60m',
        location: details.location || '',
        description: details.description || '',
        guests: details.guests || [],
      });

      const message = confirmCreate(details, result.verified);

      // Record guest usage
      if (details.guests && details.guests.length > 0) {
        try {
          const store = getContactStore();
          for (const email of details.guests) {
            store.recordUsage(email);
          }
        } catch {
          /* non-fatal */
        }
      }

      // Build HUD to show the updated day
      let ui;
      if (result.day) {
        ui = buildDayUISpec(result.day, formatDateLabel(new Date(`${details.date}T12:00:00`)));
      }

      return { success: true, message, ui };
    } catch (err) {
      log.error('calendar-create', 'Execute failed', { error: err.message, stack: err.stack });
      return { success: false, message: `I couldn't create the event: ${err.message}` };
    }
  },

  // ────────────── LLM Detail Extraction ──────────────

  async _extractDetails(query, now) {
    const dateStr = now.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

    const result = await ai.json(
      `Extract calendar event details from this request.

CURRENT CONTEXT:
- Today: ${dateStr} (${now.toISOString().slice(0, 10)})
- Time: ${timeStr}

USER REQUEST: "${query}"

Return JSON:
{
  "title": "<event title>",
  "date": "<'today', 'tomorrow', day name, or YYYY-MM-DD>",
  "time": "<HH:MM in 24-hour format>",
  "duration": "<like '30m', '1h', '90m' -- default '60m'>",
  "location": "<optional location or empty string>",
  "description": "<optional description or empty string>",
  "guests": ["<name or email>", "..."],
  "recurring": "<null | 'daily' | 'weekly' | 'biweekly' | 'monthly'>"
}

Rules:
- Extract only what the user explicitly mentioned
- Leave fields null/empty if not mentioned (do NOT guess)
- Convert times to 24-hour format: "3pm" → "15:00", "9am" → "09:00"
- "noon" → "12:00", "midnight" → "00:00"
- Guests can be names ("John") or emails ("john@example.com")`,
      { profile: 'fast', feature: 'calendar-create-extract' }
    );

    return {
      title: result.title || null,
      date: result.date || null,
      time: result.time || null,
      duration: result.duration || '60m',
      location: result.location || '',
      description: result.description || '',
      guests: result.guests || [],
      recurring: result.recurring || null,
    };
  },

  // ────────────── Guest Resolution ──────────────

  _resolveGuests(guestNames) {
    const store = getContactStore();
    const resolved = [];
    const unresolved = [];

    for (const guest of guestNames) {
      if (isValidEmail(guest)) {
        resolved.push(guest);
        continue;
      }

      const match = store.findContact(guest);
      if (match && match.email) {
        resolved.push(match.email);
      } else {
        unresolved.push(guest);
      }
    }

    if (unresolved.length > 0) {
      const nameList = unresolved.map((n) => `"${n}"`).join(', ');
      return {
        resolved,
        unresolved,
        needsInput: true,
        prompt: `I couldn't find email addresses for ${nameList}. Could you provide their emails?`,
      };
    }

    return { resolved, unresolved: [], needsInput: false };
  },

  // ────────────── Multi-turn Handlers ──────────────

  async _resumeGuestResolution(query, context, now) {
    const details = context.pendingEvent;
    const previousResolved = context.resolvedGuests || [];

    // Parse email addresses from the user's response
    const emailPattern = /[\w.+-]+@[\w.-]+\.\w+/g;
    const newEmails = query.match(emailPattern) || [];

    const allGuests = [...previousResolved, ...newEmails];
    details.guests = allGuests;

    const resolvedDate = resolveEventDate(details.date, now);
    details.date = resolvedDate;

    const result = await createEventVerified({
      title: details.title,
      date: details.date,
      time: details.time,
      duration: details.duration || '60m',
      location: details.location || '',
      description: details.description || '',
      guests: allGuests,
    });

    const message = confirmCreate(details, result.verified);

    try {
      const store = getContactStore();
      for (const email of allGuests) {
        store.recordUsage(email);
      }
    } catch {
      /* non-fatal */
    }

    return { success: true, message };
  },

  async _resumeMissingFields(query, context, _now) {
    const details = context.pendingEvent;
    const field = context.missingField;

    if (field === 'title') details.title = query;
    else if (field === 'date') details.date = query;
    else if (field === 'time') details.time = query;

    // Re-run execute with the filled-in details
    return this.execute({
      text: `Create "${details.title}" on ${details.date} at ${details.time}${details.location ? ' at ' + details.location : ''}${details.duration ? ' for ' + details.duration : ''}`,
      context: {},
    });
  },
};

module.exports = calendarCreateAgent;
