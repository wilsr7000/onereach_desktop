/**
 * Diagnostics section.
 *
 * Renders a current-state snapshot from `window.lite.health.snapshot()`
 * (ADR-036) -- "what is true right now?" across documented Lite
 * modules. Pull-based: the panel re-fetches when the user clicks
 * Refresh. No auto-polling (per ADR-036, the store has no cache and a
 * background interval would be free work the user didn't ask for).
 *
 * Security: the snapshot type cannot carry secrets (see
 * `lite/health/types.ts`). The Account section is the canonical place
 * for full token values; this panel only shows the presence booleans.
 */

/// <reference path="../../lite-window.d.ts" />

import type { SectionDescriptor } from '../types.js';

function health(): LiteHealthBridge {
  const bridge = window.lite?.health;
  if (bridge === undefined) {
    throw new Error('preload bridge `window.lite.health` is not available');
  }
  return bridge;
}

export const mountDiagnostics: SectionDescriptor['mount'] = (container) => {
  let disposed = false;
  let copyResetTimer: ReturnType<typeof setTimeout> | null = null;

  const root = document.createElement('div');
  root.className = 'diag-card';
  container.appendChild(root);

  void renderInitial(root);

  return (): void => {
    disposed = true;
    if (copyResetTimer !== null) {
      clearTimeout(copyResetTimer);
      copyResetTimer = null;
    }
    container.innerHTML = '';
  };

  async function renderInitial(target: HTMLElement): Promise<void> {
    let bridge: LiteHealthBridge;
    try {
      bridge = health();
    } catch (err) {
      target.innerHTML = bridgeMissingHTML((err as Error).message);
      return;
    }
    await refresh(target, bridge);
  }

  async function refresh(target: HTMLElement, bridge: LiteHealthBridge): Promise<void> {
    target.innerHTML = loadingHTML();
    let snap: LiteAppHealthSnapshotView;
    try {
      snap = await bridge.snapshot();
    } catch (err) {
      if (disposed) return;
      target.innerHTML = errorHTML((err as Error).message);
      attachActionHandlers(target, null, bridge);
      return;
    }
    if (disposed) return;
    target.innerHTML = snapshotHTML(snap);
    attachActionHandlers(target, snap, bridge);
  }

  function attachActionHandlers(
    target: HTMLElement,
    snap: LiteAppHealthSnapshotView | null,
    bridge: LiteHealthBridge
  ): void {
    const refreshBtn = target.querySelector<HTMLButtonElement>('#diag-refresh');
    if (refreshBtn !== null) {
      refreshBtn.addEventListener('click', () => {
        void refresh(target, bridge);
      });
    }
    const copyBtn = target.querySelector<HTMLButtonElement>('#diag-copy');
    if (copyBtn !== null) {
      copyBtn.addEventListener('click', () => {
        if (snap === null) return;
        void copyJson(copyBtn, JSON.stringify(snap, null, 2));
      });
    }
    const discoveryBtn = target.querySelector<HTMLButtonElement>(
      '#diag-spaces-discovery-run'
    );
    const discoveryOutput = target.querySelector<HTMLPreElement>(
      '#diag-spaces-discovery-output'
    );
    if (discoveryBtn !== null && discoveryOutput !== null) {
      discoveryBtn.addEventListener('click', () => {
        void runSpacesDiscovery(discoveryBtn, discoveryOutput);
      });
    }
  }

  /**
   * Engineer "Run discovery" handler. Calls the Spaces bridge,
   * renders the result envelope as pretty JSON in a pre block.
   * Disables the button while in flight so double-clicks don't
   * stack queries.
   */
  async function runSpacesDiscovery(
    btn: HTMLButtonElement,
    output: HTMLPreElement
  ): Promise<void> {
    const spaces = window.lite?.spaces;
    if (spaces === undefined) {
      output.hidden = false;
      output.textContent =
        'Spaces bridge is unavailable. Open the Spaces window once so the bridge is bound.';
      return;
    }
    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = 'Running…';
    output.hidden = false;
    output.textContent = 'Running discovery (Q1-Q4) against the configured Neon endpoint…';
    try {
      const envelope = await spaces.runDiscovery();
      if (disposed) return;
      output.textContent = JSON.stringify(envelope, null, 2);
    } catch (err) {
      if (disposed) return;
      output.textContent =
        err instanceof Error ? `Error: ${err.message}` : `Error: ${String(err)}`;
    } finally {
      if (!disposed) {
        btn.disabled = false;
        btn.textContent = originalLabel;
      }
    }
  }

  async function copyJson(btn: HTMLButtonElement, json: string): Promise<void> {
    const original = btn.textContent ?? 'Copy as JSON';
    try {
      await navigator.clipboard.writeText(json);
      btn.textContent = 'Copied';
      btn.disabled = true;
    } catch {
      btn.textContent = 'Copy failed';
    }
    if (copyResetTimer !== null) clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
      copyResetTimer = null;
    }, 1200);
  }
};

