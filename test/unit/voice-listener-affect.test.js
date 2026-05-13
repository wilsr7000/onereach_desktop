/**
 * voice-listener -- Phase 3 affect-tuned response.create
 *
 * After Phase 3 lands audio output, respondToFunctionCall sends BOTH a
 * function_call_output AND an explicit response.create so the model
 * voices the result. The response.create instructions can include a
 * tone directive ("speak in a calm, empathetic tone") when the
 * AffectTracker has a non-neutral user state. That's the new home for
 * the affect-matching layer that previously post-edited text in
 * voice-speaker.js.
 *
 * This test pins:
 *   - With neutral / null / unavailable affect: response.create is sent
 *     with no `instructions` override.
 *   - With frustrated/sad/excited: response.create.response.instructions
 *     contains the mapped tone string.
 *   - Tone vocabulary uses the documented model-friendly phrases.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: {},
  app: { getPath: () => '/tmp' },
}), { virtual: true });

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('../../lib/ai-service', () => ({
  getAIService: () => ({ _getApiKey: () => 'test-key' }),
}));

vi.mock('../../budget-manager', () => ({
  getBudgetManager: () => ({ trackUsage: vi.fn() }),
}));

vi.mock('../../lib/transcript-service', () => ({
  getTranscriptService: () => ({ push: vi.fn() }),
}));

const { VoiceListener } = require('../../voice-listener.js');

function makeListener({ affect = null } = {}) {
  const listener = new VoiceListener();
  listener.__setDeps({
    hudApi: { isSpeaking: () => false, speechStarted: vi.fn(), speechEnded: vi.fn() },
    getBargeDetector: () => null,
    getAffect: () => affect,
  });
  listener.isConnected = true;
  const sent = [];
  listener.sendEvent = vi.fn((event) => {
    sent.push(event);
    return true;
  });
  return { listener, sent };
}

describe('voice-listener.respondToFunctionCall() -- function_call_output + response.create', () => {
  it('sends a function_call_output followed by response.create (in that order)', () => {
    const { listener, sent } = makeListener();
    listener.respondToFunctionCall('call_42', 'The time is 3:45 PM.');
    expect(sent).toHaveLength(2);
    expect(sent[0].type).toBe('conversation.item.create');
    expect(sent[0].item.type).toBe('function_call_output');
    expect(sent[0].item.call_id).toBe('call_42');
    expect(sent[1].type).toBe('response.create');
  });

  it('embeds the result text in the function_call_output JSON payload', () => {
    const { listener, sent } = makeListener();
    listener.respondToFunctionCall('c1', 'Hello world');
    const parsed = JSON.parse(sent[0].item.output);
    expect(parsed.response).toBe('Hello world');
    expect(parsed.handled).toBe(true);
  });
});

describe('voice-listener.respondToFunctionCall() -- affect tone steering', () => {
  it('omits the instructions override when affect is null', () => {
    const { listener, sent } = makeListener({ affect: null });
    listener.respondToFunctionCall('c1', 'OK');
    const responseCreate = sent.find((e) => e.type === 'response.create');
    expect(responseCreate).toBeDefined();
    expect(responseCreate.response).toBeUndefined();
  });

  it('omits the instructions override when affect is neutral', () => {
    const { listener, sent } = makeListener({ affect: { label: 'neutral' } });
    listener.respondToFunctionCall('c1', 'OK');
    const responseCreate = sent.find((e) => e.type === 'response.create');
    expect(responseCreate.response).toBeUndefined();
  });

  it('omits the instructions override when affect label is unknown', () => {
    const { listener, sent } = makeListener({ affect: { label: 'mystery-emotion' } });
    listener.respondToFunctionCall('c1', 'OK');
    const responseCreate = sent.find((e) => e.type === 'response.create');
    expect(responseCreate.response).toBeUndefined();
  });

  it('adds calm/empathetic tone instructions for frustrated affect', () => {
    const { listener, sent } = makeListener({ affect: { label: 'frustrated' } });
    listener.respondToFunctionCall('c1', 'The order is on its way.');
    const responseCreate = sent.find((e) => e.type === 'response.create');
    expect(responseCreate.response).toBeDefined();
    const instr = responseCreate.response.instructions.toLowerCase();
    expect(instr).toMatch(/calm|empathetic/);
    expect(instr).toContain('speak');
  });

  it('adds upbeat/friendly tone instructions for excited affect', () => {
    const { listener, sent } = makeListener({ affect: { label: 'excited' } });
    listener.respondToFunctionCall('c1', 'Great news!');
    const responseCreate = sent.find((e) => e.type === 'response.create');
    const instr = responseCreate.response.instructions.toLowerCase();
    expect(instr).toMatch(/upbeat|friendly/);
  });

  it('adds reassuring tone for anxious affect', () => {
    const { listener, sent } = makeListener({ affect: { label: 'anxious' } });
    listener.respondToFunctionCall('c1', 'Everything is fine.');
    const responseCreate = sent.find((e) => e.type === 'response.create');
    const instr = responseCreate.response.instructions.toLowerCase();
    expect(instr).toMatch(/reassuring|steady/);
  });

  it('returns true and survives a thrown getAffect (defensive)', () => {
    const listener = new VoiceListener();
    listener.__setDeps({
      hudApi: { isSpeaking: () => false, speechStarted: vi.fn(), speechEnded: vi.fn() },
      getBargeDetector: () => null,
      getAffect: () => {
        throw new Error('affect tracker exploded');
      },
    });
    listener.isConnected = true;
    listener.sendEvent = vi.fn(() => true);
    expect(() => listener.respondToFunctionCall('c1', 'OK')).not.toThrow();
    expect(listener.respondToFunctionCall('c1', 'OK')).toBe(true);
  });
});

describe('voice-listener.respondToFunctionCall() -- not connected', () => {
  it('returns false and does not send when ws not connected', () => {
    const { listener, sent } = makeListener();
    listener.isConnected = false;
    const result = listener.respondToFunctionCall('c1', 'OK');
    expect(result).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

// REGRESSION: daily-brief and other panel-rendering agents return
// {suppressAIResponse: true}, which makes the orb call
// respondToFunction(callId, '') to silently acknowledge the function
// call while voice-speaker handles the actual TTS through another path.
// If the listener triggers response.create on empty output, the realtime
// model fabricates a spoken reply that collides with the real audio --
// the user reported this as "daily brief did not work as it did" after
// Phase 3 landed. The contract: empty result = silent ack, no audio.
describe('voice-listener.respondToFunctionCall() -- silent ack (empty result)', () => {
  it('sends function_call_output but NOT response.create for empty result', () => {
    const { listener, sent } = makeListener();
    listener.respondToFunctionCall('call_99', '');
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('conversation.item.create');
    expect(sent[0].item.type).toBe('function_call_output');
    expect(sent[0].item.call_id).toBe('call_99');
    expect(sent.find((e) => e.type === 'response.create')).toBeUndefined();
  });

  it('treats whitespace-only result as a silent ack', () => {
    const { listener, sent } = makeListener();
    listener.respondToFunctionCall('call_100', '   \n\t ');
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('conversation.item.create');
    expect(sent.find((e) => e.type === 'response.create')).toBeUndefined();
  });

  it('treats omitted result (default arg) as a silent ack', () => {
    const { listener, sent } = makeListener();
    listener.respondToFunctionCall('call_101');
    expect(sent).toHaveLength(1);
    expect(sent.find((e) => e.type === 'response.create')).toBeUndefined();
  });

  it('does NOT mark pendingResponseCreate for silent ack', () => {
    const { listener } = makeListener();
    listener.pendingResponseCreate = false;
    listener.respondToFunctionCall('call_102', '');
    expect(listener.pendingResponseCreate).toBe(false);
  });

  it('still returns true on silent ack so callers do not retry', () => {
    const { listener } = makeListener();
    expect(listener.respondToFunctionCall('call_103', '')).toBe(true);
  });
});
