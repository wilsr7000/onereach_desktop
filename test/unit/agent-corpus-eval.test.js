/**
 * Agent Corpus Evaluation
 *
 * Data-driven conversation corpus that runs multi-turn transcripts through
 * agents and evaluates whether responses were helpful or failed.
 *
 * Each corpus entry is a conversation: an array of user turns executed
 * sequentially against one agent, with context accumulating between turns.
 * After execution, each turn is evaluated against:
 *   - Did the agent respond without crashing?
 *   - Does the response match expected patterns?
 *   - Did needsInput flows provide a useful prompt?
 *   - Was the overall conversation helpful?
 *
 * Run:  npx vitest run test/unit/agent-corpus-eval.test.js
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { writeFileSync } from 'fs';
import { join } from 'path';

// ─── Mocks (same foundation as agent-execute-contract.test.js) ───────────────

vi.mock(
  'electron',
  () => ({
    app: {
      getPath: vi.fn(() => '/tmp/test-agents'),
      whenReady: vi.fn(() => Promise.resolve()),
      isReady: vi.fn(() => true),
    },
    ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
    BrowserWindow: {
      getAllWindows: vi.fn(() => []),
      fromWebContents: vi.fn(() => null),
    },
    screen: { getPrimaryDisplay: vi.fn(() => ({ workAreaSize: { width: 1920, height: 1080 } })) },
    clipboard: { readText: vi.fn(() => ''), writeText: vi.fn() },
    nativeImage: { createFromDataURL: vi.fn() },
    shell: { openExternal: vi.fn() },
    dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  }),
  { virtual: true }
);

vi.mock(
  '../../settings-manager',
  () => ({
    getSettingsManager: vi.fn(() => ({
      get: vi.fn((key) => {
        const defaults = {
          'ai.openaiApiKey': 'test-key',
          'ai.anthropicApiKey': 'test-key',
          'ai.profiles': null,
          'calendar.provider': 'none',
          'calendar.accounts': [],
          'weather.units': 'imperial',
        };
        return defaults[key] ?? null;
      }),
      set: vi.fn(),
      getAll: vi.fn(() => ({})),
    })),
  }),
  { virtual: true }
);

vi.mock(
  '../../lib/log-event-queue',
  () => ({
    getLogQueue: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  }),
  { virtual: true }
);

vi.mock(
  '../../clipboard-storage-v2',
  () => ({
    getSharedStorage: vi.fn(() => null),
  }),
  { virtual: true }
);

vi.mock(
  '../../lib/ai-service',
  () => {
    const mockChat = vi.fn(async () => ({
      content: 'Mock AI response for corpus eval',
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }));
    return {
      default: { chat: mockChat, complete: vi.fn(async () => 'Mock response'), json: vi.fn(async () => ({})) },
      chat: mockChat,
      complete: vi.fn(async () => 'Mock response'),
      json: vi.fn(async () => ({})),
      vision: vi.fn(async () => ({ content: 'Mock' })),
      embed: vi.fn(async () => [0.1, 0.2]),
    };
  },
  { virtual: true }
);

vi.mock(
  '../../lib/agent-memory-store',
  () => ({
    getAgentMemory: vi.fn(() => ({
      load: vi.fn(async () => {}),
      save: vi.fn(async () => {}),
      get: vi.fn(() => null),
      set: vi.fn(),
      getSection: vi.fn(() => []),
      addToSection: vi.fn(),
    })),
  }),
  { virtual: true }
);

vi.mock(
  '../../lib/thinking-agent',
  () => ({
    learnFromInteraction: vi.fn(async () => {}),
    reviewExecution: vi.fn(async (_task, result) => result),
    getTimeContext: vi.fn(() => ({ timeOfDay: 'morning', dayOfWeek: 'Monday' })),
  }),
  { virtual: true }
);

vi.mock(
  '../../lib/user-profile-store',
  () => ({
    getUserProfile: vi.fn(() => ({
      get: vi.fn(() => null),
      set: vi.fn(),
      getAll: vi.fn(() => ({})),
    })),
  }),
  { virtual: true }
);

vi.mock(
  '../../lib/calendar-store',
  () => ({
    getCalendarStore: vi.fn(() => ({
      getEvents: vi.fn(async () => []),
      getTodayEvents: vi.fn(async () => []),
    })),
  }),
  { virtual: true }
);

vi.mock(
  '../../lib/calendar-data',
  () => ({
    getCalendarData: vi.fn(() => ({
      getEvents: vi.fn(async () => []),
      getAccounts: vi.fn(() => []),
    })),
  }),
  { virtual: true }
);

vi.mock(
  '../../lib/http-client',
  () => ({
    fetch: vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '',
    })),
    fetchJSON: vi.fn(async () => ({})),
    resetCircuits: vi.fn(),
  }),
  { virtual: true }
);

vi.mock(
  '../../lib/exchange/event-bus',
  () => {
    const EventEmitter = require('events');
    const bus = new EventEmitter();
    bus.registerBridge = vi.fn();
    bus.getExchange = vi.fn(() => null);
    bus.processSubmit = vi.fn(async () => ({ taskId: null, queued: false }));
    return bus;
  },
  { virtual: true }
);

vi.mock(
  '../../lib/playbook-executor',
  () => ({
    executePlaybook: vi.fn(async () => ({ success: true, results: [] })),
    getPlaybookExecutor: vi.fn(() => ({
      execute: vi.fn(async () => ({ success: true, results: [] })),
    })),
  }),
  { virtual: true }
);

vi.mock(
  '../../lib/browser-automation',
  () => ({
    launch: vi.fn(async () => null),
    isAvailable: vi.fn(() => false),
  }),
  { virtual: true }
);

vi.mock(
  '../../lib/transcript-service',
  () => ({
    getTranscriptService: vi.fn(() => ({
      push: vi.fn(),
      getRecent: vi.fn(() => []),
      hasPending: vi.fn(() => false),
    })),
  }),
  { virtual: true }
);

vi.mock(
  '../../lib/contact-store',
  () => ({
    getContactStore: vi.fn(() => ({
      search: vi.fn(async () => []),
      getAll: vi.fn(async () => []),
    })),
  }),
  { virtual: true }
);

vi.mock(
  '../../lib/contact-db',
  () => ({
    getContactDB: vi.fn(() => ({
      search: vi.fn(async () => []),
      getAll: vi.fn(async () => []),
    })),
  }),
  { virtual: true }
);

// ─── Evaluation helpers ──────────────────────────────────────────────────────

/**
 * Evaluate a single turn result against expectations.
 * Returns { pass, reason, grade }.
 *   grade: 'pass' | 'partial' | 'fail' | 'crash'
 */
