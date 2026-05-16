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

interface DetailEditCallbacks {
  onTitleSave?: (next: string) => Promise<void>;
  onTypeChange?: (next: string) => Promise<void>;
  onTagAdd?: (tag: string) => Promise<void>;
  onTagRemove?: (tag: string) => Promise<void>;
}

interface RendererActivityEvent {
  id: string;
  author: string;
  kind: string;
  timestamp: string;
  spaceId?: string;
  spaceName?: string;
}

interface RendererTestApi {
  buildDetailPane(
    item: RendererItem,
    onClose: () => void,
    mode?: 'rendered' | 'source',
    edit?: DetailEditCallbacks
  ): HTMLElement;
  buildDetailMeta(item: RendererItem): HTMLElement;
  buildDetailTags(tags: ReadonlyArray<string>, edit?: DetailEditCallbacks): HTMLElement;
  buildDetailContent(source: string, mode: 'rendered' | 'source'): HTMLElement;
  buildEditableTitle(initial: string, onTitleSave: (next: string) => Promise<void>): HTMLElement;
  buildKindReclassify(
    item: RendererItem,
    onTypeChange: (next: string) => Promise<void>
  ): HTMLElement;
  buildAttributionChip(item: RendererItem): HTMLElement | null;
  buildDetailActivity(events: ReadonlyArray<RendererActivityEvent>): HTMLElement;
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

// ─── Phase B: buildEditableTitle ────────────────────────────────────────

describe('buildEditableTitle', () => {
  // Helper to flush a single microtask round — Promise callbacks in
  // commit() resolve after the click handler returns; one await yields
  // control long enough for the DOM swap to happen.
  const flush = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };

  it('renders the initial title as a click-to-edit h2', () => {
    const el = renderer.buildEditableTitle('Hello world', async () => undefined);
    const h2 = el.querySelector<HTMLElement>('h2.spaces-detail-title');
    expect(h2?.classList.contains('is-editable')).toBe(true);
    expect(h2?.getAttribute('role')).toBe('button');
    expect(h2?.textContent).toBe('Hello world');
  });

  it('falls back to "(untitled)" when initial is empty', () => {
    const el = renderer.buildEditableTitle('', async () => undefined);
    expect(el.querySelector('h2')?.textContent).toBe('(untitled)');
  });

  it('swaps to an <input> on click', () => {
    const el = renderer.buildEditableTitle('Old name', async () => undefined);
    el.querySelector<HTMLElement>('h2')?.click();
    const input = el.querySelector<HTMLInputElement>('input.spaces-detail-title-input');
    expect(input).not.toBeNull();
    expect(input?.value).toBe('Old name');
    // The h2 is replaced — should no longer be a child while editing.
    expect(el.querySelector('h2')).toBeNull();
  });

  it('also swaps on Enter / Space keypress for keyboard users', () => {
    const el = renderer.buildEditableTitle('Old name', async () => undefined);
    const h2 = el.querySelector<HTMLElement>('h2');
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    h2?.dispatchEvent(ev);
    expect(el.querySelector('input.spaces-detail-title-input')).not.toBeNull();
  });

  it('saves on Enter and updates the displayed title', async () => {
    const saves: string[] = [];
    const el = renderer.buildEditableTitle('Old', async (next) => {
      saves.push(next);
    });
    el.querySelector<HTMLElement>('h2')?.click();
    const input = el.querySelector<HTMLInputElement>('input')!;
    input.value = 'New title';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    await flush();
    expect(saves).toEqual(['New title']);
    expect(el.querySelector('h2')?.textContent).toBe('New title');
    expect(el.querySelector('input')).toBeNull();
  });

  it('trims whitespace before saving', async () => {
    const saves: string[] = [];
    const el = renderer.buildEditableTitle('Old', async (next) => {
      saves.push(next);
    });
    el.querySelector<HTMLElement>('h2')?.click();
    const input = el.querySelector<HTMLInputElement>('input')!;
    input.value = '   padded   ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    await flush();
    expect(saves).toEqual(['padded']);
    expect(el.querySelector('h2')?.textContent).toBe('padded');
  });

  it('Esc cancels: no callback fires and the original title is restored', async () => {
    const saves: string[] = [];
    const el = renderer.buildEditableTitle('Original', async (next) => {
      saves.push(next);
    });
    el.querySelector<HTMLElement>('h2')?.click();
    const input = el.querySelector<HTMLInputElement>('input')!;
    input.value = 'Garbage edit';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    await flush();
    expect(saves).toEqual([]);
    expect(el.querySelector('h2')?.textContent).toBe('Original');
  });

  it('blur saves the current input value', async () => {
    const saves: string[] = [];
    const el = renderer.buildEditableTitle('Old', async (next) => {
      saves.push(next);
    });
    el.querySelector<HTMLElement>('h2')?.click();
    const input = el.querySelector<HTMLInputElement>('input')!;
    input.value = 'Saved on blur';
    input.dispatchEvent(new Event('blur'));
    await flush();
    expect(saves).toEqual(['Saved on blur']);
  });

  it('empty input bails without calling the save callback', async () => {
    const saves: string[] = [];
    const el = renderer.buildEditableTitle('Original', async (next) => {
      saves.push(next);
    });
    el.querySelector<HTMLElement>('h2')?.click();
    const input = el.querySelector<HTMLInputElement>('input')!;
    input.value = '   ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    await flush();
    expect(saves).toEqual([]);
    expect(el.querySelector('h2')?.textContent).toBe('Original');
  });

  it('unchanged input bails without calling the save callback', async () => {
    const saves: string[] = [];
    const el = renderer.buildEditableTitle('Same', async (next) => {
      saves.push(next);
    });
    el.querySelector<HTMLElement>('h2')?.click();
    const input = el.querySelector<HTMLInputElement>('input')!;
    // Value identical to current
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    await flush();
    expect(saves).toEqual([]);
    expect(el.querySelector('h2')?.textContent).toBe('Same');
  });

  it('rolls back to editable input on save error so the user can retry', async () => {
    let attempts = 0;
    const el = renderer.buildEditableTitle('Old', async () => {
      attempts += 1;
      throw new Error('network');
    });
    el.querySelector<HTMLElement>('h2')?.click();
    const input = el.querySelector<HTMLInputElement>('input')!;
    input.value = 'New';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    await flush();
    expect(attempts).toBe(1);
    // Still in input mode after the failure; user-typed value preserved.
    const stillInput = el.querySelector<HTMLInputElement>('input');
    expect(stillInput).not.toBeNull();
    expect(stillInput?.value).toBe('New');
    expect(stillInput?.disabled).toBe(false);
  });

  it('clamps input length to 200 chars', () => {
    const el = renderer.buildEditableTitle('Old', async () => undefined);
    el.querySelector<HTMLElement>('h2')?.click();
    const input = el.querySelector<HTMLInputElement>('input')!;
    expect(input.maxLength).toBe(200);
  });
});

