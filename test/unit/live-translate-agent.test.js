/**
 * live-translate-agent -- execute()
 *
 * Covers:
 *   - "start" intent calls service.start with the right languages.
 *   - "stop" intent calls service.stop.
 *   - "switch" intent stops then starts to update target language.
 *   - "status" returns the current session state.
 *   - Missing targetLang on a start asks for it (success:false).
 *   - Unknown actions return a polite failure.
 *   - Service errors surface as success:false.
 *   - Bidder prompt mentions HIGH / LOW confidence patterns.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const memoryStub = {
  load: vi.fn().mockResolvedValue(undefined),
  getSectionNames: () => [],
  updateSection: vi.fn(),
  isDirty: () => false,
  save: vi.fn(),
};

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('../../lib/agent-memory-store', () => ({
  getAgentMemory: () => memoryStub,
}));

const agent = require('../../packages/agents/live-translate-agent');

function makeServiceStub({ active = false, sourceLang = null, targetLang = null } = {}) {
  return {
    _state: { active, sourceLang, targetLang },
    isActive() {
      return this._state.active;
    },
    getStatus() {
      return {
        active: this._state.active,
        sourceLang: this._state.sourceLang,
        targetLang: this._state.targetLang,
        subscriberCount: 0,
      };
    },
    start: vi.fn(async function start({ sourceLang, targetLang }) {
      this._state.active = true;
      this._state.sourceLang = sourceLang;
      this._state.targetLang = targetLang;
      return { success: true, message: 'started' };
    }),
    stop: vi.fn(function stop() {
      this._state.active = false;
    }),
  };
}

describe('live-translate-agent -- bidder prompt', () => {
  it('lists HIGH-confidence translation phrases', () => {
    expect(agent.prompt).toMatch(/HIGH confidence/i);
    expect(agent.prompt.toLowerCase()).toContain('translate');
    expect(agent.prompt.toLowerCase()).toContain('stop translating');
  });

  it('lists LOW-confidence non-session phrases', () => {
    expect(agent.prompt).toMatch(/LOW confidence/i);
    expect(agent.prompt.toLowerCase()).toContain('how do you say');
  });
});

describe('live-translate-agent.execute() -- start intent', () => {
  let aiJsonMock;
  let service;

  beforeEach(() => {
    aiJsonMock = vi.fn();
    service = makeServiceStub();
    agent.memory = null;
    agent.__setDeps({ aiJson: aiJsonMock, service: () => service });
  });

  it('calls service.start with the picked target language', async () => {
    aiJsonMock.mockResolvedValueOnce({
      action: 'start',
      sourceLang: 'auto',
      targetLang: 'es',
    });
    const result = await agent.execute({ content: 'translate to Spanish' });
    expect(service.start).toHaveBeenCalledWith({ sourceLang: 'auto', targetLang: 'es' });
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/es/);
  });

  it('passes through explicit sourceLang', async () => {
    aiJsonMock.mockResolvedValueOnce({
      action: 'start',
      sourceLang: 'fr',
      targetLang: 'en',
    });
    await agent.execute({ content: 'translate French to English' });
    expect(service.start).toHaveBeenCalledWith({ sourceLang: 'fr', targetLang: 'en' });
  });

  it('asks for target language when missing', async () => {
    aiJsonMock.mockResolvedValueOnce({
      action: 'start',
      sourceLang: 'auto',
      targetLang: null,
    });
    const result = await agent.execute({ content: 'start translating' });
    expect(result.success).toBe(false);
    expect(result.message.toLowerCase()).toContain('language');
    expect(service.start).not.toHaveBeenCalled();
  });

  it('surfaces service.start failures', async () => {
    aiJsonMock.mockResolvedValueOnce({
      action: 'start',
      sourceLang: 'auto',
      targetLang: 'es',
    });
    service.start.mockResolvedValueOnce({ success: false, message: 'No API key' });
    const result = await agent.execute({ content: 'translate to Spanish' });
    expect(result.success).toBe(false);
    expect(result.message).toBe('No API key');
  });
});

describe('live-translate-agent.execute() -- stop intent', () => {
  let aiJsonMock;
  let service;

  beforeEach(() => {
    aiJsonMock = vi.fn();
    service = makeServiceStub({ active: true, targetLang: 'es' });
    agent.memory = null;
    agent.__setDeps({ aiJson: aiJsonMock, service: () => service });
  });

  it('calls service.stop and returns success', async () => {
    aiJsonMock.mockResolvedValueOnce({ action: 'stop' });
    const result = await agent.execute({ content: 'stop translating' });
    expect(service.stop).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.message.toLowerCase()).toContain('stopped');
  });
});

describe('live-translate-agent.execute() -- switch intent', () => {
  let aiJsonMock;
  let service;

  beforeEach(() => {
    aiJsonMock = vi.fn();
    service = makeServiceStub({ active: true, targetLang: 'es' });
    agent.memory = null;
    agent.__setDeps({ aiJson: aiJsonMock, service: () => service });
  });

  it('stops the existing session then starts with the new target', async () => {
    aiJsonMock.mockResolvedValueOnce({
      action: 'switch',
      sourceLang: 'auto',
      targetLang: 'de',
    });
    const result = await agent.execute({ content: 'switch translation to German' });
    expect(service.stop).toHaveBeenCalledTimes(1);
    expect(service.start).toHaveBeenCalledWith({ sourceLang: 'auto', targetLang: 'de' });
    expect(result.success).toBe(true);
  });
});

describe('live-translate-agent.execute() -- status intent', () => {
  let aiJsonMock;

  beforeEach(() => {
    aiJsonMock = vi.fn();
    agent.memory = null;
  });

  it('reports off when no session is active', async () => {
    agent.__setDeps({
      aiJson: aiJsonMock,
      service: () => makeServiceStub({ active: false }),
    });
    aiJsonMock.mockResolvedValueOnce({ action: 'status' });
    const result = await agent.execute({ content: 'is translation running' });
    expect(result.success).toBe(true);
    expect(result.message.toLowerCase()).toContain('off');
  });

  it('reports the current language pair when active', async () => {
    agent.__setDeps({
      aiJson: aiJsonMock,
      service: () => makeServiceStub({ active: true, sourceLang: 'en', targetLang: 'fr' }),
    });
    aiJsonMock.mockResolvedValueOnce({ action: 'status' });
    const result = await agent.execute({ content: 'translation status' });
    expect(result.success).toBe(true);
    expect(result.message).toContain('en');
    expect(result.message).toContain('fr');
  });
});

describe('live-translate-agent.execute() -- unknown action', () => {
  it('returns polite failure with the classifier reason', async () => {
    const aiJsonMock = vi.fn().mockResolvedValueOnce({
      action: 'unknown',
      reason: 'not clearly a translation request',
    });
    agent.__setDeps({ aiJson: aiJsonMock, service: () => makeServiceStub() });
    agent.memory = null;
    const result = await agent.execute({ content: 'do translation things' });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/translation/i);
  });
});
