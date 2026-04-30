/**
 * Calendar Mutate Agent
 *
 * Phase 2a (calendar overhaul): merger of the three former calendar mutation
 * agents (calendar-create-agent, calendar-edit-agent, calendar-delete-agent).
 *
 * The four calendar agents (query / create / edit / delete) shared memory,
 * classifier, fuzzy resolver, contact-store, and Omnical client. The only
 * meaningful boundary is read vs write -- so query stays separate (preserving
 * arbitration boundaries in the bidder) while create/edit/delete collapse
 * here under one dispatcher.
 *
 * Pipeline:
 *   1. Multi-turn resumption (context.calendarState routes directly to the
 *      paused flow).
 *   2. Fresh request: a small `_classifyOperation()` LLM call decides
 *      create/edit/delete.
 *   3. Dispatch to `_handleCreate` / `_handleEdit` / `_handleDelete` -- each
 *      preserves the verbatim prompts and verified-mutation flow of its
 *      predecessor agent. No behaviour change vs the three-agent layout.
 *
 * The sub-handlers each call their own per-operation extractor LLM (titles,
 * dates, search-text, change set, etc.) so prompt accuracy matches the prior
 * single-purpose agents. The classifier adds ~one extra fast LLM call per
 * fresh mutation request -- acceptable overhead for the consolidation.
 */

'use strict';

const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();
const { getAgentMemory } = require('../../lib/agent-memory-store');
const { getCalendarMemory } = require('../../lib/calendar-memory');
const { getContactStore, isValidEmail } = require('../../lib/contact-store');

const {
  resolveEventDate,
  getEventsForDay,
  fetchEventDetails,
  createEventVerified,
  editEventVerified,
  deleteEventVerified,
} = require('../../lib/calendar-fetch');

const {
  buildDayUISpec,
  formatEventTime,
  formatDateLabel,
  confirmCreate,
  confirmEdit,
  confirmDelete,
} = require('../../lib/calendar-format');

const { analyzeDay } = require('../../lib/calendar-data');

