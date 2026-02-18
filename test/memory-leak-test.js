/**
 * Memory Leak Test Suite
 *
 * This test helps identify memory leaks by repeatedly performing
 * operations and measuring memory growth.
 *
 * Usage:
 *   # Run with garbage collection exposed
 *   electron --expose-gc test/memory-leak-test.js
 *
 *   # Or from the main process console
 *   require('./test/memory-leak-test').runAllTests()
 *
 * For renderer process testing:
 *   1. Open DevTools (Cmd+Shift+I)
 *   2. Go to Memory tab
 *   3. Take heap snapshot before operations
 *   4. Perform operations (open/close windows, clipboard operations)
 *   5. Force GC (trash icon)
 *   6. Take heap snapshot after
 *   7. Compare snapshots in "Comparison" view
 */

const ITERATIONS = 50; // Number of times to repeat each operation
const MEMORY_GROWTH_THRESHOLD = 5 * 1024 * 1024; // 5MB threshold for warning

/**
 * Format bytes to human readable
 */
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

/**
 * Force garbage collection if available
 */
function forceGC() {
  if (global.gc) {
    global.gc();
    return true;
  }
  return false;
}

/**
 * Measure memory before and after an async operation
 */
async function measureOperation(name, operationFn, iterations = ITERATIONS) {
  console.log(`\n=== Testing: ${name} (${iterations} iterations) ===`);

  // Force GC and measure baseline
  forceGC();
  await sleep(100);
  const baseline = process.memoryUsage();
  console.log(`Baseline heap: ${formatBytes(baseline.heapUsed)}`);

  // Run operation multiple times
  const startTime = Date.now();
  for (let i = 0; i < iterations; i++) {
    await operationFn();

    // Progress indicator every 10 iterations
    if ((i + 1) % 10 === 0) {
      process.stdout.write(`  Progress: ${i + 1}/${iterations}\r`);
    }
  }
  console.log(''); // New line after progress

  // Force GC and measure final
  forceGC();
  await sleep(100);
  const final = process.memoryUsage();

  const growth = final.heapUsed - baseline.heapUsed;
  const perIteration = growth / iterations;
  const duration = Date.now() - startTime;

  const result = {
    name,
    iterations,
    duration: `${duration}ms`,
    baseline: formatBytes(baseline.heapUsed),
    final: formatBytes(final.heapUsed),
    growth: formatBytes(growth),
    growthRaw: growth,
    perIteration: formatBytes(perIteration),
    leaked: growth > MEMORY_GROWTH_THRESHOLD,
  };

  console.log(`Final heap: ${result.final}`);
  console.log(`Growth: ${result.growth} (${formatBytes(perIteration)}/iteration)`);

  if (result.leaked) {
    console.warn(`⚠️  WARNING: Potential memory leak detected! Growth exceeds threshold.`);
  } else {
    console.log(`✅ PASSED: Memory growth within acceptable limits.`);
  }

  return result;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ============================================
// Test Cases
// ============================================

/**
 * Test IPC message sending (main process)
 */
async function testIPCMessages() {
  const { ipcMain } = require('electron');

  return measureOperation('IPC Message Handling', async () => {
    // Simulate receiving an IPC message
    // This tests if the listener handles are properly managed
    ipcMain.emit('test-memory-event', { sender: {} }, { data: 'test' });
    await sleep(1);
  });
}

/**
 * Test clipboard operations
 */
async function testClipboardOperations() {
  const { clipboard } = require('electron');

  return measureOperation('Clipboard Read/Write', async () => {
    // Write and read text
    clipboard.writeText('Memory test ' + Date.now());
    clipboard.readText();
    await sleep(1);
  });
}

/**
 * Test creating and destroying objects
 */
async function testObjectCreation() {
  return measureOperation('Object Creation/Destruction', async () => {
    // Create large objects that should be GC'd
    let _largeArray = new Array(10000).fill({ data: 'test' });
    _largeArray = null;
    await sleep(1);
  });
}

/**
 * Test buffer operations
 */
async function testBufferOperations() {
  return measureOperation('Buffer Operations', async () => {
    // Create and discard buffers
    let buffer = Buffer.alloc(100 * 1024); // 100KB buffer
    buffer.fill(0);
    buffer = null;
    await sleep(1);
  });
}

/**
 * Test event emitter patterns
 */
async function testEventEmitters() {
  const EventEmitter = require('events');

  return measureOperation('Event Emitter Patterns', async () => {
    const emitter = new EventEmitter();
    const handler = () => {};

    // Add and remove listener (correct pattern)
    emitter.on('test', handler);
    emitter.removeListener('test', handler);

    await sleep(1);
  });
}

/**
 * Test memory utility functions
 */
async function testMemoryUtils() {
  const memUtils = require('../memory-leak-utils');

  return measureOperation('Memory Utils Audit', async () => {
    memUtils.auditIPCListeners();
    memUtils.getMemoryStats();
    memUtils.checkLeakPatterns();
    await sleep(1);
  });
}

// ============================================
// Main Test Runner
// ============================================

async function runAllTests() {
  console.log('================================================');
  console.log('Memory Leak Test Suite');
  console.log('================================================');
  console.log(`GC Available: ${global.gc ? 'Yes' : 'No (run with --expose-gc)'}`);
  console.log(`Iterations per test: ${ITERATIONS}`);
  console.log(`Memory threshold: ${formatBytes(MEMORY_GROWTH_THRESHOLD)}`);
  console.log('');

  const results = [];

  try {
    // Run tests
    results.push(await testObjectCreation());
    results.push(await testBufferOperations());
    results.push(await testEventEmitters());

    // Only run Electron-specific tests if in Electron environment
    if (process.versions.electron) {
      results.push(await testClipboardOperations());
      results.push(await testIPCMessages());
      results.push(await testMemoryUtils());
    }
  } catch (error) {
    console.error('Test error:', error);
  }

  // Summary
  console.log('\n================================================');
  console.log('Test Summary');
  console.log('================================================');

  const passed = results.filter((r) => !r.leaked);
  const failed = results.filter((r) => r.leaked);

  console.log(`Passed: ${passed.length}/${results.length}`);
  console.log(`Failed: ${failed.length}/${results.length}`);

  if (failed.length > 0) {
    console.log('\nPotential leaks detected in:');
    failed.forEach((r) => {
      console.log(`  - ${r.name}: ${r.growth} growth`);
    });
  }

  return results;
}

// Export for use in main process
module.exports = {
  runAllTests,
  measureOperation,
  testObjectCreation,
  testBufferOperations,
  testEventEmitters,
  testClipboardOperations,
  testIPCMessages,
  testMemoryUtils,
  forceGC,
  formatBytes,
};

// Run if called directly
if (require.main === module) {
  runAllTests()
    .then(() => {
      console.log('\nTests completed.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Test failed:', err);
      process.exit(1);
    });
}
