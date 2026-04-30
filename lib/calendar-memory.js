/**
 * Calendar Memory (Phase 2b -- calendar agent overhaul)
 *
 * Domain-specific facade over `agent-memory-store` for calendar agents.
 * One memory file (`calendar-memory.md` in the GSX Agent space) backs both
 * `calendar-query-agent` and `calendar-mutate-agent`, providing:
 *
 *   - **Schema versioning + migrations** (Phase 0 contract). Every section
 *     carries a `<!-- schemaVersion: N -->` marker, the file head carries a
 *     `<!-- calendarMemoryVersion: N -->` marker, and a `migrations` table
 *     runs on load. Missing migrations refuse-to-load with a user-facing
 *     error rather than silently truncating.
 *
 *   - **Hot-path sidecar log + cold-path mutex**. Engagement increments and
 *     alias proposals append to `sidecar.jsonl` (lock-free, fast). The
 *     curator coalesces the sidecar into the markdown sections every 6 hours.
 *     Cold-path edits (Preferences, accepted alias promotion) take a per-
 *     section in-process mutex so two writers can't clobber.
 *
 *   - **Provenance tagging** on every entry. `{ source, sourceEventId?,
 *     createdAt }` is stored alongside each row. Phase 8 retriever filter
 *     uses this to keep `learning-loop` content out of prompts that handle
 *     user input -- the structural prompt-injection guardrail.
 *
 *   - **Sanitization helper** -- every code path that quotes event-derived
 *     text must pass it through `sanitizeForDisplay()`. Phase 0 contract.
 *
 * The API is intentionally section-scoped (readPreferences / proposeAlias /
 * appendEngagement / etc.) so callers don't reach into the markdown directly.
 * That keeps the schema-version/migration story honest.
 *
 * No agent code calls this module yet -- Phase 2d (BaseAgent refactor) wires
 * it into calendar-query and calendar-mutate. Phase 2b/2c just lay the
 * foundation.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();
const { AgentMemoryStore } = require('./agent-memory-store');

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

const AGENT_ID = 'calendar-memory';
const DISPLAY_NAME = 'Calendar Memory';

// File-level schema version. Bumped on a structural change to the file
// itself (renaming sections, splitting them, etc.). Section-level versions
// (below) cover field changes within a section.
const CURRENT_FILE_VERSION = 1;

// Per-section schema version. When a section's row schema changes (e.g.
// adding `source` provenance to alias entries), bump its entry here AND
// add a migration to MIGRATIONS below.
//
// NOT frozen: tests may mutate this object via `_setSchemaVersionForTests`
// to drive the migration runner end-to-end with synthetic versions.
// Production code MUST treat this as read-only by convention.
const SECTION_VERSIONS = {
  Preferences: 1,
  Aliases: 1,
  People: 1,
  'Engagement Stats': 1,
  Patterns: 1,
  'Brief Snapshots': 1,
  'Classifier Cache': 1,
  Cadences: 1,
  Commitments: 1,
  Routines: 1,
  Goals: 1,
  Reconnects: 1,
  'Life Events': 1,
  'Follow-ups': 1,
  'Learning Notes': 1,
};

// Order matters when (re)building the file from scratch -- working sections
// first, then absence-detector sections (often empty until Phase 6 fills
// them), then Learning Notes (auto-populated by the learning loop).
const SECTION_ORDER = Object.freeze([
  'Preferences',
  'Aliases',
  'People',
  'Engagement Stats',
  'Patterns',
  'Brief Snapshots',
  'Classifier Cache',
  // Absence-detector sections, populated empty per Phase 0:
  'Cadences',
  'Commitments',
  'Routines',
  'Goals',
  'Reconnects',
  'Life Events',
  'Follow-ups',
  // Auto-populated by learning loop:
  'Learning Notes',
]);

// Provenance tag values. Phase 8 retriever filter uses these to exclude
// `learning-loop` rows from prompts that interpolate user input.
const PROVENANCE = Object.freeze({
  USER_EXPLICIT: 'user-explicit',
  PATTERN_MINING: 'pattern-mining',
  LEARNING_LOOP: 'learning-loop',
});

const VERSION_COMMENT_RE = /<!--\s*schemaVersion:\s*(\d+)\s*-->/;
const FILE_VERSION_COMMENT_RE = /<!--\s*calendarMemoryVersion:\s*(\d+)\s*-->/;

// ─────────────────────────────────────────────────────────────────────────
// Migrations table
// ─────────────────────────────────────────────────────────────────────────
//
// MIGRATIONS[sectionName][fromVersion] = function(content) -> content
//
// Each migration is a pure markdown-in / markdown-out transform. The runner
// chains them: a section at v1 with target v3 runs v1->v2 then v2->v3.
//
// FILE_MIGRATIONS[fromVersion] = function(rawMarkdown) -> rawMarkdown
//
// File-level migrations run BEFORE section migrations (since they may
// rename or restructure sections themselves). They must end the markdown
// in a state where parseMarkdownSections still finds every required section.
//
// Both tables ship empty in Phase 2b. The infrastructure is what matters --
// Phase 6 will add a Cadences v1->v2 migration when it adds confidence
// fields, and the runner has to exist before the first real migration to
// avoid an awkward retrofit.

// Not frozen for the same testability reason as SECTION_VERSIONS above.
const MIGRATIONS = {};
const FILE_MIGRATIONS = {};

// ─────────────────────────────────────────────────────────────────────────
// In-process per-section mutex
// ─────────────────────────────────────────────────────────────────────────

const _sectionLocks = new Map(); // sectionName -> Promise<void>

async function _withSectionLock(sectionName, fn) {
  const prev = _sectionLocks.get(sectionName) || Promise.resolve();
  let release;
  const next = new Promise((resolve) => {
    release = resolve;
  });
  _sectionLocks.set(sectionName, prev.then(() => next));
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (_sectionLocks.get(sectionName) === prev.then(() => next)) {
      _sectionLocks.delete(sectionName);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Sanitization (Phase 0 contract)
// ─────────────────────────────────────────────────────────────────────────

const _CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const _MD_ESCAPE_RE = /([\\`*_{}[\]()#+!~|>-])/g;

/**
 * Strip control chars, cap to 200 chars, escape markdown specials. Used by
 * every code path that quotes event-derived text into a prompt or display
 * string. Phase 8 prompt-injection guardrails hinge on this being the ONLY
 * way event content reaches an LLM or a user-visible review-queue item.
 *
 * @param {string} input
 * @param {Object} [opts]
 * @param {number} [opts.maxLen=200]
 * @returns {string}
 */
