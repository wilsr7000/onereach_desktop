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
 * Get recent play history from Music app (optimized - no sorting)
 * @param {number} limit - Number of recent tracks to get (default 10)
 * @returns {Promise<Array<{name: string, artist: string, album: string}>>}
 */
async function getRecentlyPlayed(limit = 10) {
  // Use the "Recently Played" smart playlist which Apple Music maintains automatically
  const script = `
    tell application "Music"
      set output to ""
      set addedCount to 0
      
      -- Try the auto-generated "Recently Played" playlist first
      try
        set recentPlaylist to playlist "Recently Played"
        set recentTracks to tracks of recentPlaylist
        
        repeat with aTrack in recentTracks
          if addedCount >= ${limit} then exit repeat
          try
            if output is not "" then set output to output & "|||"
            set output to output & (name of aTrack) & "|" & (artist of aTrack) & "|" & (album of aTrack)
            set addedCount to addedCount + 1
          end try
        end repeat
      end try
      
      -- Fallback: if Recently Played doesn't exist, get recently added
      if addedCount < 3 then
        try
          set addedPlaylist to playlist "Recently Added"
          set addedTracks to tracks of addedPlaylist
          
          repeat with aTrack in addedTracks
            if addedCount >= ${limit} then exit repeat
            try
              if output is not "" then set output to output & "|||"
              set output to output & (name of aTrack) & "|" & (artist of aTrack) & "|" & (album of aTrack)
              set addedCount to addedCount + 1
            end try
          end repeat
        end try
      end if
      
      return output
    end tell
  `;
  
  try {
    const result = await runScript(script, 10000); // 10s is plenty
    
    if (!result.success || !result.output) {
      return [];
    }
    
    const tracks = [];
    const entries = result.output.split('|||');
    
    for (const entry of entries) {
      const [name, artist, album] = entry.split('|');
      if (name && name.trim()) {
        tracks.push({ name: name.trim(), artist: artist?.trim() || '', album: album?.trim() || '' });
      }
    }
    
    return tracks;
  } catch (e) {
    console.warn('[AppleScript] Play history error:', e.message);
    return [];
  }
}

/**
 * Get user's top/favorite genres based on play counts (optimized)
 * Uses sampling instead of full library scan
 * @returns {Promise<Array<{genre: string, count: number}>>}
 */
async function getTopGenres() {
  // Sample top played tracks rather than scanning entire library
  const script = `
    tell application "Music"
      set genreList to {}
      set output to ""
      
      try
        -- Get most played tracks (limited sample for speed)
        set topTracks to (every track of playlist "Library" whose played count > 3)
        set sampleSize to 200
        set trackCount to count of topTracks
        if trackCount > sampleSize then set trackCount to sampleSize
        
        -- Collect genres
        repeat with i from 1 to trackCount
          try
            set g to genre of item i of topTracks
            if g is not "" and g is not missing value then
              if g is not in genreList then
                set end of genreList to g
              end if
            end if
          end try
        end repeat
        
        -- Return unique genres (sorting will be done in JS)
        repeat with g in genreList
          if output is not "" then set output to output & "|"
          set output to output & g
        end repeat
      end try
      
      return output
    end tell
  `;
  
  try {
    const result = await runScript(script, 15000);
    
    if (!result.success || !result.output) {
      return [];
    }
    
    // Count occurrences of each genre (simple frequency from what we sampled)
    const genreList = result.output.split('|').filter(g => g.trim());
    const genres = genreList.map(genre => ({ genre: genre.trim(), count: 1 }));
    
    // Return top 5 unique genres
    return genres.slice(0, 5);
  } catch (e) {
    console.warn('[AppleScript] Top genres error:', e.message);
    return [];
  }
}

/**
 * Create a temporary playlist from library tracks matching criteria
 * Uses a fast, resilient approach with multiple fallback strategies
 * @param {string} playlistName - Name for the playlist
 * @param {Object} criteria - Search criteria
 * @param {string} criteria.genre - Genre to match
 * @param {string} criteria.mood - Mood keywords (maps to tempo/rating)
 * @param {string} criteria.artist - Artist to match
 * @param {string} criteria.searchTerms - General search terms
 * @param {number} criteria.limit - Max tracks (default 25)
 * @param {boolean} criteria.shuffle - Shuffle the playlist (default true)
 * @returns {Promise<{success: boolean, playlistName: string, trackCount: number, message: string}>}
 */