// ---------------------------------------------------------------------------
// HTML builders
// ---------------------------------------------------------------------------

function loadingHTML(): string {
  return `
    <div class="diag-toolbar">
      <div class="diag-toolbar-text">Loading snapshot…</div>
    </div>
  `;
}

function errorHTML(message: string): string {
  return `
    <div class="diag-toolbar">
      <div class="diag-toolbar-text">Snapshot failed</div>
      <div class="diag-toolbar-actions">
        <button type="button" id="diag-refresh" class="btn-secondary">Try again</button>
      </div>
    </div>
    <div class="banner error">${escapeHtml(message)}</div>
  `;
}

function bridgeMissingHTML(message: string): string {
  return `
    <div class="banner error">
      Diagnostics is unavailable: ${escapeHtml(message)}
    </div>
  `;
}

function snapshotHTML(snap: LiteAppHealthSnapshotView): string {
  return [
    toolbarHTML(snap),
    introHTML(),
    appSectionHTML(snap.app, snap.capturedAt),
    windowsSectionHTML(snap.windows),
    authSectionHTML(snap.auth),
    totpSectionHTML(snap.totp),
    neonSectionHTML(snap.neon),
    updaterSectionHTML(snap.updater),
    diagnosticsSectionHTML(snap.diagnostics),
    spacesDiscoverySectionHTML(),
  ].join('');
}

/**
 * Engineer-only "Show raw discovery queries" section. The Discovery
 * panel was removed from the Spaces window in chunk 3o (Home view);
 * this section keeps the runner accessible for debugging the
 * verification queries Q1-Q4 (see lite/spaces/HOME-V1.md and
 * lite/spaces/discovery.ts).
 *
 * Renders a button + an empty results container. The click handler
 * is attached in `attachActionHandlers()`. Output is plain JSON
 * (the rich card-based renderer ships in the spaces bundle, not the
 * settings bundle, and isn't worth duplicating for the engineer
 * surface).
 */
function spacesDiscoverySectionHTML(): string {
  return `
    <section class="diag-section">
      <h3 class="diag-section-title">Spaces Discovery (engineer)</h3>
      <p class="diag-intro">
        Re-runs the four verification Cypher queries that gated the original
        Phase 0.5 Spaces design (entity inventory, provenance edges,
        agent presence, ACL filtering). Surfaced here for engineers to
        debug the schema; the Spaces window itself uses the Home view
        instead. See <code>lite/spaces/HOME-V1.md</code>.
      </p>
      <div class="diag-toolbar">
        <div class="diag-toolbar-actions">
          <button type="button" id="diag-spaces-discovery-run" class="btn-secondary">
            Run discovery
          </button>
        </div>
      </div>
      <pre id="diag-spaces-discovery-output" class="diag-discovery-output" hidden></pre>
    </section>
  `;
}

