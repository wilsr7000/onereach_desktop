/**
 * Diagnostics Overlay -- drop-in renderer bridge
 *
 * Installs a single helper on `window.diagnostics.popup(errorContext, options)`
 * in any renderer, plus a floating card that pops up in the top-right corner
 * when an error surface fires. The card shows the raw error + a "What's
 * wrong?" button. LLM diagnosis runs ONLY if the user clicks -- zero cost
 * until explicit. Same visual language as the HUD's inline diagnostics panel.
 *
 * Usage from a preload script:
 *   const { installDiagnosticsOverlay } = require('./lib/diagnostics-overlay-preload');
 *   installDiagnosticsOverlay({ contextBridge, ipcRenderer });
 *
 * Any existing showNotification / showToast / showError that currently shows an
 * error message can then call:
 *   window.diagnostics.popup({ message, category, source, agentId, data })
 * to get a diagnose-able error overlay for free.
 *
 * Safety:
 *   - Dedup by signature across windows (5-minute suppression).
 *   - Skips a curated benign-patterns allowlist so transient infra noise doesn't
 *     pop up in the user's face.
 *   - No DOM touching until something is actually shown (install is cheap).
 */

'use strict';

// ────────────────────────────────────────────────────────────────────────────
// Benign patterns -- errors we know aren't actionable and shouldn't surface.
// Mirrors the list in .cursor/rules/testing-guide.mdc.
// ────────────────────────────────────────────────────────────────────────────

const BENIGN_PATTERNS = [
  /Agent reconnect failed/i,
  /Built-in agent WebSocket error/i,
  /Failed to inject Chrome-like behavior/i,
  /Failed to check for Material Symbols/i,
  /^Database IO error$/i,
  /console-message arguments are deprecated/i,
  /The ScriptProcessorNode is deprecated/i,
  /DevTools failed to load source map/i,
  /ResizeObserver loop limit exceeded/i,
];

function isBenignMessage(message) {
  const s = String(message || '');
  if (!s) return true;
  return BENIGN_PATTERNS.some((re) => re.test(s));
}

// ────────────────────────────────────────────────────────────────────────────
// Signature-based dedup
// ────────────────────────────────────────────────────────────────────────────

function _signature({ message, category, source }) {
  const norm = String(message || '')
    .slice(0, 200)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, 'UUID')
    .replace(/\b\d{10,}\b/g, 'N')
    .toLowerCase();
  return `${category || '-'}::${source || '-'}::${norm}`;
}

const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5-min suppression
const _recentSignatures = new Map(); // signature -> expiresAtMs

function isRecentlyShown(sig) {
  const entry = _recentSignatures.get(sig);
  if (!entry) return false;
  if (entry < Date.now()) {
    _recentSignatures.delete(sig);
    return false;
  }
  return true;
}

function markShown(sig) {
  // Bound the map so long-running windows don't leak.
  if (_recentSignatures.size >= 200) {
    const first = _recentSignatures.keys().next().value;
    if (first !== undefined) _recentSignatures.delete(first);
  }
  _recentSignatures.set(sig, Date.now() + DEDUP_WINDOW_MS);
}

// ────────────────────────────────────────────────────────────────────────────
// Renderer-side helper source
// Emitted as a string so the preload can inject it into the renderer with
// contextBridge.exposeInMainWorld. The renderer logic is self-contained:
// installs CSS once on first popup, owns the floating card's DOM lifecycle,
// and delegates actual diagnosis to the already-exposed window.diagnostics.diagnose.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build a factory function that the preload calls with access to
 * ipcRenderer (to invoke the diagnose handler) and returns the popup API.
 */
