/**
 * HUD Core Barrel - External Consumer Integration Test
 *
 * Simulates a non-desktop consumer (GSX flow / WISER / CLI) wiring
 * up the HUD core via the stable barrel only. No deep imports. If
 * this file breaks, the public surface broke.
 *
 * Run:  npx vitest run test/unit/hud-core-barrel.test.js
 */

import { describe, it, expect } from 'vitest';

// The ONLY import a consumer should need.
const hudCore = require('../../lib/hud-core');

describe('hud-core barrel: shape', () => {
  it('exports the task command router', () => {
    expect(typeof hudCore.classifyTaskCommand).toBe('function');
    expect(typeof hudCore.isCriticalCommand).toBe('function');
    expect(hudCore.taskCommandRouter).toBeTruthy();
    expect(Array.isArray(hudCore.taskCommandRouter.EXACT_CRITICAL)).toBe(true);
  });

  it('exports the voter pool', () => {
    expect(hudCore.voterPool).toBeTruthy();
    expect(typeof hudCore.voterPool.isAgentEligible).toBe('function');
    expect(typeof hudCore.voterPool.filterEligibleAgents).toBe('function');
    expect(typeof hudCore.voterPool.buildAgentFilter).toBe('function');
  });

  it('exports the council adapter', () => {
    expect(hudCore.councilAdapter).toBeTruthy();
    expect(typeof hudCore.councilAdapter.bidToEvaluation).toBe('function');
    expect(typeof hudCore.councilAdapter.bidsToEvaluations).toBe('function');
    expect(typeof hudCore.councilAdapter.buildConsolidateContext).toBe('function');
  });

  it('exports identity correction', () => {
    expect(hudCore.identityCorrection).toBeTruthy();
    expect(typeof hudCore.identityCorrection.detectIdentityCorrection).toBe('function');
  });

  it('exports conversation continuity (Phase 2)', () => {
    expect(typeof hudCore.pickContinuityAgent).toBe('function');
    expect(typeof hudCore.createContinuityTracker).toBe('function');
    expect(hudCore.conversationContinuity).toBeTruthy();
  });

  it('exports pending state classifier (Phase 2)', () => {
    expect(typeof hudCore.classifyPendingState).toBe('function');
    expect(typeof hudCore.shouldRouteToPendingStateHandler).toBe('function');
    expect(typeof hudCore.normalizeRoutingContext).toBe('function');
    expect(hudCore.pendingState).toBeTruthy();
  });

  it('exports bid protocol (Phase 3)', () => {
    expect(typeof hudCore.isValidBid).toBe('function');
    expect(typeof hudCore.isValidBidRequest).toBe('function');
    expect(typeof hudCore.isValidBidResponse).toBe('function');
    expect(typeof hudCore.buildBidRequest).toBe('function');
    expect(typeof hudCore.buildBidResponse).toBe('function');
    expect(typeof hudCore.normalizeBid).toBe('function');
    expect(typeof hudCore.computeBidDeadline).toBe('function');
    expect(typeof hudCore.shouldCloseAuctionEarly).toBe('function');
    expect(typeof hudCore.createTimeoutPolicy).toBe('function');
    expect(hudCore.BID_TIERS).toBeTruthy();
    expect(hudCore.DEFAULT_BID_WINDOW_MS).toBe(2000);
  });

  it('exports dedup (Phase 6)', () => {
    expect(typeof hudCore.normalizeTranscript).toBe('function');
    expect(typeof hudCore.isDuplicateSubmission).toBe('function');
    expect(typeof hudCore.createDedupTracker).toBe('function');
    expect(hudCore.dedup).toBeTruthy();
  });

  it('exports task decomposer (Phase 5)', () => {
    expect(typeof hudCore.createTaskDecomposer).toBe('function');
    expect(typeof hudCore.shouldSkipDecomposition).toBe('function');
    expect(typeof hudCore.buildDecompositionPrompt).toBe('function');
    expect(typeof hudCore.parseDecompositionResult).toBe('function');
    expect(hudCore.taskDecomposer).toBeTruthy();
  });

  it('exports winner selection (Phase 4)', () => {
    expect(typeof hudCore.pickWinnerFastPath).toBe('function');
    expect(typeof hudCore.fallbackSelection).toBe('function');
    expect(typeof hudCore.applyMultiIntentOverride).toBe('function');
    expect(typeof hudCore.hasMultiIntent).toBe('function');
    expect(typeof hudCore.validateWinners).toBe('function');
    expect(hudCore.winnerSelection).toBeTruthy();
  });

  it('exports result consolidator (Phase 7)', () => {
    expect(typeof hudCore.normalizeResult).toBe('function');
    expect(typeof hudCore.extractDeliveryMessage).toBe('function');
    expect(typeof hudCore.extractLearningMessage).toBe('function');
    expect(typeof hudCore.hasPanel).toBe('function');
    expect(typeof hudCore.agentIdToDisplayName).toBe('function');
    expect(typeof hudCore.buildDeliveryEnvelope).toBe('function');
    expect(hudCore.resultConsolidator).toBeTruthy();
  });
});

