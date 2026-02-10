/**
 * Concierge Router
 * 
 * The main orchestration point for the voice assistant.
 * The Orb never answers questions directly - it routes to the exchange.
 * 
 * Responsibilities:
 * - Critical command intercept (cancel, repeat, undo)
 * - Pending question/confirmation resolution
 * - Pronoun resolution for followups
 * - Exchange submission with late-cancel suppression
 * - Result processing and undo tracking
 */

const { getLogger } = require('../logging/Logger');
const conversationState = require('../state/conversationState');
const responseMemory = require('../memory/responseMemory');
const pronounResolver = require('../intent/pronounResolver');
const correctionDetector = require('../intent/correctionDetector');
const progressReporter = require('../events/progressReporter');

// Module-level logger for use in default parameters and static contexts
const log = getLogger();

// Critical commands that are handled locally
const CRITICAL_COMMANDS = ['cancel', 'stop', 'nevermind', 'repeat', 'undo'];

// Acknowledgment phrases
const ACKNOWLEDGMENTS = {
  immediate: ["Got it", "Sure", "Okay", "Understood"],  // For statements
  investigative: ["Let me check", "One moment", "Looking into that"],  // For requests/questions
  failure: ["I don't know how to help with that", "I couldn't find anything for that"]
};

/**
 * Heuristic: does this look like a question or action request?
 */
function looksLikeRequestOrQuestion(text) {
  if (!text) return false;
  const lower = text.toLowerCase().trim();
  
  // Question words at start
  if (/^(what|when|where|who|why|how|is|are|can|could|will|would|do|does|did)\b/.test(lower)) return true;
  
  // Action verbs at start
  if (/^(play|pause|stop|skip|set|turn|open|close|send|get|find|show|tell|search|create|make)\b/.test(lower)) return true;
  
  // Ends with question mark
  if (text.trim().endsWith('?')) return true;
  
  return false;
}

class Router {
  /**
   * Create a new Router
   * @param {Object} exchange - The task exchange instance
   * @param {Function} speak - Function to speak feedback to user
   */
  constructor(exchange, speak) {
    this.exchange = exchange;
    this.speak = speak || ((msg) => log.info('voice', '[Router] Would speak', { msg }));
    this.log = getLogger();
    
    // Track current task for cancel semantics
    this.currentTaskId = null;
    this.cancelledTaskIds = new Set();
    
    // Listen for progress events from agents
    this.setupProgressListener();
    
    // Clean up old cancelled IDs periodically
    setInterval(() => {
      // Keep set from growing unbounded
      if (this.cancelledTaskIds.size > 100) {
        this.cancelledTaskIds.clear();
      }
    }, 60000);
  }
  
  /**
   * Set up listener for progress events from agents
   */
  setupProgressListener() {
    progressReporter.on('progress', (event) => {
      // Only speak progress if we have an active task
      if (this.currentTaskId) {
        this.log.info('Router', `Progress: ${event.agentId} - ${event.message}`);
        this.speak(event.message);
      }
    });
  }
  
  /**
   * Main entry point - handle a user transcript
   * @param {string} transcript - What the user said
   * @returns {Object} - { handled, speak, ... }
   */
  async handle(transcript) {
    if (!transcript || typeof transcript !== 'string') {
      this.log.warn('Router', 'Empty or invalid transcript');
      return { handled: false };
    }
    
    this.log.info('Router', `Input: "${transcript}"`);
    
    // 1. Critical command intercept (cancel, repeat, undo)
    const critical = this.checkCriticalCommand(transcript);
    if (critical) {
      this.log.info('Router', `Critical command: ${critical.type}`);
      return critical;
    }
    
    // 2. Correction detection - "no I said X" / "I meant Y"
    const correction = await this.checkForCorrection(transcript);
    if (correction) {
      this.log.info('Router', `Correction detected: "${correction.correctedIntent}"`);
      // Route the corrected intent instead
      return this.routeToExchange(correction.correctedIntent, transcript, false);
    }
    
    // 3. Pending question - route answer back to waiting agent
    if (conversationState.pendingQuestion) {
      return this.resolvePendingQuestion(transcript);
    }
    
    // 4. Pending confirmation (yes/no)
    if (conversationState.pendingConfirmation) {
      return this.resolvePendingConfirmation(transcript);
    }
    
    // 5. Pronoun resolution for followups
    const { resolved, wasResolved, referencedSubject } = 
      pronounResolver.resolve(transcript, conversationState.recentContext);
    
    if (wasResolved) {
      this.log.info('Router', `Pronoun resolved: "${transcript}" → "${resolved}"`);
    }
    
    // 6. Route to exchange
    return this.routeToExchange(resolved, transcript, wasResolved);
  }
  
