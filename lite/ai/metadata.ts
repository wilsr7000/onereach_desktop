/**
 * Asset metadata extraction via Claude 4.8.
 *
 * Content-in / metadata-out: given an asset's text body, image bytes, or
 * PDF bytes, ask Claude to produce structured metadata (summary, tags,
 * topics, entities, ...). Uses the official `@anthropic-ai/sdk` through
 * the shared {@link ClaudeMessageCreator} seam (so it unit-tests without
 * network), and constrains the response with a structured-output schema.
 *
 * Multimodal: the user turn carries a content-block array —
 *   - text  -> a `text` block with the (truncated) body
 *   - image -> an `image` block (base64) — Claude vision
 *   - pdf   -> a `document` block (base64) — Claude document understanding
 *   - none  -> title / filename / sourceUrl hints only
 *
 * SECURITY: the API key never appears here (the SDK client holds it). The
 * asset content IS sent to Anthropic — that's the point — but nothing is
 * logged beyond lengths + the chosen modality.
 */

import { AiError, AI_ERROR_CODES } from './errors.js';
import {
  mapClaudeError,
  extractClaudeText,
  type ClaudeCreateParams,
  type ClaudeMessageCreator,
  type ClaudeResponse,
} from './client.js';
import type { AssetMetadataInput, AssetMetadataResult } from './types.js';

/** Generous ceiling for a metadata extraction. The schema is small. */
const MAX_TOKENS = 1536;
/** Cap the text body we send so a giant transcript can't blow the request. */
const MAX_TEXT_CHARS = 48_000;
/** Cap each returned array so a runaway model can't bloat the metadata bag. */
const MAX_LIST = 12;

export const ASSET_METADATA_SYSTEM_PROMPT = [
  'You are a metadata extraction assistant for a knowledge workspace.',
  'Given a single asset (text, an image, or a document) plus a few hints, produce concise, accurate metadata that helps a person find and understand it later.',
  'Rules:',
  '- summary: 1 to 3 plain sentences describing what the asset is and contains. No preamble like "This asset...".',
  '- suggestedTitle: a short, specific, human-friendly title (<= 80 chars). It may match the existing title.',
  '- tags: 3 to 8 short lowercase keyword tags, no leading "#", no spaces inside a tag (use hyphens).',
  '- topics: 2 to 5 higher-level topics or themes.',
  '- entities: notable named entities (people, organizations, products, places). Empty array if none.',
  '- contentType: a short label for the KIND of content (e.g. "meeting transcript", "invoice", "API documentation", "architecture diagram").',
  '- language: the dominant content language as a short code (e.g. "en", "es"). Use "en" if unsure.',
  '- keyPoints: up to 5 key points or takeaways, each a short phrase or sentence. Empty array if not applicable.',
  'Base everything ONLY on the provided content and hints. Do not invent facts. If the content is empty or unintelligible, return empty arrays and a brief summary noting that.',
  'Respond with ONLY a JSON object matching the schema. No prose, no markdown code fences.',
].join('\n');

/**
 * Structured-output schema. Array-length bounds aren't expressible in the
 * supported JSON-schema subset, so counts are requested in the prompt and
 * capped in {@link validateAssetMetadataShape}.
 */
const ASSET_METADATA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    suggestedTitle: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    topics: { type: 'array', items: { type: 'string' } },
    entities: { type: 'array', items: { type: 'string' } },
    contentType: { type: 'string' },
    language: { type: 'string' },
    keyPoints: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'summary',
    'suggestedTitle',
    'tags',
    'topics',
    'entities',
    'contentType',
    'language',
    'keyPoints',
  ],
} as const;

/**
 * Build the human-readable hint preamble (title / filename / kind / URL).
 * Always present so the model has anchoring context even for binary
 * assets with no extractable text.
 */
export function buildMetadataHints(input: AssetMetadataInput): string {
  const lines: string[] = [];
  lines.push(`Asset kind: ${input.kind}`);
  if (typeof input.title === 'string' && input.title.trim().length > 0) {
    lines.push(`Current title: ${input.title.trim()}`);
  }
  if (typeof input.fileName === 'string' && input.fileName.trim().length > 0) {
    lines.push(`Filename: ${input.fileName.trim()}`);
  }
  if (typeof input.mimeType === 'string' && input.mimeType.trim().length > 0) {
    lines.push(`MIME type: ${input.mimeType.trim()}`);
  }
  if (typeof input.sourceUrl === 'string' && input.sourceUrl.trim().length > 0) {
    lines.push(`Source URL: ${input.sourceUrl.trim()}`);
  }
  return lines.join('\n');
}

