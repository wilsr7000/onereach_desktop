/**
 * AppleScript Helper
 * 
 * Generates dynamic AppleScripts that return structured feedback,
 * allowing agents to understand what happened and retry if needed.
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

/**
 * Execute an AppleScript and return structured result
 * @param {string} script - AppleScript code
 * @param {number} timeout - Timeout in ms
 * @returns {Promise<{success: boolean, output: string, error: string|null}>}
 */
async function runScript(script, timeout = 10000) {
  try {
    const escapedScript = script.replace(/'/g, "'\"'\"'");
    const { stdout, stderr } = await execAsync(`osascript -e '${escapedScript}'`, { timeout });
    return {
      success: true,
      output: stdout.trim(),
      error: null
    };
  } catch (error) {
    return {
      success: false,
      output: '',
      error: error.message || 'AppleScript execution failed'
    };
  }
}

/**
 * Get detailed state of a media app
 * @param {string} app - 'Music' or 'Spotify'
 * @returns {Promise<{running: boolean, state: string, track: string|null, artist: string|null, hasContent: boolean}>}
 */
async function getMediaState(app = 'Music') {
  const script = `
    set output to ""
    tell application "System Events"
      set appRunning to (name of processes) contains "${app}"
    end tell
    
    if not appRunning then
      return "NOT_RUNNING"
    end if
    
    tell application "${app}"
      try
        set playerState to player state as string
        set output to playerState
        
        if playerState is not "stopped" then
          try
            set trackName to name of current track
            set trackArtist to artist of current track
            set output to output & "|" & trackName & "|" & trackArtist
          on error
            set output to output & "|NO_TRACK|NO_ARTIST"
          end try
        else
          set output to output & "|NO_TRACK|NO_ARTIST"
        end if
      on error errMsg
        set output to "ERROR|" & errMsg
      end try
    end tell
    
    return output
  `;
  
  const result = await runScript(script);
  
  if (!result.success) {
    return {
      running: false,
      state: 'unknown',
      track: null,
      artist: null,
      hasContent: false,
      error: result.error
    };
  }
  
  const output = result.output;
  
  if (output === 'NOT_RUNNING') {
    return {
      running: false,
      state: 'not_running',
      track: null,
      artist: null,
      hasContent: false
    };
  }
  
  if (output.startsWith('ERROR|')) {
    return {
      running: true,
      state: 'error',
      track: null,
      artist: null,
      hasContent: false,
      error: output.replace('ERROR|', '')
    };
  }
  
  const parts = output.split('|');
  const state = parts[0] || 'unknown';
  const track = parts[1] !== 'NO_TRACK' ? parts[1] : null;
  const artist = parts[2] !== 'NO_ARTIST' ? parts[2] : null;
  
  return {
    running: true,
    state,
    track,
    artist,
    hasContent: track !== null
  };
}

/**
 * Smart play command with pre-checks and feedback
 * @param {string} app - 'Music' or 'Spotify'
 * @param {string|null} query - Optional search query
 * @returns {Promise<{success: boolean, message: string, action: string, canRetry: boolean, suggestion: string|null}>}
 */
