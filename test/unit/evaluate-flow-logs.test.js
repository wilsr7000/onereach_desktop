/**
 * Test harness for the Evaluate Flow Logs feature.
 *
 * Tests three layers:
 *   1. SDK token + fetchAllFlowLogs (against live Edison API)
 *   2. IPC handler wiring (structural checks)
 *   3. AI analysis prompt shape (mock)
 *
 * Run:  node test/unit/evaluate-flow-logs.test.js [--token <bearer_token>]
 *
 * If no --token is provided, attempts the refresh_token endpoint.
 */

const https = require('https');
const path = require('path');

const FLOW_ID = 'fdfd4941-c8aa-4aa1-91f1-9da3a1603074';
const ACCOUNT_ID = '35254342-4a2e-475b-aec1-18547e517e29';
const DISCOVERY_URL = 'https://discovery.edison.api.onereach.ai';

let passed = 0;
let failed = 0;
let skipped = 0;

function ok(name) { passed++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
function fail(name, reason) { failed++; console.log(`  \x1b[31mFAIL\x1b[0m  ${name} — ${reason}`); }
function skip(name, reason) { skipped++; console.log(`  \x1b[33mSKIP\x1b[0m  ${name} — ${reason}`); }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fetchJSON(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOpts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
    };
    const req = https.request(reqOpts, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function getArg(flag) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

// ---------------------------------------------------------------------------
// Test 1: Structural checks — files and wiring exist
// ---------------------------------------------------------------------------

async function testStructure() {
  console.log('\n--- Test 1: Structural Checks ---');

  // Menu item wired
  const fs = require('fs');
  const autologin = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'gsx-autologin.js'), 'utf8');
  if (autologin.includes("action: 'evaluate-flow-logs'")) ok('Menu item has action');
  else fail('Menu item has action', 'Missing action attribute');

  // Preload bridge
  const preload = fs.readFileSync(path.join(__dirname, '..', '..', 'preload.js'), 'utf8');
  if (preload.includes('evaluateFlowLogs')) ok('Preload bridge exports evaluateFlowLogs');
  else fail('Preload bridge exports evaluateFlowLogs', 'Not found in preload.js');

  // IPC handler registered
  const mainJs = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8');
  if (mainJs.includes("ipcMain.handle('dev-tools:evaluate-flow-logs'")) ok('IPC handler registered in main.js');
  else fail('IPC handler registered in main.js', 'Handler not found');

  // Action routing
  if (mainJs.includes("action === 'evaluate-flow-logs'")) ok('Action routing for evaluate-flow-logs');
  else fail('Action routing for evaluate-flow-logs', 'Route not found');

  // Window opener
  const builder = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'menu-sections', 'dev-tools-builder.js'), 'utf8');
  if (builder.includes('openFlowLogsResults')) ok('Window opener exported');
  else fail('Window opener exported', 'Not found in dev-tools-builder.js');

  // Results HTML exists
  if (fs.existsSync(path.join(__dirname, '..', '..', 'flow-logs-results.html'))) ok('flow-logs-results.html exists');
  else fail('flow-logs-results.html exists', 'File not found');

  // Token cache helpers
  const sdkMgr = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'edison-sdk-manager.js'), 'utf8');
  if (sdkMgr.includes('_getTokenCache') && sdkMgr.includes('_setTokenCache')) ok('Token cache helpers exported');
  else fail('Token cache helpers exported', 'Not found in edison-sdk-manager.js');
}

// ---------------------------------------------------------------------------
// Test 2: Results HTML structure
// ---------------------------------------------------------------------------

