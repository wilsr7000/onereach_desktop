/**
 * Calendar Fetch Layer — Async Data Access + Verified Mutations
 *
 * Handles all communication with the Omnical API:
 *   - Fetching events with caching
 *   - Date/timeframe resolution (pure JS, no LLM)
 *   - Verified create/delete/edit (mutate → re-fetch → confirm)
 *
 * Usage:
 *   const { getEventsForDay, resolveTimeframe, createEventVerified } = require('./calendar-fetch');
 *   const { events, dateRange } = await getEventsForDay('tomorrow');
 */

'use strict';

const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();
const { deduplicateEvents, analyzeDay } = require('./calendar-data');

// ────────────────────────────────────────────────────────────────────────────
// API Endpoints
// ────────────────────────────────────────────────────────────────────────────

const OMNICAL_API_URL = 'https://em.edison.api.onereach.ai/http/35254342-4a2e-475b-aec1-18547e517e29/omnical';
const OMNICAL_ADD_EVENT_URL =
  'https://em.edison.api.onereach.ai/http/35254342-4a2e-475b-aec1-18547e517e29/omnical_event';
const OMNICAL_DELETE_EVENT_URL =
  'https://em.edison.api.onereach.ai/http/35254342-4a2e-475b-aec1-18547e517e29/omnicaldelete';
const OMNICAL_DETAILS_URL =
  'https://em.edison.api.onereach.ai/http/35254342-4a2e-475b-aec1-18547e517e29/omnical_details';

// ────────────────────────────────────────────────────────────────────────────
// Cache
// ────────────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60000; // 1 minute

const _cache = {
  events: null,
  fetchedAt: 0,
};

function invalidateCache() {
  _cache.events = null;
  _cache.fetchedAt = 0;
}

// ────────────────────────────────────────────────────────────────────────────
// Date Resolution (pure, no API)
// ────────────────────────────────────────────────────────────────────────────

const DAY_NAMES = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/**
 * Convert a relative timeframe string into a concrete date range.
 *
 * @param {string} timeframe - 'today' | 'tomorrow' | 'this_week' | 'next_week' |
 *                             'this_month' | 'monday'..'sunday' | 'YYYY-MM-DD'
 * @param {Date}   [now]     - Reference time (default: new Date())
 * @returns {{ start: Date, end: Date, label: string }}
 */
function resolveTimeframe(timeframe, now = new Date()) {
  const tf = (timeframe || 'today').toLowerCase().trim();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  if (tf === 'today') {
    const end = new Date(today);
    end.setHours(23, 59, 59, 999);
    return { start: new Date(today), end, label: 'Today' };
  }

  if (tf === 'tomorrow') {
    const start = new Date(today);
    start.setDate(start.getDate() + 1);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    return { start, end, label: 'Tomorrow' };
  }

  if (tf === 'yesterday') {
    const start = new Date(today);
    start.setDate(start.getDate() - 1);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    return { start, end, label: 'Yesterday' };
  }

  if (tf === 'this_week' || tf === 'this week') {
    const dayOfWeek = today.getDay(); // 0=Sun
    const monday = new Date(today);
    monday.setDate(today.getDate() - ((dayOfWeek + 6) % 7)); // Back to Monday
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);
    return { start: monday, end: sunday, label: 'This Week' };
  }

  if (tf === 'next_week' || tf === 'next week') {
    const dayOfWeek = today.getDay();
    const nextMonday = new Date(today);
    nextMonday.setDate(today.getDate() + (7 - ((dayOfWeek + 6) % 7)));
    const nextSunday = new Date(nextMonday);
    nextSunday.setDate(nextMonday.getDate() + 6);
    nextSunday.setHours(23, 59, 59, 999);
    return { start: nextMonday, end: nextSunday, label: 'Next Week' };
  }

  if (tf === 'this_month' || tf === 'this month') {
    const start = new Date(today.getFullYear(), today.getMonth(), 1);
    const end = new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59, 999);
    const monthName = start.toLocaleDateString('en-US', { month: 'long' });
    return { start, end, label: monthName };
  }

  // Day name: 'monday' → next occurrence
  if (DAY_NAMES[tf] !== undefined) {
    const targetDay = DAY_NAMES[tf];
    const currentDay = today.getDay();
    let daysUntil = targetDay - currentDay;
    if (daysUntil <= 0) daysUntil += 7;
    const start = new Date(today);
    start.setDate(today.getDate() + daysUntil);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    const dayLabel = start.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    return { start, end, label: dayLabel };
  }

  // ISO date: 'YYYY-MM-DD'
  if (/^\d{4}-\d{2}-\d{2}$/.test(tf)) {
    const start = new Date(tf + 'T00:00:00');
    const end = new Date(tf + 'T23:59:59.999');
    if (isNaN(start.getTime())) {
      log.warn('calendar-fetch', `Invalid date string: ${tf}, defaulting to today`);
      return resolveTimeframe('today', now);
    }
    const label = start.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    return { start, end, label };
  }

  // Fallback: today
  log.warn('calendar-fetch', `Unrecognized timeframe: "${tf}", defaulting to today`);
  return resolveTimeframe('today', now);
}