describe('task command router: consumer scenarios', () => {
  it('a CLI app can classify a critical command in one call', () => {
    expect(hudCore.isCriticalCommand('cancel')).toBe(true);
    expect(hudCore.isCriticalCommand('cancel the meeting')).toBe(false);
  });

  it('the full classification result is available for logging', () => {
    const r = hudCore.classifyTaskCommand('stop now');
    expect(r).toEqual({
      critical: true,
      matched: 'stop now',
      pattern: 'verb-pronoun',
    });
  });
});

describe('voter pool: consumer scenarios', () => {
  it('filters agents by spaceId when defaultSpaces is declared', () => {
    const agents = [
      { id: 'meeting-agent', defaultSpaces: ['meeting-agents'] },
      { id: 'generalist-agent' }, // no defaultSpaces -> always eligible
      { id: 'sound-effects-agent', defaultSpaces: ['sound-effects'] },
    ];
    const task = { spaceId: 'meeting-agents', content: 'schedule a sync' };

    const eligible = hudCore.voterPool.filterEligibleAgents(agents, task);
    const ids = eligible.map((a) => a.id).sort();
    expect(ids).toEqual(['generalist-agent', 'meeting-agent']);
  });

  it('no task spaceId = no filter applied (all agents eligible)', () => {
    const agents = [
      { id: 'a', defaultSpaces: ['x'] },
      { id: 'b' },
    ];
    const task = { content: 'hello' };
    expect(hudCore.voterPool.filterEligibleAgents(agents, task)).toHaveLength(2);
  });
});

describe('council adapter: consumer scenarios', () => {
  it('maps a bid to an evaluation entry', () => {
    const bid = {
      agentId: 'weather-agent',
      confidence: 0.82,
      reasoning: 'Strong match. Concerned about location ambiguity.',
      plan: 'Call weather API with detected coordinates.',
      hallucinationRisk: 0.1,
    };
    const evaluation = hudCore.councilAdapter.bidToEvaluation(bid);
    expect(evaluation).toBeTruthy();
    expect(evaluation.overallScore).toBe(82);
  });

  it('maps an array of bids at once (default confidence floor 0.5)', () => {
    const bids = [
      { agentId: 'a', confidence: 0.9, reasoning: '' },
      { agentId: 'b', confidence: 0.7, reasoning: '' },
      { agentId: 'c', confidence: 0.3, reasoning: '' }, // below default floor
    ];
    const evals = hudCore.councilAdapter.bidsToEvaluations(bids);
    expect(evals).toHaveLength(2);
    expect(evals[0].overallScore).toBe(90);
    expect(evals[1].overallScore).toBe(70);
  });

  it('a custom confidenceFloor of 0 retains all bids', () => {
    const bids = [
      { agentId: 'a', confidence: 0.9, reasoning: '' },
      { agentId: 'c', confidence: 0.1, reasoning: '' },
    ];
    const evals = hudCore.councilAdapter.bidsToEvaluations(bids, {
      confidenceFloor: 0,
    });
    expect(evals).toHaveLength(2);
  });
});

describe('identity correction: consumer scenarios', () => {
  it('detects a retraction-only pattern', () => {
    const r = hudCore.identityCorrection.detectIdentityCorrection(
      "I don't live in Vegas"
    );
    expect(r).toBeTruthy();
    expect(r.kind || r.type).toBeTruthy(); // module shape: some label
  });

  it('returns null for non-corrections', () => {
    expect(
      hudCore.identityCorrection.detectIdentityCorrection('play some jazz')
    ).toBeNull();
  });
});

