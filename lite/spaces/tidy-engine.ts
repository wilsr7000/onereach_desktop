/**
 * ADR-099 — the groomer's engine: the store (`spaces-tidy.json` in
 * userData), the model call, decisions, applying accepted moves through
 * the Spaces API, and the background cadence. The pure parts live in
 * `tidy.ts`; this file is the only one that touches disk, the model or
 * the graph.
 *
 * The person leaves the marks: `plan()` proposes, `decide()` records,
 * `apply()` runs ONLY moves marked accepted — through the same API calls
 * the Spaces window makes, so every guard those calls carry applies.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_TIDY_SETTINGS,
  TIDY_FEATURE,
  applyOrder,
  applyTidyMove,
  buildTidyPrompt,
  describeMove,
  normalizeTidySettings,
  parseTidyPlan,
  shouldRunScheduled,
  topLevelCount,
  type TidyApplyPorts,
  type TidyDecision,
  type TidyMove,
  type TidyPlan,
  type TidySettings,
  type TidyState,
} from './tidy.js';
import type { TidySpaceEvidence } from './types.js';

export const TIDY_STORE_FILENAME = 'spaces-tidy.json';
export const SPACES_TIDY_UPDATED_EVENT = 'lite:spaces:tidy-updated';

interface StoredDecision {
  decision: TidyDecision;
  at: string;
  /** A one-line description, so a rejected move can be shown to the model as words. */
  summary: string;
}

interface TidyStore {
  settings: TidySettings;
  lastRunAt: string | null;
  plan: TidyPlan | null;
  decisions: Record<string, StoredDecision>;
}

export interface TidyEngineDeps {
  /** Where the store lives; null = memory only (tests, signed-out). */
  configDir: string | null;
  evidence: () => Promise<TidySpaceEvidence[]>;
  chat: (input: {
    system: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    maxTokens?: number;
    jsonMode?: boolean;
    profile?: 'fast' | 'standard' | 'powerful' | 'large' | 'vision';
    feature?: string;
  }) => Promise<{ content: string; model: string; provider: string }>;
  ports: TidyApplyPorts;
  viewerId: () => string | null;
  log: {
    info: (message: string, data?: unknown) => void;
    warn: (message: string, data?: unknown) => void;
  };
  broadcast: (state: TidyState) => void;
  now?: () => Date;
}

function emptyStore(): TidyStore {
  return { settings: { ...DEFAULT_TIDY_SETTINGS }, lastRunAt: null, plan: null, decisions: {} };
}

function readStore(configDir: string | null): TidyStore {
  if (configDir === null) return emptyStore();
  try {
    const raw = JSON.parse(readFileSync(join(configDir, TIDY_STORE_FILENAME), 'utf8')) as Partial<TidyStore>;
    const store = emptyStore();
    store.settings = normalizeTidySettings(raw.settings);
    store.lastRunAt = typeof raw.lastRunAt === 'string' ? raw.lastRunAt : null;
    store.plan = raw.plan !== null && typeof raw.plan === 'object' && Array.isArray((raw.plan as TidyPlan).moves) ? (raw.plan as TidyPlan) : null;
    store.decisions = raw.decisions !== null && typeof raw.decisions === 'object' ? (raw.decisions as Record<string, StoredDecision>) : {};
    return store;
  } catch {
    return emptyStore();
  }
}

function writeStore(configDir: string | null, store: TidyStore): void {
  if (configDir === null) return;
  mkdirSync(configDir, { recursive: true });
  const target = join(configDir, TIDY_STORE_FILENAME);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  renameSync(tmp, target);
}

export class TidyEngine {
  private store: TidyStore;
  private running = false;
  private lastError: string | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstTick: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<TidyState> | null = null;

  constructor(private readonly deps: TidyEngineDeps) {
    this.store = readStore(deps.configDir);
  }

  state(): TidyState {
    const plan = this.store.plan;
    const pending = plan === null ? 0 : plan.moves.filter((m) => m.decision === 'undecided' && m.applied !== true).length;
    return {
      settings: { ...this.store.settings },
      lastRunAt: this.store.lastRunAt,
      running: this.running,
      plan,
      pending,
      ...(this.lastError !== undefined ? { error: this.lastError } : {}),
    };
  }

  settings(patch?: Partial<TidySettings>): TidySettings {
    if (patch !== undefined) {
      this.store.settings = normalizeTidySettings(patch, this.store.settings);
      this.persist();
      this.deps.broadcast(this.state());
    }
    return { ...this.store.settings };
  }

