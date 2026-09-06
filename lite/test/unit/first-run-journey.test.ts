/**
 * @vitest-environment jsdom
 *
 * The first-run journey (2026-09-02 review): install → open → sign in
 * → what you'll need → the Claude key asked for WHEN a feature needs
 * it, with a walkthrough.
 *
 * What the review found on a virgin install, each pinned here:
 *   1. the hosted Home covered the boot-chat sign-in wall — a new user
 *      saw a chat with no sign-in anywhere (the visibility rule only
 *      hid login-shaped URLs; a static page never is one);
 *   2. the boot chat said "quick sign-in needed" and nothing else —
 *      the Claude key was discovered the first time a feature failed;
 *   3. that failure was a developer message ("…ai-config.json in the
 *      app data folder. See lite/ai/README.md.") shown to an end user;
 *   4. the onboarding checklist module had no readers AND no writers.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { shouldShowRemoteHome } from '../../main-window/home-url-store.js';
import { buildWhatYouNeed, buildWelcomeFirstTime } from '../../boot-chat/boot-chat.js';

const read = (...candidates: string[]): string => {
  const found = candidates.map((p) => resolve(p)).find((p) => existsSync(p));
  if (found === undefined) throw new Error(`not found: ${candidates.join(', ')}`);
  return readFileSync(found, 'utf8');
};

// ── 1. The wall is Home when signed out ──────────────────────────────
describe('a signed-out install shows the sign-in wall, never the hosted Home', () => {
  it('the rule is the session, not the URL', () => {
    for (const url of [
      'https://files.edison.api.onereach.ai/public/x/gsx-expert-ui/index.html',
      'https://idw.edison.onereach.ai/gsx-expert',
      'https://idw.edison.onereach.ai/login?idwId=gsx-expert',
      'https://example.com',
    ]) {
      expect(shouldShowRemoteHome(url, 'edison', false), `signed out: ${url}`).toBe(false);
      expect(shouldShowRemoteHome(url, 'edison', true), `signed in: ${url}`).toBe(true);
    }
  });

  it('the remote view mounts hidden without a session and follows sign-in/out', () => {
    const s = read('main-window/window.ts', 'lite/main-window/window.ts');
    expect(s).toContain("view.setVisible(getAuthApi().getSession('edison') !== null);");
    // Both directions: sign-out hides, sign-in shows — before the early return.
    const handler = s.indexOf('getAuthApi().onSessionChanged((env, session) => {');
    const follow = s.indexOf('homeFeedView.setVisible(session !== null);', handler);
    const earlyReturn = s.indexOf('if (session === null) return;', handler);
    expect(follow).toBeGreaterThan(handler);
    expect(earlyReturn).toBeGreaterThan(follow);
  });
});

// ── 2. The shopping list, up front, in the Human voice ───────────────
describe('the first-run beat says what you will need', () => {
  it('lists sign-in now, the Claude key when needed (with a walkthrough), 2FA optional', () => {
    const el = buildWhatYouNeed();
    const text = el.textContent ?? '';
    expect(text).toMatch(/what you'll need/i);
    expect(text).toMatch(/OneReach \(GSX\) sign-in/);
    expect(text).toMatch(/Claude API key/);
    expect(text).toMatch(/walk you through/i);
    expect(text).toMatch(/2FA/);
    expect(el.classList.contains('hand-note')).toBe(true); // the pencilled margin note
    expect(el.querySelectorAll('li').length).toBe(3);
  });

  it('rides the existing first-time welcome without breaking its pins', () => {
    const el = buildWelcomeFirstTime();
    const text = el.textContent ?? '';
    expect(text).toMatch(/new Onereach App/i); // the standing pin
    expect(text).toMatch(/quick sign-in needed/i);
    expect(text).toMatch(/what you'll need/i);
  });

  it('the very first sign-in is recorded once — with no bubble, because nothing under the hosted Home is seen', () => {
    const s = read('boot-chat/boot-chat.ts', 'lite/boot-chat/boot-chat.ts');
    const fn = s.indexOf('async function noteFirstSignIn(');
    expect(fn).toBeGreaterThan(-1);
    const end = s.indexOf('async function renderWelcomeAndDigest(', fn);
    const block = s.slice(fn, end > fn ? end : fn + 900);
    expect(block).toContain("state.completedAt['signed-in'] !== undefined) return;"); // once, ever
    expect(block).toContain("onboarding.markComplete('signed-in')"); // the module gets a writer
    // 2026-09-02 review: a post-sign-in bubble is covered by the hosted
    // Home the instant a session exists, and would greet every EXISTING
    // install with "You're in" after the update. The key story lives on
    // the signed-out wall and in the just-in-time walkthrough instead.
    expect(block).not.toContain('appendBubble(');
    // It runs in the welcome path, before the digest.
    const welcome = s.indexOf('async function renderWelcomeAndDigest(');
    const call = s.indexOf('await noteFirstSignIn(deps);', welcome);
    const digest = s.indexOf('await renderEventDigestSection(deps);', welcome);
    expect(call).toBeGreaterThan(welcome);
    expect(digest).toBeGreaterThan(call);
  });

  it('the hand voice is a token, not a hard-coded font (theme guardrail)', () => {
    const sig = read('signature.css', 'lite/signature.css');
    expect(sig).toContain('--or-font-hand:');
    const chrome = read('main-window/chrome.css', 'lite/main-window/chrome.css');
    expect(chrome).toContain('.hand-note');
    expect(chrome).toContain('font-family: var(--or-font-hand)');
  });
});

// ── 3. The key is asked for when needed, with a walkthrough ──────────
describe('the just-in-time Claude key walkthrough', () => {
  const renderer = (): string => read('spaces/spaces.ts', 'lite/spaces/spaces.ts');

  it('gates every user-triggered Claude feature', () => {
    const s = renderer();
    for (const reason of ['Drafting a journey map', 'Drafting a checklist', 'Agentic search', 'Auto-fill']) {
      expect(s, `${reason} is not gated`).toContain(`ensureClaudeKey('${reason}')`);
    }
  });

  it('a present key never shows the dialog; a missing bridge never blocks', () => {
    const s = renderer();
    const fn = s.indexOf('async function ensureClaudeKey(');
    const block = s.slice(fn, fn + 900);
    expect(block).toContain('if (ai === undefined) return true;');
    expect(block).toContain('if (has.ok === true && has.value.hasKey) return true;');
  });

  it('walks through getting a key: console link, create, paste — then verifies live before saving', async () => {
    const mod = await import('../../spaces/spaces.js');
    const el = mod.buildClaudeKeyWalkthrough('Drafting a checklist');
    const text = el.textContent ?? '';
    expect(text).toContain('Drafting a checklist needs a Claude API key');
    expect(el.querySelectorAll('.spaces-keywalk-steps li').length).toBe(3);
    const link = el.querySelector<HTMLAnchorElement>('.spaces-keywalk-link');
    expect(link?.href).toBe('https://console.anthropic.com/settings/keys');
    expect(link?.target).toBe('_blank'); // routed to the OS browser by the window's popup handler
    expect(text).toMatch(/sk-ant-/);
    expect(text).toMatch(/keychain/);
    expect(el.querySelector('.spaces-keywalk-input')?.getAttribute('type')).toBe('password');
    expect(el.querySelector('.spaces-keywalk-go')?.textContent).toBe('Save key & continue');
    expect(el.querySelector('.spaces-keywalk-later')?.textContent).toBe('Not now');
    expect(el.querySelector('.spaces-keywalk-head')?.classList.contains('hand-note')).toBe(true);
    const s = renderer();
    const fn = s.indexOf('async function ensureClaudeKey(');
    const block = s.slice(fn, fn + 5000);
    const test = block.indexOf('await ai.testKey(key)');
    const save = block.indexOf('await ai.saveKey(key)');
    expect(test).toBeGreaterThan(-1);
    expect(save).toBeGreaterThan(test); // verified live BEFORE it is saved
  });

  it('is a real modal: the shared scrim + box, a ×, and an Escape that does not leak to the dialog beneath', () => {
    // 2026-09-02 review: with only the confirm classes there is no
    // overlay rule at all — the walkthrough rendered as a strip pinned
    // to the bottom of the window with the app clickable behind it.
    const s = renderer();
    const fn = s.indexOf('async function ensureClaudeKey(');
    const block = s.slice(fn, fn + 5000);
    expect(block).toContain("backdrop.className = 'spaces-member-picker-backdrop spaces-confirm-backdrop';");
    expect(block).toContain("panel.className = 'spaces-member-picker spaces-confirm-panel spaces-keywalk';");
    expect(block).toContain("close.className = 'spaces-member-picker-close';");
    // Escape is document-level (any focus) and claimed, so the checklist
    // editor that asked for the key keeps what the person typed.
    expect(block).toContain("document.addEventListener('keydown', onKey);");
    expect(block).toContain('ev.preventDefault();');
  });

  it('the not-configured error no longer reads like a developer note', () => {
    const s = read('ai/service.ts', 'lite/ai/service.ts');
    expect(s).not.toContain('ai-config.json in the app data folder');
    expect(s).not.toContain('See lite/ai/README.md');
    // ADR-094: either key-based provider fixes it, so the remediation names both.
    expect(s).toContain('Add a Claude or OpenAI API key in Settings → AI');
  });
});

// ── 4. Settings → AI walks it through too ────────────────────────────
describe('Settings → AI', () => {
  it('shows the three steps and opens the console in the OS browser', () => {
    const s = read('settings/sections/ai.ts', 'lite/settings/sections/ai.ts');
    expect(s).toContain('how to get a key');
    expect(s).toContain('https://console.anthropic.com/settings/keys');
    expect(s).toContain('API keys → Create Key');
    const w = read('settings/window.ts', 'lite/settings/window.ts');
    expect(w).toContain('setWindowOpenHandler');
    expect(w).toContain('shell.openExternal(url)');
  });
});
