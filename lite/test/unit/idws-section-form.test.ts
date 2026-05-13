/**
 * Settings -> IDWs section: Add/Edit form behaviour around bot
 * presets.
 *
 * The data layer (`bot-presets.test.ts`, `idw-store.test.ts`,
 * `idw-integration.test.ts`) covers the preset table, the store's
 * per-kind drop semantics, and the end-to-end KV round-trip. This
 * file covers what happens in the RENDERER: field visibility,
 * preset auto-fill, the "preset-set" sticky-mark, edit
 * pre-population, and the Quick Add buttons.
 *
 * The lite vitest project defaults to `environment: 'node'`; this
 * file opts in to jsdom per file via the doc-comment below. Mirrors
 * the pattern in `ai-run-times-article-extractor.test.ts`.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountIdws } from '../../settings/sections/idws.js';

// ─── test bridge ──────────────────────────────────────────────────────────

/**
 * Build a mock `window.lite.idw` bridge that the section reads on
 * mount. Exposes vi-spy mocks for each method plus the `onChange`
 * handlers so a test can simulate a live mutation.
 */
function installBridge(
  initialEntries: LiteIdwEntry[] = []
): {
  bridge: LiteIdwBridge;
  spies: {
    list: ReturnType<typeof vi.fn>;
    add: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    openStore: ReturnType<typeof vi.fn>;
  };
  changeHandlers: Array<(entries: LiteIdwEntry[]) => void>;
} {
  const handlers: Array<(entries: LiteIdwEntry[]) => void> = [];
  const list = vi.fn(async () => [...initialEntries]);
  const add = vi.fn(async () => ({
    entry: {} as unknown as LiteIdwEntry,
    wasUpdate: false,
  }));
  const update = vi.fn(async () => ({} as unknown as LiteIdwEntry));
  const remove = vi.fn(async () => ({ ok: true as const }));
  const openStore = vi.fn(async () => ({ ok: true as const }));
  const bridge: LiteIdwBridge = {
    list,
    listByKind: vi.fn(async () => []),
    get: vi.fn(async () => null),
    add,
    update,
    remove,
    openStore,
    onChange: (h) => {
      handlers.push(h);
      return () => {
        const idx = handlers.indexOf(h);
        if (idx >= 0) handlers.splice(idx, 1);
      };
    },
    parseError: () => null,
  };
  // The section reads `window.lite?.idw`. Install it on the global
  // `window` jsdom provides.
  (window as unknown as { lite?: { idw: LiteIdwBridge } }).lite = { idw: bridge };
  return { bridge, spies: { list, add, update, remove, openStore }, changeHandlers: handlers };
}

/** Wait for `mountIdws`'s fire-and-forget `initialLoad` to flush. */
async function flushMicrotasks(): Promise<void> {
  // Two ticks: one for the `list()` promise to resolve, one for the
  // render that runs synchronously after `state.entries = await ...`.
  await Promise.resolve();
  await Promise.resolve();
}

/** Common test scaffolding. `mountIdws` returns an optional disposer. */
async function mountInto(container: HTMLElement): Promise<(() => void) | undefined> {
  const dispose = mountIdws(container);
  await flushMicrotasks();
  return dispose;
}

// ─── helpers ──────────────────────────────────────────────────────────────

function $<T extends HTMLElement = HTMLElement>(root: HTMLElement, sel: string): T | null {
  return root.querySelector<T>(sel);
}

function getKindSelect(root: HTMLElement): HTMLSelectElement {
  const el = $<HTMLSelectElement>(root, 'select[name="kind"]');
  if (el === null) throw new Error('kind select missing');
  return el;
}

function getBotTypeSelect(root: HTMLElement): HTMLSelectElement {
  const el = $<HTMLSelectElement>(root, 'select[name="botType"]');
  if (el === null) throw new Error('botType select missing');
  return el;
}

function getInput(root: HTMLElement, name: string): HTMLInputElement {
  const el = $<HTMLInputElement>(root, `input[name="${name}"]`);
  if (el === null) throw new Error(`input[name="${name}"] missing`);
  return el;
}

