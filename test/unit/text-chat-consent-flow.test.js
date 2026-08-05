/**
 * TEXT-CHAT FLOW HARNESS -- level 1 of the user's testing directive:
 * "auto test this by making sure it works using text chat; voice just
 * transcribes into the same pipeline."
 *
 * Since the single-path refactor, voice IS text: the mic transcribes into
 * the same submitTask() pipeline the chat box uses. So conversational flows
 * are tested here at the submitTask boundary -- if a flow works here, voice
 * adds only transcription on top.
 *
 * Regression captured from the 2026-08-05 live failure:
 *   "Set a timer for 4:09" -> capability gap -> builder asks "Want me to
 *   draft a build plan?" -> pending input registered -> user says "Yes." ->
 *   submitTask ran the mic-noise filter -> 'filler or fragment' -> consent
 *   NEVER reached routePendingInput. Dead end.
 *
 * The contract now pinned: WHEN AN AGENT IS AWAITING INPUT, short answers
 * are meaningful and MUST pass through to the exchange. When nothing is
 * pending, the fragment filter still protects against stray mic noise.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) },
}), { virtual: true });

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../lib/agent-space-registry', () => ({
  getAgentSpaceRegistry: vi.fn().mockReturnValue({
    initialize: vi.fn().mockResolvedValue(undefined),
    getDefaultSpaceForTool: vi.fn().mockResolvedValue(null),
    getSpaces: vi.fn().mockReturnValue([]),
    getAgentsInSpace: vi.fn().mockReturnValue([]),
  }),
}));

vi.mock('../../lib/ai-service', () => ({
  default: { json: vi.fn().mockResolvedValue({ genuine: true }) },
  json: vi.fn().mockResolvedValue({ genuine: true }),
}));

// The REAL exchange event bus and REAL transcript service are used: the bus
// carries the submit to a spy bridge (exactly how the app wires it), and the
// transcript service holds the real pending-input state the filter consults.
const exchangeBus = require('../../lib/exchange/event-bus');
const { getTranscriptService } = require('../../lib/transcript-service');

const hudApi = require('../../lib/hud-api');

let processSubmit;

beforeEach(() => {
  processSubmit = vi.fn(async (text) => ({
    taskId: 't1',
    queued: true,
    transcript: text,
  }));
  exchangeBus.registerBridge({
    processSubmit,
    getExchange: () => null,
    cancelTask: () => {},
    getQueueStats: () => ({}),
  });
});

afterEach(() => {
  const ts = getTranscriptService();
  for (const agentId of ts.getPendingAgentIds()) ts.clearPending(agentId);
});

describe('consent replies while an agent is awaiting input', () => {
  beforeEach(() => {
    // The builder just asked "Want me to draft a build plan?" -- exactly the
    // state from the live failure.
    getTranscriptService().setPending('agent-builder-agent', {
      taskId: 'task-1',
      agentId: 'agent-builder-agent',
      context: { pendingBuild: { originalRequest: 'timer agent', buildMethod: 'claude-code' } },
    });
  });

  for (const answer of ['Yes.', 'yes', 'No', 'okay', 'yeah', 'playbook']) {
    it(`"${answer}" reaches the exchange instead of dying in the mic filter`, async () => {
      const result = await hudApi.submitTask(answer, { toolId: 'orb' });
      expect(processSubmit).toHaveBeenCalledTimes(1);
      expect(processSubmit.mock.calls[0][0]).toBe(answer.trim());
      expect(result.needsClarification).not.toBe(true);
    });
  }

  it('normal sentences still pass too', async () => {
    await hudApi.submitTask('actually make it a five minute timer', { toolId: 'orb' });
    expect(processSubmit).toHaveBeenCalledTimes(1);
  });
});

describe('stray fragments with NO pending agent question', () => {
  it('"Yes." with nothing pending is still filtered (mic-noise protection intact)', async () => {
    expect(getTranscriptService().hasPending()).toBe(false);
    const result = await hudApi.submitTask('Yes.', { toolId: 'orb' });
    expect(processSubmit).not.toHaveBeenCalled();
    expect(result.needsClarification).toBe(true);
    expect(result.filterReason).toBe('filler or fragment');
  });

  it('real requests pass without pending state', async () => {
    await hudApi.submitTask('set a timer for 4 minutes', { toolId: 'orb' });
    expect(processSubmit).toHaveBeenCalledTimes(1);
  });

  it('text-chat input with skipFilter passes fragments (chat box types are deliberate)', async () => {
    const result = await hudApi.submitTask('Yes.', { toolId: 'chat', skipFilter: true });
    expect(processSubmit).toHaveBeenCalledTimes(1);
    expect(result.needsClarification).not.toBe(true);
  });
});
