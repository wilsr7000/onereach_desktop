/**
 * Calendar Edit Agent
 *
 * Modifies existing calendar events:
 *   - Move events to a new time/date
 *   - Change location
 *   - Update title / description
 *   - Add/remove attendees
 *   - Verified edit (delete old → create updated → confirm)
 *   - Disambiguation when multiple events match
 */

'use strict';

const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();
const { getContactStore, isValidEmail } = require('../../lib/contact-store');

const { resolveEventDate, getEventsForDay, editEventVerified, fetchEventDetails } = require('../../lib/calendar-fetch');
const { confirmEdit, buildDayUISpec, formatEventTime, formatDateLabel } = require('../../lib/calendar-format');

const calendarEditAgent = {
  id: 'calendar-edit-agent',
  name: 'Calendar Edit',
  description:
    'Modifies existing calendar events -- move to a new time, change location, update attendees, rename, or change duration.',
  voice: 'alloy',
  acks: ["I'll update that for you.", 'Making the change now.'],
  categories: ['productivity', 'calendar'],
  keywords: [
    'move meeting',
    'reschedule',
    'change time',
    'change date',
    'update event',
    'modify event',
    'edit event',
    'change location',
    'add attendee',
    'remove attendee',
    'rename event',
    'push back meeting',
    'move to',
    'change duration',
  ],
  executionType: 'action',
  estimatedExecutionMs: 6000,
  dataSources: ['calendar-api', 'contact-store'],

  prompt: `Calendar Edit Agent modifies existing events on the user's calendar.

HIGH CONFIDENCE (0.90+):
- "Move my 3pm meeting to 4pm"
- "Reschedule the standup to Thursday"
- "Change the location of my lunch to Conference Room B"
- "Add Sarah to the design review"
- "Remove Jake from the team sync"
- "Rename the 2pm meeting to 'Product Demo'"
- "Make my 1-on-1 30 minutes instead of an hour"
- "Push back my next meeting by 30 minutes"

MEDIUM CONFIDENCE (0.60-0.89):
- "Change my calendar" (vague, might need clarification)

LOW CONFIDENCE (below 0.60) -- do NOT bid:
- "What's on my calendar?" → calendar-query-agent
- "Create a meeting" → calendar-create-agent
- "Cancel my meeting" / "Delete the standup" → calendar-delete-agent`,

  async execute(task) {
    const query = (task.content || task.text || task.query || '').trim();
    if (!query) return { success: false, message: 'What would you like to change about an event?' };

    const now = new Date();
    const context = task.context || {};

    try {
      // Multi-turn: user selected which event to edit
      if (context.calendarState === 'awaiting_edit_selection') {
        return await this._resumeEditSelection(query, context, now);
      }

      // Multi-turn: user provided attendee emails
      if (context.calendarState === 'awaiting_attendee_emails') {
        return await this._resumeAttendeeResolution(query, context, now);
      }

      // Step 1: Parse the edit intent
      const intent = await this._parseEditIntent(query, now);
      log.info('calendar-edit', 'Parsed edit intent', { intent });

      // Step 2: Find the target event
      const match = await this._findEvent(intent, now);

      if (!match) {
        return { success: false, message: `I couldn't find an event matching "${intent.searchText || query}".` };
      }

      if (Array.isArray(match)) {
        // Multiple matches: disambiguate
        const list = match
          .slice(0, 5)
          .map((e) => {
            const time = formatEventTime(e);
            return `"${e.summary}" at ${time}`;
          })
          .join(', ');

        return {
          success: true,
          needsInput: {
            prompt: `I found multiple events: ${list}. Which one did you mean?`,
            agentId: this.id,
            context: {
              calendarState: 'awaiting_edit_selection',
              matches: match.map((e) => ({ id: e.id, summary: e.summary })),
              changes: intent.changes,
            },
          },
        };
      }

      // Step 3: Build the changes
      const changes = await this._resolveChanges(intent.changes, match, now);

      // Step 4: Check if attendee changes need email resolution
      if (changes._unresolvedAttendees && changes._unresolvedAttendees.length > 0) {
        const nameList = changes._unresolvedAttendees.map((n) => `"${n}"`).join(', ');
        return {
          success: true,
          needsInput: {
            prompt: `I couldn't find email addresses for ${nameList}. Could you provide their emails?`,
            agentId: this.id,
            context: {
              calendarState: 'awaiting_attendee_emails',
              eventId: match.id,
              calendarId: 'primary',
              targetDate: intent.timeframe || 'today',
              changes,
            },
          },
        };
      }

      // Step 5: Execute the edit with verification
      const result = await editEventVerified(match.id, 'primary', intent.timeframe || 'today', changes);

      const message = confirmEdit(match.summary, changes, result.verified);

      let ui;
      if (result.day) {
        const targetDateStr = changes.date || (match.start?.dateTime || match.start?.date || '').slice(0, 10);
        ui = buildDayUISpec(result.day, formatDateLabel(new Date(targetDateStr + 'T12:00:00')));
      }

      return { success: true, message, ui };
    } catch (err) {
      log.error('calendar-edit', 'Execute failed', { error: err.message, stack: err.stack });
      return { success: false, message: `I couldn't update the event: ${err.message}` };
    }
  },

  // ────────────── Intent Parsing ──────────────

  async _parseEditIntent(query, now) {
    const dateStr = now.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    const result = await ai.json(
      `Parse this calendar edit request.

CURRENT CONTEXT:
- Today: ${dateStr} (${now.toISOString().slice(0, 10)})
- Time: ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}

USER REQUEST: "${query}"

Return JSON:
{
  "searchText": "<event name or description to find>",
  "timeframe": "<'today' | 'tomorrow' | day name | YYYY-MM-DD -- which day the event is currently on>",
  "changes": {
    "newDate": "<YYYY-MM-DD or relative like 'tomorrow', 'thursday' -- null if not changing date>",
    "newTime": "<HH:MM 24h -- null if not changing time>",
    "newDuration": "<like '30m', '1h' -- null if not changing>",
    "newTitle": "<new title -- null if not renaming>",
    "newLocation": "<new location -- null if not changing>",
    "addAttendees": ["<names or emails to add>"],
    "removeAttendees": ["<names or emails to remove>"]
  }
}

Rules:
- searchText: identify which event the user is referring to
- Only populate change fields the user explicitly mentioned
- Convert times to 24h format
- "push back 30 minutes" → calculate new time from context`,
      { profile: 'fast', feature: 'calendar-edit-intent' }
    );

    return {
      searchText: result.searchText || null,
      timeframe: result.timeframe || 'today',
      changes: result.changes || {},
    };
  },

  // ────────────── Event Search ──────────────

  async _findEvent(intent, now) {
    const { events } = await getEventsForDay(intent.timeframe, now);

    if (!intent.searchText) return events.length > 0 ? events : null;

    const searchLower = intent.searchText.toLowerCase();
    const matches = events.filter((e) => {
      const title = (e.summary || '').toLowerCase();
      return title.includes(searchLower) || searchLower.includes(title);
    });

    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];
    return matches; // Multiple: needs disambiguation
  },

  // ────────────── Change Resolution ──────────────

  async _resolveChanges(rawChanges, currentEvent, now) {
    const resolved = {};

    if (rawChanges.newDate) {
      try {
        resolved.date = resolveEventDate(rawChanges.newDate, now);
      } catch {
        /* keep null */
      }
    }

    if (rawChanges.newTime) resolved.time = rawChanges.newTime;
    if (rawChanges.newDuration) resolved.duration = rawChanges.newDuration;
    if (rawChanges.newTitle) resolved.title = rawChanges.newTitle;
    if (rawChanges.newLocation) resolved.location = rawChanges.newLocation;

    // Handle attendee additions
    if (rawChanges.addAttendees && rawChanges.addAttendees.length > 0) {
      const currentEmails = (currentEvent.attendees || []).map((a) => a.email).filter(Boolean);
      const store = getContactStore();
      const newEmails = [];
      const unresolvedNames = [];

      for (const guest of rawChanges.addAttendees) {
        if (isValidEmail(guest)) {
          newEmails.push(guest);
        } else {
          const match = store.findContact(guest);
          if (match && match.email) {
            newEmails.push(match.email);
          } else {
            unresolvedNames.push(guest);
          }
        }
      }

      if (unresolvedNames.length > 0) {
        resolved._unresolvedAttendees = unresolvedNames;
      }

      resolved.guests = [...new Set([...currentEmails, ...newEmails])];
    }

    // Handle attendee removals
    if (rawChanges.removeAttendees && rawChanges.removeAttendees.length > 0) {
      const currentEmails = resolved.guests || (currentEvent.attendees || []).map((a) => a.email).filter(Boolean);
      const store = getContactStore();
      const removeEmails = new Set();

      for (const guest of rawChanges.removeAttendees) {
        if (isValidEmail(guest)) {
          removeEmails.add(guest.toLowerCase());
        } else {
          const match = store.findContact(guest);
          if (match && match.email) {
            removeEmails.add(match.email.toLowerCase());
          }
          // Also try matching by name in current attendees
          const nameMatch = (currentEvent.attendees || []).find((a) =>
            (a.displayName || '').toLowerCase().includes(guest.toLowerCase())
          );
          if (nameMatch?.email) removeEmails.add(nameMatch.email.toLowerCase());
        }
      }

      resolved.guests = (resolved.guests || currentEmails).filter((e) => !removeEmails.has(e.toLowerCase()));
    }

    return resolved;
  },

  // ────────────── Multi-turn Handlers ──────────────

  async _resumeEditSelection(query, context, now) {
    const matches = context.matches || [];
    const queryLower = query.toLowerCase();

    const selected = matches.find((m) => queryLower.includes(m.summary.toLowerCase()));
    if (!selected) {
      return { success: false, message: "I couldn't match that to any of the options. Could you be more specific?" };
    }

    const event = await fetchEventDetails(selected.id);
    const changes = await this._resolveChanges(context.changes, event, now);

    const result = await editEventVerified(selected.id, 'primary', 'today', changes);
    const message = confirmEdit(selected.summary, changes, result.verified);

    return { success: true, message };
  },

  async _resumeAttendeeResolution(query, context, _now) {
    const emailPattern = /[\w.+-]+@[\w.-]+\.\w+/g;
    const newEmails = query.match(emailPattern) || [];

    const changes = context.changes || {};
    changes.guests = [...(changes.guests || []), ...newEmails];
    delete changes._unresolvedAttendees;

    const result = await editEventVerified(
      context.eventId,
      context.calendarId || 'primary',
      context.targetDate || 'today',
      changes
    );

    return {
      success: true,
      message: confirmEdit('the event', changes, result.verified),
    };
  },
};

module.exports = calendarEditAgent;
