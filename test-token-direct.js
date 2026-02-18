#!/usr/bin/env node

/**
 * Direct test of the OneReach Files Sync SDK
 * This will help us diagnose why the token is being rejected
 */

const { FilesSyncNode } = require('@or-sdk/files-sync-node');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');

// PASTE YOUR TOKEN AND CONFIG HERE
const CONFIG = {
  // REPLACE THIS WITH YOUR TOKEN FROM THE JSON RESPONSE
  token: process.env.GSX_TOKEN || 'PASTE-YOUR-TOKEN-HERE',

  // Your account ID
  accountId: '48cc49ef-ab05-4d51-acc6-559c7ff22150',

  // Environment: staging, edison, qa, or production
  environment: 'staging',
};

const DISCOVERY_URLS = {
  staging: 'https://discovery.staging.api.onereach.ai',
  edison: 'https://discovery.edison.onereach.ai',
  qa: 'https://discovery.qa.api.onereach.ai',
  production: 'https://discovery.api.onereach.ai',
};

async function testToken() {
  console.log('=================================================');
  console.log('OneReach Files Sync SDK - Token Test');
  console.log('=================================================\n');

  console.log('Configuration:');
  console.log('- Environment:', CONFIG.environment);
  console.log('- Discovery URL:', DISCOVERY_URLS[CONFIG.environment]);
  console.log('- Account ID:', CONFIG.accountId);
  console.log('- Token length:', CONFIG.token.length, 'characters');
  console.log('- Token prefix:', CONFIG.token.substring(0, 20) + '...');
  console.log('- Token suffix:', '...' + CONFIG.token.substring(CONFIG.token.length - 20));
  console.log('');

  // Test 1: Create SDK instance
  console.log('Test 1: Creating SDK instance...');
  try {
    const client = new FilesSyncNode({
      token: CONFIG.token,
      discoveryUrl: DISCOVERY_URLS[CONFIG.environment],
      accountId: CONFIG.accountId,
    });
    console.log('✅ SDK instance created successfully');
    console.log('   Client object:', typeof client);
    console.log('   Has filesClient:', !!client.filesClient);
    console.log('');

    // Test 2: Create a tiny test directory
    console.log('Test 2: Creating test directory...');
    const testDir = path.join(os.tmpdir(), 'gsx-sync-test-' + Date.now());
    await fs.mkdir(testDir, { recursive: true });

    // Create a tiny test file
    const testFile = path.join(testDir, 'test.txt');
    await fs.writeFile(testFile, 'Test file for GSX sync - ' + new Date().toISOString());
    console.log('✅ Test directory created:', testDir);
    console.log('   Test file:', testFile);
    console.log('');

    // Test 3: Attempt sync
    console.log('Test 3: Attempting to sync to GSX Files...');
    console.log('   This will try to upload to: GSX Files/SDK-Test');

    const startTime = Date.now();

    try {
      await client.pushLocalPathToFiles(testDir, 'SDK-Test');
      const duration = Date.now() - startTime;

      console.log('✅ SYNC SUCCESSFUL!');
      console.log('   Duration:', duration, 'ms');
      console.log('   Remote path: GSX Files/SDK-Test');
      console.log('');
      console.log('🎉 Your token works! The issue was somewhere else.');
      console.log('');
      console.log('Next steps:');
      console.log('1. Use this exact token in the app');
      console.log('2. Use environment: ' + CONFIG.environment);
      console.log('3. Use account ID: ' + CONFIG.accountId);
    } catch (syncError) {
      console.log('❌ SYNC FAILED');
      console.log('   Error type:', syncError.constructor.name);
      console.log('   Error message:', syncError.message);
      console.log('');

      // Check for specific error types
      if (syncError.message && syncError.message.includes('wrong keyId')) {
        console.log('🔍 "wrong keyId" error means:');
        console.log('   - This token is not a Files API token');
        console.log('   - It might be a UI/session token');
        console.log('   - You need a different token type');
      } else if (syncError.message && syncError.message.includes('401')) {
        console.log('🔍 "401 Unauthorized" means:');
        console.log('   - Token is expired or invalid');
        console.log('   - Environment might be wrong');
        console.log('   - Try regenerating the token');
      } else if (syncError.message && syncError.message.includes('403')) {
        console.log('🔍 "403 Forbidden" means:');
        console.log("   - Token doesn't have Files API permissions");
        console.log('   - Need to grant Files access to this token');
      } else if (syncError.message && syncError.message.includes('serviceUrl')) {
        console.log('🔍 "serviceUrl not discovered" means:');
        console.log("   - Discovery service can't find Files API endpoint");
        console.log('   - Environment might be wrong');
        console.log('   - Network/DNS issue');
      }

      console.log('');
      console.log('Full error details:');
      console.log(syncError);

      if (syncError.response) {
        console.log('');
        console.log('API Response:');
        console.log('- Status:', syncError.response.status);
        console.log('- Data:', syncError.response.data);
      }
    }

    // Cleanup
    console.log('');
    console.log('Cleaning up test directory...');
    await fs.rm(testDir, { recursive: true, force: true });
    console.log('✅ Cleanup complete');
  } catch (error) {
    console.log('❌ FAILED TO CREATE SDK INSTANCE');
    console.log('   Error:', error.message);
    console.log("   This means the SDK can't even initialize with these settings");
    console.log('');
    console.log('Full error:');
    console.log(error);
  }

  console.log('');
  console.log('=================================================');
  console.log('Test Complete');
  console.log('=================================================');
}

// Run the test
testToken().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
