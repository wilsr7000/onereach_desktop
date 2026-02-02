/**
 * Agent Templates
 * 
 * Pre-defined templates for different types of agents based on
 * their execution capabilities (terminal, AppleScript, Node.js, etc.)
 */

const AGENT_TEMPLATES = {
  // ==================== Terminal/Shell Agents ====================
  'terminal': {
    id: 'terminal',
    name: 'Terminal Command',
    description: 'Execute shell commands and scripts',
    icon: 'terminal',
    executionType: 'shell',
    capabilities: ['run commands', 'file operations', 'system tasks', 'automation'],
    systemPromptTemplate: `You are a terminal command assistant that helps users execute shell commands safely.

Your capabilities:
- Execute bash/zsh commands
- File and directory operations (ls, cd, mkdir, rm, cp, mv)
- Text processing (grep, sed, awk, cat)
- System information (ps, top, df, du)
- Network commands (curl, wget, ping)
- Package management (brew, npm, pip)

Safety guidelines:
- Always explain what a command will do before suggesting it
- Warn about destructive operations (rm -rf, etc.)
- Suggest safer alternatives when possible
- Never execute commands that could harm the system without explicit confirmation

Response format:
- Explain the command in plain English
- Provide the exact command to run
- Note any potential risks or side effects`,
    exampleKeywords: ['terminal', 'command', 'shell', 'bash', 'run', 'execute', 'script', 'grep', 'curl', 'wget', 'npm', 'pip', 'git', 'chmod', 'mkdir', 'ls', 'cd'],
    exampleAgents: [
      {
        name: 'File Organizer',
        description: 'Organizes files in directories by type',
        keywords: ['organize', 'files', 'sort', 'move', 'cleanup'],
      },
      {
        name: 'Git Helper',
        description: 'Helps with git commands and workflows',
        keywords: ['git', 'commit', 'push', 'pull', 'branch', 'merge'],
      },
    ],
  },

  // ==================== AppleScript Agents ====================
  'applescript': {
    id: 'applescript',
    name: 'AppleScript',
    description: 'Control macOS apps and system features',
    icon: 'apple',
    executionType: 'applescript',
    capabilities: ['app control', 'UI automation', 'system dialogs', 'notifications', 'clipboard'],
    systemPromptTemplate: `You are an AppleScript automation assistant for macOS.

Your capabilities:
- Control macOS applications (Finder, Safari, Mail, Calendar, etc.)
- System UI automation and scripting
- Display dialogs and notifications
- Clipboard operations
- File and folder operations via Finder
- Launch and quit applications
- Control system settings

Response format:
- Explain what the script will do
- Provide the AppleScript code
- Note which apps need to be open or permissions required

Example patterns:
- tell application "App Name" to [action]
- display dialog "message"
- set the clipboard to [content]
- do shell script "[command]"`,
    exampleKeywords: ['applescript', 'mac', 'macos', 'finder', 'automate', 'control', 'safari', 'mail', 'calendar', 'music', 'itunes', 'photos', 'keynote', 'pages', 'numbers', 'app', 'application', 'open app', 'launch app', 'tell application'],
    exampleAgents: [
      {
        name: 'App Launcher',
        description: 'Opens and arranges applications',
        keywords: ['open', 'launch', 'app', 'application', 'start'],
      },
      {
        name: 'Window Manager',
        description: 'Arranges and manages windows',
        keywords: ['window', 'arrange', 'resize', 'position', 'tile'],
      },
    ],
  },

  // ==================== Node.js Agents ====================
  'nodejs': {
    id: 'nodejs',
    name: 'Node.js Script',
    description: 'Run JavaScript code and Node.js scripts',
    icon: 'code',
    executionType: 'nodejs',
    capabilities: ['JavaScript execution', 'file I/O', 'HTTP requests', 'data processing', 'JSON handling'],
    systemPromptTemplate: `You are a Node.js scripting assistant.

Your capabilities:
- Execute JavaScript/Node.js code
- File system operations (fs module)
- HTTP requests (fetch, axios)
- JSON parsing and manipulation
- Data transformation and processing
- Working with APIs
- Text and string manipulation

Available modules (no install needed):
- fs, path, os, crypto, http, https
- child_process for shell commands
- Built-in fetch for HTTP requests

Response format:
- Explain what the code will do
- Provide clean, well-commented code
- Handle errors gracefully
- Return results in a structured format`,
    exampleKeywords: ['node', 'javascript', 'js', 'script', 'code', 'api', 'json', 'csv', 'parse', 'http', 'fetch', 'request', 'html', 'markdown', 'transform', 'process data', 'convert'],
    exampleAgents: [
      {
        name: 'API Caller',
        description: 'Makes HTTP requests to APIs',
        keywords: ['api', 'request', 'fetch', 'http', 'rest', 'endpoint'],
      },
      {
        name: 'Data Transformer',
        description: 'Transforms and processes data',
        keywords: ['transform', 'convert', 'parse', 'json', 'data', 'format'],
      },
    ],
  },

  // ==================== Conversational Agents ====================
  'conversational': {
    id: 'conversational',
    name: 'Conversational',
    description: 'Chat-based assistant for questions and discussions',
    icon: 'chat',
    executionType: 'llm',
    capabilities: ['Q&A', 'explanations', 'advice', 'creative writing', 'analysis'],
    systemPromptTemplate: `You are a helpful conversational assistant.

Your role:
- Answer questions clearly and accurately
- Provide explanations and context
- Offer advice and suggestions
- Help with writing and creative tasks
- Analyze information and provide insights

Communication style:
- Be friendly and professional
- Use clear, simple language
- Break down complex topics
- Ask clarifying questions when needed
- Provide examples when helpful

Response format:
- Keep responses concise but complete
- Use bullet points for lists
- Structure longer responses with sections
- Summarize key points at the end if needed`,
    exampleKeywords: ['help', 'explain', 'what', 'how', 'why', 'tell me', 'describe'],
    exampleAgents: [
      {
        name: 'Research Helper',
        description: 'Helps research and summarize topics',
        keywords: ['research', 'find', 'learn', 'information', 'summary'],
      },
      {
        name: 'Writing Coach',
        description: 'Helps improve writing and provides feedback',
        keywords: ['write', 'edit', 'improve', 'proofread', 'draft'],
      },
    ],
  },

  // ==================== Automation Agents ====================
  'automation': {
    id: 'automation',
    name: 'Automation',
    description: 'Multi-step automated workflows',
    icon: 'workflow',
    executionType: 'workflow',
    capabilities: ['multi-step tasks', 'conditional logic', 'scheduling', 'integrations'],
    systemPromptTemplate: `You are a workflow automation assistant.

Your capabilities:
- Design multi-step automated workflows
- Conditional logic and branching
- Integration with multiple tools and services
- Error handling and retry logic
- Scheduling and triggers

Workflow design principles:
- Break complex tasks into simple steps
- Handle errors at each step
- Provide progress updates
- Allow for user confirmation at critical points
- Log actions for troubleshooting

Response format:
- Outline the workflow steps
- Explain each step's purpose
- Note any required permissions or setup
- Provide the automation configuration`,
    exampleKeywords: ['automate', 'workflow', 'schedule', 'trigger', 'when', 'automatically', 'daily', 'every day', 'every morning', 'recurring', 'routine', 'cron', 'task scheduler', 'periodic'],
    exampleAgents: [
      {
        name: 'Daily Digest',
        description: 'Creates daily summary reports',
        keywords: ['daily', 'summary', 'digest', 'report', 'morning'],
      },
      {
        name: 'File Watcher',
        description: 'Monitors folders and acts on new files',
        keywords: ['watch', 'monitor', 'folder', 'new file', 'detect'],
      },
    ],
  },

  // ==================== Web/Browser Agents ====================
  'browser': {
    id: 'browser',
    name: 'Browser Automation',
    description: 'Control web browsers and interact with websites',
    icon: 'browser',
    executionType: 'browser',
    capabilities: ['web scraping', 'form filling', 'navigation', 'screenshots', 'downloads'],
    systemPromptTemplate: `You are a browser automation assistant.

Your capabilities:
- Navigate to websites
- Extract information from web pages
- Fill and submit forms
- Click buttons and interact with elements
- Take screenshots
- Download files
- Handle authentication (with user credentials)

Safety guidelines:
- Never store or transmit passwords
- Respect robots.txt and rate limits
- Warn about sites that may block automation
- Handle CAPTCHAs gracefully (may require user help)

Response format:
- Describe the automation steps
- Provide selectors for elements (CSS or XPath)
- Handle common failure cases
- Note any manual steps required`,
    exampleKeywords: ['browser', 'web', 'website', 'page', 'scrape', 'click', 'fill'],
    exampleAgents: [
      {
        name: 'Web Scraper',
        description: 'Extracts data from websites',
        keywords: ['scrape', 'extract', 'website', 'data', 'page'],
      },
      {
        name: 'Form Filler',
        description: 'Fills out web forms automatically',
        keywords: ['form', 'fill', 'submit', 'input', 'field'],
      },
    ],
  },

  // ==================== System Control Agents ====================
  'system': {
    id: 'system',
    name: 'System Control',
    description: 'Control system settings and hardware',
    icon: 'settings',
    executionType: 'system',
    capabilities: ['volume control', 'brightness', 'display settings', 'power management', 'Bluetooth'],
    systemPromptTemplate: `You are a system control assistant for managing computer settings.

Your capabilities:
- Audio: volume, mute, input/output devices
- Display: brightness, resolution, arrangement
- Power: sleep, shutdown, restart, energy settings
- Connectivity: Wi-Fi, Bluetooth, network
- Accessibility: zoom, color filters, voice control

Available commands vary by platform:
- macOS: Use AppleScript, osascript, or system_profiler
- General: Use appropriate system commands

Safety notes:
- Confirm before shutdown/restart
- Warn about settings that affect other users
- Restore previous settings if requested`,
    exampleKeywords: ['volume', 'brightness', 'display', 'sleep', 'restart', 'wifi', 'bluetooth', 'mute', 'unmute', 'audio', 'sound', 'battery', 'power', 'screen', 'resolution', 'network', 'system preference', 'setting'],
    exampleAgents: [
      {
        name: 'Volume Control',
        description: 'Controls system volume and audio',
        keywords: ['volume', 'mute', 'sound', 'audio', 'quiet', 'loud'],
      },
      {
        name: 'Display Manager',
        description: 'Controls brightness and display settings',
        keywords: ['brightness', 'display', 'screen', 'dim', 'bright'],
      },
    ],
  },
};

