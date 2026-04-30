/**
 * Bid Calibrator tests (Phase 5 self-learning arbitration)
 *
 * Run: npx vitest run test/unit/agent-learning/bid-calibrator.test.js
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

// vi.hoisted ensures the shared store + factory exist before vi.mock
// factories run (mocks are hoisted to the top of the file). Without
// this, the `const memorySectionStore = new Map()` is in TDZ when the
// agent-memory-store mock factory tries to reference it via the
// makeFakeMemoryStore closure.
const { memorySectionStore, makeFakeMemoryStore } = vi.hoisted(() => {
  const store = new Map();
  function factory() {
    return (agentId) => {
      const key = agentId;
      if (!store.has(key)) store.set(key, new Map());
      const sections = store.get(key);
      return {
        _isFake: true,
        _agentId: agentId,
        load: () => Promise.resolve(undefined),
        save: () => Promise.resolve(undefined),
        getSection: (name) => sections.get(name) || '',
        updateSection: (name, content) => { sections.set(name, content); },
        getSectionNames: () => [...sections.keys()],
        appendToSection: () => {},
      };
    };
  }
  return { memorySectionStore: store, makeFakeMemoryStore: factory };
});

vi.mock('../../../lib/agent-memory-store', () => ({
  getAgentMemory: (agentId) => makeFakeMemoryStore()(agentId),
}));

const {
  BidCalibrator,
  computeCalibration,
  outcomeQuality,
  calibrate,
  getShrinkage,
  renderSection,
  parseCalibrationSection,
  setAgentMemoryGetterForTests,
  CALIBRATION_SECTION,
  MIN_SAMPLES_FOR_CALIBRATION,
  MAX_SHRINKAGE,
} = require('../../../lib/agent-learning/bid-calibrator');

// Wire the test-injection seam so getShrinkage/calibrate read from
// our shared memorySectionStore. This bypasses the unreliable
// vi.mock-CJS-require interception.
setAgentMemoryGetterForTests(makeFakeMemoryStore());

// ============================================================
// outcomeQuality
// ============================================================

describe('outcomeQuality', () => {
  it('returns null with no signals', () => {
    expect(outcomeQuality({})).toBeNull();
    expect(outcomeQuality(null)).toBeNull();
  });

  it('hard veto on userFeedback === "wrong"', () => {
    expect(outcomeQuality({ userFeedback: 'wrong', reflectorScore: 0.9 })).toBe(0);
  });

  it('reflectorScore alone returns the clamped value', () => {
    expect(outcomeQuality({ reflectorScore: 0.7 })).toBeCloseTo(0.7, 5);
    expect(outcomeQuality({ reflectorScore: 1.2 })).toBe(1);
    expect(outcomeQuality({ reflectorScore: -0.5 })).toBe(0);
  });

  it('counterfactual mapping matches the overlap-tuner formula', () => {
    expect(outcomeQuality({ counterfactualJudgment: 'winner-better' })).toBe(1);
    expect(outcomeQuality({ counterfactualJudgment: 'same' })).toBe(0.6);
    expect(outcomeQuality({ counterfactualJudgment: 'runner-up-better' })).toBe(0.2);
  });
});

// ============================================================
// computeCalibration
// ============================================================

describe('computeCalibration', () => {
  function makeDecision(agentId, taskContent, confidence, outcome) {
    return {
      taskId: `t-${Math.random()}`,
      content: taskContent,
      bids: [{ agentId, agentName: agentId, confidence, score: confidence, reasoning: 'r' }],
      chosenWinner: agentId,
      outcome,
    };
  }

  it('returns empty when no decisions are evaluable', () => {
    const decisions = [
      makeDecision('a', 'what is the weather', 0.9, {}), // no signals
      makeDecision('b', 'what is the weather', 0.8, null),
    ];
    const out = computeCalibration(decisions, { minSamples: 1 });
    // No evaluable outcome -> no entries
    expect(out.size).toBe(0);
  });

  it('computes shrinkage for an over-confident agent (synthesized)', () => {
    // Agent 'over' bid 0.9 on weather but only got 0.5 quality.
    // calibrationError = 0.9 - 0.5 = 0.4 -> shrinkage = 0.4 (clamped to MAX).
    const decisions = [];
    for (let i = 0; i < 60; i += 1) {
      decisions.push(makeDecision('over', 'forecast for today', 0.9, { reflectorScore: 0.5 }));
    }
    const out = computeCalibration(decisions, { minSamples: 50, maxShrinkage: 0.4 });
    const overCalib = out.get('over');
    expect(overCalib).toBeDefined();
    const entry = overCalib.get('bucket:weather');
    expect(entry).toBeDefined();
    expect(entry.samples).toBe(60);
    expect(entry.meanConfidence).toBeCloseTo(0.9, 5);
    expect(entry.observedAccuracy).toBeCloseTo(0.5, 5);
    expect(entry.calibrationError).toBeCloseTo(0.4, 5);
    expect(entry.shrinkage).toBeCloseTo(0.4, 5);
    expect(entry.applicable).toBe(true);
  });

  it('does NOT correct under-confidence (shrinkage clamped at 0)', () => {
    // Agent bid 0.5 but performed at 0.9. calibrationError = -0.4.
    // Phase 5 only handles over-confidence; under-confidence shrinkage = 0.
    const decisions = [];
    for (let i = 0; i < 60; i += 1) {
      decisions.push(makeDecision('under', 'what is the weather', 0.5, { reflectorScore: 0.9 }));
    }
    const out = computeCalibration(decisions, { minSamples: 50 });
    const entry = out.get('under').get('bucket:weather');
    expect(entry.calibrationError).toBeCloseTo(-0.4, 5);
    expect(entry.shrinkage).toBe(0);
    expect(entry.applicable).toBe(false); // shrinkage 0 -> not applied
  });

  it('respects MIN_SAMPLES_FOR_CALIBRATION (applicable=false below threshold)', () => {
    const decisions = [];
    for (let i = 0; i < 10; i += 1) {
      decisions.push(makeDecision('a', 'what is the weather', 0.9, { reflectorScore: 0.5 }));
    }
    const out = computeCalibration(decisions, { minSamples: 50 });
    const entry = out.get('a').get('bucket:weather');
    expect(entry.samples).toBe(10);
    expect(entry.applicable).toBe(false);
  });

  it('separates calibration by task class (per-bucket)', () => {
    const decisions = [];
    // Same agent, but a is over-confident on weather, well-calibrated on time.
    for (let i = 0; i < 60; i += 1) {
      decisions.push(makeDecision('multi', 'forecast for today', 0.9, { reflectorScore: 0.5 })); // weather
      decisions.push(makeDecision('multi', 'what time is it now', 0.8, { reflectorScore: 0.85 })); // time
    }
    const out = computeCalibration(decisions, { minSamples: 50 });
    const buckets = out.get('multi');
    expect(buckets.get('bucket:weather').shrinkage).toBeCloseTo(0.4, 5);
    expect(buckets.get('bucket:time').shrinkage).toBeCloseTo(0, 5); // well-calibrated
  });

  it('clamps shrinkage at MAX_SHRINKAGE', () => {
    // Massively over-confident: 0.99 conf, but quality 0 (vetoed).
    // calibrationError = 0.99 -> clamp to 0.4 (default MAX).
    const decisions = [];
    for (let i = 0; i < 60; i += 1) {
      decisions.push(makeDecision('a', 'what is the weather', 0.99, { userFeedback: 'wrong' }));
    }
    const out = computeCalibration(decisions, { minSamples: 50 });
    const entry = out.get('a').get('bucket:weather');
    expect(entry.shrinkage).toBe(0.4);
  });

  it('skips decisions where chosenWinner does not appear in bids', () => {
    const decisions = [
      {
        taskId: 't1',
        content: 'forecast for today',
        bids: [{ agentId: 'someone-else', confidence: 0.9, reasoning: 'r' }],
        chosenWinner: 'phantom',
        outcome: { reflectorScore: 0.5 },
      },
    ];
    const out = computeCalibration(decisions, { minSamples: 1 });
    expect(out.size).toBe(0);
  });
});

// ============================================================
// renderSection / parseCalibrationSection round-trip
// ============================================================

describe('renderSection / parseCalibrationSection', () => {
  it('round-trips a per-class map through the markdown format', () => {
    const map = new Map([
      ['bucket:weather', { samples: 72, meanConfidence: 0.9, observedAccuracy: 0.5, calibrationError: 0.4, shrinkage: 0.4, applicable: true }],
      ['bucket:time', { samples: 30, meanConfidence: 0.8, observedAccuracy: 0.78, calibrationError: 0.02, shrinkage: 0, applicable: false }],
    ]);
    const text = renderSection(map);
    const parsed = parseCalibrationSection(text);
    expect(parsed.size).toBe(2);
    expect(parsed.get('bucket:weather').shrinkage).toBeCloseTo(0.4, 5);
    expect(parsed.get('bucket:weather').applicable).toBe(true);
    expect(parsed.get('bucket:time').applicable).toBe(false);
  });

  it('handles an empty map cleanly', () => {
    const text = renderSection(new Map());
    expect(text).toContain('No calibration data yet');
    const parsed = parseCalibrationSection(text);
    expect(parsed.size).toBe(0);
  });

  it('parses defensively (extra whitespace, mixed marker chars)', () => {
    const text = `
    *  bucket:weather: shrinkage=0.40 | meanConf=0.90 | accuracy=0.50 | n=60 | applied
    -bucket:time: shrinkage=0.00 | meanConf=0.80 | accuracy=0.78 | n=30 | recorded
    `;
    const parsed = parseCalibrationSection(text);
    expect(parsed.size).toBe(2);
  });

  it('returns empty for non-string / empty input', () => {
    expect(parseCalibrationSection(null).size).toBe(0);
    expect(parseCalibrationSection('').size).toBe(0);
    expect(parseCalibrationSection(42).size).toBe(0);
  });
});

// ============================================================
// calibrate / getShrinkage (read path on the hot decision)
// ============================================================

describe('calibrate', () => {
  beforeEach(() => {
    memorySectionStore.clear();
  });

  it('returns the bid unchanged when no calibration data exists', () => {
    const bid = { agentId: 'a', confidence: 0.9, score: 0.9, reasoning: 'r' };
    const out = calibrate(bid, { content: 'what is the weather' });
    expect(out).toBe(bid);
  });

  it('shrinks confidence + score by (1 - shrinkage) when applicable', () => {
    // Pre-populate the fake memory store with a calibration section.
    memorySectionStore.set('a', new Map([[
      CALIBRATION_SECTION,
      '- bucket:weather: shrinkage=0.30 | meanConf=0.90 | accuracy=0.60 | n=60 | applied',
    ]]));
    const bid = { agentId: 'a', confidence: 0.9, score: 0.9, reasoning: 'r' };
    const out = calibrate(bid, { content: 'what is the weather' });
    expect(out.confidence).toBeCloseTo(0.9 * 0.7, 5);
    expect(out.score).toBeCloseTo(0.9 * 0.7, 5);
    expect(out._calibrationAdjustment.shrinkage).toBe(0.3);
    expect(out._calibrationAdjustment.before).toBe(0.9);
    expect(out._calibrationAdjustment.after).toBeCloseTo(0.63, 5);
  });

  it('does not shrink when entry is "recorded" (below MIN_SAMPLES)', () => {
    memorySectionStore.set('a', new Map([[
      CALIBRATION_SECTION,
      '- bucket:weather: shrinkage=0.30 | meanConf=0.90 | accuracy=0.60 | n=10 | recorded',
    ]]));
    const bid = { agentId: 'a', confidence: 0.9, score: 0.9, reasoning: 'r' };
    const out = calibrate(bid, { content: 'what is the weather' });
    expect(out).toBe(bid);
  });

  it('does not shrink when task class differs from any tracked class', () => {
    memorySectionStore.set('a', new Map([[
      CALIBRATION_SECTION,
      '- bucket:weather: shrinkage=0.30 | meanConf=0.90 | accuracy=0.60 | n=60 | applied',
    ]]));
    const bid = { agentId: 'a', confidence: 0.9, score: 0.9, reasoning: 'r' };
    const out = calibrate(bid, { content: 'remind me about the meeting' });
    // task class != bucket:weather -> no shrinkage
    expect(out).toBe(bid);
  });

  it('immutable: does not mutate the input bid', () => {
    memorySectionStore.set('a', new Map([[
      CALIBRATION_SECTION,
      '- bucket:weather: shrinkage=0.30 | meanConf=0.90 | accuracy=0.60 | n=60 | applied',
    ]]));
    const bid = { agentId: 'a', confidence: 0.9, score: 0.9, reasoning: 'r' };
    const before = JSON.stringify(bid);
    calibrate(bid, { content: 'forecast for today' });
    expect(JSON.stringify(bid)).toBe(before);
  });
});

describe('getShrinkage', () => {
  beforeEach(() => { memorySectionStore.clear(); });

  it('returns 0 when no Calibration section', () => {
    expect(getShrinkage('a', 'forecast for today')).toBe(0);
  });

  it('returns the entry shrinkage when applicable', () => {
    memorySectionStore.set('a', new Map([[
      CALIBRATION_SECTION,
      '- bucket:weather: shrinkage=0.25 | meanConf=0.90 | accuracy=0.65 | n=60 | applied',
    ]]));
    expect(getShrinkage('a', 'forecast for today')).toBeCloseTo(0.25, 5);
  });

  it('clamps to MAX_SHRINKAGE if a stale section overflowed', () => {
    memorySectionStore.set('a', new Map([[
      CALIBRATION_SECTION,
      '- bucket:weather: shrinkage=0.99 | meanConf=0.90 | accuracy=0.50 | n=60 | applied',
    ]]));
    expect(getShrinkage('a', 'forecast for today')).toBe(MAX_SHRINKAGE);
  });

  it('returns 0 for empty agentId / empty taskContent', () => {
    expect(getShrinkage('', 'forecast for today')).toBe(0);
    expect(getShrinkage('a', '')).toBe(0);
  });
});

// ============================================================
// BidCalibrator.runOnce
// ============================================================

describe('BidCalibrator.runOnce', () => {
  let storage;
  beforeEach(() => {
    memorySectionStore.clear();
    storage = {
      index: { spaces: [{ id: 'arbitration-decisions' }], items: [] },
    };
  });

  function makeItem(agentId, taskContent, confidence, outcome, daysAgo = 1) {
    const ts = Date.now() - daysAgo * 24 * 60 * 60 * 1000;
    return {
      spaceId: 'arbitration-decisions',
      timestamp: ts,
      content: JSON.stringify({
        taskId: `t-${Math.random()}`,
        content: taskContent,
        bids: [{ agentId, confidence, score: confidence, reasoning: 'r' }],
        chosenWinner: agentId,
        outcome,
      }),
    };
  }

  it('writes a Calibration section per agent observed in the corpus', async () => {
    for (let i = 0; i < 60; i += 1) {
      storage.index.items.push(
        makeItem('over', 'what is the weather', 0.9, { reflectorScore: 0.5 }),
      );
    }
    const calibrator = new BidCalibrator({
      spacesAPI: { storage },
      getMemory: makeFakeMemoryStore(),
    });
    const result = await calibrator.runOnce();
    expect(result.sampleSize).toBe(60);
    expect(result.agentsCalibrated).toBe(1);
    const sections = memorySectionStore.get('over');
    expect(sections).toBeDefined();
    expect(sections.get('Calibration')).toContain('bucket:weather');
    expect(sections.get('Calibration')).toContain('applied');
  });

  it('writes an empty-record section when no class crosses MIN_SAMPLES', async () => {
    // Just 5 decisions -- not enough.
    for (let i = 0; i < 5; i += 1) {
      storage.index.items.push(
        makeItem('few', 'forecast', 0.9, { reflectorScore: 0.5 }),
      );
    }
    const calibrator = new BidCalibrator({
      spacesAPI: { storage },
      getMemory: makeFakeMemoryStore(),
    });
    const result = await calibrator.runOnce();
    // The agent IS in the calibration map (5 decisions registered),
    // but the entry's applicable=false; section reflects that.
    expect(result.agentsCalibrated).toBe(1);
    const sections = memorySectionStore.get('few');
    // Match the line marker `| recorded` exactly, not the word
    // "recorded" in the section's auto-generated header note.
    expect(sections.get('Calibration')).toMatch(/\|\s*recorded\b/);
    expect(sections.get('Calibration')).not.toMatch(/\|\s*applied\b/);
  });

  it('skips items outside the rolling window (>30 days old)', async () => {
    for (let i = 0; i < 60; i += 1) {
      storage.index.items.push(
        makeItem('old', 'forecast', 0.9, { reflectorScore: 0.5 }, 60),
      );
    }
    const calibrator = new BidCalibrator({
      spacesAPI: { storage },
      getMemory: makeFakeMemoryStore(),
    });
    const result = await calibrator.runOnce();
    expect(result.sampleSize).toBe(0);
    expect(result.agentsCalibrated).toBe(0);
  });
});

describe('exports', () => {
  it('MIN_SAMPLES_FOR_CALIBRATION is 50', () => {
    expect(MIN_SAMPLES_FOR_CALIBRATION).toBe(50);
  });

  it('MAX_SHRINKAGE is 0.4', () => {
    expect(MAX_SHRINKAGE).toBe(0.4);
  });

  it('CALIBRATION_SECTION is "Calibration"', () => {
    expect(CALIBRATION_SECTION).toBe('Calibration');
  });
});
