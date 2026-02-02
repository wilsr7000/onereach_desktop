/**
 * Personal DJ Agent - A Thinking Agent
 * 
 * An AI-powered music assistant that:
 * - Uses OpenAI to reason about what music to play
 * - Considers time of day, mood, and available speakers
 * - Learns your preferences over time
 * - Stores preferences in GSX (user-editable markdown)
 * - Handles ALL media controls (pause, skip, volume, AirPlay)
 * 
 * Uses the Agent Memory System and shared Thinking Agent utilities.
 */

const { getAgentMemory } = require('../../lib/agent-memory-store');
const { getTimeContext, learnFromInteraction } = require('../../lib/thinking-agent');
const mediaAgent = require('./media-agent');
const { getCircuit } = require('./circuit-breaker');

// Circuit breaker for AI calls
const djCircuit = getCircuit('dj-agent-ai', {
  failureThreshold: 3,
  resetTimeout: 30000,
  windowMs: 60000
});

/**
 * Get OpenAI API key
 */
function getOpenAIApiKey() {
  if (global.settingsManager) {
    const openaiKey = global.settingsManager.get('openaiApiKey');
    if (openaiKey) return openaiKey;
    const provider = global.settingsManager.get('llmProvider');
    const llmKey = global.settingsManager.get('llmApiKey');
    if (provider === 'openai' && llmKey) return llmKey;
  }
  return process.env.OPENAI_API_KEY;
}

/**
 * Use AI to reason about music recommendations
 * @param {Object} context - Request context
 * @returns {Promise<Object>} AI reasoning result
 */
async function aiReasonAboutMusic(context) {
  const apiKey = getOpenAIApiKey();
  
  if (!apiKey) {
    console.log('[DJAgent] No API key, using fallback logic');
    return null; // Will fall back to static mapping
  }
  
  const { mood, partOfDay, memory, availableSpeakers, conversationHistory } = context;
  
  const systemPrompt = `You are a personal DJ assistant. Based on the user's mood, time of day, and their listening history, recommend specific music to play.

${conversationHistory ? `Recent Conversation:\n${conversationHistory}\n` : ''}
User's Preferences (from memory):
${memory || 'No preferences learned yet.'}

Available Speakers: ${availableSpeakers.join(', ')}

Respond with a JSON object:
{
  "reasoning": "Brief explanation of your recommendation",
  "options": [
    {
      "label": "Short description (e.g., 'Jazz Cafe playlist')",
      "genre": "Primary genre/mood to search for",
      "speaker": "Which speaker to use",
      "searchTerms": ["term1", "term2", "term3"]
    }
  ],
  "greeting": "A friendly personalized message for the user"
}

IMPORTANT:
- Provide 2-3 distinct options
- Use searchTerms that would find actual Apple Music playlists (e.g., "Jazz Essentials", "Lo-Fi Beats", "Chill Vibes")
- Consider the user's history when making suggestions
- Match energy level to time of day
- Be creative but practical`;

  const userPrompt = `The user wants music. Context:
- Mood: ${mood}
- Time: ${partOfDay}
- Request: They want ${mood} music

What should I play?`;

  try {
    const result = await djCircuit.execute(async () => {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.7,
          max_tokens: 500,
          response_format: { type: 'json_object' }
        })
      });
      
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }
      
      return response.json();
    });
    
    const content = result.choices?.[0]?.message?.content;
    if (!content) return null;
    
    const parsed = JSON.parse(content);
    console.log('[DJAgent] AI reasoning:', parsed.reasoning);
    return parsed;
    
  } catch (error) {
    console.warn('[DJAgent] AI reasoning failed:', error.message);
    return null;
  }
}

/**
 * AI-driven music request understanding
 * Takes a raw user request and uses LLM to understand what they want
 * Returns either: playable action OR clarification needed
 * 
 * @param {string} userRequest - Raw user request text
 * @param {Object} context - { partOfDay, memory, availableSpeakers, conversationHistory, musicStatus }
 * @param {number} retryCount - Number of retries attempted (default 0)
 * @returns {Promise<Object>} - { action, searchTerms[], message, needsClarification?, clarificationPrompt? }
 */
