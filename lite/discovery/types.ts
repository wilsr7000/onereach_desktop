/**
 * Discovery module -- shared types.
 *
 * The discovery module wraps `@or-sdk/discovery` so other Lite modules
 * can resolve OneReach service URLs (e.g. the per-account KV service)
 * at runtime instead of hardcoding endpoints. Per ADR (the lite-kv-via-sdk
 * chunk in `lite/PORTING.md`), this is the seam that lets every
 * subsequent SDK call ride on the signed-in user's `mult` token.
 *
 * Public types live here so both `api.ts` and `store.ts` reference
 * one source of truth.
 */

/**
 * One service registered in OneReach Service Discovery. Mirrors
 * `@or-sdk/discovery`'s `ServiceResponse` minus the SDK-specific
 * `versionJsonUrl` / `updatedAt` that consumers don't need.
 *
 * Lite consumers typically only care about `serviceKey` + `url`;
 * everything else is surfaced for diagnostic UIs.
 */
export interface DiscoveryService {
  /** Stable identifier (e.g. `'key-value-storage'`, `'flows'`). */
  serviceKey: string;
  /** Service category (`'sdk'`, `'ui'`, etc.). Maps to SDK `type`. */
  type: string;
  /** Resolved service URL when the registry includes one. */
  url?: string;
  /** Service version string. */
  version: string;
}
