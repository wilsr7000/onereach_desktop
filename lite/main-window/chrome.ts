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

function getAuthBlock(): HTMLElement | null {
  return document.getElementById('auth-block');
}

type SignedOutHint =
  | { kind: 'error'; text: string }
  | { kind: 'cancelled' }
  | { kind: 'twofa-needs-setup' }
  | null;

function renderSignedOut(hint: SignedOutHint): void {
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

  if (hint === null) return;

  if (hint.kind === 'error') {
    const banner = document.createElement('div');
    banner.className = 'error-banner';
    banner.textContent = hint.text;
    block.appendChild(banner);
    return;
  }

  if (hint.kind === 'cancelled') {
    const banner = document.createElement('div');
    banner.className = 'info-banner';
    banner.textContent = 'Sign-in window closed. Click Sign in to GSX to try again.';
    block.appendChild(banner);
    return;
  }

  if (hint.kind === 'twofa-needs-setup') {
    const banner = document.createElement('div');
    banner.className = 'warn-banner';
    const headline = document.createElement('div');
    headline.className = 'warn-banner-headline';
    headline.textContent = 'OneReach is asking for a 2FA code.';
    banner.appendChild(headline);
    const body = document.createElement('div');
    body.className = 'warn-banner-body';
    body.textContent =
      'Lite has no authenticator secret saved yet. Open Settings -> Two-Factor and paste your setup secret, then try signing in again.';
    banner.appendChild(body);
    const settings = window.lite?.settings;
    if (settings !== undefined) {
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'warn-banner-action';
      link.textContent = 'Open Settings -> Two-Factor';
      link.addEventListener('click', () => {
        void settings.open('two-factor');
      });
      banner.appendChild(link);
    }
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

  // The "edison / <accountId>" line was useful for verifying
  // capture during dev but is noise for users -- the env name and
  // partial account id mean nothing to them. The full details
  // still live in Settings -> Account for diagnostics.

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
    // Pass the section id so the link goes directly to Two-Factor
    // instead of dropping the user on the default Account section.
    void settings.open('two-factor');
  });
  block.appendChild(link);
}

