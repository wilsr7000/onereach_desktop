/**
 * Calendar Prep Card (Phase 7 -- calendar agent overhaul)
 *
 * Builds a "next meeting" prep card when an event is within
 * `prepCard.windowMinutes` (default 30) of starting. Three slices, each
 * shipping independently per the plan:
 *
 *   Phase 7a -- Deterministic
 *     - Join button via extractMeetingLink()
 *     - Travel-aware leave-early hint (different physical locations only)
 *     No external dependencies, no LLM, no cross-agent calls.
 *
 *   Phase 7b -- Memory-backed
 *     - Attendee notes from People section + contact-store
 *     - Personalized prep summary from classifier `prep.reasons`
 *
 *   Phase 7c -- Cross-agent
 *     - Last meeting note via meeting-notes-agent (1.5s timeout)
 *     - Agenda extraction (cached in classifier Tier 2)
 *
 * Each slice fails closed: missing classifier/memory/meeting-notes leaves
 * the slice off but the card still works with whatever else loaded.
 */

'use strict';

const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();
const { getCalendarMemory, sanitizeForDisplay } = require('./calendar-memory');
const { extractMeetingLink } = require('./calendar-format');

// Test seams (mutable for vi.spyOn pattern).
const _seams = {
  classifier: null, // lazy-loaded via _getClassifier()
  meetingNotes: null, // lazy-loaded via _getMeetingNotes()
  contactStore: null, // lazy-loaded via _getContactStore()
};

function _getClassifier() {
  if (_seams.classifier) return _seams.classifier;
  try {
    return require('./meeting-classifier');
  } catch {
    return null;
  }
}

function _getMeetingNotes() {
  if (_seams.meetingNotes) return _seams.meetingNotes;
  try {
    return require('../packages/agents/meeting-notes-agent');
  } catch {
    return null;
  }
}

function _getContactStore() {
  if (_seams.contactStore) return _seams.contactStore;
  try {
    return require('./contact-store').getContactStore();
  } catch {
    return null;
  }
}

function _readSetting(key, fallback) {
  try {
    const v = global.settingsManager?.get(key);
    if (v !== undefined && v !== null) return v;
  } catch {
    /* fall through */
  }
  return fallback;
}

// ─── Phase 7a: deterministic ─────────────────────────────────────────────

/**
 * Travel-aware leave-early decision. Returns true only when the next event
 * starts within 5 min of this one ending AND they're at different physical
 * locations (NOT both video calls).
 */
function shouldHintLeaveEarly(event, nextEvent) {
  if (!nextEvent) return false;
  const endTs = new Date(event.end?.dateTime || event.end?.date || 0).getTime();
  const nextStartTs = new Date(nextEvent.start?.dateTime || nextEvent.start?.date || 0).getTime();
  const gap = nextStartTs - endTs;
  if (gap > 5 * 60 * 1000) return false;

  const a = extractMeetingLink(event);
  const b = extractMeetingLink(nextEvent);
  if (a.url && b.url) return false; // video -> video, no travel
  if (a.url && !nextEvent.location) return false; // video -> unknown, don't speculate

  const aLoc = (event.location || '').trim().toLowerCase();
  const bLoc = (nextEvent.location || '').trim().toLowerCase();
  return Boolean(aLoc && bLoc && aLoc !== bLoc);
}

function _buildJoinSection(event) {
  const link = extractMeetingLink(event);
  if (!link.url) return null;
  return {
    type: 'action',
    label: link.label || 'Join meeting',
    url: link.url,
    provider: link.provider,
  };
}

// ─── Phase 7b: memory-backed enrichment ──────────────────────────────────

function _buildAttendeeSection(event, memory) {
  const attendees = (event.attendees || []).slice(0, 3);
  if (attendees.length === 0) return null;

  const peopleEntries = memory?.readEntriesTrusted ? memory.readEntriesTrusted('People') : [];
  const peopleMap = new Map();
  for (const e of peopleEntries) {
    // Format: "Sarah Smith (sarah@acme.com): VP, frequent collaborator"
    const m = e.text.match(/^(.+?)\s*(?:\(([^)]+)\))?:\s*(.+)$/);
    if (!m) continue;
    const key = (m[2] || m[1]).toLowerCase().trim();
    peopleMap.set(key, { name: m[1].trim(), note: m[3].trim() });
  }

  const contactStore = _getContactStore();

  return attendees.map((a) => {
    const email = (a.email || '').toLowerCase();
    const name = a.displayName || a.email || 'Unknown';
    let note = peopleMap.get(email)?.note || peopleMap.get(name.toLowerCase())?.note;
    if (!note && contactStore?.findContact) {
      try {
        const c = contactStore.findContact(email) || contactStore.findContact(name);
        if (c?.notes) note = c.notes;
      } catch {
        /* non-fatal */
      }
    }
    return {
      name: sanitizeForDisplay(name, { maxLen: 60 }),
      email: sanitizeForDisplay(email, { maxLen: 80 }),
      note: note ? sanitizeForDisplay(note, { maxLen: 120 }) : null,
    };
  });
}

