/**
 * Onereach.ai Lite -- system tray icon.
 *
 * Adds the Lite icon to the macOS menu bar / Windows system tray /
 * Linux notification area when the app is running. On macOS the icon
 * is loaded as a template image so the OS auto-adapts it to the menu
 * bar's light/dark theme (white-on-dark, dark-on-light).
 *
 * Borrowed pattern: full app's `createTray()` in `main.js` lines
 * 444-500. Lite's port is a small module so tests can pin the menu
 * template without constructing a real `Tray`.
 *
 * Wired from `lite/main-lite.ts` after the main window is created.
 * Tear down via the returned `TrayHandle` on quit.
 */

import { app, Menu, Tray, nativeImage, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';

export interface InitTrayOptions {
  /** Resolver for the main window. Called on click to toggle visibility. */
  getMainWindow: () => BrowserWindow | null;
  /** Optional: open the Settings window from the context menu. */
  onOpenSettings?: () => void;
  /** Optional: open the Help window from the context menu. */
  onOpenHelp?: () => void;
  /**
   * Optional: open the Spaces window from the context menu. When set,
   * the entry sits alongside Settings / Help so the tray gives
   * one-click access to the three most-used surfaces.
   */
  onOpenSpaces?: () => void;
  /** Optional: quit handler. Defaults to `app.quit()`. */
  onQuit?: () => void;
  /**
   * Optional: disable the idle pulse animation. Defaults to enabled
   * (the icon breathes gently in the menu bar). Set to `false`, or
   * set the `LITE_TRAY_ANIMATION=0` env var, to keep the icon static.
   */
  pulse?: boolean;
  /** Optional logger (defaults to silent). */
  logger?: {
    info: (msg: string, data?: unknown) => void;
    warn: (msg: string, data?: unknown) => void;
    error: (msg: string, data?: unknown) => void;
  };
}

export interface TrayHandle {
  /** Rebuild the context menu (e.g. when handlers change). Idempotent. */
  rebuildMenu(): void;
  /** Start the idle pulse animation. Idempotent. */
  startPulse(): void;
  /** Pause the idle pulse animation (icon stays on the current frame). */
  stopPulse(): void;
  /** Destroy the tray icon. Idempotent. */
  teardown(): void;
}

let activeTray: Tray | null = null;
let activePulseTimer: ReturnType<typeof setInterval> | null = null;
let activePulseFrames: Electron.NativeImage[] | null = null;
let activePulseFrameIndex = 0;

/**
 * Initialize the tray. Returns `null` (and logs a warning) when no tray
 * icon can be found -- the kernel continues to boot without a tray
 * rather than crashing. Returns a handle otherwise.
 */
export function initTray(opts: InitTrayOptions): TrayHandle | null {
  const log = opts.logger ?? {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  if (activeTray !== null && !activeTray.isDestroyed()) {
    log.warn('tray: initTray called twice -- returning existing handle');
    return {
      rebuildMenu: () => rebuildActiveMenu(opts),
      startPulse: () => {
        if (activePulseFrames !== null && activePulseTimer === null && activeTray !== null) {
          runPulseTimer(activeTray);
        }
      },
      stopPulse: () => stopPulseTimer(),
      teardown: () => teardownActive(),
    };
  }

  const iconPath = resolveTrayIconPath();
  if (iconPath === null) {
    log.warn('tray: no tray icon found -- tray not installed', {
      searched: trayIconCandidates(),
    });
    return null;
  }

  let icon: Electron.NativeImage;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      log.warn('tray: tray icon at path is empty / unreadable', { iconPath });
      return null;
    }
  } catch (err) {
    log.error('tray: failed to load tray icon', {
      iconPath,
      error: (err as Error).message,
    });
    return null;
  }

  // macOS template-image handling: if the loaded file is the dedicated
  // template variant (filename ends in `Template.png`), macOS will
  // auto-resize it back to the standard ~22pt menu-bar height
  // regardless of any `.resize()` call we make -- that's how template
  // images work in NSStatusItem. So a "make it bigger" bump only
  // actually takes effect when we load the COLOR source
  // (tray-icon.png) and skip the template flag. Trade-off: the icon
  // doesn't auto-adapt to dark vs light menu bars, but the OneReach
  // mark itself is identifiable in both. We pick the color path on
  // macOS for visible-size; renderers that prefer theme-adapt can
  // override via `LITE_TRAY_TEMPLATE=1` to force the old behavior.
  const isTemplateAsset = /tray-iconTemplate\.png$/i.test(iconPath);
  const forceTemplate = process.env['LITE_TRAY_TEMPLATE'] === '1';
  const useTemplate = isTemplateAsset && (forceTemplate || process.platform !== 'darwin');

  // Resize to the configured size BEFORE setting the template flag.
  // resize() returns a fresh NativeImage with the template flag
  // cleared, so the order matters.
  try {
    icon = icon.resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE });
  } catch (err) {
    log.warn('tray: icon resize failed -- continuing at native size', {
      error: (err as Error).message,
    });
  }

  if (useTemplate) {
    icon.setTemplateImage(true);
  }

  let tray: Tray;
  try {
    tray = new Tray(icon);
  } catch (err) {
    log.error('tray: Tray construction failed', { error: (err as Error).message });
    return null;
  }

  tray.setToolTip(buildTooltip());
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate(opts)));

  // Subtle idle pulse. Pre-computes 4 size-stepped frames and cycles
  // through them every PULSE_FRAME_MS so the icon "breathes" in the
  // menu bar without drawing attention. Pre-computed (not regenerated
  // each tick) so the per-frame cost is just a setImage() call.
  const pulseEnv = process.env['LITE_TRAY_ANIMATION'];
  const pulseEnabled =
    pulseEnv === '0' || pulseEnv === 'false' ? false : opts.pulse !== false;
  if (pulseEnabled) {
    try {
      attachPulse(tray, icon, useTemplate);
    } catch (err) {
      log.warn('tray: pulse animation setup failed -- continuing static', {
        error: (err as Error).message,
      });
    }
  }

  // Left-click toggles main window visibility. macOS routes this
  // through the same handler as Windows / Linux even though Cocoa
  // also pops the menu on click -- the show/hide is the primary UX,
  // the context menu is right-click.
  tray.on('click', () => {
    const win = opts.getMainWindow();
    if (win === null || win.isDestroyed()) return;
    if (win.isVisible() && !win.isMinimized()) {
      win.hide();
    } else {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  activeTray = tray;
  log.info('tray: initialized', {
    iconPath,
    templateImage: useTemplate,
    pulseEnabled,
  });

  return {
    rebuildMenu: () => rebuildActiveMenu(opts),
    startPulse: () => {
      if (activePulseFrames === null) {
        // Rebuild frames against the current icon if pulse was off
        // at boot. Best-effort: this path is rare (initial pulse=false
        // followed by an explicit startPulse call).
        try {
          attachPulse(tray, icon, useTemplate);
        } catch {
          /* ignore -- pulse stays off */
        }
      } else if (activePulseTimer === null) {
        runPulseTimer(tray);
      }
    },
    stopPulse: () => stopPulseTimer(),
    teardown: () => teardownActive(),
  };
}

function rebuildActiveMenu(opts: InitTrayOptions): void {
  if (activeTray === null || activeTray.isDestroyed()) return;
  activeTray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate(opts)));
}