function toolbarHTML(snap: LiteAppHealthSnapshotView): string {
  const captured = formatDate(snap.capturedAt);
  return `
    <div class="diag-toolbar">
      <div class="diag-toolbar-text">Captured ${escapeHtml(captured)}</div>
      <div class="diag-toolbar-actions">
        <button type="button" id="diag-copy" class="btn-secondary">Copy as JSON</button>
        <button type="button" id="diag-refresh" class="btn-primary">Refresh</button>
      </div>
    </div>
  `;
}

function introHTML(): string {
  return `
    <p class="diag-intro">
      A pull-based snapshot of "what is true right now?" across documented Lite modules.
      Token values, the TOTP secret / current code, and the Neon password cannot appear here
      by type construction -- this panel shows presence booleans and metadata only.
      Full token values, when needed, live in the Account section.
    </p>
  `;
}

function appSectionHTML(app: LiteHealthAppSnapshotView, capturedAt: string): string {
  const startedIso = new Date(app.startedAt).toISOString();
  return sectionHTML(
    'App',
    [
      ['Version', app.version],
      ['Platform', `${app.platform} / ${app.arch}`],
      ['Uptime', formatDuration(app.uptimeMs)],
      ['Started', formatDate(startedIso)],
      ['User data', app.userDataPath.length > 0 ? app.userDataPath : '—'],
      ['Captured', formatDate(capturedAt)],
    ]
  );
}

function windowsSectionHTML(windows: LiteHealthWindowSnapshotView[]): string {
  if (windows.length === 0) {
    return sectionEmptyHTML('Windows', 'No open windows reported.');
  }
  const items = windows
    .map((w) => {
      const flags: string[] = [];
      if (w.focused) flags.push('focused');
      if (w.visible) flags.push('visible');
      if (w.destroyed) flags.push('destroyed');
      const flagsText = flags.length > 0 ? ` <span class="diag-pill-row">${flags.map(pillHTML).join('')}</span>` : '';
      const title = w.title.length > 0 ? escapeHtml(w.title) : '<em>(untitled)</em>';
      const url = w.url.length > 0 ? escapeHtml(w.url) : '—';
      return `
        <li class="diag-window">
          <div class="diag-window-head">
            <span class="diag-pill diag-pill-${escapeAttr(w.type)}">${escapeHtml(w.type)}</span>
            <span class="diag-window-title">${title}</span>
            ${flagsText}
          </div>
          <div class="diag-window-url">${url}</div>
        </li>
      `;
    })
    .join('');
  return `
    <section class="diag-section">
      <h3 class="diag-section-title">Windows <span class="diag-section-count">(${windows.length})</span></h3>
      <ul class="diag-window-list">${items}</ul>
    </section>
  `;
}

function authSectionHTML(auth: LiteHealthAuthSnapshotView): string {
  const rows: Array<[string, string]> = [
    ['Status', auth.signedIn ? 'Signed in' : 'Signed out'],
    ['Environment', auth.environment],
  ];
  if (auth.signedIn) {
    rows.push(['Account', auth.accountId ?? '—']);
    if (auth.email !== undefined) rows.push(['Email', auth.email]);
    rows.push(['mult token', auth.hasMultToken ? 'In memory' : 'Not captured this session']);
    rows.push(['Account token', auth.hasAccountToken ? 'Captured' : 'Not captured']);
    if (auth.expiresAt !== undefined) rows.push(['Expires', formatDate(new Date(auth.expiresAt).toISOString())]);
  }
  return sectionHTML('Account', rows);
}

