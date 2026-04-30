/**
 * Result Consolidator (HUD Core)
 *
 * Pure transforms that shape a raw agent execution result into the
 * delivery envelope the client speaks + displays. Extracted from the
 * `task:settled` handler in `src/voice-task-sdk/exchange-bridge.js`.
 *
 * Why this lives in the core: the field-fallback rules
 * (`result.output` -> `result.data.output` -> `result.data.message`
 * -> a canned "All done") are product-wide contract. Any consumer
 * -- desktop, GSX flow, WISER Playbooks, CLI -- needs to agree on
 * which field of the agent result is the "thing to speak" so the
 * agent ecosystem stays interoperable. Same for `result.html` as
 * the panel-present signal and for the "agent-id -> display name"
 * titlecase rule.
 *
 * What stays out of this module:
 *   - TTS call (voice-speaker)
 *   - IPC broadcast (broadcastToWindows)
 *   - Response-guard / hallucination re-execution (needs the agent
 *     registry + `checkResponseSanity`)
 *   - Agent memory / stats updates
 *
 * In short: "what goes out the door" is portable. "How it goes out"
 * is host-specific.
 */

'use strict';

const DEFAULT_LEARNING_MESSAGE_MAX_LEN = 500;
const DONE_MESSAGE = 'All done';

/**
 * Defensive: treat a null / undefined / non-object result as an
 * empty object. Matches the `safeResult = result || {}` pattern
 * that appears throughout the desktop app's task:settled handler.
 *
 * @param {any} result
 * @returns {object}
 */
function normalizeResult(result) {
  if (result && typeof result === 'object') return result;
  return {};
}

/**
 * Extract the user-facing delivery message from an agent result.
 * Walks the canonical fallback chain:
 *
 *   1. result.output
 *   2. result.data.output
 *   3. result.data.message
 *   4. "All done" if result.success is truthy
 *   5. null otherwise (failure with no message -> caller handles)
 *
 * @param {any} result
 * @returns {string | null}
 */
function extractDeliveryMessage(result) {
  const r = normalizeResult(result);
  const data = r.data && typeof r.data === 'object' ? r.data : {};
  if (typeof r.output === 'string' && r.output.length > 0) return r.output;
  if (typeof data.output === 'string' && data.output.length > 0) return data.output;
  if (typeof data.message === 'string' && data.message.length > 0) return data.message;
  if (r.success) return DONE_MESSAGE;
  return null;
}

/**
 * Extract the text that the learning / observability pipeline
 * records for this interaction. Shorter than the delivery message
 * (capped to avoid blowing out logs), and tolerates results where
 * the main message lives in `.message` instead of `.output`.
 *
 *   (result.output || result.message || '').slice(0, maxLen)
 *
 * @param {any} result
 * @param {object} [opts]
 * @param {number} [opts.maxLen]   - default 500
 * @returns {string}
 */
function extractLearningMessage(result, opts = {}) {
  const r = normalizeResult(result);
  const maxLen = Number.isFinite(opts.maxLen) ? opts.maxLen : DEFAULT_LEARNING_MESSAGE_MAX_LEN;
  const raw =
    (typeof r.output === 'string' && r.output) ||
    (typeof r.message === 'string' && r.message) ||
    '';
  return raw.slice(0, maxLen);
}

/**
 * Does this result carry a graphical panel / micro-UI?
 * The desktop app uses `!!result.html` as the signal; that contract
 * is now part of the portable surface.
 *
 * @param {any} result
 * @returns {boolean}
 */
function hasPanel(result) {
  const r = normalizeResult(result);
  return Boolean(r.html);
}

/**
 * Convert an agentId ("weather-agent") to a human display name
 * ("Weather Agent"). Agents without names rendered in UI need a
 * default; the desktop app lowercases the id, replaces hyphens with
 * spaces, and titlecases every word. This function is the canonical
 * rule so the same name appears everywhere.
 *
 * @param {string} agentId
 * @returns {string}
 */
function agentIdToDisplayName(agentId) {
  if (typeof agentId !== 'string' || !agentId) return '';
  return agentId
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Build the canonical delivery envelope used for HUD emit,
 * CommandHUD display, and the voice-task:completed broadcast.
 * Callers with host-specific shapes pick the fields they need.
 *
 *   - success        boolean (defaults to true when result.success is
 *                    not explicitly false, matching the desktop's
 *                    `result?.success !== false` convention)
 *   - message        spoken / displayed text (may be null on a no-
 *                    message failure)
 *   - html           the panel markup, if any
 *   - data           raw agent data (opaque to us)
 *   - hasPanel       !!html
 *   - agentId        caller-supplied
 *   - agentName      caller-supplied OR derived from agentId
 *   - taskId         caller-supplied
 *
 * @param {any} result
 * @param {object} [context]
 * @param {string} [context.taskId]
 * @param {string} [context.agentId]
 * @param {string} [context.agentName]
 * @returns {{
 *   success: boolean,
 *   message: string | null,
 *   html: any,
 *   data: any,
 *   hasPanel: boolean,
 *   agentId: string,
 *   agentName: string,
 *   taskId: string | null,
 * }}
 */
function buildDeliveryEnvelope(result, context = {}) {
  const r = normalizeResult(result);
  const agentId = typeof context.agentId === 'string' ? context.agentId : '';
  const agentName =
    typeof context.agentName === 'string' && context.agentName
      ? context.agentName
      : agentIdToDisplayName(agentId);
  return {
    success: r.success !== false,
    message: extractDeliveryMessage(r),
    html: r.html !== undefined ? r.html : null,
    data: r.data !== undefined ? r.data : null,
    hasPanel: hasPanel(r),
    agentId,
    agentName,
    taskId: typeof context.taskId === 'string' ? context.taskId : null,
  };
}

module.exports = {
  normalizeResult,
  extractDeliveryMessage,
  extractLearningMessage,
  hasPanel,
  agentIdToDisplayName,
  buildDeliveryEnvelope,
  DEFAULT_LEARNING_MESSAGE_MAX_LEN,
  DONE_MESSAGE,
};
