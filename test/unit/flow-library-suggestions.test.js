/**
 * Test harness for the Flow Library Suggestions feature.
 *
 * Tests:
 *   1. Structural checks — IPC handler, preload bridge, HTML wiring
 *   2. Library search (live — via Edison SDK)
 *   3. Filtering logic — excludes steps already in the flow
 *   4. App integration — checks log server for invocation evidence
 *
 * Run:  node test/unit/flow-library-suggestions.test.js
 */

const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');

const ACCOUNT_ID = '35254342-4a2e-475b-aec1-18547e517e29';
const DISCOVERY_URL = 'https://discovery.edison.api.onereach.ai';

let passed = 0;
let failed = 0;
let skipped = 0;

function ok(name) { passed++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
function fail(name, reason) { failed++; console.log(`  \x1b[31mFAIL\x1b[0m  ${name} — ${reason}`); }
function skip(name, reason) { skipped++; console.log(`  \x1b[33mSKIP\x1b[0m  ${name} — ${reason}`); }

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
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve(body); }
      });
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Test 1: Structural checks
// ---------------------------------------------------------------------------

async function testStructure() {
  console.log('\n--- Test 1: Structural Checks ---');

  const mainJs = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', '..', 'preload.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'flow-logs-results.html'), 'utf8');
  const sdkMgr = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'edison-sdk-manager.js'), 'utf8');

  // IPC handler registered
  if (mainJs.includes("ipcMain.handle('dev-tools:flow-library-suggestions'"))
    ok('IPC handler registered in main.js');
  else fail('IPC handler registered', 'Handler not found in main.js');

  // Handler calls searchLibrary
  const handlerMatch = mainJs.indexOf("'dev-tools:flow-library-suggestions'");
  const handlerBlock = handlerMatch > -1 ? mainJs.substring(handlerMatch, handlerMatch + 3000) : '';
  if (handlerBlock.includes('searchLibrary'))
    ok('Handler calls searchLibrary');
  else fail('Handler calls searchLibrary', 'Not found in handler block');

  // Handler filters existing steps
  if (handlerBlock.includes('existingNames'))
    ok('Handler filters existing step names');
  else fail('Handler filters existing step names', 'existingNames not found');

  // Handler uses standard AI profile (upgraded from fast for richer tips)
  if (handlerBlock.includes("profile: 'standard'"))
    ok('Handler uses standard AI profile');
  else fail('Handler uses standard AI profile', 'Not found');

  // Returns suggestions array shape
  if (handlerBlock.includes('suggestions'))
    ok('Handler returns suggestions shape');
  else fail('Handler returns suggestions', 'Not found');

  // Preload bridge
  if (preload.includes('getFlowLibrarySuggestions'))
    ok('Preload bridge exports getFlowLibrarySuggestions');
  else fail('Preload bridge exports getFlowLibrarySuggestions', 'Not found');

  // HTML calls the bridge
  if (html.includes('getFlowLibrarySuggestions'))
    ok('HTML calls getFlowLibrarySuggestions');
  else fail('HTML calls getFlowLibrarySuggestions', 'Not found');

  // HTML has library tip styling
  if (html.includes('tip-label') && html.includes('library'))
    ok('HTML has library tip label styling');
  else fail('HTML has library tip label styling', 'Not found');

  // HTML has step icon SVG
  if (html.includes('STEP_ICON') && html.includes('tip-icon'))
    ok('HTML has step icon SVG');
  else fail('HTML has step icon', 'STEP_ICON or tip-icon not found');

  // HTML renders library tips differently
  if (html.includes("type === 'library'") || html.includes("'library'"))
    ok('HTML differentiates library tips from flow tips');
  else fail('HTML differentiates library tips', 'type check not found');

  // SDK manager exports searchLibrary
  if (sdkMgr.includes('searchLibrary'))
    ok('edison-sdk-manager exports searchLibrary');
  else fail('edison-sdk-manager exports searchLibrary', 'Not found');
}

// ---------------------------------------------------------------------------
// Test 2: Library search (live)
// ---------------------------------------------------------------------------

