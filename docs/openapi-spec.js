'use strict';

module.exports = function buildSpec(appVersion) {
  return {
    openapi: '3.0.3',
    info: {
      title: 'GSX Power User - Local APIs',
      version: appVersion || '4.2.0',
      description:
        'Local API reference for the GSX Power User desktop application. ' +
        'These APIs run on localhost and are available to local agents, browser extensions, and tool apps.\n\n' +
        '## Servers\n' +
        '| Service | Port | Purpose |\n' +
        '|---|---|---|\n' +
        '| Spaces API | 47291 | Content storage, search, sharing, conversion |\n' +
        '| Log Server | 47292 | Structured logging, monitoring, app control |\n' +
        '| Agent Exchange | 3456 | Agent registration and task routing (WebSocket) |\n\n' +
        '## WebSocket Endpoints\n' +
        'In addition to REST, the app exposes WebSocket servers for real-time communication. ' +
        'See the **WebSocket** tag group for protocol details.\n\n' +
        '## IPC APIs\n' +
        'In-app agents running inside the Electron renderer have access to IPC APIs via `window.*` objects. ' +
        'See the **IPC** tag group for method signatures.',
      contact: { name: 'GSX Power User', url: 'https://github.com/AirTalk/GSX-power-user' },
    },
    servers: [
      { url: 'http://127.0.0.1:47291', description: 'Spaces API Server' },
      { url: 'http://127.0.0.1:47292', description: 'Log Server' },
    ],
    tags: [
      { name: 'System', description: 'Server status, reload, and database management' },
      { name: 'Spaces', description: 'Create, read, update, and delete Spaces' },
      { name: 'Items', description: 'Manage items within Spaces' },
      { name: 'Tags', description: 'Tag system for organizing items' },
      { name: 'Smart Folders', description: 'Dynamic query-based folders' },
      { name: 'Search', description: 'Full-text and deep semantic search' },
      { name: 'Files', description: 'File storage within Spaces' },
      { name: 'Metadata', description: 'Space, file, and asset metadata' },
      { name: 'Sharing', description: 'Share spaces and items with collaborators' },
      { name: 'GSX', description: 'GSX graph integration, push/pull, and schema management' },
      { name: 'Versions', description: 'Version history and project configuration' },
      { name: 'Git', description: 'Git-backed version control for Spaces' },
      { name: 'Playbooks', description: 'Playbook execution and job management' },
      { name: 'Transcripts', description: 'Real-time voice transcript service' },
      { name: 'Discovery', description: 'Discover and import remote Spaces' },
      { name: 'Data Sources', description: 'External data source connections' },
      { name: 'Conversion', description: 'Format conversion pipeline (POST to /api/convert)' },
      { name: 'Browser Extension', description: 'Browser extension tab capture and content sending' },
      { name: 'Logs', description: 'Log Server: query, stream, and export structured logs (port 47292)' },
      { name: 'Logging Level', description: 'Log Server: runtime logging level control (port 47292)' },
      { name: 'App Control', description: 'Log Server: app restart and process info (port 47292)' },
      {
        name: 'WebSocket: Agent Exchange',
        description:
          'WebSocket protocol on `ws://localhost:3456` for agent registration, bidding, and task execution.\n\n' +
          '**Register** `{ type: "register", agentId, categories, capabilities }`\n\n' +
          '**Bid Response** `{ type: "bid_response", auctionId, bid: { confidence, reasoning, estimatedTimeMs } }`\n\n' +
          '**Task ACK** `{ type: "task_ack", taskId, agentId }`\n\n' +
          '**Task Result** `{ type: "task_result", taskId, result: { success, output } }`\n\n' +
          '**Task Heartbeat** `{ type: "task_heartbeat", taskId, progress }`\n\n' +
          'Server sends: `registered`, `bid_request`, `task_assignment`, `ping`, `error`',
      },
      {
        name: 'WebSocket: Log Server',
        description:
          'WebSocket on `ws://127.0.0.1:47292/ws` for real-time log streaming.\n\n' +
          '**subscribe** `{ type: "subscribe", filter: { level?, category?, minLevel? } }`\n\n' +
          '**query** `{ type: "query", id, params: { level?, category?, search?, since?, until?, limit? } }`\n\n' +
          '**stats** `{ type: "stats" }`\n\n' +
          '**log** `{ type: "log", level, category, message, data }`\n\n' +
          'Server sends: `event`, `query-result`, `stats`, `subscribed`, `unsubscribed`, `error`',
      },
      {
        name: 'WebSocket: Spaces',
        description:
          'WebSocket on `ws://127.0.0.1:47291` for browser extension communication.\n\n' +
          '**auth** `{ type: "auth", token }`\n\n' +
          '**tabs** `{ type: "tabs", requestId }`\n\n' +
          '**capture-result** `{ type: "capture-result", requestId, data }`\n\n' +
          'Server sends: `auth-success`, `auth-failed`, `pong`, `get-tabs`, `capture-tab`',
      },
      {
        name: 'IPC: Browsing API',
        description:
          'Available as `window.browsing` in Electron renderers. Session-based browser automation.\n\n' +
          '**Session lifecycle:** `createSession(opts)`, `destroySession(id)`, `listSessions()`, `getSession(id)`\n\n' +
          '**Navigation:** `navigate(id, url, opts)`, `extract(id, opts)`, `snapshot(id)`, `act(id, action)`, `screenshot(id)`\n\n' +
          '**HITL:** `promote(id, opts)`, `waitForUser(id, opts)`\n\n' +
          '**Auth:** `checkAuthState(id)`, `autoFillCredentials(id, url)`, `getCookies(id)`, `setCookies(id, cookies)`, ' +
          '`inheritFromPartition(id, src, opts)`, `saveToAuthPool(id)`, `importChromeCookies(domain, id)`\n\n' +
          '**Orchestration:** `research(query, opts)`, `workflow(steps, opts)`, `comparePages(urls, opts)`\n\n' +
          '**Safety:** `checkDomain(url)`, `blockDomain(domain)`, `getLimits()`, `setLimits(overrides)`',
      },
      {
        name: 'IPC: AI Service',
        description:
          'Available as `window.ai` in Electron renderers. Centralized LLM access.\n\n' +
          '**Core:** `chat(opts)`, `complete(prompt, opts)`, `json(prompt, opts)`, `vision(imageData, prompt, opts)`\n\n' +
          '**Streaming:** `chatStream(opts)`, `onStreamChunk(requestId, cb)`\n\n' +
          '**Media:** `embed(input, opts)`, `transcribe(buffer, opts)`, `imageGenerate(prompt, opts)`\n\n' +
          '**Profiles:** fast (Haiku), standard (Sonnet), powerful (Opus), large (GPT-4o), vision, embedding, transcription\n\n' +
          '**Management:** `getStatus()`, `getCostSummary()`, `getProfiles()`, `setProfile(name, config)`',
      },
      {
        name: 'IPC: Spaces',
        description:
          'Available as `window.spaces` in Electron renderers. Unified Spaces CRUD.\n\n' +
          '**Spaces:** `list()`, `get(id)`, `create(opts)`, `update(id, opts)`, `delete(id)`\n\n' +
          '**Items:** `items.list(spaceId)`, `items.get(spaceId, itemId)`, `items.add(spaceId, data)`, ' +
          '`items.update(spaceId, itemId, data)`, `items.delete(spaceId, itemId)`\n\n' +
          '**Tags:** `tags.list(spaceId)`, `tags.listAll()`, `tags.findItems(tag)`\n\n' +
          '**Smart Folders:** `smartFolders.list()`, `smartFolders.create(opts)`, `smartFolders.getItems(id)`\n\n' +
          '**Files:** `files.list(spaceId)`, `files.read(spaceId, path)`, `files.write(spaceId, path, content)`\n\n' +
          '**Search:** `search(query)`\n\n' +
          '**GSX:** `gsx.pushAsset(spaceId, itemId)`, `gsx.pushSpace(spaceId)`, `gsx.getLinks(spaceId, itemId)`',
      },
    ],
    paths: {
      ...spacesSystemPaths(),
      ...spacesExtensionPaths(),
      ...spacesCrudPaths(),
      ...itemsCrudPaths(),
      ...tagsPaths(),
      ...smartFolderPaths(),
      ...searchPaths(),
      ...filesPaths(),
      ...metadataPaths(),
      ...sharingPaths(),
      ...gsxPaths(),
      ...versionPaths(),
      ...gitPaths(),
      ...playbookPaths(),
      ...transcriptPaths(),
      ...discoveryPaths(),
      ...dataSourcePaths(),
      ...conversionPaths(),
      ...logServerPaths(),
    },
    components: {
      schemas: schemaDefinitions(),
      parameters: parameterDefinitions(),
    },
  };
};

