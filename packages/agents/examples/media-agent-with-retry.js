/**
 * Example: Media Agent with Agentic Retry
 * 
 * Shows how to use the agentic-retry template to add
 * reasoning-based retries to any agent.
 */

const { withAgenticRetry } = require('../agentic-retry');
const { smartPlay, smartPause, smartSkip, getMediaState, runScript } = require('../applescript-helper');

// Base media agent (simple version)
const baseMediaAgent = {
  id: 'media-agent',
  name: 'Media Agent',
  description: 'Controls Music and Spotify',
  
  bid(task) {
    const lower = task?.content?.toLowerCase() || '';
    if (['play', 'pause', 'skip', 'music'].some(k => lower.includes(k))) {
      return { confidence: 0.9 };
    }
    return null;
  },
  
  async execute(task) {
    const lower = task.content.toLowerCase();
    const app = lower.includes('spotify') ? 'Spotify' : 'Music';
    
    // Use extracted intent if available (from agentic retry)
    const intent = task.extractedIntent?.parsed || {};
    const searchTerm = intent.searchTerm || intent.genre || intent.artist;
    
    if (lower.includes('play')) {
      const result = await smartPlay(app, searchTerm);
      return {
        success: result.success,
        message: result.message,
        canRetry: result.canRetry,
        context: { app, searchTerm }
      };
    }
    
    if (lower.includes('pause')) {
      const result = await smartPause(app);
      return { success: result.success, message: result.message };
    }
    
    if (lower.includes('skip')) {
      const result = await smartSkip(app);
      return { success: result.success, message: result.message };
    }
    
    return { success: false, message: 'Unknown command' };
  }
};

// Wrap with agentic retry
const mediaAgentWithRetry = withAgenticRetry(baseMediaAgent, {
  domain: 'music',
  maxAttempts: 4,
  
  // Only use retry for play commands
  shouldRetry: (task) => task.content?.toLowerCase().includes('play'),
  
  // Available retry actions
  actions: [
    {
      name: 'refine_query',
      description: 'Try a different/simpler search term',
      handler: async (params, extracted) => {
        const app = params.app || 'Music';
        const result = await smartPlay(app, params.query);
        return {
          success: result.success,
          message: result.message,
          canRetry: result.canRetry
        };
      }
    },
    {
      name: 'try_genre',
      description: 'Search by genre instead of specific term',
      handler: async (params, extracted) => {
        const genre = params.genre || extracted.parsed?.genre;
        if (!genre) return { success: false, message: 'No genre identified', canRetry: true };
        
        const result = await smartPlay(params.app || 'Music', genre);
        return {
          success: result.success,
          message: result.message,
          canRetry: result.canRetry
        };
      }
    },
    {
      name: 'try_alternate_app',
      description: 'Switch from Music to Spotify or vice versa',
      handler: async (params, extracted) => {
        const currentApp = params.currentApp || 'Music';
        const altApp = currentApp === 'Music' ? 'Spotify' : 'Music';
        const searchTerm = extracted.parsed?.searchTerm || extracted.parsed?.genre;
        
        const result = await smartPlay(altApp, searchTerm);
        return {
          success: result.success,
          message: result.success ? `${result.message} (using ${altApp})` : result.message,
          canRetry: result.canRetry
        };
      }
    },
    {
      name: 'shuffle_library',
      description: 'Just play random music from library',
      handler: async (params) => {
        const app = params.app || 'Music';
        try {
          if (app === 'Music') {
            await runScript(`
              tell application "Music"
                set shuffle enabled to true
                play playlist "Library"
              end tell
            `);
          } else {
            await runScript(`
              tell application "Spotify"
                set shuffling to true
                play
              end tell
            `);
          }
          
          // Verify it worked
          await new Promise(r => setTimeout(r, 1000));
          const state = await getMediaState(app);
          
          if (state.state === 'playing') {
            return {
              success: true,
              message: state.track 
                ? `Shuffling library. Now playing "${state.track}"`
                : `Shuffling your ${app} library`
            };
          }
          return { success: false, message: 'Shuffle did not start', canRetry: true };
        } catch (e) {
          return { success: false, message: e.message, canRetry: true };
        }
      }
    }
  ]
});

module.exports = mediaAgentWithRetry;


// ============ USAGE EXAMPLE ============
/*

// Import the wrapped agent
const mediaAgent = require('./examples/media-agent-with-retry');

// Use it like any other agent
const result = await mediaAgent.execute({
  content: 'play some jazz'
});

// The agentic retry will:
// 1. Extract intent: { searchTerm: 'jazz', genre: 'jazz' }
// 2. Try initial: smartPlay('Music', 'jazz')
// 3. If failed, LLM decides next step (not deterministic!)
// 4. Maybe: try_alternate_app → shuffle_library → ask_user
// 5. Return final result with reasoning chain

console.log(result);
// {
//   success: true,
//   message: "Now playing jazz",
//   attempts: 2,
//   reasoning: "initial → try_genre"
// }

*/
