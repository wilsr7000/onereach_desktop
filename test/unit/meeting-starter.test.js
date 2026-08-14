/**
 * Unit tests for the Meeting Starter stack:
 *   lib/meetings/participants.js   - human filter + graph suggestions
 *   lib/meetings/meeting-draft.js  - draft state + start flow
 *   lib/meetings/meeting-setup-app.js - setup modal HTML contract
 *   lib/meetings/ensure-meeting-agent.js - playbook-backed seeding
 *   meeting_* tools in lib/agent-tools.js (shared CJS store instances)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { resolveTools } from '../../lib/agent-tools.js';
import { renderMeetingSetup, SETUP_PANEL } from '../../lib/meetings/meeting-setup-app.js';
import {
  ensureMeetingStarterAgent,
  buildMeetingAgentConfig,
  MEETING_AGENT_TOOLS,
  MEETING_AGENT_NAME,
} from '../../lib/meetings/ensure-meeting-agent.js';
import { LOCAL_AGENT_TEMPLATE_SECTIONS } from '../../lib/agent-playbook.js';

// Tools lazy-require these as CJS; require them the same way so the seams
// land on the same module instances.
const participants = require('../../lib/meetings/participants.js');
const draftLib = require('../../lib/meetings/meeting-draft.js');

afterEach(() => {
  participants._setTestDeps(null);
  draftLib._setTestDeps(null);
  draftLib.clearDraft();
});

// ─── participants ────────────────────────────────────────────────────────────

describe('isHumanPerson', () => {
  it('keeps real people and drops system actors', () => {
    expect(participants.isHumanPerson({ name: 'Erika Hall', email: 'erika@example.com' })).toBe(true);
    expect(participants.isHumanPerson({ name: 'Playbooks System', email: 'system@playbooks.app' })).toBe(false);
    expect(participants.isHumanPerson({ name: 'system', email: 'system' })).toBe(false);
    expect(participants.isHumanPerson({ name: 'Flow-Building Pipeline (system actor)' })).toBe(false);
    expect(
      participants.isHumanPerson({ name: 'Robb (GSX Expert)', email: 'robb+multitenant/edison/gsx_expert@onereach.com' })
    ).toBe(false);
    expect(participants.isHumanPerson({ name: '35254342-4a2e-475b-aec1-18547e517e29'.replace(/-/g, '') })).toBe(false);
    expect(participants.isHumanPerson({ name: '' })).toBe(false);
  });

  it('drops UUID-shaped identities', () => {
    expect(participants.isHumanPerson({ name: '35254342-4a2e-475b-aec1-18547e517e29', email: '' })).toBe(false);
  });
});

describe('suggestParticipants', () => {
  it('queries :Person, filters to humans, dedupes, and limits', async () => {
    const client = {
      executeQuery: vi.fn(async () => [
        { name: 'Erika Hall', email: 'erika@example.com', role: null },
        { name: 'ERIKA HALL', email: 'erika@example.com', role: null }, // dupe by email
        { name: 'Playbooks System', email: 'system@playbooks.app', role: null },
        { name: 'Jonas Downey', email: 'jonas@example.com', role: null },
        { name: 'Alex Petrov', email: 'alex@example.com', role: null },
      ]),
    };
    participants._setTestDeps({ getClient: () => client });

    const out = await participants.suggestParticipants(2);
    expect(client.executeQuery.mock.calls[0][0]).toMatch(/MATCH \(p:Person\)/);
    expect(out).toEqual([
      { name: 'Erika Hall', email: 'erika@example.com' },
      { name: 'Jonas Downey', email: 'jonas@example.com' },
    ]);
  });

  it('returns [] instead of throwing when the graph is unreachable', async () => {
    participants._setTestDeps({
      getClient: () => ({ executeQuery: async () => { throw new Error('offline'); } }),
    });
    expect(await participants.suggestParticipants()).toEqual([]);
  });
});

// ─── meeting draft ───────────────────────────────────────────────────────────

describe('meeting draft', () => {
  it('updates title/space and adds/removes participants case-insensitively without dupes', () => {
    draftLib.updateDraft({ title: 'Design sync', spaceName: 'Product' });
    draftLib.updateDraft({ add: [{ name: 'Erika Hall', email: 'erika@example.com' }, 'Jonas Downey'] });
    draftLib.updateDraft({ add: ['erika hall'] }); // dupe
    let draft = draftLib.updateDraft({ remove: ['JONAS DOWNEY'] });

    expect(draft.title).toBe('Design sync');
    expect(draft.spaceName).toBe('Product');
    expect(draft.participants).toEqual([{ name: 'Erika Hall', email: 'erika@example.com' }]);

    draft = draftLib.clearDraft();
    expect(draft).toEqual({ title: null, spaceName: null, participants: [] });
  });
});

describe('startMeeting', () => {
  let opened;
  let spaces;
  let created;

  beforeEach(() => {
    opened = [];
    created = [];
    spaces = [
      { id: 'sp-prod', name: 'Product' },
      { id: 'sp-meet', name: 'Meetings' },
    ];
    draftLib._setTestDeps({
      listSpaces: async () => spaces,
      createSpace: async (name) => {
        const s = { id: `sp-new-${name}`, name };
        created.push(s);
        return s;
      },
      openRecorder: (options) => {
        opened.push(options);
        return { success: true };
      },
    });
  });

  it('starts from the draft: resolves the named space, passes participants, clears the draft', async () => {
    draftLib.updateDraft({ title: 'Design sync', spaceName: 'product', add: ['Erika Hall', 'Jonas Downey'] });
    const out = await draftLib.startMeeting();

    expect(out.started).toBe(true);
    expect(out.spaceId).toBe('sp-prod');
    expect(out.participants.map((p) => p.name)).toEqual(['Erika Hall', 'Jonas Downey']);

    expect(opened).toHaveLength(1);
    expect(opened[0].spaceId).toBe('sp-prod');
    expect(opened[0].instructions).toContain('Meeting: Design sync');
    expect(opened[0].instructions).toContain('Erika Hall, Jonas Downey');

    expect(draftLib.getDraft().participants).toEqual([]); // consumed
  });

  it('creates a missing named space', async () => {
    const out = await draftLib.startMeeting({ spaceName: 'Skunkworks', participants: ['Alex'] });
    expect(out.started).toBe(true);
    expect(created.map((s) => s.name)).toEqual(['Skunkworks']);
    expect(out.spaceId).toBe('sp-new-Skunkworks');
  });

  it('defaults to an existing meeting-ish space when none named', async () => {
    const out = await draftLib.startMeeting({ participants: ['Alex'] });
    expect(out.spaceId).toBe('sp-meet');
  });

  it('reports failure honestly when the meeting window cannot open', async () => {
    draftLib._setTestDeps({
      listSpaces: async () => spaces,
      createSpace: async () => null,
      openRecorder: () => ({ success: false, error: 'Recorder not initialized' }),
    });
    const out = await draftLib.startMeeting({ participants: ['Alex'] });
    expect(out.started).toBe(false);
    expect(out.error).toMatch(/Recorder not initialized/);
  });

  it('still starts (spaceless) when space resolution blows up', async () => {
    draftLib._setTestDeps({
      listSpaces: async () => { throw new Error('spaces down'); },
      createSpace: async () => { throw new Error('spaces down'); },
      openRecorder: (options) => { opened.push(options); return { success: true }; },
    });
    const out = await draftLib.startMeeting({ title: 'Quick huddle' });
    expect(out.started).toBe(true);
    expect(out.spaceId).toBeNull();
    expect(opened[0].spaceId).toBeUndefined();
  });
});

// ─── setup modal ─────────────────────────────────────────────────────────────

describe('renderMeetingSetup', () => {
  const draft = {
    title: 'Design sync',
    spaceName: 'Product',
    participants: [{ name: 'Erika Hall', email: 'erika@example.com' }],
  };
  const suggestions = [
    { name: 'Erika Hall', email: 'erika@example.com' }, // already chosen -> hidden
    { name: 'Jonas <Downey>', email: 'jonas@example.com' },
  ];

  it('shows chosen chips with remove actions and suggestion chips with add actions', () => {
    const html = renderMeetingSetup(draft, suggestions);
    expect(html).toMatch(/data-value="remove Erika Hall from the meeting"/);
    expect(html).toMatch(/data-value="add Jonas &lt;Downey&gt; to the meeting"/);
    // chosen suggestion is not re-suggested
    expect(html).not.toMatch(/data-value="add Erika Hall to the meeting"/);
  });

  it('carries the start action, the form contract, and the draft meta', () => {
    const html = renderMeetingSetup(draft, suggestions);
    expect(html).toMatch(/data-value="start the meeting now"/);
    expect(html).toMatch(/<form data-field="meetingRequest">/);
    expect(html).toContain('Design sync');
    expect(html).toContain('Product');
  });

  it('ships dark scrollbars and a sane panel size', () => {
    const html = renderMeetingSetup(draft, suggestions);
    expect(html).toMatch(/scrollbar-color:\s*#3a3f4b #16181d/);
    expect(SETUP_PANEL.width).toBeGreaterThanOrEqual(400);
    expect(SETUP_PANEL.height).toBeGreaterThanOrEqual(300);
  });
});

// ─── tools ───────────────────────────────────────────────────────────────────

// The setup modal must close (and stay closed) once the real meeting window
// opens — a reopened modal is the "second meeting window" users kept finding
// stacked under the meeting.
describe('setup modal lifecycle on start', () => {
  let closed;
  let nowMs;

  beforeEach(() => {
    closed = 0;
    nowMs = 1_000_000;
    draftLib.updateDraft({}); // clears any leftover just-started suppression
    draftLib.clearDraft();
    draftLib._setTestDeps({
      listSpaces: async () => [{ id: 'sp-meet', name: 'Meetings' }],
      createSpace: async () => null,
      openRecorder: () => ({ success: true }),
      closeSetupModal: () => { closed += 1; },
      now: () => nowMs,
    });
  });

  afterEach(() => {
    draftLib._setTestDeps(null);
    draftLib.updateDraft({}); // do not leak suppression into other tests
  });

  it('a successful start closes the setup modal and arms reopen suppression', async () => {
    const out = await draftLib.startMeeting({});
    expect(out.started).toBe(true);
    expect(closed).toBe(1);
    expect(draftLib.wasJustStarted()).toBe(true);
  });

  it('a failed start keeps the modal open (user still needs it to retry)', async () => {
    draftLib._setTestDeps({
      listSpaces: async () => [],
      createSpace: async () => null,
      openRecorder: () => ({ success: false, error: 'nope' }),
      closeSetupModal: () => { closed += 1; },
      now: () => nowMs,
    });
    const out = await draftLib.startMeeting({});
    expect(out.started).toBe(false);
    expect(closed).toBe(0);
    expect(draftLib.wasJustStarted()).toBe(false);
  });

  it('suppression expires after the window', async () => {
    await draftLib.startMeeting({});
    expect(draftLib.wasJustStarted()).toBe(true);
    nowMs += 20001;
    expect(draftLib.wasJustStarted()).toBe(false);
  });

  it('editing the draft again clears suppression (organizing a new meeting)', async () => {
    await draftLib.startMeeting({});
    expect(draftLib.wasJustStarted()).toBe(true);
    draftLib.updateDraft({ add: ['Erika Hall'] });
    expect(draftLib.wasJustStarted()).toBe(false);
  });

  it('meeting_open_setup refuses to reopen while just-started', async () => {
    await draftLib.startMeeting({});
    const [tool] = resolveTools(['meeting_open_setup']);
    const out = await tool.execute({ notice: 'Meeting started' });
    expect(out.opened).toBe(false);
    expect(out.suppressed).toBe(true);
  });
});

describe('meeting tools', () => {
  beforeEach(() => {
    draftLib.clearDraft();
    participants._setTestDeps({
      getClient: () => ({
        executeQuery: async () => [{ name: 'Erika Hall', email: 'erika@example.com', role: null }],
      }),
    });
  });

  it('meeting_suggest_participants returns graph humans', async () => {
    const [tool] = resolveTools(['meeting_suggest_participants']);
    const out = await tool.execute({});
    expect(out.suggestions).toEqual([{ name: 'Erika Hall', email: 'erika@example.com' }]);
  });

  it('meeting_update mutates the shared draft', async () => {
    const [tool] = resolveTools(['meeting_update']);
    const out = await tool.execute({ title: 'Sync', add: [{ name: 'Erika Hall' }] });
    expect(out.draft.title).toBe('Sync');
    expect(draftLib.getDraft().participants).toHaveLength(1);
  });

  it('meeting_start consumes the draft through the same seam', async () => {
    const openedOptions = [];
    draftLib._setTestDeps({
      listSpaces: async () => [{ id: 'sp-meet', name: 'Meetings' }],
      createSpace: async () => null,
      openRecorder: (o) => { openedOptions.push(o); return { success: true }; },
    });
    draftLib.updateDraft({ add: ['Erika Hall'] });
    const [tool] = resolveTools(['meeting_start']);
    const out = await tool.execute({});
    expect(out.started).toBe(true);
    expect(openedOptions[0].instructions).toContain('Erika Hall');
  });
});

// ─── seeding ─────────────────────────────────────────────────────────────────

describe('ensureMeetingStarterAgent', () => {
  function makeStore(agents = []) {
    return {
      init: vi.fn(),
      getLocalAgents: vi.fn(() => agents),
      createAgent: vi.fn(async (cfg) => ({ ...cfg, id: 'agent-meet' })),
      updateAgent: vi.fn(async (id, updates) => ({ id, ...updates })),
    };
  }
  const playbookLib = {
    composeLocalAgentPlaybook: vi.fn(({ config }) => ({
      markdown: `# Local Agent Playbook: ${config.name}`,
      title: `Local Agent Playbook: ${config.name}`,
      agentName: config.name,
    })),
    saveAgentPlaybook: vi.fn(() => ({ saved: true, ref: { itemId: 'pb-m', spaceId: 'agent-playbooks' } })),
  };

  it('config binds the meeting tools and the delegation contract', () => {
    const config = buildMeetingAgentConfig();
    expect(config.tools).toEqual([...MEETING_AGENT_TOOLS]);
    expect(config.prompt).toMatch(/meeting_open_setup/);
    expect(config.prompt).toMatch(/meeting_start/);
    expect(config.prompt).toMatch(/Video Recorder agent/);
    expect(config.keywords).toContain('start a meeting with');
  });

  it('creates the agent playbook-backed when missing', async () => {
    const store = makeStore([]);
    const out = await ensureMeetingStarterAgent({ getStore: () => store, playbookLib });
    expect(out.status).toBe('created');
    const created = store.createAgent.mock.calls[0][0];
    expect(created.name).toBe(MEETING_AGENT_NAME);
    expect(created.playbook.markdown).toContain('Meeting Starter');
  });

  it('patches older definitions and no-ops complete ones', async () => {
    const complete = {
      id: 'm1',
      name: 'meeting starter',
      tools: [...MEETING_AGENT_TOOLS],
      playbook: { markdown: '#' },
      prompt: buildMeetingAgentConfig().prompt,
    };
    expect((await ensureMeetingStarterAgent({ getStore: () => makeStore([complete]), playbookLib })).status).toBe('exists');

    const stale = makeStore([{ id: 'm2', name: MEETING_AGENT_NAME, tools: ['meeting_start'], playbook: { markdown: '#' } }]);
    const out = await ensureMeetingStarterAgent({ getStore: () => stale, playbookLib });
    expect(out.status).toBe('patched');
    expect(stale.updateAgent.mock.calls[0][1].tools).toEqual([...MEETING_AGENT_TOOLS]);
  });

  it('patches an agent whose prompt drifted from the code (stale prompt)', async () => {
    const drifted = makeStore([
      {
        id: 'm3',
        name: MEETING_AGENT_NAME,
        tools: [...MEETING_AGENT_TOOLS],
        playbook: { markdown: '#' },
        prompt: 'old prompt that still reopens the setup modal after start',
      },
    ]);
    const out = await ensureMeetingStarterAgent({ getStore: () => drifted, playbookLib });
    expect(out.status).toBe('patched');
    const updates = drifted.updateAgent.mock.calls[0][1];
    expect(updates.prompt).toContain('never after meeting_start');
  });

  it('the REAL template composes all sections for this agent', async () => {
    const realPlaybookLib = {
      ...(await import('../../lib/agent-playbook.js')),
      saveAgentPlaybook: vi.fn(() => ({ saved: true, ref: null })),
    };
    const store = makeStore([]);
    await ensureMeetingStarterAgent({ getStore: () => store, playbookLib: realPlaybookLib });
    const created = store.createAgent.mock.calls[0][0];
    for (const section of LOCAL_AGENT_TEMPLATE_SECTIONS) {
      expect(created.playbook.markdown).toContain(`## ${section}`);
    }
  });

  it('never throws (unavailable store / store errors)', async () => {
    expect((await ensureMeetingStarterAgent({ getStore: () => null, playbookLib })).status).toBe('unavailable');
    const broken = makeStore([]);
    broken.createAgent.mockRejectedValue(new Error('disk'));
    expect((await ensureMeetingStarterAgent({ getStore: () => broken, playbookLib })).status).toBe('error');
  });
});

// ─── bridge wiring invariant ─────────────────────────────────────────────────

describe('exchange-bridge -- Meeting Starter seeding wiring', () => {
  const fs = require('fs');
  const path = require('path');
  const BRIDGE_SOURCE = fs.readFileSync(
    path.join(__dirname, '../../src/voice-task-sdk/exchange-bridge.js'),
    'utf8'
  );

  it('seeds the Meeting Starter after connectCustomAgents, non-fatally', () => {
    expect(BRIDGE_SOURCE).toMatch(/require\('\.\.\/\.\.\/lib\/meetings\/ensure-meeting-agent'\)/);
    const connectIdx = BRIDGE_SOURCE.indexOf('await connectCustomAgents(');
    const seedIdx = BRIDGE_SOURCE.indexOf('ensureMeetingStarterAgent');
    expect(seedIdx).toBeGreaterThan(connectIdx);
  });
});