// ---------------------------------------------------------------------------
// Reusable schemas
// ---------------------------------------------------------------------------

function schemaDefinitions() {
  return {
    Space: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Unique space identifier' },
        name: { type: 'string' },
        description: { type: 'string' },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
        itemCount: { type: 'integer' },
      },
    },
    SpaceCreate: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
      },
    },
    Item: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        type: { type: 'string', description: 'Content type (text, image, code, html, video, audio, pdf, url, file)' },
        content: { type: 'string' },
        title: { type: 'string' },
        sourceUrl: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        metadata: { type: 'object' },
        pinned: { type: 'boolean' },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },
    ItemCreate: {
      type: 'object',
      properties: {
        content: { type: 'string' },
        type: { type: 'string' },
        title: { type: 'string' },
        sourceUrl: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        metadata: { type: 'object' },
        filePath: { type: 'string' },
        fileName: { type: 'string' },
      },
    },
    Tag: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        count: { type: 'integer' },
      },
    },
    SmartFolder: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        query: { type: 'object', description: 'Query filter definition' },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },
    SmartFolderCreate: {
      type: 'object',
      required: ['name', 'query'],
      properties: {
        name: { type: 'string' },
        query: { type: 'object' },
      },
    },
    LogEntry: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        timestamp: { type: 'string', format: 'date-time' },
        level: { type: 'string', enum: ['error', 'warn', 'info', 'debug'] },
        category: { type: 'string' },
        message: { type: 'string' },
        source: { type: 'string' },
        data: { type: 'object' },
      },
    },
    LogStats: {
      type: 'object',
      properties: {
        total: { type: 'integer' },
        byLevel: { type: 'object', additionalProperties: { type: 'integer' } },
        byCategory: { type: 'object', additionalProperties: { type: 'integer' } },
      },
    },
    PlaybookJob: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: ['queued', 'running', 'completed', 'failed', 'cancelled'] },
        startedAt: { type: 'string', format: 'date-time' },
        completedAt: { type: 'string', format: 'date-time' },
        result: { type: 'object' },
      },
    },
    ConversionRequest: {
      type: 'object',
      required: ['input', 'from', 'to'],
      properties: {
        input: { type: 'string', description: 'Source content (plain text or base64)' },
        from: { type: 'string', description: 'Source format (e.g. text, pdf, md)' },
        to: { type: 'string', description: 'Target format (e.g. html, md, pdf)' },
        mode: { type: 'string', default: 'auto' },
        options: { type: 'object' },
        async: { type: 'boolean', description: 'If true, returns a jobId immediately' },
      },
    },
    ConversionResult: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        output: { type: 'string' },
        outputEncoding: { type: 'string', enum: ['base64'], description: 'Present when output is binary' },
      },
    },
    HealthResponse: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'ok' },
        appVersion: { type: 'string' },
        port: { type: 'integer' },
        uptime: { type: 'number', description: 'Seconds since server start' },
        queue: { type: 'object' },
        connections: {
          type: 'object',
          properties: {
            websocket: { type: 'integer' },
            sse: { type: 'integer' },
          },
        },
      },
    },
    Error: {
      type: 'object',
      properties: {
        error: { type: 'string' },
        message: { type: 'string' },
      },
    },
    SuccessResponse: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        message: { type: 'string' },
      },
    },
  };
}

