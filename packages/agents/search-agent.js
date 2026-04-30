/**
 * Search Agent - A Thinking Agent
 *
 * Handles informational queries by searching the web.
 * Can answer questions about weather, current events, facts, definitions, etc.
 *
 * Uses GSX Search Serper API as primary method (structured Google results).
 * Falls back to webview-based search, then DuckDuckGo API.
 * Uses Omni Data Agent for context (location, preferences, etc.)
 *
 * Thinking Agent features:
 * - Remembers recent searches
 * - Tracks preferred sources
 * - Learns from search results quality
 */

const { getCircuit } = require('./circuit-breaker');
const { getAgentMemory } = require('../../lib/agent-memory-store');
const omniData = require('./omni-data-agent');
const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

// Lazy-load webview search service (only available in main process)
let webviewSearchService = null;
function getWebviewSearch() {
  if (webviewSearchService === null) {
    try {
      webviewSearchService = require('./webview-search-service');
    } catch (e) {
      log.info('agent', 'Webview search not available', { error: e.message });
      webviewSearchService = false; // Mark as unavailable
    }
  }
  return webviewSearchService || null;
}

// Circuit breaker for web requests
const webCircuit = getCircuit('web-search', {
  failureThreshold: 3,
  resetTimeout: 30000,
  windowMs: 60000,
});

// GSX Search Serper API (primary search method)
const GSX_SEARCH_BASE = 'https://em.edison.api.onereach.ai/http/35254342-4a2e-475b-aec1-18547e517e29';
const GSX_SEARCH_PATH = '/gsx-search';

// Timeout constants
const TIMEOUT_GSX_SEARCH = 10000; // 10 seconds for GSX Serper API
const TIMEOUT_WEB_SEARCH = 8000; // 8 seconds for webview fallback
const TIMEOUT_WEB_SEARCH_LITE = 10000; // 10 seconds for DDG fallback
const _TIMEOUT_LLM = 15000; // 15 seconds for LLM synthesis
const TIMEOUT_OVERALL = 25000; // 25 seconds max (increased for GSX API)

// Use centralized HTTP client for timeout, circuit breaker, and retry
const httpClient = require('../../lib/http-client');

