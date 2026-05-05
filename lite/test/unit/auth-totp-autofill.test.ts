/**
 * Auth TOTP autofill tests.
 *
 * Exercises the Lite login-popup helper without a real BrowserWindow:
 * fake webContents + fake auth frames + fake auth-scripts. Verifies:
 *   - no BrowserWindow handle => no-op
 *   - non-OneReach mainFrame is skipped
 *   - 2FA page detected via the MutationObserver wait => fills + submits
 *   - no TOTP secret => no-op, no fill/submit
 *   - logs never include the six-digit code
 *   - listeners detach on dispose
 *   - popup window opened mid-flow gets its own watcher
 *   - per-frame in-flight de-dup prevents parallel waits on same frame
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect } from 'vitest';
import { startTotpAutofill, startTotpAutofillForWebContents } from '../../auth/totp-autofill.js';
import { TotpError, TOTP_ERROR_CODES } from '../../totp/api.js';
import type { AuthWindowHandle } from '../../auth/window.js';

class FakeFrame {
  public readonly calls: string[] = [];
  public detached = false;
  public processId = 1;
  public routingId: number;
  constructor(
    private readonly responses: Record<string, unknown>,
    private readonly frameUrl = 'https://auth.edison.onereach.ai/login',
    routingId = 1
  ) {
    this.routingId = routingId;
  }
  async executeJavaScript(script: string): Promise<unknown> {
    this.calls.push(script);
    const value = this.responses[script];
    if (value instanceof Error) throw value;
    return value ?? null;
  }
  get url(): string {
    return this.frameUrl;
  }
}

class FakeWebContents extends EventEmitter {
  public mainFrame: FakeFrame & { framesInSubtree: FakeFrame[] };
  private currentUrl: string;
  constructor(mainFrame: FakeFrame, subFrames: FakeFrame[], windowUrl = 'https://studio.edison.onereach.ai/') {
    super();
    this.currentUrl = windowUrl;
    const ext = mainFrame as FakeFrame & { framesInSubtree: FakeFrame[] };
    ext.framesInSubtree = subFrames;
    this.mainFrame = ext;
  }
  getURL(): string {
    return this.currentUrl;
  }
  isDestroyed(): boolean {
    return false;
  }
}

class FakeWindow {
  public readonly webContents: FakeWebContents;
  private destroyed = false;
  constructor(mainFrame: FakeFrame, subFrames: FakeFrame[] = [], windowUrl?: string) {
    this.webContents = new FakeWebContents(mainFrame, subFrames, windowUrl);
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

function fakeHandle(win: FakeWindow): AuthWindowHandle {
  return {
    partition: 'persist:lite-auth-edison',
    close: () => undefined,
    _window: win as unknown as Electron.BrowserWindow,
    _firstLoadFired: false,
    _firstLoadCallback: null,
    _closedCallback: null,
  };
}

function fakeScripts() {
  return {
    buildWaitForAuthFormScript: (timeoutMs?: number) => `WAIT:${timeoutMs ?? 10000}`,
    buildWaitFor2FAFormScript: (timeoutMs?: number) => `WAIT:${timeoutMs ?? 10000}`,
    buildFillTOTPScript: (code: string) => `FILL:${code}`,
    buildSubmitButtonScript: () => 'SUBMIT',
    buildSelectAccountScript: (id: string) => `SELECT_ACCOUNT:${id}`,
  };
}

const WAIT_KEY = 'WAIT:300000';

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

describe('startTotpAutofill', () => {
  it('no-ops when the handle has no BrowserWindow', () => {
    const handle: AuthWindowHandle = {
      partition: 'persist:lite-auth-edison',
      close: () => undefined,
      _firstLoadFired: false,
      _firstLoadCallback: null,
      _closedCallback: null,
    };
    const logs: Array<{ message: string; data?: unknown }> = [];
    const stop = startTotpAutofill(handle, {
      authScripts: fakeScripts(),
      logger: (_level, message, data) => logs.push({ message, data }),
    });
    stop();
    expect(logs).toEqual([
      {
        message: 'auth-totp-autofill: no BrowserWindow handle; disabled',
        data: undefined,
      },
    ]);
  });

  it('logs startup info even when nothing happens', async () => {
    const mainFrame = new FakeFrame({}, 'about:blank');
    const win = new FakeWindow(mainFrame, [], 'about:blank');
    const logs: Array<{ message: string; data?: unknown }> = [];
    const stop = startTotpAutofill(fakeHandle(win), {
      authScripts: fakeScripts(),
      logger: (_level, message, data) => logs.push({ message, data }),
    });
    await flush();
    stop();
    const startedLog = logs.find((l) => l.message.includes('started watching'));
    expect(startedLog).toBeDefined();
    expect(startedLog?.data).toMatchObject({
      partition: 'persist:lite-auth-edison',
      initialUrl: 'about:blank',
    });
    // Non-onereach (about:blank) main frame is skipped.
    expect(mainFrame.calls).toEqual([]);
  });

  it('skips a non-onereach main frame and logs why', async () => {
    const mainFrame = new FakeFrame({}, 'https://example.com/');
    const win = new FakeWindow(mainFrame, [], 'https://example.com/');
    const logs: Array<{ message: string; data?: unknown }> = [];
    const stop = startTotpAutofill(fakeHandle(win), {
      authScripts: fakeScripts(),
      logger: (_level, message, data) => logs.push({ message, data }),
    });
    await flush();
    stop();
    expect(mainFrame.calls).toEqual([]);
    const skipLog = logs.find(
      (l) =>
        l.message === 'auth-totp-autofill: skip non-onereach frame' &&
        (l.data as { frameUrl?: string }).frameUrl === 'https://example.com/'
    );
    expect(skipLog).toBeDefined();
  });

  it('leaves the page alone when no TOTP secret is configured', async () => {
    const frame = new FakeFrame(
      { [WAIT_KEY]: { is2FAPage: true, reason: 'totp_input_found' } },
      'https://auth.edison.onereach.ai/2fa'
    );
    const win = new FakeWindow(frame);
    const logs: Array<{ message: string; data?: unknown }> = [];
    const stop = startTotpAutofill(fakeHandle(win), {
      authScripts: fakeScripts(),
      getCurrentCode: async () => {
        throw new TotpError({
          code: TOTP_ERROR_CODES.NO_SECRET,
          message: 'No TOTP secret is stored.',
          remediation: 'Configure Settings -> Two-Factor.',
        });
      },
      logger: (_level, message, data) => logs.push({ message, data }),
    });
    await flush();
    stop();
    expect(frame.calls).toEqual([WAIT_KEY]);
    expect(logs.some((l) => l.message.includes('no TOTP secret'))).toBe(true);
  });

  it('fills and submits the code on a 2FA page', async () => {
    const frame = new FakeFrame(
      {
        [WAIT_KEY]: { is2FAPage: true, reason: 'totp_input_found' },
        'FILL:123456': { success: true, verified: true },
        SUBMIT: { clicked: true, method: 'selector' },
      },
      'https://auth.edison.onereach.ai/2fa'
    );
    const win = new FakeWindow(frame);
    const logs: Array<{ message: string; data?: unknown }> = [];
    const stop = startTotpAutofill(fakeHandle(win), {
      authScripts: fakeScripts(),
      getCurrentCode: async () => ({ code: '123456', timeRemaining: 20 }),
      logger: (_level, message, data) => logs.push({ message, data }),
    });
    await flush();
    stop();
    expect(frame.calls).toEqual([WAIT_KEY, 'FILL:123456', 'SUBMIT']);
    const success = logs.find((l) => l.message.includes('filled and submitted 2FA code'));
    expect(success).toBeDefined();
    expect(success?.data).toMatchObject({
      attempt: 1,
      verified: true,
      submitClicked: true,
    });
  });

  it('does not fill when wait resolves without a 2FA flag', async () => {
    const frame = new FakeFrame(
      {
        [WAIT_KEY]: { isLoginPage: true, reason: 'login_form_found' },
      },
      'https://auth.edison.onereach.ai/login'
    );
    const win = new FakeWindow(frame);
    const stop = startTotpAutofill(fakeHandle(win), {
      authScripts: fakeScripts(),
      getCurrentCode: async () => ({ code: '999999', timeRemaining: 20 }),
    });
    await flush();
    stop();
    expect(frame.calls).toEqual([WAIT_KEY]);
  });

  it('fills and submits when the 2FA input is in a non-auth OneReach frame', async () => {
    const mainFrame = new FakeFrame(
      { [WAIT_KEY]: { isLoginPage: false, is2FAPage: false, reason: 'observer_timeout', inputCount: 0 } },
      'https://studio.edison.onereach.ai/',
      1
    );
    const subFrame = new FakeFrame(
      {
        [WAIT_KEY]: { is2FAPage: true, reason: 'totp_input_found' },
        'FILL:123456': { success: true, verified: true },
        SUBMIT: { clicked: true },
      },
      'https://em.edison.api.onereach.ai/http/flow/2fa',
      2
    );
    const win = new FakeWindow(mainFrame, [subFrame]);
    const stop = startTotpAutofill(fakeHandle(win), {
      authScripts: fakeScripts(),
      getCurrentCode: async () => ({ code: '123456', timeRemaining: 20 }),
    });
    await flush();
    stop();
    // Main frame is also probed, but only the sub frame finds 2FA.
    // Because attempts is capped at 1 successful fill, we don't double-fill.
    expect(subFrame.calls).toEqual([WAIT_KEY, 'FILL:123456', 'SUBMIT']);
    expect(mainFrame.calls).toContain(WAIT_KEY);
    expect(mainFrame.calls).not.toContain('FILL:123456');
  });

  it('does not log the generated six-digit code', async () => {
    const frame = new FakeFrame(
      {
        [WAIT_KEY]: { is2FAPage: true, reason: 'totp_input_found' },
        'FILL:654321': { success: true, verified: true },
        SUBMIT: { clicked: true },
      },
      'https://auth.edison.onereach.ai/2fa'
    );
    const win = new FakeWindow(frame);
    const logs: Array<{ message: string; data?: unknown }> = [];
    const stop = startTotpAutofill(fakeHandle(win), {
      authScripts: fakeScripts(),
      getCurrentCode: async () => ({ code: '654321', timeRemaining: 20 }),
      logger: (_level, message, data) => logs.push({ message, data }),
    });
    await flush();
    stop();
    expect(JSON.stringify(logs)).not.toContain('654321');
  });

  it('detaches event listeners on stop()', async () => {
    const frame = new FakeFrame({ [WAIT_KEY]: { isLoginPage: true } });
    const win = new FakeWindow(frame);
    const stop = startTotpAutofill(fakeHandle(win), {
      authScripts: fakeScripts(),
      getCurrentCode: async () => ({ code: '111111', timeRemaining: 20 }),
    });
    await flush();
    expect(win.webContents.listenerCount('did-navigate')).toBe(1);
    expect(win.webContents.listenerCount('did-navigate-in-page')).toBe(1);
    expect(win.webContents.listenerCount('did-finish-load')).toBe(1);
    expect(win.webContents.listenerCount('did-frame-finish-load')).toBe(1);
    expect(win.webContents.listenerCount('did-create-window')).toBe(1);
    stop();
    expect(win.webContents.listenerCount('did-navigate')).toBe(0);
    expect(win.webContents.listenerCount('did-navigate-in-page')).toBe(0);
    expect(win.webContents.listenerCount('did-finish-load')).toBe(0);
    expect(win.webContents.listenerCount('did-frame-finish-load')).toBe(0);
    expect(win.webContents.listenerCount('did-create-window')).toBe(0);
  });

  it('attaches a watcher to a popup window opened mid-flow', async () => {
    const mainFrame = new FakeFrame(
      { [WAIT_KEY]: { isLoginPage: true, reason: 'login_form_found' } },
      'https://studio.edison.onereach.ai/'
    );
    const win = new FakeWindow(mainFrame, [], 'https://studio.edison.onereach.ai/');

    const popupFrame = new FakeFrame(
      {
        [WAIT_KEY]: { is2FAPage: true, reason: 'totp_input_found' },
        'FILL:222333': { success: true, verified: true },
        SUBMIT: { clicked: true },
      },
      'https://auth.edison.onereach.ai/2fa',
      2
    );
    const popup = new FakeWindow(popupFrame, [], 'https://auth.edison.onereach.ai/2fa');

    const logs: Array<{ message: string; data?: unknown }> = [];
    const stop = startTotpAutofill(fakeHandle(win), {
      authScripts: fakeScripts(),
      getCurrentCode: async () => ({ code: '222333', timeRemaining: 20 }),
      logger: (_level, message, data) => logs.push({ message, data }),
    });

    // Initial scan on auth window already happened.
    await flush();
    expect(mainFrame.calls).toContain(WAIT_KEY);
    expect(popupFrame.calls).toEqual([]);

    // Simulate the popup being opened (e.g. window.open from studio).
    win.webContents.emit('did-create-window', popup as unknown as Electron.BrowserWindow);
    await flush();

    expect(popupFrame.calls).toEqual([WAIT_KEY, 'FILL:222333', 'SUBMIT']);
    const popupTrack = logs.find((l) => l.message.includes('tracking popup window'));
    expect(popupTrack).toBeDefined();
    stop();
    // Popup listeners are also detached.
    expect(popup.webContents.listenerCount('did-navigate')).toBe(0);
    expect(popup.webContents.listenerCount('did-create-window')).toBe(0);
  });

  it('coalesces parallel scans on the same frame', async () => {
    let resolveWait!: (value: unknown) => void;
    const waitPromise = new Promise((resolve) => {
      resolveWait = resolve;
    });
    const frame = new FakeFrame(
      {
        [WAIT_KEY]: waitPromise,
        'FILL:333444': { success: true, verified: true },
        SUBMIT: { clicked: true },
      },
      'https://auth.edison.onereach.ai/2fa'
    );
    const win = new FakeWindow(frame);
    const stop = startTotpAutofill(fakeHandle(win), {
      authScripts: fakeScripts(),
      getCurrentCode: async () => ({ code: '333444', timeRemaining: 20 }),
    });
    // First scan (the 'start' kick) is in flight on the wait promise.
    await flush();
    expect(frame.calls).toEqual([WAIT_KEY]);

    // Subsequent navigation events arrive while the wait is still
    // pending. They should NOT trigger additional WAIT executions on
    // the same (processId, routingId).
    win.webContents.emit('did-finish-load');
    win.webContents.emit('did-navigate');
    win.webContents.emit('did-frame-finish-load');
    await flush();
    expect(frame.calls).toEqual([WAIT_KEY]);

    // Now resolve and let the fill+submit complete.
    resolveWait({ is2FAPage: true, reason: 'totp_input_found' });
    await flush();
    await flush();
    expect(frame.calls).toEqual([WAIT_KEY, 'FILL:333444', 'SUBMIT']);
    stop();
  });
});

describe('startTotpAutofillForWebContents', () => {
  it('detects a 2FA form in a main-window tab webContents and calls the detection hook once', async () => {
    const frame = new FakeFrame(
      {
        [WAIT_KEY]: { is2FAPage: true, reason: 'totp_input_found', inputCount: 1 },
        'FILL:777888': { success: true, verified: true },
        SUBMIT: { clicked: true, method: 'selector' },
      },
      'https://auth.edison.onereach.ai/2fa'
    );
    const webContents = new FakeWebContents(frame, [], 'https://auth.edison.onereach.ai/2fa');
    const detections: Array<{ source: string; frameUrl: string; reason?: string; inputCount?: number }> = [];
    const logs: Array<{ message: string; data?: unknown }> = [];

    const stop = startTotpAutofillForWebContents(webContents as unknown as Electron.WebContents, {
      source: 'main-window-tab:test',
      authScripts: fakeScripts(),
      getCurrentCode: async () => ({ code: '777888', timeRemaining: 20 }),
      onTwoFactorDetected: (payload) => detections.push(payload),
      logger: (_level, message, data) => logs.push({ message, data }),
    });

    await flush();
    expect(frame.calls).toEqual([WAIT_KEY, 'FILL:777888', 'SUBMIT']);
    expect(detections).toEqual([
      {
        source: 'main-window-tab:test',
        frameUrl: 'https://auth.edison.onereach.ai/2fa',
        reason: 'totp_input_found',
        inputCount: 1,
      },
    ]);

    webContents.emit('did-finish-load');
    await flush();
    expect(detections).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain('777888');
    stop();
  });

  it('auto-selects the IDW account on the picker page when getTargetAccountId returns one', async () => {
    const ACCOUNT_ID = '05bd3c92-5d3c-4dc5-a95d-0c584695cea4';
    const SELECT_KEY = `SELECT_ACCOUNT:${ACCOUNT_ID}`;
    // Match the script the picker waiter generates -- we don't care
    // about its body, only that it returns the "found" object.
    const frame = new FakeFrame(
      {
        [WAIT_KEY]: { isLoginPage: true, reason: 'login_form_found' },
        [SELECT_KEY]: { success: true, method: 'link-href' },
      },
      `https://auth.edison.onereach.ai/multi-user/list-users`
    );
    // The picker wait script is generated inline (not via authScripts),
    // so we accept any string starting with `\n    new Promise` and
    // resolve it as "found".
    const realExecute = frame.executeJavaScript.bind(frame);
    frame.executeJavaScript = async (script: string): Promise<unknown> => {
      if (script.includes('TARGET = ') && script.includes(ACCOUNT_ID)) {
        frame.calls.push('PICKER_WAIT');
        return { found: true, type: 'link' };
      }
      return realExecute(script);
    };

    const webContents = new FakeWebContents(
      frame,
      [],
      `https://auth.edison.onereach.ai/multi-user/list-users`
    );
    const pickerCalls: Array<{ source: string; frameUrl: string; targetAccountId: string }> = [];
    const logs: Array<{ message: string; data?: unknown }> = [];

    const stop = startTotpAutofillForWebContents(webContents as unknown as Electron.WebContents, {
      source: 'main-window-tab:account-test',
      authScripts: fakeScripts(),
      getCurrentCode: async () => ({ code: '999999', timeRemaining: 20 }),
      getTargetAccountId: () => ACCOUNT_ID,
      onAccountPickerDetected: (payload) => pickerCalls.push(payload),
      logger: (_level, message, data) => logs.push({ message, data }),
    });

    await flush();
    await flush();
    expect(frame.calls).toContain('PICKER_WAIT');
    expect(frame.calls).toContain(SELECT_KEY);
    expect(frame.calls.filter((c) => c === SELECT_KEY).length).toBe(1);
    expect(pickerCalls).toEqual([
      {
        source: 'main-window-tab:account-test',
        frameUrl: `https://auth.edison.onereach.ai/multi-user/list-users`,
        targetAccountId: ACCOUNT_ID,
      },
    ]);
    expect(logs.some((l) => l.message.includes('account auto-selected'))).toBe(true);

    // Re-emitting navigation must not click again on the same frame.
    webContents.emit('did-navigate');
    await flush();
    expect(frame.calls.filter((c) => c === SELECT_KEY).length).toBe(1);

    stop();
  });

  it('skips account auto-select when getTargetAccountId returns null', async () => {
    const frame = new FakeFrame(
      { [WAIT_KEY]: { isLoginPage: true } },
      'https://auth.edison.onereach.ai/multi-user/list-users'
    );
    const webContents = new FakeWebContents(
      frame,
      [],
      'https://auth.edison.onereach.ai/multi-user/list-users'
    );
    const logs: Array<{ message: string; data?: unknown }> = [];

    const stop = startTotpAutofillForWebContents(webContents as unknown as Electron.WebContents, {
      source: 'main-window-tab:no-target',
      authScripts: fakeScripts(),
      getCurrentCode: async () => ({ code: '999999', timeRemaining: 20 }),
      getTargetAccountId: () => null,
      logger: (_level, message, data) => logs.push({ message, data }),
    });

    await flush();
    expect(frame.calls).toEqual([WAIT_KEY]);
    expect(logs.some((l) => l.message.includes('no targetAccountId'))).toBe(true);
    stop();
  });

  it('detaches generic webContents listeners on stop()', async () => {
    const frame = new FakeFrame({ [WAIT_KEY]: { isLoginPage: true } });
    const webContents = new FakeWebContents(frame, [], 'https://auth.edison.onereach.ai/login');

    const stop = startTotpAutofillForWebContents(webContents as unknown as Electron.WebContents, {
      source: 'main-window-tab:test',
      authScripts: fakeScripts(),
      getCurrentCode: async () => ({ code: '111111', timeRemaining: 20 }),
    });

    await flush();
    expect(webContents.listenerCount('did-navigate')).toBe(1);
    expect(webContents.listenerCount('did-navigate-in-page')).toBe(1);
    expect(webContents.listenerCount('did-finish-load')).toBe(1);
    expect(webContents.listenerCount('did-frame-finish-load')).toBe(1);
    expect(webContents.listenerCount('did-create-window')).toBe(1);

    stop();
    expect(webContents.listenerCount('did-navigate')).toBe(0);
    expect(webContents.listenerCount('did-navigate-in-page')).toBe(0);
    expect(webContents.listenerCount('did-finish-load')).toBe(0);
    expect(webContents.listenerCount('did-frame-finish-load')).toBe(0);
    expect(webContents.listenerCount('did-create-window')).toBe(0);
  });
});
