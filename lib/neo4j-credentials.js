/**
 * Neo4j Credentials Loader
 *
 * Bridges three things:
 *   1. Settings store -- where the user's Neo4j Aura credentials persist.
 *   2. The canonical Aura .txt file format -- what Neo4j Aura emails / shows
 *      you when you create an instance:
 *
 *        # Wait 60 seconds before connecting...
 *        NEO4J_URI=neo4j+s://40c812ef.databases.neo4j.io
 *        NEO4J_USERNAME=neo4j
 *        NEO4J_PASSWORD=<password>
 *        NEO4J_DATABASE=neo4j
 *        AURA_INSTANCEID=40c812ef
 *        AURA_INSTANCENAME=Instance01
 *
 *   3. The OmniGraph client singleton -- which holds the live config the
 *      sync layer reads at push/pull time.
 *
 * Public API:
 *   - parseAuraCredentialsFile(absolutePath) -> { uri, username, password,
 *                                                  database, instanceId, instanceName }
 *   - applyToSettings(creds, { settingsManager?, omniClient? })
 *       -> persists into settings AND pushes into the live OmniGraph client.
 *   - loadFromSettings({ settingsManager?, omniClient? })
 *       -> on boot, read the four neo4j settings keys and (if a password is
 *       present) push them into the OmniGraph client. No-op if unconfigured.
 *
 * Why this module exists: the OmniGraph client has a setNeo4jPassword() and
 * a setNeo4jConfig() method, but until today nothing in the production code
 * called them. The result was 2+ weeks of silently-failed pushes with
 * "Neo4j password not configured" errors and no graph-side audit trail for
 * any local FIFO evictions.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

// Settings keys we own in this module. Keep in sync with the defaults block
// in settings-manager.js.
const SETTINGS_KEYS = Object.freeze({
  password: 'neo4jPassword',
  uri: 'neo4jUri',
  user: 'neo4jUser',
  database: 'neo4jDatabase',
});

// ────────────────────────────────────────────────────────────────────────────
// Dependency injection (test-only overrides)
// vitest's vi.mock doesn't reliably intercept require() calls in this repo,
// so the public functions accept { settingsManager, omniClient } overrides.
// In production, callers omit those args and we lazy-require the singletons.
// ────────────────────────────────────────────────────────────────────────────

function _resolveSettingsManager(injected) {
  if (injected) return injected;
  try {
    const { getSettingsManager } = require('../settings-manager');
    return getSettingsManager();
  } catch (_) {
    return null;
  }
}

function _resolveOmniClient(injected) {
  if (injected) return injected;
  try {
    const { getOmniGraphClient } = require('../omnigraph-client');
    return getOmniGraphClient();
  } catch (_) {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Parse a Neo4j Aura .txt credentials file
// ────────────────────────────────────────────────────────────────────────────

/**
 * Parse the canonical Aura credentials .txt file.
 *
 * Tolerant of:
 *   - leading / trailing whitespace per line
 *   - blank lines
 *   - lines starting with `#` (Aura prepends a wait-60-seconds comment)
 *   - quoted values (`KEY="value"` or `KEY='value'`)
 *   - extra unrecognised keys (passed through silently)
 *
 * Strict about:
 *   - the file must exist and be readable
 *   - NEO4J_PASSWORD must be present and non-empty (everything else can
 *     fall back to defaults)
 *
 * @param {string} filePath  Absolute path to the Aura .txt file.
 * @returns {{ uri: string, username: string, password: string,
 *             database: string, instanceId: string, instanceName: string }}
 * @throws if the file is missing or doesn't contain a NEO4J_PASSWORD line.
 */