function totpSectionHTML(totp: LiteHealthTotpSnapshotView): string {
  if (!totp.configured) {
    return sectionEmptyHTML('Two-Factor', 'No authenticator secret configured.');
  }
  const rows: Array<[string, string]> = [['Configured', 'Yes']];
  if (totp.metadata !== undefined) {
    if (totp.metadata.issuer !== undefined) rows.push(['Issuer', totp.metadata.issuer]);
    if (totp.metadata.account !== undefined) rows.push(['Account', totp.metadata.account]);
    if (totp.metadata.secretLength !== undefined) {
      rows.push(['Secret length', `${totp.metadata.secretLength} chars`]);
    }
  }
  if (totp.hasCurrentCode) {
    const remaining = totp.secondsRemaining;
    rows.push([
      'Current code',
      remaining !== undefined ? `Available · ${remaining}s remaining` : 'Available',
    ]);
  } else {
    rows.push(['Current code', 'Could not generate']);
  }
  return sectionHTML('Two-Factor', rows);
}

function neonSectionHTML(neon: LiteHealthNeonSnapshotView): string {
  if (!neon.configured) {
    return sectionEmptyHTML('OAGI (Neon)', 'Not configured. Set the endpoint and Neo4j Aura URI in the OAGI section.');
  }
  const rows: Array<[string, string]> = [
    ['Configured', 'Yes'],
    ['Ready', neon.ready ? 'Yes' : 'No'],
  ];
  if (neon.endpoint !== undefined) rows.push(['Endpoint', neon.endpoint]);
  if (neon.uri !== undefined) rows.push(['URI', neon.uri]);
  if (neon.user !== undefined) rows.push(['User', neon.user]);
  if (neon.database !== undefined) rows.push(['Database', neon.database]);
  rows.push(['Password', neon.hasPassword ? 'Set' : 'Not set']);
  return sectionHTML('OAGI (Neon)', rows);
}

function updaterSectionHTML(updater: LiteHealthUpdaterSnapshotView): string {
  const rows: Array<[string, string]> = [
    ['Failed install attempts', String(updater.failedAttempts)],
  ];
  if (updater.lastAttemptVersion !== null) {
    rows.push(['Last attempted version', updater.lastAttemptVersion]);
  }
  if (updater.lastAttemptTime !== null) {
    rows.push(['Last attempt', formatDate(updater.lastAttemptTime)]);
  }
  if (updater.failedAttempts === 0 && updater.lastAttemptVersion === null) {
    rows.push(['Last attempt', 'Never']);
  }
  return sectionHTML('Updater', rows);
}

function diagnosticsSectionHTML(diag: LiteHealthDiagnosticsSnapshotView): string {
  const rows: Array<[string, string]> = [
    ['Recent errors', String(diag.recentErrorCount)],
    ['Recent warnings', String(diag.recentWarnCount)],
  ];
  if (diag.lastError !== undefined) {
    rows.push(['Last error', diag.lastError]);
  }
  return sectionHTML('Recent activity (last 200 events)', rows);
}

function sectionHTML(title: string, rows: Array<[string, string]>): string {
  const items = rows
    .map(
      ([k, v]) => `
        <div class="diag-row">
          <dt>${escapeHtml(k)}</dt>
          <dd>${valueHTML(v)}</dd>
        </div>
      `
    )
    .join('');
  return `
    <section class="diag-section">
      <h3 class="diag-section-title">${escapeHtml(title)}</h3>
      <dl class="diag-grid">${items}</dl>
    </section>
  `;
}

function sectionEmptyHTML(title: string, message: string): string {
  return `
    <section class="diag-section">
      <h3 class="diag-section-title">${escapeHtml(title)}</h3>
      <div class="diag-empty">${escapeHtml(message)}</div>
    </section>
  `;
}

function valueHTML(v: string): string {
  if (v === '—' || v === '') return '<span class="diag-muted">—</span>';
  if (v.startsWith('<')) return v;
  return escapeHtml(v);
}

function pillHTML(text: string): string {
  return `<span class="diag-pill diag-pill-${escapeAttr(text)}">${escapeHtml(text)}</span>`;
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (totalMin < 60) return `${totalMin}m ${sec}s`;
  const totalHr = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  if (totalHr < 24) return `${totalHr}h ${min}m`;
  const days = Math.floor(totalHr / 24);
  const hr = totalHr % 24;
  return `${days}d ${hr}h`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '-');
}