function makeOverlayFactory({ ipcRenderer }) {
  let _installed = false;
  let _containerEl = null;
  let _cardCounter = 0;

  function _installCSS() {
    if (_installed) return;
    _installed = true;
    if (typeof document === 'undefined' || !document.head) return;
    const style = document.createElement('style');
    style.setAttribute('data-diagnostics-overlay', '1');
    style.textContent = `
      .diag-overlay-stack {
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 2147483647;
        display: flex;
        flex-direction: column;
        gap: 10px;
        pointer-events: none;
        max-width: 360px;
      }
      .diag-overlay-card {
        pointer-events: auto;
        background: rgba(24, 24, 28, 0.96);
        border: 1px solid rgba(239, 68, 68, 0.25);
        border-radius: 10px;
        padding: 12px 12px 10px;
        color: #e5e5e5;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 12px;
        line-height: 1.45;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
        animation: diag-overlay-in 160ms ease-out;
      }
      @keyframes diag-overlay-in {
        from { transform: translateY(-8px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
      .diag-overlay-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 6px;
      }
      .diag-overlay-label {
        font-size: 10px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: #fca5a5;
      }
      .diag-overlay-close {
        background: transparent;
        border: 0;
        color: #888;
        cursor: pointer;
        font-size: 14px;
        line-height: 1;
        padding: 2px 6px;
      }
      .diag-overlay-close:hover { color: #eee; }
      .diag-overlay-msg {
        color: #fafafa;
        word-break: break-word;
        margin-bottom: 8px;
        max-height: 84px;
        overflow-y: auto;
      }
      .diag-overlay-actions {
        display: flex;
        gap: 6px;
      }
      .diag-overlay-btn {
        flex: 1;
        padding: 6px 10px;
        border: 1px solid rgba(139, 92, 246, 0.3);
        border-radius: 6px;
        background: rgba(139, 92, 246, 0.15);
        color: #c4b5fd;
        font-size: 11px;
        cursor: pointer;
        transition: all 0.15s;
      }
      .diag-overlay-btn:hover {
        background: rgba(139, 92, 246, 0.25);
      }
      .diag-overlay-btn.ghost {
        background: transparent;
        border-color: rgba(255, 255, 255, 0.12);
        color: #aaa;
      }
      .diag-overlay-btn.ghost:hover { color: #eee; }
      .diag-overlay-btn:disabled {
        opacity: 0.6;
        cursor: default;
      }
      .diag-overlay-spinner {
        display: inline-block;
        width: 10px;
        height: 10px;
        border: 2px solid rgba(139, 92, 246, 0.2);
        border-top-color: #a78bfa;
        border-radius: 50%;
        animation: diag-overlay-spin 0.7s linear infinite;
        vertical-align: middle;
        margin-right: 6px;
      }
      @keyframes diag-overlay-spin { to { transform: rotate(360deg); } }
      .diag-overlay-section {
        margin-top: 10px;
        border-top: 1px solid rgba(239, 68, 68, 0.15);
        padding-top: 8px;
      }
      .diag-overlay-summary {
        font-weight: 600;
        color: #fafafa;
        margin-bottom: 4px;
      }
      .diag-overlay-cause {
        color: #bbb;
        margin-bottom: 6px;
      }
      .diag-overlay-steps-label {
        font-size: 9px;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        color: #a78bfa;
        margin-bottom: 2px;
      }
      .diag-overlay-steps {
        margin: 0 0 6px 16px;
        padding: 0;
      }
      .diag-overlay-steps li {
        margin-bottom: 2px;
        color: #d4d4d4;
      }
      .diag-overlay-source {
        font-size: 9px;
        color: #666;
        margin-top: 4px;
      }
      .diag-overlay-error {
        color: #fca5a5;
        font-style: italic;
        font-size: 11px;
      }
    `;
    document.head.appendChild(style);
  }

  function _getContainer() {
    if (_containerEl && document.body.contains(_containerEl)) return _containerEl;
    if (typeof document === 'undefined' || !document.body) return null;
    _containerEl = document.createElement('div');
    _containerEl.className = 'diag-overlay-stack';
    document.body.appendChild(_containerEl);
    return _containerEl;
  }

  function _esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function popup(errorContext = {}, options = {}) {
    try {
      if (typeof document === 'undefined' || !document.body) return null;

      const msg = String(errorContext.message || '').trim();
      if (!msg) return null;

      // Benign filter -- unless the caller force-opts-in via options.force=true.
      if (!options.force && isBenignMessage(msg)) return null;

      const sig = _signature(errorContext);
      if (!options.force && isRecentlyShown(sig)) return null;
      markShown(sig);

      _installCSS();
      const container = _getContainer();
      if (!container) return null;

      const id = 'diag-overlay-' + ++_cardCounter;
      const card = document.createElement('div');
      card.className = 'diag-overlay-card';
      card.setAttribute('data-id', id);
      card.innerHTML = [
        '<div class="diag-overlay-header">',
        '<span class="diag-overlay-label">Error</span>',
        '<button class="diag-overlay-close" data-action="close" title="Dismiss">&times;</button>',
        '</div>',
        '<div class="diag-overlay-msg">' + _esc(msg.slice(0, 400)) + '</div>',
        '<div class="diag-overlay-actions">',
        '<button class="diag-overlay-btn" data-action="diagnose">What\u2019s wrong?</button>',
        '<button class="diag-overlay-btn ghost" data-action="close">Dismiss</button>',
        '</div>',
      ].join('');
      container.appendChild(card);

      // Auto-dismiss after 45s of no interaction
      const autoDismiss = setTimeout(() => _dismiss(card), 45_000);
      function clearAuto() {
        try {
          clearTimeout(autoDismiss);
        } catch (_) {
          /* no-op */
        }
      }

      card.addEventListener('click', async (e) => {
        const target = e.target;
        if (!(target instanceof HTMLElement)) return;
        const action = target.getAttribute('data-action');
        if (!action) return;
        e.preventDefault();
        e.stopPropagation();

        if (action === 'close') {
          clearAuto();
          _dismiss(card);
          return;
        }
        if (action === 'diagnose') {
          clearAuto();
          await _runDiagnose(card, errorContext);
          return;
        }
        if (action === 'copy') {
          const text = card.getAttribute('data-copyable') || msg;
          try {
            await navigator.clipboard.writeText(text);
            const btn = card.querySelector('[data-action="copy"]');
            if (btn instanceof HTMLElement) {
              const prev = btn.textContent;
              btn.textContent = 'Copied';
              setTimeout(() => {
                btn.textContent = prev;
              }, 1200);
            }
          } catch (_) {
            /* clipboard unavailable */
          }
          return;
        }
        if (action === 'deeper') {
          clearAuto();
          await _runDeep(card, errorContext);
          return;
        }
      });

      return id;
    } catch (err) {
      // Overlay must never itself surface an error. Swallow.
      try {
        console.warn('[diagnostics.popup] failed:', err && err.message);
      } catch (_) {
        /* no-op */
      }
      return null;
    }
  }

  function _dismiss(card) {
    if (!card || !card.parentNode) return;
    card.style.transition = 'opacity 160ms ease-in, transform 160ms ease-in';
    card.style.opacity = '0';
    card.style.transform = 'translateY(-8px)';
    setTimeout(() => {
      try {
        if (card.parentNode) card.parentNode.removeChild(card);
      } catch (_) {
        /* no-op */
      }
    }, 180);
  }

  async function _runDiagnose(card, errorContext) {
    const diagnoseBtn = card.querySelector('[data-action="diagnose"]');
    if (diagnoseBtn instanceof HTMLButtonElement) {
      diagnoseBtn.disabled = true;
      diagnoseBtn.innerHTML = '<span class="diag-overlay-spinner"></span>Looking this up...';
    }
    try {
      const result = await ipcRenderer.invoke('diagnostics:diagnose', errorContext, {});
      if (!result || result.error) {
        _renderError(card, (result && result.error) || 'Diagnosis failed');
        return;
      }
      _renderDiagnosis(card, errorContext, result);
    } catch (err) {
      _renderError(card, (err && err.message) || String(err));
    }
  }

  function _renderDiagnosis(card, errorContext, result) {
    const diagnoseBtn = card.querySelector('[data-action="diagnose"]');
    if (diagnoseBtn instanceof HTMLButtonElement) diagnoseBtn.remove();

    const section = document.createElement('div');
    section.className = 'diag-overlay-section';

    const summary = document.createElement('div');
    summary.className = 'diag-overlay-summary';
    summary.textContent = result.summary || 'Diagnosis unavailable.';
    section.appendChild(summary);

    if (result.rootCause) {
      const cause = document.createElement('div');
      cause.className = 'diag-overlay-cause';
      cause.textContent = result.rootCause;
      section.appendChild(cause);
    }

    const stepsLabel = document.createElement('div');
    stepsLabel.className = 'diag-overlay-steps-label';
    stepsLabel.textContent = 'Try this';
    section.appendChild(stepsLabel);

    const steps = document.createElement('ol');
    steps.className = 'diag-overlay-steps';
    for (const step of Array.isArray(result.steps) ? result.steps : []) {
      const li = document.createElement('li');
      li.textContent = String(step);
      steps.appendChild(li);
    }
    section.appendChild(steps);

    const meta = [];
    if (result.source) meta.push(result.source);
    if (result.cached) meta.push('cached');
    if (result.degraded) meta.push(result.degraded);
    if (meta.length) {
      const srcEl = document.createElement('div');
      srcEl.className = 'diag-overlay-source';
      srcEl.textContent = meta.join(' | ');
      section.appendChild(srcEl);
    }

    // Stash the copyable bundle on the card element for the Copy button to pick up.
    if (result.copyable) card.setAttribute('data-copyable', result.copyable);

    // Replace the existing actions row with diagnosis-specific actions.
    const actionsRow = card.querySelector('.diag-overlay-actions');
    if (actionsRow) {
      actionsRow.innerHTML = [
        '<button class="diag-overlay-btn" data-action="copy">Copy</button>',
        '<button class="diag-overlay-btn ghost" data-action="deeper" data-deep-available="unknown">Go deeper</button>',
        '<button class="diag-overlay-btn ghost" data-action="close">Close</button>',
      ].join('');
    }

    card.appendChild(section);
  }

  async function _runDeep(card, errorContext) {
    const deepBtn = card.querySelector('[data-action="deeper"]');
    if (deepBtn instanceof HTMLButtonElement) {
      deepBtn.disabled = true;
      deepBtn.innerHTML = '<span class="diag-overlay-spinner"></span>Running deep diagnosis...';
    }
    try {
      const statusRes = await ipcRenderer.invoke('issue-agent:status');
      if (!statusRes?.available) {
        _renderError(card, 'Deep diagnosis needs the Claude Code CLI. It is not installed here.');
        return;
      }
      const res = await ipcRenderer.invoke(
        'issue-agent:report',
        {
          userMessage: errorContext.message,
          errorContext,
        },
        { proposeFix: false }
      );
      if (!res || res.status === 'error' || !res.diagnosis) {
        _renderError(card, (res && res.error) || 'Deep diagnosis failed');
        return;
      }
      _renderDeep(card, res);
    } catch (err) {
      _renderError(card, (err && err.message) || String(err));
    }
  }

  function _renderDeep(card, res) {
    const existing = card.querySelector('.diag-overlay-deep');
    if (existing) existing.remove();
    const section = document.createElement('div');
    section.className = 'diag-overlay-section diag-overlay-deep';
    const label = document.createElement('div');
    label.className = 'diag-overlay-steps-label';
    label.textContent = 'Deep diagnosis';
    const summary = document.createElement('div');
    summary.className = 'diag-overlay-summary';
    summary.textContent = res.diagnosis.summary || '';
    const cause = document.createElement('div');
    cause.className = 'diag-overlay-cause';
    cause.textContent = res.diagnosis.rootCause || '';
    section.appendChild(label);
    section.appendChild(summary);
    section.appendChild(cause);

    const affected = Array.isArray(res.diagnosis.affectedFiles) ? res.diagnosis.affectedFiles : [];
    if (affected.length) {
      const files = document.createElement('ol');
      files.className = 'diag-overlay-steps';
      for (const f of affected.slice(0, 5)) {
        const li = document.createElement('li');
        li.textContent = `${f.path}${f.lines ? ':' + f.lines : ''}${f.why ? ' -- ' + f.why : ''}`;
        files.appendChild(li);
      }
      section.appendChild(files);
    }

    card.appendChild(section);

    const deepBtn = card.querySelector('[data-action="deeper"]');
    if (deepBtn instanceof HTMLButtonElement) deepBtn.remove();
  }

  function _renderError(card, message) {
    const actionsRow = card.querySelector('.diag-overlay-actions');
    if (actionsRow) {
      actionsRow.innerHTML = '<button class="diag-overlay-btn ghost" data-action="close">Close</button>';
    }
    const err = document.createElement('div');
    err.className = 'diag-overlay-error';
    err.style.marginTop = '6px';
    err.textContent = String(message || 'Diagnosis failed');
    card.appendChild(err);
  }

  /** Optional external trigger (main-process broadcast). */
  function onAutoPopup(handler) {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => {
      try {
        handler(payload);
      } catch (_) {
        /* no-op */
      }
    };
    ipcRenderer.on('diagnostics:auto-popup', listener);
    return () => ipcRenderer.removeListener('diagnostics:auto-popup', listener);
  }

  return {
    popup,
    isBenignMessage,
    onAutoPopup,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Public factory
// ────────────────────────────────────────────────────────────────────────────

/**
 * Returns `{ popup, onAutoPopup, isBenignMessage }`.
 *
 * Each preload script that exposes `window.diagnostics` merges this in at
 * exposeInMainWorld time. Example:
 *
 *   const overlay = makeDiagnosticsOverlayAPI({ ipcRenderer });
 *   contextBridge.exposeInMainWorld('diagnostics', {
 *     diagnose: (ctx, opts) => ipcRenderer.invoke('diagnostics:diagnose', ctx, opts),
 *     getRecentLogs: (opts) => ipcRenderer.invoke('diagnostics:get-recent-logs', opts),
 *     ...overlay,
 *   });
 */
function makeDiagnosticsOverlayAPI({ ipcRenderer }) {
  if (!ipcRenderer) {
    throw new Error('makeDiagnosticsOverlayAPI requires { ipcRenderer }');
  }
  return makeOverlayFactory({ ipcRenderer });
}

module.exports = {
  makeDiagnosticsOverlayAPI,
  makeOverlayFactory,
  isBenignMessage,
  BENIGN_PATTERNS,
  _signature, // test-only
};
