/**
 * Test script for the self-correcting AppleScript executor
 */

// Mock global.settingsManager for testing outside Electron
// Get API key from keychain or prompt
const { _execSync } = require('child_process');
let apiKey = process.env.OPENAI_API_KEY;

// Try to get from macOS keychain if not in env
if (!apiKey) {
  try {
    // Try to read from the app's settings file
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const settingsPath = path.join(
      os.homedir(),
      'Library/Application Support/gsx-power-user/app-settings-encrypted.json'
    );
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      apiKey = settings.openaiApiKey || settings.llmApiKey;
      if (typeof apiKey === 'object') {
        // It's encrypted, can't use it from here
        apiKey = null;
      }
    }
  } catch (_e) {
    // Ignore
  }
}

if (!apiKey) {
  console.log('Note: OPENAI_API_KEY not found - intent-based tests will fail');
  console.log('Set it with: export OPENAI_API_KEY=sk-...');
} else {
  // Mock the settings manager
  global.settingsManager = {
    get: (key) => {
      if (key === 'openaiApiKey') return apiKey;
      if (key === 'llmApiKey') return apiKey;
      if (key === 'llmProvider') return 'openai';
      return null;
    },
  };
  console.log('API key found, intent-based tests enabled');
}

const { executeIntent, executeQuickOrIntent, runAppleScript } = require('./packages/agents/applescript-executor');

async function runTests() {
  console.log('='.repeat(60));
  console.log('Testing AppleScript Executor');
  console.log('='.repeat(60));

  const hasApiKey = !!global.settingsManager?.get('openaiApiKey');
  console.log(`\nAPI Key available: ${hasApiKey ? 'YES' : 'NO'}`);

  // Test 1: Simple direct script
  console.log('\n--- Test 1: Direct AppleScript execution ---');
  const directResult = await runAppleScript('return "Hello from AppleScript"');
  console.log('Result:', directResult);

  // Test 2: Quick pattern - music state
  console.log('\n--- Test 2: Quick pattern (music:state) ---');
  const stateResult = await executeQuickOrIntent('music:state', 'Get music state');
  console.log('Success:', stateResult.success);
  console.log('Output:', stateResult.output);
  console.log('Method:', stateResult.method);

  // Test 3: Quick pattern - play
  console.log('\n--- Test 3: Quick pattern (music:play) ---');
  const playQuickResult = await executeQuickOrIntent('music:play', 'Play music');
  console.log('Success:', playQuickResult.success);
  console.log('Output:', playQuickResult.output);
  console.log('Method:', playQuickResult.method);

  // Test 4: Quick pattern - pause
  console.log('\n--- Test 4: Quick pattern (music:pause) ---');
  const pauseResult = await executeQuickOrIntent('music:pause', 'Pause music');
  console.log('Success:', pauseResult.success);
  console.log('Output:', pauseResult.output);
  console.log('Method:', pauseResult.method);

  // Test 5: Intent-based (only if API key available)
  if (hasApiKey) {
    console.log('\n--- Test 5: Intent-based - Get current time ---');
    const timeResult = await executeIntent('Get the current time and date formatted nicely', { maxAttempts: 2 });
    console.log('Success:', timeResult.success);
    console.log('Output:', timeResult.output);
    console.log('Attempts:', timeResult.attempts);

    if (timeResult.scripts) {
      console.log('\nAttempt history:');
      timeResult.scripts.forEach((s, i) => {
        console.log(`  ${i + 1}. ${s.result}: ${s.error || s.output?.substring(0, 80) || 'OK'}`);
      });
    }

    console.log('\n--- Test 6: Intent-based - Play music (self-correcting) ---');
    const playResult = await executeIntent(
      'Play music in the Music app. If nothing is playing, try to start playback. Return what is now playing.',
      { maxAttempts: 3, timeout: 20000 }
    );
    console.log('Success:', playResult.success);
    console.log('Output:', playResult.output);
    console.log('Attempts:', playResult.attempts);

    if (playResult.scripts) {
      console.log('\nAttempt history:');
      playResult.scripts.forEach((s, i) => {
        console.log(`  ${i + 1}. ${s.result}: ${s.error || s.output?.substring(0, 80) || 'OK'}`);
      });
    }
  } else {
    console.log('\n--- Tests 5-6 skipped (no API key) ---');
    console.log('To test intent-based execution, either:');
    console.log('  1. Run from within Electron app, OR');
    console.log('  2. export OPENAI_API_KEY=sk-...');
  }

  console.log('\n' + '='.repeat(60));
  console.log('Tests complete');
  console.log('='.repeat(60));
}

// Run tests
runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
