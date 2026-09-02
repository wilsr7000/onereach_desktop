/**
 * Onereach.ai Lite — home-view chat renderer.
 *
 * Owns the chat surface that lives inside chrome.html's home view —
 * it IS the Home tab. Other IDWs (ChatGPT, Claude, etc.) open as
 * tabs alongside it; closing them returns the user to this chat.
 *
 * Historically this was a separate "boot-chat" page that swapped to
 * chrome.html via a `lite:boot-chat:finish` IPC. That handoff is gone —
 * the chat now runs in chrome's main webContents and stays there for
 * the life of the window. The `onFinish` callback is fired the moment
 * the chat settles (post-verify for returning users, post-sign-in for
 * everyone else) and is now only used by main-lite to un-suspend the
 * re-sign-in prompter so background dialogs don't race the chat at boot.
 *
 * State machine:
 *
 *   start
 *     │
 *     ▼
 *   verifying   ←──── render "Welcome to Onereach" + typing indicator
 *     │
 *     ├─── (probe valid) ──▶ welcome-returning ──▶ digest ──▶ onFinish
 *     │
 *     └─── (probe invalid / no session) ──▶ welcome-first-time / expired
 *                                            │
 *                                            ▼
 *                                          (user clicks Sign in)
 *                                            │
 *                                            ▼
 *                                          signing-in (OAuth popup
 *                                          opened via bridge)
 *                                            │
 *                                          (cookies captured)
 *                                            │
 *                                            ▼
 *                                          welcome-returning ──▶ digest ──▶ onFinish
 *
 * Pure-builder pattern: every bubble / action button is constructed
 * by a small builder; the state machine is a tiny dispatcher that
 * appends new bubbles and swaps the action row. Tests exercise the
 * builders + the state-transition table directly.
 */

/// <reference path="../lite-window.d.ts" />

import {
  compressEventLog,
  type CompressableEvent,
  type EventDigest,
} from './event-compressor.js';

// Type-only view of the auth bridge we depend on. Mirrors the
// `AuthBridge` shape in `preload-lite.ts`; declaring locally keeps
// boot-chat free of cross-module imports per Rule 11.
interface BootChatAuthBridge {
  getSession(env: 'edison'): Promise<{
    session: { accountId: string; email?: string; capturedAt: number } | null;
  }>;
  hasValidSession(env: 'edison'): Promise<{ valid: boolean }>;
  signIn(
    env: 'edison',
    opts?: { timeoutMs?: number }
  ): Promise<{
    session: { accountId: string; email?: string; capturedAt: number };
  }>;
}

/**
 * Subset of the spaces bridge we lean on for the event-log digest.
 * Declared locally so boot-chat doesn't reach into the spaces
 * preload type surface.
 */
interface BootChatSpacesBridge {
  listRecentEvents(opts?: {
    limit?: number;
    since?: number;
  }): Promise<
    | { ok: true; value: CompressableEvent[] }
    | { ok: false; error: { code: string; message: string } }
  >;
}

export type BootChatState =
  | 'verifying'
  | 'welcome-first-time'
  | 'welcome-expired'
  | 'welcome-returning'
  | 'signing-in'
  | 'ready'
  | 'error';

// ─── Pure builders ──────────────────────────────────────────────────────

export function buildBotBubble(text: string): HTMLElement {
  const bubble = document.createElement('div');
  bubble.className = 'boot-chat-bubble boot-chat-bubble-bot';
  const avatar = document.createElement('span');
  avatar.className = 'boot-chat-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = '◆';
  const body = document.createElement('div');
  body.className = 'boot-chat-bubble-body';
  // textContent → no HTML injection.
  body.textContent = text;
  bubble.appendChild(avatar);
  bubble.appendChild(body);
  return bubble;
}

export function buildBotBubbleRich(node: HTMLElement): HTMLElement {
  const bubble = document.createElement('div');
  bubble.className = 'boot-chat-bubble boot-chat-bubble-bot';
  const avatar = document.createElement('span');
  avatar.className = 'boot-chat-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = '◆';
  const body = document.createElement('div');
  body.className = 'boot-chat-bubble-body';
  body.appendChild(node);
  bubble.appendChild(avatar);
  bubble.appendChild(body);
  return bubble;
}

