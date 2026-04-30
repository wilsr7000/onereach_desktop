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

    case 'dayView': {
      return _renderDayView(spec);
    }

    case 'alarmCard': {
      return _renderAlarmCard(spec);
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

    case 'consolidatedEvaluation': {
      return _renderConsolidatedEvaluation(spec);
    }

    case 'buildProposal': {
      return _renderBuildProposal(spec);
    }

    default:
      return '';
  }
}

// ---- Consolidated evaluation renderer (Phase 1: council mode) ----

/**
 * Render the council-mode result produced by
 * lib/exchange/council-runner.js. Minimal inline rendering that mirrors
 * the richer `js/evaluation-hud.js` panel but lives in the command-HUD
 * agent-UI slot so any tool (orb, recorder, GSX) can display a council
 * outcome without owning its own panel implementation.
 *
 * Expected spec shape:
 *   {
 *     type: 'consolidatedEvaluation',
 *     aggregateScore: number,   // 0-100
 *     confidence: 'low'|'medium'|'high',
 *     weightingMode: string,
 *     agentScores: [{ agentType, agentId, score, weight, trend }],
 *     conflicts: [{ criterion, spread, highScorer, lowScorer, resolution }],
 *     suggestions: [{ text, source, type }],
 *     primaryDrivers: [...],
 *     message: string,          // optional human summary (falls back to auto)
 *     recommendsHumanReview: boolean,
 *   }
 */
