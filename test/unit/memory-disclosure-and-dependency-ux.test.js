/**
 * UC-04: the user is TOLD when memory was updated.
 * UC-18: dependency-down failures speak actionable guidance, never a shrug.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { normalizeResult } from '../../packages/agents/agent-middleware.js';
import { resolveTools } from '../../lib/agent-tools.js';

const eventsStore = require('../../lib/events/events-store.js');
const { isGraphConfigError, friendlyGraphError } = eventsStore;

// ─── UC-04: memory-update disclosure ────────────────────────────────────────

describe('memory-update disclosure (UC-04)', () => {
  it('appends the disclosure when an agent reports what it learned', () => {
    const out = normalizeResult({
      success: true,
      message: 'Timer set for 4 minutes.',
      memoryUpdated: 'preferred timer sound: chime',
    });
    expect(out.message).toBe(
      "Timer set for 4 minutes. I've updated my memory: preferred timer sound: chime."
    );
  });

  it('does not double-disclose when the agent already mentioned memory', () => {
    const out = normalizeResult({
      success: true,
      message: 'Saved to memory: you prefer Celsius.',
      memoryUpdated: 'temperature units',
    });
    expect(out.message).toBe('Saved to memory: you prefer Celsius.');
  });

  it('says nothing about memory when nothing was learned', () => {
    const out = normalizeResult({ success: true, message: 'Done.' });
    expect(out.message).toBe('Done.');
    expect(normalizeResult({ success: true, message: 'Done.', memoryUpdated: '  ' }).message).toBe('Done.');
  });

  it('caps runaway summaries', () => {
    const out = normalizeResult({
      success: true,
      message: 'Done.',
      memoryUpdated: 'x'.repeat(300),
    });
    expect(out.message.length).toBeLessThan(120);
  });

  it('learnFromInteraction reports learned preference keys (the producer contract)', async () => {
    const { learnFromInteraction } = require('../../lib/thinking-agent');
    const sections = new Map([['Learned Preferences', '']]);
    const memory = {
      isLoaded: () => true,
      appendToSection: vi.fn(),
      parseSectionAsKeyValue: vi.fn(() => ({})),
      updateSectionAsKeyValue: vi.fn((name, kv) => sections.set(name, kv)),
      save: vi.fn(),
    };

    const learned = await learnFromInteraction(
      memory,
      { content: 'set my timer sound to chime' },
      { success: true, message: 'ok' },
      { learnedPreferences: { timerSound: 'chime' } }
    );
    expect(learned).toEqual({ learnedKeys: ['timerSound'] });

    // History-only interactions do NOT claim a memory update
    const nothing = await learnFromInteraction(
      memory,
      { content: 'what time is it' },
      { success: true, message: 'ok' },
      {}
    );
    expect(nothing).toBeNull();
  });

  it('the local executor surfaces learnings as memoryUpdated (source invariant)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../../src/voice-task-sdk/exchange-bridge.js'), 'utf8');
    expect(src).toMatch(/learned\.learnedKeys[\s\S]{0,200}memoryUpdated/);
  });
});

// ─── UC-18: dependency-down guidance ────────────────────────────────────────

describe('dependency-down guidance (UC-18)', () => {
  const CONFIG_ERR = new Error('OmniGraph client not ready (Neo4j unconfigured?)');

  it('classifies config errors vs real errors', () => {
    expect(isGraphConfigError(CONFIG_ERR)).toBe(true);
    expect(isGraphConfigError(new Error('Neo4j password not configured'))).toBe(true);
    expect(isGraphConfigError(new Error('constraint violation on :Event'))).toBe(false);
  });

  it('maps config errors to spoken-ready guidance with a settings pointer', () => {
    const msg = friendlyGraphError(CONFIG_ERR);
    expect(msg).toMatch(/not set up on this Mac/i);
    expect(msg).toMatch(/Settings/);
    expect(msg).toMatch(/Neo4j Aura credentials/);
    // non-config errors pass through untouched
    expect(friendlyGraphError(new Error('boom'))).toBe('boom');
  });

  describe('graph-backed tools surface the guidance', () => {
    beforeEach(() => {
      eventsStore._setTestDeps({
        getClient: () => ({
          executeQuery: async () => {
            throw CONFIG_ERR;
          },
        }),
        now: () => new Date(2026, 7, 3, 10, 0, 0),
      });
    });
    afterEach(() => {
      eventsStore._setTestDeps(null);
    });

    for (const toolName of ['events_add', 'events_next', 'events_delete']) {
      it(`${toolName} returns guidance + dependencyDown marker`, async () => {
        const [tool] = resolveTools([toolName]);
        const args =
          toolName === 'events_add'
            ? { title: 'Dentist', startsAt: new Date(2026, 7, 4, 15, 0).toISOString() }
            : toolName === 'events_delete'
              ? { title: 'Dentist' }
              : {};
        const out = await tool.execute(args);
        expect(out.error).toMatch(/Settings/);
        expect(out.dependencyDown).toBe('neo4j');
      });
    }

    it('events_open_app maps config errors the same way', async () => {
      const [tool] = resolveTools(['events_open_app']);
      const out = await tool.execute({});
      expect(out.error).toMatch(/Settings/);
      expect(out.dependencyDown).toBe('neo4j');
    });
  });
});
