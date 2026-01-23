/**
 * Exchange Unit Tests
 */

import { Exchange } from '../exchange/exchange.js';
import { OrderBook } from '../exchange/order-book.js';
import { CategoryIndex } from '../exchange/categories.js';
import { ReputationStore } from '../reputation/store.js';
import { PriorityQueue } from '../queue/priority-queue.js';
import { RateLimiter } from '../queue/rate-limiter.js';
import { MemoryStorage } from '../storage/memory.js';
import { TaskStatus, TaskPriority } from '../types/index.js';

// Simple test runner
const tests: { name: string; fn: () => Promise<void> }[] = [];
let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

async function runTests() {
  console.log('\n=== Exchange Unit Tests ===\n');
  
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`✓ ${name}`);
      passed++;
    } catch (error) {
      console.log(`✗ ${name}`);
      console.log(`  Error: ${error instanceof Error ? error.message : error}`);
      failed++;
    }
  }
  
  console.log(`\n${passed} passed, ${failed} failed\n`);
  return failed === 0;
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

// =============================================================================
// OrderBook Tests
// =============================================================================

test('OrderBook: accepts valid bids', async () => {
  const ob = new OrderBook('auction-1');
  
  const accepted = await ob.submitBid({
    agentId: 'agent-1',
    agentVersion: '1.0.0',
    confidence: 0.8,
    reasoning: 'I can handle this',
    estimatedTimeMs: 500,
    timestamp: Date.now(),
    tier: 'keyword',
  });
  
  assert(accepted, 'Bid should be accepted');
  assertEqual(ob.getBidCount(), 1, 'Should have 1 bid');
});

test('OrderBook: normalizes confidence to tick size', async () => {
  const ob = new OrderBook('auction-2');
  
  await ob.submitBid({
    agentId: 'agent-1',
    agentVersion: '1.0.0',
    confidence: 0.73, // Should normalize to 0.75
    reasoning: 'Test',
    estimatedTimeMs: 500,
    timestamp: Date.now(),
    tier: 'keyword',
  });
  
  const bids = ob.getBids();
  const bid = bids.get('agent-1');
  assertEqual(bid?.confidence, 0.75, 'Confidence should be normalized to 0.75');
});

test('OrderBook: rejects bids below minimum', async () => {
  const ob = new OrderBook('auction-3');
  
  const accepted = await ob.submitBid({
    agentId: 'agent-1',
    agentVersion: '1.0.0',
    confidence: 0.01, // Below minimum 0.05
    reasoning: 'Test',
    estimatedTimeMs: 500,
    timestamp: Date.now(),
    tier: 'keyword',
  });
  
  assert(!accepted, 'Bid should be rejected');
  assertEqual(ob.getBidCount(), 0, 'Should have 0 bids');
});

test('OrderBook: rejects bids after close', async () => {
  const ob = new OrderBook('auction-4');
  await ob.close();
  
  const accepted = await ob.submitBid({
    agentId: 'agent-1',
    agentVersion: '1.0.0',
    confidence: 0.8,
    reasoning: 'Test',
    estimatedTimeMs: 500,
    timestamp: Date.now(),
    tier: 'keyword',
  });
  
  assert(!accepted, 'Bid should be rejected after close');
});

test('OrderBook: ranks bids by score', async () => {
  const ob = new OrderBook('auction-5');
  const storage = new MemoryStorage();
  const repStore = new ReputationStore(storage);
  
  // Submit bids with different confidences
  await ob.submitBid({
    agentId: 'low',
    agentVersion: '1.0.0',
    confidence: 0.5,
    reasoning: 'Low',
    estimatedTimeMs: 500,
    timestamp: Date.now(),
    tier: 'keyword',
  });
  
  await ob.submitBid({
    agentId: 'high',
    agentVersion: '1.0.0',
    confidence: 0.9,
    reasoning: 'High',
    estimatedTimeMs: 500,
    timestamp: Date.now(),
    tier: 'keyword',
  });
  
  await ob.close();
  const ranked = await ob.evaluateAndRank(repStore);
  
  assertEqual(ranked[0].agentId, 'high', 'Highest confidence should be #1');
  assertEqual(ranked[1].agentId, 'low', 'Lower confidence should be #2');
});

// =============================================================================
// CategoryIndex Tests
// =============================================================================

test('CategoryIndex: matches keywords', async () => {
  const index = new CategoryIndex([
    { name: 'spelling', keywords: ['spell', 'spelling', 'letters'] },
    { name: 'math', keywords: ['calculate', 'add', 'subtract'] },
  ]);
  
  const task = {
    id: 'task-1',
    content: 'spell the word hello',
    status: TaskStatus.PENDING,
    priority: TaskPriority.NORMAL,
  } as any;
  
  const categories = index.findCategories(task);
  
  assert(categories.includes('spelling'), 'Should match spelling category');
  assert(!categories.includes('math'), 'Should not match math category');
});

