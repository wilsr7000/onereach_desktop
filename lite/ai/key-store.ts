/**
 * Anthropic API key store -- OS keychain (keytar).
 *
 * The Claude API key is a secret. Per the same pattern TOTP uses
 * (`lite/totp/store.ts`), it lives in the OS keychain — never in KV,
 * never in a log line, never returned to a renderer. The renderer can
 * only ask "is a key configured?" (`hasKey`) and write/clear it; it can
 * never read the value back.
 *
 * `loadAiConfigFromDisk` (config.ts) reads the key from here at boot +
 * after each mutation via a cached value in `ai/api.ts` (keytar is
 * async; the config loader is sync), so the env / ai-config.json
 * fallbacks keep working unchanged.
 *
 * SECURITY: the key value appears only in `setPassword` / `getPassword`
 * calls. It is never logged or placed in error context.
 */

/**
 * Minimal keytar surface. Production wires this to the real `keytar`
 * package; tests inject a Map-backed fake.
 */

import { trackKeychainBackend } from '../keychain/api.js';
export interface KeychainBackend {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

/** Keychain service + account for the Anthropic API key. */
export const KEYCHAIN_SERVICE = 'OneReach.ai-Anthropic';
export const KEYCHAIN_ACCOUNT = 'anthropic-api-key';

let _defaultBackend: KeychainBackend | null = null;

/**
 * Should this process get an inert keychain backend?
 *
 * Precedence: LITE_KEYCHAIN=1 (explicit opt-in, wins so a sign-in test
 * can beat the harness default) > LITE_NO_KEYCHAIN=1 (explicit opt-out;
 * e2e harness + release smoke) > agent-shell default-off.
 *
 * Agent-shell default-off (2026-08-20, FIFTH keytar SIGABRT of the day):
 * every crashed launch came from a Claude-session shell (CLAUDECODE=1)
 * running an unpackaged or ad-hoc binary whose signature matches no
 * Keychain ACL — keytar then throws a C++ exception past the NAPI
 * boundary and abort()s. A rule in project memory cannot reach sessions
 * that never read memory; an env discriminator reaches every one. The
 * user's own terminal launches carry no CLAUDECODE and keep the vault;
 * packaged builds are untouched (stable ACL).
 */
function keychainInert(): boolean {
  if (process.env['LITE_KEYCHAIN'] === '1') return false;
  if (process.env['LITE_NO_KEYCHAIN'] === '1') return true;
  if (process.env['CLAUDECODE'] !== undefined) {
    let packaged = false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
      packaged = (require('electron') as { app?: { isPackaged?: boolean } }).app?.isPackaged === true;
    } catch {
      // Plain node (unit tests) — unpackaged by definition.
    }
    if (!packaged) return true;
  }
  return false;
}

function defaultKeychainBackend(): KeychainBackend {
  if (keychainInert()) {
    // Inert backend — see keychainInert() above for the why.
    if (_defaultBackend === null) {
      _defaultBackend = {
        setPassword: async () => undefined,
        getPassword: async () => null,
        deletePassword: async () => false,
      };
    }
    return _defaultBackend;
  }
  if (_defaultBackend === null) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    // ADR-075: every keytar call is tracked so quit can drain
    // in-flight keychain work before Node teardown (see lite/keychain/).
    _defaultBackend = trackKeychainBackend(require('keytar') as KeychainBackend);
  }
  return _defaultBackend;
}

/** @internal -- tests reset the cached keytar binding. */
export function _resetKeychainBackendForTesting(): void {
  _defaultBackend = null;
}

/**
 * Anthropic key store. Tiny surface: save / get / has / delete. Every
 * method soft-fails (keytar errors → treated as "no key") so a broken
 * Keychain never crashes the app — the config loader just falls back to
 * env / ai-config.json.
 */
export class AnthropicKeyStore {
  private readonly keychain: KeychainBackend;

  constructor(keychain?: KeychainBackend) {
    this.keychain = keychain ?? defaultKeychainBackend();
  }

  /** Persist the key. Trims; rejects empty. */
  async saveKey(key: string): Promise<void> {
    const trimmed = typeof key === 'string' ? key.trim() : '';
    if (trimmed.length === 0) {
      throw new Error('Anthropic API key cannot be empty.');
    }
    await this.keychain.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, trimmed);
  }

  /**
   * Read the key, or null when absent / Keychain unavailable. Callers
   * (config loader) treat null as "not configured here" and fall back.
   */
  async getKey(): Promise<string | null> {
    try {
      const value = await this.keychain.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
      const trimmed = typeof value === 'string' ? value.trim() : '';
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  }

  /** Whether a key is configured. Never throws. */
  async hasKey(): Promise<boolean> {
    return (await this.getKey()) !== null;
  }

  /** Remove the key. Idempotent; no-op when absent. */
  async deleteKey(): Promise<void> {
    try {
      await this.keychain.deletePassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    } catch {
      /* best-effort -- a delete failure is non-fatal */
    }
  }
}
