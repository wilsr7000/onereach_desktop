# Lite Spaces — Roadmap

This is a sketch, not a commitment. Sequencing and scope will be revised as observed usage reveals what users (and agents) actually need.

## Shipped

- **Phase 0**: Module foundation + window shell + IPC wiring.
- **Phase 0.5**: Discovery panel running Q1–Q4 against the configured Neon endpoint (collapsible diagnostic).
- **Phase 1**: Sidebar lists every `:Space` the account can read; Uncategorized intake count surfaced as a sidebar badge.
- **Phase 2**: Items as cards in the main pane; right-rail detail panel; multi-Space chips per card via `otherSpaces` projection; optional provenance line from `(:Item)-[:PRODUCED_BY|AUTHORED_BY]->(producer)`; scope switching reloads cards; clicking an active card collapses the detail panel.

Test coverage: 31 SDK-client unit tests (Cypher source regression guards + row-mapping + error normalization), 37 renderer unit tests (jsdom-backed pure builders + formatters), plus the prior 19 conformance + discovery tests. All `lite:test:unit` green at the time of writing.

## Platform Consumers

Spaces is a platform primitive (substrate other GSX components consume), not just a Lite UI module. The SDK at `lite/spaces/api.ts` is the platform contract. Consumers today and anticipated:

- **Lite Spaces UI** (this module) — the first consumer; validates the API surface end-to-end.
- **GSX agent runtime** (planned) — agents write outputs into Spaces during task execution; provenance edges populate on write.
- **Cowork integration** (planned) — reads Space contents into agent context windows for dispatch.
- **Approval + Audit event stream** (planned) — emits events when agent output lands in Uncategorized or moves into a canonical Space; compliance tooling and external audit subscribers consume.
- **Third-party Librarian-class agents** (planned) — recommendation, reconciliation, dedup, archival agents written by GSX customers, plugging into the substrate via the same SDK and conforming to the same Trust Principles.

The SDK is designed as if it were `@or-sdk/spaces` from Phase 0 (stable signatures, semantic versioning, structured errors, observable events). When a second consumer appears the module promotes to `lib/spaces/`. When a non-monorepo consumer appears it promotes to `@or-sdk/spaces`. Both are mechanical refactors.

## Sketched

Phases below are likely directions but not committed. Names and sequencing may collapse or split based on what observed usage reveals about agent output volume, governance pain points, and user behavior.

- **Phase 3 — Write paths**: create / rename / delete Space; manual Add to Space; remove from Space (for both human- and agent-initiated writes).
- **Phase 4 — Approval + Audit queue**: surface agent output landing in Uncategorized; humans approve, reject, or quarantine. Different mental model from "file these notes" — this is "do you accept this work product into the canonical record."
- **Librarian Activity Feed**: visible timeline of what the Librarians and producing agents did today. Trust through transparency.
- **Why? Explainability panels**: structured reasoning per suggestion and per agent action, with linked evidence in the graph.
- **Relationship and overlap views**: Cytoscape-based graph view; cross-Space overlap visualization; agent-collaboration patterns.
- **Ask the Librarians**: semantic search / RAG chat surface routed through the Retrieval Librarian.
- **Recommendation agent dashboards**: per-Librarian observability, per-agent suggestion accuracy, tuning controls.

## Out of Scope

Items explicitly not on this roadmap:

- Local cache / offline support
- Real-time activity pulse (server WebSocket prerequisite; no plan to add)
- Pin / favorite Spaces (small follow-up chunk; not roadmap-level)

## Process

Each phase, when promoted from sketch to committed, gets its own micro-phase plan in `.cursor/plans/` following the same hardening contract template as the original Spaces plan.
