/**
 * Marshal an agent result into the WebSocket `task_result` payload.
 *
 * The exchange delivers an agent's result to the settled handler over a WS hop.
 * The payload MUST carry the rich dual-channel + UI fields, not just
 * message/html. Dropping ui/displayMode/panelWidth/panelHeight/spokenSummary/
 * visualText/soundCue is exactly why a dayView/modal agent (daily-brief) lost
 * its panel over that hop: the settled handler then saw no `ui`, normalized to
 * `inline`, the modal never popped, and voice==chat.
 *
 * `output` is computed per-call by the caller (needsInput.prompt vs message),
 * so it's passed in rather than derived here.
 *
 * @param {object} result  the agent's raw result
 * @param {string} output  the resolved user-facing output text
 * @returns {object} the task_result.result payload
 */
'use strict';

function marshalTaskResult(result, output) {
  const r = result || {};
  return {
    success: r.success,
    output,
    data: r.data,
    html: r.html,
    ui: r.ui,
    displayMode: r.displayMode,
    panelWidth: r.panelWidth,
    panelHeight: r.panelHeight,
    spokenSummary: r.spokenSummary,
    visualText: r.visualText,
    soundCue: r.soundCue,
    error: r.success ? undefined : r.error,
    needsInput: r.needsInput,
  };
}

module.exports = { marshalTaskResult };
