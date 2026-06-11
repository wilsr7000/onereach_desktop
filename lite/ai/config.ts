/**
 * AI provider configuration.
 *
 * Two ways to configure (env wins over file, per field):
 *
 *   1. Environment variables (great for `npm run lite` dev):
 *        ANTHROPIC_API_KEY        -> use Claude
 *        ANTHROPIC_MODEL          -> optional, defaults to claude-fable-5
 *        ANTHROPIC_BASE_URL       -> optional, defaults to api.anthropic.com
 *        ONEREACH_FLOW_URL        -> use a OneReach HTTP flow
 *        ONEREACH_FLOW_TOKEN      -> token for that flow
 *        AI_PROVIDER              -> optional: force 'claude' | 'onereach-flow'
 *
 *   2. A local JSON file the user controls, in the app's userData dir
 *      ({userData}/ai-config.json) -- the durable option for a packaged
 *      app, analogous to the user's `.env.notarization`:
 *        {
 *          "provider": "claude",
 *          "claude": { "apiKey": "sk-ant-...", "model": "claude-fable-5" },
 *          "onereachFlow": { "url": "https://...", "token": "..." }
 *        }
 *
 * SECURITY: this is the ONLY place a secret enters the process, and it
 * stays in the main process. The key/token are never returned from
 * `getStatus()`, never sent over the bridge, and never logged.
 *
 * `resolveAiConfig` is pure (env + file string in, config out) so it is
 * fully unit-testable; `loadAiConfigFromDisk` performs the I/O.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AiProvider } from './types.js';

export const DEFAULT_CLAUDE_MODEL = 'claude-fable-5';
export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
export const AI_CONFIG_FILENAME = 'ai-config.json';

export interface ClaudeConfig {
  provider: 'claude';
  apiKey: string;
  model: string;
  baseUrl: string;
}

export interface OneReachFlowConfig {
  provider: 'onereach-flow';
  url: string;
  /**
   * Optional token override. Normally the FLOW token is minted from the
   * logged-in OneReach session (see `mintFlowAuthHeader`); set this only
   * to force a specific `Authorization` value.
   */
  token?: string;
  /** Optional override for the `/refresh_token` host (defaults to edison). */
  tokenBaseUrl?: string;
}

export type ResolvedAiConfig = ClaudeConfig | OneReachFlowConfig;

interface AiConfigFileShape {
  provider?: unknown;
  claude?: { apiKey?: unknown; model?: unknown; baseUrl?: unknown };
  onereachFlow?: { url?: unknown; token?: unknown; tokenBaseUrl?: unknown };
}

/**
 * Resolve the active provider config from environment + optional config
 * file JSON. Env values take precedence over the file, per field. When
 * an `AI_PROVIDER` is named and that provider is ready, it wins;
 * otherwise Claude is preferred, then the OneReach flow. Returns null
 * when nothing is configured.
 */
export function resolveAiConfig(
  env: Record<string, string | undefined>,
  fileJson: string | null,
  keychainKey?: string | null
): ResolvedAiConfig | null {
  const file = parseConfigFile(fileJson);

  // Precedence for the Claude key: OS keychain (Settings -> AI) wins,
  // then ANTHROPIC_API_KEY env, then ai-config.json. The keychain entry
  // is the durable, user-friendly path for a packaged app.
  const claudeKey = firstString(keychainKey, env['ANTHROPIC_API_KEY'], file?.claude?.apiKey);
  const claudeModel =
    firstString(env['ANTHROPIC_MODEL'], file?.claude?.model) ?? DEFAULT_CLAUDE_MODEL;
  const claudeBaseUrl =
    firstString(env['ANTHROPIC_BASE_URL'], file?.claude?.baseUrl) ?? DEFAULT_ANTHROPIC_BASE_URL;
  const flowUrl = firstString(env['ONEREACH_FLOW_URL'], file?.onereachFlow?.url);
  const flowToken = firstString(env['ONEREACH_FLOW_TOKEN'], file?.onereachFlow?.token);
  const flowTokenBaseUrl = firstString(
    env['ONEREACH_FLOW_TOKEN_BASE_URL'],
    file?.onereachFlow?.tokenBaseUrl
  );

  const claude: ClaudeConfig | null =
    claudeKey !== undefined
      ? { provider: 'claude', apiKey: claudeKey, model: claudeModel, baseUrl: claudeBaseUrl }
      : null;
  // The flow is "ready" with just a URL -- the token is minted from the
  // logged-in session at call time (an explicit token is only an override).
  const flow: OneReachFlowConfig | null =
    flowUrl !== undefined
      ? {
          provider: 'onereach-flow',
          url: flowUrl,
          ...(flowToken !== undefined ? { token: flowToken } : {}),
          ...(flowTokenBaseUrl !== undefined ? { tokenBaseUrl: flowTokenBaseUrl } : {}),
        }
      : null;

  const explicit = normalizeProvider(firstString(env['AI_PROVIDER'], file?.provider));
  if (explicit === 'claude' && claude !== null) return claude;
  if (explicit === 'onereach-flow' && flow !== null) return flow;

  // Default preference: Claude first, then a OneReach flow.
  return claude ?? flow ?? null;
}

/**
 * Read `{configDir}/ai-config.json` (when `configDir` is set) and merge
 * with `process.env`. A missing or unreadable file is not an error --
 * we fall back to environment variables.
 */
export function loadAiConfigFromDisk(
  configDir: string | null,
  keychainKey?: string | null
): ResolvedAiConfig | null {
  let fileJson: string | null = null;
  if (configDir !== null) {
    try {
      fileJson = readFileSync(join(configDir, AI_CONFIG_FILENAME), 'utf8');
    } catch {
      fileJson = null; // missing/unreadable -> env-only.
    }
  }
  return resolveAiConfig(process.env, fileJson, keychainKey);
}

function parseConfigFile(fileJson: string | null): AiConfigFileShape | null {
  if (fileJson === null) return null;
  try {
    const parsed = JSON.parse(fileJson) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as AiConfigFileShape;
  } catch {
    return null;
  }
}

/** First non-empty trimmed string among the candidates, else undefined. */
function firstString(...vals: ReadonlyArray<unknown>): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string') {
      const t = v.trim();
      if (t.length > 0) return t;
    }
  }
  return undefined;
}

function normalizeProvider(value: string | undefined): AiProvider | null {
  if (value === 'claude' || value === 'onereach-flow') return value;
  return null;
}
