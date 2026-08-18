/**
 * Regression: the outage banner's "Report issue" dead-button (2026-08-17).
 *
 * A bad merge nested the `lite:bug-report:open` ipcMain.handle INSIDE the
 * get-prefill handler's body, so the open channel only existed after a
 * modal had already fetched its prefill — which requires a modal to be
 * open. The banner's invoke hit an unhandled channel, the rejection was
 * swallowed by `void`, and the button silently did nothing.
 *
 * Pins: (1) every bug-report channel — open included — is registered
 * synchronously by initBugReport; (2) running the get-prefill handler
 * (twice) never attempts further registrations.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

type Handler = (...args: unknown[]) => unknown;
const registered = new Map<string, Handler>();
const handleCalls: string[] = [];

vi.mock('electron', () => ({
  BrowserWindow: class {
    static getAllWindows(): unknown[] {
      return [];
    }
  },
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handleCalls.push(channel);
      registered.set(channel, fn);
    },
    on: (channel: string, fn: Handler) => {
      registered.set(channel, fn);
    },
    removeHandler: () => undefined,
  },
  app: { getPath: () => '/tmp' },
}));

import { initBugReport } from '../../bug-report/main.js';

// initBugReport is once-guarded (handlersRegistered), so register a
// single time and let both tests inspect the same registration state.
beforeAll(() => {
  initBugReport({
    logServerPort: 0,
    preloadPath: '/dev/null',
    modalHtmlPath: '/dev/null',
    liteVersion: '0.0.0-test',
    getParentWindow: () => null,
  });
});

describe('bug-report IPC registration (dead Report-issue button regression)', () => {
  it('registers the open channel at init, not lazily', () => {
    expect(registered.has('lite:bug-report:open')).toBe(true);
    expect(registered.has('lite:bug-report:get-prefill')).toBe(true);
  });

  it('get-prefill runs repeatedly without re-registering anything', () => {
    const before = handleCalls.length;
    const getPrefill = registered.get('lite:bug-report:get-prefill');
    expect(getPrefill).toBeDefined();
    expect(getPrefill?.({})).toEqual({ prefill: null });
    expect(getPrefill?.({})).toEqual({ prefill: null });
    expect(handleCalls.length).toBe(before);
  });
});