function _buildPrepSummary(verdict) {
  if (!verdict?.prep) return null;
  const reasons = verdict.prep.reasons || [];
  if (reasons.length === 0) return null;
  return {
    level: verdict.prep.level,
    minutes: verdict.prep.minutes,
    reasons: reasons.map((r) => sanitizeForDisplay(r, { maxLen: 80 })),
  };
}

// ─── Phase 7c: cross-agent enrichment ─────────────────────────────────────

async function _fetchLastMeetingNote(event) {
  const mn = _getMeetingNotes();
  if (!mn || typeof mn.findNoteForTitle !== 'function') return null;
  const timeoutMs = _readSetting('calendar.prepCard.meetingNotesTimeoutMs', 1500);
  try {
    return await Promise.race([
      mn.findNoteForTitle(event.summary),
      new Promise((_, rej) => setTimeout(() => rej(new Error('meeting-notes timeout')), timeoutMs)),
    ]);
  } catch (err) {
    log.info('calendar-prep-card', 'meeting-notes lookup failed (non-fatal)', { error: err.message });
    return null;
  }
}

function _buildAgendaSection(event, verdict) {
  // Agenda extraction is cached in classifier Tier 2 (verdict.research?.bullets).
  // If research isn't available, fall back to the raw description (sanitized).
  if (verdict?.research?.bullets?.length) {
    return verdict.research.bullets.map((b) => sanitizeForDisplay(b, { maxLen: 200 }));
  }
  if (event.description) {
    const cleaned = sanitizeForDisplay(event.description, { maxLen: 400 });
    if (cleaned.length > 20) return [cleaned];
  }
  return null;
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Build a prep card for the given event. Returns null if the event is too
 * far out (outside `prepCard.windowMinutes`) or if the prep-card flag is
 * off. The card is a plain object the HUD `card` UI spec consumes.
 *
 * @param {Object} event - the upcoming event
 * @param {Object} [ctx]
 * @param {Date}   [ctx.now]
 * @param {Object} [ctx.nextEvent] - the event AFTER this one (for back-to-back hint)
 * @param {Object} [ctx.memory] - calendar memory instance
 * @param {Object} [ctx.classifierVerdict] - precomputed verdict; otherwise we call the classifier
 * @param {Object} [ctx.userEmail]
 * @returns {Promise<Object|null>}
 */
async function buildPrepCard(event, ctx = {}) {
  if (!event) return null;
  const enabled = _readSetting('calendar.prepCardEnabled', true);
  if (!enabled) return null;

  const now = ctx.now || new Date();
  const windowMin = _readSetting('calendar.prepCard.windowMinutes', 30);
  const start = new Date(event.start?.dateTime || event.start?.date || 0);
  if (Number.isNaN(start.getTime())) return null;

  const minutesUntil = Math.round((start.getTime() - now.getTime()) / 60000);
  if (minutesUntil < -5 || minutesUntil > windowMin) return null;

  const memory = ctx.memory || getCalendarMemory();

  // Phase 7b/c: classifier verdict provides prep reasons + research.
  let verdict = ctx.classifierVerdict;
  if (!verdict) {
    const classifier = _getClassifier();
    if (classifier?.classifyMeeting) {
      try {
        verdict = await classifier.classifyMeeting(event, { now, memory, userEmail: ctx.userEmail });
      } catch (err) {
        log.info('calendar-prep-card', 'classifier failed (non-fatal)', { error: err.message });
      }
    }
  }

  // Phase 7a: deterministic core
  const join = _buildJoinSection(event);
  const leaveEarly = shouldHintLeaveEarly(event, ctx.nextEvent || null);

  // Phase 7b: memory-backed
  const attendees = _buildAttendeeSection(event, memory);
  const prepSummary = _buildPrepSummary(verdict);

  // Phase 7c: cross-agent
  let lastNote = null;
  if (verdict?.primary && verdict.primary !== 'focus-block' && verdict.primary !== 'personal') {
    lastNote = await _fetchLastMeetingNote(event);
    lastNote = lastNote ? sanitizeForDisplay(lastNote, { maxLen: 240 }) : null;
  }
  const agenda = _buildAgendaSection(event, verdict);

  return {
    type: 'prepCard',
    eventId: event.id,
    title: sanitizeForDisplay(event.summary || 'Untitled', { maxLen: 80 }),
    start: start.toISOString(),
    minutesUntil,
    join,
    leaveEarly,
    prepSummary,
    attendees,
    lastNote,
    agenda,
    research: verdict?.research || null,
  };
}

module.exports = {
  buildPrepCard,
  shouldHintLeaveEarly,
  _seams,
};
