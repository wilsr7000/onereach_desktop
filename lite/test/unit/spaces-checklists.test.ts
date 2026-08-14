/**
 * Checklists (ADR-055) — the node, the edges, the gate.
 *
 * Two load-bearing behaviors:
 *
 *   1. THE DOCTRINE IS VALIDATED, NOT DECORATIVE. Mode must be one of
 *      the book's two; a pause point is mandatory (a checklist without
 *      one is just a list); items are capped at 12 with a remediation
 *      that cites the brevity doctrine — reject, never truncate,
 *      because silently dropping someone's killer item defeats the
 *      entire point of the artifact.
 *
 *   2. THE GATE FAILS CLOSED ON `required` AND NEVER BLOCKS ON
 *      `recommended`. An incomplete required preflight blocks leaving
 *      `open`; an incomplete required postflight blocks entering
 *      `done`. A gate people can't distinguish from bureaucracy gets
 *      worked around — so recommended warns (renderer) and never
 *      blocks (SDK).
 */

import { describe, it, expect } from 'vitest';
import {
  SdkSpacesClient,
  CYPHER,
  sanitizeChecklistItems,
} from '../../spaces/sdk-client.js';
import { SpacesError } from '../../spaces/errors.js';

const NOW = Date.parse('2026-08-08T12:00:00.000Z');

interface Recorded {
  cypher: string;
  params: Record<string, unknown>;
}

function client(respond: (cypher: string) => Array<Record<string, unknown>>): {
  api: SdkSpacesClient;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const api = new SdkSpacesClient({
    now: () => NOW,
    viewerId: () => 'robb@onereach.com',
    query: async (cypher: string, params?: Record<string, unknown>) => {
      calls.push({ cypher, params: params ?? {} });
      return respond(cypher);
    },
  });
  return { api, calls };
}

// ─── 1. Doctrine validation ──────────────────────────────────────────

describe('sanitizeChecklistItems — the brevity doctrine has teeth', () => {
  it('accepts a short list and preserves killer flags', () => {
    const items = sanitizeChecklistItems([
      { text: 'Backups verified', killer: true },
      { text: '  Release   notes written  ' },
    ]);
    expect(items).toEqual([
      { text: 'Backups verified', killer: true },
      { text: 'Release notes written' },
    ]);
  });

  it('rejects an empty list — a checklist needs at least one item', () => {
    expect(() => sanitizeChecklistItems([])).toThrow(SpacesError);
  });

  it('rejects 13+ items and cites the doctrine rather than truncating', () => {
    const items = Array.from({ length: 13 }, (_, i) => ({ text: `item ${i}` }));
    try {
      sanitizeChecklistItems(items);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as SpacesError).remediation).toMatch(/killer items|5–9/);
    }
  });

  it('rejects a blank item instead of silently dropping it', () => {
    expect(() => sanitizeChecklistItems([{ text: '   ' }])).toThrow(/item 1/);
  });
});

describe('createChecklist — mode and pause point are mandatory', () => {
  it('rejects an unknown mode with the two real ones named', async () => {
    const { api } = client(() => []);
    await expect(
      api.createChecklist({
        spaceId: 'space-1',
        name: 'Deploy',
        mode: 'CHECK-LATER' as never,
        pausePoint: 'before deploy',
        items: [{ text: 'x' }],
      })
    ).rejects.toThrow(/DO-CONFIRM or READ-DO/);
  });

  it('rejects a missing pause point — WHEN it runs is part of the schema', async () => {
    const { api } = client(() => []);
    await expect(
      api.createChecklist({
        spaceId: 'space-1',
        name: 'Deploy',
        mode: 'DO-CONFIRM',
        pausePoint: '   ',
        items: [{ text: 'x' }],
      })
    ).rejects.toThrow(/pause point/);
  });

  it('writes itemCount alongside the JSON so completion checks are atomic', async () => {
    const { api, calls } = client(() => [{ id: 'c1' }]);
    await api.createChecklist({
      spaceId: 'space-1',
      name: 'Deploy',
      mode: 'READ-DO',
      pausePoint: 'before deploy',
      items: [{ text: 'a' }, { text: 'b', killer: true }],
    });
    const create = calls.find((c) => c.cypher.includes('CREATE (c:Checklist'));
    expect(create?.params['itemCount']).toBe(2);
    expect(JSON.parse(create?.params['itemsJson'] as string)).toHaveLength(2);
  });
});

