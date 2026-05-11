/**
 * Help main-process orchestration.
 *
 * Owns:
 *   - The Help window factory (single-instance) -- exposed via the
 *     `open()` method on `HelpHandle`.
 *   - The menu entry under `top:help` ("Onereach.ai Lite Help").
 *
 * Mirrors the Settings module's shape (`lite/settings/main.ts`). The
 * window itself is a thin BrowserWindow loading `help.html`; all
 * content lives in the static HTML + bundled `help.ts` renderer.
 */

import type { BrowserWindow } from 'electron';
import { openHelpWindow, closeHelpWindow } from './window.js';
import {
  registerHelpMenu,
  unregisterHelpMenu,
  isHelpMenuRegistered,
} from './menu-wiring.js';

export interface InitHelpOptions {
  /** Path to the bundled `preload-lite.js`. */
  preloadPath: string;
  /** Path to the bundled `help.html`. */
  htmlPath: string;
  /** Resolver for the parent window. Called each time Help opens. */
  getParentWindow: () => BrowserWindow | null;
  /** Optional logger (defaults to silent). */
  logger?: {
    info: (message: string, data?: unknown) => void;
    warn: (message: string, data?: unknown) => void;
    error: (message: string, data?: unknown) => void;
  };
}

export interface HelpHandle {
  /**
   * Open (or focus) the Help window. Optional `sectionId` deep-links
   * to an anchor (e.g. 'two-factor', 'auto-update').
   */
  open(sectionId?: string): void;
  /** Tear down the menu entry and close the window. Idempotent. */
  teardown(): void;
}

let initOptions: InitHelpOptions | null = null;

/**
 * Register the Help menu entry and return a handle. Safe to call
 * multiple times; idempotent via `registry.upsert`.
 */
export function initHelp(opts: InitHelpOptions): HelpHandle {
  const log = opts.logger ?? {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  initOptions = opts;

  const open = (sectionId?: string): void => {
    if (initOptions === null) {
      log.warn('help: open() called before init');
      return;
    }
    try {
      const cfg: Parameters<typeof openHelpWindow>[0] = {
        parent: initOptions.getParentWindow(),
        htmlPath: initOptions.htmlPath,
        preloadPath: initOptions.preloadPath,
      };
      if (typeof sectionId === 'string' && sectionId.length > 0) {
        cfg.sectionId = sectionId;
      }
      openHelpWindow(cfg);
      log.info('help: window opened', sectionId !== undefined ? { sectionId } : {});
    } catch (err) {
      log.error('help: failed to open window', { error: (err as Error).message });
    }
  };

  registerHelpMenu({ onOpenUserGuide: () => open() });

  return {
    open,
    teardown: (): void => {
      try {
        closeHelpWindow();
      } catch {
        /* best-effort */
      }
      if (isHelpMenuRegistered()) {
        unregisterHelpMenu();
      }
      initOptions = null;
    },
  };
}