  /** Prepare a plan now. Concurrent calls share one run. */
  plan(trigger: 'manual' | 'scheduled'): Promise<TidyState> {
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = this.runPlan(trigger).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runPlan(trigger: 'manual' | 'scheduled'): Promise<TidyState> {
    const viewer = this.deps.viewerId();
    if (viewer === null || viewer.length === 0) {
      this.lastError = 'Sign in to Onereach to tidy up your Spaces.';
      return this.state();
    }
    this.running = true;
    this.lastError = undefined;
    this.deps.broadcast(this.state());
    const now = (this.deps.now ?? (() => new Date()))();
    try {
      const evidence = await this.deps.evidence();
      const rejectedKeys = new Set(
        Object.entries(this.store.decisions)
          .filter(([, d]) => d.decision === 'rejected')
          .map(([k]) => k)
      );
      const rejected = Object.values(this.store.decisions)
        .filter((d) => d.decision === 'rejected')
        .map((d) => d.summary)
        .slice(-40);
      const prompt = buildTidyPrompt({ evidence, rejected, viewerId: viewer, now });
      const answer = await this.deps.chat({
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
        maxTokens: 6000,
        jsonMode: true,
        profile: this.store.settings.profile,
        feature: TIDY_FEATURE,
      });
      const parsed = parseTidyPlan(answer.content, { evidence, rejectedKeys });
      // A move already applied from an earlier plan never comes back.
      const applied = new Set(
        Object.entries(this.store.decisions)
          .filter(([, d]) => d.decision === 'accepted')
          .map(([k]) => k)
      );
      const moves = parsed.moves.filter((m) => !applied.has(m.key));
      this.store.plan = {
        createdAt: now.toISOString(),
        model: answer.model,
        provider: answer.provider,
        summary: parsed.summary,
        topLevelCount: topLevelCount(evidence),
        spaceCount: evidence.length,
        moves,
      };
      this.store.lastRunAt = now.toISOString();
      this.persist();
      this.deps.log.info('spaces-tidy: plan ready', {
        trigger,
        model: answer.model,
        spaces: evidence.length,
        moves: moves.length,
        dropped: parsed.dropped.length,
        ...(parsed.dropped.length > 0 ? { droppedWhy: parsed.dropped.slice(0, 10) } : {}),
      });
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.deps.log.warn('spaces-tidy: plan failed', { trigger, error: this.lastError });
    } finally {
      this.running = false;
      this.deps.broadcast(this.state());
    }
    return this.state();
  }

  decide(moveKey: string, decision: TidyDecision): TidyState {
    const plan = this.store.plan;
    const move = plan?.moves.find((m) => m.key === moveKey);
    if (plan === null || move === undefined) return this.state();
    if (move.applied === true) return this.state();
    move.decision = decision;
    if (decision === 'undecided') delete this.store.decisions[moveKey];
    else {
      this.store.decisions[moveKey] = {
        decision,
        at: new Date().toISOString(),
        summary: describeMove(move),
      };
    }
    this.persist();
    this.deps.broadcast(this.state());
    return this.state();
  }

  /** Run every accepted, not-yet-applied move, in a safe order; failures stay on the move. */
  async apply(): Promise<TidyState> {
    const plan = this.store.plan;
    if (plan === null) return this.state();
    const todo = applyOrder(plan.moves.filter((m) => m.decision === 'accepted' && m.applied !== true));
    if (todo.length === 0) return this.state();
    this.running = true;
    this.deps.broadcast(this.state());
    let ok = 0;
    for (const move of todo) {
      try {
        await applyTidyMove(move, this.deps.ports);
        move.applied = true;
        delete move.error;
        ok += 1;
      } catch (err) {
        move.error = err instanceof Error ? err.message : String(err);
        this.deps.log.warn('spaces-tidy: move failed', { move: describeMove(move), error: move.error });
      }
      this.persist();
    }
    this.running = false;
    this.deps.log.info('spaces-tidy: applied', { accepted: todo.length, ok, failed: todo.length - ok });
    this.deps.broadcast(this.state());
    return this.state();
  }

  /** The background cadence: check every `intervalMs`, plan when the rule says so. */
  start(
    intervalMs: number,
    countTopLevel: () => Promise<{ topLevel: number; spaceCount: number } | null>,
    initialDelayMs = 90_000
  ): void {
    this.stop();
    const tick = async (): Promise<void> => {
      if (this.inFlight !== null || this.running) return;
      const viewer = this.deps.viewerId();
      if (viewer === null || viewer.length === 0) return;
      let counts: { topLevel: number; spaceCount: number } | null = null;
      try {
        counts = await countTopLevel();
      } catch {
        counts = null;
      }
      if (counts === null) return;
      const now = (this.deps.now ?? (() => new Date()))();
      if (!shouldRunScheduled({ settings: this.store.settings, lastRunAt: this.store.lastRunAt, now, ...counts })) return;
      await this.plan('scheduled');
    };
    this.timer = setInterval(() => {
      void tick();
    }, intervalMs);
    this.timer.unref?.();
    this.firstTick = setTimeout(() => {
      this.firstTick = null;
      void tick();
    }, initialDelayMs);
    this.firstTick.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.firstTick !== null) {
      clearTimeout(this.firstTick);
      this.firstTick = null;
    }
  }

  private persist(): void {
    try {
      writeStore(this.deps.configDir, this.store);
    } catch (err) {
      this.deps.log.warn('spaces-tidy: could not save', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

let engine: TidyEngine | null = null;

export function getTidyEngine(): TidyEngine | null {
  return engine;
}

export function _setTidyEngine(next: TidyEngine | null): void {
  engine?.stop();
  engine = next;
}

/** The moves a plan still needs a decision on — for a badge. */
export function pendingMoves(plan: TidyPlan | null): TidyMove[] {
  return plan === null ? [] : plan.moves.filter((m) => m.decision === 'undecided' && m.applied !== true);
}
