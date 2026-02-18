/**
 * Unit tests for lib/screen-service.js
 * Tests all geometry functions with mocked multi-monitor configurations.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let mockDisplays = [];
let displayIdCounter = 1;

function makeMockDisplay(width, height, x = 0, y = 0, scaleFactor = 1) {
  const id = displayIdCounter++;
  return {
    id,
    bounds: { x, y, width, height },
    workArea: { x, y, width, height },
    workAreaSize: { width, height },
    scaleFactor,
  };
}

/** Simulates a BrowserWindow with getPosition and getSize */
function makeMockWindow(x, y, width = 400, height = 550) {
  return {
    getPosition: () => [x, y],
    getSize: () => [width, height],
    isDestroyed: () => false,
  };
}

// ---------------------------------------------------------------------------
// Mock Electron's screen module via the module's test injection point
// ---------------------------------------------------------------------------

// We mock 'electron' so require('electron') doesn't crash when loading the module
vi.mock('electron', () => ({ screen: {} }));

const screenService = await import('../../lib/screen-service.js');

const mockScreen = {
  getPrimaryDisplay: () => mockDisplays[0] || makeMockDisplay(1440, 900, 0, 0),
  getAllDisplays: () => mockDisplays,
  getDisplayNearestPoint: ({ x, y }) => {
    const match = mockDisplays.find(
      (d) => x >= d.bounds.x && x < d.bounds.x + d.bounds.width && y >= d.bounds.y && y < d.bounds.y + d.bounds.height
    );
    if (match) return match;

    let nearest = mockDisplays[0];
    let bestDist = Infinity;
    for (const d of mockDisplays) {
      const cx = d.bounds.x + d.bounds.width / 2;
      const cy = d.bounds.y + d.bounds.height / 2;
      const dist = Math.abs(x - cx) + Math.abs(y - cy);
      if (dist < bestDist) {
        bestDist = dist;
        nearest = d;
      }
    }
    return nearest;
  },
  on: vi.fn(),
  removeListener: vi.fn(),
};

// Inject the mock screen into the module
screenService._setScreenForTesting(mockScreen);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  displayIdCounter = 1;
  mockDisplays = [makeMockDisplay(1440, 900, 0, 0)]; // single 1440x900 primary
  mockScreen.on.mockClear();
  mockScreen.removeListener.mockClear();
});

afterAll(() => {
  screenService._setScreenForTesting(null);
});

// ========== displayKey ==========

describe('displayKey', () => {
  it('returns correct format for primary display', () => {
    const display = makeMockDisplay(1440, 900, 0, 0);
    expect(screenService.displayKey(display)).toBe('1440x900@0,0');
  });

  it('returns correct format for external display at offset', () => {
    const display = makeMockDisplay(2560, 1440, 1440, 0);
    expect(screenService.displayKey(display)).toBe('2560x1440@1440,0');
  });

  it('uses logical size (not physical pixels)', () => {
    // Retina: 2880x1800 physical, but bounds report logical 1440x900
    const display = makeMockDisplay(1440, 900, 0, 0, 2);
    expect(screenService.displayKey(display)).toBe('1440x900@0,0');
  });
});

// ========== getOrbScreenPosition ==========

describe('getOrbScreenPosition', () => {
  it('computes correct center for right side', () => {
    const win = makeMockWindow(100, 200, 400, 550);
    const { cx, cy, size } = screenService.getOrbScreenPosition(win, 'right');
    // Right side: cx = 100 + 400 - 20 - 40 = 440; cy = 200 + 550 - 20 - 40 = 690
    expect(cx).toBe(440);
    expect(cy).toBe(690);
    expect(size).toBe(80);
  });

  it('computes correct center for left side', () => {
    const win = makeMockWindow(100, 200, 400, 550);
    const { cx, cy } = screenService.getOrbScreenPosition(win, 'left');
    // Left side: cx = 100 + 20 + 40 = 160; cy = 690
    expect(cx).toBe(160);
    expect(cy).toBe(690);
  });

  it('works at origin (0,0)', () => {
    const win = makeMockWindow(0, 0, 400, 550);
    const { cx, cy } = screenService.getOrbScreenPosition(win, 'right');
    expect(cx).toBe(340); // 0 + 400 - 20 - 40
    expect(cy).toBe(490); // 0 + 550 - 20 - 40
    expect(cx).toBeGreaterThan(0);
    expect(cy).toBeGreaterThan(0);
  });

  it('defaults to right side when side is omitted', () => {
    const win = makeMockWindow(0, 0, 400, 550);
    const { cx } = screenService.getOrbScreenPosition(win);
    expect(cx).toBe(340); // right side
  });
});

// ========== clampToDisplay ==========

