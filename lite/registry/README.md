# lite/registry -- the Agent Registry (ADR-086)

Public surface: `RegistryApi` (implements `RegistryManagerApi`) from
`./api.ts`, constructed by `initRegistry()` in `./main.ts` over the NEON
transport. Renderer surface: `window.lite.registry`. Opened from the
IDW menu ("Agent Registry...") into its own window (`registry.html`).

A search and registry manager over the account's `:Agent` catalog in
NEON: facets (source, type, category, availability, listing,
reachability, IDW, knowledge model), server-side search with paging,
and a management panel for the selected agent -- availability on the
platform, record fields, MCP / RESTful / Skill endpoints, what it
belongs to (IDWs via `APPLIES_TO_IDW`, knowledge models via
`USES_KNOWLEDGE`, skills via `HAS_CAPABILITY`), where it is used, and
the submission checklist with listing actions.

## Permissions

- Reads are the account-wide directory (agent inventory is not Space
  content -- the same stance as the agent library search).
- Writes need a registry **admin** (a `Person` whose `role` is
  `admin`/`owner`, case-insensitive) or the agent's own creator.
  Listing on the platform and minting knowledge models / capabilities
  are admin-only. The first admin is claimed from the window while the
  graph holds no admin at all; admins grant or revoke others.
- Every write stamps `_Manifest` provenance (`updated_by_app_id`,
  `updated_by_app_name`, `updated_by_user`, `updatedAt`). Lite's own
  additions are namespaced: `lite_listing`, `lite_listed_at`,
  `lite_listing_checks`.

## Submission checklist (`checklist.ts`, pure)

Derived from the graph's registry contract: id, name, description
(20+ chars), type, category, reachable (an endpoint, a GSX endpoint or
a system agent), owner, not deleted, enabled, status in the vocabulary
(`active | inactive | deprecated`); recommended: version, three
keywords, an IDW or knowledge model home; manual reviews an admin
ticks (behaviour reviewed, endpoints/credentials reviewed, docs
linked). `unlisted -> submitted -> listed` (or `rejected`); submit and
list refuse until every required check passes.

## Files

- `types.ts` -- records, search input/result, viewer, checklist types.
- `queries.ts` -- the Cypher surface (`REGISTRY_CYPHER`), the admin gate
  and the provenance stamp.
- `api.ts` -- `RegistryApi`, row mappers, input sanitization.
- `checklist.ts` -- the checklist evaluation.
- `main.ts` -- `initRegistry()`: IPC handlers (`lite:registry:*`, one
  envelope shape) + window.
- `window.ts`, `registry.html`, `registry.css`, `renderer.ts`.

Tests: `test/unit/registry-contract.test.ts`, `test/unit/registry-ui.test.ts`.