export function buildUserBubble(text: string): HTMLElement {
  const bubble = document.createElement('div');
  bubble.className = 'boot-chat-bubble boot-chat-bubble-user';
  const avatar = document.createElement('span');
  avatar.className = 'boot-chat-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = 'You';
  const body = document.createElement('div');
  body.className = 'boot-chat-bubble-body';
  body.textContent = text;
  bubble.appendChild(avatar);
  bubble.appendChild(body);
  return bubble;
}

export function buildTypingBubble(): HTMLElement {
  const bubble = document.createElement('div');
  bubble.className = 'boot-chat-bubble boot-chat-bubble-bot boot-chat-bubble-typing';
  bubble.setAttribute('data-typing', 'true');
  const avatar = document.createElement('span');
  avatar.className = 'boot-chat-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = '◆';
  const body = document.createElement('div');
  body.className = 'boot-chat-bubble-body';
  body.setAttribute('aria-label', 'Working');
  for (let i = 0; i < 3; i++) {
    const dot = document.createElement('span');
    dot.className = 'boot-chat-typing-dot';
    body.appendChild(dot);
  }
  bubble.appendChild(avatar);
  bubble.appendChild(body);
  return bubble;
}

export function buildErrorBubble(text: string): HTMLElement {
  const bubble = buildBotBubble(text);
  bubble.classList.add('is-error');
  return bubble;
}

export interface BootChatActionButtonOpts {
  label: string;
  primary?: boolean;
  icon?: string;
  onClick: () => void;
}

export function buildActionButton(opts: BootChatActionButtonOpts): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = opts.primary === false
    ? 'boot-chat-button boot-chat-button-secondary'
    : 'boot-chat-button';
  if (typeof opts.icon === 'string' && opts.icon.length > 0) {
    const icon = document.createElement('span');
    icon.className = 'boot-chat-button-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = opts.icon;
    btn.appendChild(icon);
  }
  const label = document.createElement('span');
  label.textContent = opts.label;
  btn.appendChild(label);
  btn.addEventListener('click', opts.onClick);
  return btn;
}

/**
 * Render a Welcome-first-time bubble with bold name reference. Returns
 * the inner content element so the bubble can be wrapped.
 */
export function buildWelcomeFirstTime(): HTMLElement {
  const wrap = document.createElement('span');
  const line1 = document.createElement('div');
  line1.innerHTML = ''; // populated below
  const strong = document.createElement('strong');
  strong.textContent = 'Welcome to your new Onereach App.';
  line1.appendChild(strong);
  wrap.appendChild(line1);
  const line2 = document.createElement('div');
  line2.style.marginTop = '6px';
  line2.textContent = "I'll get you connected — quick sign-in needed.";
  wrap.appendChild(line2);
  wrap.appendChild(buildWhatYouNeed());
  return wrap;
}

/**
 * First-run review (2026-09-02): a new install said "quick sign-in
 * needed" and nothing else — the user learned about the Claude key the
 * first time a feature failed with a developer message. This is the
 * whole shopping list, up front, in the Human voice (a pencilled
 * margin note — DESIGN-LANGUAGE.md's hand traces), and it promises the
 * one thing that matters: the key is asked for WHEN it is needed, with
 * a walkthrough, never as homework.
 */
export function buildWhatYouNeed(): HTMLElement {
  const note = document.createElement('div');
  note.className = 'boot-chat-needs hand-note';
  const head = document.createElement('div');
  head.className = 'boot-chat-needs-head';
  head.textContent = "✎ what you'll need";
  note.appendChild(head);
  const list = document.createElement('ol');
  list.className = 'boot-chat-needs-list';
  const items: Array<[string, string]> = [
    ['your OneReach (GSX) sign-in', 'now — it unlocks your Spaces and agents'],
    ['a Claude API key', "later — I'll ask, and walk you through getting one, the first time a feature needs it"],
    ['2FA setup secret', 'optional — lets me fill your GSX login code for you (Settings → Two-factor)'],
  ];
  for (const [what, when] of items) {
    const li = document.createElement('li');
    const b = document.createElement('strong');
    b.textContent = what;
    li.appendChild(b);
    li.appendChild(document.createTextNode(` — ${when}`));
    list.appendChild(li);
  }
  note.appendChild(list);
  return note;
}

export function buildWelcomeBack(displayName: string): HTMLElement {
  const wrap = document.createElement('span');
  const line1 = document.createElement('div');
  const strong = document.createElement('strong');
  strong.textContent = `Welcome back${displayName.length > 0 ? `, ${displayName}` : ''}.`;
  line1.appendChild(strong);
  wrap.appendChild(line1);
  const line2 = document.createElement('div');
  line2.style.marginTop = '6px';
  line2.textContent = 'Opening your workspace…';
  wrap.appendChild(line2);
  return wrap;
}

