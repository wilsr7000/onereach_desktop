/**
 * LLM Client Mocks
 * Part of the Governed Self-Improving Agent Runtime Testing Infrastructure
 *
 * Mock implementations for Claude, OpenAI, and Aider
 */

import { vi } from 'vitest';

// Default mock responses
const DEFAULT_COMPLETION = 'This is a mock LLM response.';
const DEFAULT_CODE = '// Generated code\nfunction example() {\n  return true;\n}';

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
 * Create a mock Aider bridge
 */
export function createMockAiderBridge(options = {}) {
  const defaultCode = options.defaultCode || DEFAULT_CODE;

  return {
    sendPrompt: vi.fn().mockImplementation(async (_prompt) => ({
      success: true,
      response: defaultCode,
      filesChanged: ['src/example.js'],
      tokensUsed: { input: 200, output: 100 },
    })),

    addFile: vi.fn().mockResolvedValue({ success: true }),
    removeFile: vi.fn().mockResolvedValue({ success: true }),
    getStatus: vi.fn().mockResolvedValue({ running: true, model: 'claude-3-opus' }),

    isConnected: vi.fn().mockReturnValue(true),
    connect: vi.fn().mockResolvedValue(true),
    disconnect: vi.fn().mockResolvedValue(true),
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
export const mockAiderBridge = createMockAiderBridge();
export const mockLLMJudge = createMockLLMJudge();

export default {
  createMockClaudeClient,
  createMockOpenAIClient,
  createMockAiderBridge,
  createMockLLMJudge,
  mockClaudeClient,
  mockOpenAIClient,
  mockAiderBridge,
  mockLLMJudge,
};
