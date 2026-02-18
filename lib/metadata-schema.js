/**
 * Metadata Schema - SPACE Framework-Aligned Core Schema
 *
 * Provides extensible metadata schemas for Spaces (containers) and Items (assets)
 * organized around the Contextual SPACE framework:
 *
 *   S - System Insights     : operational state, health, integrations, processing
 *   P - Physical Locations   : geography, storage paths, origin devices
 *   A - Attributes           : descriptive properties, tags, roles, capabilities
 *   C - Communication Context: interaction history, channels, relationships
 *   E - Event & Sequence Data: temporal data, versions, activity, milestones
 *
 * Each SPACE category is a namespace in the metadata object. Core fields are
 * defined per namespace; additional fields can be added without schema changes.
 * The deep-merge update pattern preserves unknown keys, making the schema
 * forward-compatible and extensible by any consumer (agents, tools, plugins).
 *
 * @module metadata-schema
 */

const os = require('os');

// ─────────────────────────────────────────────
// Schema Constants
// ─────────────────────────────────────────────

const SCHEMA_VERSION = '3.0';

const SPACE_CATEGORIES = ['system', 'physical', 'attributes', 'communication', 'events'];

const VALID_SPACE_TYPES = [
  'project', // GSX Create project spaces
  'collection', // Curated content collections
  'workspace', // Working areas
  'archive', // Archived/historical spaces
  'conversation', // AI conversation captures
  'monitor', // Web monitor spaces
  'agent', // Agent-specific spaces
  'general', // Default / unclassified
];

const VALID_ITEM_TYPES = ['text', 'html', 'code', 'image', 'file', 'video', 'audio', 'pdf', 'url', 'data-source'];

const VALID_DATA_SOURCE_TYPES = ['mcp', 'api', 'web-scraping'];

const VALID_SYNC_STATUSES = ['local-only', 'pending', 'synced', 'conflict', 'error'];
const VALID_PROCESSING_STATUSES = ['raw', 'processed', 'enriched', 'error'];
const VALID_VISIBILITY = ['private', 'shared', 'public'];

// ─────────────────────────────────────────────
// Space Schema Factory
// ─────────────────────────────────────────────

/**
 * Create a new Space metadata object with SPACE-framework namespaces.
 * All fields have sensible defaults. Unknown fields passed via `overrides`
 * are preserved in the appropriate namespace or at root level.
 *
 * @param {Object} params - Space creation parameters
 * @param {string} params.id - Unique space identifier
 * @param {string} params.name - Display name
 * @param {string} [params.icon='◯'] - Space icon
 * @param {string} [params.color='#64c8ff'] - Space color
 * @param {Object} [params.overrides={}] - Additional fields merged into the schema
 * @returns {Object} Complete space metadata object
 */
function createSpaceMetadata({ id, name, icon = '◯', color = '#64c8ff', overrides = {} }) {
  const now = new Date().toISOString();
  const author = _getAuthor();

  const metadata = {
    // ── Schema Meta ──
    _schema: {
      version: SCHEMA_VERSION,
      type: 'space',
      storageEngine: 'git',
      extensions: [],
    },

    // ── Identity ──
    id,
    name,
    icon,
    color,

    // ── Temporal ──
    createdAt: now,
    updatedAt: now,

    // ── S: System Insights ──
    // Operational state, health, integrations, storage metrics
    system: {
      health: 'healthy',
      itemCount: 0,
      storageBytes: 0,
      lastSyncAt: null,
      syncStatus: 'local-only',
      integrations: {
        gsx: {
          pushed: false,
          graphId: null,
          lastPushedAt: null,
        },
      },
      errors: [],
    },

    // ── P: Physical Locations ──
    // Where this space lives and originated
    physical: {
      storagePath: null, // populated by storage layer
      originDevice: os.hostname(),
      region: null,
    },

    // ── A: Attributes ──
    // Descriptive properties, classification, ownership
    attributes: {
      author,
      description: null,
      tags: [],
      category: 'general',
      visibility: 'private',
      isSystem: false,
      capabilities: [], // what this space supports (e.g. 'video-editing', 'gsx-project')
    },

    // ── C: Communication Context ──
    // How this space relates to interactions and collaboration
    communication: {
      channels: [], // usage context: 'chat', 'email', 'project', 'research'
      relatedSpaces: [], // linked space IDs
      sharedWith: [], // users/teams with access
      lastInteractionAt: null,
    },

    // ── E: Event & Sequence Data ──
    // Temporal history, milestones (version history tracked by Git)
    events: {
      activityLog: [], // recent activity entries
      milestones: [], // key events with timestamps
    },

    // ── Domain-Specific ──
    projectConfig: {
      setupComplete: false,
      mainFile: null,
      description: null,
      targetUsers: null,
      stylePreference: null,
    },
    files: {},
    assets: {},
    approvals: {},

    // ── Open Extension Slot ──
    // Registered extensions add their data here.
    // e.g. extensions: { "video-editor": { timeline: {} }, "budget": { allocated: 5000 } }
    extensions: {},
  };

  // Merge any overrides, preserving SPACE namespaces
  if (overrides && typeof overrides === 'object') {
    return deepMerge(metadata, overrides);
  }

  return metadata;
}

