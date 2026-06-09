/**
 * Unit tests for the generic Claude chat engine (`ai/chat.ts`) and the
 * `AiService.chat` / `chatStream` methods that back the embedded WISER
 * Playbooks `window.ai` bridge.
 *
 * All network access is stubbed via the injectable ClaudeChatClient seam,
 * so these run offline with no SDK call.
 */

import { describe, it, expect } from 'vitest';
import {
  profileToModel,
  estimateCost,
  normalizeMessages,
  assertValidChatInput,
  runClaudeChat,
  runClaudeChatStream,
  type ClaudeChatClient,
  type ClaudeMessageLike,
} from '../../ai/chat.js';
import { AiService } from '../../ai/service.js';
import { AiError } from '../../ai/errors.js';
import type { ClaudeConfig } from '../../ai/config.js';

const CLAUDE_CFG: ClaudeConfig = {
  provider: 'claude',
  apiKey: 'sk-ant-test',
  model: 'claude-opus-4-8',
  baseUrl: 'https://api.anthropic.com',
};

/** A fake chat client that records params + plays back canned deltas/usage. */
function fakeClient(opts: {
  deltas?: string[];
  message?: ClaudeMessageLike;
  throwErr?: unknown;
}): { client: ClaudeChatClient; lastParams: () => Record<string, unknown> | null } {
  let captured: Record<string, unknown> | null = null;
  const client: ClaudeChatClient = {
    stream: (params) => {
      captured = params;
      return {
        on: (_event, listener) => {
          for (const d of opts.deltas ?? []) listener(d);
          return undefined;
        },
        finalMessage: async () => {
          if (opts.throwErr !== undefined) throw opts.throwErr;
          return (
            opts.message ?? {
              content: [{ type: 'text', text: (opts.deltas ?? []).join('') }],
              usage: { input_tokens: 10, output_tokens: 5 },
            }
          );
        },
      };
    },
  };
  return { client, lastParams: () => captured };
}

describe('profileToModel', () => {
  it('resolves every profile to the configured model', () => {
    for (const p of ['fast', 'standard', 'powerful', 'large', 'vision'] as const) {
      expect(profileToModel(p, 'claude-opus-4-8')).toBe('claude-opus-4-8');
    }
    expect(profileToModel(undefined, 'some-model')).toBe('some-model');
  });
});

