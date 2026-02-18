/**
 * Calendar Data Layer — Pure Analysis Functions
 *
 * Every function in this module is synchronous and pure:
 *   - Takes events + a reference time
 *   - Returns structured, pre-analyzed data
 *   - No API calls, no side effects, no LLM
 *
 * `now` is always a parameter (never read from the clock) so tests can
 * freeze time and verify exact behaviour with fixture events.
 *
 * Usage:
 *   const { analyzeDay, analyzeWeek, findConflicts } = require('./calendar-data');
 *   const day = analyzeDay(events, targetDate, new Date());
 */

'use strict';

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Parse a Google-Calendar event's start / end into real Dates.
 * Handles both timed events (dateTime) and all-day events (date).
 */
function parseEventTimes(event) {
  const startRaw = event.start?.dateTime || event.start?.date || event.startTime;
  const endRaw = event.end?.dateTime || event.end?.date || event.endTime;
  const startTime = new Date(startRaw);
  const endTime = endRaw ? new Date(endRaw) : new Date(startTime.getTime() + 3600000); // default 1h
  const isAllDay = !event.start?.dateTime;
  return { startTime, endTime, isAllDay };
}

/**
 * Human-readable elapsed / remaining string.
 *   formatElapsed(120000)  → '2 minutes'
 *   formatElapsed(7200000) → '2 hours'
 */
function formatElapsed(ms) {
  const totalMins = Math.round(Math.abs(ms) / 60000);
  if (totalMins === 0) return 'less than a minute';
  if (totalMins === 1) return '1 minute';
  if (totalMins < 60) return `${totalMins} minutes`;
  const hrs = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (mins === 0) return `${hrs} hour${hrs === 1 ? '' : 's'}`;
  return `${hrs} hour${hrs === 1 ? '' : 's'} ${mins} min`;
}

/**
 * Human-readable relative-time string.
 *   formatRelative(ms, 'ago')  → '2 hours ago'
 *   formatRelative(ms, 'from now') → 'in 30 minutes'
 */
function formatRelative(ms, suffix) {
  const text = formatElapsed(ms);
  if (suffix === 'ago') return `${text} ago`;
  return `in ${text}`;
}

/**
 * Compute a day-label string.  'Today', 'Tomorrow', or 'Wednesday, Feb 19'.
 */