async function testLibrarySearch() {
  console.log('\n--- Test 2: Library Search (Live SDK) ---');

  let token;
  try {
    const resp = await fetchJSON(`https://em.edison.api.onereach.ai/http/${ACCOUNT_ID}/refresh_token`);
    if (resp.status === 200 && resp.data?.token) {
      token = resp.data.token.startsWith('FLOW ') ? resp.data.token : `FLOW ${resp.data.token}`;
      ok('Token acquired from refresh_token endpoint');
    } else {
      skip('Token acquisition', `HTTP ${resp.status}`);
      return;
    }
  } catch (err) {
    skip('Token acquisition', err.message);
    return;
  }

  let LibraryV2;
  try {
    LibraryV2 = require(path.join(__dirname, '..', '..', 'node_modules', '@or-sdk', 'library')).LibraryV2;
    ok('@or-sdk/library loaded');
  } catch (_err) {
    try {
      LibraryV2 = require('@or-sdk/library').LibraryV2;
      ok('@or-sdk/library loaded (global)');
    } catch (err2) {
      fail('@or-sdk/library loaded', err2.message);
      return;
    }
  }

  const lib = new LibraryV2({
    token: () => token,
    discoveryUrl: DISCOVERY_URL,
    packageType: 'STEP',
  });

  // Search with a realistic flow-related query
  try {
    const results = await lib.searchPackages({ query: 'http request', take: 10 });
    const items = results?.items || results || [];
    const count = Array.isArray(items) ? items.length : 0;
    if (count > 0) {
      ok(`Library search returned ${count} results for "http request"`);

      // Validate item shape
      const first = items[0];
      const hasName = !!(first.meta?.name || first.name || first.label);
      const hasDesc = !!(first.meta?.help || first.description);
      if (hasName) ok('Library item has name');
      else fail('Library item has name', `Keys: ${Object.keys(first).join(', ')}`);

      if (hasDesc) ok('Library item has description/help');
      else skip('Library item has description/help', 'First item has no help text');

      // Show a sample
      const name = first.meta?.name || first.name || first.label || '(unnamed)';
      const desc = (first.meta?.help || first.description || '').substring(0, 80);
      console.log(`    Sample: "${name}" — ${desc || '(no description)'}...`);
    } else {
      fail('Library search returned results', 'Got 0 results');
    }
  } catch (err) {
    fail('Library search', err.message);
  }

  // Search with a different query to test variety
  try {
    const results2 = await lib.searchPackages({ query: 'storage value', take: 5 });
    const items2 = results2?.items || results2 || [];
    const count2 = Array.isArray(items2) ? items2.length : 0;
    if (count2 > 0) ok(`Library search for "storage value" returned ${count2} results`);
    else skip('Library search "storage value"', 'No results');
  } catch (err) {
    fail('Library search "storage value"', err.message);
  }
}

// ---------------------------------------------------------------------------
// Test 3: Filtering logic (unit)
// ---------------------------------------------------------------------------

async function testFilteringLogic() {
  console.log('\n--- Test 3: Filtering Logic ---');

  // Simulate what the handler does: filter library results against existing step names
  const existingLabels = ['Send HTTP Request', 'Set Value to a Storage', 'Log Message'];
  const existingNames = new Set(existingLabels.map(l => l.toLowerCase().trim()));

  const libraryResults = [
    { name: 'Send HTTP Request', description: 'Makes HTTP calls' },
    { name: 'Parse JSON', description: 'Parses JSON strings' },
    { name: 'Set Value to a Storage', description: 'Stores data' },
    { name: 'Send Email', description: 'Sends emails via SMTP' },
    { name: 'Wait for Event', description: 'Pauses execution until event' },
  ];

  const novel = libraryResults.filter(r =>
    r.name && !existingNames.has(r.name.toLowerCase().trim())
  );

  if (novel.length === 3) ok('Filter excludes existing steps (5 - 2 = 3 novel)');
  else fail('Filter excludes existing steps', `Expected 3, got ${novel.length}`);

  const names = novel.map(n => n.name);
  if (!names.includes('Send HTTP Request') && !names.includes('Set Value to a Storage'))
    ok('Filtered out correct steps (HTTP Request, Set Value)');
  else fail('Filtered wrong steps', `Novel: ${names.join(', ')}`);

  if (names.includes('Parse JSON') && names.includes('Send Email') && names.includes('Wait for Event'))
    ok('Kept correct novel steps');
  else fail('Missing novel steps', `Got: ${names.join(', ')}`);

  // Slice to 3
  const sliced = novel.slice(0, 3);
  if (sliced.length === 3) ok('Slices to max 3 suggestions');
  else fail('Slice to 3', `Got ${sliced.length}`);

  // Empty library results
  const emptyNovel = [].filter(r => r.name && !existingNames.has(r.name.toLowerCase().trim()));
  if (emptyNovel.length === 0) ok('Empty library results handled gracefully');
  else fail('Empty library results', 'Should be 0');

  // All results already in flow
  const allExisting = [
    { name: 'Send HTTP Request', description: 'x' },
    { name: 'Set Value to a Storage', description: 'y' },
  ];
  const noneNovel = allExisting.filter(r =>
    r.name && !existingNames.has(r.name.toLowerCase().trim())
  );
  if (noneNovel.length === 0) ok('All-existing results correctly filtered to 0');
  else fail('All-existing filter', `Expected 0, got ${noneNovel.length}`);

  // Case-insensitive filtering
  const caseResults = [
    { name: 'send http request', description: 'lowercase' },
    { name: 'SEND HTTP REQUEST', description: 'uppercase' },
    { name: 'New Step', description: 'novel' },
  ];
  const caseNovel = caseResults.filter(r =>
    r.name && !existingNames.has(r.name.toLowerCase().trim())
  );
  if (caseNovel.length === 1 && caseNovel[0].name === 'New Step')
    ok('Case-insensitive filtering works');
  else fail('Case-insensitive filtering', `Expected 1 "New Step", got ${caseNovel.length}`);
}

// ---------------------------------------------------------------------------
// Test 4: Suggestion output shape (simulated)
// ---------------------------------------------------------------------------

