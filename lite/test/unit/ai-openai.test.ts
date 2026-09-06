/**
 * OpenAI adapter (ADR-094) — the translation from Claude-shaped params to
 * a Chat Completions request, the response mapping back, error mapping,
 * and SSE streaming. All pure or fetch-injected; no network.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  translateToOpenAi,
  toClaudeResponse,
  mapOpenAiError,
  parseOpenAiStreamChunk,
  makeOpenAiMessageCreator,
  makeOpenAiChatClient,
} from '../../ai/openai.js';
import { AI_ERROR_CODES } from '../../ai/errors.js';
import type { OpenAiConfig } from '../../ai/config.js';

const CONFIG: OpenAiConfig = {
  provider: 'openai',
  apiKey: 'sk-test',
  model: 'gpt-5.2',
  baseUrl: 'https://api.openai.com',
};

describe('translateToOpenAi', () => {
  it('maps system + text to messages and max_tokens to max_completion_tokens', () => {
    const body = translateToOpenAi(
      { model: 'gpt-5.2', max_tokens: 512, system: 'Be brief.', messages: [{ role: 'user', content: 'hi' }] },
      'gpt-5.2'
    );
    expect(body).toEqual({
      model: 'gpt-5.2',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'hi' },
      ],
      max_completion_tokens: 512,
    });
    // Reasoning models reject temperature; it is never forwarded.
    expect(body).not.toHaveProperty('temperature');
  });

  it('turns a json_schema output_config into response_format and asks for JSON', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    const body = translateToOpenAi(
      {
        model: 'gpt-5.2',
        max_tokens: 100,
        system: 'Draft.',
        messages: [{ role: 'user', content: 'x' }],
        output_config: { format: { type: 'json_schema', schema } },
      },
      'gpt-5.2'
    );
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'lite_structured_output', schema, strict: false },
    });
    expect(body.messages[0]?.content).toContain('Respond with a single JSON object');
  });

  it('translates image and PDF blocks to image_url and file parts, dropping unknown blocks', () => {
    const body = translateToOpenAi(
      {
        model: 'gpt-5.2',
        max_tokens: 100,
        system: '',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'BBB' } },
              { type: 'text', text: 'Extract metadata.' },
              { type: 'mystery' },
            ],
          },
        ],
      },
      'gpt-5.2'
    );
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      { type: 'file', file: { filename: 'document.pdf', file_data: 'data:application/pdf;base64,BBB' } },
      { type: 'text', text: 'Extract metadata.' },
    ]);
  });
});

describe('toClaudeResponse', () => {
  it('yields a text block, usage, and maps content_filter to refusal', () => {
    expect(
      toClaudeResponse({
        choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })
    ).toEqual({
      content: [{ type: 'text', text: '{"a":1}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(
      toClaudeResponse({ choices: [{ message: { content: null }, finish_reason: 'content_filter' }] })
        .stop_reason
    ).toBe('refusal');
  });
});

describe('mapOpenAiError', () => {
  it('maps 401/403 → AUTH_REJECTED, 429 → RATE_LIMITED, other status → PROVIDER_ERROR, fetch failure → NETWORK', () => {
    expect(mapOpenAiError({ status: 401 }).code).toBe(AI_ERROR_CODES.AUTH_REJECTED);
    expect(mapOpenAiError({ status: 403 }).code).toBe(AI_ERROR_CODES.AUTH_REJECTED);
    expect(mapOpenAiError({ status: 429 }).code).toBe(AI_ERROR_CODES.RATE_LIMITED);
    expect(mapOpenAiError({ status: 500, message: 'boom' }).code).toBe(AI_ERROR_CODES.PROVIDER_ERROR);
    expect(mapOpenAiError(new TypeError('fetch failed')).code).toBe(AI_ERROR_CODES.NETWORK);
  });

  it('never echoes the key', () => {
    const err = mapOpenAiError({ status: 401, message: 'Incorrect API key provided: sk-test' });
    expect(JSON.stringify(err.toJSON())).not.toContain('sk-test');
  });
});

describe('makeOpenAiMessageCreator', () => {
  it('POSTs to /v1/chat/completions with the bearer key and returns a Claude-shaped response', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.openai.com/v1/chat/completions');
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
      const body = JSON.parse(String(init?.body)) as { model: string; max_completion_tokens: number };
      expect(body.model).toBe('gpt-5.2');
      expect(body.max_completion_tokens).toBe(64);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    const create = makeOpenAiMessageCreator(CONFIG, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await create({ model: 'gpt-5.2', max_tokens: 64, system: 's', messages: [{ role: 'user', content: 'ping' }] });
    expect(res).toEqual({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 1 },
    });
  });

  it('a 401 becomes AUTH_REJECTED with the API message, without the key', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), { status: 401 })
    );
    const create = makeOpenAiMessageCreator(CONFIG, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(
      create({ model: 'gpt-5.2', max_tokens: 1, system: '', messages: [{ role: 'user', content: 'x' }] })
    ).rejects.toMatchObject({ code: AI_ERROR_CODES.AUTH_REJECTED });
  });
});

describe('streaming', () => {
  it('parseOpenAiStreamChunk reads deltas, finish reasons and the usage-only chunk', () => {
    expect(parseOpenAiStreamChunk('{"choices":[{"delta":{"content":"Hel"}}]}')).toEqual({
      delta: 'Hel',
      finishReason: null,
      usage: null,
    });
    expect(parseOpenAiStreamChunk('{"choices":[{"delta":{},"finish_reason":"stop"}]}').finishReason).toBe('stop');
    expect(parseOpenAiStreamChunk('{"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":4}}').usage).toEqual({
      prompt_tokens: 2,
      completion_tokens: 4,
    });
    expect(parseOpenAiStreamChunk('not json')).toEqual({ delta: '', finishReason: null, usage: null });
  });

  it('makeOpenAiChatClient streams text deltas and resolves the assembled final message', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":", world"},"finish_reason":null}]}',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      '',
      'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { stream: boolean; stream_options: unknown };
      expect(body.stream).toBe(true);
      expect(body.stream_options).toEqual({ include_usage: true });
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const client = makeOpenAiChatClient(CONFIG, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const deltas: string[] = [];
    const stream = client.stream({ model: 'gpt-5.2', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
    stream.on('text', (t) => deltas.push(t));
    const final = await stream.finalMessage();
    expect(deltas).toEqual(['Hello', ', world']);
    expect(final).toEqual({
      content: [{ type: 'text', text: 'Hello, world' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 7, output_tokens: 3 },
    });
  });
});