/**
 * Welcome-back bubble — historical "your workspace is ready when you
 * are" copy. The live chat no longer renders this bubble; the chat
 * goes straight to a tight headline + event digest. Kept around for
 * backward compatibility with the unit test that exercises this
 * builder directly.
 */
export function buildWelcomeBackPrompt(displayName: string): HTMLElement {
  const wrap = document.createElement('span');
  const line1 = document.createElement('div');
  const strong = document.createElement('strong');
  strong.textContent = `Welcome back${displayName.length > 0 ? `, ${displayName}` : ''}.`;
  line1.appendChild(strong);
  wrap.appendChild(line1);
  const line2 = document.createElement('div');
  line2.style.marginTop = '6px';
  line2.textContent = 'Your workspace is ready when you are.';
  wrap.appendChild(line2);
  return wrap;
}

/**
 * Short welcome headline that PRECEDES the event-log digest bubble.
 * Distinct from `buildWelcomeBackPrompt` because the second line
 * lives in its own digest bubble now, not folded into the greeting.
 */
export function buildWelcomeHeadline(displayName: string): HTMLElement {
  const strong = document.createElement('strong');
  strong.textContent = `Welcome back${displayName.length > 0 ? `, ${displayName}` : ''}.`;
  return strong;
}

/**
 * Render an event-log digest as chat content. Returns the inner node
 * the chat wraps in a bot bubble. Layout:
 *
 *   Since you were last here:
 *     • Alice added 4 items in Engineering
 *     • Audit Agent completed 3 tickets in Q3 Audit
 *     …
 *
 * For an empty digest (no recent activity), returns a soft "nothing
 * new" line so the bubble still has something to say.
 */
export function buildEventDigestBubble(digest: EventDigest): HTMLElement {
  const wrap = document.createElement('span');
  if (digest.bullets.length === 0) {
    wrap.textContent = "It's been quiet — no new activity since you were last here.";
    return wrap;
  }
  const intro = document.createElement('div');
  intro.textContent = 'Since you were last here:';
  wrap.appendChild(intro);

  const list = document.createElement('ul');
  list.className = 'boot-chat-digest-list';
  for (const b of digest.bullets) {
    const li = document.createElement('li');
    li.textContent = b;
    list.appendChild(li);
  }
  wrap.appendChild(list);

  // Footer line when there were more events than bullets shown.
  if (digest.totalEvents > digest.bullets.length) {
    const more = document.createElement('div');
    more.className = 'boot-chat-digest-more';
    more.textContent = `+${digest.totalEvents - digest.bullets.length} more in the timeline.`;
    wrap.appendChild(more);
  }
  return wrap;
}

/**
 * Fetch + render the event-log digest. Soft-fails: missing bridge,
 * bridge errors, or empty results all degrade to a friendly "quiet"
 * bubble (or skip the bubble entirely when the bridge is unavailable).
 */
async function renderEventDigestSection(deps: BootChatDeps): Promise<void> {
  if (deps.spaces === undefined) return;
  // Pull a generous window — the compressor caps display itself.
  let events: CompressableEvent[] = [];
  try {
    const res = await deps.spaces.listRecentEvents({ limit: 50 });
    if (res.ok === true) {
      events = res.value;
    }
  } catch {
    // Soft fail: skip the digest bubble entirely.
    return;
  }
  const digest = compressEventLog(events);
  appendBubble(deps.thread, buildBotBubbleRich(buildEventDigestBubble(digest)));
}

export function buildWelcomeExpired(displayName: string): HTMLElement {
  const wrap = document.createElement('span');
  const line1 = document.createElement('div');
  const strong = document.createElement('strong');
  strong.textContent = `Welcome back${displayName.length > 0 ? `, ${displayName}` : ''}.`;
  line1.appendChild(strong);
  wrap.appendChild(line1);
  const line2 = document.createElement('div');
  line2.style.marginTop = '6px';
  line2.textContent = 'Your session expired — quick re-verify and we\'re good.';
  wrap.appendChild(line2);
  return wrap;
}

// ─── State machine ──────────────────────────────────────────────────────

