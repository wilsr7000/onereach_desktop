/**
 * Named-query scoping fence (2026-09-01 identity audit).
 *
 * `window.lite.neon.queryNamed(name)` lets a renderer run ANY Cypher a
 * module registered via registerNamedQuery — and the executor injects no
 * $viewerId. Today the only registration is the IDW/Agent catalog, which
 * is account-wide by design. This test makes that a decision, not an
 * accident: any registered query that touches user-scoped labels
 * (:Space, :Asset, :Playbook, :Note, :Commit) must carry a $viewerId
 * guard, or be listed below with a written reason.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const SCOPED_LABELS = /:(Space|Asset|Playbook|Note|Commit)\b/;

/** Registered names allowed to touch scoped labels without $viewerId. */
const EXEMPT: Record<string, string> = {};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'test' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

function registrations(): Array<{ file: string; name: string; cypher: string }> {
  const found: Array<{ file: string; name: string; cypher: string }> = [];
  const re = /registerNamedQuery\(\s*['"]([^'"]+)['"]\s*,\s*(['"`])([\s\S]*?)\2\s*\)/g;
  for (const file of walk(ROOT)) {
    if (file.endsWith('named-queries.ts')) continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(re)) {
      found.push({ file: path.relative(ROOT, file), name: m[1]!, cypher: m[3]! });
    }
  }
  return found;
}

describe('named queries a renderer can run', () => {
  const regs = registrations();

  it('finds the registrations (the fence must actually see something)', () => {
    expect(regs.length).toBeGreaterThan(0);
    expect(regs.map((r) => r.name)).toContain('idw.oagi-catalog');
  });

  it('none touches a user-scoped label without a $viewerId guard (or a written exemption)', () => {
    for (const r of regs) {
      if (!SCOPED_LABELS.test(r.cypher)) continue;
      const guarded = r.cypher.includes('$viewerId');
      const exempt = r.name in EXEMPT;
      expect(
        guarded || exempt,
        `${r.name} (${r.file}) reads a user-scoped label with no $viewerId guard and no exemption`
      ).toBe(true);
    }
  });

  it('the IDW/Agent catalog stays account-wide by design (labels only IDW|Agent)', () => {
    const cat = regs.find((r) => r.name === 'idw.oagi-catalog');
    expect(cat).toBeDefined();
    expect(SCOPED_LABELS.test(cat!.cypher)).toBe(false);
  });
});
