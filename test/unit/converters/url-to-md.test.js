import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock global fetch for URL fetching
const mockFetchResponse = {
  ok: true,
  status: 200,
  text: vi.fn().mockResolvedValue('<!DOCTYPE html><html><body><article><h1>Article Title</h1><p>Article content here</p></article></body></html>'),
  json: vi.fn().mockResolvedValue({}),
  headers: { get: vi.fn().mockReturnValue('text/html') },
};
vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockFetchResponse));

// Mock turndown before importing agent
vi.mock('turndown', () => ({
  default: vi.fn().mockImplementation(() => ({
    turndown: vi.fn().mockReturnValue('# Article Title\n\nArticle content here'),
    addRule: vi.fn(),
    remove: vi.fn(),
  })),
}));

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();

// Import the agent class (CJS)
const { UrlToMdAgent } = require('../../../lib/converters/url-to-md.js');

// Run the standard lifecycle test harness
testConverterAgent(UrlToMdAgent, {
  sampleInput: 'https://example.com',
  expectedFromFormats: ['url'],
  expectedToFormats: ['md', 'markdown'],
  expectedStrategies: ['readability', 'full', 'selective'],
  mockAI,
});

// Agent-specific tests
describe('UrlToMdAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch.mockResolvedValue(mockFetchResponse);
    agent = new UrlToMdAgent({ ai: mockAI, silent: true });
  });

  it('readability strategy produces Markdown from article content', async () => {
    const result = await agent.execute('https://example.com/article', 'readability');
    expect(typeof result.output).toBe('string');
    expect(result.metadata.strategy).toBe('readability');
    expect(result.metadata.url).toBe('https://example.com/article');
  });

  it('selective strategy uses AI for content identification', async () => {
    await agent.execute('https://example.com', 'selective');
    expect(mockAI.chat).toHaveBeenCalled();
  });

  it('full strategy converts entire page HTML', async () => {
    const result = await agent.execute('https://example.com', 'full');
    expect(typeof result.output).toBe('string');
    expect(result.output.length).toBeGreaterThan(0);
  });
});
