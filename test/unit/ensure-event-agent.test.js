/**
 * Unit tests for lib/events/ensure-event-agent.js -- idempotent seeding of
 * the playbook-backed Event Manager local agent (the self-heal test target).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  ensureEventManagerAgent,
  buildEventAgentConfig,
  EVENT_AGENT_NAME,
  EVENT_AGENT_TOOLS,
} from '../../lib/events/ensure-event-agent.js';
import { LOCAL_AGENT_TEMPLATE_SECTIONS } from '../../lib/agent-playbook.js';

function makePlaybookLib() {
  return {
    composeLocalAgentPlaybook: vi.fn(({ config }) => ({
      markdown: `# Local Agent Playbook: ${config.name}\n(spec)`,
      title: `Local Agent Playbook: ${config.name}`,
      agentName: config.name,
    })),
    saveAgentPlaybook: vi.fn(() => ({ saved: true, ref: { itemId: 'pb-1', spaceId: 'agent-playbooks' } })),
  };
}

function makeStore(agents = []) {
  return {
    init: vi.fn(),
    getLocalAgents: vi.fn(() => agents),
    createAgent: vi.fn(async (cfg) => ({ ...cfg, id: 'agent-new' })),
    updateAgent: vi.fn(async (id, updates) => ({ id, ...updates })),
  };
}

let playbookLib;

beforeEach(() => {
  playbookLib = makePlaybookLib();
});

describe('buildEventAgentConfig', () => {
  it('binds the events tools, llm execution, and trigger keywords', () => {
    const config = buildEventAgentConfig();
    expect(config.name).toBe(EVENT_AGENT_NAME);
    expect(config.executionType).toBe('llm');
    expect(config.tools).toEqual([...EVENT_AGENT_TOOLS]);
    expect(config.keywords).toContain('appointments');
    expect(config.keywords).toContain("what's next");
    expect(config.enabled).toBe(true);
    // The prompt encodes the app-popping and recurrence contracts
    expect(config.prompt).toMatch(/events_open_app/);
    expect(config.prompt).toMatch(/recurrence \(none\|daily\|weekly\|monthly\)/);
    expect(config.prompt).toMatch(/get_current_time/);
  });
});

describe('ensureEventManagerAgent', () => {
  it('creates the agent with a composed+saved playbook when missing', async () => {
    const store = makeStore([]);
    const out = await ensureEventManagerAgent({ getStore: () => store, playbookLib });

    expect(out.status).toBe('created');
    expect(store.createAgent).toHaveBeenCalledTimes(1);
    const created = store.createAgent.mock.calls[0][0];
    expect(created.name).toBe(EVENT_AGENT_NAME);
    expect(created.tools).toEqual([...EVENT_AGENT_TOOLS]);
    expect(created.playbook.markdown).toContain('Local Agent Playbook: Event Manager');
    expect(created.playbook.ref).toEqual({ itemId: 'pb-1', spaceId: 'agent-playbooks' });
    expect(playbookLib.saveAgentPlaybook).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the agent already exists with playbook + tools', async () => {
    const store = makeStore([
      { id: 'a1', name: 'event manager', tools: [...EVENT_AGENT_TOOLS], playbook: { markdown: '# spec' } },
    ]);
    const out = await ensureEventManagerAgent({ getStore: () => store, playbookLib });
    expect(out.status).toBe('exists');
    expect(store.createAgent).not.toHaveBeenCalled();
    expect(store.updateAgent).not.toHaveBeenCalled();
  });

  it('patches an existing agent that predates the playbook', async () => {
    const store = makeStore([
      { id: 'a1', name: EVENT_AGENT_NAME, tools: [...EVENT_AGENT_TOOLS] }, // no playbook
    ]);
    const out = await ensureEventManagerAgent({ getStore: () => store, playbookLib });
    expect(out.status).toBe('patched');
    const [id, updates] = store.updateAgent.mock.calls[0];
    expect(id).toBe('a1');
    expect(updates.playbook.markdown).toContain('Event Manager');
    expect(updates.tools).toBeUndefined();
  });

  it('patches missing tool bindings', async () => {
    const store = makeStore([
      { id: 'a1', name: EVENT_AGENT_NAME, tools: ['events_add'], playbook: { markdown: '# spec' } },
    ]);
    const out = await ensureEventManagerAgent({ getStore: () => store, playbookLib });
    expect(out.status).toBe('patched');
    const [, updates] = store.updateAgent.mock.calls[0];
    expect(updates.tools).toEqual([...EVENT_AGENT_TOOLS]);
    expect(updates.playbook).toBeUndefined();
  });

  it('reports unavailable without throwing when the store is missing', async () => {
    const out = await ensureEventManagerAgent({ getStore: () => null, playbookLib });
    expect(out.status).toBe('unavailable');
  });

  it('never throws on store errors', async () => {
    const store = makeStore([]);
    store.createAgent.mockRejectedValue(new Error('disk full'));
    const out = await ensureEventManagerAgent({ getStore: () => store, playbookLib });
    expect(out.status).toBe('error');
  });

  it('the REAL template composes a full playbook for this agent (integration of the two modules)', async () => {
    const realPlaybookLib = {
      ...(await import('../../lib/agent-playbook.js')),
      // keep compose real, stub only the Spaces side effect
      saveAgentPlaybook: vi.fn(() => ({ saved: true, ref: null })),
    };
    const store = makeStore([]);
    await ensureEventManagerAgent({ getStore: () => store, playbookLib: realPlaybookLib });
    const created = store.createAgent.mock.calls[0][0];
    for (const section of LOCAL_AGENT_TEMPLATE_SECTIONS) {
      expect(created.playbook.markdown).toContain(`## ${section}`);
    }
    expect(created.playbook.markdown).toContain('events_open_app');
  });
});
