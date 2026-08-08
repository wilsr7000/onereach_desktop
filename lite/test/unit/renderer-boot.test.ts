/**
 * Shared renderer boot guard tests (`lite/renderer-boot.ts`).
 *
 * The guard is the last-resort crash surface every renderer entry
 * point installs (2026-08-08 hardening review). These tests lock down:
 *   - init dispatch (sync + async) and the auto "boot succeeded" mark
 *   - the fatal banner: painted for boot failures, suppressed after
 *     the first successful paint, deduped, carries title + detail +
 *     reload affordance
 *   - the window error / unhandledrejection listeners
 *
 * NOTE ON ORDERING: every `bootRenderer` call installs window
 * listeners that live for the whole jsdom window (one per test file).
 * A reporter whose boot FAILED stays armed and will repaint a banner
 * on any later window 'error' dispatch. Success-path tests that
 * assert "no banner" therefore run BEFORE any failure-path test.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bootRenderer, type RendererBootContext } from '../../renderer-boot.js';

function banner(): HTMLElement | null {
  return document.getElementById('lite-fatal');
}

/** Let queued microtasks (promise reactions in boot()) run. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  banner()?.remove();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
  banner()?.remove();
});

describe('bootRenderer -- success paths (must run before failure tests)', () => {
  it('runs a sync init immediately when the DOM is already ready', () => {
    let ran = false;
    bootRenderer({
      scope: 'test-sync',
      title: 'Test failed to load',
      init: () => {
        ran = true;
      },
    });
    expect(ran).toBe(true);
    expect(banner()).toBeNull();
  });

  it('suppresses the banner for window errors after a sync init returned', () => {
    bootRenderer({
      scope: 'test-sync-ok',
      title: 'Test failed to load',
      init: () => undefined,
    });
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('late click handler') }));
    // Logged (console-only), never painted.
    expect(errorSpy).toHaveBeenCalled();
    expect(banner()).toBeNull();
  });

  it('suppresses the banner after an async init resolves', async () => {
    bootRenderer({
      scope: 'test-async-ok',
      title: 'Test failed to load',
      init: async () => {
        await Promise.resolve();
      },
    });
    await flushMicrotasks();
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('late async failure') }));
    expect(banner()).toBeNull();
  });

  it('honors an explicit ctx.markBootSucceeded before init settles', async () => {
    let ctx: RendererBootContext | null = null;
    bootRenderer({
      scope: 'test-explicit-mark',
      title: 'Test failed to load',
      // Never settles -- models a long-lived chat/init loop.
      init: (c) => {
        ctx = c;
        return new Promise(() => undefined);
      },
    });
    (ctx as unknown as RendererBootContext).markBootSucceeded();
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('mid-session error') }));
    await flushMicrotasks();
    expect(banner()).toBeNull();
  });
});

describe('bootRenderer -- failure paths', () => {
  it('paints the banner when a sync init throws', () => {
    bootRenderer({
      scope: 'test-sync-throw',
      title: 'Sync window failed to load',
      init: () => {
        throw new Error('exploded wiring the app');
      },
    });
    const el = banner();
    expect(el).not.toBeNull();
    expect(el?.getAttribute('role')).toBe('alert');
    expect(el?.textContent).toContain('Sync window failed to load');
    expect(el?.textContent).toContain('exploded wiring the app');
    // Reload affordance present.
    expect(el?.querySelector('button')?.textContent).toBe('Reload');
    // And the failure reached console.error (-> central log).
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[test-sync-throw] fatal in init')
    );
  });

  it('paints the banner when an async init rejects', async () => {
    bootRenderer({
      scope: 'test-async-reject',
      title: 'Async window failed to load',
      init: async () => {
        await Promise.resolve();
        throw new Error('bridge call failed during boot');
      },
    });
    await flushMicrotasks();
    const el = banner();
    expect(el).not.toBeNull();
    expect(el?.textContent).toContain('bridge call failed during boot');
  });

  it('dedupes: a second failure never stacks a second banner', () => {
    bootRenderer({
      scope: 'test-dupe-a',
      title: 'First failure',
      init: () => {
        throw new Error('first');
      },
    });
    bootRenderer({
      scope: 'test-dupe-b',
      title: 'Second failure',
      init: () => {
        throw new Error('second');
      },
    });
    expect(document.querySelectorAll('#lite-fatal')).toHaveLength(1);
    expect(banner()?.textContent).toContain('First failure');
  });

  it('paints from the window error listener while boot is still pending', () => {
    bootRenderer({
      scope: 'test-error-listener',
      title: 'Pending window failed to load',
      init: () => new Promise(() => undefined), // never settles
    });
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('boot-time crash') }));
    expect(banner()).not.toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('fatal in window.onerror')
    );
  });

  it('paints from the unhandledrejection listener while boot is still pending', () => {
    bootRenderer({
      scope: 'test-rejection-listener',
      title: 'Rejection window failed to load',
      init: () => new Promise(() => undefined), // never settles
    });
    // jsdom has no PromiseRejectionEvent constructor; a bare Event
    // exercises the listener (reason comes through as undefined).
    window.dispatchEvent(new Event('unhandledrejection'));
    expect(banner()).not.toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('fatal in unhandledrejection')
    );
  });
});
