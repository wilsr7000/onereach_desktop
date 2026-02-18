/**
 * Spelling Agent
 *
 * Handles spelling-related tasks:
 * - "Spell the word 'necessary'"
 * - "How do you spell 'receive'?"
 * - "Is 'recieve' spelled correctly?"
 */

const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

// Common misspellings and corrections
const COMMON_MISSPELLINGS = {
  recieve: 'receive',
  seperate: 'separate',
  occured: 'occurred',
  untill: 'until',
  definately: 'definitely',
  accomodate: 'accommodate',
  occassion: 'occasion',
  neccessary: 'necessary',
  independant: 'independent',
  embarass: 'embarrass',
  occurence: 'occurrence',
  millenium: 'millennium',
  persistant: 'persistent',
  refered: 'referred',
  wierd: 'weird',
  calender: 'calendar',
  foriegn: 'foreign',
  goverment: 'government',
  harrass: 'harass',
  immediatly: 'immediately',
  libary: 'library',
  mispell: 'misspell',
  noticable: 'noticeable',
  publically: 'publicly',
  recomend: 'recommend',
  rythm: 'rhythm',
  successfull: 'successful',
  tommorow: 'tomorrow',
  truely: 'truly',
  writting: 'writing',
};

// Keywords that indicate a spelling task
const SPELLING_KEYWORDS = ['spell', 'spelling', 'spelled', 'spelt', 'letters', 'how do you write'];

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

  // Match "is it X or Y" pattern (return the first word -- caller checks both)
  const orMatch = content.match(/is\s+it\s+([a-zA-Z]+)\s+or\s+([a-zA-Z]+)/i);
  if (orMatch) {
    return orMatch[1].toLowerCase();
  }

  // Match "spelling of X" or "correct spelling of X"
  const ofMatch = content.match(/spelling\s+of\s+([a-zA-Z]+)/i);
  if (ofMatch) {
    return ofMatch[1].toLowerCase();
  }

  // Match "how do you spell X"
  const howMatch = content.match(/how\s+(?:do\s+you\s+)?spell\s+([a-zA-Z]+)/i);
  if (howMatch) {
    return howMatch[1].toLowerCase();
  }

  // Fallback: last word that's 3+ letters and not a common filler
  const words = content.match(/[a-zA-Z]{3,}/g);
  const fillers = new Set([
    'how',
    'you',
    'the',
    'what',
    'spell',
    'spelling',
    'correct',
    'write',
    'this',
    'that',
    'does',
    'can',
  ]);
  if (words) {
    for (let i = words.length - 1; i >= 0; i--) {
      if (!fillers.has(words[i].toLowerCase())) {
        return words[i].toLowerCase();
      }
    }
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
  let createAgent;

  try {
    const agentPkg = require('../task-agent/dist/index.js');
    createAgent = agentPkg.createAgent;
  } catch (error) {
    log.error('agent', 'Failed to load task-agent package', { error: error.message });
    log.info('agent', 'Make sure to run: cd packages/task-agent && npm run build');
    throw error;
  }

  return createAgent({
    name: 'spelling-agent',
    version: '1.0.0',
    voice: 'sage', // Calm, precise - see VOICE-GUIDE.md
    categories: ['spelling', 'language', 'words'],

    exchange: {
      url: exchangeUrl,
      reconnect: true,
      reconnectIntervalMs: 3000,
    },

    // Bidding is handled entirely by the unified LLM bidder (unified-bidder.js).
    // No quickMatch -- per project policy, no keyword/regex classification.

    // Execute spelling tasks
    execute: async (task, context) => {
      const content = task.content.toLowerCase();

      // Check for cancellation
      if (context.signal.aborted) {
        return { success: false, message: 'Task cancelled' };
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

// ==================== STANDARD BUILT-IN AGENT FORMAT ====================
// This is the primary export -- used by agent-registry.js for LLM-based bidding.
// The createSpellingAgent() factory is DEPRECATED (uses old task-agent SDK).

const spellingAgent = {
  id: 'spelling-agent',
  name: 'Spelling Agent',
  description: 'Spells words, checks spelling, and corrects common misspellings',
  voice: 'sage',
  acks: ['Let me spell that.', 'Checking the spelling.'],
  categories: ['spelling', 'language', 'words'],
  keywords: ['spell', 'spelling', 'spelled', 'spelt', 'letters', 'how do you write', 'correct spelling'],
  executionType: 'informational',

  prompt: `Spelling Agent handles spelling requests: spelling out words, checking spelling, and correcting misspellings.

HIGH CONFIDENCE (0.85+) for:
- "How do you spell necessary?" → spell out the word
- "Spell accommodation" → spell out the word
- "Is it receive or recieve?" → spelling check / correction
- "What is the correct spelling of rhythm?" → spelling correction
- "Check the spelling of occurrence" → spelling check
- Any request about how to spell a word, or whether a word is spelled correctly

LOW CONFIDENCE (0.00) -- do NOT bid on:
- Definitions: "What does 'necessary' mean?" (search agent)
- Grammar: "Should I use who or whom?" (not spelling)
- General knowledge: "Who invented the alphabet?" (search agent)
- Any request not about spelling a specific word`,

  async execute(task) {
    const content = task.content.toLowerCase();
    const word = extractWord(task.content);

    if (!word) {
      return {
        success: true,
        message: "I couldn't identify the word to spell. Try: \"How do you spell 'example'?\"",
      };
    }

    // Handle "is it X or Y" comparisons
    const orMatch = task.content.match(/is\s+it\s+([a-zA-Z]+)\s+or\s+([a-zA-Z]+)/i);
    if (orMatch) {
      const word1 = orMatch[1].toLowerCase();
      const word2 = orMatch[2].toLowerCase();
      const check1 = checkSpelling(word1);
      const check2 = checkSpelling(word2);
      if (check1.correct && !check2.correct) {
        return { success: true, message: 'The correct spelling is "' + word1 + '", not "' + word2 + '".' };
      } else if (!check1.correct && check2.correct) {
        return { success: true, message: 'The correct spelling is "' + word2 + '", not "' + word1 + '".' };
      } else if (check1.suggestion && !check2.suggestion) {
        return { success: true, message: 'The correct spelling is "' + word2 + '".' };
      } else if (!check1.suggestion && check2.suggestion) {
        return { success: true, message: 'The correct spelling is "' + word1 + '".' };
      } else {
        // Both seem valid or both misspelled -- spell the first
        return { success: true, message: '"' + word1 + '" is the standard spelling: ' + spellWord(word1) };
      }
    }

    // Check / correct spelling
    if (
      content.includes('correct') ||
      content.includes('right') ||
      content.includes('check') ||
      content.includes('is it')
    ) {
      const result = checkSpelling(word);
      if (result.correct) {
        return { success: true, message: 'Yes, "' + word + '" is spelled correctly.' };
      } else {
        return {
          success: true,
          message: result.suggestion
            ? '"' + word + '" is misspelled. The correct spelling is "' + result.suggestion + '".'
            : '"' + word + '" appears to be misspelled.',
        };
      }
    }

    // Default: spell out the word
    const spellCheck = checkSpelling(word);
    const correctWord = spellCheck.suggestion || word;
    const spelled = spellWord(correctWord);

    let message = correctWord.toUpperCase() + ': ' + spelled;
    if (spellCheck.suggestion) {
      message =
        'Note: "' +
        word +
        '" is commonly misspelled. The correct spelling is:\n' +
        correctWord.toUpperCase() +
        ': ' +
        spelled;
    }

    return { success: true, message };
  },
};

// Default export: standard built-in agent
module.exports = spellingAgent;

// Named exports for backward compatibility and testing
module.exports.createSpellingAgent = createSpellingAgent;
module.exports.extractWord = extractWord;
module.exports.spellWord = spellWord;
module.exports.checkSpelling = checkSpelling;
module.exports.COMMON_MISSPELLINGS = COMMON_MISSPELLINGS;
module.exports.SPELLING_KEYWORDS = SPELLING_KEYWORDS;
