import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock highlight.js before importing agent
vi.mock('highlight.js', () => ({
  default: {
    highlightAuto: vi.fn().mockReturnValue({
      value: '<span class="hljs-keyword">function</span> <span class="hljs-title">hello</span>() { <span class="hljs-keyword">return</span> <span class="hljs-string">&quot;world&quot;</span>; }',
      language: 'javascript',
      relevance: 10,
    }),
    highlight: vi.fn().mockReturnValue({
      value: '<span class="hljs-keyword">function</span> <span class="hljs-title">hello</span>() { <span class="hljs-keyword">return</span> <span class="hljs-string">&quot;world&quot;</span>; }',
    }),
    getLanguage: vi.fn().mockReturnValue(true),
    listLanguages: vi.fn().mockReturnValue(['javascript', 'python', 'typescript']),
  },
}));

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();

// Import the agent class (CJS)
const { CodeToHtmlAgent } = require('../../../lib/converters/code-to-html.js');

// Run the standard lifecycle test harness
testConverterAgent(CodeToHtmlAgent, {
  sampleInput: 'function hello() { return "world"; }',
  expectedFromFormats: ['code', 'js'],
  expectedToFormats: ['html'],
  expectedStrategies: ['highlight', 'themed', 'annotated'],
  mockAI,
});

// Agent-specific tests
describe('CodeToHtmlAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new CodeToHtmlAgent({ ai: mockAI, silent: true });
  });

  it('highlight strategy produces HTML with hljs classes', async () => {
    const result = await agent.execute('function hello() { return "world"; }', 'highlight');
    expect(typeof result.output).toBe('string');
    expect(result.output).toContain('hljs');
    expect(result.metadata.strategy).toBe('highlight');
    expect(result.metadata.language).toBeDefined();
  });

  it('annotated strategy calls AI for code annotations', async () => {
    await agent.execute('function hello() { return "world"; }', 'annotated');
    expect(mockAI.complete).toHaveBeenCalled();
  });

  it('themed strategy wraps output in a styled HTML document', async () => {
    const result = await agent.execute('const x = 1;', 'themed');
    expect(typeof result.output).toBe('string');
    expect(result.output.length).toBeGreaterThan(0);
  });
});