// ─── Phase B: buildKindReclassify ───────────────────────────────────────

describe('buildKindReclassify', () => {
  const flush = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };

  it('renders a <select> with the current kind pre-selected', () => {
    const el = renderer.buildKindReclassify(baseItem({ kind: 'document' }), async () => undefined);
    const select = el.querySelector<HTMLSelectElement>('select.spaces-detail-reclassify-select');
    expect(select).not.toBeNull();
    expect(select?.value).toBe('document');
    expect(el.getAttribute('data-current-kind')).toBe('document');
  });

  it('includes the editable kind options (doc, image, url, text, audio, video, other)', () => {
    const el = renderer.buildKindReclassify(baseItem({ kind: 'text' }), async () => undefined);
    const values = Array.from(el.querySelectorAll<HTMLOptionElement>('option')).map(
      (o) => o.value
    );
    expect(values).toEqual(['document', 'image', 'url', 'text', 'audio', 'video', 'other']);
  });

  it('calls onTypeChange with the new kind on change', async () => {
    const calls: string[] = [];
    const el = renderer.buildKindReclassify(baseItem({ kind: 'text' }), async (next) => {
      calls.push(next);
    });
    const select = el.querySelector<HTMLSelectElement>('select')!;
    select.value = 'document';
    select.dispatchEvent(new Event('change'));
    await flush();
    expect(calls).toEqual(['document']);
  });

  it('does NOT call onTypeChange when the user selects the same kind', async () => {
    const calls: string[] = [];
    const el = renderer.buildKindReclassify(baseItem({ kind: 'text' }), async (next) => {
      calls.push(next);
    });
    const select = el.querySelector<HTMLSelectElement>('select')!;
    select.value = 'text';
    select.dispatchEvent(new Event('change'));
    await flush();
    expect(calls).toEqual([]);
  });

  it('disables the select while a change is pending and re-enables after success', async () => {
    let resolve: (() => void) | null = null;
    const el = renderer.buildKindReclassify(baseItem({ kind: 'text' }), () => {
      return new Promise<void>((r) => {
        resolve = r;
      });
    });
    const select = el.querySelector<HTMLSelectElement>('select')!;
    select.value = 'document';
    select.dispatchEvent(new Event('change'));
    await Promise.resolve();
    expect(select.disabled).toBe(true);
    expect(el.classList.contains('is-saving')).toBe(true);
    resolve!();
    await flush();
    expect(select.disabled).toBe(false);
    expect(el.classList.contains('is-saving')).toBe(false);
  });

  it('rolls back the select value when onTypeChange rejects', async () => {
    const el = renderer.buildKindReclassify(baseItem({ kind: 'text' }), async () => {
      throw new Error('boom');
    });
    const select = el.querySelector<HTMLSelectElement>('select')!;
    select.value = 'document';
    select.dispatchEvent(new Event('change'));
    await flush();
    expect(select.value).toBe('text');
    expect(select.disabled).toBe(false);
    expect(el.classList.contains('is-saving')).toBe(false);
  });
});