function _renderConsolidatedEvaluation(spec) {
  if (!spec) return '';

  const score = Math.max(0, Math.min(100, Number(spec.aggregateScore) || 0));
  const scoreColor = score >= 75 ? '#4ade80' : score >= 50 ? '#fbbf24' : '#f87171';
  const confidence = spec.confidence || 'medium';
  const weightingMode = spec.weightingMode || 'uniform';

  const message = spec.message
    ? `<div style="margin-bottom:10px;font-size:14px;line-height:1.4;">${esc(spec.message)}</div>`
    : '';

  const header = `
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:12px;">
      <div>
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.15em;color:rgba(255,255,255,0.45);">Council</div>
        <div style="font-size:28px;font-weight:700;color:${scoreColor};line-height:1;">${score}</div>
        <div style="font-size:10px;color:rgba(255,255,255,0.5);margin-top:2px;">confidence: ${esc(confidence)} &middot; ${esc(weightingMode)}</div>
      </div>
      ${spec.recommendsHumanReview ? `<div style="padding:4px 8px;border-radius:9999px;border:1px solid rgba(251,191,36,0.3);background:rgba(251,191,36,0.1);font-size:10px;color:#fef3c7;">Review recommended</div>` : ''}
    </div>`;

  // Per-agent scores
  const agentScores = Array.isArray(spec.agentScores) ? spec.agentScores : [];
  const agentRows = agentScores.map((s) => {
    const barWidth = Math.max(2, Math.min(100, Number(s.score) || 0));
    const trendIcon = s.trend === 'above' ? '▲' : s.trend === 'below' ? '▼' : '●';
    const trendColor = s.trend === 'above' ? '#4ade80' : s.trend === 'below' ? '#f87171' : 'rgba(255,255,255,0.4)';
    return `
      <div style="display:grid;grid-template-columns:1fr 40px 14px;gap:8px;align-items:center;padding:3px 0;">
        <div style="overflow:hidden;">
          <div style="font-size:11px;color:rgba(255,255,255,0.85);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(s.agentType || s.agentId || '?')}</div>
          <div style="height:4px;background:rgba(255,255,255,0.08);border-radius:2px;overflow:hidden;margin-top:2px;">
            <div style="width:${barWidth}%;height:100%;background:${scoreColor};opacity:0.7;"></div>
          </div>
        </div>
        <div style="text-align:right;font-size:11px;font-variant-numeric:tabular-nums;color:rgba(255,255,255,0.8);">${Math.round(Number(s.score) || 0)}</div>
        <div style="text-align:center;font-size:9px;color:${trendColor};">${trendIcon}</div>
      </div>`;
  }).join('');

  const agentsBlock = agentScores.length > 0 ? `
    <div style="margin-bottom:10px;">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:rgba(255,255,255,0.45);margin-bottom:4px;">Agents (${agentScores.length})</div>
      ${agentRows}
    </div>` : '';

  // Conflicts
  const conflicts = Array.isArray(spec.conflicts) ? spec.conflicts : [];
  const conflictsBlock = conflicts.length > 0 ? `
    <div style="margin-bottom:10px;padding:8px;border-radius:8px;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.2);">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#fef3c7;margin-bottom:4px;">Conflicts (${conflicts.length})</div>
      ${conflicts.map((c) => `
        <div style="font-size:11px;color:rgba(255,255,255,0.8);margin-top:4px;">
          <strong>${esc(c.criterion || '?')}</strong>
          <span style="color:rgba(255,255,255,0.5);">spread ${esc(String(c.spread ?? '?'))}</span>
          ${c.highScorer ? `&nbsp;&middot; high: ${esc(c.highScorer.agentType || '?')} (${Math.round(c.highScorer.score || 0)})` : ''}
          ${c.lowScorer ? `&nbsp;&middot; low: ${esc(c.lowScorer.agentType || '?')} (${Math.round(c.lowScorer.score || 0)})` : ''}
          ${c.resolution ? `<div style="font-size:10px;color:rgba(255,255,255,0.55);margin-top:2px;">${esc(c.resolution)}</div>` : ''}
        </div>`).join('')}
    </div>` : '';

  // Top suggestions (cap at 3)
  const suggestions = (Array.isArray(spec.suggestions) ? spec.suggestions : []).slice(0, 3);
  const suggestionsBlock = suggestions.length > 0 ? `
    <div style="margin-bottom:10px;">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:rgba(255,255,255,0.45);margin-bottom:4px;">Suggestions</div>
      ${suggestions.map((s) => `
        <div style="font-size:11px;color:rgba(255,255,255,0.8);padding:4px 6px;margin-top:3px;border-radius:6px;background:rgba(255,255,255,0.04);">
          <span style="color:rgba(255,255,255,0.85);">${esc((s.text || '').slice(0, 300))}</span>
          ${s.source ? `<span style="color:rgba(255,255,255,0.4);font-size:10px;margin-left:6px;">${esc(s.source)}</span>` : ''}
        </div>`).join('')}
    </div>` : '';

  // Primary drivers (criteria that dominated the score)
  const drivers = Array.isArray(spec.primaryDrivers) ? spec.primaryDrivers : [];
  const driversBlock = drivers.length > 0 ? `
    <div style="font-size:10px;color:rgba(255,255,255,0.5);">
      Primary drivers: ${drivers.slice(0, 5).map((d) => esc(typeof d === 'string' ? d : d.name || '?')).join(', ')}
    </div>` : '';

  return `<div class="hud-card" style="padding:12px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">
    ${message}
    ${header}
    ${agentsBlock}
    ${conflictsBlock}
    ${suggestionsBlock}
    ${driversBlock}
  </div>`;
}

// ---- Day View renderer (rich daily brief) ----

