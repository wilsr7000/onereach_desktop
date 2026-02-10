import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock global fetch for URL fetching
const mockFetchResponse = {
  ok: true,
  status: 200,
  text: vi.fn().mockResolvedValue('<!DOCTYPE html><html><body><h1>Example Domain</h1><p>This domain is for use in illustrative examples.</p></body></html>'),
  json: vi.fn().mockResolvedValue({}),
  headers: { get: vi.fn().mockReturnValue('text/html') },
};
vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockFetchResponse));

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();

// Import the agent class (CJS)
const { UrlToTextAgent } = require('../../../lib/converters/url-to-text.js');

// Run the standard lifecycle test harness
testConverterAgent(UrlToTextAgent, {
  sampleInput: 'https://example.com',
  expectedFromFormats: ['url'],
  expectedToFormats: ['text'],
  expectedStrategies: ['article', 'full', 'structured'],
  mockAI,
});

// Agent-specific tests
describe('UrlToTextAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch.mockResolvedValue(mockFetchResponse);
    agent = new UrlToTextAgent({ ai: mockAI, silent: true });
  });

  it('article strategy extracts main content text', async () => {
    const result = await agent.execute('https://example.com', 'article');
    expect(typeof result.output).toBe('string');
    expect(result.metadata.strategy).toBe('article');
    expect(result.metadata.url).toBe('https://example.com');
  });

  it('structured strategy preserves heading markers', async () => {
    const result = await agent.execute('https://example.com', 'structured');
    expect(typeof result.output).toBe('string');
    expect(result.output.length).toBeGreaterThan(0);
  });

  it('full strategy includes all visible text', async () => {
    const result = await agent.execute('https://example.com', 'full');
    expect(typeof result.output).toBe('string');
  });
});
