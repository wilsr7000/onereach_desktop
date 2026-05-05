# `lite/discovery/` -- Service URL resolver

Wraps `@or-sdk/discovery` so other Lite modules can resolve OneReach service URLs (KV, Flows, Bots, etc.) at runtime instead of hardcoding endpoints. This is the seam that lets every subsequent SDK call ride on the signed-in user's `mult` token.

- **Public API**: [`api.ts`](api.ts) -- `DiscoveryApi`, `getDiscoveryApi()`, `DiscoveryError`, `DISCOVERY_ERROR_CODES`
- **Internal**:
  - [`store.ts`](store.ts) -- `DiscoveryStore` SDK wrapper + cache (`@internal`)
  - [`types.ts`](types.ts) -- `DiscoveryService`
  - [`events.ts`](events.ts) -- typed event surface (ADR-032)
- **Tests**: [`../test/unit/discovery-api.test.ts`](../test/unit/discovery-api.test.ts), [`../test/unit/discovery-store.test.ts`](../test/unit/discovery-store.test.ts)

## Usage

```typescript
import { getDiscoveryApi } from '../discovery/api.js';

const kvUrl = await getDiscoveryApi().resolve('key-value-storage');
// 'https://...sdk-api.onereach.ai/keyvalue'
```

`resolve()` requires a signed-in user (token is read from `getAuthApi().getToken('edison')`). Signed-out callers see `DISCOVERY_NOT_AUTHENTICATED`.

## Caching

Resolved URLs are cached per `serviceKey` for 5 minutes. Calling `resolve('key-value-storage')` 100 times pays the discovery roundtrip once. `invalidateCache()` clears the cache (called on sign-out).

## Error catalog

| Code | When | Remediation |
|------|------|-------------|
| `DISCOVERY_NOT_AUTHENTICATED` | No `mult` token (user signed out) | Sign in via Settings -> Account |
| `DISCOVERY_NOT_FOUND` | Discovery returned 404 or no URL for the serviceKey | Confirm the serviceKey is registered |
| `DISCOVERY_HTTP` | Non-2xx, non-404 response (incl. 401/403) | Check token freshness; sign out + back in |
| `DISCOVERY_NETWORK` | Underlying fetch rejected (DNS / TCP / TLS) | Check network connectivity |

## Discovery URL

Edison uses `https://discovery.edison.api.onereach.ai`. Other environments (staging, dev, production) would land in `lite/auth/types.ts:ENVIRONMENT_CONFIGS` as part of the `auth-multi-env` chunk in `lite/PORTING.md`.

## Borrowed pattern

The construction shape (token getter + discoveryUrl) mirrors `lib/edison-sdk-manager.js:298-308` -- the full app's pattern, studied but not imported (per `lite/LITE-RULES.md`).
