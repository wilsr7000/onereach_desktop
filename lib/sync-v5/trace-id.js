/**
 * Trace IDs (ULID) for v5 sync observability
 *
 * Every op gets a ULID `traceId` at write time. The ID flows through:
 *   - local op queue row
 *   - GSX Files upload (X-Trace-Id header)
 *   - :OperationLog.traceId in Neo4j
 *   - :Heartbeat.ackedTraceIds[] when the device confirms
 *
 * Diagnosing "which device's write got lost?" is then a single Cypher query.
 *
 * ULID rationale (vs UUID v4): lex-sortable by creation time. Two trace IDs
 * compared as strings tell you which came first. Useful for log analysis and
 * for ordering sequence-diagram views in the diagnostics panel.
 *
 * Implementation: Crockford base32 (excludes I, L, O, U). 48 bits of millis
 * timestamp (10 chars) + 80 bits of randomness (16 chars) = 26 chars total.
 * Spec: https://github.com/ulid/spec
 *
 * No external dependency: implementing in ~30 lines is more reliable than
 * pulling a package for foundational infrastructure.
 */

'use strict';

const crypto = require('crypto');

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32, no I L O U
const TIME_LEN = 10;
const RANDOM_LEN = 16;

const TRACE_ID_HEADER = 'X-Trace-Id';
const TRACE_ID_PATTERN = new RegExp(`^[${ENCODING}]{26}$`);

/**
 * Generate a new ULID-format trace ID.
 *
 * @param {number} [now=Date.now()] -- override timestamp (test only)
 * @param {Buffer} [randomBytes]    -- override randomness (test only)
 * @returns {string} 26-char Crockford base32
 */
function newTraceId(now, randomBytes) {
  const ts = typeof now === 'number' ? now : Date.now();
  if (ts < 0 || ts > 0xffffffffffff) {
    throw new RangeError(`ULID timestamp out of range: ${ts}`);
  }

  const bytes = randomBytes || crypto.randomBytes(10);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 10) {
    throw new Error('ULID random bytes must be a 10-byte Buffer');
  }

  return _encodeTime(ts) + _encodeRandom(bytes);
}

/**
 * Validate that a string is a well-formed ULID.
 * @param {string} id
 * @returns {boolean}
 */
function isValidTraceId(id) {
  return typeof id === 'string' && TRACE_ID_PATTERN.test(id);
}

/**
 * Extract the timestamp embedded in a ULID, in milliseconds since epoch.
 * Useful for "ops within the last hour" queries on the device side without
 * a separate timestamp column.
 *
 * @param {string} id
 * @returns {number} ms since epoch
 * @throws if id is not a valid ULID
 */
function timestampFromTraceId(id) {
  if (!isValidTraceId(id)) {
    throw new Error(`Invalid trace ID: ${id}`);
  }
  let ts = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    const ch = id[i];
    const v = ENCODING.indexOf(ch);
    if (v === -1) {
      throw new Error(`Invalid character in ULID timestamp segment: ${ch}`);
    }
    ts = ts * 32 + v;
  }
  return ts;
}

/**
 * Build an HTTP header object carrying the trace ID. Used for blob uploads
 * to GSX Files so the server-side log can be correlated with the device-side
 * operation.
 *
 * @param {string} traceId
 * @returns {{ 'X-Trace-Id': string }}
 */
function traceHeader(traceId) {
  if (!isValidTraceId(traceId)) {
    throw new Error(`Invalid trace ID: ${traceId}`);
  }
  return { [TRACE_ID_HEADER]: traceId };
}

// ────────────────────────────────────────────────────────────────────────────
// Internal: Crockford base32 encoders
// ────────────────────────────────────────────────────────────────────────────

function _encodeTime(ts) {
  let out = '';
  let n = ts;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const r = n % 32;
    out = ENCODING[r] + out;
    n = Math.floor(n / 32);
  }
  return out;
}

function _encodeRandom(bytes) {
  // 80 bits = 16 chars of base32. We unpack 5-bit groups MSB-first from a
  // bigint to avoid floating-point drift on 80-bit integers.
  let n = 0n;
  for (const b of bytes) {
    n = (n << 8n) | BigInt(b);
  }
  let out = '';
  for (let i = 0; i < RANDOM_LEN; i++) {
    const r = Number(n & 31n);
    out = ENCODING[r] + out;
    n >>= 5n;
  }
  return out;
}

module.exports = {
  newTraceId,
  isValidTraceId,
  timestampFromTraceId,
  traceHeader,
  TRACE_ID_HEADER,
  TRACE_ID_PATTERN,
  // Test-only:
  _encodeTime,
  _encodeRandom,
};
