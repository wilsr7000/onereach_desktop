/**
 * CalendarStore - Persistent Local Calendar with Recurring Events
 *
 * Provides a full-featured calendar engine:
 *   - Local event CRUD (persisted to Spaces)
 *   - Recurring events (daily, weekdays, weekly, biweekly, monthly, yearly, custom)
 *   - Occurrence expansion within arbitrary date ranges
 *   - Single-occurrence exceptions and modifications
 *   - Conflict detection and resolution helpers
 *   - Free/busy calculation and free-slot finder
 *   - Morning brief generation
 *   - Week/day summaries with recurring vs one-off breakdown
 *   - Merge with external calendar sources (omnical / Google)
 *
 * Storage: events are kept in ~/Documents/OR-Spaces/calendar-store/events.json
 * and also persisted via the Spaces API for UI visibility.
 *
 * @module CalendarStore
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

// ─── Constants ───────────────────────────────────────────────────────────────

const STORE_DIR_NAME = 'calendar-store';
const EVENTS_FILE = 'events.json';
const SETTINGS_FILE = 'settings.json';

const DEFAULT_WORKING_HOURS = { start: 9, end: 17 }; // 9 AM – 5 PM
const DEFAULT_MIN_GAP_MINUTES = 15; // Minimum gap between meetings
const DEFAULT_EVENT_DURATION_MINUTES = 30;
const _SLOT_STEP_MINUTES = 15; // Resolution for free-slot search

const _RECURRENCE_PATTERNS = ['daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'yearly', 'custom'];

// Day-of-week indices: 0 = Sunday … 6 = Saturday
const WEEKDAY_INDICES = [1, 2, 3, 4, 5];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function uuid() {
  return 'evt_' + crypto.randomUUID();
}

function startOfDay(d) {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

function endOfDay(d) {
  const r = new Date(d);
  r.setHours(23, 59, 59, 999);
  return r;
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function addMonths(d, n) {
  const r = new Date(d);
  r.setMonth(r.getMonth() + n);
  return r;
}

function addYears(d, n) {
  const r = new Date(d);
  r.setFullYear(r.getFullYear() + n);
  return r;
}

function isoDate(d) {
  const dt = new Date(d);
  // Use LOCAL date components, not UTC -- users think in local time
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function sameDay(a, b) {
  return isoDate(a) === isoDate(b);
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function durationMinutes(start, end) {
  return Math.round((new Date(end) - new Date(start)) / 60000);
}

function formatTime12(d) {
  return new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function dayName(d) {
  return new Date(d).toLocaleDateString('en-US', { weekday: 'long' });
}

function friendlyDate(d) {
  const today = startOfDay(new Date());
  const target = startOfDay(d);
  const diff = Math.round((target - today) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff <= 6) return dayName(d);
  return new Date(d).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

// ─── Store directory ─────────────────────────────────────────────────────────

function getStoreDir() {
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
  const dir = path.join(home, 'Documents', 'OR-Spaces', STORE_DIR_NAME);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// ─── CalendarStore class ─────────────────────────────────────────────────────

class CalendarStore {
  constructor() {
    this._events = []; // Array of event objects
    this._settings = {
      workingHours: { ...DEFAULT_WORKING_HOURS },
      minGapMinutes: DEFAULT_MIN_GAP_MINUTES,
      defaultDuration: DEFAULT_EVENT_DURATION_MINUTES,
      morningBriefTime: '07:30', // HH:MM
      morningBriefEnabled: false,
      eveningSummaryTime: '18:00',
      eveningSummaryEnabled: false,
      defaultReminders: [15], // minutes before
      defaultCalendar: 'personal',
    };
    this._loaded = false;
    this._dirty = false;
    this._briefTimer = null;
    this._lastBriefDate = null; // Track last brief date to avoid repeats
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PERSISTENCE
  // ═══════════════════════════════════════════════════════════════════════════

  load() {
    try {
      const dir = getStoreDir();
      const eventsPath = path.join(dir, EVENTS_FILE);
      const settingsPath = path.join(dir, SETTINGS_FILE);

      if (fs.existsSync(eventsPath)) {
        const raw = fs.readFileSync(eventsPath, 'utf8');
        this._events = JSON.parse(raw);
        log.info('agent', `CalendarStore loaded ${this._events.length} events`);
      }

      if (fs.existsSync(settingsPath)) {
        const raw = fs.readFileSync(settingsPath, 'utf8');
        Object.assign(this._settings, JSON.parse(raw));
      }

      this._loaded = true;
      this._dirty = false;
    } catch (err) {
      log.error('agent', 'CalendarStore load error', { error: err.message });
      this._events = [];
      this._loaded = true;
    }
  }

  save() {
    try {
      const dir = getStoreDir();
      fs.writeFileSync(path.join(dir, EVENTS_FILE), JSON.stringify(this._events, null, 2));
      fs.writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify(this._settings, null, 2));
      this._dirty = false;
      log.info('agent', `CalendarStore saved ${this._events.length} events`);
    } catch (err) {
      log.error('agent', 'CalendarStore save error', { error: err.message });
    }
  }

  _ensureLoaded() {
    if (!this._loaded) this.load();
  }

  _markDirty() {
    this._dirty = true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SETTINGS
  // ═══════════════════════════════════════════════════════════════════════════

  getSettings() {
    this._ensureLoaded();
    return { ...this._settings };
  }

  updateSettings(changes) {
    this._ensureLoaded();
    Object.assign(this._settings, changes);
    this._markDirty();
    this.save();
    return this._settings;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EVENT CRUD
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Add a new event.
   *
   * @param {Object} eventData
   * @param {string} eventData.title - Event title (required)
   * @param {string} eventData.startTime - ISO datetime (required)
   * @param {string} [eventData.endTime] - ISO datetime (defaults to startTime + defaultDuration)
   * @param {boolean} [eventData.allDay=false]
   * @param {string} [eventData.description]
   * @param {string} [eventData.location]
   * @param {string[]} [eventData.guests]
   * @param {Object} [eventData.recurring] - Recurrence rule
   * @param {number[]} [eventData.reminders] - Minutes before
   * @param {string} [eventData.calendar='personal']
   * @param {string} [eventData.color]
   * @returns {{ event: Object, conflicts: Object[] }}
   */
  addEvent(eventData) {
    this._ensureLoaded();

    const event = {
      id: eventData.id || uuid(),
      title: eventData.title || 'Untitled Event',
      description: eventData.description || '',
      location: eventData.location || '',
      startTime: eventData.startTime,
      endTime: eventData.endTime || this._defaultEndTime(eventData.startTime),
      allDay: eventData.allDay || false,
      recurring: eventData.recurring || null,
      reminders: eventData.reminders || [...this._settings.defaultReminders],
      guests: eventData.guests || [],
      calendar: eventData.calendar || this._settings.defaultCalendar,
      color: eventData.color || null,
      source: eventData.source || 'local',
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      // For recurring events: tracks exception dates and per-occurrence overrides
      exceptions: eventData.exceptions || [], // dates to skip (YYYY-MM-DD)
      overrides: eventData.overrides || {}, // { 'YYYY-MM-DD': { title, startTime, ... } }
    };

    // Validate recurrence if present
    if (event.recurring) {
      event.recurring = this._normalizeRecurrence(event.recurring);
    }

    // Check for conflicts (non-allDay events only)
    const conflicts = event.allDay ? [] : this.findConflicts(event.startTime, event.endTime, null);

    this._events.push(event);
    this._markDirty();
    this.save();

    log.info('agent', `CalendarStore: added event "${event.title}"`, {
      id: event.id,
      recurring: !!event.recurring,
      conflicts: conflicts.length,
    });

    return { event, conflicts };
  }

  /**
   * Update an existing event.
   */
  updateEvent(eventId, changes) {
    this._ensureLoaded();
    const idx = this._events.findIndex((e) => e.id === eventId);
    if (idx === -1) return null;

    const event = this._events[idx];
    const allowed = [
      'title',
      'description',
      'location',
      'startTime',
      'endTime',
      'allDay',
      'recurring',
      'reminders',
      'guests',
      'calendar',
      'color',
      'exceptions',
      'overrides',
    ];
    for (const key of allowed) {
      if (changes[key] !== undefined) event[key] = changes[key];
    }
    if (changes.recurring) {
      event.recurring = this._normalizeRecurrence(changes.recurring);
    }
    event.updated = new Date().toISOString();

    this._markDirty();
    this.save();
    return event;
  }

  /**
   * Delete an event by ID.
   */
  deleteEvent(eventId) {
    this._ensureLoaded();
    const idx = this._events.findIndex((e) => e.id === eventId);
    if (idx === -1) return false;
    const removed = this._events.splice(idx, 1)[0];
    this._markDirty();
    this.save();
    log.info('agent', `CalendarStore: deleted "${removed.title}"`);
    return true;
  }

  /**
   * Get a single event by ID.
   */
  getEvent(eventId) {
    this._ensureLoaded();
    return this._events.find((e) => e.id === eventId) || null;
  }

  /**
   * Search events by title (partial, case-insensitive).
   */
  searchEvents(query, dateRange) {
    this._ensureLoaded();
    const q = (query || '').toLowerCase();
    let pool = this._events;
    if (dateRange) {
      pool = this.getEventsInRange(dateRange.start, dateRange.end);
    }
    return pool.filter((e) => e.title.toLowerCase().includes(q));
  }

  /**
   * Get all raw events (no recurrence expansion).
   */
  getAllEvents() {
    this._ensureLoaded();
    return [...this._events];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RECURRING EVENTS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Normalize a recurrence rule to a standard shape.
   */
  _normalizeRecurrence(rec) {
    if (!rec) return null;
    return {
      pattern: rec.pattern || 'weekly',
      daysOfWeek: rec.daysOfWeek || null,
      dayOfMonth: rec.dayOfMonth || null,
      interval: rec.interval || 1,
      endDate: rec.endDate || null,
      endAfter: rec.endAfter || null,
    };
  }

  /**
   * Expand a recurring event into concrete occurrences within [rangeStart, rangeEnd].
   *
   * Each occurrence is a shallow copy of the event with adjusted startTime / endTime
   * and an `occurrenceDate` property (YYYY-MM-DD).
   *
   * Respects exceptions (skipped dates) and overrides (per-date changes).
   */
  expandRecurring(event, rangeStart, rangeEnd) {
    if (!event.recurring) return [];

    const rs = new Date(rangeStart);
    const re = new Date(rangeEnd);
    const rule = event.recurring;
    const eventDuration = new Date(event.endTime) - new Date(event.startTime);
    const baseDate = new Date(event.startTime);
    const occurrences = [];
    let count = 0;
    const maxExpand = 400; // safety cap

    let cursor = new Date(baseDate);

    while (cursor <= re && count < maxExpand) {
      if (cursor >= rs) {
        const dateStr = isoDate(cursor);

        // Skip exceptions
        if (!(event.exceptions || []).includes(dateStr)) {
          // Check if this occurrence should appear based on pattern
          if (this._matchesPattern(cursor, baseDate, rule)) {
            const occ = this._buildOccurrence(event, cursor, eventDuration, dateStr);
            occurrences.push(occ);
            count++;
          }
        }
      }

      // Check endAfter
      if (rule.endAfter && count >= rule.endAfter) break;

      // Advance cursor
      cursor = this._advanceCursor(cursor, baseDate, rule);

      // Check endDate
      if (rule.endDate && cursor > new Date(rule.endDate)) break;
    }

    return occurrences;
  }

  /**
   * Does this cursor date match the recurrence pattern?
   */
  _matchesPattern(cursor, baseDate, rule) {
    const day = cursor.getDay();

    switch (rule.pattern) {
      case 'daily':
        return true;

      case 'weekdays':
        return WEEKDAY_INDICES.includes(day);

      case 'weekly':
        if (rule.daysOfWeek && rule.daysOfWeek.length > 0) {
          return rule.daysOfWeek.includes(day);
        }
        return day === baseDate.getDay();

      case 'biweekly': {
        if (rule.daysOfWeek && rule.daysOfWeek.length > 0 && !rule.daysOfWeek.includes(day)) {
          return false;
        }
        const weekDiff = Math.floor((cursor - baseDate) / (7 * 86400000));
        return weekDiff % 2 === 0;
      }

      case 'monthly':
        if (rule.dayOfMonth) return cursor.getDate() === rule.dayOfMonth;
        return cursor.getDate() === baseDate.getDate();

      case 'yearly':
        return cursor.getDate() === baseDate.getDate() && cursor.getMonth() === baseDate.getMonth();

      case 'custom':
        // Custom: user specifies exact daysOfWeek
        if (rule.daysOfWeek && rule.daysOfWeek.length > 0) {
          return rule.daysOfWeek.includes(day);
        }
        return true;

      default:
        return true;
    }
  }

  /**
   * Advance the cursor by one step according to the recurrence pattern.
   */
  _advanceCursor(cursor, baseDate, rule) {
    switch (rule.pattern) {
      case 'daily':
      case 'weekdays':
        return addDays(cursor, 1);

      case 'weekly':
      case 'custom':
        // If specific days, advance one day at a time
        if (rule.daysOfWeek && rule.daysOfWeek.length > 0) {
          return addDays(cursor, 1);
        }
        return addDays(cursor, 7 * (rule.interval || 1));

      case 'biweekly':
        if (rule.daysOfWeek && rule.daysOfWeek.length > 0) {
          return addDays(cursor, 1);
        }
        return addDays(cursor, 14);

      case 'monthly':
        return addMonths(cursor, rule.interval || 1);

      case 'yearly':
        return addYears(cursor, rule.interval || 1);

      default:
        return addDays(cursor, 1);
    }
  }

  /**
   * Build a concrete occurrence from a recurring event template.
   */
  _buildOccurrence(event, cursorDate, durationMs, dateStr) {
    // Start with base event times, but on the cursor's date
    const base = new Date(event.startTime);
    const occStart = new Date(cursorDate);
    occStart.setHours(base.getHours(), base.getMinutes(), base.getSeconds(), 0);
    const occEnd = new Date(occStart.getTime() + durationMs);

    // Apply overrides if present for this date
    const override = (event.overrides || {})[dateStr];
    const occ = {
      ...event,
      startTime: override?.startTime || occStart.toISOString(),
      endTime: override?.endTime || occEnd.toISOString(),
      title: override?.title || event.title,
      location: override?.location || event.location,
      description: override?.description || event.description,
      occurrenceDate: dateStr,
      isRecurringInstance: true,
      parentEventId: event.id,
    };

    return occ;
  }

  /**
   * Add an exception date to a recurring event (skip one occurrence).
   */
  addException(eventId, date) {
    const event = this.getEvent(eventId);
    if (!event || !event.recurring) return false;
    const dateStr = isoDate(date);
    if (!event.exceptions) event.exceptions = [];
    if (!event.exceptions.includes(dateStr)) {
      event.exceptions.push(dateStr);
      event.updated = new Date().toISOString();
      this._markDirty();
      this.save();
    }
    return true;
  }

  /**
   * Override a single occurrence of a recurring event.
   */
  overrideOccurrence(eventId, date, changes) {
    const event = this.getEvent(eventId);
    if (!event || !event.recurring) return false;
    const dateStr = isoDate(date);
    if (!event.overrides) event.overrides = {};
    event.overrides[dateStr] = { ...(event.overrides[dateStr] || {}), ...changes };
    event.updated = new Date().toISOString();
    this._markDirty();
    this.save();
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // QUERYING: EVENTS IN RANGE (with recurrence expansion + merge)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get all events (one-off + expanded recurring) within a date range.
   * Optionally merge in external events.
   *
   * @param {Date|string} rangeStart
   * @param {Date|string} rangeEnd
   * @param {Object[]} [externalEvents] - Events from omnical / Google to merge
   * @returns {Object[]} Sorted by startTime
   */
  getEventsInRange(rangeStart, rangeEnd, externalEvents) {
    this._ensureLoaded();
    const rs = new Date(rangeStart);
    const re = new Date(rangeEnd);
    const results = [];

    for (const event of this._events) {
      if (event.recurring) {
        // Expand recurring into this range
        const occs = this.expandRecurring(event, rs, re);
        results.push(...occs);
      } else {
        // One-off: check if it falls in range
        const es = new Date(event.startTime);
        const ee = new Date(event.endTime);
        if (overlaps(es, ee, rs, re)) {
          results.push({ ...event, isRecurringInstance: false });
        }
      }
    }

    // Merge external events (de-duplicate by ID, then by title + time)
    if (externalEvents && externalEvents.length > 0) {
      const seenIds = new Set(results.map((r) => r.id).filter(Boolean));
      for (const ext of externalEvents) {
        const normalExt = this._normalizeExternalEvent(ext);
        // De-dup by ID first (most reliable)
        if (normalExt.id && seenIds.has(normalExt.id)) continue;
        // De-dup: skip if an existing event has same title and overlapping time
        const isDup = results.some(
          (r) =>
            r.title.toLowerCase() === normalExt.title.toLowerCase() &&
            Math.abs(new Date(r.startTime) - new Date(normalExt.startTime)) < 300000 // 5 min
        );
        if (!isDup) {
          if (normalExt.id) seenIds.add(normalExt.id);
          results.push(normalExt);
        }
      }
    }

    // Sort by start time
    results.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    return results;
  }

  /**
   * Get events for a specific day.
   */
  getEventsForDay(date, externalEvents) {
    const d = new Date(date);
    return this.getEventsInRange(startOfDay(d), endOfDay(d), externalEvents);
  }

  /**
   * Get events for today.
   */
  getEventsToday(externalEvents) {
    return this.getEventsForDay(new Date(), externalEvents);
  }

  /**
   * Get events for the current week (Monday–Sunday).
   */
  getEventsThisWeek(externalEvents) {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const monday = addDays(now, dayOfWeek === 0 ? -6 : 1 - dayOfWeek);
    const sunday = addDays(monday, 6);
    return this.getEventsInRange(startOfDay(monday), endOfDay(sunday), externalEvents);
  }

  /**
   * Normalize an external calendar event (omnical/Google format) to our format.
   */
  _normalizeExternalEvent(ext) {
    return {
      id: ext.id || ext.eventId || uuid(),
      title: ext.summary || ext.title || 'Untitled',
      description: ext.description || '',
      location: ext.location || '',
      startTime: ext.start?.dateTime || ext.start?.date || ext.startTime || '',
      endTime: ext.end?.dateTime || ext.end?.date || ext.endTime || '',
      allDay: !ext.start?.dateTime,
      recurring: null,
      isRecurringInstance: !!ext.recurringEventId,
      parentEventId: ext.recurringEventId || null,
      reminders: [],
      guests: (ext.attendees || []).map((a) => a.email || a),
      calendar: ext.calendarId || 'external',
      source: 'external',
      color: ext.colorId || null,
      created: ext.created || '',
      updated: ext.updated || '',
    };
  }

  _defaultEndTime(startTime) {
    const d = new Date(startTime);
    d.setMinutes(d.getMinutes() + this._settings.defaultDuration);
    return d.toISOString();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONFLICT DETECTION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Find events that overlap with a given time range.
   *
   * @param {Date|string} start
   * @param {Date|string} end
   * @param {string|null} [excludeEventId] - Event ID to exclude (for editing)
   * @returns {Object[]} Conflicting events
   */
  findConflicts(start, end, excludeEventId) {
    const s = new Date(start);
    const e = new Date(end);

    // Get all events on the same day (plus a day before/after for safety)
    const rangeStart = addDays(startOfDay(s), -1);
    const rangeEnd = addDays(endOfDay(e), 1);
    const allEvents = this.getEventsInRange(rangeStart, rangeEnd);

    return allEvents.filter((evt) => {
      if (evt.allDay) return false;
      if (excludeEventId && (evt.id === excludeEventId || evt.parentEventId === excludeEventId)) return false;
      const es = new Date(evt.startTime);
      const ee = new Date(evt.endTime);
      return overlaps(s, e, es, ee);
    });
  }

  /**
   * Find ALL conflicts on a given day (any events that overlap with each other).
   *
   * @param {Date|string} date
   * @returns {Object[]} Array of { event1, event2, overlapMinutes }
   */
  findDayConflicts(date, externalEvents) {
    const events = this.getEventsForDay(date, externalEvents).filter((e) => !e.allDay);
    const conflicts = [];

    for (let i = 0; i < events.length; i++) {
      for (let j = i + 1; j < events.length; j++) {
        const a = events[i];
        const b = events[j];
        const aStart = new Date(a.startTime);
        const aEnd = new Date(a.endTime);
        const bStart = new Date(b.startTime);
        const bEnd = new Date(b.endTime);

        if (overlaps(aStart, aEnd, bStart, bEnd)) {
          const overlapStart = Math.max(aStart, bStart);
          const overlapEnd = Math.min(aEnd, bEnd);
          conflicts.push({
            event1: a,
            event2: b,
            overlapMinutes: Math.round((overlapEnd - overlapStart) / 60000),
          });
        }
      }
    }

    return conflicts;
  }

  /**
   * Check if a time slot is available (no conflicts).
   */
  isAvailable(start, end) {
    return this.findConflicts(start, end, null).length === 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FREE / BUSY
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get free slots on a given day, respecting working hours.
   *
   * @param {Date|string} date
   * @param {number} [minDurationMinutes=30] - Minimum slot length
   * @param {Object[]} [externalEvents] - External events to consider
   * @returns {{ start: string, end: string, durationMinutes: number }[]}
   */
  getFreeSlots(date, minDurationMinutes, externalEvents) {
    const minDur = minDurationMinutes || this._settings.defaultDuration;
    const d = new Date(date);
    const wh = this._settings.workingHours;

    // Working hours boundaries for this day
    const whStart = new Date(d);
    whStart.setHours(wh.start, 0, 0, 0);
    const whEnd = new Date(d);
    whEnd.setHours(wh.end, 0, 0, 0);

    // Get all non-allDay events for the day, sorted by start
    const events = this.getEventsForDay(d, externalEvents)
      .filter((e) => !e.allDay)
      .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

    const slots = [];
    let cursor = whStart;

    for (const evt of events) {
      const evtStart = new Date(evt.startTime);
      const evtEnd = new Date(evt.endTime);

      // If event starts after cursor, there's a gap
      if (evtStart > cursor) {
        const gapEnd = evtStart < whEnd ? evtStart : whEnd;
        const dur = durationMinutes(cursor, gapEnd);
        if (dur >= minDur) {
          slots.push({
            start: cursor.toISOString(),
            end: gapEnd.toISOString(),
            durationMinutes: dur,
          });
        }
      }

      // Move cursor past this event
      if (evtEnd > cursor) {
        cursor = new Date(evtEnd);
      }
    }

    // Gap after last event until end of working hours
    if (cursor < whEnd) {
      const dur = durationMinutes(cursor, whEnd);
      if (dur >= minDur) {
        slots.push({
          start: cursor.toISOString(),
          end: whEnd.toISOString(),
          durationMinutes: dur,
        });
      }
    }

    return slots;
  }

  /**
   * Suggest alternative times for a meeting of given duration.
   *
   * @param {number} durationMinutes
   * @param {Date|string} preferredDate
   * @param {number} [maxSuggestions=3]
   * @returns {{ start: string, end: string, day: string }[]}
   */
  suggestAlternatives(durationMinutes, preferredDate, maxSuggestions) {
    const max = maxSuggestions || 3;
    const suggestions = [];
    let d = new Date(preferredDate);

    // Search up to 5 days out
    for (let dayOffset = 0; dayOffset < 5 && suggestions.length < max; dayOffset++) {
      const dayToCheck = addDays(d, dayOffset);
      const slots = this.getFreeSlots(dayToCheck, durationMinutes);

      for (const slot of slots) {
        if (suggestions.length >= max) break;
        // Offer the start of each free slot
        const start = new Date(slot.start);
        const end = new Date(start.getTime() + durationMinutes * 60000);
        suggestions.push({
          start: start.toISOString(),
          end: end.toISOString(),
          day: friendlyDate(start),
          time: formatTime12(start),
        });
      }
    }

    return suggestions;
  }

  /**
   * Calculate total free and busy hours for a day.
   */
  getDayBalance(date, externalEvents) {
    const d = new Date(date);
    const wh = this._settings.workingHours;
    const totalWorkMinutes = (wh.end - wh.start) * 60;

    const events = this.getEventsForDay(d, externalEvents).filter((e) => !e.allDay);
    let busyMinutes = 0;
    for (const evt of events) {
      busyMinutes += durationMinutes(evt.startTime, evt.endTime);
    }
    // Cap busy to working hours
    busyMinutes = Math.min(busyMinutes, totalWorkMinutes);
    const freeMinutes = totalWorkMinutes - busyMinutes;

    return {
      totalWorkHours: totalWorkMinutes / 60,
      busyHours: Math.round((busyMinutes / 60) * 10) / 10,
      freeHours: Math.round((freeMinutes / 60) * 10) / 10,
      busyPercent: Math.round((busyMinutes / totalWorkMinutes) * 100),
      eventCount: events.length,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MORNING BRIEF
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Generate a comprehensive morning brief for a given day.
   *
   * @param {Date|string} [date] - Defaults to today
   * @param {Object[]} [externalEvents] - External events to merge
   * @returns {Object} Structured brief
   */
  generateMorningBrief(date, externalEvents) {
    const d = date ? new Date(date) : new Date();
    const now = new Date(); // actual current time for past/upcoming split
    const events = this.getEventsForDay(d, externalEvents);
    const dayLabel = friendlyDate(d);
    const dayOfWeek = dayName(d);

    // Separate timed vs all-day
    const timedEvents = events.filter((e) => !e.allDay);
    const allDayEvents = events.filter((e) => e.allDay);

    // Split timed events into past, in-progress, and upcoming based on current time
    const isToday = sameDay(d, now);
    const pastEvents = isToday ? timedEvents.filter((e) => new Date(e.endTime) <= now) : [];
    const inProgressEvents = isToday
      ? timedEvents.filter((e) => new Date(e.startTime) <= now && new Date(e.endTime) > now)
      : [];
    const upcomingEvents = isToday ? timedEvents.filter((e) => new Date(e.startTime) > now) : timedEvents; // If not today, all events are "upcoming" (future day)

    // Recurring vs one-off
    const recurring = timedEvents.filter((e) => e.isRecurringInstance || e.recurring);
    const oneOff = timedEvents.filter((e) => !e.isRecurringInstance && !e.recurring);

    // Conflicts (only for upcoming events if today)
    const conflicts = this.findDayConflicts(d, externalEvents);
    const upcomingConflicts = isToday
      ? conflicts.filter((c) => new Date(c.event1.endTime) > now || new Date(c.event2.endTime) > now)
      : conflicts;

    // Back-to-back detection (only upcoming)
    const eventsForBackToBack = isToday ? [...inProgressEvents, ...upcomingEvents] : timedEvents;
    const backToBack = this._findBackToBack(eventsForBackToBack);

    // Free time -- for today, only show remaining free time
    const balance = this.getDayBalance(d, externalEvents);
    const allFreeSlots = this.getFreeSlots(d, 30, externalEvents);
    const freeSlots = isToday ? allFreeSlots.filter((s) => new Date(s.end) > now) : allFreeSlots;

    // Recalculate remaining free hours for today
    let remainingFreeHours = balance.freeHours;
    if (isToday && freeSlots.length > 0) {
      const remainingFreeMinutes = freeSlots.reduce((sum, s) => {
        const slotStart = new Date(s.start) < now ? now : new Date(s.start);
        const slotEnd = new Date(s.end);
        return sum + Math.max(0, (slotEnd - slotStart) / 60000);
      }, 0);
      remainingFreeHours = Math.round((remainingFreeMinutes / 60) * 10) / 10;
    }

    // Next upcoming meeting (first that hasn't started yet)
    const nextMeeting = upcomingEvents[0] || null;

    // Currently in-progress meeting
    const currentMeeting = inProgressEvents[0] || null;

    // First and last meetings of the day (for context)
    const firstMeeting = timedEvents[0] || null;
    const lastMeeting = timedEvents.length > 0 ? timedEvents[timedEvents.length - 1] : null;

    // Longest remaining free stretch
    const longestFree = freeSlots.reduce((max, s) => (s.durationMinutes > max.durationMinutes ? s : max), {
      durationMinutes: 0,
    });

    // Tomorrow preview
    const tomorrow = addDays(d, 1);
    const tomorrowEvents = this.getEventsForDay(tomorrow, externalEvents);
    const tomorrowFirst = tomorrowEvents.filter((e) => !e.allDay)[0] || null;

    return {
      date: d.toISOString(),
      currentTime: now.toISOString(),
      currentTimeFormatted: formatTime12(now),
      isToday,
      dayLabel,
      dayOfWeek,
      greeting: this._briefGreeting(now),

      summary: {
        totalEvents: events.length,
        timedEvents: timedEvents.length,
        allDayEvents: allDayEvents.length,
        recurringCount: recurring.length,
        oneOffCount: oneOff.length,
        completedCount: pastEvents.length,
        inProgressCount: inProgressEvents.length,
        upcomingCount: upcomingEvents.length,
      },

      // Full timeline for reference
      timeline: timedEvents.map((e) => {
        const evtEnd = new Date(e.endTime);
        const evtStart = new Date(e.startTime);
        let status = 'upcoming';
        if (isToday && evtEnd <= now) status = 'completed';
        else if (isToday && evtStart <= now && evtEnd > now) status = 'in-progress';
        return {
          title: e.title,
          start: formatTime12(e.startTime),
          end: formatTime12(e.endTime),
          duration: durationMinutes(e.startTime, e.endTime),
          location: e.location || null,
          isRecurring: e.isRecurringInstance || !!e.recurring,
          guests: e.guests || [],
          status,
        };
      }),

      allDayEvents: allDayEvents.map((e) => ({
        title: e.title,
        isRecurring: e.isRecurringInstance || !!e.recurring,
      })),

      conflicts: upcomingConflicts.map((c) => ({
        event1: c.event1.title,
        event2: c.event2.title,
        overlapMinutes: c.overlapMinutes,
        time: formatTime12(c.event1.startTime),
      })),

      backToBack: backToBack.map((pair) => ({
        first: pair[0].title,
        second: pair[1].title,
        transitionTime: formatTime12(pair[0].endTime),
      })),

      freeTime: {
        totalFreeHours: balance.freeHours,
        remainingFreeHours,
        busyHours: balance.busyHours,
        busyPercent: balance.busyPercent,
        longestFreeBlock:
          longestFree.durationMinutes > 0
            ? `${longestFree.durationMinutes} minutes starting at ${formatTime12(longestFree.start)}`
            : null,
        freeSlots: freeSlots.map((s) => ({
          start: formatTime12(s.start),
          end: formatTime12(s.end),
          duration: s.durationMinutes,
        })),
      },

      // Current meeting (in-progress right now)
      currentMeeting: currentMeeting
        ? {
            title: currentMeeting.title,
            start: formatTime12(currentMeeting.startTime),
            end: formatTime12(currentMeeting.endTime),
            location: currentMeeting.location || null,
            minutesRemaining: Math.max(0, Math.round((new Date(currentMeeting.endTime) - now) / 60000)),
          }
        : null,

      // Next upcoming meeting (hasn't started yet)
      nextMeeting: nextMeeting
        ? {
            title: nextMeeting.title,
            time: formatTime12(nextMeeting.startTime),
            location: nextMeeting.location || null,
            minutesUntil: Math.max(0, Math.round((new Date(nextMeeting.startTime) - now) / 60000)),
          }
        : null,

      // Legacy: first/last for full-day context
      firstMeeting: firstMeeting
        ? {
            title: firstMeeting.title,
            time: formatTime12(firstMeeting.startTime),
            location: firstMeeting.location || null,
          }
        : null,

      lastMeeting: lastMeeting
        ? {
            title: lastMeeting.title,
            time: formatTime12(lastMeeting.startTime),
          }
        : null,

      tomorrowPreview: {
        eventCount: tomorrowEvents.length,
        firstMeeting: tomorrowFirst
          ? {
              title: tomorrowFirst.title,
              time: formatTime12(tomorrowFirst.startTime),
            }
          : null,
      },
    };
  }

  /**
   * Render a morning brief as a natural-language string (for TTS).
   */
  renderBriefForSpeech(brief) {
    const parts = [];
    const isToday = brief.isToday !== false; // default true for backward compat
    const { completedCount = 0, inProgressCount = 0, upcomingCount = 0 } = brief.summary;

    // Greeting
    parts.push(brief.greeting);

    // Day overview -- time-aware
    if (brief.summary.totalEvents === 0) {
      parts.push(`Your calendar is clear ${brief.dayLabel.toLowerCase()}. No meetings scheduled.`);
    } else if (isToday && completedCount > 0 && upcomingCount === 0 && inProgressCount === 0) {
      // All meetings are done
      const evtWord = completedCount === 1 ? 'meeting' : 'meetings';
      parts.push(`You had ${completedCount} ${evtWord} today, and they're all done.`);
    } else if (isToday && completedCount > 0) {
      // Mix of past and upcoming
      const doneWord = completedCount === 1 ? 'meeting' : 'meetings';
      const leftWord = upcomingCount === 1 ? 'meeting' : 'meetings';
      let overview = `You've had ${completedCount} ${doneWord} already today.`;
      if (inProgressCount > 0) {
        overview += ` You're in a meeting right now.`;
      }
      if (upcomingCount > 0) {
        overview += ` You still have ${upcomingCount} ${leftWord} ahead.`;
      }
      parts.push(overview);
    } else {
      // All upcoming (morning brief or future day)
      const evtWord = brief.summary.timedEvents === 1 ? 'meeting' : 'meetings';
      parts.push(`You have ${brief.summary.timedEvents} ${evtWord} ${brief.dayLabel.toLowerCase()}.`);
    }

    if (brief.summary.allDayEvents > 0) {
      const adWord = brief.summary.allDayEvents === 1 ? 'all-day event' : 'all-day events';
      parts.push(`Plus ${brief.summary.allDayEvents} ${adWord}.`);
    }

    // Recurring breakdown (only if there are upcoming events to care about)
    if (brief.summary.recurringCount > 0 && brief.summary.oneOffCount > 0 && upcomingCount > 0) {
      parts.push(
        `${brief.summary.recurringCount} ${brief.summary.recurringCount === 1 ? 'is' : 'are'} recurring, ` +
          `${brief.summary.oneOffCount} ${brief.summary.oneOffCount === 1 ? 'is' : 'are'} one-time.`
      );
    }

    // Current meeting (in-progress)
    if (brief.currentMeeting) {
      const locPart = brief.currentMeeting.location ? ` at ${brief.currentMeeting.location}` : '';
      parts.push(
        `Right now you're in "${brief.currentMeeting.title}"${locPart}, wrapping up in about ${brief.currentMeeting.minutesRemaining} minutes.`
      );
    }

    // For today: show "next meeting" (first upcoming, skipping past ones)
    // For future days: show "first meeting" (all events are in the future)
    if (isToday && brief.nextMeeting) {
      const locPart = brief.nextMeeting.location ? ` at ${brief.nextMeeting.location}` : '';
      if (brief.nextMeeting.minutesUntil <= 60) {
        parts.push(
          `Your next meeting is "${brief.nextMeeting.title}" at ${brief.nextMeeting.time}${locPart}, that's in about ${brief.nextMeeting.minutesUntil} minutes.`
        );
      } else {
        parts.push(`Your next meeting is "${brief.nextMeeting.title}" at ${brief.nextMeeting.time}${locPart}.`);
      }
    } else if (!isToday && brief.firstMeeting) {
      const locPart = brief.firstMeeting.location ? ` at ${brief.firstMeeting.location}` : '';
      parts.push(`Your first meeting is "${brief.firstMeeting.title}" at ${brief.firstMeeting.time}${locPart}.`);
    }

    // Conflicts (only upcoming ones)
    if (brief.conflicts.length > 0) {
      const conflictWord = brief.conflicts.length === 1 ? 'conflict' : 'conflicts';
      parts.push(`Heads up: you have ${brief.conflicts.length} upcoming scheduling ${conflictWord}.`);
      for (const c of brief.conflicts.slice(0, 2)) {
        parts.push(`"${c.event1}" and "${c.event2}" overlap by ${c.overlapMinutes} minutes around ${c.time}.`);
      }
    }

    // Back-to-back
    if (brief.backToBack.length > 0) {
      parts.push(
        `You have ${brief.backToBack.length} back-to-back transition${brief.backToBack.length > 1 ? 's' : ''} with no break.`
      );
    }

    // Free time -- show remaining free time for today
    const freeHours = isToday
      ? (brief.freeTime.remainingFreeHours ?? brief.freeTime.totalFreeHours)
      : brief.freeTime.totalFreeHours;
    if (freeHours > 0 && brief.summary.timedEvents > 0) {
      const qualifier = isToday ? 'remaining ' : '';
      parts.push(`You have about ${freeHours} hours of ${qualifier}free time during working hours.`);
      if (brief.freeTime.longestFreeBlock) {
        parts.push(`Your longest open block is ${brief.freeTime.longestFreeBlock}.`);
      }
    }

    // Tomorrow preview
    if (brief.tomorrowPreview.eventCount > 0 && brief.tomorrowPreview.firstMeeting) {
      parts.push(
        `Looking ahead to tomorrow: ${brief.tomorrowPreview.eventCount} events. ` +
          `First up is "${brief.tomorrowPreview.firstMeeting.title}" at ${brief.tomorrowPreview.firstMeeting.time}.`
      );
    }

    return parts.join(' ');
  }

  /**
   * Generate a context-aware greeting based on time of day.
   */
  _briefGreeting(date) {
    const h = new Date(date || new Date()).getHours();
    if (h < 12) return "Good morning. Here's your day.";
    if (h < 17) return "Good afternoon. Here's the rest of your day.";
    return "Good evening. Here's a look at your schedule.";
  }

  /**
   * Find back-to-back meeting pairs (gap < minGapMinutes).
   */
  _findBackToBack(sortedEvents) {
    const pairs = [];
    const gap = this._settings.minGapMinutes;
    for (let i = 0; i < sortedEvents.length - 1; i++) {
      const end = new Date(sortedEvents[i].endTime);
      const nextStart = new Date(sortedEvents[i + 1].startTime);
      if ((nextStart - end) / 60000 < gap) {
        pairs.push([sortedEvents[i], sortedEvents[i + 1]]);
      }
    }
    return pairs;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DAY / WEEK SUMMARIES
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Generate a day summary suitable for speech.
   */
  generateDaySummary(date, externalEvents) {
    const d = new Date(date);
    const label = friendlyDate(d);
    const events = this.getEventsForDay(d, externalEvents);

    if (events.length === 0) {
      return `You have nothing scheduled ${label.toLowerCase()}.`;
    }

    const timed = events.filter((e) => !e.allDay);
    const allDay = events.filter((e) => e.allDay);
    const parts = [];

    if (allDay.length > 0) {
      parts.push(
        `${allDay.length} all-day event${allDay.length > 1 ? 's' : ''}: ${allDay.map((e) => e.title).join(', ')}.`
      );
    }

    for (const evt of timed) {
      const recurring = evt.isRecurringInstance || evt.recurring ? ' (recurring)' : '';
      const loc = evt.location ? ` at ${evt.location}` : '';
      parts.push(`${formatTime12(evt.startTime)}: "${evt.title}"${loc}${recurring}`);
    }

    return `${label}: ${events.length} event${events.length > 1 ? 's' : ''}. ${parts.join('. ')}.`;
  }

  /**
   * Generate a week summary suitable for speech.
   */
  generateWeekSummary(externalEvents) {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const monday = addDays(now, dayOfWeek === 0 ? -6 : 1 - dayOfWeek);
    const parts = [];
    let totalEvents = 0;
    let busiestDay = { day: '', count: 0 };
    let freeDays = [];

    for (let i = 0; i < 7; i++) {
      const d = addDays(monday, i);
      const events = this.getEventsForDay(d, externalEvents).filter((e) => !e.allDay);
      totalEvents += events.length;
      const dn = dayName(d);

      if (events.length > busiestDay.count) {
        busiestDay = { day: dn, count: events.length };
      }
      if (events.length === 0) {
        freeDays.push(dn);
      }
    }

    parts.push(`This week you have ${totalEvents} meeting${totalEvents !== 1 ? 's' : ''} total.`);

    if (busiestDay.count > 0) {
      parts.push(
        `Your busiest day is ${busiestDay.day} with ${busiestDay.count} meeting${busiestDay.count > 1 ? 's' : ''}.`
      );
    }

    if (freeDays.length > 0 && freeDays.length <= 3) {
      parts.push(`You're free on ${freeDays.join(' and ')}.`);
    } else if (freeDays.length > 3) {
      parts.push(`You have ${freeDays.length} free days.`);
    }

    return parts.join(' ');
  }

  /**
   * Get the next upcoming event from now.
   */
  getNextEvent(externalEvents) {
    const now = new Date();
    const endOfWeek = addDays(now, 7);
    const events = this.getEventsInRange(now, endOfWeek, externalEvents).filter(
      (e) => !e.allDay && new Date(e.startTime) > now
    );
    return events[0] || null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MORNING BRIEF SCHEDULER
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Start the morning brief scheduler.
   * Checks every minute if it's time for the configured brief.
   *
   * @param {Function} onBrief - Called with (speechText, briefData) when brief is due
   */
  startBriefScheduler(onBrief) {
    if (this._briefTimer) return; // Already running

    this._ensureLoaded();
    const checkInterval = 60000; // Check every minute

    this._briefTimer = setInterval(() => {
      if (!this._settings.morningBriefEnabled) return;

      const now = new Date();
      const todayStr = isoDate(now);
      if (this._lastBriefDate === todayStr) return; // Already delivered today

      const [briefH, briefM] = this._settings.morningBriefTime.split(':').map(Number);
      if (now.getHours() === briefH && now.getMinutes() === briefM) {
        this._lastBriefDate = todayStr;
        try {
          const brief = this.generateMorningBrief();
          const speech = this.renderBriefForSpeech(brief);
          log.info('agent', 'Morning brief triggered');
          if (typeof onBrief === 'function') onBrief(speech, brief);
        } catch (err) {
          log.error('agent', 'Morning brief error', { error: err.message });
        }
      }
    }, checkInterval);

    log.info('agent', `Brief scheduler started (${this._settings.morningBriefTime})`);
  }

  /**
   * Stop the brief scheduler.
   */
  stopBriefScheduler() {
    if (this._briefTimer) {
      clearInterval(this._briefTimer);
      this._briefTimer = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if a time is within working hours.
   */
  isWorkingHour(date) {
    const h = new Date(date).getHours();
    return h >= this._settings.workingHours.start && h < this._settings.workingHours.end;
  }

  /**
   * Get stats about a date range.
   */
  getStats(rangeStart, rangeEnd) {
    const events = this.getEventsInRange(rangeStart, rangeEnd);
    const recurring = events.filter((e) => e.isRecurringInstance || e.recurring);
    const oneOff = events.filter((e) => !e.isRecurringInstance && !e.recurring);
    const local = events.filter((e) => e.source === 'local');
    const external = events.filter((e) => e.source === 'external');

    return {
      total: events.length,
      recurring: recurring.length,
      oneOff: oneOff.length,
      local: local.length,
      external: external.length,
    };
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _instance = null;

function getCalendarStore() {
  if (!_instance) {
    _instance = new CalendarStore();
    _instance.load();
  }
  return _instance;
}

module.exports = {
  CalendarStore,
  getCalendarStore,
};
