# Use case: "UXMag articles Feb"

A canonical real-world Space to test against. When the renderer shapes
its UI around the random hash-named assets currently in the dev graph,
it ends up looking weird. This document captures the shape of a real
Space + its contents so we can sanity-check rendering, and so the data
producers know what fields the renderer actually consumes.

## The Space

```cypher
CREATE (s:Space {
  id: 'space-uxmag-feb',
  name: 'UXMag articles Feb',
  description: 'Articles, transcripts, and visuals collected from UXMag in February.',
  color: '#7bdbff',
  iconKey: 'book-open',
  createdAt: datetime('2026-02-01T00:00:00Z'),
  updatedAt: datetime('2026-02-28T18:42:00Z')
})
```

What renders:
- Sidebar row: blue dot (from `color`), label "UXMag articles Feb".
- Home timeline events tagged `in [UXMag articles Feb]` chip.

## The five asset kinds, end-to-end

Each asset entry below lists the Cypher that creates it, then the
renderer surfaces that show it. The renderer's content cascade is:

1. `:Asset.content` non-empty → inline text/markdown preview
2. `:Asset.url` / `.fileUrl` non-empty → binary file preview (image,
   audio, video) via the Files module's signed-URL resolver
3. `:Asset.sourceUrl` non-empty → external "Source" link block
4. None of the above → friendly empty-content hint naming what's missing

### 1. Transcript (kind: text)

```cypher
CREATE (a:Asset {
  id: 'asset-uxmag-feb-interview-01',
  type: 'text',
  name: 'Interview with Erika Hall',
  content: '# Conversation\n\nErika: Designers have always...',
  excerpt: 'Erika Hall on why design research stays grounded in...',
  createdAt: datetime('2026-02-04T10:30:00Z'),
  updatedAt: datetime('2026-02-04T10:30:00Z')
})
CREATE (a)-[:BELONGS_TO]->(:Space {id: 'space-uxmag-feb'})
CREATE (:Person {id: 'person-rebecca', name: 'Rebecca Wilson'})-[:CREATED]->(a)
```

Renderer behavior:
- **Card title**: "Interview with Erika Hall" (real title, passes through).
- **Card excerpt**: "Erika Hall on why design research stays grounded in..."
- **Detail rail**: title + meta + Markdown-rendered content body.
- **Attribution chip**: "Created by Rebecca Wilson · 14d ago".

### 2. Image (kind: image)

```cypher
CREATE (a:Asset {
  id: 'asset-uxmag-feb-image-01',
  type: 'image',
  name: 'Cover art — accessibility issue',
  url: 's3://uxmag-assets/2026-02/cover-accessibility.png',
  mimeType: 'image/png',
  size: 482183,
  createdAt: datetime('2026-02-06T09:00:00Z'),
  updatedAt: datetime('2026-02-06T09:00:00Z')
})
CREATE (a)-[:BELONGS_TO]->(:Space {id: 'space-uxmag-feb'})
```

Renderer behavior:
- **Card title**: "Cover art — accessibility issue".
- **Detail rail**: title + meta + inline `<img>` preview (signed URL
  resolved in background via `bridge.items.resolveFileUrl`).
- If a producer wrote `url` but no `name`, the renderer falls back to
  a generated title: e.g. "cover-accessibility · uxmag-assets" derived
  from the path segment + bucket.

### 3. Diagram (also kind: image, with metadata)

```cypher
CREATE (a:Asset {
  id: 'asset-uxmag-feb-diagram-01',
  type: 'image',
  name: 'IA diagram — new home',
  url: 's3://uxmag-assets/2026-02/ia-diagram-home.svg',
  mimeType: 'image/svg+xml',
  metadata: {
    diagramType: 'information-architecture',
    revision: 3,
    softwareUsed: 'Whimsical'
  },
  createdAt: datetime('2026-02-12T14:20:00Z'),
  updatedAt: datetime('2026-02-15T16:01:00Z')
})
```

Renderer behavior:
- Same as image, plus the **Metadata** table renders the bag verbatim:
  ```
  diagramType:    "information-architecture"
  revision:       3
  softwareUsed:   "Whimsical"
  ```
- This is why `metadata: {...}` matters — it's the per-kind sidecar.

### 4. Link (kind: url)

```cypher
CREATE (a:Asset {
  id: 'asset-uxmag-feb-link-01',
  type: 'url',
  name: 'UX trends 2026 — roundup',
  sourceUrl: 'https://uxmag.com/articles/ux-trends-2026',
  excerpt: 'Survey of 412 designers on the year ahead.',
  createdAt: datetime('2026-02-18T11:45:00Z'),
  updatedAt: datetime('2026-02-18T11:45:00Z')
})
```

Renderer behavior:
- **Card title**: "UX trends 2026 — roundup".
- **Detail rail**: title + meta + "Source" block with the URL as a
  clickable `target="_blank"` link.

### 5. Author (kind: separate `:Person` node, NOT an `:Asset`)

