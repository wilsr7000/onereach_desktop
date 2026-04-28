/**
 * Schema-version handshake (v5 Section 4.4)
 *
 * The :SchemaVersion singleton in the graph is the device-graph contract.
 * Every device reads it on connect and decides:
 *   - compatible      -> normal operation
 *   - graph-newer     -> compat mode: writes use OLDER schema until rollout completes
 *   - device-newer    -> READ-ONLY with banner; pulls allowed, pushes refused
 *
 * Forward-compatibility constraint (enforced at migration review, not in code):
 *   schema migrations must be forward-compatible for one version. Writes by
 *   N+1 devices must remain readable by N devices. Standard pattern:
 *   expand-migrate-contract -- add new fields without removing or renaming;
 *   migrate consumers; remove old fields in a SUBSEQUENT migration after all
 *   devices have rolled forward. Breaking changes ship as TWO compatible
 *   migrations across two release cycles, never one.
 *
 * v5 Phase 1 ships:
 *   - the singleton schema (Cypher constants below)
 *   - device-side compatibility check + readiness gate
 *   - admin upsert helper (callable from a release script, not the app)
 *
 * v5 Phase 1 does NOT ship:
 *   - migration tooling (Phase 5)
 *   - per-device cache rebuild routines (per migration in Phase 5)
 *   - integration into the existing spaces-sync-manager push path (Phase 2)
 */

'use strict';

const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

/**
 * The schema version this build of the device understands.
 *
 * Bump this when shipping a release that introduces a new schema requirement.
 * Bumping requires a corresponding migration in Phase 5 tooling, plus the
 * matching forward-compat audit (see expand-migrate-contract above).
 *
 * Phase 1 ships at version 1: the bare floor. :SchemaVersion exists, the
 * heartbeat protocol is defined, but no entity-level schema yet (vc, tombstones,
 * snapshots all land in Phase 3).
 */
const COMPILED_IN_SCHEMA_VERSION = 1;

const COMPAT_STATES = Object.freeze({
  COMPATIBLE: 'compatible',
  GRAPH_NEWER_COMPAT_MODE: 'graph-newer-compat-mode',
  DEVICE_NEWER_READONLY: 'device-newer-readonly',
  UNKNOWN: 'unknown',
});

// ────────────────────────────────────────────────────────────────────────────
// Cypher constants
// These are the canonical schema-version queries. Keep them as exported
// constants so tests, admin scripts, and future Phase 5 migration code all
// reference the same Cypher.
// ────────────────────────────────────────────────────────────────────────────

const CYPHER_READ_SCHEMA_VERSION = `
  MATCH (sv:SchemaVersion)
  RETURN sv.version AS version,
         sv.deployedAt AS deployedAt,
         sv.migrationsRequired AS migrationsRequired
  LIMIT 1
`;

const CYPHER_UPSERT_SCHEMA_VERSION = `
  MERGE (sv:SchemaVersion)
  ON CREATE SET sv.version = $version,
                sv.deployedAt = datetime(),
                sv.migrationsRequired = $migrationsRequired
  ON MATCH  SET sv.version = $version,
                sv.deployedAt = datetime(),
                sv.migrationsRequired = $migrationsRequired
  RETURN sv.version AS version
`;

/**
 * Probe APOC availability. APOC is load-bearing in v5's production paths:
 * CYPHER_OP_TX, CYPHER_DELETE_TX (apoc.map.setKey), CYPHER_DEVICE_REBIND
 * (apoc.map.removeKey + apoc.map.merge), CYPHER_WRITE_SNAPSHOT and
 * CYPHER_DELETE_TX (apoc.convert.toJson). Aura ships APOC by default;
 * a self-hosted Neo4j without APOC plugin would fail every push with
 * cryptic Cypher errors. This probe lets the handshake refuse to
 * declare writeAllowed=true when APOC isn't present, so the failure
 * surfaces as a clean banner instead of late-stage Cypher errors.
 */
const CYPHER_PROBE_APOC = `
  RETURN apoc.version() AS version
`;

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

/**
 * @returns {number} the schema version this build understands.
 */
function getCompiledInVersion() {
  return COMPILED_IN_SCHEMA_VERSION;
}

/**
 * Read the :SchemaVersion singleton from the graph.
 *
 * @param {object} [opts]
 * @param {object} [opts.omniClient] -- test override
 * @returns {Promise<{version:number|null, deployedAt:string|null, migrationsRequired:string[]}>}
 */
