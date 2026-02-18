/**
 * First-Class Custom Agents - Unit Tests
 *
 * Tests the v2 agent schema, generator, auto-tester pipeline, and
 * the runtime executeLocalAgent() upgrades.
 *
 * Run:  npx vitest run test/unit/first-class-agents.test.js
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Electron mock ──────────────────────────────────────────────────────────
vi.mock(
  'electron',
  () => ({
    app: { getPath: vi.fn(() => '/tmp/test-agents') },
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    BrowserWindow: { getAllWindows: vi.fn(() => []) },
  }),
  { virtual: true }
);

// ─── Settings mock ──────────────────────────────────────────────────────────
vi.mock(
  '../../settings-manager',
  () => ({
    getSettingsManager: vi.fn(() => ({
      get: vi.fn((key) => {
        const defaults = {
          'ai.openaiApiKey': 'test-key',
          'ai.anthropicApiKey': 'test-key',
          'ai.profiles': null,
        };
        return defaults[key] ?? null;
      }),
      set: vi.fn(),
    })),
  }),
  { virtual: true }
);

// ─── Log queue mock ─────────────────────────────────────────────────────────
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

// ─── clipboard-storage mock (for agent-memory-store) ────────────────────────
vi.mock(
  '../../clipboard-storage-v2',
  () => ({
    getSharedStorage: vi.fn(() => null),
  }),
  { virtual: true }
);

// ─── AI service: We patch ai.chat on the Proxy object directly ──────────────
// ai-service exports a Proxy whose set() stores on _namedExports and whose
// get() checks _namedExports first. So setting ai.chat = mockFn makes it
// return the mock from any require('./ai-service').chat() call.

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Agent Store - Schema Migration
// ═══════════════════════════════════════════════════════════════════════════════

describe('Agent Store - Schema Migration', () => {
  let AgentStore, DEFAULT_LOCAL_AGENT, AGENT_SCHEMA_VERSION;

  beforeEach(async () => {
    // Dynamic import to pick up mocks
    const mod = require('../../src/voice-task-sdk/agent-store');
    AgentStore = mod.AgentStore;
    DEFAULT_LOCAL_AGENT = mod.DEFAULT_LOCAL_AGENT;
    AGENT_SCHEMA_VERSION = mod.AGENT_SCHEMA_VERSION;
  });

  it('DEFAULT_LOCAL_AGENT has all v2 fields', () => {
    expect(DEFAULT_LOCAL_AGENT).toHaveProperty('schemaVersion', AGENT_SCHEMA_VERSION);
    expect(DEFAULT_LOCAL_AGENT).toHaveProperty('voice', null);
    expect(DEFAULT_LOCAL_AGENT).toHaveProperty('acks');
    expect(Array.isArray(DEFAULT_LOCAL_AGENT.acks)).toBe(true);
    expect(DEFAULT_LOCAL_AGENT).toHaveProperty('estimatedExecutionMs', 5000);
    expect(DEFAULT_LOCAL_AGENT).toHaveProperty('dataSources');
    expect(DEFAULT_LOCAL_AGENT).toHaveProperty('memory');
    expect(DEFAULT_LOCAL_AGENT.memory).toHaveProperty('enabled', false);
    expect(DEFAULT_LOCAL_AGENT.memory).toHaveProperty('sections');
    expect(DEFAULT_LOCAL_AGENT).toHaveProperty('briefing');
    expect(DEFAULT_LOCAL_AGENT.briefing).toHaveProperty('enabled', false);
    expect(DEFAULT_LOCAL_AGENT.briefing).toHaveProperty('priority', 5);
    expect(DEFAULT_LOCAL_AGENT).toHaveProperty('multiTurn', false);
    expect(DEFAULT_LOCAL_AGENT).toHaveProperty('executionType', 'llm');
  });

  it('AGENT_SCHEMA_VERSION is 2', () => {
    expect(AGENT_SCHEMA_VERSION).toBe(2);
  });

  it('_migrateAgent fills missing v2 fields on a v1 agent', () => {
    const store = new AgentStore();
    const v1Agent = {
      id: 'test-id',
      type: 'local',
      name: 'Old Agent',
      version: 1,
      enabled: true,
      keywords: ['test'],
      categories: ['general'],
      prompt: 'You are a test agent.',
      settings: { confidenceThreshold: 0.8 },
    };

    const migrated = store._migrateAgent(v1Agent);

    // Original fields preserved
    expect(migrated.id).toBe('test-id');
    expect(migrated.name).toBe('Old Agent');
    expect(migrated.keywords).toEqual(['test']);
    expect(migrated.settings.confidenceThreshold).toBe(0.8); // preserved, not overwritten

    // v2 fields filled from defaults
    expect(migrated.schemaVersion).toBe(AGENT_SCHEMA_VERSION);
    expect(migrated.voice).toBeNull();
    expect(migrated.acks).toEqual([]);
    expect(migrated.estimatedExecutionMs).toBe(5000);
    expect(migrated.memory.enabled).toBe(false);
    expect(migrated.briefing.enabled).toBe(false);
    expect(migrated.multiTurn).toBe(false);
    expect(migrated.executionType).toBe('llm');
  });

  it('_migrateAgent is idempotent for v2 agents', () => {
    const store = new AgentStore();
    const v2Agent = {
      ...DEFAULT_LOCAL_AGENT,
      id: 'v2-agent',
      name: 'V2 Agent',
      schemaVersion: AGENT_SCHEMA_VERSION,
      voice: 'verse',
    };

    const result = store._migrateAgent(v2Agent);
    // Should return the same object reference (no migration needed)
    expect(result).toBe(v2Agent);
  });

  it('_migrateAgent deep-merges nested objects', () => {
    const store = new AgentStore();
    const partial = {
      id: 'partial',
      name: 'Partial',
      keywords: ['x'],
      prompt: 'test',
      memory: { enabled: true },
      // briefing missing entirely
      settings: { maxConcurrent: 10 },
    };

    const migrated = store._migrateAgent(partial);

    // memory.enabled preserved, sections filled from default
    expect(migrated.memory.enabled).toBe(true);
    expect(migrated.memory.sections).toEqual(['Learned Preferences']);

    // briefing filled entirely from defaults
    expect(migrated.briefing.enabled).toBe(false);
    expect(migrated.briefing.priority).toBe(5);

    // settings deep-merged
    expect(migrated.settings.maxConcurrent).toBe(10);
    expect(migrated.settings.confidenceThreshold).toBe(0.7); // from default
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Agent Generator - v2 Output
// ═══════════════════════════════════════════════════════════════════════════════

describe('Agent Generator', () => {
  let validateAgentConfig, getAvailableVoices, VOICE_MAP;

  beforeEach(() => {
    const mod = require('../../lib/ai-agent-generator');
    validateAgentConfig = mod.validateAgentConfig;
    getAvailableVoices = mod.getAvailableVoices;
    VOICE_MAP = mod.VOICE_MAP;
  });

  describe('validateAgentConfig', () => {
    it('validates a correct v2 config', () => {
      const config = {
        name: 'Test Agent',
        keywords: ['test', 'demo'],
        prompt: 'You are a test agent that helps with testing.',
        voice: 'alloy',
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects missing name', () => {
      const config = { keywords: ['x'], prompt: 'A prompt that is long enough to pass.' };
      const result = validateAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Agent name is required');
    });

    it('rejects empty keywords', () => {
      const config = { name: 'Test', keywords: [], prompt: 'A prompt that is long enough to pass.' };
      const result = validateAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('At least one keyword is required');
    });

    it('rejects short prompt', () => {
      const config = { name: 'Test', keywords: ['x'], prompt: 'Too short' };
      const result = validateAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('prompt'))).toBe(true);
    });

    it('rejects invalid voice', () => {
      const config = {
        name: 'Test',
        keywords: ['x'],
        prompt: 'A prompt that is long enough to pass.',
        voice: 'nonexistent-voice',
      };
      const result = validateAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Unknown voice'))).toBe(true);
    });

    it('rejects briefing without section', () => {
      const config = {
        name: 'Test',
        keywords: ['x'],
        prompt: 'A prompt that is long enough to pass.',
        briefing: { enabled: true, section: '' },
      };
      const result = validateAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Briefing section'))).toBe(true);
    });
  });

  describe('getAvailableVoices', () => {
    it('returns all 8 voices', () => {
      const voices = getAvailableVoices();
      expect(Object.keys(voices)).toHaveLength(8);
      expect(voices).toHaveProperty('alloy');
      expect(voices).toHaveProperty('verse');
      expect(voices).toHaveProperty('coral');
      expect(voices).toHaveProperty('echo');
      expect(voices).toHaveProperty('sage');
      expect(voices).toHaveProperty('ash');
      expect(voices).toHaveProperty('ballad');
      expect(voices).toHaveProperty('shimmer');
    });

    it('returns a new copy each time', () => {
      const a = getAvailableVoices();
      const b = getAvailableVoices();
      expect(a).not.toBe(b); // different references
      expect(a).toEqual(b); // same content
    });
  });

  describe('VOICE_MAP', () => {
    it('has descriptions for every voice', () => {
      for (const [name, desc] of Object.entries(VOICE_MAP)) {
        expect(typeof name).toBe('string');
        expect(typeof desc).toBe('string');
        expect(desc.length).toBeGreaterThan(10);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Agent Templates - buildAgentPrompt
// ═══════════════════════════════════════════════════════════════════════════════

describe('Agent Templates', () => {
  let matchTemplate, buildAgentPrompt, getTemplates;

  beforeEach(() => {
    const mod = require('../../lib/agent-templates');
    matchTemplate = mod.matchTemplate;
    buildAgentPrompt = mod.buildAgentPrompt;
    getTemplates = mod.getTemplates;
  });

  it('matchTemplate returns conversational by default', () => {
    const result = matchTemplate('do something general');
    expect(result.id).toBe('conversational');
  });

  it('matchTemplate picks terminal for shell-related descriptions', () => {
    const result = matchTemplate('run terminal commands and execute bash scripts');
    expect(result.id).toBe('terminal');
  });

  it('matchTemplate picks applescript for macOS automation', () => {
    const result = matchTemplate('control macOS apps with AppleScript automation');
    expect(result.id).toBe('applescript');
  });

  it('buildAgentPrompt returns template and systemPrompt', () => {
    const result = buildAgentPrompt('a weather helper agent');
    expect(result).toHaveProperty('template');
    expect(result).toHaveProperty('systemPrompt');
    expect(typeof result.systemPrompt).toBe('string');
    expect(result.systemPrompt.length).toBeGreaterThan(50);
  });

  it('getTemplates returns all 7 templates', () => {
    const templates = getTemplates();
    expect(templates.length).toBe(7);
    const ids = templates.map((t) => t.id);
    expect(ids).toContain('terminal');
    expect(ids).toContain('applescript');
    expect(ids).toContain('nodejs');
    expect(ids).toContain('conversational');
    expect(ids).toContain('automation');
    expect(ids).toContain('browser');
    expect(ids).toContain('system');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Agent Auto-Tester - v2 Functions
// ═══════════════════════════════════════════════════════════════════════════════

describe('Agent Auto-Tester v2', () => {
  let generateTestScenarios, quickValidate;
  let ai;
  let _originalChat;

  beforeEach(() => {
    // Patch ai.chat on the Proxy (set trap stores on _namedExports, get checks it first)
    ai = require('../../lib/ai-service');
    _originalChat = ai.chat; // save original for teardown
    ai.chat = vi.fn(async () => ({ content: '' }));

    const mod = require('../../lib/agent-auto-tester');
    generateTestScenarios = mod.generateTestScenarios;
    quickValidate = mod.quickValidate;
  });

  afterEach(() => {
    // Restore original chat so other test suites aren't affected
    if (ai && _originalChat) {
      ai.chat = _originalChat;
    }
  });

  describe('generateTestScenarios', () => {
    it('returns fallback scenarios when AI fails', async () => {
      // AI mock returns invalid JSON -> fallback path
      ai.chat.mockResolvedValueOnce({ content: 'not valid json' });

      const agent = {
        name: 'Test Agent',
        executionType: 'llm',
        keywords: ['test', 'demo', 'example'],
        categories: ['general'],
        prompt: 'You are a test agent.',
      };

      const scenarios = await generateTestScenarios(agent);
      expect(scenarios).toHaveProperty('positive');
      expect(scenarios).toHaveProperty('negative');
      expect(Array.isArray(scenarios.positive)).toBe(true);
      expect(Array.isArray(scenarios.negative)).toBe(true);
      // Fallback generates from keywords
      expect(scenarios.positive.length).toBeGreaterThan(0);
      expect(scenarios.negative.length).toBeGreaterThan(0);
    });

    it('parses valid AI response into scenarios', async () => {
      ai.chat.mockResolvedValueOnce({
        content: JSON.stringify({
          positive: ['Do a test', 'Show me a demo', 'Run an example'],
          negative: ['What time is it?', "What's the weather?"],
        }),
      });

      const agent = {
        name: 'Test Agent',
        keywords: ['test'],
        prompt: 'test',
      };

      const scenarios = await generateTestScenarios(agent);
      expect(scenarios.positive).toEqual(['Do a test', 'Show me a demo', 'Run an example']);
      expect(scenarios.negative).toEqual(['What time is it?', "What's the weather?"]);
    });

    it('caps positive at 5 and negative at 3', async () => {
      ai.chat.mockResolvedValueOnce({
        content: JSON.stringify({
          positive: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
          negative: ['x', 'y', 'z', 'w'],
        }),
      });

      const scenarios = await generateTestScenarios({ name: 'T', keywords: ['t'], prompt: 't' });
      expect(scenarios.positive.length).toBeLessThanOrEqual(5);
      expect(scenarios.negative.length).toBeLessThanOrEqual(3);
    });
  });

  describe('quickValidate', () => {
    it('returns passed:true for non-empty response', async () => {
      ai.chat.mockResolvedValueOnce({ content: 'Here is the answer to your question.' });

      const result = await quickValidate(
        { id: 'test', name: 'Test', prompt: 'You are helpful.' },
        'Help me with something'
      );

      expect(result.passed).toBe(true);
      expect(result.response).toContain('Here is the answer');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('returns passed:false for empty response', async () => {
      ai.chat.mockResolvedValueOnce({ content: '' });

      const result = await quickValidate({ id: 'test', name: 'Test', prompt: 'You are helpful.' }, 'Help me');

      expect(result.passed).toBe(false);
    });

    it('returns passed:false on error', async () => {
      ai.chat.mockRejectedValueOnce(new Error('API timeout'));

      const result = await quickValidate({ id: 'test', name: 'Test', prompt: 'test' }, 'test prompt');

      expect(result.passed).toBe(false);
      expect(result.response).toContain('API timeout');
    });

    it('truncates long responses to 500 chars', async () => {
      ai.chat.mockResolvedValueOnce({ content: 'x'.repeat(1000) });

      const result = await quickValidate({ id: 'test', name: 'Test', prompt: 'test' }, 'test');

      expect(result.response.length).toBeLessThanOrEqual(500);
    });
  });
});
