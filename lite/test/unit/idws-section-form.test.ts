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

// ─── Top-level third-party tile row (one-click install) ─────────────────

/**
 * The 5 well-known third-party agents (ChatGPT / Claude / Gemini /
 * Perplexity / Grok) get a quick-add tile row at the top of the IDWs
 * section. Covers:
 *   - the 5 tiles render with the right preset id + URL
 *   - clicking a tile fires `idw().add` with the canonical payload
 *   - already-installed tiles show "Installed" state and are disabled
 *   - the row re-renders via onChange after a successful install
 */
describe('Settings -> IDWs third-party tile row', () => {
  it('renders one tile per non-custom preset', async () => {
    installBridge([]);
    await mountInto(container);
    const tiles = container.querySelectorAll<HTMLButtonElement>('[data-third-party-add]');
    expect(tiles).toHaveLength(5);
    const ids = Array.from(tiles).map((t) => t.dataset['thirdPartyAdd']);
    expect(ids).toEqual(['chatgpt', 'claude', 'gemini', 'perplexity', 'grok']);
  });

  it('each tile carries the preset URL in title for hover discoverability', async () => {
    installBridge([]);
    await mountInto(container);
    const chatgpt = container.querySelector<HTMLButtonElement>(
      '[data-third-party-add="chatgpt"]'
    );
    expect(chatgpt?.getAttribute('title')).toBe('https://chat.openai.com');
    const claude = container.querySelector<HTMLButtonElement>(
      '[data-third-party-add="claude"]'
    );
    expect(claude?.getAttribute('title')).toBe('https://claude.ai/new');
  });

  it('clicking a tile fires idw().add with kind=external-bot + the preset URL/label/botType', async () => {
    const { spies } = installBridge([]);
    await mountInto(container);
    const claude = container.querySelector<HTMLButtonElement>(
      '[data-third-party-add="claude"]'
    );
    claude?.click();
    await flushMicrotasks();
    expect(spies.add).toHaveBeenCalledTimes(1);
    const payload = spies.add.mock.calls[0]?.[0] as LiteIdwAddInput;
    expect(payload).toMatchObject({
      kind: 'external-bot',
      label: 'Claude',
      url: 'https://claude.ai/new',
      botType: 'claude',
    });
  });

  it('shows "Installed" state for presets the user already has', async () => {
    installBridge([
      {
        id: 'existing-chatgpt',
        kind: 'external-bot',
        label: 'ChatGPT',
        url: 'https://chat.openai.com',
        botType: 'chatgpt',
        source: 'manual',
        order: 100,
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
      } as LiteIdwEntry,
    ]);
    await mountInto(container);
    const chatgpt = container.querySelector<HTMLButtonElement>(
      '[data-third-party-add="chatgpt"]'
    );
    expect(chatgpt?.classList.contains('is-installed')).toBe(true);
    expect(chatgpt?.disabled).toBe(true);
    expect(chatgpt?.querySelector('.idw-tp-tile-status')?.textContent).toBe('Installed');

    // Other presets remain addable.
    const gemini = container.querySelector<HTMLButtonElement>(
      '[data-third-party-add="gemini"]'
    );
    expect(gemini?.disabled).toBe(false);
    expect(gemini?.querySelector('.idw-tp-tile-add')?.textContent).toBe('+ Add');
  });

  it('disables the clicked tile while the add is in flight', async () => {
    const { spies } = installBridge([]);
    // Stall the add() promise so we can observe the disabled mid-flight.
    // `resolveAdd` is captured in the Promise executor closure; the
    // cast pins the type once we read it at the bottom of the test.
    type AddResolver = (v: { entry: LiteIdwEntry; wasUpdate: boolean }) => void;
    const resolveBox: { fn: AddResolver | null } = { fn: null };
    spies.add.mockImplementationOnce(
      () =>
        new Promise<{ entry: LiteIdwEntry; wasUpdate: boolean }>((r) => {
          resolveBox.fn = r;
        })
    );
    await mountInto(container);
    const grok = container.querySelector<HTMLButtonElement>(
      '[data-third-party-add="grok"]'
    );
    grok?.click();
    // After click, before promise resolves.
    expect(grok?.disabled).toBe(true);
    expect(grok?.classList.contains('is-loading')).toBe(true);
    // Drain.
    resolveBox.fn?.({ entry: {} as unknown as LiteIdwEntry, wasUpdate: false });
    await flushMicrotasks();
  });

  it('surfaces an error banner when add fails (rolls back tile disabled state)', async () => {
    const { spies } = installBridge([]);
    spies.add.mockRejectedValueOnce(new Error('network down'));
    await mountInto(container);
    const perplexity = container.querySelector<HTMLButtonElement>(
      '[data-third-party-add="perplexity"]'
    );
    perplexity?.click();
    await flushMicrotasks();
    await flushMicrotasks();
    expect(perplexity?.disabled).toBe(false);
    expect(perplexity?.classList.contains('is-loading')).toBe(false);
    const banner = container.querySelector('#idw-banner');
    expect(banner?.textContent ?? '').toMatch(/network down/);
  });

  it('re-renders the tile row to "Installed" after onChange fires post-add', async () => {
    const { spies, changeHandlers } = installBridge([]);
    await mountInto(container);

    // Initial state: ChatGPT tile is addable.
    let chatgpt = container.querySelector<HTMLButtonElement>(
      '[data-third-party-add="chatgpt"]'
    );
    expect(chatgpt?.classList.contains('is-installed')).toBe(false);

    // Click → spied add fires; then simulate the onChange listener
    // receiving the updated entry list (this is what idw().add does
    // in production via the store's broadcast).
    chatgpt?.click();
    await flushMicrotasks();
    expect(spies.add).toHaveBeenCalledTimes(1);

    changeHandlers.forEach((h) =>
      h([
        {
          id: 'new-chatgpt',
          kind: 'external-bot',
          label: 'ChatGPT',
          url: 'https://chat.openai.com',
          botType: 'chatgpt',
          source: 'manual',
          order: 100,
          createdAt: '2026-05-18T00:00:00Z',
          updatedAt: '2026-05-18T00:00:00Z',
        } as LiteIdwEntry,
      ])
    );
    // Re-render is synchronous within the onChange callback.
    chatgpt = container.querySelector<HTMLButtonElement>(
      '[data-third-party-add="chatgpt"]'
    );
    expect(chatgpt?.classList.contains('is-installed')).toBe(true);
    expect(chatgpt?.disabled).toBe(true);
  });
});
