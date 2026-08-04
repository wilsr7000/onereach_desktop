/**
 * Meeting Setup app - the modal surface for the Meeting Starter agent.
 *
 * Shows the draft (title, space, chosen participants) and one-click
 * suggestions. Rides the same bidirectional agent-ui modal contract as the
 * events app: [data-value] clicks and the form submit route back to the
 * agent as utterances, so click and voice stay one flow.
 *
 * Dark UI with dark scrollbars (never a white scrollbar on a dark body).
 */

'use strict';

const SETUP_PANEL = Object.freeze({ width: 460, height: 600 });

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {Object} draft - { title, spaceName, participants: [{name,email}] }
 * @param {Array<{name, email}>} suggestions - from participants.suggestParticipants
 * @param {Object} [opts] - { notice }
 * @returns {string} HTML
 */
function renderMeetingSetup(draft = {}, suggestions = [], opts = {}) {
  const chosen = draft.participants || [];
  const chosenKeys = new Set(chosen.map((p) => p.name.toLowerCase()));
  const remaining = suggestions.filter((s) => !chosenKeys.has(String(s.name).toLowerCase()));

  const chosenRows = chosen.length
    ? chosen
        .map(
          (p) => `
      <span class="chip chosen">
        ${_esc(p.name)}
        <button class="chip-x" data-value="remove ${_esc(p.name)} from the meeting" title="Remove">✕</button>
      </span>`
        )
        .join('\n')
    : '<div class="empty">No one yet — tap a suggestion or say "add Erika".</div>';

  const suggestionRows = remaining.length
    ? remaining
        .map(
          (s) => `
      <button class="chip suggest" data-value="add ${_esc(s.name)} to the meeting">＋ ${_esc(s.name)}</button>`
        )
        .join('\n')
    : '<div class="empty">No more suggestions.</div>';

  const notice = opts.notice ? `<div class="notice">${_esc(opts.notice)}</div>` : '';

  return `
<div class="meeting-setup">
  <style>
    .meeting-setup {
      background: #101216; color: #e6e8ee;
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      border-radius: 10px; padding: 16px; height: 100%; box-sizing: border-box;
      display: flex; flex-direction: column; gap: 12px;
    }
    /* Dark scrollbars — mandatory on dark surfaces */
    .meeting-setup * { scrollbar-color: #3a3f4b #16181d; scrollbar-width: thin; }
    .meeting-setup *::-webkit-scrollbar { width: 10px; height: 10px; }
    .meeting-setup *::-webkit-scrollbar-track { background: #16181d; }
    .meeting-setup *::-webkit-scrollbar-thumb { background: #3a3f4b; border-radius: 5px; }
    .meeting-setup *::-webkit-scrollbar-thumb:hover { background: #4a5060; }

    .meeting-setup h2 { margin: 0; font-size: 16px; font-weight: 600; }
    .meeting-setup .meta { color: #9aa3b5; font-size: 12px; }
    .meeting-setup .meta b { color: #cfd5e2; font-weight: 600; }
    .meeting-setup .notice {
      background: #1d2b22; color: #7ee2a8; border: 1px solid #2c4636;
      border-radius: 6px; padding: 6px 10px; font-size: 12px;
    }
    .meeting-setup .section { font-size: 11px; text-transform: uppercase; letter-spacing: 0.6px; color: #6b7385; margin-top: 2px; }
    .meeting-setup .chips { display: flex; flex-wrap: wrap; gap: 8px; overflow-y: auto; }
    .meeting-setup .chip {
      display: inline-flex; align-items: center; gap: 6px;
      border-radius: 999px; padding: 6px 12px; font-size: 13px; border: 1px solid #3a4258;
    }
    .meeting-setup .chip.chosen { background: #23304d; color: #dfe7ff; }
    .meeting-setup .chip.suggest { background: #181b21; color: #b9c1d4; cursor: pointer; border-style: dashed; }
    .meeting-setup .chip.suggest:hover { background: #212633; color: #e6e8ee; }
    .meeting-setup .chip-x { background: none; border: none; color: #8b93a5; cursor: pointer; font-size: 12px; padding: 0 2px; }
    .meeting-setup .chip-x:hover { color: #f28b9b; }
    .meeting-setup .empty { color: #6b7385; font-size: 12px; padding: 4px 2px; }
    .meeting-setup form { display: flex; gap: 8px; }
    .meeting-setup input[type="text"] {
      flex: 1; background: #181b21; color: #e6e8ee; border: 1px solid #2c313c;
      border-radius: 8px; padding: 9px 12px; font-size: 13px; outline: none;
    }
    .meeting-setup input[type="text"]:focus { border-color: #5865f2; }
    .meeting-setup .start {
      background: #2e7d4f; color: #eafff2; border: 1px solid #3a9c64;
      border-radius: 10px; padding: 12px; font-size: 15px; font-weight: 600; cursor: pointer;
    }
    .meeting-setup .start:hover { background: #35935c; }
    .meeting-setup button[type="submit"] {
      background: #2b3245; color: #dfe3ee; border: 1px solid #3a4258;
      border-radius: 8px; padding: 9px 14px; font-size: 13px; cursor: pointer;
    }
  </style>

  <h2>Start a Meeting</h2>
  <div class="meta"><b>${_esc(draft.title || 'Meeting')}</b> · Space: <b>${_esc(draft.spaceName || 'Meetings')}</b></div>
  ${notice}

  <div class="section">In the room</div>
  <div class="chips">
${chosenRows}
  </div>

  <div class="section">Suggested</div>
  <div class="chips">
${suggestionRows}
  </div>

  <form data-field="meetingRequest">
    <input type="text" name="meetingRequest" placeholder='e.g. "call it design sync" · "use the Product space" · "add Jonas"' autocomplete="off" />
    <button type="submit">Apply</button>
  </form>

  <button class="start" data-value="start the meeting now">▶ Start meeting</button>
</div>`;
}

module.exports = { renderMeetingSetup, SETUP_PANEL };
