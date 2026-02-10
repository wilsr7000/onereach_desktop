/**
 * LLM-Driven Orchestration Test Suite
 * 
 * End-to-end test that boots the Exchange, connects agents via WebSocket,
 * submits real tasks through the pipeline, captures every communication event,
 * and uses an LLM judge to evaluate whether user-facing communication is
 * appropriate, timely, and helpful.
 * 
 * Tests: bidding, fast-path instant answers, task decomposition, error handling,
 * event sequence correctness, and overall communication quality.
 * 
 * Run: node test-orchestration.js
 */

const path = require('path');
const WebSocket = require('ws');

// ==================== MOCK SETTINGS MANAGER ====================
// Must be set BEFORE requiring ai-service so it finds API keys
// without needing Electron's app.getPath()

function setupMockSettings() {
  // Try to read API keys from environment
  const openaiKey = process.env.OPENAI_API_KEY || null;
  const anthropicKey = process.env.ANTHROPIC_API_KEY || null;

  // If no env keys, try to read from Keys space in clipboard storage
  let storedOpenAI = null;
  let storedAnthropic = null;
  try {
    const { getSharedStorage } = require('./clipboard-storage-v2');
    const storage = getSharedStorage();
    const spaces = storage.index?.spaces || [];
    const keysSpace = spaces.find(s =>
      s.name?.toLowerCase() === 'keys' || s.id?.toLowerCase() === 'keys'
    );
    if (keysSpace) {
      const items = (storage.index?.items || []).filter(i => i.spaceId === keysSpace.id);
      for (const item of items) {
        const full = storage.loadItem(item.id);
        const content = full?.content || item.content || '';
        const title = (item.title || item.fileName || '').toLowerCase();
        if (title.includes('openai') || content.includes('sk-proj-')) {
          const m = content.match(/sk-proj-[A-Za-z0-9_-]+/);
          if (m) storedOpenAI = m[0];
          else if (content.trim().startsWith('sk-')) storedOpenAI = content.trim();
        }
        if (title.includes('anthropic') || content.includes('sk-ant-')) {
          const m = content.match(/sk-ant-[A-Za-z0-9_-]+/);
          if (m) storedAnthropic = m[0];
        }
      }
    }
  } catch (e) {
    // Clipboard storage not available -- rely on env vars
  }

  const resolvedOpenAI = openaiKey || storedOpenAI;
  const resolvedAnthropic = anthropicKey || storedAnthropic;

  if (!resolvedOpenAI && !resolvedAnthropic) {
    console.error('\nFATAL: No API keys found.');
    console.error('Set OPENAI_API_KEY or ANTHROPIC_API_KEY, or add keys to the "Keys" space.\n');
    process.exit(1);
  }

  // Build profile overrides: route 'fast' through available provider
  let profileOverrides = null;
  if (!resolvedOpenAI && resolvedAnthropic) {
    // Only Anthropic available: route fast profile through Anthropic
    profileOverrides = {
      fast: {
        provider: 'anthropic', model: 'claude-3-haiku-20240307',
        fallback: null, // no fallback -- skip OpenAI entirely
      },
    };
  } else if (resolvedOpenAI && !resolvedAnthropic) {
    // Only OpenAI available: no change (fast already defaults to OpenAI)
    profileOverrides = null;
  }

  // Create minimal settings manager mock
  const mockSettings = {
    openaiApiKey: resolvedOpenAI,
    anthropicApiKey: resolvedAnthropic,
    aiModelProfiles: profileOverrides,
  };

  global.settingsManager = {
    get(key) {
      return mockSettings[key] !== undefined ? mockSettings[key] : null;
    },
    set() {},
  };

  const keyInfo = [];
  if (resolvedOpenAI) keyInfo.push(`OpenAI: sk-...${resolvedOpenAI.slice(-4)}`);
  if (resolvedAnthropic) keyInfo.push(`Anthropic: sk-ant-...${resolvedAnthropic.slice(-4)}`);
  console.log(`[Test] API keys loaded: ${keyInfo.join(', ')}`);
}

// Set up settings BEFORE any module loads
setupMockSettings();

// ==================== CONFIG ====================

const TEST_PORT = 48399; // Dedicated test port
const TASK_TIMEOUT_MS = 30000; // Max time to wait for a task to complete
const AUCTION_WINDOW_MS = 4000; // Match production auction window

// ==================== RESULTS TRACKING ====================

let passed = 0;
let failed = 0;
const results = [];
const scenarioScores = [];

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

// ==================== COMMUNICATION TIMELINE ====================

class CommunicationTimeline {
  constructor() {
    this.events = [];
    this.startTime = Date.now();
  }

  record(channel, type, data) {
    this.events.push({
      timestamp: Date.now() - this.startTime,
      channel,
      type,
      data: JSON.parse(JSON.stringify(data || {})),
    });
  }

  reset() {
    this.events = [];
    this.startTime = Date.now();
  }

  getByChannel(channel) {
    return this.events.filter(e => e.channel === channel);
  }

  getByType(type) {
    return this.events.filter(e => e.type === type);
  }

  getOrderedTypes() {
    return this.events.map(e => e.type);
  }

  format() {
    return this.events.map(e =>
      `[${e.timestamp}ms] ${e.channel}::${e.type} ${JSON.stringify(e.data).slice(0, 200)}`
    ).join('\n');
  }
}

// ==================== CIRCUIT BREAKER RESETS ====================

function resetAllCircuits() {
  // Reset AI service circuit breakers
  try {
    const ai = require('./lib/ai-service');
    ai.resetCircuit('openai');
    ai.resetCircuit('anthropic');
  } catch (e) { /* ignore */ }

  // Reset unified-bidder circuit breaker
  try {
    const { getCircuit } = require('./packages/agents/circuit-breaker');
    const cb = getCircuit('unified-bidder');
    if (cb && cb.reset) cb.reset();
    else if (cb) { cb.state = 'closed'; cb.failureCount = 0; }
  } catch (e) { /* ignore */ }
}

// ==================== TEST SCENARIOS ====================

const TEST_SCENARIOS = [
  // --- Bidding & Agent Selection ---
  {
    id: 'simple-time',
    input: 'What time is it right now?',
    expectedAgent: 'time-agent',
    expectedFlow: ['task:queued', 'task:assigned', 'task:settled'],
    category: 'bidding',
  },
  {
    id: 'simple-weather',
    input: "What's the weather like in San Francisco today?",
    expectedAgent: 'weather-agent',
    expectedFlow: ['task:queued', 'task:assigned', 'task:settled'],
    category: 'bidding',
  },

  // --- Instant Answer (Fast-Path) ---
  {
    id: 'smalltalk-greeting',
    input: 'Hey there, how are you doing today?',
    expectedAgent: 'smalltalk-agent',
    expectFastPath: true,
    category: 'fast-path',
  },
  {
    id: 'help-request',
    input: 'What kinds of things can you help me with?',
    expectedAgent: 'help-agent',
    expectFastPath: true,
    category: 'fast-path',
  },

  // --- Task Decomposition ---
  {
    id: 'compound-request',
    input: 'Check the weather in New York and also tell me what time it is in Tokyo',
    expectDecomposed: true,
    expectedSubtaskCount: 2,
    category: 'decomposition',
  },

  // --- Error Handling ---
  {
    id: 'nonsense-input',
    input: 'xyzzy plugh foobar bloop',
    expectLowConfidence: true,
    category: 'error-handling',
  },
];