function isHidden(el: HTMLElement | null): boolean {
  return el !== null && el.hasAttribute('hidden');
}

function fireChange(el: HTMLSelectElement): void {
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function fireInput(el: HTMLInputElement): void {
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function openAddForm(container: HTMLElement): Promise<HTMLElement> {
  const btn = $<HTMLButtonElement>(container, '#idw-add-custom');
  if (btn === null) throw new Error('Add Custom Agent button missing');
  btn.click();
  // Form rendering is synchronous after the click handler runs.
  const wrap = $<HTMLElement>(container, '#idw-add-form-wrap');
  if (wrap === null) throw new Error('add-form-wrap missing');
  return wrap;
}

// ─── setup ────────────────────────────────────────────────────────────────

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  document.body.innerHTML = '';
  delete (window as unknown as { lite?: unknown }).lite;
});

// ─── tests ────────────────────────────────────────────────────────────────

describe('Settings -> IDWs Add form: bot type field visibility', () => {
  it('hides the Bot type row when kind=idw (default)', async () => {
    installBridge([]);
    await mountInto(container);
    const wrap = await openAddForm(container);
    const botTypeField = wrap.querySelector<HTMLElement>('[data-show-when="botType"]');
    expect(isHidden(botTypeField)).toBe(true);
  });

  it('shows the Bot type row when kind=external-bot', async () => {
    installBridge([]);
    await mountInto(container);
    const wrap = await openAddForm(container);
    const kindSel = getKindSelect(wrap);
    kindSel.value = 'external-bot';
    fireChange(kindSel);
    const botTypeField = wrap.querySelector<HTMLElement>('[data-show-when="botType"]');
    expect(isHidden(botTypeField)).toBe(false);
  });

  it('re-hides the Bot type row when kind switches back to idw', async () => {
    installBridge([]);
    await mountInto(container);
    const wrap = await openAddForm(container);
    const kindSel = getKindSelect(wrap);
    kindSel.value = 'external-bot';
    fireChange(kindSel);
    kindSel.value = 'idw';
    fireChange(kindSel);
    const botTypeField = wrap.querySelector<HTMLElement>('[data-show-when="botType"]');
    expect(isHidden(botTypeField)).toBe(true);
  });
});

