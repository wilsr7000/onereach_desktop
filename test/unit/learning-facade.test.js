/**
 * Learning Facade -- Unit Tests
 *
 * Verifies recordBidOutcome fans out correctly to the three learning
 * stores, that getLearnedWeight clamps to [0.5, 1.5] and falls back to
 * 1.0 when data is missing, and that the snapshot composes correctly.
 *
 * We swap the real stores out by mutating require.cache so the facade
 * picks up fakes. This keeps the test free of Vitest's CommonJS module-
 * resolution quirks (same approach as council-runner tests).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const path = require('path');

const facade = require('../../lib/learning/index');
const {
  recordBidOutcome,
  getLearnedWeight,
  getAgentSnapshot,
  _deriveAgentType,
  _resetLearningForTests,
} = facade;

// ---- Fake stores -----------------------------------------------------

function _makeAgentStatsFake() {
  const calls = { recordWin: [], recordSuccess: [], recordFailure: [] };
  return {
    calls,
    module: {
      getAgentStats: () => ({
        recordWin: (id) => calls.recordWin.push(id),
        recordSuccess: (id, ms) => calls.recordSuccess.push([id, ms]),
        recordFailure: (id, err, ms) => calls.recordFailure.push([id, err, ms]),
        getStats: (id) => ({ totalBids: 3, wins: 2, agentId: id }),
      }),
    },
  };
}

function _makeMetaLearningFake(weights = { calendar: 1.3 }, samples = 50) {
  const outcomes = [];
  return {
    outcomes,
    module: {
      // evaluation-handlers exports a getter; we emulate that surface so
      // the facade's first-choice branch (use the shared singleton) is
      // exercised.
      getMetaLearning: () => ({
        recordOutcome: async (evalId, data) => { outcomes.push({ evalId, data }); },
        agentMemory: {
          getRecommendedWeight: (agentType) => weights[agentType] ?? 1.0,
          // Return enough totalEvaluations to clear the cold-start
          // guard in the facade. Individual tests that want to
          // exercise cold-start can override samples to 0.
          getMemory: (agentType) => ({
            agentType,
            accuracy: 0.8,
            totalEvaluations: samples,
          }),
        },
      }),
    },
  };
}

function _makeAgentLearningFake() {
  const records = [];
  return {
    records,
    module: {
      InteractionCollector: class {
        // eslint-disable-next-line class-methods-use-this
        async record(data) { records.push(data); }
      },
    },
  };
}

// Install fakes by overriding the require cache entries for the three
// modules. Paths match what lib/learning/index.js uses internally.
// `fake` is either `{ module: exportsObj }` (produced by our _make*
// helpers) or a bare exports object.
function _installFakes({ stats, meta, learning }) {
  const map = {
    '../../src/voice-task-sdk/agent-stats': stats,
    '../ipc/evaluation-handlers': meta,
    '../agent-learning/interaction-collector': learning,
  };
  for (const [rel, fake] of Object.entries(map)) {
    if (!fake) continue;
    const exportsObj = fake.module || fake;
    const abs = path.resolve(__dirname, '../../lib/learning/', rel + '.js');
    require.cache[abs] = {
      id: abs,
      filename: abs,
      loaded: true,
      exports: exportsObj,
    };
  }

  // Always stub the meta-learning module fallback so a test that does
  // not install a meta fake does not silently spin up the real
  // subsystem (which would hit disk / disturb state). `lib/meta-learning/`
  // is a directory so Node resolves the require to its index.js.
  const metaAbs = path.resolve(__dirname, '../../lib/meta-learning/index.js');
  if (!require.cache[metaAbs]) {
    require.cache[metaAbs] = {
      id: metaAbs,
      filename: metaAbs,
      loaded: true,
      exports: { createMetaLearningSystem: () => null },
    };
  }
}

function _uninstallFakes() {
  const rels = [
    '../../src/voice-task-sdk/agent-stats',
    '../ipc/evaluation-handlers',
    '../agent-learning/interaction-collector',
  ];
  for (const rel of rels) {
    const abs = path.resolve(__dirname, '../../lib/learning/', rel + '.js');
    delete require.cache[abs];
  }
  // The meta-learning stub is stored by its own absolute path (not
  // relative to lib/learning/) so clean it separately.
  delete require.cache[path.resolve(__dirname, '../../lib/meta-learning/index.js')];
}

beforeEach(() => {
  _resetLearningForTests();
});

afterEach(() => {
  _uninstallFakes();
  _resetLearningForTests();
});

// ---- _deriveAgentType ------------------------------------------------

describe('_deriveAgentType', () => {
  it('strips the -agent suffix', () => {
    expect(_deriveAgentType('calendar-query-agent')).toBe('calendar-query');
    expect(_deriveAgentType('weather-agent')).toBe('weather');
  });

  it('is case-insensitive', () => {
    expect(_deriveAgentType('Calendar-AGENT')).toBe('calendar');
  });

  it('returns unknown for non-strings', () => {
    expect(_deriveAgentType(null)).toBe('unknown');
    expect(_deriveAgentType(42)).toBe('unknown');
  });
});

// ---- recordBidOutcome ------------------------------------------------

describe('recordBidOutcome', () => {
  it('rejects missing agentId or taskId gracefully', async () => {
    expect(await recordBidOutcome(null)).toEqual({ stats: false, meta: false, agentLearning: false });
    expect(await recordBidOutcome({})).toEqual({ stats: false, meta: false, agentLearning: false });
    expect(await recordBidOutcome({ agentId: 'a' })).toEqual({ stats: false, meta: false, agentLearning: false });
  });

  it('fans out a winning + successful bid to all three stores', async () => {
    const stats = _makeAgentStatsFake();
    const meta = _makeMetaLearningFake();
    const learning = _makeAgentLearningFake();
    _installFakes({ stats: stats.module, meta: meta.module, learning: learning.module });

    const result = await recordBidOutcome({
      agentId: 'calendar-query-agent',
      taskId: 't1',
      confidence: 0.9,
      won: true,
      success: true,
      durationMs: 1200,
      evaluationId: 'eval-1',
      documentType: 'code',
    });

    expect(result.stats).toBe(true);
    expect(stats.calls.recordWin).toEqual(['calendar-query-agent']);
    expect(stats.calls.recordSuccess).toEqual([['calendar-query-agent', 1200]]);

    expect(result.meta).toBe(true);
    expect(meta.outcomes).toHaveLength(1);
    expect(meta.outcomes[0].data.agentType).toBe('calendar-query');

    expect(result.agentLearning).toBe(true);
    expect(learning.records).toHaveLength(1);
    expect(learning.records[0]).toMatchObject({
      agentId: 'calendar-query-agent',
      success: true,
      won: true,
    });
  });

  it('does not call recordWin when won is false', async () => {
    const stats = _makeAgentStatsFake();
    _installFakes({ stats: stats.module });

    await recordBidOutcome({
      agentId: 'a-agent',
      taskId: 't1',
      confidence: 0.3,
      won: false,
      success: false,
    });

    expect(stats.calls.recordWin).toHaveLength(0);
    // Didn't win, so no execution happened -- no failure recorded either.
    expect(stats.calls.recordFailure).toHaveLength(0);
  });

  it('records a failure when the winner executed but failed', async () => {
    const stats = _makeAgentStatsFake();
    _installFakes({ stats: stats.module });

    await recordBidOutcome({
      agentId: 'a-agent',
      taskId: 't1',
      confidence: 0.8,
      won: true,
      success: false,
      durationMs: 300,
      error: 'timeout',
    });

    expect(stats.calls.recordFailure).toEqual([['a-agent', 'timeout', 300]]);
  });

  it('skips meta-learning fan-out when no evaluationId is provided', async () => {
    const meta = _makeMetaLearningFake();
    _installFakes({ meta: meta.module });

    const result = await recordBidOutcome({
      agentId: 'a-agent',
      taskId: 't1',
      confidence: 0.8,
      won: true,
      success: true,
    });

    expect(result.meta).toBe(false);
    expect(meta.outcomes).toHaveLength(0);
  });

  it('defaults accuracy from win/success/confidence when not provided', async () => {
    const meta = _makeMetaLearningFake();
    _installFakes({ meta: meta.module });

    await recordBidOutcome({
      agentId: 'a-agent',
      taskId: 't1',
      confidence: 0.9,
      won: true,
      success: true,
      evaluationId: 'eval-1',
    });

    expect(meta.outcomes[0].data.accuracy).toBe(true);
  });

  it('errors in one store do not prevent the others from recording', async () => {
    const stats = {
      module: {
        getAgentStats: () => ({
          recordWin: () => { throw new Error('stats explode'); },
          recordSuccess: () => { throw new Error('stats explode'); },
          getStats: () => null,
        }),
      },
    };
    const learning = _makeAgentLearningFake();
    _installFakes({ stats: stats.module, learning: learning.module });

    const result = await recordBidOutcome({
      agentId: 'a-agent',
      taskId: 't1',
      confidence: 0.8,
      won: true,
      success: true,
    });

    // stats reports failure but learning path still ran
    expect(result.stats).toBe(false);
    expect(result.agentLearning).toBe(true);
    expect(learning.records).toHaveLength(1);
  });
});

// ---- getLearnedWeight ------------------------------------------------

describe('getLearnedWeight', () => {
  it('returns 1.0 when meta-learning is unavailable', () => {
    _installFakes({ meta: { module: { getMetaLearning: () => null } } });
    expect(getLearnedWeight('a-agent')).toBe(1.0);
  });

  it('returns 1.0 for falsy agentId', () => {
    expect(getLearnedWeight('')).toBe(1.0);
    expect(getLearnedWeight(null)).toBe(1.0);
  });

  it('looks up by derived agentType', () => {
    _installFakes({ meta: _makeMetaLearningFake({ calendar: 1.3 }).module });
    expect(getLearnedWeight('calendar-agent')).toBe(1.3);
  });

  it('respects explicit agentType override', () => {
    _installFakes({ meta: _makeMetaLearningFake({ expert: 1.2 }).module });
    expect(getLearnedWeight('x-agent', { agentType: 'expert' })).toBe(1.2);
  });

  it('clamps out-of-range weights to [0.5, 1.5]', () => {
    _installFakes({ meta: _makeMetaLearningFake({ hot: 5.0, cold: 0.1 }).module });
    expect(getLearnedWeight('hot-agent')).toBe(1.5);
    expect(getLearnedWeight('cold-agent')).toBe(0.5);
  });

  it('falls back to 1.0 on non-numeric weight', () => {
    _installFakes({
      meta: {
        module: {
          getMetaLearning: () => ({
            agentMemory: { getRecommendedWeight: () => 'NaN' },
          }),
        },
      },
    });
    expect(getLearnedWeight('a-agent')).toBe(1.0);
  });

  it('cold-start: returns 1.0 when the agent has fewer than 5 recorded outcomes', () => {
    _installFakes({
      meta: {
        module: {
          getMetaLearning: () => ({
            agentMemory: {
              getRecommendedWeight: () => 1.4, // would apply if samples were sufficient
              getMemory: () => ({ agentType: 'unseen', totalEvaluations: 3 }),
            },
          }),
        },
      },
    });
    expect(getLearnedWeight('unseen-agent')).toBe(1.0);
  });

  it('applies learned weight once the agent clears the cold-start threshold', () => {
    _installFakes({
      meta: {
        module: {
          getMetaLearning: () => ({
            agentMemory: {
              getRecommendedWeight: () => 1.4,
              getMemory: () => ({ agentType: 'seasoned', totalEvaluations: 20 }),
            },
          }),
        },
      },
    });
    expect(getLearnedWeight('seasoned-agent')).toBe(1.4);
  });
});

// ---- getAgentSnapshot ------------------------------------------------

describe('getAgentSnapshot', () => {
  it('composes stats + weight + memory', () => {
    const stats = _makeAgentStatsFake();
    const meta = _makeMetaLearningFake({ calendar: 1.2 });
    _installFakes({ stats: stats.module, meta: meta.module });

    const snap = getAgentSnapshot('calendar-agent');
    expect(snap.agentId).toBe('calendar-agent');
    expect(snap.agentType).toBe('calendar');
    expect(snap.stats).toMatchObject({ totalBids: 3 });
    expect(snap.weight).toBe(1.2);
    expect(snap.memory).toMatchObject({ agentType: 'calendar', accuracy: 0.8 });
  });

  it('returns safe defaults when subsystems are missing', () => {
    _installFakes({
      meta: { module: { getMetaLearning: () => null } },
      stats: { module: { getAgentStats: () => null } },
    });
    const snap = getAgentSnapshot('lonely-agent');
    expect(snap.weight).toBe(1.0);
    expect(snap.stats).toBe(null);
  });
});
