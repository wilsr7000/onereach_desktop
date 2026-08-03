/**
 * Unit tests for lib/exchange/self-heal.js
 *
 * The self-healing loop: broken-agent events (agent:contract-violation /
 * agent:hot-connect-refused) become a proactive rebuild offer routed through
 * the builder-consent flow. All decisions are tested behaviorally through
 * the pure functions and the notifier's injected deps -- no string matching
 * as the decider.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  BROKEN_AGENT_EVENTS,
  isBrokenAgentEvent,
  shouldOfferRebuild,
  composeRebuildRequest,
  buildRebuildPendingBuild,
  createSelfHealNotifier,
} from '../../lib/exchange/self-heal.js';

const STORED_DEF = {
  id: 'agent-123',
  name: 'Alarm Manager',
  description: 'Sets and manages alarms',
  prompt: 'You manage alarms for the user.',
  keywords: ['alarm', 'wake me'],
  executionType: 'llm',
};

function violationEntry(overrides = {}) {
  return {
    level: 'error',
    category: 'agent',
    message: 'Agent broken',
    data: {
      event: 'agent:contract-violation',
      agentId: 'agent-123',
      agentName: 'Alarm Manager',
    },
    ...overrides,
  };
}

describe('isBrokenAgentEvent', () => {
  it('recognizes agent:contract-violation error entries', () => {
    const r = isBrokenAgentEvent(violationEntry());
    expect(r.broken).toBe(true);
    expect(r.event).toBe('agent:contract-violation');
    expect(r.agentId).toBe('agent-123');
    expect(r.agentName).toBe('Alarm Manager');
  });

  it('recognizes agent:hot-connect-refused error entries', () => {
    const r = isBrokenAgentEvent(
      violationEntry({ data: { event: 'agent:hot-connect-refused', agentId: 'a9', agentName: 'X' } })
    );
    expect(r.broken).toBe(true);
    expect(r.event).toBe('agent:hot-connect-refused');
  });

  it('ignores non-error levels even with a matching event marker', () => {
    const r = isBrokenAgentEvent(violationEntry({ level: 'warn' }));
    expect(r.broken).toBe(false);
  });

  it('ignores error entries without a broken-agent event marker', () => {
    expect(isBrokenAgentEvent(violationEntry({ data: { event: 'delivery' } })).broken).toBe(false);
    expect(isBrokenAgentEvent(violationEntry({ data: {} })).broken).toBe(false);
    expect(isBrokenAgentEvent({ level: 'error' }).broken).toBe(false);
    expect(isBrokenAgentEvent(null).broken).toBe(false);
  });

  it('covers exactly the two broken-agent event names', () => {
    expect([...BROKEN_AGENT_EVENTS].sort()).toEqual([
      'agent:contract-violation',
      'agent:hot-connect-refused',
    ]);
  });
});

describe('shouldOfferRebuild', () => {
  const base = {
    agentId: 'agent-123',
    agentName: 'Alarm Manager',
    hasStoredDefinition: true,
    alreadyOffered: false,
    busy: false,
  };

  it('offers for a broken store agent (happy path)', () => {
    expect(shouldOfferRebuild(base)).toEqual({ offer: true, reason: 'broken-agent' });
  });

  it('refuses when the agent cannot be identified', () => {
    const d = shouldOfferRebuild({ ...base, agentId: null, agentName: null });
    expect(d.offer).toBe(false);
    expect(d.reason).toBe('unidentified-agent');
  });

  it('throttles to once per agent per session', () => {
    const d = shouldOfferRebuild({ ...base, alreadyOffered: true });
    expect(d.offer).toBe(false);
    expect(d.reason).toBe('already-offered-this-session');
  });

  it('defers while another agent is awaiting user input', () => {
    const d = shouldOfferRebuild({ ...base, busy: true });
    expect(d.offer).toBe(false);
    expect(d.reason).toBe('pending-input-busy');
  });

  it('refuses built-in agents (no stored definition to rebuild from)', () => {
    const d = shouldOfferRebuild({ ...base, hasStoredDefinition: false });
    expect(d.offer).toBe(false);
    expect(d.reason).toBe('no-stored-definition');
  });
});

describe('composeRebuildRequest / buildRebuildPendingBuild', () => {
  it('embeds the stored definition so the rebuild reproduces intent', () => {
    const req = composeRebuildRequest(STORED_DEF);
    expect(req).toContain('Alarm Manager');
    expect(req).toContain(STORED_DEF.description);
    expect(req).toContain(STORED_DEF.prompt);
    expect(req).toContain('alarm, wake me');
    expect(req).toContain('llm');
  });

  it('produces a builder-consent pendingBuild routed to claude-code with a rebuild tag', () => {
    const pb = buildRebuildPendingBuild(STORED_DEF, 'agent:contract-violation');
    expect(pb.buildMethod).toBe('claude-code');
    expect(pb.rebuild).toEqual({
      agentId: 'agent-123',
      agentName: 'Alarm Manager',
      brokenEvent: 'agent:contract-violation',
    });
    // The assessment must satisfy the builder's _handleConfirmation contract
    expect(pb.assessment.effort).toBe('easy');
    expect(pb.originalRequest).toContain(STORED_DEF.prompt);
  });
});

describe('createSelfHealNotifier', () => {
  let deps;
  let offers;
  let subscribedHandler;

  beforeEach(() => {
    offers = [];
    subscribedHandler = null;
    deps = {
      subscribe: vi.fn((handler) => {
        subscribedHandler = handler;
        return () => {
          subscribedHandler = null;
        };
      }),
      getAgentDef: vi.fn((agentId) => (agentId === 'agent-123' ? STORED_DEF : null)),
      isBusy: vi.fn(() => false),
      offerRebuild: vi.fn(async (offer) => {
        offers.push(offer);
      }),
      log: { info: vi.fn(), warn: vi.fn() },
    };
  });

  it('subscribes on creation and stop() unsubscribes', () => {
    const notifier = createSelfHealNotifier(deps);
    expect(deps.subscribe).toHaveBeenCalledTimes(1);
    expect(typeof subscribedHandler).toBe('function');
    notifier.stop();
    expect(subscribedHandler).toBeNull();
  });

  it('surfaces a rebuild offer with the broken agent definition as pendingBuild', async () => {
    const notifier = createSelfHealNotifier(deps);
    const outcome = await notifier.handleEntry(violationEntry());

    expect(outcome.offered).toBe(true);
    expect(offers).toHaveLength(1);
    const offer = offers[0];
    expect(offer.agentId).toBe('agent-123');
    expect(offer.agentName).toBe('Alarm Manager');
    expect(offer.pendingBuild.buildMethod).toBe('claude-code');
    expect(offer.pendingBuild.rebuild.agentId).toBe('agent-123');
    expect(offer.pendingBuild.originalRequest).toContain(STORED_DEF.prompt);
    expect(offer.prompt).toContain('Alarm Manager');
  });

  it('throttles: a second event for the same agent does not re-offer', async () => {
    const notifier = createSelfHealNotifier(deps);
    await notifier.handleEntry(violationEntry());
    const second = await notifier.handleEntry(violationEntry());

    expect(second.offered).toBe(false);
    expect(second.reason).toBe('already-offered-this-session');
    expect(offers).toHaveLength(1);
  });

  it('a different broken agent still gets its own offer', async () => {
    deps.getAgentDef = vi.fn(() => STORED_DEF);
    const notifier = createSelfHealNotifier(deps);
    await notifier.handleEntry(violationEntry());
    await notifier.handleEntry(
      violationEntry({ data: { event: 'agent:hot-connect-refused', agentId: 'agent-456', agentName: 'Other' } })
    );
    expect(offers).toHaveLength(2);
  });

  it('busy defers WITHOUT consuming the once-per-session slot', async () => {
    let busy = true;
    deps.isBusy = vi.fn(() => busy);
    const notifier = createSelfHealNotifier(deps);
    const first = await notifier.handleEntry(violationEntry());
    expect(first.offered).toBe(false);
    expect(first.reason).toBe('pending-input-busy');
    expect(offers).toHaveLength(0);
    expect(notifier.offeredAgents.has('agent-123')).toBe(false);

    // User becomes free; the same agent re-registering can offer now.
    busy = false;
    const second = await notifier.handleEntry(violationEntry());
    expect(second.offered).toBe(true);
    expect(offers).toHaveLength(1);
  });

  it('skips agents with no stored definition (built-ins) without offering', async () => {
    const notifier = createSelfHealNotifier(deps);
    const outcome = await notifier.handleEntry(
      violationEntry({ data: { event: 'agent:contract-violation', agentId: 'builtin-x', agentName: 'Builtin' } })
    );
    expect(outcome.offered).toBe(false);
    expect(outcome.reason).toBe('no-stored-definition');
    expect(offers).toHaveLength(0);
  });

  it('ignores unrelated log entries', async () => {
    const notifier = createSelfHealNotifier(deps);
    const outcome = await notifier.handleEntry({ level: 'error', data: { event: 'delivery' } });
    expect(outcome.offered).toBe(false);
    expect(deps.getAgentDef).not.toHaveBeenCalled();
  });

  it('an offerRebuild failure through the subscription never throws into the log queue', async () => {
    deps.offerRebuild = vi.fn(async () => {
      throw new Error('TTS exploded');
    });
    createSelfHealNotifier(deps);
    expect(() => subscribedHandler(violationEntry())).not.toThrow();
    // allow the fire-and-forget microtask chain to settle
    await new Promise((r) => setTimeout(r, 0));
    expect(deps.log.warn).toHaveBeenCalled();
  });
});
