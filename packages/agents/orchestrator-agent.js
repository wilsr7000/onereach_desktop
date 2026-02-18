/**
 * Orchestrator Agent - Meta-agent for composite requests
 *
 * Detects when multiple agents could help with a request and coordinates them.
 * Example: "Cheer me up" → Smalltalk offers encouragement + DJ plays upbeat music
 */

const smalltalkAgent = require('./smalltalk-agent');
const djAgent = require('./dj-agent');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

/**
 * Composite request patterns and which agents can help
 */
const COMPOSITE_PATTERNS = [
  {
    name: 'cheer_up',
    patterns: [
      /cheer me up/i,
      /feeling (down|sad|blue)/i,
      /having a (bad|rough|tough) day/i,
      /need (cheering|some cheer)/i,
    ],
    agents: ['smalltalk', 'dj'],
    intro: 'Let me help brighten your day!',
    djContext: { mood: 'happy', energy: 'upbeat' },
  },
  {
    name: 'relax',
    patterns: [/help me relax/i, /feeling (stressed|anxious|overwhelmed)/i, /need to (calm down|unwind|de-?stress)/i],
    agents: ['smalltalk', 'dj'],
    intro: "Let's help you unwind.",
    djContext: { mood: 'calm', energy: 'low' },
  },
  {
    name: 'focus',
    patterns: [/help me (focus|concentrate)/i, /need to (work|study|get things done)/i, /focus mode/i],
    agents: ['smalltalk', 'dj'],
    intro: "Let's get you in the zone.",
    djContext: { mood: 'focus', energy: 'medium' },
  },
  {
    name: 'energy',
    patterns: [/need energy/i, /pump me up/i, /wake me up/i, /feeling (tired|sleepy|sluggish)/i, /get me going/i],
    agents: ['smalltalk', 'dj'],
    intro: "Let's get you energized!",
    djContext: { mood: 'energetic', energy: 'high' },
  },
  {
    name: 'celebrate',
    patterns: [/let's celebrate/i, /feeling (great|amazing|awesome)/i, /good news/i, /i did it/i, /party time/i],
    agents: ['smalltalk', 'dj'],
    intro: "That's awesome! Let's celebrate!",
    djContext: { mood: 'party', energy: 'high' },
  },
  {
    name: 'wind_down',
    patterns: [/wind down/i, /end of (the )?day/i, /time (for|to) (bed|sleep)/i, /getting late/i],
    agents: ['smalltalk', 'dj'],
    intro: "Let's help you wind down.",
    djContext: { mood: 'sleepy', energy: 'very low' },
  },
];

const orchestratorAgent = {
  id: 'orchestrator-agent',
  name: 'Orchestrator',
  description: 'Coordinates multiple agents for composite requests',
  voice: 'sage', // Wise, coordinating - see VOICE-GUIDE.md
  categories: ['meta', 'coordination', 'mood', 'emotional'],

  // Prompt for LLM evaluation
  prompt: `Orchestrator Agent coordinates multiple agents for complex composite requests.

HIGH CONFIDENCE (0.85+) for:
- Composite mood requests: "I need to relax" (coordinates DJ + Smalltalk)
- Multi-part requests: "Check my calendar and play some focus music"
- Emotional support with actions: "I'm stressed, help me unwind"

LOW CONFIDENCE (0.00-0.20) - DO NOT BID on these:
- Single-purpose requests that one agent can handle alone:
  - "What time is it?" (time agent)
  - "Play jazz music" (DJ agent)
  - "What's on my calendar?" (calendar agent)
  - "Hello" (smalltalk agent)

This agent ONLY bids when a request clearly requires coordination between multiple agents. For simple single-purpose requests, let the specialized agent handle it directly.`,

  keywords: [
    'cheer me up',
    'feeling down',
    'feeling sad',
    'bad day',
    'rough day',
    'help me relax',
    'feeling stressed',
    'feeling anxious',
    'calm down',
    'help me focus',
    'need to concentrate',
    'focus mode',
    'need energy',
    'pump me up',
    'wake me up',
    'feeling tired',
    'celebrate',
    'good news',
    'party time',
    'wind down',
    'end of day',
    'time for bed',
  ],
  executionType: 'system', // Meta-coordination agent (being repurposed for task decomposition)

  // Acknowledgments
  acks: ["I've got just the thing.", 'Let me take care of that.', 'On it!', 'I know exactly what you need.'],

  /**
   * Detect if this is a composite request
   */
  _detectComposite(text) {
    const lower = text.toLowerCase();

    for (const pattern of COMPOSITE_PATTERNS) {
      for (const regex of pattern.patterns) {
        if (regex.test(lower)) {
          return pattern;
        }
      }
    }

    return null;
  },

  // No bid() method. Routing is 100% LLM-based via unified-bidder.js.
  // NEVER add keyword/regex bidding here. See .cursorrules.

  /**
   * Execute by coordinating multiple agents
   */
  async execute(task, context = {}) {
    const composite = this._detectComposite(task.content);

    if (!composite) {
      return { success: false, message: "I'm not sure how to help with that." };
    }

    log.info('agent', `Handling composite request: ${composite.name}`);
    log.info('agent', `Will coordinate: ${composite.agents.join(', ')}`);

    const results = [];
    const messages = [];

    // Start with intro
    messages.push(composite.intro);

    // Execute each agent
    for (const agentName of composite.agents) {
      try {
        if (agentName === 'smalltalk') {
          // Initialize smalltalk if needed
          if (smalltalkAgent.initialize) {
            await smalltalkAgent.initialize();
          }

          // Get encouragement from smalltalk
          const result = await smalltalkAgent.execute(task, context);
          if (result.success && result.message) {
            results.push({ agent: 'smalltalk', result });
            messages.push(result.message);
          }
        } else if (agentName === 'dj') {
          // Initialize DJ if needed
          if (djAgent.initialize) {
            await djAgent.initialize();
          }

          // Create a music-focused task for DJ
          const djTask = {
            ...task,
            content: this._buildDJRequest(composite.djContext),
            context: {
              ...task.context,
              orchestrated: true,
              moodContext: composite.djContext,
            },
          };

          const result = await djAgent.execute(djTask, context);
          if (result.success && result.message) {
            results.push({ agent: 'dj', result });
            // DJ's message about what's playing
            messages.push(result.message);
          }
        }
      } catch (error) {
        log.error('agent', `Error executing ${agentName}`, { error: error.message });
      }
    }

    // Combine messages into a cohesive response
    // First message is the intro, spoken first
    // Subsequent messages follow naturally
    const combinedMessage =
      messages.length > 1 ? messages[0] + ' ' + messages.slice(1).join(' ') : messages[0] || "I'm working on it!";

    return {
      success: true,
      message: combinedMessage,
      orchestrated: true,
      agentsUsed: composite.agents,
      results,
    };
  },

  /**
   * Build a natural DJ request based on mood context
   */
  _buildDJRequest(djContext) {
    const { mood, _energy } = djContext;

    const requests = {
      happy: 'play something upbeat and happy',
      calm: 'play something calm and relaxing',
      focus: 'play some focus music, maybe lo-fi or ambient',
      energetic: 'play something energetic to pump me up',
      party: 'play some party music, something fun',
      sleepy: 'play something soft and peaceful for winding down',
    };

    return requests[mood] || 'play some music';
  },
};

module.exports = orchestratorAgent;
