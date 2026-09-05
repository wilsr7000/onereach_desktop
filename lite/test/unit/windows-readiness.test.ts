/**
 * Windows readiness invariants (2026-09-02).
 *
 * Lite has only ever shipped on macOS. These pins keep the codebase
 * honest about the handful of places where macOS-only Electron
 * behaviour leaks into runtime code, so a future edit cannot quietly
 * make a Windows build unusable while every macOS test stays green.
 * Each pin names the failure it prevents.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

function liteRoot(): string {
  for (const c of [path.resolve('lite'), path.resolve('.')]) {
    if (existsSync(path.join(c, 'main-lite.ts'))) return c;
  }
  throw new Error('lite root not found');
}
function repoRoot(): string {
  return path.resolve(liteRoot(), '..');
}
function read(rel: string): string {
  return readFileSync(path.join(liteRoot(), rel), 'utf8');
}
/** Every runtime .ts under lite/ (no tests, no d.ts, no scripts). */
function runtimeSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (name === 'node_modules' || name === 'test' || name === 'scripts' || name === 'dist-lite') continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts') && !full.endsWith('.d.ts') && !full.endsWith('.generated.ts')) out.push(full);
    }
  };
  walk(liteRoot());
  return out;
}

describe('macOS-only window chrome is always platform-gated', () => {
  it("every titleBarStyle:'hiddenInset' / trafficLightPosition sits inside a process.platform === 'darwin' branch", () => {
    // Off macOS these options are meaningless at best; the sign-in
    // window shipped them unguarded until 2026-09-02.
    const offenders: string[] = [];
    for (const file of runtimeSources()) {
      const src = readFileSync(file, 'utf8');
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        if (!/titleBarStyle:\s*'hiddenInset'|trafficLightPosition:/.test(line)) return;
        // Look back a few lines for the guard that owns this spread.
        const window = lines.slice(Math.max(0, i - 4), i + 1).join('\n');
        if (!window.includes("process.platform === 'darwin'")) {
          offenders.push(`${path.relative(liteRoot(), file)}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the main window shows its native menu bar off macOS (the app menu lives there)', () => {
    const src = read('main-window/window.ts');
    expect(src).toContain("autoHideMenuBar: process.platform === 'darwin'");
  });
});

describe('the app menu builds on every platform', () => {
  it("top:app uses the macOS-only 'appMenu' role only on darwin", () => {
    const src = read('menu/seed.ts');
    expect(src).toContain("platform === 'darwin' ? { role: 'appMenu' as const } : { label: 'WISER' }");
  });
});

describe('auto-update installs on every platform', () => {
  it('performUpdateInstall routes non-darwin to electron-updater quitAndInstall and never spawns bash there', () => {
    const src = read('updater/install.ts');
    const start = src.indexOf('export async function performUpdateInstall');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}', start));
    expect(body).toContain("if (platform !== 'darwin') {");
    expect(body).toContain('deps.autoUpdater.quitAndInstall(false, true)');
    // The bash helper spawn must come AFTER the non-darwin early return.
    expect(body.indexOf("if (platform !== 'darwin')")).toBeLessThan(body.indexOf('spawnInstallHelper('));
  });

  it("'/bin/bash' is spawned only inside the macOS install helper module", () => {
    const hits = runtimeSources().filter((f) => readFileSync(f, 'utf8').includes("'/bin/bash'"));
    expect(hits.map((f) => path.relative(liteRoot(), f))).toEqual(['updater/install.ts']);
  });
});

describe('tray + packaging', () => {
  it('trayIconCandidates prefers the colour mark off darwin', () => {
    expect(read('tray/main.ts')).toContain("const preferColor = forceColor || platform !== 'darwin';");
  });

  it('Windows packaging: ≥256px app icon (not the tray glyph), nsis per-user one-click, named artifacts', () => {
    const cfg = JSON.parse(read('electron-builder.json')) as {
      win?: { icon?: string; artifactName?: string; target?: string[] };
      nsis?: { oneClick?: boolean; perMachine?: boolean };
    };
    expect(cfg.win?.icon).toBe('assets/icon-win.png');
    expect(existsSync(path.join(repoRoot(), 'assets', 'icon-win.png'))).toBe(true);
    expect(cfg.win?.target).toEqual(['nsis', 'zip']);
    expect(cfg.win?.artifactName).toContain('-win.');
    expect(cfg.nsis?.oneClick).toBe(true);
    expect(cfg.nsis?.perMachine).toBe(false);
  });

  it('the notarize afterSign hook is a no-op off darwin', () => {
    const src = readFileSync(path.join(repoRoot(), 'scripts', 'notarize.js'), 'utf8');
    expect(src).toContain("if (electronPlatformName !== 'darwin') return;");
  });

  it('lite:package:win runs the shared runner with --platform=win', () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot(), 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['lite:package:win']).toContain('--platform=win');
    expect(read('scripts/electron-builder-mac.mjs')).toContain("platform === 'win' ? '--win' : '--mac'");
  });
});

describe('renderer keyboard shortcuts never require the ⌘ key alone', () => {
  it('every metaKey check is paired with ctrlKey (Windows has no ⌘)', () => {
    const offenders: string[] = [];
    for (const file of runtimeSources()) {
      const src = readFileSync(file, 'utf8');
      src.split('\n').forEach((line, i) => {
        if (line.includes('metaKey') && !line.includes('ctrlKey')) {
          offenders.push(`${path.relative(liteRoot(), file)}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
