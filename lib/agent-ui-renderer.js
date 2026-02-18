/**
 * Agent UI Renderer
 *
 * Converts declarative UI specs (from LLM agents) into HTML strings
 * compatible with the Command HUD agent UI panel system.
 *
 * Supported types:
 *   - confirm: Action buttons (proceed/cancel style)
 *   - select: Clickable option list
 *   - info: Read-only display card
 *   - eventList: Calendar/event list with importance bars, recurring icon, attendees
 *   - actionLog: List of actions with success/fail status (browser agent)
 *   - screenshot: Captioned image display (data URLs or regular URLs)
 *   - panel: Compound type -- message + optional actionLog + optional screenshot
 */

/**
 * Convert a declarative UI spec to HTML for the Command HUD.
 *
 * @param {Object} spec - UI specification from agent
 * @param {string} spec.type - "confirm" | "select" | "info" | "eventList" | "actionLog" | "screenshot" | "panel"
 * @param {string} [spec.message] - Descriptive text shown above controls
 * @param {Array}  [spec.options] - For confirm/select: { label, value, style? }
 * @param {string} [spec.title] - For eventList: header label (e.g. "Today")
 * @param {Array}  [spec.events] - For eventList: { time, title, recurring, importance, attendees, actionValue }
 * @param {Array}  [spec.actions] - For actionLog/panel: { action, url?, ref?, value?, success }
 * @param {string} [spec.screenshot] - For screenshot/panel: image URL or data URL
 * @returns {string} HTML string safe for injection into .agent-ui-card-body
 */
function renderAgentUI(spec) {
  if (!spec || !spec.type) return '';

  switch (spec.type) {
    case 'confirm': {
      const options = spec.options || [
        { label: 'Confirm', value: 'yes, confirm' },
        { label: 'Cancel', value: 'no, cancel' },
      ];
      const messageHtml = spec.message ? `<div class="hud-card"><p>${esc(spec.message)}</p></div>` : '';
      const buttonsHtml = options
        .map((o) => {
          const style = o.style || '';
          return `<button class="hud-action-btn ${esc(style)}" data-value="${esc(o.value)}">${esc(o.label)}</button>`;
        })
        .join('');
      return `${messageHtml}<div style="display:flex;gap:8px;margin-top:${spec.message ? '12' : '0'}px">${buttonsHtml}</div>`;
    }

    case 'select': {
      const options = spec.options || [];
      const messageHtml = spec.message ? `<div class="hud-card"><p>${esc(spec.message)}</p></div>` : '';
      const optionsHtml = options
        .map(
          (o, i) =>
            `<div class="hud-option-item" data-value="${esc(o.value)}">` +
            `<span class="option-number">${i + 1}</span>` +
            `<span style="font-size:13px;color:#e0e0e0">${esc(o.label)}</span>` +
            `</div>`
        )
        .join('');
      return `${messageHtml}<div style="display:flex;flex-direction:column;gap:6px;margin-top:${spec.message ? '12' : '0'}px">${optionsHtml}</div>`;
    }

    case 'info': {
      return spec.message ? `<div class="hud-card"><p>${esc(spec.message)}</p></div>` : '';
    }

    case 'eventList': {
      const events = spec.events || [];
      const title = spec.title || 'Events';

      if (events.length === 0) {
        return `<div class="hud-card"><div style="padding:8px;opacity:0.5;">No events ${esc(title.toLowerCase())}</div></div>`;
      }

      const rows = events
        .slice(0, 8)
        .map((ev) => {
          const time = esc(ev.time || '');
          const evTitle = esc(ev.title || 'Untitled');
          const importance = Math.max(1, Math.min(5, ev.importance || 1));
          const actionValue = esc(ev.actionValue || `tell me more about ${ev.title || 'this event'}`);

          // Importance bars (cellular signal style, heights 4-16px)
          const bars = Array.from({ length: 5 }, (_, i) => {
            const h = 4 + i * 3;
            const filled = i < importance;
            return `<span style="display:inline-block;width:3px;height:${h}px;margin-right:1px;border-radius:1px;background:${filled ? 'var(--accent, #4fc3f7)' : 'rgba(255,255,255,0.15)'};vertical-align:bottom;"></span>`;
          }).join('');

          // Recurring indicator (loop arrow SVG)
          const recurIcon = ev.recurring
            ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity:0.6;margin-left:4px;vertical-align:middle;"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`
            : '';

          // Attendee initials (max 3 circles + overflow count)
          let attendeeHTML = '';
          if (ev.attendees && ev.attendees.length > 0) {
            const initials = ev.attendees
              .slice(0, 3)
              .map((a) => {
                const initial = esc(a.initial || '?');
                return `<span style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:rgba(255,255,255,0.1);font-size:9px;margin-left:2px;" title="${esc(a.name || '')}">${initial}</span>`;
              })
              .join('');
            const extra =
              ev.attendees.length > 3
                ? `<span style="font-size:9px;opacity:0.5;margin-left:2px;">+${ev.attendees.length - 3}</span>`
                : '';
            attendeeHTML = `<div style="display:flex;align-items:center;margin-top:2px;">${initials}${extra}</div>`;
          }

          return `<div class="hud-option-item" data-value="${actionValue}" style="display:flex;align-items:flex-start;gap:8px;padding:6px 8px;cursor:pointer;">
  <div style="min-width:52px;font-size:11px;opacity:0.7;padding-top:2px;">${time}</div>
  <div style="flex:1;min-width:0;">
    <div style="display:flex;align-items:center;gap:4px;">
      <span style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${evTitle}</span>${recurIcon}
    </div>
    ${attendeeHTML}
  </div>
  <div style="display:flex;align-items:flex-end;gap:0;padding-top:4px;" title="Importance: ${importance}/5">${bars}</div>
</div>`;
        })
        .join('');

      const countLabel = events.length > 8 ? ` (showing 8 of ${events.length})` : '';

      return `<div class="hud-card">
  <div style="padding:6px 8px;font-size:11px;opacity:0.5;border-bottom:1px solid rgba(255,255,255,0.06);">${esc(title)}${countLabel}</div>
  ${rows}
</div>`;
    }

    case 'actionLog': {
      return _renderActionLog(spec.actions || [], spec.message);
    }

    case 'screenshot': {
      return _renderScreenshot(spec.screenshot, spec.message);
    }

    case 'panel': {
      // Compound type: message + optional action log + optional screenshot
      const parts = [];
      if (spec.message) {
        parts.push(`<div style="margin-bottom:10px;font-size:14px;line-height:1.4;">${esc(spec.message)}</div>`);
      }
      if (spec.actions && spec.actions.length > 0) {
        parts.push(_renderActionLog(spec.actions, null));
      }
      if (spec.screenshot) {
        parts.push(_renderScreenshot(spec.screenshot, null));
      }
      if (parts.length === 0) return '';
      return `<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#e2e8f0;font-size:13px;max-width:500px;">${parts.join('')}</div>
<style>
  .action-row { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
  .action-detail { color: #94a3b8; }
  .action-value { color: #a78bfa; }
  .action-text { flex: 1; }
  .action-ok .action-text { color: #e2e8f0; }
  .action-err .action-text { color: #fca5a5; }
</style>`;
    }

    default:
      return '';
  }
}

