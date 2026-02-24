import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  session: {
    fromPartition: vi.fn().mockReturnValue({
      webRequest: { onBeforeSendHeaders: vi.fn() },
    }),
  },
}));

describe('BrowserStealth', () => {
  let stealth;

  beforeEach(async () => {
    vi.clearAllMocks();
    stealth = await import('../../lib/browser-stealth.js');
  });

  describe('getUserAgent()', () => {
    it('should return a Chrome-like user agent string', () => {
      const ua = stealth.getUserAgent();
      expect(ua).toContain('Mozilla/5.0');
      expect(ua).toContain('Chrome/');
      expect(ua).toContain('Safari/537.36');
      expect(ua).not.toContain('Electron');
    });

    it('should include the actual Chrome version', () => {
      const ua = stealth.getUserAgent();
      expect(ua).toContain(stealth.CHROME_VERSION);
    });
  });

  describe('getSecChUa()', () => {
    it('should return a valid Sec-Ch-Ua header', () => {
      const header = stealth.getSecChUa();
      expect(header).toContain('Chromium');
      expect(header).toContain(stealth.CHROME_MAJOR);
      expect(header).not.toContain('Electron');
    });
  });

  describe('apply()', () => {
    it('should register event listeners on webContents', () => {
      const mockWebContents = {
        on: vi.fn(),
        setUserAgent: vi.fn(),
        executeJavaScript: vi.fn(),
      };

      const cleanup = stealth.apply(mockWebContents);

      expect(mockWebContents.on).toHaveBeenCalledWith('did-finish-load', expect.any(Function));
      expect(mockWebContents.on).toHaveBeenCalledWith('did-navigate-in-page', expect.any(Function));
      expect(mockWebContents.setUserAgent).toHaveBeenCalledWith(stealth.getUserAgent());
      expect(typeof cleanup).toBe('function');
    });

    it('should return a cleanup function that removes listeners', () => {
      const mockWebContents = {
        on: vi.fn(),
        setUserAgent: vi.fn(),
        removeListener: vi.fn(),
        executeJavaScript: vi.fn(),
      };

      const cleanup = stealth.apply(mockWebContents);
      cleanup();

      expect(mockWebContents.removeListener).toHaveBeenCalledWith('did-finish-load', expect.any(Function));
      expect(mockWebContents.removeListener).toHaveBeenCalledWith('did-navigate-in-page', expect.any(Function));
    });
  });

  describe('applyToSession()', () => {
    it('should be a callable function', () => {
      expect(typeof stealth.applyToSession).toBe('function');
    });
  });

  describe('applyHeaders()', () => {
    it('should register request header interceptor', () => {
      const mockSession = {
        webRequest: { onBeforeSendHeaders: vi.fn() },
      };

      stealth.applyHeaders(mockSession);
      expect(mockSession.webRequest.onBeforeSendHeaders).toHaveBeenCalled();
    });

    it('should set Chrome-like headers in interceptor callback', () => {
      const mockSession = {
        webRequest: { onBeforeSendHeaders: vi.fn() },
      };

      stealth.applyHeaders(mockSession);

      const [filter, callback] = mockSession.webRequest.onBeforeSendHeaders.mock.calls[0];
      expect(filter.urls).toContain('*://*/*');

      const mockCallback = vi.fn();
      callback(
        { requestHeaders: { 'X-Electron': 'true' }, resourceType: 'mainFrame' },
        mockCallback,
      );

      const result = mockCallback.mock.calls[0][0];
      expect(result.requestHeaders['User-Agent']).toBe(stealth.getUserAgent());
      expect(result.requestHeaders['Sec-Ch-Ua']).toBe(stealth.getSecChUa());
      expect(result.requestHeaders['X-Electron']).toBeUndefined();
      expect(result.requestHeaders['X-DevTools-Request-Id']).toBeUndefined();
    });
  });

  describe('Injection Script Content', () => {
    it('should contain all stealth overrides', () => {
      const mockWebContents = {
        on: vi.fn(),
        setUserAgent: vi.fn(),
        executeJavaScript: vi.fn().mockResolvedValue(undefined),
      };

      stealth.apply(mockWebContents);

      const didFinishLoad = mockWebContents.on.mock.calls.find(c => c[0] === 'did-finish-load');
      expect(didFinishLoad).toBeDefined();

      didFinishLoad[1]();
      expect(mockWebContents.executeJavaScript).toHaveBeenCalled();

      const script = String(mockWebContents.executeJavaScript.mock.calls[0][0]);

      expect(script).toContain('webdriver');
      expect(script).toContain('chrome');
      expect(script).toContain('PluginArray');
      expect(script).toContain('permissions');
      expect(script).toContain('WebGL');
      expect(script).toContain('Intel');
      expect(script).toContain('hasFocus');
    });
  });
});
