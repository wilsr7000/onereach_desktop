/**
 * Bidding Test Corpus
 * 
 * A collection of test phrases to validate that agents correctly
 * bid on tasks they can handle and ignore tasks they cannot.
 * 
 * Run with: npm run test:corpus
 */

const { MockExchange } = require('../mocks/mock-exchange.js');
const { createKeywordAgent, createMockAgent } = require('../mocks/mock-agent.js');

// ============================================================================
// TEST CORPUS - Phrases organized by expected winning agent
// ============================================================================

const TEST_CORPUS = {
  // Time Agent should win these
  'time-agent': [
    'what time is it',
    'what\'s the time',
    'tell me the time',
    'what is the current time',
    'what day is it',
    'what\'s today\'s date',
    'what is the date today',
    'what month is it',
    'what year is it',
    'what\'s the date',
  ],
  
  // Weather Agent should win these
  'weather-agent': [
    'what\'s the weather',
    'what is the weather like',
    'how\'s the weather today',
    'what\'s the temperature',
    'is it going to rain',
    'weather in New York',
    'what\'s the weather in Denver',
    'temperature outside',
    'is it cold outside',
    'weather forecast',
  ],
  
  // Media Agent should win these
  'media-agent': [
    'play music',
    'play some music',
    'pause the music',
    'stop the music',
    'skip this song',
    'next track',
    'previous song',
    'turn up the volume',
    'volume down',
    'mute',
  ],
  
  // Help Agent should win these
  'help-agent': [
    'help',
    'help me',
    'what can you do',
    'show me what you can do',
    'list your capabilities',
    'what are your features',
    'how do I use this',
    'need help',
    'assist me',
    'what commands are available',
  ],
  
  // Search Agent should win these  
  'search-agent': [
    'search for cats',
    'find information about AI',
    'look up the weather',
    'search the web for recipes',
    'google something',
    'find me a restaurant',
    'search for flights to LA',
    'look for hotels',
    'find cheap tickets',
    'search news about tech',
  ],
  
  // Smalltalk Agent should win these
  'smalltalk-agent': [
    'hello',
    'hi there',
    'good morning',
    'how are you',
    'thanks',
    'thank you',
    'goodbye',
    'see you later',
    'nice to meet you',
    'what\'s your name',
  ],
  
  // Ambiguous - multiple agents might bid
  'ambiguous': [
    'play the weather channel',  // media + weather
    'search for the time in Tokyo',  // search + time
    'help me find music',  // help + search + media
    'what time does it start',  // time but context-dependent
    'look up the temperature',  // search + weather
  ],
  
  // No agent should bid high on these
  'low-confidence': [
    'asdfghjkl',
    'random gibberish here',
    'the quick brown fox',
    'lorem ipsum dolor sit amet',
    'xyzzy plugh',
  ],
};

// ============================================================================
// MOCK AGENTS - Simulate built-in agents with keyword matching
// ============================================================================

function createTestAgents() {
  return {
    'time-agent': createKeywordAgent('time-agent', 
      ['time', 'clock', 'hour', 'date', 'day', 'month', 'year', 'today'],
      { successMessage: 'The time is 3:14 PM' }
    ),
    
    'weather-agent': createKeywordAgent('weather-agent',
      ['weather', 'temperature', 'rain', 'cold', 'hot', 'forecast', 'outside'],
      { successMessage: 'It\'s 72 degrees and sunny' }
    ),
    
    'media-agent': createKeywordAgent('media-agent',
      ['play', 'pause', 'stop', 'music', 'song', 'track', 'volume', 'mute', 'skip', 'next', 'previous'],
      { successMessage: 'Playing music' }
    ),
    
    'help-agent': createKeywordAgent('help-agent',
      ['help', 'assist', 'what can you do', 'capabilities', 'features', 'commands', 'how do'],
      { successMessage: 'I can help with time, weather, music, and more' }
    ),
    
    'search-agent': createKeywordAgent('search-agent',
      ['search', 'find', 'look', 'google', 'look up', 'lookup'],
      { successMessage: 'Found 10 results' }
    ),
    
    'smalltalk-agent': createKeywordAgent('smalltalk-agent',
      ['hello', 'hi', 'hey', 'good morning', 'good afternoon', 'goodbye', 'thanks', 'thank you', 'how are you', 'name'],
      { successMessage: 'Hello! How can I help you?' }
    ),
  };
}

// ============================================================================
// TEST RUNNER
// ============================================================================