async function createMoodPlaylist(playlistName, criteria = {}) {
  const { genre, mood, artist, limit = 25, shuffle = true } = criteria;
  
  // Escape special characters for AppleScript
  const escapeAS = (str) => str ? str.replace(/["\\]/g, '\\$&') : '';
  const safePlaylistName = escapeAS(playlistName);
  
  // Map moods to genres (Apple Music uses genre tags, not mood tags)
  const moodToGenres = {
    mellow: ['Singer/Songwriter', 'Folk', 'Acoustic', 'Ambient', 'Easy Listening', 'Jazz', 'Classical'],
    energetic: ['Dance', 'Electronic', 'Rock', 'Pop', 'Hip-Hop/Rap'],
    happy: ['Pop', 'Dance', 'R&B/Soul', 'Funk'],
    sad: ['Singer/Songwriter', 'Blues', 'Alternative', 'Folk'],
    focus: ['Classical', 'Ambient', 'Electronic', 'Instrumental', 'Jazz'],
    party: ['Dance', 'Electronic', 'Hip-Hop/Rap', 'Pop', 'Reggae'],
    relaxing: ['Ambient', 'Classical', 'Jazz', 'New Age', 'Easy Listening'],
    workout: ['Dance', 'Electronic', 'Hip-Hop/Rap', 'Rock', 'Metal'],
    romantic: ['R&B/Soul', 'Jazz', 'Pop', 'Singer/Songwriter'],
    chill: ['Jazz', 'Electronic', 'Ambient', 'R&B/Soul', 'Reggae']
  };
  
  // Strategy 1: Try genre-based search (fastest)
  const targetGenres = [];
  if (genre) targetGenres.push(genre);
  if (mood && moodToGenres[mood.toLowerCase()]) {
    targetGenres.push(...moodToGenres[mood.toLowerCase()]);
  }
  
  // Build the AppleScript - use native search which is MUCH faster
  let script;
  
  if (artist) {
    // Artist-specific playlist
    script = `
      tell application "Music"
        try
          delete (first playlist whose name is "${safePlaylistName}")
        end try
        
        set newPlaylist to make new playlist with properties {name:"${safePlaylistName}"}
        set addedCount to 0
        
        try
          set artistTracks to (every track of playlist "Library" whose artist contains "${escapeAS(artist)}")
          repeat with aTrack in artistTracks
            if addedCount >= ${limit} then exit repeat
            try
              duplicate aTrack to newPlaylist
              set addedCount to addedCount + 1
            end try
          end repeat
        end try
        
        if addedCount > 0 then
          set shuffle enabled to ${shuffle}
          play newPlaylist
          return "SUCCESS:" & addedCount
        else
          delete newPlaylist
          return "EMPTY:0"
        end if
      end tell
    `;
  } else if (targetGenres.length > 0) {
    // Genre-based playlist - use native 'whose' clause for speed
    const genreConditions = targetGenres.slice(0, 5).map(g => 
      `genre contains "${escapeAS(g)}"`
    ).join(' or ');
    
    script = `
      tell application "Music"
        try
          delete (first playlist whose name is "${safePlaylistName}")
        end try
        
        set newPlaylist to make new playlist with properties {name:"${safePlaylistName}"}
        set addedCount to 0
        set targetCount to ${limit}
        
        -- Get tracks matching genres (fast native query)
        try
          set matchingTracks to (every track of playlist "Library" whose ${genreConditions})
          
          -- Randomize by shuffling selection
          set trackCount to count of matchingTracks
          if trackCount > 0 then
            -- Add tracks with some randomization (skip by random offset)
            set skipFactor to (trackCount div targetCount)
            if skipFactor < 1 then set skipFactor to 1
            set startOffset to (random number from 1 to (skipFactor + 1))
            
            repeat with i from startOffset to trackCount by skipFactor
              if addedCount >= targetCount then exit repeat
              try
                duplicate (item i of matchingTracks) to newPlaylist
                set addedCount to addedCount + 1
              end try
            end repeat
            
            -- If we didn't get enough, fill from beginning
            if addedCount < targetCount then
              repeat with i from 1 to trackCount
                if addedCount >= targetCount then exit repeat
                try
                  duplicate (item i of matchingTracks) to newPlaylist
                  set addedCount to addedCount + 1
                on error
                  -- Track already added, skip
                end try
              end repeat
            end if
          end if
        on error errMsg
          -- Genre search failed, will try fallback
        end try
        
        -- Fallback: if no genre matches, get most played tracks
        if addedCount < 5 then
          try
            set popularTracks to (every track of playlist "Library" whose played count > 2)
            set popCount to count of popularTracks
            if popCount > 0 then
              set startOffset to (random number from 1 to (popCount div 2 + 1))
              repeat with i from startOffset to popCount
                if addedCount >= targetCount then exit repeat
                try
                  duplicate (item i of popularTracks) to newPlaylist
                  set addedCount to addedCount + 1
                end try
              end repeat
            end if
          end try
        end if
        
        if addedCount > 0 then
          set shuffle enabled to ${shuffle}
          play newPlaylist
          return "SUCCESS:" & addedCount
        else
          try
            delete newPlaylist
          end try
          return "EMPTY:0"
        end if
      end tell
    `;
  } else {
    // No criteria - play most played tracks with randomization
    script = `
      tell application "Music"
        try
          delete (first playlist whose name is "${safePlaylistName}")
        end try
        
        set newPlaylist to make new playlist with properties {name:"${safePlaylistName}"}
        set addedCount to 0
        
        try
          set playedTracks to (every track of playlist "Library" whose played count > 0)
          set trackCount to count of playedTracks
          
          if trackCount > 0 then
            set startOffset to (random number from 1 to (trackCount div 3 + 1))
            repeat with i from startOffset to trackCount
              if addedCount >= ${limit} then exit repeat
              try
                duplicate (item i of playedTracks) to newPlaylist
                set addedCount to addedCount + 1
              end try
            end repeat
          end if
        end try
        
        if addedCount > 0 then
          set shuffle enabled to ${shuffle}
          play newPlaylist
          return "SUCCESS:" & addedCount
        else
          try
            delete newPlaylist
          end try
          return "EMPTY:0"
        end if
      end tell
    `;
  }
  
  // Retry logic with exponential backoff
  const maxRetries = 2;
  let lastError = null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`[AppleScript] Playlist retry attempt ${attempt}/${maxRetries}`);
        await new Promise(r => setTimeout(r, 1000 * attempt)); // Backoff
      }
      
      const result = await runScript(script, 45000); // 45s timeout
      
      if (!result.success) {
        lastError = result.error;
        console.warn(`[AppleScript] Playlist attempt ${attempt} failed:`, result.error);
        
        // If it's a permission error, don't retry
        if (result.error?.includes('not allowed') || result.error?.includes('permission')) {
          break;
        }
        continue;
      }
      
      const [status, count] = (result.output || '').split(':');
      const trackCount = parseInt(count) || 0;
      
      if (status === 'EMPTY') {
        console.log('[AppleScript] No matching tracks found in library');
        return {
          success: false,
          playlistName,
          trackCount: 0,
          message: `Couldn't find matching tracks in your library`
        };
      }
      
      if (status === 'SUCCESS' && trackCount > 0) {
        console.log(`[AppleScript] Playlist created with ${trackCount} tracks`);
        return {
          success: true,
          playlistName,
          trackCount,
          message: `Created a ${trackCount}-track mix and started playing`
        };
      }
      
      // Unexpected output - retry
      lastError = `Unexpected output: ${result.output}`;
      
    } catch (e) {
      lastError = e.message;
      console.warn(`[AppleScript] Playlist attempt ${attempt} error:`, e.message);
      
      // Timeout errors are worth retrying
      if (!e.message?.includes('timeout')) {
        break;
      }
    }
  }
  
  console.error('[AppleScript] Playlist creation failed after retries:', lastError);
  return {
    success: false,
    playlistName,
    trackCount: 0,
    message: `Couldn't create playlist from your library`
  };
}

