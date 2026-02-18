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
      getData: vi
        .fn()
        .mockReturnValue(
          Buffer.from('<p:sld><a:p><a:t>Welcome</a:t></a:p><a:p><a:t>Introduction content</a:t></a:p></p:sld>')
        ),
    },
    {
      entryName: 'ppt/slides/slide2.xml',
      getData: vi
        .fn()
        .mockReturnValue(Buffer.from('<p:sld><a:p><a:t>Key Points</a:t></a:p><a:p><a:t>Point A</a:t></a:p></p:sld>')),
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
const { PptxToMdAgent } = require('../../../lib/converters/pptx-to-md.js');

// Run the standard lifecycle test harness
testConverterAgent(PptxToMdAgent, {
  sampleInput: Buffer.from([0x50, 0x4b, 0x03, 0x04, ...Array(96).fill(0)]),
  expectedFromFormats: ['pptx'],
  expectedToFormats: ['md', 'markdown'],
  expectedStrategies: ['flat', 'sectioned', 'enhanced'],
  mockAI,
});

// Agent-specific tests
describe('PptxToMdAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new PptxToMdAgent({ ai: mockAI, silent: true });
  });

  it('sectioned strategy creates slide headings', async () => {
    const result = await agent.execute(Buffer.from('mock-pptx'), 'sectioned');
    expect(typeof result.output).toBe('string');
    expect(result.output).toContain('## Slide 1');
    expect(result.metadata.mimeType).toBe('text/markdown');
  });

  it('flat strategy produces text without slide headings', async () => {
    const result = await agent.execute(Buffer.from('mock-pptx'), 'flat');
    expect(result.output).not.toContain('## Slide');
    expect(result.output).toContain('Welcome');
  });

  it('enhanced strategy calls AI for enrichment', async () => {
    await agent.execute(Buffer.from('mock-pptx'), 'enhanced');
    expect(mockAI.complete).toHaveBeenCalledWith(
      expect.stringContaining('Improve the following Markdown'),
      expect.objectContaining({ profile: 'fast' })
    );
  });
});
