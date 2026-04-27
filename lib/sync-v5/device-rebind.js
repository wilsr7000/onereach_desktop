/**
 * Device rebind ops (v5 Section 4.2)
 *
 * vector-clock slots are keyed by deviceId. Without rebind, slots from
 * dead devices accumulate forever in every entity's vc. Rebind reassigns
 * a slot from an old deviceId to a new one when:
 *
 *   Path A (live handoff): the old device is alive and signs a transfer
 *     payload with its keychain key. The new device submits a :DeviceRebind
 *     op carrying the signed payload. The graph validates the signature
 *     using the old device's registered public key, then rewrites every
 *     entity's vc map: `vc[oldDeviceId]` -> `vc[newDeviceId]`.
 *
 *   Path B (user-attested): OS reinstall, disk failure, Time Machine
 *     restore. The old device is gone. The user authenticates to GSX,
 *     declares "this is the same me", and the graph writes a rebind
 *     attestation. Same vc-rewrite happens; the trust root is the
 *     authenticated user identity rather than a key signature.
 *
 * Phase 3 ships:
 *   - the data shapes and Cypher constants
 *   - Path A signature verification (Ed25519 via Node crypto -- no native dep)
 *   - Path B attestation handler (with auth function as injected dep)
 *   - the vc-rewrite Cypher that runs in the same tx as the :DeviceRebind
 *     write, so rebind is atomic across the graph
 *
 * Phase 3 does NOT ship:
 *   - keychain integration on the device side (Phase 0/auth effort)
 *   - GSX user authentication (Phase 0/auth effort)
 *   - the registered-public-key store (graph-side, but a separate :PublicKey
 *     node type that's a Phase 5 schema migration)
 *
 * Until those land, this module is callable in test mode (deps injected)
 * but the production trust path requires the auth substrate. Marked
 * accordingly.
 */

'use strict';

const crypto = require('crypto');

const vc = require('./vector-clock');
const { newTraceId, isValidTraceId } = require('./trace-id');
const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

const REBIND_PATH = Object.freeze({
  LIVE_HANDOFF: 'live-handoff',
  USER_ATTESTED: 'user-attested',
});

// ────────────────────────────────────────────────────────────────────────────
// Cypher constants
// ────────────────────────────────────────────────────────────────────────────

/**
 * Atomically write the :DeviceRebind audit node AND rewrite every vc map
 * across all :Asset nodes that reference the old deviceId. The rewrite is
 * done in one statement so the graph never sees a partial state where
 * some entities have the old slot and some have the new.
 *
 * Param shape:
 *   $traceId, $fromDeviceId, $toDeviceId, $path, $attestation,
 *   $signedPayload, $signature, $at
 *
 * Note: the `apoc.map` call is a placeholder that requires the APOC
 * extension on Aura (Aura ships with APOC by default). If APOC isn't
 * available, the rewrite must happen client-side in a read-modify-write
 * transaction; the structure stays similar.
 */
const CYPHER_DEVICE_REBIND = `
  CREATE (rb:DeviceRebind {
    traceId: $traceId,
    fromDeviceId: $fromDeviceId,
    toDeviceId: $toDeviceId,
    path: $path,
    attestation: $attestation,
    signedPayload: $signedPayload,
    signature: $signature,
    at: datetime($at)
  })
  WITH rb
  MATCH (a:Asset)
  WHERE a.vc IS NOT NULL AND a.vc[$fromDeviceId] IS NOT NULL
  SET a.vc = apoc.map.removeKey(
    apoc.map.merge(a.vc, {[$toDeviceId]: a.vc[$fromDeviceId]}),
    $fromDeviceId
  )
  RETURN count(a) AS rewrittenAssets, rb.traceId AS traceId
`;

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

/**
 * Path A: build a rebind payload for the OLD device to sign with its
 * keychain-resident private key. The payload is deterministic so the
 * graph can verify the signature against the registered public key.
 *
 * @param {object} args
 * @param {string} args.fromDeviceId
 * @param {string} args.toDeviceId
 * @param {string} [args.at]  -- ISO; defaults to now
 * @returns {{ traceId:string, payload:string, payloadHash:string }}
 */
