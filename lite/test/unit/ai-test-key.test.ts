/**
 * testAiKey — the Settings "Test" button backend (2026-08-31: "lite AI
 * token should have a test option — when pasted it should test and make
 * sure it works"). Validates a CANDIDATE key against the live API
 * without persisting it. Pins: empty input fails fast with no network
 * call, a working key returns the model, and a rejected key maps through
 * the error mapper. The message-creator is injected so no real SDK call
 * runs.
 */
import { describe, it, expect, vi } from 'vitest';
import { testAiKey } from '../../ai/api.js';
import { AiError, AI_ERROR_CODES } from '../../ai/errors.js';

describe('testAiKey', () => {
  it('rejects an empty key WITHOUT making a network call', async () => {
    const makeCreator = vi.fn();
    await expect(testAiKey('   ', { makeCreator })).rejects.toMatchObject({
      code: AI_ERROR_CODES.INVALID_INPUT,
    });
    expect(makeCreator).not.toHaveBeenCalled();
  });

  it('returns the validated model when the candidate key authenticates', async () => {
    const createMessage = vi.fn(async () => ({ content: [], stop_reason: 'end_turn' }));
    const makeCreator = vi.fn(() => createMessage);
    const res = await testAiKey('sk-ant-good', { makeCreator });
    expect(res).toEqual({ ok: true, model: 'claude-fable-5' });
    // The candidate key was handed to the creator, and a minimal ping ran.
    expect(makeCreator).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'claude', apiKey: 'sk-ant-good' })
    );
    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: 1 })
    );
  });

  it('maps a rejected key through the error mapper', async () => {
    const createMessage = vi.fn(async () => {
      throw new Error('401');
    });
    const mapError = vi.fn(
      () =>
        new AiError({
          code: AI_ERROR_CODES.AUTH_REJECTED,
          message: 'Claude rejected the API key.',
        })
    );
    await expect(
      testAiKey('sk-ant-bad', { makeCreator: () => createMessage, mapError })
    ).rejects.toMatchObject({ code: AI_ERROR_CODES.AUTH_REJECTED });
    expect(mapError).toHaveBeenCalledOnce();
  });
});
