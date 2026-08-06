import { describe, it, expect } from 'vitest';
import {
  runApiConformanceContract,
  runErrorConformanceContract,
} from '../harness/conformance.js';
import {
  getAiApi,
  _resetAiApiForTesting,
  _setAiApiForTesting,
  type AiApi,
  AiError,
  AI_ERROR_CODES,
} from '../../ai/api.js';

// 1. API conformance -- the uniform Rule-12 suite. Enforced by
//    module-conformance.test.ts (a missing/empty contract fails the build).
runApiConformanceContract<AiApi>({
  name: 'AiApi',
  getInstance: getAiApi,
  resetForTesting: _resetAiApiForTesting,
  setForTesting: _setAiApiForTesting,
  expectedMethods: [
    'getStatus',
    'spaceAssist',
    'extractAssetMetadata',
    'convertToOkf',
    'suggestSpaces',
    'chat',
    'chatStream',
  ],
});

// 2. Error class conformance.
runErrorConformanceContract<AiError>({
  name: 'AiError',
  ErrorClass: AiError,
  codeEnum: AI_ERROR_CODES,
  modulePrefix: 'AI_',
  constructErrorWithCode: (code) =>
    new AiError({
      code: code as never,
      message: 'sample',
      context: { op: 'sample' },
    }),
});

// 3. Override hook delegates to the injected implementation.
describe('AiApi override', () => {
  it('_setAiApiForTesting routes getStatus / spaceAssist to the stub', async () => {
    const stub: AiApi = {
      getStatus: async () => ({ configured: true, provider: 'claude' }),
      spaceAssist: async () => ({ description: 'D', objectives: ['a', 'b', 'c'] }),
      suggestSpaces: async () => ({ suggestions: [] }),
      extractAssetMetadata: async () => ({
        summary: '',
        suggestedTitle: '',
        tags: [],
        topics: [],
        entities: [],
        contentType: '',
        language: '',
        keyPoints: [],
      }),
      convertToOkf: async () => ({ okf: 'name: X', agentType: 'conversational', name: 'X' }),
      chat: async () => ({
        content: 'hi',
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'claude-opus-4-8',
        provider: 'claude',
        cost: 0,
      }),
      chatStream: async () => ({
        content: 'hi',
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'claude-opus-4-8',
        provider: 'claude',
        cost: 0,
      }),
    };
    _setAiApiForTesting(stub);
    const api = getAiApi();
    expect(api).toBe(stub);
    await expect(api.getStatus()).resolves.toEqual({ configured: true, provider: 'claude' });
    await expect(api.spaceAssist({ purpose: 'x' })).resolves.toEqual({
      description: 'D',
      objectives: ['a', 'b', 'c'],
    });
    _resetAiApiForTesting();
  });
});
