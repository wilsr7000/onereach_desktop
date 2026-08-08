/**
 * GSX automation store -- state + orchestration behind `GsxApi`.
 *
 * Owns the evaluation feedback loop:
 *
 *   run (deterministic script)
 *     → grade against the script's own assertions (verdict)
 *       → pass:      record + stats, done. No model call on the happy path.
 *       → fail/error → snapshot the live page → AI repairs the steps
 *           → repaired run passes → SAVE as `learned` variant
 *             (shadows the seed; replays deterministically next time)
 *           → repaired run fails  → record `repaired-fail`
 *   learned variant fails GSX_INVALIDATE_AFTER_CONSECUTIVE_FAILURES
 *   times in a row → DEMOTE back to the seed (gsx.script.invalidated).
 *
 * Every transition emits a typed event (`gsx.run.verdict`,
 * `gsx.script.learned`, `gsx.script.invalidated`, per-step
 * `gsx.step.result`) so the loop is auditable from the event stream.
 *
 * Electron-free: window access goes through the injected
 * {@link GsxWindowPort} (production impl in `window.ts`, wired by
 * `main.ts`); the AI chat, accountId resolver, clock, and persist dir
 * are injected the same way. Unit tests drive the whole loop with
 * fakes.
 *
 * Persistence: learned scripts + stats + a capped run history in one
 * JSON file (`gsx-automation.json`) under userData. Loaded lazily on
 * first read, written after every mutation; write failures soft-fail
 * with a logged `GSX_PERSIST_FAILED` (the in-memory loop keeps
 * working).
 *
 * @internal -- consumers use `getGsxApi()` from `./api.ts`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Environment } from '../auth/types.js';
import { SUPPORTED_ENVIRONMENTS } from '../auth/types.js';
import type { Span } from '../logging/events.js';
import {
  GSX_INVALIDATE_AFTER_CONSECUTIVE_FAILURES,
  GSX_MAX_RUN_RECORDS,
  type GsxOpenWindowOptions,
  type GsxPageSnapshot,
  type GsxRepairSummary,
  type GsxRunRecord,
  type GsxRunScriptOptions,
  type GsxScript,
  type GsxScriptStats,
  type GsxStepResult,
  type GsxWindowInfo,
} from './types.js';
import { GsxError, GSX_ERROR_CODES } from './errors.js';
import { GSX_EVENTS, type GsxEvent } from './events.js';
import { GSX_SEED_SCRIPTS, findSeedScript, GSX_STUDIO_ORIGIN_TEMPLATE } from './scripts.js';
import {
  executeSteps,
  substituteParams,
  takeSnapshot,
  validateScript,
  type GsxExecutor,
} from './runner.js';
import { repairScript, type GsxChatFn } from './repair.js';
import {
  buildStepsFromRecording,
  generalizeRecording,
  GSX_MAX_RECORDED_EVENTS,
  RECORDER_DRAIN_SCRIPT,
  RECORDER_INSTALL_SCRIPT,
  type GsxRecordedEvent,
} from './recorder.js';
import type {
  GsxAgent,
  GsxInvokeAgentOptions,
  GsxInvokeAgentResult,
  GsxRecordingStatus,
  GsxStopRecordingAsAgentOptions,
  GsxStopRecordingOptions,
} from './types.js';
import {
  buildAgentCreateInput,
  buildAgentOkf,
  buildParamExtractionInput,
  fallbackAgentMeta,
  parseAgentCreateResponse,
  parseParamExtractionResponse,
  requireValidAgentName,
  scanScriptParams,
} from './agent.js';

/** What the store needs from the window layer. Production: `window.ts`. */
export interface GsxWindowPort {
  open(opts: { env: Environment; url: string; title?: string }): Promise<GsxWindowInfo>;
  close(windowId: string): boolean;
  list(): GsxWindowInfo[];
  info(windowId: string): GsxWindowInfo | null;
  navigate(windowId: string, url: string): Promise<void>;
  executor(windowId: string): GsxExecutor;
}

export interface GsxStoreConfig {
  logger: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  spanEmitter?: (name: string, data?: unknown) => Span;
  eventEmitter?: (name: string, data?: unknown, level?: 'info' | 'warn' | 'error') => void;
  /** Lazy window port -- throws until `main.ts` wires the real one. */
  windowPort: () => GsxWindowPort;
  /** Lazy AI chat seam; null = repair unavailable (recorded, not fatal). */
  chat: () => GsxChatFn | null;
  /** Resolve the signed-in accountId for an env (null when signed out). */
  accountId: (env: Environment) => string | null;
  /** Directory for gsx-automation.json; null disables persistence. */
  persistDir: () => string | null;
  /**
   * Subscribe to the unified event stream, pre-filtered to GSX events
   * (ADR-030: everything flows through logging; `api.ts` wires this to
   * `getLoggingApi().onEvent` + `isGsxEvent`). Returns unsubscribe.
   */
  eventSubscribe?: (handler: (event: GsxEvent) => void) => () => void;
  now?: () => number;
  uuid?: () => string;
  /** Teach-mode drain interval (ms). Tests shrink it; default 400. */
  recordPollMs?: number;
  /**
   * Publish a taught agent into the "GSX Build" Space (wired by
   * `main.ts` to the spaces module -- this file never imports it).
   * Returns the created item id, or null when publication is
   * unavailable (signed out, spaces not initialized). Soft-fail only.
   */
  publishAgent?: (input: {
    name: string;
    title: string;
    description: string;
    okf: string;
  }) => Promise<{ itemId: string } | null>;
}

