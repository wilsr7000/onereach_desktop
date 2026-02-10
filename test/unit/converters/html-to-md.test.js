import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock turndown before importing agent
vi.mock('turndown', () => {
  const TurndownService = vi.fn().mockImplementation(() => ({
    turndown: vi.fn().mockReturnValue('# Hello\n\nWorld'),
    addRule: vi.fn(),
  }));
  return { default: TurndownService };
});

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();

// Import the agent class (CJS)
const { HtmlToMdAgent } = require('../../../lib/converters/html-to-md.js');

// Run the standard lifecycle test harness
testConverterAgent(HtmlToMdAgent, {
  sampleInput: '<h1>Hello</h1><p>This is a <strong>test</strong> paragraph.</p>',
  expectedFromFormats: ['html'],
  expectedToFormats: ['md', 'markdown'],
  expectedStrategies: ['turndown', 'semantic', 'clean'],
  mockAI,
});

// Agent-specific tests
describe('HtmlToMdAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new HtmlToMdAgent({ ai: mockAI, silent: true });
  });

  it('clean strategy strips script and style tags before conversion', async () => {
    const html = '<script>alert("x")</script><style>body{}</style><p>Content</p>';
    const result = await agent.execute(html, 'clean');
    expect(result.output).not.toContain('<script>');
    expect(result.output).not.toContain('<style>');
  });

  it('metadata includes tagsStripped flag for clean strategy', async () => {
    const result = await agent.execute('<p>Hello</p>', 'clean');
    expect(result.metadata.tagsStripped).toBe(true);
  });

  it('turndown strategy does not strip non-content tags', async () => {
    const result = await agent.execute('<p>Hello</p>', 'turndown');
    expect(result.metadata.tagsStripped).toBe(false);
  });
});
