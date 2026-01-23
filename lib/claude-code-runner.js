/**
 * Claude Code Runner
 * 
 * Spawns and manages Claude Code CLI processes.
 * Handles both bundled binary and global npm install.
 */

const { spawn, spawnSync, execSync, execFile, exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// Active process tracking
let activeProcess = null;
let processAbortController = null;

/**
 * Get the path to Claude Code binary/script
 * Checks in order:
 * 1. Bundled binary in app resources (production)
 * 2. Global npm install (development/fallback)
 */
function getClaudeCodePath() {
  // In production, look for bundled binary
  if (app.isPackaged) {
    const platform = `${process.platform}-${process.arch}`;
    const binaryName = process.platform === 'win32' ? 'claude.exe' : 'claude';
    const bundledPath = path.join(process.resourcesPath, 'claude-code', platform, binaryName);
    
    if (fs.existsSync(bundledPath)) {
      console.log('[ClaudeCodeRunner] Using bundled binary:', bundledPath);
      return bundledPath;
    }
    
    // Fallback to platform-agnostic path
    const fallbackPath = path.join(process.resourcesPath, 'claude-code', binaryName);
    if (fs.existsSync(fallbackPath)) {
      console.log('[ClaudeCodeRunner] Using fallback bundled path:', fallbackPath);
      return fallbackPath;
    }
  }
  
  // In development or if bundled not found, try global install
  console.log('[ClaudeCodeRunner] Using global claude command');
  return 'claude';
}

/**
 * Check if Claude Code CLI is available
 * @returns {Promise<{ available: boolean, version?: string, path?: string }>}
 */
async function isClaudeCodeAvailable() {
  try {
    const claudePath = getClaudeCodePath();
    
    // Try to get version
    const result = execSync(`"${claudePath}" --version`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    
    return {
      available: true,
      version: result.trim(),
      path: claudePath,
    };
  } catch (error) {
    console.log('[ClaudeCodeRunner] Claude Code not available:', error.message);
    return {
      available: false,
    };
  }
}

/**
 * Check if Claude Code is authenticated (has valid API key)
 * @returns {Promise<{ authenticated: boolean, error?: string }>}
 */
async function isAuthenticated() {
  try {
    // First check if we have an API key in settings
    let apiKey = null;
    try {
      const { getSettingsManager } = require('../settings-manager');
      const settings = getSettingsManager();
      apiKey = settings.get('anthropicApiKey') || 
               settings.get('llmApiKey') || 
               settings.get('llmConfig.anthropic.apiKey');
      
      if (apiKey) {
        apiKey = apiKey.replace(/^Anthr:\s*/i, '').trim();
      }
    } catch (e) {
      // Ignore settings errors
    }
    
    if (!apiKey || !apiKey.startsWith('sk-ant-')) {
      return {
        authenticated: false,
        error: 'No Anthropic API key found. Please add your API key in Settings.',
      };
    }
    
    // API key exists and looks valid
    return {
      authenticated: true,
    };
  } catch (error) {
    console.log('[ClaudeCodeRunner] Auth check error:', error.message);
    return {
      authenticated: false,
      error: error.message,
    };
  }
}

/**
 * Run Claude Code CLI with a prompt
 * @param {string} prompt - The prompt to send to Claude Code
 * @param {Object} options - Options
 * @param {string} options.cwd - Working directory
 * @param {string} options.systemPrompt - System prompt override
 * @param {boolean} options.enableTools - Enable agentic tools (Bash, etc.) for execution
 * @param {string[]} options.allowedTools - Specific tools to allow (e.g., ['Bash', 'Read'])
 * @param {Function} options.onOutput - Callback for stdout data
 * @param {Function} options.onError - Callback for stderr data
 * @param {Function} options.onProgress - Callback for progress updates
 * @returns {Promise<{ success: boolean, output?: string, error?: string }>}
 */
async function runClaudeCode(prompt, options = {}) {
  const { cwd, systemPrompt, enableTools, allowedTools, onOutput, onError, onProgress } = options;
  
  // Check if already running
  if (activeProcess) {
    return {
      success: false,
      error: 'A Claude Code process is already running',
    };
  }
  
  const claudePath = getClaudeCodePath();
  
  // Build arguments
  const args = ['-p', prompt];
  
  // Add output format for structured response
  args.push('--output-format', 'text');
  
  // Tools configuration
  if (enableTools) {
    // Enable specific tools or use defaults
    if (allowedTools && allowedTools.length > 0) {
      args.push('--allowedTools', allowedTools.join(','));
    }
    // Don't add --tools "" to keep default tools enabled
  } else {
    // Disable all tools - text generation only
    args.push('--tools', '');
  }
  
  // Skip permission checks to avoid hanging
  args.push('--dangerously-skip-permissions');
  
  // Add system prompt if provided
  if (systemPrompt) {
    args.push('--system-prompt', systemPrompt);
  }
  
  // Get API key from settings and pass it to Claude Code
  const env = { ...process.env };
  
  try {
    const { getSettingsManager } = require('../settings-manager');
    const settings = getSettingsManager();
    const apiKey = settings.get('anthropicApiKey') || 
                   settings.get('llmApiKey') || 
                   settings.get('llmConfig.anthropic.apiKey');
    
    
    if (apiKey) {
      // Clean the API key (remove any prefix labels)
      const cleanKey = apiKey.replace(/^Anthr:\s*/i, '').trim();
      env.ANTHROPIC_API_KEY = cleanKey;
      console.log('[ClaudeCodeRunner] Using API key from settings');
      
    }
  } catch (e) {
    console.warn('[ClaudeCodeRunner] Could not get API key from settings:', e.message);
  }
  
  console.log('[ClaudeCodeRunner] Starting Claude Code...');
  console.log('[ClaudeCodeRunner] Path:', claudePath);
  console.log('[ClaudeCodeRunner] CWD:', cwd || process.cwd());
  console.log('[ClaudeCodeRunner] Prompt:', prompt.substring(0, 100) + '...');
  
  
  // Use file redirection approach - write to temp file then read it
  const fs7 = require('fs');
  const os = require('os');
  const path = require('path');
  
  // Create unique temp file for output
  const tempFile = path.join(os.tmpdir(), `claude-output-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  
  fs7.appendFileSync('/Users/richardwilson/Onereach_app/.cursor/debug.log', JSON.stringify({location:'claude-code-runner.js:file-redirect',message:'Starting with file redirect',data:{claudePath,argsCount:args.length,promptLen:prompt?.length,hasEnvKey:!!env.ANTHROPIC_API_KEY,tempFile},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H-FILE-START'})+'\n');
  
  return new Promise((resolve) => {
    const timeoutMs = 120000;
    
    // Build shell command with file redirection
    const fullClaudePath = '/opt/homebrew/bin/claude';
    const escapedArgs = args.map(a => {
      if (a === '') return '""';
      // Escape single quotes for shell
      return `'${a.replace(/'/g, "'\\''")}'`;
    }).join(' ');
    
    const shellCommand = `${fullClaudePath} ${escapedArgs} > "${tempFile}" 2>&1`;
    
    fs7.appendFileSync('/Users/richardwilson/Onereach_app/.cursor/debug.log', JSON.stringify({location:'claude-code-runner.js:file-redirect',message:'Running shell command',data:{commandPreview:shellCommand.substring(0,200)+'...'},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H-FILE-CMD'})+'\n');
    
    // Use execSync with shell to run the command
    try {
      execSync(shellCommand, {
        env: env,
        cwd: cwd || process.cwd(),
        timeout: timeoutMs,
        stdio: 'ignore', // Don't capture stdio, we're using file
        shell: '/bin/zsh',
      });
    } catch (execError) {
      // Command failed or timed out - still try to read the file
      fs7.appendFileSync('/Users/richardwilson/Onereach_app/.cursor/debug.log', JSON.stringify({location:'claude-code-runner.js:file-redirect',message:'Exec error (may still have output)',data:{error:execError.message?.substring(0,200)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H-FILE-ERROR'})+'\n');
    }
    
    // Read the output file
    let stdout = '';
    try {
      stdout = fs7.readFileSync(tempFile, 'utf8');
      // Clean up temp file
      fs7.unlinkSync(tempFile);
    } catch (readError) {
      fs7.appendFileSync('/Users/richardwilson/Onereach_app/.cursor/debug.log', JSON.stringify({location:'claude-code-runner.js:file-redirect',message:'Failed to read output file',data:{error:readError.message},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H-FILE-READ-ERROR'})+'\n');
    }
    
    fs7.appendFileSync('/Users/richardwilson/Onereach_app/.cursor/debug.log', JSON.stringify({location:'claude-code-runner.js:file-redirect',message:'File redirect completed',data:{stdoutLen:stdout.length,stdoutPreview:stdout.substring(0,500)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H-FILE-DONE'})+'\n');
    
    if (onOutput && stdout) {
      onOutput({ type: 'stdout', text: stdout });
    }
    
    if (stdout) {
      // Try to parse JSON from output
      let parsed;
      try {
        const jsonMatch = stdout.match(/\{[\s\S]*\}(?=[^}]*$)/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0]);
        }
      } catch {
        parsed = { raw: stdout };
      }
      
      resolve({
        success: true,
        output: stdout,
        result: parsed,
      });
    } else {
      resolve({
        success: false,
        error: 'No output received from Claude CLI',
        output: '',
      });
    }
  });
}

/**
 * Cancel the running Claude Code process
 * @returns {boolean} True if cancelled, false if no process running
 */
function cancelClaudeCode() {
  if (!activeProcess) {
    console.log('[ClaudeCodeRunner] No process to cancel');
    return false;
  }
  
  console.log('[ClaudeCodeRunner] Cancelling process...');
  
  try {
    if (processAbortController) {
      processAbortController.abort();
    } else {
      activeProcess.kill('SIGTERM');
    }
    
    activeProcess = null;
    processAbortController = null;
    
    return true;
  } catch (error) {
    console.error('[ClaudeCodeRunner] Cancel error:', error);
    return false;
  }
}

/**
 * Check if a process is currently running
 * @returns {boolean}
 */
function isRunning() {
  return activeProcess !== null;
}

/**
 * Run a template-based Claude Code command
 * @param {Object} template - Template object from claude-code-templates.js
 * @param {string} userPrompt - User's prompt
 * @param {Object} options - Additional options
 * @returns {Promise<{ success: boolean, output?: string, error?: string }>}
 */
async function runTemplate(template, userPrompt, options = {}) {
  // Build the full prompt with template system prompt
  let fullPrompt = userPrompt;
  
  if (template.systemPrompt) {
    // The system prompt will be passed separately
    options.systemPrompt = template.systemPrompt;
  }
  
  return runClaudeCode(fullPrompt, options);
}

/**
 * Chat-style interface for Claude Code (mimics ClaudeAPI.chat)
 * @param {Array} messages - Array of {role, content} messages
 * @param {Object} options - Options like systemPrompt, maxTokens
 * @returns {Promise<{ success: boolean, content?: string, error?: string }>}
 */
async function chat(messages, options = {}) {
  // Convert message history to a single prompt
  const systemPrompt = options.system || options.systemPrompt || '';
  
  // Build conversation context
  let conversationContext = '';
  for (const msg of messages) {
    if (msg.role === 'user') {
      conversationContext += `User: ${msg.content}\n\n`;
    } else if (msg.role === 'assistant') {
      conversationContext += `Assistant: ${msg.content}\n\n`;
    }
  }
  
  // Get the last user message as the main prompt
  const lastUserMessage = messages.filter(m => m.role === 'user').pop();
  const prompt = lastUserMessage?.content || '';
  
  // Build a context-aware prompt
  const fullPrompt = messages.length > 1
    ? `Previous conversation:\n${conversationContext}\nRespond to the last user message.`
    : prompt;
  
  const result = await runClaudeCode(fullPrompt, {
    systemPrompt,
    ...options,
  });
  
  if (result.success) {
    // Extract the text content from the output
    let content = result.output || '';
    
    // Try to parse JSON output format
    try {
      const lines = content.split('\n').filter(l => l.trim());
      for (const line of lines) {
        if (line.startsWith('{')) {
          const parsed = JSON.parse(line);
          if (parsed.type === 'result' && parsed.result) {
            content = parsed.result;
            break;
          }
          if (parsed.content) {
            content = parsed.content;
            break;
          }
        }
      }
    } catch {
      // Use raw output
    }
    
    return {
      success: true,
      content: content.trim(),
    };
  }
  
  return {
    success: false,
    error: result.error,
  };
}

/**
 * Simple completion interface for Claude Code (mimics ClaudeAPI.complete)
 * @param {string} prompt - The prompt
 * @param {Object} options - Options like systemPrompt, maxTokens
 * @returns {Promise<string>} The response text
 */
async function complete(prompt, options = {}) {
  const result = await runClaudeCode(prompt, {
    systemPrompt: options.systemPrompt,
    ...options,
  });
  
  if (result.success) {
    // Extract text from output
    let content = result.output || '';
    
    // Try to parse JSON output
    try {
      const lines = content.split('\n').filter(l => l.trim());
      for (const line of lines) {
        if (line.startsWith('{')) {
          const parsed = JSON.parse(line);
          if (parsed.type === 'result' && parsed.result) {
            content = parsed.result;
            break;
          }
          if (parsed.content) {
            content = parsed.content;
            break;
          }
        }
      }
    } catch {
      // Use raw output
    }
    
    return content.trim();
  }
  
  throw new Error(result.error || 'Claude Code failed');
}

/**
 * Execute a task with agentic tools enabled (Bash, Read, Write, etc.)
 * This allows the CLI to actually run commands and scripts autonomously
 * @param {string} prompt - The task to execute
 * @param {Object} options - Options
 * @param {string} options.systemPrompt - System prompt
 * @param {string[]} options.allowedTools - Tools to allow (default: Bash only for safety)
 * @param {string} options.cwd - Working directory
 * @returns {Promise<{ success: boolean, output?: string, error?: string }>}
 */
async function executeWithTools(prompt, options = {}) {
  const result = await runClaudeCode(prompt, {
    systemPrompt: options.systemPrompt,
    enableTools: true,
    allowedTools: options.allowedTools || ['Bash'], // Default to Bash only for safety
    cwd: options.cwd,
    ...options,
  });
  
  return result;
}

/**
 * Plan an agent based on user description (mimics ClaudeAPI.planAgent)
 * @param {string} description - User's description of what they want the agent to do
 * @param {Object} availableTemplates - Available agent templates
 * @returns {Promise<{ success: boolean, plan?: Object, error?: string }>}
 */
async function planAgent(description, availableTemplates = {}) {
  const templateInfo = Object.entries(availableTemplates).map(([id, t]) => 
    `- ${id}: ${t.name} - ${t.description} (capabilities: ${t.capabilities?.join(', ')})`
  ).join('\n');

  const prompt = `Analyze this user request and plan the best approach for building a voice-activated agent:

USER REQUEST: "${description}"

AVAILABLE EXECUTION TYPES:
${templateInfo || `
- shell: Terminal commands, file operations, system tasks
- applescript: macOS app control, UI automation, system features
- nodejs: JavaScript code, API calls, data processing
- llm: Conversational AI, Q&A, text generation (no system access)
- browser: Web automation, scraping, form filling
`}

Analyze the request and identify ALL possible features this agent could have. For each feature, determine if it's feasible.

Respond in JSON format:
{
  "understanding": "What the user is trying to accomplish in one sentence",
  "executionType": "The best execution type for this task",
  "reasoning": "Why this execution type is best (2-3 sentences)",
  "features": [
    {
      "id": "feature_id",
      "name": "Feature Name",
      "description": "What this feature does",
      "enabled": true,
      "feasible": true,
      "feasibilityReason": "Why it can or can't be done",
      "priority": "core|recommended|optional",
      "requiresPermission": false
    }
  ],
  "approach": {
    "steps": ["Step 1", "Step 2", ...],
    "requirements": ["What's needed - apps, permissions, etc"],
    "challenges": ["Potential issues to handle"]
  },
  "suggestedName": "Short agent name (2-4 words)",
  "suggestedKeywords": ["keyword1", "keyword2", ...],
  "verification": {
    "canAutoVerify": true/false,
    "verificationMethod": "How to check if it worked",
    "expectedOutcome": "What success looks like"
  },
  "testPlan": {
    "tests": [
      {
        "id": "test_id",
        "name": "Test Name",
        "description": "What this test verifies",
        "testPrompt": "The voice command to test with",
        "expectedBehavior": "What should happen",
        "verificationMethod": "auto-app-state | auto-file-check | auto-process-check | manual",
        "verificationDetails": {
          "appName": "App name if checking app state",
          "checkType": "running | frontmost | player-state | file-exists",
          "expectedValue": "The expected result"
        },
        "priority": "critical | important | nice-to-have"
      }
    ],
    "setupSteps": ["Any setup needed before testing"],
    "cleanupSteps": ["Cleanup after testing"]
  },
  "confidence": 0.0-1.0
}

TEST PLAN GUIDELINES:
- Include 2-5 tests covering core functionality
- "critical" tests must pass for agent to be considered working
- "important" tests should pass but aren't blockers
- "nice-to-have" tests are optional
- Use "auto-*" verification methods when possible (auto-app-state for apps, auto-file-check for files)
- Use "manual" only when automatic verification isn't possible

FEATURE GUIDELINES:
- "core" features are essential to the agent's purpose (always enabled by default)
- "recommended" features enhance the agent (enabled by default)
- "optional" features are nice-to-have (disabled by default)
- Set feasible=false for features that cannot be implemented (e.g., require APIs we don't have, need hardware we can't access)
- Include 4-8 features total, covering the main functionality and potential enhancements`;

  try {
    const response = await complete(prompt, {});
    
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const plan = JSON.parse(jsonMatch[0]);
        return {
          success: true,
          plan,
          raw: response
        };
      } catch (parseError) {
        console.error('[ClaudeCodeRunner] Plan JSON parse error:', parseError.message);
        return {
          success: false,
          error: `JSON parse error: ${parseError.message}. The response may have been truncated.`,
          raw: response,
          partialJson: jsonMatch[0].substring(0, 1000)
        };
      }
    } else {
      return {
        success: false,
        error: 'No JSON found in response',
        raw: response
      };
    }
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

module.exports = {
  getClaudeCodePath,
  isClaudeCodeAvailable,
  isAuthenticated,
  runClaudeCode,
  cancelClaudeCode,
  isRunning,
  runTemplate,
  chat,
  complete,
  executeWithTools,
  planAgent,
};
