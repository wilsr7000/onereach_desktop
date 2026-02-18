#!/usr/bin/env node

/**
 * Test script to try POST request to OneReach API endpoint
 * Run with: node test-api-post.js
 */

const https = require('https');
const fs = require('fs');

const API_BASE = 'https://em.staging.api.onereach.ai/http/48cc49ef-ab05-4d51-acc6-559c7ff22150';

console.log('Testing OneReach API with different methods...\n');

async function testRequest(path, method = 'GET', body = null) {
  const url = new URL(`${API_BASE}${path}`);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    };

    if (body) {
      const bodyString = JSON.stringify(body);
      options.headers['Content-Length'] = Buffer.byteLength(bodyString);
    }

    console.log(`\nTesting: ${method} ${url.toString()}`);
    if (body) console.log('Body:', JSON.stringify(body, null, 2));

    const req = https.request(options, (res) => {
      let data = '';

      console.log(`Status: ${res.statusCode}`);

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        console.log('Response:', data);
        resolve({ status: res.statusCode, data });
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

async function runTests() {
  console.log('-----------------------------------');
  console.log('Testing various endpoint patterns:');
  console.log('-----------------------------------');

  // Test different URL patterns and methods
  const tests = [
    { path: '/idw_quick_starts', method: 'GET' },
    { path: '/idw_quick_starts', method: 'POST', body: {} },
    { path: '/idw_quick_starts', method: 'POST', body: { userId: 'test-user' } },
    { path: '', method: 'GET' },
    { path: '', method: 'POST', body: { action: 'idw_quick_starts' } },
    { path: '', method: 'POST', body: { method: 'idw_quick_starts' } },
    { path: '', method: 'POST', body: { endpoint: 'idw_quick_starts' } },
    {
      path: '',
      method: 'POST',
      body: {
        action: 'get_lessons',
        userId: 'test-user',
      },
    },
    {
      path: '',
      method: 'POST',
      body: {
        type: 'quick_starts',
        user: { id: 'test-user' },
      },
    },
  ];

  for (const test of tests) {
    try {
      const result = await testRequest(test.path, test.method, test.body);

      // Try to parse as JSON
      try {
        const jsonData = JSON.parse(result.data);
        if (jsonData && !jsonData.error) {
          console.log('✅ Valid response received!');

          // Save successful response
          const filename = `api-success-${Date.now()}.json`;
          fs.writeFileSync(filename, JSON.stringify(jsonData, null, 2));
          console.log(`Response saved to: ${filename}`);

          // Check structure
          console.log('Response keys:', Object.keys(jsonData));

          return jsonData;
        }
      } catch (_e) {
        // Not JSON or parsing error
      }
    } catch (error) {
      console.error('Request failed:', error.message);
    }

    console.log('---');
  }

  console.log('\n❌ No successful response pattern found');
  console.log('\nPossible issues:');
  console.log('1. The endpoint might require authentication');
  console.log('2. The URL structure might be different');
  console.log('3. The endpoint might expect specific headers or parameters');
  console.log('\nPlease check with the API documentation or provider');
}

runTests().catch(console.error);
