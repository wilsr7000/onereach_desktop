/**
 * Onereach Lite Auto-Updater -- menu registration.
 *
 * Adds `Help -> Check for Updates...` to the registry. No accelerator
 * (per ADR-015 -- no shortcuts unless explicitly requested by the user).
 *
 * Order = 50 so future Help entries (Documentation, Feedback, etc.) can
 * insert above (lower order) or below (higher order) without colliding
 * with Report a Bug... (order 0) or this entry.
 */

import { registry } from '../menu/registry.js';

export const CHECK_FOR_UPDATES_ID = 'help:check-for-updates';
export const CHECK_FOR_UPDATES_LABEL = 'Check for Updates...';

export interface UpdaterMenuHandlers {
  onCheckForUpdates: () => void;
}

let registered = false;

/**
 * Register the Check for Updates menu item under top:help. The Help
 * top-level itself is registered by the kernel menu seed (lite/menu/seed.ts);
 * this function only adds a child entry. Idempotent.
 */
export function registerUpdaterMenu(handlers: UpdaterMenuHandlers): void {
  registry.upsert({
    id: CHECK_FOR_UPDATES_ID,
    type: 'item',
    parentId: 'top:help',
    label: CHECK_FOR_UPDATES_LABEL,
    order: 50,
    click: handlers.onCheckForUpdates,
  });
  registered = true;
}

export function unregisterUpdaterMenu(): void {
  registry.unregister(CHECK_FOR_UPDATES_ID);
  registered = false;
}

export function isUpdaterMenuRegistered(): boolean {
  return registered;
}
