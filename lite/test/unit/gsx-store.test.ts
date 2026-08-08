/**
 * GSX store tests -- the full evaluation feedback loop with fakes
 * (ADR-052): run -> grade -> repair -> learned promotion -> demotion,
 * plus stats, run history, and JSON persistence.
 *
 * Everything is injected (window port, chat, clock, persist dir), so
 * this exercises the real orchestration code with zero Electron and
 * zero network.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GsxStore, type GsxWindowPort } from '../../gsx/store.js';
import { SNAPSHOT_SCRIPT, type GsxExecutor } from '../../gsx/runner.js';
import {
  RECORDER_DRAIN_SCRIPT,
  RECORDER_INSTALL_SCRIPT,
} from '../../gsx/recorder.js';
import type { GsxScript } from '../../gsx/types.js';
import { GSX_ERROR_CODES } from '../../gsx/errors.js';
import { GSX_EVENTS } from '../../gsx/events.js';
import type { GsxChatFn } from '../../gsx/repair.js';

type ExecResult = { ok: boolean; detail?: string } | Error;

interface Fixture {
  store: GsxStore;
  events: Array<{ name: string; data?: unknown }>;
  /** Push results for non-snapshot exec calls (FIFO; default ok). */
  execQueue: ExecResult[];
  /** Batches returned by successive recorder drains (FIFO; default []). */
  drainQueue: unknown[][];
  navigations: string[];
}

function makeFixture(opts?: {
  chat?: GsxChatFn | null;
  persistDir?: string | null;
  publishAgent?: (input: {
    name: string;
    title: string;
    description: string;
    okf: string;
  }) => Promise<{ itemId: string } | null>;
}): Fixture {
  const events: Array<{ name: string; data?: unknown }> = [];
  const execQueue: ExecResult[] = [];
  const drainQueue: unknown[][] = [];
  const navigations: string[] = [];
  const executor: GsxExecutor = {
    async exec(js: string): Promise<unknown> {
      if (js === RECORDER_INSTALL_SCRIPT) return { installed: true };
      if (js === RECORDER_DRAIN_SCRIPT) return drainQueue.shift() ?? [];
      if (js === SNAPSHOT_SCRIPT) {
        return {
          url: 'https://studio.edison.onereach.ai/flows',
          title: 'Flows',
          elements: [
            { ref: 0, tag: 'div', text: '', attrs: { 'data-testid': 'flows-root' } },
          ],
        };
      }
      const next = execQueue.shift() ?? { ok: true };
      if (next instanceof Error) throw next;
      return next;
    },
    async navigate(url: string): Promise<void> {
      navigations.push(url);
    },
    currentUrl: () => 'https://studio.edison.onereach.ai/flows',
  };
  const windows = new Map<string, { windowId: string; env: 'edison'; url: string; title: string }>();
  let counter = 0;
  const port: GsxWindowPort = {
    async open(o) {
      const windowId = `w${++counter}`;
      const info = { windowId, env: o.env as 'edison', url: o.url, title: o.title ?? 'GSX' };
      windows.set(windowId, info);
      return info;
    },
    close(windowId) {
      return windows.delete(windowId);
    },
    list: () => [...windows.values()],
    info: (windowId) => windows.get(windowId) ?? null,
    navigate: async () => undefined,
    executor: () => executor,
  };
  const store = new GsxStore({
    logger: () => undefined,
    eventEmitter: (name, data) => {
      events.push({ name, data });
    },
    windowPort: () => port,
    chat: () => (opts?.chat === undefined ? null : opts.chat),
    accountId: () => 'acc-1',
    persistDir: () => opts?.persistDir ?? null,
    uuid: () => `uuid-${Math.random().toString(36).slice(2, 10)}`,
    // Keep the interval effectively dormant -- tests rely on the final
    // drain stopRecording performs, not on wall-clock polling.
    recordPollMs: 60_000,
    ...(opts?.publishAgent !== undefined ? { publishAgent: opts.publishAgent } : {}),
  });
  return { store, events, execQueue, drainQueue, navigations };
}