async function smartPlay(app = 'Music', query = null) {
  // Step 1: Check current state
  const beforeState = await getMediaState(app);
  
  // Not running - try to open
  if (!beforeState.running) {
    const openResult = await runScript(`
      tell application "${app}" to activate
      delay 2
      tell application "${app}" to play
    `, 15000);
    
    if (!openResult.success) {
      return {
        success: false,
        message: `${app} couldn't be opened`,
        action: 'open_failed',
        canRetry: false,
        suggestion: `Make sure ${app} is installed`
      };
    }
    
    // Check if it worked
    const afterOpen = await getMediaState(app);
    if (afterOpen.state === 'playing') {
      return {
        success: true,
        message: afterOpen.track ? `Now playing "${afterOpen.track}" by ${afterOpen.artist}` : `${app} is now playing`,
        action: 'opened_and_playing',
        canRetry: false,
        suggestion: null
      };
    }
    
    return {
      success: false,
      message: `${app} opened but nothing is playing`,
      action: 'opened_no_content',
      canRetry: true,
      suggestion: `Try saying "play [song name]" or open ${app} and select some music first`
    };
  }
  
  // If user requested specific content, ALWAYS search for it (don't shortcut)
  if (query) {
    // Search and play specific content - with smart matching
    const searchQuery = query.replace(/"/g, '\\"').replace(/'/g, '');
    const searchScript = app === 'Music' 
      ? `
        tell application "Music"
          set searchResults to search playlist "Library" for "${searchQuery}"
          if length of searchResults = 0 then
            return "NOT_FOUND"
          end if
          
          -- Try to find exact or best match
          set bestMatch to item 1 of searchResults
          set searchLower to "${searchQuery.toLowerCase()}"
          
          repeat with aTrack in searchResults
            set trackName to name of aTrack
            set trackLower to do shell script "echo " & quoted form of trackName & " | tr '[:upper:]' '[:lower:]'"
            
            -- Exact match takes priority
            if trackLower is searchLower then
              set bestMatch to aTrack
              exit repeat
            end if
            
            -- Track name contains search term
            if trackLower contains searchLower then
              set bestMatch to aTrack
              exit repeat
            end if
          end repeat
          
          play bestMatch
          delay 0.5
          
          -- Return what's actually playing for verification
          try
            set nowPlaying to name of current track
            set nowArtist to artist of current track
            return "PLAYING|" & nowPlaying & "|" & nowArtist
          on error
            return "FOUND"
          end try
        end tell
      `
      : `
        tell application "Spotify" to activate
        delay 0.5
        tell application "System Events"
          keystroke "l" using command down
          delay 0.2
          keystroke "${query.replace(/"/g, '\\"')}"
          delay 1.5
          keystroke return
        end tell
        return "SEARCHED"
      `;
    
    const searchResult = await runScript(searchScript, 20000);
    
    if (searchResult.output === 'NOT_FOUND') {
      return {
        success: false,
        message: `Couldn't find "${query}" in your library`,
        action: 'search_no_results',
        canRetry: true,
        suggestion: `Try a different search term, or make sure the song is in your ${app} library`
      };
    }
    
    // Parse the PLAYING|trackName|artist response
    if (searchResult.output?.startsWith('PLAYING|')) {
      const parts = searchResult.output.split('|');
      const nowPlaying = parts[1] || '';
      const nowArtist = parts[2] || '';
      
      // Verify we're playing something close to what was requested
      const queryLower = query.toLowerCase();
      const trackLower = nowPlaying.toLowerCase();
      
      const isMatch = trackLower.includes(queryLower) || queryLower.includes(trackLower);
      
      if (isMatch) {
        return {
          success: true,
          message: `Now playing "${nowPlaying}" by ${nowArtist}`,
          action: 'search_playing',
          canRetry: false,
          suggestion: null
        };
      } else {
        // Found something but not what was requested
        return {
          success: false,
          message: `Searched for "${query}" but playing "${nowPlaying}" instead`,
          action: 'search_wrong_track',
          canRetry: true,
          nowPlaying,
          nowArtist,
          suggestion: `"${query}" may not be in your library. Playing closest match.`
        };
      }
    }
    
    // Fallback: check state
    await new Promise(r => setTimeout(r, 500));
    const afterSearch = await getMediaState(app);
    
    if (afterSearch.state === 'playing') {
      // Verify track matches
      const queryLower = query.toLowerCase();
      const trackLower = (afterSearch.track || '').toLowerCase();
      const isMatch = trackLower.includes(queryLower) || queryLower.includes(trackLower);
      
      if (isMatch) {
        return {
          success: true,
          message: `Now playing "${afterSearch.track}" by ${afterSearch.artist}`,
          action: 'search_playing',
          canRetry: false,
          suggestion: null
        };
      } else {
        return {
          success: false,
          message: `Searched for "${query}" but playing "${afterSearch.track}" instead`,
          action: 'search_wrong_track',
          canRetry: true,
          suggestion: `"${query}" may not be in your library`
        };
      }
    }
    
    return {
      success: false,
      message: `Searched for "${query}" but playback didn't start`,
      action: 'search_no_play',
      canRetry: true,
      suggestion: 'Try playing it manually or check if the song is available'
    };
  }
  
  // Generic play - just try
  await runScript(`tell application "${app}" to play`);
  const afterPlay = await getMediaState(app);
  
  if (afterPlay.state === 'playing') {
    return {
      success: true,
      message: afterPlay.track 
        ? `Now playing "${afterPlay.track}" by ${afterPlay.artist}`
        : 'Music is now playing',
      action: 'generic_playing',
      canRetry: false,
      suggestion: null
    };
  }
  
  return {
    success: false,
    message: `${app} is open but there's nothing to play`,
    action: 'no_content',
    canRetry: true,
    suggestion: `Open ${app} and add some music to your library or queue, then try again`
  };
}

/**
 * Smart pause with feedback
 */
async function smartPause(app = 'Music') {
  const beforeState = await getMediaState(app);
  
  if (!beforeState.running) {
    return {
      success: false,
      message: `${app} isn't running`,
      action: 'not_running',
      canRetry: false
    };
  }
  
  if (beforeState.state === 'paused' || beforeState.state === 'stopped') {
    return {
      success: true,
      message: 'Already paused',
      action: 'already_paused',
      canRetry: false
    };
  }
  
  await runScript(`tell application "${app}" to pause`);
  
  return {
    success: true,
    message: beforeState.track ? `Paused "${beforeState.track}"` : 'Paused',
    action: 'paused',
    previousTrack: beforeState.track,
    previousArtist: beforeState.artist,
    canRetry: false
  };
}

/**
 * Smart skip with feedback
 */
async function smartSkip(app = 'Music') {
  const beforeState = await getMediaState(app);
  
  if (!beforeState.running || beforeState.state === 'stopped') {
    return {
      success: false,
      message: `Nothing is playing to skip`,
      action: 'nothing_playing',
      canRetry: false,
      suggestion: 'Start playing music first'
    };
  }
  
  const previousTrack = beforeState.track;
  await runScript(`tell application "${app}" to next track`);
  
  await new Promise(r => setTimeout(r, 500));
  const afterState = await getMediaState(app);
  
  if (afterState.track && afterState.track !== previousTrack) {
    return {
      success: true,
      message: `Skipped to "${afterState.track}" by ${afterState.artist}`,
      action: 'skipped',
      canRetry: false
    };
  }
  
  if (afterState.state === 'stopped') {
    return {
      success: true,
      message: 'Reached end of playlist',
      action: 'end_of_playlist',
      canRetry: false
    };
  }
  
  return {
    success: true,
    message: 'Skipped to next track',
    action: 'skipped',
    canRetry: false
  };
}

module.exports = {
  runScript,
  getMediaState,
  smartPlay,
  smartPause,
  smartSkip
};
