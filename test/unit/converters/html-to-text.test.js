import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();

// Import the agent class (CJS)
const { HtmlToTextAgent } = require('../../../lib/converters/html-to-text.js');

const sampleHtml = '<html><body><h1>Title</h1><p>Hello <strong>world</strong>, this is a test.</p><ul><li>One</li><li>Two</li></ul></body></html>';

// Run the standard lifecycle test harness
testConverterAgent(HtmlToTextAgent, {
  sampleInput: sampleHtml,
  expectedFromFormats: ['html'],
  expectedToFormats: ['text'],
  expectedStrategies: ['strip', 'readable', 'article'],
  mockAI,
});

// Agent-specific tests
describe('HtmlToTextAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new HtmlToTextAgent({ ai: mockAI, silent: true });
  });

  it('strip strategy removes all HTML tags', async () => {
    const result = await agent.execute('<p>Hello <b>world</b></p>', 'strip');
    expect(result.output).not.toMatch(/<[^>]+>/);
    expect(result.output).toContain('Hello');
    expect(result.output).toContain('world');
  });

  it('readable strategy preserves paragraph structure as newlines', async () => {
    const html = '<p>Paragraph one.</p><p>Paragraph two.</p>';
    const result = await agent.execute(html, 'readable');
    expect(result.output).toContain('Paragraph one.');
    expect(result.output).toContain('Paragraph two.');
    // The two paragraphs should be separated
    expect(result.output).toMatch(/Paragraph one\.\s+Paragraph two\./);
  });

  it('article strategy extracts content from <article> tags', async () => {
    const html = '<html><nav>Menu</nav><article><p>Main content here.</p></article><footer>Footer</footer></html>';
    const result = await agent.execute(html, 'article');
    expect(result.output).toContain('Main content here');
    expect(result.output).not.toContain('Menu');
    expect(result.output).not.toContain('Footer');
  });
});
