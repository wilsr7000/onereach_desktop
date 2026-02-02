/**
 * Smart AppleScript Executor
 * 
 * An intelligent, self-correcting AppleScript execution engine that:
 * 1. Understands the intent and generates appropriate scripts
 * 2. Executes with detailed feedback capture
 * 3. Categorizes errors and applies targeted fixes
 * 4. Verifies the action actually accomplished the goal
 * 5. Learns from failures to avoid repeating mistakes
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const fs = require('fs');
const os = require('os');
const path = require('path');

// Get API key from app settings
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

// ============================================================================
// ERROR CATEGORIZATION
// ============================================================================

const ERROR_TYPES = {
  APP_NOT_RUNNING: 'app_not_running',
  APP_NOT_INSTALLED: 'app_not_installed',
  PERMISSION_DENIED: 'permission_denied',
  SYNTAX_ERROR: 'syntax_error',
  PROPERTY_NOT_FOUND: 'property_not_found',
  CONNECTION_INVALID: 'connection_invalid',
  TIMEOUT: 'timeout',
  NO_CONTENT: 'no_content',
  UNKNOWN: 'unknown'
};

/**
 * Categorize an AppleScript error for targeted fixing
 */
function categorizeError(error) {
  const e = error.toLowerCase();
  
  if (e.includes('not running') || e.includes('isn\'t running')) {
    return { type: ERROR_TYPES.APP_NOT_RUNNING, fixStrategy: 'activate_app' };
  }
  if (e.includes('not find application') || e.includes('can\'t find application')) {
    return { type: ERROR_TYPES.APP_NOT_INSTALLED, fixStrategy: 'none', unfixable: true };
  }
  if (e.includes('not allowed') || e.includes('permission') || e.includes('access')) {
    return { type: ERROR_TYPES.PERMISSION_DENIED, fixStrategy: 'request_permission', unfixable: true };
  }
  if (e.includes('syntax error') || e.includes('expected') || e.includes('can\'t continue')) {
    return { type: ERROR_TYPES.SYNTAX_ERROR, fixStrategy: 'rewrite_script' };
  }
  if (e.includes('can\'t get') || e.includes('doesn\'t understand')) {
    return { type: ERROR_TYPES.PROPERTY_NOT_FOUND, fixStrategy: 'add_existence_check' };
  }
  if (e.includes('connection is invalid') || e.includes('lost connection')) {
    return { type: ERROR_TYPES.CONNECTION_INVALID, fixStrategy: 'reconnect_app' };
  }
  if (e.includes('timeout') || e.includes('timed out')) {
    return { type: ERROR_TYPES.TIMEOUT, fixStrategy: 'simplify_or_increase_delay' };
  }
  if (e.includes('no track') || e.includes('nothing to') || e.includes('empty')) {
    return { type: ERROR_TYPES.NO_CONTENT, fixStrategy: 'check_content_first' };
  }
  
  return { type: ERROR_TYPES.UNKNOWN, fixStrategy: 'llm_analyze' };
}

// ============================================================================
// SCRIPT EXECUTION WITH RICH FEEDBACK
// ============================================================================

/**
 * Execute an AppleScript with detailed result capture
 */
async function runAppleScript(script, options = {}) {
  const { timeout = 15000, captureState = false, app = null } = options;
  
  // Optionally capture state before execution
  let stateBefore = null;
  if (captureState && app) {
    stateBefore = await getAppState(app);
  }
  
  try {
    // Write to temp file to avoid escaping issues
    const tempFile = path.join(os.tmpdir(), `applescript_${Date.now()}.scpt`);
    fs.writeFileSync(tempFile, script);
    
    const startTime = Date.now();
    
    try {
      const { stdout, stderr } = await execAsync(`osascript "${tempFile}"`, { timeout });
      const duration = Date.now() - startTime;
      
      fs.unlinkSync(tempFile);
      
      // Capture state after execution
      let stateAfter = null;
      if (captureState && app) {
        stateAfter = await getAppState(app);
      }
      
      return {
        success: true,
        output: stdout.trim(),
        stderr: stderr.trim(),
        error: null,
        duration,
        stateBefore,
        stateAfter,
        stateChanged: stateBefore && stateAfter ? 
          JSON.stringify(stateBefore) !== JSON.stringify(stateAfter) : null
      };
    } catch (execError) {
      fs.unlinkSync(tempFile);
      throw execError;
    }
  } catch (error) {
    const errorInfo = categorizeError(error.message || error.stderr || '');
    
    return {
      success: false,
      output: '',
      stderr: error.stderr || '',
      error: error.message || 'Unknown error',
      errorType: errorInfo.type,
      fixStrategy: errorInfo.fixStrategy,
      unfixable: errorInfo.unfixable || false,
      stateBefore
    };
  }
}

