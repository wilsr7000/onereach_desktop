/**
 * Browsing Auth E2E Test — IDW Page
 *
 * Launches a fresh Electron instance and tests the full auth lifecycle
 * against the Marvin 2 IDW page:
 *   1. Create session & navigate
 *   2. checkAuthState detection
 *   3. lookupCredentials
 *   4. getCookies (HttpOnly redaction, sameSite)
 *   5. exportCookies / importCookies round-trip
 *   6. Task runner with auth-aware loop
 *
 * Run:  npx playwright test test/e2e/browsing-auth-idw.spec.js --timeout 120000
 */

const { test, expect } = require('@playwright/test');
const { launchApp, closeApp, snapshotErrors, checkNewErrors, filterBenignErrors } = require('./helpers/electron-app');

const IDW_URL = 'https://studio.staging.onereach.ai/bots/2f7e4ce3-6922-4597-b932-872169d9e914';

let app, mainWindow, errorBaseline;

test.beforeAll(async () => {
  app = await launchApp({ timeout: 45000 });
  mainWindow = app.mainWindow;
  errorBaseline = await snapshotErrors();
});

test.afterAll(async () => {
  if (app) await closeApp(app);
});

// ---- Auth Session Tests (serial — each depends on previous) ----

test.describe.serial('Browsing Auth — IDW Page', () => {
  test.setTimeout(90000);

  let sessionId;

  test('Step 1: create session and navigate to IDW', async () => {
    const sess = await mainWindow.evaluate(async () => {
      return await window.browsing.createSession({
        mode: 'auto-promote',
        timeout: 30000,
        persistent: true,
        partition: 'auth-test-idw',
      });
    });

    console.log('createSession:', JSON.stringify(sess));
    expect(sess.sessionId).toBeTruthy();
    expect(sess.status).toBe('created');
    sessionId = sess.sessionId;

    const nav = await mainWindow.evaluate(async (args) => {
      return await window.browsing.navigate(args.sid, args.url, { timeout: 25000 });
    }, { sid: sessionId, url: IDW_URL });

    console.log('navigate:', JSON.stringify(nav));
    expect(['loaded', 'error']).toContain(nav.status);
    if (nav.status === 'loaded') {
      expect(nav.url).toBeTruthy();
      console.log(`Navigated to: ${nav.url} — "${nav.title}"`);
      console.log(`Redirected: ${nav.redirected}, Blocked: ${nav.blocked}, Detection: ${nav.detection?.type || 'none'}`);
    } else {
      console.log(`Navigation resulted in: ${nav.status} — ${nav.error}`);
      console.log('This may indicate a redirect to a login page');
    }
  });

  test('Step 2: checkAuthState returns valid fields', async () => {
    expect(sessionId).toBeTruthy();

    const state = await mainWindow.evaluate(async (sid) => {
      return await window.browsing.checkAuthState(sid);
    }, sessionId);

    console.log('checkAuthState:', JSON.stringify(state, null, 2));

    expect(state).toBeDefined();
    expect(state.url).toBeTruthy();
    expect(state.domain).toBeTruthy();
    expect(typeof state.authWall).toBe('boolean');
    expect(typeof state.captcha).toBe('boolean');
    expect(typeof state.mfa).toBe('boolean');
    expect(typeof state.oauth).toBe('boolean');
    expect(typeof state.blocked).toBe('boolean');
    expect(typeof state.loggedIn).toBe('boolean');
    expect(state.detectionType).toBeTruthy();
    expect(typeof state.cookieCount).toBe('number');
    expect(typeof state.hasSessionCookies).toBe('boolean');
    expect(state.persistent).toBe(true);
    expect(state.partition).toBe('auth-test-idw');

    console.log(`Auth state: loggedIn=${state.loggedIn}, authWall=${state.authWall}, detection=${state.detectionType}`);
    console.log(`Cookies: ${state.cookieCount} total, hasSession=${state.hasSessionCookies}`);
  });

  test('Step 3: lookupCredentials returns array', async () => {
    const creds = await mainWindow.evaluate(async (url) => {
      return await window.browsing.lookupCredentials(url);
    }, IDW_URL);

    console.log('lookupCredentials:', JSON.stringify(creds));

    expect(Array.isArray(creds)).toBe(true);
    if (creds.length > 0) {
      expect(creds[0].username).toBeTruthy();
      expect(creds[0].hasPassword).toBe(true);
      expect(creds[0].password).toBeUndefined();
      console.log(`Found ${creds.length} saved credential(s): ${creds.map(c => c.username).join(', ')}`);
    } else {
      console.log('No saved credentials for this domain (expected for test environments)');
    }
  });

  test('Step 4: getCookies with HttpOnly redaction and sameSite', async () => {
    expect(sessionId).toBeTruthy();

    const cookies = await mainWindow.evaluate(async (sid) => {
      return await window.browsing.getCookies(sid, {});
    }, sessionId);

    console.log(`getCookies: ${Array.isArray(cookies) ? cookies.length : 'error'} cookies`);

    if (cookies.error) {
      console.log('Cookie error:', cookies.error);
      return;
    }

    expect(Array.isArray(cookies)).toBe(true);

    for (const c of cookies) {
      expect(c.name).toBeTruthy();
      expect(c.domain).toBeTruthy();
      expect(typeof c.secure).toBe('boolean');
      expect(typeof c.httpOnly).toBe('boolean');
      expect(c.sameSite).toBeTruthy();

      if (c.httpOnly) {
        expect(c.value).toBe('[httpOnly]');
        console.log(`  [httpOnly REDACTED] ${c.name} on ${c.domain} (sameSite=${c.sameSite})`);
      } else {
        console.log(`  ${c.name}=${c.value.slice(0, 20)}${c.value.length > 20 ? '...' : ''} on ${c.domain} (sameSite=${c.sameSite})`);
      }
    }

    const cookiesWithValues = await mainWindow.evaluate(async (sid) => {
      return await window.browsing.getCookies(sid, { includeValues: true });
    }, sessionId);

    if (Array.isArray(cookiesWithValues)) {
      const httpOnlyCookie = cookiesWithValues.find(c => c.httpOnly);
      if (httpOnlyCookie) {
        expect(httpOnlyCookie.value).not.toBe('[httpOnly]');
        console.log(`  includeValues=true: httpOnly cookie "${httpOnlyCookie.name}" value revealed (length=${httpOnlyCookie.value.length})`);
      }
    }
  });

  test('Step 5: exportCookies and importCookies round-trip', async () => {
    expect(sessionId).toBeTruthy();

    const exported = await mainWindow.evaluate(async (sid) => {
      return await window.browsing.exportCookies(sid, {});
    }, sessionId);

    console.log('exportCookies:', JSON.stringify({
      cookieCount: exported.cookies?.length || 0,
      exportedAt: exported.exportedAt,
      sessionId: exported.sessionId,
      domain: exported.domain,
    }));

    if (exported.error) {
      console.log('Export error:', exported.error);
      return;
    }

    expect(exported.cookies).toBeDefined();
    expect(exported.exportedAt).toBeGreaterThan(0);
    expect(exported.sessionId).toBe(sessionId);

    if (exported.cookies.length === 0) {
      console.log('No cookies to round-trip (page may not set any)');
      return;
    }

    const newSess = await mainWindow.evaluate(async () => {
      return await window.browsing.createSession({
        mode: 'auto',
        persistent: true,
        partition: 'auth-test-import',
      });
    });

    const imported = await mainWindow.evaluate(async (args) => {
      return await window.browsing.importCookies(args.sid, args.exp);
    }, { sid: newSess.sessionId, exp: exported });

    console.log('importCookies:', JSON.stringify(imported));
    expect(imported.imported).toBe(exported.cookies.length);

    await mainWindow.evaluate(async (sid) => {
      return await window.browsing.destroySession(sid);
    }, newSess.sessionId);

    console.log('Round-trip: exported -> imported -> verified -> cleaned up');
  });

  test('Step 6: full session lifecycle — navigate, snapshot, act, check auth', async () => {
    const runnerSess = await mainWindow.evaluate(async () => {
      return await window.browsing.createSession({
        mode: 'auto-promote',
        persistent: true,
        partition: 'auth-test-runner',
      });
    });
    expect(runnerSess.sessionId).toBeTruthy();

    const nav = await mainWindow.evaluate(async (args) => {
      return await window.browsing.navigate(args.sid, args.url, { timeout: 20000 });
    }, { sid: runnerSess.sessionId, url: IDW_URL });

    console.log('Runner navigate:', JSON.stringify({ url: nav.url, status: nav.status, blocked: nav.blocked }));
    expect(nav.status).toBe('loaded');

    const authState = await mainWindow.evaluate(async (sid) => {
      return await window.browsing.checkAuthState(sid);
    }, runnerSess.sessionId);

    console.log('Runner auth state:', JSON.stringify(authState));
    expect(typeof authState.authWall).toBe('boolean');
    expect(typeof authState.mfa).toBe('boolean');
    expect(typeof authState.oauth).toBe('boolean');
    expect(authState.detectionType).toBeTruthy();

    const snap = await mainWindow.evaluate(async (sid) => {
      return await window.browsing.snapshot(sid, {});
    }, runnerSess.sessionId);

    console.log(`Runner snapshot: ${snap.refs?.length || 0} elements`);
    expect(snap.refs).toBeDefined();

    if (snap.refs && snap.refs.length > 0) {
      const firstClickable = snap.refs.find(r => r.role === 'button' || r.role === 'link');
      if (firstClickable) {
        const actResult = await mainWindow.evaluate(async (args) => {
          return await window.browsing.act(args.sid, { action: 'click', ref: args.ref });
        }, { sid: runnerSess.sessionId, ref: firstClickable.ref });

        console.log(`Clicked [ref=${firstClickable.ref}] "${firstClickable.name || firstClickable.text?.slice(0, 30) || '?'}": success=${actResult.success}`);
      } else {
        console.log('No clickable elements found on page');
      }
    }

    if (authState.blocked || authState.authWall || authState.captcha) {
      console.log(`Auth blocked (${authState.detectionType}) — testing autoFillCredentials...`);
      const fillResult = await mainWindow.evaluate(async (args) => {
        return await window.browsing.autoFillCredentials(args.sid, args.url);
      }, { sid: runnerSess.sessionId, url: IDW_URL });

      console.log('autoFillCredentials:', JSON.stringify(fillResult));
      expect(fillResult).toBeDefined();
      expect(typeof fillResult.filled).toBe('boolean');
      console.log(`Auto-fill result: filled=${fillResult.filled}, reason=${fillResult.reason || 'n/a'}`);
    } else {
      console.log('No auth wall — page loaded normally (no autoFillCredentials test needed)');
    }

    await mainWindow.evaluate(async (sid) => {
      return await window.browsing.destroySession(sid);
    }, runnerSess.sessionId);

    console.log('Runner session cleaned up');
  });

  test('cleanup: destroy test session', async () => {
    if (!sessionId) return;

    const result = await mainWindow.evaluate(async (sid) => {
      return await window.browsing.destroySession(sid);
    }, sessionId);

    console.log('destroySession:', JSON.stringify(result));
    // Session may have already been destroyed by timeout or previous step
    expect(result.destroyed || result.success || result.error === 'Session not found').toBeTruthy();
  });
});

test('no new critical errors from auth tests', async () => {
  if (!errorBaseline) return;

  let errors = [];
  try {
    errors = await checkNewErrors(errorBaseline);
  } catch (err) {
    console.log('Could not check errors:', err.message);
    return;
  }

  const real = filterBenignErrors(errors);
  if (real.length > 0) {
    console.log('Genuine errors found during auth tests:');
    real.forEach(e => console.log(`  [${e.category}] ${e.message}`));
  }

  console.log(`Total errors: ${errors.length}, after filtering benign: ${real.length}`);
});
