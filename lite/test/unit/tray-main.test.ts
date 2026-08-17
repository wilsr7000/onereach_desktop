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
  isPulseEnabled,
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
  it('reads "WISER" verbatim', () => {
    expect(TRAY_TOOLTIP).toBe('WISER');
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
      expect(tt).toMatch(/^WISER v\S+$/);
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
    expect(labels).toContain('Show WISER');
    expect(labels).toContain('Hide WISER');
    expect(labels).toContain('Quit WISER');
  });

  // The tray is the only surface still reachable when a window won't
  // load or a login spins -- which is exactly when someone wants to
  // file a bug. Before this, the sole entry point was the Help menu,
  // which needs a working window to reach.
  it('offers Report a Bug when a handler is supplied, and wires it', () => {
    let clicked = 0;
    const template = buildTrayMenuTemplate({
      getMainWindow: (() => null) as GetMain as () => never,
      onReportBug: () => {
        clicked += 1;
      },
    });
    const entry = template.find((t) => t.label === 'Report a Bug…');
    expect(entry, 'tray must expose a bug-report entry point').toBeDefined();
    (entry?.click as (() => void) | undefined)?.();
    expect(clicked).toBe(1);
  });

  it('omits Report a Bug when no handler is supplied', () => {
    const template = buildTrayMenuTemplate({
      getMainWindow: (() => null) as GetMain as () => never,
    });
    expect(template.some((t) => t.label === 'Report a Bug…')).toBe(false);
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
    expect(labels).not.toContain('WISER Help');
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
    // First labeled item is the version header caption (dynamic version).
    expect(labels[0]).toMatch(/^WISER( v\S+)?$/);
    expect(labels.slice(1)).toEqual([
      'Show WISER',
      'Hide WISER',
      'Spaces…',
      'Settings…',
      'WISER Help',
      'Quit WISER',
    ]);
  });

  it('places separators around the optional cluster (consistent shape)', () => {
    const template = buildTrayMenuTemplate({
      getMainWindow: (() => null) as GetMain as () => never,
      onOpenSettings: vi.fn(),
    });
    // Structure: [Header, sep, Show, Hide, sep, Settings…, sep, Quit]
    expect(template).toHaveLength(8);
    expect(template[0]?.enabled).toBe(false);
    expect(template[0]?.label).toMatch(/^WISER/);
    expect(template[1]?.type).toBe('separator');
    expect(template[2]?.label).toBe('Show WISER');
    expect(template[4]?.type).toBe('separator');
    expect(template[5]?.label).toBe('Settings…');
    expect(template[6]?.type).toBe('separator');
    expect(template[7]?.label).toBe('Quit WISER');
  });

  it('still emits both separators even when no optional entries are wired', () => {
    // Documents the "two separators with nothing between" case --
    // the surrounding structure stays consistent so the renderer
    // doesn't have to special-case the empty middle.
    const template = buildTrayMenuTemplate({
      getMainWindow: (() => null) as GetMain as () => never,
    });
    // Structure: [Header, sep, Show, Hide, sep, sep, Quit]
    expect(template).toHaveLength(7);
    expect(template[4]?.type).toBe('separator');
    expect(template[5]?.type).toBe('separator');
  });

  it('Show handler restores + shows + focuses the main window', () => {
    const win = makeFakeWin({ visible: false, minimized: true });
    const template = buildTrayMenuTemplate({
      getMainWindow: (() => win) as GetMain as () => never,
    });
    clickByLabel(template, 'Show WISER');
    expect(win.minimized).toBe(false);
    expect(win.visible).toBe(true);
  });

  it('Show handler no-ops when no main window exists', () => {
    const template = buildTrayMenuTemplate({
      getMainWindow: (() => null) as GetMain as () => never,
    });
    // Should not throw.
    expect(() => clickByLabel(template, 'Show WISER')).not.toThrow();
  });

  it('Show handler no-ops when the main window has been destroyed', () => {
    const win = makeFakeWin({ destroyed: true });
    const template = buildTrayMenuTemplate({
      getMainWindow: (() => win) as GetMain as () => never,
    });
    expect(() => clickByLabel(template, 'Show WISER')).not.toThrow();
    expect(win.visible).toBe(false);
  });

  it('Hide handler hides the window only when currently visible', () => {
    const win = makeFakeWin({ visible: true });
    const template = buildTrayMenuTemplate({
      getMainWindow: (() => win) as GetMain as () => never,
    });
    clickByLabel(template, 'Hide WISER');
    expect(win.visible).toBe(false);
  });

  it('Hide handler is a no-op when window is already hidden', () => {
    const win = makeFakeWin({ visible: false });
    const template = buildTrayMenuTemplate({
      getMainWindow: (() => win) as GetMain as () => never,
    });
    expect(() => clickByLabel(template, 'Hide WISER')).not.toThrow();
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
    clickByLabel(template, 'WISER Help');
    expect(onOpenHelp).toHaveBeenCalledTimes(1);
  });

  it('Quit invokes the supplied handler when given', () => {
    const onQuit = vi.fn();
    const template = buildTrayMenuTemplate({
      getMainWindow: (() => null) as GetMain as () => never,
      onQuit,
    });
    clickByLabel(template, 'Quit WISER');
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
    const quitItem = template.find((t) => t.label === 'Quit WISER');
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
    // First two are dist-lite/build template siblings: the pre-sized 22pt
    // asset (full-app parity) then the 44px template.
    const firstTwo = candidates.slice(0, 2);
    expect(firstTwo.some((p) => /tray-icon-22Template\.png$/.test(p))).toBe(true);
    expect(firstTwo.some((p) => /tray-iconTemplate\.png$/.test(p))).toBe(true);
  });

  it('includes an <appPath>/assets fallback after the dist-lite siblings', () => {
    const candidates = trayIconCandidates();
    const fromAssets = candidates.filter((p) => p.includes('assets/') || p.includes('assets\\'));
    expect(fromAssets.length).toBeGreaterThanOrEqual(1);
  });

  it('prefers the monochrome template first (every platform) so it never washes out', () => {
    // The template is tinted to the menu-bar theme on macOS (dark-on-light,
    // light-on-dark), so it stays legible on any bar -- the fix for the
    // washed-out color mark on a light menu bar.
    const candidates = trayIconCandidates();
    // The pre-sized 22pt template — the exact asset the full app renders.
    expect(candidates[0]).toMatch(/tray-icon-22Template\.png$/);
  });

  it('LITE_TRAY_COLOR=1 forces the full-color tray-icon.png to the front', () => {
    const prev = process.env['LITE_TRAY_COLOR'];
    process.env['LITE_TRAY_COLOR'] = '1';
    try {
      const candidates = trayIconCandidates();
      expect(candidates[0]).toMatch(/tray-icon\.png$/);
      expect(candidates[0]).not.toMatch(/Template/);
    } finally {
      if (prev === undefined) delete process.env['LITE_TRAY_COLOR'];
      else process.env['LITE_TRAY_COLOR'] = prev;
    }
  });
});