/**
 * Get the current state of an application
 */
async function getAppState(app) {
  const stateScript = `
    set output to ""
    tell application "System Events"
      set isRunning to (name of processes) contains "${app}"
    end tell
    
    if not isRunning then
      return "NOT_RUNNING"
    end if
    
    tell application "${app}"
      try
        if "${app}" is "Music" or "${app}" is "Spotify" then
          set playerState to player state as string
          set output to playerState
          if playerState is not "stopped" then
            try
              set trackName to name of current track
              set trackArtist to artist of current track
              set output to output & "|" & trackName & "|" & trackArtist
            end try
          end if
        else
          set output to "RUNNING"
        end if
      on error
        set output to "RUNNING_UNKNOWN_STATE"
      end try
    end tell
    return output
  `;
  
  try {
    const tempFile = path.join(os.tmpdir(), `state_${Date.now()}.scpt`);
    fs.writeFileSync(tempFile, stateScript);
    const { stdout } = await execAsync(`osascript "${tempFile}"`, { timeout: 5000 });
    fs.unlinkSync(tempFile);
    
    const output = stdout.trim();
    if (output === 'NOT_RUNNING') {
      return { running: false, state: 'not_running' };
    }
    
    const parts = output.split('|');
    return {
      running: true,
      state: parts[0] || 'unknown',
      track: parts[1] || null,
      artist: parts[2] || null
    };
  } catch {
    return { running: false, state: 'error' };
  }
}

// ============================================================================
// INTELLIGENT SCRIPT GENERATION
// ============================================================================

/**
 * Generate an AppleScript with comprehensive error handling
 */