async function readGraphSchemaVersion(opts = {}) {
  const omniClient = _resolveOmniClient(opts.omniClient);
  if (!omniClient) {
    return { version: null, deployedAt: null, migrationsRequired: [] };
  }
  if (typeof omniClient.isReady === 'function' && !omniClient.isReady()) {
    return { version: null, deployedAt: null, migrationsRequired: [] };
  }
  try {
    const records = await omniClient.executeQuery(CYPHER_READ_SCHEMA_VERSION);
    if (!Array.isArray(records) || records.length === 0) {
      return { version: null, deployedAt: null, migrationsRequired: [] };
    }
    const row = records[0];
    return {
      version: _toInt(row.version),
      deployedAt: row.deployedAt ? String(row.deployedAt) : null,
      migrationsRequired: Array.isArray(row.migrationsRequired) ? row.migrationsRequired : [],
    };
  } catch (err) {
    log.warn('sync-v5', 'Failed to read :SchemaVersion', { error: err.message });
    return { version: null, deployedAt: null, migrationsRequired: [] };
  }
}

/**
 * Probe APOC availability. Returns `{ available, version, error }`.
 *
 * Implementation notes:
 *   - Calls `RETURN apoc.version()`. If APOC isn't installed, Neo4j throws
 *     "Unknown function 'apoc.version'" or similar. We catch and report.
 *   - Fails closed on any error (graph unavailable, auth failure, etc.) --
 *     we'd rather refuse to write than write half-Cypher into a half-
 *     supported graph.
 *
 * @param {object} [opts]
 * @param {object} [opts.omniClient]
 * @returns {Promise<{available:boolean, version:string|null, error:string|null}>}
 */
async function probeApoc(opts = {}) {
  const omniClient = _resolveOmniClient(opts.omniClient);
  if (!omniClient) {
    return { available: false, version: null, error: 'OmniGraph client unavailable' };
  }
  if (typeof omniClient.isReady === 'function' && !omniClient.isReady()) {
    return { available: false, version: null, error: 'graph not ready' };
  }
  try {
    const rows = await omniClient.executeQuery(CYPHER_PROBE_APOC);
    if (Array.isArray(rows) && rows.length > 0 && rows[0].version != null) {
      return { available: true, version: String(rows[0].version), error: null };
    }
    return { available: false, version: null, error: 'apoc.version() returned no row' };
  } catch (err) {
    log.warn('sync-v5', 'APOC probe failed (push/pull will be disabled)', {
      error: err.message,
    });
    return { available: false, version: null, error: err.message };
  }
}

/**
 * Compare the device's compiled-in version against the graph's current version
 * and return a compatibility state.
 *
 * - device === graph                 -> COMPATIBLE
 * - device  <  graph                 -> GRAPH_NEWER_COMPAT_MODE
 *   (the device is one or more versions behind; it can still read but writes
 *    must use the older schema. Only safe within the forward-compat window;
 *    if the gap is >1 version, treat as DEVICE_NEWER_READONLY's mirror -- the
 *    device shouldn't write at all.)
 * - device  >  graph                 -> the graph hasn't been migrated up yet.
 *   Treat as COMPATIBLE -- the device should write using the OLDER schema
 *   it knows the graph supports. This is the staged-rollout case where new
 *   devices ship before the graph migration runs.
 * - graph version unknown            -> UNKNOWN -- caller decides (typically
 *   refuse-to-write until known).
 *
 * @param {number|null} graphVersion
 * @param {number}      [deviceVersion=COMPILED_IN_SCHEMA_VERSION]
 * @returns {string} one of COMPAT_STATES
 */
function checkCompatibility(graphVersion, deviceVersion = COMPILED_IN_SCHEMA_VERSION) {
  if (graphVersion == null || typeof graphVersion !== 'number') {
    return COMPAT_STATES.UNKNOWN;
  }
  if (graphVersion === deviceVersion) {
    return COMPAT_STATES.COMPATIBLE;
  }
  if (graphVersion > deviceVersion) {
    // Graph is newer. If exactly +1, the forward-compat window applies and
    // the device can keep writing in the older schema. If +2 or more, the
    // device has missed a window and must go read-only.
    if (graphVersion - deviceVersion === 1) {
      return COMPAT_STATES.GRAPH_NEWER_COMPAT_MODE;
    }
    return COMPAT_STATES.DEVICE_NEWER_READONLY; // misnomer here -- "device too old to write"
  }
  // graphVersion < deviceVersion: pre-migration rollout. Device targets the
  // older schema until the graph catches up. From the device's perspective
  // this is COMPATIBLE.
  return COMPAT_STATES.COMPATIBLE;
}

/**
 * Should the device allow writes given its current compatibility state?
 *
 * @param {string} compatState (one of COMPAT_STATES)
 * @returns {boolean}
 */
function isWriteAllowed(compatState) {
  return (
    compatState === COMPAT_STATES.COMPATIBLE ||
    compatState === COMPAT_STATES.GRAPH_NEWER_COMPAT_MODE
  );
}