function parameterDefinitions() {
  return {
    spaceId: { name: 'spaceId', in: 'path', required: true, schema: { type: 'string' }, description: 'Space identifier' },
    itemId: { name: 'itemId', in: 'path', required: true, schema: { type: 'string' }, description: 'Item identifier' },
    limit: { name: 'limit', in: 'query', schema: { type: 'integer', default: 100, maximum: 1000 }, description: 'Max results to return' },
    offset: { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 }, description: 'Pagination offset' },
  };
}

// ---------------------------------------------------------------------------
// Helper: build a simple endpoint object
// ---------------------------------------------------------------------------

function ep(tag, summary, opts = {}) {
  const o = { tags: [tag], summary, operationId: opts.operationId };
  if (opts.description) o.description = opts.description;
  if (opts.params) o.parameters = opts.params;
  if (opts.body) o.requestBody = { required: true, content: { 'application/json': { schema: opts.body } } };
  o.responses = opts.responses || {
    200: { description: 'Success', content: { 'application/json': { schema: opts.responseSchema || { type: 'object' } } } },
  };
  return o;
}

function ref(name) { return { $ref: `#/components/schemas/${name}` }; }
function pref(name) { return { $ref: `#/components/parameters/${name}` }; }
function arr(itemSchema) { return { type: 'array', items: itemSchema }; }

// ---------------------------------------------------------------------------
// Spaces API - System
// ---------------------------------------------------------------------------

