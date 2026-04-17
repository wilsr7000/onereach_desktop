/**
 * Unit tests for agent-builder-agent's Claude Code build offer.
 *
 * Verifies:
 *  1. _chooseBuildMethod routes easy/medium -> claude-code, hard -> playbook, not_feasible -> none
 *  2. _buildConversationalResponse produces the right call-to-action per method
 *  3. _handleConfirmation routes to Claude Code vs Playbooks based on buildMethod
 *  4. Claude Code failure falls back to Playbooks with a re-ask prompt
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock external deps BEFORE importing the agent
vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../lib/ai-service', () => ({
  json: vi.fn(),
  complete: vi.fn(),
  chat: vi.fn(),
}));

import agentBuilder from '../../packages/agents/agent-builder-agent';
import * as aiService from '../../lib/ai-service';

// Inject a mock Claude Code builder via the module's test hook
const mockBuildAgent = vi.fn();
agentBuilder._setClaudeCodeBuilder(mockBuildAgent);

// Inject a mock exchange bus so we can verify progress emissions and auto-retry
const busEvents = [];
const submitCalls = [];
const mockExchangeBus = {
  emit: vi.fn((event, payload) => {
    busEvents.push({ event, payload });
  }),
  processSubmit: vi.fn((text, options) => {
    submitCalls.push({ text, options });
    return Promise.resolve({ taskId: 'retry-task-1', queued: true });
  }),
};
agentBuilder._setExchangeBus(mockExchangeBus);

describe('agent-builder-agent: Claude Code integration', () => {
  beforeEach(() => {
    mockBuildAgent.mockReset();
    aiService.json.mockReset();
    busEvents.length = 0;
    submitCalls.length = 0;
    mockExchangeBus.emit.mockClear();
    mockExchangeBus.processSubmit.mockClear();
  });

  describe('_chooseBuildMethod', () => {
    it("returns 'claude-code' for easy effort", () => {
      expect(agentBuilder._chooseBuildMethod({ effort: 'easy' })).toBe('claude-code');
    });

    it("returns 'claude-code' for medium effort", () => {
      expect(agentBuilder._chooseBuildMethod({ effort: 'medium' })).toBe('claude-code');
    });

    it("returns 'playbook' for hard effort", () => {
      expect(agentBuilder._chooseBuildMethod({ effort: 'hard' })).toBe('playbook');
    });

    it("returns 'none' for not_feasible effort", () => {
      expect(agentBuilder._chooseBuildMethod({ effort: 'not_feasible' })).toBe('none');
    });

    it("returns 'playbook' for unknown effort (safe default)", () => {
      expect(agentBuilder._chooseBuildMethod({ effort: 'galactic' })).toBe('playbook');
    });
  });

  describe('_buildConversationalResponse', () => {
    it('offers Claude Code now for easy requests (with playbook escape hatch)', () => {
      const response = agentBuilder._buildConversationalResponse(
        { effort: 'easy', estimatedCostPerUse: '~$0.01', requiredIntegrations: ['web_search'] },
        'tell me a random joke'
      );
      expect(response).toMatch(/build it right now/i);
      expect(response).toMatch(/30 seconds/);
      // For easy requests we PROMOTE Claude Code as the primary offer but
      // still mention "playbook" as a voice-discoverable opt-out so users
      // know they can say that word to switch paths.
      expect(response).toMatch(/playbook/i);
      expect(response).toMatch(/plan it first/i);
    });

    it('offers Claude Code now for medium requests (mentions similar agent)', () => {
      const response = agentBuilder._buildConversationalResponse(
        {
          effort: 'medium',
          estimatedCostPerUse: '~$0.02',
          requiredIntegrations: [],
          missingAccess: [],
          similarAgent: 'weather agent',
        },
        'tell me the forecast for tomorrow'
      );
      expect(response).toMatch(/right now/i);
      expect(response).toMatch(/weather agent/);
    });

    it('offers Playbooks for hard requests (not Claude Code)', () => {
      const response = agentBuilder._buildConversationalResponse(
        { effort: 'hard', estimatedCostPerUse: '~$0.05', requiredIntegrations: ['browser'], missingAccess: ['credentials'] },
        'automate my end-of-month reporting workflow'
      );
      expect(response).toMatch(/playbook/i);
      expect(response).not.toMatch(/right now/i);
    });

    it('explains not_feasible without offering to build', () => {
      const response = agentBuilder._buildConversationalResponse(
        {
          effort: 'not_feasible',
          reasoning: 'Requires real-time video processing we cannot do locally.',
          alternativeSuggestion: 'use a cloud service',
        },
        'do live video deepfake detection'
      );
      expect(response).toMatch(/really tough/i);
      expect(response).toMatch(/cloud service/i);
      // Must not include the Claude Code or Playbooks CTAs
      expect(response).not.toMatch(/build it right now/i);
      expect(response).not.toMatch(/playbook/i);
    });

    it('preserves the LLM spoken response but appends Claude Code CTA when absent', () => {
      const response = agentBuilder._buildConversationalResponse(
        {
          effort: 'easy',
          spokenResponse: 'That sounds like a fun one to set up.',
          estimatedCostPerUse: '~$0.01',
          requiredIntegrations: [],
        },
        'tell me a joke'
      );
      expect(response).toContain('That sounds like a fun one to set up.');
      expect(response).toMatch(/build it right now/i);
    });

    it('does not double-append the CTA if LLM already asks to build', () => {
      const response = agentBuilder._buildConversationalResponse(
        {
          effort: 'easy',
          spokenResponse: 'That sounds easy. Want me to build it now and try it out?',
          estimatedCostPerUse: '~$0.01',
          requiredIntegrations: [],
        },
        'tell me a joke'
      );
      // Should be the LLM response untouched -- no second "Want me to..."
      const wantMeMatches = response.match(/want me to/gi) || [];
      expect(wantMeMatches.length).toBeLessThanOrEqual(1);
    });
  });

  describe('_handleConfirmation routing', () => {
    it("routes 'claude-code' buildMethod to Claude Code builder", async () => {
      mockBuildAgent.mockResolvedValue({
        success: true,
        agent: { id: 'agent-x', name: 'Joke Bot' },
        plan: { suggestedName: 'Joke Bot' },
        elapsedMs: 15234,
      });

      const result = await agentBuilder._handleConfirmation({
        originalRequest: 'tell me a joke',
        assessment: { effort: 'easy', estimatedCostPerUse: '~$0.01', requiredIntegrations: [] },
        buildMethod: 'claude-code',
      });

      expect(mockBuildAgent).toHaveBeenCalledTimes(1);
      expect(mockBuildAgent.mock.calls[0][0]).toBe('tell me a joke');
      expect(result.success).toBe(true);
      expect(result.message).toMatch(/Joke Bot/);
      expect(result.message).toMatch(/15 seconds/);
      // Auto-retry schedules the original request; success message reflects that
      expect(result.message).toMatch(/Running your original request/i);
    });

    it('produces a reasonable message for sub-second builds', async () => {
      mockBuildAgent.mockResolvedValue({
        success: true,
        agent: { id: 'a', name: 'Test Bot' },
        plan: null,
        elapsedMs: 400,
      });
      const result = await agentBuilder._handleConfirmation({
        originalRequest: 'do x',
        assessment: { effort: 'easy', estimatedCostPerUse: '~$0.01', requiredIntegrations: [] },
        buildMethod: 'claude-code',
      });
      expect(result.message).toMatch(/Test Bot/);
      expect(result.message).toMatch(/Running your original request/i);
    });

    it('falls back to Playbooks (via needsInput) if Claude Code build fails', async () => {
      mockBuildAgent.mockResolvedValue({
        success: false,
        stage: 'generate',
        error: 'Anthropic API error',
      });

      const result = await agentBuilder._handleConfirmation({
        originalRequest: 'tell me a joke',
        assessment: { effort: 'easy', estimatedCostPerUse: '~$0.01', requiredIntegrations: [] },
        buildMethod: 'claude-code',
      });

      expect(result.success).toBe(true);
      expect(result.message).toMatch(/snag/i);
      expect(result.message).toMatch(/Anthropic API error/);
      expect(result.needsInput).toBeTruthy();
      expect(result.needsInput.context.pendingBuild.buildMethod).toBe('playbook');
    });

    it('falls back to Playbooks path if buildAgentWithClaudeCode throws', async () => {
      mockBuildAgent.mockRejectedValue(new Error('catastrophic'));

      const result = await agentBuilder._handleConfirmation({
        originalRequest: 'tell me a joke',
        assessment: { effort: 'easy', estimatedCostPerUse: '~$0.01', requiredIntegrations: [] },
        buildMethod: 'claude-code',
      });

      // Thrown errors in _buildWithClaudeCode route to _buildWithPlaybooks,
      // which in this test env has no Playbooks tool -> generic fallback msg.
      expect(result.success).toBe(true);
      expect(mockBuildAgent).toHaveBeenCalledTimes(1);
    });

    it("routes 'playbook' buildMethod to Playbooks path (no Claude Code call)", async () => {
      const result = await agentBuilder._handleConfirmation({
        originalRequest: 'do something big',
        assessment: { effort: 'hard', estimatedCostPerUse: '~$0.05', requiredIntegrations: [], missingAccess: [] },
        buildMethod: 'playbook',
      });

      expect(mockBuildAgent).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
    });
  });

  describe('progress events + auto-retry', () => {
    it('forwards build-progress events from the builder to the exchange bus', async () => {
      mockBuildAgent.mockImplementation(async (_req, opts) => {
        if (opts && typeof opts.onProgress === 'function') {
          opts.onProgress({ stage: 'start', message: 'Starting' });
          opts.onProgress({ stage: 'plan', message: 'Planning' });
          opts.onProgress({ stage: 'done', message: 'Done' });
        }
        return {
          success: true,
          agent: { id: 'a', name: 'Test Bot' },
          plan: null,
          elapsedMs: 5000,
        };
      });

      await agentBuilder._handleConfirmation({
        originalRequest: 'summarize PDFs',
        assessment: { effort: 'easy', estimatedCostPerUse: '~$0.01', requiredIntegrations: [] },
        buildMethod: 'claude-code',
      });

      const progressStages = busEvents
        .filter((e) => e.event === 'agent-builder:progress')
        .map((e) => e.payload.stage);
      expect(progressStages).toContain('start');
      expect(progressStages).toContain('plan');
      expect(progressStages).toContain('done');

      // Each progress event carries the originalRequest for UI context
      const firstProgress = busEvents.find((e) => e.event === 'agent-builder:progress');
      expect(firstProgress.payload.originalRequest).toBe('summarize PDFs');
    });

    it('auto-retries the original request via processSubmit after a successful build', async () => {
      mockBuildAgent.mockResolvedValue({
        success: true,
        agent: { id: 'agent-abc', name: 'PDF Agent' },
        plan: null,
        elapsedMs: 12000,
      });

      const result = await agentBuilder._handleConfirmation({
        originalRequest: 'summarize this PDF',
        assessment: { effort: 'easy', estimatedCostPerUse: '~$0.01', requiredIntegrations: [] },
        buildMethod: 'claude-code',
      });

      expect(result.success).toBe(true);
      expect(result.message).toMatch(/Running your original request now/);
      expect(mockExchangeBus.processSubmit).toHaveBeenCalledTimes(1);
      const [retryText, retryOpts] = mockExchangeBus.processSubmit.mock.calls[0];
      expect(retryText).toBe('summarize this PDF');
      expect(retryOpts.metadata.retriedAfterBuild).toBe(true);
      expect(retryOpts.metadata.builtAgentId).toBe('agent-abc');
    });

    it('handles missing processSubmit gracefully (tells user to try again)', async () => {
      // Bus exists but has no processSubmit (e.g. exchange-bridge not yet
      // registered). The builder should still succeed but tell the user to
      // re-issue the request themselves.
      const busWithoutSubmit = {
        emit: vi.fn(),
        // no processSubmit
      };
      agentBuilder._setExchangeBus(busWithoutSubmit);

      mockBuildAgent.mockResolvedValue({
        success: true,
        agent: { id: 'a', name: 'Test Bot' },
        plan: null,
        elapsedMs: 8000,
      });

      const result = await agentBuilder._handleConfirmation({
        originalRequest: 'do thing',
        assessment: { effort: 'easy', estimatedCostPerUse: '~$0.01', requiredIntegrations: [] },
        buildMethod: 'claude-code',
      });
      expect(result.success).toBe(true);
      expect(result.message).toMatch(/try your original request again/i);

      // Restore the fully-featured mock bus for later tests
      agentBuilder._setExchangeBus(mockExchangeBus);
    });

    it('surfaces a budget-blocked result as a Playbooks re-ask', async () => {
      mockBuildAgent.mockResolvedValue({
        success: false,
        budgetBlocked: true,
        error: 'Daily budget cap would be exceeded',
      });

      const result = await agentBuilder._handleConfirmation({
        originalRequest: 'do thing',
        assessment: { effort: 'easy', estimatedCostPerUse: '~$0.01', requiredIntegrations: [] },
        buildMethod: 'claude-code',
      });

      expect(result.success).toBe(true);
      expect(result.message).toMatch(/budget cap/i);
      expect(result.needsInput).toBeTruthy();
      expect(result.needsInput.context.pendingBuild.buildMethod).toBe('playbook');
      // Auto-retry should NOT happen on budget-blocked
      expect(mockExchangeBus.processSubmit).not.toHaveBeenCalled();
    });
  });

  describe('execute() response routing', () => {
    it('routes "yes" follow-up to the pending build method', async () => {
      mockBuildAgent.mockResolvedValue({
        success: true,
        agent: { id: 'a', name: 'Joke Bot' },
        plan: null,
        elapsedMs: 2000,
      });

      const result = await agentBuilder.execute({
        content: 'yes please',
        context: {
          pendingBuild: {
            originalRequest: 'tell me a joke',
            assessment: { effort: 'easy', estimatedCostPerUse: '~$0.01', requiredIntegrations: [] },
            buildMethod: 'claude-code',
          },
        },
      });

      expect(mockBuildAgent).toHaveBeenCalledTimes(1);
      expect(result.message).toMatch(/Joke Bot/);
    });

    it('routes "playbook" follow-up to the Playbooks path regardless of current buildMethod', async () => {
      const result = await agentBuilder.execute({
        content: 'use playbook instead',
        context: {
          pendingBuild: {
            originalRequest: 'do thing',
            assessment: { effort: 'easy', estimatedCostPerUse: '~$0.01', requiredIntegrations: [] },
            buildMethod: 'claude-code',
          },
        },
      });

      expect(mockBuildAgent).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('routes "no" follow-up to a polite decline (no build, no playbook)', async () => {
      const result = await agentBuilder.execute({
        content: 'no thanks',
        context: {
          pendingBuild: {
            originalRequest: 'do thing',
            assessment: { effort: 'easy', estimatedCostPerUse: '~$0.01', requiredIntegrations: [] },
            buildMethod: 'claude-code',
          },
        },
      });

      expect(mockBuildAgent).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.message).toMatch(/no worries/i);
    });
  });

  describe('execute() attaches buildMethod to needsInput context', () => {
    it('carries buildMethod derived from the assessment', async () => {
      aiService.json.mockResolvedValue({
        effort: 'easy',
        reasoning: 'simple task',
        requiredIntegrations: [],
        missingAccess: [],
        estimatedCostPerUse: '~$0.01',
        similarAgent: null,
        alternativeSuggestion: null,
        spokenResponse: 'Easy to build. Want me to do it now?',
      });

      const result = await agentBuilder.execute({ content: 'tell me a joke' });

      expect(result.success).toBe(true);
      expect(result.needsInput).toBeTruthy();
      expect(result.needsInput.context.pendingBuild.buildMethod).toBe('claude-code');
      expect(result.needsInput.context.pendingBuild.originalRequest).toBe('tell me a joke');
    });

    it('handles feasibility LLM failure gracefully (falls back to medium + claude-code)', async () => {
      // When ai.json throws, _assessFeasibility returns a default
      // { effort: 'medium', ... } -- which should still offer claude-code.
      aiService.json.mockRejectedValue(new Error('LLM down'));

      const result = await agentBuilder.execute({ content: 'do something' });
      expect(result.success).toBe(true);
      expect(result.needsInput.context.pendingBuild.buildMethod).toBe('claude-code');
    });
  });
});
