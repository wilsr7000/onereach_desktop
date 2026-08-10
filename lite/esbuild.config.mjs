/**
 * esbuild config for Onereach Lite kernel.
 *
 * Kernel uses plain HTML + TypeScript (per ADR-002 / ADR-013). Vue 3 + Vite
 * are introduced at the first content-tab port (`shell-window-vue-tabs`).
 *
 * This config produces three bundles:
 *   - main process    : lite/main-lite.ts -> dist-lite/build/main-lite.js (CJS, Node target)
 *   - preload         : lite/preload-lite.ts -> dist-lite/build/preload-lite.js (CJS, Node target)
 *   - bug-report modal: lite/bug-report/modal.ts -> dist-lite/build/bug-report-modal.js (IIFE, browser target)
 *
 * Electron is externalized in the main + preload bundles (Node-side runtime
 * resolves it). The renderer bundle is browser-targeted with Electron globals
 * injected via the contextBridge in preload, never imported directly.
 */

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { promises as fs } from 'node:fs';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const outDir = resolve(rootDir, 'dist-lite/build');

// HTML/CSS assets must live alongside their bundled JS in dist-lite/build/
// so file:// origin + strict CSP work correctly. Renderer references the
// bundle as `./bug-report-modal.js` (same directory).
const ASSETS_TO_COPY = [
  { from: 'lite/signature.css', to: 'signature.css' },
  { from: 'lite/wiser-header.html', to: 'wiser-header.html' },
  { from: 'lite/placeholder.html', to: 'placeholder.html' },
  { from: 'lite/about.html', to: 'about.html' },
  { from: 'lite/bug-report/modal.html', to: 'modal.html' },
  { from: 'lite/bug-report/modal.css', to: 'modal.css' },
  { from: 'lite/settings/settings.html', to: 'settings.html' },
  { from: 'lite/settings/settings.css', to: 'settings.css' },
  { from: 'lite/api-docs/index.html', to: 'api-docs.html' },
  { from: 'lite/api-docs/index.css', to: 'api-docs.css' },
  { from: 'lite/idw/catalog.html', to: 'idw-store.html' },
  { from: 'lite/idw/catalog.css', to: 'idw-store.css' },
  { from: 'lite/tools/manager.html', to: 'tools-manager.html' },
  { from: 'lite/tools/manager.css', to: 'tools-manager.css' },
  { from: 'lite/main-window/chrome.html', to: 'chrome.html' },
  { from: 'lite/main-window/chrome.css', to: 'chrome.css' },
  { from: 'lite/university/tutorials.html', to: 'university-tutorials.html' },
  { from: 'lite/university/tutorials.css', to: 'university-tutorials.css' },
  { from: 'lite/ai-run-times/feed.html', to: 'ai-run-times.html' },
  { from: 'lite/ai-run-times/feed.css', to: 'ai-run-times.css' },
  { from: 'lite/help/help.html', to: 'help.html' },
  { from: 'lite/help/help.css', to: 'help.css' },
  { from: 'lite/spaces/spaces.html', to: 'spaces.html' },
  { from: 'lite/learn/learn.html', to: 'learn.html' },
  { from: 'lite/learn/learn.css', to: 'learn.css' },
  { from: 'lite/assets/capchewlogo.jpg', to: 'capchewlogo.jpg' },
  { from: 'lite/spaces/spaces.css', to: 'spaces.css' },
  // boot-chat.html / boot-chat.css were retired when the chat surface
  // moved inline into chrome.html — the module source lives at
  // lite/boot-chat/ and is imported by chrome.ts, but the page is no
  // longer loaded as a standalone window.
  // Download → Save to Space picker. Spawned by lite/downloads/handler.ts
  // for every captured will-download event the user routes to Spaces.
  { from: 'lite/downloads/picker.html', to: 'download-picker.html' },
  { from: 'lite/downloads/picker.css', to: 'download-picker.css' },
  // Tray icons (Phase 0a). Copied next to the main bundle so
  // `lite/tray/main.ts` can resolve them via `path.join(__dirname,
  // ...)` without poking at <appPath>/assets/. Template variant
  // enables macOS menu-bar auto-adapt; the @2x sibling auto-loads
  // when present so Retina menu bars render crisp; regular icon is
  // the fallback for non-template builds.
  { from: 'assets/tray-iconTemplate.png', to: 'tray-iconTemplate.png' },
  { from: 'assets/tray-iconTemplate@2x.png', to: 'tray-iconTemplate@2x.png' },
  { from: 'assets/tray-icon.png', to: 'tray-icon.png' },
  // OneReach logo used by `.spaces-or-button` in the main-window tab
  // bar. Same asset the full app's `#black-hole-button` uses; copied
  // sibling-of the HTML/CSS so `chrome.css` can reference it as
  // `./or-logo.png` without a build-time data-URL.
  { from: 'assets/or-logo.png', to: 'or-logo.png' },
];