function teardownActive(): void {
  stopPulseTimer();
  activePulseFrames = null;
  activePulseFrameIndex = 0;
  if (activeTray !== null && !activeTray.isDestroyed()) {
    try {
      activeTray.destroy();
    } catch {
      /* best-effort teardown */
    }
  }
  activeTray = null;
}

// ─── Pulse animation ────────────────────────────────────────────────────

/**
 * One pulse cycle: 4 frames stepping through small / smaller / small /
 * larger relative to the base size, so the icon "inhales" and
 * "exhales" gently. Edge length deltas of ±2pt keep the swing
 * imperceptible-but-alive. With PULSE_FRAME_MS at 600 and 4 frames the
 * full cycle is 2.4s -- slow enough to feel calming rather than busy.
 */
const PULSE_FRAME_MS = 600;
const PULSE_DELTAS = [-1, -2, -1, 1] as const;

/**
 * Pre-compute resized pulse frames once and start the swap timer.
 * The frames stay cached on the module-level state so each tick only
 * needs a `Tray.setImage()` call.
 */
function attachPulse(
  tray: Tray,
  baseIcon: Electron.NativeImage,
  applyTemplate: boolean
): void {
  const frames = buildPulseFrames(baseIcon, applyTemplate);
  if (frames.length === 0) return;
  activePulseFrames = frames;
  activePulseFrameIndex = 0;
  runPulseTimer(tray);
}

