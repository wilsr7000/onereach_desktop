/**
 * Direct Agent Tests
 * Tests the built-in agents directly without the full exchange
 */

const timeAgent = require('./packages/agents/time-agent.js');
const weatherAgent = require('./packages/agents/weather-agent.js');
const helpAgent = require('./packages/agents/help-agent.js');
const mediaAgent = require('./packages/agents/media-agent.js');

async function runTests() {
  console.log('=== Direct Agent Tests ===\n');

  const testCases = [
    // Time Agent
    { agent: timeAgent, phrase: 'What time is it?', shouldBid: true, description: 'Time query' },
    { agent: timeAgent, phrase: 'What day is it?', shouldBid: true, description: 'Date query' },
    { agent: timeAgent, phrase: 'Play music', shouldBid: false, description: 'Not time related' },

    // Weather Agent
    { agent: weatherAgent, phrase: 'Weather in Denver', shouldBid: true, description: 'Weather with location' },
    { agent: weatherAgent, phrase: "What's the weather", shouldBid: true, description: 'Weather without location' },
    { agent: weatherAgent, phrase: 'What time is it?', shouldBid: false, description: 'Not weather related' },

    // Help Agent
    { agent: helpAgent, phrase: 'What can you do?', shouldBid: true, description: 'Capabilities query' },
    { agent: helpAgent, phrase: 'Help', shouldBid: true, description: 'Help command' },
    { agent: helpAgent, phrase: 'Play music', shouldBid: false, description: 'Not help related' },

    // Media Agent
    { agent: mediaAgent, phrase: 'Play music', shouldBid: true, description: 'Play command' },
    { agent: mediaAgent, phrase: 'Pause', shouldBid: true, description: 'Pause command' },
    { agent: mediaAgent, phrase: 'Stop', shouldBid: true, description: 'Stop command' },
    { agent: mediaAgent, phrase: 'What time is it?', shouldBid: false, description: 'Not media related' },
  ];

  let passed = 0;
  let failed = 0;

  console.log('--- Bid Tests ---\n');

  for (const test of testCases) {
    const task = { id: 'test', content: test.phrase };
    const bid = test.agent.bid(task);
    const didBid = !!(bid && bid.confidence > 0.5); // Convert to boolean

    const isCorrect = didBid === test.shouldBid;
    const status = isCorrect ? '✓' : '✗';
    const detail = didBid ? `bid ${bid.confidence}` : 'no bid';

    console.log(
      `${status} ${test.agent.id}: "${test.phrase}" - ${detail} (expected: ${test.shouldBid ? 'bid' : 'no bid'})`
    );
    if (isCorrect) passed++;
    else failed++;
  }

  console.log('\n--- Execute Tests ---\n');

  // Test time agent execution
  console.log('Time Agent Execute:');
  const timeResult = await timeAgent.execute({ id: 'test', content: 'What time is it?' }, {});
  console.log(`  Result: ${timeResult.success ? '✓' : '✗'} - ${timeResult.message}`);
  if (timeResult.success) passed++;
  else failed++;

  // Test weather agent execution (without location - should need input)
  console.log('Weather Agent Execute (no location):');
  const weatherResult = await weatherAgent.execute({ id: 'test', content: "What's the weather" }, {});
  const weatherNeedsInput = !!weatherResult.needsInput;
  console.log(
    `  Result: ${weatherNeedsInput ? '✓ needs input' : '✗ should need input'} - ${weatherResult.needsInput?.prompt || weatherResult.message}`
  );
  if (weatherNeedsInput) passed++;
  else failed++;

  // Test weather agent execution (with location)
  console.log('Weather Agent Execute (with location):');
  const weatherResult2 = await weatherAgent.execute({ id: 'test', content: 'Weather in Denver' }, {});
  console.log(`  Result: ${weatherResult2.success ? '✓' : '✗'} - ${weatherResult2.message}`);
  if (weatherResult2.success) passed++;
  else failed++;

  // Test help agent execution
  console.log('Help Agent Execute:');
  const helpResult = await helpAgent.execute({ id: 'test', content: 'What can you do?' }, {});
  console.log(`  Result: ${helpResult.success ? '✓' : '✗'} - ${helpResult.message?.substring(0, 50)}...`);
  if (helpResult.success) passed++;
  else failed++;

  console.log('\n=== Summary ===');
  console.log(`Passed: ${passed}/${passed + failed}`);
  console.log(`Failed: ${failed}/${passed + failed}`);

  // Test HUD calls would happen
  console.log('\n--- HUD Integration Check ---');
  console.log('global.showCommandHUD exists:', typeof global.showCommandHUD);
  console.log('global.sendCommandHUDResult exists:', typeof global.sendCommandHUDResult);

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