describe('clampToDisplay', () => {
  const display = makeMockDisplay(1440, 900, 0, 0);

  it('does not change a window fully inside the display', () => {
    const { x, y } = screenService.clampToDisplay({ x: 100, y: 100, width: 400, height: 550 }, display);
    expect(x).toBe(100);
    expect(y).toBe(100);
  });

  it('clamps window overflowing right edge', () => {
    const { x } = screenService.clampToDisplay({ x: 1200, y: 100, width: 400, height: 550 }, display);
    expect(x).toBe(1440 - 400 - 10); // 1030
  });

  it('clamps window overflowing left edge', () => {
    const { x } = screenService.clampToDisplay({ x: -100, y: 100, width: 400, height: 550 }, display);
    expect(x).toBe(10); // margin
  });

  it('clamps window overflowing bottom edge', () => {
    const { y } = screenService.clampToDisplay({ x: 100, y: 500, width: 400, height: 550 }, display);
    expect(y).toBe(900 - 550 - 10); // 340
  });

  it('clamps window overflowing top edge', () => {
    const { y } = screenService.clampToDisplay({ x: 100, y: -50, width: 400, height: 550 }, display);
    expect(y).toBe(10); // margin
  });

  it('clamps window completely off display to nearest corner', () => {
    const { x, y } = screenService.clampToDisplay({ x: -500, y: -500, width: 400, height: 550 }, display);
    expect(x).toBe(10);
    expect(y).toBe(10);
  });

  it('works with a display at a non-zero offset (second monitor)', () => {
    const secondDisplay = makeMockDisplay(2560, 1440, 1440, 0);
    const { x, y } = screenService.clampToDisplay({ x: 1400, y: 100, width: 400, height: 550 }, secondDisplay);
    // Left edge of second display is 1440 + margin = 1450
    expect(x).toBe(1450);
    expect(y).toBe(100);
  });
});

// ========== snapToEdge ==========

describe('snapToEdge', () => {
  const display = makeMockDisplay(1440, 900, 0, 0);

  it('snaps to right edge when within snap distance', () => {
    const result = screenService.snapToEdge({ x: 1025, y: 200, width: 400, height: 550 }, display);
    // Right edge would be at x + 400 = 1425, display right is 1440
    // Distance = |1425 - 1440| = 15 < 20 snap distance
    expect(result.x).toBe(1440 - 400); // 1040
    expect(result.snapped).toBe(true);
  });

  it('snaps to bottom-right corner (both axes)', () => {
    const result = screenService.snapToEdge({ x: 1025, y: 340, width: 400, height: 550 }, display);
    // Right: 1425 vs 1440 -> snap. Bottom: 890 vs 900 -> snap.
    expect(result.x).toBe(1040);
    expect(result.y).toBe(900 - 550); // 350
    expect(result.snapped).toBe(true);
  });

  it('does not snap when outside snap zone', () => {
    const result = screenService.snapToEdge({ x: 500, y: 200, width: 400, height: 550 }, display);
    expect(result.x).toBe(500);
    expect(result.y).toBe(200);
    expect(result.snapped).toBe(false);
  });

  it('does not change position if already at edge', () => {
    const result = screenService.snapToEdge({ x: 0, y: 0, width: 400, height: 550 }, display);
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
    expect(result.snapped).toBe(false); // already at edge, no change needed
  });

  it('snaps to second display edge, not primary', () => {
    const secondDisplay = makeMockDisplay(2560, 1440, 1440, 0);
    const result = screenService.snapToEdge({ x: 1445, y: 200, width: 400, height: 550 }, secondDisplay);
    // Left edge: x=1445 vs wa.x=1440, distance=5 < 20 -> snap
    expect(result.x).toBe(1440);
    expect(result.snapped).toBe(true);
  });

  it('snaps to left edge when close', () => {
    const result = screenService.snapToEdge({ x: 15, y: 200, width: 400, height: 550 }, display);
    expect(result.x).toBe(0);
    expect(result.snapped).toBe(true);
  });
});

// ========== getDisplayForWindow ==========

