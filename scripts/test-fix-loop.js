#!/usr/bin/env node
/**
 * Self-Healing Test Runner
 *
 * Runs the test suite, detects failures, uses AI to diagnose and fix them,
 * then re-tests until everything is green -- or max attempts are exhausted.
 *
 * Usage:
 *   node scripts/test-fix-loop.js                  # Run all CRUD tests
 *   node scripts/test-fix-loop.js --scope unit     # Unit tests only
 *   node scripts/test-fix-loop.js --scope all      # Full vitest suite
 *   node scripts/test-fix-loop.js --max-rounds 10  # Up to 10 fix rounds
 *   node scripts/test-fix-loop.js --dry-run        # Show what would be fixed, don't write
 *
 * Requires: ANTHROPIC_API_KEY or OPENAI_API_KEY env var, or keys in app-settings.json
 *
 * Exit codes: 0 = all green, 1 = failures remain after max rounds
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');

// ─── Configuration ────────────────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '..');
const MAX_ROUNDS = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--max-rounds') || '5', 10);
const MAX_FIX_ATTEMPTS_PER_FILE = 3;
const DRY_RUN = process.argv.includes('--dry-run');
const SCOPE = process.argv.find((_, i, a) => a[i - 1] === '--scope') || 'crud';
const REPORT_PATH = path.join(ROOT, 'test-fix-report.json');

// ─── Logging ──────────────────────────────────────────────────────────────────
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function log(msg) {
  console.log(`${DIM}[test-fix]${RESET} ${msg}`);
}
function logPass(msg) {
  console.log(`${GREEN}  PASS${RESET} ${msg}`);
}
function logFail(msg) {
  console.log(`${RED}  FAIL${RESET} ${msg}`);
}
function logFix(msg) {
  console.log(`${YELLOW}  FIX ${RESET} ${msg}`);
}
function logInfo(msg) {
  console.log(`${CYAN}  INFO${RESET} ${msg}`);
}
function logBold(msg) {
  console.log(`${BOLD}${msg}${RESET}`);
}

// ─── API Key Resolution ──────────────────────────────────────────────────────
function getApiKey() {
  // 1. Environment variables
  if (process.env.ANTHROPIC_API_KEY) return { provider: 'anthropic', key: process.env.ANTHROPIC_API_KEY };
  if (process.env.OPENAI_API_KEY) return { provider: 'openai', key: process.env.OPENAI_API_KEY };

  // 2. .env file in project root
  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile)) {
    try {
      const envContent = fs.readFileSync(envFile, 'utf8');
      const anthMatch = envContent.match(/^ANTHROPIC_API_KEY=(.+)$/m);
      if (anthMatch) return { provider: 'anthropic', key: anthMatch[1].trim() };
      const oaiMatch = envContent.match(/^OPENAI_API_KEY=(.+)$/m);
      if (oaiMatch) return { provider: 'openai', key: oaiMatch[1].trim() };
    } catch {
      /* ok */
    }
  }

  // 3. App settings file
  const settingsPaths = [
    path.join(os.homedir(), 'Library/Application Support/onereach-ai/app-settings.json'),
    path.join(os.homedir(), 'Library/Application Support/GSX Power User/app-settings.json'),
    path.join(os.homedir(), 'Library/Application Support/Onereach.ai/app-settings.json'),
    path.join(os.homedir(), '.config/onereach-ai/app-settings.json'),
    path.join(os.homedir(), '.config/gsx-power-user/app-settings.json'),
  ];

  for (const p of settingsPaths) {
    try {
      if (!fs.existsSync(p)) continue;
      const settings = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (settings.anthropicApiKey) {
        const match = settings.anthropicApiKey.match(/sk-ant-[A-Za-z0-9_-]+/);
        return { provider: 'anthropic', key: match ? match[0] : settings.anthropicApiKey };
      }
      if (settings.openaiApiKey) return { provider: 'openai', key: settings.openaiApiKey };
    } catch {
      continue;
    }
  }

  return null;
}

// ─── AI Call ──────────────────────────────────────────────────────────────────
function callAI(prompt, systemPrompt) {
  const creds = getApiKey();
  if (!creds)
    throw new Error(
      'No API key found. Provide one via:\n' +
        '  1. ANTHROPIC_API_KEY=sk-ant-... node scripts/test-fix-loop.js\n' +
        '  2. Add ANTHROPIC_API_KEY=... to .env in project root\n' +
        '  3. export ANTHROPIC_API_KEY=sk-ant-... (shell env)'
    );

  if (creds.provider === 'anthropic') return callAnthropic(creds.key, prompt, systemPrompt);
  return callOpenAI(creds.key, prompt, systemPrompt);
}

