// ============================================================================
// Seed: "UXMag articles Feb" Space
// ============================================================================
//
// Idempotent. Re-running this file overwrites the demo nodes without
// creating duplicates -- every CREATE is a MERGE, every property write
// is SET. Safe to paste into Neon Browser, run via cypher-shell, or
// invoke through Lite's neon bridge from a dev console.
//
// How to run:
//   1. Neon Browser  : paste each `// section` block + the parameters
//                      manually. The whole file at once might exceed
//                      the browser query limit; break at the `:dotted`
//                      separators if needed.
//   2. cypher-shell  : cypher-shell -a <bolt-url> -u <user> -p <pw> \
//                          -f lite/spaces/seed-uxmag-articles-feb.cypher
//   3. Lite renderer : open Spaces, click any item, open DevTools
//                      console, paste:
//
//        await window.lite.neon.query(`<this whole file as a string>`)
//
//      That runs through the same Cypher executor the Spaces module
//      uses, so cookies / auth / Edison endpoint behave identically.
//
// To remove afterward: see seed-uxmag-articles-feb-cleanup.cypher (a
// companion file with the matching DETACH DELETE statements).
//
// Source of truth for the data shape: lite/spaces/USE-CASE-UXMAG.md.
// ============================================================================


// --- 1. The Space ------------------------------------------------------------

MERGE (s:Space {id: 'space-uxmag-feb'})
SET   s.name        = 'UXMag articles Feb',
      s.description = 'Articles, transcripts, and visuals collected from UXMag in February.',
      s.color       = '#7bdbff',
      s.iconKey     = 'book-open',
      s.createdAt   = coalesce(s.createdAt, datetime('2026-02-01T00:00:00Z')),
      s.updatedAt   = datetime('2026-02-28T18:42:00Z'),
      s.deletedAt   = null;


// --- 2. People (authors) -----------------------------------------------------

MERGE (rebecca:Person {id: 'person-rebecca-wilson'})
SET   rebecca.name  = 'Rebecca Wilson',
      rebecca.email = 'rebecca@example.com';

MERGE (jonas:Person {id: 'person-jonas-downey'})
SET   jonas.name    = 'Jonas Downey',
      jonas.email   = 'jonas@example.com';

MERGE (erika:Person {id: 'person-erika-hall'})
SET   erika.name    = 'Erika Hall',
      erika.email   = 'erika@example.com';

MERGE (alex:Person {id: 'person-alex-petrov'})
SET   alex.name     = 'Alex Petrov',
      alex.email    = 'alex@example.com';


// --- 3. Assets ---------------------------------------------------------------

// 3a. Transcript (kind: text). Inline content body, attribution.
//
// Note: Cypher single-quoted strings escape with backslash, NOT
// SQL-style doubled apostrophes. We use curly typographic apostrophes
// (’) here so there's nothing to escape and the multi-line string
// concat with `+` survives a round-trip through any HTTP / JSON layer.
MERGE (a:Asset {id: 'asset-uxmag-feb-interview-erika-hall'})
SET   a.type      = 'text',
      a.name      = 'Interview with Erika Hall',
      a.excerpt   = 'Erika Hall on why design research stays grounded in real people.',
      a.content   =
        '# Conversation\n\n' +
        '**Rebecca:** Erika, thanks for sitting down with us. Let’s start with research.\n\n' +
        '**Erika:** Designers have always been most useful when we’re close to the people we serve. ' +
        'The trap is treating research as a phase rather than a practice.\n\n' +
        '**Rebecca:** What changes in 2026?\n\n' +
        '**Erika:** The tools change. The fundamentals don’t. If you can’t describe ' +
        'who your user is in one breath, no AI is going to save you.\n',
      a.createdAt = coalesce(a.createdAt, datetime('2026-02-04T10:30:00Z')),
      a.updatedAt = datetime('2026-02-04T10:30:00Z'),
      a.deletedAt = null;


// 3b. Cover image (kind: image). FileKey is a real public image URL
// so the renderer's `<img>` preview actually shows content. (The
// previous `s3://uxmag-assets/...` placeholders were unreachable.)
MERGE (b:Asset {id: 'asset-uxmag-feb-cover-accessibility'})
SET   b.type      = 'image',
      b.name      = 'Cover art — accessibility issue',
      b.excerpt   = 'February cover: a typographic treatment on accessibility.',
      b.url       = 'https://picsum.photos/seed/uxmag-feb-cover/1200/630',
      b.mimeType  = 'image/jpeg',
      b.size      = 142183,
      b.createdAt = coalesce(b.createdAt, datetime('2026-02-06T09:00:00Z')),
      b.updatedAt = datetime('2026-02-06T09:00:00Z'),
      b.deletedAt = null;