function spacesSystemPaths() {
  return {
    '/api/status': {
      get: ep('System', 'Server status', {
        operationId: 'getStatus',
        responseSchema: {
          type: 'object',
          properties: {
            status: { type: 'string' }, version: { type: 'string' },
            extensionConnected: { type: 'boolean' }, port: { type: 'integer' },
            databaseReady: { type: 'boolean' }, database: { type: 'object' },
          },
        },
      }),
    },
    '/api/reload': {
      post: ep('System', 'Reload server', { operationId: 'reloadServer', responseSchema: ref('SuccessResponse') }),
    },
    '/api/database/status': {
      get: ep('System', 'Database status', { operationId: 'getDatabaseStatus' }),
    },
    '/api/database/rebuild': {
      post: ep('System', 'Rebuild database index', {
        operationId: 'rebuildDatabase',
        responseSchema: {
          type: 'object',
          properties: { success: { type: 'boolean' }, message: { type: 'string' }, itemsRebuilt: { type: 'integer' } },
        },
      }),
    },
    '/api/token': {
      get: ep('System', 'Get extension auth token', {
        operationId: 'getToken',
        description: 'Returns a token for browser extension authentication. Only accessible from localhost.',
        responseSchema: { type: 'object', properties: { token: { type: 'string' } } },
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Browser Extension
// ---------------------------------------------------------------------------

function spacesExtensionPaths() {
  return {
    '/api/tabs': {
      get: ep('Browser Extension', 'List open browser tabs', {
        operationId: 'getTabs',
        responseSchema: { type: 'object', properties: { tabs: arr({ type: 'object' }) } },
      }),
    },
    '/api/capture-tab': {
      post: ep('Browser Extension', 'Capture screenshot/text from tab', {
        operationId: 'captureTab',
        body: { type: 'object', required: ['tabId'], properties: { tabId: { type: 'integer' } } },
      }),
    },
    '/api/send-to-space': {
      post: ep('Browser Extension', 'Send content to a Space', {
        operationId: 'sendToSpace',
        body: {
          type: 'object', required: ['spaceId'],
          properties: {
            spaceId: { type: 'string' }, content: { type: 'string' }, type: { type: 'string' },
            title: { type: 'string' }, sourceUrl: { type: 'string' },
            tags: arr({ type: 'string' }), metadata: { type: 'object' },
          },
        },
        responseSchema: { type: 'object', properties: { success: { type: 'boolean' }, itemId: { type: 'string' } } },
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Spaces CRUD
// ---------------------------------------------------------------------------

function spacesCrudPaths() {
  return {
    '/api/spaces': {
      get: ep('Spaces', 'List all Spaces', { operationId: 'listSpaces', responseSchema: { type: 'object', properties: { spaces: arr(ref('Space')) } } }),
      post: ep('Spaces', 'Create a Space', { operationId: 'createSpace', body: ref('SpaceCreate'), responseSchema: ref('Space') }),
    },
    '/api/spaces/{spaceId}': {
      get: ep('Spaces', 'Get Space by ID', { operationId: 'getSpace', params: [pref('spaceId')], responseSchema: ref('Space') }),
      put: ep('Spaces', 'Update a Space', { operationId: 'updateSpace', params: [pref('spaceId')], body: ref('SpaceCreate'), responseSchema: ref('Space') }),
      delete: ep('Spaces', 'Delete a Space', { operationId: 'deleteSpace', params: [pref('spaceId')], responseSchema: ref('SuccessResponse') }),
    },
  };
}

// ---------------------------------------------------------------------------
// Items CRUD
// ---------------------------------------------------------------------------

function itemsCrudPaths() {
  return {
    '/api/spaces/{spaceId}/items': {
      get: ep('Items', 'List items in a Space', {
        operationId: 'listItems',
        params: [pref('spaceId'), pref('limit'), pref('offset')],
        responseSchema: { type: 'object', properties: { items: arr(ref('Item')) } },
      }),
      post: ep('Items', 'Add item to a Space', { operationId: 'addItem', params: [pref('spaceId')], body: ref('ItemCreate'), responseSchema: ref('Item') }),
    },
    '/api/spaces/{spaceId}/items/{itemId}': {
      get: ep('Items', 'Get item by ID', { operationId: 'getItem', params: [pref('spaceId'), pref('itemId')], responseSchema: ref('Item') }),
      put: ep('Items', 'Update an item', { operationId: 'updateItem', params: [pref('spaceId'), pref('itemId')], body: ref('ItemCreate'), responseSchema: ref('Item') }),
      delete: ep('Items', 'Delete an item', { operationId: 'deleteItem', params: [pref('spaceId'), pref('itemId')], responseSchema: ref('SuccessResponse') }),
    },
    '/api/spaces/{spaceId}/items/{itemId}/move': {
      post: ep('Items', 'Move item to another Space', {
        operationId: 'moveItem',
        params: [pref('spaceId'), pref('itemId')],
        body: { type: 'object', required: ['targetSpaceId'], properties: { targetSpaceId: { type: 'string' } } },
        responseSchema: ref('SuccessResponse'),
      }),
    },
    '/api/spaces/{spaceId}/items/{itemId}/pin': {
      post: ep('Items', 'Toggle item pin status', { operationId: 'togglePin', params: [pref('spaceId'), pref('itemId')], responseSchema: ref('SuccessResponse') }),
    },
    '/api/spaces/{spaceId}/items/upload': {
      post: ep('Items', 'Upload file to Space', {
        operationId: 'uploadFile',
        params: [pref('spaceId')],
        description: 'Multipart file upload. Send file as form-data.',
      }),
    },
    '/api/spaces/{spaceId}/items/push': {
      post: ep('Items', 'Bulk push assets', {
        operationId: 'bulkPushItems',
        params: [pref('spaceId')],
        body: { type: 'object' },
        responseSchema: ref('SuccessResponse'),
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

function tagsPaths() {
  return {
    '/api/tags': {
      get: ep('Tags', 'List all tags', { operationId: 'listAllTags', params: [pref('limit'), pref('offset')], responseSchema: arr(ref('Tag')) }),
    },
    '/api/tags/search': {
      get: ep('Tags', 'Search items by tags', {
        operationId: 'searchByTags',
        params: [{ name: 'q', in: 'query', schema: { type: 'string' }, description: 'Tag search query' }],
      }),
    },
    '/api/spaces/{spaceId}/tags': {
      get: ep('Tags', 'List tags in a Space', { operationId: 'listSpaceTags', params: [pref('spaceId')], responseSchema: arr(ref('Tag')) }),
    },
    '/api/spaces/{spaceId}/items/{itemId}/tags': {
      get: ep('Tags', 'Get item tags', { operationId: 'getItemTags', params: [pref('spaceId'), pref('itemId')], responseSchema: arr({ type: 'string' }) }),
      put: ep('Tags', 'Replace item tags', {
        operationId: 'setItemTags',
        params: [pref('spaceId'), pref('itemId')],
        body: { type: 'object', required: ['tags'], properties: { tags: arr({ type: 'string' }) } },
      }),
      post: ep('Tags', 'Add tag to item', {
        operationId: 'addItemTag',
        params: [pref('spaceId'), pref('itemId')],
        body: { type: 'object', required: ['tag'], properties: { tag: { type: 'string' } } },
      }),
    },
    '/api/spaces/{spaceId}/items/{itemId}/tags/{tagName}': {
      delete: ep('Tags', 'Remove tag from item', {
        operationId: 'removeItemTag',
        params: [pref('spaceId'), pref('itemId'), { name: 'tagName', in: 'path', required: true, schema: { type: 'string' } }],
        responseSchema: ref('SuccessResponse'),
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Smart Folders
// ---------------------------------------------------------------------------

function smartFolderPaths() {
  return {
    '/api/smart-folders': {
      get: ep('Smart Folders', 'List smart folders', { operationId: 'listSmartFolders', responseSchema: arr(ref('SmartFolder')) }),
      post: ep('Smart Folders', 'Create smart folder', { operationId: 'createSmartFolder', body: ref('SmartFolderCreate'), responseSchema: ref('SmartFolder') }),
    },
    '/api/smart-folders/{folderId}': {
      get: ep('Smart Folders', 'Get smart folder', {
        operationId: 'getSmartFolder',
        params: [{ name: 'folderId', in: 'path', required: true, schema: { type: 'string' } }],
        responseSchema: ref('SmartFolder'),
      }),
      put: ep('Smart Folders', 'Update smart folder', {
        operationId: 'updateSmartFolder',
        params: [{ name: 'folderId', in: 'path', required: true, schema: { type: 'string' } }],
        body: ref('SmartFolderCreate'),
        responseSchema: ref('SmartFolder'),
      }),
      delete: ep('Smart Folders', 'Delete smart folder', {
        operationId: 'deleteSmartFolder',
        params: [{ name: 'folderId', in: 'path', required: true, schema: { type: 'string' } }],
        responseSchema: ref('SuccessResponse'),
      }),
    },
    '/api/smart-folders/{folderId}/items': {
      get: ep('Smart Folders', 'Get smart folder items', {
        operationId: 'getSmartFolderItems',
        params: [{ name: 'folderId', in: 'path', required: true, schema: { type: 'string' } }, pref('limit'), pref('offset')],
        responseSchema: arr(ref('Item')),
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function searchPaths() {
  return {
    '/api/search': {
      get: ep('Search', 'Search across Spaces', {
        operationId: 'search',
        params: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' }, description: 'Search query' },
          pref('limit'), pref('offset'),
        ],
      }),
    },
    '/api/search/suggestions': {
      get: ep('Search', 'Get search suggestions', {
        operationId: 'searchSuggestions',
        params: [{ name: 'q', in: 'query', schema: { type: 'string' } }],
      }),
    },
    '/api/search/deep': {
      post: ep('Search', 'Deep semantic search', { operationId: 'deepSearch', body: { type: 'object' } }),
    },
    '/api/search/deep/filters': {
      get: ep('Search', 'Get deep search filter options', { operationId: 'getDeepSearchFilters' }),
    },
  };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function filesPaths() {
  return {
    '/api/spaces/{spaceId}/files': {
      get: ep('Files', 'List files in a Space', { operationId: 'listFiles', params: [pref('spaceId')] }),
    },
    '/api/spaces/{spaceId}/files/{filePath}': {
      get: ep('Files', 'Read file content', {
        operationId: 'readFile',
        params: [pref('spaceId'), { name: 'filePath', in: 'path', required: true, schema: { type: 'string' }, description: 'File path (may contain slashes)' }],
        description: 'Returns raw file content. Content-Type depends on the file type.',
      }),
      put: ep('Files', 'Write file content', {
        operationId: 'writeFile',
        params: [pref('spaceId'), { name: 'filePath', in: 'path', required: true, schema: { type: 'string' } }],
        body: { type: 'string', description: 'File content' },
        responseSchema: ref('SuccessResponse'),
      }),
      delete: ep('Files', 'Delete a file', {
        operationId: 'deleteFile',
        params: [pref('spaceId'), { name: 'filePath', in: 'path', required: true, schema: { type: 'string' } }],
        responseSchema: ref('SuccessResponse'),
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

function metadataPaths() {
  return {
    '/api/spaces/{spaceId}/metadata': {
      get: ep('Metadata', 'Get Space metadata', { operationId: 'getSpaceMetadata', params: [pref('spaceId')] }),
      put: ep('Metadata', 'Update Space metadata', { operationId: 'updateSpaceMetadata', params: [pref('spaceId')], body: { type: 'object' } }),
    },
    '/api/spaces/{spaceId}/metadata/files/{filePath}': {
      get: ep('Metadata', 'Get file metadata', {
        operationId: 'getFileMetadata',
        params: [pref('spaceId'), { name: 'filePath', in: 'path', required: true, schema: { type: 'string' } }],
      }),
      put: ep('Metadata', 'Set file metadata', {
        operationId: 'setFileMetadata',
        params: [pref('spaceId'), { name: 'filePath', in: 'path', required: true, schema: { type: 'string' } }],
        body: { type: 'object' },
      }),
    },
    '/api/spaces/{spaceId}/metadata/assets/{assetType}': {
      get: ep('Metadata', 'Get asset metadata', {
        operationId: 'getAssetMetadata',
        params: [pref('spaceId'), { name: 'assetType', in: 'path', required: true, schema: { type: 'string' } }],
      }),
      put: ep('Metadata', 'Set asset metadata', {
        operationId: 'setAssetMetadata',
        params: [pref('spaceId'), { name: 'assetType', in: 'path', required: true, schema: { type: 'string' } }],
        body: { type: 'object' },
      }),
    },
    '/api/spaces/{spaceId}/metadata/approvals/{itemType}/{itemId}': {
      put: ep('Metadata', 'Set approval status', {
        operationId: 'setApprovalStatus',
        params: [
          pref('spaceId'),
          { name: 'itemType', in: 'path', required: true, schema: { type: 'string' } },
          pref('itemId'),
        ],
        body: { type: 'object' },
      }),
    },
    '/api/spaces/{spaceId}/metadata/project-config': {
      get: ep('Metadata', 'Get project configuration', { operationId: 'getProjectConfig', params: [pref('spaceId')] }),
      put: ep('Metadata', 'Update project configuration', { operationId: 'updateProjectConfig', params: [pref('spaceId')], body: { type: 'object' } }),
    },
  };
}

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

function sharingPaths() {
  return {
    '/api/shares': {
      get: ep('Sharing', 'Get items shared with me', { operationId: 'getSharedWithMe' }),
    },
    '/api/spaces/{spaceId}/share': {
      post: ep('Sharing', 'Share a Space', {
        operationId: 'shareSpace',
        params: [pref('spaceId')],
        body: { type: 'object', required: ['email'], properties: { email: { type: 'string' }, permission: { type: 'string' } } },
      }),
      get: ep('Sharing', 'Get Space sharing info', { operationId: 'getSpaceShares', params: [pref('spaceId')] }),
    },
    '/api/spaces/{spaceId}/share/{email}': {
      delete: ep('Sharing', 'Unshare a Space', {
        operationId: 'unshareSpace',
        params: [pref('spaceId'), { name: 'email', in: 'path', required: true, schema: { type: 'string' } }],
        responseSchema: ref('SuccessResponse'),
      }),
    },
    '/api/spaces/{spaceId}/items/{itemId}/share': {
      post: ep('Sharing', 'Share an item', {
        operationId: 'shareItem',
        params: [pref('spaceId'), pref('itemId')],
        body: { type: 'object', required: ['email'], properties: { email: { type: 'string' }, permission: { type: 'string' } } },
      }),
      get: ep('Sharing', 'Get item sharing info', { operationId: 'getItemShares', params: [pref('spaceId'), pref('itemId')] }),
    },
    '/api/spaces/{spaceId}/items/{itemId}/share/{email}': {
      delete: ep('Sharing', 'Unshare an item', {
        operationId: 'unshareItem',
        params: [pref('spaceId'), pref('itemId'), { name: 'email', in: 'path', required: true, schema: { type: 'string' } }],
        responseSchema: ref('SuccessResponse'),
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// GSX
// ---------------------------------------------------------------------------

function gsxPaths() {
  return {
    '/api/gsx/status': { get: ep('GSX', 'GSX connection status', { operationId: 'getGSXStatus' }) },
    '/api/gsx/schemas': { get: ep('GSX', 'List GSX schemas', { operationId: 'listGSXSchemas' }) },
    '/api/gsx/schema/{entity}': {
      get: ep('GSX', 'Get GSX schema for entity', {
        operationId: 'getGSXSchema',
        params: [{ name: 'entity', in: 'path', required: true, schema: { type: 'string' } }],
      }),
    },
    '/api/gsx/stats': { get: ep('GSX', 'GSX statistics', { operationId: 'getGSXStats' }) },
    '/api/gsx/test': { get: ep('GSX', 'Test GSX connection', { operationId: 'testGSXConnection' }) },
    '/api/gsx/seed-permission-schema': { post: ep('GSX', 'Seed permission schema', { operationId: 'seedPermissionSchema', body: { type: 'object' } }) },
    '/api/spaces/{spaceId}/push': {
      post: ep('GSX', 'Push Space to GSX', { operationId: 'pushSpace', params: [pref('spaceId')], body: { type: 'object' } }),
    },
    '/api/spaces/{spaceId}/unpush': {
      post: ep('GSX', 'Unpush Space from GSX', { operationId: 'unpushSpace', params: [pref('spaceId')], body: { type: 'object' } }),
    },
    '/api/spaces/{spaceId}/items/{itemId}/push': {
      post: ep('GSX', 'Push item to GSX', { operationId: 'pushItem', params: [pref('spaceId'), pref('itemId')], body: { type: 'object' } }),
    },
    '/api/spaces/{spaceId}/items/{itemId}/unpush': {
      post: ep('GSX', 'Unpush item from GSX', { operationId: 'unpushItem', params: [pref('spaceId'), pref('itemId')], body: { type: 'object' } }),
    },
    '/api/spaces/{spaceId}/items/{itemId}/push-status': {
      get: ep('GSX', 'Get item push status', { operationId: 'getItemPushStatus', params: [pref('spaceId'), pref('itemId')] }),
    },
    '/api/spaces/{spaceId}/items/{itemId}/visibility': {
      put: ep('GSX', 'Update item visibility', { operationId: 'updateItemVisibility', params: [pref('spaceId'), pref('itemId')], body: { type: 'object' } }),
    },
    '/api/spaces/{spaceId}/items/{itemId}/links': {
      get: ep('GSX', 'Get item links', { operationId: 'getItemLinks', params: [pref('spaceId'), pref('itemId')] }),
    },
  };
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

function versionPaths() {
  return {
    '/api/spaces/{spaceId}/metadata/versions': {
      get: ep('Versions', 'Get version history', { operationId: 'getVersions', params: [pref('spaceId')] }),
      post: ep('Versions', 'Create a version', { operationId: 'createVersion', params: [pref('spaceId')], body: { type: 'object' } }),
    },
  };
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

function gitPaths() {
  return {
    '/api/spaces/{spaceId}/git-status': { get: ep('Git', 'Get git status', { operationId: 'getGitStatus', params: [pref('spaceId')] }) },
    '/api/spaces/{spaceId}/git-versions': {
      get: ep('Git', 'Get git commit log', { operationId: 'getGitVersions', params: [pref('spaceId')] }),
      post: ep('Git', 'Create git commit', { operationId: 'createGitCommit', params: [pref('spaceId')], body: { type: 'object' } }),
    },
    '/api/spaces/{spaceId}/git-diff': {
      get: ep('Git', 'Get git diff', { operationId: 'getGitDiff', params: [pref('spaceId')] }),
    },
    '/api/spaces/{spaceId}/git-branches': {
      get: ep('Git', 'List git branches', { operationId: 'listGitBranches', params: [pref('spaceId')] }),
      post: ep('Git', 'Create git branch', {
        operationId: 'createGitBranch', params: [pref('spaceId')],
        body: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
      }),
    },
    '/api/spaces/{spaceId}/git-merge': {
      post: ep('Git', 'Merge git branch', { operationId: 'mergeGitBranch', params: [pref('spaceId')], body: { type: 'object' } }),
    },
    '/api/spaces/{spaceId}/git-tags': {
      get: ep('Git', 'List git tags', { operationId: 'listGitTags', params: [pref('spaceId')] }),
      post: ep('Git', 'Create git tag', { operationId: 'createGitTag', params: [pref('spaceId')], body: { type: 'object' } }),
    },
    '/api/spaces/{spaceId}/git-revert': {
      post: ep('Git', 'Revert to commit', { operationId: 'revertGitCommit', params: [pref('spaceId')], body: { type: 'object' } }),
    },
    '/api/git/migration': {
      get: ep('Git', 'Get migration status', { operationId: 'getGitMigrationStatus' }),
      post: ep('Git', 'Run git migration', { operationId: 'runGitMigration', body: { type: 'object' } }),
    },
  };
}

// ---------------------------------------------------------------------------
// Playbooks
// ---------------------------------------------------------------------------

function playbookPaths() {
  return {
    '/api/playbook/execute': {
      post: ep('Playbooks', 'Execute a playbook', { operationId: 'executePlaybook', body: { type: 'object' }, responseSchema: ref('PlaybookJob') }),
    },
    '/api/playbook/jobs': {
      get: ep('Playbooks', 'List playbook jobs', { operationId: 'listPlaybookJobs', params: [pref('limit'), pref('offset')], responseSchema: arr(ref('PlaybookJob')) }),
    },
    '/api/playbook/jobs/{jobId}': {
      get: ep('Playbooks', 'Get playbook job status', {
        operationId: 'getPlaybookJob',
        params: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }],
        responseSchema: ref('PlaybookJob'),
      }),
    },
    '/api/playbook/jobs/{jobId}/respond': {
      post: ep('Playbooks', 'Respond to playbook job', {
        operationId: 'respondToPlaybookJob',
        params: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }],
        body: { type: 'object' },
      }),
    },
    '/api/playbook/jobs/{jobId}/cancel': {
      post: ep('Playbooks', 'Cancel playbook job', {
        operationId: 'cancelPlaybookJob',
        params: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }],
        responseSchema: ref('SuccessResponse'),
      }),
    },
    '/api/playbook/spaces/{spaceId}/playbooks': {
      get: ep('Playbooks', 'List playbooks in a Space', { operationId: 'listPlaybooks', params: [pref('spaceId')] }),
    },
  };
}

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

function transcriptPaths() {
  return {
    '/api/transcript': {
      get: ep('Transcripts', 'Get transcript entries', {
        operationId: 'getTranscript',
        params: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
          { name: 'since', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'ISO timestamp' },
          { name: 'speaker', in: 'query', schema: { type: 'string', enum: ['user', 'agent', 'all'] } },
          { name: 'final_only', in: 'query', schema: { type: 'boolean' } },
        ],
        responseSchema: {
          type: 'object',
          properties: {
            entries: arr({ type: 'object' }), count: { type: 'integer' },
            sessionId: { type: 'string' }, timestamp: { type: 'string' },
          },
        },
      }),
    },
    '/api/transcript/stream': {
      get: ep('Transcripts', 'Stream transcript (SSE)', {
        operationId: 'streamTranscript',
        description: 'Server-Sent Events stream of transcript entries.',
        params: [
          { name: 'speaker', in: 'query', schema: { type: 'string', enum: ['user', 'agent', 'all'] } },
          { name: 'final_only', in: 'query', schema: { type: 'boolean' } },
        ],
        responses: { 200: { description: 'SSE stream', content: { 'text/event-stream': { schema: { type: 'string' } } } } },
      }),
    },
    '/api/transcript/pending': {
      get: ep('Transcripts', 'Get pending transcript agents', {
        operationId: 'getPendingTranscripts',
        responseSchema: {
          type: 'object',
          properties: {
            hasPending: { type: 'boolean' }, agents: arr({ type: 'object' }),
            details: { type: 'object' }, timestamp: { type: 'string' },
          },
        },
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function discoveryPaths() {
  return {
    '/api/spaces/discover': {
      get: ep('Discovery', 'Discover remote Spaces', { operationId: 'discoverSpaces' }),
      post: ep('Discovery', 'Import discovered Spaces', { operationId: 'importDiscoveredSpaces', body: { type: 'object' } }),
    },
  };
}

// ---------------------------------------------------------------------------
// Data Sources
// ---------------------------------------------------------------------------

function dataSourcePaths() {
  return {
    '/api/data-sources': {
      get: ep('Data Sources', 'List data sources', { operationId: 'listDataSources', params: [pref('limit'), pref('offset')] }),
    },
    '/api/data-sources/{itemId}': {
      get: ep('Data Sources', 'Get data source', { operationId: 'getDataSource', params: [pref('itemId')] }),
    },
    '/api/data-sources/{itemId}/document': {
      get: ep('Data Sources', 'Get data source document', { operationId: 'getDataSourceDocument', params: [pref('itemId')] }),
      put: ep('Data Sources', 'Update data source document', { operationId: 'updateDataSourceDocument', params: [pref('itemId')], body: { type: 'object' } }),
    },
    '/api/data-sources/{itemId}/operations': {
      get: ep('Data Sources', 'Get CRUD operation definitions', { operationId: 'getDataSourceOperations', params: [pref('itemId')] }),
    },
    '/api/data-sources/{itemId}/test': {
      post: ep('Data Sources', 'Test data source connection', { operationId: 'testDataSource', params: [pref('itemId')], body: { type: 'object' } }),
    },
  };
}

// ---------------------------------------------------------------------------
// Conversion API
// ---------------------------------------------------------------------------

function conversionPaths() {
  return {
    '/api/convert': {
      post: ep('Conversion', 'Convert content between formats', {
        operationId: 'convert',
        body: ref('ConversionRequest'),
        responses: {
          200: { description: 'Synchronous result', content: { 'application/json': { schema: ref('ConversionResult') } } },
          202: { description: 'Async job created', content: { 'application/json': { schema: { type: 'object', properties: { jobId: { type: 'string' }, status: { type: 'string' } } } } } },
        },
      }),
    },
    '/api/convert/capabilities': {
      get: ep('Conversion', 'List converter capabilities', {
        operationId: 'getConversionCapabilities',
        responseSchema: { type: 'object', properties: { converters: arr({ type: 'object' }), count: { type: 'integer' } } },
      }),
    },
    '/api/convert/graph': {
      get: ep('Conversion', 'Get format conversion graph', { operationId: 'getConversionGraph' }),
    },
    '/api/convert/pipeline': {
      post: ep('Conversion', 'Run multi-step conversion pipeline', {
        operationId: 'runConversionPipeline',
        body: {
          type: 'object', required: ['input', 'steps'],
          properties: {
            input: { type: 'string' },
            steps: arr({ type: 'object', required: ['to'], properties: { to: { type: 'string' } } }),
          },
        },
        responseSchema: ref('ConversionResult'),
      }),
    },
    '/api/convert/status/{jobId}': {
      get: ep('Conversion', 'Check async conversion job status', {
        operationId: 'getConversionJobStatus',
        params: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Job status', content: { 'application/json': { schema: { type: 'object', properties: { jobId: { type: 'string' }, status: { type: 'string' }, result: ref('ConversionResult') } } } } },
          404: { description: 'Job not found', content: { 'application/json': { schema: ref('Error') } } },
        },
      }),
    },
    '/api/convert/validate/playbook': {
      post: ep('Conversion', 'Validate a playbook', { operationId: 'validatePlaybook', body: { type: 'object', required: ['playbook'], properties: { playbook: { type: 'object' }, framework: { type: 'string' } } } }),
    },
    '/api/convert/diagnose/playbook': {
      post: ep('Conversion', 'Diagnose playbook issues', { operationId: 'diagnosePlaybook', body: { type: 'object', required: ['playbook'], properties: { playbook: { type: 'object' }, framework: { type: 'string' }, sourceContent: {} } } }),
    },
  };
}

// ---------------------------------------------------------------------------
// Log Server (port 47292)
// ---------------------------------------------------------------------------

function logServerPaths() {
  return {
    '/health': {
      get: ep('Logs', 'Server health and status', {
        operationId: 'getHealth',
        description: 'Returns app version, uptime, queue stats, and connection counts. Served on port 47292.',
        responseSchema: ref('HealthResponse'),
      }),
    },
    '/logs': {
      get: ep('Logs', 'Query log entries', {
        operationId: 'queryLogs',
        description: 'Served on port 47292.',
        params: [
          { name: 'level', in: 'query', schema: { type: 'string', enum: ['error', 'warn', 'info', 'debug'] } },
          { name: 'category', in: 'query', schema: { type: 'string' } },
          { name: 'source', in: 'query', schema: { type: 'string' } },
          { name: 'search', in: 'query', schema: { type: 'string' } },
          { name: 'since', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'until', in: 'query', schema: { type: 'string', format: 'date-time' } },
          pref('limit'), pref('offset'),
        ],
        responseSchema: { type: 'object', properties: { count: { type: 'integer' }, query: { type: 'object' }, data: arr(ref('LogEntry')) } },
      }),
      post: ep('Logs', 'Push a log event', {
        operationId: 'pushLogEvent',
        description: 'Served on port 47292. Max body 1 MB.',
        body: {
          type: 'object',
          properties: {
            level: { type: 'string', enum: ['error', 'warn', 'info', 'debug'], default: 'info' },
            category: { type: 'string', default: 'external' },
            message: { type: 'string' },
            data: { type: 'object' },
          },
        },
        responses: { 201: { description: 'Log entry created', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, entry: ref('LogEntry') } } } } } },
      }),
    },
    '/logs/stats': {
      get: ep('Logs', 'Get aggregated log statistics', { operationId: 'getLogStats', description: 'Served on port 47292.', responseSchema: ref('LogStats') }),
    },
    '/logs/stream': {
      get: ep('Logs', 'Stream log events (SSE)', {
        operationId: 'streamLogs',
        description: 'Server-Sent Events stream. Served on port 47292.',
        params: [
          { name: 'level', in: 'query', schema: { type: 'string' } },
          { name: 'category', in: 'query', schema: { type: 'string' } },
          { name: 'source', in: 'query', schema: { type: 'string' } },
          { name: 'minLevel', in: 'query', schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'SSE stream', content: { 'text/event-stream': { schema: { type: 'string' } } } } },
      }),
    },
    '/logs/export': {
      get: ep('Logs', 'Export logs', {
        operationId: 'exportLogs',
        description: 'Served on port 47292.',
        params: [
          { name: 'since', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'until', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'text'], default: 'json' } },
          { name: 'level', in: 'query', schema: { type: 'string' } },
          { name: 'category', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 5000 } },
        ],
      }),
    },
    '/logging/level': {
      get: ep('Logging Level', 'Get current logging level', {
        operationId: 'getLoggingLevel',
        description: 'Served on port 47292.',
        responseSchema: {
          type: 'object',
          properties: {
            level: { type: 'string' },
            persisted: { type: 'string' },
            validLevels: arr({ type: 'string' }),
          },
        },
      }),
      post: ep('Logging Level', 'Set logging level', {
        operationId: 'setLoggingLevel',
        description: 'Changes the runtime logging level. Persisted across restarts. Served on port 47292.',
        body: {
          type: 'object', required: ['level'],
          properties: { level: { type: 'string', enum: ['off', 'error', 'warn', 'info', 'debug'] } },
        },
        responseSchema: { type: 'object', properties: { success: { type: 'boolean' }, level: { type: 'string' }, persisted: { type: 'boolean' } } },
      }),
    },
    '/app/restart': {
      post: ep('App Control', 'Restart the application', {
        operationId: 'restartApp',
        description: 'Triggers an Electron app relaunch after a 1-second delay. Served on port 47292.',
        responseSchema: ref('SuccessResponse'),
      }),
    },
    '/app/pid': {
      get: ep('App Control', 'Get process ID', {
        operationId: 'getAppPid',
        description: 'Served on port 47292.',
        responseSchema: { type: 'object', properties: { pid: { type: 'integer' } } },
      }),
    },
  };
}
