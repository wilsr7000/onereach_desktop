/**
 * Settings window renderer entry.
 *
 * Renders a sidebar of section tabs + a content area. Tabs are
 * registered in the `SECTIONS` list; clicking a tab lazily mounts the
 * section into its content pane on first activation, then keeps it
 * mounted until window close. Disposers run on `beforeunload` so each
 * section can clean up timers / listeners (e.g. Two-Factor's countdown
 * setInterval, Account's session listener).
 *
 * Loaded as an external script (not inline) so the strict CSP
 * `script-src 'self'` allows execution -- see the LITE-PUNCH-LIST
 * "Renderer scripts must be bundled, never inline" lesson.
 */

/// <reference path="../lite-window.d.ts" />

// File is a module so esbuild treats it as ESM input.
export {};

import { mountAccount } from './sections/account.js';
import { mountTwoFactor } from './sections/two-factor.js';
import { mountNeon } from './sections/neon.js';
import { mountIdws } from './sections/idws.js';
import { mountDeveloper } from './sections/developer.js';
import { mountDiagnostics } from './sections/diagnostics.js';
import type { SectionDescriptor } from './types.js';

// ---------------------------------------------------------------------------
// Section icons
//
// Inline SVG strings -- 16x16, currentColor stroke. Active-tab CSS swaps
// the surrounding color so we don't need separate active variants.
// ---------------------------------------------------------------------------

const ICON_ACCOUNT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>`;

const ICON_TWO_FACTOR = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>`;

const ICON_UPDATES = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7" /><polyline points="21 3 21 9 15 9" /></svg>`;

const ICON_DIAGNOSTICS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4" /><path d="M12 18v4" /><path d="M4.93 4.93l2.83 2.83" /><path d="M16.24 16.24l2.83 2.83" /><path d="M2 12h4" /><path d="M18 12h4" /><path d="M4.93 19.07l2.83-2.83" /><path d="M16.24 7.76l2.83-2.83" /></svg>`;

const ICON_NEON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v6a8 3 0 0 0 16 0V6" /><path d="M4 12v6a8 3 0 0 0 16 0v-6" /></svg>`;

const ICON_ABOUT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>`;

const ICON_DEVELOPER = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>`;

