/**
 * Budget Manager - Agent Attribution Tests
 *
 * Covers:
 *   - deriveAgent() resolution order: explicit agentId -> agent: prefix ->
 *     FEATURE_TO_AGENT map -> *-agent suffix -> unattributed.
 *   - trackUsage() stamps agentId/agentName onto every usage entry.
 *   - stats.byAgent aggregates cost / calls / tokens + agent x model
 *     + agent x feature breakdowns.
 *   - getStatsByAgent + getAgentLeaderboard + getAgentCosts period filtering.
 *   - Schema v2 -> v3 migration backfills byAgent from legacy records.
 *
 * Run: npx vitest run test/unit/budget-agent-tracking.test.js
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Stub 'electron' BEFORE loading budget-manager so the `const { app } =
// require('electron')` at module-load time resolves to our fake.
// vi.mock couldn't intercept the CJS require chain in this setup, so we
// prime the require cache directly -- reliable across vitest workers.
const electronModulePath = require.resolve('electron');
require.cache[electronModulePath] = {
  id: electronModulePath,
  filename: electronModulePath,
  loaded: true,
  exports: {
    app: {
      getPath: () => fs.mkdtempSync(path.join(os.tmpdir(), 'budget-test-')),
      getVersion: () => '0.0.0-test',
    },
    BrowserWindow: { getAllWindows: () => [] },
  },
};

const { deriveAgent, getBudgetManager } = require('../../budget-manager');

function freshManager() {
  const mgr = getBudgetManager();
  mgr.data.usage = [];
  mgr.data.stats = {
    totalCost: 0,
    totalCalls: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    byProvider: {},
    byFeature: {},
    byProject: {},
    byModel: {},
    byAgent: {},
    dailyCosts: {},
  };
  mgr.data.projectBudgets = {};
  mgr.data.projects = {};
  return mgr;
}

// ============================================================
// deriveAgent()
// ============================================================

describe('deriveAgent()', () => {
  it('returns explicit agentId when provided', () => {
    expect(deriveAgent({ agentId: 'memory-agent', agentName: 'Memory' })).toEqual({
      agentId: 'memory-agent',
      agentName: 'Memory',
    });
  });

  it('falls back to agentId as name when agentName missing', () => {
    expect(deriveAgent({ agentId: 'foo' })).toEqual({
      agentId: 'foo',
      agentName: 'foo',
    });
  });

  it('resolves agent: prefix in feature (exchange-bridge convention)', () => {
    expect(deriveAgent({ feature: 'agent:weather-agent' })).toEqual({
      agentId: 'weather-agent',
      agentName: 'weather-agent',
    });
  });

  it('resolves known feature strings via the lookup map', () => {
    expect(deriveAgent({ feature: 'app-manager-agent' })).toMatchObject({
      agentId: 'app-manager-agent',
    });
    expect(deriveAgent({ feature: 'memory-agent-observer' })).toMatchObject({
      agentId: 'memory-agent',
    });
    expect(deriveAgent({ feature: 'playbooks' })).toMatchObject({
      agentId: 'webtool:playbooks',
    });
    expect(deriveAgent({ feature: 'playbooks-launch-space-match' })).toMatchObject({
      agentId: 'playbooks-launch-agent',
    });
  });

  it('tags test:* features with a test prefix', () => {
    expect(deriveAgent({ feature: 'test:calendar-agent' })).toEqual({
      agentId: 'test:calendar-agent',
      agentName: 'Test: calendar-agent',
    });
  });

  it('generic *-agent feature resolves to itself', () => {
    expect(deriveAgent({ feature: 'my-custom-agent' })).toEqual({
      agentId: 'my-custom-agent',
      agentName: 'my-custom-agent',
    });
  });

  it('returns nulls when no identity can be derived', () => {
    expect(deriveAgent({})).toEqual({ agentId: null, agentName: null });
    expect(deriveAgent({ feature: 'other' })).toEqual({ agentId: null, agentName: null });
  });

  it('explicit agentId wins over any feature mapping', () => {
    expect(
      deriveAgent({ agentId: 'override-me', agentName: 'Override', feature: 'app-manager-agent' })
    ).toEqual({ agentId: 'override-me', agentName: 'Override' });
  });
});

// ============================================================
// trackUsage -> entry and stats
// ============================================================

describe('trackUsage() agent attribution', () => {
  let mgr;
  beforeEach(() => {
    mgr = freshManager();
  });

  it('stamps explicit agentId/agentName on the entry', () => {
    mgr.trackUsage({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      inputTokens: 100,
      outputTokens: 20,
      feature: 'chat',
      agentId: 'memory-agent',
      agentName: 'Memory Agent',
    });

    expect(mgr.data.usage).toHaveLength(1);
    expect(mgr.data.usage[0]).toMatchObject({
      agentId: 'memory-agent',
      agentName: 'Memory Agent',
      feature: 'chat',
    });
  });

  it('auto-derives agent from feature when agentId missing', () => {
    mgr.trackUsage({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      inputTokens: 50,
      outputTokens: 10,
      feature: 'app-manager-agent',
    });

    expect(mgr.data.usage[0]).toMatchObject({
      agentId: 'app-manager-agent',
      agentName: 'App Manager Agent',
    });
  });

  it('aggregates cost/calls/tokens under stats.byAgent', () => {
    mgr.trackUsage({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      inputTokens: 1000,
      outputTokens: 200,
      feature: 'app-manager-agent',
    });
    mgr.trackUsage({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      inputTokens: 500,
      outputTokens: 100,
      feature: 'app-manager-agent',
    });

    const byAgent = mgr.data.stats.byAgent;
    expect(byAgent['app-manager-agent']).toBeDefined();
    const bucket = byAgent['app-manager-agent'];

    expect(bucket.calls).toBe(2);
    expect(bucket.inputTokens).toBe(1500);
    expect(bucket.outputTokens).toBe(300);
    expect(bucket.cost).toBeGreaterThan(0);
    expect(bucket.name).toBe('App Manager Agent');

    // Per-model breakdown.
    expect(Object.keys(bucket.byModel).sort()).toEqual(
      ['claude-opus-4-7', 'claude-sonnet-4-5-20250929'].sort()
    );
    expect(bucket.byModel['claude-opus-4-7'].calls).toBe(1);
    expect(bucket.byModel['claude-sonnet-4-5-20250929'].calls).toBe(1);

    // Per-feature breakdown.
    expect(bucket.byFeature['app-manager-agent'].calls).toBe(2);
  });

  it('buckets unattributed calls into an "unattributed" agent', () => {
    mgr.trackUsage({
      provider: 'openai',
      model: 'gpt-4o-mini',
      inputTokens: 10,
      outputTokens: 5,
      feature: 'other',
    });

    expect(mgr.data.stats.byAgent.unattributed).toBeDefined();
    expect(mgr.data.stats.byAgent.unattributed.calls).toBe(1);
  });
});

// ============================================================
// Query helpers: getStatsByAgent / leaderboard / getAgentCosts
// ============================================================

describe('agent cost query helpers', () => {
  let mgr;
  beforeEach(() => {
    mgr = freshManager();
  });

  it('getAgentLeaderboard returns agents sorted by cost', () => {
    // Opus is ~7x more expensive per call than sonnet -- memory-agent wins.
    mgr.trackUsage({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      inputTokens: 10000,
      outputTokens: 1000,
      feature: 'memory-agent-orchestrator',
    });
    mgr.trackUsage({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      inputTokens: 100,
      outputTokens: 10,
      feature: 'dj-agent',
    });

    const leaderboard = mgr.getAgentLeaderboard({ period: 'all', limit: 5 });
    expect(leaderboard[0].agentId).toBe('memory-agent');
    expect(leaderboard[1].agentId).toBe('dj-agent');
    expect(leaderboard[0].cost).toBeGreaterThan(leaderboard[1].cost);
  });

  it('getAgentCosts returns null for an unknown agent', () => {
    expect(mgr.getAgentCosts('nobody')).toBeNull();
  });

  it('getStatsByAgent with period filters by timestamp', () => {
    // Insert an old entry manually (beyond "daily" window), then a fresh one.
    mgr.data.usage.push({
      id: 'old-1',
      timestamp: '2020-01-01T00:00:00.000Z',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      inputTokens: 100,
      outputTokens: 10,
      cost: 0.5,
      feature: 'dj-agent',
      agentId: 'dj-agent',
      agentName: 'DJ Agent',
    });
    mgr.trackUsage({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      inputTokens: 10,
      outputTokens: 5,
      feature: 'dj-agent',
    });

    const daily = mgr.getStatsByAgent('daily');
    // The 2020 entry is excluded; only today's call counts.
    expect(daily['dj-agent'].calls).toBe(1);

    // getStatsByAgent('all') fast-paths through pre-aggregated stats, but
    // our manual push above bypassed trackUsage. Rebuild to pull it in so
    // we can verify the union count.
    mgr._rebuildStats(mgr.data);
    const all = mgr.getStatsByAgent('all');
    expect(all['dj-agent'].calls).toBe(2);
  });
});

// ============================================================
// Migration: v2 -> v3 backfills byAgent
// ============================================================

describe('schema migration v2 -> v3 backfill', () => {
  it('rebuilds byAgent from legacy usage records on load', () => {
    const mgr = freshManager();

    // Simulate a v2 database: usage entries without agentId, stats without byAgent.
    mgr.data = {
      version: 2,
      configured: true,
      budgetLimits: {
        daily: { limit: 10, alertAt: 8, hardLimit: false },
        weekly: { limit: 50, alertAt: 40, hardLimit: false },
        monthly: { limit: 150, alertAt: 120, hardLimit: false },
      },
      projectBudgets: {},
      usage: [
        {
          id: 'legacy-1',
          timestamp: new Date().toISOString(),
          provider: 'anthropic',
          model: 'claude-opus-4-7',
          inputTokens: 500,
          outputTokens: 50,
          cost: 0.01,
          feature: 'playbooks',
          operation: 'ai-service:powerful',
          success: true,
        },
        {
          id: 'legacy-2',
          timestamp: new Date().toISOString(),
          provider: 'anthropic',
          model: 'claude-sonnet-4-5-20250929',
          inputTokens: 300,
          outputTokens: 20,
          cost: 0.002,
          feature: 'app-manager-agent',
          operation: 'ai-service:standard',
          success: true,
        },
      ],
      stats: {
        totalCost: 0,
        totalCalls: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        byProvider: {},
        byFeature: {},
        byProject: {},
        byModel: {},
        // NOTE: no byAgent yet (v2)
        dailyCosts: {},
      },
      projects: {},
      preferences: {},
    };

    // Trigger migration explicitly so we don't need disk IO.
    const migrated = mgr._migrateData(mgr.data, {
      version: 3,
      stats: {
        totalCost: 0,
        totalCalls: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        byProvider: {},
        byFeature: {},
        byProject: {},
        byModel: {},
        byAgent: {},
        dailyCosts: {},
      },
      budgetLimits: {
        daily: { limit: 10, alertAt: 8, hardLimit: false },
        weekly: { limit: 50, alertAt: 40, hardLimit: false },
        monthly: { limit: 150, alertAt: 120, hardLimit: false },
      },
    });

    expect(migrated.version).toBe(3);
    expect(migrated.stats.byAgent).toBeDefined();
    expect(migrated.stats.byAgent['webtool:playbooks']).toBeDefined();
    expect(migrated.stats.byAgent['app-manager-agent']).toBeDefined();

    // Legacy usage entries should now have derived agentId stamped on them too.
    expect(migrated.usage[0].agentId).toBe('webtool:playbooks');
    expect(migrated.usage[1].agentId).toBe('app-manager-agent');
  });
});
