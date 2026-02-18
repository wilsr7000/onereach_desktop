/**
 * Browser Automation Service
 *
 * Playwright-based singleton that manages an isolated Chromium browser.
 * Provides a high-level, reference-based API for navigation, interaction,
 * screenshots, and data extraction.
 *
 * Design principles:
 * - Isolated browser profile (never touches user's personal browser)
 * - Headless by default, headed option for debugging
 * - Auto-start on first use, idle shutdown after timeout
 * - Ref-based interaction: snapshot() returns numbered refs, act() uses them
 * - Single shared browser instance with tab isolation per task
 *
 * Usage:
 *   const browser = require('./lib/browser-automation');
 *   await browser.start();
 *   await browser.navigate('https://example.com');
 *   const snap = await browser.snapshot();
 *   await browser.act(2, 'click');
 *   const img = await browser.screenshot();
 *   await browser.stop();
 */

const path = require('path');
const os = require('os');
const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

// ==================== CONFIGURATION ====================

const DEFAULT_CONFIG = {
  headless: true,
  idleShutdownMs: 5 * 60 * 1000, // 5 minutes
  maxActionsPerTask: 20,
  maxConcurrentTabs: 3,
  blockedDomains: [],
  viewport: { width: 1280, height: 720 },
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  navigationTimeout: 30000,
  actionTimeout: 10000,
};

// ==================== SINGLETON STATE ====================

let browser = null;
let context = null;
let activePage = null;
let pages = new Map(); // tabId -> page
let tabCounter = 0;
let lastRefMap = new Map(); // ref number -> locator metadata
let refCounter = 0;
let idleTimer = null;
let config = { ...DEFAULT_CONFIG };
let starting = false;
let startPromise = null;

// Network inspection state
let capturedConsole = []; // { type, text, timestamp }
let capturedErrors = []; // { message, timestamp }
let capturedRequests = []; // { url, method, status, timestamp }
let networkCapturing = false;

// Download state
const downloadDir = path.join(os.homedir(), 'Library', 'Application Support', 'onereach-ai', 'browser-downloads');

// Data directory for isolated browser profile
const userDataDir = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'onereach-ai',
  'browser-automation-profile'
);

// ==================== LIFECYCLE ====================

/**
 * Start the managed browser.
 * Idempotent -- safe to call if already running.
 * @param {Object} [opts] - Override config for this session
 * @returns {Promise<{ success: boolean }>}
 */
async function start(opts = {}) {
  if (browser) {
    resetIdleTimer();
    return { success: true, message: 'Browser already running' };
  }

  // Prevent concurrent starts
  if (starting) return startPromise;
  starting = true;

  startPromise = _doStart(opts);
  try {
    return await startPromise;
  } finally {
    starting = false;
    startPromise = null;
  }
}

async function _doStart(opts) {
  try {
    // Merge runtime config
    Object.assign(config, opts);

    const { chromium } = require('playwright');

    log.info('browser-automation', 'Starting managed browser', {
      headless: config.headless,
      userDataDir,
    });

    // Launch with persistent context for cookie/storage persistence
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: config.headless,
      viewport: config.viewport,
      userAgent: config.userAgent,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
      ignoreHTTPSErrors: true,
    });

    browser = context.browser() || context; // persistent context IS the browser

    // Use the default page or create one
    const existingPages = context.pages();
    if (existingPages.length > 0) {
      activePage = existingPages[0];
    } else {
      activePage = await context.newPage();
    }

    const tabId = `tab-${++tabCounter}`;
    pages.set(tabId, activePage);

    // Handle page close events
    activePage.on('close', () => {
      for (const [id, p] of pages) {
        if (p === activePage) {
          pages.delete(id);
          break;
        }
      }
      if (pages.size > 0) {
        activePage = pages.values().next().value;
      } else {
        activePage = null;
      }
    });

    // Set up default dialog handler (auto-accept, like OpenClaw)
    _attachDialogHandler(activePage);

    // Set up network capturing on the default page
    _attachNetworkCapture(activePage);

    resetIdleTimer();

    log.info('browser-automation', 'Browser started successfully');
    return { success: true };
  } catch (error) {
    log.error('browser-automation', 'Failed to start browser', { error: error.message });
    browser = null;
    context = null;
    activePage = null;
    return { success: false, error: error.message };
  }
}

/**
 * Stop the managed browser and clean up.
 * @returns {Promise<{ success: boolean }>}
 */
async function stop() {
  clearIdleTimer();

  if (!context) {
    return { success: true, message: 'Browser not running' };
  }

  try {
    log.info('browser-automation', 'Stopping browser');
    await context.close().catch((err) => console.warn('[browser-automation] context close:', err.message));
  } catch (error) {
    log.warn('browser-automation', 'Error closing browser', { error: error.message });
  } finally {
    browser = null;
    context = null;
    activePage = null;
    pages.clear();
    lastRefMap.clear();
    refCounter = 0;
  }

  return { success: true };
}

/**
 * Get browser status.
 * @returns {Object}
 */
function status() {
  if (!activePage) {
    return { running: false };
  }

  let url = '';
  let _title = '';
  try {
    url = activePage.url();
    // title requires async but we try synchronously from cache
  } catch (_e) {
    /* page may be navigating */
  }

  return {
    running: true,
    url,
    tabCount: pages.size,
    headless: config.headless,
    config: {
      maxActionsPerTask: config.maxActionsPerTask,
      blockedDomains: config.blockedDomains,
      maxConcurrentTabs: config.maxConcurrentTabs,
      idleShutdownMs: config.idleShutdownMs,
    },
  };
}

