/**
 * voice-listener -- session.update payload assertions
 *
 * Pins the payload the listener sends to OpenAI right after the WebSocket
 * opens. The GA Realtime API 2 schema is shape-sensitive (one wrong field
 * name and the session is rejected silently), so this test catches
 * regressions before they hit the orb.
 *
 * Asserted invariants (Phase 3 -- audio output hard cut active):
 *   - session.type === 'realtime'
 *   - session.model === 'gpt-realtime-2'
 *   - session.output_modalities is ['audio'] (Phase 3 -- audio-only). The GA
 *     Realtime API rejects the combined ['audio', 'text'] value with
 *     `Invalid modalities: ['audio', 'text']. Supported combinations are:
 *     ['text'] and ['audio']`. Audio-only still gets transcript via
 *     response.output_audio_transcript.delta events.
 *   - audio.output is present with PCM format and a fixed `marin` voice
 *     (per-agent voices are blocked by the GA mid-session voice-change
 *     restriction; this is a documented follow-up).
 *   - session.reasoning.effort === 'low'.
 *   - session.instructions is the simplified router prompt -- NO mention
 *     of "ABSOLUTE RULES" or "NO EXCEPTIONS" wording.
 *   - audio.input.format / .transcription / .turn_detection are the
 *     GA-shape nested block.
 *   - tools[0].name === 'handle_user_request'.
 *   - tool_choice === 'auto' (was 'required' pre-Phase 3 -- 'auto' lets
 *     the model speak the function output rather than re-calling the tool).
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

vi.mock('../../lib/hud-api', () => ({ isSpeaking: () => false }));

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

describe('voice-listener.buildSessionUpdate() -- Phase 3 (audio output)', () => {
  let payload;

  beforeEach(() => {
    const listener = new VoiceListener();
    payload = listener.buildSessionUpdate();
  });

  it('uses the GA Realtime API 2 envelope', () => {
    expect(payload.type).toBe('session.update');
    expect(payload.session.type).toBe('realtime');
    expect(payload.session.model).toBe('gpt-realtime-2');
  });

  it('reasoning.effort is set to "low" for the router session', () => {
    expect(payload.session.reasoning).toBeDefined();
    expect(payload.session.reasoning.effort).toBe('low');
  });

  it('output_modalities is ["audio"] only (GA API rejects audio+text combo)', () => {
    // The GA Realtime API only accepts ['audio'] OR ['text'], NOT both.
    // ['audio', 'text'] is rejected with invalid_request_error and the
    // session never opens -- verified live against gpt-realtime-2 (May 2026).
    expect(payload.session.output_modalities).toEqual(['audio']);
  });

  it('audio.output is configured with PCM 24kHz and a fixed voice', () => {
    expect(payload.session.audio.output).toBeDefined();
    expect(payload.session.audio.output.format).toEqual({ type: 'audio/pcm', rate: 24000 });
    // marin is OpenAI's recommended default; per-agent voices require custom
    // voice uploads because GA forbids mid-session voice changes.
    expect(payload.session.audio.output.voice).toBe('marin');
  });

  it('instructions do not include the legacy "ABSOLUTE RULES" wording', () => {
    expect(typeof payload.session.instructions).toBe('string');
    expect(payload.session.instructions).not.toMatch(/ABSOLUTE RULES/i);
    expect(payload.session.instructions).not.toMatch(/NO EXCEPTIONS/i);
  });

  it('instructions reference handle_user_request', () => {
    expect(payload.session.instructions.toLowerCase()).toContain('handle_user_request');
  });

  it('instructions allow brief preamble acknowledgements (Phase 2.1)', () => {
    expect(payload.session.instructions.toLowerCase()).toContain('preamble');
  });

  it('instructions tell the model to speak the function output verbatim', () => {
    expect(payload.session.instructions.toLowerCase()).toContain('speak the function output');
  });

  it('audio.input uses the GA-shape nested block', () => {
    expect(payload.session.audio.input.format).toEqual({ type: 'audio/pcm', rate: 24000 });
    expect(payload.session.audio.input.transcription).toEqual({ model: 'gpt-realtime-whisper' });
    expect(payload.session.audio.input.turn_detection).toEqual({ type: 'semantic_vad' });
  });

  it('does not include the preview-era flat input_audio_format field', () => {
    expect(payload.session.input_audio_format).toBeUndefined();
    expect(payload.session.input_audio_transcription).toBeUndefined();
    expect(payload.session.turn_detection).toBeUndefined();
    expect(payload.session.modalities).toBeUndefined();
  });

  it('tools[0] is the handle_user_request function tool', () => {
    expect(payload.session.tools).toHaveLength(1);
    expect(payload.session.tools[0]).toMatchObject({
      type: 'function',
      name: 'handle_user_request',
    });
    expect(payload.session.tools[0].parameters.required).toEqual(['transcript']);
  });

  it('tool_choice is "auto" (Phase 3 -- so the model can speak after function output)', () => {
    expect(payload.session.tool_choice).toBe('auto');
  });
});
