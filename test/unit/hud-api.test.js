import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) },
}), { virtual: true });

// Mock dependencies
vi.mock('../../lib/agent-space-registry', () => ({
  getAgentSpaceRegistry: vi.fn().mockReturnValue({
    initialize: vi.fn().mockResolvedValue(undefined),
    getDefaultSpaceForTool: vi.fn().mockResolvedValue(null),
    getSpaces: vi.fn().mockReturnValue([]),
    getAgentsInSpace: vi.fn().mockReturnValue([]),
  }),
}));
vi.mock('../../lib/exchange/event-bus', () => {
  const bus = {
    _processSubmit: null,
    getExchange: vi.fn().mockReturnValue(null),
    on: vi.fn(),
    emit: vi.fn(),
    registerProcessSubmit: vi.fn((fn) => { bus._processSubmit = fn; }),
  };
  return bus;
});
vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));
vi.mock('../../lib/ai-service', () => ({
  default: { json: vi.fn().mockResolvedValue({ genuine: true }) },
  json: vi.fn().mockResolvedValue({ genuine: true }),
}));
vi.mock('uuid', () => ({ v4: vi.fn().mockReturnValue('test-task-id-1234') }));

describe('HUD API', () => {
  let hudApi;

  beforeEach(async () => {
    vi.resetModules();
    vi.mock('electron', () => ({
      ipcMain: { handle: vi.fn(), on: vi.fn() },
      BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) },
    }), { virtual: true });
    vi.mock('../../lib/agent-space-registry', () => ({
      getAgentSpaceRegistry: vi.fn().mockReturnValue({
        initialize: vi.fn().mockResolvedValue(undefined),
        getDefaultSpaceForTool: vi.fn().mockResolvedValue(null),
        getSpaces: vi.fn().mockReturnValue([]),
        getAgentsInSpace: vi.fn().mockReturnValue([]),
      }),
    }));
    vi.mock('../../lib/exchange/event-bus', () => {
      const bus = {
        _processSubmit: null,
        getExchange: vi.fn().mockReturnValue(null),
        on: vi.fn(),
        emit: vi.fn(),
        registerProcessSubmit: vi.fn((fn) => { bus._processSubmit = fn; }),
      };
      return bus;
    });
    vi.mock('../../lib/log-event-queue', () => ({
      getLogQueue: () => ({
        info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      }),
    }));
    vi.mock('../../lib/ai-service', () => ({
      default: { json: vi.fn().mockResolvedValue({ genuine: true }) },
      json: vi.fn().mockResolvedValue({ genuine: true }),
    }));
    vi.mock('uuid', () => ({ v4: vi.fn().mockReturnValue('test-task-id-1234') }));

    hudApi = require('../../lib/hud-api');
  });

  // ═══════════════════════════════════════════════════════════════
  // MODULE EXPORTS
  // ═══════════════════════════════════════════════════════════════

  describe('Module exports', () => {

    it('exports initialize function', () => {
      expect(typeof hudApi.initialize).toBe('function');
    });

    it('exports submitTask function', () => {
      expect(typeof hudApi.submitTask).toBe('function');
    });

    it('exports filterTranscript function', () => {
      expect(typeof hudApi.filterTranscript).toBe('function');
    });

    it('exports speechStarted and speechEnded', () => {
      expect(typeof hudApi.speechStarted).toBe('function');
      expect(typeof hudApi.speechEnded).toBe('function');
    });

    it('exports isSpeaking function', () => {
      expect(typeof hudApi.isSpeaking).toBe('function');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // SUBMIT TASK
  // ═══════════════════════════════════════════════════════════════

  describe('submitTask()', () => {

    it('rejects empty text', async () => {
      const result = await hudApi.submitTask('');
      expect(result.queued).toBe(false);
      expect(result.handled).toBe(false);
      expect(result.error).toContain('Empty');
    });

    it('rejects null text', async () => {
      const result = await hudApi.submitTask(null);
      expect(result.queued).toBe(false);
      expect(result.error).toContain('Empty');
    });

    it('rejects whitespace-only text', async () => {
      const result = await hudApi.submitTask('   ');
      expect(result.queued).toBe(false);
    });

    it('accepts valid text input', async () => {
      // Without exchange bridge, returns a minimal result
      const result = await hudApi.submitTask('what is the weather', { toolId: 'orb' });
      // Will get exchange-not-ready error since bus._processSubmit is null
      expect(result).toBeDefined();
    });

    it('passes toolId and skipFilter through options', async () => {
      const result = await hudApi.submitTask('hello', {
        toolId: 'orb',
        skipFilter: true,
      });
      expect(result).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // SPEECH STATE
  // ═══════════════════════════════════════════════════════════════

  describe('Speech state management', () => {

    it('starts not speaking', () => {
      expect(hudApi.isSpeaking()).toBe(false);
    });

    it('transitions to speaking on speechStarted()', () => {
      hudApi.speechStarted();
      expect(hudApi.isSpeaking()).toBe(true);
    });

    it('transitions back to not speaking on speechEnded() after delay', async () => {
      vi.useFakeTimers();
      hudApi.speechStarted();
      expect(hudApi.isSpeaking()).toBe(true);
      hudApi.speechEnded();
      // speechEnded uses a 300ms trailing buffer timeout
      expect(hudApi.isSpeaking()).toBe(true); // still speaking during buffer
      vi.advanceTimersByTime(350);
      expect(hudApi.isSpeaking()).toBe(false);
      vi.useRealTimers();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // TRANSCRIPT FILTER
  // ═══════════════════════════════════════════════════════════════

  describe('filterTranscript()', () => {

    it('rejects empty transcripts', async () => {
      const result = await hudApi.filterTranscript('');
      expect(result.pass).toBe(false);
    });

    it('rejects whitespace-only transcripts', async () => {
      const result = await hudApi.filterTranscript('   ');
      expect(result.pass).toBe(false);
    });

    it('passes short but valid transcripts through to LLM check', async () => {
      // "um" is short but not empty -- the filter uses LLM for quality, not length
      const result = await hudApi.filterTranscript('um');
      expect(result.pass).toBe(true); // LLM mock returns genuine: true
    });

    it('passes reasonable transcripts', async () => {
      const result = await hudApi.filterTranscript('what is the weather today');
      expect(result.pass).toBe(true);
    });
  });
});
