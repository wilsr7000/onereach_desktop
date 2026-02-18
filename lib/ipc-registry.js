/**
 * IPC Channel Registry
 * Auto-generated documentation of all IPC channels in the app.
 *
 * This file serves as the single source of truth for IPC channel names.
 * Use it for:
 * - Documenting all channels
 * - Validating channel names in development mode
 * - Generating preload whitelists
 *
 * To regenerate: Search for ipcMain.handle/ipcMain.on in main.js and clipboard-manager-v2-adapter.js
 */

const IPC_CHANNELS = {
  // --- Logging ---
  'logging:set-level': { type: 'handle', source: 'main.js', description: 'Set logging level' },
  'logging:get-level': { type: 'handle', source: 'main.js', description: 'Get current logging level' },
  'logging:enqueue': { type: 'on', source: 'main.js', description: 'Enqueue log event' },
  'logging:query': { type: 'handle', source: 'main.js', description: 'Query logs' },
  'logging:get-stats': { type: 'handle', source: 'main.js', description: 'Get log stats' },
  'logging:export': { type: 'handle', source: 'main.js', description: 'Export logs' },
  'logging:subscribe': { type: 'handle', source: 'main.js', description: 'Subscribe to log stream' },
  'logging:get-files': { type: 'handle', source: 'main.js', description: 'Get log files' },
  'logging:get-recent-logs': { type: 'handle', source: 'main.js', description: 'Get recent logs' },

  // --- Logger ---
  'logger:get-recent-logs': { type: 'handle', source: 'main.js', description: 'Get recent logs' },
  'logger:info': { type: 'on', source: 'main.js', description: 'Info log event' },
  'logger:warn': { type: 'on', source: 'main.js', description: 'Warn log event' },
  'logger:error': { type: 'on', source: 'main.js', description: 'Error log event' },
  'logger:debug': { type: 'on', source: 'main.js', description: 'Debug log event' },
  'logger:event': { type: 'on', source: 'main.js', description: 'Event log event' },
  'logger:user-action': { type: 'on', source: 'main.js', description: 'User action log event' },
  'logger:batch': { type: 'on', source: 'main.js', description: 'Batch log entries' },
  'logger:get-stats': { type: 'handle', source: 'main.js', description: 'Get logger stats' },
  'logger:export': { type: 'handle', source: 'main.js', description: 'Export logger data' },
  'logger:get-files': { type: 'handle', source: 'main.js', description: 'Get logger files' },

  // --- Log ---
  'log-message': { type: 'on', source: 'main.js', description: 'Log message event' },
  'debug:log': { type: 'on', source: 'main.js', description: 'Debug log event' },
  'log:event': { type: 'handle', source: 'main.js', description: 'Log event' },
  'log:tab-created': { type: 'handle', source: 'main.js', description: 'Log tab created' },
  'log:tab-closed': { type: 'handle', source: 'main.js', description: 'Log tab closed' },
  'log:tab-switched': { type: 'handle', source: 'main.js', description: 'Log tab switched' },
  'log:window-navigation': { type: 'handle', source: 'main.js', description: 'Log window navigation' },
  'log:feature-used': { type: 'handle', source: 'main.js', description: 'Log feature usage' },

  // --- Test ---
  'test:set-context': { type: 'on', source: 'main.js', description: 'Set test context' },
  'test:clear-context': { type: 'on', source: 'main.js', description: 'Clear test context' },

  // --- Agent ---
  'agent:respond-to-escalation': { type: 'handle', source: 'main.js', description: 'Respond to agent escalation' },
  'agent:get-pending-escalations': { type: 'handle', source: 'main.js', description: 'Get pending escalations' },

  // --- Convert ---
  'convert:run': { type: 'handle', source: 'main.js', description: 'Run conversion pipeline' },
  'convert:capabilities': { type: 'handle', source: 'main.js', description: 'Get convert capabilities' },
  'convert:pipeline': { type: 'handle', source: 'main.js', description: 'Get convert pipeline' },
  'convert:graph': { type: 'handle', source: 'main.js', description: 'Get convert graph' },
  'convert:status': { type: 'handle', source: 'main.js', description: 'Get convert job status' },
  'convert:validate-playbook': { type: 'handle', source: 'main.js', description: 'Validate playbook' },
  'convert:diagnose-playbook': { type: 'handle', source: 'main.js', description: 'Diagnose playbook' },

  // --- Browser automation ---
  'browser-automation:start': { type: 'handle', source: 'main.js', description: 'Start browser automation' },
  'browser-automation:stop': { type: 'handle', source: 'main.js', description: 'Stop browser automation' },
  'browser-automation:status': { type: 'handle', source: 'main.js', description: 'Get automation status' },
  'browser-automation:configure': { type: 'handle', source: 'main.js', description: 'Configure automation' },
  'browser-automation:navigate': { type: 'handle', source: 'main.js', description: 'Navigate to URL' },
  'browser-automation:snapshot': { type: 'handle', source: 'main.js', description: 'Take DOM snapshot' },
  'browser-automation:screenshot': { type: 'handle', source: 'main.js', description: 'Take screenshot' },
  'browser-automation:act': { type: 'handle', source: 'main.js', description: 'Perform UI action' },
  'browser-automation:scroll': { type: 'handle', source: 'main.js', description: 'Scroll page' },
  'browser-automation:evaluate': { type: 'handle', source: 'main.js', description: 'Evaluate script' },
  'browser-automation:extractText': { type: 'handle', source: 'main.js', description: 'Extract text by selector' },
  'browser-automation:extractLinks': { type: 'handle', source: 'main.js', description: 'Extract page links' },
  'browser-automation:waitFor': { type: 'handle', source: 'main.js', description: 'Wait for condition' },
  'browser-automation:tabs': { type: 'handle', source: 'main.js', description: 'List browser tabs' },
  'browser-automation:openTab': { type: 'handle', source: 'main.js', description: 'Open new tab' },
  'browser-automation:closeTab': { type: 'handle', source: 'main.js', description: 'Close browser tab' },
  'browser-automation:focusTab': { type: 'handle', source: 'main.js', description: 'Focus tab by ID' },
  'browser-automation:cookies': { type: 'handle', source: 'main.js', description: 'Get cookies' },
  'browser-automation:setCookie': { type: 'handle', source: 'main.js', description: 'Set cookie' },
  'browser-automation:clearCookies': { type: 'handle', source: 'main.js', description: 'Clear cookies' },
  'browser-automation:setViewport': { type: 'handle', source: 'main.js', description: 'Set viewport size' },
  'browser-automation:pdf': { type: 'handle', source: 'main.js', description: 'Generate PDF' },
  'browser-automation:handleDialog': { type: 'handle', source: 'main.js', description: 'Handle native dialog' },
  'browser-automation:getLastDialog': { type: 'handle', source: 'main.js', description: 'Get last dialog' },
  'browser-automation:upload': { type: 'handle', source: 'main.js', description: 'Upload files' },
  'browser-automation:uploadViaChooser': { type: 'handle', source: 'main.js', description: 'Upload via chooser' },
  'browser-automation:download': { type: 'handle', source: 'main.js', description: 'Trigger download' },
  'browser-automation:getDownloadDir': { type: 'handle', source: 'main.js', description: 'Get download directory' },
  'browser-automation:storageGet': { type: 'handle', source: 'main.js', description: 'Get storage value' },
  'browser-automation:storageSet': { type: 'handle', source: 'main.js', description: 'Set storage value' },
  'browser-automation:storageClear': { type: 'handle', source: 'main.js', description: 'Clear storage' },
  'browser-automation:networkStart': { type: 'handle', source: 'main.js', description: 'Start network capture' },
  'browser-automation:networkStop': { type: 'handle', source: 'main.js', description: 'Stop network capture' },
  'browser-automation:getConsole': { type: 'handle', source: 'main.js', description: 'Get console logs' },
  'browser-automation:getErrors': { type: 'handle', source: 'main.js', description: 'Get page errors' },
  'browser-automation:getRequests': { type: 'handle', source: 'main.js', description: 'Get network requests' },
  'browser-automation:getResponseBody': { type: 'handle', source: 'main.js', description: 'Get response body' },
  'browser-automation:screenshotElement': { type: 'handle', source: 'main.js', description: 'Screenshot element' },
  'browser-automation:drag': { type: 'handle', source: 'main.js', description: 'Drag element' },
  'browser-automation:setDevice': { type: 'handle', source: 'main.js', description: 'Set device emulation' },
  'browser-automation:setGeolocation': { type: 'handle', source: 'main.js', description: 'Set geolocation' },
  'browser-automation:clearGeolocation': { type: 'handle', source: 'main.js', description: 'Clear geolocation' },
  'browser-automation:setTimezone': { type: 'handle', source: 'main.js', description: 'Set timezone' },
  'browser-automation:setLocale': { type: 'handle', source: 'main.js', description: 'Set locale' },
  'browser-automation:setOffline': { type: 'handle', source: 'main.js', description: 'Set offline mode' },
  'browser-automation:setExtraHeaders': { type: 'handle', source: 'main.js', description: 'Set extra headers' },
  'browser-automation:setCredentials': { type: 'handle', source: 'main.js', description: 'Set credentials' },
  'browser-automation:setMedia': { type: 'handle', source: 'main.js', description: 'Set media emulation' },
  'browser-automation:traceStart': { type: 'handle', source: 'main.js', description: 'Start trace' },
  'browser-automation:traceStop': { type: 'handle', source: 'main.js', description: 'Stop trace' },
  'browser-automation:highlight': { type: 'handle', source: 'main.js', description: 'Highlight element' },
  'browser-automation:waitForFunction': { type: 'handle', source: 'main.js', description: 'Wait for function' },

  // --- Spaces ---
  'spaces:list': { type: 'handle', source: 'main.js', description: 'List all spaces' },
  'spaces:get': { type: 'handle', source: 'main.js', description: 'Get space by ID' },
  'spaces:create': { type: 'handle', source: 'main.js', description: 'Create space' },
  'spaces:update': { type: 'handle', source: 'main.js', description: 'Update space' },
  'spaces:delete': { type: 'handle', source: 'main.js', description: 'Delete space' },
  'spaces:discover': { type: 'handle', source: 'main.js', description: 'Discover spaces' },
  'spaces:discover:import': { type: 'handle', source: 'main.js', description: 'Import discovered spaces' },
  'spaces:items:list': { type: 'handle', source: 'main.js', description: 'List space items' },
  'spaces:items:get': { type: 'handle', source: 'main.js', description: 'Get space item' },
  'spaces:items:add': { type: 'handle', source: 'main.js', description: 'Add item to space' },
  'spaces:items:update': { type: 'handle', source: 'main.js', description: 'Update space item' },
  'spaces:items:delete': { type: 'handle', source: 'main.js', description: 'Delete space item' },
  'spaces:items:move': { type: 'handle', source: 'main.js', description: 'Move item between spaces' },
  'spaces:items:togglePin': { type: 'handle', source: 'main.js', description: 'Toggle item pin' },
  'spaces:search': { type: 'handle', source: 'main.js', description: 'Search spaces' },
  'spaces:metadata:get': { type: 'handle', source: 'main.js', description: 'Get space metadata' },
  'spaces:metadata:update': { type: 'handle', source: 'main.js', description: 'Update space metadata' },
  'spaces:metadata:getFile': { type: 'handle', source: 'main.js', description: 'Get metadata file' },
  'spaces:metadata:setFile': { type: 'handle', source: 'main.js', description: 'Set metadata file' },
  'spaces:metadata:setAsset': { type: 'handle', source: 'main.js', description: 'Set asset metadata' },
  'spaces:metadata:setApproval': { type: 'handle', source: 'main.js', description: 'Set approval status' },
  'spaces:metadata:addVersion': { type: 'handle', source: 'main.js', description: 'Add metadata version' },
  'spaces:metadata:updateProjectConfig': { type: 'handle', source: 'main.js', description: 'Update project config' },
  'spaces:files:getPath': { type: 'handle', source: 'main.js', description: 'Get space file path' },
  'spaces:files:list': { type: 'handle', source: 'main.js', description: 'List space files' },
  'spaces:files:read': { type: 'handle', source: 'main.js', description: 'Read space file' },
  'spaces:files:write': { type: 'handle', source: 'main.js', description: 'Write space file' },
  'spaces:files:delete': { type: 'handle', source: 'main.js', description: 'Delete space file' },
  'spaces:getStorageRoot': { type: 'handle', source: 'main.js', description: 'Get storage root' },
  'spaces:items:getTags': { type: 'handle', source: 'main.js', description: 'Get item tags' },
  'spaces:items:setTags': { type: 'handle', source: 'main.js', description: 'Set item tags' },
  'spaces:items:addTag': { type: 'handle', source: 'main.js', description: 'Add item tag' },
  'spaces:items:removeTag': { type: 'handle', source: 'main.js', description: 'Remove item tag' },
  'spaces:items:generateMetadata': { type: 'handle', source: 'main.js', description: 'Generate item metadata' },
  'spaces:tags:list': { type: 'handle', source: 'main.js', description: 'List space tags' },
  'spaces:tags:listAll': { type: 'handle', source: 'main.js', description: 'List all tags' },
  'spaces:tags:findItems': { type: 'handle', source: 'main.js', description: 'Find items by tags' },
  'spaces:tags:rename': { type: 'handle', source: 'main.js', description: 'Rename tag' },
  'spaces:tags:deleteFromSpace': { type: 'handle', source: 'main.js', description: 'Delete tag from space' },
  'spaces:smartFolders:list': { type: 'handle', source: 'main.js', description: 'List smart folders' },
  'spaces:smartFolders:get': { type: 'handle', source: 'main.js', description: 'Get smart folder' },
  'spaces:smartFolders:create': { type: 'handle', source: 'main.js', description: 'Create smart folder' },
  'spaces:smartFolders:update': { type: 'handle', source: 'main.js', description: 'Update smart folder' },
  'spaces:smartFolders:delete': { type: 'handle', source: 'main.js', description: 'Delete smart folder' },
  'spaces:smartFolders:getItems': { type: 'handle', source: 'main.js', description: 'Get smart folder items' },
  'spaces:smartFolders:preview': { type: 'handle', source: 'main.js', description: 'Preview smart folder' },
  'spaces:gsx:initialize': { type: 'handle', source: 'main.js', description: 'Initialize GSX' },
  'spaces:gsx:setCurrentUser': { type: 'handle', source: 'main.js', description: 'Set GSX current user' },
  'spaces:gsx:getToken': { type: 'handle', source: 'main.js', description: 'Get GSX token' },
  'spaces:gsx:pushAsset': { type: 'handle', source: 'main.js', description: 'Push asset to GSX' },
  'spaces:gsx:pushAssets': { type: 'handle', source: 'main.js', description: 'Push multiple assets' },
  'spaces:gsx:pushSpace': { type: 'handle', source: 'main.js', description: 'Push space to GSX' },
  'spaces:gsx:unpushAsset': { type: 'handle', source: 'main.js', description: 'Unpush asset' },
  'spaces:gsx:unpushAssets': { type: 'handle', source: 'main.js', description: 'Unpush multiple assets' },
  'spaces:gsx:unpushSpace': { type: 'handle', source: 'main.js', description: 'Unpush space' },
  'spaces:gsx:changeVisibility': { type: 'handle', source: 'main.js', description: 'Change asset visibility' },
  'spaces:gsx:changeVisibilityBulk': { type: 'handle', source: 'main.js', description: 'Bulk change visibility' },
  'spaces:gsx:getPushStatus': { type: 'handle', source: 'main.js', description: 'Get push status' },
  'spaces:gsx:getPushStatuses': { type: 'handle', source: 'main.js', description: 'Get push statuses' },
  'spaces:gsx:updatePushStatus': { type: 'handle', source: 'main.js', description: 'Update push status' },
  'spaces:gsx:checkLocalChanges': { type: 'handle', source: 'main.js', description: 'Check local changes' },
  'spaces:gsx:getLinks': { type: 'handle', source: 'main.js', description: 'Get item links' },
  'spaces:gsx:getShareLink': { type: 'handle', source: 'main.js', description: 'Get share link' },
  'spaces:gsx:getLink': { type: 'handle', source: 'main.js', description: 'Get link by type' },

  // --- Spaces API ---
  'spaces-api:getVideoPath': { type: 'handle', source: 'main.js', description: 'Get video path' },
  'spaces-api:list': { type: 'handle', source: 'main.js', description: 'List spaces' },
  'spaces-api:get': { type: 'handle', source: 'main.js', description: 'Get space' },
  'spaces-api:create': { type: 'handle', source: 'main.js', description: 'Create space' },
  'spaces-api:update': { type: 'handle', source: 'main.js', description: 'Update space' },
  'spaces-api:delete': { type: 'handle', source: 'main.js', description: 'Delete space' },
  'spaces-api:items:list': { type: 'handle', source: 'main.js', description: 'List items' },
  'spaces-api:items:get': { type: 'handle', source: 'main.js', description: 'Get item' },
  'spaces-api:items:add': { type: 'handle', source: 'main.js', description: 'Add item' },
  'spaces-api:items:update': { type: 'handle', source: 'main.js', description: 'Update item' },
  'spaces-api:items:delete': { type: 'handle', source: 'main.js', description: 'Delete item' },
  'spaces-api:items:move': { type: 'handle', source: 'main.js', description: 'Move item' },
  'spaces-api:files:getSpacePath': { type: 'handle', source: 'main.js', description: 'Get space path' },
  'spaces-api:files:list': { type: 'handle', source: 'main.js', description: 'List files' },
  'spaces-api:files:read': { type: 'handle', source: 'main.js', description: 'Read file' },
  'spaces-api:files:write': { type: 'handle', source: 'main.js', description: 'Write file' },

  // --- Contacts ---
  'contacts:list': { type: 'handle', source: 'main.js', description: 'List contacts' },
  'contacts:search': { type: 'handle', source: 'main.js', description: 'Search contacts' },
  'contacts:suggest': { type: 'handle', source: 'main.js', description: 'Suggest contacts' },
  'contacts:add': { type: 'handle', source: 'main.js', description: 'Add contact' },
  'contacts:update': { type: 'handle', source: 'main.js', description: 'Update contact' },
  'contacts:delete': { type: 'handle', source: 'main.js', description: 'Delete contact' },
  'contacts:resolve': { type: 'handle', source: 'main.js', description: 'Resolve contact guests' },
  'contacts:stats': { type: 'handle', source: 'main.js', description: 'Get contact stats' },
  'contacts:learn-from-events': { type: 'handle', source: 'main.js', description: 'Learn from events' },
  'contacts:frequent': { type: 'handle', source: 'main.js', description: 'Get frequent contacts' },
  'contacts:meetings': { type: 'handle', source: 'main.js', description: 'Get contact meetings' },
  'contacts:co-attendees': { type: 'handle', source: 'main.js', description: 'Get co-attendees' },
  'contacts:ingest-events': { type: 'handle', source: 'main.js', description: 'Ingest calendar events' },

  // --- Generative search ---
  'generative-search:search': { type: 'handle', source: 'main.js', description: 'Generative search' },
  'generative-search:estimate-cost': { type: 'handle', source: 'main.js', description: 'Estimate search cost' },
  'generative-search:cancel': { type: 'handle', source: 'main.js', description: 'Cancel search' },
  'generative-search:get-filter-types': { type: 'handle', source: 'main.js', description: 'Get filter types' },
  'generative-search:clear-cache': { type: 'handle', source: 'main.js', description: 'Clear search cache' },

  // --- Playbook ---
  'playbook:execute': { type: 'handle', source: 'main.js', description: 'Execute playbook' },
  'playbook:status': { type: 'handle', source: 'main.js', description: 'Get playbook status' },
  'playbook:respond': { type: 'handle', source: 'main.js', description: 'Respond to playbook' },
  'playbook:cancel': { type: 'handle', source: 'main.js', description: 'Cancel playbook' },
  'playbook:find': { type: 'handle', source: 'main.js', description: 'Find playbook' },
  'playbook:jobs': { type: 'handle', source: 'main.js', description: 'List playbook jobs' },

  // --- Sync ---
  'sync:push': { type: 'handle', source: 'main.js', description: 'Push sync' },
  'sync:pull': { type: 'handle', source: 'main.js', description: 'Pull sync' },
  'sync:status': { type: 'handle', source: 'main.js', description: 'Get sync status' },

  // --- Multi-tenant ---
  'multi-tenant:get-token': { type: 'handle', source: 'main.js', description: 'Get tenant token' },
  'multi-tenant:has-token': { type: 'handle', source: 'main.js', description: 'Check has token' },
  'multi-tenant:inject-token': { type: 'handle', source: 'main.js', description: 'Inject tenant token' },
  'multi-tenant:attach-listener': { type: 'handle', source: 'main.js', description: 'Attach token listener' },
  'multi-tenant:remove-listener': { type: 'handle', source: 'main.js', description: 'Remove token listener' },
  'multi-tenant:get-cookies': { type: 'handle', source: 'main.js', description: 'Get tenant cookies' },
  'multi-tenant:register-partition': { type: 'handle', source: 'main.js', description: 'Register partition' },
  'multi-tenant:unregister-partition': { type: 'handle', source: 'main.js', description: 'Unregister partition' },
  'multi-tenant:get-environments': { type: 'handle', source: 'main.js', description: 'Get environments' },
  'multi-tenant:get-diagnostics': { type: 'handle', source: 'main.js', description: 'Get diagnostics' },
  'multi-tenant:get-user-data': { type: 'handle', source: 'main.js', description: 'Get user data' },
  'multi-tenant:get-user-data-sync': { type: 'on', source: 'main.js', description: 'Get user data sync' },

  // --- Onereach ---
  'onereach:get-credentials': { type: 'handle', source: 'main.js', description: 'Get credentials' },
  'onereach:save-credentials': { type: 'handle', source: 'main.js', description: 'Save credentials' },
  'onereach:delete-credentials': { type: 'handle', source: 'main.js', description: 'Delete credentials' },
  'onereach:save-totp': { type: 'handle', source: 'main.js', description: 'Save TOTP secret' },
  'onereach:delete-totp': { type: 'handle', source: 'main.js', description: 'Delete TOTP' },
  'onereach:test-login': { type: 'handle', source: 'main.js', description: 'Test login' },
  'onereach:execute-in-frame': { type: 'handle', source: 'main.js', description: 'Execute script in frame' },

  // --- TOTP ---
  'totp:scan-qr-screen': { type: 'handle', source: 'main.js', description: 'Scan QR for TOTP' },
  'totp:get-current-code': { type: 'handle', source: 'main.js', description: 'Get current TOTP code' },

  // --- Conversation ---
  'conversation:isEnabled': { type: 'handle', source: 'main.js', description: 'Check capture enabled' },
  'conversation:isPaused': { type: 'handle', source: 'main.js', description: 'Check capture paused' },
  'conversation:setPaused': { type: 'handle', source: 'main.js', description: 'Set capture paused' },
  'conversation:markDoNotSave': { type: 'handle', source: 'main.js', description: 'Mark do not save' },
  'conversation:isMarkedDoNotSave': { type: 'handle', source: 'main.js', description: 'Check do not save' },
  'conversation:getCurrent': { type: 'handle', source: 'main.js', description: 'Get current conversation' },
  'conversation:undoSave': { type: 'handle', source: 'main.js', description: 'Undo conversation save' },
  'conversation:copyToSpace': { type: 'handle', source: 'main.js', description: 'Copy to space' },
  'conversation:getMedia': { type: 'handle', source: 'main.js', description: 'Get conversation media' },
  'conversation:test-capture': { type: 'handle', source: 'main.js', description: 'Test capture (test mode)' },

  // --- Response capture ---
  'chatgpt-response-captured': { type: 'on', source: 'main.js', description: 'ChatGPT response captured' },
  'grok-response-captured': { type: 'on', source: 'main.js', description: 'Grok response captured' },
  'gemini-response-captured': { type: 'on', source: 'main.js', description: 'Gemini response captured' },

  // --- Claude ---
  'claude:runHeadlessPrompt': { type: 'handle', source: 'main.js', description: 'Run headless prompt' },
  'claude:unified-complete': { type: 'handle', source: 'main.js', description: 'Legacy unified complete' },
  'claude:unified-status': { type: 'handle', source: 'main.js', description: 'Legacy unified status' },
  'claude:unified-update-settings': { type: 'handle', source: 'main.js', description: 'Legacy update settings' },

  // --- AI ---
  'ai:chat': { type: 'handle', source: 'main.js', description: 'AI chat' },
  'ai:complete': { type: 'handle', source: 'main.js', description: 'AI complete' },
  'ai:json': { type: 'handle', source: 'main.js', description: 'AI JSON output' },
  'ai:vision': { type: 'handle', source: 'main.js', description: 'AI vision' },
  'ai:embed': { type: 'handle', source: 'main.js', description: 'AI embed' },
  'ai:transcribe': { type: 'handle', source: 'main.js', description: 'AI transcribe' },
  'ai:chatStream': { type: 'handle', source: 'main.js', description: 'AI streaming chat' },
  'ai:getCostSummary': { type: 'handle', source: 'main.js', description: 'Get AI cost summary' },
  'ai:getStatus': { type: 'handle', source: 'main.js', description: 'Get AI status' },
  'ai:getProfiles': { type: 'handle', source: 'main.js', description: 'Get AI profiles' },
  'ai:setProfile': { type: 'handle', source: 'main.js', description: 'Set AI profile' },
  'ai:testConnection': { type: 'handle', source: 'main.js', description: 'Test AI connection' },
  'ai:resetCircuit': { type: 'handle', source: 'main.js', description: 'Reset AI circuit' },
  'ai:imageGenerate': { type: 'handle', source: 'main.js', description: 'AI image generation' },
  'ai:direct-call': { type: 'handle', source: 'main.js', description: 'Direct AI API call' },

  // --- App ---
  'get-overlay-script': { type: 'handle', source: 'main.js', description: 'Get overlay script' },
  'app:execute-action': { type: 'handle', source: 'main.js', description: 'Execute app action' },
  'app:list-actions': { type: 'handle', source: 'main.js', description: 'List app actions' },

  // --- Tab picker ---
  'tab-picker:get-status': { type: 'handle', source: 'main.js', description: 'Get tab picker status' },
  'tab-picker:get-tabs': { type: 'handle', source: 'main.js', description: 'Get extension tabs' },
  'tab-picker:capture-tab': { type: 'handle', source: 'main.js', description: 'Capture tab' },
  'tab-picker:fetch-url': { type: 'handle', source: 'main.js', description: 'Fetch URL content' },
  'tab-picker:result': { type: 'on', source: 'main.js', description: 'Tab picker result' },
  'tab-picker:close': { type: 'on', source: 'main.js', description: 'Close tab picker' },
  'tab-picker:open-setup': { type: 'on', source: 'main.js', description: 'Open setup guide' },
  'open-tab-picker': { type: 'handle', source: 'main.js', description: 'Open tab picker' },
  'get-extension-auth-token': { type: 'handle', source: 'main.js', description: 'Get extension auth token' },

  // --- Module ---
  'module:get-installed': { type: 'handle', source: 'main.js', description: 'Get installed modules' },
  'module:open': { type: 'handle', source: 'main.js', description: 'Open module' },
  'module:uninstall': { type: 'handle', source: 'main.js', description: 'Uninstall module' },
  'module:install-from-url': { type: 'handle', source: 'main.js', description: 'Install from URL' },
  'module:install-from-file': { type: 'handle', source: 'main.js', description: 'Install from file' },
  'module:evaluate': { type: 'handle', source: 'main.js', description: 'Evaluate module' },
  'module:ai-review': { type: 'handle', source: 'main.js', description: 'AI review module' },
  'module:check-claude-api': { type: 'handle', source: 'main.js', description: 'Check Claude API' },
  'module:generate-ai-report': { type: 'handle', source: 'main.js', description: 'Generate AI report' },
  'module:download-temp': { type: 'handle', source: 'main.js', description: 'Download temp module' },
  'module:get-web-tools': { type: 'handle', source: 'main.js', description: 'Get web tools' },
  'module:add-web-tool': { type: 'handle', source: 'main.js', description: 'Add web tool' },
  'module:open-web-tool': { type: 'handle', source: 'main.js', description: 'Open web tool' },
  'module:delete-web-tool': { type: 'handle', source: 'main.js', description: 'Delete web tool' },

  // --- IDW store ---
  'idw-store:fetch-directory': { type: 'handle', source: 'main.js', description: 'Fetch IDW directory' },
  'idw-store:add-to-menu': { type: 'handle', source: 'main.js', description: 'Add IDW to menu' },

  // --- Deps ---
  'deps:check-all': { type: 'handle', source: 'main.js', description: 'Check all dependencies' },
  'deps:install': { type: 'handle', source: 'main.js', description: 'Install dependency' },
  'deps:install-all': { type: 'handle', source: 'main.js', description: 'Install all deps' },
  'deps:cancel-install': { type: 'handle', source: 'main.js', description: 'Cancel install' },
  'deps:get-aider-python': { type: 'handle', source: 'main.js', description: 'Get aider Python' },

  // --- Aider ---
  'aider:start': { type: 'handle', source: 'main.js', description: 'Start aider' },
  'aider:initialize': { type: 'handle', source: 'main.js', description: 'Initialize aider' },
  'aider:run-prompt': { type: 'handle', source: 'main.js', description: 'Run aider prompt' },
  'aider:run-prompt-streaming': { type: 'handle', source: 'main.js', description: 'Run prompt streaming' },
  'aider:add-files': { type: 'handle', source: 'main.js', description: 'Add files to aider' },
  'aider:remove-files': { type: 'handle', source: 'main.js', description: 'Remove aider files' },
  'aider:get-repo-map': { type: 'handle', source: 'main.js', description: 'Get repo map' },
  'aider:set-test-cmd': { type: 'handle', source: 'main.js', description: 'Set test command' },
  'aider:set-lint-cmd': { type: 'handle', source: 'main.js', description: 'Set lint command' },
  'aider:shutdown': { type: 'handle', source: 'main.js', description: 'Shutdown aider' },
  'aider:get-app-path': { type: 'handle', source: 'main.js', description: 'Get app path' },
  'aider:select-folder': { type: 'handle', source: 'main.js', description: 'Select folder' },
  'aider:create-space': { type: 'handle', source: 'main.js', description: 'Create space' },
  'aider:init-branch-manager': { type: 'handle', source: 'main.js', description: 'Init branch manager' },
  'aider:init-branch': { type: 'handle', source: 'main.js', description: 'Init branch' },
  'aider:branch-prompt': { type: 'handle', source: 'main.js', description: 'Branch prompt' },
  'aider:cleanup-branch': { type: 'handle', source: 'main.js', description: 'Cleanup branch' },
  'aider:cleanup-all-branches': { type: 'handle', source: 'main.js', description: 'Cleanup all branches' },
  'aider:get-branch-log': { type: 'handle', source: 'main.js', description: 'Get branch log' },
  'aider:get-orchestration-log': { type: 'handle', source: 'main.js', description: 'Get orchestration log' },
  'aider:get-active-branches': { type: 'handle', source: 'main.js', description: 'Get active branches' },
  'aider:get-api-config': { type: 'handle', source: 'main.js', description: 'Get API config' },
  'aider:evaluate': { type: 'handle', source: 'main.js', description: 'Evaluate aider' },
  'aider:run-playwright-tests': { type: 'handle', source: 'main.js', description: 'Run Playwright tests' },
  'aider:get-spaces': { type: 'handle', source: 'main.js', description: 'Get spaces' },
  'aider:get-space-metadata': { type: 'handle', source: 'main.js', description: 'Get space metadata' },
  'aider:update-space-metadata': { type: 'handle', source: 'main.js', description: 'Update space metadata' },
  'aider:set-file-metadata': { type: 'handle', source: 'main.js', description: 'Set file metadata' },
  'aider:get-file-metadata': { type: 'handle', source: 'main.js', description: 'Get file metadata' },
  'aider:set-asset-metadata': { type: 'handle', source: 'main.js', description: 'Set asset metadata' },
  'aider:set-approval': { type: 'handle', source: 'main.js', description: 'Set approval' },
  'aider:add-version': { type: 'handle', source: 'main.js', description: 'Add version' },
  'aider:update-project-config': { type: 'handle', source: 'main.js', description: 'Update project config' },
  'aider:migrate-spaces': { type: 'handle', source: 'main.js', description: 'Migrate spaces' },
  'aider:search-all-spaces': { type: 'handle', source: 'main.js', description: 'Search all spaces' },
  'aider:query-spaces': { type: 'handle', source: 'main.js', description: 'Query spaces' },
  'aider:get-all-spaces-with-metadata': {
    type: 'handle',
    source: 'main.js',
    description: 'Get all spaces with metadata',
  },
  'aider:get-space-files': { type: 'handle', source: 'main.js', description: 'Get space files' },
  'aider:get-space-path': { type: 'handle', source: 'main.js', description: 'Get space path' },
  'aider:list-project-files': { type: 'handle', source: 'main.js', description: 'List project files' },
  'aider:read-file': { type: 'handle', source: 'main.js', description: 'Read file' },
  'aider:write-file': { type: 'handle', source: 'main.js', description: 'Write file' },
  'aider:delete-file': { type: 'handle', source: 'main.js', description: 'Delete file' },
  'aider:backup-version': { type: 'handle', source: 'main.js', description: 'Backup version' },
  'aider:restore-version': { type: 'handle', source: 'main.js', description: 'Restore version' },
  'aider:list-backups': { type: 'handle', source: 'main.js', description: 'List backups' },
  'aider:create-branch': { type: 'handle', source: 'main.js', description: 'Create branch' },
  'aider:list-branches': { type: 'handle', source: 'main.js', description: 'List branches' },
  'aider:update-branch': { type: 'handle', source: 'main.js', description: 'Update branch' },
  'aider:promote-branch': { type: 'handle', source: 'main.js', description: 'Promote branch' },
  'aider:delete-branch': { type: 'handle', source: 'main.js', description: 'Delete branch' },
  'aider:git-create-branch': { type: 'handle', source: 'main.js', description: 'Git create branch' },
  'aider:git-create-orphan-branch': { type: 'handle', source: 'main.js', description: 'Git create orphan branch' },
  'aider:git-switch-branch': { type: 'handle', source: 'main.js', description: 'Git switch branch' },
  'aider:git-delete-branch': { type: 'handle', source: 'main.js', description: 'Git delete branch' },
  'aider:git-init': { type: 'handle', source: 'main.js', description: 'Git init' },
  'aider:git-list-branches': { type: 'handle', source: 'main.js', description: 'Git list branches' },
  'aider:git-diff-branches': { type: 'handle', source: 'main.js', description: 'Git diff branches' },
  'aider:git-merge-branch': { type: 'handle', source: 'main.js', description: 'Git merge branch' },
  'aider:git-merge-preview': { type: 'handle', source: 'main.js', description: 'Git merge preview' },
  'aider:open-file': { type: 'handle', source: 'main.js', description: 'Open file' },
  'aider:get-style-guides': { type: 'handle', source: 'main.js', description: 'Get style guides' },
  'aider:save-style-guide': { type: 'handle', source: 'main.js', description: 'Save style guide' },
  'aider:delete-style-guide': { type: 'handle', source: 'main.js', description: 'Delete style guide' },
  'aider:get-journey-maps': { type: 'handle', source: 'main.js', description: 'Get journey maps' },
  'aider:save-journey-map': { type: 'handle', source: 'main.js', description: 'Save journey map' },
  'aider:delete-journey-map': { type: 'handle', source: 'main.js', description: 'Delete journey map' },
  'aider:register-created-file': { type: 'handle', source: 'main.js', description: 'Register created file' },
  'aider:update-file-metadata': { type: 'handle', source: 'main.js', description: 'Update file metadata' },
  'aider:get-space-items': { type: 'handle', source: 'main.js', description: 'Get space items' },
  'aider:watch-file': { type: 'handle', source: 'main.js', description: 'Watch file' },
  'aider:unwatch-file': { type: 'handle', source: 'main.js', description: 'Unwatch file' },
  'aider:capture-preview-screenshot': { type: 'handle', source: 'main.js', description: 'Capture preview screenshot' },
  'aider:analyze-screenshot': { type: 'handle', source: 'main.js', description: 'Analyze screenshot' },
  'aider:web-search': { type: 'handle', source: 'main.js', description: 'Web search' },

  // --- Dialog ---
  'dialog:open-file': { type: 'handle', source: 'main.js', description: 'Open file dialog' },
  'dialog:save-file': { type: 'handle', source: 'main.js', description: 'Save file dialog' },

  // --- Design ---
  'design:generate-choices': { type: 'handle', source: 'main.js', description: 'Generate design choices' },
  'design:regenerate-single': { type: 'handle', source: 'main.js', description: 'Regenerate single design' },
  'design:extract-tokens': { type: 'handle', source: 'main.js', description: 'Extract design tokens' },
  'design:generate-code': { type: 'handle', source: 'main.js', description: 'Generate design code' },
  'design:get-approaches': { type: 'handle', source: 'main.js', description: 'Get design approaches' },

  // --- TXDB ---
  'txdb:get-summary': { type: 'handle', source: 'main.js', description: 'Get TXDB summary' },
  'txdb:record-transaction': { type: 'handle', source: 'main.js', description: 'Record transaction' },
  'txdb:get-transactions': { type: 'handle', source: 'main.js', description: 'Get transactions' },
  'txdb:log-event': { type: 'handle', source: 'main.js', description: 'Log event' },
  'txdb:get-event-logs': { type: 'handle', source: 'main.js', description: 'Get event logs' },

  // --- EventDB ---
  'eventdb:cost-by-model': { type: 'handle', source: 'main.js', description: 'Cost by model' },
  'eventdb:daily-costs': { type: 'handle', source: 'main.js', description: 'Daily costs' },
  'eventdb:query-spaces': { type: 'handle', source: 'main.js', description: 'Query spaces' },
  'eventdb:search-spaces': { type: 'handle', source: 'main.js', description: 'Search spaces' },
  'eventdb:query': { type: 'handle', source: 'main.js', description: 'EventDB query' },

  // --- Video ---
  'save-video-project': { type: 'handle', source: 'main.js', description: 'Save video project' },
  'load-video-project': { type: 'handle', source: 'main.js', description: 'Load video project' },
  'delete-video-project': { type: 'handle', source: 'main.js', description: 'Delete video project' },

  // --- Settings ---
  'settings:get-all': { type: 'handle', source: 'main.js', description: 'Get all settings' },
  'settings:save': { type: 'handle', source: 'main.js', description: 'Save settings' },
  'settings:test-llm': { type: 'handle', source: 'main.js', description: 'Test LLM connection' },

  // --- Release ---
  'release:authenticate-youtube': { type: 'handle', source: 'main.js', description: 'Auth YouTube' },
  'release:authenticate-vimeo': { type: 'handle', source: 'main.js', description: 'Auth Vimeo' },
  'release:get-youtube-status': { type: 'handle', source: 'main.js', description: 'Get YouTube status' },
  'release:get-vimeo-status': { type: 'handle', source: 'main.js', description: 'Get Vimeo status' },

  // --- GSX ---
  'gsx:sync-all': { type: 'handle', source: 'main.js', description: 'Sync all GSX' },
  'gsx:test-connection': { type: 'handle', source: 'main.js', description: 'Test GSX connection' },
  'gsx:get-connections': { type: 'handle', source: 'main.js', description: 'Get GSX connections' },
  'gsx:add-connection': { type: 'handle', source: 'main.js', description: 'Add GSX connection' },
  'gsx:update-connection': { type: 'handle', source: 'main.js', description: 'Update connection' },
  'gsx:delete-connection': { type: 'handle', source: 'main.js', description: 'Delete connection' },

  // --- Smart export ---
  'get-smart-export-data': { type: 'handle', source: 'main.js', description: 'Get smart export data' },
  'generate-smart-export': { type: 'handle', source: 'main.js', description: 'Generate smart export' },
  'generate-basic-export': { type: 'handle', source: 'main.js', description: 'Generate basic export' },
  'save-smart-export-html': { type: 'handle', source: 'main.js', description: 'Save export HTML' },
  'save-smart-export-pdf': { type: 'handle', source: 'main.js', description: 'Save export PDF' },
  'get-export-templates': { type: 'handle', source: 'main.js', description: 'Get export templates' },
  'get-export-template': { type: 'handle', source: 'main.js', description: 'Get export template' },
  'save-export-template': { type: 'handle', source: 'main.js', description: 'Save export template' },
  'smart-export:get-formats': { type: 'handle', source: 'main.js', description: 'Get export formats' },
  'smart-export:generate': { type: 'handle', source: 'main.js', description: 'Generate smart export' },
  'smart-export:open-modal': { type: 'handle', source: 'main.js', description: 'Open export modal' },
  'smart-export:close-modal': { type: 'on', source: 'main.js', description: 'Close export modal' },

  // --- Style guide ---
  'analyze-website-styles': { type: 'handle', source: 'main.js', description: 'Analyze website styles' },
  'get-style-guides': { type: 'handle', source: 'main.js', description: 'Get style guides' },
  'save-style-guide': { type: 'handle', source: 'main.js', description: 'Save style guide' },
  'delete-style-guide': { type: 'handle', source: 'main.js', description: 'Delete style guide' },

  // --- Desktop ---
  'get-desktop-sources': { type: 'handle', source: 'main.js', description: 'Get desktop sources' },

  // --- Misc handles ---
  'save-to-space': { type: 'handle', source: 'main.js', description: 'Save content to space' },
  'get-spaces': { type: 'handle', source: 'main.js', description: 'Get spaces' },
  'clipboard:get-space-audio': { type: 'handle', source: 'main.js', description: 'Get space audio' },
  'clipboard:get-space-videos': { type: 'handle', source: 'main.js', description: 'Get space videos' },
  'clipboard:get-item-path': { type: 'handle', source: 'main.js', description: 'Get item path' },
  'clipboard:write-text': { type: 'handle', source: 'main.js', description: 'Write clipboard text' },
  'get-clipboard-data': { type: 'handle', source: 'main.js', description: 'Get clipboard data' },
  'get-clipboard-files': { type: 'handle', source: 'main.js', description: 'Get clipboard files' },

  // --- Recorder ---
  'recorder:open': { type: 'handle', source: 'main.js', description: 'Open recorder' },

  // --- Black hole (main.js) ---
  'black-hole:get-pending-data': { type: 'handle', source: 'main.js', description: 'Get pending black hole data' },
  'black-hole:create-space': { type: 'handle', source: 'main.js', description: 'Create black hole space' },

  // --- Orb ---
  'orb:show': { type: 'handle', source: 'main.js', description: 'Show orb' },
  'orb:hide': { type: 'handle', source: 'main.js', description: 'Hide orb' },
  'orb:toggle': { type: 'handle', source: 'main.js', description: 'Toggle orb' },
  'orb:position': { type: 'handle', source: 'main.js', description: 'Set orb position' },
  'orb:flip-side': { type: 'handle', source: 'main.js', description: 'Flip orb side' },
  'orb:get-display': { type: 'handle', source: 'main.js', description: 'Get orb display' },
  'orb:relay-to-composer': { type: 'handle', source: 'main.js', description: 'Relay to composer' },
  'orb:is-composer-active': { type: 'handle', source: 'main.js', description: 'Check composer active' },
  'orb:expand-for-chat': { type: 'handle', source: 'main.js', description: 'Expand orb for chat' },
  'orb:collapse-from-chat': { type: 'handle', source: 'main.js', description: 'Collapse orb from chat' },
  'orb:set-click-through': { type: 'handle', source: 'main.js', description: 'Set orb click through' },
  'orb-control:hide': { type: 'handle', source: 'main.js', description: 'Hide orb control' },
  'orb-control:show': { type: 'handle', source: 'main.js', description: 'Show orb control' },
  'orb-control:toggle': { type: 'handle', source: 'main.js', description: 'Toggle orb control' },
  'orb-control:is-visible': { type: 'handle', source: 'main.js', description: 'Check orb control visible' },
  'orb-control:get-status': { type: 'handle', source: 'main.js', description: 'Get orb control status' },

  // --- Command HUD ---
  'command-hud:show': { type: 'handle', source: 'main.js', description: 'Show command HUD' },
  'command-hud:hide': { type: 'handle', source: 'main.js', description: 'Hide command HUD' },
  'command-hud:task': { type: 'handle', source: 'main.js', description: 'Command HUD task' },
  'command-hud:result': { type: 'handle', source: 'main.js', description: 'Command HUD result' },
  'command-hud:resize': { type: 'handle', source: 'main.js', description: 'Resize command HUD' },

  // --- HUD ---
  'hud:position': { type: 'handle', source: 'main.js', description: 'Set HUD position' },
  'hud:trigger-agent': { type: 'handle', source: 'main.js', description: 'Trigger HUD agent' },

  // --- Voice ---
  'voice:speak': { type: 'handle', source: 'main.js', description: 'Speak text' },
  'voice:stop': { type: 'handle', source: 'main.js', description: 'Stop speech' },
  'voice:is-available': { type: 'handle', source: 'main.js', description: 'Check voice available' },
  'voice:list-voices': { type: 'handle', source: 'main.js', description: 'List voices' },

  // --- Agents ---
  'agents:get-local': { type: 'handle', source: 'main.js', description: 'Get local agents' },
  'agents:list': { type: 'handle', source: 'main.js', description: 'List agents' },
  'agents:create': { type: 'handle', source: 'main.js', description: 'Create agent' },
  'agents:update': { type: 'handle', source: 'main.js', description: 'Update agent' },
  'agents:delete': { type: 'handle', source: 'main.js', description: 'Delete agent' },
  'agents:get-versions': { type: 'handle', source: 'main.js', description: 'Get agent versions' },
  'agents:get-version': { type: 'handle', source: 'main.js', description: 'Get agent version' },
  'agents:undo': { type: 'handle', source: 'main.js', description: 'Undo agent change' },
  'agents:revert': { type: 'handle', source: 'main.js', description: 'Revert agent' },
  'agents:compare-versions': { type: 'handle', source: 'main.js', description: 'Compare versions' },
  'agents:get-builtin-list': { type: 'handle', source: 'main.js', description: 'Get builtin agents' },
  'agents:get-builtin-states': { type: 'handle', source: 'main.js', description: 'Get builtin states' },
  'agents:set-builtin-enabled': { type: 'handle', source: 'main.js', description: 'Set builtin enabled' },
  'agents:test-phrase': { type: 'handle', source: 'main.js', description: 'Test agent phrase' },
  'agents:test-phrase-all': { type: 'handle', source: 'main.js', description: 'Test phrase all agents' },
  'agents:execute-direct': { type: 'handle', source: 'main.js', description: 'Execute agent direct' },
  'agents:get-api-key': { type: 'handle', source: 'main.js', description: 'Get API key' },
  'agents:get-version-history': { type: 'handle', source: 'main.js', description: 'Get version history' },
  'agents:revert-to-version': { type: 'handle', source: 'main.js', description: 'Revert to version' },
  'agents:enhance': { type: 'handle', source: 'main.js', description: 'Enhance agent' },
  'agents:get-stats': { type: 'handle', source: 'main.js', description: 'Get agent stats' },
  'agents:get-all-stats': { type: 'handle', source: 'main.js', description: 'Get all stats' },
  'agents:get-bid-history': { type: 'handle', source: 'main.js', description: 'Get bid history' },
  'agents:get-agent-bid-history': { type: 'handle', source: 'main.js', description: 'Get agent bid history' },

  // --- Claude terminal ---
  'claude-terminal:start': { type: 'handle', source: 'main.js', description: 'Start Claude terminal' },
  'claude-terminal:write': { type: 'on', source: 'main.js', description: 'Write to terminal' },
  'claude-terminal:resize': { type: 'on', source: 'main.js', description: 'Resize terminal' },
  'claude-terminal:kill': { type: 'on', source: 'main.js', description: 'Kill terminal' },

  // --- Claude code ---
  'claude-code:templates': { type: 'handle', source: 'main.js', description: 'Get Claude code templates' },
  'claude-code:template': { type: 'handle', source: 'main.js', description: 'Get template' },
  'claude-code:agent-types': { type: 'handle', source: 'main.js', description: 'Get agent types' },
  'claude-code:generate-agent': { type: 'handle', source: 'main.js', description: 'Generate agent' },
  'claude-code:test-agent': { type: 'handle', source: 'main.js', description: 'Test agent' },
  'claude-code:check-auth': { type: 'handle', source: 'main.js', description: 'Check auth' },
  'claude-code:login': { type: 'handle', source: 'main.js', description: 'Login' },
  'claude-code:available': { type: 'handle', source: 'main.js', description: 'Check available' },
  'claude-code:run': { type: 'handle', source: 'main.js', description: 'Run Claude code' },
  'claude-code:cancel': { type: 'handle', source: 'main.js', description: 'Cancel run' },
  'claude-code:browse-directory': { type: 'handle', source: 'main.js', description: 'Browse directory' },

  // --- Agent composer ---
  'agent-composer:score-templates': { type: 'handle', source: 'main.js', description: 'Score templates' },
  'agent-composer:voices': { type: 'handle', source: 'main.js', description: 'Get voices' },
  'agent-composer:plan': { type: 'handle', source: 'main.js', description: 'Plan agent' },
  'agent-composer:broadcast-plan': { type: 'handle', source: 'main.js', description: 'Broadcast plan' },
  'agent-composer:creation-complete': { type: 'handle', source: 'main.js', description: 'Creation complete' },

  // --- GSX Create ---
  'gsx-create:chat': { type: 'handle', source: 'main.js', description: 'GSX Create chat' },
  'gsx-create:save-agent': { type: 'handle', source: 'main.js', description: 'Save agent' },
  'gsx-create:generate-scenarios': { type: 'handle', source: 'main.js', description: 'Generate scenarios' },
  'gsx-create:test-suite': { type: 'handle', source: 'main.js', description: 'Test suite' },
  'gsx-create:auto-test': { type: 'handle', source: 'main.js', description: 'Auto test' },
  'gsx-create:quick-test': { type: 'handle', source: 'main.js', description: 'Quick test' },

  // --- Intro wizard ---
  'intro-wizard:get-init-data': { type: 'handle', source: 'main.js', description: 'Get wizard init data' },
  'intro-wizard:mark-seen': { type: 'handle', source: 'main.js', description: 'Mark wizard seen' },
  'intro-wizard:close': { type: 'handle', source: 'main.js', description: 'Close wizard' },

  // --- Dashboard ---
  'dashboard:open-log-folder': { type: 'handle', source: 'main.js', description: 'Open log folder' },
  'dashboard:resolve-issue': { type: 'handle', source: 'main.js', description: 'Resolve issue' },
  'dashboard:ignore-issue': { type: 'handle', source: 'main.js', description: 'Ignore issue' },

  // --- Test agent ---
  'test-agent:generate-plan': { type: 'handle', source: 'main.js', description: 'Generate test plan' },
  'test-agent:run-tests': { type: 'handle', source: 'main.js', description: 'Run tests' },
  'test-agent:accessibility': { type: 'handle', source: 'main.js', description: 'Accessibility test' },
  'test-agent:performance': { type: 'handle', source: 'main.js', description: 'Performance test' },
  'test-agent:visual': { type: 'handle', source: 'main.js', description: 'Visual test' },
  'test-agent:interactive': { type: 'handle', source: 'main.js', description: 'Interactive test' },
  'test-agent:update-context': { type: 'handle', source: 'main.js', description: 'Update test context' },
  'test-agent:cross-browser': { type: 'handle', source: 'main.js', description: 'Cross browser test' },
  'test-agent:set-tracing': { type: 'handle', source: 'main.js', description: 'Set tracing' },
  'test-agent:close': { type: 'handle', source: 'main.js', description: 'Close test agent' },

  // --- Budget ---
  'budget:getCostSummary': { type: 'handle', source: 'main.js', description: 'Get cost summary' },
  'budget:getAllBudgetLimits': { type: 'handle', source: 'main.js', description: 'Get budget limits' },
  'budget:setBudgetLimit': { type: 'handle', source: 'main.js', description: 'Set budget limit' },
  'budget:getUsageHistory': { type: 'handle', source: 'main.js', description: 'Get usage history' },
  'budget:getProjectCosts': { type: 'handle', source: 'main.js', description: 'Get project costs' },
  'budget:getAllProjects': { type: 'handle', source: 'main.js', description: 'Get all projects' },
  'budget:clearUsageHistory': { type: 'handle', source: 'main.js', description: 'Clear usage history' },
  'budget:exportData': { type: 'handle', source: 'main.js', description: 'Export budget data' },
  'budget:estimateCost': { type: 'handle', source: 'main.js', description: 'Estimate cost' },
  'budget:checkBudget': { type: 'handle', source: 'main.js', description: 'Check budget' },
  'budget:trackUsage': { type: 'handle', source: 'main.js', description: 'Track usage' },
  'budget:registerProject': { type: 'handle', source: 'main.js', description: 'Register project' },
  'budget:getPricing': { type: 'handle', source: 'main.js', description: 'Get pricing' },
  'budget:updatePricing': { type: 'handle', source: 'main.js', description: 'Update pricing' },
  'budget:resetToDefaults': { type: 'handle', source: 'main.js', description: 'Reset to defaults' },
  'budget:importData': { type: 'handle', source: 'main.js', description: 'Import data' },
  'budget:isBudgetConfigured': { type: 'handle', source: 'main.js', description: 'Check budget configured' },
  'budget:markBudgetConfigured': { type: 'handle', source: 'main.js', description: 'Mark configured' },
  'budget:getEstimates': { type: 'handle', source: 'main.js', description: 'Get estimates' },
  'budget:saveEstimates': { type: 'handle', source: 'main.js', description: 'Save estimates' },
  'budget:updateEstimate': { type: 'handle', source: 'main.js', description: 'Update estimate' },
  'budget:getTotalEstimated': { type: 'handle', source: 'main.js', description: 'Get total estimated' },
  'budget:getEstimateCategories': { type: 'handle', source: 'main.js', description: 'Get estimate categories' },
  'budget:createBackup': { type: 'handle', source: 'main.js', description: 'Create backup' },
  'budget:listBackups': { type: 'handle', source: 'main.js', description: 'List backups' },
  'budget:restoreFromBackup': { type: 'handle', source: 'main.js', description: 'Restore from backup' },
  'budget:getStatus': { type: 'handle', source: 'main.js', description: 'Get budget status' },
  'budget:answerQuestion': { type: 'handle', source: 'main.js', description: 'Answer budget question' },
  'budget:getStatsByFeature': { type: 'handle', source: 'main.js', description: 'Stats by feature' },
  'budget:getStatsByProvider': { type: 'handle', source: 'main.js', description: 'Stats by provider' },
  'budget:getStatsByModel': { type: 'handle', source: 'main.js', description: 'Stats by model' },
  'budget:getDailyCosts': { type: 'handle', source: 'main.js', description: 'Get daily costs' },
  'budget:setHardLimitEnabled': { type: 'handle', source: 'main.js', description: 'Set hard limit' },
  'budget:setProjectBudget': { type: 'handle', source: 'main.js', description: 'Set project budget' },

  // --- Pricing ---
  'pricing:getAll': { type: 'handle', source: 'main.js', description: 'Get all pricing' },
  'pricing:calculate': { type: 'handle', source: 'main.js', description: 'Calculate price' },

  // --- Misc on handlers ---
  'refresh-menu': { type: 'on', source: 'main.js', description: 'Refresh menu' },
  'orb:clicked': { type: 'on', source: 'main.js', description: 'Orb clicked' },
  'orb-control:heartbeat': { type: 'on', source: 'main.js', description: 'Orb control heartbeat' },
  'hud:dismiss': { type: 'on', source: 'main.js', description: 'HUD dismiss' },
  'hud:retry': { type: 'on', source: 'main.js', description: 'HUD retry' },
  'hud:show-context-menu': { type: 'on', source: 'main.js', description: 'HUD show context menu' },
  'agent-manager:close': { type: 'on', source: 'main.js', description: 'Agent manager close' },
  'agents:open-manager': { type: 'on', source: 'main.js', description: 'Open agent manager' },
  'claude-code:close': { type: 'on', source: 'main.js', description: 'Claude code close' },
  'trigger-mission-control': { type: 'on', source: 'main.js', description: 'Trigger mission control' },
  'clear-cache-and-reload': { type: 'on', source: 'main.js', description: 'Clear cache and reload' },
  'window:ping': { type: 'on', source: 'main.js', description: 'Window ping' },
  'idw-environments-response': { type: 'on', source: 'main.js', description: 'IDW environments response' },
  'user-action': { type: 'on', source: 'main.js', description: 'User action' },
  'open-setup-wizard': { type: 'on', source: 'main.js', description: 'Open setup wizard' },
  'close-wizard': { type: 'on', source: 'main.js', description: 'Close wizard' },
  'open-settings': { type: 'on', source: 'main.js', description: 'Open settings' },
  'show-notification': { type: 'on', source: 'main.js', description: 'Show notification' },
  'show-context-menu': { type: 'on', source: 'main.js', description: 'Show context menu' },
  'open-recorder': { type: 'on', source: 'main.js', description: 'Open recorder' },
  'open-clipboard-viewer': { type: 'on', source: 'main.js', description: 'Open clipboard viewer' },
  'open-external-url': { type: 'on', source: 'main.js', description: 'Open external URL' },
  'open-black-hole-widget': { type: 'on', source: 'main.js', description: 'Open black hole widget' },
  'close-black-hole-widget': { type: 'on', source: 'main.js', description: 'Close black hole widget' },
  'show-black-hole': { type: 'on', source: 'main.js', description: 'Show black hole' },
  'paste-to-black-hole': { type: 'on', source: 'main.js', description: 'Paste to black hole' },
  'black-hole:trigger-paste': { type: 'on', source: 'main.js', description: 'Black hole trigger paste' },
  'get-clipboard-text': { type: 'on', source: 'main.js', description: 'Get clipboard text' },
  'close-content-window': { type: 'on', source: 'main.js', description: 'Close content window' },
  'tab-action': { type: 'on', source: 'main.js', description: 'Tab action' },
  'setup-webcontents-handlers': { type: 'on', source: 'main.js', description: 'Setup webcontents handlers' },
  'get-idw-entries': { type: 'on', source: 'main.js', description: 'Get IDW entries' },
  'get-external-bots': { type: 'on', source: 'main.js', description: 'Get external bots' },
  'get-image-creators': { type: 'on', source: 'main.js', description: 'Get image creators' },
  'get-video-creators': { type: 'on', source: 'main.js', description: 'Get video creators' },
  'get-audio-generators': { type: 'on', source: 'main.js', description: 'Get audio generators' },
  'open-gsx-link': { type: 'on', source: 'main.js', description: 'Open GSX link' },
  'update-action': { type: 'on', source: 'main.js', description: 'Update action' },
  'save-gsx-links': { type: 'on', source: 'main.js', description: 'Save GSX links' },
  'save-reading-log': { type: 'on', source: 'main.js', description: 'Save reading log' },
  'save-reading-log-sync': { type: 'on', source: 'main.js', description: 'Save reading log sync' },
  'save-user-preferences': { type: 'on', source: 'main.js', description: 'Save user preferences' },
  'save-external-bots': { type: 'on', source: 'main.js', description: 'Save external bots' },
  'save-image-creators': { type: 'on', source: 'main.js', description: 'Save image creators' },
  'save-video-creators': { type: 'on', source: 'main.js', description: 'Save video creators' },
  'save-audio-generators': { type: 'on', source: 'main.js', description: 'Save audio generators' },
  'save-ui-design-tools': { type: 'on', source: 'main.js', description: 'Save UI design tools' },
  'save-idw-entries': { type: 'on', source: 'main.js', description: 'Save IDW entries' },
  'save-idw-environments': { type: 'on', source: 'main.js', description: 'Save IDW environments' },
  'menu-action': { type: 'on', source: 'main.js', description: 'Menu action' },
  'wipe-all-partitions': { type: 'on', source: 'main.js', description: 'Wipe all partitions' },
  'get-ui-design-tools': { type: 'on', source: 'main.js', description: 'Get UI design tools' },
  'test-idw-load': { type: 'on', source: 'main.js', description: 'Test IDW load' },
  'open-budget-setup': { type: 'on', source: 'main.js', description: 'Open budget setup' },
  'open-budget-dashboard': { type: 'on', source: 'main.js', description: 'Open budget dashboard' },
  'open-budget-estimator': { type: 'on', source: 'main.js', description: 'Open budget estimator' },
  'black-hole:debug': { type: 'on', source: 'main.js', description: 'Black hole debug' },
  'black-hole:active': { type: 'on', source: 'main.js', description: 'Black hole active' },
  'black-hole:inactive': { type: 'on', source: 'main.js', description: 'Black hole inactive' },

  // --- Misc handles (no namespace) ---
  'fetch-user-lessons': { type: 'handle', source: 'main.js', description: 'Fetch user lessons' },
  'update-lesson-progress': { type: 'handle', source: 'main.js', description: 'Update lesson progress' },
  'log-lesson-click': { type: 'handle', source: 'main.js', description: 'Log lesson click' },
  'get-current-user': { type: 'handle', source: 'main.js', description: 'Get current user' },
  'load-reading-log': { type: 'handle', source: 'main.js', description: 'Load reading log' },
  'article:save-tts': { type: 'handle', source: 'main.js', description: 'Save article TTS' },
  'article:get-tts': { type: 'handle', source: 'main.js', description: 'Get article TTS' },
  'cache:save': { type: 'handle', source: 'main.js', description: 'Save cache' },
  'cache:load': { type: 'handle', source: 'main.js', description: 'Load cache' },
  'fetch-rss': { type: 'handle', source: 'main.js', description: 'Fetch RSS' },
  'open-external': { type: 'handle', source: 'main.js', description: 'Open external URL' },
  'debug-save-content': { type: 'handle', source: 'main.js', description: 'Debug save content' },
  'fetch-article': { type: 'handle', source: 'main.js', description: 'Fetch article' },
  'wizard:save-idw-environments': { type: 'handle', source: 'main.js', description: 'Save IDW environments' },
  'update-reading-times': { type: 'handle', source: 'main.js', description: 'Update reading times' },
  'rollback:get-backups': { type: 'handle', source: 'main.js', description: 'Get rollback backups' },
  'rollback:open-folder': { type: 'handle', source: 'main.js', description: 'Open rollback folder' },
  'rollback:create-restore-script': { type: 'handle', source: 'main.js', description: 'Create restore script' },
  'get-memory-info': { type: 'handle', source: 'main.js', description: 'Get memory info' },
  'save-settings': { type: 'handle', source: 'main.js', description: 'Save settings' },
  'get-settings': { type: 'handle', source: 'main.js', description: 'Get settings' },
  'save-test-results': { type: 'handle', source: 'main.js', description: 'Save test results' },
  'export-test-report': { type: 'handle', source: 'main.js', description: 'Export test report' },
  'get-test-history': { type: 'handle', source: 'main.js', description: 'Get test history' },
  'add-test-history': { type: 'handle', source: 'main.js', description: 'Add test history' },
  'get-manual-test-notes': { type: 'handle', source: 'main.js', description: 'Get manual test notes' },
  'save-manual-test-notes': { type: 'handle', source: 'main.js', description: 'Save manual test notes' },
  'get-manual-test-statuses': { type: 'handle', source: 'main.js', description: 'Get manual test statuses' },
  'save-manual-test-status': { type: 'handle', source: 'main.js', description: 'Save manual test status' },
  'get-app-version': { type: 'handle', source: 'main.js', description: 'Get app version' },
  'get-os-info': { type: 'handle', source: 'main.js', description: 'Get OS info' },
  'check-widget-ready': { type: 'handle', source: 'main.js', description: 'Check widget ready' },
  'test-claude-connection': { type: 'handle', source: 'main.js', description: 'Test Claude connection' },
  'test-openai-connection': { type: 'handle', source: 'main.js', description: 'Test OpenAI connection' },
  'encrypt-data': { type: 'handle', source: 'main.js', description: 'Encrypt data' },
  'decrypt-data': { type: 'handle', source: 'main.js', description: 'Decrypt data' },
  'check-for-updates': { type: 'handle', source: 'main.js', description: 'Check for updates' },
  'get-rollback-versions': { type: 'handle', source: 'main.js', description: 'Get rollback versions' },
  'save-test-progress': { type: 'handle', source: 'main.js', description: 'Save test progress' },
  'load-test-progress': { type: 'handle', source: 'main.js', description: 'Load test progress' },
  'save-finalized-report': { type: 'handle', source: 'main.js', description: 'Save finalized report' },
  'save-test-history': { type: 'handle', source: 'main.js', description: 'Save test history' },

  // --- Black hole (clipboard-manager-v2-adapter.js) ---
  'black-hole:resize-window': {
    type: 'on',
    source: 'clipboard-manager-v2-adapter.js',
    description: 'Resize black hole window',
  },
  'black-hole:move-window': {
    type: 'on',
    source: 'clipboard-manager-v2-adapter.js',
    description: 'Move black hole window',
  },
  'black-hole:get-position': {
    type: 'on',
    source: 'clipboard-manager-v2-adapter.js',
    description: 'Get black hole position',
  },
  'black-hole:restore-position': {
    type: 'on',
    source: 'clipboard-manager-v2-adapter.js',
    description: 'Restore black hole position',
  },
  'black-hole:toggle-always-on-top': {
    type: 'on',
    source: 'clipboard-manager-v2-adapter.js',
    description: 'Toggle always on top',
  },
  'black-hole:add-text': {
    type: 'handle',
    source: 'clipboard-manager-v2-adapter.js',
    description: 'Add text to black hole',
  },
  'black-hole:add-html': {
    type: 'handle',
    source: 'clipboard-manager-v2-adapter.js',
    description: 'Add HTML to black hole',
  },
  'black-hole:add-image': {
    type: 'handle',
    source: 'clipboard-manager-v2-adapter.js',
    description: 'Add image to black hole',
  },
  'black-hole:add-file': {
    type: 'handle',
    source: 'clipboard-manager-v2-adapter.js',
    description: 'Add file to black hole',
  },

  // --- Float card ---
  'float-card:close': { type: 'on', source: 'clipboard-manager-v2-adapter.js', description: 'Close float card' },
  'float-card:ready': { type: 'on', source: 'clipboard-manager-v2-adapter.js', description: 'Float card ready' },
  'float-card:start-drag': {
    type: 'on',
    source: 'clipboard-manager-v2-adapter.js',
    description: 'Start float card drag',
  },

  // --- YouTube ---
  'youtube:is-youtube-url': {
    type: 'handle',
    source: 'clipboard-manager-v2-adapter.js',
    description: 'Check if YouTube URL',
  },
  'youtube:extract-video-id': {
    type: 'handle',
    source: 'clipboard-manager-v2-adapter.js',
    description: 'Extract video ID',
  },
  'youtube:get-info': { type: 'handle', source: 'clipboard-manager-v2-adapter.js', description: 'Get YouTube info' },
  'youtube:download-to-space': {
    type: 'handle',
    source: 'clipboard-manager-v2-adapter.js',
    description: 'Download to space',
  },
  'youtube:start-background-download': {
    type: 'handle',
    source: 'clipboard-manager-v2-adapter.js',
    description: 'Start background download',
  },
  'youtube:download': { type: 'handle', source: 'clipboard-manager-v2-adapter.js', description: 'Download YouTube' },
  'youtube:cancel-download': {
    type: 'handle',
    source: 'clipboard-manager-v2-adapter.js',
    description: 'Cancel download',
  },
  'youtube:get-active-downloads': {
    type: 'handle',
    source: 'clipboard-manager-v2-adapter.js',
    description: 'Get active downloads',
  },
  'youtube:get-transcript': {
    type: 'handle',
    source: 'clipboard-manager-v2-adapter.js',
    description: 'Get transcript',
  },
  'youtube:fetch-transcript-for-item': {
    type: 'handle',
    source: 'clipboard-manager-v2-adapter.js',
    description: 'Fetch transcript for item',
  },
  'youtube:get-transcript-whisper': {
    type: 'handle',
    source: 'clipboard-manager-v2-adapter.js',
    description: 'Get transcript via Whisper',
  },
  'youtube:process-speaker-recognition': {
    type: 'handle',
    source: 'clipboard-manager-v2-adapter.js',
    description: 'Process speaker recognition',
  },
};

/**
 * Group channels by namespace prefix (everything before the first colon).
 * @returns {Record<string, string[]>} Map of namespace -> channel names
 */
function getChannelsByNamespace() {
  const byNs = {};
  for (const channel of Object.keys(IPC_CHANNELS)) {
    const ns = channel.includes(':') ? channel.split(':')[0] : '(no namespace)';
    if (!byNs[ns]) byNs[ns] = [];
    byNs[ns].push(channel);
  }
  for (const ns of Object.keys(byNs)) {
    byNs[ns].sort();
  }
  return byNs;
}

/**
 * Validate that a channel exists in the registry.
 * @param {string} channel - Channel name to check
 * @returns {boolean}
 */
function isRegisteredChannel(channel) {
  return Object.prototype.hasOwnProperty.call(IPC_CHANNELS, channel);
}

/**
 * Get all channel names.
 * @returns {string[]}
 */
function getAllChannels() {
  return Object.keys(IPC_CHANNELS);
}

module.exports = {
  IPC_CHANNELS,
  getChannelsByNamespace,
  isRegisteredChannel,
  getAllChannels,
};
