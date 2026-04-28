# sync-v5 Materialised Replica — Shape, Equivalence, and Cutover

**Status**: planning. No code yet. This document is the prerequisite for the
materialised-replica implementation work that activates v5 invariants 1, 2,
and 6 (source-of-truth, convergence, read-path).

**Owner**: TBD; the replica is the next architectural step after the
`db2a614 → 0d0187b` v5 commit chain.

**Reading**: pair this with the v5 architectural review at
`/Users/richardwilson/.cursor/plans/spaces_+_neo4j_(neon)_source-of-truth_architecture_review_(v5)_*.plan.md`,
sections 4.1 / 4.6 / 5.

---

## 0. Goal in one sentence

The materialised replica is a per-device SQLite database that exposes the
exact query surface today's Spaces consumers depend on, populated by
deterministic projection of `:Space` and `:Asset` rows from the graph (and,
during cutover, by mirror writes from the existing
`clipboard-storage-v2.js`). When the replica is in place, the existing
storage becomes a write-shim during cutover and is removed entirely after.

Verifiable success criterion: every test that passes today against
`clipboard-storage-v2.js` + `index.json` + `OR-Spaces/` also passes against
the replica, and `pull-engine.applyMode` flips from `noop` to `sqlite` in
boot wiring without any consumer change.

---

## 1. Surprise discovered during recon

The Spaces stack today has **two parallel datastore paths**, not one. Any
replica plan that addresses only `spaces-api.js` is a partial solution.

```mermaid
flowchart TB
  subgraph p1 [Spaces API path - what the architecture review documented]
    direction TB
    consumer1["spaces-agent / omni-data-agent /<br/>recorder / playbook-executor /<br/>build-step-template / spaces-upload-handler"]
    api1["spaces-api.js<br/>SpacesAPI class"]
    storage1["clipboard-storage-v2.js<br/>(DuckDB + index.json + filesystem)"]
    consumer1 --> api1 --> storage1
  end

  subgraph p2 [Clipboard adapter path - undocumented in v5 plan]
    direction TB
    consumer2["clipboard-viewer.js<br/>(Spaces Manager UI)"]
    api2["window.clipboard.*<br/>(preload.js)"]
    adapter2["clipboard-manager-v2-adapter.js"]
    storage2["clipboard-storage-v2.js<br/>same backend"]
    consumer2 --> api2 --> adapter2 --> storage2
  end

  storage1 -.->|same on-disk store| storage2
```

The two paths share the same physical storage (one DuckDB, one
`index.json`, one `OR-Spaces/items/` tree) but expose different in-process
APIs and **different search backends**:

- `spaces-api.search(query, opts)` — used by `spaces-agent` and other
  agent code; goes through `clipboard-storage-v2.search()` with
  `searchTags`, `searchMetadata`, `searchContent`, `fuzzy`,
  `fuzzyThreshold`, `includeHighlights` options
  ([spaces-api.js:1295-1385](spaces-api.js)).
- `window.clipboard.search(query)` — used by `clipboard-viewer`; routes
  through the adapter and does its own thing
  ([clipboard-manager-v2-adapter.js:1086-1091](clipboard-manager-v2-adapter.js)).

**Consequence for the replica**: it must satisfy both paths, OR the
cutover plan must unify them first. Recommendation: **unify before
replicating**. The clipboard adapter's read methods become thin wrappers
over `spaces-api`, then the replica targets only `spaces-api`'s surface.
This is one extra commit's worth of work (~2-3 days, mostly tests) and
saves an indefinite tail of "the replica works for agents but the UI
shows different results" debugging.

---

## 2. Query surface the replica must answer

Enumerated from production callers. Frequency notes apply at this user's
single-device scale; treat them as relative not absolute.

### 2.1 Hot path (per-render or per-event)