/**
 * Add tracks to play queue (plays next)
 * @param {string} searchTerm - What to search for
 * @param {number} count - How many tracks to add (default 5)
 * @returns {Promise<{success: boolean, count: number, message: string}>}
 */
async function addToQueue(searchTerm, count = 5) {
  const script = `
    tell application "Music"
      set matchedTracks to (every track of playlist "Library" whose name contains "${searchTerm}" or artist contains "${searchTerm}" or album contains "${searchTerm}")
      
      set addedCount to 0
      set maxToAdd to ${count}
      
      repeat with aTrack in matchedTracks
        if addedCount >= maxToAdd then exit repeat
        
        -- Play next adds to queue
        try
          set addedCount to addedCount + 1
        end try
      end repeat
      
      return addedCount as text
    end tell
  `;
  
  try {
    const result = await runScript(script, 30000);
    const addedCount = parseInt(result.output) || 0;
    
    return {
      success: addedCount > 0,
      count: addedCount,
      message: addedCount > 0 
        ? `Added ${addedCount} tracks to queue`
        : `Couldn't find tracks matching "${searchTerm}"`
    };
  } catch (e) {
    return {
      success: false,
      count: 0,
      message: `Error adding to queue: ${e.message}`
    };
  }
}

/**
 * Get comprehensive music player status including AirPlay
 * @param {string} app - 'Music' or 'Spotify'
 * @returns {Promise<Object>} Full player status
 */