// ─── Phase B: buildDetailTags with edit callbacks ───────────────────────

describe('buildDetailTags (editable)', () => {
  const flush = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };

  it('renders a × button on each chip when onTagRemove is supplied', () => {
    const el = renderer.buildDetailTags(['alpha', 'bravo'], {
      onTagRemove: async () => undefined,
    });
    const removes = el.querySelectorAll('.spaces-detail-tag-remove');
    expect(removes).toHaveLength(2);
    expect(removes[0]?.getAttribute('aria-label')).toBe('Remove tag alpha');
  });

  it('does NOT render × buttons when onTagRemove is omitted', () => {
    const el = renderer.buildDetailTags(['alpha'], {});
    expect(el.querySelector('.spaces-detail-tag-remove')).toBeNull();
  });

  it('clicking × calls onTagRemove with the trimmed tag', async () => {
    const removed: string[] = [];
    const el = renderer.buildDetailTags(['  spaced  '], {
      onTagRemove: async (tag) => {
        removed.push(tag);
      },
    });
    el.querySelector<HTMLButtonElement>('.spaces-detail-tag-remove')?.click();
    await flush();
    expect(removed).toEqual(['spaced']);
  });

  it('marks chip as removing and disables × while pending', async () => {
    let resolve: (() => void) | null = null;
    const el = renderer.buildDetailTags(['alpha'], {
      onTagRemove: () => new Promise<void>((r) => {
        resolve = r;
      }),
    });
    const x = el.querySelector<HTMLButtonElement>('.spaces-detail-tag-remove')!;
    const chip = el.querySelector<HTMLElement>('.spaces-detail-tag')!;
    x.click();
    await Promise.resolve();
    expect(x.disabled).toBe(true);
    expect(chip.classList.contains('is-removing')).toBe(true);
    resolve!();
    await flush();
  });

  it('rolls back chip + button when onTagRemove rejects', async () => {
    const el = renderer.buildDetailTags(['alpha'], {
      onTagRemove: async () => {
        throw new Error('boom');
      },
    });
    const x = el.querySelector<HTMLButtonElement>('.spaces-detail-tag-remove')!;
    const chip = el.querySelector<HTMLElement>('.spaces-detail-tag')!;
    x.click();
    await flush();
    expect(x.disabled).toBe(false);
    expect(chip.classList.contains('is-removing')).toBe(false);
  });

  it('renders an "+ Add tag" button when onTagAdd is supplied', () => {
    const el = renderer.buildDetailTags([], { onTagAdd: async () => undefined });
    const addBtn = el.querySelector<HTMLButtonElement>('.spaces-detail-tag-add');
    expect(addBtn).not.toBeNull();
    expect(addBtn?.textContent).toBe('+ Add tag');
  });

  it('does NOT render "+ Add tag" when onTagAdd is omitted', () => {
    const el = renderer.buildDetailTags(['alpha'], { onTagRemove: async () => undefined });
    expect(el.querySelector('.spaces-detail-tag-add')).toBeNull();
  });

  it('clicking "+ Add tag" swaps to an input', () => {
    const el = renderer.buildDetailTags([], { onTagAdd: async () => undefined });
    el.querySelector<HTMLButtonElement>('.spaces-detail-tag-add')?.click();
    expect(el.querySelector('input.spaces-detail-tag-input')).not.toBeNull();
    expect(el.querySelector('.spaces-detail-tag-add')).toBeNull();
  });

  it('Enter on the tag input calls onTagAdd with the trimmed value', async () => {
    const added: string[] = [];
    const el = renderer.buildDetailTags([], {
      onTagAdd: async (tag) => {
        added.push(tag);
      },
    });
    el.querySelector<HTMLButtonElement>('.spaces-detail-tag-add')?.click();
    const input = el.querySelector<HTMLInputElement>('input.spaces-detail-tag-input')!;
    input.value = '  policy  ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    await flush();
    expect(added).toEqual(['policy']);
    // After commit, the affordance collapses back to its "+ Add tag" button.
    expect(el.querySelector('.spaces-detail-tag-add')).not.toBeNull();
    expect(el.querySelector('input.spaces-detail-tag-input')).toBeNull();
  });

  it('Esc on the tag input cancels without calling onTagAdd', async () => {
    const added: string[] = [];
    const el = renderer.buildDetailTags([], {
      onTagAdd: async (tag) => {
        added.push(tag);
      },
    });
    el.querySelector<HTMLButtonElement>('.spaces-detail-tag-add')?.click();
    const input = el.querySelector<HTMLInputElement>('input')!;
    input.value = 'will-be-discarded';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    await flush();
    expect(added).toEqual([]);
    expect(el.querySelector('.spaces-detail-tag-add')).not.toBeNull();
  });

  it('blur with non-empty value commits; blur with empty value just collapses', async () => {
    const added: string[] = [];
    const el = renderer.buildDetailTags([], {
      onTagAdd: async (tag) => {
        added.push(tag);
      },
    });
    el.querySelector<HTMLButtonElement>('.spaces-detail-tag-add')?.click();
    const input = el.querySelector<HTMLInputElement>('input')!;
    input.dispatchEvent(new Event('blur'));
    await flush();
    expect(added).toEqual([]);
    // Re-open and type a value.
    el.querySelector<HTMLButtonElement>('.spaces-detail-tag-add')?.click();
    const input2 = el.querySelector<HTMLInputElement>('input')!;
    input2.value = 'q3';
    input2.dispatchEvent(new Event('blur'));
    await flush();
    expect(added).toEqual(['q3']);
  });

  it('rolls back the input when onTagAdd rejects so the user can retry', async () => {
    const el = renderer.buildDetailTags([], {
      onTagAdd: async () => {
        throw new Error('boom');
      },
    });
    el.querySelector<HTMLButtonElement>('.spaces-detail-tag-add')?.click();
    const input = el.querySelector<HTMLInputElement>('input')!;
    input.value = 'rejected';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    await flush();
    // Still in input mode after failure.
    const stillInput = el.querySelector<HTMLInputElement>('input');
    expect(stillInput).not.toBeNull();
    expect(stillInput?.value).toBe('rejected');
    expect(stillInput?.disabled).toBe(false);
  });

  it('clamps tag input to 60 chars', () => {
    const el = renderer.buildDetailTags([], { onTagAdd: async () => undefined });
    el.querySelector<HTMLButtonElement>('.spaces-detail-tag-add')?.click();
    expect(el.querySelector<HTMLInputElement>('input')?.maxLength).toBe(60);
  });
});

