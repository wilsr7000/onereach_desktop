/**
 * orb-turn-response — pure turn-decision logic extracted from
 * handleFunctionCallTranscript. Exhaustively pins every branch so the handler's
 * behaviour is testable in isolation and can't silently drift.
 */

import { describe, it, expect } from 'vitest';

const { classifyTurnResponse, classifyRoutedResponse } = require('../../lib/orb/orb-turn-response.js');

describe('classifyTurnResponse (route-independent branches)', () => {
  it('error: null or {error}', () => {
    expect(classifyTurnResponse(null)).toMatchObject({ action: 'error' });
    expect(classifyTurnResponse({ error: 'boom' })).toMatchObject({ action: 'error', error: 'boom' });
  });

  it('silent-ack: suppressAIResponse (async result handled elsewhere)', () => {
    expect(classifyTurnResponse({ suppressAIResponse: true })).toEqual({ action: 'silent-ack', ackText: '' });
  });

  it('silent-ack wins over needsInput (daily-brief shape: queued + suppress)', () => {
    const d = classifyTurnResponse({ suppressAIResponse: true, needsInput: true });
    expect(d.action).toBe('silent-ack');
  });

  it('clarify: needsClarification + filterReason speaks the message', () => {
    const d = classifyTurnResponse({ needsClarification: true, filterReason: 'off-topic', message: 'Rephrase please' });
    expect(d).toEqual({ action: 'clarify', ackText: 'Rephrase please' });
  });

  it('clarify with no message acks empty', () => {
    expect(classifyTurnResponse({ needsClarification: true, filterReason: 'x' }).ackText).toBe('');
  });

  it('needs-input: explicit needsInput uses message, then prompt, then default', () => {
    expect(classifyTurnResponse({ needsInput: true, message: 'Which one?' })).toMatchObject({
      action: 'needs-input', ackText: 'Which one?', awaitInput: true,
    });
    expect(classifyTurnResponse({ needsInput: { prompt: 'Pick a date' } }).ackText).toBe('Pick a date');
    expect(classifyTurnResponse({ needsInput: true }).ackText).toBe('What would you like?');
  });

  it('needs-input: needsClarification without a filterReason', () => {
    expect(classifyTurnResponse({ needsClarification: true, message: 'Clarify?' })).toMatchObject({
      action: 'needs-input', awaitInput: true,
    });
  });

  it('carries hasPanel for needs-input and route', () => {
    expect(classifyTurnResponse({ needsInput: true, html: '<div/>' }).hasPanel).toBe(true);
    expect(classifyTurnResponse({ message: 'hi', html: '<div/>' })).toMatchObject({ action: 'route', hasPanel: true });
  });

  it('route: plain result with no special flags', () => {
    expect(classifyTurnResponse({ message: 'The time is 3pm' })).toMatchObject({ action: 'route', hasPanel: false });
  });
});

describe('classifyRoutedResponse (tone vs speak)', () => {
  it('tone: mode tone / tone+visual acks empty', () => {
    expect(classifyRoutedResponse({}, { mode: 'tone', dwellMs: 4000 })).toEqual({
      action: 'tone', ackText: '', awaitAnswer: false, dwellMs: 4000,
    });
    expect(classifyRoutedResponse({}, { mode: 'tone+visual' }).action).toBe('tone');
  });

  it('speak: route.speech takes precedence over result.message', () => {
    const d = classifyRoutedResponse({ message: 'raw' }, { mode: 'full', speech: 'polished', dwellMs: 2000 });
    expect(d).toEqual({ action: 'speak', ackText: 'polished', awaitAnswer: false, dwellMs: 2000 });
  });

  it('speak: falls back to result.message, then default', () => {
    expect(classifyRoutedResponse({ message: 'from message' }, { mode: 'full' }).ackText).toBe('from message');
    expect(classifyRoutedResponse({}, null).ackText).toBe("I'm not sure how to help with that.");
  });

  it('propagates awaitAnswer and defaults dwellMs to 0', () => {
    const d = classifyRoutedResponse({ message: 'q?' }, { mode: 'full', awaitAnswer: true });
    expect(d.awaitAnswer).toBe(true);
    expect(d.dwellMs).toBe(0);
  });
});