/** A minimal one-step custom script (a single waitFor). */
function customScript(overrides?: Partial<GsxScript>): GsxScript {
  return {
    id: 'test.custom',
    title: 'Custom',
    description: 'One waitFor step',
    version: 1,
    source: 'learned',
    steps: [{ kind: 'waitFor', selector: '#app' }],
    ...overrides,
  };
}

/** A chat fake that returns a fixed repaired steps array. */
function chatReturning(steps: unknown): GsxChatFn {
  return async () => ({
    content: JSON.stringify({ steps, note: 'test repair' }),
    usage: { inputTokens: 1, outputTokens: 1 },
    model: 'claude-fable-5',
    provider: 'claude',
    cost: 0,
  });
}

let tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsx-store-test-'));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  tmpDirs = [];
});
afterEach(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('GsxStore run + grade', () => {
  it('a passing run records pass, updates stats, opens a window on demand', async () => {
    const f = makeFixture();
    await f.store.saveScript(customScript());
    const run = await f.store.runScript({ scriptId: 'test.custom' });
    expect(run.verdict).toBe('pass');
    expect(run.windowId).toBe('w1');
    expect(run.params.accountId).toBe('acc-1');
    const [stats] = await f.store.getStats('test.custom');
    expect(stats).toMatchObject({ runs: 1, passes: 1, failures: 0, consecutiveFailures: 0 });
    const runs = await f.store.listRuns('test.custom');
    expect(runs).toHaveLength(1);
    await expect(f.store.getRun(run.runId)).resolves.toMatchObject({ verdict: 'pass' });
    const verdictEvents = f.events.filter((e) => e.name === GSX_EVENTS.RUN_VERDICT);
    expect(verdictEvents).toHaveLength(1);
  });

  it('repair disabled: a failing run stays fail with no repair summary', async () => {
    const f = makeFixture();
    await f.store.saveScript(customScript());
    f.execQueue.push({ ok: false, detail: 'timeout' });
    const run = await f.store.runScript({ scriptId: 'test.custom', repair: false });
    expect(run.verdict).toBe('fail');
    expect(run.repair).toBeUndefined();
    expect(run.failure).toContain('timeout');
  });

  it('AI unavailable: repair is skipped and recorded, verdict stays fail', async () => {
    const f = makeFixture({ chat: null });
    await f.store.saveScript(customScript());
    f.execQueue.push({ ok: false, detail: 'timeout' });
    const run = await f.store.runScript({ scriptId: 'test.custom' });
    expect(run.verdict).toBe('fail');
    expect(run.repair).toMatchObject({ attempted: false, skippedReason: 'ai-not-configured' });
  });
});

describe('GsxStore repair promotion', () => {
  it('a passing repaired run promotes a learned v2 and grades repaired-pass', async () => {
    const f = makeFixture({
      chat: chatReturning([{ kind: 'waitFor', selector: '[data-testid="flows-root"]' }]),
    });
    await f.store.saveScript(customScript());
    // Original run fails; the repaired re-run (default ok) passes.
    f.execQueue.push({ ok: false, detail: 'timeout waiting for #app' });
    const run = await f.store.runScript({ scriptId: 'test.custom' });
    expect(run.verdict).toBe('repaired-pass');
    expect(run.repair).toMatchObject({ attempted: true, learnedVersion: 2 });
    const effective = await f.store.getScript('test.custom');
    expect(effective.version).toBe(2);
    expect(effective.steps[0]).toMatchObject({ selector: '[data-testid="flows-root"]' });
    expect(f.events.some((e) => e.name === GSX_EVENTS.SCRIPT_LEARNED)).toBe(true);
    // The promoted variant replays deterministically: next run passes
    // without any queued failure (and without a chat fake being hit).
    const second = await f.store.runScript({ scriptId: 'test.custom' });
    expect(second.verdict).toBe('pass');
    expect(second.scriptVersion).toBe(2);
  });

  it('a failing repaired run grades repaired-fail and promotes nothing', async () => {
    const f = makeFixture({
      chat: chatReturning([{ kind: 'waitFor', selector: '#still-wrong' }]),
    });
    await f.store.saveScript(customScript());
    f.execQueue.push({ ok: false, detail: 'timeout' }); // original run
    f.execQueue.push({ ok: false, detail: 'still timeout' }); // repaired re-run
    const run = await f.store.runScript({ scriptId: 'test.custom' });
    expect(run.verdict).toBe('repaired-fail');
    expect(run.repair?.learnedVersion).toBeUndefined();
    const effective = await f.store.getScript('test.custom');
    expect(effective.version).toBe(1);
  });

  it('a chat/model failure lands in repair.skippedReason, never throws', async () => {
    const f = makeFixture({
      chat: async () => {
        throw new Error('rate limited');
      },
    });
    await f.store.saveScript(customScript());
    f.execQueue.push({ ok: false, detail: 'timeout' });
    const run = await f.store.runScript({ scriptId: 'test.custom' });
    expect(run.verdict).toBe('fail');
    expect(run.repair).toMatchObject({ attempted: true, skippedReason: 'rate limited' });
  });
});

describe('GsxStore learned invalidation', () => {
  it('a learned variant shadowing a seed is demoted after 3 consecutive failures', async () => {
    const f = makeFixture();
    // Shadow the real seed id with a one-step learned variant.
    await f.store.saveScript(
      customScript({ id: 'flows.list', version: 2, steps: [{ kind: 'waitFor', selector: '#x' }] })
    );
    for (let i = 0; i < 3; i++) {
      f.execQueue.push({ ok: false, detail: `fail ${i}` });
      const run = await f.store.runScript({ scriptId: 'flows.list', repair: false });
      expect(run.scriptVersion).toBe(2);
      expect(run.verdict).toBe('fail');
    }
    // Demoted: effective script is the seed again.
    const effective = await f.store.getScript('flows.list');
    expect(effective.source).toBe('seed');
    expect(effective.version).toBe(1);
    expect(f.events.some((e) => e.name === GSX_EVENTS.SCRIPT_INVALIDATED)).toBe(true);
    const [stats] = await f.store.getStats('flows.list');
    expect(stats?.lastInvalidatedAt).toBeDefined();
    expect(stats?.consecutiveFailures).toBe(0); // fresh slate for the seed
  });

  it('a custom script (no seed floor) is never auto-deleted', async () => {
    const f = makeFixture();
    await f.store.saveScript(customScript());
    for (let i = 0; i < 4; i++) {
      f.execQueue.push({ ok: false, detail: 'nope' });
      await f.store.runScript({ scriptId: 'test.custom', repair: false });
    }
    const still = await f.store.getScript('test.custom');
    expect(still.version).toBe(1);
    expect(f.events.some((e) => e.name === GSX_EVENTS.SCRIPT_INVALIDATED)).toBe(false);
  });
});

describe('GsxStore persistence', () => {
  it('learned scripts, stats, and runs survive a store restart', async () => {
    const dir = tmpDir();
    const a = makeFixture({
      persistDir: dir,
      chat: chatReturning([{ kind: 'waitFor', selector: '#fixed' }]),
    });
    await a.store.saveScript(customScript());
    a.execQueue.push({ ok: false, detail: 'timeout' });
    const run = await a.store.runScript({ scriptId: 'test.custom' });
    expect(run.verdict).toBe('repaired-pass');

    const b = makeFixture({ persistDir: dir });
    const effective = await b.store.getScript('test.custom');
    expect(effective.version).toBe(2);
    const runs = await b.store.listRuns('test.custom');
    expect(runs).toHaveLength(1);
    const [stats] = await b.store.getStats('test.custom');
    expect(stats?.runs).toBe(1);
  });

  it('a corrupt persisted file soft-fails to a clean slate', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'gsx-automation.json'), '{corrupt', 'utf-8');
    const f = makeFixture({ persistDir: dir });
    const scripts = await f.store.listScripts();
    expect(scripts.length).toBeGreaterThan(0); // seeds still there
  });
});

