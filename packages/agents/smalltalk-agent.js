/**
 * Small Talk Agent
 * 
 * Handles greetings, goodbyes, thanks, and basic conversational exchanges.
 * Provides friendly, natural responses to make the assistant feel more human.
 */

const smalltalkAgent = {
  id: 'smalltalk-agent',
  name: 'Small Talk Agent',
  description: 'Handles greetings and casual conversation',
  categories: ['conversation', 'social'],
  keywords: [
    'hi', 'hello', 'hey', 'howdy', 'greetings',
    'good morning', 'good afternoon', 'good evening', 'good night',
    'bye', 'goodbye', 'see you', 'later', 'farewell',
    'thanks', 'thank you', 'appreciate',
    'how are you', "what's up", 'whats up', "how's it going", 'hows it going',
    'nice to meet', 'pleased to meet',
    'sorry', 'my bad', 'apologies',
    'yes', 'no', 'okay', 'ok', 'sure', 'alright', 'yep', 'nope',
    'wow', 'cool', 'awesome', 'great', 'nice', 'amazing'
  ],
  
  /**
   * Bid on a task
   * @param {Object} task - { content, ... }
   * @returns {Object|null} - { confidence } or null to not bid
   */
  bid(task) {
    if (!task?.content) return null;
    
    const lower = task.content.toLowerCase().trim();
    
    // Very short greetings - high confidence
    if (/^(hi|hey|hello|yo|howdy|hiya)[\s!.,?]*$/i.test(lower)) {
      return { confidence: 0.98 };
    }
    
    // Good morning/afternoon/evening/night
    if (/^good\s+(morning|afternoon|evening|night)[\s!.,?]*$/i.test(lower)) {
      return { confidence: 0.98 };
    }
    
    // Goodbyes
    if (/^(bye|goodbye|see you|later|farewell|take care|goodnight)[\s!.,?]*$/i.test(lower) ||
        /^(see you later|catch you later|talk to you later)[\s!.,?]*$/i.test(lower)) {
      return { confidence: 0.98 };
    }
    
    // Thanks
    if (/^(thanks|thank you|thx|ty|appreciate it|much appreciated)[\s!.,?]*$/i.test(lower)) {
      return { confidence: 0.98 };
    }
    
    // How are you variants
    if (/how are you|how('s| is) it going|what'?s up|how('s| is) everything|how('s| is) your day/i.test(lower)) {
      return { confidence: 0.95 };
    }
    
    // Affirmative/negative responses
    if (/^(yes|no|yeah|nope|yep|nah|sure|okay|ok|alright|fine|got it)[\s!.,?]*$/i.test(lower)) {
      return { confidence: 0.85 };
    }
    
    // Reactions
    if (/^(wow|cool|awesome|great|nice|amazing|neat|sweet|perfect|wonderful)[\s!.,?]*$/i.test(lower)) {
      return { confidence: 0.85 };
    }
    
    // Apologies
    if (/^(sorry|my bad|apologies|oops|whoops)[\s!.,?]*$/i.test(lower)) {
      return { confidence: 0.90 };
    }
    
    // Check for keywords in longer phrases
    for (const keyword of this.keywords) {
      if (lower.includes(keyword)) {
        return { confidence: 0.7 };
      }
    }
    
    return null;
  },
  
  /**
   * Execute the task
   * @param {Object} task - { content, context, ... }
   * @returns {Object} - { success, message }
   */
  async execute(task, context = {}) {
    const lower = task.content.toLowerCase().trim();
    
    // Greetings
    if (/^(hi|hey|hello|yo|howdy|hiya)[\s!.,?]*$/i.test(lower)) {
      return this.randomResponse([
        "Hey there! How can I help you?",
        "Hello! What can I do for you?",
        "Hi! I'm here to help.",
        "Hey! What's on your mind?"
      ]);
    }
    
    // Time-based greetings
    if (/good morning/i.test(lower)) {
      return this.randomResponse([
        "Good morning! How can I help you today?",
        "Morning! What can I do for you?",
        "Good morning! Ready to help."
      ]);
    }
    
    if (/good afternoon/i.test(lower)) {
      return this.randomResponse([
        "Good afternoon! How can I help?",
        "Afternoon! What can I do for you?",
        "Good afternoon! What do you need?"
      ]);
    }
    
    if (/good evening/i.test(lower)) {
      return this.randomResponse([
        "Good evening! How can I help you?",
        "Evening! What can I do for you?",
        "Good evening! I'm here to help."
      ]);
    }
    
    if (/good night/i.test(lower)) {
      return this.randomResponse([
        "Good night! Sleep well.",
        "Night! Take care.",
        "Good night! See you tomorrow."
      ]);
    }
    
    // Goodbyes
    if (/bye|goodbye|see you|later|farewell|take care/i.test(lower)) {
      return this.randomResponse([
        "Goodbye! Have a great day!",
        "See you later!",
        "Take care! Come back anytime.",
        "Bye! Let me know if you need anything else."
      ]);
    }
    
    // Thanks
    if (/thanks|thank you|thx|ty|appreciate/i.test(lower)) {
      return this.randomResponse([
        "You're welcome!",
        "Happy to help!",
        "Anytime!",
        "No problem!",
        "Glad I could help!"
      ]);
    }
    
    // How are you
    if (/how are you|how('s| is) it going|what'?s up|how('s| is) everything/i.test(lower)) {
      return this.randomResponse([
        "I'm doing well, thanks for asking! How can I help you?",
        "All good here! What can I do for you?",
        "I'm great! Ready to help. What do you need?",
        "Doing fine! What's on your mind?"
      ]);
    }
    
    // Affirmative responses
    if (/^(yes|yeah|yep|sure|okay|ok|alright|fine|got it)[\s!.,?]*$/i.test(lower)) {
      return this.randomResponse([
        "Great! What would you like me to do?",
        "Alright! How can I help?",
        "Okay! What's next?",
        "Got it. What do you need?"
      ]);
    }
    
    // Negative responses
    if (/^(no|nope|nah)[\s!.,?]*$/i.test(lower)) {
      return this.randomResponse([
        "No problem. Let me know if you need anything.",
        "Okay. I'm here if you change your mind.",
        "Alright. Just say the word when you need help."
      ]);
    }
    
    // Reactions
    if (/^(wow|cool|awesome|great|nice|amazing|neat|sweet|perfect|wonderful)[\s!.,?]*$/i.test(lower)) {
      return this.randomResponse([
        "Glad you think so!",
        "Thanks! Anything else I can help with?",
        "Happy to hear that! What else can I do?"
      ]);
    }
    
    // Apologies
    if (/sorry|my bad|apologies|oops|whoops/i.test(lower)) {
      return this.randomResponse([
        "No worries at all!",
        "That's okay! How can I help?",
        "No problem! What do you need?"
      ]);
    }
    
    // Fallback for other small talk
    return this.randomResponse([
      "I'm here to help! Just let me know what you need.",
      "How can I assist you?",
      "What can I do for you?"
    ]);
  },
  
  /**
   * Return a random response from an array
   * @param {string[]} responses 
   * @returns {Object} - { success, message }
   */
  randomResponse(responses) {
    const message = responses[Math.floor(Math.random() * responses.length)];
    return { success: true, message };
  }
};

module.exports = smalltalkAgent;
