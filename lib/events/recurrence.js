/**
 * Event recurrence - pure occurrence math for the manage-events feature.
 *
 * Events carry:
 *   startsAt   ISO datetime of the first (or only) occurrence
 *   recurrence 'none' | 'daily' | 'weekly' | 'monthly'
 *   byDay      (weekly only, optional) array of weekday numbers 0-6 (Sun=0);
 *              defaults to the weekday of startsAt
 *
 * No I/O, no clocks -- callers pass `from`. All math in local time.
 */

'use strict';

const RECURRENCES = Object.freeze(['none', 'daily', 'weekly', 'monthly']);
const DAY_MS = 24 * 60 * 60 * 1000;

function _atSameTime(dayDate, timeSource) {
  const d = new Date(dayDate);
  d.setHours(timeSource.getHours(), timeSource.getMinutes(), timeSource.getSeconds(), 0);
  return d;
}

/**
 * Next occurrence of an event at or after `from`.
 *
 * @param {Object} event - { startsAt, recurrence?, byDay? }
 * @param {Date|string|number} from
 * @returns {Date|null} null when the event has no future occurrence
 *                      (a one-off already in the past), or is malformed
 */
function nextOccurrence(event, from) {
  if (!event || !event.startsAt) return null;
  const start = new Date(event.startsAt);
  if (isNaN(start.getTime())) return null;
  const fromDate = new Date(from);
  if (isNaN(fromDate.getTime())) return null;

  const recurrence = RECURRENCES.includes(event.recurrence) ? event.recurrence : 'none';

  if (start >= fromDate) return start;

  switch (recurrence) {
    case 'none':
      return null;

    case 'daily': {
      const candidate = _atSameTime(fromDate, start);
      return candidate >= fromDate ? candidate : new Date(candidate.getTime() + DAY_MS);
    }

    case 'weekly': {
      const byDay =
        Array.isArray(event.byDay) && event.byDay.length
          ? event.byDay.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
          : [start.getDay()];
      if (!byDay.length) return null;
      // Walk forward up to 7 days from `from`; the first matching weekday
      // whose occurrence time is >= from wins.
      for (let i = 0; i <= 7; i++) {
        const day = new Date(fromDate.getTime() + i * DAY_MS);
        if (!byDay.includes(day.getDay())) continue;
        const candidate = _atSameTime(day, start);
        if (candidate >= fromDate) return candidate;
      }
      return null; // unreachable with a non-empty byDay
    }

    case 'monthly': {
      // Same day-of-month as startsAt. Months lacking that day (e.g. 31st
      // in February) are skipped, matching common calendar behavior.
      const wantedDay = start.getDate();
      for (let i = 0; i <= 24; i++) {
        const candidate = new Date(
          fromDate.getFullYear(),
          fromDate.getMonth() + i,
          wantedDay,
          start.getHours(),
          start.getMinutes(),
          start.getSeconds(),
          0
        );
        // JS Date rolls over invalid days (Feb 31 -> Mar 3); detect and skip.
        if (candidate.getDate() !== wantedDay) continue;
        if (candidate >= fromDate) return candidate;
      }
      return null;
    }

    default:
      return null;
  }
}

/**
 * Upcoming occurrences across a set of events, sorted soonest-first.
 * One entry per event (its NEXT occurrence), not an expansion.
 *
 * @param {Object[]} events
 * @param {Date|string|number} from
 * @param {number} [limit=10]
 * @returns {Array<{ event: Object, at: Date }>}
 */
function upcoming(events, from, limit = 10) {
  return (events || [])
    .map((event) => ({ event, at: nextOccurrence(event, from) }))
    .filter((e) => e.at !== null)
    .sort((a, b) => a.at - b.at)
    .slice(0, limit);
}

/**
 * Human-friendly phrasing for a next occurrence, relative to `from`.
 * Deterministic (no locale surprises in tests beyond weekday names).
 */
function describeOccurrence(at, from) {
  const d = new Date(at);
  const fromDate = new Date(from);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const startOfFrom = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
  const dayDiff = Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - startOfFrom) / DAY_MS);
  if (dayDiff === 0) return `today at ${time}`;
  if (dayDiff === 1) return `tomorrow at ${time}`;
  if (dayDiff > 1 && dayDiff < 7) {
    return `${d.toLocaleDateString([], { weekday: 'long' })} at ${time}`;
  }
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${time}`;
}

module.exports = { RECURRENCES, nextOccurrence, upcoming, describeOccurrence };
