/**
 * AI provider clients.
 *
 *   - Claude  -> the official `@anthropic-ai/sdk` (the AI bridge is a
 *                permanent part of lite, so the dependency is warranted;
 *                added to lite/package.json + externalized in esbuild per
 *                ADR-047's dependency recipe).
 *   - OneReach flow -> raw HTTP to a user-supplied flow URL, authenticated
 *                with a FLOW token minted from the *logged-in session*
 *                (same /refresh_token path the KV transport uses), so the
 *                user never pastes a token.
 *
 * Both paths take an injectable seam (a Claude message-creator, or a
 * `fetch` impl) so they unit-test without real network access.
 *
 * SECURITY: the API key / FLOW token are passed only to the SDK client /
 * request headers. They are never placed in error context, logs, or the
 * response.
 */

import Anthropic from '@anthropic-ai/sdk';
import { AiError, AI_ERROR_CODES } from './errors.js';
import type { ClaudeConfig } from './config.js';
import type { SpaceAssistInput, SpaceAssistResult } from './types.js';

const MAX_TOKENS = 2048;
/** Upper bound on objectives we keep, regardless of what the model returns. */
const MAX_OBJECTIVES = 5;

/**
 * Hard clamp for AI-drafted space descriptions — headroom under the
 * server cap (MAX_SPACE_DESC_LENGTH = 3000 in lite/spaces/types.ts;
 * pinned equal-or-below by test) so a drafted Space always saves.
 */
const AI_DESCRIPTION_MAX = 2800;
const BODY_PREVIEW_CHARS = 200;

/** Default host for minting the per-account FLOW token (matches KV). */
export const FLOW_TOKEN_BASE_URL = 'https://em.edison.api.onereach.ai';

/**
 * System prompt for the Claude path. Short + stable. (It is well under
 * the model's minimum cacheable prefix, so prompt caching does not apply
 * here -- the savings would be negligible for a one-shot draft.)
 */
export const SPACE_ASSIST_SYSTEM_PROMPT = [
  'You are a workspace-setup assistant for Onereach.ai "Spaces" -- collaborative data rooms where people and AI agents organize work around a shared purpose.',
  'Given a short, possibly rough note about what a Space is for, produce:',
  "- description: one or two clear, polished sentences stating the Space's purpose, in plain text (no markdown, no surrounding quotes). Never exceed 2500 characters.",
  '- objectives: 3 to 5 concise, high-level objectives. Each is a short imperative phrase (for example "Centralize vendor contracts"), with no numbering and no trailing punctuation.',
  'Respond with ONLY a JSON object of the form {"description": string, "objectives": string[]}. Do not include any prose, explanation, or markdown code fences.',
].join('\n');

/**
 * Structured-output schema. The structured-output schema subset does not
 * support array length constraints, so the 3-5 count is requested in the
 * prompt and enforced in {@link validateSpaceAssistShape}.
 */
const SPACE_ASSIST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    description: { type: 'string' },
    objectives: { type: 'array', items: { type: 'string' } },
  },
  required: ['description', 'objectives'],
} as const;

/** Build the user-turn text from the rough purpose + optional name. */
export function buildSpaceAssistUserPrompt(input: SpaceAssistInput): string {
  const parts: string[] = [];
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length > 0) parts.push(`Space name: ${name}`);
  parts.push(`What this Space is for: ${input.purpose.trim()}`);
  return parts.join('\n');
}

// ─── Claude (Anthropic SDK) ──────────────────────────────────────────────

/**
 * Minimal request shape we hand to the SDK (structured-output drafting).
 * `content` is `string | unknown[]` so the same seam serves both the
 * plain-text Space-assist path and the multimodal metadata-extraction
 * path (text / image / document content blocks).
 */
export interface ClaudeCreateParams {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: 'user'; content: string | unknown[] }>;
  output_config?: unknown;
}

/** Minimal response shape we read back (decoupled from SDK internals). */
export interface ClaudeResponse {
  content?: unknown;
  stop_reason?: unknown;
}

/** The seam: turns request params into a response. Stubbed in tests. */
export type ClaudeMessageCreator = (params: ClaudeCreateParams) => Promise<ClaudeResponse>;

/**
 * Time bounds for one Claude call (2026-08-08 release review — a
 * main-process `extractAssetMetadata` run hung indefinitely):
 *
 *   - `CLAUDE_ATTEMPT_TIMEOUT_MS` is handed to the SDK, which aborts
 *     the HTTP attempt at the socket level. One opportunistic retry
 *     (`CLAUDE_MAX_RETRIES`) covers transient 429/5xx/connection blips.
 *   - `CLAUDE_DEADLINE_MS` is enforced at the seam below and is
 *     absolute: the returned promise ALWAYS settles by then, even if
 *     the transport wedges in a way the SDK's own timer never sees.
 */