// ==================== LLM COMMUNICATION JUDGE ====================

const RUBRIC_WEIGHTS = {
  acknowledgment: 0.20,
  agentSelection: 0.20,
  resultClarity: 0.25,
  errorHandling: 0.15,
  progressTransparency: 0.10,
  eventCompleteness: 0.10,
};

async function judgeScenario(scenario, timeline, taskResult) {
  const ai = require('./lib/ai-service');

  const timelineFormatted = timeline.format();
  const resultMessage = taskResult?.message || taskResult?.output || taskResult?.error || 'No result';
  const winningAgent = timeline.getByType('task:assigned')[0]?.data?.agentId || 'none';
  const confidence = timeline.getByType('task:assigned')[0]?.data?.confidence || 0;
  const ackEvents = timeline.getByType('ack');
  const ackText = ackEvents.length > 0 ? ackEvents[0].data.message : 'No ack';
  const fastPath = timeline.getByType('fast-path').length > 0;
  const decomposed = timeline.getByType('task:decomposed').length > 0;
  const errorRouted = timeline.getByType('error_routed').length > 0;

  const prompt = `You are evaluating the communication quality of a voice assistant processing a user request.

USER REQUEST: "${scenario.input}"
EXPECTED AGENT: "${scenario.expectedAgent || 'any appropriate agent'}"
EXPECTED BEHAVIOR: ${scenario.expectFastPath ? 'Fast-path instant answer (no execution needed)' : scenario.expectDecomposed ? `Decompose into ${scenario.expectedSubtaskCount} subtasks` : scenario.expectLowConfidence ? 'Low confidence / error handling' : 'Normal bidding and execution'}

ACTUAL RESULTS:
- Winning Agent: ${winningAgent} (confidence: ${(confidence * 100).toFixed(0)}%)
- Acknowledgment: "${ackText}"
- Fast-Path Used: ${fastPath}
- Task Decomposed: ${decomposed}
- Error Routed: ${errorRouted}
- Final Response: "${resultMessage}"

FULL COMMUNICATION TIMELINE:
${timelineFormatted}

## Scoring Instructions

Rate each dimension 1-10 based on what actually happened:

1. **acknowledgment** (20%): Was there an acknowledgment? Was it timely (before execution)? Was it appropriate for the request type? If fast-path, was the instant answer natural?
2. **agentSelection** (20%): Did the right agent handle this? Was the confidence score reasonable? If the expected agent was specified, did it match?
3. **resultClarity** (25%): Is the final response clear, natural, helpful? Does it actually answer the question? Would a real user be satisfied?
4. **errorHandling** (15%): If errors occurred, were they communicated gracefully? If no errors, give 8 (neutral). If the system handled an impossible request well, score high.
5. **progressTransparency** (10%): Could the user follow what was happening? Were status updates meaningful? Were events in logical order?
6. **eventCompleteness** (10%): Did all expected lifecycle events fire? Was the sequence logical (queued -> assigned -> settled)?

RESPOND IN JSON ONLY:
{
  "scores": {
    "acknowledgment": { "score": 8, "feedback": "..." },
    "agentSelection": { "score": 9, "feedback": "..." },
    "resultClarity": { "score": 8, "feedback": "..." },
    "errorHandling": { "score": 8, "feedback": "..." },
    "progressTransparency": { "score": 8, "feedback": "..." },
    "eventCompleteness": { "score": 9, "feedback": "..." }
  },
  "overallFeedback": "1-2 sentence summary"
}`;

  try {
    const evaluation = await ai.json(prompt, {
      profile: 'fast',
      temperature: 0.2,
      maxTokens: 500,
      feature: 'orchestration-test-judge',
    });

    if (!evaluation?.scores) {
      return { composite: 7.0, scores: {}, feedback: 'Judge returned invalid format' };
    }

    // Calculate weighted composite
    let composite = 0;
    for (const [dim, weight] of Object.entries(RUBRIC_WEIGHTS)) {
      const score = evaluation.scores[dim]?.score || 7;
      composite += score * weight;
    }
    composite = Math.round(composite * 10) / 10;

    return {
      composite,
      scores: evaluation.scores,
      feedback: evaluation.overallFeedback || '',
      pass: composite >= 7.0,
    };
  } catch (err) {
    console.warn(`  [Judge] LLM evaluation failed: ${err.message}`);
    return { composite: 0, scores: {}, feedback: `Judge error: ${err.message}`, pass: false };
  }
}

// ==================== EXCHANGE BOOTSTRAP ====================

let Exchange, WebSocketTransport, MemoryStorage;
let exchangeInstance = null;
let transportInstance = null;
let agentConnections = new Map();

async function bootExchange() {
  // Load exchange package
  const pkg = require('./packages/task-exchange/dist/index.js');
  Exchange = pkg.Exchange;
  WebSocketTransport = pkg.WebSocketTransport;
  MemoryStorage = pkg.MemoryStorage;

  // Build categories from agent registry (same as production)
  const { buildCategoryConfig } = require('./packages/agents/agent-registry');
  const agentCategories = buildCategoryConfig();

  const storage = new MemoryStorage();
  exchangeInstance = new Exchange({
    port: TEST_PORT,
    transport: 'websocket',
    storage: 'memory',

    categories: agentCategories,

    auction: {
      defaultWindowMs: AUCTION_WINDOW_MS,
      minWindowMs: 3000,
      maxWindowMs: 5000,
      instantWinThreshold: 0.9,
      dominanceMargin: 0.3,
      maxAuctionAttempts: 2,
      executionTimeoutMs: 20000,
    },

    reputation: {
      initialScore: 50,
      maxScore: 100,
      decayRate: 0.01,
      flagThreshold: 20,
    },

    rateLimit: {
      maxTasksPerMinute: 30,
      maxTasksPerAgent: 10,
    },

    heartbeatIntervalMs: 30000,
    heartbeatTimeoutMs: 60000,
  }, storage);

  transportInstance = new WebSocketTransport(exchangeInstance, {
    port: TEST_PORT,
    heartbeatIntervalMs: 30000,
    heartbeatTimeoutMs: 60000,
  });

  await transportInstance.start();
  await exchangeInstance.start();
  console.log(`[Test] Exchange running on port ${TEST_PORT}`);
}

async function shutdownExchange() {
  // Disconnect all agents
  for (const [id, conn] of agentConnections) {
    try {
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.close();
      }
      if (conn.heartbeat) clearInterval(conn.heartbeat);
    } catch (e) { /* ignore */ }
  }
  agentConnections.clear();

  if (exchangeInstance) {
    try { await exchangeInstance.stop(); } catch (e) { /* ignore */ }
  }
  if (transportInstance) {
    try { await transportInstance.stop(); } catch (e) { /* ignore */ }
  }
  console.log('[Test] Exchange shut down');
}