Authors live on their own nodes and connect to assets via `:CREATED`:

```cypher
CREATE (rebecca:Person {
  id: 'person-rebecca',
  name: 'Rebecca Wilson',
  email: 'rebecca@example.com'
})
CREATE (erika:Person {
  id: 'person-erika',
  name: 'Erika Hall'
})
CREATE (jonas:Person {
  id: 'person-jonas',
  name: 'Jonas Downey'
})
```

Then attach them to assets:

```cypher
MATCH (a:Asset {id: 'asset-uxmag-feb-interview-01'})
MATCH (p:Person {id: 'person-rebecca'})
CREATE (p)-[:CREATED]->(a)

MATCH (a:Asset {id: 'asset-uxmag-feb-image-01'})
MATCH (p:Person {id: 'person-jonas'})
CREATE (p)-[:CREATED]->(a)
```

Renderer behavior:
- The `producedBy` projection (`(:Person)-[:CREATED]->(:Asset)`) renders
  as an **attribution chip** at the top of the detail rail:
  *"Created by Rebecca Wilson · 14d ago"*.
- In the Home timeline, the row says *"Rebecca Wilson added Interview
  with Erika Hall"* instead of *"Someone added 5b4375…"*.

## Round-trip checklist

After loading the above into Neon, you should see in Lite:

- [x] Sidebar: "UXMag articles Feb" with a teal-blue dot.
- [x] Click into the Space: 4 item cards (interview, cover image, IA
      diagram, trends link). Each card shows a real title.
- [x] Click the interview card: detail rail shows the transcript
      rendered as Markdown, attribution "Created by Rebecca Wilson".
- [x] Click the IA diagram card: detail rail shows the SVG inline AND
      the metadata table with diagramType / revision / softwareUsed.
- [x] Click the trends-link card: detail rail shows a Source block
      linking to uxmag.com.
- [x] Home timeline: rows read as `<Person> added <title> in UXMag
      articles Feb · <recency>`.

## What "no content" looks like (and how the renderer handles it)

When an asset is missing all four (content / fileKey / sourceUrl /
type-block) — common for partial imports or in-flight uploads — the
detail rail shows the **empty-content hint** (added in this pass):

> No image attached.
> When an image fileKey is set (graph property `:Asset.url`), a preview appears here.

Hint copy is keyed to the asset's `type`. This keeps the click feeling
*responsive* even when the underlying data is sparse, and tells a
data-producer reading the screen exactly which property they need to
populate.

## What does NOT shape the UI

The renderer is deliberately defensive about quirky graph data:

- **Hash-shaped names** (e.g. `5b4375227558…`) collapse to a generated
  title like `Image · 5b4375` via `generateItemTitle`. They never reach
  the user as raw hex.
- **UUID-shaped Space names** collapse to `Unnamed space` via
  `friendlySpaceName`. The user never sees a 32-char hex chip.
- **Missing `:Commit.author`** collapses to `Someone` via
  `prettyAuthor`; device-shaped authors (`device_mac.lan_*`) collapse
  to `Local device`.
- **Missing content of any kind** triggers the empty-content hint
  instead of an invisible gap.

So if the dev graph happens to contain "50/50 Risk Analyst" or
"Accountability Guardian" as agent names — that's just real data and
the renderer surfaces it as-is. The UI should be shaped by the
canonical schema, not by whatever oddities a specific dataset contains.

## Helper for tests + dev seeding

Two runnable Cypher files sit next to this doc:

- [`seed-uxmag-articles-feb.cypher`](./seed-uxmag-articles-feb.cypher) — idempotent `MERGE`-based seed that
  creates the Space, the five assets, the four `:Person` author nodes,
  and all `[:BELONGS_TO]` + `[:CREATED]` edges. Ends with a verify
  query that should return 5 rows.
- [`seed-uxmag-articles-feb-cleanup.cypher`](./seed-uxmag-articles-feb-cleanup.cypher) — `DETACH DELETE` companion
  that removes everything the seed created. Verifies with a final
  match that should return zero rows.

How to run:

1. **Neon Browser** — paste each section block at a time.
2. **cypher-shell** — `cypher-shell -a <bolt-url> -u <user> -p <pw> -f
   lite/spaces/seed-uxmag-articles-feb.cypher`.
3. **Lite DevTools console** — easiest if Lite is already connected to
   your Neon endpoint:
   ```js
   const cypher = await (await fetch(
     'file://' + window.location.pathname.replace(/[^/]*$/, '') +
     '../../spaces/seed-uxmag-articles-feb.cypher'
   )).text();
   await window.lite.neon.query(cypher);
   ```
   Or just paste the file's contents into the console as a template
   literal directly.

A typed fixture builder (`lite/test/fixtures/uxmag-articles-feb.ts`)
is a still-open follow-up — it would lift this data into TS for
integration tests that exercise the full renderer against a real
shaped graph. The two Cypher files above are the dev-seed equivalent.