function dayLabel(targetDate, now) {
  const t = new Date(targetDate);
  t.setHours(0, 0, 0, 0);
  const n = new Date(now);
  n.setHours(0, 0, 0, 0);
  const diff = Math.round((t - n) / 86400000);

  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return t.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

/**
 * Deduplicate events by id (or summary+time fallback).
 * Matches the existing dedup logic from the old calendar agent.
 */
function deduplicateEvents(events) {
  if (!events || events.length === 0) return [];
  const seen = new Map();
  const result = [];
  for (const ev of events) {
    const id = ev.id || ev.eventId;
    if (id) {
      if (seen.has(id)) continue;
      seen.set(id, true);
      result.push(ev);
    } else {
      const summary = (ev.summary || ev.title || '').toLowerCase();
      const start = new Date(ev.start?.dateTime || ev.start?.date || ev.startTime || 0).getTime();
      const isDup = result.some((r) => {
        const rSummary = (r.summary || r.title || '').toLowerCase();
        const rStart = new Date(r.start?.dateTime || r.start?.date || r.startTime || 0).getTime();
        return rSummary === summary && Math.abs(rStart - start) < 300000;
      });
      if (!isDup) result.push(ev);
    }
  }
  return result;
}

const sortByStart = (a, b) => {
  const aTime = new Date(a.start?.dateTime || a.start?.date || a.startTime || 0);
  const bTime = new Date(b.start?.dateTime || b.start?.date || b.startTime || 0);
  return aTime - bTime;
};

// ────────────────────────────────────────────────────────────────────────────
// enrichEvent
// ────────────────────────────────────────────────────────────────────────────

/**
 * Add computed fields to a raw Google Calendar event.
 *
 * @param {Object}  event - Raw event object
 * @param {Date}    now   - Reference time
 * @returns {EnrichedEvent}
 */
function enrichEvent(event, now) {
  const { startTime, endTime, isAllDay } = parseEventTimes(event);

  const isPast = endTime <= now;
  const isCurrent = startTime <= now && endTime > now;
  const isFuture = startTime > now;

  let status;
  if (isPast) status = 'past';
  else if (isCurrent) status = 'current';
  else status = 'upcoming';

  const enriched = {
    event,
    startTime,
    endTime,
    isAllDay,
    status,
    durationMinutes: Math.round((endTime - startTime) / 60000),
  };

  if (isPast) {
    enriched.endedAgoMs = now - endTime;
    enriched.endedAgo = formatRelative(enriched.endedAgoMs, 'ago');
  }

  if (isCurrent) {
    enriched.startedAgoMs = now - startTime;
    enriched.startedAgo = formatRelative(enriched.startedAgoMs, 'ago');
    enriched.endsInMs = endTime - now;
    enriched.endsIn = formatRelative(enriched.endsInMs, 'from now');
    const total = endTime - startTime;
    enriched.percentComplete = total > 0 ? Math.round(((now - startTime) / total) * 100) : 0;
  }

  if (isFuture) {
    enriched.startsInMs = startTime - now;
    enriched.startsIn = formatRelative(enriched.startsInMs, 'from now');
  }

  return enriched;
}

// ────────────────────────────────────────────────────────────────────────────
// isEventInRange
// ────────────────────────────────────────────────────────────────────────────

/**
 * Does this event's start fall within [rangeStart, rangeEnd]?
 */
function isEventInRange(event, rangeStart, rangeEnd) {
  const { startTime } = parseEventTimes(event);
  return startTime >= rangeStart && startTime <= rangeEnd;
}

// ────────────────────────────────────────────────────────────────────────────
// findConflicts
// ────────────────────────────────────────────────────────────────────────────

/**
 * Detect overlapping event pairs in a flat array.
 *
 * @param {Array}  events - Raw Google Calendar events
 * @returns {Array<Conflict>}
 */
function findConflicts(events) {
  if (!events || events.length < 2) return [];

  const timed = events
    .map((e) => ({ event: e, ...parseEventTimes(e) }))
    .filter((e) => !e.isAllDay)
    .sort((a, b) => a.startTime - b.startTime);

  const conflicts = [];

  for (let i = 0; i < timed.length - 1; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      const a = timed[i];
      const b = timed[j];

      // b starts after a ends → no overlap with a for any later event either
      if (b.startTime >= a.endTime) break;

      const overlapStart = Math.max(a.startTime.getTime(), b.startTime.getTime());
      const overlapEnd = Math.min(a.endTime.getTime(), b.endTime.getTime());
      const overlapMinutes = Math.round((overlapEnd - overlapStart) / 60000);

      if (overlapMinutes > 0) {
        conflicts.push({
          events: [a.event, b.event],
          overlapMinutes,
          overlapWindow: { start: new Date(overlapStart), end: new Date(overlapEnd) },
          description: _describeConflict(a, b, overlapMinutes, new Date(overlapStart), new Date(overlapEnd)),
        });
      }
    }
  }

  return conflicts;
}

