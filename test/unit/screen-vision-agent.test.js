/**
 * screen-vision-agent -- execute()
 *
 * Verifies:
 *   - Captures the screen via the injected desktopCapturer stub.
 *   - Strips the data: prefix from the source thumbnail before passing to vision.
 *   - Returns { success: true, message } when vision returns text.
 *   - Surfaces capture errors as { success: false } without throwing.
 *   - Surfaces vision-call errors as { success: false } without throwing.
 *   - Has a bidder prompt covering visual-referent intents.
 *
 * Uses the agent's __setDeps test seam so we don't need to mock electron's
 * desktopCapturer module directly.
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

const agent = require('../../packages/agents/screen-vision-agent');

function makeFakeSource(dataUrl) {
  return {
    id: 'screen:0:0',
    name: 'Primary',
    display_id: '1',
    thumbnail: { toDataURL: () => dataUrl },
  };
}

describe('screen-vision-agent -- bidder prompt', () => {
  it('lists visual-referent phrases as HIGH confidence', () => {
    expect(agent.prompt).toMatch(/HIGH confidence/i);
    expect(agent.prompt.toLowerCase()).toContain('what is this error');
    expect(agent.prompt.toLowerCase()).toContain('what is on my screen');
  });

  it('lists non-visual phrases as LOW confidence', () => {
    expect(agent.prompt).toMatch(/LOW confidence/i);
    expect(agent.prompt.toLowerCase()).toContain('what time is it');
    expect(agent.prompt.toLowerCase()).toContain('weather in boston');
  });
});

describe('screen-vision-agent.execute() -- happy path', () => {
  beforeEach(() => {
    agent.memory = null;
    agent.__setDeps({
      captureScreenSource: vi.fn(async () => ({
        source: makeFakeSource('data:image/png;base64,AAAAFAKEBYTESxyz'),
        display: { id: 1 },
      })),
      visionAnswer: vi.fn(async () => 'There is a red button labelled Save.'),
    });
  });

  it('returns { success: true, message } with the vision answer', async () => {
    const result = await agent.execute({ content: 'what is on my screen' });
    expect(result.success).toBe(true);
    expect(result.message).toBe('There is a red button labelled Save.');
  });

  it('strips the data: prefix from the thumbnail before calling vision', async () => {
    await agent.execute({ content: 'read this' });
    const visionMock = agent._deps.visionAnswer;
    expect(visionMock).toHaveBeenCalledTimes(1);
    const [base64Arg, promptArg] = visionMock.mock.calls[0];
    expect(base64Arg).toBe('AAAAFAKEBYTESxyz');
    expect(base64Arg).not.toContain('data:image');
    expect(promptArg).toContain('read this');
  });

  it('includes the user transcript in the vision prompt', async () => {
    await agent.execute({ content: 'summarize this article' });
    const visionMock = agent._deps.visionAnswer;
    const [, prompt] = visionMock.mock.calls[0];
    expect(prompt).toContain('summarize this article');
  });

  it('trims trailing whitespace from the answer', async () => {
    agent.__setDeps({
      captureScreenSource: vi.fn(async () => ({
        source: makeFakeSource('data:image/png;base64,abc'),
        display: { id: 1 },
      })),
      visionAnswer: vi.fn(async () => '  An answer with whitespace  \n'),
    });
    const result = await agent.execute({ content: 'what is this' });
    expect(result.message).toBe('An answer with whitespace');
  });
});

describe('screen-vision-agent.execute() -- error paths', () => {
  beforeEach(() => {
    agent.memory = null;
  });

  it('returns success:false when capture throws (e.g. screen recording perm denied)', async () => {
    agent.__setDeps({
      captureScreenSource: vi.fn(async () => {
        throw new Error('Screen recording not permitted');
      }),
      visionAnswer: vi.fn(),
    });
    const result = await agent.execute({ content: 'what is this' });
    expect(result.success).toBe(false);
    expect(result.message.toLowerCase()).toContain('capture');
    expect(agent._deps.visionAnswer).not.toHaveBeenCalled();
  });

  it('returns success:false when the thumbnail is empty', async () => {
    agent.__setDeps({
      captureScreenSource: vi.fn(async () => ({
        source: { thumbnail: { toDataURL: () => '' } },
        display: { id: 1 },
      })),
      visionAnswer: vi.fn(),
    });
    const result = await agent.execute({ content: 'what is this' });
    expect(result.success).toBe(false);
    expect(result.message.toLowerCase()).toContain('empty');
    expect(agent._deps.visionAnswer).not.toHaveBeenCalled();
  });

  it('returns success:false when vision throws', async () => {
    agent.__setDeps({
      captureScreenSource: vi.fn(async () => ({
        source: makeFakeSource('data:image/png;base64,abc'),
        display: { id: 1 },
      })),
      visionAnswer: vi.fn(async () => {
        throw new Error('budget exceeded');
      }),
    });
    const result = await agent.execute({ content: 'what is this' });
    expect(result.success).toBe(false);
    expect(result.message.toLowerCase()).toContain('vision');
  });

  it('returns success:false when vision returns empty', async () => {
    agent.__setDeps({
      captureScreenSource: vi.fn(async () => ({
        source: makeFakeSource('data:image/png;base64,abc'),
        display: { id: 1 },
      })),
      visionAnswer: vi.fn(async () => ''),
    });
    const result = await agent.execute({ content: 'what is this' });
    expect(result.success).toBe(false);
  });
});
