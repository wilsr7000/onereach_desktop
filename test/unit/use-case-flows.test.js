/**
 * Use-case flows — text-only, automated coverage of the three canonical flows,
 * driven through the REAL decision modules (no LLM, no Electron, no voice).
 *
 * The point (per the plan): voice is just a relay onto the text path. If these
 * text-driven decisions are correct and regression-locked, voice works because
 * it only feeds transcripts in and speaks results out. Each scenario mirrors the
 * bulleted flow in docs/internal/EXCHANGE-DECISIONS.md.
 *
 *   UC-A  no agent exists  -> evaluate buildability -> offer build OR decline
 *   UC-B  daily brief      -> classify intent -> compose multi-channel answer
 *   UC-C  agent follow-up  -> surface -> correlate answer back to the SAME agent
 *
 * Run: npx vitest run test/unit/use-case-flows.test.js
 */

import { describe, it, expect, beforeEach } from 'vitest';

const relay = require('../../lib/exchange/relay-core');
const meta = require('../../lib/exchange/meta-tasks');
const { META_TASK_KINDS, registerMetaHandler, runMetaTask } = meta;
const agentBuilder = require('../../packages/agents/agent-builder-agent');
const { getTranscriptService } = require('../../lib/transcript-service');

const NOW = 1_000_000_000_000;
beforeEach(() => meta._reset());

// ===========================================================================
// UC-A — no agent exists: evaluate buildability, then offer-to-build or decline
// ===========================================================================
describe('UC-A: no agent exists -> build-agent evaluates and offers or declines', () => {
  // The buildability judgment lives in agent-builder-agent (deterministic given
  // an assessment). Here we register it as a META-TASK so the meta-work flows
  // through the exchange as a first-class, observable task (the "everything is a
  // task" model) — direct-assigned, not auctioned.
  function registerBuildabilityMetaHandler() {
    registerMetaHandler(META_TASK_KINDS.EVALUATE_BUILDABILITY, async ({ request, assessment }) => ({
      method: agentBuilder._chooseBuildMethod(assessment),
      response: agentBuilder._buildConversationalResponse(assessment, request),
      effort: assessment.effort,
    }));
  }

  it('an EASY request is offered as a build (via Claude Code)', async () => {
    registerBuildabilityMetaHandler();
    const assessment = {
      effort: 'easy',
      reasoning: 'Straightforward.',
      estimatedCostPerUse: '$0.01',
      requiredIntegrations: ['calendar'],
      missingAccess: [],
      spokenResponse: '',
    };
    const out = await runMetaTask(
      META_TASK_KINDS.EVALUATE_BUILDABILITY,
      { request: 'remind me of my first meeting each morning', assessment },
      { now: () => NOW }
    );
    expect(out.status).toBe('settled');
    expect(out.result.method).toBe('claude-code');
    expect(out.result.response.toLowerCase()).toMatch(/build (it|that)|right now/);
  });

  it('a NOT_FEASIBLE request is declined gracefully with an alternative (no build offer)', async () => {
    registerBuildabilityMetaHandler();
    const assessment = {
      effort: 'not_feasible',
      reasoning: 'It needs hardware control we do not have.',
      alternativeSuggestion: 'set a reminder instead',
    };
    const out = await runMetaTask(
      META_TASK_KINDS.EVALUATE_BUILDABILITY,
      { request: 'physically turn on my toaster', assessment },
      { now: () => NOW }
    );
    expect(out.result.method).toBe('none');
    // graceful decline: acknowledges the limit AND offers the alternative,
    // never prompts to build.
    expect(out.result.response.toLowerCase()).toMatch(/tough|right now/);
    expect(out.result.response).toMatch(/set a reminder instead/);
    expect(out.result.response.toLowerCase()).not.toMatch(/build it right now/);
  });

  it('the buildability evaluation is a recorded, observable task', async () => {
    registerBuildabilityMetaHandler();
    await runMetaTask(
      META_TASK_KINDS.EVALUATE_BUILDABILITY,
      { request: 'x', assessment: { effort: 'medium', requiredIntegrations: [], missingAccess: [], spokenResponse: '' } },
      { now: () => NOW }
    );
    const ledger = meta.listMetaTasks();
    expect(ledger.some((r) => r.kind === META_TASK_KINDS.EVALUATE_BUILDABILITY && r.status === 'settled')).toBe(true);
  });
});