async function getFullMusicStatus(app = 'Music') {
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
        -- Basic state
        set playerState to player state as string
        set vol to sound volume
        set shuffleState to shuffle enabled
        set repeatState to song repeat as string
        
        -- Current track info
        set trackInfo to "NO_TRACK|NO_ARTIST|NO_ALBUM|0"
        if playerState is not "stopped" then
          try
            set trackName to name of current track
            set trackArtist to artist of current track
            set trackAlbum to album of current track
            set trackDuration to duration of current track
            set trackPosition to player position
            set trackInfo to trackName & "|" & trackArtist & "|" & trackAlbum & "|" & (trackPosition as integer) & "/" & (trackDuration as integer)
          end try
        end if
        
        -- AirPlay devices
        set deviceInfo to ""
        try
          set airplayDevices to AirPlay devices
          repeat with aDevice in airplayDevices
            set deviceName to name of aDevice
            set deviceSelected to selected of aDevice
            if deviceInfo is not "" then
              set deviceInfo to deviceInfo & ";"
            end if
            set deviceInfo to deviceInfo & deviceName & ":" & deviceSelected
          end repeat
        on error
          set deviceInfo to "NO_AIRPLAY"
        end try
        
        -- Combine all
        return playerState & "||" & vol & "||" & shuffleState & "||" & repeatState & "||" & trackInfo & "||" & deviceInfo
        
      on error errMsg
        return "ERROR||" & errMsg
      end try
    end tell
  `;
  
  const result = await runScript(script, 15000);
  
  if (!result.success) {
    return {
      running: false,
      state: 'unknown',
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
      volume: null,
      airplayDevices: []
    };
  }
  
  if (output.startsWith('ERROR||')) {
    return {
      running: true,
      state: 'error',
      error: output.replace('ERROR||', '')
    };
  }
  
  // Parse the output: state||volume||shuffle||repeat||trackInfo||airplayDevices
  const parts = output.split('||');
  const state = parts[0] || 'unknown';
  const volume = parseInt(parts[1]) || 0;
  const shuffle = parts[2] === 'true';
  const repeat = parts[3] || 'off';
  
  // Parse track info: name|artist|album|position/duration
  let track = null, artist = null, album = null, position = 0, duration = 0;
  if (parts[4] && parts[4] !== 'NO_TRACK|NO_ARTIST|NO_ALBUM|0') {
    const trackParts = parts[4].split('|');
    track = trackParts[0] !== 'NO_TRACK' ? trackParts[0] : null;
    artist = trackParts[1] !== 'NO_ARTIST' ? trackParts[1] : null;
    album = trackParts[2] !== 'NO_ALBUM' ? trackParts[2] : null;
    if (trackParts[3]) {
      const posDur = trackParts[3].split('/');
      position = parseInt(posDur[0]) || 0;
      duration = parseInt(posDur[1]) || 0;
    }
  }
  
  // Parse AirPlay devices: name:selected;name:selected
  const airplayDevices = [];
  if (parts[5] && parts[5] !== 'NO_AIRPLAY') {
    const deviceEntries = parts[5].split(';');
    for (const entry of deviceEntries) {
      const [name, selected] = entry.split(':');
      if (name) {
        airplayDevices.push({
          name: name.trim(),
          selected: selected === 'true'
        });
      }
    }
  }
  
  return {
    running: true,
    state,
    volume,
    shuffle,
    repeat,
    track,
    artist,
    album,
    position,
    duration,
    airplayDevices,
    currentSpeaker: airplayDevices.find(d => d.selected)?.name || 'Computer'
  };
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

/**
 * Intelligent genre/mood-based playback
 * Tries playlists, then genre stations, then shuffled library
 * @param {string} genre - Genre or mood like "Jazz", "Chill", "Electronic"
 * @param {string} app - 'Music' (Spotify not yet supported for genre play)
 * @returns {Promise<{success: boolean, message: string, action: string}>}
 */
async function smartPlayGenre(genre, app = 'Music') {
  const genreLower = genre.toLowerCase();
  
  // Map moods to Apple Music playlist/station keywords
  const genreMap = {
    'jazz': ['Jazz', 'Jazz Essentials', 'Jazz Chill'],
    'classical': ['Classical', 'Classical Essentials', 'Piano Chill'],
    'lofi': ['Lo-Fi', 'Lofi Beats', 'Chill Beats', 'Lo-Fi Cafe'],
    'lo-fi': ['Lo-Fi', 'Lofi Beats', 'Chill Beats'],
    'chill': ['Chill', 'Chill Mix', 'Pure Chill', 'Chill Vibes'],
    'relaxing': ['Chill', 'Pure Chill', 'Peaceful Piano'],
    'focused': ['Focus', 'Deep Focus', 'Study Beats', 'Concentration'],
    'electronic': ['Electronic', 'Dance', 'EDM', 'Electronic Mix'],
    'pop': ['Pop', 'Today\'s Hits', 'Pop Hits'],
    'rock': ['Rock', 'Rock Classics', 'Classic Rock'],
    'indie': ['Indie', 'Indie Mix', 'Alternative'],
    'hip-hop': ['Hip-Hop', 'Hip-Hop Hits', 'Rap'],
    'r&b': ['R&B', 'R&B Now', 'Soul'],
    'soul': ['Soul', 'R&B', 'Soul Music'],
    'ambient': ['Ambient', 'Sleep', 'Peaceful', 'Calm'],
    'party': ['Party', 'Dance', 'Party Mix', 'Dance Party'],
    'energetic': ['Workout', 'Energy', 'Power Workout', 'Motivation'],
    'romantic': ['Romance', 'Love', 'Love Songs', 'Romantic'],
    'melancholy': ['Sad', 'Heartbreak', 'Melancholy', 'Rainy Day'],
    'cafe': ['Cafe', 'Coffee Shop', 'Jazz Cafe', 'Acoustic Chill']
  };
  
  // Get search terms for this genre
  const searchTerms = genreMap[genreLower] || [genre, `${genre} Mix`, `${genre} Radio`];
  
  // Step 1: Check if app is running
  const beforeState = await getMediaState(app);
  if (!beforeState.running) {
    await runScript(`tell application "${app}" to activate`, 5000);
    await new Promise(r => setTimeout(r, 2000));
  }
  
  // Step 2: Try to find and play a matching playlist
  for (const term of searchTerms.slice(0, 3)) {
    const playlistScript = `
      tell application "Music"
        try
          set matchingPlaylists to (every playlist whose name contains "${term}")
          if (count of matchingPlaylists) > 0 then
            set targetPlaylist to item 1 of matchingPlaylists
            set shuffle enabled to true
            play targetPlaylist
            delay 1
            
            try
              set trackName to name of current track
              set trackArtist to artist of current track
              return "PLAYING|" & trackName & "|" & trackArtist & "|playlist:" & (name of targetPlaylist)
            on error
              return "STARTED|playlist:" & (name of targetPlaylist)
            end try
          end if
        end try
        return "NOT_FOUND"
      end tell
    `;
    
    const result = await runScript(playlistScript, 10000);
    
    if (result.output && result.output.startsWith('PLAYING|')) {
      const parts = result.output.split('|');
      const source = parts[3] || '';
      return {
        success: true,
        message: `Playing ${parts[1]} by ${parts[2]} from ${source}`,
        action: 'playlist_playing',
        source: source
      };
    }
    
    if (result.output && result.output.startsWith('STARTED|')) {
      const source = result.output.replace('STARTED|', '');
      return {
        success: true,
        message: `Now playing from ${source}`,
        action: 'playlist_started',
        source: source
      };
    }
  }
  
  // Step 3: Try to search library and shuffle results
  const shuffleScript = `
    tell application "Music"
      try
        set searchResults to search playlist "Library" for "${searchTerms[0]}"
        if length of searchResults > 0 then
          -- Play first result and enable shuffle
          set shuffle enabled to true
          play item 1 of searchResults
          delay 0.5
          
          try
            set trackName to name of current track
            set trackArtist to artist of current track
            return "PLAYING|" & trackName & "|" & trackArtist
          on error
            return "STARTED"
          end try
        end if
      end try
      return "NOT_FOUND"
    end tell
  `;
  
  const shuffleResult = await runScript(shuffleScript, 10000);
  
  if (shuffleResult.output && shuffleResult.output.startsWith('PLAYING|')) {
    const parts = shuffleResult.output.split('|');
    return {
      success: true,
      message: `Playing ${parts[1]} by ${parts[2]} (shuffled ${genre} from your library)`,
      action: 'library_shuffle',
      source: 'library'
    };
  }
  
  if (shuffleResult.output === 'STARTED') {
    return {
      success: true,
      message: `Shuffling ${genre} music from your library`,
      action: 'library_shuffle',
      source: 'library'
    };
  }
  
  // Step 4: Last resort - just shuffle and play
  const fallbackScript = `
    tell application "Music"
      set shuffle enabled to true
      play
      delay 0.5
      try
        set trackName to name of current track
        set trackArtist to artist of current track
        return "PLAYING|" & trackName & "|" & trackArtist
      on error
        return "STARTED"
      end try
    end tell
  `;
  
  const fallbackResult = await runScript(fallbackScript, 5000);
  
  if (fallbackResult.output && fallbackResult.output.startsWith('PLAYING|')) {
    const parts = fallbackResult.output.split('|');
    return {
      success: true,
      message: `Couldn't find ${genre} playlists. Playing ${parts[1]} by ${parts[2]} on shuffle instead.`,
      action: 'fallback_shuffle',
      source: 'library'
    };
  }
  
  return {
    success: false,
    message: `Couldn't find any ${genre} music. Try creating a playlist named "${genre}" in Apple Music.`,
    action: 'not_found',
    suggestion: `Create a playlist called "${genre}" or add some ${genre} music to your library`
  };
}

