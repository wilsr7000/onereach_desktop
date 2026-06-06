import { describe, it, expect } from 'vitest';
import {
  buildMetadataHints,
  buildMetadataUserContent,
  callClaudeMetadata,
  parseAssetMetadataResult,
  validateAssetMetadataShape,
  ASSET_METADATA_SYSTEM_PROMPT,
} from '../../ai/metadata.js';
import { AiError, AI_ERROR_CODES } from '../../ai/errors.js';
import type { ClaudeCreateParams, ClaudeMessageCreator } from '../../ai/client.js';
import type { AssetMetadataInput } from '../../ai/types.js';

// ─── helpers ───────────────────────────────────────────────────────────────

/** A Claude stub that records the params and returns a fixed text body. */
function recordingClaude(
  text: string,
  stopReason = 'end_turn'
): { createMessage: ClaudeMessageCreator; calls: ClaudeCreateParams[] } {
  const calls: ClaudeCreateParams[] = [];
  const createMessage: ClaudeMessageCreator = async (params) => {
    calls.push(params);
    return { content: [{ type: 'text', text }], stop_reason: stopReason };
  };
  return { createMessage, calls };
}

function claudeThrows(err: unknown): ClaudeMessageCreator {
  return async () => {
    throw err;
  };
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected promise to reject, but it resolved');
}

const FULL_RESULT = JSON.stringify({
  summary: 'A quarterly sales report for Q3.',
  suggestedTitle: 'Q3 Sales Report',
  tags: ['sales', 'q3', 'report'],
  topics: ['revenue', 'forecasting'],
  entities: ['Acme Corp'],
  contentType: 'spreadsheet',
  language: 'en',
  keyPoints: ['Revenue up 12%'],
});

// Type guards for the opaque content-block array.
function block(b: unknown): Record<string, unknown> {
  return b as Record<string, unknown>;
}

// ─── buildMetadataHints ─────────────────────────────────────────────────────

describe('buildMetadataHints', () => {
  it('always includes the asset kind', () => {
    expect(buildMetadataHints({ kind: 'image' })).toContain('Asset kind: image');
  });

  it('includes title / filename / mime / sourceUrl when present', () => {
    const hints = buildMetadataHints({
      kind: 'document',
      title: 'Contract',
      fileName: 'contract.pdf',
      mimeType: 'application/pdf',
      sourceUrl: 'https://example.com/c',
    });
    expect(hints).toContain('Current title: Contract');
    expect(hints).toContain('Filename: contract.pdf');
    expect(hints).toContain('MIME type: application/pdf');
    expect(hints).toContain('Source URL: https://example.com/c');
  });

  it('omits absent / whitespace-only hint lines', () => {
    const hints = buildMetadataHints({ kind: 'text', title: '   ' });
    expect(hints).not.toContain('Current title');
    expect(hints).not.toContain('Filename');
  });
});

// ─── buildMetadataUserContent (request shape per modality) ───────────────────

describe('buildMetadataUserContent', () => {
  it('builds an image (vision) block first, then a text instruction', () => {
    const blocks = buildMetadataUserContent({
      kind: 'image',
      imageBase64: 'aGVsbG8=',
      imageMediaType: 'image/png',
    });
    expect(blocks).toHaveLength(2);
    const img = block(blocks[0]);
    expect(img['type']).toBe('image');
    expect(img['source']).toEqual({
      type: 'base64',
      media_type: 'image/png',
      data: 'aGVsbG8=',
    });
    const txt = block(blocks[1]);
    expect(txt['type']).toBe('text');
    expect(String(txt['text'])).toContain('image above');
  });

  it('builds a PDF document block with application/pdf media type', () => {
    const blocks = buildMetadataUserContent({ kind: 'document', pdfBase64: 'JVBERi0=' });
    const doc = block(blocks[0]);
    expect(doc['type']).toBe('document');
    expect(doc['source']).toEqual({
      type: 'base64',
      media_type: 'application/pdf',
      data: 'JVBERi0=',
    });
    expect(String(block(blocks[1])['text'])).toContain('document above');
  });

  it('wraps a text body between the ASSET markers', () => {
    const blocks = buildMetadataUserContent({ kind: 'text', text: 'hello world' });
    expect(blocks).toHaveLength(1);
    const txt = String(block(blocks[0])['text']);
    expect(txt).toContain('<<<ASSET');
    expect(txt).toContain('hello world');
    expect(txt).toContain('ASSET>>>');
  });

  it('truncates an over-long text body', () => {
    const big = 'x'.repeat(60_000);
    const blocks = buildMetadataUserContent({ kind: 'text', text: big });
    const txt = String(block(blocks[0])['text']);
    expect(txt).toContain('[truncated');
    expect(txt.length).toBeLessThan(big.length);
  });

  it('prefers the image block when both image and text are present', () => {
    const blocks = buildMetadataUserContent({
      kind: 'image',
      imageBase64: 'aGVsbG8=',
      imageMediaType: 'image/jpeg',
      text: 'ignored caption',
    });
    expect(block(blocks[0])['type']).toBe('image');
    expect(JSON.stringify(blocks)).not.toContain('ignored caption');
  });

  it('falls back to a hints-only block when there is no content', () => {
    const blocks = buildMetadataUserContent({ kind: 'audio', title: 'Voice memo' });
    expect(blocks).toHaveLength(1);
    const txt = String(block(blocks[0])['text']);
    expect(txt).toContain('No extractable content');
    expect(txt).toContain('Voice memo');
  });

  it('ignores an image with a base64 payload but no media type', () => {
    // Without a media type we cannot build a valid vision block -> text/hints.
    const blocks = buildMetadataUserContent({ kind: 'image', imageBase64: 'aGVsbG8=' });
    expect(block(blocks[0])['type']).toBe('text');
  });
});