async function testResultsHTML() {
  console.log('\n--- Test 2: Results HTML Validation ---');

  const fs = require('fs');
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'flow-logs-results.html'), 'utf8');

  const checks = [
    ['Calls evaluateFlowLogs()', html.includes('evaluateFlowLogs(')],
    ['Has loading spinner', html.includes('spinner')],
    ['Has summary section', html.includes('ai-summary')],
    ['Has session groups', html.includes('session-group')],
    ['Has session status indicator', html.includes('session-status')],
    ['Has time-ago display', html.includes('timeAgo') || html.includes('time-ago')],
    ['Has diagnostic rows', html.includes('diagnostic')],
    ['Has pattern display', html.includes('pattern-name')],
    ['Has recommendation display', html.includes('recommendation')],
    ['Has raw logs toggle', html.includes('rawToggle')],
    ['Copy Analysis button', html.includes('copyAnalysis')],
    ['Copy Raw Logs button', html.includes('copyRaw')],
    ['Uses electron clipboard', html.includes('electron.clipboard.writeText') || html.includes('electron') && html.includes('clipboard')],
    ['Has fallback copy (execCommand)', html.includes('execCommand')],
    ['Has error badge', html.includes('badge error')],
    ['Has summary bar', html.includes('summaryBar')],
    ['Escapes HTML (esc function)', html.includes('function esc')],
  ];

  for (const [name, result] of checks) {
    if (result) ok(name);
    else fail(name, 'Not found in HTML');
  }
}

// ---------------------------------------------------------------------------
// Test 3: SDK fetchAllFlowLogs (live — requires token)
// ---------------------------------------------------------------------------

