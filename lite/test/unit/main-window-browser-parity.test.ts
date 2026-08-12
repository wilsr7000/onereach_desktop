/**
 * ADR-063 — Chrome-parity for third-party tabs. Pins the behavior
 * table that decides whether a tab feels like Chrome or drives the
 * user back to it: window.open routing (popups for OAuth, tabs for
 * target=_blank, OS for mailto:, block for arbitrary schemes), the
 * Electron-free user agent, hardened popup options, and the
 * context-menu template.
 */
import { describe, it, expect } from 'vitest';

import {
  buildContextMenuTemplate,
  buildTabWindowOpenHandler,
  chromeParityUserAgent,
  classifyWindowOpen,
  parsePopupSize,
  popupWindowOptions,
  EXTERNAL_SCHEME_ALLOWLIST,
} from '../../main-window/browser-parity.js';

describe('classifyWindowOpen — the Chrome behavior table', () => {
  it('sized window.open() gets a real popup window (OAuth flows need opener/postMessage)', () => {
    expect(
      classifyWindowOpen('https://accounts.google.com/o/oauth2/auth', 'new-window', 'width=520,height=640')
    ).toBe('popup');
    expect(classifyWindowOpen('https://example.com/picker', 'other', 'popup=yes,width=400')).toBe(
      'popup'
    );
  });

  it('featureless opens become app tabs regardless of disposition (Chrome behavior; disposition lies in WebContentsView)', () => {
    expect(classifyWindowOpen('https://example.com/doc', 'foreground-tab')).toBe('tab');
    expect(classifyWindowOpen('https://example.com/doc', 'background-tab')).toBe('tab');
    expect(classifyWindowOpen('https://example.com/doc', 'default')).toBe('tab');
    // The live-drive regression: an anchor click surfacing as a
    // scripted open MUST still land in a tab.
    expect(classifyWindowOpen('https://example.com/doc', 'new-window')).toBe('tab');
    expect(classifyWindowOpen('https://example.com/doc', 'other', '   ')).toBe('tab');
  });

  it('parsePopupSize honors the request within clamps', () => {
    expect(parsePopupSize('width=520,height=420')).toEqual({ width: 520, height: 420 });
    expect(parsePopupSize('width=20,height=99999')).toEqual({ width: 320, height: 1600 });
    expect(parsePopupSize('menubar=no')).toEqual({ width: 980, height: 760 });
  });

  it('allowlisted schemes go to the OS; arbitrary protocols are blocked', () => {
    expect(classifyWindowOpen('mailto:robb@onereach.com', 'new-window')).toBe('external');
    expect(classifyWindowOpen('mailto:x@y.z', 'new-window', 'width=500')).toBe('external');
    expect(classifyWindowOpen('tel:+15551234567', 'new-window')).toBe('external');
    // A page must not get an arbitrary-app-launch primitive.
    expect(classifyWindowOpen('slack://open', 'new-window')).toBe('deny');
    expect(classifyWindowOpen('zoommtg://join?x=1', 'foreground-tab')).toBe('deny');
    expect(classifyWindowOpen('not a url', 'new-window')).toBe('deny');
  });

  it('the external allowlist stays small and vetted', () => {
    expect(EXTERNAL_SCHEME_ALLOWLIST).toEqual(['mailto:', 'tel:', 'sms:', 'facetime:', 'webcal:']);
  });
});

describe('chromeParityUserAgent', () => {
  it('carries Chrome and never Electron or the app name', () => {
    const ua = chromeParityUserAgent();
    expect(ua).toContain('Chrome/');
    expect(ua).toContain('Safari/537.36');
    expect(ua).not.toMatch(/Electron/i);
    expect(ua).not.toMatch(/onereach|gsx/i);
  });
});

describe('popupWindowOptions — popups stay sandboxed', () => {
  it('inherits the partition and the full ADR-038 hardening, with the PDF viewer on', () => {
    const opts = popupWindowOptions('persist:tab-x1');
    expect(opts.webPreferences).toMatchObject({
      partition: 'persist:tab-x1',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      plugins: true,
    });
    expect(opts.webPreferences).not.toHaveProperty('preload');
  });
});

