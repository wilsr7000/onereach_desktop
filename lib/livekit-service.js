/**
 * LiveKit Service
 *
 * Server-side (main process) service for LiveKit room and token management.
 * Used by WISER Meeting to create rooms and generate participant tokens.
 *
 * Credentials are read from settingsManager with hardcoded defaults.
 */

const { AccessToken } = require('livekit-server-sdk');
const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

// Default credentials (can be overridden in settings)
const DEFAULTS = {
  url: 'wss://gsx-desktop-1dlj9n62.livekit.cloud',
  apiKey: 'APIMtjfTgxua3e8',
  apiSecret: 'a7uhU7ami2kHW2KduB4lpiE4wht5pMZsmQeglWeCFXx',
};

/**
 * Get LiveKit credentials from settings or defaults.
 * @returns {{ url: string, apiKey: string, apiSecret: string }}
 */
function getCredentials() {
  const settings = global.settingsManager;
  return {
    url: settings?.get('livekitUrl') || DEFAULTS.url,
    apiKey: settings?.get('livekitApiKey') || DEFAULTS.apiKey,
    apiSecret: settings?.get('livekitApiSecret') || DEFAULTS.apiSecret,
  };
}

/**
 * Generate a LiveKit access token for a participant.
 *
 * @param {string} roomName - Room to join
 * @param {string} identity - Unique participant identity (e.g. 'host', 'guest-1')
 * @param {Object} [options]
 * @param {boolean} [options.isHost=false] - Host gets admin permissions + longer TTL
 * @param {string} [options.ttl='2h'] - Token time-to-live
 * @returns {Promise<string>} Signed JWT token
 */
async function generateToken(roomName, identity, options = {}) {
  const { apiKey, apiSecret } = getCredentials();
  const isHost = options.isHost || false;
  const ttl = options.ttl || (isHost ? '24h' : '2h');

  const at = new AccessToken(apiKey, apiSecret, {
    identity,
    ttl,
  });

  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    roomAdmin: isHost,
  });

  const token = await at.toJwt();
  log.info('recorder', 'LiveKit token generated', { roomName, identity, isHost });
  return token;
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
  const { url } = getCredentials();

  // Generate host token + guest token pool in parallel
  const guestPromises = [];
  for (let i = 0; i < guestCount; i++) {
    guestPromises.push(generateToken(roomName, `guest-${i}`, { isHost: false }));
  }

  const [hostToken, ...guestTokens] = await Promise.all([
    generateToken(roomName, 'host', { isHost: true }),
    ...guestPromises,
  ]);

  log.info('recorder', 'LiveKit room created', { roomName, livekitUrl: url, guestTokenCount: guestTokens.length });

  return {
    roomName,
    hostToken,
    guestTokens,
    livekitUrl: url,
  };
}

/**
 * Save LiveKit credentials to settings.
 * @param {string} url
 * @param {string} apiKey
 * @param {string} apiSecret
 */
function saveCredentials(url, apiKey, apiSecret) {
  const settings = global.settingsManager;
  if (!settings) return;
  if (url) settings.set('livekitUrl', url);
  if (apiKey) settings.set('livekitApiKey', apiKey);
  if (apiSecret) settings.set('livekitApiSecret', apiSecret);
  log.info('recorder', 'LiveKit credentials saved');
}

module.exports = {
  getCredentials,
  generateToken,
  createRoom,
  saveCredentials,
};
