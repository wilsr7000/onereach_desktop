/**
 * Test script for the centralized logging event queue and REST/WebSocket server.
 * Run with: node test-log-queue.js
 */

const http = require('http');

// --- Test 1: LogEventQueue in-process ---
console.log('=== Test 1: LogEventQueue in-process ===\n');

// Mock electron app for event-logger (it requires app.getPath)
const mockApp = { getPath: () => '/tmp', isReady: () => true, getVersion: () => '0.0.0-test' };
try {
  require('electron');
} catch (_e) {
  // Provide a minimal mock so the queue can load (file writer will gracefully fail)
  require.cache[require.resolve('electron')] = {
    id: 'electron',
    filename: 'electron',
    loaded: true,
    exports: { app: mockApp },
  };
}

const { _LogEventQueue, getLogQueue, _LOG_LEVELS, _CATEGORIES } = require('./lib/log-event-queue');

// Test singleton
const q1 = getLogQueue();
const q2 = getLogQueue();
console.log('Singleton test:', q1 === q2 ? 'PASS' : 'FAIL');

// Test enqueue
const entry = q1.info('test', 'Hello from test', { key: 'value' });
console.log('Enqueue test:', entry && entry.id && entry.level === 'info' ? 'PASS' : 'FAIL');

// Test multiple levels
q1.debug('test', 'Debug message');
q1.warn('test', 'Warning message');
q1.error('test', 'Error message');
console.log('Multi-level test:', q1.getStats().total >= 4 ? 'PASS' : 'FAIL');

// Test query
const errors = q1.query({ level: 'error' });
console.log('Query by level test:', errors.length === 1 && errors[0].message === 'Error message' ? 'PASS' : 'FAIL');

const byCategory = q1.query({ category: 'test' });
console.log('Query by category test:', byCategory.length >= 4 ? 'PASS' : 'FAIL');

const searched = q1.query({ search: 'Hello' });
console.log('Query search test:', searched.length === 1 ? 'PASS' : 'FAIL');

// Test subscribe
let receivedEvent = null;
const unsub = q1.subscribe({ level: 'error' }, (e) => {
  receivedEvent = e;
});
q1.error('test', 'Subscribed error');
console.log('Subscribe test:', receivedEvent && receivedEvent.message === 'Subscribed error' ? 'PASS' : 'FAIL');

// Test unsubscribe
unsub();
receivedEvent = null;
q1.error('test', 'After unsubscribe');
console.log('Unsubscribe test:', receivedEvent === null ? 'PASS' : 'FAIL');

// Test stats
const stats = q1.getStats();
console.log('Stats test:', stats.total > 0 && stats.byLevel.error > 0 && stats.byCategory.test > 0 ? 'PASS' : 'FAIL');
console.log('  Stats:', JSON.stringify(stats, null, 2));

// --- Test 2: LogServer REST API ---
console.log('\n=== Test 2: LogServer REST API ===\n');

const { _LogServer, getLogServer } = require('./lib/log-server');

const server = getLogServer(q1);

async function testREST() {
  try {
    await server.start();
    console.log('Server start test: PASS');

    // Helper for HTTP requests
    function httpGet(path) {
      return new Promise((resolve, reject) => {
        http
          .get(`http://127.0.0.1:47292${path}`, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
              try {
                resolve({ status: res.statusCode, body: JSON.parse(data) });
              } catch (_e) {
                resolve({ status: res.statusCode, body: data });
              }
            });
          })
          .on('error', reject);
      });
    }

    function httpPost(path, body) {
      return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request(
          `http://127.0.0.1:47292${path}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
          },
          (res) => {
            let resData = '';
            res.on('data', (chunk) => (resData += chunk));
            res.on('end', () => {
              try {
                resolve({ status: res.statusCode, body: JSON.parse(resData) });
              } catch (_e) {
                resolve({ status: res.statusCode, body: resData });
              }
            });
          }
        );
        req.on('error', reject);
        req.write(data);
        req.end();
      });
    }

    // GET /health
    const health = await httpGet('/health');
    console.log('GET /health test:', health.status === 200 && health.body.status === 'ok' ? 'PASS' : 'FAIL');

    // GET /logs
    const logs = await httpGet('/logs?limit=5');
    console.log('GET /logs test:', logs.status === 200 && Array.isArray(logs.body.data) ? 'PASS' : 'FAIL');
    console.log('  Log count:', logs.body.count);

    // GET /logs?level=error
    const errorLogs = await httpGet('/logs?level=error');
    console.log(
      'GET /logs?level=error test:',
      errorLogs.status === 200 && errorLogs.body.data.every((e) => e.level === 'error') ? 'PASS' : 'FAIL'
    );

    // GET /logs/stats
    const statsRes = await httpGet('/logs/stats');
    console.log('GET /logs/stats test:', statsRes.status === 200 && statsRes.body.total > 0 ? 'PASS' : 'FAIL');

    // POST /logs
    const posted = await httpPost('/logs', {
      level: 'info',
      category: 'external',
      message: 'Posted from test',
      data: { source: 'test-script' },
    });
    console.log('POST /logs test:', posted.status === 201 && posted.body.success ? 'PASS' : 'FAIL');

    // Verify posted event shows up in query
    const afterPost = await httpGet('/logs?search=Posted+from+test');
    console.log('Posted event query test:', afterPost.body.count >= 1 ? 'PASS' : 'FAIL');

    // GET /logs/export
    const exported = await httpGet('/logs/export?format=json&limit=10');
    console.log('GET /logs/export test:', exported.status === 200 ? 'PASS' : 'FAIL');

    // 404 test
    const notFound = await httpGet('/nonexistent');
    console.log('404 test:', notFound.status === 404 ? 'PASS' : 'FAIL');

    console.log('\n=== All tests complete ===\n');

    // Final stats
    const finalStats = q1.getStats();
    console.log('Final stats:', JSON.stringify(finalStats, null, 2));

    server.stop();
    process.exit(0);
  } catch (error) {
    console.error('Test error:', error);
    server.stop();
    process.exit(1);
  }
}

testREST();
