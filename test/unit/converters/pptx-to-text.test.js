import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { createRequire } from 'module';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

const require2 = createRequire(import.meta.url);

// Inject adm-zip mock into Node require cache so CJS require() inside agents picks it up
// AdmZip must be a real constructor (arrow functions aren't constructable)
function MockAdmZip() {
  this.getEntries = vi.fn().mockReturnValue([
    {
      entryName: 'ppt/slides/slide1.xml',
      getData: vi.fn().mockReturnValue(
        Buffer.from('<p:sld><a:p><a:t>Slide Title</a:t></a:p><a:p><a:t>Bullet point one</a:t></a:p></p:sld>'),
      ),
    },
    {
      entryName: 'ppt/slides/slide2.xml',
      getData: vi.fn().mockReturnValue(
        Buffer.from('<p:sld><a:p><a:t>Second Slide</a:t></a:p><a:p><a:t>More content</a:t></a:p></p:sld>'),
      ),
    },
  ]);
}

beforeAll(() => {
  const admZipPath = require2.resolve('adm-zip');
  require2.cache[admZipPath] = { id: admZipPath, filename: admZipPath, loaded: true, exports: MockAdmZip };
});

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();

// Import the agent class (CJS)
const { PptxToTextAgent } = require('../../../lib/converters/pptx-to-text.js');

// Run the standard lifecycle test harness
testConverterAgent(PptxToTextAgent, {
  sampleInput: Buffer.from([0x50, 0x4B, 0x03, 0x04, ...Array(96).fill(0)]),
  expectedFromFormats: ['pptx'],
  expectedToFormats: ['text'],
  expectedStrategies: ['slide-text', 'with-notes', 'structured'],
  mockAI,
});

// Agent-specific tests
describe('PptxToTextAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new PptxToTextAgent({ ai: mockAI, silent: true });
  });

  it('slide-text strategy extracts text from all slides', async () => {
    const result = await agent.execute(Buffer.from('mock-pptx'), 'slide-text');
    expect(typeof result.output).toBe('string');
    expect(result.output).toContain('Slide Title');
    expect(result.metadata.mimeType).toBe('text/plain');
  });

  it('structured strategy prefixes slide numbers', async () => {
    const result = await agent.execute(Buffer.from('mock-pptx'), 'structured');
    expect(result.output).toContain('--- Slide 1 ---');
    expect(result.output).toContain('--- Slide 2 ---');
  });

  it('metadata includes slideCount', async () => {
    const result = await agent.execute(Buffer.from('mock-pptx'), 'slide-text');
    expect(result.metadata.slideCount).toBe(2);
  });
});
