/**
 * NEON read client -- a read-only transport to the shared graph for the
 * daily-brief contributors (tasks, tickets).
 *
 * Why not omnigraph-client: that client refuses to run until a Neo4j
 * password is configured locally (isReady() is false on every install that
 * never pasted Aura credentials -- the 2026-09-15 log shows "OmniGraph
 * client not ready (Neo4j unconfigured?)" on every heartbeat). The neon2
 * proxy has held the graph credential server-side since 2026-08-17
 * (ADR-070), so a READ needs no local secret at all. This module therefore
 * sends no password, ever, and is deliberately read-only: it refuses any
 * statement that carries a write keyword.
 *
 * NEON access standard (ADR-070): every statement wears a caller tag as
 * line 1, visible verbatim in SHOW TRANSACTIONS. Tag: onereach-desktop-brief.
 *
 * Failure contract: throws on HTTP/network/proxy errors; returns [] when the
 * graph answers with no rows. Callers decide what a missing section says.
 */

'use strict';

const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

const CALLER_TAG = 'onereach-desktop-brief';
const DEFAULT_ACCOUNT_ID = '35254342-4a2e-475b-aec1-18547e517e29';
const DEFAULT_ENDPOINT = `https://em.edison.api.onereach.ai/http/${DEFAULT_ACCOUNT_ID}/omnidata/neon2`;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_CYPHER_LENGTH = 20_000;

// Write keywords, plus CALL outright: the brief needs no procedures, and
// apoc.* / db.* procedures can write through a string argument.
const WRITE_KEYWORD_RE = /\b(CREATE|MERGE|SET|DELETE|REMOVE|DROP|DETACH|FOREACH|LOAD|CALL)\b/i;

/**
 * Reduce a statement to its structural tokens: comments go first (a quote
 * inside a comment must not open a "string" that swallows a keyword), then
 * backtick identifiers, then string literals. Each removed span is replaced
 * by a space so tokens on either side stay separate.
 */
function bareCypher(cypher) {
  return String(cypher)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:[^`]|``)*`/g, ' `id` ')
    .replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, " '' ");
}

/** True when the statement carries no write keyword (and no CALL) outside comments, identifiers and strings. */
function isReadOnlyCypher(cypher) {
  if (typeof cypher !== 'string' || !cypher.trim()) return false;
  const bare = bareCypher(cypher);
  // An unterminated quote or backtick means the tokenizer could not see the
  // whole statement; refuse rather than guess.
  if (/['"`]/.test(bare.replace(/ `id` | '' /g, ' '))) return false;
  return !WRITE_KEYWORD_RE.test(bare);
}

function resolveEndpoint(override) {
  if (override) return override;
  try {
    const sm = global.settingsManager;
    const fromSettings = sm && typeof sm.get === 'function' ? sm.get('neonReadEndpoint') : null;
    if (typeof fromSettings === 'string' && /^https:\/\//.test(fromSettings)) return fromSettings;
  } catch (_) {
    /* settings optional */
  }
  return DEFAULT_ENDPOINT;
}

/** Accept the proxy's several result shapes; throw on an error body. */
function extractRecords(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  if (body.error) throw new Error(`neon proxy error: ${typeof body.error === 'string' ? body.error : JSON.stringify(body.error).slice(0, 200)}`);
  if (body.result && typeof body.result === 'object') {
    if (body.result.status && body.result.status !== 'ok') {
      throw new Error(`neon proxy status ${body.result.status}: ${String(body.result.error || body.result.message || '').slice(0, 200)}`);
    }
    if (Array.isArray(body.result.records)) return body.result.records;
    if (Array.isArray(body.result)) return body.result;
  }
  if (Array.isArray(body.records)) return body.records;
  return [];
}

/**
 * Run one read-only Cypher statement against NEON.
 *
 * @param {string} cypher
 * @param {Object} [parameters]
 * @param {Object} [opts]
 * @param {Function} [opts.fetchImpl] - test seam (defaults to global fetch)
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.endpoint]
 * @param {string} [opts.caller] - caller tag override
 * @returns {Promise<Array<Object>>} records keyed by RETURN alias
 */
async function neonRead(cypher, parameters = {}, opts = {}) {
  if (typeof cypher !== 'string' || cypher.length === 0) throw new Error('neonRead: cypher is required');
  if (cypher.length > MAX_CYPHER_LENGTH) throw new Error('neonRead: cypher too long');
  if (!isReadOnlyCypher(cypher)) throw new Error('neonRead: refusing a statement with a write keyword');
  if (parameters && (typeof parameters !== 'object' || Array.isArray(parameters))) {
    throw new Error('neonRead: parameters must be a plain object');
  }

  const tagged = cypher.startsWith('/* caller:') ? cypher : `/* caller:${opts.caller || CALLER_TAG} */\n${cypher}`;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('neonRead: fetch is not available');
  const endpoint = resolveEndpoint(opts.endpoint);
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  const started = Date.now();
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cypher: tagged, parameters: parameters || {} }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`neon proxy HTTP ${res.status}`);
    const body = await res.json().catch(() => null);
    const records = extractRecords(body);
    log.debug('neon-read', 'Query ok', { rows: records.length, ms: Date.now() - started });
    return records;
  } catch (err) {
    const msg = err && err.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : (err && err.message) || String(err);
    log.warn('neon-read', 'Query failed', { error: msg, ms: Date.now() - started });
    throw new Error(`NEON read failed: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  neonRead,
  isReadOnlyCypher,
  extractRecords,
  CALLER_TAG,
  DEFAULT_ENDPOINT,
};