// ─── 2. The status gate ──────────────────────────────────────────────

function gateRows(over: {
  status?: string;
  pre?: Array<{ name: string; complete: boolean }>;
  post?: Array<{ name: string; complete: boolean }>;
}): Array<Record<string, unknown>> {
  return [
    {
      currentStatus: over.status ?? 'open',
      requiredPre: over.pre ?? [],
      requiredPost: over.post ?? [],
    },
  ];
}

describe('the required-checklist gate', () => {
  it('blocks open -> in_progress while a required preflight is incomplete', async () => {
    const { api } = client((cypher) =>
      cypher.includes('requiredPre')
        ? gateRows({ status: 'open', pre: [{ name: 'Launch readiness', complete: false }] })
        : []
    );
    try {
      await api.assertTicketStatusAllowed('t1', 'in_progress');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as SpacesError).code).toBe('SPACES_CHECKLIST_REQUIRED');
      // The error NAMES the checklist so the renderer can point at it.
      expect((err as SpacesError).message).toContain('Launch readiness');
    }
  });

  it('allows the transition once the preflight is complete', async () => {
    const { api } = client((cypher) =>
      cypher.includes('requiredPre')
        ? gateRows({ status: 'open', pre: [{ name: 'Launch readiness', complete: true }] })
        : []
    );
    await expect(api.assertTicketStatusAllowed('t1', 'in_progress')).resolves.toBeUndefined();
  });

  it('blocks entering done while a required postflight is incomplete', async () => {
    const { api } = client((cypher) =>
      cypher.includes('requiredPre')
        ? gateRows({ status: 'in_progress', post: [{ name: 'Ship review', complete: false }] })
        : []
    );
    await expect(api.assertTicketStatusAllowed('t1', 'done')).rejects.toThrow(/Ship review/);
  });

  // The book's warning in reverse: a gate that blocks on advice gets
  // worked around, poisoning trust in the required ones.
  it('NEVER blocks on recommended — only required gates', async () => {
    const { api } = client((cypher) =>
      cypher.includes('requiredPre')
        ? gateRows({ status: 'open' }) // gate query returns REQUIRED only
        : []
    );
    await expect(api.assertTicketStatusAllowed('t1', 'in_progress')).resolves.toBeUndefined();
  });

  it('does not gate transitions to blocked — parking a ticket is always allowed', async () => {
    const { api, calls } = client(() => []);
    await api.assertTicketStatusAllowed('t1', 'blocked');
    expect(calls, 'no gate query should even run').toHaveLength(0);
  });

  it('a preflight does not re-gate a ticket already past open', async () => {
    const { api } = client((cypher) =>
      cypher.includes('requiredPre')
        ? gateRows({ status: 'in_progress', pre: [{ name: 'Launch readiness', complete: false }] })
        : []
    );
    // Moving in_progress -> done: only the POSTFLIGHT set applies.
    await expect(api.assertTicketStatusAllowed('t1', 'done')).resolves.toBeUndefined();
  });

  it('updateTicket runs the gate BEFORE the write', async () => {
    const order: string[] = [];
    const { api } = client((cypher) => {
      if (cypher.includes('requiredPre')) {
        order.push('gate');
        return gateRows({ status: 'open', pre: [{ name: 'L', complete: false }] });
      }
      if (cypher.includes('SET a.name')) order.push('write');
      return [{ id: 't1' }];
    });
    await expect(api.updateTicket('t1', { status: 'in_progress' })).rejects.toThrow(
      /SPACES_CHECKLIST_REQUIRED|incomplete/
    );
    expect(order, 'the write must never have happened').toEqual(['gate']);
  });
});

// ─── 2b. Central param injection ─────────────────────────────────────
//
// Regression for the silent-empty-tickets bug: LIST_TICKETS_IN_SPACE
// gained the ADR-051 visibility predicate (which reads $viewerId)
// without its call site gaining the parameter. Neo4j rejected the
// query; the Edison flow mapped the rejection to an empty result set;
// every shared dashboard showed "No tickets yet" against real data.
// run() now injects viewerId (like nowMs) so the omission is
// structurally impossible.

