/**
 * OmniGraph Client — Neo4j Backend
 *
 * Client for the Neo4j Cypher Proxy API for managing
 * GSX ecosystem nodes: Spaces, Asset Types, and Assets.
 *
 * Backend: Neo4j Aura via Edison HTTP Cypher Proxy
 * Endpoint: POST .../omnidata/neon  (async job pattern: POST→jobId, GET→result)
 *
 * Follows the Temporal Graph Honor System v2.0.0:
 * - All nodes have provenance fields (created_by_*, updated_by_*, _history)
 * - All changes are tracked with history entries
 * - App identity is required for all operations
 *
 * Timeout: 60 seconds (polling)
 *
 * @module OmniGraphClient
 */

const crypto = require('crypto');

// ===========================================================================
// DIRECT-AURA FALLBACK (added to bypass broken GSX proxy)
// ===========================================================================
//
// The GSX OmniGraph proxy (this.endpoint) is the canonical path for queries,
// but tonight's diagnosis showed every POST returns `no handler` from the
// server-side flow. Until that's fixed, app graph writes are dead.
//
// When the user configures `neo4jUri` + `neo4jPassword` (the standard Aura
// credentials), this client connects DIRECTLY to Aura via the official
// neo4j-driver npm package. Direct path is preferred when configured;
// GSX endpoint becomes a fallback for callers that haven't set the URI.
//
// Lazy-require so the driver isn't loaded until needed (and so this module
// keeps loading in non-Aura environments where neo4j-driver might be absent).
//
// Result-shape parity: the existing GSX path returns records as plain objects
// keyed by Cypher RETURN aliases, with Node values shaped as
// `{ id, labels, properties }`. The direct path normalises neo4j-driver's
// Record + Node + Relationship + Integer + DateTime types into the same
// shape so callers don't need to know which path was used.
// ===========================================================================

let _neo4jDriverModule = null;
function _loadNeo4jDriver() {
  if (_neo4jDriverModule) return _neo4jDriverModule;
  try {
    _neo4jDriverModule = require('neo4j-driver');
    return _neo4jDriverModule;
  } catch (err) {
    const e = new Error('neo4j-driver not available; run npm install neo4j-driver. Original: ' + err.message);
    e.code = 'NEO4J_DRIVER_MISSING';
    throw e;
  }
}

/**
 * Convert a neo4j-driver Record into a plain GSX-compatible object.
 * Keys are the Cypher RETURN aliases; values are recursively normalised.
 */
function _recordToPlain(record) {
  const out = {};
  for (const key of record.keys) {
    out[key] = _normaliseDriverValue(record.get(key));
  }
  return out;
}

/**
 * Recursively convert neo4j-driver values into plain JS suitable for the
 * GSX-compatible result shape.
 *
 * Mappings:
 *   Integer        -> Number (lossy for >2^53; acceptable for our use)
 *   Node           -> { id, labels, properties }
 *   Relationship   -> { id, type, start, end, properties }
 *   Path           -> { segments: [{ start, relationship, end }, ...] }
 *   Date / DateTime / LocalDateTime / Time / Duration -> ISO string
 *   Point          -> { srid, x, y, z? }
 *   Buffer-like    -> base64 string
 *   Array          -> mapped recursively
 *   Plain object   -> mapped recursively
 *   primitive      -> as-is
 */
function _normaliseDriverValue(v) {
  if (v === null || v === undefined) return v;
  const driver = _neo4jDriverModule;
  if (!driver) return v;

  // neo4j Integer
  if (driver.isInt && driver.isInt(v)) {
    // Use toNumber() when in safe range; toString() otherwise so callers
    // can choose how to handle big values without losing them silently.
    return v.inSafeRange() ? v.toNumber() : v.toString();
  }
  // Node / Relationship / Path -- detect via duck-typing because the
  // direct `instanceof` checks against driver.types vary by version.
  if (v && v.constructor && v.constructor.name === 'Node') {
    return {
      id: v.identity && driver.isInt(v.identity) ? v.identity.toString() : (v.elementId || String(v.identity)),
      labels: Array.isArray(v.labels) ? v.labels.slice() : [],
      properties: _normaliseDriverValue(v.properties || {}),
    };
  }
  if (v && v.constructor && v.constructor.name === 'Relationship') {
    return {
      id: v.identity && driver.isInt(v.identity) ? v.identity.toString() : String(v.identity),
      type: v.type,
      start: v.start && driver.isInt(v.start) ? v.start.toString() : String(v.start),
      end: v.end && driver.isInt(v.end) ? v.end.toString() : String(v.end),
      properties: _normaliseDriverValue(v.properties || {}),
    };
  }
  if (v && v.constructor && v.constructor.name === 'Path') {
    return {
      segments: (v.segments || []).map((s) => ({
        start: _normaliseDriverValue(s.start),
        relationship: _normaliseDriverValue(s.relationship),
        end: _normaliseDriverValue(s.end),
      })),
    };
  }
  // Temporal types -- they all expose .toString() that returns ISO
  if (v && typeof v === 'object') {
    const cn = v.constructor && v.constructor.name;
    if (cn === 'Date' || cn === 'DateTime' || cn === 'LocalDateTime'
        || cn === 'Time' || cn === 'LocalTime' || cn === 'Duration') {
      return v.toString();
    }
    if (cn === 'Point') {
      return {
        srid: v.srid && driver.isInt(v.srid) ? v.srid.toNumber() : v.srid,
        x: v.x, y: v.y,
        ...(typeof v.z !== 'undefined' ? { z: v.z } : {}),
      };
    }
  }
  // Buffer / Uint8Array
  if (Buffer.isBuffer && Buffer.isBuffer(v)) return v.toString('base64');
  if (v && v.buffer && typeof v.byteLength === 'number' && typeof v.length === 'number') {
    return Buffer.from(v).toString('base64');
  }
  // Array
  if (Array.isArray(v)) return v.map(_normaliseDriverValue);
  // Plain object (including .properties from a Node/Relationship)
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = _normaliseDriverValue(v[k]);
    return out;
  }
  return v;
}

// ============================================
// APP IDENTITY (Honor System Requirement)
// ============================================

/**
 * Application identity for the Temporal Graph Honor System
 * Every app that writes to the graph must identify itself
 */
const APP_IDENTITY = {
  name: 'GSX-Desktop',
  id: 'gsx-desktop-app',
};

/**
 * Build provenance fields for node creation
 * @param {string} user - User email who triggered the action
 * @returns {Object} Provenance fields object
 */
function buildCreateProvenance(user) {
  const now = Date.now();
  return {
    created_by_app_name: APP_IDENTITY.name,
    created_by_app_id: APP_IDENTITY.id,
    created_by_user: user || 'system',
    created_at: now,
    updated_by_app_name: APP_IDENTITY.name,
    updated_by_app_id: APP_IDENTITY.id,
    updated_by_user: user || 'system',
    updated_at: now,
    _history: '[]',
  };
}

/**
 * Build provenance fields for node update
 * @param {string} user - User email who triggered the action
 * @returns {Object} Update provenance fields
 */
function buildUpdateProvenance(user) {
  return {
    updated_by_app_name: APP_IDENTITY.name,
    updated_by_app_id: APP_IDENTITY.id,
    updated_by_user: user || 'system',
    updated_at: Date.now(),
  };
}

/**
 * Build a history entry for tracking changes
 * @param {string} user - User email
 * @param {string} action - Action type (CREATE, UPDATE, DELETE)
 * @param {Array} changes - Array of {property, old_value, new_value}
 * @returns {Object} History entry
 */
function buildHistoryEntry(user, action, changes = []) {
  return {
    timestamp: Date.now(),
    app_name: APP_IDENTITY.name,
    app_id: APP_IDENTITY.id,
    user: user || 'system',
    action,
    changes,
  };
}

/**
 * Escape a string for safe use in Cypher queries
 * Prevents injection attacks by escaping special characters
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
function escapeCypher(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Capitalize first letter of a string
 * @param {string} str - String to capitalize
 * @returns {string} Capitalized string
 */
function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

/**
 * OmniGraph Client for managing GSX ecosystem graph nodes
 * Follows Temporal Graph Honor System v2.0.0
 *
 * Backend: Neo4j Aura via Edison HTTP Cypher Proxy (async job pattern)
 */
class OmniGraphClient {
  /**
   * Create an OmniGraph client
   * @param {Object} options - Configuration options
   * @param {string} options.endpoint - Neo4j Cypher Proxy URL
   * @param {string} options.neo4jPassword - Neo4j Aura instance password
   * @param {string} options.neo4jUri - Neo4j Bolt URI (proxy converts to HTTPS)
   * @param {string} options.neo4jUser - Neo4j username (default: 'neo4j')
   * @param {string} options.database - Neo4j database name (default: 'neo4j')
   * @param {Function} options.getAuthToken - Legacy: Function that returns current auth token
   * @param {number} options.timeout - Polling timeout in ms (default: 60000)
   * @param {number} options.pollInterval - Polling interval in ms (default: 1500)
   * @param {string} options.currentUser - Current user email for provenance tracking
   */
  constructor(options = {}) {
    this.endpoint = options.endpoint || null;
    this.neo4jPassword = options.neo4jPassword || null;
    this.neo4jUri = options.neo4jUri || null;
    this.neo4jUser = options.neo4jUser || 'neo4j';
    this.database = options.database || 'neo4j';
    this.getAuthToken = options.getAuthToken || (() => null);
    this.timeout = options.timeout || 60000;
    this.pollInterval = options.pollInterval || 1500;
    this.currentUser = options.currentUser || 'system'; // For provenance tracking

    // Direct-Aura driver instance (lazy, created on first executeQuery if
    // neo4jUri + neo4jPassword are set). Survives across queries.
    this._directDriver = null;
    // Counter so /sync/queue diagnostics can see which path is actually
    // being used.
    this._counters = { directQueries: 0, gsxQueries: 0, directErrors: 0, gsxErrors: 0 };
  }

  /**
   * Should we prefer the direct-Aura driver path over GSX?
   * True when the standard Aura credentials (uri + password) are set.
   * The GSX endpoint is then optional fallback.
   */
  _hasDirectCreds() {
    return !!(this.neo4jUri && this.neo4jPassword);
  }

  /**
   * Lazy-construct the neo4j-driver Driver. Cached on this instance.
   * Returns null when credentials are missing.
   */
  _getDirectDriver() {
    if (this._directDriver) return this._directDriver;
    if (!this._hasDirectCreds()) return null;
    const neo4j = _loadNeo4jDriver();
    this._directDriver = neo4j.driver(
      this.neo4jUri,
      neo4j.auth.basic(this.neo4jUser || 'neo4j', this.neo4jPassword),
      {
        // Reasonable defaults for an Aura instance over public internet.
        maxConnectionLifetime: 60 * 60 * 1000,
        connectionAcquisitionTimeout: 30 * 1000,
        // Aura uses neo4j+s:// (TLS); driver picks scheme from URI.
        userAgent: 'gsx-power-user/4.9.0 (direct-aura)',
      },
    );
    console.log('[OmniGraph] Direct Aura driver initialised:', this.neo4jUri, '(user:', this.neo4jUser + ', db:', this.database + ')');
    return this._directDriver;
  }

  /**
   * Cleanly close the direct driver. Safe to call from app shutdown handlers.
   * After close(), a subsequent _getDirectDriver() will create a fresh driver.
   */
  async closeDirectDriver() {
    const d = this._directDriver;
    this._directDriver = null;
    if (d) {
      try { await d.close(); } catch (_e) { /* ignore */ }
    }
  }