function buildRebindPayload({ fromDeviceId, toDeviceId, at }) {
  if (!fromDeviceId || !toDeviceId) {
    throw new Error('buildRebindPayload: fromDeviceId and toDeviceId required');
  }
  if (fromDeviceId === toDeviceId) {
    throw new Error('buildRebindPayload: fromDeviceId and toDeviceId must differ');
  }
  const traceId = newTraceId();
  // Deterministic JSON: keys sorted, no whitespace.
  const payloadObj = {
    fromDeviceId,
    toDeviceId,
    transferredAt: at || new Date().toISOString(),
    traceId,
    v: 1,
  };
  const payload = JSON.stringify(_sortedKeys(payloadObj));
  const payloadHash = crypto.createHash('sha256').update(payload).digest('hex');
  return { traceId, payload, payloadHash };
}

/**
 * Verify a Path A signature.
 *
 * @param {object} args
 * @param {string} args.payload      -- the canonical payload string
 * @param {string} args.signature    -- base64 signature from the old device
 * @param {string|Buffer} args.publicKeyPem -- the registered Ed25519 / RSA pub key
 * @returns {boolean}
 */
function verifyHandoffSignature({ payload, signature, publicKeyPem }) {
  if (!payload || typeof payload !== 'string') return false;
  if (!signature || typeof signature !== 'string') return false;
  if (!publicKeyPem) return false;
  try {
    const verifier = crypto.createVerify('SHA256');
    verifier.update(payload);
    verifier.end();
    return verifier.verify(publicKeyPem, signature, 'base64');
  } catch (err) {
    log.warn('sync-v5', 'rebind signature verify threw', { error: err.message });
    return false;
  }
}

/**
 * Submit a Path A (live handoff) rebind. The new device builds the
 * payload via buildRebindPayload, has the OLD device sign it (over IPC,
 * Bluetooth, QR scan, etc. -- transport is out of scope), then calls this.
 *
 * @param {object} args
 * @param {string} args.fromDeviceId
 * @param {string} args.toDeviceId
 * @param {string} args.payload
 * @param {string} args.signature -- base64
 * @param {string|Buffer} args.publicKeyPem
 * @param {object} [opts]
 * @param {object} [opts.omniClient]
 * @returns {Promise<{success:boolean, rewrittenAssets:number, traceId:string|null, error:string|null}>}
 */
async function submitLiveHandoff(args, opts = {}) {
  const { fromDeviceId, toDeviceId, payload, signature, publicKeyPem } = args || {};
  const verified = verifyHandoffSignature({ payload, signature, publicKeyPem });
  if (!verified) {
    return { success: false, rewrittenAssets: 0, traceId: null, error: 'signature verification failed' };
  }
  // Re-parse the payload to recover the traceId and at fields, and to
  // verify fromDeviceId / toDeviceId match the args (defends against the
  // submitter swapping these client-side).
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch (_) {
    return { success: false, rewrittenAssets: 0, traceId: null, error: 'malformed payload' };
  }
  if (parsed.fromDeviceId !== fromDeviceId || parsed.toDeviceId !== toDeviceId) {
    return {
      success: false,
      rewrittenAssets: 0,
      traceId: null,
      error: 'payload deviceIds do not match args',
    };
  }
  return _submitRebind({
    traceId: parsed.traceId || newTraceId(),
    fromDeviceId,
    toDeviceId,
    path: REBIND_PATH.LIVE_HANDOFF,
    attestation: 'signature',
    signedPayload: payload,
    signature,
    at: parsed.transferredAt || new Date().toISOString(),
    omniClient: opts.omniClient,
  });
}

/**
 * Submit a Path B (user-attested) rebind. The user has authenticated to
 * GSX and asserted "this is the same me." The auth function is injected;
 * Phase 0 wires it to the real GSX auth.
 *
 * @param {object} args
 * @param {string} args.fromDeviceId
 * @param {string} args.toDeviceId
 * @param {string} args.userId   -- authenticated user identity
 * @param {string} [args.at]
 * @param {object} [opts]
 * @param {object} [opts.omniClient]
 * @param {(userId:string) => Promise<boolean>} [opts.verifyUserOwnsDevice]
 *   -- returns true if the authenticated userId is the same identity that
 *      registered fromDeviceId. Phase 0 plugs this into the real GSX auth;
 *      tests pass a fake.
 * @returns {Promise<{success:boolean, rewrittenAssets:number, traceId:string|null, error:string|null}>}
 */
