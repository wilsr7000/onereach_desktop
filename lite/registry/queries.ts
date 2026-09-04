/**
 * Agent Registry — the Cypher surface (ADR-086).
 *
 * Reads are the account-wide directory (the same stance as
 * AGENT_LIBRARY_SEARCH: agent names/descriptions in the catalog are
 * platform inventory, not Space content) and always carry `$viewerId`.
 * Writes: an ADMIN (Person.role admin/owner, case-insensitive) or the
 * agent's own creator, and every write stamps the `_Manifest`
 * provenance fields. The Playbooks writer keeps its own fields; Lite
 * namespaces its additions (`lite_listing*`).
 */

export const REGISTRY_APP_ID = 'onereach-lite';
export const REGISTRY_APP_NAME = 'Onereach.ai Lite';

export const REGISTRY_ADMIN = `EXISTS {
      MATCH (adm:Person {id: $viewerId})
      WHERE toLower(coalesce(adm.role, '')) IN ['admin', 'owner']
    }`;

/** Admin, or the creator of the agent bound as `a`. */
export const REGISTRY_CAN_WRITE = `(
      $viewerId <> '' AND (
        ${REGISTRY_ADMIN}
        OR coalesce(a.created_by_user, '') = $viewerId
      )
    )`;

/** `_Manifest`: every write carries provenance. */
export const PROVENANCE = (alias: string): string => `${alias}.updated_by_app_id = '${REGISTRY_APP_ID}',
        ${alias}.updated_by_app_name = '${REGISTRY_APP_NAME}',
        ${alias}.updated_by_user = $viewerId,
        ${alias}.updatedAt = $nowMs,
        ${alias}.updated_at = toString($nowMs)`;

const SEARCH_WHERE = `
      WHERE ($includeDeleted OR coalesce(a.deleted, false) = false)
        AND ($q = ''
             OR toLower(coalesce(a.name, '')) CONTAINS $q
             OR toLower(coalesce(a.description, '')) CONTAINS $q
             OR toLower(coalesce(a.keywords, '')) CONTAINS $q
             OR toLower(coalesce(a.category, a.menuCategory, '')) CONTAINS $q
             OR toLower(coalesce(a.id, '')) CONTAINS $q)
        AND ($source = '' OR coalesce(a.created_by_app_name, '') = $source)
        AND ($type = '' OR coalesce(a.agentType, a.type, '') = $type)
        AND ($category = '' OR coalesce(a.category, a.menuCategory, '') = $category)
        AND ($state = ''
             OR ($state = 'enabled' AND coalesce(a.enabled, a.active, true) = true)
             OR ($state = 'disabled' AND coalesce(a.enabled, a.active, true) = false))
        AND ($listing = '' OR coalesce(a.lite_listing, 'unlisted') = $listing)
        AND ($reach = ''
             OR EXISTS { MATCH (a)-[:REACHABLE_VIA]->(re:AgentEndpoint) WHERE re.kind = $reach }
             OR ($reach = 'api' AND a.gsxEndpoint IS NOT NULL))
        AND ($idwId = '' OR EXISTS { MATCH (a)-[:APPLIES_TO_IDW]->(:IDW {id: $idwId}) })
        AND ($knowledgeId = '' OR EXISTS { MATCH (a)-[:USES_KNOWLEDGE]->(:KnowledgeModel {id: $knowledgeId}) })`;

const SUMMARY_RETURN = `
      RETURN a.id AS id,
             coalesce(a.name, a.id) AS name,
             left(coalesce(a.description, ''), 240) AS description,
             coalesce(a.agentType, a.type, '') AS type,
             coalesce(a.category, a.menuCategory, '') AS category,
             coalesce(a.enabled, a.active, true) AS enabled,
             coalesce(a.deleted, false) AS deleted,
             coalesce(a.created_by_app_name, '') AS source,
             coalesce(a.created_by_user, '') AS owner,
             coalesce(toInteger(toString(coalesce(a.updatedAt, a.updated_at, a.created_at, 0))), 0) AS updatedMs,
             coalesce(a.lite_listing, 'unlisted') AS listing,
             coalesce(a.builtin, false) AS builtin,
             coalesce(a.isSystem, false) AS isSystem,
             [(a)-[:REACHABLE_VIA]->(e:AgentEndpoint) | e.kind] AS reach,
             size([(a)-[:APPLIES_TO_IDW]->(:IDW) | 1]) AS idwCount,
             size([(a)-[:USES_KNOWLEDGE]->(:KnowledgeModel) | 1]) AS knowledgeCount`;