/**
 * Get all templates
 * @returns {Object[]} Array of templates
 */
function getTemplates() {
  return Object.values(AGENT_TEMPLATES);
}

/**
 * Get a template by ID
 * @param {string} id - Template ID
 * @returns {Object|undefined}
 */
function getTemplate(id) {
  return AGENT_TEMPLATES[id];
}

/**
 * Get template by matching description keywords
 * @param {string} description - User's description
 * @returns {Object} Best matching template
 */
function matchTemplate(description) {
  const text = description.toLowerCase();
  let bestMatch = AGENT_TEMPLATES['conversational']; // Default
  let bestScore = 0;

  for (const template of Object.values(AGENT_TEMPLATES)) {
    let score = 0;

    // Check capabilities
    for (const cap of template.capabilities) {
      if (text.includes(cap.toLowerCase())) {
        score += 2;
      }
    }

    // Check example keywords
    for (const kw of template.exampleKeywords) {
      if (text.includes(kw.toLowerCase())) {
        score += 1;
      }
    }

    // Check template name/description
    if (text.includes(template.name.toLowerCase())) {
      score += 3;
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = template;
    }
  }

  return bestMatch;
}

/**
 * Score all templates against description
 * Returns templates with scores, sorted by relevance
 * @param {string} description - User's description
 * @returns {Object[]} Array of { template, score, matchedKeywords }
 */
