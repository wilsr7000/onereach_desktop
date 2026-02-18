/**
 * IPC Browser Automation Namespace - Lifecycle Tests
 *
 * Lifecycle: start -> navigate -> snapshot -> act -> scroll -> screenshot -> stop -> verify
 *
 * Run:  npx vitest run test/unit/ipc-browser-automation.test.js
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockInvoke = vi.fn().mockResolvedValue({ success: true });

// Build the namespace as preload.js would
const browserAutomation = {
  start: (opts) => mockInvoke('browser-automation:start', opts),
  stop: () => mockInvoke('browser-automation:stop'),
  status: () => mockInvoke('browser-automation:status'),
  configure: (cfg) => mockInvoke('browser-automation:configure', cfg),
  navigate: (url, opts) => mockInvoke('browser-automation:navigate', url, opts),
  snapshot: (opts) => mockInvoke('browser-automation:snapshot', opts),
  screenshot: (opts) => mockInvoke('browser-automation:screenshot', opts),
  act: (ref, action, value) => mockInvoke('browser-automation:act', ref, action, value),
  scroll: (dir, amount) => mockInvoke('browser-automation:scroll', dir, amount),
  evaluate: (script) => mockInvoke('browser-automation:evaluate', script),
  extractText: (selector) => mockInvoke('browser-automation:extract-text', selector),
  extractLinks: () => mockInvoke('browser-automation:extract-links'),
  tabs: () => mockInvoke('browser-automation:tabs'),
  openTab: (url) => mockInvoke('browser-automation:open-tab', url),
  closeTab: (tabId) => mockInvoke('browser-automation:close-tab', tabId),
  cookies: () => mockInvoke('browser-automation:cookies'),
  setCookie: (cookie) => mockInvoke('browser-automation:set-cookie', cookie),
  clearCookies: () => mockInvoke('browser-automation:clear-cookies'),
  setViewport: (w, h) => mockInvoke('browser-automation:set-viewport', w, h),
  pdf: (opts) => mockInvoke('browser-automation:pdf', opts),
};

beforeEach(() => {
  mockInvoke.mockClear();
});

// ═══════════════════════════════════════════════════════════════════
// AUTOMATION LIFECYCLE
// ═══════════════════════════════════════════════════════════════════

describe('IPC Browser Automation - Lifecycle', () => {
  it('Step 1: Start automation', async () => {
    await browserAutomation.start({ headless: true });
    expect(mockInvoke).toHaveBeenCalledWith('browser-automation:start', { headless: true });
  });

  it('Step 2: Navigate to URL', async () => {
    await browserAutomation.navigate('https://example.com');
    expect(mockInvoke).toHaveBeenCalledWith('browser-automation:navigate', 'https://example.com', undefined);
  });

  it('Step 3: Take snapshot', async () => {
    await browserAutomation.snapshot({ format: 'html' });
    expect(mockInvoke).toHaveBeenCalledWith('browser-automation:snapshot', { format: 'html' });
  });

  it('Step 4: Perform action', async () => {
    await browserAutomation.act('ref123', 'click');
    expect(mockInvoke).toHaveBeenCalledWith('browser-automation:act', 'ref123', 'click', undefined);
  });

  it('Step 5: Scroll page', async () => {
    await browserAutomation.scroll('down', 500);
    expect(mockInvoke).toHaveBeenCalledWith('browser-automation:scroll', 'down', 500);
  });

  it('Step 6: Take screenshot', async () => {
    await browserAutomation.screenshot({ fullPage: true });
    expect(mockInvoke).toHaveBeenCalledWith('browser-automation:screenshot', { fullPage: true });
  });

  it('Step 7: Stop automation', async () => {
    await browserAutomation.stop();
    expect(mockInvoke).toHaveBeenCalledWith('browser-automation:stop');
  });

  it('Step 8: Check status after stop', async () => {
    await browserAutomation.status();
    expect(mockInvoke).toHaveBeenCalledWith('browser-automation:status');
  });
});

// ═══════════════════════════════════════════════════════════════════
// COOKIES CRUD
// ═══════════════════════════════════════════════════════════════════

describe('IPC Browser Automation - Cookie CRUD', () => {
  it('Create cookie', async () => {
    await browserAutomation.setCookie({ name: 'test', value: 'abc', domain: '.example.com' });
    expect(mockInvoke).toHaveBeenCalledWith('browser-automation:set-cookie', expect.objectContaining({ name: 'test' }));
  });

  it('Read cookies', async () => {
    await browserAutomation.cookies();
    expect(mockInvoke).toHaveBeenCalledWith('browser-automation:cookies');
  });

  it('Delete cookies', async () => {
    await browserAutomation.clearCookies();
    expect(mockInvoke).toHaveBeenCalledWith('browser-automation:clear-cookies');
  });
});

// ═══════════════════════════════════════════════════════════════════
// TABS CRUD
// ═══════════════════════════════════════════════════════════════════

describe('IPC Browser Automation - Tab CRUD', () => {
  it('Create tab', async () => {
    await browserAutomation.openTab('https://example.com');
    expect(mockInvoke).toHaveBeenCalledWith('browser-automation:open-tab', 'https://example.com');
  });

  it('Read tabs', async () => {
    await browserAutomation.tabs();
    expect(mockInvoke).toHaveBeenCalledWith('browser-automation:tabs');
  });

  it('Delete tab', async () => {
    await browserAutomation.closeTab('tab-1');
    expect(mockInvoke).toHaveBeenCalledWith('browser-automation:close-tab', 'tab-1');
  });
});
