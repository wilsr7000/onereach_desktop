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
const {
  getCalendarMemory,
  buildSnapshotMap,
  diffSnapshots,
} = require('../../lib/calendar-memory');
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

  prompt: `Calendar Query Agent answers questions about the user's schedule, meetings, and availability.

Capabilities:
- Check today's/tomorrow's/this week's schedule
- Look up specific meetings and their details (time, location, attendees, links)
- Check availability at a specific time or date range
- Count meetings on a given day
- Find the next upcoming meeting
- Retrieve meeting join links (Zoom, Teams, Google Meet)
- Answer questions about schedule conflicts

This agent reads calendar data. It does not create, modify, or delete events.`,

  // ── Memory (Phase 2d) ─────────────────────────────────────────────────
  //
  // `memory` is the agent's per-agent memory file (`calendar-query-agent-memory.md`).
  // The learning loop writes Learning Notes here automatically when answers
  // score low; the curator grooms it; the retriever pulls from it for prompt
  // context. One file per agent.
  //
  // `calendarMemory` is the SHARED cross-agent calendar facade backed by
  // `calendar-memory.md` -- holds Aliases, People, Engagement Stats, Brief
  // Snapshots, and the absence-detector seed sections. calendar-mutate-agent
  // shares the same facade. See lib/calendar-memory.js.
  memory: null,
  calendarMemory: null,

  async initialize() {
    if (!this.memory) {
      this.memory = getAgentMemory('calendar-query-agent', { displayName: 'Calendar Query' });
      try {
        await this.memory.load();
      } catch (err) {
        log.warn('calendar-query', 'Per-agent memory load failed (non-fatal)', { error: err.message });
      }
    }
    if (!this.calendarMemory) {
      this.calendarMemory = getCalendarMemory();
      try {
        await this.calendarMemory.load();
      } catch (err) {
        log.warn('calendar-query', 'Shared calendar-memory load failed (non-fatal)', { error: err.message });
      }
    }
    return { memory: this.memory, calendarMemory: this.calendarMemory };
  },

  /**
   * Briefing contribution. Accepts optional { targetDate, dateLabel } from daily-brief-agent.
   *
   * Phase 1 (calendar overhaul): when `calendar.briefIncludeLiveEvents` is enabled,
   * fetches live Omnical events and passes them as `externalEvents` to
   * `generateMorningBrief()` so the brief reflects what's actually on the user's
   * calendar -- not just what's in the local store. Flag-gated kill switch.
   */
  async getBriefing(context = {}) {
    try {
      // Lazy-init memory so Phase 2e can read/write Brief Snapshots without
      // each call having to do its own bootstrapping. Failure is non-fatal --
      // the brief still works without memory, just without the diff line.
      await this.initialize();

      const date = context?.targetDate || null;
      const label = context?.dateLabel || 'today';

      const includeLive = global.settingsManager?.get('calendar.briefIncludeLiveEvents') === true;
      const maxLive = Number.isFinite(global.settingsManager?.get('calendar.briefMerge.maxLiveEvents'))
        ? global.settingsManager.get('calendar.briefMerge.maxLiveEvents')
        : 50;

      let liveEvents = [];
      if (includeLive) {
        try {
          const timeframe = this._timeframeForDate(date);
          const events = await this._fetchLiveEventsForBrief(timeframe);
          liveEvents = (events || []).slice(0, maxLive);
          log.info('calendar-query', 'Brief merge fetched live events', {
            timeframe,
            count: liveEvents.length,
            cappedAt: maxLive,
          });
        } catch (err) {
          log.warn('calendar-query', 'Omnical fetch failed in brief, using local only', {
            error: err.message,
          });
          liveEvents = [];
        }
      }

      const store = this._getStore();
      const brief = await store.generateMorningBrief(date, liveEvents);

      // Phase 2e: identity-keyed diff against the most recent prior snapshot.
      // The diff line ("Two new since yesterday: ...") is computed before
      // we persist today's snapshot so we don't diff against ourselves.
      let diffSummary = null;
      try {
        diffSummary = await this._buildSnapshotDiff(date, liveEvents);
      } catch (err) {
        log.warn('calendar-query', 'Snapshot diff failed (non-fatal)', { error: err.message });
      }

      const result = this._composeBriefingContribution(brief, label, diffSummary);

      // Write today's snapshot AFTER reading the prior one so today doesn't
      // become its own baseline. Best-effort; failure is non-fatal.
      try {
        if (this.calendarMemory && liveEvents.length > 0) {
          await this.calendarMemory.writeBriefSnapshot(date || new Date(), liveEvents);
        }
      } catch (err) {
        log.warn('calendar-query', 'Snapshot write failed (non-fatal)', { error: err.message });
      }

      return result;
    } catch (err) {
      log.error('calendar-query', 'getBriefing failed', { error: err.message });
      return { section: 'Calendar', priority: 3, content: 'Calendar unavailable.' };
    }
  },

  /**
   * Phase 2e: read the most recent prior snapshot and diff it against today's
   * events. Returns a one-line human-friendly summary (for the brief) plus
   * the structured diff (for callers who want it). Returns null if there's
   * no prior snapshot or no meaningful change.
   */
  async _buildSnapshotDiff(date, todayEvents) {
    if (!this.calendarMemory || !todayEvents || todayEvents.length === 0) return null;

    const target = date instanceof Date ? date : new Date(date || new Date());
    const prior = this.calendarMemory.getMostRecentBriefSnapshot(target);
    if (!prior) return null;

    const todayMap = buildSnapshotMap(todayEvents);
    const diff = diffSnapshots(prior.events, todayMap);

    const { added, removed, moved, retitled } = diff;
    if (added.length === 0 && removed.length === 0 && moved.length === 0 && retitled.length === 0) {
      return null;
    }

    // Format the line with the appropriate "since" label. Most days the
    // prior snapshot is yesterday; if the user hasn't briefed for a while,
    // say so explicitly.
    const sinceLabel =
      prior.ageDays === 1 ? 'yesterday' : prior.ageDays === 0 ? 'earlier today' : `${prior.ageDays} days ago`;

    const parts = [];
    if (added.length === 1) {
      parts.push(`new since ${sinceLabel}: "${added[0].title || 'Untitled'}"`);
    } else if (added.length > 1) {
      const first = added.slice(0, 2).map((e) => `"${e.title || 'Untitled'}"`).join(', ');
      const more = added.length > 2 ? ` and ${added.length - 2} more` : '';
      parts.push(`${added.length} new since ${sinceLabel}: ${first}${more}`);
    }
    if (removed.length === 1) {
      parts.push(`"${removed[0].title || 'Untitled'}" was cancelled`);
    } else if (removed.length > 1) {
      parts.push(`${removed.length} cancelled`);
    }
    if (moved.length > 0) {
      const m = moved[0];
      parts.push(`"${m.title || 'Untitled'}" moved`);
      if (moved.length > 1) parts[parts.length - 1] += ` (and ${moved.length - 1} more)`;
    }

    return {
      line: parts.join('; ') + '.',
      diff,
      ageDays: prior.ageDays,
    };
  },

  /**
   * Compose the briefing { section, priority, content, briefData } payload from a
   * generateMorningBrief() result. Pulled out of getBriefing() so it can be unit-tested
   * independently of the live-events fetch path.
   *
   * @param {Object} brief - generateMorningBrief() output
   * @param {string} label - dateLabel (e.g. "today", "tomorrow")
   * @param {Object|null} [diffSummary] - Phase 2e diff line + structured diff
   */
  _composeBriefingContribution(brief, label, diffSummary = null) {
    if (!brief || !brief.timeline || brief.timeline.length === 0) {
      return { section: 'Calendar', priority: 3, content: `No meetings scheduled ${label}.` };
    }

    const count = brief.timeline.length;
    const parts = [`${count} meeting${count !== 1 ? 's' : ''} ${label}.`];

    // Prefer the next upcoming meeting; fall back to the first timeline entry for
    // forward-looking briefs (tomorrow / this week) where every entry is upcoming anyway.
    const firstUpcoming = brief.timeline.find((e) => e.status === 'upcoming') || brief.timeline[0];
    if (firstUpcoming) {
      parts.push(`Next: "${firstUpcoming.title}" at ${firstUpcoming.start}.`);
    }

    if (brief.backToBack?.length) {
      parts.push(`${brief.backToBack.length} back-to-back.`);
    }

    if (brief.conflicts?.length) {
      const conflictCount = brief.conflicts.length;
      const sample = brief.conflicts[0];
      const a = sample?.event1?.title;
      const b = sample?.event2?.title;
      if (a && b) {
        parts.push(`${conflictCount} conflict${conflictCount > 1 ? 's' : ''}: "${a}" and "${b}" overlap.`);
      } else {
        parts.push(`${conflictCount} conflict${conflictCount > 1 ? 's' : ''}.`);
      }
    }

    if (brief.longestFree?.durationMinutes >= 60) {
      const hours = Math.round(brief.longestFree.durationMinutes / 60);
      parts.push(`Longest free block: ${hours}h.`);
    }

    // Phase 2e: append the "what changed since last brief" diff line.
    // Falsy diffSummary means no prior snapshot, no changes, or feature off.
    if (diffSummary?.line) {
      parts.push(diffSummary.line);
    }

    return {
      section: 'Calendar',
      priority: 3,
      content: parts.join(' '),
      briefData: brief,
      ...(diffSummary ? { briefDiff: diffSummary.diff } : {}),
    };
  },

  /**
   * Test seam: fetch live events for the brief. Wraps `getEventsForDay()` so
   * tests can `vi.spyOn(calendarQueryAgent, '_fetchLiveEventsForBrief')`. The
   * wrapping is the simplest pattern that survives this project's vitest +
   * CJS require quirks (vi.mock doesn't reliably intercept calendar-fetch's
   * require chain in unit tests).
   */
  async _fetchLiveEventsForBrief(timeframe) {
    const { events } = await getEventsForDay(timeframe, new Date());
    return events || [];
  },

  /**
   * Test seam: resolve the calendar store. Same rationale as
   * `_fetchLiveEventsForBrief` -- gives tests a `vi.spyOn` handle.
   */
  _getStore() {
    return getCalendarStore();
  },

  /**
   * Convert a Date (or null) into a timeframe string accepted by
   * `calendar-fetch.getEventsForDay()` -- 'today' / 'tomorrow' / 'yesterday' /
   * 'YYYY-MM-DD'. Used by the briefing merge so we can fetch the same window
   * the local store is summarizing.
   */
  _timeframeForDate(date) {
    if (!date) return 'today';
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return 'today';

    const now = new Date();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const target = new Date(d);
    target.setHours(0, 0, 0, 0);

    const diffDays = Math.round((target - today) / (24 * 60 * 60 * 1000));
    if (diffDays === 0) return 'today';
    if (diffDays === 1) return 'tomorrow';
    if (diffDays === -1) return 'yesterday';
    // ISO YYYY-MM-DD form is accepted by resolveTimeframe in calendar-fetch.js
    return target.toISOString().slice(0, 10);
  },

  async execute(task) {
    const query = (task.content || task.text || task.query || '').trim();
    if (!query) return { success: false, message: 'What would you like to know about your calendar?' };

    const now = new Date();
    // Phase 2d: lazy-init memory on first execute. Replaces the dead
    // `_memory = getAgentMemory(...)` line that loaded but never used memory.
    await this.initialize();

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

    // Phase 2d: prepend a small "learned aliases" hint so the parser can
    // resolve user phrases like "the leadership meeting" without making a
    // second LLM call. Trusted-only (Phase 8 retriever filter): excludes
    // any alias whose provenance is `learning-loop` since those aren't
    // user-accepted yet.
    let aliasHint = '';
    try {
      const aliases = this.calendarMemory ? this.calendarMemory.readEntriesTrusted('Aliases') : [];
      if (aliases.length > 0) {
        const lines = aliases.slice(0, 10).map((e) => `- ${e.text}`).join('\n');
        aliasHint = `\nLEARNED ALIASES (user-accepted phrases that map to specific events or attendees):\n${lines}\n`;
      }
    } catch (err) {
      log.warn('calendar-query', 'Alias hint build failed (non-fatal)', { error: err.message });
    }

    const result = await ai.json(
      `Parse this calendar query into a structured intent.

CURRENT CONTEXT:
- Today: ${dateStr} (${now.toISOString().slice(0, 10)})
- Time: ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
- Time of day: ${timeContext.timeOfDay || 'day'}
${aliasHint}
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

    const soundCue = mins <= 5 && mins > 0
      ? { type: 'one-shot', name: 'meeting-chime', volume: 0.4 }
      : null;
    return { success: true, message: msg, soundCue };
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