async function aiUnderstandMusicRequest(userRequest, context, retryCount = 0) {
  const MAX_RETRIES = 2;
  const apiKey = getOpenAIApiKey();
  
  if (!apiKey) {
    console.log('[DJAgent] No API key, falling back to simple parsing');
    return { action: 'play', searchTerms: [userRequest], message: 'Playing music...' };
  }
  
  const { partOfDay, memory, availableSpeakers, conversationHistory, musicStatus, listeningHistory } = context;
  
  // Build music status context
  let musicStatusText = 'Music app not running';
  if (musicStatus?.running) {
    musicStatusText = `Music app is ${musicStatus.state}`;
    if (musicStatus.track) {
      musicStatusText += `, currently playing "${musicStatus.track}" by ${musicStatus.artist || 'Unknown'}`;
    }
    musicStatusText += `. Volume: ${musicStatus.volume}%`;
    if (musicStatus.currentSpeaker) {
      musicStatusText += `. Output: ${musicStatus.currentSpeaker}`;
    }
  }
  
  // Build AirPlay devices context
  let airplayText = 'No AirPlay devices available';
  if (musicStatus?.airplayDevices?.length > 0) {
    const deviceList = musicStatus.airplayDevices.map(d => 
      `${d.name}${d.selected ? ' (active)' : ''}`
    ).join(', ');
    airplayText = `Available speakers: ${deviceList}`;
  } else if (availableSpeakers?.length > 0) {
    airplayText = `Available speakers: ${availableSpeakers.join(', ')}`;
  }
  
  // Build listening history context
  let historyText = 'No listening history available';
  if (listeningHistory?.recentTracks?.length > 0) {
    const recentList = listeningHistory.recentTracks
      .slice(0, 5)
      .map(t => `"${t.name}" by ${t.artist}`)
      .join(', ');
    historyText = `Recently played: ${recentList}`;
  }
  
  let genresText = '';
  if (listeningHistory?.topGenres?.length > 0) {
    const topList = listeningHistory.topGenres
      .slice(0, 3)
      .map(g => g.genre)
      .join(', ');
    genresText = `\nFavorite genres: ${topList}`;
  }
  
  // Build podcast context if available
  let podcastText = '';
  if (context.podcastStatus?.subscriptions?.length > 0) {
    podcastText = `\nSUBSCRIBED PODCASTS: ${context.podcastStatus.subscriptions.slice(0, 5).join(', ')}`;
    if (context.podcastStatus.playing && context.podcastStatus.currentShow) {
      podcastText += `\nCurrently playing podcast: "${context.podcastStatus.currentEpisode}" from ${context.podcastStatus.currentShow}`;
    }
  }

  const systemPrompt = `You are a personal DJ creating the soundtrack to someone's life - the score to a movie where THEY are the star. Your job is to read the moment, understand what they're feeling, and deliver the perfect music.

THE SCENE RIGHT NOW:
${musicStatusText}
${podcastText}

WHAT THEY'VE BEEN VIBING TO:
${historyText}${genresText}

THEIR SOUND SYSTEM:
${airplayText}

THE MOMENT:
- Time: ${partOfDay}
- What you know about them: ${memory || 'Still learning their taste'}
${conversationHistory ? `- What's been said:\n${conversationHistory}` : ''}

YOUR DJ INSTINCTS:
You understand music AND people. When someone says:
- "this isn't reggae" → They asked for reggae, this track doesn't fit. Play ACTUAL reggae.
- "I don't like this" → Skip it, try something different in the same vibe
- "more like this" → They love it, find similar tracks
- "this is perfect" → Remember this for later, keep the vibe going
- "change it up" → Same genre/mood but fresher picks
- "is this jazz?" → They're questioning the genre, probably want real jazz

FEEDBACK IS A REQUEST. If they comment on what's playing ("this isn't X", "this doesn't sound like Y", "I wanted Z"), they want you to FIX IT by playing what they actually asked for.

Respond with JSON:
{
  "understood": true/false,
  "reasoning": "What you read from the moment",
  "mediaType": "music" | "podcast",
  "action": "play" | "playlist" | "podcast" | "clarify" | "control" | "custom",
  "searchTerms": ["term1", "term2"],
  "podcastSearch": "show or topic",
  "mood": "mellow|energetic|happy|sad|focus|party|relaxing|workout|romantic|chill",
  "genre": "the genre they want",
  "artist": "artist if mentioned",
  "speaker": "speaker name or null",
  "message": "Your response (brief, warm, like a good DJ)",
  "clarificationPrompt": "Only if truly lost",
  "customTask": "for complex requests"
}

ACTIONS:
- "playlist": Mood/genre request → Create a mix from their library
- "play": Specific song/artist → Search Apple Music  
- "podcast": They want spoken content
- "control": ANY playback control (pause, skip, volume, shuffle, etc.) - just set action to "control"
- "custom": Complex stuff (rate song, add to favorites, create special playlist)
- "clarify": Only when you genuinely can't tell what they want

For "control" actions, just identify it as control - the system will figure out the specifics.

PODCASTS (spoken word):
"podcast", "episode", "the daily", "news", "find a podcast about..." → action: "podcast"

REMEMBER:
- You're scoring their life, not just playing songs
- Read between the lines - complaints are requests
- Keep responses brief and warm, like a friend who just happens to be a great DJ
- When they give feedback about current music, ACT ON IT`;

  const userPrompt = `User request: "${userRequest}"

What music should I play? (or what clarification do I need?)`;

  try {
    const result = await djCircuit.execute(async () => {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.7,
          max_tokens: 400,
          response_format: { type: 'json_object' }
        })
      });
      
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }
      
      return response.json();
    });
    
    const content = result.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('No content in AI response');
    }
    
    const parsed = JSON.parse(content);
    console.log('[DJAgent] AI understood request:', parsed.reasoning);
    
    // Track cost
    if (global.budgetManager) {
      global.budgetManager.trackUsage({
        model: 'gpt-4o-mini',
        inputTokens: result.usage?.prompt_tokens || 0,
        outputTokens: result.usage?.completion_tokens || 0,
        feature: 'dj-agent-understanding'
      });
    }
    
    return parsed;
    
  } catch (error) {
    console.warn(`[DJAgent] AI understanding failed (attempt ${retryCount + 1}):`, error.message);
    
    // Retry logic
    if (retryCount < MAX_RETRIES) {
      console.log(`[DJAgent] Retrying... (${retryCount + 1}/${MAX_RETRIES})`);
      await new Promise(r => setTimeout(r, 1000 * (retryCount + 1))); // Exponential backoff
      return aiUnderstandMusicRequest(userRequest, context, retryCount + 1);
    }
    
    // Final fallback - try to play with the raw request
    console.log('[DJAgent] All retries failed, using raw request as search term');
    return {
      understood: true,
      action: 'play',
      searchTerms: [userRequest.replace(/^(play|put on|start)\s+/i, '')],
      message: "Let me find that for you..."
    };
  }
}

// Fallback genre mappings (used when AI not available)
const MOOD_GENRES = {
  energetic: ['Pop', 'Dance', 'Electronic', 'Rock', 'Hip Hop'],
  focused: ['Lo-fi', 'Ambient', 'Classical', 'Jazz', 'Instrumental'],
  relaxing: ['Chill', 'Jazz', 'Acoustic', 'Soul', 'R&B'],
  happy: ['Pop', 'Funk', 'Disco', 'Indie', 'Reggae'],
  melancholy: ['Blues', 'Indie', 'Folk', 'Classical', 'Alternative'],
  romantic: ['R&B', 'Soul', 'Jazz', 'Acoustic', 'Love Songs'],
  party: ['Dance', 'Pop', 'Hip Hop', 'EDM', 'Top 40'],
  // Additional moods
  cafe: ['Jazz', 'Lo-fi', 'Acoustic', 'Chill', 'Bossa Nova'],
  chill: ['Chill', 'Lo-fi', 'Ambient', 'Jazz', 'Acoustic'],
  work: ['Lo-fi', 'Ambient', 'Classical', 'Jazz', 'Focus'],
  study: ['Lo-fi', 'Classical', 'Ambient', 'Piano', 'Focus'],
  sleep: ['Ambient', 'Sleep', 'Classical', 'Piano', 'Peaceful'],
  workout: ['EDM', 'Hip Hop', 'Rock', 'Pop', 'Motivation'],
  dinner: ['Jazz', 'Classical', 'Soul', 'Acoustic', 'Chill'],
  morning: ['Acoustic', 'Pop', 'Indie', 'Jazz', 'Coffee'],
  creative: ['Electronic', 'Lo-fi', 'Indie', 'Ambient', 'Alternative']
};

const TIME_MOODS = {
  morning: ['focused', 'energetic', 'happy'],
  afternoon: ['energetic', 'focused', 'happy'],
  evening: ['relaxing', 'happy', 'romantic'],
  night: ['relaxing', 'melancholy', 'romantic']
};

const TIME_GREETINGS = {
  morning: 'Good morning',
  afternoon: 'Good afternoon',
  evening: 'Good evening',
  night: 'Hey there'
};

const djAgent = {
  id: 'dj-agent',
  name: 'Personal DJ',
  description: 'Intelligent music assistant - handles playback, preferences, and personalized recommendations',
  voice: 'ash',  // Warm, friendly - like a radio DJ - see VOICE-GUIDE.md
  
  // Quick acknowledgments spoken immediately when agent wins bid (before execution)
  acks: [
    "On it!",
    "Got it!",
    "You got it!",
    "Coming right up!",
    "Let me handle that.",
  ],

  // Prompt for LLM evaluation - describes what this agent does
  prompt: `Personal DJ handles ALL music, audio, playback requests, AND music preference management. HIGH CONFIDENCE (0.8+) for:
- Setting/managing music preferences ("set my music preferences", "my favorite genre is...")
- Learning user's music taste ("I like jazz", "I prefer rock in the morning", "remember I like classical")
- Favorite genres/artists ("my favorites", "what music do I like", "add to my preferences")
- Time-based preferences ("morning music", "evening playlist preferences")
- Speaker preferences for different rooms/times
- ANY mention of music, songs, audio, sound, tracks, playlists, beats, tunes
- Playback control: play, pause, stop, skip, next, previous, shuffle, repeat
- Volume: louder, quieter, turn up, turn down, mute, unmute
- Questions about current music: "what's playing", "what song is this", "what happened to the music"
- Vague requests: "play something", "change it up", "something different", "surprise me"
- Mood requests: "play something relaxing", "upbeat music", "focus music"
- Feedback: "I like this", "I don't like this", "more like this", "not this"
- Speaker/AirPlay: HomePod, speakers, AirPlay, living room, bedroom, kitchen
- Genre/artist requests: jazz, rock, pop, classical, any artist name

IMPORTANT: This agent handles BOTH playing music AND managing music preferences/settings. If the user mentions music preferences, favorite music, music settings, or wants to configure their music taste, route to this agent with HIGH confidence (0.85+).`,

  capabilities: [
    'Play music by mood, genre, artist, or song',
    'Control music playback (pause, stop, skip, next, previous)',
    'Adjust volume (up, down, mute, unmute)',
    'Control AirPlay speakers and devices',
    'Make personalized music recommendations',
    'Learn and remember user music preferences',
    'Set favorite genres and artists',
    'Configure time-of-day music preferences',
    'Handle feedback about current music'
  ],
  
  // NOTE: Input schema removed - using AI-driven understanding instead
  // The AI analyzes the request and asks clarifying questions only when needed
  // This is more flexible and natural than keyword-based detection
  
  categories: ['media', 'music', 'entertainment', 'personal', 'mood'],
  keywords: [
    // Music/DJ keywords
    'dj', 'play music', 'play something', 'what should i listen', 'music recommendation', 'suggest music',
    // Basic media controls
    'play', 'pause', 'stop', 'skip', 'next', 'previous', 'volume', 'mute', 'unmute',
    // AirPlay
    'airplay', 'speaker', 'speakers', 'homepod', 'apple tv', 'output', 'living room', 'bedroom', 'kitchen',
    // Mood/emotional requests - DJ can help with music
    'cheer me up', 'feeling down', 'feeling sad', 'need energy', 'pump me up', 'calm me down',
    'relax', 'relaxing', 'focus', 'concentrate', 'work music', 'study music', 'party', 'celebrate',
    'feeling happy', 'feeling energetic', 'feeling tired', 'wake me up', 'wind down', 'chill'
  ],
  
  // Memory store instance
  memory: null,
  
  /**
   * Initialize the agent's memory
   */
  async initialize() {
    if (!this.memory) {
      this.memory = getAgentMemory('dj-agent', {
        displayName: 'Personal DJ'
      });
      await this.memory.load();
      
      // Ensure memory has required sections
      this._ensureMemorySections();
    }
    return this.memory;
  },
  
  /**
   * Ensure memory has all required sections with defaults
   * @private
   */
  _ensureMemorySections() {
    const sections = this.memory.getSectionNames();
    
    // Add Time-Based Preferences if missing
    if (!sections.includes('Time-Based Preferences')) {
      this.memory.updateSection('Time-Based Preferences', `### Morning (6am-12pm)
- Genres: Jazz, Classical, Lo-fi
- Energy: Low to Medium
- Typical moods: Focused, Calm

### Afternoon (12pm-6pm)
- Genres: Pop, Indie, Electronic
- Energy: Medium to High
- Typical moods: Energetic, Productive

### Evening (6pm-10pm)
- Genres: R&B, Soul, Jazz
- Energy: Medium
- Typical moods: Relaxing, Social

### Night (10pm-6am)
- Genres: Ambient, Classical, Lo-fi
- Energy: Low
- Typical moods: Calm, Sleepy`);
    }
    
    // Add Speaker Preferences if missing
    if (!sections.includes('Speaker Preferences')) {
      this.memory.updateSection('Speaker Preferences', `*Will be populated as you use different speakers*`);
    }
    
    // Add Favorite Artists if missing
    if (!sections.includes('Favorite Artists')) {
      this.memory.updateSection('Favorite Artists', `*Will be populated as you listen to music*`);
    }

    // Add Custom AppleScripts tracking if missing
    if (!sections.includes('Custom AppleScripts')) {
      this.memory.updateSection('Custom AppleScripts', `*No custom scripts tracked yet*`);
    }

    // Save if we made changes
    if (this.memory.isDirty()) {
      this.memory.save();
    }
  },
  
  // NOTE: bid() function removed - using LLM-based bidding via unified-bidder.js
  // The agent's prompt, description, keywords, and capabilities are used by the LLM
  // to intelligently decide if this agent should handle a request.
  // Falls back to keyword matching if LLM is unavailable.
  
  /**
   * Execute the task
   * @param {Object} task - { content, context, ... }
   * @returns {Object} - { success, message, needsInput?, ... }
   */
  async execute(task) {
    try {
      // Initialize memory if needed
      if (!this.memory) {
        await this.initialize();
      }
      
      // ==================== MULTI-TURN CONVERSATION STATE ====================
      // Check for multi-turn FIRST before other commands
      // This ensures follow-up responses are handled correctly
      const context = this._gatherContext();
      
      if (task.context?.djState === 'awaiting_mood') {
        return this._handleMoodResponse(task, context);
      }
      
      if (task.context?.djState === 'awaiting_choice') {
        return this._handleChoiceResponse(task, context);
      }
      
      // Handle AI clarification response
      if (task.context?.djState === 'awaiting_ai_clarification') {
        return this._handleAIClarificationResponse(task, context);
      }
      
      // NOTE: AirPlay commands are now handled by AI understanding
      // The AI will detect if user wants to play on a specific speaker
      // and include that in the response
      
      // ==================== AI-DRIVEN MEDIA UNDERSTANDING ====================
      // Get current music/podcast status and listening history for better AI context
      const [musicStatus, listeningHistory, podcastStatus] = await Promise.all([
        this._getMusicStatus(),
        this._getListeningHistory(),
        this._getPodcastStatus()
      ]);

      // Use LLM to understand what the user wants
      const aiContext = {
        partOfDay: context.partOfDay,
        memory: this.memory ? this.memory.getSection('Favorite Artists') : null,
        availableSpeakers: musicStatus?.airplayDevices?.map(d => d.name) || await this._getAvailableSpeakers(),
        conversationHistory: task.context?.conversationText || '',
        musicStatus,
        listeningHistory,
        podcastStatus
      };

      console.log('[DJAgent] Using AI to understand request:', task.content);
      console.log('[DJAgent] Music status:', musicStatus?.state, 'Podcasts:', podcastStatus?.subscriptions?.length || 0);
      const aiResult = await aiUnderstandMusicRequest(task.content, aiContext);
      
      if (!aiResult) {
        // AI failed completely, use simple fallback
        return this._askMood(context);
      }
      
      // Handle based on AI's decision
      if (aiResult.action === 'control') {
        console.log('[DJAgent] Control action - letting LLM figure it out');
        // Pass original request - LLM will determine the AppleScript
        try {
          const controlResult = await this._handleControlAction(null, task.content);
          console.log('[DJAgent] Control result:', JSON.stringify(controlResult));
          return controlResult;
        } catch (controlError) {
          console.error('[DJAgent] Control action threw:', controlError?.message || controlError);
          return { success: false, message: `Control failed: ${controlError?.message}` };
        }
      }

      // AI wants to play a podcast
      if (aiResult.action === 'podcast' || aiResult.mediaType === 'podcast') {
        console.log('[DJAgent] Playing podcast:', aiResult.podcastSearch || 'any');
        return this._playPodcast(aiResult.podcastSearch, aiResult.message);
      }

      if (aiResult.action === 'clarify' || !aiResult.understood) {
        // AI needs clarification - ask the user
        const prompt = aiResult.clarificationPrompt || "What kind of music would you like?";
        return {
          success: true,
          needsInput: {
            prompt,
            agentId: this.id,
            context: {
              djState: 'awaiting_ai_clarification',
              originalRequest: task.content
            }
          }
        };
      }
      
      // AI wants to create a playlist from the user's library
      if (aiResult.action === 'playlist') {
        console.log('[DJAgent] Creating mood playlist:', aiResult.mood || aiResult.genre);
        if (aiResult.speaker) {
          console.log('[DJAgent] AI detected speaker:', aiResult.speaker);
        }
        return this._createMoodPlaylist(aiResult, context);
      }

      // AI understood the request - play music with the search terms
      if (aiResult.action === 'play' && aiResult.searchTerms?.length > 0) {
        console.log('[DJAgent] AI provided search terms:', aiResult.searchTerms);
        if (aiResult.speaker) {
          console.log('[DJAgent] AI detected speaker:', aiResult.speaker);
        }
        return this._playWithSearchTerms(aiResult.searchTerms, aiResult.message, aiResult.speaker);
      }

      // AI identified this as a custom/complex request requiring generated AppleScript
      if (aiResult.action === 'custom' && aiResult.customTask) {
        console.log('[DJAgent] Generating custom AppleScript for:', aiResult.customTask);
        return this._generateAndExecuteCustomAppleScript(aiResult.customTask, task.content, aiResult.message);
      }

      // Fallback to asking
      return this._askMood(context);
      
    } catch (error) {
      console.error('[DJAgent] Execute error:', error?.message || error);
      console.error('[DJAgent] Stack:', error?.stack);
      return {
        success: false,
        message: "I had trouble getting your music ready. Let me try again."
      };
    }
  },
  
  /**
   * Gather context (time, speakers, preferences)
   * Uses shared getTimeContext from thinking-agent module
   * @private
   */
  _gatherContext() {
    // Use shared time context utility
    return getTimeContext();
  },
  
  /**
   * Get available speakers/AirPlay devices
   * @private
   */
  async _getAvailableSpeakers() {
    try {
      const devices = await mediaAgent.listAirPlayDevices();
      if (devices && devices.length > 0) {
        return devices.map(d => d.name || d);
      }
    } catch (e) {
      console.warn('[DJAgent] Could not get speakers:', e.message);
    }
    return ['default speaker'];
  },
  
  /**
   * Get full music player status for AI context
   * @private
   */
  async _getMusicStatus() {
    try {
      const { getFullMusicStatus } = require('./applescript-helper');
      const status = await getFullMusicStatus('Music');
      console.log('[DJAgent] Got music status:', status.state, status.track ? `playing ${status.track}` : 'no track');
      return status;
    } catch (e) {
      console.warn('[DJAgent] Could not get music status:', e.message);
      return null;
    }
  },
  
  /**
   * Get podcast status and subscriptions
   * @private
   */
  async _getPodcastStatus() {
    try {
      const { getPodcastStatus } = require('./applescript-helper');
      const status = await getPodcastStatus();
      console.log('[DJAgent] Podcast status:', status.running ? 'running' : 'not running', 'Subscriptions:', status.subscriptions?.length || 0);
      return status;
    } catch (e) {
      console.warn('[DJAgent] Could not get podcast status:', e.message);
      return { running: false, playing: false, subscriptions: [] };
    }
  },

  /**
   * Play a podcast - searches subscriptions first, then catalog
   * @private
   */
  async _playPodcast(searchTerm, message) {
    const { playPodcast, searchAndPlayPodcast, getPodcastStatus, controlPodcast } = require('./applescript-helper');
    
    console.log('[DJAgent] Playing podcast:', searchTerm || 'any available');
    
    // First try subscriptions
    const result = await playPodcast(searchTerm || '');
    
    if (result.success) {
      // Verify podcast is playing
      await new Promise(r => setTimeout(r, 2000));
      const status = await getPodcastStatus();
      
      if (status.playing) {
        return {
          success: true,
          message: result.message || `Now playing: ${status.currentEpisode} from ${status.currentShow}`
        };
      }
      
      // Podcast app opened but not playing - try to force play
      await controlPodcast('play');
      
      await new Promise(r => setTimeout(r, 1500));
      const retryStatus = await getPodcastStatus();
      
      if (retryStatus.playing) {
        return {
          success: true,
          message: `Now playing: ${retryStatus.currentEpisode || 'podcast'}`
        };
      }
    }
    
    // Not in subscriptions - search the catalog!
    if (searchTerm && result.needsCatalogSearch) {
      console.log('[DJAgent] Not in subscriptions, searching podcast catalog for:', searchTerm);
      
      const catalogResult = await searchAndPlayPodcast(searchTerm);
      
      if (catalogResult.success) {
        // Verify it's playing
        await new Promise(r => setTimeout(r, 2000));
        const status = await getPodcastStatus();
        
        if (status.playing) {
          return {
            success: true,
            message: `Found a podcast about ${searchTerm}! Now playing: ${status.currentEpisode || 'episode'} from ${status.currentShow || 'new show'}`
          };
        }
        
        // Opened search results but not playing yet
        return {
          success: true,
          message: catalogResult.message || `I found podcasts about "${searchTerm}" - pick one you like!`
        };
      }
      
      // Catalog search also failed - open app with search as last resort
      return {
        success: true,
        message: `I opened Podcasts with a search for "${searchTerm}" - browse and pick what interests you!`
      };
    }
    
    // No search term and nothing in subscriptions
    if (!searchTerm) {
      return {
        success: false,
        message: "I couldn't find any podcasts to play. What topic interests you? I can search for something."
      };
    }
    
    return {
      success: false,
      message: result.message || `I had trouble finding "${searchTerm}". Try being more specific?`
    };
  },

  /**
   * Control podcast playback
   * @private
   */
  async _handlePodcastControl(action) {
    const { controlPodcast, getPodcastStatus } = require('./applescript-helper');
    
    // Map some common action names
    const actionMap = {
      'skip': 'forward',
      'skip_forward': 'forward',
      'skip_back': 'rewind',
      'back': 'rewind',
      'resume': 'play'
    };
    
    const mappedAction = actionMap[action] || action;
    console.log('[DJAgent] Podcast control:', mappedAction);
    
    const result = await controlPodcast(mappedAction);
    
    if (result.success) {
      // Get current state to report
      const status = await getPodcastStatus();
      if (status.currentEpisode && mappedAction !== 'pause') {
        return {
          success: true,
          message: `${result.message}. Playing: ${status.currentEpisode}`
        };
      }
    }
    
    return result;
  },

  /**
   * Get listening history and preferences
   * @private
   */
  async _getListeningHistory() {
    try {
      const { getRecentlyPlayed, getTopGenres } = require('./applescript-helper');

      // Get recent tracks and top genres in parallel
      const [recentTracks, topGenres] = await Promise.all([
        getRecentlyPlayed(5),
        getTopGenres()
      ]);

      console.log('[DJAgent] Got listening history:', recentTracks.length, 'recent tracks,', topGenres.length, 'top genres');

      return {
        recentTracks,
        topGenres
      };
    } catch (e) {
      console.warn('[DJAgent] Could not get listening history:', e.message);
      return { recentTracks: [], topGenres: [] };
    }
  },
  
  /**
   * Tool library - JS functions that LLM can call
   * Each function executes AppleScript and returns result for LLM to consume
   * @private
   */
  _tools: {
    async setVolume({ level }) {
      const { runScript, getFullMusicStatus } = require('./applescript-helper');
      const clampedLevel = Math.min(100, Math.max(0, parseInt(level)));
      await runScript(`tell application "Music" to set sound volume to ${clampedLevel}`);
      const status = await getFullMusicStatus('Music');
      return { success: true, newVolume: status.volume };
    },
    
    async adjustVolume({ delta }) {
      const { runScript, getFullMusicStatus } = require('./applescript-helper');
      const op = delta >= 0 ? '+' : '';
      await runScript(`tell application "Music" to set sound volume to (sound volume ${op} ${delta})`);
      const status = await getFullMusicStatus('Music');
      return { success: true, newVolume: status.volume };
    },
    
    async pause() {
      const { runScript, getFullMusicStatus } = require('./applescript-helper');
      await runScript(`tell application "Music" to pause`);
      const status = await getFullMusicStatus('Music');
      return { success: true, state: status.state };
    },
    
    async play() {
      const { runScript, getFullMusicStatus } = require('./applescript-helper');
      await runScript(`tell application "Music" to play`);
      const status = await getFullMusicStatus('Music');
      return { success: true, state: status.state, track: status.track };
    },
    
    async nextTrack() {
      const { runScript, getFullMusicStatus } = require('./applescript-helper');
      await runScript(`tell application "Music" to next track`);
      await new Promise(r => setTimeout(r, 300));
      const status = await getFullMusicStatus('Music');
      return { success: true, track: status.track, artist: status.artist };
    },
    
    async previousTrack() {
      const { runScript, getFullMusicStatus } = require('./applescript-helper');
      await runScript(`tell application "Music" to previous track`);
      await new Promise(r => setTimeout(r, 300));
      const status = await getFullMusicStatus('Music');
      return { success: true, track: status.track, artist: status.artist };
    },
    
    async toggleShuffle() {
      const { runScript } = require('./applescript-helper');
      await runScript(`tell application "Music" to set shuffle enabled to (not shuffle enabled)`);
      const result = await runScript(`tell application "Music" to get shuffle enabled`);
      return { success: true, shuffleEnabled: result.trim() === 'true' };
    },
    
    async runCustomScript({ script }) {
      const { runScript, getFullMusicStatus } = require('./applescript-helper');
      await runScript(`tell application "Music" to ${script}`);
      const status = await getFullMusicStatus('Music');
      return { success: true, volume: status.volume, state: status.state, track: status.track };
    }
  },

  /**
   * Tool descriptions for LLM
   * @private
   */
  _toolDescriptions: `
AVAILABLE TOOLS:
- setVolume({level: 0-100}) - Set exact volume level
- adjustVolume({delta: number}) - Adjust volume relatively (+15, -10, etc.)
- pause() - Pause playback
- play() - Resume playback
- nextTrack() - Skip to next track
- previousTrack() - Go back to previous track
- toggleShuffle() - Toggle shuffle on/off
- runCustomScript({script: "AppleScript"}) - Run any AppleScript command
`,

  /**
   * Pattern cache for common requests - skips LLM entirely
   * Each pattern has keywords to match and the tool call to make
   * @private
   */
  _patternCache: [
    // Volume up variations
    { keywords: ['turn it up', 'louder', 'crank it', 'pump it up'], tool: 'adjustVolume', args: { delta: 15 } },
    { keywords: ['turn it up a bit', 'little louder', 'bit louder'], tool: 'adjustVolume', args: { delta: 10 } },
    { keywords: ['turn it up a lot', 'way up', 'much louder', 'crank'], tool: 'adjustVolume', args: { delta: 30 } },
    // Volume down variations
    { keywords: ['turn it down', 'quieter', 'lower'], tool: 'adjustVolume', args: { delta: -15 } },
    { keywords: ['turn it down a bit', 'little quieter', 'bit quieter'], tool: 'adjustVolume', args: { delta: -10 } },
    { keywords: ['turn it down a lot', 'way down', 'much quieter'], tool: 'adjustVolume', args: { delta: -30 } },
    // Volume extremes
    { keywords: ['mute', 'silence'], tool: 'setVolume', args: { level: 0 } },
    { keywords: ['max volume', 'full volume', 'all the way up'], tool: 'setVolume', args: { level: 100 } },
    // Playback
    { keywords: ['pause', 'stop'], tool: 'pause', args: {} },
    { keywords: ['play', 'resume', 'unpause', 'start'], tool: 'play', args: {} },
    { keywords: ['skip', 'next', 'next song', 'next track'], tool: 'nextTrack', args: {} },
    { keywords: ['previous', 'back', 'go back', 'last song'], tool: 'previousTrack', args: {} },
    { keywords: ['shuffle', 'randomize', 'mix it up'], tool: 'toggleShuffle', args: {} },
  ],

  /**
   * Try to match request against pattern cache
   * Returns { tool, args } if matched, null if no match
   * @private
   */
  _matchPattern(request) {
    const r = request.toLowerCase().trim();
    
    // Check for specific volume level first (e.g., "volume to 23%", "set it to 50")
    const volumeMatch = r.match(/(?:volume|set it|turn it|put it)?\s*(?:to|at)\s*(\d+)\s*%?/);
    if (volumeMatch) {
      const level = Math.min(100, Math.max(0, parseInt(volumeMatch[1])));
      return { tool: 'setVolume', args: { level }, cached: true };
    }
    
    // Check pattern cache - longer patterns first for better matching
    const sortedPatterns = [...this._patternCache].sort((a, b) => {
      const aMax = Math.max(...a.keywords.map(k => k.length));
      const bMax = Math.max(...b.keywords.map(k => k.length));
      return bMax - aMax;
    });
    
    for (const pattern of sortedPatterns) {
      for (const keyword of pattern.keywords) {
        if (r.includes(keyword)) {
          return { tool: pattern.tool, args: pattern.args, cached: true };
        }
      }
    }
    
    return null; // No match, need LLM
  },

  /**
   * Single LLM call that picks tool AND generates response
   * Returns { tool, args, response } in one call to reduce latency
   * @private
   */
  async _pickToolWithResponse(request, currentState) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('No API key');

    const prompt = `You control Apple Music. User said: "${request}"
Current: volume=${currentState.volume ?? '?'}%, state=${currentState.state ?? '?'}, track="${currentState.track ?? 'none'}"

${this._toolDescriptions}

Pick the best tool, provide arguments, AND write a brief friendly DJ response.

Return JSON:
{
  "tool": "toolName",
  "args": {arg1: value1},
  "response": "brief friendly response to say after"
}

Examples:
- "turn it to 23%" → {"tool": "setVolume", "args": {"level": 23}, "response": "Setting it to 23%"}
- "turn it up" → {"tool": "adjustVolume", "args": {"delta": 15}, "response": "Turning it up"}
- "turn it up a lot" → {"tool": "adjustVolume", "args": {"delta": 30}, "response": "Cranking it up!"}
- "turn it down a bit" → {"tool": "adjustVolume", "args": {"delta": -10}, "response": "Bringing it down a touch"}
- "pause" → {"tool": "pause", "args": {}, "response": "Paused"}
- "skip" → {"tool": "nextTrack", "args": {}, "response": "Skipping to the next one"}
- "rate this 5 stars" → {"tool": "runCustomScript", "args": {"script": "set rating of current track to 100"}, "response": "Rated 5 stars"}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 200 })
    });

    const data = await response.json();
    let content = data.choices?.[0]?.message?.content?.trim();
    if (content.includes('```')) content = content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    
    if (global.budgetManager) {
      global.budgetManager.trackUsage({ model: 'gpt-4o-mini', inputTokens: data.usage?.prompt_tokens || 0, outputTokens: data.usage?.completion_tokens || 0, context: 'dj-pick-tool' });
    }

    return JSON.parse(content);
  },

  /**
   * Generate simple response from tool result without LLM
   * Used for cached patterns and to enhance LLM responses with actual values
   * @private
   */
  _simpleResponse(result, toolName) {
    // Volume responses
    if (result.newVolume !== undefined) {
      return `Volume at ${result.newVolume}%`;
    }
    
    // Track responses
    if (result.track) {
      const artist = result.artist ? ` by ${result.artist}` : '';
      return `Now playing: ${result.track}${artist}`;
    }
    
    // State responses
    if (result.state) {
      return result.state === 'playing' ? 'Playing' : 'Paused';
    }
    
    // Shuffle responses
    if (result.shuffleEnabled !== undefined) {
      return result.shuffleEnabled ? 'Shuffle on' : 'Shuffle off';
    }
    
    // Tool-specific fallbacks
    const toolResponses = {
      'adjustVolume': 'Volume adjusted',
      'setVolume': 'Volume set',
      'pause': 'Paused',
      'play': 'Playing',
      'nextTrack': 'Skipped',
      'previousTrack': 'Going back',
      'toggleShuffle': 'Shuffle toggled',
      'runCustomScript': 'Done'
    };
    
    return toolResponses[toolName] || 'Done';
  },

  /**
   * Enhance LLM response with actual result values
   * @private
   */
  _enhanceResponse(llmResponse, result) {
    // If LLM response doesn't include the actual value, append it
    if (result.newVolume !== undefined && !llmResponse.includes('%')) {
      return `${llmResponse}. Volume at ${result.newVolume}%`;
    }
    if (result.track && !llmResponse.toLowerCase().includes(result.track.toLowerCase())) {
      return `${llmResponse}. Now playing: ${result.track}`;
    }
    return llmResponse;
  },

  /**
   * Handle control actions - Optimized flow:
   * 1. Check pattern cache (skips LLM entirely for common requests)
   * 2. If cache miss → single LLM call (tool + response together)
   * 3. Execute tool function
   * 4. Return response (simple for cache hits, LLM response for complex)
   * @private
   */
  async _handleControlAction(_, originalRequest) {
    const { getFullMusicStatus } = require('./applescript-helper');

    console.log(`[DJAgent] Control: "${originalRequest}"`);

    // STEP 1: Get current state for context
    let currentState = {};
    try {
      currentState = await getFullMusicStatus('Music');
      console.log(`[DJAgent] State: volume=${currentState.volume}, state=${currentState.state}`);
    } catch (e) {
      console.warn('[DJAgent] Could not get state:', e.message);
    }

    // STEP 2: Try pattern cache first (no LLM needed for common requests)
    let toolCall = this._matchPattern(originalRequest);
    let usedCache = false;
    
    if (toolCall) {
      console.log(`[DJAgent] Cache hit: ${toolCall.tool}(${JSON.stringify(toolCall.args)})`);
      usedCache = true;
    } else {
      // STEP 2b: Cache miss - use single LLM call for tool + response
      console.log(`[DJAgent] Cache miss, calling LLM...`);
      try {
        toolCall = await this._pickToolWithResponse(originalRequest, currentState);
        console.log(`[DJAgent] LLM: ${toolCall.tool}(${JSON.stringify(toolCall.args)}) → "${toolCall.response}"`);
      } catch (e) {
        console.error('[DJAgent] LLM failed:', e.message);
        return { success: false, message: `I couldn't figure that out` };
      }
    }

    // STEP 3: Execute the tool
    const tool = this._tools[toolCall.tool];
    if (!tool) {
      console.error(`[DJAgent] Unknown tool: ${toolCall.tool}`);
      return { success: false, message: `I don't know how to do that` };
    }

    let result;
    try {
      result = await tool(toolCall.args || {});
      console.log(`[DJAgent] Result: ${JSON.stringify(result)}`);
    } catch (e) {
      console.error(`[DJAgent] Tool failed: ${e.message}`);
      return { success: false, message: `That didn't work: ${e.message}` };
    }

    // STEP 4: Generate response
    let message;
    if (usedCache) {
      // Cache hit - use simple response based on result
      message = this._simpleResponse(result, toolCall.tool);
    } else {
      // LLM call - use LLM's response, enhanced with actual values
      message = this._enhanceResponse(toolCall.response || 'Done', result);
    }
    
    console.log(`[DJAgent] Response: ${message}`);
    return { success: true, message };
  },


  
  /**
   * Verify music is actually playing after an action
   * @private
   * @returns {Promise<{playing: boolean, track: string|null, retryNeeded: boolean}>}
   */
  async _verifyMusicPlaying(waitMs = 2000) {
    const { getFullMusicStatus } = require('./applescript-helper');
    
    // Wait for music to start
    await new Promise(r => setTimeout(r, waitMs));
    
    try {
      const status = await getFullMusicStatus('Music');
      
      if (!status || !status.running) {
        console.log('[DJAgent] Verify: Music app not running');
        return { playing: false, track: null, retryNeeded: true };
      }
      
      if (status.state === 'playing') {
        console.log('[DJAgent] Verify: Music is playing -', status.track);
        return { 
          playing: true, 
          track: status.track,
          artist: status.artist,
          retryNeeded: false 
        };
      }
      
      // Music app is open but not playing
      console.log('[DJAgent] Verify: Music app open but state is', status.state);
      return { playing: false, track: null, retryNeeded: true };
      
    } catch (e) {
      console.warn('[DJAgent] Verify failed:', e.message);
      // Can't verify - assume it might be working
      return { playing: false, track: null, retryNeeded: false };
    }
  },
  
  /**
   * Force play if music isn't playing
   * @private
   */
  async _forcePlay() {
    const { runScript } = require('./applescript-helper');
    
    try {
      await runScript(`
        tell application "Music"
          if player state is not playing then
            play
          end if
        end tell
      `, 5000);
      return true;
    } catch (e) {
      console.warn('[DJAgent] Force play failed:', e.message);
      return false;
    }
  },

  /**
   * Generate and execute custom AppleScript using Claude
   * For complex requests that don't fit pre-built patterns
   * Tracks successful scripts for potential promotion to pre-built
   * @private
   */
  async _generateAndExecuteCustomAppleScript(customTask, originalRequest, aiMessage) {
    const { runScript } = require('./applescript-helper');
    
    try {
      // Get Claude to generate AppleScript
      const claudeCode = require('../../lib/claude-code-runner');
      
      const prompt = `You are an expert at writing AppleScript for macOS Music app (Apple Music).

USER REQUEST: "${originalRequest}"
TASK: ${customTask}

Generate AppleScript code to accomplish this task. The script should:
1. Work with the Music app (not iTunes - use "tell application Music")
2. Handle errors gracefully with try blocks
3. Return a meaningful result or confirmation
4. Be safe - don't delete playlists or data without confirmation

IMPORTANT GUIDELINES:
- Use "Music" not "iTunes" as the application name
- For playlists, use: make new playlist with properties {name:"..."}
- For adding to library: add (some track) to library playlist 1
- For ratings: set rating of current track to X (where X is 0-100, 100=5 stars)
- For favorites/loved: set loved of current track to true
- To get track info: get {name, artist, album} of current track
- For searching: (every track whose name contains "...")

Return ONLY the AppleScript code, no explanation. The code should be directly executable.`;

      console.log('[DJAgent] Generating custom AppleScript with Claude...');
      
      const response = await claudeCode.complete(prompt, {
        maxTokens: 1000,
      });
      
      if (!response) {
        throw new Error('No response from Claude');
      }
      
      // Extract AppleScript from response (might be in code blocks)
      let script = response;
      const codeMatch = response.match(/```(?:applescript)?\n?([\s\S]*?)```/);
      if (codeMatch) {
        script = codeMatch[1].trim();
      }
      
      // Clean up the script
      script = script.trim();
      if (!script) {
        throw new Error('Empty script generated');
      }
      
      console.log('[DJAgent] Generated AppleScript:', script.substring(0, 200) + '...');
      
      // Execute the generated script
      const result = await runScript(script, 15000); // 15 second timeout for complex scripts
      
      console.log('[DJAgent] Custom script result:', result);
      
      // Track successful script for potential promotion
      await this._trackCustomScriptSuccess(customTask, originalRequest, script);
      
      return {
        success: true,
        message: aiMessage || result || 'Done!'
      };
      
    } catch (error) {
      console.error('[DJAgent] Custom AppleScript failed:', error.message);
      
      // Track failure for learning
      await this._trackCustomScriptFailure(customTask, originalRequest, error.message);
      
      // Try to provide a helpful error message
      if (error.message.includes('not authorized')) {
        return {
          success: false,
          message: "I need permission to control the Music app. Please grant access in System Preferences > Privacy & Security > Automation."
        };
      }
      
      return {
        success: false,
        message: `I couldn't complete that action: ${error.message}. Try asking in a different way?`
      };
    }
  },

  /**
   * Track successful custom AppleScript for potential promotion
   * @private
   */
  async _trackCustomScriptSuccess(customTask, originalRequest, script) {
    try {
      if (!this.memory) {
        await this.initialize();
      }

      // Normalize the task for pattern matching
      const normalizedTask = customTask.toLowerCase().trim();
      
      // Get existing custom scripts section
      let customScripts = this.memory.getSection('Custom AppleScripts') || '';
      
      // Parse existing entries
      const entries = this._parseCustomScriptEntries(customScripts);
      
      // Find existing entry for similar task
      const existingIndex = entries.findIndex(e => 
        this._tasksAreSimilar(e.task, normalizedTask)
      );
      
      const timestamp = new Date().toISOString().split('T')[0];
      
      if (existingIndex >= 0) {
        // Update existing entry
        entries[existingIndex].successCount++;
        entries[existingIndex].lastUsed = timestamp;
        entries[existingIndex].script = script; // Keep latest working version
        
        // Check if ready for promotion (3+ successes)
        if (entries[existingIndex].successCount >= 3 && !entries[existingIndex].flaggedForPromotion) {
          entries[existingIndex].flaggedForPromotion = true;
          console.log(`[DJAgent] PROMOTION CANDIDATE: "${customTask}" has ${entries[existingIndex].successCount} successes`);
          console.log('[DJAgent] Script to add to applescript-helper.js:');
          console.log('---BEGIN SCRIPT---');
          console.log(script);
          console.log('---END SCRIPT---');
        }
      } else {
        // Add new entry
        entries.push({
          task: normalizedTask,
          originalRequest,
          script,
          successCount: 1,
          failureCount: 0,
          lastUsed: timestamp,
          flaggedForPromotion: false
        });
      }
      
      // Save back to memory
      this._saveCustomScriptEntries(entries);
      await this.memory.save();
      
    } catch (error) {
      console.warn('[DJAgent] Could not track custom script:', error.message);
    }
  },

  /**
   * Track failed custom AppleScript for learning
   * @private
   */
  async _trackCustomScriptFailure(customTask, originalRequest, errorMessage) {
    try {
      if (!this.memory) {
        await this.initialize();
      }

      const normalizedTask = customTask.toLowerCase().trim();
      let customScripts = this.memory.getSection('Custom AppleScripts') || '';
      const entries = this._parseCustomScriptEntries(customScripts);
      
      const existingIndex = entries.findIndex(e => 
        this._tasksAreSimilar(e.task, normalizedTask)
      );
      
      if (existingIndex >= 0) {
        entries[existingIndex].failureCount++;
        entries[existingIndex].lastError = errorMessage;
        this._saveCustomScriptEntries(entries);
        await this.memory.save();
      }
    } catch (error) {
      // Silently fail - tracking is non-critical
    }
  },

  /**
   * Check if two tasks are similar (for pattern matching)
   * @private
   */
  _tasksAreSimilar(task1, task2) {
    // Simple word overlap similarity
    const words1 = new Set(task1.split(/\s+/).filter(w => w.length > 2));
    const words2 = new Set(task2.split(/\s+/).filter(w => w.length > 2));
    
    const intersection = [...words1].filter(w => words2.has(w));
    const union = new Set([...words1, ...words2]);
    
    // Jaccard similarity > 0.5 = similar
    return intersection.length / union.size > 0.5;
  },

  /**
   * Parse custom script entries from memory section
   * @private
   */
  _parseCustomScriptEntries(sectionContent) {
    if (!sectionContent || sectionContent.includes('*No custom')) {
      return [];
    }
    
    try {
      // Try JSON format first
      if (sectionContent.startsWith('[')) {
        return JSON.parse(sectionContent);
      }
    } catch (e) {
      // Not JSON, return empty
    }
    
    return [];
  },

  /**
   * Save custom script entries to memory
   * @private
   */
  _saveCustomScriptEntries(entries) {
    // Keep only last 20 entries to prevent unbounded growth
    const trimmed = entries.slice(-20);
    
    // Sort by success count (most successful first)
    trimmed.sort((a, b) => b.successCount - a.successCount);
    
    this.memory.updateSection('Custom AppleScripts', JSON.stringify(trimmed, null, 2));
  },

  /**
   * Get promotion candidates (scripts ready to be added to pre-built)
   * Can be called to review what should be promoted
   */
  getPromotionCandidates() {
    if (!this.memory) {
      return [];
    }
    
    const customScripts = this.memory.getSection('Custom AppleScripts') || '';
    const entries = this._parseCustomScriptEntries(customScripts);
    
    return entries.filter(e => e.flaggedForPromotion).map(e => ({
      task: e.task,
      originalRequest: e.originalRequest,
      script: e.script,
      successCount: e.successCount,
      failureCount: e.failureCount
    }));
  },

  /**
   * Create a mood-based playlist from the user's library
   * @private
   */
  async _createMoodPlaylist(aiResult, context) {
    const { createMoodPlaylist, runScript } = require('./applescript-helper');
    
    // Set speaker/AirPlay if specified
    if (aiResult.speaker) {
      try {
        console.log('[DJAgent] Setting speaker to:', aiResult.speaker);
        const setAirplayScript = `
          tell application "Music"
            set current AirPlay devices to (AirPlay device "${aiResult.speaker}")
          end tell
        `;
        await runScript(setAirplayScript, 5000);
      } catch (e) {
        console.warn('[DJAgent] Could not set speaker:', e.message);
        // Continue anyway - the music will play on default output
      }
    }
    
    // Generate a playlist name
    const moodOrGenre = aiResult.mood || aiResult.genre || 'Custom';
    const playlistName = `DJ Mix - ${moodOrGenre.charAt(0).toUpperCase() + moodOrGenre.slice(1)}`;
    
    console.log('[DJAgent] Creating playlist:', playlistName);
    console.log('[DJAgent] Criteria:', { mood: aiResult.mood, genre: aiResult.genre, artist: aiResult.artist });
    
    const result = await createMoodPlaylist(playlistName, {
      mood: aiResult.mood,
      genre: aiResult.genre,
      artist: aiResult.artist,
      limit: 25,
      shuffle: true
    });
    
    if (result.success) {
      // VERIFY music actually started playing
      console.log('[DJAgent] Playlist created, verifying playback...');
      let verification = await this._verifyMusicPlaying(2000);
      
      if (!verification.playing && verification.retryNeeded) {
        // Try to force play
        console.log('[DJAgent] Music not playing, attempting force play...');
        await this._forcePlay();
        verification = await this._verifyMusicPlaying(1500);
      }
      
      if (verification.playing) {
        const trackInfo = verification.track ? ` Now playing: ${verification.track}` : '';
        return {
          success: true,
          message: `Created a ${result.trackCount}-track ${moodOrGenre} mix.${trackInfo}`
        };
      }
      
      // Playlist was created but music didn't start - try Apple Music search as backup
      console.log('[DJAgent] Playlist created but music not playing, trying Apple Music...');
    } else {
      // Playlist creation failed
      console.log('[DJAgent] Playlist creation failed, falling back to Apple Music search');
    }
    
    // Generate search terms based on the mood/genre
    const fallbackTerms = [];
    if (aiResult.mood) fallbackTerms.push(`${aiResult.mood} music`, `${aiResult.mood} playlist`);
    if (aiResult.genre) fallbackTerms.push(aiResult.genre, `${aiResult.genre} essentials`);
    if (aiResult.artist) fallbackTerms.push(aiResult.artist);
    
    if (fallbackTerms.length === 0) {
      fallbackTerms.push('chill music', 'popular playlist');
    }
    
    return this._playWithSearchTerms(
      fallbackTerms,
      `I couldn't find enough matching tracks in your library, but I found something similar.`,
      aiResult.speaker
    );
  },
  
  /**
   * Play music with AI-provided search terms
   * Tries each search term until one works
   * Optionally sets the output speaker first
   * @private
   */
  async _playWithSearchTerms(searchTerms, message, speaker = null) {
    const { smartPlayWithSearchTerms, runScript } = require('./applescript-helper');
    
    // Set speaker/AirPlay if specified
    if (speaker) {
      try {
        console.log('[DJAgent] Setting speaker to:', speaker);
        // Try to set AirPlay device
        const setAirplayScript = `
          tell application "Music"
            set current AirPlay devices to (AirPlay device "${speaker}")
          end tell
        `;
        await runScript(setAirplayScript);
        console.log('[DJAgent] Speaker set successfully');
      } catch (e) {
        console.warn('[DJAgent] Could not set speaker:', e.message);
        // Continue anyway - play on default speaker
      }
    }
    
    for (const term of searchTerms) {
      console.log('[DJAgent] Trying search term:', term);
      try {
        const result = await smartPlayWithSearchTerms([term]);
        if (result.success) {
          // VERIFY music actually started
          console.log('[DJAgent] Search succeeded, verifying playback...');
          let verification = await this._verifyMusicPlaying(2500);
          
          if (!verification.playing && verification.retryNeeded) {
            // Try force play
            console.log('[DJAgent] Music not playing after search, forcing play...');
            await this._forcePlay();
            verification = await this._verifyMusicPlaying(1500);
          }
          
          if (verification.playing) {
            // Learn from success
            if (this.memory) {
              try {
                await learnFromInteraction(this.memory, 'dj-agent', {
                  request: term,
                  response: message || 'Playing music',
                  outcome: 'success',
                  speaker: speaker || 'default'
                });
              } catch (e) {
                // Non-fatal
              }
            }
            
            const speakerMsg = speaker ? ` on ${speaker}` : '';
            const trackInfo = verification.track ? `"${verification.track}"` : term;
            return {
              success: true,
              message: message || `Playing ${trackInfo}${speakerMsg}`
            };
          }
          
          // Search said success but music not playing - try next term
          console.log('[DJAgent] Search reported success but music not playing, trying next term...');
        }
      } catch (e) {
        console.warn(`[DJAgent] Search term "${term}" failed:`, e.message);
        // Continue to next term
      }
    }
    
    // All search terms failed - last resort: open Music app and try to play anything
    console.log('[DJAgent] All search terms failed, trying last resort...');
    try {
      await runScript(`
        tell application "Music"
          activate
          delay 1
          -- Try to play something - anything
          try
            play (some track of playlist "Library")
          on error
            play
          end try
        end tell
      `, 10000);
      
      // Verify
      const verification = await this._verifyMusicPlaying(2000);
      if (verification.playing) {
        return {
          success: true,
          message: `I couldn't find exactly what you wanted, but I started playing ${verification.track || 'some music'}`
        };
      }
      
      return {
        success: false,
        message: "I had trouble starting the music. Could you try opening the Music app and playing something manually?"
      };
    } catch (e) {
      return {
        success: false,
        message: "I couldn't get the music playing. Could you try a different request?"
      };
    }
  },
  
  /**
   * Handle response to AI clarification question
   * @private
   */
  async _handleAIClarificationResponse(task, context) {
    const userResponse = task.context?.userInput || task.content;
    const originalRequest = task.context?.originalRequest || '';
    
    // Combine original request with clarification for better context
    const combinedRequest = originalRequest 
      ? `${originalRequest} - ${userResponse}`
      : userResponse;
    
    console.log('[DJAgent] Processing clarification response:', combinedRequest);
    
    // Use AI again with the clarified request
    const aiContext = {
      partOfDay: context.partOfDay,
      memory: this.memory ? this.memory.getSection('Favorite Artists') : null,
      availableSpeakers: await this._getAvailableSpeakers(),
      conversationHistory: `Original request: ${originalRequest}\nClarification: ${userResponse}`
    };
    
    const aiResult = await aiUnderstandMusicRequest(combinedRequest, aiContext);

    // Handle podcast action from clarification
    if (aiResult && (aiResult.action === 'podcast' || aiResult.mediaType === 'podcast')) {
      return this._playPodcast(aiResult.podcastSearch, aiResult.message);
    }

    // Handle playlist action from clarification
    if (aiResult && aiResult.action === 'playlist') {
      return this._createMoodPlaylist(aiResult, context);
    }

    if (aiResult && aiResult.action === 'play' && aiResult.searchTerms?.length > 0) {
      return this._playWithSearchTerms(aiResult.searchTerms, aiResult.message);
    }

    // Still can't understand - one more try or give up
    if (aiResult && aiResult.action === 'clarify') {
      return {
        success: true,
        needsInput: {
          prompt: aiResult.clarificationPrompt || "Could you tell me more about what you'd like to hear?",
          agentId: this.id,
          context: {
            djState: 'awaiting_ai_clarification',
            originalRequest: combinedRequest
          }
        }
      };
    }
    
    // Fall back to just playing something based on time of day
    const fallbackTerms = this._getTimeBasedSearchTerms(context.partOfDay);
    return this._playWithSearchTerms(fallbackTerms, "Let me play something nice for this time of day");
  },
  
  /**
   * Get search terms based on time of day
   * @private
   */
  _getTimeBasedSearchTerms(partOfDay) {
    const timeTerms = {
      morning: ['Morning Coffee', 'Wake Up Happy', 'Acoustic Morning'],
      afternoon: ['Afternoon Chill', 'Focus Flow', 'Productive Pop'],
      evening: ['Evening Jazz', 'Dinner Party', 'Relaxing Evening'],
      night: ['Late Night Vibes', 'Chill Night', 'Peaceful Piano']
    };
    return timeTerms[partOfDay] || timeTerms.afternoon;
  },
  
  /**
   * Detect mood/genre from the user's request (legacy fallback)
   * @private
   * @param {string} lower - Lowercased request text
   * @returns {string|null} - Detected mood or null if none found
   */
  _detectMoodFromRequest(lower) {
    // Map of keywords to mood/genre
    const moodMappings = {
      // Moods
      'mellow': 'Relaxing',
      'chill': 'Relaxing',
      'calm': 'Relaxing',
      'peaceful': 'Relaxing',
      'relaxing': 'Relaxing',
      'relax': 'Relaxing',
      'happy': 'Happy',
      'upbeat': 'Happy',
      'cheerful': 'Happy',
      'energetic': 'Energetic',
      'pump': 'Energetic',
      'workout': 'Energetic',
      'party': 'Energetic',
      'focused': 'Focused',
      'focus': 'Focused',
      'study': 'Focused',
      'concentrate': 'Focused',
      'romantic': 'Romantic',
      'love': 'Romantic',
      'sad': 'Melancholy',
      'melancholy': 'Melancholy',
      // Genres (map to closest mood)
      'jazz': 'Jazz',
      'rock': 'Energetic',
      'pop': 'Happy',
      'classical': 'Focused',
      'electronic': 'Energetic',
      'hip hop': 'Energetic',
      'hip-hop': 'Energetic',
      'country': 'Happy',
      'indie': 'Relaxing',
      'folk': 'Relaxing',
      'blues': 'Melancholy',
      'soul': 'Relaxing',
      'r&b': 'Relaxing',
      'ambient': 'Focused',
      'lofi': 'Focused',
      'lo-fi': 'Focused',
      'lo fi': 'Focused',
    };
    
    for (const [keyword, mood] of Object.entries(moodMappings)) {
      if (lower.includes(keyword)) {
        return mood;
      }
    }
    
    return null;
  },
  
  /**
   * Ask the user about their mood
   * @private
   */
  _askMood(context) {
    const greeting = TIME_GREETINGS[context.partOfDay];
    const suggestedMoods = TIME_MOODS[context.partOfDay];
    
    // Get all available moods
    const allMoods = Object.keys(MOOD_GENRES);
    
    // Format mood options nicely
    const moodOptions = suggestedMoods.map(m => m.charAt(0).toUpperCase() + m.slice(1));
    const otherMoods = allMoods
      .filter(m => !suggestedMoods.includes(m))
      .map(m => m.charAt(0).toUpperCase() + m.slice(1));
    
    return {
      success: true,
      needsInput: {
        prompt: `${greeting}! What mood are you in? ${moodOptions.join(', ')}? Or something else like ${otherMoods.slice(0, 2).join(' or ')}?`,
        field: 'mood',
        options: [...moodOptions, ...otherMoods],
        agentId: 'dj-agent',
        context: {
          djState: 'awaiting_mood',
          timeContext: context
        }
      }
    };
  },
  
  /**
   * Handle the user's mood response and generate options using AI reasoning
   * @private
   */
  async _handleMoodResponse(task, context) {
    const mood = (task.context.userInput || task.content).toLowerCase().trim();
    
    // Get available speakers
    let speakers = ['Computer'];
    try {
      const deviceResult = await mediaAgent.listAirPlayDevices();
      if (deviceResult.devices && deviceResult.devices.length > 0) {
        speakers = deviceResult.devices.map(d => d.name);
      }
    } catch (e) {
      console.log('[DJAgent] Could not get speakers, using default');
    }
    
    // Get memory content for AI context
    let memoryContent = '';
    try {
      if (this.memory) {
        memoryContent = this.memory.getSection('Learned Preferences') || '';
        const history = this.memory.getSection('Recent History') || '';
        if (history && !history.includes('*No history')) {
          memoryContent += '\n\nRecent listening history:\n' + history;
        }
      }
    } catch (e) {
      console.log('[DJAgent] Could not load memory for AI');
    }
    
    // Get conversation history for context
    const conversationText = task.context?.conversationText || 
                            task.metadata?.conversationText || '';
    
    // Try AI reasoning first
    const aiResult = await aiReasonAboutMusic({
      mood,
      partOfDay: context.partOfDay,
      memory: memoryContent,
      availableSpeakers: speakers,
      conversationHistory: conversationText
    });
    
    let options;
    let prompt;
    let normalizedMood = mood;
    
    if (aiResult && aiResult.options && aiResult.options.length > 0) {
      // Use AI-generated options
      console.log('[DJAgent] Using AI-generated recommendations');
      options = aiResult.options.map(opt => ({
        label: opt.label,
        genre: opt.genre,
        speaker: opt.speaker || speakers[0],
        searchTerms: opt.searchTerms || [opt.genre]
      }));
      prompt = aiResult.greeting || `${mood} mood! Here are my AI picks:`;
    } else {
      // Fallback to static mappings
      console.log('[DJAgent] Using fallback static recommendations');
      
      // Normalize mood input
      const moodAliases = {
        'calm': 'relaxing', 'productive': 'focused', 'concentrate': 'focused',
        'upbeat': 'energetic', 'pumped': 'energetic', 'hype': 'energetic',
        'sad': 'melancholy', 'down': 'melancholy', 'love': 'romantic',
        'date': 'romantic', 'dance': 'party', 'fun': 'party', 'celebrate': 'party',
        'coffee': 'cafe', 'coffeeshop': 'cafe', 'lounge': 'cafe',
        'gym': 'workout', 'exercise': 'workout', 'run': 'workout', 'running': 'workout',
        'bed': 'sleep', 'relax': 'relaxing', 'cool': 'chill', 'vibes': 'chill'
      };
      
      for (const [alias, actual] of Object.entries(moodAliases)) {
        if (mood.includes(alias)) {
          normalizedMood = actual;
          break;
        }
      }
      
      if (!MOOD_GENRES[normalizedMood]) {
        normalizedMood = TIME_MOODS[context.partOfDay][0];
      }
      
      const genres = MOOD_GENRES[normalizedMood] || ['Pop', 'Rock', 'Jazz'];
      options = this._generateOptions(normalizedMood, genres, speakers, context);
      prompt = `${normalizedMood.charAt(0).toUpperCase() + normalizedMood.slice(1)} mood, nice! Here are my picks:`;
    }
    
    // Format options for voice
    const optionList = options.map((o, i) => `${i + 1}) ${o.label}`).join(', ');
    
    return {
      success: true,
      needsInput: {
        prompt: `${prompt} ${optionList}. Which sounds good?`,
        field: 'choice',
        options: options.map((o, i) => `${i + 1}`),
        agentId: 'dj-agent',
        context: {
          djState: 'awaiting_choice',
          timeContext: context,
          mood: normalizedMood,
          options: options
        }
      }
    };
  },
  
  /**
   * Generate music options based on mood and context
   * @private
   */
  _generateOptions(mood, genres, speakers, context) {
    const options = [];
    const usedGenres = new Set();
    
    // Option 1: Primary genre on current/default speaker
    const primaryGenre = genres[0];
    usedGenres.add(primaryGenre);
    options.push({
      label: `${primaryGenre} playlist`,
      genre: primaryGenre,
      speaker: speakers[0]
    });
    
    // Option 2: Secondary genre (maybe different speaker if available)
    const secondaryGenre = genres[1] || genres[0];
    const secondSpeaker = speakers.length > 1 ? speakers[1] : speakers[0];
    if (!usedGenres.has(secondaryGenre) || speakers.length > 1) {
      usedGenres.add(secondaryGenre);
      const speakerLabel = speakers.length > 1 ? ` on ${secondSpeaker}` : '';
      options.push({
        label: `${secondaryGenre}${speakerLabel}`,
        genre: secondaryGenre,
        speaker: secondSpeaker
      });
    }
    
    // Option 3: Third genre or mood-based shuffle
    if (genres.length > 2) {
      const thirdGenre = genres[2];
      options.push({
        label: `${thirdGenre} vibes`,
        genre: thirdGenre,
        speaker: speakers[0]
      });
    } else {
      // Offer mood-based playlist as an option
      options.push({
        label: `${mood} mix`,
        genre: mood, // Use mood as genre - smartPlayGenre handles mapping
        speaker: speakers[0]
      });
    }
    
    return options;
  },
  
  /**
   * Handle the user's choice and play music
   * @private
   */
  async _handleChoiceResponse(task, context) {
    const choice = task.context.userInput || task.content;
    const options = task.context.options || [];
    const mood = task.context.mood;
    
    // Parse choice
    let selectedOption = null;
    
    // Try to match by number
    const numMatch = choice.match(/(\d+)/);
    if (numMatch) {
      const num = parseInt(numMatch[1]);
      if (num > 0 && num <= options.length) {
        selectedOption = options[num - 1];
      }
    }
    
    // Try to match by genre name or label
    if (!selectedOption) {
      const lower = choice.toLowerCase();
      selectedOption = options.find(o => 
        (o.genre && lower.includes(o.genre.toLowerCase())) ||
        (o.label && o.label.toLowerCase().includes(lower))
      );
    }
    
    // Default to first option
    if (!selectedOption && options.length > 0) {
      selectedOption = options[0];
    }
    
    if (!selectedOption) {
      return {
        success: false,
        message: "I couldn't understand your choice. Let's start over - just say 'play music' again."
      };
    }
    
    console.log('[DJAgent] Selected option:', JSON.stringify(selectedOption));
    
    // Play the music using intelligent genre-based playback
    let result;
    const { smartPlayGenre, smartPlayWithSearchTerms } = require('./applescript-helper');
    
    // Set AirPlay device if not Computer
    if (selectedOption.speaker && selectedOption.speaker !== 'Computer') {
      try {
        await mediaAgent.setAirPlayDevice(selectedOption.speaker);
        console.log('[DJAgent] Set AirPlay device:', selectedOption.speaker);
      } catch (e) {
        console.log('[DJAgent] Could not set AirPlay device:', e.message);
      }
    }
    
    // Use AI-provided search terms if available, otherwise use genre
    if (selectedOption.searchTerms && selectedOption.searchTerms.length > 0) {
      // AI provided specific playlist/search terms - try each until one works
      console.log('[DJAgent] Using AI search terms:', selectedOption.searchTerms);
      result = await smartPlayWithSearchTerms(selectedOption.searchTerms, 'Music');
    } else {
      // Fallback to genre-based playback
      result = await smartPlayGenre(selectedOption.genre, 'Music');
    }
    
    // Learn from this choice
    await this._learnFromChoice(selectedOption, mood, context);
    
    if (result.success) {
      const source = result.source ? ` from ${result.source}` : '';
      return {
        success: true,
        message: result.message || `Playing ${selectedOption.label}${source}. Enjoy!`
      };
    }
    
    return {
      success: true, // We tried, output might be set
      message: result.message || `I tried to play ${selectedOption.genre}. Check your Apple Music library.`
    };
  },
  
  /**
   * Learn from the user's choice and update preferences
   * @private
   */
  async _learnFromChoice(choice, mood, context) {
    try {
      if (!this.memory) {
        await this.initialize();
      }
      
      // Add to Recent History (with consistent format for parsing)
      const historyEntry = `- ${context.timestamp.split('T')[0]} ${context.partOfDay} | ${mood} | ${choice.genre} on ${choice.speaker} | Liked`;
      this.memory.appendToSection('Recent History', historyEntry, 30);
      
      // Re-evaluate and update preferences based on accumulated patterns
      await this._reEvaluatePreferences(context);
      
      // Save memory (includes both history and updated preferences)
      await this.memory.save();
      
      console.log(`[DJAgent] Learned: ${mood} -> ${choice.genre} on ${choice.speaker} (${context.partOfDay})`);
    } catch (error) {
      console.error('[DJAgent] Error learning from choice:', error);
      // Non-fatal - don't fail the request
    }
  },
  
  /**
   * Get preferences for a specific time of day
   * @param {string} partOfDay - morning, afternoon, evening, night
   * @returns {Object} - { genres, energy, moods }
   */
  getTimePreferences(partOfDay) {
    if (!this.memory || !this.memory.isLoaded()) {
      // Return defaults
      return {
        genres: MOOD_GENRES[TIME_MOODS[partOfDay][0]],
        energy: partOfDay === 'morning' || partOfDay === 'afternoon' ? 'Medium' : 'Low',
        moods: TIME_MOODS[partOfDay]
      };
    }
    
    const prefs = this.memory.getSection('Time-Based Preferences');
    // Parse the markdown section for this time of day
    // For now, return defaults - can be enhanced to parse actual stored prefs
    return {
      genres: MOOD_GENRES[TIME_MOODS[partOfDay][0]],
      energy: 'Medium',
      moods: TIME_MOODS[partOfDay]
    };
  },
  
  // ==================== LEARNING & RE-EVALUATION ====================
  
  /**
   * Parse Recent History markdown into structured entries
   * Format: "- 2026-01-27 afternoon | energetic | Pop on Living Room | Liked"
   * @private
   * @param {string} history - Raw history markdown
   * @returns {Array<Object>} Parsed entries
   */
  _parseHistory(history) {
    if (!history || history.includes('*No history')) {
      return [];
    }
    
    const entries = [];
    const lines = history.split('\n').filter(l => l.trim().startsWith('-'));
    
    for (const line of lines) {
      // Parse: "- 2026-01-27 afternoon | mood | genre on speaker | status"
      // Remove leading "- " and split by "|"
      const content = line.trim().substring(2).trim(); // Remove "- "
      const parts = content.split('|').map(p => p.trim());
      
      if (parts.length >= 4) {
        // First part: "2026-01-27 afternoon"
        const dateTimeParts = parts[0].split(' ').filter(p => p);
        const date = dateTimeParts[0] || '';
        const partOfDay = (dateTimeParts[1] || '').toLowerCase();
        
        // Second part: mood
        const mood = parts[1].toLowerCase();
        
        // Third part: "genre on speaker"
        const genreSpeakerParts = parts[2].split(' on ');
        const genre = (genreSpeakerParts[0] || '').trim();
        const speaker = (genreSpeakerParts[1] || 'Computer').trim();
        
        // Fourth part: status
        const status = parts[3].toLowerCase();
        
        if (date && partOfDay && mood && genre) {
          entries.push({
            date,
            partOfDay,
            mood,
            genre,
            speaker,
            status
          });
        }
      }
    }
    
    return entries;
  },
  
  /**
   * Analyze history entries to find patterns
   * @private
   * @param {Array<Object>} entries - Parsed history entries
   * @returns {Object} Pattern analysis
   */
  _analyzePatterns(entries) {
    const patterns = {
      byTimeAndMood: {},  // { "afternoon_energetic": { genres: {Pop: 3, Electronic: 2}, count: 5 } }
      byTime: {},         // { "afternoon": { genres: {Pop: 5}, moods: {energetic: 3}, count: 8 } }
      bySpeaker: {},      // { "Living Room": { moods: {relaxing: 4}, genres: {Jazz: 3}, count: 7 } }
      genreCounts: {}     // { "Pop": 10, "Jazz": 5 }
    };
    
    for (const entry of entries) {
      // Only count liked entries
      if (entry.status !== 'liked') continue;
      
      // Time + Mood pattern
      const timeMoodKey = `${entry.partOfDay}_${entry.mood}`;
      if (!patterns.byTimeAndMood[timeMoodKey]) {
        patterns.byTimeAndMood[timeMoodKey] = { genres: {}, count: 0 };
      }
      patterns.byTimeAndMood[timeMoodKey].genres[entry.genre] = 
        (patterns.byTimeAndMood[timeMoodKey].genres[entry.genre] || 0) + 1;
      patterns.byTimeAndMood[timeMoodKey].count++;
      
      // Time pattern
      if (!patterns.byTime[entry.partOfDay]) {
        patterns.byTime[entry.partOfDay] = { genres: {}, moods: {}, count: 0 };
      }
      patterns.byTime[entry.partOfDay].genres[entry.genre] = 
        (patterns.byTime[entry.partOfDay].genres[entry.genre] || 0) + 1;
      patterns.byTime[entry.partOfDay].moods[entry.mood] = 
        (patterns.byTime[entry.partOfDay].moods[entry.mood] || 0) + 1;
      patterns.byTime[entry.partOfDay].count++;
      
      // Speaker pattern
      if (entry.speaker !== 'Computer') {
        if (!patterns.bySpeaker[entry.speaker]) {
          patterns.bySpeaker[entry.speaker] = { moods: {}, genres: {}, count: 0 };
        }
        patterns.bySpeaker[entry.speaker].moods[entry.mood] = 
          (patterns.bySpeaker[entry.speaker].moods[entry.mood] || 0) + 1;
        patterns.bySpeaker[entry.speaker].genres[entry.genre] = 
          (patterns.bySpeaker[entry.speaker].genres[entry.genre] || 0) + 1;
        patterns.bySpeaker[entry.speaker].count++;
      }
      
      // Overall genre counts
      patterns.genreCounts[entry.genre] = (patterns.genreCounts[entry.genre] || 0) + 1;
    }
    
    return patterns;
  },
  
  /**
   * Sort object entries by value descending
   * @private
   */
  _sortByCount(obj) {
    return Object.entries(obj)
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => ({ name: key, count }));
  },
  
  /**
   * Update Time-Based Preferences section with learned patterns
   * @private
   * @param {Object} patterns - Analyzed patterns
   * @param {string} timestamp - Current timestamp
   */
  _updateTimePreferences(patterns, timestamp) {
    const dateStr = timestamp.split('T')[0];
    const timeSlots = ['morning', 'afternoon', 'evening', 'night'];
    const timeRanges = {
      morning: '6am-12pm',
      afternoon: '12pm-6pm',
      evening: '6pm-10pm',
      night: '10pm-6am'
    };
    
    const sections = [];
    
    for (const slot of timeSlots) {
      const timeData = patterns.byTime[slot];
      const hasData = timeData && timeData.count >= 3; // Minimum 3 choices to update
      
      // Get top genres and moods
      let topGenres, topMoods, energy;
      
      if (hasData) {
        topGenres = this._sortByCount(timeData.genres).slice(0, 3);
        topMoods = this._sortByCount(timeData.moods).slice(0, 3);
        
        // Determine energy based on genres
        const highEnergyGenres = ['Pop', 'Dance', 'Electronic', 'Rock', 'Hip Hop', 'EDM'];
        const lowEnergyGenres = ['Ambient', 'Classical', 'Lo-fi', 'Chill', 'Jazz'];
        const topGenreNames = topGenres.map(g => g.name);
        
        if (topGenreNames.some(g => highEnergyGenres.includes(g))) {
          energy = topGenreNames.some(g => lowEnergyGenres.includes(g)) ? 'Medium to High' : 'High';
        } else if (topGenreNames.some(g => lowEnergyGenres.includes(g))) {
          energy = 'Low to Medium';
        } else {
          energy = 'Medium';
        }
      } else {
        // Use defaults
        const defaultMood = TIME_MOODS[slot][0];
        topGenres = (MOOD_GENRES[defaultMood] || ['Pop', 'Rock']).slice(0, 3).map(g => ({ name: g, count: 0 }));
        topMoods = TIME_MOODS[slot].map(m => ({ name: m, count: 0 }));
        energy = (slot === 'morning' || slot === 'night') ? 'Low to Medium' : 'Medium to High';
      }
      
      // Format section
      const genreList = topGenres.map(g => g.count > 0 ? `${g.name} (${g.count}x)` : g.name).join(', ');
      const moodList = topMoods.map(m => m.count > 0 ? `${m.name} (${m.count}x)` : m.name).join(', ');
      const updatedNote = hasData ? `*Last updated: ${dateStr}*` : '*Default preferences*';
      
      sections.push(`### ${slot.charAt(0).toUpperCase() + slot.slice(1)} (${timeRanges[slot]})
${updatedNote}
- Genres: ${genreList}
- Energy: ${energy}
- Common moods: ${moodList}`);
    }
    
    this.memory.updateSection('Time-Based Preferences', sections.join('\n\n'));
  },
  
  /**
   * Update Speaker Preferences section with learned patterns
   * @private
   * @param {Object} patterns - Analyzed patterns
   * @param {string} timestamp - Current timestamp
   */
  _updateSpeakerPreferences(patterns, timestamp) {
    const dateStr = timestamp.split('T')[0];
    const speakerData = patterns.bySpeaker;
    
    if (Object.keys(speakerData).length === 0) {
      // No speaker data yet
      return;
    }
    
    const entries = [];
    
    for (const [speaker, data] of Object.entries(speakerData)) {
      if (data.count < 2) continue; // Need at least 2 uses
      
      const topMoods = this._sortByCount(data.moods).slice(0, 2);
      const topGenres = this._sortByCount(data.genres).slice(0, 3);
      
      const moodStr = topMoods.map(m => m.name).join(', ');
      const genreStr = topGenres.map(g => g.name).join(', ');
      
      entries.push(`- ${speaker}: ${moodStr} music, ${genreStr}
  *Learned: ${dateStr} from ${data.count} choices*`);
    }
    
    if (entries.length > 0) {
      this.memory.updateSection('Speaker Preferences', entries.join('\n'));
    }
  },
  
  /**
   * Update Favorite Artists/Genres section
   * @private
   * @param {Object} patterns - Analyzed patterns
   * @param {string} timestamp - Current timestamp
   */
  _updateFavoriteGenres(patterns, timestamp) {
    const dateStr = timestamp.split('T')[0];
    const genreCounts = patterns.genreCounts;
    
    if (Object.keys(genreCounts).length === 0) {
      return;
    }
    
    const topGenres = this._sortByCount(genreCounts).slice(0, 10);
    
    if (topGenres.length > 0 && topGenres[0].count >= 2) {
      const entries = topGenres.map(g => `- ${g.name}: ${g.count} plays`);
      entries.push(`\n*Last updated: ${dateStr}*`);
      this.memory.updateSection('Favorite Artists', entries.join('\n'));
    }
  },
  
  /**
   * Re-evaluate all preferences based on accumulated history
   * Called after each choice is recorded
   * @private
   * @param {Object} context - Current context with timestamp
   */
  async _reEvaluatePreferences(context) {
    try {
      const history = this.memory.getSection('Recent History');
      if (!history) return;
      
      // Parse history into structured entries
      const entries = this._parseHistory(history);
      
      if (entries.length < 3) {
        // Not enough data to re-evaluate
        console.log(`[DJAgent] Not enough history to re-evaluate (${entries.length} entries)`);
        return;
      }
      
      console.log(`[DJAgent] Re-evaluating preferences from ${entries.length} history entries`);
      
      // Analyze patterns
      const patterns = this._analyzePatterns(entries);
      
      // Update preference sections (replaces existing content)
      this._updateTimePreferences(patterns, context.timestamp);
      this._updateSpeakerPreferences(patterns, context.timestamp);
      this._updateFavoriteGenres(patterns, context.timestamp);
      
      console.log('[DJAgent] Preferences re-evaluated and updated');
    } catch (error) {
      console.error('[DJAgent] Error re-evaluating preferences:', error);
      // Non-fatal - don't fail the request
    }
  }
};

module.exports = djAgent;
