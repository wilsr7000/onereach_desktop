/**
 * Playbook Execution API Tests
 *
 * Tests the REST API surface for the playbook executor, including the UXmag
 * email use case as a real-world integration scenario.
 *
 * Two modes:
 *   Mode A: Automated -- creates test space programmatically
 *   Mode B: Manual    -- uses PLAYBOOK_SPACE_ID env var for pre-existing space
 *
 * Run:  npm run test:playbook
 *       PLAYBOOK_SPACE_ID=abc123 npx playwright test test/e2e/playbook-api.spec.js
 */

const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const {
  closeApp,
  waitForHealth,
  snapshotErrors,
  checkNewErrors,
  filterBenignErrors,
  checkSpacesApi,
  createSpace,
  deleteSpace,
  addItem,
  getItems,
  executePlaybook,
  getPlaybookJob,
  respondToPlaybook,
  cancelPlaybookJob,
  listPlaybooks,
  setLogLevel,
  sleep,
  SPACES_API,
} = require('./helpers/electron-app');

// Load playbook fixture
const UXMAG_PLAYBOOK = fs.readFileSync(path.join(__dirname, '../fixtures/uxmag-playbook.md'), 'utf8');

let electronApp;
let testSpaceId;
let testPlaybookId;
let testJobId;
const manualSpaceId = process.env.PLAYBOOK_SPACE_ID;

