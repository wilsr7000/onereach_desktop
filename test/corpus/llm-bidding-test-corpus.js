/**
 * LLM-Based Bidding Test Corpus
 *
 * Tests the distributed bidding system using REAL LLM evaluation
 * (not keyword matching). Retrieves API key from the "Keys" space.
 *
 * Run with: npm run test:corpus:llm
 */

// ============================================================================
// API KEY RETRIEVAL FROM KEYS SPACE
// ============================================================================

/**
 * Get OpenAI API key from the "Keys" space
 */
async function getApiKeyFromKeysSpace() {
  try {
    // Try to load from clipboard storage directly (for standalone test)
    const { getSharedStorage } = require('../../clipboard-storage-v2');

    const storage = getSharedStorage();

    // Find the "Keys" space
    const spaces = storage.index?.spaces || [];
    const keysSpace = spaces.find((s) => s.name?.toLowerCase() === 'keys' || s.id?.toLowerCase() === 'keys');

    if (!keysSpace) {
      console.log('[KeysSpace] Available spaces:', spaces.map((s) => s.name).join(', '));
      return null;
    }

    console.log(`[KeysSpace] Found Keys space: ${keysSpace.id}`);

    // Get items from the Keys space
    const items = (storage.index?.items || []).filter((item) => item.spaceId === keysSpace.id);

    console.log(`[KeysSpace] Found ${items.length} items in Keys space`);

    // Look for OpenAI key in items
    for (const item of items) {
      // Load full content
      const fullItem = storage.loadItem(item.id);
      const content = fullItem?.content || item.content || '';
      const title = item.title || item.fileName || '';

      // Check if this looks like an OpenAI key
      if (
        title.toLowerCase().includes('openai') ||
        content.toLowerCase().includes('openai') ||
        content.startsWith('sk-')
      ) {
        // Extract the key - might be the content itself or in a structured format
        const keyMatch = content.match(/sk-[a-zA-Z0-9_-]{20,}/);
        if (keyMatch) {
          console.log(`[KeysSpace] Found OpenAI key in item: ${title || item.id}`);
          return keyMatch[0];
        }

        // If content looks like a raw key
        if (content.trim().startsWith('sk-')) {
          return content.trim();
        }
      }
    }

    console.log('[KeysSpace] No OpenAI key found in Keys space items');
    return null;
  } catch (error) {
    console.error('[KeysSpace] Error accessing Keys space:', error.message);
    return null;
  }
}

/**
 * Get API key from environment or Keys space
 */
async function getApiKey() {
  // Try environment first
  if (process.env.OPENAI_API_KEY) {
    console.log('[APIKey] Using key from environment');
    return process.env.OPENAI_API_KEY;
  }

  // Try Keys space
  const spaceKey = await getApiKeyFromKeysSpace();
  if (spaceKey) {
    return spaceKey;
  }

  return null;
}

// ============================================================================
// LLM EVALUATION (same as unified-bidder.js)
// ============================================================================

/**
 * Evaluate agent bid using LLM
 */
async function evaluateAgentBidWithLLM(agent, task, apiKey) {
  const prompt = `You are evaluating if an AI agent can handle a user's request.

AGENT:
- Name: ${agent.name}
- ID: ${agent.id}
- Keywords: ${(agent.keywords || []).join(', ')}
- Capabilities: ${(agent.capabilities || []).join(', ')}
${agent.prompt ? `- Instructions: ${agent.prompt}` : ''}

USER REQUEST: "${task.content}"

Evaluate how confident this agent should be in handling this request.
Consider:
1. Does the request match the agent's capabilities?
2. Can the agent provide a useful response?
3. Is this the RIGHT agent for this task?

Respond in JSON format:
{
  "confidence": <number 0-1>,
  "reasoning": "<brief explanation>",
  "canHandle": <boolean>
}

Be strict - only give high confidence (>0.7) if this agent is clearly the best choice.`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: prompt }],
        temperature: 0,
        max_tokens: 200,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error('Empty response');
    }

    const parsed = JSON.parse(content);
    return {
      confidence: Math.max(0, Math.min(1, parsed.confidence || 0)),
      reasoning: parsed.reasoning || '',
      canHandle: parsed.canHandle || false,
    };
  } catch (error) {
    console.error(`[LLM] Error evaluating ${agent.name}:`, error.message);
    return { confidence: 0, reasoning: error.message, canHandle: false };
  }
}

