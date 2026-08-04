/**
 * Conversation-loop fixes (2026-08-04 "no joy" live test) — the four breaks
 * that made multi-turn voice conversations die:
 *  A. orb entered listening with a DEAD mic after asking a question
 *  B. stale pending-input hijacked new commands ("set an alarm" became
 *     "Prep me for the next meeting")
 *  C. a settle with no spokenSummary completed silently and ungraded
 *  D. awaitingInput -> speaking was an invalid transition (consent speech)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..', '..');

// ── B: pending TTL (behavioral) ─────────────────────────────────────────────
vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe('transcript-service pending TTL', () => {
  let ts;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { TranscriptService } = require('../../lib/transcript-service');
    ts = new TranscriptService();
  });

  it('a fresh pending is routable', () => {
    ts.setPending('app-agent', { taskId: 't1' });
    expect(ts.hasPending()).toBe(true);
  });

  it('a stale pending (>45s) expires and cannot hijack later commands', () => {
    ts.setPending('daily-brief-agent', { taskId: 't1' });
    vi.setSystemTime(Date.now() + 58000); // the live-test age
    expect(ts.hasPending()).toBe(false);
  });

  it('purge is per-entry: fresh pendings survive while stale ones expire', () => {
    ts.setPending('old-agent', { taskId: 'old' });
    vi.setSystemTime(Date.now() + 40000);
    ts.setPending('new-agent', { taskId: 'new' });
    vi.setSystemTime(Date.now() + 10000); // old=50s, new=10s
    ts.hasPending();
    expect(ts.getPendingAgentIds()).toEqual(['new-agent']);
  });
});

// ── B: relevance guard + C: silent-settle grading (source invariants) ──────
describe('exchange-bridge: hijack guard + silent-settle grading', () => {
  const SRC = readFileSync(resolve(REPO, 'src/voice-task-sdk/exchange-bridge.js'), 'utf8');

  it('routePendingInput bypasses when the utterance is unrelated to the pending options', () => {
    const idx = SRC.indexOf('async function routePendingInput');
    const body = SRC.slice(idx, idx + 3500);
    expect(body).toMatch(/voice:pending-bypass/);
    expect(body).toMatch(/return null; \/\/ caller falls through to the normal pipeline/);
    // Affirmatives (yes/build/skip...) must still route to the pending agent.
    expect(body).toMatch(/affirmative/);
  });

  it('a settle with NO spokenSummary is graded (not-spoken) instead of silent', () => {
    const idx = SRC.indexOf("} else if (!normalized.spokenSummary) {");
    expect(idx).toBeGreaterThan(-1);
    const body = SRC.slice(idx, idx + 900);
    expect(body).toMatch(/deliveryEval\.evaluateDelivery\(\{/);
    expect(body).toMatch(/speakAttempted:\s*false/);
  });
});

// ── A: mic re-acquisition (source invariants on orb.html) ───────────────────
describe('orb.html: followup-listen re-acquires a dead mic', () => {
  const ORB = readFileSync(resolve(REPO, 'orb.html'), 'utf8');

  it('extracted _acquireMicCapture exists and connecting-entry uses it', () => {
    expect(ORB).toMatch(/function _acquireMicCapture\(gen\)/);
    expect(ORB).toMatch(/_acquireMicCapture\(gen\);/);
  });

  it('listening-entry RE-ACQUIRES instead of warn-only, and reconnects the session', () => {
    const idx = ORB.indexOf('Entered listening without an active mic — re-acquiring');
    expect(idx).toBeGreaterThan(-1);
    const after = ORB.slice(idx, idx + 1400);
    expect(after).toMatch(/_acquireMicCapture\(_sessionGeneration\)/);
    expect(after).toMatch(/\.connect\(\)/);
    expect(after).toMatch(/isSessionReady/);
  });

  it('recoverable disconnects keep the mic; only terminal closes stop capture', () => {
    const idx = ORB.indexOf("disconnected: (e) =>");
    const body = ORB.slice(idx, idx + 1800);
    const terminalIdx = body.indexOf("kind === 'terminal'");
    const stopIdx = body.indexOf('stopAudioCapture()');
    expect(terminalIdx).toBeGreaterThan(-1);
    expect(stopIdx).toBeGreaterThan(terminalIdx); // stop only inside terminal branch
  });
});

// ── E: a delivered result must COMPLETE the turn (no false apology) ─────────
describe('orb.html: back-to-back speech completion ends the turn', () => {
  const ORB = readFileSync(resolve(REPO, 'orb.html'), 'utf8');
  it('speech-end in processing with settled task and no pending question goes idle', () => {
    const idx = ORB.indexOf('onSpeechState((speechState)');
    expect(idx).toBeGreaterThan(-1);
    const body = ORB.slice(idx, idx + 1600);
    expect(body).toMatch(/S\.phase === 'processing' && !_activeTaskId && !_pendingNeedsInput/);
    expect(body).toMatch(/'result-delivered'/);
  });
});

// ── D: consent speech during awaitingInput is a legal transition ────────────
describe('orb-state: awaitingInput -> speaking allowed', () => {
  it('VALID_TRANSITIONS includes speaking from awaitingInput', () => {
    const src = readFileSync(resolve(REPO, 'lib/orb/orb-state.js'), 'utf8');
    const m = src.match(/awaitingInput:\s*\[([^\]]*)\]/);
    expect(m[1]).toMatch(/'speaking'/);
  });
});