describe('Settings -> IDWs Add form: bot preset auto-fill', () => {
  it('auto-fills Label and URL when switching kind to external-bot', async () => {
    installBridge([]);
    await mountInto(container);
    const wrap = await openAddForm(container);
    const kindSel = getKindSelect(wrap);
    kindSel.value = 'external-bot';
    fireChange(kindSel);
    // Default bot type is the first preset (ChatGPT).
    expect(getInput(wrap, 'label').value).toBe('ChatGPT');
    expect(getInput(wrap, 'url').value).toBe('https://chat.openai.com');
  });

  it('auto-fills Label and URL when picking a different preset', async () => {
    installBridge([]);
    await mountInto(container);
    const wrap = await openAddForm(container);
    const kindSel = getKindSelect(wrap);
    kindSel.value = 'external-bot';
    fireChange(kindSel);
    const botSel = getBotTypeSelect(wrap);
    botSel.value = 'claude';
    fireChange(botSel);
    expect(getInput(wrap, 'label').value).toBe('Claude');
    expect(getInput(wrap, 'url').value).toBe('https://claude.ai/new');
  });

  it('overwrites a previous preset value on subsequent preset pick', async () => {
    installBridge([]);
    await mountInto(container);
    const wrap = await openAddForm(container);
    const kindSel = getKindSelect(wrap);
    kindSel.value = 'external-bot';
    fireChange(kindSel);
    // First pick: ChatGPT (default).
    expect(getInput(wrap, 'label').value).toBe('ChatGPT');
    // Second pick: Gemini -- because the previous value was preset-set,
    // it gets overwritten.
    const botSel = getBotTypeSelect(wrap);
    botSel.value = 'gemini';
    fireChange(botSel);
    expect(getInput(wrap, 'label').value).toBe('Gemini');
    expect(getInput(wrap, 'url').value).toBe('https://gemini.google.com');
  });

  it('does NOT overwrite a user-typed Label on preset switch', async () => {
    installBridge([]);
    await mountInto(container);
    const wrap = await openAddForm(container);
    const kindSel = getKindSelect(wrap);
    kindSel.value = 'external-bot';
    fireChange(kindSel);
    // User edits the Label (clears the preset-set marker).
    const labelEl = getInput(wrap, 'label');
    labelEl.value = 'MyBot';
    fireInput(labelEl);
    // Switching presets must NOT clobber the user-typed value.
    const botSel = getBotTypeSelect(wrap);
    botSel.value = 'claude';
    fireChange(botSel);
    expect(labelEl.value).toBe('MyBot');
    // URL was preset-set and still untouched by user, so it DOES update.
    expect(getInput(wrap, 'url').value).toBe('https://claude.ai/new');
  });

  it('does NOT overwrite a user-typed URL on preset switch', async () => {
    installBridge([]);
    await mountInto(container);
    const wrap = await openAddForm(container);
    const kindSel = getKindSelect(wrap);
    kindSel.value = 'external-bot';
    fireChange(kindSel);
    const urlEl = getInput(wrap, 'url');
    urlEl.value = 'https://my-private.example.com';
    fireInput(urlEl);
    const botSel = getBotTypeSelect(wrap);
    botSel.value = 'perplexity';
    fireChange(botSel);
    expect(urlEl.value).toBe('https://my-private.example.com');
  });

  it('does not touch Label or URL when the user picks Custom', async () => {
    installBridge([]);
    await mountInto(container);
    const wrap = await openAddForm(container);
    const kindSel = getKindSelect(wrap);
    kindSel.value = 'external-bot';
    fireChange(kindSel);
    // ChatGPT defaults applied.
    expect(getInput(wrap, 'label').value).toBe('ChatGPT');
    // Switching to Custom must leave existing fields intact (early-return).
    const botSel = getBotTypeSelect(wrap);
    botSel.value = 'custom';
    fireChange(botSel);
    expect(getInput(wrap, 'label').value).toBe('ChatGPT');
    expect(getInput(wrap, 'url').value).toBe('https://chat.openai.com');
  });
});

describe('Settings -> IDWs Add form: Quick Add buttons', () => {
  it('emits five named quick-add buttons (one per non-custom preset)', async () => {
    installBridge([]);
    await mountInto(container);
    const wrap = await openAddForm(container);
    const btns = Array.from(
      wrap.querySelectorAll<HTMLButtonElement>('button.idw-quick-add-btn[data-quick-add]')
    );
    const ids = btns.map((b) => b.dataset['quickAdd']);
    expect(ids.sort()).toEqual(['chatgpt', 'claude', 'gemini', 'grok', 'perplexity']);
  });

  it('Quick Add jumps the form to external-bot and pre-fills the picked preset', async () => {
    installBridge([]);
    await mountInto(container);
    const wrap = await openAddForm(container);
    const claudeBtn = wrap.querySelector<HTMLButtonElement>(
      'button.idw-quick-add-btn[data-quick-add="claude"]'
    );
    expect(claudeBtn).not.toBeNull();
    claudeBtn?.click();
    expect(getKindSelect(wrap).value).toBe('external-bot');
    expect(getBotTypeSelect(wrap).value).toBe('claude');
    expect(getInput(wrap, 'label').value).toBe('Claude');
    expect(getInput(wrap, 'url').value).toBe('https://claude.ai/new');
  });
});