- `spaces.list()` — every UI init, every space-tab switch. Returns
  `{id, name, icon, color, itemCount, path, createdAt, updatedAt}[]`.
  ItemCount is derived (`COUNT(*) FROM items WHERE space_id = ?` in
  replica terms; today it's `index.items.filter(...).length`).

- `items.list(spaceId, options)` — every space-tab switch via
  `getSpaceItems`, also direct from agents and recorder. Options:
  `{limit, offset, type, pinned, tags, anyTags, includeContent}`.
  Sort: pinned first, then `timestamp` desc.
  - **Tag semantics**: `tags` = ALL must match; `anyTags` = ANY must
    match. Case-insensitive in current implementation.
  - **`includeContent: false`** is the high-frequency case (list views).
    Returns metadata + path references; UI lazy-loads bodies.
  - **`includeContent: true`** is the slow-path case (smart export,
    playbook-executor build steps). Reads body from filesystem via
    `loadItem(itemId)`.

- `items.get(spaceId, itemId)` — preview / detail open in UI; agent
  context lookup (`gsx-agent-main-context`, `gsx-agent-profile` are
  fixed item IDs read by `omni-data-agent` and cached). Returns
  full item including parsed `metadata`.

- `search(query, options)` — debounced UI search input;
  `spaces-agent`'s `{ limit: 10 }` voice queries; recorder lookups.
  Options: `{spaceId, type, searchTags, searchMetadata, searchContent,
  fuzzy, fuzzyThreshold, limit, includeHighlights}`. Defaults:
  searchTags=true, searchMetadata=true, searchContent=false,
  fuzzy=true, fuzzyThreshold=0.7, includeHighlights=true.
  Returns items extended with
  `_search: {score, matches, highlights?}`.

### 2.2 Cross-space and aggregate

- `tags.list(spaceId)` → `[{tag, count}]` per space.
- `tags.listAll()` → `[{tag, count, spaces: string[]}]` global.
- `tags.findItems(tags, options)` — options: `{spaceId?, matchAll?,
  limit?}`. matchAll defaults to false (any match).
- Smart folders evaluate cross-space against `criteria: {tags, anyTags,
  types, spaces}`.

### 2.3 Specific-tag filters used by integrations

These are the implicit contracts that need replica equivalence:

- `items.list(spaceId, { tags: ['riff-source'], includeContent: true })`
  — WISER Playbooks build steps ([build-step-template.html:244](build-step-template.html)).
- `items.list(spaceId, { tags: ['wiser-meeting'], includeContent: true })`
  — WISER meeting capture ([recorder.js:621-625](recorder.js)).
- `items.list(spaceId, { tags: ['wiser-template'] })` — WISER templates
  ([recorder.js:674-677](recorder.js)).
- `metadata.source === 'riff' | 'wiser-playbooks'` — playbook detection
  in `playbook-executor._isPlaybook`. Tag-equivalent for cross-asset
  filtering.

### 2.4 Mutation surface

- `items.add(spaceId, item)` — called by clipboard capture (high
  frequency at the user level), agents, and direct UI saves. Payload:
  `{type, content, metadata?, source?, skipAutoMetadata?}`.
- `items.update(spaceId, itemId, data)` — partial item-row update.
- `items.delete(spaceId, itemId)`, `items.deleteMany(spaceId, ids[])`.
- `items.move(itemId, fromSpaceId, toSpaceId)`,
  `items.moveMany(ids[], from, to)`.
- `items.togglePin(spaceId, itemId)` → returns new boolean.
- Tag mutations: `items.getTags / setTags / addTag / removeTag`.
- `spaces.create / update / delete`.

### 2.5 Filesystem-shaped read

- `files.read(spaceId, relativePath)` — UTF-8 markdown read, used by
  `unified-bidder` for `gsx-agent/conversation-history.md` and
  `gsx-agent/session-summaries.md`
  ([spaces-api.js:1994-2002](spaces-api.js)).

The replica doesn't model this directly — it remains a filesystem
operation against `OR-Spaces/spaces/<spaceId>/<relativePath>`. The
replica's content cache (keyed by `contentHash`) is a separate layer.

---

## 3. Replica SQLite schema

Mirrors the DuckDB schema in
[clipboard-storage-v2.js:209-294](clipboard-storage-v2.js) with two
additions for v5: `vc` (vector clock) and `vc_after_hash` (digest of vc
for indexed lookups).

```sql
-- Spaces table: one row per :Space.
CREATE TABLE spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT,
  color TEXT,
  is_system INTEGER DEFAULT 0,           -- 0/1; SQLite has no BOOLEAN
  created_at TEXT NOT NULL,              -- ISO 8601
  updated_at TEXT NOT NULL,
  vc TEXT NOT NULL DEFAULT '{}',         -- JSON-encoded VectorClock
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_spaces_active ON spaces(active);

-- Items table: one row per :Asset.
CREATE TABLE items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  space_id TEXT NOT NULL DEFAULT 'unclassified',
  timestamp INTEGER NOT NULL,            -- ms since epoch
  preview TEXT,
  content_path TEXT,
  thumbnail_path TEXT,
  metadata_path TEXT,
  tags TEXT NOT NULL DEFAULT '[]',       -- JSON-encoded string[]
  pinned INTEGER NOT NULL DEFAULT 0,
  file_name TEXT,
  file_size INTEGER,
  file_type TEXT,
  file_category TEXT,
  file_ext TEXT,
  is_screenshot INTEGER DEFAULT 0,
  json_subtype TEXT,
  -- Source / provenance (mirrors clipboard-storage-v2 GSX columns)
  source TEXT,
  metadata_source TEXT,
  -- v5 additions
  content_hash TEXT,                     -- SHA-256, references blob store
  vc TEXT NOT NULL DEFAULT '{}',         -- JSON-encoded VectorClock
  active INTEGER NOT NULL DEFAULT 1,     -- soft-delete flag (tombstoned items)
  deleted_at TEXT,                       -- ISO 8601 if active=0
  deleted_by TEXT,                       -- deviceId from :Tombstone
  created_at TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  has_parked_precursor INTEGER NOT NULL DEFAULT 0  -- DLQ flag from sync-engine
);

-- Mirror the DuckDB indexes for query parity.
CREATE INDEX idx_items_space ON items(space_id, active);
CREATE INDEX idx_items_type ON items(type);
CREATE INDEX idx_items_timestamp ON items(timestamp DESC);
CREATE INDEX idx_items_pinned ON items(pinned, timestamp DESC);
CREATE INDEX idx_items_content_hash ON items(content_hash);

-- Full-text search index for searchContent path (replaces clipboard-storage-v2's
-- ad-hoc fuzzy matching). FTS5 supports BM25 ranking + tokenization.
CREATE VIRTUAL TABLE items_fts USING fts5(
  id UNINDEXED,
  preview,
  content,                               -- lazy-populated when includeContent path runs
  metadata_text,
  tags_text,
  tokenize = 'porter unicode61'
);

-- Tags index (denormalised for tag-aggregate queries).
-- Avoids JSON-array scans on every tags.list call.
CREATE TABLE item_tags (
  item_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (item_id, tag),
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
);
CREATE INDEX idx_item_tags_tag ON item_tags(tag);

-- Smart folders persisted alongside item state for transactional consistency.
CREATE TABLE smart_folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT,
  color TEXT,
  criteria TEXT NOT NULL,                -- JSON {tags, anyTags, types, spaces}
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Schema version for migration tooling (Phase 5 hooks here).
CREATE TABLE replica_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO replica_meta(key, value) VALUES ('schemaVersion', '1');
INSERT INTO replica_meta(key, value) VALUES ('lastFullPullAt', '');
INSERT INTO replica_meta(key, value) VALUES ('cursor', '');
```

### 3.1 Schema choice notes

- **SQLite over DuckDB**: SQLite is the standard for OLTP-shaped local
  replicas; DuckDB is OLAP-shaped (columnar). Per the v5 plan §4.1 ("one
  DB per device. Holds materialized projection... Replaces DuckDB and
  index.json"), the replica explicitly displaces DuckDB. We can use
  `better-sqlite3` (synchronous, no native build complications on macOS)
  or stick with `@duckdb/node-api` if avoiding the new dep is more
  important than the architectural fit. **Recommendation**: add
  `better-sqlite3` as a dep — it's the right tool, the Electron-build
  story is well-trodden, and SQLite has FTS5 which is a real win for
  the search backend.

- **`tags` denormalised**: `tags.list / listAll / findItems` are common
  enough that scanning JSON arrays in the items table is a wrong
  choice. The `item_tags` join table is the cheap fix.

- **FTS5 for searchContent**: today's
  `clipboard-storage-v2.search` is ad-hoc fuzzy matching across
  preview / metadata. FTS5 with porter+unicode61 tokenization is
  strictly better and gives BM25 ranking for free, replacing the manual
  `_search.score` computation.

- **Soft-delete via `active=0`** + `deleted_at` / `deleted_by` matches
  the v5 tombstone model. The replica retains tombstoned rows
  (compactor doesn't touch them); `:Tombstone` in the graph is the
  authoritative record.

---

## 4. Initial population (cold device)

A device that's never seen the replica before needs to populate it from
either (a) the existing `clipboard-storage-v2` data or (b) the graph.

```mermaid
flowchart TB
  start[First boot with replica enabled] --> check{Local DuckDB +<br/>index.json present?}
  check -->|yes| migrate[Migrate from existing storage:<br/>read index.items / index.spaces<br/>+ each item's metadata.json,<br/>insert into SQLite]
  check -->|no| pull{Graph reachable?}
  pull -->|yes| graphpull[Pull from graph:<br/>MATCH (s:Space)-[:CONTAINS]->(a:Asset)<br/>RETURN s.id, a.id, a.vc, a.contentHash, ...<br/>insert rows;<br/>set lastFullPullAt cursor]
  pull -->|no| empty[Start empty:<br/>replica populated as user adds items<br/>OR as graph becomes reachable]
  migrate --> bothmode[Replica live + clipboard-storage-v2 still mirroring]
  graphpull --> bothmode
  empty --> bothmode
  bothmode --> cutover[After validation window:<br/>flip read path to replica only]
```

The migration-from-existing-storage path is the load-bearing one for
this user (they have ~1019 items). It must:

1. Walk `index.items[]` and `index.spaces[]`.
2. For each item, read `metadata.json` from disk to recover the rich
   metadata that the index doesn't store.
3. Compute SHA-256 of each item's body file, write to the
   content-addressed blob store, set `content_hash` on the SQLite row.
4. Initialise `vc = { [deviceId]: 1 }` for every row (every existing
   item is "this device's first version" from the v5 perspective).
5. Set `replica_meta.lastFullPullAt` so subsequent pulls only fetch
   ops since.

This is one-shot, a few seconds for 1019 items. Should run on first
boot after the replica feature flag flips to true.

---

## 5. Cutover plan

The replica work is **not** a single commit. It's a sequence of
commits with a feature flag gating the read path. The pattern: keep
both code paths live, validate equivalence on production traffic, then
remove the old path.

### 5.1 Phases

```mermaid
flowchart LR
  c1[Commit A:<br/>replica library +<br/>migration tooling +<br/>tests against fixtures]
  c2[Commit B:<br/>boot wiring -<br/>replica instantiated,<br/>pull engine still applyMode='noop',<br/>migration runs on first boot if flag enabled]
  c3[Commit C:<br/>shadow-write -<br/>every existing storage write<br/>also writes the replica;<br/>read still goes through old path]
  c4[Commit D:<br/>shadow-read -<br/>every read returns existing-path result<br/>BUT also queries replica + diffs;<br/>logs divergences]
  c5[Commit E:<br/>cutover -<br/>read path flipped to replica;<br/>old path becomes write-only mirror]
  c6[Commit F:<br/>cleanup -<br/>old path removed;<br/>pull engine flips applyMode='sqlite']

  c1 --> c2 --> c3 --> c4 --> c5 --> c6
```

### 5.2 Settings flags

```
syncV5.replica.enabled               // default false; flip true to enable
syncV5.replica.shadowReadEnabled    // default false; commit D enables
syncV5.replica.cutoverEnabled       // default false; commit E enables
syncV5.replica.fallbackToOldPath    // default true until commit F
```

The flags ladder: `enabled` true → `shadowReadEnabled` true → run for
some duration → `cutoverEnabled` true → run for some duration →
`fallbackToOldPath` false → commit F.

### 5.3 Rollback

If commit C ships and a divergence is detected in production, the
shadow-read logs (commit D) make the divergence specific. Rollback is
flipping `replica.enabled` to false; the existing path is unaffected
because shadow-write was append-only on the replica, not destructive.

The earliest commit at which "remove old path" is safe is **D + 14
days of clean shadow-read logs**. This is non-negotiable for a personal
data store.

### 5.4 Test surface required

For each public API method the replica must answer, a paired test:

- **Equivalence test**: same args, both paths return byte-identical
  results (or, where ordering is non-deterministic, set-equivalent).
- **Round-trip test**: write through replica, read through old path,
  verify equivalence; and vice versa.
- **Failure-mode test**: replica down → fall back to old path; old path
  down → replica answers from cache.

About 80-120 tests across `items.list / get / add / update / delete /
move / togglePin`, `tags.list / listAll / findItems / addTag /
removeTag`, `search`, `smartFolders.*`, `spaces.*`. The existing test
suite at `test/unit/sync-v5/` reaches ~344 today; the replica equivalence
suite roughly doubles that.

---

## 6. Open questions

These are decisions I deliberately don't make in this document.

### 6.1 Library choice: `better-sqlite3` vs. `@duckdb/node-api`

**Recommendation**: `better-sqlite3`. Real SQL OLTP semantics, FTS5,
synchronous API, mature Electron-rebuild story.

**Concern**: new native dep. The repo currently has `@duckdb/node-api`
and could reuse it. DuckDB does support transactions and indexes, just
not optimised for the queue-shaped workload. For the replica
specifically (which is read-heavy with low-concurrency writes), DuckDB
would actually be fine. Trade-off: stick-with-what-works (DuckDB) vs.
right-tool-for-the-job (SQLite).

**Decision needed before commit A.**

### 6.2 Two-path unification: before or during cutover?

**Recommendation**: before. Unify `clipboard-viewer.js`'s
`window.clipboard.search()` with `spaces-api.search()` first, in a
separate commit. The replica then targets a single API surface. This
adds one commit's worth of work but eliminates an entire class of
"works in agents but UI shows different results" bugs.

**Alternative**: the replica supports both paths via parallel-queryable
methods. More complex, higher rollback risk. Not recommended.

**Decision needed before commit A.**

### 6.3 Migration of `gsx-agent` markdown files

`unified-bidder` reads `gsx-agent/conversation-history.md` and
`gsx-agent/session-summaries.md` via `files.read()`. These are not
items in the index — they're filesystem artefacts under
`OR-Spaces/spaces/gsx-agent/`. They survive the cutover untouched
because the replica doesn't model them; they remain on disk.

**Implicit contract**: the `OR-Spaces/spaces/<spaceId>/` directory
structure stays. Replica owns the catalog (items + tags + smart
folders); filesystem owns the raw markdown / files. This split is
called out in v5 §4.1 ("OR-Spaces folder becomes a write-only export
view"); the unified-bidder use case shows it's actually
read-and-write for this specific space.

**Refinement needed**: explicit list of "filesystem read paths the
replica must NOT shadow" — at minimum, `gsx-agent/*.md`.

### 6.4 Search backend semantics

`spaces-api.search` and `clipboard-storage-v2.search` produce
slightly different result shapes, and `clipboard-viewer.js`'s search
input is wired to the latter. FTS5's BM25 scoring is ranking-better
than the current ad-hoc fuzzy match but **changes scores**. UI-visible
behaviour will shift slightly — items that ranked #3 may now rank #1.
This is a behaviour change we should call out, not hide.

**Recommendation**: ship FTS5; document the change; let the
shadow-read window expose any user-affecting cases before cutover.

### 6.5 Tombstone retention vs. replica row retention

Per v5 §4.3, tombstones in the graph are permanent. The replica's
`active=0` rows mirror this permanence by default. But this user
hasn't expressed a preference — they may want the option to truly
purge soft-deleted rows after some retention window for storage
hygiene.

**Default**: keep tombstone rows forever, mirroring graph. The graph
is the authority; the replica conforms.

**Configurable**: `syncV5.replica.tombstoneRetentionDays` (default
unset = keep forever; if set, the periodic compactor purges
`active=0` rows older than the retention).

### 6.6 What's the right cutover validation duration?

Recommendation in §5.3 says "14 days of clean shadow-read logs."
That's a guess. Real answer depends on how often this user hits the
edge cases — search, tag operations, smart folders. If they don't use
smart folders for 14 days, the validation isn't validating.

**Refinement**: validation gates on **N invocations of each public API
method**, not wall-clock duration. E.g. 100 list, 100 get, 50 search,
20 tag mutations. Whichever ships first.

---

## 7. Scope and timeline

Honest estimate, single-developer, parallel-with-other-work:

- **Decisions** (§6): half-day to lock in.
- **Two-path unification** (§6.2): 2-3 days, mostly tests.
- **Commit A** (replica library + migration + fixture tests): 3-5 days.
- **Commit B** (boot wiring): half-day.
- **Commit C** (shadow-write): 1-2 days, mostly equivalence tests.
- **Commit D** (shadow-read + divergence logging): 1-2 days.
- **Validation window**: gated on §6.6 criteria (likely 1-2 weeks
  elapsed at this user's traffic).
- **Commit E** (cutover): half-day.
- **Commit F** (cleanup, applyMode flip): half-day.

**Total**: ~8-13 days of focused dev work plus the validation window.
This is roughly 2× a v5 phase commit.

The replica is the load-bearing remaining piece. After it lands:
- v5 invariants 1, 2, 6 hold.
- `spaces-sync-manager.js` retires.
- Pull engine `applyMode` flips to `sqlite`.
- Phase 5 migration tooling becomes meaningful (because the first real
  schema bump — SQLite tables — has shipped).
- Phase 0 auth becomes the next architectural priority (Path B device
  rebind for disk-failure recovery).

---

## 8. Verifiable outputs of this document

The document is "complete" when:

- [x] Two-path discovery surfaced and resolved (recommendation: unify
  before cutover, §6.2).
- [x] Query surface enumerated against production callers (§2).
- [x] SQLite schema specified to mirror DuckDB + JSON-index merge,
  with v5-specific additions (§3).
- [x] Cold-device migration path specified (§4).
- [x] Cutover phasing with feature flags + rollback story (§5).
- [x] Open questions named with recommendations (§6).
- [x] Test surface bounded (§5.4).
- [x] Scope estimate (§7).

The document is **not** the implementation. It's the contract the
implementation has to satisfy and the decision boundary for what's
in vs. out. The next step is the §6 decisions, then commit A.
