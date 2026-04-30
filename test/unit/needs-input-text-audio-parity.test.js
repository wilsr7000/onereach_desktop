/**
 * Invariant: when an agent returns needsInput, the text shown in the
 * HUD / text-chat / conversation history must match what gets spoken
 * via TTS. Otherwise the user reads one thing and hears another -- a
 * real bug that showed up in production (the coffee-shop question got
 * a short HUD panel text and a longer spoken prompt).
 *
 * Two checks here:
 *   1. The known agents (Search Agent) return identical strings for
 *      `message` and `needsInput.prompt`, documenting the contract at
 *      the source.
 *   2. The orb response-router speaks `needsInput.prompt` when present
 *      and NOT a divergent `message`, so even if a future agent does
 *      regress this invariant the router picks the right field.
 *
 * Run: npx vitest run test/unit/needs-input-text-audio-parity.test.js
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));
vi.mock('../../lib/ai-service', () => ({ chat: vi.fn(), complete: vi.fn() }));
vi.mock('../../lib/http-client', () => ({ fetch: vi.fn() }));
vi.mock('../../lib/agent-memory-store', () => ({
  getAgentMemory: () => ({ load: vi.fn(), save: vi.fn() }),
}));

describe('needsInput text/audio parity -- source code invariant', () => {
  // Scan the Search Agent source for needsInput return sites and
  // confirm each one uses the SAME variable for `message` and
  // `needsInput.prompt`. We check textually rather than executing the
  // full agent because the return path is mid-function and has deps.
  it('Search Agent uses one variable for both message and needsInput.prompt at each site', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'packages', 'agents', 'search-agent.js'),
      'utf8'
    );
    // Find all `needsInput: {` blocks and their preceding `message:` line.
    const lines = src.split('\n');
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      if (/needsInput:\s*\{/.test(lines[i])) {
        // Look backwards up to 8 lines for a `message: ...` in the same return
        for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
          const m = lines[j].match(/message:\s*(.+?),?\s*$/);
          if (m) {
            hits.push({ lineMessage: j + 1, lineNeedsInput: i + 1, messageExpr: m[1] });
            break;
          }
        }
      }
    }
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      // Grab the prompt line within the needsInput block
      let promptExpr = null;
      for (let j = hit.lineNeedsInput; j < Math.min(lines.length, hit.lineNeedsInput + 10); j++) {
        const m = lines[j].match(/prompt:\s*(.+?),?\s*$/);
        if (m) { promptExpr = m[1]; break; }
      }
      expect(promptExpr, `${hit.lineNeedsInput}: needsInput block has no prompt`).not.toBeNull();
      // Either identical string literals or the same identifier. Strip
      // trailing commas / closing braces to make the comparison robust.
      const msgClean = hit.messageExpr.replace(/[,\s]+$/, '').trim();
      const promptClean = promptExpr.replace(/[,\s]+$/, '').trim();
      expect(msgClean, `line ${hit.lineMessage}/${hit.lineNeedsInput}: message and prompt differ. message=${msgClean} prompt=${promptClean}`)
        .toBe(promptClean);
    }
  });
});

describe('needsInput text/audio parity -- response router', () => {
  function loadRouter() {
    const code = fs.readFileSync(
      path.join(__dirname, '..', '..', 'lib', 'orb', 'orb-response-router.js'),
      'utf8'
    );
    const _window = {};
    const _ls = { _store: {}, getItem(k){return this._store[k]||null;}, setItem(k,v){this._store[k]=v;} };
    const fn = new Function('window', 'localStorage', 'console', code);
    fn(_window, _ls, console);
    return _window.OrbResponseRouter;
  }

  it('when needsInput is set, speech uses needsInput.prompt (not message)', () => {
    const router = loadRouter();
    const route = router.classify({
      success: true,
      message: 'short version',
      needsInput: { prompt: 'long version with helpful detail' },
    });
    expect(route.speech).toBe('long version with helpful detail');
  });

  it('falls back to message if prompt missing', () => {
    const router = loadRouter();
    const route = router.classify({
      success: true,
      message: 'only this',
      needsInput: {},
    });
    expect(route.speech).toBe('only this');
  });
});

describe('needsInput text/audio parity -- exchange-bridge output normalization', () => {
  // The exchange-bridge sends `output: needsInput.prompt || message` to
  // downstream consumers (text-chat, HUD). This check reads the source
  // file to verify that rule is encoded.
  it('built-in agent path prefers needsInput.prompt for the HUD output field', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'voice-task-sdk', 'exchange-bridge.js'),
      'utf8'
    );
    // Look for the two output-selection blocks. Each must reference
    // needsInput.prompt before the message fallback.
    const regex = /result\.needsInput && result\.needsInput\.prompt\s*\?\s*result\.needsInput\.prompt/g;
    const matches = src.match(regex) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