// ==================== NAVIGATION ====================

/**
 * Navigate to a URL.
 * Auto-starts the browser if not running.
 * @param {string} url - URL to navigate to
 * @param {Object} [opts]
 * @param {string} [opts.waitUntil='load'] - 'load', 'domcontentloaded', 'networkidle'
 * @param {number} [opts.timeout] - Navigation timeout ms
 * @returns {Promise<Object>}
 */
async function navigate(url, opts = {}) {
  await ensureRunning();

  // Check blocked domains
  if (isBlocked(url)) {
    return { success: false, error: `Domain is blocked: ${new URL(url).hostname}` };
  }

  const waitUntil = opts.waitUntil || 'load';
  const timeout = opts.timeout || config.navigationTimeout;

  try {
    log.info('browser-automation', `Navigating to ${url}`);
    const response = await activePage.goto(url, { waitUntil, timeout });
    // Allow the page a moment to settle
    await activePage.waitForTimeout(1000);

    resetIdleTimer();

    return {
      success: true,
      url: activePage.url(),
      status: response?.status() || 0,
    };
  } catch (error) {
    log.error('browser-automation', 'Navigation failed', { url, error: error.message });
    return { success: false, error: error.message };
  }
}

// ==================== SNAPSHOT (ref-based) ====================

/**
 * Take an accessibility snapshot of the current page.
 * Returns a structured tree with numbered refs for interaction.
 * @param {Object} [opts]
 * @param {boolean} [opts.interactiveOnly=false] - Only include interactive elements
 * @returns {Promise<Object>}
 */
async function snapshot(opts = {}) {
  await ensureRunning();
  resetIdleTimer();

  try {
    const interactiveOnly = opts.interactiveOnly !== false;

    // Build the accessibility tree using Playwright's accessibility API
    const accessibilityTree = await activePage.accessibility.snapshot({
      interestingOnly: interactiveOnly,
    });

    // Reset ref counter for fresh mapping
    lastRefMap.clear();
    refCounter = 0;

    const refs = {};
    let treeText = '';

    if (accessibilityTree) {
      treeText = _buildRefTree(accessibilityTree, refs, 0);
    }

    return {
      success: true,
      url: activePage.url(),
      title: await activePage.title(),
      refs,
      tree: treeText,
      refCount: refCounter,
    };
  } catch (error) {
    log.error('browser-automation', 'Snapshot failed', { error: error.message });
    return { success: false, error: error.message, refs: {}, tree: '' };
  }
}

/**
 * Recursively build a ref tree from the accessibility snapshot.
 * Assigns numbered refs to interactive/meaningful elements.
 */
function _buildRefTree(node, refs, depth) {
  if (!node) return '';

  const indent = '  '.repeat(depth);
  let line = '';
  let ref = null;

  // Assign ref to interactive elements
  const interactiveRoles = new Set([
    'link',
    'button',
    'textbox',
    'combobox',
    'checkbox',
    'radio',
    'menuitem',
    'tab',
    'switch',
    'slider',
    'spinbutton',
    'searchbox',
    'option',
    'menuitemcheckbox',
    'menuitemradio',
    'treeitem',
  ]);

  const isInteractive = interactiveRoles.has(node.role);
  const hasName = node.name && node.name.trim().length > 0;

  if (isInteractive || (hasName && ['heading', 'img', 'cell', 'row'].includes(node.role))) {
    ref = ++refCounter;
    const name = node.name ? ` '${node.name.substring(0, 80)}'` : '';
    const value = node.value ? ` value='${String(node.value).substring(0, 40)}'` : '';
    const checked = node.checked !== undefined ? ` [${node.checked ? 'checked' : 'unchecked'}]` : '';
    const disabled = node.disabled ? ' [disabled]' : '';

    line = `${indent}[${ref}] ${node.role}${name}${value}${checked}${disabled}\n`;

    // Store ref metadata for act()
    lastRefMap.set(ref, {
      role: node.role,
      name: node.name || '',
      value: node.value,
      checked: node.checked,
      disabled: node.disabled,
    });

    refs[ref] = {
      role: node.role,
      name: node.name || '',
      tag: node.role,
      value: node.value,
      disabled: !!node.disabled,
    };
  } else if (node.role === 'text' && hasName) {
    // Show text nodes without ref for context
    const text = node.name.substring(0, 120);
    line = `${indent}  "${text}"\n`;
  }

  // Recurse children
  let childText = '';
  if (node.children) {
    for (const child of node.children) {
      childText += _buildRefTree(child, refs, depth + (ref ? 1 : 0));
    }
  }

  return line + childText;
}

// ==================== ACTIONS ====================

/**
 * Perform an action on an element identified by ref number.
 * @param {number} ref - Ref number from snapshot
 * @param {string} action - 'click', 'fill', 'type', 'select', 'hover', 'check', 'uncheck', 'press'
 * @param {string} [value] - Value for fill/type/select/press actions
 * @returns {Promise<Object>}
 */
