/**
 * Worker-thread runner (ADR-100 Amendment 1).
 *
 * A conversion is synchronous JavaScript: once it starts, nothing on the
 * main thread can interrupt it, and the MCP server is one process per
 * client — the review wedged it for good with 2 MB of `<script`. So the
 * MCP server runs every conversion in a worker thread with a kill timer
 * and a heap limit: over budget, the worker is terminated and the caller
 * gets CONVERT_TIMEOUT; out of memory, the worker dies alone and the
 * caller gets CONVERT_FAILED. The cheap refusals (format, path, size)
 * stay in-process, so a bad request never pays for a thread.
 *
 * `capabilities()` and `pipeline()` answer from an in-process service;
 * only `convert()` crosses into the worker.
 */

import { Worker } from 'node:worker_threads';
import { ConvertError, CONVERT_ERROR_CODES, isConvertErrorCode } from './errors.js';
import { ConvertService } from './service.js';
import { createDefaultRegistry } from './converters/index.js';
import {
  DEFAULT_CONVERT_TIMEOUT_MS,
  MAX_CONVERT_TIMEOUT_MS,
  MAX_INPUT_BYTES,
  type Capabilities,
  type ConvertRequest,
  type ConvertResult,
  type PipelinePlan,
} from './types.js';

/** What the MCP tools need from a service — the in-process one or the worker-backed one. */
export type ConvertRunner = Pick<ConvertService, 'capabilities' | 'pipeline' | 'convert'>;

export interface SerializedConvertError {
  code: string;
  message: string;
  remediation: string;
  context: Record<string, unknown>;
}

export type WorkerReply = { ok: true; result: ConvertResult } | { ok: false; error: SerializedConvertError };

export interface WorkerConvertOptions {
  /** The bundled worker script (dist-lite/build/convert-worker.js beside the server). */
  workerPath: string;
  /** Wall-clock budget per conversion; the worker is terminated when it runs out. */
  timeoutMs?: number;
  /** V8 old-space limit for the worker; a run that exceeds it fails alone. */
  maxOldGenerationSizeMb?: number;
  maxInputBytes?: number;
}

/** CONVERT_TIMEOUT_MS as a budget: a whole number of milliseconds, 1 s to 120 s; anything else is the default. */
export function parseTimeoutMs(raw: string | undefined): number {
  const n = Number(raw);
  if (raw === undefined || raw.trim().length === 0 || !Number.isFinite(n) || n <= 0) return DEFAULT_CONVERT_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(n), 1000), MAX_CONVERT_TIMEOUT_MS);
}

function rehydrate(e: SerializedConvertError): ConvertError {
  return new ConvertError({
    code: isConvertErrorCode(e.code) ? e.code : CONVERT_ERROR_CODES.FAILED,
    message: e.message,
    remediation: e.remediation,
    context: e.context,
  });
}

export class WorkerConvertService implements ConvertRunner {
  private readonly local: ConvertService;
  readonly timeoutMs: number;
  private readonly maxOldGenerationSizeMb: number;

  constructor(private readonly opts: WorkerConvertOptions) {
    this.local = new ConvertService({
      registry: createDefaultRegistry(),
      ...(opts.maxInputBytes !== undefined ? { maxInputBytes: opts.maxInputBytes } : {}),
    });
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_CONVERT_TIMEOUT_MS;
    this.maxOldGenerationSizeMb = opts.maxOldGenerationSizeMb ?? 512;
  }

  capabilities(): Capabilities {
    return this.local.capabilities();
  }

  pipeline(from: string, to: string): PipelinePlan {
    return this.local.pipeline(from, to);
  }

  async convert(req: ConvertRequest): Promise<ConvertResult> {
    if (typeof req.input !== 'string') {
      throw new ConvertError({
        code: CONVERT_ERROR_CODES.INVALID_INPUT,
        message: 'input must be a string',
        remediation: 'Pass the content as text (decode files first).',
        context: { inputType: typeof req.input },
      });
    }
    // Unknown formats and unreachable pairs are refused here, without a thread.
    this.local.pipeline(req.from, req.to);
    const inputBytes = Buffer.byteLength(req.input, 'utf8');
    const max = this.opts.maxInputBytes ?? MAX_INPUT_BYTES;
    if (inputBytes > max) {
      throw new ConvertError({
        code: CONVERT_ERROR_CODES.TOO_LARGE,
        message: `input is ${inputBytes} bytes; the cap is ${max}`,
        remediation: 'Split the content or convert a smaller excerpt.',
        context: { inputBytes, max },
      });
    }
    return this.runInWorker(req, inputBytes);
  }

  private runInWorker(req: ConvertRequest, inputBytes: number): Promise<ConvertResult> {
    return new Promise<ConvertResult>((resolve, reject) => {
      const timeoutMs = this.timeoutMs;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const worker = new Worker(this.opts.workerPath, {
        workerData: { req },
        resourceLimits: { maxOldGenerationSizeMb: this.maxOldGenerationSizeMb },
      });
      const finish = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        void worker.terminate();
        outcome();
      };
      const context = { from: req.from, to: req.to, inputBytes, timeoutMs };
      timer = setTimeout(() => {
        finish(() =>
          reject(
            new ConvertError({
              code: CONVERT_ERROR_CODES.TIMEOUT,
              message: `conversion ${req.from} → ${req.to} exceeded its ${timeoutMs} ms budget and was stopped`,
              remediation: 'Convert a smaller excerpt, or raise CONVERT_TIMEOUT_MS for the MCP server (up to 120000).',
              context,
            })
          )
        );
      }, timeoutMs);
      worker.once('message', (reply: WorkerReply) => {
        finish(() => {
          if (reply.ok) resolve(reply.result);
          else reject(rehydrate(reply.error));
        });
      });
      worker.once('error', (err: Error) => {
        finish(() =>
          reject(
            new ConvertError({
              code: CONVERT_ERROR_CODES.FAILED,
              message: `conversion worker failed: ${err.message}`,
              remediation: 'Convert a smaller excerpt; a worker that runs out of memory fails alone.',
              context,
              cause: err,
            })
          )
        );
      });
      worker.once('exit', (code: number) => {
        finish(() =>
          reject(
            new ConvertError({
              code: CONVERT_ERROR_CODES.FAILED,
              message: `conversion worker exited with code ${code} before answering`,
              remediation: 'Try again; if it repeats, the worker bundle beside the server is broken (run npm run lite:build).',
              context: { ...context, exitCode: code },
            })
          )
        );
      });
    });
  }
}