function runPulseTimer(tray: Tray): void {
  stopPulseTimer();
  activePulseTimer = setInterval(() => {
    if (activePulseFrames === null) return;
    if (activeTray === null || activeTray.isDestroyed()) {
      stopPulseTimer();
      return;
    }
    activePulseFrameIndex = (activePulseFrameIndex + 1) % activePulseFrames.length;
    const next = activePulseFrames[activePulseFrameIndex];
    if (next !== undefined) {
      try {
        tray.setImage(next);
      } catch {
        /* tray may be torn down between checks; best-effort */
      }
    }
  }, PULSE_FRAME_MS);
}

function stopPulseTimer(): void {
  if (activePulseTimer !== null) {
    clearInterval(activePulseTimer);
    activePulseTimer = null;
  }
}

/**
 * Build the pulse frames from a base NativeImage. Pure (no side
 * effects) so unit tests can pin the output shape. Each frame is the
 * base resized by `(TRAY_ICON_SIZE + delta)` for one entry in
 * `PULSE_DELTAS`. On macOS the template flag is re-applied per frame
 * because `NativeImage.resize()` returns a fresh image with the
 * template flag cleared.
 */
export function buildPulseFrames(
  baseIcon: Electron.NativeImage,
  applyTemplate: boolean
): Electron.NativeImage[] {
  const out: Electron.NativeImage[] = [];
  for (const delta of PULSE_DELTAS) {
    let frame: Electron.NativeImage;
    try {
      frame = baseIcon.resize({
        width: TRAY_ICON_SIZE + delta,
        height: TRAY_ICON_SIZE + delta,
      });
    } catch {
      continue;
    }
    if (applyTemplate) {
      try {
        frame.setTemplateImage(true);
      } catch {
        /* best-effort -- non-fatal */
      }
    }
    out.push(frame);
  }
  return out;
}

// ─── Pure helpers (testable without Electron Tray) ──────────────────────

/** Static base portion of the tooltip; combined with the version by `buildTooltip()`. */
export const TRAY_TOOLTIP_BASE = 'Onereach.ai Lite' as const;

/**
 * Backwards-compatible static tooltip. Retained as a const so the
 * existing test file's `TRAY_TOOLTIP` assertions keep passing; new
 * call sites should prefer the dynamic `buildTooltip()` below.
 */
export const TRAY_TOOLTIP = TRAY_TOOLTIP_BASE;

/**
 * Compose the tray tooltip. Format: `Onereach.ai Lite v<version>`.
 * The version is read from `app.getVersion()` each time the tooltip
 * is built so an in-place upgrade is reflected next time the tooltip
 * is set (no need to recompute on every hover -- the OS caches it).
 *
 * Falls back to the static base when `app` isn't accessible (e.g. in
 * a vitest environment where Electron is partially shimmed).
 */
export function buildTooltip(): string {
  let version: string | null = null;
  try {
    const v = app.getVersion?.();
    if (typeof v === 'string' && v.length > 0) version = v;
  } catch {
    /* best-effort -- fall through to base */
  }
  return version !== null ? `${TRAY_TOOLTIP_BASE} v${version}` : TRAY_TOOLTIP_BASE;
}

/**
 * Source-image edge length we pass to NativeImage.resize() before
 * handing the icon to Tray, in points.
 *
 * On macOS, NSStatusItem auto-fits the icon to the menu bar's visible
 * content area (~22pt on Sequoia / Sonoma) regardless of the source
 * size, so this primarily sets the aspect ratio. The user-visible
 * "bigger" effect comes from preferring the full-color 1024x1024
 * `tray-icon.png` over the dedicated 22x22 template silhouette: the
 * color source has the OneReach mark filling more of its canvas, so
 * after macOS auto-fits to ~22pt the rendered glyph feels denser and
 * more present in the menu bar.
 *
 * On Windows / Linux the tray slot is larger and the icon renders
 * close to this size literally, so the value also serves as a sane
 * "looks at home" target on those platforms.
 */
export const TRAY_ICON_SIZE = 30 as const;