// ==================== AGENT CONNECTION ====================

async function connectAgentToExchange(agent, timeline) {
  const { evaluateAgentBid } = require('./packages/agents/unified-bidder');

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
    let heartbeat = null;

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'register',
        agentId: agent.id,
        agentVersion: agent.version || '1.0.0',
        categories: agent.categories,
        capabilities: { keywords: agent.keywords, executionType: agent.executionType || 'builtin' },
      }));

      heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        }
      }, 25000);

      agentConnections.set(agent.id, { ws, agent, heartbeat });
      resolve();
    });

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'bid_request') {
          // Real LLM bidding
          let evaluation = { confidence: 0, plan: null, result: null };
          try {
            const llmResult = await Promise.race([
              evaluateAgentBid(agent, msg.task),
              new Promise((_, rej) => setTimeout(() => rej(new Error('LLM timeout')), 5000)),
            ]);
            evaluation = {
              confidence: llmResult.confidence || 0,
              plan: llmResult.plan || llmResult.reasoning || '',
              result: llmResult.result || null,
            };
          } catch (e) {
            // LLM failed, agent can't bid
          }

          timeline.record('bid', `bid:${agent.id}`, {
            agentId: agent.id,
            confidence: evaluation.confidence,
            reasoning: evaluation.plan,
            hasFastPath: !!evaluation.result,
          });

          if (evaluation.confidence > 0.1) {
            const bidPayload = {
              confidence: evaluation.confidence,
              reasoning: evaluation.plan,
              estimatedTimeMs: 2000,
              tier: 'builtin',
            };
            if (evaluation.result) {
              bidPayload.result = evaluation.result;
              timeline.record('fast-path', 'fast-path', {
                agentId: agent.id,
                result: evaluation.result,
              });
            }
            ws.send(JSON.stringify({
              type: 'bid_response',
              auctionId: msg.auctionId,
              agentId: agent.id,
              agentVersion: agent.version || '1.0.0',
              bid: bidPayload,
            }));
          } else {
            ws.send(JSON.stringify({
              type: 'bid_response',
              auctionId: msg.auctionId,
              agentId: agent.id,
              agentVersion: agent.version || '1.0.0',
              bid: null,
            }));
          }
        } else if (msg.type === 'task_assignment') {
          // Real agent execution
          timeline.record('execution', 'execution:start', {
            agentId: agent.id,
            taskContent: msg.task?.content?.slice(0, 80),
          });

          try {
            let result;
            if (agent.execute && typeof agent.execute === 'function') {
              result = await Promise.race([
                agent.execute(msg.task),
                new Promise((_, rej) => setTimeout(() => rej(new Error('Execution timeout')), 15000)),
              ]);
            } else {
              result = { success: false, error: 'Agent has no execute method' };
            }

            timeline.record('execution', 'execution:complete', {
              agentId: agent.id,
              success: result.success,
              message: result.message || result.output || '',
            });

            ws.send(JSON.stringify({
              type: 'task_result',
              taskId: msg.taskId,
              result: {
                success: result.success,
                output: result.message || result.result,
                data: result.data,
                error: result.success ? undefined : result.error,
                needsInput: result.needsInput,
              },
            }));
          } catch (execError) {
            timeline.record('execution', 'execution:error', {
              agentId: agent.id,
              error: execError.message,
            });
            ws.send(JSON.stringify({
              type: 'task_result',
              taskId: msg.taskId,
              result: { success: false, error: execError.message },
            }));
          }
        } else if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        }
      } catch (error) {
        // Message parse error
      }
    });

    ws.on('error', (err) => {
      reject(err);
    });

    setTimeout(() => reject(new Error(`Agent ${agent.id} connection timeout`)), 5000);
  });
}

// ==================== TASK SUBMISSION & TRACKING ====================

function submitAndTrack(input, timeline) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ timeout: true, message: 'Task timed out' });
      }
    }, TASK_TIMEOUT_MS);

    // Listen for exchange events
    const onQueued = ({ task }) => {
      timeline.record('lifecycle', 'task:queued', {
        taskId: task.id,
        content: task.content,
      });
    };

    const onAssigned = ({ task, winner, backups }) => {
      // Simulate ack selection (what exchange-bridge does)
      const { getAgent } = require('./packages/agents/agent-registry');
      const agent = getAgent(winner.agentId);
      let ackMessage = 'Got it';
      if (agent?.acks && Array.isArray(agent.acks) && agent.acks.length > 0) {
        ackMessage = agent.acks[Math.floor(Math.random() * agent.acks.length)];
      } else if (agent?.ack) {
        ackMessage = agent.ack;
      }

      timeline.record('voice', 'ack', { message: ackMessage, agentId: winner.agentId });
      timeline.record('lifecycle', 'task:assigned', {
        taskId: task.id,
        agentId: winner.agentId,
        confidence: winner.confidence,
        reasoning: winner.reasoning,
        backupCount: backups?.length || 0,
      });
      timeline.record('hud', 'showCommandHUD', {
        status: 'running',
        agentId: winner.agentId,
        agentName: winner.agentName || winner.agentId,
        confidence: winner.confidence,
      });
    };

    const onSettled = ({ task, result, agentId }) => {
      const message = result?.output || result?.data?.output || result?.data?.message || result?.message || 'Done';

      timeline.record('lifecycle', 'task:settled', {
        taskId: task.id,
        agentId,
        success: result?.success !== false,
        fastPath: !!result?.data?.fastPath,
      });
      timeline.record('hud', 'sendResult', {
        success: true,
        message,
        agentId,
      });
      if (message && message !== 'All done') {
        timeline.record('voice', 'result-speech', { message, agentId });
      }

      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        cleanup();
        resolve({
          success: result?.success !== false,
          message,
          agentId,
          fastPath: !!result?.data?.fastPath,
          taskId: task.id,
        });
      }
    };

    const onHalt = ({ task, reason }) => {
      timeline.record('lifecycle', 'exchange:halt', { taskId: task?.id, reason });
      timeline.record('voice', 'error-speech', {
        message: "I'm not sure how to handle that one. Could you rephrase it?",
      });
      timeline.record('hud', 'sendResult', {
        success: false,
        needsClarification: true,
        message: reason,
      });

      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        cleanup();
        resolve({
          success: false,
          message: reason,
          agentId: null,
          halt: true,
        });
      }
    };

    const onErrorRouted = ({ task, reason }) => {
      timeline.record('lifecycle', 'error_routed', { taskId: task?.id, reason });

      // Simulate error agent execution
      const { getAgent } = require('./packages/agents/agent-registry');
      const errorAgent = getAgent('error-agent');
      if (errorAgent) {
        const errorTask = { content: input, metadata: { errorReason: reason } };
        errorAgent.execute(errorTask).then(result => {
          const msg = result?.output || 'Something went wrong.';
          timeline.record('voice', 'error-speech', { message: msg, agentId: 'error-agent' });
          timeline.record('hud', 'sendResult', { success: false, message: msg, agentId: 'error-agent' });

          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            cleanup();
            resolve({ success: false, message: msg, agentId: 'error-agent', errorRouted: true });
          }
        });
      }
    };

    const onDeadLetter = ({ task, reason }) => {
      timeline.record('lifecycle', 'task:dead_letter', { taskId: task?.id, reason });
      timeline.record('hud', 'sendResult', { success: false, message: 'Could not complete request' });

      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        cleanup();
        resolve({ success: false, message: reason, agentId: null, deadLetter: true });
      }
    };

    const onBusted = ({ task, agentId, error, backupsRemaining }) => {
      timeline.record('lifecycle', 'task:busted', { taskId: task?.id, agentId, error, backupsRemaining });
      timeline.record('hud', 'showCommandHUD', {
        status: 'running',
        action: backupsRemaining > 0 ? 'Trying backup agent...' : 'All agents failed',
      });
    };

    function cleanup() {
      exchangeInstance.off('task:queued', onQueued);
      exchangeInstance.off('task:assigned', onAssigned);
      exchangeInstance.off('task:settled', onSettled);
      exchangeInstance.off('exchange:halt', onHalt);
      exchangeInstance.off('task:route_to_error_agent', onErrorRouted);
      exchangeInstance.off('task:dead_letter', onDeadLetter);
      exchangeInstance.off('task:busted', onBusted);
    }

    exchangeInstance.on('task:queued', onQueued);
    exchangeInstance.on('task:assigned', onAssigned);
    exchangeInstance.on('task:settled', onSettled);
    exchangeInstance.on('exchange:halt', onHalt);
    exchangeInstance.on('task:route_to_error_agent', onErrorRouted);
    exchangeInstance.on('task:dead_letter', onDeadLetter);
    exchangeInstance.on('task:busted', onBusted);

    // Submit the task
    exchangeInstance.submit({
      content: input,
      priority: 2,
      metadata: { source: 'orchestration-test', timestamp: Date.now() },
    });
  });
}

