/**
 * Unit tests for the manage-events surface:
 *  - the events_* tools registered in lib/agent-tools.js (behavioral, via
 *    the events-store _setTestDeps seam -- the tools and the test share the
 *    same CJS module instance)
 *  - the renderEventsApp modal HTML (structure + the bidirectional modal
 *    contract: form data-field + [data-value] actions + dark scrollbars)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { resolveTools, getToolDefinitions } from '../../lib/agent-tools.js';
import { renderEventsApp, APP_PANEL } from '../../lib/events/events-app.js';

// The tools lazy-require the events store as CJS; require it the same way so
// the _setTestDeps seam lands on the SAME module instance the tools use
// (an ESM import here can get a separate interop instance under vitest).
const eventsStore = require('../../lib/events/events-store.js');

const NOW = new Date(2026, 7, 3, 10, 0, 0);

describe('events tools registration', () => {
  it('all four events tools resolve with LLM-facing schemas', () => {
    const defs = getToolDefinitions(['events_open_app', 'events_add', 'events_next', 'events_delete']);
    expect(defs).toHaveLength(4);
    const add = defs.find((d) => d.name === 'events_add');
    expect(add.inputSchema.required).toEqual(['title', 'startsAt']);
    expect(add.inputSchema.properties.recurrence.enum).toEqual(['none', 'daily', 'weekly', 'monthly']);
    const open = defs.find((d) => d.name === 'events_open_app');
    expect(open.description).toMatch(/modal/i);
  });
});

describe('events tools execution (through the shared store seam)', () => {
  let client;

  beforeEach(() => {
    client = { executeQuery: vi.fn(async () => []) };
    eventsStore._setTestDeps({ getClient: () => client, now: () => NOW });
  });

  afterEach(() => {
    eventsStore._setTestDeps(null);
  });

  it('events_add writes through the store and returns the stored event', async () => {
    const [tool] = resolveTools(['events_add']);
    const out = await tool.execute({
      title: 'Dentist',
      startsAt: new Date(2026, 7, 4, 15, 0).toISOString(),
      recurrence: 'none',
    });
    expect(out.added).toBe(true);
    expect(out.event.title).toBe('Dentist');
    expect(client.executeQuery).toHaveBeenCalledTimes(1);
    expect(client.executeQuery.mock.calls[0][0]).toMatch(/MERGE \(e:Event/);
  });

  it('events_add surfaces validation errors as { error } (LLM-visible, no throw)', async () => {
    const [tool] = resolveTools(['events_add']);
    const out = await tool.execute({ title: 'X', startsAt: 'not-a-date' });
    expect(out.error).toMatch(/start time/);
  });

  it('events_next returns recurrence-aware upcoming occurrences', async () => {
    client.executeQuery.mockResolvedValue([
      { id: 'evt_b', title: 'Standup', startsAt: new Date(2026, 6, 6, 9, 30).toISOString(), recurrence: 'weekly', byDay: '1,2,3,4,5', active: true },
    ]);
    const [tool] = resolveTools(['events_next']);
    const out = await tool.execute({ limit: 3 });
    expect(out.upcoming).toHaveLength(1);
    expect(out.upcoming[0].title).toBe('Standup');
    expect(out.upcoming[0].when).toMatch(/tomorrow/);
  });

  it('events_delete routes id/title through the store', async () => {
    client.executeQuery.mockResolvedValue([{ deleted: 1 }]);
    const [tool] = resolveTools(['events_delete']);
    const out = await tool.execute({ title: 'Dentist' });
    expect(out.deleted).toBe(1);
  });

  it('events_open_app degrades to { error } when the modal layer is unavailable (test env has no electron)', async () => {
    client.executeQuery.mockResolvedValue([]);
    const [tool] = resolveTools(['events_open_app']);
    const out = await tool.execute({});
    // In the app this opens the modal; here the electron require fails and
    // the tool must hand the LLM an error object rather than throwing.
    expect(out.opened === true || typeof out.error === 'string').toBe(true);
  });
});

describe('renderEventsApp (modal HTML)', () => {
  const list = [
    {
      event: { id: 'evt_1', title: 'Dentist <checkup>', recurrence: 'none' },
      at: new Date(2026, 7, 4, 15, 0),
      when: 'tomorrow at 3:00 PM',
    },
    {
      event: { id: 'evt_2', title: 'Standup', recurrence: 'weekly' },
      at: new Date(2026, 7, 4, 9, 30),
      when: 'tomorrow at 9:30 AM',
    },
  ];

  it('renders rows with escaped titles, recurrence badges, and delete actions', () => {
    const html = renderEventsApp(list);
    expect(html).toContain('Dentist &lt;checkup&gt;');
    expect(html).not.toContain('Dentist <checkup>');
    expect(html).toContain('>weekly</span>');
    // Delete rides the [data-value] click contract back to the agent
    expect(html).toMatch(/data-value="delete the event Standup \(id evt_2\)"/);
  });

  it('carries the bidirectional form contract (data-field + named input)', () => {
    const html = renderEventsApp(list);
    expect(html).toMatch(/<form data-field="eventRequest">/);
    expect(html).toMatch(/name="eventRequest"/);
    // Quick actions route as spoken-equivalent utterances
    expect(html).toMatch(/data-value="what's next on my calendar of events"/);
  });

  it('shows an empty state and an optional notice', () => {
    expect(renderEventsApp([])).toMatch(/No upcoming events/);
    expect(renderEventsApp([], { notice: 'Added: Dentist ✓' })).toContain('Added: Dentist ✓');
  });

  it('ships dark scrollbars (never a default white scrollbar on a dark body)', () => {
    const html = renderEventsApp(list);
    expect(html).toMatch(/scrollbar-color:\s*#3a3f4b #16181d/);
    expect(html).toMatch(/::-webkit-scrollbar-thumb/);
  });

  it('exports the modal panel size the tool passes to showAgentUIModal', () => {
    expect(APP_PANEL.width).toBeGreaterThanOrEqual(400);
    expect(APP_PANEL.height).toBeGreaterThanOrEqual(300);
  });
});