test('CategoryIndex: returns unique agents', async () => {
  const index = new CategoryIndex([
    { name: 'cat1', keywords: ['word1'] },
    { name: 'cat2', keywords: ['word2'] },
  ]);
  
  // Agent in both categories
  index.addAgent('agent-1', ['cat1', 'cat2']);
  
  const task = {
    id: 'task-1',
    content: 'word1 word2', // Matches both
    status: TaskStatus.PENDING,
    priority: TaskPriority.NORMAL,
  } as any;
  
  const agents = index.getAgentsForTask(task);
  
  // Should be deduplicated
  assertEqual(agents.size, 1, 'Should have 1 unique agent');
  assert(agents.has('agent-1'), 'Should contain agent-1');
});

// =============================================================================
// ReputationStore Tests
// =============================================================================

test('ReputationStore: creates initial reputation', async () => {
  const storage = new MemoryStorage();
  const store = new ReputationStore(storage);
  
  const rep = await store.get('new-agent', '1.0.0');
  
  assertEqual(rep.score, 1.0, 'Initial score should be 1.0');
  assertEqual(rep.totalTasks, 0, 'Initial tasks should be 0');
});

test('ReputationStore: increases score on success', async () => {
  const storage = new MemoryStorage();
  const store = new ReputationStore(storage);
  
  await store.get('agent-1', '1.0.0'); // Initialize
  await store.recordSuccess('agent-1', '1.0.0');
  
  const rep = await store.get('agent-1', '1.0.0');
  
  assertEqual(rep.totalTasks, 1, 'Should have 1 task');
  assertEqual(rep.successCount, 1, 'Should have 1 success');
  // Score stays at 1.0 (max) for first success
});

test('ReputationStore: decreases score on failure', async () => {
  const storage = new MemoryStorage();
  const store = new ReputationStore(storage);
  
  await store.get('agent-1', '1.0.0');
  await store.recordFailure('agent-1', '1.0.0', { isTimeout: false, error: 'test' });
  
  const rep = await store.get('agent-1', '1.0.0');
  
  assertEqual(rep.failCount, 1, 'Should have 1 failure');
  assert(rep.score < 1.0, 'Score should decrease');
});

test('ReputationStore: flags agent below threshold', async () => {
  const storage = new MemoryStorage();
  const store = new ReputationStore(storage, { flagThreshold: 0.9 });
  
  let flagged = false;
  store.on('agent:flagged', () => { flagged = true; });
  
  await store.get('agent-1', '1.0.0');
  // Multiple failures to drop below threshold
  for (let i = 0; i < 5; i++) {
    await store.recordFailure('agent-1', '1.0.0', { isTimeout: false, error: 'test' });
  }
  
  const rep = await store.get('agent-1', '1.0.0');
  
  assert(rep.flaggedForReview, 'Agent should be flagged');
  assert(flagged, 'Should emit flagged event');
});

// =============================================================================
// PriorityQueue Tests
// =============================================================================

test('PriorityQueue: urgent tasks first', async () => {
  const queue = new PriorityQueue();
  
  queue.enqueue({ id: 'normal', priority: TaskPriority.NORMAL } as any);
  queue.enqueue({ id: 'urgent', priority: TaskPriority.URGENT } as any);
  queue.enqueue({ id: 'low', priority: TaskPriority.LOW } as any);
  
  const first = queue.dequeue();
  const second = queue.dequeue();
  const third = queue.dequeue();
  
  assertEqual(first?.id, 'urgent', 'First should be urgent');
  assertEqual(second?.id, 'normal', 'Second should be normal');
  assertEqual(third?.id, 'low', 'Third should be low');
});

test('PriorityQueue: escalate moves to urgent', async () => {
  const queue = new PriorityQueue();
  
  queue.enqueue({ id: 'task-1', priority: TaskPriority.NORMAL } as any);
  queue.escalate('task-1');
  
  const task = queue.peek();
  
  assertEqual(task?.priority, TaskPriority.URGENT, 'Should be escalated to urgent');
});

// =============================================================================
// RateLimiter Tests
// =============================================================================

test('RateLimiter: allows within limit', async () => {
  const limiter = new RateLimiter({ maxTasksPerMinute: 10 });
  
  const result = limiter.canSubmit();
  
  assert(result.allowed, 'Should be allowed');
});

test('RateLimiter: blocks when exceeded', async () => {
  const limiter = new RateLimiter({ maxTasksPerMinute: 2 });
  
  limiter.recordSubmission();
  limiter.recordSubmission();
  
  const result = limiter.canSubmit();
  
  assert(!result.allowed, 'Should be blocked');
  assert(result.retryAfterMs !== undefined, 'Should have retry time');
});

// =============================================================================
// Run Tests
// =============================================================================

runTests().then(success => {
  process.exit(success ? 0 : 1);
});
