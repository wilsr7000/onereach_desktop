/**
 * ConvertService (ADR-100): validate a request, resolve the pipeline,
 * run the steps, report. No Electron, no logging imports — the api.ts
 * singleton wraps it with spans for the app; the MCP server runs it
 * bare in its own process.
 */

import { ConvertError, CONVERT_ERROR_CODES } from './errors.js';
import { ConverterRegistry, formatSpec, mimeTypeFor, normalizeFormat } from './registry.js';
import {
  MAX_INPUT_BYTES,
  type Capabilities,
  type ConvertRequest,
  type ConvertResult,
  type ConvertStep,
  type Converter,
  type PipelinePlan,
} from './types.js';

export interface ConvertServiceOptions {
  registry: ConverterRegistry;
  /** Override for tests. */
  now?: () => number;
  maxInputBytes?: number;
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

export class ConvertService {
  private readonly registry: ConverterRegistry;
  private readonly now: () => number;
  private readonly maxInputBytes: number;

  constructor(opts: ConvertServiceOptions) {
    this.registry = opts.registry;
    this.now = opts.now ?? ((): number => Date.now());
    this.maxInputBytes = opts.maxInputBytes ?? MAX_INPUT_BYTES;
  }

  capabilities(): Capabilities {
    return this.registry.capabilities();
  }

  /** The plan for a pair, with formats normalised. Throws on unknown / unreachable. */
  pipeline(fromRaw: string, toRaw: string): PipelinePlan {
    const from = this.format(fromRaw, 'from');
    const to = this.format(toRaw, 'to');
    const plan = this.registry.resolve(from, to);
    if (plan === null) {
      throw new ConvertError({
        code: CONVERT_ERROR_CODES.NO_PATH,
        message: `No conversion from ${from} to ${to}`,
        remediation: 'Call convert_capabilities to see the reachable pairs.',
        context: { from, to },
      });
    }
    return plan;
  }

