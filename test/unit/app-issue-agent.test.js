/**
 * Unit tests for lib/app-issue-agent.js
 *
 * Covers:
 *   - Orchestrator: reportIssue() diagnose-only + diagnose+proposeFix paths
 *   - Input validation (missing userMessage + errorContext)
 *   - Budget-exceeded short-circuit for both stages
 *   - Fix stage gate (dev-mode detection + ONEREACH_AUTOFIX override)
 *   - canAutoFix=false blocks the fix stage unless force:true
 *   - validateChanges: path denylist, extension allowlist, malformed diff headers
 *   - assemblePatch: trailing newlines, multi-file output
 *   - sanitizeBranchSuggestion: protected branches, slugification
 *   - Diagnosis normalization: bounded arrays, severity whitelist, confidence clamp
 *   - Source overview: keyFiles present
 *   - savePatch: refuses patches with validation errors, writes to the target dir
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: () => {}, warn: () => {}, error: () => {}, query: () => [] }),
}));

const issueAgent = require('../../lib/app-issue-agent');

// ────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ────────────────────────────────────────────────────────────────────────────

const VALID_DIAGNOSIS_JSON = {
  summary: 'Test diagnosis summary.',
  rootCause: 'Test root cause.',
  severity: 'medium',
  affectedFiles: [
    { path: 'lib/foo.js', lines: '10-20', why: 'Missing null check.' },
  ],
  reproSteps: ['Step 1', 'Step 2'],
  userFacingSteps: ['Restart the app.'],
  instructionsForFixAgent: {
    goal: 'Add a null guard.',
    filesToEdit: ['lib/foo.js'],
    approach: 'Insert `if (!x) return;` at line 12.',
    verification: ['npm test -- test/unit/foo.test.js'],
    risks: ['None expected.'],
  },
  canAutoFix: true,
  confidence: 0.85,
};

const VALID_FIX_JSON = {
  summary: 'Add a null guard to lib/foo.js.',
  changes: [
    {
      path: 'lib/foo.js',
      reasoning: 'The function crashes on undefined input.',
      unifiedDiff:
        '--- a/lib/foo.js\n+++ b/lib/foo.js\n@@ -10,3 +10,4 @@\n function foo(x) {\n+  if (!x) return;\n   return x.y;\n }\n',
    },
  ],
  branchSuggestion: 'fix/null-guard-foo',
  commitMessage: 'fix(foo): add null guard\n\nPrevents crash on undefined input.',
  prDescription: 'Adds a null guard to `foo()` in `lib/foo.js`.',
  verificationPlan: ['npm test'],
};

function fakeRunner({ available = true, onDiagnose = null, onFix = null, throwOnRun = false } = {}) {
  return {
    isClaudeCodeAvailable: async () => ({ available }),
    runClaudeCode: async (prompt, opts) => {
      if (throwOnRun) throw new Error('spawn failed');
      const feature = opts?.feature || '';
      let payload;
      if (feature.includes('propose-fix')) {
        payload = typeof onFix === 'function' ? onFix() : VALID_FIX_JSON;
      } else {
        payload = typeof onDiagnose === 'function' ? onDiagnose() : VALID_DIAGNOSIS_JSON;
      }
      if (payload === null) {
        return { success: true, result: 'not json at all' };
      }
      return { success: true, result: JSON.stringify(payload) };
    },
  };
}

function fakeBudget({ blocked = false } = {}) {
  return {
    getBudgetManager: () => ({ checkBudget: () => ({ blocked, warnings: [] }) }),
  };
}

function fakeElectronApp({ isPackaged = false } = {}) {
  return { isPackaged };
}

// ────────────────────────────────────────────────────────────────────────────

describe('app-issue-agent', () => {
  beforeEach(() => {
    issueAgent._resetInjections();
    issueAgent._clearCache();
    delete process.env.ONEREACH_AUTOFIX;
  });

  // ──────────────────────────────────────────────────────────────────────
  // Pure helpers
  // ──────────────────────────────────────────────────────────────────────

  describe('validateChanges', () => {
    it('accepts a well-formed unified diff for an allowed extension', () => {
      const errs = issueAgent.validateChanges([
        {
          path: 'lib/foo.js',
          unifiedDiff: '--- a/lib/foo.js\n+++ b/lib/foo.js\n@@ -1 +1 @@\n-old\n+new\n',
        },
      ]);
      expect(errs).toEqual([]);
    });

    it('rejects a path on the deny list (.env, lockfiles, node_modules)', () => {
      const bad = [
        { path: 'package-lock.json', unifiedDiff: '--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-x\n+y\n' },
        { path: '.env.local', unifiedDiff: '--- a/.env.local\n+++ b/.env.local\n@@ -1 +1 @@\n-x\n+y\n' },
        { path: 'node_modules/foo/index.js', unifiedDiff: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-x\n+y\n' },
      ];
      for (const c of bad) {
        const errs = issueAgent.validateChanges([c]);
        expect(errs.length).toBeGreaterThan(0);
      }
    });

    it('rejects disallowed extensions', () => {
      const errs = issueAgent.validateChanges([
        { path: 'script.sh', unifiedDiff: '--- a/script.sh\n+++ b/script.sh\n@@ -1 +1 @@\n-x\n+y\n' },
      ]);
      expect(errs.some((e) => e.includes('extension'))).toBe(true);
    });

    it('rejects paths with traversal (..) or absolute roots', () => {
      const errs1 = issueAgent.validateChanges([
        { path: '../etc/passwd', unifiedDiff: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-x\n+y\n' },
      ]);
      expect(errs1.length).toBeGreaterThan(0);
      const errs2 = issueAgent.validateChanges([
        { path: '/tmp/foo.js', unifiedDiff: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-x\n+y\n' },
      ]);
      expect(errs2.length).toBeGreaterThan(0);
    });

    it('rejects diffs missing unified-diff headers', () => {
      const errs = issueAgent.validateChanges([
        { path: 'lib/foo.js', unifiedDiff: 'just some free text with no --- line' },
      ]);
      expect(errs.some((e) => e.includes('headers'))).toBe(true);
    });

    it('reports "no changes" when the list is empty', () => {
      expect(issueAgent.validateChanges([])).toEqual(['No changes to validate.']);
    });
  });

  describe('assemblePatch', () => {
    it('joins multiple file diffs and ensures trailing newlines', () => {
      const patch = issueAgent.assemblePatch([
        { path: 'a.js', unifiedDiff: '--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-x\n+y' }, // no trailing \n
        { path: 'b.js', unifiedDiff: '--- a/b.js\n+++ b/b.js\n@@ -1 +1 @@\n-foo\n+bar\n' },
      ]);
      expect(patch).toContain('--- a/a.js');
      expect(patch).toContain('--- a/b.js');
      expect(patch.endsWith('\n')).toBe(true);
    });
  });

  describe('sanitizeBranchSuggestion', () => {
    it('prefixes plain slugs with fix/', () => {
      expect(issueAgent.sanitizeBranchSuggestion('add-null-guard', 'fix/fallback')).toBe('fix/add-null-guard');
    });

    it('keeps valid namespaced branches', () => {
      expect(issueAgent.sanitizeBranchSuggestion('fix/null-guard-foo', 'fix/fallback')).toBe('fix/null-guard-foo');
      expect(issueAgent.sanitizeBranchSuggestion('chore/docs-fix', 'fix/fallback')).toBe('chore/docs-fix');
    });

    it('falls back when asked to use a protected branch', () => {
      expect(issueAgent.sanitizeBranchSuggestion('main', 'fix/fallback')).toBe('fix/fallback');
      expect(issueAgent.sanitizeBranchSuggestion('master', 'fix/fallback')).toBe('fix/fallback');
      expect(issueAgent.sanitizeBranchSuggestion('develop', 'fix/fallback')).toBe('fix/fallback');
    });

    it('slugifies messy input', () => {
      expect(issueAgent.sanitizeBranchSuggestion('  Fix that stupid Bug!!  ', 'fix/fallback')).toBe(
        'fix/fix-that-stupid-bug'
      );
    });
  });

  describe('getCachedSourceOverview', () => {
    it('returns the repo root and a hand-picked keyFiles list', () => {
      const overview = issueAgent.getCachedSourceOverview();
      expect(overview.repoRoot).toMatch(/Onereach_app$/);
      expect(Array.isArray(overview.keyFiles)).toBe(true);
      expect(overview.keyFiles.length).toBeGreaterThan(5);
      // Known file must be present
      expect(overview.keyFiles.some((kf) => kf.path === 'main.js')).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // isFixStageEnabled
  // ──────────────────────────────────────────────────────────────────────

  describe('isFixStageEnabled', () => {
    it('returns true when no electron app is present (test env)', () => {
      issueAgent._setElectronApp(null);
      expect(issueAgent.isFixStageEnabled()).toBe(true);
    });

    it('returns true when the app is not packaged (dev mode)', () => {
      issueAgent._setElectronApp(fakeElectronApp({ isPackaged: false }));
      expect(issueAgent.isFixStageEnabled()).toBe(true);
    });

    it('returns false when the app is packaged without the override', () => {
      issueAgent._setElectronApp(fakeElectronApp({ isPackaged: true }));
      expect(issueAgent.isFixStageEnabled()).toBe(false);
    });

    it('returns true when ONEREACH_AUTOFIX=1 even in a packaged build', () => {
      issueAgent._setElectronApp(fakeElectronApp({ isPackaged: true }));
      process.env.ONEREACH_AUTOFIX = '1';
      expect(issueAgent.isFixStageEnabled()).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // diagnose()
  // ──────────────────────────────────────────────────────────────────────

  describe('diagnose', () => {
    it('returns a normalized diagnosis on Claude Code success', async () => {
      issueAgent._setClaudeRunner(fakeRunner());
      const res = await issueAgent.diagnose({
        userMessage: "WISER Meeting won't let guests join",
        errorContext: { message: 'publish failed', category: 'recorder' },
      });
      expect(res.source).toBe('claude-code');
      expect(res.diagnosis.summary).toBe('Test diagnosis summary.');
      expect(res.diagnosis.canAutoFix).toBe(true);
      expect(res.diagnosis.affectedFiles[0].path).toBe('lib/foo.js');
      expect(res.diagnosis.severity).toBe('medium');
      expect(res.diagnosis.confidence).toBe(0.85);
    });

    it('normalizes bad input safely (invalid severity, out-of-range confidence)', async () => {
      issueAgent._setClaudeRunner(
        fakeRunner({
          onDiagnose: () => ({
            summary: 'x',
            rootCause: 'y',
            severity: 'catastrophic', // not in whitelist
            confidence: 5, // out of range
            canAutoFix: 'yes',
            affectedFiles: [{ path: 'a.js' }],
          }),
        })
      );
      const res = await issueAgent.diagnose({ userMessage: 'something broke' });
      expect(res.diagnosis.severity).toBe('medium');
      expect(res.diagnosis.confidence).toBe(0.5);
      expect(res.diagnosis.canAutoFix).toBe(false); // string 'yes' is not ===true
    });

    it('caches repeat calls for the same error text', async () => {
      issueAgent._setClaudeRunner(fakeRunner());
      const first = await issueAgent.diagnose({ userMessage: 'same issue' });
      const second = await issueAgent.diagnose({ userMessage: 'same issue' });
      expect(first.cached).toBe(false);
      expect(second.cached).toBe(true);
    });

    it('short-circuits when the budget is blocked', async () => {
      issueAgent._setClaudeRunner(fakeRunner());
      issueAgent._setBudgetManager(fakeBudget({ blocked: true }));
      const res = await issueAgent.diagnose({ userMessage: 'anything' });
      expect(res.diagnosis).toBeNull();
      expect(res.source).toBe('fallback');
      expect(res.degraded).toBe('budget-exceeded');
    });

    it('reports an error when Claude Code throws', async () => {
      issueAgent._setClaudeRunner(fakeRunner({ throwOnRun: true }));
      const res = await issueAgent.diagnose({ userMessage: 'oops' });
      expect(res.diagnosis).toBeNull();
      expect(res.source).toBe('error');
      expect(res.error).toMatch(/spawn failed/);
    });

    it('returns error when Claude Code returns non-JSON', async () => {
      issueAgent._setClaudeRunner(fakeRunner({ onDiagnose: () => null }));
      const res = await issueAgent.diagnose({ userMessage: 'something' });
      expect(res.diagnosis).toBeNull();
      expect(res.error).toMatch(/valid JSON/i);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // proposeFix()
  // ──────────────────────────────────────────────────────────────────────

  describe('proposeFix', () => {
    it('returns a patch when Claude Code proposes valid diffs', async () => {
      issueAgent._setClaudeRunner(fakeRunner());
      const res = await issueAgent.proposeFix(VALID_DIAGNOSIS_JSON);
      expect(res.fix).not.toBeNull();
      expect(res.fix.summary).toBe('Add a null guard to lib/foo.js.');
      expect(res.fix.patch).toContain('--- a/lib/foo.js');
      expect(res.fix.branchSuggestion).toBe('fix/null-guard-foo');
      expect(res.fix.validationErrors).toEqual([]);
    });

    it('refuses when the diagnosis says canAutoFix=false', async () => {
      issueAgent._setClaudeRunner(fakeRunner());
      const res = await issueAgent.proposeFix({ ...VALID_DIAGNOSIS_JSON, canAutoFix: false });
      expect(res.fix).toBeNull();
      expect(res.degraded).toBe('not-auto-fixable');
    });

    it('honors { force: true } to override canAutoFix=false', async () => {
      issueAgent._setClaudeRunner(fakeRunner());
      const res = await issueAgent.proposeFix({ ...VALID_DIAGNOSIS_JSON, canAutoFix: false }, { force: true });
      expect(res.fix).not.toBeNull();
    });

    it('short-circuits when the fix stage is disabled (packaged, no override)', async () => {
      issueAgent._setElectronApp(fakeElectronApp({ isPackaged: true }));
      const res = await issueAgent.proposeFix(VALID_DIAGNOSIS_JSON);
      expect(res.fix).toBeNull();
      expect(res.degraded).toBe('feature-gated');
    });

    it('short-circuits when the budget is blocked', async () => {
      issueAgent._setClaudeRunner(fakeRunner());
      issueAgent._setBudgetManager(fakeBudget({ blocked: true }));
      const res = await issueAgent.proposeFix(VALID_DIAGNOSIS_JSON);
      expect(res.fix).toBeNull();
      expect(res.degraded).toBe('budget-exceeded');
    });

    it('flags validation errors when the diff targets a denied path', async () => {
      issueAgent._setClaudeRunner(
        fakeRunner({
          onFix: () => ({
            ...VALID_FIX_JSON,
            changes: [
              {
                path: 'package-lock.json',
                reasoning: 'should not happen',
                unifiedDiff: '--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-x\n+y\n',
              },
            ],
          }),
        })
      );
      const res = await issueAgent.proposeFix(VALID_DIAGNOSIS_JSON);
      expect(res.fix).not.toBeNull();
      expect(res.fix.validationErrors.length).toBeGreaterThan(0);
    });

    it('rewrites a protected branch suggestion to the fallback', async () => {
      issueAgent._setClaudeRunner(
        fakeRunner({ onFix: () => ({ ...VALID_FIX_JSON, branchSuggestion: 'main' }) })
      );
      const res = await issueAgent.proposeFix(VALID_DIAGNOSIS_JSON);
      expect(res.fix.branchSuggestion).toMatch(/^fix\//);
      expect(res.fix.branchSuggestion).not.toBe('main');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // reportIssue() orchestrator
  // ──────────────────────────────────────────────────────────────────────

  describe('reportIssue', () => {
    it('errors when neither userMessage nor errorContext.message is provided', async () => {
      const res = await issueAgent.reportIssue({});
      expect(res.status).toBe('error');
    });

    it('returns status=diagnosed when proposeFix is not requested', async () => {
      issueAgent._setClaudeRunner(fakeRunner());
      const res = await issueAgent.reportIssue({ userMessage: 'thing broke' });
      expect(res.status).toBe('diagnosed');
      expect(res.fix).toBeUndefined();
    });

    it('returns status=fix-proposed when proposeFix succeeds', async () => {
      issueAgent._setClaudeRunner(fakeRunner());
      const res = await issueAgent.reportIssue(
        { userMessage: 'thing broke' },
        { proposeFix: true }
      );
      expect(res.status).toBe('fix-proposed');
      expect(res.fix.patch).toBeTruthy();
    });

    it('returns status=fix-unavailable when the fix stage is gated off', async () => {
      issueAgent._setClaudeRunner(fakeRunner());
      issueAgent._setElectronApp(fakeElectronApp({ isPackaged: true }));
      const res = await issueAgent.reportIssue(
        { userMessage: 'thing broke' },
        { proposeFix: true }
      );
      expect(res.status).toBe('fix-unavailable');
      expect(res.degraded).toBe('feature-gated');
    });

    it('returns status=diagnose-failed when Claude Code fails', async () => {
      issueAgent._setClaudeRunner(fakeRunner({ throwOnRun: true }));
      const res = await issueAgent.reportIssue({ userMessage: 'broke' });
      expect(res.status).toBe('diagnose-failed');
    });

    it('passes through the errorContext.message as the triggering issue', async () => {
      issueAgent._setClaudeRunner(fakeRunner());
      const res = await issueAgent.reportIssue({
        errorContext: { message: 'SignalRequestError' },
      });
      expect(res.status).toBe('diagnosed');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // savePatch()
  // ──────────────────────────────────────────────────────────────────────

  describe('savePatch', () => {
    let tmpDir;

    beforeEach(async () => {
      tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'issue-agent-test-'));
    });

    afterEach(async () => {
      if (tmpDir) {
        try {
          await fs.promises.rm(tmpDir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
    });

    it('refuses to save a patch with validation errors', async () => {
      await expect(
        issueAgent.savePatch({
          summary: 'bad',
          patch: 'anything',
          branchSuggestion: 'fix/bad',
          validationErrors: ['Change #1: path "package-lock.json" is on the deny list.'],
        })
      ).rejects.toThrow(/validation errors/);
    });

    it('refuses to save when patch content is missing', async () => {
      await expect(
        issueAgent.savePatch({ summary: 'empty', patch: '', branchSuggestion: 'fix/x', validationErrors: [] })
      ).rejects.toThrow(/patch content/);
    });

    it('writes the patch + a descriptive header to the destination dir', async () => {
      const fix = {
        summary: 'Add a null guard.',
        patch: '--- a/lib/foo.js\n+++ b/lib/foo.js\n@@ -10,3 +10,4 @@\n a\n+b\n c\n d\n',
        branchSuggestion: 'fix/null-guard-foo',
        commitMessage: 'fix(foo): null guard',
        validationErrors: [],
      };
      const result = await issueAgent.savePatch(fix, { destinationDir: tmpDir });
      expect(result.path.startsWith(tmpDir)).toBe(true);
      expect(result.bytes).toBeGreaterThan(0);
      expect(result.branch).toBe('fix/null-guard-foo');

      const written = await fs.promises.readFile(result.path, 'utf8');
      expect(written).toContain('# Proposed fix: Add a null guard.');
      expect(written).toContain('# Branch:         fix/null-guard-foo');
      expect(written).toContain('--- a/lib/foo.js');
    });
  });
});