/**
 * Fetch with timeout -- delegates to the centralized http-client.
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  return httpClient.fetch(url, { ...options, timeoutMs });
}

// Keywords that suggest an informational/search query
const SEARCH_KEYWORDS = [
  // Weather
  'weather',
  'temperature',
  'forecast',
  'rain',
  'snow',
  'sunny',
  'cloudy',
  'humid',
  'cold',
  'hot',
  'warm',
  // General knowledge
  'what is',
  'who is',
  'where is',
  'when did',
  'how does',
  'why does',
  'define',
  'meaning of',
  // Current events
  'news',
  'latest',
  'current',
  'today',
  'recent',
  'update',
  // Facts and information
  'how many',
  'how much',
  'how far',
  'how long',
  'how old',
  'how tall',
  // Lookups
  'search',
  'find',
  'look up',
  'google',
  'search for',
];

// Exclude keywords (these should go to other agents)
const _EXCLUDE_KEYWORDS = [
  'play',
  'pause',
  'stop',
  'skip',
  'volume',
  'music',
  'song', // media
  'help',
  'commands',
  'what can you do', // help
  // Note: time/date excluded only when NOT combined with weather/events
];

const searchAgent = {
  id: 'search-agent',
  name: 'Search Agent',
  description:
    'Searches the web for any query requiring external information - podcasts, people, companies, facts, news, definitions',
  voice: 'echo', // Authoritative, knowledgeable - see VOICE-GUIDE.md
  acks: ['Let me look that up.', 'Searching now.'],
  categories: ['search', 'information', 'knowledge'],

  // Prompt for LLM evaluation
  prompt: `Search Agent finds information from the internet for any query requiring external or current knowledge.

Capabilities:
- Look up information about people, companies, products, places, concepts
- Find current news, prices, scores, and events
- Answer factual questions that require web search
- Research topics the user wants to learn about
- Verify facts and provide source-backed answers

This agent searches the internet. It provides information but does not control apps or access personal data.`,
  keywords: SEARCH_KEYWORDS,
  executionType: 'action', // Needs web search API for data

  // Memory instance
  memory: null,

  /**
   * Initialize memory
   */
  async initialize() {
    if (!this.memory) {
      this.memory = getAgentMemory('search-agent', { displayName: 'Search Agent' });
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
      this.memory.updateSection(
        'Learned Preferences',
        `- Preferred Sources: Any
- Detail Level: Concise
- Include Sources: No`
      );
    }

    if (!sections.includes('Recent Searches')) {
      this.memory.updateSection('Recent Searches', `*Your recent searches will appear here*`);
    }

    if (this.memory.isDirty()) {
      this.memory.save();
    }
  },

  // No bid() method. Routing is 100% LLM-based via unified-bidder.js.
  // NEVER add keyword/regex bidding here. See .cursorrules.

  /**
   * Execute the task with overall timeout protection
   * @param {Object} task - { content, context, ... }
   * @param {Object} context - { onProgress, ... }
   * @returns {Object} - { success, message }
   */
  async execute(task, context = {}) {
    // Wrap execution with overall timeout to prevent hanging
    return Promise.race([
      this._executeInternal(task, context),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Search timed out')), TIMEOUT_OVERALL);
      }),
    ]).catch((error) => {
      log.error('agent', 'Overall timeout or error', { error: error.message });
      return {
        success: false,
        message: "I'm having trouble searching right now. Please try again.",
      };
    });
  },

  /**
   * Internal execute implementation
   * @param {Object} task - { content, context, ... }
   * @param {Object} context - { onProgress, ... }
   * @returns {Object} - { success, message }
   */
  async _executeInternal(task, context = {}) {
    // Initialize memory
    if (!this.memory) {
      await this.initialize();
    }

    let query = task.content || '';
    const { onProgress = () => {} } = context;
    const action = task.data?.action || task.action;

    log.info('agent', `Searching for: "${query}" (action: ${action || 'web_search'})`);

    // Track search in memory
    try {
      const timestamp = new Date().toISOString().split('T')[0];
      this.memory.appendToSection('Recent Searches', `- ${timestamp}: "${query.slice(0, 50)}..."`, 20);
      await this.memory.save();
    } catch (_e) {
      // Non-fatal, continue with search
    }

    try {
      // Step 0: Pull context from Omni Data Agent
      onProgress('Getting context...');
      const relevantContext = await omniData.getRelevantContext(task, {
        id: this.id,
        name: this.name,
        description: this.description,
      });

      // Handle user_info action - answer from context, no web search
      if (action === 'user_info' || this.isUserInfoQuery(query)) {
        log.info('agent', 'Handling user info query from context');
        const allContext = await omniData.getAll();
        const profile = await omniData.getAgentProfile();

        return this.answerUserInfoQuery(query, allContext, profile);
      }

      // Enhance location-sensitive queries with the user's live location.
      // Previously this only applied to weather; now any "nearby/near me/
      // around here/local" query that doesn't already name a place gets
      // the user's current city appended. This is exactly the class of
      // question ("where's good coffee around here?") that used to return
      // empty results because the agent didn't know where the user was.
      const locCtx = relevantContext.location;
      const needsLocation =
        !this.hasLocation(query) &&
        (this.isWeatherQuery(query) || this._isImplicitlyLocal(query));

      if (needsLocation && locCtx?.city) {
        const locationStr = locCtx.region || locCtx.state
          ? `${locCtx.city}, ${locCtx.region || locCtx.state}`
          : locCtx.city;
        query = `${query} in ${locationStr}`;
        log.info('agent', `Enhanced query with live location: "${query}"`, {
          source: locCtx._locationSource,
          ageMs: locCtx._locationAgeMs,
        });
      } else if (needsLocation && !locCtx?.city) {
        // Implicitly-local query, but we have no location at all. Instead
        // of returning "I don't know" after an empty search -- the old
        // behavior that caused the coffee-shop-in-Berkeley incident -- ask
        // the user where they are. The orb will hear the question, open
        // the mic via the awaitingInput state, and the Search Agent will
        // re-run with the city supplied.
        //
        // IMPORTANT: `message` and `needsInput.prompt` must be identical.
        // Different strings cause the text-chat panel (reads `message`)
        // and the TTS (speaks `needsInput.prompt`) to diverge -- user
        // reads one thing and hears another.
        log.info('agent', 'Implicit-local query without location; asking user');
        const askCityPrompt = 'What city are you in? I can find results near you once I know.';
        return {
          success: true,
          message: askCityPrompt,
          needsInput: {
            agentId: this.id,
            prompt: askCityPrompt,
            field: 'city',
            context: { originalQuery: task.content || query, savedQuery: query },
          },
        };
      }

      // Step 1: Try web search first
      onProgress('Searching the web...');
      let searchResults = [];
      try {
        searchResults = await this.webSearch(query);
        log.info('agent', `Found ${searchResults.length} search results`);
      } catch (e) {
        log.info('agent', `Web search failed: ${e.message}`);
      }

      // If the search returned nothing AND this is a local query that was
      // already enhanced with a city, there's a deeper problem (bad city,
      // search API down). Ask the user to clarify rather than synthesizing
      // a fake answer from nothing.
      if (
        searchResults.length === 0 &&
        (this._isImplicitlyLocal(task.content) || this.isWeatherQuery(task.content))
      ) {
        // Same invariant: keep `message` and `needsInput.prompt` identical
        // so the text panel and the spoken prompt match verbatim.
        log.info('agent', 'Local query returned empty search; asking user to rephrase');
        const narrowPrompt = "I couldn't find anything specific for that. Could you name a city or area?";
        return {
          success: true,
          message: narrowPrompt,
          needsInput: {
            agentId: this.id,
            prompt: narrowPrompt,
            field: 'query',
            context: { originalQuery: task.content || query },
          },
        };
      }

      // Step 2: Synthesize answer (with or without search results)
      onProgress(searchResults.length > 0 ? 'Analyzing results...' : 'Generating answer...');
      const answer = await this.synthesizeAnswer(query, searchResults);

      // Step 3: Lightweight in-band grounding check. Previously the
      // synthesis prompt allowed "general knowledge" answers when search
      // returned nothing or when the model ignored the snippets, which
      // opened a direct path to hallucination. Here we verify that the
      // synthesised answer overlaps meaningfully with the retrieved
      // content. If it doesn't, we flag the answer as possibly-ungrounded
      // so downstream (reflector + UI) can show appropriate uncertainty.
      const groundingHint = this._checkGrounding(answer, searchResults);

      return {
        success: true,
        message: answer,
        sources: searchResults
          .slice(0, 3)
          .map((r) => r.url)
          .filter((u) => u),
        // Data block is passed to the reflector so it can judge
        // groundedness against the actual evidence.
        data: {
          searchResults: searchResults.slice(0, 7).map((r) => ({
            title: r.title,
            snippet: r.snippet,
            url: r.url || r.link,
          })),
          groundingHint,
        },
      };
    } catch (error) {
      log.error('agent', 'Error', { error: error.message });
      return {
        success: false,
        message: `I had trouble with that question. ${error.message}`,
      };
    }
  },

  /**
   * Check if query is about the user's personal info
   */
  isUserInfoQuery(query) {
    const lower = query.toLowerCase();
    const userInfoPatterns = [
      'who am i',
      'what is my name',
      "what's my name",
      'my name',
      'where am i',
      'what city',
      'my location',
      'where do i live',
      'what apps',
      'my apps',
      'installed apps',
      'what software',
      'my computer',
      'my system',
      'what os',
      'my timezone',
      'my time zone',
      'about me',
      'tell me about myself',
    ];
    return userInfoPatterns.some((p) => lower.includes(p));
  },

  /**
   * Answer user info queries from Omni Data context
   */
  answerUserInfoQuery(query, context, _profile) {
    const lower = query.toLowerCase();

    // Who am I / my name - use raw content if available for rich response
    if (lower.includes('who am i') || lower.includes('my name') || lower.includes('about me')) {
      // If we have rich raw content, extract a summary
      if (context.rawContent && context.rawContent.length > 100) {
        // Extract first meaningful paragraph or identity statement
        const lines = context.rawContent.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
        const firstMeaningful = lines.find((l) => l.length > 20 && !l.startsWith('*') && !l.startsWith('-'));

        if (firstMeaningful) {
          // Clean it up and return
          let summary = firstMeaningful.replace(/\*\*/g, '').trim();
          if (summary.length > 200) {
            summary = summary.substring(0, 200) + '...';
          }
          return { success: true, message: summary };
        }
      }

      // Fallback to structured data
      const name = context.user?.name || context.user?.username || 'friend';
      const system = context.system?.os ? ` on ${context.system.os}` : '';
      const location = context.location?.city ? ` in ${context.location.city}` : '';
      const appsCount = context.apps?.length || 0;

      let response = `You're ${name}${location}${system}.`;
      if (appsCount > 0) {
        response += ` You have ${appsCount} apps installed.`;
      }

      return { success: true, message: response };
    }

    // Location queries
    if (lower.includes('where am i') || lower.includes('my location') || lower.includes('my city')) {
      if (context.location?.city) {
        const loc = context.location;
        const locationStr = [loc.city, loc.state, loc.country].filter(Boolean).join(', ');
        return { success: true, message: `You're in ${locationStr}.` };
      }
      return { success: true, message: "I don't have your location set. You can add it in the GSX Agent space." };
    }

    // Apps queries
    if (lower.includes('apps') || lower.includes('software') || lower.includes('installed')) {
      if (context.apps && context.apps.length > 0) {
        const topApps = context.apps.slice(0, 10).join(', ');
        const more = context.apps.length > 10 ? ` and ${context.apps.length - 10} more` : '';
        return { success: true, message: `You have ${context.apps.length} apps including: ${topApps}${more}.` };
      }
      return { success: true, message: "I don't have information about your installed apps." };
    }

    // System queries
    if (lower.includes('my computer') || lower.includes('my system') || lower.includes('what os')) {
      if (context.system) {
        const sys = context.system;
        return { success: true, message: `You're on ${sys.os} (${sys.arch}), hostname: ${sys.hostname}.` };
      }
      return { success: true, message: "I don't have your system information." };
    }

    // Timezone
    if (lower.includes('timezone') || lower.includes('time zone')) {
      if (context.timezone) {
        return { success: true, message: `Your timezone is ${context.timezone}.` };
      }
      return { success: true, message: "I don't have your timezone set." };
    }

    // Generic about me
    const parts = [];
    if (context.user?.name) parts.push(`Name: ${context.user.name}`);
    if (context.location?.city) parts.push(`Location: ${context.location.city}`);
    if (context.timezone) parts.push(`Timezone: ${context.timezone}`);
    if (context.system?.os) parts.push(`System: ${context.system.os}`);
    if (context.apps?.length) parts.push(`Apps: ${context.apps.length} installed`);

    if (parts.length > 0) {
      return { success: true, message: `Here's what I know about you: ${parts.join(', ')}.` };
    }

    return {
      success: true,
      message: "I don't have much information about you yet. You can add details in the GSX Agent space.",
    };
  },

  /**
   * Check if query is about weather
   */
  isWeatherQuery(query) {
    const weatherKeywords = [
      'weather',
      'temperature',
      'forecast',
      'rain',
      'snow',
      'sunny',
      'cloudy',
      'humid',
      'cold',
      'hot',
      'warm',
    ];
    const lower = query.toLowerCase();
    return weatherKeywords.some((k) => lower.includes(k));
  },

  /**
   * Check if query already contains a location
   */
  hasLocation(query) {
    // Check for common location patterns
    const locationPatterns = [
      /\bin\s+\w+/i, // "in Denver"
      /\bat\s+\w+/i, // "at Denver"
      /\bfor\s+\w+/i, // "for Denver"
      /\bnear\s+\w+/i, // "near Denver"
      /\b\d{5}\b/, // ZIP code
      /,\s*[A-Z]{2}\b/, // State abbreviation ", CO"
    ];
    return locationPatterns.some((p) => p.test(query));
  },

  /**
   * Cheap heuristic grounding check. Compares the synthesised answer's
   * content-word set against the union of search-result title+snippet
   * content words. Returns one of:
   *   'grounded'    -- enough overlap to trust the answer is result-backed
   *   'weak'        -- some overlap; treat with caution
   *   'ungrounded'  -- very little overlap; the answer may be fabricated
   *   'no-evidence' -- search returned nothing; answer comes from model prior
   *
   * Not a hard gate -- the reflector runs a proper LLM judge after the
   * user has already heard the answer. This hint is surfaced in the
   * result's `data` block and logs so downstream consumers can react
   * (e.g. the reflector can weight grounded-score lower).
   */
  _checkGrounding(answer, searchResults) {
    if (!answer) return 'no-evidence';
    if (!Array.isArray(searchResults) || searchResults.length === 0) {
      return 'no-evidence';
    }
    const STOPWORDS = new Set([
      'the','a','an','is','are','was','were','be','been','being','to','of','in',
      'on','at','by','for','with','and','or','but','if','then','so','that','this',
      'it','its','as','from','you','your','i','my','me','we','our','they','their',
      'here','there','what','which','who','how','why','when','where','can','will',
      'would','should','could','may','might','do','does','did','have','has','had',
      'not','no','yes','also','just','very','more','most','some','any','all','one',
      'two','three','also',
    ]);
    const tokens = (text) =>
      String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w));

    const answerTokens = new Set(tokens(answer));
    if (answerTokens.size === 0) return 'weak';

    const evidenceTokens = new Set();
    for (const r of searchResults) {
      tokens(`${r.title || ''} ${r.snippet || ''}`).forEach((w) => evidenceTokens.add(w));
    }
    if (evidenceTokens.size === 0) return 'no-evidence';

    let overlap = 0;
    for (const w of answerTokens) if (evidenceTokens.has(w)) overlap += 1;
    const ratio = overlap / answerTokens.size;
    // Thresholds chosen so short factual answers ("14 degrees") aren't
    // unfairly penalised -- they have few tokens but should mostly overlap.
    if (ratio >= 0.45) return 'grounded';
    if (ratio >= 0.2) return 'weak';
    return 'ungrounded';
  },

  /**
   * Detect queries that implicitly refer to "here" -- the user's current
   * location -- without naming a place. These benefit from being rewritten
   * with the live city so search returns results relevant to where the
   * user actually is, not to the agent's training data or a stale default.
   *
   * Examples that match:
   *   "coffee shops nearby"
   *   "find a good place for lunch around here"
   *   "closest pharmacy"
   *   "restaurants near me"
   *   "gyms in this area"
   *
   * Examples that do NOT match (already have a place, or aren't local):
   *   "coffee shops in Paris"
   *   "capital of France"
   *   "latest iPhone news"
   */
  _isImplicitlyLocal(query) {
    const lower = String(query || '').toLowerCase();
    const implicitPhrases = [
      'near me',
      'nearby',
      'near here',
      'around here',
      'around me',
      'in this area',
      'close by',
      'closest',
      'nearest',
      'local',
      'walk to',
      'walking distance',
      'drive to',
      'get to',
    ];
    if (implicitPhrases.some((p) => lower.includes(p))) return true;

    // "find/where/what/best ... <place-noun>" with no explicit city.
    const localNouns =
      /\b(restaurant|cafe|coffee|espresso|bar|pub|brewery|store|shop|grocery|market|pharmacy|drugstore|hospital|urgent care|clinic|dentist|doctor|gas station|hotel|motel|airbnb|park|playground|gym|yoga|pilates|laundry|dry cleaner|atm|bank|barber|salon|movie theater|cinema|bookstore)\b/;
    const localIntent = /\b(find|where|which|best|good|cheap|nearest|closest|top)\b/;
    if (localNouns.test(lower) && localIntent.test(lower)) return true;

    return false;
  },

  /**
   * Search the web using GSX Serper API (primary), webview, or DuckDuckGo (fallbacks)
   * @param {string} query - Search query
   * @returns {Promise<Array<{title, snippet, url}>>}
   */
  async webSearch(query) {
    return webCircuit.execute(async () => {
      // Primary: GSX Search Serper API (structured Google results)
      try {
        log.info('agent', 'Trying GSX Search API...');
        const results = await this.gsxSearch(query);
        if (results && results.length > 0) {
          log.info('agent', `GSX Search found ${results.length} results`);
          return results;
        }
        log.info('agent', 'GSX Search returned no results, trying fallbacks...');
      } catch (e) {
        log.info('agent', 'GSX Search failed, trying fallbacks', { error: e.message });
      }

      // Fallback 1: Webview search (hidden BrowserWindow)
      const webviewSearch = getWebviewSearch();
      if (webviewSearch) {
        try {
          log.info('agent', 'Trying webview search...');
          const results = await webviewSearch.search(query);
          if (results && results.length > 0) {
            log.info('agent', `Webview found ${results.length} results`);
            return results;
          }
          log.info('agent', 'Webview returned no results, trying DuckDuckGo...');
        } catch (e) {
          log.info('agent', 'Webview search failed', { error: e.message });
        }
      }

      // Fallback 2: DuckDuckGo API
      return this.duckDuckGoSearch(query);
    });
  },

  /**
   * Search using GSX Search Serper API (primary method)
   * Calls the OneReach-hosted Serper flow that returns structured Google results.
   * @param {string} query - Search query
   * @returns {Promise<Array<{title, snippet, url}>>}
   */
  async gsxSearch(query) {
    const encodedQuery = encodeURIComponent(query);
    const url = `${GSX_SEARCH_BASE}${GSX_SEARCH_PATH}?query=${encodedQuery}`;

    const response = await fetchWithTimeout(
      url,
      {
        headers: { Accept: 'application/json' },
      },
      TIMEOUT_GSX_SEARCH
    );

    if (!response.ok) {
      throw new Error(`GSX Search API returned ${response.status}`);
    }

    const data = await response.json();

    // Check for fetch error in response
    if (data.fetchError) {
      throw new Error(`GSX Search error: ${data.fetchError}`);
    }

    return this.parseGsxResults(data);
  },

  /**
   * Parse GSX Search Serper API response into standard result format
   * @param {Object} data - Raw API response
   * @returns {Array<{title, snippet, url}>}
   */
  parseGsxResults(data) {
    const results = [];

    // Parse organic results (main search results)
    if (data.organic && Array.isArray(data.organic)) {
      for (const item of data.organic.slice(0, 7)) {
        if (item.title || item.snippet) {
          results.push({
            title: item.title || '',
            snippet: item.snippet || '',
            url: item.link || '',
          });
        }
      }
    }

    // Include "People Also Ask" as additional context (up to 3)
    if (data.peopleAlsoAsk && Array.isArray(data.peopleAlsoAsk)) {
      for (const paa of data.peopleAlsoAsk.slice(0, 3)) {
        if (paa.question && paa.snippet) {
          results.push({
            title: paa.question,
            snippet: paa.snippet,
            url: paa.link || '',
          });
        }
      }
    }

    // Include knowledge graph if present
    if (data.knowledgeGraph) {
      const kg = data.knowledgeGraph;
      const kgSnippet =
        kg.description ||
        [
          kg.type,
          kg.attributes &&
            Object.entries(kg.attributes)
              .map(([k, v]) => `${k}: ${v}`)
              .join(', '),
        ]
          .filter(Boolean)
          .join('. ');
      if (kg.title && kgSnippet) {
        results.unshift({
          title: kg.title,
          snippet: kgSnippet,
          url: kg.website || kg.descriptionLink || '',
        });
      }
    }

    return results;
  },

  /**
   * Search using DuckDuckGo API (fallback method)
   * @param {string} query - Search query
   * @returns {Promise<Array<{title, snippet, url}>>}
   */
  async duckDuckGoSearch(query) {
    const encodedQuery = encodeURIComponent(query);

    // Try DuckDuckGo Instant Answer API first (JSON, no parsing needed)
    const instantUrl = `https://api.duckduckgo.com/?q=${encodedQuery}&format=json&no_html=1&skip_disambig=1`;

    try {
      const instantResponse = await fetchWithTimeout(
        instantUrl,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          },
        },
        TIMEOUT_WEB_SEARCH
      );

      if (instantResponse.ok) {
        const data = await instantResponse.json();
        const results = this.parseDuckDuckGoInstant(data, query);

        if (results.length > 0) {
          return results;
        }
      }
    } catch (e) {
      log.info('agent', 'DuckDuckGo Instant API failed, trying Lite', { error: e.message });
    }

    // Fallback to DuckDuckGo Lite HTML
    const searchUrl = `https://lite.duckduckgo.com/lite/?q=${encodedQuery}`;

    const response = await fetchWithTimeout(
      searchUrl,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
      },
      TIMEOUT_WEB_SEARCH_LITE
    );

    if (!response.ok) {
      throw new Error(`Search failed: ${response.status}`);
    }

    const html = await response.text();
    return this.parseDuckDuckGoLite(html);
  },

  /**
   * Parse DuckDuckGo Instant Answer API response
   * @param {Object} data - JSON response
   * @param {string} query - Original query
   * @returns {Array<{title, snippet, url}>}
   */
  parseDuckDuckGoInstant(data, query) {
    const results = [];

    // Abstract (main answer)
    if (data.Abstract && data.AbstractText) {
      results.push({
        title: data.Heading || query,
        snippet: data.AbstractText,
        url: data.AbstractURL || data.AbstractSource || '',
      });
    }

    // Answer (for calculations, conversions, etc.)
    if (data.Answer) {
      results.push({
        title: 'Direct Answer',
        snippet: data.Answer,
        url: '',
      });
    }

    // Related topics
    if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
      for (const topic of data.RelatedTopics.slice(0, 5)) {
        if (topic.Text && topic.FirstURL) {
          results.push({
            title: topic.Text.split(' - ')[0] || topic.Text.substring(0, 50),
            snippet: topic.Text,
            url: topic.FirstURL,
          });
        }
        // Handle nested topics
        if (topic.Topics && Array.isArray(topic.Topics)) {
          for (const subtopic of topic.Topics.slice(0, 2)) {
            if (subtopic.Text && subtopic.FirstURL) {
              results.push({
                title: subtopic.Text.split(' - ')[0] || subtopic.Text.substring(0, 50),
                snippet: subtopic.Text,
                url: subtopic.FirstURL,
              });
            }
          }
        }
      }
    }

    // Infobox data
    if (data.Infobox && data.Infobox.content) {
      const infoItems = data.Infobox.content
        .filter((item) => item.label && item.value)
        .map((item) => `${item.label}: ${item.value}`)
        .join('. ');

      if (infoItems) {
        results.push({
          title: data.Heading || 'Information',
          snippet: infoItems,
          url: data.AbstractURL || '',
        });
      }
    }

    return results;
  },

  /**
   * Parse DuckDuckGo Lite HTML results
   * @param {string} html - Raw HTML
   * @returns {Array<{title, snippet, url}>}
   */
  parseDuckDuckGoLite(html) {
    const results = [];

    // DuckDuckGo Lite uses a table-based format
    // Results are in rows with class containing "result" or in specific table cells

    // Method 1: Look for result links (class="result-link" or similar patterns)
    // DuckDuckGo Lite format has links followed by snippets in table cells

    // Try to find links with their text content - filter out internal DDG links
    const linkPattern = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;

    let match;
    const potentialResults = [];

    while ((match = linkPattern.exec(html)) !== null) {
      const url = match[1];
      const title = match[2].trim();

      // Skip DuckDuckGo internal links, W3C DTD, and empty/short titles
      if (
        url.includes('duckduckgo.com') ||
        url.includes('duck.co') ||
        url.includes('w3.org') ||
        title.length < 5 ||
        title.toLowerCase() === 'next' ||
        title.toLowerCase() === 'previous'
      ) {
        continue;
      }

      potentialResults.push({ url, title });
    }

    // Try to extract snippets from text following links
    // Look for text content between </a> and next <a> that looks like a snippet
    const snippetPattern = /<\/a>\s*([^<]{20,300})</gi;
    const snippets = [];
    while ((match = snippetPattern.exec(html)) !== null) {
      const text = match[1].trim();
      // Filter out navigation text and keep meaningful content
      if (text.length > 30 && !text.match(/^\d+$/) && !text.match(/^(next|previous|page)/i)) {
        snippets.push(text);
      }
    }

    // Combine links with snippets
    for (let i = 0; i < Math.min(potentialResults.length, 10); i++) {
      results.push({
        title: potentialResults[i].title,
        url: potentialResults[i].url,
        snippet: snippets[i] || '',
      });
    }

    // Method 2: If above didn't work, try DuckDuckGo instant answer API
    if (results.length === 0) {
      log.info('agent', 'Lite parsing found no results, returning empty');
    }

    return results;
  },

  /**
   * Use LLM to synthesize an answer from search results
   * @param {string} query - Original query
   * @param {Array} results - Search results (may be empty)
   * @returns {Promise<string>}
   */
  async synthesizeAnswer(query, results) {
    // Build prompt based on whether we have search results
    let systemPrompt, userPrompt;

    if (results.length > 0) {
      // Format search results for the LLM
      const resultsText = results
        .slice(0, 5)
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   Source: ${r.url}`)
        .join('\n\n');

      systemPrompt = `You are a helpful assistant that answers questions based on web search results.
Give a concise, conversational answer suitable for voice output (1-3 sentences).
If the search results don't contain the answer, use your general knowledge.
Don't mention "search results" - just answer naturally.
For weather queries, include temperature if available.
For factual queries, be specific and accurate.`;

      userPrompt = `Question: "${query}"

Search Results:
${resultsText}

Provide a brief, natural answer:`;
    } else {
      // No search results - use LLM's general knowledge
      systemPrompt = `You are a helpful assistant that answers questions.
Give a concise, conversational answer suitable for voice output (1-3 sentences).
Answer factual questions accurately. For weather, explain you don't have real-time data but can describe typical conditions.
Be helpful and informative.`;

      userPrompt = `Question: "${query}"

Provide a brief, natural answer:`;
    }

    try {
      const result = await ai.chat({
        profile: 'fast',
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        temperature: 0.3,
        maxTokens: 200,
        feature: 'search-agent',
      });

      const answer = result.content?.trim();
      return answer || `Here's what I found: ${results[0]?.title || 'No results'}`;
    } catch (error) {
      log.error('agent', 'LLM synthesis error', { error: error.message });
      // Fallback to simple result (works even on timeout)
      if (results.length > 0) {
        return `Here's what I found: ${results[0]?.title}. ${results[0]?.snippet || ''}`;
      }
      return "I couldn't complete the search right now. Please try again.";
    }
  },
};

module.exports = searchAgent;
