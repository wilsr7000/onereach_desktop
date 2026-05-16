/**
 * Unit tests for lite/tray/main.ts.
 *
 * Exercises the pure menu-template builder without constructing a
 * real `Tray` (which requires a running Electron event loop). Asserts:
 *   - label ordering: Show / Hide first, Quit last
 *   - optional Spaces / Settings / Help entries appear when handlers
 *     are wired and are omitted otherwise
 *   - separators are placed consistently regardless of which optional
 *     entries are included
 *   - the Show / Hide handlers no-op when the main window is null
 *     or destroyed (defensive defaults)
 *   - the default Quit handler falls back to `app.quit()`
 */

import { describe, it, expect, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import {
  buildTrayMenuTemplate,
  trayIconCandidates,
  TRAY_TOOLTIP,
  TRAY_TOOLTIP_BASE,
  TRAY_ICON_SIZE,
  buildPulseFrames,
  buildTooltip,
} from '../../tray/main.js';

// Lightweight stand-in for Electron's BrowserWindow used by the
// menu-builder tests. We only need the methods the click handlers
// actually touch.
interface FakeWin {
  destroyed: boolean;
  visible: boolean;
  minimized: boolean;
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  show(): void;
  hide(): void;
  focus(): void;
  restore(): void;
}

function makeFakeWin(overrides: Partial<FakeWin> = {}): FakeWin {
  const state = {
    destroyed: false,
    visible: false,
    minimized: false,
    ...overrides,
  };
  return {
    get destroyed() {
      return state.destroyed;
    },
    set destroyed(v) {
      state.destroyed = v;
    },
    get visible() {
      return state.visible;
    },
    set visible(v) {
      state.visible = v;
    },
    get minimized() {
      return state.minimized;
    },
    set minimized(v) {
      state.minimized = v;
    },
    isDestroyed: () => state.destroyed,
    isVisible: () => state.visible,
    isMinimized: () => state.minimized,
    show: () => {
      state.visible = true;
    },
    hide: () => {
      state.visible = false;
    },
    focus: () => {
      /* no-op */
    },
    restore: () => {
      state.minimized = false;
    },
  };
}

/**
 * The menu-builder casts `getMainWindow` to `BrowserWindow | null`;
 * the fake satisfies the subset of methods touched at click time.
 */
type GetMain = () => unknown;

function clickByLabel(
  template: MenuItemConstructorOptions[],
  label: string
): void {
  const item = template.find((t) => t.label === label);
  if (item === undefined) throw new Error(`menu item not found: ${label}`);
  const click = item.click;
  expect(typeof click).toBe('function');
  (click as () => void)();
}

describe('TRAY_TOOLTIP', () => {
  it('reads "Onereach.ai Lite" verbatim', () => {
    expect(TRAY_TOOLTIP).toBe('Onereach.ai Lite');
  });

  it('shares its value with TRAY_TOOLTIP_BASE (static base for dynamic tooltips)', () => {
    expect(TRAY_TOOLTIP_BASE).toBe(TRAY_TOOLTIP);
  });
});

describe('buildTooltip', () => {
  it('returns a string starting with the static base', () => {
    const tt = buildTooltip();
    expect(typeof tt).toBe('string');
    expect(tt.startsWith(TRAY_TOOLTIP_BASE)).toBe(true);
  });

  it('falls back to the static base when no version is available', () => {
    // Under vitest the Electron `app` module's getVersion may be a no-op
    // or undefined. The fallback ensures we never produce something
    // like "Onereach.ai Lite vundefined" -- if version resolution
    // fails, we return the static base unchanged.
    const tt = buildTooltip();
    // Either it's the static base alone, OR it's "<base> v<something
    // non-empty>". Both are acceptable; the assertion below proves we
    // never produce an empty or malformed "v" suffix.
    if (tt !== TRAY_TOOLTIP_BASE) {
      expect(tt).toMatch(/^Onereach\.ai Lite v\S+$/);
    }
  });
});

describe('buildTrayMenuTemplate', () => {
  it('always includes Show, Hide, and Quit', () => {
    const template = buildTrayMenuTemplate({
      getMainWindow: (() => null) as GetMain as () => never,
    });
    const labels = template
      .map((t) => t.label)
      .filter((l): l is string => typeof l === 'string');
    expect(labels).toContain('Show Onereach.ai Lite');
    expect(labels).toContain('Hide Onereach.ai Lite');
    expect(labels).toContain('Quit Onereach.ai Lite');
  });

  it('omits Spaces / Settings / Help when no handler is provided', () => {
    const template = buildTrayMenuTemplate({
      getMainWindow: (() => null) as GetMain as () => never,
    });
    const labels = template
      .map((t) => t.label)
      .filter((l): l is string => typeof l === 'string');
    expect(labels).not.toContain('Spaces…');
    expect(labels).not.toContain('Settings…');
    expect(labels).not.toContain('Onereach.ai Lite Help');
  });

  it('includes each optional entry only when its handler is provided', () => {
    const onOpenSpaces = vi.fn();
    const onOpenSettings = vi.fn();
    const onOpenHelp = vi.fn();
    const template = buildTrayMenuTemplate({
      getMainWindow: (() => null) as GetMain as () => never,
      onOpenSpaces,
      onOpenSettings,
      onOpenHelp,
    });
    const labels = template
      .map((t) => t.label)
      .filter((l): l is string => typeof l === 'string');
    expect(labels).toEqual([
      'Show Onereach.ai Lite',
      'Hide Onereach.ai Lite',
      'Spaces…',
      'Settings…',
      'Onereach.ai Lite Help',
      'Quit Onereach.ai Lite',
    ]);
  });

  it('places separators around the optional cluster (consistent shape)', () => {
    const template = buildTrayMenuTemplate({
      getMainWindow: (() => null) as GetMain as () => never,
      onOpenSettings: vi.fn(),
    });
    // Structure: [Show, Hide, sep, Settings…, sep, Quit]
    expect(template).toHaveLength(6);
    expect(template[2]?.type).toBe('separator');
    expect(template[3]?.label).toBe('Settings…');
    expect(template[4]?.type).toBe('separator');
    expect(template[5]?.label).toBe('Quit Onereach.ai Lite');
  });

  it('still emits both separators even when no optional entries are wired', () => {
    // Documents the "two separators with nothing between" case --
    // the surrounding structure stays consistent so the renderer
    // doesn't have to special-case the empty middle.
    const template = buildTrayMenuTemplate({
      getMainWindow: (() => null) as GetMain as () => never,
    });
    expect(template).toHaveLength(5);
    expect(template[2]?.type).toBe('separator');
    expect(template[3]?.type).toBe('separator');
  });

  it('Show handler restores + shows + focuses the main window', () => {
    const win = makeFakeWin({ visible: false, minimized: true });
    const template = buildTrayMenuTemplate({
      getMainWindow: (() => win) as GetMain as () => never,
    });
    clickByLabel(template, 'Show Onereach.ai Lite');
    expect(win.minimized).toBe(false);
    expect(win.visible).toBe(true);
  });

  it('Show handler no-ops when no main window exists', () => {
    const template = buildTrayMenuTemplate({
      getMainWindow: (() => null) as GetMain as () => never,
    });
    // Should not throw.
    expect(() => clickByLabel(template, 'Show Onereach.ai Lite')).not.toThrow();
  });

  it('Show handler no-ops when the main window has been destroyed', () => {
    const win = makeFakeWin({ destroyed: true });
    const template = buildTrayMenuTemplate({
      getMainWindow: (() => win) as GetMain as () => never,
    });
    expect(() => clickByLabel(template, 'Show Onereach.ai Lite')).not.toThrow();
    expect(win.visible).toBe(false);
  });

  it('Hide handler hides the window only when currently visible', () => {
    const win = makeFakeWin({ visible: true });
    const template = buildTrayMenuTemplate({
      getMainWindow: (() => win) as GetMain as () => never,
    });
    clickByLabel(template, 'Hide Onereach.ai Lite');
    expect(win.visible).toBe(false);
  });

  it('Hide handler is a no-op when window is already hidden', () => {
    const win = makeFakeWin({ visible: false });
    const template = buildTrayMenuTemplate({
      getMainWindow: (() => win) as GetMain as () => never,
    });
    expect(() => clickByLabel(template, 'Hide Onereach.ai Lite')).not.toThrow();
    expect(win.visible).toBe(false);
  });

  it('Spaces / Settings / Help click handlers fire the supplied callback', () => {
    const onOpenSpaces = vi.fn();
    const onOpenSettings = vi.fn();
    const onOpenHelp = vi.fn();
    const template = buildTrayMenuTemplate({
      getMainWindow: (() => null) as GetMain as () => never,
      onOpenSpaces,
      onOpenSettings,
      onOpenHelp,
    });
    clickByLabel(template, 'Spaces…');
    expect(onOpenSpaces).toHaveBeenCalledTimes(1);
    clickByLabel(template, 'Settings…');
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    clickByLabel(template, 'Onereach.ai Lite Help');
    expect(onOpenHelp).toHaveBeenCalledTimes(1);
  });

  it('Quit invokes the supplied handler when given', () => {
    const onQuit = vi.fn();
    const template = buildTrayMenuTemplate({
      getMainWindow: (() => null) as GetMain as () => never,
      onQuit,
    });
    clickByLabel(template, 'Quit Onereach.ai Lite');
    expect(onQuit).toHaveBeenCalledTimes(1);
  });

  it('Quit falls back to a click handler when no custom onQuit is supplied', () => {
    // The default click invokes `app.quit()` -- in production. Under
    // vitest the Electron `app` module is shimmed and calling its
    // `quit()` would throw, so we don't invoke it here. We only
    // assert that a click handler is wired (proving the fallback
    // didn't short-circuit to `undefined`); the real `app.quit()`
    // dispatch is exercised in packaged-build E2E.
    const template = buildTrayMenuTemplate({
      getMainWindow: (() => null) as GetMain as () => never,
    });
    const quitItem = template.find((t) => t.label === 'Quit Onereach.ai Lite');
    expect(quitItem).toBeDefined();
    expect(typeof quitItem?.click).toBe('function');
  });
});

describe('buildPulseFrames', () => {
  // Minimal NativeImage stub: only the methods buildPulseFrames touches.
  // Captures every resize() request so the test can pin the sequence.
  interface ResizeCall {
    width: number;
    height: number;
  }

  function makeStubNativeImage(): {
    resizeCalls: ResizeCall[];
    templateApplications: number;
    image: unknown;
  } {
    const resizeCalls: ResizeCall[] = [];
    let templateApplications = 0;
    const resize = (opts: { width?: number; height?: number }): unknown => {
      // The frame returned from resize() shares this stub's
      // setTemplateImage so the test can count applications across
      // every frame produced.
      resizeCalls.push({
        width: opts.width ?? 0,
        height: opts.height ?? 0,
      });
      return {
        setTemplateImage: () => {
          templateApplications += 1;
        },
      };
    };
    return {
      resizeCalls,
      get templateApplications() {
        return templateApplications;
      },
      image: { resize },
    };
  }

  it('returns 4 frames stepping through small / smaller / small / larger', () => {
    const stub = makeStubNativeImage();
    const frames = buildPulseFrames(
      stub.image as unknown as Electron.NativeImage,
      false
    );
    expect(frames).toHaveLength(4);
    // The pulse sequence -- four sizes centered on TRAY_ICON_SIZE.
    // Exact deltas are internal but we can assert the shape: monotonic
    // breathe down then up, total swing within ±2 of base.
    const sizes = stub.resizeCalls.map((c) => c.width);
    expect(sizes).toHaveLength(4);
    for (const s of sizes) {
      expect(s).toBeGreaterThanOrEqual(TRAY_ICON_SIZE - 2);
      expect(s).toBeLessThanOrEqual(TRAY_ICON_SIZE + 2);
    }
    // The cycle must touch BOTH a smaller and a larger value so the
    // motion is visible as a "breath" rather than a one-way drift.
    expect(Math.min(...sizes)).toBeLessThan(TRAY_ICON_SIZE);
    expect(Math.max(...sizes)).toBeGreaterThan(TRAY_ICON_SIZE);
  });

  it('does NOT apply the template flag when applyTemplate is false', () => {
    const stub = makeStubNativeImage();
    buildPulseFrames(stub.image as unknown as Electron.NativeImage, false);
    expect(stub.templateApplications).toBe(0);
  });

  it('applies the template flag on every frame when applyTemplate is true', () => {
    const stub = makeStubNativeImage();
    const frames = buildPulseFrames(
      stub.image as unknown as Electron.NativeImage,
      true
    );
    expect(stub.templateApplications).toBe(frames.length);
  });

  it('always emits square frames (width === height)', () => {
    const stub = makeStubNativeImage();
    buildPulseFrames(stub.image as unknown as Electron.NativeImage, false);
    for (const call of stub.resizeCalls) {
      expect(call.width).toBe(call.height);
    }
  });

  it('drops a frame silently when resize throws (and keeps the others)', () => {
    let callCount = 0;
    const fragile: unknown = {
      resize: () => {
        callCount += 1;
        if (callCount === 2) throw new Error('synthetic resize failure');
        return { setTemplateImage: () => undefined };
      },
    };
    const frames = buildPulseFrames(
      fragile as unknown as Electron.NativeImage,
      false
    );
    // 4 calls scheduled, 1 throws -- 3 frames survive.
    expect(frames).toHaveLength(3);
  });
});

describe('trayIconCandidates', () => {
  it('lists at least two dist-lite/build/ siblings (template + regular)', () => {
    const candidates = trayIconCandidates();
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    // The first two candidates must be siblings of the bundle
    // (highest-priority lookup path), regardless of ordering.
    const firstTwo = candidates.slice(0, 2);
    expect(firstTwo.some((p) => /tray-iconTemplate\.png$/.test(p))).toBe(true);
    expect(firstTwo.some((p) => /tray-icon\.png$/.test(p))).toBe(true);
  });

  it('includes an <appPath>/assets fallback after the dist-lite siblings', () => {
    const candidates = trayIconCandidates();
    const fromAssets = candidates.filter((p) => p.includes('assets/') || p.includes('assets\\'));
    expect(fromAssets.length).toBeGreaterThanOrEqual(1);
  });

  it('on macOS, prefers the color tray-icon.png so the resize is not clamped by macOS template auto-fit', () => {
    if (process.platform !== 'darwin') return; // platform-specific assertion
    const candidates = trayIconCandidates();
    expect(candidates[0]).toMatch(/tray-icon\.png$/);
    expect(candidates[0]).not.toMatch(/Template/);
  });

  it('on non-macOS, prefers the template-named variant first (no template auto-fit concern)', () => {
    if (process.platform === 'darwin') return; // platform-specific assertion
    const candidates = trayIconCandidates();
    expect(candidates[0]).toMatch(/tray-iconTemplate\.png$/);
  });
});