  /**
   * Execute a Cypher query against Aura DIRECTLY (bypasses GSX).
   * Same return shape as the GSX path: array of record objects keyed by
   * Cypher RETURN aliases, with Node/Relationship values shaped as
   * { id, labels, properties } / { id, type, start, end, properties }.
   *
   * Throws when credentials are missing or the driver/network errors.
   */
  async _executeDirect(cypher, parameters = {}) {
    const driver = this._getDirectDriver();
    if (!driver) {
      throw new Error('Direct Aura: neo4jUri / neo4jPassword not configured');
    }
    const startTime = Date.now();
    const session = driver.session({ database: this.database || 'neo4j' });
    try {
      const result = await session.run(cypher, parameters);
      const records = result.records.map(_recordToPlain);
      const ms = Date.now() - startTime;
      console.log(`[OmniGraph/direct] Query returned ${records.length} records in ${ms}ms`);
      this._counters.directQueries++;
      return records;
    } catch (err) {
      this._counters.directErrors++;
      // Wrap with a clearer message; preserve the original cause for callers.
      const msg = err && err.message ? err.message : String(err);
      console.error('[OmniGraph/direct] Query failed:', msg);
      const wrapped = new Error('Direct Aura query failed: ' + msg);
      wrapped.cause = err;
      wrapped.directAura = true;
      throw wrapped;
    } finally {
      try { await session.close(); } catch (_e) { /* ignore close noise */ }
    }
  }

  /**
   * Set the endpoint URL
   * @param {string} endpoint - Neo4j Cypher Proxy URL
   */
  setEndpoint(endpoint) {
    this.endpoint = endpoint;
    console.log('[OmniGraph] Endpoint set to:', endpoint);
  }

  /**
   * Set the Neo4j password for the Cypher Proxy
   * @param {string} password - Neo4j Aura instance password
   */
  setNeo4jPassword(password) {
    this.neo4jPassword = password;
    console.log('[OmniGraph] Neo4j password configured');
  }

  /**
   * Set the Neo4j connection URI (optional — proxy has a default)
   * @param {string} uri - Neo4j Bolt-style URI (e.g. neo4j+s://xxx.databases.neo4j.io)
   */
  setNeo4jUri(uri) {
    this.neo4jUri = uri;
    console.log('[OmniGraph] Neo4j URI set to:', uri);
  }

  /**
   * Configure all Neo4j Cypher Proxy settings at once
   * @param {Object} config
   * @param {string} config.endpoint - Proxy URL
   * @param {string} config.neo4jPassword - Neo4j password
   * @param {string} [config.neo4jUri] - Neo4j URI (optional)
   * @param {string} [config.neo4jUser] - Neo4j username (default: 'neo4j')
   * @param {string} [config.database] - Database name (default: 'neo4j')
   */
  setNeo4jConfig(config) {
    if (config.endpoint) this.endpoint = config.endpoint;
    if (config.neo4jPassword) this.neo4jPassword = config.neo4jPassword;
    if (config.neo4jUri) this.neo4jUri = config.neo4jUri;
    if (config.neo4jUser) this.neo4jUser = config.neo4jUser;
    if (config.database) this.database = config.database;
    console.log('[OmniGraph] Neo4j config set — endpoint:', this.endpoint);
  }

  /**
   * Set the auth token getter function (legacy — not needed for Neo4j proxy)
   * @param {Function} fn - Function that returns auth token
   */
  setAuthTokenGetter(fn) {
    this.getAuthToken = fn;
  }

  /**
   * Set the current user for provenance tracking
   * @param {string} user - User email
   */
  setCurrentUser(user) {
    this.currentUser = user || 'system';
    console.log('[OmniGraph] Current user set to:', this.currentUser);
  }

  /**
   * Check if client is configured and ready.
   *
   * Returns true when EITHER:
   *   - the GSX proxy is fully configured (endpoint + neo4jPassword), OR
   *   - direct-Aura credentials are set (neo4jUri + neo4jPassword).
   *
   * Either path produces a working executeQuery. Callers that want to know
   * which path is in effect can inspect _hasDirectCreds() / endpoint.
   */
  isReady() {
    if (this._hasDirectCreds()) return true;
    return !!(this.endpoint && this.neo4jPassword);
  }

  // ============================================
  // SCHEMA DISCOVERY (Schema-First Workflow)
  // ============================================

  /**
   * Get a Schema node for an entity type
   * Following the ontology guide: "Always start with this query to get complete instructions"
   * @param {string} entity - Entity type (e.g., 'Asset', 'Space')
   * @returns {Promise<Object|null>} Schema node or null
   */
  async getSchema(entity) {
    const cypher = `MATCH (s:Schema {entity: '${escapeCypher(entity)}'}) RETURN s`;
    try {
      const result = await this.executeQuery(cypher);
      // Extract properties from the graph node - API returns { id, labels, properties }
      const schemaNode = result?.[0]?.s;
      return schemaNode?.properties || schemaNode || null;
    } catch (error) {
      console.warn(`[OmniGraph] Schema not found for ${entity}:`, error.message);
      return null;
    }
  }

  /**
   * Check if a Schema exists for an entity type
   * @param {string} entity - Entity type
   * @returns {Promise<boolean>} Whether schema exists
   */
  async schemaExists(entity) {
    const schema = await this.getSchema(entity);
    return schema !== null;
  }

  /**
   * Get LLM instructions from the master Schema
   * @returns {Promise<string|null>} LLM instructions
   */
  async getSchemaInstructions() {
    const cypher = `MATCH (s:Schema {entity: 'Schema'}) RETURN s.llmInstructions`;
    try {
      const result = await this.executeQuery(cypher);
      return result?.[0]?.['s.llmInstructions'] || null;
    } catch (error) {
      console.warn('[OmniGraph] Could not get schema instructions:', error.message);
      return null;
    }
  }

  /**
   * List all available entity schemas
   * @returns {Promise<Array>} Array of {entity, description}
   */
  async listSchemas() {
    const cypher = `MATCH (s:Schema) RETURN s.entity, s.description ORDER BY s.entity`;
    try {
      const result = await this.executeQuery(cypher);
      return (
        result?.map((r) => ({
          entity: r['s.entity'],
          description: r['s.description'],
        })) || []
      );
    } catch (error) {
      console.warn('[OmniGraph] Could not list schemas:', error.message);
      return [];
    }
  }

  // ============================================
  // SCHEMA MANAGEMENT
  // ============================================

  /**
   * Create or update a Schema node in the graph.
   * Follows the Temporal Graph Honor System provenance pattern.
   * @param {Object} schemaData - Schema data
   * @param {string} schemaData.entity - Entity type name (primary key)
   * @param {string} schemaData.version - Semver version
   * @param {string} schemaData.description - Human-readable description
   * @param {string} schemaData.storagePattern - Storage pattern (graph, relationship, hybrid, etc.)
   * @param {string} schemaData.instructions - Usage instructions (LLM-friendly)
   * @param {string} [schemaData.crudExamples] - JSON string of Cypher CRUD examples
   * @param {string} [schemaData.relationships] - JSON string of relationship definitions
   * @param {Object} [schemaData.extra] - Additional properties to set on the schema node
   * @returns {Promise<any>} Created/updated schema node
   */
  async upsertSchema(schemaData) {
    const now = Date.now();
    const user = this.currentUser;

    // Build SET clauses for extra properties
    let extraSets = '';
    if (schemaData.extra && typeof schemaData.extra === 'object') {
      for (const [key, value] of Object.entries(schemaData.extra)) {
        const escaped = typeof value === 'string' ? `'${escapeCypher(value)}'` : value;
        extraSets += `,\n        s.${escapeCypher(key)} = ${escaped}`;
      }
    }

    const cypher = `
      MERGE (s:Schema {entity: '${escapeCypher(schemaData.entity)}'})
      ON CREATE SET
          s.created_by_app_name = '${APP_IDENTITY.name}',
          s.created_by_app_id = '${APP_IDENTITY.id}',
          s.created_by_user = '${escapeCypher(user)}',
          s.created_at = ${now},
          s._history = '[]'
      SET s.version = '${escapeCypher(schemaData.version || '1.0.0')}',
          s.description = '${escapeCypher(schemaData.description || '')}',
          s.storagePattern = '${escapeCypher(schemaData.storagePattern || 'graph')}',
          s.instructions = '${escapeCypher(schemaData.instructions || '')}',
          s.crudExamples = '${escapeCypher(schemaData.crudExamples || '{}')}',
          s.relationships = '${escapeCypher(schemaData.relationships || '{}')}',
          s.updated_by_app_name = '${APP_IDENTITY.name}',
          s.updated_by_app_id = '${APP_IDENTITY.id}',
          s.updated_by_user = '${escapeCypher(user)}',
          s.updated_at = ${now}${extraSets}
      RETURN s
    `;

    console.log('[OmniGraph] Upserting schema:', schemaData.entity);
    return this.executeQuery(cypher);
  }

  /**
   * Ensure the Permission schema exists in the graph.
   * Idempotent -- safe to call multiple times.
   * Also patches the Person schema's relationships to include SHARED_WITH.
   * @returns {Promise<void>}
   */
  async ensurePermissionSchema() {
    // Skip if already ensured this session
    if (this._permissionSchemaEnsured) return;

    try {
      // 1. Create the Permission schema node
      // Note: Complex JSON values (crudExamples, permissionLevels, relationshipProperties)
      // are stored as base64-encoded strings to avoid Cypher parsing issues with special chars.
      const permLevels = {
        read: 'View, list items, download files',
        write: 'Read + add/edit/delete items, upload files, edit metadata',
        admin: 'Write + share with others, change visibility, manage approvals',
        owner: 'Implicit via CREATED edge. Full control, cannot be revoked.',
      };
      const relProps = {
        permission: 'string (read|write|admin)',
        grantedAt: 'number (epoch ms)',
        grantedBy: 'string (email)',
        expiresAt: 'number|null (epoch ms, null=no expiry)',
        note: 'string (optional message)',
        at: 'number (provenance timestamp)',
      };
      const crudEx = {
        share: 'MERGE Person-SHARED_WITH->Target with permission, grantedAt, grantedBy, expiresAt',
        revoke: 'DELETE SHARED_WITH relationship between Person and Target',
        list: 'MATCH all Person-SHARED_WITH->Target where not expired',
        myShares: 'MATCH all Target<-SHARED_WITH-Person where not expired',
      };
      await this.upsertSchema({
        entity: 'Permission',
        version: '1.0.0',
        description:
          'Sharing permission model for SHARED_WITH relationships between Person and Space or Asset nodes with read write admin levels and optional TTL',
        storagePattern: 'relationship',
        instructions:
          'SHARED_WITH relationship on Person to Space or Asset. Properties: permission (read or write or admin), grantedAt, grantedBy, expiresAt (null means forever). Owner is implicit via CREATED edge. Filter expired: WHERE r.expiresAt IS NULL OR r.expiresAt > timestamp. Admin can re-share. Write and read cannot.',
        relationships: '{"SHARED_WITH":"Space,Asset"}',
        crudExamples: JSON.stringify(crudEx),
        extra: {
          permissionLevels: JSON.stringify(permLevels),
          relationshipProperties: JSON.stringify(relProps),
        },
      });

      // 2. Patch Person schema to include SHARED_WITH in its relationships
      const personSchema = await this.getSchema('Person');
      if (personSchema) {
        let rels = {};
        try {
          rels = JSON.parse(personSchema.relationships || '{}');
        } catch (_e) {
          /* ignore */
        }
        if (!rels.SHARED_WITH) {
          rels.SHARED_WITH = 'Space,Asset';
          const now = Date.now();
          const cypher = `
            MATCH (s:Schema {entity: 'Person'})
            SET s.relationships = '${escapeCypher(JSON.stringify(rels))}',
                s.updated_by_app_name = '${APP_IDENTITY.name}',
                s.updated_by_app_id = '${APP_IDENTITY.id}',
                s.updated_by_user = '${escapeCypher(this.currentUser)}',
                s.updated_at = ${now}
            RETURN s
          `;
          await this.executeQuery(cypher);
          console.log('[OmniGraph] Patched Person schema with SHARED_WITH relationship');
        }
      }

      this._permissionSchemaEnsured = true;
      console.log('[OmniGraph] Permission schema ensured');
    } catch (error) {
      console.error('[OmniGraph] Failed to ensure Permission schema:', error.message, error.stack);
      // Store the error for diagnostics
      this._permissionSchemaError = error.message;
      // Non-fatal -- sharing can still work with local metadata
    }
  }

  // ============================================
  // SHARING OPERATIONS
  // ============================================

