/**
 * Generic Claude chat — the engine behind the embedded WISER Playbooks
 * `window.ai` bridge.
 *
 * The Spaces/`spaceAssist` paths in `client.ts` are deliberately narrow
 * (structured-output drafting). The WISER Playbooks web app, by contrast,
 * speaks a generic chat contract (`window.ai.chat` / `chatStream`) that it
 * already uses inside the Onereach "Spaces" Electron shell. This module
 * implements that contract for Lite so the embedded Playbooks window can
 * run on the Onereach app's Claude key **without the key ever leaving the
 * main process** — the renderer only sends messages and receives text.
 *
 * SECURITY: the API key is only ever handed to the SDK client here, in the
 * main process. It is never returned to the renderer, logged, or placed in
 * an error. The WISER window's preload exposes only `chat`/`chatStream` —
 * never the key, never `getStatus`, never any other Lite bridge.
 *
 * Both paths take an injectable client seam so they unit-test without real
 * network access.
 */

import Anthropic from '@anthropic-ai/sdk';
import { AiError, AI_ERROR_CODES } from './errors.js';
import { mapClaudeError } from './client.js';
import type { ClaudeConfig } from './config.js';

/**
 * WISER's model "profile" abstraction (mirrors the Spaces shell contract).
 * The host maps each profile to a concrete model — see {@link profileToModel}.
 */
export type AiChatProfile = 'fast' | 'standard' | 'powerful' | 'large' | 'vision';

/** A single chat turn. Only user/assistant turns — system goes in `system`. */
export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Input to {@link runClaudeChat} / {@link runClaudeChatStream}. */
export interface AiChatInput {
  /** Abstract capability tier requested by the renderer (mapped to a model). */
  profile?: AiChatProfile;
  /** System prompt (optional). */
  system?: string;
  /** The conversation so far (must start/normalize to a user turn). */
  messages: AiChatMessage[];
  /** Max output tokens. Defaults to {@link DEFAULT_MAX_TOKENS}. */
  maxTokens?: number;
  /** Sampling temperature (forwarded only when provided). */
  temperature?: number;
  /** Ask the model for JSON only (appends an instruction to the system prompt). */
  jsonMode?: boolean;
  /** Cost-tracking label forwarded by the renderer (e.g. "playbooks"). */
  feature?: string;
}

/** Result returned to the renderer — mirrors WISER's `WindowAIChatResult`. */
export interface AiChatResult {
  content: string;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  provider: 'claude';
  /** Best-effort USD estimate. WISER ignores this; populated for parity/telemetry. */
  cost: number;
}

/** Default output cap when the renderer doesn't specify one. */
export const DEFAULT_MAX_TOKENS = 4096;

const JSON_MODE_SUFFIX =
  '\n\nIMPORTANT: Respond with valid JSON only. No markdown fences, no commentary.';

/**
 * Map a WISER capability profile to a concrete Claude model.
 *
 * Every profile currently resolves to the **configured** model (the one
 * the active key is already proven to work with for `spaceAssist`), so the
 * bridge can never request a model the deployment doesn't have. Structured
 * as a switch so per-tier models (haiku for `fast`, etc.) can be slotted in
 * later without touching callers.
 */
export function profileToModel(_profile: AiChatProfile | undefined, configuredModel: string): string {
  return configuredModel;
}

/**
 * Best-effort USD cost estimate from token usage. WISER does not read this
 * field, but the `window.ai` contract carries it and `/logs` may surface it
 * later. Unknown model families return 0 rather than guessing wrong.
 */
export function estimateCost(
  model: string,
  usage: { inputTokens: number; outputTokens: number }
): number {
  const m = model.toLowerCase();
  // Per-million-token prices (USD). Family-level; current-generation rates
  // (Opus 4.5+ is $5/$25 -- pre-4.5 Opus was $15/$75 but those models are
  // legacy/retiring and not configurable here).
  let inPerM = 0;
  let outPerM = 0;
  if (m.includes('fable')) {
    inPerM = 10;
    outPerM = 50;
  } else if (m.includes('opus')) {
    inPerM = 5;
    outPerM = 25;
  } else if (m.includes('sonnet')) {
    inPerM = 3;
    outPerM = 15;
  } else if (m.includes('haiku')) {
    inPerM = 1;
    outPerM = 5;
  } else {
    return 0;
  }
  return (usage.inputTokens / 1_000_000) * inPerM + (usage.outputTokens / 1_000_000) * outPerM;
}

/** Append the JSON-only instruction to the system prompt when requested. */
function buildSystem(system: string | undefined, jsonMode: boolean | undefined): string | undefined {
  if (jsonMode !== true) return system;
  return system !== undefined && system.length > 0 ? system + JSON_MODE_SUFFIX : JSON_MODE_SUFFIX.trimStart();
}

/**
 * Normalize a turn list into the shape Anthropic requires: alternating
 * user/assistant, starting with user. Consecutive same-role turns are
 * merged; an empty list becomes a single "." user turn so the request is
 * always valid.
 */
