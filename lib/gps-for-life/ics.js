// lib/gps-for-life/ics.js — minimal ICS (RFC 5545) parser + occurrence
// expansion for the GPS for Life calendar merge.
//
// Scope: exactly what Google Calendar "secret address" feeds emit —
// folded lines, VEVENT blocks with DTSTART/DTEND in the three real-world
// forms (UTC "Z", TZID=<zone> wall time, VALUE=DATE all-day), SUMMARY /
// DESCRIPTION / LOCATION / UID / STATUS, RRULE (FREQ + INTERVAL + BYDAY
// weekly + UNTIL/COUNT) and EXDATE. Deliberately dependency-free: this
// runs in the main process, fetching feeds the browser can't (Google's
// ICS endpoints send no CORS headers), and publishes normalized
// occurrences for every surface to read.
//
// Not supported (skipped, never crashed on): VTODO/VJOURNAL, monthly
// nth-weekday BYDAY (falls back to same day-of-month), BYMONTHDAY lists,
// RDATE. Google emits these rarely; occurrences we can't expand are
// dropped with a counter the caller can surface.

'use strict';

/** Unfold RFC 5545 folded lines (CRLF followed by space/tab). */
function unfold(text) {
  return String(text).replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
}

/** Parse "KEY;PARAM=V;PARAM2=V2:value" → { key, params, value }. */
function parseLine(line) {
  const colon = findUnquotedColon(line);
  if (colon === -1) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const segs = left.split(';');
  const key = segs[0].toUpperCase();
  const params = {};
  for (const seg of segs.slice(1)) {
    const eq = seg.indexOf('=');
    if (eq > 0) params[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { key, params, value };
}

function findUnquotedColon(line) {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ':' && !inQuote) return i;
  }
  return -1;
}

/** Unescape ICS text values (\n \, \; \\). */
function unescapeText(v) {
  return String(v).replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}

/**
 * Convert a wall-clock time in an IANA zone to a UTC ms timestamp.
 * Standard two-pass Intl technique: guess UTC, see what wall time that
 * instant shows in the zone, correct by the difference (second pass
 * handles DST boundaries).
 */
function zonedTimeToUtcMs(y, mo, d, h, mi, s, timeZone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const adjust = (ts) => {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = {};
    for (const p of dtf.formatToParts(new Date(ts))) parts[p.type] = p.value;
    const shown = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second)
    );
    return ts + (guess - shown);
  };
  return adjust(adjust(guess));
}

/**
 * Parse an ICS date/date-time value into { ms, allDay }.
 * Forms: 20260817 (all-day), 20260817T120000Z (UTC), 20260817T060000
 * (floating or TZID wall time). All-day values are anchored to LOCAL
 * midnight (calendar-day semantics, matching how the dashboard groups
 * items by local day).
 */
function parseIcsDate(value, params = {}) {
  const v = String(value).trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m || (params.VALUE || '').toUpperCase() === 'DATE') {
    if (!m) m = /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return null;
    return { ms: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime(), allDay: true };
  }
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number);
  if (m[7] === 'Z') return { ms: Date.UTC(y, mo - 1, d, h, mi, s), allDay: false };
  if (params.TZID) {
    try {
      return { ms: zonedTimeToUtcMs(y, mo, d, h, mi, s, params.TZID), allDay: false };
    } catch {
      // Unknown zone id — fall through to floating/local.
    }
  }
  return { ms: new Date(y, mo - 1, d, h, mi, s).getTime(), allDay: false };
}

/** Parse "FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2;UNTIL=..." → object or null. */
function parseRrule(value) {
  const out = {};
  for (const seg of String(value).split(';')) {
    const eq = seg.indexOf('=');
    if (eq > 0) out[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1);
  }
  if (!out.FREQ) return null;
  return {
    freq: out.FREQ.toUpperCase(),
    interval: Math.max(1, parseInt(out.INTERVAL || '1', 10) || 1),
    byday: out.BYDAY ? out.BYDAY.split(',').map(x => x.trim().toUpperCase()) : null,
    untilMs: out.UNTIL ? (parseIcsDate(out.UNTIL, {})?.ms ?? null) : null,
    count: out.COUNT ? parseInt(out.COUNT, 10) : null,
  };
}

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/**
 * Parse a full ICS document into raw events.
 * Returns { events, calendarName }.
 */
