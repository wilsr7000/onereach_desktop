/**
 * orb-chat-history -- persistent conversation log
 *
 * Pins:
 *   - Schema (every entry has the required fields)
 *   - Append + load round-trip
 *   - loadLast(N) returns at most N entries, newest at the end
 *   - Rotation (size never exceeds MAX_ENTRIES after triggered rotate)
 *   - Defensive validation (bad role/source/text rejected)
 *   - Malformed lines on disk are skipped, not crashed-on
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');

const history = require('../../lib/orb-chat-history.js');

let TMP_PATH;

beforeEach(() => {
  TMP_PATH = path.join(os.tmpdir(), `orb-chat-history-test-${Date.now()}-${Math.random()}.jsonl`);
  history._setHistoryPath(TMP_PATH);
});

afterEach(() => {
  try { fs.unlinkSync(TMP_PATH); } catch (_e) { /* gone */ }
  history._resetHistoryPath();
});

describe('orb-chat-history -- append + load round-trip', () => {
  it('appendEntry returns the stamped entry with id, ts, and all required fields', () => {
    const entry = history.appendEntry({
      role: 'user',
      source: 'voice',
      text: 'what time is it',
      inputModality: 'voice',
    });
    expect(entry.id).toBeTruthy();
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.role).toBe('user');
    expect(entry.source).toBe('voice');
    expect(entry.text).toBe('what time is it');
    expect(entry.agentId).toBeNull();
    expect(entry.agentName).toBeNull();
    expect(entry.cardHtml).toBeNull();
    expect(entry.modalAgentId).toBeNull();
    expect(entry.inputModality).toBe('voice');
  });

  it('loadLast returns entries in append order (oldest first)', () => {
    history.appendEntry({ role: 'user', source: 'voice', text: 'one' });
    history.appendEntry({ role: 'assistant', source: 'voice', text: 'two', agentId: 'time-agent' });
    history.appendEntry({ role: 'user', source: 'text', text: 'three' });
    const last = history.loadLast(10);
    expect(last.map((e) => e.text)).toEqual(['one', 'two', 'three']);
  });

  it('loadLast(N) caps to the most recent N when more entries exist', () => {
    for (let i = 0; i < 30; i++) {
      history.appendEntry({ role: 'user', source: 'text', text: `t${i}` });
    }
    const last = history.loadLast(5);
    expect(last).toHaveLength(5);
    expect(last.map((e) => e.text)).toEqual(['t25', 't26', 't27', 't28', 't29']);
  });

  it('loadLast() with no argument returns at most LOAD_DEFAULT entries', () => {
    for (let i = 0; i < 100; i++) {
      history.appendEntry({ role: 'user', source: 'text', text: `t${i}` });
    }
    const last = history.loadLast();
    expect(last.length).toBeLessThanOrEqual(history.LOAD_DEFAULT);
  });

  it('loadLast on empty history returns empty array', () => {
    expect(history.loadLast(50)).toEqual([]);
  });

  it('preserves cardHtml and modalAgentId when set', () => {
    history.appendEntry({
      role: 'assistant',
      source: 'voice',
      text: 'You have 3 meetings.',
      agentId: 'daily-brief-agent',
      agentName: 'Daily Brief Agent',
      cardHtml: '<div>inline</div>',
      modalAgentId: null,
      inputModality: 'voice',
    });
    history.appendEntry({
      role: 'assistant',
      source: 'voice',
      text: 'Daily brief shown.',
      agentId: 'daily-brief-agent',
      agentName: 'Daily Brief Agent',
      cardHtml: null,
      modalAgentId: 'daily-brief-agent',
      inputModality: 'voice',
    });
    const last = history.loadLast(2);
    expect(last[0].cardHtml).toBe('<div>inline</div>');
    expect(last[0].modalAgentId).toBeNull();
    expect(last[1].cardHtml).toBeNull();
    expect(last[1].modalAgentId).toBe('daily-brief-agent');
  });

  it('size() reports the on-disk entry count', () => {
    expect(history.size()).toBe(0);
    history.appendEntry({ role: 'user', source: 'voice', text: 'a' });
    history.appendEntry({ role: 'user', source: 'voice', text: 'b' });
    expect(history.size()).toBe(2);
  });

  it('clear() removes the file', () => {
    history.appendEntry({ role: 'user', source: 'voice', text: 'a' });
    history.clear();
    expect(history.size()).toBe(0);
    expect(history.loadLast(10)).toEqual([]);
  });
});