describe('estimateCost', () => {
  it('prices the opus family', () => {
    expect(estimateCost('claude-opus-4-8', { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(15);
    expect(estimateCost('claude-opus-4-8', { inputTokens: 0, outputTokens: 1_000_000 })).toBeCloseTo(75);
  });
  it('returns 0 for unknown families rather than guessing', () => {
    expect(estimateCost('mystery-model', { inputTokens: 9_999, outputTokens: 9_999 })).toBe(0);
  });
});

describe('normalizeMessages', () => {
  it('merges consecutive same-role turns', () => {
    expect(
      normalizeMessages([
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
      ])
    ).toEqual([{ role: 'user', content: 'a\n\nb' }]);
  });
  it('forces a leading user turn', () => {
    const out = normalizeMessages([{ role: 'assistant', content: 'hi' }]);
    expect(out[0]!.role).toBe('user');
  });
  it('never returns an empty list', () => {
    expect(normalizeMessages([]).length).toBeGreaterThan(0);
    expect(normalizeMessages(undefined as never).length).toBeGreaterThan(0);
  });
});

describe('assertValidChatInput', () => {
  it('throws AI_INVALID_INPUT on empty messages', () => {
    try {
      assertValidChatInput({ messages: [] });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AiError);
      expect((err as AiError).code).toBe('AI_INVALID_INPUT');
    }
  });
  it('accepts a non-empty message list', () => {
    expect(() => assertValidChatInput({ messages: [{ role: 'user', content: 'hi' }] })).not.toThrow();
  });
});

describe('runClaudeChat', () => {
  it('returns content, usage, model, provider, and cost', async () => {
    const { client, lastParams } = fakeClient({
      message: { content: [{ type: 'text', text: 'hello world' }], usage: { input_tokens: 12, output_tokens: 7 } },
    });
    const result = await runClaudeChat(
      { profile: 'powerful', system: 'sys', messages: [{ role: 'user', content: 'hi' }], maxTokens: 1234 },
      { config: CLAUDE_CFG, client }
    );
    expect(result.content).toBe('hello world');
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
    expect(result.model).toBe('claude-opus-4-8');
    expect(result.provider).toBe('claude');
    expect(result.cost).toBeGreaterThan(0);
    // params mapping
    const params = lastParams()!;
    expect(params['model']).toBe('claude-opus-4-8');
    expect(params['max_tokens']).toBe(1234);
    expect(params['system']).toBe('sys');
  });

  it('appends the JSON-only instruction in jsonMode', async () => {
    const { client, lastParams } = fakeClient({ deltas: ['{}'] });
    await runClaudeChat(
      { messages: [{ role: 'user', content: 'give json' }], jsonMode: true, system: 'base' },
      { config: CLAUDE_CFG, client }
    );
    expect(String(lastParams()!['system'])).toContain('valid JSON only');
  });

  it('maps SDK errors through mapClaudeError', async () => {
    const { client } = fakeClient({ throwErr: { status: 401 } });
    await expect(
      runClaudeChat({ messages: [{ role: 'user', content: 'hi' }] }, { config: CLAUDE_CFG, client })
    ).rejects.toMatchObject({ code: 'AI_AUTH_REJECTED' });
  });
});

describe('runClaudeChatStream', () => {
  it('emits each delta and resolves with the full result', async () => {
    const deltas = ['Hel', 'lo ', 'there'];
    const { client } = fakeClient({ deltas });
    const seen: string[] = [];
    const result = await runClaudeChatStream(
      { messages: [{ role: 'user', content: 'hi' }] },
      { config: CLAUDE_CFG, client, onDelta: (d) => seen.push(d) }
    );
    expect(seen).toEqual(deltas);
    expect(result.content).toBe('Hello there');
  });

  it('does not let a throwing onDelta abort the stream', async () => {
    const { client } = fakeClient({ deltas: ['x', 'y'] });
    const result = await runClaudeChatStream(
      { messages: [{ role: 'user', content: 'hi' }] },
      {
        config: CLAUDE_CFG,
        client,
        onDelta: () => {
          throw new Error('consumer blew up');
        },
      }
    );
    expect(result.content).toBe('xy');
  });
});

describe('AiService.chat / chatStream', () => {
  function svc(cfg: ClaudeConfig | null, client?: ClaudeChatClient): AiService {
    return new AiService({
      loadConfig: () => cfg,
      fetchImpl: globalThis.fetch.bind(globalThis),
      accountId: () => null,
      ...(client !== undefined ? { makeClaudeChatClient: () => client } : {}),
    });
  }

  it('chat throws AI_NOT_CONFIGURED when no provider is configured', async () => {
    await expect(svc(null).chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({
      code: 'AI_NOT_CONFIGURED',
    });
  });

  it('chat throws AI_NOT_CONFIGURED when the provider is not Claude', async () => {
    const flowCfg = { provider: 'onereach-flow', url: 'https://x' } as unknown as ClaudeConfig;
    await expect(svc(flowCfg).chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({
      code: 'AI_NOT_CONFIGURED',
    });
  });

  it('chat throws AI_INVALID_INPUT on empty messages', async () => {
    const { client } = fakeClient({ deltas: ['x'] });
    await expect(svc(CLAUDE_CFG, client).chat({ messages: [] })).rejects.toMatchObject({
      code: 'AI_INVALID_INPUT',
    });
  });

  it('chat returns a result via the configured Claude client', async () => {
    const { client } = fakeClient({
      message: { content: [{ type: 'text', text: 'answer' }], usage: { input_tokens: 3, output_tokens: 2 } },
    });
    const result = await svc(CLAUDE_CFG, client).chat({ messages: [{ role: 'user', content: 'q' }] });
    expect(result.content).toBe('answer');
    expect(result.provider).toBe('claude');
  });

  it('chatStream streams deltas and resolves', async () => {
    const { client } = fakeClient({ deltas: ['a', 'b', 'c'] });
    const seen: string[] = [];
    const result = await svc(CLAUDE_CFG, client).chatStream(
      { messages: [{ role: 'user', content: 'q' }] },
      (d) => seen.push(d)
    );
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(result.content).toBe('abc');
  });
});
