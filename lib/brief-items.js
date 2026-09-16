/**
 * Brief items -- ONE compression of a schedule into items that read the same
 * on screen and out loud.
 *
 * Why this module exists (2026-09-15): the daily brief kept confusing
 * back-to-back meetings with conflicts. generateMorningBrief() counted every
 * consecutive pair with a gap under 15 minutes as "back-to-back" -- including
 * NEGATIVE gaps, i.e. overlaps -- so an overlapping pair was tallied twice
 * ("3 back-to-back. 3 conflicts.") with no names attached, and the composer
 * had nothing to say but the numbers. Two stale test events in the local
 * store ("standup" / "daily standup", 9:00 every weekday) supplied the
 * overlaps against the real 9 AM meeting.
 *
 * This module owns the vocabulary:
 *   conflict      = two real meetings OVERLAP (share at least one minute)
 *   back-to-back  = one real meeting ends and the next starts within
 *                   minGapMinutes, with NO overlap ("no break between")
 * Blocks (Don't book / Focus / Hold) and invites the user declined are never
 * conflicts and never back-to-back -- a hold is not a double-booking.
 *
 * Every timeline entry compresses to ONE item, { line, spoken, ... }:
 *   line   -- the visual row text ("9:00-10:00 AM · Think Tank · Zoom · 95 people · no break before Library sync-up")
 *   spoken -- the TTS-friendly sentence ("9 to 10 AM, Think Tank on Zoom with 95 people, then straight into Library sync-up.")
 * The calendar contribution (what the LLM composer reads), the dayView rows
 * and the composed briefing all read from these items, so voice and screen
 * cannot disagree.
 *
 * Dependency-free on purpose: calendar-store, calendar-format and the agents
 * all require this module; it requires nothing of theirs.
 */

'use strict';

/**
 * Titles that mark a personal block / hold rather than a meeting. Shared by
 * the spoken count, the dayView glance card and the flag derivation.
 * (Moved here from calendar-format.js, which re-exports it.)
 */