describe('conversation continuity: consumer scenarios', () => {
  it('stateful tracker records wins and picks continuity agent', () => {
    let clock = 1_000_000;
    const tracker = hudCore.createContinuityTracker({
      windowMs: 60_000,
      now: () => clock,
    });
    tracker.recordWin('weather-agent', { text: 'forecast for tomorrow' });
    clock += 5_000;
    tracker.recordWin('calendar-agent');
    clock += 2_000;
    expect(tracker.pickContinuityAgent().agentId).toBe('calendar-agent');
  });

  it('pure pickContinuityAgent works for consumers with external win stores', () => {
    const wins = [
      { agentId: 'a', timestamp: 1000 },
      { agentId: 'b', timestamp: 5000 },
    ];
    const r = hudCore.pickContinuityAgent({ wins, now: 6000, windowMs: 10_000 });
    expect(r.agentId).toBe('b');
  });

  it('expired wins yield null', () => {
    const r = hudCore.pickContinuityAgent({
      wins: [{ agentId: 'a', timestamp: 100 }],
      now: 300_000,
      windowMs: 120_000,
    });
    expect(r).toBeNull();
  });
});

describe('pending state: consumer scenarios', () => {
  it('open question -> should route to pending-state handler', () => {
    const ctx = { hasPendingQuestion: true, pendingAgentId: 'calendar', pendingField: 'time' };
    const r = hudCore.classifyPendingState(ctx);
    expect(r.kind).toBe('question');
    expect(r.shouldHandleAsPending).toBe(true);
    expect(hudCore.shouldRouteToPendingStateHandler(ctx)).toBe(true);
  });

  it('pending confirmation -> kind confirmation', () => {
    const ctx = { hasPendingConfirmation: true, pendingAgentId: 'email' };
    expect(hudCore.classifyPendingState(ctx).kind).toBe('confirmation');
  });

  it('no pending state -> auction proceeds normally', () => {
    expect(hudCore.shouldRouteToPendingStateHandler({})).toBe(false);
    expect(hudCore.shouldRouteToPendingStateHandler(null)).toBe(false);
  });

  it('normalizeRoutingContext strips junk fields for cross-network transport', () => {
    const raw = JSON.parse(
      JSON.stringify({
        hasPendingQuestion: true,
        pendingAgentId: 'calendar',
        random: 'should be dropped',
      })
    );
    const clean = hudCore.normalizeRoutingContext(raw);
    expect(clean.random).toBeUndefined();
    expect(clean.pendingAgentId).toBe('calendar');
  });
});

describe('winner selection: consumer scenarios', () => {
  it('a CLI app with only bids (no LLM) can use fast-path + fallback', () => {
    const bids = [
      { agentId: 'weather', confidence: 0.85 },
      { agentId: 'time', confidence: 0.4 },
    ];
    // Fast path fires because gap > 0.3.
    const decision = hudCore.pickWinnerFastPath(bids);
    expect(decision.winners).toEqual(['weather']);
    expect(decision.executionMode).toBe('single');
  });

  it('close bids require LLM -> consumer uses fallback when no LLM available', () => {
    const bids = [
      { agentId: 'weather', confidence: 0.75 },
      { agentId: 'time', confidence: 0.6 },
    ];
    expect(hudCore.pickWinnerFastPath(bids)).toBeNull();
    // Consumer can fall back to the deterministic highest-scorer.
    const fb = hudCore.fallbackSelection(bids);
    expect(fb.winners).toEqual(['weather']);
  });

  it('consumer can run the full decision flow: fast-path -> LLM? -> override -> validate', () => {
    const bids = [
      { agentId: 'weather', confidence: 0.6 },
      { agentId: 'time', confidence: 0.55 },
      { agentId: 'dj', confidence: 0.5 },
    ];
    const task = 'what time is it';

    // Fast-path returns null (close bids).
    const fast = hudCore.pickWinnerFastPath(bids);
    expect(fast).toBeNull();

    // Simulate an LLM returning multiple winners on a simple task.
    const llmResult = {
      winners: ['weather', 'time'],
      executionMode: 'parallel',
    };

    // Override strips multi-winner on single-intent tasks.
    const corrected = hudCore.applyMultiIntentOverride(llmResult, task);
    expect(corrected.winners).toEqual(['weather']);
    expect(corrected.executionMode).toBe('single');

    // Validate against actual bid list.
    const validated = hudCore.validateWinners(corrected.winners, bids);
    expect(validated).toEqual(['weather']);
  });

  it('consumer can apply multi-intent override that keeps all winners on "and" task', () => {
    const llmResult = { winners: ['calendar', 'dj'], executionMode: 'parallel' };
    const corrected = hudCore.applyMultiIntentOverride(
      llmResult,
      'check my calendar and play music'
    );
    expect(corrected.winners).toEqual(['calendar', 'dj']);
    expect(corrected.executionMode).toBe('parallel');
  });
});

