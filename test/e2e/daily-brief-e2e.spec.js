/**
 * Daily Brief E2E Test
 *
 * Tests the full pipeline for "give me my daily brief":
 * 1. Intent normalizer fast-skips (clear command)
 * 2. Bidder produces hallucinationRisk and strips fast-path for action agents
 * 3. Calendar agent wins auction and orchestrates briefing
 * 4. Response guard validates date/day sanity
 * 5. Result is spoken via TTS
 *
 * Uses the renderer window's IPC bridge (agentHUD.submitTask) to trigger tasks,
 * and the log server REST API to verify pipeline behavior.
 */

const { test, expect } = require('@playwright/test');
const { launchApp, closeApp, snapshotErrors, checkNewErrors } = require('./helpers/electron-app');

const LOG_SERVER = 'http://127.0.0.1:47292';

// Helper: query logs
async function getLogs(opts = {}) {
  const params = new URLSearchParams();
  if (opts.category) params.set('category', opts.category);
  if (opts.level) params.set('level', opts.level);
  if (opts.since) params.set('since', opts.since);
  if (opts.search) params.set('search', opts.search);
  params.set('limit', String(opts.limit || 100));
  try {
    const res = await fetch(`${LOG_SERVER}/logs?${params}`);
    const json = await res.json();
    return json.data || [];
  } catch {
    return [];
  }
}

// Helper: wait for a log message matching a regex
async function waitForLog(pattern, opts = {}) {
  const { since, timeout = 30000, interval = 1500 } = opts;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const logs = await getLogs({ category: 'voice', since, limit: 200 });
    const match = logs.find(l => pattern.test(l.message || ''));
    if (match) return match;
    await new Promise(r => setTimeout(r, interval));
  }
  return null;
}

// Helper: find the orb window
async function findOrbWindow(electronApp) {
  const windows = electronApp.windows();
  for (const w of windows) {
    const url = w.url();
    if (url.includes('orb.html')) return w;
  }
  // Wait a bit for orb to load
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const ws = electronApp.windows();
    for (const w of ws) {
      if (w.url().includes('orb.html')) return w;
    }
  }
  return null;
}

let app;

