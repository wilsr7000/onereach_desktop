/**
 * Account section -- OneReach Edison sign-in.
 *
 * Consumes the auth preload bridge (`window.lite.auth`) per ADR-026.
 * The token never crosses IPC; this section only reads metadata
 * (environment, accountId, email, capturedAt, expiresAt) and triggers
 * sign-in / sign-out flows.
 *
 * v1 surface:
 *   - SIGNED-OUT: "Sign in to OneReach" button -> opens auth window
 *   - SIGNED-IN:  email + accountId + Sign Out button
 *
 * Listens to `onSessionChanged` so the UI refreshes when sign-in
 * completes (the auth window itself does the capture; this section
 * doesn't need to poll). Returns a disposer that detaches the listener.
 */

/// <reference path="../../lite-window.d.ts" />

import type { SectionDescriptor } from '../types.js';

const ENV: LiteAuthEnvironment = 'edison';

function auth(): LiteAuthBridge {
  const a = window.lite?.auth;
  if (a === undefined) {
    throw new Error('preload bridge `window.lite.auth` is not available');
  }
  return a;
}

export const mountAccount: SectionDescriptor['mount'] = (container) => {
  let detachSessionListener: (() => void) | null = null;

  // Initial render against last-known session, then listen for changes.
  void renderState(container);

  try {
    detachSessionListener = auth().onSessionChanged((payload) => {
      if (payload.env !== ENV) return;
      renderSession(container, payload.session);
    });
  } catch {
    // Bridge missing; renderState already handled the error path.
  }

  return (): void => {
    if (detachSessionListener !== null) {
      try {
        detachSessionListener();
      } catch {
        /* best-effort */
      }
    }
    container.innerHTML = '';
  };
};

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

async function renderState(container: HTMLElement): Promise<void> {
  let bridge: LiteAuthBridge;
  try {
    bridge = auth();
  } catch (err) {
    renderBridgeMissing(container, (err as Error).message);
    return;
  }

  try {
    const { session } = await bridge.getSession(ENV);
    renderSession(container, session);
  } catch (err) {
    renderError(container, (err as Error).message);
  }
}

function renderSession(container: HTMLElement, session: LiteAuthSessionRendererView | null): void {
  if (session === null) {
    renderSignedOut(container);
  } else {
    renderSignedIn(container, session);
  }
}

// ---------------------------------------------------------------------------
// SIGNED-OUT
// ---------------------------------------------------------------------------

function renderSignedOut(container: HTMLElement): void {
  container.innerHTML = `
    <div class="acc-card">
      <div class="acc-status">
        <div class="acc-status-icon acc-status-icon-out">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        </div>
        <div class="acc-status-text">
          <div class="acc-status-title">Not signed in</div>
          <div class="acc-status-help">Sign in with OneReach to enable Edison APIs and account-scoped features.</div>
        </div>
      </div>
      <div class="acc-actions">
        <button type="button" id="acc-sign-in" class="btn-primary">Sign in to OneReach</button>
      </div>
      <div id="acc-status" class="banner" style="display: none;"></div>
    </div>
  `;

  const btn = container.querySelector<HTMLButtonElement>('#acc-sign-in');
  const status = container.querySelector<HTMLElement>('#acc-status');
  if (btn === null || status === null) return;

  btn.addEventListener('click', () => {
    void signInFlow(container, btn, status);
  });
}

