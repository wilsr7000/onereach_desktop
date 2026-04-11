/**
 * Neo4j Full Schema Migration — OmniGraph → Neo4j Native
 *
 * Reads all 42 Schema nodes exported from OmniGraph and:
 * 1. Creates uniqueness constraints (camelCase naming)
 * 2. Creates range indexes for common query patterns
 * 3. Creates Schema nodes with normalized camelCase properties
 *
 * Neo4j best practices applied:
 * - Constraint names: <label>_<field>_unique (camelCase label, camelCase field)
 * - Index names: <label>_<field>_idx
 * - All property names normalized to camelCase
 * - Node labels in PascalCase (as-is from OmniGraph)
 * - Relationship types in UPPER_SNAKE_CASE (as-is from OmniGraph)
 *
 * Run: node scripts/neo4j-schema-migration.js
 */

const neo4j = require('neo4j-driver');
const fs = require('fs');
const path = require('path');

// ============================================
// CONNECTION
// ============================================
const NEO4J_URI = 'neo4j+s://40c812ef.databases.neo4j.io';
const NEO4J_USER = 'neo4j';
const NEO4J_PASSWORD = 'oCLF5bxkj66qivVDh1biePK7Byo9U1NUvFLJrHnQjzo';

// ============================================
// LOAD OMNIGRAPH EXPORT
// ============================================
const EXPORT_PATH = path.join(__dirname, 'omnigraph-schemas-export.json');
const omniSchemas = JSON.parse(fs.readFileSync(EXPORT_PATH, 'utf8'));
console.log(`Loaded ${omniSchemas.length} Schema nodes from OmniGraph export\n`);

// ============================================
// camelCase NORMALIZER
// ============================================
// OmniGraph has inconsistent naming: storage_pattern, __createdAt, created_by_app_name, etc.
// Normalize everything to camelCase for Neo4j best practices.

function toCamelCase(str) {
  // Handle __prefixed fields
  str = str.replace(/^_+/, '');
  // Handle snake_case
  return str.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

// Map of OmniGraph field names → normalized camelCase Neo4j property names
const FIELD_MAP = {
  // Already camelCase — keep as-is
  'entity': 'entity',
  'version': 'version',
  'description': 'description',
  'storagePattern': 'storagePattern',
  'instructions': 'instructions',
  'crudExamples': 'crudExamples',
  'relationships': 'relationships',

  // snake_case → camelCase
  'storage_pattern': 'storagePattern',
  'id_pattern': 'idPattern',
  'access_doc': 'accessDoc',
  'synced_at': 'syncedAt',
  'same_as': 'sameAs',
  'crud_examples': 'crudExamples',
  'spec_url': 'specUrl',
  'node_label': 'nodeLabel',
  'creation_sources': 'creationSources',
  'storage_details': 'storageDetails',
  'framework_pillars': 'frameworkPillars',
  'required_properties': 'requiredProperties',
  'optional_properties': 'optionalProperties',

  // Provenance fields → camelCase
  'created_by_app_name': 'createdByAppName',
  'created_by_app_id': 'createdByAppId',
  'created_by_user': 'createdByUser',
  'created_at': 'createdAt',
  'updated_by_app_name': 'updatedByAppName',
  'updated_by_app_id': 'updatedByAppId',
  'updated_by_user': 'updatedByUser',
  'updated_at': 'updatedAt',
  '_history': 'history',

  // Double-underscore prefixed
  '__createdAt': 'createdAt',

  // Permission-specific
  'permissionLevels': 'permissionLevels',
  'relationshipProperties': 'relationshipProperties',

  // Other fields
  'source': 'source',
  'roles': 'roles',
  'name': 'name',
  'label': 'label',
  'definition': 'definition',
  'properties': 'properties',
  'statuses': 'statuses',
  'stages': 'stages',
  'dataSources': 'dataSources',
  'jsonSchema': 'jsonSchema',
};

function normalizeFieldName(field) {
  if (FIELD_MAP[field]) return FIELD_MAP[field];
  // Fallback: convert to camelCase
  return toCamelCase(field);
}

function normalizeSchema(raw) {
  const normalized = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined) continue;
    const newKey = normalizeFieldName(key);
    // If two source fields map to the same camelCase key, prefer non-empty
    if (normalized[newKey] !== undefined && normalized[newKey] !== '') continue;
    normalized[newKey] = value;
  }
  // Ensure storagePattern exists (some use storage_pattern only)
  if (!normalized.storagePattern && raw.storage_pattern) {
    normalized.storagePattern = raw.storage_pattern;
  }
  return normalized;
}

