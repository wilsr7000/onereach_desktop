/**
 * Preferred-provider store — which key-based provider serves AI calls
 * when more than one is configured (Settings → AI → "Use").
 *
 * `auto` (the default) keeps the historical order: Claude first, then
 * OpenAI, then a OneReach flow. One tiny JSON file under userData
 * (`ai-provider.json`), read synchronously by the config loader (which
 * is sync by contract) and written atomically. Corrupt or missing →
 * `auto`. Carries no secret.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const AI_PROVIDER_PREFERENCE_FILENAME = 'ai-provider.json';

export const AI_PROVIDER_PREFERENCES = ['auto', 'claude', 'openai'] as const;
export type AiProviderPreference = (typeof AI_PROVIDER_PREFERENCES)[number];

export function validateProviderPreference(raw: unknown): AiProviderPreference | null {
  return typeof raw === 'string' &&
    (AI_PROVIDER_PREFERENCES as readonly string[]).includes(raw)
    ? (raw as AiProviderPreference)
    : null;
}

/** The stored preference, or `auto` when unset / corrupt / no dir. */
export function readProviderPreference(configDir: string | null): AiProviderPreference {
  if (configDir === null) return 'auto';
  try {
    const raw = readFileSync(join(configDir, AI_PROVIDER_PREFERENCE_FILENAME), 'utf8');
    const parsed = JSON.parse(raw) as { provider?: unknown };
    return validateProviderPreference(parsed.provider) ?? 'auto';
  } catch {
    return 'auto';
  }
}

/**
 * Persist a preference (atomic tmp+rename); `auto` removes the file.
 * Throws on an unknown value or when no config dir is available.
 */
export function writeProviderPreference(
  configDir: string | null,
  raw: unknown
): AiProviderPreference {
  const pref = validateProviderPreference(raw);
  if (pref === null) throw new Error('Provider must be one of: auto, claude, openai.');
  if (configDir === null) throw new Error('No settings directory is available.');
  const target = join(configDir, AI_PROVIDER_PREFERENCE_FILENAME);
  if (pref === 'auto') {
    rmSync(target, { force: true });
    return pref;
  }
  mkdirSync(configDir, { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify({ provider: pref }, null, 2), 'utf8');
  renameSync(tmp, target);
  return pref;
}
