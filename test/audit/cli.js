#!/usr/bin/env node
'use strict';

const { TestAuditOrchestrator } = require('./orchestrator');

// ─── ANSI Colors ───
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
};

const STATUS_COLORS = {
  passed: C.green,
  failed: C.red,
  skipped: C.yellow,
  blocked: C.magenta,
  untested: C.gray,
  pending: C.cyan,
  pass: C.green,
  fail: C.red,
  partial: C.yellow,
};

function colorStatus(status) {
  return `${STATUS_COLORS[status] || ''}${status}${C.reset}`;
}

function printHelp() {
  console.log(`
${C.bold}Test Audit Orchestrator${C.reset}
${C.dim}Walks through test plans one item at a time with full audit trail.${C.reset}

${C.bold}Usage:${C.reset}
  node test/audit/cli.js <command> [options]

${C.bold}Commands:${C.reset}
  ${C.cyan}status${C.reset}              Show current progress summary
  ${C.cyan}next${C.reset}                Run the next untested item
  ${C.cyan}run <id>${C.reset}            Re-run a specific item (e.g., after fixing a failure)
  ${C.cyan}failed${C.reset}              List all currently failed items
  ${C.cyan}retry-failed${C.reset}        Re-run all failed items to verify fixes
  ${C.cyan}plan <N>${C.reset}            Run all items in plan number N
  ${C.cyan}regression${C.reset}          Re-run all passed items to detect regressions
  ${C.cyan}report${C.reset} [--format]   Generate audit report (json, markdown, html)
  ${C.cyan}item <id>${C.reset}           Show full history for a specific item
  ${C.cyan}record <id> <status>${C.reset} Record manual test result (pass/fail)
  ${C.cyan}skip <id> [reason]${C.reset}  Skip an item with optional reason
  ${C.cyan}diagnose <id>${C.reset}       Diagnose a failed item (source files, errors, fix suggestion)
  ${C.cyan}restart${C.reset}              Restart the Electron app (wait for it to come back)
  ${C.cyan}reset-skipped${C.reset}       Reset 'no automation' skipped items for re-run
  ${C.cyan}reset --confirm${C.reset}     Reset all state (destructive)
  ${C.cyan}help${C.reset}                Show this help message

${C.bold}Workflow:${C.reset}
  next -> fix failures -> run <id> to retest -> next -> ...
  After many tests: regression -> fix regressions -> retry-failed
  After expanding automation: reset-skipped -> plan <N> (re-runs with new checks)

${C.bold}npm scripts:${C.reset}
  npm run test:audit             # Interactive (same as 'status')
  npm run test:audit:next        # Run next item
  npm run test:audit:status      # Show progress
  npm run test:audit:failed      # List failed items
  npm run test:audit:retry       # Re-run all failed items
  npm run test:audit:regression  # Run regression suite
  npm run test:audit:report      # Generate markdown report
`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'status';

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  const orch = new TestAuditOrchestrator();
  await orch.init();

  try {
    switch (command) {
      case 'status':
        await cmdStatus(orch);
        break;

      case 'next':
      case 'resume':
        await cmdNext(orch);
        break;

      case 'run':
      case 'rerun':
      case 'retest': {
        const itemId = args[1];
        if (!itemId) {
          console.error(`${C.red}Error: run requires an item ID. Example: run <item-id>${C.reset}`);
          process.exit(1);
        }
        await cmdRun(orch, itemId);
        break;
      }

      case 'failed':
      case 'failures':
        await cmdFailed(orch);
        break;

      case 'retry-failed':
      case 'retry':
        await cmdRetryFailed(orch);
        break;

      case 'plan': {
        const planNum = parseInt(args[1], 10);
        if (isNaN(planNum)) {
          console.error(`${C.red}Error: plan command requires a plan number. Example: plan 1${C.reset}`);
          process.exit(1);
        }
        await cmdPlan(orch, planNum);
        break;
      }

      case 'regression':
        await cmdRegression(orch);
        break;

      case 'report': {
        const format = args.includes('--format') ? args[args.indexOf('--format') + 1] : 'markdown';
        await cmdReport(orch, format || 'markdown');
        break;
      }

      case 'item': {
        const itemId = args[1];
        if (!itemId) {
          console.error(`${C.red}Error: item command requires an item ID.${C.reset}`);
          process.exit(1);
        }
        await cmdItem(orch, itemId);
        break;
      }

      case 'record': {
        const id = args[1];
        const status = args[2];
        const notes = args.slice(3).join(' ');
        if (!id || !status) {
          console.error(`${C.red}Error: record requires <id> <pass|fail> [notes]${C.reset}`);
          process.exit(1);
        }
        const mappedStatus = status === 'pass' ? 'passed' : status === 'fail' ? 'failed' : status;
        await cmdRecord(orch, id, mappedStatus, notes);
        break;
      }

      case 'skip': {
        const id = args[1];
        const reason = args.slice(2).join(' ');
        if (!id) {
          console.error(`${C.red}Error: skip requires an item ID.${C.reset}`);
          process.exit(1);
        }
        await cmdSkip(orch, id, reason);
        break;
      }

      case 'diagnose':
      case 'diag': {
        const itemId = args[1];
        if (!itemId) {
          console.error(`${C.red}Error: diagnose requires an item ID.${C.reset}`);
          process.exit(1);
        }
        await cmdDiagnose(orch, itemId);
        break;
      }

      case 'restart':
      case 'relaunch': {
        console.log(`${C.cyan}Sending restart command to app...${C.reset}`);
        const result = await orch.restartApp();
        if (result.success) {
          console.log(`${C.green}App restarted successfully in ${(result.downtime / 1000).toFixed(1)}s${C.reset}`);
        } else {
          console.error(`${C.red}Restart failed: ${result.error}${C.reset}`);
          process.exit(1);
        }
        break;
      }

      case 'reset-skipped': {
        const result = await orch.resetSkipped();
        console.log(`${C.green}${result.message}${C.reset}`);
        console.log(`${C.dim}These items will now be retested with expanded automation on next run.${C.reset}`);
        break;
      }

      case 'reset': {
        if (!args.includes('--confirm')) {
          console.error(`${C.red}Error: reset is destructive. Use 'reset --confirm' to proceed.${C.reset}`);
          process.exit(1);
        }
        await orch.reset(true);
        console.log(`${C.green}State reset to fresh. All progress cleared.${C.reset}`);
        break;
      }

      default:
        console.error(`${C.red}Unknown command: ${command}${C.reset}`);
        printHelp();
        process.exit(1);
    }
  } finally {
    await orch.close();
  }
}

// ─── Command Implementations ───

async function cmdStatus(orch) {
  const st = orch.status();
  const s = st.summary;

  console.log(`\n${C.bold}Test Audit Progress${C.reset}`);
  console.log(`${'─'.repeat(60)}`);
  console.log(`  Total:    ${C.bold}${s.total}${C.reset} items across ${st.plans.length} plans`);
  console.log(`  Passed:   ${C.green}${s.passed}${C.reset}`);
  console.log(`  Failed:   ${C.red}${s.failed}${C.reset}`);
  console.log(`  Skipped:  ${C.yellow}${s.skipped}${C.reset}`);
  console.log(`  Blocked:  ${C.magenta}${s.blocked}${C.reset}`);
  console.log(`  Pending:  ${C.cyan}${s.pending || 0}${C.reset}  ${C.dim}(awaiting manual record)${C.reset}`);
  console.log(`  Untested: ${C.gray}${s.untested}${C.reset}`);
  console.log(`  Complete: ${C.bold}${s.percentComplete}%${C.reset}`);
  console.log(`  Regressions: ${st.regressionRuns} runs recorded`);
  console.log(`${'─'.repeat(60)}`);

  // Per-plan table
  console.log(`\n${C.bold}Plan Status${C.reset}\n`);
  console.log(`  ${C.dim}${'#'.padStart(3)}  ${'Plan'.padEnd(32)} Status     Pass  Fail  Skip  Left${C.reset}`);
  for (const p of st.plans) {
    const num = String(p.number).padStart(3);
    const name = p.name.padEnd(32).slice(0, 32);
    const status = colorStatus(p.status).padEnd(18);
    const pass = String(p.passed).padStart(4);
    const fail = String(p.failed).padStart(5);
    const skip = String(p.skipped).padStart(5);
    const left = String(p.untested).padStart(5);
    console.log(`  ${num}  ${name} ${status} ${pass} ${fail} ${skip} ${left}`);
  }

  // Next item
  if (st.nextItem) {
    console.log(`\n${C.bold}Next item:${C.reset}`);
    console.log(`  [${st.nextItem.type}] ${st.nextItem.plan} > ${st.nextItem.description}`);
    console.log(`  ${C.dim}Run: node test/audit/cli.js next${C.reset}`);
  } else {
    console.log(`\n${C.green}All items have been tested!${C.reset}`);
  }
  console.log('');
}

async function cmdNext(orch) {
  const result = await orch.next();

  if (result.action === 'complete') {
    console.log(`\n${C.green}${C.bold}All items have been tested!${C.reset}`);
    return;
  }

  const item = result.item;
  console.log(`\n${C.bold}[${item.type}] ${item.plan} > ${item.section}${C.reset}`);
  console.log(`${C.dim}ID: ${item.id}${C.reset}`);
  console.log(`\n  ${item.description}\n`);

  if (result.action === 'automated') {
    const status = result.result.status;
    console.log(`  Result: ${colorStatus(status)}`);
    if (result.result.notes) console.log(`  ${C.dim}${result.result.notes}${C.reset}`);
    if (result.result.error) console.log(`  ${C.red}Error: ${result.result.error}${C.reset}`);

    // Show diagnosis on failure -- this is the fix loop entry point
    if (result.diagnosis) {
      printDiagnosis(result.diagnosis, item.id);
    }
  } else if (result.action === 'manual') {
    console.log(`  ${C.yellow}MANUAL TEST REQUIRED${C.reset}`);
    console.log(`  Perform this test, then record the result:`);
    console.log(`  ${C.dim}node test/audit/cli.js record ${item.id} pass${C.reset}`);
    console.log(`  ${C.dim}node test/audit/cli.js record ${item.id} fail "reason"${C.reset}`);
  } else if (result.action === 'verify') {
    console.log(`  ${C.cyan}VERIFICATION NEEDED${C.reset}`);
    console.log(`  Automated part: ${colorStatus(result.result.status)}`);
    if (result.result.notes) console.log(`  ${C.dim}${result.result.notes}${C.reset}`);
    console.log(`  Visually verify, then record:`);
    console.log(`  ${C.dim}node test/audit/cli.js record ${item.id} pass${C.reset}`);
    console.log(`  ${C.dim}node test/audit/cli.js record ${item.id} fail "reason"${C.reset}`);
  }

  // Show next preview
  if (result.next) {
    console.log(`\n${C.dim}Up next: [${result.next.type}] ${result.next.plan} > ${result.next.description}${C.reset}`);
  }
  console.log('');
}

async function cmdRun(orch, itemId) {
  try {
    const result = await orch.run(itemId);
    const item = result.item;

    console.log(`\n${C.bold}Re-running: [${item.type}] ${item.plan} > ${item.section}${C.reset}`);
    console.log(`${C.dim}ID: ${item.id}${C.reset}`);
    console.log(`\n  ${item.description}\n`);

    if (result.action === 'automated') {
      const status = result.result.status;
      console.log(`  Result: ${colorStatus(status)}`);
      if (result.result.notes) console.log(`  ${C.dim}${result.result.notes}${C.reset}`);
      if (result.result.error) console.log(`  ${C.red}Error: ${result.result.error}${C.reset}`);

      // Show diagnosis on failure
      if (result.diagnosis) {
        printDiagnosis(result.diagnosis, item.id);
      }
    } else if (result.action === 'manual') {
      console.log(`  ${C.yellow}MANUAL TEST REQUIRED${C.reset}`);
      console.log(`  ${C.dim}node test/audit/cli.js record ${item.id} pass${C.reset}`);
      console.log(`  ${C.dim}node test/audit/cli.js record ${item.id} fail "reason"${C.reset}`);
    } else if (result.action === 'verify') {
      console.log(`  ${C.cyan}VERIFICATION NEEDED${C.reset}`);
      console.log(`  Automated part: ${colorStatus(result.result.status)}`);
      if (result.result.notes) console.log(`  ${C.dim}${result.result.notes}${C.reset}`);
      console.log(`  ${C.dim}node test/audit/cli.js record ${item.id} pass${C.reset}`);
      console.log(`  ${C.dim}node test/audit/cli.js record ${item.id} fail "reason"${C.reset}`);
    }
    console.log('');
  } catch (err) {
    console.error(`${C.red}Error: ${err.message}${C.reset}`);
    console.log(`${C.dim}Hint: use 'item <id>' to look up an item, or 'failed' to list failed items${C.reset}`);
  }
}

async function cmdFailed(orch) {
  const st = orch.status();
  const failedItems = [];

  for (const plan of st.plans) {
    if (plan.failed > 0) {
      const items = orch._state._items
        .filter((i) => i.planNumber === plan.number)
        .map((i) => ({ ...i, state: orch._state._state.items[i.id] }))
        .filter((i) => i.state && i.state.status === 'failed');
      failedItems.push(...items);
    }
  }

  if (failedItems.length === 0) {
    console.log(`\n${C.green}No failed items.${C.reset}\n`);
    return;
  }

  console.log(`\n${C.bold}${C.red}Failed Items (${failedItems.length})${C.reset}\n`);
  for (const item of failedItems) {
    const lastRun = item.state.runs[item.state.runs.length - 1];
    const error = lastRun?.error || lastRun?.notes || '';
    console.log(`  ${C.red}[${item.type}]${C.reset} ${item.planName} > ${item.description}`);
    console.log(`      ${C.dim}ID: ${item.id}${C.reset}`);
    if (error) console.log(`      ${C.dim}Error: ${error}${C.reset}`);
    console.log(`      ${C.dim}Retest: node test/audit/cli.js run ${item.id}${C.reset}`);
    console.log('');
  }
  console.log(`${C.dim}Retry all: node test/audit/cli.js retry-failed${C.reset}\n`);
}

async function cmdRetryFailed(orch) {
  console.log(`\n${C.bold}Retrying all failed items...${C.reset}\n`);
  const result = await orch.retryFailed();

  if (!result.total) {
    console.log(`${C.yellow}${result.message}${C.reset}`);
    return;
  }

  console.log(`${'─'.repeat(50)}`);
  console.log(`  Total retried: ${result.total}`);
  console.log(`  Now passing:   ${C.green}${result.fixed.length}${C.reset}`);
  console.log(`  Still failing: ${C.red}${result.stillFailing.length}${C.reset}`);
  console.log(`  Duration:      ${(result.durationMs / 1000).toFixed(1)}s`);

  if (result.fixed.length > 0) {
    console.log(`\n  ${C.green}${C.bold}FIXED:${C.reset}`);
    for (const id of result.fixed) {
      console.log(`    ${C.green}+ ${id}${C.reset}`);
    }
  }

  if (result.stillFailing.length > 0) {
    console.log(`\n  ${C.red}${C.bold}STILL FAILING:${C.reset}`);
    for (const item of result.stillFailing) {
      if (item.action) {
        console.log(`    ${C.yellow}- ${item.id} (needs ${item.action})${C.reset}`);
      } else {
        console.log(`    ${C.red}- ${item.id}${item.error ? ': ' + item.error : ''}${C.reset}`);
      }
    }
  }
  console.log('');
}

async function cmdPlan(orch, planNumber) {
  console.log(`\n${C.bold}Running plan ${planNumber}...${C.reset}\n`);
  const result = await orch.runPlan(planNumber);

  console.log(`${C.bold}Plan ${planNumber}: ${result.planName}${C.reset}`);
  console.log(`${'─'.repeat(50)}`);
  for (const r of result.results) {
    const item = r.item;
    const status = r.result ? r.result.status : 'pending';
    const icon =
      r.action === 'manual'
        ? 'M'
        : r.action === 'verify'
          ? 'V'
          : status === 'passed'
            ? '+'
            : status === 'failed'
              ? 'X'
              : '-';
    console.log(`  [${icon}] ${colorStatus(status).padEnd(18)} ${item.description.slice(0, 60)}`);
  }
  console.log(`${'─'.repeat(50)}`);
  console.log(
    `  Total: ${result.summary.total}, Passed: ${C.green}${result.summary.passed}${C.reset}, Failed: ${C.red}${result.summary.failed}${C.reset}, Manual: ${C.yellow}${result.summary.manual}${C.reset}, Skipped: ${result.summary.skipped}`
  );
  console.log('');
}

async function cmdRegression(orch) {
  console.log(`\n${C.bold}Running regression tests...${C.reset}\n`);
  const result = await orch.regression();

  if (!result.runId) {
    console.log(`${C.yellow}${result.message}${C.reset}`);
    return;
  }

  console.log(`${C.bold}Regression Run: ${result.runId}${C.reset}`);
  console.log(`${'─'.repeat(50)}`);
  console.log(`  Items re-tested: ${result.total}`);
  console.log(`  Still passing:   ${C.green}${result.stillPassing.length}${C.reset}`);
  console.log(`  Regressions:     ${C.red}${result.regressions.length}${C.reset}`);
  console.log(`  Duration:        ${(result.durationMs / 1000).toFixed(1)}s`);

  if (result.regressions.length > 0) {
    console.log(`\n  ${C.red}${C.bold}REGRESSIONS DETECTED:${C.reset}`);
    for (const id of result.regressions) {
      console.log(`    ${C.red}- ${id}${C.reset}`);
    }
  } else {
    console.log(`\n  ${C.green}No regressions detected.${C.reset}`);
  }
  console.log('');
}

async function cmdReport(orch, format) {
  const report = await orch.report(format);
  if (typeof report === 'string') {
    console.log(report);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}

async function cmdItem(orch, itemId) {
  const item = orch.getItem(itemId);
  if (!item || !item.state) {
    // Try partial match
    const st = orch.status();
    const _matches = st.plans.flatMap((_p) => {
      const _items = orch._state ? [] : [];
      return [];
    });
    console.error(`${C.red}Item not found: ${itemId}${C.reset}`);
    console.log(`${C.dim}Hint: IDs use format "01-settings--section-name--description-slug"${C.reset}`);
    return;
  }

  console.log(`\n${C.bold}Item: ${item.id}${C.reset}`);
  console.log(`${'─'.repeat(60)}`);
  console.log(`  Plan:        ${item.planName} (${item.planFile})`);
  console.log(`  Section:     ${item.section}`);
  console.log(`  Description: ${item.description}`);
  console.log(`  Type:        ${item.type}`);
  console.log(`  Status:      ${colorStatus(item.state.status)}`);
  console.log(`  Last run:    ${item.state.lastRunAt || 'never'}`);
  console.log(`  Total runs:  ${item.state.runs.length}`);

  if (item.state.runs.length > 0) {
    console.log(`\n  ${C.bold}Run History:${C.reset}`);
    for (const run of item.state.runs) {
      console.log(
        `    ${C.dim}${run.timestamp}${C.reset} ${colorStatus(run.status)} (${run.durationMs}ms)${run.notes ? ' -- ' + run.notes : ''}${run.error ? ' ERROR: ' + run.error : ''}`
      );
    }
  }

  if (item.auditTrail.length > 0) {
    console.log(`\n  ${C.bold}Audit Trail:${C.reset}`);
    for (const e of item.auditTrail.slice(-10)) {
      console.log(`    ${C.dim}${e.ts}${C.reset} ${e.event}`);
    }
  }
  console.log('');
}

async function cmdRecord(orch, itemId, status, notes) {
  const result = await orch.recordResult(itemId, status, notes);
  console.log(`\n  ${colorStatus(result.status)} -- ${result.itemId}`);
  if (notes) console.log(`  ${C.dim}Notes: ${notes}${C.reset}`);
  console.log('');
}

async function cmdSkip(orch, itemId, reason) {
  const result = await orch.skip(itemId, reason);
  console.log(`\n  ${colorStatus('skipped')} -- ${result.itemId}`);
  if (reason) console.log(`  ${C.dim}Reason: ${reason}${C.reset}`);
  console.log('');
}

// ─── Diagnosis Display ───

/**
 * Print structured diagnostic info for a failed test item.
 * This is the key output that enables the fix loop -- gives the AI agent
 * (or human) everything needed to fix the issue immediately.
 */
function printDiagnosis(diag, itemId) {
  console.log(`\n  ${C.bold}${C.red}DIAGNOSIS${C.reset}`);
  console.log(`  ${'─'.repeat(56)}`);

  // Suggested action (most important -- this is the "what to fix")
  if (diag.suggestedAction) {
    console.log(`  ${C.bold}${C.yellow}FIX:${C.reset} ${diag.suggestedAction}`);
  }

  // Source files to investigate
  if (diag.sourceFiles.length > 0) {
    console.log(`\n  ${C.bold}Source files:${C.reset}`);
    for (const f of diag.sourceFiles) {
      console.log(`    ${C.cyan}${f}${C.reset}`);
    }
  }

  // Recent errors from log server
  if (diag.recentErrors.length > 0) {
    console.log(`\n  ${C.bold}Recent errors (from log server):${C.reset}`);
    for (const e of diag.recentErrors) {
      console.log(`    ${C.red}[${e.category}]${C.reset} ${e.message}`);
    }
  }

  // Extra context (exchange health, missing channels, etc.)
  if (diag.context) {
    if (diag.context.exchangeHealth) {
      const eh = diag.context.exchangeHealth;
      const status = eh.listening ? `${C.green}listening${C.reset}` : `${C.red}NOT listening (${eh.error})${C.reset}`;
      console.log(`\n  ${C.bold}Exchange port ${eh.port}:${C.reset} ${status}`);
    }
    if (diag.context.missingChannel) {
      console.log(`  ${C.bold}Missing IPC:${C.reset} ${diag.context.missingChannel}`);
      if (diag.context.expectedLocation) {
        console.log(`  ${C.bold}Expected in:${C.reset} ${diag.context.expectedLocation}`);
      }
    }
    if (diag.context.exchangeErrors && diag.context.exchangeErrors.length > 0) {
      console.log(`\n  ${C.bold}Exchange errors:${C.reset}`);
      for (const e of diag.context.exchangeErrors) {
        console.log(`    ${C.red}${e}${C.reset}`);
      }
    }
  }

  console.log(`\n  ${C.dim}After fixing, retest: node test/audit/cli.js run ${itemId}${C.reset}`);
  console.log(`  ${'─'.repeat(56)}`);
}

async function cmdDiagnose(orch, itemId) {
  try {
    const diag = await orch.diagnose(itemId);

    console.log(`\n${C.bold}Diagnosis for: ${itemId}${C.reset}`);
    console.log(`  Plan:    ${diag.planName}`);
    console.log(`  Section: ${diag.section}`);
    console.log(`  Test:    ${diag.description}`);
    console.log(`  Error:   ${C.red}${diag.error}${C.reset}`);

    printDiagnosis(diag, itemId);
    console.log('');
  } catch (err) {
    console.error(`${C.red}Error: ${err.message}${C.reset}`);
  }
}

// ─── Run ───
main().catch((err) => {
  console.error(`${C.red}Fatal error: ${err.message}${C.reset}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
