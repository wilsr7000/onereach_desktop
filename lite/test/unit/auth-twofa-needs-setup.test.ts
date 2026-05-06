/**
 * AuthStore + TOTP autofill: 2FA-needs-setup notification.
 *
 * Verifies the contract that drives the chrome / placeholder
 * banner: when the autofill watcher detects a 2FA page but Lite
 * has no TOTP secret saved, `onTwoFactorNeedsSetup` subscribers
 * fire exactly once per `startTotpAutofill` call.
 *
 * This is an isolated test that drives `attachToTarget` indirectly
 * via the public `startTotpAutofill` surface using stubs -- no
 * real BrowserWindow / Electron involved.
 */

import { describe, it, expect, vi } from 'vitest';
import { TotpError, TOTP_ERROR_CODES } from '../../totp/api.js';
import { startTotpAutofill } from '../../auth/totp-autofill.js';
import type { AuthWindowHandle } from '../../auth/window.js';

/** Local copy of `AuthScriptsLike` (the type isn't exported from totp-autofill). */
interface AuthScriptsLike {
  buildWaitForAuthFormScript(timeoutMs?: number): string;
  buildFillTOTPScript(code: string): string;
  buildSubmitButtonScript(): string;
  buildAccountPickerWaitScript(timeoutMs?: number): string;
  buildAccountPickerSelectScript(accountId: string): string;
}

/**
 * Build a minimal AuthScripts stub. The autofill flow injects
 * scripts via `frame.executeJavaScript(...)`. Our fake frame
 * returns a probe result + ignores fill scripts.
 */
function buildAuthScripts(): AuthScriptsLike {
  return {
    buildWaitForAuthFormScript: () => 'WAIT_FOR_FORM_SCRIPT',
    buildFillTOTPScript: () => 'FILL_TOTP_SCRIPT',
    buildSubmitButtonScript: () => 'SUBMIT_SCRIPT',
    buildAccountPickerWaitScript: () => 'WAIT_PICKER_SCRIPT',
    buildAccountPickerSelectScript: () => 'SELECT_PICKER_SCRIPT',
  };
}

interface FakeFrame {
  url: string;
  detached: boolean;
  processId: number;
  routingId: number;
  framesInSubtree: FakeFrame[];
  executeJavaScript: (script: string) => Promise<unknown>;
}

function buildOneReachFrame(probeResult: unknown): FakeFrame {
  const frame: FakeFrame = {
    url: 'https://login.onereach.ai/2fa',
    detached: false,
    processId: 1,
    routingId: 1,
    framesInSubtree: [],
    executeJavaScript: vi.fn().mockResolvedValue(probeResult),
  };
  return frame;
}

interface FakeWebContents {
  isDestroyed: () => boolean;
  getURL: () => string;
  mainFrame: FakeFrame;
  on: (event: string, _listener: (...args: unknown[]) => void) => void;
  off: (event: string, _listener: (...args: unknown[]) => void) => void;
}

interface FakeBrowserWindow {
  isDestroyed: () => boolean;
  webContents: FakeWebContents;
  getURL: () => string;
}

function buildFakeWindow(probe: unknown): FakeBrowserWindow {
  const mainFrame = buildOneReachFrame(probe);
  // Capture event listeners so we can manually trigger scans.
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const wc: FakeWebContents = {
    isDestroyed: () => false,
    getURL: () => 'https://login.onereach.ai/2fa',
    mainFrame,
    on: (event, listener) => {
      const arr = listeners.get(event) ?? [];
      arr.push(listener);
      listeners.set(event, arr);
    },
    off: (event, listener) => {
      const arr = listeners.get(event);
      if (arr === undefined) return;
      const i = arr.indexOf(listener);
      if (i >= 0) arr.splice(i, 1);
    },
  };
  return {
    isDestroyed: () => false,
    webContents: wc,
    getURL: () => 'https://login.onereach.ai/2fa',
  };
}

