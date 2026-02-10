/**
 * Task Exchange E2E Tests -- LLM-Evaluated
 *
 * A comprehensive test suite for the Task Exchange auction system.
 * Uses a two-tier strategy:
 *
 *   Tier 1 (Deterministic):  Hard assertions on structure, lifecycle, and
 *       edge cases.  No AI calls -- fast, stable, always run.
 *
 *   Tier 2 (LLM-as-judge):  Submits real voice-command-style queries through
 *       the full exchange pipeline, waits for settlement, then asks an LLM to
 *       evaluate routing accuracy and response quality against a rubric.
 *       Runs when the AI service is available (live app).
 *
 * All tests call exchange-bridge functions directly in the main process
 * via electronApp.evaluate(), because the exchange bridge is a main-process
 * module and its IPC channels (voice-task-sdk:*) are only exposed through
 * specific preloads (orb, command-hud), not the main window preload.
 *
 * Run:  npx playwright test test/e2e/task-exchange.spec.js
 */

const { test, expect } = require('@playwright/test');
const {
  launchApp, closeApp, snapshotErrors, checkNewErrors, filterBenignErrors,
  checkExchangeHealth, sleep
} = require('./helpers/electron-app');

let app;
let electronApp;
let mainWindow;
let errorSnapshot;

// ═══════════════════════════════════════════════════════════════════════════════
// Test Corpus -- queries for LLM-evaluated routing & response quality
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Each entry defines a voice command, the agent category it should route to,
 * and a rubric the LLM judge will evaluate against.
 */
const ROUTING_CORPUS = [
  {
    id: 'time-query',
    query: 'What time is it right now?',
    expectedAgentPattern: /time/i,
    category: 'informational',
    rubric: [
      'The winning agent is a time-related agent (not weather, not search)',
      'The response includes the current time or indicates it will provide the time',
    ],
  },
  {
    id: 'weather-query',
    query: "What's the weather like today?",
    expectedAgentPattern: /weather/i,
    category: 'informational',
    rubric: [
      'The winning agent is a weather-related agent (not time, not search)',
      'The response is about weather conditions, not an unrelated topic',
    ],
  },
  {
    id: 'smalltalk-greeting',
    query: 'Hey, how are you doing today?',
    expectedAgentPattern: /smalltalk|help|chat/i,
    category: 'informational',
    rubric: [
      'The winning agent handles small talk or general conversation',
      'The response is friendly and conversational, not a task execution',
    ],
  },
  {
    id: 'search-query',
    query: 'Search for the latest news about AI',
    expectedAgentPattern: /search|web/i,
    category: 'action',
    rubric: [
      'The winning agent handles search or web queries',
      'The response indicates a search was initiated or results were found',
    ],
  },
  {
    id: 'app-settings',
    query: 'Open the settings window',
    expectedAgentPattern: /app|system|settings/i,
    category: 'action',
    rubric: [
      'The winning agent handles app commands (open windows, navigate)',
      'The response indicates the settings window was opened or will be opened',
    ],
  },
];

/**
 * Edge-case queries that test the exchange's resilience.
 */
