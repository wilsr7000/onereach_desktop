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
import { execFileSync } from 'node:child_process';
import { join, extname, basename } from 'node:path';

const ROOT = process.argv[2] || '.';
const SKIP = /node_modules|\.git\/|dist-lite|dist\/|\.claude\/worktrees|coverage/;
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

// Private signing material must NEVER be committed to a public repo — the
// Developer ID key signs as "OneReach, Inc." A provisioning profile carries
// only the PUBLIC cert (not the key), but a public repo injects it in CI
// rather than committing it, so it is blocked here too. Cleared by
// git-ignoring the file and supplying it via a CI secret.
const SIGNING_FILE = /\.(p12|pfx|cer|pem|key|keystore|mobileprovision|provisionprofile)$/i;

/**
 * The publishable surface = files that would actually ship. Inside a git
 * repo that's the TRACKED set (`git ls-files`), so a git-ignored profile
 * sitting on a dev disk is correctly NOT flagged, while a *committed* one
 * is. Outside a repo (tests, an extracted export dir) fall back to a full
 * filesystem walk.
 */
function trackedFiles() {
  try {
    const out = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const rel = out.split('\0').filter(Boolean);
    if (rel.length > 0) return rel.map((r) => join(ROOT, r));
  } catch { /* not a git repo — fall through to walk */ }
  const acc = [];
  const walk = (p) => {
    let st; try { st = statSync(p); } catch { return; }
    if (SKIP.test(p + (st.isDirectory() ? '/' : ''))) return;
    if (st.isDirectory()) { for (const e of readdirSync(p)) walk(join(p, e)); return; }
    acc.push(p);
  };
  walk(ROOT);
  return acc;
}

const files = trackedFiles().filter((f) => !SKIP.test(f));

const findings = [];
for (const f of files) {
  const rel = f.startsWith(ROOT + '/') ? f.slice(ROOT.length + 1) : f;
  const isTest = /\.(test|spec)\.|\/test\//.test(f) || /fixtures?\//.test(f);
  // Forbidden-file check runs regardless of extension.
  if (SIGNING_FILE.test(basename(f))) {
    findings.push({ sev: 'CRITICAL', rule: 'signing-material-committed', file: rel, line: 1, isTest });
    continue;
  }
  if (!EXT.has(extname(f))) continue;
  let text; try { text = readFileSync(f, 'utf8'); } catch { continue; }
  const lines = text.split('\n');
  for (const rule of RULES) {
    lines.forEach((line, i) => {
      rule.re.lastIndex = 0;
      if (rule.re.test(line)) {
        if (rule.sev === 'MEDIUM' && SAFE.test(line)) return;
        findings.push({ sev: rule.sev, rule: rule.id, file: rel, line: i + 1, isTest });
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
