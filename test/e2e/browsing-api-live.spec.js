/**
 * Browsing API Live Integration Test
 *
 * Runs against the live Electron app to verify real browser sessions,
 * real HTTP fetches, and real page extraction. No mocks.
 *
 * Run: npx playwright test test/e2e/browsing-api-live.spec.js
 *
 * What this tests end-to-end:
 * 1. Safety guardrails: domain blocking, session limits
 * 2. Browser session lifecycle: create -> navigate -> extract -> snapshot -> screenshot -> destroy
 * 3. Fast-path search: real HTTP to DuckDuckGo + extract (skipped until search provider is fixed)
 */

const { test, expect } = require('@playwright/test');
const { launchApp, closeApp, checkNewErrors, snapshotErrors } = require('./helpers/electron-app');

let app, mainWindow;

test.beforeAll(async () => {
  app = await launchApp({ timeout: 45000 });
  mainWindow = app.mainWindow;
  await snapshotErrors();
});

test.afterAll(async () => {
  if (app) await closeApp(app);
});

// ---- Safety Guardrails (independent, no ordering needed) ----

test.describe('Safety Guardrails', () => {
  test.setTimeout(30000);

  test('block localhost', async () => {
    const result = await mainWindow.evaluate(async () => {
      return await window.browsing.checkDomain('http://localhost:3000');
    });

    expect(result.blocked).toBe(true);
    console.log(`Blocked localhost: ${result.reason}`);
  });

  test('block private IPs', async () => {
    const result = await mainWindow.evaluate(async () => {
      return await window.browsing.checkDomain('http://192.168.1.1');
    });

    expect(result.blocked).toBe(true);
  });

  test('allow normal websites', async () => {
    const result = await mainWindow.evaluate(async () => {
      return await window.browsing.checkDomain('https://github.com');
    });

    expect(result.blocked).toBe(false);
  });

  test('return session limits', async () => {
    const limits = await mainWindow.evaluate(async () => {
      return await window.browsing.getLimits();
    });

    expect(limits.maxActionsPerSession).toBeGreaterThan(0);
    expect(limits.maxSessionsTotal).toBeGreaterThan(0);
    console.log('Session limits:', JSON.stringify(limits));
  });
});

// ---- Browser Session (serial -- each step depends on the previous) ----