function _renderDayView(spec) {
  const now = esc(spec.now || '');
  const dateLabel = esc(spec.dateLabel || '');
  const events = spec.events || [];
  const insightCards = spec.insightCards || [];
  const briefing = spec.briefing || [];
  const actions = spec.actions || [];
  const focus = spec.focusWindow;

  const typeColors = {
    Work: 'background:rgba(59,130,246,0.15);color:#bfdbfe;border-color:rgba(96,165,250,0.2)',
    Personal: 'background:rgba(16,185,129,0.15);color:#a7f3d0;border-color:rgba(52,211,153,0.2)',
    Critical: 'background:rgba(245,158,11,0.15);color:#fde68a;border-color:rgba(251,191,36,0.2)',
    Recovery: 'background:rgba(139,92,246,0.15);color:#ddd6fe;border-color:rgba(167,139,250,0.2)',
  };

  const statusBorder = {
    done: 'border-color:rgba(255,255,255,0.1);opacity:0.65',
    now: 'border-color:rgba(103,232,249,0.5);box-shadow:0 0 0 1px rgba(103,232,249,0.25)',
    next: 'border-color:rgba(252,211,77,0.4)',
    open: 'border-color:rgba(196,181,253,0.3)',
    upcoming: 'border-color:rgba(255,255,255,0.1)',
  };

  // ── Insight cards ──
  const insightHtml = insightCards.map(card =>
    `<div style="border-radius:20px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);padding:14px 16px;box-shadow:0 4px 24px rgba(0,0,0,0.2);">` +
    `<div style="font-size:11px;color:rgba(255,255,255,0.5);letter-spacing:0.02em;">${esc(card.title)}</div>` +
    `<div style="margin-top:6px;font-size:20px;font-weight:600;letter-spacing:-0.02em;">${esc(card.value)}</div>` +
    `<div style="margin-top:3px;font-size:11px;color:rgba(255,255,255,0.6);">${esc(card.sub)}</div>` +
    `</div>`
  ).join('');

  // ── Timeline events ──
  const eventsHtml = events.map(ev => {
    const borderStyle = statusBorder[ev.status] || statusBorder.upcoming;
    const typeStyle = typeColors[ev.type] || typeColors.Work;

    let statusBadge = '';
    if (ev.status === 'now') {
      statusBadge = `<span style="display:inline-block;border-radius:9999px;border:1px solid rgba(103,232,249,0.3);background:rgba(103,232,249,0.1);padding:2px 8px;font-size:10px;font-weight:500;color:#cffafe;">Happening now</span>`;
    } else if (ev.status === 'next') {
      statusBadge = `<span style="display:inline-block;border-radius:9999px;border:1px solid rgba(252,211,77,0.3);background:rgba(252,211,77,0.1);padding:2px 8px;font-size:10px;font-weight:500;color:#fef3c7;">Up next</span>`;
    }

    return `<div style="border-radius:18px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.2);padding:12px 14px;${borderStyle};" data-value="tell me more about ${esc(ev.title)}">` +
      `<div style="display:flex;align-items:flex-start;gap:10px;">` +
        `<div style="min-width:64px;flex-shrink:0;">` +
          `<div style="font-size:14px;font-weight:600;">${esc(ev.time)}</div>` +
          `<div style="font-size:11px;color:rgba(255,255,255,0.45);">until ${esc(ev.end)}</div>` +
        `</div>` +
        `<div style="flex:1;min-width:0;">` +
          `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:5px;">` +
            `<span style="font-size:14px;font-weight:500;letter-spacing:-0.01em;">${esc(ev.title)}</span>` +
            `<span style="display:inline-block;border-radius:9999px;border:1px solid;padding:1px 7px;font-size:10px;font-weight:500;${typeStyle}">${esc(ev.type)}</span>` +
            statusBadge +
          `</div>` +
          `<div style="margin-top:5px;display:flex;flex-wrap:wrap;gap:8px;font-size:11px;color:rgba(255,255,255,0.55);">` +
            (ev.location ? `<span>${esc(ev.location)}</span>` : '') +
            (ev.note ? `<span>${esc(ev.note)}</span>` : '') +
          `</div>` +
        `</div>` +
      `</div>` +
    `</div>`;
  }).join('');

  // ── AI Briefing ──
  const briefingHtml = briefing.length > 0
    ? `<div style="border-radius:20px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);padding:16px;box-shadow:0 4px 24px rgba(0,0,0,0.2);">` +
      `<div style="font-size:16px;font-weight:600;">AI briefing</div>` +
      `<div style="margin-top:10px;display:flex;flex-direction:column;gap:8px;font-size:12px;line-height:1.6;color:rgba(255,255,255,0.7);">` +
      briefing.map(p => `<p style="margin:0;">${esc(p)}</p>`).join('') +
      `</div></div>`
    : '';

  // ── Smart Actions ──
  const actionsHtml = actions.length > 0
    ? `<div style="border-radius:20px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);padding:16px;box-shadow:0 4px 24px rgba(0,0,0,0.2);">` +
      `<div style="font-size:16px;font-weight:600;">Smart actions</div>` +
      `<div style="margin-top:10px;display:flex;flex-direction:column;gap:6px;">` +
      actions.map(a =>
        `<button style="display:block;width:100%;border-radius:14px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.2);padding:10px 12px;text-align:left;font-size:12px;color:rgba(255,255,255,0.8);cursor:pointer;font-family:inherit;" data-value="${esc(a)}">${esc(a)}</button>`
      ).join('') +
      `</div></div>`
    : '';

  // ── Focus Window ──
  const focusHtml = focus
    ? `<div style="border-radius:20px;border:1px solid rgba(52,211,153,0.2);background:rgba(52,211,153,0.1);padding:16px;box-shadow:0 4px 24px rgba(0,0,0,0.2);">` +
      `<div style="font-size:11px;color:rgba(167,243,208,0.8);">Recommended focus window</div>` +
      `<div style="margin-top:6px;font-size:24px;font-weight:600;letter-spacing:-0.02em;">${esc(focus.time)}</div>` +
      `<div style="margin-top:6px;font-size:11px;color:rgba(236,253,245,0.8);">${esc(focus.description)}</div>` +
      `</div>`
    : '';

  return `<style>
.dv{font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','SF Pro Text',system-ui,sans-serif;color:#fff;-webkit-font-smoothing:antialiased;}
.dv *{box-sizing:border-box;}
.dv button:hover{background:rgba(255,255,255,0.06) !important;}
</style>
<div class="dv" style="display:flex;flex-direction:column;gap:12px;">
  <div>
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.25em;color:rgba(255,255,255,0.45);">AI Day View</div>
    <div style="margin-top:6px;font-size:22px;font-weight:600;letter-spacing:-0.02em;line-height:1.2;">Here's what your day looks like</div>
    <div style="margin-top:6px;font-size:12px;color:rgba(255,255,255,0.6);line-height:1.5;">A calm, decision-ready view of what matters, what is next, and where the gaps are.</div>
  </div>
  <div style="border-radius:20px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.05);padding:12px 16px;backdrop-filter:blur(12px);box-shadow:0 4px 24px rgba(0,0,0,0.2);">
    <div style="font-size:11px;color:rgba(255,255,255,0.5);">Right now</div>
    <div style="margin-top:4px;font-size:26px;font-weight:600;">${now}</div>
    <div style="color:rgba(255,255,255,0.6);font-size:12px;">${dateLabel}</div>
  </div>
  <div style="display:flex;flex-direction:column;gap:8px;">${insightHtml}</div>
  <div style="border-radius:20px;border:1px solid rgba(255,255,255,0.1);background:linear-gradient(to bottom,rgba(255,255,255,0.05),rgba(255,255,255,0.02));padding:14px;box-shadow:0 4px 24px rgba(0,0,0,0.2);">
    <div style="display:flex;align-items:center;justify-content:space-between;padding-bottom:10px;">
      <div>
        <div style="font-size:16px;font-weight:600;">Timeline</div>
        <div style="font-size:11px;color:rgba(255,255,255,0.5);">Sorted by what you need to care about next</div>
      </div>
      <div style="border-radius:9999px;border:1px solid rgba(103,232,249,0.25);background:rgba(103,232,249,0.1);padding:3px 10px;font-size:10px;color:#cffafe;">Live context on</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;">${eventsHtml}</div>
  </div>
  ${briefingHtml}
  ${actionsHtml}
  ${focusHtml}
</div>`;
}

