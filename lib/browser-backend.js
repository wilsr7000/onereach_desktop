'use strict';

const path = require('path');

class ElectronBackend {
  constructor() {
    this.type = 'electron';
    this._win = null;
    this._session = null;
    this._partition = null;
  }

  get webContents() { return this._win?.webContents; }
  get window() { return this._win; }

  async launch(opts = {}) {
    const { BrowserWindow } = require('electron');
    const { app } = require('electron');

    this._partition = opts.persistent
      ? `persist:${opts.partition || 'browse-' + opts.sessionId}`
      : opts.partition || 'browse-' + opts.sessionId;

    const { session } = require('electron');
    this._session = session.fromPartition(this._partition);

    this._win = new BrowserWindow({
      show: opts.show || false,
      width: opts.width || 1280,
      height: opts.height || 900,
      title: opts.title || 'Browsing Session',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: path.join(app.getAppPath(), 'preload-browsing-api.js'),
        partition: this._partition,
        webviewTag: false,
        webSecurity: true,
      },
    });

    return { window: this._win, session: this._session, partition: this._partition };
  }

  async navigate(url, opts = {}) {
    const timeout = opts.timeout || 15000;
    await this._win.loadURL(url);
    await this._waitForLoad(opts.waitUntil || 'domcontentloaded', timeout);
    return {
      url: this._win.webContents.getURL(),
      title: this._win.webContents.getTitle(),
    };
  }

  async evaluate(script) {
    return this._win.webContents.executeJavaScript(script, true);
  }

  async screenshot(opts = {}) {
    const image = await this._win.webContents.capturePage();
    const format = opts.format || 'png';
    const buffer = format === 'jpeg'
      ? image.toJPEG(opts.quality || 80)
      : image.toPNG();
    return {
      base64: buffer.toString('base64'),
      width: image.getSize().width,
      height: image.getSize().height,
      format,
    };
  }

  async sendInput(event) {
    this._win.webContents.sendInputEvent(event);
  }

  async getCookies(filter = {}) {
    return this._session.cookies.get(filter);
  }

  async setCookies(cookies) {
    for (const c of cookies) {
      await this._session.cookies.set(c);
    }
  }

  async show() {
    if (this._win && !this._win.isDestroyed()) {
      this._win.show();
      this._win.focus();
    }
  }

  async close() {
    if (this._win && !this._win.isDestroyed()) {
      this._win.destroy();
    }
    this._win = null;
    this._session = null;
  }

  supportsHITL() { return true; }

  async _waitForLoad(waitUntil, timeout) {
    const wc = this._win.webContents;
    const eventMap = { domcontentloaded: 'dom-ready', load: 'did-finish-load' };
    const eventName = eventMap[waitUntil] || 'dom-ready';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(), timeout);
      wc.once(eventName, () => { clearTimeout(timer); resolve(); });
    });
  }
}

class PlaywrightBackend {
  constructor() {
    this.type = 'playwright';
    this._browser = null;
    this._context = null;
    this._page = null;
  }

  get page() { return this._page; }
  get context() { return this._context; }

  async launch(opts = {}) {
    let playwright;
    try {
      playwright = require('playwright');
    } catch {
      throw new Error('Playwright not installed. Run: npm install playwright');
    }

    const launchArgs = [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ];

    this._browser = await playwright.chromium.launch({
      headless: !opts.show,
      args: launchArgs,
      channel: 'chrome',
    });

    const contextOpts = {
      viewport: { width: opts.width || 1280, height: opts.height || 900 },
      userAgent: opts.userAgent || undefined,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      deviceScaleFactor: opts.deviceScaleFactor || 1,
    };

    if (opts.cookies) contextOpts.storageState = { cookies: opts.cookies };

    this._context = await this._browser.newContext(contextOpts);
    this._page = await this._context.newPage();

    await this._page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    return { page: this._page, context: this._context, browser: this._browser };
  }

  async navigate(url, opts = {}) {
    const timeout = opts.timeout || 15000;
    const waitUntilMap = {
      domcontentloaded: 'domcontentloaded',
      load: 'load',
      networkidle: 'networkidle',
    };
    const waitUntil = waitUntilMap[opts.waitUntil] || 'domcontentloaded';
    await this._page.goto(url, { waitUntil, timeout });
    return {
      url: this._page.url(),
      title: await this._page.title(),
    };
  }

  async evaluate(script) {
    return this._page.evaluate(script);
  }

  async screenshot(opts = {}) {
    const format = opts.format || 'png';
    const buffer = await this._page.screenshot({
      type: format === 'jpeg' ? 'jpeg' : 'png',
      quality: format === 'jpeg' ? (opts.quality || 80) : undefined,
      fullPage: opts.fullPage || false,
    });
    const base64 = buffer.toString('base64');
    const viewport = this._page.viewportSize();
    return {
      base64,
      width: viewport?.width || 1280,
      height: viewport?.height || 900,
      format,
    };
  }

  async sendInput(event) {
    if (event.type === 'mouseDown' || event.type === 'mouseUp') {
      await this._page.mouse.click(event.x || 0, event.y || 0);
    } else if (event.type === 'keyDown') {
      await this._page.keyboard.press(event.keyCode || event.key || '');
    } else if (event.type === 'char') {
      await this._page.keyboard.insertText(event.keyCode || event.key || '');
    } else if (event.type === 'mouseMove') {
      await this._page.mouse.move(event.x || 0, event.y || 0);
    }
  }

  async getCookies(filter = {}) {
    let cookies = await this._context.cookies();
    if (filter.url) {
      try {
        const u = new URL(filter.url);
        cookies = cookies.filter(c => u.hostname.endsWith(c.domain.replace(/^\./, '')));
      } catch { /* keep all */ }
    }
    if (filter.domain) {
      cookies = cookies.filter(c => c.domain.includes(filter.domain));
    }
    return cookies;
  }

  async setCookies(cookies) {
    const mapped = cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      secure: c.secure || false,
      httpOnly: c.httpOnly || false,
      sameSite: (c.sameSite || 'Lax'),
      expires: c.expirationDate || -1,
    }));
    await this._context.addCookies(mapped);
  }

  async show() {
    // Playwright doesn't support showing after launch in headless mode
  }

  async close() {
    try {
      if (this._page) await this._page.close().catch(() => {});
      if (this._context) await this._context.close().catch(() => {});
      if (this._browser) await this._browser.close().catch(() => {});
    } catch { /* cleanup is best-effort */ }
    this._page = null;
    this._context = null;
    this._browser = null;
  }

  supportsHITL() { return false; }
}

function createBackend(type) {
  if (type === 'chrome' || type === 'playwright') return new PlaywrightBackend();
  return new ElectronBackend();
}

module.exports = { ElectronBackend, PlaywrightBackend, createBackend };
