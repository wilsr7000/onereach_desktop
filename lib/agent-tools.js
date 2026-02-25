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
