// ============================================================================
// Cleanup: remove the "UXMag articles Feb" demo seed
// ============================================================================
//
// Companion to seed-uxmag-articles-feb.cypher. Removes the Space, all
// its assets, and the People that authored them. Run from the same
// surface you used to seed (Neon Browser / cypher-shell /
// `window.lite.neon.query(...)` in a Lite DevTools console).
//
// Safe to re-run -- nothing fails if the nodes have already been
// removed. The matching `id` prefixes (`space-uxmag-feb`,
// `asset-uxmag-feb-*`, `person-*`) are unique to the seed so this
// will not touch unrelated data.
// ============================================================================


// --- 1. Asset --[:CREATED]-- + --[:BELONGS_TO]-- edges + nodes ---------------

// DETACH DELETE drops the node together with every incident edge.
MATCH (a:Asset)
WHERE a.id IN [
  'asset-uxmag-feb-interview-erika-hall',
  'asset-uxmag-feb-cover-accessibility',
  'asset-uxmag-feb-diagram-ia-home',
  'asset-uxmag-feb-link-trends-2026',
  'asset-uxmag-feb-design-guide'
]
DETACH DELETE a;


// --- 2. Space ----------------------------------------------------------------

MATCH (s:Space {id: 'space-uxmag-feb'})
DETACH DELETE s;


// --- 3. People (only those exclusively created for the seed) ----------------

// We intentionally DETACH DELETE these even if they have edges to
// other graph elements -- the seed Persons use unique ids
// (`person-rebecca-wilson`, etc.) chosen to avoid collision with
// real account members. If you've connected them to real :Asset
// nodes outside the seed, comment out this section and remove them
// manually.

MATCH (p:Person)
WHERE p.id IN [
  'person-rebecca-wilson',
  'person-jonas-downey',
  'person-erika-hall',
  'person-alex-petrov'
]
DETACH DELETE p;


// --- 4. Verify ---------------------------------------------------------------

// Should return zero rows.
MATCH (n)
WHERE n.id STARTS WITH 'asset-uxmag-feb-'
   OR n.id STARTS WITH 'person-rebecca-wilson'
   OR n.id STARTS WITH 'person-jonas-downey'
   OR n.id STARTS WITH 'person-erika-hall'
   OR n.id STARTS WITH 'person-alex-petrov'
   OR n.id = 'space-uxmag-feb'
RETURN n;
