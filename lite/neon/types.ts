/**
 * Neon module shared types.
 *
 * Public types are re-exported from `api.ts`. Internal types stay
 * here. Consumers typecheck against `NeonRecord`, `NeonNode`,
 * `NeonRelationship`, `NeonStatus`, and `NeonConfig` -- never against
 * the raw `client.ts` shapes.
 *
 * Wire-format note: the `/omnidata/neon` endpoint returns records
 * keyed by Cypher RETURN aliases. Node values are normalized at the
 * client boundary to `{ id, labels, properties }`; relationship values
 * to `{ id, type, start, end, properties }`. Primitive scalars and
 * arrays pass through as-is.
 */

/**
 * One Cypher record. Keys are the RETURN aliases.
 *
 * Example:
 *   `MATCH (p:Person) RETURN p, p.email AS email LIMIT 1`
 *   -> `[{ p: <NeonNode>, email: 'rich@example.com' }]`
 */
export interface NeonRecord {
  [alias: string]: NeonValue;
}

export type NeonValue =
  | null
  | string
  | number
  | boolean
  | NeonNode
  | NeonRelationship
  | NeonValue[]
  | { [key: string]: NeonValue };

/**
 * Normalized Neo4j Node value.
 *
 * `id` is the Neo4j-internal element identifier (string for forward
 * compatibility with `elementId`). Callers that need a stable
 * application-level key should read it out of `properties` (e.g.
 * `properties.id`, `properties.email`).
 */
export interface NeonNode {
  id: string;
  labels: string[];
  properties: { [key: string]: NeonValue };
}

/**
 * Normalized Neo4j Relationship value.
 *
 * `start` / `end` are the internal element identifiers of the source
 * and target nodes (matching the shape of `NeonNode.id`).
 */
export interface NeonRelationship {
  id: string;
  type: string;
  start: string;
  end: string;
  properties: { [key: string]: NeonValue };
}

/**
 * Snapshot of the Neon client's configuration. Returned by
 * `getNeonApi().status()` and over IPC to renderers. NEVER includes
 * the password.
 */
export interface NeonStatus {
  /** Edison /omnidata/neon flow URL, or null when unset. */
  endpoint: string | null;
  /** Neo4j Aura URI (`neo4j+s://...`), or null when unset. */
  uri: string | null;
  /** Username (default `neo4j`). */
  user: string;
  /** Database name (default `neo4j`). */
  database: string;
  /** True when a non-empty password is loaded into the credential provider. */
  hasPassword: boolean;
  /** True when the client can attempt a query (endpoint + uri + password). */
  ready: boolean;
}

/**
 * Configuration accepted by `getNeonApi().configure(...)`. Any fields
 * provided are persisted via the active credentials provider; missing
 * fields are left unchanged. Pass `password: ''` to clear the password.
 */
export interface NeonConfig {
  endpoint?: string;
  uri?: string;
  user?: string;
  password?: string;
  database?: string;
}

/**
 * Sentinel constant so `types.ts` has a value-level export (avoids
 * dep-cruiser orphan warning).
 */
export const NEON_MODULE_VERSION = 1 as const;