async function act(ref, action, value) {
  await ensureRunning();
  resetIdleTimer();

  const refInfo = lastRefMap.get(ref);
  if (!refInfo) {
    return { success: false, error: `Ref ${ref} not found. Take a new snapshot first.` };
  }

  try {
    const locator = _buildLocator(refInfo);
    if (!locator) {
      return { success: false, error: `Could not build locator for ref ${ref}` };
    }

    log.info('browser-automation', `Acting: ${action} on ref ${ref} (${refInfo.role} '${refInfo.name}')`, {
      value: value?.substring?.(0, 50),
    });

    switch (action) {
      case 'click':
        await locator.click({ timeout: config.actionTimeout });
        break;
      case 'dblclick':
        await locator.dblclick({ timeout: config.actionTimeout });
        break;
      case 'fill':
        await locator.fill(value || '', { timeout: config.actionTimeout });
        break;
      case 'type':
        await locator.pressSequentially(value || '', { delay: 50, timeout: config.actionTimeout });
        break;
      case 'select':
        await locator.selectOption(value || '', { timeout: config.actionTimeout });
        break;
      case 'hover':
        await locator.hover({ timeout: config.actionTimeout });
        break;
      case 'check':
        await locator.check({ timeout: config.actionTimeout });
        break;
      case 'uncheck':
        await locator.uncheck({ timeout: config.actionTimeout });
        break;
      case 'press':
        await locator.press(value || 'Enter', { timeout: config.actionTimeout });
        break;
      case 'focus':
        await locator.focus({ timeout: config.actionTimeout });
        break;
      case 'scrollIntoView':
        await locator.scrollIntoViewIfNeeded({ timeout: config.actionTimeout });
        break;
      default:
        return { success: false, error: `Unknown action: ${action}` };
    }

    // Brief pause to let the page react
    await activePage.waitForTimeout(500);

    return { success: true, action, ref, url: activePage.url() };
  } catch (error) {
    log.error('browser-automation', `Action failed: ${action} on ref ${ref}`, { error: error.message });
    return { success: false, error: error.message, action, ref };
  }
}

/**
 * Scroll the page.
 * @param {'up'|'down'|'top'|'bottom'} direction
 * @param {number} [amount=500] - Pixels to scroll
 * @returns {Promise<Object>}
 */
