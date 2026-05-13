/**
 * Spaces window renderer.
 *
 * Phase 0 scope:
 *   - Wire the active-scope state (default: Uncategorized).
 *   - Click handling on sidebar rows so the wiring is observable
 *     (the active row swaps; the main pane echoes the active scope id).
 *
 * Phase 0.5 (this file) scope:
 *   - Wire the Discovery panel: button click -> window.lite.spaces.runDiscovery
 *   - Render per-query cards with status pill, rationale, summary, rows
 *   - Copy-as-Markdown action via discoveryResultsToMarkdown()
 *
 * Phase 1 will replace the discovery panel with the real Spaces list +
 * Uncategorized count; Phase 2 lands `items.list` + cards + detail panel.
 *
 * Built as an IIFE bundle by esbuild. Talks to the main process via the
 * preload bridge (`window.lite.spaces.*`).
 */

import { UNCATEGORIZED_SPACE_ID } from './scope.js';
import {
  discoveryResultsToMarkdown,
  type DiscoveryQueryResult,
  type DiscoveryResults,
} from './discovery-format.js';

// `window.lite.spaces.*` is declared globally in `lite/lite-window.d.ts`.
// All renderer entry points share that declaration.

// ─── State ──────────────────────────────────────────────────────────────

interface SpacesRendererState {
  activeScopeId: string;
  lastDiscovery: DiscoveryResults | null;
  discoveryInFlight: boolean;
}

const state: SpacesRendererState = {
  activeScopeId: UNCATEGORIZED_SPACE_ID,
  lastDiscovery: null,
  discoveryInFlight: false,
};

// ─── Bootstrap ──────────────────────────────────────────────────────────

function init(): void {
  applyActiveRow(state.activeScopeId);
  renderActiveScope();
  wireSidebarClicks();
  wireDiscoveryPanel();
}

function wireSidebarClicks(): void {
  const sidebar = document.getElementById('spaces-sidebar');
  if (sidebar === null) return;

  sidebar.addEventListener('click', (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const row = target.closest<HTMLElement>('.spaces-row');
    if (row === null) return;
    const scopeId = row.getAttribute('data-scope-id');
    if (typeof scopeId !== 'string' || scopeId.length === 0) return;
    setActiveScope(scopeId);
  });
}

function setActiveScope(scopeId: string): void {
  if (scopeId === state.activeScopeId) return;
  state.activeScopeId = scopeId;
  applyActiveRow(scopeId);
  renderActiveScope();
}

function applyActiveRow(scopeId: string): void {
  const rows = Array.from(document.querySelectorAll<HTMLElement>('.spaces-row'));
  for (const row of rows) {
    const id = row.getAttribute('data-scope-id');
    row.classList.toggle('is-active', id === scopeId);
  }
}

function renderActiveScope(): void {
  const echo = document.getElementById('spaces-active-scope');
  if (echo !== null) echo.textContent = state.activeScopeId;
}

// ─── Discovery panel ────────────────────────────────────────────────────

function wireDiscoveryPanel(): void {
  const runBtn = document.getElementById('spaces-discovery-run');
  const copyBtn = document.getElementById('spaces-discovery-copy');

  if (runBtn instanceof HTMLButtonElement) {
    runBtn.addEventListener('click', () => {
      void runDiscovery();
    });
  }

  if (copyBtn instanceof HTMLButtonElement) {
    copyBtn.addEventListener('click', () => {
      void copyMarkdown();
    });
  }
}

