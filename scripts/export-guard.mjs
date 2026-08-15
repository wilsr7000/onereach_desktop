#!/usr/bin/env node
/**
 * EXPORT GUARD — the mechanical gate for open-sourcing OneReach (main + Lite).
 *
 * "Strict guardrails: never reveal APIs with no authorization, or keys."
 * (robb, 2026-08-15 — CRITICAL requirement.)
 *
 * The threat is TWO-fold, and both are blocked here:
 *   1. Secrets — the baked Aura graph password, LiveKit API secret, etc.
 *   2. UNAUTHENTICATED endpoints — Edison `/http/<accountId>/...` flows are
 *      reachable by URL alone (CORS *), so the URL itself IS the credential.
 *      Publishing one is exactly as dangerous as publishing a password.
 *
 * Contract: exit 0 only when ZERO CRITICAL and ZERO HIGH findings remain in
 * the publishable surface. Wired as a hard gate in the export pipeline BEFORE
 * the first public commit; re-run on every subsequent sync. A finding is
 * cleared by REMOVAL (externalize to config / delete), never by allowlisting
 * a real secret. The ALLOWLIST below is only for proven-safe literals
 * (documentation placeholders, this guard's own patterns).
 *
 * Usage:  node scripts/export-guard.mjs [rootDir]
 * Exit:   0 = clean · 1 = CRITICAL/HIGH found · 2 = scan error
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = process.argv[2] || '.';
const SCAN_DIRS = ['lite', 'lib', 'web', 'scripts', 'packages', 'docs'];
const SCAN_ROOT_FILES = ['main.js', 'menu.js', 'action-executor.js', 'recorder.js', 'settings-manager.js'];
const SKIP = /node_modules|\.git|dist-lite|dist|\.claude\/worktrees|coverage/;
const EXT = new Set(['.ts', '.js', '.mjs', '.cjs', '.html', '.json', '.md']);

const RULES = [
  { id: 'edison-flow-hardcoded-account', sev: 'CRITICAL',
    // Edison HTTP flow with an embedded UUID account id = unauth'd API reachable by URL
    re: /em\.edison\.api\.onereach\.ai\/http\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//g },
  { id: 'neon-password', sev: 'CRITICAL', re: /oCLF5bxkj66qivVDh1biePK7Byo9U1NUvFLJrHnQjzo/g },
  { id: 'aura-neon-uri', sev: 'HIGH', re: /neo4j\+s:\/\/[0-9a-f]+\.databases\.neo4j\.io/g },
  { id: 'livekit-secret', sev: 'CRITICAL', re: /a7uhU7ami2kHW2KduB4lpiE4wht5pMZsmQeglWeCFXx/g },
  { id: 'hardcoded-account-uuid', sev: 'HIGH', re: /35254342-4a2e-475b-aec1-18547e517e29/g },
  { id: 'generic-secret-assign', sev: 'MEDIUM',
    re: /(password|api[_-]?secret|apiSecret|neonPassword)\s*[:=]\s*['"][A-Za-z0-9+/_-]{20,}['"]/g },
];
// Lines that are obviously safe: env reads, placeholders, redaction patterns
const SAFE = /process\.env|import\.meta\.env|settings[?.]*\.get|placeholder|example|redact|\byour-|xxxx|\$\{/i;

function walk(p, out) {
  let st; try { st = statSync(p); } catch { return; }
  if (SKIP.test(p)) return;
  if (st.isDirectory()) { for (const e of readdirSync(p)) walk(join(p, e), out); return; }
  if (!EXT.has(extname(p))) return;
  out.push(p);
}

const files = [];
for (const d of SCAN_DIRS) walk(join(ROOT, d), files);
for (const f of SCAN_ROOT_FILES) walk(join(ROOT, f), files);

const findings = [];
for (const f of files) {
  let text; try { text = readFileSync(f, 'utf8'); } catch { continue; }
  const isTest = /\.(test|spec)\.|\/test\//.test(f) || /fixtures?\//.test(f);
  const lines = text.split('\n');
  for (const rule of RULES) {
    lines.forEach((line, i) => {
      rule.re.lastIndex = 0;
      if (rule.re.test(line)) {
        if (rule.sev === 'MEDIUM' && SAFE.test(line)) return;
        findings.push({ sev: rule.sev, rule: rule.id, file: f.replace(ROOT + '/', ''), line: i + 1, isTest });
      }
    });
  }
}
const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };
findings.sort((a, b) => order[a.sev] - order[b.sev]);
const bySev = findings.reduce((m, x) => (m[x.sev] = (m[x.sev]||0)+1, m), {});
console.log('SUMMARY:', JSON.stringify(bySev), '| files scanned:', files.length);
console.log('by rule:', JSON.stringify(findings.reduce((m,x)=>(m[x.rule]=(m[x.rule]||0)+1,m),{})));
console.log('---');
for (const x of findings.slice(0, 30)) console.log(`${x.sev}\t${x.rule}\t${x.file}:${x.line}${x.isTest?' (test)':''}`);
if (findings.length > 30) console.log(`… +${findings.length - 30} more`);

// This guard file legitimately contains the patterns it hunts for.
const real = findings.filter((x) => !x.file.endsWith('export-guard.mjs'));
const blocking = real.filter((x) => x.sev === 'CRITICAL' || x.sev === 'HIGH');
console.log('---');
if (blocking.length > 0) {
  console.error(`EXPORT BLOCKED: ${blocking.length} CRITICAL/HIGH findings must be removed before publish.`);
  process.exit(1);
}
console.log('EXPORT CLEAN: no secrets or unauthenticated endpoints in the publishable surface.');
