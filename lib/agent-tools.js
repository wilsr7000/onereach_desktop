/**
 * Agent Tool Registry
 *
 * Central catalog of tools available to agents. Each tool has:
 * - name: unique identifier
 * - description: for LLM context
 * - inputSchema: JSON Schema for the tool's parameters
 * - execute: async function that runs the tool
 * - safety: optional constraints (blocked patterns, requires approval)
 *
 * Agents declare which tools they need via a `tools` property on their definition.
 * The middleware resolves tool names into full definitions at execution time.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const BLOCKED_SHELL_PATTERNS = [
  /\brm\s+(-rf?|--recursive)\s+[\/~]/i,
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  />\s*\/dev\/sd/i,
  /\bformat\b.*[cCdD]:/i,
  /\bchmod\s+777\s+\//i,
  /\b:(){ :|:& };:/,
];

function isShellCommandSafe(command) {
  for (const pattern of BLOCKED_SHELL_PATTERNS) {
    if (pattern.test(command)) return false;
  }
  return true;
}

const TOOLS = {
  shell_exec: {
    name: 'shell_exec',
    description: 'Execute a shell command and return its stdout and stderr. Use for system commands, file manipulation, git operations, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run' },
        cwd: { type: 'string', description: 'Working directory (optional, defaults to app root)' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default 10000)' },
      },
      required: ['command'],
    },
    execute: async ({ command, cwd, timeout = 10000 }) => {
      if (!isShellCommandSafe(command)) {
        return { error: 'Command blocked by safety filter' };
      }
      try {
        const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', command], {
          cwd: cwd || process.cwd(),
          timeout,
          maxBuffer: 1024 * 1024,
        });
        return { stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 1000) };
      } catch (err) {
        return { error: err.message, stderr: err.stderr?.slice(0, 1000) || '' };
      }
    },
  },

  file_read: {
    name: 'file_read',
    description: 'Read the contents of a file. Returns the text content.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative file path' },
        maxBytes: { type: 'number', description: 'Maximum bytes to read (default 50000)' },
      },
      required: ['path'],
    },
    execute: async ({ path: filePath, maxBytes = 50000 }) => {
      try {
        const resolved = path.resolve(filePath);
        const stat = await fs.promises.stat(resolved);
        if (stat.size > maxBytes) {
          const fd = await fs.promises.open(resolved, 'r');
          const buf = Buffer.alloc(maxBytes);
          await fd.read(buf, 0, maxBytes, 0);
          await fd.close();
          return { content: buf.toString('utf-8'), truncated: true, totalSize: stat.size };
        }
        const content = await fs.promises.readFile(resolved, 'utf-8');
        return { content };
      } catch (err) {
        return { error: err.message };
      }
    },
  },

  file_write: {
    name: 'file_write',
    description: 'Write content to a file. Creates the file if it does not exist.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative file path' },
        content: { type: 'string', description: 'Content to write' },
        append: { type: 'boolean', description: 'Append instead of overwrite (default false)' },
      },
      required: ['path', 'content'],
    },
    execute: async ({ path: filePath, content, append = false }) => {
      try {
        const resolved = path.resolve(filePath);
        await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
        if (append) {
          await fs.promises.appendFile(resolved, content, 'utf-8');
        } else {
          await fs.promises.writeFile(resolved, content, 'utf-8');
        }
        return { success: true, path: resolved };
      } catch (err) {
        return { error: err.message };
      }
    },
  },

  file_list: {
    name: 'file_list',
    description: 'List files and directories in a given path.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list' },
        recursive: { type: 'boolean', description: 'List recursively (default false, max 200 entries)' },
      },
      required: ['path'],
    },
    execute: async ({ path: dirPath, recursive = false }) => {
      try {
        const resolved = path.resolve(dirPath);
        if (recursive) {
          const entries = [];
          const walk = async (dir, prefix = '') => {
            const items = await fs.promises.readdir(dir, { withFileTypes: true });
            for (const item of items) {
              if (entries.length >= 200) break;
              const rel = prefix ? `${prefix}/${item.name}` : item.name;
              entries.push({ name: rel, type: item.isDirectory() ? 'dir' : 'file' });
              if (item.isDirectory() && !item.name.startsWith('.') && item.name !== 'node_modules') {
                await walk(path.join(dir, item.name), rel);
              }
            }
          };
          await walk(resolved);
          return { entries };
        }
        const items = await fs.promises.readdir(resolved, { withFileTypes: true });
        return {
          entries: items.map((i) => ({ name: i.name, type: i.isDirectory() ? 'dir' : 'file' })),
        };
      } catch (err) {
        return { error: err.message };
      }
    },
  },

  web_search: {
    name: 'web_search',
    description: 'Search the web and return results. Returns titles, URLs, and snippets.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
    execute: async ({ query }) => {
      try {
        const { search } = require('./browse-fast-path');
        const results = await search(query);
        if (results && results.results) {
          return { results: results.results.slice(0, 5) };
        }
        return { results: [], note: 'No results found' };
      } catch (err) {
        return { error: err.message };
      }
    },
  },

  spaces_search: {
    name: 'spaces_search',
    description: 'Search the local Spaces storage for items matching a query. Spaces store clipboard items, notes, and other content.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
    execute: async ({ query, limit = 10 }) => {
      try {
        const http = require('http');
        const url = `http://127.0.0.1:47291/api/search?q=${encodeURIComponent(query)}&limit=${limit}`;
        return new Promise((resolve) => {
          http.get(url, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
              try { resolve(JSON.parse(body)); } catch (_) { resolve({ error: 'Invalid response' }); }
            });
          }).on('error', (err) => resolve({ error: err.message }));
        });
      } catch (err) {
        return { error: err.message };
      }
    },
  },

  spaces_add_item: {
    name: 'spaces_add_item',
    description: 'Add an item to a Space. Requires a space ID and item content.',
    inputSchema: {
      type: 'object',
      properties: {
        spaceId: { type: 'string', description: 'The space ID to add the item to' },
        content: { type: 'string', description: 'The text content of the item' },
        type: { type: 'string', description: 'Item type (default "text")', enum: ['text', 'code', 'url', 'note'] },
      },
      required: ['spaceId', 'content'],
    },
    execute: async ({ spaceId, content, type = 'text' }) => {
      try {
        const http = require('http');
        const postData = JSON.stringify({ content, type });
        return new Promise((resolve) => {
          const req = http.request({
            hostname: '127.0.0.1', port: 47291,
            path: `/api/spaces/${spaceId}/items`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          }, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
              try { resolve(JSON.parse(body)); } catch (_) { resolve({ error: 'Invalid response' }); }
            });
          });
          req.on('error', (err) => resolve({ error: err.message }));
          req.write(postData);
          req.end();
        });
      } catch (err) {
        return { error: err.message };
      }
    },
  },

  get_current_time: {
    name: 'get_current_time',
    description: 'Get the current date, time, and timezone.',
    inputSchema: {
      type: 'object',
      properties: {
        timezone: { type: 'string', description: 'IANA timezone (e.g. "America/New_York"). Defaults to system timezone.' },
      },
    },
    execute: async ({ timezone } = {}) => {
      const now = new Date();
      const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
      const formatted = now.toLocaleString('en-US', {
        timeZone: tz,
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
      });
      return { iso: now.toISOString(), formatted, timezone: tz, epochMs: now.getTime() };
    },
  },

  // ==================== DESKTOP AUTOPILOT TOOLS ====================

  desktop_browse: {
    name: 'desktop_browse',
    description: 'Control a web browser to navigate websites, interact with elements, take screenshots, and extract data. Use "run_task" for natural-language tasks (AI handles multi-step execution) or individual actions for fine-grained control.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['run_task', 'navigate', 'screenshot', 'get_state', 'extract_content', 'evaluate', 'close'],
          description: 'The browser action to perform',
        },
        task: { type: 'string', description: 'Natural language task for run_task (e.g. "Go to example.com and find the pricing page")' },
        url: { type: 'string', description: 'URL for navigate action' },
        script: { type: 'string', description: 'JavaScript for evaluate action' },
        selector: { type: 'string', description: 'CSS selector for extract_content' },
        useVision: { type: 'boolean', description: 'Enable screenshot-based vision for run_task (default: auto)' },
        maxSteps: { type: 'number', description: 'Max steps for run_task (default: from settings)' },
        headless: { type: 'boolean', description: 'Run browser invisibly (true) or show the browser window (false). Default: true.' },
      },
      required: ['action'],
    },
    execute: async (args) => {
      const autopilot = require('./desktop-autopilot');
      switch (args.action) {
        case 'run_task':
          if (!args.task) return { error: 'task is required for run_task action' };
          return autopilot.browser.runTask(args.task, {
            useVision: args.useVision,
            maxSteps: args.maxSteps,
            headless: args.headless,
          });
        case 'navigate':
          if (!args.url) return { error: 'url is required for navigate action' };
          return autopilot.browser.navigate(args.url, { headless: args.headless });
        case 'screenshot':
          return autopilot.browser.screenshot({ fullPage: args.fullPage });
        case 'get_state':
          return autopilot.browser.getState();
        case 'extract_content':
          return autopilot.browser.extractContent({ selector: args.selector });
        case 'evaluate':
          if (!args.script) return { error: 'script is required for evaluate action' };
          return autopilot.browser.evaluate(args.script);
        case 'close':
          return autopilot.browser.close();
        default:
          return { error: `Unknown browser action: ${args.action}` };
      }
    },
  },

  desktop_app_action: {
    name: 'desktop_app_action',
    description: 'Execute an app control action (open windows, manage settings, agents, AI, tabs, credentials, backup, etc.). Use desktop_app_situation first to discover available actions.',
    inputSchema: {
      type: 'object',
      properties: {
        actionId: { type: 'string', description: 'The action ID to execute (e.g. "open-settings", "agents-list", "tab-open")' },
        params: { type: 'object', description: 'Parameters for the action (varies by action)' },
      },
      required: ['actionId'],
    },
    execute: async ({ actionId, params = {} }) => {
      const autopilot = require('./desktop-autopilot');
      return autopilot.app.execute(actionId, params);
    },
  },

  desktop_app_situation: {
    name: 'desktop_app_situation',
    description: 'Get a full snapshot of the app state: open windows, connected agents, active flow context, voice orb status, recent activity, and key settings. Also lists all available app actions.',
    inputSchema: {
      type: 'object',
      properties: {
        includeActions: { type: 'boolean', description: 'Include list of all available action IDs (default: false)' },
      },
    },
    execute: async ({ includeActions = false } = {}) => {
      const autopilot = require('./desktop-autopilot');
      const situation = await autopilot.app.situation();
      if (includeActions) {
        const actionList = autopilot.app.list();
        situation.availableActions = actionList.success ? actionList.actions : null;
      }
      return situation;
    },
  },

  desktop_applescript: {
    name: 'desktop_applescript',
    description: 'Run an AppleScript on macOS to automate system tasks, control native apps (Finder, Music, Calendar, Mail, etc.), manage windows, and interact with the OS. Only available on macOS with System Control enabled.',
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'The AppleScript code to execute' },
      },
      required: ['script'],
    },
    execute: async ({ script }) => {
      const autopilot = require('./desktop-autopilot');
      return autopilot.system.applescript(script);
    },
  },

  desktop_mouse: {
    name: 'desktop_mouse',
    description: 'Control the mouse cursor: move to coordinates, click, double-click, right-click, scroll, or get current position. Requires System Control enabled in settings.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['move', 'click', 'double_click', 'right_click', 'scroll', 'get_position'],
          description: 'Mouse action to perform',
        },
        x: { type: 'number', description: 'X coordinate for move/scroll' },
        y: { type: 'number', description: 'Y coordinate for move/scroll' },
        button: { type: 'string', enum: ['left', 'right'], description: 'Mouse button (default: left)' },
      },
      required: ['action'],
    },
    execute: async (args) => {
      const autopilot = require('./desktop-autopilot');
      switch (args.action) {
        case 'move':
          if (args.x == null || args.y == null) return { error: 'x and y are required for move' };
          return autopilot.system.mouseMove(args.x, args.y);
        case 'click':
          return autopilot.system.mouseClick(args.button || 'left', false);
        case 'double_click':
          return autopilot.system.mouseClick(args.button || 'left', true);
        case 'right_click':
          return autopilot.system.mouseClick('right', false);
        case 'scroll':
          return autopilot.system.mouseScroll(args.x || 0, args.y || 0);
        case 'get_position':
          return autopilot.system.getMousePosition();
        default:
          return { error: `Unknown mouse action: ${args.action}` };
      }
    },
  },

  desktop_keyboard: {
    name: 'desktop_keyboard',
    description: 'Type text or press keyboard shortcuts. Use "type" for natural text input, "press" for individual keys with modifiers (e.g. cmd+c, ctrl+shift+t). Requires System Control enabled.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['type', 'press'],
          description: '"type" for text strings, "press" for key combos',
        },
        text: { type: 'string', description: 'Text to type (for "type" action)' },
        key: { type: 'string', description: 'Key to press (for "press" action, e.g. "c", "enter", "tab")' },
        modifiers: {
          type: 'object',
          description: 'Modifier keys for "press" action',
          properties: {
            shift: { type: 'boolean' },
            control: { type: 'boolean' },
            alt: { type: 'boolean' },
            meta: { type: 'boolean', description: 'Command key on macOS' },
          },
        },
      },
      required: ['action'],
    },
    execute: async (args) => {
      const autopilot = require('./desktop-autopilot');
      switch (args.action) {
        case 'type':
          if (!args.text) return { error: 'text is required for type action' };
          return autopilot.system.keyType(args.text);
        case 'press':
          if (!args.key) return { error: 'key is required for press action' };
          return autopilot.system.keyPress(args.key, args.modifiers || {});
        default:
          return { error: `Unknown keyboard action: ${args.action}` };
      }
    },
  },
};

/**
 * Resolve an array of tool names (or 'all') into full tool definitions.
 * @param {string[]|string} toolNames - Array of tool names, or 'all'
 * @returns {Object[]} Array of tool definitions with execute functions
 */