async function runDiscovery(): Promise<void> {
  if (state.discoveryInFlight) return;
  state.discoveryInFlight = true;
  setRunButton({ busy: true });
  showSummary({
    kind: 'info',
    text: 'Running Q1–Q4 against the configured Neon endpoint…',
  });
  clearResults();

  try {
    const bridge = window.lite?.spaces;
    if (bridge === undefined) {
      showSummary({
        kind: 'failure',
        text: 'Spaces bridge is unavailable. Reload the window.',
      });
      return;
    }
    const envelope = await bridge.runDiscovery();
    if (envelope.ok === false) {
      showSummary({
        kind: 'failure',
        text: `Discovery failed before any query ran: [${envelope.error.code}] ${envelope.error.message}`,
      });
      return;
    }
    // The bridge result type at the global declaration is wider than
    // the runner's `DiscoveryResults`; rows is typed as `Record<string,
    // unknown>[]`. The runtime shape is identical -- cast once at the
    // bridge boundary.
    const value = envelope.value as unknown as DiscoveryResults;
    state.lastDiscovery = value;
    renderResults(value);
    showSummary(buildSummary(value));
    setCopyButtonEnabled(true);
  } catch (err) {
    showSummary({
      kind: 'failure',
      text: `Discovery threw at the bridge: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  } finally {
    state.discoveryInFlight = false;
    setRunButton({ busy: false });
  }
}

async function copyMarkdown(): Promise<void> {
  if (state.lastDiscovery === null) return;
  const md = discoveryResultsToMarkdown(state.lastDiscovery);
  try {
    await navigator.clipboard.writeText(md);
    flashCopyButton('Copied');
  } catch {
    flashCopyButton('Copy failed');
  }
}

// ─── Renderers ──────────────────────────────────────────────────────────

function setRunButton(opts: { busy: boolean }): void {
  const runBtn = document.getElementById('spaces-discovery-run');
  if (!(runBtn instanceof HTMLButtonElement)) return;
  runBtn.disabled = opts.busy;
  runBtn.textContent = opts.busy ? 'Running…' : 'Run Discovery';
}

function setCopyButtonEnabled(enabled: boolean): void {
  const copyBtn = document.getElementById('spaces-discovery-copy');
  if (!(copyBtn instanceof HTMLButtonElement)) return;
  copyBtn.disabled = !enabled;
}

function flashCopyButton(label: string): void {
  const copyBtn = document.getElementById('spaces-discovery-copy');
  if (!(copyBtn instanceof HTMLButtonElement)) return;
  const original = copyBtn.textContent;
  copyBtn.textContent = label;
  setTimeout(() => {
    copyBtn.textContent = original;
  }, 1500);
}

type SummaryKind = 'info' | 'success' | 'warning' | 'failure';

function showSummary(opts: { kind: SummaryKind; text: string }): void {
  const summary = document.getElementById('spaces-discovery-summary');
  if (summary === null) return;
  summary.hidden = false;
  summary.classList.remove('is-warning', 'is-failure');
  if (opts.kind === 'warning') summary.classList.add('is-warning');
  if (opts.kind === 'failure') summary.classList.add('is-failure');
  summary.textContent = opts.text;
}

function clearResults(): void {
  const container = document.getElementById('spaces-discovery-results');
  if (container !== null) container.replaceChildren();
}

function renderResults(results: DiscoveryResults): void {
  const container = document.getElementById('spaces-discovery-results');
  if (container === null) return;
  container.replaceChildren();
  for (const r of results.results) {
    container.appendChild(buildCard(r));
  }
}

function buildCard(r: DiscoveryQueryResult): HTMLElement {
  const card = document.createElement('article');
  card.className = 'spaces-discovery-card';

  const head = document.createElement('div');
  head.className = 'spaces-discovery-card-head';

  const title = document.createElement('h4');
  title.className = 'spaces-discovery-card-title';
  title.textContent = r.title;
  head.appendChild(title);

  const gatingPill = document.createElement('span');
  gatingPill.className =
    'spaces-discovery-pill ' +
    (r.gating === 'GATING'
      ? 'spaces-discovery-pill-gating'
      : 'spaces-discovery-pill-informational');
  gatingPill.textContent = r.gating;
  head.appendChild(gatingPill);

  const statusPill = document.createElement('span');
  statusPill.className =
    'spaces-discovery-pill ' +
    (r.ok ? 'spaces-discovery-pill-status-ok' : 'spaces-discovery-pill-status-fail');
  statusPill.textContent = r.ok ? 'OK' : 'FAILED';
  head.appendChild(statusPill);

  card.appendChild(head);

  const rationale = document.createElement('p');
  rationale.className = 'spaces-discovery-rationale';
  rationale.textContent = r.rationale;
  card.appendChild(rationale);

  if (r.summary !== undefined) {
    const summary = document.createElement('div');
    summary.className = 'spaces-discovery-summary-line';
    summary.textContent = r.summary;
    card.appendChild(summary);
  }

  const meta = document.createElement('div');
  meta.className = 'spaces-discovery-meta';
  meta.textContent = `${r.id} · ${r.durationMs}ms · ${r.rows.length} row(s)`;
  card.appendChild(meta);

  if (r.notes.length > 0) {
    const notes = document.createElement('ul');
    notes.className = 'spaces-discovery-notes';
    for (const note of r.notes) {
      const li = document.createElement('li');
      li.textContent = note;
      notes.appendChild(li);
    }
    card.appendChild(notes);
  }

  if (r.ok) {
    if (r.rows.length > 0) {
      const rowsPre = document.createElement('pre');
      rowsPre.className = 'spaces-discovery-rows';
      rowsPre.textContent = JSON.stringify(r.rows, null, 2);
      card.appendChild(rowsPre);
    }
  } else if (r.error !== undefined) {
    const errBox = document.createElement('div');
    errBox.className = 'spaces-discovery-error';
    errBox.textContent = `[${r.error.code}] ${r.error.message}`;
    card.appendChild(errBox);
  }

  return card;
}

function buildSummary(results: DiscoveryResults): {
  kind: SummaryKind;
  text: string;
} {
  const total = results.results.length;
  const passed = results.results.filter((r) => r.ok).length;
  const failedGating = results.results.filter(
    (r) => !r.ok && r.gating === 'GATING'
  ).length;
  const failedInfo = results.results.filter(
    (r) => !r.ok && r.gating === 'INFORMATIONAL'
  ).length;

  if (failedGating > 0) {
    return {
      kind: 'failure',
      text: `Discovery complete — ${passed}/${total} passed, ${failedGating} GATING failure(s). Resolve gating items before Phase 2 design lock.`,
    };
  }
  if (failedInfo > 0) {
    return {
      kind: 'warning',
      text: `Discovery complete — ${passed}/${total} passed, ${failedInfo} INFORMATIONAL failure(s). Note results and continue.`,
    };
  }
  return {
    kind: 'success',
    text: `Discovery complete — all ${total} queries passed. Capture the Markdown export and resolve Q5/Q6 with the Edison team.`,
  };
}

// ─── Boot ───────────────────────────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
