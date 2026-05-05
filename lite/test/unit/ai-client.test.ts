/**
 * Lite AI client tests -- OpenAI request/response shape verification.
 *
 * Uses a stub `fetch` to avoid real network calls. Verifies:
 *   - TTS request body shape (model, input, voice, response_format)
 *   - Auth header is `Bearer <apiKey>`
 *   - Audio bytes round-trip into Uint8Array correctly
 *   - 401 maps to AI_HTTP, 429 maps to AI_RATE_LIMITED, 500 maps to AI_HTTP
 *   - Network failure maps to AI_NETWORK
 *   - AbortSignal timeout maps to AI_TIMEOUT
 *   - Chat completion request body + response parsing
 */

import { describe, it, expect, vi } from 'vitest';
import { OpenAiClient } from '../../ai/client.js';
import { AiError, AI_ERROR_CODES } from '../../ai/errors.js';
import { StaticAiCredentialsProvider } from '../../ai/credentials.js';

function makeFetch(
  resp: Partial<Response> & { ok?: boolean; status?: number; arrayBuffer?: () => Promise<ArrayBuffer>; text?: () => Promise<string>; json?: () => Promise<unknown> }
): typeof fetch {
  const mock = vi.fn().mockResolvedValue({
    ok: resp.ok ?? true,
    status: resp.status ?? 200,
    arrayBuffer: resp.arrayBuffer ?? (async () => new ArrayBuffer(0)),
    text: resp.text ?? (async () => ''),
    json: resp.json ?? (async () => ({})),
    headers: new Headers(),
  });
  return mock as unknown as typeof fetch;
}

describe('OpenAiClient.tts', () => {
  it('sends the correct request body and headers', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new ArrayBuffer(8),
        text: async () => '',
        headers: new Headers(),
      } as unknown as Response;
    });
    const client = new OpenAiClient({
      credentials: new StaticAiCredentialsProvider({ apiKey: 'sk-test' }),
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    const result = await client.tts({
      text: 'Hello world',
      voice: 'echo',
      model: 'tts-1-hd',
      format: 'mp3',
    });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error('expected call');
    expect(call.url).toBe('https://api.openai.com/v1/audio/speech');
    expect(call.init.method).toBe('POST');
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(call.init.body as string) as Record<string, unknown>;
    expect(body.model).toBe('tts-1-hd');
    expect(body.input).toBe('Hello world');
    expect(body.voice).toBe('echo');
    expect(body.response_format).toBe('mp3');

    expect(result.audio).toBeInstanceOf(Uint8Array);
    expect(result.audio.byteLength).toBe(8);
    expect(result.mimeType).toBe('audio/mpeg');
    expect(result.voice).toBe('echo');
  });

  it('maps 429 to AI_RATE_LIMITED', async () => {
    const client = new OpenAiClient({
      credentials: new StaticAiCredentialsProvider({ apiKey: 'sk-test' }),
      fetchImpl: makeFetch({ ok: false, status: 429, text: async () => 'too many' }),
    });
    await expect(client.tts({ text: 'x' })).rejects.toMatchObject({
      code: AI_ERROR_CODES.RATE_LIMITED,
      status: 429,
    });
  });

  it('maps 500 to AI_HTTP', async () => {
    const client = new OpenAiClient({
      credentials: new StaticAiCredentialsProvider({ apiKey: 'sk-test' }),
      fetchImpl: makeFetch({ ok: false, status: 500, text: async () => 'oops' }),
    });
    await expect(client.tts({ text: 'x' })).rejects.toMatchObject({
      code: AI_ERROR_CODES.HTTP,
      status: 500,
    });
  });

  it('maps 401 to AI_HTTP with auth-specific remediation', async () => {
    const client = new OpenAiClient({
      credentials: new StaticAiCredentialsProvider({ apiKey: 'sk-test' }),
      fetchImpl: makeFetch({ ok: false, status: 401, text: async () => 'no auth' }),
    });
    try {
      await client.tts({ text: 'x' });
      throw new Error('should have thrown');
    } catch (err) {
      const e = err as AiError;
      expect(e).toBeInstanceOf(AiError);
      expect(e.code).toBe(AI_ERROR_CODES.HTTP);
      expect(e.status).toBe(401);
      expect(e.remediation).toMatch(/Settings/);
    }
  });

  it('maps network throw to AI_NETWORK', async () => {
    const client = new OpenAiClient({
      credentials: new StaticAiCredentialsProvider({ apiKey: 'sk-test' }),
      fetchImpl: vi.fn().mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch,
    });
    await expect(client.tts({ text: 'x' })).rejects.toMatchObject({
      code: AI_ERROR_CODES.NETWORK,
    });
  });

  it('maps AbortError to AI_TIMEOUT', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    const client = new OpenAiClient({
      credentials: new StaticAiCredentialsProvider({ apiKey: 'sk-test' }),
      fetchImpl: vi.fn().mockRejectedValue(abortErr) as unknown as typeof fetch,
    });
    await expect(client.tts({ text: 'x' })).rejects.toMatchObject({
      code: AI_ERROR_CODES.TIMEOUT,
    });
  });
});

describe('OpenAiClient.chat', () => {
  it('sends the correct request body', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new ArrayBuffer(0),
        text: async () => '',
        json: async () => ({
          choices: [{ message: { content: 'Hello back' } }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          model: 'gpt-4o-mini',
        }),
        headers: new Headers(),
      } as unknown as Response;
    });
    const client = new OpenAiClient({
      credentials: new StaticAiCredentialsProvider({ apiKey: 'sk-test' }),
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    const result = await client.chat({
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hi' },
      ],
      maxTokens: 50,
    });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error('expected call');
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(call.init.body as string) as Record<string, unknown>;
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.max_tokens).toBe(50);
    expect((body.messages as unknown[]).length).toBe(2);
    expect(result.content).toBe('Hello back');
    expect(result.usage.totalTokens).toBe(8);
  });
});
