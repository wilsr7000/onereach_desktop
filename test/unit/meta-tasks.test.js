/**
 * Meta-tasks — the "meta-work is a first-class task" foundation.
 * See docs/internal/EXCHANGE-DECISIONS.md.
 *
 * Run: npx vitest run test/unit/meta-tasks.test.js
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const meta = require('../../lib/exchange/meta-tasks');
const { META_TASK_KINDS, registerMetaHandler, runMetaTask, listMetaTasks, hasMetaHandler } = meta;

const NOW = 1_000_000_000_000;

beforeEach(() => meta._reset());

describe('meta-task registration', () => {
  it('registers a handler for a known kind', () => {
    registerMetaHandler(META_TASK_KINDS.CLASSIFY_INTENT, async () => ({}));
    expect(hasMetaHandler(META_TASK_KINDS.CLASSIFY_INTENT)).toBe(true);
  });

  it('rejects an unknown kind', () => {
    expect(() => registerMetaHandler('not-a-kind', async () => {})).toThrow(/Unknown meta-task kind/);
  });

  it('rejects a non-function handler', () => {
    expect(() => registerMetaHandler(META_TASK_KINDS.DISAMBIGUATE, 42)).toThrow(/must be a function/);
  });
});

describe('runMetaTask direct-assign', () => {
  it('records + settles a handled meta-task and returns its result', async () => {
    registerMetaHandler(META_TASK_KINDS.CLASSIFY_INTENT, async (p) => ({ intent: p.text.toUpperCase() }));
    const out = await runMetaTask(META_TASK_KINDS.CLASSIFY_INTENT, { text: 'daily brief' }, { now: () => NOW });
    expect(out.status).toBe('settled');
    expect(out.result).toEqual({ intent: 'DAILY BRIEF' });
    expect(out.createdAt).toBe(NOW);
    expect(out.settledAt).toBe(NOW);
  });

  it('passes ctx (id, kind, now) to the handler', async () => {
    let seen;
    registerMetaHandler(META_TASK_KINDS.EVALUATE_RESPONSE, async (_p, ctx) => { seen = ctx; return 'ok'; });
    await runMetaTask(META_TASK_KINDS.EVALUATE_RESPONSE, {}, { now: () => NOW });
    expect(seen.kind).toBe(META_TASK_KINDS.EVALUATE_RESPONSE);
    expect(seen.id).toMatch(/^meta_evaluate-response_/);
  });

  it('settles as unhandled (does NOT throw) when no handler is registered', async () => {
    const out = await runMetaTask(META_TASK_KINDS.DISAMBIGUATE, { text: 'x' }, { now: () => NOW });
    expect(out.status).toBe('unhandled');
    expect(out.result).toBeNull();
    expect(out.error).toMatch(/No meta-handler/);
  });

  it('settles as failed (does NOT throw) when the handler throws', async () => {
    registerMetaHandler(META_TASK_KINDS.CLASSIFY_INTENT, async () => { throw new Error('llm down'); });
    const out = await runMetaTask(META_TASK_KINDS.CLASSIFY_INTENT, {}, { now: () => NOW });
    expect(out.status).toBe('failed');
    expect(out.error).toBe('llm down');
    expect(out.result).toBeNull();
  });

  it('invokes observability hooks (onRecord + log)', async () => {
    const onRecord = vi.fn();
    const log = vi.fn();
    registerMetaHandler(META_TASK_KINDS.CLASSIFY_INTENT, async () => 'r');
    await runMetaTask(META_TASK_KINDS.CLASSIFY_INTENT, {}, { now: () => NOW, onRecord, log });
    expect(onRecord).toHaveBeenCalledWith(expect.objectContaining({ status: 'settled' }));
    expect(log).toHaveBeenCalled();
  });

  it('records every run in the ledger (observable + prunable)', async () => {
    registerMetaHandler(META_TASK_KINDS.CLASSIFY_INTENT, async () => 'a');
    await runMetaTask(META_TASK_KINDS.CLASSIFY_INTENT, {}, { now: () => NOW });
    await runMetaTask(META_TASK_KINDS.CLASSIFY_INTENT, {}, { now: () => NOW });
    const ledger = listMetaTasks();
    expect(ledger.length).toBe(2);
    expect(ledger.every((r) => r.kind === META_TASK_KINDS.CLASSIFY_INTENT)).toBe(true);
  });
});