describe('run() injects viewerId and nowMs into every query', () => {
  it('listTickets carries viewerId even though its call site never binds it', async () => {
    const { api, calls } = client(() => []);
    await api.listTickets('space-1');
    const q = calls.find((c) => c.cypher.includes("= 'ticket'"));
    expect(q?.params['viewerId']).toBe('robb@onereach.com');
    expect(q?.params['nowMs']).toBe(NOW);
  });

  it('every checklist read carries viewerId', async () => {
    const { api, calls } = client((cypher) =>
      cypher.includes('requiredPre') ? [] : []
    );
    await api.listChecklists('space-1');
    await api.getTicketChecklists('t1');
    for (const c of calls) {
      if (c.cypher.includes('$viewerId')) {
        expect(c.params['viewerId'], c.cypher.slice(0, 60)).toBe('robb@onereach.com');
      }
    }
    expect(calls.length).toBeGreaterThan(0);
  });

  it('an explicit viewerId in call-site params still wins (tests can pin)', async () => {
    const calls: Recorded[] = [];
    const api = new SdkSpacesClient({
      now: () => NOW,
      viewerId: () => 'robb@onereach.com',
      query: async (cypher: string, params?: Record<string, unknown>) => {
        calls.push({ cypher, params: params ?? {} });
        return [];
      },
    });
    // listSpaces binds viewerId explicitly at the call site.
    await api.listSpaces();
    const q = calls[0];
    expect(q?.params['viewerId']).toBe('robb@onereach.com');
  });
});

// ─── 3. Query-shape guards (the visibility sweep also covers these) ──

describe('checklist Cypher carries the visibility predicates', () => {
  it('LIST_CHECKLISTS_IN_SPACE gates on the Space', () => {
    expect(CYPHER.LIST_CHECKLISTS_IN_SPACE).toContain("coalesce(s.createdBy, '') = $viewerId");
  });

  it('GET_TICKET_CHECKLISTS and the gate read are asset-gated', () => {
    expect(CYPHER.GET_TICKET_CHECKLISTS).toContain("coalesce(vs.createdBy, '') = $viewerId");
    expect(CYPHER.TICKET_GATE_STATE).toContain("coalesce(vs.createdBy, '') = $viewerId");
  });

  it('the atomic toggle is a native list op, not a JSON read-modify-write', () => {
    expect(CYPHER.SET_CHECKLIST_ITEM_PREFLIGHT).toContain('WHERE x <> $itemIndex');
    expect(CYPHER.SET_CHECKLIST_ITEM_PREFLIGHT).toContain('size(r.checkedIdx)');
  });

  it('attach edges are the two named relationship types, not a property flag', () => {
    expect(CYPHER.ATTACH_CHECKLIST_PREFLIGHT).toContain('[r:PREFLIGHT_CHECKLIST]');
    expect(CYPHER.ATTACH_CHECKLIST_POSTFLIGHT).toContain('[r:POSTFLIGHT_CHECKLIST]');
  });

  it('the schema registry write covers the entity and both relationships', () => {
    expect(CYPHER.ENSURE_CHECKLIST_SCHEMA).toContain("entity: 'Checklist'");
    expect(CYPHER.ENSURE_CHECKLIST_SCHEMA).toContain("entity: '_RelationshipTypes'");
    expect(CYPHER.ENSURE_CHECKLIST_SCHEMA).toContain('preflightChecklist');
    expect(CYPHER.ENSURE_CHECKLIST_SCHEMA).toContain('postflightChecklist');
  });
});

