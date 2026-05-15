'use strict';

/**
 * voice-task-push -- proactive agent alerts through the unified pipeline
 *
 * Phase 6 of Orb Unified UX redesign. Agents that need to push proactive
 * content to the user (critical-meeting alarms, scheduled briefs,
 * monitoring agents that detect issues, etc.) call:
 *
 *   const { pushProactiveAlert } = require('./lib/voice-task-push');
 *   pushProactiveAlert({
 *     agentId: 'critical-meeting-alarm',
 *     agentName: 'Critical Meeting Alarm',
 *     spokenSummary: 'Sales sync starts in two minutes.',
 *     visualText: 'Sales sync (with Acme) starts in 2 minutes. Room: Conference A. Link: ...',
 *     ui: { type: 'alarmCard', ... },     // optional
 *     panelWidth: 380, panelHeight: 220,
 *     soundCue: { type: 'one-shot', name: 'attention' },
 *   });
 *
 * Why this exists:
 *   Before Phase 6, proactive alerts called voice-speaker.speak() directly
 *   and sometimes pushed an HTML panel via global.sendCommandHUDResult.
 *   That meant alerts:
 *     - Spoke once and disappeared (no scrollback)
 *     - Lived outside the chat history (user had no record)
 *     - Used a separate display path from user-initiated tasks
 *
 *   Phase 6 funnels alerts through the SAME pipeline as user-initiated
 *   tasks by synthesizing a fake task + result and emitting them via
 *   the bridge. The user gets:
 *     - Chat-history entry tagged source: 'agent-proactive' with a badge
 *     - Inline card or modal per the same hybrid heuristic (Phase 2)
 *     - TTS speaks the spokenSummary (proactive overrides voice-in-only)
 *
 * The module is decoupled from the bridge to avoid a require cycle.
 * It posts an IPC `voice-task:push-proactive` event to itself in main;
 * the bridge subscribes via setProactiveListener(callback) and
 * synthesizes the task:settled handler call inside its own context.
 */

const listeners = new Set();

/**
 * Register a listener for proactive alerts. Returns an unsubscribe.
 * Used by exchange-bridge to consume alerts and run them through the
 * task:settled pipeline as a synthesized completion. Multiple listeners
 * are supported but the bridge is normally the only one.
 */
function setProactiveListener(callback) {
  if (typeof callback !== 'function') return () => {};
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function _ulid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Push a proactive alert. Returns the synthetic taskId so callers can
 * correlate downstream events.
 */
function pushProactiveAlert(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new TypeError('pushProactiveAlert requires a payload object');
  }
  if (typeof payload.agentId !== 'string' || payload.agentId.length === 0) {
    throw new RangeError('pushProactiveAlert: agentId is required');
  }
  if (
    (typeof payload.spokenSummary !== 'string' || payload.spokenSummary.length === 0) &&
    (typeof payload.visualText !== 'string' || payload.visualText.length === 0) &&
    (typeof payload.message !== 'string' || payload.message.length === 0)
  ) {
    throw new RangeError(
      'pushProactiveAlert: at least one of spokenSummary, visualText, or message must be a non-empty string'
    );
  }

  const taskId = payload.taskId || _ulid();
  const synthTask = {
    id: taskId,
    content: '<proactive>',
    agentId: payload.agentId,
    inputModality: 'voice', // proactive always speaks
    metadata: { origin: 'proactive' },
  };
  const synthResult = {
    success: true,
    spokenSummary: payload.spokenSummary || payload.message || '',
    visualText: payload.visualText || payload.message || payload.spokenSummary || '',
    ui: payload.ui || null,
    html: payload.html || null,
    panelWidth: payload.panelWidth || null,
    panelHeight: payload.panelHeight || null,
    displayMode: payload.displayMode || null,
    soundCue: payload.soundCue || null,
    data: payload.data || null,
    message: payload.message || payload.spokenSummary || payload.visualText || '',
  };

  // Fire to all listeners. If none are registered yet (e.g. bridge not
  // initialized), the alert is silently dropped -- matches today's
  // behavior where alerts during early boot also disappear.
  for (const cb of listeners) {
    try {
      cb({ task: synthTask, result: synthResult, agentId: payload.agentId });
    } catch (err) {
      // Best-effort: don't let one bad listener break the rest.
      // eslint-disable-next-line no-console
      console.warn('[voice-task-push] listener threw:', err?.message || err);
    }
  }

  return taskId;
}

function _clearListeners() {
  listeners.clear();
}

function _getListenerCount() {
  return listeners.size;
}

module.exports = {
  pushProactiveAlert,
  setProactiveListener,
  // Test seams
  _clearListeners,
  _getListenerCount,
};
