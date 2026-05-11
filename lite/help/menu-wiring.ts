/**
 * Help window menu wiring.
 *
 * Adds `Onereach.ai Lite Help` as the FIRST entry under the Help
 * top-level menu, matching the macOS convention of putting the user
 * guide at the top of the Help menu (above Report a Bug, Check for
 * Updates, etc.). No accelerator (per ADR-015).
 *
 * Order = 10. The kernel seed places `Report a Bug...` at order 30
 * so this entry sits cleanly above it; `Check for Updates...` stays
 * at order 50.
 */

import { registry } from '../menu/registry.js';

export const HELP_USER_GUIDE_ID = 'help:user-guide';
export const HELP_USER_GUIDE_LABEL = 'Onereach.ai Lite Help';

export interface HelpMenuHandlers {
  onOpenUserGuide: () => void;
}

let registered = false;

/**
 * Register the User Guide menu item under top:help. Idempotent --
 * subsequent calls replace the click handler (matches the updater
 * menu wiring pattern).
 */
export function registerHelpMenu(handlers: HelpMenuHandlers): void {
  registry.upsert({
    id: HELP_USER_GUIDE_ID,
    type: 'item',
    parentId: 'top:help',
    label: HELP_USER_GUIDE_LABEL,
    order: 10,
    click: handlers.onOpenUserGuide,
  });
  registered = true;
}

export function unregisterHelpMenu(): void {
  registry.unregister(HELP_USER_GUIDE_ID);
  registered = false;
}

export function isHelpMenuRegistered(): boolean {
  return registered;
}