export const CLAUDE_ATTEMPT_TIMEOUT_MS = 60_000;
export const CLAUDE_MAX_RETRIES = 1;
export const CLAUDE_DEADLINE_MS = 90_000;

/**
 * Absolute-deadline guard: settle with the promise, or reject with a
 * NETWORK `AiError` after `ms`. Exported for tests.
 */
export function withClaudeDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new AiError({
          code: AI_ERROR_CODES.NETWORK,
          message: `Claude did not respond within ${Math.round(ms / 1000)}s.`,
          context: { provider: 'claude', timeoutMs: ms },
          remediation: 'Check your network connection and try again.',
        })
      );
    }, ms);
    // Don't let a pending AI call hold the main process open.
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

/**
 * Build the default SDK-backed message creator for a Claude config.
 * Constructs the `Anthropic` client once and returns a `messages.create`
 * caller. Every call is time-bounded (see the constants above) so no
 * caller — in particular main-process enrichment — can wedge on it.
 */
export function makeClaudeMessageCreator(config: ClaudeConfig): ClaudeMessageCreator {
  const client = new Anthropic({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    timeout: CLAUDE_ATTEMPT_TIMEOUT_MS,
    maxRetries: CLAUDE_MAX_RETRIES,
  });
  return async (params) => {
    const message = await withClaudeDeadline(
      client.messages.create(params as unknown as Anthropic.MessageCreateParamsNonStreaming),
      CLAUDE_DEADLINE_MS
    );
    return message as unknown as ClaudeResponse;
  };
}

/** Draft a Space via Claude. `createMessage` is the SDK seam. */
export async function callClaude(
  input: SpaceAssistInput,
  opts: { model: string; createMessage: ClaudeMessageCreator }
): Promise<SpaceAssistResult> {
  const params: ClaudeCreateParams = {
    model: opts.model,
    max_tokens: MAX_TOKENS,
    system: SPACE_ASSIST_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildSpaceAssistUserPrompt(input) }],
    output_config: { format: { type: 'json_schema', schema: SPACE_ASSIST_SCHEMA } },
  };

  let message: ClaudeResponse;
  try {
    message = await opts.createMessage(params);
  } catch (err) {
    throw mapClaudeError(err);
  }

  if (message.stop_reason === 'refusal') {
    throw new AiError({
      code: AI_ERROR_CODES.PROVIDER_ERROR,
      message: 'Claude declined to draft this Space.',
      context: { provider: 'claude', stopReason: 'refusal' },
      remediation: 'Rephrase the purpose and try again, or fill it in manually.',
    });
  }

  return parseSpaceAssistResult(extractClaudeText(message), 'claude');
}

/** Map an SDK error (or test stub) onto an AiError. Never leaks the key. */
export function mapClaudeError(err: unknown): AiError {
  if (err instanceof AiError) return err;
  const e = (err ?? {}) as { status?: unknown; name?: unknown; message?: unknown };
  const status = typeof e.status === 'number' ? e.status : undefined;
  if (status === 401 || status === 403) {
    return new AiError({
      code: AI_ERROR_CODES.AUTH_REJECTED,
      message: 'Claude rejected the API key.',
      context: { provider: 'claude', status },
      remediation: 'Check ANTHROPIC_API_KEY (or ai-config.json) and try again.',
    });
  }
  if (status === 429) {
    return new AiError({
      code: AI_ERROR_CODES.RATE_LIMITED,
      message: 'Claude rate-limited the request.',
      context: { provider: 'claude', status },
      remediation: 'Wait a moment and try again.',
    });
  }
  if (status !== undefined) {
    return new AiError({
      code: AI_ERROR_CODES.PROVIDER_ERROR,
      message: `Claude returned HTTP ${status}.`,
      context: { provider: 'claude', status },
      remediation: 'Try again, or fill in the details manually.',
      cause: err,
    });
  }
  const name = typeof e.name === 'string' ? e.name : '';
  if (err instanceof Anthropic.APIConnectionError || /connection/i.test(name)) {
    return new AiError({
      code: AI_ERROR_CODES.NETWORK,
      message: `Claude request failed to send: ${String(e.message ?? name ?? 'connection error')}`,
      context: { provider: 'claude' },
      remediation: 'Check your network connection (DNS, VPN, proxy) and try again.',
      cause: err,
    });
  }
  return new AiError({
    code: AI_ERROR_CODES.PROVIDER_ERROR,
    message: `Claude error: ${String(e.message ?? 'unknown')}`,
    context: { provider: 'claude' },
    remediation: 'Try again, or fill in the details manually.',
    cause: err,
  });
}