  /**
   * Check for and handle critical commands
   * @param {string} transcript
   * @returns {Object|null}
   */
  checkCriticalCommand(transcript) {
    const lower = transcript.toLowerCase().trim();
    
    // Cancel: clear state AND mark current task as cancelled
    //
    // IMPORTANT: Distinguish system cancel from agent intent:
    //   "cancel"                     → system (stop current task)
    //   "stop"                       → system
    //   "cancel it" / "stop that"    → system (pronoun = current task)
    //   "nevermind" / "never mind"   → system
    //   "cancel the dentist appointment" → AGENT (calendar delete intent)
    //   "cancel my 3pm meeting"         → AGENT
    //   "stop the recording"            → AGENT
    //
    // Rule: intercept only bare commands or commands followed by a pronoun
    // (it, that, this, everything, all). Anything with a noun phrase routes to agents.
    const cancelWords = ['cancel', 'stop', 'nevermind', 'never mind'];
    const isCancelWord = cancelWords.some(c => lower === c);
    const pronounFollowers = ['it', 'that', 'this', 'everything', 'all', 'now'];
    const isCancelPronoun = cancelWords.some(c => {
      if (!lower.startsWith(c + ' ')) return false;
      const rest = lower.slice(c.length + 1).trim();
      return pronounFollowers.includes(rest);
    });
    if (isCancelWord || isCancelPronoun) {
      if (this.currentTaskId) {
        this.cancelledTaskIds.add(this.currentTaskId);
        this.log.info('Router', `Cancelled task: ${this.currentTaskId}`);
        
        // Tell exchange to cancel if it supports it
        if (this.exchange?.cancel) {
          try {
            this.exchange.cancel(this.currentTaskId);
          } catch (e) {
            this.log.warn('Router', 'Exchange cancel failed:', e.message);
          }
        }
      }
      this.currentTaskId = null;
      conversationState.clear();
      
      return { 
        handled: true, 
        speak: "Cancelled",
        type: 'cancel'
      };
    }
    
    // Repeat: only replay agent messages, not acknowledgments
    if (lower === 'repeat' || lower === 'say that again' || lower === 'what did you say') {
      const last = responseMemory.getLastResponse();
      return { 
        handled: true, 
        speak: last || "I haven't said anything yet",
        type: 'repeat'
      };
    }
    
    // Undo
    if (lower === 'undo' || lower === 'undo that' || lower === 'take that back') {
      return this.handleUndo();
    }
    
    return null;
  }
  
  /**
   * Check if user is correcting a previous command
   * @param {string} transcript
   * @returns {Object|null} - { correctedIntent } or null
   */
  async checkForCorrection(transcript) {
    // Get context from recent conversation
    const lastContext = conversationState.recentContext[0];
    const context = {
      lastRequest: lastContext?.subject || null,
      lastResponse: responseMemory.getLastResponse() || null
    };
    
    // Use pattern matching (fast), no LLM fallback by default
    // LLM fallback can be enabled if we have recent context
    const useLLM = !!context.lastRequest;
    
    const result = await correctionDetector.detect(transcript, context, useLLM);
    
    if (result.isCorrection && result.correctedIntent) {
      return {
        correctedIntent: result.correctedIntent,
        confidence: result.confidence,
        reasoning: result.reasoning
      };
    }
    
    return null;
  }
  
