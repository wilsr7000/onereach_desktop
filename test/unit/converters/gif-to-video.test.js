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
    readFileSync: vi.fn(() => Buffer.from([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])),
    unlinkSync: vi.fn(),
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({ size: 32768 })),
  };
});

vi.mock('uuid', () => ({ v4: () => 'test-uuid-g2v' }));
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();
const { GifToVideoAgent } = require('../../../lib/converters/gif-to-video.js');

testConverterAgent(GifToVideoAgent, {
  sampleInput: Buffer.from('GIF89a mock data'),
  expectedFromFormats: ['gif'],
  expectedToFormats: ['mp4', 'webm'],
  expectedStrategies: ['standard', 'high-quality', 'loop'],
  mockAI,
});

describe('GifToVideoAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new GifToVideoAgent({ ai: mockAI, silent: true });
  });

  it('has correct agent identity', () => {
    expect(agent.id).toBe('converter:gif-to-video');
    expect(agent.name).toBe('GIF to Video');
  });

  it('outputs mp4 and webm formats', () => {
    expect(agent.to).toContain('mp4');
    expect(agent.to).toContain('webm');
  });

  it('has three distinct strategies', () => {
    const ids = agent.strategies.map((s) => s.id);
    expect(ids).toContain('standard');
    expect(ids).toContain('high-quality');
    expect(ids).toContain('loop');
  });

  it('uses symbolic mode only', () => {
    expect(agent.modes).toEqual(['symbolic']);
  });
});