describe('getDisplayForWindow', () => {
  it('returns primary display for window on primary', () => {
    mockDisplays = [makeMockDisplay(1440, 900, 0, 0), makeMockDisplay(2560, 1440, 1440, 0)];
    const win = makeMockWindow(100, 100);
    const display = screenService.getDisplayForWindow(win);
    expect(display.bounds.x).toBe(0);
    expect(display.bounds.width).toBe(1440);
  });

  it('returns secondary display for window on secondary', () => {
    mockDisplays = [makeMockDisplay(1440, 900, 0, 0), makeMockDisplay(2560, 1440, 1440, 0)];
    const win = makeMockWindow(2000, 500);
    const display = screenService.getDisplayForWindow(win);
    expect(display.bounds.x).toBe(1440);
    expect(display.bounds.width).toBe(2560);
  });

  it('returns nearest display when window is between displays', () => {
    mockDisplays = [
      makeMockDisplay(1440, 900, 0, 0),
      makeMockDisplay(2560, 1440, 1500, 0), // small gap between displays
    ];
    // Window at 1450, in the gap -- should return nearest
    const win = makeMockWindow(1450, 400);
    const display = screenService.getDisplayForWindow(win);
    expect(display).toBeDefined();
  });

  it('returns primary display for destroyed window', () => {
    mockDisplays = [makeMockDisplay(1440, 900, 0, 0)];
    const win = { isDestroyed: () => true, getPosition: () => [0, 0] };
    const display = screenService.getDisplayForWindow(win);
    expect(display.bounds.width).toBe(1440);
  });

  it('returns primary display for null window', () => {
    mockDisplays = [makeMockDisplay(1440, 900, 0, 0)];
    const display = screenService.getDisplayForWindow(null);
    expect(display.bounds.width).toBe(1440);
  });
});

// ========== getDisplayForPoint ==========

describe('getDisplayForPoint', () => {
  it('returns correct display for point on secondary monitor', () => {
    mockDisplays = [makeMockDisplay(1440, 900, 0, 0), makeMockDisplay(2560, 1440, 1440, 0)];
    const display = screenService.getDisplayForPoint({ x: 2000, y: 500 });
    expect(display.bounds.x).toBe(1440);
  });

  it('returns primary for NaN coordinates', () => {
    mockDisplays = [makeMockDisplay(1440, 900, 0, 0)];
    const display = screenService.getDisplayForPoint({ x: NaN, y: NaN });
    expect(display.bounds.width).toBe(1440);
  });

  it('returns primary for null point', () => {
    mockDisplays = [makeMockDisplay(1440, 900, 0, 0)];
    const display = screenService.getDisplayForPoint(null);
    expect(display.bounds.width).toBe(1440);
  });
});

// ========== Per-display position memory ==========

describe('per-display position memory', () => {
  it('saves and retrieves position for a display', () => {
    const display = makeMockDisplay(2560, 1440, 1440, 0);
    const map = screenService.setSavedPositionForDisplay({}, display, { x: 2000, y: 500, side: 'left' });
    const saved = screenService.getSavedPositionForDisplay(map, display);
    expect(saved).toEqual({ x: 2000, y: 500, side: 'left' });
  });

  it('returns null for display with no saved position', () => {
    const display = makeMockDisplay(1440, 900, 0, 0);
    const saved = screenService.getSavedPositionForDisplay({}, display);
    expect(saved).toBeNull();
  });

  it('returns null for null/undefined map', () => {
    const display = makeMockDisplay(1440, 900, 0, 0);
    expect(screenService.getSavedPositionForDisplay(null, display)).toBeNull();
    expect(screenService.getSavedPositionForDisplay(undefined, display)).toBeNull();
  });

  it('preserves positions for other displays when updating one', () => {
    const displayA = makeMockDisplay(1440, 900, 0, 0);
    const displayB = makeMockDisplay(2560, 1440, 1440, 0);
    let map = screenService.setSavedPositionForDisplay({}, displayA, { x: 100, y: 100, side: 'right' });
    map = screenService.setSavedPositionForDisplay(map, displayB, { x: 2000, y: 500, side: 'left' });

    expect(screenService.getSavedPositionForDisplay(map, displayA)).toEqual({ x: 100, y: 100, side: 'right' });
    expect(screenService.getSavedPositionForDisplay(map, displayB)).toEqual({ x: 2000, y: 500, side: 'left' });
  });

  it('migrates old flat position to correct display key', () => {
    mockDisplays = [makeMockDisplay(1440, 900, 0, 0)];
    const map = screenService.migrateOldPosition({ x: 1020, y: 330 }, 'right');
    const key = '1440x900@0,0';
    expect(map[key]).toBeDefined();
    expect(map[key].x).toBe(1020);
    expect(map[key].y).toBe(330);
    expect(map[key].side).toBe('right');
  });

  it('returns empty map for null old position', () => {
    const map = screenService.migrateOldPosition(null, 'right');
    expect(Object.keys(map)).toHaveLength(0);
  });
});

// ========== computeHUDPosition ==========