/**
 * Validate and resolve a date string for event mutations.
 *
 * @param {string} dateStr - 'tomorrow', 'next friday', 'YYYY-MM-DD', day name
 * @param {Date}   [now]   - Reference time
 * @returns {string} YYYY-MM-DD string
 * @throws {Error} if date is invalid or unreasonable
 */
function resolveEventDate(dateStr, now = new Date()) {
  if (!dateStr) throw new Error('Date is required');

  const ds = dateStr.toLowerCase().trim();

  // Relative terms
  if (ds === 'today') {
    return now.toISOString().slice(0, 10);
  }
  if (ds === 'tomorrow') {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  // "next <day>" or just day name
  const nextMatch = ds.match(/^(?:next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/);
  if (nextMatch) {
    const range = resolveTimeframe(nextMatch[1], now);
    return range.start.toISOString().slice(0, 10);
  }

  // ISO date
  if (/^\d{4}-\d{2}-\d{2}$/.test(ds)) {
    const d = new Date(ds + 'T12:00:00'); // noon to avoid timezone issues
    if (isNaN(d.getTime())) throw new Error(`Invalid date: ${ds}`);

    // Sanity: not more than 1 year out
    const oneYearOut = new Date(now);
    oneYearOut.setFullYear(oneYearOut.getFullYear() + 1);
    if (d > oneYearOut) throw new Error(`Date ${ds} is more than a year away`);

    return ds;
  }

  throw new Error(`Cannot resolve date: "${dateStr}". Use YYYY-MM-DD, a day name, "today", or "tomorrow".`);
}

// ────────────────────────────────────────────────────────────────────────────
// Raw API Functions
// ────────────────────────────────────────────────────────────────────────────

function _formatApiDate(d) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`;
}

/**
 * Fetch raw events from the Omnical API for a date range.
 * Uses a 1-minute cache.
 */
async function fetchEventsForRange(startDate, endDate, { includeDetails = true } = {}) {
  const now = Date.now();

  // Cache check
  if (_cache.events && now - _cache.fetchedAt < CACHE_TTL_MS) {
    log.info('calendar-fetch', 'Using cached events');
    return _cache.events;
  }

  try {
    const requestBody = {
      method: '',
      startDate: _formatApiDate(startDate),
      endDate: _formatApiDate(endDate),
      startTime: '',
      endTime: '',
      searchText: '',
      timeZone: 'America/Los_Angeles',
    };

    log.info('calendar-fetch', `Fetching events: ${requestBody.startDate} to ${requestBody.endDate}`);

    const response = await fetch(OMNICAL_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) throw new Error(`API error: ${response.status}`);

    const data = await response.json();

    if (data?.result === 'not found') {
      _cache.events = [];
      _cache.fetchedAt = now;
      return [];
    }

    let events = Array.isArray(data) ? data : [];

    if (includeDetails && events.length > 0) {
      events = await _enrichEventsWithDetails(events);
    }

    events = deduplicateEvents(events);

    _cache.events = events;
    _cache.fetchedAt = now;

    log.info('calendar-fetch', `Fetched ${events.length} events`);
    return events;
  } catch (error) {
    log.error('calendar-fetch', 'Failed to fetch events', { error: error.message });
    if (_cache.events) {
      log.info('calendar-fetch', 'Returning stale cached events');
      return _cache.events;
    }
    throw error;
  }
}

/**
 * Enrich events with full details (attendees, description, etc.)
 */
async function _enrichEventsWithDetails(events) {
  const CONCURRENCY = 5;
  const enriched = [];

  for (let i = 0; i < events.length; i += CONCURRENCY) {
    const batch = events.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (event) => {
        try {
          const response = await fetch(OMNICAL_DETAILS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ CalendarId: 'primary', eventId: event.id }),
          });
          if (response.ok) {
            const details = await response.json();
            const eventData = details.event || details;
            return { ...event, ...eventData };
          }
          return event;
        } catch {
          return event;
        }
      })
    );
    enriched.push(...results);
  }

  return enriched;
}

/**
 * Fetch details for a single event.
 */
async function fetchEventDetails(eventId, calendarId = 'primary') {
  const response = await fetch(OMNICAL_DETAILS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ CalendarId: calendarId, eventId }),
  });
  if (!response.ok) throw new Error(`Details API error: ${response.status}`);
  const data = await response.json();
  return data.event || data;
}

/**
 * Create an event via the Omnical API (raw, no verification).
 */
async function rawCreateEvent(params) {
  const {
    title,
    date,
    time,
    duration = '60m',
    location = '',
    description = '',
    guests = [],
    timeZone = 'America/Los_Angeles',
  } = params;

  const requestBody = {
    title,
    description,
    startDate: date,
    startTime: time,
    eventDuration: duration,
    location,
    guests: Array.isArray(guests) ? guests : [],
    timeZone,
  };

  log.info('calendar-fetch', 'Creating event', { title, date, time });

  const response = await fetch(OMNICAL_ADD_EVENT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Create event failed (${response.status}): ${errorText}`);
  }

  return response.json();
}