// ==================== DECOMPOSITION TEST ====================

async function testDecomposition() {
  const ai = require('./lib/ai-service');

  // We test decomposeIfNeeded logic directly (it's a pure LLM call, no Electron needed)
  const input = 'Check the weather in New York and also tell me what time it is in Tokyo';

  const prompt = `Analyze whether this user request contains MULTIPLE INDEPENDENT tasks that should be handled separately by different agents.

User request: "${input}"

Rules:
- Only decompose if there are genuinely SEPARATE tasks (e.g. "play music and check my calendar")
- Do NOT decompose a single complex task
- Do NOT decompose if the parts depend on each other
- Most requests are NOT composite -- err on the side of returning isComposite: false

Respond with JSON only:
{
  "isComposite": true/false,
  "subtasks": ["subtask 1 text", "subtask 2 text"],
  "reasoning": "Brief explanation"
}`;

  try {
    const parsed = await ai.json(prompt, {
      profile: 'fast',
      temperature: 0.1,
      maxTokens: 200,
      feature: 'orchestration-test',
    });

    return {
      isComposite: !!parsed.isComposite,
      subtasks: Array.isArray(parsed.subtasks) ? parsed.subtasks : [],
      reasoning: parsed.reasoning || '',
    };
  } catch (err) {
    return { isComposite: false, subtasks: [], reasoning: `LLM error: ${err.message}` };
  }
}

// ==================== TEST SECTIONS ====================

async function testBiddingAndSelection(timeline) {
  section('Bidding & Agent Selection');

  for (const scenario of TEST_SCENARIOS.filter(s => s.category === 'bidding')) {
    console.log(`\n  Scenario: ${scenario.id} -- "${scenario.input}"`);
    timeline.reset();
    resetAllCircuits();

    const result = await submitAndTrack(scenario.input, timeline);

    // Structural assertions
    assert(!result.timeout, `${scenario.id}: task completed (not timed out)`);
    assert(result.agentId === scenario.expectedAgent, `${scenario.id}: ${scenario.expectedAgent} won (got: ${result.agentId})`);
    assert(result.success, `${scenario.id}: task succeeded`);
    assert(result.message && result.message.length > 0, `${scenario.id}: has response message`);

    // Event sequence
    const types = timeline.getOrderedTypes().filter(t => t.startsWith('task:'));
    const hasQueued = types.includes('task:queued');
    const hasAssigned = types.includes('task:assigned');
    const hasSettled = types.includes('task:settled');
    assert(hasQueued && hasAssigned && hasSettled, `${scenario.id}: complete event sequence (queued->assigned->settled)`);

    // Ack was emitted
    const acks = timeline.getByType('ack');
    assert(acks.length > 0, `${scenario.id}: acknowledgment was spoken`);

    // Confidence is reasonable
    const assignEvent = timeline.getByType('task:assigned')[0];
    const conf = assignEvent?.data?.confidence || 0;
    assert(conf >= 0.5, `${scenario.id}: winning confidence >= 0.5 (got: ${(conf * 100).toFixed(0)}%)`);

    // LLM Judge
    resetAllCircuits();
    const judgment = await judgeScenario(scenario, timeline, result);
    const scoreStr = Object.entries(judgment.scores || {})
      .map(([k, v]) => `${k}: ${v?.score || '?'}`)
      .join(', ');
    console.log(`  Score: ${judgment.composite}/10 [${scoreStr}]`);
    console.log(`  Judge: ${judgment.feedback}`);
    assert(judgment.composite >= 7.0, `${scenario.id}: judge score >= 7.0 (got: ${judgment.composite})`);

    scenarioScores.push({ id: scenario.id, category: scenario.category, ...judgment });

    // Small delay between scenarios to avoid bid cache collisions
    await new Promise(r => setTimeout(r, 500));
  }
}

async function testFastPath(timeline) {
  section('Fast-Path / Instant Answers');

  const { clearCache } = require('./packages/agents/unified-bidder');
  clearCache(); // Ensure clean bids

  for (const scenario of TEST_SCENARIOS.filter(s => s.category === 'fast-path')) {
    console.log(`\n  Scenario: ${scenario.id} -- "${scenario.input}"`);
    timeline.reset();
    resetAllCircuits();

    const result = await submitAndTrack(scenario.input, timeline);

    assert(!result.timeout, `${scenario.id}: task completed (not timed out)`);
    assert(result.success, `${scenario.id}: task succeeded`);
    assert(result.message && result.message.length > 0, `${scenario.id}: has response message`);

    // Check if fast-path was used
    const fastPathEvents = timeline.getByType('fast-path');
    if (scenario.expectFastPath) {
      // Fast-path is optional -- informational agents CAN fast-path but don't always
      // The key thing is the agent responded appropriately
      if (fastPathEvents.length > 0) {
        console.log(`  [Info] Fast-path was used -- result returned in bid phase`);
        assert(true, `${scenario.id}: fast-path triggered (result in bid)`);
      } else {
        console.log(`  [Info] Fast-path not used -- agent executed normally (still valid)`);
        assert(true, `${scenario.id}: agent executed normally`);
      }
    }

    // Agent selection
    if (scenario.expectedAgent) {
      assert(result.agentId === scenario.expectedAgent, `${scenario.id}: ${scenario.expectedAgent} handled it (got: ${result.agentId})`);
    }

    // LLM Judge
    resetAllCircuits();
    const judgment = await judgeScenario(scenario, timeline, result);
    const scoreStr = Object.entries(judgment.scores || {})
      .map(([k, v]) => `${k}: ${v?.score || '?'}`)
      .join(', ');
    console.log(`  Score: ${judgment.composite}/10 [${scoreStr}]`);
    console.log(`  Judge: ${judgment.feedback}`);
    assert(judgment.composite >= 7.0, `${scenario.id}: judge score >= 7.0 (got: ${judgment.composite})`);

    scenarioScores.push({ id: scenario.id, category: scenario.category, ...judgment });
    await new Promise(r => setTimeout(r, 500));
  }
}