// ─── OneReach flow (login-derived FLOW token) ────────────────────────────

/**
 * Mint a per-account FLOW auth header from the logged-in session, via the
 * public `/http/{accountId}/refresh_token` flow (the same mechanism the
 * KV transport uses). Returns a value ready for the `Authorization`
 * header (always `FLOW <token>`).
 */
export async function mintFlowAuthHeader(
  accountId: string,
  fetchImpl: typeof fetch,
  baseUrl: string = FLOW_TOKEN_BASE_URL
): Promise<string> {
  const url = `${stripTrailingSlash(baseUrl)}/http/${encodeURIComponent(accountId)}/refresh_token`;
  let resp: Response;
  try {
    resp = await fetchImpl(url, { method: 'GET' });
  } catch (err) {
    throw new AiError({
      code: AI_ERROR_CODES.NETWORK,
      message: `OneReach token refresh failed to send: ${(err as Error).message}`,
      context: { provider: 'onereach-flow', op: 'refresh_token' },
      remediation: 'Check your network connection and try again.',
      cause: err,
    });
  }
  const text = await safeText(resp);
  if (!resp.ok) throw mapHttpError('onereach-flow', resp.status, text);

  let data: { token?: unknown; access_token?: unknown };
  try {
    data = JSON.parse(text) as { token?: unknown; access_token?: unknown };
  } catch (err) {
    throw new AiError({
      code: AI_ERROR_CODES.BAD_RESPONSE,
      message: 'OneReach token refresh returned a non-JSON body.',
      context: { provider: 'onereach-flow', op: 'refresh_token', status: resp.status },
      remediation: 'The /refresh_token flow must return `{ token: "..." }`.',
      cause: err,
    });
  }
  const token =
    (typeof data.token === 'string' && data.token) ||
    (typeof data.access_token === 'string' && data.access_token) ||
    '';
  if (token === '') {
    throw new AiError({
      code: AI_ERROR_CODES.PROVIDER_ERROR,
      message: 'OneReach token refresh returned an empty token.',
      context: { provider: 'onereach-flow', op: 'refresh_token', status: resp.status },
      remediation: 'Make sure the /refresh_token flow is deployed for this account.',
    });
  }
  return token.startsWith('FLOW ') ? token : `FLOW ${token}`;
}

/**
 * Call a user-supplied OneReach HTTP flow. The flow receives
 * `{ purpose, name }` with the `Authorization` header set to the
 * login-derived FLOW token, and is expected to return a JSON object
 * containing `description` and `objectives` (top-level or nested under
 * `value` / `data` / `result` / `output` / `response` / `body`). See
 * `lite/ai/README.md` for the contract.
 */
export async function callOneReachFlow(
  input: SpaceAssistInput,
  opts: { url: string; authHeader: string; fetchImpl: typeof fetch }
): Promise<SpaceAssistResult> {
  const payload: { purpose: string; name?: string } = { purpose: input.purpose.trim() };
  if (typeof input.name === 'string' && input.name.trim().length > 0) {
    payload.name = input.name.trim();
  }

  let resp: Response;
  try {
    resp = await opts.fetchImpl(opts.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: opts.authHeader },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new AiError({
      code: AI_ERROR_CODES.NETWORK,
      message: `OneReach flow request failed to send: ${(err as Error).message}`,
      context: { provider: 'onereach-flow', op: 'space-assist' },
      remediation: 'Check the flow URL and your network connection, then try again.',
      cause: err,
    });
  }

  const text = await safeText(resp);
  if (!resp.ok || looksLikeAuthRejection(text)) {
    throw mapHttpError('onereach-flow', resp.status, text);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new AiError({
      code: AI_ERROR_CODES.BAD_RESPONSE,
      message: 'The OneReach flow returned a non-JSON response.',
      context: { provider: 'onereach-flow', status: resp.status, bodyPreview: preview(text) },
      remediation: 'Make sure the flow returns JSON of the form {"description","objectives"}.',
      cause: err,
    });
  }

  return validateSpaceAssistShape(extractAssistObject(parsed), 'onereach-flow');
}

// ─── parsing / validation (pure, exported for tests) ─────────────────────

/**
 * Parse a JSON string (possibly wrapped in a markdown code fence) into a
 * validated {@link SpaceAssistResult}.
 */
