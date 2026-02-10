/**
 * Corpus Runner -- tests each query one at a time against the live app.
 * Launches Electron, submits queries, reports agent + response.
 * 
 * Usage: node test-corpus-runner.js [start_index]
 *   start_index: 0-based index to start from (default: 0)
 */
const { _electron: electron } = require('playwright');
const path = require('path');

const CORPUS = [
  // Time Agent
  { query: 'what time is it',           expected: 'time-agent',     category: 'time' },
  { query: 'whats the time',            expected: 'time-agent',     category: 'time' },
  { query: 'tell me the current time',  expected: 'time-agent',     category: 'time' },
  { query: "what's today's date",       expected: 'time-agent',     category: 'time' },
  { query: 'what day is it',            expected: 'time-agent',     category: 'time' },
  { query: 'time please',              expected: 'time-agent',     category: 'time' },
  // Spelling Agent
  { query: 'spell necessary',                expected: 'spelling-agent', category: 'spelling' },
  { query: 'how do you spell accommodation', expected: 'spelling-agent', category: 'spelling' },
  { query: 'is recieve spelled correctly',   expected: 'spelling-agent', category: 'spelling' },
  { query: 'spell the word separate',        expected: 'spelling-agent', category: 'spelling' },
  { query: 'how do u spell definitely',      expected: 'spelling-agent', category: 'spelling' },
  { query: 'spell beautiful',               expected: 'spelling-agent', category: 'spelling' },
  // Help Agent
  { query: 'help',                       expected: 'help-agent',     category: 'help' },
  { query: 'what can you do',            expected: 'help-agent',     category: 'help' },
  { query: 'I need help',               expected: 'help-agent',     category: 'help' },
  { query: 'what are your capabilities', expected: 'help-agent',     category: 'help' },
  // Smalltalk Agent
  { query: 'hello',        expected: 'smalltalk-agent', category: 'smalltalk' },
  { query: 'hey',          expected: 'smalltalk-agent', category: 'smalltalk' },
  { query: 'good morning', expected: 'smalltalk-agent', category: 'smalltalk' },
  { query: 'thank you',    expected: 'smalltalk-agent', category: 'smalltalk' },
  { query: 'how are you',  expected: 'smalltalk-agent', category: 'smalltalk' },
  { query: 'goodbye',      expected: 'smalltalk-agent', category: 'smalltalk' },
  // App Agent
  { query: 'open settings',           expected: 'app-agent', category: 'app' },
  { query: 'open the video editor',   expected: 'app-agent', category: 'app' },
  { query: 'open settigns',           expected: 'app-agent', category: 'app' },
  { query: 'how do I export a video', expected: 'app-agent', category: 'app' },
  // Spaces Agent
  { query: 'open spaces',                expected: 'spaces-agent', category: 'spaces' },
  { query: 'show my clipboard',          expected: 'spaces-agent', category: 'spaces' },
  { query: 'create a space called Work', expected: 'spaces-agent', category: 'spaces' },
  { query: 'find my notes',             expected: 'spaces-agent', category: 'spaces' },
];

async function submitAndWait(orbPage, query, timeoutMs = 15000) {
  return orbPage.evaluate(async ({ q, t }) => {
    if (typeof window.agentHUD?.submitTask !== 'function') {
      return { error: 'agentHUD.submitTask not available' };
    }
    return new Promise((resolve) => {
      let resultData = null;
      const unsub = window.agentHUD.onResult((res) => { resultData = res; });
      const timer = setTimeout(() => { unsub(); resolve({ timedOut: true, result: resultData }); }, t);

      window.agentHUD.submitTask(q, { toolId: 'corpus-test', skipFilter: true })
        .then((sub) => {
          if (sub?.handled && !sub?.taskId) {
            clearTimeout(timer); unsub();
            resolve({ directResponse: sub });
            return;
          }
          const check = setInterval(() => {
            if (resultData) {
              clearInterval(check); clearTimeout(timer); unsub();
              resolve({ result: resultData });
            }
          }, 200);
        })
        .catch(e => { clearTimeout(timer); unsub(); resolve({ error: e.message }); });
    });
  }, { q: query, t: timeoutMs });
}

(async () => {
  const startIdx = parseInt(process.argv[2] || '0', 10);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  console.log('Launching app...');
  const electronApp = await electron.launch({
    args: [path.resolve('.')],
    env,
    timeout: 40000
  });

  const mainWindow = await electronApp.firstWindow();
  console.log('Waiting for full init...');
  await new Promise(r => setTimeout(r, 10000));

  // Open orb
  await electronApp.evaluate(() => {
    if (typeof global.toggleOrbWindow === 'function') global.toggleOrbWindow();
  });
  await new Promise(r => setTimeout(r, 5000));

  const windows = await electronApp.windows();
  const orbPage = windows.find(w => { try { return w.url().includes('orb.html'); } catch { return false; } });
  if (!orbPage) {
    console.log('FATAL: Orb window not found');
    await electronApp.close();
    process.exit(1);
  }

  console.log(`\nRunning corpus from index ${startIdx}...\n`);
  const results = [];

  for (let i = startIdx; i < CORPUS.length; i++) {
    const entry = CORPUS[i];
    const result = await submitAndWait(orbPage, entry.query);
    
    const agentId = result.result?.agentId || result.directResponse?.action || 'NONE';
    const success = result.result?.success;
    const message = (result.result?.message || result.directResponse?.message || '').slice(0, 120);
    const timedOut = result.timedOut || false;
    const correct = agentId === entry.expected;

    const status = timedOut ? 'TIMEOUT' : correct ? 'PASS' : 'WRONG';
    console.log(`[${i}] ${status} | "${entry.query}" | expected=${entry.expected} got=${agentId} | msg="${message}"`);

    results.push({ idx: i, status, query: entry.query, expected: entry.expected, got: agentId, message });

    // Pause between queries
    await new Promise(r => setTimeout(r, 2000));
  }

  // Summary
  console.log('\n=== SUMMARY ===');
  const pass = results.filter(r => r.status === 'PASS').length;
  const wrong = results.filter(r => r.status === 'WRONG').length;
  const timeout = results.filter(r => r.status === 'TIMEOUT').length;
  console.log(`PASS: ${pass}  WRONG: ${wrong}  TIMEOUT: ${timeout}  TOTAL: ${results.length}`);
  
  if (wrong > 0) {
    console.log('\nWRONG ROUTES:');
    results.filter(r => r.status === 'WRONG').forEach(r => {
      console.log(`  [${r.idx}] "${r.query}" expected=${r.expected} got=${r.got}`);
    });
  }
  if (timeout > 0) {
    console.log('\nTIMEOUTS:');
    results.filter(r => r.status === 'TIMEOUT').forEach(r => {
      console.log(`  [${r.idx}] "${r.query}" expected=${r.expected}`);
    });
  }

  // Cleanup
  try { await electronApp.evaluate(({ app }) => app.quit()); } catch(_) {}
  try { await electronApp.close(); } catch(_) {}
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
