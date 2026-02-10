import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock child_process (FFmpeg-dependent)
vi.mock('child_process', () => ({
  execFile: vi.fn((cmd, args, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    // Return valid duration for ffprobe calls
    const stdout = (Array.isArray(args) && args.includes('-show_entries'))
      ? '120.5'
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
    readFileSync: vi.fn(() => Buffer.from([0x89, 0x50, 0x4E, 0x47])),
    unlinkSync: vi.fn(),
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({ size: 8192 })),
    readdirSync: vi.fn(() => ['frame_001.png']),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

// Mock uuid
vi.mock('uuid', () => ({ v4: () => 'test-uuid-vti' }));

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();

// Import the agent class (CJS)
const { VideoToImageAgent } = require('../../../lib/converters/video-to-image.js');

// Run the standard lifecycle test harness
testConverterAgent(VideoToImageAgent, {
  sampleInput: Buffer.from([0x00, 0x00, 0x00, 0x1C, 0x66, 0x74, 0x79, 0x70]),
  expectedFromFormats: ['mp4', 'webm', 'mov'],
  expectedToFormats: ['png', 'jpg'],
  expectedStrategies: ['thumbnail', 'keyframes', 'interval', 'specific'],
  mockAI,
});

// Agent-specific tests
describe('VideoToImageAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new VideoToImageAgent({ ai: mockAI, silent: true });
  });

  it('supports four extraction strategies', () => {
    const ids = agent.strategies.map(s => s.id);
    expect(ids).toEqual(['thumbnail', 'keyframes', 'interval', 'specific']);
  });

  it('operates in symbolic mode', () => {
    expect(agent.modes).toContain('symbolic');
  });

  it('has correct agent identity', () => {
    expect(agent.id).toBe('converter:video-to-image');
    expect(agent.name).toBe('Video to Image');
  });
});
