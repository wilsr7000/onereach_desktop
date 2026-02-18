'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATE_DIR = path.join(__dirname, 'state');
const TRAIL_FILE = path.join(STATE_DIR, 'audit-trail.jsonl');

/**
 * Append-only JSONL audit logger.
 * Every action is permanently recorded -- the file is never edited or truncated.
 */
class AuditLogger {
  constructor() {
    this._sessionId = null;
  }

  /**
   * Start a new audit session.
   * @param {Object} meta - { appVersion, totalItems }
   * @returns {string} sessionId
   */
  startSession(meta = {}) {
    this._ensureDir();
    this._sessionId = `s-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    this.log({
      event: 'session_start',
      sessionId: this._sessionId,
      appVersion: meta.appVersion || 'unknown',
      totalItems: meta.totalItems || 0,
    });
    return this._sessionId;
  }

  /**
   * End the current session.
   * @param {Object} summary - { tested, passed, failed, skipped }
   */
  endSession(summary = {}) {
    this.log({
      event: 'session_end',
      sessionId: this._sessionId,
      ...summary,
    });
    this._sessionId = null;
  }

  /**
   * Log a test start event.
   * @param {Object} item - { id, type, planFile, section, description }
   * @returns {string} correlationId for log correlation
   */
  testStart(item) {
    const correlationId = `t-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    this.log({
      event: 'test_start',
      itemId: item.id,
      type: item.type,
      plan: item.planFile,
      section: item.section,
      description: item.description,
      correlationId,
      sessionId: this._sessionId,
    });
    return correlationId;
  }

  /**
   * Log a test pass event.
   */
  testPass(itemId, details = {}) {
    this.log({
      event: 'test_pass',
      itemId,
      durationMs: details.durationMs || 0,
      notes: details.notes || '',
      correlationId: details.correlationId || null,
      sessionId: this._sessionId,
    });
  }

  /**
   * Log a test fail event.
   */
  testFail(itemId, details = {}) {
    this.log({
      event: 'test_fail',
      itemId,
      durationMs: details.durationMs || 0,
      error: details.error || 'unknown error',
      notes: details.notes || '',
      correlationId: details.correlationId || null,
      sessionId: this._sessionId,
    });
  }

  /**
   * Log a test skip event.
   */
  testSkip(itemId, reason = '') {
    this.log({
      event: 'test_skip',
      itemId,
      reason,
      sessionId: this._sessionId,
    });
  }

  /**
   * Log a test block event.
   */
  testBlock(itemId, reason = '') {
    this.log({
      event: 'test_block',
      itemId,
      reason,
      sessionId: this._sessionId,
    });
  }

  /**
   * Log a regression run start.
   */
  regressionStart(runId, itemCount) {
    this.log({
      event: 'regression_start',
      runId,
      itemCount,
      sessionId: this._sessionId,
    });
  }

  /**
   * Log a regression run completion.
   */
  regressionComplete(runId, results = {}) {
    this.log({
      event: 'regression_complete',
      runId,
      passed: results.passed || 0,
      failed: results.failed || 0,
      regressions: results.regressions || [],
      durationMs: results.durationMs || 0,
      sessionId: this._sessionId,
    });
  }

  /**
   * Append a single event line to the JSONL file.
   * @param {Object} event - Event data (timestamp auto-added)
   */
  log(event) {
    this._ensureDir();
    const entry = {
      ts: new Date().toISOString(),
      ...event,
    };
    fs.appendFileSync(TRAIL_FILE, JSON.stringify(entry) + '\n', 'utf-8');
  }

  /**
   * Read and filter the audit trail.
   * @param {Object} filters - { since, until, event, itemId, sessionId, limit }
   * @returns {Array<Object>}
   */
  getTrail(filters = {}) {
    if (!fs.existsSync(TRAIL_FILE)) return [];

    const lines = fs
      .readFileSync(TRAIL_FILE, 'utf-8')
      .split('\n')
      .filter((line) => line.trim());

    let entries = lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    // Apply filters
    if (filters.since) {
      entries = entries.filter((e) => e.ts >= filters.since);
    }
    if (filters.until) {
      entries = entries.filter((e) => e.ts <= filters.until);
    }
    if (filters.event) {
      entries = entries.filter((e) => e.event === filters.event);
    }
    if (filters.itemId) {
      entries = entries.filter((e) => e.itemId === filters.itemId);
    }
    if (filters.sessionId) {
      entries = entries.filter((e) => e.sessionId === filters.sessionId);
    }
    if (filters.limit) {
      entries = entries.slice(-filters.limit);
    }

    return entries;
  }

  /**
   * Get the current session ID.
   */
  getSessionId() {
    return this._sessionId;
  }

  /**
   * Generate a human-readable audit report from the trail.
   * @returns {string} Markdown-formatted report
   */
  getReport() {
    const trail = this.getTrail();
    if (trail.length === 0) return '# Audit Report\n\nNo audit trail entries found.\n';

    const sessions = trail.filter((e) => e.event === 'session_start');
    const passes = trail.filter((e) => e.event === 'test_pass');
    const fails = trail.filter((e) => e.event === 'test_fail');
    const skips = trail.filter((e) => e.event === 'test_skip');
    const blocks = trail.filter((e) => e.event === 'test_block');
    const regressions = trail.filter((e) => e.event === 'regression_complete');

    let report = '# Test Audit Report\n\n';
    report += `Generated: ${new Date().toISOString()}\n\n`;
    report += `## Summary\n\n`;
    report += `- Total audit trail entries: ${trail.length}\n`;
    report += `- Sessions: ${sessions.length}\n`;
    report += `- Tests passed: ${passes.length}\n`;
    report += `- Tests failed: ${fails.length}\n`;
    report += `- Tests skipped: ${skips.length}\n`;
    report += `- Tests blocked: ${blocks.length}\n`;
    report += `- Regression runs: ${regressions.length}\n\n`;

    // Failed tests detail
    if (fails.length > 0) {
      report += `## Failed Tests\n\n`;
      for (const f of fails) {
        report += `- **${f.itemId}**: ${f.error} (${f.ts})\n`;
      }
      report += '\n';
    }

    // Regression results
    if (regressions.length > 0) {
      report += `## Regression Runs\n\n`;
      for (const r of regressions) {
        const regCount = (r.regressions || []).length;
        report += `- **${r.runId}** (${r.ts}): ${r.passed} passed, ${r.failed} failed`;
        if (regCount > 0) {
          report += ` -- ${regCount} REGRESSIONS: ${r.regressions.join(', ')}`;
        }
        report += '\n';
      }
      report += '\n';
    }

    // Recent activity
    report += `## Recent Activity (last 20)\n\n`;
    const recent = trail.slice(-20);
    for (const e of recent) {
      report += `- \`${e.ts}\` ${e.event}`;
      if (e.itemId) report += ` -- ${e.itemId}`;
      if (e.error) report += ` (ERROR: ${e.error})`;
      report += '\n';
    }

    return report;
  }

  /**
   * Ensure state directory exists.
   */
  _ensureDir() {
    if (!fs.existsSync(STATE_DIR)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    }
  }
}

module.exports = { AuditLogger };