/**
 * Build the tray context menu template. Pure -- no Electron Tray
 * construction. Separated so tests can assert the structure without
 * running Electron.
 *
 * Order is fixed:
 *   1. Show / Hide (toggle main window)
 *   2. ─── separator ───
 *   3. Spaces / Settings / Help (when provided)
 *   4. ─── separator ───
 *   5. Quit
 *
 * Entries whose handlers aren't provided are omitted; the surrounding
 * separators stay so the structure reads consistently regardless of
 * which optional entries are wired.
 */
export function buildTrayMenuTemplate(
  opts: InitTrayOptions
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];
  template.push({
    label: 'Show Onereach.ai Lite',
    click: () => {
      const win = opts.getMainWindow();
      if (win === null || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    },
  });
  template.push({
    label: 'Hide Onereach.ai Lite',
    click: () => {
      const win = opts.getMainWindow();
      if (win === null || win.isDestroyed()) return;
      if (win.isVisible()) win.hide();
    },
  });
  template.push({ type: 'separator' });
  if (opts.onOpenSpaces !== undefined) {
    template.push({ label: 'Spaces…', click: opts.onOpenSpaces });
  }
  if (opts.onOpenSettings !== undefined) {
    template.push({ label: 'Settings…', click: opts.onOpenSettings });
  }
  if (opts.onOpenHelp !== undefined) {
    template.push({ label: 'Onereach.ai Lite Help', click: opts.onOpenHelp });
  }
  template.push({ type: 'separator' });
  template.push({
    label: 'Quit Onereach.ai Lite',
    click: opts.onQuit ?? ((): void => app.quit()),
  });
  return template;
}

/**
 * Candidate paths the tray icon loader probes, in priority order.
 * Exposed so the no-icon-found warning can list what was searched.
 *
 * Priority depends on platform + the `LITE_TRAY_TEMPLATE` env var:
 *   - macOS (default): prefer the FULL-COLOR `tray-icon.png`. macOS
 *     auto-resizes template images back to ~22pt regardless of any
 *     `.resize()` call, so the color source is the only path that
 *     respects the configured `TRAY_ICON_SIZE`.
 *   - macOS (`LITE_TRAY_TEMPLATE=1`): prefer the template variant.
 *     Restores theme-adaptive rendering at the menu bar's default
 *     22pt height (smaller, but adapts to dark / light bars).
 *   - Windows / Linux: prefer the template-named asset (smaller
 *     pixel footprint, no theme constraint) and fall back to color.
 */
export function trayIconCandidates(): string[] {
  const isMac = process.platform === 'darwin';
  const forceTemplate = process.env['LITE_TRAY_TEMPLATE'] === '1';
  const preferColor = isMac && !forceTemplate;
  const candidates: string[] = [];
  // esbuild-copied siblings in dist-lite/build/ first.
  if (preferColor) {
    candidates.push(path.join(__dirname, 'tray-icon.png'));
    candidates.push(path.join(__dirname, 'tray-iconTemplate.png'));
  } else {
    candidates.push(path.join(__dirname, 'tray-iconTemplate.png'));
    candidates.push(path.join(__dirname, 'tray-icon.png'));
  }
  // <appPath>/assets/ fallback -- works in both dev and packaged
  // builds because electron-builder includes the assets directory
  // by default (it's not in the `files` exclusion list).
  let appPath: string;
  try {
    appPath = app.getAppPath();
  } catch {
    appPath = path.resolve(__dirname, '..', '..');
  }
  if (preferColor) {
    candidates.push(path.join(appPath, 'assets', 'tray-icon.png'));
    candidates.push(path.join(appPath, 'assets', 'tray-iconTemplate.png'));
  } else {
    candidates.push(path.join(appPath, 'assets', 'tray-iconTemplate.png'));
    candidates.push(path.join(appPath, 'assets', 'tray-icon.png'));
  }
  return candidates;
}

/**
 * Resolve the best tray icon path. Returns `null` when nothing is
 * available so the caller can degrade gracefully (warn + skip tray
 * install) instead of crashing the kernel.
 */
export function resolveTrayIconPath(): string | null {
  for (const candidate of trayIconCandidates()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* probe failed; try next */
    }
  }
  return null;
}

/** @internal -- for tests */
export function _hasActiveTrayForTesting(): boolean {
  return activeTray !== null && !activeTray.isDestroyed();
}

/** @internal -- for tests */
export function _resetTrayForTesting(): void {
  teardownActive();
}
