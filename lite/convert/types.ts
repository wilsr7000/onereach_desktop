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

export interface Converter {
  spec: ConverterSpec;
  /**
   * Do the conversion. `strategy` is one of `spec.strategies` (the
   * service validates); `options` are the caller's, already merged
   * over the spec defaults. Throws on unusable input.
   */
  execute(input: string, strategy: string, options: Record<string, unknown>): Promise<ExecuteResult>;
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
}

export interface Capabilities {
  formats: Array<{ id: string; aliases: string[]; mimeType: string; title: string }>;
  converters: ConverterCapability[];
  /** Every reachable (from, to) pair, direct or through a pipeline. */
  reachable: Array<{ from: string; to: string; hops: number }>;
}

/** Inputs above this are refused — conversion is in-memory text. */
export const MAX_INPUT_BYTES = 25 * 1024 * 1024;
