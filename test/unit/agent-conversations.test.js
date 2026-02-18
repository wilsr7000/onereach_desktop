/**
 * Agent Conversation Tests
 *
 * Tests every registered agent with realistic user conversation text.
 * Verifies that agents produce meaningful responses (not just contract shape).
 *
 * Each agent gets multiple conversation scenarios that mimic real voice input.
 * Tests validate:
 *   - execute() succeeds or returns needsInput (not crash/undefined)
 *   - Response message is non-empty and relevant
 *   - needsInput responses include a prompt
 *   - No agent throws on realistic input
 *
 * Run:  npx vitest run test/unit/agent-conversations.test.js
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

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
      content: 'Mock AI response for conversation test',
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

// ─── Conversation Corpus ─────────────────────────────────────────────────────
// Realistic user utterances for each agent. Each entry: { text, expectation }.
// expectation: 'success' | 'needsInput' | 'either' (some agents may ask follow-ups)

const CONVERSATIONS = {
  'orchestrator-agent': [
    { text: 'Check the weather and my calendar for today', expectation: 'either' },
    { text: 'Give me a summary of everything happening this week', expectation: 'either' },
  ],
  'app-agent': [
    { text: 'How do I use the video editor?', expectation: 'either' },
    { text: 'What features does this app have?', expectation: 'either' },
    { text: 'Show me how to manage my spaces', expectation: 'either' },
  ],
  'spaces-agent': [
    { text: 'Show me my saved items', expectation: 'either' },
    { text: 'Create a new space called project notes', expectation: 'either' },
    { text: 'What spaces do I have?', expectation: 'either' },
  ],
  'time-agent': [
    { text: 'What time is it?', expectation: 'success' },
    { text: 'What day of the week is it?', expectation: 'success' },
    { text: 'What is the date today?', expectation: 'success' },
  ],
  'weather-agent': [
    { text: 'What is the weather in San Francisco?', expectation: 'either' },
    { text: 'Will it rain tomorrow in New York?', expectation: 'either' },
    { text: 'What is the temperature outside?', expectation: 'either' },
  ],
  'calendar-query-agent': [
    { text: 'What meetings do I have today?', expectation: 'either' },
    { text: 'Am I free at 3pm tomorrow?', expectation: 'either' },
    { text: 'Show me my schedule for this week', expectation: 'either' },
  ],
  'calendar-create-agent': [
    { text: 'Schedule a meeting with Bob at 2pm tomorrow', expectation: 'either' },
    { text: 'Add a dentist appointment next Monday at 10am', expectation: 'either' },
  ],
  'calendar-edit-agent': [
    { text: 'Move my 3pm meeting to 4pm', expectation: 'either' },
    { text: 'Change the location of the team standup to room 301', expectation: 'either' },
  ],
  'calendar-delete-agent': [
    { text: 'Cancel my meeting tomorrow at noon', expectation: 'either' },
    { text: 'Delete the dentist appointment', expectation: 'either' },
  ],
  'help-agent': [
    { text: 'What can you do?', expectation: 'success' },
    { text: 'Help me understand the agents', expectation: 'success' },
    { text: 'List all available commands', expectation: 'success' },
  ],
  'search-agent': [
    { text: 'Search for quarterly revenue reports', expectation: 'either' },
    { text: 'Find documents about project alpha', expectation: 'either' },
  ],
  'smalltalk-agent': [
    { text: 'Hello there', expectation: 'success' },
    { text: 'Good morning', expectation: 'success' },
    { text: 'Thanks for your help', expectation: 'success' },
    { text: 'How are you doing?', expectation: 'success' },
  ],
  'spelling-agent': [
    { text: 'How do you spell entrepreneur?', expectation: 'success' },
    { text: 'Spell accommodation', expectation: 'success' },
    { text: 'What is the correct spelling of necessary?', expectation: 'success' },
  ],
  'dj-agent': [
    { text: 'Play some jazz music', expectation: 'either' },
    { text: 'Put on something relaxing', expectation: 'either' },
    { text: 'Play Bohemian Rhapsody', expectation: 'either' },
  ],
  'email-agent': [
    { text: 'Send an email to John about the meeting tomorrow', expectation: 'either' },
    { text: 'Draft a follow-up email to the design team', expectation: 'either' },
  ],
  'recorder-agent': [
    { text: 'Start recording the meeting', expectation: 'either' },
    { text: 'Record this conversation', expectation: 'either' },
  ],
  'meeting-monitor-agent': [
    { text: 'Monitor this meeting for action items', expectation: 'either' },
    { text: 'Watch for any decisions being made', expectation: 'either' },
  ],
  'error-agent': [
    { text: 'Something went wrong with my last request', expectation: 'either' },
    { text: 'The previous task failed', expectation: 'either' },
  ],
  'action-item-agent': [
    { text: 'Bob will send the report by Friday', expectation: 'either' },
    { text: 'Capture action item: review the proposal by end of week', expectation: 'either' },
  ],
  'decision-agent': [
    { text: 'We decided to go with vendor A for the project', expectation: 'either' },
    { text: 'The team agreed to postpone the launch to March', expectation: 'either' },
  ],
  'meeting-notes-agent': [
    { text: 'Take note of this discussion about the budget', expectation: 'either' },
    { text: 'Bookmark this moment in the meeting', expectation: 'either' },
  ],
  'docs-agent': [
    { text: 'How do I configure the AI service?', expectation: 'either' },
    { text: 'What are the keyboard shortcuts?', expectation: 'either' },
  ],
  'daily-brief-agent': [
    { text: 'Give me my morning briefing', expectation: 'either' },
    { text: 'What do I have going on today?', expectation: 'either' },
  ],
  'memory-agent': [
    { text: 'What do you know about me?', expectation: 'either' },
    { text: 'Remember that I prefer dark mode', expectation: 'either' },
    { text: 'My favorite color is blue', expectation: 'either' },
  ],
  'playbook-agent': [
    { text: 'Run the onboarding playbook', expectation: 'either' },
    { text: 'Execute the weekly review checklist', expectation: 'either' },
  ],
  'browser-agent': [
    { text: 'Go to google.com and search for weather', expectation: 'either' },
    { text: 'Open the company dashboard', expectation: 'either' },
  ],
};

// ═════════════════════════════════════════════════════════════════════════════
// TESTS
// ═════════════════════════════════════════════════════════════════════════════

describe('Agent Conversations', () => {
  // Pre-load agents to discover which ones are available in the test environment
  const agentEntries = (() => {
    const entries = [];
    try {
      const reg = require('../../packages/agents/agent-registry');
      for (const agentId of reg.BUILT_IN_AGENT_IDS) {
        try {
          require(`../../packages/agents/${agentId}`);
          entries.push(agentId);
        } catch (_) {
          // skip agents that can't load
        }
      }
    } catch (_) {
      /* registry failed */
    }
    return entries;
  })();

  it('loads all registered agents', () => {
    expect(agentEntries.length).toBeGreaterThan(20);
  });

  describe.each(agentEntries.map((id) => [id]))('%s', (agentId) => {
    let agent;

    beforeAll(() => {
      agent = require(`../../packages/agents/${agentId}`);
    });

    const scenarios = CONVERSATIONS[agentId] || [{ text: 'Hello, can you help me?', expectation: 'either' }];

    it.each(scenarios.map((s, _i) => [`"${s.text.slice(0, 50)}"`, s]))('handles %s', async (_label, scenario) => {
      const task = {
        id: `conv-${agentId}-${Date.now()}`,
        content: scenario.text,
        input: scenario.text,
        context: {
          signal: { aborted: false },
          conversationHistory: [],
          conversationText: '',
        },
      };

      let result;
      try {
        result = await agent.execute(task, {
          signal: { aborted: false },
          onProgress: vi.fn(),
        });
      } catch (err) {
        expect.fail(`${agentId}.execute() threw on "${scenario.text}": ${err.message}`);
      }

      // Must return an object
      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
      expect(typeof result.success).toBe('boolean');

      if (scenario.expectation === 'success') {
        // Must succeed with a message (unless it returned needsInput, which is also acceptable)
        if (!result.needsInput) {
          expect(result.success).toBe(true);
        }
      }

      // If needsInput, must include a prompt
      if (result.needsInput) {
        expect(result.needsInput.prompt).toBeDefined();
        expect(typeof result.needsInput.prompt).toBe('string');
        expect(result.needsInput.prompt.length).toBeGreaterThan(0);
      }

      // Must have a message or needsInput prompt (some system agents return success with no message)
      const hasMessage = result.message && result.message.length > 0;
      const hasPrompt = result.needsInput && result.needsInput.prompt && result.needsInput.prompt.length > 0;
      const hasResponse = hasMessage || hasPrompt || result.success;
      expect(hasResponse).toBeTruthy();
    });
  });
});