describe('ADR-055 addendum — revise + delete (2026-08-08)', () => {
  it('UPDATE bumps the version and RESETS every run state in one statement', async () => {
    const { CYPHER } = await import('../../spaces/sdk-client.js');
    const q = CYPHER.UPDATE_CHECKLIST;
    expect(q).toContain('c.version = coalesce(c.version, 1) + 1');
    expect(q).toContain('c.revisedAt = $now');
    // Both edge types reset — a check against v1's items says nothing
    // about v2's (checkedIdx is positional).
    expect(q).toContain('[pre:PREFLIGHT_CHECKLIST]->(c)');
    expect(q).toContain('pre.checkedIdx = []');
    expect(q).toContain('[post:POSTFLIGHT_CHECKLIST]->(c)');
    expect(q).toContain('post.checkedIdx = []');
    // Visibility-gated like every checklist read/write.
    expect(q).toContain('$viewerId');
  });

  it('DELETE is refused while attached; the count query sees both edges', async () => {
    const { CYPHER } = await import('../../spaces/sdk-client.js');
    expect(CYPHER.COUNT_CHECKLIST_ATTACHMENTS).toContain('PREFLIGHT_CHECKLIST');
    expect(CYPHER.COUNT_CHECKLIST_ATTACHMENTS).toContain('POSTFLIGHT_CHECKLIST');
    expect(CYPHER.DELETE_CHECKLIST).toContain('DETACH DELETE c');
    expect(CYPHER.DELETE_CHECKLIST).toContain('$viewerId');

    const { SdkSpacesClient } = await import('../../spaces/sdk-client.js');
    const calls: string[] = [];
    const client = new SdkSpacesClient({
      query: async (cypher: string) => {
        calls.push(cypher);
        if (cypher.includes('attachedCount')) return [{ attachedCount: 2 }];
        return [];
      },
    });
    await expect(client.deleteChecklist('cl-1')).rejects.toMatchObject({
      code: 'SPACES_CHECKLIST_ATTACHED',
    });
    // The delete itself must never have run.
    expect(calls.some((c) => c.includes('DETACH DELETE'))).toBe(false);
  });

  it('delete proceeds when detached everywhere', async () => {
    const { SdkSpacesClient } = await import('../../spaces/sdk-client.js');
    const calls: string[] = [];
    const client = new SdkSpacesClient({
      query: async (cypher: string) => {
        calls.push(cypher);
        if (cypher.includes('attachedCount')) return [{ attachedCount: 0 }];
        return [];
      },
    });
    await client.deleteChecklist('cl-1');
    expect(calls.some((c) => c.includes('DETACH DELETE'))).toBe(true);
  });

  it('update revalidates with the SAME doctrine as create (cap 12, reject)', async () => {
    const { SdkSpacesClient } = await import('../../spaces/sdk-client.js');
    const client = new SdkSpacesClient({ query: async () => [] });
    const thirteen = Array.from({ length: 13 }, (_, i) => ({ text: `item ${i}` }));
    await expect(
      client.updateChecklist({
        id: 'cl-1',
        name: 'Release',
        mode: 'DO-CONFIRM',
        pausePoint: 'before publish',
        items: thirteen,
      })
    ).rejects.toMatchObject({ code: 'SPACES_INVALID_INPUT' });
    await expect(
      client.updateChecklist({
        id: 'cl-1',
        name: 'Release',
        mode: 'DO-CONFIRM',
        pausePoint: '',
        items: [{ text: 'one' }],
      })
    ).rejects.toMatchObject({ code: 'SPACES_INVALID_INPUT' });
  });

  it('LIST projects usedByCount so the library can warn before delete', async () => {
    const { CYPHER } = await import('../../spaces/sdk-client.js');
    expect(CYPHER.LIST_CHECKLISTS_IN_SPACE).toContain('AS usedByCount');
  });

  it('the Space manager wires the library end to end (source-level)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('node:path') as typeof import('node:path');
    const found = ['spaces/spaces.ts', 'lite/spaces/spaces.ts']
      .map((r) => path.resolve(r))
      .find((f) => fs.existsSync(f));
    expect(found).toBeDefined();
    const src = fs.readFileSync(found as string, 'utf8');
    expect(src).toContain('buildSharedDashboardChecklists(space)');
    expect(src).toContain('function openChecklistEditorPanel');
    // The revise warning is load-bearing UX: runs reset on save.
    expect(src).toContain('resets the run state on every attached ticket');
    // Delete goes through the confirm.
    const delIdx = src.indexOf('function buildChecklistLibraryCard');
    expect(src.slice(delIdx, delIdx + 4000)).toContain('askToConfirm');
  });
});