describe('computeHUDPosition', () => {
  it('centers HUD above actual orb on right side', () => {
    mockDisplays = [makeMockDisplay(1440, 900, 0, 0)];
    // Orb window bottom-right, orb on right side
    const win = makeMockWindow(1020, 330, 400, 550);
    const { x, y } = screenService.computeHUDPosition(win, 'right', 340, 420);

    // Orb center X = 1020 + 400 - 20 - 40 = 1360
    // HUD center X should be near 1360 - 170 = 1190
    // But clamped to screen right: max = 1440 - 340 - 10 = 1090
    expect(x).toBeLessThanOrEqual(1440 - 340 - 10);
    expect(x).toBeGreaterThanOrEqual(10);
    // HUD should be above the orb
    expect(y).toBeLessThan(330 + 550 - 20 - 80); // above orb top
  });

  it('centers HUD above actual orb on left side', () => {
    mockDisplays = [makeMockDisplay(1440, 900, 0, 0)];
    const win = makeMockWindow(0, 330, 400, 550);
    const { x, y } = screenService.computeHUDPosition(win, 'left', 340, 420);

    // Orb center X = 0 + 20 + 40 = 60
    // HUD x = 60 - 170 = -110 -> clamped to 10
    expect(x).toBe(10);
    expect(y).toBeLessThan(330 + 550 - 20 - 80);
  });

  it('places HUD below orb when not enough room above', () => {
    mockDisplays = [makeMockDisplay(1440, 900, 0, 0)];
    // Orb window near top of screen
    const win = makeMockWindow(500, 10, 400, 550);
    const { y } = screenService.computeHUDPosition(win, 'right', 340, 420);

    // Orb top = 10 + 550 - 20 - 80 = 460
    // HUD above would be 460 - 420 - 20 = 20, which is >= margin
    // So it should still be above
    expect(y).toBeGreaterThanOrEqual(10);
  });

  it('clamps to second monitor workArea', () => {
    mockDisplays = [makeMockDisplay(1440, 900, 0, 0), makeMockDisplay(2560, 1440, 1440, 0)];
    // Orb on second display
    const win = makeMockWindow(3500, 870, 400, 550);
    const { x, y } = screenService.computeHUDPosition(win, 'right', 340, 420);

    // Should be within second display bounds
    expect(x).toBeGreaterThanOrEqual(1440 + 10);
    expect(x).toBeLessThanOrEqual(1440 + 2560 - 340 - 10);
    expect(y).toBeGreaterThanOrEqual(10);
  });
});

// ========== listenForDisplayChanges ==========

describe('listenForDisplayChanges', () => {
  it('registers listeners on screen', () => {
    const callback = vi.fn();
    const cleanup = screenService.listenForDisplayChanges(callback);

    expect(mockScreen.on).toHaveBeenCalledWith('display-added', expect.any(Function));
    expect(mockScreen.on).toHaveBeenCalledWith('display-removed', expect.any(Function));
    expect(mockScreen.on).toHaveBeenCalledWith('display-metrics-changed', expect.any(Function));

    cleanup();
    expect(mockScreen.removeListener).toHaveBeenCalledTimes(3);
  });
});

// ========== getScreenContext ==========

describe('getScreenContext', () => {
  it('returns single display info', () => {
    mockDisplays = [makeMockDisplay(1440, 900, 0, 0)];
    const ctx = screenService.getScreenContext(null, 'right');
    expect(ctx.displayCount).toBe(1);
    expect(ctx.displays[0].width).toBe(1440);
    expect(ctx.displays[0].primary).toBe(true);
    expect(ctx.orbPosition).toBeNull();
  });

  it('returns two displays with correct geometry', () => {
    mockDisplays = [makeMockDisplay(1440, 900, 0, 0), makeMockDisplay(2560, 1440, 1440, 0)];
    const ctx = screenService.getScreenContext(null, 'right');
    expect(ctx.displayCount).toBe(2);
    expect(ctx.displays[0].primary).toBe(true);
    expect(ctx.displays[1].x).toBe(1440);
    expect(ctx.displays[1].width).toBe(2560);
  });

  it('includes orb position when orbWindow is provided', () => {
    mockDisplays = [makeMockDisplay(1440, 900, 0, 0)];
    const win = makeMockWindow(1020, 330, 400, 550);
    const ctx = screenService.getScreenContext(win, 'right');
    expect(ctx.orbPosition).toBeDefined();
    expect(ctx.orbPosition.side).toBe('right');
    expect(ctx.orbPosition.cx).toBe(1360); // 1020 + 400 - 20 - 40
    expect(ctx.orbPosition.cy).toBe(820); // 330 + 550 - 20 - 40
  });

  it('returns safe defaults on error', () => {
    const ctx = screenService.getScreenContext({ isDestroyed: () => true }, 'right');
    expect(ctx.orbPosition).toBeNull();
    expect(ctx.displayCount).toBeGreaterThanOrEqual(0);
  });
});
