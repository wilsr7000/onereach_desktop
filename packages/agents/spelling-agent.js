/**
 * Spelling Agent
 * 
 * Handles spelling-related tasks:
 * - "Spell the word 'necessary'"
 * - "How do you spell 'receive'?"
 * - "Is 'recieve' spelled correctly?"
 */

const path = require('path');

// Common misspellings and corrections
const COMMON_MISSPELLINGS = {
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
function extractWord(content) {
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
function spellWord(word) {
  return word.toUpperCase().split('').join(' - ');
}

/**
 * Check if a word is likely misspelled
 */
function checkSpelling(word) {
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
function createSpellingAgent(exchangeUrl) {
  // Load the agent SDK from the compiled dist folder
  let createAgent, createKeywordMatcher;
  
  try {
    const agentPkg = require('../task-agent/dist/index.js');
    createAgent = agentPkg.createAgent;
    createKeywordMatcher = agentPkg.createKeywordMatcher;
  } catch (error) {
    console.error('[SpellingAgent] Failed to load task-agent package:', error.message);
    console.log('[SpellingAgent] Make sure to run: cd packages/task-agent && npm run build');
    throw error;
  }
  
  return createAgent({
    name: 'spelling-agent',
    version: '1.0.0',
    categories: ['spelling', 'language', 'words'],
    
    exchange: {
      url: exchangeUrl,
      reconnect: true,
      reconnectIntervalMs: 3000,
    },
    
    // Fast keyword matching
    quickMatch: (task) => {
      const content = task.content.toLowerCase();
      
      // High confidence for direct spelling requests
      if (content.includes('spell ') || content.includes('spelling')) {
        return 0.95;
      }
      
      // Medium confidence for related queries
      if (content.includes('how do you write') || 
          content.includes('letters in') ||
          content.includes('spelled correctly')) {
        return 0.8;
      }
      
      // Check for any spelling keywords
      const hasKeyword = SPELLING_KEYWORDS.some(kw => content.includes(kw));
      if (hasKeyword) {
        return 0.7;
      }
      
      return 0; // Can't handle this
    },
    
    // Execute spelling tasks
    execute: async (task, context) => {
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

module.exports = {
  createSpellingAgent,
  extractWord,
  spellWord,
  checkSpelling,
  COMMON_MISSPELLINGS,
  SPELLING_KEYWORDS,
};
