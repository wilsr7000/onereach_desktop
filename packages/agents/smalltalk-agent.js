/**
 * Small Talk Agent - A Thinking Agent
 * 
 * Handles greetings, goodbyes, thanks, and basic conversational exchanges.
 * 
 * Thinking Agent features:
 * - Remembers user's name for personalized greetings
 * - Tracks conversation style preferences
 * - Learns from interactions to improve responses
 */

const { getAgentMemory } = require('../../lib/agent-memory-store');
const { learnFromInteraction, getTimeContext } = require('../../lib/thinking-agent');

const smalltalkAgent = {
  id: 'smalltalk-agent',
  name: 'Small Talk Agent',
  description: 'Handles greetings and casual conversation - remembers your name',
  categories: ['conversation', 'social'],
  keywords: [
    'hi', 'hello', 'hey', 'howdy', 'greetings',
    'good morning', 'good afternoon', 'good evening', 'good night',
    'bye', 'goodbye', 'see you', 'later', 'farewell',
    'thanks', 'thank you', 'appreciate',
    'how are you', "what's up", 'whats up', "how's it going",
    'sorry', 'my bad', 'apologies',
    'yes', 'no', 'okay', 'ok', 'sure', 'alright',
    'wow', 'cool', 'awesome', 'great', 'nice', 'amazing',
    'my name is', "i'm called", 'call me'
  ],
  
  // Memory instance
  memory: null,
  
  /**
   * Initialize memory
   */
  async initialize() {
    if (!this.memory) {
      this.memory = getAgentMemory('smalltalk-agent', { displayName: 'Small Talk Agent' });
      await this.memory.load();
      this._ensureMemorySections();
    }
    return this.memory;
  },
  
  /**
   * Ensure required memory sections exist
   */
  _ensureMemorySections() {
    const sections = this.memory.getSectionNames();
    
    if (!sections.includes('Learned Preferences')) {
      this.memory.updateSection('Learned Preferences', `- User Name: *Not set*
- Conversation Style: Friendly
- Formality: Casual`);
    }
    
    if (!sections.includes('Conversation Notes')) {
      this.memory.updateSection('Conversation Notes', `*Notes about conversations will appear here*`);
    }
    
    if (this.memory.isDirty()) {
      this.memory.save();
    }
  },
  
  /**
   * Bid on a task
   */
  bid(task) {
    if (!task?.content) return null;
    
    const lower = task.content.toLowerCase().trim();
    
    // Name introduction - high confidence
    if (/my name is|i'm called|call me|i am (\w+)/i.test(lower)) {
      return { confidence: 0.98, reasoning: 'Name introduction' };
    }
    
    // Very short greetings - high confidence
    if (/^(hi|hey|hello|yo|howdy|hiya)[\s!.,?]*$/i.test(lower)) {
      return { confidence: 0.98, reasoning: 'Greeting' };
    }
    
    // Good morning/afternoon/evening/night
    if (/^good\s+(morning|afternoon|evening|night)[\s!.,?]*$/i.test(lower)) {
      return { confidence: 0.98, reasoning: 'Time greeting' };
    }
    
    // Goodbyes
    if (/^(bye|goodbye|see you|later|farewell|take care|goodnight)[\s!.,?]*$/i.test(lower)) {
      return { confidence: 0.98, reasoning: 'Goodbye' };
    }
    
    // Thanks
    if (/^(thanks|thank you|thx|ty|appreciate)[\s!.,?]*$/i.test(lower)) {
      return { confidence: 0.98, reasoning: 'Thanks' };
    }
    
    // How are you
    if (/how are you|how('s| is) it going|what'?s up|how('s| is) everything/i.test(lower)) {
      return { confidence: 0.95, reasoning: 'How are you' };
    }
    
    // Affirmative/negative responses
    if (/^(yes|no|yeah|nope|yep|nah|sure|okay|ok|alright|fine)[\s!.,?]*$/i.test(lower)) {
      return { confidence: 0.85, reasoning: 'Affirmative/negative' };
    }
    
    // Reactions
    if (/^(wow|cool|awesome|great|nice|amazing|neat|sweet|perfect)[\s!.,?]*$/i.test(lower)) {
      return { confidence: 0.85, reasoning: 'Reaction' };
    }
    
    // Apologies
    if (/^(sorry|my bad|apologies|oops)[\s!.,?]*$/i.test(lower)) {
      return { confidence: 0.90, reasoning: 'Apology' };
    }
    
    // Check for keywords in longer phrases
    for (const keyword of this.keywords) {
      if (lower.includes(keyword)) {
        return { confidence: 0.7, reasoning: 'Keyword match' };
      }
    }
    
    return null;
  },
  
  /**
   * Execute the task
   */
  async execute(task, context = {}) {
    // Initialize memory
    if (!this.memory) {
      await this.initialize();
    }
    
    const lower = task.content.toLowerCase().trim();
    const prefs = this.memory.parseSectionAsKeyValue('Learned Preferences') || {};
    const userName = prefs['User Name'];
    const hasName = userName && userName !== '*Not set*';
    const timeContext = getTimeContext();
    
    // Handle name introduction
    const nameMatch = task.content.match(/(?:my name is|i'm called|call me|i am)\s+(\w+)/i);
    if (nameMatch) {
      const name = nameMatch[1];
      await learnFromInteraction(this.memory, task, { success: true }, {
        learnedPreferences: { 'User Name': name }
      });
      return { 
        success: true, 
        message: `Nice to meet you, ${name}! I'll remember that.` 
      };
    }
    
    // Greetings with personalization
    if (/^(hi|hey|hello|yo|howdy|hiya)[\s!.,?]*$/i.test(lower)) {
      const greeting = hasName 
        ? this.randomPick([
            `Hey ${userName}! How can I help you?`,
            `Hello ${userName}! What can I do for you?`,
            `Hi ${userName}! I'm here to help.`
          ])
        : this.randomPick([
            "Hey there! How can I help you?",
            "Hello! What can I do for you?",
            "Hi! I'm here to help."
          ]);
      return { success: true, message: greeting };
    }
    
    // Time-based greetings
    if (/good morning/i.test(lower)) {
      const greeting = hasName
        ? `Good morning, ${userName}! How can I help you today?`
        : "Good morning! How can I help you today?";
      return { success: true, message: greeting };
    }
    
    if (/good afternoon/i.test(lower)) {
      const greeting = hasName
        ? `Good afternoon, ${userName}! How can I help?`
        : "Good afternoon! How can I help?";
      return { success: true, message: greeting };
    }
    
    if (/good evening/i.test(lower)) {
      const greeting = hasName
        ? `Good evening, ${userName}! How can I help you?`
        : "Good evening! How can I help you?";
      return { success: true, message: greeting };
    }
    
    if (/good night/i.test(lower)) {
      const farewell = hasName
        ? `Good night, ${userName}! Sleep well.`
        : "Good night! Sleep well.";
      return { success: true, message: farewell };
    }
    
    // Goodbyes
    if (/bye|goodbye|see you|later|farewell|take care/i.test(lower)) {
      const farewell = hasName
        ? this.randomPick([
            `Goodbye, ${userName}! Have a great ${timeContext.partOfDay}!`,
            `See you later, ${userName}!`,
            `Take care, ${userName}!`
          ])
        : this.randomPick([
            `Goodbye! Have a great ${timeContext.partOfDay}!`,
            "See you later!",
            "Take care!"
          ]);
      return { success: true, message: farewell };
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
      const response = hasName
        ? `I'm doing well, ${userName}! How can I help you?`
        : "I'm doing well, thanks for asking! How can I help you?";
      return { success: true, message: response };
    }
    
    // Affirmative responses
    if (/^(yes|yeah|yep|sure|okay|ok|alright|fine)[\s!.,?]*$/i.test(lower)) {
      return this.randomResponse([
        "Great! What would you like me to do?",
        "Alright! How can I help?",
        "Okay! What's next?"
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
    if (/^(wow|cool|awesome|great|nice|amazing|neat|sweet|perfect)[\s!.,?]*$/i.test(lower)) {
      return this.randomResponse([
        "Glad you think so!",
        "Thanks! Anything else I can help with?",
        "Happy to hear that!"
      ]);
    }
    
    // Apologies
    if (/sorry|my bad|apologies|oops/i.test(lower)) {
      return this.randomResponse([
        "No worries at all!",
        "That's okay! How can I help?",
        "No problem! What do you need?"
      ]);
    }
    
    // Fallback
    return this.randomResponse([
      "I'm here to help! Just let me know what you need.",
      "How can I assist you?",
      "What can I do for you?"
    ]);
  },
  
  /**
   * Pick a random item from array
   */
  randomPick(items) {
    return items[Math.floor(Math.random() * items.length)];
  },
  
  /**
   * Return a random response from an array
   */
  randomResponse(responses) {
    const message = this.randomPick(responses);
    return { success: true, message };
  }
};

module.exports = smalltalkAgent;