describe('GsxStore teach mode', () => {
  const RECORDED_CLICK = {
    type: 'click',
    candidates: ['[data-testid="flow-row"]'],
    text: 'Billing Bot',
    label: 'Flow name',
    tag: 'li',
  };

  it('start -> interact -> stop saves a deterministic learned template', async () => {
    const f = makeFixture(); // no chat: deterministic fallback path
    const win = await f.store.openWindow({});
    await f.store.startRecording(win.windowId);
    await expect(f.store.getRecording(win.windowId)).resolves.toMatchObject({
      recording: true,
      eventCount: 0,
    });
    f.drainQueue.push([RECORDED_CLICK]); // final drain sees the click
    const script = await f.store.stopRecording(win.windowId, {
      scriptId: 'taught.open-flow',
      title: 'Open a flow (taught)',
      description: 'Opens the billing flow',
    });
    expect(script.source).toBe('learned');
    expect(script.version).toBe(1);
    expect(script.steps[0]).toMatchObject({
      kind: 'click',
      selector: '[data-testid="flow-row"]',
      textFallback: ['Billing Bot'],
    });
    // Saved + effective: it now runs through the normal loop.
    await expect(f.store.getScript('taught.open-flow')).resolves.toMatchObject({
      id: 'taught.open-flow',
    });
    await expect(f.store.getRecording(win.windowId)).resolves.toMatchObject({
      recording: false,
    });
  });

  it('generalization promotes labels to params; garbage falls back', async () => {
    const f = makeFixture({
      chat: chatReturning([
        { kind: 'click', selector: '[data-testid="flow-row"]', textFallback: ['{flowName}'] },
        { kind: 'assertUrl', pattern: '/designer' },
      ]),
    });
    const win = await f.store.openWindow({});
    await f.store.startRecording(win.windowId);
    f.drainQueue.push([RECORDED_CLICK]);
    const script = await f.store.stopRecording(win.windowId, {
      scriptId: 'taught.open-any-flow',
      title: 'Open any flow',
      description: 'Opens the flow named {flowName}',
    });
    expect(script.steps[0]).toMatchObject({ textFallback: ['{flowName}'] });
    expect(f.events.some((e) => e.name === GSX_EVENTS.RECORD_GENERALIZED)).toBe(true);

    // Garbage model output: deterministic recording is kept.
    const g = makeFixture({
      chat: async () => ({
        content: 'not json at all',
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'claude-fable-5',
        provider: 'claude',
        cost: 0,
      }),
    });
    const win2 = await g.store.openWindow({});
    await g.store.startRecording(win2.windowId);
    g.drainQueue.push([RECORDED_CLICK]);
    const fallback = await g.store.stopRecording(win2.windowId, {
      scriptId: 'taught.fallback',
      title: 'Fallback',
      description: 'x',
    });
    expect(fallback.steps[0]).toMatchObject({ textFallback: ['Billing Bot'] });
  });

  it('an empty recording throws GSX_EMPTY_RECORDING (and stays stopped)', async () => {
    const f = makeFixture();
    const win = await f.store.openWindow({});
    await f.store.startRecording(win.windowId);
    await expect(
      f.store.stopRecording(win.windowId, { scriptId: 'x', title: 'x', description: 'x' })
    ).rejects.toMatchObject({ code: GSX_ERROR_CODES.EMPTY_RECORDING });
    await expect(f.store.getRecording(win.windowId)).resolves.toMatchObject({
      recording: false,
    });
  });

  it('stop without start throws GSX_NOT_RECORDING; cancel is soft', async () => {
    const f = makeFixture();
    const win = await f.store.openWindow({});
    await expect(
      f.store.stopRecording(win.windowId, { scriptId: 'x', title: 'x', description: 'x' })
    ).rejects.toMatchObject({ code: GSX_ERROR_CODES.NOT_RECORDING });
    await expect(f.store.cancelRecording(win.windowId)).resolves.toEqual({ cancelled: false });
    await f.store.startRecording(win.windowId);
    await expect(f.store.cancelRecording(win.windowId)).resolves.toEqual({ cancelled: true });
    expect(f.events.some((e) => e.name === GSX_EVENTS.RECORD_CANCELLED)).toBe(true);
  });

  it('malformed page events are dropped by sanitization', async () => {
    const f = makeFixture();
    const win = await f.store.openWindow({});
    await f.store.startRecording(win.windowId);
    f.drainQueue.push([
      null,
      42,
      { type: 'click' }, // no candidates
      { type: 'evil', candidates: ['#x'] }, // unknown type
      RECORDED_CLICK, // the one survivor
    ]);
    const script = await f.store.stopRecording(win.windowId, {
      scriptId: 'taught.sanitized',
      title: 'Sanitized',
      description: 'x',
    });
    expect(script.steps).toHaveLength(1);
  });
});

