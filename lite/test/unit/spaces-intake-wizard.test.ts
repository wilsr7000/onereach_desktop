/**
 * The batch-intake WIZARD, driven behaviorally ("did you fully test?" —
 * 2026-08-20). A fake bridge counts creates; real Files flow through the
 * real pipeline including the SHA-256 duplicate gate, so this exercises
 * what the pure-helper tests cannot: the click path, the queue
 * advancement, duplicate auto-skip, Add-all, and failure isolation.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import '../../spaces/spaces.js';

// jsdom has no crypto.subtle; the pipeline hashes every upload.
beforeEach(() => {
  if (globalThis.crypto?.subtle === undefined) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
  // jsdom Files lack .text()/.arrayBuffer(); the pipeline uses both.
  const proto = File.prototype as unknown as Record<string, unknown>;
  if (typeof proto['text'] !== 'function') {
    proto['text'] = function (this: Blob): Promise<string> {
      return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error);
        r.readAsText(this);
      });
    };
  }
  if (typeof proto['arrayBuffer'] !== 'function') {
    proto['arrayBuffer'] = function (this: Blob): Promise<ArrayBuffer> {
      return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as ArrayBuffer);
        r.onerror = () => reject(r.error);
        r.readAsArrayBuffer(this);
      });
    };
  }
  document.body.innerHTML = '';
});

interface Handle {
  openBatchIntakeWizard(queue: unknown[], spaceId: string): void;
  createAssetFromUploadFile(file: File, opts: Record<string, unknown>): Promise<unknown>;
}

function handle(): Handle {
  const w = window as unknown as { __spacesRendererForTesting?: Handle };
  if (w.__spacesRendererForTesting === undefined) throw new Error('handle missing');
  return w.__spacesRendererForTesting;
}

function installBridge(): { created: Array<Record<string, unknown>>; updated: Array<Record<string, unknown>> } {
  const created: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];
  (window as unknown as { lite?: unknown }).lite = {
    spaces: {
      items: {
        create: vi.fn(async (input: Record<string, unknown>) => {
          created.push(input);
          return { ok: true, value: { id: `created-${created.length}` } };
        }),
        update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
          updated.push({ id, ...patch });
          return { ok: true, value: {} };
        }),
        list: vi.fn(async () => ({ ok: true, value: [] })),
      },
    },
  };
  return { created, updated };
}

afterEach(() => {
  delete (window as unknown as { lite?: unknown }).lite;
  document.querySelector('.spaces-intake-backdrop')?.remove();
});

const qItem = (name: string, content: string): unknown => ({
  file: new File([content], name, { type: 'text/markdown' }),
  relativePath: name,
  suggestedTitle: name.replace(/\.md$/, ''),
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 24; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('the wizard, clicked through', () => {
  it('Add advances the queue and creates through the one pipeline', async () => {
    const bridge = installBridge();
    handle().openBatchIntakeWizard([qItem('a.md', 'alpha'), qItem('b.md', 'beta')], 'sp-1');

    const panel = document.querySelector('.spaces-intake-panel');
    expect(panel, 'wizard panel mounts').not.toBeNull();
    expect(panel!.textContent).toContain('1 of 2');

    (panel!.querySelector('.spaces-items-new') as HTMLButtonElement).click();
    await flush();
    expect(document.querySelector('.spaces-intake-panel')!.textContent).toContain('2 of 2');
    expect(bridge.created).toHaveLength(1);
    expect(bridge.created[0]!['title']).toBe('a');
    // The dedupe identity is stamped on the way in.
    const meta = bridge.created[0]!['metadata'] as Record<string, unknown>;
    expect(typeof meta['contentSha256']).toBe('string');
  });

  it('an exact duplicate WITHIN the batch is refused and counted', async () => {
    const bridge = installBridge();
    handle().openBatchIntakeWizard(
      [qItem('one.md', 'same bytes'), qItem('copy-of-one.md', 'same bytes')],
      'sp-1'
    );
    const addAll = document.querySelector('.spaces-intake-all') as HTMLButtonElement;
    addAll.click();
    await flush();
    // One created; the byte-identical twin refused despite its new name.
    expect(bridge.created).toHaveLength(1);
    expect(document.querySelector('.spaces-intake-panel')).toBeNull(); // finished
  });

  it('a description is saved as a follow-up update', async () => {
    const bridge = installBridge();
    handle().openBatchIntakeWizard([qItem('doc.md', 'body')], 'sp-1');
    const panel = document.querySelector('.spaces-intake-panel')!;
    (panel.querySelector('.spaces-intake-desc') as HTMLTextAreaElement).value = 'why it matters';
    (panel.querySelector('.spaces-items-new') as HTMLButtonElement).click();
    await flush();
    expect(bridge.updated).toEqual([{ id: 'created-1', description: 'why it matters' }]);
  });

  it('one failing create never sinks the rest', async () => {
    const bridge = installBridge();
    const items = (window as unknown as { lite: { spaces: { items: { create: ReturnType<typeof vi.fn> } } } })
      .lite.spaces.items;
    let n = 0;
    items.create.mockImplementation(async (input: Record<string, unknown>) => {
      n += 1;
      if (n === 1) return { ok: false, error: { message: 'graph hiccup' } };
      bridge.created.push(input);
      return { ok: true, value: { id: `created-${bridge.created.length}` } };
    });
    handle().openBatchIntakeWizard([qItem('bad.md', 'x'), qItem('good.md', 'y')], 'sp-1');
    (document.querySelector('.spaces-intake-all') as HTMLButtonElement).click();
    await flush();
    expect(bridge.created).toHaveLength(1);
    expect(bridge.created[0]!['title']).toBe('good');
  });

  it('Skip skips without creating', async () => {
    const bridge = installBridge();
    handle().openBatchIntakeWizard([qItem('a.md', '1'), qItem('b.md', '2')], 'sp-1');
    (document.querySelector('.spaces-intake-skip') as HTMLButtonElement).click();
    await flush();
    expect(document.querySelector('.spaces-intake-panel')!.textContent).toContain('2 of 2');
    expect(bridge.created).toHaveLength(0);
  });
});
