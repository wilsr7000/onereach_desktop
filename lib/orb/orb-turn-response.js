/**
 * Orb Turn Response — pure decision for what to do with a submitTask result on
 * the function-call (voice) turn.
 *
 * Extracted from orb.html's handleFunctionCallTranscript so the branching that
 * decides "silent-ack vs clarify vs needs-input vs tone vs speak" can be
 * unit-tested in isolation. NO side effects: the handler still performs the
 * actual respondToFunction / state transition / route dispatch based on the
 * returned descriptor. Behaviour mirrors the handler exactly.
 *
 * Two phases because the response route (routeResult) is side-effectful (it
 * plays tones) and must only be computed on the standard-response path:
 *   1. classifyTurnResponse(result) — route-independent branches. Returns a
 *      descriptor, or { action: 'route' } meaning "compute the route, then call
 *      classifyRoutedResponse".
 *   2. classifyRoutedResponse(result, route) — tone-only vs spoken response.
 *
 * Descriptor fields:
 *   action    'error' | 'silent-ack' | 'clarify' | 'needs-input' | 'route' | 'tone' | 'speak'
 *   ackText   string passed to respondToFunction (empty = silent ack)
 *   awaitInput / awaitAnswer  set _pendingNeedsInput (re-open mic after TTS)
 *   dwellMs   post-response dwell-listen window
 *   hasPanel  result carried an HTML panel (set hasActivePanel)
 */

'use strict';

(function () {
  function classifyTurnResponse(result) {
    if (!result || result.error) {
      return { action: 'error', error: (result && result.error) || 'Unknown error' };
    }
    // Backend already handled TTS (exchange async result, cached route, media
    // command). Silent-ack the tool slot to avoid double audio.
    if (result.suppressAIResponse) {
      return { action: 'silent-ack', ackText: '' };
    }
    // Transcript was filtered (quality gate) with a reason -> speak the message.
    if (result.needsClarification && result.filterReason) {
      return { action: 'clarify', ackText: result.message || '' };
    }
    const hasPanel = !!result.html;
    // Multi-turn: agent needs more input (incl. NormalizeIntent clarification).
    if (result.needsInput || (result.needsClarification && !result.filterReason)) {
      const prompt =
        result.message || (result.needsInput && result.needsInput.prompt) || 'What would you like?';
      return { action: 'needs-input', ackText: prompt, awaitInput: true, hasPanel };
    }
    return { action: 'route', hasPanel };
  }

  function classifyRoutedResponse(result, route) {
    const awaitAnswer = !!(route && route.awaitAnswer);
    const dwellMs = route && typeof route.dwellMs === 'number' ? route.dwellMs : 0;
    if (route && (route.mode === 'tone' || route.mode === 'tone+visual')) {
      return { action: 'tone', ackText: '', awaitAnswer, dwellMs };
    }
    // route.speech takes precedence over the raw message, then a safe default.
    const ackText = (route && route.speech) || (result && result.message) || "I'm not sure how to help with that.";
    return { action: 'speak', ackText, awaitAnswer, dwellMs };
  }

  const api = { classifyTurnResponse, classifyRoutedResponse };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.OrbTurnResponse = api;
  }
})();
