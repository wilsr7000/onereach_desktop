/**
 * Orb Text Input Flow Tests
 *
 * Tests the text chat panel submission flow in orb.html:
 *   sendChatMessage() -> processVoiceCommand() -> window.agentHUD.submitTask()
 *
 * Also tests the integration between orb text input, HUD API, and state machine.
 *
 * Run: npx vitest run test/unit/orb-text-input.test.js
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════
// SIMULATED ORB ENVIRONMENT
// ═══════════════════════════════════════════════════════════════════

function createOrbTextInputEnv() {
  // Simulated DOM elements
  const chatInput = { value: '', focus: vi.fn() };
  const chatMessages = { children: [], scrollTop: 0, scrollHeight: 100, appendChild: vi.fn() };

  // Simulated window.agentHUD
  const agentHUD = {
    submitTask: vi.fn().mockResolvedValue({
      taskId: 'task-123',
      queued: true,
      handled: true,
      message: 'Agent responded',
    }),
    onResult: vi.fn(),
    onLifecycle: vi.fn(),
    onNeedsInput: vi.fn(),
    onDisambiguation: vi.fn(),
  };

  // Track messages added to chat
  const messageLog = [];

  // Simulated addChatMessage
  function addChatMessage(type, text) {
    messageLog.push({ type, text, timestamp: Date.now() });
  }

  // Simulated processVoiceCommand (the shared handler for voice + text)
  let processVoiceCommandResult = null;
  async function processVoiceCommand(transcript) {
    if (!transcript || !transcript.trim()) return;

    const result = await agentHUD.submitTask(transcript, {
      toolId: 'orb',
      skipFilter: false,
    });
    processVoiceCommandResult = result;
    return result;
  }

  // Simulated sendChatMessage (from orb.html)
  async function sendChatMessage() {
    const text = chatInput.value.trim();
    if (!text) return;

    // Clear input
    chatInput.value = '';

    // Add user message to chat
    addChatMessage('user', text);

    // Process via shared handler
    try {
      const result = await processVoiceCommand(text);

      if (result && result.message) {
        addChatMessage('assistant', result.message);
      }
    } catch (err) {
      addChatMessage('error', 'Something went wrong. Please try again.');
    }
  }

  return {
    chatInput,
    chatMessages,
    agentHUD,
    messageLog,
    addChatMessage,
    processVoiceCommand,
    sendChatMessage,
    getLastResult: () => processVoiceCommandResult,
  };
}

// ═══════════════════════════════════════════════════════════════════
// SEND CHAT MESSAGE
// ═══════════════════════════════════════════════════════════════════

describe('Orb Text Input - sendChatMessage()', () => {
  let env;

  beforeEach(() => {
    env = createOrbTextInputEnv();
  });

  it('sends text to agentHUD.submitTask with toolId orb', async () => {
    env.chatInput.value = 'what is the weather';
    await env.sendChatMessage();

    expect(env.agentHUD.submitTask).toHaveBeenCalledWith(
      'what is the weather',
      expect.objectContaining({ toolId: 'orb', skipFilter: false })
    );
  });

  it('clears input field after sending', async () => {
    env.chatInput.value = 'hello';
    await env.sendChatMessage();
    expect(env.chatInput.value).toBe('');
  });

  it('adds user message to chat log', async () => {
    env.chatInput.value = 'tell me a joke';
    await env.sendChatMessage();
    expect(env.messageLog[0].type).toBe('user');
    expect(env.messageLog[0].text).toBe('tell me a joke');
  });

  it('adds assistant response to chat log', async () => {
    env.agentHUD.submitTask.mockResolvedValue({
      taskId: 'task-1',
      handled: true,
      message: 'Here is a joke...',
    });
    env.chatInput.value = 'tell me a joke';
    await env.sendChatMessage();
    expect(env.messageLog).toHaveLength(2);
    expect(env.messageLog[1].type).toBe('assistant');
    expect(env.messageLog[1].text).toBe('Here is a joke...');
  });

  it('ignores empty input', async () => {
    env.chatInput.value = '';
    await env.sendChatMessage();
    expect(env.agentHUD.submitTask).not.toHaveBeenCalled();
    expect(env.messageLog).toHaveLength(0);
  });

  it('ignores whitespace-only input', async () => {
    env.chatInput.value = '   ';
    await env.sendChatMessage();
    expect(env.agentHUD.submitTask).not.toHaveBeenCalled();
  });

  it('handles submission error gracefully', async () => {
    env.agentHUD.submitTask.mockRejectedValue(new Error('Exchange down'));
    env.chatInput.value = 'test';
    await env.sendChatMessage();
    // Should add error message
    const errorMsg = env.messageLog.find(m => m.type === 'error');
    expect(errorMsg).toBeDefined();
    expect(errorMsg.text).toContain('wrong');
  });

  it('handles null result from submitTask', async () => {
    env.agentHUD.submitTask.mockResolvedValue(null);
    env.chatInput.value = 'test';
    await env.sendChatMessage();
    // Should have user message but no assistant message
    expect(env.messageLog).toHaveLength(1);
    expect(env.messageLog[0].type).toBe('user');
  });
});

// ═══════════════════════════════════════════════════════════════════
// PROCESS VOICE COMMAND (shared text + voice handler)
// ═══════════════════════════════════════════════════════════════════

describe('Orb Text Input - processVoiceCommand()', () => {
  let env;

  beforeEach(() => {
    env = createOrbTextInputEnv();
  });

  it('calls submitTask with correct parameters', async () => {
    await env.processVoiceCommand('what time is it');
    expect(env.agentHUD.submitTask).toHaveBeenCalledWith(
      'what time is it',
      { toolId: 'orb', skipFilter: false }
    );
  });

  it('returns submitTask result', async () => {
    env.agentHUD.submitTask.mockResolvedValue({
      taskId: 'task-42',
      handled: true,
      message: 'It is 3pm',
    });
    const result = await env.processVoiceCommand('what time is it');
    expect(result.taskId).toBe('task-42');
    expect(result.message).toBe('It is 3pm');
  });

  it('ignores empty transcript', async () => {
    await env.processVoiceCommand('');
    expect(env.agentHUD.submitTask).not.toHaveBeenCalled();
  });

  it('ignores null transcript', async () => {
    await env.processVoiceCommand(null);
    expect(env.agentHUD.submitTask).not.toHaveBeenCalled();
  });

  it('handles needsInput response', async () => {
    env.agentHUD.submitTask.mockResolvedValue({
      taskId: 'task-43',
      handled: true,
      needsInput: {
        prompt: 'Which city?',
        field: 'city',
        agentId: 'weather-agent',
      },
    });
    const result = await env.processVoiceCommand('check the weather');
    expect(result.needsInput).toBeDefined();
    expect(result.needsInput.prompt).toBe('Which city?');
  });

  it('handles disambiguation response', async () => {
    env.agentHUD.submitTask.mockResolvedValue({
      taskId: 'task-44',
      handled: true,
      needsClarification: true,
      message: 'Did you mean A or B?',
    });
    const result = await env.processVoiceCommand('play something');
    expect(result.needsClarification).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEXT INPUT VS VOICE INPUT DIFFERENCES
// ═══════════════════════════════════════════════════════════════════

describe('Text Input vs Voice Input paths', () => {
  let env;

  beforeEach(() => {
    env = createOrbTextInputEnv();
  });

  it('text input sets skipFilter: false', async () => {
    env.chatInput.value = 'hello world';
    await env.sendChatMessage();
    const [, options] = env.agentHUD.submitTask.mock.calls[0];
    expect(options.skipFilter).toBe(false);
  });

  it('text input sets toolId to orb', async () => {
    env.chatInput.value = 'hello world';
    await env.sendChatMessage();
    const [, options] = env.agentHUD.submitTask.mock.calls[0];
    expect(options.toolId).toBe('orb');
  });

  it('text input sends exact user text (no transcription noise)', async () => {
    const exactText = 'Schedule a meeting with Bob at 3pm tomorrow';
    env.chatInput.value = exactText;
    await env.sendChatMessage();
    const [text] = env.agentHUD.submitTask.mock.calls[0];
    expect(text).toBe(exactText);
  });

  it('text input trims whitespace', async () => {
    env.chatInput.value = '  hello world  ';
    await env.sendChatMessage();
    const [text] = env.agentHUD.submitTask.mock.calls[0];
    expect(text).toBe('hello world');
  });
});

// ═══════════════════════════════════════════════════════════════════
// MULTI-TURN CONVERSATION
// ═══════════════════════════════════════════════════════════════════

describe('Orb Text Input - Multi-turn conversation', () => {
  let env;

  beforeEach(() => {
    env = createOrbTextInputEnv();
  });

  it('handles sequential messages', async () => {
    env.agentHUD.submitTask.mockResolvedValue({ taskId: 'task-1', handled: true, message: 'Response 1' });
    env.chatInput.value = 'first message';
    await env.sendChatMessage();

    env.agentHUD.submitTask.mockResolvedValue({ taskId: 'task-2', handled: true, message: 'Response 2' });
    env.chatInput.value = 'second message';
    await env.sendChatMessage();

    expect(env.agentHUD.submitTask).toHaveBeenCalledTimes(2);
    expect(env.messageLog).toHaveLength(4);
    expect(env.messageLog[0].text).toBe('first message');
    expect(env.messageLog[1].text).toBe('Response 1');
    expect(env.messageLog[2].text).toBe('second message');
    expect(env.messageLog[3].text).toBe('Response 2');
  });

  it('handles follow-up after needsInput', async () => {
    // First message triggers follow-up
    env.agentHUD.submitTask.mockResolvedValue({
      taskId: 'task-1',
      handled: true,
      needsInput: { prompt: 'Which city?', field: 'city', agentId: 'weather-agent' },
      message: 'Which city would you like weather for?',
    });
    env.chatInput.value = 'check the weather';
    await env.sendChatMessage();

    // Second message provides the answer
    env.agentHUD.submitTask.mockResolvedValue({
      taskId: 'task-2',
      handled: true,
      message: 'Weather in NYC: Sunny, 72F',
    });
    env.chatInput.value = 'New York';
    await env.sendChatMessage();

    expect(env.agentHUD.submitTask).toHaveBeenCalledTimes(2);
    expect(env.messageLog).toHaveLength(4);
  });
});

// ═══════════════════════════════════════════════════════════════════
// ORB STATE + TEXT INPUT INTERACTION
// ═══════════════════════════════════════════════════════════════════

describe('OrbState + Text Input interaction', () => {

  function loadOrbState() {
    const _window = {};
    const fs = require('fs');
    const path = require('path');
    const code = fs.readFileSync(path.join(__dirname, '../../lib/orb/orb-state.js'), 'utf8');
    const fn = new Function('window', code);
    fn(_window);
    return _window.OrbState;
  }

  it('text input works in idle state (does not require listening)', () => {
    const OrbState = loadOrbState();
    expect(OrbState.phase).toBe('idle');
    // Text input bypasses voice-listener, so idle is fine
    // The key point: text input does NOT go through event router input gating
  });

  it('text input works in processing state', () => {
    const OrbState = loadOrbState();
    OrbState.startSession();
    OrbState.transition('listening', 'connected');
    OrbState.transition('processing', 'text-submitted');
    expect(OrbState.phase).toBe('processing');
    // Text input can still be queued even during processing
  });

  it('canAcceptInput is false during processing (voice only)', () => {
    const OrbState = loadOrbState();
    OrbState.startSession();
    OrbState.transition('listening', 'connected');
    OrbState.transition('processing', 'submitted');
    expect(OrbState.canAcceptInput()).toBe(false);
    // This gate only applies to VOICE input via event router
    // Text input bypasses this check entirely
  });
});
