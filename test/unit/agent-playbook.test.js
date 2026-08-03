/**
 * Unit tests for lib/agent-playbook.js -- the LOCAL AGENT TEMPLATE and its
 * lifecycle (compose -> save to Spaces -> open in WISER Playbooks).
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  LOCAL_AGENT_TEMPLATE_SECTIONS,
  AGENT_PLAYBOOKS_SPACE_ID,
  composeLocalAgentPlaybook,
  saveAgentPlaybook,
  openPlaybookInWiser,
} from '../../lib/agent-playbook.js';

describe('composeLocalAgentPlaybook', () => {
  it('emits every section of the local-agent template, in order', () => {
    const { markdown } = composeLocalAgentPlaybook({ request: 'tell me a joke' });
    let lastIdx = -1;
    for (const section of LOCAL_AGENT_TEMPLATE_SECTIONS) {
      const idx = markdown.indexOf(`## ${section}`);
      expect(idx, `section "${section}" must exist`).toBeGreaterThan(-1);
      expect(idx, `section "${section}" must come after the previous one`).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  it('embeds the request, plan fields, and suggested name', () => {
    const { markdown, title, agentName } = composeLocalAgentPlaybook({
      request: 'manage my appointments',
      plan: {
        understanding: 'User wants an events agent',
        features: ['open the app', 'add events', 'answer whats next'],
        approach: 'LLM with events tools',
        suggestedName: 'Event Manager',
      },
      assessment: { requiredIntegrations: ['graph store'] },
    });
    expect(agentName).toBe('Event Manager');
    expect(title).toContain('Event Manager');
    expect(markdown).toContain('manage my appointments');
    expect(markdown).toContain('User wants an events agent');
    expect(markdown).toContain('1. open the app');
    expect(markdown).toContain('LLM with events tools');
    expect(markdown).toContain('graph store');
  });

  it('embeds a known config (keywords, tools, prompt) when pre-decided', () => {
    const { markdown } = composeLocalAgentPlaybook({
      request: 'x',
      config: {
        name: 'Event Manager',
        keywords: ['appointments', "what's next"],
        tools: ['events_add', 'events_next'],
        prompt: 'You are Event Manager.',
      },
    });
    expect(markdown).toContain('- "appointments"');
    expect(markdown).toContain('events_add, events_next');
    expect(markdown).toContain('You are Event Manager.');
  });

  it('never throws on empty input', () => {
    const out = composeLocalAgentPlaybook();
    expect(out.markdown).toContain('# Local Agent Playbook');
    expect(out.agentName).toBe('New Local Agent');
  });

  it('states the self-heal contract (playbook is the rebuild spec)', () => {
    const { markdown } = composeLocalAgentPlaybook({ request: 'x' });
    expect(markdown).toMatch(/rebuild.*FROM this document/i);
    expect(markdown).toMatch(/agent:contract-violation/);
  });
});

describe('saveAgentPlaybook', () => {
  function makeStorage({ hasSpace = false } = {}) {
    return {
      index: { spaces: hasSpace ? [{ id: AGENT_PLAYBOOKS_SPACE_ID }] : [] },
      createSpace: vi.fn(),
      addItem: vi.fn(() => ({ id: 'item-1' })),
    };
  }

  it('creates the Agent Playbooks space when missing and saves the item', () => {
    const storage = makeStorage({ hasSpace: false });
    const out = saveAgentPlaybook('# PB', { title: 'T', agentName: 'A' }, { getSpacesStorage: () => storage });

    expect(out.saved).toBe(true);
    expect(out.ref).toEqual({ itemId: 'item-1', spaceId: AGENT_PLAYBOOKS_SPACE_ID });
    expect(storage.createSpace).toHaveBeenCalledTimes(1);
    const item = storage.addItem.mock.calls[0][0];
    expect(item.spaceId).toBe(AGENT_PLAYBOOKS_SPACE_ID);
    expect(item.content).toBe('# PB');
    expect(item.metadata.itemType).toBe('agent-playbook');
  });

  it('does not recreate an existing space', () => {
    const storage = makeStorage({ hasSpace: true });
    saveAgentPlaybook('# PB', {}, { getSpacesStorage: () => storage });
    expect(storage.createSpace).not.toHaveBeenCalled();
  });

  it('returns saved:false instead of throwing when storage is unavailable or broken', () => {
    expect(saveAgentPlaybook('# PB', {}, { getSpacesStorage: () => null }).saved).toBe(false);
    const broken = { index: { spaces: [] }, createSpace: () => { throw new Error('disk'); } };
    const out = saveAgentPlaybook('# PB', {}, { getSpacesStorage: () => broken });
    expect(out.saved).toBe(false);
    expect(out.error).toMatch(/disk/);
  });
});

describe('openPlaybookInWiser', () => {
  it('deep-links the playbooks tool with the markdown prefilled + autoSubmit', () => {
    const openWebTool = vi.fn();
    const ok = openPlaybookInWiser('# My Playbook', {
      getWebTools: () => [
        { id: 't1', name: 'Voice Monitor', url: 'https://x/voice' },
        { id: 't2', name: 'WISER Playbooks', url: 'https://x/riff/index.html' },
      ],
      openWebTool,
    });
    expect(ok).toBe(true);
    const [toolId, opts] = openWebTool.mock.calls[0];
    expect(toolId).toBe('t2');
    const url = new URL(opts.url);
    expect(url.searchParams.get('prompt')).toBe('# My Playbook');
    expect(url.searchParams.get('autoSubmit')).toBe('true');
  });

  it('returns false when no playbooks tool is registered', () => {
    expect(openPlaybookInWiser('# PB', { getWebTools: () => [], openWebTool: vi.fn() })).toBe(false);
  });

  it('never throws when the web-tool layer errors', () => {
    const ok = openPlaybookInWiser('# PB', {
      getWebTools: () => {
        throw new Error('no module manager');
      },
    });
    expect(ok).toBe(false);
  });
});
