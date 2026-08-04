/**
 * Manage Events app - the visual surface for the events agent.
 *
 * Renders the full app HTML shown in the agent-UI modal whenever the events
 * agent is invoked. Interactions ride the existing bidirectional modal
 * contract (agent-ui-modal.html): form submits and [data-value] clicks are
 * relayed back through agent-ui:submit-input -> the events agent, so "add"
 * typed in the app and "add" spoken to the orb take the same path.
 *
 * Self-contained dark UI. Dark scrollbars are mandatory in dark surfaces
 * (never ship a default white scrollbar on a dark body).
 */

'use strict';

const APP_PANEL = Object.freeze({ width: 480, height: 620 });

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const RECURRENCE_BADGE = {
  daily: 'daily',
  weekly: 'weekly',
  monthly: 'monthly',
};

/**
 * Render the app.
 * @param {Array<{event: Object, at: Date, when: string}>} upcomingList - from events-store.nextEvents
 * @param {Object} [opts] - { notice } transient status line (e.g. "Added ✓")
 * @returns {string} HTML
 */
function renderEventsApp(upcomingList = [], opts = {}) {
  const rows = upcomingList.length
    ? upcomingList
        .map(({ event, when }) => {
          const badge = RECURRENCE_BADGE[event.recurrence]
            ? `<span class="badge">${RECURRENCE_BADGE[event.recurrence]}</span>`
            : '';
          return `
        <div class="event-row">
          <div class="event-main">
            <div class="event-title">${_esc(event.title)}${badge}</div>
            <div class="event-when">${_esc(when)}</div>
          </div>
          <button class="event-delete" data-value="delete the event ${_esc(event.title)} (id ${_esc(event.id)})" title="Delete">✕</button>
        </div>`;
        })
        .join('\n')
    : '<div class="empty">No upcoming events. Add one below or just tell me one.</div>';

  const notice = opts.notice ? `<div class="notice">${_esc(opts.notice)}</div>` : '';

  return `
<div class="events-app">
  <style>
    .events-app {
      background: #101216; color: #e6e8ee;
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      border-radius: 10px; padding: 16px; height: 100%; box-sizing: border-box;
      display: flex; flex-direction: column; gap: 12px;
    }
    /* Dark scrollbars — never a white scrollbar on a dark body */
    .events-app * { scrollbar-color: #3a3f4b #16181d; scrollbar-width: thin; }
    .events-app *::-webkit-scrollbar { width: 10px; height: 10px; }
    .events-app *::-webkit-scrollbar-track { background: #16181d; }
    .events-app *::-webkit-scrollbar-thumb { background: #3a3f4b; border-radius: 5px; }
    .events-app *::-webkit-scrollbar-thumb:hover { background: #4a5060; }

    .events-app h2 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: 0.2px; }
    .events-app .subtitle { color: #8b93a5; font-size: 12px; margin-top: -8px; }
    .events-app .notice {
      background: #1d2b22; color: #7ee2a8; border: 1px solid #2c4636;
      border-radius: 6px; padding: 6px 10px; font-size: 12px;
    }
    .events-app .event-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
    .events-app .event-row {
      display: flex; align-items: center; gap: 8px;
      background: #181b21; border: 1px solid #262a33; border-radius: 8px; padding: 10px 12px;
    }
    .events-app .event-main { flex: 1; min-width: 0; }
    .events-app .event-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .events-app .event-when { color: #9aa3b5; font-size: 12px; margin-top: 2px; }
    .events-app .badge {
      margin-left: 8px; font-size: 10px; font-weight: 600; text-transform: uppercase;
      color: #b7a5f7; background: #241f36; border: 1px solid #3a3357;
      padding: 1px 6px; border-radius: 999px; vertical-align: 1px;
    }
    .events-app .event-delete {
      background: none; border: none; color: #6b7385; font-size: 14px; cursor: pointer;
      padding: 4px 6px; border-radius: 6px;
    }
    .events-app .event-delete:hover { background: #2a1d20; color: #f28b9b; }
    .events-app .empty { color: #8b93a5; padding: 20px 6px; text-align: center; }
    .events-app form { display: flex; gap: 8px; }
    .events-app input[type="text"] {
      flex: 1; background: #181b21; color: #e6e8ee; border: 1px solid #2c313c;
      border-radius: 8px; padding: 9px 12px; font-size: 13px; outline: none;
    }
    .events-app input[type="text"]:focus { border-color: #5865f2; }
    .events-app button[type="submit"], .events-app .quick {
      background: #2b3245; color: #dfe3ee; border: 1px solid #3a4258;
      border-radius: 8px; padding: 9px 14px; font-size: 13px; cursor: pointer;
    }
    .events-app button[type="submit"]:hover, .events-app .quick:hover { background: #364060; }
    .events-app .quick-row { display: flex; gap: 8px; }
    .events-app .quick { flex: 1; font-size: 12px; padding: 7px 10px; }
  </style>

  <h2>Manage Events</h2>
  <div class="subtitle">One-off & recurring · synced to your graph (watch-ready)</div>
  ${notice}
  <div class="event-list">
${rows}
  </div>
  <form data-field="eventRequest">
    <input type="text" name="eventRequest" placeholder='Add: "Dentist Tuesday 3pm" or "Standup weekdays 9:30, weekly"' autocomplete="off" />
    <button type="submit">Add</button>
  </form>
  <div class="quick-row">
    <button class="quick" data-value="what's next on my calendar of events">What's next?</button>
    <button class="quick" data-value="open my events app">Refresh</button>
  </div>
</div>`;
}

module.exports = { renderEventsApp, APP_PANEL };