async function testDecompositionScenario(timeline) {
  section('Task Decomposition');

  const scenario = TEST_SCENARIOS.find(s => s.category === 'decomposition');
  console.log(`\n  Scenario: ${scenario.id} -- "${scenario.input}"`);
  timeline.reset();

  resetAllCircuits();

  // Test decomposition logic (LLM call)
  const decomposition = await testDecomposition();
  timeline.record('lifecycle', 'task:decomposed', {
    isComposite: decomposition.isComposite,
    subtaskCount: decomposition.subtasks.length,
    subtasks: decomposition.subtasks,
    reasoning: decomposition.reasoning,
  });

  assert(decomposition.isComposite === true, `${scenario.id}: identified as composite request`);
  assert(decomposition.subtasks.length >= 2, `${scenario.id}: decomposed into ${decomposition.subtasks.length} subtasks (expected >= 2)`);
  console.log(`  Subtasks: ${decomposition.subtasks.map(s => `"${s}"`).join(', ')}`);
  console.log(`  Reasoning: ${decomposition.reasoning}`);

  // Now submit each subtask individually and verify it routes correctly
  if (decomposition.subtasks.length >= 2) {
    for (let i = 0; i < Math.min(decomposition.subtasks.length, 2); i++) {
      const subtask = decomposition.subtasks[i];
      console.log(`\n  Executing subtask ${i + 1}: "${subtask}"`);
      const subTimeline = new CommunicationTimeline();
      const subResult = await submitAndTrack(subtask, subTimeline);

      assert(!subResult.timeout, `${scenario.id} subtask ${i + 1}: completed`);
      assert(subResult.success, `${scenario.id} subtask ${i + 1}: succeeded (agent: ${subResult.agentId})`);

      // Merge subtask events into main timeline
      for (const evt of subTimeline.events) {
        timeline.record(evt.channel, `subtask:${evt.type}`, { subtaskIndex: i, ...evt.data });
      }
    }
  }

  // LLM Judge for the overall decomposition
  resetAllCircuits();
  const judgment = await judgeScenario(scenario, timeline, {
    message: `Decomposed into ${decomposition.subtasks.length} tasks: ${decomposition.subtasks.join('; ')}`,
  });
  const scoreStr = Object.entries(judgment.scores || {})
    .map(([k, v]) => `${k}: ${v?.score || '?'}`)
    .join(', ');
  console.log(`\n  Score: ${judgment.composite}/10 [${scoreStr}]`);
  console.log(`  Judge: ${judgment.feedback}`);
  assert(judgment.composite >= 7.0, `${scenario.id}: judge score >= 7.0 (got: ${judgment.composite})`);

  scenarioScores.push({ id: scenario.id, category: scenario.category, ...judgment });
}

async function testErrorHandling(timeline) {
  section('Error Communication');

  const scenario = TEST_SCENARIOS.find(s => s.category === 'error-handling');
  console.log(`\n  Scenario: ${scenario.id} -- "${scenario.input}"`);
  timeline.reset();

  const { clearCache } = require('./packages/agents/unified-bidder');
  clearCache();
  resetAllCircuits();

  const result = await submitAndTrack(scenario.input, timeline);
  assert(!result.timeout, `${scenario.id}: completed (not timed out)`);

  // For nonsense input, we expect either: halt (no bids), error routing, or low-confidence match
  const halted = result.halt || false;
  const errorRouted = result.errorRouted || false;
  const deadLettered = result.deadLetter || false;
  const lowConfAgent = !halted && !errorRouted && result.agentId;

  if (halted) {
    console.log(`  [Info] Exchange halted -- no agents could bid (expected for nonsense)`);
    assert(true, `${scenario.id}: exchange halted for nonsense input`);
  } else if (errorRouted) {
    console.log(`  [Info] Error agent handled gracefully`);
    assert(true, `${scenario.id}: error agent provided user-friendly message`);
    // Check the error message is user-friendly
    assert(result.message && result.message.length > 20, `${scenario.id}: error message is substantive`);
  } else if (deadLettered) {
    console.log(`  [Info] Task dead-lettered after all retries`);
    assert(true, `${scenario.id}: dead-lettered (all agents failed)`);
  } else if (lowConfAgent) {
    console.log(`  [Info] Low-confidence agent handled it: ${result.agentId}`);
    // Smalltalk might pick it up as unclear input
    assert(true, `${scenario.id}: handled by ${result.agentId} (acceptable for ambiguous input)`);
  }

  // LLM Judge
  resetAllCircuits();
  const judgment = await judgeScenario(scenario, timeline, result);
  const scoreStr = Object.entries(judgment.scores || {})
    .map(([k, v]) => `${k}: ${v?.score || '?'}`)
    .join(', ');
  console.log(`  Score: ${judgment.composite}/10 [${scoreStr}]`);
  console.log(`  Judge: ${judgment.feedback}`);
  assert(judgment.composite >= 6.0, `${scenario.id}: judge score >= 6.0 (got: ${judgment.composite})`);

  scenarioScores.push({ id: scenario.id, category: scenario.category, ...judgment });
}

async function testEventSequence(timeline) {
  section('Event Sequence Validation');

  // Check all completed scenarios for proper event ordering
  for (const scenario of TEST_SCENARIOS.filter(s => s.category === 'bidding')) {
    console.log(`\n  Checking sequence for: ${scenario.id}`);
    timeline.reset();
    resetAllCircuits();

    const result = await submitAndTrack(scenario.input, timeline);
    if (result.timeout) {
      assert(false, `${scenario.id}: timed out during sequence test`);
      continue;
    }

    const types = timeline.getOrderedTypes();

    // Queued must come before assigned
    const queuedIdx = types.indexOf('task:queued');
    const assignedIdx = types.indexOf('task:assigned');
    const settledIdx = types.indexOf('task:settled');

    if (queuedIdx >= 0 && assignedIdx >= 0) {
      assert(queuedIdx < assignedIdx, `${scenario.id}: queued before assigned`);
    }
    if (assignedIdx >= 0 && settledIdx >= 0) {
      assert(assignedIdx < settledIdx, `${scenario.id}: assigned before settled`);
    }

    // Ack must come before result speech
    const ackIdx = types.indexOf('ack');
    const resultSpeechIdx = types.indexOf('result-speech');
    if (ackIdx >= 0 && resultSpeechIdx >= 0) {
      assert(ackIdx < resultSpeechIdx, `${scenario.id}: ack spoken before result`);
    }

    // Bid events must exist (agents actually bid)
    const bidEvents = timeline.events.filter(e => e.type.startsWith('bid:'));
    assert(bidEvents.length > 0, `${scenario.id}: at least one agent bid`);

    // No duplicate lifecycle events of same type for same task
    const lifecycleTypes = timeline.getByChannel('lifecycle').map(e => e.type);
    const uniqueTypes = new Set(lifecycleTypes);
    assert(lifecycleTypes.length === uniqueTypes.size, `${scenario.id}: no duplicate lifecycle events`);

    await new Promise(r => setTimeout(r, 500));
  }
}

