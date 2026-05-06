/**
 * Calendar Absence Detector (Phase 6 -- calendar agent overhaul)
 *
 * Memory-driven nudge engine that detects gaps between what memory expects
 * and what the upcoming calendar window actually contains. The hard contract
 * from the plan, in priority order:
 *
 *   1. Empty memory -> no suggestion, no section in the brief.
 *   2. One suggestion per brief -- aggregator picks the highest-confidence
 *      non-null source result; the rest go to userQueue for later perusal.
 *   3. Confidence threshold (default 0.7) for brief surfacing; medium
 *      confidence (0.4-0.7) goes to the review queue; below 0.4 dropped.
 *   4. First-run grace: silent for `absenceDetector.firstRunGraceDays`
 *      (default 7) so passive cadence mining can warm up.
 *
 * Five seed sources (per the locked design):
 *
 *   - Explicit user statements -> Cadences, Routines, Reconnects, Goals
 *   - Cadence mining over 90d Omnical -> Cadences (low confidence until 3+)
 *   - Meeting-notes action items -> Commitments, Follow-ups
 *   - Goals / projects -> Goals (derived from deadline proximity)
 *   - Email parsing -> Commitments, Reconnects (never auto-applied)
 *
 * Plus three derived checks that don't need memory but live here for symmetry:
 *
 *   - checkPrepGaps -- heavy-prep meeting without a prep block scheduled
 *   - checkRecoveryGaps -- 4+ hour back-to-back stretches
 *   - checkTravelGaps -- in-person at non-default location
 *
 * Phase 6 ships with the SCAFFOLDING for all sources -- each source's check
 * function reads memory and returns either null (silent) or a suggestion
 * object. Until users populate Cadences/Commitments/etc. (Phase 8 learning
 * loop or explicit user statements), every check returns null and the brief
 * shows nothing. That's the contract.
 */

'use strict';

const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();
const { getCalendarMemory, sanitizeForDisplay } = require('./calendar-memory');

// ─── Constants + settings ─────────────────────────────────────────────────

const CONFIDENCE_BRIEF_THRESHOLD = 0.7;
const CONFIDENCE_REVIEW_THRESHOLD = 0.4;
const DEFAULT_FIRST_RUN_GRACE_DAYS = 7;

