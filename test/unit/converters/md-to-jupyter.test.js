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
const { MdToJupyterAgent } = require('../../../lib/converters/md-to-jupyter.js');

const sampleMarkdown = `# Analysis

Some introductory text.

\`\`\`python
import pandas as pd
df = pd.read_csv("data.csv")
print(df.head())
\`\`\`

## Results

The data shows interesting patterns.`;

// Run the standard lifecycle test harness
testConverterAgent(MdToJupyterAgent, {
  sampleInput: sampleMarkdown,
  expectedFromFormats: ['md', 'markdown'],
  expectedToFormats: ['ipynb'],
  expectedStrategies: ['auto-cell', 'strict-fence', 'annotated'],
  mockAI,
});

// Agent-specific tests
describe('MdToJupyterAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new MdToJupyterAgent({ ai: mockAI, silent: true });
  });

  it('produces valid nbformat 4 JSON output', async () => {
    const result = await agent.execute(sampleMarkdown, 'auto-cell');
    const notebook = JSON.parse(result.output);
    expect(notebook.nbformat).toBe(4);
    expect(notebook.metadata.kernelspec).toBeDefined();
    expect(Array.isArray(notebook.cells)).toBe(true);
  });

  it('creates code cells from fenced code blocks', async () => {
    const result = await agent.execute(sampleMarkdown, 'strict-fence');
    const notebook = JSON.parse(result.output);
    const codeCells = notebook.cells.filter(c => c.cell_type === 'code');
    expect(codeCells.length).toBeGreaterThan(0);
    expect(codeCells[0].source.join('')).toContain('import pandas');
  });

  it('annotated strategy adds metadata tags to cells', async () => {
    const result = await agent.execute(sampleMarkdown, 'annotated');
    const notebook = JSON.parse(result.output);
    const taggedCells = notebook.cells.filter(c => c.metadata.tags && c.metadata.tags.length > 0);
    expect(taggedCells.length).toBeGreaterThan(0);
  });
});
