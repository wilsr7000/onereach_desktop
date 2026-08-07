/**
 * Settings → Home: which page the main window's Home tab loads.
 *
 * 2026-08-07, per user request: the Home tab's remote page is
 * configurable, defaulting to the WISER capture join room. The URL may
 * contain a literal `{accountId}` placeholder, substituted at load
 * time with the signed-in GSX account id.
 *
 * Same conventions as the other sections: self-mounting, returns a
 * disposer, talks only through the preload bridge.
 */

export function mountHome(container: HTMLElement): (() => void) | undefined {
  const wrap = document.createElement('div');
  wrap.className = 'home-pane';

  const intro = document.createElement('p');
  intro.className = 'pane-intro';
  intro.textContent =
    'The Home tab loads this page. Use {accountId} anywhere in the URL to inject the signed-in GSX account id. Changes apply on the next app launch.';
  wrap.appendChild(intro);

  const label = document.createElement('label');
  label.className = 'home-url-label';
  label.textContent = 'Home page URL';
  label.setAttribute('for', 'settings-home-url');
  wrap.appendChild(label);

  const input = document.createElement('input');
  input.type = 'url';
  input.id = 'settings-home-url';
  input.className = 'home-url-input';
  input.placeholder = 'https://…';
  input.spellcheck = false;
  wrap.appendChild(input);

  const note = document.createElement('p');
  note.className = 'pane-note';
  wrap.appendChild(note);

  const actions = document.createElement('div');
  actions.className = 'dev-actions';

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn-primary';
  save.textContent = 'Save';
  actions.appendChild(save);

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'btn-secondary';
  reset.textContent = 'Reset to default';
  actions.appendChild(reset);

  wrap.appendChild(actions);
  container.appendChild(wrap);

  const bridge = window.lite?.homeUrl;

  const render = (state: { url: string; isDefault: boolean }): void => {
    input.value = state.url;
    note.textContent = state.isDefault
      ? 'Using the default (GSX Product Expert — email triage).'
      : 'Custom URL set.';
  };

  const load = async (): Promise<void> => {
    if (bridge === undefined) {
      note.textContent = 'Bridge unavailable — reload the window.';
      return;
    }
    try {
      render(await bridge.get());
    } catch {
      note.textContent = 'Could not read the setting.';
    }
  };

  save.addEventListener('click', () => {
    if (bridge === undefined) return;
    save.disabled = true;
    void bridge
      .set(input.value)
      .then((state) => {
        render(state);
        note.textContent = `${note.textContent} Saved — takes effect on next launch.`;
      })
      .catch((err: unknown) => {
        note.textContent = err instanceof Error ? err.message : 'Save failed.';
      })
      .finally(() => {
        save.disabled = false;
      });
  });

  reset.addEventListener('click', () => {
    if (bridge === undefined) return;
    reset.disabled = true;
    void bridge
      .set(null)
      .then((state) => {
        render(state);
        note.textContent = 'Reset to the default. Takes effect on next launch.';
      })
      .catch(() => {
        note.textContent = 'Reset failed.';
      })
      .finally(() => {
        reset.disabled = false;
      });
  });

  void load();
  return undefined;
}