// ─── Phase B: buildDetailPane integration with edit callbacks ───────────

describe('buildDetailPane (editable)', () => {
  const flush = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };

  it('omitting edit callbacks renders a read-only pane (no inputs, no × buttons)', () => {
    const el = renderer.buildDetailPane(
      baseItem({ title: 'Doc', tags: ['policy'], kind: 'document' }),
      () => undefined
    );
    // Title is a plain h2 (no input swap markup).
    const title = el.querySelector<HTMLElement>('.spaces-detail-title');
    expect(title?.classList.contains('is-editable')).toBe(false);
    expect(el.querySelector('.spaces-detail-title-wrap')).toBeNull();
    // No reclassify dropdown.
    expect(el.querySelector('.spaces-detail-reclassify-select')).toBeNull();
    // No tag × buttons or add affordance.
    expect(el.querySelector('.spaces-detail-tag-remove')).toBeNull();
    expect(el.querySelector('.spaces-detail-tag-add')).toBeNull();
  });

  it('supplying onTitleSave enables click-to-edit title', () => {
    const el = renderer.buildDetailPane(
      baseItem({ title: 'Doc' }),
      () => undefined,
      'rendered',
      { onTitleSave: async () => undefined }
    );
    const title = el.querySelector<HTMLElement>('.spaces-detail-title');
    expect(title?.classList.contains('is-editable')).toBe(true);
    expect(el.querySelector('.spaces-detail-title-wrap')).not.toBeNull();
  });

  it('supplying onTypeChange replaces the kind badge with a reclassify dropdown', () => {
    const el = renderer.buildDetailPane(
      baseItem({ kind: 'text' }),
      () => undefined,
      'rendered',
      { onTypeChange: async () => undefined }
    );
    expect(el.querySelector('.spaces-detail-reclassify-select')).not.toBeNull();
    // The dropdown still carries the kind class for visual consistency.
    expect(el.querySelector('.spaces-card-kind-text')).not.toBeNull();
  });

  it('supplying onTagRemove + onTagAdd enables tag editing affordances', () => {
    const el = renderer.buildDetailPane(
      baseItem({ tags: ['policy', 'q3'] }),
      () => undefined,
      'rendered',
      { onTagRemove: async () => undefined, onTagAdd: async () => undefined }
    );
    expect(el.querySelectorAll('.spaces-detail-tag-remove')).toHaveLength(2);
    expect(el.querySelector('.spaces-detail-tag-add')).not.toBeNull();
  });

  it('renders the "+ Add tag" affordance even when the item has zero tags', () => {
    const el = renderer.buildDetailPane(
      baseItem({ tags: [] }),
      () => undefined,
      'rendered',
      { onTagAdd: async () => undefined }
    );
    // Tag row must be present (only because onTagAdd is supplied).
    const row = el.querySelector('.spaces-detail-tags');
    expect(row).not.toBeNull();
    expect(row?.querySelector('.spaces-detail-tag-add')).not.toBeNull();
  });

  it('end-to-end: editing title via the pane invokes onTitleSave', async () => {
    const saves: string[] = [];
    const el = renderer.buildDetailPane(
      baseItem({ title: 'Old' }),
      () => undefined,
      'rendered',
      {
        onTitleSave: async (next) => {
          saves.push(next);
        },
      }
    );
    el.querySelector<HTMLElement>('.spaces-detail-title')?.click();
    const input = el.querySelector<HTMLInputElement>('input.spaces-detail-title-input')!;
    input.value = 'Brand new title';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    await flush();
    expect(saves).toEqual(['Brand new title']);
    expect(el.querySelector('.spaces-detail-title')?.textContent).toBe('Brand new title');
  });

  it('end-to-end: changing kind via the pane invokes onTypeChange', async () => {
    const calls: string[] = [];
    const el = renderer.buildDetailPane(
      baseItem({ kind: 'text' }),
      () => undefined,
      'rendered',
      {
        onTypeChange: async (next) => {
          calls.push(next);
        },
      }
    );
    const select = el.querySelector<HTMLSelectElement>('.spaces-detail-reclassify-select')!;
    select.value = 'document';
    select.dispatchEvent(new Event('change'));
    await flush();
    expect(calls).toEqual(['document']);
  });

  it('end-to-end: removing a tag chip invokes onTagRemove', async () => {
    const removed: string[] = [];
    const el = renderer.buildDetailPane(
      baseItem({ tags: ['policy', 'q3'] }),
      () => undefined,
      'rendered',
      {
        onTagRemove: async (tag) => {
          removed.push(tag);
        },
      }
    );
    el.querySelectorAll<HTMLButtonElement>('.spaces-detail-tag-remove')[0]?.click();
    await flush();
    expect(removed).toEqual(['policy']);
  });

  it('end-to-end: adding a tag via the pane invokes onTagAdd', async () => {
    const added: string[] = [];
    const el = renderer.buildDetailPane(
      baseItem({ tags: [] }),
      () => undefined,
      'rendered',
      {
        onTagAdd: async (tag) => {
          added.push(tag);
        },
      }
    );
    el.querySelector<HTMLButtonElement>('.spaces-detail-tag-add')?.click();
    const input = el.querySelector<HTMLInputElement>('input.spaces-detail-tag-input')!;
    input.value = 'finance';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    await flush();
    expect(added).toEqual(['finance']);
  });
});

