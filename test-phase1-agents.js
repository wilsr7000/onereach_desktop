/**
 * Phase 1 Agent Test Script
 * Tests built-in agents by simulating voice input (bypassing speech-to-text)
 */

// Mock global.speakFeedback for testing
global.speakFeedback = (text) => {
  console.log(`\n🔊 [SPEAK]: "${text}"\n`);
};

// Import agents directly
const timeAgent = require('./packages/agents/time-agent');
const weatherAgent = require('./packages/agents/weather-agent');
const mediaAgent = require('./packages/agents/media-agent');
const helpAgent = require('./packages/agents/help-agent');

// Import state management
const conversationState = require('./src/voice-task-sdk/state/conversationState');
const responseMemory = require('./src/voice-task-sdk/memory/responseMemory');
const pronounResolver = require('./src/voice-task-sdk/intent/pronounResolver');

const builtInAgents = [timeAgent, weatherAgent, mediaAgent, helpAgent];

async function simulateVoiceInput(transcript) {
  console.log('\n' + '='.repeat(60));
  console.log(`USER SAYS: "${transcript}"`);
  console.log('='.repeat(60));

  const task = { id: `task_${Date.now()}`, content: transcript };

  // Check for critical commands first
  const lowerText = transcript.toLowerCase().trim();

  if (lowerText === 'cancel' || lowerText === 'stop' || lowerText === 'nevermind') {
    conversationState.clear();
    console.log('→ Critical command: CANCEL');
    global.speakFeedback('Cancelled.');
    return { handled: true, action: 'cancel' };
  }

  if (lowerText === 'repeat') {
    const lastResponse = responseMemory.getLastResponse();
    if (lastResponse) {
      console.log('→ Critical command: REPEAT');
      global.speakFeedback(lastResponse);
      return { handled: true, action: 'repeat' };
    } else {
      global.speakFeedback("I don't have anything to repeat.");
      return { handled: true, action: 'repeat-empty' };
    }
  }

  if (lowerText === 'undo') {
    console.log('→ Critical command: UNDO');
    if (responseMemory.canUndo()) {
      const undoInfo = responseMemory.getUndoInfo();
      console.log(`   Undoing: ${undoInfo.description}`);
      await responseMemory.undo();
      global.speakFeedback(`Undone: ${undoInfo.description}`);
      return { handled: true, action: 'undo' };
    } else {
      global.speakFeedback('Nothing to undo.');
      return { handled: true, action: 'undo-nothing' };
    }
  }

  // Check for pending question
  if (conversationState.pendingQuestion) {
    console.log('→ Resolving pending question');
    const pending = conversationState.pendingQuestion;
    conversationState.clearPendingQuestion();

    // Re-submit with the answer as context
    const newTask = {
      id: `task_${Date.now()}`,
      content: pending.originalTranscript || 'weather',
    };
    const context = { [pending.field]: transcript };

    // Find the agent that asked the question
    for (const agent of builtInAgents) {
      if (agent.id === pending.agentId) {
        const result = await agent.execute(newTask, context);
        if (result.success) {
          responseMemory.setLastResponse(result.message);
          global.speakFeedback(result.message);
          return { handled: true, action: agent.id, message: result.message };
        }
      }
    }
  }

  // Check for pronoun resolution
  if (pronounResolver.needsResolution(transcript)) {
    const recentSubject = conversationState.getRecentSubject();
    if (recentSubject) {
      const resolved = pronounResolver.resolve(transcript, conversationState.recentContext);
      console.log(`→ Pronoun resolved: "${transcript}" → "${resolved}"`);
      task.content = resolved;
    }
  }

  // Try built-in agents
  console.log('→ Checking built-in agents...');

  for (const agent of builtInAgents) {
    const bid = agent.bid(task);
    console.log(`   ${agent.id}: ${bid ? `bid ${bid.confidence}` : 'no bid'}`);

    if (bid && bid.confidence > 0.5) {
      console.log(`   → ${agent.id} WINS`);

      const result = await agent.execute(task, {});

      // Handle needsInput
      if (result.needsInput) {
        console.log(`   → Agent needs input: ${result.needsInput.field}`);
        conversationState.setPendingQuestion(
          {
            prompt: result.needsInput.prompt,
            field: result.needsInput.field,
            agentId: agent.id,
            taskId: task.id,
            originalTranscript: transcript,
          },
          () => {}
        );

        global.speakFeedback(result.needsInput.prompt);
        return { handled: true, action: `${agent.id}-needs-input`, needsInput: true };
      }

      if (result.success) {
        // Store for repeat
        if (result.message) {
          responseMemory.setLastResponse(result.message);
          conversationState.addContext({
            type: 'response',
            agent: agent.id,
            subject: task.content,
            response: result.message,
          });
        }

        // Store undo if available
        if (result.undoFn && result.undoDescription) {
          responseMemory.setUndoableAction(result.undoDescription, result.undoFn);
          console.log(`   → Undo available: "${result.undoDescription}"`);
        }

        global.speakFeedback(result.message);
        return { handled: true, action: agent.id, message: result.message };
      }
    }
  }

  // No agent handled it
  console.log('→ No agent bid - falling through to exchange');
  global.speakFeedback("I'm not sure how to help with that.");
  return { handled: false };
}

// Run tests
async function runTests() {
  console.log('\n' + '╔' + '═'.repeat(58) + '╗');
  console.log('║' + ' PHASE 1 AGENT TESTS '.padStart(40).padEnd(58) + '║');
  console.log('╚' + '═'.repeat(58) + '╝');

  // Test 1: Time
  await simulateVoiceInput('What time is it?');

  // Test 2: Help
  await simulateVoiceInput('What can you do?');

  // Test 3: Weather without location (should ask)
  await simulateVoiceInput("What's the weather?");

  // Test 4: Provide the location (simulates followup)
  await simulateVoiceInput('San Francisco');

  // Test 5: Repeat
  await simulateVoiceInput('Repeat');

  // Test 6: Media (pause)
  await simulateVoiceInput('Pause the music');

  // Test 7: Undo (should resume)
  await simulateVoiceInput('Undo');

  // Test 8: Undo again (nothing to undo)
  await simulateVoiceInput('Undo');

  // Test 9: Cancel
  await simulateVoiceInput('Cancel');

  // Test 10: No match
  await simulateVoiceInput('Tell me a joke');

  console.log('\n' + '═'.repeat(60));
  console.log('TESTS COMPLETE');
  console.log('═'.repeat(60) + '\n');
}

runTests().catch(console.error);