// ---- Internal renderers for compound types ----

/**
 * Render a list of actions with success/fail status icons.
 * @param {Array} actions - { action, url?, ref?, value?, success }
 * @param {string|null} message - Optional header message
 * @returns {string} HTML string
 */
function _renderActionLog(actions, message) {
  if (!actions || actions.length === 0) return '';

  const successIcon =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
  const failIcon =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  const rows = actions
    .map((a) => {
      const statusClass = a.success ? 'action-ok' : 'action-err';
      const icon = a.success ? successIcon : failIcon;
      let desc = esc(a.action || '');
      if (a.url) desc += ` <span class="action-detail">${esc(_shortenUrl(a.url))}</span>`;
      if (a.ref) desc += ` <span class="action-detail">[ref ${esc(a.ref)}]</span>`;
      if (a.value) desc += ` <span class="action-value">"${esc(String(a.value).substring(0, 40))}"</span>`;
      return `<div class="action-row ${statusClass}">${icon} <span class="action-text">${desc}</span></div>`;
    })
    .join('');

  const messageHtml = message
    ? `<div style="margin-bottom:10px;font-size:14px;line-height:1.4;">${esc(message)}</div>`
    : '';

  return `${messageHtml}<div style="margin-bottom:10px;">
  <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#94a3b8;margin-bottom:4px;">Actions (${actions.length})</div>
  <div style="background:rgba(0,0,0,0.2);border-radius:6px;padding:6px 8px;font-family:'SF Mono',monospace;font-size:12px;max-height:200px;overflow-y:auto;">
    ${rows}
  </div>
</div>`;
}

/**
 * Render a screenshot image with optional caption.
 * @param {string} src - Image URL or data URL
 * @param {string|null} message - Optional caption
 * @returns {string} HTML string
 */
function _renderScreenshot(src, message) {
  if (!src) return '';
  const messageHtml = message
    ? `<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#94a3b8;margin-bottom:4px;">${esc(message)}</div>`
    : '';
  return `<div style="margin-bottom:10px;">
  ${messageHtml}
  <div><img src="${esc(src)}" alt="Screenshot" style="width:100%;border-radius:6px;margin-top:4px;" /></div>
</div>`;
}

/**
 * Shorten a URL for display (show host + truncated path).
 * @param {string} url
 * @returns {string}
 */
function _shortenUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 20 ? u.pathname.substring(0, 20) + '...' : u.pathname;
    return u.host + path;
  } catch (_) {
    return String(url).substring(0, 40);
  }
}

/**
 * Escape HTML entities for safe rendering.
 * @param {string} text
 * @returns {string}
 */
function esc(text) {
  if (!text) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { renderAgentUI, esc };