function _readSetting(key, fallback) {
  try {
    const v = global.settingsManager?.get(key);
    if (v !== undefined && v !== null) return v;
  } catch {
    /* fall through */
  }
  return fallback;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function _daysBetween(a, b) {
  const aTs = a instanceof Date ? a.getTime() : new Date(a).getTime();
  const bTs = b instanceof Date ? b.getTime() : new Date(b).getTime();
  return Math.round((bTs - aTs) / (24 * 60 * 60 * 1000));
}

function _parseCadenceLine(text) {
  // "Marcus 1:1: every 14d, last on 2026-04-15"
  const m = String(text || '').match(/^(.+?):\s*every\s+(\d+)\s*d(?:ays?)?(?:,\s*last\s+on\s+(\d{4}-\d{2}-\d{2}))?/i);
  if (!m) return null;
  return {
    label: m[1].trim(),
    cadenceDays: parseInt(m[2], 10),
    lastOn: m[3] || null,
  };
}

function _parseCommitmentLine(text) {
  // "Send Q2 deck to Sarah by 2026-04-30"
  const m = String(text || '').match(/^(.+?)\s+by\s+(\d{4}-\d{2}-\d{2})/i);
  if (!m) return null;
  return {
    label: m[1].trim(),
    deadline: m[2],
  };
}

function _parseGoalLine(text) {
  // "Ship feature X by 2026-06-01"
  return _parseCommitmentLine(text);
}

function _parseReconnectLine(text) {
  // "John Smith: catch up every 42d, last on 2026-03-01"
  return _parseCadenceLine(text);
}

// ─── Source check functions ──────────────────────────────────────────────

/**
 * Source 1: Explicit cadences. The user said "1:1 with Marcus every 14
 * days" -- if the next cycle is due in the window and no event matches,
 * suggest scheduling.
 */
function checkExplicitCadences(memory, window) {
  if (!memory?.readEntriesTrusted) return null;
  const entries = memory.readEntriesTrusted('Cadences');
  if (entries.length === 0) return null;

  const now = window.now || new Date();
  const horizonDays = window.horizonDays || 14;
  const horizon = new Date(now.getTime() + horizonDays * 24 * 60 * 60 * 1000);

  const dues = [];
  for (const entry of entries) {
    const cad = _parseCadenceLine(entry.text);
    if (!cad || !cad.lastOn) continue;
    const nextDue = new Date(cad.lastOn);
    nextDue.setDate(nextDue.getDate() + cad.cadenceDays);
    // Accept past-due AND in-window cadences. Past-due is the whole point
    // of the nudge -- "your usual X is overdue".
    if (nextDue <= horizon) {
      dues.push({ label: cad.label, nextDue: nextDue.toISOString().slice(0, 10), source: 'cadences' });
    }
  }
  if (dues.length === 0) return null;

  // Cross-check against scheduled events: drop any dues that already have a
  // matching event in the upcoming window.
  const scheduledTitles = (window.events || [])
    .map((e) => (e.summary || '').toLowerCase())
    .join(' | ');
  const missing = dues.filter((d) => !scheduledTitles.includes(d.label.toLowerCase().split(' ')[0]));
  if (missing.length === 0) return null;

  const top = missing[0];
  return {
    suggestion: `Your usual "${top.label}" is due around ${top.nextDue} -- want me to schedule it?`,
    confidence: 0.85,
    reason: 'cadence due, no matching event scheduled',
    source: 'explicit-cadences',
    action: { type: 'proposeCreate', title: top.label, suggestedDate: top.nextDue },
  };
}

/**
 * Source 2: Cadence mining over Omnical history. Stub for v1 -- returns
 * null until Phase 8 wires the weekly cron that mines past 90 days for
 * implicit cadences and writes them to the Cadences section.
 */
function checkMinedCadences(_memory, _window) {
  return null;
}

/**
 * Source 3: Explicit commitments. "Send Q2 deck to Sarah by 2026-04-30"
 * -> if the deadline is in the window and no focus block / event addresses
 * it, suggest scheduling one.
 */
function checkCommitments(memory, window) {
  if (!memory?.readEntriesTrusted) return null;
  const entries = memory.readEntriesTrusted('Commitments');
  if (entries.length === 0) return null;

  const now = window.now || new Date();
  const horizonDays = window.horizonDays || 14;
  const horizon = new Date(now.getTime() + horizonDays * 24 * 60 * 60 * 1000);

  for (const entry of entries) {
    const c = _parseCommitmentLine(entry.text);
    if (!c) continue;
    const deadline = new Date(c.deadline);
    if (deadline < now || deadline > horizon) continue;

    // Look for any event that mentions the commitment label.
    const scheduledTitles = (window.events || [])
      .map((e) => (e.summary || '').toLowerCase())
      .join(' | ');
    const labelToken = c.label.toLowerCase().split(/\s+/)[0];
    if (scheduledTitles.includes(labelToken)) continue;

    const daysLeft = _daysBetween(now, deadline);
    return {
      suggestion: `"${sanitizeForDisplay(c.label, { maxLen: 80 })}" is due ${daysLeft <= 1 ? 'tomorrow' : `in ${daysLeft} days`}; you haven't blocked time for it.`,
      confidence: 0.9,
      reason: 'commitment deadline approaching, no scheduled work block',
      source: 'commitments',
      action: { type: 'proposeFocusBlock', label: c.label, deadline: c.deadline },
    };
  }
  return null;
}

/**
 * Source 4: Routines. "Gym Mon/Wed/Fri 6am" -- v1 just checks whether the
 * Routines section is non-empty and one of its days is missing this week.
 * Detailed parsing left for Phase 8 cron.
 */
function checkRoutines(memory, _window) {
  if (!memory?.readEntriesTrusted) return null;
  const entries = memory.readEntriesTrusted('Routines');
  if (entries.length === 0) return null;
  // Stub: signal that routines exist but we don't have richer detection yet.
  // Returning null keeps the brief silent (correct per the contract); when
  // Phase 8's cron mines this section, this check fills in.
  return null;
}

/**
 * Source 5: Goals + reconnects. Same pattern as commitments -- read the
 * sections, surface anything due that isn't scheduled.
 */
function checkGoals(memory, window) {
  if (!memory?.readEntriesTrusted) return null;
  const entries = memory.readEntriesTrusted('Goals');
  if (entries.length === 0) return null;

  const now = window.now || new Date();
  const horizonDays = window.horizonDays || 14;
  const horizon = new Date(now.getTime() + horizonDays * 24 * 60 * 60 * 1000);

  for (const entry of entries) {
    const g = _parseGoalLine(entry.text);
    if (!g) continue;
    const deadline = new Date(g.deadline);
    if (deadline < now || deadline > horizon) continue;

    const scheduledTitles = (window.events || [])
      .map((e) => (e.summary || '').toLowerCase())
      .join(' | ');
    const labelToken = g.label.toLowerCase().split(/\s+/)[0];
    if (scheduledTitles.includes(labelToken)) continue;

    const daysLeft = _daysBetween(now, deadline);
    return {
      suggestion: `Goal "${sanitizeForDisplay(g.label, { maxLen: 80 })}" is ${daysLeft} days out and has no project time scheduled.`,
      confidence: 0.75,
      reason: 'goal deadline approaching, no project time blocked',
      source: 'goals',
      action: { type: 'proposeFocusBlock', label: g.label, deadline: g.deadline },
    };
  }
  return null;
}

function checkReconnects(memory, window) {
  if (!memory?.readEntriesTrusted) return null;
  const entries = memory.readEntriesTrusted('Reconnects');
  if (entries.length === 0) return null;

  const now = window.now || new Date();
  for (const entry of entries) {
    const r = _parseReconnectLine(entry.text);
    if (!r || !r.lastOn) continue;
    const nextDue = new Date(r.lastOn);
    nextDue.setDate(nextDue.getDate() + r.cadenceDays);
    if (nextDue > now) continue; // not due yet

    const scheduledTitles = (window.events || [])
      .map((e) => (e.summary || '').toLowerCase())
      .join(' | ');
    const labelToken = r.label.toLowerCase().split(/\s+/)[0];
    if (scheduledTitles.includes(labelToken)) continue;

    return {
      suggestion: `It's been a while since you connected with ${sanitizeForDisplay(r.label, { maxLen: 60 })} -- want me to suggest some times?`,
      confidence: 0.7,
      reason: 'reconnect cadence due',
      source: 'reconnects',
      action: { type: 'proposeReconnect', label: r.label },
    };
  }
  return null;
}

// ─── Derived checks (no memory needed) ────────────────────────────────────

/**
 * Heavy-prep events that don't have a prep block scheduled before them.
 * Requires classifier verdicts to know which events ARE heavy-prep.
 */
function checkPrepGaps(_memory, window) {
  const verdicts = window.classifierVerdicts || {};
  const events = window.events || [];
  if (events.length === 0) return null;

  const now = window.now || new Date();
  for (const event of events) {
    const eventStart = new Date(event.start?.dateTime || event.start?.date || 0);
    if (eventStart < now) continue;

    const verdict = verdicts[event.id];
    if (!verdict || verdict.prep?.level !== 'heavy') continue;

    // Prep gap = no other event in the 60 minutes before this one with a
    // title that mentions prep/review/draft for the same meeting.
    const prepWindowStart = new Date(eventStart.getTime() - 60 * 60 * 1000);
    const titleHint = (event.summary || '').toLowerCase().split(/\s+/)[0];
    const hasPrep = events.some((other) => {
      if (other.id === event.id) return false;
      const oStart = new Date(other.start?.dateTime || other.start?.date || 0);
      if (oStart < prepWindowStart || oStart > eventStart) return false;
      const otitle = (other.summary || '').toLowerCase();
      return /prep|review|draft|notes/i.test(otitle) && titleHint && otitle.includes(titleHint);
    });
    if (hasPrep) continue;

    return {
      suggestion: `"${sanitizeForDisplay(event.summary || 'Untitled', { maxLen: 60 })}" needs heavy prep but you don't have a prep block scheduled.`,
      confidence: 0.8,
      reason: 'classifier flagged heavy-prep, no prep block',
      source: 'prep-gaps',
      action: { type: 'proposeFocusBlock', label: `Prep for ${event.summary}`, beforeEventId: event.id },
    };
  }
  return null;
}

/**
 * 4+ hour back-to-back stretches without a 15-min buffer. Soft-suggest a
 * recovery block.
 */
function checkRecoveryGaps(_memory, window) {
  const events = window.events || [];
  if (events.length < 4) return null;

  // Sort events by start, walk for back-to-back stretches.
  const sorted = [...events].sort((a, b) => {
    const sa = new Date(a.start?.dateTime || a.start?.date).getTime();
    const sb = new Date(b.start?.dateTime || b.start?.date).getTime();
    return sa - sb;
  });

  let stretchStart = null;
  let stretchMinutes = 0;
  let prevEnd = null;

  for (const e of sorted) {
    const start = new Date(e.start?.dateTime || 0);
    const end = new Date(e.end?.dateTime || 0);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    if (prevEnd && (start.getTime() - prevEnd.getTime()) < 5 * 60 * 1000) {
      stretchMinutes += (end.getTime() - start.getTime()) / 60000;
    } else {
      stretchStart = start;
      stretchMinutes = (end.getTime() - start.getTime()) / 60000;
    }
    if (stretchMinutes >= 4 * 60) {
      return {
        suggestion: `You have a 4+ hour back-to-back stretch starting ${stretchStart?.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} -- consider a 15-min recovery block.`,
        confidence: 0.65,
        reason: '4+ hour back-to-back, no buffer',
        source: 'recovery-gaps',
        action: { type: 'proposeFocusBlock', label: 'Recovery / decompress', durationMin: 15 },
      };
    }
    prevEnd = end;
  }
  return null;
}

/**
 * In-person event at a non-default location. Suggest a travel block.
 * Default location is read from preferences if set; otherwise we just check
 * for any non-empty, non-video location.
 */
function checkTravelGaps(memory, window) {
  const events = window.events || [];
  const prefs = memory?.readPreferences ? memory.readPreferences() : {};
  const defaultLocation = (prefs['Default location'] || '').toLowerCase().trim();
  const now = window.now || new Date();

  for (const event of events) {
    const start = new Date(event.start?.dateTime || event.start?.date || 0);
    if (start < now) continue;
    const loc = (event.location || '').trim();
    if (!loc) continue;
    if (/zoom|meet\.google|teams\.microsoft|webex|hangouts/i.test(loc)) continue;
    if (defaultLocation && loc.toLowerCase().includes(defaultLocation)) continue;

    return {
      suggestion: `"${sanitizeForDisplay(event.summary || 'Untitled', { maxLen: 60 })}" is at ${sanitizeForDisplay(loc, { maxLen: 40 })} -- block travel time?`,
      confidence: 0.6,
      reason: 'in-person event at non-default location',
      source: 'travel-gaps',
      action: { type: 'proposeFocusBlock', label: 'Travel time', beforeEventId: event.id },
    };
  }
  return null;
}

// ─── Aggregator ───────────────────────────────────────────────────────────

const ALL_CHECKS = [
  checkCommitments,
  checkExplicitCadences,
  checkGoals,
  checkReconnects,
  checkRoutines,
  checkMinedCadences,
  checkPrepGaps,
  checkRecoveryGaps,
  checkTravelGaps,
];

/**
 * Run every source check, sort by confidence, return the single top
 * suggestion if it clears the brief threshold. Lower-confidence results
 * may go to the user-action queue (caller's responsibility).
 *
 * @param {Object} window
 * @param {Date} [window.now]
 * @param {Array} [window.events] - calendar events in the upcoming window
 * @param {Object} [window.classifierVerdicts] - eventId -> verdict
 * @param {number} [window.horizonDays] - how far out to look (default 14)
 * @param {Object} [opts]
 * @param {Object} [opts.memory] - calendar memory instance (defaults to singleton)
 * @returns {{ topSuggestion: Object|null, queueable: Object[] }}
 */
function detectAbsences(window = {}, opts = {}) {
  const memory = opts.memory || getCalendarMemory();
  const enabled = _readSetting('calendar.absenceDetectorEnabled', true);
  if (!enabled) return { topSuggestion: null, queueable: [] };

  // First-run grace: if memory has been around for less than the grace
  // period, stay silent so passive mining can warm up. We use the file
  // mtime / metadata if available; absent that, the contract is "silent
  // for 7 days from creation".
  const graceDays = _readSetting('calendar.absenceDetector.firstRunGraceDays', DEFAULT_FIRST_RUN_GRACE_DAYS);
  const memoryAgeDays = _memoryAgeDays(memory);
  if (memoryAgeDays !== null && memoryAgeDays < graceDays) {
    log.info('calendar-absence', 'Within first-run grace -- staying silent', { memoryAgeDays, graceDays });
    return { topSuggestion: null, queueable: [] };
  }

  const results = [];
  for (const check of ALL_CHECKS) {
    try {
      const r = check(memory, window);
      if (r && Number.isFinite(r.confidence)) results.push(r);
    } catch (err) {
      log.warn('calendar-absence', 'check failed (non-fatal)', { source: check.name, error: err.message });
    }
  }

  if (results.length === 0) return { topSuggestion: null, queueable: [] };

  results.sort((a, b) => b.confidence - a.confidence);

  const briefThreshold = _readSetting('calendar.absenceDetector.briefThreshold', CONFIDENCE_BRIEF_THRESHOLD);
  const reviewThreshold = _readSetting('calendar.absenceDetector.reviewThreshold', CONFIDENCE_REVIEW_THRESHOLD);

  const top = results[0].confidence >= briefThreshold ? results[0] : null;
  const queueable = results.filter((r, i) => {
    if (top && i === 0) return false; // top is brief-surfaced, not queued
    return r.confidence >= reviewThreshold && r.confidence < briefThreshold;
  });

  return { topSuggestion: top, queueable };
}

function _memoryAgeDays(memory) {
  // Best-effort: read the _header section's "Last updated" timestamp. If we
  // can't determine, return null so the grace gate is skipped (open behavior).
  if (!memory?._store?.getSection) return null;
  try {
    const header = memory._store.getSection('_header') || '';
    const m = header.match(/Last updated:\s*(\S+)/);
    if (!m) return null;
    const ts = new Date(m[1]).getTime();
    if (Number.isNaN(ts)) return null;
    return Math.round((Date.now() - ts) / (24 * 60 * 60 * 1000));
  } catch {
    return null;
  }
}

// ─── Brief contributor ───────────────────────────────────────────────────

/**
 * Daily brief contributor. Returns a synthetic agent-shaped object with
 * `getBriefing()` so the brief discovery in `getBriefingAgents()` picks it
 * up automatically. If no top suggestion exists, returns no content (the
 * silent-when-empty contract).
 */
async function getBriefing(context = {}) {
  try {
    const memory = getCalendarMemory();
    if (!memory.isLoaded()) await memory.load();

    const window = {
      now: context.now || new Date(),
      events: context.events || [],
      classifierVerdicts: context.classifierVerdicts || {},
      horizonDays: 14,
    };

    const { topSuggestion } = detectAbsences(window, { memory });
    if (!topSuggestion) return null; // silent

    return {
      section: 'Calendar Suggestions',
      priority: 4,
      content: topSuggestion.suggestion,
      absenceSource: topSuggestion.source,
      absenceAction: topSuggestion.action,
    };
  } catch (err) {
    log.warn('calendar-absence', 'getBriefing failed (non-fatal)', { error: err.message });
    return null;
  }
}

module.exports = {
  detectAbsences,
  getBriefing,
  // Per-source exports so callers can run individual checks.
  checkCommitments,
  checkExplicitCadences,
  checkMinedCadences,
  checkRoutines,
  checkGoals,
  checkReconnects,
  checkPrepGaps,
  checkRecoveryGaps,
  checkTravelGaps,
};