/**
 * Run the boot-time handshake: read the graph version, probe APOC,
 * compare against compiled-in version, return the compatibility state
 * plus a human-readable banner string for the diagnostics overlay.
 *
 * `writeAllowed` is the AND of (a) schema-compatibility and (b) APOC
 * availability. v5's production Cypher uses APOC functions that don't
 * have core-Cypher equivalents for dynamic-key map updates; without
 * APOC every push would fail at the proxy layer with cryptic errors.
 * Failing closed at the handshake means the banner surfaces the cause
 * instead.
 *
 * @param {object} [opts]
 * @param {object} [opts.omniClient] -- test override
 * @returns {Promise<{
 *   state:string,
 *   deviceVersion:number,
 *   graphVersion:number|null,
 *   apocAvailable:boolean,
 *   apocVersion:string|null,
 *   banner:string|null,
 *   writeAllowed:boolean
 * }>}
 */
async function handshake(opts = {}) {
  const deviceVersion = getCompiledInVersion();
  const { version: graphVersion } = await readGraphSchemaVersion(opts);
  const apoc = await probeApoc(opts);
  const state = checkCompatibility(graphVersion, deviceVersion);
  const writeAllowedBySchema = isWriteAllowed(state);
  const writeAllowed = writeAllowedBySchema && apoc.available;

  // Banner precedence: APOC missing wins over schema banners because it's
  // a hard prerequisite -- without APOC nothing else matters.
  let banner = null;
  if (!apoc.available && state !== COMPAT_STATES.UNKNOWN) {
    banner =
      'Spaces graph requires the APOC plugin -- not available on this Neo4j. Push/pull disabled until APOC is installed.';
  } else if (state === COMPAT_STATES.UNKNOWN) {
    banner =
      'Spaces graph schema version unavailable -- writes will be queued locally until the graph reports a version.';
  } else if (state === COMPAT_STATES.GRAPH_NEWER_COMPAT_MODE) {
    banner =
      'Spaces graph schema is newer than this build (compat mode). Update the app at your convenience.';
  } else if (state === COMPAT_STATES.DEVICE_NEWER_READONLY) {
    banner = 'This build is too old for the current Spaces graph -- read-only until the app is updated.';
  }

  log.info('sync-v5', 'Schema version handshake', {
    deviceVersion,
    graphVersion,
    state,
    apocAvailable: apoc.available,
    apocVersion: apoc.version,
    writeAllowed,
  });

  return {
    state,
    deviceVersion,
    graphVersion,
    apocAvailable: apoc.available,
    apocVersion: apoc.version,
    banner,
    writeAllowed,
  };
}

/**
 * ADMIN: upsert the :SchemaVersion singleton. This is for release scripts,
 * NOT the app. Calling this from a device would cause every other device
 * to flip into compat mode or read-only.
 *
 * @param {object} args
 * @param {number} args.version
 * @param {string[]} [args.migrationsRequired=[]]
 * @param {object} [opts]
 * @param {object} [opts.omniClient]
 * @returns {Promise<{version:number}>}
 */
async function adminUpsertSchemaVersion({ version, migrationsRequired = [] }, opts = {}) {
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new Error(`adminUpsertSchemaVersion: version must be a positive integer, got ${version}`);
  }
  const omniClient = _resolveOmniClient(opts.omniClient);
  if (!omniClient || (typeof omniClient.isReady === 'function' && !omniClient.isReady())) {
    throw new Error('adminUpsertSchemaVersion: OmniGraph client is not ready');
  }
  const result = await omniClient.executeQuery(CYPHER_UPSERT_SCHEMA_VERSION, {
    version,
    migrationsRequired,
  });
  log.info('sync-v5', 'Admin set :SchemaVersion', { version, migrationsRequired });
  return { version: _toInt(result?.[0]?.version) ?? version };
}

// ────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────────────

function _resolveOmniClient(injected) {
  if (injected) return injected;
  try {
    const { getOmniGraphClient } = require('../../omnigraph-client');
    return getOmniGraphClient();
  } catch (_) {
    return null;
  }
}

function _toInt(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }
  // Neo4j Integer object: { low, high }
  if (typeof v === 'object' && typeof v.low === 'number') return v.low;
  return null;
}

module.exports = {
  COMPILED_IN_SCHEMA_VERSION,
  COMPAT_STATES,
  CYPHER_READ_SCHEMA_VERSION,
  CYPHER_UPSERT_SCHEMA_VERSION,
  CYPHER_PROBE_APOC,
  getCompiledInVersion,
  readGraphSchemaVersion,
  checkCompatibility,
  isWriteAllowed,
  probeApoc,
  handshake,
  adminUpsertSchemaVersion,
};
