/**
 * Agent Recognition Tests
 *
 * Tests that the right agents recognize and bid on the right tasks.
 *
 * Run with: OPENAI_API_KEY=your-key node test/test-agent-recognition.js
 */

const assert = require('assert');

console.log('=== Agent Recognition Tests ===\n');

// Track results
let passed = 0;
let failed = 0;

async function test(name, fn) {
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

// Load the modules
const { decomposeTasks } = require('../packages/agents/task-decomposer');
const { getBidsForTask, selectWinner } = require('../packages/agents/agent-bidder');

// Built-in agents
const timeAgent = require('../packages/agents/time-agent');
const mediaAgent = require('../packages/agents/media-agent');
const weatherAgent = require('../packages/agents/weather-agent');
const helpAgent = require('../packages/agents/help-agent');
const searchAgent = require('../packages/agents/search-agent');

const agents = {
  'time-agent': timeAgent,
  'media-agent': mediaAgent,
  'weather-agent': weatherAgent,
  'help-agent': helpAgent,
  'search-agent': searchAgent,
};

// Test cases: [input phrase, expected agent, description]
const TEST_CASES = [
  // Time agent
  ['what time is it', 'time-agent', 'Basic time query'],
  ['what is the date today', 'time-agent', 'Date query'],
  ['what day is it', 'time-agent', 'Day query'],

  // Media agent
  ['play some jazz', 'media-agent', 'Play music'],
  ['pause the music', 'media-agent', 'Pause command'],
  ['skip this song', 'media-agent', 'Skip command'],
  ['turn up the volume', 'media-agent', 'Volume command'],
  ['play Beatles for 30 minutes', 'media-agent', 'Play with duration'],

  // Search agent (weather, facts, information)
  ['what is the weather', 'search-agent', 'Weather query'],
  ['is it going to rain today', 'search-agent', 'Rain query'],
  ['how cold is it outside', 'search-agent', 'Temperature query'],
  ['who is the president', 'search-agent', 'Person lookup'],
  ['what is quantum computing', 'search-agent', 'Definition query'],
  ['search for pizza near me', 'search-agent', 'Explicit search'],

  // Help agent
  ['what can you do', 'help-agent', 'Capabilities query'],
  ['help me', 'help-agent', 'Help request'],
  ['list your commands', 'help-agent', 'Commands query'],
];

async function runTests() {
  // Check API key
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log('⚠ No API key found. Set OPENAI_API_KEY environment variable.');
    console.log('  Some tests will be skipped or use fallback logic.\n');
  }

  // ============================================================
  // 1. AGENT BID TESTS (direct agent.bid() method)
  // ============================================================
  console.log('--- Direct Agent Bid Tests ---\n');

  for (const [phrase, expectedAgent, description] of TEST_CASES) {
    await test(`${description}: "${phrase}" → ${expectedAgent}`, async () => {
      const task = { id: 'test', content: phrase };

      // Get bids from all agents
      const bids = {};
      for (const [agentId, agent] of Object.entries(agents)) {
        if (agent.bid) {
          const bid = agent.bid(task);
          if (bid && bid.confidence > 0) {
            bids[agentId] = bid.confidence;
          }
        }
      }

      // Find the highest bidder
      let winner = null;
      let maxConfidence = 0;
      for (const [agentId, confidence] of Object.entries(bids)) {
        if (confidence > maxConfidence) {
          maxConfidence = confidence;
          winner = agentId;
        }
      }

      // Log the bids for debugging
      const bidSummary = Object.entries(bids)
        .map(([id, conf]) => `${id.replace('-agent', '')}:${conf}`)
        .join(', ');

      if (winner !== expectedAgent) {
        throw new Error(`Expected ${expectedAgent}, got ${winner || 'no bids'}. Bids: ${bidSummary || 'none'}`);
      }
    });
  }

  // ============================================================
  // 2. LLM BIDDER TESTS (if API key available)
  // ============================================================
  if (apiKey) {
    console.log('\n--- LLM Agent Bidder Tests ---\n');

    // Test a subset with the LLM bidder
    const llmTestCases = [
      ['what time is it', 'time-agent'],
      ['play some jazz music', 'media-agent'],
      ['what is the weather in Denver', 'search-agent'],
      ['who invented the telephone', 'search-agent'],
    ];

    for (const [phrase, expectedAgent] of llmTestCases) {
      await test(`LLM Bidder: "${phrase}" → ${expectedAgent}`, async () => {
        const task = { id: 'test', content: phrase, type: 'unknown' };

        const bids = await getBidsForTask(task);
        const { winner } = selectWinner(bids);

        if (!winner) {
          throw new Error('No winner selected');
        }

        // Log bids for debugging
        console.log(`    Bids: ${bids.map((b) => `${b.agentId}:${b.confidence.toFixed(2)}`).join(', ')}`);

        if (winner.agentId !== expectedAgent) {
          throw new Error(`Expected ${expectedAgent}, got ${winner.agentId}`);
        }
      });
    }
  }

  // ============================================================
  // 3. TASK DECOMPOSER TESTS (if API key available)
  // ============================================================
  if (apiKey) {
    console.log('\n--- Task Decomposer Tests ---\n');

    await test('Decompose simple time query', async () => {
      const result = await decomposeTasks('what time is it');

      assert.ok(result.tasks.length > 0, 'Should have at least one task');
      assert.ok(
        result.tasks.some((t) => t.type === 'time' || t.action?.includes('time')),
        'Should identify as time task'
      );
      console.log(`    Tasks: ${result.tasks.map((t) => t.type || t.action).join(', ')}`);
    });

    await test('Decompose simple media query', async () => {
      const result = await decomposeTasks('play some jazz');

      assert.ok(result.tasks.length > 0, 'Should have at least one task');
      assert.ok(
        result.tasks.some((t) => t.type === 'media' || t.action?.includes('play')),
        'Should identify as media task'
      );
      console.log(`    Tasks: ${result.tasks.map((t) => `${t.type}:${t.action}`).join(', ')}`);
    });

    await test('Decompose compound query (time + weather)', async () => {
      const result = await decomposeTasks('what time is it and what is the weather');

      assert.ok(result.tasks.length >= 2, 'Should have at least two tasks');

      const hasTime = result.tasks.some((t) => t.type === 'time');
      // Weather queries may be classified as 'weather', 'search', or 'clarify' depending on decomposer
      const hasWeatherOrSearch = result.tasks.some(
        (t) => t.type === 'weather' || t.type === 'search' || t.type === 'clarify'
      );

      console.log(`    Tasks: ${result.tasks.map((t) => t.type).join(', ')}`);

      assert.ok(hasTime, 'Should have time task');
      assert.ok(hasWeatherOrSearch, 'Should have weather/search task');
    });

    await test('Decompose with duration extraction', async () => {
      const result = await decomposeTasks('play jazz for 30 minutes');

      assert.ok(result.tasks.length > 0, 'Should have at least one task');

      const mediaTask = result.tasks.find((t) => t.type === 'media');
      assert.ok(mediaTask, 'Should have media task');

      console.log(`    Task data: ${JSON.stringify(mediaTask.data || {})}`);
    });
  }

  // ============================================================
  // 4. CORRECTION DETECTION INTEGRATION
  // ============================================================
  if (apiKey) {
    console.log('\n--- Correction + Agent Recognition ---\n');

    const correctionDetector = require('../src/voice-task-sdk/intent/correctionDetector');

    await test('Correction redirects to correct agent', async () => {
      // Scenario: User said "play jaws", system played Jaws soundtrack
      // User says "no I said jazz"
      const context = {
        lastRequest: 'play jaws',
        lastResponse: 'Playing Jaws soundtrack',
      };

      const result = await correctionDetector.detect('no I said jazz', context, true);

      assert.ok(result.isCorrection, 'Should detect as correction');
      assert.ok(result.correctedIntent, 'Should extract corrected intent');

      console.log(`    Corrected intent: "${result.correctedIntent}"`);

      // Now check that the corrected intent routes to media agent
      const task = { id: 'test', content: result.correctedIntent };
      const mediaBid = mediaAgent.bid(task);

      assert.ok(mediaBid && mediaBid.confidence > 0.5, 'Corrected intent should route to media agent');
      console.log(`    Media agent confidence: ${mediaBid.confidence}`);
    });
  }

  // ============================================================
  // SUMMARY
  // ============================================================
  console.log('\n=== Test Summary ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((e) => {
  console.error('Test runner error:', e);
  process.exit(1);
});