async function startSignIn(): Promise<void> {
  const auth = window.lite?.auth;
  if (auth === undefined) {
    renderSignedOut({ kind: 'error', text: 'Auth bridge unavailable. Try restarting the app.' });
    return;
  }
  renderSigningIn();
  try {
    const result = await auth.signIn(ENV);
    renderSignedIn(result.session);
  } catch (err) {
    const parsed = auth.parseError(err);
    if (parsed !== null && parsed.code === 'AUTH_CANCELLED') {
      // Surface a friendly hint instead of silently flipping back to
      // the bare button -- new users sometimes close the window
      // expecting it to do something else and end up confused why
      // the app "did nothing."
      renderSignedOut({ kind: 'cancelled' });
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
    renderSignedOut({ kind: 'error', text: message });
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
  // "Open Spaces" — peer to the OAGI / Manage Agents CTAs. Routes
  // through the spaces bridge (window.lite.spaces.open) so the same
  // single-instance BrowserWindow pattern handles focus on repeat
  // clicks. Silently no-ops if the bridge isn't wired (signed-out
  // boot before initSpaces runs).
  const openSpacesBtn = document.getElementById('open-spaces-btn');
  if (openSpacesBtn !== null) {
    openSpacesBtn.addEventListener('click', () => {
      const spaces = window.lite?.spaces;
      if (spaces === undefined) return;
      void spaces.open().catch(() => undefined);
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
    // Subscribe to 2FA-needs-setup broadcasts so the user gets a
    // contextual banner the moment the autofill watcher discovers
    // they need to save their authenticator setup secret.
    auth.on2FANeedsSetup(() => {
      renderSignedOut({ kind: 'twofa-needs-setup' });
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

  // 6. Onboarding checklist: show + auto-update on every relevant
  //    state change.
  void wireOnboardingCard();
}

// ─── onboarding card ─────────────────────────────────────────────────────
//
// Renders a small "Set up your workspace" card on the home view AFTER
// the user signs in. Each row has a plain-language outcome title, a
// one-line subtitle that explains the actual benefit, and a button
// labeled with the next action. Hidden when:
//   - The user is not yet signed in (the big Sign-In button above is
//     the CTA in that state -- a checklist row repeating "Sign in to
//     GSX" is noise).
//   - All visible steps are complete.
//   - The user explicitly clicked the X to dismiss.
//
// The 'signed-in' step is still tracked in KV so we can decide
// whether to show the card at all, but it is NOT rendered as a row
// (would be redundant with the visible Sign-In button).

interface OnboardingStep {
  id: LiteOnboardingStepId;
  /** Plain-language outcome -- what the user gets, not the feature name. */
  title: string;
  /** One-line "what this gives you" copy. */
  subtitle: string;
  /** Action button label. */
  buttonLabel: string;
  /** Run on button click. */
  action: () => void;
}

async function wireOnboardingCard(): Promise<void> {
  const card = document.getElementById('onboarding-card');
  if (card === null) return;
  const onboardingBridge = window.lite?.onboarding;
  if (onboardingBridge === undefined) return;

  // Mark steps complete as they happen.
  const auth = window.lite?.auth;
  const mw = window.lite?.mainWindow;
  const totp = window.lite?.totp;

  // Initial sync: read live state and mark anything already true.
  try {
    if (auth !== undefined) {
      const session = await auth.getSession(ENV);
      if (session.session !== null) {
        await onboardingBridge.markComplete('signed-in');
      }
    }
    if (totp !== undefined) {
      const result = await totp.hasSecret();
      if (result.hasSecret === true) {
        await onboardingBridge.markComplete('two-factor-saved');
      }
    }
    if (mw !== undefined) {
      const tabsList = await mw.listTabs();
      if (tabsList.length > 0) {
        await onboardingBridge.markComplete('first-agent-opened');
      }
    }
  } catch {
    /* best-effort */
  }

  // Subscribe to changes that should auto-tick the boxes.
  if (auth !== undefined) {
    auth.onSessionChanged((payload) => {
      if (payload.env !== ENV) return;
      if (payload.session !== null) {
        void onboardingBridge.markComplete('signed-in').then(refreshOnboardingCard);
      }
    });
  }
  if (mw !== undefined) {
    mw.onTabsChanged((payload) => {
      if (payload.tabs.length > 0) {
        void onboardingBridge.markComplete('first-agent-opened').then(refreshOnboardingCard);
      }
    });
  }
  // The two-factor secret can change while Settings is open in a
  // child window. The chrome doesn't get a direct event, but we can
  // re-poll on focus (cheap enough).
  window.addEventListener('focus', () => {
    void rePollOnboardingState();
  });

  // Wire dismiss button.
  const dismissBtn = document.getElementById('onboarding-dismiss');
  if (dismissBtn !== null) {
    dismissBtn.addEventListener('click', () => {
      void onboardingBridge.dismiss().then(() => {
        const c = document.getElementById('onboarding-card');
        if (c !== null) c.setAttribute('hidden', '');
      });
    });
  }

  await refreshOnboardingCard();
}

async function rePollOnboardingState(): Promise<void> {
  const onboardingBridge = window.lite?.onboarding;
  if (onboardingBridge === undefined) return;
  const totp = window.lite?.totp;
  try {
    if (totp !== undefined) {
      const result = await totp.hasSecret();
      if (result.hasSecret === true) {
        await onboardingBridge.markComplete('two-factor-saved');
      }
    }
    await refreshOnboardingCard();
  } catch {
    /* best-effort */
  }
}

async function refreshOnboardingCard(): Promise<void> {
  const card = document.getElementById('onboarding-card');
  if (card === null) return;
  const onboardingBridge = window.lite?.onboarding;
  if (onboardingBridge === undefined) return;

  let state;
  try {
    state = await onboardingBridge.load();
  } catch {
    return;
  }

  // Explicit dismissal wins.
  if (state.dismissedAt !== null) {
    card.setAttribute('hidden', '');
    return;
  }

  // Hide the card until the user is signed in. The Sign-In button
  // above the card is the call to action when signed out; a "Sign in
  // to GSX" row in the card is just noise (and confusing -- "GSX"
  // means nothing to a brand-new user).
  const signedIn = state.completedAt['signed-in'] !== undefined;
  if (!signedIn) {
    card.setAttribute('hidden', '');
    return;
  }

  // Visible steps: outcome titles + subtitles + action buttons.
  // 'signed-in' is intentionally NOT rendered (already implied by
  // the card being visible at all).
  const steps: OnboardingStep[] = [
    {
      id: 'two-factor-saved',
      title: 'Skip the 2FA copy-paste',
      subtitle:
        'If your OneReach account uses two-factor sign-in, save your authenticator setup once and Lite fills in the 6-digit codes for you.',
      buttonLabel: 'Set up auto-fill',
      action: () => {
        void window.lite?.settings?.open('two-factor');
      },
    },
    {
      id: 'first-agent-opened',
      title: 'Open an AI agent',
      subtitle:
        'Pick ChatGPT, Claude, Gemini, or one of your team\u2019s agents from the IDW menu. Each one opens as a tab here.',
      buttonLabel: 'Browse agents',
      action: () => {
        void window.lite?.idw?.openStore();
      },
    },
  ];

  // Hide the card when every visible step is done -- the user has
  // finished setup; no reason to keep nagging.
  const allDone = steps.every((s) => state.completedAt[s.id] !== undefined);
  if (allDone) {
    card.setAttribute('hidden', '');
    return;
  }

  card.removeAttribute('hidden');
  const list = document.getElementById('onboarding-list');
  if (list === null) return;
  list.innerHTML = '';
  for (const step of steps) {
    const done = state.completedAt[step.id] !== undefined;
    const row = document.createElement('div');
    row.className = 'onboarding-row' + (done ? ' done' : '');

    const status = document.createElement('span');
    status.className = 'onboarding-status';
    status.setAttribute('aria-hidden', 'true');
    status.textContent = done ? '\u2713' : '';
    row.appendChild(status);

    const text = document.createElement('div');
    text.className = 'onboarding-text';
    const title = document.createElement('div');
    title.className = 'onboarding-row-title';
    title.textContent = step.title;
    text.appendChild(title);
    const sub = document.createElement('div');
    sub.className = 'onboarding-row-subtitle';
    sub.textContent = step.subtitle;
    text.appendChild(sub);
    row.appendChild(text);

    if (!done) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'onboarding-row-action';
      btn.textContent = step.buttonLabel;
      btn.addEventListener('click', () => step.action());
      row.appendChild(btn);
    }

    list.appendChild(row);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    void bootstrap();
  });
} else {
  void bootstrap();
}