/** Shape of the persisted JSON file. */
interface GsxPersistedState {
  schemaVersion: 1;
  learnedScripts: GsxScript[];
  stats: GsxScriptStats[];
  runs: GsxRunRecord[];
  /** Absent in pre-agent files; loader tolerates. */
  agents?: GsxAgent[];
}

const PERSIST_FILENAME = 'gsx-automation.json';
const DEFAULT_ENV: Environment = 'edison';
const DEFAULT_RECORD_POLL_MS = 400;

/** Live teach-mode session state, one per window. */
interface ActiveRecording {
  windowId: string;
  env: Environment;
  events: GsxRecordedEvent[];
  lastUrl: string;
  timer: ReturnType<typeof setInterval>;
  span: Span | undefined;
  /** Serializes poll ticks so a slow drain never overlaps the next. */
  polling: boolean;
}

export class GsxStore {
  private readonly config: GsxStoreConfig;
  private readonly now: () => number;
  private readonly uuid: () => string;
  /** Learned/custom scripts by id (shadow seeds with the same id). */
  private learned = new Map<string, GsxScript>();
  private stats = new Map<string, GsxScriptStats>();
  private runs: GsxRunRecord[] = [];
  private loaded = false;
  private recordings = new Map<string, ActiveRecording>();
  private agents = new Map<string, GsxAgent>();

  constructor(config: GsxStoreConfig) {
    this.config = config;
    this.now = config.now ?? Date.now;
    this.uuid = config.uuid ?? (() => globalThis.crypto.randomUUID());
  }

  // ─── windows ──────────────────────────────────────────────────────────

  async openWindow(opts?: GsxOpenWindowOptions): Promise<GsxWindowInfo> {
    const env = this.resolveEnv(opts?.env);
    const url = this.resolveUrl(env, opts?.url);
    const span = this.config.spanEmitter?.(stripSpanSuffix(GSX_EVENTS.OPEN_WINDOW_START), {
      env,
      url,
    });
    try {
      const info = await this.config.windowPort().open({
        env,
        url,
        ...(opts?.title !== undefined ? { title: opts.title } : {}),
      });
      span?.finish({ windowId: info.windowId });
      return info;
    } catch (err) {
      span?.fail(err);
      throw err;
    }
  }

  async closeWindow(windowId: string): Promise<{ closed: boolean }> {
    const closed = this.config.windowPort().close(windowId);
    if (closed) {
      this.config.eventEmitter?.(GSX_EVENTS.WINDOW_CLOSED, { windowId });
    }
    return { closed };
  }

  async listWindows(): Promise<GsxWindowInfo[]> {
    return this.config.windowPort().list();
  }

  async navigate(windowId: string, url: string): Promise<GsxWindowInfo> {
    const port = this.config.windowPort();
    const info = port.info(windowId);
    if (info === null) {
      throw new GsxError({
        code: GSX_ERROR_CODES.WINDOW_NOT_FOUND,
        message: `No open GSX window with id ${windowId}`,
        remediation: 'Call openWindow() first, or list windows to find a live id.',
      });
    }
    await port.navigate(windowId, this.resolveUrl(info.env, url));
    return this.config.windowPort().info(windowId) ?? info;
  }

  async snapshot(windowId: string): Promise<GsxPageSnapshot> {
    const port = this.config.windowPort();
    if (port.info(windowId) === null) {
      throw new GsxError({
        code: GSX_ERROR_CODES.WINDOW_NOT_FOUND,
        message: `No open GSX window with id ${windowId}`,
        remediation: 'Call openWindow() first, or list windows to find a live id.',
      });
    }
    return takeSnapshot(port.executor(windowId));
  }

  // ─── scripts ──────────────────────────────────────────────────────────

