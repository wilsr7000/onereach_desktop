#!/usr/bin/env node

/**
 * Test script for GSX File Sync functionality
 * Run with: node test/test-gsx-sync.js
 */

const { FilesSyncNode } = require('@or-sdk/files-sync-node');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');

// Test configuration - update with your token
const TEST_CONFIG = {
  token: process.env.GSX_TOKEN || '', // Set GSX_TOKEN environment variable or update here
  environment: process.env.GSX_ENV || 'qa', // Use qa for testing
  testDir: path.join(os.tmpdir(), 'gsx-sync-test')
};

async function createTestFiles() {
  console.log('Creating test files...');
  
  // Create test directory
  await fs.mkdir(TEST_CONFIG.testDir, { recursive: true });
  
  // Create some test files
  await fs.writeFile(
    path.join(TEST_CONFIG.testDir, 'test-file-1.txt'),
    'This is test file 1 content\n' + new Date().toISOString()
  );
  
  await fs.writeFile(
    path.join(TEST_CONFIG.testDir, 'test-file-2.json'),
    JSON.stringify({ 
      test: true, 
      timestamp: new Date().toISOString(),
      message: 'GSX sync test file'
    }, null, 2)
  );
  
  // Create a subdirectory with files
  const subDir = path.join(TEST_CONFIG.testDir, 'subdirectory');
  await fs.mkdir(subDir, { recursive: true });
  
  await fs.writeFile(
    path.join(subDir, 'nested-file.md'),
    '# Test Markdown File\n\nThis file is in a subdirectory.'
  );
  
  console.log(`Test files created in: ${TEST_CONFIG.testDir}`);
}

async function testConnection() {
  console.log('\n=== Testing GSX Connection ===');
  
  if (!TEST_CONFIG.token) {
    console.error('ERROR: No GSX token provided!');
    console.log('Please set the GSX_TOKEN environment variable or update TEST_CONFIG.token');
    return false;
  }
  
  const discoveryUrls = {
    qa: 'https://discovery.qa.api.onereach.ai',
    staging: 'https://discovery.staging.api.onereach.ai',
    production: 'https://discovery.api.onereach.ai'
  };
  
  const discoveryUrl = discoveryUrls[TEST_CONFIG.environment];
  console.log(`Using discovery URL: ${discoveryUrl}`);
  
  try {
    const client = new FilesSyncNode({
      token: TEST_CONFIG.token,
      discoveryUrl: discoveryUrl
    });
    
    console.log('✓ Client initialized successfully');
    return client;
  } catch (error) {
    console.error('✗ Failed to initialize client:', error.message);
    return null;
  }
}

async function testSync(client) {
  console.log('\n=== Testing File Sync ===');
  
  const remotePath = `test-sync-${Date.now()}`;
  console.log(`Syncing to remote path: ${remotePath}`);
  
  try {
    // Test basic sync
    console.log('Starting sync...');
    await client.pushLocalPathToFiles(TEST_CONFIG.testDir, remotePath);
    console.log(`✓ Successfully synced ${TEST_CONFIG.testDir} to GSX Files/${remotePath}`);
    
    // Test with options
    console.log('\nTesting sync with options...');
    const remotePathPublic = `${remotePath}-public`;
    await client.pushLocalPathToFiles(TEST_CONFIG.testDir, remotePathPublic, {
      isPublic: true
    });
    console.log(`✓ Successfully synced with public access to GSX Files/${remotePathPublic}`);
    
    // Test with TTL
    console.log('\nTesting sync with TTL (1 hour expiration)...');
    const remotePathTTL = `${remotePath}-ttl`;
    await client.pushLocalPathToFiles(TEST_CONFIG.testDir, remotePathTTL, {
      ttl: Date.now() + 3600000 // 1 hour from now
    });
    console.log(`✓ Successfully synced with 1 hour TTL to GSX Files/${remotePathTTL}`);
    
    return true;
  } catch (error) {
    console.error('✗ Sync failed:', error.message);
    if (error.stack) {
      console.error('Stack trace:', error.stack);
    }
    return false;
  }
}

async function cleanup() {
  console.log('\n=== Cleanup ===');
  
  try {
    await fs.rm(TEST_CONFIG.testDir, { recursive: true, force: true });
    console.log(`✓ Cleaned up test directory: ${TEST_CONFIG.testDir}`);
  } catch (error) {
    console.error('✗ Cleanup failed:', error.message);
  }
}

async function runTests() {
  console.log('GSX File Sync Test Suite');
  console.log('========================\n');
  console.log('Configuration:');
  console.log(`- Environment: ${TEST_CONFIG.environment}`);
  console.log(`- Token: ${TEST_CONFIG.token ? '***' + TEST_CONFIG.token.slice(-4) : 'NOT SET'}`);
  console.log(`- Test Directory: ${TEST_CONFIG.testDir}`);
  
  try {
    // Create test files
    await createTestFiles();
    
    // Test connection
    const client = await testConnection();
    if (!client) {
      console.error('\n❌ Connection test failed. Cannot proceed with sync tests.');
      await cleanup();
      process.exit(1);
    }
    
    // Test sync
    const syncSuccess = await testSync(client);
    
    // Cleanup
    await cleanup();
    
    // Summary
    console.log('\n=== Test Summary ===');
    if (syncSuccess) {
      console.log('✅ All tests passed successfully!');
      console.log('\nYou can now:');
      console.log('1. Add your GSX token in the app Settings');
      console.log('2. Use the GSX → File Sync menu to sync your files');
      process.exit(0);
    } else {
      console.log('❌ Some tests failed. Please check the errors above.');
      process.exit(1);
    }
  } catch (error) {
    console.error('\n❌ Unexpected error:', error);
    await cleanup();
    process.exit(1);
  }
}

// Run tests if executed directly
if (require.main === module) {
  runTests();
}

module.exports = { runTests };
