/**
 * Converter registry + format graph (ADR-100).
 *
 * Formats are nodes, converters are edges; a request that has no direct
 * converter is answered by the shortest pipeline (BFS), the way the full
 * app's PipelineResolver does it. Pure and synchronous; the service owns
 * validation and execution.
 */

import type { Capabilities, Converter, PipelinePlan } from './types.js';

export interface FormatSpec {
  id: string;
  title: string;
  mimeType: string;
  aliases: readonly string[];
}

/** The formats Lite knows, with the spellings people use for them. */
export const FORMATS: readonly FormatSpec[] = [
  { id: 'md', title: 'Markdown', mimeType: 'text/markdown', aliases: ['markdown', 'mdown', 'mkd'] },
  { id: 'html', title: 'HTML', mimeType: 'text/html', aliases: ['htm', 'xhtml'] },
  { id: 'text', title: 'Plain text', mimeType: 'text/plain', aliases: ['txt', 'plain', 'plaintext'] },
  { id: 'csv', title: 'CSV', mimeType: 'text/csv', aliases: ['comma-separated'] },
  { id: 'tsv', title: 'TSV', mimeType: 'text/tab-separated-values', aliases: ['tab-separated'] },
  { id: 'json', title: 'JSON', mimeType: 'application/json', aliases: [] },
  { id: 'yaml', title: 'YAML', mimeType: 'application/yaml', aliases: ['yml'] },
  { id: 'ipynb', title: 'Jupyter notebook', mimeType: 'application/x-ipynb+json', aliases: ['jupyter', 'notebook'] },
  { id: 'py', title: 'Python', mimeType: 'text/x-python', aliases: ['python'] },
  { id: 'code', title: 'Source code', mimeType: 'text/plain', aliases: ['source', 'src'] },
];

const FORMAT_BY_ID: ReadonlyMap<string, FormatSpec> = new Map(FORMATS.map((f) => [f.id, f]));
const FORMAT_BY_ALIAS: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const f of FORMATS) {
    m.set(f.id, f.id);
    for (const a of f.aliases) m.set(a, f.id);
  }
  return m;
})();

/** Fold a spelling to a canonical format id, or null when unknown. */
export function normalizeFormat(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase().replace(/^\./, '');
  if (key.length === 0) return null;
  return FORMAT_BY_ALIAS.get(key) ?? null;
}

export function formatSpec(id: string): FormatSpec | null {
  return FORMAT_BY_ID.get(id) ?? null;
}

export function mimeTypeFor(id: string): string {
  return FORMAT_BY_ID.get(id)?.mimeType ?? 'text/plain';
}

export class ConverterRegistry {
  private readonly byId = new Map<string, Converter>();
  /** from → to → converters (in registration order). */
  private readonly edges = new Map<string, Map<string, Converter[]>>();

  register(converter: Converter): void {
    const { spec } = converter;
    if (this.byId.has(spec.id)) throw new Error(`converter "${spec.id}" registered twice`);
    if (!spec.strategies.some((s) => s.id === spec.defaultStrategy)) {
      throw new Error(`converter "${spec.id}" defaults to unknown strategy "${spec.defaultStrategy}"`);
    }
    for (const f of [...spec.from, ...spec.to]) {
      if (!FORMAT_BY_ID.has(f)) throw new Error(`converter "${spec.id}" names unknown format "${f}"`);
    }
    this.byId.set(spec.id, converter);
    for (const from of spec.from) {
      let targets = this.edges.get(from);
      if (targets === undefined) {
        targets = new Map();
        this.edges.set(from, targets);
      }
      for (const to of spec.to) {
        if (from === to) continue;
        const list = targets.get(to) ?? [];
        list.push(converter);
        targets.set(to, list);
      }
    }
  }

  get(id: string): Converter | null {
    return this.byId.get(id) ?? null;
  }

  all(): Converter[] {
    return Array.from(this.byId.values());
  }

  /** The direct converter for a pair (first registered wins), or null. */
  direct(from: string, to: string): Converter | null {
    return this.edges.get(from)?.get(to)?.[0] ?? null;
  }

  /** Shortest pipeline from → to (BFS over formats), or null when unreachable. */
  resolve(from: string, to: string): PipelinePlan | null {
    if (from === to) return { from, to, steps: [] };
    const direct = this.direct(from, to);
    if (direct !== null) return { from, to, steps: [{ converterId: direct.spec.id, from, to }] };
    const prev = new Map<string, { format: string; converter: Converter } | null>();
    prev.set(from, null);
    const queue: string[] = [from];
    while (queue.length > 0) {
      const cur = queue.shift() as string;
      const targets = this.edges.get(cur);
      if (targets === undefined) continue;
      for (const [next, converters] of targets) {
        if (prev.has(next)) continue;
        const via = converters[0];
        if (via === undefined) continue;
        prev.set(next, { format: cur, converter: via });
        if (next === to) {
          const steps: PipelinePlan['steps'] = [];
          let at = to;
          while (at !== from) {
            const p = prev.get(at);
            if (p === null || p === undefined) break;
            steps.unshift({ converterId: p.converter.spec.id, from: p.format, to: at });
            at = p.format;
          }
          return { from, to, steps };
        }
        queue.push(next);
      }
    }
    return null;
  }

  /** Every reachable pair with its hop count (for the capabilities catalog). */
  reachablePairs(): Array<{ from: string; to: string; hops: number }> {
    const out: Array<{ from: string; to: string; hops: number }> = [];
    for (const a of FORMATS) {
      for (const b of FORMATS) {
        if (a.id === b.id) continue;
        const plan = this.resolve(a.id, b.id);
        if (plan !== null) out.push({ from: a.id, to: b.id, hops: plan.steps.length });
      }
    }
    return out;
  }

  capabilities(): Capabilities {
    return {
      formats: FORMATS.map((f) => ({ id: f.id, aliases: [...f.aliases], mimeType: f.mimeType, title: f.title })),
      converters: this.all().map((c) => ({
        id: c.spec.id,
        title: c.spec.title,
        description: c.spec.description,
        from: [...c.spec.from],
        to: [...c.spec.to],
        engine: c.spec.engine,
        strategies: c.spec.strategies.map((s) => ({ ...s })),
        defaultStrategy: c.spec.defaultStrategy,
        options: (c.spec.options ?? []).map((o) => ({ ...o })),
      })),
      reachable: this.reachablePairs(),
    };
  }
}