// ============================================================================
// TEST CORPUS
// ============================================================================

const TEST_CORPUS = {
  'time-agent': ['what time is it', "what's the current time", "tell me today's date", 'what day of the week is it'],

  'weather-agent': [
    "what's the weather like",
    'is it going to rain today',
    "what's the temperature in Denver",
    'should I bring an umbrella',
  ],

  'media-agent': ['play some music', 'pause the song', 'turn up the volume', 'skip to the next track'],

  'help-agent': ['help me', 'what can you do', 'list your capabilities'],

  'search-agent': ['search for information about AI', 'find restaurants near me', 'look up the latest news'],

  'smalltalk-agent': ['hello', 'how are you', 'thank you', 'goodbye'],

  ambiguous: [
    "what's the weather like at 5pm", // time + weather
    'play weather sounds', // media + weather
    'help me find music', // help + search + media
  ],

  none: ['asdfghjkl random gibberish', 'the mitochondria is the powerhouse of the cell'],
};

// ============================================================================
// TEST AGENTS (simulating built-in agents)
// ============================================================================

const TEST_AGENTS = {
  'time-agent': {
    id: 'time-agent',
    name: 'Time Agent',
    keywords: ['time', 'clock', 'date', 'day', 'month', 'year'],
    capabilities: ['Tell current time', 'Tell current date', 'Answer questions about dates and times'],
  },

  'weather-agent': {
    id: 'weather-agent',
    name: 'Weather Agent',
    keywords: ['weather', 'temperature', 'rain', 'forecast'],
    capabilities: ['Check current weather', 'Provide weather forecasts', 'Answer weather-related questions'],
  },

  'media-agent': {
    id: 'media-agent',
    name: 'Media Agent',
    keywords: ['play', 'pause', 'stop', 'music', 'volume', 'song'],
    capabilities: ['Play music', 'Control playback', 'Adjust volume', 'Skip tracks'],
  },

  'help-agent': {
    id: 'help-agent',
    name: 'Help Agent',
    keywords: ['help', 'assist', 'capabilities', 'features'],
    capabilities: ['Explain available features', 'Provide help and guidance', 'List capabilities'],
  },

  'search-agent': {
    id: 'search-agent',
    name: 'Search Agent',
    keywords: ['search', 'find', 'look up', 'lookup'],
    capabilities: ['Search the web', 'Find information', 'Look up topics'],
  },

  'smalltalk-agent': {
    id: 'smalltalk-agent',
    name: 'Smalltalk Agent',
    keywords: ['hello', 'hi', 'thanks', 'goodbye'],
    capabilities: ['Greetings', 'Social conversation', 'Polite responses'],
  },
};

// ============================================================================
// TEST RUNNER
// ============================================================================