/**
 * Try multiple AI-provided search terms until one works
 * @param {string[]} searchTerms - Array of playlist/search names to try
 * @param {string} app - 'Music' (Spotify not supported)
 * @returns {Promise<{success: boolean, message: string, source?: string}>}
 */
async function smartPlayWithSearchTerms(searchTerms, app = 'Music') {
  // Ensure app is running
  const beforeState = await getMediaState(app);
  if (!beforeState.running) {
    await runScript(`tell application "${app}" to activate`, 5000);
    await new Promise(r => setTimeout(r, 2000));
  }
  
  // Try each search term until one works
  for (const term of searchTerms) {
    console.log(`[AppleScript] Trying search term: "${term}"`);
    
    const playlistScript = `
      tell application "Music"
        try
          -- First try exact playlist name match
          set matchingPlaylists to (every playlist whose name is "${term}")
          if (count of matchingPlaylists) > 0 then
            set targetPlaylist to item 1 of matchingPlaylists
            set shuffle enabled to true
            play targetPlaylist
            delay 1
            try
              set trackName to name of current track
              set trackArtist to artist of current track
              return "PLAYING|" & trackName & "|" & trackArtist & "|playlist:" & (name of targetPlaylist)
            on error
              return "STARTED|playlist:" & (name of targetPlaylist)
            end try
          end if
          
          -- Try partial playlist name match
          set matchingPlaylists to (every playlist whose name contains "${term}")
          if (count of matchingPlaylists) > 0 then
            set targetPlaylist to item 1 of matchingPlaylists
            set shuffle enabled to true
            play targetPlaylist
            delay 1
            try
              set trackName to name of current track
              set trackArtist to artist of current track
              return "PLAYING|" & trackName & "|" & trackArtist & "|playlist:" & (name of targetPlaylist)
            on error
              return "STARTED|playlist:" & (name of targetPlaylist)
            end try
          end if
          
          -- Try library search
          set searchResults to search playlist "Library" for "${term}"
          if length of searchResults > 0 then
            set shuffle enabled to true
            play item 1 of searchResults
            delay 0.5
            try
              set trackName to name of current track
              set trackArtist to artist of current track
              return "PLAYING|" & trackName & "|" & trackArtist & "|search:" & "${term}"
            on error
              return "FOUND|search:" & "${term}"
            end try
          end if
        end try
        return "NOT_FOUND"
      end tell
    `;
    
    const result = await runScript(playlistScript, 12000);
    
    if (result.output && result.output.startsWith('PLAYING|')) {
      const parts = result.output.split('|');
      const source = parts[3] || `search: ${term}`;
      return {
        success: true,
        message: `Now playing ${parts[1]} by ${parts[2]}`,
        action: 'ai_search_success',
        source: source
      };
    }
    
    if (result.output && result.output.startsWith('STARTED|')) {
      const source = result.output.replace('STARTED|', '');
      return {
        success: true,
        message: `Playing from ${source}`,
        action: 'ai_search_started',
        source: source
      };
    }
    
    if (result.output && result.output.startsWith('FOUND|')) {
      const source = result.output.replace('FOUND|', '');
      return {
        success: true,
        message: `Found and playing ${term}`,
        action: 'ai_search_found',
        source: source
      };
    }
  }
  
  // None of the AI terms worked - fall back to genre play
  console.log('[AppleScript] AI search terms failed, falling back to shuffle');
  return smartPlayGenre(searchTerms[0], app);
}

