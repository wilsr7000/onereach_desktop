/**
 * Every preload a window attaches must actually be BUILT.
 *
 * A preload is referenced by filename at runtime
 * (`preload: join(__dirname, 'preload-x.js')`) and produced by a
 * separate list in `esbuild.config.mjs`. Nothing connects the two: add a
 * window with a new preload and forget the build entry, and the app
 * still starts, the window still opens, and the bridge is simply absent
 * — `window.journeySpaces` undefined, the page silently falling back to
 * its own storage. No error, no failing test, just a feature that isn't
 * there.
 *
 * That is exactly the shape of the ADR-072 phase 2 landing (a new
 * `preload-journey-map.ts` plus a new esbuild entry), so the link is
 * made mechanical here: scan the source for attached preloads, scan the
 * build config for what it emits, and require the second to cover the
 * first — including membership of `allConfigs`, since an options object
 * that is never added to that array is never built.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const liteRoot = resolve(__dirname, '..', '..');

/** lite/*.ts plus lite/<module>/*.ts — the app's own source, no tests. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const push = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(join(dir, name));
    }
  };
  push(liteRoot);
  for (const entry of readdirSync(liteRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'test' || entry.name === 'node_modules' || entry.name === 'scripts') continue;
    const dir = join(liteRoot, entry.name);
    if (!statSync(dir).isDirectory()) continue;
    push(dir);
  }
  return out;
}

/** `preload: join(__dirname, 'X.js')` / `path.join(...)` — literal attachments. */
function attachedPreloads(): Array<{ file: string; bundle: string }> {
  const re = /preload:\s*(?:path\.)?join\(__dirname,\s*'([^']+\.js)'\)/g;
  const found: Array<{ file: string; bundle: string }> = [];
  for (const file of sourceFiles()) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(re)) {
      const bundle = m[1];
      if (bundle !== undefined) found.push({ file: file.slice(liteRoot.length + 1), bundle });
    }
  }
  return found;
}

const buildConfig = (): string => readFileSync(join(liteRoot, 'esbuild.config.mjs'), 'utf8');

/** const name -> emitted filename, for every `*Options` block in the config. */
function buildTargets(src: string): Map<string, string> {
  const blocks = [...src.matchAll(/^const (\w+) = \{/gm)];
  const targets = new Map<string, string>();
  blocks.forEach((block, i) => {
    const name = block[1];
    if (name === undefined || block.index === undefined) return;
    const end = i + 1 < blocks.length ? blocks[i + 1]?.index : src.length;
    const body = src.slice(block.index, end ?? src.length);
    const outfile = /outfile:\s*resolve\(outDir,\s*'([^']+)'\)/.exec(body);
    if (outfile?.[1] !== undefined) targets.set(name, outfile[1]);
  });
  return targets;
}

/** The configs actually handed to esbuild. */
function builtConfigNames(src: string): string[] {
  const arr = /const allConfigs = \[([\s\S]*?)\];/.exec(src);
  if (arr?.[1] === undefined) throw new Error('allConfigs not found in esbuild.config.mjs');
  return arr[1]
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('//'));
}

describe('preload bundles', () => {
  it('finds the preloads the app attaches (sanity — the scan still matches)', () => {
    const attached = attachedPreloads();
    expect(attached.length).toBeGreaterThanOrEqual(3);
    expect(attached.map((a) => a.bundle)).toContain('preload-journey-map.js');
  });

  it('every attached preload is emitted by esbuild', () => {
    const src = buildConfig();
    const emitted = new Set(buildTargets(src).values());
    const missing = attachedPreloads().filter((a) => !emitted.has(a.bundle));
    expect(
      missing.map((m) => `${m.bundle} (attached in ${m.file})`),
      'a window attaches a preload that no esbuild entry produces — the bridge will be silently absent at runtime'
    ).toEqual([]);
  });

  it('every emitted preload is in allConfigs — a defined-but-unlisted entry never builds', () => {
    const src = buildConfig();
    const targets = buildTargets(src);
    const listed = new Set(builtConfigNames(src));
    const attachedBundles = new Set(attachedPreloads().map((a) => a.bundle));

    const orphans: string[] = [];
    for (const [name, outfile] of targets) {
      if (attachedBundles.has(outfile) && !listed.has(name)) orphans.push(`${name} -> ${outfile}`);
    }
    expect(orphans, 'esbuild config defined but never added to allConfigs').toEqual([]);
  });

  it('the journey-map preload is built from the journey-map source', () => {
    const src = buildConfig();
    const block = /const journeyMapPreloadOptions = \{[\s\S]*?\};/.exec(src)?.[0];
    expect(block, 'journeyMapPreloadOptions missing from esbuild.config.mjs').toBeDefined();
    expect(block).toContain("'preload-journey-map.ts'");
    expect(block).toContain("'preload-journey-map.js'");
    // A preload runs in the renderer's process but needs electron as an
    // external and CJS output, like every other preload here.
    expect(block).toContain("format: 'cjs'");
    expect(block).toContain("external: ['electron']");
  });
});
