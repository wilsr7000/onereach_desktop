/**
 * Relay Core — the pure decision brain shared by every I/O relay agent
 * (Voice Relay, Chat Agent, Modal Agent).
 *
 * See docs/internal/ORB-EXCHANGE-AGENTS.md. The relay agents are thin: they own
 * a transport (mic/TTS, chat DOM, modal window) and delegate every *decision* to
 * these two pure functions, so the branching is testable without Electron.
 *
 *   classifyInbound({ source, text, interaction, awaitingAgentId })
 *       -> submission descriptor: should we post a task, with what text, and with
 *          what correlation (targetAgentId) so a modal choice or followup answer
 *          returns to the agent that asked. This is the ONE place a modal UI
 *          interaction becomes a text utterance.
 *
 *   planOutbound(normalizedResult, { voiceMode })
 *       -> channel plan { speak, chat, modal, listenAfter }: which of the three
 *          output channels to drive for an already-normalized agent result, and
 *          whether to re-open the mic (a followup question).
 *
 * NO side effects, NO I/O, NO Electron. planOutbound expects a result already
 * run through lib/agent-result-normalize.js — it does not re-normalize.
 */

'use strict';

(function () {
  // ---- helpers -------------------------------------------------------------

  function firstNonEmpty(...vals) {
    for (const v of vals) {
      if (typeof v === 'string' && v.trim()) return v;
    }
    return '';
  }

  // ---- inbound: user I/O event -> task submission descriptor ---------------

  /**
   * @param {object} evt
   * @param {'voice'|'text'|'modal'} evt.source
   * @param {string}  [evt.text]         raw transcript / typed text (voice, text)
   * @param {object}  [evt.interaction]  modal UI event { value, label, field, agentId, options }
   * @param {string}  [evt.awaitingAgentId]  an agent is waiting on a followup answer
   * @returns {{
   *   submit: boolean,
   *   text: string,
   *   kind: 'utterance'|'followup'|'modal-choice'|'noop',
   *   correlation: { targetAgentId?: string, field?: string }
   * }}
   */
  function classifyInbound(evt) {
    const source = evt && evt.source;

    // Modal interaction: a click/submit inside an agent's UI. Convert it to text
    // and correlate back to the agent that rendered the modal so the answer
    // resumes THAT task (never a fresh auction).
    if (source === 'modal') {
      const it = (evt && evt.interaction) || {};
      // Prefer the machine value; fall back to the human label. A form field may
      // carry an empty value legitimately only if a label exists.
      const text = firstNonEmpty(it.value, it.label);
      if (!text) {
        return { submit: false, text: '', kind: 'noop', correlation: {} };
      }
      const correlation = {};
      if (it.agentId) correlation.targetAgentId = it.agentId;
      if (it.field) correlation.field = it.field;
      return { submit: true, text, kind: 'modal-choice', correlation };
    }

    // Voice / text utterance.
    const text = firstNonEmpty(evt && evt.text);
    if (!text) {
      return { submit: false, text: '', kind: 'noop', correlation: {} };
    }
    // If an agent is awaiting a followup, correlate this utterance to it so the
    // exchange routes it to that agent instead of re-auctioning.
    if (evt && evt.awaitingAgentId) {
      return {
        submit: true,
        text,
        kind: 'followup',
        correlation: { targetAgentId: evt.awaitingAgentId },
      };
    }
    return { submit: true, text, kind: 'utterance', correlation: {} };
  }

  // ---- outbound: normalized result -> channel plan -------------------------

  /**
   * @param {object} r  a result already run through normalizeAgentResult
   *   { success, message, spokenSummary, visualText, html, ui, displayMode,
   *     panelWidth, panelHeight, needsInput }
   * @param {object} [opts]
   * @param {boolean} [opts.voiceMode=true]  is the voice channel active
   * @returns {{
   *   speak:  { text: string } | null,
   *   chat:   { role: 'assistant', text: string, cardHtml: string|null } | null,
   *   modal:  { html: string, width: number|null, height: number|null, agentId: string|null } | null,
   *   listenAfter: boolean
   * }}
   */
  function planOutbound(r, opts) {
    const result = r || {};
    const voiceMode = !opts || opts.voiceMode !== false;

    // A followup question: prompt text drives every channel, and the mic re-opens.
    const needsInput = result.needsInput || null;
    const promptText = needsInput
      ? firstNonEmpty(needsInput.prompt, result.spokenSummary, result.visualText, result.message)
      : '';

    // Spoken channel: only when voice is active and there is something to say.
    let speak = null;
    if (voiceMode) {
      const spoken = needsInput
        ? promptText
        : firstNonEmpty(result.spokenSummary, result.message);
      if (spoken) speak = { text: spoken };
    }

    // Chat channel: the visible transcript. Followup prompts are shown too so the
    // text history stays in sync with what was spoken (UC1/UC3).
    let chat = null;
    const chatText = needsInput
      ? promptText
      : firstNonEmpty(result.visualText, result.message);
    if (chatText) {
      chat = {
        role: 'assistant',
        text: chatText,
        // An inline card rides in chat; a modal card does not (it gets its own window).
        cardHtml: result.displayMode === 'inline' && result.html ? result.html : null,
      };
    }

    // Modal channel: a dedicated window for rich/large UI.
    let modal = null;
    if (result.displayMode === 'modal' && result.html) {
      modal = {
        html: result.html,
        width: typeof result.panelWidth === 'number' ? result.panelWidth : null,
        height: typeof result.panelHeight === 'number' ? result.panelHeight : null,
        agentId: result.agentId || (needsInput && needsInput.agentId) || null,
      };
    }

    return { speak, chat, modal, listenAfter: !!needsInput };
  }

  const api = { classifyInbound, planOutbound };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.RelayCore = api;
  }
})();
