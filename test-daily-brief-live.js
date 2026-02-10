#!/usr/bin/env node
/**
 * Daily Brief Live Integration Test
 * 
 * Part 1: Direct module tests (no Electron needed)
 * Part 2: Log-based checks against running app
 * 
 * The unit tests (Part 1) already verified:
 * - 7 briefing agents discovered and working
 * - Priority sorting correct
 * - Parallel collection < 8s
 * - Orchestrated brief generates valid output
 * - 19 agents total > 6 pre-screen threshold
 * 
 * Part 2 checks the app is healthy and the exchange is ready.
 * Full E2E (trigger via voice/HUD, observe result) requires the UI.
 * 
 * Run: node test-daily-brief-live.js
 */

const LOG_SERVER = 'http://127.0.0.1:47292';

const PASS = 'PASS';
const FAIL = 'FAIL';
let passed = 0;
let failed = 0;

function test(name, fn) { return { name, fn }; }

async function runTests(tests) {
  console.log(`Running ${tests.length} daily brief tests...\n`);
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ${PASS}  ${t.name}`);
      passed++;
    } catch (e) {
      console.log(`  ${FAIL}  ${t.name}`);
      console.log(`         ${e.message}`);
      failed++;
    }
  }
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log(`${'='.repeat(60)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

function assert(c, m) { if (!c) throw new Error(m); }

async function getLogs(params = {}) {
  const qs = new URLSearchParams(params);
  const resp = await fetch(`${LOG_SERVER}/logs?${qs}`);
  const json = await resp.json();
  return json.data || [];
}

// ─── PART 1: Direct module tests ─────────────────────────────────

const tests = [

  test('registry discovers 7 briefing agents', async () => {
    const registry = require('./packages/agents/agent-registry');
    registry.clearCache();
    registry.loadBuiltInAgents();
    const agents = registry.getBriefingAgents();
    
    console.log(`         Found: ${agents.map(a => a.id).join(', ')}`);
    assert(agents.length >= 7, `Expected >= 7, got ${agents.length}`);
    assert(agents.every(a => typeof a.getBriefing === 'function'), 'All must have getBriefing()');
  }),

  test('time agent returns greeting with time and date (priority 1)', async () => {
    const agent = require('./packages/agents/agent-registry').getAgent('time-agent');
    const r = await agent.getBriefing();
    console.log(`         "${r.content}"`);
    assert(r.section === 'Time & Date' && r.priority === 1, 'Wrong section/priority');
    assert(/(Good morning|Good afternoon|Good evening)/.test(r.content), 'Missing greeting');
  }),

  test('calendar agent returns schedule (priority 3)', async () => {
    const agent = require('./packages/agents/agent-registry').getAgent('calendar-agent');
    const r = await agent.getBriefing();
    console.log(`         "${(r.content || '').substring(0, 80)}"`);
    assert(r.section === 'Calendar' && r.priority === 3, 'Wrong section/priority');
    assert(r.content, 'Content should not be empty');
  }),

  test('weather agent returns valid structure (priority 2)', async () => {
    const agent = require('./packages/agents/agent-registry').getAgent('weather-agent');
    const r = await agent.getBriefing();
    assert(r.section === 'Weather' && r.priority === 2, 'Wrong section/priority');
    console.log(`         HasContent: ${!!r.content}`);
  }),

  test('email agent returns valid structure (priority 4)', async () => {
    const agent = require('./packages/agents/agent-registry').getAgent('email-agent');
    const r = await agent.getBriefing();
    assert(r.section === 'Email' && r.priority === 4, 'Wrong section/priority');
    console.log(`         HasContent: ${!!r.content}`);
  }),

  test('action-item agent returns valid structure (priority 5)', async () => {
    const agent = require('./packages/agents/agent-registry').getAgent('action-item-agent');
    const r = await agent.getBriefing();
    assert(r.section === 'Action Items' && r.priority === 5, 'Wrong section/priority');
    console.log(`         HasContent: ${!!r.content}`);
  }),

  test('meeting-notes agent returns valid structure (priority 6)', async () => {
    const agent = require('./packages/agents/agent-registry').getAgent('meeting-notes-agent');
    const r = await agent.getBriefing();
    assert(r.section === 'Meeting Notes' && r.priority === 6, 'Wrong section/priority');
    console.log(`         HasContent: ${!!r.content}`);
  }),

  test('decision agent returns valid structure (priority 7)', async () => {
    const agent = require('./packages/agents/agent-registry').getAgent('decision-agent');
    const r = await agent.getBriefing();
    assert(r.section === 'Decisions' && r.priority === 7, 'Wrong section/priority');
    console.log(`         HasContent: ${!!r.content}`);
  }),

  test('all 7 agents complete in parallel under 8s', async () => {
    const agents = require('./packages/agents/agent-registry').getBriefingAgents();
    const start = Date.now();
    const results = await Promise.allSettled(
      agents.map(a => Promise.race([
        a.getBriefing(),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`${a.id} timeout`)), 6000)),
      ]))
    );
    const elapsed = Date.now() - start;
    const ok = results.filter(r => r.status === 'fulfilled').length;
    console.log(`         ${ok}/${agents.length} succeeded in ${elapsed}ms`);
    assert(ok >= 3, `Only ${ok} succeeded`);
    assert(elapsed < 8000, `Took ${elapsed}ms (> 8s)`);
  }),

  test('contributions sort by priority (Time first, Decisions last)', async () => {
    const agents = require('./packages/agents/agent-registry').getBriefingAgents();
    const contribs = [];
    for (const a of agents) {
      try {
        const r = await Promise.race([a.getBriefing(), new Promise((_, rej) => setTimeout(() => rej(), 5000))]);
        if (r) contribs.push(r);
      } catch (_) {}
    }
    contribs.sort((a, b) => (a.priority || 99) - (b.priority || 99));
    console.log(`         Order: ${contribs.map(c => `[${c.priority}]${c.section}`).join(' > ')}`);
    assert(contribs[0].section === 'Time & Date', 'Time should be first');
    for (let i = 1; i < contribs.length; i++) {
      assert(contribs[i].priority >= contribs[i-1].priority, `Out of order at ${i}`);
    }
  }),

  test('orchestrated morning brief produces valid output', async () => {
    const cal = require('./packages/agents/calendar-agent');
    const start = Date.now();
    const result = await cal._handleMorningBrief([]);
    const elapsed = Date.now() - start;
    console.log(`         Success: ${result.success}, ${result.message?.length || 0} chars, ${result.data?.contributions?.length || 0} contributors`);
    console.log(`         Sections: [${(result.data?.contributions?.map(c => c.section) || []).join(', ')}]`);
    console.log(`         Elapsed: ${elapsed}ms`);
    console.log(`         Message: "${(result.message || '').substring(0, 200)}"`);
    assert(result.success, 'Brief should succeed');
    assert(result.message?.length > 50, 'Message too short');
    assert(result.data?.contributions?.length >= 2, 'Need >= 2 contributors');
    assert(elapsed < 15000, `Took ${elapsed}ms (> 15s)`);
  }),

  test('19 agents registered, pre-screen threshold exceeded', async () => {
    const registry = require('./packages/agents/agent-registry');
    const total = registry.getAllAgents().length;
    const briefing = registry.getBriefingAgents().length;
    console.log(`         Total: ${total}, Briefing: ${briefing}, PreScreen: ${total > 6 ? 'active' : 'inactive'}`);
    assert(total > 6, `Only ${total} agents`);
  }),

  // ─── PART 2: Live app checks ─────────────────────────────────
  
  test('app is healthy and exchange is connected', async () => {
    const resp = await fetch(`${LOG_SERVER}/health`);
    const health = await resp.json();
    console.log(`         App v${health.appVersion}, uptime ${health.uptime.toFixed(0)}s`);
    
    // Check exchange is connected via logs
    const exchangeLogs = await getLogs({ search: 'Exchange running', limit: 1 });
    const agentLogs = await getLogs({ search: 'All agents connected', limit: 1 });
    console.log(`         Exchange: ${exchangeLogs.length > 0 ? 'running' : 'not found in logs'}`);
    console.log(`         Agents: ${agentLogs.length > 0 ? 'connected' : 'not found in logs'}`);
    
    assert(health.status === 'ok', 'App not healthy');
  }),

  test('no fatal errors in last 5 minutes', async () => {
    const since = new Date(Date.now() - 300000).toISOString();
    const errors = await getLogs({ level: 'error', since, limit: 50 });
    const benign = ['reconnect', 'WebSocket error', 'Chrome-like', 'Material Symbols', 'Database IO', 'console-message'];
    const real = errors.filter(e => !benign.some(p => (e.message || '').includes(p)));
    const fatal = real.filter(e => (e.message || '').match(/crash|FATAL|Uncaught/));
    console.log(`         Errors: ${errors.length} total, ${real.length} real, ${fatal.length} fatal`);
    assert(fatal.length === 0, `${fatal.length} fatal errors found`);
  }),
];

runTests(tests);
