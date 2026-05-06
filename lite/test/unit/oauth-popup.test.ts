/**
 * OAuth popup helper tests.
 *
 * Verifies the trust boundary that lets OAuth IdP popups stay in
 * the opener's partition (so cookies land in the right jar) while
 * still routing arbitrary third-party popups to the OS browser.
 *
 * No real Electron (`shell.openExternal`, `BrowserWindow`) is
 * involved -- the helper accepts a stub `shellOpenExternal` and a
 * stub logger.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isOAuthPopupUrl,
  buildPopupHandler,
  OAUTH_POPUP_ALLOWLIST,
  attachPopupLifecycle,
  POPUP_PARENT_ORIGIN_GRACE_MS,
} from '../../auth/oauth-popup.js';
import type { BrowserWindow } from 'electron';

describe('isOAuthPopupUrl', () => {
  it('returns true for known IdP origins (exact host match)', () => {
    expect(isOAuthPopupUrl('https://accounts.google.com/o/oauth2/auth')).toBe(true);
    expect(isOAuthPopupUrl('https://login.microsoftonline.com/common/oauth2/authorize')).toBe(true);
    expect(isOAuthPopupUrl('https://appleid.apple.com/auth/authorize')).toBe(true);
    expect(isOAuthPopupUrl('https://github.com/login/oauth/authorize')).toBe(true);
  });

  it('returns true for subdomains of allowlisted hosts', () => {
    expect(isOAuthPopupUrl('https://tenant.auth0.com/authorize')).toBe(true);
    expect(isOAuthPopupUrl('https://my-org.okta.com/oauth2/v1/authorize')).toBe(true);
    expect(isOAuthPopupUrl('https://my-org.okta-emea.com/oauth2/v1/authorize')).toBe(true);
    expect(isOAuthPopupUrl('https://pool.amazoncognito.com/oauth2/authorize')).toBe(true);
  });

  it('returns false for non-allowlisted hosts', () => {
    expect(isOAuthPopupUrl('https://example.com/login')).toBe(false);
    expect(isOAuthPopupUrl('https://attacker.example.com/oauth')).toBe(false);
  });

  it('returns false for non-http(s) schemes', () => {
    expect(isOAuthPopupUrl('javascript:alert(1)')).toBe(false);
    expect(isOAuthPopupUrl('file:///etc/passwd')).toBe(false);
    expect(isOAuthPopupUrl('chrome://settings')).toBe(false);
  });

  it('returns false for malformed URLs', () => {
    expect(isOAuthPopupUrl('not-a-url')).toBe(false);
    expect(isOAuthPopupUrl('')).toBe(false);
    expect(isOAuthPopupUrl(null)).toBe(false);
    expect(isOAuthPopupUrl(undefined)).toBe(false);
    expect(isOAuthPopupUrl(123)).toBe(false);
  });

  it('does NOT match a host that merely contains an allowlisted suffix as substring', () => {
    // `myaccounts.google.com.evil.com` ends with `.evil.com`, not
    // any allowlisted entry, so should be denied.
    expect(isOAuthPopupUrl('https://accounts.google.com.evil.com/login')).toBe(false);
    // `googlefoo.com` is NOT a subdomain of `google.com`.
    expect(isOAuthPopupUrl('https://googleaccounts.com/login')).toBe(false);
  });

  it('the allowlist contains the well-known major IdP origins', () => {
    expect(OAUTH_POPUP_ALLOWLIST).toContain('accounts.google.com');
    expect(OAUTH_POPUP_ALLOWLIST).toContain('login.microsoftonline.com');
    expect(OAUTH_POPUP_ALLOWLIST).toContain('appleid.apple.com');
    expect(OAUTH_POPUP_ALLOWLIST).toContain('github.com');
  });
});

describe('buildPopupHandler', () => {
  it('returns allow with overrideBrowserWindowOptions inheriting the partition for OAuth URLs', () => {
    const shellOpenExternal = vi.fn();
    const logger = vi.fn();
    const handler = buildPopupHandler({
      partition: 'persist:tab-test',
      shellOpenExternal,
      logger,
      source: 'main-window-tab:t-test',
    });
    const result = handler({
      url: 'https://accounts.google.com/o/oauth2/auth',
    } as unknown as Electron.HandlerDetails);
    expect(result.action).toBe('allow');
    if (result.action === 'allow') {
      expect(result.overrideBrowserWindowOptions?.webPreferences?.partition).toBe('persist:tab-test');
      expect(result.overrideBrowserWindowOptions?.webPreferences?.contextIsolation).toBe(true);
      expect(result.overrideBrowserWindowOptions?.webPreferences?.sandbox).toBe(true);
    }
    expect(shellOpenExternal).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith(
      'info',
      'oauth-popup: allowed in-app child window',
      expect.objectContaining({
        url: 'https://accounts.google.com',
        reason: 'oauth-allowlist',
        source: 'main-window-tab:t-test',
        partition: 'persist:tab-test',
      })
    );
  });

  it('returns deny + calls shellOpenExternal for non-allowlisted URLs', () => {
    const shellOpenExternal = vi.fn();
    const logger = vi.fn();
    const handler = buildPopupHandler({
      partition: 'persist:tab-test',
      shellOpenExternal,
      logger,
    });
    const result = handler({
      url: 'https://example.com/some-popup',
    } as unknown as Electron.HandlerDetails);
    expect(result.action).toBe('deny');
    expect(shellOpenExternal).toHaveBeenCalledWith('https://example.com/some-popup');
    expect(logger).toHaveBeenCalledWith(
      'info',
      'oauth-popup: routed to OS default browser',
      expect.objectContaining({ url: 'https://example.com' })
    );
  });

  it('extraAllowPredicate short-circuits to allow', () => {
    const shellOpenExternal = vi.fn();
    const handler = buildPopupHandler({
      partition: 'persist:lite-auth-edison',
      shellOpenExternal,
      extraAllowPredicate: (url) => url.includes('onereach.ai'),
    });
    const result = handler({
      url: 'https://login.onereach.ai/some-flow',
    } as unknown as Electron.HandlerDetails);
    expect(result.action).toBe('allow');
    if (result.action === 'allow') {
      expect(result.overrideBrowserWindowOptions?.webPreferences?.partition).toBe(
        'persist:lite-auth-edison'
      );
    }
    expect(shellOpenExternal).not.toHaveBeenCalled();
  });

  it('extraAllowPredicate is checked BEFORE the OAuth allowlist', () => {
    // accounts.google.com is on the OAuth allowlist; make sure
    // extraAllowPredicate doesn't double-fire (single allow path).
    const handler = buildPopupHandler({
      partition: 'persist:test',
      extraAllowPredicate: () => true,
    });
    const result = handler({
      url: 'https://accounts.google.com/x',
    } as unknown as Electron.HandlerDetails);
    expect(result.action).toBe('allow');
  });

  it('routes javascript: URLs to shell.openExternal (deny)', () => {
    // Defense in depth: javascript: schemes should never become
    // child windows even though they're not on the allowlist.
    const shellOpenExternal = vi.fn();
    const handler = buildPopupHandler({
      partition: 'persist:test',
      shellOpenExternal,
    });
    const result = handler({
      url: 'javascript:alert(1)',
    } as unknown as Electron.HandlerDetails);
    expect(result.action).toBe('deny');
    expect(shellOpenExternal).toHaveBeenCalled();
  });

  it('logger is optional', () => {
    const shellOpenExternal = vi.fn();
    const handler = buildPopupHandler({
      partition: 'persist:test',
      shellOpenExternal,
    });
    expect(() =>
      handler({ url: 'https://example.com' } as unknown as Electron.HandlerDetails)
    ).not.toThrow();
  });
});

// ─── attachPopupLifecycle ──────────────────────────────────────────────────
//
// Regression coverage for the "Google auth seemed to work then the
// login screen stayed" bug: closing the popup synchronously when it
// hit the parent's origin cut off the OAuth callback's post-redirect
// work (cookie-set + postMessage + window.close), leaving the parent
// stuck on /login. The fix adds a grace window before the close.

interface FakeWebContents {
  url: string;
  listeners: Map<string, Array<(...args: unknown[]) => void>>;
  on(event: string, cb: (...args: unknown[]) => void): void;
  off(event: string, cb: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
  getURL(): string;
}

function makeFakeWebContents(initialUrl: string): FakeWebContents {
  return {
    url: initialUrl,
    listeners: new Map(),
    on(event, cb) {
      const arr = this.listeners.get(event) ?? [];
      arr.push(cb);
      this.listeners.set(event, arr);
    },
    off(event, cb) {
      const arr = this.listeners.get(event) ?? [];
      this.listeners.set(
        event,
        arr.filter((h) => h !== cb)
      );
    },
    emit(event, ...args) {
      for (const cb of this.listeners.get(event) ?? []) {
        cb(...args);
      }
    },
    getURL() {
      return this.url;
    },
  };
}

interface FakeBrowserWindow {
  webContents: FakeWebContents;
  destroyed: boolean;
  closeCount: number;
  closedListeners: Array<() => void>;
  isDestroyed(): boolean;
  close(): void;
  once(event: string, cb: () => void): void;
  /** Test hook -- simulate a navigation. */
  navigate(url: string): void;
  /** Test hook -- simulate the popup closing itself. */
  emitClosed(): void;
}