const BLOCK_TITLE_RE = /don[’']?t book|do not book|\bhold\b|\bblocked?\b|focus time|\bfocus\b|\bbusy\b/i;

const DEFAULT_MIN_GAP_MINUTES = 15;

function isBlockTitle(title) {
  return BLOCK_TITLE_RE.test(title || '');
}

/** True for entries the brief should never count as a real meeting. */
function isNonMeeting(entry) {
  if (!entry) return true;
  if (entry.allDay) return true;
  if (isBlockTitle(entry.title)) return true;
  if (entry.selfDeclined) return true;
  return false;
}

/**
 * Classify a brief timeline into the counting vocabulary shared by the
 * spoken brief and the dayView UI.
 *
 * @param {Array} timeline - generateMorningBrief() timeline entries
 * @returns {{ meetings: Array, blocks: Array, declined: Array, upcoming: Array, completed: Array }}
 */
function classifyBriefTimeline(timeline) {
  const entries = Array.isArray(timeline) ? timeline : [];
  const blocks = entries.filter((e) => isBlockTitle(e.title));
  const declined = entries.filter((e) => !isBlockTitle(e.title) && e.selfDeclined);
  const meetings = entries.filter((e) => !isBlockTitle(e.title) && !e.selfDeclined);
  const upcoming = meetings.filter((e) => e.status === 'upcoming' || e.status === 'in-progress');
  const completed = meetings.filter((e) => e.status === 'completed');
  return { meetings, blocks, declined, upcoming, completed };
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/** "9:00 AM" / "10:50 PM" -> minutes since midnight, or null. */
function parseClock(str) {
  if (typeof str !== 'string') return null;
  const m = str.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const mer = m[3] ? m[3].toUpperCase() : null;
  if (mer === 'PM' && h !== 12) h += 12;
  if (mer === 'AM' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Resolve an entry's start/end to epoch ms. Accepts the store's event shape
 * (startTime/endTime ISO), the brief timeline shape (startISO/endISO, or the
 * formatted start/end strings anchored on `baseDate`), and Date objects.
 */
function spanMs(entry, baseDate) {
  const pick = (a, b) => (a !== undefined && a !== null && a !== '' ? a : b);
  const rawStart = pick(entry.startISO, pick(entry.startTime, entry.startMs));
  const rawEnd = pick(entry.endISO, pick(entry.endTime, entry.endMs));
  let s = rawStart !== undefined ? new Date(rawStart).getTime() : NaN;
  let e = rawEnd !== undefined ? new Date(rawEnd).getTime() : NaN;
  if (Number.isNaN(s) || Number.isNaN(e)) {
    const base = baseDate ? new Date(baseDate) : new Date();
    const sm = parseClock(entry.start);
    const em = parseClock(entry.end);
    if (sm === null || em === null) return null;
    const day = new Date(base);
    day.setHours(0, 0, 0, 0);
    s = day.getTime() + sm * 60000;
    e = day.getTime() + em * 60000;
    if (e < s) e += 24 * 60 * 60000; // crosses midnight
  }
  if (!(e > s)) return null;
  return { s, e };
}

function formatClock(ms) {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** "9:00 AM".."10:00 AM" -> "9:00-10:00 AM"; "11:30 AM".."1:00 PM" -> "11:30 AM-1:00 PM". */
function compactSpan(start, end) {
  if (!start) return '';
  if (!end) return start;
  const ms = String(start).match(/(AM|PM)$/i);
  const me = String(end).match(/(AM|PM)$/i);
  if (ms && me && ms[1].toUpperCase() === me[1].toUpperCase()) {
    return `${String(start).replace(/\s*(AM|PM)$/i, '')}–${end}`;
  }
  return `${start}–${end}`;
}

/** "9:00 AM".."10:00 AM" -> "9 to 10 AM" (TTS reads it cleanly). */
function spokenSpan(start, end) {
  const trim = (t) => String(t || '').replace(/:00(?=\s*(AM|PM)$)/i, '');
  if (!start) return '';
  if (!end) return trim(start);
  const a = trim(start);
  const b = trim(end);
  const ma = a.match(/(AM|PM)$/i);
  const mb = b.match(/(AM|PM)$/i);
  if (ma && mb && ma[1].toUpperCase() === mb[1].toUpperCase()) {
    return `${a.replace(/\s*(AM|PM)$/i, '')} to ${b}`;
  }
  return `${a} to ${b}`;
}

// ---------------------------------------------------------------------------
// Flags: conflicts vs back-to-back (one definition, used everywhere)
// ---------------------------------------------------------------------------

/**
 * Derive schedule flags from a list of events.
 *
 * @param {Array} events - store events ({ title, startTime, endTime, allDay,
 *   selfDeclined }) or timeline entries ({ title, start, end, startISO, endISO,
 *   status, selfDeclined }). Blocks, declined invites and all-day rows are
 *   ignored entirely.
 * @param {Object} [opts]
 * @param {number} [opts.minGapMinutes=15] - "back-to-back" threshold (gap in [0, minGap))
 * @param {Date|number} [opts.now] - when set, pairs where BOTH sides have already
 *   ended are dropped (the brief only warns about what is still ahead)
 * @param {Date} [opts.baseDate] - anchor for entries that only carry clock strings
 * @returns {{ conflicts: Array<{first, second, overlapMinutes, atMs}>,
 *             backToBack: Array<{first, second, gapMinutes, atMs}> }}
 *   `first`/`second` are the input objects (sorted by start; first starts earlier).
 */
function deriveScheduleFlags(events, opts = {}) {
  const minGap = Number.isFinite(opts.minGapMinutes) ? opts.minGapMinutes : DEFAULT_MIN_GAP_MINUTES;
  const nowMs = opts.now !== undefined && opts.now !== null ? new Date(opts.now).getTime() : null;

  const real = [];
  for (const ev of Array.isArray(events) ? events : []) {
    if (isNonMeeting(ev)) continue;
    const span = spanMs(ev, opts.baseDate);
    if (!span) continue;
    real.push({ ev, s: span.s, e: span.e });
  }
  real.sort((a, b) => a.s - b.s || a.e - b.e);

  const stillRelevant = (a, b) => nowMs === null || a.e > nowMs || b.e > nowMs;

  const conflicts = [];
  for (let i = 0; i < real.length; i++) {
    for (let j = i + 1; j < real.length; j++) {
      const a = real[i];
      const b = real[j];
      if (b.s >= a.e) break; // sorted by start: nothing later can overlap a
      const overlap = Math.min(a.e, b.e) - Math.max(a.s, b.s);
      if (overlap <= 0) continue;
      if (!stillRelevant(a, b)) continue;
      conflicts.push({
        first: a.ev,
        second: b.ev,
        overlapMinutes: Math.round(overlap / 60000),
        atMs: Math.max(a.s, b.s),
      });
    }
  }

  const backToBack = [];
  for (let i = 0; i < real.length; i++) {
    const a = real[i];
    // Earliest real meeting that starts at or after `a` ends, within the gap.
    let best = null;
    for (let j = 0; j < real.length; j++) {
      if (j === i) continue;
      const b = real[j];
      const gap = b.s - a.e;
      if (gap < 0 || gap >= minGap * 60000) continue;
      if (!best || b.s < best.s) best = b;
    }
    if (!best) continue;
    if (!stillRelevant(a, best)) continue;
    backToBack.push({
      first: a.ev,
      second: best.ev,
      gapMinutes: Math.round((best.s - a.e) / 60000),
      atMs: a.e,
    });
  }

  return { conflicts, backToBack };
}

// ---------------------------------------------------------------------------
// Item compression
// ---------------------------------------------------------------------------

const VIDEO_HOSTS = [
  [/zoom\.us|zoom\.com/i, 'Zoom'],
  [/meet\.google\.com/i, 'Google Meet'],
  [/teams\.microsoft\.com|teams\.live\.com/i, 'Teams'],
  [/webex\.com/i, 'Webex'],
  [/whereby\.com/i, 'Whereby'],
];

/** A location string -> short place ("Zoom", "Google Meet", "Room 4B", ...). */
function describeLocation(location) {
  const loc = typeof location === 'string' ? location.trim() : '';
  if (!loc) return null;
  for (const [re, name] of VIDEO_HOSTS) {
    if (re.test(loc)) return name;
  }
  if (/^https?:\/\//i.test(loc)) return 'video call';
  return loc.length > 40 ? `${loc.slice(0, 37).trim()}…` : loc;
}

/** "oleksandra.hohulia@onereach.com" -> "Oleksandra Hohulia"; "Antony Peklo" -> as-is. */
function displayNameFromGuest(guest) {
  if (!guest) return null;
  const raw = typeof guest === 'string' ? guest : guest.displayName || guest.name || guest.email || '';
  if (!raw) return null;
  if (!raw.includes('@')) return raw.trim();
  const local = raw.split('@')[0].split('+')[0];
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

function firstName(name) {
  return name ? name.split(/\s+/)[0] : name;
}

/**
 * Describe the other attendees. Returns { count, line, spoken } where line is
 * screen text ("95 people", "with Antony Peklo") and spoken is the sentence
 * fragment ("with 95 people", "with Antony").
 */
function describePeople(guests, selfEmail) {
  const list = Array.isArray(guests) ? guests : [];
  const self = (selfEmail || '').toLowerCase();
  const others = list.filter((g) => {
    const email = (typeof g === 'string' ? g : g && g.email) || '';
    return !self || email.toLowerCase() !== self;
  });
  const count = others.length;
  if (count === 0) return { count: 0, line: '', spoken: '' };
  if (count <= 2) {
    const names = others.map(displayNameFromGuest).filter(Boolean);
    const firsts = names.map(firstName);
    return {
      count,
      line: `with ${names.join(' and ')}`,
      spoken: `with ${firsts.join(' and ')}`,
    };
  }
  return { count, line: `${count} people`, spoken: `with ${count} people` };
}

/**
 * Index flags by title so a row can look up its own markers.
 * Titles are the join key because the brief timeline carries no ids.
 */
function indexFlagsByTitle(flags) {
  const conflicts = new Map();
  const b2bFirst = new Map();
  const b2bSecond = new Map();
  const titleOf = (x) => (typeof x === 'string' ? x : x && x.title) || '';
  for (const c of (flags && flags.conflicts) || []) {
    const a = titleOf(c.first !== undefined ? c.first : c.event1);
    const b = titleOf(c.second !== undefined ? c.second : c.event2);
    if (!a || !b) continue;
    for (const [self, other] of [[a, b], [b, a]]) {
      const entry = conflicts.get(self) || { others: [], overlapMinutes: 0 };
      if (!entry.others.includes(other)) entry.others.push(other);
      entry.overlapMinutes = Math.max(entry.overlapMinutes, c.overlapMinutes || 0);
      conflicts.set(self, entry);
    }
  }
  for (const p of (flags && flags.backToBack) || []) {
    const a = titleOf(p.first);
    const b = titleOf(p.second);
    if (!a || !b) continue;
    if (!b2bFirst.has(a)) b2bFirst.set(a, b);
    if (!b2bSecond.has(b)) b2bSecond.set(b, a);
  }
  return { conflicts, b2bFirst, b2bSecond };
}

/**
 * Compress one timeline entry into a useful item for screen + voice.
 *
 * @param {Object} ev - generateMorningBrief() timeline entry
 * @param {Object} [ctx]
 * @param {Object} [ctx.flags] - { conflicts, backToBack } from the brief (names or objects)
 * @param {string} [ctx.selfEmail] - the user's email (excluded from attendee counts)
 * @returns {{ time, end, span, title, kind, status, where, who, flag, flagDetail, line, spoken }}
 */
function compressTimelineItem(ev, ctx = {}) {
  const idx = ctx._index || indexFlagsByTitle(ctx.flags);
  const title = (ev && ev.title) || 'Untitled';
  const status = (ev && ev.status) || 'upcoming';
  const isBlock = isBlockTitle(title);
  const isDeclined = !isBlock && !!(ev && ev.selfDeclined);
  const kind = isBlock ? 'block' : isDeclined ? 'declined' : 'meeting';
  const where = describeLocation(ev && ev.location);
  const people = kind === 'meeting' ? describePeople(ev && ev.guests, ctx.selfEmail) : { count: 0, line: '', spoken: '' };
  const span = compactSpan(ev && ev.start, ev && ev.end);
  const spokenWhen = spokenSpan(ev && ev.start, ev && ev.end);

  let flag = null;
  let flagDetail = '';
  let spokenFlag = '';
  if (kind === 'meeting') {
    const conflict = idx.conflicts.get(title);
    const nextTight = idx.b2bFirst.get(title);
    const prevTight = idx.b2bSecond.get(title);
    if (conflict) {
      flag = 'conflict';
      flagDetail = `overlaps ${conflict.others.join(', ')}${conflict.overlapMinutes ? ` by ${conflict.overlapMinutes} min` : ''}`;
      spokenFlag = `which overlaps ${conflict.others.join(' and ')}`;
    } else if (nextTight) {
      flag = 'back-to-back';
      flagDetail = `no break before ${nextTight}`;
      spokenFlag = `then straight into ${nextTight}`;
    } else if (prevTight) {
      flag = 'back-to-back';
      flagDetail = `right after ${prevTight}`;
      spokenFlag = '';
    }
  }

  const lineParts = [span, title];
  if (kind === 'block') lineParts.push('block');
  if (kind === 'declined') lineParts.push('declined');
  if (kind === 'meeting' && status === 'in-progress') lineParts.push('happening now');
  if (where) lineParts.push(where);
  if (people.line) lineParts.push(people.line);
  if (flagDetail) lineParts.push(flagDetail);
  const line = lineParts.filter(Boolean).join(' · ');

  let spoken;
  if (kind === 'block') {
    spoken = `${spokenWhen} is held for ${title}, not a meeting.`;
  } else if (kind === 'declined') {
    spoken = `${title} at ${ev.start} is on the calendar but you declined it.`;
  } else if (status === 'completed') {
    spoken = `${title} is done.`;
  } else if (status === 'in-progress') {
    spoken = `Right now you're in ${title}${where ? ` on ${where}` : ''}, until ${ev.end}.`;
  } else {
    const bits = [`${spokenWhen}, ${title}`];
    if (where) bits.push(`on ${where}`);
    if (people.spoken) bits.push(people.spoken);
    if (spokenFlag) bits.push(spokenFlag);
    spoken = `${bits.join(' ')}.`;
  }

  return {
    time: (ev && ev.start) || '',
    end: (ev && ev.end) || '',
    span,
    title,
    kind,
    status,
    where,
    who: people.line || null,
    peopleCount: people.count,
    flag,
    flagDetail,
    line,
    spoken,
  };
}

/**
 * Compress a whole timeline (keeps order). Precomputes the flag index once.
 */
function compressTimeline(timeline, ctx = {}) {
  const _index = indexFlagsByTitle(ctx.flags);
  return (Array.isArray(timeline) ? timeline : []).map((ev) => compressTimelineItem(ev, { ...ctx, _index }));
}

// ---------------------------------------------------------------------------
// The calendar contribution text (what the LLM composer reads)
// ---------------------------------------------------------------------------

function titleOf(x) {
  return (typeof x === 'string' ? x : x && x.title) || '';
}

/**
 * Build the Calendar section text for the daily-brief composer. Every claim
 * is spelled out with names and definitions so the composer cannot merge
 * "back-to-back" and "conflict" into one number.
 *
 * @param {Object} args
 * @param {Object} args.brief - generateMorningBrief() output
 * @param {string} args.label - 'today' | 'tomorrow' | weekday label
 * @param {Array} [args.items] - compressTimeline() output (built here when absent)
 * @param {string} [args.diffLine] - "what changed since last brief" line
 * @param {string} [args.staleReason] - set when live calendar data was unavailable
 * @returns {{ headline: string, content: string, items: Array }}
 */
function buildCalendarBriefText({ brief, label = 'today', items, diffLine, staleReason, selfEmail } = {}) {
  const timeline = (brief && brief.timeline) || [];
  const { meetings, upcoming, completed, blocks, declined } = classifyBriefTimeline(timeline);
  const list = items || compressTimeline(timeline, { flags: brief, selfEmail });

  const lines = [];
  let headline;
  if (label === 'today') {
    if (upcoming.length === 0) {
      headline = `Today's meetings are done — you had ${completed.length}.`;
    } else {
      headline = `${upcoming.length} meeting${upcoming.length !== 1 ? 's' : ''} left today${
        completed.length ? ` (${completed.length} already done)` : ''
      }.`;
    }
  } else {
    headline = `${meetings.length} meeting${meetings.length !== 1 ? 's' : ''} ${label}.`;
  }
  const extras = [];
  if (blocks.length) extras.push(`${blocks.length} block${blocks.length !== 1 ? 's' : ''} (not meetings)`);
  if (declined.length) extras.push(`${declined.length} declined`);
  if (extras.length) headline += ` Plus ${extras.join(', ')}.`;
  lines.push(headline);

  // "Now" is the meeting in progress; "Next" is the first that has not
  // started. The old code called an in-progress meeting "Next".
  const nowMeeting = upcoming.find((e) => e.status === 'in-progress') || null;
  const nextMeeting =
    upcoming.find((e) => e.status !== 'in-progress') || (label !== 'today' ? meetings[0] : null);
  if (nowMeeting) lines.push(`Now: "${nowMeeting.title}" until ${nowMeeting.end}.`);
  if (nextMeeting) lines.push(`Next: "${nextMeeting.title}" at ${nextMeeting.start}.`);

  if (list.length) {
    lines.push('Schedule items (one per event, in order):');
    for (const it of list) lines.push(`- ${it.line}${it.status === 'completed' ? ' (done)' : ''}`);
  }

  const conflicts = (brief && brief.conflicts) || [];
  if (conflicts.length) {
    const named = conflicts
      .map((c) => {
        const a = titleOf(c.first !== undefined ? c.first : c.event1);
        const b = titleOf(c.second !== undefined ? c.second : c.event2);
        if (!a || !b) return null;
        const when = c.time ? ` around ${c.time}` : '';
        const by = c.overlapMinutes ? ` by ${c.overlapMinutes} min` : '';
        return `"${a}" overlaps "${b}"${by}${when}`;
      })
      .filter(Boolean);
    lines.push(
      `Schedule conflicts (overlapping meetings, you cannot attend both in full): ${conflicts.length}${
        named.length ? ` — ${named.join('; ')}` : ''
      }.`
    );
  } else {
    lines.push('Schedule conflicts (overlapping meetings): none.');
  }

  const b2b = (brief && brief.backToBack) || [];
  if (b2b.length) {
    const named = b2b
      .map((p) => {
        const a = titleOf(p.first);
        const b = titleOf(p.second);
        if (!a || !b) return null;
        return `"${a}" → "${b}"${p.transitionTime ? ` at ${p.transitionTime}` : ''}`;
      })
      .filter(Boolean);
    lines.push(
      `Meetings back-to-back (no break between, NOT a conflict): ${b2b.length}${
        named.length ? ` — ${named.join('; ')}` : ''
      }.`
    );
  } else {
    lines.push('Meetings back-to-back (no break between): none.');
  }

  const longest = brief && (brief.longestFree || (brief.freeTime && brief.freeTime.longestFreeBlock));
  if (longest && typeof longest === 'object' && longest.durationMinutes >= 60) {
    lines.push(`Longest free block: ${Math.round(longest.durationMinutes / 60)}h.`);
  } else if (typeof longest === 'string') {
    lines.push(`Longest free block: ${longest}.`);
  }

  if (diffLine) lines.push(diffLine);
  if (staleReason) lines.push('(based on local cache; calendar service is offline)');

  return { headline, content: lines.join('\n'), items: list };
}

module.exports = {
  BLOCK_TITLE_RE,
  DEFAULT_MIN_GAP_MINUTES,
  isBlockTitle,
  isNonMeeting,
  classifyBriefTimeline,
  parseClock,
  spanMs,
  formatClock,
  compactSpan,
  spokenSpan,
  deriveScheduleFlags,
  describeLocation,
  displayNameFromGuest,
  describePeople,
  indexFlagsByTitle,
  compressTimelineItem,
  compressTimeline,
  buildCalendarBriefText,
};
