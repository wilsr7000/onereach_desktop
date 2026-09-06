/**
 * Product naming — the ONE place the user-facing name lives (ADR-095,
 * 2026-09-06: "let's not call it Onereach Lite, let's call it Onereach
 * Desktop").
 *
 * Two names, deliberately different:
 *
 *   - PRODUCT_DISPLAY_NAME is what people see: the bundle and DMG
 *     (electron-builder `productName` / CFBundleDisplayName), the app and
 *     tray menus, window titles, About, Help, dialogs, in-app prose.
 *     Change it here; `product-name.test.ts` pins every surface that has
 *     to agree (the builder config, the release script, the HTML titles).
 *
 *   - INTERNAL_APP_NAME is the identity Electron keys everything on:
 *     `app.setName()` → the userData folder, the log folder, the
 *     safeStorage keychain item ("<name> Safe Storage"), the SessionVault
 *     service, Squirrel.Mac update pathing. It is FROZEN. Changing it
 *     silently moves every install's data and vault, and the user signs
 *     in again to an empty app. It is never shown to anyone; `lite/` stays
 *     the codename in code, scripts and ADRs.
 *
 * The bundle id (`appId` com.onereach.lite) is frozen for the same
 * reason — auto-update, keychain access and passkeys all hang off it.
 */

export const PRODUCT_DISPLAY_NAME = 'Onereach Desktop';

export const INTERNAL_APP_NAME = 'Onereach.ai Lite';

/**
 * Bundle folder names an install can live under. A fresh install lands as
 * the first; an install that auto-updated in place from before the rename
 * keeps the folder it was dragged in as — Squirrel.Mac swaps the bundle's
 * contents at the running app's path and never renames the folder.
 */
export const APP_BUNDLE_NAMES = [`${PRODUCT_DISPLAY_NAME}.app`, `${INTERNAL_APP_NAME}.app`] as const;