function makeFakeBrowserWindow(initialUrl: string): FakeBrowserWindow {
  const wc = makeFakeWebContents(initialUrl);
  const win: FakeBrowserWindow = {
    webContents: wc,
    destroyed: false,
    closeCount: 0,
    closedListeners: [],
    isDestroyed() {
      return this.destroyed;
    },
    close() {
      this.closeCount += 1;
      if (!this.destroyed) {
        this.destroyed = true;
        for (const cb of this.closedListeners) cb();
      }
    },
    once(event, cb) {
      if (event === 'closed') this.closedListeners.push(cb);
    },
    navigate(url) {
      wc.url = url;
      wc.emit('did-navigate', { preventDefault: () => undefined }, url);
    },
    emitClosed() {
      this.destroyed = true;
      for (const cb of this.closedListeners) cb();
    },
  };
  return win;
}

describe('attachPopupLifecycle - parent-origin grace window', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does NOT close immediately when popup navigates to parent origin', () => {
    const parent = makeFakeBrowserWindow('https://auth.edison.onereach.ai/login');
    const popup = makeFakeBrowserWindow('https://accounts.google.com/o/oauth2/auth');
    attachPopupLifecycle(parent as unknown as BrowserWindow, popup as unknown as BrowserWindow);

    popup.navigate('https://auth.edison.onereach.ai/callback?code=xyz');
    // No close yet -- the grace timer is pending.
    expect(popup.closeCount).toBe(0);
    expect(popup.destroyed).toBe(false);
  });

  it('closes after the grace window expires (safety net for hung popups)', () => {
    const parent = makeFakeBrowserWindow('https://auth.edison.onereach.ai/login');
    const popup = makeFakeBrowserWindow('https://accounts.google.com/o/oauth2/auth');
    attachPopupLifecycle(parent as unknown as BrowserWindow, popup as unknown as BrowserWindow);

    popup.navigate('https://auth.edison.onereach.ai/callback');
    expect(popup.closeCount).toBe(0);

    vi.advanceTimersByTime(POPUP_PARENT_ORIGIN_GRACE_MS - 1);
    expect(popup.closeCount).toBe(0); // still inside the grace window

    vi.advanceTimersByTime(2);
    expect(popup.closeCount).toBe(1); // grace elapsed -> close
  });

  it('does NOT close if the popup self-closes during the grace window', () => {
    const parent = makeFakeBrowserWindow('https://auth.edison.onereach.ai/login');
    const popup = makeFakeBrowserWindow('https://accounts.google.com/o/oauth2/auth');
    attachPopupLifecycle(parent as unknown as BrowserWindow, popup as unknown as BrowserWindow);

    popup.navigate('https://auth.edison.onereach.ai/callback');
    // Popup's own renderer calls window.close() before the grace window.
    popup.emitClosed();
    expect(popup.closeCount).toBe(0); // we never called .close() because the popup beat us to it

    vi.advanceTimersByTime(POPUP_PARENT_ORIGIN_GRACE_MS + 1000);
    // Even after the grace window, no extra close call -- the timer
    // was cancelled by the popup-closed listener.
    expect(popup.closeCount).toBe(0);
  });

  it('closes immediately when the parent navigates (auth-completed signal)', () => {
    const parent = makeFakeBrowserWindow('https://auth.edison.onereach.ai/login');
    const popup = makeFakeBrowserWindow('https://accounts.google.com/o/oauth2/auth');
    attachPopupLifecycle(parent as unknown as BrowserWindow, popup as unknown as BrowserWindow);

    popup.navigate('https://auth.edison.onereach.ai/callback');
    expect(popup.closeCount).toBe(0); // grace timer pending

    // Parent navigates -- the canonical "OneReach auth landed" signal.
    parent.navigate('https://studio.edison.onereach.ai/');
    expect(popup.closeCount).toBe(1);

    // The pending grace timer should have been cancelled, so even
    // after the grace window the close count stays at 1 (no double).
    vi.advanceTimersByTime(POPUP_PARENT_ORIGIN_GRACE_MS + 1000);
    expect(popup.closeCount).toBe(1);
  });

  it('multiple parent-origin navigations only schedule one grace timer', () => {
    const parent = makeFakeBrowserWindow('https://auth.edison.onereach.ai/login');
    const popup = makeFakeBrowserWindow('https://accounts.google.com/o/oauth2/auth');
    attachPopupLifecycle(parent as unknown as BrowserWindow, popup as unknown as BrowserWindow);

    popup.navigate('https://auth.edison.onereach.ai/callback');
    popup.navigate('https://auth.edison.onereach.ai/callback#step-2');
    popup.navigate('https://auth.edison.onereach.ai/callback#step-3');

    // Single timer scheduled regardless of how many same-origin navs
    // fired -- closing once, on the original schedule.
    vi.advanceTimersByTime(POPUP_PARENT_ORIGIN_GRACE_MS + 1);
    expect(popup.closeCount).toBe(1);
  });

  it('respects parentOriginGraceMs override (for tests / future tunability)', () => {
    const parent = makeFakeBrowserWindow('https://auth.edison.onereach.ai/login');
    const popup = makeFakeBrowserWindow('https://accounts.google.com/o/oauth2/auth');
    attachPopupLifecycle(parent as unknown as BrowserWindow, popup as unknown as BrowserWindow, {
      parentOriginGraceMs: 100,
    });

    popup.navigate('https://auth.edison.onereach.ai/callback');
    vi.advanceTimersByTime(99);
    expect(popup.closeCount).toBe(0);
    vi.advanceTimersByTime(2);
    expect(popup.closeCount).toBe(1);
  });

  it('does not schedule a timer when popup navigates to a non-parent origin', () => {
    const parent = makeFakeBrowserWindow('https://auth.edison.onereach.ai/login');
    const popup = makeFakeBrowserWindow('https://accounts.google.com/o/oauth2/auth');
    attachPopupLifecycle(parent as unknown as BrowserWindow, popup as unknown as BrowserWindow);

    // Hops between IdP / SAML / consent screens -- never on the
    // parent's origin. Should never schedule a grace close.
    popup.navigate('https://accounts.google.com/v3/signin/identifier');
    popup.navigate('https://accounts.google.com/o/saml2/continue');
    popup.navigate('https://sso.global.api.onereach.ai/saml/acs');

    vi.advanceTimersByTime(POPUP_PARENT_ORIGIN_GRACE_MS * 2);
    expect(popup.closeCount).toBe(0);
  });

  it('disposer cancels any pending grace timer', () => {
    const parent = makeFakeBrowserWindow('https://auth.edison.onereach.ai/login');
    const popup = makeFakeBrowserWindow('https://accounts.google.com/o/oauth2/auth');
    const dispose = attachPopupLifecycle(
      parent as unknown as BrowserWindow,
      popup as unknown as BrowserWindow
    );

    popup.navigate('https://auth.edison.onereach.ai/callback');
    dispose();

    vi.advanceTimersByTime(POPUP_PARENT_ORIGIN_GRACE_MS + 1);
    expect(popup.closeCount).toBe(0);
  });
});
