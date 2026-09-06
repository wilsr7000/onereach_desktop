/**
 * Product naming (ADR-095, 2026-09-06: "let's call it Onereach Desktop").
 *
 * Two names, two rules, one test:
 *
 *   - Every user-facing surface says PRODUCT_DISPLAY_NAME — the builder
 *     config (bundle, DMG, artifacts), the release script's artifact
 *     prefix, the static window titles, the Help entry, the tray. Change
 *     the constant in lite/product.ts and this test names every file
 *     that has to follow.
 *
 *   - The INTERNAL identity never moves: `app.setName('Onereach.ai
 *     Lite')` and appId com.onereach.lite. Renaming either silently
 *     relocates every install's userData and keychain vault (the user
 *     signs in again to an empty app) and breaks auto-update.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PRODUCT_DISPLAY_NAME, INTERNAL_APP_NAME, APP_BUNDLE_NAMES } from '../../product.js';

const ROOT = resolve(__dirname, '../..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
const ARTIFACT_PREFIX = PRODUCT_DISPLAY_NAME.replace(/\s+/g, '.');

describe('the display name reaches every surface', () => {
  it('electron-builder: bundle, Dock/Finder name, DMG title, artifacts', () => {
    const cfg = JSON.parse(read('electron-builder.json')) as {
      productName: string;
      appId: string;
      mac: { extendInfo: Record<string, string>; artifactName: string };
      win: { artifactName: string };
      dmg: { title: string };
      nsis: { artifactName: string };
    };
    expect(cfg.productName).toBe(PRODUCT_DISPLAY_NAME);
    expect(cfg.mac.extendInfo['CFBundleDisplayName']).toBe(PRODUCT_DISPLAY_NAME);
    expect(cfg.dmg.title).toBe(`${PRODUCT_DISPLAY_NAME} \${version}`);
    for (const name of [cfg.mac.artifactName, cfg.win.artifactName, cfg.nsis.artifactName]) {
      expect(name.startsWith(`${ARTIFACT_PREFIX}-`)).toBe(true);
    }
  });

  it('release script: the artifact prefix matches the builder, the public notes carry the name', () => {
    const sh = read('scripts/release-lite.sh');
    expect(sh).toContain(`LITE_ARTIFACT_PREFIX="${ARTIFACT_PREFIX}"`);
    expect(sh).toContain(`PUBLIC_NOTES="# ${PRODUCT_DISPLAY_NAME} \${LITE_TAG}`);
    expect(sh).toContain(`/Applications/${PRODUCT_DISPLAY_NAME}.app`);
  });

  it('static window titles', () => {
    expect(read('main-window/chrome.html')).toContain(`<title>${PRODUCT_DISPLAY_NAME}</title>`);
    expect(read('placeholder.html')).toContain(`<title>${PRODUCT_DISPLAY_NAME}</title>`);
    expect(read('about.html')).toContain(`<title>About ${PRODUCT_DISPLAY_NAME}</title>`);
    expect(read('help/help.html')).toContain(`<title>${PRODUCT_DISPLAY_NAME} Help</title>`);
  });

  it('the main process and its menus read the constant, never a literal', async () => {
    const main = read('main-lite.ts');
    expect(main).toContain('export const LITE_DISPLAY_NAME = PRODUCT_DISPLAY_NAME;');
    expect(main).toContain('const LITE_PRODUCT_NAME = INTERNAL_APP_NAME;');
    expect(main).toContain('app.setName(LITE_PRODUCT_NAME);');
    const { HELP_USER_GUIDE_LABEL } = await import('../../help/menu-wiring.js');
    expect(HELP_USER_GUIDE_LABEL).toBe(`${PRODUCT_DISPLAY_NAME} Help`);
    const seed = read('menu/seed.ts');
    expect(seed).toContain('label: `About ${PRODUCT_DISPLAY_NAME}`');
    expect(seed).toContain('label: `Quit ${PRODUCT_DISPLAY_NAME}`');
    expect(seed).not.toMatch(/label: '(About|Quit) /);
  });

  it('no user-facing source string still carries the old names', () => {
    // Source files that may legitimately say 'Onereach.ai Lite': the
    // frozen identity itself, provenance labels written to the graph
    // (a cross-app contract — the registry Note standard, presence
    // beacons, the feedback Space's name), and scripts that must find
    // an install updated in place under its old folder.
    const allowed = new Set([
      'product.ts',
      'main-lite.ts',
      'updater/install.ts',
      'updater/state.ts',
      // Provenance + cross-app contracts (see ADR-095): the registry
      // Note standard's sourceApp, presence beacons, the registry's
      // writer name, the feedback Space's name, the .ics PRODID.
      'bug-report/space.ts',
      'spaces/sdk-client.ts',
      'spaces/spaces.ts',
      'spaces/note-standard.ts',
      'spaces/main.ts',
      'registry/queries.ts',
      'calendar/ics.ts',
      'scripts/seed-registry-showcase.ts',
      'scripts/release-lite.sh',
      'mcp/session-identity.ts',
    ]);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const rel = full.slice(ROOT.length + 1);
        if (rel.startsWith('test') || rel.startsWith('node_modules') || rel.startsWith('api-docs') || rel.startsWith('build')) continue;
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.(ts|html)$/.test(entry) || rel.endsWith('.d.ts')) continue;
        if (allowed.has(rel)) continue;
        const src = readFileSync(full, 'utf8');
        for (const [i, line] of src.split('\n').entries()) {
          const t = line.trim();
          if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--')) continue;
          if (/Onereach(\.ai)? Lite\b/.test(line) || /['"`>](About |Quit )?WISER['"`<]/.test(line)) offenders.push(`${rel}:${i + 1}: ${t.slice(0, 90)}`);
          // The brand is dropping the ".ai" (2026-09-06): copy says
          // "Onereach". Domains (idw.edison.onereach.ai), the full app's
          // config path, and keychain service ids are not copy.
          if (/(^|[^a-z0-9.-])(Onereach|OneReach)\.ai(?![a-z0-9-]*\.onereach|\/)/.test(line) && !/\.config\/Onereach\.ai|-(Anthropic|OpenAI|Session|TOTP)/.test(line)) {
            offenders.push(`${rel}:${i + 1}: ${t.slice(0, 90)}`);
          }
        }
      }
    };
    walk(ROOT);
    expect(offenders).toEqual([]);
  });
});

describe('the internal identity is frozen', () => {
  it('app.setName, appId and the bundle-name pair', () => {
    expect(INTERNAL_APP_NAME).toBe('Onereach.ai Lite');
    const cfg = JSON.parse(read('electron-builder.json')) as { appId: string };
    expect(cfg.appId).toBe('com.onereach.lite');
    expect(APP_BUNDLE_NAMES).toEqual([`${PRODUCT_DISPLAY_NAME}.app`, 'Onereach.ai Lite.app']);
    // The release script's boot-log needle is the INTERNAL name — the
    // banner prints app.getName(), which must not follow the rename.
    expect(read('scripts/release-lite.sh')).toContain('LITE_PRODUCT_NAME="Onereach.ai Lite"');
  });
});