  /**
   * Share a Space or Asset with a Person by creating a SHARED_WITH relationship.
   * Automatically ensures the Permission schema and Person node exist.
   * @param {string} targetType - 'Space' or 'Asset'
   * @param {string} targetId - The Space or Asset ID
   * @param {string} email - Email of the person to share with
   * @param {string} permission - 'read', 'write', or 'admin'
   * @param {Object} [options] - Additional options
   * @param {number} [options.expiresAt] - Epoch ms TTL (null = no expiry)
   * @param {string} [options.note] - Optional message
   * @param {string} [options.grantedBy] - Email of the granter (defaults to currentUser)
   * @returns {Promise<Object>} Share result
   */
  async shareWith(targetType, targetId, email, permission, options = {}) {
    if (!['Space', 'Asset'].includes(targetType)) {
      throw new Error(`Invalid target type: ${targetType}. Must be Space or Asset.`);
    }
    if (!['read', 'write', 'admin'].includes(permission)) {
      throw new Error(`Invalid permission: ${permission}. Must be read, write, or admin.`);
    }
    if (!email || !email.includes('@')) {
      throw new Error('Invalid email address');
    }

    // Ensure schema and person exist
    await this.ensurePermissionSchema();
    await this.ensurePerson(email);

    const now = Date.now();
    const grantedBy = options.grantedBy || this.currentUser;
    const expiresAt = options.expiresAt || 'NULL';
    const note = options.note || '';

    const cypher = `
      MATCH (p:Person {id: '${escapeCypher(email)}'})
      MATCH (t:${targetType} {id: '${escapeCypher(targetId)}'})
      MERGE (p)-[r:SHARED_WITH]->(t)
      SET r.permission = '${escapeCypher(permission)}',
          r.grantedAt = ${now},
          r.grantedBy = '${escapeCypher(grantedBy)}',
          r.expiresAt = ${expiresAt === 'NULL' ? 'NULL' : expiresAt},
          r.note = '${escapeCypher(note)}',
          r.at = ${now}
      RETURN r
    `;

    const _result = await this.executeQuery(cypher);
    console.log(`[OmniGraph] Shared ${targetType} ${targetId} with ${email} (${permission})`);
    return {
      success: true,
      email,
      permission,
      grantedAt: now,
      grantedBy,
      expiresAt: expiresAt === 'NULL' ? null : expiresAt,
      note: note || null,
    };
  }

  /**
   * Revoke sharing -- removes the SHARED_WITH relationship.
   * @param {string} targetType - 'Space' or 'Asset'
   * @param {string} targetId - The Space or Asset ID
   * @param {string} email - Email of the person to unshare from
   * @returns {Promise<Object>} Unshare result
   */
  async unshare(targetType, targetId, email) {
    const cypher = `
      MATCH (p:Person {id: '${escapeCypher(email)}'})-[r:SHARED_WITH]->(t:${targetType} {id: '${escapeCypher(targetId)}'})
      DELETE r
      RETURN count(r) AS deleted
    `;

    const result = await this.executeQuery(cypher);
    const deleted = result?.[0]?.deleted || 0;
    console.log(`[OmniGraph] Unshared ${targetType} ${targetId} from ${email} (deleted: ${deleted})`);
    return { success: true, deleted: deleted > 0 };
  }

  /**
   * List all people a Space or Asset is shared with (active, non-expired shares).
   * @param {string} targetType - 'Space' or 'Asset'
   * @param {string} targetId - The Space or Asset ID
   * @returns {Promise<Array>} Array of { email, name, role, permission, grantedAt, expiresAt, grantedBy }
   */
  async getSharedWith(targetType, targetId) {
    const now = Date.now();
    const cypher = `
      MATCH (p:Person)-[r:SHARED_WITH]->(t:${targetType} {id: '${escapeCypher(targetId)}'})
      WHERE r.expiresAt IS NULL OR r.expiresAt > ${now}
      RETURN p, r
    `;

    const result = await this.executeQuery(cypher);
    if (!result || !Array.isArray(result)) return [];

    return result.map((row) => {
      const person = row.p?.properties || row.p || {};
      const rel = row.r?.properties || row.r || {};
      return {
        email: person.email || person.id,
        name: person.name || null,
        role: person.role || null,
        permission: rel.permission,
        grantedAt: rel.grantedAt,
        expiresAt: rel.expiresAt || null,
        grantedBy: rel.grantedBy || null,
        note: rel.note || null,
      };
    });
  }

  /**
   * List all Spaces and Assets shared with a specific person (active, non-expired).
   * @param {string} email - The person's email
   * @returns {Promise<Array>} Array of { id, name, type, permission, grantedAt, expiresAt, grantedBy }
   */
  async getSharedWithMe(email) {
    const now = Date.now();
    const cypher = `
      MATCH (p:Person {id: '${escapeCypher(email)}'})-[r:SHARED_WITH]->(t)
      WHERE (t:Space OR t:Asset) AND (r.expiresAt IS NULL OR r.expiresAt > ${now})
      RETURN t, r, labels(t) AS nodeLabels
    `;

    const result = await this.executeQuery(cypher);
    if (!result || !Array.isArray(result)) return [];

    return result.map((row) => {
      const target = row.t?.properties || row.t || {};
      const rel = row.r?.properties || row.r || {};
      const labels = row.nodeLabels || [];
      const type = labels.includes('Space') ? 'space' : labels.includes('Asset') ? 'asset' : 'unknown';
      return {
        id: target.id,
        name: target.name || target.title || target.id,
        type,
        permission: rel.permission,
        grantedAt: rel.grantedAt,
        expiresAt: rel.expiresAt || null,
        grantedBy: rel.grantedBy || null,
      };
    });
  }

  // ============================================
  // GENERAL QUERY EXECUTION
  // ============================================

  /**
   * Execute a Cypher query against the Neo4j Cypher Proxy
   *
   * Uses async job pattern:
   * 1. POST {cypher, parameters, neo4jPassword} → {jobId}
   * 2. Poll GET ?jobId=... → {result: {status, records, fields}}
   *
   * @param {string} cypher - Cypher query string
   * @param {Object} [parameters] - Bound parameters for $param references
   * @returns {Promise<Array>} Array of record objects (each record is {key: value, ...})
   * @throws {Error} On network, query, or timeout error
   */
  async executeQuery(cypher, parameters = {}) {
    // Prefer the direct-Aura path when standard credentials are
    // configured. The GSX proxy was the original path but is currently
    // returning `POST error: no handler` for every query; direct-Aura
    // bypasses it entirely. See top-of-file comment for rationale.
    //
    // If the direct path errors with what looks like a network/auth issue
    // and the GSX endpoint is configured, fall back to GSX as a last
    // resort. App-level errors (Cypher syntax, constraint violations)
    // bubble up directly without fallback because GSX wouldn't fix them.
    if (this._hasDirectCreds()) {
      try {
        return await this._executeDirect(cypher, parameters);
      } catch (err) {
        const msg = (err && err.message) || '';
        const isNetworkish =
          /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|getaddrinfo|ServiceUnavailable|SessionExpired|connection.*closed/i.test(msg);
        if (isNetworkish && this.endpoint && this.neo4jPassword) {
          console.warn('[OmniGraph] Direct Aura unavailable; falling back to GSX endpoint:', msg);
        } else {
          // Non-network error -- propagate; GSX wouldn't fix it.
          throw err;
        }
      }
    }

    if (!this.endpoint) {
      throw new Error('OmniGraph endpoint not configured (and direct-Aura not available)');
    }
    if (!this.neo4jPassword) {
      throw new Error('Neo4j password not configured');
    }

    const startTime = Date.now();

    try {
      console.log('[OmniGraph] Executing query:', cypher.substring(0, 100) + '...');

      // Step 1: Submit the query
      const postBody = {
        cypher,
        neo4jPassword: this.neo4jPassword,
      };
      if (parameters && Object.keys(parameters).length > 0) {
        postBody.parameters = parameters;
      }
      if (this.neo4jUri) {
        postBody.neo4jUri = this.neo4jUri;
      }
      if (this.neo4jUser && this.neo4jUser !== 'neo4j') {
        postBody.neo4jUser = this.neo4jUser;
      }
      if (this.database && this.database !== 'neo4j') {
        postBody.database = this.database;
      }

      const postResponse = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(postBody),
      });

      const postData = await postResponse.json();

      if (!postResponse.ok) {
        const errorMsg = postData.error || postData.message || `HTTP ${postResponse.status}`;
        console.error('[OmniGraph] POST error:', errorMsg);
        throw new Error(errorMsg);
      }

      if (postData.error) {
        console.error('[OmniGraph] Submission error:', postData.error);
        throw new Error(postData.error);
      }

      const jobId = postData.jobId;
      if (!jobId) {
        // Direct response (no job pattern) — return result directly
        if (postData.result) {
          return postData.result?.records || postData.result || [];
        }
        throw new Error('No jobId returned from proxy');
      }