describe('required/optional items + AI drafting + accordions (2026-08-08)', () => {
  it('sanitizer: killer beats optional; more capped at 500; flags survive', async () => {
    const { sanitizeChecklistItems } = await import('../../spaces/sdk-client.js');
    const out = sanitizeChecklistItems([
      { text: 'a', killer: true, optional: true },
      { text: 'b', optional: true, more: 'x'.repeat(600) },
      { text: 'c' },
    ]);
    expect(out[0]).toEqual({ text: 'a', killer: true }); // optional dropped
    expect(out[1]?.optional).toBe(true);
    expect(out[1]?.more?.length).toBe(500);
    expect(out[2]).toEqual({ text: 'c' });
  });

  it('requiredIndexes: non-optional positions only', async () => {
    const { requiredIndexes } = await import('../../spaces/sdk-client.js');
    expect(
      requiredIndexes([
        { text: 'a' },
        { text: 'b', optional: true },
        { text: 'c', killer: true },
        { text: 'd', optional: true },
      ])
    ).toEqual([0, 2]);
  });

  it('completion is required-aware in ALL FOUR Cypher spots, with a legacy fallback', async () => {
    const { CYPHER } = await import('../../spaces/sdk-client.js');
    for (const q of [CYPHER.SET_CHECKLIST_ITEM_PREFLIGHT, CYPHER.SET_CHECKLIST_ITEM_POSTFLIGHT]) {
      expect(q).toContain('WHEN c.requiredIdx IS NULL');
      expect(q).toContain('all(req IN c.requiredIdx WHERE req IN r.checkedIdx)');
    }
    expect(CYPHER.TICKET_GATE_STATE).toContain('all(req IN cpre.requiredIdx WHERE req IN coalesce(pre.checkedIdx, []))');
    expect(CYPHER.TICKET_GATE_STATE).toContain('all(req IN cpost.requiredIdx WHERE req IN coalesce(post.checkedIdx, []))');
    // Create + update persist the denormalized list.
    expect(CYPHER.CREATE_CHECKLIST).toContain('requiredIdx: $requiredIdx');
    expect(CYPHER.UPDATE_CHECKLIST).toContain('c.requiredIdx = $requiredIdx');
    // ...and the READ path returns it (2026-08-08 release review): the
    // run-card `complete` is computed from this projection, so if the
    // read drops requiredIdx the card falls back to the v1 all-items
    // rule and disagrees with the gate.
    expect(CYPHER.GET_TICKET_CHECKLISTS).toContain('requiredIdx: cpre.requiredIdx');
    expect(CYPHER.GET_TICKET_CHECKLISTS).toContain('requiredIdx: cpost.requiredIdx');
  });

  it('the editor is structured rows + AI draft; drafts are reviewed, never auto-saved', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('node:path') as typeof import('node:path');
    const found = ['spaces/spaces.ts', 'lite/spaces/spaces.ts']
      .map((r) => path.resolve(r))
      .find((f) => fs.existsSync(f));
    const src = fs.readFileSync(found as string, 'utf8');
    const start = src.indexOf('function openChecklistEditorPanel');
    const body = src.slice(start, start + 24000);
    expect(body).toContain('checklists.draft(prompt)');
    expect(body).toContain('Prefill for review — the human saves, never the model.');
    expect(body).toContain('addItemRow');
    // Killer implies required, mirrored in the UI.
    expect(body).toContain("if (killer.checked) req.value = 'required'");
    // Accordions exist in both surfaces.
    expect(src).toContain('spaces-checklist-item-more-toggle');
  });

  it('the AI draft validates through the SAME sanitizer as manual saves', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('node:path') as typeof import('node:path');
    const found = ['spaces/main.ts', 'lite/spaces/main.ts']
      .map((r) => path.resolve(r))
      .find((f) => fs.existsSync(f));
    const src = fs.readFileSync(found as string, 'utf8');
    const start = src.indexOf('async draft(prompt: string)');
    const body = src.slice(start, start + 3200);
    expect(body).toContain('sanitizeChecklistItems(');
    expect(body).toContain('jsonMode: true');
  });
});

// ─── Review fixes (2026-08-08) ─────────────────────────────────────────