describe('GsxStore UI-automation agents', () => {
  const RECORDED_CLICK = {
    type: 'click',
    candidates: ['[data-testid="flow-row"]'],
    text: 'Billing Bot',
    label: 'Flow name',
    tag: 'li',
  };

  /** Chat fake that answers BOTH agent-create and extraction prompts. */
  const agentChat: GsxChatFn = async (input) => {
    const isExtraction = input.feature === 'gsx-agent-extract';
    const content = isExtraction
      ? JSON.stringify({ params: { flowName: 'Support Bot' }, missing: [] })
      : JSON.stringify({
          title: 'Open a Flow',
          description: 'Opens the named flow from the Flows list.',
          steps: [
            { kind: 'click', selector: '[data-testid="flow-row"]', textFallback: ['{flowName}'] },
            { kind: 'assertUrl', pattern: '/flows' },
          ],
          params: [{ name: 'flowName', description: 'Display name of the flow to open' }],
          note: 'parameterized flow name',
        });
    return {
      content,
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'claude-fable-5',
      provider: 'claude',
      cost: 0,
    };
  };

  async function teachAgent(f: Fixture, publish?: boolean): Promise<string> {
    const win = await f.store.openWindow({});
    await f.store.startRecording(win.windowId);
    f.drainQueue.push([RECORDED_CLICK]);
    const agent = await f.store.stopRecordingAsAgent(win.windowId, {
      name: 'open-flow',
      hint: 'opens a flow by name',
      ...(publish !== undefined ? { publish } : {}),
    });
    return agent.name;
  }

  it('stopRecordingAsAgent: the system describes it, documents params, publishes', async () => {
    const published: string[] = [];
    const f = makeFixture({
      chat: agentChat,
      publishAgent: async (input) => {
        published.push(input.okf);
        return { itemId: 'item-1' };
      },
    });
    await teachAgent(f);
    const agent = await f.store.getAgent('open-flow');
    expect(agent.title).toBe('Open a Flow'); // AI-written, not user-written
    expect(agent.description).toContain('named flow');
    expect(agent.params).toEqual([
      { name: 'flowName', description: 'Display name of the flow to open' },
    ]);
    expect(agent.scriptId).toBe('agent.open-flow');
    expect(agent.spaceItemId).toBe('item-1'); // GSX Build space item
    expect(published[0]).toContain('kind: ui-automation-agent');
    expect(f.events.some((e) => e.name === GSX_EVENTS.AGENT_CREATED)).toBe(true);
    expect(f.events.some((e) => e.name === GSX_EVENTS.AGENT_PUBLISHED)).toBe(true);
    // The template itself is a normal learned script.
    await expect(f.store.getScript('agent.open-flow')).resolves.toMatchObject({
      source: 'learned',
    });
  });

  it('invokeAgent extracts params from free-form details and runs the template', async () => {
    const f = makeFixture({ chat: agentChat });
    await teachAgent(f, false);
    const result = await f.store.invokeAgent('open-flow', {
      details: 'open the support bot flow',
    });
    expect(result.params).toEqual({ flowName: 'Support Bot' });
    expect(result.run.verdict).toBe('pass');
    expect(result.run.scriptId).toBe('agent.open-flow');
    expect(f.events.some((e) => e.name === GSX_EVENTS.AGENT_INVOKE_START)).toBe(false); // span, not instant
  });

  it('structured params win over extraction; missing params fail with names', async () => {
    const f = makeFixture({ chat: agentChat });
    await teachAgent(f, false);
    const result = await f.store.invokeAgent('open-flow', {
      details: 'open the support bot flow',
      params: { flowName: 'Override Bot' },
    });
    expect(result.params).toEqual({ flowName: 'Override Bot' });

    // No details, no params, no way to fill flowName -> loud failure.
    const g = makeFixture({ chat: agentChat });
    await teachAgent(g, false);
    await expect(g.store.invokeAgent('open-flow')).rejects.toMatchObject({
      code: GSX_ERROR_CODES.MISSING_PARAMS,
    });
  });

  it('no AI: fallback meta (slug title, scanned params), structured invocation works', async () => {
    const f = makeFixture(); // chat: null
    const win = await f.store.openWindow({});
    await f.store.startRecording(win.windowId);
    f.drainQueue.push([RECORDED_CLICK]);
    const agent = await f.store.stopRecordingAsAgent(win.windowId, {
      name: 'open-flow',
      publish: false,
    });
    expect(agent.title).toBe('Open Flow'); // deterministic slug title
    // Deterministic recording has no {params}; invocation just runs.
    const result = await f.store.invokeAgent('open-flow');
    expect(result.run.verdict).toBe('pass');
  });

  it('publish failure is soft: agent exists without spaceItemId', async () => {
    const f = makeFixture({
      chat: agentChat,
      publishAgent: async () => {
        throw new Error('spaces offline');
      },
    });
    await teachAgent(f);
    const agent = await f.store.getAgent('open-flow');
    expect(agent.spaceItemId).toBeUndefined();
  });

  it('agents persist across restart; deleteAgent removes agent + script', async () => {
    const dir = tmpDir();
    const a = makeFixture({ chat: agentChat, persistDir: dir });
    await teachAgent(a, false);
    const b = makeFixture({ persistDir: dir });
    const listed = await b.store.listAgents();
    expect(listed.map((x) => x.name)).toEqual(['open-flow']);
    await expect(b.store.deleteAgent('open-flow')).resolves.toEqual({ deleted: true });
    await expect(b.store.getAgent('open-flow')).rejects.toMatchObject({
      code: GSX_ERROR_CODES.AGENT_NOT_FOUND,
    });
    await expect(b.store.getScript('agent.open-flow')).rejects.toMatchObject({
      code: GSX_ERROR_CODES.SCRIPT_NOT_FOUND,
    });
  });

  it('bad names and unknown agents are structured errors', async () => {
    const f = makeFixture();
    const win = await f.store.openWindow({});
    await f.store.startRecording(win.windowId);
    await expect(
      f.store.stopRecordingAsAgent(win.windowId, { name: 'Bad Name!' })
    ).rejects.toMatchObject({ code: GSX_ERROR_CODES.INVALID_AGENT_NAME });
    await expect(f.store.invokeAgent('ghost')).rejects.toMatchObject({
      code: GSX_ERROR_CODES.AGENT_NOT_FOUND,
    });
    // The failed name validation leaves the recording active (by
    // design -- the walkthrough isn't lost); clear its poll timer.
    await f.store.cancelRecording(win.windowId);
  });
});

describe('GsxStore guardrails', () => {
  it('rejects unsupported environments', async () => {
    const f = makeFixture();
    await expect(
      f.store.openWindow({ env: 'production' as never })
    ).rejects.toMatchObject({ code: GSX_ERROR_CODES.UNSUPPORTED_ENV });
  });

  it('rejects runs against an unknown windowId', async () => {
    const f = makeFixture();
    await f.store.saveScript(customScript());
    await expect(
      f.store.runScript({ scriptId: 'test.custom', windowId: 'ghost' })
    ).rejects.toMatchObject({ code: GSX_ERROR_CODES.WINDOW_NOT_FOUND });
  });

  it('resolves relative URLs against the env studio origin with accountId', async () => {
    const f = makeFixture();
    const info = await f.store.openWindow({ url: '/flows?accountId={accountId}' });
    expect(info.url).toBe('https://studio.edison.onereach.ai/flows?accountId=acc-1');
  });
});
