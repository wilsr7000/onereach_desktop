'use strict';

/**
 * agent-result-normalize -- dual-channel agent contract shim
 *
 * Today every agent returns a single `message` string used for both
 * TTS and on-screen rendering. The new contract splits that into two
 * channels because reading bandwidth >> listening bandwidth:
 *
 *   - spokenSummary -- short, voiced via TTS for voice-in turns
 *   - visualText    -- richer, rendered in the orb chat scroll
 *   - ui / html     -- optional micro-UI (declarative spec or pre-rendered)
 *   - displayMode   -- 'inline' (chat card) | 'modal' (own window)
 *                       | undefined (auto: size-based heuristic)
 *
 * normalizeAgentResult(result) is the migration shim. Legacy agents
 * that only set `message` keep working unchanged: spokenSummary and
 * visualText both fall back to message, so spoken == visual (which is
 * exactly Scenario 3 in the design plan -- the simple-interaction case).
 *
 * New / migrated agents set spokenSummary + visualText explicitly to
 * unlock Scenarios 1 and 2 (different content for ear vs eye).
 *
 * displayMode heuristic:
 *   - explicit result.displayMode wins
 *   - panelWidth >= 400 OR panelHeight >= 300  -> 'modal'
 *   - has html or ui (any size)                -> 'inline'
 *   - text-only                                 -> null (chat-only)
 *
 * The function is pure -- no side effects, no Electron dependencies --
 * so it can be unit-tested in isolation and reused by the
 * agent-ui-modal-window manager (Phase 2) without coupling.
 */

const MODAL_MIN_WIDTH = 400;
const MODAL_MIN_HEIGHT = 300;

function normalizeAgentResult(result) {
  if (!result || typeof result !== 'object') {
    return {
      success: false,
      spokenSummary: '',
      visualText: '',
      displayMode: null,
      ui: null,
      html: null,
      panelWidth: null,
      panelHeight: null,
      data: null,
    };
  }

  const message = typeof result.message === 'string' ? result.message : '';
  const spokenSummary =
    typeof result.spokenSummary === 'string' && result.spokenSummary.length > 0
      ? result.spokenSummary
      : message;
  const visualText =
    typeof result.visualText === 'string' && result.visualText.length > 0
      ? result.visualText
      : message;

  const html = typeof result.html === 'string' && result.html.length > 0 ? result.html : null;
  const ui = result.ui != null ? result.ui : null;
  const panelWidth = typeof result.panelWidth === 'number' && result.panelWidth > 0 ? result.panelWidth : null;
  const panelHeight =
    typeof result.panelHeight === 'number' && result.panelHeight > 0 ? result.panelHeight : null;

  let displayMode = null;
  if (result.displayMode === 'inline' || result.displayMode === 'modal') {
    displayMode = result.displayMode;
  } else if ((panelWidth && panelWidth >= MODAL_MIN_WIDTH) || (panelHeight && panelHeight >= MODAL_MIN_HEIGHT)) {
    displayMode = 'modal';
  } else if (html || ui) {
    displayMode = 'inline';
  }

  return {
    ...result,
    success: result.success !== false,
    spokenSummary,
    visualText,
    displayMode,
    ui,
    html,
    panelWidth,
    panelHeight,
    data: result.data != null ? result.data : null,
  };
}

module.exports = {
  normalizeAgentResult,
  MODAL_MIN_WIDTH,
  MODAL_MIN_HEIGHT,
};
