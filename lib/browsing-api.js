'use strict';

const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

let _electron, _stealth, _errorDetector, _safety;
function getElectron() { if (!_electron) _electron = require('electron'); return _electron; }
function getStealth() { if (!_stealth) _stealth = require('./browser-stealth'); return _stealth; }
function getErrorDetector() { if (!_errorDetector) _errorDetector = require('./browse-error-detector'); return _errorDetector; }
function getSafety() { if (!_safety) _safety = require('./browse-safety'); return _safety; }

const DEVICE_PRESETS = {
  desktop: { width: 1280, height: 900, scaleFactor: 1, mobile: false, ua: null },
  mobile: { width: 390, height: 844, scaleFactor: 3, mobile: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  'iphone-15': { width: 393, height: 852, scaleFactor: 3, mobile: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  'iphone-se': { width: 375, height: 667, scaleFactor: 2, mobile: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  'ipad': { width: 820, height: 1180, scaleFactor: 2, mobile: true, ua: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  'android': { width: 412, height: 915, scaleFactor: 2.625, mobile: true, ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' },
  'android-tablet': { width: 800, height: 1280, scaleFactor: 2, mobile: true, ua: 'Mozilla/5.0 (Linux; Android 14; SM-X810) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
};

class BrowsingSession extends EventEmitter {
  constructor(id, opts = {}) {
    super();
    this.id = id;
    this.mode = opts.mode || 'auto-promote';
    this.persistent = opts.persistent || false;
    this.partition = opts.partition || `browse-${id}`;
    this.timeout = opts.timeout || 120000;
    this.maxActions = opts.maxActions || 50;
    this.userAgent = opts.userAgent || getStealth().getUserAgent();
    this.window = null;
    this.overlayView = null;
    this.createdAt = Date.now();
    this.actionCount = 0;
    this.status = 'created'; // created | navigating | ready | hitl | error | destroyed
    this.lastUrl = '';
    this.lastTitle = '';
    this.history = [];
    this.checkpoints = [];
    this.error = null;
    this._hitlResolve = null;
    this._hitlTimeout = null;
    this._sessionTimeout = null;
    this._cleanupStealth = null;
    this._consoleLogs = [];
    this._networkLog = [];
    this._consoleLogMax = 50;
    this._networkLogMax = 50;
    this.viewport = null;
  }

  toJSON() {
    return {
      sessionId: this.id,
      mode: this.mode,
      status: this.status,
      url: this.lastUrl,
      title: this.lastTitle,
      actionCount: this.actionCount,
      maxActions: this.maxActions,
      createdAt: this.createdAt,
      elapsedMs: Date.now() - this.createdAt,
      historyLength: this.history.length,
      checkpoints: this.checkpoints.length,
      viewport: this.viewport,
    };
  }
}

class BrowsingAPI extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this._maxConcurrent = 5;
    this._authPoolDomains = new Set();
    this._tabDiscoveryFn = null;
    this._autoAuthAttempted = new Set();
  }

  async createSession(opts = {}) {
    const sessionCheck = getSafety().validateSessionCreation(this.sessions.size);
    if (!sessionCheck.allowed) {
      throw new Error(sessionCheck.reason);
    }
    if (this.sessions.size >= this._maxConcurrent) {
      throw new Error(`Max concurrent sessions (${this._maxConcurrent}) reached`);
    }

    const backendType = opts.backend || 'electron';

    if (backendType === 'chrome' || backendType === 'playwright') {
      return this._createPlaywrightSession(opts);
    }

    const id = opts.sessionId || crypto.randomUUID();
    const sess = new BrowsingSession(id, opts);
    const partitionKey = sess.persistent ? `persist:${sess.partition}` : sess.partition;

    const viewportSpec = this._resolveViewport(opts.viewport);

    getStealth().applyToSession(partitionKey);

    const { BrowserWindow } = getElectron();
    const win = new BrowserWindow({
      show: sess.mode === 'hitl',
      width: viewportSpec.width,
      height: viewportSpec.height,
      title: `Browsing Session ${id.slice(0, 8)}`,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: path.join(getElectron().app.getAppPath(), 'preload-browsing-api.js'),
        partition: partitionKey,
        webviewTag: false,
        webSecurity: true,
      },
    });

    sess.window = win;
    sess.backendType = 'electron';
    sess._cleanupStealth = getStealth().apply(win.webContents);

    if (viewportSpec.mobile) {
      this._applyDeviceEmulation(sess, viewportSpec);
    } else {
      win.webContents.setUserAgent(sess.userAgent);
      sess.viewport = { preset: 'desktop', width: viewportSpec.width, height: viewportSpec.height, mobile: false };
    }

    win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      sess._consoleLogs.push({
        level,
        message: (message || '').slice(0, 500),
        line,
        source: (sourceId || '').slice(-60),
        timestamp: Date.now(),
      });
      if (sess._consoleLogs.length > sess._consoleLogMax) sess._consoleLogs.shift();
    });

    win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
      sess._consoleLogs.push({
        level: 3,
        message: `LOAD FAILED: ${errorDescription} (${errorCode}) ${validatedURL}`,
        timestamp: Date.now(),
      });
    });

    try {
      const sessionObj = getElectron().session.fromPartition(partitionKey);
      sessionObj.webRequest.onCompleted((details) => {
        if (details.statusCode >= 400) {
          sess._networkLog.push({
            url: (details.url || '').slice(0, 200),
            status: details.statusCode,
            method: details.method || 'GET',
            timestamp: Date.now(),
          });
          if (sess._networkLog.length > sess._networkLogMax) sess._networkLog.shift();
        }
      });
      sessionObj.webRequest.onErrorOccurred((details) => {
        sess._networkLog.push({
          url: (details.url || '').slice(0, 200),
          error: details.error,
          method: details.method || 'GET',
          timestamp: Date.now(),
        });
        if (sess._networkLog.length > sess._networkLogMax) sess._networkLog.shift();
      });
    } catch (_) {
      // Network logging is optional -- session API may not be available in all contexts
    }

    win.on('closed', () => {
      this._cleanupSession(id);
    });

    sess._sessionTimeout = setTimeout(() => {
      this._timeoutSession(id);
    }, sess.timeout);

    this.sessions.set(id, sess);

    let inheritResult = null;
    if (opts.inheritSession && opts.targetUrl) {
      try {
        inheritResult = await this._inheritForSession(id, opts.inheritSession, opts.targetUrl);
      } catch (_) {
        inheritResult = { inherited: false, reason: 'inherit-error' };
      }
    }

    this.emit('session:created', sess.toJSON());

    const result = sess.toJSON();
    if (inheritResult) result.inheritResult = inheritResult;
    return result;
  }

  async _createPlaywrightSession(opts = {}) {
    const { PlaywrightBackend } = require('./browser-backend');
    const id = opts.sessionId || crypto.randomUUID();
    const sess = new BrowsingSession(id, opts);
    sess.backendType = 'playwright';

    const viewportSpec = this._resolveViewport(opts.viewport);
    const backend = new PlaywrightBackend();

    try {
      await backend.launch({
        show: sess.mode === 'hitl',
        width: viewportSpec.width,
        height: viewportSpec.height,
        userAgent: viewportSpec.ua || sess.userAgent,
        deviceScaleFactor: viewportSpec.scaleFactor || 1,
      });
    } catch (err) {
      throw new Error(`Playwright launch failed: ${err.message}. Run: npx playwright install chromium`);
    }

    sess.window = null;
    sess._backend = backend;
    sess.viewport = {
      preset: typeof opts.viewport === 'string' ? opts.viewport : 'desktop',
      width: viewportSpec.width,
      height: viewportSpec.height,
      mobile: viewportSpec.mobile || false,
    };

    sess._sessionTimeout = setTimeout(() => {
      this._timeoutSession(id);
    }, sess.timeout);

    this.sessions.set(id, sess);
    this.emit('session:created', sess.toJSON());
    return sess.toJSON();
  }

  _getBackend(sess) {
    if (sess._backend) return sess._backend;
    return null;
  }

  async navigate(sessionId, url, opts = {}) {
    const sess = this._getSession(sessionId);
    const waitUntil = opts.waitUntil || 'domcontentloaded';
    const timeout = opts.timeout || 30000;
    const spaSettle = opts.spaSettle !== undefined ? opts.spaSettle : 1500;

    const domainCheck = getSafety().isDomainBlocked(url);
    if (domainCheck.blocked) {
      return { url, status: 'blocked', error: domainCheck.reason, blocked: true };
    }

    if (sess.backendType === 'playwright' && sess._backend) {
      return this._navigatePlaywright(sess, sessionId, url, { waitUntil, timeout, spaSettle });
    }

    sess.status = 'navigating';
    sess.emit('navigating', url);

    try {
      let loadError = null;
      await Promise.race([
        sess.window.loadURL(url),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Navigation timeout')), timeout)),
      ]).catch((err) => {
        if (err.message === 'Navigation timeout') throw err;
        loadError = err;
      });

      const currentUrl = sess.window.webContents.getURL();
      const wasRedirected = loadError && currentUrl && currentUrl !== '' && currentUrl !== url;

      if (loadError && !wasRedirected) {
        await this._waitForLoad(sess, 'domcontentloaded', 5000);
        const retryUrl = sess.window.webContents.getURL();
        if (!retryUrl || retryUrl === '' || retryUrl === 'about:blank') {
          throw loadError;
        }
      }

      await this._waitForLoad(sess, waitUntil, Math.min(timeout, 10000));

      if (spaSettle > 0) {
        await this._wait(spaSettle);
      }

      sess.lastUrl = sess.window.webContents.getURL();
      sess.lastTitle = sess.window.webContents.getTitle();
      sess.status = 'ready';
      sess.redirected = wasRedirected || sess.lastUrl !== url;

      sess.history.push({
        action: 'navigate',
        url: sess.lastUrl,
        title: sess.lastTitle,
        timestamp: Date.now(),
      });

      let detection = await getErrorDetector().detect(sess.window.webContents);

      if (detection.type === 'consent') {
        await getErrorDetector().dismissConsent(sess.window.webContents);
        await this._wait(1000);
      }

      if (detection.blocked && !opts._skipAutoAuth) {
        const resolved = await this._tryAutoAuth(sessionId, sess, url, detection);
        if (resolved) {
          detection = resolved.detection;
        }
      }

      if (detection.blocked && sess.mode !== 'auto') {
        if (sess.mode === 'auto-promote' || sess.mode === 'hitl') {
          await this.promote(sessionId, {
            reason: detection.type,
            message: detection.message,
          });
        }
      }

      return {
        url: sess.lastUrl,
        title: sess.lastTitle,
        status: 'loaded',
        blocked: detection.blocked,
        redirected: sess.redirected || false,
        detection: detection.type !== 'clear' ? detection : undefined,
      };
    } catch (err) {
      sess.status = 'error';
      sess.error = err.message;
      return { url, status: 'error', error: err.message, blocked: false };
    }
  }

  async extract(sessionId, opts = {}) {
    const sess = this._getSession(sessionId);
    const mode = opts.mode || 'readability';
    const maxLength = opts.maxLength || 8000;

    if (sess.backendType === 'playwright' && sess._backend) {
      const script = this._buildExtractionScript(mode, maxLength, opts);
      try {
        const result = await sess._backend.evaluate(script);
        sess.history.push({ action: 'extract', mode, resultLength: result.text ? result.text.length : 0, timestamp: Date.now() });
        return result;
      } catch (err) {
        return { text: '', metadata: {}, error: err.message };
      }
    }

    const script = this._buildExtractionScript(mode, maxLength, opts);

    try {
      const result = await sess.window.webContents.executeJavaScript(script);
      sess.history.push({
        action: 'extract',
        mode,
        resultLength: result.text ? result.text.length : 0,
        timestamp: Date.now(),
      });
      return result;
    } catch (err) {
      return { text: '', metadata: {}, error: err.message };
    }
  }

  async snapshot(sessionId, opts = {}) {
    const sess = this._getSession(sessionId);
    const interactiveOnly = opts.interactiveOnly !== false;

    const script = this._buildSnapshotScript(interactiveOnly);

    if (sess.backendType === 'playwright' && sess._backend) {
      try {
        const result = await sess._backend.evaluate(script);
        return {
          refs: result.refs,
          url: sess._backend.page?.url() || sess.lastUrl,
          title: await sess._backend.page?.title() || sess.lastTitle,
          totalElements: result.totalElements,
        };
      } catch (err) {
        return { refs: [], url: sess.lastUrl, title: sess.lastTitle, error: err.message };
      }
    }

    try {
      const result = await sess.window.webContents.executeJavaScript(script);
      return {
        refs: result.refs,
        url: sess.window.webContents.getURL(),
        title: sess.window.webContents.getTitle(),
        totalElements: result.totalElements,
      };
    } catch (err) {
      return { refs: [], url: sess.lastUrl, title: sess.lastTitle, error: err.message };
    }
  }

  async act(sessionId, action) {
    const sess = this._getSession(sessionId);
    const strategy = action.strategy || 'default';

    if (sess.backendType === 'playwright' && sess._backend) {
      return this._actPlaywright(sess, action, strategy);
    }

    const safetyCheck = getSafety().checkActionSafety(action, {
      actionCount: sess.actionCount,
      navigationCount: sess.history.filter((h) => h.action === 'navigate').length,
      startTime: sess.createdAt,
    });
    if (!safetyCheck.safe) {
      const reasons = safetyCheck.issues.map((i) => i.reason).join('; ');
      return { success: false, error: `Safety block: ${reasons}`, actionCount: sess.actionCount };
    }
    if (safetyCheck.requiresConfirmation && sess.mode !== 'hitl') {
      await this.promote(sessionId, {
        reason: 'sensitive-field',
        message: safetyCheck.issues.find((i) => i.requiresConfirmation)?.reason || 'Sensitive field detected',
      });
    }

    if (sess.actionCount >= sess.maxActions) {
      return { success: false, error: 'Max actions reached', actionCount: sess.actionCount };
    }

    sess.actionCount++;

    try {
      let result;
      switch (strategy) {
        case 'fast':
          result = await sess.window.webContents.executeJavaScript(this._buildFastActionScript(action));
          break;
        case 'stealth':
          result = await this._executeStealth(sess, action);
          break;
        case 'auto':
          result = await this._executeWithFallback(sess, action);
          break;
        default:
          result = await sess.window.webContents.executeJavaScript(this._buildActionScript(action));
          break;
      }

      await this._wait(strategy === 'fast' ? 100 : 300);

      const newUrl = sess.window.webContents.getURL();
      const urlChanged = newUrl !== sess.lastUrl;
      sess.lastUrl = newUrl;
      sess.lastTitle = sess.window.webContents.getTitle();

      sess.history.push({
        action: action.action,
        ref: action.ref,
        value: action.value,
        strategy,
        success: result.success,
        urlChanged,
        fallback: result.fallback || null,
        trusted: result.trusted || false,
        timestamp: Date.now(),
      });

      if (urlChanged) {
        const detection = await getErrorDetector().detect(sess.window.webContents);
        if (detection.type === 'consent') {
          await getErrorDetector().dismissConsent(sess.window.webContents);
        }
        if (detection.blocked && (sess.mode === 'auto-promote' || sess.mode === 'hitl')) {
          await this.promote(sessionId, { reason: detection.type, message: detection.message });
        }
      }

      return {
        success: result.success,
        strategy,
        actionCount: sess.actionCount,
        url: sess.lastUrl,
        urlChanged,
        fallback: result.fallback || null,
        trusted: result.trusted || false,
        error: result.error,
      };
    } catch (err) {
      sess.history.push({
        action: action.action, ref: action.ref, strategy, success: false,
        error: err.message, timestamp: Date.now(),
      });
      return { success: false, strategy, error: err.message, actionCount: sess.actionCount };
    }
  }

  async screenshot(sessionId, opts = {}) {
    const sess = this._getSession(sessionId);
    const fullPage = opts.fullPage || false;

    if (sess.backendType === 'playwright' && sess._backend) {
      try {
        return await sess._backend.screenshot({ format: opts.format, quality: opts.quality, fullPage });
      } catch (err) {
        return { error: err.message };
      }
    }

    try {
      const image = await sess.window.webContents.capturePage();
      const buffer = opts.format === 'jpeg'
        ? image.toJPEG(opts.quality || 80)
        : image.toPNG();

      return {
        base64: buffer.toString('base64'),
        width: image.getSize().width,
        height: image.getSize().height,
        format: opts.format || 'png',
      };
    } catch (err) {
      return { error: err.message };
    }
  }

  async promote(sessionId, opts = {}) {
    const sess = this._getSession(sessionId);

    if (sess.status === 'hitl') return sess.toJSON();

    sess.status = 'hitl';
    sess.window.show();
    sess.window.focus();

    this.emit('session:hitl', {
      sessionId,
      reason: opts.reason || 'manual',
      message: opts.message || 'User input required',
    });

    if (opts.overlayMessage) {
      this._showOverlay(sess, opts.overlayMessage);
    }

    return sess.toJSON();
  }

  async waitForUser(sessionId, opts = {}) {
    const sess = this._getSession(sessionId);
    const timeout = opts.timeout || 120000;
    const waitFor = opts.waitFor || 'navigation';

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        sess.window.webContents.removeAllListeners('did-navigate');
        if (sess._hitlResolve) sess._hitlResolve = null;
      };

      const timer = setTimeout(() => {
        cleanup();
        resolve({ resumed: false, reason: 'timeout' });
      }, timeout);

      if (waitFor === 'navigation') {
        sess.window.webContents.once('did-navigate', () => {
          cleanup();
          sess.lastUrl = sess.window.webContents.getURL();
          sess.lastTitle = sess.window.webContents.getTitle();
          sess.status = 'ready';
          resolve({ resumed: true, reason: 'navigation', url: sess.lastUrl });
        });
      } else if (waitFor === 'manual-resume') {
        sess._hitlResolve = (data) => {
          cleanup();
          sess.status = 'ready';
          resolve({ resumed: true, reason: 'manual', ...data });
        };
      }
    });
  }

  resumeHitl(sessionId, data = {}) {
    const sess = this._getSession(sessionId);
    if (sess._hitlResolve) {
      sess._hitlResolve(data);
    }
  }

  async destroySession(sessionId) {
    const sess = this.sessions.get(sessionId);
    if (!sess) return { destroyed: false, error: 'Session not found' };
    this._cleanupSession(sessionId);
    return { destroyed: true, sessionId };
  }

  listSessions() {
    return Array.from(this.sessions.values()).map((s) => s.toJSON());
  }

  getSession(sessionId) {
    const sess = this.sessions.get(sessionId);
    return sess ? sess.toJSON() : null;
  }

  getConsoleLogs(sessionId, opts = {}) {
    const sess = this._getSession(sessionId);
    const since = opts.since || 0;
    const clear = opts.clear !== false;

    const logs = since
      ? sess._consoleLogs.filter((l) => l.timestamp > since)
      : [...sess._consoleLogs];

    if (clear) sess._consoleLogs = [];
    return logs;
  }

  getNetworkLog(sessionId, opts = {}) {
    const sess = this._getSession(sessionId);
    const since = opts.since || 0;
    const clear = opts.clear !== false;

    const logs = since
      ? sess._networkLog.filter((l) => l.timestamp > since)
      : [...sess._networkLog];

    if (clear) sess._networkLog = [];
    return logs;
  }

  async setViewport(sessionId, viewport) {
    const sess = this._getSession(sessionId);
    const spec = this._resolveViewport(viewport);

    if (spec.mobile) {
      this._applyDeviceEmulation(sess, spec);
    } else {
      try { sess.window.webContents.disableDeviceEmulation(); } catch (_) {}
      sess.window.setSize(spec.width, spec.height);
      sess.window.webContents.setUserAgent(sess.userAgent);
      sess.viewport = { preset: 'desktop', width: spec.width, height: spec.height, mobile: false };
    }

    return sess.viewport;
  }

  getDevicePresets() {
    return Object.entries(DEVICE_PRESETS).map(([name, p]) => ({
      name,
      width: p.width,
      height: p.height,
      mobile: p.mobile,
      scaleFactor: p.scaleFactor,
    }));
  }

  // --- Cookie & Auth Management ---

  async getCookies(sessionId, opts = {}) {
    const sess = this._getSession(sessionId);
    const partitionKey = sess.persistent ? `persist:${sess.partition}` : sess.partition;
    try {
      const sessionObj = getElectron().session.fromPartition(partitionKey);
      const filter = {};
      if (opts.url) filter.url = opts.url;
      if (opts.domain) filter.domain = opts.domain;
      const cookies = await sessionObj.cookies.get(filter);
      const includeValues = opts.includeValues === true;
      return cookies.map((c) => ({
        name: c.name,
        value: c.httpOnly && !includeValues ? '[httpOnly]' : c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite || 'unspecified',
        expirationDate: c.expirationDate,
      }));
    } catch (err) {
      return { error: err.message };
    }
  }

  async setCookies(sessionId, cookies) {
    const sess = this._getSession(sessionId);
    const partitionKey = sess.persistent ? `persist:${sess.partition}` : sess.partition;
    try {
      const sessionObj = getElectron().session.fromPartition(partitionKey);
      const results = [];
      for (const c of cookies) {
        try {
          const cookieOpts = {
            url: c.url || `http${c.secure ? 's' : ''}://${c.domain}${c.path || '/'}`,
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path || '/',
            secure: c.secure || false,
            httpOnly: c.httpOnly || false,
            expirationDate: c.expirationDate,
          };
          if (c.sameSite && c.sameSite !== 'unspecified') {
            cookieOpts.sameSite = c.sameSite;
          }
          await sessionObj.cookies.set(cookieOpts);
          results.push({ name: c.name, success: true });
        } catch (err) {
          results.push({ name: c.name, success: false, error: err.message });
        }
      }
      await sessionObj.cookies.flushStore();
      return results;
    } catch (err) {
      return { error: err.message };
    }
  }

  async exportCookies(sessionId, opts = {}) {
    const cookies = await this.getCookies(sessionId, opts);
    if (cookies.error) return cookies;
    return {
      cookies,
      sessionId,
      exportedAt: Date.now(),
      domain: opts.domain || opts.url || 'all',
    };
  }

  async importCookies(sessionId, cookieExport) {
    if (!cookieExport?.cookies?.length) return { imported: 0, error: 'No cookies to import' };
    const results = await this.setCookies(sessionId, cookieExport.cookies);
    const succeeded = Array.isArray(results) ? results.filter((r) => r.success).length : 0;
    return { imported: succeeded, total: cookieExport.cookies.length, results };
  }

  async inheritFromPartition(sessionId, sourcePartition, opts = {}) {
    const sess = this._getSession(sessionId);
    const targetPartition = sess.persistent ? `persist:${sess.partition}` : sess.partition;
    const domain = opts.domain || null;

    try {
      const sourceSes = getElectron().session.fromPartition(sourcePartition);
      const filter = domain ? { domain } : {};
      const cookies = await sourceSes.cookies.get(filter);
      if (!cookies.length) return { inherited: 0, source: sourcePartition };

      const targetSes = getElectron().session.fromPartition(targetPartition);
      let copied = 0;

      for (const c of cookies) {
        try {
          const cookieOpts = {
            url: `http${c.secure ? 's' : ''}://${c.domain.replace(/^\./, '')}${c.path || '/'}`,
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            secure: c.secure,
            httpOnly: c.httpOnly,
            expirationDate: c.expirationDate,
          };
          if (c.sameSite && c.sameSite !== 'unspecified') {
            cookieOpts.sameSite = c.sameSite;
          }
          await targetSes.cookies.set(cookieOpts);
          copied++;
        } catch (_) { /* some cookies may not transfer */ }
      }
      await targetSes.cookies.flushStore();
      return { inherited: copied, total: cookies.length, source: sourcePartition };
    } catch (err) {
      return { inherited: 0, error: err.message, source: sourcePartition };
    }
  }

  async cloneSession(sourceSessionId, opts = {}) {
    const sourceSess = this._getSession(sourceSessionId);
    const sourcePartition = sourceSess.persistent ? `persist:${sourceSess.partition}` : sourceSess.partition;

    const newOpts = {
      ...opts,
      persistent: opts.persistent !== undefined ? opts.persistent : sourceSess.persistent,
      partition: opts.partition || `clone-${sourceSess.partition}-${Date.now()}`,
      mode: opts.mode || sourceSess.mode,
      viewport: opts.viewport || (sourceSess.viewport?.preset !== 'desktop' ? sourceSess.viewport?.preset : undefined),
    };

    const newSess = await this.createSession(newOpts);

    const inheritResult = await this.inheritFromPartition(newSess.sessionId, sourcePartition);
    if (inheritResult.error) {
      return { ...newSess, cookieCloneError: inheritResult.error };
    }

    return { ...newSess, clonedFrom: sourceSessionId, cookiesCloned: true, cookiesCopied: inheritResult.inherited };
  }

  async checkAuthState(sessionId, opts = {}) {
    const sess = this._getSession(sessionId);
    const url = sess.window.webContents.getURL();

    let detection = await getErrorDetector().detect(sess.window.webContents);

    if (detection.type === 'clear' && opts.spaSettle !== 0) {
      await this._wait(opts.spaSettle || 800);
      detection = await getErrorDetector().detect(sess.window.webContents);
    }

    let domain = '';
    try { domain = new URL(url).hostname; } catch (_) {}

    const partitionKey = sess.persistent ? `persist:${sess.partition}` : sess.partition;
    let cookieCount = 0;
    let hasSessionCookies = false;
    try {
      const sessionObj = getElectron().session.fromPartition(partitionKey);
      const cookies = await sessionObj.cookies.get({ domain });
      cookieCount = cookies.length;
      hasSessionCookies = cookies.some((c) =>
        !c.expirationDate || c.name.toLowerCase().includes('session') || c.name.toLowerCase().includes('token') || c.name.toLowerCase().includes('auth')
      );
    } catch (_) {}

    return {
      url,
      domain,
      authWall: detection.type === 'auth-wall',
      captcha: detection.type === 'captcha',
      mfa: detection.type === 'mfa',
      oauth: detection.type === 'oauth',
      blocked: detection.blocked,
      detectionType: detection.type,
      loggedIn: !detection.blocked && hasSessionCookies,
      cookieCount,
      hasSessionCookies,
      persistent: sess.persistent,
      partition: sess.partition,
    };
  }

  async lookupCredentials(url) {
    try {
      const credMgr = require('./credential-manager');
      const creds = await credMgr.getCredentialsForDomain(url);
      return creds.map((c) => ({
        username: c.username,
        domain: c.domain,
        hasPassword: !!c.password,
      }));
    } catch (_) {
      return [];
    }
  }

  async autoFillCredentials(sessionId, url) {
    const sess = this._getSession(sessionId);
    const targetUrl = url || sess.lastUrl;

    const hasPasswordField = await sess.window.webContents.executeJavaScript(`
      !!document.querySelector('input[type="password"]')
    `);

    if (!hasPasswordField) {
      return { filled: false, reason: 'no-password-field' };
    }

    if (sess.mode !== 'hitl') {
      await this.promote(sessionId, {
        reason: 'credential-fill',
        message: `Auto-fill credentials for ${targetUrl}? Saved login found.`,
      });
    }

    let creds;
    try {
      const credMgr = require('./credential-manager');
      creds = await credMgr.getCredentialsForDomain(targetUrl);
    } catch (_) {
      return { filled: false, reason: 'credential-manager-unavailable' };
    }

    if (!creds || creds.length === 0) {
      return { filled: false, reason: 'no-credentials-found' };
    }

    const cred = creds[0];

    const fillResult = await sess.window.webContents.executeJavaScript(`
      (() => {
        const userFields = document.querySelectorAll(
          'input[type="text"], input[type="email"], input[name*="user"], input[name*="email"], ' +
          'input[name*="login"], input[autocomplete="username"], input[autocomplete="email"]'
        );
        const passFields = document.querySelectorAll('input[type="password"]');
        let filled = { username: false, password: false };

        for (const f of userFields) {
          if (f.offsetParent !== null) {
            f.value = ${JSON.stringify(cred.username)};
            f.dispatchEvent(new Event('input', { bubbles: true }));
            f.dispatchEvent(new Event('change', { bubbles: true }));
            filled.username = true;
            break;
          }
        }
        for (const f of passFields) {
          if (f.offsetParent !== null) {
            f.value = ${JSON.stringify(cred.password)};
            f.dispatchEvent(new Event('input', { bubbles: true }));
            f.dispatchEvent(new Event('change', { bubbles: true }));
            filled.password = true;
            break;
          }
        }
        return filled;
      })()
    `);

    return {
      filled: fillResult.username || fillResult.password,
      username: fillResult.username,
      password: fillResult.password,
      credentialUsed: cred.username,
    };
  }

  setTabDiscoveryFn(fn) {
    this._tabDiscoveryFn = fn;
  }

  async _findTabForDomain(domain) {
    if (!this._tabDiscoveryFn) return null;
    try {
      const tabs = await this._tabDiscoveryFn();
      if (!Array.isArray(tabs)) return null;

      for (const tab of tabs) {
        try {
          const tabHost = new URL(tab.url).hostname;
          if (tabHost === domain || tabHost.endsWith(`.${domain}`)) {
            return tab;
          }
        } catch (_) {}
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  _authPoolPartition(domain) {
    const normalized = domain.replace(/^www\./, '').toLowerCase();
    return `persist:auth-pool-${normalized}`;
  }

  async saveToAuthPool(sessionId) {
    const sess = this._getSession(sessionId);
    const url = sess.window.webContents.getURL();
    let domain = '';
    try { domain = new URL(url).hostname; } catch (_) { return { saved: false, reason: 'no-domain' }; }

    const poolPartition = this._authPoolPartition(domain);
    const sourcePartition = sess.persistent ? `persist:${sess.partition}` : sess.partition;

    try {
      const sourceSes = getElectron().session.fromPartition(sourcePartition);
      const cookies = await sourceSes.cookies.get({ domain });
      if (!cookies.length) return { saved: false, reason: 'no-cookies' };

      const targetSes = getElectron().session.fromPartition(poolPartition);
      let copied = 0;
      for (const c of cookies) {
        try {
          const cookieOpts = {
            url: `http${c.secure ? 's' : ''}://${c.domain.replace(/^\./, '')}${c.path || '/'}`,
            name: c.name, value: c.value, domain: c.domain, path: c.path,
            secure: c.secure, httpOnly: c.httpOnly, expirationDate: c.expirationDate,
          };
          if (c.sameSite && c.sameSite !== 'unspecified') cookieOpts.sameSite = c.sameSite;
          await targetSes.cookies.set(cookieOpts);
          copied++;
        } catch (_) {}
      }
      await targetSes.cookies.flushStore();

      if (!this._authPoolDomains) this._authPoolDomains = new Set();
      this._authPoolDomains.add(domain);

      return { saved: true, domain, partition: poolPartition, cookies: copied };
    } catch (err) {
      return { saved: false, error: err.message };
    }
  }

  async getAuthPoolDomains() {
    return [...this._authPoolDomains];
  }

  async _inheritForSession(sessionId, mode, targetUrl) {
    let domain = '';
    try { domain = new URL(targetUrl).hostname; } catch (_) { return { inherited: false, reason: 'invalid-url' }; }

    const tryPool = async () => {
      const poolPartition = this._authPoolPartition(domain);
      try {
        const poolSes = getElectron().session.fromPartition(poolPartition);
        const poolCookies = await poolSes.cookies.get({});
        if (poolCookies.length > 0) {
          const result = await this.inheritFromPartition(sessionId, poolPartition, { domain });
          if (result.inherited > 0) return { source: 'pool', cookiesCopied: result.inherited, inherited: true };
        }
      } catch (_) {}
      return null;
    };

    const tryTab = async () => {
      const tab = await this._findTabForDomain(domain);
      if (tab && tab.partition) {
        const result = await this.inheritFromPartition(sessionId, tab.partition, { domain });
        if (result.inherited > 0) return { source: 'tab', tabUrl: tab.url, cookiesCopied: result.inherited, inherited: true };
      }
      return null;
    };

    const tryChrome = async () => {
      try {
        const chromeImport = require('./chrome-cookie-import');
        if (!chromeImport.isChromeAvailable()) return null;
        const sess = this._getSession(sessionId);
        const targetPartition = sess.persistent ? `persist:${sess.partition}` : sess.partition;
        const result = await chromeImport.importChromeCookies(domain, targetPartition);
        if (result.imported > 0) return { source: 'chrome', cookiesCopied: result.imported, inherited: true };
      } catch (_) {}
      return null;
    };

    if (mode === 'pool') return (await tryPool()) || { inherited: false, reason: 'no-pool-auth' };
    if (mode === 'tab') return (await tryTab()) || { inherited: false, reason: 'no-matching-tab' };
    if (mode === 'chrome') return (await tryChrome()) || { inherited: false, reason: 'chrome-unavailable' };

    if (mode === 'auto') {
      const poolResult = await tryPool();
      if (poolResult) return poolResult;
      const tabResult = await tryTab();
      if (tabResult) return tabResult;
      const chromeResult = await tryChrome();
      if (chromeResult) return chromeResult;
      return { inherited: false, reason: 'no-auth-source' };
    }

    // Direct partition name
    if (typeof mode === 'string') {
      const result = await this.inheritFromPartition(sessionId, mode, { domain });
      if (result.inherited > 0) return { source: 'partition', cookiesCopied: result.inherited, inherited: true };
      return { inherited: false, reason: 'empty-partition' };
    }

    return { inherited: false, reason: 'unknown-mode' };
  }

  async getDomContext(sessionId, ref, opts = {}) {
    const sess = this._getSession(sessionId);
    const depth = opts.depth || 3;
    const maxLength = opts.maxLength || 2000;

    const script = this._buildDomContextScript(ref, depth, maxLength);
    try {
      return await sess.window.webContents.executeJavaScript(script);
    } catch (err) {
      return { html: '', error: err.message };
    }
  }

  async parallel(tasks, opts = {}) {
    const maxConcurrent = Math.min(opts.maxConcurrent || 5, this._maxConcurrent);
    const timeout = opts.timeout || 30000;

    const results = [];
    const chunks = [];
    for (let i = 0; i < tasks.length; i += maxConcurrent) {
      chunks.push(tasks.slice(i, i + maxConcurrent));
    }

    for (const chunk of chunks) {
      const chunkResults = await Promise.allSettled(
        chunk.map(async (task) => {
          const sess = await this.createSession({ mode: task.mode || 'auto-promote', timeout });
          try {
            const nav = await this.navigate(sess.sessionId, task.url, { timeout });
            if (nav.status === 'error') return { url: task.url, error: nav.error };

            const content = await this.extract(sess.sessionId, task.extract || {});
            return { url: task.url, ...content };
          } finally {
            await this.destroySession(sess.sessionId);
          }
        })
      );
      results.push(...chunkResults.map((r) => (r.status === 'fulfilled' ? r.value : { error: r.reason?.message })));
    }

    return results;
  }

  async _tryAutoAuth(sessionId, sess, originalUrl, detection) {
    let domain = '';
    try { domain = new URL(sess.window.webContents.getURL()).hostname; } catch (_) { return null; }

    if (!this._autoAuthAttempted) this._autoAuthAttempted = new Set();
    const attemptKey = `${sessionId}:${domain}`;
    if (this._autoAuthAttempted.has(attemptKey)) return null;
    this._autoAuthAttempted.add(attemptKey);

    const sources = [];

    // 1. Try the shared auth pool first (fastest, no disk I/O)
    const poolPartition = this._authPoolPartition(domain);
    try {
      const poolSes = getElectron().session.fromPartition(poolPartition);
      const poolCookies = await poolSes.cookies.get({});
      if (poolCookies.length > 0) sources.push({ type: 'pool', partition: poolPartition });
    } catch (_) {}

    // 2. Try matching app tab
    const tab = await this._findTabForDomain(domain);
    if (tab && tab.partition) sources.push({ type: 'tab', partition: tab.partition });

    // 3. Try Chrome profile (only if key is accessible and domain hasn't failed before)
    try {
      const chromeImport = require('./chrome-cookie-import');
      if (chromeImport.isChromeAvailable() && !chromeImport.isDomainFailed(domain)) {
        sources.push({ type: 'chrome' });
      }
    } catch (_) {}

    if (sources.length === 0) return null;

    for (const source of sources) {
      try {
        if (source.type === 'chrome') {
          const chromeImport = require('./chrome-cookie-import');
          const targetPartition = sess.persistent ? `persist:${sess.partition}` : sess.partition;
          const importResult = await chromeImport.importChromeCookies(domain, targetPartition);
          if (!importResult.imported) continue;
        } else {
          const inheritResult = await this.inheritFromPartition(sessionId, source.partition, { domain });
          if (!inheritResult.inherited) continue;
        }

        const reloadUrl = sess.window.webContents.getURL() || originalUrl;
        await sess.window.loadURL(reloadUrl);
        await this._waitForLoad(sess, 'domcontentloaded', 10000);
        await this._wait(1500);

        const newDetection = await getErrorDetector().detect(sess.window.webContents);

        sess.lastUrl = sess.window.webContents.getURL();
        sess.lastTitle = sess.window.webContents.getTitle();

        if (!newDetection.blocked) {
          try { await this.saveToAuthPool(sessionId); } catch (_) {}
          return { detection: newDetection, source: source.type };
        }
      } catch (_) {}
    }

    return null;
  }

  // --- Private helpers ---

  _resolveViewport(viewport) {
    if (!viewport) return DEVICE_PRESETS.desktop;
    if (typeof viewport === 'string') {
      const preset = DEVICE_PRESETS[viewport];
      if (!preset) throw new Error(`Unknown viewport preset: ${viewport}. Available: ${Object.keys(DEVICE_PRESETS).join(', ')}`);
      return { ...preset, preset: viewport };
    }
    return {
      width: viewport.width || 390,
      height: viewport.height || 844,
      scaleFactor: viewport.scaleFactor || 2,
      mobile: viewport.mobile !== false,
      ua: viewport.ua || DEVICE_PRESETS.mobile.ua,
      preset: 'custom',
    };
  }

  _applyDeviceEmulation(sess, spec) {
    const ua = spec.ua || DEVICE_PRESETS.mobile.ua;
    sess.window.webContents.setUserAgent(ua);
    sess.window.setSize(spec.width, spec.height);

    try {
      sess.window.webContents.enableDeviceEmulation({
        screenPosition: 'mobile',
        screenSize: { width: spec.width, height: spec.height },
        viewSize: { width: spec.width, height: spec.height },
        viewPosition: { x: 0, y: 0 },
        deviceScaleFactor: spec.scaleFactor || 2,
        fitToView: false,
      });
    } catch (_) {
      // Device emulation may not be available in all contexts (tests)
    }

    sess.viewport = {
      preset: spec.preset || 'mobile',
      width: spec.width,
      height: spec.height,
      scaleFactor: spec.scaleFactor || 2,
      mobile: true,
    };
  }

  _getSession(sessionId) {
    const sess = this.sessions.get(sessionId);
    if (!sess) throw new Error(`Session ${sessionId} not found`);
    if (sess.status === 'destroyed') throw new Error(`Session ${sessionId} is destroyed`);
    return sess;
  }

  _cleanupSession(sessionId) {
    const sess = this.sessions.get(sessionId);
    if (!sess) return;

    sess.status = 'destroyed';
    if (sess._sessionTimeout) clearTimeout(sess._sessionTimeout);
    if (sess._hitlTimeout) clearTimeout(sess._hitlTimeout);
    if (sess._cleanupStealth) sess._cleanupStealth();

    if (sess._backend) {
      sess._backend.close().catch(() => {});
    }

    try {
      if (sess.window && !sess.window.isDestroyed()) {
        if (sess.overlayView) {
          sess.window.removeBrowserView(sess.overlayView);
          sess.overlayView.webContents.destroy();
        }
        sess.window.close();
      }
    } catch (_) {}

    this.sessions.delete(sessionId);
    this.emit('session:destroyed', { sessionId });
  }

  _timeoutSession(sessionId) {
    const sess = this.sessions.get(sessionId);
    if (!sess || sess.status === 'destroyed') return;
    sess.emit('timeout');
    this.emit('session:timeout', { sessionId });
    this._cleanupSession(sessionId);
  }

  async _navigatePlaywright(sess, sessionId, url, opts) {
    sess.status = 'navigating';
    sess.emit('navigating', url);
    try {
      const result = await sess._backend.navigate(url, {
        waitUntil: opts.waitUntil,
        timeout: opts.timeout,
      });
      if (opts.spaSettle > 0) await this._wait(opts.spaSettle);

      sess.lastUrl = result.url;
      sess.lastTitle = result.title;
      sess.status = 'ready';
      sess.redirected = result.url !== url;

      sess.history.push({ action: 'navigate', url: sess.lastUrl, title: sess.lastTitle, timestamp: Date.now() });

      return {
        url: sess.lastUrl,
        title: sess.lastTitle,
        status: 'loaded',
        blocked: false,
        redirected: sess.redirected,
      };
    } catch (err) {
      sess.status = 'error';
      return { url, status: 'error', error: err.message, blocked: false };
    }
  }

  async _actPlaywright(sess, action, strategy) {
    if (sess.actionCount >= sess.maxActions) {
      return { success: false, error: 'Max actions reached', actionCount: sess.actionCount };
    }
    sess.actionCount++;

    try {
      const script = strategy === 'fast'
        ? this._buildFastActionScript(action)
        : this._buildActionScript(action);

      const result = await sess._backend.evaluate(script);
      await this._wait(strategy === 'fast' ? 100 : 300);

      const newUrl = sess._backend.page?.url() || sess.lastUrl;
      const urlChanged = newUrl !== sess.lastUrl;
      sess.lastUrl = newUrl;
      try { sess.lastTitle = await sess._backend.page?.title(); } catch { /* ok */ }

      sess.history.push({
        action: action.action, ref: action.ref, value: action.value,
        strategy, success: result.success, urlChanged, timestamp: Date.now(),
      });

      return {
        success: result.success,
        strategy,
        actionCount: sess.actionCount,
        url: sess.lastUrl,
        urlChanged,
        fallback: null,
        trusted: false,
        error: result.error,
      };
    } catch (err) {
      sess.history.push({
        action: action.action, ref: action.ref, strategy,
        success: false, error: err.message, timestamp: Date.now(),
      });
      return { success: false, strategy, error: err.message, actionCount: sess.actionCount };
    }
  }

  async _waitForLoad(sess, waitUntil, timeout) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, timeout);

      const event = waitUntil === 'domcontentloaded' ? 'dom-ready' : 'did-finish-load';

      const handler = () => {
        cleanup();
        resolve();
      };

      const cleanup = () => {
        clearTimeout(timer);
        sess.window.webContents.removeListener(event, handler);
      };

      if (waitUntil === 'networkidle') {
        this._waitForNetworkIdle(sess, Math.min(timeout, 8000)).then(() => {
          cleanup();
          resolve();
        });
      } else {
        sess.window.webContents.once(event, handler);
      }
    });
  }

  async _waitForNetworkIdle(sess, timeout, idleMs = 500) {
    return new Promise((resolve) => {
      let pending = 0;
      let idleTimer = null;
      const partitionKey = sess.persistent ? `persist:${sess.partition}` : sess.partition;
      let sessionObj;

      try {
        sessionObj = getElectron().session.fromPartition(partitionKey);
      } catch (_) {
        setTimeout(resolve, 2000);
        return;
      }

      const overallTimer = setTimeout(() => {
        cleanup();
        resolve();
      }, timeout);

      const checkIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (pending <= 0) {
          idleTimer = setTimeout(() => {
            cleanup();
            resolve();
          }, idleMs);
        }
      };

      const onBeforeRequest = () => { pending++; };
      const onCompleted = () => { pending = Math.max(0, pending - 1); checkIdle(); };
      const onErrorOccurred = () => { pending = Math.max(0, pending - 1); checkIdle(); };

      const cleanup = () => {
        clearTimeout(overallTimer);
        if (idleTimer) clearTimeout(idleTimer);
        try {
          sessionObj.webRequest.onBeforeRequest(null);
          sessionObj.webRequest.onCompleted(null);
          sessionObj.webRequest.onErrorOccurred(null);
        } catch (_) { /* session may be destroyed */ }
      };

      sessionObj.webRequest.onBeforeRequest(onBeforeRequest);
      sessionObj.webRequest.onCompleted(onCompleted);
      sessionObj.webRequest.onErrorOccurred(onErrorOccurred);

      checkIdle();
    });
  }

  _wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  _showOverlay(sess, message) {
    // Overlay is a minimal HTML page shown via BrowserView on top
    // Not modifying the target page DOM (stealth safe)
    try {
      const { BrowserView } = getElectron();
      const view = new BrowserView({
        webPreferences: { nodeIntegration: false, contextIsolation: true },
      });
      sess.window.addBrowserView(view);
      const bounds = sess.window.getContentBounds();
      view.setBounds({ x: 0, y: 0, width: bounds.width, height: 48 });
      view.webContents.loadURL(`data:text/html,${encodeURIComponent(`
        <!DOCTYPE html>
        <html><head><style>
          body { margin:0; padding:8px 16px; font:13px/1.4 -apple-system,system-ui,sans-serif;
            background:#1a1a2e; color:#e0e0e0; display:flex; align-items:center; gap:12px; }
          .dot { width:8px; height:8px; border-radius:50%; background:#ffd700; animation:pulse 1s infinite; }
          @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
          button { background:#333; color:#fff; border:1px solid #555; border-radius:4px; padding:4px 12px; cursor:pointer; font-size:12px; }
          button:hover { background:#444; }
        </style></head><body>
          <span class="dot"></span>
          <span>${message}</span>
          <span style="flex:1"></span>
          <button onclick="window.close()">Cancel</button>
        </body></html>
      `)}`);
      sess.overlayView = view;
    } catch (_) {}
  }

  _buildExtractionScript(mode, maxLength, opts) {
    return `
(function() {
  const mode = '${mode}';
  const maxLen = ${maxLength};
  const includeLinks = ${opts.includeLinks !== false};
  const includeImages = ${opts.includeImages || false};

  function getMetadata() {
    const meta = {};
    meta.title = document.title;
    meta.url = window.location.href;
    meta.description = '';
    meta.author = '';
    meta.publishDate = '';
    meta.siteName = '';

    const descEl = document.querySelector('meta[name="description"],meta[property="og:description"]');
    if (descEl) meta.description = descEl.getAttribute('content') || '';
    const authorEl = document.querySelector('meta[name="author"],meta[property="article:author"]');
    if (authorEl) meta.author = authorEl.getAttribute('content') || '';
    const dateEl = document.querySelector('meta[property="article:published_time"],meta[name="date"],time[datetime]');
    if (dateEl) meta.publishDate = dateEl.getAttribute('content') || dateEl.getAttribute('datetime') || '';
    const siteEl = document.querySelector('meta[property="og:site_name"]');
    if (siteEl) meta.siteName = siteEl.getAttribute('content') || '';

    // JSON-LD
    try {
      const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
      const ldData = [];
      ldScripts.forEach(s => { try { ldData.push(JSON.parse(s.textContent)); } catch(_) {} });
      if (ldData.length) meta.structuredData = ldData;
    } catch(_) {}

    // Open Graph
    const og = {};
    document.querySelectorAll('meta[property^="og:"]').forEach(m => {
      og[m.getAttribute('property').replace('og:', '')] = m.getAttribute('content');
    });
    if (Object.keys(og).length) meta.openGraph = og;

    return meta;
  }

  function extractReadability() {
    const clone = document.cloneNode(true);
    const remove = ['script','style','nav','header','footer','aside',
      '[role="navigation"]','[role="banner"]','[role="complementary"]',
      '.sidebar','.nav','.menu','.ad','.advertisement','.social-share',
      '.comments','.cookie-banner','[class*="consent"]'];
    remove.forEach(sel => {
      try { clone.querySelectorAll(sel).forEach(el => el.remove()); } catch(_) {}
    });

    const article = clone.querySelector('article, [role="main"], main, .post-content, .article-body, .entry-content');
    const source = article || clone.body;
    let text = source ? source.innerText : document.body.innerText;

    text = text.replace(/\\n{3,}/g, '\\n\\n').trim();
    if (text.length > maxLen) text = text.slice(0, maxLen) + '\\n[...truncated]';
    return text;
  }

  function extractRaw() {
    let text = document.body.innerText || '';
    text = text.replace(/\\n{3,}/g, '\\n\\n').trim();
    if (text.length > maxLen) text = text.slice(0, maxLen) + '\\n[...truncated]';
    return text;
  }

  function extractLinks() {
    if (!includeLinks) return [];
    const links = [];
    document.querySelectorAll('a[href]').forEach(a => {
      const href = a.href;
      const text = a.innerText.trim();
      if (href && text && !href.startsWith('javascript:') && !href.startsWith('#')) {
        links.push({ href, text: text.slice(0, 100) });
      }
    });
    return links.slice(0, 50);
  }

  function extractHeadings() {
    const headings = [];
    document.querySelectorAll('h1,h2,h3').forEach(h => {
      headings.push({ level: parseInt(h.tagName[1]), text: h.innerText.trim().slice(0, 200) });
    });
    return headings.slice(0, 30);
  }

  const metadata = getMetadata();
  const text = mode === 'raw' ? extractRaw() : extractReadability();
  const links = extractLinks();
  const headings = extractHeadings();

  return { text, metadata, links, headings };
})();
`;
  }

  _buildSnapshotScript(interactiveOnly) {
    return `
(function() {
  const interactive = ${interactiveOnly};
  const refs = [];
  let refCounter = 0;

  const INTERACTIVE_ROLES = new Set([
    'button','link','textbox','checkbox','radio','combobox','listbox',
    'menuitem','tab','switch','slider','spinbutton','searchbox','option',
  ]);

  const INTERACTIVE_TAGS = new Set([
    'A','BUTTON','INPUT','SELECT','TEXTAREA','DETAILS','SUMMARY',
  ]);

  function isVisible(el) {
    if (!el.offsetParent && el.tagName !== 'BODY' && el.tagName !== 'HTML') return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function getRole(el) {
    if (el.getAttribute('role')) return el.getAttribute('role');
    const tag = el.tagName;
    if (tag === 'A' && el.href) return 'link';
    if (tag === 'BUTTON') return 'button';
    if (tag === 'INPUT') {
      const type = (el.type || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button') return 'button';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'H1' || tag === 'H2' || tag === 'H3') return 'heading';
    if (tag === 'IMG') return 'img';
    if (tag === 'NAV') return 'navigation';
    return el.tagName.toLowerCase();
  }

  function getName(el) {
    return el.getAttribute('aria-label')
      || el.getAttribute('title')
      || el.getAttribute('alt')
      || el.getAttribute('placeholder')
      || el.innerText?.trim().slice(0, 80)
      || el.getAttribute('name')
      || '';
  }

  function walk(root) {
    const elements = root.querySelectorAll('*');
    for (const el of elements) {
      if (!isVisible(el)) continue;

      const role = getRole(el);
      const isInteractive = INTERACTIVE_ROLES.has(role) || INTERACTIVE_TAGS.has(el.tagName);

      if (interactive && !isInteractive) continue;

      refCounter++;
      const ref = {
        ref: refCounter,
        role: role,
        name: getName(el),
        tag: el.tagName.toLowerCase(),
      };

      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        ref.value = el.value || '';
        ref.type = el.type || 'text';
      }
      if (el.tagName === 'SELECT') {
        ref.value = el.value || '';
        ref.options = Array.from(el.options).slice(0, 20).map(o => o.text);
      }
      if (el.checked !== undefined) ref.checked = el.checked;
      if (el.disabled) ref.disabled = true;
      if (el.href) ref.href = el.href;

      el.dataset.__browseRef = refCounter;
      refs.push(ref);
    }
  }

  walk(document);

  return { refs, totalElements: refCounter };
})();
`;
  }

  _buildActionScript(action) {
    return `
(function() {
  const ref = ${JSON.stringify(action.ref)};
  const actionType = ${JSON.stringify(action.action)};
  const value = ${JSON.stringify(action.value || '')};

  const el = document.querySelector('[data-__browse-ref="' + ref + '"]');
  if (!el) return { success: false, error: 'Element with ref ' + ref + ' not found' };

  try {
    switch (actionType) {
      case 'click':
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.click();
        return { success: true };

      case 'fill':
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.focus();
        el.value = '';
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true };

      case 'select':
        el.value = value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true };

      case 'scroll':
        if (value === 'up') window.scrollBy(0, -400);
        else if (value === 'down') window.scrollBy(0, 400);
        else if (value === 'top') window.scrollTo(0, 0);
        else if (value === 'bottom') window.scrollTo(0, document.body.scrollHeight);
        else el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return { success: true };

      case 'hover':
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        return { success: true };

      case 'press':
        el.focus();
        el.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: value, bubbles: true }));
        return { success: true };

      case 'check':
        if (!el.checked) el.click();
        return { success: true, checked: el.checked };

      case 'uncheck':
        if (el.checked) el.click();
        return { success: true, checked: el.checked };

      case 'focus':
        el.focus();
        return { success: true };

      default:
        return { success: false, error: 'Unknown action: ' + actionType };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
})();
`;
  }

  _buildFastActionScript(action) {
    return `
(function() {
  const ref = ${JSON.stringify(action.ref)};
  const actionType = ${JSON.stringify(action.action)};
  const value = ${JSON.stringify(action.value || '')};

  const el = document.querySelector('[data-__browse-ref="' + ref + '"]');
  if (!el) return { success: false, error: 'Element with ref ' + ref + ' not found' };

  try {
    switch (actionType) {
      case 'click':
        el.click();
        return { success: true };

      case 'fill':
        el.value = value;
        return { success: true };

      case 'select':
        el.value = value;
        return { success: true };

      case 'submit':
        const form = el.closest('form') || (el.tagName === 'FORM' ? el : null);
        if (form) { form.submit(); return { success: true }; }
        el.click();
        return { success: true };

      case 'check':
        el.checked = true;
        return { success: true, checked: true };

      case 'uncheck':
        el.checked = false;
        return { success: true, checked: false };

      case 'focus':
        el.focus();
        return { success: true };

      case 'scroll':
        if (value === 'up') window.scrollBy(0, -400);
        else if (value === 'down') window.scrollBy(0, 400);
        else if (value === 'top') window.scrollTo(0, 0);
        else if (value === 'bottom') window.scrollTo(0, document.body.scrollHeight);
        else el.scrollIntoView({ block: 'center' });
        return { success: true };

      default:
        return { success: false, error: 'Unknown action: ' + actionType };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
})();
`;
  }

  _buildGetElementRect(ref) {
    return `
(function() {
  const el = document.querySelector('[data-__browse-ref="${ref}"]');
  if (!el) return null;
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), width: r.width, height: r.height };
})();
`;
  }

  async _sendTrustedClick(sess, ref) {
    const rect = await sess.window.webContents.executeJavaScript(this._buildGetElementRect(ref));
    if (!rect) return { success: false, error: 'Element with ref ' + ref + ' not found' };

    sess.window.webContents.sendInputEvent({ type: 'mouseDown', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await this._wait(50);
    sess.window.webContents.sendInputEvent({ type: 'mouseUp', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    return { success: true, trusted: true };
  }

  async _sendTrustedFill(sess, ref, value) {
    const rect = await sess.window.webContents.executeJavaScript(this._buildGetElementRect(ref));
    if (!rect) return { success: false, error: 'Element with ref ' + ref + ' not found' };

    sess.window.webContents.sendInputEvent({ type: 'mouseDown', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await this._wait(30);
    sess.window.webContents.sendInputEvent({ type: 'mouseUp', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await this._wait(50);

    await sess.window.webContents.executeJavaScript(`
      (() => {
        const el = document.querySelector('[data-__browse-ref="${ref}"]');
        if (el) { el.value = ''; el.focus(); }
      })()
    `);

    await sess.window.webContents.insertText(value);
    return { success: true, trusted: true };
  }

  async _sendTrustedKey(sess, ref, key) {
    await sess.window.webContents.executeJavaScript(`
      (() => {
        const el = document.querySelector('[data-__browse-ref="${ref}"]');
        if (el) el.focus();
      })()
    `);
    await this._wait(30);

    const keyCode = key.charCodeAt(0);
    sess.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
    await this._wait(20);
    sess.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
    return { success: true, trusted: true };
  }

  async _executeStealth(sess, action) {
    switch (action.action) {
      case 'click':
      case 'submit':
      case 'check':
      case 'uncheck':
        return await this._sendTrustedClick(sess, action.ref);
      case 'fill':
        return await this._sendTrustedFill(sess, action.ref, action.value || '');
      case 'press':
        return await this._sendTrustedKey(sess, action.ref, action.value || 'Enter');
      case 'hover': {
        const rect = await sess.window.webContents.executeJavaScript(this._buildGetElementRect(action.ref));
        if (!rect) return { success: false, error: 'Element not found' };
        sess.window.webContents.sendInputEvent({ type: 'mouseMove', x: rect.x, y: rect.y });
        return { success: true, trusted: true };
      }
      default:
        return await sess.window.webContents.executeJavaScript(this._buildActionScript(action));
    }
  }

  async _executeWithFallback(sess, action) {
    const result = await sess.window.webContents.executeJavaScript(this._buildActionScript(action));
    if (result.success && (action.action === 'click' || action.action === 'fill')) {
      await this._wait(100);
      const stateCheck = await sess.window.webContents.executeJavaScript(`
        (() => {
          const el = document.querySelector('[data-__browse-ref="${action.ref}"]');
          if (!el) return { exists: false };
          return {
            exists: true,
            value: el.value,
            checked: el.checked,
            focused: document.activeElement === el,
          };
        })()
      `);
      if (stateCheck.exists && action.action === 'fill' && stateCheck.value !== (action.value || '')) {
        try {
          const retried = await this._executeStealth(sess, action);
          retried.fallback = 'stealth';
          return retried;
        } catch (_) { /* stealth failed, return original result */ }
      }
    }
    return result;
  }

  _buildDomContextScript(ref, depth, maxLength) {
    return `
(function() {
  const ref = ${JSON.stringify(ref)};
  const maxDepth = ${depth};
  const maxLen = ${maxLength};

  const el = document.querySelector('[data-__browse-ref="' + ref + '"]');
  if (!el) return { html: '', error: 'Element not found', ref: ref };

  function skeleton(node, d) {
    if (d > maxDepth) return '';
    if (node.nodeType === 3) {
      const t = node.textContent.trim();
      return t ? t.slice(0, 80) : '';
    }
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    if (['script','style','svg','noscript'].includes(tag)) return '';
    const attrs = [];
    if (node.id) attrs.push('id="' + node.id + '"');
    if (node.className && typeof node.className === 'string') {
      const cls = node.className.trim().split(/\\s+/).slice(0, 3).join(' ');
      if (cls) attrs.push('class="' + cls + '"');
    }
    if (node.getAttribute('type')) attrs.push('type="' + node.getAttribute('type') + '"');
    if (node.getAttribute('name')) attrs.push('name="' + node.getAttribute('name') + '"');
    if (node.getAttribute('placeholder')) attrs.push('placeholder="' + node.getAttribute('placeholder').slice(0, 40) + '"');
    if (node.getAttribute('for')) attrs.push('for="' + node.getAttribute('for') + '"');
    if (node.getAttribute('role')) attrs.push('role="' + node.getAttribute('role') + '"');
    if (node.getAttribute('aria-label')) attrs.push('aria-label="' + node.getAttribute('aria-label').slice(0, 40) + '"');
    if (node.getAttribute('data-__browse-ref')) attrs.push('ref=' + node.getAttribute('data-__browse-ref'));
    const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
    const children = Array.from(node.childNodes).map(c => skeleton(c, d + 1)).filter(Boolean).join('');
    if (!children) return '<' + tag + attrStr + '/>';
    return '<' + tag + attrStr + '>' + children + '</' + tag + '>';
  }

  let target = el;
  for (let i = 0; i < maxDepth && target.parentElement; i++) {
    target = target.parentElement;
    if (['form','fieldset','section','main','article','dialog','div'].includes(target.tagName.toLowerCase())) break;
  }

  const html = skeleton(target, 0).slice(0, maxLen);

  const labels = [];
  if (el.id) {
    const lbl = document.querySelector('label[for="' + el.id + '"]');
    if (lbl) labels.push(lbl.textContent.trim().slice(0, 80));
  }
  const closestLabel = el.closest('label');
  if (closestLabel) labels.push(closestLabel.textContent.trim().slice(0, 80));

  const fieldset = el.closest('fieldset');
  const legend = fieldset ? fieldset.querySelector('legend') : null;

  return {
    html: html,
    ref: ref,
    tag: el.tagName.toLowerCase(),
    labels: labels,
    fieldset: legend ? legend.textContent.trim().slice(0, 60) : null,
    form: el.closest('form') ? { id: el.closest('form').id, action: el.closest('form').action } : null,
  };
})();
`;
  }
}

// Singleton
const browsingAPI = new BrowsingAPI();

browsingAPI._injectDeps = function({ electron, stealth, errorDetector, safety } = {}) {
  if (electron) _electron = electron;
  if (stealth) _stealth = stealth;
  if (errorDetector) _errorDetector = errorDetector;
  if (safety) _safety = safety;
};

module.exports = browsingAPI;
