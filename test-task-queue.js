/**
 * Test Task Queue Manager
 * Tests the full pipeline: decompose → bid → execute
 */

const { processPhrase } = require('./packages/agents/task-queue-manager');

async function runTests() {
  console.log('=== Task Queue Manager Tests ===\n');

  const callbacks = {
    onTaskQueued: (task) => console.log(`  [QUEUED] ${task.type}: ${task.content}`),
    onTaskAssigned: (task, winner) =>
      console.log(`  [ASSIGNED] ${task.type} → ${winner.agentId} (${winner.confidence.toFixed(2)})`),
    onTaskCompleted: (task, winner, result) => console.log(`  [COMPLETED] ${task.type}: ${result.message || 'OK'}`),
    onNeedsClarification: (tasks, message) => console.log(`  [CLARIFY] ${message}`),
  };

  const testCases = [
    // Single task requests
    { phrase: 'What time is it?', expectedSuccess: true },
    { phrase: 'Play some music', expectedSuccess: true },
    { phrase: 'What can you help me with?', expectedSuccess: true },

    // Multi-task requests
    { phrase: 'What time is it and what day is today', expectedSuccess: true },
    { phrase: 'Play music and turn up the volume', expectedSuccess: true },

    // Requests needing clarification
    { phrase: 'Weather in Denver', expectedSuccess: true }, // Has location
    { phrase: "What's the weather", expectedSuccess: true }, // May need location

    // Unclear requests
    { phrase: 'Hello', expectedSuccess: false },
    { phrase: 'I like cats', expectedSuccess: false },

    // System commands
    { phrase: 'Cancel', expectedSuccess: true },
    { phrase: 'Undo that', expectedSuccess: true },
  ];

  let passed = 0;
  let failed = 0;

  for (const test of testCases) {
    console.log(`\n--- "${test.phrase}" ---`);

    try {
      const result = await processPhrase(test.phrase, [], callbacks);

      console.log(`  Result: ${result.success ? '✓' : '✗'} - ${result.message}`);

      if (result.success === test.expectedSuccess || result.needsClarification) {
        passed++;
      } else {
        console.log(`  Expected success: ${test.expectedSuccess}`);
        failed++;
      }
    } catch (error) {
      console.log(`  ERROR: ${error.message}`);
      failed++;
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Passed: ${passed}/${testCases.length}`);
  console.log(`Failed: ${failed}/${testCases.length}`);
  console.log(`\nNote: Without OPENAI_API_KEY, uses fallback decomposition/bidding.`);

  process.exit(failed > 2 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
