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
const sessionContext = require('../../lib/agent-session-context');
const { fuzzyMatch } = require('../../lib/calendar-fuzzy-match');
const { buildPrepCard } = require('../../lib/calendar-prep-card');
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

      // Phase 1 rolled out (v4.9.x): default the flag ON. Users can still
      // explicitly disable by setting calendar.briefIncludeLiveEvents = false
      // if Omnical is causing trouble; setting === false forces off.
      const flagValue = global.settingsManager?.get('calendar.briefIncludeLiveEvents');
      const includeLive = flagValue !== false;
      const maxLive = Number.isFinite(global.settingsManager?.get('calendar.briefMerge.maxLiveEvents'))
        ? global.settingsManager.get('calendar.briefMerge.maxLiveEvents')
        : 50;

      let liveEvents = [];
      let staleReason = null;
      if (includeLive) {
        try {
          const timeframe = this._timeframeForDate(date);
          const events = await this._fetchLiveEventsForBrief(timeframe);
          liveEvents = (events || []).slice(0, maxLive);
          // Phase 5: events may carry a __stale tag if calendar-fetch fell
          // back to the local cache (Omnical down or circuit open). Bubble
          // that up so the brief can disclose "based on local cache".
          if (events && events.__stale) staleReason = events.__staleReason || 'stale';
          log.info('calendar-query', 'Brief merge fetched live events', {
            timeframe,
            count: liveEvents.length,
            cappedAt: maxLive,
            stale: !!staleReason,
          });
        } catch (err) {
          log.warn('calendar-query', 'Omnical fetch failed in brief, using local only', {
            error: err.message,
          });
          liveEvents = [];
          staleReason = 'unavailable';
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

      const result = this._composeBriefingContribution(brief, label, diffSummary, { staleReason });

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
  _composeBriefingContribution(brief, label, diffSummary = null, opts = {}) {
    if (!brief || !brief.timeline || brief.timeline.length === 0) {
      const empty = { section: 'Calendar', priority: 3, content: `No meetings scheduled ${label}.` };
      if (opts.staleReason) empty.content += ' (based on local cache; calendar service is offline)';
      return empty;
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

    // Phase 5: stale-source disclosure -- spoken so the user knows the
    // brief might be incomplete during an Omnical outage.
    if (opts.staleReason) {
      parts.push('(based on local cache; calendar service is offline)');
    }

    return {
      section: 'Calendar',
      priority: 3,
      content: parts.join(' '),
      briefData: brief,
      ...(diffSummary ? { briefDiff: diffSummary.diff } : {}),
      ...(opts.staleReason ? { stale: true, staleReason: opts.staleReason } : {}),
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
      let result;
      switch (intent.action) {
        case 'check_schedule':
          result = await this._handleCheckSchedule(intent, now, task);
          break;
        case 'next_meeting':
          result = await this._handleNextMeeting(now, task);
          break;
        case 'next_meeting_with':
          result = await this._handleNextMeetingWith(intent, now, task);
          break;
        case 'recent_followup':
          result = await this._handleRecentFollowup(intent, now, task);
          break;
        case 'resolve_conflict':
          result = await this._handleResolveConflict(intent, now, task);
          break;
        case 'check_availability':
          result = await this._handleAvailability(intent, now, task);
          break;
        case 'event_details':
          result = await this._handleEventDetails(intent, now, task);
          break;
        case 'join_meeting':
          result = await this._handleJoinMeeting(intent, now, task);
          break;
        case 'conflicts':
          result = await this._handleConflicts(intent, now, task);
          break;
        case 'free_slots':
          result = await this._handleFreeSlots(intent, now, task);
          break;
        default:
          result = await this._handleCheckSchedule({ ...intent, timeframe: intent.timeframe || 'today' }, now, task);
      }

      // Phase 4: stash the most recent result's event ids on sessionContext
      // so a follow-up like "what about the one after that?" can resolve.
      if (result?.lastResultEventIds) {
        sessionContext.setSession(this.id, 'lastResultEventIds', result.lastResultEventIds, { ttlMs: 5 * 60_000 });
        sessionContext.setSession(this.id, 'lastQuery', { query, action: intent.action, ts: Date.now() }, { ttlMs: 5 * 60_000 });
      }
      return result;
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
  "action": "check_schedule" | "next_meeting" | "next_meeting_with" | "recent_followup" | "resolve_conflict" | "check_availability" | "event_details" | "join_meeting" | "conflicts" | "free_slots",
  "timeframe": "today" | "tomorrow" | "this_week" | "next_week" | "this_month" | "<day_name>" | "<YYYY-MM-DD>",
  "searchText": "<optional: specific event/meeting name to find>",
  "personRef": "<optional: attendee name or email when the user asks about meetings WITH someone>",
  "timeSlot": "<optional: specific time like '2pm' or '14:00' for availability checks>"
}

Rules:
- "what's on my calendar" / "what meetings" / "check my schedule" → check_schedule
- "next meeting" / "what's next" → next_meeting
- "next meeting with X" / "when do I see X next" / "upcoming with X" → next_meeting_with (set personRef)
- "what about the one after that" / "the next one" / "and then" / pronoun referring to a prior result → recent_followup
- "fix the conflict" / "resolve the overlap" / "what should I do about the double-booking" → resolve_conflict
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
      personRef: result.personRef || null,
      timeSlot: result.timeSlot || null,
    };
  },

  // ────────────── Handlers ──────────────

  async _handleCheckSchedule(intent, now, task, opts = {}) {
    const { events, dateRange } = await getEventsForDay(intent.timeframe, now);
    const day = analyzeDay(events, dateRange.start, now);

    if (day.summary.total === 0) {
      // Phase 5: file header has long promised "On bad results: eval -> retry
      // with corrected timeframe (max 1 retry)" -- finally implementing it.
      // Only retry on fuzzy timeframes (the ones the LLM might have resolved
      // wrong): this_week / next_week / this_month / day-names. ISO dates
      // and today/tomorrow/yesterday are unambiguous.
      const FUZZY_TIMEFRAMES = new Set([
        'this_week', 'next_week', 'this_month',
        'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
      ]);
      if (!opts._isRetry && FUZZY_TIMEFRAMES.has((intent.timeframe || '').toLowerCase())) {
        const corrected = await this._suggestCorrectedTimeframe(intent, dateRange);
        if (corrected && corrected !== intent.timeframe) {
          log.info('calendar-query', 'Retrying check_schedule with corrected timeframe', {
            from: intent.timeframe, to: corrected,
          });
          return this._handleCheckSchedule({ ...intent, timeframe: corrected }, now, task, { _isRetry: true });
        }
      }
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

    // Phase 7 dual-channel migration: calendar-query returns either a
    // small dayView (single-day) or a longer eventList. Both come with
    // a spoken summary. The visualText echoes the spoken summary; the
    // ui carries the actual schedule. The dual-channel shim picks
    // 'inline' or 'modal' based on the ui's rendered size.
    return {
      success: true,
      message: spoken,
      spokenSummary: spoken,
      visualText: spoken,
      ui: uiSpec,
    };
  },

  /**
   * Phase 5: ask the LLM to suggest a different timeframe when the original
   * one came back empty. Returns the new timeframe string or null if the
   * LLM doesn't have a better suggestion.
   */
  async _suggestCorrectedTimeframe(intent, dateRange) {
    try {
      const dateRangeStr = `${new Date(dateRange.start).toISOString().slice(0, 10)} to ${new Date(dateRange.end).toISOString().slice(0, 10)}`;
      const result = await ai.json(
        `The user asked about timeframe "${intent.timeframe}" which I resolved to ${dateRangeStr}, but no events came back. Did I pick the wrong timeframe? If a different timeframe is more likely to have events, suggest it. If the original was probably right (calendar legitimately empty), return null.

USER ORIGINAL QUERY HINT: "${intent.searchText || ''}"

Return JSON: { "timeframe": "today" | "tomorrow" | "this_week" | "next_week" | "this_month" | "<day_name>" | "<YYYY-MM-DD>" | null }`,
        { profile: 'fast', feature: 'calendar-query-timeframe-retry' }
      );
      const tf = result?.timeframe;
      return typeof tf === 'string' && tf.length > 0 ? tf : null;
    } catch (err) {
      log.warn('calendar-query', 'Timeframe-retry LLM failed (non-fatal)', { error: err.message });
      return null;
    }
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

    // Phase 7: attach a prep card when the meeting is within window. The
    // module returns null if outside windowMinutes / flag off / errors --
    // failure is non-fatal.
    let prepCard = null;
    try {
      const allEventsForToday = events;
      const sortedEvents = [...allEventsForToday].sort((a, b) => {
        const sa = new Date(a.start?.dateTime || a.start?.date).getTime();
        const sb = new Date(b.start?.dateTime || b.start?.date).getTime();
        return sa - sb;
      });
      const idx = sortedEvents.findIndex((e) => e.id === raw.id);
      const nextEvent = idx >= 0 ? sortedEvents[idx + 1] : null;

      prepCard = await buildPrepCard(raw, {
        now,
        nextEvent,
        memory: this.calendarMemory,
      });
    } catch (err) {
      log.warn('calendar-query', 'prep card build failed (non-fatal)', { error: err.message });
    }

    return {
      success: true,
      message: msg,
      soundCue,
      lastResultEventIds: [raw.id],
      ...(prepCard ? { ui: prepCard } : {}),
    };
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

    const { events, dateRange } = await getEventsForDay(intent.timeframe, now);

    // Phase 4: substring-first conditional-LLM fuzzy match. Replaces the
    // prior `title.includes(searchLower) || searchLower.includes(title)`
    // logic which missed obvious matches like "the standup" -> "Daily Standup".
    const matches = await fuzzyMatch(intent.searchText, events, {
      agentId: this.id,
      cacheKey: dateRange.start ? new Date(dateRange.start).toISOString().slice(0, 10) : 'today',
    });
    const match = matches?.[0];

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

    return { success: true, message: msg, lastResultEventIds: [match.id] };
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

  // ──────── Phase 4 handlers: next_meeting_with / recent_followup / resolve_conflict ───

  /**
   * "When's my next meeting with Sarah?" Looks across the next 14 days,
   * finds the earliest event that includes the named attendee.
   */
  async _handleNextMeetingWith(intent, now, _task) {
    const personRef = intent.personRef || intent.searchText;
    if (!personRef) {
      return { success: false, message: 'Who would you like to find your next meeting with?' };
    }

    // Fetch a wider window (14 days) so "next with X" finds them even if
    // they're not on today's calendar.
    const { events } = await getEventsForDay('today', now);
    const matches = await fuzzyMatch(personRef, events, {
      agentId: this.id,
      cacheKey: 'next_meeting_with',
    });

    if (!matches || matches.length === 0) {
      return {
        success: true,
        message: `I couldn't find an upcoming meeting with "${personRef}" in the next 14 days.`,
      };
    }

    // Earliest by start time after now.
    const upcoming = matches
      .filter((e) => {
        const s = new Date(e.start?.dateTime || e.start?.date);
        return s >= now;
      })
      .sort((a, b) => {
        const sa = new Date(a.start?.dateTime || a.start?.date).getTime();
        const sb = new Date(b.start?.dateTime || b.start?.date).getTime();
        return sa - sb;
      });

    if (upcoming.length === 0) {
      return {
        success: true,
        message: `No upcoming meeting with "${personRef}" in the next 14 days.`,
      };
    }

    const next = upcoming[0];
    const title = next.summary || 'Untitled';
    const time = formatEventTimeRange(next);
    const start = new Date(next.start?.dateTime || next.start?.date);
    const dayLabel = start.toDateString() === now.toDateString()
      ? 'today'
      : start.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

    return {
      success: true,
      message: `Your next meeting with ${personRef}: "${title}" ${dayLabel} at ${time}.`,
      lastResultEventIds: [next.id],
    };
  },

  /**
   * "What about the one after that?" Pulls the prior result's event ids out
   * of sessionContext and returns the next one, or asks for clarification
   * if there's no prior context.
   */
  async _handleRecentFollowup(intent, now, _task) {
    const lastIds = sessionContext.getSessionValue(this.id, 'lastResultEventIds');
    if (!lastIds || lastIds.length === 0) {
      return {
        success: true,
        message: "I don't have a prior result to follow up on. What event are you asking about?",
      };
    }

    // Find the LAST id in the prior result and return the event AFTER it
    // chronologically from today's events.
    const { events } = await getEventsForDay(intent.timeframe || 'today', now);
    const sorted = [...events].sort((a, b) => {
      const sa = new Date(a.start?.dateTime || a.start?.date).getTime();
      const sb = new Date(b.start?.dateTime || b.start?.date).getTime();
      return sa - sb;
    });

    const lastIdx = sorted.findIndex((e) => lastIds.includes(e.id));
    if (lastIdx < 0 || lastIdx + 1 >= sorted.length) {
      return { success: true, message: 'There are no more events after that.' };
    }

    const next = sorted[lastIdx + 1];
    const title = next.summary || 'Untitled';
    const time = formatEventTimeRange(next);
    return {
      success: true,
      message: `After that: "${title}" at ${time}.`,
      lastResultEventIds: [next.id],
    };
  },

  /**
   * "Fix the conflict" -- find the most recent overlap and have the LLM
   * propose a reschedule (returned as an action: 'proposeEdit' for one-tap
   * acceptance once the prep card UI is built).
   */
  async _handleResolveConflict(intent, now, _task) {
    const { events, dateRange } = await getEventsForDay(intent.timeframe || 'today', now);
    const conflicts = findConflicts(events);

    if (conflicts.length === 0) {
      return { success: true, message: `No conflicts to resolve ${dateRange.label.toLowerCase()}.` };
    }

    const c = conflicts[0];
    const a = c.event1 || c.events?.[0];
    const b = c.event2 || c.events?.[1];
    if (!a || !b) {
      return { success: true, message: `Found ${conflicts.length} conflict(s) but couldn't read the event pairs.` };
    }

    // Find free slots for the day so we can suggest a target.
    const freeSlots = findFreeSlots(events, dateRange.start, dateRange.end) || [];

    let suggestion;
    try {
      suggestion = await ai.json(
        `Two calendar events overlap. Suggest which one should move and to which free slot. Be brief.

EVENT A: "${(a.summary || 'Untitled').replace(/[\r\n]/g, ' ')}" at ${formatEventTime(a)}
EVENT B: "${(b.summary || 'Untitled').replace(/[\r\n]/g, ' ')}" at ${formatEventTime(b)}

FREE SLOTS TODAY:
${freeSlots.slice(0, 5).map((s) => {
  const sStart = new Date(s.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const sEnd = new Date(s.end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `- ${sStart} to ${sEnd}`;
}).join('\n') || '(none -- you are fully booked)'}

Return JSON: { "moveEventTitle": "<A's title or B's title>", "moveTo": "<HH:MM 24h>", "rationale": "<one short sentence>" }`,
        { profile: 'fast', feature: 'calendar-query-resolve-conflict' }
      );
    } catch (err) {
      log.warn('calendar-query', 'resolve_conflict LLM failed (non-fatal)', { error: err.message });
    }

    if (!suggestion?.moveEventTitle || !suggestion?.moveTo) {
      return {
        success: true,
        message: `"${a.summary}" and "${b.summary}" overlap. ${freeSlots.length === 0 ? "You're fully booked, so a manual reshuffle is needed." : "I couldn't pick a clean slot -- want me to show your free time?"}`,
      };
    }

    const targetEvent =
      (a.summary || '').toLowerCase().includes(suggestion.moveEventTitle.toLowerCase()) ? a : b;

    return {
      success: true,
      message: `"${a.summary}" and "${b.summary}" overlap. Suggestion: move "${suggestion.moveEventTitle}" to ${suggestion.moveTo} -- ${suggestion.rationale}`,
      action: {
        type: 'proposeEdit',
        eventId: targetEvent.id,
        newTime: suggestion.moveTo,
        rationale: suggestion.rationale,
      },
      lastResultEventIds: [a.id, b.id],
    };
  },

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
