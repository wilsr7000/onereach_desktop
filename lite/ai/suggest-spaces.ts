/**
 * "Which Spaces does this belong in?" — Claude reads an item alongside
 * the Space names + descriptions and proposes the best fits, each with
 * a one-line reason.
 *
 * Why this exists: adding an item to several Spaces meant knowing the
 * whole Space list by heart and picking one at a time from a dropdown.
 * The names and descriptions already say what each Space is for, so the
 * model can shortlist and explain — turning recall into recognition.
 *
 * Guarantees the UI depends on:
 *   - Every returned `spaceId` is one that was PASSED IN. A model that
 *     invents an id (or echoes a name) is dropped, so the picker can
 *     never render a Space that doesn't exist.
 *   - Suggestions are de-duplicated and capped.
 *   - Reasons are short, single-line, and truncated.
 *
 * Prompt/schema/parse are pure and exported so the whole surface is
 * testable without a network call — same shape as `okf.ts`.
 */

import { AiError, AI_ERROR_CODES } from './errors.js';
import {
  mapClaudeError,
  extractClaudeText,
  type ClaudeCreateParams,
  type ClaudeMessageCreator,
  type ClaudeResponse,
} from './client.js';

const MAX_TOKENS = 1024;
/** Cap on the item text we send; enough to classify, cheap to send. */
const MAX_ITEM_CHARS = 4_000;
/** Cap on how many Spaces we describe to the model. */
export const MAX_SPACES_CONSIDERED = 60;
/** Cap on suggestions returned to the UI. */
export const MAX_SUGGESTIONS = 3;
/** Cap on a single reason string. */
const MAX_REASON_CHARS = 140;

/** One Space as the model sees it. */
export interface SuggestSpaceCandidate {
  id: string;
  name: string;
  description?: string;
}

/** The item being placed. */
export interface SuggestSpacesItem {
  title: string;
  kind?: string;
  /** Excerpt or content snippet — whatever the caller has. */
  text?: string;
}

export interface SpaceSuggestion {
  spaceId: string;
  /** Short, human-readable justification shown under the Space name. */
  reason: string;
}

export interface SuggestSpacesResult {
  suggestions: SpaceSuggestion[];
}

export const SUGGEST_SPACES_SYSTEM_PROMPT = [
  'You help file an item into the right Spaces in a knowledge workspace.',
  'A Space is a project/topic container. An item may belong in SEVERAL Spaces.',
  '',
  'You are given the item and a list of candidate Spaces (id, name, description).',
  'Return the Spaces the item genuinely belongs in, best match first.',
  '',
  'Rules:',
  '- Use ONLY ids from the provided candidate list. Never invent an id.',
  `- Return at most ${MAX_SUGGESTIONS} suggestions.`,
  '- Only suggest a Space when the item plausibly belongs there. Returning',
  '  an EMPTY list is correct and expected when nothing fits — do not pad',
  '  the list to reach the maximum.',
  '- Do not suggest a Space the item is already in (those are excluded',
  '  from the candidates you receive).',
  '- Each reason: one short sentence, under 20 words, concrete about WHY',
  '  this item matches THIS Space. No restating the Space name alone.',
].join('\n');

export const SUGGEST_SPACES_SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          spaceId: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['spaceId', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['suggestions'],
  additionalProperties: false,
} as const;

/** Build the user turn: the item, then the candidate Spaces. */
export function buildSuggestSpacesUserContent(
  item: SuggestSpacesItem,
  candidates: ReadonlyArray<SuggestSpaceCandidate>
): string {
  const lines: string[] = [];
  lines.push('ITEM');
  lines.push(`title: ${item.title}`);
  if (typeof item.kind === 'string' && item.kind.length > 0) {
    lines.push(`kind: ${item.kind}`);
  }
  const text = typeof item.text === 'string' ? item.text.trim() : '';
  if (text.length > 0) {
    lines.push('content:');
    lines.push(text.length > MAX_ITEM_CHARS ? `${text.slice(0, MAX_ITEM_CHARS)}…` : text);
  }
  lines.push('');
  lines.push('CANDIDATE SPACES');
  for (const c of candidates.slice(0, MAX_SPACES_CONSIDERED)) {
    const desc =
      typeof c.description === 'string' && c.description.trim().length > 0
        ? ` — ${c.description.trim().slice(0, 300)}`
        : '';
    lines.push(`- id=${c.id} | ${c.name}${desc}`);
  }
  return lines.join('\n');
}

export async function callClaudeSuggestSpaces(
  item: SuggestSpacesItem,
  candidates: ReadonlyArray<SuggestSpaceCandidate>,
  opts: { model: string; createMessage: ClaudeMessageCreator }
): Promise<SuggestSpacesResult> {
  const params: ClaudeCreateParams = {
    model: opts.model,
    max_tokens: MAX_TOKENS,
    system: SUGGEST_SPACES_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildSuggestSpacesUserContent(item, candidates) }],
    output_config: { format: { type: 'json_schema', schema: SUGGEST_SPACES_SCHEMA } },
  };

  let message: ClaudeResponse;
  try {
    message = await opts.createMessage(params);
  } catch (err) {
    throw mapClaudeError(err);
  }

  if (message.stop_reason === 'refusal') {
    // Soft-fail: suggestions are an ACCELERANT, not the feature. The
    // picker still lists every Space, so a refusal must not block
    // filing -- it just means no shortlist.
    return { suggestions: [] };
  }

  return parseSuggestSpacesResult(extractClaudeText(message), candidates);
}

/** Parse a JSON string (possibly fenced) into a validated result. */
export function parseSuggestSpacesResult(
  raw: string,
  candidates: ReadonlyArray<SuggestSpaceCandidate>
): SuggestSpacesResult {
  const stripped = stripFence(raw).trim();
  if (stripped.length === 0) return { suggestions: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    throw new AiError({
      code: AI_ERROR_CODES.BAD_RESPONSE,
      message: 'Claude did not return valid JSON for the Space suggestions.',
      context: { provider: 'claude', op: 'suggest-spaces' },
      remediation: 'Try again; if it persists, pick Spaces manually.',
      ...(err instanceof Error ? { cause: err } : {}),
    });
  }
  return validateSuggestSpacesShape(parsed, candidates);
}

/**
 * Validate + normalize. Drops anything whose id is not a real
 * candidate, so a hallucinated Space can never reach the UI.
 */
export function validateSuggestSpacesShape(
  value: unknown,
  candidates: ReadonlyArray<SuggestSpaceCandidate>
): SuggestSpacesResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { suggestions: [] };
  }
  const rawList = (value as Record<string, unknown>)['suggestions'];
  if (!Array.isArray(rawList)) return { suggestions: [] };

  const valid = new Set(candidates.map((c) => c.id));
  const seen = new Set<string>();
  const out: SpaceSuggestion[] = [];

  for (const entry of rawList) {
    if (entry === null || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const spaceId = typeof obj['spaceId'] === 'string' ? obj['spaceId'].trim() : '';
    if (spaceId.length === 0 || !valid.has(spaceId) || seen.has(spaceId)) continue;
    const reasonRaw = typeof obj['reason'] === 'string' ? obj['reason'].trim() : '';
    const reason = reasonRaw
      .replace(/\s+/g, ' ')
      .slice(0, MAX_REASON_CHARS);
    seen.add(spaceId);
    out.push({ spaceId, reason });
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return { suggestions: out };
}

function stripFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```[a-zA-Z]*\s*/, '')
    .replace(/```$/, '')
    .trim();
}
