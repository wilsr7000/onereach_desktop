/**
 * Delivery Eval - end-of-turn verdict on whether the user actually RECEIVED
 * the answer to a voice request.
 *
 * The gap this closes: the pipeline can "succeed" internally (auction won,
 * brief composed, TTS generated, task settled) while the user hears/sees
 * nothing -- and nothing notices. Worse, the answer-reflector can even judge
 * the answer low-quality and only write a memory note. Every failure mode of
 * the voice pipeline so far has been a SILENT one.
 *
 * This module grades each settled voice task on delivery:
 *   - delivered      : speak confirmed (speechQueue resolves true only after
 *                      the renderer acks playback complete) -- the user heard it
 *   - silent-failure : we tried to speak and playback was NOT confirmed
 *                      (timeout / dropped audio / error) -- the user got nothing
 *   - not-spoken     : voice-in task settled but TTS was never attempted
 *   - skipped-text   : text-in task, speech intentionally skipped (pass)
 *
 * Verdicts are logged to the central event manager under category 'delivery'
 * (error level for failures, so they are alarm-visible in the event log), and
 * a silent failure triggers ONE user-visible fallback: a short spoken notice
 * via voice-speaker (guarded, never recursive) plus a broadcast so UI surfaces
 * can toast it. The answer-reflector's low-quality verdict is also surfaced
 * here as a warn-level 'delivery' event instead of memory-only.
 */

'use strict';

const { getLogQueue } = require('./log-event-queue');

// Injectable for tests (vitest module mocks don't reliably intercept this
// module's CJS require chain -- same quirk as calendar-brief-merge tests).
let _deps = {
  log: getLogQueue(),
  getSpeaker: () => {
    try {
      return require('../voice-speaker').getVoiceSpeaker();
    } catch (_e) {
      return null;
    }
  },
  broadcast: (channel, payload) => {
    try {
      if (typeof global.broadcastToWindows === 'function') {
        global.broadcastToWindows(channel, payload);
      }
    } catch (_e) { /* best effort */ }
  },
};

function __setDeps(overrides) {
  _deps = { ..._deps, ...(overrides || {}) };
}

// One fallback per task, and never a fallback for a fallback.
const _fallbackSpokenFor = new Set();

/**
 * Compute the verdict for a settled task's delivery facts. Pure.
 *
 * @param {Object} f
 * @param {string} f.inputModality - 'voice' | 'text'
 * @param {string} [f.spokenSummary]
 * @param {boolean} [f.speakAttempted]
 * @param {boolean} [f.speakResult] - resolved value of speaker.speak(): true
 *   only when playback completion was confirmed.
 * @param {string} [f.error] - error message if the speak path threw
 * @returns {'delivered'|'silent-failure'|'not-spoken'|'skipped-text'}
 */
function computeVerdict(f) {
  const voiceIn = (f.inputModality || 'voice') === 'voice';
  if (!voiceIn) return 'skipped-text';
  if (!f.spokenSummary || !f.spokenSummary.trim()) return 'not-spoken';
  if (!f.speakAttempted) return 'not-spoken';
  if (f.error) return 'silent-failure';
  return f.speakResult === true ? 'delivered' : 'silent-failure';
}

/**
 * Grade a settled task's delivery and act on the verdict. Called from the
 * exchange-bridge task:settled speak path (all branches). Never throws.
 *
 * @param {Object} facts - { taskId, agentId, inputModality, spokenSummary,
 *   hasPanel, speakAttempted, speakResult, speakMs, error }
 * @returns {string} the verdict
 */
function evaluateDelivery(facts = {}) {
  let verdict = 'silent-failure';
  try {
    verdict = computeVerdict(facts);
    const data = {
      event: 'delivery:verdict',
      verdict,
      taskId: facts.taskId,
      agentId: facts.agentId,
      inputModality: facts.inputModality,
      hasPanel: !!facts.hasPanel,
      speakAttempted: !!facts.speakAttempted,
      speakResult: facts.speakResult === true,
      speakMs: facts.speakMs ?? null,
      spokenPreview: (facts.spokenSummary || '').slice(0, 60),
      error: facts.error || null,
    };

    if (verdict === 'delivered' || verdict === 'skipped-text') {
      _deps.log.info('delivery', `Delivery verdict: ${verdict}`, data);
      return verdict;
    }

    // Failure: make it LOUD (error-level, alarm-visible in the event log)...
    _deps.log.error('delivery', `Delivery verdict: ${verdict} — user did not receive the answer`, data);

    // ...visible to UI surfaces (chat/orb can toast it)...
    _deps.broadcast('voice-task:delivery-failed', {
      taskId: facts.taskId,
      agentId: facts.agentId,
      verdict,
      spokenSummary: facts.spokenSummary || '',
    });

    // ...and audible, once. If TTS itself is what broke, this may also fail --
    // that outcome is logged but NEVER re-graded (no recursion).
    if (facts.taskId && !_fallbackSpokenFor.has(facts.taskId)) {
      _fallbackSpokenFor.add(facts.taskId);
      if (_fallbackSpokenFor.size > 200) _fallbackSpokenFor.clear(); // bound memory
      const speaker = _deps.getSpeaker();
      if (speaker && typeof speaker.speak === 'function') {
        Promise.resolve(
          speaker.speak(
            "Sorry — I finished your request but couldn't deliver the answer. It's in the chat panel.",
            { taskResult: true, skipAffectMatching: true }
          )
        )
          .then((ok) =>
            _deps.log[ok ? 'info' : 'error']('delivery', 'Delivery-failure fallback speech ' + (ok ? 'played' : 'ALSO failed'), {
              event: 'delivery:fallback',
              taskId: facts.taskId,
              ok: !!ok,
            })
          )
          .catch((err) =>
            _deps.log.error('delivery', 'Delivery-failure fallback speech threw', {
              event: 'delivery:fallback',
              taskId: facts.taskId,
              error: err && err.message,
            })
          );
      }
    }
  } catch (err) {
    try {
      _deps.log.error('delivery', 'Delivery eval itself failed', { error: err && err.message });
    } catch (_e) { /* never break the settle path */ }
  }
  return verdict;
}

/**
 * Surface the answer-reflector's low-quality verdict in the central event log
 * (it currently only writes an agent-memory note). Subscribe once.
 *
 * @param {EventEmitter} exchangeBus
 */
let _qualitySubscribed = false;
function subscribeQualityFlags(exchangeBus) {
  if (_qualitySubscribed || !exchangeBus || typeof exchangeBus.on !== 'function') return;
  _qualitySubscribed = true;
  exchangeBus.on('learning:low-quality-answer', (evt = {}) => {
    try {
      _deps.log.warn('delivery', 'Answer judged low-quality by reflector', {
        event: 'delivery:quality-flag',
        taskId: evt.taskId,
        agentId: evt.agentId,
        score: evt.score,
        reason: (evt.reason || evt.critique || '').slice(0, 200),
      });
    } catch (_e) { /* best effort */ }
  });
}

function __resetForTests() {
  _fallbackSpokenFor.clear();
  _qualitySubscribed = false;
}

module.exports = { evaluateDelivery, computeVerdict, subscribeQualityFlags, __setDeps, __resetForTests };
