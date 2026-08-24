/**
 * The SPACE_WRITABLE rewrite, checked at RUNTIME (2026-08-20).
 *
 * Live failure: "add Rich to a space" → HTTP 500 on every write behind
 * SPACE_WRITABLE — twenty mutation queries, broken for everyone on
 * 0.0.77. Root cause: an invisible 0x08 BACKSPACE byte inside the
 * `/\br\./g` regex literal (an editor materialized the escape), so the
 * GRANT_LIVE rewrite matched nothing, `r.` survived inside the
 * `[w:HAS_ACCESS]` block, and Neo4j threw `Variable r not defined`.
 *
 * Source-regex tests could never catch this — the SOURCE looked right;
 * only the runtime string was wrong. So these pins evaluate the REAL
 * exported query strings, and one scans the file bytes for the whole
 * class of invisible control characters.
 */
import { describe, it, expect } from 'vitest';
import { CYPHER } from '../../spaces/sdk-client.js';

describe('SPACE_WRITABLE at runtime', () => {
  it('the grant-liveness rewrite actually happened in every write query', () => {
    for (const [name, query] of Object.entries(CYPHER)) {
      if (typeof query !== 'string') continue;
      if (!query.includes('[w:HAS_ACCESS]')) continue;
      const writable = query.slice(query.indexOf('[w:HAS_ACCESS]'));
      const block = writable.slice(0, writable.indexOf('}'));
      expect(block, `${name}: rewrite failed — r. survived in the w-block`).not.toMatch(
        /\br\.expiresUnixMs/
      );
      expect(block, `${name}: expected the rewritten binding`).toContain('w.expiresUnixMs');
    }
  });

  it('at least one query actually embeds the writable guard (the loop is not vacuous)', () => {
    const withGuard = Object.values(CYPHER).filter(
      (q) => typeof q === 'string' && q.includes('[w:HAS_ACCESS]')
    );
    expect(withGuard.length).toBeGreaterThanOrEqual(10);
  });
});

describe('no invisible control bytes in the query source', () => {
  it('NO lite production source carries C0 control characters', () => {
    // The 0x08 that broke 0.0.77 happened to land in sdk-client.ts,
    // but an editor can materialize an escape in ANY file — a regex in
    // the renderer or a Cypher string in a module would break just as
    // invisibly. Scan the whole production tree; tests included costs
    // nothing and catches fixture accidents too.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('node:path') as typeof import('node:path');
    const root = ['.', 'lite']
      .map((r) => path.resolve(r))
      .find((r) => fs.existsSync(path.join(r, 'main-lite.ts')));
    if (root === undefined) throw new Error('lite root not found');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir)) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        const full = path.join(dir, entry);
        if (fs.statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|mts|cts|js|mjs)$/.test(entry)) continue;
        const bytes = fs.readFileSync(full);
        for (let i = 0; i < bytes.length; i++) {
          const b = bytes[i]!;
          if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) {
            offenders.push(`${path.relative(root, full)}: 0x${b.toString(16)} at ${i}`);
            break; // one report per file is enough
          }
        }
      }
    };
    walk(root);
    expect(
      offenders,
      'invisible control bytes — an editor materialized an escape sequence'
    ).toEqual([]);
  });

  it('sdk-client.ts contains no C0 control characters beyond tab/newline', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('node:path') as typeof import('node:path');
    const found = ['spaces/sdk-client.ts', 'lite/spaces/sdk-client.ts']
      .map((r) => path.resolve(r))
      .find((f) => fs.existsSync(f));
    const bytes = fs.readFileSync(found as string);
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      const bad = b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d;
      if (bad) {
        throw new Error(
          `control byte 0x${b.toString(16)} at offset ${i} — an editor materialized an escape sequence`
        );
      }
    }
  });
});
