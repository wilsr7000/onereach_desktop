/**
 * mcp-bridge-agent -- execute() + dynamic prompt
 *
 * Verifies that the agent:
 *   - Builds a bidder prompt from the registered MCP tool list.
 *   - Asks the fast model to pick a tool, then calls it via the MCP client.
 *   - Abstains when the model says abstain or confidence is low.
 *   - Surfaces unknown-server / tool-error gracefully.
 *   - Returns a no-config message when nothing is registered.
 *
 * Uses the agent's __setDeps() test seam to inject stub settings and client
 * factories. This is more reliable than vi.mock for lazy/inline requires.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const aiJsonMock = vi.fn();
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

const agent = require('../../packages/agents/mcp-bridge-agent');

/**
 * Build a stub createClient that returns clients backed by the given
 * map (url -> { tools: [{ name, description, response | handler }] }).
 */
function makeClientFactory(byUrl) {
  return (config) => {
    const fixture = byUrl.get(config.url) || {};
    return {
      label: config.label || config.url,
      listTools: vi.fn().mockResolvedValue(fixture.tools || []),
      callTool: vi.fn(async (name, args) => {
        const tool = (fixture.tools || []).find((t) => t.name === name);
        if (!tool) throw new Error(`Unknown tool: ${name}`);
        if (typeof tool.handler === 'function') return tool.handler(args);
        return tool.response || '';
      }),
    };
  };
}

describe('mcp-bridge-agent -- empty config', () => {
  beforeEach(() => {
    aiJsonMock.mockReset();
    agent.__setDeps({
      loadServers: () => [],
      createClient: makeClientFactory(new Map()),
      aiJson: (...args) => aiJsonMock(...args),
    });
    agent._clients = [];
    agent._toolIndex = [];
    agent.memory = null;
    agent.prompt = '';
  });

  it('returns no-config message when nothing is registered', async () => {
    await agent.initialize();
    const result = await agent.execute({ content: 'do something' });
    expect(result.success).toBe(false);
    expect(result.message.toLowerCase()).toContain('mcp');
  });

  it('prompt is the empty skeleton (telling the bidder to stand down)', async () => {
    await agent.initialize();
    expect(agent.prompt.toLowerCase()).toContain('no mcp servers');
    expect(agent.prompt.toLowerCase()).toContain('do not win');
  });
});

describe('mcp-bridge-agent -- with one server', () => {
  let byUrl;

  beforeEach(() => {
    aiJsonMock.mockReset();
    byUrl = new Map();
    byUrl.set('http://s1', {
      tools: [
        { name: 'echo', description: 'Echo back a message', response: 'echoed' },
        { name: 'now', description: 'Get the current timestamp', response: '2026-05-11T15:00:00Z' },
      ],
    });
    agent.__setDeps({
      loadServers: () => [{ id: 's1', label: 'ServerOne', url: 'http://s1', enabled: true }],
      createClient: makeClientFactory(byUrl),
      aiJson: (...args) => aiJsonMock(...args),
    });
    agent._clients = [];
    agent._toolIndex = [];
    agent.memory = null;
    agent.prompt = '';
  });

  it('builds a prompt that lists the available tools', async () => {
    await agent.initialize();
    expect(agent.prompt).toContain('ServerOne.echo');
    expect(agent.prompt).toContain('ServerOne.now');
    expect(agent.prompt).toContain('Echo back a message');
  });

  it('execute picks a tool and returns its result', async () => {
    aiJsonMock.mockResolvedValueOnce({
      server: 'ServerOne',
      tool: 'echo',
      args: { text: 'hi' },
      confidence: 0.9,
    });
    await agent.initialize();
    const result = await agent.execute({ content: 'echo hi back to me' });
    expect(result.success).toBe(true);
    expect(result.message).toBe('echoed');
  });

  it('abstains when the picker returns { abstain: true }', async () => {
    aiJsonMock.mockResolvedValueOnce({ abstain: true, reason: 'no match' });
    await agent.initialize();
    const result = await agent.execute({ content: 'what time is it' });
    expect(result.success).toBe(false);
    expect(result.message).toBe('no match');
  });

  it('abstains when confidence is below the threshold', async () => {
    aiJsonMock.mockResolvedValueOnce({
      server: 'ServerOne',
      tool: 'echo',
      args: {},
      confidence: 0.3,
    });
    await agent.initialize();
    const result = await agent.execute({ content: 'borderline request' });
    expect(result.success).toBe(false);
    expect(result.message.toLowerCase()).toContain('not confident');
  });

  it('reports unknown-server gracefully', async () => {
    aiJsonMock.mockResolvedValueOnce({
      server: 'GhostServer',
      tool: 'echo',
      args: {},
      confidence: 0.9,
    });
    await agent.initialize();
    const result = await agent.execute({ content: 'do something' });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Unknown MCP server/);
  });

  it('surfaces tool errors as { success: false }', async () => {
    aiJsonMock.mockResolvedValueOnce({
      server: 'ServerOne',
      tool: 'echo',
      args: {},
      confidence: 0.9,
    });
    byUrl.set('http://s1', {
      tools: [
        {
          name: 'echo',
          description: 'echo',
          handler: () => {
            throw new Error('tool blew up');
          },
        },
      ],
    });
    await agent.initialize();
    const result = await agent.execute({ content: 'echo' });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/blew up/);
  });
});

