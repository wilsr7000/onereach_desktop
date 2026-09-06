/**
 * OpenAI provider — an adapter behind the SAME two seams every Claude
 * capability already uses, so nothing per-capability changes:
 *
 *   - {@link makeOpenAiMessageCreator} implements `ClaudeMessageCreator`
 *     (space-assist, metadata extraction, OKF conversion, Space
 *     suggestions): Claude-shaped params in, Claude-shaped response out.
 *   - {@link makeOpenAiChatClient} implements `ClaudeChatClient`
 *     (chat / chatStream for the embedded WISER `window.ai` bridge),
 *     streaming over Server-Sent Events.
 *
 * Plain `fetch` against the Chat Completions API — no SDK dependency, so
 * packaging (the asar externals guard) is untouched. Translation rules:
 *   - `system`                       → a `system` message
 *   - text block                     → `{ type: 'text' }`
 *   - image block (base64)           → `image_url` data URL (vision)
 *   - document block (PDF base64)    → `file` input (`file_data` data URL)
 *   - `output_config.json_schema`    → `response_format: json_schema`
 *                                      (non-strict: the schema guides,
 *                                      our validators still decide)
 *   - `max_tokens`                   → `max_completion_tokens` (the only
 *                                      form the GPT-5 family accepts)
 *   - `temperature` is NOT forwarded: reasoning models reject it.
 *
 * SECURITY: the key appears only in the `Authorization` header. Errors
 * are mapped to `AiError` (AUTH_REJECTED / RATE_LIMITED / NETWORK /
 * PROVIDER_ERROR) without echoing the key or the request body.
 */

import { AiError, AI_ERROR_CODES } from './errors.js';
import type { OpenAiConfig } from './config.js';
import type { ClaudeCreateParams, ClaudeMessageCreator, ClaudeResponse } from './client.js';
import type { ClaudeChatClient, ClaudeMessageLike, ClaudeStreamLike } from './chat.js';

/** One attempt's socket budget, and the absolute deadline (mirrors Claude's). */
export const OPENAI_ATTEMPT_TIMEOUT_MS = 60_000;
export const OPENAI_DEADLINE_MS = 90_000;
/** Streams may legitimately run long (WISER asks for up to 32k tokens). */
export const OPENAI_STREAM_DEADLINE_MS = 10 * 60_000;

/** The request body we send (exported so tests can assert the translation). */
export interface OpenAiChatRequest {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | unknown[] }>;
  max_completion_tokens: number;
  response_format?: unknown;
  stream?: boolean;
  stream_options?: { include_usage: boolean };
}

interface OpenAiChatCompletion {
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Translate Claude-shaped create params into an OpenAI Chat Completions
 * body. Pure; pinned by unit tests.
 */
export function translateToOpenAi(params: ClaudeCreateParams, model: string): OpenAiChatRequest {
  const messages: OpenAiChatRequest['messages'] = [];
  const schema = extractJsonSchema(params.output_config);
  const system =
    typeof params.system === 'string' && params.system.length > 0
      ? schema !== null
        ? `${params.system}\n\nRespond with a single JSON object and nothing else.`
        : params.system
      : schema !== null
        ? 'Respond with a single JSON object and nothing else.'
        : null;
  if (system !== null) messages.push({ role: 'system', content: system });
  for (const m of params.messages) {
    // The chat path streams assistant turns through the same seam even
    // though the drafting type only names `user`.
    const role = (m as { role: string }).role === 'assistant' ? 'assistant' : 'user';
    messages.push({
      role,
      content: typeof m.content === 'string' ? m.content : translateBlocks(m.content),
    });
  }
  const body: OpenAiChatRequest = {
    model,
    messages,
    max_completion_tokens: Math.max(1, Math.floor(params.max_tokens)),
  };
  if (schema !== null) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'lite_structured_output', schema, strict: false },
    };
  }
  return body;
}

/** Pull `{ format: { type: 'json_schema', schema } }` out of Claude's output_config. */
function extractJsonSchema(outputConfig: unknown): Record<string, unknown> | null {
  const format = (outputConfig as { format?: { type?: unknown; schema?: unknown } } | undefined)
    ?.format;
  if (format?.type === 'json_schema' && format.schema !== null && typeof format.schema === 'object') {
    return format.schema as Record<string, unknown>;
  }
  return null;
}

