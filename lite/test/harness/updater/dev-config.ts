/**
 * Onereach Lite Test Harness -- dev-app-update.yml injection.
 *
 * In dev mode (!app.isPackaged), electron-updater reads its feed config
 * from a dev-app-update.yml in the app dir. Tests use this to point lite
 * at the local update server (lite/test/harness/updater/server.ts).
 *
 * Borrowed pattern: main.js lines 16814-16822, where setupAutoUpdater
 * sets autoUpdater.updateConfigPath in dev mode.
 *
 * Note: lite's main process today ALWAYS goes through initAutoUpdater
 * which auto-loads from package.json's publish config. In dev tests we
 * need the auto-updater to point at the local server instead, so the
 * test harness writes a dev-app-update.yml and lite's initUpdater is
 * told (via initOpts.devUpdateConfigPath) to apply it.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface DevConfigOptions {
  /** Local update server base URL, e.g. http://127.0.0.1:54321 */
  serverUrl: string;
  /**
   * Channel name. Lite uses the default `latest` channel since
   * ADR-027 moved lite to its own repo (separate "Latest" namespace).
   * Override only for testing alpha/beta/etc. channels.
   */
  channel?: string;
  /** Optional override for the YAML basename (electron-updater respects 'updaterCacheDirName' style). */
  publisherName?: string;
}

/**
 * Write a dev-app-update.yml at the given path. Returns the path written.
 */
export async function writeDevAppUpdateYml(
  outputPath: string,
  opts: DevConfigOptions
): Promise<string> {
  const channel = opts.channel ?? 'latest';
  const yml = [
    `provider: generic`,
    `url: ${opts.serverUrl}`,
    // Only emit a `channel:` line if it's not the default. Specifying
    // `channel: latest` is harmless but unnecessary noise.
    channel !== 'latest' ? `channel: ${channel}` : null,
    opts.publisherName !== undefined ? `publisherName: ${opts.publisherName}` : null,
    '',
  ]
    .filter((line) => line !== null)
    .join('\n');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, yml, 'utf-8');
  return outputPath;
}

/**
 * Convenience: write the dev-app-update.yml to a tempdir alongside the
 * main entry point, returning the absolute path the harness can pass
 * back to lite via env / arg / extension.
 */
export async function injectDevAppUpdateYml(
  tempDir: string,
  opts: DevConfigOptions
): Promise<string> {
  return writeDevAppUpdateYml(path.join(tempDir, 'dev-app-update.yml'), opts);
}