function _describeConflict(a, b, mins, start, end) {
  const fmt = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${fmt(start)}-${fmt(end)}: "${a.event.summary || 'Untitled'}" overlaps with "${b.event.summary || 'Untitled'}" by ${mins} min`;
}

// ────────────────────────────────────────────────────────────────────────────
// findFreeSlots
// ────────────────────────────────────────────────────────────────────────────

/**
 * Compute free gaps between events within a given window.
 *
 * @param {Array}  events       - Raw events (only timed events within the window matter)
 * @param {Date}   windowStart  - Start of the search window
 * @param {Date}   windowEnd    - End of the search window
 * @param {Object} [workingHours] - { start: 8, end: 18 } (hours, 24h). Defaults to 8-18.
 * @returns {Array<FreeSlot>}
 */
function findFreeSlots(events, windowStart, windowEnd, workingHours = { start: 8, end: 18 }) {
  // Clamp window to working hours
  const dayStart = new Date(windowStart);
  dayStart.setHours(workingHours.start, 0, 0, 0);
  const dayEnd = new Date(windowStart);
  dayEnd.setHours(workingHours.end, 0, 0, 0);

  const start = dayStart > windowStart ? dayStart : windowStart;
  const end = dayEnd < windowEnd ? dayEnd : windowEnd;

  if (start >= end) return [];

  // Collect busy intervals (timed events only, within the window)
  const busy = events
    .map((e) => parseEventTimes(e))
    .filter((e) => !e.isAllDay)
    .filter((e) => e.endTime > start && e.startTime < end)
    .map((e) => ({
      start: e.startTime < start ? start : e.startTime,
      end: e.endTime > end ? end : e.endTime,
    }))
    .sort((a, b) => a.start - b.start);

  // Merge overlapping busy intervals
  const merged = [];
  for (const interval of busy) {
    if (merged.length === 0 || interval.start > merged[merged.length - 1].end) {
      merged.push({ start: new Date(interval.start), end: new Date(interval.end) });
    } else {
      merged[merged.length - 1].end = new Date(
        Math.max(merged[merged.length - 1].end.getTime(), interval.end.getTime())
      );
    }
  }

  // Gaps between busy intervals
  const slots = [];
  let cursor = new Date(start);

  for (const interval of merged) {
    if (cursor < interval.start) {
      const durationMinutes = Math.round((interval.start - cursor) / 60000);
      if (durationMinutes >= 15) {
        // ignore tiny gaps
        slots.push({ start: new Date(cursor), end: new Date(interval.start), durationMinutes });
      }
    }
    cursor = interval.end > cursor ? new Date(interval.end) : cursor;
  }

  // Gap after last busy block
  if (cursor < end) {
    const durationMinutes = Math.round((end - cursor) / 60000);
    if (durationMinutes >= 15) {
      slots.push({ start: new Date(cursor), end: new Date(end), durationMinutes });
    }
  }

  return slots;
}

// ────────────────────────────────────────────────────────────────────────────
// getNextEvent
// ────────────────────────────────────────────────────────────────────────────

/**
 * Fast path: return the single next upcoming event.
 *
 * @param {Array}  events - Raw events
 * @param {Date}   now
 * @returns {EnrichedEvent|null}
 */
function getNextEvent(events, now) {
  if (!events || events.length === 0) return null;

  let closest = null;
  let closestMs = Infinity;

  for (const event of events) {
    const { startTime, isAllDay } = parseEventTimes(event);
    if (isAllDay) continue;
    const diff = startTime - now;
    if (diff > 0 && diff < closestMs) {
      closestMs = diff;
      closest = event;
    }
  }

  return closest ? enrichEvent(closest, now) : null;
}

// ────────────────────────────────────────────────────────────────────────────
// analyzeDay
// ────────────────────────────────────────────────────────────────────────────

/**
 * Full analysis of a single day's events.
 *
 * @param {Array}  events     - Raw Google Calendar events (may span multiple days)
 * @param {Date}   targetDate - The day to analyze
 * @param {Date}   now        - Current time
 * @returns {DayAnalysis}
 */
function analyzeDay(events, targetDate, now) {
  // Day boundaries
  const dayStart = new Date(targetDate);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setHours(23, 59, 59, 999);

  const label = dayLabel(dayStart, now);
  const isToday = dayStart.toDateString() === now.toDateString();

  // Now-relative day status
  const nowStart = new Date(now);
  nowStart.setHours(0, 0, 0, 0);
  const isPastDay = dayEnd < nowStart;
  const isFutureDay = dayStart > new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  // Filter & deduplicate events for this day
  const dayEvents = deduplicateEvents((events || []).filter((e) => isEventInRange(e, dayStart, dayEnd))).sort(
    sortByStart
  );

  // Enrich all events
  const enriched = dayEvents.map((e) => enrichEvent(e, now));

  // Bucket by status
  const past = enriched.filter((e) => e.status === 'past');
  const currentArr = enriched.filter((e) => e.status === 'current');
  const current = currentArr.length > 0 ? currentArr[0] : null;
  const upcoming = enriched.filter((e) => e.status === 'upcoming');
  const next = upcoming.length > 0 ? upcoming[0] : null;

  if (next) {
    next.isFirstOfDay = enriched.length > 0 && enriched[0] === next;
  }

  // First and last events of the day (regardless of status)
  const firstOfDay =
    enriched.length > 0
      ? {
          event: enriched[0].event,
          startTime: enriched[0].startTime,
          time: enriched[0].isAllDay
            ? 'All day'
            : enriched[0].startTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
        }
      : null;

  const lastOfDay =
    enriched.length > 0
      ? {
          event: enriched[enriched.length - 1].event,
          endTime: enriched[enriched.length - 1].endTime,
          time: enriched[enriched.length - 1].isAllDay
            ? 'All day'
            : enriched[enriched.length - 1].endTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
        }
      : null;

  // Conflicts
  const conflicts = findConflicts(dayEvents);

  // Free slots (within working hours)
  const windowStart = isToday && now > dayStart ? now : dayStart;
  const freeSlots = findFreeSlots(dayEvents, windowStart, dayEnd);

  // Summary stats
  const busyMinutes = enriched.filter((e) => !e.isAllDay).reduce((sum, e) => sum + e.durationMinutes, 0);

  const _workingMinutes = 10 * 60; // 8am-6pm = 10h
  const freeMinutes = freeSlots.reduce((sum, s) => sum + s.durationMinutes, 0);

  const summary = {
    total: enriched.length,
    pastCount: past.length,
    currentCount: currentArr.length,
    remainingCount: upcoming.length,
    busyMinutes,
    freeMinutes,
    hasConflicts: conflicts.length > 0,
    conflictCount: conflicts.length,
    firstEventTime: firstOfDay ? firstOfDay.time : null,
    lastEventTime: lastOfDay ? lastOfDay.time : null,
  };

  return {
    date: dayStart,
    dateStr: dayStart.toISOString().slice(0, 10),
    label,
    isToday,
    isPast: isPastDay,
    isFuture: isFutureDay,

    past,
    current,
    next,
    remaining: upcoming,
    firstOfDay,
    lastOfDay,

    conflicts,
    freeSlots,
    summary,

    // Expose the full enriched list for agents that want it
    all: enriched,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// analyzeWeek
// ────────────────────────────────────────────────────────────────────────────

/**
 * Analyze a full week of events.
 *
 * @param {Array}  events    - Raw events (should cover the target week)
 * @param {Date}   weekStart - First day of the week (typically Monday)
 * @param {Date}   now
 * @returns {WeekAnalysis}
 */
function analyzeWeek(events, weekStart, now) {
  const start = new Date(weekStart);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  end.setHours(23, 59, 59, 999);

  // Analyze each day
  const days = [];
  for (let i = 0; i < 7; i++) {
    const day = new Date(start);
    day.setDate(day.getDate() + i);
    days.push(analyzeDay(events, day, now));
  }

  // Cross-day analysis
  const allConflicts = days.flatMap((d) => d.conflicts);

  let busiestDay = days[0];
  let lightestDay = days[0];
  let totalEvents = 0;
  let totalBusyMinutes = 0;
  let daysWithEvents = 0;
  const emptyDays = [];

  for (const day of days) {
    totalEvents += day.summary.total;
    totalBusyMinutes += day.summary.busyMinutes;
    if (day.summary.total > busiestDay.summary.total) busiestDay = day;
    if (day.summary.total < lightestDay.summary.total) lightestDay = day;
    if (day.summary.total > 0) {
      daysWithEvents++;
    } else {
      emptyDays.push(day.label);
    }
  }

  // Label: check if `now` falls within this week's range
  const nowMs = now.getTime();
  let label;
  if (nowMs >= start.getTime() && nowMs <= end.getTime()) {
    label = 'This Week';
  } else if (start.getTime() > nowMs) {
    // Check if it's the immediately next week
    const nowStart = new Date(now);
    nowStart.setHours(0, 0, 0, 0);
    const daysUntilStart = Math.round((start - nowStart) / 86400000);
    label =
      daysUntilStart <= 7
        ? 'Next Week'
        : `Week of ${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  } else {
    label = `Week of ${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  }

  return {
    startDate: start,
    endDate: end,
    label,
    days,
    allConflicts,
    busiestDay: { date: busiestDay.date, label: busiestDay.label, eventCount: busiestDay.summary.total },
    lightestDay: { date: lightestDay.date, label: lightestDay.label, eventCount: lightestDay.summary.total },
    summary: {
      totalEvents,
      busiestDay: busiestDay.label,
      lightestDay: lightestDay.label,
      totalConflicts: allConflicts.length,
      totalBusyMinutes,
      averageEventsPerDay: days.length > 0 ? Math.round((totalEvents / days.length) * 10) / 10 : 0,
      daysWithEvents,
      emptyDays,
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// analyzeMonth
// ────────────────────────────────────────────────────────────────────────────

/**
 * Analyze a full month of events.
 *
 * @param {Array}  events     - Raw events (should cover the target month)
 * @param {Date}   monthStart - First day of the month
 * @param {Date}   now
 * @returns {MonthAnalysis}
 */
function analyzeMonth(events, monthStart, now) {
  const start = new Date(monthStart);
  start.setDate(1);
  start.setHours(0, 0, 0, 0);

  // Last day of month
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 0, 23, 59, 59, 999);
  const daysInMonth = end.getDate();

  // Analyze each day
  const days = [];
  for (let i = 0; i < daysInMonth; i++) {
    const day = new Date(start);
    day.setDate(day.getDate() + i);
    days.push(analyzeDay(events, day, now));
  }

  // Cross-day analysis
  const allConflicts = days.flatMap((d) => d.conflicts);

  let busiestDay = days[0];
  let lightestDay = days[0];
  let totalEvents = 0;
  let totalBusyMinutes = 0;
  let daysWithEvents = 0;
  const emptyDays = [];

  for (const day of days) {
    totalEvents += day.summary.total;
    totalBusyMinutes += day.summary.busyMinutes;
    if (day.summary.total > busiestDay.summary.total) busiestDay = day;
    if (day.summary.total < lightestDay.summary.total) lightestDay = day;
    if (day.summary.total > 0) {
      daysWithEvents++;
    } else {
      emptyDays.push(day.label);
    }
  }

  const monthName = start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const nowMonth = new Date(now);
  let label;
  if (start.getMonth() === nowMonth.getMonth() && start.getFullYear() === nowMonth.getFullYear()) {
    label = 'This Month';
  } else {
    label = monthName;
  }

  return {
    startDate: start,
    endDate: end,
    label,
    monthName,
    daysInMonth,
    days,
    allConflicts,
    busiestDay: { date: busiestDay.date, label: busiestDay.label, eventCount: busiestDay.summary.total },
    lightestDay: { date: lightestDay.date, label: lightestDay.label, eventCount: lightestDay.summary.total },
    summary: {
      totalEvents,
      busiestDay: busiestDay.label,
      lightestDay: lightestDay.label,
      totalConflicts: allConflicts.length,
      totalBusyMinutes,
      averageEventsPerDay: daysInMonth > 0 ? Math.round((totalEvents / daysInMonth) * 10) / 10 : 0,
      daysWithEvents,
      emptyDays: emptyDays.length, // count only for month (too many to list)
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Exports
// ────────────────────────────────────────────────────────────────────────────

module.exports = {
  // Core analysis
  analyzeDay,
  analyzeWeek,
  analyzeMonth,

  // Standalone helpers
  findConflicts,
  findFreeSlots,
  getNextEvent,
  enrichEvent,
  isEventInRange,
  deduplicateEvents,

  // Low-level (useful for tests)
  parseEventTimes,
  formatElapsed,
  dayLabel,
};
