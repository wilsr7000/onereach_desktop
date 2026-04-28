/**
 * Materialised SQLite replica -- barrel.
 *
 * Re-exports the public surface of lib/sync-v5/replica/. Per the
 * commit-A scaffold scope, this is a small surface; commit B adds
 * migration tooling, commit C/D add the search + smart-folder
 * surface as cutover progresses.
 */

'use strict';

const schema = require('./schema');
const replica = require('./replica');
const migrate = require('./migrate');
const shadowWriter = require('./shadow-writer');
const shadowReader = require('./shadow-reader');
const validationGate = require('./validation-gate');
const cutoverProvider = require('./cutover-provider');

module.exports = {
  // Schema
  SCHEMA_VERSION: schema.SCHEMA_VERSION,
  getInitDDL: schema.getInitDDL,
  buildReplicaMetaSeed: schema.buildReplicaMetaSeed,
  // DDL constants (named exports for tests / tooling that wants to
  // inspect the schema without opening a DB)
  DDL_SPACES: schema.DDL_SPACES,
  DDL_ITEMS: schema.DDL_ITEMS,
  DDL_ITEM_TAGS: schema.DDL_ITEM_TAGS,
  DDL_SMART_FOLDERS: schema.DDL_SMART_FOLDERS,
  DDL_REPLICA_META: schema.DDL_REPLICA_META,
  DDL_ITEMS_FTS: schema.DDL_ITEMS_FTS,

  // Replica class + factory
  Replica: replica.Replica,
  getReplica: replica.getReplica,

  // Cold-device migration tool (commit B)
  migrateFromClipboardStorage: migrate.migrateFromClipboardStorage,

  // Shadow-writer (commit C)
  attachShadowWriter: shadowWriter.attachShadowWriter,

  // Shadow-reader + validation gate (commit D)
  attachShadowReader: shadowReader.attachShadowReader,
  ValidationGate: validationGate.ValidationGate,
  DEFAULT_THRESHOLDS: validationGate.DEFAULT_THRESHOLDS,
  DEFAULT_WALL_CLOCK_DAYS: validationGate.DEFAULT_WALL_CLOCK_DAYS,

  // Cutover provider (commit E)
  buildCutoverProvider: cutoverProvider.buildCutoverProvider,

  // Pure helpers (exported for testing; not part of the runtime contract)
  _normaliseSpaceRow: replica._normaliseSpaceRow,
  _normaliseItemRow: replica._normaliseItemRow,
  _parseTagsField: replica._parseTagsField,
  _matchGlob: replica._matchGlob,
};
