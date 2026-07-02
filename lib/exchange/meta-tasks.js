/**
 * Meta-tasks — make the exchange's *meta-work* first-class tasks.
 *
 * See docs/internal/EXCHANGE-DECISIONS.md. The user-facing work already flows
 * through the exchange as an auctioned task, but the meta-work that decides HOW
 * to handle a request — classify intent, disambiguate, evaluate buildability,
 * evaluate a response — is inline privileged code. The intended architecture is
 * "almost everything is a task." This module is the two-tier model:
 *
 *   - meta-work becomes a real, recorded TASK (observable + prunable, like any
 *     other), so the moderator and traces see it and it clears when done;
 *   - but it is DIRECT-ASSIGNED to a registered meta-agent rather than
 *     competitively auctioned — no auction latency on the hot path, and no
 *     "classify the classifier" circularity (you'd need to classify a request to
 *     route a classify auction...).
 *
 * Pure and dependency-free (no Electron, no exchange). A runtime injects the now
 * clock and observability hooks, so both the runner and every handler are
 * text-testable.
 */

'use strict';

const META_TASK_KINDS = {
  CLASSIFY_INTENT: 'classify-intent',
  DISAMBIGUATE: 'disambiguate',
  EVALUATE_BUILDABILITY: 'evaluate-buildability',
  EVALUATE_RESPONSE: 'evaluate-response',
};

const KIND_SET = new Set(Object.values(META_TASK_KINDS));

const _handlers = new Map(); // kind -> async (payload, ctx) => result
const _ledger = []; // recent records, bounded
const LEDGER_MAX = 200;
let _seq = 0;

function registerMetaHandler(kind, fn) {
  if (!KIND_SET.has(kind)) {
    throw new Error(`Unknown meta-task kind: "${kind}"`);
  }
  if (typeof fn !== 'function') {
    throw new Error(`Meta-handler for "${kind}" must be a function`);
  }
  _handlers.set(kind, fn);
  return true;
}

function hasMetaHandler(kind) {
  return _handlers.has(kind);
}

function _pushLedger(record) {
  _ledger.push(record);
  if (_ledger.length > LEDGER_MAX) _ledger.splice(0, _ledger.length - LEDGER_MAX);
}

function _emit(deps, record) {
  if (deps && typeof deps.onRecord === 'function') {
    try { deps.onRecord({ ...record }); } catch (_e) { /* observability is non-fatal */ }
  }
  if (deps && typeof deps.log === 'function') {
    try {
      deps.log('info', 'meta-task', {
        kind: record.kind,
        status: record.status,
        id: record.id,
        error: record.error,
      });
    } catch (_e) { /* non-fatal */ }
  }
}

/**
 * Run a meta-task: record it, direct-assign to its handler, settle it.
 *
 * @param {string} kind    one of META_TASK_KINDS
 * @param {*} payload      handler input (e.g. { text }, { assessment })
 * @param {object} [deps]  { now?(): number, onRecord?(record), log?(level,msg,data) }
 * @returns {Promise<{ id, kind, status: 'settled'|'failed'|'unhandled',
 *                     result: *|null, error?: string, createdAt, settledAt }>}
 *   Never throws — a missing handler or a handler error settles as
 *   'unhandled'/'failed' so callers can fall back to an inline path.
 */
async function runMetaTask(kind, payload, deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const id = `meta_${kind}_${++_seq}`;
  const record = { id, kind, status: 'assigned', createdAt: now() };
  _pushLedger(record);

  const handler = _handlers.get(kind);
  if (typeof handler !== 'function') {
    record.status = 'unhandled';
    record.error = `No meta-handler registered for "${kind}"`;
    record.settledAt = now();
    _emit(deps, record);
    return { ...record, result: null };
  }

  try {
    const result = await handler(payload, { id, kind, now });
    record.status = 'settled';
    record.settledAt = now();
    _emit(deps, record);
    return { ...record, result };
  } catch (err) {
    record.status = 'failed';
    record.error = (err && err.message) || String(err);
    record.settledAt = now();
    _emit(deps, record);
    return { ...record, result: null };
  }
}

/** Snapshot of recent meta-task records (for the moderator / diagnostics). */
function listMetaTasks() {
  return _ledger.map((r) => ({ ...r }));
}

/** Test/reset seam — clears handlers and ledger. */
function _reset() {
  _handlers.clear();
  _ledger.length = 0;
  _seq = 0;
}

module.exports = {
  META_TASK_KINDS,
  registerMetaHandler,
  hasMetaHandler,
  runMetaTask,
  listMetaTasks,
  LEDGER_MAX,
  _reset,
};