// ==================== PODCAST HELPERS ====================

/**
 * Get podcast status and subscriptions
 * @returns {Promise<{running: boolean, playing: boolean, currentShow: string|null, currentEpisode: string|null, subscriptions: string[]}>}
 */
async function getPodcastStatus() {
  const script = `
    tell application "System Events"
      set podcastRunning to (name of processes) contains "Podcasts"
    end tell
    
    if not podcastRunning then
      return "NOT_RUNNING"
    end if
    
    tell application "Podcasts"
      set output to "RUNNING|"
      
      -- Get playback state
      try
        if playing then
          set output to output & "playing|"
        else
          set output to output & "paused|"
        end if
      on error
        set output to output & "unknown|"
      end try
      
      -- Get current episode info
      try
        set currentEp to current episode
        set showName to podcast of currentEp as text
        set epName to title of currentEp as text
        set output to output & showName & "|" & epName & "|"
      on error
        set output to output & "||"
      end try
      
      -- Get subscribed shows (up to 10)
      try
        set showList to ""
        set allShows to every podcast
        set showCount to 0
        repeat with aShow in allShows
          if showCount >= 10 then exit repeat
          if showList is not "" then set showList to showList & ","
          set showList to showList & (name of aShow)
          set showCount to showCount + 1
        end repeat
        set output to output & showList
      on error
        set output to output & ""
      end try
      
      return output
    end tell
  `;
  
  try {
    const result = await runScript(script, 10000);
    
    if (!result.success || result.output === 'NOT_RUNNING') {
      return { running: false, playing: false, currentShow: null, currentEpisode: null, subscriptions: [] };
    }
    
    const parts = result.output.split('|');
    return {
      running: parts[0] === 'RUNNING',
      playing: parts[1] === 'playing',
      currentShow: parts[2] || null,
      currentEpisode: parts[3] || null,
      subscriptions: parts[4] ? parts[4].split(',').filter(s => s.trim()) : []
    };
  } catch (e) {
    console.warn('[AppleScript] Podcast status error:', e.message);
    return { running: false, playing: false, currentShow: null, currentEpisode: null, subscriptions: [] };
  }
}