async function scroll(direction = 'down', amount = 500) {
  await ensureRunning();
  resetIdleTimer();

  try {
    switch (direction) {
      case 'up':
        await activePage.evaluate((px) => window.scrollBy(0, -px), amount);
        break;
      case 'down':
        await activePage.evaluate((px) => window.scrollBy(0, px), amount);
        break;
      case 'top':
        await activePage.evaluate(() => window.scrollTo(0, 0));
        break;
      case 'bottom':
        await activePage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        break;
    }

    await activePage.waitForTimeout(300);
    return { success: true, direction };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Build a Playwright locator from ref metadata.
 * Uses role-based locators for reliability.
 */
function _buildLocator(refInfo) {
  if (!activePage) return null;

  const { role, name } = refInfo;

  // Map accessibility roles to Playwright getByRole roles
  const roleMap = {
    link: 'link',
    button: 'button',
    textbox: 'textbox',
    searchbox: 'searchbox',
    combobox: 'combobox',
    checkbox: 'checkbox',
    radio: 'radio',
    menuitem: 'menuitem',
    menuitemcheckbox: 'menuitemcheckbox',
    menuitemradio: 'menuitemradio',
    tab: 'tab',
    switch: 'switch',
    slider: 'slider',
    spinbutton: 'spinbutton',
    option: 'option',
    treeitem: 'treeitem',
    heading: 'heading',
    img: 'img',
    cell: 'cell',
    row: 'row',
  };

  const playwrightRole = roleMap[role];
  if (!playwrightRole) {
    // Fall back to text-based locator
    if (name) {
      return activePage.getByText(name, { exact: false });
    }
    return null;
  }

  const opts = {};
  if (name) opts.name = name;

  return activePage.getByRole(playwrightRole, opts);
}

// ==================== SCREENSHOTS ====================

/**
 * Take a screenshot of the current page.
 * @param {Object} [opts]
 * @param {boolean} [opts.fullPage=false] - Capture full page
 * @param {'png'|'jpeg'} [opts.type='png'] - Image format
 * @param {number} [opts.quality] - JPEG quality (1-100)
 * @returns {Promise<Object>}
 */
async function screenshot(opts = {}) {
  await ensureRunning();
  resetIdleTimer();

  try {
    const imageType = opts.type || 'png';
    const buffer = await activePage.screenshot({
      fullPage: opts.fullPage || false,
      type: imageType,
      quality: imageType === 'jpeg' ? opts.quality || 80 : undefined,
    });

    const base64 = buffer.toString('base64');
    const mimeType = imageType === 'jpeg' ? 'image/jpeg' : 'image/png';

    return {
      success: true,
      image: `data:${mimeType};base64,${base64}`,
      url: activePage.url(),
      width: config.viewport.width,
      height: config.viewport.height,
    };
  } catch (error) {
    log.error('browser-automation', 'Screenshot failed', { error: error.message });
    return { success: false, error: error.message };
  }
}

// ==================== DATA EXTRACTION ====================

/**
 * Execute JavaScript in the page context.
 * @param {string} script - JavaScript to evaluate
 * @returns {Promise<Object>}
 */
async function evaluate(script) {
  await ensureRunning();
  resetIdleTimer();

  try {
    const result = await activePage.evaluate(script);
    return { success: true, result };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Extract visible text content from the page.
 * @param {string} [selector] - Optional CSS selector to scope extraction
 * @returns {Promise<Object>}
 */
async function extractText(selector) {
  await ensureRunning();
  resetIdleTimer();

  try {
    const text = await activePage.evaluate((sel) => {
      const el = sel ? document.querySelector(sel) : document.body;
      if (!el) return null;
      return el.innerText || el.textContent || '';
    }, selector || null);

    return {
      success: true,
      text: text ? text.substring(0, 50000) : '',
      url: activePage.url(),
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Extract all links from the page.
 * @returns {Promise<Object>}
 */
async function extractLinks() {
  await ensureRunning();
  resetIdleTimer();

  try {
    const links = await activePage.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href]'))
        .map((a) => ({
          text: a.innerText?.trim().substring(0, 100) || '',
          href: a.href,
          target: a.target || '',
        }))
        .filter((l) => l.href && !l.href.startsWith('javascript:'));
    });

    return { success: true, links: links.slice(0, 200) };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ==================== WAIT ====================

/**
 * Wait for a condition on the page.
 * @param {Object} condition
 * @param {string} [condition.selector] - CSS selector to wait for
 * @param {string} [condition.text] - Text content to wait for
 * @param {string} [condition.url] - URL pattern to wait for (glob)
 * @param {'load'|'domcontentloaded'|'networkidle'} [condition.state] - Load state
 * @param {number} [condition.timeout=10000]
 * @returns {Promise<Object>}
 */
async function waitFor(condition = {}) {
  await ensureRunning();
  resetIdleTimer();

  const timeout = condition.timeout || 10000;

  try {
    if (condition.selector) {
      await activePage.waitForSelector(condition.selector, { timeout });
    }
    if (condition.text) {
      await activePage.getByText(condition.text).waitFor({ timeout });
    }
    if (condition.url) {
      await activePage.waitForURL(condition.url, { timeout });
    }
    if (condition.state) {
      await activePage.waitForLoadState(condition.state, { timeout });
    }
    if (!condition.selector && !condition.text && !condition.url && !condition.state) {
      // Default: wait a fixed time
      await activePage.waitForTimeout(timeout);
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ==================== TAB MANAGEMENT ====================

/**
 * List open tabs.
 * @returns {Object}
 */
function tabs() {
  const result = [];
  for (const [id, page] of pages) {
    let url = '';
    try {
      url = page.url();
    } catch (_e) {
      /* */
    }
    result.push({
      id,
      url,
      active: page === activePage,
    });
  }
  return { success: true, tabs: result };
}

/**
 * Open a new tab.
 * @param {string} [url='about:blank']
 * @returns {Promise<Object>}
 */
async function openTab(url = 'about:blank') {
  await ensureRunning();

  if (pages.size >= config.maxConcurrentTabs) {
    return { success: false, error: `Max concurrent tabs (${config.maxConcurrentTabs}) reached` };
  }

  try {
    const page = await context.newPage();
    const tabId = `tab-${++tabCounter}`;
    pages.set(tabId, page);
    activePage = page;

    if (url !== 'about:blank') {
      await page.goto(url, { waitUntil: 'load', timeout: config.navigationTimeout });
    }

    page.on('close', () => {
      pages.delete(tabId);
      if (activePage === page) {
        activePage = pages.size > 0 ? pages.values().next().value : null;
      }
    });

    _attachDialogHandler(page);
    _attachNetworkCapture(page);

    resetIdleTimer();
    return { success: true, tabId, url: page.url() };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Close a tab by ID.
 * @param {string} tabId
 * @returns {Promise<Object>}
 */
async function closeTab(tabId) {
  const page = pages.get(tabId);
  if (!page) return { success: false, error: `Tab ${tabId} not found` };

  try {
    await page.close();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Switch to a tab by ID.
 * @param {string} tabId
 * @returns {Object}
 */
function focusTab(tabId) {
  const page = pages.get(tabId);
  if (!page) return { success: false, error: `Tab ${tabId} not found` };

  activePage = page;
  lastRefMap.clear();
  refCounter = 0;
  return { success: true, tabId };
}

// ==================== COOKIES ====================

/**
 * Get all cookies.
 * @returns {Promise<Object>}
 */
async function cookies() {
  await ensureRunning();
  try {
    const allCookies = await context.cookies();
    return { success: true, cookies: allCookies };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Set a cookie.
 * @param {Object} cookie - { name, value, domain, path, ... }
 * @returns {Promise<Object>}
 */
async function setCookie(cookie) {
  await ensureRunning();
  try {
    await context.addCookies([cookie]);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Clear all cookies.
 * @returns {Promise<Object>}
 */
async function clearCookies() {
  await ensureRunning();
  try {
    await context.clearCookies();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ==================== ENVIRONMENT ====================

/**
 * Set viewport size.
 * @param {number} width
 * @param {number} height
 * @returns {Promise<Object>}
 */
async function setViewport(width, height) {
  await ensureRunning();
  try {
    config.viewport = { width, height };
    await activePage.setViewportSize({ width, height });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Generate PDF of the current page.
 * @param {Object} [opts] - Playwright PDF options
 * @returns {Promise<Object>}
 */
async function pdf(opts = {}) {
  await ensureRunning();
  try {
    const buffer = await activePage.pdf({
      format: opts.format || 'A4',
      printBackground: opts.printBackground !== false,
      ...opts,
    });
    const base64 = buffer.toString('base64');
    return { success: true, pdf: `data:application/pdf;base64,${base64}` };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ==================== CONFIGURATION ====================

/**
 * Update runtime configuration.
 * @param {Object} newConfig
 */
function configure(newConfig) {
  Object.assign(config, newConfig);
  log.info('browser-automation', 'Config updated', { config: newConfig });
}

/**
 * Get current configuration.
 * @returns {Object}
 */
function getConfig() {
  return { ...config };
}

// ==================== INTERNALS ====================

/**
 * Ensure the browser is running, auto-starting if needed.
 */
async function ensureRunning() {
  if (!activePage || !context) {
    const result = await start();
    if (!result.success) {
      throw new Error(result.error || 'Failed to start browser');
    }
  }
}

/**
 * Check if a URL's domain is blocked.
 * @param {string} url
 * @returns {boolean}
 */
function isBlocked(url) {
  if (!config.blockedDomains || config.blockedDomains.length === 0) return false;
  try {
    const hostname = new URL(url).hostname;
    return config.blockedDomains.some((domain) => hostname === domain || hostname.endsWith('.' + domain));
  } catch {
    return false;
  }
}

/**
 * Reset the idle shutdown timer.
 */
function resetIdleTimer() {
  clearIdleTimer();
  if (config.idleShutdownMs > 0) {
    idleTimer = setTimeout(async () => {
      log.info('browser-automation', 'Idle timeout reached, shutting down');
      await stop();
    }, config.idleShutdownMs);
  }
}

/**
 * Clear the idle timer.
 */
function clearIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

// ==================== DIALOG HANDLING ====================

// Dialog state: last dialog info + configurable response
let dialogConfig = { accept: true, promptText: '' };
let lastDialog = null;

/**
 * Attach dialog handler to a page.
 * By default, auto-accepts dialogs (like OpenClaw).
 * Call handleDialog() before an action to configure response.
 */
function _attachDialogHandler(page) {
  page.on('dialog', async (dialog) => {
    lastDialog = {
      type: dialog.type(), // 'alert', 'confirm', 'prompt', 'beforeunload'
      message: dialog.message(),
      defaultValue: dialog.defaultValue(),
      timestamp: Date.now(),
    };
    log.info('browser-automation', `Dialog: ${dialog.type()} "${dialog.message().substring(0, 80)}"`);

    try {
      if (dialogConfig.accept) {
        await dialog.accept(dialogConfig.promptText || undefined);
      } else {
        await dialog.dismiss();
      }
    } catch (_e) {
      // Dialog may already be handled
    }

    // Reset to defaults after handling
    dialogConfig = { accept: true, promptText: '' };
  });
}

/**
 * Configure how the next dialog will be handled.
 * Call BEFORE the action that triggers the dialog.
 * @param {Object} opts
 * @param {boolean} [opts.accept=true] - Accept or dismiss
 * @param {string} [opts.promptText=''] - Text for prompt() dialogs
 * @returns {Object}
 */
function handleDialog(opts = {}) {
  dialogConfig = {
    accept: opts.accept !== false,
    promptText: opts.promptText || '',
  };
  return { success: true, config: dialogConfig };
}

/**
 * Get the last dialog that appeared.
 * @returns {Object}
 */
function getLastDialog() {
  return { success: true, dialog: lastDialog };
}

// ==================== FILE UPLOAD ====================

/**
 * Upload a file to a file input element.
 * @param {number} ref - Ref number of the file input
 * @param {string|string[]} filePaths - Absolute path(s) to file(s)
 * @returns {Promise<Object>}
 */
async function upload(ref, filePaths) {
  await ensureRunning();
  resetIdleTimer();

  const refInfo = lastRefMap.get(ref);
  if (!refInfo) {
    return { success: false, error: `Ref ${ref} not found. Take a new snapshot first.` };
  }

  try {
    const locator = _buildLocator(refInfo);
    if (!locator) {
      return { success: false, error: `Could not build locator for ref ${ref}` };
    }

    const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
    await locator.setInputFiles(paths, { timeout: config.actionTimeout });

    log.info('browser-automation', `Uploaded ${paths.length} file(s) to ref ${ref}`);
    return { success: true, ref, files: paths.map((p) => path.basename(p)) };
  } catch (error) {
    log.error('browser-automation', 'Upload failed', { error: error.message });
    return { success: false, error: error.message };
  }
}

/**
 * Handle a file chooser dialog triggered by a click.
 * Arms the file chooser listener, then clicks the trigger element.
 * @param {number} triggerRef - Ref of the element that opens the file chooser
 * @param {string|string[]} filePaths - Files to select
 * @returns {Promise<Object>}
 */
async function uploadViaChooser(triggerRef, filePaths) {
  await ensureRunning();
  resetIdleTimer();

  try {
    const paths = Array.isArray(filePaths) ? filePaths : [filePaths];

    // Arm the file chooser listener BEFORE clicking
    const [fileChooser] = await Promise.all([
      activePage.waitForEvent('filechooser', { timeout: config.actionTimeout }),
      act(triggerRef, 'click'),
    ]);

    await fileChooser.setFiles(paths);

    log.info('browser-automation', `File chooser: uploaded ${paths.length} file(s)`);
    return { success: true, files: paths.map((p) => path.basename(p)) };
  } catch (error) {
    log.error('browser-automation', 'File chooser upload failed', { error: error.message });
    return { success: false, error: error.message };
  }
}

// ==================== DOWNLOAD HANDLING ====================

/**
 * Wait for a download triggered by an action.
 * Arms the download listener, then clicks the trigger element.
 * @param {number} triggerRef - Ref of the element that triggers download
 * @param {string} [saveAs] - Filename to save as (optional)
 * @returns {Promise<Object>}
 */
async function download(triggerRef, saveAs) {
  await ensureRunning();
  resetIdleTimer();

  const fs = require('fs').promises;

  try {
    // Ensure download directory exists
    await fs.mkdir(downloadDir, { recursive: true });

    // Arm the download listener BEFORE clicking
    const [dl] = await Promise.all([activePage.waitForEvent('download', { timeout: 30000 }), act(triggerRef, 'click')]);

    const suggestedName = dl.suggestedFilename();
    const filename = saveAs || suggestedName;
    const savePath = path.join(downloadDir, filename);

    await dl.saveAs(savePath);

    log.info('browser-automation', `Downloaded: ${filename}`);
    return {
      success: true,
      filename,
      path: savePath,
      suggestedFilename: suggestedName,
    };
  } catch (error) {
    log.error('browser-automation', 'Download failed', { error: error.message });
    return { success: false, error: error.message };
  }
}

/**
 * Get the download directory path.
 * @returns {Object}
 */
function getDownloadDir() {
  return { success: true, path: downloadDir };
}

// ==================== STORAGE (localStorage / sessionStorage) ====================

/**
 * Get a storage value.
 * @param {'local'|'session'} storageType
 * @param {string} [key] - Specific key, or omit to get all
 * @returns {Promise<Object>}
 */
async function storageGet(storageType = 'local', key) {
  await ensureRunning();
  resetIdleTimer();

  try {
    const storage = storageType === 'session' ? 'sessionStorage' : 'localStorage';
    const result = await activePage.evaluate(
      ({ storage, key }) => {
        const s = window[storage];
        if (key) return s.getItem(key);
        const all = {};
        for (let i = 0; i < s.length; i++) {
          const k = s.key(i);
          all[k] = s.getItem(k);
        }
        return all;
      },
      { storage, key }
    );

    return { success: true, data: result };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Set a storage value.
 * @param {'local'|'session'} storageType
 * @param {string} key
 * @param {string} value
 * @returns {Promise<Object>}
 */
async function storageSet(storageType = 'local', key, value) {
  await ensureRunning();
  resetIdleTimer();

  try {
    const storage = storageType === 'session' ? 'sessionStorage' : 'localStorage';
    await activePage.evaluate(
      ({ storage, key, value }) => {
        window[storage].setItem(key, value);
      },
      { storage, key, value }
    );

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Clear storage.
 * @param {'local'|'session'} storageType
 * @returns {Promise<Object>}
 */
async function storageClear(storageType = 'local') {
  await ensureRunning();
  resetIdleTimer();

  try {
    const storage = storageType === 'session' ? 'sessionStorage' : 'localStorage';
    await activePage.evaluate((storage) => {
      window[storage].clear();
    }, storage);

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ==================== NETWORK INSPECTION ====================

/**
 * Attach network capture listeners to a page.
 */
function _attachNetworkCapture(page) {
  page.on('console', (msg) => {
    if (!networkCapturing) return;
    capturedConsole.push({
      type: msg.type(),
      text: msg.text().substring(0, 500),
      timestamp: Date.now(),
    });
    // Ring buffer: keep last 200
    if (capturedConsole.length > 200) capturedConsole.shift();
  });

  page.on('pageerror', (error) => {
    capturedErrors.push({
      message: error.message?.substring(0, 500) || String(error).substring(0, 500),
      timestamp: Date.now(),
    });
    if (capturedErrors.length > 100) capturedErrors.shift();
  });

  page.on('response', (response) => {
    if (!networkCapturing) return;
    capturedRequests.push({
      url: response.url().substring(0, 200),
      method: response.request().method(),
      status: response.status(),
      contentType: response.headers()['content-type'] || '',
      timestamp: Date.now(),
    });
    if (capturedRequests.length > 300) capturedRequests.shift();
  });
}

/**
 * Start capturing network activity.
 * @returns {Object}
 */
function networkStart() {
  networkCapturing = true;
  capturedConsole = [];
  capturedErrors = [];
  capturedRequests = [];
  return { success: true };
}

/**
 * Stop capturing network activity.
 * @returns {Object}
 */
function networkStop() {
  networkCapturing = false;
  return { success: true };
}

/**
 * Get captured console messages.
 * @param {Object} [opts]
 * @param {string} [opts.level] - Filter by type: 'log', 'warn', 'error', 'info'
 * @param {boolean} [opts.clear=false] - Clear after reading
 * @returns {Object}
 */
function getConsole(opts = {}) {
  let messages = [...capturedConsole];
  if (opts.level) {
    messages = messages.filter((m) => m.type === opts.level);
  }
  if (opts.clear) capturedConsole = [];
  return { success: true, messages };
}

/**
 * Get captured page errors.
 * @param {Object} [opts]
 * @param {boolean} [opts.clear=false]
 * @returns {Object}
 */
function getErrors(opts = {}) {
  const errors = [...capturedErrors];
  if (opts.clear) capturedErrors = [];
  return { success: true, errors };
}

/**
 * Get captured network requests.
 * @param {Object} [opts]
 * @param {string} [opts.filter] - URL substring filter
 * @param {boolean} [opts.clear=false]
 * @returns {Object}
 */
function getRequests(opts = {}) {
  let requests = [...capturedRequests];
  if (opts.filter) {
    requests = requests.filter((r) => r.url.includes(opts.filter));
  }
  if (opts.clear) capturedRequests = [];
  return { success: true, requests };
}

/**
 * Get the response body for a URL.
 * Only works for requests made after calling this (uses route interception).
 * @param {string} urlPattern - URL substring to match
 * @param {number} [timeout=10000]
 * @returns {Promise<Object>}
 */
async function getResponseBody(urlPattern, timeout = 10000) {
  await ensureRunning();

  try {
    const response = await activePage.waitForResponse((resp) => resp.url().includes(urlPattern), { timeout });
    const body = await response.text();
    return {
      success: true,
      url: response.url(),
      status: response.status(),
      body: body.substring(0, 50000),
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ==================== ELEMENT SCREENSHOT ====================

/**
 * Take a screenshot of a specific element by ref.
 * @param {number} ref - Ref number from snapshot
 * @param {Object} [opts]
 * @returns {Promise<Object>}
 */
async function screenshotElement(ref, opts = {}) {
  await ensureRunning();
  resetIdleTimer();

  const refInfo = lastRefMap.get(ref);
  if (!refInfo) {
    return { success: false, error: `Ref ${ref} not found. Take a new snapshot first.` };
  }

  try {
    const locator = _buildLocator(refInfo);
    if (!locator) {
      return { success: false, error: `Could not build locator for ref ${ref}` };
    }

    const imageType = opts.type || 'png';
    const buffer = await locator.screenshot({
      type: imageType,
      quality: imageType === 'jpeg' ? opts.quality || 80 : undefined,
      timeout: config.actionTimeout,
    });

    const base64 = buffer.toString('base64');
    const mimeType = imageType === 'jpeg' ? 'image/jpeg' : 'image/png';

    return {
      success: true,
      image: `data:${mimeType};base64,${base64}`,
      ref,
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ==================== DRAG ====================

/**
 * Drag from one element to another.
 * @param {number} sourceRef - Ref to drag from
 * @param {number} targetRef - Ref to drag to
 * @returns {Promise<Object>}
 */
async function drag(sourceRef, targetRef) {
  await ensureRunning();
  resetIdleTimer();

  const sourceInfo = lastRefMap.get(sourceRef);
  const targetInfo = lastRefMap.get(targetRef);
  if (!sourceInfo) return { success: false, error: `Source ref ${sourceRef} not found` };
  if (!targetInfo) return { success: false, error: `Target ref ${targetRef} not found` };

  try {
    const source = _buildLocator(sourceInfo);
    const target = _buildLocator(targetInfo);
    if (!source || !target) {
      return { success: false, error: 'Could not build locators for drag' };
    }

    await source.dragTo(target, { timeout: config.actionTimeout });
    await activePage.waitForTimeout(500);

    return { success: true, sourceRef, targetRef };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ==================== ENVIRONMENT SPOOFING ====================

/**
 * Emulate a device (uses Playwright device descriptors).
 * @param {string} deviceName - e.g. 'iPhone 14', 'Pixel 7', 'iPad Pro 11'
 * @returns {Promise<Object>}
 */
async function setDevice(deviceName) {
  // Device emulation requires recreating the context, which we can't do
  // with a persistent context. Instead, set the viewport + user agent.
  await ensureRunning();

  try {
    const { devices } = require('playwright');
    const device = devices[deviceName];
    if (!device) {
      const available = Object.keys(devices).slice(0, 20).join(', ');
      return { success: false, error: `Unknown device "${deviceName}". Available: ${available}...` };
    }

    config.viewport = device.viewport;
    config.userAgent = device.userAgent;
    await activePage.setViewportSize(device.viewport);

    // User agent change requires evaluate since persistent context
    // doesn't support setExtraHTTPHeaders for UA dynamically
    log.info('browser-automation', `Device emulation: ${deviceName}`, device.viewport);
    return { success: true, device: deviceName, viewport: device.viewport };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Set geolocation.
 * @param {number} latitude
 * @param {number} longitude
 * @param {number} [accuracy=100]
 * @returns {Promise<Object>}
 */
async function setGeolocation(latitude, longitude, accuracy = 100) {
  await ensureRunning();

  try {
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude, longitude, accuracy });
    return { success: true, latitude, longitude };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Clear geolocation override.
 * @returns {Promise<Object>}
 */
async function clearGeolocation() {
  await ensureRunning();
  try {
    await context.setGeolocation(null);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Set timezone.
 * Note: Requires browser restart for persistent contexts.
 * For the current page, we override via JS.
 * @param {string} timezoneId - e.g. 'America/New_York', 'Europe/London'
 * @returns {Promise<Object>}
 */
async function setTimezone(timezoneId) {
  await ensureRunning();
  try {
    // Override Intl.DateTimeFormat for current page
    await activePage.evaluate((tz) => {
      const origDTF = Intl.DateTimeFormat;
      Intl.DateTimeFormat = function (locale, options) {
        return new origDTF(locale, { ...options, timeZone: tz });
      };
      Intl.DateTimeFormat.prototype = origDTF.prototype;
      window.__overriddenTimezone = tz;
    }, timezoneId);
    return { success: true, timezone: timezoneId };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Set locale.
 * @param {string} locale - e.g. 'en-US', 'fr-FR', 'ja-JP'
 * @returns {Promise<Object>}
 */
async function setLocale(locale) {
  await ensureRunning();
  try {
    await activePage.evaluate((loc) => {
      Object.defineProperty(navigator, 'language', { value: loc, configurable: true });
      Object.defineProperty(navigator, 'languages', { value: [loc], configurable: true });
    }, locale);
    return { success: true, locale };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Set offline mode.
 * @param {boolean} offline
 * @returns {Promise<Object>}
 */
async function setOffline(offline) {
  await ensureRunning();
  try {
    await context.setOffline(offline);
    return { success: true, offline };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Set extra HTTP headers for all requests.
 * @param {Object} headers - { 'X-Custom': 'value', ... }
 * @returns {Promise<Object>}
 */
async function setExtraHeaders(headers) {
  await ensureRunning();
  try {
    await activePage.setExtraHTTPHeaders(headers);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Set HTTP basic auth credentials.
 * @param {string} username
 * @param {string} password
 * @returns {Promise<Object>}
 */
async function setCredentials(username, password) {
  await ensureRunning();
  try {
    await context.setHTTPCredentials(username && password ? { username, password } : null);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Set media features (color scheme preference).
 * @param {'dark'|'light'|'no-preference'|null} colorScheme
 * @returns {Promise<Object>}
 */
async function setMedia(colorScheme) {
  await ensureRunning();
  try {
    await activePage.emulateMedia({
      colorScheme: colorScheme || null,
    });
    return { success: true, colorScheme };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ==================== TRACE RECORDING ====================

let tracing = false;

/**
 * Start a Playwright trace recording.
 * @param {Object} [opts]
 * @param {boolean} [opts.screenshots=true]
 * @param {boolean} [opts.snapshots=true]
 * @returns {Promise<Object>}
 */
async function traceStart(opts = {}) {
  await ensureRunning();

  if (tracing) {
    return { success: false, error: 'Trace already in progress' };
  }

  try {
    await context.tracing.start({
      screenshots: opts.screenshots !== false,
      snapshots: opts.snapshots !== false,
    });
    tracing = true;
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Stop trace recording and save to file.
 * @param {string} [savePath] - Path to save trace zip
 * @returns {Promise<Object>}
 */
async function traceStop(savePath) {
  await ensureRunning();

  if (!tracing) {
    return { success: false, error: 'No trace in progress' };
  }

  try {
    const tracePath = savePath || path.join(downloadDir, `trace-${Date.now()}.zip`);

    const fs = require('fs').promises;
    await fs.mkdir(path.dirname(tracePath), { recursive: true });

    await context.tracing.stop({ path: tracePath });
    tracing = false;

    log.info('browser-automation', `Trace saved: ${tracePath}`);
    return { success: true, path: tracePath };
  } catch (error) {
    tracing = false;
    return { success: false, error: error.message };
  }
}

// ==================== ELEMENT HIGHLIGHT ====================

/**
 * Highlight an element on the page by ref (visual debugging).
 * Draws a red outline around the element for 3 seconds.
 * @param {number} ref
 * @param {Object} [opts]
 * @param {string} [opts.color='red']
 * @param {number} [opts.duration=3000] - ms
 * @returns {Promise<Object>}
 */
async function highlight(ref, opts = {}) {
  await ensureRunning();
  resetIdleTimer();

  const refInfo = lastRefMap.get(ref);
  if (!refInfo) {
    return { success: false, error: `Ref ${ref} not found` };
  }

  try {
    const locator = _buildLocator(refInfo);
    if (!locator) {
      return { success: false, error: `Could not build locator for ref ${ref}` };
    }

    const color = opts.color || 'red';
    const duration = opts.duration || 3000;

    await locator.evaluate(
      (el, { color, duration }) => {
        const prev = el.style.outline;
        const prevTransition = el.style.transition;
        el.style.outline = `3px solid ${color}`;
        el.style.outlineOffset = '2px';
        el.style.transition = 'outline 0.2s ease';
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => {
          el.style.outline = prev;
          el.style.transition = prevTransition;
        }, duration);
      },
      { color, duration }
    );

    return { success: true, ref };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ==================== ENHANCED WAIT ====================

/**
 * Wait for a JavaScript predicate to return true.
 * @param {string} expression - JS expression that returns boolean
 * @param {number} [timeout=10000]
 * @returns {Promise<Object>}
 */
async function waitForFunction(expression, timeout = 10000) {
  await ensureRunning();
  resetIdleTimer();

  try {
    await activePage.waitForFunction(expression, null, { timeout });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ==================== EXPORTS ====================

module.exports = {
  // Lifecycle
  start,
  stop,
  status,
  configure,
  getConfig,

  // Navigation
  navigate,

  // Snapshot & refs
  snapshot,

  // Actions
  act,
  scroll,
  drag,

  // Screenshots
  screenshot,
  screenshotElement,

  // Data extraction
  evaluate,
  extractText,
  extractLinks,

  // Wait
  waitFor,
  waitForFunction,

  // Tab management
  tabs,
  openTab,
  closeTab,
  focusTab,

  // Cookies
  cookies,
  setCookie,
  clearCookies,

  // Storage
  storageGet,
  storageSet,
  storageClear,

  // Dialogs
  handleDialog,
  getLastDialog,

  // File upload
  upload,
  uploadViaChooser,

  // Download
  download,
  getDownloadDir,

  // Network inspection
  networkStart,
  networkStop,
  getConsole,
  getErrors,
  getRequests,
  getResponseBody,

  // Environment
  setViewport,
  setDevice,
  setGeolocation,
  clearGeolocation,
  setTimezone,
  setLocale,
  setOffline,
  setExtraHeaders,
  setCredentials,
  setMedia,

  // Debug
  traceStart,
  traceStop,
  highlight,

  // PDF
  pdf,
};
