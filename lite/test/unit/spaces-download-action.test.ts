/**
 * Detail-header Download action (2026-08-10 — "no way to download an
 * asset"). Every asset kind must be downloadable: inline-content items
 * save client-side; binary items resolve a signed URL; genuinely empty
 * items get no button.
 */

// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  buildDetailDownloadButton,
  downloadFilenameForItem,
} from '../../spaces/spaces.js';

// RendererItem is a private alias in spaces.ts — derive the param type
// from the function signature instead of importing it.
type RItem = Parameters<typeof buildDetailDownloadButton>[0];

const item = (over: Partial<RItem>): RItem =>
  ({
    id: 'i1',
    spaceId: 's1',
    kind: 'text',
    title: 'My Note',
    ...over,
  }) as RItem;

describe('buildDetailDownloadButton — presence per kind', () => {
  it('renders for an inline-content item', () => {
    const btn = buildDetailDownloadButton(item({ kind: 'knowledge', content: '# hi' }));
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute('aria-label')).toBe('Download this asset');
  });

  it('renders for a binary (fileKey) item even without inline content', () => {
    const btn = buildDetailDownloadButton(item({ kind: 'image', fileKey: 'files/abc' }));
    expect(btn).not.toBeNull();
  });

  it('renders null when there is nothing to download (no content, no file)', () => {
    const btn = buildDetailDownloadButton(item({ kind: 'text' }));
    expect(btn).toBeNull();
  });
});

describe('downloadFilenameForItem — safe, extension-bearing', () => {
  it('infers .md for inline knowledge/playbook by kind', () => {
    expect(downloadFilenameForItem(item({ kind: 'playbook', title: 'Release ritual' }))).toBe(
      'Release ritual.md'
    );
  });

  it('honors an explicit mimeType over the kind default', () => {
    expect(
      downloadFilenameForItem(item({ kind: 'knowledge', title: 'Data', mimeType: 'application/json' }))
    ).toBe('Data.json');
  });

  it('strips filesystem-hostile characters from the title', () => {
    const name = downloadFilenameForItem(item({ kind: 'text', title: 'a/b:c*?"<>|d' }));
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
    expect(name.endsWith('.txt')).toBe(true);
  });

  it('does not double-extend a title that already has one', () => {
    expect(downloadFilenameForItem(item({ kind: 'text', title: 'notes.txt' }))).toBe('notes.txt');
  });

  it('always yields a non-empty, extension-bearing filename (even for a blank title)', () => {
    const name = downloadFilenameForItem(item({ kind: 'text', title: '   ' }));
    expect(name.length).toBeGreaterThan(0);
    expect(/\.[a-z0-9]{1,8}$/i.test(name)).toBe(true);
  });
});

// ── Viewed-by list (asset audit trail, 2026-08-10) ───────────────────
import { buildDetailViewers } from '../../spaces/spaces.js';

describe('buildDetailViewers — the "Viewed by" list', () => {
  it('renders nothing for zero viewers', () => {
    const el = buildDetailViewers([]);
    expect(el.querySelector('.spaces-detail-viewers-heading')).toBeNull();
    expect(el.textContent).toBe('');
  });

  it('renders a heading with the count and one row per viewer', () => {
    const el = buildDetailViewers([
      { viewerId: 'u1', name: 'Ada', email: '', firstAt: 1000, lastAt: 2000, count: 3 },
      { viewerId: 'u2', name: '', email: '', firstAt: null, lastAt: 5000, count: 1 },
    ]);
    expect(el.querySelector('.spaces-detail-viewers-heading')?.textContent).toBe('Viewed by 2');
    const rows = el.querySelectorAll('.spaces-detail-viewers-row');
    expect(rows.length).toBe(2);
    // falls back to viewerId when name is empty
    expect(rows[1]?.querySelector('.spaces-detail-viewers-name')?.textContent).toBe('u2');
    // multi-view shows the count suffix
    expect(rows[0]?.querySelector('.spaces-detail-viewers-when')?.textContent).toContain('3×');
  });
});
