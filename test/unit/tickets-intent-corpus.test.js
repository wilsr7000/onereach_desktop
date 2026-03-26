/**
 * Tickets Agent -- Intent Classification Corpus Test
 *
 * Runs a large corpus of phrases through the AI intent classifier
 * and reports accuracy against expected intents.
 *
 * Run from the app's Electron process (needs encrypted API keys):
 *   npx electron test/unit/tickets-intent-corpus.test.js
 *
 * Or standalone with an explicit key:
 *   ANTHROPIC_API_KEY=sk-ant-... node test/unit/tickets-intent-corpus.test.js
 */

'use strict';

// ---------------------------------------------------------------------------
// Corpus: [phrase, expectedIntent, description]
// ---------------------------------------------------------------------------

const CORPUS = [
  // ── summarize ──
  ['Summarize my tickets', 'summarize', 'direct'],
  ['Give me a ticket summary', 'summarize', 'direct'],
  ['Ticket overview', 'summarize', 'direct'],
  ['Ticket report', 'summarize', 'direct'],
  ['How are my tickets looking?', 'summarize', 'natural'],
  ['What is the state of my tickets?', 'summarize', 'natural'],
  ['Show me a summary of all my tickets', 'summarize', 'verbose'],
  ['Any updates on my tickets?', 'summarize', 'ambiguous-summarize'],
  ['Give me the big picture on tickets', 'summarize', 'colloquial'],

  // ── next_ticket ──
  ['What is my next ticket?', 'next_ticket', 'direct'],
  ['What should I work on next?', 'next_ticket', 'natural'],
  ['Next task', 'next_ticket', 'terse'],
  ['What should I do now?', 'next_ticket', 'natural'],
  ['Give me my next action item', 'next_ticket', 'gtd-style'],
  ['What is at the top of my queue?', 'next_ticket', 'colloquial'],
  ['Pick a ticket for me', 'next_ticket', 'imperative'],

  // ── create ──
  ['Create a ticket for fixing the login page', 'create', 'with-title'],
  ['New ticket: API returns 500 on POST', 'create', 'with-title'],
  ['Add a ticket', 'create', 'bare'],
  ['I need a new ticket for the deployment issue', 'create', 'natural'],
  ['Create an urgent ticket to fix production outage', 'create', 'with-priority'],
  ['Make a ticket about the CSS bug, low priority', 'create', 'with-priority'],
  ['Open a ticket for onboarding docs', 'create', 'synonym'],
  ['Log a ticket: database migration failing', 'create', 'synonym'],
  ['Create ticket: Update user settings page, tag it frontend', 'create', 'with-tags'],

  // ── assign ──
  ['Assign ticket tsk_abc123def to Sarah', 'assign', 'with-id-and-person'],
  ['Give ticket tsk_test12345 to the design team', 'assign', 'with-id-and-team'],
  ['Assign this ticket to John', 'assign', 'no-id'],
  ['Transfer ticket tsk_xyz987654 to Mike', 'assign', 'synonym'],
  ['Hand off tsk_abc123def to QA', 'assign', 'colloquial'],

  // ── block ──
  ["I'm blocked on tsk_abc123def", 'block', 'with-id'],
  ["Can't proceed with tsk_test12345, waiting on API keys", 'block', 'with-reason'],
  ["I'm stuck on a ticket", 'block', 'no-id'],
  ['This ticket is blocked because of a dependency', 'block', 'with-reason'],
  ["I can't move forward, waiting on design review", 'block', 'natural'],
  ['Mark tsk_abc123def as blocked, need client approval', 'block', 'explicit'],

  // ── unblock ──
  ['Unblock tsk_abc123def', 'unblock', 'direct'],
  ["I'm no longer blocked on tsk_test12345", 'unblock', 'natural'],
  ['Remove the block on my ticket', 'unblock', 'natural'],
  ['tsk_abc123def is clear now, unblock it', 'unblock', 'colloquial'],

  // ── status ──
  ['What is the status of tsk_abc123def?', 'status', 'with-id'],
  ['Where is ticket tsk_test12345?', 'status', 'colloquial'],
  ['Status of my login bug ticket', 'status', 'no-id-description'],
  ['Check on ticket tsk_abc123def', 'status', 'imperative'],
  ['How is tsk_test12345 progressing?', 'status', 'natural'],

  // ── explain ──
  ['Explain ticket tsk_abc123def', 'explain', 'direct'],
  ['Tell me about tsk_test12345', 'explain', 'natural'],
  ['What is ticket tsk_abc123def about?', 'explain', 'question'],
  ['Break down tsk_test12345 for me', 'explain', 'colloquial'],
  ['Give me the details on tsk_abc123def', 'explain', 'verbose'],
  ['Walk me through this ticket tsk_abc123def', 'explain', 'colloquial'],

  // ── list_assigned ──
  ['What tickets do I have?', 'list_assigned', 'direct'],
  ['Show my tickets', 'list_assigned', 'terse'],
  ['Tickets assigned to me', 'list_assigned', 'direct'],
  ['What am I working on?', 'list_assigned', 'natural'],
  ['List all my open tickets', 'list_assigned', 'verbose'],
  ['What do I have on my plate?', 'list_assigned', 'colloquial'],

  // ── list_blocked ──
  ["What's blocked?", 'list_blocked', 'direct'],
  ['Show me blocked tickets', 'list_blocked', 'direct'],
  ['Any tickets stuck?', 'list_blocked', 'colloquial'],
  ['Which tickets are blocked right now?', 'list_blocked', 'verbose'],
  ['List all blockers', 'list_blocked', 'synonym'],

  // ── complete ──
  ['Mark tsk_abc123def as done', 'complete', 'direct'],
  ['Complete ticket tsk_test12345', 'complete', 'direct'],
  ['I finished tsk_abc123def', 'complete', 'natural'],
  ["Done with tsk_test12345", 'complete', 'terse'],
  ['Close out tsk_abc123def', 'complete', 'synonym'],
  ['tsk_test12345 is finished, mark it complete', 'complete', 'verbose'],

  // ── extraction tests (check ticketId, priority, etc.) ──
  ['Create an urgent ticket called Deploy hotfix', 'create', 'extract-priority-urgent'],
  ['Create a low priority ticket for cleanup tasks', 'create', 'extract-priority-low'],
  ['Assign tsk_real99999 to alice@example.com', 'assign', 'extract-id-and-email'],

  // ── edge cases ──
  ['tickets', 'list_assigned', 'single-word'],
  ['help with tickets', 'list_assigned', 'ambiguous'],
  ['ticket?', 'list_assigned', 'minimal'],
];