async function runCorpusTests() {
  const exchange = new MockExchange({ auctionDelayMs: 1, executionDelayMs: 1 });
  await exchange.start();
  
  // Register all test agents
  const agents = createTestAgents();
  for (const [id, agent] of Object.entries(agents)) {
    exchange.registerAgent(id, {
      bidFn: (task) => agent.bid(task),
      executeFn: (task) => agent.execute(task),
    });
  }
  
  console.log('\n========================================');
  console.log('  DISTRIBUTED BIDDING TEST CORPUS');
  console.log('========================================\n');
  console.log(`Registered ${Object.keys(agents).length} agents\n`);
  
  const results = {
    passed: 0,
    failed: 0,
    ambiguous: 0,
    noBids: 0,
    details: [],
  };
  
  // Run tests for each category
  for (const [expectedAgent, phrases] of Object.entries(TEST_CORPUS)) {
    console.log(`\n--- Testing: ${expectedAgent} ---\n`);
    
    for (const phrase of phrases) {
      const result = await testPhrase(exchange, phrase, expectedAgent);
      results.details.push(result);
      
      if (result.status === 'PASS') {
        results.passed++;
        console.log(`  ✓ "${phrase}"`);
        console.log(`    → ${result.winner} (${(result.confidence * 100).toFixed(0)}%)`);
      } else if (result.status === 'FAIL') {
        results.failed++;
        console.log(`  ✗ "${phrase}"`);
        console.log(`    Expected: ${expectedAgent}, Got: ${result.winner || 'NO BIDS'}`);
      } else if (result.status === 'AMBIGUOUS') {
        results.ambiguous++;
        console.log(`  ? "${phrase}" [AMBIGUOUS - expected]`);
        console.log(`    → ${result.winner} (${(result.confidence * 100).toFixed(0)}%)`);
        if (result.allBids.length > 1) {
          console.log(`    Other bids: ${result.allBids.slice(1).map(b => `${b.agentId}(${(b.confidence * 100).toFixed(0)}%)`).join(', ')}`);
        }
      } else if (result.status === 'NO_BIDS') {
        if (expectedAgent === 'low-confidence') {
          results.passed++;
          console.log(`  ✓ "${phrase}" [NO BIDS - expected]`);
        } else {
          results.noBids++;
          console.log(`  ○ "${phrase}" [NO BIDS]`);
        }
      }
    }
  }
  
  // Print summary
  console.log('\n========================================');
  console.log('  SUMMARY');
  console.log('========================================\n');
  console.log(`  Passed:    ${results.passed}`);
  console.log(`  Failed:    ${results.failed}`);
  console.log(`  Ambiguous: ${results.ambiguous} (expected)`);
  console.log(`  No Bids:   ${results.noBids}`);
  console.log(`  Total:     ${results.details.length}`);
  console.log(`\n  Success Rate: ${((results.passed / (results.passed + results.failed)) * 100).toFixed(1)}%`);
  console.log('');
  
  await exchange.shutdown();
  
  // Return exit code
  return results.failed === 0 ? 0 : 1;
}

async function testPhrase(exchange, phrase, expectedAgent) {
  return new Promise(async (resolve) => {
    let winner = null;
    let allBids = [];
    let settled = false;
    
    const onAssigned = ({ task, winner: w, backups }) => {
      winner = w;
      allBids = [w, ...backups];
    };
    
    const onHalt = () => {
      settled = true;
    };
    
    const onSettled = () => {
      settled = true;
    };
    
    exchange.on('task:assigned', onAssigned);
    exchange.on('exchange:halt', onHalt);
    exchange.on('task:settled', onSettled);
    
    await exchange.submit({ content: phrase });
    
    // Wait for auction to complete
    await new Promise(r => setTimeout(r, 50));
    
    exchange.off('task:assigned', onAssigned);
    exchange.off('exchange:halt', onHalt);
    exchange.off('task:settled', onSettled);
    
    // Determine result
    if (!winner) {
      resolve({
        phrase,
        expectedAgent,
        status: 'NO_BIDS',
        winner: null,
        confidence: 0,
        allBids: [],
      });
    } else if (expectedAgent === 'ambiguous') {
      resolve({
        phrase,
        expectedAgent,
        status: 'AMBIGUOUS',
        winner: winner.agentId,
        confidence: winner.confidence,
        allBids,
      });
    } else if (expectedAgent === 'low-confidence') {
      resolve({
        phrase,
        expectedAgent,
        status: winner ? 'FAIL' : 'NO_BIDS',
        winner: winner?.agentId,
        confidence: winner?.confidence || 0,
        allBids,
      });
    } else if (winner.agentId === expectedAgent) {
      resolve({
        phrase,
        expectedAgent,
        status: 'PASS',
        winner: winner.agentId,
        confidence: winner.confidence,
        allBids,
      });
    } else {
      resolve({
        phrase,
        expectedAgent,
        status: 'FAIL',
        winner: winner.agentId,
        confidence: winner.confidence,
        allBids,
      });
    }
  });
}

// ============================================================================
// EXPORT / RUN
// ============================================================================

if (require.main === module) {
  runCorpusTests()
    .then(exitCode => process.exit(exitCode))
    .catch(err => {
      console.error('Test corpus failed:', err);
      process.exit(1);
    });
}

module.exports = { TEST_CORPUS, runCorpusTests, createTestAgents };
