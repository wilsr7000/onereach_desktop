/**
 * Integration Test - Full Exchange + Agent Flow
 * 
 * Tests the complete auction cycle:
 * 1. Start exchange
 * 2. Connect agent
 * 3. Submit task
 * 4. Agent bids
 * 5. Agent executes
 * 6. Task completes
 */

import { createExchange, TaskPriority, TaskStatus } from './task-exchange/src/index.js';
import { createAgent, createKeywordMatcher } from './task-agent/src/index.js';
import type { Task, TaskResult, ExecutionContext } from './task-exchange/src/types/index.js';

// Test utilities
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// Track test results
const results: { name: string; passed: boolean; error?: string }[] = [];

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`  ${name}... `);
  try {
    await fn();
    console.log('✓');
    results.push({ name, passed: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(`✗ (${msg})`);
    results.push({ name, passed: false, error: msg });
  }
}

async function main() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('                  INTEGRATION TEST SUITE');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 1: Exchange Startup
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('1. EXCHANGE STARTUP');
  console.log('───────────────────────────────────────────────────────────────');

  let exchange: Awaited<ReturnType<typeof createExchange>> | null = null;

  await runTest('Exchange starts successfully', async () => {
    exchange = await createExchange({
      port: 3457,
      storage: 'memory',
      categories: [
        { name: 'test', keywords: ['test', 'hello', 'echo'] },
        { name: 'math', keywords: ['add', 'subtract', 'multiply'] },
      ],
      auction: {
        defaultWindowMs: 300,
        minWindowMs: 100,
        maxWindowMs: 1000,
        maxAuctionAttempts: 2,
        executionTimeoutMs: 5000,
        instantWinThreshold: 0.9,
        dominanceMargin: 0.3,
      },
    });
    
    assert(exchange !== null, 'Exchange should be created');
  });

  await runTest('Exchange is running', async () => {
    const stats = exchange!.exchange.getQueueStats();
    assert(stats.depth.total === 0, 'Queue should be empty');
    assert(stats.activeAuctions === 0, 'No active auctions');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 2: Agent Connection
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n2. AGENT CONNECTION');
  console.log('───────────────────────────────────────────────────────────────');

  let testAgent: ReturnType<typeof createAgent> | null = null;
  let agentConnected = false;
  let taskExecuted = false;
  let executedTaskContent = '';

  await runTest('Agent connects to exchange', async () => {
    testAgent = createAgent({
      name: 'test-agent',
      version: '1.0.0',
      categories: ['test'],
      exchange: {
        url: 'ws://localhost:3457',
        reconnect: false,
      },
      quickMatch: createKeywordMatcher(['test', 'hello', 'echo']),
      execute: async (task: Task, ctx: ExecutionContext): Promise<TaskResult> => {
        console.log(`\n    [TestAgent] Executing: "${task.content}"`);
        taskExecuted = true;
        executedTaskContent = task.content;
        await sleep(100);
        return {
          success: true,
          data: { message: `Echo: ${task.content}`, executed: true },
        };
      },
    });

    testAgent.on('connected', () => { agentConnected = true; });
    testAgent.on('error', ({ error }) => { console.log(`    [TestAgent] Error: ${error.message}`); });

    await testAgent.start();
    await sleep(500); // Wait for registration
    
    assert(agentConnected, 'Agent should be connected');
  });

  await runTest('Agent appears in registry', async () => {
    const agents = exchange!.exchange.agents.getAll();
    assert(agents.length >= 1, 'Should have at least 1 agent');
    
    const found = agents.find(a => a.id === 'test-agent');
    assert(found !== undefined, 'test-agent should be registered');
    assert(found!.healthy === true, 'Agent should be healthy');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 3: Task Submission & Auction
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n3. TASK SUBMISSION & AUCTION');
  console.log('───────────────────────────────────────────────────────────────');

  let submittedTaskId = '';

  await runTest('Task submission succeeds', async () => {
    const { taskId, task } = await exchange!.exchange.submit({
      content: 'test hello world',
      priority: TaskPriority.NORMAL,
    });
    
    submittedTaskId = taskId;
    assert(taskId !== '', 'Should get task ID');
    assert(task.status === TaskStatus.PENDING || task.status === TaskStatus.OPEN, 'Task should be pending or open');
  });

  await runTest('Auction completes and task settles', async () => {
    // Wait for auction + execution
    await sleep(2000);
    
    const task = exchange!.exchange.getTask(submittedTaskId);
    assert(task !== null, 'Task should exist');
    console.log(`    Task status: ${task!.status}`);
    assert(task!.status === TaskStatus.SETTLED, `Task should be settled (got: ${task!.status})`);
  });

  await runTest('Agent executed the task', async () => {
    assert(taskExecuted, 'Task should have been executed by agent');
    assert(executedTaskContent === 'test hello world', 'Agent should receive correct content');
  });

  await runTest('Task has result', async () => {
    const task = exchange!.exchange.getTask(submittedTaskId);
    assert(task!.result !== null, 'Task should have result');
    assert(task!.result!.success === true, 'Result should be successful');
    assert((task!.result!.data as any).executed === true, 'Should have executed flag');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 4: Reputation Tracking
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n4. REPUTATION TRACKING');
  console.log('───────────────────────────────────────────────────────────────');

  await runTest('Agent reputation updated', async () => {
    const rep = await exchange!.exchange.reputation.get('test-agent', '1.0.0');
    assert(rep.totalTasks >= 1, 'Should have at least 1 task');
    assert(rep.successCount >= 1, 'Should have at least 1 success');
    assert(rep.score >= 1.0, 'Score should be at max');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 5: No-Match Task (Dead Letter)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n5. NO-MATCH TASK');
  console.log('───────────────────────────────────────────────────────────────');

  await runTest('Unmatched task goes to dead letter', async () => {
    const { taskId } = await exchange!.exchange.submit({
      content: 'xyzzy foobar unknown command',
      priority: TaskPriority.NORMAL,
    });
    
    // Wait for auction attempts
    await sleep(3000);
    
    const task = exchange!.exchange.getTask(taskId);
    console.log(`    Task status: ${task?.status}`);
    // Should be halted (no agents bid) or dead_letter (all failed)
    assert(
      task?.status === TaskStatus.HALTED || task?.status === TaskStatus.DEAD_LETTER,
      `Task should be halted or dead-lettered (got: ${task?.status})`
    );
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 6: Multiple Tasks
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n6. MULTIPLE TASKS');
  console.log('───────────────────────────────────────────────────────────────');

  await runTest('Multiple tasks process correctly', async () => {
    taskExecuted = false;
    let completedCount = 0;
    
    // Submit 3 tasks
    const tasks = await Promise.all([
      exchange!.exchange.submit({ content: 'test task 1', priority: TaskPriority.NORMAL }),
      exchange!.exchange.submit({ content: 'test task 2', priority: TaskPriority.NORMAL }),
      exchange!.exchange.submit({ content: 'test task 3', priority: TaskPriority.NORMAL }),
    ]);
    
    // Wait for all to complete
    await sleep(5000);
    
    for (const { taskId } of tasks) {
      const task = exchange!.exchange.getTask(taskId);
      if (task?.status === TaskStatus.SETTLED) {
        completedCount++;
      }
    }
    
    console.log(`    Completed: ${completedCount}/3`);
    assert(completedCount === 3, `All 3 tasks should complete (got: ${completedCount})`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n7. CLEANUP');
  console.log('───────────────────────────────────────────────────────────────');

  await runTest('Agent stops cleanly', async () => {
    if (testAgent) {
      await testAgent.stop();
    }
  });

  await runTest('Exchange shuts down cleanly', async () => {
    if (exchange) {
      await exchange.shutdown(2000);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // RESULTS
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('                         RESULTS');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  if (failed > 0) {
    console.log('Failed tests:');
    results.filter(r => !r.passed).forEach(r => {
      console.log(`  - ${r.name}: ${r.error}`);
    });
    console.log('');
  }

  console.log(`Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
  console.log('');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('Test suite error:', error);
  process.exit(1);
});