async function generateScript(intent, context = {}) {
  const apiKey = getOpenAIApiKey();
  if (!apiKey) {
    throw new Error('OpenAI API key required for script generation');
  }

  const { 
    previousAttempts = [], 
    targetApp = null,
    currentState = null,
    constraints = []
  } = context;

  const systemPrompt = `You are an expert AppleScript developer. Generate robust, production-quality AppleScript code.

CRITICAL RULES:
1. Return ONLY valid AppleScript code - no markdown, no explanation
2. ALWAYS include comprehensive error handling (try/on error)
3. ALWAYS return a descriptive result string
4. ALWAYS verify the action succeeded after performing it
5. Handle edge cases: app not running, no content, permissions

REQUIRED PATTERN:
\`\`\`
-- Check prerequisites
tell application "System Events"
  set appRunning to (name of processes) contains "AppName"
end tell

if not appRunning then
  tell application "AppName" to activate
  delay 1
end if

-- Perform action with verification
tell application "AppName"
  try
    -- Do the thing
    -- Verify it worked
    -- Return what happened
  on error errMsg
    return "ERROR: " & errMsg
  end try
end tell
\`\`\`

VERIFICATION IS MANDATORY:
- After "play", check player state is "playing"
- After "pause", check player state is "paused"  
- After search, check if results were found
- After any action, confirm the expected state change occurred

${previousAttempts.length > 0 ? `
PREVIOUS FAILED ATTEMPTS (avoid these mistakes):
${previousAttempts.map((a, i) => `${i + 1}. Script failed with: ${a.error}`).join('\n')}
` : ''}

${currentState ? `CURRENT APP STATE: ${JSON.stringify(currentState)}` : ''}
${constraints.length > 0 ? `CONSTRAINTS: ${constraints.join(', ')}` : ''}`;

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
        { role: 'user', content: `Generate AppleScript to: ${intent}` }
      ],
      temperature: 0.1,
      max_tokens: 1500
    })
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  const data = await response.json();
  let script = data.choices?.[0]?.message?.content || '';
  
  // Clean up any markdown
  script = script.replace(/^```applescript\n?/i, '').replace(/^```\n?/i, '').replace(/\n?```$/gi, '');
  
  return script.trim();
}

// ============================================================================
// INTELLIGENT ERROR ANALYSIS AND FIXING
// ============================================================================

/**
 * Analyze an error with full context and generate a targeted fix
 */
async function analyzeAndFix(context) {
  const apiKey = getOpenAIApiKey();
  if (!apiKey) {
    throw new Error('OpenAI API key required for error analysis');
  }

  const { 
    originalScript, 
    error, 
    errorType,
    fixStrategy,
    intent, 
    stateBefore,
    previousFixes = []
  } = context;

  // Quick fixes for known error types
  if (fixStrategy === 'activate_app' && !previousFixes.includes('activate_app')) {
    // Extract app name and add activation
    const appMatch = originalScript.match(/tell application "([^"]+)"/);
    if (appMatch) {
      const app = appMatch[1];
      const fixedScript = `
tell application "${app}" to activate
delay 1.5
${originalScript}`;
      return {
        fixedScript,
        explanation: `Added app activation for ${app}`,
        canFix: true,
        fixApplied: 'activate_app'
      };
    }
  }

  // Use LLM for complex fixes
  const systemPrompt = `You are an AppleScript debugger. Analyze and fix the script.

ERROR TYPE: ${errorType}
SUGGESTED STRATEGY: ${fixStrategy}

${previousFixes.length > 0 ? `ALREADY TRIED FIXES: ${previousFixes.join(', ')} - try something different` : ''}

Return JSON:
{
  "fixedScript": "the complete corrected AppleScript (no markdown)",
  "explanation": "what was wrong and how you fixed it",
  "canFix": true/false,
  "fixApplied": "brief name for this fix strategy"
}

UNFIXABLE situations (set canFix: false):
- App not installed
- Permission denied by macOS
- Hardware not available
- User intervention required

For all other errors, provide a fix. Be creative but practical.`;

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
        { role: 'user', content: `Intent: ${intent}

Script that failed:
${originalScript}

Error: ${error}

${stateBefore ? `State before execution: ${JSON.stringify(stateBefore)}` : ''}` }
      ],
      temperature: 0.2,
      max_tokens: 2000,
      response_format: { type: 'json_object' }
    })
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  const data = await response.json();
  const result = JSON.parse(data.choices?.[0]?.message?.content || '{}');
  
  // Clean up script if needed
  if (result.fixedScript) {
    result.fixedScript = result.fixedScript
      .replace(/^```applescript\n?/i, '')
      .replace(/^```\n?/i, '')
      .replace(/\n?```$/gi, '')
      .trim();
  }
  
  return result;
}

// ============================================================================
// VERIFICATION - DID THE ACTION ACTUALLY WORK?
// ============================================================================

/**
 * Verify that the action accomplished what was intended
 */
async function verifyOutcome(intent, result, options = {}) {
  const { app, expectedState, stateBefore, stateAfter } = options;
  
  // Basic checks
  if (!result.success) {
    return { verified: false, reason: 'Script execution failed' };
  }
  
  if (result.output?.toLowerCase().includes('error')) {
    return { verified: false, reason: `Script returned error: ${result.output}` };
  }
  
  // State-based verification
  if (stateBefore && stateAfter) {
    const intentLower = intent.toLowerCase();
    
    // Play verification
    if (intentLower.includes('play')) {
      if (stateAfter.state === 'playing') {
        return { verified: true, reason: 'Music is now playing' };
      }
      return { verified: false, reason: `Expected playing but state is ${stateAfter.state}` };
    }
    
    // Pause verification
    if (intentLower.includes('pause')) {
      if (stateAfter.state === 'paused') {
        return { verified: true, reason: 'Music is now paused' };
      }
      return { verified: false, reason: `Expected paused but state is ${stateAfter.state}` };
    }
    
    // Skip/next verification
    if (intentLower.includes('skip') || intentLower.includes('next')) {
      if (stateAfter.track && stateAfter.track !== stateBefore.track) {
        return { verified: true, reason: `Skipped to ${stateAfter.track}` };
      }
      // Might be at end of playlist
      if (stateAfter.state === 'stopped') {
        return { verified: true, reason: 'Reached end of playlist' };
      }
    }
    
    // Search/play specific song
    if (intentLower.includes('play') && (intentLower.includes('"') || intentLower.includes("'"))) {
      // Extract the song name from intent
      const songMatch = intent.match(/["']([^"']+)["']/);
      if (songMatch && stateAfter.track) {
        const requestedSong = songMatch[1].toLowerCase();
        const nowPlaying = stateAfter.track.toLowerCase();
        if (nowPlaying.includes(requestedSong) || requestedSong.includes(nowPlaying)) {
          return { verified: true, reason: `Now playing "${stateAfter.track}"` };
        }
        return { 
          verified: false, 
          reason: `Requested "${songMatch[1]}" but playing "${stateAfter.track}"`,
          partialSuccess: true
        };
      }
    }
  }
  
  // Default: trust the output if no errors
  return { verified: true, reason: 'Script completed without errors' };
}