const calendarMutateAgent = {
  id: 'calendar-mutate-agent',
  name: 'Calendar Mutate',
  description:
    'Creates, modifies, and deletes calendar events. Routes the request to the right operation, extracts details, resolves attendees, and verifies the change before reporting back.',
  voice: 'alloy',
  acks: ["I'll take care of that.", 'Updating your calendar.'],
  categories: ['productivity', 'calendar'],
  keywords: [
    // Create
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
    // Edit
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
    // Delete
    'delete event',
    'cancel event',
    'remove event',
    'cancel meeting',
    'delete meeting',
    'remove meeting',
    'cancel the',
    'delete the',
    'remove the',
    'skip meeting',
    'drop the meeting',
  ],
  executionType: 'action',
  estimatedExecutionMs: 6000,
  dataSources: ['calendar-api', 'contact-store'],

  prompt: `Calendar Mutate Agent creates, edits, and deletes events on the user's calendar.

Capabilities:
- Create new events with title, time, attendees, location, recurring patterns
- Reschedule events to a different time or date
- Change event titles, locations, durations, and attendees
- Cancel or delete events
- Multi-turn flows for missing fields and disambiguation

This agent modifies calendar events. For querying schedule, finding events, or checking availability, route to calendar-query-agent.`,

  // ── Memory (Phase 2d) ─────────────────────────────────────────────────
  //
  // Same pattern as calendar-query-agent: per-agent memory file for the
  // learning loop's Learning Notes, plus the shared calendar-memory facade
  // for cross-agent state (Aliases, People, Engagement Stats, etc.).
  memory: null,
  calendarMemory: null,

  async initialize() {
    if (!this.memory) {
      this.memory = getAgentMemory('calendar-mutate-agent', { displayName: 'Calendar Mutate' });
      try {
        await this.memory.load();
      } catch (err) {
        log.warn('calendar-mutate', 'Per-agent memory load failed (non-fatal)', { error: err.message });
      }
    }
    if (!this.calendarMemory) {
      this.calendarMemory = getCalendarMemory();
      try {
        await this.calendarMemory.load();
      } catch (err) {
        log.warn('calendar-mutate', 'Shared calendar-memory load failed (non-fatal)', { error: err.message });
      }
    }
    return { memory: this.memory, calendarMemory: this.calendarMemory };
  },

  // ────────────── Entry point ──────────────

  async execute(task) {
    const query = (task.content || task.text || task.query || '').trim();
    if (!query) {
      return { success: false, message: 'What would you like me to do with your calendar?' };
    }

    const now = new Date();
    const context = task.context || {};

    // Phase 2d: lazy-init memory on first execute. Replaces the dead
    // `_memory = getAgentMemory(...)` pattern from the legacy create/edit/delete
    // agents that loaded but never used memory.
    await this.initialize();

    try {
      // Multi-turn resumption -- the operation is implicit in the saved state.
      switch (context.calendarState) {
        case 'awaiting_guest_emails':
          return await this._resumeGuestResolution(query, context, now);
        case 'awaiting_event_fields':
          return await this._resumeMissingFields(query, context, now);
        case 'awaiting_edit_selection':
          return await this._resumeEditSelection(query, context, now);
        case 'awaiting_attendee_emails':
          return await this._resumeAttendeeResolution(query, context, now);
        case 'awaiting_delete_selection':
          return await this._resumeDeleteSelection(query, context, now);
        case 'awaiting_delete_confirmation':
          return await this._resumeDeleteConfirmation(query, context, now);
        default:
          break;
      }

      // Fresh request: classify the operation, then dispatch.
      const operation = await this._classifyOperation(query, now);
      log.info('calendar-mutate', 'Classified operation', { operation });

      switch (operation) {
        case 'create':
          return await this._handleCreate(query, now);
        case 'edit':
          return await this._handleEdit(query, now);
        case 'delete':
          return await this._handleDelete(query, now);
        default:
          return {
            success: false,
            message: 'Did you want me to create, change, or cancel an event?',
          };
      }
    } catch (err) {
      log.error('calendar-mutate', 'Execute failed', { error: err.message, stack: err.stack });
      return { success: false, message: `I couldn't update your calendar: ${err.message}` };
    }
  },

  // ────────────── Operation classifier ──────────────

  async _classifyOperation(query, now) {
    const dateStr = now.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });

    const result = await ai.json(
      `Classify this calendar request as create, edit, or delete.

CURRENT CONTEXT:
- Today: ${dateStr}

USER REQUEST: "${query}"

Return JSON: { "operation": "create" | "edit" | "delete" }

Rules:
- create: user wants to add a new event ("schedule X", "add X", "book X", "set up X", "put X on my calendar")
- edit: user wants to change an existing event ("move X", "reschedule X", "change X", "rename X", "push back X")
- delete: user wants to remove an event ("cancel X", "delete X", "remove X", "drop X", "skip X")
- Default to "create" only when truly ambiguous; prefer edit/delete when their verbs appear.`,
      { profile: 'fast', feature: 'calendar-mutate-classify' }
    );

    const op = (result.operation || '').toLowerCase();
    if (op === 'create' || op === 'edit' || op === 'delete') return op;
    return 'create';
  },

  // ════════════════════════════════════════════════════════════════════════════
  // CREATE FLOW (former calendar-create-agent)
  // ════════════════════════════════════════════════════════════════════════════

  async _handleCreate(query, now) {
    const details = await this._extractCreateDetails(query, now);
    log.info('calendar-mutate', 'Extracted create details', { details });

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

    const resolvedDate = resolveEventDate(details.date, now);
    details.date = resolvedDate;

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

    let ui;
    if (result.day) {
      ui = buildDayUISpec(result.day, formatDateLabel(new Date(`${details.date}T12:00:00`)));
    }

    return { success: true, message, ui };
  },

  async _extractCreateDetails(query, now) {
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
      { profile: 'fast', feature: 'calendar-mutate-create-extract' }
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

  _resolveGuests(guestNames) {
    const store = getContactStore();
    const resolved = [];
    const unresolved = [];

    for (const guest of guestNames) {
      if (isValidEmail(guest)) {
        resolved.push(guest);
        continue;
      }

      const match = store.resolveGuest(guest);
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

  async _resumeGuestResolution(query, context, now) {
    const details = context.pendingEvent;
    const previousResolved = context.resolvedGuests || [];

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

    const parts = [`Create "${details.title || 'event'}"`];
    if (details.date) parts.push(`on ${details.date}`);
    if (details.time) parts.push(`at ${details.time}`);
    if (details.location) parts.push(`at ${details.location}`);
    if (details.duration && details.duration !== '60m') parts.push(`for ${details.duration}`);
    if (details.guests && details.guests.length > 0) parts.push(`with ${details.guests.join(', ')}`);

    return this.execute({ text: parts.join(' '), context: {} });
  },

  // ════════════════════════════════════════════════════════════════════════════
  // EDIT FLOW (former calendar-edit-agent)
  // ════════════════════════════════════════════════════════════════════════════

  async _handleEdit(query, now) {
    const intent = await this._parseEditIntent(query, now);
    log.info('calendar-mutate', 'Parsed edit intent', { intent });

    const match = await this._findEditTargetEvent(intent, now);

    if (!match) {
      return { success: false, message: `I couldn't find an event matching "${intent.searchText || query}".` };
    }

    if (Array.isArray(match)) {
      const list = match
        .slice(0, 5)
        .map((e) => `"${e.summary}" at ${formatEventTime(e)}`)
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

    const changes = await this._resolveChanges(intent.changes, match, now);

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

    const result = await editEventVerified(match.id, 'primary', intent.timeframe || 'today', changes);
    const message = confirmEdit(match.summary, changes, result.verified);

    let ui;
    if (result.day) {
      const targetDateStr = changes.date || (match.start?.dateTime || match.start?.date || '').slice(0, 10);
      ui = buildDayUISpec(result.day, formatDateLabel(new Date(`${targetDateStr}T12:00:00`)));
    }

    return { success: true, message, ui };
  },

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
      { profile: 'fast', feature: 'calendar-mutate-edit-intent' }
    );

    return {
      searchText: result.searchText || null,
      timeframe: result.timeframe || 'today',
      changes: result.changes || {},
    };
  },

  async _findEditTargetEvent(intent, now) {
    const { events } = await getEventsForDay(intent.timeframe, now);

    if (!intent.searchText) return events.length > 0 ? events : null;

    const searchLower = intent.searchText.toLowerCase();
    const matches = events.filter((e) => {
      const title = (e.summary || '').toLowerCase();
      return title.includes(searchLower) || searchLower.includes(title);
    });

    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];
    return matches;
  },

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

    if (rawChanges.addAttendees && rawChanges.addAttendees.length > 0) {
      const currentEmails = (currentEvent.attendees || []).map((a) => a.email).filter(Boolean);
      const store = getContactStore();
      const newEmails = [];
      const unresolvedNames = [];

      for (const guest of rawChanges.addAttendees) {
        if (isValidEmail(guest)) {
          newEmails.push(guest);
        } else {
          const match = store.findContact ? store.findContact(guest) : store.resolveGuest(guest);
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

    if (rawChanges.removeAttendees && rawChanges.removeAttendees.length > 0) {
      const currentEmails = resolved.guests || (currentEvent.attendees || []).map((a) => a.email).filter(Boolean);
      const store = getContactStore();
      const removeEmails = new Set();

      for (const guest of rawChanges.removeAttendees) {
        if (isValidEmail(guest)) {
          removeEmails.add(guest.toLowerCase());
        } else {
          const match = store.findContact ? store.findContact(guest) : store.resolveGuest(guest);
          if (match && match.email) {
            removeEmails.add(match.email.toLowerCase());
          }
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

  // ════════════════════════════════════════════════════════════════════════════
  // DELETE FLOW (former calendar-delete-agent)
  // ════════════════════════════════════════════════════════════════════════════

  async _handleDelete(query, now) {
    const intent = await this._parseDeleteIntent(query, now);
    log.info('calendar-mutate', 'Parsed delete intent', { intent });

    const { events, dateRange } = await getEventsForDay(intent.timeframe, now);
    const day = analyzeDay(events, dateRange.start, now);
    const dayEvents = day.all.map((e) => e.event);

    if (!dayEvents || dayEvents.length === 0) {
      return { success: false, message: `You don't have any events ${dateRange.label.toLowerCase()} to cancel.` };
    }

    const searchLower = (intent.searchText || '').toLowerCase();

    if (!searchLower) {
      const list = dayEvents
        .slice(0, 8)
        .map((e) => `"${e.summary}" at ${formatEventTime(e)}`)
        .join(', ');

      return {
        success: true,
        needsInput: {
          prompt: `Which event ${dateRange.label.toLowerCase()} should I cancel? You have: ${list}`,
          agentId: this.id,
          context: {
            calendarState: 'awaiting_delete_selection',
            matches: dayEvents.map((e) => ({ id: e.id, summary: e.summary, calendarId: e.calendarId || 'primary' })),
            targetDate: intent.timeframe,
          },
        },
      };
    }

    const matches = dayEvents.filter((e) => {
      const title = (e.summary || '').toLowerCase();
      return title.includes(searchLower) || searchLower.includes(title);
    });

    if (matches.length === 0) {
      const list = dayEvents
        .slice(0, 5)
        .map((e) => `"${e.summary}" at ${formatEventTime(e)}`)
        .join(', ');
      return {
        success: false,
        message: `I couldn't find "${intent.searchText}" ${dateRange.label.toLowerCase()}. Your events: ${list}`,
      };
    }

    if (matches.length > 1) {
      const list = matches
        .slice(0, 5)
        .map((e) => `"${e.summary}" at ${formatEventTime(e)}`)
        .join(', ');

      return {
        success: true,
        needsInput: {
          prompt: `I found ${matches.length} events: ${list}. Which one should I cancel?`,
          agentId: this.id,
          context: {
            calendarState: 'awaiting_delete_selection',
            matches: matches.map((e) => ({ id: e.id, summary: e.summary, calendarId: e.calendarId || 'primary' })),
            targetDate: intent.timeframe,
          },
        },
      };
    }

    const target = matches[0];
    const result = await deleteEventVerified(target.id, target.calendarId || 'primary', intent.timeframe);
    const message = confirmDelete(target.summary, result.verified);

    let ui;
    if (result.day) {
      ui = buildDayUISpec(result.day, dateRange.label);
    }

    return { success: true, message, ui };
  },

  async _parseDeleteIntent(query, now) {
    const dateStr = now.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    const result = await ai.json(
      `Parse this calendar deletion request.

CURRENT CONTEXT:
- Today: ${dateStr} (${now.toISOString().slice(0, 10)})
- Time: ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}

USER REQUEST: "${query}"

Return JSON:
{
  "searchText": "<event name or description to find>",
  "timeframe": "<'today' | 'tomorrow' | day name | YYYY-MM-DD -- which day the event is on>"
}

Rules:
- Extract the event name/description the user wants to delete
- Identify which day the event is on (default "today" if not specified)
- "cancel the standup" → searchText: "standup", timeframe: "today"
- "delete tomorrow's lunch" → searchText: "lunch", timeframe: "tomorrow"`,
      { profile: 'fast', feature: 'calendar-mutate-delete-intent' }
    );

    return {
      searchText: result.searchText || null,
      timeframe: result.timeframe || 'today',
    };
  },

  async _resumeDeleteSelection(query, context, _now) {
    const matches = context.matches || [];
    const queryLower = query.toLowerCase();

    const selected = matches.find((m) => queryLower.includes(m.summary.toLowerCase()));

    if (!selected) {
      const ordinals = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4, '1st': 0, '2nd': 1, '3rd': 2 };
      for (const [word, idx] of Object.entries(ordinals)) {
        if (queryLower.includes(word) && matches[idx]) {
          const target = matches[idx];
          const result = await deleteEventVerified(
            target.id,
            target.calendarId || 'primary',
            context.targetDate || 'today'
          );
          return { success: true, message: confirmDelete(target.summary, result.verified) };
        }
      }

      return { success: false, message: "I couldn't match that to any of the options. Could you be more specific?" };
    }

    const result = await deleteEventVerified(
      selected.id,
      selected.calendarId || 'primary',
      context.targetDate || 'today'
    );
    return { success: true, message: confirmDelete(selected.summary, result.verified) };
  },

  async _resumeDeleteConfirmation(query, context, _now) {
    const q = query.toLowerCase();
    if (q.includes('yes') || q.includes('confirm') || q.includes('do it') || q.includes('go ahead')) {
      const result = await deleteEventVerified(
        context.eventId,
        context.calendarId || 'primary',
        context.targetDate || 'today'
      );
      return { success: true, message: confirmDelete(context.eventTitle, result.verified) };
    }

    return { success: true, message: "Okay, I won't delete it." };
  },
};

module.exports = calendarMutateAgent;
