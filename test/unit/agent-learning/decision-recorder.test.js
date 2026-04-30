/**
 * Decision Recorder tests (Phase 1 self-learning arbitration)
 *
 * Run: npx vitest run test/unit/agent-learning/decision-recorder.test.js
 *
 * The recorder owns the arbitration-decisions Space + the in-memory
 * taskId -> itemId join map. Tests use a fake spaces-storage with the
 * same surface (createSpace, addItem, updateItemIndex, deleteItem,
 * index.{spaces,items}) to verify the join + retention behavior
 * without touching disk or the real Spaces API.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

const recorder = require('../../../lib/agent-learning/decision-recorder');

// ============================================================
// Test harness: fake spaces storage
// ============================================================

function makeFakeStorage() {
  let nextId = 1;
  const storage = {
    index: { spaces: [], items: [] },
    createSpace: vi.fn((space) => {
      storage.index.spaces.push(space);
      return space;
    }),
    addItem: vi.fn((item) => {
      const id = `item-${nextId++}`;
      const stored = { ...item, id };
      storage.index.items.push(stored);
      return stored;
    }),
    updateItemIndex: vi.fn((itemId, updates) => {
      const item = storage.index.items.find((i) => i.id === itemId);
      if (!item) return false;
      if (updates.content !== undefined) item.content = updates.content;
      if (updates.metadata !== undefined) {
        item.metadata = { ...(item.metadata || {}), ...updates.metadata };
      }
      return true;
    }),
    deleteItem: vi.fn((itemId) => {
      const idx = storage.index.items.findIndex((i) => i.id === itemId);
      if (idx === -1) return false;
      storage.index.items.splice(idx, 1);
      return true;
    }),
  };
  return storage;
}

function makeFakeApi(storage) {
  return { storage };
}

function makeFakeSettings(overrides = {}) {
  const values = {
    'arbitrationDecisions.enabled': true,
    'arbitrationDecisions.retentionDays': 90,
    'arbitrationDecisions.redactedRecording': false,
    ...overrides,
  };
  return {
    get: vi.fn((key) => values[key]),
    set: vi.fn((key, value) => { values[key] = value; }),
  };
}

function makeInteraction(overrides = {}) {
  return {
    taskId: 'task-1',
    agentId: 'time-agent',
    userInput: 'what time is it',
    success: true,
    message: 'It is 3:14 PM',
    durationMs: 800,
    bustCount: 0,
    bustedAgents: [],
    bids: [
      { agentId: 'time-agent', agentName: 'Time Agent', confidence: 0.85, score: 0.85, reasoning: 'I report current time', won: true, busted: false },
      { agentId: 'calendar-agent', agentName: 'Calendar Agent', confidence: 0.7, score: 0.7, reasoning: 'I handle calendar queries which include time', won: false, busted: false },
    ],
    executionMode: 'single',
    decisionPath: 'fast-path-dominant',
    timestamp: 1700000000,
    ...overrides,
  };
}

// ============================================================
// Tests
// ============================================================

describe('decision-recorder', () => {
  let storage;
  let settings;

  beforeEach(() => {
    recorder._resetForTests();
    storage = makeFakeStorage();
    settings = makeFakeSettings();
    recorder._setTestDeps({
      spacesAPI: makeFakeApi(storage),
      settingsManager: settings,
    });
  });

  describe('ensureArbitrationSpace', () => {
    it('creates the space if it does not exist', async () => {
      const ok = await recorder.ensureArbitrationSpace();
      expect(ok).toBe(true);
      expect(storage.createSpace).toHaveBeenCalledTimes(1);
      expect(storage.index.spaces[0].id).toBe(recorder.ARBITRATION_SPACE_ID);
    });

    it('is idempotent', async () => {
      await recorder.ensureArbitrationSpace();
      await recorder.ensureArbitrationSpace();
      expect(storage.createSpace).toHaveBeenCalledTimes(1);
    });

    it('returns false when no spaces API is available', async () => {
      recorder._setTestDeps({ spacesAPI: null });
      const ok = await recorder.ensureArbitrationSpace();
      expect(ok).toBe(false);
    });
  });

  describe('_onInteraction creates the item', () => {
    it('creates one item per settled task with the canonical shape', async () => {
      await recorder._onInteraction(makeInteraction());
      expect(storage.addItem).toHaveBeenCalledTimes(1);
      const item = storage.index.items[0];
      const decision = JSON.parse(item.content);
      expect(decision.taskId).toBe('task-1');
      expect(decision.chosenWinner).toBe('time-agent');
      expect(decision.bids).toHaveLength(2);
      expect(decision.bids[0].won).toBe(true);
      expect(decision.bids[1].won).toBe(false);
      expect(decision.outcome.reflectorScore).toBeNull();
      expect(decision.outcome.userFeedback).toBeNull();
      expect(decision.outcome.counterfactualJudgment).toBeNull();
    });

    it('tags the item with the decision-path so queries are cheap', async () => {
      await recorder._onInteraction(makeInteraction());
      const item = storage.index.items[0];
      expect(item.tags).toContain(recorder.TAG);
      expect(item.tags).toContain('fast-path-dominant');
    });

    it('skips when arbitrationDecisions.enabled = false', async () => {
      settings = makeFakeSettings({ 'arbitrationDecisions.enabled': false });
      recorder._setTestDeps({ settingsManager: settings });
      await recorder._onInteraction(makeInteraction());
      expect(storage.addItem).not.toHaveBeenCalled();
    });

    it('redacts content + bid reasoning when redactedRecording = true', async () => {
      settings = makeFakeSettings({ 'arbitrationDecisions.redactedRecording': true });
      recorder._setTestDeps({ settingsManager: settings });
      await recorder._onInteraction(makeInteraction({
        userInput: 'email alice@example.com about it',
        bids: [
          { agentId: 'a', confidence: 0.9, score: 0.9, reasoning: 'I will send to alice@example.com', won: true },
        ],
      }));
      const item = storage.index.items[0];
      const decision = JSON.parse(item.content);
      expect(decision.content).toContain('<EMAIL>');
      expect(decision.content).not.toContain('alice@example.com');
      expect(decision.bids[0].reasoning).toContain('<EMAIL>');
    });

    it('preserves structural fields (confidences, agent IDs) under redaction', async () => {
      settings = makeFakeSettings({ 'arbitrationDecisions.redactedRecording': true });
      recorder._setTestDeps({ settingsManager: settings });
      await recorder._onInteraction(makeInteraction());
      const decision = JSON.parse(storage.index.items[0].content);
      expect(decision.bids[0].confidence).toBe(0.85);
      expect(decision.bids[0].agentId).toBe('time-agent');
      expect(decision.chosenWinner).toBe('time-agent');
    });
  });

  describe('signal joins (in-order)', () => {
    it('reflection updates outcome.reflectorScore + reflectorIssues', async () => {
      await recorder._onInteraction(makeInteraction());
      recorder._onReflection({ taskId: 'task-1', overall: 0.42, issues: ['ungrounded', 'vague'] });

      const decision = JSON.parse(storage.index.items[0].content);
      expect(decision.outcome.reflectorScore).toBe(0.42);
      expect(decision.outcome.reflectorIssues).toEqual(['ungrounded', 'vague']);
    });

    it('negative-feedback sets outcome.userFeedback = "wrong"', async () => {
      await recorder._onInteraction(makeInteraction());
      recorder._onNegativeFeedback({ taskId: 'task-1', source: 'voice-shortcut' });

      const decision = JSON.parse(storage.index.items[0].content);
      expect(decision.outcome.userFeedback).toBe('wrong');
      expect(decision.outcome.userFeedbackSource).toBe('voice-shortcut');
    });

    it('counterfactual-judgment sets outcome.counterfactualJudgment + confidence', async () => {
      await recorder._onInteraction(makeInteraction());
      recorder._onCounterfactual({ taskId: 'task-1', judgment: 'runner-up-better', confidence: 0.7 });

      const decision = JSON.parse(storage.index.items[0].content);
      expect(decision.outcome.counterfactualJudgment).toBe('runner-up-better');
      expect(decision.outcome.counterfactualConfidence).toBe(0.7);
    });

    it('all three signals join onto the same item', async () => {
      await recorder._onInteraction(makeInteraction());
      recorder._onReflection({ taskId: 'task-1', overall: 0.6, issues: [] });
      recorder._onNegativeFeedback({ taskId: 'task-1', source: 'voice-shortcut' });
      recorder._onCounterfactual({ taskId: 'task-1', judgment: 'same', confidence: 0.5 });

      expect(storage.addItem).toHaveBeenCalledTimes(1);
      const decision = JSON.parse(storage.index.items[0].content);
      expect(decision.outcome.reflectorScore).toBe(0.6);
      expect(decision.outcome.userFeedback).toBe('wrong');
      expect(decision.outcome.counterfactualJudgment).toBe('same');
    });
  });

  describe('signal joins (out-of-order)', () => {
    it('buffers signals that arrive before the item is created', async () => {
      // Reflection fires before interaction (reflector is faster than the
      // task settle handler in some races)
      recorder._onReflection({ taskId: 'task-1', overall: 0.42, issues: [] });
      // No item exists yet.
      expect(storage.index.items).toHaveLength(0);

      // Now the interaction lands.
      await recorder._onInteraction(makeInteraction());
      const decision = JSON.parse(storage.index.items[0].content);
      // The buffered reflection should be applied.
      expect(decision.outcome.reflectorScore).toBe(0.42);
    });

    it('drops late signals for items that no longer exist', async () => {
      // Late reflection for a task that was never recorded:
      recorder._onReflection({ taskId: 'never-recorded', overall: 0.5, issues: [] });
      // Doesn't crash; doesn't create anything.
      expect(storage.index.items).toHaveLength(0);
    });
  });

  describe('startDecisionRecorder wiring', () => {
    it('subscribes to all four learning events', async () => {
      const bus = new EventEmitter();
      recorder.startDecisionRecorder(bus);

      bus.emit('learning:interaction', makeInteraction());
      // Emission is sync; _onInteraction is async but creates the item
      // synchronously up to the storage.addItem call inside the await
      // chain. Yield once so the async path runs.
      await new Promise((r) => setImmediate(r));
      expect(storage.addItem).toHaveBeenCalledTimes(1);

      bus.emit('learning:reflection', { taskId: 'task-1', overall: 0.7, issues: [] });
      const decision1 = JSON.parse(storage.index.items[0].content);
      expect(decision1.outcome.reflectorScore).toBe(0.7);

      bus.emit('learning:negative-feedback', { taskId: 'task-1' });
      const decision2 = JSON.parse(storage.index.items[0].content);
      expect(decision2.outcome.userFeedback).toBe('wrong');

      bus.emit('learning:counterfactual-judgment', { taskId: 'task-1', judgment: 'winner-better', confidence: 0.9 });
      const decision3 = JSON.parse(storage.index.items[0].content);
      expect(decision3.outcome.counterfactualJudgment).toBe('winner-better');
    });

    it('stopDecisionRecorder removes all subscriptions', async () => {
      const bus = new EventEmitter();
      recorder.startDecisionRecorder(bus);
      recorder.stopDecisionRecorder();

      bus.emit('learning:interaction', makeInteraction());
      await new Promise((r) => setImmediate(r));
      expect(storage.addItem).not.toHaveBeenCalled();
    });

    it('start is idempotent', async () => {
      const bus = new EventEmitter();
      recorder.startDecisionRecorder(bus);
      recorder.startDecisionRecorder(bus);

      bus.emit('learning:interaction', makeInteraction());
      await new Promise((r) => setImmediate(r));
      // Single record despite two starts.
      expect(storage.addItem).toHaveBeenCalledTimes(1);
    });
  });

  describe('pruneStaleDecisions', () => {
    it('removes items older than retentionDays', async () => {
      const now = Date.now();
      const oneDay = 24 * 60 * 60 * 1000;

      // Two old items, one fresh
      storage.index.spaces.push({ id: recorder.ARBITRATION_SPACE_ID });
      storage.index.items.push({
        id: 'old-1',
        spaceId: recorder.ARBITRATION_SPACE_ID,
        timestamp: now - 100 * oneDay,
        content: '{}',
      });
      storage.index.items.push({
        id: 'old-2',
        spaceId: recorder.ARBITRATION_SPACE_ID,
        timestamp: now - 95 * oneDay,
        content: '{}',
      });
      storage.index.items.push({
        id: 'fresh',
        spaceId: recorder.ARBITRATION_SPACE_ID,
        timestamp: now - 5 * oneDay,
        content: '{}',
      });

      const result = await recorder.pruneStaleDecisions({ retentionDays: 90 });
      expect(result.checked).toBe(3);
      expect(result.pruned).toBe(2);
      expect(storage.index.items).toHaveLength(1);
      expect(storage.index.items[0].id).toBe('fresh');
    });

    it('skips items in other spaces', async () => {
      storage.index.spaces.push({ id: recorder.ARBITRATION_SPACE_ID });
      storage.index.items.push({
        id: 'in-other-space',
        spaceId: 'some-other-space',
        timestamp: 0, // ancient
        content: '{}',
      });

      const result = await recorder.pruneStaleDecisions({ retentionDays: 90 });
      expect(result.checked).toBe(0);
      expect(result.pruned).toBe(0);
      expect(storage.index.items).toHaveLength(1);
    });

    it('uses the default retentionDays when not provided', async () => {
      // Set up storage with a single fresh item (default 90 days
      // shouldn't prune it).
      storage.index.items.push({
        id: 'fresh',
        spaceId: recorder.ARBITRATION_SPACE_ID,
        timestamp: Date.now() - 10 * 24 * 60 * 60 * 1000,
        content: '{}',
      });
      const result = await recorder.pruneStaleDecisions();
      expect(result.pruned).toBe(0);
    });
  });
});
