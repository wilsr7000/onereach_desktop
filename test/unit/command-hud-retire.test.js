/**
 * Command HUD retirement (Phase 4)
 *
 * Pins the new behavior of main.js's showCommandHUD and
 * sendCommandHUDResult: by default they are no-ops, so the legacy HUD
 * window does NOT pop adjacent to the orb every time a task runs. The
 * useLegacyHud feature flag in settings re-enables the old window for
 * users who hit a regression in the new chat+modal pipeline.
 */

import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');

const MAIN_SOURCE = fs.readFileSync(
  path.join(__dirname, '../../main.js'),
  'utf8'
);

function extract(fnName) {
  const start = MAIN_SOURCE.indexOf(`function ${fnName}(`);
  expect(start, `function ${fnName} must exist`).toBeGreaterThan(-1);
  // Find the matching closing brace by scanning. Cheap heuristic: take
  // the next ~80 lines which is generous for these small functions.
  const slice = MAIN_SOURCE.slice(start, start + 4000);
  const end = slice.indexOf('\n}\n');
  return slice.slice(0, end > 0 ? end + 2 : slice.length);
}

describe('Phase 4: Command HUD retired by default, behind useLegacyHud flag', () => {
  it('introduces _isLegacyHudEnabled() reading useLegacyHud setting', () => {
    expect(MAIN_SOURCE).toMatch(/function\s+_isLegacyHudEnabled\s*\(\s*\)/);
    expect(MAIN_SOURCE).toMatch(/global\.settingsManager\?\.get\(['"]useLegacyHud['"]\)/);
  });

  it('showCommandHUD short-circuits when the flag is OFF (default)', () => {
    const body = extract('showCommandHUD');
    // The early-return gate must appear BEFORE any HUD show / position
    // / send call, otherwise the legacy HUD would fire even when the
    // flag is off (defeating the whole retirement).
    const gateIdx = body.indexOf('!_isLegacyHudEnabled()');
    expect(gateIdx, 'flag-off gate must exist').toBeGreaterThan(-1);
    const showIdx = body.indexOf('commandHUDWindow.show(');
    if (showIdx > -1) {
      expect(gateIdx).toBeLessThan(showIdx);
    }
    const positionIdx = body.indexOf('setPosition');
    if (positionIdx > -1) {
      expect(gateIdx).toBeLessThan(positionIdx);
    }
  });

  it('sendCommandHUDResult short-circuits when the flag is OFF (default)', () => {
    const body = extract('sendCommandHUDResult');
    const gateIdx = body.indexOf('!_isLegacyHudEnabled()');
    expect(gateIdx, 'flag-off gate must exist').toBeGreaterThan(-1);
    const sendIdx = body.indexOf('webContents.send(');
    if (sendIdx > -1) {
      expect(gateIdx).toBeLessThan(sendIdx);
    }
  });

  it('legacy HUD window code remains in tree (so flag-on path still works)', () => {
    // Don't outright delete createCommandHUDWindow / commandHUDWindow.
    // They must still exist for users who flip useLegacyHud=true.
    expect(MAIN_SOURCE).toMatch(/function createCommandHUDWindow/);
    expect(MAIN_SOURCE).toMatch(/commandHUDWindow\.show\(\)/);
  });

  it('global.showCommandHUD and global.sendCommandHUDResult are still exported (callers unaware of retirement)', () => {
    // The bridge calls global.showCommandHUD() and global.sendCommandHUDResult()
    // unconditionally. Retirement is silent: they just no-op rather
    // than disappear.
    expect(MAIN_SOURCE).toMatch(/global\.showCommandHUD\s*=\s*showCommandHUD/);
    expect(MAIN_SOURCE).toMatch(/global\.sendCommandHUDResult\s*=\s*sendCommandHUDResult/);
  });
});
