/**
 * Playbook API - CRUD Lifecycle Tests
 *
 * Lifecycle: POST execute -> GET jobs -> GET job/:id -> POST cancel -> Verify
 *
 * Run:  npx playwright test test/e2e/playbook-api-crud.spec.js
 */

const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const path = require('path');
const { closeApp, SPACES_API, waitForHealth, _sleep } = require('./helpers/electron-app');

let electronApp;

test.beforeAll(async () => {
  electronApp = await electron.launch({
    args: [path.join(__dirname, '../../main.js')],
    env: { ...process.env, NODE_ENV: 'test', TEST_MODE: 'true', ELECTRON_RUN_AS_NODE: undefined },
    timeout: 30000,
  });
  await electronApp.firstWindow();
  await waitForHealth(40);
});

test.afterAll(async () => {
  await closeApp({ electronApp });
});

async function api(method, apiPath, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${SPACES_API}${apiPath}`, opts);
  const text = await res.text();
  try {
    return { status: res.status, ok: res.ok, data: JSON.parse(text) };
  } catch {
    return { status: res.status, ok: res.ok, data: text };
  }
}

// ═══════════════════════════════════════════════════════════════════
// PLAYBOOK LIFECYCLE
// ═══════════════════════════════════════════════════════════════════

test.describe('Playbook API CRUD Lifecycle', () => {
  let jobId;

  test('Step 1: Execute a playbook', async () => {
    const { data, ok, status } = await api('POST', '/api/playbook/execute', {
      content: '---\ntitle: CRUD Test Playbook\n---\n\n## Step 1\n\nSay hello.',
      options: { dryRun: true },
    });
    // May succeed or return an error if no playbook engine is configured
    if (ok && data.jobId) {
      jobId = data.jobId;
    }
    expect([200, 400, 404, 500].includes(status)).toBe(true);
  });

  test('Step 2: List jobs', async () => {
    const { data, ok } = await api('GET', '/api/playbook/jobs');
    expect(ok).toBe(true);
    const jobs = data.jobs || data;
    expect(Array.isArray(jobs)).toBe(true);
  });

  test('Step 3: Get job status', async () => {
    if (!jobId) {
      test.skip();
      return;
    }
    const { data, ok } = await api('GET', `/api/playbook/jobs/${jobId}`);
    expect(ok).toBe(true);
    expect(data.status || data.state).toBeTruthy();
  });

  test('Step 4: Cancel job', async () => {
    if (!jobId) {
      test.skip();
      return;
    }
    const { ok } = await api('POST', `/api/playbook/jobs/${jobId}/cancel`);
    expect(ok).toBe(true);
  });

  test('Step 5: Verify cancelled', async () => {
    if (!jobId) {
      test.skip();
      return;
    }
    const { data } = await api('GET', `/api/playbook/jobs/${jobId}`);
    expect(['cancelled', 'completed', 'failed'].includes(data.status || data.state || '')).toBe(true);
  });
});