function buildHandle(win: FakeBrowserWindow): AuthWindowHandle {
  // The test stubs out the BrowserWindow but the handle's
  // `_window` is typed as `BrowserWindow`, not `BrowserWindow |
  // undefined`. We cast through `unknown` to satisfy strict
  // exactOptionalPropertyTypes.
  return {
    partition: 'persist:lite-auth-edison',
    close: () => undefined,
    _window: win as unknown as AuthWindowHandle['_window'],
    _firstLoadFired: true,
    _firstLoadCallback: null,
    _closedCallback: null,
  } as unknown as AuthWindowHandle;
}

describe('startTotpAutofill: 2FA-needs-setup notification', () => {
  it('fires onTwoFactorNeedsSetup when 2FA detected + NO_SECRET', async () => {
    const win = buildFakeWindow({ is2FAPage: true, isLoginPage: false, inputCount: 1 });
    const handle = buildHandle(win);
    const onTwoFactorNeedsSetup = vi.fn();
    const onTwoFactorDetected = vi.fn();
    const dispose = startTotpAutofill(handle, {
      authScripts: buildAuthScripts(),
      getCurrentCode: async () => {
        throw new TotpError({
          code: TOTP_ERROR_CODES.NO_SECRET,
          message: 'no secret',
        });
      },
      onTwoFactorDetected,
      onTwoFactorNeedsSetup,
    });
    // The watcher attaches event listeners + does an initial scan.
    // Wait one microtask cycle for the async fill flow to run.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onTwoFactorDetected).toHaveBeenCalled();
    expect(onTwoFactorNeedsSetup).toHaveBeenCalledTimes(1);
    const arg = onTwoFactorNeedsSetup.mock.calls[0]?.[0];
    expect((arg as { source: string } | undefined)?.source).toBe('auth-window');
    expect((arg as { frameUrl: string } | undefined)?.frameUrl).toBe(
      'https://login.onereach.ai/2fa'
    );
    dispose();
  });

  it('does NOT fire when getCurrentCode succeeds (secret IS configured)', async () => {
    const win = buildFakeWindow({ is2FAPage: true, isLoginPage: false, inputCount: 1 });
    const handle = buildHandle(win);
    const onTwoFactorNeedsSetup = vi.fn();
    const dispose = startTotpAutofill(handle, {
      authScripts: buildAuthScripts(),
      getCurrentCode: async () => ({ code: '123456', timeRemaining: 30 }),
      onTwoFactorNeedsSetup,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onTwoFactorNeedsSetup).not.toHaveBeenCalled();
    dispose();
  });

  it('does NOT fire when probe says is2FAPage=false', async () => {
    const win = buildFakeWindow({ is2FAPage: false, isLoginPage: true });
    const handle = buildHandle(win);
    const onTwoFactorNeedsSetup = vi.fn();
    const dispose = startTotpAutofill(handle, {
      authScripts: buildAuthScripts(),
      getCurrentCode: async () => {
        throw new TotpError({
          code: TOTP_ERROR_CODES.NO_SECRET,
          message: 'no secret',
        });
      },
      onTwoFactorNeedsSetup,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onTwoFactorNeedsSetup).not.toHaveBeenCalled();
    dispose();
  });

  it('fires only ONCE even when multiple scans hit the no-secret path', async () => {
    const win = buildFakeWindow({ is2FAPage: true, isLoginPage: false, inputCount: 1 });
    const handle = buildHandle(win);
    const onTwoFactorNeedsSetup = vi.fn();
    let callCount = 0;
    const dispose = startTotpAutofill(handle, {
      authScripts: buildAuthScripts(),
      getCurrentCode: async () => {
        callCount += 1;
        throw new TotpError({
          code: TOTP_ERROR_CODES.NO_SECRET,
          message: 'no secret',
        });
      },
      onTwoFactorNeedsSetup,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Even if the watcher's per-frame state allows multiple
    // executions, the runtime state's `needsSetupNotified` flag
    // must gate the callback to exactly one fire.
    expect(onTwoFactorNeedsSetup).toHaveBeenCalledTimes(1);
    expect(callCount).toBeGreaterThanOrEqual(1);
    dispose();
  });
});
