/**
 * Chrome (tab bar + home view) renderer.
 *
 * Runs in lite's main window webContents. Subscribes to the main
 * process via the preload-exposed `window.lite.mainWindow.*` bridge,
 * renders the tab bar from the live tab list, and forwards click
 * events back through the bridge.
 *
 * The Home tab IS the conversational chat surface — what used to be
 * the standalone boot-chat page now lives inside this renderer. The
 * chat verifies the session, offers sign-in inline when needed, and
 * settles into a welcome + recent-activity digest. Opening an IDW
 * (ChatGPT, Claude, …) covers the chat with that tab's
 * WebContentsView; closing the tab restores the chat.
 *
 * Loaded as an external script (not inline) so the strict CSP
 * `script-src 'self'` allows execution.
 */

/// <reference path="../lite-window.d.ts" />

import {
  runBootChat,
  type BootChatDeps,
} from '../boot-chat/boot-chat.js';
import type { CompressableEvent } from '../boot-chat/event-compressor.js';

// File is a module so esbuild treats it as ESM input.
export {};

// ---------------------------------------------------------------------------
// Constants + state
// ---------------------------------------------------------------------------

const ENV: LiteAuthEnvironment = 'edison';

let tabs: LiteMainWindowTab[] = [];
let activeId: string | null = null;

/** Re-run guard so duplicate runChat() calls during sign-in races don't double-render. */
let chatRunning = false;

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

  // Toggle home view visibility — when an agent tab is active in the
  // main process, its WebContentsView covers the home content; when
  // not, the chat surface is revealed underneath. Hidden visually so
  // the renderer keeps running (no rehydration cost on tab switch).
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
// Home view: chat surface (formerly boot-chat.html)
// ---------------------------------------------------------------------------

/**
 * Adapter from the live `window.lite.spaces.home.recentEvents` bridge
 * to the simpler `listRecentEvents` shape `runBootChat` expects. Kept
 * inside chrome.ts so the boot-chat module stays free of the full
 * spaces type surface (Rule 11).
 */
function buildSpacesAdapter(): BootChatDeps['spaces'] | undefined {
  const spaces = window.lite?.spaces;
  if (spaces === undefined) return undefined;
  return {
    listRecentEvents: async (
      opts?: { limit?: number; since?: number }
    ) => {
      try {
        const result = await spaces.home.recentEvents(opts ?? {});
        if (result.ok === true) {
          return { ok: true as const, value: result.value as CompressableEvent[] };
        }
        return {
          ok: false as const,
          error: { code: result.error.code, message: result.error.message },
        };
      } catch (err) {
        return {
          ok: false as const,
          error: {
            code: 'BRIDGE_THREW',
            message: (err as Error).message,
          },
        };
      }
    },
  };
}

function getThreadEl(): HTMLElement | null {
  return document.getElementById('boot-chat-thread');
}

function getActionsEl(): HTMLElement | null {
  return document.getElementById('boot-chat-actions');
}

/**
 * Run the chat in the home view. Soft-resets the thread + actions so
 * repeat invocations (e.g. after sign-out) start clean. The chat fires
 * onFinish once it settles, which un-suspends the re-sign-in prompter
 * in main-lite so background dialogs can surface again.
 */
async function runChat(): Promise<void> {
  if (chatRunning) return;
  const thread = getThreadEl();
  const actions = getActionsEl();
  if (thread === null || actions === null) return;
  const auth = window.lite?.auth;
  if (auth === undefined) {
    // Bridge missing — surface a static error and bail.
    thread.replaceChildren();
    const err = document.createElement('div');
    err.className = 'boot-chat-bubble boot-chat-bubble-bot is-error';
    const body = document.createElement('div');
    body.className = 'boot-chat-bubble-body';
    body.textContent = 'Auth bridge unavailable. Restart the app.';
    err.appendChild(body);
    thread.appendChild(err);
    return;
  }

  chatRunning = true;
  thread.replaceChildren();
  actions.replaceChildren();
  actions.hidden = true;

  // The chat's preload-facing auth shape is a narrow subset of the
  // real bridge; pass the methods runBootChat cares about. (Casts are
  // safe — the bridge surface is a superset.)
  const chatAuth: BootChatDeps['auth'] = {
    getSession: (env) => auth.getSession(env) as ReturnType<BootChatDeps['auth']['getSession']>,
    hasValidSession: (env) =>
      auth.hasValidSession(env) as ReturnType<BootChatDeps['auth']['hasValidSession']>,
    signIn: (env) =>
      auth.signIn(env) as ReturnType<BootChatDeps['auth']['signIn']>,
  };

  const spaces = buildSpacesAdapter();
  const host = window.lite?.bootChat;

  try {
    await runBootChat({
      thread,
      actions,
      auth: chatAuth,
      ...(spaces !== undefined ? { spaces } : {}),
      onFinish: () => {
        // Un-suspend the main-process re-sign-in prompter. The IPC
        // payload is intentionally empty — the host treats this as a
        // one-shot "chat has settled" signal.
        try {
          host?.finish();
        } catch {
          /* best-effort — boot-chat bridge is optional */
        }
      },
    });
  } finally {
    chatRunning = false;
  }
}

