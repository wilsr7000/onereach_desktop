/**
 * NEON bridge — CORS origin allowlist. Per ADR-081.
 *
 * The bridge exposes the org Digital Twin's viewer-gated reads over
 * loopback HTTP so the app's own web apps can read it without embedding
 * the cloud endpoint. But the local servers historically sent
 * `Access-Control-Allow-Origin: *` — which would let ANY website open in
 * the user's browser read the org graph via localhost. This module is
 * the fence: only the app's own hosted origins (and localhost dev) are
 * allowed; every other origin is refused (2026-08-31 decision).
 *
 * Pure + injectable so the policy is unit-tested independently of the
 * HTTP server.
 */

/**
 * The app's own web-app origins. The hosted builds (journey-map builder,
 * WISER riff, IDW pages) all live under the Edison public-files origin;
 * localhost covers dev servers.
 */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  'https://files.edison.api.onereach.ai',
  'https://idw.edison.onereach.ai',
];

/**
 * Is this `Origin` header value allowed to call the bridge?
 *
 * - Exact match against the allowlist (scheme + host + optional port).
 * - Any `http://localhost` / `http://127.0.0.1` on any port (dev servers).
 * - `null` / empty (a non-browser caller: curl, an agent, the MCP
 *   aggregator) is allowed — the server binds loopback-only, so a
 *   caller with no Origin is already on this machine.
 *
 * Everything else is refused.
 */
export function isAllowedOrigin(
  origin: string | undefined | null,
  allowlist: readonly string[] = DEFAULT_ALLOWED_ORIGINS
): boolean {
  if (origin === undefined || origin === null || origin.length === 0) {
    return true; // non-browser, loopback-only
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    (host === 'localhost' || host === '127.0.0.1')
  ) {
    return true;
  }
  // Exact origin match (URL normalizes trailing slashes away in .origin).
  return allowlist.some((allowed) => {
    try {
      return new URL(allowed).origin === parsed.origin;
    } catch {
      return false;
    }
  });
}
