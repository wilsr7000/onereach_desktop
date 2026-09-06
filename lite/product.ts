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
 * The bundle folder — and the executable inside it — keep the INTERNAL
 * name (electron-builder `productName`). Not cosmetic caution: on macOS
 * the update is applied by a bash helper packaged inside the app that is
 * ALREADY installed, and every helper shipped through 0.0.90 finds the
 * new bundle inside the downloaded zip by the installed folder's own
 * basename. A zip whose root is "Onereach Desktop.app" fails every one of
 * those installs at find_bundle (verified against the built zip,
 * 2026-09-06 review). The name people see comes from CFBundleName (the
 * menu-bar title) and CFBundleDisplayName (Dock, About), both set to
 * PRODUCT_DISPLAY_NAME in electron-builder.json; only Finder still shows
 * the folder's file name.
 *
 * Renaming the folder later needs a sequence: first ship a helper that
 * accepts a lone `*.app` at the zip root (scripts/install-update.sh does
 * since 0.0.91), wait until no install older than that remains, then
 * change productName. Until then this list has one entry.
 */
export const APP_BUNDLE_NAMES = [`${INTERNAL_APP_NAME}.app`] as const;