function sanitizeForDisplay(input, opts = {}) {
  if (input == null) return '';
  const maxLen = Number.isFinite(opts.maxLen) ? opts.maxLen : 200;
  let s = String(input).replace(_CONTROL_RE, '');
  // Cap to exactly maxLen characters (including the ellipsis when truncated).
  if (s.length > maxLen) s = `${s.slice(0, Math.max(0, maxLen - 3))}...`;
  s = s.replace(_MD_ESCAPE_RE, '\\$1');
  return s;
}

// ─────────────────────────────────────────────────────────────────────────
// Provenance helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build a provenance suffix to embed in a markdown row. We use a compact
 * comment so the markdown stays human-readable and the retriever filter
 * can parse it back deterministically.
 *
 *   "- the leadership meeting -> evt_123  <!-- src=user-explicit ts=2026-04-29T18:00:00Z -->"
 */
function _buildProvenanceComment({ source, sourceEventId, createdAt }) {
  const parts = [`src=${source || PROVENANCE.USER_EXPLICIT}`];
  if (sourceEventId) parts.push(`evt=${sourceEventId}`);
  parts.push(`ts=${createdAt || new Date().toISOString()}`);
  return `<!-- ${parts.join(' ')} -->`;
}

const _PROVENANCE_COMMENT_RE = /<!--\s*(?:src|evt|ts)=[^>]*-->/;

function _parseProvenanceFromLine(line) {
  const match = line.match(/<!--\s*src=([^\s]+)(?:\s+evt=([^\s]+))?\s+ts=([^\s]+)\s*-->/);
  if (!match) return null;
  return {
    source: match[1],
    sourceEventId: match[2] || null,
    createdAt: match[3],
  };
}

function _stripProvenance(line) {
  return line.replace(_PROVENANCE_COMMENT_RE, '').trimEnd();
}

// ─────────────────────────────────────────────────────────────────────────
// Snapshot serialization helpers (Phase 2e)
// ─────────────────────────────────────────────────────────────────────────

