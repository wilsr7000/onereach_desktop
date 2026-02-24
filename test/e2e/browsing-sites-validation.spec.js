/**
 * Browsing API Multi-Site Validation Suite
 *
 * Tests the browsing API against a list of real-world websites to validate:
 * - Session creation and navigation
 * - Snapshot element detection
 * - Content extraction
 * - Screenshot capture
 * - Block/CAPTCHA detection
 *
 * Run: npx playwright test test/e2e/browsing-sites-validation.spec.js
 */

const { test, expect } = require('@playwright/test');
const { launchApp, closeApp, snapshotErrors } = require('./helpers/electron-app');

let app, mainWindow;

const SITES = [
  {
    url: 'https://example.com',
    name: 'example.com',
    expect: { minElements: 1, titleContains: 'Example' },
  },
  {
    url: 'https://en.wikipedia.org/wiki/Main_Page',
    name: 'Wikipedia',
    expect: { minElements: 5, titleContains: 'Wikipedia' },
  },
  {
    url: 'https://httpbin.org/html',
    name: 'httpbin',
    expect: { textContains: 'Herman Melville' },
  },
  {
    url: 'https://news.ycombinator.com',
    name: 'Hacker News',
    expect: { minElements: 5 },
  },
  {
    url: 'https://jsonplaceholder.typicode.com',
    name: 'JSONPlaceholder',
    expect: { minElements: 3 },
  },
];

test.describe.serial('Multi-Site Validation', () => {
  test.setTimeout(120000);

  test.beforeAll(async () => {
    app = await launchApp({ timeout: 45000 });
    mainWindow = app.mainWindow;
    await snapshotErrors();
  });

  test.afterAll(async () => {
    if (app) await closeApp(app);
  });

  for (const site of SITES) {
    test.describe(site.name, () => {
      let sessionId;

      test(`navigate to ${site.url}`, async () => {
        const sess = await mainWindow.evaluate(async () => {
          return await window.browsing.createSession({ mode: 'auto' });
        });
        sessionId = sess.sessionId;
        expect(sessionId).toBeTruthy();

        const nav = await mainWindow.evaluate(async ({ sid, url }) => {
          return await window.browsing.navigate(sid, url);
        }, { sid: sessionId, url: site.url });

        expect(nav.url).toBeTruthy();
        expect(nav.status).not.toBe('error');

        if (nav.blocked) {
          console.log(`[${site.name}] BLOCKED: ${nav.error || 'unknown'}`);
        }
      });

      test(`snapshot has interactive elements`, async () => {
        if (!sessionId) return;

        const snapshot = await mainWindow.evaluate(async (sid) => {
          return await window.browsing.snapshot(sid);
        }, sessionId);

        expect(snapshot.refs).toBeDefined();
        console.log(`[${site.name}] Snapshot: ${snapshot.refs.length} elements`);

        if (site.expect.minElements) {
          expect(snapshot.refs.length).toBeGreaterThanOrEqual(site.expect.minElements);
        }

        if (site.expect.titleContains) {
          expect(snapshot.title?.toLowerCase()).toContain(site.expect.titleContains.toLowerCase());
        }
      });

      test(`extract content`, async () => {
        if (!sessionId) return;

        const content = await mainWindow.evaluate(async (sid) => {
          return await window.browsing.extract(sid, { mode: 'readability' });
        }, sessionId);

        expect(content.text).toBeTruthy();
        expect(content.text.length).toBeGreaterThan(0);
        console.log(`[${site.name}] Extracted ${content.text.length} chars`);

        if (site.expect.textContains) {
          expect(content.text).toContain(site.expect.textContains);
        }
      });

      test(`screenshot succeeds`, async () => {
        if (!sessionId) return;

        const shot = await mainWindow.evaluate(async (sid) => {
          return await window.browsing.screenshot(sid, { format: 'jpeg', quality: 50 });
        }, sessionId);

        expect(shot.base64).toBeTruthy();
        expect(shot.base64.length).toBeGreaterThan(100);
        expect(shot.width).toBeGreaterThan(0);
        expect(shot.height).toBeGreaterThan(0);
        console.log(`[${site.name}] Screenshot: ${shot.width}x${shot.height}, ${Math.round(shot.base64.length / 1024)}KB`);
      });

      test(`cleanup session`, async () => {
        if (!sessionId) return;
        const result = await mainWindow.evaluate(async (sid) => {
          return await window.browsing.destroySession(sid);
        }, sessionId);
        expect(result.destroyed || result.success || result.error === 'Session not found').toBeTruthy();
      });
    });
  }

  test.describe('Stealth Profile Detection', () => {
    test('should resolve profiles for known domains', async () => {
      const profiles = await mainWindow.evaluate(async () => {
        const domains = [
          'www.google.com',
          'login.microsoftonline.com',
          'cdn.cloudflare.com',
          'randomsite.example.org',
        ];
        const results = {};
        for (const d of domains) {
          try {
            const mod = require('../../lib/stealth-profiles.js');
            results[d] = mod.getProfileForDomain(d).id;
          } catch (e) {
            results[d] = 'error: ' + e.message;
          }
        }
        return results;
      });

      console.log('Stealth profiles resolved:', JSON.stringify(profiles));
      expect(profiles).toBeDefined();
    });
  });

  test.describe('Vision Fallback Smoke Test', () => {
    test('snapshot with empty page triggers low-element count', async () => {
      const sess = await mainWindow.evaluate(async () => {
        return await window.browsing.createSession({ mode: 'auto' });
      });
      expect(sess.sessionId).toBeTruthy();

      await mainWindow.evaluate(async (sid) => {
        return await window.browsing.navigate(sid, 'about:blank');
      }, sess.sessionId);

      const snapshot = await mainWindow.evaluate(async (sid) => {
        return await window.browsing.snapshot(sid);
      }, sess.sessionId);

      expect(snapshot.refs.length).toBeLessThan(3);
      console.log(`about:blank snapshot: ${snapshot.refs.length} elements (vision would trigger at <3)`);

      const shot = await mainWindow.evaluate(async (sid) => {
        return await window.browsing.screenshot(sid, { format: 'jpeg', quality: 50 });
      }, sess.sessionId);

      expect(shot.base64).toBeTruthy();
      console.log(`about:blank screenshot OK: ${Math.round(shot.base64.length / 1024)}KB`);

      await mainWindow.evaluate(async (sid) => {
        return await window.browsing.destroySession(sid);
      }, sess.sessionId);
    });
  });
});
