/**
 * Named-query registry — the only Cypher a renderer can cause to run.
 *
 * From the 2026-08-07 graph review (N4): `window.lite.neon.query`
 * accepted arbitrary Cypher from any Lite renderer, checked only for
 * "non-empty string". The renderer surface turned out to have exactly
 * ONE consumer (the IDW catalog, one fixed query), so instead of an
 * allowlist bolted onto a raw channel, the raw channel is gone:
 * modules register their fixed Cypher here at init (main process),
 * and renderers may only invoke a query BY NAME. The text of every
 * runnable query lives in reviewed source; a renderer — or anything
 * that compromises one — can choose from the menu but never write it.
 *
 * Pure module (no Electron imports): api.ts re-exports `register`
 * without creating an api→main cycle, and the registry is testable
 * directly.
 */

const registry = new Map<string, string>();

/** Name format: `<module>.<query-name>`, lowercase dot/dash tokens. */
const NAME_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

/**
 * Register a named query. Called by module `init*()` in the main
 * process. Throws on an invalid name, empty Cypher, or an attempt to
 * REDEFINE an existing name with different text — silently replacing
 * a reviewed query is exactly the substitution this registry exists
 * to prevent. Re-registering identical text is a no-op so idempotent
 * module inits stay safe.
 */
export function registerNamedQuery(name: string, cypher: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(
      `named query "${name}" must be <module>.<name> in lowercase dot/dash tokens`
    );
  }
  if (typeof cypher !== 'string' || cypher.trim().length === 0) {
    throw new Error(`named query "${name}" has empty Cypher`);
  }
  const existing = registry.get(name);
  if (existing !== undefined && existing !== cypher) {
    throw new Error(
      `named query "${name}" is already registered with different Cypher — ` +
        `redefinition is not allowed`
    );
  }
  registry.set(name, cypher);
}

/** The Cypher for a registered name, or null when unknown. */
export function getNamedQuery(name: string): string | null {
  return registry.get(name) ?? null;
}

/** Registered names, for diagnostics. Never exposes the Cypher. */
export function listNamedQueries(): string[] {
  return [...registry.keys()].sort();
}

/** Test-only: clear the registry between cases. */
export function _resetNamedQueriesForTesting(): void {
  registry.clear();
}