      // Step 2: Poll for the result
      const pollUrl = `${this.endpoint}?jobId=${encodeURIComponent(jobId)}`;
      const maxAttempts = Math.ceil(this.timeout / this.pollInterval);

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, this.pollInterval));

        const elapsed = Date.now() - startTime;
        if (elapsed > this.timeout) {
          throw new Error(`Neo4j query timed out after ${Math.round(elapsed / 1000)}s`);
        }

        const pollResponse = await fetch(pollUrl);
        const pollData = await pollResponse.json();

        // Still processing
        if (pollData.status === 'job started' || pollData.status === 'pending') {
          continue;
        }

        // Success
        if (pollData.result?.status === 'ok') {
          const records = pollData.result.records || [];
          console.log(`[OmniGraph] Query returned ${records.length} records in ${Date.now() - startTime}ms`);
          this._counters.gsxQueries++;
          return records;
        }

        // Error from Neo4j
        if (pollData.result?.status === 'error') {
          const errorMsg = pollData.result.error || 'Neo4j query error';
          console.error('[OmniGraph] Neo4j error:', errorMsg);
          throw new Error(errorMsg);
        }

        // Flow-level error (timeout, crash)
        if (pollData.status === 'error') {
          const errorMsg = pollData.error || 'Proxy error';
          console.error('[OmniGraph] Proxy error:', errorMsg);
          throw new Error(errorMsg);
        }

        // Unknown response — keep polling
        console.warn('[OmniGraph] Unexpected poll response:', JSON.stringify(pollData).substring(0, 200));
      }

      throw new Error(`Neo4j query polling timed out after ${maxAttempts} attempts`);
    } catch (error) {
      this._counters.gsxErrors++;
      if (error.name === 'AbortError') {
        throw new Error('Neo4j query aborted');
      }
      throw error;
    }
  }

  /**
   * Diagnostic snapshot for /sync/queue or operator queries.
   * Indicates which path(s) are wired and how each is being used.
   */
  inspect() {
    return {
      endpoint: this.endpoint || null,
      neo4jUri: this.neo4jUri || null,
      neo4jUser: this.neo4jUser,
      database: this.database,
      hasPassword: !!this.neo4jPassword,
      hasDirectCreds: this._hasDirectCreds(),
      directDriverActive: !!this._directDriver,
      preferredPath: this._hasDirectCreds() ? 'direct' : (this.endpoint && this.neo4jPassword ? 'gsx' : 'none'),
      counters: { ...this._counters },
    };
  }

  // ============================================
  // SPACE OPERATIONS
  // ============================================

  /**
   * Create or update a Space node (represents a collection/note in the graph)
   * @param {Object} space - Space data
   * @param {string} space.id - Space ID
   * @param {string} space.name - Space name
   * @param {string} space.description - Space description
   * @param {string} space.icon - Space icon
   * @param {string} space.color - Space color
   * @param {string} space.visibility - 'public' or 'private'
   * @returns {Promise<Object>} Created/updated space node
   */
  async upsertSpace(space) {
    const now = Date.now();
    const user = this.currentUser;

    // Build history entry for this operation
    const _historyEntry = buildHistoryEntry(user, 'UPSERT', [
      { property: 'name', old_value: null, new_value: space.name },
    ]);

    const cypher = `
      MERGE (s:Space {id: '${escapeCypher(space.id)}'})
      ON CREATE SET
          s.created_by_app_name = '${APP_IDENTITY.name}',
          s.created_by_app_id = '${APP_IDENTITY.id}',
          s.created_by_user = '${escapeCypher(user)}',
          s.created_at = ${now},
          s._history = '[]'
      SET s.name = '${escapeCypher(space.name || space.id)}',
          s.description = '${escapeCypher(space.description || '')}',
          s.icon = '${escapeCypher(space.icon || '')}',
          s.color = '${escapeCypher(space.color || '#64c8ff')}',
          s.visibility = '${escapeCypher(space.visibility || 'private')}',
          s.status = 'published',
          s.active = true,
          s.updated_by_app_name = '${APP_IDENTITY.name}',
          s.updated_by_app_id = '${APP_IDENTITY.id}',
          s.updated_by_user = '${escapeCypher(user)}',
          s.updated_at = ${now}
      RETURN s
    `;
    return this.executeQuery(cypher);
  }

  /**
   * Get a Space node by ID
   * @param {string} spaceId - Space ID
   * @returns {Promise<Object|null>} Space node or null
   */
  async getSpace(spaceId) {
    const cypher = `
      MATCH (s:Space {id: '${escapeCypher(spaceId)}'})
      WHERE s.active = true OR s.active IS NULL
      RETURN s
      LIMIT 1
    `;
    const result = await this.executeQuery(cypher);
    // Extract properties from the graph node - API returns { id, labels, properties }
    const spaceNode = result?.[0]?.s;
    return spaceNode?.properties || spaceNode || null;
  }

  /**
   * Get all active Space nodes created by a specific user.
   * @param {string} email - The creator's email address
   * @returns {Promise<Array>} Array of { id, name, icon, color, description, visibility, createdAt, source }
   */
  async getSpacesByUser(email) {
    if (!email || !email.includes('@')) return [];

    const cypher = `
      MATCH (s:Space)
      WHERE s.created_by_user = '${escapeCypher(email)}'
        AND (s.active = true OR s.active IS NULL)
      RETURN s
    `;
    const result = await this.executeQuery(cypher);
    if (!result || !Array.isArray(result)) return [];

    return result.map((row) => {
      const s = row.s?.properties || row.s || {};
      return {
        id: s.id,
        name: s.name || s.id,
        icon: s.icon || '',
        color: s.color || '#64c8ff',
        description: s.description || '',
        visibility: s.visibility || 'private',
        createdAt: s.created_at || null,
        source: 'owned',
      };
    });
  }

  /**
   * Discover all spaces associated with an email -- both owned and shared.
   * Merges getSpacesByUser + getSharedWithMe, deduplicating by space ID.
   * @param {string} email - User email address
   * @returns {Promise<Array>} Unified array of discovered spaces with source field ('owned' or 'shared')
   */
  async discoverSpaces(email) {
    if (!email || !email.includes('@')) return [];

    const [owned, shared] = await Promise.all([this.getSpacesByUser(email), this.getSharedWithMe(email)]);

    const seen = new Map();

    for (const space of owned) {
      seen.set(space.id, space);
    }

    const sharedSpaces = (shared || []).filter((s) => s.type === 'space');
    for (const s of sharedSpaces) {
      if (!seen.has(s.id)) {
        seen.set(s.id, {
          id: s.id,
          name: s.name,
          icon: '',
          color: '#64c8ff',
          description: '',
          visibility: 'private',
          createdAt: s.grantedAt || null,
          source: 'shared',
          permission: s.permission,
          grantedBy: s.grantedBy,
        });
      }
    }

    return Array.from(seen.values());
  }

  /**
   * Soft delete a Space node
   * @param {string} spaceId - Space ID
   * @param {boolean} includeAssets - Also soft-delete all assets in space
   * @returns {Promise<Object>} Result with unpublished count
   */
  async softDeleteSpace(spaceId, includeAssets = false) {
    const now = Date.now();
    const user = this.currentUser;

    // Soft-delete the space with provenance
    const spaceCypher = `
      MATCH (s:Space {id: '${escapeCypher(spaceId)}'})
      SET s.status = 'unpublished',
          s.unpublishedAt = ${now},
          s.active = false,
          s.updated_by_app_name = '${APP_IDENTITY.name}',
          s.updated_by_app_id = '${APP_IDENTITY.id}',
          s.updated_by_user = '${escapeCypher(user)}',
          s.updated_at = ${now}
      RETURN s
    `;
    await this.executeQuery(spaceCypher);

    // Optionally soft-delete all assets in this space
    if (includeAssets) {
      const assetsCypher = `
        MATCH (a:Asset)-[:BELONGS_TO]->(s:Space {id: '${escapeCypher(spaceId)}'})
        SET a.status = 'unpublished',
            a.unpublishedAt = ${now},
            a.active = false,
            a.updated_by_app_name = '${APP_IDENTITY.name}',
            a.updated_by_app_id = '${APP_IDENTITY.id}',
            a.updated_by_user = '${escapeCypher(user)}',
            a.updated_at = ${now}
        RETURN count(a) as unpublishedCount
      `;
      const result = await this.executeQuery(assetsCypher);
      return { spaceUnpublished: true, assetsUnpublished: result?.[0]?.unpublishedCount || 0 };
    }

    return { spaceUnpublished: true, assetsUnpublished: 0 };
  }

  // ============================================
  // ASSET TYPE HUB OPERATIONS
  // ============================================

  /**
   * Ensure an AssetType hub node exists for a space
   * Creates the hub if it doesn't exist and links it to the space
   * @param {string} spaceId - Space ID
   * @param {string} assetType - Asset type (video, image, text, code, file, etc.)
   * @returns {Promise<Object>} AssetType hub node
   */
  async ensureAssetTypeHub(spaceId, assetType) {
    const typeLabel = `${capitalize(assetType)}Type`;
    const hubId = `${spaceId}_${assetType}`;
    const now = Date.now();
    const user = this.currentUser;

    const cypher = `
      MATCH (s:Space {id: '${escapeCypher(spaceId)}'})
      MERGE (t:${typeLabel} {id: '${escapeCypher(hubId)}', spaceId: '${escapeCypher(spaceId)}'})
      ON CREATE SET
          t.created_by_app_name = '${APP_IDENTITY.name}',
          t.created_by_app_id = '${APP_IDENTITY.id}',
          t.created_by_user = '${escapeCypher(user)}',
          t.created_at = ${now},
          t._history = '[]'
      MERGE (s)-[:HAS_TYPE]->(t)
      SET t.assetType = '${escapeCypher(assetType)}',
          t.updated_by_app_name = '${APP_IDENTITY.name}',
          t.updated_by_app_id = '${APP_IDENTITY.id}',
          t.updated_by_user = '${escapeCypher(user)}',
          t.updated_at = ${now}
      RETURN t
    `;
    return this.executeQuery(cypher);
  }

  // ============================================
  // PERSON OPERATIONS
  // ============================================

  /**
   * Ensure a Person node exists for a user (email is the unique key)
   * Creates the person if they don't exist, updates timestamp if they do
   * @param {string} email - User email (unique identifier)
   * @param {string} name - Optional display name
   * @param {string} role - Optional role (USER, ADMIN, etc.)
   * @returns {Promise<Object>} Person node
   */
  async ensurePerson(email, name = null, role = 'USER') {
    if (!email) {
      console.warn('[OmniGraph] Cannot create Person without email');
      return null;
    }

    const now = Date.now();
    const displayName = name || email.split('@')[0]; // Use email prefix if no name

    const cypher = `
      MERGE (p:Person {id: '${escapeCypher(email)}'})
      ON CREATE SET
          p.email = '${escapeCypher(email)}',
          p.name = '${escapeCypher(displayName)}',
          p.role = '${escapeCypher(role)}',
          p.created_by_app_name = '${APP_IDENTITY.name}',
          p.created_by_app_id = '${APP_IDENTITY.id}',
          p.created_by_user = '${escapeCypher(email)}',
          p.created_at = ${now},
          p.updated_by_app_name = '${APP_IDENTITY.name}',
          p.updated_by_app_id = '${APP_IDENTITY.id}',
          p.updated_by_user = '${escapeCypher(email)}',
          p.updated_at = ${now},
          p._history = '[]'
      ON MATCH SET
          p.updated_by_app_name = '${APP_IDENTITY.name}',
          p.updated_by_app_id = '${APP_IDENTITY.id}',
          p.updated_at = ${now}
      RETURN p
    `;
    return this.executeQuery(cypher);
  }

  /**
   * Get a Person node by email
   * @param {string} email - Person's email
   * @returns {Promise<Object|null>} Person node or null
   */
  async getPerson(email) {
    const cypher = `
      MATCH (p:Person {id: '${escapeCypher(email)}'})
      RETURN p
      LIMIT 1
    `;
    const result = await this.executeQuery(cypher);
    // Extract properties from the graph node - API returns { id, labels, properties }
    const personNode = result?.[0]?.p;
    return personNode?.properties || personNode || null;
  }

  // ============================================
  // ASSET OPERATIONS
  // ============================================

  /**
   * Create or update an Asset node with ALL metadata (two-layer: Files + Graph)
   * Following schema-first pattern from the ontology guide.
   *
   * @param {Object} asset - Asset data (all metadata stored in graph)
   * @param {string} asset.id - Asset ID
   * @param {string} asset.title - Asset title
   * @param {string} asset.description - Asset description
   * @param {string} asset.fileName - Original file name
   * @param {string} asset.fileType - MIME type
   * @param {number} asset.fileSize - File size in bytes
   * @param {string} asset.fileUrl - GSX Files URL
   * @param {string} asset.visibility - 'public' or 'private'
   * @param {string} asset.version - Version string (e.g., 'v1', 'v2')
   * @param {string} asset.contentHash - SHA256 content hash
   * @param {string[]} asset.tags - Array of tags
   * @param {string} asset.source - Source URL or origin
   * @param {string} asset.author - Author/creator
   * @param {string} asset.notes - User notes
   * @param {string} spaceId - Parent space ID
   * @param {string} assetType - Asset type for hub connection
   * @param {Object} spaceData - Optional full space data (if provided, used for upsertSpace)
   * @returns {Promise<Object>} Created/updated asset node
   */
  async upsertAsset(asset, spaceId, assetType, spaceData = null) {
    // First ensure the space, type hub, and person exist
    // Use full space data if provided, otherwise fallback to minimal data
    const spaceInfo = spaceData || { id: spaceId, name: spaceId, visibility: asset.visibility };
    await this.upsertSpace(spaceInfo);
    await this.ensureAssetTypeHub(spaceId, assetType);

    // Ensure the Person node exists for the current user (email is the key)
    const user = this.currentUser;
    if (user && user !== 'system' && user.includes('@')) {
      await this.ensurePerson(user);
    }
    const typeLabel = `${capitalize(assetType)}Type`;
    const hubId = `${spaceId}_${assetType}`;
    const now = Date.now();

    // Prepare tags as comma-separated string for graph storage
    const tagsString = Array.isArray(asset.tags) ? asset.tags.join(',') : asset.tags || '';

    const hasValidUser = user && user !== 'system' && user.includes('@');

    // Step 1: MERGE the asset node and set all properties (simple, fast query)
    const assetCypher = `
      MERGE (a:Asset {id: '${escapeCypher(asset.id)}'})
      ON CREATE SET
          a.created_by_app_name = '${APP_IDENTITY.name}',
          a.created_by_app_id = '${APP_IDENTITY.id}',
          a.created_by_user = '${escapeCypher(user)}',
          a.created_at = ${now},
          a._history = '[]'
      SET a.title = '${escapeCypher(asset.title || asset.fileName || 'Untitled')}',
          a.description = '${escapeCypher(asset.description || '')}',
          a.fileName = '${escapeCypher(asset.fileName || '')}',
          a.fileType = '${escapeCypher(asset.fileType || '')}',
          a.fileSize = ${asset.fileSize || 0},
          a.fileUrl = '${escapeCypher(asset.fileUrl || '')}',
          a.visibility = '${escapeCypher(asset.visibility || 'private')}',
          a.version = '${escapeCypher(asset.version || 'v1')}',
          a.contentHash = '${escapeCypher(asset.contentHash || '')}',
          a.tags = '${escapeCypher(tagsString)}',
          a.source = '${escapeCypher(asset.source || '')}',
          a.author = '${escapeCypher(asset.author || '')}',
          a.notes = '${escapeCypher(asset.notes || '')}',
          a.assetType = '${escapeCypher(assetType)}',
          a.spaceId = '${escapeCypher(spaceId)}',
          a.status = 'published',
          a.active = true,
          a.updated_by_app_name = '${APP_IDENTITY.name}',
          a.updated_by_app_id = '${APP_IDENTITY.id}',
          a.updated_by_user = '${escapeCypher(user)}',
          a.updated_at = ${now}
      RETURN a
    `;
    const assetResult = await this.executeQuery(assetCypher);

    // Step 2: Link asset to type hub (CONTAINS) and space (BELONGS_TO)
    const linkCypher = `
      MATCH (a:Asset {id: '${escapeCypher(asset.id)}'})
      MATCH (s:Space {id: '${escapeCypher(spaceId)}'})
      MATCH (t:${typeLabel} {id: '${escapeCypher(hubId)}'})
      MERGE (t)-[r1:CONTAINS]->(a) SET r1.at = ${now}
      MERGE (a)-[r2:BELONGS_TO]->(s) SET r2.at = ${now}
      RETURN a
    `;
    await this.executeQuery(linkCypher);

    // Step 3: Link asset to creator (CREATED) if valid user
    if (hasValidUser) {
      const creatorCypher = `
        MATCH (a:Asset {id: '${escapeCypher(asset.id)}'})
        MATCH (p:Person {id: '${escapeCypher(user)}'})
        MERGE (p)-[r:CREATED]->(a) SET r.at = ${now}
        RETURN a
      `;
      await this.executeQuery(creatorCypher);
    }

    return assetResult;
  }

  /**
   * Get an Asset node by ID
   * @param {string} assetId - Asset ID
   * @returns {Promise<Object|null>} Asset node with space info or null
   */
  async getAsset(assetId) {
    const cypher = `
      MATCH (a:Asset {id: '${escapeCypher(assetId)}'})
      WHERE a.active = true OR a.active IS NULL
      OPTIONAL MATCH (a)-[:BELONGS_TO]->(s:Space)
      RETURN a, s.id AS spaceId, s.name AS spaceName
      LIMIT 1
    `;
    const result = await this.executeQuery(cypher);
    if (result?.[0]) {
      // Extract properties from the graph node - API returns { id, labels, properties }
      const assetNode = result[0].a;
      const assetProps = assetNode?.properties || assetNode;
      return {
        ...assetProps,
        _graphNodeId: assetNode?.id, // Keep graph node ID separately if needed
        spaceId: result[0].spaceId,
        spaceName: result[0].spaceName,
      };
    }
    return null;
  }

  /**
   * Verify an asset exists in the graph with matching content hash
   * Used to confirm push operations succeeded
   * @param {string} assetId - Asset ID to verify
   * @param {string} expectedHash - Expected content hash
   * @returns {Promise<Object>} Verification result with fileUrl if successful
   */
  async verifyAsset(assetId, expectedHash) {
    try {
      const asset = await this.getAsset(assetId);

      if (!asset) {
        return {
          verified: false,
          reason: 'Asset not found in graph',
          assetId,
        };
      }

      // Check content hash matches
      if (expectedHash && asset.contentHash !== expectedHash) {
        return {
          verified: false,
          reason: 'Content hash mismatch',
          expected: expectedHash,
          actual: asset.contentHash,
          assetId,
        };
      }

      // Verification successful
      return {
        verified: true,
        assetId: asset.id,
        fileUrl: asset.fileUrl || null,
        spaceId: asset.spaceId,
        spaceName: asset.spaceName,
        version: asset.version,
        contentHash: asset.contentHash,
        title: asset.title,
      };
    } catch (error) {
      return {
        verified: false,
        reason: `Verification query failed: ${error.message}`,
        assetId,
      };
    }
  }

  /**
   * Verify a space exists in the graph
   * @param {string} spaceId - Space ID to verify
   * @returns {Promise<Object>} Verification result
   */
  async verifySpace(spaceId) {
    try {
      const space = await this.getSpace(spaceId);

      if (!space) {
        return {
          verified: false,
          reason: 'Space not found in graph',
          spaceId,
        };
      }

      return {
        verified: true,
        spaceId: space.id,
        name: space.name,
        visibility: space.visibility,
      };
    } catch (error) {
      return {
        verified: false,
        reason: `Space verification failed: ${error.message}`,
        spaceId,
      };
    }
  }

  /**
   * Get all active assets in a space
   * @param {string} spaceId - Space ID
   * @param {number} limit - Max results (default 100)
   * @returns {Promise<Array>} Array of asset nodes
   */
  async getActiveAssetsInSpace(spaceId, limit = 100) {
    const cypher = `
      MATCH (a:Asset)-[:BELONGS_TO]->(s:Space {id: '${escapeCypher(spaceId)}'})
      WHERE a.active = true OR a.active IS NULL
      RETURN a
      LIMIT ${limit}
    `;
    const result = await this.executeQuery(cypher);
    // Extract properties from graph nodes - API returns { id, labels, properties }
    return result?.map((r) => r.a?.properties || r.a) || [];
  }

  /**
   * Get the latest Commit node for a space.
   * @param {string} spaceId
   * @returns {Promise<{hash: string, timestamp: number, message: string, author: string}|null>}
   */
  async getLatestCommit(spaceId) {
    const cypher = `
      MATCH (c:Commit)-[:IN_SPACE]->(s:Space {id: '${escapeCypher(spaceId)}'})
      RETURN c
      ORDER BY c.timestamp DESC
      LIMIT 1
    `;
    const result = await this.executeQuery(cypher);
    const node = result?.[0]?.c;
    if (!node) return null;
    const props = node.properties || node;
    return {
      hash: props.hash || null,
      timestamp: props.timestamp || null,
      message: props.message || null,
      author: props.author || null,
    };
  }

  /**
   * Get all active assets in a space with content hashes for diffing.
   * @param {string} spaceId
   * @returns {Promise<Array<{id, title, type, contentHash, fileUrl, updated_at}>>}
   */
  async getSpaceAssetsWithHashes(spaceId) {
    const cypher = `
      MATCH (a:Asset)-[:BELONGS_TO]->(s:Space {id: '${escapeCypher(spaceId)}'})
      WHERE a.active = true OR a.active IS NULL
      RETURN a.id AS id, a.title AS title, a.assetType AS type,
             a.contentHash AS contentHash, a.fileUrl AS fileUrl,
             a.updated_at AS updatedAt, a.spaceId AS spaceId
      ORDER BY a.updated_at DESC
    `;
    const result = await this.executeQuery(cypher);
    return (result || []).map(r => ({
      id: r.id,
      title: r.title,
      type: r.type,
      contentHash: r.contentHash || null,
      fileUrl: r.fileUrl || null,
      updatedAt: r.updatedAt || null,
      spaceId: r.spaceId,
    }));
  }

  /**
   * Soft delete an Asset node
   * @param {string} assetId - Asset ID
   * @returns {Promise<Object>} Updated asset node
   */
  async softDeleteAsset(assetId) {
    const now = Date.now();
    const user = this.currentUser;

    const cypher = `
      MATCH (a:Asset {id: '${escapeCypher(assetId)}'})
      SET a.status = 'unpublished',
          a.unpublishedAt = ${now},
          a.active = false,
          a.updated_by_app_name = '${APP_IDENTITY.name}',
          a.updated_by_app_id = '${APP_IDENTITY.id}',
          a.updated_by_user = '${escapeCypher(user)}',
          a.updated_at = ${now}
      RETURN a
    `;
    return this.executeQuery(cypher);
  }

  /**
   * Reactivate a soft-deleted Asset node
   * @param {string} assetId - Asset ID
   * @returns {Promise<Object>} Reactivated asset node
   */
  async reactivateAsset(assetId) {
    const now = Date.now();
    const user = this.currentUser;

    const cypher = `
      MATCH (a:Asset {id: '${escapeCypher(assetId)}'})
      SET a.status = 'published',
          a.active = true,
          a.unpublishedAt = null,
          a.reactivatedAt = ${now},
          a.updated_by_app_name = '${APP_IDENTITY.name}',
          a.updated_by_app_id = '${APP_IDENTITY.id}',
          a.updated_by_user = '${escapeCypher(user)}',
          a.updated_at = ${now}
      RETURN a
    `;
    return this.executeQuery(cypher);
  }

  /**
   * Change visibility of an Asset node
   * @param {string} assetId - Asset ID
   * @param {string} visibility - 'public' or 'private'
   * @returns {Promise<Object>} Updated asset node
   */
  async changeAssetVisibility(assetId, visibility) {
    const now = Date.now();
    const user = this.currentUser;

    const cypher = `
      MATCH (a:Asset {id: '${escapeCypher(assetId)}'})
      SET a.visibility = '${escapeCypher(visibility)}',
          a.visibilityChangedAt = ${now},
          a.updated_by_app_name = '${APP_IDENTITY.name}',
          a.updated_by_app_id = '${APP_IDENTITY.id}',
          a.updated_by_user = '${escapeCypher(user)}',
          a.updated_at = ${now}
      RETURN a
    `;
    return this.executeQuery(cypher);
  }

  // ============================================
  // IDW (Interactive Digital Worker) OPERATIONS
  // ============================================

  /**
   * Fetch all active IDW nodes from the graph.
   * Returns data in the IDW Store directory format:
   *   { availableIDWs: { all, featured, categories }, installedIDWs }
   *
   * @param {Array} installedIds - Array of installed IDW IDs (from local settings)
   * @returns {Promise<Object>} IDW directory object
   */
  async getIDWDirectory(installedIds = []) {
    // Query all active IDW nodes
    const cypher = `
      MATCH (i:IDW)
      WHERE i.active = true OR i.active IS NULL
      RETURN i
      ORDER BY i.name
    `;

    const result = await this.executeQuery(cypher);
    const allIDWs = (result || []).map((row) => {
      const node = row.i?.properties || row.i || {};
      return this._mapGraphNodeToIDW(node);
    });

    // Build featured list (nodes explicitly marked, or top-rated as fallback)
    const featured = allIDWs.filter((idw) => idw._featured).slice(0, 6);

    // If nobody is explicitly featured, pick the top-rated
    const featuredList =
      featured.length > 0 ? featured : [...allIDWs].sort((a, b) => (b.rating || 0) - (a.rating || 0)).slice(0, 6);

    // Build category summary
    const categoryMap = {};
    for (const idw of allIDWs) {
      const cat = idw.category || 'Other';
      if (!categoryMap[cat]) {
        categoryMap[cat] = { name: cat, idwCount: 0, iconName: null };
      }
      categoryMap[cat].idwCount++;
      // Use the first iconName encountered for the category
      if (!categoryMap[cat].iconName && idw.iconName) {
        categoryMap[cat].iconName = idw.iconName;
      }
    }
    const categories = Object.values(categoryMap).sort((a, b) => b.idwCount - a.idwCount);

    // Build installed list
    const installedSet = new Set(installedIds);
    const installedIDWs = allIDWs
      .filter((idw) => installedSet.has(idw.id))
      .map((idw) => ({ idwId: idw.id, installedAt: null }));

    return {
      availableIDWs: {
        all: allIDWs,
        featured: featuredList,
        categories,
      },
      installedIDWs,
      metadata: {
        source: 'omnigraph',
        fetchedAt: new Date().toISOString(),
        totalCount: allIDWs.length,
      },
    };
  }

  /**
   * Get a single IDW node by ID.
   * @param {string} idwId - IDW ID
   * @returns {Promise<Object|null>} IDW object or null
   */
  async getIDW(idwId) {
    const cypher = `
      MATCH (i:IDW {id: '${escapeCypher(idwId)}'})
      WHERE i.active = true OR i.active IS NULL
      RETURN i
      LIMIT 1
    `;
    const result = await this.executeQuery(cypher);
    if (!result || result.length === 0) return null;

    const node = result[0].i?.properties || result[0].i || {};
    return this._mapGraphNodeToIDW(node);
  }

  /**
   * Map a raw graph node to the IDW Store data format.
   * Handles property naming differences between graph storage and UI expectations.
   * @param {Object} node - Raw graph node properties
   * @returns {Object} IDW object in store format
   * @private
   */
  _mapGraphNodeToIDW(node) {
    // Parse tags: stored as comma-separated string or JSON array
    let tags = [];
    if (node.tags) {
      try {
        tags = JSON.parse(node.tags);
      } catch (_) {
        tags = String(node.tags)
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
      }
    }

    // Parse screenshots: stored as comma-separated URLs or JSON array
    let screenshots = [];
    if (node.screenshots) {
      try {
        screenshots = JSON.parse(node.screenshots);
      } catch (_) {
        screenshots = String(node.screenshots)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      }
    }

    // Parse pricing: stored as JSON string or individual fields
    let pricing = null;
    if (node.pricing) {
      try {
        pricing = typeof node.pricing === 'string' ? JSON.parse(node.pricing) : node.pricing;
      } catch (_) {
        pricing = { model: 'free', startingPrice: 0 };
      }
    } else if (node.pricingModel || node.startingPrice !== undefined) {
      pricing = {
        model: node.pricingModel || 'free',
        startingPrice: parseFloat(node.startingPrice) || 0,
      };
    }

    return {
      id: node.id || '',
      name: node.name || node.label || 'Untitled IDW',
      developer: node.developer || node.publisher || '',
      description: node.description || '',
      category: node.category || 'Other',
      url: node.url || node.chatUrl || '',
      homePageURL: node.homePageURL || node.homePageUrl || node.homepageUrl || '',
      rating: parseFloat(node.rating) || 0,
      reviewCount: parseInt(node.reviewCount) || 0,
      version: node.version || '1.0.0',
      lastUpdated: node.lastUpdated || node.updated_at || node.created_at || null,
      pricing,
      tags,
      screenshots,
      apiEndpoint: node.apiEndpoint || null,
      apiKeyRequired: node.apiKeyRequired === true || node.apiKeyRequired === 'true',
      apiKeyName: node.apiKeyName || null,
      thumbnailUrl: node.thumbnailUrl || node.thumbnail || null,
      imageUrl: node.imageUrl || node.image || null,
      iconName: node.iconName || null,
      // Internal flag (not rendered by UI) -- used to build featured list
      _featured: node.featured === true || node.featured === 'true',
    };
  }

  // ============================================
  // LIBRARY: ORGANIZATION, TEAM, LIBRARY
  // ============================================

  /**
   * Ensure an Organization node exists. Idempotent (MERGE on id).
   * @param {Object} org - { id, name, domain, plan }
   * @returns {Promise<Object>} Organization node
   */
  async ensureOrganization(org) {
    const now = Date.now();
    const user = this.currentUser;
    const cypher = `
      MERGE (o:Organization {id: '${escapeCypher(org.id)}'})
      ON CREATE SET
          o.name = '${escapeCypher(org.name || org.id)}',
          o.domain = '${escapeCypher(org.domain || '')}',
          o.plan = '${escapeCypher(org.plan || 'free')}',
          o.active = true,
          o.created_by_app_name = '${APP_IDENTITY.name}',
          o.created_by_app_id = '${APP_IDENTITY.id}',
          o.created_by_user = '${escapeCypher(user)}',
          o.created_at = ${now},
          o.updated_by_app_name = '${APP_IDENTITY.name}',
          o.updated_by_app_id = '${APP_IDENTITY.id}',
          o.updated_by_user = '${escapeCypher(user)}',
          o.updated_at = ${now},
          o._history = '[]'
      ON MATCH SET
          o.updated_by_app_name = '${APP_IDENTITY.name}',
          o.updated_by_app_id = '${APP_IDENTITY.id}',
          o.updated_by_user = '${escapeCypher(user)}',
          o.updated_at = ${now}
      RETURN o
    `;
    return this.executeQuery(cypher);
  }

  /**
   * Ensure a Team node exists and is linked to its Organization.
   * @param {Object} team - { id, name, orgId, description }
   * @returns {Promise<Object>} Team node
   */
  async ensureTeam(team) {
    const now = Date.now();
    const user = this.currentUser;
    const cypher = `
      MERGE (t:Team {id: '${escapeCypher(team.id)}'})
      ON CREATE SET
          t.name = '${escapeCypher(team.name || team.id)}',
          t.description = '${escapeCypher(team.description || '')}',
          t.active = true,
          t.created_by_app_name = '${APP_IDENTITY.name}',
          t.created_by_app_id = '${APP_IDENTITY.id}',
          t.created_by_user = '${escapeCypher(user)}',
          t.created_at = ${now},
          t.updated_by_app_name = '${APP_IDENTITY.name}',
          t.updated_by_app_id = '${APP_IDENTITY.id}',
          t.updated_by_user = '${escapeCypher(user)}',
          t.updated_at = ${now},
          t._history = '[]'
      ON MATCH SET
          t.updated_by_app_name = '${APP_IDENTITY.name}',
          t.updated_by_app_id = '${APP_IDENTITY.id}',
          t.updated_by_user = '${escapeCypher(user)}',
          t.updated_at = ${now}
      WITH t
      MATCH (o:Organization {id: '${escapeCypher(team.orgId)}'})
      MERGE (o)-[:HAS_TEAM]->(t)
      RETURN t
    `;
    return this.executeQuery(cypher);
  }

  /**
   * Add a Person as a member of a Team.
   * @param {string} teamId - Team ID
   * @param {string} email - Person email
   * @param {string} [role='member'] - Role within the team
   * @returns {Promise<Object>} Result
   */
  async addTeamMember(teamId, email, role = 'member') {
    const now = Date.now();
    const cypher = `
      MATCH (t:Team {id: '${escapeCypher(teamId)}'})
      MATCH (p:Person {id: '${escapeCypher(email)}'})
      MERGE (t)-[r:MEMBER]->(p)
      SET r.role = '${escapeCypher(role)}',
          r.joinedAt = coalesce(r.joinedAt, ${now})
      RETURN p, t
    `;
    return this.executeQuery(cypher);
  }

  /**
   * Remove a Person from a Team.
   * @param {string} teamId - Team ID
   * @param {string} email - Person email
   * @returns {Promise<Object>} Result
   */
  async removeTeamMember(teamId, email) {
    const cypher = `
      MATCH (t:Team {id: '${escapeCypher(teamId)}'})-[r:MEMBER]->(p:Person {id: '${escapeCypher(email)}'})
      DELETE r
      RETURN p
    `;
    return this.executeQuery(cypher);
  }

  /**
   * Ensure a Library node exists and is linked to its Organization.
   * @param {Object} lib - { id, orgId, name, description }
   * @returns {Promise<Object>} Library node
   */
  async ensureLibrary(lib) {
    const now = Date.now();
    const user = this.currentUser;
    const cypher = `
      MERGE (l:Library {id: '${escapeCypher(lib.id)}'})
      ON CREATE SET
          l.name = '${escapeCypher(lib.name || 'Library')}',
          l.description = '${escapeCypher(lib.description || '')}',
          l.active = true,
          l.created_by_app_name = '${APP_IDENTITY.name}',
          l.created_by_app_id = '${APP_IDENTITY.id}',
          l.created_by_user = '${escapeCypher(user)}',
          l.created_at = ${now},
          l.updated_by_app_name = '${APP_IDENTITY.name}',
          l.updated_by_app_id = '${APP_IDENTITY.id}',
          l.updated_by_user = '${escapeCypher(user)}',
          l.updated_at = ${now},
          l._history = '[]'
      ON MATCH SET
          l.updated_by_app_name = '${APP_IDENTITY.name}',
          l.updated_by_app_id = '${APP_IDENTITY.id}',
          l.updated_by_user = '${escapeCypher(user)}',
          l.updated_at = ${now}
      WITH l
      MATCH (o:Organization {id: '${escapeCypher(lib.orgId)}'})
      MERGE (o)-[:HAS_LIBRARY]->(l)
      RETURN l
    `;
    return this.executeQuery(cypher);
  }

  /**
   * Add an item (IDW, Tool, or Agent) to a Library.
   * @param {string} libraryId - Library ID
   * @param {string} itemId - Item node ID
   * @param {string} itemLabel - Node label ('IDW', 'Tool', or 'Agent')
   * @returns {Promise<Object>} Result
   */
  async addToLibrary(libraryId, itemId, itemLabel) {
    if (!['IDW', 'Tool', 'Agent'].includes(itemLabel)) {
      throw new Error(`Invalid item label: ${itemLabel}. Must be IDW, Tool, or Agent.`);
    }
    const now = Date.now();
    const user = this.currentUser;
    const cypher = `
      MATCH (l:Library {id: '${escapeCypher(libraryId)}'})
      MATCH (item:${itemLabel} {id: '${escapeCypher(itemId)}'})
      MERGE (l)-[r:CONTAINS]->(item)
      SET r.addedAt = coalesce(r.addedAt, ${now}),
          r.addedBy = '${escapeCypher(user)}'
      RETURN item
    `;
    return this.executeQuery(cypher);
  }

  /**
   * Remove an item from a Library.
   * @param {string} libraryId - Library ID
   * @param {string} itemId - Item node ID
   * @param {string} itemLabel - Node label ('IDW', 'Tool', or 'Agent')
   * @returns {Promise<Object>} Result
   */
  async removeFromLibrary(libraryId, itemId, itemLabel) {
    if (!['IDW', 'Tool', 'Agent'].includes(itemLabel)) {
      throw new Error(`Invalid item label: ${itemLabel}. Must be IDW, Tool, or Agent.`);
    }
    const cypher = `
      MATCH (l:Library {id: '${escapeCypher(libraryId)}'})-[r:CONTAINS]->(item:${itemLabel} {id: '${escapeCypher(itemId)}'})
      DELETE r
      RETURN item
    `;
    return this.executeQuery(cypher);
  }

  // ============================================
  // LIBRARY: TOOL AND AGENT NODES
  // ============================================

  /**
   * Create or update a Tool node.
   * @param {Object} tool - { id, name, url, description, docsUrl, windowSize, type, category }
   * @returns {Promise<Object>} Tool node
   */
  async upsertTool(tool) {
    const now = Date.now();
    const user = this.currentUser;
    const cypher = `
      MERGE (t:Tool {id: '${escapeCypher(tool.id)}'})
      ON CREATE SET
          t.active = true,
          t.created_by_app_name = '${APP_IDENTITY.name}',
          t.created_by_app_id = '${APP_IDENTITY.id}',
          t.created_by_user = '${escapeCypher(user)}',
          t.created_at = ${now},
          t._history = '[]'
      SET t.name = '${escapeCypher(tool.name || '')}',
          t.url = '${escapeCypher(tool.url || '')}',
          t.description = '${escapeCypher(tool.description || '')}',
          t.docsUrl = '${escapeCypher(tool.docsUrl || '')}',
          t.windowSize = '${escapeCypher(tool.windowSize || 'large')}',
          t.type = '${escapeCypher(tool.type || 'weblink')}',
          t.category = '${escapeCypher(tool.category || '')}',
          t.updated_by_app_name = '${APP_IDENTITY.name}',
          t.updated_by_app_id = '${APP_IDENTITY.id}',
          t.updated_by_user = '${escapeCypher(user)}',
          t.updated_at = ${now}
      RETURN t
    `;
    return this.executeQuery(cypher);
  }

  /**
   * Get a Tool node by ID.
   * @param {string} toolId - Tool ID
   * @returns {Promise<Object|null>} Tool node or null
   */
  async getTool(toolId) {
    const cypher = `
      MATCH (t:Tool {id: '${escapeCypher(toolId)}'})
      WHERE t.active = true OR t.active IS NULL
      RETURN t LIMIT 1
    `;
    const result = await this.executeQuery(cypher);
    const node = result?.[0]?.t;
    return node?.properties || node || null;
  }

  /**
   * Create or update an Agent node.
   * @param {Object} agent - { id, name, description, categories, keywords, executionType, builtin, prompt, capabilities }
   * @returns {Promise<Object>} Agent node
   */
  async upsertAgent(agent) {
    const now = Date.now();
    const user = this.currentUser;
    const cats = JSON.stringify(agent.categories || []);
    const kw = JSON.stringify(agent.keywords || []);
    const caps = JSON.stringify(agent.capabilities || []);
    const cypher = `
      MERGE (a:Agent {id: '${escapeCypher(agent.id)}'})
      ON CREATE SET
          a.active = true,
          a.created_by_app_name = '${APP_IDENTITY.name}',
          a.created_by_app_id = '${APP_IDENTITY.id}',
          a.created_by_user = '${escapeCypher(user)}',
          a.created_at = ${now},
          a._history = '[]'
      SET a.name = '${escapeCypher(agent.name || '')}',
          a.description = '${escapeCypher(agent.description || '')}',
          a.categories = '${escapeCypher(cats)}',
          a.keywords = '${escapeCypher(kw)}',
          a.capabilities = '${escapeCypher(caps)}',
          a.executionType = '${escapeCypher(agent.executionType || '')}',
          a.builtin = ${agent.builtin === true},
          a.prompt = '${escapeCypher(agent.prompt || '')}',
          a.updated_by_app_name = '${APP_IDENTITY.name}',
          a.updated_by_app_id = '${APP_IDENTITY.id}',
          a.updated_by_user = '${escapeCypher(user)}',
          a.updated_at = ${now}
      RETURN a
    `;
    return this.executeQuery(cypher);
  }

  /**
   * Get an Agent node by ID.
   * @param {string} agentId - Agent ID
   * @returns {Promise<Object|null>} Agent node or null
   */
  async getAgent(agentId) {
    const cypher = `
      MATCH (a:Agent {id: '${escapeCypher(agentId)}'})
      WHERE a.active = true OR a.active IS NULL
      RETURN a LIMIT 1
    `;
    const result = await this.executeQuery(cypher);
    const node = result?.[0]?.a;
    return node?.properties || node || null;
  }

  // ============================================
  // LIBRARY: ENABLE / DISABLE / QUERY
  // ============================================

  /**
   * Enable an item for a user (create ENABLED relationship).
   * @param {string} email - Person email
   * @param {string} itemId - Item node ID
   * @param {string} itemLabel - Node label ('IDW', 'Tool', or 'Agent')
   * @param {string} [source='manual'] - How it was enabled
   * @returns {Promise<Object>} Result
   */
  async enableItem(email, itemId, itemLabel, source = 'manual') {
    if (!['IDW', 'Tool', 'Agent'].includes(itemLabel)) {
      throw new Error(`Invalid item label: ${itemLabel}. Must be IDW, Tool, or Agent.`);
    }
    const now = Date.now();
    const cypher = `
      MATCH (p:Person {id: '${escapeCypher(email)}'})
      MATCH (item:${itemLabel} {id: '${escapeCypher(itemId)}'})
      MERGE (p)-[r:ENABLED]->(item)
      SET r.enabledAt = coalesce(r.enabledAt, ${now}),
          r.source = '${escapeCypher(source)}'
      RETURN item
    `;
    return this.executeQuery(cypher);
  }

  /**
   * Disable an item for a user (delete ENABLED relationship).
   * @param {string} email - Person email
   * @param {string} itemId - Item node ID
   * @param {string} itemLabel - Node label ('IDW', 'Tool', or 'Agent')
   * @returns {Promise<Object>} Result
   */
  async disableItem(email, itemId, itemLabel) {
    if (!['IDW', 'Tool', 'Agent'].includes(itemLabel)) {
      throw new Error(`Invalid item label: ${itemLabel}. Must be IDW, Tool, or Agent.`);
    }
    const cypher = `
      MATCH (p:Person {id: '${escapeCypher(email)}'})-[r:ENABLED]->(item:${itemLabel} {id: '${escapeCypher(itemId)}'})
      DELETE r
      RETURN item
    `;
    return this.executeQuery(cypher);
  }

  /**
   * Get all items a user has enabled, grouped by type.
   * @param {string} email - Person email
   * @returns {Promise<Object>} { idws: [], tools: [], agents: [] }
   */
  async getEnabledItems(email) {
    const cypher = `
      MATCH (p:Person {id: '${escapeCypher(email)}'})-[r:ENABLED]->(item)
      WHERE (item:IDW OR item:Tool OR item:Agent)
        AND (item.active = true OR item.active IS NULL)
      RETURN item, labels(item) AS nodeLabels, r.enabledAt AS enabledAt, r.source AS source
      ORDER BY r.enabledAt DESC
    `;
    const result = await this.executeQuery(cypher) || [];
    const out = { idws: [], tools: [], agents: [] };
    for (const row of result) {
      const node = row.item?.properties || row.item || {};
      const labels = row.nodeLabels || [];
      const meta = { enabledAt: row.enabledAt, source: row.source };
      if (labels.includes('IDW')) out.idws.push({ ...node, ...meta });
      else if (labels.includes('Tool')) out.tools.push({ ...node, ...meta });
      else if (labels.includes('Agent')) out.agents.push({ ...node, ...meta });
    }
    return out;
  }

  /**
   * Get all items available to a user via their Organization's Library.
   * Traverses: Person <- MEMBER - Team <- HAS_TEAM - Org - HAS_LIBRARY -> Library - CONTAINS -> items
   * @param {string} email - Person email
   * @returns {Promise<Object>} { idws: [], tools: [], agents: [], organization: null }
   */
  async getLibraryForUser(email) {
    const cypher = `
      MATCH (p:Person {id: '${escapeCypher(email)}'})<-[:MEMBER]-(t:Team)<-[:HAS_TEAM]-(o:Organization)-[:HAS_LIBRARY]->(l:Library)-[:CONTAINS]->(item)
      WHERE (item.active = true OR item.active IS NULL)
        AND (o.active = true OR o.active IS NULL)
      RETURN item, labels(item) AS nodeLabels, o.id AS orgId, o.name AS orgName, l.id AS libraryId
      ORDER BY item.name
    `;
    const result = await this.executeQuery(cypher) || [];
    const out = { idws: [], tools: [], agents: [], organization: null };
    for (const row of result) {
      if (!out.organization && row.orgId) {
        out.organization = { id: row.orgId, name: row.orgName, libraryId: row.libraryId };
      }
      const node = row.item?.properties || row.item || {};
      const labels = row.nodeLabels || [];
      if (labels.includes('IDW')) out.idws.push(this._mapGraphNodeToIDW(node));
      else if (labels.includes('Tool')) out.tools.push(node);
      else if (labels.includes('Agent')) out.agents.push(node);
    }
    return out;
  }

  /**
   * Get the Organization a user belongs to (via Team membership).
   * @param {string} email - Person email
   * @returns {Promise<Object|null>} Organization node or null
   */
  async getOrganizationForUser(email) {
    const cypher = `
      MATCH (p:Person {id: '${escapeCypher(email)}'})<-[:MEMBER]-(t:Team)<-[:HAS_TEAM]-(o:Organization)
      WHERE o.active = true OR o.active IS NULL
      RETURN o LIMIT 1
    `;
    const result = await this.executeQuery(cypher);
    const node = result?.[0]?.o;
    return node?.properties || node || null;
  }

  // ============================================
  // LIBRARY: SCHEMA BOOTSTRAP
  // ============================================

  /**
   * Ensure all Library-related schemas exist in the graph.
   * Idempotent -- safe to call on every app startup.
   * Creates Schema nodes for Organization, Team, Library, Tool, Agent,
   * TaskQueue, TaskItem, Resource.
   * Patches Person, IDW, and Event schemas to document new relationships.
   * @returns {Promise<void>}
   */
  async ensureLibrarySchema() {
    if (this._librarySchemaEnsured) return;

    try {
      await this.upsertSchema({
        entity: 'Organization',
        version: '1.0.0',
        description: 'Top-level organization that owns a Library of IDWs, Tools, and Agents',
        storagePattern: 'graph',
        instructions: 'MERGE on id. Properties: name, domain, plan (free|pro|enterprise), active. Relationships: HAS_TEAM to Team, HAS_LIBRARY to Library.',
        relationships: '{"HAS_TEAM":"Team","HAS_LIBRARY":"Library"}',
      });

      await this.upsertSchema({
        entity: 'Team',
        version: '1.0.0',
        description: 'A group within an Organization. Members are Person nodes.',
        storagePattern: 'graph',
        instructions: 'MERGE on id. Connected to Organization via HAS_TEAM. Members connected via MEMBER relationship to Person nodes. MEMBER has role and joinedAt properties.',
        relationships: '{"MEMBER":"Person"}',
      });

      await this.upsertSchema({
        entity: 'Library',
        version: '1.0.0',
        description: 'Catalog of all IDWs, Tools, and Agents available to an Organization',
        storagePattern: 'graph',
        instructions: 'One Library per Organization via HAS_LIBRARY. Items linked via CONTAINS relationship to IDW, Tool, or Agent nodes. CONTAINS has addedAt and addedBy properties.',
        relationships: '{"CONTAINS":"IDW,Tool,Agent"}',
      });

      await this.upsertSchema({
        entity: 'Tool',
        version: '1.0.0',
        description: 'A web tool (weblink) that can be opened in the app',
        storagePattern: 'graph',
        instructions: 'MERGE on id. Properties: name, url, description, docsUrl, windowSize, type, category, active. Connected to Library via CONTAINS. Enabled by Person via ENABLED.',
        relationships: '{}',
      });

      await this.upsertSchema({
        entity: 'Agent',
        version: '1.0.0',
        description: 'A voice agent (built-in or custom) that participates in the task exchange',
        storagePattern: 'graph',
        instructions: 'MERGE on id. Properties: name, description, categories (JSON array), keywords (JSON array), capabilities (JSON array), executionType, builtin (boolean), prompt, active. Connected to Library via CONTAINS. Enabled by Person via ENABLED.',
        relationships: '{}',
      });

      await this.upsertSchema({
        entity: 'TaskQueue',
        version: '1.0.0',
        description: 'A named queue that organizes and schedules TaskItems -- acts as the dispatcher and backpressure boundary for a category of work.',
        storagePattern: 'graph',
        id_pattern: 'slug string (e.g. digital-twin-queue, ingestion-queue)',
        instructions: 'MERGE on id. Properties: name, status (active|paused|draining), concurrency_limit, retry_policy (JSON), created_at, updated_at. TaskItems linked via ENQUEUED_IN. Subscribers (Agent, IDW, Flow) linked via SUBSCRIBE_TO.',
        relationships: '{"ENQUEUED_IN":"TaskItem (inbound)","SUBSCRIBE_TO":"Agent,IDW,Flow (inbound)"}',
        crud_examples: JSON.stringify({
          runnable: "MATCH (t:TaskItem {status:'queued'})-[:ENQUEUED_IN]->(q:TaskQueue {status:'active'}) WHERE NOT (t)-[:DEPENDS_ON_TASK]->(:TaskItem {status:'queued'}) AND NOT (t)-[:DEPENDS_ON_TASK]->(:TaskItem {status:'running'}) AND NOT (t)-[:REQUIRES]->(:Resource)-[:LOCKED_BY]->(:TaskItem {status:'running'}) RETURN t,q ORDER BY t.priority DESC, t.queued_at ASC LIMIT 10",
          metrics: "MATCH (q:TaskQueue) OPTIONAL MATCH (t:TaskItem)-[:ENQUEUED_IN]->(q) RETURN q.id,q.name,q.status,count(t) AS total ORDER BY q.name",
          dead_letters: "MATCH (t:TaskItem {status:'dead_letter'})-[:ENQUEUED_IN]->(q:TaskQueue) RETURN t.id,t.name,t.error,q.id AS queue ORDER BY t.completed_at DESC LIMIT 50",
          subscribers: "MATCH (sub)-[:SUBSCRIBE_TO]->(q:TaskQueue) RETURN q.id,q.name,labels(sub) AS type,sub.id,sub.name",
        }),
      });

      await this.upsertSchema({
        entity: 'TaskItem',
        version: '1.0.0',
        description: 'A unit of work enqueued for processing -- the executable item in a TaskQueue with dependency tracking and retry state.',
        storagePattern: 'graph',
        id_pattern: 'generated string (e.g. task-<timestamp>-<random>)',
        instructions: 'MERGE on id. Properties: name, status (queued|running|completed|failed|dead_letter), priority (integer, higher = first), payload (JSON), queued_at, started_at, completed_at, error, retry_count, max_retries. Linked to queue via ENQUEUED_IN. Dependencies via DEPENDS_ON_TASK. Resource locks via REQUIRES. Causal link from Event via TRIGGERS.',
        relationships: '{"ENQUEUED_IN":"TaskQueue","DEPENDS_ON_TASK":"TaskItem","REQUIRES":"Resource"}',
        crud_examples: JSON.stringify({
          by_status: "MATCH (t:TaskItem {status:'queued'})-[:ENQUEUED_IN]->(q:TaskQueue) RETURN t.id,t.name,t.priority,q.name AS queue ORDER BY t.priority DESC LIMIT 50",
          deps: "MATCH (t:TaskItem {id:$id}) OPTIONAL MATCH (t)-[:DEPENDS_ON_TASK]->(up:TaskItem) OPTIONAL MATCH (down:TaskItem)-[:DEPENDS_ON_TASK]->(t) RETURN t,collect(DISTINCT up) AS upstream,collect(DISTINCT down) AS downstream",
          causal: "MATCH (e:Event)-[:TRIGGERS]->(t:TaskItem {id:$id}) OPTIONAL MATCH (e)-[:PRODUCED_BY]->(src) RETURN e,src,t",
        }),
      });

      await this.upsertSchema({
        entity: 'Resource',
        version: '1.0.0',
        description: 'A shared system resource that tasks compete for -- used for concurrency control and contention modeling in the task queue.',
        storagePattern: 'graph',
        id_pattern: 'slug string (e.g. res-omnigraph-db, res-email-service)',
        instructions: 'MERGE on id. Properties: name, capacity (integer), status (available|degraded|offline). Locked by running tasks via LOCKED_BY. Requested by queued tasks via REQUIRES (inbound from TaskItem).',
        relationships: '{"LOCKED_BY":"TaskItem","REQUIRES":"TaskItem (inbound)"}',
        crud_examples: JSON.stringify({
          contention: "MATCH (res:Resource) OPTIONAL MATCH (res)-[:LOCKED_BY]->(holder:TaskItem) RETURN res.id,res.name,res.capacity,res.status,holder.id AS locked_by",
          waiters: "MATCH (w:TaskItem {status:'queued'})-[:REQUIRES]->(res:Resource)-[:LOCKED_BY]->(h:TaskItem {status:'running'}) RETURN res.id AS resource,h.id AS held_by,collect(w.id) AS waiting",
        }),
      });

      const patchSchemaRels = async (entity, newRels) => {
        const schema = await this.getSchema(entity);
        if (!schema) return;
        let rels = {};
        try { rels = JSON.parse(schema.relationships || '{}'); } catch (_) {}
        let patched = false;
        for (const [key, val] of Object.entries(newRels)) {
          if (!rels[key]) { rels[key] = val; patched = true; }
        }
        if (patched) {
          const now = Date.now();
          await this.executeQuery(`
            MATCH (s:Schema {entity: '${escapeCypher(entity)}'})
            SET s.relationships = '${escapeCypher(JSON.stringify(rels))}',
                s.updated_by_app_name = '${APP_IDENTITY.name}',
                s.updated_by_app_id = '${APP_IDENTITY.id}',
                s.updated_by_user = '${escapeCypher(this.currentUser)}',
                s.updated_at = ${now}
            RETURN s
          `);
          console.log(`[OmniGraph] Patched ${entity} schema with new relationships`);
        }
      };

      await patchSchemaRels('Person', { MEMBER: 'Team (inbound)', ENABLED: 'IDW,Tool,Agent' });
      await patchSchemaRels('IDW', { ENABLED: 'Person (inbound)', CONTAINS: 'Library (inbound)' });
      await patchSchemaRels('Event', { TRIGGERS: 'TaskItem' });

      this._librarySchemaEnsured = true;
      console.log('[OmniGraph] Library schema ensured (Organization, Team, Library, Tool, Agent, TaskQueue, TaskItem, Resource)');
    } catch (error) {
      console.error('[OmniGraph] Failed to ensure Library schema:', error.message);
      this._librarySchemaError = error.message;
    }
  }

  // ============================================
  // UTILITY METHODS
  // ============================================

  /**
   * Test connection to Neo4j via the Cypher Proxy
   * @returns {Promise<boolean>} Whether connection succeeded
   */
  async testConnection() {
    try {
      const result = await this.executeQuery('MATCH (n) RETURN count(n) as count LIMIT 1');
      console.log('[OmniGraph] Connection test successful, node count:', result?.[0]?.count || 0);
      return true;
    } catch (error) {
      console.error('[OmniGraph] Connection test failed:', error.message);
      return false;
    }
  }

  /**
   * Get statistics about the graph
   * @returns {Promise<Object>} Graph statistics
   */
  async getStats() {
    const spacesCypher = `MATCH (s:Space) WHERE s.active = true OR s.active IS NULL RETURN count(s) as count`;
    const assetsCypher = `MATCH (a:Asset) WHERE a.active = true OR a.active IS NULL RETURN count(a) as count`;

    const [spacesResult, assetsResult] = await Promise.all([
      this.executeQuery(spacesCypher).catch(() => [{ count: 0 }]),
      this.executeQuery(assetsCypher).catch(() => [{ count: 0 }]),
    ]);

    return {
      spaces: spacesResult?.[0]?.count || 0,
      assets: assetsResult?.[0]?.count || 0,
    };
  }

  // ============================================
  // CAPTURE SESSION SIGNALING (P2P Recording)
  // ============================================

  /**
   * Create a CaptureSession node for WebRTC signaling.
   * SDP offers are large (~9KB), so we split into 1500-char chunks
   * stored as sdpOffer0, sdpOffer1, ... sdpOfferN plus sdpOfferChunks count.
   * @param {string} code - Memorable session code word
   * @param {string} sdpOffer - JSON-stringified SDP offer
   * @returns {Promise<void>}
   */
  async createCaptureSession(code, sdpOffer) {
    const now = Date.now();
    const CHUNK = 1400; // safe under OmniGraph query size limit

    // 1. Create node with metadata (no offer yet)
    await this.executeQuery(`
      CREATE (s:CaptureSession {
        code: '${escapeCypher(code)}',
        sdpAnswer: '',
        status: 'waiting',
        createdAt: ${now},
        sdpOfferChunks: ${Math.ceil(sdpOffer.length / CHUNK)}
      })
      RETURN s.code
    `);

    // 2. SET each chunk in a separate query
    for (let i = 0; i * CHUNK < sdpOffer.length; i++) {
      const chunk = sdpOffer.slice(i * CHUNK, (i + 1) * CHUNK);
      await this.executeQuery(`
        MATCH (s:CaptureSession {code: '${escapeCypher(code)}'})
        SET s.sdpOffer${i} = '${escapeCypher(chunk)}'
        RETURN s.code
      `);
    }
  }

  /**
   * Retrieve a CaptureSession by code word.
   * @param {string} code - Session code word
   * @returns {Promise<Object|null>} Session data or null
   */
  async getCaptureSession(code) {
    const cypher = `
      MATCH (s:CaptureSession {code: '${escapeCypher(code)}'})
      WHERE s.status = 'waiting'
      RETURN s
    `;
    const result = await this.executeQuery(cypher);
    if (!result || result.length === 0) return null;

    const node = result[0].s?.properties || result[0].s || result[0];
    const chunks = parseInt(node.sdpOfferChunks) || 0;

    // Reassemble chunked SDP offer
    let sdpOffer = '';
    if (chunks > 0) {
      for (let i = 0; i < chunks; i++) {
        sdpOffer += node[`sdpOffer${i}`] || '';
      }
    } else {
      sdpOffer = node.sdpOffer || '';
    }

    return { code, sdpOffer, status: node.status, createdAt: node.createdAt };
  }

  /**
   * Set the SDP answer on a CaptureSession (guest posts their answer).
   * @param {string} code - Session code word
   * @param {string} sdpAnswer - JSON-stringified SDP answer
   * @returns {Promise<void>}
   */
  async setCaptureAnswer(code, sdpAnswer) {
    const CHUNK = 1400;

    // Set status + chunk count first
    await this.executeQuery(`
      MATCH (s:CaptureSession {code: '${escapeCypher(code)}'})
      SET s.status = 'answered',
          s.sdpAnswerChunks = ${Math.ceil(sdpAnswer.length / CHUNK)}
      RETURN s.code
    `);

    // Set each answer chunk
    for (let i = 0; i * CHUNK < sdpAnswer.length; i++) {
      const chunk = sdpAnswer.slice(i * CHUNK, (i + 1) * CHUNK);
      await this.executeQuery(`
        MATCH (s:CaptureSession {code: '${escapeCypher(code)}'})
        SET s.sdpAnswer${i} = '${escapeCypher(chunk)}'
        RETURN s.code
      `);
    }
  }

  /**
   * Poll for the SDP answer on a CaptureSession.
   * @param {string} code - Session code word
   * @returns {Promise<string|null>} SDP answer or null if not yet answered
   */
  async getCaptureAnswer(code) {
    const cypher = `
      MATCH (s:CaptureSession {code: '${escapeCypher(code)}', status: 'answered'})
      RETURN s.sdpAnswer AS sdpAnswer
    `;
    const result = await this.executeQuery(cypher);
    if (!result || result.length === 0 || !result[0].sdpAnswer) return null;
    return result[0].sdpAnswer;
  }

  /**
   * Delete a CaptureSession node (cleanup after connection or timeout).
   * @param {string} code - Session code word
   * @returns {Promise<void>}
   */
  async deleteCaptureSession(code) {
    const cypher = `
      MATCH (s:CaptureSession {code: '${escapeCypher(code)}'})
      DELETE s
    `;
    await this.executeQuery(cypher).catch((_ignored) => {
      /* deleteCaptureSession cleanup - node may not exist or DB unavailable */
    });
  }
}