// ---------------------------------------------------------------------------
// Standalone Anthropic API caller (no Electron dependency)
// ---------------------------------------------------------------------------

const CLASSIFY_PROMPT = `Classify this ticket management request and extract any details.

USER REQUEST: "{{PHRASE}}"

Return JSON:
{
  "intent": "<one of: summarize, next_ticket, create, assign, block, unblock, status, explain, list_assigned, list_blocked, complete>",
  "ticketId": "<ticket ID like tsk_xxxxxxxx if mentioned, else null>",
  "assignee": "<person name or user ID if mentioned, else null>",
  "title": "<ticket title if creating, else null>",
  "description": "<ticket description if creating, else null>",
  "priority": "<urgent, normal, or low if mentioned, else null>",
  "section": "<inbox, next-actions, waiting, or someday if mentioned, else null>",
  "tags": ["<any tags mentioned>"],
  "reason": "<reason if blocking, else null>"
}

Rules:
- "summarize my tickets", "ticket overview", "ticket report" → summarize
- "what is my next ticket", "next task", "what should I work on" → next_ticket
- "create a ticket", "new ticket", "add a ticket" → create
- "assign ticket to", "give ticket to" → assign
- "I'm blocked", "blocked on", "can't proceed" → block
- "unblock", "no longer blocked" → unblock
- "status of ticket", "where is ticket" → status
- "explain ticket", "tell me about ticket", "what is ticket" → explain
- "my tickets", "tickets assigned to me", "what do I have" → list_assigned
- "what's blocked", "blocked tickets", "show blocked" → list_blocked
- "done with ticket", "complete ticket", "finished", "mark done" → complete
- Extract ticket IDs (tsk_xxxxxxxxx) from the text when present
- Extract only what the user explicitly mentioned; leave fields null if not stated`;

