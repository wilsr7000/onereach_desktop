/**
 * Agent System v2 -- End-to-end Integration Test
 *
 * Wires every phase together in a single deterministic test so we
 * know the stack actually lights up as designed:
 *
 *   1. `buildTask` receives a rubric id + variant:'council'
 *   2. Rubric auto-expands into Task.criteria[]
 *   3. `runCouncil` receives the task + a set of agents with
 *      different declared `expertise` per criterion.
 *   4. Injected bid collector returns per-criterion scored bids
 *      that reflect each agent's expertise.
 *   5. council-adapter translates those bids into evaluations.
 *   6. `EvaluationConsolidator` produces a weighted aggregate
 *      score, surfaces conflicts, and returns epistemic framing.
 *   7. The shape of the final CouncilResult is what the HUD
 *      renderer expects (`consolidatedEvaluation` spec).
 *
 * No LLM calls. No Electron. Should run in <100ms.
 */

import { describe, it, expect } from 'vitest';

const { buildTask } = require('../../lib/task');
const { runCouncil } = require('../../lib/exchange/council-runner');
const { renderAgentUI } = require('../../lib/agent-ui-renderer');

// ---- Fake agents modeling the real meeting-space trio ------------------

const decisionAgent = {
  id: 'decision-agent',
  name: 'Decision',
  executionType: 'informational', // council test path executes informational
  defaultSpaces: ['meeting-agents'],
  expertise: {
    rationale: 0.92,
    alternatives: 0.65,
    reversibility: 0.55,
    stakeholders: 0.6,
    followup: 0.5,
  },
  execute: async (_task) => ({
    success: true,
    message: 'Decision recorded',
    data: { agentId: 'decision-agent' },
  }),
};

const meetingNotesAgent = {
  id: 'meeting-notes-agent',
  name: 'Meeting Notes',
  executionType: 'informational',
  defaultSpaces: ['meeting-agents'],
  expertise: {
    notes_quality: 0.9,
    decisions_captured: 0.6,
    action_items: 0.55,
    unresolved: 0.75,
    priority: 0.45,
  },
  execute: async (_task) => ({ success: true, message: 'Notes captured' }),
};

const actionItemAgent = {
  id: 'action-item-agent',
  name: 'Action Items',
  executionType: 'informational',
  defaultSpaces: ['meeting-agents'],
  expertise: {
    notes_quality: 0.4,
    decisions_captured: 0.3,
    action_items: 0.95,
    unresolved: 0.5,
    priority: 0.7,
  },
  execute: async (_task) => ({ success: true, message: 'Action items captured' }),
};

/**
 * Synthesize a bid shaped like what `unified-bidder` produces under
 * Phase 4, using each agent's self-declared expertise as its per-
 * criterion score (scaled to 0-100). Overall confidence is the mean.
 */
function _bidFromExpertise(agent, taskCriteria) {
  const criteria = taskCriteria
    .filter((c) => c && c.id)
    .map((c) => {
      const e = (agent.expertise && agent.expertise[c.id]) ?? 0.5;
      return {
        id: c.id,
        score: Math.round(e * 100),
        rationale: `${agent.name} is ${Math.round(e * 100)}% confident on ${c.label || c.id}`,
      };
    });
  const avg = criteria.reduce((s, c) => s + c.score, 0) / Math.max(1, criteria.length);
  return {
    agentId: agent.id,
    agentName: agent.name,
    confidence: avg / 100, // 0..1 scale for unified-bidder parity
    reasoning: `Self-assessed overall fit ${Math.round(avg)}/100 across declared criteria.`,
    plan: '',
    hallucinationRisk: 'none',
    result: null,
    criteria,
  };
}

// ---- Tests -------------------------------------------------------------

