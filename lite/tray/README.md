# lite/tray

System tray (macOS menu bar / Windows system tray / Linux notification
area) icon for Onereach.ai Lite.

## What this module does

Installs a tray icon when the kernel boots. Left-click toggles the main
window's visibility. The context menu (right-click on macOS / Windows;
single-click on Linux) gives one-click access to Show / Hide, Spaces,
Settings, Help, and Quit.

The tray shows the same artwork as the app icon (`assets/icon.icns` /
the dock and taskbar icon): the navy tile with the iDW hexagon mark,
loaded from `assets/tray-icon.png`. Setting `LITE_TRAY_TEMPLATE=1`
switches to the monochrome *template* variant of the same mark (the
file name ends in `Template.png` AND
`NativeImage.setTemplateImage(true)` is called), which macOS
auto-adapts for light vs dark menu bars.

## Surface

| Export | Role |
|---|---|
| `initTray(opts)` | Wire up the tray. Returns a `TrayHandle` (`rebuildMenu()`, `teardown()`) or `null` if no icon can be found. |
| `TrayHandle` | Returned by `initTray`; tear down on app quit. |
| `buildTrayMenuTemplate(opts)` | Pure menu template builder. Exposed so tests can pin the structure without constructing a real `Tray`. |
| `resolveTrayIconPath()` | Probes the candidate icon paths (`dist-lite/build/` siblings, then `<appPath>/assets/`). |
| `trayIconCandidates()` | Returns the list of paths probed -- used by the no-icon-found warning. |
| `TRAY_TOOLTIP` | Hover tooltip string (`'Onereach.ai Lite'`). |

## Icon files

The module looks for the tray icon in this order:

1. `dist-lite/build/tray-icon.png` (esbuild-copied)
2. `dist-lite/build/tray-iconTemplate.png` (esbuild-copied)
3. `<appPath>/assets/tray-icon.png`
4. `<appPath>/assets/tray-iconTemplate.png`

The full-color variant is preferred on every platform because it
carries the app icon's own artwork, keeping the tray visually matched
to the dock / taskbar. With `LITE_TRAY_TEMPLATE=1` the template
variant moves to the front of each pair instead (theme-adaptive
monochrome rendering on macOS). Both `tray-iconTemplate.png` (22x22)
and `tray-iconTemplate@2x.png` (44x44, Retina) are generated from the
same source art as the app icon.

## Wiring

Called once from `lite/main-lite.ts` after the main window is created,
with handlers that delegate to the Settings / Help / Spaces modules:

```ts
trayHandle = initTray({
  getMainWindow: () => mainWindow,
  onOpenSettings: () => settingsHandle?.open(),
  onOpenHelp: () => helpHandle?.open(),
  onOpenSpaces: () => spacesHandle?.open(),
});
```

Teardown lives alongside the other module teardowns in the kernel's
quit path.

## Tests

`lite/test/unit/tray-main.test.ts` covers the pure menu template
builder (label ordering, conditional inclusion of Settings / Help /
Spaces when handlers are wired, separator placement, default quit
delegation to `app.quit`).