export const REGISTRY_CYPHER = {
  WHO_AM_I: `
    OPTIONAL MATCH (me:Person {id: $viewerId})
    WITH me
    OPTIONAL MATCH (adm:Person) WHERE toLower(coalesce(adm.role, '')) IN ['admin', 'owner']
    RETURN me IS NOT NULL AS known,
           toLower(coalesce(me.role, '')) IN ['admin', 'owner'] AS isAdmin,
           collect(DISTINCT adm.id) AS admins
  `,
  /** First-admin bootstrap: only while the graph has NO admin at all. */
  CLAIM_FIRST_ADMIN: `
    MATCH (p:Person {id: $viewerId})
    WHERE $viewerId <> ''
      AND NOT EXISTS { MATCH (q:Person) WHERE toLower(coalesce(q.role, '')) IN ['admin', 'owner'] }
    SET p.role = 'ADMIN',
        p.lite_admin_since = $nowMs,
        ${PROVENANCE('p')}
    RETURN p.id AS id
  `,
  SET_ADMIN: `
    MATCH (p:Person {id: $personId})
    WHERE ${REGISTRY_ADMIN} AND $personId <> $viewerId
    SET p.role = CASE WHEN $isAdmin THEN 'ADMIN' ELSE 'USER' END,
        ${PROVENANCE('p')}
    RETURN p.id AS id, p.role AS role
  `,
  SEARCH: `
    MATCH (a:Agent)${SEARCH_WHERE}
    WITH a
    ORDER BY coalesce(toInteger(toString(coalesce(a.updatedAt, a.updated_at, a.created_at, 0))), 0) DESC
    SKIP toInteger($offset) LIMIT toInteger($limit)
    ${SUMMARY_RETURN}
  `,
  SEARCH_COUNT: `
    MATCH (a:Agent)${SEARCH_WHERE}
    RETURN count(a) AS total
  `,
  FACETS: `
    MATCH (a:Agent)
      WHERE ($includeDeleted OR coalesce(a.deleted, false) = false)
        AND ($q = ''
             OR toLower(coalesce(a.name, '')) CONTAINS $q
             OR toLower(coalesce(a.description, '')) CONTAINS $q)
    WITH coalesce(a.created_by_app_name, '') AS source,
         coalesce(a.agentType, a.type, '') AS type,
         coalesce(a.category, a.menuCategory, '') AS category
    RETURN 'source' AS facet, source AS value, count(*) AS n
    UNION ALL
    MATCH (a:Agent)
      WHERE ($includeDeleted OR coalesce(a.deleted, false) = false)
        AND ($q = ''
             OR toLower(coalesce(a.name, '')) CONTAINS $q
             OR toLower(coalesce(a.description, '')) CONTAINS $q)
    WITH coalesce(a.agentType, a.type, '') AS type
    RETURN 'type' AS facet, type AS value, count(*) AS n
    UNION ALL
    MATCH (a:Agent)
      WHERE ($includeDeleted OR coalesce(a.deleted, false) = false)
        AND ($q = ''
             OR toLower(coalesce(a.name, '')) CONTAINS $q
             OR toLower(coalesce(a.description, '')) CONTAINS $q)
    WITH coalesce(a.category, a.menuCategory, '') AS category
    RETURN 'category' AS facet, category AS value, count(*) AS n
  `,
  GET: `
    MATCH (a:Agent {id: $id})
    RETURN a.id AS id,
           coalesce(a.name, a.id) AS name,
           coalesce(a.description, '') AS description,
           coalesce(a.agentType, a.type, '') AS type,
           coalesce(a.category, a.menuCategory, '') AS category,
           coalesce(a.enabled, a.active, true) AS enabled,
           coalesce(a.deleted, false) AS deleted,
           coalesce(a.created_by_app_name, '') AS source,
           coalesce(a.created_by_user, '') AS owner,
           coalesce(toInteger(toString(coalesce(a.updatedAt, a.updated_at, a.created_at, 0))), 0) AS updatedMs,
           coalesce(toInteger(toString(coalesce(a.createdAt, a.created_at, 0))), 0) AS createdMs,
           coalesce(a.lite_listing, 'unlisted') AS listing,
           a.lite_listed_at AS listedAt,
           coalesce(a.lite_listing_checks, '{}') AS manualChecks,
           coalesce(a.builtin, false) AS builtin,
           coalesce(a.isSystem, false) AS isSystem,
           coalesce(a.status, '') AS status,
           coalesce(a.version, '') AS version,
           coalesce(a.keywords, '[]') AS keywords,
           coalesce(a.capabilities, '[]') AS capabilities,
           coalesce(a.executionType, '') AS executionType,
           coalesce(a.gsxEndpoint, '') AS gsxEndpoint,
           [(a)-[:REACHABLE_VIA]->(e:AgentEndpoint) | {id: e.id, kind: e.kind, url: e.url, channels: coalesce(e.channels, '')}] AS endpoints,
           [(a)-[:APPLIES_TO_IDW]->(i:IDW) | {id: i.id, name: coalesce(i.name, i.id), description: coalesce(i.description, ''), status: coalesce(i.status, '')}] AS idws,
           [(a)-[:USES_KNOWLEDGE]->(k:KnowledgeModel) | {id: k.id, name: coalesce(k.name, k.id), description: coalesce(k.description, ''), status: coalesce(k.status, '')}] AS knowledgeModels,
           [(a)-[:HAS_CAPABILITY]->(c:Capability) | {id: c.id, name: coalesce(c.name, c.id), description: coalesce(c.description, ''), status: coalesce(c.status, '')}] AS capabilityNodes,
           [(a)-[:USED_IN]->(s:Space) WHERE s.deletedAt IS NULL | {id: s.id, name: coalesce(s.name, s.id)}] AS usedInSpaces,
           [(rep:Asset)-[:REPRESENTS]->(a) WHERE rep.deletedAt IS NULL | {assetId: rep.id, spaceName: coalesce(head([(rep)-[:BELONGS_TO]->(sp:Space) | sp.name]), '')}] AS representedBy,
           size([(a)-[:CONTRIBUTED_TO]->(:Playbook) | 1]) AS contributedPlaybooks,
           size([(:Person)-[:ENABLED]->(a) | 1]) AS enabledBy,
           coalesce(head([(l:Library)-[:CONTAINS]->(a) | coalesce(l.name, l.id)]), '') AS library
  `,
  LIST_IDWS: `
    MATCH (i:IDW)
    RETURN i.id AS id, coalesce(i.name, i.id) AS name, coalesce(i.description, '') AS description, coalesce(i.status, '') AS status,
           coalesce(i.url, i.homePageURL, '') AS url
    ORDER BY toLower(coalesce(i.name, i.id)) ASC LIMIT 200
  `,
  LIST_KNOWLEDGE_MODELS: `
    MATCH (k:KnowledgeModel)
    RETURN k.id AS id, coalesce(k.name, k.id) AS name, coalesce(k.description, '') AS description, coalesce(k.status, '') AS status
    ORDER BY toLower(coalesce(k.name, k.id)) ASC LIMIT 200
  `,
  LIST_CAPABILITIES: `
    MATCH (c:Capability)
    RETURN c.id AS id, coalesce(c.name, c.id) AS name, coalesce(c.description, '') AS description, coalesce(c.status, '') AS status
    ORDER BY toLower(coalesce(c.name, c.id)) ASC LIMIT 200
  `,
  UPDATE_AGENT: `
    MATCH (a:Agent {id: $id})
    WHERE ${REGISTRY_CAN_WRITE}
    SET a += $patch,
        ${PROVENANCE('a')}
    RETURN a.id AS id
  `,
  SET_ENABLED: `
    MATCH (a:Agent {id: $id})
    WHERE ${REGISTRY_CAN_WRITE}
    SET a.enabled = $enabled,
        a.active = $enabled,
        ${PROVENANCE('a')}
    RETURN a.id AS id
  `,
  LINK_IDW: `
    MATCH (a:Agent {id: $id}), (i:IDW {id: $targetId})
    WHERE ${REGISTRY_CAN_WRITE}
    MERGE (a)-[r:APPLIES_TO_IDW]->(i)
      ON CREATE SET r.createdAt = $nowMs, r.createdBy = $viewerId
    SET ${PROVENANCE('a')}
    RETURN i.id AS id
  `,
  UNLINK_IDW: `
    MATCH (a:Agent {id: $id})-[r:APPLIES_TO_IDW]->(i:IDW {id: $targetId})
    WHERE ${REGISTRY_CAN_WRITE}
    DELETE r
    SET ${PROVENANCE('a')}
    RETURN i.id AS id
  `,
  LINK_KNOWLEDGE: `
    MATCH (a:Agent {id: $id}), (k:KnowledgeModel {id: $targetId})
    WHERE ${REGISTRY_CAN_WRITE}
    MERGE (a)-[r:USES_KNOWLEDGE]->(k)
      ON CREATE SET r.createdAt = $nowMs, r.createdBy = $viewerId
    SET ${PROVENANCE('a')}
    RETURN k.id AS id
  `,
  UNLINK_KNOWLEDGE: `
    MATCH (a:Agent {id: $id})-[r:USES_KNOWLEDGE]->(k:KnowledgeModel {id: $targetId})
    WHERE ${REGISTRY_CAN_WRITE}
    DELETE r
    SET ${PROVENANCE('a')}
    RETURN k.id AS id
  `,
  LINK_CAPABILITY: `
    MATCH (a:Agent {id: $id}), (c:Capability {id: $targetId})
    WHERE ${REGISTRY_CAN_WRITE}
    MERGE (a)-[r:HAS_CAPABILITY]->(c)
      ON CREATE SET r.createdAt = $nowMs, r.createdBy = $viewerId
    SET ${PROVENANCE('a')}
    RETURN c.id AS id
  `,
  UNLINK_CAPABILITY: `
    MATCH (a:Agent {id: $id})-[r:HAS_CAPABILITY]->(c:Capability {id: $targetId})
    WHERE ${REGISTRY_CAN_WRITE}
    DELETE r
    SET ${PROVENANCE('a')}
    RETURN c.id AS id
  `,
  /** Registry-contract entities an admin may mint (MERGE on id, provenance). */
  CREATE_KNOWLEDGE_MODEL: `
    MATCH (adm:Person {id: $viewerId})
    WHERE ${REGISTRY_ADMIN}
    MERGE (k:KnowledgeModel {id: $targetId})
      ON CREATE SET k.createdAt = $nowMs, k.created_by_user = $viewerId, k.created_by_app_name = '${REGISTRY_APP_NAME}'
    SET k.name = $name,
        k.description = $description,
        k.type = coalesce($type, 'collection'),
        k.status = coalesce($status, 'available'),
        ${PROVENANCE('k')}
    RETURN k.id AS id
  `,
  CREATE_CAPABILITY: `
    MATCH (adm:Person {id: $viewerId})
    WHERE ${REGISTRY_ADMIN}
    MERGE (c:Capability {id: $targetId})
      ON CREATE SET c.createdAt = $nowMs, c.created_by_user = $viewerId, c.created_by_app_name = '${REGISTRY_APP_NAME}'
    SET c.name = $name,
        c.description = $description,
        c.status = 'active',
        ${PROVENANCE('c')}
    RETURN c.id AS id
  `,
  ADD_ENDPOINT: `
    MATCH (a:Agent {id: $id})
    WHERE ${REGISTRY_CAN_WRITE}
    CREATE (a)-[:REACHABLE_VIA]->(e:AgentEndpoint:__KIND_LABEL__ {
      id: $endpointId, kind: $kind, url: $url, channels: $channels, createdAt: $nowMs, createdBy: $viewerId
    })
    SET ${PROVENANCE('a')}
    RETURN e.id AS id
  `,
  REMOVE_ENDPOINT: `
    MATCH (a:Agent {id: $id})-[:REACHABLE_VIA]->(e:AgentEndpoint {id: $endpointId})
    WHERE ${REGISTRY_CAN_WRITE}
    DETACH DELETE e
    SET ${PROVENANCE('a')}
    RETURN $endpointId AS id
  `,
  SET_MANUAL_CHECKS: `
    MATCH (a:Agent {id: $id})
    WHERE ${REGISTRY_CAN_WRITE}
    SET a.lite_listing_checks = $checks,
        ${PROVENANCE('a')}
    RETURN a.id AS id
  `,
  /** Listing state: unlisted | submitted | listed | rejected (+ contract status). */
  SET_LISTING: `
    MATCH (a:Agent {id: $id})
    WHERE ${REGISTRY_CAN_WRITE}
      AND ($listing <> 'listed' OR ${REGISTRY_ADMIN})
    SET a.lite_listing = $listing,
        a.lite_listed_at = CASE WHEN $listing = 'listed' THEN $nowMs ELSE a.lite_listed_at END,
        a.status = CASE WHEN $listing = 'listed' THEN 'active' WHEN $listing = 'rejected' THEN coalesce(a.status, 'inactive') ELSE a.status END,
        ${PROVENANCE('a')}
    RETURN a.id AS id, a.lite_listing AS listing
  `,
  /** Idempotent registry annotations for other writers (lite_* keys only). */
  ENSURE_ANNOTATIONS: `
    MERGE (ag:Schema {entity: 'Agent'})
    SET ag.lite_properties =
          'lite_listing: unlisted|submitted|listed|rejected (Lite Agent Registry, ADR-086) · lite_listed_at: epoch ms · ' +
          'lite_listing_checks: JSON of manual review ticks · enabled/active mirrored on toggle · ' +
          'every Lite write stamps updated_by_app_id/updated_by_app_name/updated_by_user/updatedAt (and updated_at as a string)',
        ag.lite_annotated_at = $nowMs
    MERGE (rt:Schema {entity: '_RelationshipTypes'})
    SET rt.lite_registry_relationships =
          'APPLIES_TO_IDW (Agent→IDW): the agent is deployed on / applies to that IDW · USES_KNOWLEDGE (Agent→KnowledgeModel) · ' +
          'HAS_CAPABILITY (Agent→Capability): a skill the agent has · REACHABLE_VIA (Agent→AgentEndpoint:Mcp|Api|Skill) · ' +
          'written by the Lite Agent Registry (ADR-086) with createdAt/createdBy on the edge; an admin is a Person with role admin|owner',
        rt.lite_registry_annotated_at = $nowMs
    RETURN 2 AS annotated
  `,
} as const;