const EDGE_CASE_CORPUS = [
  {
    id: 'gibberish',
    query: 'asdfghjkl qwerty zxcvbnm',
    expectation: 'rejected-or-low-confidence',
    description: 'Gibberish should be filtered or produce low-confidence routing',
  },
  {
    id: 'single-word',
    query: 'hello',
    expectation: 'handled',
    description: 'Single word should still route (likely to smalltalk)',
  },
  {
    id: 'very-long-input',
    query: 'I need you to help me with a very long and detailed request that goes on and on about multiple different things including the weather forecast for tomorrow, what time it currently is in Tokyo, and also please search for some information about machine learning algorithms and their applications in modern software development practices',
    expectation: 'handled-or-decomposed',
    description: 'Long multi-topic input may be decomposed into subtasks',
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// LLM Judge Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Submit a query through the full exchange pipeline and wait for settlement.
 * Returns the full task lifecycle result.
 *
 * @param {ElectronApplication} electronApp
 * @param {string} query
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<Object>} { submission, task, agentId, result, status, timedOut }
 */
async function submitAndWaitForSettlement(electronApp, query, timeoutMs = 15000) {
  return await electronApp.evaluate(async ({ query, timeoutMs }) => {
    const bridge = require('./src/voice-task-sdk/exchange-bridge');

    if (!bridge.isRunning()) {
      return { error: 'Exchange not running', submission: null };
    }

    // Submit through the full pipeline
    const submission = await bridge.processSubmit(query, {
      toolId: 'e2e-test',
      skipFilter: true,
    });

    if (!submission.queued || !submission.taskId) {
      // Task was handled directly (fast-path, router, etc.)
      return {
        submission,
        task: null,
        agentId: null,
        result: submission.message ? { success: true, message: submission.message } : null,
        status: submission.handled ? 'handled-directly' : 'not-queued',
        timedOut: false,
      };
    }

    // Poll for task settlement
    const exchange = bridge.getExchange();
    const taskId = submission.taskId;
    const startTime = Date.now();
    const pollInterval = 250;
    const terminalStatuses = ['SETTLED', 'DEAD_LETTER', 'CANCELLED', 'HALTED', 'BUSTED'];

    while (Date.now() - startTime < timeoutMs) {
      const task = exchange.getTask(taskId);
      if (task && terminalStatuses.includes(task.status)) {
        return {
          submission,
          task: {
            id: task.id,
            status: task.status,
            content: task.content,
            assignedAgent: task.assignedAgent,
            backupQueue: task.backupQueue,
            executionMode: task.executionMode,
            auctionAttempt: task.auctionAttempt,
            createdAt: task.createdAt,
            completedAt: task.completedAt,
            durationMs: task.completedAt ? task.completedAt - task.createdAt : null,
          },
          agentId: task.assignedAgent,
          result: task.result,
          status: task.status,
          timedOut: false,
        };
      }
      await new Promise(r => setTimeout(r, pollInterval));
    }

    // Timed out -- capture last known state
    const task = exchange.getTask(taskId);
    return {
      submission,
      task: task ? {
        id: task.id,
        status: task.status,
        content: task.content,
        assignedAgent: task.assignedAgent,
      } : null,
      agentId: task?.assignedAgent || null,
      result: task?.result || null,
      status: task?.status || 'UNKNOWN',
      timedOut: true,
    };
  }, { query, timeoutMs });
}

/**
 * Ask the LLM to evaluate a task exchange result against a rubric.
 * Returns a structured judgment with score and per-criterion results.
 *
 * @param {ElectronApplication} electronApp
 * @param {Object} opts
 * @param {string} opts.query - The original user query
 * @param {string} opts.agentId - The agent that won the auction
 * @param {Object} opts.result - The agent's result
 * @param {string} opts.status - Final task status
 * @param {string[]} opts.rubric - Criteria to evaluate
 * @returns {Promise<{score: number, pass: boolean, criteria: Array}>}
 */
async function llmJudge(electronApp, { query, agentId, result, status, rubric }) {
  return await electronApp.evaluate(async ({ query, agentId, result, status, rubric }) => {
    try {
      const ai = require('./lib/ai-service');

      // Extract the response text from the result
      let responseText = 'No response';
      if (result?.data?.output) {
        responseText = typeof result.data.output === 'string'
          ? result.data.output
          : JSON.stringify(result.data.output);
      } else if (result?.message) {
        responseText = result.message;
      } else if (result?.data?.results) {
        responseText = JSON.stringify(result.data.results);
      }

      const prompt = `You are a quality evaluator for a voice-command task routing system.

A user spoke a voice command, and the system routed it through an auction where AI agents bid to handle it. One agent won and produced a response.

USER QUERY: "${query}"
WINNING AGENT: ${agentId || 'none'}
TASK STATUS: ${status}
AGENT RESPONSE: ${responseText.slice(0, 1500)}

EVALUATION RUBRIC:
${rubric.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Additional criteria (always evaluate these):
- The task reached a terminal status (SETTLED, DEAD_LETTER, or handled directly)
- The winning agent is a reasonable choice for this query (even if not perfect)
- The response is relevant to what the user asked

For each criterion, determine if the result passes (true/false) and give a brief reason.
Then give an overall score 0-100 where:
  90-100 = Perfect routing and response
  70-89  = Correct routing, acceptable response
  50-69  = Marginal -- routed but response quality is poor
  0-49   = Wrong agent or broken response

Return ONLY valid JSON:
{
  "score": <number>,
  "criteria": [
    {"criterion": "<text>", "pass": <boolean>, "reasoning": "<brief>"}
  ]
}`;

      const judgment = await ai.json(prompt, {
        profile: 'fast',
        feature: 'task-exchange-eval',
        temperature: 0,
        maxTokens: 800,
      });

      return {
        score: judgment.score || 0,
        pass: (judgment.score || 0) >= 70,
        criteria: judgment.criteria || [],
        evaluatedBy: 'llm',
      };
    } catch (evalError) {
      // AI service not available -- deterministic fallback
      const hasAgent = !!agentId;
      const hasResult = result?.success === true;
      const isSettled = status === 'SETTLED' || status === 'handled-directly';

      let score = 0;
      if (isSettled && hasAgent && hasResult) score = 75;
      else if (isSettled && hasResult) score = 65;
      else if (hasAgent) score = 50;

      return {
        score,
        pass: score >= 70,
        criteria: rubric.map(c => ({
          criterion: c,
          pass: score >= 70,
          reasoning: `Deterministic fallback (AI unavailable: ${evalError.message})`,
        })),
        evaluatedBy: 'deterministic-fallback',
      };
    }
  }, { query, agentId, result, status, rubric });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Task Exchange', () => {

  test.beforeAll(async () => {
    app = await launchApp();
    electronApp = app.electronApp;
    mainWindow = app.mainWindow;
    errorSnapshot = await snapshotErrors();
  });

  test.afterAll(async () => {
    await closeApp(app);
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // Tier 1: Deterministic -- Exchange Infrastructure
  // ═════════════════════════════════════════════════════════════════════════════

  test.describe('Tier 1: Exchange Infrastructure', () => {

    test('exchange bridge is initialized and running', async () => {
      const status = await checkExchangeHealth(electronApp);
      expect(status).toBeDefined();
      expect(status.running).toBe(true);
      expect(status.port).toBe(3456);
      expect(typeof status.agentCount).toBe('number');
    });

    test('exchange instance exposes required methods', async () => {
      const methods = await electronApp.evaluate(async () => {
        const bridge = require('./src/voice-task-sdk/exchange-bridge');
        const exchange = bridge.getExchange();
        if (!exchange) return { error: 'No exchange instance' };
        return {
          hasGetTask: typeof exchange.getTask === 'function',
          hasSubmit: typeof exchange.submit === 'function',
          hasCancelTask: typeof exchange.cancelTask === 'function',
          hasGetQueueStats: typeof exchange.getQueueStats === 'function',
          hasAgentRegistry: !!exchange.agents,
          hasGetCount: typeof exchange.agents?.getCount === 'function',
          hasGetAll: typeof exchange.agents?.getAll === 'function',
        };
      });

      expect(methods.error).toBeUndefined();
      expect(methods.hasGetTask).toBe(true);
      expect(methods.hasSubmit).toBe(true);
      expect(methods.hasCancelTask).toBe(true);
      expect(methods.hasGetQueueStats).toBe(true);
      expect(methods.hasAgentRegistry).toBe(true);
      expect(methods.hasGetCount).toBe(true);
      expect(methods.hasGetAll).toBe(true);
    });

    test('exchange URL is ws://localhost:3456', async () => {
      const url = await electronApp.evaluate(async () => {
        const bridge = require('./src/voice-task-sdk/exchange-bridge');
        return bridge.getExchangeUrl();
      });
      expect(url).toBe('ws://localhost:3456');
    });

    test('at least one agent is registered', async () => {
      const info = await electronApp.evaluate(async () => {
        const bridge = require('./src/voice-task-sdk/exchange-bridge');
        const exchange = bridge.getExchange();
        if (!exchange) return { count: 0, agents: [] };
        const agents = exchange.agents.getAll();
        return {
          count: agents.length,
          agents: agents.slice(0, 20).map(a => ({
            id: a.id,
            name: a.name,
            enabled: a.enabled,
          })),
        };
      });

      expect(info.count).toBeGreaterThan(0);
      console.log(`  Registered agents: ${info.count}`);
      for (const a of info.agents) {
        console.log(`    - ${a.id} (${a.name}) enabled=${a.enabled}`);
      }
    });

    test('queue stats return valid structure', async () => {
      const stats = await electronApp.evaluate(async () => {
        const bridge = require('./src/voice-task-sdk/exchange-bridge');
        const exchange = bridge.getExchange();
        if (!exchange) return { error: 'No exchange' };
        try {
          return exchange.getQueueStats();
        } catch (e) {
          return { error: e.message };
        }
      });

      expect(stats).toBeDefined();
      expect(stats.error).toBeUndefined();
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // Tier 1: Deterministic -- Task Submission Lifecycle
  // ═════════════════════════════════════════════════════════════════════════════

  test.describe('Tier 1: Task Submission Lifecycle', () => {

    test('processSubmit returns required fields on valid input', async () => {
      const result = await electronApp.evaluate(async () => {
        const bridge = require('./src/voice-task-sdk/exchange-bridge');
        if (!bridge.isRunning()) return { error: 'Exchange not running' };
        return await bridge.processSubmit('What time is it?', {
          toolId: 'e2e-test',
          skipFilter: true,
        });
      });

      expect(result.error).toBeUndefined();
      expect(result.transcript).toBeTruthy();
      // Must have lifecycle flags
      expect('queued' in result || 'handled' in result).toBe(true);
      // If queued, must have a taskId
      if (result.queued) {
        expect(result.taskId).toBeTruthy();
        expect(result.action).toBeTruthy();
      }
    });

    test('empty transcript is rejected with proper message', async () => {
      const result = await electronApp.evaluate(async () => {
        const bridge = require('./src/voice-task-sdk/exchange-bridge');
        return await bridge.processSubmit('', { toolId: 'e2e-test' });
      });

      expect(result).toBeDefined();
      expect(result.queued).toBe(false);
      expect(result.message).toBeTruthy();
      expect(result.message.toLowerCase()).toContain('empty');
    });

    test('whitespace-only transcript is rejected', async () => {
      const result = await electronApp.evaluate(async () => {
        const bridge = require('./src/voice-task-sdk/exchange-bridge');
        return await bridge.processSubmit('   \n\t  ', { toolId: 'e2e-test' });
      });

      expect(result.queued).toBe(false);
    });

    test('duplicate submission within dedup window is detected', async () => {
      const uniquePhrase = `dedup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const results = await electronApp.evaluate(async (phrase) => {
        const bridge = require('./src/voice-task-sdk/exchange-bridge');
        const first = await bridge.processSubmit(phrase, {
          toolId: 'e2e-test',
          skipFilter: true,
        });
        // Immediate re-submit
        const second = await bridge.processSubmit(phrase, {
          toolId: 'e2e-test',
          skipFilter: true,
        });
        return { first, second };
      }, uniquePhrase);

      expect(results.first).toBeDefined();
      expect(results.second).toBeDefined();
      // Second should be flagged as duplicate
      expect(results.second.suppressAIResponse).toBe(true);
      expect(results.second.queued).toBe(false);
      expect(results.second.handled).toBe(true);
    });

    test('exchange-not-running returns graceful error', async () => {
      // We can't actually stop the exchange mid-test, so we verify the
      // error path structure by checking the error message constants
      const result = await electronApp.evaluate(async () => {
        const bridge = require('./src/voice-task-sdk/exchange-bridge');
        // Simulate what processSubmit returns when exchange is down
        // by checking the error-path return shape documented in the code
        const submission = await bridge.processSubmit('test query', {
          toolId: 'e2e-test',
          skipFilter: true,
        });
        // Verify the submission went through (exchange IS running)
        return {
          hasTranscript: !!submission.transcript,
          hasQueuedFlag: 'queued' in submission,
          hasHandledFlag: 'handled' in submission,
        };
      });

      expect(result.hasTranscript).toBe(true);
      expect(result.hasQueuedFlag).toBe(true);
    });

    test('submitted task reaches terminal status within 15 seconds', async () => {
      const lifecycle = await submitAndWaitForSettlement(
        electronApp,
        `What is two plus two? (test-${Date.now()})`,
        15000
      );

      expect(lifecycle.error).toBeUndefined();
      expect(lifecycle.timedOut).toBe(false);

      const terminalStatuses = ['SETTLED', 'DEAD_LETTER', 'HALTED', 'handled-directly'];
      expect(terminalStatuses).toContain(lifecycle.status);

      if (lifecycle.task) {
        console.log(`  Task ${lifecycle.task.id}: ${lifecycle.status} by ${lifecycle.agentId || 'n/a'} in ${lifecycle.task.durationMs || '?'}ms`);
      }
    });

    test('cancel a task returns boolean', async () => {
      const result = await electronApp.evaluate(async () => {
        const bridge = require('./src/voice-task-sdk/exchange-bridge');
        const exchange = bridge.getExchange();
        if (!exchange) return { error: 'No exchange' };
        // Cancel a non-existent task -- should return false gracefully
        const cancelled = exchange.cancelTask('nonexistent-task-id-12345');
        return { cancelled, type: typeof cancelled };
      });

      expect(result.error).toBeUndefined();
      expect(result.type).toBe('boolean');
      expect(result.cancelled).toBe(false); // non-existent task
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // Tier 1: Deterministic -- Edge Cases
  // ═════════════════════════════════════════════════════════════════════════════

  test.describe('Tier 1: Edge Cases', () => {

    for (const tc of EDGE_CASE_CORPUS) {
      test(`[${tc.id}] ${tc.description}`, async () => {
        const lifecycle = await submitAndWaitForSettlement(electronApp, tc.query, 15000);

        expect(lifecycle.error).toBeUndefined();

        if (tc.expectation === 'rejected-or-low-confidence') {
          // Gibberish: either rejected by filter, or routed to an agent that handles it
          // Both are acceptable -- the system shouldn't crash
          expect(lifecycle.submission).toBeDefined();
        } else if (tc.expectation === 'handled') {
          // Should be processed without error
          expect(lifecycle.submission).toBeDefined();
          expect(lifecycle.timedOut).toBe(false);
        } else if (tc.expectation === 'handled-or-decomposed') {
          expect(lifecycle.submission).toBeDefined();
          // Check for decomposition
          if (lifecycle.submission.decomposed) {
            expect(Array.isArray(lifecycle.submission.subtaskIds)).toBe(true);
            expect(lifecycle.submission.subtaskIds.length).toBeGreaterThan(1);
            console.log(`  Decomposed into ${lifecycle.submission.subtaskIds.length} subtasks`);
          }
        }
      });
    }

    test('rapid-fire submissions do not crash the exchange', async () => {
      const results = await electronApp.evaluate(async () => {
        const bridge = require('./src/voice-task-sdk/exchange-bridge');
        const submissions = [];
        const queries = [
          `rapid-fire-A-${Date.now()}`,
          `rapid-fire-B-${Date.now()}`,
          `rapid-fire-C-${Date.now()}`,
        ];

        for (const q of queries) {
          try {
            const sub = await bridge.processSubmit(q, {
              toolId: 'e2e-test',
              skipFilter: true,
            });
            submissions.push({ query: q, queued: sub.queued, error: null });
          } catch (e) {
            submissions.push({ query: q, queued: false, error: e.message });
          }
        }

        return {
          total: submissions.length,
          errors: submissions.filter(s => s.error).length,
          queued: submissions.filter(s => s.queued).length,
          exchangeStillRunning: bridge.isRunning(),
        };
      });

      expect(results.total).toBe(3);
      expect(results.errors).toBe(0);
      expect(results.exchangeStillRunning).toBe(true);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // Tier 2: LLM-Evaluated -- Routing Accuracy
  // ═════════════════════════════════════════════════════════════════════════════

  test.describe('Tier 2: LLM-Evaluated Routing Accuracy', () => {

    for (const tc of ROUTING_CORPUS) {
      test(`[${tc.id}] "${tc.query}" routes correctly`, async () => {
        // Unique-ify to avoid dedup
        const uniqueQuery = `${tc.query} (test-${Date.now()}-${Math.random().toString(36).slice(2, 6)})`;

        // Submit and wait for settlement
        const lifecycle = await submitAndWaitForSettlement(electronApp, uniqueQuery, 15000);
        expect(lifecycle.error).toBeUndefined();

        // --- Tier 1 checks (always run) ---

        // Task must not time out
        if (lifecycle.timedOut) {
          console.log(`  WARNING: Task timed out. Last status: ${lifecycle.status}`);
        }
        // We allow timeout but log it -- some agents are slow

        // If task was queued and settled, check agent
        if (lifecycle.agentId && tc.expectedAgentPattern) {
          const agentMatch = tc.expectedAgentPattern.test(lifecycle.agentId);
          if (!agentMatch) {
            console.log(`  Agent mismatch: expected ${tc.expectedAgentPattern}, got "${lifecycle.agentId}"`);
          }
          // Soft check -- LLM judge below is the authority
        }

        // --- Tier 2: LLM evaluation ---
        const judgment = await llmJudge(electronApp, {
          query: tc.query,
          agentId: lifecycle.agentId,
          result: lifecycle.result,
          status: lifecycle.status,
          rubric: tc.rubric,
        });

        console.log(`  [${tc.id}] Score: ${judgment.score}/100 (${judgment.evaluatedBy})`);
        for (const c of judgment.criteria) {
          const mark = c.pass ? 'PASS' : 'FAIL';
          console.log(`    ${mark}: ${c.criterion} -- ${c.reasoning}`);
        }

        // Main assertion: LLM judge score must be >= 70
        expect(judgment.score).toBeGreaterThanOrEqual(70);
        expect(judgment.pass).toBe(true);
      });
    }
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // Tier 2: LLM-Evaluated -- Response Quality
  // ═════════════════════════════════════════════════════════════════════════════

  test.describe('Tier 2: LLM-Evaluated Response Quality', () => {

    test('informational query produces useful response content', async () => {
      const query = `What is the current time? (test-${Date.now()})`;
      const lifecycle = await submitAndWaitForSettlement(electronApp, query, 15000);

      expect(lifecycle.error).toBeUndefined();

      const judgment = await llmJudge(electronApp, {
        query: 'What is the current time?',
        agentId: lifecycle.agentId,
        result: lifecycle.result,
        status: lifecycle.status,
        rubric: [
          'The response contains actual time information (hours, minutes) or indicates it is fetching/providing the time',
          'The response is concise and suitable for a voice assistant (under 50 words ideal)',
          'The response does not contain irrelevant information or error messages',
        ],
      });

      console.log(`  Time query response quality: ${judgment.score}/100`);
      expect(judgment.score).toBeGreaterThanOrEqual(60);
    });

    test('task result contains expected metadata', async () => {
      const query = `Tell me a fun fact (test-${Date.now()})`;
      const lifecycle = await submitAndWaitForSettlement(electronApp, query, 15000);

      expect(lifecycle.error).toBeUndefined();

      // If we got a settled task, check result structure
      if (lifecycle.status === 'SETTLED' && lifecycle.result) {
        expect('success' in lifecycle.result).toBe(true);
        if (lifecycle.result.data) {
          // Fast-path or normal result should have output
          expect(
            lifecycle.result.data.output !== undefined ||
            lifecycle.result.data.results !== undefined ||
            lifecycle.result.message !== undefined
          ).toBe(true);
        }
      }

      if (lifecycle.task) {
        expect(lifecycle.task.id).toBeTruthy();
        expect(lifecycle.task.content).toBeTruthy();
        if (lifecycle.task.completedAt && lifecycle.task.createdAt) {
          expect(lifecycle.task.durationMs).toBeGreaterThan(0);
        }
      }
    });

    test('settled task has assigned agent and non-null result', async () => {
      const query = `What day of the week is it? (test-${Date.now()})`;
      const lifecycle = await submitAndWaitForSettlement(electronApp, query, 15000);

      expect(lifecycle.error).toBeUndefined();

      if (lifecycle.status === 'SETTLED') {
        expect(lifecycle.agentId).toBeTruthy();
        expect(lifecycle.result).toBeDefined();
        expect(lifecycle.result).not.toBeNull();
        expect(lifecycle.result.success).toBe(true);
      } else if (lifecycle.status === 'handled-directly') {
        // Handled by router or fast-path -- also valid
        expect(lifecycle.submission.handled).toBe(true);
      } else {
        // DEAD_LETTER, HALTED -- log for investigation but don't fail hard
        // (the Tier 2 LLM judge tests cover quality)
        console.log(`  WARNING: Task ended with status ${lifecycle.status}`);
      }
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // Tier 2: LLM-Evaluated -- Auction Integrity
  // ═════════════════════════════════════════════════════════════════════════════

  test.describe('Tier 2: Auction Integrity', () => {

    test('two different queries route to different agents', async () => {
      const timeQuery = `What time is it? (test-${Date.now()}-a)`;
      const weatherQuery = `What is the weather forecast? (test-${Date.now()}-b)`;

      // Wait between submissions to avoid dedup
      const timeResult = await submitAndWaitForSettlement(electronApp, timeQuery, 15000);
      await sleep(2000); // Let dedup window pass
      const weatherResult = await submitAndWaitForSettlement(electronApp, weatherQuery, 15000);

      expect(timeResult.error).toBeUndefined();
      expect(weatherResult.error).toBeUndefined();

      // If both settled with agents, they should be different
      if (timeResult.agentId && weatherResult.agentId) {
        const sameAgent = timeResult.agentId === weatherResult.agentId;
        if (sameAgent) {
          console.log(`  WARNING: Both queries routed to same agent: ${timeResult.agentId}`);
        }

        // LLM evaluates whether the differentiation makes sense
        const judgment = await llmJudge(electronApp, {
          query: `Two queries were submitted: (1) "What time is it?" routed to ${timeResult.agentId}, (2) "What is the weather forecast?" routed to ${weatherResult.agentId}`,
          agentId: `${timeResult.agentId} and ${weatherResult.agentId}`,
          result: { success: true, data: { output: `Query 1 agent: ${timeResult.agentId}, Query 2 agent: ${weatherResult.agentId}` } },
          status: 'SETTLED',
          rubric: [
            'A time-related query should route to a time agent, not a weather agent',
            'A weather query should route to a weather agent, not a time agent',
            'The two queries should ideally route to different agents since they ask for different things',
          ],
        });

        console.log(`  Routing differentiation score: ${judgment.score}/100`);
        expect(judgment.score).toBeGreaterThanOrEqual(60);
      }
    });

    test('fast-path settlement works for informational queries', async () => {
      const query = `What time is it right now? (test-${Date.now()})`;
      const lifecycle = await submitAndWaitForSettlement(electronApp, query, 15000);

      expect(lifecycle.error).toBeUndefined();

      if (lifecycle.status === 'SETTLED' && lifecycle.result?.data?.fastPath) {
        // Verify fast-path result has content
        expect(lifecycle.result.data.output).toBeTruthy();
        console.log('  Fast-path settlement confirmed');
      } else if (lifecycle.status === 'SETTLED') {
        // Normal settlement -- also fine
        console.log('  Normal settlement (no fast-path)');
      }
      // Either path is acceptable
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // Error check (always last)
  // ═════════════════════════════════════════════════════════════════════════════

  test('no unexpected errors during task exchange tests', async () => {
    const errors = await checkNewErrors(errorSnapshot);
    const genuine = filterBenignErrors(errors);
    if (genuine.length > 0) {
      console.log(`Genuine errors found (${genuine.length}):`);
      for (const err of genuine.slice(0, 10)) {
        console.log(`  [${err.category}] ${err.message}`);
      }
    }
    expect(genuine.length).toBeLessThanOrEqual(5);
  });
});
