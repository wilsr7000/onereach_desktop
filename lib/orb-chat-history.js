'use strict';

/**
 * orb-chat-history -- append-only persistent log of orb chat interactions
 *
 * The chat panel is now the unified conversation log (Phase 1 of the
 * Orb Unified UX redesign). It records every interaction the user has
 * with the orb -- voice transcripts, text submissions, agent replies
 * (visualText), and proactive alerts -- so users can scroll back and
 * see what happened.
 *
 * Storage: append-only JSONL at
 *   ~/Library/Application Support/Onereach.ai/orb-chat-history.jsonl
 * One JSON object per line. Schema:
 *   {
 *     id:          ulid-ish string,
 *     ts:          ISO 8601 timestamp,
 *     role:        'user' | 'assistant' | 'system',
 *     source:      'voice' | 'text' | 'agent-proactive' | 'breadcrumb',
 *     text:        the visible text,
 *     agentId:     null | string,
 *     agentName:   null | string,
 *     cardHtml:    null | string (inline micro-UI for displayMode === 'inline'),
 *     modalAgentId: null | string (when a modal was shown for displayMode === 'modal'),
 *     inputModality: 'voice' | 'text' | null (only meaningful for assistant turns)
 *   }
 *
 * Rotation: when the file exceeds MAX_ENTRIES, the oldest entries are
 * dropped to keep it bounded. The cap is generous (5000) so the user
 * has a long scroll-back without runaway disk use.
 *
 * The module is sync. Each append is a single fs.appendFileSync call
 * (a few hundred bytes); even at high orb-chat throughput this is
 * trivial. Async + queueing would add complexity without clear win.
 *
 * Used by exchange-bridge (assistant turns from task:settled), orb's
 * IPC handler (user turns from sendChatMessage / processVoiceCommand),
 * and the main process (loading the last N entries on orb open).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

let _cachedPath = null;
const MAX_ENTRIES = 5000;
const LOAD_DEFAULT = 50;

function getHistoryPath() {
  if (_cachedPath) return _cachedPath;
  // Mirror Electron app.getPath('userData') without requiring the
  // Electron module (this lib is testable in isolation).
  const home = os.homedir();
  const dir = process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'Onereach.ai')
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA || home, 'Onereach.ai')
      : path.join(home, '.config', 'Onereach.ai');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_e) {
    /* dir exists, OK */
  }
  _cachedPath = path.join(dir, 'orb-chat-history.jsonl');
  return _cachedPath;
}

// For tests
function _setHistoryPath(p) {
  _cachedPath = p;
}
function _resetHistoryPath() {
  _cachedPath = null;
}

function _ulid() {
  // Tiny ulid-ish: timestamp + 8 random chars. Not crypto-strong but
  // collision-resistant enough for chat entry IDs.
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${ts}-${rand}`;
}

function _validRole(role) {
  return role === 'user' || role === 'assistant' || role === 'system';
}

function _validSource(source) {
  return source === 'voice' || source === 'text' || source === 'agent-proactive' || source === 'breadcrumb';
}

function appendEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new TypeError('appendEntry requires an object');
  }
  if (!_validRole(entry.role)) {
    throw new RangeError(`role must be 'user'|'assistant'|'system', got ${entry.role}`);
  }
  if (!_validSource(entry.source)) {
    throw new RangeError(`source must be 'voice'|'text'|'agent-proactive'|'breadcrumb', got ${entry.source}`);
  }
  if (typeof entry.text !== 'string') {
    throw new TypeError('text must be a string');
  }

  const stamped = {
    id: entry.id || _ulid(),
    ts: entry.ts || new Date().toISOString(),
    role: entry.role,
    source: entry.source,
    text: entry.text,
    agentId: entry.agentId || null,
    agentName: entry.agentName || null,
    cardHtml: typeof entry.cardHtml === 'string' && entry.cardHtml.length > 0 ? entry.cardHtml : null,
    modalAgentId: entry.modalAgentId || null,
    inputModality: entry.inputModality || null,
  };

  const line = JSON.stringify(stamped) + '\n';
  fs.appendFileSync(getHistoryPath(), line, 'utf8');

  // Lazy rotation: only check size every Nth append to keep cost low.
  // 1/64 chance per call -> on average a check every 64 appends.
  if (Math.random() < 1 / 64) {
    _maybeRotate();
  }

  return stamped;
}

function _readAllLines() {
  const p = getHistoryPath();
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf8');
  if (!raw) return [];
  return raw.split('\n').filter((l) => l.length > 0);
}

function _maybeRotate() {
  const lines = _readAllLines();
  if (lines.length <= MAX_ENTRIES) return;
  const keep = lines.slice(lines.length - MAX_ENTRIES);
  fs.writeFileSync(getHistoryPath(), keep.join('\n') + '\n', 'utf8');
}

function loadLast(n = LOAD_DEFAULT) {
  const lines = _readAllLines();
  const tail = lines.slice(Math.max(0, lines.length - n));
  const out = [];
  for (const line of tail) {
    try {
      out.push(JSON.parse(line));
    } catch (_e) {
      // Skip malformed lines (e.g. from a partial write or external edit)
    }
  }
  return out;
}

function clear() {
  const p = getHistoryPath();
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
  }
}

function size() {
  return _readAllLines().length;
}

module.exports = {
  appendEntry,
  loadLast,
  clear,
  size,
  getHistoryPath,
  MAX_ENTRIES,
  LOAD_DEFAULT,
  // test-only
  _setHistoryPath,
  _resetHistoryPath,
};
