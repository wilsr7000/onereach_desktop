import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mocks ---

const mockWebContents = {
  executeJavaScript: vi.fn().mockResolvedValue({}),
  setUserAgent: vi.fn(),
  getURL: vi.fn().mockReturnValue('https://example.com'),
  getTitle: vi.fn().mockReturnValue('Example'),
  capturePage: vi.fn().mockResolvedValue({
    toPNG: () => Buffer.from('fake-png'),
    toJPEG: () => Buffer.from('fake-jpeg'),
    getSize: () => ({ width: 1280, height: 900 }),
  }),
  on: vi.fn(),
  once: vi.fn((event, handler) => { if (event === 'dom-ready') setTimeout(handler, 10); }),
  removeListener: vi.fn(),
  removeAllListeners: vi.fn(),
  isDestroyed: vi.fn().mockReturnValue(false),
  destroy: vi.fn(),
  enableDeviceEmulation: vi.fn(),
  disableDeviceEmulation: vi.fn(),
  sendInputEvent: vi.fn(),
  insertText: vi.fn().mockResolvedValue(undefined),
};

const mockBrowserWindow = {
  loadURL: vi.fn().mockResolvedValue(undefined),
  show: vi.fn(),
  focus: vi.fn(),
  close: vi.fn(),
  setSize: vi.fn(),
  isDestroyed: vi.fn().mockReturnValue(false),
  getContentBounds: vi.fn().mockReturnValue({ width: 1280, height: 900 }),
  addBrowserView: vi.fn(),
  removeBrowserView: vi.fn(),
  on: vi.fn(),
  webContents: mockWebContents,
};

function MockBrowserWindow() { return mockBrowserWindow; }
MockBrowserWindow.prototype = {};

function MockBrowserView() {
  return { setBounds: vi.fn(), webContents: { loadURL: vi.fn(), destroy: vi.fn() } };
}

const mockCookieStore = [];
const mockSessionObj = {
  webRequest: { onBeforeSendHeaders: vi.fn(), onCompleted: vi.fn(), onErrorOccurred: vi.fn() },
  cookies: {
    get: vi.fn().mockImplementation(async (filter) => {
      if (filter.domain) return mockCookieStore.filter((c) => c.domain === filter.domain);
      if (filter.url) return mockCookieStore.filter((c) => filter.url.includes(c.domain));
      return [...mockCookieStore];
    }),
    set: vi.fn().mockResolvedValue(undefined),
    flushStore: vi.fn().mockResolvedValue(undefined),
  },
};

const mockElectron = {
  BrowserWindow: MockBrowserWindow,
  BrowserView: MockBrowserView,
  session: {
    fromPartition: vi.fn().mockReturnValue(mockSessionObj),
  },
  app: { getAppPath: () => '/mock/app' },
};

const mockStealth = {
  apply: vi.fn().mockReturnValue(() => {}),
  applyToSession: vi.fn(),
  getUserAgent: vi.fn().mockReturnValue('Mozilla/5.0 Chrome/125.0.0.0'),
  getSecChUa: vi.fn().mockReturnValue('"Chromium";v="125"'),
  applyHeaders: vi.fn(),
};

const mockErrorDetector = {
  detect: vi.fn().mockResolvedValue({ blocked: false, type: 'clear', action: 'continue', details: {} }),
  dismissConsent: vi.fn().mockResolvedValue({ dismissed: true }),
};

const mockSafety = {
  validateSessionCreation: vi.fn().mockReturnValue({ allowed: true }),
  isDomainBlocked: vi.fn().mockReturnValue({ blocked: false }),
  checkActionSafety: vi.fn().mockReturnValue({ safe: true, issues: [], requiresConfirmation: false }),
};

