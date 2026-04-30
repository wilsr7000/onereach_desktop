/**
 * Pending State Classifier - Unit Tests
 *
 * Run:  npx vitest run test/unit/pending-state.test.js
 */

import { describe, it, expect } from 'vitest';

const {
  classifyPendingState,
  shouldRouteToPendingStateHandler,
  normalizeRoutingContext,
} = require('../../lib/hud-core/pending-state');

describe('classifyPendingState', () => {
  it('no pending context -> kind none, shouldHandle false', () => {
    const r = classifyPendingState({});
    expect(r.kind).toBe('none');
    expect(r.shouldHandleAsPending).toBe(false);
  });

  it('null / undefined tolerated', () => {
    expect(classifyPendingState(null).kind).toBe('none');
    expect(classifyPendingState(undefined).kind).toBe('none');
    expect(classifyPendingState().kind).toBe('none');
  });

  it('hasPendingQuestion -> kind question', () => {
    const r = classifyPendingState({
      hasPendingQuestion: true,
      pendingAgentId: 'calendar-agent',
      pendingField: 'time',
    });
    expect(r.kind).toBe('question');
    expect(r.shouldHandleAsPending).toBe(true);
    expect(r.pendingAgentId).toBe('calendar-agent');
    expect(r.pendingField).toBe('time');
  });

  it('hasPendingConfirmation -> kind confirmation', () => {
    const r = classifyPendingState({
      hasPendingConfirmation: true,
      pendingAgentId: 'email-agent',
    });
    expect(r.kind).toBe('confirmation');
    expect(r.shouldHandleAsPending).toBe(true);
    expect(r.pendingAgentId).toBe('email-agent');
  });

  it('question takes priority over confirmation when both true', () => {
    const r = classifyPendingState({
      hasPendingQuestion: true,
      hasPendingConfirmation: true,
    });
    expect(r.kind).toBe('question');
  });

  it('does not expose irrelevant fields on none', () => {
    const r = classifyPendingState({ lastSubject: 'scheduling' });
    expect(r).toEqual({ kind: 'none', shouldHandleAsPending: false });
  });
});

describe('shouldRouteToPendingStateHandler', () => {
  it('convenience boolean matches classifyPendingState.shouldHandleAsPending', () => {
    expect(shouldRouteToPendingStateHandler({ hasPendingQuestion: true })).toBe(true);
    expect(shouldRouteToPendingStateHandler({ hasPendingConfirmation: true })).toBe(true);
    expect(shouldRouteToPendingStateHandler({})).toBe(false);
    expect(shouldRouteToPendingStateHandler(null)).toBe(false);
  });
});

describe('normalizeRoutingContext', () => {
  it('returns a blank shape for null / non-object', () => {
    expect(normalizeRoutingContext(null)).toEqual({
      hasPendingQuestion: false,
      hasPendingConfirmation: false,
    });
    expect(normalizeRoutingContext('nope')).toEqual({
      hasPendingQuestion: false,
      hasPendingConfirmation: false,
    });
  });

  it('coerces booleans', () => {
    const r = normalizeRoutingContext({
      hasPendingQuestion: 1,
      hasPendingConfirmation: 'yes',
    });
    expect(r.hasPendingQuestion).toBe(true);
    expect(r.hasPendingConfirmation).toBe(true);
  });

  it('keeps only string / number fields in their respective slots', () => {
    const r = normalizeRoutingContext({
      hasPendingQuestion: true,
      pendingAgentId: 'calendar',
      pendingField: 'time',
      lastSubject: 'scheduling',
      contextCount: 3,
      random: 'drop-me',
    });
    expect(r).toMatchObject({
      hasPendingQuestion: true,
      hasPendingConfirmation: false,
      pendingAgentId: 'calendar',
      pendingField: 'time',
      lastSubject: 'scheduling',
      contextCount: 3,
    });
    expect(r.random).toBeUndefined();
  });

  it('drops non-string pendingAgentId / pendingField', () => {
    const r = normalizeRoutingContext({
      pendingAgentId: 42,
      pendingField: null,
      contextCount: 'three',
    });
    expect(r.pendingAgentId).toBeUndefined();
    expect(r.pendingField).toBeUndefined();
    expect(r.contextCount).toBeUndefined();
  });
});

describe('legacy equivalence to the inline pending-state check', () => {
  // The inline code in exchange-bridge.js before extraction was:
  //   const routingContext = conversationState.getRoutingContext();
  //   if (routingContext.hasPendingQuestion || routingContext.hasPendingConfirmation) {
  //     // route to Router
  //   }
  function legacy(ctx) {
    return Boolean(ctx.hasPendingQuestion || ctx.hasPendingConfirmation);
  }

  const cases = [
    {},
    { hasPendingQuestion: true },
    { hasPendingConfirmation: true },
    { hasPendingQuestion: true, hasPendingConfirmation: true },
    { hasPendingQuestion: false, hasPendingConfirmation: false },
  ];
  for (const ctx of cases) {
    it(`legacy(${JSON.stringify(ctx)}) === shouldRouteToPendingStateHandler(${JSON.stringify(ctx)})`, () => {
      expect(legacy(ctx)).toBe(shouldRouteToPendingStateHandler(ctx));
    });
  }
});