// 3c. Diagram (kind: image + structured metadata bag).
MERGE (c:Asset {id: 'asset-uxmag-feb-diagram-ia-home'})
SET   c.type      = 'image',
      c.name      = 'IA diagram — new home',
      c.excerpt   = 'Information architecture for the redesigned UXMag home view.',
      c.url       = 'https://picsum.photos/seed/uxmag-feb-ia-diagram/1024/768',
      c.mimeType  = 'image/jpeg',
      c.metadata  = '{"diagramType":"information-architecture","revision":3,"softwareUsed":"Whimsical"}',
      c.createdAt = coalesce(c.createdAt, datetime('2026-02-12T14:20:00Z')),
      c.updatedAt = datetime('2026-02-15T16:01:00Z'),
      c.deletedAt = null;


// 3d. Link (kind: url). External sourceUrl.
MERGE (d:Asset {id: 'asset-uxmag-feb-link-trends-2026'})
SET   d.type      = 'url',
      d.name      = 'UX trends 2026 — roundup',
      d.excerpt   = 'Survey of 412 designers on the year ahead.',
      d.sourceUrl = 'https://uxmag.com/articles/ux-trends-2026',
      d.createdAt = coalesce(d.createdAt, datetime('2026-02-18T11:45:00Z')),
      d.updatedAt = datetime('2026-02-18T11:45:00Z'),
      d.deletedAt = null;


// 3e. Document (kind: document). PDF with a real, dereferenceable URL
// (Mozilla pdf.js sample) so the renderer's `<embed type=application/
// pdf>` actually loads content. The previous `s3://uxmag-assets/...`
// placeholder was unreachable; replaced with a stable public PDF that
// CORS allows for demo purposes.
MERGE (e:Asset {id: 'asset-uxmag-feb-design-guide'})
SET   e.type      = 'document',
      e.name      = 'Design guide — Feb edition',
      e.excerpt   = 'Editorial style guide and component library reference, February 2026.',
      e.url       = 'https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf',
      e.mimeType  = 'application/pdf',
      e.size      = 1016315,
      e.createdAt = coalesce(e.createdAt, datetime('2026-02-22T13:10:00Z')),
      e.updatedAt = datetime('2026-02-22T13:10:00Z'),
      e.deletedAt = null;


// --- 4. Edges ----------------------------------------------------------------

// 4a. Asset --[:BELONGS_TO]--> Space
MATCH (s:Space {id: 'space-uxmag-feb'})
MATCH (a:Asset)
WHERE a.id IN [
  'asset-uxmag-feb-interview-erika-hall',
  'asset-uxmag-feb-cover-accessibility',
  'asset-uxmag-feb-diagram-ia-home',
  'asset-uxmag-feb-link-trends-2026',
  'asset-uxmag-feb-design-guide'
]
MERGE (a)-[:BELONGS_TO]->(s);


// 4b. Person --[:CREATED]--> Asset
//     Rebecca authored the interview transcript.
//     Jonas authored the cover and the diagram.
//     Alex curated the trends roundup link.
//     The design-guide PDF was assembled by Rebecca.
MATCH (rebecca:Person {id: 'person-rebecca-wilson'})
MATCH (a:Asset      {id: 'asset-uxmag-feb-interview-erika-hall'})
MERGE (rebecca)-[:CREATED]->(a);

MATCH (jonas:Person {id: 'person-jonas-downey'})
MATCH (a:Asset      {id: 'asset-uxmag-feb-cover-accessibility'})
MERGE (jonas)-[:CREATED]->(a);

MATCH (jonas:Person {id: 'person-jonas-downey'})
MATCH (a:Asset      {id: 'asset-uxmag-feb-diagram-ia-home'})
MERGE (jonas)-[:CREATED]->(a);

MATCH (alex:Person  {id: 'person-alex-petrov'})
MATCH (a:Asset      {id: 'asset-uxmag-feb-link-trends-2026'})
MERGE (alex)-[:CREATED]->(a);

MATCH (rebecca:Person {id: 'person-rebecca-wilson'})
MATCH (a:Asset      {id: 'asset-uxmag-feb-design-guide'})
MERGE (rebecca)-[:CREATED]->(a);


// --- 5. Verify ---------------------------------------------------------------

// Run this last to confirm the round-trip: should return 5 rows, one
// per asset, with title + kind + author name + Space name set.
MATCH (a:Asset)-[:BELONGS_TO]->(s:Space {id: 'space-uxmag-feb'})
OPTIONAL MATCH (p:Person)-[:CREATED]->(a)
RETURN s.name       AS spaceName,
       a.name       AS title,
       a.type       AS kind,
       p.name       AS author,
       a.createdAt  AS createdAt
ORDER BY a.createdAt ASC;
