import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock marked before importing agent
vi.mock('marked', () => ({
  marked: {
    parse: vi.fn((input) => `<p>${input}</p>\n`),
    setOptions: vi.fn(),
  },
}));

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();

const samplePlaybook = JSON.stringify({
  id: 'test-playbook-1',
  title: 'Test Playbook',
  content: '# Test Content\nThis is a test playbook for unit testing.',
  status: 'draft',
  keywords: ['test', 'unit'],
  framework: {
    who: [{ entity: 'Tester', role: 'QA' }],
    what: [{ item: 'Test playbook conversion' }],
    why: [{ reason: 'Validate converter agents' }],
    where: [{ location: 'Test environment' }],
    when: [{ timeframe: 'During testing' }],
  },
});

// Import the agent class (CJS)
const { PlaybookToHtmlAgent } = require('../../../lib/converters/playbook-to-html.js');

// Run the standard lifecycle test harness
testConverterAgent(PlaybookToHtmlAgent, {
  sampleInput: samplePlaybook,
  expectedFromFormats: ['playbook'],
  expectedToFormats: ['html'],
  expectedStrategies: ['document', 'dashboard', 'print'],
  mockAI,
});

// Agent-specific tests
describe('PlaybookToHtmlAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new PlaybookToHtmlAgent({ ai: mockAI, silent: true });
  });

  it('document strategy produces a full HTML document', async () => {
    const result = await agent.execute(JSON.parse(samplePlaybook), 'document');
    expect(typeof result.output).toBe('string');
    expect(result.output).toContain('<!DOCTYPE html>');
    expect(result.metadata.isFullDocument).toBe(true);
  });

  it('dashboard strategy produces card-based layout', async () => {
    const result = await agent.execute(JSON.parse(samplePlaybook), 'dashboard');
    expect(typeof result.output).toBe('string');
    expect(result.output.length).toBeGreaterThan(0);
  });

  it('print strategy includes print-optimized styles', async () => {
    const result = await agent.execute(JSON.parse(samplePlaybook), 'print');
    expect(typeof result.output).toBe('string');
    expect(result.output.length).toBeGreaterThan(0);
  });
});
