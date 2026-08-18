/**
 * "+ New checklist" must actually open the editor (2026-08-17 live
 * report: "I opened a space and clicked on new checklist and nothing
 * happened").
 *
 * Every existing checklist test is either pure-logic or a SOURCE regex —
 * nothing drove the click, so a dead button was invisible to the suite.
 * These pin the user-visible contract end to end in the DOM: the button
 * renders, clicking it mounts the editor panel, and when the kernel
 * lacks the checklists bridge the button says so instead of silently
 * doing nothing.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const SPACE = { id: 'sp-1', name: 'Infobip', kind: 'shared' } as never;

function installBridge(checklists: unknown): void {
  (window as unknown as { lite: unknown }).lite = {
    spaces: {
      ...(checklists === undefined ? {} : { checklists }),
    },
  };
}

const workingChecklists = {
  list: vi.fn().mockResolvedValue({ ok: true, value: [] }),
  create: vi.fn().mockResolvedValue({ ok: true, value: { id: 'cl-1' } }),
  draft: vi.fn().mockResolvedValue({ ok: true, value: { items: [] } }),
};

beforeEach(() => {
  // Production scaffold: showToast is a no-op without these hosts
  // (spaces.html provides them).
  document.body.innerHTML =
    '<div id="spaces-toast"><span id="spaces-toast-message"></span>' +
    '<button id="spaces-toast-action"></button></div>';
});

afterEach(() => {
  document.querySelector('.spaces-checklist-editor-backdrop')?.remove();
});

describe('+ New checklist opens the editor', () => {
  it('mounts the editor panel on click', async () => {
    installBridge(workingChecklists);
    const mod = await import('../../spaces/spaces.js');
    const section = mod.buildSharedDashboardChecklists(SPACE);
    document.body.appendChild(section);

    const btn = section.querySelector<HTMLButtonElement>('.spaces-checklist-new');
    expect(btn, 'the + New checklist button must render').not.toBeNull();
    expect(document.querySelector('.spaces-checklist-editor-backdrop')).toBeNull();

    btn?.click();

    const backdrop = document.querySelector('.spaces-checklist-editor-backdrop');
    expect(backdrop, 'clicking + New checklist must mount the editor').not.toBeNull();
    expect(backdrop?.querySelector('.spaces-checklist-editor')).not.toBeNull();
  });

  it('opens the editor directly too (the panel builder is sound)', async () => {
    installBridge(workingChecklists);
    const mod = await import('../../spaces/spaces.js');
    mod.openChecklistEditorPanel({ spaceId: 'sp-1', onSaved: () => undefined });
    expect(document.querySelector('.spaces-checklist-editor-backdrop')).not.toBeNull();
  });

  it('without the bridge the button EXPLAINS itself instead of dying silently', async () => {
    installBridge(undefined);
    const mod = await import('../../spaces/spaces.js');
    const section = mod.buildSharedDashboardChecklists(SPACE);
    document.body.appendChild(section);
    const btn = section.querySelector<HTMLButtonElement>('.spaces-checklist-new');
    btn?.click();
    // No panel — but the user must be TOLD, never left guessing.
    expect(document.querySelector('.spaces-checklist-editor-backdrop')).toBeNull();
    expect(document.body.textContent).toMatch(/newer build|unavailable|not available/i);
  });
});
/**
 * "+ New checklist" must never fail silently (2026-08-18: "I clicked
 * new checklist and nothing happened"). Either the editor mounts, or
 * the user is told why.
 */

// @vitest-environment jsdom
