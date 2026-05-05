/**
 * Discovery module -- PUBLIC API.
 *
 * The only file other lite modules should import from in this module.
 * Per ADR-019 / Rule 11 in `lite/LITE-RULES.md`, cross-module imports
 * go through `<module>/api.ts` -- never reach into `store.ts` or any
 * other internal file.
 *
 * Wraps `@or-sdk/discovery` so other modules can resolve OneReach
 * service URLs (KV, Flows, Bots, etc.) without importing the SDK.
 *
 * Usage from another module (main process only):
 *
 *   import { getDiscoveryApi } from '../discovery/api.js';
 *   const url = await getDiscoveryApi().resolve('key-value-storage');
 *
 * Tests: `_setDiscoveryApiForTesting(stub)` to inject a custom
 * implementation, `_resetDiscoveryApiForTesting()` to clear the
 * singleton.
 */

import { DiscoveryStore, DISCOVERY_ERROR_CODES, DiscoveryError } from './store.js';
import type { StoreConfig } from './store.js';
import { getAuthApi } from '../auth/api.js';
import { ENVIRONMENT_CONFIGS } from '../auth/types.js';
import { getLoggingApi } from '../logging/api.js';

// Re-export the public types consumers need.
export type { DiscoveryService } from './types.js';

// Re-export the structured error class + code catalog.
export type { DiscoveryErrorCode, DiscoveryErrorOptions } from './store.js';
export { DiscoveryError, DISCOVERY_ERROR_CODES } from './store.js';

// Per-module typed event surface (ADR-032).
export {
  DISCOVERY_EVENTS,
  isDiscoveryEvent,
  type DiscoveryEvent,
  type DiscoveryEventName,
  type DiscoveryResolveStartEvent,
  type DiscoveryResolveFinishEvent,
  type DiscoveryResolveFailEvent,
  type DiscoveryListStartEvent,
  type DiscoveryListFinishEvent,
  type DiscoveryListFailEvent,
  type DiscoveryCacheHitEvent,
} from './events.js';

// Generic base class -- consumers can also catch via `instanceof LiteError`
// if they want to handle errors uniformly across all lite modules.
export { LiteError, isLiteError } from '../errors.js';

import type { DiscoveryService } from './types.js';
import type { DiscoveryEvent } from './events.js';
import { isDiscoveryEvent } from './events.js';
import type { EventRecord } from '../logging/events.js';

/**
 * The public surface of the discovery module.
 *
 * **Error contract**: `resolve()` and `list()` throw `DiscoveryError`
 * (extends `LiteError`) on failure. Inspect `.code`:
 * `DISCOVERY_NOT_AUTHENTICATED`, `DISCOVERY_NOT_FOUND`,
 * `DISCOVERY_HTTP`, `DISCOVERY_NETWORK`.
 *
 * **Caching**: `resolve()` is cached per serviceKey (5-minute TTL by
 * default) so cold-start cost is paid once per service per session.
 */
export interface DiscoveryApi {
  /**
   * Resolve a serviceKey to its base URL. Cached per serviceKey.
   *
   * @param serviceKey Stable identifier (e.g. `'key-value-storage'`).
   * @returns The service base URL.
   * @throws {DiscoveryError} `DISCOVERY_NOT_AUTHENTICATED` when no token.
   * @throws {DiscoveryError} `DISCOVERY_NOT_FOUND` when the key isn't registered.
   * @throws {DiscoveryError} `DISCOVERY_HTTP` | `DISCOVERY_NETWORK` on transport failure.
   */
  resolve(serviceKey: string): Promise<string>;

  /**
   * List every service registered for the active account. Diagnostic
   * use only; feature modules should call `resolve()` directly.
   */
  list(): Promise<DiscoveryService[]>;

  /**
   * Drop the in-memory resolve cache. Call this on sign-out so a
   * subsequent sign-in (potentially as a different user) re-queries
   * discovery instead of reusing stale URLs.
   */
  invalidateCache(): void;

  /**
   * Subscribe to typed discovery events (ADR-032). Branch on `ev.name`
   * for type-narrowed access.
   */
  onEvent(handler: (event: DiscoveryEvent) => void): () => void;
}

let _instance: DiscoveryApi | null = null;

/**
 * Get the singleton discovery API. Lazily instantiates on first call.
 *
 * Default backing implementation is `DiscoveryStore` wired to:
 *   - the auth module's `getToken('edison')` (signed-in user's mult)
 *   - the env-specific `discoveryUrl` from `ENVIRONMENT_CONFIGS`
 */
export function getDiscoveryApi(): DiscoveryApi {
  if (_instance === null) {
    _instance = new DiscoveryStoreApiAdapter(new DiscoveryStore(defaultConfig()));
  }
  return _instance;
}

/** Reset the singleton (for tests). */
export function _resetDiscoveryApiForTesting(): void {
  _instance = null;
}

/**
 * Override the singleton with a custom implementation (for tests).
 * Useful when consumers want to inject a stub Discovery without
 * standing up the real SDK.
 */
export function _setDiscoveryApiForTesting(api: DiscoveryApi): void {
  _instance = api;
}

/**
 * @internal -- exposed so tests that want a real DiscoveryStore can
 * pass a custom config (e.g. shorter cache TTL, a fake SDK ctor)
 * without going through the singleton.
 */
export function _buildDiscoveryApiForTesting(config: StoreConfig): DiscoveryApi {
  return new DiscoveryStoreApiAdapter(new DiscoveryStore(config));
}

// ─── default implementation ──────────────────────────────────────────────

/**
 * Adapter that exposes the public API surface on top of the internal
 * `DiscoveryStore`. Same pattern as other lite modules (idw, neon,
 * main-window) -- keeps the store class private and lets api.ts
 * decide what's exported.
 */
class DiscoveryStoreApiAdapter implements DiscoveryApi {
  constructor(private readonly store: DiscoveryStore) {}

  resolve(serviceKey: string): Promise<string> {
    return this.store.resolve(serviceKey);
  }

  list(): Promise<DiscoveryService[]> {
    return this.store.list();
  }

  invalidateCache(): void {
    this.store.invalidateCache();
  }

  onEvent(handler: (event: DiscoveryEvent) => void): () => void {
    return getLoggingApi().onEvent('discovery.*', (ev: EventRecord) => {
      if (isDiscoveryEvent(ev)) {
        handler(ev as unknown as DiscoveryEvent);
      }
    });
  }
}

function defaultConfig(): StoreConfig {
  const edisonConfig = ENVIRONMENT_CONFIGS['edison'];
  if (edisonConfig === undefined) {
    // Should be impossible -- ENVIRONMENT_CONFIGS always defines edison
    // in v1. Throw a typed error so callers see it loudly.
    throw new DiscoveryError({
      code: DISCOVERY_ERROR_CODES.NOT_FOUND,
      message: 'No EnvironmentConfig found for edison; cannot construct discovery client.',
      context: {},
    });
  }
  return {
    token: () => getAuthApi().getToken('edison') ?? '',
    discoveryUrl: edisonConfig.discoveryUrl,
    logger: (level, message, data) => {
      const log = getLoggingApi();
      log[level]('discovery', message, data);
    },
    spanEmitter: (name, data) => getLoggingApi().start(name, data),
  };
}