function parseAuraCredentialsFile(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('parseAuraCredentialsFile: filePath is required');
  }
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Neo4j credentials file not found: ${abs}`);
  }

  const raw = fs.readFileSync(abs, 'utf8');
  const map = {};
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) map[key] = value;
  }

  const password = map.NEO4J_PASSWORD || '';
  if (!password) {
    throw new Error(
      `Neo4j credentials file is missing NEO4J_PASSWORD: ${abs}. ` +
        'Expected the standard Aura format (NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD, NEO4J_DATABASE).'
    );
  }

  return {
    uri: map.NEO4J_URI || '',
    username: map.NEO4J_USERNAME || 'neo4j',
    password,
    database: map.NEO4J_DATABASE || 'neo4j',
    instanceId: map.AURA_INSTANCEID || '',
    instanceName: map.AURA_INSTANCENAME || '',
  };
}

// ────────────────────────────────────────────────────────────────────────────
// applyToSettings -- persist + push to live client
// ────────────────────────────────────────────────────────────────────────────

/**
 * Persist credentials into the settings store AND push them into the live
 * OmniGraph client so the next push/pull picks them up without a restart.
 *
 * Logs every step but ALWAYS redacts the password (first 4 chars + ellipsis).
 *
 * @param {Object} creds  Output of parseAuraCredentialsFile, or any subset
 *                        with at least { password }.
 * @param {Object} [opts]
 * @param {Object} [opts.settingsManager]  Test override.
 * @param {Object} [opts.omniClient]       Test override.
 * @returns {{ saved: boolean, applied: boolean, redactedPassword: string }}
 */
function applyToSettings(creds, opts = {}) {
  if (!creds || typeof creds !== 'object') {
    throw new Error('applyToSettings: creds object is required');
  }
  if (!creds.password) {
    throw new Error('applyToSettings: creds.password is required');
  }

  const settings = _resolveSettingsManager(opts.settingsManager);
  const omniClient = _resolveOmniClient(opts.omniClient);

  const redactedPassword = _redact(creds.password);
  let saved = false;
  let applied = false;

  if (settings && typeof settings.set === 'function') {
    settings.set(SETTINGS_KEYS.password, creds.password);
    if (creds.uri) settings.set(SETTINGS_KEYS.uri, creds.uri);
    if (creds.username) settings.set(SETTINGS_KEYS.user, creds.username);
    if (creds.database) settings.set(SETTINGS_KEYS.database, creds.database);
    saved = true;
  } else {
    log.warn('app', 'neo4j-credentials: settings manager unavailable; credentials NOT persisted');
  }

  if (omniClient && typeof omniClient.setNeo4jConfig === 'function') {
    omniClient.setNeo4jConfig({
      neo4jPassword: creds.password,
      ...(creds.uri ? { neo4jUri: creds.uri } : {}),
      ...(creds.username ? { neo4jUser: creds.username } : {}),
      ...(creds.database ? { database: creds.database } : {}),
    });
    applied = true;
  } else {
    log.warn('app', 'neo4j-credentials: OmniGraph client unavailable; live config NOT updated');
  }

  log.info('app', 'neo4j-credentials: applied', {
    saved,
    applied,
    user: creds.username || 'neo4j',
    database: creds.database || 'neo4j',
    uri: creds.uri || '(default)',
    instanceId: creds.instanceId || '(unknown)',
    passwordRedacted: redactedPassword,
  });

  return { saved, applied, redactedPassword };
}

// ────────────────────────────────────────────────────────────────────────────
// loadFromSettings -- boot-time hydration of the OmniGraph client
// ────────────────────────────────────────────────────────────────────────────

/**
 * On app boot, read the four Neo4j settings and apply them to the live
 * OmniGraph client. Safe to call multiple times. No-op when the password
 * is unset (the OmniGraph client stays in its "endpoint-only" state and
 * the sync layer's isReady() check will refuse to push).
 *
 * @param {Object} [opts]
 * @param {Object} [opts.settingsManager]  Test override.
 * @param {Object} [opts.omniClient]       Test override.
 * @returns {{ configured: boolean, redactedPassword: string|null }}
 */
function loadFromSettings(opts = {}) {
  const settings = _resolveSettingsManager(opts.settingsManager);
  if (!settings || typeof settings.get !== 'function') {
    return { configured: false, redactedPassword: null };
  }

  const password = settings.get(SETTINGS_KEYS.password) || '';
  if (!password) {
    return { configured: false, redactedPassword: null };
  }

  const uri = settings.get(SETTINGS_KEYS.uri) || '';
  const username = settings.get(SETTINGS_KEYS.user) || 'neo4j';
  const database = settings.get(SETTINGS_KEYS.database) || 'neo4j';

  applyToSettings(
    { password, uri, username, database },
    { settingsManager: settings, omniClient: opts.omniClient }
  );
  return { configured: true, redactedPassword: _redact(password) };
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function _redact(secret) {
  const s = String(secret || '');
  if (!s) return '';
  if (s.length <= 8) return '****';
  return s.slice(0, 4) + '...' + s.slice(-2);
}

module.exports = {
  parseAuraCredentialsFile,
  applyToSettings,
  loadFromSettings,
  SETTINGS_KEYS,
  // Test-only:
  _redact,
};
