/**
 * Test Suite: Centralized HUD API + Agent Spaces
 *
 * Validates:
 * 1. Agent Space Registry: create, assign, filter, default spaces
 * 2. Meeting Agents: loading, structured extraction
 * 3. Remote Agent Client: bid/execute protocol, circuit breaker
 * 4. HUD API: submit with space, items, events
 *
 * Run: node test-hud-api.js
 */

const http = require('http');

// Track results
let passed = 0;
let failed = 0;
const results = [];

function assert(condition, label) {
  if (condition) {
    passed++;
    results.push({ status: 'PASS', label });
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    results.push({ status: 'FAIL', label });
    console.error(`  FAIL  ${label}`);
  }
}

function section(name) {
  console.log(`\n--- ${name} ---`);
}

// ==================== TEST 1: Agent Registry ====================

async function testAgentRegistry() {
  section('Agent Registry');

  const registry = require('./packages/agents/agent-registry');

  // Load agents
  const agents = registry.loadBuiltInAgents();
  assert(Array.isArray(agents), 'loadBuiltInAgents returns array');
  assert(agents.length > 0, `Loaded ${agents.length} agents`);

  // Check new meeting agents exist
  const actionItem = registry.getAgent('action-item-agent');
  assert(actionItem !== null, 'action-item-agent loaded');
  assert(actionItem && actionItem.name === 'Action Item Agent', 'action-item-agent has correct name');
  assert(actionItem && Array.isArray(actionItem.defaultSpaces), 'action-item-agent has defaultSpaces');
  assert(
    actionItem && actionItem.defaultSpaces?.includes('meeting-agents'),
    'action-item-agent in meeting-agents space'
  );

  const decision = registry.getAgent('decision-agent');
  assert(decision !== null, 'decision-agent loaded');
  assert(decision && decision.defaultSpaces?.includes('meeting-agents'), 'decision-agent in meeting-agents space');

  const notes = registry.getAgent('meeting-notes-agent');
  assert(notes !== null, 'meeting-notes-agent loaded');
  assert(notes && notes.defaultSpaces?.includes('meeting-agents'), 'meeting-notes-agent in meeting-agents space');

  // Test getAgentsByDefaultSpace
  const meetingAgents = registry.getAgentsByDefaultSpace('meeting-agents');
  assert(meetingAgents.length >= 3, `getAgentsByDefaultSpace returns ${meetingAgents.length} meeting agents`);

  // Ensure existing agents still work
  const weather = registry.getAgent('weather-agent');
  assert(weather !== null, 'weather-agent still loads');

  const time = registry.getAgent('time-agent');
  assert(time !== null, 'time-agent still loads');

  // Check BUILT_IN_AGENT_IDS includes new agents
  assert(registry.BUILT_IN_AGENT_IDS.includes('action-item-agent'), 'BUILT_IN_AGENT_IDS includes action-item-agent');
  assert(registry.BUILT_IN_AGENT_IDS.includes('decision-agent'), 'BUILT_IN_AGENT_IDS includes decision-agent');
  assert(
    registry.BUILT_IN_AGENT_IDS.includes('meeting-notes-agent'),
    'BUILT_IN_AGENT_IDS includes meeting-notes-agent'
  );

  // Optional: defaultSpaces is in OPTIONAL_PROPERTIES
  assert(registry.OPTIONAL_PROPERTIES.includes('defaultSpaces'), 'defaultSpaces in OPTIONAL_PROPERTIES');
}

// ==================== TEST 2: Agent Space Registry ====================

async function testAgentSpaceRegistry() {
  section('Agent Space Registry');

  const { getAgentSpaceRegistry, DEFAULT_SPACES } = require('./lib/agent-space-registry');
  const reg = getAgentSpaceRegistry();

  // Check default spaces definition
  assert(DEFAULT_SPACES['general-agents'] !== undefined, 'general-agents default space defined');
  assert(DEFAULT_SPACES['meeting-agents'] !== undefined, 'meeting-agents default space defined');
  assert(DEFAULT_SPACES['general-agents'].agentIds.length > 5, 'general-agents has multiple agent IDs');
  assert(
    DEFAULT_SPACES['meeting-agents'].agentIds.includes('action-item-agent'),
    'meeting-agents includes action-item-agent'
  );

  // Test default space for tools
  assert(DEFAULT_SPACES['general-agents'].defaultForTools.includes('orb'), 'orb defaults to general-agents');
  assert(
    DEFAULT_SPACES['general-agents'].defaultForTools.includes('command-hud'),
    'command-hud defaults to general-agents'
  );
  assert(DEFAULT_SPACES['meeting-agents'].defaultForTools.includes('recorder'), 'recorder defaults to meeting-agents');

  // Test the registry object has all expected methods
  assert(typeof reg.initialize === 'function', 'has initialize()');
  assert(typeof reg.getAgentSpaces === 'function', 'has getAgentSpaces()');
  assert(typeof reg.getAgentIdsInSpace === 'function', 'has getAgentIdsInSpace()');
  assert(typeof reg.getDefaultSpaceForTool === 'function', 'has getDefaultSpaceForTool()');
  assert(typeof reg.createAgentSpace === 'function', 'has createAgentSpace()');
  assert(typeof reg.assignAgent === 'function', 'has assignAgent()');
  assert(typeof reg.removeAgent === 'function', 'has removeAgent()');
  assert(typeof reg.setAgentEnabled === 'function', 'has setAgentEnabled()');
}