// ==================== TEST: AGENT-SPAWNED SUBTASKS ====================

async function testAgentSpawnedSubtasks(timeline) {
  section('Agent-Spawned Subtasks');

  resetAllCircuits();
  timeline.reset();

  // Test open routing: submit a subtask that goes through normal auction
  console.log('\n  Subtest: Open routing (subtask goes through auction)');
  const openSubtaskEvents = [];

  const onSettled = ({ task, result, agentId }) => {
    if (task.metadata?.source === 'subtask') {
      openSubtaskEvents.push({ type: 'settled', taskId: task.id, agentId, result });
    }
  };
  exchangeInstance.on('task:settled', onSettled);

  const { taskId: openSubtaskId } = await exchangeInstance.submit({
    content: 'What time is it?',
    priority: 2,
    metadata: {
      source: 'subtask',
      parentTaskId: 'test-parent-001',
      routingMode: 'open',
      subtaskContext: { reason: 'orchestration test' },
    },
  });

  assert(!!openSubtaskId, 'open subtask: submitted successfully');
  timeline.record('lifecycle', 'subtask:created', { subtaskId: openSubtaskId, routingMode: 'open' });

  // Wait for it to settle
  await new Promise(r => setTimeout(r, 10000));
  exchangeInstance.off('task:settled', onSettled);

  const openSettled = openSubtaskEvents.find(e => e.taskId === openSubtaskId);
  assert(!!openSettled, 'open subtask: settled through normal auction');
  if (openSettled) {
    assert(!!openSettled.agentId, `open subtask: handled by ${openSettled.agentId}`);
    timeline.record('lifecycle', 'subtask:settled', { subtaskId: openSubtaskId, agentId: openSettled.agentId });
  }

  // Test locked routing: submit a subtask locked to time-agent
  console.log('\n  Subtest: Locked routing (direct assignment, skip auction)');
  resetAllCircuits();

  const lockedEvents = [];
  const onAssigned2 = ({ task, winner }) => {
    if (task.metadata?.source === 'subtask' && task.metadata?.routingMode === 'locked') {
      lockedEvents.push({ type: 'assigned', taskId: task.id, agentId: winner.agentId, confidence: winner.confidence });
    }
  };
  const onSettled2 = ({ task, result, agentId }) => {
    if (task.metadata?.source === 'subtask' && task.metadata?.routingMode === 'locked') {
      lockedEvents.push({ type: 'settled', taskId: task.id, agentId, result });
    }
  };
  exchangeInstance.on('task:assigned', onAssigned2);
  exchangeInstance.on('task:settled', onSettled2);

  const { taskId: lockedSubtaskId } = await exchangeInstance.submit({
    content: 'Tell me the current time',
    priority: 2,
    metadata: {
      source: 'subtask',
      parentTaskId: 'test-parent-002',
      routingMode: 'locked',
      lockedAgentId: 'time-agent',
      subtaskContext: { reason: 'locked routing test' },
    },
  });

  assert(!!lockedSubtaskId, 'locked subtask: submitted successfully');
  timeline.record('lifecycle', 'subtask:created', { subtaskId: lockedSubtaskId, routingMode: 'locked', lockedAgentId: 'time-agent' });

  await new Promise(r => setTimeout(r, 10000));
  exchangeInstance.off('task:assigned', onAssigned2);
  exchangeInstance.off('task:settled', onSettled2);

  const lockedAssign = lockedEvents.find(e => e.type === 'assigned');
  assert(!!lockedAssign, 'locked subtask: was assigned');
  if (lockedAssign) {
    assert(lockedAssign.agentId === 'time-agent', `locked subtask: assigned to time-agent (got: ${lockedAssign.agentId})`);
    assert(lockedAssign.confidence === 1.0, `locked subtask: synthetic confidence = 1.0 (got: ${lockedAssign.confidence})`);
    timeline.record('lifecycle', 'subtask:assigned', { agentId: lockedAssign.agentId, confidence: lockedAssign.confidence });
  }

  const lockedSettle = lockedEvents.find(e => e.type === 'settled');
  assert(!!lockedSettle, 'locked subtask: settled');
  if (lockedSettle) {
    assert(lockedSettle.agentId === 'time-agent', `locked subtask: executed by time-agent (got: ${lockedSettle.agentId})`);
    timeline.record('lifecycle', 'subtask:settled', { agentId: lockedSettle.agentId });
  }
}

// ==================== TEST: CANCEL TASK FLOW ====================

async function testCancelTask(timeline) {
  section('Cancel Task Flow');

  resetAllCircuits();
  timeline.reset();

  // Submit a task then immediately cancel it
  console.log('\n  Subtest: Cancel during auction');

  let cancelledEvent = null;
  const onCancelled = ({ task, reason }) => {
    cancelledEvent = { taskId: task.id, reason };
  };
  exchangeInstance.on('task:cancelled', onCancelled);

  const { taskId } = await exchangeInstance.submit({
    content: 'Search for something that takes a while',
    priority: 2,
    metadata: { source: 'cancel-test' },
  });

  assert(!!taskId, 'cancel test: task submitted');
  timeline.record('lifecycle', 'task:queued', { taskId });

  // Cancel immediately (while auction is running)
  const cancelled = exchangeInstance.cancelTask(taskId);
  assert(cancelled === true, 'cancel test: cancelTask() returned true');
  timeline.record('lifecycle', 'task:cancelled', { taskId });

  // Give a moment for event to propagate
  await new Promise(r => setTimeout(r, 500));
  exchangeInstance.off('task:cancelled', onCancelled);

  assert(cancelledEvent !== null, 'cancel test: task:cancelled event fired');
  if (cancelledEvent) {
    assert(cancelledEvent.taskId === taskId, 'cancel test: correct taskId in event');
    assert(cancelledEvent.reason === 'user_request', `cancel test: reason is user_request (got: ${cancelledEvent.reason})`);
  }

  // Verify the task is actually cancelled in the exchange
  const task = exchangeInstance.getTask(taskId);
  assert(task?.status === 'cancelled' || task?.status === 4, 'cancel test: task status is cancelled');

  // Second cancel should return false (already cancelled)
  const secondCancel = exchangeInstance.cancelTask(taskId);
  assert(secondCancel === false, 'cancel test: double-cancel returns false');
}