/** Claude content blocks → OpenAI content parts. Unknown blocks are dropped. */
function translateBlocks(blocks: unknown[]): unknown[] {
  const parts: unknown[] = [];
  for (const raw of blocks) {
    const b = (raw ?? {}) as {
      type?: unknown;
      text?: unknown;
      source?: { type?: unknown; media_type?: unknown; data?: unknown };
    };
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push({ type: 'text', text: b.text });
    } else if (
      b.type === 'image' &&
      b.source?.type === 'base64' &&
      typeof b.source.media_type === 'string' &&
      typeof b.source.data === 'string'
    ) {
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
      });
    } else if (
      b.type === 'document' &&
      b.source?.type === 'base64' &&
      typeof b.source.data === 'string'
    ) {
      const mediaType =
        typeof b.source.media_type === 'string' ? b.source.media_type : 'application/pdf';
      parts.push({
        type: 'file',
        file: { filename: 'document.pdf', file_data: `data:${mediaType};base64,${b.source.data}` },
      });
    }
  }
  return parts;
}

/** OpenAI completion → the Claude-shaped response the validators read. */
export function toClaudeResponse(completion: OpenAiChatCompletion): ClaudeResponse & ClaudeMessageLike {
  const choice = completion.choices?.[0];
  const text = typeof choice?.message?.content === 'string' ? choice.message.content : '';
  const finish = choice?.finish_reason ?? null;
  return {
    content: [{ type: 'text', text }],
    stop_reason:
      finish === 'content_filter' ? 'refusal' : finish === 'length' ? 'max_tokens' : 'end_turn',
    usage: {
      input_tokens: completion.usage?.prompt_tokens ?? 0,
      output_tokens: completion.usage?.completion_tokens ?? 0,
    },
  };
}

/** Map a fetch/HTTP failure onto an AiError. Never leaks the key. */
export function mapOpenAiError(err: unknown): AiError {
  if (err instanceof AiError) return err;
  const e = (err ?? {}) as { status?: unknown; name?: unknown; message?: unknown };
  const status = typeof e.status === 'number' ? e.status : undefined;
  if (status === 401 || status === 403) {
    return new AiError({
      code: AI_ERROR_CODES.AUTH_REJECTED,
      message: 'OpenAI rejected the API key.',
      context: { provider: 'openai', status },
      remediation: 'Check the key in Settings → AI (it starts with `sk-`) and try again.',
    });
  }
  if (status === 429) {
    return new AiError({
      code: AI_ERROR_CODES.RATE_LIMITED,
      message: 'OpenAI rate-limited the request.',
      context: { provider: 'openai', status },
      remediation: 'Wait a moment and try again.',
    });
  }
  if (status !== undefined) {
    return new AiError({
      code: AI_ERROR_CODES.PROVIDER_ERROR,
      message: `OpenAI returned HTTP ${status}${
        typeof e.message === 'string' && e.message.length > 0 ? `: ${e.message}` : '.'
      }`,
      context: { provider: 'openai', status },
      remediation: 'Try again, or fill in the details manually.',
      cause: err,
    });
  }
  const name = typeof e.name === 'string' ? e.name : '';
  if (name === 'AbortError' || name === 'TypeError' || /fetch|network|connection/i.test(String(e.message ?? ''))) {
    return new AiError({
      code: AI_ERROR_CODES.NETWORK,
      message: `OpenAI request failed to send: ${String(e.message ?? name ?? 'connection error')}`,
      context: { provider: 'openai' },
      remediation: 'Check your network connection (DNS, VPN, proxy) and try again.',
      cause: err,
    });
  }
  return new AiError({
    code: AI_ERROR_CODES.PROVIDER_ERROR,
    message: `OpenAI error: ${String(e.message ?? 'unknown')}`,
    context: { provider: 'openai' },
    remediation: 'Try again, or fill in the details manually.',
    cause: err,
  });
}

/** An HTTP failure carrying the status + the API's own message (no body echo beyond that). */
class OpenAiHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'OpenAiHttpError';
    this.status = status;
  }
}

async function readApiErrorMessage(res: Response): Promise<string> {
  try {
    const json = (await res.json()) as { error?: { message?: unknown } };
    return typeof json.error?.message === 'string' ? json.error.message.slice(0, 200) : '';
  } catch {
    return '';
  }
}

function completionsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

function headers(apiKey: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
}

/** Absolute deadline: settle with the promise, or reject NETWORK after `ms`. */
export function withOpenAiDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new AiError({
          code: AI_ERROR_CODES.NETWORK,
          message: `OpenAI did not respond within ${Math.round(ms / 1000)}s.`,
          context: { provider: 'openai', timeoutMs: ms },
          remediation: 'Check your network connection and try again.',
        })
      );
    }, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err as Error);
      }
    );
  });
}

export interface OpenAiDeps {
  /** Injectable fetch (tests). Defaults to the global. */
  fetchImpl?: typeof fetch;
}

/**
 * Non-streaming creator behind the `ClaudeMessageCreator` seam. One
 * request, time-bounded; HTTP/transport failures surface as `AiError`.
 */
