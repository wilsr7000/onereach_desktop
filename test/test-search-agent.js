/**
 * Search Agent Integration Test
 *
 * Tests that the search agent can actually search and synthesize answers.
 *
 * Run with: OPENAI_API_KEY=your-key node test/test-search-agent.js
 */

const searchAgent = require('../packages/agents/search-agent');

async function main() {
  console.log('=== Search Agent Integration Test ===\n');

  const testQueries = [
    'what is the weather in New York',
    'who invented the telephone',
    'what is the capital of France',
  ];

  for (const query of testQueries) {
    console.log(`\nQuery: "${query}"`);
    console.log('-'.repeat(50));

    // Check bid
    const bid = searchAgent.bid({ content: query });
    console.log(`Bid confidence: ${bid?.confidence || 'no bid'}`);

    if (bid) {
      // Execute
      console.log('Executing search...');
      const result = await searchAgent.execute({ content: query });

      console.log(`Success: ${result.success}`);
      console.log(`Answer: ${result.message}`);
      if (result.sources) {
        console.log(`Sources: ${result.sources.slice(0, 2).join(', ')}`);
      }
    }
  }

  console.log('\n=== Test Complete ===');
}

main().catch((e) => {
  console.error('Error:', e);
  process.exit(1);
});
