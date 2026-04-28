#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * scripts/replica-status.js
 *
 * Operator CLI for the sync-v5 materialised replica.
 *
 * Hits the running app's diagnostics endpoints
 * (http://127.0.0.1:47292/sync/queue + /sync/replica/validation) and
 * pretty-prints the full replica state: migration stats, shadow-writer
 * counters, shadow-reader counters, cutover state, validation gate,
 * blockers, recent divergences.
 *
 * Designed so an operator can run `npm run replica:status` repeatedly
 * during the validation window and immediately see whether the gate
 * is making progress, whether divergences are creeping in, whether
 * the replica is actually populated, etc.
 *
 * Exits with status 0 when the replica is in a healthy state, 1 if
 * the gate is unmet, 2 if the replica is disabled, 3 if the app is
 * unreachable. CI / cron friendly.
 *
 * Usage:
 *   node scripts/replica-status.js                # default endpoint
 *   node scripts/replica-status.js --port 47292   # alternate port
 *   node scripts/replica-status.js --json         # raw JSON for scripting
 *   node scripts/replica-status.js --watch=10     # repeat every 10s
 *
 * No external deps -- uses node's built-in http and the Process'
 * stdout. Coloring is conditional on TTY.
 */

'use strict';

const http = require('http');

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const opts = parseArgs(argv);

function parseArgs(args) {
  const out = { port: 47292, host: '127.0.0.1', json: false, watch: 0 };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--port' || a === '-p') out.port = parseInt(args[++i], 10);
    else if (a === '--host' || a === '-h') out.host = args[++i];
    else if (a === '--json' || a === '-j') out.json = true;
    else if (a.startsWith('--watch')) {
      const eq = a.indexOf('=');
      out.watch = eq >= 0 ? parseInt(a.slice(eq + 1), 10) : parseInt(args[++i], 10) || 5;
    } else if (a === '--help') {
      printHelp();
      process.exit(0);
    }
  }
  return out;
}

function printHelp() {
  console.log(`Usage: replica-status.js [options]

Options:
  --port <n>      Log-server port (default 47292)
  --host <h>      Host (default 127.0.0.1)
  --json          Print raw JSON instead of pretty-printed
  --watch <s>     Repeat every <s> seconds (default 5)
  --help          This message

Exit status:
  0  Replica healthy + gate met (cutover allowed)
  1  Replica healthy + gate unmet (validation in progress or divergences)
  2  Replica disabled or not wired
  3  App unreachable (log-server not responding)
`);
}