describe('mcp-bridge-agent -- multiple servers', () => {
  beforeEach(() => {
    aiJsonMock.mockReset();
    const byUrl = new Map();
    byUrl.set('http://a', { tools: [{ name: 'a_tool', description: 'a' }] });
    byUrl.set('http://b', { tools: [{ name: 'b_tool', description: 'b', response: 'from B' }] });
    agent.__setDeps({
      loadServers: () => [
        { id: 's1', label: 'A', url: 'http://a', enabled: true },
        { id: 's2', label: 'B', url: 'http://b', enabled: true },
        { id: 's3', label: 'Disabled', url: 'http://c', enabled: false },
      ],
      createClient: makeClientFactory(byUrl),
      aiJson: (...args) => aiJsonMock(...args),
    });
    agent._clients = [];
    agent._toolIndex = [];
    agent.memory = null;
    agent.prompt = '';
  });

  it('skips disabled servers and aggregates tools from enabled ones', async () => {
    await agent.initialize();
    expect(agent._clients).toHaveLength(2);
    expect(agent.prompt).toContain('A.a_tool');
    expect(agent.prompt).toContain('B.b_tool');
    expect(agent.prompt).not.toContain('Disabled');
  });

  it('routes by server label from the picker', async () => {
    aiJsonMock.mockResolvedValueOnce({
      server: 'B',
      tool: 'b_tool',
      args: {},
      confidence: 0.95,
    });
    await agent.initialize();
    const result = await agent.execute({ content: 'do b things' });
    expect(result.success).toBe(true);
    expect(result.message).toBe('from B');
  });
});

describe('mcp-bridge-agent -- reload()', () => {
  it('re-reads settings on reload and rebuilds the prompt', async () => {
    aiJsonMock.mockReset();
    let serversValue = [{ id: 's1', label: 'V1', url: 'http://v1', enabled: true }];
    const byUrl = new Map();
    byUrl.set('http://v1', { tools: [{ name: 'a', description: 'orig' }] });
    byUrl.set('http://v2', { tools: [{ name: 'b', description: 'newer' }] });

    agent.__setDeps({
      loadServers: () => serversValue,
      createClient: makeClientFactory(byUrl),
      aiJson: (...args) => aiJsonMock(...args),
    });
    agent._clients = [];
    agent._toolIndex = [];
    agent.memory = null;
    agent.prompt = '';

    await agent.initialize();
    expect(agent.prompt).toContain('V1.a');

    serversValue = [{ id: 's2', label: 'V2', url: 'http://v2', enabled: true }];
    await agent.reload();
    expect(agent.prompt).toContain('V2.b');
    expect(agent.prompt).not.toContain('V1.a');
  });
});