  async listScripts(): Promise<GsxScript[]> {
    this.ensureLoaded();
    const out: GsxScript[] = [];
    const seen = new Set<string>();
    // Learned/custom variants shadow seeds with the same id.
    for (const script of this.learned.values()) {
      out.push(script);
      seen.add(script.id);
    }
    for (const seed of GSX_SEED_SCRIPTS) {
      if (!seen.has(seed.id)) out.push(seed);
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  async getScript(id: string): Promise<GsxScript> {
    this.ensureLoaded();
    const script = this.learned.get(id) ?? findSeedScript(id);
    if (script === null || script === undefined) {
      throw new GsxError({
        code: GSX_ERROR_CODES.SCRIPT_NOT_FOUND,
        message: `No GSX script registered under id "${id}"`,
        remediation: 'List scripts to see the available ids.',
      });
    }
    return script;
  }

  async saveScript(candidate: GsxScript): Promise<GsxScript> {
    this.ensureLoaded();
    const script = validateScript(candidate);
    if (script.source === 'seed') {
      throw new GsxError({
        code: GSX_ERROR_CODES.SEED_READ_ONLY,
        message: 'Seed scripts are read-only; save with source "learned" to shadow one.',
        remediation: 'Set source to "learned" (it will shadow the seed of the same id).',
      });
    }
    this.learned.set(script.id, script);
    this.persist();
    return script;
  }

  async deleteScript(id: string): Promise<{ deleted: boolean }> {
    this.ensureLoaded();
    if (!this.learned.has(id)) {
      if (findSeedScript(id) !== null) {
        throw new GsxError({
          code: GSX_ERROR_CODES.SEED_READ_ONLY,
          message: `"${id}" is a seed script and cannot be deleted.`,
          remediation:
            'Only learned/custom variants can be deleted (deleting one reverts to the seed).',
        });
      }
      return { deleted: false };
    }
    this.learned.delete(id);
    this.persist();
    return { deleted: true };
  }

  // ─── the run + eval loop ──────────────────────────────────────────────

  async runScript(opts: GsxRunScriptOptions): Promise<GsxRunRecord> {
    this.ensureLoaded();
    const script = await this.getScript(opts.scriptId);
    const env = this.resolveEnv(opts.env);
    const span = this.config.spanEmitter?.(stripSpanSuffix(GSX_EVENTS.RUN_SCRIPT_START), {
      scriptId: script.id,
      version: script.version,
      source: script.source,
    });
    try {
      const record = await this.runResolvedScript(script, env, opts);
      span?.finish({ runId: record.runId, verdict: record.verdict });
      return record;
    } catch (err) {
      span?.fail(err);
      throw err;
    }
  }

  private async runResolvedScript(
    script: GsxScript,
    env: Environment,
    opts: GsxRunScriptOptions
  ): Promise<GsxRunRecord> {
    const port = this.config.windowPort();
    // Resolve the target window: explicit id > open a fresh one.
    let windowId = opts.windowId;
    if (windowId !== undefined && port.info(windowId) === null) {
      throw new GsxError({
        code: GSX_ERROR_CODES.WINDOW_NOT_FOUND,
        message: `No open GSX window with id ${windowId}`,
        remediation: 'Omit windowId to let the run open its own window.',
      });
    }
    if (windowId === undefined) {
      const info = await this.openWindow({ env });
      windowId = info.windowId;
    }

    const params: Record<string, string> = {
      env,
      accountId: this.config.accountId(env) ?? '',
      ...(opts.params ?? {}),
    };
    const resolved = substituteParams(script, params);
    const executor = port.executor(windowId);

    const startedAtMs = this.now();
    const outcome = await executeSteps(resolved, executor, { now: this.now });
    this.emitStepResults(script, outcome.steps);

    let verdict: GsxRunRecord['verdict'] = outcome.verdict;
    let steps = outcome.steps;
    let failure = outcome.failure;
    let repair: GsxRepairSummary | undefined;

    if (verdict !== 'pass' && opts.repair !== false) {
      const provisional = this.buildRecord(
        script, windowId, params, startedAtMs, verdict, steps, failure
      );
      const repairResult = await this.tryRepair(script, provisional, executor);
      repair = repairResult.summary;
      if (repairResult.record !== null) {
        verdict = repairResult.record.verdict === 'pass' ? 'repaired-pass' : 'repaired-fail';
        steps = repairResult.record.steps;
        failure = repairResult.record.failure;
      }
    }

    const record = this.buildRecord(
      script, windowId, params, startedAtMs, verdict, steps, failure, repair
    );
    this.recordRun(script, record);
    return record;
  }

  /**
   * The LLM half of the hybrid: snapshot → repair → re-run → maybe
   * promote. Never throws -- everything lands in the repair summary.
   */
  private async tryRepair(
    script: GsxScript,
    failedRun: GsxRunRecord,
    executor: GsxExecutor
  ): Promise<{
    summary: GsxRepairSummary;
    record: { verdict: 'pass' | 'fail' | 'error'; steps: GsxStepResult[]; failure?: string } | null;
  }> {
    const chat = this.config.chat();
    if (chat === null) {
      return {
        summary: { attempted: false, skippedReason: 'ai-not-configured' },
        record: null,
      };
    }
    const span = this.config.spanEmitter?.(stripSpanSuffix(GSX_EVENTS.REPAIR_START), {
      scriptId: script.id,
      failedVersion: script.version,
    });
    try {
      const snapshot = await takeSnapshot(executor);
      const { script: learnedCandidate, note } = await repairScript(
        chat, script, failedRun, snapshot
      );
      // Re-run the repaired steps against the SAME window, same params.
      const resolved = substituteParams(learnedCandidate, failedRun.params);
      const rerun = await executeSteps(resolved, executor, { now: this.now });
      this.emitStepResults(learnedCandidate, rerun.steps);
      if (rerun.verdict === 'pass') {
        this.learned.set(learnedCandidate.id, learnedCandidate);
        // A fresh variant starts with a clean consecutive-failure slate.
        const stat = this.statFor(script.id);
        stat.consecutiveFailures = 0;
        this.config.eventEmitter?.(GSX_EVENTS.SCRIPT_LEARNED, {
          scriptId: learnedCandidate.id,
          version: learnedCandidate.version,
          note,
        });
        this.persist();
        span?.finish({ learnedVersion: learnedCandidate.version });
        return {
          summary: { attempted: true, learnedVersion: learnedCandidate.version, steps: rerun.steps },
          record: rerun,
        };
      }
      span?.finish({});
      return {
        summary: { attempted: true, steps: rerun.steps },
        record: rerun,
      };
    } catch (err) {
      span?.fail(err);
      this.config.logger('warn', 'repair attempt failed', {
        scriptId: script.id,
        error: (err as Error).message,
      });
      return {
        summary: { attempted: true, skippedReason: (err as Error).message },
        record: null,
      };
    }
  }

  private buildRecord(
    script: GsxScript,
    windowId: string,
    params: Record<string, string>,
    startedAtMs: number,
    verdict: GsxRunRecord['verdict'],
    steps: GsxStepResult[],
    failure?: string,
    repair?: GsxRepairSummary
  ): GsxRunRecord {
    const finishedAtMs = this.now();
    // accountId can be sensitive-ish; keep it, but never log params
    // wholesale in events (see emit sites).
    return {
      runId: this.uuid(),
      scriptId: script.id,
      scriptVersion: script.version,
      source: script.source,
      windowId,
      params,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: Math.max(0, finishedAtMs - startedAtMs),
      verdict,
      steps,
      ...(failure !== undefined ? { failure } : {}),
      ...(repair !== undefined ? { repair } : {}),
    };
  }

  /** Record + stats + invalidation policy + verdict event. */
  private recordRun(script: GsxScript, record: GsxRunRecord): void {
    this.runs.push(record);
    if (this.runs.length > GSX_MAX_RUN_RECORDS) {
      this.runs = this.runs.slice(-GSX_MAX_RUN_RECORDS);
    }
    const stat = this.statFor(script.id);
    stat.runs += 1;
    stat.lastVerdict = record.verdict;
    stat.lastRunAt = record.finishedAt;
    const passed = record.verdict === 'pass' || record.verdict === 'repaired-pass';
    if (passed) {
      stat.passes += 1;
      stat.consecutiveFailures = 0;
    } else {
      stat.failures += 1;
      stat.consecutiveFailures += 1;
    }
    // Demotion: a learned variant that keeps failing gets thrown away so
    // the next run falls back to the deterministic seed floor. Custom
    // scripts (no seed under the id) are never auto-deleted -- there is
    // no floor to fall back to.
    const effective = this.learned.get(script.id);
    if (
      !passed &&
      effective !== undefined &&
      findSeedScript(script.id) !== null &&
      stat.consecutiveFailures >= GSX_INVALIDATE_AFTER_CONSECUTIVE_FAILURES
    ) {
      this.learned.delete(script.id);
      stat.consecutiveFailures = 0;
      stat.lastInvalidatedAt = record.finishedAt;
      this.config.eventEmitter?.(
        GSX_EVENTS.SCRIPT_INVALIDATED,
        {
          scriptId: script.id,
          invalidatedVersion: effective.version,
          consecutiveFailures: GSX_INVALIDATE_AFTER_CONSECUTIVE_FAILURES,
        },
        'warn'
      );
    }
    this.config.eventEmitter?.(
      GSX_EVENTS.RUN_VERDICT,
      {
        runId: record.runId,
        scriptId: record.scriptId,
        version: record.scriptVersion,
        source: record.source,
        verdict: record.verdict,
        durationMs: record.durationMs,
        ...(record.failure !== undefined ? { failure: record.failure } : {}),
      },
      passed ? 'info' : 'warn'
    );
    this.persist();
  }

  private emitStepResults(script: GsxScript, steps: GsxStepResult[]): void {
    for (const step of steps) {
      this.config.eventEmitter?.(
        GSX_EVENTS.STEP_RESULT,
        {
          scriptId: script.id,
          index: step.index,
          kind: step.kind,
          ok: step.ok,
          ...(step.detail !== undefined ? { detail: step.detail.slice(0, 200) } : {}),
        },
        step.ok ? 'info' : 'warn'
      );
    }
  }

  // ─── teach mode (recording) ───────────────────────────────────────────

  /**
   * Start recording the user's navigation in a window. Idempotent per
   * window (a second call just reports the live status). The poll loop
   * drains the page buffer, synthesizes `navigate` events from URL
   * changes, and re-installs the recorder after each navigation.
   */
  async startRecording(windowId: string): Promise<GsxRecordingStatus> {
    const port = this.config.windowPort();
    const info = port.info(windowId);
    if (info === null) {
      throw new GsxError({
        code: GSX_ERROR_CODES.WINDOW_NOT_FOUND,
        message: `No open GSX window with id ${windowId}`,
        remediation: 'Call openWindow() first, then start recording.',
      });
    }
    const existing = this.recordings.get(windowId);
    if (existing !== undefined) {
      return { windowId, recording: true, eventCount: existing.events.length };
    }
    const executor = port.executor(windowId);
    await executor.exec(RECORDER_INSTALL_SCRIPT, false);
    const span = this.config.spanEmitter?.(stripSpanSuffix(GSX_EVENTS.RECORD_START), {
      windowId,
    });
    const recording: ActiveRecording = {
      windowId,
      env: info.env,
      events: [],
      lastUrl: executor.currentUrl(),
      timer: setInterval(() => {
        void this.pollRecording(windowId);
      }, this.config.recordPollMs ?? DEFAULT_RECORD_POLL_MS),
      span,
      polling: false,
    };
    this.recordings.set(windowId, recording);
    return { windowId, recording: true, eventCount: 0 };
  }

  /** Live status (recording: false when no session is active). */
  async getRecording(windowId: string): Promise<GsxRecordingStatus> {
    const active = this.recordings.get(windowId);
    return {
      windowId,
      recording: active !== undefined,
      eventCount: active?.events.length ?? 0,
    };
  }

  /**
   * Finish a recording: final drain, convert to deterministic steps,
   * optionally ask the AI module to GENERALIZE them into a
   * parameterized template (labels drive the param names), and save
   * the result as a `learned` script. Generalization failures fall
   * back to the deterministic recording -- teach mode never loses a
   * walkthrough to a flaky model call.
   */
  async stopRecording(
    windowId: string,
    opts: GsxStopRecordingOptions
  ): Promise<GsxScript> {
    this.ensureLoaded();
    const active = this.takeRecording(windowId);
    try {
      const steps = await this.collectRecordedSteps(windowId, active);
      const base: GsxScript = {
        id: opts.scriptId,
        title: opts.title,
        description: opts.description,
        version: this.nextVersionFor(opts.scriptId),
        source: 'learned',
        steps,
      };
      validateScript(base);
      let finalScript = base;
      let generalized = false;
      const chat = this.config.chat();
      if (opts.generalize !== false && chat !== null) {
        try {
          const result = await generalizeRecording(chat, base, active.events);
          finalScript = result.script;
          generalized = true;
          this.config.eventEmitter?.(GSX_EVENTS.RECORD_GENERALIZED, {
            scriptId: finalScript.id,
            params: finalScript.params ?? [],
            note: result.note,
          });
        } catch (err) {
          this.config.logger('warn', 'generalization failed; keeping deterministic recording', {
            scriptId: opts.scriptId,
            error: (err as Error).message,
          });
        }
      }
      const saved = await this.saveScript(finalScript);
      active.span?.finish({
        scriptId: saved.id,
        eventCount: active.events.length,
        generalized,
      });
      return saved;
    } catch (err) {
      active.span?.fail(err);
      throw err;
    }
  }

  /**
   * Finish a recording as a NAMED UI-AUTOMATION AGENT (ADR-054). The
   * system writes the agent's title, description, and per-param
   * descriptions from the recording in the same LLM call that
   * generalizes the steps into a `{param}` template. Without AI the
   * agent still exists (slug-derived title, params scanned from
   * placeholders) and is invokable with structured params. Best-effort
   * publishes the OKF definition into the "GSX Build" Space.
   */
  async stopRecordingAsAgent(
    windowId: string,
    opts: GsxStopRecordingAsAgentOptions
  ): Promise<GsxAgent> {
    this.ensureLoaded();
    const name = requireValidAgentName(opts.name);
    const active = this.takeRecording(windowId);
    try {
      const steps = await this.collectRecordedSteps(windowId, active);
      const scriptId = `agent.${name}`;
      const base: GsxScript = {
        id: scriptId,
        title: name,
        description: opts.hint ?? '',
        version: this.nextVersionFor(scriptId),
        source: 'learned',
        steps,
      };
      validateScript(base);

      // One model call: describe + generalize + document params.
      let script = base;
      let meta = fallbackAgentMeta(name, base);
      let described = false;
      const chat = this.config.chat();
      if (chat !== null) {
        try {
          const result = await chat(
            buildAgentCreateInput(base, active.events, name, opts.hint)
          );
          const parsed = parseAgentCreateResponse(result.content, base);
          script = parsed.script;
          meta = {
            title: parsed.title,
            description:
              parsed.description.length > 0 ? parsed.description : meta.description,
            params: parsed.params,
          };
          described = true;
        } catch (err) {
          this.config.logger('warn', 'agent describe/generalize failed; using fallback meta', {
            agent: name,
            error: (err as Error).message,
          });
        }
      }
      script = { ...script, title: meta.title, description: meta.description };
      await this.saveScript(script);

      const now = new Date(this.now()).toISOString();
      const existing = this.agents.get(name);
      const agent: GsxAgent = {
        name,
        title: meta.title,
        description: meta.description,
        scriptId,
        params: meta.params,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...(existing?.spaceItemId !== undefined ? { spaceItemId: existing.spaceItemId } : {}),
      };
      this.agents.set(name, agent);
      this.persist();
      this.config.eventEmitter?.(GSX_EVENTS.AGENT_CREATED, {
        agent: name,
        scriptId,
        paramCount: agent.params.length,
        described,
      });
      active.span?.finish({
        scriptId,
        eventCount: active.events.length,
        generalized: described,
      });

      // Publication is decoration, never a gate: the agent works
      // locally whether or not the Space write succeeds.
      if (opts.publish !== false && this.config.publishAgent !== undefined) {
        try {
          const published = await this.config.publishAgent({
            name: agent.name,
            title: agent.title,
            description: agent.description,
            okf: buildAgentOkf(agent, script),
          });
          if (published !== null) {
            const updated: GsxAgent = { ...agent, spaceItemId: published.itemId };
            this.agents.set(name, updated);
            this.persist();
            this.config.eventEmitter?.(GSX_EVENTS.AGENT_PUBLISHED, {
              agent: name,
              spaceItemId: published.itemId,
            });
            return updated;
          }
        } catch (err) {
          this.config.logger('warn', 'agent publish to GSX Build space failed', {
            agent: name,
            error: (err as Error).message,
          });
        }
      }
      return agent;
    } catch (err) {
      active.span?.fail(err);
      throw err;
    }
  }

  /**
   * Invoke an agent by name. `params` are merged over values extracted
   * from free-form `details` (extraction uses the agent's param
   * descriptions; requires the AI module). Any params still missing
   * fail with `GSX_MISSING_PARAMS` naming them -- so a caller can
   * always fall back to passing structured params.
   */
  async invokeAgent(
    name: string,
    opts?: GsxInvokeAgentOptions
  ): Promise<GsxInvokeAgentResult> {
    this.ensureLoaded();
    const agent = this.agents.get(name);
    if (agent === undefined) {
      throw new GsxError({
        code: GSX_ERROR_CODES.AGENT_NOT_FOUND,
        message: `No UI-automation agent named "${name}"`,
        remediation: 'List agents to see the available names.',
      });
    }
    const span = this.config.spanEmitter?.(stripSpanSuffix(GSX_EVENTS.AGENT_INVOKE_START), {
      agent: name,
      hasDetails: typeof opts?.details === 'string' && opts.details.length > 0,
    });
    try {
      const script = await this.getScript(agent.scriptId);
      const needed = scanScriptParams(script);
      const params: Record<string, string> = {};
      let missing = needed.filter((p) => !(p in params));
      const details = opts?.details;
      const chat = this.config.chat();
      if (missing.length > 0 && details !== undefined && details.length > 0 && chat !== null) {
        try {
          const result = await chat(buildParamExtractionInput(agent, missing, details));
          const extracted = parseParamExtractionResponse(result.content, missing);
          Object.assign(params, extracted.params);
        } catch (err) {
          this.config.logger('warn', 'param extraction failed', {
            agent: name,
            error: (err as Error).message,
          });
        }
      }
      // Structured params always win over extraction.
      Object.assign(params, opts?.params ?? {});
      missing = needed.filter((p) => params[p] === undefined || params[p].length === 0);
      if (missing.length > 0) {
        throw new GsxError({
          code: GSX_ERROR_CODES.MISSING_PARAMS,
          message: `Agent "${name}" needs params: ${missing.join(', ')}`,
          remediation:
            'Pass them in params, or include them in details (AI extraction requires the AI module).',
          context: { agent: name, missing },
        });
      }
      const run = await this.runScript({
        scriptId: agent.scriptId,
        params,
        ...(opts?.windowId !== undefined ? { windowId: opts.windowId } : {}),
        ...(opts?.env !== undefined ? { env: opts.env } : {}),
        ...(opts?.repair !== undefined ? { repair: opts.repair } : {}),
      });
      span?.finish({ agent: name, runId: run.runId, verdict: run.verdict });
      return { agent, params, run };
    } catch (err) {
      span?.fail(err);
      throw err;
    }
  }

  /** All registered UI-automation agents, sorted by name. */
  async listAgents(): Promise<GsxAgent[]> {
    this.ensureLoaded();
    return [...this.agents.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** One agent by name. Throws `GSX_AGENT_NOT_FOUND`. */
  async getAgent(name: string): Promise<GsxAgent> {
    this.ensureLoaded();
    const agent = this.agents.get(name);
    if (agent === undefined) {
      throw new GsxError({
        code: GSX_ERROR_CODES.AGENT_NOT_FOUND,
        message: `No UI-automation agent named "${name}"`,
        remediation: 'List agents to see the available names.',
      });
    }
    return agent;
  }

  /** Delete an agent (and its learned script). */
  async deleteAgent(name: string): Promise<{ deleted: boolean }> {
    this.ensureLoaded();
    const agent = this.agents.get(name);
    if (agent === undefined) return { deleted: false };
    this.agents.delete(name);
    this.learned.delete(agent.scriptId);
    this.persist();
    this.config.eventEmitter?.(GSX_EVENTS.AGENT_DELETED, { agent: name });
    return { deleted: true };
  }

  /** Shared teach-mode epilogue: final drain -> non-empty steps. */
  private async collectRecordedSteps(
    windowId: string,
    active: ActiveRecording
  ): Promise<GsxScript['steps']> {
    await this.pollRecording(windowId, active); // final drain (best-effort)
    if (active.events.length === 0) {
      throw new GsxError({
        code: GSX_ERROR_CODES.EMPTY_RECORDING,
        message: 'The recording captured no actions',
        remediation: 'Interact with the GSX window while recording, then stop again.',
      });
    }
    return buildStepsFromRecording(active.events, {
      env: active.env,
      accountId: this.config.accountId(active.env),
    });
  }

  /** Abandon a recording without saving. */
  async cancelRecording(windowId: string): Promise<{ cancelled: boolean }> {
    const active = this.recordings.get(windowId);
    if (active === undefined) return { cancelled: false };
    clearInterval(active.timer);
    this.recordings.delete(windowId);
    active.span?.finish({ eventCount: active.events.length, generalized: false });
    this.config.eventEmitter?.(GSX_EVENTS.RECORD_CANCELLED, {
      windowId,
      eventCount: active.events.length,
      reason: 'cancelled',
    });
    return { cancelled: true };
  }

  /** Detach + stop the poll timer, keeping the state for the caller. */
  private takeRecording(windowId: string): ActiveRecording {
    const active = this.recordings.get(windowId);
    if (active === undefined) {
      throw new GsxError({
        code: GSX_ERROR_CODES.NOT_RECORDING,
        message: `No active recording on window ${windowId}`,
        remediation: 'Call startRecording() first.',
      });
    }
    clearInterval(active.timer);
    this.recordings.delete(windowId);
    return active;
  }

  /**
   * One drain tick. Navigation first (the drained buffer belongs to
   * the CURRENT page -- sessionStorage carried any pre-nav clicks
   * across), then the drained events, then re-install (idempotent; a
   * fresh page world needs it).
   */
  private async pollRecording(
    windowId: string,
    detached?: ActiveRecording
  ): Promise<void> {
    const active = detached ?? this.recordings.get(windowId);
    if (active === undefined || active.polling) return;
    active.polling = true;
    try {
      const port = this.config.windowPort();
      if (port.info(windowId) === null) {
        // Window closed mid-recording: stop polling but KEEP the state
        // in the map -- stopRecording can still save what was captured.
        clearInterval(active.timer);
        return;
      }
      const executor = port.executor(windowId);
      const url = executor.currentUrl();
      if (url !== active.lastUrl && url.length > 0) {
        active.lastUrl = url;
        if (active.events.length < GSX_MAX_RECORDED_EVENTS) {
          active.events.push({ type: 'navigate', url });
        }
      }
      const drained = (await executor.exec(RECORDER_DRAIN_SCRIPT, false)) as unknown;
      if (Array.isArray(drained)) {
        for (const raw of drained) {
          if (active.events.length >= GSX_MAX_RECORDED_EVENTS) break;
          const event = sanitizeRecordedEvent(raw);
          if (event !== null) active.events.push(event);
        }
      }
      await executor.exec(RECORDER_INSTALL_SCRIPT, false);
    } catch (err) {
      // Transient exec failures (navigation in flight) are normal;
      // just log at debug-ish level and let the next tick retry.
      this.config.logger('info', 'recording poll tick failed (will retry)', {
        windowId,
        error: (err as Error).message,
      });
    } finally {
      active.polling = false;
    }
  }

  /** Next version for a template id: shadows bump whatever exists. */
  private nextVersionFor(scriptId: string): number {
    const existing = this.learned.get(scriptId) ?? findSeedScript(scriptId);
    return existing !== null && existing !== undefined ? existing.version + 1 : 1;
  }

  // ─── run history + stats ──────────────────────────────────────────────

  async listRuns(scriptId?: string): Promise<GsxRunRecord[]> {
    this.ensureLoaded();
    const all = scriptId === undefined ? this.runs : this.runs.filter((r) => r.scriptId === scriptId);
    // Newest first.
    return [...all].reverse();
  }

  async getRun(runId: string): Promise<GsxRunRecord> {
    this.ensureLoaded();
    const run = this.runs.find((r) => r.runId === runId);
    if (run === undefined) {
      throw new GsxError({
        code: GSX_ERROR_CODES.RUN_NOT_FOUND,
        message: `No run record with id ${runId}`,
        remediation: 'Run records are capped; list runs for the live window of history.',
      });
    }
    return run;
  }

  async getStats(scriptId?: string): Promise<GsxScriptStats[]> {
    this.ensureLoaded();
    const all = [...this.stats.values()];
    return scriptId === undefined ? all : all.filter((s) => s.scriptId === scriptId);
  }

  onEvent(handler: (event: GsxEvent) => void): () => void {
    if (this.config.eventSubscribe === undefined) {
      return () => undefined;
    }
    return this.config.eventSubscribe(handler);
  }

  // ─── internals ────────────────────────────────────────────────────────

  private statFor(scriptId: string): GsxScriptStats {
    let stat = this.stats.get(scriptId);
    if (stat === undefined) {
      stat = { scriptId, runs: 0, passes: 0, failures: 0, consecutiveFailures: 0 };
      this.stats.set(scriptId, stat);
    }
    return stat;
  }

  private resolveEnv(env?: Environment): Environment {
    const resolved = env ?? DEFAULT_ENV;
    if (!(SUPPORTED_ENVIRONMENTS as readonly string[]).includes(resolved)) {
      throw new GsxError({
        code: GSX_ERROR_CODES.UNSUPPORTED_ENV,
        message: `Environment "${resolved}" is not supported`,
        remediation: `Use one of: ${SUPPORTED_ENVIRONMENTS.join(', ')}.`,
      });
    }
    return resolved;
  }

  /** Resolve a possibly-relative URL against the env's studio origin. */
  private resolveUrl(env: Environment, url?: string): string {
    const origin = GSX_STUDIO_ORIGIN_TEMPLATE.replace('{env}', env);
    const accountId = this.config.accountId(env) ?? '';
    const raw = url === undefined || url.length === 0 ? `${origin}/?accountId={accountId}` : url;
    const substituted = raw
      .replace(/\{env\}/g, env)
      .replace(/\{accountId\}/g, accountId);
    return substituted.startsWith('/') ? `${origin}${substituted}` : substituted;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    const dir = this.config.persistDir();
    if (dir === null) return;
    const file = path.join(dir, PERSIST_FILENAME);
    try {
      if (!fs.existsSync(file)) return;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as GsxPersistedState;
      if (parsed.schemaVersion !== 1) return;
      for (const script of parsed.learnedScripts ?? []) {
        try {
          this.learned.set(script.id, validateScript(script));
        } catch {
          this.config.logger('warn', 'dropping invalid persisted script', { id: script?.id });
        }
      }
      for (const stat of parsed.stats ?? []) this.stats.set(stat.scriptId, stat);
      this.runs = Array.isArray(parsed.runs) ? parsed.runs.slice(-GSX_MAX_RUN_RECORDS) : [];
      for (const agent of parsed.agents ?? []) {
        if (typeof agent?.name === 'string' && typeof agent?.scriptId === 'string') {
          this.agents.set(agent.name, agent);
        }
      }
    } catch (err) {
      this.config.logger('warn', 'failed to load persisted gsx state', {
        error: (err as Error).message,
      });
    }
  }

  private persist(): void {
    const dir = this.config.persistDir();
    if (dir === null) return;
    const file = path.join(dir, PERSIST_FILENAME);
    const state: GsxPersistedState = {
      schemaVersion: 1,
      learnedScripts: [...this.learned.values()],
      stats: [...this.stats.values()],
      runs: this.runs.slice(-GSX_MAX_RUN_RECORDS),
      agents: [...this.agents.values()],
    };
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf-8');
    } catch (err) {
      // Soft-fail (GSX_PERSIST_FAILED is the code consumers would see if
      // we ever choose to surface this; today it only logs).
      this.config.logger('error', 'failed to persist gsx state', {
        code: GSX_ERROR_CODES.PERSIST_FAILED,
        error: (err as Error).message,
      });
    }
  }
}

/** `gsx.open-window.start` -> `gsx.open-window` (span base name). */
function stripSpanSuffix(startName: string): string {
  return startName.replace(/\.start$/, '');
}

/**
 * Validate one drained page event into a typed {@link GsxRecordedEvent}
 * (or null). The page world is untrusted; only expected shapes with
 * bounded strings survive.
 */
function sanitizeRecordedEvent(raw: unknown): GsxRecordedEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (e.type !== 'click' && e.type !== 'fill') return null;
  const candidates = Array.isArray(e.candidates)
    ? (e.candidates as unknown[])
        .filter((c): c is string => typeof c === 'string' && c.length > 0 && c.length <= 300)
        .slice(0, 3)
    : [];
  if (candidates.length === 0) return null;
  const str = (v: unknown, max: number): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined;
  const text = str(e.text, 80);
  const label = str(e.label, 80);
  const tag = str(e.tag, 20);
  if (e.type === 'fill') {
    return {
      type: 'fill',
      candidates,
      value: typeof e.value === 'string' ? e.value.slice(0, 200) : '',
      ...(label !== undefined ? { label } : {}),
      ...(tag !== undefined ? { tag } : {}),
    };
  }
  return {
    type: 'click',
    candidates,
    ...(text !== undefined ? { text } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(tag !== undefined ? { tag } : {}),
  };
}
