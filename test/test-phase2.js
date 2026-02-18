/**
 * Phase 2 Tests
 *
 * Run with: node test/test-phase2.js
 */

const assert = require('assert');

console.log('=== Phase 2 Tests ===\n');

// Track results
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`✗ ${name}`);
    console.log(`  Error: ${e.message}`);
    failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`✗ ${name}`);
    console.log(`  Error: ${e.message}`);
    failed++;
  }
}

// ============================================================
// 1. CIRCUIT BREAKER TESTS
// ============================================================
console.log('\n--- Circuit Breaker Tests ---');

const { CircuitBreaker, getCircuit, STATES } = require('../packages/agents/circuit-breaker');

test('CircuitBreaker starts in CLOSED state', () => {
  const cb = new CircuitBreaker({ name: 'test1' });
  assert.strictEqual(cb.getState(), STATES.CLOSED);
});

test('CircuitBreaker opens after threshold failures', async () => {
  const cb = new CircuitBreaker({ name: 'test2', failureThreshold: 2 });

  // Simulate failures
  try {
    await cb.execute(() => {
      throw new Error('fail 1');
    });
  } catch (_e) {
    /* no-op */
  }
  assert.strictEqual(cb.getState(), STATES.CLOSED, 'Should still be closed after 1 failure');

  try {
    await cb.execute(() => {
      throw new Error('fail 2');
    });
  } catch (_e) {
    /* no-op */
  }
  assert.strictEqual(cb.getState(), STATES.OPEN, 'Should be open after 2 failures');
});

test('CircuitBreaker rejects calls when open', async () => {
  const cb = new CircuitBreaker({ name: 'test3', failureThreshold: 1, resetTimeout: 60000 });

  // Force open
  try {
    await cb.execute(() => {
      throw new Error('fail');
    });
  } catch (_e) {
    /* no-op */
  }
  assert.strictEqual(cb.getState(), STATES.OPEN);

  // Should reject
  let rejected = false;
  try {
    await cb.execute(() => 'should not run');
  } catch (e) {
    rejected = e.name === 'CircuitOpenError';
  }
  assert.strictEqual(rejected, true, 'Should throw CircuitOpenError');
});

test('CircuitBreaker closes on success after half-open', async () => {
  const cb = new CircuitBreaker({ name: 'test4', failureThreshold: 1, resetTimeout: 10 });

  // Force open
  try {
    await cb.execute(() => {
      throw new Error('fail');
    });
  } catch (_e) {
    /* no-op */
  }
  assert.strictEqual(cb.getState(), STATES.OPEN);

  // Wait for reset timeout
  await new Promise((r) => {
    setTimeout(r, 20);
  });

  // Next call should try half-open and succeed
  const result = await cb.execute(() => 'success');
  assert.strictEqual(result, 'success');
  assert.strictEqual(cb.getState(), STATES.CLOSED, 'Should be closed after success');
});

test('getCircuit returns singleton per name', () => {
  const c1 = getCircuit('singleton-test');
  const c2 = getCircuit('singleton-test');
  assert.strictEqual(c1, c2, 'Should return same instance');
});

// ============================================================
// 2. PROGRESS REPORTER TESTS
// ============================================================
console.log('\n--- Progress Reporter Tests ---');

const progressReporter = require('../src/voice-task-sdk/events/progressReporter');

test('ProgressReporter emits progress events', (_done) => {
  let received = false;
  const handler = (event) => {
    if (event.agentId === 'test-agent' && event.message === 'Testing...') {
      received = true;
    }
  };

  progressReporter.on('progress', handler);
  progressReporter.report('test-agent', 'Testing...', { force: true });
  progressReporter.off('progress', handler);

  assert.strictEqual(received, true, 'Should receive progress event');
});

test('ProgressReporter throttles rapid reports', () => {
  progressReporter.clearThrottle('throttle-test');

  const result1 = progressReporter.report('throttle-test', 'First');
  const result2 = progressReporter.report('throttle-test', 'Second'); // Should be throttled

  assert.strictEqual(result1, true, 'First should succeed');
  assert.strictEqual(result2, false, 'Second should be throttled');
});

test('ProgressReporter started() bypasses throttle', () => {
  progressReporter.clearThrottle('started-test');

  progressReporter.report('started-test', 'First');
  const result = progressReporter.started('started-test', 'Started!');

  assert.strictEqual(result, true, 'started() should bypass throttle');
});

// ============================================================
// 3. NOTIFICATION MANAGER TESTS
// ============================================================
console.log('\n--- Notification Manager Tests ---');

