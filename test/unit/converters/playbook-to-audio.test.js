import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService({
  ttsResponse: Buffer.from('mock-audio-data-for-playbook-narration'),
  completeResponse: 'This playbook covers testing best practices for converter agents.',
});

const samplePlaybook = JSON.stringify({
  id: 'test-playbook-1',
  title: 'Test Playbook',
  content: '# Test Content\nThis is a test playbook for unit testing.',
  status: 'draft',
  keywords: ['test', 'unit'],
  framework: {
    who: [{ entity: 'Tester', role: 'QA' }],
    what: [{ item: 'Test playbook conversion' }],
    why: [{ reason: 'Validate converter agents' }],
    where: [{ location: 'Test environment' }],
    when: [{ timeframe: 'During testing' }],
  },
});

// Import the agent class (CJS)
const { PlaybookToAudioAgent } = require('../../../lib/converters/playbook-to-audio.js');

// Run the standard lifecycle test harness
testConverterAgent(PlaybookToAudioAgent, {
  sampleInput: samplePlaybook,
  expectedFromFormats: ['playbook'],
  expectedToFormats: ['mp3', 'wav'],
  expectedStrategies: ['narration', 'summary', 'framework-first'],
  mockAI,
});

// Agent-specific tests
describe('PlaybookToAudioAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new PlaybookToAudioAgent({ ai: mockAI, silent: true });
  });

  it('has correct agent identity', () => {
    expect(agent.id).toBe('converter:playbook-to-audio');
    expect(agent.name).toBe('Playbook to Audio');
  });

  it('uses generative mode', () => {
    expect(agent.modes).toContain('generative');
  });

  it('summary strategy calls AI for text summarization before TTS', async () => {
    await agent.execute(JSON.parse(samplePlaybook), 'summary');
    expect(mockAI.complete).toHaveBeenCalled();
    expect(mockAI.tts).toHaveBeenCalled();
  });
});
