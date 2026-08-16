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
  /**
   * Optional: open the Report a Bug modal from the context menu.
   *
   * The tray is the ONE surface that is still reachable when the app is
   * misbehaving -- a window that won't load, a login that spins, a main
   * window hidden behind a broken state. Those are exactly the moments
   * a user wants to file a bug, and until now the only entry point was
   * the Help menu, which needs a functioning window to reach.
   */
  onReportBug?: () => void;
  /** Optional: quit handler. Defaults to `app.quit()`. */
  onQuit?: () => void;
  /**
   * Optional: enable the idle pulse animation. Defaults to DISABLED.
   *
   * The pulse works by swapping size-stepped frames, and a menu-bar
   * item's width tracks its image width -- so a breathing icon visibly
   * jitters AND shoves every neighbouring status item (Claude, Wi-Fi,
   * clock) sideways on each frame. That's the bug this default fixes.
   * It also runs against macOS convention: a status item should be
   * static unless it's conveying a state change.
   *
   * Set to `true`, or set `LITE_TRAY_ANIMATION=1`, to opt back in.
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

  // macOS template-image handling. A template image is pure black + alpha;
  // macOS tints it per the menu-bar theme (dark-on-light, light-on-dark) so
  // it is ALWAYS legible and never washes out. We default to the template
  // on every platform (it's the correct menu-bar treatment) -- the earlier
  // "prefer the full-color source so it renders bigger" choice made the
  // light-colored mark disappear on a light menu bar, which is the bug this
  // fixes. The trade-off (template auto-fits to ~22pt, so it can't be made
  // arbitrarily larger) is the right one for a status item. Set
  // `LITE_TRAY_COLOR=1` to force the old full-color path.
  const isTemplateAsset = /tray-iconTemplate\.png$/i.test(iconPath);
  // The template flag is meaningful only on macOS; on Windows/Linux it's a
  // harmless no-op. Apply it whenever we actually loaded the template asset.
  const useTemplate = isTemplateAsset;

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

  // Idle pulse -- OFF by default, opt-in only. The frames are
  // size-stepped, and a menu-bar item's width follows its image width,
  // so the animation made our icon jitter and pushed neighbouring
  // status items (Claude, Wi-Fi, clock) around ~1.7x/second. A status
  // item should sit still unless it's signalling a state change.
  const pulseEnabled = isPulseEnabled(process.env['LITE_TRAY_ANIMATION'], opts.pulse);
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
 * Should the idle pulse run? **Default: NO.**
 *
 * Pulse frames are size-stepped, and a macOS menu-bar item's width
 * tracks its image width — so an animating icon jitters in place AND
 * shoves every neighbouring status item sideways on each frame (the
 * user-reported "flashing and moving with Claude beside it"). It is
 * opt-in only: `LITE_TRAY_ANIMATION=1` (or `pulse: true`).
 *
 * Exported so the default is pinned by a test rather than by comment.
 */
export function isPulseEnabled(envValue: string | undefined, optsPulse?: boolean): boolean {
  if (envValue === '1' || envValue === 'true') return true;
  return optsPulse === true;
}

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
export const TRAY_TOOLTIP_BASE = 'WISER' as const;

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
    // Dev (`npm run lite`): app.getVersion() returns ELECTRON's own
    // version (e.g. "41.2.1") because no app package.json overrides it.
    // Read lite/package.json instead so the tray header shows the real
    // product version in both modes. (Driven-release-pass nit,
    // 2026-08-05.) Packaged builds get the right value from
    // electron-builder's extraMetadata, so getVersion() is correct there.
    if (app.isPackaged !== true) {
      version = readDevLiteVersion();
    }
    if (version === null) {
      const v = app.getVersion?.();
      if (typeof v === 'string' && v.length > 0) version = v;
    }
  } catch {
    /* best-effort -- fall through to base */
  }
  return version !== null ? `${TRAY_TOOLTIP_BASE} v${version}` : TRAY_TOOLTIP_BASE;
}