describe('orb-chat-history -- defensive validation', () => {
  it('throws on missing entry', () => {
    expect(() => history.appendEntry()).toThrow(TypeError);
    expect(() => history.appendEntry(null)).toThrow(TypeError);
  });

  it('throws on invalid role', () => {
    expect(() => history.appendEntry({ role: 'bot', source: 'voice', text: 'x' })).toThrow(RangeError);
  });

  it('throws on invalid source', () => {
    expect(() => history.appendEntry({ role: 'user', source: 'oops', text: 'x' })).toThrow(RangeError);
  });

  it('throws on non-string text', () => {
    expect(() => history.appendEntry({ role: 'user', source: 'voice', text: 42 })).toThrow(TypeError);
  });

  it('accepts the four valid sources', () => {
    history.appendEntry({ role: 'user', source: 'voice', text: 'a' });
    history.appendEntry({ role: 'user', source: 'text', text: 'b' });
    history.appendEntry({ role: 'system', source: 'breadcrumb', text: 'c' });
    history.appendEntry({ role: 'assistant', source: 'agent-proactive', text: 'd' });
    const last = history.loadLast(10);
    expect(last.map((e) => e.source)).toEqual(['voice', 'text', 'breadcrumb', 'agent-proactive']);
  });
});

describe('orb-chat-history -- malformed-line tolerance', () => {
  it('loadLast skips malformed JSON lines and returns the valid ones', () => {
    history.appendEntry({ role: 'user', source: 'voice', text: 'good1' });
    fs.appendFileSync(TMP_PATH, '{ this is not json }\n', 'utf8');
    history.appendEntry({ role: 'user', source: 'voice', text: 'good2' });
    const last = history.loadLast(10);
    expect(last.map((e) => e.text)).toEqual(['good1', 'good2']);
  });

  it('handles a file with only blank lines / whitespace as empty', () => {
    fs.writeFileSync(TMP_PATH, '\n\n\n', 'utf8');
    expect(history.loadLast(10)).toEqual([]);
  });
});

describe('orb-chat-history -- rotation', () => {
  it('size never exceeds MAX_ENTRIES after a forced rotate', () => {
    // Append > MAX_ENTRIES. The lazy rotation may not fire on every
    // append (probabilistic 1/64), so we explicitly rebuild the file
    // smaller via clear+seed, then verify the rotation invariant by
    // calling _maybeRotate-equivalent: we trigger it by writing a
    // huge file and forcing many appends.
    const max = history.MAX_ENTRIES;
    // Seed the file with max+50 entries directly to skip the slow path.
    const lines = [];
    for (let i = 0; i < max + 50; i++) {
      lines.push(JSON.stringify({
        id: `id${i}`, ts: new Date().toISOString(), role: 'user', source: 'voice',
        text: `t${i}`, agentId: null, agentName: null, cardHtml: null, modalAgentId: null, inputModality: 'voice',
      }));
    }
    fs.writeFileSync(TMP_PATH, lines.join('\n') + '\n', 'utf8');
    expect(history.size()).toBe(max + 50);

    // Force the rotation by appending many more times until the random
    // rotate gate fires. Cap iterations so this test can never spin.
    for (let i = 0; i < 2000 && history.size() > max; i++) {
      history.appendEntry({ role: 'user', source: 'voice', text: `extra${i}` });
    }
    expect(history.size()).toBeLessThanOrEqual(max);
  });
});
