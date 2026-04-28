/**
 * Temporal Context
 *
 * Agents don't just need "what is the user asking?" -- they need "what
 * has the user been doing?". Without temporal awareness, every question
 * feels like the first. With it, the system can say:
 *
 *   - "Looks like your morning routine; here's your calendar."
 *   - "You usually ask about this kind of thing around 5pm -- want me
 *      to set a reminder?"
 *   - "Earlier today you were asking about the Berkeley trip -- here's
 *      the coffee shop you saved."
 *
 * This module maintains a compact rolling model of:
 *
 *   1. RECENT:   the last ~20 interactions in chronological order
 *                (in-memory; drives "you were just doing X" context).
 *   2. HOURLY:   per-hour buckets for the last 7 days. Tracks query-
 *                bucket frequency by hour-of-day so we can surface
 *                "usually at this time you..." patterns.
 *   3. DAILY:    per-day summaries for the last 14 days. Each day gets
 *                a top-3 bucket list. Used for cross-session continuity.
 *
 * State persists to userData/temporal/state.json. The footprint is tiny
 * (a few KB) because we store counts, not transcripts.
 *
 * Callers:
 *   - `recordInteraction({ userInput, agentId, timestamp, bucket? })`
 *     called from the exchange-bridge learning pipeline.
 *   - `getContextSnapshot()` returns a synchronous { recent, patterns,
 *     yesterdayTopics, timeOfDay } shaped object agents can splice into
 *     their prompt.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { getLogQueue } = require('./log-event-queue');

const MAX_RECENT = 20;
const MAX_HOURLY_DAYS = 7;
const MAX_DAILY_DAYS = 14;
const FLUSH_DEBOUNCE_MS = 30 * 1000; // coalesce persists

// Keep in sync with slow-success-tracker buckets so "usually at this
// time you do X" lines up with suggestion semantics.
const BUCKETS = [
  'local-search', 'weather', 'directions', 'news', 'time',
  'factual', 'calendar', 'email', 'tasks', 'playbook', 'other',
];

function classifyBucket(userInput) {
  const q = String(userInput || '').toLowerCase();
  if (!q) return 'other';

  // Time bucket: "what time", "today", "tomorrow"
  if (/\b(what time|what day|timezone|clock|tomorrow|today'?s)\b/.test(q)) return 'time';

  // Calendar
  if (/\b(meeting|calendar|schedule|appointment|event|my day)\b/.test(q)) return 'calendar';

  // Email
  if (/\b(email|inbox|unread|compose|reply|send to)\b/.test(q)) return 'email';

  // Tasks
  if (/\b(todo|task|reminder|checklist|priorit)\b/.test(q)) return 'tasks';

  // Weather
  if (/\b(weather|forecast|temperature|rain|snow|sunny|humid|wind)/.test(q)) return 'weather';

  // Local search / nearby
  if (/\b(nearby|near me|around here|closest|nearest|restaurant|cafe|coffee|pharmacy|gas station|bar|store)\b/.test(q)) {
    return 'local-search';
  }

  // Directions
  if (/\b(directions|drive to|walk to|how far|route|map)\b/.test(q)) return 'directions';

  // News
  if (/\b(news|headlines|latest|breaking|recent)\b/.test(q)) return 'news';

  // Factual / definitional
  if (/\b(what is|what's|who is|who's|define|meaning of|how does|how do)\b/.test(q)) {
    return 'factual';
  }

  // Playbook / agent build
  if (/\bplaybook|build(ing)? (an? )?agent\b/i.test(q)) return 'playbook';

  return 'other';
}

function _dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function _hourKey(ts) {
  const d = new Date(ts);
  return `${_dayKey(ts)}T${String(d.getHours()).padStart(2, '0')}`;
}
function _dayOfWeek(ts) { return new Date(ts).getDay(); } // 0=Sun
function _hourOfDay(ts) { return new Date(ts).getHours(); }

function _partOfDay(hour) {
  if (hour < 5) return 'late-night';
  if (hour < 10) return 'morning';
  if (hour < 12) return 'late-morning';
  if (hour < 14) return 'midday';
  if (hour < 17) return 'afternoon';
  if (hour < 21) return 'evening';
  return 'night';
}

class TemporalContext {
  constructor() {
    this._log = getLogQueue();
    this._diskPath = null;
    this._recent = [];                    // [{ ts, userInput, agentId, bucket }]
    this._hourly = new Map();             // hourKey -> { bucket: count }
    this._daily = new Map();              // dayKey  -> { bucket: count }
    this._flushTimer = null;
    this._disabled = false;
  }

  init(userDataDir) {
    if (!userDataDir) return this;
    try {
      const dir = path.join(userDataDir, 'temporal');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      this._diskPath = path.join(dir, 'state.json');
      if (fs.existsSync(this._diskPath)) {
        const raw = JSON.parse(fs.readFileSync(this._diskPath, 'utf8'));
        this._recent = Array.isArray(raw.recent) ? raw.recent.slice(-MAX_RECENT) : [];
        this._hourly = new Map(Object.entries(raw.hourly || {}));
        this._daily = new Map(Object.entries(raw.daily || {}));
        this._prune(Date.now());
      }
      this._log.info('app', '[TemporalContext] Loaded', {
        recent: this._recent.length,
        hourlyKeys: this._hourly.size,
        dailyKeys: this._daily.size,
      });
    } catch (err) {
      this._log.warn('app', '[TemporalContext] Init error', { error: err.message });
      this._disabled = true;
    }
    return this;
  }

  /**
   * Record a completed interaction. Non-blocking; persists debounced.
   */
  recordInteraction({ userInput, agentId, timestamp = Date.now(), bucket }) {
    if (this._disabled) return;
    const ts = timestamp;
    const b = bucket || classifyBucket(userInput);
    this._recent.push({
      ts,
      userInput: String(userInput || '').slice(0, 200),
      agentId,
      bucket: b,
    });
    if (this._recent.length > MAX_RECENT) this._recent.shift();

    const hk = _hourKey(ts);
    if (!this._hourly.has(hk)) this._hourly.set(hk, {});
    const hv = this._hourly.get(hk);
    hv[b] = (hv[b] || 0) + 1;

    const dk = _dayKey(ts);
    if (!this._daily.has(dk)) this._daily.set(dk, {});
    const dv = this._daily.get(dk);
    dv[b] = (dv[b] || 0) + 1;

    this._prune(ts);
    this._scheduleFlush();
  }

  /**
   * Return a snapshot agents can splice into their prompt. Cheap; no IO.
   */
  getContextSnapshot(now = Date.now()) {
    const currentHour = _hourOfDay(now);
    const currentDow = _dayOfWeek(now);

    // Last 3 interactions as "what you were just doing" signal
    const recent = this._recent.slice(-3).map((e) => ({
      ageMs: now - e.ts,
      bucket: e.bucket,
      userInput: e.userInput,
    }));

    // Hour-of-day patterns across last 7 days: { bucket: count at this hour }
    const hourCounts = {};
    for (const [hk, v] of this._hourly) {
      const hour = Number(hk.split('T')[1]);
      if (hour === currentHour) {
        for (const [b, n] of Object.entries(v)) {
          hourCounts[b] = (hourCounts[b] || 0) + n;
        }
      }
    }

    // Day-of-week patterns: same hour on same weekday is strongest signal
    const dowCounts = {};
    for (const [hk, v] of this._hourly) {
      const dateStr = hk.split('T')[0];
      const hour = Number(hk.split('T')[1]);
      if (hour !== currentHour) continue;
      if (_dayOfWeek(`${dateStr}T00:00:00`) !== currentDow) continue;
      for (const [b, n] of Object.entries(v)) {
        dowCounts[b] = (dowCounts[b] || 0) + n;
      }
    }

    // Previous-day top topics
    const yesterdayKey = _dayKey(now - 24 * 60 * 60 * 1000);
    const yesterday = this._daily.get(yesterdayKey) || {};
    const yesterdayTop = Object.entries(yesterday)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([bucket, count]) => ({ bucket, count }));

    // "usually at this time" pattern: pick top bucket for this hour
    // if sample is large enough
    const hourTop = Object.entries(hourCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([bucket, count]) => ({ bucket, count }));

    return {
      timeOfDay: _partOfDay(currentHour),
      hour: currentHour,
      dayOfWeek: ['sun','mon','tue','wed','thu','fri','sat'][currentDow],
      recent,
      patternsAtThisHour: hourTop,
      patternsAtThisHourAndDayOfWeek: Object.entries(dowCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([bucket, count]) => ({ bucket, count })),
      yesterdayTop,
      totalRecorded: this._recent.length,
    };
  }

  /**
   * Human-readable summary for splicing into agent prompts.
   * Returns empty string if we have no meaningful signal yet.
   */
  getPromptSummary(now = Date.now()) {
    const snap = this.getContextSnapshot(now);
    const parts = [];
    if (snap.recent.length > 0) {
      const last = snap.recent[snap.recent.length - 1];
      const mins = Math.round(last.ageMs / 60000);
      if (mins < 60) {
        parts.push(`Most recent activity (${mins} min ago): "${last.userInput}" [${last.bucket}]`);
      }
    }
    if (snap.patternsAtThisHour.length > 0 && snap.patternsAtThisHour[0].count >= 3) {
      const top = snap.patternsAtThisHour[0];
      parts.push(`At this hour you usually ask about: ${top.bucket} (${top.count} past times)`);
    }
    if (snap.yesterdayTop.length > 0) {
      parts.push(`Yesterday's top topics: ${snap.yesterdayTop.map((y) => y.bucket).join(', ')}`);
    }
    parts.push(`Time of day: ${snap.timeOfDay}, ${snap.dayOfWeek}`);
    return parts.join('\n');
  }

  /** Prune buckets outside retention window. */
  _prune(now) {
    const cutoffHourly = now - MAX_HOURLY_DAYS * 24 * 60 * 60 * 1000;
    for (const hk of [...this._hourly.keys()]) {
      const dateStr = hk.split('T')[0];
      if (new Date(dateStr).getTime() < cutoffHourly) this._hourly.delete(hk);
    }
    const cutoffDaily = now - MAX_DAILY_DAYS * 24 * 60 * 60 * 1000;
    for (const dk of [...this._daily.keys()]) {
      if (new Date(dk).getTime() < cutoffDaily) this._daily.delete(dk);
    }
  }

  _scheduleFlush() {
    if (!this._diskPath || this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this._flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  _flush() {
    if (!this._diskPath) return;
    try {
      const payload = {
        recent: this._recent,
        hourly: Object.fromEntries(this._hourly),
        daily: Object.fromEntries(this._daily),
        savedAt: Date.now(),
      };
      fs.writeFileSync(this._diskPath, JSON.stringify(payload));
    } catch (err) {
      this._log.warn('app', '[TemporalContext] Flush error', { error: err.message });
    }
  }

  _resetForTests() {
    this._recent = [];
    this._hourly.clear();
    this._daily.clear();
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
  }
}

let _instance = null;
function getTemporalContext() {
  if (!_instance) _instance = new TemporalContext();
  return _instance;
}

module.exports = {
  TemporalContext,
  getTemporalContext,
  classifyBucket,
  BUCKETS,
};
