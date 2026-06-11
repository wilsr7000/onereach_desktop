/**
 * Meeting Link Signing Keys
 *
 * Persistent per-install ECDSA P-256 keypair used to sign the meeting
 * token payloads that WISER Meeting stores in GSX KeyValue.
 *
 * Why: the KV endpoint accepts unauthenticated writes, so the guest page
 * must not trust whatever it reads there. Join links carry the public
 * key in the URL fragment (#k=...), and the guest page only accepts a
 * token payload whose signature verifies against that key. Overwriting
 * the KV entry without the host's private key can at worst deny a join —
 * it can no longer redirect guests to an attacker's LiveKit server.
 *
 * The keypair is persistent (not per-meeting) on purpose: "copy room
 * link" hands out links before the meeting has started, so the public
 * key must be stable across meetings on this install.
 *
 * ECDSA P-256 (not Ed25519) because the guest page verifies with
 * WebCrypto in whatever browser a guest happens to use, and P-256 has
 * universal WebCrypto support. Node's webcrypto produces the same
 * P1363 (r||s) signature format browsers verify.
 */

const { webcrypto } = require('crypto');
const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

const SETTINGS_KEY = 'meetingLinkSigningKeyV1';
const EC_PARAMS = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_PARAMS = { name: 'ECDSA', hash: 'SHA-256' };

// Cached { publicKeyB64u, privateKey: CryptoKey } and the in-flight
// loader so concurrent callers don't both generate a keypair.
let cached = null;
let loading = null;

function b64u(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

async function _generateAndPersist(settings) {
  const pair = await webcrypto.subtle.generateKey(EC_PARAMS, true, ['sign', 'verify']);
  const publicKeyRaw = await webcrypto.subtle.exportKey('raw', pair.publicKey);
  const privateKeyJwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey);
  const record = { publicKeyRaw: b64u(publicKeyRaw), privateKeyJwk };
  settings.set(SETTINGS_KEY, JSON.stringify(record));
  log.info('recorder', 'Meeting link signing keypair generated', {});
  return { publicKeyB64u: record.publicKeyRaw, privateKey: pair.privateKey };
}

async function _load() {
  const settings = global.settingsManager;
  if (!settings) throw new Error('Settings manager not available for meeting link keys');

  const stored = settings.get(SETTINGS_KEY);
  if (stored) {
    try {
      const record = typeof stored === 'string' ? JSON.parse(stored) : stored;
      if (record?.publicKeyRaw && record?.privateKeyJwk) {
        const privateKey = await webcrypto.subtle.importKey('jwk', record.privateKeyJwk, EC_PARAMS, false, ['sign']);
        return { publicKeyB64u: record.publicKeyRaw, privateKey };
      }
    } catch (err) {
      log.warn('recorder', 'Stored meeting link keypair unreadable; regenerating', { error: err.message });
    }
  }
  return _generateAndPersist(settings);
}

/**
 * Get (or lazily create) the install's signing keypair.
 * @returns {Promise<{ publicKeyB64u: string, privateKey: CryptoKey }>}
 */
async function getOrCreateKeyPair() {
  if (cached) return cached;
  if (!loading) {
    loading = _load()
      .then((pair) => {
        cached = pair;
        return pair;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

/**
 * Base64url-encoded raw (uncompressed point) P-256 public key — this is
 * the value that rides in join links as #k=...
 */
async function getPublicKeyB64u() {
  return (await getOrCreateKeyPair()).publicKeyB64u;
}

/**
 * Sign a payload string (UTF-8 bytes) and return the base64url P1363
 * signature the guest page verifies with WebCrypto.
 * @param {string} payloadString
 */
async function signPayload(payloadString) {
  const { privateKey } = await getOrCreateKeyPair();
  const sig = await webcrypto.subtle.sign(SIGN_PARAMS, privateKey, Buffer.from(payloadString, 'utf8'));
  return b64u(sig);
}

/**
 * Drop the persisted keypair so the next call generates a fresh one.
 * Rotation breaks previously shared links — callers own that warning.
 */
function resetKeyPair() {
  cached = null;
  loading = null;
  global.settingsManager?.set(SETTINGS_KEY, '');
  log.info('recorder', 'Meeting link signing keypair reset', {});
}

module.exports = {
  getOrCreateKeyPair,
  getPublicKeyB64u,
  signPayload,
  resetKeyPair,
};
