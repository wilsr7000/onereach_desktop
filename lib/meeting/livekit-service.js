/**
 * LiveKit Service
 *
 * Server-side (main process) service for LiveKit room and token management.
 * Used by WISER Meeting to create rooms and generate participant tokens.
 *
 * Credential sources, in precedence order:
 *   1. Server-side mint — settings key `livekitMintUrl` points at a GSX
 *      function that holds the LiveKit secret and returns ready-made
 *      tokens. The desktop app never sees the API secret.
 *   2. Per-account credentials — settings keys `livekitUrl`,
 *      `livekitApiKey`, `livekitApiSecret` (the install brings its own
 *      LiveKit Cloud project).
 *   3. Legacy shared project — LEGACY_SHARED_CREDENTIALS below, so
 *      hosting works out of the box with zero configuration.
 *
 * The legacy pair has shipped inside every build, so treat it as PUBLIC:
 * anyone can mint admin tokens for rooms on that shared project.
 * Decision 2026-06-10: keep it as the fallback anyway — meeting hosting
 * must stay fully functional as-is until the mint function is deployed
 * and the key is rotated (docs/internal/WISER-MEETING-SECURITY.md §3).
 * After rotation: delete LEGACY_SHARED_CREDENTIALS and the allowlist
 * entry in test/unit/leaked-credential-scan.test.js; hosting then
 * requires mode 1 or 2. That scan keeps the pair contained to this one
 * file in the meantime.
 */

const { AccessToken } = require('livekit-server-sdk');
const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

const LEGACY_SHARED_CREDENTIALS = {
  url: 'wss://gsx-desktop-1dlj9n62.livekit.cloud',
  apiKey: 'APIMtjfTgxua3e8',
  apiSecret: 'a7uhU7ami2kHW2KduB4lpiE4wht5pMZsmQeglWeCFXx',
};

const MINT_TIMEOUT_MS = 30000;

// Test seam: unit tests inject a token provider because the real
// gsx-flow-context is wired to the Electron session. Production code
// leaves this null and uses gsx-flow-context.getAuthToken().
let authTokenProvider = null;
function _setAuthTokenProviderForTests(fn) {
  authTokenProvider = fn;
}

const SETUP_HINT =
  'WISER Meeting is not configured for hosting. Set "livekitMintUrl" (recommended, see ' +
  'docs/internal/WISER-MEETING-SECURITY.md) or "livekitUrl"/"livekitApiKey"/"livekitApiSecret" in settings.';

let warnedLegacy = false;

/**
 * Get LiveKit credentials for local token minting. A complete per-account
 * set in settings wins; otherwise the legacy shared project applies (no
 * mixing — partial settings fall back wholesale so url/key/secret always
 * belong together).
 *
 * @returns {{ url: string, apiKey: string, apiSecret: string } | null}
 *   null only when no fallback exists (post-rotation builds).
 */
function getCredentials() {
  const settings = global.settingsManager;
  const url = settings?.get('livekitUrl') || '';
  const apiKey = settings?.get('livekitApiKey') || '';
  const apiSecret = settings?.get('livekitApiSecret') || '';
  if (url && apiKey && apiSecret) return { url, apiKey, apiSecret };
  return { ...LEGACY_SHARED_CREDENTIALS };
}

/**
 * URL of the server-side mint endpoint (GSX function), or '' when unset.
 */
function getMintUrl() {
  const url = global.settingsManager?.get('livekitMintUrl') || '';
  return typeof url === 'string' && /^https:\/\//.test(url) ? url : '';
}

/**
 * Which hosting mode is configured: 'server-mint', 'local', or
 * 'legacy-shared' (the zero-config fallback; see file header).
 */
function getConfiguredMode() {
  if (getMintUrl()) return 'server-mint';
  const creds = getCredentials();
  if (!creds) return null;
  return creds.apiKey === LEGACY_SHARED_CREDENTIALS.apiKey ? 'legacy-shared' : 'local';
}

/**
 * Generate a LiveKit access token locally (per-account or legacy
 * credentials — never used in server-mint mode).
 *
 * @param {string} roomName - Room to join
 * @param {string} identity - Unique participant identity (e.g. 'host', 'guest-1')
 * @param {Object} [options]
 * @param {boolean} [options.isHost=false] - Host gets admin permissions + longer TTL
 * @param {string} [options.ttl='12h'] - Token time-to-live
 * @returns {Promise<string>} Signed JWT token
 */
async function generateToken(roomName, identity, options = {}) {
  const creds = getCredentials();
  if (!creds) throw new Error(SETUP_HINT);
  const isHost = options.isHost || false;
  // 12h guest TTL: tokens are minted when the room is created, so a short
  // TTL starves anyone joining late in a long meeting.
  const ttl = options.ttl || (isHost ? '24h' : '12h');

  const at = new AccessToken(creds.apiKey, creds.apiSecret, {
    identity,
    ttl,
  });

  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    canUpdateOwnMetadata: true,
    roomAdmin: isHost,
  });

  const token = await at.toJwt();
  log.info('recorder', 'LiveKit token generated', { roomName, identity, isHost });
  return token;
}