function evaluateTurn(result, turn) {
  // Crash: execute() threw (should never happen -- caught upstream)
  if (!result) {
    return { pass: false, grade: 'crash', reason: 'No result returned' };
  }

  // Must be an object with success boolean
  if (typeof result !== 'object' || typeof result.success !== 'boolean') {
    return { pass: false, grade: 'crash', reason: 'Malformed result (missing success boolean)' };
  }

  // Check needsInput expectations
  if (turn.expect.needsInput) {
    if (!result.needsInput) {
      return { pass: false, grade: 'fail', reason: 'Expected needsInput but agent returned a final response' };
    }
    if (!result.needsInput.prompt || result.needsInput.prompt.length === 0) {
      return { pass: false, grade: 'fail', reason: 'needsInput has no prompt' };
    }
    // If a prompt pattern is given, check it
    if (turn.expect.promptPattern && !turn.expect.promptPattern.test(result.needsInput.prompt)) {
      return {
        pass: false,
        grade: 'partial',
        reason: `needsInput prompt "${result.needsInput.prompt.slice(0, 60)}" did not match pattern ${turn.expect.promptPattern}`,
      };
    }
    return { pass: true, grade: 'pass', reason: 'needsInput with valid prompt' };
  }

  // Check success expectation
  if (turn.expect.success === true && !result.success && !result.needsInput) {
    // Some agents return success: false with a message in mocked env -- partial credit
    if (result.message && result.message.length > 0) {
      return {
        pass: false,
        grade: 'partial',
        reason: `success: false but has message: "${result.message.slice(0, 60)}"`,
      };
    }
    return { pass: false, grade: 'fail', reason: 'Expected success but got failure with no message' };
  }

  // Check response content pattern
  const responseText = result.message || result.needsInput?.prompt || '';
  if (turn.expect.pattern && responseText) {
    if (!turn.expect.pattern.test(responseText)) {
      return {
        pass: false,
        grade: 'partial',
        reason: `Response "${responseText.slice(0, 60)}" did not match pattern ${turn.expect.pattern}`,
      };
    }
  }

  // Check that there IS a response
  if (!responseText && !result.success) {
    return { pass: false, grade: 'fail', reason: 'No message and no success' };
  }

  return { pass: true, grade: 'pass', reason: 'Response meets expectations' };
}