// ============================================
// CONTENT HASH UTILITIES
// ============================================

/**
 * Compute SHA256 hash of file content
 * @param {string} filePath - Path to file
 * @returns {string} Hash string in format 'sha256:xxxx'
 */
function computeContentHash(filePath) {
  const fs = require('fs');
  const content = fs.readFileSync(filePath);
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  return `sha256:${hash.substring(0, 12)}`;
}

/**
 * Compute SHA256 hash from buffer
 * @param {Buffer} buffer - Content buffer
 * @returns {string} Hash string in format 'sha256:xxxx'
 */
function computeContentHashFromBuffer(buffer) {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  return `sha256:${hash.substring(0, 12)}`;
}

/**
 * Compute version number based on existing history
 * @param {Array} history - Array of {version, contentHash} objects
 * @param {string} newHash - New content hash
 * @returns {string} Version string (e.g., 'v1', 'v2')
 */
function computeVersionNumber(history, newHash) {
  // Check if this hash already exists
  const existing = history.find((v) => v.contentHash === newHash);
  if (existing) return existing.version; // Same content = same version

  // New version
  const latestVersion = history.length > 0 ? parseInt(history[history.length - 1].version.replace('v', '')) : 0;
  return `v${latestVersion + 1}`;
}

// Singleton instance
let omnigraphClientInstance = null;

/**
 * Get the OmniGraph client singleton
 * @returns {OmniGraphClient}
 */
function getOmniGraphClient() {
  if (!omnigraphClientInstance) {
    omnigraphClientInstance = new OmniGraphClient();
  }
  return omnigraphClientInstance;
}

module.exports = {
  OmniGraphClient,
  getOmniGraphClient,
  escapeCypher,
  computeContentHash,
  computeContentHashFromBuffer,
  computeVersionNumber,
  // Provenance helpers (Temporal Graph Honor System v2.0.0)
  APP_IDENTITY,
  buildCreateProvenance,
  buildUpdateProvenance,
  buildHistoryEntry,
};