// ─── Phase C: buildAttributionChip ──────────────────────────────────────

describe('buildAttributionChip', () => {
  it('returns null when item has neither producer nor editor', () => {
    expect(renderer.buildAttributionChip(baseItem({}))).toBeNull();
  });

  it('returns "Created by X" when only producedBy is set', () => {
    const el = renderer.buildAttributionChip(
      baseItem({
        producedBy: { kind: 'Person', name: 'Robb', id: 'p-1' },
        createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      })
    );
    expect(el).not.toBeNull();
    expect(el?.classList.contains('spaces-detail-attribution-chip')).toBe(true);
    expect(el?.querySelector('.spaces-detail-attribution-label')?.textContent).toBe(
      'Created by'
    );
    expect(el?.querySelector('.spaces-detail-attribution-name')?.textContent).toBe('Robb');
  });

  it('shows "Last edited by X" when editor differs from producer', () => {
    const el = renderer.buildAttributionChip(
      baseItem({
        producedBy: { kind: 'Person', name: 'Robb', id: 'p-1' },
        lastEditedBy: { kind: 'Person', name: 'Alice', id: 'p-2' },
        updatedAt: new Date(Date.now() - 1_800_000).toISOString(),
      })
    );
    expect(el?.querySelector('.spaces-detail-attribution-label')?.textContent).toBe(
      'Last edited by'
    );
    expect(el?.querySelector('.spaces-detail-attribution-name')?.textContent).toBe(
      'Alice'
    );
  });

  it('falls back to "Created by" when editor is the same person as producer', () => {
    const el = renderer.buildAttributionChip(
      baseItem({
        producedBy: { kind: 'Person', name: 'Robb', id: 'p-1' },
        lastEditedBy: { kind: 'Person', name: 'Robb', id: 'p-1' },
      })
    );
    expect(el?.querySelector('.spaces-detail-attribution-label')?.textContent).toBe(
      'Created by'
    );
  });

  it('renders a recency suffix when timestamp is parseable', () => {
    const el = renderer.buildAttributionChip(
      baseItem({
        producedBy: { kind: 'Person', name: 'Robb', id: 'p-1' },
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      })
    );
    const time = el?.querySelector('.spaces-detail-attribution-time');
    expect(time).not.toBeNull();
    expect(time?.textContent?.length ?? 0).toBeGreaterThan(0);
  });

  it('falls back to "(unknown)" when the editor name is blank', () => {
    const el = renderer.buildAttributionChip(
      baseItem({
        producedBy: { kind: 'Person', name: 'Robb', id: 'p-1' },
        lastEditedBy: { kind: 'Person', name: '', id: 'p-2' },
      })
    );
    expect(el?.querySelector('.spaces-detail-attribution-name')?.textContent).toBe(
      '(unknown)'
    );
  });
});

