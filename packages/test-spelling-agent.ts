/**
 * Test harness for the Spelling Agent
 * 
 * Spins up an exchange and the spelling agent, then submits test tasks
 */

import { createExchange, TaskPriority } from './task-exchange/src/index.js';
import { createSpellingAgent } from './agents/spelling-agent.js';

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('='.repeat(60));
  console.log('SPELLING AGENT TEST');
  console.log('='.repeat(60));
  console.log();

  // 1. Start Exchange
  console.log('[Test] Starting exchange on port 3000...');
  const { exchange, shutdown } = await createExchange({
    port: 3000,
    storage: 'memory',
    categories: [
      { name: 'spelling', keywords: ['spell', 'spelling', 'spelled', 'letters', 'write'] },
      { name: 'language', keywords: ['word', 'words', 'language', 'grammar'] },
    ],
  });

  // Listen for exchange events
  exchange.on('task:queued', ({ task }) => {
    console.log(`[Exchange] Task queued: ${task.id.slice(0, 8)}... - "${task.content}"`);
  });

  exchange.on('auction:started', ({ task, auctionId }) => {
    console.log(`[Exchange] Auction started: ${auctionId.slice(0, 8)}...`);
  });

  exchange.on('auction:candidates', ({ agents }) => {
    console.log(`[Exchange] Bidding agents: ${agents.join(', ') || 'none'}`);
  });

  exchange.on('task:assigned', ({ task, winner }) => {
    console.log(`[Exchange] Winner: ${winner.agentId} (confidence: ${winner.confidence}, score: ${winner.score.toFixed(3)})`);
  });

  exchange.on('task:settled', ({ task, result, agentId }) => {
    console.log(`[Exchange] Task settled by ${agentId}`);
    console.log(`[Exchange] Result:`, JSON.stringify(result.data, null, 2));
  });

  exchange.on('task:dead_letter', ({ task, reason }) => {
    console.error(`[Exchange] DEAD LETTER: ${task.id} - ${reason}`);
  });

  console.log('[Test] Exchange started\n');

  // 2. Start Spelling Agent
  console.log('[Test] Starting spelling agent...');
  const agent = createSpellingAgent('ws://localhost:3000');
  
  agent.on('connected', () => console.log('[Agent] Connected'));
  agent.on('registered', () => console.log('[Agent] Registered'));
  agent.on('bid:submitted', ({ confidence }) => console.log(`[Agent] Bid: ${confidence}`));
  agent.on('task:completed', ({ success }) => console.log(`[Agent] Task ${success ? 'SUCCESS' : 'FAILED'}`));

  await agent.start();
  console.log('[Test] Spelling agent started\n');

  // Wait for registration
  await sleep(500);

  // 3. Run Test Cases
  console.log('='.repeat(60));
  console.log('RUNNING TEST CASES');
  console.log('='.repeat(60));
  console.log();

  const testCases = [
    'Spell the word "necessary"',
    'How do you spell "rhythm"?',
    'Is "recieve" spelled correctly?',
    'Spell "Mississippi"',
    'Is "definitely" spelled right?',
  ];

  for (let i = 0; i < testCases.length; i++) {
    const testCase = testCases[i];
    console.log(`\n--- Test ${i + 1}: "${testCase}" ---\n`);
    
    const { taskId } = await exchange.submit({
      content: testCase,
      priority: TaskPriority.NORMAL,
    });

    // Wait for task to complete
    await sleep(2000);

    // Check final status
    const task = exchange.getTask(taskId);
    console.log(`[Test] Final status: ${task?.status || 'unknown'}`);
    console.log();
  }

  // 4. Print summary
  console.log('='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));

  const stats = exchange.getQueueStats();
  console.log('Queue stats:', stats);

  const repSummary = await exchange.reputation.getSummary();
  console.log('Reputation:', Object.fromEntries(repSummary));

  // 5. Cleanup
  console.log('\n[Test] Shutting down...');
  await agent.stop();
  await shutdown();
  console.log('[Test] Done!');
}

main().catch((error) => {
  console.error('Test failed:', error);
  process.exit(1);
});
