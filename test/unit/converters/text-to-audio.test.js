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
const { TextToAudioConverter } = require('../../../lib/converters/text-to-audio.js');

// Run the standard lifecycle test harness
testConverterAgent(TextToAudioConverter, {
  sampleInput: 'Hello, this is a test of the text to audio converter.',
  expectedFromFormats: ['text', 'md'],
  expectedToFormats: ['mp3', 'wav'],
  expectedStrategies: ['standard', 'voiced', 'expressive'],
  mockAI,
});

// Agent-specific tests
describe('TextToAudioConverter (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new TextToAudioConverter({ ai: mockAI, silent: true });
  });

  it('validates known voice IDs', () => {
    expect(agent._validateVoice('alloy')).toBe('alloy');
    expect(agent._validateVoice('nova')).toBe('nova');
    expect(agent._validateVoice('shimmer')).toBe('shimmer');
  });

  it('falls back to default for unknown voice', () => {
    // Unknown voices should fall back to the default voice (alloy)
    expect(agent._validateVoice('unknown-voice')).toBe('alloy');
    expect(agent._validateVoice('')).toBe('alloy');
  });

  it('strips Markdown formatting for cleaner TTS', () => {
    const md = '# Title\n\n**bold** text and `code`';
    const stripped = agent._stripMarkdown(md);
    expect(stripped).not.toContain('#');
    expect(stripped).not.toContain('**');
    expect(stripped).not.toContain('`');
    expect(stripped).toContain('bold');
    expect(stripped).toContain('text');
  });
});
