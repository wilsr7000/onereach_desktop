/**
 * Menu Registry Seed -- registers the kernel's menu entries.
 *
 * Kernel menu structure (per ADR-016, which supersedes ADR-014):
 *
 *   Onereach.ai Lite (top:app,  role: appMenu)
 *     |- About Onereach.ai Lite (app:about, click)
 *     |- Quit Onereach.ai Lite  (app:quit,  click)
 *
 *   Help (top:help, role: help)
 *     |- Report a Bug...        (help:report-bug, click)
 *
 *   Dev Tools (top:dev-tools)
 *     |- Open DevTools for Focused Window
 *     |- Open DevTools for Active Tab
 *     |- Open DevTools for All Windows
 *
 * NO accelerators are bound by default (per ADR-015 and the "Keyboard
 * Shortcuts" rule in .cursorrules). Items use explicit click handlers
 * rather than role-driven defaults so Electron does not auto-add Cmd+Q
 * from `role: 'quit'`. The user adds shortcuts by name when they want them.
 *
 * Future ports register their entries (and any new top-level placeholders)
 * into the registry; the menu builder picks them up automatically. See
 * lite/PORTING.md for the registration template each port copies.
 */

import { registry } from './registry.js';

export interface SeedHandlers {
  /** Called when the user clicks Report a Bug... */
  onReportBug: () => void;
  /** Called when the user clicks About. Routes to native panel on macOS, custom HTML on Windows. */
  onAbout: () => void;
  /** Called when the user clicks Quit. Should call app.quit() in main process. */
  onQuit: () => void;
  /** Called when the user clicks Settings... (ADR-031). */
  onSettings?: () => void;
  /** Called when the user clicks Open DevTools for Focused Window. */
  onOpenFocusedDevTools?: () => void;
  /** Called when the user clicks Open DevTools for Active Tab. */
  onOpenActiveTabDevTools?: () => void;
  /** Called when the user clicks Open DevTools for All Windows. */
  onOpenAllDevTools?: () => void;
}

let seeded = false;

/**
 * Register the kernel's menu entries. Safe to call multiple times
 * (idempotent via upsert), but not necessary.
 */
export function seedKernelMenu(handlers: SeedHandlers): void {
  // Top-level placeholders. App menu first (role 'appMenu' positions it
  // as the productName slot on macOS); Help last (role 'help' marks it
  // for platform conventions like macOS's Help-search affordance).
  registry.upsert({
    id: 'top:app',
    type: 'top-level',
    role: 'appMenu',
    order: 0,
  });

  // Help menu uses an explicit `label:` only, NOT `role: 'help'` (ADR-017).
  // Note: removing the role alone is NOT sufficient -- macOS Cocoa also
  // detects help menus by title. The full fix is Info.plist keys
  // (CFBundleHelpBookFolder + CFBundleHelpBookName) added in ADR-018,
  // which suppress macOS's auto-injection in packaged builds. In dev
  // (`npm run lite:dev`), the Electron host bundle's Info.plist is what
  // macOS sees, so "Send Electron Feedback to Apple..." still appears
  // until you run `npm run lite:package:mac`.
  registry.upsert({
    id: 'top:help',
    type: 'top-level',
    label: 'Help',
    order: 100,
  });

  if (
    handlers.onOpenFocusedDevTools !== undefined ||
    handlers.onOpenActiveTabDevTools !== undefined ||
    handlers.onOpenAllDevTools !== undefined
  ) {
    registry.upsert({
      id: 'top:dev-tools',
      type: 'top-level',
      label: 'Dev Tools',
      order: 90,
    });
  }

  // App menu items.
  // No `role:` on items -- roles can come with platform-default
  // accelerators (Cmd+Q for role:'quit' on macOS) which violate the
  // "no shortcuts unless explicitly requested" policy.
  registry.upsert({
    id: 'app:about',
    type: 'item',
    parentId: 'top:app',
    label: 'About Onereach.ai Lite',
    order: 0,
    click: handlers.onAbout,
  });

  // Settings... menu entry. macOS convention places this between About
  // and Quit in the app menu (ADR-031). No accelerator per ADR-015 +
  // .cursorrules ("no shortcuts unless explicitly requested by name").
  if (handlers.onSettings !== undefined) {
    const settingsClick = handlers.onSettings;
    registry.upsert({
      id: 'app:settings',
      type: 'item',
      parentId: 'top:app',
      label: 'Settings...',
      order: 50,
      click: settingsClick,
    });
  }

  registry.upsert({
    id: 'app:quit',
    type: 'item',
    parentId: 'top:app',
    label: 'Quit Onereach.ai Lite',
    order: 100,
    click: handlers.onQuit,
  });

  if (handlers.onOpenFocusedDevTools !== undefined) {
    const openFocusedDevTools = handlers.onOpenFocusedDevTools;
    registry.upsert({
      id: 'dev-tools:open-focused-window',
      type: 'item',
      parentId: 'top:dev-tools',
      label: 'Open DevTools for Focused Window',
      order: 0,
      click: openFocusedDevTools,
    });
  }

  if (handlers.onOpenActiveTabDevTools !== undefined) {
    const openActiveTabDevTools = handlers.onOpenActiveTabDevTools;
    registry.upsert({
      id: 'dev-tools:open-active-tab',
      type: 'item',
      parentId: 'top:dev-tools',
      label: 'Open DevTools for Active Tab',
      order: 10,
      click: openActiveTabDevTools,
    });
  }

  if (handlers.onOpenAllDevTools !== undefined) {
    const openAllDevTools = handlers.onOpenAllDevTools;
    registry.upsert({
      id: 'dev-tools:open-all-windows',
      type: 'item',
      parentId: 'top:dev-tools',
      label: 'Open DevTools for All Windows',
      order: 20,
      click: openAllDevTools,
    });
  }

  // Help menu items.
  registry.upsert({
    id: 'help:report-bug',
    type: 'item',
    parentId: 'top:help',
    label: 'Report a Bug...',
    order: 0,
    click: handlers.onReportBug,
  });

  // Tools menu used to host the standalone Authenticator window
  // (ADR-027). That moved into Settings -> Two-Factor as part of
  // ADR-031; the Tools placeholder is no longer registered. The
  // registry's getChildren semantics auto-hide top-level menus with
  // no children, so removing the top:tools registration is enough --
  // the menu bar reflects the change immediately.

  seeded = true;
}

/** Whether the kernel menu has been seeded. For tests. */
export function isSeeded(): boolean {
  return seeded;
}

/** Reset the seeded flag for tests. */
export function _resetSeedForTesting(): void {
  seeded = false;
}
