import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock exceljs before importing agent
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
    fn({ eachCell: vi.fn((o, cb) => { cb({ value: 'Name' }, 1); cb({ value: 'Age' }, 2); }) }, 1);
    fn({ eachCell: vi.fn((o, cb) => { cb({ value: 'Alice' }, 1); cb({ value: 30 }, 2); }) }, 2);
  }),
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
      getWorksheet: vi.fn().mockReturnValue(mockSheet),
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
const { XlsxToJsonAgent } = require('../../../lib/converters/xlsx-to-json.js');

// Run the standard lifecycle test harness
testConverterAgent(XlsxToJsonAgent, {
  sampleInput: Buffer.from([0x50, 0x4B, 0x03, 0x04, ...Array(96).fill(0)]),
  expectedFromFormats: ['xlsx'],
  expectedToFormats: ['json'],
  expectedStrategies: ['rows-as-objects', 'raw-arrays', 'typed'],
  mockAI,
});

// Agent-specific tests
describe('XlsxToJsonAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new XlsxToJsonAgent({ ai: mockAI, silent: true });
  });

  it('infers numeric types correctly', () => {
    expect(agent._inferType('42')).toBe(42);
    expect(agent._inferType('3.14')).toBe(3.14);
    expect(agent._inferType('0')).toBe(0);
  });

  it('infers boolean types correctly', () => {
    expect(agent._inferType('true')).toBe(true);
    expect(agent._inferType('false')).toBe(false);
  });

  it('preserves leading-zero strings as strings', () => {
    expect(agent._inferType('007')).toBe('007');
    expect(agent._inferType('01234')).toBe('01234');
  });
});