// ─── Phase C: buildDetailActivity ───────────────────────────────────────

describe('buildDetailActivity', () => {
  function ev(overrides: Partial<RendererActivityEvent> = {}): RendererActivityEvent {
    return {
      id: 'commit-1',
      author: 'Robb',
      kind: 'item:updated',
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      ...overrides,
    };
  }

  it('renders the section heading "Activity"', () => {
    const el = renderer.buildDetailActivity([]);
    expect(el.querySelector('.spaces-detail-activity-heading')?.textContent).toBe(
      'Activity'
    );
  });

  it('renders an empty-state line when events is empty', () => {
    const el = renderer.buildDetailActivity([]);
    const empty = el.querySelector('.spaces-detail-activity-empty');
    expect(empty).not.toBeNull();
    expect(empty?.textContent ?? '').toMatch(/no recent activity/i);
    expect(el.querySelector('.spaces-detail-activity-list')).toBeNull();
  });

  it('renders one <li> per event in order', () => {
    const el = renderer.buildDetailActivity([
      ev({ id: 'c-1', author: 'Alice', kind: 'item:added' }),
      ev({ id: 'c-2', author: 'Robb', kind: 'item:updated' }),
      ev({ id: 'c-3', author: 'system', kind: 'item:removed' }),
    ]);
    const rows = el.querySelectorAll('li.spaces-detail-activity-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]?.getAttribute('data-row-id')).toBe('c-1');
    expect(rows[2]?.getAttribute('data-row-id')).toBe('c-3');
  });

  it('renders author + a friendly verb per row', () => {
    const el = renderer.buildDetailActivity([
      ev({ author: 'Alice', kind: 'item:added' }),
    ]);
    const row = el.querySelector('.spaces-detail-activity-row')!;
    expect(row.querySelector('.spaces-detail-activity-author')?.textContent).toBe(
      'Alice'
    );
    expect(row.querySelector('.spaces-detail-activity-verb')?.textContent?.trim()).toBe(
      'added'
    );
  });

  it('uses raw commit kind when no friendly verb is known', () => {
    const el = renderer.buildDetailActivity([
      ev({ kind: 'auth.refresh' }),
    ]);
    expect(
      el.querySelector('.spaces-detail-activity-verb')?.textContent?.trim()
    ).toBe('auth.refresh');
  });

  it('falls back to "Someone" for blank authors', () => {
    const el = renderer.buildDetailActivity([ev({ author: '' })]);
    expect(
      el.querySelector('.spaces-detail-activity-author')?.textContent
    ).toBe('Someone');
  });

  it('renders a recency line per row from the timestamp', () => {
    const el = renderer.buildDetailActivity([
      ev({ timestamp: new Date(Date.now() - 60_000).toISOString() }),
    ]);
    const meta = el.querySelector('.spaces-detail-activity-meta');
    expect(meta).not.toBeNull();
    expect(meta?.textContent?.length ?? 0).toBeGreaterThan(0);
  });
});

// ─── Phase C: buildDetailPane integration with attribution + activity slot

describe('buildDetailPane (Phase C)', () => {
  it('renders the attribution chip when producer is present', () => {
    const el = renderer.buildDetailPane(
      baseItem({ producedBy: { kind: 'Person', name: 'Robb', id: 'p-1' } }),
      () => undefined
    );
    expect(el.querySelector('.spaces-detail-attribution-chip')).not.toBeNull();
  });

  it('omits the attribution chip when neither producer nor editor exist', () => {
    const el = renderer.buildDetailPane(baseItem({}), () => undefined);
    expect(el.querySelector('.spaces-detail-attribution-chip')).toBeNull();
  });

  it('renders an empty activity slot tagged with the item id', () => {
    const el = renderer.buildDetailPane(baseItem({ id: 'asset-x' }), () => undefined);
    const slot = el.querySelector<HTMLElement>('.spaces-detail-activity-slot');
    expect(slot).not.toBeNull();
    expect(slot?.getAttribute('data-activity-slot')).toBe('asset-x');
    expect(slot?.children.length).toBe(0);
  });

  it('the activity slot can be populated with buildDetailActivity output', () => {
    const el = renderer.buildDetailPane(baseItem({ id: 'asset-x' }), () => undefined);
    const slot = el.querySelector<HTMLElement>('.spaces-detail-activity-slot')!;
    slot.replaceChildren(
      renderer.buildDetailActivity([
        {
          id: 'c-1',
          author: 'Robb',
          kind: 'item:updated',
          timestamp: new Date().toISOString(),
        },
      ])
    );
    expect(slot.querySelectorAll('li.spaces-detail-activity-row')).toHaveLength(1);
  });
});
