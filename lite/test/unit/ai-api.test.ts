/**
 * Lite AI service tests -- Rule 12 conformance + behavior.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getAiApi,
  buildAiApi,
  _resetAiApiForTesting,
  _setAiApiForTesting,
  AiError,
  AI_ERROR_CODES,
  AI_EVENTS,
  isAiEvent,
  type AiApi,
  type AiErrorCode,
} from '../../ai/api.js';
import { StaticAiCredentialsProvider } from '../../ai/credentials.js';
import { runApiConformanceContract } from '../harness/api-conformance.js';
import { runErrorConformanceContract } from '../harness/error-conformance.js';

runApiConformanceContract<AiApi>({
  name: 'AiApi',
  getInstance: getAiApi,
  resetForTesting: _resetAiApiForTesting,
  setForTesting: _setAiApiForTesting,
  expectedMethods: ['tts', 'chat', 'status', 'configure', 'onEvent'],
});

runErrorConformanceContract<AiError>({
  name: 'AiError',
  ErrorClass: AiError,
  codeEnum: AI_ERROR_CODES,
  modulePrefix: 'AI_',
  constructErrorWithCode: (code) =>
    new AiError({
      code: code as AiErrorCode,
      message: 'sample',
      context: { op: 'sample' },
    }),
});

describe('AiApi.status', () => {
  beforeEach(() => {
    _resetAiApiForTesting();
  });

  it('returns hasApiKey:false when KV has nothing', async () => {
    const api = buildAiApi(new StaticAiCredentialsProvider());
    const status = await api.status();
    expect(status.hasApiKey).toBe(false);
    expect(status.provider).toBe('openai');
    expect(status.defaultTtsVoice).toBe('nova');
  });

  it('returns hasApiKey:true when configured', async () => {
    const api = buildAiApi(new StaticAiCredentialsProvider({ apiKey: 'sk-test' }));
    const status = await api.status();
    expect(status.hasApiKey).toBe(true);
  });
});

describe('AiApi.configure', () => {
  it('updates the underlying credentials provider', async () => {
    const provider = new StaticAiCredentialsProvider();
    const api = buildAiApi(provider);
    await api.configure({ apiKey: 'sk-new', defaultTtsVoice: 'echo' });
    const status = await api.status();
    expect(status.hasApiKey).toBe(true);
    expect(status.defaultTtsVoice).toBe('echo');
  });

  it('clearing apiKey ("") removes it', async () => {
    const provider = new StaticAiCredentialsProvider({ apiKey: 'sk-old' });
    const api = buildAiApi(provider);
    await api.configure({ apiKey: '' });
    const status = await api.status();
    expect(status.hasApiKey).toBe(false);
  });
});

describe('AiApi.tts', () => {
  it('throws AI_NOT_CONFIGURED when no key is set', async () => {
    const api = buildAiApi(new StaticAiCredentialsProvider());
    await expect(api.tts({ text: 'hello' })).rejects.toBeInstanceOf(AiError);
    try {
      await api.tts({ text: 'hello' });
    } catch (err) {
      expect((err as AiError).code).toBe(AI_ERROR_CODES.NOT_CONFIGURED);
    }
  });

  it('throws AI_BAD_INPUT for empty text', async () => {
    const api = buildAiApi(new StaticAiCredentialsProvider({ apiKey: 'sk-test' }));
    await expect(api.tts({ text: '' })).rejects.toBeInstanceOf(AiError);
  });

  it('throws AI_BAD_INPUT for text > 4096 chars', async () => {
    const api = buildAiApi(new StaticAiCredentialsProvider({ apiKey: 'sk-test' }));
    const huge = 'a'.repeat(4097);
    await expect(api.tts({ text: huge })).rejects.toMatchObject({
      code: AI_ERROR_CODES.BAD_INPUT,
    });
  });
});

describe('AiApi.chat', () => {
  it('throws AI_NOT_CONFIGURED when no key is set', async () => {
    const api = buildAiApi(new StaticAiCredentialsProvider());
    await expect(api.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({
      code: AI_ERROR_CODES.NOT_CONFIGURED,
    });
  });

  it('throws AI_BAD_INPUT for empty messages', async () => {
    const api = buildAiApi(new StaticAiCredentialsProvider({ apiKey: 'sk-test' }));
    await expect(api.chat({ messages: [] })).rejects.toMatchObject({
      code: AI_ERROR_CODES.BAD_INPUT,
    });
  });
});

describe('isAiEvent', () => {
  it('narrows by event name', () => {
    for (const name of Object.values(AI_EVENTS)) {
      expect(
        isAiEvent({
          id: '1',
          timestamp: 't',
          name,
          level: 'info',
          category: 'ai',
        })
      ).toBe(true);
    }
    expect(
      isAiEvent({
        id: '1',
        timestamp: 't',
        name: 'kv.set.start',
        level: 'info',
        category: 'kv',
      })
    ).toBe(false);
  });
});

describe('_setAiApiForTesting', () => {
  beforeEach(() => {
    _resetAiApiForTesting();
  });

  it('overrides the singleton', () => {
    const stub: AiApi = {
      tts: vi.fn(),
      chat: vi.fn(),
      status: vi.fn(),
      configure: vi.fn(),
      onEvent: vi.fn().mockReturnValue(() => undefined),
    };
    _setAiApiForTesting(stub);
    expect(getAiApi()).toBe(stub);
  });
});
