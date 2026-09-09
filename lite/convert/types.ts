/**
 * Convert module types (ADR-100).
 *
 * A converter turns one text format into another. The full Onereach app
 * carries 67 converter agents behind an LLM plan/execute/evaluate loop;
 * Lite ports the deterministic ones as plain functions — the same
 * strategies, chosen explicitly instead of by a model — and exposes
 * them to agents over MCP.
 *
 * Formats are short ids (`md`, `html`, `csv`…); `normalizeFormat` in
 * registry.ts folds the spellings people use (`markdown`, `txt`, `yml`).
 */

/** A conversion strategy — one way a converter can do its job. */
export interface ConverterStrategy {
  id: string;
  description: string;
  /** When to pick it (shown to agents choosing a strategy). */
  when: string;
}

/** An option a converter honours (documented, validated loosely). */
export interface ConverterOptionSpec {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
  default?: string | number | boolean;
}

export interface ConverterSpec {
  /** Stable id, `<from>-to-<to>` (or `<a>-<b>` for two-way converters). */
  id: string;
  title: string;
  description: string;
  /** Input formats accepted (canonical ids). */
  from: readonly string[];
  /** Output formats produced (canonical ids). */
  to: readonly string[];
  /** What does the work: `pure` (hand-written) or a library name. */
  engine: 'pure' | 'marked' | 'turndown' | 'js-yaml' | 'highlight.js';
  /**
   * This converter's own input cap, below the service cap, for engines
   * whose cost is not plainly linear (regex renderers, highlighters).
   * Amendment 1: 2 MB for the markup renderers, 8 MB for the linear
   * tag/marker strippers, the 25 MB service cap for the data parsers.
   */
  maxInputBytes?: number;
  strategies: readonly ConverterStrategy[];
  defaultStrategy: string;
  options?: readonly ConverterOptionSpec[];
}

export interface ExecuteResult {
  output: string;
  /** Numbers and short facts about the run (rows, headings, bytes…). */
  stats?: Record<string, string | number | boolean>;
  warnings?: string[];
}

/** Where a step sits in its pipeline — the formats it was asked to bridge. */
export interface StepContext {
  from: string;
  to: string;
  /** 1-based position and the pipeline length. */
  step: number;
  of: number;
}

export interface Converter {
  spec: ConverterSpec;
  /**
   * Do the conversion. `strategy` is one of `spec.strategies` (the
   * service validates); `options` are the caller's, already merged
   * over the spec defaults; `context` says which of the converter's
   * formats this step bridges (a tsv target, a py source). Throws on
   * unusable input.
   */
  execute(input: string, strategy: string, options: Record<string, unknown>, context?: StepContext): Promise<ExecuteResult>;
}

export interface ConvertRequest {
  /** The content to convert, as text. */
  input: string;
  /** Source format id or alias. */
  from: string;
  /** Target format id or alias. */
  to: string;
  /** A strategy id of the converter that will run (single-step only). */
  strategy?: string;
  options?: Record<string, unknown>;
}

export interface ConvertStep {
  converterId: string;
  from: string;
  to: string;
  strategy: string;
  durationMs: number;
  stats: Record<string, string | number | boolean>;
}

export interface ConvertResult {
  output: string;
  from: string;
  to: string;
  /** Media type of the output, for callers that save it. */
  mimeType: string;
  steps: ConvertStep[];
  durationMs: number;
  warnings: string[];
  inputBytes: number;
  outputBytes: number;
}

export interface PipelinePlan {
  from: string;
  to: string;
  /** Converter ids in order; empty when from === to. */
  steps: Array<{ converterId: string; from: string; to: string }>;
}

export interface ConverterCapability {
  id: string;
  title: string;
  description: string;
  from: string[];
  to: string[];
  engine: string;
  strategies: ConverterStrategy[];
  defaultStrategy: string;
  options: ConverterOptionSpec[];
  /** The converter's own input cap in bytes, or null when the service cap applies. */
  maxInputBytes: number | null;
}

export interface Capabilities {
  /** `asSource` / `asTarget` say whether any converter reads / writes the format — `code` is read only, `py` mostly written. */
  formats: Array<{ id: string; aliases: string[]; mimeType: string; title: string; asSource: boolean; asTarget: boolean }>;
  converters: ConverterCapability[];
  /** Every reachable (from, to) pair, direct or through a pipeline. */
  reachable: Array<{ from: string; to: string; hops: number }>;
}

/** Inputs above this are refused — conversion is in-memory text. The data parsers (csv, json, yaml, ipynb) run to it. */
export const MAX_INPUT_BYTES = 25 * 1024 * 1024;
/** The markup renderers' cap (marked, turndown, highlight.js, the text structurer): regex engines whose cost is not plainly linear. */
export const MARKUP_INPUT_BYTES = 2 * 1024 * 1024;
/** The linear tag/marker strippers' cap (html-to-text, md-to-text). */
export const TEXT_SCAN_INPUT_BYTES = 8 * 1024 * 1024;
/** Wall-clock budget for one conversion in the worker (ADR-100 Amendment 1); CONVERT_TIMEOUT_MS overrides it for the MCP server. */
export const DEFAULT_CONVERT_TIMEOUT_MS = 20_000;
export const MAX_CONVERT_TIMEOUT_MS = 120_000;
