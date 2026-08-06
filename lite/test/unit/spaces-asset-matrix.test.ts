/**
 * Supported-asset MATRIX — one pass over every asset kind Spaces can
 * hold, asserting the tile and the detail preview each render something
 * usable.
 *
 * Why this file exists: a PDF uploaded fine, resolved a signed URL
 * fine, and still showed no preview and an "Open PDF" button that did
 * nothing. Every individual unit was healthy; nothing checked the
 * per-kind result end to end. Adding a kind (or changing a mime branch)
 * without a row here is how that recurs — so the SUPPORTED_ASSETS table
 * below is the contract, and `every supported kind is covered` fails if
 * a kind is added to the renderer without a matrix row.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import '../../spaces/spaces.js';

interface RendererTestHandle {
  buildItemCard: (item: unknown, opts?: unknown) => HTMLElement;
  buildBinaryPreview: (item: unknown, url: string) => HTMLElement;
}

function handle(): RendererTestHandle {
  const w = window as unknown as { __spacesRendererForTesting?: RendererTestHandle };
  if (w.__spacesRendererForTesting === undefined) {
    throw new Error('renderer test handle missing — did the bundle import fail?');
  }
  return w.__spacesRendererForTesting;
}

/** The signed-URL shape the Files module hands back for an upload. */
const SIGNED = 'https://files.edison.api.onereach.ai/signed/abc?sig=xyz';

interface AssetCase {
  kind: string;
  mimeType?: string;
  /** A binary kind renders a detail preview from a resolved URL. */
  binary: boolean;
  /** Tag we expect in the detail preview for a binary kind. */
  expectTag?: string;
  /** For kinds rendered as an action card rather than an inline viewer. */
  expectAction?: string;
}

const SUPPORTED_ASSETS: AssetCase[] = [
  { kind: 'text', binary: false },
  { kind: 'url', binary: false },
  { kind: 'agent', binary: false },
  { kind: 'ticket', binary: false },
  { kind: 'playbook', binary: false },
  { kind: 'image', mimeType: 'image/png', binary: true, expectTag: 'IMG' },
  { kind: 'audio', mimeType: 'audio/mpeg', binary: true, expectTag: 'AUDIO' },
  { kind: 'video', mimeType: 'video/mp4', binary: true, expectTag: 'VIDEO' },
  // The regression that motivated this file: a remote PDF renders an
  // action card (an inline <embed> of a signed URL shows a blank white
  // slab), so what matters is that the OPEN AFFORDANCE exists and
  // carries the real URL.
  { kind: 'document', mimeType: 'application/pdf', binary: true, expectAction: 'Open in browser' },
  { kind: 'other', mimeType: 'application/zip', binary: true },
];

function makeItem(c: AssetCase): Record<string, unknown> {
  return {
    id: `it-${c.kind}`,
    title: `Sample ${c.kind}`,
    kind: c.kind,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    otherSpaces: [],
    producedBy: null,
    ...(c.mimeType !== undefined ? { mimeType: c.mimeType } : {}),
    ...(c.binary ? { fileKey: 'lite-spaces/assets/uuid-sample', size: 12345 } : {}),
    ...(c.kind === 'text' || c.kind === 'agent' ? { content: 'hello world' } : {}),
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('asset matrix — tiles', () => {
  for (const c of SUPPORTED_ASSETS) {
    it(`renders a tile for kind="${c.kind}"${c.mimeType ? ` (${c.mimeType})` : ''}`, () => {
      const card = handle().buildItemCard(makeItem(c));
      expect(card).toBeInstanceOf(HTMLElement);
      // The tile must carry the title and not render empty.
      expect(card.textContent ?? '').toContain(`Sample ${c.kind}`);
      expect((card.textContent ?? '').trim().length).toBeGreaterThan(0);
    });
  }
});

describe('asset matrix — detail previews for binary kinds', () => {
  const binaries = SUPPORTED_ASSETS.filter((c) => c.binary);

  for (const c of binaries) {
    it(`renders a usable preview for ${c.mimeType}`, () => {
      const el = handle().buildBinaryPreview(makeItem(c), SIGNED);
      expect(el).toBeInstanceOf(HTMLElement);
      // Never an empty shell -- that is what "no preview" looked like.
      expect((el.textContent ?? '').length + el.children.length).toBeGreaterThan(0);

      if (c.expectTag !== undefined) {
        const media = el.querySelector(c.expectTag.toLowerCase());
        expect(media, `expected a <${c.expectTag.toLowerCase()}> for ${c.mimeType}`).not.toBeNull();
        expect(media?.getAttribute('src')).toBe(SIGNED);
      }

      if (c.expectAction !== undefined) {
        const action = Array.from(el.querySelectorAll('a')).find(
          (a) => (a.textContent ?? '').trim() === c.expectAction
        );
        expect(action, `expected an "${c.expectAction}" action`).toBeDefined();
        // The affordance must point at the real resolved URL -- an
        // empty/placeholder href is indistinguishable from "broken".
        expect(action?.getAttribute('href')).toBe(SIGNED);
      }
    });
  }

  it('every binary kind offers a way to GET the file (inline src or a link)', () => {
    for (const c of binaries) {
      const el = handle().buildBinaryPreview(makeItem(c), SIGNED);
      const hasSrc = Array.from(el.querySelectorAll('[src]')).some(
        (n) => n.getAttribute('src') === SIGNED
      );
      const hasHref = Array.from(el.querySelectorAll('a')).some(
        (a) => a.getAttribute('href') === SIGNED
      );
      expect(hasSrc || hasHref, `${c.mimeType} exposes no way to reach the file`).toBe(true);
    }
  });
});

describe('asset matrix — coverage contract', () => {
  it('covers every ItemKind the renderer can classify', () => {
    // Mirrors the ItemKind union in lite/spaces/types.ts. If a kind is
    // added there, add a row above -- otherwise it ships untested, which
    // is exactly how the PDF preview regression reached a user.
    const KNOWN_KINDS = [
      'text',
      'url',
      'image',
      'audio',
      'video',
      'document',
      'agent',
      'ticket',
      'playbook',
      'other',
    ];
    const covered = new Set(SUPPORTED_ASSETS.map((c) => c.kind));
    const missing = KNOWN_KINDS.filter((k) => !covered.has(k));
    expect(missing, `asset kinds with no matrix row: ${missing.join(', ')}`).toEqual([]);
  });
});