function _normalizeDateKey(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  const s = String(d);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const parsed = new Date(s);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function _parseSnapshotLine(text) {
  // text is the post-readEntries canonical form (leading "- " already stripped)
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && parsed.date && parsed.events) {
      return parsed;
    }
  } catch {
    /* fall through */
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Sidecar log path
// ─────────────────────────────────────────────────────────────────────────

let _sidecarPathOverride = null;

/**
 * The sidecar lives next to the agent-memory markdown so the curator can
 * find both with one stat() pair. Tests inject an override via
 * `_setSidecarPathForTests()`.
 */
function _resolveSidecarPath() {
  if (_sidecarPathOverride) return _sidecarPathOverride;
  return path.join(
    os.homedir(),
    'Documents',
    'OR-Spaces',
    'items',
    `agent-memory-${AGENT_ID}`,
    'sidecar.jsonl'
  );
}

function _setSidecarPathForTests(p) {
  _sidecarPathOverride = p;
}

function _ensureSidecarDir() {
  const p = _resolveSidecarPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return p;
}

function _appendSidecarRecord(record) {
  try {
    const p = _ensureSidecarDir();
    fs.appendFileSync(p, `${JSON.stringify({ ...record, ts: record.ts || new Date().toISOString() })}\n`);
    return true;
  } catch (err) {
    log.warn('calendar-memory', 'sidecar append failed', { error: err.message });
    return false;
  }
}

function _readSidecar() {
  const p = _resolveSidecarPath();
  try {
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, 'utf8');
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    log.warn('calendar-memory', 'sidecar read failed', { error: err.message });
    return [];
  }
}