/**
 * Build the multimodal user-turn content array. Exported for tests so the
 * request shape (which block type is chosen for each modality) is
 * assertable without a live SDK.
 */
export function buildMetadataUserContent(input: AssetMetadataInput): unknown[] {
  const hints = buildMetadataHints(input);
  const blocks: unknown[] = [];

  // Image: vision block first, then the instruction.
  if (
    typeof input.imageBase64 === 'string' &&
    input.imageBase64.length > 0 &&
    typeof input.imageMediaType === 'string' &&
    input.imageMediaType.length > 0
  ) {
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: input.imageMediaType,
        data: input.imageBase64,
      },
    });
    blocks.push({
      type: 'text',
      text: `${hints}\n\nExtract metadata for the image above.`,
    });
    return blocks;
  }

  // PDF: document block, then the instruction.
  if (typeof input.pdfBase64 === 'string' && input.pdfBase64.length > 0) {
    blocks.push({
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: input.pdfBase64,
      },
    });
    blocks.push({
      type: 'text',
      text: `${hints}\n\nExtract metadata for the document above.`,
    });
    return blocks;
  }

  // Text body (truncated).
  if (typeof input.text === 'string' && input.text.trim().length > 0) {
    const body = truncate(input.text.trim(), MAX_TEXT_CHARS);
    blocks.push({
      type: 'text',
      text: `${hints}\n\nAsset content follows between the markers.\n<<<ASSET\n${body}\nASSET>>>\n\nExtract metadata for the content above.`,
    });
    return blocks;
  }

  // No extractable content — hints only.
  blocks.push({
    type: 'text',
    text: `${hints}\n\nNo extractable content is available (binary or media asset). Produce best-effort metadata from the hints alone; prefer empty arrays over guesses.`,
  });
  return blocks;
}

/**
 * Call Claude to extract metadata. `createMessage` is the SDK seam.
 * Throws {@link AiError} on auth / network / provider / bad-response.
 */
export async function callClaudeMetadata(
  input: AssetMetadataInput,
  opts: { model: string; createMessage: ClaudeMessageCreator }
): Promise<AssetMetadataResult> {
  const params: ClaudeCreateParams = {
    model: opts.model,
    max_tokens: MAX_TOKENS,
    system: ASSET_METADATA_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildMetadataUserContent(input) }],
    output_config: { format: { type: 'json_schema', schema: ASSET_METADATA_SCHEMA } },
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
      message: 'Claude declined to extract metadata for this asset.',
      context: { provider: 'claude', op: 'extract-metadata', stopReason: 'refusal' },
      remediation: 'The content may be disallowed. Add metadata manually instead.',
    });
  }

  return parseAssetMetadataResult(extractClaudeText(message));
}

/** Parse a JSON string (possibly fenced) into a validated result. */
export function parseAssetMetadataResult(raw: string): AssetMetadataResult {
  const stripped = stripCodeFence(raw).trim();
  if (stripped.length === 0) {
    throw badResponse('Claude returned an empty metadata response.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    throw badResponse('Claude did not return valid JSON metadata.', err);
  }
  return validateAssetMetadataShape(parsed);
}

/** Validate + normalize an already-parsed object. Caps every list. */
export function validateAssetMetadataShape(value: unknown): AssetMetadataResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw badResponse('Claude metadata was not a JSON object.');
  }
  const obj = value as Record<string, unknown>;
  return {
    summary: str(obj['summary']),
    suggestedTitle: str(obj['suggestedTitle']),
    tags: strList(obj['tags']),
    topics: strList(obj['topics']),
    entities: strList(obj['entities']),
    contentType: str(obj['contentType']),
    language: str(obj['language']) || 'en',
    keyPoints: strList(obj['keyPoints']),
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────

function badResponse(message: string, cause?: unknown): AiError {
  return new AiError({
    code: AI_ERROR_CODES.BAD_RESPONSE,
    message,
    context: { provider: 'claude', op: 'extract-metadata' },
    remediation: 'Try again, or add metadata manually.',
    ...(cause !== undefined ? { cause } : {}),
  });
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    const s = typeof item === 'string' ? item.trim() : '';
    if (s.length === 0) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= MAX_LIST) break;
  }
  return out;
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