/**
 * Delete an event via the Omnical API (raw, no verification).
 */
async function rawDeleteEvent(eventId, calendarId = 'primary') {
  log.info('calendar-fetch', 'Deleting event', { eventId, calendarId });

  const response = await fetch(OMNICAL_DELETE_EVENT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ calendarId, eventId }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 404) {
      throw new Error('Event not found -- it may have already been deleted.');
    }
    throw new Error(`Delete event failed (${response.status}): ${errorText}`);
  }

  return response.json();
}

// ────────────────────────────────────────────────────────────────────────────
// Convenience Wrappers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Fetch events for a day (resolves timeframe, fetches, returns raw events + date range).
 */
async function getEventsForDay(dayRef, now = new Date()) {
  const dateRange = resolveTimeframe(dayRef, now);
  // Always fetch a 14-day window (matches old behavior), filter in analyzeDay
  const windowStart = new Date(now);
  windowStart.setHours(0, 0, 0, 0);
  const windowEnd = new Date(windowStart.getTime() + 14 * 24 * 60 * 60 * 1000);
  const events = await fetchEventsForRange(windowStart, windowEnd);
  return { events, dateRange };
}

/**
 * Fetch events for a week.
 */
async function getEventsForWeek(weekRef, now = new Date()) {
  const dateRange = resolveTimeframe(weekRef, now);
  const windowStart = new Date(dateRange.start);
  const windowEnd = new Date(dateRange.end.getTime() + 24 * 60 * 60 * 1000);
  const events = await fetchEventsForRange(windowStart, windowEnd);
  return { events, dateRange };
}

/**
 * Fetch events for a month.
 */
async function getEventsForMonth(monthRef, now = new Date()) {
  const dateRange = resolveTimeframe(monthRef, now);
  const windowStart = new Date(dateRange.start);
  const windowEnd = new Date(dateRange.end.getTime() + 24 * 60 * 60 * 1000);
  const events = await fetchEventsForRange(windowStart, windowEnd);
  return { events, dateRange };
}

// ────────────────────────────────────────────────────────────────────────────
// Verified Mutations
// ────────────────────────────────────────────────────────────────────────────

const _sleep = (ms) =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

/**
 * Create an event and verify it appears in the calendar.
 * Returns the fresh DayAnalysis so the agent can render the updated HUD immediately.
 */
async function createEventVerified(params) {
  const result = await rawCreateEvent(params);
  invalidateCache();

  await _sleep(500);

  const { events } = await getEventsForDay(params.date);
  const now = new Date();
  const dateRange = resolveTimeframe(params.date, now);
  const day = analyzeDay(events, dateRange.start, now);

  // Search for the new event
  const titleLower = (params.title || '').toLowerCase();
  const found = day.all.find((e) => {
    const evTitle = (e.event.summary || '').toLowerCase();
    return evTitle.includes(titleLower) || titleLower.includes(evTitle);
  });

  if (found) {
    return { success: true, verified: true, event: found, day };
  }

  // Retry once
  await _sleep(1000);
  invalidateCache();
  const { events: retryEvents } = await getEventsForDay(params.date);
  const retryDay = analyzeDay(retryEvents, dateRange.start, new Date());
  const retryFound = retryDay.all.find((e) => {
    const evTitle = (e.event.summary || '').toLowerCase();
    return evTitle.includes(titleLower) || titleLower.includes(evTitle);
  });

  if (retryFound) {
    return { success: true, verified: true, event: retryFound, day: retryDay };
  }

  return {
    success: true,
    verified: false,
    warning: 'Event created but not yet visible in calendar.',
    apiResult: result,
    day: retryDay,
  };
}