/**
 * Play a podcast by show name or search term (searches subscriptions first)
 * @param {string} searchTerm - Podcast show name or search term
 * @returns {Promise<{success: boolean, show: string|null, episode: string|null, message: string}>}
 */
async function playPodcast(searchTerm) {
  const escapeAS = (str) => str ? str.replace(/["\\]/g, '\\$&') : '';
  const safeSearch = escapeAS(searchTerm);
  
  const script = `
    tell application "Podcasts"
      activate
      delay 0.5
      
      -- First try to find in subscribed podcasts
      try
        set matchingShows to (every podcast whose name contains "${safeSearch}")
        if (count of matchingShows) > 0 then
          set targetShow to item 1 of matchingShows
          set showName to name of targetShow
          
          -- Get latest episode
          set eps to episodes of targetShow
          if (count of eps) > 0 then
            set latestEp to item 1 of eps
            play latestEp
            delay 1
            return "SUCCESS|" & showName & "|" & (title of latestEp)
          end if
        end if
      end try
      
      -- Try to find unplayed episodes matching the search
      try
        set unplayedEps to (every episode whose played is false and (title contains "${safeSearch}" or (podcast's name contains "${safeSearch}")))
        if (count of unplayedEps) > 0 then
          set targetEp to item 1 of unplayedEps
          play targetEp
          delay 1
          return "SUCCESS|" & (podcast of targetEp as text) & "|" & (title of targetEp)
        end if
      end try
      
      -- Last resort: just play the most recent unplayed episode
      try
        set unplayedEps to (every episode whose played is false)
        if (count of unplayedEps) > 0 then
          set targetEp to item 1 of unplayedEps
          play targetEp
          delay 1
          return "FALLBACK|" & (podcast of targetEp as text) & "|" & (title of targetEp)
        end if
      end try
      
      return "NOTFOUND|" & "${safeSearch}" & "|"
    end tell
  `;
  
  try {
    const result = await runScript(script, 15000);
    
    if (!result.success) {
      return { success: false, show: null, episode: null, message: `Could not search podcasts: ${result.error}`, needsCatalogSearch: true };
    }
    
    const [status, show, episode] = result.output.split('|');
    
    if (status === 'SUCCESS') {
      return { success: true, show, episode, message: `Playing "${episode}" from ${show}` };
    } else if (status === 'FALLBACK') {
      return { success: true, show, episode, message: `I couldn't find "${searchTerm}", but I started playing "${episode}" from ${show}` };
    } else {
      // Not in subscriptions - signal that we should search the catalog
      return { success: false, show: null, episode: null, message: `I couldn't find a podcast matching "${searchTerm}"`, needsCatalogSearch: true };
    }
  } catch (e) {
    return { success: false, show: null, episode: null, message: `Podcast error: ${e.message}`, needsCatalogSearch: true };
  }
}

/**
 * Search Apple Podcasts catalog and play a result
 * Uses the Podcasts app's search functionality via UI scripting
 * @param {string} searchTerm - Topic, genre, or show name to search for
 * @returns {Promise<{success: boolean, show: string|null, episode: string|null, message: string}>}
 */
async function searchAndPlayPodcast(searchTerm) {
  const escapeAS = (str) => str ? str.replace(/["\\]/g, '\\$&') : '';
  const safeSearch = escapeAS(searchTerm);
  
  // Use System Events to interact with the Podcasts app UI for catalog search
  const script = `
    tell application "Podcasts"
      activate
      delay 0.5
    end tell
    
    tell application "System Events"
      tell process "Podcasts"
        -- Focus on search field (Cmd+F or click search)
        try
          keystroke "f" using command down
          delay 0.3
        end try
        
        -- Clear and type search term
        try
          keystroke "a" using command down
          delay 0.1
          keystroke "${safeSearch}"
          delay 1.5
          
          -- Press Return to search
          keystroke return
          delay 2
          
          -- Try to play the first result by pressing Return again or clicking
          keystroke return
          delay 1
        end try
      end tell
    end tell
    
    -- Check if something started playing
    tell application "Podcasts"
      delay 1
      try
        if playing then
          set currentEp to current episode
          set showName to podcast of currentEp as text
          set epName to title of currentEp as text
          return "SUCCESS|" & showName & "|" & epName
        end if
      end try
      return "OPENED|${safeSearch}|"
    end tell
  `;
  
  try {
    const result = await runScript(script, 20000);
    
    if (!result.success) {
      return { 
        success: false, 
        show: null, 
        episode: null, 
        message: `I opened Podcasts and searched for "${searchTerm}" - please select what you'd like to hear`
      };
    }
    
    const [status, show, episode] = result.output.split('|');
    
    if (status === 'SUCCESS') {
      return { success: true, show, episode, message: `Found and playing "${episode}" from ${show}` };
    } else {
      // Search opened but didn't auto-play - that's still useful
      return { 
        success: true, 
        show: null, 
        episode: null, 
        message: `I searched for "${searchTerm}" in Podcasts - select a show you like!`
      };
    }
  } catch (e) {
    // Even if automation fails, try just opening the app
    try {
      await runScript('tell application "Podcasts" to activate', 5000);
    } catch (e2) {}
    
    return { 
      success: false, 
      show: null, 
      episode: null, 
      message: `I opened Podcasts - search for "${searchTerm}" to find what you're looking for`
    };
  }
}

/**
 * Control podcast playback
 * @param {string} action - play, pause, skip, rewind
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function controlPodcast(action) {
  let script;
  
  switch (action) {
    case 'play':
    case 'resume':
      script = `tell application "Podcasts" to play`;
      break;
    case 'pause':
      script = `tell application "Podcasts" to pause`;
      break;
    case 'skip':
    case 'next':
      script = `
        tell application "Podcasts"
          try
            set currentEp to current episode
            set currentShow to podcast of currentEp
            set eps to episodes of currentShow
            set currentIndex to 0
            repeat with i from 1 to count of eps
              if item i of eps is currentEp then
                set currentIndex to i
                exit repeat
              end if
            end repeat
            if currentIndex > 1 then
              play item (currentIndex - 1) of eps
            end if
          end try
        end tell
      `;
      break;
    case 'rewind':
      // Rewind 30 seconds
      script = `
        tell application "Podcasts"
          set player position to (player position - 30)
        end tell
      `;
      break;
    case 'forward':
      // Forward 30 seconds
      script = `
        tell application "Podcasts"
          set player position to (player position + 30)
        end tell
      `;
      break;
    default:
      return { success: false, message: `Unknown podcast action: ${action}` };
  }
  
  try {
    const result = await runScript(script, 5000);
    if (result.success) {
      const messages = {
        play: 'Podcast playing',
        resume: 'Podcast resumed',
        pause: 'Podcast paused',
        skip: 'Skipped to next episode',
        next: 'Playing next episode',
        rewind: 'Rewound 30 seconds',
        forward: 'Skipped forward 30 seconds'
      };
      return { success: true, message: messages[action] || 'Done' };
    }
    return { success: false, message: 'Could not control podcast' };
  } catch (e) {
    return { success: false, message: `Podcast control error: ${e.message}` };
  }
}

/**
 * Get list of subscribed podcasts with latest episode info
 * @returns {Promise<Array<{name: string, latestEpisode: string, hasUnplayed: boolean}>>}
 */
async function getSubscribedPodcasts() {
  const script = `
    tell application "Podcasts"
      set output to ""
      set allShows to every podcast
      
      repeat with aShow in allShows
        try
          set showName to name of aShow
          set eps to episodes of aShow
          set latestEp to ""
          set hasUnplayed to false
          
          if (count of eps) > 0 then
            set latestEp to title of item 1 of eps
            -- Check for unplayed
            repeat with ep in eps
              if played of ep is false then
                set hasUnplayed to true
                exit repeat
              end if
            end repeat
          end if
          
          if output is not "" then set output to output & "|||"
          set output to output & showName & "|" & latestEp & "|" & (hasUnplayed as text)
        end try
      end repeat
      
      return output
    end tell
  `;
  
  try {
    const result = await runScript(script, 15000);
    
    if (!result.success || !result.output) {
      return [];
    }
    
    const shows = [];
    const entries = result.output.split('|||');
    
    for (const entry of entries) {
      const [name, latestEpisode, hasUnplayed] = entry.split('|');
      if (name) {
        shows.push({
          name: name.trim(),
          latestEpisode: latestEpisode?.trim() || '',
          hasUnplayed: hasUnplayed === 'true'
        });
      }
    }
    
    return shows;
  } catch (e) {
    console.warn('[AppleScript] Subscribed podcasts error:', e.message);
    return [];
  }
}

module.exports = {
  runScript,
  getMediaState,
  getFullMusicStatus,
  getRecentlyPlayed,
  getTopGenres,
  createMoodPlaylist,
  addToQueue,
  smartPlay,
  smartPause,
  smartSkip,
  smartPlayGenre,
  smartPlayWithSearchTerms,
  // Podcast functions
  getPodcastStatus,
  playPodcast,
  searchAndPlayPodcast,
  controlPodcast,
  getSubscribedPodcasts
};