async function submitUserAttested(args, opts = {}) {
  const { fromDeviceId, toDeviceId, userId, at } = args || {};
  if (!fromDeviceId || !toDeviceId || !userId) {
    return {
      success: false,
      rewrittenAssets: 0,
      traceId: null,
      error: 'fromDeviceId, toDeviceId, and userId required',
    };
  }
  if (fromDeviceId === toDeviceId) {
    return { success: false, rewrittenAssets: 0, traceId: null, error: 'fromDeviceId === toDeviceId' };
  }
  const verifier = opts.verifyUserOwnsDevice;
  if (typeof verifier !== 'function') {
    return {
      success: false,
      rewrittenAssets: 0,
      traceId: null,
      error: 'verifyUserOwnsDevice not provided -- Path B requires an auth substrate (Phase 0)',
    };
  }
  let owns;
  try {
    owns = await verifier(userId);
  } catch (err) {
    return { success: false, rewrittenAssets: 0, traceId: null, error: `auth check failed: ${err.message}` };
  }
  if (!owns) {
    return {
      success: false,
      rewrittenAssets: 0,
      traceId: null,
      error: 'authenticated user does not own fromDeviceId',
    };
  }
  return _submitRebind({
    traceId: newTraceId(),
    fromDeviceId,
    toDeviceId,
    path: REBIND_PATH.USER_ATTESTED,
    attestation: `user:${userId}`,
    signedPayload: null,
    signature: null,
    at: at || new Date().toISOString(),
    omniClient: opts.omniClient,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Pure-function helpers (testable without a graph)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Apply a rebind to a single vc. Used by Phase 5 backfill tooling and by
 * tests asserting the algebra. Production rebind happens server-side via
 * the apoc Cypher; this is the equivalent local computation.
 *
 * @param {object} v
 * @param {string} fromDeviceId
 * @param {string} toDeviceId
 * @returns {object}
 */
function applyRebindToVc(v, fromDeviceId, toDeviceId) {
  if (!vc.isValid(v)) return v;
  if (!(fromDeviceId in v)) return v;
  const out = { ...v, [toDeviceId]: v[fromDeviceId] };
  delete out[fromDeviceId];
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Internal
// ────────────────────────────────────────────────────────────────────────────

async function _submitRebind(args) {
  const omniClient = _resolveOmniClient(args.omniClient);
  if (!omniClient) {
    return { success: false, rewrittenAssets: 0, traceId: null, error: 'OmniGraph client unavailable' };
  }
  if (typeof omniClient.isReady === 'function' && !omniClient.isReady()) {
    return { success: false, rewrittenAssets: 0, traceId: null, error: 'graph not ready' };
  }
  if (!isValidTraceId(args.traceId)) {
    return { success: false, rewrittenAssets: 0, traceId: null, error: 'invalid traceId' };
  }
  try {
    const rows = await omniClient.executeQuery(CYPHER_DEVICE_REBIND, {
      traceId: args.traceId,
      fromDeviceId: args.fromDeviceId,
      toDeviceId: args.toDeviceId,
      path: args.path,
      attestation: args.attestation,
      signedPayload: args.signedPayload,
      signature: args.signature,
      at: args.at,
    });
    const rewritten = _toInt(rows?.[0]?.rewrittenAssets) || 0;
    log.info('sync-v5', 'Device rebind applied', {
      traceId: args.traceId,
      fromDeviceId: args.fromDeviceId,
      toDeviceId: args.toDeviceId,
      path: args.path,
      rewrittenAssets: rewritten,
    });
    return {
      success: true,
      rewrittenAssets: rewritten,
      traceId: args.traceId,
      error: null,
    };
  } catch (err) {
    log.warn('sync-v5', 'Device rebind failed', { error: err.message });
    return { success: false, rewrittenAssets: 0, traceId: args.traceId, error: err.message };
  }
}

function _resolveOmniClient(injected) {
  if (injected) return injected;
  try {
    const { getOmniGraphClient } = require('../../omnigraph-client');
    return getOmniGraphClient();
  } catch (_) {
    return null;
  }
}

function _sortedKeys(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

function _toInt(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && typeof v.low === 'number') return v.low;
  return null;
}

module.exports = {
  REBIND_PATH,
  CYPHER_DEVICE_REBIND,
  buildRebindPayload,
  verifyHandoffSignature,
  submitLiveHandoff,
  submitUserAttested,
  applyRebindToVc,
};
