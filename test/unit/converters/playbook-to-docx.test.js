import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock docx package before importing agent
vi.mock('docx', () => ({
  Document: vi.fn().mockImplementation(() => ({})),
  Packer: { toBuffer: vi.fn().mockResolvedValue(Buffer.from([0x50, 0x4B, 0x03, 0x04, ...Array(96).fill(0)])) },
  Paragraph: vi.fn().mockImplementation((opts) => opts || {}),
  TextRun: vi.fn().mockImplementation((opts) => opts || {}),
  HeadingLevel: { HEADING_1: 'HEADING_1', HEADING_2: 'HEADING_2', HEADING_3: 'HEADING_3' },
  AlignmentType: { CENTER: 'CENTER', RIGHT: 'RIGHT', LEFT: 'LEFT' },
  Header: vi.fn().mockImplementation((opts) => opts || {}),
  Footer: vi.fn().mockImplementation((opts) => opts || {}),
  PageNumber: { CURRENT: 'CURRENT', TOTAL_PAGES: 'TOTAL_PAGES' },
  BorderStyle: { SINGLE: 'SINGLE' },
  Table: vi.fn().mockImplementation((opts) => opts || {}),
  TableRow: vi.fn().mockImplementation((opts) => opts || {}),
  TableCell: vi.fn().mockImplementation((opts) => opts || {}),
  WidthType: { PERCENTAGE: 'PERCENTAGE', DXA: 'DXA' },
  ShadingType: { SOLID: 'SOLID' },
  VerticalAlign: { CENTER: 'CENTER' },
  TableLayoutType: { FIXED: 'FIXED' },
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
const { PlaybookToDocxAgent } = require('../../../lib/converters/playbook-to-docx.js');

// Run the standard lifecycle test harness
testConverterAgent(PlaybookToDocxAgent, {
  sampleInput: samplePlaybook,
  expectedFromFormats: ['playbook'],
  expectedToFormats: ['docx'],
  expectedStrategies: ['formal', 'template', 'compact'],
  mockAI,
});

// Agent-specific tests
describe('PlaybookToDocxAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new PlaybookToDocxAgent({ ai: mockAI, silent: true });
  });

  it('has correct agent identity', () => {
    expect(agent.id).toBe('converter:playbook-to-docx');
    expect(agent.name).toBe('Playbook to DOCX');
  });

  it('formal strategy produces Buffer output', async () => {
    const result = await agent.execute(JSON.parse(samplePlaybook), 'formal');
    expect(Buffer.isBuffer(result.output)).toBe(true);
  });

  it('compact strategy produces minimal document', async () => {
    const result = await agent.execute(JSON.parse(samplePlaybook), 'compact');
    expect(Buffer.isBuffer(result.output)).toBe(true);
  });
});
