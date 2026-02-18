import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock pptxgenjs before importing agent
const mockSlide = {
  addText: vi.fn(),
  addShape: vi.fn(),
  addImage: vi.fn(),
  background: null,
};
vi.mock('pptxgenjs', () => ({
  default: vi.fn().mockImplementation(() => ({
    author: '',
    title: '',
    addSlide: vi.fn().mockReturnValue(mockSlide),
    write: vi.fn().mockResolvedValue(Buffer.from([0x50, 0x4b, 0x03, 0x04, ...Array(96).fill(0)])),
    defineSlideMaster: vi.fn(),
  })),
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
const { PlaybookToPptxAgent } = require('../../../lib/converters/playbook-to-pptx.js');

// Run the standard lifecycle test harness
testConverterAgent(PlaybookToPptxAgent, {
  sampleInput: samplePlaybook,
  expectedFromFormats: ['playbook'],
  expectedToFormats: ['pptx'],
  expectedStrategies: ['framework-slides', 'narrative', 'executive'],
  mockAI,
});

// Agent-specific tests
describe('PlaybookToPptxAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new PlaybookToPptxAgent({ ai: mockAI, silent: true });
  });

  it('has correct agent identity', () => {
    expect(agent.id).toBe('converter:playbook-to-pptx');
    expect(agent.name).toBe('Playbook to PPTX');
  });

  it('framework-slides strategy creates multiple slides', async () => {
    const result = await agent.execute(JSON.parse(samplePlaybook), 'framework-slides');
    expect(Buffer.isBuffer(result.output)).toBe(true);
  });

  it('narrative strategy calls AI for story structure', async () => {
    await agent.execute(JSON.parse(samplePlaybook), 'narrative');
    expect(mockAI.json).toHaveBeenCalled();
  });
});
