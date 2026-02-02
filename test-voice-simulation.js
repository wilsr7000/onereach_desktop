/**
 * Voice Simulation Test
 * Tests the agent routing by simulating transcribed phrases
 */

// Mock globals that exchange-bridge expects
global.showCommandHUD = (data) => {
  console.log('[HUD] showCommandHUD called:', JSON.stringify(data));
};
global.sendCommandHUDResult = (data) => {
  console.log('[HUD] sendCommandHUDResult called:', JSON.stringify(data));
};
global.speakFeedback = (text) => {
  console.log('[SPEAK] speakFeedback called:', text);
};

// Import the exchange bridge
const path = require('path');

async function runTests() {
  console.log('=== Voice Simulation Tests ===\n');
  
  // Dynamically import after setting globals
  const { submitVoiceTask, initializeExchangeBridge } = require('./src/voice-task-sdk/exchange-bridge.js');
  
  // Initialize the exchange bridge
  await initializeExchangeBridge();
  
  const testCases = [
    { phrase: 'What time is it?', expectedAgent: 'time-agent', description: 'Time query' },
    { phrase: 'What is the time', expectedAgent: 'time-agent', description: 'Time query variant' },
    { phrase: 'What day is it?', expectedAgent: 'time-agent', description: 'Date query' },
    { phrase: 'Play music', expectedAgent: 'media-agent', description: 'Media command' },
    { phrase: 'Pause', expectedAgent: 'media-agent', description: 'Media pause' },
    { phrase: 'What can you do?', expectedAgent: 'help-agent', description: 'Help query' },
    { phrase: 'Help', expectedAgent: 'help-agent', description: 'Help command' },
    { phrase: 'Weather in Denver', expectedAgent: 'weather-agent', description: 'Weather with location' },
    { phrase: "What's the weather", expectedAgent: 'weather-agent', description: 'Weather without location (needs input)' },
    { phrase: 'Cancel', expectedAgent: null, description: 'Cancel command (router)' },
    { phrase: 'Repeat', expectedAgent: null, description: 'Repeat command (router)' },
  ];
  
  let passed = 0;
  let failed = 0;
  
  for (const test of testCases) {
    console.log(`\n--- Test: ${test.description} ---`);
    console.log(`Phrase: "${test.phrase}"`);
    
    try {
      const result = await submitVoiceTask(test.phrase);
      
      console.log('Result:', JSON.stringify(result, null, 2));
      
      // Check if handled by expected agent
      const handledBy = result.action || 'unknown';
      const isExpected = test.expectedAgent === null 
        ? (result.handled === true)
        : (handledBy === test.expectedAgent || handledBy.includes(test.expectedAgent));
      
      if (isExpected) {
        console.log(`✓ PASS - Handled by: ${handledBy}`);
        passed++;
      } else {
        console.log(`✗ FAIL - Expected: ${test.expectedAgent}, Got: ${handledBy}`);
        failed++;
      }
    } catch (error) {
      console.log(`✗ ERROR - ${error.message}`);
      failed++;
    }
  }
  
  console.log('\n=== Summary ===');
  console.log(`Passed: ${passed}/${testCases.length}`);
  console.log(`Failed: ${failed}/${testCases.length}`);
  
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