// ─────────────────────────────────────────────
// Item Schema Factory
// ─────────────────────────────────────────────

/**
 * Create a new Item metadata object with SPACE-framework namespaces.
 * Content-type-specific fields are stored under a typed namespace
 * (e.g. `video: {}`, `image: {}`).
 *
 * @param {Object} params - Item creation parameters
 * @param {string} params.id - Unique item identifier
 * @param {string} params.type - Content type (text, image, file, etc.)
 * @param {string} params.spaceId - Parent space ID
 * @param {Object} [params.overrides={}] - Additional fields merged into the schema
 * @returns {Object} Complete item metadata object
 */
function createItemMetadata({ id, type, spaceId, overrides = {} }) {
  const now = new Date().toISOString();
  const author = _getAuthor();

  const metadata = {
    // ── Schema Meta ──
    _schema: {
      version: SCHEMA_VERSION,
      type: 'item',
      contentType: type,
      storageEngine: 'git',
    },

    // ── Identity ──
    id,
    type,
    spaceId,

    // ── Temporal ──
    dateCreated: now,
    dateModified: now,

    // ── S: System Insights ──
    // Source, processing pipeline, AI enrichment, sync state
    system: {
      source: 'clipboard',
      contentHash: null,
      fileSize: null,
      mimeType: null,
      processingStatus: 'raw',
      aiMetadata: {
        generated: false,
        generatedAt: null,
        model: null,
        spaceContextUsed: false,
      },
      gsxPush: {
        pushed: false,
        pushedAt: null,
        graphId: null,
        status: 'none',
        error: null,
      },
      errors: [],
    },

    // ── P: Physical Locations ──
    // Where this content came from and where it lives
    physical: {
      sourceUrl: null,
      sourceApp: null,
      deviceName: os.hostname(),
      filePath: null,
    },

    // ── A: Attributes ──
    // Descriptive metadata, classification, user annotations
    attributes: {
      title: null,
      description: null,
      author,
      tags: [],
      pinned: false,
      notes: null,
      language: null, // for code/text content
    },

    // ── C: Communication Context ──
    // Conversation/thread context, participants
    communication: {
      conversationId: null,
      threadId: null,
      participants: [],
      channel: null, // 'email', 'chat', 'web', 'api'
    },

    // ── E: Event & Sequence Data ──
    // Temporal ordering, relationships (version history tracked by Git)
    events: {
      capturedAt: now,
      sequence: null, // order within a set/batch
      relatedItems: [], // linked item IDs
      workflowStage: null, // 'draft', 'review', 'approved', 'published'
    },

    // ── Content-Type Extensions ──
    // Populated based on item type; only relevant namespace is included
    ...getContentTypeDefaults(type),

    // ── Legacy compat ──
    scenes: [],

    // ── Open Extension Slot ──
    extensions: {},
  };

  // Merge any overrides, preserving SPACE namespaces
  if (overrides && typeof overrides === 'object') {
    return deepMerge(metadata, overrides);
  }

  return metadata;
}

// ─────────────────────────────────────────────
// Content-Type Defaults
// ─────────────────────────────────────────────

/**
 * Returns default fields for content-type-specific metadata.
 * Only the relevant type namespace is returned.
 *
 * @param {string} type - Content type
 * @returns {Object} Type-specific default fields
 */