  /**
   * Handle undo command
   * @returns {Object}
   */
  async handleUndo() {
    if (!responseMemory.canUndo()) {
      return { 
        handled: true, 
        speak: "Nothing to undo",
        type: 'undo-failed'
      };
    }
    
    const result = await responseMemory.undo();
    
    return { 
      handled: true, 
      speak: result.message,
      type: result.success ? 'undo-success' : 'undo-failed'
    };
  }
  
  /**
   * Resolve a pending question with user's answer
   * @param {string} transcript
   * @returns {Object}
   */
  async resolvePendingQuestion(transcript) {
    const routing = conversationState.resolvePendingQuestion(transcript);
    if (!routing) {
      return { handled: false };
    }
    
    this.log.info('Router', `Routing answer to ${routing.agentId}`, { field: routing.field });
    
    // Re-submit to exchange with the answer filled in
    if (this.exchange?.submit) {
      try {
        const result = await this.exchange.submit({
          content: transcript,
          targetAgent: routing.agentId,
          context: {
            originalTaskId: routing.taskId,
            [routing.field]: transcript
          }
        });
        
        return this.processResult(result, transcript, true);
      } catch (error) {
        this.log.error('Router', 'Failed to route answer:', error.message);
        return { 
          handled: true, 
          speak: "Sorry, I couldn't process that answer"
        };
      }
    }
    
    return { handled: true, speak: null };
  }
  
