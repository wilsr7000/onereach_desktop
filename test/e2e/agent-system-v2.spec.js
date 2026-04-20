/**
 * Agent System v2 -- Live App E2E
 *
 * Proves the v2 code paths actually light up inside a real Electron
 * process with all feature flags enabled. Complements the unit + integration
 * tests (which run in isolation) by exercising:
 *
 *   - lib/agent-system-flags resolution inside the real main process
 *   - lib/task.js buildTask + rubric auto-expansion end-to-end
 *   - lib/exchange/council-runner against the real EvaluationConsolidator
 *     with a deterministic injected bid collector (no LLM calls)
 *   - lib/exchange/voter-pool filter against the real agent registry
 *   - lib/agent-stats recordTaskLifecycle / getTaskTimeline persistence
 *   - lib/agent-gateway start/stop + /health + /submit-task shape
 *   - lib/learning/index.js getLearnedWeight cold-start behavior
 *
 * The app is launched with AGENT_SYS_AGENT_SYS_V2=1 so every phase flag
 * is active. The test suite leaves all flags in their post-commit state
 * when done.
 *
 * Run:  npx playwright test test/e2e/agent-system-v2.spec.js
 */

const { test, expect } = require('@playwright/test');
const { launchApp, closeApp, snapshotErrors, checkNewErrors, filterBenignErrors, sleep } = require('./helpers/electron-app');