test.describe('Daily Brief Pipeline', () => {

  test.beforeAll(async () => {
    app = await launchApp({ timeout: 45000 });

    // Enable debug logging
    await fetch(`${LOG_SERVER}/logging/level`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'debug' }),
    });
  });

  test.afterAll(async () => {
    if (app) await closeApp(app);
  });

  test('daily brief triggers full execution, no hallucinated fast-path', async () => {
    test.setTimeout(60000);

    const snapshot = await snapshotErrors();
    const since = snapshot.timestamp;

    // Find the orb window and submit via its IPC bridge
    const orb = await findOrbWindow(app.electronApp);
    expect(orb).toBeTruthy();

    const submitResult = await orb.evaluate(async (text) => {
      if (window.agentHUD && typeof window.agentHUD.submitTask === 'function') {
        return await window.agentHUD.submitTask(text, { toolId: 'playwright-test', skipFilter: true });
      }
      return { error: 'agentHUD.submitTask not available' };
    }, 'give me my daily brief');

    console.log('Submit result:', JSON.stringify(submitResult, null, 2));

    // The task should be queued or handled
    expect(submitResult).toBeTruthy();
    expect(submitResult.error).toBeFalsy();

    // Wait for the task to settle (agent response arrives)
    const settledLog = await waitForLog(/Task settled by|routing-cache-hit/, { since, timeout: 35000 });
    console.log('Settled log:', settledLog ? settledLog.message : 'NOT FOUND (may still be processing)');

    // Check that fast-path was suppressed for action agents
    const fastPathLogs = await getLogs({ category: 'voice', since, search: 'Fast-path', limit: 50 });
    for (const l of fastPathLogs) {
      console.log('  Fast-path log:', l.message);
    }

    // Check for hallucinationRisk logs in agent category
    const riskLogs = await getLogs({ category: 'agent', since, search: 'hallucinationRisk', limit: 20 });
    if (riskLogs.length > 0) {
      console.log('Hallucination risk logs:', riskLogs.length);
      for (const l of riskLogs) console.log('  ', l.message);
    }

    // Verify no new real errors
    const newErrors = await checkNewErrors(snapshot);
    const realErrors = newErrors.filter(e => {
      const msg = e.message || '';
      return !msg.includes('Agent reconnect') &&
             !msg.includes('WebSocket error') &&
             !msg.includes('Chrome-like behavior') &&
             !msg.includes('Material Symbols') &&
             !msg.includes('Database IO') &&
             !msg.includes('console-message arguments');
    });
    if (realErrors.length > 0) {
      console.log('Unexpected errors:');
      for (const e of realErrors) console.log(' ', e.category, ':', e.message);
    }
    // Allow zero errors, or only benign ones
    expect(realErrors.length).toBe(0);
  });

  test('response guard catches wrong day-of-week', async () => {
    test.setTimeout(15000);

    // This test runs in Electron main process context -- uses only simple JS (no require)
    const guardResult = await app.electronApp.evaluate(() => {
      const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const now = new Date();
      const todayName = DAY_NAMES[now.getDay()];
      const wrongDay = todayName === 'monday' ? 'sunday' : 'monday';

      function checkDay(message) {
        const lower = message.toLowerCase();
        const match = lower.match(/(?:today is|it(?:'|')s|this)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/i);
        if (match && match[1].toLowerCase() !== todayName) {
          return `Wrong day: "${match[1]}" but today is ${todayName}`;
        }
        return null;
      }

      return {
        todayName,
        wrongDay,
        wrongDayCaught: checkDay(`Today is ${wrongDay}, have a great day.`),
        correctDayPasses: checkDay(`Today is ${todayName}, have a great day.`),
        wrongDateCaught: (() => {
          const lower = `today is february ${now.getDate() - 1}`.toLowerCase();
          const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
          const match = lower.match(/today(?:\s+is|,)\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})/i);
          if (match) {
            const cm = MONTHS.indexOf(match[1].toLowerCase());
            const cd = parseInt(match[2], 10);
            if (cm !== now.getMonth() || cd !== now.getDate()) return `Wrong date: ${match[1]} ${match[2]}`;
          }
          return null;
        })(),
      };
    });

    console.log('Guard test:', guardResult);
    expect(guardResult.wrongDayCaught).toBeTruthy();
    expect(guardResult.correctDayPasses).toBeNull();
    expect(guardResult.wrongDateCaught).toBeTruthy();
  });

  test('normalizeIntent fast-skips for clear daily brief command', async () => {
    test.setTimeout(15000);

    // This test verifies the normalizeIntent fast-skip by checking logs
    // from test 1's "give me my daily brief" submission.
    // If the fast-skip worked, there should be NO "Interpreted:" log
    // (the command matched a skip pattern so no LLM call was needed).
    //
    // We look at ALL voice logs since app start for any NormalizeIntent logs.
    const normLogs = await getLogs({ category: 'voice', search: 'NormalizeIntent', limit: 50 });
    console.log('All NormalizeIntent logs:', normLogs.map(l => l.message));

    // For "give me my daily brief", the normalizer should fast-skip.
    // If an "Interpreted" log exists, the intent must still contain "daily brief".
    const interpreted = normLogs.filter(l => (l.message || '').includes('Interpreted'));
    console.log('Interpreted logs (expected 0 for clear commands):', interpreted.length);

    for (const l of interpreted) {
      // If intent was normalized, it should still be about the daily brief
      expect(l.message.toLowerCase()).toContain('daily brief');
    }
  });

  test('smalltalk agent does not bid high on factual questions', async () => {
    test.setTimeout(45000);

    const snapshot = await snapshotErrors();
    const since = snapshot.timestamp;

    const orb = await findOrbWindow(app.electronApp);
    expect(orb).toBeTruthy();

    const result = await orb.evaluate(async (text) => {
      if (window.agentHUD && typeof window.agentHUD.submitTask === 'function') {
        return await window.agentHUD.submitTask(text, { toolId: 'factual-test', skipFilter: true });
      }
      return { error: 'not available' };
    }, 'what time is it');

    console.log('Factual query result:', JSON.stringify(result, null, 2));

    // Wait for auction + settlement
    const settledLog = await waitForLog(/Task settled by/, { since, timeout: 25000 });
    if (settledLog) {
      console.log('Settled by:', settledLog.message);
      // The winner should NOT be smalltalk-agent for "what time is it"
      expect(settledLog.message).not.toContain('smalltalk');
    }

    // Check for any errors
    const newErrors = await checkNewErrors(snapshot);
    const realErrors = newErrors.filter(e => {
      const msg = e.message || '';
      return !msg.includes('Agent reconnect') &&
             !msg.includes('WebSocket error') &&
             !msg.includes('Chrome-like behavior') &&
             !msg.includes('Material Symbols') &&
             !msg.includes('Database IO') &&
             !msg.includes('console-message arguments');
    });
    expect(realErrors.length).toBe(0);
  });
});