  async convert(req: ConvertRequest): Promise<ConvertResult> {
    const started = this.now();
    if (typeof req.input !== 'string') {
      throw new ConvertError({
        code: CONVERT_ERROR_CODES.INVALID_INPUT,
        message: 'input must be a string',
        remediation: 'Pass the content as text (decode files first).',
        context: { inputType: typeof req.input },
      });
    }
    const inputBytes = byteLength(req.input);
    if (inputBytes > this.maxInputBytes) {
      throw new ConvertError({
        code: CONVERT_ERROR_CODES.TOO_LARGE,
        message: `input is ${inputBytes} bytes; the cap is ${this.maxInputBytes}`,
        remediation: 'Split the content or convert a smaller excerpt.',
        context: { inputBytes, max: this.maxInputBytes },
      });
    }
    const plan = this.pipeline(req.from, req.to);
    const warnings: string[] = [];
    const steps: ConvertStep[] = [];
    if (plan.steps.length === 0) {
      warnings.push(`${plan.from} to ${plan.to} is the same format; the input was returned unchanged.`);
      return this.result(req.input, plan, steps, warnings, inputBytes, started);
    }
    const requestedStrategy = typeof req.strategy === 'string' && req.strategy.trim().length > 0 ? req.strategy.trim() : null;
    if (requestedStrategy !== null && plan.steps.length > 1) {
      warnings.push(
        `strategy "${requestedStrategy}" applies to a single converter; this conversion runs ${plan.steps.length} steps (${plan.steps.map((s) => s.converterId).join(' → ')}) with their defaults.`
      );
    }
    const optionKeys = req.options !== null && typeof req.options === 'object' ? Object.keys(req.options) : [];
    if (optionKeys.length > 0 && plan.steps.length > 1) {
      warnings.push(
        `options {${optionKeys.join(', ')}} are offered to every step of this ${plan.steps.length}-step pipeline (${plan.steps.map((s) => s.converterId).join(' → ')}); each converter honours only the options it declares.`
      );
    }
    let current = req.input;
    for (const [index, step] of plan.steps.entries()) {
      const converter = this.registry.get(step.converterId) as Converter;
      // Amendment 1: a converter's own cap (the markup renderers stop at 2 MB) applies to what reaches it, step by step.
      const stepCap = Math.min(converter.spec.maxInputBytes ?? Number.POSITIVE_INFINITY, this.maxInputBytes);
      const stepBytes = index === 0 ? inputBytes : byteLength(current);
      if (stepBytes > stepCap) {
        throw new ConvertError({
          code: CONVERT_ERROR_CODES.TOO_LARGE,
          message: `${converter.spec.id} takes at most ${stepCap} bytes; ${index === 0 ? 'the input' : `step ${index + 1}'s input`} is ${stepBytes}`,
          remediation: 'Split the content or convert a smaller excerpt.',
          context: { converterId: converter.spec.id, inputBytes: stepBytes, max: stepCap, step: index + 1, of: plan.steps.length },
        });
      }
      const strategy = plan.steps.length === 1 && requestedStrategy !== null ? requestedStrategy : converter.spec.defaultStrategy;
      if (!converter.spec.strategies.some((s) => s.id === strategy)) {
        throw new ConvertError({
          code: CONVERT_ERROR_CODES.UNKNOWN_STRATEGY,
          message: `converter ${converter.spec.id} has no strategy "${strategy}"`,
          remediation: `Use one of: ${converter.spec.strategies.map((s) => s.id).join(', ')}.`,
          context: { converterId: converter.spec.id, strategy },
        });
      }
      const options = mergeOptions(converter, req.options);
      const t0 = this.now();
      try {
        const out = await converter.execute(current, strategy, options, { from: step.from, to: step.to, step: index + 1, of: plan.steps.length });
        if (typeof out.output !== 'string') {
          throw new Error(`converter ${converter.spec.id} produced ${typeof out.output}`);
        }
        current = out.output;
        steps.push({
          converterId: converter.spec.id,
          from: step.from,
          to: step.to,
          strategy,
          durationMs: this.now() - t0,
          stats: out.stats ?? {},
        });
        for (const w of out.warnings ?? []) warnings.push(`${converter.spec.id}: ${w}`);
      } catch (err) {
        if (err instanceof ConvertError) throw err;
        throw new ConvertError({
          code: CONVERT_ERROR_CODES.FAILED,
          message: `${converter.spec.id} failed: ${err instanceof Error ? err.message : String(err)}`,
          remediation: 'Check the input is really the source format, or try another strategy.',
          context: { converterId: converter.spec.id, strategy, step: steps.length + 1, of: plan.steps.length },
          cause: err,
        });
      }
    }
    return this.result(current, plan, steps, warnings, inputBytes, started);
  }

  private result(
    output: string,
    plan: PipelinePlan,
    steps: ConvertStep[],
    warnings: string[],
    inputBytes: number,
    started: number
  ): ConvertResult {
    return {
      output,
      from: plan.from,
      to: plan.to,
      mimeType: mimeTypeFor(plan.to),
      steps,
      durationMs: this.now() - started,
      warnings,
      inputBytes,
      outputBytes: byteLength(output),
    };
  }

  private format(raw: string, which: 'from' | 'to'): string {
    const id = normalizeFormat(raw);
    if (id === null || formatSpec(id) === null) {
      throw new ConvertError({
        code: CONVERT_ERROR_CODES.UNKNOWN_FORMAT,
        message: `unknown ${which} format "${String(raw)}"`,
        remediation: 'Use a format id from convert_capabilities (md, html, text, csv, tsv, json, yaml, ipynb, py, code).',
        context: { [which]: raw },
      });
    }
    return id;
  }
}

/** Keys that would reach the prototype instead of the options (JSON.parse keeps an own `__proto__`). */
const UNSAFE_OPTION_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** The caller's options over the converter's declared defaults; prototype-shaped keys are dropped. */
export function mergeOptions(converter: Converter, given: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const o of converter.spec.options ?? []) {
    if (o.default !== undefined) out[o.name] = o.default;
  }
  if (given !== null && typeof given === 'object') {
    for (const [k, v] of Object.entries(given)) {
      if (v !== undefined && !UNSAFE_OPTION_KEYS.has(k)) out[k] = v;
    }
  }
  return out;
}