/**
 * Toggle the Sign-in / Sign-out button visibility based on session state.
 * The two buttons share the shortcuts row; exactly one is visible at a
 * time so the user always has the right action available even when the
 * home-view boot-chat is hidden behind an open IDW tab.
 */
function updateSignOutButton(signedIn: boolean): void {
  const out = document.getElementById('signout-btn');
  const inBtn = document.getElementById('signin-btn');
  if (signedIn) {
    out?.removeAttribute('hidden');
    inBtn?.setAttribute('hidden', '');
  } else {
    out?.setAttribute('hidden', '');
    inBtn?.removeAttribute('hidden');
  }
}

async function startSignOut(): Promise<void> {
  const auth = window.lite?.auth;
  if (auth === undefined) return;
  try {
    await auth.signOut(ENV);
  } catch {
    /* best-effort */
  }
  updateSignOutButton(false);
  // Re-run the chat so the user lands on the welcome + sign-in CTA.
  await runChat();
}

/**
 * Trigger a fresh sign-in from the always-available chrome button.
 * Coalesces against any in-flight sign-in via the auth store's
 * `inFlight` map, so clicking this while the boot-chat's sign-in is
 * already running joins the same auth window rather than spawning a
 * duplicate.
 */
async function startSignIn(): Promise<void> {
  const auth = window.lite?.auth;
  if (auth === undefined) return;
  const btn = document.getElementById('signin-btn');
  if (btn instanceof HTMLButtonElement) {
    btn.disabled = true;
    btn.textContent = 'Signing in…';
  }
  try {
    await auth.signIn(ENV);
    updateSignOutButton(true);
  } catch {
    // User cancelled or sign-in failed. Restore the button so they can
    // retry; the cookie listener still sets the session up if cookies
    // landed before the throw, so we re-probe.
    try {
      const result = await auth.getSession(ENV);
      updateSignOutButton(result.session !== null);
    } catch {
      updateSignOutButton(false);
    }
  } finally {
    if (btn instanceof HTMLButtonElement) {
      btn.disabled = false;
      btn.textContent = 'Sign in to OneReach';
    }
  }
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

  // 2. Wire shortcut buttons in the home view.
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
  const signOutBtn = document.getElementById('signout-btn');
  if (signOutBtn !== null) {
    signOutBtn.addEventListener('click', () => {
      void startSignOut();
    });
  }
  const signInBtn = document.getElementById('signin-btn');
  if (signInBtn !== null) {
    signInBtn.addEventListener('click', () => {
      void startSignIn();
    });
  }
  // Spaces OR-logo button (upper-left of the tab bar) — ported from
  // the full app's `#black-hole-button`. Single-instance bridge.
  const spacesOrBtn = document.getElementById('spaces-or-button');
  if (spacesOrBtn !== null) {
    spacesOrBtn.addEventListener('click', () => {
      const spaces = window.lite?.spaces;
      if (spaces === undefined) return;
      void spaces.open().catch(() => undefined);
    });
  }

  // 3. Wire the Home pill click.
  wireHomePill();

  // 4. Wire auth lifecycle. The chat owns the visible sign-in flow;
  //    this listener just keeps the Sign-out shortcut button in sync
  //    and re-runs the chat when the user drops a session externally
  //    (e.g. server-side revoke triggered through a background KV op).
  const auth = window.lite?.auth;
  if (auth !== undefined) {
    auth.onSessionChanged((payload) => {
      if (payload.env !== ENV) return;
      const signedIn = payload.session !== null;
      updateSignOutButton(signedIn);
      if (!signedIn) {
        // Soft-restart so the chat lands on the welcome + sign-in CTA.
        void runChat();
      }
    });
    // 2FA-needs-setup is handled by the chat itself now — when sign-in
    // throws with `AUTH_TWO_FACTOR_NEEDS_SETUP` the chat shows an
    // error bubble. We still listen so the Settings shortcut on the
    // shortcut row gets a fresh entry. v1: no-op (the chat error
    // copy is enough; the user can hit Manage Agents → Two-Factor).
    auth.on2FANeedsSetup(() => {
      /* future: route to Settings → Two-Factor */
    });
    try {
      const result = await auth.getSession(ENV);
      updateSignOutButton(result.session !== null);
    } catch {
      /* leave the sign-out button hidden */
    }
  }

  // 5. Subscribe to tab list changes from the main process.
  const mw = window.lite?.mainWindow;
  if (mw !== undefined) {
    mw.onTabsChanged((payload) => {
      tabs = payload.tabs;
      activeId = payload.activeId;
      renderTabBar();
    });
    // Initial fetch — in case we missed an early broadcast.
    try {
      const initialTabs = await mw.listTabs();
      tabs = initialTabs;
      const active = await mw.getActiveTabId();
      activeId = active.activeId;
      renderTabBar();
    } catch {
      /* tab bar starts empty */
    }
  }

  // 6. Start the chat. Drives verify → welcome → digest (or sign-in).
  await runChat();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    void bootstrap();
  });
} else {
  void bootstrap();
}