async function copyAssets() {
  await fs.mkdir(outDir, { recursive: true });
  for (const { from, to } of ASSETS_TO_COPY) {
    await fs.copyFile(join(rootDir, from), join(outDir, to));
  }
  console.log(`[esbuild] copied ${ASSETS_TO_COPY.length} HTML/CSS assets -> ${outDir}`);
}

const isWatch = process.argv.includes('--watch');
const isDev = process.env.NODE_ENV === 'development' || isWatch;

/** @type {esbuild.BuildOptions} */
const commonOptions = {
  bundle: true,
  sourcemap: isDev ? 'inline' : false,
  minify: !isDev,
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': JSON.stringify(isDev ? 'development' : 'production'),
    __LITE_LOG_PORT__: '47392',
    __LITE_AGENT_EXCHANGE_PORT__: '3457',
    __LITE_SPACES_PORT__: '47391',
  },
};

/** @type {esbuild.BuildOptions} */
const mainProcessOptions = {
  ...commonOptions,
  entryPoints: [resolve(__dirname, 'main-lite.ts')],
  outfile: resolve(outDir, 'main-lite.js'),
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: [
    'electron',
    'electron-log',
    'electron-updater',
    'better-sqlite3',
    'keytar',
    'otplib',
    'jsqr',
    // @anthropic-ai/sdk is BUNDLED (removed from externals, 0.0.47): as
    // an external it needed node_modules packaging, and electron-builder's
    // collector dropped its transitive deps (standardwebhooks,
    // json-schema-to-ts) when a nested duplicate sdk (browser-use's old
    // 0.74) confused resolution — 0.0.46 crashed at boot on exactly that.
    // Pure-JS deps belong in the bundle; only natives + electron stay out.
  ],
};

/** @type {esbuild.BuildOptions} */
const preloadOptions = {
  ...commonOptions,
  entryPoints: [resolve(__dirname, 'preload-lite.ts')],
  outfile: resolve(outDir, 'preload-lite.js'),
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron'],
};

/**
 * Minimal preload for the embedded WISER Playbooks window. Exposes ONLY
 * `window.ai` (a Claude chat proxy on the app's keychain key) -- never the
 * full `window.lite.*` bridge. Same build shape as the main preload; the
 * only runtime require is `electron`, so it is sandbox-safe.
 */
const wiserPreloadOptions = {
  ...commonOptions,
  entryPoints: [resolve(__dirname, 'preload-lite-wiser.ts')],
  outfile: resolve(outDir, 'preload-lite-wiser.js'),
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron'],
};

/** @type {esbuild.BuildOptions} */
const bugReportModalOptions = {
  ...commonOptions,
  entryPoints: [resolve(__dirname, 'bug-report/modal.ts')],
  outfile: resolve(outDir, 'bug-report-modal.js'),
  platform: 'browser',
  target: 'chrome130', // Electron 41 uses Chromium 146; chrome130 is conservative
  format: 'iife',
  globalName: 'OnereachLiteBugReport',
};

/** @type {esbuild.BuildOptions} */
const placeholderOptions = {
  ...commonOptions,
  entryPoints: [resolve(__dirname, 'placeholder.ts')],
  outfile: resolve(outDir, 'placeholder.js'),
  platform: 'browser',
  target: 'chrome130',
  format: 'iife',
  globalName: 'OnereachLitePlaceholder',
};

/** @type {esbuild.BuildOptions} */
const settingsOptions = {
  ...commonOptions,
  entryPoints: [resolve(__dirname, 'settings/settings.ts')],
  outfile: resolve(outDir, 'settings.js'),
  platform: 'browser',
  target: 'chrome130',
  format: 'iife',
  globalName: 'OnereachLiteSettings',
};

/** @type {esbuild.BuildOptions} */
const apiDocsOptions = {
  ...commonOptions,
  entryPoints: [resolve(__dirname, 'api-docs/index.ts')],
  outfile: resolve(outDir, 'api-docs.js'),
  platform: 'browser',
  target: 'chrome130',
  format: 'iife',
  globalName: 'OnereachLiteApiDocs',
};

/** @type {esbuild.BuildOptions} */
const idwStoreOptions = {
  ...commonOptions,
  entryPoints: [resolve(__dirname, 'idw/catalog-renderer.ts')],
  outfile: resolve(outDir, 'idw-store.js'),
  platform: 'browser',
  target: 'chrome130',
  format: 'iife',
  globalName: 'OnereachLiteIdwStore',
};

