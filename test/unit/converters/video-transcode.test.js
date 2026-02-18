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
    readFileSync: vi.fn(() => Buffer.from([0x00, 0x00, 0x00, 0x1c])),
    unlinkSync: vi.fn(),
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({ size: 1024 })),
  };
});

// Mock uuid
vi.mock('uuid', () => ({ v4: () => 'test-uuid-1234' }));

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();

// Import the agent class (CJS)
const { VideoTranscodeAgent } = require('../../../lib/converters/video-transcode.js');

// Run the standard lifecycle test harness
testConverterAgent(VideoTranscodeAgent, {
  sampleInput: Buffer.from([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70]),
  expectedFromFormats: ['mp4', 'webm', 'mov'],
  expectedToFormats: ['mp4', 'webm', 'mov'],
  expectedStrategies: ['fast', 'quality', 'compress'],
  mockAI,
});

// Agent-specific tests
describe('VideoTranscodeAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new VideoTranscodeAgent({ ai: mockAI, silent: true });
  });

  it('builds copy-only args for fast strategy', () => {
    const args = agent._buildArgs('/tmp/in.mp4', '/tmp/out.mp4', 'fast', 'mp4', {});
    expect(args).toContain('-c');
    expect(args).toContain('copy');
    expect(args).not.toContain('-crf');
  });

  it('includes CRF flag for quality strategy', () => {
    const args = agent._buildArgs('/tmp/in.mp4', '/tmp/out.mp4', 'quality', 'mp4', {});
    expect(args).toContain('-crf');
    expect(args).toContain('18');
    expect(args).toContain('libx264');
  });

  it('uses higher CRF for compress strategy', () => {
    const args = agent._buildArgs('/tmp/in.mp4', '/tmp/out.mp4', 'compress', 'mp4', {});
    expect(args).toContain('-crf');
    expect(args).toContain('28');
  });
});