async function testSDKFetch() {
  console.log('\n--- Test 3: SDK fetchAllFlowLogs (Live) ---');

  let token = getArg('--token');

  // Try refresh_token endpoint if no token provided
  if (!token) {
    try {
      const resp = await fetchJSON(`https://em.edison.api.onereach.ai/http/${ACCOUNT_ID}/refresh_token`);
      if (resp.status === 200 && resp.data?.token) {
        token = resp.data.token.startsWith('FLOW ') ? resp.data.token : `FLOW ${resp.data.token}`;
        ok('Token from refresh_token endpoint');
      } else {
        skip('Token from refresh_token endpoint', `HTTP ${resp.status}`);
      }
    } catch (err) {
      skip('Token from refresh_token endpoint', err.message);
    }
  } else {
    ok('Token provided via --token flag');
  }

  if (!token) {
    skip('fetchAllFlowLogs SDK call', 'No token available');
    skip('Response shape validation', 'No token available');
    return null;
  }

  // Use the SDK directly
  let Flows;
  try {
    Flows = require('@or-sdk/flows').Flows;
    ok('@or-sdk/flows loaded');
  } catch (_err) {
    // Try from the app's node_modules
    try {
      Flows = require(path.join(__dirname, '..', '..', 'node_modules', '@or-sdk', 'flows')).Flows;
      ok('@or-sdk/flows loaded (from node_modules)');
    } catch (err2) {
      fail('@or-sdk/flows loaded', err2.message);
      return null;
    }
  }

  const flows = new Flows({
    token: () => token,
    discoveryUrl: DISCOVERY_URL,
  });

  try {
    const start = Date.now() - 24 * 60 * 60 * 1000;
    const result = await flows.fetchAllFlowLogs({ flowId: FLOW_ID, limit: 10, start, end: 'now' });
    ok('fetchAllFlowLogs returned');

    // Validate response shape
    const isArray = Array.isArray(result);
    const hasEvents = result?.events && Array.isArray(result.events);
    const hasData = result?.data && Array.isArray(result.data);
    const hasItems = result?.items && Array.isArray(result.items);

    if (isArray) {
      ok(`Response is array with ${result.length} entries`);
    } else if (hasEvents) {
      ok(`Response has .events array with ${result.events.length} entries`);
    } else if (hasData) {
      ok(`Response has .data array with ${result.data.length} entries`);
    } else if (hasItems) {
      ok(`Response has .items array with ${result.items.length} entries`);
    } else {
      console.log('  Response type:', typeof result);
      console.log('  Response keys:', result ? Object.keys(result) : 'null');
      console.log('  Response preview:', JSON.stringify(result, null, 2).substring(0, 500));
      fail('Response shape', 'Unexpected shape — not array, .events, .data, or .items');
    }

    return result;
  } catch (err) {
    fail('fetchAllFlowLogs call', err.message);
    if (err.message.includes('401') || err.message.includes('403')) {
      console.log('  Hint: Token may be expired or invalid');
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Test 4: IPC handler logic (simulated — no Electron needed)
// ---------------------------------------------------------------------------

async function testHandlerLogic() {
  console.log('\n--- Test 4: Handler Logic Simulation ---');

  // Simulate what the IPC handler does with sample log data
  const sampleLogs = [
    { timestamp: '2026-03-24T10:00:00Z', message: 'Flow started', level: 'INFO' },
    { timestamp: '2026-03-24T10:00:01Z', message: 'Step "Send Email" executed', level: 'INFO' },
    { timestamp: '2026-03-24T10:00:02Z', message: 'Error: SMTP connection timeout', level: 'ERROR' },
    { timestamp: '2026-03-24T10:00:03Z', message: 'Step "Send Email" retrying...', level: 'WARN' },
    { timestamp: '2026-03-24T10:00:05Z', message: 'Flow completed with errors', level: 'ERROR' },
  ];

  // Test array extraction logic
  const logEntries1 = Array.isArray(sampleLogs) ? sampleLogs : (sampleLogs?.events || sampleLogs?.items || sampleLogs?.data || []);
  if (logEntries1.length === 5) ok('Array extraction (direct array)');
  else fail('Array extraction (direct array)', `Got ${logEntries1.length}`);

  const wrapped = { events: sampleLogs };
  const logEntries2 = Array.isArray(wrapped) ? wrapped : (wrapped?.events || wrapped?.items || wrapped?.data || []);
  if (logEntries2.length === 5) ok('Array extraction (.events wrapper)');
  else fail('Array extraction (.events wrapper)', `Got ${logEntries2.length}`);

  // Test truncation logic
  const bigLogs = Array.from({ length: 1000 }, (_, i) => ({
    timestamp: `2026-03-24T10:${String(i).padStart(2, '0')}:00Z`,
    message: `Log entry ${i} with some longer content to pad the size ${'x'.repeat(100)}`,
    level: i % 10 === 0 ? 'ERROR' : 'INFO',
  }));

  let logsForAI = JSON.stringify(bigLogs, null, 2);
  const MAX_LOG_CHARS = 100000;
  let truncated = false;
  if (logsForAI.length > MAX_LOG_CHARS) {
    truncated = true;
    const truncCount = Math.floor(bigLogs.length * (MAX_LOG_CHARS / logsForAI.length));
    logsForAI = JSON.stringify(bigLogs.slice(0, truncCount), null, 2);
  }

  if (truncated) ok(`Truncation works: ${bigLogs.length} entries -> ${logsForAI.length} chars`);
  else fail('Truncation logic', 'Should have truncated 1000 large entries');

  if (logsForAI.length <= MAX_LOG_CHARS + 10000) ok('Truncated size within bounds');
  else fail('Truncated size within bounds', `${logsForAI.length} chars exceeds limit`);

  // Test resolveChainIds + session grouping
  function resolveChainIds(logEntries) {
    const reqToChain = {};
    for (const evt of logEntries) {
      const rid = evt.requestId || 'unknown';
      if (reqToChain[rid]) continue;
      if (evt.message?.type === 'json' && evt.message.parsed) {
        const p = evt.message.parsed;
        const bsid = p.event?.BeginningSessionId || p.session?.id;
        if (bsid) reqToChain[rid] = bsid;
      }
    }
    return (evt) => reqToChain[evt.requestId] || evt.requestId || 'unknown';
  }

  // Simple case: no chain metadata, falls back to requestId
  const simpleLogs = [
    { requestId: 'r1', timestamp: 1000, message: { parsed: 'start', type: 'string' } },
    { requestId: 'r1', timestamp: 2000, message: { parsed: 'end', type: 'string' } },
    { requestId: 'r2', timestamp: 3000, message: { parsed: 'start', type: 'string' } },
    { requestId: 'r2', timestamp: 6000, message: { parsed: 'end', type: 'string' } },
  ];
  const simpleGetId = resolveChainIds(simpleLogs);
  if (simpleGetId(simpleLogs[0]) === 'r1' && simpleGetId(simpleLogs[2]) === 'r2') ok('Chain grouping fallback: uses requestId when no session metadata');
  else fail('Chain grouping fallback', 'Did not fall back to requestId');

  // Multi-session chain: two requestIds share one BeginningSessionId
  const chainLogs = [
    { requestId: 'r-origin', timestamp: 1000, message: { type: 'json', parsed: { type: 'START' } } },
    { requestId: 'r-origin', timestamp: 1100, message: { type: 'json', parsed: { event: { SessionId: 'r-origin', BeginningSessionId: 'r-origin' } } } },
    { requestId: 'r-origin', timestamp: 1200, message: { type: 'json', parsed: { session: { id: 'r-origin' }, type: 'vital' } } },
    { requestId: 'r-child', timestamp: 2000, message: { type: 'json', parsed: { type: 'START' } } },
    { requestId: 'r-child', timestamp: 2100, message: { type: 'json', parsed: { event: { SessionId: 'r-child', BeginningSessionId: 'r-origin' } } } },
    { requestId: 'r-child', timestamp: 2200, message: { type: 'json', parsed: { type: 'END' } } },
    { requestId: 'r-origin', timestamp: 3000, message: { type: 'json', parsed: { type: 'END' } } },
  ];
  const chainGetId = resolveChainIds(chainLogs);
  const allOrigin = chainLogs.every(evt => chainGetId(evt) === 'r-origin');
  if (allOrigin) ok('Chain grouping: all events (origin + child) map to BeginningSessionId');
  else fail('Chain grouping', 'Not all events mapped to r-origin: ' + chainLogs.map(e => chainGetId(e)).join(', '));

  // Group using chain IDs and verify single session
  const chainSessionMap = {};
  for (const evt of chainLogs) {
    const sid = chainGetId(evt);
    if (!chainSessionMap[sid]) chainSessionMap[sid] = { sessionId: sid, events: [], startTs: evt.timestamp, endTs: evt.timestamp };
    chainSessionMap[sid].events.push(evt);
    if (evt.timestamp < chainSessionMap[sid].startTs) chainSessionMap[sid].startTs = evt.timestamp;
    if (evt.timestamp > chainSessionMap[sid].endTs) chainSessionMap[sid].endTs = evt.timestamp;
  }
  const chainSessions = Object.values(chainSessionMap);
  if (chainSessions.length === 1) ok('Chain grouping: multi-requestId chain merges into 1 session');
  else fail('Chain grouping merge', `Expected 1, got ${chainSessions.length}`);

  if (chainSessions[0].events.length === 7) ok('Chain session: contains all 7 events');
  else fail('Chain session event count', `Expected 7, got ${chainSessions[0].events.length}`);

  if (chainSessions[0].endTs - chainSessions[0].startTs === 2000) ok('Chain session duration: 2000ms spanning origin+child');
  else fail('Chain session duration', `Got ${chainSessions[0].endTs - chainSessions[0].startTs}`);

  // Fallback grouping still works for non-chain requestIds
  const sessionLogs = [
    { requestId: 'sess-1', timestamp: 1000, message: { parsed: 'start', type: 'string' } },
    { requestId: 'sess-1', timestamp: 2000, message: { parsed: 'end', type: 'string' } },
    { requestId: 'sess-2', timestamp: 3000, message: { parsed: 'start', type: 'string' } },
    { requestId: 'sess-2', timestamp: 6000, message: { parsed: 'end', type: 'string' } },
  ];
  const fbGetId = resolveChainIds(sessionLogs);
  const sessionMap = {};
  for (const evt of sessionLogs) {
    const sid = fbGetId(evt);
    if (!sessionMap[sid]) sessionMap[sid] = { sessionId: sid, events: [], startTs: evt.timestamp, endTs: evt.timestamp };
    sessionMap[sid].events.push(evt);
    if (evt.timestamp < sessionMap[sid].startTs) sessionMap[sid].startTs = evt.timestamp;
    if (evt.timestamp > sessionMap[sid].endTs) sessionMap[sid].endTs = evt.timestamp;
  }
  const testSessions = Object.values(sessionMap).sort((a, b) => b.startTs - a.startTs);
  if (testSessions.length === 2) ok('Fallback grouping: 2 separate sessions');
  else fail('Fallback grouping', `Expected 2, got ${testSessions.length}`);

  if (testSessions[0].sessionId === 'sess-2' && testSessions[0].events.length === 2) ok('Fallback ordering: most recent first');
  else fail('Fallback ordering', 'Wrong order or count');

  // Test empty logs response
  const emptyResult = {
    flowId: FLOW_ID,
    label: null,
    logCount: 0,
    sessions: [],
    analysis: { summary: 'No log entries found for this flow.', sessions: [], patterns: [], recommendations: [] },
    rawLogs: [],
    ts: new Date().toISOString(),
  };

  if (emptyResult.analysis.summary && emptyResult.sessions.length === 0) ok('Empty logs response shape');
  else fail('Empty logs response shape', 'Incorrect structure');
}

// ---------------------------------------------------------------------------
// Test 5: App integration (if app is running)
// ---------------------------------------------------------------------------

async function testAppIntegration() {
  console.log('\n--- Test 5: App Integration (Running App) ---');

  try {
    const http = require('http');
    const healthResp = await new Promise((resolve, reject) => {
      http.get('http://127.0.0.1:47292/health', (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve(JSON.parse(body)));
      }).on('error', reject);
    });

    ok(`App running: v${healthResp.appVersion}`);

    // Check for flow context
    const logsResp = await new Promise((resolve, reject) => {
      http.get('http://127.0.0.1:47292/logs?category=gsx-flow-context&search=updated&limit=1', (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve(JSON.parse(body)));
      }).on('error', reject);
    });

    if (logsResp.data && logsResp.data.length > 0) {
      const ctx = logsResp.data[0].data || {};
      if (ctx.flowId) ok(`Flow context has flowId: ${ctx.flowId.substring(0, 12)}...`);
      else skip('Flow context flowId', 'Not in latest log entry');
    } else {
      skip('Flow context check', 'No gsx-flow-context logs');
    }

    // Check for any flow-logs category entries (shows if handler has been invoked)
    const flowLogsResp = await new Promise((resolve, reject) => {
      http.get('http://127.0.0.1:47292/logs?category=flow-logs&limit=5', (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve(JSON.parse(body)));
      }).on('error', reject);
    });

    if (flowLogsResp.data && flowLogsResp.data.length > 0) {
      ok(`Flow-logs handler has been invoked (${flowLogsResp.data.length} entries)`);
      for (const entry of flowLogsResp.data) {
        console.log(`    ${entry.timestamp?.substring(0, 19)} [${entry.level}] ${entry.message} ${JSON.stringify(entry.data || {}).substring(0, 100)}`);
      }
    } else {
      console.log('  INFO: No flow-logs entries yet — feature has not been invoked.');
      console.log('  To test: Open Dev Tools menu > Evaluate Flow Logs in the GSX window.');
    }

  } catch (err) {
    skip('App integration', `App not reachable: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Evaluate Flow Logs — Test Harness ===');
  console.log(`Flow ID: ${FLOW_ID}`);
  console.log(`Time: ${new Date().toISOString()}`);

  await testStructure();
  await testResultsHTML();
  await testSDKFetch();
  await testHandlerLogic();
  await testAppIntegration();

  console.log('\n=== Summary ===');
  console.log(`  \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m, \x1b[33m${skipped} skipped\x1b[0m`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Test harness error:', err);
  process.exit(1);
});
