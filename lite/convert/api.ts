/**
 * Convert API — the module's public surface (Rule 11 / Rule 12, ADR-100).
 *
 * Wraps {@link ConvertService} with the app's spans so every run shows up
 * in /logs?category=convert as `convert.run.start|finish|fail`. The MCP
 * server (`lite/mcp/convert-mcp.ts`) runs the same service without this
 * wrapper, in its own process.
 *
 * @example
 *   const html = await getConvertApi().convert({ input: md, from: 'md', to: 'html' });
 */

import { getLoggingApi } from '../logging/api.js';
import type { EventRecord, Span } from '../logging/events.js';
import { ConvertService } from './service.js';
import { createDefaultRegistry } from './converters/index.js';
import { isConvertEvent, type ConvertEvent } from './events.js';
import type { Capabilities, ConvertRequest, ConvertResult, PipelinePlan } from './types.js';

export { ConvertError, CONVERT_ERROR_CODES } from './errors.js';
export type { ConvertErrorCode } from './errors.js';
export type { Capabilities, ConvertRequest, ConvertResult, PipelinePlan, ConvertStep, Converter, ConverterSpec } from './types.js';

export interface ConvertApi {
  /** Convert text between formats; resolves a pipeline when no direct converter exists. */
  convert(req: ConvertRequest): Promise<ConvertResult>;
  /** The steps a from → to conversion would take. Throws for unknown or unreachable formats. */
  pipeline(from: string, to: string): PipelinePlan;
  /** Formats, converters, strategies, reachable pairs. */
  capabilities(): Capabilities;
  /** Subscribe to typed convert events (ADR-032). */
  onEvent(handler: (event: ConvertEvent) => void): () => void;
}

type SpanEmitter = (name: string, data?: unknown) => Span;

class LoggedConvertApi implements ConvertApi {
  constructor(
    private readonly service: ConvertService,
    private readonly spanEmitter: SpanEmitter | null,
    private readonly subscribe: (pattern: string, handler: (event: EventRecord) => void) => () => void
  ) {}

  async convert(req: ConvertRequest): Promise<ConvertResult> {
    const inputBytes = typeof req.input === 'string' ? Buffer.byteLength(req.input, 'utf8') : 0;
    // One span per run: convert.run.start / .finish / .fail (ADR-030).
    const span = this.spanEmitter?.('convert.run', {
      from: req.from,
      to: req.to,
      inputBytes,
      ...(req.strategy !== undefined ? { strategy: req.strategy } : {}),
    });
    try {
      const result = await this.service.convert(req);
      span?.finish({
        pipeline: result.steps.map((s) => s.converterId),
        outputBytes: result.outputBytes,
        durationMs: result.durationMs,
        warnings: result.warnings.length,
      });
      return result;
    } catch (err) {
      span?.fail(err);
      throw err;
    }
  }

  pipeline(from: string, to: string): PipelinePlan {
    return this.service.pipeline(from, to);
  }

  capabilities(): Capabilities {
    return this.service.capabilities();
  }

  onEvent(handler: (event: ConvertEvent) => void): () => void {
    return this.subscribe('convert.*', (record) => {
      if (isConvertEvent(record)) handler(record);
    });
  }
}

let _instance: ConvertApi | null = null;

/** Get the singleton convert API. Lazily instantiates on first call. */
export function getConvertApi(): ConvertApi {
  if (_instance === null) {
    _instance = new LoggedConvertApi(
      new ConvertService({ registry: createDefaultRegistry() }),
      (name, data) => getLoggingApi().start(name, data),
      (pattern, handler) => getLoggingApi().onEvent(pattern, handler)
    );
  }
  return _instance;
}

/** Reset the singleton (for tests). */
export function _resetConvertApiForTesting(): void {
  _instance = null;
}

/** Override the singleton with a custom implementation (for tests). */
export function _setConvertApiForTesting(api: ConvertApi): void {
  _instance = api;
}

/**
 * @internal — build an instance on injected seams (a fake span emitter,
 * a fake subscription) without touching the singleton.
 */
export function _buildConvertApiForTesting(deps: {
  service?: ConvertService;
  spanEmitter?: SpanEmitter;
  subscribe?: (pattern: string, handler: (event: EventRecord) => void) => () => void;
}): ConvertApi {
  return new LoggedConvertApi(
    deps.service ?? new ConvertService({ registry: createDefaultRegistry() }),
    deps.spanEmitter ?? ((name, data) => getLoggingApi().start(name, data)),
    deps.subscribe ?? ((pattern, handler) => getLoggingApi().onEvent(pattern, handler))
  );
}