// ============================================
// PRIMARY KEYS
// ============================================
const PRIMARY_KEY_MAP = {
  Schema: 'entity',
  Commit: 'hash',
  CaptureSession: 'code',
};

function getPrimaryKey(entity) {
  return PRIMARY_KEY_MAP[entity] || 'id';
}

const TYPE_HUB_LABELS = ['VideoType', 'ImageType', 'TextType', 'CodeType', 'FileType'];

// ============================================
// INDEXES — per-entity
// ============================================
const ENTITY_INDEXES = {
  Space: ['createdByUser', 'active', 'status', 'updatedAt'],
  Asset: ['active', 'status', 'spaceId', 'contentHash', 'assetType', 'updatedAt'],
  Person: ['email', 'createdAt'],
  IDW: ['active', 'category', 'featured'],
  Agent: ['active', 'builtin'],
  Tool: ['active'],
  Organization: ['active'],
  Team: ['active'],
  Library: ['active'],
  Commit: ['timestamp', 'spaceId'],
  CaptureSession: ['status'],
  TaskItem: ['status', 'priority'],
  TaskQueue: ['status'],
  Resource: ['status'],
  Ticket: ['status', 'createdAt'],
  Playbook: ['status', 'createdAt'],
  Violation: ['severity', 'rule'],
  HealthCheck: ['runAt'],
  Account: ['active'],
  Tag: ['name'],
  Flow: ['active'],
  Note: ['createdAt'],
};

const COMPOSITE_INDEXES = [
  { label: 'Asset', fields: ['spaceId', 'active'], name: 'asset_spaceId_active_idx' },
  { label: 'Violation', fields: ['severity', 'rule'], name: 'violation_severity_rule_idx' },
];

