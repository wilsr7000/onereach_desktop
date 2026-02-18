import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock global fetch for URL fetching
const mockFetchResponse = {
  ok: true,
  status: 200,
  text: vi
    .fn()
    .mockResolvedValue(
      '<!DOCTYPE html><html><head><title>Example</title></head><body><h1>Example</h1><p>Content here</p></body></html>'
    ),
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
const { UrlToHtmlAgent } = require('../../../lib/converters/url-to-html.js');

// Run the standard lifecycle test harness
testConverterAgent(UrlToHtmlAgent, {
  sampleInput: 'https://example.com',
  expectedFromFormats: ['url'],
  expectedToFormats: ['html'],
  expectedStrategies: ['fetch', 'tab-capture', 'cached'],
  mockAI,
});

// Agent-specific tests
describe('UrlToHtmlAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch.mockResolvedValue(mockFetchResponse);
    agent = new UrlToHtmlAgent({ ai: mockAI, silent: true });
  });

  it('fetch strategy retrieves HTML from URL', async () => {
    const result = await agent.execute('https://example.com', 'fetch');
    expect(typeof result.output).toBe('string');
    expect(result.output).toContain('<html>');
    expect(result.metadata.strategy).toBe('fetch');
    expect(result.metadata.url).toBe('https://example.com');
  });

  it('cached strategy returns cached content on second call', async () => {
    await agent.execute('https://example.com/cached-test', 'cached');
    const result = await agent.execute('https://example.com/cached-test', 'cached');
    expect(typeof result.output).toBe('string');
  });

  it('rejects empty URL input', async () => {
    await expect(agent.execute('', 'fetch')).rejects.toThrow();
  });
});
