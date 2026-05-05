/**
 * Chrome (tab bar + home view) renderer.
 *
 * Runs in lite's main window webContents. Subscribes to the main
 * process via the preload-exposed `window.lite.mainWindow.*` bridge,
 * renders the tab bar from the live tab list, and forwards click
 * events back through the bridge.
 *
 * Also hosts the Home view's auth/welcome logic, ported from the
 * retired `lite/placeholder.ts`. Home is what the user sees when
 * `activeId === null` -- the main process hides every tab view in
 * that state, so the home content is uncovered.
 *
 * Loaded as an external script (not inline) so the strict CSP
 * `script-src 'self'` allows execution.
 */

/// <reference path="../lite-window.d.ts" />

// File is a module so esbuild treats it as ESM input.
export {};

// ---------------------------------------------------------------------------
// Constants + state
// ---------------------------------------------------------------------------

const ENV: LiteAuthEnvironment = 'edison';

let tabs: LiteMainWindowTab[] = [];
let activeId: string | null = null;

// ---------------------------------------------------------------------------
// Tab bar render
// ---------------------------------------------------------------------------

function mainWindow(): LiteMainWindowBridge {
  const mw = window.lite?.mainWindow;
  if (mw === undefined) {
    throw new Error('preload bridge `window.lite.mainWindow` is not available');
  }
  return mw;
}

function renderTabBar(): void {
  const list = document.getElementById('tab-list');
  const homePill = document.getElementById('home-pill');
  if (list === null || homePill === null) return;

  // Toggle active state on the Home pill.
  homePill.classList.toggle('active', activeId === null);
  homePill.setAttribute('aria-selected', String(activeId === null));

  // Toggle home view visibility -- when an agent tab is active in the
  // main process, its WebContentsView covers the home content; when
  // not, we still want a smooth fade rather than a stark slot. v1:
  // just hide the home content visually when something else is foregrounded.
  const homeView = document.getElementById('home-view');
  if (homeView !== null) {
    homeView.style.visibility = activeId === null ? 'visible' : 'hidden';
  }

  list.innerHTML = '';
  for (const tab of tabs) {
    list.appendChild(buildPill(tab));
  }
}

function buildPill(tab: LiteMainWindowTab): HTMLElement {
  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'tab-pill' + (tab.id === activeId ? ' active' : '');
  pill.setAttribute('role', 'tab');
  pill.setAttribute('aria-selected', String(tab.id === activeId));
  pill.dataset['id'] = tab.id;
  pill.title = tab.label;

  const labelSpan = document.createElement('span');
  labelSpan.className = 'tab-pill-label';
  labelSpan.textContent = tab.label;
  pill.appendChild(labelSpan);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'tab-pill-close';
  closeBtn.setAttribute('aria-label', 'Close ' + tab.label);
  closeBtn.textContent = '×'; // ×
  closeBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    void mainWindow().closeTab(tab.id).catch(() => undefined);
  });
  pill.appendChild(closeBtn);

  pill.addEventListener('click', () => {
    void mainWindow().activateTab(tab.id).catch(() => undefined);
  });

  return pill;
}

function wireHomePill(): void {
  const homePill = document.getElementById('home-pill');
  if (homePill === null) return;
  homePill.addEventListener('click', () => {
    void mainWindow().goHome().catch(() => undefined);
  });
}

// ---------------------------------------------------------------------------
// Home view: auth + welcome (ported from placeholder.ts)
// ---------------------------------------------------------------------------

function shortenAccountId(id: string): string {
  if (id.length <= 12) return id;
  return id.slice(0, 8) + '...' + id.slice(-4);
}

function getAuthBlock(): HTMLElement | null {
  return document.getElementById('auth-block');
}

function renderSignedOut(errorText: string | null): void {
  const block = getAuthBlock();
  if (block === null) return;
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
  if (block === null) return;
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
  if (block === null) return;
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
  link.textContent = 'Need a 2FA code? Open Settings -> Two-Factor';
  link.addEventListener('click', () => {
    void settings.open();
  });
  block.appendChild(link);
}

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
    /* best-effort */
  }
  renderSignedOut(null);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function bootstrap(): Promise<void> {
  // 1. Populate the version text.
  const versionEl = document.getElementById('version');
  const version = window.lite?.version;
  if (versionEl !== null && typeof version === 'string' && version.length > 0) {
    versionEl.textContent = 'v' + version;
  }

  // 2. Wire static buttons in the home view.
  const initialBtn = document.getElementById('signin-btn');
  if (initialBtn !== null) {
    initialBtn.addEventListener('click', () => {
      void startSignIn();
    });
  }
  const openStoreBtn = document.getElementById('open-store-btn');
  if (openStoreBtn !== null) {
    openStoreBtn.addEventListener('click', () => {
      const idw = window.lite?.idw;
      if (idw === undefined) return;
      void idw.openStore().catch(() => undefined);
    });
  }
  const manageBtn = document.getElementById('manage-agents-btn');
  if (manageBtn !== null) {
    manageBtn.addEventListener('click', () => {
      const settings = window.lite?.settings;
      if (settings === undefined) return;
      void settings.open('idws').catch(() => undefined);
    });
  }

  // 3. Wire the Home pill click.
  wireHomePill();

  // 4. Wire auth flows.
  const auth = window.lite?.auth;
  if (auth !== undefined) {
    auth.onSessionChanged((payload) => {
      if (payload.env !== ENV) return;
      if (payload.session !== null) {
        renderSignedIn(payload.session);
      } else {
        renderSignedOut(null);
      }
    });
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

  // 5. Subscribe to tab list changes from the main process.
  const mw = window.lite?.mainWindow;
  if (mw !== undefined) {
    mw.onTabsChanged((payload) => {
      tabs = payload.tabs;
      activeId = payload.activeId;
      renderTabBar();
    });
    // Initial fetch -- in case we missed an early broadcast.
    try {
      const initialTabs = await mw.listTabs();
      tabs = initialTabs;
      const active = await mw.getActiveTabId();
      activeId = active.activeId;
      renderTabBar();
    } catch {
      /* tab bar starts empty; nothing to do */
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    void bootstrap();
  });
} else {
  void bootstrap();
}