/**
 * Mint room tokens via the server-side GSX function. The function holds
 * the LiveKit secret and authenticates the caller with the same GSX auth
 * token the rest of the app uses (`n` header).
 *
 * @param {string} roomName
 * @param {number} guestCount
 * @returns {Promise<{ roomName: string, hostToken: string, guestTokens: string[], livekitUrl: string }>}
 */
async function mintRoomViaServer(roomName, guestCount) {
  const mintUrl = getMintUrl();
  const authToken = authTokenProvider
    ? authTokenProvider()
    : require('../gsx-flow-context').getAuthToken();
  if (!authToken) {
    throw new Error('Sign in to GSX before hosting a meeting (no auth token for the LiveKit mint service).');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MINT_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(mintUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', n: authToken },
      body: JSON.stringify({ roomName, guestCount }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`LiveKit mint service unreachable: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    throw new Error(`LiveKit mint service returned ${resp.status}${resp.status === 401 || resp.status === 403 ? ' (GSX sign-in may have expired)' : ''}`);
  }

  const data = await resp.json();
  const valid =
    data &&
    typeof data.hostToken === 'string' &&
    data.hostToken &&
    Array.isArray(data.guestTokens) &&
    data.guestTokens.length > 0 &&
    data.guestTokens.every((t) => typeof t === 'string' && t) &&
    typeof data.livekitUrl === 'string' &&
    /^wss:\/\//.test(data.livekitUrl);
  if (!valid) throw new Error('LiveKit mint service returned an invalid response.');

  log.info('recorder', 'LiveKit room minted server-side', {
    roomName,
    livekitUrl: data.livekitUrl,
    guestTokenCount: data.guestTokens.length,
  });
  return {
    roomName,
    hostToken: data.hostToken,
    guestTokens: data.guestTokens,
    livekitUrl: data.livekitUrl,
  };
}

/**
 * Create a WISER Meeting room and generate tokens for host + a pool of guests.
 *
 * Each guest token has a unique identity (guest-0 … guest-N) so multiple
 * people can join the same room without kicking each other out.
 *
 * @param {string} roomName - Room name (derived from space name)
 * @param {number} [guestCount=200] - Number of guest tokens to pre-generate
 * @returns {Promise<{ roomName: string, hostToken: string, guestTokens: string[], livekitUrl: string }>}
 */
async function createRoom(roomName, guestCount = 200) {
  if (getMintUrl()) {
    return mintRoomViaServer(roomName, guestCount);
  }

  const creds = getCredentials();
  if (!creds) throw new Error(SETUP_HINT);
  if (creds.apiKey === LEGACY_SHARED_CREDENTIALS.apiKey && !warnedLegacy) {
    warnedLegacy = true;
    log.warn('recorder', 'Hosting on the legacy shared LiveKit project (credential is public — see docs/internal/WISER-MEETING-SECURITY.md). Configure livekitMintUrl or per-account credentials.', {});
  }

  // Generate host token + guest token pool in parallel
  const guestPromises = [];
  for (let i = 0; i < guestCount; i++) {
    guestPromises.push(generateToken(roomName, `guest-${i}`, { isHost: false }));
  }

  const [hostToken, ...guestTokens] = await Promise.all([
    generateToken(roomName, 'host', { isHost: true }),
    ...guestPromises,
  ]);

  log.info('recorder', 'LiveKit room created', { roomName, livekitUrl: creds.url, guestTokenCount: guestTokens.length });

  return {
    roomName,
    hostToken,
    guestTokens,
    livekitUrl: creds.url,
  };
}

/**
 * Save LiveKit credentials to settings.
 * @param {string} url
 * @param {string} apiKey
 * @param {string} apiSecret
 * @returns {boolean} true when saved
 */
function saveCredentials(url, apiKey, apiSecret) {
  const settings = global.settingsManager;
  if (!settings) return false;
  if (url) settings.set('livekitUrl', url);
  if (apiKey) settings.set('livekitApiKey', apiKey);
  if (apiSecret) settings.set('livekitApiSecret', apiSecret);
  log.info('recorder', 'LiveKit credentials saved');
  return true;
}

/**
 * Who is in the room right now, per the LiveKit SERVER (authoritative —
 * includes web guests). Returns [{ identity, name }] or null on any
 * failure (missing creds, network, room not found) so callers can skip
 * a beat quietly — the roster is garnish, never load-bearing.
 */
async function listParticipants(roomName) {
  try {
    const creds = getCredentials();
    if (!creds) return null;
    const { RoomServiceClient } = require('livekit-server-sdk');
    const httpUrl = creds.url.replace(/^wss:/, 'https:');
    const svc = new RoomServiceClient(httpUrl, creds.apiKey, creds.apiSecret);
    const parts = await svc.listParticipants(roomName);
    return parts.map((p) => ({
      identity: String(p.identity || ''),
      name: String(p.name || p.identity || ''),
    }));
  } catch {
    return null;
  }
}

module.exports = {
  getCredentials,
  getConfiguredMode,
  generateToken,
  createRoom,
  listParticipants,
  saveCredentials,
  _setAuthTokenProviderForTests,
};