function getContentTypeDefaults(type) {
  switch (type) {
    case 'video':
      return {
        video: {
          duration: null,
          resolution: null,
          codec: null,
          frameRate: null,
          hasAudio: null,
          transcription: null,
          chapters: [],
        },
      };

    case 'audio':
      return {
        audio: {
          duration: null,
          sampleRate: null,
          channels: null,
          codec: null,
          transcription: null,
          speakers: [],
        },
      };

    case 'image':
      return {
        image: {
          width: null,
          height: null,
          format: null,
          colorSpace: null,
          hasAlpha: null,
        },
      };

    case 'code':
      return {
        code: {
          language: null,
          lineCount: null,
          framework: null,
          entryPoint: false,
        },
      };

    case 'pdf':
      return {
        pdf: {
          pageCount: null,
          hasOCR: false,
          extractedText: null,
        },
      };

    case 'url':
      return {
        url: {
          href: null,
          domain: null,
          lastCheckedAt: null,
          statusCode: null,
          contentType: null,
        },
      };

    case 'data-source':
      return {
        dataSource: {
          sourceType: null, // 'mcp' | 'api' | 'web-scraping'

          // Connection config
          connection: {
            url: '', // Base URL, MCP server URI, or scrape target
            protocol: '', // 'rest', 'graphql', 'mcp-stdio', 'mcp-sse', 'mcp-http', 'http-scrape'
            method: 'GET', // Default HTTP method
            headers: {}, // Non-sensitive headers (Content-Type, Accept, etc.)
            queryParams: {}, // Default query params
            timeout: 30000, // Request timeout ms
          },

          // Auth reference (label only, no secrets stored)
          auth: {
            type: 'none', // 'none' | 'api-key' | 'bearer' | 'oauth2' | 'basic'
            label: '', // Human-readable label ("My OpenAI Key", "Production Token")
            headerName: '', // Header name for api-key type (e.g., "X-API-Key")
            tokenUrl: '', // For OAuth2 discovery
            scopes: [], // For OAuth2
            notes: '', // How to obtain credentials
          },

          // CRUD operation definitions
          operations: {
            create: { enabled: false, endpoint: '', method: 'POST', bodyTemplate: '' },
            read: { enabled: false, endpoint: '', method: 'GET', params: '' },
            update: { enabled: false, endpoint: '', method: 'PUT', bodyTemplate: '' },
            delete: { enabled: false, endpoint: '', method: 'DELETE' },
            list: { enabled: false, endpoint: '', method: 'GET', paginationType: 'none' },
          },

          // MCP-specific fields
          mcp: {
            serverName: '',
            transport: 'stdio', // 'stdio' | 'sse' | 'streamable-http'
            command: '', // For stdio (e.g., 'npx')
            args: [], // For stdio (e.g., ['-y', '@modelcontextprotocol/server-sqlite'])
            env: {}, // Non-secret env vars
            capabilities: [], // Discovered tool/resource names
          },

          // Web scraping-specific fields
          scraping: {
            selectors: {}, // Named CSS selectors for extraction
            schedule: '', // Cron expression or interval
            pagination: { type: 'none', selector: '', maxPages: 1 },
            rateLimit: { requestsPerMinute: 10 },
            userAgent: '',
          },

          // Description document
          document: {
            content: '', // Markdown description of what this data source is
            visibility: 'private', // 'public' | 'private'
            lastUpdated: null,
          },

          // Operational status
          status: 'inactive', // 'active' | 'inactive' | 'error'
          lastTestedAt: null,
          lastError: null,
        },
      };

    default:
      return {};
  }
}

// ─────────────────────────────────────────────
// SPACE Context Extraction (for AI Agents)
// ─────────────────────────────────────────────

/**
 * Extract a SPACE-formatted context summary from a space's metadata.
 * Returns a structured object suitable for AI agent consumption.
 *
 * @param {Object} metadata - Space metadata (v2.0)
 * @returns {Object} SPACE-categorized context summary
 */
function extractSpaceContext(metadata) {
  if (!metadata) return null;

  return {
    S: {
      label: 'System Insights',
      summary: metadata.system || {},
      _hint: 'Operational state, health, sync status, integrations',
    },
    P: {
      label: 'Physical Locations',
      summary: metadata.physical || {},
      _hint: 'Storage location, origin device, geographic context',
    },
    A: {
      label: 'Attributes',
      summary: metadata.attributes || {},
      _hint: 'Description, tags, category, author, capabilities',
    },
    C: {
      label: 'Communication Context',
      summary: metadata.communication || {},
      _hint: 'Channels, related spaces, collaboration context',
    },
    E: {
      label: 'Event & Sequence Data',
      summary: metadata.events || {},
      _hint: 'Version history, activity log, milestones',
    },
  };
}

/**
 * Extract a SPACE-formatted context summary from an item's metadata.
 * Returns a structured object suitable for AI agent consumption.
 *
 * @param {Object} metadata - Item metadata (v2.0)
 * @returns {Object} SPACE-categorized context summary
 */
function extractItemContext(metadata) {
  if (!metadata) return null;

  return {
    S: {
      label: 'System Insights',
      summary: metadata.system || {},
      _hint: 'Source, processing status, AI enrichment, sync state',
    },
    P: {
      label: 'Physical Locations',
      summary: metadata.physical || {},
      _hint: 'Source URL/app, device, local file path',
    },
    A: {
      label: 'Attributes',
      summary: metadata.attributes || {},
      _hint: 'Title, description, tags, author, notes',
    },
    C: {
      label: 'Communication Context',
      summary: metadata.communication || {},
      _hint: 'Conversation, thread, participants, channel',
    },
    E: {
      label: 'Event & Sequence Data',
      summary: metadata.events || {},
      _hint: 'Capture time, sequence, related items, workflow stage',
    },
  };
}

