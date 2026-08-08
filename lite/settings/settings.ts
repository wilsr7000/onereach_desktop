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

import { bootRenderer } from '../renderer-boot.js';
import { mountAccount } from './sections/account.js';
import { mountHome } from './sections/home.js';
import { mountUpdates } from './sections/updates.js';
import { mountTwoFactor } from './sections/two-factor.js';
import { mountNeon } from './sections/neon.js';
import { mountIdws } from './sections/idws.js';
import { mountDeveloper } from './sections/developer.js';
import { mountDiagnostics } from './sections/diagnostics.js';
import { mountAi } from './sections/ai.js';
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

const ICON_HOME = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /><path d="M9 21v-6h6v6" /></svg>`;
const ICON_DEVELOPER = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>`;

// Robot/agent icon for the IDWs section.
const ICON_IDWS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="11" rx="2" /><path d="M8 19v2M16 19v2" /><circle cx="9" cy="13" r="1" /><circle cx="15" cy="13" r="1" /><path d="M12 4v4" /><circle cx="12" cy="3" r="1" /></svg>`;

// Sparkle icon for the AI section (auto-metadata).
const ICON_AI = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 4.6L18 9.4l-4.2 1.8L12 16l-1.8-4.8L6 9.4l4.2-1.8z" /><path d="M19 14l.7 1.8L21.5 16.5l-1.8.7L19 19l-.7-1.8L16.5 16.5l1.8-.7z" /></svg>`;


// ---------------------------------------------------------------------------
// Placeholder mount -- used by sections that ship empty in v1
// ---------------------------------------------------------------------------

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
    id: 'ai',
    title: 'AI',
    icon: ICON_AI,
    mount: mountAi,
  },
  {
    id: 'updates',
    title: 'Updates',
    icon: ICON_UPDATES,
    mount: mountUpdates,
  },
  {
    id: 'diagnostics',
    title: 'Diagnostics',
    icon: ICON_DIAGNOSTICS,
    mount: mountDiagnostics,
  },
  {
    id: 'home',
    title: 'Home',
    icon: ICON_HOME,
    mount: mountHome,
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
    mount: mountAbout,
  },
];

/**
 * About: a real section, not a dashed placeholder. Shows the running
 * version + platform (the native macOS About panel does too, but this
 * is the only About on Windows/Linux) alongside what Lite is.
 * (2026-08-08 function sweep.)
 */