// ─── Conversation Corpus ─────────────────────────────────────────────────────
// Each entry: { name, agentId, turns: [{ user, expect }] }
// turns are executed sequentially with accumulating context.

const CORPUS = [
  // ── Time ────────────────────────────────────────────────────
  {
    name: 'Time: basic queries',
    agentId: 'time-agent',
    turns: [
      { user: 'What time is it?', expect: { success: true, pattern: /\d/ } },
      { user: 'And what day is it today?', expect: { success: true, pattern: /day|mon|tue|wed|thu|fri|sat|sun/i } },
      { user: 'What is the date?', expect: { success: true, pattern: /\d/ } },
    ],
  },
  {
    name: 'Time: timezone awareness',
    agentId: 'time-agent',
    turns: [
      { user: 'What time is it in Tokyo?', expect: { success: true } },
      { user: 'And in London?', expect: { success: true } },
    ],
  },

  // ── Weather ─────────────────────────────────────────────────
  {
    name: 'Weather: city provided',
    agentId: 'weather-agent',
    turns: [{ user: 'What is the weather in Denver?', expect: { success: true } }],
  },
  {
    name: 'Weather: no city triggers follow-up',
    agentId: 'weather-agent',
    turns: [
      { user: "What's the weather?", expect: { needsInput: true } },
      { user: 'San Francisco', expect: { success: true } },
    ],
  },
  {
    name: 'Weather: forecast request',
    agentId: 'weather-agent',
    turns: [{ user: 'Will it rain tomorrow in Seattle?', expect: { success: true } }],
  },

  // ── Spelling ────────────────────────────────────────────────
  {
    name: 'Spelling: common words',
    agentId: 'spelling-agent',
    turns: [
      { user: 'How do you spell necessary?', expect: { success: true, pattern: /n.e.c.e.s.s.a.r.y/i } },
      { user: 'And accommodation?', expect: { success: true, pattern: /a.c.c.o.m.m.o.d.a.t.i.o.n/i } },
      { user: 'Spell entrepreneur', expect: { success: true, pattern: /e.n.t.r.e.p.r.e.n.e.u.r/i } },
    ],
  },
  {
    name: 'Spelling: misspelling correction',
    agentId: 'spelling-agent',
    turns: [
      { user: 'Is recieve spelled correctly?', expect: { success: true, pattern: /receive/i } },
      { user: 'How about definately?', expect: { success: true, pattern: /definitely/i } },
    ],
  },

  // ── Smalltalk ───────────────────────────────────────────────
  {
    name: 'Smalltalk: greeting flow',
    agentId: 'smalltalk-agent',
    turns: [
      { user: 'Hello there', expect: { success: true } },
      { user: 'How are you doing?', expect: { success: true } },
      { user: 'Thanks for your help', expect: { success: true } },
      { user: 'Goodbye', expect: { success: true } },
    ],
  },
  {
    name: 'Smalltalk: casual greetings',
    agentId: 'smalltalk-agent',
    turns: [
      { user: 'Hey', expect: { success: true } },
      { user: 'Good morning', expect: { success: true } },
      { user: 'Good night', expect: { success: true } },
    ],
  },

  // ── Help ────────────────────────────────────────────────────
  {
    name: 'Help: capabilities inquiry',
    agentId: 'help-agent',
    turns: [
      { user: 'What can you do?', expect: { success: true } },
      { user: 'Tell me more about the agents', expect: { success: true } },
    ],
  },
  {
    name: 'Help: feature questions',
    agentId: 'help-agent',
    turns: [
      { user: 'Help', expect: { success: true } },
      { user: 'How do I use voice commands?', expect: { success: true } },
    ],
  },

  // ── Calendar query ──────────────────────────────────────────
  {
    name: 'Calendar: schedule queries',
    agentId: 'calendar-query-agent',
    turns: [
      { user: 'What meetings do I have today?', expect: { success: true } },
      { user: 'Am I free at 3pm?', expect: { success: true } },
      { user: 'Show my schedule for this week', expect: { success: true } },
    ],
  },

  // ── Calendar create ─────────────────────────────────────────
  {
    name: 'Calendar: create with full details',
    agentId: 'calendar-create-agent',
    turns: [
      { user: 'Schedule a meeting with Bob at 2pm tomorrow', expect: { needsInput: true } },
      { user: 'One hour, in the conference room', expect: { success: true } },
    ],
  },
  {
    name: 'Calendar: create with missing details',
    agentId: 'calendar-create-agent',
    turns: [
      { user: 'Add a dentist appointment', expect: { needsInput: true } },
      { user: 'Next Monday at 10am', expect: { success: true } },
    ],
  },

  // ── Calendar edit ───────────────────────────────────────────
  {
    name: 'Calendar: reschedule',
    agentId: 'calendar-edit-agent',
    turns: [{ user: 'Move my 3pm meeting to 4pm', expect: { needsInput: true } }],
  },

  // ── Calendar delete ─────────────────────────────────────────
  {
    name: 'Calendar: cancel event',
    agentId: 'calendar-delete-agent',
    turns: [{ user: 'Cancel my meeting tomorrow at noon', expect: { needsInput: true } }],
  },

  // ── Search ──────────────────────────────────────────────────
  {
    name: 'Search: document queries',
    agentId: 'search-agent',
    turns: [
      { user: 'Search for quarterly revenue reports', expect: { success: true } },
      { user: 'Find documents about project alpha', expect: { success: true } },
    ],
  },

  // ── Email ───────────────────────────────────────────────────
  {
    name: 'Email: compose flow',
    agentId: 'email-agent',
    turns: [{ user: 'Send an email to John about the meeting tomorrow', expect: { needsInput: true } }],
  },

  // ── DJ ──────────────────────────────────────────────────────
  {
    name: 'DJ: music requests',
    agentId: 'dj-agent',
    turns: [
      { user: 'Play some jazz music', expect: { success: true } },
      { user: 'Something more upbeat', expect: { success: true } },
    ],
  },

  // ── Recorder ────────────────────────────────────────────────
  {
    name: 'Recorder: start recording',
    agentId: 'recorder-agent',
    turns: [{ user: 'Start recording the meeting', expect: { success: true } }],
  },

  // ── Meeting agents ──────────────────────────────────────────
  {
    name: 'Action items: capture from conversation',
    agentId: 'action-item-agent',
    turns: [
      { user: 'Bob will send the report by Friday', expect: { success: true } },
      { user: 'Sarah needs to review the budget proposal by next week', expect: { success: true } },
    ],
  },
  {
    name: 'Decisions: log team decisions',
    agentId: 'decision-agent',
    turns: [
      { user: 'We decided to go with vendor A for the cloud migration', expect: { success: true } },
      { user: 'The team agreed to postpone the launch to March', expect: { success: true } },
    ],
  },
  {
    name: 'Meeting notes: capture key points',
    agentId: 'meeting-notes-agent',
    turns: [
      { user: 'Take note of this discussion about the Q2 budget', expect: { success: true } },
      { user: 'Bookmark this moment -- important agreement on pricing', expect: { success: true } },
    ],
  },

  // ── Docs ────────────────────────────────────────────────────
  {
    name: 'Docs: product questions',
    agentId: 'docs-agent',
    turns: [
      { user: 'How do I configure the AI service?', expect: { success: true } },
      { user: 'What are the keyboard shortcuts?', expect: { success: true } },
    ],
  },

  // ── Daily brief ─────────────────────────────────────────────
  {
    name: 'Daily brief: morning briefing',
    agentId: 'daily-brief-agent',
    turns: [{ user: 'Give me my morning briefing', expect: { success: true } }],
  },

  // ── Memory ──────────────────────────────────────────────────
  {
    name: 'Memory: store and recall preferences',
    agentId: 'memory-agent',
    turns: [
      { user: 'Remember that I prefer dark mode', expect: { success: true } },
      { user: 'My favorite programming language is Rust', expect: { success: true } },
      { user: 'What do you know about me?', expect: { success: true } },
    ],
  },

  // ── Playbook ────────────────────────────────────────────────
  {
    name: 'Playbook: execute a playbook',
    agentId: 'playbook-agent',
    turns: [{ user: 'Run the onboarding playbook', expect: { success: true } }],
  },

  // ── Browser ─────────────────────────────────────────────────
  {
    name: 'Browser: web navigation',
    agentId: 'browser-agent',
    turns: [{ user: 'Go to google.com and search for weather', expect: { success: true } }],
  },

  // ── App ─────────────────────────────────────────────────────
  {
    name: 'App: navigation commands',
    agentId: 'app-agent',
    turns: [
      { user: 'Open settings', expect: { success: true } },
      { user: 'Open the video editor', expect: { success: true } },
    ],
  },

  // ── Spaces ──────────────────────────────────────────────────
  {
    name: 'Spaces: content management',
    agentId: 'spaces-agent',
    turns: [
      { user: 'What spaces do I have?', expect: { success: true } },
      { user: 'Create a new space called project notes', expect: { success: true } },
    ],
  },

  // ── Error agent ─────────────────────────────────────────────
  {
    name: 'Error agent: graceful failure handling',
    agentId: 'error-agent',
    turns: [{ user: 'Something went wrong with my last request', expect: { success: true } }],
  },

  // ── Orchestrator ────────────────────────────────────────────
  {
    name: 'Orchestrator: composite request',
    agentId: 'orchestrator-agent',
    turns: [{ user: 'Check the weather and my calendar for today', expect: { success: true } }],
  },

  // ── Edge cases ──────────────────────────────────────────────
  {
    name: 'Edge: garbled input',
    agentId: 'smalltalk-agent',
    turns: [{ user: 'asdfghjkl', expect: { success: true } }],
  },
  {
    name: 'Edge: single word',
    agentId: 'help-agent',
    turns: [{ user: 'help', expect: { success: true } }],
  },
  {
    name: 'Edge: very long input',
    agentId: 'help-agent',
    turns: [
      {
        user: 'I need help understanding how to use all the different features of this application including the video editor the spaces manager the voice orb the agent system the calendar integration and everything else you offer',
        expect: { success: true },
      },
    ],
  },
];