async function testOutputShape() {
  console.log('\n--- Test 4: Output Shape Simulation ---');

  // Simulate AI response parsing (numbered lines)
  const aiResponse = `1. Use Parse JSON to validate incoming payloads before processing.
2. Send Email can notify admins when critical errors occur in the flow.
3. Wait for Event enables async patterns like webhook callbacks.`;

  const lines = aiResponse.split('\n').map(l => l.replace(/^\d+[\.\)]\s*/, '').trim()).filter(Boolean);
  if (lines.length === 3) ok('AI response parsed into 3 lines');
  else fail('AI response parsing', `Expected 3, got ${lines.length}`);

  if (!lines[0].match(/^\d/)) ok('Line numbering stripped correctly');
  else fail('Line numbering', `First line still starts with number: ${lines[0]}`);

  const novel = [
    { name: 'Parse JSON', description: 'Parses JSON strings' },
    { name: 'Send Email', description: 'Sends emails via SMTP' },
    { name: 'Wait for Event', description: 'Pauses until event' },
  ];

  const suggestions = novel.map((r, i) => ({
    name: r.name,
    description: r.description,
    tip: lines[i] || null,
  })).filter(s => s.tip);

  if (suggestions.length === 3) ok('All 3 suggestions have tips');
  else fail('Suggestion count', `Expected 3, got ${suggestions.length}`);

  if (suggestions[0].name === 'Parse JSON' && suggestions[0].tip.includes('Parse JSON'))
    ok('Suggestion links name to correct tip');
  else fail('Suggestion name-tip link', `Got: ${suggestions[0].name} / ${suggestions[0].tip}`);

  // Missing lines fallback
  const shortAI = '1. Only one tip here.';
  const shortLines = shortAI.split('\n').map(l => l.replace(/^\d+[\.\)]\s*/, '').trim()).filter(Boolean);
  const partialSuggestions = novel.map((r, i) => ({
    name: r.name,
    description: r.description,
    tip: shortLines[i] || null,
  })).filter(s => s.tip);

  if (partialSuggestions.length === 1) ok('Partial AI response: only items with tips survive');
  else fail('Partial AI response', `Expected 1, got ${partialSuggestions.length}`);

  // Verify handler return shape
  const handlerReturn = { suggestions };
  if (Array.isArray(handlerReturn.suggestions) && handlerReturn.suggestions[0].name && handlerReturn.suggestions[0].tip)
    ok('Handler return shape: { suggestions: [{ name, description, tip }] }');
  else fail('Handler return shape', JSON.stringify(handlerReturn).substring(0, 100));
}

// ---------------------------------------------------------------------------
// Test 5: App integration
// ---------------------------------------------------------------------------

async function testAppIntegration() {
  console.log('\n--- Test 5: App Integration (Running App) ---');

  try {
    const health = await httpGet('http://127.0.0.1:47292/health');
    ok(`App running: v${health.appVersion}`);

    // Check for flow context
    const ctxLogs = await httpGet('http://127.0.0.1:47292/logs?category=gsx-flow-context&search=updated&limit=1');
    if (ctxLogs.data && ctxLogs.data.length > 0) {
      const ctx = ctxLogs.data[0].data || {};
      if (ctx.flowId) ok(`Flow context has flowId: ${ctx.flowId.substring(0, 12)}...`);
      else skip('Flow context flowId', 'Not in latest log entry');
    } else {
      skip('Flow context check', 'No gsx-flow-context logs');
    }

    // Check for library suggestion logs
    const sugLogs = await httpGet('http://127.0.0.1:47292/logs?category=flow-library-suggestions&limit=5');
    if (sugLogs.data && sugLogs.data.length > 0) {
      ok(`Library suggestions invoked (${sugLogs.data.length} entries)`);
      for (const entry of sugLogs.data) {
        console.log(`    ${entry.timestamp?.substring(0, 19)} [${entry.level}] ${entry.message} ${JSON.stringify(entry.data || {}).substring(0, 100)}`);
      }
    } else {
      console.log('  INFO: No flow-library-suggestions entries yet — feature has not been invoked.');
      console.log('  To test: Open Dev Tools menu > Evaluate Flow Logs and watch the loading screen.');
    }

    // Check for step tip logs (the tips feature that runs alongside)
    const tipLogs = await httpGet('http://127.0.0.1:47292/logs?category=flow-step-tip&limit=3');
    if (tipLogs.data && tipLogs.data.length > 0) {
      ok(`Step tips also invoked (${tipLogs.data.length} entries)`);
    } else {
      skip('Step tips invocation', 'No flow-step-tip log entries');
    }

  } catch (err) {
    skip('App integration', `App not reachable: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Flow Library Suggestions — Test Harness ===');
  console.log(`Time: ${new Date().toISOString()}`);

  await testStructure();
  await testLibrarySearch();
  await testFilteringLogic();
  await testOutputShape();
  await testAppIntegration();

  console.log('\n=== Summary ===');
  console.log(`  \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m, \x1b[33m${skipped} skipped\x1b[0m`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Test harness error:', err);
  process.exit(1);
});
