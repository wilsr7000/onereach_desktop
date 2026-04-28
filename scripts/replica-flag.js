#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * scripts/replica-flag.js
 *
 * Operator helper for atomically flipping replica settings flags in
 * the persisted Electron settings file (userData/app-settings.json).
 *
 * Why this exists: the production settings UI for these flags lives
 * inside the running app, but the most reliable way to flip them is
 * to (a) quit the app, (b) edit the persisted settings file, (c)
 * relaunch. Editing the file by hand is error-prone (JSON typos,
 * accidentally clobbering window bounds, etc.). This script:
 *   - Checks if the app is running (refuses to write if it is, to
 *     avoid being clobbered by the app's own save-on-exit).
 *   - Reads the current settings file atomically.
 *   - Sets ONLY the keys requested; leaves everything else
 *     untouched.
 *   - Writes via tmp + rename so a crash mid-write can't corrupt.
 *   - Backs up the previous version to app-settings.bak.json so a
 *     bad flip can be reverted in one command.
 *
 * Designed for the activation runbook's flag-flip steps:
 *   Phase 1: --enable                    (syncV5.replica.enabled = true)
 *   Phase 3: --enable --shadow-read      (+ shadowReadEnabled = true)
 *   Phase 4: --cutover                   (cutoverEnabled = true)
 *   Phase 6: --strict                    (fallbackToOldPath = false)
 *   Rollback: --disable                  (replica.enabled = false)
 *
 * Composable: --enable --shadow-read sets BOTH flags in one write.
 *
 * Usage:
 *   node scripts/replica-flag.js --status              # show current values, no write
 *   node scripts/replica-flag.js --enable --shadow-read
 *   node scripts/replica-flag.js --cutover             # flip cutoverEnabled = true
 *   node scripts/replica-flag.js --disable             # flip replica.enabled = false
 *   node scripts/replica-flag.js --strict              # flip fallbackToOldPath = false
 *   node scripts/replica-flag.js --restore             # restore from .bak.json
 *
 * Safe defaults: refuses to write if it can ping the running log
 * server (port 47292). Override with --force at your peril.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

// ---------------------------------------------------------------------------
// Settings file location -- mirrors settings-manager.js
// ---------------------------------------------------------------------------

const USERDATA = process.env.SETTINGS_DIR || path.join(
  os.homedir(),
  'Library', 'Application Support', 'onereach-ai'
);
const SETTINGS_PATH = path.join(USERDATA, 'app-settings.json');
const BACKUP_PATH = path.join(USERDATA, 'app-settings.bak.json');

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flags = {
  status: argv.includes('--status'),
  enable: argv.includes('--enable'),
  disable: argv.includes('--disable'),
  shadowRead: argv.includes('--shadow-read') || argv.includes('--shadowRead'),
  shadowReadOff: argv.includes('--no-shadow-read'),
  cutover: argv.includes('--cutover'),
  cutoverOff: argv.includes('--no-cutover'),
  strict: argv.includes('--strict'),
  fallbackOn: argv.includes('--fallback'),
  restore: argv.includes('--restore'),
  force: argv.includes('--force'),
  json: argv.includes('--json'),
  help: argv.includes('--help') || argv.includes('-h'),
};

if (flags.help || argv.length === 0) {
  printHelp();
  process.exit(0);
}

function printHelp() {
  console.log(`replica-flag.js -- atomically flip replica settings

Usage:
  node scripts/replica-flag.js [flags]

Read-only:
  --status              Show current values + verify file. No write.
  --json                Emit current values as JSON.

Activation flags (additive; combine with each other):
  --enable              syncV5.replica.enabled = true            (Phase 1)
  --shadow-read         syncV5.replica.shadowReadEnabled = true  (Phase 3)
  --cutover             syncV5.replica.cutoverEnabled = true     (Phase 4)
  --strict              syncV5.replica.fallbackToOldPath = false (Phase 6)

Rollback flags:
  --disable             syncV5.replica.enabled = false
  --no-shadow-read      syncV5.replica.shadowReadEnabled = false
  --no-cutover          syncV5.replica.cutoverEnabled = false
  --fallback            syncV5.replica.fallbackToOldPath = true
  --restore             Restore the previous settings from .bak.json

Safety:
  --force               Skip the running-app check (NOT recommended).

The script refuses to write while the app is running -- the app
saves its own settings on exit and would clobber this edit. Quit
the app first, then run with the desired flags, then relaunch.

Settings file: ${SETTINGS_PATH}
Backup file:   ${BACKUP_PATH}
`);
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

function readSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) {
    throw new Error(`Settings file not found: ${SETTINGS_PATH}`);
  }
  const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Settings file is corrupt JSON: ${err.message}`);
  }
}

function writeSettings(obj) {
  // Backup first.
  if (fs.existsSync(SETTINGS_PATH)) {
    fs.copyFileSync(SETTINGS_PATH, BACKUP_PATH);
  }
  // Atomic write via tmp + rename.
  const tmp = `${SETTINGS_PATH}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, SETTINGS_PATH);
}