/**
 * Delete an event and verify it's gone.
 */
async function deleteEventVerified(eventId, calendarId, targetDate) {
  await rawDeleteEvent(eventId, calendarId);
  invalidateCache();

  await _sleep(500);

  const { events } = await getEventsForDay(targetDate || 'today');
  const now = new Date();
  const dateRange = resolveTimeframe(targetDate || 'today', now);
  const day = analyzeDay(events, dateRange.start, now);

  const stillExists = day.all.find((e) => (e.event.id || e.event.eventId) === eventId);

  if (!stillExists) {
    return { success: true, verified: true, day };
  }

  // Retry
  await _sleep(1000);
  invalidateCache();
  const { events: retryEvents } = await getEventsForDay(targetDate || 'today');
  const retryDay = analyzeDay(retryEvents, dateRange.start, new Date());
  const retryStillExists = retryDay.all.find((e) => (e.event.id || e.event.eventId) === eventId);

  if (!retryStillExists) {
    return { success: true, verified: true, day: retryDay };
  }

  return {
    success: true,
    verified: false,
    warning: 'Event deleted but still appears in calendar.',
    day: retryDay,
  };
}

/**
 * Edit an event via delete+recreate and verify.
 */
async function editEventVerified(eventId, calendarId, targetDate, newParams) {
  // Fetch current event
  const current = await fetchEventDetails(eventId, calendarId);

  // Delete old
  await rawDeleteEvent(eventId, calendarId);
  invalidateCache();

  // Build merged params
  const merged = {
    title: newParams.title || current.summary || current.title,
    date: newParams.date || (current.start?.dateTime || current.start?.date || '').slice(0, 10),
    time: newParams.time || (current.start?.dateTime || '').slice(11, 16) || '09:00',
    duration: newParams.duration || _computeDuration(current),
    location: newParams.location !== undefined ? newParams.location : current.location || '',
    description: newParams.description !== undefined ? newParams.description : current.description || '',
    guests: newParams.guests || _extractGuestEmails(current),
  };

  // Create updated event
  const _createResult = await rawCreateEvent(merged);
  invalidateCache();

  await _sleep(500);

  // Verify: old gone, new present
  const { events } = await getEventsForDay(merged.date);
  const now = new Date();
  const dateRange = resolveTimeframe(merged.date, now);
  const day = analyzeDay(events, dateRange.start, now);

  const oldStillExists = day.all.find((e) => (e.event.id || e.event.eventId) === eventId);
  const titleLower = merged.title.toLowerCase();
  const newFound = day.all.find((e) => {
    const evTitle = (e.event.summary || '').toLowerCase();
    return evTitle.includes(titleLower) || titleLower.includes(evTitle);
  });

  return {
    success: true,
    verified: !oldStillExists && !!newFound,
    event: newFound || null,
    day,
    warning: oldStillExists ? 'Old event still visible.' : !newFound ? 'Updated event not yet visible.' : undefined,
  };
}

function _computeDuration(event) {
  if (!event.start?.dateTime || !event.end?.dateTime) return '60m';
  const start = new Date(event.start.dateTime);
  const end = new Date(event.end.dateTime);
  const mins = Math.round((end - start) / 60000);
  if (mins <= 0) return '60m';
  if (mins >= 60 && mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}

function _extractGuestEmails(event) {
  if (!event.attendees || event.attendees.length === 0) return [];
  return event.attendees.filter((a) => a.email && !a.self).map((a) => a.email);
}

// ────────────────────────────────────────────────────────────────────────────
// Exports
// ────────────────────────────────────────────────────────────────────────────

module.exports = {
  // Date resolution (pure, testable)
  resolveTimeframe,
  resolveEventDate,

  // Fetch
  fetchEventsForRange,
  fetchEventDetails,
  getEventsForDay,
  getEventsForWeek,
  getEventsForMonth,

  // Raw mutations
  rawCreateEvent,
  rawDeleteEvent,

  // Verified mutations
  createEventVerified,
  deleteEventVerified,
  editEventVerified,

  // Cache
  invalidateCache,

  // Constants (for agents that need direct API access)
  OMNICAL_API_URL,
  OMNICAL_ADD_EVENT_URL,
  OMNICAL_DELETE_EVENT_URL,
  OMNICAL_DETAILS_URL,
};