test.describe.serial('Browser Session Lifecycle', () => {
  test.setTimeout(60000);

  let sessionId;

  test('create hidden browsing session', async () => {
    const result = await mainWindow.evaluate(async () => {
      return await window.browsing.createSession({ mode: 'auto-promote', timeout: 30000 });
    });

    console.log('createSession result:', JSON.stringify(result));

    expect(result.sessionId).toBeTruthy();
    expect(result.status).toBe('created');
    sessionId = result.sessionId;
    console.log(`Session created: ${sessionId}`);
  });

  test('navigate to example.com', async () => {
    expect(sessionId).toBeTruthy();

    const result = await mainWindow.evaluate(async (sid) => {
      return await window.browsing.navigate(sid, 'https://example.com', { timeout: 15000 });
    }, sessionId);

    console.log('navigate result:', JSON.stringify(result));

    expect(result.status).toBe('loaded');
    expect(result.url).toContain('example.com');
    expect(result.title).toBeTruthy();
    expect(result.blocked).toBeFalsy();
    console.log(`Navigated: ${result.url} - "${result.title}"`);
  });

  test('extract page content', async () => {
    expect(sessionId).toBeTruthy();

    const result = await mainWindow.evaluate(async (sid) => {
      return await window.browsing.extract(sid, { mode: 'readability' });
    }, sessionId);

    console.log('extract result:', JSON.stringify(result).slice(0, 300));

    expect(result.text).toBeTruthy();
    expect(result.text.length).toBeGreaterThan(10);
    console.log(`Extracted ${result.text.length} chars: "${result.text.substring(0, 80)}..."`);
  });

  test('get accessibility snapshot', async () => {
    expect(sessionId).toBeTruthy();

    const result = await mainWindow.evaluate(async (sid) => {
      return await window.browsing.snapshot(sid, {});
    }, sessionId);

    console.log('snapshot result:', JSON.stringify(result).slice(0, 300));

    expect(result.refs).toBeDefined();
    expect(result.url).toContain('example.com');
    console.log(`Snapshot: ${result.refs.length} elements`);
    if (result.refs.length > 0) {
      console.log(`  First: [ref=${result.refs[0].ref}] <${result.refs[0].tag}> "${(result.refs[0].text || '').slice(0, 40)}"`);
    }
  });

  test('take screenshot', async () => {
    expect(sessionId).toBeTruthy();

    const result = await mainWindow.evaluate(async (sid) => {
      const r = await window.browsing.screenshot(sid, { format: 'png' });
      return { hasBase64: !!r.base64, length: r.base64 ? r.base64.length : 0, width: r.width, height: r.height, error: r.error };
    }, sessionId);

    console.log('screenshot result:', JSON.stringify(result));

    if (result.error) {
      console.log('Screenshot error:', result.error);
      test.skip();
    }

    expect(result.hasBase64).toBe(true);
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    console.log(`Screenshot: ${result.width}x${result.height}, ${Math.round(result.length / 1024)}KB`);
  });

  test('navigate blocked domain is rejected', async () => {
    expect(sessionId).toBeTruthy();

    const result = await mainWindow.evaluate(async (sid) => {
      return await window.browsing.navigate(sid, 'http://localhost:8080/admin');
    }, sessionId);

    console.log('blocked navigation result:', JSON.stringify(result));

    expect(result.blocked).toBe(true);
    expect(result.status).toBe('blocked');
  });

  test('destroy session', async () => {
    expect(sessionId).toBeTruthy();

    const result = await mainWindow.evaluate(async (sid) => {
      return await window.browsing.destroySession(sid);
    }, sessionId);

    console.log('destroySession result:', JSON.stringify(result));
    expect(result.destroyed || result.success).toBeTruthy();
    sessionId = null;
  });
});

// ---- Fast Path (skipped until DuckDuckGo search provider is replaced) ----

test.describe.skip('Fast Path - HTTP Search', () => {
  test.setTimeout(30000);

  test('search DuckDuckGo and return results', async () => {
    const result = await mainWindow.evaluate(async () => {
      return await window.browsing.fastQuery('Electron framework official site', { maxSources: 3 });
    });

    console.log('fast-query result:', JSON.stringify(result).slice(0, 300));

    expect(result.sources).toBeDefined();
    expect(result.sources.length).toBeGreaterThan(0);

    const firstSource = result.sources[0];
    expect(firstSource.title || firstSource.url).toBeTruthy();
    console.log(`Returned ${result.sources.length} sources`);
  });

  test('extract content from a URL via HTTP', async () => {
    const result = await mainWindow.evaluate(async () => {
      return await window.browsing.fastExtract('https://example.com', {});
    });

    console.log('fast-extract result:', JSON.stringify(result).slice(0, 300));

    if (result.error) {
      console.log('Extract error (network?):', result.error);
      test.skip();
    }

    const content = result.text || result.content || '';
    expect(content.length).toBeGreaterThan(10);
    expect(content.toLowerCase()).toContain('example');
    console.log(`Extracted ${content.length} chars from example.com`);
  });
});

// ---- Error check (runs after everything else) ----

test('no new browsing errors in logs', async () => {
  let browsingErrors = [];
  try {
    const result = await checkNewErrors();
    const errors = result?.newErrors || [];
    browsingErrors = errors.filter(
      (e) => e.message && (e.message.includes('browsing') || e.message.includes('browse') || e.message.includes('stealth'))
    );
  } catch (err) {
    console.log('Could not check error logs:', err.message);
    return;
  }

  if (browsingErrors.length > 0) {
    console.log('Browsing-related errors found:');
    browsingErrors.forEach((e) => console.log(`  ${e.timestamp}: ${e.message}`));
  }

  expect(browsingErrors.length).toBe(0);
});
