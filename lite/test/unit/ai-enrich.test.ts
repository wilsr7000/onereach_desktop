import { describe, it, expect, afterEach } from 'vitest';
import { enrichAsset } from '../../ai/enrich.js';
import { _setSpacesApiForTesting, _resetSpacesApiForTesting } from '../../spaces/api.js';
import { _setFilesApiForTesting, _resetFilesApiForTesting } from '../../files/api.js';
import { _setAiApiForTesting, _resetAiApiForTesting, type AssetMetadataInput } from '../../ai/api.js';
import type { Item } from '../../spaces/api.js';
import type { SpacesApi } from '../../spaces/api.js';
import type { FilesApi } from '../../files/api.js';
import type { AiApi, AssetMetadataResult } from '../../ai/api.js';

// ─── stubs ───────────────────────────────────────────────────────────────────

const RESULT: AssetMetadataResult = {
  summary: 'A short summary.',
  suggestedTitle: 'Nice Title',
  tags: ['alpha', 'beta'],
  topics: ['theme'],
  entities: [],
  contentType: 'note',
  language: 'en',
  keyPoints: ['point one'],
};

interface Wiring {
  item: Item;
  /** Records the input the AI received so we can assert the chosen modality. */
  seen: { input?: AssetMetadataInput; patched?: Record<string, unknown> };
  downloadBytes?: Buffer;
}

function wire(w: Wiring): void {
  const seen = w.seen;
  const spaces = {
    items: {
      get: async (_id: string): Promise<Item | null> => w.item,
      patchMetadata: async (_id: string, patch: Record<string, unknown>): Promise<Item> => {
        seen.patched = patch;
        return w.item;
      },
    },
  } as unknown as SpacesApi;

  const files = {
    download: async (): Promise<ArrayBuffer> => {
      const b = w.downloadBytes ?? Buffer.from('');
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    },
  } as unknown as FilesApi;

  const ai = {
    getStatus: async () => ({ configured: true, provider: 'claude' as const }),
    spaceAssist: async () => ({ description: '', objectives: [] }),
    extractAssetMetadata: async (input: AssetMetadataInput): Promise<AssetMetadataResult> => {
      seen.input = input;
      return RESULT;
    },
  } as unknown as AiApi;

  _setSpacesApiForTesting(spaces);
  _setFilesApiForTesting(files);
  _setAiApiForTesting(ai);
}

function baseItem(over: Partial<Item>): Item {
  return {
    id: 'a1',
    title: 'Asset',
    kind: 'text',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    otherSpaces: [],
    producedBy: null,
    ...over,
  } as Item;
}

afterEach(() => {
  _resetSpacesApiForTesting();
  _resetFilesApiForTesting();
  _resetAiApiForTesting();
});

// ─── enrichAsset: content routing + bag projection ───────────────────────────

describe('enrichAsset', () => {
  it('routes a text body to the text modality and writes ai_* keys', async () => {
    const seen: Wiring['seen'] = {};
    wire({ item: baseItem({ kind: 'text', content: 'the body text' }), seen });

    const out = await enrichAsset('a1');

    expect(seen.input?.text).toBe('the body text');
    expect(out.modality).toBe('text');
    // Bag is ai_-prefixed and drops empty (entities was []).
    expect(out.written['ai_summary']).toBe('A short summary.');
    expect(out.written['ai_tags']).toEqual(['alpha', 'beta']);
    expect(out.written['ai_suggested_title']).toBe('Nice Title');
    expect(out.written).not.toHaveProperty('ai_entities');
    expect(out.written['ai_model']).toBeTruthy();
    // It actually persisted that same bag.
    expect(seen.patched).toEqual(out.written);
  });

  it('routes a data: URL image (no fileKey) to the image modality', async () => {
    const seen: Wiring['seen'] = {};
    // A tiny base64 PNG payload carried inline in `content` (how the
    // new-asset dialog stores uploads — no fileKey).
    const dataUrl = 'data:image/png;base64,aGVsbG8gd29ybGQ=';
    wire({ item: baseItem({ kind: 'image', content: dataUrl }), seen });

    const out = await enrichAsset('a1');

    expect(out.modality).toBe('image');
    expect(seen.input?.imageBase64).toBe('aGVsbG8gd29ybGQ=');
    expect(seen.input?.imageMediaType).toBe('image/png');
    // The raw data URL must NOT leak into the text field.
    expect(seen.input?.text).toBeUndefined();
  });

  it('routes a data: URL PDF (no fileKey) to the pdf modality', async () => {
    const seen: Wiring['seen'] = {};
    const dataUrl = 'data:application/pdf;base64,JVBERi0xLjQK';
    wire({ item: baseItem({ kind: 'document', mimeType: 'application/pdf', content: dataUrl }), seen });

    const out = await enrichAsset('a1');

    expect(out.modality).toBe('pdf');
    expect(seen.input?.pdfBase64).toBe('JVBERi0xLjQK');
  });

  it('downloads a fileKey-backed image and base64-encodes it', async () => {
    const seen: Wiring['seen'] = {};
    wire({
      item: baseItem({ kind: 'image', fileKey: 'space/a1/pic.jpg', mimeType: 'image/jpeg' }),
      seen,
      downloadBytes: Buffer.from('JPEGDATA'),
    });

    const out = await enrichAsset('a1');

    expect(out.modality).toBe('image');
    expect(seen.input?.imageBase64).toBe(Buffer.from('JPEGDATA').toString('base64'));
    expect(seen.input?.imageMediaType).toBe('image/jpeg');
  });

  it('degrades to hints-only when a binary asset has no content or fileKey', async () => {
    const seen: Wiring['seen'] = {};
    wire({ item: baseItem({ kind: 'audio', title: 'Voice memo' }), seen });

    const out = await enrichAsset('a1');

    expect(out.modality).toBe('hints');
    expect(seen.input?.text).toBeUndefined();
    expect(seen.input?.imageBase64).toBeUndefined();
  });

  it('throws when the asset does not exist', async () => {
    const seen: Wiring['seen'] = {};
    wire({ item: baseItem({}), seen });
    // Override get to return null.
    _setSpacesApiForTesting({
      items: {
        get: async () => null,
        patchMetadata: async () => baseItem({}),
      },
    } as unknown as SpacesApi);

    await expect(enrichAsset('missing')).rejects.toThrow(/not found/i);
  });

  it('rejects an empty asset id without touching the providers', async () => {
    await expect(enrichAsset('')).rejects.toThrow(/non-empty/i);
  });
});