async function signInFlow(container: HTMLElement, btn: HTMLButtonElement, status: HTMLElement): Promise<void> {
  btn.disabled = true;
  setStatus(status, 'Opening sign-in window…', 'info');
  try {
    await auth().signIn(ENV);
    // Render is driven by the onSessionChanged listener; the in-progress
    // banner clears when the signed-in view paints.
  } catch (err) {
    const parsed = parseAuthError(err);
    if (parsed !== null && parsed.code === 'AUTH_CANCELLED') {
      renderSignedOut(container);
    } else if (parsed !== null) {
      setStatus(status, `${parsed.message} ${parsed.remediation}`.trim(), 'error');
    } else {
      setStatus(status, (err as Error).message ?? 'Sign-in failed.', 'error');
    }
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// SIGNED-IN
// ---------------------------------------------------------------------------

function renderSignedIn(container: HTMLElement, session: LiteAuthSessionRendererView): void {
  const email = session.email !== undefined ? escapeHtml(session.email) : '';
  const account = escapeHtml(session.accountId);
  const captured = formatDate(session.capturedAt);
  const expires = session.expiresAt !== undefined ? formatDate(session.expiresAt) : null;

  container.innerHTML = `
    <div class="acc-card">
      <div class="acc-status">
        <div class="acc-status-icon acc-status-icon-in">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M20 6L9 17l-5-5" />
          </svg>
        </div>
        <div class="acc-status-text">
          <div class="acc-status-title">Signed in to OneReach (Edison)</div>
          ${email !== '' ? `<div class="acc-status-help acc-email">${email}</div>` : ''}
        </div>
      </div>
      <dl class="acc-meta">
        <div class="acc-meta-row">
          <dt>Account</dt>
          <dd class="acc-meta-mono">${account}</dd>
        </div>
        <div class="acc-meta-row">
          <dt>Captured</dt>
          <dd>${captured}</dd>
        </div>
        ${
          expires !== null
            ? `<div class="acc-meta-row"><dt>Expires</dt><dd>${expires}</dd></div>`
            : ''
        }
      </dl>
      <div id="acc-tokens-mount"></div>
      <div class="acc-actions">
        <button type="button" id="acc-sign-out" class="btn-secondary btn-danger">Sign out</button>
      </div>
      <div id="acc-status" class="banner" style="display: none;"></div>
    </div>
  `;

  const btn = container.querySelector<HTMLButtonElement>('#acc-sign-out');
  const status = container.querySelector<HTMLElement>('#acc-status');
  if (btn === null || status === null) return;

  btn.addEventListener('click', () => {
    void signOutFlow(btn, status);
  });

  // Token bundle is rehydrated only via signIn(); fetch it async so
  // the rest of the card renders immediately.
  const tokensMount = container.querySelector<HTMLElement>('#acc-tokens-mount');
  if (tokensMount !== null) {
    void renderTokens(tokensMount);
  }
}

// ---------------------------------------------------------------------------
// Token bundle (mult + or)
// ---------------------------------------------------------------------------

async function renderTokens(mount: HTMLElement): Promise<void> {
  let bundle: LiteAuthTokenBundle | null;
  try {
    const result = await auth().getTokenBundle(ENV);
    bundle = result.bundle;
  } catch {
    mount.innerHTML = '';
    return;
  }

  if (bundle === null) {
    mount.innerHTML = `
      <div class="acc-tokens">
        <div class="acc-tokens-title">Tokens</div>
        <div class="acc-tokens-empty">
          Tokens are cleared on app restart for security. Sign out and sign back in to refresh them in this view.
        </div>
      </div>
    `;
    return;
  }

  const captured = formatDate(bundle.capturedAt);
  const multExpires = bundle.multExpiresAt !== undefined ? formatDate(bundle.multExpiresAt) : null;
  const accountExpires =
    bundle.accountExpiresAt !== undefined ? formatDate(bundle.accountExpiresAt) : null;

  mount.innerHTML = `
    <div class="acc-tokens">
      <div class="acc-tokens-title">Tokens</div>
      <div class="acc-tokens-help">
        Held in memory only -- never written to KV, never logged, cleared on app restart and on sign-out.
        Captured ${escapeHtml(captured)}.
      </div>
      ${tokenBlock('mult', 'mult (API bearer)', bundle.multToken, multExpires)}
      ${tokenBlock('or', 'or (account / session cookie)', bundle.accountToken, accountExpires)}
    </div>
  `;

  for (const id of ['mult', 'or']) {
    const btn = mount.querySelector<HTMLButtonElement>(`#acc-token-copy-${id}`);
    const value = mount.querySelector<HTMLElement>(`#acc-token-value-${id}`);
    if (btn !== null && value !== null) {
      btn.addEventListener('click', () => {
        void copyToken(btn, value.textContent ?? '');
      });
    }
    const toggle = mount.querySelector<HTMLButtonElement>(`#acc-token-toggle-${id}`);
    const body = mount.querySelector<HTMLElement>(`#acc-token-body-${id}`);
    const chevron = toggle?.querySelector<HTMLElement>('.acc-token-toggle-chevron') ?? null;
    if (toggle !== null && body !== null) {
      toggle.addEventListener('click', () => {
        const expanded = toggle.getAttribute('aria-expanded') === 'true';
        const next = !expanded;
        toggle.setAttribute('aria-expanded', String(next));
        if (next) {
          body.removeAttribute('hidden');
          if (chevron !== null) chevron.textContent = '\u25BE';
        } else {
          body.setAttribute('hidden', '');
          if (chevron !== null) chevron.textContent = '\u25B8';
        }
      });
    }
  }
}

function tokenBlock(
  id: string,
  label: string,
  value: string,
  expires: string | null
): string {
  const safeLabel = escapeHtml(label);
  const safeValue = escapeHtml(value);
  const meta = `${value.length} chars${expires !== null ? ` &middot; expires ${escapeHtml(expires)}` : ''}`;
  // Tokens are collapsed by default. The value pane only mounts +
  // becomes visible when the user clicks "Show", which keeps the
  // section scannable when the user just wants to see "yes, both
  // tokens are captured" without staring at two long base64-ish
  // strings on screen all the time.
  return `
    <div class="acc-token" data-token-id="${id}">
      <div class="acc-token-head">
        <button
          type="button"
          class="acc-token-toggle"
          id="acc-token-toggle-${id}"
          aria-expanded="false"
          aria-controls="acc-token-body-${id}"
        >
          <span class="acc-token-toggle-chevron" aria-hidden="true">\u25B8</span>
          <span class="acc-token-label">${safeLabel}</span>
        </button>
        <span class="acc-token-meta">${meta}</span>
      </div>
      <div
        class="acc-token-body"
        id="acc-token-body-${id}"
        hidden
      >
        <div class="acc-token-value-row">
          <pre class="acc-token-value" id="acc-token-value-${id}">${safeValue}</pre>
          <button type="button" class="btn-secondary acc-token-copy" id="acc-token-copy-${id}">Copy</button>
        </div>
      </div>
    </div>
  `;
}

async function copyToken(btn: HTMLButtonElement, value: string): Promise<void> {
  if (value.length === 0) return;
  const original = btn.textContent ?? 'Copy';
  try {
    await navigator.clipboard.writeText(value);
    btn.textContent = 'Copied';
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
    }, 1200);
  } catch {
    btn.textContent = 'Copy failed';
    setTimeout(() => {
      btn.textContent = original;
    }, 1500);
  }
}