describe('bid protocol: consumer scenarios', () => {
  it('a GSX flow can build a bid request + validate replies in one pass', () => {
    const req = hudCore.buildBidRequest({
      auctionId: 'a1',
      task: { id: 't1', content: 'play jazz' },
      context: {
        queueDepth: 0,
        conversationHistory: [],
        conversationText: '',
        participatingAgents: ['dj', 'weather'],
      },
      deadline: hudCore.computeBidDeadline({ now: 1000, windowMs: 2000 }),
    });
    expect(hudCore.isValidBidRequest(req)).toBe(true);
    expect(req.deadline).toBe(3000);

    // Agent replies arrive; consumer validates before ranking.
    const goodReply = hudCore.buildBidResponse({
      auctionId: 'a1',
      agentId: 'dj',
      agentVersion: '1.0.0',
      bid: { confidence: 0.82, reasoning: 'music request', estimatedTimeMs: 80, tier: 'llm' },
    });
    expect(hudCore.isValidBidResponse(goodReply)).toBe(true);

    const noBid = hudCore.buildBidResponse({
      auctionId: 'a1',
      agentId: 'weather',
      agentVersion: '1.0.0',
    });
    expect(hudCore.isValidBidResponse(noBid)).toBe(true);
    expect(noBid.bid).toBeNull();
  });

  it('timeout policy: consumer waits until deadline OR all bids in', () => {
    let clock = 0;
    const tp = hudCore.createTimeoutPolicy({ windowMs: 1000, now: () => clock });

    // At 200ms only 1 of 3 bids; keep waiting.
    clock = 200;
    expect(tp.isExpired()).toBe(false);
    expect(tp.shouldClose(1, 3)).toBe(false);

    // All 3 arrive at 400ms; close early.
    clock = 400;
    expect(tp.shouldClose(3, 3)).toBe(true);

    // Had they not arrived, we'd close on timeout at 1000ms.
    clock = 1001;
    expect(tp.isExpired()).toBe(true);
  });

  it('normalizeBid tick-rounds and defaults optional fields', () => {
    const b = hudCore.normalizeBid({
      agentId: 'dj',
      confidence: 0.82,        // off-tick
      reasoning: 'music',
    });
    expect(hudCore.isValidBid(b)).toBe(true);
    expect(b.confidence).toBeCloseTo(0.8, 10);
    expect(b.tier).toBe('llm');
  });

  it('rejects malformed bids before they reach the ranker', () => {
    expect(hudCore.isValidBid({ agentId: 'x', confidence: 0.5 })).toBe(false);
    expect(hudCore.isValidBid(null)).toBe(false);
  });
});

describe('dedup: consumer scenarios', () => {
  it('stateful tracker dedupes incremental STT partials', () => {
    let clock = 0;
    const d = hudCore.createDedupTracker({ windowMs: 3000, now: () => clock });

    // Partial transcript arrives first.
    expect(d.check('can you play it on?').duplicate).toBe(false);
    d.record('can you play it on?');

    // Final transcript is a superset of the partial -> caught as dup.
    clock = 200;
    const r = d.check('can you play it on my speaker?');
    expect(r.duplicate).toBe(true);
  });

  it('normalization handles case + punctuation on both sides', () => {
    let clock = 0;
    const d = hudCore.createDedupTracker({ windowMs: 3000, now: () => clock });
    d.record('Play Jazz!');
    clock = 100;
    expect(d.check('play jazz').duplicate).toBe(true);
  });

  it('a distributed consumer can reuse the pure decision against their own store', () => {
    // Simulate a Redis-backed store that produces {text, time}[].
    const fromRedis = [
      { text: 'play some jazz', time: 900 },
      { text: 'check my calendar', time: 800 },
    ];
    const r = hudCore.isDuplicateSubmission({
      normalized: hudCore.normalizeTranscript('Play some jazz!'),
      recent: fromRedis,
      now: 1000,
      windowMs: 3000,
    });
    expect(r.duplicate).toBe(true);
    expect(r.match.text).toBe('play some jazz');
  });
});

