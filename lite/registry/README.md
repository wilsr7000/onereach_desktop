# lite/registry -- the Agent Registry (ADR-086)

Public surface: `RegistryApi` (implements `RegistryManagerApi`) from
`./api.ts`, constructed by `initRegistry()` in `./main.ts` over the NEON
transport. Renderer surface: `window.lite.registry`. Opened from the
GSX menu ("Agent Library…"; it sat under IDW until 2026-09-05) into its own window (`registry.html`).

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

## Admission checklist (ADR-088)

`admission.ts` is the Gartner-project admission checklist (A1–F2, the platform matrix, the grade map) extracted from the hosted page verbatim, with `computeAdmission()` a port of the page's `compute()`. The registry API reads and writes the page's shared KV document (`amp:rfi` / `registry:checklist`):

- `admissionGet(id)` — the agent's entry + status (progress, rung, ceiling, grade, admission, per-line met/blocked/federated) and whether the viewer may write.
- `admissionSave(id, { platform?, ownerEmail?, items? })` — merged into the shared document (fresh read, own entry replaced, everyone else's untouched), stamped `updatedAt`/`by`/`agentId`.
- `admissionAnalyze(id)` — graph-proven lines ticked with evidence (A1, A4, D5, E2); a Claude grading pass over the rest, recorded under `lite.analysis`, never auto-ticked.
- `setListing` is gated by admission: submit needs a grade above Critical; list needs F1 + F2.
- `openWindow({ agentId })` opens the registry on that agent (from a Space's agent detail).

## Where an agent lives (ADR-089)

Shown as the **Agent Library**. Each summary carries `spaces` (Spaces the viewer may see that hold the agent, via an asset that represents it or the full app's usage edge; sight-filtered with the ADR-084 predicate), `hosting` (`library` | `hosted` | `catalog`) with `account`, and `isSkill` (an agent with a UI: micro-ui or a Skill endpoint). Filters: `spaceId`, `hosting`, `kind`. `listSpaces()` feeds the Space facet.
