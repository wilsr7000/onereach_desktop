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

  // ── Manage Events (voice agent + modal app + graph :Event nodes) ─────────
  // Shared source of truth: lib/events/events-store.js writes :Event nodes
  // to the OneReach graph (watch-ready). events_open_app pops the app modal.

  events_open_app: {
    name: 'events_open_app',
    description:
      'Open (or refresh) the Manage Events app in a modal window, showing upcoming events. Call this whenever the user asks to open/see their events or appointments, and after any add/delete so the app reflects the change.',
    inputSchema: {
      type: 'object',
      properties: {
        notice: { type: 'string', description: 'Optional status line to show at the top (e.g. "Added: Dentist ✓")' },
      },
    },
    execute: async ({ notice } = {}) => {
      try {
        const store = require('./events/events-store');
        const { renderEventsApp, APP_PANEL } = require('./events/events-app');
        const list = await store.nextEvents(12);
        const html = renderEventsApp(list, { notice });
        const { showAgentUIModal } = require('./agent-ui-modal-manager');
        showAgentUIModal({
          agentId: 'event-manager',
          agentName: 'Event Manager',
          html,
          panelWidth: APP_PANEL.width,
          panelHeight: APP_PANEL.height,
        });
        return { opened: true, upcomingCount: list.length };
      } catch (err) {
        const store = require('./events/events-store');
        return {
          error: store.isGraphConfigError(err)
            ? store.friendlyGraphError(err)
            : `Could not open the events app: ${err.message}`,
          dependencyDown: store.isGraphConfigError(err) ? 'neo4j' : undefined,
        };
      }
    },
  },

  events_add: {
    name: 'events_add',
    description:
      'Add an event or appointment (one-off or recurring) to the shared events store. Resolve relative dates ("tomorrow 3pm") to an absolute ISO datetime BEFORE calling. For weekly recurrence, byDay holds weekday numbers (0=Sunday..6=Saturday).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short event title, e.g. "Dentist"' },
        startsAt: { type: 'string', description: 'ISO datetime of the (first) occurrence, e.g. 2026-08-04T15:00:00' },
        recurrence: { type: 'string', enum: ['none', 'daily', 'weekly', 'monthly'], description: 'Default none (one-off)' },
        byDay: { type: 'array', items: { type: 'number' }, description: 'Weekly only: weekday numbers 0-6 (0=Sunday)' },
        notes: { type: 'string', description: 'Optional notes' },
      },
      required: ['title', 'startsAt'],
    },
    execute: async (args) => {
      try {
        const store = require('./events/events-store');
        const event = await store.addEvent(args);
        return { added: true, event };
      } catch (err) {
        const store = require('./events/events-store');
        return { error: store.friendlyGraphError(err), dependencyDown: store.isGraphConfigError(err) ? 'neo4j' : undefined };
      }
    },
  },

  events_next: {
    name: 'events_next',
    description:
      "List the user's upcoming events (recurrence-aware, soonest first). Use to answer \"what's next\", \"what's on my calendar\", \"do I have anything tomorrow\".",
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max occurrences to return (default 5)' },
      },
    },
    execute: async ({ limit = 5 } = {}) => {
      try {
        const store = require('./events/events-store');
        const list = await store.nextEvents(limit);
        return {
          upcoming: list.map(({ event, at, when }) => ({
            id: event.id,
            title: event.title,
            at: new Date(at).toISOString(),
            when,
            recurrence: event.recurrence,
          })),
        };
      } catch (err) {
        const store = require('./events/events-store');
        return { error: store.friendlyGraphError(err), dependencyDown: store.isGraphConfigError(err) ? 'neo4j' : undefined };
      }
    },
  },

  events_delete: {
    name: 'events_delete',
    description: 'Delete (deactivate) an event by id (preferred, evt_...) or by exact title.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Event id (evt_...)' },
        title: { type: 'string', description: 'Exact event title (used when id unknown)' },
      },
    },
    execute: async (args) => {
      try {
        const store = require('./events/events-store');
        return await store.deleteEvent(args);
      } catch (err) {
        const store = require('./events/events-store');
        return { error: store.friendlyGraphError(err), dependencyDown: store.isGraphConfigError(err) ? 'neo4j' : undefined };
      }
    },
  },

  // ── Meeting Starter ("easier than Zoom") ─────────────────────────────────
  // Draft state in lib/meetings/meeting-draft.js; suggestions from graph
  // :Person nodes; starting opens the WISER Meeting recorder in the target
  // Space (the recorder owns the LiveKit room + guest links from there).

  meeting_open_setup: {
    name: 'meeting_open_setup',
    description:
      'Open (or refresh) the Start-a-Meeting setup modal showing the current draft (title, space, chosen participants) plus suggested people to add. Call when the user wants to start/organize a meeting, and after every draft change so the modal stays current.',
    inputSchema: {
      type: 'object',
      properties: {
        notice: { type: 'string', description: 'Optional status line (e.g. "Added Erika ✓" or "Meeting started")' },
      },
    },
    execute: async ({ notice } = {}) => {
      try {
        const draftLib = require('./meetings/meeting-draft');
        // A meeting just started: the setup modal closed itself and must NOT
        // come back — reopening it stacks a second window under the meeting.
        if (draftLib.wasJustStarted()) {
          return {
            opened: false,
            suppressed: true,
            note: 'Meeting already started — the meeting window is open; the setup modal stays closed. Do not reopen it.',
          };
        }
        const { suggestParticipants } = require('./meetings/participants');
        const { renderMeetingSetup, SETUP_PANEL } = require('./meetings/meeting-setup-app');
        const suggestions = await suggestParticipants(8);
        const html = renderMeetingSetup(draftLib.getDraft(), suggestions, { notice });
        const { showAgentUIModal } = require('./agent-ui-modal-manager');
        showAgentUIModal({
          agentId: 'meeting-starter',
          agentName: 'Meeting Starter',
          html,
          panelWidth: SETUP_PANEL.width,
          panelHeight: SETUP_PANEL.height,
        });
        return { opened: true, draft: draftLib.getDraft(), suggestions };
      } catch (err) {
        return { error: `Could not open meeting setup: ${err.message}` };
      }
    },
  },

  meeting_suggest_participants: {
    name: 'meeting_suggest_participants',
    description:
      'Suggest people to invite to the meeting (humans from the OneReach graph, deduped). Use to answer "who should I invite" or to present choices.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max suggestions (default 8)' },
      },
    },
    execute: async ({ limit = 8 } = {}) => {
      try {
        const { suggestParticipants } = require('./meetings/participants');
        return { suggestions: await suggestParticipants(limit) };
      } catch (err) {
        return { error: err.message };
      }
    },
  },

  meeting_update: {
    name: 'meeting_update',
    description:
      'Update the meeting draft: set the title and/or target Space, add participants (by name, optional email), remove participants. Returns the updated draft. Follow with meeting_open_setup so the modal reflects the change.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Meeting title (e.g. "Design sync")' },
        spaceName: { type: 'string', description: 'Target Space name (found or created at start time)' },
        add: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, email: { type: 'string' } },
            required: ['name'],
          },
          description: 'Participants to add',
        },
        remove: { type: 'array', items: { type: 'string' }, description: 'Participant names to remove' },
      },
    },
    execute: async (args = {}) => {
      try {
        const draftLib = require('./meetings/meeting-draft');
        return { draft: draftLib.updateDraft(args) };
      } catch (err) {
        return { error: err.message };
      }
    },
  },

  meeting_start: {
    name: 'meeting_start',
    description:
      'Start the meeting NOW from the current draft (or explicit overrides): resolves/creates the target Space, opens the WISER Meeting window scoped to it with the participant list, and clears the draft. The meeting window provides the shareable join link.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Override title' },
        spaceName: { type: 'string', description: 'Override Space name' },
        participants: { type: 'array', items: { type: 'string' }, description: 'Override participant names' },
      },
    },
    execute: async (args = {}) => {
      try {
        const draftLib = require('./meetings/meeting-draft');
        return await draftLib.startMeeting(args);
      } catch (err) {
        return { error: err.message };
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
