/**
 * Surface Policy - guarantees a rich result is shown on a surface the user
 * can actually see.
 *
 * The bug this kills (2026-08 "no visual window opened"): the daily brief's
 * dayView spec failed, the agent degraded to a ui/html result with NO explicit
 * displayMode and NO panel sizes, and the normalize heuristic ("html any size
 * -> inline") routed a rich panel to the orb chat card -- which is invisible
 * unless the chat is expanded. A voice-in user is not looking at chat: the
 * spoken summary said "brief on screen" while no window ever opened.
 *
 * Policy (pure function, applied at the task:settled surface decision):
 *   - An agent's EXPLICIT displayMode is always honored (explicit 'inline'
 *     means "small ack card, speech carries the content" -- fine to miss).
 *   - A DERIVED 'inline' for a voice-in task that carries html is escalated
 *     to 'modal' with default panel sizing, so the content pops a real
 *     window. Text-in tasks keep 'inline' -- the user is already looking at
 *     the chat surface they typed into.
 */

'use strict';

const DEFAULT_PANEL_WIDTH = 480;
const DEFAULT_PANEL_HEIGHT = 600;

/**
 * Decide the final surface for a settled task.
 *
 * @param {Object} f
 * @param {string|null} f.explicitDisplayMode - result.displayMode as returned
 *   by the agent ('inline' | 'modal' | anything else = not explicit)
 * @param {string|null} f.displayMode - normalize's derived displayMode
 * @param {boolean} f.hasHtml - normalized result carries html to show
 * @param {string} f.inputModality - 'voice' | 'text'
 * @param {number|null} [f.panelWidth]
 * @param {number|null} [f.panelHeight]
 * @returns {{ mode: string|null, escalated: boolean, panelWidth: number|null,
 *   panelHeight: number|null }}
 */
function resolveSurface(f = {}) {
  const explicit = f.explicitDisplayMode === 'inline' || f.explicitDisplayMode === 'modal';
  const out = {
    mode: f.displayMode || null,
    escalated: false,
    panelWidth: f.panelWidth ?? null,
    panelHeight: f.panelHeight ?? null,
  };

  if (explicit) {
    out.mode = f.explicitDisplayMode;
    return out;
  }

  const voiceIn = (f.inputModality || 'voice') === 'voice';
  if (out.mode === 'inline' && f.hasHtml && voiceIn) {
    out.mode = 'modal';
    out.escalated = true;
    if (!out.panelWidth) out.panelWidth = DEFAULT_PANEL_WIDTH;
    if (!out.panelHeight) out.panelHeight = DEFAULT_PANEL_HEIGHT;
  }
  return out;
}

module.exports = { resolveSurface, DEFAULT_PANEL_WIDTH, DEFAULT_PANEL_HEIGHT };