/** Cached dev-mode version from lite/package.json (null = unresolved). */
let _devLiteVersion: string | null | undefined;

function readDevLiteVersion(): string | null {
  if (_devLiteVersion !== undefined) return _devLiteVersion;
  _devLiteVersion = null;
  // `electron dist-lite/build/main-lite.js` is launched from the repo
  // root, so appPath is either the root (getAppPath falls back to CWD)
  // or the bundle dir -- probe both shapes.
  let appPath: string;
  try {
    appPath = app.getAppPath();
  } catch {
    appPath = process.cwd();
  }
  for (const candidate of [
    path.join(appPath, 'lite', 'package.json'),
    path.join(appPath, '..', '..', 'lite', 'package.json'),
  ]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version.length > 0) {
        _devLiteVersion = parsed.version;
        break;
      }
    } catch {
      /* try next candidate */
    }
  }
  return _devLiteVersion;
}

/**
 * Source-image edge length we pass to NativeImage.resize() before
 * handing the icon to Tray, in points.
 *
 * On macOS, NSStatusItem auto-fits a template image to the menu bar's
 * visible content area (~22pt on Sequoia / Sonoma) regardless of the
 * source size, so this primarily sets the aspect ratio and keeps the
 * mark crisp before the OS tints it. On Windows / Linux the tray slot
 * is larger and the icon renders close to this size literally.
 *
 * On Windows / Linux the tray slot is larger and the icon renders
 * close to this size literally, so the value also serves as a sane
 * "looks at home" target on those platforms.
 */
export const TRAY_ICON_SIZE = 22 as const;

/**
 * Build the tray context menu template. Pure -- no Electron Tray
 * construction. Separated so tests can assert the structure without
 * running Electron.
 *
 * Order is fixed:
 *   1. Header caption: "Onereach.ai Lite v<version>" (disabled)
 *   2. ─── separator ───
 *   3. Show / Hide (toggle main window)
 *   4. ─── separator ───
 *   5. Spaces / Settings / Help (when provided)
 *   6. ─── separator ───
 *   7. Quit
 *
 * Entries whose handlers aren't provided are omitted; the surrounding
 * separators stay so the structure reads consistently regardless of
 * which optional entries are wired.
 */
export function buildTrayMenuTemplate(
  opts: InitTrayOptions
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];
  // Header caption so the tray menu itself identifies the app + version
  // ("Onereach.ai Lite v0.0.19") -- the version is otherwise only on the
  // hover tooltip. Disabled so it reads as a label, not a clickable item.
  template.push({ label: buildTooltip(), enabled: false });
  template.push({ type: 'separator' });
  template.push({
    label: 'Show WISER',
    click: () => {
      const win = opts.getMainWindow();
      if (win === null || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    },
  });
  template.push({
    label: 'Hide WISER',
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
    template.push({ label: 'WISER Help', click: opts.onOpenHelp });
  }
  if (opts.onReportBug !== undefined) {
    template.push({ label: 'Report a Bug…', click: opts.onReportBug });
  }
  template.push({ type: 'separator' });
  template.push({
    label: 'Quit WISER',
    click: opts.onQuit ?? ((): void => app.quit()),
  });
  return template;
}

/**
 * Candidate paths the tray icon loader probes, in priority order.
 * Exposed so the no-icon-found warning can list what was searched.
 *
 * Default (all platforms): prefer the monochrome `tray-iconTemplate.png`.
 * On macOS it's tinted to the menu-bar theme so it never washes out; on
 * Windows / Linux it's a clean small-footprint mark. The full-color
 * `tray-icon.png` is the fallback, or can be forced with
 * `LITE_TRAY_COLOR=1` (trades theme-adaptation for a larger glyph -- only
 * advisable on a menu bar whose theme you control).
 */
export function trayIconCandidates(): string[] {
  const forceColor = process.env['LITE_TRAY_COLOR'] === '1';
  const preferColor = forceColor;
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