function parseIcs(text) {
  const lines = unfold(text);
  const events = [];
  let calendarName = null;
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') {
      if (cur && cur.start && (cur.status || '').toUpperCase() !== 'CANCELLED') events.push(cur);
      cur = null;
      continue;
    }
    const parsed = parseLine(line);
    if (!parsed) continue;
    const { key, params, value } = parsed;
    if (cur === null) {
      if (key === 'X-WR-CALNAME') calendarName = unescapeText(value);
      continue;
    }
    switch (key) {
      case 'UID': cur.uid = value; break;
      case 'SUMMARY': cur.title = unescapeText(value); break;
      case 'DESCRIPTION': cur.description = unescapeText(value); break;
      case 'LOCATION': cur.location = unescapeText(value); break;
      case 'STATUS': cur.status = value; break;
      case 'DTSTART': cur.start = parseIcsDate(value, params); break;
      case 'DTEND': cur.end = parseIcsDate(value, params); break;
      case 'RRULE': cur.rrule = parseRrule(value); break;
      case 'EXDATE': {
        // EXDATE may carry a comma-separated list.
        for (const v of value.split(',')) {
          const d = parseIcsDate(v, params);
          if (d) cur.exdates.push(d.ms);
        }
        break;
      }
      default: break;
    }
  }
  return { events, calendarName };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ITERATIONS = 1000;

/**
 * Expand one raw event into concrete occurrences inside [rangeStartMs,
 * rangeEndMs]. Returns [{ uid, occId, title, description, location,
 * startMs, endMs, allDay, recurring }].
 */
function expandEvent(ev, rangeStartMs, rangeEndMs) {
  if (!ev.start) return [];
  const durMs = ev.end && ev.end.ms > ev.start.ms
    ? ev.end.ms - ev.start.ms
    : (ev.start.allDay ? DAY_MS : 0);
  const exdates = new Set(ev.exdates || []);
  const base = {
    uid: ev.uid || `${ev.title || 'event'}@ics`,
    title: ev.title || '(untitled)',
    description: ev.description || '',
    location: ev.location || '',
    allDay: !!ev.start.allDay,
    recurring: !!ev.rrule,
  };
  const emit = (startMs, out) => {
    if (exdates.has(startMs)) return;
    const endMs = startMs + durMs;
    if (endMs < rangeStartMs || startMs > rangeEndMs) return;
    out.push({ ...base, occId: `${base.uid}:${startMs}`, startMs, endMs });
  };

  const out = [];
  if (!ev.rrule) {
    emit(ev.start.ms, out);
    return out;
  }

  const r = ev.rrule;
  const hardEnd = Math.min(rangeEndMs, r.untilMs ?? Infinity);
  let produced = 0;
  const start = new Date(ev.start.ms);

  if (r.freq === 'WEEKLY' && r.byday && r.byday.length > 0) {
    // Anchor at the start of the DTSTART week; step whole weeks.
    const anchor = new Date(ev.start.ms);
    anchor.setDate(anchor.getDate() - anchor.getDay()); // Sunday of week 0
    for (let week = 0; week < MAX_ITERATIONS; week += r.interval) {
      let weekHadFuture = false;
      for (const code of r.byday) {
        const dow = DAY_CODES.indexOf(code.slice(-2));
        if (dow === -1) continue;
        const occ = new Date(anchor);
        occ.setDate(occ.getDate() + week * 7 + dow);
        occ.setHours(start.getHours(), start.getMinutes(), start.getSeconds(), 0);
        const ms = occ.getTime();
        if (ms < ev.start.ms) continue;
        if (r.count !== null && ++produced > r.count) return out;
        if (ms > hardEnd) continue;
        weekHadFuture = true;
        emit(ms, out);
      }
      const weekStartMs = anchor.getTime() + week * 7 * DAY_MS;
      if (weekStartMs > hardEnd && !weekHadFuture) break;
    }
    return out;
  }

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const n = i * r.interval;
    const occ = new Date(start);
    if (r.freq === 'DAILY') occ.setDate(occ.getDate() + n);
    else if (r.freq === 'WEEKLY') occ.setDate(occ.getDate() + n * 7);
    else if (r.freq === 'MONTHLY') occ.setMonth(occ.getMonth() + n);
    else if (r.freq === 'YEARLY') occ.setFullYear(occ.getFullYear() + n);
    else return out; // unsupported FREQ — drop silently, counted by caller
    const ms = occ.getTime();
    if (r.count !== null && i >= r.count) break;
    if (ms > hardEnd) break;
    emit(ms, out);
  }
  return out;
}

/**
 * Parse + expand a whole feed. Returns { calendarName, occurrences,
 * eventCount } with occurrences sorted by start.
 */
function expandIcsFeed(text, rangeStartMs, rangeEndMs) {
  const { events, calendarName } = parseIcs(text);
  const occurrences = [];
  for (const ev of events) occurrences.push(...expandEvent(ev, rangeStartMs, rangeEndMs));
  occurrences.sort((a, b) => a.startMs - b.startMs);
  return { calendarName, occurrences, eventCount: events.length };
}

module.exports = { parseIcs, expandEvent, expandIcsFeed, _internals: { parseIcsDate, parseRrule, zonedTimeToUtcMs, unfold } };