describe('buildTabWindowOpenHandler routing', () => {
  function harness(): {
    handler: ReturnType<typeof buildTabWindowOpenHandler>;
    tabs: string[];
    external: string[];
    warns: string[];
  } {
    const tabs: string[] = [];
    const external: string[] = [];
    const warns: string[] = [];
    const handler = buildTabWindowOpenHandler({
      partition: 'persist:tab-a',
      openInNewTab: (url) => tabs.push(url),
      openExternal: (url) => external.push(url),
      logWarn: (message) => warns.push(message),
    });
    return { handler, tabs, external, warns };
  }

  it('popup route allows with hardened same-partition options', () => {
    const { handler } = harness();
    const result = handler({
      url: 'https://accounts.google.com/auth',
      disposition: 'new-window',
      features: 'width=520,height=640',
    } as never);
    expect(result.action).toBe('allow');
    expect(result.overrideBrowserWindowOptions).toMatchObject({ width: 520, height: 640 });
    expect(result.overrideBrowserWindowOptions?.webPreferences).toMatchObject({
      partition: 'persist:tab-a',
      sandbox: true,
    });
  });

  it('tab route denies the window and opens an app tab instead', () => {
    const { handler, tabs } = harness();
    const result = handler({
      url: 'https://example.com/article',
      disposition: 'foreground-tab',
    } as never);
    expect(result.action).toBe('deny');
    expect(tabs).toEqual(['https://example.com/article']);
  });

  it('external route shells out; unknown schemes deny with a log line', () => {
    const { handler, external, warns } = harness();
    expect(handler({ url: 'mailto:x@y.z', disposition: 'new-window' } as never).action).toBe(
      'deny'
    );
    expect(external).toEqual(['mailto:x@y.z']);
    expect(handler({ url: 'slack://open', disposition: 'new-window' } as never).action).toBe(
      'deny'
    );
    expect(warns).toHaveLength(1);
  });
});

describe('buildContextMenuTemplate — the right-click menu', () => {
  const base = { linkURL: '', mediaType: 'none', isEditable: false, selectionText: '', srcURL: '' };

  it('always leads with navigation, honoring history state', () => {
    const t = buildContextMenuTemplate(base as never, { canGoBack: false, canGoForward: true });
    expect(t[0]).toMatchObject({ id: 'back', enabled: false });
    expect(t[1]).toMatchObject({ id: 'forward', enabled: true });
    expect(t[2]).toMatchObject({ id: 'reload' });
  });

  it('adds link actions under a link', () => {
    const t = buildContextMenuTemplate(
      { ...base, linkURL: 'https://x.y/z' } as never,
      { canGoBack: true, canGoForward: false }
    );
    const ids = t.map((e) => e.id);
    expect(ids).toContain('open-link-new-tab');
    expect(ids).toContain('copy-link');
  });

  it('adds image actions over an image', () => {
    const t = buildContextMenuTemplate(
      { ...base, mediaType: 'image', srcURL: 'https://x.y/i.png' } as never,
      { canGoBack: false, canGoForward: false }
    );
    const ids = t.map((e) => e.id);
    expect(ids).toContain('copy-image');
    expect(ids).toContain('copy-image-address');
  });

  it('editable fields get the full edit section; plain selections just copy', () => {
    const editable = buildContextMenuTemplate(
      { ...base, isEditable: true } as never,
      { canGoBack: false, canGoForward: false }
    ).map((e) => e.id);
    for (const id of ['undo', 'redo', 'cut', 'copy', 'paste', 'select-all']) {
      expect(editable).toContain(id);
    }
    const selection = buildContextMenuTemplate(
      { ...base, selectionText: 'hello' } as never,
      { canGoBack: false, canGoForward: false }
    ).map((e) => e.id);
    expect(selection).toContain('copy');
    expect(selection).not.toContain('paste');
  });
});
