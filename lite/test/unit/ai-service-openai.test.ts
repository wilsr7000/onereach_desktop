/**
 * AiService on an OpenAI config (ADR-094): every capability that used to
 * be Claude-only runs through the injected OpenAI seams, the status
 * reports the live provider, and chat results are tagged 'openai'.
 */
import { describe, it, expect, vi } from 'vitest';
import { AiService } from '../../ai/service.js';
import type { OpenAiConfig } from '../../ai/config.js';
import type { ClaudeMessageCreator } from '../../ai/client.js';
import type { ClaudeChatClient } from '../../ai/chat.js';

const OPENAI: OpenAiConfig = {
  provider: 'openai',
  apiKey: 'sk-oai',
  model: 'gpt-5.2',
  baseUrl: 'https://api.openai.com',
};

function creatorReturning(text: string): { creator: ClaudeMessageCreator; calls: unknown[] } {
  const calls: unknown[] = [];
  const creator: ClaudeMessageCreator = async (params) => {
    calls.push(params);
    return { content: [{ type: 'text', text }], stop_reason: 'end_turn' };
  };
  return { creator, calls };
}

function service(creator: ClaudeMessageCreator, chat?: ClaudeChatClient): AiService {
  const openAiCreator = vi.fn(() => creator);
  const claudeCreator = vi.fn(() => {
    throw new Error('Claude seam must not be used on an OpenAI config');
  });
  return new AiService({
    loadConfig: () => OPENAI,
    fetchImpl: vi.fn() as unknown as typeof fetch,
    accountId: () => null,
    makeClaudeMessageCreator: claudeCreator,
    makeOpenAiMessageCreator: openAiCreator,
    ...(chat !== undefined ? { makeOpenAiChatClient: () => chat } : {}),
  });
}

describe('AiService on OpenAI', () => {
  it('getStatus reports openai as the live provider', async () => {
    const svc = service(creatorReturning('{}').creator);
    await expect(svc.getStatus()).resolves.toEqual({ configured: true, provider: 'openai' });
  });

  it('spaceAssist drafts through the OpenAI creator with the configured model', async () => {
    const { creator, calls } = creatorReturning(
      JSON.stringify({ description: 'A launch.', objectives: ['Plan', 'Ship', 'Measure'] })
    );
    const svc = service(creator);
    const res = await svc.spaceAssist({ purpose: 'launch the thing' });
    expect(res.objectives).toEqual(['Plan', 'Ship', 'Measure']);
    expect(calls[0]).toMatchObject({ model: 'gpt-5.2' });
  });

  it('extractAssetMetadata, suggestSpaces and convertToOkf are no longer Claude-only', async () => {
    const { creator } = creatorReturning(
      JSON.stringify({
        summary: 'S',
        suggestedTitle: 'T',
        tags: ['a'],
        topics: [],
        entities: [],
        contentType: 'note',
        language: 'en',
        keyPoints: [],
      })
    );
    const svc = service(creator);
    const meta = await svc.extractAssetMetadata({ kind: 'text', text: 'hello world' });
    expect(meta.tags).toEqual(['a']);
    const { creator: suggest } = creatorReturning(JSON.stringify({ suggestions: [{ spaceId: 'sp-1', reason: 'fits' }] }));
    const out = await service(suggest).suggestSpaces({
      item: { title: 'Doc' },
      spaces: [{ id: 'sp-1', name: 'Launch' }],
    });
    expect(out.suggestions).toEqual([{ spaceId: 'sp-1', reason: 'fits' }]);
    const { creator: okf } = creatorReturning(
      JSON.stringify({ okf: 'name: X', agentType: 'conversational', name: 'X' })
    );
    const conv = await service(okf).convertToOkf({ source: 'an agent that answers billing questions', isUrl: false });
    expect(conv.name).toBe('X');
  });

  it('chat and chatStream run on the OpenAI chat client and tag the result provider', async () => {
    const chat: ClaudeChatClient = {
      stream: () => {
        const listeners: Array<(t: string) => void> = [];
        return {
          on: (_e, l) => {
            listeners.push(l);
            return undefined;
          },
          finalMessage: async () => {
            for (const l of listeners) l('hi');
            return { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 } };
          },
        };
      },
    };
    const svc = service(creatorReturning('').creator, chat);
    const res = await svc.chat({ messages: [{ role: 'user', content: 'hello' }] });
    expect(res).toMatchObject({ content: 'hi', provider: 'openai', model: 'gpt-5.2' });
    const deltas: string[] = [];
    const streamed = await svc.chatStream({ messages: [{ role: 'user', content: 'hello' }] }, (d) => deltas.push(d));
    expect(deltas).toEqual(['hi']);
    expect(streamed.provider).toBe('openai');
  });

  it('a flow-only config still refuses the model-only capabilities with the shared remediation', async () => {
    const svc = new AiService({
      loadConfig: () => ({ provider: 'onereach-flow', url: 'https://flow.example/run' }),
      fetchImpl: vi.fn() as unknown as typeof fetch,
      accountId: () => 'acct',
    });
    await expect(svc.chat({ messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({
      code: 'AI_NOT_CONFIGURED',
      remediation: expect.stringContaining('Claude API key'),
    });
  });
});
