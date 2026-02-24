/**
 * WebMCP Provider -- tool definitions for exposing app functionality
 * via the navigator.modelContext API.
 *
 * Each function returns an array of tool definitions that can be
 * registered on the appropriate app page.  The returned definitions
 * use the WebMCP ToolDefinition shape:
 *   { name, description, inputSchema, execute, annotations? }
 *
 * The `execute` callbacks assume access to the corresponding
 * window.* IPC bridges (spaces, clipboard, api, ai).
 */

// ── Spaces Tools ───────────────────────────────────────────

function spacesTools() {
  return [
    {
      name: 'spaces_list',
      description:
        'List all content spaces. Returns an array of space objects with id, name, description, and item count.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      execute: async () => {
        const spaces = await window.spaces.list();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                spaces.map((s) => ({
                  id: s.id,
                  name: s.name,
                  description: s.description,
                  itemCount: s.itemCount || 0,
                }))
              ),
            },
          ],
        };
      },
    },
    {
      name: 'spaces_search',
      description:
        'Search across all spaces for content matching a query string. Returns matching items with their space, type, and preview.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query to find content across all spaces',
          },
        },
        required: ['query'],
      },
      annotations: { readOnlyHint: true },
      execute: async ({ query }) => {
        const results = await window.clipboard.search(query);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                (results || []).slice(0, 20).map((r) => ({
                  id: r.id,
                  type: r.type,
                  title: r.title || r.name,
                  preview: (r.content || r.text || '').substring(0, 200),
                  spaceName: r.spaceName,
                }))
              ),
            },
          ],
        };
      },
    },
    {
      name: 'spaces_create',
      description:
        'Create a new content space with a name and optional description.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name for the new space' },
          description: {
            type: 'string',
            description: 'Optional description of what this space contains',
          },
        },
        required: ['name'],
      },
      execute: async ({ name, description }) => {
        const space = await window.spaces.create(name, { description });
        return {
          content: [
            {
              type: 'text',
              text: `Created space "${space.name}" (id: ${space.id})`,
            },
          ],
        };
      },
    },
    {
      name: 'spaces_add_item',
      description:
        'Add a text or URL content item to an existing space by space ID.',
      inputSchema: {
        type: 'object',
        properties: {
          spaceId: { type: 'string', description: 'ID of the target space' },
          type: {
            type: 'string',
            enum: ['text', 'url', 'html', 'code'],
            description: 'Content type of the item',
          },
          content: { type: 'string', description: 'The content to store' },
          title: {
            type: 'string',
            description: 'Optional title for the item',
          },
        },
        required: ['spaceId', 'type', 'content'],
      },
      execute: async ({ spaceId, type, content, title }) => {
        const item = await window.spaces.items.add(spaceId, {
          type: type || 'text',
          content,
          title,
        });
        return {
          content: [
            {
              type: 'text',
              text: `Added ${type} item to space (id: ${item?.id || 'unknown'})`,
            },
          ],
        };
      },
    },
  ];
}

// ── Search Tools ───────────────────────────────────────────

function searchTools() {
  return [
    {
      name: 'web_search',
      description:
        'Perform a web search and return structured results with titles, snippets, and URLs. Uses a multi-tier search system for reliability.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          maxResults: {
            type: 'number',
            description: 'Maximum results to return (default 5)',
          },
        },
        required: ['query'],
      },
      annotations: { readOnlyHint: true },
      execute: async ({ query, maxResults }) => {
        const results = await window.api.invoke('aider:web-search', {
          query,
          maxResults: maxResults || 5,
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                (results || []).slice(0, maxResults || 5).map((r) => ({
                  title: r.title,
                  snippet: r.snippet,
                  url: r.url,
                }))
              ),
            },
          ],
        };
      },
    },
  ];
}

// ── Navigation Tools ───────────────────────────────────────

function navigationTools() {
  return [
    {
      name: 'browser_open_url',
      description:
        'Open a URL in a new browser tab within the application.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to open' },
        },
        required: ['url'],
      },
      execute: async ({ url }) => {
        if (typeof createNewTab === 'function') {
          createNewTab(url);
        } else {
          window.api.send('open-in-new-tab', { url });
        }
        return {
          content: [{ type: 'text', text: `Opened ${url} in a new tab` }],
        };
      },
    },
    {
      name: 'browser_current_page',
      description:
        'Get information about the currently active browser tab including its title and URL.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      execute: async () => {
        const active = document.querySelector('webview.active, .webview-container.active webview');
        if (!active) {
          return {
            content: [{ type: 'text', text: 'No active tab' }],
          };
        }
        let title = '';
        try {
          title = await active.executeJavaScript('document.title');
        } catch {
          title = 'unknown';
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                url: active.getURL(),
                title,
              }),
            },
          ],
        };
      },
    },
  ];
}

// ── Settings Tools ─────────────────────────────────────────

function settingsTools() {
  return [
    {
      name: 'app_settings_read',
      description:
        'Read the current application settings. Returns a JSON object with all user-configurable preferences.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      execute: async () => {
        const settings = await window.api.getSettings();
        const safe = { ...settings };
        // Strip sensitive fields
        delete safe.apiKeys;
        delete safe.credentials;
        delete safe.tokens;
        return {
          content: [{ type: 'text', text: JSON.stringify(safe) }],
        };
      },
    },
  ];
}

// ── Registration Helper ────────────────────────────────────

/**
 * Register a set of tools with navigator.modelContext if available.
 * Silently no-ops if the API is not present.
 *
 * @param {Array} tools - Array of WebMCP tool definitions
 * @returns {Array} Array of registration handles (for cleanup)
 */
function registerAll(tools) {
  if (typeof navigator === 'undefined' || !navigator.modelContext) return [];

  const registrations = [];
  for (const tool of tools) {
    try {
      navigator.modelContext.registerTool(tool);
      registrations.push(tool.name);
    } catch (err) {
      console.warn(`[WebMCP Provider] Failed to register ${tool.name}:`, err.message);
    }
  }

  if (registrations.length > 0) {
    console.log(`[WebMCP Provider] Registered ${registrations.length} tool(s):`, registrations.join(', '));
  }
  return registrations;
}

/**
 * Generate a self-contained script string that registers tools
 * when executed inside a webview or page context.
 *
 * @param {string[]} toolSets - Which tool sets to include: 'spaces', 'search', 'navigation', 'settings'
 * @returns {string} JavaScript source code to execute
 */
function generateInjectionScript(toolSets = []) {
  const parts = [];

  if (toolSets.includes('spaces')) parts.push(`(${spacesTools.toString()})()`);
  if (toolSets.includes('search')) parts.push(`(${searchTools.toString()})()`);
  if (toolSets.includes('navigation')) parts.push(`(${navigationTools.toString()})()`);
  if (toolSets.includes('settings')) parts.push(`(${settingsTools.toString()})()`);

  return `
(function() {
  'use strict';
  if (typeof navigator === 'undefined' || !navigator.modelContext) return;

  var allTools = [].concat(${parts.join(', ')});
  allTools.forEach(function(tool) {
    try {
      navigator.modelContext.registerTool(tool);
      console.log('[WebMCP Provider] Registered:', tool.name);
    } catch (e) {
      console.warn('[WebMCP Provider] Failed:', tool.name, e.message);
    }
  });
  console.log('[WebMCP Provider] Done.', allTools.length, 'tools registered');
})();
`;
}

module.exports = {
  spacesTools,
  searchTools,
  navigationTools,
  settingsTools,
  registerAll,
  generateInjectionScript,
};
