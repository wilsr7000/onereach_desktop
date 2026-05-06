import neo4j from 'neo4j-driver';

const driver = neo4j.driver(
  'neo4j+s://40c812ef.databases.neo4j.io',
  neo4j.auth.basic('neo4j', 'oCLF5bxkj66qivVDh1biePK7Byo9U1NUvFLJrHnQjzo'),
  { connectionTimeout: 15000 }
);

async function run(cypher, params = {}) {
  const session = driver.session({ database: 'neo4j' });
  try {
    const result = await session.run(cypher, params);
    return result.records.map(r => r.toObject());
  } finally { await session.close(); }
}

const j = (o) => JSON.stringify(o, (_, v) => (v && typeof v === 'object' && 'low' in v && 'high' in v) ? v.low : v, 2);

try {
  console.log('=== Total Agents + alive vs deleted ===');
  console.log(j(await run('MATCH (n:Agent) RETURN count(*) AS total, sum(CASE WHEN n.deleted = true THEN 1 ELSE 0 END) AS deleted, sum(CASE WHEN coalesce(n.deleted, false) = false THEN 1 ELSE 0 END) AS alive')));

  console.log('\n=== By created_by_app_name ===');
  console.log(j(await run('MATCH (n:Agent) RETURN n.created_by_app_name AS source, count(*) AS count ORDER BY count DESC')));

  console.log('\n=== By agentType ===');
  console.log(j(await run('MATCH (n:Agent) RETURN n.agentType AS agentType, count(*) AS count ORDER BY count DESC LIMIT 20')));

  console.log('\n=== By type ===');
  console.log(j(await run('MATCH (n:Agent) RETURN n.type AS type, count(*) AS count ORDER BY count DESC LIMIT 20')));

  console.log('\n=== By menuCategory ===');
  console.log(j(await run('MATCH (n:Agent) RETURN n.menuCategory AS menuCategory, count(*) AS count ORDER BY count DESC LIMIT 20')));

  console.log('\n=== By isSystem ===');
  console.log(j(await run('MATCH (n:Agent) RETURN n.isSystem AS isSystem, count(*) AS count ORDER BY count DESC')));

  console.log('\n=== Distinct names + how many copies of each (top 30) ===');
  console.log(j(await run('MATCH (n:Agent) WHERE coalesce(n.deleted, false) = false RETURN n.name AS name, count(*) AS copies ORDER BY copies DESC LIMIT 30')));

  console.log('\n=== Distinct names total (how many unique agents are there really?) ===');
  console.log(j(await run('MATCH (n:Agent) RETURN count(DISTINCT n.name) AS distinctNames, count(DISTINCT n.id) AS distinctIds, count(*) AS total')));

  console.log('\n=== Created over time (top 10 created_at buckets) ===');
  console.log(j(await run("MATCH (n:Agent) WITH n.created_by_app_name AS app, count(*) AS c, min(toInteger(n.created_at)) AS minTs, max(toInteger(n.created_at)) AS maxTs RETURN app, c, datetime({epochMillis: minTs}) AS firstSeen, datetime({epochMillis: maxTs}) AS lastSeen ORDER BY c DESC")));

  console.log('\n=== Sample 3 alive Agents from the largest creator ===');
  console.log(j(await run('MATCH (n:Agent) WHERE coalesce(n.deleted, false) = false RETURN n.name AS name, n.id AS id, n.agentType AS agentType, n.type AS type, n.menuCategory AS menuCategory, n.created_by_app_name AS source LIMIT 5')));

  console.log('\n=== Are there relationships from Agents to anything? ===');
  console.log(j(await run('MATCH (n:Agent)-[r]->() RETURN type(r) AS relType, count(*) AS count ORDER BY count DESC LIMIT 10')));
  console.log('--- incoming ---');
  console.log(j(await run('MATCH (n:Agent)<-[r]-() RETURN type(r) AS relType, count(*) AS count ORDER BY count DESC LIMIT 10')));
} catch (err) {
  console.error('FAIL:', err.message);
  process.exit(1);
} finally { await driver.close(); }