function resolveTools(toolNames) {
  if (!toolNames) return [];
  if (toolNames === 'all') return Object.values(TOOLS);
  const names = Array.isArray(toolNames) ? toolNames : [toolNames];
  return names.map((n) => TOOLS[n]).filter(Boolean);
}

/**
 * Get just the LLM-facing definitions (no execute functions).
 * @param {string[]|string} toolNames
 * @returns {Object[]} Array of {name, description, inputSchema}
 */
function getToolDefinitions(toolNames) {
  return resolveTools(toolNames).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

/**
 * Create an onToolCall dispatcher from resolved tools.
 * @param {Object[]} tools - Resolved tool objects with execute functions
 * @returns {Function} async (name, input) => result
 */
function createToolDispatcher(tools) {
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  return async (name, input) => {
    const tool = toolMap.get(name);
    if (!tool) return { error: `Unknown tool: ${name}` };
    return tool.execute(input || {});
  };
}

/**
 * Register a custom tool at runtime.
 * @param {Object} tool - {name, description, inputSchema, execute}
 */
function registerTool(tool) {
  if (!tool.name || !tool.execute) throw new Error('Tool requires name and execute');
  TOOLS[tool.name] = tool;
}

module.exports = {
  TOOLS,
  resolveTools,
  getToolDefinitions,
  createToolDispatcher,
  registerTool,
  isShellCommandSafe,
};