test.describe('Playbook Execution API', () => {
  test.setTimeout(180000); // 3 min per test for playbook execution

  test.beforeAll(async () => {
    electronApp = await electron.launch({
      args: [path.join(__dirname, '../../main.js')],
      env: { ...process.env, NODE_ENV: 'test', TEST_MODE: 'true' },
      timeout: 30000,
    });
    await electronApp.firstWindow();
    await waitForHealth(40);
    await setLogLevel('debug');
  });

  test.afterAll(async () => {
    // Cleanup test space if we created it
    if (testSpaceId && !manualSpaceId) {
      try {
        await deleteSpace(testSpaceId);
      } catch (_) {
        /* no-op */
      }
    }
    try {
      await setLogLevel('info');
    } catch (_) {
      /* no-op */
    }
    await closeApp({ electronApp });
  });

  // ---- Setup ----

  test('Spaces API is reachable', async () => {
    const alive = await checkSpacesApi();
    expect(alive).toBe(true);
  });

  test('create test space with playbook and assets', async () => {
    if (manualSpaceId) {
      testSpaceId = manualSpaceId;
      return;
    }

    const snap = await snapshotErrors();

    // 1. Create space
    const space = await createSpace(`UXmag Email Test ${Date.now()}`, 'Playbook API test');
    testSpaceId = space.id || space.spaceId;
    expect(testSpaceId).toBeTruthy();

    // 2. Add URL item (article link)
    await addItem(testSpaceId, {
      type: 'url',
      content: 'https://uxmag.com/articles/the-future-of-ux-research',
      metadata: { title: 'Sample UX Article' },
    });

    // 3. Add text item (author bio)
    await addItem(testSpaceId, {
      type: 'text',
      content:
        '# Jane Smith\n\nJane Smith is a UX researcher with 10 years of experience in human-computer interaction. She holds a PhD from Stanford and has published in ACM CHI, DIS, and UX Magazine. Her work focuses on inclusive design and accessibility.',
      metadata: { title: 'Author Bio - Jane Smith' },
    });

    // 4. Add text item (author email)
    await addItem(testSpaceId, {
      type: 'text',
      content: 'jane.smith@example.com',
      metadata: { title: 'Author Email' },
    });

    // 5. Add playbook
    const playbookRes = await addItem(testSpaceId, {
      type: 'text',
      content: UXMAG_PLAYBOOK,
      metadata: { title: 'UXmag Submission Playbook', tags: ['playbook'] },
      tags: ['playbook'],
    });
    testPlaybookId = playbookRes?.id || playbookRes?.itemId;

    const errors = filterBenignErrors(await checkNewErrors(snap));
    expect(errors).toHaveLength(0);
  });

  // ---- API surface tests ----

  test('GET /api/playbook/spaces/:spaceId/playbooks lists playbooks', async () => {
    const playbooks = await listPlaybooks(testSpaceId);
    expect(playbooks.length).toBeGreaterThanOrEqual(1);
    expect(playbooks[0]).toHaveProperty('title');
    expect(playbooks[0]).toHaveProperty('id');
    // Use the found playbook ID if we didn't get one from creation
    if (!testPlaybookId) {
      testPlaybookId = playbooks[0].id;
    }
  });

  test('POST /api/playbook/execute starts a job', async () => {
    const snap = await snapshotErrors();

    const result = await executePlaybook({
      spaceId: testSpaceId,
      playbookId: testPlaybookId,
      maxTurns: 15,
      maxBudget: 1.5,
    });

    expect(result).toHaveProperty('jobId');
    expect(result.status).toBe('running');
    testJobId = result.jobId;

    const errors = filterBenignErrors(await checkNewErrors(snap));
    // Execution errors are non-fatal for this test (Claude CLI may not be installed)
    if (errors.length > 0) {
      console.log('Execution start errors (may be expected):', JSON.stringify(errors, null, 2));
    }
  });

  test('GET /api/playbook/jobs/:jobId returns job status', async () => {
    if (!testJobId) return;

    const job = await getPlaybookJob(testJobId);
    expect(job.jobId).toBe(testJobId);
    expect(job.spaceId).toBe(testSpaceId);
    expect(['running', 'paused', 'completed', 'failed']).toContain(job.status);
    expect(job).toHaveProperty('progress');
    expect(job).toHaveProperty('pendingQuestions');
    expect(job).toHaveProperty('outputs');
  });

  test('GET /api/playbook/jobs lists all jobs', async () => {
    const res = await fetch(`${SPACES_API}/api/playbook/jobs?spaceId=${testSpaceId}`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data).toHaveProperty('jobs');
    expect(data).toHaveProperty('total');
    expect(data.jobs.length).toBeGreaterThanOrEqual(1);
  });

  test('job completes or fails gracefully', async () => {
    if (!testJobId) return;

    // Poll until completed or failed (timeout: 120s)
    let job;
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      job = await getPlaybookJob(testJobId);

      if (job.status === 'paused' && job.pendingQuestions?.length > 0) {
        // Auto-answer any questions
        const q = job.pendingQuestions[0];
        try {
          await respondToPlaybook(testJobId, q.id, 'Proceed with defaults');
        } catch (_) {
          console.log('Respond failed (may be expected):', _.message);
        }
        continue;
      }

      if (job.status === 'completed' || job.status === 'failed') break;
    }

    // Either completed (Claude CLI available) or failed gracefully (no CLI)
    expect(['completed', 'failed']).toContain(job.status);

    if (job.status === 'completed') {
      // Verify outputs were produced
      expect(job.outputs.length).toBeGreaterThanOrEqual(1);

      // Check for email output
      const _emailOutput = job.outputs.find(
        (o) => o.title?.toLowerCase().includes('email') || o.fileName?.includes('email')
      );
      console.log(
        'Outputs:',
        job.outputs.map((o) => o.title || o.fileName)
      );
      // Email output is expected but not strictly required (depends on Claude's interpretation)
    }

    if (job.status === 'failed') {
      console.log('Job failed (expected if Claude CLI not available):', job.error);
    }
  });

  test('email stored in space (if job completed)', async () => {
    if (!testJobId) return;

    const job = await getPlaybookJob(testJobId);
    if (job.status !== 'completed') {
      console.log('Skipping -- job did not complete successfully');
      return;
    }

    const items = await getItems(testSpaceId);
    const outputItems = items.filter(
      (i) => i.tags?.includes('playbook-output') || i.metadata?.source === 'playbook-executor'
    );

    expect(outputItems.length).toBeGreaterThanOrEqual(1);
  });

  test('POST /api/playbook/jobs/:jobId/cancel works', async () => {
    const _snap = await snapshotErrors();

    // Start a new job
    const startResult = await executePlaybook({
      spaceId: testSpaceId,
      maxTurns: 5,
      maxBudget: 0.5,
    });

    if (!startResult?.jobId) {
      console.log('Skipping cancel test -- execute failed');
      return;
    }

    // Wait briefly then cancel
    await sleep(1000);

    const cancelResult = await cancelPlaybookJob(startResult.jobId);
    expect(cancelResult.status).toBe('cancelled');

    // Verify status is cancelled
    const job = await getPlaybookJob(startResult.jobId);
    expect(job.status).toBe('cancelled');
  });

  // ---- Cleanup ----

  test('clean up test space', async () => {
    if (!testSpaceId || manualSpaceId) return;

    const snap = await snapshotErrors();
    const deleted = await deleteSpace(testSpaceId);
    expect(deleted).toBe(true);

    testSpaceId = null;

    const errors = filterBenignErrors(await checkNewErrors(snap));
    expect(errors).toHaveLength(0);
  });
});
