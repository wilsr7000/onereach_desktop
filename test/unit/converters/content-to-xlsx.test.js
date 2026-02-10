import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock exceljs before importing agent
const mockRow = {
  eachCell: vi.fn((opts, fn) => { fn({ value: 'test' }, 1); }),
};
const mockSheet = {
  name: 'Sheet1',
  addRow: vi.fn().mockReturnValue(mockRow),
  eachRow: vi.fn((opts, fn) => { fn(mockRow, 1); }),
  columns: [],
  views: [],
};
vi.mock('exceljs', () => ({
  default: {
    Workbook: vi.fn().mockImplementation(() => ({
      creator: '',
      created: null,
      addWorksheet: vi.fn().mockReturnValue(mockSheet),
      worksheets: [mockSheet],
      xlsx: {
        writeBuffer: vi.fn().mockResolvedValue(Buffer.from([0x50, 0x4B, 0x03, 0x04, ...Array(96).fill(0)])),
        load: vi.fn().mockResolvedValue(undefined),
      },
    })),
  },
}));

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();

// Import the agent class (CJS)
const { ContentToXlsxAgent } = require('../../../lib/converters/content-to-xlsx.js');

// Run the standard lifecycle test harness
testConverterAgent(ContentToXlsxAgent, {
  sampleInput: 'Name,Age\nAlice,30\nBob,25',
  expectedFromFormats: ['text', 'csv', 'json'],
  expectedToFormats: ['xlsx'],
  expectedStrategies: ['flat', 'multi-sheet', 'formatted'],
  mockAI,
});

// Agent-specific tests
describe('ContentToXlsxAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new ContentToXlsxAgent({ ai: mockAI, silent: true });
  });

  it('parses CSV input into rows', () => {
    const rows = agent._parseInputToRows('Name,Age\nAlice,30\nBob,25');
    expect(rows.length).toBe(3);
    expect(rows[0]).toEqual(['Name', 'Age']);
    expect(rows[1]).toEqual(['Alice', '30']);
  });

  it('parses JSON array input into rows with headers', () => {
    const jsonInput = JSON.stringify([{ Name: 'Alice', Age: 30 }]);
    const rows = agent._parseInputToRows(jsonInput);
    expect(rows.length).toBe(2);
    expect(rows[0]).toContain('Name');
  });

  it('metadata includes xlsx mime type', async () => {
    const result = await agent.execute('A,B\n1,2', 'flat');
    expect(result.metadata.mimeType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(result.metadata.extension).toBe('xlsx');
  });
});
