import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock child_process (FFmpeg-dependent)
vi.mock('child_process', () => ({
  execFile: vi.fn((cmd, args, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    // Return valid duration for ffprobe calls
    const stdout = (Array.isArray(args) && args.includes('-show_entries'))
      ? '30.0'
      : 'mock output';
    if (cb) cb(null, stdout, '');
    return { on: vi.fn(), stdout: { on: vi.fn() }, stderr: { on: vi.fn() } };
  }),
}));

// Mock fs for temp file operations
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => Buffer.from('GIF89a mock data')),
    unlinkSync: vi.fn(),
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({ size: 16384 })),
  };
});

// Mock uuid
vi.mock('uuid', () => ({ v4: () => 'test-uuid-gif' }));

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();

// Import the agent class (CJS)
const { VideoToGifAgent } = require('../../../lib/converters/video-to-gif.js');

// Run the standard lifecycle test harness
testConverterAgent(VideoToGifAgent, {
  sampleInput: Buffer.from([0x00, 0x00, 0x00, 0x1C, 0x66, 0x74, 0x79, 0x70]),
  expectedFromFormats: ['mp4', 'webm', 'mov'],
  expectedToFormats: ['gif'],
  expectedStrategies: ['clip', 'highlight', 'timelapse'],
  mockAI,
});

// Agent-specific tests
describe('VideoToGifAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new VideoToGifAgent({ ai: mockAI, silent: true });
  });

  it('outputs gif format only', () => {
    expect(agent.to).toEqual(['gif']);
  });

  it('has three distinct strategies for different use cases', () => {
    const ids = agent.strategies.map(s => s.id);
    expect(ids).toContain('clip');
    expect(ids).toContain('highlight');
    expect(ids).toContain('timelapse');
  });

  it('has correct agent identity', () => {
    expect(agent.id).toBe('converter:video-to-gif');
    expect(agent.name).toBe('Video to GIF');
  });
});