export function makeOpenAiMessageCreator(
  config: OpenAiConfig,
  deps: OpenAiDeps = {}
): ClaudeMessageCreator {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  return async (params) => {
    const body = translateToOpenAi(params, params.model || config.model);
    const controller = new AbortController();
    const attempt = setTimeout(() => controller.abort(), OPENAI_ATTEMPT_TIMEOUT_MS);
    (attempt as unknown as { unref?: () => void }).unref?.();
    try {
      const res = await withOpenAiDeadline(
        fetchImpl(completionsUrl(config.baseUrl), {
          method: 'POST',
          headers: headers(config.apiKey),
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        OPENAI_DEADLINE_MS
      );
      if (!res.ok) throw new OpenAiHttpError(res.status, await readApiErrorMessage(res));
      return toClaudeResponse((await res.json()) as OpenAiChatCompletion);
    } catch (err) {
      throw mapOpenAiError(err);
    } finally {
      clearTimeout(attempt);
    }
  };
}

/**
 * Parse one SSE `data:` payload from a chat-completions stream. Returns
 * the text delta (if any), the finish reason (if present) and usage (on
 * the final usage-only chunk). Exported for tests.
 */
export function parseOpenAiStreamChunk(json: string): {
  delta: string;
  finishReason: string | null;
  usage: { prompt_tokens?: number; completion_tokens?: number } | null;
} {
  let parsed: OpenAiChatCompletion & { choices?: Array<{ delta?: { content?: unknown } }> };
  try {
    parsed = JSON.parse(json) as typeof parsed;
  } catch {
    return { delta: '', finishReason: null, usage: null };
  }
  const choice = parsed.choices?.[0] as
    | { delta?: { content?: unknown }; finish_reason?: string | null }
    | undefined;
  const content = choice?.delta?.content;
  return {
    delta: typeof content === 'string' ? content : '',
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
    usage: parsed.usage ?? null,
  };
}

/**
 * Streaming chat client behind the `ClaudeChatClient` seam. `stream()`
 * starts the request immediately; `on('text')` listeners receive deltas
 * as SSE events arrive; `finalMessage()` resolves with the assembled
 * text + usage once the stream ends.
 */
export function makeOpenAiChatClient(config: OpenAiConfig, deps: OpenAiDeps = {}): ClaudeChatClient {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  return {
    stream: (params): ClaudeStreamLike => {
      const listeners: Array<(text: string) => void> = [];
      const claudeParams = params as unknown as ClaudeCreateParams;
      const body: OpenAiChatRequest = {
        ...translateToOpenAi(claudeParams, claudeParams.model || config.model),
        stream: true,
        stream_options: { include_usage: true },
      };
      const run = (async (): Promise<ClaudeMessageLike> => {
        let res: Response;
        try {
          res = await fetchImpl(completionsUrl(config.baseUrl), {
            method: 'POST',
            headers: headers(config.apiKey),
            body: JSON.stringify(body),
          });
        } catch (err) {
          throw mapOpenAiError(err);
        }
        if (!res.ok) throw mapOpenAiError(new OpenAiHttpError(res.status, await readApiErrorMessage(res)));
        if (res.body === null) throw mapOpenAiError(new Error('empty response body'));
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let text = '';
        let finish: string | null = null;
        let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
        const handleLine = (line: string): void => {
          if (!line.startsWith('data:')) return;
          const payload = line.slice(5).trim();
          if (payload.length === 0 || payload === '[DONE]') return;
          const chunk = parseOpenAiStreamChunk(payload);
          if (chunk.delta.length > 0) {
            text += chunk.delta;
            for (const fn of listeners) {
              try {
                fn(chunk.delta);
              } catch {
                /* a broken listener must not kill the stream */
              }
            }
          }
          if (chunk.finishReason !== null) finish = chunk.finishReason;
          if (chunk.usage !== null) usage = chunk.usage;
        };
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl = buffer.indexOf('\n');
          while (nl !== -1) {
            handleLine(buffer.slice(0, nl).replace(/\r$/, ''));
            buffer = buffer.slice(nl + 1);
            nl = buffer.indexOf('\n');
          }
        }
        if (buffer.trim().length > 0) handleLine(buffer.trim());
        return toClaudeResponse({
          choices: [{ message: { content: text }, finish_reason: finish }],
          ...(usage !== null ? { usage } : {}),
        });
      })();
      const final = withOpenAiDeadline(run, OPENAI_STREAM_DEADLINE_MS);
      // Keep an unobserved rejection from surfacing before finalMessage() is awaited.
      final.catch(() => undefined);
      return {
        on: (event, listener) => {
          if (event === 'text') listeners.push(listener);
          return undefined;
        },
        finalMessage: () => final,
      };
    },
  };
}