export function normalizeMessages(messages: AiChatMessage[]): AiChatMessage[] {
  const valid = (Array.isArray(messages) ? messages : []).filter(
    (m): m is AiChatMessage =>
      m !== null &&
      typeof m === 'object' &&
      (m.role === 'user' || m.role === 'assistant') &&
      typeof m.content === 'string'
  );

  const merged: AiChatMessage[] = [];
  for (const m of valid) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.role === m.role) {
      last.content += '\n\n' + m.content;
    } else {
      merged.push({ role: m.role, content: m.content });
    }
  }
  if (merged.length === 0) merged.push({ role: 'user', content: '.' });
  if (merged[0]!.role !== 'user') merged.unshift({ role: 'user', content: '.' });
  return merged;
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (b): b is { type: 'text'; text: string } =>
        b !== null &&
        typeof b === 'object' &&
        (b as { type?: unknown }).type === 'text' &&
        typeof (b as { text?: unknown }).text === 'string'
    )
    .map((b) => b.text)
    .join('');
}

// ─── SDK seam (injectable for tests) ─────────────────────────────────────

/** Minimal view of the SDK's MessageStream we depend on. */
export interface ClaudeStreamLike {
  on(event: 'text', listener: (text: string) => void): unknown;
  finalMessage(): Promise<ClaudeMessageLike>;
}

/** Minimal view of the SDK's final Message we read back. */
export interface ClaudeMessageLike {
  content?: unknown;
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: unknown;
}

/** The seam: turns request params into a streamable message. Stubbed in tests. */
export interface ClaudeChatClient {
  stream(params: Record<string, unknown>): ClaudeStreamLike;
}

/**
 * Build the default SDK-backed chat client for a Claude config. Uses
 * `messages.stream()` for BOTH the streaming and non-streaming paths: the
 * SDK refuses plain `messages.create()` when `max_tokens` is large enough
 * that the call could exceed 10 minutes (WISER sends up to 32k), and
 * `stream().finalMessage()` is the supported escape hatch.
 */
export function makeClaudeChatClient(config: ClaudeConfig): ClaudeChatClient {
  const client = new Anthropic({ apiKey: config.apiKey, baseURL: config.baseUrl });
  return {
    stream: (params) =>
      client.messages.stream(
        params as unknown as Anthropic.MessageCreateParamsStreaming
      ) as unknown as ClaudeStreamLike,
  };
}

function buildParams(input: AiChatInput, model: string): Record<string, unknown> {
  const system = buildSystem(input.system, input.jsonMode);
  const messages = normalizeMessages(input.messages);
  const maxTokens =
    typeof input.maxTokens === 'number' && input.maxTokens > 0 ? input.maxTokens : DEFAULT_MAX_TOKENS;
  return {
    model,
    max_tokens: maxTokens,
    messages,
    ...(system !== undefined ? { system } : {}),
    ...(typeof input.temperature === 'number' ? { temperature: input.temperature } : {}),
  };
}

function toResult(model: string, message: ClaudeMessageLike): AiChatResult {
  const usage = {
    inputTokens: typeof message.usage?.input_tokens === 'number' ? message.usage.input_tokens : 0,
    outputTokens: typeof message.usage?.output_tokens === 'number' ? message.usage.output_tokens : 0,
  };
  return {
    content: extractText(message.content),
    usage,
    model,
    provider: 'claude',
    cost: estimateCost(model, usage),
  };
}

// ─── public runners ──────────────────────────────────────────────────────

/** Non-streaming chat. Returns the full result once the model finishes. */
export async function runClaudeChat(
  input: AiChatInput,
  opts: { config: ClaudeConfig; client?: ClaudeChatClient }
): Promise<AiChatResult> {
  const model = profileToModel(input.profile, opts.config.model);
  const client = opts.client ?? makeClaudeChatClient(opts.config);
  try {
    const message = await client.stream(buildParams(input, model)).finalMessage();
    return toResult(model, message);
  } catch (err) {
    throw mapClaudeError(err);
  }
}

/**
 * Streaming chat. Invokes `onDelta` for each text delta as it arrives and
 * resolves with the full result. `onDelta` errors are swallowed so a flaky
 * consumer can't abort the stream.
 */
export async function runClaudeChatStream(
  input: AiChatInput,
  opts: { config: ClaudeConfig; client?: ClaudeChatClient; onDelta: (delta: string) => void }
): Promise<AiChatResult> {
  const model = profileToModel(input.profile, opts.config.model);
  const client = opts.client ?? makeClaudeChatClient(opts.config);
  try {
    const stream = client.stream(buildParams(input, model));
    stream.on('text', (text: string) => {
      try {
        opts.onDelta(text);
      } catch {
        /* a broken consumer must not kill the stream */
      }
    });
    const message = await stream.finalMessage();
    return toResult(model, message);
  } catch (err) {
    throw mapClaudeError(err);
  }
}

/** Validate renderer-supplied chat input, throwing a clear AiError. */
export function assertValidChatInput(input: AiChatInput): void {
  const messages = input?.messages;
  const hasContent =
    Array.isArray(messages) &&
    messages.some(
      (m) => m !== null && typeof m === 'object' && typeof (m as AiChatMessage).content === 'string'
    );
  if (!hasContent) {
    throw new AiError({
      code: AI_ERROR_CODES.INVALID_INPUT,
      message: 'A chat request needs at least one message.',
      context: { op: 'chat' },
      remediation: 'Send a non-empty `messages` array.',
    });
  }
}