describe('Agent System v2 -- integration', () => {
  it('task.rubric auto-expands to criteria', () => {
    const task = buildTask({
      content: 'Evaluate how well this meeting captured its outcomes.',
      rubric: 'meeting_outcome',
      variant: 'council',
      toolId: 'integration-test',
      spaceId: 'meeting-agents',
    });
    expect(task.variant).toBe('council');
    expect(task.rubric).toBe('meeting_outcome');
    expect(Array.isArray(task.criteria)).toBe(true);
    // meeting_outcome rubric defines 5 criteria
    expect(task.criteria).toHaveLength(5);
    expect(task.criteria.map((c) => c.id).sort()).toEqual(
      ['action_items', 'decisions_captured', 'notes_quality', 'priority', 'unresolved']
    );
  });

  it('council runner produces a weighted aggregate + identifies specialists per criterion', async () => {
    const task = buildTask({
      content: 'Evaluate the meeting output',
      rubric: 'meeting_outcome',
      variant: 'council',
      spaceId: 'meeting-agents',
    });
    const agents = [decisionAgent, meetingNotesAgent, actionItemAgent];
    const getBids = async (_agents, t) => agents.map((a) => _bidFromExpertise(a, t.criteria));

    const lifecycle = [];
    const result = await runCouncil(task, agents, {
      getBids,
      onLifecycle: (e) => lifecycle.push(e.type),
    });

    // All three bids should qualify (each agent has at least one criterion >=0.5 so avg clears the 0.5 floor for most)
    expect(result.bidCount).toBe(3);
    expect(result.aggregateScore).toBeGreaterThan(50);
    expect(result.aggregateScore).toBeLessThanOrEqual(100);

    // Per-agent breakdown
    const byAgent = Object.fromEntries(result.agentScores.map((s) => [s.agentId, s]));
    expect(byAgent['decision-agent']).toBeTruthy();
    expect(byAgent['meeting-notes-agent']).toBeTruthy();
    expect(byAgent['action-item-agent']).toBeTruthy();

    // Lifecycle events must include all four phases
    for (const type of ['bids-collected', 'execution:started', 'execution:done', 'consolidation:done']) {
      expect(lifecycle).toContain(type);
    }

    // Consolidated per-criterion surface tells us which agent led each
    const byCriterion = Object.fromEntries(
      result.consolidatedCriteria.map((c) => [c.name, c]),
    );
    // meeting-notes-agent should dominate notes_quality (0.9 > others)
    expect(byCriterion.notes_quality.score).toBeGreaterThanOrEqual(55);
    // action-item-agent should dominate action_items (0.95 > others)
    expect(byCriterion.action_items.score).toBeGreaterThanOrEqual(55);
  });

  it('conflicts surface when agents disagree on a criterion', async () => {
    const task = buildTask({
      content: 'Evaluate the meeting output',
      rubric: 'meeting_outcome',
      variant: 'council',
    });
    const getBids = async (_agents, t) => [
      // action-item-agent: 95 on action_items (its expertise)
      _bidFromExpertise(actionItemAgent, t.criteria),
      // meeting-notes-agent: 55 on action_items (not its expertise)
      _bidFromExpertise(meetingNotesAgent, t.criteria),
    ];
    const result = await runCouncil(task, [actionItemAgent, meetingNotesAgent], { getBids });

    // Spread = 95 - 55 = 40 >= CONFLICT_THRESHOLD (20) -> a conflict surfaces
    expect(result.conflicts.length).toBeGreaterThan(0);
    const actionConflict = result.conflicts.find((c) => c.criterion === 'action_items');
    expect(actionConflict).toBeTruthy();
    expect(actionConflict.highScorer.agentId).toBe('action-item-agent');
  });

  it('bid-time clarification round updates the task context before the second bid', async () => {
    const task = buildTask({
      content: 'Evaluate this plan',
      rubric: 'plan_review',
      variant: 'council',
    });

    // First bid round: one agent asks for clarification.
    let callNumber = 0;
    let task2Seen = null;
    const getBids = async (_agents, t) => {
      callNumber += 1;
      if (callNumber === 1) {
        return [{
          agentId: 'decision-agent',
          confidence: 0.6,
          reasoning: 'cannot judge feasibility without the timeline',
          needsClarification: {
            question: 'What is the target timeline?',
            blocks: 'feasibility',
          },
        }];
      }
      task2Seen = t;
      return [_bidFromExpertise(decisionAgent, t.criteria)];
    };

    const askUser = async ({ question }) => {
      expect(question).toMatch(/timeline/);
      return 'Q4 2025';
    };

    const result = await runCouncil(task, [decisionAgent], { getBids, askUser });
    expect(result.clarifyRounds).toBe(1);
    expect(task2Seen.metadata.clarifications).toHaveLength(1);
    expect(task2Seen.metadata.clarifications[0].answer).toBe('Q4 2025');
    expect(result.bidCount).toBe(1);
  });

  it('CouncilResult renders into the consolidatedEvaluation HUD spec', async () => {
    const task = buildTask({
      content: 'Evaluate',
      rubric: 'meeting_outcome',
      variant: 'council',
    });
    const agents = [decisionAgent, meetingNotesAgent, actionItemAgent];
    const getBids = async (_a, t) => agents.map((a) => _bidFromExpertise(a, t.criteria));
    const result = await runCouncil(task, agents, { getBids });

    const uiSpec = {
      type: 'consolidatedEvaluation',
      aggregateScore: result.aggregateScore,
      confidence: result.confidence,
      weightingMode: result.weightingMode,
      agentScores: result.agentScores,
      conflicts: result.conflicts,
      suggestions: result.suggestions,
      primaryDrivers: result.epistemicFraming?.primaryDrivers || [],
      recommendsHumanReview: !!result.epistemicFraming?.recommendsHumanReview,
    };
    const html = renderAgentUI(uiSpec);
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain('Council');
    expect(html).toContain(String(result.aggregateScore));
    // Renderer strips the -agent suffix via council-adapter's _deriveAgentType
    expect(html).toContain('decision');
    expect(html).toContain('meeting-notes');
    expect(html).toContain('action-item');
    expect(html).toMatch(/Agents \(3\)/);
  });

  it('non-council task path is unaffected by v2 code (backward compat)', async () => {
    // A plain winner-style task should still build cleanly without
    // criteria / variant even when rubrics are loaded in the process.
    const t = buildTask({ content: 'play some music', toolId: 'orb' });
    expect(t.variant).toBeUndefined();
    expect(t.criteria).toBeUndefined();
    expect(t.rubric).toBeUndefined();
    expect(t.content).toBe('play some music');
  });
});
