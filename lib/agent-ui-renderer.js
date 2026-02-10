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
 */

/**
 * Convert a declarative UI spec to HTML for the Command HUD.
 *
 * @param {Object} spec - UI specification from agent
 * @param {string} spec.type - "confirm" | "select" | "info" | "eventList"
 * @param {string} [spec.message] - Descriptive text shown above controls
 * @param {Array}  [spec.options] - For confirm/select: { label, value, style? }
 * @param {string} [spec.title] - For eventList: header label (e.g. "Today")
 * @param {Array}  [spec.events] - For eventList: { time, title, recurring, importance, attendees, actionValue }
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
      const messageHtml = spec.message
        ? `<div class="hud-card"><p>${esc(spec.message)}</p></div>`
        : '';
      const buttonsHtml = options.map(o => {
        const style = o.style || '';
        return `<button class="hud-action-btn ${esc(style)}" data-value="${esc(o.value)}">${esc(o.label)}</button>`;
      }).join('');
      return `${messageHtml}<div style="display:flex;gap:8px;margin-top:${spec.message ? '12' : '0'}px">${buttonsHtml}</div>`;
    }

    case 'select': {
      const options = spec.options || [];
      const messageHtml = spec.message
        ? `<div class="hud-card"><p>${esc(spec.message)}</p></div>`
        : '';
      const optionsHtml = options.map((o, i) =>
        `<div class="hud-option-item" data-value="${esc(o.value)}">` +
        `<span class="option-number">${i + 1}</span>` +
        `<span style="font-size:13px;color:#e0e0e0">${esc(o.label)}</span>` +
        `</div>`
      ).join('');
      return `${messageHtml}<div style="display:flex;flex-direction:column;gap:6px;margin-top:${spec.message ? '12' : '0'}px">${optionsHtml}</div>`;
    }

    case 'info': {
      return spec.message
        ? `<div class="hud-card"><p>${esc(spec.message)}</p></div>`
        : '';
    }

    case 'eventList': {
      const events = spec.events || [];
      const title = spec.title || 'Events';

      if (events.length === 0) {
        return `<div class="hud-card"><div style="padding:8px;opacity:0.5;">No events ${esc(title.toLowerCase())}</div></div>`;
      }

      const rows = events.slice(0, 8).map(ev => {
        const time = esc(ev.time || '');
        const evTitle = esc(ev.title || 'Untitled');
        const importance = Math.max(1, Math.min(5, ev.importance || 1));
        const actionValue = esc(ev.actionValue || `tell me more about ${ev.title || 'this event'}`);

        // Importance bars (cellular signal style, heights 4-16px)
        const bars = Array.from({ length: 5 }, (_, i) => {
          const h = 4 + (i * 3);
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
          const initials = ev.attendees.slice(0, 3).map(a => {
            const initial = esc(a.initial || '?');
            return `<span style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:rgba(255,255,255,0.1);font-size:9px;margin-left:2px;" title="${esc(a.name || '')}">${initial}</span>`;
          }).join('');
          const extra = ev.attendees.length > 3
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
      }).join('');

      const countLabel = events.length > 8 ? ` (showing 8 of ${events.length})` : '';

      return `<div class="hud-card">
  <div style="padding:6px 8px;font-size:11px;opacity:0.5;border-bottom:1px solid rgba(255,255,255,0.06);">${esc(title)}${countLabel}</div>
  ${rows}
</div>`;
    }

    default:
      return '';
  }
}

/**
 * Escape HTML entities for safe rendering.
 * @param {string} text
 * @returns {string}
 */
function esc(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { renderAgentUI, esc };
