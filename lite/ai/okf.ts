/**
 * Agent-definition → OKF conversion via Claude 4.8.
 *
 * Given an arbitrary agent description (pasted text, or the contents of
 * a fetched URL), ask Claude to produce **OKF** — a human-readable,
 * structured-text (YAML/Markdown-like) agent definition — and to
 * classify the agent's type + suggest a name. Uses the shared
 * {@link ClaudeMessageCreator} seam (unit-testable without network) and
 * constrains the response with a structured-output schema.
 *
 * SECURITY: the API key never appears here (the SDK client holds it).
 * The source IS sent to Anthropic — that's the point — but nothing is
 * logged beyond lengths.
 */

import { AiError, AI_ERROR_CODES } from './errors.js';
import {
  mapClaudeError,
  extractClaudeText,
  type ClaudeCreateParams,
  type ClaudeMessageCreator,
  type ClaudeResponse,
} from './client.js';
import type { OkfConversionResult } from './types.js';

/** OKF can be a sizeable document; give it room. */
const MAX_TOKENS = 4096;
/** Cap the source we send so a giant page can't blow the request. */
const MAX_INPUT_CHARS = 48_000;
/** Cap the OKF we keep, regardless of what the model returns. */
const MAX_OKF_CHARS = 100_000;

export const OKF_SYSTEM_PROMPT = [
  'You convert an agent description into OKF — a single, human-readable, structured-text agent definition (YAML- or Markdown-like).',
  'The input may be polished docs, a raw config dump, a web page, or rough notes about an AI agent.',
  'Produce three things:',
  '- okf: the OKF document as structured text. Use clear top-level sections (e.g. name, type, purpose, instructions/behaviors, inputs, outputs, tools/skills, constraints) as YAML keys or Markdown headings. Capture the agent faithfully and concisely.',
  '- agentType: classify into exactly one of: "conversational", "workflow", "autonomous", "tool", "orchestrator". If none clearly fits, use "other".',
  '- name: a short, specific, human-friendly agent name (<= 80 chars), inferred from the source.',
  'Base everything ONLY on the provided source. Do NOT invent capabilities, tools, or facts that are not present. If the source is empty or unintelligible, return a minimal okf noting that, agentType "other", and a best-effort name.',
  'Respond with ONLY a JSON object matching the schema. No prose, no markdown code fences around the JSON (the okf field itself may contain markdown).',
].join('\n');

/**
 * Structured-output schema. The `okf` string itself carries the
 * YAML/Markdown; the wrapper is JSON so we get agentType + name cleanly.
 */
const OKF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    okf: { type: 'string' },
    agentType: { type: 'string' },
    name: { type: 'string' },
  },
  required: ['okf', 'agentType', 'name'],
} as const;

/** Build the user-turn content: the source text between markers. */
export function buildOkfUserContent(source: string): string {
  const body = truncate(source.trim(), MAX_INPUT_CHARS);
  return [
    'Convert the agent description between the markers into OKF.',
    '<<<AGENT_SOURCE',
    body,
    'AGENT_SOURCE>>>',
  ].join('\n');
}

/**
 * Call Claude to convert a source string into OKF. `createMessage` is
 * the SDK seam. Throws {@link AiError} on auth / network / provider /
 * bad-response.
 */
export async function callClaudeOkf(
  source: string,
  opts: { model: string; createMessage: ClaudeMessageCreator }
): Promise<OkfConversionResult> {
  const params: ClaudeCreateParams = {
    model: opts.model,
    max_tokens: MAX_TOKENS,
    system: OKF_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildOkfUserContent(source) }],
    output_config: { format: { type: 'json_schema', schema: OKF_SCHEMA } },
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
      message: 'Claude declined to convert this agent definition.',
      context: { provider: 'claude', op: 'convert-okf', stopReason: 'refusal' },
      remediation: 'Rephrase the source, or paste the definition manually.',
    });
  }

  return parseOkfResult(extractClaudeText(message));
}

/** Parse a JSON string (possibly fenced) into a validated result. */
export function parseOkfResult(raw: string): OkfConversionResult {
  const stripped = stripCodeFence(raw).trim();
  if (stripped.length === 0) {
    throw badResponse('Claude returned an empty OKF response.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    throw badResponse('Claude did not return valid JSON for the OKF conversion.', err);
  }
  return validateOkfShape(parsed);
}

/** Validate + normalize an already-parsed object. */
export function validateOkfShape(value: unknown): OkfConversionResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw badResponse('Claude OKF result was not a JSON object.');
  }
  const obj = value as Record<string, unknown>;
  const okf = truncate(str(obj['okf']), MAX_OKF_CHARS);
  if (okf.length === 0) {
    throw badResponse('Claude returned an empty OKF document.');
  }
  return {
    okf,
    agentType: str(obj['agentType']) || 'other',
    name: str(obj['name']),
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────

function badResponse(message: string, cause?: unknown): AiError {
  return new AiError({
    code: AI_ERROR_CODES.BAD_RESPONSE,
    message,
    context: { provider: 'claude', op: 'convert-okf' },
    remediation: 'Try again, or paste the OKF definition manually.',
    ...(cause !== undefined ? { cause } : {}),
  });
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  const inner = fence?.[1];
  return inner !== undefined ? inner : trimmed;
}