function _truncateSidecar() {
  const p = _resolveSidecarPath();
  try {
    if (fs.existsSync(p)) fs.writeFileSync(p, '');
  } catch (err) {
    log.warn('calendar-memory', 'sidecar truncate failed', { error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Identity-keyed snapshot diff helpers (Phase 2e)
// ─────────────────────────────────────────────────────────────────────────
//
// The naive "compare today's timeline summary to yesterday's" diff produces
// noise -- every recurring instance reads as "still there", every one-off
// reads as "new". The correct algorithm is identity-keyed, AND the key
// has to survive a moved recurring instance:
//
//   - When a user moves the Tuesday standup from 9am to 10am, the OBVIOUS
//     key `${recurringEventId}:${currentStartTime}` would change ("Tue 9am"
//     -> "Tue 10am") and the diff would report remove(Tue 9am) + add(Tue
//     10am). That's the noise we're trying to eliminate.
//
//   - The fix: key on Google's `originalStartTime` field, which is the
//     recurrence's intended occurrence slot. It's set on every instance and
//     stays constant across reschedules. That way the moved instance keeps
//     its identity and surfaces in the `moved` bucket.
//
//   - Fallback: Google generates instance ids `${recurringEventId}_${origTs}`
//     -- the id itself is stable across reschedules even if `originalStartTime`
//     isn't normalized through Omnical.

/**
 * Compute the stable identity key for an event. See header comment above
 * for the recurring-instance reasoning.
 *
 * @param {Object} event - raw calendar event (Google or Omnical-shaped)
 * @returns {string|null}
 */
function eventKey(event) {
  if (!event) return null;
  if (event.recurringEventId && event.originalStartTime) {
    const ost = event.originalStartTime.dateTime || event.originalStartTime.date;
    if (ost) return `${event.recurringEventId}:${ost}`;
  }
  // Stable fallback: Google instance ids include the original timestamp.
  if (event.recurringEventId && event.id) return event.id;
  if (event.id) return event.id;
  return null;
}

/**
 * Build a snapshot map from a list of events. The map is keyed by `eventKey`
 * and each entry stores just enough fields to reconstruct a diff line.
 *
 * @param {Array} events - raw calendar events
 * @returns {Object} key -> { title, startISO, endISO, recurringEventId }
 */
function buildSnapshotMap(events) {
  const out = {};
  for (const e of events || []) {
    const k = eventKey(e);
    if (!k) continue;
    const startISO = e.start?.dateTime || e.start?.date || null;
    const endISO = e.end?.dateTime || e.end?.date || null;
    out[k] = {
      title: e.summary || e.title || null,
      startISO,
      endISO,
      recurringEventId: e.recurringEventId || null,
    };
  }
  return out;
}

/**
 * Diff two snapshot maps. Returns sets of added/removed/moved/retitled
 * events, keyed by stable identity. Empty arrays when both sides match.
 *
 * @param {Object} yesterdayMap - prior snapshot's events map
 * @param {Object} todayMap - current snapshot's events map
 */
function diffSnapshots(yesterdayMap, todayMap) {
  const y = yesterdayMap || {};
  const t = todayMap || {};
  const added = [];
  const removed = [];
  const moved = [];
  const retitled = [];
  const yesterdayKeys = new Set(Object.keys(y));
  const todayKeys = new Set(Object.keys(t));

  for (const k of todayKeys) {
    if (!yesterdayKeys.has(k)) {
      added.push({ key: k, ...t[k] });
      continue;
    }
    const yEntry = y[k];
    const tEntry = t[k];
    if (yEntry.startISO !== tEntry.startISO) {
      moved.push({ key: k, fromStart: yEntry.startISO, toStart: tEntry.startISO, ...tEntry });
    }
    if (yEntry.title !== tEntry.title) {
      retitled.push({ key: k, fromTitle: yEntry.title, toTitle: tEntry.title, ...tEntry });
    }
  }
  for (const k of yesterdayKeys) {
    if (!todayKeys.has(k)) removed.push({ key: k, ...y[k] });
  }
  return { added, removed, moved, retitled };
}

// ─────────────────────────────────────────────────────────────────────────
// CalendarMemory class
// ─────────────────────────────────────────────────────────────────────────

class CalendarMemory {
  constructor(opts = {}) {
    this._store = new AgentMemoryStore(AGENT_ID, { displayName: DISPLAY_NAME });
    this._store._sectionsToRender = SECTION_ORDER; // for future renderers; plain hint
    this._strict = Boolean(opts.strict);
    this._loaded = false;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  async load() {
    if (this._loaded) return true;
    await this._store.load();

    const rawHeader = this._store.getSection('_header') || '';
    const fileVersion = this._readFileVersion(rawHeader);

    // File-level migrations (rare; bump file version on structural reshapes).
    if (fileVersion < CURRENT_FILE_VERSION) {
      await this._runFileMigrations(fileVersion);
    } else if (fileVersion > CURRENT_FILE_VERSION) {
      const msg = `Calendar memory file is version ${fileVersion}, but this build only knows version ${CURRENT_FILE_VERSION}. Please update Onereach.ai before opening this calendar memory.`;
      log.error('calendar-memory', msg);
      throw new Error(msg);
    }

    // Section-level migrations.
    await this._runSectionMigrations();

    // Ensure all required sections exist with correct schema markers.
    this._ensureSections();

    if (this._store.isDirty()) {
      await this._store.save();
    }

    this._loaded = true;
    return true;
  }

  isLoaded() {
    return this._loaded;
  }

  async save() {
    return this._store.save();
  }

  /**
   * Test seam: replace the underlying AgentMemoryStore with a fake. Useful
   * for unit tests that want to drive the migration runner with synthetic
   * markdown without touching Spaces.
   */
  _setStoreForTests(fakeStore) {
    this._store = fakeStore;
  }

  // ── Schema-version helpers ───────────────────────────────────────────

  _readFileVersion(header) {
    const m = header.match(FILE_VERSION_COMMENT_RE);
    if (!m) return 0; // legacy / un-versioned files = 0
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : 0;
  }

  _readSectionVersion(content) {
    if (!content) return 0;
    const m = content.match(VERSION_COMMENT_RE);
    if (!m) return 0;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : 0;
  }

  async _runFileMigrations(fromVersion) {
    let v = fromVersion;
    while (v < CURRENT_FILE_VERSION) {
      const fn = FILE_MIGRATIONS[v];
      if (!fn) {
        // Legacy un-versioned files (v=0) bump straight to v1 with just a
        // header stamp -- there's no prior schema we'd be silently dropping.
        // Real migrations (v>=1) MUST be registered or we refuse to load
        // rather than risk corrupting user data.
        if (v === 0) {
          log.info('calendar-memory', 'File legacy stamp: treating un-versioned file as v1');
          v += 1;
          continue;
        }
        const msg = `No file migration registered from v${v} to v${v + 1}. Refusing to silently truncate.`;
        log.error('calendar-memory', msg);
        throw new Error(msg);
      }
      const before = this._store.getRaw();
      const after = fn(before);
      this._store.setRaw(after);
      log.info('calendar-memory', `File migration v${v} -> v${v + 1} applied`);
      v += 1;
    }

    // Stamp current version into header.
    const header = this._store.getSection('_header') || '';
    const stamped = header.replace(FILE_VERSION_COMMENT_RE, '').trimEnd();
    const newHeader = `${stamped}\n<!-- calendarMemoryVersion: ${CURRENT_FILE_VERSION} -->`.trim();
    this._store.updateSection('_header', newHeader);
  }

  async _runSectionMigrations() {
    for (const [section, target] of Object.entries(SECTION_VERSIONS)) {
      const current = this._store.getSection(section);
      if (current == null) continue; // section missing -- _ensureSections() will create with current version
      const fromVersion = this._readSectionVersion(current);
      if (fromVersion === target) continue;

      if (fromVersion > target) {
        const msg = `Section "${section}" is v${fromVersion}, but this build only knows v${target}. Refusing to load.`;
        log.error('calendar-memory', msg);
        throw new Error(msg);
      }

      let working = current;
      let v = fromVersion;
      while (v < target) {
        const fn = (MIGRATIONS[section] || {})[v];
        if (!fn) {
          // Legacy section (v=0, no schemaVersion comment) bumps to v1 with
          // a stamp. Higher versions REQUIRE a registered migration.
          if (v === 0) {
            log.info('calendar-memory', `Section "${section}" legacy stamp: treating un-versioned section as v1`);
            v += 1;
            continue;
          }
          const msg = `No migration registered for "${section}" v${v} -> v${v + 1}. Refusing to silently truncate.`;
          log.error('calendar-memory', msg);
          throw new Error(msg);
        }
        working = fn(working);
        log.info('calendar-memory', `Section "${section}" v${v} -> v${v + 1} applied`);
        v += 1;
      }

      // Stamp current section version comment.
      const stamped = this._stampSectionVersion(working, target);
      this._store.updateSection(section, stamped);
    }
  }

  _stampSectionVersion(content, version) {
    const cleaned = content.replace(VERSION_COMMENT_RE, '').replace(/^\n+/, '');
    return `<!-- schemaVersion: ${version} -->\n${cleaned}`;
  }

  _ensureSections() {
    let mutated = false;
    for (const section of SECTION_ORDER) {
      if (!this._store.getSection(section)) {
        const seed = this._defaultSectionContent(section);
        this._store.updateSection(section, seed);
        mutated = true;
      } else {
        // Backfill schema version comment if missing.
        const cur = this._store.getSection(section);
        if (!VERSION_COMMENT_RE.test(cur)) {
          this._store.updateSection(section, this._stampSectionVersion(cur, SECTION_VERSIONS[section] || 1));
          mutated = true;
        }
      }
    }
    // Ensure file-version comment present in header.
    const header = this._store.getSection('_header') || '';
    if (!FILE_VERSION_COMMENT_RE.test(header)) {
      this._store.updateSection(
        '_header',
        `${header.trim()}\n<!-- calendarMemoryVersion: ${CURRENT_FILE_VERSION} -->`.trim()
      );
      mutated = true;
    }
    return mutated;
  }

  _defaultSectionContent(name) {
    const v = SECTION_VERSIONS[name] || 1;
    const stamp = `<!-- schemaVersion: ${v} -->`;

    switch (name) {
      case 'Preferences':
        return `${stamp}
*Calendar preferences. Edit freely.*
- Briefing inclusions: all
- Briefing excluded sections: none
- Default timeframe: today
- Spoken style: standard`;

      case 'Aliases':
        return `${stamp}
*Phrases the user repeats that map to a specific event title or attendee. One per line.*
*No aliases learned yet.*`;

      case 'People':
        return `${stamp}
*Per-attendee notes. Used by prep card and fuzzy attendee search.*
*No people notes yet.*`;

      case 'Engagement Stats':
        return `${stamp}
*Per-meeting-title rolling counts of queries, joins, edits, no-shows. Drives engaged/drifting/newly-recurring tagging.*
*No engagement data yet.*`;

      case 'Patterns':
        return `${stamp}
*Learned shortcuts -- "user briefs every weekday at 8 AM", etc.*
*No patterns learned yet.*`;

      case 'Brief Snapshots':
        return `${stamp}
*Identity-keyed event records for the last N days. Used by the "what changed since yesterday" diff in Phase 2e.*
*No snapshots stored yet.*`;

      case 'Classifier Cache':
        return `${stamp}
*Machine-only cache of meeting-classifier verdicts. Hidden in the GSX UI.*
*No verdicts cached yet.*`;

      case 'Cadences':
        return `${stamp}
*Recurring-meeting expectations from explicit user statements or 90d Omnical pattern mining. Phase 6 fills this.*
*No cadences yet.*`;

      case 'Commitments':
        return `${stamp}
*Time-bound action items the user has agreed to. Phase 6 fills this.*
*No commitments yet.*`;

      case 'Routines':
        return `${stamp}
*Time-blocking habits (gym, focus blocks, etc.). Phase 6 fills this.*
*No routines yet.*`;

      case 'Goals':
        return `${stamp}
*Time-bound goals with deadlines. Phase 6 fills this.*
*No goals yet.*`;

      case 'Reconnects':
        return `${stamp}
*People to reconnect with -- "1:1 with Marcus every 4 weeks". Phase 6 fills this.*
*No reconnects yet.*`;

      case 'Life Events':
        return `${stamp}
*Birthdays, anniversaries, and personal milestones. Phase 6 fills this.*
*No life events yet.*`;

      case 'Follow-ups':
        return `${stamp}
*Follow-up tasks waiting on prior meetings. Phase 6 fills this.*
*No follow-ups yet.*`;

      case 'Learning Notes':
        return `${stamp}
*Auto-populated by the agent-learning loop when answers score low. Do not edit.*
*No learning notes yet.*`;

      default:
        return stamp;
    }
  }

  // ── Section-scoped read API ─────────────────────────────────────────

  getSectionRaw(name) {
    if (!this._loaded) {
      log.warn('calendar-memory', 'getSectionRaw before load -- returning null', { section: name });
      return null;
    }
    return this._store.getSection(name);
  }

  /**
   * Read all rows from a section, parsed into `{ text, provenance }` records.
   * Empty placeholder lines (those starting with `*` or wrapped in markdown
   * italics) are filtered out.
   */
  readEntries(name) {
    const content = this.getSectionRaw(name);
    if (!content) return [];
    const lines = content.split('\n');
    const out = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('<!--')) continue; // schema version + provenance comments
      if (line.startsWith('*') && line.endsWith('*')) continue; // placeholder
      const provenance = _parseProvenanceFromLine(line);
      // Canonical text = line minus provenance suffix and leading bullet.
      // Writers ALWAYS prepend "- " when rebuilding the section, so we strip
      // it here so round-trips don't accumulate dashes.
      const text = _stripProvenance(line).replace(/^-\s+/, '');
      out.push({ text, provenance });
    }
    return out;
  }

  /**
   * Read entries excluding any with `learning-loop` provenance. Phase 8
   * retriever filter. Pass these to prompts that interpolate user input.
   */
  readEntriesTrusted(name) {
    return this.readEntries(name).filter(
      (e) => !e.provenance || e.provenance.source !== PROVENANCE.LEARNING_LOOP
    );
  }

  readPreferences() {
    return this._store.parseSectionAsKeyValue('Preferences');
  }

  // ── Section-scoped write API ────────────────────────────────────────

  /**
   * Cold-path full-section write. Mutex-guarded so two concurrent writers
   * don't clobber each other.
   */
  async writeSection(name, content) {
    if (!this._loaded) await this.load();
    return _withSectionLock(name, async () => {
      const v = SECTION_VERSIONS[name] || 1;
      const stamped = this._stampSectionVersion(content, v);
      this._store.updateSection(name, stamped);
      await this._store.save();
      return true;
    });
  }

  async writePreferences(kv) {
    if (!this._loaded) await this.load();
    return _withSectionLock('Preferences', async () => {
      const lines = [`<!-- schemaVersion: ${SECTION_VERSIONS.Preferences} -->`];
      for (const [k, v] of Object.entries(kv)) {
        lines.push(`- ${k}: ${v}`);
      }
      this._store.updateSection('Preferences', lines.join('\n'));
      await this._store.save();
      return true;
    });
  }

  // ── Hot-path sidecar API ────────────────────────────────────────────

  /**
   * Hot path: append an alias proposal to the sidecar log. Does NOT modify
   * the markdown directly -- the curator coalesces the sidecar into the
   * Aliases section every 6 hours, AND user acceptance via the review queue
   * promotes a single proposal to the markdown immediately via writeSection.
   *
   * @param {Object} input
   * @param {string} input.phrase - the user phrase that should resolve to the event
   * @param {string} input.eventId - the event id the alias points to
   * @param {string} [input.eventTitle] - optional human title (sanitized before storing)
   * @param {string} [input.source] - provenance, defaults to 'learning-loop'
   * @param {string} [input.sourceEventId]
   */
  proposeAlias({ phrase, eventId, eventTitle, source, sourceEventId }) {
    if (!phrase || !eventId) return false;
    return _appendSidecarRecord({
      kind: 'alias-proposal',
      phrase: sanitizeForDisplay(phrase),
      eventId,
      eventTitle: eventTitle ? sanitizeForDisplay(eventTitle) : null,
      source: source || PROVENANCE.LEARNING_LOOP,
      sourceEventId: sourceEventId || null,
    });
  }

  /**
   * Hot path: record an engagement signal for an event. Drives the
   * engaged/drifting/newly-recurring tag.
   *
   * @param {Object} input
   * @param {string} input.eventId
   * @param {string} input.signal - 'queried' | 'joined' | 'edited' | 'no-show' | 'declined'
   * @param {string} [input.source]
   */
  appendEngagement({ eventId, signal, source }) {
    if (!eventId || !signal) return false;
    return _appendSidecarRecord({
      kind: 'engagement',
      eventId,
      signal,
      source: source || PROVENANCE.LEARNING_LOOP,
    });
  }

  /**
   * Read the pending sidecar entries WITHOUT coalescing them. Useful for
   * tests and for the review queue to surface proposals to the user before
   * they're committed to the markdown.
   */
  readSidecar() {
    return _readSidecar();
  }

  /**
   * Coalesce sidecar entries into the markdown sections. Called by the
   * curator on its 6-hour sweep. Synchronizes the markdown with what's been
   * accumulating, then truncates the sidecar.
   *
   * Idempotent: running coalesce twice with no new entries is a no-op.
   *
   * @returns {{ aliases: number, engagement: number }} coalesce counts
   */
  async coalesceSidecar() {
    if (!this._loaded) await this.load();
    const records = _readSidecar();
    if (records.length === 0) return { aliases: 0, engagement: 0 };

    const counts = { aliases: 0, engagement: 0 };

    // Aliases: append unique (phrase, eventId) pairs that aren't already in the section.
    const aliasRecords = records.filter((r) => r.kind === 'alias-proposal');
    if (aliasRecords.length > 0) {
      await _withSectionLock('Aliases', async () => {
        const existing = this.readEntries('Aliases');
        const seen = new Set(existing.map((e) => e.text));

        const lines = [`<!-- schemaVersion: ${SECTION_VERSIONS.Aliases} -->`];
        if (existing.length === 0) {
          // Fresh section -- drop the placeholder.
        }
        for (const e of existing) {
          const prov = e.provenance ? ` ${_buildProvenanceComment(e.provenance)}` : '';
          lines.push(`- ${e.text}${prov}`);
        }
        for (const r of aliasRecords) {
          const text = r.eventTitle
            ? `${r.phrase} -> ${r.eventTitle} (${r.eventId})`
            : `${r.phrase} -> ${r.eventId}`;
          if (seen.has(text)) continue;
          seen.add(text);
          const prov = _buildProvenanceComment({
            source: r.source,
            sourceEventId: r.sourceEventId,
            createdAt: r.ts,
          });
          lines.push(`- ${text} ${prov}`);
          counts.aliases += 1;
        }
        this._store.updateSection('Aliases', lines.join('\n'));
      });
    }

    // Engagement: increment per-eventId counters in the section. We store
    // one row per eventId with running counts: "evt_123: queried=4, joined=2".
    const engagementRecords = records.filter((r) => r.kind === 'engagement');
    if (engagementRecords.length > 0) {
      await _withSectionLock('Engagement Stats', async () => {
        const existing = this.readEntries('Engagement Stats');
        const counters = new Map(); // eventId -> { signal: count }

        for (const e of existing) {
          // Format: "evt_123: queried=4, joined=2"
          const m = e.text.match(/^([^:]+):\s*(.+)$/);
          if (!m) continue;
          const id = m[1].trim();
          const stats = {};
          for (const piece of m[2].split(',')) {
            const kv = piece.trim().split('=');
            if (kv.length === 2 && Number.isFinite(Number(kv[1]))) {
              stats[kv[0].trim()] = Number(kv[1]);
            }
          }
          counters.set(id, stats);
        }

        for (const r of engagementRecords) {
          const stats = counters.get(r.eventId) || {};
          stats[r.signal] = (stats[r.signal] || 0) + 1;
          counters.set(r.eventId, stats);
          counts.engagement += 1;
        }

        const lines = [`<!-- schemaVersion: ${SECTION_VERSIONS['Engagement Stats']} -->`];
        for (const [id, stats] of counters) {
          const summary = Object.entries(stats)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ');
          lines.push(`- ${id}: ${summary}`);
        }
        this._store.updateSection('Engagement Stats', lines.join('\n'));
      });
    }

    await this._store.save();
    _truncateSidecar();
    return counts;
  }

  // ── Brief Snapshots (Phase 2e) ──────────────────────────────────────

  /**
   * Persist a snapshot for a given date. Each row is one JSON object so the
   * round-trip is lossless. Upsert-by-date: re-writing the same date replaces
   * the prior snapshot (the brief may run multiple times in a day).
   *
   * Pruning: rows older than `briefSnapshots.retentionDays` (default 14) are
   * dropped on each write so the section can't grow unbounded.
   *
   * @param {string|Date} date - the day this snapshot describes (YYYY-MM-DD)
   * @param {Array} events - raw events to snapshot
   */
  async writeBriefSnapshot(date, events) {
    if (!this._loaded) await this.load();
    const dateKey = _normalizeDateKey(date);
    if (!dateKey) return false;

    const eventsMap = buildSnapshotMap(events);
    const retentionDays = (global.settingsManager?.get('calendar.briefSnapshots.retentionDays')) || 14;
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

    return _withSectionLock('Brief Snapshots', async () => {
      const existing = this.readEntries('Brief Snapshots');
      const surviving = [];
      for (const e of existing) {
        const parsed = _parseSnapshotLine(e.text);
        if (!parsed) continue;
        if (parsed.date === dateKey) continue; // upsert: skip prior same-date row
        const ts = new Date(parsed.date).getTime();
        if (Number.isFinite(ts) && ts < cutoff) continue;
        surviving.push(parsed);
      }
      surviving.push({ date: dateKey, events: eventsMap });
      // Newest-first so the next read finds yesterday quickly.
      surviving.sort((a, b) => (a.date < b.date ? 1 : -1));

      const lines = [`<!-- schemaVersion: ${SECTION_VERSIONS['Brief Snapshots']} -->`];
      for (const s of surviving) {
        lines.push(`- ${JSON.stringify(s)}`);
      }
      this._store.updateSection('Brief Snapshots', lines.join('\n'));
      await this._store.save();
      return true;
    });
  }

  /**
   * Read the snapshot for a specific date, or null if none.
   */
  readBriefSnapshot(date) {
    if (!this._loaded) return null;
    const dateKey = _normalizeDateKey(date);
    if (!dateKey) return null;
    const entries = this.readEntries('Brief Snapshots');
    for (const e of entries) {
      const parsed = _parseSnapshotLine(e.text);
      if (parsed && parsed.date === dateKey) return parsed;
    }
    return null;
  }

  /**
   * Read the most recent snapshot strictly before `date`. Used to find the
   * "yesterday" baseline for the diff -- but yesterday may actually be the
   * last day the user ran a brief, which could be more than 1 day ago.
   *
   * Returns `{ date, events, ageDays }` or null if no prior snapshot exists.
   */
  getMostRecentBriefSnapshot(date) {
    if (!this._loaded) return null;
    const dateKey = _normalizeDateKey(date);
    if (!dateKey) return null;
    const entries = this.readEntries('Brief Snapshots');
    let best = null;
    for (const e of entries) {
      const parsed = _parseSnapshotLine(e.text);
      if (!parsed || parsed.date >= dateKey) continue;
      if (!best || parsed.date > best.date) best = parsed;
    }
    if (!best) return null;
    const ageMs = new Date(dateKey).getTime() - new Date(best.date).getTime();
    return {
      ...best,
      ageDays: Math.max(0, Math.round(ageMs / (24 * 60 * 60 * 1000))),
    };
  }

  // ── Aliases (cold-path acceptance from review queue) ─────────────────

  /**
   * Promote a single alias from a proposal to the Aliases section. This is
   * called when the user accepts a userQueue review item -- it bypasses the
   * sidecar coalesce (which is curator-driven) and writes directly with
   * provenance = user-explicit.
   */
  async acceptAlias({ phrase, eventId, eventTitle }) {
    if (!phrase || !eventId) return false;
    if (!this._loaded) await this.load();
    return _withSectionLock('Aliases', async () => {
      const existing = this.readEntries('Aliases');
      const text = eventTitle
        ? `${sanitizeForDisplay(phrase)} -> ${sanitizeForDisplay(eventTitle)} (${eventId})`
        : `${sanitizeForDisplay(phrase)} -> ${eventId}`;
      if (existing.some((e) => e.text === text)) return true;

      const lines = [`<!-- schemaVersion: ${SECTION_VERSIONS.Aliases} -->`];
      for (const e of existing) {
        const prov = e.provenance ? ` ${_buildProvenanceComment(e.provenance)}` : '';
        lines.push(`- ${e.text}${prov}`);
      }
      const prov = _buildProvenanceComment({ source: PROVENANCE.USER_EXPLICIT });
      lines.push(`- ${text} ${prov}`);
      this._store.updateSection('Aliases', lines.join('\n'));
      await this._store.save();
      return true;
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Singleton + module exports
// ─────────────────────────────────────────────────────────────────────────

let _instance = null;

function getCalendarMemory() {
  if (!_instance) _instance = new CalendarMemory();
  return _instance;
}

function _resetForTests() {
  _instance = null;
  _sidecarPathOverride = null;
  _sectionLocks.clear();
}

module.exports = {
  CalendarMemory,
  getCalendarMemory,
  sanitizeForDisplay,
  PROVENANCE,
  SECTION_ORDER,
  SECTION_VERSIONS,
  CURRENT_FILE_VERSION,
  MIGRATIONS,
  FILE_MIGRATIONS,
  // Phase 2e -- identity-keyed snapshot diff helpers (also useful to
  // callers outside CalendarMemory, e.g. unit tests or future absence
  // detector that needs the same key shape).
  eventKey,
  buildSnapshotMap,
  diffSnapshots,
  // Test seams (underscore prefix marks them):
  _setSidecarPathForTests,
  _resetForTests,
  _buildProvenanceComment,
  _parseProvenanceFromLine,
};