// ---------------------------------------------------------------------------
// Running-app check
// ---------------------------------------------------------------------------

function pingApp() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 47292, path: '/health', timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ---------------------------------------------------------------------------
// Pretty status output
// ---------------------------------------------------------------------------

const REPLICA_KEYS = [
  'syncV5.replica.enabled',
  'syncV5.replica.shadowReadEnabled',
  'syncV5.replica.cutoverEnabled',
  'syncV5.replica.fallbackToOldPath',
  'syncV5.replica.tenantId',
  'syncV5.replica.tombstoneRetentionDays',
];

function printStatus(settings) {
  if (flags.json) {
    const out = {};
    for (const k of REPLICA_KEYS) out[k] = settings[k];
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  console.log(`\nReplica settings @ ${SETTINGS_PATH}:\n`);
  for (const k of REPLICA_KEYS) {
    const v = settings[k];
    const display = v === undefined
      ? '(default)'
      : (typeof v === 'string' ? `"${v}"` : String(v));
    console.log(`  ${k.padEnd(40)} ${display}`);
  }
  console.log();
  // Summarise effective phase.
  const enabled = settings['syncV5.replica.enabled'] === true;
  const shadow = settings['syncV5.replica.shadowReadEnabled'] === true;
  const cutover = settings['syncV5.replica.cutoverEnabled'] === true;
  const strict = settings['syncV5.replica.fallbackToOldPath'] === false;
  let phase;
  if (!enabled) phase = 'OFF';
  else if (!shadow && !cutover) phase = 'Phase 1-2 (boot + shadow-write)';
  else if (shadow && !cutover) phase = 'Phase 3 (shadow-read window in progress)';
  else if (cutover && !strict) phase = 'Phase 4-5 (cutover active, fallback enabled)';
  else if (cutover && strict) phase = 'Phase 6 (cutover STRICT, no fallback)';
  else phase = '(unusual combination)';
  console.log(`  Effective phase: ${phase}\n`);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function applyFlags(settings) {
  const writes = [];
  if (flags.enable) { settings['syncV5.replica.enabled'] = true; writes.push('syncV5.replica.enabled = true'); }
  if (flags.disable) { settings['syncV5.replica.enabled'] = false; writes.push('syncV5.replica.enabled = false'); }
  if (flags.shadowRead) { settings['syncV5.replica.shadowReadEnabled'] = true; writes.push('syncV5.replica.shadowReadEnabled = true'); }
  if (flags.shadowReadOff) { settings['syncV5.replica.shadowReadEnabled'] = false; writes.push('syncV5.replica.shadowReadEnabled = false'); }
  if (flags.cutover) { settings['syncV5.replica.cutoverEnabled'] = true; writes.push('syncV5.replica.cutoverEnabled = true'); }
  if (flags.cutoverOff) { settings['syncV5.replica.cutoverEnabled'] = false; writes.push('syncV5.replica.cutoverEnabled = false'); }
  if (flags.strict) { settings['syncV5.replica.fallbackToOldPath'] = false; writes.push('syncV5.replica.fallbackToOldPath = false (STRICT)'); }
  if (flags.fallbackOn) { settings['syncV5.replica.fallbackToOldPath'] = true; writes.push('syncV5.replica.fallbackToOldPath = true'); }
  return writes;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // --restore takes priority.
  if (flags.restore) {
    if (!fs.existsSync(BACKUP_PATH)) {
      console.error(`No backup file at ${BACKUP_PATH}`);
      process.exit(1);
    }
    const running = !flags.force && await pingApp();
    if (running) {
      console.error('App is running -- quit it first, or pass --force.');
      process.exit(2);
    }
    fs.copyFileSync(BACKUP_PATH, SETTINGS_PATH);
    console.log(`Restored ${SETTINGS_PATH} from backup.`);
    process.exit(0);
  }

  let settings;
  try {
    settings = readSettings();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  if (flags.status) {
    printStatus(settings);
    return;
  }

  // Anything else writes. Check the app isn't running.
  const writes = applyFlags(settings);
  if (writes.length === 0) {
    console.error('No flags specified to write. Use --status to inspect, or --help.');
    process.exit(1);
  }

  if (!flags.force) {
    const running = await pingApp();
    if (running) {
      console.error('App is running -- quit it first.');
      console.error('  (The app saves settings on exit and would clobber this edit.)');
      console.error('  Override with --force at your peril.');
      process.exit(2);
    }
  }

  writeSettings(settings);
  console.log(`Wrote ${SETTINGS_PATH}:`);
  for (const w of writes) console.log(`  ${w}`);
  console.log(`\nBackup at: ${BACKUP_PATH}`);
  console.log('\nNext: relaunch the app, then run `npm run replica:status` to verify.');
}

main().catch((err) => {
  console.error(`fatal: ${err.message}`);
  if (process.env.DEBUG && err.stack) console.error(err.stack);
  process.exit(1);
});
