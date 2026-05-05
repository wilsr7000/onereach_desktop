/**
 * Placeholder window renderer logic. Runs in the main lite window.
 *
 * Communicates with the main process via the preload-exposed bridges
 * declared in `lite/preload-lite.ts`:
 *   - `window.lite.version`           (read app version)
 *   - `window.lite.auth.signIn(env)`  (open auth window, capture token)
 *   - `window.lite.auth.signOut(env)` (clear session)
 *   - `window.lite.auth.getSession`   (load already-captured session)
 *   - `window.lite.auth.onSessionChanged(cb)` (live updates)
 *   - `window.lite.auth.parseError(err)` (extract structured AuthError)
 *
 * Loaded as an external script (not inline) so the strict CSP
 * (`script-src 'self'`) allows execution. Inline `<script>` tags would
 * be blocked.
 */

// Reference the shared global declarations (defines Window.lite +
// Window.bugReport in one place so the two renderer entry points
// don't collide on declaration merging).
/// <reference path="./lite-window.d.ts" />

// File is a module so esbuild treats it as ESM input.
export {};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Per ADR-026, v1 supports Edison only.
const ENV: LiteAuthEnvironment = 'edison';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortenAccountId(id: string): string {
  if (id.length <= 12) return id;
  return id.slice(0, 8) + '...' + id.slice(-4);
}

function getAuthBlock(): HTMLElement {
  const el = document.getElementById('auth-block');
  if (el === null) {
    throw new Error('placeholder: #auth-block not found in DOM');
  }
  return el;
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function renderSignedOut(errorText: string | null): void {
  const block = getAuthBlock();
  block.innerHTML = '';

  const btn = document.createElement('button');
  btn.id = 'signin-btn';
  btn.className = 'signin-button';
  btn.type = 'button';
  btn.textContent = 'Sign in to GSX';
  btn.addEventListener('click', () => {
    void startSignIn();
  });
  block.appendChild(btn);
  appendSettingsShortcut(block);

  if (errorText !== null && errorText.length > 0) {
    const banner = document.createElement('div');
    banner.className = 'error-banner';
    banner.textContent = errorText;
    block.appendChild(banner);
  }
}

function renderSigningIn(): void {
  const block = getAuthBlock();
  block.innerHTML = '';

  const btn = document.createElement('button');
  btn.id = 'signin-btn';
  btn.className = 'signin-button';
  btn.type = 'button';
  btn.disabled = true;
  btn.textContent = 'Signing in...';
  block.appendChild(btn);
  appendSettingsShortcut(block);
}

function renderSignedIn(session: LiteAuthSessionRendererView): void {
  const block = getAuthBlock();
  block.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'signed-in';

  const email = document.createElement('div');
  email.className = 'email';
  email.textContent =
    session.email !== undefined && session.email.length > 0
      ? 'Signed in as ' + session.email
      : 'Signed in';
  wrap.appendChild(email);

  const account = document.createElement('div');
  account.className = 'account';
  account.textContent = ENV + ' / ' + shortenAccountId(session.accountId);
  wrap.appendChild(account);

  const signOutBtn = document.createElement('button');
  signOutBtn.className = 'signout-link';
  signOutBtn.type = 'button';
  signOutBtn.textContent = 'Sign out';
  signOutBtn.addEventListener('click', () => {
    void startSignOut();
  });
  wrap.appendChild(signOutBtn);

  block.appendChild(wrap);
}

function appendSettingsShortcut(block: HTMLElement): void {
  const settings = window.lite?.settings;
  if (settings === undefined) return;

  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'settings-shortcut';
  link.textContent = 'Need a 2FA code? Open Two-Factor settings';
  link.addEventListener('click', () => {
    void settings.open();
  });
  block.appendChild(link);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function startSignIn(): Promise<void> {
  const auth = window.lite?.auth;
  if (auth === undefined) {
    renderSignedOut('Auth bridge unavailable. Try restarting the app.');
    return;
  }
  renderSigningIn();
  try {
    const result = await auth.signIn(ENV);
    renderSignedIn(result.session);
  } catch (err) {
    const parsed = auth.parseError(err);

    // Cancellation is a normal user action -- they closed the auth
    // window themselves -- not an error. Silently return to the
    // signed-out state. A red banner saying "click Sign in to try
    // again" right next to the Sign-in button would be redundant
    // and feel like a failure.
    if (parsed !== null && parsed.code === 'AUTH_CANCELLED') {
      renderSignedOut(null);
      return;
    }

    let message: string;
    if (parsed !== null) {
      message =
        parsed.remediation.length > 0
          ? parsed.message + ' ' + parsed.remediation
          : parsed.message;
    } else if (err !== null && typeof err === 'object' && 'message' in err) {
      message = String((err as { message: unknown }).message);
    } else {
      message = 'Sign-in failed.';
    }
    renderSignedOut(message);
  }
}

async function startSignOut(): Promise<void> {
  const auth = window.lite?.auth;
  if (auth === undefined) {
    renderSignedOut(null);
    return;
  }
  try {
    await auth.signOut(ENV);
  } catch {
    // signOut is best-effort; render signed-out either way.
  }
  renderSignedOut(null);
}

// ---------------------------------------------------------------------------
// Bootstrap (runs once on script load)
// ---------------------------------------------------------------------------

function bootstrap(): void {
  // 1. Populate the version text.
  const versionEl = document.getElementById('version');
  const version = window.lite?.version;
  if (versionEl !== null && typeof version === 'string' && version.length > 0) {
    versionEl.textContent = 'v' + version;
  }

  // 2. Wire the initial Sign-in button rendered by the static HTML.
  const initialBtn = document.getElementById('signin-btn');
  if (initialBtn !== null) {
    initialBtn.addEventListener('click', () => {
      void startSignIn();
    });
  }

  const auth = window.lite?.auth;
  if (auth === undefined) return;

  // 3. Subscribe to session-changed events so sign-in / sign-out from
  //    anywhere updates the UI.
  auth.onSessionChanged((payload) => {
    if (payload.env !== ENV) return;
    if (payload.session !== null) {
      renderSignedIn(payload.session);
    } else {
      renderSignedOut(null);
    }
  });

  // 4. Probe for an already-rehydrated session.
  void auth
    .getSession(ENV)
    .then((result) => {
      if (result.session !== null) {
        renderSignedIn(result.session);
      }
    })
    .catch(() => {
      /* leave the default button */
    });
}

// Run after DOM is ready (the script tag is at the end of <body>, so
// `document.readyState` is 'interactive' or 'complete' here, but be
// defensive in case esbuild moves things later).
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