// ==================== TEST 3: Remote Agent Client ====================

async function testRemoteAgentClient() {
  section('Remote Agent Client');

  const {
    callRemoteBid,
    callRemoteExecute,
    checkRemoteHealth,
    getCircuitStatus,
    resetCircuit,
  } = require('./lib/remote-agent-client');

  // Test exports exist
  assert(typeof callRemoteBid === 'function', 'callRemoteBid exists');
  assert(typeof callRemoteExecute === 'function', 'callRemoteExecute exists');
  assert(typeof checkRemoteHealth === 'function', 'checkRemoteHealth exists');
  assert(typeof getCircuitStatus === 'function', 'getCircuitStatus exists');
  assert(typeof resetCircuit === 'function', 'resetCircuit exists');

  // Test with mock remote agent server
  const mockAgent = {
    id: 'test-remote-agent',
    endpoint: 'http://127.0.0.1:48299',
    authType: 'none',
  };

  // Create mock server
  const mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');

      if (req.url === '/bid' && req.method === 'POST') {
        res.end(
          JSON.stringify({
            confidence: 0.85,
            plan: 'Test plan',
            reasoning: 'Mock bid',
          })
        );
      } else if (req.url === '/execute' && req.method === 'POST') {
        res.end(
          JSON.stringify({
            success: true,
            message: 'Mock execution complete',
            data: { result: 'test' },
          })
        );
      } else if (req.url === '/health') {
        res.end(JSON.stringify({ status: 'ok', version: '1.0.0' }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
  });

  await new Promise((resolve) => {
    mockServer.listen(48299, resolve);
  });

  try {
    // Test bid
    const bidResult = await callRemoteBid(mockAgent, { content: 'test task' });
    assert(bidResult.confidence === 0.85, `Remote bid confidence: ${bidResult.confidence}`);
    assert(bidResult.plan === 'Test plan', 'Remote bid plan correct');

    // Test execute
    const execResult = await callRemoteExecute(mockAgent, { content: 'test task' }, 'Test plan');
    assert(execResult.success === true, 'Remote execute success');
    assert(execResult.message === 'Mock execution complete', 'Remote execute message correct');

    // Test health
    const health = await checkRemoteHealth(mockAgent);
    assert(health.status === 'ok', `Remote health status: ${health.status}`);
    assert(health.latency >= 0, `Remote health latency: ${health.latency}ms`);

    // Test circuit status
    const status = getCircuitStatus();
    assert(typeof status === 'object', 'Circuit status is object');

    // Test circuit reset
    resetCircuit('test-remote-agent');
    const statusAfter = getCircuitStatus();
    assert(!statusAfter['test-remote-agent'], 'Circuit reset clears entry');
  } finally {
    mockServer.close();
  }

  // Test failure case (no server)
  const failAgent = { id: 'fail-agent', endpoint: 'http://127.0.0.1:48298', authType: 'none' };
  const failBid = await callRemoteBid(failAgent, { content: 'test' });
  assert(failBid.confidence === 0, 'Failed bid returns confidence 0');
}

// ==================== TEST 4: HUD API ====================

async function testHudAPI() {
  section('HUD API');

  const hudApi = require('./lib/hud-api');

  // Test exports exist
  assert(typeof hudApi.initialize === 'function', 'HUD API has initialize()');
  assert(typeof hudApi.submitTask === 'function', 'HUD API has submitTask()');
  assert(typeof hudApi.cancelTask === 'function', 'HUD API has cancelTask()');
  assert(typeof hudApi.onLifecycle === 'function', 'HUD API has onLifecycle()');
  assert(typeof hudApi.onResult === 'function', 'HUD API has onResult()');
  assert(typeof hudApi.addHUDItem === 'function', 'HUD API has addHUDItem()');
  assert(typeof hudApi.removeHUDItem === 'function', 'HUD API has removeHUDItem()');
  assert(typeof hudApi.getHUDItems === 'function', 'HUD API has getHUDItems()');
  assert(typeof hudApi.clearHUDItems === 'function', 'HUD API has clearHUDItems()');
  assert(typeof hudApi.getAgentSpaces === 'function', 'HUD API has getAgentSpaces()');
  assert(typeof hudApi.registerRemoteAgent === 'function', 'HUD API has registerRemoteAgent()');

  // Test HUD items (in-memory, no IPC needed)
  const item = hudApi.addHUDItem('test-tool', {
    type: 'action-item',
    text: 'Review budget',
    tags: ['John', 'Sarah'],
    deadline: 'Friday',
  });
  assert(item.id !== undefined, 'addHUDItem returns item with id');
  assert(item.type === 'action-item', 'Item has correct type');
  assert(item.tags.length === 2, 'Item has correct tags');
  assert(item.deadline === 'Friday', 'Item has correct deadline');

  // Get items
  const items = hudApi.getHUDItems('test-tool');
  assert(items.length === 1, 'getHUDItems returns 1 item');
  assert(items[0].text === 'Review budget', 'Item text correct');

  // Add another item
  hudApi.addHUDItem('test-tool', { type: 'note', text: 'Timeline discussed', tags: ['Everyone'] });
  assert(hudApi.getHUDItems('test-tool').length === 2, 'getHUDItems returns 2 items');

  // Remove item
  hudApi.removeHUDItem('test-tool', item.id);
  assert(hudApi.getHUDItems('test-tool').length === 1, 'removeHUDItem works');

  // Clear items
  hudApi.clearHUDItems('test-tool');
  assert(hudApi.getHUDItems('test-tool').length === 0, 'clearHUDItems works');

  // Test event subscription
  let receivedEvent = null;
  hudApi.onLifecycle('test-tool', (event) => {
    receivedEvent = event;
  });
  hudApi.emitLifecycle({ type: 'task:queued', taskId: 'test-123' });
  assert(receivedEvent !== null, 'Lifecycle event received');
  assert(receivedEvent?.type === 'task:queued', 'Lifecycle event type correct');

  // Test task-tool mapping
  assert(typeof hudApi.getTaskTool === 'function', 'HUD API has getTaskTool()');
  assert(typeof hudApi.getTaskSpace === 'function', 'HUD API has getTaskSpace()');

  // Cleanup
  hudApi.offAll('test-tool');
}

// ==================== TEST 5: Meeting Agent Validation ====================

async function testMeetingAgentStructure() {
  section('Meeting Agent Structure');

  const agents = [
    require('./packages/agents/action-item-agent'),
    require('./packages/agents/decision-agent'),
    require('./packages/agents/meeting-notes-agent'),
  ];

  for (const agent of agents) {
    const name = agent.name;

    // Required properties
    assert(typeof agent.id === 'string', `${name}: has id`);
    assert(typeof agent.name === 'string', `${name}: has name`);
    assert(typeof agent.description === 'string', `${name}: has description`);
    assert(Array.isArray(agent.categories), `${name}: has categories`);
    assert(Array.isArray(agent.keywords), `${name}: has keywords`);
    assert(typeof agent.execute === 'function', `${name}: has execute()`);

    // Meeting-specific
    assert(agent.categories.includes('meeting'), `${name}: has 'meeting' category`);
    assert(agent.executionType === 'action', `${name}: executionType is 'action'`);
    assert(Array.isArray(agent.defaultSpaces), `${name}: has defaultSpaces`);
    assert(agent.defaultSpaces.includes('meeting-agents'), `${name}: defaultSpaces includes 'meeting-agents'`);

    // No bid method (enforced by registry)
    assert(typeof agent.bid !== 'function', `${name}: no bid() method`);

    // Has voice
    assert(typeof agent.voice === 'string', `${name}: has voice`);

    // Has acks
    assert(Array.isArray(agent.acks), `${name}: has acks`);
  }
}

// ==================== TEST 6: Preload Module ====================

async function testPreloadModule() {
  section('Preload Module');

  // Note: This tests the module export, not the actual contextBridge
  // (which requires Electron renderer context)
  const { getHudApiMethods } = require('./preload-hud-api');
  assert(typeof getHudApiMethods === 'function', 'getHudApiMethods exported');

  // Can't call getHudApiMethods() outside Electron (no ipcRenderer)
  // but we can verify the export exists
  assert(true, 'Preload module loads without error');
}

// ==================== TEST 7: Exchange TypeScript Compilation ====================

async function testExchangeCompilation() {
  section('Exchange Compilation');

  try {
    const exchangePkg = require('./packages/task-exchange/dist/index.js');
    assert(typeof exchangePkg.Exchange === 'function', 'Exchange class exists');
    assert(typeof exchangePkg.WebSocketTransport === 'function', 'WebSocketTransport exists');
    assert(typeof exchangePkg.MemoryStorage === 'function', 'MemoryStorage exists');
    assert(true, 'Exchange package loads successfully');
  } catch (e) {
    assert(false, `Exchange package load failed: ${e.message}`);
  }
}

// ==================== TEST 8: HUD API New Methods (Phase 2) ====================

async function testHudAPIPhase2() {
  section('HUD API Phase 2: Disambiguation, Multi-turn, Queue Stats');

  const hudApi = require('./lib/hud-api');

  // -- Disambiguation --
  assert(typeof hudApi.emitDisambiguation === 'function', 'HUD API has emitDisambiguation()');
  assert(typeof hudApi.onDisambiguation === 'function', 'HUD API has onDisambiguation()');
  assert(typeof hudApi.selectDisambiguationOption === 'function', 'HUD API has selectDisambiguationOption()');
  assert(typeof hudApi.cancelDisambiguation === 'function', 'HUD API has cancelDisambiguation()');

  // Test disambiguation event emission
  let _disambigReceived = null;
  hudApi.onDisambiguation('test-phase2', (state) => {
    disambigReceived = state;
  });

  // We need to set up the task-tool mapping so the event routes correctly
  // Simulate a task submission tracking
  hudApi.addHUDItem('test-phase2', { text: 'placeholder' }); // ensure tool exists in subscribers

  const disambigState = hudApi.emitDisambiguation({
    taskId: 'test-disambig-1',
    question: 'Did you mean...?',
    options: [
      { label: 'Option A', description: 'Play music' },
      { label: 'Option B', description: 'Check calendar' },
    ],
  });
  assert(disambigState.stateId !== undefined, 'Disambiguation returns stateId');
  assert(disambigState.question === 'Did you mean...?', 'Disambiguation question correct');
  assert(disambigState.options.length === 2, 'Disambiguation has 2 options');

  // Test cancel disambiguation
  hudApi.cancelDisambiguation(disambigState.stateId);
  assert(true, 'cancelDisambiguation does not throw');

  // -- Multi-turn (needsInput) --
  assert(typeof hudApi.emitNeedsInput === 'function', 'HUD API has emitNeedsInput()');
  assert(typeof hudApi.onNeedsInput === 'function', 'HUD API has onNeedsInput()');
  assert(typeof hudApi.respondToInput === 'function', 'HUD API has respondToInput()');

  let _needsInputReceived = null;
  hudApi.onNeedsInput('test-phase2', (req) => {
    needsInputReceived = req;
  });

  const inputReq = hudApi.emitNeedsInput({
    taskId: 'test-input-1',
    prompt: 'What time?',
    agentId: 'calendar-agent',
  });
  assert(inputReq.prompt === 'What time?', 'NeedsInput prompt correct');
  assert(inputReq.agentId === 'calendar-agent', 'NeedsInput agentId correct');

  // -- Queue stats --
  assert(typeof hudApi.getQueueStats === 'function', 'HUD API has getQueueStats()');
  const stats = hudApi.getQueueStats();
  assert(typeof stats === 'object', 'getQueueStats returns object');
  assert(typeof stats.active === 'number', 'getQueueStats has active count');

  // -- Transcription --
  assert(typeof hudApi.transcribeAudio === 'function', 'HUD API has transcribeAudio()');
  // Can't test actual transcription without API key, but verify the function exists

  // -- targetAgentId support --
  // The submitTask signature should accept targetAgentId (tested structurally)
  assert(typeof hudApi.submitTask === 'function', 'submitTask function exists');

  // Cleanup
  hudApi.clearHUDItems('test-phase2');
  hudApi.offAll('test-phase2');
}

// ==================== TEST 9: Git Integration in Agent Space Registry ====================

async function testGitIntegration() {
  section('Git Integration in Agent Space Registry');

  // Test that the _commitAgentSpaceChange helper exists
  // We can't directly test the private function, but we can verify that
  // the registry module loads without error with Git support
  const { getAgentSpaceRegistry } = require('./lib/agent-space-registry');
  const registry = getAgentSpaceRegistry();

  assert(typeof registry.createAgentSpace === 'function', 'createAgentSpace exists');
  assert(typeof registry.assignAgent === 'function', 'assignAgent exists');
  assert(typeof registry.removeAgent === 'function', 'removeAgent exists');
  assert(typeof registry.setAgentEnabled === 'function', 'setAgentEnabled exists');
  assert(typeof registry.deleteAgentSpace === 'function', 'deleteAgentSpace exists');
  assert(typeof registry.setDefaultSpaceForTool === 'function', 'setDefaultSpaceForTool exists');

  // Test that spaces-git module loads (Git helper available)
  try {
    const spacesGitModule = require('./lib/spaces-git');
    assert(typeof spacesGitModule.getSpacesGit === 'function', 'spaces-git module loads');

    const spacesGit = spacesGitModule.getSpacesGit();
    assert(typeof spacesGit.commit === 'function', 'spacesGit has commit()');
    assert(typeof spacesGit.commitAll === 'function', 'spacesGit has commitAll()');
    assert(typeof spacesGit.log === 'function', 'spacesGit has log()');
    assert(typeof spacesGit.diff === 'function', 'spacesGit has diff()');
    assert(typeof spacesGit.isInitialized === 'function', 'spacesGit has isInitialized()');
    assert(typeof spacesGit.createBranch === 'function', 'spacesGit has createBranch()');
    assert(typeof spacesGit.createTag === 'function', 'spacesGit has createTag()');
    assert(typeof spacesGit.revert === 'function', 'spacesGit has revert()');
  } catch (e) {
    assert(false, `spaces-git module failed to load: ${e.message}`);
  }
}

// ==================== TEST 10: AI Service API Surface ====================

async function testAiServiceSurface() {
  section('AI Service API Surface');

  const ai = require('./lib/ai-service');

  // Core methods
  assert(typeof ai.chat === 'function', 'ai-service has chat()');
  assert(typeof ai.chatStream === 'function', 'ai-service has chatStream()');
  assert(typeof ai.complete === 'function', 'ai-service has complete()');
  assert(typeof ai.json === 'function', 'ai-service has json()');
  assert(typeof ai.vision === 'function', 'ai-service has vision()');
  assert(typeof ai.embed === 'function', 'ai-service has embed()');
  assert(typeof ai.transcribe === 'function', 'ai-service has transcribe()');
  assert(typeof ai.tts === 'function', 'ai-service has tts()');
  assert(typeof ai.realtime === 'function', 'ai-service has realtime()');

  // New imageEdit method
  assert(typeof ai.imageEdit === 'function', 'ai-service has imageEdit()');

  // Agent helper methods (absorbed from claude-api)
  assert(typeof ai.planAgent === 'function', 'ai-service has planAgent()');
  assert(typeof ai.diagnoseAgentFailure === 'function', 'ai-service has diagnoseAgentFailure()');
  assert(typeof ai.generateAgentFix === 'function', 'ai-service has generateAgentFix()');

  // OpenAI adapter
  const { getOpenAIAdapter } = require('./lib/ai-providers/openai-adapter');
  const adapter = getOpenAIAdapter();
  assert(typeof adapter.chat === 'function', 'OpenAI adapter has chat()');
  assert(typeof adapter.embed === 'function', 'OpenAI adapter has embed()');
  assert(typeof adapter.transcribe === 'function', 'OpenAI adapter has transcribe()');
  assert(typeof adapter.imageEdit === 'function', 'OpenAI adapter has imageEdit()');
  assert(typeof adapter.tts === 'function', 'OpenAI adapter has tts()');
}

// ==================== RUN ALL TESTS ====================

async function runAll() {
  console.log('=== HUD API + Agent Spaces Test Suite ===\n');

  await testAgentRegistry();
  await testAgentSpaceRegistry();
  await testRemoteAgentClient();
  await testHudAPI();
  await testMeetingAgentStructure();
  await testPreloadModule();
  await testExchangeCompilation();
  await testHudAPIPhase2();
  await testGitIntegration();
  await testAiServiceSurface();

  console.log('\n=== Summary ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total:  ${passed + failed}`);

  if (failed > 0) {
    console.log('\nFailed tests:');
    results.filter((r) => r.status === 'FAIL').forEach((r) => console.log(`  - ${r.label}`));
  }

  process.exit(failed > 0 ? 1 : 0);
}

runAll().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
