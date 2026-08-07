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

// ─── 3. Query-shape guards (the visibility sweep also covers these) ──

describe('checklist Cypher carries the visibility predicates', () => {
  it('LIST_CHECKLISTS_IN_SPACE gates on the Space', () => {
    expect(CYPHER.LIST_CHECKLISTS_IN_SPACE).toContain("coalesce(s.visibility, 'open')");
  });

  it('GET_TICKET_CHECKLISTS and the gate read are asset-gated', () => {
    expect(CYPHER.GET_TICKET_CHECKLISTS).toContain('coalesce(vs.visibility');
    expect(CYPHER.TICKET_GATE_STATE).toContain('coalesce(vs.visibility');
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
