/**
 * Chrome tab-pill ⚠ login-stuck badge — the user-facing half of the
 * auto-login verifier. Previously this path was verified by eyeball
 * only; these tests pin the render, the tooltip instruction, the
 * clear-on-activate behavior, and the prune-on-close sweep.
 *
 * chrome.ts is a side-effecting renderer entry; it exposes
 * `window.__chromeForTesting` at module load and its bootstrap bails
 * without the preload bridge, so importing it under jsdom is safe.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import '../../main-window/chrome.js';

type ChromeHooks = NonNullable<Window['__chromeForTesting']>;

function hooks(): ChromeHooks {
  const h = window.__chromeForTesting;
  if (h === undefined) throw new Error('chrome test hook missing');
  return h;
}

function tab(id: string, label: string): LiteMainWindowTab {
  return { id, label, url: 'https://idw.edison.onereach.ai/x' } as unknown as LiteMainWindowTab;
}

const INSTRUCTION = '“Marvin” is on the OneReach “continue with your session” screen. Click Continue / Skip in the tab to finish signing in.';

describe('tab-pill login-stuck badge', () => {
  const activateTab = vi.fn(async () => ({ ok: true }));
  const closeTab = vi.fn(async () => ({ ok: true }));

  beforeEach(() => {
    document.body.innerHTML =
      '<div id="tab-list"></div><button id="home-pill"></button><div id="home-view"></div>';
    hooks().stuckTabs.clear();
    hooks().setTabsForTesting([], null);
    activateTab.mockClear();
    (window as unknown as { lite: unknown }).lite = {
      mainWindow: { activateTab, closeTab },
    };
  });

  it('a normal pill has no badge and uses the label as tooltip', () => {
    const pill = hooks().buildPill(tab('t1', 'Marvin'));
    expect(pill.classList.contains('login-stuck')).toBe(false);
    expect(pill.querySelector('.tab-pill-warn')).toBeNull();
    expect(pill.title).toBe('Marvin');
  });

  it('a stuck pill renders ⚠ + the instruction as its tooltip', () => {
    hooks().stuckTabs.set('t1', INSTRUCTION);
    const pill = hooks().buildPill(tab('t1', 'Marvin'));
    expect(pill.classList.contains('login-stuck')).toBe(true);
    const warn = pill.querySelector('.tab-pill-warn');
    expect(warn?.textContent).toBe('⚠');
    expect(warn?.getAttribute('aria-hidden')).toBe('true');
    expect(pill.title).toBe(INSTRUCTION);
    // The label itself is unchanged — the badge is additive.
    expect(pill.querySelector('.tab-pill-label')?.textContent).toBe('Marvin');
  });

  it('clicking a stuck pill clears the flag, re-renders, and activates the tab', () => {
    hooks().setTabsForTesting([tab('t1', 'Marvin')], null);
    hooks().stuckTabs.set('t1', INSTRUCTION);
    hooks().renderTabBar();
    const list = document.getElementById('tab-list');
    const pill = list?.querySelector<HTMLElement>('.tab-pill');
    expect(pill?.classList.contains('login-stuck')).toBe(true);

    pill?.click();

    expect(hooks().stuckTabs.has('t1')).toBe(false);
    expect(activateTab).toHaveBeenCalledWith('t1');
    // The re-render produced a clean pill.
    const after = document.querySelector<HTMLElement>('#tab-list .tab-pill');
    expect(after?.classList.contains('login-stuck')).toBe(false);
    expect(after?.querySelector('.tab-pill-warn')).toBeNull();
  });

  it('renderTabBar prunes stuck flags for tabs that no longer exist', () => {
    hooks().stuckTabs.set('gone-tab', INSTRUCTION);
    hooks().stuckTabs.set('t2', INSTRUCTION);
    hooks().setTabsForTesting([tab('t2', 'Live')], null);
    hooks().renderTabBar();
    expect(hooks().stuckTabs.has('gone-tab')).toBe(false);
    expect(hooks().stuckTabs.has('t2')).toBe(true);
  });
});