export interface BootChatDeps {
  thread: HTMLElement;
  actions: HTMLElement;
  auth: BootChatAuthBridge;
  /**
   * Spaces bridge for the event-log digest. Optional — when omitted
   * (e.g. in tests that don't care about the digest), the chat skips
   * the digest bubble entirely and goes straight to the settled state.
   */
  spaces?: BootChatSpacesBridge;
  /**
   * Settled-state handler — invoked once the chat has reached a
   * stable resting state (returning user verified + digest rendered,
   * or sign-in completed for first-time / expired users). The chat
   * stays on screen; this hook is the cue for the host to un-suspend
   * the re-sign-in prompter so background dialogs can fire again.
   * Idempotent — fires at most once per `runBootChat` invocation.
   */
  onFinish: () => void;
  /** Optional schedule helper for tests; defaults to setTimeout. */
  schedule?: (fn: () => void, ms: number) => void;
}

interface BootChatRuntime {
  state: BootChatState;
  /** Cached session (if any) so the welcome bubble knows the name. */
  cachedDisplayName: string;
  /** Set to true once `deps.onFinish` has fired — keeps it one-shot. */
  finishFired: boolean;
}

export async function runBootChat(deps: BootChatDeps): Promise<void> {
  const schedule = deps.schedule ?? ((fn, ms) => window.setTimeout(fn, ms));
  const runtime: BootChatRuntime = {
    state: 'verifying',
    cachedDisplayName: '',
    finishFired: false,
  };

  // Initial greeting + typing indicator.
  appendBubble(deps.thread, buildBotBubble('Welcome to Onereach.'));
  const typing = buildTypingBubble();
  deps.thread.appendChild(typing);

  // Verify in the background.
  try {
    const sessionRes = await deps.auth.getSession('edison');
    const session = sessionRes.session;
    runtime.cachedDisplayName =
      session !== null ? friendlyNameFromSession(session) : '';

    const validRes = await deps.auth.hasValidSession('edison');
    typing.remove();

    if (validRes.valid && session !== null) {
      // Returning, verified. The chat is the Home tab — greet the
      // user, render the digest, then settle. No handoff button.
      await renderWelcomeAndDigest(deps, runtime);
      return;
    }

    if (session !== null) {
      // Session known but expired.
      runtime.state = 'welcome-expired';
      appendBubble(deps.thread, buildBotBubbleRich(buildWelcomeExpired(runtime.cachedDisplayName)));
      showSignInAction(deps, runtime, 'Re-verify');
      return;
    }

    runtime.state = 'welcome-first-time';
    appendBubble(deps.thread, buildBotBubbleRich(buildWelcomeFirstTime()));
    showSignInAction(deps, runtime, 'Sign in with OneReach');
  } catch (err) {
    typing.remove();
    runtime.state = 'error';
    appendBubble(
      deps.thread,
      buildErrorBubble(
        'Could not check your session — the network might be off. Try again?'
      )
    );
    showRetryAction(deps, runtime);
  }
  // Suppress unused-var warning while keeping `schedule` available
  // for sub-flows (sign-in completion still uses it).
  void schedule;
}

/**
 * Render the post-verify (or post-sign-in) "settled" surface: a
 * welcome headline, the event-log digest, and then fire `onFinish`
 * so the host knows the chat has come to rest. No CTA — the chat IS
 * the Home tab; the user opens IDWs from the tab bar / menu.
 */

/**
 * The first time this install ever signs in, say what happens next —
 * once. Uses the onboarding store (`signed-in` step) as the memory, so
 * the beat never repeats and the checklist finally records the truth.
 * Best-effort: no bridge, or a KV hiccup, and the chat simply moves on.
 */
async function noteFirstSignIn(deps: BootChatDeps): Promise<void> {
  const onboarding = window.lite?.onboarding;
  if (onboarding === undefined) return;
  try {
    const state = await onboarding.load();
    if (state.completedAt['signed-in'] !== undefined) return;
    await onboarding.markComplete('signed-in');
    const wrap = document.createElement('span');
    const line = document.createElement('div');
    line.textContent =
      "You're in. Your Spaces and agents are yours now. One thing to know: some features think with Claude — " +
      "the first time you use one, I'll ask for an API key and show you exactly where to get it.";
    wrap.appendChild(line);
    const note = document.createElement('div');
    note.className = 'hand-note boot-chat-needs-head';
    note.style.marginTop = '8px';
    note.textContent = '✎ no key yet? nothing breaks — it just waits for you';
    wrap.appendChild(note);
    appendBubble(deps.thread, buildBotBubbleRich(wrap));
  } catch {
    /* documentation, not data — never block the welcome */
  }
}