// Robot/agent icon for the IDWs section.
const ICON_IDWS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="11" rx="2" /><path d="M8 19v2M16 19v2" /><circle cx="9" cy="13" r="1" /><circle cx="15" cy="13" r="1" /><path d="M12 4v4" /><circle cx="12" cy="3" r="1" /></svg>`;


// ---------------------------------------------------------------------------
// Placeholder mount -- used by sections that ship empty in v1
// ---------------------------------------------------------------------------

function placeholderMount(message: string): SectionDescriptor['mount'] {
  return (container) => {
    container.innerHTML = `<div class="pane-placeholder">${message}</div>`;
    return undefined;
  };
}

// ---------------------------------------------------------------------------
// Section list
//
// Order here = order in the sidebar. Account is first because it's the
// only fully-populated section in v1; Two-Factor preserves the existing
// functionality; the rest are placeholders showing the structure.
// ---------------------------------------------------------------------------

const SECTIONS: SectionDescriptor[] = [
  {
    id: 'account',
    title: 'Account',
    icon: ICON_ACCOUNT,
    mount: mountAccount,
  },
  {
    id: 'two-factor',
    title: 'Two-Factor',
    icon: ICON_TWO_FACTOR,
    mount: mountTwoFactor,
  },
  {
    id: 'oagi',
    title: 'OAGI',
    icon: ICON_NEON,
    mount: mountNeon,
  },
  {
    id: 'idws',
    title: 'IDWs',
    icon: ICON_IDWS,
    mount: mountIdws,
  },
  {
    id: 'updates',
    title: 'Updates',
    icon: ICON_UPDATES,
    mount: placeholderMount(
      'Update settings will appear here. Today, lite checks for updates automatically every 6 hours; use Help -> Check for Updates to trigger a check manually.'
    ),
  },
  {
    id: 'diagnostics',
    title: 'Diagnostics',
    icon: ICON_DIAGNOSTICS,
    mount: mountDiagnostics,
  },
  {
    id: 'developer',
    title: 'Developer',
    icon: ICON_DEVELOPER,
    mount: mountDeveloper,
  },
  {
    id: 'about',
    title: 'About',
    icon: ICON_ABOUT,
    mount: placeholderMount(
      'Onereach.ai Lite. A slim Electron kernel that ships independently from the full Onereach.ai app.'
    ),
  },
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface MountedSection {
  pane: HTMLElement;
  /** True once the section's mount() has run for this window. */
  mounted: boolean;
  /** Disposer returned from mount(); null if never mounted or none returned. */
  dispose: (() => void) | null;
}

const mounted = new Map<string, MountedSection>();
let activeId: string | null = null;

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function bootstrap(): void {
  const sidebar = document.getElementById('settings-sidebar');
  const content = document.getElementById('settings-content');
  if (sidebar === null || content === null) {
    // eslint-disable-next-line no-console
    console.error('[settings] required mount points not found in DOM');
    return;
  }

  // Build sidebar tabs + content panes.
  for (const section of SECTIONS) {
    sidebar.appendChild(buildSidebarTab(section));
    content.appendChild(buildContentPane(section));
  }

  // Honor a deep-link section id (?section=idws). Falls back to the
  // first section when the requested id is unknown or absent.
  const requested = readRequestedSection();
  const known = requested !== null && SECTIONS.some((s) => s.id === requested);
  const initialId = known && requested !== null ? requested : SECTIONS[0]?.id;
  if (initialId !== undefined) {
    activate(initialId);
  }

  // Close button.
  const closeBtn = document.getElementById('close-btn');
  if (closeBtn !== null) {
    closeBtn.addEventListener('click', () => window.close());
  }


  // Expose a global for the main process to call when the window is
  // already open and the user requests a different section. Uses a
  // double-underscore prefix to signal "internal API; not for general
  // renderer code". The main-process side calls this via
  // webContents.executeJavaScript -- see `lite/settings/window.ts`.
  (window as unknown as { __liteActivateSection?: (id: string) => void }).__liteActivateSection = (id: string): void => {
    if (typeof id !== 'string' || id.length === 0) return;
    if (!SECTIONS.some((s) => s.id === id)) return;
    activate(id);
  };
}

function readRequestedSection(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const value = params.get('section');
    return value !== null && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function buildSidebarTab(section: SectionDescriptor): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sidebar-tab';
  btn.dataset['section'] = section.id;
  btn.setAttribute('role', 'tab');
  btn.setAttribute('aria-controls', `pane-${section.id}`);
  btn.setAttribute('aria-selected', 'false');

  if (section.icon !== undefined) {
    const iconWrap = document.createElement('span');
    iconWrap.className = 'sidebar-tab-icon';
    iconWrap.innerHTML = section.icon;
    btn.appendChild(iconWrap);
  }

  const label = document.createElement('span');
  label.className = 'sidebar-tab-label';
  label.textContent = section.title;
  btn.appendChild(label);

  // Per-section status dot (e.g. AI section shows a dot when the
  // OpenAI API key isn't set yet so the user can see the
  // unfinished-setup signal without entering the section).
  const dot = document.createElement('span');
  dot.className = 'sidebar-tab-dot';
  dot.dataset['for'] = section.id;
  dot.hidden = true;
  btn.appendChild(dot);

  btn.addEventListener('click', () => activate(section.id));
  return btn;
}


function buildContentPane(section: SectionDescriptor): HTMLElement {
  const pane = document.createElement('section');
  pane.className = 'tab-pane';
  pane.id = `pane-${section.id}`;
  pane.setAttribute('role', 'tabpanel');
  pane.setAttribute('aria-labelledby', `tab-${section.id}`);

  const header = document.createElement('div');
  header.className = 'pane-header';
  const h2 = document.createElement('h2');
  h2.className = 'pane-title';
  h2.textContent = section.title;
  header.appendChild(h2);
  pane.appendChild(header);

  const mountPoint = document.createElement('div');
  mountPoint.className = 'pane-body';
  pane.appendChild(mountPoint);

  mounted.set(section.id, { pane, mounted: false, dispose: null });
  return pane;
}

function activate(id: string): void {
  if (id === activeId) return;
  const target = mounted.get(id);
  if (target === undefined) return;

  // Update sidebar active class. Array.from for lib.dom iterator
  // compat across the strict TS config.
  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('.sidebar-tab'))) {
    const isActive = btn.dataset['section'] === id;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  }

  // Hide previously active pane.
  if (activeId !== null) {
    const prev = mounted.get(activeId);
    if (prev !== undefined) prev.pane.classList.remove('active');
  }

  // Show target pane.
  target.pane.classList.add('active');
  activeId = id;

  // Lazy mount on first activation.
  if (!target.mounted) {
    const section = SECTIONS.find((s) => s.id === id);
    if (section === undefined) return;
    const body = target.pane.querySelector<HTMLElement>('.pane-body');
    if (body === null) return;
    try {
      const dispose = section.mount(body);
      target.mounted = true;
      target.dispose = dispose ?? null;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[settings] section "${id}" failed to mount:`, err);
      body.textContent = `This section failed to load: ${(err as Error).message}`;
      target.mounted = true;
    }
  }
}

window.addEventListener('beforeunload', () => {
  for (const entry of mounted.values()) {
    if (entry.dispose !== null) {
      try {
        entry.dispose();
      } catch {
        // best-effort
      }
    }
  }
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
