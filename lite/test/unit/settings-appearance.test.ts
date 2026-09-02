/**
 * Settings → Appearance section: three radio cards, current one
 * checked, choosing applies through the bridge immediately (no Save),
 * arrows move the choice like a native radio group.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mountAppearance } from '../../settings/sections/appearance.js';

type Pref = 'light' | 'dark' | 'system';

function installBridge(initial: Pref | null): { sets: Array<Pref | null> } {
  const sets: Array<Pref | null> = [];
  let current: Pref = initial ?? 'light';
  let isDefault = initial === null;
  (window as unknown as { lite?: unknown }).lite = {
    theme: {
      get: async () => ({ preference: current, isDefault }),
      set: async (p: Pref | null) => {
        sets.push(p);
        current = p ?? 'light';
        isDefault = p === null;
        return { preference: current, isDefault };
      },
    },
  };
  return { sets };
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

function checked(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('.appearance-option[aria-checked="true"]')
  ).map((el) => el.dataset['theme'] ?? '');
}

beforeEach(() => {
  document.body.innerHTML = '<div id="host"></div>';
  delete (window as unknown as { lite?: unknown }).lite;
});

describe('Settings → Appearance', () => {
  it('renders Light / Dark / Match system as a radio group with Light checked by default', async () => {
    installBridge(null);
    mountAppearance(document.getElementById('host') as HTMLElement);
    await flush();
    const group = document.querySelector('[role="radiogroup"]');
    expect(group).not.toBeNull();
    const cards = Array.from(document.querySelectorAll<HTMLElement>('.appearance-option'));
    expect(cards.map((c) => c.dataset['theme'])).toEqual(['light', 'dark', 'system']);
    expect(cards.map((c) => c.textContent)).toEqual([
      expect.stringContaining('Light'),
      expect.stringContaining('Dark'),
      expect.stringContaining('Match system'),
    ]);
    expect(checked()).toEqual(['light']);
    expect(document.querySelector('.pane-note')?.textContent).toContain('default');
    // No Save button: the choice is the action.
    expect(document.querySelector('button.btn-primary')).toBeNull();
  });

  it('reflects a stored preference', async () => {
    installBridge('dark');
    mountAppearance(document.getElementById('host') as HTMLElement);
    await flush();
    expect(checked()).toEqual(['dark']);
    expect(document.querySelector('.pane-note')?.textContent).toContain('Dark is on');
  });

  it('choosing a card applies immediately through the bridge', async () => {
    const bridge = installBridge(null);
    mountAppearance(document.getElementById('host') as HTMLElement);
    await flush();
    document.querySelector<HTMLButtonElement>('.appearance-option[data-theme="dark"]')?.click();
    await flush();
    expect(bridge.sets).toEqual(['dark']);
    expect(checked()).toEqual(['dark']);
    expect(document.querySelector('.pane-note')?.textContent).toContain('Dark is on');
  });

  it('arrow keys move and apply the choice; the checked card is the only tab stop', async () => {
    const bridge = installBridge('light');
    mountAppearance(document.getElementById('host') as HTMLElement);
    await flush();
    const group = document.querySelector('[role="radiogroup"]') as HTMLElement;
    group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await flush();
    expect(bridge.sets).toEqual(['dark']);
    expect(checked()).toEqual(['dark']);
    group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await flush();
    expect(bridge.sets).toEqual(['dark', 'light']);
    const stops = Array.from(document.querySelectorAll<HTMLElement>('.appearance-option')).map(
      (c) => c.tabIndex
    );
    expect(stops).toEqual([0, -1, -1]);
  });

  it('a failed set reverts to what the bridge reports and explains', async () => {
    (window as unknown as { lite?: unknown }).lite = {
      theme: {
        get: async () => ({ preference: 'light', isDefault: true }),
        set: async () => {
          throw new Error('disk full');
        },
      },
    };
    mountAppearance(document.getElementById('host') as HTMLElement);
    await flush();
    document.querySelector<HTMLButtonElement>('.appearance-option[data-theme="system"]')?.click();
    await flush();
    await flush();
    expect(document.querySelector('.pane-note')?.textContent).toContain('disk full');
    expect(checked()).toEqual(['light']);
  });

  it('without a bridge the pane still renders and says so', async () => {
    mountAppearance(document.getElementById('host') as HTMLElement);
    await flush();
    expect(document.querySelectorAll('.appearance-option')).toHaveLength(3);
    expect(document.querySelector('.pane-note')?.textContent).toContain('Bridge unavailable');
  });
});