async function classifyWithAnthropic(phrase, apiKey) {
  const prompt = CLASSIFY_PROMPT.replace('{{PHRASE}}', phrase);

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Anthropic API ${resp.status}: ${text.substring(0, 200)}`);
  }

  const data = await resp.json();
  const text = data.content?.[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`No JSON in response: ${text.substring(0, 100)}`);
  return JSON.parse(jsonMatch[0]);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Set ANTHROPIC_API_KEY env var to run this test.');
    console.error('  ANTHROPIC_API_KEY=sk-ant-... node test/unit/tickets-intent-corpus.test.js');
    process.exit(1);
  }

  console.log(`\nTickets Intent Corpus Test`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Corpus size: ${CORPUS.length} phrases`);
  console.log(`Model: claude-haiku-4-5-20251001\n`);

  const results = [];
  let passed = 0;
  let failed = 0;
  const failures = [];
  const intentCounts = {};

  for (let i = 0; i < CORPUS.length; i++) {
    const [phrase, expected, desc] = CORPUS[i];
    process.stdout.write(`[${i + 1}/${CORPUS.length}] "${phrase.substring(0, 50).padEnd(50)}" `);

    try {
      const result = await classifyWithAnthropic(phrase, apiKey);

      const actual = result.intent;
      const match = actual === expected;
      if (match) {
        passed++;
        process.stdout.write(`PASS (${actual})\n`);
      } else {
        failed++;
        process.stdout.write(`FAIL (got: ${actual}, expected: ${expected})\n`);
        failures.push({ phrase, expected, actual, desc });
      }

      intentCounts[actual] = (intentCounts[actual] || 0) + 1;

      results.push({
        phrase,
        expected,
        actual,
        match,
        desc,
        ticketId: result.ticketId,
        priority: result.priority,
        title: result.title,
        assignee: result.assignee,
        reason: result.reason,
        tags: result.tags,
      });
    } catch (err) {
      failed++;
      process.stdout.write(`ERROR: ${err.message.substring(0, 80)}\n`);
      failures.push({ phrase, expected, actual: 'ERROR', desc, error: err.message });
      results.push({ phrase, expected, actual: 'ERROR', match: false, desc });
    }
  }

  // ── Report ──
  console.log(`\n${'='.repeat(60)}`);
  console.log(`RESULTS: ${passed}/${CORPUS.length} passed (${((passed / CORPUS.length) * 100).toFixed(1)}%)`);
  console.log(`${'='.repeat(60)}`);

  if (failures.length > 0) {
    console.log(`\nFAILURES (${failures.length}):`);
    for (const f of failures) {
      console.log(`  "${f.phrase}" → got "${f.actual}", expected "${f.expected}" [${f.desc}]`);
    }
  }

  console.log('\nIntent distribution:');
  for (const [intent, count] of Object.entries(intentCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${intent}: ${count}`);
  }

  // ── Extraction spot checks ──
  console.log('\nExtraction spot checks:');
  const extractionChecks = results.filter((r) =>
    r.desc?.startsWith('extract-') || r.desc === 'with-id-and-person' || r.desc === 'with-reason'
  );
  for (const r of extractionChecks) {
    const extras = [];
    if (r.ticketId) extras.push(`id=${r.ticketId}`);
    if (r.priority) extras.push(`priority=${r.priority}`);
    if (r.title) extras.push(`title="${r.title}"`);
    if (r.assignee) extras.push(`assignee=${r.assignee}`);
    if (r.reason) extras.push(`reason="${r.reason}"`);
    if (r.tags?.length && r.tags[0]) extras.push(`tags=[${r.tags.join(',')}]`);
    console.log(`  "${r.phrase.substring(0, 55)}" → ${r.actual} | ${extras.join(', ') || '(none extracted)'}`);
  }

  // Write JSON report
  const fs = require('fs');
  const reportPath = require('path').join(__dirname, '..', 'corpus-tickets-intent.json');
  fs.writeFileSync(reportPath, JSON.stringify({ passed, failed, total: CORPUS.length, accuracy: ((passed / CORPUS.length) * 100).toFixed(1) + '%', failures, results }, null, 2));
  console.log(`\nFull report: ${reportPath}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
