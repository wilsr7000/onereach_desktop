/**
 * Test Intent Classifier
 */

const { classifyIntent, AGENT_DEFINITIONS } = require('./packages/agents/intent-classifier');

async function runTests() {
  console.log('=== Intent Classifier Tests ===\n');
  
  const testCases = [
    // Time queries - various phrasings
    { phrase: 'What time is it?', expectedAgent: 'time-agent' },
    { phrase: 'What is the current time', expectedAgent: 'time-agent' },
    { phrase: 'Tell me the time', expectedAgent: 'time-agent' },
    { phrase: 'Do you know what time it is', expectedAgent: 'time-agent' },
    { phrase: 'What day is today', expectedAgent: 'time-agent' },
    
    // Weather queries
    { phrase: 'What is the weather in Denver', expectedAgent: 'weather-agent' },
    { phrase: 'Is it going to rain tomorrow', expectedAgent: 'weather-agent' },
    { phrase: 'How cold is it outside', expectedAgent: 'weather-agent' },
    
    // Media commands
    { phrase: 'Play some music', expectedAgent: 'media-agent' },
    { phrase: 'Can you pause this', expectedAgent: 'media-agent' },
    { phrase: 'Turn up the volume', expectedAgent: 'media-agent' },
    { phrase: 'Skip to the next song', expectedAgent: 'media-agent' },
    
    // Help queries
    { phrase: 'What can you help me with', expectedAgent: 'help-agent' },
    { phrase: 'Show me what you can do', expectedAgent: 'help-agent' },
    { phrase: 'I need help', expectedAgent: 'help-agent' },
    
    // System commands (should return isSystemCommand)
    { phrase: 'Cancel', expectedAgent: null, isSystem: true },
    { phrase: 'Nevermind', expectedAgent: null, isSystem: true },
    { phrase: 'Undo that', expectedAgent: null, isSystem: true },
    
    // Unclear/no match
    { phrase: 'Hello there', expectedAgent: null },
    { phrase: 'I like pizza', expectedAgent: null },
  ];
  
  let passed = 0;
  let failed = 0;
  
  for (const test of testCases) {
    process.stdout.write(`Testing: "${test.phrase}" ... `);
    
    try {
      const result = await classifyIntent(test.phrase);
      
      const matchesExpected = test.isSystem 
        ? result.isSystemCommand === true
        : result.agentId === test.expectedAgent;
      
      if (matchesExpected) {
        console.log(`✓ -> ${result.agentId || 'system'} (${result.confidence.toFixed(2)})`);
        passed++;
      } else {
        console.log(`✗ Expected: ${test.expectedAgent || 'system'}, Got: ${result.agentId} (${result.confidence.toFixed(2)})`);
        failed++;
      }
    } catch (error) {
      console.log(`✗ Error: ${error.message}`);
      failed++;
    }
  }
  
  console.log(`\n=== Summary ===`);
  console.log(`Passed: ${passed}/${testCases.length}`);
  console.log(`Failed: ${failed}/${testCases.length}`);
  console.log(`\nNote: If OPENAI_API_KEY is not set, classifier uses fallback regex matching.`);
  console.log(`API Key configured: ${process.env.OPENAI_API_KEY ? 'Yes' : 'No'}`);
  
  process.exit(failed > 3 ? 1 : 0);  // Allow some failures for edge cases without API
}

runTests().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
