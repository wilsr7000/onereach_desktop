import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock js-yaml before importing agent
vi.mock('js-yaml', () => ({
  default: {
    dump: vi.fn().mockReturnValue('title: Test Playbook\nstatus: draft\nkeywords:\n  - test\n  - unit\n'),
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
const { PlaybookToMdAgent } = require('../../../lib/converters/playbook-to-md.js');

// Run the standard lifecycle test harness
testConverterAgent(PlaybookToMdAgent, {
  sampleInput: samplePlaybook,
  expectedFromFormats: ['playbook'],
  expectedToFormats: ['md', 'markdown'],
  expectedStrategies: ['frontmatter', 'inline', 'structured'],
  mockAI,
});

// Agent-specific tests
describe('PlaybookToMdAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new PlaybookToMdAgent({ ai: mockAI, silent: true });
  });

  it('has correct agent identity', () => {
    expect(agent.id).toBe('converter:playbook-to-md');
    expect(agent.name).toBe('Playbook to Markdown');
  });

  it('frontmatter strategy produces YAML front matter', async () => {
    const result = await agent.execute(JSON.parse(samplePlaybook), 'frontmatter');
    expect(typeof result.output).toBe('string');
    expect(result.metadata.strategy).toBe('frontmatter');
  });

  it('structured strategy includes framework as Markdown section', async () => {
    const result = await agent.execute(JSON.parse(samplePlaybook), 'structured');
    expect(typeof result.output).toBe('string');
    expect(result.output.length).toBeGreaterThan(0);
  });
});
