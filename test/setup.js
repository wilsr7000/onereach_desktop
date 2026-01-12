/**
 * Test Setup File
 * Part of the Governed Self-Improving Agent Runtime Testing Infrastructure
 * 
 * Global test configuration and mock registration
 */

import { beforeEach, afterEach, vi } from 'vitest';

// Reset all mocks between tests
beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Global test utilities
global.testUtils = {
  // Helper to wait for async operations
  wait: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  
  // Helper to create a mock LLM response
  mockLLMResponse: (content) => ({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
  }),
  
  // Helper to create a mock evaluation
  mockEvaluation: (overrides = {}) => ({
    agentId: 'test-agent',
    agentType: 'expert',
    overallScore: 75,
    criteria: [],
    strengths: [],
    concerns: [],
    suggestions: [],
    ...overrides
  })
};

// Suppress console output during tests unless DEBUG is set
if (!process.env.DEBUG) {
  global.console = {
    ...console,
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    // Keep error for debugging
    error: console.error
  };
}

