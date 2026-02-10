/**
 * Spelling Agent
 * 
 * Handles spelling-related tasks:
 * - "Spell the word 'necessary'"
 * - "How do you spell 'receive'?"
 * - "Is 'recieve' spelled correctly?"
 */

import { createAgent, createKeywordMatcher } from '../task-agent/src/index.js';
import type { Task, TaskResult, ExecutionContext } from '../task-exchange/src/types/index.js';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

// Common misspellings and corrections
const COMMON_MISSPELLINGS: Record<string, string> = {
  'recieve': 'receive',
  'seperate': 'separate',
  'occured': 'occurred',
  'untill': 'until',
  'definately': 'definitely',
  'accomodate': 'accommodate',
  'occassion': 'occasion',
  'neccessary': 'necessary',
  'independant': 'independent',
  'embarass': 'embarrass',
  'occurence': 'occurrence',
  'millenium': 'millennium',
  'persistant': 'persistent',
  'refered': 'referred',
  'wierd': 'weird',
  'calender': 'calendar',
  'foriegn': 'foreign',
  'goverment': 'government',
  'harrass': 'harass',
  'immediatly': 'immediately',
  'libary': 'library',
  'mispell': 'misspell',
  'noticable': 'noticeable',
  'publically': 'publicly',
  'recomend': 'recommend',
  'rythm': 'rhythm',
  'successfull': 'successful',
  'tommorow': 'tomorrow',
  'truely': 'truly',
  'writting': 'writing',
};

// Keywords that indicate a spelling task
const SPELLING_KEYWORDS = [
  'spell',
  'spelling',
  'spelled',
  'spelt',
  'letters',
  'how do you write',
];

/**
 * Extract the target word from the task content
 */
function extractWord(content: string): string | null {
  // Match quoted words: "word" or 'word'
  const quotedMatch = content.match(/['"]([a-zA-Z]+)['"]/);
  if (quotedMatch) {
    return quotedMatch[1].toLowerCase();
  }

  // Match "spell X" pattern
  const spellMatch = content.match(/spell\s+(?:the\s+word\s+)?([a-zA-Z]+)/i);
  if (spellMatch) {
    return spellMatch[1].toLowerCase();
  }

  // Match "is X spelled" pattern
  const checkMatch = content.match(/is\s+([a-zA-Z]+)\s+spell/i);
  if (checkMatch) {
    return checkMatch[1].toLowerCase();
  }

  return null;
}

/**
 * Spell out a word letter by letter
 */
function spellWord(word: string): string {
  return word.toUpperCase().split('').join(' - ');
}

/**
 * Check if a word is likely misspelled
 */
function checkSpelling(word: string): { correct: boolean; suggestion?: string } {
  const lower = word.toLowerCase();
  
  // Check our known misspellings
  if (COMMON_MISSPELLINGS[lower]) {
    return { correct: false, suggestion: COMMON_MISSPELLINGS[lower] };
  }
  
  // Basic heuristics for common patterns
  // Double letters that shouldn't be
  if (/([a-z])\1\1/.test(lower)) {
    return { correct: false, suggestion: undefined };
  }
  
  // Assume correct if not in our list
  return { correct: true };
}

/**
 * Create the spelling agent
 */
export function createSpellingAgent(exchangeUrl: string) {
  return createAgent({
    name: 'spelling-agent',
    version: '1.0.0',
    categories: ['spelling', 'language', 'words'],
    
    exchange: {
      url: exchangeUrl,
      reconnect: true,
      reconnectIntervalMs: 3000,
    },
    
    // Bidding is handled entirely by the unified LLM bidder (unified-bidder.js).
    // No quickMatch -- per project policy, no keyword/regex classification.
    
    // Execute spelling tasks
    execute: async (task: Task, context: ExecutionContext): Promise<TaskResult> => {
      const content = task.content.toLowerCase();
      
      // Check for cancellation
      if (context.signal.aborted) {
        return { success: false, error: 'Task cancelled' };
      }
      
      // Extract the target word
      const word = extractWord(task.content);
      
      if (!word) {
        return {
          success: false,
          error: 'Could not identify the word to spell. Try: "Spell the word \'example\'"',
        };
      }
      
      // Determine what kind of spelling task
      if (content.includes('correct') || content.includes('right') || content.includes('check')) {
        // Spelling check
        const result = checkSpelling(word);
        
        if (result.correct) {
          return {
            success: true,
            data: {
              action: 'check',
              word,
              correct: true,
              message: `Yes, "${word}" is spelled correctly.`,
            },
          };
        } else {
          return {
            success: true,
            data: {
              action: 'check',
              word,
              correct: false,
              suggestion: result.suggestion,
              message: result.suggestion 
                ? `"${word}" is misspelled. The correct spelling is "${result.suggestion}".`
                : `"${word}" appears to be misspelled.`,
            },
          };
        }
      }
      
      // Default: spell out the word
      // First check if it might be misspelled
      const spellCheck = checkSpelling(word);
      const correctWord = spellCheck.suggestion || word;
      const spelled = spellWord(correctWord);
      
      let message = `${correctWord.toUpperCase()}: ${spelled}`;
      if (spellCheck.suggestion) {
        message = `Note: "${word}" is commonly misspelled. The correct spelling is:\n${correctWord.toUpperCase()}: ${spelled}`;
      }
      
      return {
        success: true,
        data: {
          action: 'spell',
          originalWord: word,
          correctedWord: correctWord,
          spelled,
          message,
          letterCount: correctWord.length,
        },
      };
    },
    
    maxConcurrent: 10, // Spelling is fast, can handle many
  });
}

// === CLI Runner ===

async function main() {
  const exchangeUrl = process.argv[2] || 'ws://localhost:3000';
  
  log.info('agent', 'Starting', { exchangeUrl });
  log.info('agent', 'Connecting to exchange', { exchangeUrl });
  
  const agent = createSpellingAgent(exchangeUrl);
  
  // Event handlers
  agent.on('connected', ({ exchangeUrl }) => {
    log.info('agent', 'Connected to exchange', { exchangeUrl });
  });
  
  agent.on('disconnected', ({ reason }) => {
    log.warn('agent', 'Disconnected from exchange', { reason });
  });
  
  agent.on('reconnecting', ({ attempt }) => {
    log.info('agent', 'Reconnecting to exchange', { attempt });
  });
  
  agent.on('bid:requested', ({ task }) => {
    log.debug('agent', 'Bid requested', { content: task.content });
  });
  
  agent.on('bid:submitted', ({ confidence }) => {
    log.debug('agent', 'Bid submitted', { confidence });
  });
  
  agent.on('bid:skipped', ({ reason }) => {
    log.debug('agent', 'Skipped bidding', { reason });
  });
  
  agent.on('task:assigned', ({ task, isBackup }) => {
    log.info('agent', 'Task assigned', { content: task.content, isBackup });
  });
  
  agent.on('task:completed', ({ taskId, success }) => {
    log.info('agent', 'Task completed', { taskId, success });
  });
  
  // Start the agent
  try {
    await agent.start();
    log.info('agent', 'Running - press Ctrl+C to stop');
    
    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      log.info('agent', 'Shutting down');
      await agent.stop();
      process.exit(0);
    });
    
  } catch (error: any) {
    log.error('agent', 'Failed to start', { error: error?.message || error });
    process.exit(1);
  }
}

// Run if executed directly
if (process.argv[1]?.includes('spelling-agent')) {
  main();
}

export default createSpellingAgent;
