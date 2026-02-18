/**
 * Calendar Delete Agent
 *
 * Deletes/cancels calendar events:
 *   - Find event by name or description
 *   - Disambiguation when multiple events match
 *   - Verified deletion (delete → re-fetch → confirm it's gone)
 *   - Shows updated calendar after deletion
 */

'use strict';

const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();
const { getEventsForDay, deleteEventVerified } = require('../../lib/calendar-fetch');
const { confirmDelete, buildDayUISpec, formatEventTime } = require('../../lib/calendar-format');

const calendarDeleteAgent = {
  id: 'calendar-delete-agent',
  name: 'Calendar Delete',
  description:
    'Deletes or cancels calendar events -- finds the event by name, confirms with the user if ambiguous, and verifies removal.',
  voice: 'alloy',
  acks: ["I'll take care of that.", 'Removing it now.'],
  categories: ['productivity', 'calendar'],
  keywords: [
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
  estimatedExecutionMs: 5000,
  dataSources: ['calendar-api'],

  prompt: `Calendar Delete Agent removes events from the user's calendar.

HIGH CONFIDENCE (0.90+):
- "Cancel my 3pm meeting"
- "Delete the standup"
- "Remove the team sync from my calendar"
- "Cancel tomorrow's lunch"
- "Delete all my meetings on Friday" (with confirmation)
- "Skip the recurring standup this week"

MEDIUM CONFIDENCE (0.60-0.89):
- "I don't need that meeting anymore" (needs context)
- "Get rid of the 2pm" (informal deletion)

LOW CONFIDENCE (below 0.60) -- do NOT bid:
- "What's on my calendar?" → calendar-query-agent
- "Create a meeting" → calendar-create-agent
- "Move my meeting to 3pm" → calendar-edit-agent
- Questions about events without deletion intent`,

  async execute(task) {
    const query = (task.text || task.query || '').trim();
    if (!query) return { success: false, message: 'Which event would you like to cancel?' };

    const now = new Date();
    const context = task.context || {};

    try {
      // Multi-turn: user selected which event to delete
      if (context.calendarState === 'awaiting_delete_selection') {
        return await this._resumeDeleteSelection(query, context, now);
      }

      // Multi-turn: user confirmed deletion
      if (context.calendarState === 'awaiting_delete_confirmation') {
        return await this._resumeDeleteConfirmation(query, context, now);
      }

      // Step 1: Parse the delete intent
      const intent = await this._parseDeleteIntent(query, now);
      log.info('calendar-delete', 'Parsed delete intent', { intent });

      // Step 2: Find the target event
      const { events, dateRange } = await getEventsForDay(intent.timeframe, now);

      if (!events || events.length === 0) {
        return { success: false, message: `You don't have any events ${dateRange.label.toLowerCase()} to cancel.` };
      }

      // Search for matching event
      const searchLower = (intent.searchText || '').toLowerCase();
      const matches = events.filter((e) => {
        const title = (e.summary || '').toLowerCase();
        if (!searchLower) return false;
        return title.includes(searchLower) || searchLower.includes(title);
      });

      if (matches.length === 0) {
        return {
          success: false,
          message: `I couldn't find an event matching "${intent.searchText || query}" ${dateRange.label.toLowerCase()}.`,
        };
      }

      if (matches.length > 1) {
        const list = matches
          .slice(0, 5)
          .map((e) => {
            const time = formatEventTime(e);
            return `"${e.summary}" at ${time}`;
          })
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

      // Single match: proceed
      const target = matches[0];

      // Step 3: Delete with verification
      const result = await deleteEventVerified(target.id, target.calendarId || 'primary', intent.timeframe);
      const message = confirmDelete(target.summary, result.verified);

      let ui;
      if (result.day) {
        ui = buildDayUISpec(result.day, dateRange.label);
      }

      return { success: true, message, ui };
    } catch (err) {
      log.error('calendar-delete', 'Execute failed', { error: err.message, stack: err.stack });
      return { success: false, message: `I couldn't delete the event: ${err.message}` };
    }
  },

  // ────────────── Intent Parsing ──────────────

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
      { profile: 'fast', feature: 'calendar-delete-intent' }
    );

    return {
      searchText: result.searchText || null,
      timeframe: result.timeframe || 'today',
    };
  },

  // ────────────── Multi-turn Handlers ──────────────

  async _resumeDeleteSelection(query, context, _now) {
    const matches = context.matches || [];
    const queryLower = query.toLowerCase();

    const selected = matches.find((m) => queryLower.includes(m.summary.toLowerCase()));

    if (!selected) {
      // Try matching by position: "the first one", "the second one"
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

module.exports = calendarDeleteAgent;
