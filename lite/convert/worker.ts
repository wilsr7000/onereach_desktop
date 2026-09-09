/**
 * The convert worker (ADR-100 Amendment 1): one conversion per thread.
 * Spawned by WorkerConvertService with the request as workerData; posts
 * a {@link WorkerReply} and exits. Bundled on its own by esbuild to
 * dist-lite/build/convert-worker.js, beside convert-mcp.js. Also
 * importable — the runner's tests bundle it and drive it for real.
 */

import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { ConvertService } from './service.js';
import { createDefaultRegistry } from './converters/index.js';
import { ConvertError } from './errors.js';
import type { ConvertRequest } from './types.js';
import type { SerializedConvertError, WorkerReply } from './worker-runner.js';

export function serializeError(err: unknown): SerializedConvertError {
  if (err instanceof ConvertError) {
    return { code: err.code, message: err.message, remediation: err.remediation, context: { ...err.context } };
  }
  return {
    code: 'CONVERT_FAILED',
    message: err instanceof Error ? err.message : String(err),
    remediation: 'Check the input is really the source format, or try another strategy.',
    context: {},
  };
}

/** Run one request against a fresh service; never throws. */
export async function runWorkerRequest(req: ConvertRequest): Promise<WorkerReply> {
  try {
    const result = await new ConvertService({ registry: createDefaultRegistry() }).convert(req);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: serializeError(err) };
  }
}

if (!isMainThread && parentPort !== null) {
  const port = parentPort;
  const data = workerData as { req?: ConvertRequest } | undefined;
  const req = data?.req;
  if (req === undefined) {
    port.postMessage({ ok: false, error: { code: 'CONVERT_INVALID_INPUT', message: 'worker started without a request', remediation: '', context: {} } } satisfies WorkerReply);
  } else {
    void runWorkerRequest(req).then((reply) => port.postMessage(reply));
  }
}
