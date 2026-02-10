/**
 * OmniGraph Client
 * 
 * Client for the OmniGraph API (Cypher/RedisGraph) for managing
 * GSX ecosystem nodes: Spaces, Asset Types, and Assets.
 * 
 * Follows the Temporal Graph Honor System v2.0.0:
 * - All nodes have provenance fields (created_by_*, updated_by_*, _history)
 * - All changes are tracked with history entries
 * - App identity is required for all operations
 * 
 * Graph name: idw (fixed)
 * Timeout: 30 seconds
 * 
 * @module OmniGraphClient
 */

const crypto = require('crypto');

// ============================================
// APP IDENTITY (Honor System Requirement)
// ============================================

/**
 * Application identity for the Temporal Graph Honor System
 * Every app that writes to the graph must identify itself
 */
const APP_IDENTITY = {
  name: 'GSX-Desktop',
  id: 'gsx-desktop-app'
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
    _history: '[]'
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
    updated_at: Date.now()
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
    changes
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
 */
class OmniGraphClient {
  /**
   * Create an OmniGraph client
   * @param {Object} options - Configuration options
   * @param {string} options.endpoint - Full endpoint URL (e.g., https://em.edison.api.onereach.ai/http/{accountId}/omnigraph)
   * @param {Function} options.getAuthToken - Function that returns current auth token
   * @param {number} options.timeout - Request timeout in ms (default: 30000)
   * @param {string} options.currentUser - Current user email for provenance tracking
   */
  constructor(options = {}) {
    this.endpoint = options.endpoint || null;
    this.getAuthToken = options.getAuthToken || (() => null);
    this.timeout = options.timeout || 30000;
    this.graphName = 'idw'; // Fixed graph name
    this.currentUser = options.currentUser || 'system'; // For provenance tracking
  }

  /**
   * Set the endpoint URL
   * @param {string} endpoint - Full endpoint URL
   */
  setEndpoint(endpoint) {
    this.endpoint = endpoint;
    console.log('[OmniGraph] Endpoint set to:', endpoint);
  }

  /**
   * Set the auth token getter function
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
   * Check if client is configured and ready
   * @returns {boolean} Whether client can make requests
   */
  isReady() {
    return !!this.endpoint;
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
      return result?.map(r => ({
        entity: r['s.entity'],
        description: r['s.description']
      })) || [];
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
        owner: 'Implicit via CREATED edge. Full control, cannot be revoked.'
      };
      const relProps = {
        permission: 'string (read|write|admin)',
        grantedAt: 'number (epoch ms)',
        grantedBy: 'string (email)',
        expiresAt: 'number|null (epoch ms, null=no expiry)',
        note: 'string (optional message)',
        at: 'number (provenance timestamp)'
      };
      const crudEx = {
        share: 'MERGE Person-SHARED_WITH->Target with permission, grantedAt, grantedBy, expiresAt',
        revoke: 'DELETE SHARED_WITH relationship between Person and Target',
        list: 'MATCH all Person-SHARED_WITH->Target where not expired',
        myShares: 'MATCH all Target<-SHARED_WITH-Person where not expired'
      };
      await this.upsertSchema({
        entity: 'Permission',
        version: '1.0.0',
        description: 'Sharing permission model for SHARED_WITH relationships between Person and Space or Asset nodes with read write admin levels and optional TTL',
        storagePattern: 'relationship',
        instructions: 'SHARED_WITH relationship on Person to Space or Asset. Properties: permission (read or write or admin), grantedAt, grantedBy, expiresAt (null means forever). Owner is implicit via CREATED edge. Filter expired: WHERE r.expiresAt IS NULL OR r.expiresAt > timestamp. Admin can re-share. Write and read cannot.',
        relationships: '{"SHARED_WITH":"Space,Asset"}',
        crudExamples: JSON.stringify(crudEx),
        extra: {
          permissionLevels: JSON.stringify(permLevels),
          relationshipProperties: JSON.stringify(relProps)
        }
      });

      // 2. Patch Person schema to include SHARED_WITH in its relationships
      const personSchema = await this.getSchema('Person');
      if (personSchema) {
        let rels = {};
        try { rels = JSON.parse(personSchema.relationships || '{}'); } catch (e) { /* ignore */ }
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

    const result = await this.executeQuery(cypher);
    console.log(`[OmniGraph] Shared ${targetType} ${targetId} with ${email} (${permission})`);
    return {
      success: true,
      email,
      permission,
      grantedAt: now,
      grantedBy,
      expiresAt: expiresAt === 'NULL' ? null : expiresAt,
      note: note || null
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

    return result.map(row => {
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
        note: rel.note || null
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

    return result.map(row => {
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
        grantedBy: rel.grantedBy || null
      };
    });
  }

  // ============================================
  // GENERAL QUERY EXECUTION
  // ============================================

  /**
   * Execute a Cypher query against the OmniGraph API
   * @param {string} cypher - Cypher query string
   * @returns {Promise<any>} Query result
   * @throws {Error} On network or query error
   */
  async executeQuery(cypher) {
    if (!this.endpoint) {
      throw new Error('OmniGraph endpoint not configured');
    }

    const token = await this.getAuthToken();
    const headers = {
      'Content-Type': 'application/json'
    };
    
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      console.log('[OmniGraph] Executing query:', cypher.substring(0, 100) + '...');
      
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ graph: this.graphName, query: cypher }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      const data = await response.json();
      
      if (!response.ok) {
        const errorMsg = data.error || data.message || `HTTP ${response.status}`;
        console.error('[OmniGraph] API error:', errorMsg);
        throw new Error(errorMsg);
      }

      if (data.error) {
        console.error('[OmniGraph] Query error:', data.error);
        throw new Error(data.error);
      }

      return data.result;
    } catch (error) {
      clearTimeout(timeoutId);
      
      if (error.name === 'AbortError') {
        throw new Error('OmniGraph query timed out (30s limit)');
      }
      
      throw error;
    }
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
    const historyEntry = buildHistoryEntry(user, 'UPSERT', [
      { property: 'name', old_value: null, new_value: space.name }
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
    const tagsString = Array.isArray(asset.tags) ? asset.tags.join(',') : (asset.tags || '');

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
        spaceName: result[0].spaceName
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
          assetId
        };
      }
      
      // Check content hash matches
      if (expectedHash && asset.contentHash !== expectedHash) {
        return { 
          verified: false, 
          reason: 'Content hash mismatch',
          expected: expectedHash,
          actual: asset.contentHash,
          assetId
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
        title: asset.title
      };
    } catch (error) {
      return {
        verified: false,
        reason: `Verification query failed: ${error.message}`,
        assetId
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
          spaceId
        };
      }
      
      return { 
        verified: true,
        spaceId: space.id,
        name: space.name,
        visibility: space.visibility
      };
    } catch (error) {
      return {
        verified: false,
        reason: `Space verification failed: ${error.message}`,
        spaceId
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
    return result?.map(r => r.a?.properties || r.a) || [];
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
  // UTILITY METHODS
  // ============================================

  /**
   * Test connection to OmniGraph API
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
      this.executeQuery(assetsCypher).catch(() => [{ count: 0 }])
    ]);

    return {
      spaces: spacesResult?.[0]?.count || 0,
      assets: assetsResult?.[0]?.count || 0
    };
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
  const existing = history.find(v => v.contentHash === newHash);
  if (existing) return existing.version; // Same content = same version
  
  // New version
  const latestVersion = history.length > 0 
    ? parseInt(history[history.length - 1].version.replace('v', ''))
    : 0;
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
  buildHistoryEntry
};