describe('isPulseEnabled -- idle animation defaults OFF', () => {
  // Regression guard: the pulse swaps SIZE-STEPPED frames, and a
  // macOS menu-bar item's width follows its image width -- so an
  // animating tray icon jitters and pushes neighbouring status items
  // (Claude, Wi-Fi, clock) sideways on every frame. It must stay
  // opt-in; this test is what keeps the default honest.
  it('is OFF with no env var and no explicit option', () => {
    expect(isPulseEnabled(undefined, undefined)).toBe(false);
  });

  it('is OFF for an unset / empty / unrelated env value', () => {
    expect(isPulseEnabled('', undefined)).toBe(false);
    expect(isPulseEnabled('0', undefined)).toBe(false);
    expect(isPulseEnabled('false', undefined)).toBe(false);
    expect(isPulseEnabled('yes-please', undefined)).toBe(false);
  });

  it('turns ON only via explicit opt-in (env=1/true or pulse:true)', () => {
    expect(isPulseEnabled('1', undefined)).toBe(true);
    expect(isPulseEnabled('true', undefined)).toBe(true);
    expect(isPulseEnabled(undefined, true)).toBe(true);
  });

  it('an explicit pulse:false is never overridden into ON by absence of env', () => {
    expect(isPulseEnabled(undefined, false)).toBe(false);
    expect(isPulseEnabled('0', false)).toBe(false);
  });
});