async function renderWelcomeAndDigest(
  deps: BootChatDeps,
  runtime: BootChatRuntime
): Promise<void> {
  runtime.state = 'welcome-returning';
  appendBubble(
    deps.thread,
    buildBotBubbleRich(buildWelcomeHeadline(runtime.cachedDisplayName))
  );
  await noteFirstSignIn(deps);
  await renderEventDigestSection(deps);
  // Hide the action row (any stale Sign In / Retry button is gone now)
  // and fire onFinish exactly once.
  deps.actions.replaceChildren();
  deps.actions.hidden = true;
  runtime.state = 'ready';
  if (!runtime.finishFired) {
    runtime.finishFired = true;
    deps.onFinish();
  }
}

function showSignInAction(
  deps: BootChatDeps,
  runtime: BootChatRuntime,
  label: string
): void {
  deps.actions.replaceChildren();
  const button = buildActionButton({
    label,
    icon: '→',
    onClick: () => {
      void startSignIn(deps, runtime);
    },
  });
  deps.actions.appendChild(button);
  deps.actions.hidden = false;
}

function showRetryAction(deps: BootChatDeps, runtime: BootChatRuntime): void {
  deps.actions.replaceChildren();
  const button = buildActionButton({
    label: 'Retry',
    icon: '↻',
    onClick: () => {
      deps.actions.hidden = true;
      // Soft-reset the thread back to the initial verify path.
      deps.thread.replaceChildren();
      void runBootChat(deps);
    },
  });
  deps.actions.appendChild(button);
  deps.actions.hidden = false;
  void runtime;
}

async function startSignIn(
  deps: BootChatDeps,
  runtime: BootChatRuntime
): Promise<void> {
  runtime.state = 'signing-in';
  deps.actions.hidden = true;
  appendBubble(deps.thread, buildUserBubble('Sign me in'));
  const typing = buildTypingBubble();
  deps.thread.appendChild(typing);
  try {
    const res = await deps.auth.signIn('edison');
    typing.remove();
    runtime.cachedDisplayName = friendlyNameFromSession(res.session);
    // Post-sign-in lands on the same settled surface as a returning
    // user: welcome + event-log digest, then onFinish. No CTA — the
    // chat is the Home tab.
    await renderWelcomeAndDigest(deps, runtime);
  } catch (err) {
    typing.remove();
    runtime.state = 'welcome-first-time';
    const message =
      (err as Error).message.length > 0
        ? (err as Error).message
        : 'Sign-in was cancelled. Want to try again?';
    appendBubble(deps.thread, buildErrorBubble(message));
    showSignInAction(deps, runtime, 'Try again');
  }
}

function appendBubble(thread: HTMLElement, bubble: HTMLElement): void {
  thread.appendChild(bubble);
  // Keep latest bubble in view.
  thread.scrollTop = thread.scrollHeight;
}

/**
 * Pull a friendly name from the session: prefer email's local part,
 * fall back to accountId.
 */
export function friendlyNameFromSession(session: {
  accountId: string;
  email?: string;
}): string {
  const email = typeof session.email === 'string' ? session.email : '';
  if (email.length > 0) {
    const local = email.split('@')[0] ?? '';
    if (local.length > 0) {
      return local
        .split(/[._-]/)
        .filter((p) => p.length > 0)
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
        .join(' ');
    }
  }
  return session.accountId;
}

// ─── Test escape hatch ──────────────────────────────────────────────────
//
// The chat is no longer a standalone bundle — chrome.ts imports the
// builders + state machine and wires the DOM itself. We still surface
// the symbols on `window.__bootChatForTesting` so the existing unit
// tests can import this module and exercise the builders directly.

(window as unknown as { __bootChatForTesting?: unknown }).__bootChatForTesting = {
  buildBotBubble,
  buildBotBubbleRich,
  buildUserBubble,
  buildTypingBubble,
  buildErrorBubble,
  buildActionButton,
  buildWelcomeFirstTime,
  buildWelcomeBack,
  buildWelcomeBackPrompt,
  buildWelcomeHeadline,
  buildWelcomeExpired,
  buildEventDigestBubble,
  compressEventLog,
  friendlyNameFromSession,
  runBootChat,
};