// ---------------------------------------------------------------------------
// Coloring (TTY-conditional)
// ---------------------------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  bold: (s) => useColor ? `\x1b[1m${s}\x1b[22m` : s,
  dim: (s) => useColor ? `\x1b[2m${s}\x1b[22m` : s,
  red: (s) => useColor ? `\x1b[31m${s}\x1b[39m` : s,
  green: (s) => useColor ? `\x1b[32m${s}\x1b[39m` : s,
  yellow: (s) => useColor ? `\x1b[33m${s}\x1b[39m` : s,
  blue: (s) => useColor ? `\x1b[34m${s}\x1b[39m` : s,
  magenta: (s) => useColor ? `\x1b[35m${s}\x1b[39m` : s,
  cyan: (s) => useColor ? `\x1b[36m${s}\x1b[39m` : s,
};

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function fetchJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: opts.host, port: opts.port, path,
      timeout: 5000,
      headers: { Accept: 'application/json' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch (err) {
          reject(new Error(`Invalid JSON from ${path}: ${err.message} -- body: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`Timeout connecting to ${opts.host}:${opts.port}${path}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Pretty-printing
// ---------------------------------------------------------------------------

function fmtNumber(n) {
  if (typeof n !== 'number') return String(n || 0);
  return n.toLocaleString();
}

function fmtMs(ms) {
  if (typeof ms !== 'number') return String(ms || '');
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function fmtBool(b, trueLabel = 'yes', falseLabel = 'no') {
  return b ? c.green(trueLabel) : c.dim(falseLabel);
}

function fmtGate(g) {
  if (!g) return c.dim('--');
  const label = `${g.actual}/${g.required}`;
  return g.met ? c.green(label) : c.yellow(label);
}

function header(text) {
  console.log();
  console.log(c.bold(c.cyan(`── ${text} ${'─'.repeat(Math.max(2, 60 - text.length))}`)));
}

function row(label, value) {
  console.log(`  ${c.dim(label.padEnd(28))} ${value}`);
}

// ---------------------------------------------------------------------------
// Main report
// ---------------------------------------------------------------------------

async function fetchAll() {
  const queue = await fetchJson('/sync/queue');
  const validation = await fetchJson('/sync/replica/validation');
  return {
    replica: queue.body && queue.body.replica,
    validation: validation.body,
    fullQueue: queue.body,
  };
}

function printReport({ replica, validation }) {
  // ── Top banner ──
  console.log();
  if (!replica || replica.wired === false) {
    console.log(c.yellow('REPLICA: ') + c.dim('not wired ') + c.dim(`(${replica?.note || 'syncV5.replica.enabled is false'})`));
    return 2;
  }

  // Replica is wired -- describe its state.
  const cutoverActive = !!(replica.cutover && replica.cutover.active);
  const cutoverEnabled = !!(replica.cutover && replica.cutover.enabled);
  const fallback = replica.cutover && replica.cutover.fallbackToOldPath;

  let statusBanner;
  if (cutoverActive) {
    statusBanner = c.green('CUTOVER ACTIVE') + c.dim(fallback ? '  (fallback enabled)' : '  (strict mode)');
  } else if (cutoverEnabled) {
    statusBanner = c.yellow('cutover enabled, gate refusing') + c.dim('  -- check blockers below');
  } else if (replica.shadowReader && replica.shadowReader.wired !== false) {
    statusBanner = c.cyan('shadow-read ACTIVE') + c.dim('  -- validation window in progress');
  } else if (replica.shadowWriter && replica.shadowWriter.wired !== false) {
    statusBanner = c.cyan('shadow-write only') + c.dim('  -- shadow-read disabled');
  } else {
    statusBanner = c.yellow('replica wired but shadow paths inactive');
  }
  console.log(c.bold('REPLICA: ') + statusBanner);

  // ── Replica state ──
  header('replica');
  row('dbPath', c.dim(replica.dbPath || ''));
  row('tenantId / deviceId', `${replica.tenantId || ''} / ${c.dim(replica.deviceId || '')}`);
  row('schemaVersion', `${replica.schemaVersion} (compiled: ${replica.compiledInSchemaVersion})`);
  row('FTS5 available', fmtBool(replica.fts5Available));
  row('counts', `spaces=${c.bold(fmtNumber(replica.counts?.spaces))}  items=${c.bold(fmtNumber(replica.counts?.items))}  smartFolders=${c.bold(fmtNumber(replica.counts?.smartFolders))}`);
  row('cursor', replica.meta?.cursor || c.dim('(empty)'));
  row('lastFullPullAt', replica.meta?.lastFullPullAt || c.dim('(none)'));
  row('migratedFromClipAt', replica.meta?.migratedFromClipboardStorageAt || c.dim('(not yet)'));

  // ── Shadow-writer ──
  header('shadow-writer (commit C)');
  const sw = replica.shadowWriter;
  if (!sw || sw.wired === false) {
    row('status', c.dim(sw?.note || 'not wired'));
  } else {
    row('attached / detached', `${sw.attachedAt || '?'}${sw.detachedAt ? '  -> ' + sw.detachedAt : ''}`);
    row('totals', `writes=${c.bold(fmtNumber(sw.writes))}  errors=${sw.errors > 0 ? c.red(sw.errors) : c.green(0)}`);
    row('last write', `${sw.lastWriteEvent || c.dim('(none)')}  ${c.dim(sw.lastWriteAt || '')}`);
    if (sw.lastError) {
      row('last error', c.red(`${sw.lastError.event}: ${sw.lastError.message}`));
    }
    if (sw.perEvent) {
      const events = Object.keys(sw.perEvent).filter((e) => sw.perEvent[e].writes > 0);
      if (events.length > 0) {
        row('per event', events.slice(0, 5).map((e) => `${e}=${sw.perEvent[e].writes}`).join('  '));
      }
    }
  }

  // ── Shadow-reader ──
  header('shadow-reader (commit D)');
  const sr = replica.shadowReader;
  if (!sr || sr.wired === false) {
    row('status', c.dim(sr?.note || 'not wired'));
  } else {
    row('attached', sr.attachedAt || '?');
    row('sample rate', `1-in-${sr.sampleRate} (hot path)`);
    if (sr.perEvent) {
      const events = Object.keys(sr.perEvent);
      for (const e of events) {
        const ev = sr.perEvent[e];
        const div = ev.divergences > 0 ? c.red(`div=${ev.divergences}`) : c.green('div=0');
        const errs = ev.errors > 0 ? c.red(`err=${ev.errors}`) : c.dim('err=0');
        row(e, `inv=${fmtNumber(ev.invocations)}  cmp=${fmtNumber(ev.sampledComparisons)}  ${div}  ${errs}`);
      }
    }
    if (sr.lastDivergence) {
      console.log();
      console.log(c.red('  Last divergence:'));
      console.log(`    event: ${sr.lastDivergence.event}`);
      console.log(`    at:    ${sr.lastDivergence.at}`);
      const summary = JSON.stringify(sr.lastDivergence, null, 2).split('\n').slice(1, 8).join('\n');
      console.log(c.dim(summary));
    }
  }

  // ── Cutover state ──
  header('cutover (commit E)');
  if (replica.cutover) {
    row('cutoverEnabled (setting)', fmtBool(replica.cutover.enabled));
    row('active (gate-passed)', fmtBool(replica.cutover.active));
    row('fallbackToOldPath', fmtBool(replica.cutover.fallbackToOldPath, 'enabled', 'STRICT'));
  } else {
    row('status', c.dim('cutover state not surfaced'));
  }

  // ── Pull adapter ──
  header('pull-engine adapter (commit F)');
  const pa = replica.pullAdapter;
  if (!pa || pa.wired === false) {
    row('status', c.dim(pa?.note || 'not wired'));
  } else {
    row('totals', `applied=${fmtNumber(pa.applied)}  tombstoned=${fmtNumber(pa.tombstoned)}  skipped=${fmtNumber(pa.skipped)}  errors=${pa.errors > 0 ? c.red(pa.errors) : c.green(0)}`);
    row('last apply', `${pa.lastOpType || c.dim('(none)')}  ${c.dim(pa.lastApplyAt || '')}`);
  }

  // ── Validation gate (the one that matters) ──
  header('validation gate (§6.6)');
  if (!validation || validation.wired === false) {
    row('status', c.dim(validation?.note || 'gate not wired (shadow-read disabled)'));
    return 1;
  }
  const allowed = !!validation.cutoverAllowed;
  row('cutoverAllowed', allowed ? c.green('YES -- ready for commit E flag flip') : c.red('NO'));
  row('startedAt', validation.startedAt || c.dim('(not started)'));
  row('wall-clock', `${fmtGate(validation.wallClockGate)} days`);
  if (validation.invocationGates) {
    for (const [name, g] of Object.entries(validation.invocationGates)) {
      row(`  ${name}`, fmtGate(g));
    }
  }
  if (validation.divergences) {
    const total = validation.divergences.total || 0;
    row('divergences', total === 0 ? c.green('0 (clean)') : c.red(`${total} -- ` + JSON.stringify(validation.divergences.byMethod)));
  }
  if (validation.blockers && validation.blockers.length > 0) {
    console.log();
    console.log(c.yellow('  Blockers:'));
    for (const b of validation.blockers) console.log(`    - ${b}`);
  }

  return allowed ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function runOnce() {
  let report;
  try {
    report = await fetchAll();
  } catch (err) {
    console.error(c.red(`Cannot reach app at ${opts.host}:${opts.port} -- ${err.message}`));
    console.error(c.dim('  Is the app running? Check that the log-server started ok.'));
    return 3;
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    if (!report.replica || report.replica.wired === false) return 2;
    return report.validation && report.validation.cutoverAllowed ? 0 : 1;
  }

  return printReport(report);
}

async function main() {
  if (opts.watch > 0) {
    while (true) {
      if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H'); // clear screen
      console.log(c.dim(`replica-status @ ${new Date().toISOString()} (refresh every ${opts.watch}s; Ctrl-C to stop)`));
      await runOnce();
      await new Promise((res) => setTimeout(res, opts.watch * 1000));
    }
  } else {
    process.exit(await runOnce());
  }
}

main().catch((err) => {
  console.error(c.red(`fatal: ${err.message}`));
  if (err.stack && process.env.DEBUG) console.error(err.stack);
  process.exit(3);
});