function mountAbout(container: HTMLElement): (() => void) | undefined {
  const wrap = document.createElement('div');
  wrap.className = 'about-pane';
  const intro = document.createElement('p');
  intro.className = 'pane-intro';
  intro.textContent =
    'Onereach.ai Lite is a slim, independently-shipping desktop kernel: it signs you in to Onereach.ai and gives your AIs, Spaces, tutorials, and bug reporting a single home — with everything else loaded on demand or deferred to the full app.';
  wrap.appendChild(intro);

  const rows: Array<[string, string]> = [
    ['Version', window.lite?.version ?? 'unknown'],
    ['Platform', window.lite?.platform ?? navigator.platform],
    ['Channel', 'Signed, auto-updating (every 6 hours)'],
  ];
  const grid = document.createElement('div');
  grid.className = 'about-grid';
  for (const [label, value] of rows) {
    const l = document.createElement('span');
    l.className = 'about-grid-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'about-grid-value';
    v.textContent = value;
    grid.append(l, v);
  }
  wrap.appendChild(grid);

  // The cap-chew signs off — the handmade mark, the same one tucked
  // into WISER Playbooks. Nirvana's fingerprint on the machine.
  const sig = document.createElement('div');
  sig.className = 'about-sig';
  const cap = document.createElement('img');
  cap.className = 'about-capchew';
  cap.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAYCAYAAABKtPtEAAANRUlEQVR4Ae3AA6AkWZbG8f937o3IzKdyS2Oubdu2bdu2bdu2bWmMnpZKr54yMyLu+Xa3anqmhztr1a/+yI/9pKWg1EASJYSzYSer9Zp7770XZxKlEKWiKAhQFEJCUQiJWitRgvsJyDRTa7RpIjMB03U9CgEghG0e/4S/53GP+3v6vuelX/plueOO27j9GbfSWgNgahPnz+9ycHDIarnCNpKYz3sWizl93/OoRz6Cf3j8E3jQLbewWi1Zrddc2r3EuXO7LDZmKMQ0No72j5jGkWxJrZV69z13EyUoUYkS1FpwG8lM2jQSIdIQYexGIKRCLZVSChGFUoJaO6IUwGAwxjYxjkwSLSeyGUlgrhBI4rGPeQke8fBHsx7XhII777ydKEHLpJag63pOnIB+1jEMA8Mw0nUdOU1IYhjWnD9/gZd88Rdja2uLYRy56847OXf2PJtbC+bznvV6QJhSRWbBaRSilhARQYQoEUgiEZJQCKURBoQAMCVEqUEthVI6SimUrqPWDgHphDSZDRFEFIZRiIYk7icFYBTBous4sTjDarWktUYplcwEQAFbWxt0XWEYRsZxRApaG1mvR9o0ce/Zc1xz7TVMbQJgmCam1jhx4hgSTOPIiLFBAZIQotZSUSlIIEAEERU8kU3YkA4CIQWhgiKICEqtdF2llI6u66m1AkE6yTaRWZAmIkRmMjmJCABsABMRIKEI+tmMvb1d0kmUgDGQQIhaC7aJCGoNjCA7ap1YrZaM48jTnvY0HnTLg+hnMy5c2AVEKZVSRO06vBqQRIlChlGIGrUgBQIiAgkkYQcRHaUmMCGJUgoRIiKopdDVSi2Vru+ptafWHjvJTJogWoKNnZRSaBlEBDZEiMskJJjPN7h44QKXdi+CYT7foKgwTgOhAIJSKyiwEydQxLxUnAk2h8sVd919N83mvnvP0c061sOaWddhoJRCRNCcKAJFodqJBCgwRjbkiDNprSGDJLCxEykoAiRQEFFQBAgU4BRgJIGEJCRRQhQJAVEC2xgQxhQyk9YmVqsjuq5jNuvBJgIyk5YJGDtRFHAytaREEBFEBMrk3IXzrFYjSLRxYrVaI0MphVIKUQtpEyEkqFIAAgAEEkQgm1KCTFMCZIgIRAAgQEBm0qZGRCGzkZmkE2wAJKEQikKJIGqHbWwDoAhQMJ/PmcaBYVhRa9DVihaijYWWjTY1pjaRU2KJyUZAywQJRSE9kq0hkoggW2NYj3Rdj21CoqsVp3EmAFUKIkSUQkhEqbQWoJF0YleEAUBBiaDWQlcKEkgCm2yNjABAEraRDJhARECtPYogASdIIImtnWPce+9dTMOKYRiQYTafU8aJrJU2TQxlJFolDbk8otRKTg2ycZkgBBGBIihF4MBOsjXSiSWkIEIoAlkEAAgMIDAIIwURhRIFRRClUItQgCQQyAYndpKZZGtkJs7ENjaAQIABjDCBiQAJogSLzU2e8uTHcd2NNzOf9XRdR42g9j1RO2o3o6s9tVS6rtJ3PZkJNrYBsA0WtsEQEcwWPZIYx4lM4zQqQhIoUAlqZgIgBRBIopQKkdiAEzBRgpAQIAlxPwMGm2wNJC6TAAPGNhECKgKwMSCJ+XzBr/7iTzKbzXjS4/+e48dOsjw6ZD0MFIIShdYmSimsVke4BdlV+tYxamIYkpYNDGCEEKJEUKKAwDYk2IkzsY0kQFRIUCAJMBFBRGAnl2WCTCiQBCQSRIACQgKB3cgESSBBGmQAQoUUKIzTJBAhFEFm4zGPfUme/vSnc/fd9/BSL/2yHBzsU1dLptaYpglnkm2ihDlykoi0yTTSQCAEhAKAdGJMZqNEoAgiIDOQAIQwpQZVmAAkkCBCSEKqgHEIIUJBCQEGTEQBBVYgm3QSIWxQBEgIIwlCCAiblCmGCKEotGaOnzjNPX/8R5w/f5aXeImX5sTp6/G5e2nZsBttmnCbqLWgCPLwgEyTaZobTmiZME1EFEpptJZAoFKRRAKQAKBAYQBqlIoiiBC1dkQUIgpgbJAKICKEJDCUEJYIBUiUEkzjSL+YMw0TmQkCCJABKKXDJGEDAomQSINdeOM3fgucyXpYQ1TWOwNHB3tEGHoxDksIQQSoQIpsjWkaaaVRaqFOBdekZcEGEMaUEBiajdOEIG1wUlsbwQklyJwwhftFFAAkkEARhIQUzGYzto4dYxxHfv+3fo277rqDl3v5V+CP/vD3OXPt9bzSK706tXYYkEQgrABD2oDAXCFwg7RZzBfs7p7n2PYW4/oQZ1K6igIUgaJgizaOTNNEOmlpWjbcJXYyjqJEYCAkBBgDBoyzAeAGdRomXBJJFJuIgmogATRsExFIQdf1HD91hs3tHfYunecv/uT3+Ye/+yue9rSnc3C05IlPfDwv/dIvzbmz9/BTP/mDPOpRL8aDH/IItre3sQKbZzK2EYEzISCdZDZSUEKETN93LJdHFAelVFppzCLING1zE0soAkVQQlxhWkuGYWBqibOh0iGBBM7ETto04YTyhm/8Zp8tAYhQECVQFMBgoQiOnzrFidPXcu1NtyDBP/z1n/Kbv/Kz3Pr0pyGJra1tai1kJmfP3kutlc2tbf76r/+Kv/mbv2S9WnPd9TdQSgVxWSiwTWJsgQAndmMxX1BrZRhXTNNERND1PQgwSIEEEQGYKEFmkq0RCtKNZkMmkqi1EBE4TWZjGBrTMAGiGmgJSohM0gkYEXR9zyNf8mWJEKujQ576hL/j7//6z3na057KU576FO697xzZkptvvoEbrr+OU6dOcnB4wO7uRW67/Q62tjZp48Sv/fov84zbnsbrvd6bcN21N2ABBsuQCRhbSCKicPa+e/iHf/gbTp0+w8mTp2gtKaXS9wLWIIEARMsGEm2ayEzWdc0wjrTWkGGaJkIiSqGUQqZp00SUoO96yhu84Zt+NkApQUQhohARSME1N97E0f4e9919B4/7m7+gn814+KNfjJd4qZfj5V7ulZj1lVufcSvTOHHd9dczTSPbOztsbW3Tpsa5s+cREKVy6zNu4+hojzNnrmFzaxswaWMn88WCw6NDnvzkJ/AXf/FHPP3pT+Hc+XPceeedvORLvjStNUoEILI17ASDBCGBIVvDaZwmW8M2AJLo+p6u61gPA8vlQJQAQBHUbCNQaK0QkbTWmKaJiMLxU2fYOXmS1dERj3zJl8UtOXvPXTz1CX/PrU97Ev/w93/LYt4TEbzMy748Ap74hH9gHJZce8011Fq47+x5jpZLNjYW/OVf/TXPeMYzeLu3exdOn7mGU2fOcP7sBX7qZ36U257xDNo0ceaaMzz8YQ/nJV/yZYkQrTU2FluM4xoQEUIIKRAgmwC62jGfz2nTyHw+RwIJaq1kS8ZxYpgmur5jHAZKrbgl1QZJ2NBao7WglOARL/HSbB8/ybBccfbuO3nCP/wN99x1F7c942ms1iv6UrjxhuuJEGfPnePHfvSHeY/3eB9e87Ven7Nn7+UJj/875rMZJ47vsFyu6LrKfDbjGU9/Bj/3Mz/JMAz0i45hPXD69Cle7mVfngfd8mCuufZaMpNxXDMMA601SulQBCKptWMcRuwkSkAEdhIhSgSz2YzWGgIwrFYrVtPEcrUiQihEN+tZHq2ZzXpqdBVFAYEVZCab2ztIwe/80s9w9913cf7cvdz8oIfw8Ec9hmEa+amf+DFOHD/GIx/xCG6++WZsc+78BX7xF36at3u7d+H0mWt5xZ1j/MPf/w2X9nZBhbPnzlFrsLOzw3J5xO7uLm/+lm/JQx/6MM6cvpbWknSjTQ1ktraOgYL9S7us1ysQOIUQEcJOMk1rjbSZ2kjmBEDf9QjRsrFcr1gPI6UEUQowslqtmS9mtLFR3vTN3uqzIwJFJWRKEdfd+GCuu+lB3Hfv3Zw4dZI3eqt34JaHPJyNxYInPeEfePrTnsbtt93J2bNnufbaM/R9x4ULFzh3/jx249Sp09x999089elP4+LFXV7+5V+RE8dPcP7CeS6cu8CJkyd45Vd5FV7xFV6Z+WJOawk2xpgkAqZxwjZd13N4sEdmIyKwYWoTrY201pimkZwa0zQCIhQgQDCOI3t7+9RaUCmsVwOZRgqmaaKUQpWEFEhGQK09Nz3sYbTWePGXfgWWhwf8ye/+Fn/6R7/D4cE+B0cHzGYdi40562HNX/7V3/CIRzyU5WoFhr/9u7/lL//6r1GI+XzO9vY2v/M7v8Xdd9/NcrlmNu+4dOkiT33ak3m5V3hFuq4jKFjGNiGBAwCn6eczhnEAiZ5ACoQAIQUlAgNSodQgSlK7jqntc7RcUbsORbB3/iIAkuj7grOxWg7UiEASkrHNjQ96CHc8/VYuXbzAEx73dzz1yY9DSra2trn+hhtYro44ODhkb2+P1pKuq9x1191sbGzQ9z2LxYLTp0/T2sR8seDM6TOcO3+Wra0Fly7t06YRgNV6zTSO1NJhGSEApGAYRo6OjhAwX2wwDiPr9Qosuq4DYBxG1usV2RrOZBpHxmliYzGHEOvVmhKFYzs7XNy9xLGdHTKTvu8YhxE3M+8X/CPQG0DS3mgH9QAAAABJRU5ErkJggg==';
  cap.alt = 'the cap-chew';
  sig.appendChild(cap);
  const line = document.createElement('span');
  line.className = 'about-sig-line';
  line.textContent = 'Made with care. Come as you are.';
  sig.appendChild(line);
  wrap.appendChild(sig);

  container.appendChild(wrap);
  return (): void => wrap.remove();
}

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

  // Per-section status dot — reserved for a future "needs setup"
  // signal (e.g. the AI section's Anthropic key not yet set). Created
  // hidden; nothing un-hides it yet, so it is inert today.
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

// Shared crash surface (`lite/renderer-boot.ts`): fatal-error banner +
// window error/unhandledrejection listeners (2026-08-08 hardening
// review -- previously only the Spaces renderer had this guard).
bootRenderer({
  scope: 'settings',
  title: 'Settings failed to load',
  init: () => bootstrap(),
});
