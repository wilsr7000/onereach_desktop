import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService, createMockSharp } from '../../mocks/conversion-mocks.js';

// Mock sharp for fallback rendering
const mockSharp = createMockSharp();
vi.mock('sharp', () => ({ default: mockSharp }));

// Mock child_process (pdftoppm / FFmpeg)
vi.mock('child_process', () => ({
  execFile: vi.fn((cmd, args, opts, cb) => {
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    if (cb) cb(null, 'mock output', '');
    return { on: vi.fn(), stdout: { on: vi.fn() }, stderr: { on: vi.fn() } };
  }),
}));

// Mock pdf-parse for fallback page counting
vi.mock('pdf-parse', () => ({
  default: vi.fn().mockResolvedValue({
    text: 'Mock PDF content',
    numpages: 2,
    info: { Title: 'Mock PDF' },
  }),
}));

// Mock fs for temp file operations
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    unlinkSync: vi.fn(),
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({ size: 4096 })),
    readdirSync: vi.fn(() => ['page_001.png']),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();

// Import the agent class (CJS)
const { PdfToImageAgent } = require('../../../lib/converters/pdf-to-image.js');

// Run the standard lifecycle test harness
testConverterAgent(PdfToImageAgent, {
  sampleInput: Buffer.from([0x25, 0x50, 0x44, 0x46]),
  expectedFromFormats: ['pdf'],
  expectedToFormats: ['png', 'jpg'],
  expectedStrategies: ['single-page', 'all-pages', 'thumbnail'],
  mockAI,
});

// Agent-specific tests
describe('PdfToImageAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new PdfToImageAgent({ ai: mockAI, silent: true });
  });

  it('operates in symbolic mode', () => {
    expect(agent.modes).toEqual(['symbolic']);
  });

  it('has three rendering strategies', () => {
    const ids = agent.strategies.map((s) => s.id);
    expect(ids).toEqual(['single-page', 'all-pages', 'thumbnail']);
  });

  it('has correct agent identity', () => {
    expect(agent.id).toBe('converter:pdf-to-image');
    expect(agent.name).toBe('PDF to Image');
  });
});