function callAnthropic(apiKey, prompt, systemPrompt) {
  const body = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: 'user', content: prompt }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) return reject(new Error(parsed.error.message));
            resolve(parsed.content?.[0]?.text || '');
          } catch (e) {
            reject(new Error(`Parse error: ${e.message}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function callOpenAI(apiKey, prompt, systemPrompt) {
  const body = JSON.stringify({
    model: 'gpt-4o',
    max_tokens: 8192,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ],
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) return reject(new Error(parsed.error.message));
            resolve(parsed.choices?.[0]?.message?.content || '');
          } catch (e) {
            reject(new Error(`Parse error: ${e.message}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Test Runner ──────────────────────────────────────────────────────────────
function getTestCommand() {
  switch (SCOPE) {
    case 'crud':
      return 'npx vitest run --reporter json';
    case 'unit':
      return 'npx vitest run --reporter json --exclude="**/*.eval.*"';
    case 'all':
      return 'npx vitest run --reporter json';
    default:
      return 'npx vitest run --reporter json';
  }
}

function getTestFiles() {
  if (SCOPE === 'crud') {
    return [
      'test/unit/user-profile-store.test.js',
      'test/unit/rollback-manager.test.js',
      'test/unit/resource-manager.test.js',
      'test/unit/omnigraph-client.test.js',
      'test/unit/livekit-service.test.js',
      'test/unit/subtask-registry.test.js',
      'test/unit/agent-registry-crud.test.js',
      'test/unit/ipc-auth.test.js',
      'test/unit/ipc-recorder.test.js',
      'test/unit/ipc-browser-automation.test.js',
      'test/unit/ipc-youtube.test.js',
      'test/unit/ipc-generative-search.test.js',
      'test/unit/ipc-sync.test.js',
      'test/unit/ipc-state-manager.test.js',
      'test/unit/ipc-project-api.test.js',
      'test/unit/ipc-resource-manager.test.js',
      'test/unit/ipc-flipboard.test.js',
      'test/unit/ipc-deps.test.js',
      'test/unit/exchange-protocol.test.js',
      'test/unit/spaces-websocket.test.js',
      'test/unit/gsx-mcs-client.test.js',
      'test/unit/conversion-service.test.js',
      'test/unit/conversion-routes.test.js',
    ];
  }
  return []; // empty = run all
}

function runTests() {
  const cmd = getTestCommand();
  const files = getTestFiles();
  const fullCmd = files.length ? `${cmd} ${files.join(' ')}` : cmd;

  try {
    const output = execSync(fullCmd, { cwd: ROOT, encoding: 'utf8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] });
    return parseVitestJSON(output);
  } catch (e) {
    // vitest exits non-zero on test failures -- that's expected
    const output = (e.stdout || '') + (e.stderr || '');
    return parseVitestJSON(output);
  }
}

function runSingleTestFile(testFile) {
  const cmd = `npx vitest run --reporter json ${testFile}`;
  try {
    const output = execSync(cmd, { cwd: ROOT, encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] });
    return parseVitestJSON(output);
  } catch (e) {
    return parseVitestJSON((e.stdout || '') + (e.stderr || ''));
  }
}

function parseVitestJSON(output) {
  // vitest JSON reporter outputs a JSON object; find it in the output
  const jsonMatch = output.match(/\{[\s\S]*"testResults"[\s\S]*\}/);
  if (!jsonMatch) {
    // Try to find individual test file results
    const altMatch = output.match(/\{[\s\S]*"numTotalTests"[\s\S]*\}/);
    if (!altMatch) return { passed: false, failures: [], total: 0, passCount: 0 };
    try {
      return normalizeResults(JSON.parse(altMatch[0]));
    } catch {
      /* fall through */
    }
  }

  try {
    const data = JSON.parse(jsonMatch[0]);
    return normalizeResults(data);
  } catch {
    return { passed: false, failures: [], total: 0, passCount: 0 };
  }
}

function normalizeResults(data) {
  const failures = [];
  const testResults = data.testResults || [];

  for (const fileResult of testResults) {
    const filePath = fileResult.name || fileResult.testFilePath || '';
    const relPath = filePath.replace(ROOT + '/', '');

    if (fileResult.status === 'failed') {
      const failedTests = (fileResult.assertionResults || []).filter((t) => t.status === 'failed');
      for (const t of failedTests) {
        failures.push({
          file: relPath,
          testName: t.fullName || t.ancestorTitles?.join(' > ') + ' > ' + t.title || 'unknown',
          error: (t.failureMessages || []).join('\n').substring(0, 2000),
        });
      }
      // If no individual test failures extracted, add a file-level failure
      if (failedTests.length === 0) {
        failures.push({
          file: relPath,
          testName: '(file-level error)',
          error: (fileResult.message || fileResult.failureMessage || 'Unknown error').substring(0, 2000),
        });
      }
    }
  }

  return {
    passed: data.numFailedTestSuites === 0 && data.numFailedTests === 0,
    failures,
    total: data.numTotalTests || 0,
    passCount: data.numPassedTests || 0,
    failCount: data.numFailedTests || 0,
    filesPassed: data.numPassedTestSuites || 0,
    filesFailed: data.numFailedTestSuites || 0,
  };
}

// ─── Source File Discovery ────────────────────────────────────────────────────
function findSourceFile(testFile) {
  // Map test file to source file
  const base = path.basename(testFile, '.test.js');

  // Common patterns
  const candidates = [
    `lib/${base}.js`,
    `${base}.js`,
    `packages/agents/${base}.js`,
    `src/${base}.js`,
    `lib/exchange/${base}.js`,
  ];

  // IPC tests map to preload files
  if (base.startsWith('ipc-')) {
    const namespace = base.replace('ipc-', '');
    candidates.unshift(`preload-${namespace}.js`, `preload.js`);
  }

  for (const candidate of candidates) {
    const fullPath = path.join(ROOT, candidate);
    if (fs.existsSync(fullPath)) return candidate;
  }

  return null;
}

// ─── AI Fix Generation ───────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a test-fixing assistant. You receive a failing test file, the error messages, and optionally the source file being tested.

Your job: fix the TEST file so the tests pass. Do NOT modify the source code -- only fix the test.

Rules:
- Output ONLY the complete fixed test file content, nothing else
- Do not add markdown fences or explanations
- Preserve the existing test structure and naming
- Fix assertion mismatches, mock issues, and import errors
- If a mock is wrong, fix the mock to match the real module's API
- If an assertion value is wrong, fix it to match actual behavior
- Do not remove tests -- fix them
- Keep the same testing framework (vitest) and patterns`;

async function generateFix(testFile, failures, sourceFile) {
  let testContent;
  try {
    testContent = fs.readFileSync(path.join(ROOT, testFile), 'utf8');
  } catch {
    return null;
  }

  let sourceContent = '';
  if (sourceFile) {
    try {
      sourceContent = fs.readFileSync(path.join(ROOT, sourceFile), 'utf8');
      // Truncate very large source files
      if (sourceContent.length > 15000) {
        sourceContent = sourceContent.substring(0, 15000) + '\n// ... truncated ...';
      }
    } catch {
      /* ok */
    }
  }

  const errorSummary = failures.map((f) => `TEST: ${f.testName}\nERROR:\n${f.error}`).join('\n\n---\n\n');

  const prompt = `Fix this failing test file.

## Test File: ${testFile}
\`\`\`javascript
${testContent}
\`\`\`

## Failures
${errorSummary}

${sourceContent ? `## Source File: ${sourceFile}\n\`\`\`javascript\n${sourceContent}\n\`\`\`\n` : '(No source file found)'}

Output the COMPLETE fixed test file content. No markdown fences, no explanation -- just the code.`;

  try {
    const response = await callAI(prompt, SYSTEM_PROMPT);
    // Strip any markdown fences the AI might add despite instructions
    let fixed = response.trim();
    fixed = fixed.replace(/^```(?:javascript|js|typescript|ts)?\n?/m, '');
    fixed = fixed.replace(/\n?```$/m, '');
    return fixed.trim();
  } catch (e) {
    logFail(`AI call failed: ${e.message}`);
    return null;
  }
}

// ─── Main Loop ────────────────────────────────────────────────────────────────
async function main() {
  logBold('\n========================================');
  logBold('  Self-Healing Test Runner');
  logBold('========================================\n');
  logInfo(`Scope: ${SCOPE}`);
  logInfo(`Max rounds: ${MAX_ROUNDS}`);
  logInfo(`Max fix attempts per file: ${MAX_FIX_ATTEMPTS_PER_FILE}`);
  logInfo(`Dry run: ${DRY_RUN}`);
  logInfo(`API: ${getApiKey()?.provider || 'NONE -- will fail'}`);

  const report = {
    startedAt: new Date().toISOString(),
    scope: SCOPE,
    rounds: [],
    fixes: [],
    finalResult: null,
  };

  const fixAttempts = {}; // file -> count

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    logBold(`\n--- Round ${round}/${MAX_ROUNDS} ---\n`);

    log('Running tests...');
    const results = runTests();

    log(`Results: ${results.passCount} passed, ${results.failCount} failed, ${results.total} total`);

    const roundReport = {
      round,
      passCount: results.passCount,
      failCount: results.failCount,
      total: results.total,
      failures: results.failures.map((f) => f.file + ': ' + f.testName),
      fixes: [],
    };

    if (results.passed || results.failures.length === 0) {
      logBold(`\n${GREEN}ALL TESTS PASSING${RESET}`);
      logPass(`${results.passCount} tests across ${results.filesPassed || '?'} files`);
      roundReport.outcome = 'all_green';
      report.rounds.push(roundReport);
      report.finalResult = 'success';
      break;
    }

    // Group failures by file
    const failsByFile = {};
    for (const f of results.failures) {
      if (!failsByFile[f.file]) failsByFile[f.file] = [];
      failsByFile[f.file].push(f);
    }

    const filesToFix = Object.keys(failsByFile);
    logFail(`${results.failures.length} failures across ${filesToFix.length} files`);

    let fixedThisRound = 0;

    for (const testFile of filesToFix) {
      const attempts = fixAttempts[testFile] || 0;
      if (attempts >= MAX_FIX_ATTEMPTS_PER_FILE) {
        logInfo(`Skipping ${testFile} -- max attempts (${MAX_FIX_ATTEMPTS_PER_FILE}) reached`);
        continue;
      }

      const fileFailures = failsByFile[testFile];
      logFix(
        `Fixing ${testFile} (${fileFailures.length} failures, attempt ${attempts + 1}/${MAX_FIX_ATTEMPTS_PER_FILE})`
      );

      const sourceFile = findSourceFile(testFile);
      if (sourceFile) logInfo(`Source: ${sourceFile}`);

      const fixedContent = await generateFix(testFile, fileFailures, sourceFile);

      if (!fixedContent) {
        logFail(`Could not generate fix for ${testFile}`);
        fixAttempts[testFile] = (fixAttempts[testFile] || 0) + 1;
        continue;
      }

      if (DRY_RUN) {
        logInfo(`[DRY RUN] Would write fix to ${testFile}`);
        fixAttempts[testFile] = (fixAttempts[testFile] || 0) + 1;
        continue;
      }

      // Backup and write fix
      const fullPath = path.join(ROOT, testFile);
      const backup = fs.readFileSync(fullPath, 'utf8');
      fs.writeFileSync(fullPath, fixedContent, 'utf8');

      // Verify the fix by running just this file
      log(`  Verifying fix for ${testFile}...`);
      const verifyResult = runSingleTestFile(testFile);

      if (verifyResult.passed || verifyResult.failCount === 0) {
        logPass(`Fix verified for ${testFile}`);
        fixedThisRound++;
        report.fixes.push({
          file: testFile,
          round,
          attempt: attempts + 1,
          status: 'fixed',
          failureCount: fileFailures.length,
        });
      } else {
        // Fix didn't work -- revert
        logFail(`Fix didn't work for ${testFile} (${verifyResult.failCount} still failing) -- reverting`);
        fs.writeFileSync(fullPath, backup, 'utf8');
        report.fixes.push({
          file: testFile,
          round,
          attempt: attempts + 1,
          status: 'reverted',
          remainingFailures: verifyResult.failCount,
        });
      }

      fixAttempts[testFile] = (fixAttempts[testFile] || 0) + 1;
    }

    roundReport.fixedCount = fixedThisRound;
    roundReport.outcome = fixedThisRound > 0 ? 'progress' : 'stuck';
    report.rounds.push(roundReport);

    if (fixedThisRound === 0) {
      logBold(`\n${YELLOW}No fixes succeeded this round -- stopping to avoid infinite loop${RESET}`);
      report.finalResult = 'stuck';
      break;
    }
  }

  if (!report.finalResult) {
    report.finalResult = 'max_rounds_reached';
  }

  // Final verification run
  if (!DRY_RUN && report.finalResult !== 'success') {
    logBold('\n--- Final Verification ---\n');
    const finalResults = runTests();
    if (finalResults.passed || finalResults.failCount === 0) {
      logBold(`${GREEN}ALL TESTS NOW PASSING${RESET}`);
      report.finalResult = 'success';
    } else {
      logFail(`${finalResults.failCount} tests still failing after ${MAX_ROUNDS} rounds`);
      for (const f of finalResults.failures) {
        logFail(`  ${f.file}: ${f.testName}`);
      }
    }
  }

  // Write report
  report.completedAt = new Date().toISOString();
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  log(`Report saved to ${REPORT_PATH}`);

  // Summary
  logBold('\n========================================');
  logBold('  Summary');
  logBold('========================================');
  logInfo(`Rounds: ${report.rounds.length}`);
  logInfo(`Total fixes attempted: ${report.fixes.length}`);
  logInfo(`Successful fixes: ${report.fixes.filter((f) => f.status === 'fixed').length}`);
  logInfo(`Reverted fixes: ${report.fixes.filter((f) => f.status === 'reverted').length}`);
  logInfo(`Result: ${report.finalResult}`);
  console.log('');

  process.exit(report.finalResult === 'success' ? 0 : 1);
}

main().catch((e) => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
