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

- **Phase 3 — Workspace Beta (v1)** (committed; planned in [`.cursor/plans/lite_spaces_phase_3_writes_share_onboard_7e4c2a91.plan.md`](../../.cursor/plans/lite_spaces_phase_3_writes_share_onboard_7e4c2a91.plan.md) for chunks 3a-3f and in [`.cursor/plans/spaces_v1_internal_release_doc_37b3367a.plan.md`](../../.cursor/plans/spaces_v1_internal_release_doc_37b3367a.plan.md) for the v1 release contract that adds 3g/3h/3i/3k/3o; recorded in [ADR-048](../DECISIONS.md)). The Workspace Beta is the foundation the Data Room (Phase 4 / v2) is built on top of. See also: [`./RELEASE-V1-INTERNAL.md`](./RELEASE-V1-INTERNAL.md).
  - **Home view (3k + 3o)** — ships first as the v1 milestone. Replaces the Phase 0.5 Discovery panel with a 5-card news-feed dashboard fed by 6 read-only Cypher queries (entity counts, recent items, top contributors, recent events, agents sample, permission summary). Sidebar gains a "Home" item above the Spaces list; Home becomes the default landing scope on window open. Detail in [`./HOME-V1.md`](./HOME-V1.md). 3k pulled forward from v2 to power the activity card.
  - **3a — Create / Rename / Delete Space**: SDK methods `spaces.create`, `spaces.rename`, `spaces.delete`, `spaces.undelete`. Soft-delete by default; reversibility enforced via the `trust-principles.test.ts` harness. New error codes `SPACES_DUPLICATE_NAME`, `SPACES_DELETE_NON_EMPTY`. "+ New Space" button in sidebar; inline rename on double-click.
  - **3b — Item creation seam + 3-tier WAL router**: per Pre-A (ADR-049) recommends new `lite/items/` module with `:AUTHORED_BY` provenance distinguishing user-authored from agent-produced. Routes text→KV, binary→Files, metadata→Neon via the WAL pattern (Pre-G). Required so the tour's step 2 ("drop something into your Space") demos a real loop.
  - **3c — Add to / Remove from Space**: `spaces.items.fileInto` / `spaces.items.removeFrom`. `:BELONGS_TO` edges carry `addedBy` + `addedAt`. Multi-Space chips update without reload.
  - **3d — Space-level sharing UX**: gated on Edison D-series answers (D1-D7). `spaces.share`, `spaces.unshare`, `spaces.listGrants`, `spaces.listAccountMembers`. Account-member picker home depends on D7. Share modal hides when caller lacks grant rights per D5. Privacy review for the picker per [`PRIVACY-REVIEW-PICKER.md`](./PRIVACY-REVIEW-PICKER.md) signs off before code lands.
  - **3g — Asset-level sharing**: `(:Asset)-[:SHARED_WITH]->(:Person)` per canonical schema. Composition with Space ACLs per Pre-E ADR.
  - **3h — Per-filing intent metadata**: user-authored "why I put this here" annotation on each filing. Payload location per Pre-D ADR.
  - **3i — AI Spaces-suggester with auto-file + undo**: classifier on asset creation suggests Spaces; top suggestion auto-fires; one-click undo from recap card. Trust Principle amendment in Pre-E ADR.
  - **3e0 — Tour prototype gate**: non-code prototype with 2-3 user tests; gates 3e on observed median ≤ 90s, p95 ≤ 180s. Skipping this gate means shipping a tour that COULD be 4 minutes p50 because step 4 was confusing.
  - **3e — Tour code**: 8-step guided flow (`name your Space → drop something in → see AI suggestion → file into second Space → add intent → share Space → share asset → recap`). Three entry points (empty-state CTA, permanent "How does this work?" header button, Settings → Diagnostics replay). Persisted in KV `lite-spaces-onboarding/default`.
  - **3f — Recap card + cleanup with failure paths**: also handles 3i auto-file undos. "Delete and start fresh" cleanup is multi-mutation (revoke shares → remove memberships → soft-delete items → soft-delete Space); the failure matrix in the plan documents the UI response when each step fails so the user is never left with worse state than starting over.
- **Phase 4 — Data Room (v2)** (placeholder in [`./V2-DATA-ROOM-PLACEHOLDER.md`](./V2-DATA-ROOM-PLACEHOLDER.md); full plan drafted after v1 ships). Four chunks:
  - **3j — Auto-metadata pipeline**: title / summary / tags / language / hash / embedding generated on every asset, not just Space suggestions. New stage in 3b's seam after the WAL `published` step.
  - **3l — Real bidirectional sync**: port [`lib/sync-v5/`](../../lib/sync-v5/) (already built and tested in the full app) into `lite/sync/`. Multi-device aware; offline-tolerant; conflict resolution via existing sync-v5 strategies. Removes the "Local cache / offline support" line from "Out of Scope" below.
  - **3m — Ontology-aware navigation**: cross-entity views ("Asset → its creator + sharers + commits + Spaces", "Person → all assets they touched", "Agent → all assets it produced"). Graph search across `:Asset.name` + KV-resident body. Possibly a Cytoscape graph view.
  - **3n — Agents as first-class room participants**: `(:Agent)-[:WATCHES]->(:Space)` (new edge, schema amendment). When events fire (extended `:Commit` subscription on top of v1 3k), watching agents get notified. Composes with the existing `lib/exchange/` and `packages/agents/` infrastructure.
- **Phase 5 — Approval + Audit queue**: surface agent output landing in Uncategorized; humans approve, reject, or quarantine. Different mental model from "file these notes" — this is "do you accept this work product into the canonical record." Phase 3d reserves a `spaces.share.granted` notification hook that this builds the recipient-side UI for.
- **Why? Explainability panels**: structured reasoning per suggestion and per agent action, with linked evidence in the graph.
- **Ask the Librarians**: semantic search / RAG chat surface routed through the Retrieval Librarian.
- **Recommendation agent dashboards**: per-Librarian observability, per-agent suggestion accuracy, tuning controls.

## Out of Scope

Items explicitly not on this roadmap:

- Real-time activity pulse (server WebSocket prerequisite; no plan to add)
- Pin / favorite Spaces (small follow-up chunk; not roadmap-level)

(Note: "Local cache / offline support" was previously listed here; it has moved into Phase 4 v2 as chunk 3l now that the Data Room scope is committed.)

## Process

Each phase, when promoted from sketch to committed, gets its own micro-phase plan in `.cursor/plans/` following the same hardening contract template as the original Spaces plan.