// ---- Build proposal renderer (capability-gap → build-a-new-agent UI) ----

/**
 * Render a "build a new agent?" card shown when no existing agent could
 * handle the user's request. Produced by agent-builder-agent's
 * feasibility assessment; clickable options route back through the
 * agent (targetAgentId in metadata) so the user can confirm with a
 * button instead of (or in addition to) a voice reply.
 *
 * Expected spec:
 *   {
 *     type: 'buildProposal',
 *     request: string,           // what the user asked for (short)
 *     effort: 'easy'|'medium'|'hard'|'not_feasible',
 *     reasoning: string,         // why that effort level
 *     estimatedCostPerUse: string, // e.g. '$0.003'
 *     requiredIntegrations: string[],
 *     missingAccess: string[],
 *     buildMethod: 'claude-code'|'playbook'|'none',
 *     alternativeSuggestion: string | null, // only when effort=not_feasible
 *     message: string,           // optional human summary (falls back to auto)
 *   }
 *
 * Buttons route via the standard [data-value] delegated click handler
 * in command-hud.html which submits the value back through submitTask
 * with `metadata.targetAgentId = agentId`, reaching agent-builder-agent's
 * pending `needsInput` conversation.
 */
function _renderBuildProposal(spec) {
  if (!spec) return '';

  const request = String(spec.request || '').slice(0, 200);
  const effort = spec.effort || 'medium';
  const reasoning = String(spec.reasoning || '');
  const cost = String(spec.estimatedCostPerUse || '~$0.01');
  const integrations = Array.isArray(spec.requiredIntegrations) ? spec.requiredIntegrations : [];
  const missing = Array.isArray(spec.missingAccess) ? spec.missingAccess : [];
  const buildMethod = spec.buildMethod || (effort === 'not_feasible' ? 'none' : 'claude-code');
  const alternative = spec.alternativeSuggestion ? String(spec.alternativeSuggestion) : null;

  const effortColor =
    effort === 'easy' ? '#4ade80' :
    effort === 'medium' ? '#fbbf24' :
    effort === 'hard' ? '#fb923c' :
    /* not_feasible */ '#f87171';

  const effortLabel = effort === 'not_feasible' ? 'Not feasible today'
    : effort === 'easy' ? 'Easy build (~30s, bundled Claude Code)'
    : effort === 'medium' ? 'Medium build (~45s, bundled Claude Code)'
    : 'Hard -- needs a plan first';

  const header = `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:10px;">
      <div style="flex:1;min-width:0;">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.15em;color:rgba(255,255,255,0.45);">Build a new agent?</div>
        <div style="margin-top:4px;font-size:14px;font-weight:600;color:#e2e8f0;line-height:1.3;">${esc(request)}</div>
      </div>
      <span style="display:inline-block;border-radius:9999px;border:1px solid;padding:3px 9px;font-size:10px;font-weight:600;flex-shrink:0;background:${effortColor}22;color:${effortColor};border-color:${effortColor}55;">${esc(effortLabel)}</span>
    </div>`;

  const reasoningBlock = reasoning ? `
    <div style="font-size:12px;color:rgba(255,255,255,0.75);line-height:1.5;margin-bottom:10px;">${esc(reasoning)}</div>` : '';

  const costLine = effort !== 'not_feasible' ? `
    <div style="font-size:11px;color:rgba(255,255,255,0.6);margin-bottom:8px;">
      <span style="color:rgba(255,255,255,0.45);">Estimated cost per use:</span>
      <span style="color:#a7f3d0;font-variant-numeric:tabular-nums;">${esc(cost)}</span>
    </div>` : '';

  const integrationsBlock = integrations.length > 0 ? `
    <div style="font-size:11px;color:rgba(255,255,255,0.65);margin-bottom:8px;">
      <span style="color:rgba(255,255,255,0.45);">Uses:</span>
      ${integrations.slice(0, 5).map((i) => `<span style="display:inline-block;margin-right:6px;padding:1px 6px;border-radius:6px;background:rgba(96,165,250,0.15);color:#bfdbfe;">${esc(i)}</span>`).join('')}
    </div>` : '';

  const missingBlock = missing.length > 0 ? `
    <div style="font-size:11px;color:rgba(255,255,255,0.65);margin-bottom:8px;padding:6px 8px;border-radius:6px;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.2);">
      <span style="color:#fef3c7;">Needs access to:</span>
      ${missing.slice(0, 3).map((m) => esc(m)).join(', ')}
    </div>` : '';

  const alternativeBlock = alternative ? `
    <div style="font-size:12px;color:rgba(255,255,255,0.75);padding:8px 10px;border-radius:8px;background:rgba(139,92,246,0.08);border:1px solid rgba(139,92,246,0.2);margin-top:8px;">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#ddd6fe;margin-bottom:3px;">Alternative</div>
      ${esc(alternative)}
    </div>` : '';

  // Buttons vary by buildMethod:
  //   claude-code -> Build now, Create playbook, Not now
  //   playbook    -> Create playbook, Not now (no Build now, too risky)
  //   none        -> Not now (+ alternative shown above)
  let buttonsHtml = '';
  if (buildMethod === 'claude-code') {
    buttonsHtml = `
      <div style="display:flex;gap:6px;margin-top:10px;">
        <button class="hud-action-btn success" data-value="yes" style="flex:1.2;">Build now</button>
        <button class="hud-action-btn" data-value="playbook" style="flex:1;">Create playbook</button>
        <button class="hud-action-btn" data-value="no" style="flex:0.7;">Not now</button>
      </div>`;
  } else if (buildMethod === 'playbook') {
    buttonsHtml = `
      <div style="display:flex;gap:6px;margin-top:10px;">
        <button class="hud-action-btn success" data-value="playbook" style="flex:1;">Create playbook</button>
        <button class="hud-action-btn" data-value="no" style="flex:0.6;">Not now</button>
      </div>`;
  } else {
    buttonsHtml = `
      <div style="display:flex;gap:6px;margin-top:10px;">
        <button class="hud-action-btn" data-value="no" style="flex:1;">OK</button>
      </div>`;
  }

  return `<div class="hud-card" style="padding:12px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">
    ${header}
    ${reasoningBlock}
    ${costLine}
    ${integrationsBlock}
    ${missingBlock}
    ${alternativeBlock}
    ${buttonsHtml}
  </div>`;
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
 * Render a critical-meeting alarm card. Fires in the command-hud window when
 * the critical-meeting-alarm-agent emits `critical-alarms:fire`.
 *
 * Expected spec shape:
 *   {
 *     type: 'alarmCard',
 *     id:             string,        // unique alarm id (eventId:startMs:leadMinutes)
 *     eventId:        string,
 *     title:          string,
 *     startEpochMs:   number,
 *     leadMinutes:    number,        // minutes until meeting starts
 *     location?:      string,
 *     joinLink?:      string,
 *     reasons?:       string[],      // why this event is flagged critical
 *     message?:       string,        // headline spoken by the voice channel
 *   }
 *
 * The resulting HTML hosts three buttons with `data-action` attributes. The
 * renderer wires the click handlers via a short inline script so we stay
 * consistent with how other agent UIs are injected (the command HUD calls
 * `addAgentUIPanel(agentId, agentName, html)` which executes inline scripts).
 */
function _renderAlarmCard(spec) {
  const alarmId = esc(spec.id || '');
  const eventId = esc(spec.eventId || '');
  const title = esc(spec.title || 'Upcoming meeting');
  const lead = Number.isFinite(spec.leadMinutes) ? Math.max(0, Math.round(spec.leadMinutes)) : null;
  const startEpochMs = Number.isFinite(spec.startEpochMs) ? spec.startEpochMs : null;
  const startLabel = startEpochMs
    ? new Date(startEpochMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : '';
  const reasons = Array.isArray(spec.reasons) ? spec.reasons.slice(0, 3) : [];
  const location = esc(spec.location || '');
  const joinLink = esc(spec.joinLink || '');
  const headline = lead !== null
    ? lead <= 1
      ? 'Starting now'
      : `In ${lead} minute${lead === 1 ? '' : 's'}`
    : 'Upcoming';

  const reasonsHtml = reasons.length
    ? `<ul class="alarm-reasons">${reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`
    : '';
  const locationHtml = location ? `<div class="alarm-location">${location}</div>` : '';
  const joinBtn = joinLink
    ? `<button class="hud-action-btn success" data-alarm-action="join" data-alarm-href="${joinLink}">Join</button>`
    : '';

  return [
    '<div class="alarm-card" data-alarm-id="' + alarmId + '" data-event-id="' + eventId + '">',
    '<div class="alarm-card-header">',
    '<div class="alarm-card-when">' + esc(headline) + '</div>',
    startLabel ? '<div class="alarm-card-time">' + esc(startLabel) + '</div>' : '',
    '</div>',
    '<div class="alarm-card-title">' + title + '</div>',
    locationHtml,
    reasonsHtml,
    '<div class="alarm-card-actions" style="display:flex;gap:6px;margin-top:10px">',
    joinBtn,
    '<button class="hud-action-btn" data-alarm-action="snooze">Snooze 5m</button>',
    '<button class="hud-action-btn danger" data-alarm-action="dismiss">Dismiss</button>',
    '</div>',
    '</div>',
  ].join('');
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
