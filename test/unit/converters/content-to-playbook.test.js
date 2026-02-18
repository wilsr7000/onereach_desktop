import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockPlaybookOutput = {
  title: 'Project Management Guide',
  content: 'Here is some content about project management',
  keywords: ['project', 'management'],
  framework: {
    who: { primary: 'Project managers', characteristics: ['leadership'], context: 'Corporate', notFor: [] },
    why: {
      coreValue: 'Efficiency',
      emotionalHook: 'Success',
      practicalBenefit: 'Better outcomes',
      uniqueAngle: 'Framework-based',
    },
    what: {
      primaryAction: 'Manage projects',
      secondaryActions: ['Plan', 'Execute'],
      successLooksLike: 'On-time delivery',
      failureLooksLike: 'Missed deadlines',
    },
    where: {
      platform: 'Web',
      format: 'Playbook',
      distribution: 'Internal',
      consumptionContext: 'Work',
      constraints: [],
    },
    when: { raw: 'Ongoing', parsed: { type: 'ongoing', display: 'Ongoing' }, confirmed: true },
  },
  doFramework: {},
};

const mockAI = createMockAIService({
  jsonResponse: mockPlaybookOutput,
});

// Import the agent class (CJS)
const { ContentToPlaybookAgent } = require('../../../lib/converters/content-to-playbook.js');

// Run the standard lifecycle test harness
testConverterAgent(ContentToPlaybookAgent, {
  sampleInput: 'Here is some content about project management',
  expectedFromFormats: ['text', 'md', 'html'],
  expectedToFormats: ['playbook'],
  expectedStrategies: ['full-analysis', 'quick', 'template'],
  mockAI,
});

// Agent-specific tests
describe('ContentToPlaybookAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new ContentToPlaybookAgent({ ai: mockAI, silent: true });
  });

  it('has correct agent identity', () => {
    expect(agent.id).toBe('converter:content-to-playbook');
    expect(agent.name).toContain('Playbook');
  });

  it('uses generative mode for AI-powered analysis', () => {
    expect(agent.modes).toContain('generative');
  });

  it('full-analysis strategy calls AI for framework extraction', async () => {
    await agent.execute('Content about project management best practices', 'full-analysis');
    expect(mockAI.json).toHaveBeenCalled();
  });
});