  /**
   * Resolve a pending confirmation (yes/no)
   * @param {string} transcript
   * @returns {Object}
   */
  resolvePendingConfirmation(transcript) {
    const lower = transcript.toLowerCase().trim();
    
    const isYes = /^(yes|yeah|yep|sure|ok|okay|confirm|do it|go ahead|please|affirmative)$/i.test(lower);
    const isNo = /^(no|nope|nah|cancel|stop|nevermind|don't|negative)$/i.test(lower);
    
    if (!isYes && !isNo) {
      // Unclear response - ask again
      return { 
        handled: true, 
        speak: "Please say yes or no" 
      };
    }
    
    const result = conversationState.resolvePendingConfirmation(isYes);
    
    if (isNo) {
      return { 
        handled: true, 
        speak: "Cancelled",
        type: 'confirmation-no'
      };
    }
    
    // Confirmed - the action will speak its own result
    return { 
      handled: true, 
      speak: null,
      type: 'confirmation-yes'
    };
  }
  
  /**
   * Route a task to the exchange
   * @param {string} resolvedTranscript - Transcript with pronouns resolved
   * @param {string} originalTranscript - Original transcript
   * @param {boolean} wasResolved - Whether pronouns were resolved
   * @returns {Object}
   */
  async routeToExchange(resolvedTranscript, originalTranscript, wasResolved) {
    // Generate task ID for tracking
    const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    this.currentTaskId = taskId;
    
    // Acknowledge (investigative for requests, immediate for statements)
    const isRequest = looksLikeRequestOrQuestion(resolvedTranscript);
    const ack = this.pickRandom(isRequest ? ACKNOWLEDGMENTS.investigative : ACKNOWLEDGMENTS.immediate);
    
    // Speak acknowledgment
    this.speak(ack);
    
    // Submit to exchange
    if (!this.exchange?.submit) {
      this.log.error('Router', 'No exchange available');
      return { 
        handled: true, 
        speak: "Sorry, I can't process that right now"
      };
    }
    
    try {
      const result = await this.exchange.submit({ 
        id: taskId,
        content: resolvedTranscript
      });
      
      // Check if this task was cancelled while executing
      if (this.cancelledTaskIds.has(taskId)) {
        this.log.info('Router', `Suppressing late result for cancelled task: ${taskId}`);
        this.cancelledTaskIds.delete(taskId);
        return { handled: true, speak: null };
      }
      
      this.currentTaskId = null;
      return this.processResult(result, originalTranscript, isRequest);
      
    } catch (error) {
      this.log.error('Router', 'Exchange submit failed:', error.message);
      this.currentTaskId = null;
      return { 
        handled: true, 
        speak: "Sorry, something went wrong"
      };
    }
  }
  
  /**
   * Process a result from the exchange or agent
   * @param {Object} result - The result object
   * @param {string} transcript - Original transcript
   * @param {boolean} isRequest - Whether this was a request/question
   * @returns {Object}
   */
  async processResult(result, transcript, isRequest = true) {
    // Handle needsInput - agent needs more information
    if (result?.needsInput) {
      const { prompt, field, agentId } = result.needsInput;
      const taskId = result.needsInput.taskId || this.currentTaskId;
      
      this.log.info('Router', `Agent needs input: ${field}`);
      
      // Set up pending question and speak the prompt
      conversationState.setPendingQuestion(
        { prompt, field, agentId, taskId },
        () => {} // Resolve callback - not used in this flow
      );
      
      return { 
        handled: true, 
        speak: prompt,
        type: 'needs-input'
      };
    }
    
    // Handle no-bid / failure
    if (!result?.success) {
      // For statements (not requests), give safe acknowledgment
      if (!isRequest && !result?.message) {
        // Already acknowledged with "Got it"
        return { handled: true, speak: null };
      }
      
      const fail = result?.message || this.pickRandom(ACKNOWLEDGMENTS.failure);
      return { 
        handled: true, 
        speak: fail,
        type: 'failure'
      };
    }
    
    // Success - store for repeat
    if (result.message) {
      // Only store agent messages, not our acknowledgments
      responseMemory.setLastResponse(result.message);
      
      // Store undo only if BOTH undoFn AND undoDescription are present
      if (result.undoFn && result.undoDescription) {
        responseMemory.setUndoableAction(result.undoDescription, result.undoFn);
      }
      
      // Add to context for followups
      const subject = pronounResolver.extractSubject(transcript);
      if (subject) {
        conversationState.addContext({
          subject,
          response: result.message,
          timestamp: Date.now()
        });
      }
    }
    
    // Handle agent handoff - agent wants to pass task to another agent
    if (result.handoff) {
      await this.processHandoff(result.handoff, transcript);
    }
    
    return { 
      handled: true, 
      speak: result.message,
      type: 'success'
    };
  }
  
  /**
   * Process an agent handoff request
   * @param {Object} handoff - { targetAgent, content, context }
   * @param {string} originalTranscript - Original user request
   */
  async processHandoff(handoff, originalTranscript) {
    const { targetAgent, content, context } = handoff;
    
    this.log.info('Router', `Handoff to ${targetAgent}: "${content}"`);
    
    if (!this.exchange?.submit) {
      this.log.warn('Router', 'Cannot process handoff - no exchange available');
      return;
    }
    
    try {
      // Submit the handoff task to the target agent
      const handoffResult = await this.exchange.submit({
        id: `handoff_${Date.now()}`,
        content: content,
        targetAgent: targetAgent,
        context: {
          ...context,
          handoffFrom: originalTranscript,
          isHandoff: true
        }
      });
      
      // If the handoff produced a message, speak it
      if (handoffResult?.success && handoffResult?.message) {
        this.speak(handoffResult.message);
      } else if (!handoffResult?.success && handoffResult?.message) {
        this.log.warn('Router', `Handoff to ${targetAgent} failed: ${handoffResult.message}`);
      }
    } catch (error) {
      this.log.error('Router', `Handoff to ${targetAgent} error:`, error.message);
    }
  }
  
  /**
   * Pick a random item from an array
   * @param {Array} arr
   * @returns {*}
   */
  pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }
  
  /**
   * Get current state for debugging
   * @returns {Object}
   */
  getState() {
    return {
      currentTaskId: this.currentTaskId,
      cancelledCount: this.cancelledTaskIds.size,
      conversationState: conversationState.getRoutingContext(),
      undoAvailable: responseMemory.canUndo(),
      lastResponse: responseMemory.getLastResponse()?.substring(0, 50)
    };
  }
}

/**
 * Create a Router instance
 * @param {Object} exchange - Task exchange
 * @param {Function} speak - Speak function
 * @returns {Router}
 */
function createRouter(exchange, speak) {
  return new Router(exchange, speak);
}

module.exports = { 
  Router, 
  createRouter,
  ACKNOWLEDGMENTS,
  looksLikeRequestOrQuestion
};
