import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock child_process (FFmpeg-dependent)
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

// Mock fs for temp file operations
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => Buffer.from([0xff, 0xfb, 0x90, 0x00])),
    unlinkSync: vi.fn(),
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({ size: 2048 })),
  };
});

// Mock uuid
vi.mock('uuid', () => ({ v4: () => 'test-uuid-af' }));

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();

// Import the agent class (CJS)
const { AudioFormatConverter } = require('../../../lib/converters/audio-format.js');

// Run the standard lifecycle test harness
testConverterAgent(AudioFormatConverter, {
  sampleInput: Buffer.from([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70]),
  expectedFromFormats: ['mp3', 'wav', 'aac', 'ogg', 'flac'],
  expectedToFormats: ['mp3', 'wav', 'aac', 'ogg', 'flac'],
  expectedStrategies: ['direct', 'normalized', 'optimized'],
  mockAI,
});

// Agent-specific tests
describe('AudioFormatConverter (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new AudioFormatConverter({ ai: mockAI, silent: true });
  });

  it('operates in symbolic mode only', () => {
    expect(agent.modes).toEqual(['symbolic']);
  });

  it('supports m4a as an input format', () => {
    expect(agent.from).toContain('m4a');
  });

  it('has correct agent identity', () => {
    expect(agent.id).toBe('converter:audio-format');
    expect(agent.name).toBe('Audio Format Converter');
  });
});
