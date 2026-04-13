/**
 * Dependency Resolver Tests
 *
 * Tests detection of user-required resources, pending actions,
 * resolution tracking, and notification building.
 *
 * Run:  npx vitest run test/unit/agent-learning/dependency-resolver.test.js
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

const mockAI = { json: vi.fn() };
vi.mock('../../../lib/ai-service', () => mockAI);

const depResolver = require('../../../lib/agent-learning/dependency-resolver');

describe('DependencyResolver', () => {
  beforeEach(() => {
    mockAI.json.mockReset();
    depResolver.clearAll();
    depResolver._setTestDeps({ ai: mockAI });
  });

  describe('detectDependencies', () => {
    it('returns no dependencies for simple prompt improvement', async () => {
      mockAI.json.mockResolvedValue({
        hasDependencies: false,
        dependencies: [],
        canProceedPartially: true,
      });

      const result = await depResolver.detectDependencies(
        { name: 'Test Agent', description: 'answers questions' },
        { type: 'prompt', patch: { prompt: 'new prompt' }, description: 'improved prompt' },
        { specificIssue: 'vague answers' }
      );

      expect(result.hasDependencies).toBe(false);
      expect(result.dependencies).toHaveLength(0);
    });

    it('detects API key dependency', async () => {
      mockAI.json.mockResolvedValue({
        hasDependencies: true,
        dependencies: [{
          type: 'api-key',
          description: 'Weather API key needed',
          actionForUser: 'Add your OpenWeatherMap API key in Settings > Integrations',
          blocking: true,
          settingsKey: 'integrations.openweathermap.apiKey',
        }],
        canProceedPartially: false,
      });

      const result = await depResolver.detectDependencies(
        { name: 'Weather Agent', description: 'gets weather' },
        { type: 'reliability', patch: {}, description: 'add weather API fallback' },
        { specificIssue: 'no weather data source' }
      );

      expect(result.hasDependencies).toBe(true);
      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0].type).toBe('api-key');
      expect(result.dependencies[0].blocking).toBe(true);
    });

    it('handles LLM failure gracefully', async () => {
      mockAI.json.mockRejectedValue(new Error('LLM down'));

      const result = await depResolver.detectDependencies(
        { name: 'Agent' }, { type: 'prompt' }, {}
      );

      expect(result.hasDependencies).toBe(false);
      expect(result.canProceedPartially).toBe(true);
    });
  });

  describe('registerPendingAction', () => {
    it('creates a pending action with an ID', () => {
      const actionId = depResolver.registerPendingAction({
        agentId: 'weather-agent',
        agentName: 'Weather',
        improvement: { type: 'reliability' },
        dependencies: [
          { type: 'api-key', description: 'Weather API key', actionForUser: 'Add API key', blocking: true },
        ],
      });

      expect(actionId).toBeTruthy();
      expect(depResolver.getPendingActions()).toHaveLength(1);
    });
  });

  describe('resolveDependency', () => {
    it('returns the action when all blocking deps are resolved', () => {
      const actionId = depResolver.registerPendingAction({
        agentId: 'a',
        agentName: 'A',
        improvement: { type: 'prompt' },
        dependencies: [
          { type: 'api-key', blocking: true },
          { type: 'configuration', blocking: false },
        ],
      });

      const readyAction = depResolver.resolveDependency(actionId, 0);
      expect(readyAction).toBeTruthy();
      expect(readyAction.status).toBe('ready');
    });

    it('returns null when blocking deps remain', () => {
      const actionId = depResolver.registerPendingAction({
        agentId: 'a',
        agentName: 'A',
        improvement: { type: 'prompt' },
        dependencies: [
          { type: 'api-key', blocking: true },
          { type: 'credentials', blocking: true },
        ],
      });

      const result = depResolver.resolveDependency(actionId, 0);
      expect(result).toBeNull();
    });

    it('returns null for unknown actionId', () => {
      expect(depResolver.resolveDependency('nonexistent', 0)).toBeNull();
    });
  });

  describe('buildUserNotification', () => {
    it('builds single-dependency notification', () => {
      const msg = depResolver.buildUserNotification('Weather', [
        { type: 'api-key', actionForUser: 'Add your weather API key in Settings', blocking: true },
      ]);

      expect(msg).toContain('Weather');
      expect(msg).toContain('API key');
      expect(msg).toContain('Settings');
    });

    it('builds multi-dependency notification', () => {
      const msg = depResolver.buildUserNotification('Email', [
        { type: 'credentials', actionForUser: 'Add your email credentials', blocking: true },
        { type: 'permission', actionForUser: 'Enable email access in system preferences', blocking: true },
      ]);

      expect(msg).toContain('Email');
      expect(msg).toContain('few things');
    });

    it('builds non-blocking suggestion notification', () => {
      const msg = depResolver.buildUserNotification('Helper', [
        { type: 'configuration', actionForUser: 'Optionally configure your timezone', blocking: false },
      ]);

      expect(msg).toContain('even better');
    });
  });

  describe('getReadyActions', () => {
    it('returns actions where all blocking deps are resolved', () => {
      const actionId = depResolver.registerPendingAction({
        agentId: 'a', agentName: 'A',
        improvement: { type: 'prompt' },
        dependencies: [{ type: 'api-key', blocking: true }],
      });

      expect(depResolver.getReadyActions()).toHaveLength(0);
      depResolver.resolveDependency(actionId, 0);
      expect(depResolver.getReadyActions()).toHaveLength(1);
    });
  });

  describe('clearAll', () => {
    it('removes all pending actions', () => {
      depResolver.registerPendingAction({
        agentId: 'a', agentName: 'A',
        improvement: {}, dependencies: [],
      });
      depResolver.clearAll();
      expect(depResolver.getPendingActions()).toHaveLength(0);
    });
  });
});