async function signOutFlow(btn: HTMLButtonElement, status: HTMLElement): Promise<void> {
  btn.disabled = true;
  setStatus(status, 'Signing out…', 'info');
  try {
    await auth().signOut(ENV);
    // Listener will rerender to signed-out.
  } catch (err) {
    setStatus(status, (err as Error).message ?? 'Sign-out failed.', 'error');
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Error / fallback rendering
// ---------------------------------------------------------------------------

function renderBridgeMissing(container: HTMLElement, message: string): void {
  container.innerHTML = `
    <div class="acc-card">
      <div class="banner error">
        Sign-in is unavailable: ${escapeHtml(message)}
      </div>
    </div>
  `;
}

function renderError(container: HTMLElement, message: string): void {
  container.innerHTML = `
    <div class="acc-card">
      <div class="banner error">
        Could not load account: ${escapeHtml(message)}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

function parseAuthError(err: unknown): LiteAuthErrorJSON | null {
  try {
    return auth().parseError(err);
  } catch {
    return null;
  }
}

function setStatus(banner: HTMLElement, text: string, kind: 'info' | 'success' | 'error'): void {
  banner.textContent = text;
  banner.classList.remove('info', 'success', 'error');
  banner.classList.add(kind);
  banner.style.display = '';
}

function formatDate(epochMs: number): string {
  try {
    return new Date(epochMs).toLocaleString();
  } catch {
    return new Date(epochMs).toISOString();
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