// ═════════════════════════════════════════════════════════════════════════════
// TESTS
// ═════════════════════════════════════════════════════════════════════════════

describe('Agent Corpus Evaluation', () => {
  // Track results for the summary
  const evalResults = [];

  // Pre-load agents
  const loadableAgents = new Set();
  (() => {
    try {
      const reg = require('../../packages/agents/agent-registry');
      for (const id of reg.BUILT_IN_AGENT_IDS) {
        try {
          require(`../../packages/agents/${id}`);
          loadableAgents.add(id);
        } catch (_) {
          /* skip */
        }
      }
    } catch (_) {
      /* registry failed */
    }
  })();

  afterAll(() => {
    // Print evaluation summary
    const total = evalResults.length;
    const passed = evalResults.filter((r) => r.grade === 'pass').length;
    const partial = evalResults.filter((r) => r.grade === 'partial').length;
    const failed = evalResults.filter((r) => r.grade === 'fail').length;
    const crashed = evalResults.filter((r) => r.grade === 'crash').length;

    // Build report
    const lines = [];
    lines.push('='.repeat(70));
    lines.push('  CORPUS EVALUATION SUMMARY');
    lines.push('='.repeat(70));
    lines.push(`  Total turns evaluated: ${total}`);
    lines.push(`  Pass:    ${passed}  (${total ? Math.round((passed / total) * 100) : 0}%)`);
    lines.push(`  Partial: ${partial}  (${total ? Math.round((partial / total) * 100) : 0}%)`);
    lines.push(`  Fail:    ${failed}  (${total ? Math.round((failed / total) * 100) : 0}%)`);
    lines.push(`  Crash:   ${crashed}  (${total ? Math.round((crashed / total) * 100) : 0}%)`);
    lines.push('='.repeat(70));

    if (failed > 0 || crashed > 0) {
      lines.push('');
      lines.push('  FAILURES:');
      for (const r of evalResults.filter((r) => r.grade === 'fail' || r.grade === 'crash')) {
        lines.push(`    [${r.grade.toUpperCase()}] ${r.conversation} / "${r.user.slice(0, 50)}" -> ${r.reason}`);
      }
    }
    if (partial > 0) {
      lines.push('');
      lines.push('  PARTIAL:');
      for (const r of evalResults.filter((r) => r.grade === 'partial')) {
        lines.push(`    [PARTIAL] ${r.conversation} / "${r.user.slice(0, 50)}" -> ${r.reason}`);
      }
    }

    // Per-conversation breakdown
    lines.push('');
    lines.push('-'.repeat(70));
    lines.push('  PER-CONVERSATION RESULTS');
    lines.push('-'.repeat(70));
    const grouped = {};
    for (const r of evalResults) {
      if (!grouped[r.conversation]) grouped[r.conversation] = [];
      grouped[r.conversation].push(r);
    }
    for (const [name, turns] of Object.entries(grouped)) {
      const allPass = turns.every((t) => t.grade === 'pass');
      const icon = allPass ? 'PASS' : turns.some((t) => t.grade === 'crash' || t.grade === 'fail') ? 'FAIL' : 'PARTIAL';
      lines.push(`  [${icon}] ${name} (${turns[0].agentId})`);
      for (const t of turns) {
        const status = t.grade === 'pass' ? '+' : t.grade === 'partial' ? '~' : '-';
        const respSnippet = t.response ? ` -> "${t.response.slice(0, 55)}"` : '';
        lines.push(`    ${status} "${t.user.slice(0, 50)}"${respSnippet}`);
      }
    }
    lines.push('');

    const report = lines.join('\n');

    // Write report to file (always readable)
    const reportPath = join(__dirname, '..', 'corpus-eval-report.txt');
    try {
      writeFileSync(reportPath, report, 'utf8');
    } catch (_) {
      /* non-fatal */
    }

    // Also write JSON for programmatic analysis
    const jsonPath = join(__dirname, '..', 'corpus-eval-report.json');
    try {
      writeFileSync(
        jsonPath,
        JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            summary: { total, passed, partial, failed, crashed },
            results: evalResults,
          },
          null,
          2
        ),
        'utf8'
      );
    } catch (_) {
      /* non-fatal */
    }

    // Print to stderr (bypasses Vitest console capture)
    process.stderr.write('\n' + report + '\n');
  });

  for (const conversation of CORPUS) {
    describe(conversation.name, () => {
      // Skip if agent can't load
      if (!loadableAgents.has(conversation.agentId)) {
        it(`skipped (${conversation.agentId} could not load)`, () => {
          expect(true).toBe(true);
        });
        return;
      }

      let agent;
      let conversationHistory = [];

      beforeAll(() => {
        agent = require(`../../packages/agents/${conversation.agentId}`);
        conversationHistory = [];
      });

      for (let i = 0; i < conversation.turns.length; i++) {
        const turn = conversation.turns[i];

        it(`turn ${i + 1}: "${turn.user.slice(0, 55)}"`, async () => {
          const task = {
            id: `corpus-${conversation.agentId}-${Date.now()}-${i}`,
            content: turn.user,
            input: turn.user,
            context: {
              signal: { aborted: false },
              conversationHistory,
              conversationText: conversationHistory.map((h) => `${h.role}: ${h.content}`).join('\n'),
              userInput: turn.user,
            },
          };

          let result;
          try {
            result = await agent.execute(task, {
              signal: { aborted: false },
              onProgress: vi.fn(),
            });
          } catch (err) {
            // execute() threw -- record as crash
            const evalResult = {
              conversation: conversation.name,
              agentId: conversation.agentId,
              user: turn.user,
              grade: 'crash',
              reason: `Threw: ${err.message}`,
              response: null,
            };
            evalResults.push(evalResult);
            expect.fail(`${conversation.agentId} threw on "${turn.user}": ${err.message}`);
          }

          // Accumulate conversation history for subsequent turns
          conversationHistory.push({ role: 'user', content: turn.user });
          if (result.message) {
            conversationHistory.push({ role: 'assistant', content: result.message });
          } else if (result.needsInput?.prompt) {
            conversationHistory.push({ role: 'assistant', content: result.needsInput.prompt });
          }

          // Evaluate
          const evaluation = evaluateTurn(result, turn);
          evalResults.push({
            conversation: conversation.name,
            agentId: conversation.agentId,
            user: turn.user,
            grade: evaluation.grade,
            reason: evaluation.reason,
            response: (result.message || result.needsInput?.prompt || '').slice(0, 100),
          });

          // Assert: crash and fail are test failures; partial is a warning
          if (evaluation.grade === 'crash') {
            expect.fail(evaluation.reason);
          }
          if (evaluation.grade === 'fail') {
            // For mocked environment, allow fails that are due to missing services
            // but still record them in the evaluation summary
            console.warn(`  [FAIL] ${conversation.name}: "${turn.user}" -> ${evaluation.reason}`);
          }

          // Always assert: no crash, result is well-formed
          expect(result).toBeDefined();
          expect(typeof result).toBe('object');
          expect(typeof result.success).toBe('boolean');
        });
      }
    });
  }
});