export function parseSpaceAssistResult(raw: string, provider: string): SpaceAssistResult {
  const stripped = stripCodeFence(raw).trim();
  if (stripped.length === 0) {
    throw new AiError({
      code: AI_ERROR_CODES.BAD_RESPONSE,
      message: 'The AI provider returned an empty response.',
      context: { provider },
      remediation: 'Try again, or fill in the details manually.',
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    throw new AiError({
      code: AI_ERROR_CODES.BAD_RESPONSE,
      message: 'The AI provider did not return valid JSON.',
      context: { provider, bodyPreview: preview(stripped) },
      remediation: 'Try again, or fill in the details manually.',
      cause: err,
    });
  }
  return validateSpaceAssistShape(parsed, provider);
}

/**
 * Validate + normalize an already-parsed object into a
 * {@link SpaceAssistResult}. Trims fields, drops empty objectives, and
 * caps the list at {@link MAX_OBJECTIVES}.
 */
export function validateSpaceAssistShape(value: unknown, provider: string): SpaceAssistResult {
  const bad = (message: string): AiError =>
    new AiError({
      code: AI_ERROR_CODES.BAD_RESPONSE,
      message,
      context: { provider },
      remediation: 'Try again, or fill in the details manually.',
    });

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw bad('The AI response was not an object with description + objectives.');
  }
  const obj = value as Record<string, unknown>;

  let description = typeof obj['description'] === 'string' ? obj['description'].trim() : '';
  if (description.length === 0) {
    throw bad('The AI response was missing a description.');
  }
  // The model must never write more than the destination field can
  // hold (2026-08-12 user rule). Space descriptions cap at
  // MAX_SPACE_DESC_LENGTH (3000, lite/spaces/types.ts); clamp with
  // headroom at a sentence boundary so an over-eager draft degrades
  // to a clean cut instead of a downstream validation error.
  if (description.length > AI_DESCRIPTION_MAX) {
    const cut = description.slice(0, AI_DESCRIPTION_MAX);
    const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'));
    description = lastStop > AI_DESCRIPTION_MAX * 0.6 ? cut.slice(0, lastStop + 1) : cut;
  }

  const rawObjectives = obj['objectives'];
  if (!Array.isArray(rawObjectives)) {
    throw bad('The AI response was missing an objectives list.');
  }
  const objectives = rawObjectives
    .map((o) => (typeof o === 'string' ? o.trim() : ''))
    .filter((o) => o.length > 0)
    .slice(0, MAX_OBJECTIVES);
  if (objectives.length === 0) {
    throw bad('The AI response did not include any objectives.');
  }

  return { description, objectives };
}

/**
 * Dig a `{description, objectives}`-shaped object out of a flow response.
 * Checks the top level, then common envelope wrappers one level deep.
 */
export function extractAssistObject(parsed: unknown): unknown {
  if (hasAssistKeys(parsed)) return parsed;
  if (parsed !== null && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    for (const key of ['value', 'data', 'result', 'output', 'response', 'body']) {
      if (hasAssistKeys(obj[key])) return obj[key];
    }
  }
  return parsed; // let validateSpaceAssistShape produce a clear error
}

function hasAssistKeys(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return 'description' in obj || 'objectives' in obj;
}

// ─── helpers ─────────────────────────────────────────────────────────────

export function extractClaudeText(message: ClaudeResponse): string {
  if (!Array.isArray(message.content)) return '';
  for (const block of message.content as Array<{ type?: unknown; text?: unknown }>) {
    if (block?.type === 'text' && typeof block.text === 'string') return block.text;
  }
  return '';
}

function mapHttpError(provider: string, status: number, body: string): AiError {
  if (status === 401 || status === 403 || looksLikeAuthRejection(body)) {
    return new AiError({
      code: AI_ERROR_CODES.AUTH_REJECTED,
      message: 'The OneReach flow rejected the session token.',
      context: { provider, status },
      remediation: 'Sign in to OneReach again, then retry.',
    });
  }
  if (status === 429) {
    return new AiError({
      code: AI_ERROR_CODES.RATE_LIMITED,
      message: 'The AI provider rate-limited the request.',
      context: { provider, status },
      remediation: 'Wait a moment and try again.',
    });
  }
  return new AiError({
    code: AI_ERROR_CODES.PROVIDER_ERROR,
    message: `The AI provider returned HTTP ${status}.`,
    context: { provider, status, bodyPreview: preview(body) },
    remediation: 'Try again, or fill in the details manually.',
  });
}

function looksLikeAuthRejection(body: string): boolean {
  return /token was not accepted|unauthor|invalid api key|authentication/i.test(body);
}

async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return '';
  }
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  const inner = fence?.[1];
  return inner !== undefined ? inner : trimmed;
}

function preview(text: string): string {
  return text.length > BODY_PREVIEW_CHARS ? `${text.slice(0, BODY_PREVIEW_CHARS)}...` : text;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