describe('task decomposer: consumer scenarios', () => {
  it('consumer wires their own ai adapter and decomposes a composite task', async () => {
    // Consumer's text-returning LLM wrapped to speak the ai.json shape:
    const fakeAi = {
      json: async (_prompt, _opts) => ({
        isComposite: true,
        subtasks: ['play jazz', 'check my calendar'],
        reasoning: 'two independent domains',
      }),
    };
    const decomposer = hudCore.createTaskDecomposer({ ai: fakeAi });
    const r = await decomposer.decomposeIfNeeded(
      'please play some jazz and also check my calendar for tomorrow morning'
    );
    expect(r.isComposite).toBe(true);
    expect(r.subtasks).toHaveLength(2);
  });

  it('no-ai-port consumer: decomposer degrades gracefully', async () => {
    const decomposer = hudCore.createTaskDecomposer();
    const r = await decomposer.decomposeIfNeeded(
      'please play some jazz and also check my calendar for tomorrow morning'
    );
    expect(r.isComposite).toBe(false);
    expect(r.skipped).toBe('no-ai-port');
  });

  it('fast-path guards prevent LLM cost on trivially-single requests', async () => {
    const ai = { json: async () => { throw new Error('should not be called'); } };
    const decomposer = hudCore.createTaskDecomposer({ ai });
    await expect(decomposer.decomposeIfNeeded('play jazz')).resolves.toMatchObject({
      isComposite: false,
      skipped: expect.stringMatching(/below-min-words/),
    });
  });
});

describe('result consolidator: consumer scenarios', () => {
  it('full pipeline: agent result -> delivery envelope a consumer can speak + render', () => {
    const agentResult = {
      success: true,
      output: 'The weather is clear, 72 degrees.',
      data: { temp: 72, condition: 'clear' },
      html: '<div>72F Clear</div>',
    };
    const envelope = hudCore.buildDeliveryEnvelope(agentResult, {
      taskId: 't-42',
      agentId: 'weather-agent',
    });
    // Voice consumer: speak envelope.message
    expect(envelope.message).toBe('The weather is clear, 72 degrees.');
    // Panel consumer: render envelope.html when envelope.hasPanel
    expect(envelope.hasPanel).toBe(true);
    expect(envelope.html).toBe('<div>72F Clear</div>');
    // Display name auto-derived
    expect(envelope.agentName).toBe('Weather Agent');
  });

  it('handles the data.output fallback path (common legacy agent shape)', () => {
    const result = {
      success: true,
      data: { output: 'From data.output', track: 'xyz' },
    };
    expect(hudCore.extractDeliveryMessage(result)).toBe('From data.output');
  });

  it('learning pipeline consumer: bounded string safe to log', () => {
    const bigResult = { output: 'x'.repeat(9_000) };
    const learning = hudCore.extractLearningMessage(bigResult);
    expect(learning.length).toBe(500);
  });

  it('failure with no message -> envelope.message is null (caller handles)', () => {
    const envelope = hudCore.buildDeliveryEnvelope({ success: false }, { agentId: 'x' });
    expect(envelope.message).toBeNull();
    expect(envelope.success).toBe(false);
  });
});

describe('defensive usage', () => {
  it('null / undefined never throws across the barrel', () => {
    expect(() => hudCore.classifyTaskCommand(null)).not.toThrow();
    expect(() => hudCore.isCriticalCommand(undefined)).not.toThrow();
    expect(() => hudCore.voterPool.filterEligibleAgents([], {})).not.toThrow();
    expect(() => hudCore.identityCorrection.detectIdentityCorrection('')).not.toThrow();
  });
});