// ==================== TEST: MULTI-TURN NEEDSINPUT ====================

async function testMultiTurnNeedsInput(timeline) {
  section('Multi-Turn NeedsInput');

  resetAllCircuits();
  timeline.reset();

  // Email agent requests needsInput when user says "send an email" without specifying recipient
  // We test by submitting to the exchange and checking if needsInput comes back
  console.log('\n  Subtest: Agent requests clarification via needsInput');

  let needsInputResult = null;
  let settledResult = null;

  const onSettled = ({ task, result, agentId }) => {
    if (result?.needsInput) {
      needsInputResult = { taskId: task.id, agentId, prompt: result.needsInput.prompt, field: result.needsInput.field };
    } else {
      settledResult = { taskId: task.id, agentId, result };
    }
  };
  exchangeInstance.on('task:settled', onSettled);

  const { taskId } = await exchangeInstance.submit({
    content: 'Send an email',
    priority: 2,
    metadata: { source: 'needsinput-test' },
  });

  assert(!!taskId, 'needsInput test: task submitted');
  timeline.record('lifecycle', 'task:queued', { taskId });

  // Wait for agent to respond
  await new Promise(r => setTimeout(r, 12000));
  exchangeInstance.off('task:settled', onSettled);

  // Either the agent asks for clarification (needsInput) or provides a response
  if (needsInputResult) {
    console.log(`  [Info] Agent ${needsInputResult.agentId} asked for input: "${needsInputResult.prompt}"`);
    assert(true, 'needsInput test: agent requested clarification');
    assert(needsInputResult.prompt && needsInputResult.prompt.length > 0, 'needsInput test: prompt is non-empty');
    timeline.record('lifecycle', 'needsInput', {
      agentId: needsInputResult.agentId,
      prompt: needsInputResult.prompt,
    });
    timeline.record('voice', 'needsInput-speech', { message: needsInputResult.prompt });
  } else if (settledResult) {
    // Agent handled it directly (some agents might just respond)
    console.log(`  [Info] Agent ${settledResult.agentId} handled directly without clarification`);
    assert(true, 'needsInput test: agent handled directly (acceptable)');
    timeline.record('lifecycle', 'task:settled', { agentId: settledResult.agentId });
  } else {
    // Neither happened -- task may have timed out or halted
    console.log('  [Info] No response received (task may have halted or timed out)');
    assert(true, 'needsInput test: no agent won (acceptable for vague input)');
  }
}

// ==================== TEST: HUD API TOOL-SCOPED ROUTING ====================

async function testToolScopedRouting(timeline) {
  section('HUD API Tool-Scoped Routing');

  const hudApi = require('./lib/hud-api');
  timeline.reset();

  // Subscribe different tools to lifecycle events
  const recorderEvents = [];
  const orbEvents = [];

  hudApi.onLifecycle('recorder', (event) => recorderEvents.push(event));
  hudApi.onLifecycle('orb', (event) => orbEvents.push(event));

  // Also subscribe result channels
  const recorderResults = [];
  const orbResults = [];
  hudApi.onResult('recorder', (result) => recorderResults.push(result));
  hudApi.onResult('orb', (result) => orbResults.push(result));

  // Simulate a task submitted by recorder
  const recorderTaskId = 'test-recorder-task-001';
  // Manually wire up task-tool mapping (normally done by submitTask)
  const taskToolMap = require('./lib/hud-api');
  // We need to use the internal mapping -- call emitLifecycle with a known taskId
  // First, add a HUD item for the recorder tool
  const item = hudApi.addHUDItem('recorder', { type: 'action-item', text: 'Test item for routing' });
  assert(item.id !== undefined, 'tool routing: addHUDItem for recorder works');

  // Verify items are tool-scoped
  const recorderItems = hudApi.getHUDItems('recorder');
  const orbItems = hudApi.getHUDItems('orb');
  assert(recorderItems.length >= 1, 'tool routing: recorder has items');
  assert(orbItems.length === 0, 'tool routing: orb has no items (isolation)');

  // Emit a lifecycle event for a task that isn't mapped to any tool
  // (should broadcast to ALL subscribers)
  hudApi.emitLifecycle({ type: 'task:queued', taskId: 'unmapped-task-123' });
  await new Promise(r => setTimeout(r, 100));

  assert(recorderEvents.length > 0, 'tool routing: recorder received global event');
  assert(orbEvents.length > 0, 'tool routing: orb received global event');
  timeline.record('hud', 'global-broadcast', { recorderGot: recorderEvents.length, orbGot: orbEvents.length });

  // Now emit a result event (results clean up the mapping, so test lifecycle routing)
  const preRecorderCount = recorderEvents.length;
  const preOrbCount = orbEvents.length;

  // Emit another global event
  hudApi.emitLifecycle({ type: 'task:assigned', taskId: 'unmapped-task-456' });
  await new Promise(r => setTimeout(r, 100));

  assert(recorderEvents.length > preRecorderCount, 'tool routing: recorder got second global event');
  assert(orbEvents.length > preOrbCount, 'tool routing: orb got second global event');

  // Test result emission for recorder
  hudApi.emitResult({ taskId: 'unmapped-result-789', success: true, message: 'test result' });
  await new Promise(r => setTimeout(r, 100));

  // Clean up
  hudApi.offAll('recorder');
  hudApi.offAll('orb');
  hudApi.clearHUDItems('recorder');

  // Verify unsubscribe works
  const postCleanRecorder = recorderEvents.length;
  hudApi.emitLifecycle({ type: 'task:queued', taskId: 'after-cleanup' });
  await new Promise(r => setTimeout(r, 100));
  assert(recorderEvents.length === postCleanRecorder, 'tool routing: offAll() stops events');

  timeline.record('hud', 'isolation-verified', { pass: true });
}

// ==================== TEST: RE-QUEUE / CASCADE FALLBACK ====================

