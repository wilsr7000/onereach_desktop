/**
 * Spaces detail-pane builders + Markdown renderer (Phase A).
 *
 * Pure-builder tests for the rewritten asset detail surface:
 *   - `buildDetailMeta` (time · size · author lines)
 *   - `buildDetailTags` (chip row from string[])
 *   - `buildDetailContent` (Markdown / Source toggle scaffolding)
 *   - `renderMarkdown` + `renderInlineMarkdown` (minimal Markdown
 *     subset — headers, bold/italic, code, links, lists, fences)
 *   - `formatBytes` (compact byte formatter)
 *   - `buildDetailPane` integration (the orchestrator wires the
 *     pieces together correctly + degrades cleanly when fields are
 *     missing)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeAll } from 'vitest';

interface RendererItemProvenance {
  kind: string;
  name: string;
  id: string;
}

interface RendererItem {
  id: string;
  title: string;
  kind: string;
  fileKey?: string;
  sourceUrl?: string;
  createdAt: string;
  updatedAt: string;
  excerpt?: string;
  otherSpaces: Array<{ id: string; name: string }>;
  producedBy: RendererItemProvenance | null;
  content?: string;
  metadata?: Record<string, unknown>;
  size?: number;
  mimeType?: string;
  tags?: string[];
  lastEditedBy?: RendererItemProvenance | null;
}

interface RendererTestApi {
  buildDetailPane(item: RendererItem, onClose: () => void, mode?: 'rendered' | 'source'): HTMLElement;
  buildDetailMeta(item: RendererItem): HTMLElement;
  buildDetailTags(tags: ReadonlyArray<string>): HTMLElement;
  buildDetailContent(source: string, mode: 'rendered' | 'source'): HTMLElement;
  renderMarkdown(source: string): HTMLElement;
  renderInlineMarkdown(escaped: string): string;
  formatBytes(n: number): string;
}

let renderer: RendererTestApi;

beforeAll(async () => {
  await import('../../spaces/spaces.js');
  renderer = (window as unknown as { __spacesRendererForTesting: RendererTestApi })
    .__spacesRendererForTesting;
  expect(renderer).toBeDefined();
});

function baseItem(overrides: Partial<RendererItem> = {}): RendererItem {
  return {
    id: 'i-1',
    title: 'My Item',
    kind: 'text',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: new Date().toISOString(),
    otherSpaces: [],
    producedBy: null,
    ...overrides,
  };
}

// ─── formatBytes ────────────────────────────────────────────────────────

describe('formatBytes', () => {
  it('returns "" for non-finite / negative', () => {
    expect(renderer.formatBytes(NaN)).toBe('');
    expect(renderer.formatBytes(-1)).toBe('');
    expect(renderer.formatBytes(Infinity)).toBe('');
  });
  it('uses bytes under 1 KB', () => {
    expect(renderer.formatBytes(0)).toBe('0 B');
    expect(renderer.formatBytes(512)).toBe('512 B');
    expect(renderer.formatBytes(999)).toBe('999 B');
  });
  it('uses KB up to 1 MB', () => {
    expect(renderer.formatBytes(1000)).toBe('1.0 KB');
    expect(renderer.formatBytes(1234)).toBe('1.2 KB');
    expect(renderer.formatBytes(999_999)).toBe('1000.0 KB');
  });
  it('uses MB up to 1 GB', () => {
    expect(renderer.formatBytes(1_000_000)).toBe('1.0 MB');
    expect(renderer.formatBytes(12_345_678)).toBe('12.3 MB');
  });
  it('uses GB at scale', () => {
    expect(renderer.formatBytes(2_500_000_000)).toBe('2.5 GB');
  });
});

// ─── renderInlineMarkdown ───────────────────────────────────────────────

describe('renderInlineMarkdown', () => {
  it('renders inline code first so it does not interpret formatting inside', () => {
    expect(renderer.renderInlineMarkdown('use `**raw**` here')).toBe(
      'use <code>**raw**</code> here'
    );
  });
  it('renders bold + italic', () => {
    expect(renderer.renderInlineMarkdown('a **bold** and *em* word')).toBe(
      'a <strong>bold</strong> and <em>em</em> word'
    );
  });
  it('renders http(s) links with safe rel + target', () => {
    expect(
      renderer.renderInlineMarkdown('see [docs](https://example.com/path) for more')
    ).toBe('see <a href="https://example.com/path" target="_blank" rel="noopener noreferrer">docs</a> for more');
  });
  it('ignores non-http(s)/mailto links (XSS guard)', () => {
    expect(
      renderer.renderInlineMarkdown('[click](javascript:alert(1))')
    ).toBe('[click](javascript:alert(1))');
  });
});

// ─── renderMarkdown ─────────────────────────────────────────────────────

describe('renderMarkdown', () => {
  it('returns an empty <div> for empty input', () => {
    const el = renderer.renderMarkdown('');
    expect(el.tagName).toBe('DIV');
    expect(el.children.length).toBe(0);
  });

  it('wraps non-markdown text in a single paragraph', () => {
    const el = renderer.renderMarkdown('Just one line of text.');
    expect(el.querySelectorAll('p')).toHaveLength(1);
    expect(el.querySelector('p')?.textContent).toBe('Just one line of text.');
  });

  it('emits separate paragraphs for blank-line-separated blocks', () => {
    const el = renderer.renderMarkdown('First paragraph.\n\nSecond paragraph.');
    expect(el.querySelectorAll('p')).toHaveLength(2);
  });

  it('renders ATX headers H1-H3', () => {
    const el = renderer.renderMarkdown('# One\n## Two\n### Three');
    expect(el.querySelector('h1')?.textContent).toBe('One');
    expect(el.querySelector('h2')?.textContent).toBe('Two');
    expect(el.querySelector('h3')?.textContent).toBe('Three');
  });

  it('renders unordered lists', () => {
    const el = renderer.renderMarkdown('- alpha\n- bravo\n- charlie');
    const items = el.querySelectorAll('ul li');
    expect(items).toHaveLength(3);
    expect(items[1]?.textContent).toBe('bravo');
  });

  it('renders ordered lists', () => {
    const el = renderer.renderMarkdown('1. one\n2. two');
    const items = el.querySelectorAll('ol li');
    expect(items).toHaveLength(2);
  });

  it('renders fenced code blocks with optional language tag', () => {
    const el = renderer.renderMarkdown('```ts\nconst x = 1;\n```');
    const pre = el.querySelector<HTMLElement>('pre.spaces-markdown-code');
    expect(pre).not.toBeNull();
    expect(pre?.getAttribute('data-lang')).toBe('ts');
    expect(pre?.querySelector('code')?.textContent).toBe('const x = 1;');
  });

  it('does NOT execute HTML embedded in the source (XSS guard)', () => {
    const el = renderer.renderMarkdown('<img src=x onerror=alert(1)>');
    // Should be rendered as escaped text, not a real <img>.
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('preserves inline bold + link composition in a paragraph', () => {
    const el = renderer.renderMarkdown('See **important** notes at [the page](https://example.com).');
    expect(el.querySelector('strong')?.textContent).toBe('important');
    expect(el.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
  });
});

// ─── buildDetailMeta ────────────────────────────────────────────────────

describe('buildDetailMeta', () => {
  it('shows the "Updated …" line', () => {
    const el = renderer.buildDetailMeta(baseItem({ updatedAt: new Date(Date.now() - 60_000).toISOString() }));
    expect(el.textContent ?? '').toMatch(/Updated/);
  });

  it('appends the formatted byte size when present', () => {
    const el = renderer.buildDetailMeta(baseItem({ size: 1500 }));
    expect(el.textContent ?? '').toContain('1.5 KB');
  });

  it('omits byte size when missing / zero', () => {
    const el = renderer.buildDetailMeta(baseItem({ size: 0 }));
    expect(el.textContent ?? '').not.toMatch(/\sB\b/);
  });

  it('shows "Produced by X (Person)" when producedBy is set', () => {
    const el = renderer.buildDetailMeta(
      baseItem({ producedBy: { kind: 'Person', name: 'Robb', id: 'p-1' } })
    );
    expect(el.querySelector('.spaces-detail-provenance')?.textContent).toContain(
      'Produced by Robb (Person)'
    );
  });

  it('adds "Last edited by X" when distinct from producer', () => {
    const el = renderer.buildDetailMeta(
      baseItem({
        producedBy: { kind: 'Person', name: 'Robb', id: 'p-1' },
        lastEditedBy: { kind: 'Person', name: 'Alice', id: 'p-2' },
      })
    );
    expect(el.querySelector('.spaces-detail-provenance')?.textContent).toContain(
      'Last edited by Alice'
    );
  });

  it('suppresses "Last edited by" when the editor IS the producer', () => {
    const el = renderer.buildDetailMeta(
      baseItem({
        producedBy: { kind: 'Person', name: 'Robb', id: 'p-1' },
        lastEditedBy: { kind: 'Person', name: 'Robb', id: 'p-1' },
      })
    );
    expect(el.querySelector('.spaces-detail-provenance')?.textContent).not.toContain(
      'Last edited by'
    );
  });
});

// ─── buildDetailTags ────────────────────────────────────────────────────

describe('buildDetailTags', () => {
  it('renders one chip per tag', () => {
    const el = renderer.buildDetailTags(['policy', 'q3', 'finance']);
    const chips = el.querySelectorAll('.spaces-detail-tag');
    expect(chips).toHaveLength(3);
    expect(chips[1]?.textContent).toBe('q3');
  });

  it('trims whitespace and drops empty entries', () => {
    const el = renderer.buildDetailTags(['  spaced  ', '', '   ', 'real']);
    const chips = el.querySelectorAll('.spaces-detail-tag');
    expect(chips).toHaveLength(2);
    expect(chips[0]?.textContent).toBe('spaced');
    expect(chips[1]?.textContent).toBe('real');
  });

  it('returns an empty container for an empty tag list', () => {
    const el = renderer.buildDetailTags([]);
    expect(el.children.length).toBe(0);
  });
});

// ─── buildDetailContent ─────────────────────────────────────────────────

describe('buildDetailContent', () => {
  it('defaults to rendered mode with toggle row', () => {
    const el = renderer.buildDetailContent('# Hello', 'rendered');
    expect(el.getAttribute('data-mode')).toBe('rendered');
    const renderedBtn = el.querySelector<HTMLButtonElement>(
      '.spaces-detail-toggle-btn[data-mode="rendered"]'
    );
    const sourceBtn = el.querySelector<HTMLButtonElement>(
      '.spaces-detail-toggle-btn[data-mode="source"]'
    );
    expect(renderedBtn?.classList.contains('is-active')).toBe(true);
    expect(sourceBtn?.classList.contains('is-active')).toBe(false);
    expect(el.querySelector('.spaces-markdown h1')?.textContent).toBe('Hello');
  });

  it('starts in source mode when requested', () => {
    const el = renderer.buildDetailContent('# Hello', 'source');
    expect(el.getAttribute('data-mode')).toBe('source');
    expect(el.querySelector('pre.spaces-detail-source-pre')?.textContent).toBe('# Hello');
  });

  it('toggles between source and rendered on button click', () => {
    const el = renderer.buildDetailContent('# Hello', 'rendered');
    const sourceBtn = el.querySelector<HTMLButtonElement>(
      '.spaces-detail-toggle-btn[data-mode="source"]'
    );
    sourceBtn?.click();
    expect(el.getAttribute('data-mode')).toBe('source');
    expect(el.querySelector('pre.spaces-detail-source-pre')).not.toBeNull();
    expect(el.querySelector('.spaces-markdown')).toBeNull();

    const renderedBtn = el.querySelector<HTMLButtonElement>(
      '.spaces-detail-toggle-btn[data-mode="rendered"]'
    );
    renderedBtn?.click();
    expect(el.getAttribute('data-mode')).toBe('rendered');
    expect(el.querySelector('.spaces-markdown')).not.toBeNull();
  });
});

// ─── buildDetailPane (integration of the above) ─────────────────────────

describe('buildDetailPane', () => {
  it('renders kind badge, title, meta, and close button', () => {
    const el = renderer.buildDetailPane(
      baseItem({ title: 'Engineering brief', kind: 'document', size: 1234 }),
      () => undefined
    );
    expect(el.querySelector('.spaces-card-kind')?.textContent).toBe('Doc');
    expect(el.querySelector('.spaces-detail-title')?.textContent).toBe('Engineering brief');
    expect(el.querySelector('.spaces-detail-meta')?.textContent).toContain('1.2 KB');
    expect(el.querySelector<HTMLButtonElement>('.spaces-detail-close')).not.toBeNull();
  });

  it('shows MIME hint next to the kind badge when present', () => {
    const el = renderer.buildDetailPane(
      baseItem({ kind: 'other', mimeType: 'application/pdf' }),
      () => undefined
    );
    expect(el.querySelector('.spaces-detail-mime')?.textContent).toBe('application/pdf');
  });

  it('renders the tag chip row when item has tags', () => {
    const el = renderer.buildDetailPane(
      baseItem({ tags: ['policy', 'q3'] }),
      () => undefined
    );
    expect(el.querySelectorAll('.spaces-detail-tag')).toHaveLength(2);
  });

  it('omits the tag row when tags is empty / undefined', () => {
    const el = renderer.buildDetailPane(baseItem({}), () => undefined);
    expect(el.querySelector('.spaces-detail-tags')).toBeNull();
  });

  it('wraps text content in the Markdown-mode block by default', () => {
    const el = renderer.buildDetailPane(
      baseItem({ content: '## Notes\nMain body.' }),
      () => undefined
    );
    expect(el.querySelector('.spaces-detail-content-block')).not.toBeNull();
    expect(el.querySelector('.spaces-markdown h2')?.textContent).toBe('Notes');
  });

  it('omits the content block when content is missing', () => {
    // baseItem() omits content by default; assert the empty path.
    const el = renderer.buildDetailPane(baseItem(), () => undefined);
    expect(el.querySelector('.spaces-detail-content-block')).toBeNull();
  });

  it('preserves the source link for url-kind items', () => {
    const el = renderer.buildDetailPane(
      baseItem({ kind: 'url', sourceUrl: 'https://example.com/article' }),
      () => undefined
    );
    const link = el.querySelector<HTMLAnchorElement>('.spaces-detail-source a');
    expect(link?.href).toBe('https://example.com/article');
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toBe('noopener noreferrer');
  });

  it('wires the close button to the onClose callback', () => {
    let closed = false;
    const el = renderer.buildDetailPane(baseItem(), () => {
      closed = true;
    });
    el.querySelector<HTMLButtonElement>('.spaces-detail-close')?.click();
    expect(closed).toBe(true);
  });

  it('falls back to "(untitled)" when title is empty', () => {
    const el = renderer.buildDetailPane(baseItem({ title: '' }), () => undefined);
    expect(el.querySelector('.spaces-detail-title')?.textContent).toBe('(untitled)');
  });
});