// ─────────────────────────────────────────────
// Extension Registration
// ─────────────────────────────────────────────

/**
 * Register an extension on a metadata object.
 * Extensions add domain-specific data under the `extensions` namespace.
 *
 * @param {Object} metadata - Space or Item metadata object
 * @param {string} extensionName - Unique extension identifier (e.g. 'video-editor', 'budget')
 * @param {Object} extensionData - Extension-specific data
 * @returns {Object} Updated metadata with extension registered
 */
function registerExtension(metadata, extensionName, extensionData = {}) {
  if (!metadata || !extensionName) return metadata;

  // Register in schema extensions list
  if (metadata._schema && !metadata._schema.extensions.includes(extensionName)) {
    metadata._schema.extensions.push(extensionName);
  }

  // Store extension data
  if (!metadata.extensions) metadata.extensions = {};
  metadata.extensions[extensionName] = deepMerge(metadata.extensions[extensionName] || {}, extensionData);

  return metadata;
}

/**
 * Retrieve extension data from a metadata object.
 *
 * @param {Object} metadata - Space or Item metadata object
 * @param {string} extensionName - Extension identifier
 * @returns {Object|null} Extension data or null if not registered
 */
function getExtension(metadata, extensionName) {
  if (!metadata || !metadata.extensions) return null;
  return metadata.extensions[extensionName] || null;
}

// ─────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────

/**
 * Validate that a metadata object conforms to the core schema.
 * Returns an array of error strings (empty = valid).
 *
 * @param {Object} metadata - Metadata object to validate
 * @returns {string[]} Array of validation error messages
 */
function validate(metadata) {
  const errors = [];

  if (!metadata) {
    errors.push('Metadata is null or undefined');
    return errors;
  }

  // Schema meta
  if (!metadata._schema) {
    errors.push('Missing _schema field');
  } else {
    if (!metadata._schema.version) errors.push('Missing _schema.version');
    if (!metadata._schema.type) errors.push('Missing _schema.type');
    if (!['space', 'item'].includes(metadata._schema.type)) {
      errors.push(`Invalid _schema.type: ${metadata._schema.type}`);
    }
  }

  // Identity
  if (!metadata.id) errors.push('Missing id');

  // SPACE namespaces (warn if missing, don't error — allow partial metadata)
  for (const ns of SPACE_CATEGORIES) {
    if (!metadata[ns]) {
      errors.push(`Missing SPACE namespace: ${ns} (will use defaults)`);
    }
  }

  // Type-specific validation
  if (metadata._schema && metadata._schema.type === 'space') {
    if (!metadata.name) errors.push('Space missing name');
  }

  if (metadata._schema && metadata._schema.type === 'item') {
    if (!metadata.type) errors.push('Item missing type');
    if (!metadata.spaceId) errors.push('Item missing spaceId');
  }

  return errors;
}

// ─────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────

/**
 * Deep merge two objects. Arrays are replaced (not concatenated).
 * Null values in source overwrite target values.
 *
 * @param {Object} target - Base object
 * @param {Object} source - Object to merge in
 * @returns {Object} Merged result (new object, inputs not mutated)
 */
function deepMerge(target, source) {
  const result = { ...target };

  for (const key in source) {
    if (source[key] !== undefined) {
      if (
        source[key] &&
        typeof source[key] === 'object' &&
        !Array.isArray(source[key]) &&
        typeof result[key] === 'object' &&
        result[key] !== null &&
        !Array.isArray(result[key])
      ) {
        result[key] = deepMerge(result[key], source[key]);
      } else {
        result[key] = source[key];
      }
    }
  }

  return result;
}

/**
 * Get the current system author name.
 * @returns {string}
 */
function _getAuthor() {
  try {
    return os.userInfo().username || 'Unknown';
  } catch {
    return 'Unknown';
  }
}

// ─────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────

module.exports = {
  // Constants
  SCHEMA_VERSION,
  SPACE_CATEGORIES,
  VALID_SPACE_TYPES,
  VALID_ITEM_TYPES,
  VALID_DATA_SOURCE_TYPES,
  VALID_SYNC_STATUSES,
  VALID_PROCESSING_STATUSES,
  VALID_VISIBILITY,

  // Factory functions
  createSpaceMetadata,
  createItemMetadata,
  getContentTypeDefaults,

  // SPACE context extraction (for AI agents)
  extractSpaceContext,
  extractItemContext,

  // Extension management
  registerExtension,
  getExtension,

  // Validation
  validate,

  // Utilities
  deepMerge,
};