// ─── callClaudeMetadata ──────────────────────────────────────────────────────

describe('callClaudeMetadata', () => {
  const input: AssetMetadataInput = { kind: 'text', text: 'some content' };

  it('sends the system prompt, model, and json_schema output config', async () => {
    const { createMessage, calls } = recordingClaude(FULL_RESULT);
    await callClaudeMetadata(input, { model: 'claude-opus-4-8', createMessage });
    expect(calls).toHaveLength(1);
    const p = calls[0]!;
    expect(p.model).toBe('claude-opus-4-8');
    expect(p.system).toBe(ASSET_METADATA_SYSTEM_PROMPT);
    expect(p.max_tokens).toBeGreaterThan(0);
    expect(p.output_config).toMatchObject({ format: { type: 'json_schema' } });
    expect(p.messages[0]?.role).toBe('user');
    expect(Array.isArray(p.messages[0]?.content)).toBe(true);
  });

  it('returns the parsed, normalized result on success', async () => {
    const { createMessage } = recordingClaude(FULL_RESULT);
    const out = await callClaudeMetadata(input, { model: 'm', createMessage });
    expect(out.suggestedTitle).toBe('Q3 Sales Report');
    expect(out.tags).toEqual(['sales', 'q3', 'report']);
    expect(out.language).toBe('en');
  });

  it('throws AI_PROVIDER_ERROR when Claude refuses', async () => {
    const { createMessage } = recordingClaude('{}', 'refusal');
    const err = await caught(callClaudeMetadata(input, { model: 'm', createMessage }));
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).code).toBe(AI_ERROR_CODES.PROVIDER_ERROR);
  });

  it('maps a 401 from the SDK to AI_AUTH_REJECTED', async () => {
    const createMessage = claudeThrows(Object.assign(new Error('unauthorized'), { status: 401 }));
    const err = await caught(callClaudeMetadata(input, { model: 'm', createMessage }));
    expect((err as AiError).code).toBe(AI_ERROR_CODES.AUTH_REJECTED);
  });

  it('maps a 429 from the SDK to AI_RATE_LIMITED', async () => {
    const createMessage = claudeThrows(Object.assign(new Error('slow down'), { status: 429 }));
    const err = await caught(callClaudeMetadata(input, { model: 'm', createMessage }));
    expect((err as AiError).code).toBe(AI_ERROR_CODES.RATE_LIMITED);
  });

  it('surfaces a BAD_RESPONSE when the model returns non-JSON', async () => {
    const { createMessage } = recordingClaude('not json at all');
    const err = await caught(callClaudeMetadata(input, { model: 'm', createMessage }));
    expect((err as AiError).code).toBe(AI_ERROR_CODES.BAD_RESPONSE);
  });
});

// ─── parseAssetMetadataResult ────────────────────────────────────────────────

describe('parseAssetMetadataResult', () => {
  it('parses a plain JSON object', () => {
    const out = parseAssetMetadataResult(FULL_RESULT);
    expect(out.summary).toContain('quarterly sales');
  });

  it('strips a ```json code fence before parsing', () => {
    const fenced = '```json\n' + FULL_RESULT + '\n```';
    expect(parseAssetMetadataResult(fenced).suggestedTitle).toBe('Q3 Sales Report');
  });

  it('throws BAD_RESPONSE on an empty body', () => {
    expect(() => parseAssetMetadataResult('   ')).toThrowError(AiError);
  });

  it('throws BAD_RESPONSE on malformed JSON', () => {
    const err = (() => {
      try {
        parseAssetMetadataResult('{ broken');
      } catch (e) {
        return e;
      }
    })();
    expect((err as AiError).code).toBe(AI_ERROR_CODES.BAD_RESPONSE);
  });
});

// ─── validateAssetMetadataShape ──────────────────────────────────────────────

describe('validateAssetMetadataShape', () => {
  it('defaults language to "en" when missing', () => {
    const out = validateAssetMetadataShape({ summary: 'x' });
    expect(out.language).toBe('en');
    expect(out.tags).toEqual([]);
  });

  it('caps lists at 12 entries', () => {
    const tags = Array.from({ length: 30 }, (_v, i) => `tag${i}`);
    const out = validateAssetMetadataShape({ tags });
    expect(out.tags).toHaveLength(12);
  });

  it('dedupes list entries case-insensitively and trims', () => {
    const out = validateAssetMetadataShape({ tags: ['Sales', 'sales', '  SALES ', 'q3'] });
    expect(out.tags).toEqual(['Sales', 'q3']);
  });

  it('drops empty / non-string list items', () => {
    const out = validateAssetMetadataShape({ topics: ['', '  ', 7, null, 'real'] });
    expect(out.topics).toEqual(['real']);
  });

  it('coerces non-array list fields to []', () => {
    const out = validateAssetMetadataShape({ tags: 'not-an-array' });
    expect(out.tags).toEqual([]);
  });

  it('throws BAD_RESPONSE for a non-object', () => {
    const err = (() => {
      try {
        validateAssetMetadataShape(['a', 'b']);
      } catch (e) {
        return e;
      }
    })();
    expect((err as AiError).code).toBe(AI_ERROR_CODES.BAD_RESPONSE);
  });
});
