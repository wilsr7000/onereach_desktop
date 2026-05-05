/**
 * OpenAI HTTP client for the Lite AI service.
 *
 * Implements two endpoints:
 *  - `POST https://api.openai.com/v1/audio/speech` (TTS)
 *  - `POST https://api.openai.com/v1/chat/completions` (chat)
 *
 * Uses Node `fetch` (Node 18+ / Electron 22+ have native fetch).
 * Per-request timeout via `AbortSignal`. Errors normalized to
 * `AiError` with stable codes.
 *
 * @internal
 */

import {
  AiError,
  AI_ERROR_CODES,
  type AiErrorCode,
} from './errors.js';
import type { AiCredentialsProvider } from './credentials.js';
import type {
  ChatRequest,
  ChatResponse,
  TtsRequest,
  TtsResponse,
  OpenAiTtsFormat,
  OpenAiTtsModel,
  OpenAiTtsVoice,
} from './types.js';

const OPENAI_BASE = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 60_000;

const FORMAT_MIME: Readonly<Record<OpenAiTtsFormat, string>> = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/L16',
};

export interface OpenAiClientOptions {
  credentials: AiCredentialsProvider;
  /** Override the per-request timeout. Default: 60s. */
  timeoutMs?: number;
  /** Override the base URL (for testing). */
  baseUrl?: string;
  /** Override fetch (for testing). */
  fetchImpl?: typeof fetch;
}

export class OpenAiClient {
  private readonly credentials: AiCredentialsProvider;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiClientOptions) {
    this.credentials = options.credentials;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.baseUrl = options.baseUrl ?? OPENAI_BASE;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  // ── TTS ───────────────────────────────────────────────────────────────

  async tts(req: TtsRequest): Promise<TtsResponse> {
    if (typeof req.text !== 'string' || req.text.length === 0) {
      throw new AiError({
        code: AI_ERROR_CODES.BAD_INPUT,
        message: 'tts: text must be a non-empty string',
        context: { op: 'tts', field: 'text' },
        remediation: 'Pass a non-empty string. OpenAI TTS caps input at ~4096 characters.',
      });
    }
    if (req.text.length > 4096) {
      throw new AiError({
        code: AI_ERROR_CODES.BAD_INPUT,
        message: 'tts: text exceeds the 4096-character per-call limit',
        context: { op: 'tts', textLength: req.text.length },
        remediation:
          'Split the input into chunks (sentence boundaries) and call tts() for each chunk.',
      });
    }
    const creds = await this.requireCredentials('tts');
    const voice: OpenAiTtsVoice = req.voice ?? 'nova';
    const model: OpenAiTtsModel = req.model ?? 'tts-1';
    const format: OpenAiTtsFormat = req.format ?? 'mp3';

    const body = JSON.stringify({
      model,
      input: req.text,
      voice,
      response_format: format,
      ...(typeof req.speed === 'number' ? { speed: req.speed } : {}),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/audio/speech`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${creds.apiKey}`,
          'Content-Type': 'application/json',
          Accept: FORMAT_MIME[format],
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw this.normalizeFetchError(err, 'tts');
    }
    clearTimeout(timer);

    if (!response.ok) {
      const errBody = await safeReadText(response);
      throw new AiError({
        code: response.status === 429 ? AI_ERROR_CODES.RATE_LIMITED : AI_ERROR_CODES.HTTP,
        message: `tts: OpenAI returned ${response.status}`,
        context: { op: 'tts', status: response.status },
        status: response.status,
        responseBody: truncate(errBody, 1000),
        remediation:
          response.status === 429
            ? 'Wait a moment and try again. OpenAI rate-limits per organization.'
            : response.status === 401
              ? 'Check the API key in Settings -> AI; OpenAI rejected it.'
              : 'See OpenAI status page or response body for details.',
      });
    }

    const buf = await response.arrayBuffer();
    return {
      audio: new Uint8Array(buf),
      mimeType: FORMAT_MIME[format],
      format,
      voice,
      model,
    };
  }

  // ── chat ──────────────────────────────────────────────────────────────

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (!Array.isArray(req.messages) || req.messages.length === 0) {
      throw new AiError({
        code: AI_ERROR_CODES.BAD_INPUT,
        message: 'chat: messages must be a non-empty array',
        context: { op: 'chat', field: 'messages' },
        remediation: 'Pass at least one { role, content } message.',
      });
    }
    const creds = await this.requireCredentials('chat');
    const model = req.model ?? 'gpt-4o-mini';
    const temperature = req.temperature ?? 0.7;
    const maxTokens = req.maxTokens ?? 500;

    const body = JSON.stringify({
      model,
      messages: req.messages,
      temperature,
      max_tokens: maxTokens,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${creds.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw this.normalizeFetchError(err, 'chat');
    }
    clearTimeout(timer);

    if (!response.ok) {
      const errBody = await safeReadText(response);
      throw new AiError({
        code: response.status === 429 ? AI_ERROR_CODES.RATE_LIMITED : AI_ERROR_CODES.HTTP,
        message: `chat: OpenAI returned ${response.status}`,
        context: { op: 'chat', status: response.status },
        status: response.status,
        responseBody: truncate(errBody, 1000),
        remediation:
          response.status === 401
            ? 'Check the API key in Settings -> AI; OpenAI rejected it.'
            : 'See OpenAI status page or response body for details.',
      });
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
      model?: string;
    };
    const content = json.choices?.[0]?.message?.content ?? '';
    return {
      content,
      model: json.model ?? model,
      usage: {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
        totalTokens: json.usage?.total_tokens ?? 0,
      },
    };
  }

  // ── helpers ───────────────────────────────────────────────────────────

  private async requireCredentials(op: string): Promise<{ apiKey: string }> {
    const creds = await this.credentials.get();
    if (creds === null) {
      throw new AiError({
        code: AI_ERROR_CODES.NOT_CONFIGURED,
        message: 'AI service has no API key configured',
        context: { op },
        remediation: 'Open Settings -> AI and paste an OpenAI API key.',
      });
    }
    return { apiKey: creds.apiKey };
  }

  private normalizeFetchError(err: unknown, op: string): AiError {
    const e = err as Error & { name?: string };
    const code: AiErrorCode = e.name === 'AbortError' ? AI_ERROR_CODES.TIMEOUT : AI_ERROR_CODES.NETWORK;
    return new AiError({
      code,
      message: code === AI_ERROR_CODES.TIMEOUT ? `${op}: request timed out` : `${op}: network error`,
      context: { op, errorMessage: e.message ?? String(err) },
      cause: err,
      remediation:
        code === AI_ERROR_CODES.TIMEOUT
          ? 'Try again. If the problem persists, check your network or OpenAI status.'
          : 'Check your network connection.',
    });
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}...(truncated)`;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