// ============================================
// MAIN
// ============================================
async function migrate() {
  console.log('╔═══════════════════════════════════════════════════╗');
  console.log('║  Neo4j Schema Migration — 42 entities (camelCase) ║');
  console.log('╚═══════════════════════════════════════════════════╝\n');

  const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));

  try {
    const serverInfo = await driver.getServerInfo();
    console.log(`Connected: ${serverInfo.address}\n`);

    // ─── Step 1: Clean ───
    console.log('--- Step 1: Clean existing Schema nodes & constraints/indexes ---');
    const { records: delResult } = await driver.executeQuery('MATCH (s:Schema) DETACH DELETE s RETURN count(s) AS deleted');
    console.log(`  Removed ${delResult[0].get('deleted').toNumber()} Schema nodes`);

    // Drop old snake_case constraints/indexes that will be replaced
    const { records: oldConstraints } = await driver.executeQuery('SHOW CONSTRAINTS YIELD name RETURN name');
    for (const r of oldConstraints) {
      const name = r.get('name');
      try {
        await driver.executeQuery(`DROP CONSTRAINT ${name} IF EXISTS`);
      } catch (_) { /* ignore */ }
    }
    console.log(`  Dropped ${oldConstraints.length} old constraints`);

    const { records: oldIndexes } = await driver.executeQuery('SHOW INDEXES YIELD name, type WHERE type <> "LOOKUP" RETURN name');
    for (const r of oldIndexes) {
      const name = r.get('name');
      try {
        await driver.executeQuery(`DROP INDEX ${name} IF EXISTS`);
      } catch (_) { /* ignore */ }
    }
    console.log(`  Dropped ${oldIndexes.length} old indexes\n`);

    // ─── Step 2: Constraints (Neo4j naming: label_field_unique) ───
    console.log('--- Step 2: Uniqueness constraints ---');
    const allEntities = omniSchemas.map(s => s.entity);
    const allLabels = [...new Set([...allEntities, ...TYPE_HUB_LABELS])];

    let cOk = 0;
    for (const label of allLabels) {
      const pk = getPrimaryKey(label);
      // Neo4j best practice: constraint name = label_field_unique
      const name = `${label}_${pk}_unique`;
      const cypher = `CREATE CONSTRAINT ${name} IF NOT EXISTS FOR (n:${label}) REQUIRE n.${pk} IS UNIQUE`;
      try {
        await driver.executeQuery(cypher);
        cOk++;
        console.log(`  ✓ ${name}`);
      } catch (err) {
        console.error(`  ✗ ${name}: ${err.message.substring(0, 80)}`);
      }
    }
    console.log(`  → ${cOk} constraints created\n`);

    // ─── Step 3: Indexes (Neo4j naming: Label_field_idx) ───
    console.log('--- Step 3: Performance indexes ---');
    let iOk = 0;

    for (const [label, fields] of Object.entries(ENTITY_INDEXES)) {
      for (const field of fields) {
        const name = `${label}_${field}_idx`;
        const cypher = `CREATE INDEX ${name} IF NOT EXISTS FOR (n:${label}) ON (n.${field})`;
        try {
          await driver.executeQuery(cypher);
          iOk++;
          console.log(`  ✓ ${name}`);
        } catch (err) {
          if (err.message.includes('already exists') || err.message.includes('equivalent')) {
            console.log(`  ○ ${name} (exists)`);
          } else {
            console.error(`  ✗ ${name}: ${err.message.substring(0, 80)}`);
          }
        }
      }
    }

    for (const ci of COMPOSITE_INDEXES) {
      const fieldList = ci.fields.map(f => `n.${f}`).join(', ');
      const cypher = `CREATE INDEX ${ci.name} IF NOT EXISTS FOR (n:${ci.label}) ON (${fieldList})`;
      try {
        await driver.executeQuery(cypher);
        iOk++;
        console.log(`  ✓ ${ci.name}`);
      } catch (err) {
        console.error(`  ✗ ${ci.name}: ${err.message.substring(0, 80)}`);
      }
    }
    console.log(`  → ${iOk} indexes created\n`);

    // ─── Step 4: Schema nodes (normalized camelCase) ───
    console.log('--- Step 4: Schema nodes (42, camelCase normalized) ---');
    const now = Date.now();

    for (const raw of omniSchemas) {
      const schema = normalizeSchema(raw);

      // Build parameterized SET clauses
      const params = {};
      const setClauses = [];

      for (const [key, value] of Object.entries(schema)) {
        if (value === null || value === undefined) continue;
        // Sanitize param name (remove dots, etc.)
        const paramName = key.replace(/[^a-zA-Z0-9]/g, '');
        params[paramName] = value;
        setClauses.push(`s.\`${key}\` = $${paramName}`);
      }

      // Migration metadata
      params['migratedFrom'] = 'omnigraph';
      params['migratedAt'] = now;
      setClauses.push('s.migratedFrom = $migratedFrom');
      setClauses.push('s.migratedAt = $migratedAt');

      const cypher = `
        CREATE (s:Schema {entity: $entity})
        SET ${setClauses.join(',\n            ')}
        RETURN s.entity AS entity
      `;

      try {
        await driver.executeQuery(cypher, params);
        console.log(`  ✓ ${schema.entity}`);
      } catch (err) {
        console.error(`  ✗ ${schema.entity}: ${err.message.substring(0, 120)}`);
      }
    }

    // ─── Verification ───
    console.log('\n╔═══════════════════════════════════════════════════╗');
    console.log('║              Verification                         ║');
    console.log('╚═══════════════════════════════════════════════════╝');

    const { records: schemaCount } = await driver.executeQuery('MATCH (s:Schema) RETURN count(s) AS count');
    console.log(`\n  Schema nodes: ${schemaCount[0].get('count').toNumber()}`);

    const { records: constCount } = await driver.executeQuery('SHOW CONSTRAINTS YIELD * RETURN count(*) AS count');
    console.log(`  Constraints: ${constCount[0].get('count').toNumber()}`);

    const { records: idxCount } = await driver.executeQuery('SHOW INDEXES YIELD * WHERE type <> "LOOKUP" RETURN count(*) AS count');
    console.log(`  Indexes: ${idxCount[0].get('count').toNumber()} (non-lookup)`);

    // Verify camelCase on a sample node
    console.log('\n  camelCase verification (Person schema):');
    const { records: personCheck } = await driver.executeQuery(
      'MATCH (s:Schema {entity: "Person"}) RETURN keys(s) AS props'
    );
    if (personCheck.length) {
      const props = personCheck[0].get('props');
      console.log(`    Properties: ${props.sort().join(', ')}`);
      const hasSnakeCase = props.filter(p => p.includes('_') && !p.startsWith('_'));
      if (hasSnakeCase.length === 0) {
        console.log('    ✓ No snake_case properties found');
      } else {
        console.log(`    ⚠ snake_case found: ${hasSnakeCase.join(', ')}`);
      }
    }

    // Entity list
    const { records: schemaList } = await driver.executeQuery('MATCH (s:Schema) RETURN s.entity AS e ORDER BY e');
    console.log(`\n  All ${schemaList.length} entities:`);
    const entities = schemaList.map(r => r.get('e'));
    for (let i = 0; i < entities.length; i += 4) {
      console.log(`    ${entities.slice(i, i + 4).map(e => e.padEnd(20)).join('')}`);
    }

    console.log('\n✅ Full schema migration complete!');

  } catch (err) {
    console.error('\n❌ Migration failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    await driver.close();
  }
}

migrate();
