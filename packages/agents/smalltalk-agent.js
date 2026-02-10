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
const ai = require('../../lib/ai-service');

const smalltalkAgent = {
  id: 'smalltalk-agent',
  name: 'Small Talk Agent',
  description: 'Handles greetings and casual conversation - remembers your name',
  voice: 'coral',  // Clear, welcoming - see VOICE-GUIDE.md
  categories: ['conversation', 'social', 'mood', 'emotional'],
  
  // Prompt for LLM evaluation
  prompt: `Small Talk Agent handles greetings, farewells, and casual social conversation.

HIGH CONFIDENCE (0.85+) for:
- Greetings: "Hi", "Hello", "Hey", "Good morning", "Good afternoon"
- Farewells: "Bye", "Goodbye", "See you later", "Goodnight"
- Thanks: "Thank you", "Thanks", "Appreciate it"
- How are you: "How are you?", "How's it going?", "What's up?"
- Name introductions: "My name is...", "Call me..."
- Simple reactions: "Cool", "Awesome", "Nice", "Great"
- Emotional support: "I'm feeling down", "Cheer me up"
- Fun/casual requests: "Tell me a joke", "Say something funny", "Make me laugh"
- Compliments: "You're great", "Good job"
- Chitchat: "What do you think about...", "Do you like..."

LOW CONFIDENCE (0.00-0.20) - DO NOT BID on these:
- Action requests: "Play music", "What's the weather?"
- Calendar queries: "What do I have on Tuesday?"
- Time queries: "What time is it?"
- Knowledge questions: "Who invented the telephone?" (search agent)
- Questions about schedules, events, or tasks

This agent handles casual social conversation and light entertainment. Any request for factual information, app actions, or tasks should go to other agents.

HALLUCINATION GUARD:
NEVER state facts that are not in your context window.
You do NOT know the current time, date, day of week, weather, calendar events, or any real-world data.
If someone asks a factual question (time, date, weather, schedule, news), do NOT guess.
Instead bid 0.00 so the correct agent handles it.
The ONLY facts you may state are those present in the conversation history or user profile provided in your context. Everything else is a guess and will damage user trust.`,
  
  keywords: [
    'hi', 'hello', 'hey', 'howdy', 'greetings',
    'good morning', 'good afternoon', 'good evening', 'good night',
    'bye', 'goodbye', 'see you', 'later', 'farewell',
    'thanks', 'thank you', 'appreciate',
    'how are you', "what's up", 'whats up', "how's it going",
    'sorry', 'my bad', 'apologies',
    'yes', 'no', 'okay', 'ok', 'sure', 'alright',
    'wow', 'cool', 'awesome', 'great', 'nice', 'amazing',
    'my name is', "i'm called", 'call me',
    'your name', 'who are you', 'what are you',  // Asking assistant's identity
    // Emotional support - smalltalk can offer encouragement
    'cheer me up', 'feeling down', 'feeling sad', 'feeling lonely', 'feeling stressed',
    'need encouragement', 'having a bad day', 'rough day', 'tough day',
    'feeling anxious', 'feeling worried', 'feeling overwhelmed'
  ],
  executionType: 'informational',  // Pure conversation, no side effects -- can fast-path in bid
  
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
   * Check if input looks like gibberish/unclear speech
   */
  _isUnclearInput(text) {
    const lower = text.toLowerCase().trim();
    const stripped = lower.replace(/[.,!?;:'"]/g, '').trim();
    
    // Very short unclear sounds
    if (/^(um+|uh+|hm+|ah+|oh+|eh+|er+|mm+)h*$/i.test(stripped)) return true;
    
    // Repeated characters (like "aaaah" or "mmmm")
    if (/^(.)\1{2,}$/i.test(stripped)) return true;
    
    // Very short (1-2 chars) after stripping punctuation
    if (stripped.length <= 2) return true;
    
    // Single filler word
    const fillers = ['um', 'uh', 'hmm', 'hm', 'ah', 'oh', 'eh', 'er', 'mm', 'mhm'];
    if (fillers.includes(stripped)) return true;
    
    // Looks like random consonants (no vowels = probably noise)
    if (stripped.length > 3 && !/[aeiou]/i.test(stripped)) return true;
    
    // Random keyboard mash pattern
    if (/^[asdfghjklqwertyuiopzxcvbnm]{5,}$/i.test(stripped) && !/[aeiou]{2}/i.test(stripped)) return true;
    
    return false;
  },
  
  // No bid() method. Routing is 100% LLM-based via unified-bidder.js.
  // NEVER add keyword/regex bidding here. See .cursorrules.
  
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
    
    // Handle "what's your name" - asking the assistant's name
    if (/what('?s| is) your name|who are you|what are you called|what should i call you/i.test(lower)) {
      return this.randomResponse([
        "I'm your voice assistant! You can call me whatever you like.",
        "I don't have a specific name, but I'm here to help you with tasks, answer questions, and keep you company.",
        "I'm your AI assistant. Some people give me nicknames - feel free to call me whatever works for you!",
        "I'm the voice assistant built into this app. What can I help you with?"
      ]);
    }
    
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
    
    // Emotional support - offer encouragement
    if (/cheer me up|feeling (down|sad|lonely|stressed|anxious|worried|overwhelmed)|bad day|rough day|tough day|need encouragement/i.test(lower)) {
      const encouragements = hasName ? [
        `Hey ${userName}, I'm sorry you're feeling that way. You've got this!`,
        `${userName}, tough times don't last, but tough people do. I'm here for you.`,
        `I hear you, ${userName}. Take a deep breath. Things will get better.`,
        `${userName}, it's okay to have hard days. You're doing great just by keeping going.`,
        `Sending good vibes your way, ${userName}. You've handled hard things before!`
      ] : [
        "I'm sorry you're feeling that way. You've got this!",
        "Tough times don't last, but tough people do. I'm here for you.",
        "Take a deep breath. Things will get better.",
        "It's okay to have hard days. You're doing great just by keeping going.",
        "Sending good vibes your way. You've handled hard things before!",
        "Hey, everyone has rough patches. Tomorrow's a new day!",
        "I believe in you. Whatever you're facing, you can handle it."
      ];
      return this.randomResponse(encouragements);
    }
    
    // Unclear/gibberish input - respond naturally
    if (this._isUnclearInput(task.content)) {
      return this.randomResponse([
        "Hmm?",
        "Sorry, I didn't catch that.",
        "Come again?",
        "What was that?",
        "I'm not sure I understood.",
        "Could you say that again?",
        "Hmm, what's that?"
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
