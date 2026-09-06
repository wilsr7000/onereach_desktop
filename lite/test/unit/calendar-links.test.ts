/**
 * Flow ↔ playbook ↔ Space ↔ journey-map links (ADR-090 addendum): the
 * watcher's queue slots are the flow→playbook truth; NEON rows add
 * titles, Spaces and journey maps under the sight rule.
 */
import { describe, it, expect } from 'vitest';
import { FLOW_LINKS_CYPHER, buildsForFlow, linksFromRows, slotFrom } from '../../calendar/links.js';

describe('calendar links — queue slots', () => {
  it('reads a slot (object or JSON text), needs both ids, and dates finishedAt in ms', () => {
    const slot = slotFrom('req-1', { playbookId: 'pb-1', flowId: 'f-1', status: 'completed', finishedAt: '2026-08-17T11:30:36.342Z' });
    expect(slot).toMatchObject({ key: 'req-1', playbookId: 'pb-1', flowId: 'f-1', status: 'completed', finishedAtMs: Date.parse('2026-08-17T11:30:36.342Z'), botId: null });
    expect(slotFrom('req-2', JSON.stringify({ playbookId: 'pb-2', flowId: 'f-2', botId: 'b-1', requestedAt: 1_700_000_000 }))).toMatchObject({ botId: 'b-1', status: 'unknown', finishedAtMs: 1_700_000_000_000 });
    expect(slotFrom('req-3', { playbookId: 'pb-3' })).toBeNull();
    expect(slotFrom('req-4', 'not json')).toBeNull();
    expect(slotFrom('req-5', null)).toBeNull();
  });

  it('lists the builds of a flow newest first, one per playbook', () => {
    const slots = [
      slotFrom('a', { playbookId: 'pb-1', flowId: 'f-1', finishedAt: '2026-01-01T00:00:00Z' })!,
      slotFrom('b', { playbookId: 'pb-2', flowId: 'f-1', finishedAt: '2026-03-01T00:00:00Z' })!,
      slotFrom('c', { playbookId: 'pb-1', flowId: 'f-1', finishedAt: '2026-02-01T00:00:00Z' })!,
      slotFrom('d', { playbookId: 'pb-9', flowId: 'f-other' })!,
    ];
    expect(buildsForFlow(slots, 'f-1').map((b) => [b.playbookId, b.key])).toEqual([['pb-2', 'b'], ['pb-1', 'c']]);
    expect(buildsForFlow(slots, 'f-none')).toEqual([]);
  });
});

describe('calendar links — rows', () => {
  const builds = [slotFrom('a', { playbookId: 'pb-1', flowId: 'f-1', status: 'completed', finishedAt: '2026-08-17T11:30:36.342Z' })!];
  it('merges Spaces (asset first), playbooks with build metadata, and journeys ranked by closeness', () => {
    const rows = [
      {
        flowSpaces: [{ id: 'sp-1', name: 'Omni Data', assetId: 'as-1', assetTitle: 'HTTP toolkit flow' }],
        playbooks: [{ id: 'pb-1', title: 'HTTP toolkit playbook', spaceId: 'sp-2', spaceName: 'Ops' }],
        spaces: [{ id: 'sp-2', name: 'Ops', via: 'playbook' }, { id: 'sp-1', name: 'Omni Data', via: 'asset' }, { id: 'sp-3', name: 'omni data', via: 'name' }],
        journeys: [{ id: 'j-2', title: 'Ops journey', spaceId: 'sp-2', spaceName: 'Ops', via: 'playbook' }, { id: 'j-1', title: 'Onboarding Journey Map', spaceId: 'sp-1', spaceName: 'Omni Data', via: 'asset' }, { id: 'j-1', title: 'Onboarding Journey Map', spaceId: 'sp-3', spaceName: 'omni data', via: 'space' }],
      },
    ];
    const r = linksFromRows(rows, builds);
    expect(r.spaces.map((s) => [s.id, s.via, s.assetId, s.assetTitle])).toEqual([['sp-1', 'asset', 'as-1', 'HTTP toolkit flow'], ['sp-2', 'playbook', null, null], ['sp-3', 'name', null, null]]);
    expect(r.playbooks).toEqual([{ id: 'pb-1', title: 'HTTP toolkit playbook', spaceId: 'sp-2', spaceName: 'Ops', via: 'build', builtAtMs: Date.parse('2026-08-17T11:30:36.342Z'), status: 'completed' }]);
    expect(r.journeys.map((j) => [j.id, j.via])).toEqual([['j-1', 'asset'], ['j-2', 'playbook']]);
  });

  it('empty rows give empty lists; ids are required', () => {
    expect(linksFromRows([], builds)).toEqual({ spaces: [], playbooks: [], journeys: [] });
    expect(linksFromRows([{ flowSpaces: null, playbooks: [{ title: 'no id' }], spaces: [{ name: 'no id' }], journeys: [{ id: 'j', spaceId: '' }] }], builds)).toEqual({ spaces: [], playbooks: [], journeys: [] });
  });

  it('the Cypher takes the flow, the playbook ids and the GSX space name, is sight-filtered, and never infers from OWNS', () => {
    expect(FLOW_LINKS_CYPHER).toContain('$flowId');
    expect(FLOW_LINKS_CYPHER).toContain('fa.gsxFlowId = $flowId');
    expect(FLOW_LINKS_CYPHER).toContain('$playbookIds');
    expect(FLOW_LINKS_CYPHER).toContain('$botLabel');
    expect(FLOW_LINKS_CYPHER).toContain('$viewerId');
    expect(FLOW_LINKS_CYPHER).not.toMatch(/OWNS/);
    expect(FLOW_LINKS_CYPHER).toContain("'journey'");
  });
});