function scoreAllTemplates(description) {
  const text = description.toLowerCase();
  const results = [];

  for (const template of Object.values(AGENT_TEMPLATES)) {
    let score = 0;
    const matchedKeywords = [];

    // Check capabilities (higher weight)
    for (const cap of template.capabilities) {
      if (text.includes(cap.toLowerCase())) {
        score += 2;
        matchedKeywords.push(cap);
      }
    }

    // Check example keywords
    for (const kw of template.exampleKeywords) {
      if (text.includes(kw.toLowerCase())) {
        score += 1;
        if (!matchedKeywords.includes(kw)) {
          matchedKeywords.push(kw);
        }
      }
    }

    // Check template name/description (highest weight)
    if (text.includes(template.name.toLowerCase())) {
      score += 3;
      matchedKeywords.push(template.name);
    }

    results.push({
      template: {
        id: template.id,
        name: template.name,
        description: template.description,
        executionType: template.executionType,
      },
      score,
      matchedKeywords,
    });
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);
  
  return results;
}

/**
 * Build the full system prompt for agent generation
 * @param {string} description - User's description
 * @param {Object} template - Template to use (optional, auto-matched if not provided)
 * @returns {Object} { template, systemPrompt }
 */
function buildAgentPrompt(description, template = null) {
  if (!template) {
    template = matchTemplate(description);
  }

  const systemPrompt = `You are creating a voice-activated agent. The user wants:
"${description}"

This agent will be of type: ${template.name} (${template.executionType})

${template.systemPromptTemplate}

Generate a complete agent configuration with:
1. name: Short descriptive name (2-4 words, no emojis)
2. keywords: 5-10 trigger phrases (lowercase)
3. prompt: System prompt for the agent (use the template above as guidance)
4. categories: 2-4 category tags
5. executionType: "${template.executionType}"
6. capabilities: List of specific things this agent can do

Return ONLY valid JSON, no markdown or explanation.`;

  return {
    template,
    systemPrompt,
  };
}

module.exports = {
  AGENT_TEMPLATES,
  getTemplates,
  getTemplate,
  matchTemplate,
  scoreAllTemplates,
  buildAgentPrompt,
};
