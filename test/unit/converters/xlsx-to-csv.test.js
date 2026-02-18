import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock exceljs before importing agent
const _mockCell = { value: 'test' };
const mockRow = {
  eachCell: vi.fn((opts, fn) => {
    fn({ value: 'Name' }, 1);
    fn({ value: 'Age' }, 2);
  }),
};
const mockSheet = {
  name: 'Sheet1',
  addRow: vi.fn().mockReturnValue(mockRow),
  eachRow: vi.fn((opts, fn) => {
    fn(
      {
        eachCell: vi.fn((o, cb) => {
          cb({ value: 'Name' }, 1);
          cb({ value: 'Age' }, 2);
        }),
      },
      1
    );
    fn(
      {
        eachCell: vi.fn((o, cb) => {
          cb({ value: 'Alice' }, 1);
          cb({ value: '30' }, 2);
        }),
      },
      2
    );
  }),
  columns: [],
  views: [],
};
vi.mock('exceljs', () => {
  // Use a plain constructor (not vi.fn) so vi.clearAllMocks() cannot reset it
  function MockWorkbook() {
    return {
      creator: '',
      created: null,
      addWorksheet: vi.fn().mockReturnValue(mockSheet),
      worksheets: [mockSheet],
      xlsx: {
        writeBuffer: vi.fn().mockResolvedValue(Buffer.from([0x50, 0x4b, 0x03, 0x04, ...Array(96).fill(0)])),
        load: vi.fn().mockResolvedValue(undefined),
      },
      getWorksheet: vi.fn().mockReturnValue(mockSheet),
    };
  }
  return { default: { Workbook: MockWorkbook }, Workbook: MockWorkbook };
});

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();

// Import the agent class (CJS)
const { XlsxToCsvAgent } = require('../../../lib/converters/xlsx-to-csv.js');

// Run the standard lifecycle test harness
testConverterAgent(XlsxToCsvAgent, {
  sampleInput: Buffer.from([0x50, 0x4b, 0x03, 0x04, ...Array(96).fill(0)]),
  expectedFromFormats: ['xlsx'],
  expectedToFormats: ['csv'],
  expectedStrategies: ['first-sheet', 'all-sheets', 'merged'],
  mockAI,
});

// Agent-specific tests
describe('XlsxToCsvAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    // Note: vi.clearAllMocks() intentionally omitted here because it resets
    // the exceljs Workbook mock implementation, causing the real exceljs to run.
    // The mockSheet is stateless enough that stale call counts don't matter.
    agent = new XlsxToCsvAgent({ ai: mockAI, silent: true });
  });

  it('escapes CSV cells containing commas', () => {
    expect(agent._escapeCsvCell('hello, world')).toBe('"hello, world"');
    expect(agent._escapeCsvCell('simple')).toBe('simple');
  });

  it('escapes CSV cells containing quotes', () => {
    expect(agent._escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it('metadata includes csv mime type', async () => {
    // vi.mock cannot intercept CJS require('exceljs') in vitest 4.x,
    // so create a real minimal XLSX buffer for the test.
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Test');
    ws.addRow(['Name', 'Age']);
    ws.addRow(['Alice', 30]);
    const buffer = await wb.xlsx.writeBuffer();

    const result = await agent.execute(buffer, 'first-sheet');
    expect(result.metadata.mimeType).toBe('text/csv');
    expect(result.metadata.extension).toBe('csv');
    expect(result.metadata.sheetCount).toBeGreaterThan(0);
  });
});