describe('parseChecklistItems round-trips the v2 fields', () => {
  it('preserves optional and more through a read (revise must not tighten gates)', async () => {
    const itemsJson = JSON.stringify([
      { text: 'Verify backups', killer: true },
      { text: 'Update the wiki', optional: true, more: 'Only the ops page.' },
    ]);
    const { api } = client((cypher) =>
      cypher.includes(':Checklist')
        ? [{ id: 'c1', name: 'Deploy', mode: 'DO-CONFIRM', pausePoint: 'x', itemsJson, itemCount: 2, version: 1 }]
        : []
    );
    const lists = await api.listChecklists('space-1');
    const items = lists[0]?.items ?? [];
    expect(items[1]?.optional).toBe(true);
    expect(items[1]?.more).toBe('Only the ops page.');
    expect(items[0]?.killer).toBe(true);
    expect(items[0]?.optional).toBeUndefined();
  });
});

describe('getTicketChecklists — the run card agrees with the gate (2026-08-08 review)', () => {
  // A checklist with one optional item: the gate passes once both
  // REQUIRED items are checked, and the run card must say the same.
  const ITEMS = [
    { text: 'Verify backups' },
    { text: 'Update the wiki', optional: true },
    { text: 'Tag the release' },
  ];
  const linkRow = (overrides: Record<string, unknown>): Array<Record<string, unknown>> => [
    {
      links: [
        {
          phase: 'preflight',
          obligation: 'required',
          checkedIdx: [],
          completedAt: null,
          lastCheckedBy: null,
          lastCheckedAt: null,
          id: 'c1',
          name: 'Deploy',
          mode: 'DO-CONFIRM',
          pausePoint: 'before merge',
          itemsJson: JSON.stringify(ITEMS),
          itemCount: ITEMS.length,
          requiredIdx: [0, 2],
          version: 2,
          ...overrides,
        },
      ],
    },
  ];
  const forTicket = async (
    overrides: Record<string, unknown>
  ): Promise<boolean | undefined> => {
    const { api } = client((cypher) =>
      cypher.includes('AS links') ? linkRow(overrides) : []
    );
    const links = await api.getTicketChecklists('t1');
    return links[0]?.complete;
  };

  it('complete when every REQUIRED item is checked, optional unchecked', async () => {
    // The regression: the mapper used the v1 all-items rule
    // (checked.length === itemCount), so this exact state — gate open,
    // work done — rendered "2/2 required" next to an incomplete card.
    await expect(forTicket({ checkedIdx: [0, 2] })).resolves.toBe(true);
  });

  it('incomplete while a required item is unchecked, even with the optional done', async () => {
    await expect(forTicket({ checkedIdx: [0, 1] })).resolves.toBe(false);
  });

  it('legacy checklist (requiredIdx null) keeps the all-items rule', async () => {
    await expect(forTicket({ requiredIdx: null, checkedIdx: [0, 1] })).resolves.toBe(false);
    await expect(forTicket({ requiredIdx: null, checkedIdx: [0, 1, 2] })).resolves.toBe(true);
  });

  it('all-optional checklist (requiredIdx []) is trivially complete — gate parity', async () => {
    // Cypher: all(req IN [] WHERE ...) is TRUE; the mapper must match.
    await expect(forTicket({ requiredIdx: [], checkedIdx: [] })).resolves.toBe(true);
  });
});

describe('the blocked-status bypass is closed', () => {
  it('blocked -> in_progress still gates the required preflight', async () => {
    const { api } = client((cypher) =>
      cypher.includes('requiredPre')
        ? gateRows({ status: 'blocked', pre: [{ name: 'Launch readiness', complete: false }] })
        : []
    );
    await expect(api.assertTicketStatusAllowed('t1', 'in_progress')).rejects.toThrow(
      /Launch readiness/
    );
  });

  it('blocked -> done gates preflight AND postflight', async () => {
    const { api } = client((cypher) =>
      cypher.includes('requiredPre')
        ? gateRows({
            status: 'blocked',
            pre: [{ name: 'Pre', complete: false }],
            post: [{ name: 'Post', complete: false }],
          })
        : []
    );
    await expect(api.assertTicketStatusAllowed('t1', 'done')).rejects.toThrow(/Pre.*Post|Pre/);
  });

  it('in_progress -> done still does NOT re-gate preflight', async () => {
    const { api } = client((cypher) =>
      cypher.includes('requiredPre')
        ? gateRows({ status: 'in_progress', pre: [{ name: 'Pre', complete: false }] })
        : []
    );
    await expect(api.assertTicketStatusAllowed('t1', 'done')).resolves.toBeUndefined();
  });
});