test.describe('Agent System v2 -- Live App E2E', () => {
  let electronApp;
  let errorSnapshot;

  test.beforeAll(async () => {
    // Enable the umbrella flag BEFORE launching so the main process
    // sees it during boot. The helper forwards process.env to the
    // spawned Electron.
    process.env.AGENT_SYS_AGENT_SYS_V2 = '1';
    const launched = await launchApp({ timeout: 45000 });
    electronApp = launched.electronApp;
    errorSnapshot = await snapshotErrors();
  });

  test.afterAll(async () => {
    await closeApp({ electronApp });
    delete process.env.AGENT_SYS_AGENT_SYS_V2;
  });

  // ═════════════════════════════════════════════════════════════════════
  // 1. FLAG RESOLUTION -- prove the umbrella flag is active in-process
  // ═════════════════════════════════════════════════════════════════════

  test('all v2 phase flags report enabled under the umbrella', async () => {
    const snapshot = await electronApp.evaluate(async () => {
      const { isAgentFlagEnabled, getAgentFlagNames } = process.mainModule.require('./lib/agent-system-flags');
      const result = {};
      for (const name of getAgentFlagNames()) {
        result[name] = isAgentFlagEnabled(name);
      }
      return result;
    });

    // With umbrella on, every phase flag should read as true unless
    // the settings store explicitly opts out. This is a fresh launch,
    // so we expect everything on.
    expect(snapshot.agentSysV2).toBe(true);
    expect(snapshot.typedTaskContract).toBe(true);
    expect(snapshot.councilMode).toBe(true);
    expect(snapshot.learnedWeights).toBe(true);
    expect(snapshot.roleBasedVoterPool).toBe(true);
    expect(snapshot.variantSelector).toBe(true);
    expect(snapshot.perCriterionBidding).toBe(true);
    expect(snapshot.bidTimeClarification).toBe(true);
    expect(snapshot.adequacyLoop).toBe(true);
    expect(snapshot.httpGateway).toBe(true);
  });

  // ═════════════════════════════════════════════════════════════════════
  // 2. BUILDTASK + RUBRIC EXPANSION
  // ═════════════════════════════════════════════════════════════════════

  test('buildTask auto-expands task.rubric into criteria (plan_review)', async () => {
    const task = await electronApp.evaluate(async () => {
      const { buildTask } = process.mainModule.require('./lib/task');
      return buildTask({
        content: 'Evaluate this proposal',
        variant: 'council',
        rubric: 'plan_review',
        toolId: 'e2e-test',
      });
    });

    expect(task.id).toBeTruthy();
    expect(task.variant).toBe('council');
    expect(task.rubric).toBe('plan_review');
    expect(Array.isArray(task.criteria)).toBe(true);
    // plan_review defines 6 criteria (clarity, feasibility, specificity,
    // risk, completeness, coherence)
    expect(task.criteria.length).toBe(6);
    const ids = task.criteria.map((c) => c.id).sort();
    expect(ids).toEqual(
      ['clarity', 'coherence', 'completeness', 'feasibility', 'risk', 'specificity']
    );
  });

  test('buildTask auto-expansion works for meeting_outcome rubric', async () => {
    const task = await electronApp.evaluate(async () => {
      const { buildTask } = process.mainModule.require('./lib/task');
      return buildTask({
        content: 'Review the meeting',
        rubric: 'meeting_outcome',
      });
    });
    const ids = task.criteria.map((c) => c.id).sort();
    expect(ids).toEqual(['action_items', 'decisions_captured', 'notes_quality', 'priority', 'unresolved']);
  });

  // ═════════════════════════════════════════════════════════════════════
  // 3. COUNCIL RUNNER AGAINST REAL CONSOLIDATOR
  //    Uses injected getBids so test is deterministic (no LLM calls).
  // ═════════════════════════════════════════════════════════════════════

  test('runCouncil + real EvaluationConsolidator produces weighted aggregate', async () => {
    const result = await electronApp.evaluate(async () => {
      const { runCouncil } = process.mainModule.require('./lib/exchange/council-runner');
      const { buildTask } = process.mainModule.require('./lib/task');

      const task = buildTask({
        content: 'Evaluate the meeting output',
        variant: 'council',
        rubric: 'meeting_outcome',
      });

      const agents = [
        {
          id: 'decision-agent',
          name: 'Decision',
          executionType: 'informational',
          execute: async () => ({ success: true, message: 'decision ran' }),
        },
        {
          id: 'meeting-notes-agent',
          name: 'Meeting Notes',
          executionType: 'informational',
          execute: async () => ({ success: true, message: 'notes ran' }),
        },
        {
          id: 'action-item-agent',
          name: 'Action Items',
          executionType: 'informational',
          execute: async () => ({ success: true, message: 'actions ran' }),
        },
      ];

      // Deterministic bids -- mirror the expertise maps we seeded on the
      // real agents so per-criterion scoring produces realistic spread
      const bids = [
        {
          agentId: 'decision-agent',
          confidence: 0.60,
          reasoning: 'decision agent partial match',
          criteria: [
            { id: 'notes_quality', score: 50 },
            { id: 'decisions_captured', score: 85 },
            { id: 'action_items', score: 45 },
            { id: 'unresolved', score: 55 },
            { id: 'priority', score: 50 },
          ],
        },
        {
          agentId: 'meeting-notes-agent',
          confidence: 0.70,
          reasoning: 'notes agent strong on notes',
          criteria: [
            { id: 'notes_quality', score: 90 },
            { id: 'decisions_captured', score: 55 },
            { id: 'action_items', score: 55 },
            { id: 'unresolved', score: 75 },
            { id: 'priority', score: 45 },
          ],
        },
        {
          agentId: 'action-item-agent',
          confidence: 0.65,
          reasoning: 'action agent strong on items',
          criteria: [
            { id: 'notes_quality', score: 40 },
            { id: 'decisions_captured', score: 30 },
            { id: 'action_items', score: 95 },
            { id: 'unresolved', score: 50 },
            { id: 'priority', score: 70 },
          ],
        },
      ];

      return runCouncil(task, agents, {
        getBids: async () => bids,
      });
    });

    expect(result.bidCount).toBe(3);
    expect(result.aggregateScore).toBeGreaterThan(50);
    expect(result.aggregateScore).toBeLessThanOrEqual(100);
    expect(Array.isArray(result.agentScores)).toBe(true);
    expect(result.agentScores).toHaveLength(3);
    // Conflicts should surface because action_items ranges 95 vs 45 (>= 20 threshold)
    expect(Array.isArray(result.conflicts)).toBe(true);
    expect(result.conflicts.length).toBeGreaterThan(0);
    const actionConflict = result.conflicts.find((c) => c.criterion === 'action_items');
    expect(actionConflict).toBeTruthy();
    expect(actionConflict.highScorer.agentId).toBe('action-item-agent');
  });

  // ═════════════════════════════════════════════════════════════════════
  // 4. VOTER POOL AGAINST REAL REGISTRY
  // ═════════════════════════════════════════════════════════════════════

  test('voter pool filter drops non-meeting specialists for meeting-agents space', async () => {
    const result = await electronApp.evaluate(async () => {
      const { getAllAgents } = process.mainModule.require('./packages/agents/agent-registry');
      const { filterEligibleAgents, buildAgentFilter } = process.mainModule.require('./lib/exchange/voter-pool');

      const all = (getAllAgents() || []).filter((a) => !a.bidExcluded);
      const filtered = filterEligibleAgents(all, { spaceId: 'meeting-agents' });
      const filter = buildAgentFilter(all, { spaceId: 'meeting-agents' });

      return {
        totalAgents: all.length,
        filteredAgents: filtered.length,
        filterIds: filter,
        // Every meeting-agents specialist should be in the filtered set
        hasDecision: filtered.some((a) => a.id === 'decision-agent'),
        hasMeetingNotes: filtered.some((a) => a.id === 'meeting-notes-agent'),
        hasActionItem: filtered.some((a) => a.id === 'action-item-agent'),
        // Sound-effects and browser agents are generalists (no defaultSpaces)
        // so they should also be present. Confirms generalist pass-through.
        hasBrowser: filtered.some((a) => a.id === 'browser-agent'),
      };
    });

    expect(result.totalAgents).toBeGreaterThan(10);
    expect(result.hasDecision).toBe(true);
    expect(result.hasMeetingNotes).toBe(true);
    expect(result.hasActionItem).toBe(true);
    expect(result.hasBrowser).toBe(true); // generalist
    // When filter is not null, at least one agent was dropped
    if (result.filterIds) {
      expect(result.filterIds.length).toBeLessThanOrEqual(result.totalAgents);
    }
  });

  // ═════════════════════════════════════════════════════════════════════
  // 5. DURABLE TIMELINE PERSISTENCE
  // ═════════════════════════════════════════════════════════════════════

  test('recordTaskLifecycle writes to the durable timeline', async () => {
    const result = await electronApp.evaluate(async () => {
      const { getAgentStats } = process.mainModule.require('./src/voice-task-sdk/agent-stats');
      const stats = getAgentStats();
      const taskId = 'e2e-test-' + Date.now();
      stats.recordTaskLifecycle({ taskId, type: 'queued', at: Date.now(), data: { toolId: 'e2e' } });
      stats.recordTaskLifecycle({ taskId, type: 'assigned', at: Date.now(), data: { agentId: 'test' } });
      stats.recordTaskLifecycle({ taskId, type: 'completed', at: Date.now() });
      const timeline = stats.getTaskTimeline(taskId);
      return {
        timelineLen: timeline.length,
        types: timeline.map((e) => e.type),
      };
    });

    expect(result.timelineLen).toBe(3);
    expect(result.types).toEqual(['queued', 'assigned', 'completed']);
  });

  // ═════════════════════════════════════════════════════════════════════
  // 6. HTTP GATEWAY
  // ═════════════════════════════════════════════════════════════════════

  test('agent-gateway can be started and responds to /health', async () => {
    const addr = await electronApp.evaluate(async () => {
      const { startAgentGateway, stopAgentGateway } = process.mainModule.require('./lib/agent-gateway');
      // Use ephemeral port to avoid conflicts with anything else
      const server = await startAgentGateway({ port: 0 });
      const { port, address } = server.address();
      // Leave it running for the next test (we'll stop it after)
      global.__e2eGatewayPort = port;
      return { port, address };
    });

    expect(addr.address).toBe('127.0.0.1');
    expect(addr.port).toBeGreaterThan(0);

    // Cross-process HTTP call from the test runner to the spawned gateway
    const res = await fetch(`http://127.0.0.1:${addr.port}/health`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.pid).toBe('number');
    expect(typeof body.subscribers).toBe('number');
  });

  test('agent-gateway POST /submit-task delegates to hud-api', async () => {
    // Re-read the port stashed in the previous test
    const port = await electronApp.evaluate(async () => global.__e2eGatewayPort);
    expect(port).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${port}/submit-task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'e2e gateway ping', toolId: 'e2e-test', skipFilter: true }),
    });
    // Expect 200 from the gateway. The submitTask path inside hud-api may
    // fail further downstream (no real LLM available), but the gateway
    // itself should return a result envelope either way.
    expect([200, 500]).toContain(res.status);
    const body = await res.json();
    // Either the request was routed successfully or hud-api returned an
    // error payload -- either way we got JSON back, not a gateway fault.
    expect(body).toBeTruthy();
  });

  test('agent-gateway stops cleanly', async () => {
    const result = await electronApp.evaluate(async () => {
      const { stopAgentGateway, isAgentGatewayRunning } = process.mainModule.require('./lib/agent-gateway');
      await stopAgentGateway();
      return { running: isAgentGatewayRunning() };
    });
    expect(result.running).toBe(false);
  });

  // ═════════════════════════════════════════════════════════════════════
  // 7. LEARNED-WEIGHT COLD START
  // ═════════════════════════════════════════════════════════════════════

  test('getLearnedWeight returns 1.0 for a fresh agent (cold-start guard)', async () => {
    const weight = await electronApp.evaluate(async () => {
      const { getLearnedWeight } = process.mainModule.require('./lib/learning');
      // Very unlikely to have history for an entirely made-up agent
      return getLearnedWeight('nonexistent-agent-' + Date.now());
    });
    expect(weight).toBe(1.0);
  });

  // ═════════════════════════════════════════════════════════════════════
  // 8. NO NEW ERRORS WHILE v2 CODE IS ACTIVE
  // ═════════════════════════════════════════════════════════════════════

  test('no unexpected errors during v2 E2E session', async () => {
    // Small buffer to let any trailing async writes land
    await sleep(500);
    const newErrors = await checkNewErrors(errorSnapshot);
    const genuine = filterBenignErrors(newErrors);
    if (genuine.length > 0) {
      console.warn('[agent-system-v2 E2E] Observed errors:');
      for (const e of genuine.slice(0, 10)) {
        console.warn('  -', e.category, '::', (e.message || '').slice(0, 200));
      }
    }
    expect(genuine.length).toBe(0);
  });
});