// ============================================================================
// MAIN EXECUTION ENGINE
// ============================================================================

/**
 * Execute an intent with intelligent retry, self-correction, and verification
 */
async function executeIntent(intent, options = {}) {
  const {
    maxAttempts = 4,
    timeout = 15000,
    verbose = true,
    verifyOutcome: shouldVerify = true,
    app = null
  } = options;

  // Detect app from intent if not provided
  const detectedApp = app || detectAppFromIntent(intent);
  
  const attempts = [];
  const appliedFixes = [];
  let currentScript = null;
  let lastError = null;
  let lastErrorType = null;

  // Get initial state
  let initialState = null;
  if (detectedApp) {
    initialState = await getAppState(detectedApp);
    if (verbose) {
      console.log(`[Executor] Initial ${detectedApp} state:`, initialState);
    }
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (verbose) {
      console.log(`[Executor] Attempt ${attempt}/${maxAttempts}: "${intent}"`);
    }

    try {
      // Generate or fix the script
      if (attempt === 1) {
        currentScript = await generateScript(intent, {
          targetApp: detectedApp,
          currentState: initialState
        });
        if (verbose) {
          console.log('[Executor] Generated script:', currentScript.substring(0, 150) + '...');
        }
      } else {
        // Analyze and fix based on previous error
        const fix = await analyzeAndFix({
          originalScript: currentScript,
          error: lastError,
          errorType: lastErrorType,
          fixStrategy: attempts[attempts.length - 1]?.fixStrategy,
          intent,
          stateBefore: initialState,
          previousFixes: appliedFixes
        });
        
        if (!fix.canFix) {
          if (verbose) {
            console.log('[Executor] Unfixable:', fix.explanation);
          }
          return {
            success: false,
            output: fix.explanation,
            attempts,
            unfixable: true
          };
        }
        
        currentScript = fix.fixedScript;
        appliedFixes.push(fix.fixApplied);
        
        if (verbose) {
          console.log(`[Executor] Applied fix: ${fix.fixApplied} - ${fix.explanation}`);
        }
      }

      // Execute with state capture
      const result = await runAppleScript(currentScript, {
        timeout,
        captureState: shouldVerify,
        app: detectedApp
      });
      
      attempts.push({
        attempt,
        script: currentScript,
        success: result.success,
        output: result.output,
        error: result.error,
        errorType: result.errorType,
        fixStrategy: result.fixStrategy,
        stateBefore: result.stateBefore,
        stateAfter: result.stateAfter
      });

      if (result.success) {
        // Verify the outcome if requested
        if (shouldVerify) {
          const verification = await verifyOutcome(intent, result, {
            app: detectedApp,
            stateBefore: initialState,
            stateAfter: result.stateAfter
          });
          
          if (verbose) {
            console.log(`[Executor] Verification: ${verification.verified ? '✓' : '✗'} ${verification.reason}`);
          }
          
          if (!verification.verified && !verification.partialSuccess && attempt < maxAttempts) {
            // Script ran but didn't achieve the goal - treat as failure
            lastError = verification.reason;
            lastErrorType = 'verification_failed';
            continue;
          }
          
          return {
            success: verification.verified || verification.partialSuccess,
            output: result.output || verification.reason,
            verified: verification.verified,
            verificationReason: verification.reason,
            attempts,
            finalState: result.stateAfter
          };
        }
        
        return {
          success: true,
          output: result.output || 'Done',
          attempts,
          finalState: result.stateAfter
        };
      }

      // Failed - prepare for retry
      lastError = result.error;
      lastErrorType = result.errorType;
      
      if (result.unfixable) {
        if (verbose) {
          console.log('[Executor] Error is unfixable:', result.error);
        }
        return {
          success: false,
          output: result.error,
          attempts,
          unfixable: true
        };
      }
      
      if (verbose) {
        console.log(`[Executor] Failed (${result.errorType}): ${result.error}`);
      }

    } catch (error) {
      if (verbose) {
        console.error('[Executor] Exception:', error.message);
      }
      attempts.push({
        attempt,
        script: currentScript,
        success: false,
        error: error.message
      });
      lastError = error.message;
      lastErrorType = 'exception';
    }
  }

  // All attempts failed
  return {
    success: false,
    output: `Failed after ${maxAttempts} attempts. Last error: ${lastError}`,
    attempts,
    appliedFixes
  };
}

