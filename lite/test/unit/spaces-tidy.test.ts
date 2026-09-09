/**
 * ADR-099 — the groomer. The pure core (`tidy.ts`): what the model is
 * shown, how its answer is checked against the rules, how an accepted
 * move maps onto the API; and the engine (`tidy-engine.ts`) with fake
 * deps: plan → decide → apply, decision memory, the cadence.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TIDY_SETTINGS,
  MAX_TIDY_MOVES,
  applyOrder,
  applyTidyMove,
  buildTidyPrompt,
  describeMove,
  extractJsonObject,
  moveKey,
  nameOverlaps,
  normalizeTidySettings,
  parseTidyPlan,
  shouldRunScheduled,
  topLevelCount,
  type TidyApplyPorts,
  type TidyMove,
} from '../../spaces/tidy.js';
import { TidyEngine, type TidyEngineDeps } from '../../spaces/tidy-engine.js';
import type { TidySpaceEvidence } from '../../spaces/types.js';

function space(over: Partial<TidySpaceEvidence> & { id: string; name: string }): TidySpaceEvidence {
  return {
    description: '',
    kind: 'user',
    source: '',
    gsxBotId: '',
    createdBy: 'robb@onereach.com',
    createdAt: '2026-09-01T00:00:00.000Z',
    archived: false,
    itemCount: 0,
    lastActivity: '',
    items: [],
    members: [],
    memberCount: 0,
    parentIds: [],
    writable: true,
    ...over,
  };
}

const EVIDENCE: TidySpaceEvidence[] = [
  space({ id: 'pay', name: 'Payments Ops', itemCount: 12, items: [{ title: 'Refund policy', kind: 'doc', tags: ['policy'] }] }),
  space({ id: 'pay2', name: 'payments-ops', itemCount: 3, members: ['rich@onereach.com'] }),
  space({ id: 'idle', name: 'test 2 space', itemCount: 0, lastActivity: '2026-04-01T00:00:00.000Z' }),
  space({ id: 'grp', name: 'GSX Designer', source: 'lite-group' }),
  space({ id: 'mirror', name: 'Tickets', source: 'gsx-designer', gsxBotId: 'b1', parentIds: ['grp'] }),
  space({ id: 'theirs', name: 'Rich only', createdBy: 'rich@onereach.com', writable: false }),
  space({ id: 'old', name: 'Old plan', archived: true }),
];

describe('topLevelCount', () => {
  it('counts live rows with no visible parent', () => {
    expect(topLevelCount(EVIDENCE)).toBe(5); // pay, pay2, idle, grp, theirs — mirror sits in grp, old is archived
  });
  it('a parent the viewer cannot see makes the child top-level', () => {
    expect(topLevelCount([space({ id: 'a', name: 'A', parentIds: ['unseen'] })])).toBe(1);
  });
});

describe('nameOverlaps', () => {
  it('pairs names that share words or contain each other', () => {
    const pairs = nameOverlaps(EVIDENCE);
    expect(pairs.some((p) => (p.a === 'pay' && p.b === 'pay2') || (p.a === 'pay2' && p.b === 'pay'))).toBe(true);
    expect(pairs.some((p) => p.a === 'grp' || p.b === 'grp')).toBe(false);
  });
});

describe('moveKey', () => {
  it('is stable and ignores child order', () => {
    expect(moveKey({ kind: 'create-parent', childIds: ['b', 'a'], name: 'X' })).toBe(moveKey({ kind: 'create-parent', childIds: ['a', 'b'], name: 'Y' }));
    expect(moveKey({ kind: 'nest', spaceId: 'a', parentId: 'b' })).not.toBe(moveKey({ kind: 'nest', spaceId: 'b', parentId: 'a' }));
    expect(moveKey({ kind: 'rename', spaceId: 'a', name: ' New ' })).toBe(moveKey({ kind: 'rename', spaceId: 'a', name: 'new' }));
  });
});

describe('buildTidyPrompt', () => {
  it('shows the model the evidence, the overlaps, the rejections and the rules', () => {
    const { system, user } = buildTidyPrompt({ evidence: EVIDENCE, rejected: ['Archive "test 2 space"'], viewerId: 'robb@onereach.com', now: new Date('2026-09-09T12:00:00Z') });
    expect(system).toContain('Never propose anything that changes who can see or edit');
    expect(system).toContain(`At most ${MAX_TIDY_MOVES}`);
    const payload = JSON.parse(user) as { spaces: Array<{ id: string; writable: boolean; sample: string[] }>; previouslyRejected: string[]; nameOverlaps: unknown[]; topLevelRows: number };
    expect(payload.spaces.map((s) => s.id)).toContain('pay');
    expect(payload.spaces.find((s) => s.id === 'theirs')?.writable).toBe(false);
    // People never cross to the provider by name: the same person is the
    // same label everywhere, the viewer is "viewer", and no email survives.
    expect(user).not.toContain('@');
    const pay2 = payload.spaces.find((s) => s.id === 'pay2') as unknown as { members: string[]; createdBy: string };
    expect(pay2.members).toEqual(['person-2']);
    expect(pay2.createdBy).toBe('viewer');
    expect((payload.spaces.find((s) => s.id === 'theirs') as unknown as { createdBy: string }).createdBy).toBe('person-2');
    expect(payload.spaces.find((s) => s.id === 'pay')?.sample[0]).toBe('Refund policy [doc; policy]');
    expect(payload.previouslyRejected).toEqual(['Archive "test 2 space"']);
    expect(payload.nameOverlaps.length).toBeGreaterThan(0);
    expect(payload.topLevelRows).toBe(5);
  });
});

describe('extractJsonObject', () => {
  it('reads a fenced or prose-wrapped object', () => {
    expect(extractJsonObject('Here you go:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('sure {"a":[1,2]} done')).toEqual({ a: [1, 2] });
    expect(extractJsonObject('nope')).toBeNull();
  });
});

describe('parseTidyPlan', () => {
  const ctx = { evidence: EVIDENCE, rejectedKeys: new Set<string>() };

  it('keeps well-formed moves and fills names from the evidence', () => {
    const raw = JSON.stringify({
      summary: 'Two payments Spaces and an idle test Space.',
      moves: [
        { kind: 'merge', spaceId: 'pay2', targetId: 'pay', reason: 'Same team, same work.', evidence: ['payments-ops', 'Payments Ops'], confidence: 0.8 },
        { kind: 'archive', spaceId: 'idle', reason: 'Empty since April.', evidence: [], confidence: 0.9 },
        { kind: 'rename', spaceId: 'idle', name: 'Scratch', reason: 'Nobody named it.', confidence: 0.4 },
        { kind: 'create-parent', name: 'Payments', childIds: ['pay', 'pay2'], reason: 'One theme.', confidence: 0.6 },
      ],
    });
    const plan = parseTidyPlan(raw, ctx);
    expect(plan.summary).toContain('payments');
    expect(plan.moves.map((m) => m.kind)).toEqual(['merge', 'archive', 'rename', 'create-parent']);
    const merge = plan.moves[0]!;
    expect(merge).toMatchObject({ spaceName: 'payments-ops', targetName: 'Payments Ops', membersNotInTarget: ['rich@onereach.com'] });
    expect(merge.key).toBe('merge:pay2>pay');
    expect(plan.moves[3]).toMatchObject({ childNames: ['Payments Ops', 'payments-ops'] });
    expect(plan.dropped).toEqual([]);
  });

  it('drops what the rules forbid, with a reason each', () => {
    const raw = JSON.stringify({
      moves: [
        { kind: 'archive', spaceId: 'theirs', reason: 'x', confidence: 1 }, // not writable
        { kind: 'archive', spaceId: 'nope', reason: 'x' }, // unknown
        { kind: 'archive', spaceId: 'grp', reason: 'x' }, // a group the app keeps
        { kind: 'archive', spaceId: 'old', reason: 'x' }, // already archived
        { kind: 'rename', spaceId: 'old', name: 'Older', reason: 'x' }, // archived: only unnest may touch it
        { kind: 'nest', spaceId: 'old', parentId: 'pay', reason: 'x' }, // archived child
        { kind: 'nest', spaceId: 'grp', parentId: 'mirror', reason: 'x' }, // cycle: mirror is inside grp
        { kind: 'nest', spaceId: 'mirror', parentId: 'grp', reason: 'x' }, // already inside
        { kind: 'unnest', spaceId: 'pay', parentId: 'grp', reason: 'x' }, // not inside
        { kind: 'merge', spaceId: 'pay', targetId: 'pay', reason: 'x' }, // itself
        { kind: 'rename', spaceId: 'pay', name: 'payments ops', reason: 'x' }, // same name
        { kind: 'create-parent', name: 'Payments Ops', childIds: ['pay', 'pay2'], reason: 'x' }, // name exists
        { kind: 'create-parent', name: 'Solo', childIds: ['pay'], reason: 'x' }, // one child
        { kind: 'share', spaceId: 'pay', reason: 'x' }, // not a move
        { kind: 'archive', spaceId: 'idle' }, // no reason
      ],
    });
    const plan = parseTidyPlan(raw, ctx);
    expect(plan.moves).toEqual([]);
    expect(plan.dropped).toHaveLength(15);
    expect(plan.dropped.join('\n')).toMatch(/not writable/);
    expect(plan.dropped.join('\n')).toMatch(/cycle/);
    expect(plan.dropped.join('\n')).toMatch(/group the app keeps/);
  });

  it('never raises a move the person rejected, dedupes, and caps the count', () => {
    const rejected = new Set([moveKey({ kind: 'archive', spaceId: 'idle' })]);
    const moves = Array.from({ length: 40 }, (_, i) => ({ kind: 'rename', spaceId: 'pay', name: `Name ${i}`, reason: 'r', confidence: 0.5 }));
    const raw = JSON.stringify({
      moves: [
        { kind: 'archive', spaceId: 'idle', reason: 'again', confidence: 0.9 },
        { kind: 'nest', spaceId: 'pay2', parentId: 'pay', reason: 'r' },
        { kind: 'nest', spaceId: 'pay2', parentId: 'pay', reason: 'r' },
        ...moves,
      ],
    });
    const plan = parseTidyPlan(raw, { evidence: EVIDENCE, rejectedKeys: rejected });
    expect(plan.moves.some((m) => m.kind === 'archive')).toBe(false);
    expect(plan.moves.filter((m) => m.kind === 'nest')).toHaveLength(1);
    expect(plan.moves.length).toBe(MAX_TIDY_MOVES);
    expect(plan.dropped.join('\n')).toMatch(/previously rejected/);
    expect(plan.dropped.join('\n')).toMatch(/duplicate/);
  });

  it('a non-JSON answer yields no moves, not a crash', () => {
    expect(parseTidyPlan('I would rather not.', ctx)).toEqual({ summary: '', moves: [], dropped: ['answer was not a JSON object'] });
  });
});

describe('applyOrder + applyTidyMove', () => {
  const calls: string[] = [];
  const ports: TidyApplyPorts = {
    nest: async (c, p) => void calls.push(`nest ${c} ${p}`),
    unnest: async (c, p) => void calls.push(`unnest ${c} ${p}`),
    archive: async (id, reason) => void calls.push(`archive ${id} ${reason}`),
    rename: async (id, name) => void calls.push(`rename ${id} ${name}`),
    createSpace: async (name) => {
      calls.push(`create ${name}`);
      return 'new-parent';
    },
    listItemIds: async (id) => (id === 'pay2' ? ['i1', 'i2'] : []),
    moveItem: async (item, from, to) => void calls.push(`move ${item} ${from} ${to}`),
  };
  const mk = (over: Partial<TidyMove> & { kind: TidyMove['kind'] }): TidyMove => ({ key: '', reason: 'r', evidence: [], confidence: 0.5, decision: 'accepted', ...over });

  it('orders structure before names before containment before merges before archives', () => {
    const ordered = applyOrder([mk({ kind: 'archive' }), mk({ kind: 'merge' }), mk({ kind: 'nest' }), mk({ kind: 'rename' }), mk({ kind: 'create-parent' }), mk({ kind: 'unnest' })]);
    expect(ordered.map((m) => m.kind)).toEqual(['create-parent', 'rename', 'unnest', 'nest', 'merge', 'archive']);
  });

  it('a merge moves every item then archives the source with a pointer; a new parent nests its children', async () => {
    calls.length = 0;
    await applyTidyMove(mk({ kind: 'merge', spaceId: 'pay2', targetId: 'pay' }), ports);
    await applyTidyMove(mk({ kind: 'create-parent', name: 'Payments', childIds: ['pay', 'pay2'], childNames: ['Payments Ops', 'payments-ops'] }), ports);
    await applyTidyMove(mk({ kind: 'rename', spaceId: 'idle', name: 'Scratch' }), ports);
    expect(calls).toEqual([
      'move i1 pay2 pay',
      'move i2 pay2 pay',
      'archive pay2 merged-into:pay',
      'create Payments',
      'nest pay new-parent',
      'nest pay2 new-parent',
      'rename idle Scratch',
    ]);
  });

  it('describes a move in the person\'s words', () => {
    expect(describeMove(mk({ kind: 'merge', spaceId: 'pay2', spaceName: 'payments-ops', targetId: 'pay', targetName: 'Payments Ops' }))).toBe('Merge "payments-ops" into "Payments Ops"');
    expect(describeMove(mk({ kind: 'create-parent', name: 'Payments', childNames: ['A', 'B'] }))).toBe('Create "Payments" and put "A", "B" inside');
  });
});

describe('the cadence', () => {
  const settings = { ...DEFAULT_TIDY_SETTINGS };
  const now = new Date('2026-09-09T12:00:00Z');
  it('runs when never run, after the cadence, or a day after the top level passes the threshold', () => {
    expect(shouldRunScheduled({ settings, lastRunAt: null, now, topLevel: 5, spaceCount: 10 })).toBe(true);
    expect(shouldRunScheduled({ settings, lastRunAt: '2026-09-08T12:00:00Z', now, topLevel: 5, spaceCount: 10 })).toBe(false);
    expect(shouldRunScheduled({ settings, lastRunAt: '2026-09-01T12:00:00Z', now, topLevel: 5, spaceCount: 10 })).toBe(true);
    expect(shouldRunScheduled({ settings, lastRunAt: '2026-09-08T11:00:00Z', now, topLevel: 30, spaceCount: 40 })).toBe(true);
    expect(shouldRunScheduled({ settings, lastRunAt: '2026-09-09T06:00:00Z', now, topLevel: 30, spaceCount: 40 })).toBe(false);
  });
  it('stays quiet for a handful of Spaces', () => {
    expect(shouldRunScheduled({ settings, lastRunAt: null, now, topLevel: 3, spaceCount: 3 })).toBe(false);
  });
  it('normalizes settings within bounds', () => {
    expect(normalizeTidySettings({ cadenceDays: 0, topLevelThreshold: 9999, profile: 'fast' })).toEqual({ cadenceDays: 1, topLevelThreshold: 500, profile: 'powerful' });
    expect(normalizeTidySettings(null)).toEqual(DEFAULT_TIDY_SETTINGS);
  });
});

describe('TidyEngine', () => {
  function makeEngine(answer: () => string): { engine: TidyEngine; calls: string[]; broadcasts: number; chats: Array<{ system: string; user: string }> } {
    const calls: string[] = [];
    const chats: Array<{ system: string; user: string }> = [];
    const stats = { broadcasts: 0 };
    const deps: TidyEngineDeps = {
      configDir: null,
      evidence: async () => EVIDENCE,
      chat: async (input) => {
        chats.push({ system: input.system, user: input.messages[0]?.content ?? '' });
        return { content: answer(), model: 'claude-fable-5-1', provider: 'claude' };
      },
      ports: {
        nest: async (c, p) => void calls.push(`nest ${c} ${p}`),
        unnest: async () => undefined,
        archive: async (id, reason) => {
          if (id === 'idle') throw new Error('graph said no');
          calls.push(`archive ${id} ${reason}`);
        },
        rename: async (id, name) => void calls.push(`rename ${id} ${name}`),
        createSpace: async () => 'p',
        listItemIds: async () => [],
        moveItem: async () => undefined,
      },
      viewerId: () => 'robb@onereach.com',
      log: { info: () => undefined, warn: () => undefined },
      broadcast: () => {
        stats.broadcasts += 1;
      },
      now: () => new Date('2026-09-09T12:00:00Z'),
    };
    const engine = new TidyEngine(deps);
    return {
      engine,
      calls,
      chats,
      get broadcasts() {
        return stats.broadcasts;
      },
    };
  }
  const answer = JSON.stringify({
    summary: 'Tidy.',
    moves: [
      { kind: 'nest', spaceId: 'pay2', parentId: 'pay', reason: 'r', confidence: 0.7 },
      { kind: 'archive', spaceId: 'idle', reason: 'r', confidence: 0.9 },
    ],
  });

  it('plans, records decisions, applies only accepted moves, and keeps failures on the move', async () => {
    const h = makeEngine(() => answer);
    expect(h.engine.state()).toMatchObject({ plan: null, pending: 0, running: false, lastRunAt: null });
    const planned = await h.engine.plan('manual');
    expect(planned.plan?.moves).toHaveLength(2);
    expect(planned.pending).toBe(2);
    expect(planned.lastRunAt).toBe('2026-09-09T12:00:00.000Z');
    expect(planned.plan?.model).toBe('claude-fable-5-1');
    // Nothing applied on its own.
    expect(h.calls).toEqual([]);
    h.engine.decide('nest:pay2>pay', 'accepted');
    h.engine.decide('archive:idle', 'accepted');
    const applied = await h.engine.apply();
    expect(h.calls).toEqual(['nest pay2 pay']);
    const moves = applied.plan?.moves ?? [];
    expect(moves.find((m) => m.kind === 'nest')?.applied).toBe(true);
    expect(moves.find((m) => m.kind === 'archive')?.error).toBe('graph said no');
    expect(applied.pending).toBe(0);
    expect(h.broadcasts).toBeGreaterThan(0);
  });

  it('a rejected move is told to the model next time and dropped if it comes back', async () => {
    const h = makeEngine(() => answer);
    await h.engine.plan('manual');
    h.engine.decide('archive:idle', 'rejected');
    const second = await h.engine.plan('manual');
    const payload = JSON.parse(h.chats[1]?.user ?? '{}') as { previouslyRejected: string[] };
    expect(payload.previouslyRejected).toEqual(['Archive "test 2 space"']);
    expect(second.plan?.moves.map((m) => m.kind)).toEqual(['nest']);
  });

  it('an applied move never comes back; an accepted-but-unapplied or undecided one does', async () => {
    const h = makeEngine(() => answer);
    await h.engine.plan('manual');
    h.engine.decide('nest:pay2>pay', 'accepted');
    h.engine.decide('archive:idle', 'accepted'); // will fail to apply (graph said no)
    await h.engine.apply();
    const second = await h.engine.plan('manual');
    expect(second.plan?.moves.map((m) => m.key)).toEqual(['archive:idle']);
  });

  it('one apply at a time; a plan requested mid-apply waits for it', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = makeEngine(() => answer);
    h.engine.state();
    (h.engine as unknown as { deps: TidyEngineDeps }).deps.ports.nest = async () => {
      await gate;
      h.calls.push('nest');
    };
    await h.engine.plan('manual');
    h.engine.decide('nest:pay2>pay', 'accepted');
    const first = h.engine.apply();
    const second = h.engine.apply();
    const planned = h.engine.plan('manual');
    expect(second).toBe(first);
    expect(planned).toBe(first);
    release();
    await first;
    expect(h.calls.filter((c) => c === 'nest')).toHaveLength(1);
  });

  it('the store belongs to one person: a different signed-in person starts clean, settings stay', async () => {
    const h = makeEngine(() => answer);
    h.engine.settings({ cadenceDays: 3 });
    await h.engine.plan('manual');
    expect(h.engine.state().plan?.moves).toHaveLength(2);
    const deps = (h.engine as unknown as { deps: TidyEngineDeps }).deps;
    deps.viewerId = () => 'rich@onereach.com';
    const fresh = h.engine.state();
    expect(fresh.plan).toBeNull();
    expect(fresh.pending).toBe(0);
    expect(fresh.settings.cadenceDays).toBe(3);
    deps.viewerId = () => null;
    expect(h.engine.state().plan).toBeNull();
  });

  it('signed out: no plan, a plain message', async () => {
    const h = makeEngine(() => answer);
    (h.engine as unknown as { deps: TidyEngineDeps }).deps.viewerId = () => null;
    const state = await h.engine.plan('scheduled');
    expect(state.plan).toBeNull();
    expect(state.error).toMatch(/Sign in/);
  });

  it('a model failure lands in state.error, the plan stays what it was', async () => {
    let fail = false;
    const h = makeEngine(() => {
      if (fail) throw new Error('rate limited');
      return answer;
    });
    await h.engine.plan('manual');
    fail = true;
    const state = await h.engine.plan('manual');
    expect(state.error).toBe('Could not prepare a plan: rate limited');
    expect(state.plan?.moves).toHaveLength(2);
    expect(state.running).toBe(false);
  });
});
