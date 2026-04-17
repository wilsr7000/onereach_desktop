/**
 * LLM Client Mocks
 * Part of the Governed Self-Improving Agent Runtime Testing Infrastructure
 *
 * Mock implementations for Claude, OpenAI, and the GSX Create engine.
 */

import { vi } from 'vitest';

// Default mock responses
const DEFAULT_COMPLETION = 'This is a mock LLM response.';

/**
 * Create a mock Claude/Anthropic client
 */
export function createMockClaudeClient(options = {}) {
  const defaultResponse = options.defaultResponse || DEFAULT_COMPLETION;

  return {
    messages: {
      create: vi.fn().mockImplementation(async ({ _messages }) => ({
        id: 'mock-message-id',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: defaultResponse }],
        model: 'claude-3-opus-20240229',
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
        },
      })),
    },
  };
}

/**
 * Create a mock OpenAI client
 */
export function createMockOpenAIClient(options = {}) {
  const defaultResponse = options.defaultResponse || DEFAULT_COMPLETION;

  return {
    chat: {
      completions: {
        create: vi.fn().mockImplementation(async ({ _messages }) => ({
          id: 'mock-completion-id',
          object: 'chat.completion',
          created: Date.now(),
          model: 'gpt-4',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: defaultResponse,
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
          },
        })),
      },
    },
  };
}

/**
 * Create a mock GSX Create engine (drop-in replacement for the old Aider bridge mock).
 * Exposes the same methods as lib/gsx-create-engine.js.
 */
export function createMockGSXCreateEngine(options = {}) {
  const defaultResponse = options.defaultResponse || 'mocked assistant reply';

  return {
    start: vi.fn().mockResolvedValue({ success: true, version: '2.1.112', type: 'bundled' }),
    initialize: vi.fn().mockResolvedValue({ success: true, repo_path: '/mock/path' }),
    runPrompt: vi.fn().mockImplementation(async (_message) => ({
      success: true,
      response: defaultResponse,
      output: defaultResponse,
      usage: { input_tokens: 100, output_tokens: 50 },
      sessionId: 'mock-session',
    })),
    runPromptStreaming: vi.fn().mockImplementation(async (_message, onToken) => {
      if (typeof onToken === 'function') {
        onToken(defaultResponse);
      }
      return {
        success: true,
        response: defaultResponse,
        output: defaultResponse,
        usage: { input_tokens: 100, output_tokens: 50 },
        sessionId: 'mock-session',
      };
    }),
    addFiles: vi.fn().mockResolvedValue({ success: true, files: [] }),
    removeFiles: vi.fn().mockResolvedValue({ success: true, files: [] }),
    getRepoMap: vi.fn().mockResolvedValue({ success: true, files: [], count: 0 }),
    setTestCmd: vi.fn().mockResolvedValue({ success: true }),
    setLintCmd: vi.fn().mockResolvedValue({ success: true }),
    shutdown: vi.fn().mockResolvedValue({ success: true }),
    isRunning: vi.fn().mockReturnValue(true),
    sendRequest: vi.fn().mockResolvedValue({ success: true }),
  };
}

/**
 * Mock LLM judge for evaluations
 */
export function createMockLLMJudge() {
  return {
    evaluate: vi.fn().mockImplementation(async (_content, _criteria) => ({
      score: 0.85,
      reasoning: 'The content meets most criteria effectively.',
      passed: true,
      details: {
        strengths: ['Clear structure', 'Good examples'],
        weaknesses: ['Could use more detail'],
        suggestions: ['Add more context'],
      },
    })),
  };
}

// Pre-configured mock instances
export const mockClaudeClient = createMockClaudeClient();
export const mockOpenAIClient = createMockOpenAIClient();
export const mockGSXCreateEngine = createMockGSXCreateEngine();
export const mockLLMJudge = createMockLLMJudge();

export default {
  createMockClaudeClient,
  createMockOpenAIClient,
  createMockGSXCreateEngine,
  createMockLLMJudge,
  mockClaudeClient,
  mockOpenAIClient,
  mockGSXCreateEngine,
  mockLLMJudge,
};