/** @type {esbuild.BuildOptions} */
const toolsManagerOptions = {
  ...commonOptions,
  entryPoints: [resolve(__dirname, 'tools/manager-renderer.ts')],
  outfile: resolve(outDir, 'tools-manager.js'),
  platform: 'browser',
  target: 'chrome130',
  format: 'iife',
  globalName: 'OnereachLiteToolsManager',
};

/** @type {esbuild.BuildOptions} */
const universityTutorialsOptions = {
  ...commonOptions,
  entryPoints: [resolve(__dirname, 'university/tutorials-renderer.ts')],
  outfile: resolve(outDir, 'university-tutorials.js'),
  platform: 'browser',
  target: 'chrome130',
  format: 'iife',
  globalName: 'OnereachLiteUniversityTutorials',
};

/** @type {esbuild.BuildOptions} */
const chromeOptions = {
  ...commonOptions,
  entryPoints: [resolve(__dirname, 'main-window/chrome.ts')],
  outfile: resolve(outDir, 'chrome.js'),
  platform: 'browser',
  target: 'chrome130',
  format: 'iife',
  globalName: 'OnereachLiteChrome',
};

/** @type {esbuild.BuildOptions} */
const aiRunTimesOptions = {
  ...commonOptions,
  entryPoints: [resolve(__dirname, 'ai-run-times/feed-renderer.ts')],
  outfile: resolve(outDir, 'ai-run-times.js'),
  platform: 'browser',
  target: 'chrome130',
  format: 'iife',
  globalName: 'OnereachLiteAiRunTimes',
};

/** @type {esbuild.BuildOptions} */
const helpOptions = {
  ...commonOptions,
  entryPoints: [resolve(__dirname, 'help/help.ts')],
  outfile: resolve(outDir, 'help.js'),
  platform: 'browser',
  target: 'chrome130',
  format: 'iife',
  globalName: 'OnereachLiteHelp',
};

/** @type {esbuild.BuildOptions} */
const spacesOptions = {
  ...commonOptions,
  entryPoints: [resolve(__dirname, 'spaces/spaces.ts')],
  outfile: resolve(outDir, 'spaces.js'),
  platform: 'browser',
  target: 'chrome130',
  format: 'iife',
  globalName: 'OnereachLiteSpaces',
};

/** @type {esbuild.BuildOptions} */
const learnPageOptions = {
  ...commonOptions,
  entryPoints: [resolve(__dirname, 'learn/learn.ts')],
  outfile: resolve(outDir, 'learn-page.js'),
  platform: 'browser',
  target: 'chrome130',
  format: 'iife',
  globalName: 'OnereachLiteLearn',
};

/** @type {esbuild.BuildOptions} */
const downloadPickerOptions = {
  ...commonOptions,
  entryPoints: [resolve(__dirname, 'downloads/picker.ts')],
  outfile: resolve(outDir, 'download-picker.js'),
  platform: 'browser',
  target: 'chrome130',
  format: 'iife',
  globalName: 'OnereachLiteDownloadPicker',
};

// boot-chat is no longer a standalone bundle — the module lives at
// lite/boot-chat/ and is imported by chrome.ts, so esbuild inlines it
// into chrome.js automatically. Removed entry retired alongside the
// boot-chat → chrome swap.

const allConfigs = [
  mainProcessOptions,
  preloadOptions,
  wiserPreloadOptions,
  bugReportModalOptions,
  placeholderOptions,
  settingsOptions,
  apiDocsOptions,
  idwStoreOptions,
  toolsManagerOptions,
  universityTutorialsOptions,
  chromeOptions,
  aiRunTimesOptions,
  helpOptions,
  spacesOptions,
  learnPageOptions,
  downloadPickerOptions,
];

if (isWatch) {
  await copyAssets();
  const contexts = await Promise.all(allConfigs.map((cfg) => esbuild.context(cfg)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log(`[esbuild] watching ${allConfigs.length} bundles -> ${outDir}`);
  // Keep the process alive
  process.stdin.resume();
} else {
  await copyAssets();
  const results = await Promise.all(allConfigs.map((cfg) => esbuild.build(cfg)));
  const totalErrors = results.reduce((acc, r) => acc + r.errors.length, 0);
  const totalWarnings = results.reduce((acc, r) => acc + r.warnings.length, 0);
  console.log(
    `[esbuild] built ${allConfigs.length} bundles -> ${outDir} (${totalErrors} errors, ${totalWarnings} warnings)`
  );
  if (totalErrors > 0) process.exit(1);
}
