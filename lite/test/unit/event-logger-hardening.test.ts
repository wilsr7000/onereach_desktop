/**
 * EventLogger hardening tests (root `event-logger.js` -- the file writer
 * behind the lib LogEventQueue that both full and lite persist through).
 *
 * Motivated by the 2026-08-12 v0.0.60 incident: the installed app's log
 * file went silent mid-session while the app stayed up, and a same-evening
 * log flood (465k entries / 6.5s) rotated the file 6 times in 6 seconds,
 * whose cleanup deleted the whole log history including an ACTIVE file.
 *
 * Failure modes pinned here:
 *   1. Ghost-inode writes: current file unlinked externally -> the old
 *      writer kept writing to the deleted inode forever (rotation was
 *      gated on existsSync(currentLogFile), so it never re-armed).
 *   2. Dead stream: a stream error left flush() throwing forever with an
 *      unbounded buffer and no reopen attempt.
 *   3. Rotation storms: floods rotated several times per second; cleanup
 *      sorted by second-granular mtime with unstable ties and could
 *      delete the active file.
 *   4. Flood amplification: per-entry statSync + per-error flush; no cap
 *      on entries reaching disk.
 *   5. Silence ambiguity: no heartbeat, so "writer died" and "app died"
 *      were indistinguishable post-hoc; event-loop stalls left no trace.
 *   6. `Unhandled Rejection` entries serialized Errors as `{}`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const requireCjs = createRequire(import.meta.url);

interface EventLoggerOptions {
  logDir?: string;
  appVersion?: string;
  installProcessHooks?: boolean;
  maxLogSize?: number;
  maxLogFiles?: number;
  flushIntervalMs?: number;
  rotateCooldownMs?: number;
  floodRatePerSec?: number;
  floodBurst?: number;
  errorRatePerSec?: number;
  errorBurst?: number;
  maxBufferBytes?: number;
  heartbeatEveryTicks?: number;
}

interface EventLoggerLike {
  currentLogFile: string | null;
  logDir: string;
  logStream: NodeJS.EventEmitter | null;
  logBuffer: string[];
  _streamDead: boolean;
  _lastTickAt: number;
  _droppedTotal: number;
  info(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  flush(): void;
  destroy(): void;
  cleanupOldLogs(): void;
  _onFlushTick(): void;
  _flushed(): Promise<void>;
}

const eventLoggerModule = requireCjs('../../../event-logger.js') as {
  EventLogger: new (options?: EventLoggerOptions) => EventLoggerLike;
  serializeErrorish: (value: unknown) => Record<string, unknown>;
};
const { EventLogger, serializeErrorish } = eventLoggerModule;

interface LogLine {
  timestamp: string;
  level: string;
  message: string;
  [key: string]: unknown;
}

let dir: string;
let logger: EventLoggerLike | null = null;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'event-logger-test-'));
});

afterEach(() => {
  if (logger !== null) {
    logger.destroy();
    logger = null;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeLogger(options: EventLoggerOptions = {}): EventLoggerLike {
  logger = new EventLogger({
    logDir: dir,
    appVersion: '0.0.0-test',
    installProcessHooks: false,
    ...options,
  });
  return logger;
}

function listLogFiles(): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('onereach-') && f.endsWith('.log'))
    .sort();
}

function parseFile(filePath: string): LogLine[] {
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LogLine);
}

function allEntries(): LogLine[] {
  return listLogFiles().flatMap((f) => parseFile(path.join(dir, f)));
}

describe('EventLogger basics', () => {
  it('writes JSON lines to the current log file on flush', async () => {
    const log = makeLogger();
    log.info('hello world', { a: 1 });
    log.flush();
    await log._flushed();

    const entries = parseFile(log.currentLogFile as string);
    const banner = entries.find((e) => e.message === 'Logger initialized');
    const hello = entries.find((e) => e.message === 'hello world');
    expect(banner).toBeDefined();
    expect(banner?.['appVersion']).toBe('0.0.0-test');
    expect(hello?.['a']).toBe(1);
    expect(hello?.level).toBe('INFO');
  });
});

describe('ghost-file self-heal', () => {
  it('reopens a fresh file when the current one is unlinked externally', async () => {
    const log = makeLogger();
    log.info('before unlink');
    log.flush();
    await log._flushed();

    const oldFile = log.currentLogFile as string;
    fs.unlinkSync(oldFile);

    // These land in the buffer; the tick must carry them into a NEW file
    // rather than flushing them into the unlinked inode.
    log.info('after unlink');
    log._onFlushTick();
    await log._flushed();

    // The name may be reused (the unlink freed it) -- what matters is a
    // real directory entry exists again and receives the buffered lines.
    const newFile = log.currentLogFile as string;
    expect(fs.existsSync(newFile)).toBe(true);

    const entries = parseFile(newFile);
    expect(entries.some((e) => e.message === 'Logger recovered')).toBe(true);
    expect(entries.some((e) => e.message === 'after unlink')).toBe(true);

    // And the writer keeps working afterwards.
    log.info('later still');
    log.flush();
    await log._flushed();
    expect(parseFile(newFile).some((e) => e.message === 'later still')).toBe(true);
  });

  it('reopens after a stream error instead of dying silently', async () => {
    const log = makeLogger();
    // Simulate ENOSPC/EIO: the stream emits 'error'. Must not throw (an
    // unhandled 'error' event would crash the process).
    log.logStream?.emit('error', new Error('simulated EIO'));
    expect(log._streamDead).toBe(true);

    log.info('written while dead');
    log.flush(); // no-op on a dead stream; buffer retained
    log._onFlushTick(); // recovery: reopen + drain
    await log._flushed();

    expect(log._streamDead).toBe(false);
    const entries = allEntries();
    expect(entries.some((e) => e.message === 'Logger recovered')).toBe(true);
    expect(entries.some((e) => e.message === 'written while dead')).toBe(true);
  });
});

describe('rotation-storm guards', () => {
  it('size-based rotation honors the cooldown', () => {
    const log = makeLogger({ maxLogSize: 400, rotateCooldownMs: 60_000 });
    for (let i = 0; i < 5; i++) {
      log.info(`entry ${i} ${'x'.repeat(300)}`);
      log.flush();
    }
    // Size is exceeded but the startup rotation is < 60s old: no storm.
    expect(listLogFiles()).toHaveLength(1);
  });

  it('rotates on size when the cooldown allows it, without filename reuse', () => {
    const log = makeLogger({ maxLogSize: 400, rotateCooldownMs: 0 });
    for (let i = 0; i < 4; i++) {
      log.info(`entry ${i} ${'x'.repeat(300)}`);
      log.flush();
    }
    const files = listLogFiles();
    // One file per oversized write; same-second rotations get a suffix
    // instead of silently appending to the same name.
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(new Set(files).size).toBe(files.length);
  });

  it('cleanup never deletes the active file or recently-modified siblings', () => {
    const log = makeLogger({ maxLogFiles: 1 });

    // A sibling instance's active file: fresh mtime.
    const sibling = path.join(dir, 'onereach-1999-01-01_00-00-00.log');
    fs.writeFileSync(sibling, '{"sibling":true}\n');

    // Six stale files from past sessions.
    const staleTime = new Date(Date.now() - 60 * 60 * 1000);
    for (let i = 1; i <= 6; i++) {
      const stale = path.join(dir, `onereach-2020-01-0${i}_00-00-00.log`);
      fs.writeFileSync(stale, '{"stale":true}\n');
      fs.utimesSync(stale, staleTime, staleTime);
    }

    log.cleanupOldLogs();

    const survivors = listLogFiles().map((f) => path.join(dir, f));
    expect(survivors).toContain(log.currentLogFile);
    expect(survivors).toContain(sibling);
    // All six stale files were eligible and got trimmed.
    expect(survivors.filter((f) => f.includes('onereach-2020-'))).toHaveLength(0);
  });
});

describe('flood guard', () => {
  it('caps entries reaching disk, preserves errors, and reports drops', async () => {
    const log = makeLogger({
      floodRatePerSec: 1,
      floodBurst: 10,
      errorRatePerSec: 1,
      errorBurst: 5,
    });

    for (let i = 0; i < 200; i++) {
      log.info(`flood ${i}`);
    }
    for (let i = 0; i < 3; i++) {
      log.error(`failure ${i}`);
    }
    log._onFlushTick();
    await log._flushed();

    const entries = allEntries();
    const floodLines = entries.filter((e) => e.message.startsWith('flood '));
    const errorLines = entries.filter((e) => e.message.startsWith('failure '));
    const summary = entries.find((e) =>
      e.message.startsWith('Log flood: entries dropped')
    );

    expect(floodLines.length).toBeLessThanOrEqual(12);
    expect(errorLines).toHaveLength(3); // reserved error budget
    expect(summary).toBeDefined();
    expect(summary?.['dropped']).toBeGreaterThanOrEqual(180);
    expect(log._droppedTotal).toBeGreaterThanOrEqual(180);
  });

  it('bounds the in-memory buffer while the stream is dead', async () => {
    const log = makeLogger({
      maxBufferBytes: 2_000,
      floodRatePerSec: 100_000,
      floodBurst: 100_000,
    });
    log._streamDead = true;

    for (let i = 0; i < 100; i++) {
      log.info(`padded ${i} ${'y'.repeat(100)}`);
    }

    const bufferedBytes = log.logBuffer.reduce((sum, line) => sum + line.length, 0);
    expect(bufferedBytes).toBeLessThanOrEqual(2_000);
    expect(log._droppedTotal).toBeGreaterThan(0);

    // Recovery drains the retained tail into the new file.
    log._onFlushTick();
    await log._flushed();
    expect(allEntries().some((e) => e.message.startsWith('padded 99'))).toBe(true);
  });
});

describe('liveness heartbeat', () => {
  it('emits a heartbeat line every N ticks', async () => {
    const log = makeLogger({ heartbeatEveryTicks: 2 });
    log._onFlushTick();
    log._onFlushTick();
    await log._flushed();

    const beat = allEntries().find((e) => e.message === 'logger.heartbeat');
    expect(beat).toBeDefined();
    expect(typeof beat?.['uptimeSec']).toBe('number');
    expect(typeof beat?.['rotationsTotal']).toBe('number');
  });

  it('records the stall duration when a tick fires late', async () => {
    const log = makeLogger({ flushIntervalMs: 30_000 });
    log._lastTickAt = Date.now() - 90_000; // tick arrives ~60s late
    log._onFlushTick();
    await log._flushed();

    const stall = allEntries().find((e) =>
      e.message.startsWith('Event-loop stall detected')
    );
    expect(stall).toBeDefined();
    expect(stall?.['tickDelayMs']).toBeGreaterThanOrEqual(55_000);
  });
});

describe('serializeErrorish', () => {
  it('preserves Error name/message/stack (Errors JSON.stringify to {})', () => {
    const serialized = serializeErrorish(new Error('kv get timed out'));
    const roundTripped = JSON.parse(JSON.stringify(serialized)) as Record<string, unknown>;
    expect(roundTripped['message']).toBe('kv get timed out');
    expect(roundTripped['name']).toBe('Error');
    expect(typeof roundTripped['stack']).toBe('string');
  });

  it('passes plain objects through and stringifies the unserializable', () => {
    expect(serializeErrorish({ code: 500 })).toEqual({ code: 500 });
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(serializeErrorish(circular)).toHaveProperty('unserializable');
    expect(serializeErrorish('plain reason')).toEqual({ value: 'plain reason' });
  });
});