describe('BrowsingAPI', () => {
  let browsingAPI;

  beforeEach(async () => {
    vi.clearAllMocks();
    if (!browsingAPI) {
      const module = await import('../../lib/browsing-api.js');
      browsingAPI = module.default || module;
    }
    browsingAPI._injectDeps({
      electron: mockElectron,
      stealth: mockStealth,
      errorDetector: mockErrorDetector,
      safety: mockSafety,
    });
    vi.spyOn(browsingAPI, '_wait').mockResolvedValue();
    browsingAPI.sessions.clear();
    browsingAPI._autoAuthAttempted = new Set();
  });

  afterEach(() => {
    for (const [id] of browsingAPI.sessions) {
      browsingAPI.sessions.delete(id);
    }
  });

  describe('Session Lifecycle', () => {
    it('should create a session and return session info', async () => {
      const result = await browsingAPI.createSession({ mode: 'auto' });

      expect(result.sessionId).toBeDefined();
      expect(result.mode).toBe('auto');
      expect(result.status).toBe('created');
      expect(result.actionCount).toBe(0);
      expect(browsingAPI.sessions.size).toBe(1);
    });

    it('should create a session with custom options', async () => {
      const result = await browsingAPI.createSession({
        mode: 'hitl',
        persistent: true,
        partition: 'test-partition',
        timeout: 60000,
        maxActions: 30,
      });

      expect(result.mode).toBe('hitl');
      expect(result.maxActions).toBe(30);
    });

    it('should enforce max concurrent sessions', async () => {
      browsingAPI._maxConcurrent = 2;

      await browsingAPI.createSession();
      await browsingAPI.createSession();

      await expect(browsingAPI.createSession()).rejects.toThrow('Max concurrent sessions');

      browsingAPI._maxConcurrent = 5;
    });

    it('should destroy a session', async () => {
      const sess = await browsingAPI.createSession();
      const result = await browsingAPI.destroySession(sess.sessionId);

      expect(result.destroyed).toBe(true);
      expect(browsingAPI.sessions.size).toBe(0);
    });

    it('should return error when destroying non-existent session', async () => {
      const result = await browsingAPI.destroySession('fake-id');
      expect(result.destroyed).toBe(false);
    });

    it('should list all sessions', async () => {
      await browsingAPI.createSession({ mode: 'auto' });
      await browsingAPI.createSession({ mode: 'hitl' });

      const sessions = browsingAPI.listSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions[0].mode).toBe('auto');
      expect(sessions[1].mode).toBe('hitl');
    });

    it('should get a specific session', async () => {
      const sess = await browsingAPI.createSession();
      const info = browsingAPI.getSession(sess.sessionId);

      expect(info.sessionId).toBe(sess.sessionId);
      expect(info.status).toBe('created');
    });

    it('should return null for non-existent session', () => {
      expect(browsingAPI.getSession('fake')).toBeNull();
    });
  });

  describe('Navigation', () => {
    it('should navigate to a URL', async () => {
      const sess = await browsingAPI.createSession();
      const result = await browsingAPI.navigate(sess.sessionId, 'https://example.com');

      expect(mockBrowserWindow.loadURL).toHaveBeenCalledWith('https://example.com');
      expect(result.url).toBe('https://example.com');
      expect(result.title).toBe('Example');
      expect(result.status).toBe('loaded');
    });

    it('should throw for non-existent session', async () => {
      await expect(browsingAPI.navigate('fake', 'https://example.com')).rejects.toThrow('not found');
    });

    it('should run error detection after navigation', async () => {
      const sess = await browsingAPI.createSession();
      const result = await browsingAPI.navigate(sess.sessionId, 'https://example.com');

      expect(result.status).toBe('loaded');
      expect(mockErrorDetector.detect).toHaveBeenCalled();
    });

    it('should track navigation in history', async () => {
      const sess = await browsingAPI.createSession();
      await browsingAPI.navigate(sess.sessionId, 'https://example.com');

      const session = browsingAPI.sessions.get(sess.sessionId);
      expect(session.history).toHaveLength(1);
      expect(session.history[0].action).toBe('navigate');
      expect(session.history[0].url).toBe('https://example.com');
    });

    it('should try auto-auth with pool cookies before prompting user', async () => {
      const authCookie = { name: 'tok', value: 'abc', domain: '.example.com', path: '/', secure: true, httpOnly: true };

      // Reset detect mock to ensure clean state, then set up the chain
      mockErrorDetector.detect.mockReset()
        .mockResolvedValueOnce({ blocked: true, type: 'auth-wall', message: 'Login required' })  // initial detect
        .mockResolvedValueOnce({ blocked: false, type: 'clear' })  // after reload with inherited cookies
        .mockResolvedValue({ blocked: false, type: 'clear', action: 'continue', details: {} });   // default fallback

      // Pool has cookies -> inherit succeeds -> reload resolves auth
      mockSessionObj.cookies.get
        .mockResolvedValueOnce([authCookie])  // _tryAutoAuth: pool check
        .mockResolvedValueOnce([authCookie])  // inheritFromPartition copy
        .mockResolvedValueOnce([authCookie]); // saveToAuthPool after success

      browsingAPI.setTabDiscoveryFn(async () => []);

      const sess = await browsingAPI.createSession({ mode: 'auto' });
      const result = await browsingAPI.navigate(sess.sessionId, 'https://secure.example.com');

      expect(result.status).toBe('loaded');
      expect(mockErrorDetector.detect).toHaveBeenCalledTimes(2);
      expect(result.blocked).toBe(false);
    });

    it('should skip auto-auth when _skipAutoAuth opt is set', async () => {
      mockErrorDetector.detect.mockReset()
        .mockResolvedValueOnce({ blocked: true, type: 'auth-wall', message: 'Login required' })
        .mockResolvedValue({ blocked: false, type: 'clear', action: 'continue', details: {} });

      const sess = await browsingAPI.createSession({ mode: 'auto' });
      const result = await browsingAPI.navigate(sess.sessionId, 'https://secure.example.com', { _skipAutoAuth: true });

      expect(result.blocked).toBe(true);
      expect(mockErrorDetector.detect).toHaveBeenCalledTimes(1);
    });

    it('should fall through to HITL when auto-auth has no sources', async () => {
      mockErrorDetector.detect.mockReset()
        .mockResolvedValue({ blocked: true, type: 'auth-wall', message: 'Login required' });

      mockSessionObj.cookies.get.mockResolvedValue([]);
      browsingAPI.setTabDiscoveryFn(async () => []);

      const sess = await browsingAPI.createSession({ mode: 'auto-promote' });
      const result = await browsingAPI.navigate(sess.sessionId, 'https://locked.example.com');

      expect(result.blocked).toBe(true);
      expect(result.detection.type).toBe('auth-wall');
      expect(mockBrowserWindow.show).toHaveBeenCalled();
    });

    it('should save to auth pool after successful auto-auth from tab', async () => {
      const authCookie = { name: 'sess', value: 'tok', domain: '.example.com', path: '/', secure: true, httpOnly: true };

      mockErrorDetector.detect.mockReset()
        .mockResolvedValueOnce({ blocked: true, type: 'auth-wall', message: 'Login required' })
        .mockResolvedValueOnce({ blocked: false, type: 'clear' })
        .mockResolvedValue({ blocked: false, type: 'clear', action: 'continue', details: {} });

      mockSessionObj.cookies.get
        .mockResolvedValueOnce([])            // _tryAutoAuth: pool check (empty)
        .mockResolvedValueOnce([authCookie])  // inheritFromPartition: tab cookie copy
        .mockResolvedValueOnce([authCookie]); // saveToAuthPool after success

      browsingAPI.setTabDiscoveryFn(async () => [
        { partition: 'persist:tab-123', url: 'https://example.com/dash', title: 'App' },
      ]);

      const sess = await browsingAPI.createSession({ mode: 'auto' });
      const result = await browsingAPI.navigate(sess.sessionId, 'https://example.com/app');

      expect(result.blocked).toBe(false);
      expect(mockSessionObj.cookies.flushStore).toHaveBeenCalled();
    });
  });

  describe('Content Extraction', () => {
    it('should extract page content', async () => {
      mockWebContents.executeJavaScript.mockResolvedValueOnce({
        text: 'Hello world',
        metadata: { title: 'Test' },
        links: [],
        headings: [],
      });

      const sess = await browsingAPI.createSession();
      // Navigate first to set up session state
      await browsingAPI.navigate(sess.sessionId, 'https://example.com');

      const result = await browsingAPI.extract(sess.sessionId);

      expect(result.text).toBe('Hello world');
      expect(result.metadata.title).toBe('Test');
    });

    it('should support different extraction modes', async () => {
      const sess = await browsingAPI.createSession();
      await browsingAPI.navigate(sess.sessionId, 'https://example.com');

      await browsingAPI.extract(sess.sessionId, { mode: 'raw' });

      const lastCall = mockWebContents.executeJavaScript.mock.calls.at(-1)[0];
      expect(lastCall).toContain("mode = 'raw'");
    });

    it('should handle extraction errors gracefully', async () => {
      mockWebContents.executeJavaScript.mockRejectedValueOnce(new Error('Page crashed'));

      const sess = await browsingAPI.createSession();
      await browsingAPI.navigate(sess.sessionId, 'https://example.com');

      const result = await browsingAPI.extract(sess.sessionId);
      expect(result.text).toBe('');
      expect(result.error).toBe('Page crashed');
    });
  });

  describe('Accessibility Snapshots', () => {
    it('should return accessibility snapshot with refs', async () => {
      mockWebContents.executeJavaScript.mockResolvedValueOnce({
        refs: [
          { ref: 1, role: 'button', name: 'Submit', tag: 'button' },
          { ref: 2, role: 'textbox', name: 'Email', tag: 'input', type: 'email' },
        ],
        totalElements: 2,
      });

      const sess = await browsingAPI.createSession();
      await browsingAPI.navigate(sess.sessionId, 'https://example.com');

      const snap = await browsingAPI.snapshot(sess.sessionId);

      expect(snap.refs).toHaveLength(2);
      expect(snap.refs[0].role).toBe('button');
      expect(snap.refs[1].type).toBe('email');
      expect(snap.url).toBe('https://example.com');
    });
  });

  describe('Actions', () => {
    it('should execute a click action', async () => {
      mockWebContents.executeJavaScript.mockResolvedValueOnce({ success: true });

      const sess = await browsingAPI.createSession();
      await browsingAPI.navigate(sess.sessionId, 'https://example.com');

      const result = await browsingAPI.act(sess.sessionId, { action: 'click', ref: 1 });

      expect(result.success).toBe(true);
      expect(result.actionCount).toBe(1);
    });

    it('should increment action count', async () => {
      mockWebContents.executeJavaScript.mockResolvedValue({ success: true });

      const sess = await browsingAPI.createSession({ maxActions: 50 });
      await browsingAPI.navigate(sess.sessionId, 'https://example.com');

      await browsingAPI.act(sess.sessionId, { action: 'click', ref: 1 });
      await browsingAPI.act(sess.sessionId, { action: 'click', ref: 2 });

      const result = await browsingAPI.act(sess.sessionId, { action: 'fill', ref: 3, value: 'hello' });
      expect(result.actionCount).toBe(3);
    });

    it('should enforce max actions limit', async () => {
      const sess = await browsingAPI.createSession({ maxActions: 2 });
      await browsingAPI.navigate(sess.sessionId, 'https://example.com');

      mockWebContents.executeJavaScript.mockResolvedValue({ success: true });
      await browsingAPI.act(sess.sessionId, { action: 'click', ref: 1 });
      await browsingAPI.act(sess.sessionId, { action: 'click', ref: 2 });

      const result = await browsingAPI.act(sess.sessionId, { action: 'click', ref: 3 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Max actions');
    });

    it('should track actions in history', async () => {
      mockWebContents.executeJavaScript.mockResolvedValue({ success: true });

      const sess = await browsingAPI.createSession();
      await browsingAPI.navigate(sess.sessionId, 'https://example.com');
      await browsingAPI.act(sess.sessionId, { action: 'fill', ref: 5, value: 'test@email.com' });

      const session = browsingAPI.sessions.get(sess.sessionId);
      const lastAction = session.history.at(-1);
      expect(lastAction.action).toBe('fill');
      expect(lastAction.ref).toBe(5);
      expect(lastAction.value).toBe('test@email.com');
    });
  });

  describe('Action Strategies', () => {
    it('should default to strategy "default" when not specified', async () => {
      mockWebContents.executeJavaScript.mockResolvedValue({ success: true });
      const sess = await browsingAPI.createSession();
      await browsingAPI.navigate(sess.sessionId, 'https://example.com');

      const result = await browsingAPI.act(sess.sessionId, { action: 'click', ref: 1 });
      expect(result.success).toBe(true);
      expect(result.strategy).toBe('default');
    });

    it('should execute fast strategy with direct DOM writes', async () => {
      mockWebContents.executeJavaScript.mockResolvedValue({ success: true });
      const sess = await browsingAPI.createSession();
      await browsingAPI.navigate(sess.sessionId, 'https://example.com');

      const result = await browsingAPI.act(sess.sessionId, { action: 'fill', ref: 3, value: 'hello', strategy: 'fast' });
      expect(result.success).toBe(true);
      expect(result.strategy).toBe('fast');

      const lastCall = mockWebContents.executeJavaScript.mock.calls.at(-1)[0];
      expect(lastCall).not.toContain('dispatchEvent');
      expect(lastCall).toContain('el.value = value');
      expect(lastCall).not.toContain('el.focus();\n        el.value');
    });

    it('should execute stealth strategy using sendInputEvent for click', async () => {
      mockWebContents.executeJavaScript.mockResolvedValue({ x: 100, y: 200, width: 50, height: 30 });
      const sess = await browsingAPI.createSession();
      await browsingAPI.navigate(sess.sessionId, 'https://example.com');

      const result = await browsingAPI.act(sess.sessionId, { action: 'click', ref: 5, strategy: 'stealth' });
      expect(result.success).toBe(true);
      expect(result.strategy).toBe('stealth');
      expect(result.trusted).toBe(true);
      expect(mockWebContents.sendInputEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'mouseDown', button: 'left' })
      );
      expect(mockWebContents.sendInputEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'mouseUp', button: 'left' })
      );
    });

    it('should execute stealth fill using insertText', async () => {
      mockWebContents.executeJavaScript.mockResolvedValue({ x: 50, y: 80, width: 200, height: 30 });
      const sess = await browsingAPI.createSession();
      await browsingAPI.navigate(sess.sessionId, 'https://example.com');

      const result = await browsingAPI.act(sess.sessionId, { action: 'fill', ref: 2, value: 'typed text', strategy: 'stealth' });
      expect(result.success).toBe(true);
      expect(result.trusted).toBe(true);
      expect(mockWebContents.insertText).toHaveBeenCalledWith('typed text');
    });

    it('should return element-not-found for stealth click when rect is null', async () => {
      mockWebContents.executeJavaScript.mockResolvedValue(null);
      const sess = await browsingAPI.createSession();
      await browsingAPI.navigate(sess.sessionId, 'https://example.com');

      const result = await browsingAPI.act(sess.sessionId, { action: 'click', ref: 99, strategy: 'stealth' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should support auto strategy that falls back from default to stealth', async () => {
      mockWebContents.executeJavaScript
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ exists: true, value: '', focused: false })
        .mockResolvedValueOnce({ x: 100, y: 200, width: 50, height: 30 })
        .mockResolvedValueOnce(undefined);
      const sess = await browsingAPI.createSession();
      await browsingAPI.navigate(sess.sessionId, 'https://example.com');

      const result = await browsingAPI.act(sess.sessionId, {
        action: 'fill', ref: 3, value: 'hello', strategy: 'auto',
      });
      expect(result.success).toBe(true);
      expect(result.strategy).toBe('auto');
      expect(result.fallback).toBe('stealth');
    });

    it('should track strategy in history', async () => {
      mockWebContents.executeJavaScript.mockResolvedValue({ success: true });
      const sess = await browsingAPI.createSession();
      await browsingAPI.navigate(sess.sessionId, 'https://example.com');

      await browsingAPI.act(sess.sessionId, { action: 'click', ref: 1, strategy: 'fast' });

      const session = browsingAPI.sessions.get(sess.sessionId);
      const lastAction = session.history.at(-1);
      expect(lastAction.strategy).toBe('fast');
    });

    it('fast strategy submit action should call form.submit', async () => {
      mockWebContents.executeJavaScript.mockResolvedValue({ success: true });
      const sess = await browsingAPI.createSession();
      await browsingAPI.navigate(sess.sessionId, 'https://example.com');

      const result = await browsingAPI.act(sess.sessionId, { action: 'submit', ref: 10, strategy: 'fast' });
      expect(result.success).toBe(true);

      const lastScript = mockWebContents.executeJavaScript.mock.calls.at(-1)[0];
      expect(lastScript).toContain('submit');
      expect(lastScript).toContain('closest');
    });
  });

  describe('Screenshots', () => {
    it('should capture a screenshot as PNG', async () => {
      const sess = await browsingAPI.createSession();
      await browsingAPI.navigate(sess.sessionId, 'https://example.com');

      const result = await browsingAPI.screenshot(sess.sessionId);

      expect(result.base64).toBeDefined();
      expect(result.width).toBe(1280);
      expect(result.height).toBe(900);
      expect(result.format).toBe('png');
    });

    it('should support JPEG format', async () => {
      const sess = await browsingAPI.createSession();
      await browsingAPI.navigate(sess.sessionId, 'https://example.com');

      const result = await browsingAPI.screenshot(sess.sessionId, { format: 'jpeg', quality: 50 });
      expect(result.format).toBe('jpeg');
    });
  });

  describe('HITL Promotion', () => {
    it('should promote a hidden session to visible', async () => {
      const sess = await browsingAPI.createSession({ mode: 'auto' });
      const result = await browsingAPI.promote(sess.sessionId, {
        reason: 'captcha',
        message: 'Solve the CAPTCHA',
      });

      expect(result.status).toBe('hitl');
      expect(mockBrowserWindow.show).toHaveBeenCalled();
      expect(mockBrowserWindow.focus).toHaveBeenCalled();
    });

    it('should not double-promote an already-HITL session', async () => {
      const sess = await browsingAPI.createSession({ mode: 'hitl' });
      await browsingAPI.promote(sess.sessionId);
      await browsingAPI.promote(sess.sessionId);

      expect(mockBrowserWindow.show).toHaveBeenCalledTimes(1);
    });

    it('should emit session:hitl event', async () => {
      const handler = vi.fn();
      browsingAPI.on('session:hitl', handler);

      const sess = await browsingAPI.createSession({ mode: 'auto' });
      await browsingAPI.promote(sess.sessionId, { reason: 'captcha' });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ reason: 'captcha' }));
      browsingAPI.removeListener('session:hitl', handler);
    });
  });

  describe('Parallel Sessions', () => {
    it('should run multiple extractions in parallel', async () => {
      mockWebContents.executeJavaScript.mockResolvedValue({
        text: 'Content from page',
        metadata: { title: 'Page' },
        links: [],
        headings: [],
      });

      const results = await browsingAPI.parallel([
        { url: 'https://site-a.com', extract: { mode: 'readability' } },
        { url: 'https://site-b.com', extract: { mode: 'raw' } },
      ]);

      expect(results).toHaveLength(2);
      // Sessions should be cleaned up after parallel
      expect(browsingAPI.sessions.size).toBe(0);
    });
  });

  describe('Console Log Capture', () => {
    it('should capture console messages on the session', async () => {
      const sess = await browsingAPI.createSession();
      const sessionObj = browsingAPI.sessions.get(sess.sessionId);
      expect(sessionObj._consoleLogs).toEqual([]);

      sessionObj._consoleLogs.push({ level: 3, message: 'Test error', timestamp: Date.now() });
      sessionObj._consoleLogs.push({ level: 2, message: 'Test warn', timestamp: Date.now() });

      const logs = browsingAPI.getConsoleLogs(sess.sessionId, { clear: false });
      expect(logs).toHaveLength(2);
      expect(logs[0].message).toBe('Test error');
      expect(logs[1].message).toBe('Test warn');
    });

    it('should clear logs when clear=true', async () => {
      const sess = await browsingAPI.createSession();
      const sessionObj = browsingAPI.sessions.get(sess.sessionId);
      sessionObj._consoleLogs.push({ level: 2, message: 'msg', timestamp: Date.now() });

      const logs = browsingAPI.getConsoleLogs(sess.sessionId, { clear: true });
      expect(logs).toHaveLength(1);
      expect(browsingAPI.getConsoleLogs(sess.sessionId, { clear: false })).toHaveLength(0);
    });

    it('should filter logs by since timestamp', async () => {
      const sess = await browsingAPI.createSession();
      const sessionObj = browsingAPI.sessions.get(sess.sessionId);
      const now = Date.now();
      sessionObj._consoleLogs.push({ level: 2, message: 'old', timestamp: now - 5000 });
      sessionObj._consoleLogs.push({ level: 3, message: 'new', timestamp: now + 1000 });

      const logs = browsingAPI.getConsoleLogs(sess.sessionId, { since: now, clear: false });
      expect(logs).toHaveLength(1);
      expect(logs[0].message).toBe('new');
    });
  });

  describe('Network Log Capture', () => {
    it('should capture network errors on the session', async () => {
      const sess = await browsingAPI.createSession();
      const sessionObj = browsingAPI.sessions.get(sess.sessionId);
      expect(sessionObj._networkLog).toEqual([]);

      sessionObj._networkLog.push({ url: 'https://api.example.com/data', status: 500, method: 'POST', timestamp: Date.now() });
      sessionObj._networkLog.push({ url: 'https://api.example.com/auth', error: 'net::ERR_CONNECTION_REFUSED', method: 'GET', timestamp: Date.now() });

      const logs = browsingAPI.getNetworkLog(sess.sessionId, { clear: false });
      expect(logs).toHaveLength(2);
      expect(logs[0].status).toBe(500);
      expect(logs[1].error).toContain('REFUSED');
    });

    it('should clear network logs when clear=true', async () => {
      const sess = await browsingAPI.createSession();
      const sessionObj = browsingAPI.sessions.get(sess.sessionId);
      sessionObj._networkLog.push({ url: 'https://x.com', status: 404, method: 'GET', timestamp: Date.now() });

      browsingAPI.getNetworkLog(sess.sessionId, { clear: true });
      expect(browsingAPI.getNetworkLog(sess.sessionId, { clear: false })).toHaveLength(0);
    });
  });

  describe('DOM Context', () => {
    it('should execute dom context script and return result', async () => {
      mockWebContents.executeJavaScript.mockResolvedValue({
        html: '<form><input ref=5 name="title"/></form>',
        ref: 5,
        tag: 'input',
        labels: ['Title'],
        fieldset: null,
        form: { id: 'ticket-form', action: '/api/tickets' },
      });

      const sess = await browsingAPI.createSession();
      const result = await browsingAPI.getDomContext(sess.sessionId, 5, { depth: 2 });

      expect(result.html).toContain('form');
      expect(result.tag).toBe('input');
      expect(result.labels).toContain('Title');
      expect(mockWebContents.executeJavaScript).toHaveBeenCalled();
    });

    it('should return error for invalid ref', async () => {
      mockWebContents.executeJavaScript.mockResolvedValue({ html: '', error: 'Element not found', ref: 999 });

      const sess = await browsingAPI.createSession();
      const result = await browsingAPI.getDomContext(sess.sessionId, 999);

      expect(result.error).toBe('Element not found');
    });
  });

  describe('Viewport / Mobile Emulation', () => {
    it('should create a desktop session by default', async () => {
      const sess = await browsingAPI.createSession();
      expect(sess.viewport).toBeTruthy();
      expect(sess.viewport.mobile).toBe(false);
      expect(sess.viewport.preset).toBe('desktop');
    });

    it('should create a mobile session with string preset', async () => {
      const sess = await browsingAPI.createSession({ viewport: 'mobile' });
      expect(sess.viewport.mobile).toBe(true);
      expect(sess.viewport.width).toBe(390);
      expect(sess.viewport.height).toBe(844);
      expect(mockWebContents.enableDeviceEmulation).toHaveBeenCalled();
      expect(mockWebContents.setUserAgent).toHaveBeenCalledWith(
        expect.stringContaining('iPhone')
      );
    });

    it('should accept named device presets', async () => {
      const sess = await browsingAPI.createSession({ viewport: 'ipad' });
      expect(sess.viewport.mobile).toBe(true);
      expect(sess.viewport.width).toBe(820);
      expect(sess.viewport.height).toBe(1180);
    });

    it('should accept android preset', async () => {
      const sess = await browsingAPI.createSession({ viewport: 'android' });
      expect(sess.viewport.mobile).toBe(true);
      expect(sess.viewport.width).toBe(412);
      expect(mockWebContents.setUserAgent).toHaveBeenCalledWith(
        expect.stringContaining('Android')
      );
    });

    it('should accept custom viewport object', async () => {
      const sess = await browsingAPI.createSession({
        viewport: { width: 360, height: 640, scaleFactor: 3, mobile: true },
      });
      expect(sess.viewport.mobile).toBe(true);
      expect(sess.viewport.width).toBe(360);
      expect(sess.viewport.height).toBe(640);
      expect(sess.viewport.preset).toBe('custom');
    });

    it('should throw on unknown preset', async () => {
      await expect(browsingAPI.createSession({ viewport: 'nokia-3310' }))
        .rejects.toThrow('Unknown viewport preset');
    });

    it('should switch viewport mid-session with setViewport', async () => {
      const sess = await browsingAPI.createSession();
      expect(sess.viewport.mobile).toBe(false);

      const result = await browsingAPI.setViewport(sess.sessionId, 'mobile');
      expect(result.mobile).toBe(true);
      expect(result.width).toBe(390);
      expect(mockWebContents.enableDeviceEmulation).toHaveBeenCalled();
    });

    it('should switch back to desktop from mobile', async () => {
      const sess = await browsingAPI.createSession({ viewport: 'mobile' });
      expect(sess.viewport.mobile).toBe(true);

      const result = await browsingAPI.setViewport(sess.sessionId, 'desktop');
      expect(result.mobile).toBe(false);
      expect(mockWebContents.disableDeviceEmulation).toHaveBeenCalled();
    });

    it('should list available device presets', () => {
      const presets = browsingAPI.getDevicePresets();
      expect(presets.length).toBeGreaterThan(0);
      const names = presets.map((p) => p.name);
      expect(names).toContain('desktop');
      expect(names).toContain('mobile');
      expect(names).toContain('iphone-15');
      expect(names).toContain('ipad');
      expect(names).toContain('android');
      presets.forEach((p) => {
        expect(p).toHaveProperty('width');
        expect(p).toHaveProperty('height');
        expect(p).toHaveProperty('mobile');
      });
    });
  });

  describe('Cookie Management', () => {
    it('should get cookies for a session with httpOnly values redacted', async () => {
      mockSessionObj.cookies.get.mockResolvedValueOnce([
        { name: 'session_id', value: 'abc123', domain: 'example.com', path: '/', secure: true, httpOnly: true, sameSite: 'lax' },
        { name: 'theme', value: 'dark', domain: 'example.com', path: '/', secure: false, httpOnly: false },
      ]);
      const sess = await browsingAPI.createSession();
      const cookies = await browsingAPI.getCookies(sess.sessionId);
      expect(cookies).toHaveLength(2);
      expect(cookies[0].name).toBe('session_id');
      expect(cookies[0].value).toBe('[httpOnly]');
      expect(cookies[0].sameSite).toBe('lax');
      expect(cookies[1].value).toBe('dark');
    });

    it('should include httpOnly values when includeValues is true', async () => {
      mockSessionObj.cookies.get.mockResolvedValueOnce([
        { name: 'session_id', value: 'abc123', domain: 'example.com', path: '/', secure: true, httpOnly: true },
      ]);
      const sess = await browsingAPI.createSession();
      const cookies = await browsingAPI.getCookies(sess.sessionId, { includeValues: true });
      expect(cookies[0].value).toBe('abc123');
    });

    it('should filter cookies by domain', async () => {
      mockSessionObj.cookies.get.mockResolvedValueOnce([
        { name: 'token', value: 'xyz', domain: 'api.example.com', path: '/', secure: false, httpOnly: false },
      ]);
      const sess = await browsingAPI.createSession();
      const cookies = await browsingAPI.getCookies(sess.sessionId, { domain: 'api.example.com' });
      expect(cookies).toHaveLength(1);
      expect(mockSessionObj.cookies.get).toHaveBeenCalledWith(expect.objectContaining({ domain: 'api.example.com' }));
    });

    it('should set cookies on a session', async () => {
      const sess = await browsingAPI.createSession();
      const results = await browsingAPI.setCookies(sess.sessionId, [
        { name: 'auth', value: 'token123', domain: 'example.com' },
      ]);
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(mockSessionObj.cookies.set).toHaveBeenCalled();
      expect(mockSessionObj.cookies.flushStore).toHaveBeenCalled();
    });

    it('should export cookies as a transferable object', async () => {
      mockSessionObj.cookies.get.mockResolvedValueOnce([
        { name: 'sid', value: '999', domain: 'example.com', path: '/', secure: true, httpOnly: true },
      ]);
      const sess = await browsingAPI.createSession();
      const exported = await browsingAPI.exportCookies(sess.sessionId);
      expect(exported.cookies).toHaveLength(1);
      expect(exported.exportedAt).toBeGreaterThan(0);
      expect(exported.sessionId).toBe(sess.sessionId);
    });

    it('should import cookies from an export', async () => {
      const sess = await browsingAPI.createSession();
      const result = await browsingAPI.importCookies(sess.sessionId, {
        cookies: [
          { name: 'a', value: '1', domain: 'x.com' },
          { name: 'b', value: '2', domain: 'x.com' },
        ],
      });
      expect(result.imported).toBe(2);
      expect(result.total).toBe(2);
    });

    it('should return error for empty import', async () => {
      const sess = await browsingAPI.createSession();
      const result = await browsingAPI.importCookies(sess.sessionId, { cookies: [] });
      expect(result.imported).toBe(0);
      expect(result.error).toContain('No cookies');
    });
  });

  describe('Session Cloning', () => {
    it('should clone a session with cookies', async () => {
      mockSessionObj.cookies.get.mockResolvedValueOnce([
        { name: 'auth', value: 'tok', domain: 'example.com', path: '/', secure: true },
      ]);
      const sess = await browsingAPI.createSession({ persistent: true, partition: 'original' });
      const cloned = await browsingAPI.cloneSession(sess.sessionId, { partition: 'clone-test' });
      expect(cloned.sessionId).toBeTruthy();
      expect(cloned.clonedFrom).toBe(sess.sessionId);
      expect(cloned.cookiesCloned).toBe(true);
    });

    it('should create a new session even if cookie clone fails', async () => {
      mockSessionObj.cookies.get.mockRejectedValueOnce(new Error('Cookie access denied'));
      const sess = await browsingAPI.createSession();
      const cloned = await browsingAPI.cloneSession(sess.sessionId);
      expect(cloned.sessionId).toBeTruthy();
      expect(cloned.cookieCloneError).toContain('Cookie access denied');
    });
  });

  describe('Auth State Detection', () => {
    it('should detect logged-in state with session cookies', async () => {
      mockSessionObj.cookies.get.mockResolvedValueOnce([
        { name: 'session_token', value: 'abc', domain: 'example.com', path: '/' },
      ]);
      mockErrorDetector.detect.mockResolvedValueOnce({ blocked: false, type: 'clear' });

      const sess = await browsingAPI.createSession();
      const state = await browsingAPI.checkAuthState(sess.sessionId);
      expect(state.loggedIn).toBe(true);
      expect(state.hasSessionCookies).toBe(true);
      expect(state.authWall).toBe(false);
    });

    it('should detect auth wall state', async () => {
      mockSessionObj.cookies.get.mockResolvedValueOnce([]);
      mockErrorDetector.detect.mockResolvedValueOnce({ blocked: true, type: 'auth-wall' });

      const sess = await browsingAPI.createSession();
      const state = await browsingAPI.checkAuthState(sess.sessionId);
      expect(state.loggedIn).toBe(false);
      expect(state.authWall).toBe(true);
    });

    it('should detect CAPTCHA state', async () => {
      mockSessionObj.cookies.get.mockResolvedValueOnce([]);
      mockErrorDetector.detect.mockResolvedValueOnce({ blocked: true, type: 'captcha' });

      const sess = await browsingAPI.createSession();
      const state = await browsingAPI.checkAuthState(sess.sessionId);
      expect(state.captcha).toBe(true);
      expect(state.loggedIn).toBe(false);
    });

    it('should detect MFA state', async () => {
      mockSessionObj.cookies.get.mockResolvedValueOnce([]);
      mockErrorDetector.detect.mockResolvedValueOnce({ blocked: true, type: 'mfa' });

      const sess = await browsingAPI.createSession();
      const state = await browsingAPI.checkAuthState(sess.sessionId);
      expect(state.mfa).toBe(true);
      expect(state.detectionType).toBe('mfa');
      expect(state.blocked).toBe(true);
      expect(state.loggedIn).toBe(false);
    });

    it('should detect OAuth state', async () => {
      mockSessionObj.cookies.get.mockResolvedValueOnce([]);
      mockErrorDetector.detect.mockResolvedValueOnce({ blocked: true, type: 'oauth' });

      const sess = await browsingAPI.createSession();
      const state = await browsingAPI.checkAuthState(sess.sessionId);
      expect(state.oauth).toBe(true);
      expect(state.detectionType).toBe('oauth');
      expect(state.blocked).toBe(true);
    });

    it('should include detectionType in all responses', async () => {
      mockSessionObj.cookies.get.mockResolvedValueOnce([]);
      mockErrorDetector.detect.mockResolvedValueOnce({ blocked: false, type: 'clear' });

      const sess = await browsingAPI.createSession();
      const state = await browsingAPI.checkAuthState(sess.sessionId);
      expect(state.detectionType).toBe('clear');
      expect(state.blocked).toBe(false);
    });
  });

  describe('Credential Lookup', () => {
    it('should return credentials list without passwords', async () => {
      const creds = await browsingAPI.lookupCredentials('https://example.com');
      expect(Array.isArray(creds)).toBe(true);
    });
  });

  describe('Events', () => {
    it('should emit session:created event', async () => {
      const handler = vi.fn();
      browsingAPI.on('session:created', handler);

      await browsingAPI.createSession();
      expect(handler).toHaveBeenCalledTimes(1);

      browsingAPI.removeListener('session:created', handler);
    });

    it('should emit session:destroyed event', async () => {
      const handler = vi.fn();
      browsingAPI.on('session:destroyed', handler);

      const sess = await browsingAPI.createSession();
      await browsingAPI.destroySession(sess.sessionId);

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: sess.sessionId }));
      browsingAPI.removeListener('session:destroyed', handler);
    });
  });

  describe('inheritFromPartition', () => {
    it('should copy cookies from a source partition into session', async () => {
      const sess = await browsingAPI.createSession({ persistent: true });
      mockSessionObj.cookies.get.mockResolvedValueOnce([
        { name: 'tok', value: 'abc', domain: '.example.com', path: '/', secure: true, httpOnly: true, sameSite: 'lax' },
        { name: 'sid', value: '123', domain: '.example.com', path: '/', secure: false, httpOnly: false },
      ]);

      const result = await browsingAPI.inheritFromPartition(sess.sessionId, 'persist:tab-source', { domain: '.example.com' });

      expect(result.inherited).toBe(2);
      expect(result.source).toBe('persist:tab-source');
      expect(mockSessionObj.cookies.set).toHaveBeenCalledTimes(2);
      expect(mockSessionObj.cookies.flushStore).toHaveBeenCalled();
    });

    it('should return 0 inherited when source has no cookies', async () => {
      const sess = await browsingAPI.createSession();
      mockSessionObj.cookies.get.mockResolvedValueOnce([]);

      const result = await browsingAPI.inheritFromPartition(sess.sessionId, 'persist:empty');
      expect(result.inherited).toBe(0);
    });

    it('should filter by domain when provided', async () => {
      const sess = await browsingAPI.createSession();
      mockSessionObj.cookies.get.mockResolvedValueOnce([
        { name: 'a', value: 'x', domain: '.target.com', path: '/', secure: false, httpOnly: false },
      ]);

      await browsingAPI.inheritFromPartition(sess.sessionId, 'persist:src', { domain: '.target.com' });
      expect(mockSessionObj.cookies.get).toHaveBeenCalledWith({ domain: '.target.com' });
    });

    it('should preserve sameSite attribute', async () => {
      const sess = await browsingAPI.createSession();
      mockSessionObj.cookies.get.mockResolvedValueOnce([
        { name: 'c', value: 'v', domain: '.ex.com', path: '/', secure: true, httpOnly: false, sameSite: 'strict' },
      ]);

      await browsingAPI.inheritFromPartition(sess.sessionId, 'persist:src');
      expect(mockSessionObj.cookies.set).toHaveBeenCalledWith(
        expect.objectContaining({ sameSite: 'strict' })
      );
    });

    it('should handle errors gracefully', async () => {
      const sess = await browsingAPI.createSession();
      mockSessionObj.cookies.get.mockRejectedValueOnce(new Error('partition not found'));

      const result = await browsingAPI.inheritFromPartition(sess.sessionId, 'persist:bad');
      expect(result.inherited).toBe(0);
      expect(result.error).toBe('partition not found');
    });
  });

  describe('cloneSession (refactored)', () => {
    it('should use inheritFromPartition internally', async () => {
      const source = await browsingAPI.createSession({ mode: 'auto', persistent: true });
      mockSessionObj.cookies.get.mockResolvedValueOnce([
        { name: 's', value: 'v', domain: '.test.com', path: '/', secure: false, httpOnly: false },
      ]);

      const result = await browsingAPI.cloneSession(source.sessionId);

      expect(result.clonedFrom).toBe(source.sessionId);
      expect(result.cookiesCloned).toBe(true);
      expect(result.cookiesCopied).toBe(1);
    });
  });

  describe('Tab Discovery', () => {
    it('should find a tab matching a domain', async () => {
      browsingAPI.setTabDiscoveryFn(async () => [
        { partition: 'persist:tab-1', url: 'https://app.example.com/dashboard', title: 'Dashboard' },
        { partition: 'persist:tab-2', url: 'https://other.com', title: 'Other' },
      ]);

      const tab = await browsingAPI._findTabForDomain('app.example.com');
      expect(tab).toBeTruthy();
      expect(tab.partition).toBe('persist:tab-1');
    });

    it('should match subdomains', async () => {
      browsingAPI.setTabDiscoveryFn(async () => [
        { partition: 'persist:tab-1', url: 'https://sub.example.com/page', title: 'Sub' },
      ]);

      const tab = await browsingAPI._findTabForDomain('example.com');
      expect(tab).toBeTruthy();
      expect(tab.partition).toBe('persist:tab-1');
    });

    it('should return null when no tab matches', async () => {
      browsingAPI.setTabDiscoveryFn(async () => [
        { partition: 'persist:tab-1', url: 'https://other.com', title: 'Other' },
      ]);

      const tab = await browsingAPI._findTabForDomain('example.com');
      expect(tab).toBeNull();
    });

    it('should return null when no discovery function is set', async () => {
      browsingAPI.setTabDiscoveryFn(null);
      const tab = await browsingAPI._findTabForDomain('example.com');
      expect(tab).toBeNull();
    });
  });

  describe('Auth Pool', () => {
    it('should save session cookies to auth pool partition', async () => {
      const sess = await browsingAPI.createSession({ persistent: true });
      mockWebContents.getURL.mockReturnValue('https://studio.onereach.ai/bots');
      mockSessionObj.cookies.get.mockResolvedValueOnce([
        { name: 'auth', value: 'tok123', domain: '.onereach.ai', path: '/', secure: true, httpOnly: true },
      ]);

      const result = await browsingAPI.saveToAuthPool(sess.sessionId);

      expect(result.saved).toBe(true);
      expect(result.domain).toBe('studio.onereach.ai');
      expect(result.cookies).toBe(1);
      expect(result.partition).toBe('persist:auth-pool-studio.onereach.ai');
      expect(mockSessionObj.cookies.set).toHaveBeenCalled();
      expect(mockSessionObj.cookies.flushStore).toHaveBeenCalled();
    });

    it('should return saved=false when no cookies found', async () => {
      const sess = await browsingAPI.createSession();
      mockWebContents.getURL.mockReturnValue('https://empty.com');
      mockSessionObj.cookies.get.mockResolvedValueOnce([]);

      const result = await browsingAPI.saveToAuthPool(sess.sessionId);
      expect(result.saved).toBe(false);
      expect(result.reason).toBe('no-cookies');
    });

    it('should track pool domains', async () => {
      const sess = await browsingAPI.createSession({ persistent: true });
      mockWebContents.getURL.mockReturnValue('https://app.example.com/page');
      mockSessionObj.cookies.get.mockResolvedValueOnce([
        { name: 'x', value: 'y', domain: '.example.com', path: '/', secure: false, httpOnly: false },
      ]);

      await browsingAPI.saveToAuthPool(sess.sessionId);
      const domains = await browsingAPI.getAuthPoolDomains();
      expect(domains).toContain('app.example.com');
    });

    it('should normalize pool partition names (strip www)', () => {
      expect(browsingAPI._authPoolPartition('www.example.com')).toBe('persist:auth-pool-example.com');
      expect(browsingAPI._authPoolPartition('app.example.com')).toBe('persist:auth-pool-app.example.com');
    });
  });

  describe('createSession with inheritSession', () => {
    it('should inherit from pool when cookies exist', async () => {
      const poolCookie = { name: 'a', value: 'b', domain: '.example.com', path: '/', secure: true, httpOnly: false };
      mockSessionObj.cookies.get
        .mockResolvedValueOnce([poolCookie])  // tryPool: poolSes.cookies.get({}) -- pool has cookies
        .mockResolvedValueOnce([poolCookie]); // inheritFromPartition: sourceSes.cookies.get({domain})

      const result = await browsingAPI.createSession({
        inheritSession: 'pool',
        targetUrl: 'https://example.com/page',
      });

      expect(result.inheritResult).toBeDefined();
      expect(result.inheritResult.inherited).toBe(true);
      expect(result.inheritResult.source).toBe('pool');
    });

    it('should inherit from tab when matching tab found', async () => {
      browsingAPI.setTabDiscoveryFn(async () => [
        { partition: 'persist:tab-abc', url: 'https://example.com/dash', title: 'Dash' },
      ]);
      mockSessionObj.cookies.get.mockResolvedValueOnce([
        { name: 't', value: 'v', domain: '.example.com', path: '/', secure: false, httpOnly: false },
      ]);

      const result = await browsingAPI.createSession({
        inheritSession: 'tab',
        targetUrl: 'https://example.com',
      });

      expect(result.inheritResult).toBeDefined();
      expect(result.inheritResult.inherited).toBe(true);
      expect(result.inheritResult.source).toBe('tab');
    });

    it('should try auto mode: pool -> tab -> chrome', async () => {
      browsingAPI.setTabDiscoveryFn(async () => []);
      mockSessionObj.cookies.get.mockResolvedValue([]);

      const result = await browsingAPI.createSession({
        inheritSession: 'auto',
        targetUrl: 'https://unknown.com',
      });

      expect(result.inheritResult).toBeDefined();
      expect(result.inheritResult.inherited).toBe(false);
      expect(result.inheritResult.reason).toBe('no-auth-source');
    });

    it('should skip inheritance when no targetUrl provided', async () => {
      const result = await browsingAPI.createSession({
        inheritSession: 'auto',
      });
      expect(result.inheritResult).toBeUndefined();
    });

    it('should inherit from explicit partition string', async () => {
      mockSessionObj.cookies.get.mockResolvedValueOnce([
        { name: 'x', value: 'y', domain: '.ex.com', path: '/', secure: false, httpOnly: false },
      ]);

      const result = await browsingAPI.createSession({
        inheritSession: 'persist:my-custom-partition',
        targetUrl: 'https://ex.com',
      });

      expect(result.inheritResult.inherited).toBe(true);
      expect(result.inheritResult.source).toBe('partition');
    });
  });
});
