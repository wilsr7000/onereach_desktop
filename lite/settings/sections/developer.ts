/**
 * Developer section (ADR-035).
 *
 * One button: "Open API Reference." Opens the in-app docs window
 * sourced from `lite/api-docs/manifest.generated.ts` (built from
 * each module's `api.ts`, `events.ts`, and `README.md`).
 *
 * Consumes `window.lite.apiDocs` per the standard preload bridge
 * pattern. No state of its own; the docs window owns its render.
 */

/// <reference path="../../lite-window.d.ts" />

import type { SectionDescriptor } from '../types.js';

function apiDocs(): LiteApiDocsBridge {
  const bridge = window.lite?.apiDocs;
  if (bridge === undefined) {
    throw new Error('preload bridge `window.lite.apiDocs` is not available');
  }
  return bridge;
}

export const mountDeveloper: SectionDescriptor['mount'] = (container) => {
  container.innerHTML = '';

  const intro = document.createElement('p');
  intro.className = 'pane-intro';
  intro.textContent =
    'Browse every documented Lite module: public API, typed events, and full README. ' +
    'Content is harvested at build time from the actual source -- if a module ships, ' +
    'its docs ship with it.';
  container.appendChild(intro);

  const row = document.createElement('div');
  row.className = 'dev-actions';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-primary';
  btn.textContent = 'Open API Reference';
  btn.addEventListener('click', () => {
    void apiDocs()
      .open()
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[settings/developer] failed to open api-docs window', err);
      });
  });
  row.appendChild(btn);
  container.appendChild(row);

  const note = document.createElement('p');
  note.className = 'pane-note';
  note.textContent =
    'A new window will open. The first launch may take a moment while the bundled ' +
    'manifest renders (~50 KB of typed module metadata + README content).';
  container.appendChild(note);

  // No state to clean up.
  return undefined;
};