// ===========================================================================
// UC-B — daily brief: classify intent (as a task) then compose the answer
// ===========================================================================
describe('UC-B: daily brief -> classify intent, winner composes multi-channel answer', () => {
  it('intent classification runs as a direct-assigned meta-task', async () => {
    // Stub the classifier (the LLM is non-deterministic; the ROUTING contract is
    // what we lock): "daily brief" classifies to the daily-brief-agent.
    registerMetaHandler(META_TASK_KINDS.CLASSIFY_INTENT, async ({ text }) => ({
      intent: text,
      winner: /brief/i.test(text) ? 'daily-brief-agent' : 'unknown',
    }));
    const out = await runMetaTask(META_TASK_KINDS.CLASSIFY_INTENT, { text: 'give me my daily brief' }, { now: () => NOW });
    expect(out.result.winner).toBe('daily-brief-agent');
  });

  it('the winner\'s composed result fans out to speak + chat + modal (planOutbound)', () => {
    // daily-brief-agent composes calendar/conflict data (from other agents/data
    // sources) into this normalized result; relay-core decides the channels.
    const composed = {
      success: true,
      spokenSummary: 'You have two meetings today; your morning is free until 11.',
      visualText: 'You have two meetings today; your morning is free until 11.',
      html: '<div class="day-view">…</div>',
      displayMode: 'modal',
      panelWidth: 480,
      panelHeight: 600,
      agentId: 'daily-brief-agent',
    };
    const plan = relay.planOutbound(composed, { voiceMode: true });
    expect(plan.speak.text).toMatch(/two meetings/);
    expect(plan.chat.text).toMatch(/two meetings/);
    expect(plan.modal).toMatchObject({ agentId: 'daily-brief-agent', width: 480, height: 600 });
    expect(plan.listenAfter).toBe(false); // a brief is terminal, not a follow-up
  });

  it('with voice off, the same brief still lands in chat (no speech)', () => {
    const composed = { success: true, spokenSummary: 'Brief…', visualText: 'Brief…' };
    const plan = relay.planOutbound(composed, { voiceMode: false });
    expect(plan.speak).toBeNull();
    expect(plan.chat.text).toBe('Brief…');
  });
});

// ===========================================================================
// UC-C — agent needs follow-up: surface, then correlate answer to SAME agent
// ===========================================================================
describe('UC-C: agent follow-up -> surfaced, answer correlated back (no new auction)', () => {
  it('a follow-up from any agent is surfaced by the voice relay', () => {
    expect(relay.shouldSurfaceNeedsInput({ toolId: 'orb', agentId: 'calendar-mutate-agent' })).toBe(true);
    // even a proactive/background agent the user never invoked
    expect(relay.shouldSurfaceNeedsInput({ toolId: 'meeting-monitor-agent', proactive: true })).toBe(true);
  });

  it('a spoken answer is correlated to the agent that asked and re-runs THAT agent', () => {
    const ts = getTranscriptService();
    ts._pending && ts._pending.clear && ts._pending.clear();
    // Agent asks -> pending is opened, keyed by the agent (task stays open).
    ts.setPending('calendar-mutate-agent', { taskId: 't-cal', field: 'slot' });

    // User answers by voice while that agent is awaiting.
    const decision = relay.classifyInbound({
      source: 'voice',
      text: 'the 3pm one',
      awaitingAgentId: 'calendar-mutate-agent',
    });
    expect(decision.kind).toBe('followup');
    expect(decision.correlation.targetAgentId).toBe('calendar-mutate-agent');

    // Routing picks the pending agent by id — the SAME agent, no fresh auction.
    const picked = ts.pickPending(decision.correlation.targetAgentId);
    expect(picked.agentId).toBe('calendar-mutate-agent');
    expect(ts.hasPending()).toBe(false); // consumed; the turn is resolved
  });

  it('a modal click answers the same way (converted to text, correlated by agentId)', () => {
    const ts = getTranscriptService();
    ts._pending && ts._pending.clear && ts._pending.clear();
    ts.setPending('email-agent', { taskId: 't-email', field: 'recipient' });

    const decision = relay.classifyInbound({
      source: 'modal',
      interaction: { value: 'robb@onereach.com', field: 'recipient', agentId: 'email-agent' },
    });
    expect(decision.kind).toBe('modal-choice');
    expect(decision.text).toBe('robb@onereach.com');
    expect(decision.correlation.targetAgentId).toBe('email-agent');

    const picked = ts.pickPending(decision.correlation.targetAgentId);
    expect(picked.agentId).toBe('email-agent');
  });
});