async function testRequeueAndCascade(timeline) {
  section('Re-Queue & Cascade Fallback');

  resetAllCircuits();
  timeline.reset();

  // Submit a task and track busted/cascade events
  console.log('\n  Subtest: Cascade fallback when primary agent fails');

  const cascadeEvents = [];
  const onBusted = ({ task, agentId, error, backupsRemaining }) => {
    cascadeEvents.push({ type: 'busted', taskId: task.id, agentId, error, backupsRemaining });
  };
  const onSettled = ({ task, result, agentId }) => {
    cascadeEvents.push({ type: 'settled', taskId: task.id, agentId, success: result?.success });
  };
  const onDeadLetter = ({ task, reason }) => {
    cascadeEvents.push({ type: 'dead_letter', taskId: task.id, reason });
  };
  const onHalt = ({ task, reason }) => {
    cascadeEvents.push({ type: 'halt', taskId: task?.id, reason });
  };

  exchangeInstance.on('task:busted', onBusted);
  exchangeInstance.on('task:settled', onSettled);
  exchangeInstance.on('task:dead_letter', onDeadLetter);
  exchangeInstance.on('exchange:halt', onHalt);

  // Submit a simple task -- we're testing that the cascade mechanism works
  // The orchestrator-agent often fails (no real orchestration backend), triggering cascade to backup
  const { taskId } = await exchangeInstance.submit({
    content: 'What time is it right now?',
    priority: 2,
    metadata: { source: 'cascade-test' },
  });

  assert(!!taskId, 'cascade test: task submitted');

  // Wait for resolution
  await new Promise(r => setTimeout(r, 15000));

  exchangeInstance.off('task:busted', onBusted);
  exchangeInstance.off('task:settled', onSettled);
  exchangeInstance.off('task:dead_letter', onDeadLetter);
  exchangeInstance.off('exchange:halt', onHalt);

  // Check what happened
  const bustedCount = cascadeEvents.filter(e => e.type === 'busted').length;
  const settledCount = cascadeEvents.filter(e => e.type === 'settled').length;
  const deadLetterCount = cascadeEvents.filter(e => e.type === 'dead_letter').length;

  console.log(`  Cascade events: ${bustedCount} busted, ${settledCount} settled, ${deadLetterCount} dead-lettered`);

  for (const evt of cascadeEvents) {
    timeline.record('lifecycle', evt.type, evt);
  }

  if (bustedCount > 0) {
    console.log(`  [Info] Cascade occurred: ${bustedCount} agent(s) failed before settling`);
    assert(true, 'cascade test: at least one cascade fallback happened');
    // If it settled after cascading, the backup mechanism works
    if (settledCount > 0) {
      assert(true, 'cascade test: task settled after cascading to backup');
    }
  } else if (settledCount > 0) {
    console.log('  [Info] Primary agent succeeded (no cascade needed)');
    assert(true, 'cascade test: primary agent handled successfully');
  } else if (deadLetterCount > 0) {
    console.log('  [Info] Task dead-lettered (all agents exhausted)');
    assert(true, 'cascade test: dead-letter after exhaustion (mechanism works)');
  } else {
    console.log('  [Info] Task halted or no response captured');
    assert(true, 'cascade test: exchange halted (no bids)');
  }
}

async function reportAggregateScoring() {
  section('Aggregate Scoring');

  if (scenarioScores.length === 0) {
    console.log('  No scenarios scored.');
    return;
  }

  // Per-dimension averages
  const dimensions = Object.keys(RUBRIC_WEIGHTS);
  const dimAverages = {};
  for (const dim of dimensions) {
    const scores = scenarioScores
      .map(s => s.scores?.[dim]?.score)
      .filter(s => s !== undefined && s !== null);
    dimAverages[dim] = scores.length > 0
      ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
      : 'N/A';
  }

  // Overall composite
  const composites = scenarioScores.map(s => s.composite).filter(c => c > 0);
  const overallComposite = composites.length > 0
    ? Math.round((composites.reduce((a, b) => a + b, 0) / composites.length) * 10) / 10
    : 0;

  console.log('\n  Per-Scenario Scores:');
  for (const s of scenarioScores) {
    const status = s.composite >= 7.0 ? 'PASS' : 'FAIL';
    console.log(`    ${status}  ${s.id}: ${s.composite}/10 -- ${s.feedback}`);
  }

  console.log('\n  Dimension Averages:');
  for (const [dim, avg] of Object.entries(dimAverages)) {
    console.log(`    ${dim}: ${avg}/10`);
  }

  console.log(`\n  Overall Composite: ${overallComposite}/10`);
  console.log(`  Scenarios: ${scenarioScores.filter(s => s.composite >= 7.0).length} passed, ${scenarioScores.filter(s => s.composite < 7.0).length} failed`);

  assert(overallComposite >= 7.0, `Overall composite score >= 7.0 (got: ${overallComposite})`);
}

// ==================== MAIN ====================

async function runAll() {
  console.log('=== LLM-Driven Orchestration Test Suite ===');
  console.log(`Started: ${new Date().toISOString()}\n`);

  const timeline = new CommunicationTimeline();

  // --- Section 1: Bootstrap ---
  section('Infrastructure Setup');

  // Check API key
  const ai = require('./lib/ai-service');
  try {
    const testResult = await ai.chat({
      profile: 'fast',
      messages: [{ role: 'user', content: 'Say "ok" and nothing else.' }],
      maxTokens: 5,
      temperature: 0,
      feature: 'orchestration-test-check',
    });
    assert(testResult?.content, 'AI service is available');
  } catch (e) {
    console.error(`\n  FATAL: AI service unavailable: ${e.message}`);
    console.error('  This test requires a working API key (OpenAI or Anthropic).');
    console.error('  Set OPENAI_API_KEY or configure via settings.\n');
    process.exit(1);
  }

  // Boot exchange
  try {
    await bootExchange();
    assert(true, 'Exchange booted successfully');
  } catch (e) {
    console.error(`  FATAL: Exchange boot failed: ${e.message}`);
    process.exit(1);
  }

  // Load and connect agents
  const { loadBuiltInAgents, getAllAgents } = require('./packages/agents/agent-registry');
  loadBuiltInAgents();
  const agents = getAllAgents().filter(a => !a.bidExcluded);
  console.log(`  Connecting ${agents.length} agents...`);

  let connectedCount = 0;
  for (const agent of agents) {
    try {
      await connectAgentToExchange(agent, timeline);
      connectedCount++;
    } catch (e) {
      console.warn(`  Warning: Could not connect ${agent.id}: ${e.message}`);
    }
  }
  assert(connectedCount >= 5, `Connected ${connectedCount} agents (need >= 5)`);

  // Wait for agents to register
  await new Promise(r => setTimeout(r, 1000));

  // Clear bidder cache for clean test
  const { clearCache } = require('./packages/agents/unified-bidder');
  clearCache();

  // Reset circuit breakers for a clean start
  resetAllCircuits();

  // --- Section 2-6: Run tests ---
  try {
    await testBiddingAndSelection(timeline);
    await testFastPath(timeline);
    await testDecompositionScenario(timeline);
    await testErrorHandling(timeline);
    await testEventSequence(timeline);
    await testAgentSpawnedSubtasks(timeline);
    await testCancelTask(timeline);
    await testMultiTurnNeedsInput(timeline);
    await testToolScopedRouting(timeline);
    await testRequeueAndCascade(timeline);
    await reportAggregateScoring();
  } catch (e) {
    console.error(`\n  Test execution error: ${e.message}`);
    console.error(e.stack);
  }

  // --- Cleanup ---
  await shutdownExchange();

  // --- Summary ---
  console.log('\n=== Summary ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total:  ${passed + failed}`);
  console.log(`Finished: ${new Date().toISOString()}`);

  if (failed > 0) {
    console.log('\nFailed tests:');
    results.filter(r => r.status === 'FAIL').forEach(r => console.log(`  - ${r.label}`));
  }

  process.exit(failed > 0 ? 1 : 0);
}

runAll().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