describe('Settings -> IDWs Edit form: bot type pre-population', () => {
  it('pre-selects the entry.botType when editing an external-bot', async () => {
    const entry: LiteIdwEntry = {
      id: 'eb-1',
      kind: 'external-bot',
      label: 'My Claude',
      url: 'https://claude.ai/new',
      source: 'manual',
      botType: 'claude',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    installBridge([entry]);
    await mountInto(container);
    // Click Edit on the row.
    const editBtn = container.querySelector<HTMLButtonElement>(
      'button[data-action="edit"][data-id="eb-1"]'
    );
    expect(editBtn).not.toBeNull();
    editBtn?.click();
    const editWrap = container.querySelector<HTMLElement>(
      '.idw-row[data-id="eb-1"] .idw-row-edit'
    );
    expect(editWrap).not.toBeNull();
    expect(isHidden(editWrap)).toBe(false);
    expect(getBotTypeSelect(editWrap as HTMLElement).value).toBe('claude');
    // Label / URL also pre-populated from the entry.
    expect(getInput(editWrap as HTMLElement, 'label').value).toBe('My Claude');
    expect(getInput(editWrap as HTMLElement, 'url').value).toBe('https://claude.ai/new');
  });

  it('defaults Bot type to "custom" when entry.botType is absent', async () => {
    const entry: LiteIdwEntry = {
      id: 'eb-2',
      kind: 'external-bot',
      label: 'Legacy',
      url: 'https://example.com',
      source: 'manual',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    installBridge([entry]);
    await mountInto(container);
    const editBtn = container.querySelector<HTMLButtonElement>(
      'button[data-action="edit"][data-id="eb-2"]'
    );
    editBtn?.click();
    const editWrap = container.querySelector<HTMLElement>(
      '.idw-row[data-id="eb-2"] .idw-row-edit'
    );
    expect(getBotTypeSelect(editWrap as HTMLElement).value).toBe('custom');
  });

  it('hides Quick Add row in edit mode (kind cannot change)', async () => {
    const entry: LiteIdwEntry = {
      id: 'eb-3',
      kind: 'external-bot',
      label: 'A',
      url: 'https://a.example.com',
      source: 'manual',
      botType: 'chatgpt',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    installBridge([entry]);
    await mountInto(container);
    const editBtn = container.querySelector<HTMLButtonElement>(
      'button[data-action="edit"][data-id="eb-3"]'
    );
    editBtn?.click();
    const editWrap = container.querySelector<HTMLElement>(
      '.idw-row[data-id="eb-3"] .idw-row-edit'
    );
    const quickAdd = editWrap?.querySelector<HTMLElement>('[data-show-when="quick-add"]');
    expect(isHidden(quickAdd as HTMLElement)).toBe(true);
  });
});

describe('Settings -> IDWs Add form: submit payload includes botType', () => {
  it('submits botType when kind=external-bot and a preset is picked', async () => {
    const { spies } = installBridge([]);
    await mountInto(container);
    const wrap = await openAddForm(container);
    const kindSel = getKindSelect(wrap);
    kindSel.value = 'external-bot';
    fireChange(kindSel);
    const botSel = getBotTypeSelect(wrap);
    botSel.value = 'gemini';
    fireChange(botSel);
    // Submit.
    const form = wrap.querySelector<HTMLFormElement>('#idw-add-form');
    if (form === null) throw new Error('form missing');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    // The submit handler is async; flush.
    await flushMicrotasks();
    await flushMicrotasks();
    expect(spies.add).toHaveBeenCalledTimes(1);
    const payload = spies.add.mock.calls[0]?.[0] as LiteIdwAddInput;
    expect(payload).toBeDefined();
    expect(payload.kind).toBe('external-bot');
    expect(payload.botType).toBe('gemini');
    expect(payload.label).toBe('Gemini');
    expect(payload.url).toBe('https://gemini.google.com');
  });

  it('omits botType from the add payload when kind=idw', async () => {
    const { spies } = installBridge([]);
    await mountInto(container);
    const wrap = await openAddForm(container);
    // kind defaults to idw; just type the required fields.
    getInput(wrap, 'label').value = 'My IDW';
    getInput(wrap, 'url').value = 'https://example.com';
    const form = wrap.querySelector<HTMLFormElement>('#idw-add-form');
    form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();
    await flushMicrotasks();
    expect(spies.add).toHaveBeenCalledTimes(1);
    const payload = spies.add.mock.calls[0]?.[0] as LiteIdwAddInput;
    expect(payload.botType).toBeUndefined();
  });
});
