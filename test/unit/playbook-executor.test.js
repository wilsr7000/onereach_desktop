/**
 * Playbook Executor Unit Tests
 *
 * Tests job lifecycle, pause/resume, output parsing with mocked Claude CLI.
 * Uses _setTestDeps() to inject mock dependencies directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

// ---- Mock electron (needed at module load) ----
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => os.tmpdir() },
}));

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../budget-manager', () => ({
  getBudgetManager: () => ({ trackUsage: vi.fn() }),
}));

vi.mock('../../settings-manager', () => ({
  getSettingsManager: () => ({
    get: vi.fn().mockReturnValue('sk-ant-test-key-123'),
  }),
}));

// ---- Import executor ----
import executor from '../../lib/playbook-executor.js';

// ---- Mock dependencies injected via _setTestDeps ----
const mockItemsList = vi.fn();
const mockItemsGet = vi.fn();
const mockItemsAdd = vi.fn();
const mockRunClaudeCode = vi.fn();
const mockCancelSession = vi.fn().mockReturnValue(true);
const mockSyncPush = vi.fn().mockResolvedValue({ committed: false });

// ---- Test data ----

const PLAYBOOK_ITEM = {
  id: 'playbook-1',
  type: 'text',
  content: '# Test Playbook\n\n## Steps\n1. Read the data\n2. Generate report',
  metadata: { title: 'Test Playbook', tags: ['playbook'] },
  tags: ['playbook'],
  fileName: 'playbook.md',
};

const ASSET_ITEM = {
  id: 'asset-1',
  type: 'text',
  content: 'Sample data content',
  metadata: { title: 'Sample Data' },
  fileName: 'sample.txt',
};

// ---- Helper ----
async function waitForJobTerminal(jobId, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = executor.getJob(jobId);
    if (job && ['completed', 'failed', 'cancelled', 'paused'].includes(job.status)) {
      return job;
    }
    await new Promise((r) => {
      setTimeout(r, 50);
    });
  }
  return executor.getJob(jobId);
}

// ---- Tests ----

describe('PlaybookExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockItemsAdd.mockResolvedValue({ id: 'new-item-1' });

    // Inject mocks
    executor._setTestDeps({
      spacesAPI: () => ({
        items: {
          list: mockItemsList,
          get: mockItemsGet,
          add: mockItemsAdd,
        },
      }),
      claudeCode: () => ({
        runClaudeCode: mockRunClaudeCode,
        cancelSession: mockCancelSession,
      }),
      sync: () => ({
        push: mockSyncPush,
        pull: vi.fn().mockResolvedValue({ pulled: false }),
        status: vi.fn().mockResolvedValue({}),
      }),
    });
  });

  afterEach(() => {
    executor._clearTestDeps();
    executor._clearJobs();
  });

  describe('Job lifecycle', () => {
    it('startJob returns a jobId and running status', async () => {
      mockItemsList.mockResolvedValue([PLAYBOOK_ITEM, ASSET_ITEM]);
      mockItemsGet.mockResolvedValue(PLAYBOOK_ITEM);
      mockRunClaudeCode.mockResolvedValue({
        success: true,
        output: 'Done',
        requestId: 'req-1',
        sessionId: 'sess-1',
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      const result = await executor.startJob({ spaceId: 'space-lc1', playbookId: 'playbook-1' });

      expect(result).toHaveProperty('jobId');
      expect(result.status).toBe('running');
    });

    it('getJob returns current state for a valid jobId', async () => {
      mockItemsList.mockResolvedValue([PLAYBOOK_ITEM, ASSET_ITEM]);
      mockItemsGet.mockImplementation(async (sid, iid) => {
        if (iid === 'playbook-1') return PLAYBOOK_ITEM;
        return ASSET_ITEM;
      });
      mockRunClaudeCode.mockResolvedValue({
        success: true,
        output: 'Done',
        requestId: 'req-2',
        sessionId: 'sess-2',
      });

      const { jobId } = await executor.startJob({ spaceId: 'space-lc2', playbookId: 'playbook-1' });
      const job = await waitForJobTerminal(jobId);

      expect(job).not.toBeNull();
      expect(job.jobId).toBe(jobId);
      expect(job.spaceId).toBe('space-lc2');
    });

    it('getJob returns null for unknown jobId', () => {
      expect(executor.getJob('nonexistent-id')).toBeNull();
    });

    it('cancel sets status to cancelled', async () => {
      mockItemsList.mockResolvedValue([PLAYBOOK_ITEM, ASSET_ITEM]);
      mockItemsGet.mockResolvedValue(PLAYBOOK_ITEM);
      mockRunClaudeCode.mockReturnValue(new Promise(() => {})); // never resolves

      const { jobId } = await executor.startJob({ spaceId: 'space-lc4', playbookId: 'playbook-1' });
      await new Promise((r) => {
        setTimeout(r, 300);
      });

      const result = executor.cancel(jobId);
      expect(result.jobId).toBe(jobId);
      expect(result.status).toBe('cancelled');
    });
  });

  describe('Space context loading', () => {
    it('finds playbook items by tag', async () => {
      mockItemsList.mockResolvedValue([
        { id: 'item-1', type: 'text', metadata: { title: 'Notes' } },
        { id: 'item-2', type: 'text', tags: ['playbook'], metadata: { title: 'My Playbook' } },
      ]);
      mockItemsGet.mockResolvedValue({
        id: 'item-2',
        type: 'text',
        content: '## Steps\n1. Do thing',
        metadata: { title: 'My Playbook' },
      });

      const playbooks = await executor.findPlaybooks('space-ctx1');
      expect(playbooks.length).toBe(1);
      expect(playbooks[0].title).toBe('My Playbook');
    });

    it('finds playbook items by title containing playbook', async () => {
      mockItemsList.mockResolvedValue([
        { id: 'item-1', type: 'text', metadata: { title: 'My Playbook Plan' }, fileName: 'playbook.md' },
      ]);
      mockItemsGet.mockResolvedValue({
        id: 'item-1',
        type: 'text',
        content: 'step 1',
        metadata: { title: 'My Playbook Plan' },
      });

      const playbooks = await executor.findPlaybooks('space-ctx2');
      expect(playbooks.length).toBe(1);
    });

    it('fails job when no playbook found among items', async () => {
      mockItemsList.mockResolvedValue([
        { id: 'item-1', type: 'text', metadata: { title: 'Notes' } },
        { id: 'item-2', type: 'url', content: 'http://example.com', metadata: { title: 'Link' } },
      ]);

      const { jobId } = await executor.startJob({ spaceId: 'space-ctx3' });
      const job = await waitForJobTerminal(jobId);

      expect(job.status).toBe('failed');
      expect(job.error).toMatch(/no playbook/i);
    });
  });

  describe('Pause/resume', () => {
    it('detects _pause.json and sets status to paused', async () => {
      mockItemsList.mockResolvedValue([PLAYBOOK_ITEM, ASSET_ITEM]);
      mockItemsGet.mockImplementation(async (sid, iid) => {
        if (iid === 'playbook-1') return PLAYBOOK_ITEM;
        return ASSET_ITEM;
      });

      mockRunClaudeCode.mockImplementation(async (prompt, opts) => {
        if (opts.cwd) {
          fs.writeFileSync(
            path.join(opts.cwd, '_pause.json'),
            JSON.stringify({
              questions: [
                {
                  id: 'q1',
                  question: 'Which template?',
                  options: ['A', 'B'],
                  context: 'Multiple options found',
                },
              ],
            })
          );
        }
        return { success: true, output: 'Paused', requestId: 'req-p', sessionId: 'sess-p' };
      });

      const { jobId } = await executor.startJob({ spaceId: 'space-p1', playbookId: 'playbook-1' });
      const job = await waitForJobTerminal(jobId);

      expect(job.status).toBe('paused');
      expect(job.pendingQuestions.length).toBe(1);
      expect(job.pendingQuestions[0].question).toBe('Which template?');
      expect(job.pendingQuestions[0].options).toEqual(['A', 'B']);
    });

    it('respond rejects if job is not paused', async () => {
      mockItemsList.mockResolvedValue([PLAYBOOK_ITEM]);
      mockItemsGet.mockResolvedValue(PLAYBOOK_ITEM);
      mockRunClaudeCode.mockResolvedValue({
        success: true,
        output: 'Done',
        requestId: 'req-np',
      });

      const { jobId } = await executor.startJob({ spaceId: 'space-np', playbookId: 'playbook-1' });
      await waitForJobTerminal(jobId);

      await expect(executor.respond(jobId, 'q1', 'answer')).rejects.toThrow(/not paused/);
    });
  });

  describe('Output handling', () => {
    it('parses _results.json and maps output types', async () => {
      mockItemsList.mockResolvedValue([PLAYBOOK_ITEM, ASSET_ITEM]);
      mockItemsGet.mockImplementation(async (sid, iid) => {
        if (iid === 'playbook-1') return PLAYBOOK_ITEM;
        return ASSET_ITEM;
      });
      mockItemsAdd.mockResolvedValue({ id: 'output-new' });

      mockRunClaudeCode.mockImplementation(async (prompt, opts) => {
        const wd = opts.cwd;
        fs.writeFileSync(path.join(wd, 'report.md'), '# Report\n\nResults here.');
        fs.writeFileSync(path.join(wd, 'dashboard.html'), '<html><body>Dashboard</body></html>');
        fs.writeFileSync(
          path.join(wd, '_results.json'),
          JSON.stringify({
            tickets: [{ id: 't1', title: 'Task 1', status: 'done', output: 'Completed' }],
            outputs: [
              { file: 'report.md', type: 'document', title: 'Analysis Report' },
              { file: 'dashboard.html', type: 'dashboard', title: 'Metrics Dashboard', render: true },
            ],
            summary: 'Generated a report and dashboard.',
          })
        );
        return { success: true, output: 'Done', requestId: 'req-out', sessionId: 'sess-out' };
      });

      const { jobId } = await executor.startJob({ spaceId: 'space-out', playbookId: 'playbook-1' });
      const job = await waitForJobTerminal(jobId, 5000);

      expect(job.status).toBe('completed');
      expect(job.outputs.length).toBe(2);
      expect(job.tickets.length).toBe(1);
      expect(job.tickets[0].status).toBe('done');
      expect(mockItemsAdd.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('listJobs', () => {
    it('returns jobs filtered by spaceId', async () => {
      mockItemsList.mockResolvedValue([PLAYBOOK_ITEM]);
      mockItemsGet.mockResolvedValue(PLAYBOOK_ITEM);
      mockRunClaudeCode.mockResolvedValue({
        success: true,
        output: 'Done',
        requestId: 'req-list',
      });

      const { jobId: _jA } = await executor.startJob({ spaceId: 'space-AAA-unique', playbookId: 'playbook-1' });
      const { jobId: _jB } = await executor.startJob({ spaceId: 'space-BBB-unique', playbookId: 'playbook-1' });

      const result = executor.listJobs({ spaceId: 'space-AAA-unique' });
      expect(result.jobs.length).toBe(1);
      expect(result.jobs[0].spaceId).toBe('space-AAA-unique');
    });
  });
});
