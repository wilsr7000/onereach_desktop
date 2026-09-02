/**
 * Session identity for out-of-process MCP servers (2026-09-01 identity
 * audit: "make sure all APIs are tied to the users that log in").
 *
 * spaces-mcp and local-api-mcp run OUTSIDE the app (Claude Code spawns
 * them over stdio), so they cannot read the app's session directly.
 * Before this they took their viewer identity from an env var in
 * .mcp.json — a CLAIMED identity, hand-set, never authenticated.
 *
 * Resolution order, strongest first:
 *   1. The running app's NEON bridge `GET /neon/whoami` — the
 *      AUTHENTICATED signed-in viewer (loopback, short deadline).
 *   2. The env var (SPACES_VIEWER_ID / LOCAL_API_VIEWER_ID) — a dev
 *      fallback for when the app isn't running; logged LOUDLY so it is
 *      never silently the source.
 *   3. Nothing → throw. Fail closed: no identity, no access (ADR-051).
 */

export type ViewerSource = 'app-session' | 'env';

export interface ResolveViewerOptions {
  env: Record<string, string | undefined>;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  bridgeUrl?: string;
  timeoutMs?: number;
  /** Where to narrate the decision (stderr in the MCP servers). */
  log?: (message: string) => void;
}

export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:47294';
const ENV_KEYS = ['SPACES_VIEWER_ID', 'LOCAL_API_VIEWER_ID'] as const;

export async function resolveSessionViewer(
  opts: ResolveViewerOptions
): Promise<{ viewerId: string; source: ViewerSource }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const bridgeUrl = (opts.bridgeUrl ?? opts.env.LITE_BRIDGE_URL ?? DEFAULT_BRIDGE_URL).replace(/\/$/, '');
  const log = opts.log ?? (() => undefined);

  // 1. The signed-in app session, via the bridge.
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 1500);
    try {
      const res = await fetchImpl(`${bridgeUrl}/neon/whoami`, { signal: ctl.signal });
      if (res.ok) {
        const body = (await res.json()) as { viewerId?: unknown };
        if (typeof body.viewerId === 'string' && body.viewerId.trim().length > 0) {
          log(`identity: signed-in app session (${body.viewerId})`);
          return { viewerId: body.viewerId.trim(), source: 'app-session' };
        }
        log('identity: app is running but signed out');
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    log('identity: app bridge not reachable');
  }

  // 2. Env fallback — loud.
  for (const key of ENV_KEYS) {
    const v = opts.env[key];
    if (typeof v === 'string' && v.trim().length > 0) {
      log(`identity: WARNING — using ${key} from env (${v.trim()}); this is a claimed identity, not the signed-in session. Start Onereach.ai Lite and sign in to bind to the real user.`);
      return { viewerId: v.trim(), source: 'env' };
    }
  }

  // 3. Fail closed.
  throw new Error(
    'No viewer identity: sign in to Onereach.ai Lite (so the bridge on 47294 can vouch for you), or set SPACES_VIEWER_ID for local development.'
  );
}
