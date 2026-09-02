/**
 * Settings → Appearance: Light (default) / Dark / Match system.
 *
 * Pick-don't-type: three radio cards, each a miniature of the window
 * it produces, so the choice is seen before it is made. Applies the
 * moment a card is chosen — the main process flips `nativeTheme`, and
 * every open window repaints through `prefers-color-scheme` — so there
 * is no Save button and nothing to wait for.
 *
 * Same conventions as the other sections: self-mounting, talks only
 * through the preload bridge, returns a disposer.
 */

type ThemePreference = 'light' | 'dark' | 'system';

interface ThemeOption {
  value: ThemePreference;
  label: string;
  hint: string;
}

const OPTIONS: readonly ThemeOption[] = [
  { value: 'light', label: 'Light', hint: 'The default.' },
  { value: 'dark', label: 'Dark', hint: 'The original palette.' },
  { value: 'system', label: 'Match system', hint: 'Follows your Mac.' },
];

export function mountAppearance(container: HTMLElement): (() => void) | undefined {
  const wrap = document.createElement('div');
  wrap.className = 'appearance-pane';

  const intro = document.createElement('p');
  intro.className = 'pane-intro';
  intro.textContent =
    'Choose how Onereach.ai Lite looks. The change applies to every window immediately.';
  wrap.appendChild(intro);

  const group = document.createElement('div');
  group.className = 'appearance-options';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', 'Appearance');
  wrap.appendChild(group);

  const cards = new Map<ThemePreference, HTMLButtonElement>();
  for (const option of OPTIONS) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'appearance-option';
    card.dataset['theme'] = option.value;
    card.setAttribute('role', 'radio');
    card.setAttribute('aria-checked', 'false');
    card.tabIndex = -1;

    // The miniature: a title bar and a card on a canvas, painted in the
    // palette the option selects (theme-invariant by design).
    const swatch = document.createElement('span');
    swatch.className = 'appearance-swatch';
    swatch.setAttribute('aria-hidden', 'true');
    const bar = document.createElement('span');
    bar.className = 'appearance-swatch-bar';
    const body = document.createElement('span');
    body.className = 'appearance-swatch-body';
    const tile = document.createElement('span');
    tile.className = 'appearance-swatch-card';
    body.appendChild(tile);
    swatch.append(bar, body);

    const label = document.createElement('span');
    label.className = 'appearance-option-label';
    label.textContent = option.label;

    const hint = document.createElement('span');
    hint.className = 'appearance-option-hint';
    hint.textContent = option.hint;

    card.append(swatch, label, hint);
    group.appendChild(card);
    cards.set(option.value, card);
  }

  const note = document.createElement('p');
  note.className = 'pane-note';
  wrap.appendChild(note);

  container.appendChild(wrap);

  const bridge = window.lite?.theme;
  let current: ThemePreference = 'light';

  const render = (state: { preference: ThemePreference; isDefault: boolean }): void => {
    current = state.preference;
    for (const [value, card] of cards) {
      const on = value === state.preference;
      card.setAttribute('aria-checked', on ? 'true' : 'false');
      card.classList.toggle('is-selected', on);
      card.tabIndex = on ? 0 : -1;
    }
    note.textContent = state.isDefault
      ? 'Using the default (Light).'
      : `${OPTIONS.find((o) => o.value === state.preference)?.label ?? state.preference} is on.`;
  };

  const choose = (value: ThemePreference): void => {
    if (bridge === undefined) {
      note.textContent = 'Bridge unavailable — reload the window.';
      return;
    }
    // Optimistic: the card flips now; the bridge confirms (or reverts).
    render({ preference: value, isDefault: false });
    void bridge
      .set(value)
      .then(render)
      .catch(async (err: unknown) => {
        // Revert to what the main process actually holds, THEN explain.
        try {
          render(await bridge.get());
        } catch {
          /* keep the optimistic state; the note still explains */
        }
        note.textContent = err instanceof Error ? err.message : 'Could not change the appearance.';
      });
  };

  for (const [value, card] of cards) {
    card.addEventListener('click', () => choose(value));
  }

  // Roving radio: arrows move AND apply, like a native radio group.
  const onKeyDown = (event: KeyboardEvent): void => {
    const order = OPTIONS.map((o) => o.value);
    const index = order.indexOf(current);
    let next: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % order.length;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      next = (index - 1 + order.length) % order.length;
    }
    if (next === null) return;
    event.preventDefault();
    const value = order[next];
    if (value === undefined) return;
    choose(value);
    cards.get(value)?.focus();
  };
  group.addEventListener('keydown', onKeyDown);

  const load = async (): Promise<void> => {
    if (bridge === undefined) {
      render({ preference: 'light', isDefault: true });
      note.textContent = 'Bridge unavailable — reload the window.';
      return;
    }
    try {
      render(await bridge.get());
    } catch {
      note.textContent = 'Could not read the setting.';
    }
  };

  void load();
  return () => {
    group.removeEventListener('keydown', onKeyDown);
  };
}