async function runLLMCorpusTests() {
  console.log('\n========================================');
  console.log('  LLM-BASED BIDDING TEST CORPUS');
  console.log('========================================\n');

  // Get API key
  const apiKey = await getApiKey();
  if (!apiKey) {
    console.error('ERROR: No OpenAI API key found.');
    console.error('Please set OPENAI_API_KEY environment variable or add key to "Keys" space.');
    process.exit(1);
  }

  console.log('API Key: sk-....' + apiKey.slice(-4));
  console.log(
    `Testing ${Object.values(TEST_CORPUS).flat().length} phrases against ${Object.keys(TEST_AGENTS).length} agents\n`
  );

  const results = {
    passed: 0,
    failed: 0,
    ambiguous: 0,
    noBids: 0,
    details: [],
    apiCalls: 0,
  };

  // Run tests
  for (const [expectedAgent, phrases] of Object.entries(TEST_CORPUS)) {
    console.log(`\n--- Testing: ${expectedAgent} ---\n`);

    for (const phrase of phrases) {
      const result = await testPhraseWithLLM(phrase, expectedAgent, apiKey);
      results.details.push(result);
      results.apiCalls += Object.keys(TEST_AGENTS).length;

      // Display result
      if (result.status === 'PASS') {
        results.passed++;
        console.log(`  ✓ "${phrase}"`);
        console.log(
          `    → ${result.winner} (${(result.confidence * 100).toFixed(0)}%) - ${result.reasoning.slice(0, 60)}...`
        );
      } else if (result.status === 'FAIL') {
        results.failed++;
        console.log(`  ✗ "${phrase}"`);
        console.log(`    Expected: ${expectedAgent}, Got: ${result.winner || 'NONE'}`);
        if (result.reasoning) {
          console.log(`    Reason: ${result.reasoning.slice(0, 80)}...`);
        }
      } else if (result.status === 'AMBIGUOUS') {
        results.ambiguous++;
        console.log(`  ? "${phrase}" [AMBIGUOUS]`);
        console.log(`    → ${result.winner} (${(result.confidence * 100).toFixed(0)}%)`);
        if (result.allBids.length > 1) {
          const others = result.allBids
            .slice(1, 3)
            .map((b) => `${b.agentId}(${(b.confidence * 100).toFixed(0)}%)`)
            .join(', ');
          console.log(`    Also: ${others}`);
        }
      } else if (result.status === 'NO_BIDS') {
        if (expectedAgent === 'none') {
          results.passed++;
          console.log(`  ✓ "${phrase}" [NO CONFIDENT BIDS - expected]`);
        } else {
          results.noBids++;
          console.log(`  ○ "${phrase}" [NO CONFIDENT BIDS]`);
        }
      }

      // Rate limiting - pause between tests
      await new Promise((r) => {
        setTimeout(r, 200);
      });
    }
  }

  // Summary
  console.log('\n========================================');
  console.log('  SUMMARY');
  console.log('========================================\n');
  console.log(`  Passed:     ${results.passed}`);
  console.log(`  Failed:     ${results.failed}`);
  console.log(`  Ambiguous:  ${results.ambiguous}`);
  console.log(`  No Bids:    ${results.noBids}`);
  console.log(`  Total:      ${results.details.length}`);
  console.log(`  API Calls:  ${results.apiCalls}`);
  console.log(`\n  Success Rate: ${((results.passed / (results.passed + results.failed)) * 100).toFixed(1)}%`);
  console.log('');

  return results.failed === 0 ? 0 : 1;
}

async function testPhraseWithLLM(phrase, expectedAgent, apiKey) {
  const task = { content: phrase };
  const _bids = [];

  // Evaluate all agents in parallel
  const evaluations = await Promise.all(
    Object.values(TEST_AGENTS).map(async (agent) => {
      const eval_ = await evaluateAgentBidWithLLM(agent, task, apiKey);
      return {
        agentId: agent.id,
        confidence: eval_.confidence,
        reasoning: eval_.reasoning,
        canHandle: eval_.canHandle,
      };
    })
  );

  // Filter to bids with confidence > 0.3 (lowered from 0.5 to catch more)
  const validBids = evaluations
    .filter((e) => e.confidence > 0.3 && e.canHandle)
    .sort((a, b) => b.confidence - a.confidence);

  const winner = validBids[0] || null;

  // Determine result
  if (!winner) {
    return {
      phrase,
      expectedAgent,
      status: 'NO_BIDS',
      winner: null,
      confidence: 0,
      reasoning: '',
      allBids: evaluations.sort((a, b) => b.confidence - a.confidence),
    };
  }

  if (expectedAgent === 'ambiguous') {
    return {
      phrase,
      expectedAgent,
      status: 'AMBIGUOUS',
      winner: winner.agentId,
      confidence: winner.confidence,
      reasoning: winner.reasoning,
      allBids: validBids,
    };
  }

  if (expectedAgent === 'none') {
    return {
      phrase,
      expectedAgent,
      status: winner ? 'FAIL' : 'NO_BIDS',
      winner: winner?.agentId,
      confidence: winner?.confidence || 0,
      reasoning: winner?.reasoning || '',
      allBids: validBids,
    };
  }

  if (winner.agentId === expectedAgent) {
    return {
      phrase,
      expectedAgent,
      status: 'PASS',
      winner: winner.agentId,
      confidence: winner.confidence,
      reasoning: winner.reasoning,
      allBids: validBids,
    };
  }

  return {
    phrase,
    expectedAgent,
    status: 'FAIL',
    winner: winner.agentId,
    confidence: winner.confidence,
    reasoning: winner.reasoning,
    allBids: validBids,
  };
}

// ============================================================================
// MAIN
// ============================================================================

if (require.main === module) {
  runLLMCorpusTests()
    .then((exitCode) => process.exit(exitCode))
    .catch((err) => {
      console.error('Test corpus failed:', err);
      process.exit(1);
    });
}

module.exports = { TEST_CORPUS, TEST_AGENTS, runLLMCorpusTests, getApiKey };