/**
 * Detect which app an intent is targeting
 */
function detectAppFromIntent(intent) {
  const lower = intent.toLowerCase();
  if (lower.includes('spotify')) return 'Spotify';
  if (lower.includes('music') || lower.includes('play') || lower.includes('song') || 
      lower.includes('track') || lower.includes('artist') || lower.includes('album')) {
    return 'Music';
  }
  if (lower.includes('safari') || lower.includes('browser') || lower.includes('web')) return 'Safari';
  if (lower.includes('finder') || lower.includes('file') || lower.includes('folder')) return 'Finder';
  if (lower.includes('mail') || lower.includes('email')) return 'Mail';
  if (lower.includes('calendar') || lower.includes('event')) return 'Calendar';
  if (lower.includes('notes') || lower.includes('note')) return 'Notes';
  if (lower.includes('messages') || lower.includes('imessage') || lower.includes('text')) return 'Messages';
  return null;
}

// ============================================================================
// QUICK PATTERNS (for common operations)
// ============================================================================

const QUICK_PATTERNS = {
  'music:play': `
    tell application "Music"
      try
        play
        delay 0.5
        if player state is playing then
          return "Playing: " & (name of current track) & " by " & (artist of current track)
        else
          return "ERROR: Play command sent but music not playing"
        end if
      on error errMsg
        return "ERROR: " & errMsg
      end try
    end tell
  `,
  'music:pause': `
    tell application "Music"
      try
        pause
        delay 0.3
        if player state is paused then
          return "Paused"
        else
          return "ERROR: Pause sent but state is " & (player state as string)
        end if
      on error errMsg
        return "ERROR: " & errMsg
      end try
    end tell
  `,
  'music:next': `
    tell application "Music"
      try
        set oldTrack to name of current track
        next track
        delay 0.5
        set newTrack to name of current track
        if newTrack is not oldTrack then
          return "Now playing: " & newTrack & " by " & (artist of current track)
        else
          return "ERROR: Track did not change"
        end if
      on error errMsg
        return "ERROR: " & errMsg
      end try
    end tell
  `,
  'music:state': `
    tell application "Music"
      try
        set s to player state as string
        if s is "playing" then
          return "Playing: " & (name of current track) & " by " & (artist of current track)
        else if s is "paused" then
          return "Paused: " & (name of current track) & " by " & (artist of current track)
        else
          return "State: " & s
        end if
      on error errMsg
        return "Music not available: " & errMsg
      end try
    end tell
  `
};

/**
 * Execute a quick pattern or fall back to intelligent execution
 */
async function executeQuickOrIntent(patternKey, intent, options = {}) {
  const pattern = QUICK_PATTERNS[patternKey];
  
  if (pattern) {
    const result = await runAppleScript(pattern, { 
      timeout: options.timeout || 10000,
      captureState: true,
      app: detectAppFromIntent(intent)
    });
    
    if (result.success && !result.output?.toUpperCase().includes('ERROR')) {
      return {
        success: true,
        output: result.output,
        method: 'quick_pattern',
        stateAfter: result.stateAfter
      };
    }
    
    console.log(`[Executor] Quick pattern failed, using intelligent execution...`);
  }
  
  const intentResult = await executeIntent(intent, options);
  return {
    ...intentResult,
    method: 'intelligent'
  };
}

module.exports = {
  runAppleScript,
  generateScript,
  analyzeAndFix,
  executeIntent,
  executeQuickOrIntent,
  verifyOutcome,
  getAppState,
  categorizeError,
  detectAppFromIntent,
  QUICK_PATTERNS,
  ERROR_TYPES
};