const notificationManager = require('../src/voice-task-sdk/notifications/notificationManager');

test('NotificationManager schedules notifications', () => {
  const id = 'test-notify-1';
  notificationManager.schedule(id, 'Test notification', { delay: 10000 });

  const pending = notificationManager.getPending();
  const found = pending.find((p) => p.id === id);

  assert.ok(found, 'Should find scheduled notification');

  // Clean up
  notificationManager.cancel(id);
});

test('NotificationManager cancels notifications', () => {
  const id = 'test-notify-2';
  notificationManager.schedule(id, 'Will be cancelled', { delay: 10000 });

  const cancelled = notificationManager.cancel(id);
  assert.strictEqual(cancelled, true, 'Should return true for cancelled');

  const pending = notificationManager.getPending();
  const found = pending.find((p) => p.id === id);
  assert.ok(!found, 'Should not find cancelled notification');
});

test('NotificationManager setTimer creates timer notification', () => {
  const timerId = notificationManager.setTimer(60, 'test');

  assert.ok(timerId.startsWith('timer_'), 'Should return timer ID');

  const pending = notificationManager.getPending();
  const found = pending.find((p) => p.id === timerId);
  assert.ok(found, 'Should find timer in pending');
  assert.ok(found.message.includes('timer'), 'Message should mention timer');

  // Clean up
  notificationManager.cancel(timerId);
});

test('NotificationManager DND blocks notifications', () => {
  notificationManager.enableDND();

  let _delivered = false;
  const handler = () => {
    _delivered = true;
  };
  notificationManager.on('notify', handler);

  // Schedule immediate notification
  notificationManager.schedule('dnd-test', 'Should be blocked', { delay: 0 });

  // Give it time to potentially deliver
  setTimeout(() => {
    notificationManager.off('notify', handler);
    notificationManager.disableDND();

    // Should be queued, not delivered
    const pending = notificationManager.getPending();
    const _found = pending.find((p) => p.id === 'dnd-test');

    // Clean up
    notificationManager.cancel('dnd-test');
  }, 50);
});

// ============================================================
// 4. CORRECTION DETECTOR TESTS
// ============================================================
console.log('\n--- Correction Detector Tests ---');

const correctionDetector = require('../src/voice-task-sdk/intent/correctionDetector');

test('mightBeCorrection detects correction hints', () => {
  assert.strictEqual(correctionDetector.mightBeCorrection('no I said jazz'), true);
  assert.strictEqual(correctionDetector.mightBeCorrection('I meant blues'), true);
  assert.strictEqual(correctionDetector.mightBeCorrection('actually rock'), true);
  assert.strictEqual(correctionDetector.mightBeCorrection('not that, classical'), true);
});

test('mightBeCorrection rejects non-corrections', () => {
  assert.strictEqual(correctionDetector.mightBeCorrection('yes'), false);
  assert.strictEqual(correctionDetector.mightBeCorrection('ok'), false);
  assert.strictEqual(correctionDetector.mightBeCorrection('play some jazz'), false);
});

// ============================================================
// 5. ASYNC TESTS (require API key)
// ============================================================
console.log('\n--- Async Tests (API-dependent) ---');

async function runAsyncTests() {
  // Check if API key is available
  const hasApiKey = process.env.OPENAI_API_KEY || global.settingsManager?.get('openaiApiKey');

  if (!hasApiKey) {
    console.log('⚠ Skipping LLM tests - no API key available');
    console.log('  Set OPENAI_API_KEY environment variable to run these tests');
  } else {
    await testAsync('Correction detector analyzes with LLM', async () => {
      const result = await correctionDetector.analyzeWithLLM('no I said jazz not jaws', {
        lastRequest: 'play jaws',
        lastResponse: 'Playing Jaws soundtrack',
      });

      assert.strictEqual(result.isCorrection, true, 'Should detect correction');
      assert.ok(result.correctedIntent, 'Should extract corrected intent');
      assert.ok(result.correctedIntent.toLowerCase().includes('jazz'), 'Should mention jazz');
    });

    await testAsync('Extract intent includes duration', async () => {
      const { extractIntent } = require('../packages/agents/retry-evaluator');

      const result = await extractIntent('play jazz for 30 minutes');

      assert.ok(result.durationSeconds, 'Should extract duration');
      assert.strictEqual(result.durationSeconds, 1800, 'Should be 1800 seconds (30 min)');
    });
  }

  // Final summary
  console.log('\n=== Test Summary ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

runAsyncTests().catch((e) => {
  console.error('Test runner error:', e);
  process.exit(1);
});
