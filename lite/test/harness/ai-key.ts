/**
 * The AI credentials THE APP is configured with (Settings → AI).
 *
 * Tests that need a real model must not invent their own way of finding
 * a key. A suite that reads `ANTHROPIC_API_KEY` and nothing else tests a
 * configuration the user never uses: in the packaged app the key is
 * pasted into Settings → AI and lands in the OS keychain, and the env
 * var is only a dev convenience. So this harness resolves the key the
 * way `lite/ai/api.ts` does at boot, using the app's OWN code:
 *
 *   1. OS keychain (Settings → AI)  — {@link AnthropicKeyStore}
 *   2. `ANTHROPIC_API_KEY` env      — dev shell
 *   3. `{userData}/ai-config.json`  — the durable file option
 *
 * Precedence is not re-implemented here: {@link resolveAiConfig} — the
 * function the app calls — is handed the same three inputs, so the suite
 * cannot drift from the app. This module only supplies the inputs (read
 * the keychain, find userData) and reports WHICH one won.
 *
 * SECURITY: the resolved key is returned so a live test can call the
 * model, and is never logged. {@link fingerprintSecret} exists so a test
 * can say *which* key it used — a truncated SHA-256, never the value or
 * any slice of it.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { AnthropicKeyStore } from '../../ai/key-store.js';
import {
  AI_CONFIG_FILENAME,
  resolveAiConfig,
  type ClaudeConfig,
  type ResolvedAiConfig,
} from '../../ai/config.js';

/**
 * The app's INTERNAL product name, which is what names its userData
 * directory. Duplicated from `LITE_PRODUCT_NAME` in `main-lite.ts`
 * because importing that file boots Electron; `ai-key-source.test.ts`
 * pins this copy against the original so the two cannot drift.
 */
export const LITE_PRODUCT_NAME = 'Onereach.ai Lite';

/** Which of the three inputs supplied the key that won. */
export type AiKeySource = 'app-settings-keychain' | 'env' | 'ai-config.json' | 'unknown';

export interface AppAiCredentials {
  /** The provider config the app would use right now. */
  config: ResolvedAiConfig;
  /** Where the winning Claude key came from (`unknown` for a flow config). */
  source: AiKeySource;
  /** Safe to print: a truncated hash, never the secret. */
  fingerprint: string;
}

/**
 * The app's userData directory — where `ai-config.json` lives.
 *
 * Honours `LITE_USER_DATA_DIR` first, exactly like `main-lite.ts`, so a
 * test run pointed at a side-by-side dev profile reads that profile's
 * config rather than the installed app's.
 */
export function liteUserDataDir(platform: NodeJS.Platform = process.platform): string {
  const override = process.env['LITE_USER_DATA_DIR'];
  if (typeof override === 'string' && override.trim().length > 0) return override.trim();
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', LITE_PRODUCT_NAME);
  }
  if (platform === 'win32') {
    const appData = process.env['APPDATA'];
    const base =
      typeof appData === 'string' && appData.length > 0
        ? appData
        : join(homedir(), 'AppData', 'Roaming');
    return join(base, LITE_PRODUCT_NAME);
  }
  return join(homedir(), '.config', LITE_PRODUCT_NAME);
}

/**
 * The key the user pasted into Settings → AI, or null.
 *
 * Soft-fails the way the app does. `keytar` is a native module: on a
 * machine (or CI Node) where the binding won't load, constructing the
 * store throws — that is "no key configured here", not a test failure,
 * and the env / file inputs still apply.
 */
export async function readAppSettingsAiKey(): Promise<string | null> {
  try {
    return await new AnthropicKeyStore().getKey();
  } catch {
    return null;
  }
}

/** Raw `{userData}/ai-config.json`, or null when absent/unreadable. */
export function readAiConfigFileJson(dir: string = liteUserDataDir()): string | null {
  try {
    const path = join(dir, AI_CONFIG_FILENAME);
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * A stable, non-reversible label for a secret, so a test can report
 * which key it ran with. Truncated SHA-256 — no prefix or suffix of the
 * key itself, because a "last 4" leaks real bytes into CI logs.
 */
export function fingerprintSecret(secret: string): string {
  return `sha256:${createHash('sha256').update(secret).digest('hex').slice(0, 12)}`;
}

/**
 * The pure core: three inputs in, credentials out. Split from the I/O so
 * precedence and source attribution are unit-testable without a
 * keychain, a home directory, or a network.
 */
export function buildAppAiCredentials(
  env: Record<string, string | undefined>,
  fileJson: string | null,
  keychainKey: string | null
): AppAiCredentials | null {
  const config = resolveAiConfig(env, fileJson, keychainKey);
  if (config === null) return null;

  if (config.provider !== 'claude') {
    return { config, source: 'unknown', fingerprint: fingerprintSecret(config.url) };
  }
  return {
    config,
    source: attributeKey(config.apiKey, keychainKey, env['ANTHROPIC_API_KEY']),
    fingerprint: fingerprintSecret(config.apiKey),
  };
}

/**
 * Resolve what the app would use, from the app's own three inputs.
 * Returns null when nothing is configured anywhere.
 */
export async function resolveAppAiConfig(
  env: Record<string, string | undefined> = process.env,
  userDataDir: string = liteUserDataDir()
): Promise<AppAiCredentials | null> {
  return buildAppAiCredentials(env, readAiConfigFileJson(userDataDir), await readAppSettingsAiKey());
}

/**
 * The Claude half of {@link resolveAppAiConfig} — null when the app is
 * unconfigured OR configured for the OneReach flow instead.
 */
export async function resolveAppClaudeConfig(
  env: Record<string, string | undefined> = process.env,
  userDataDir: string = liteUserDataDir()
): Promise<(AppAiCredentials & { config: ClaudeConfig }) | null> {
  const found = await resolveAppAiConfig(env, userDataDir);
  if (found === null || found.config.provider !== 'claude') return null;
  return found as AppAiCredentials & { config: ClaudeConfig };
}

/**
 * One line a live test can print (or skip with) that says where the key
 * came from and which key it is, without revealing it.
 */
export function describeAiCredentials(found: AppAiCredentials | null): string {
  if (found === null) {
    return (
      'no AI credentials configured — paste a Claude key into Settings → AI ' +
      `(keychain), export ANTHROPIC_API_KEY, or write ${AI_CONFIG_FILENAME} ` +
      `into ${liteUserDataDir()}`
    );
  }
  if (found.config.provider !== 'claude') {
    return `provider=onereach-flow url=${found.config.url} (${found.fingerprint})`;
  }
  return (
    `provider=claude source=${found.source} model=${found.config.model} ` +
    `(${found.fingerprint})`
  );
}

/** Which input produced the winning key. */
function attributeKey(
  winner: string,
  keychainKey: string | null,
  envKey: string | undefined
): AiKeySource {
  if (keychainKey !== null && keychainKey.trim() === winner) return 'app-settings-keychain';
  if (typeof envKey === 'string' && envKey.trim() === winner) return 'env';
  return 'ai-config.json';
}
