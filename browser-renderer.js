// Tab management for the browser
let tabs = [];
let activeTabId = null;
let tabCounter = 0;
let openChatLinksInNewTab = false; // Preference for chat link behavior

// Initialize when the document is loaded
document.addEventListener('DOMContentLoaded', () => {
    // Load preferences
    const savedPreference = localStorage.getItem('openChatLinksInNewTab');
    if (savedPreference !== null) {
        openChatLinksInNewTab = savedPreference === 'true';
        console.log('Loaded chat link preference:', openChatLinksInNewTab);
    }
    
    // Initialize UI elements
    const newTabButton = document.getElementById('new-tab-button');
    const backButton = document.getElementById('back-button');
    const forwardButton = document.getElementById('forward-button');
    const refreshButton = document.getElementById('refresh-button');
    const loadingIndicator = document.getElementById('loading-indicator');
    
    // Set up event listeners
    newTabButton.addEventListener('click', () => {
        console.log('Plus button clicked, requesting IDW environments');
        
        // Check if a menu already exists and remove it
        const existingMenu = document.querySelector('.idw-menu');
        if (existingMenu) {
            console.log('Removing existing menu');
            existingMenu.remove();
            // Also remove overlay if it exists
            const existingOverlay = document.querySelector('.idw-menu-overlay');
            if (existingOverlay) existingOverlay.remove();
            return; // Just close the menu if it's already open
        }
        
        // Create a transparent overlay to capture clicks
        const overlay = document.createElement('div');
        overlay.className = 'idw-menu-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: 999;
            background: transparent;
        `;
        
        // Create a menu element
        const menu = document.createElement('div');
        menu.className = 'idw-menu';
        
        // Get the position of the plus button
        const buttonRect = newTabButton.getBoundingClientRect();
        
        menu.style.cssText = `
            position: absolute;
            top: ${buttonRect.bottom + 5}px;
            left: ${buttonRect.left}px;
            background: #2a2a2a;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            z-index: 1000;
            min-width: 200px;
            max-width: 300px;
            max-height: 400px;
            overflow-y: auto;
        `;

        let environments = [];
        
        // Get currently open tab URLs for filtering
        const getOpenTabUrls = () => {
            const openUrls = new Set();
            const urlDetails = [];
            
            tabs.forEach(tab => {
                if (tab.webview && tab.webview.src) {
                    try {
                        // Store the full URL for exact matching
                        openUrls.add(tab.webview.src);
                        
                        // If tab has a stored current URL (from navigation), add that too
                        if (tab.currentUrl && tab.currentUrl !== tab.webview.src) {
                            openUrls.add(tab.currentUrl);
                            console.log(`Tab ${tab.id} has different currentUrl: ${tab.currentUrl} vs src: ${tab.webview.src}`);
                            
                            // Also process currentUrl for variations
                            try {
                                const currentTabUrl = new URL(tab.currentUrl);
                                
                                // Add variations for currentUrl
                                const currentUrlWithoutFragment = currentTabUrl.origin + currentTabUrl.pathname + currentTabUrl.search;
                                openUrls.add(currentUrlWithoutFragment);
                                
                                const currentUrlWithoutQuery = currentTabUrl.origin + currentTabUrl.pathname;
                                openUrls.add(currentUrlWithoutQuery);
                                
                                if (currentTabUrl.pathname.endsWith('/')) {
                                    openUrls.add(currentTabUrl.origin + currentTabUrl.pathname.slice(0, -1) + currentTabUrl.search);
                                    openUrls.add(currentTabUrl.origin + currentTabUrl.pathname.slice(0, -1));
                                }
                                
                                openUrls.add(currentTabUrl.origin);
                                openUrls.add(currentTabUrl.origin + '/');
                            } catch (e) {
                                console.error('Error processing currentUrl:', e);
                            }
                        }
                        
                        // Also normalize for comparison
                        const tabUrl = new URL(tab.webview.src);
                        
                        // Store different variations for matching
                        // 1. Full URL without fragment
                        const urlWithoutFragment = tabUrl.origin + tabUrl.pathname + tabUrl.search;
                        openUrls.add(urlWithoutFragment);
                        
                        // 2. URL without query params
                        const urlWithoutQuery = tabUrl.origin + tabUrl.pathname;
                        openUrls.add(urlWithoutQuery);
                        
                        // 3. URL without trailing slash
                        if (tabUrl.pathname.endsWith('/')) {
                            openUrls.add(tabUrl.origin + tabUrl.pathname.slice(0, -1) + tabUrl.search);
                            openUrls.add(tabUrl.origin + tabUrl.pathname.slice(0, -1));
                        }
                        
                        // 4. Just the origin (for sites that redirect to subpaths)
                        openUrls.add(tabUrl.origin);
                        openUrls.add(tabUrl.origin + '/');
                        
                        // 5. Handle www vs non-www
                        if (tabUrl.hostname.startsWith('www.')) {
                            const nonWwwOrigin = tabUrl.protocol + '//' + tabUrl.hostname.substring(4);
                            openUrls.add(nonWwwOrigin);
                            openUrls.add(nonWwwOrigin + '/');
                            openUrls.add(nonWwwOrigin + tabUrl.pathname);
                        } else {
                            const wwwOrigin = tabUrl.protocol + '//www.' + tabUrl.hostname;
                            openUrls.add(wwwOrigin);
                            openUrls.add(wwwOrigin + '/');
                            openUrls.add(wwwOrigin + tabUrl.pathname);
                        }
                        
                        // 6. Special handling for known redirects
                        // ChatGPT might redirect from chat.openai.com to chatgpt.com
                        if (tabUrl.hostname.includes('chatgpt.com')) {
                            openUrls.add('https://chat.openai.com/');
                            openUrls.add('https://chat.openai.com');
                        } else if (tabUrl.hostname.includes('chat.openai.com')) {
                            openUrls.add('https://chatgpt.com/');
                            openUrls.add('https://chatgpt.com');
                        }
                        
                        
                        urlDetails.push({
                            tabId: tab.id,
                            title: tab.element.querySelector('.tab-title').textContent,
                            url: tab.webview.src,
                            origin: tabUrl.origin,
                            pathname: tabUrl.pathname
                        });
                        
                    } catch (e) {
                        console.error('Error parsing tab URL:', e);
                    }
                }
            });
            
            console.log('Open tab details:', urlDetails);
            return openUrls;
        };
        
        const populateMenu = () => {
            console.log('PopulateMenu called');
            console.log('Environments:', environments);
            
            // Clear existing content
            menu.innerHTML = '';
            
            // Get open tab URLs
            const openUrls = getOpenTabUrls();
            console.log('Currently open URLs set size:', openUrls.size);
            console.log('Open URLs:', Array.from(openUrls));
            
            // Also log what tabs are currently open with their details
            console.log('\nCurrently open tabs:');
            tabs.forEach((tab, index) => {
                console.log(`Tab ${index}: ${tab.element.querySelector('.tab-title').textContent}`);
                console.log(`  - src: ${tab.webview.src}`);
                console.log(`  - currentUrl: ${tab.currentUrl}`);
            });
            
            let itemsAdded = 0;
            
            // Helper function to check if URL is already open - for IDW environments
            const isIdwUrlOpen = (url) => {
                console.log(`\nChecking if IDW URL is open: ${url}`);
                try {
                    // For IDW, we need more precise matching to avoid false positives
                    // since many IDWs share base URLs
                    
                    // First check exact match
                    if (openUrls.has(url)) {
                        console.log(`  ✓ IDW URL ${url} is open (exact match)`);
                        return true;
                    }
                    
                    // Parse the URL for more flexible matching
                    const checkUrl = new URL(url);
                    
                    // Check without fragment
                    const urlWithoutFragment = checkUrl.origin + checkUrl.pathname + checkUrl.search;
                    if (openUrls.has(urlWithoutFragment)) {
                        console.log(`IDW URL ${url} is open (without fragment match)`);
                        return true;
                    }
                    
                    // Check with normalized path (with and without trailing slash)
                    const normalizedPath = checkUrl.pathname.endsWith('/') 
                        ? checkUrl.pathname.slice(0, -1) 
                        : checkUrl.pathname;
                    const urlNormalized = checkUrl.origin + normalizedPath + checkUrl.search;
                    
                    if (openUrls.has(urlNormalized)) {
                        console.log(`IDW URL ${url} is open (normalized match)`);
                        return true;
                    }
                    
                    // Also check with trailing slash added
                    const urlWithSlash = checkUrl.origin + normalizedPath + '/' + checkUrl.search;
                    if (openUrls.has(urlWithSlash)) {
                        console.log(`IDW URL ${url} is open (with slash match)`);
                        return true;
                    }
                    
                    // For IDW URLs, also check if any open URL shares the same subdomain
                    // This handles cases where IDW navigates between pages
                    const checkDomain = checkUrl.hostname;
                    console.log(`  Checking domain match for: ${checkDomain}`);
                    for (const openUrl of openUrls) {
                        try {
                            const openUrlObj = new URL(openUrl);
                            if (openUrlObj.hostname === checkDomain) {
                                console.log(`  ✓ IDW URL ${url} is open (same domain match: ${openUrlObj.hostname})`);
                                return true;
                            }
                        } catch (e) {
                            // Skip invalid URLs
                        }
                    }
                    
                    console.log(`IDW URL ${url} is NOT open`);
                    return false;
                } catch (e) {
                    console.error('Error checking IDW URL:', e);
                    return false;
                }
            };
            
            // Add IDW environments (filter out already open)
            const filteredEnvironments = environments.filter(env => {
                // For IDW environments, check both homeUrl and chatUrl
                const homeUrlOpen = env.homeUrl ? isIdwUrlOpen(env.homeUrl) : false;
                const chatUrlOpen = env.chatUrl ? isIdwUrlOpen(env.chatUrl) : false;
                
                console.log(`IDW ${env.label}:`);
                console.log(`  - homeUrl: ${env.homeUrl}`);
                console.log(`  - chatUrl: ${env.chatUrl}`);
                console.log(`  - homeUrl open: ${homeUrlOpen}`);
                console.log(`  - chatUrl open: ${chatUrlOpen}`);
                
                // Consider it "open" if either URL is open
                return !homeUrlOpen && !chatUrlOpen;
            });
            
            console.log(`Filtered IDW environments: ${filteredEnvironments.length} out of ${environments.length}`);
            
            filteredEnvironments.forEach(env => {
                const menuItem = document.createElement('div');
                menuItem.className = 'idw-menu-item';
                menuItem.style.cssText = `
                    padding: 12px 16px;
                    cursor: pointer;
                    color: #ffffff;
                    transition: background-color 0.2s;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                `;
                menuItem.innerHTML = `
                    <div class="tab-favicon default-favicon"></div>
                    <span>${env.label}</span>
                `;
                menuItem.addEventListener('click', () => {
                    console.log('Opening IDW environment in current tab:', env.label);
                    navigateToUrl(env.homeUrl);
                    closeMenuAndCleanup();
                });
                menuItem.addEventListener('mouseover', () => {
                    menuItem.style.backgroundColor = '#3a3a3a';
                });
                menuItem.addEventListener('mouseout', () => {
                    menuItem.style.backgroundColor = 'transparent';
                });
                menu.appendChild(menuItem);
                itemsAdded++;
            });



            // If no items at all, show a message
            if (itemsAdded === 0) {
                const emptyMessage = document.createElement('div');
                emptyMessage.style.cssText = `
                    padding: 16px;
                    color: rgba(255,255,255,0.5);
                    text-align: center;
                `;
                emptyMessage.textContent = 'All IDW environments are already open';
                menu.appendChild(emptyMessage);
            }

            // Add the menu to the document
            document.body.appendChild(overlay);
            document.body.appendChild(menu);

            // Close menu when clicking on overlay or outside menu
            const closeMenu = (e) => {
                // Don't close if it's a right-click (context menu)
                if (e.button === 2) return;
                
                // If clicking on overlay or outside menu (but not the menu itself or new tab button)
                if (e.target === overlay || (!menu.contains(e.target) && e.target !== newTabButton)) {
                    console.log('Closing menu due to outside click');
                    menu.remove();
                    overlay.remove();
                    document.removeEventListener('click', closeMenu);
                    document.removeEventListener('mousedown', closeMenuOnWebview);
                }
            };
            
            // Special handler for webview clicks (since they might not bubble up)
            const closeMenuOnWebview = (e) => {
                // Don't close if it's a right-click (context menu)
                if (e.button === 2) return;
                
                // Check if the click target is within a webview container
                const isWebviewClick = e.target.closest('.webview-container') || 
                                     e.target.tagName === 'WEBVIEW';
                                     
                if (isWebviewClick) {
                    console.log('Closing menu due to webview click');
                    menu.remove();
                    overlay.remove();
                    document.removeEventListener('click', closeMenu);
                    document.removeEventListener('mousedown', closeMenuOnWebview);
                }
            };
            
            // Helper function to close menu and cleanup
            const closeMenuAndCleanup = () => {
                menu.remove();
                overlay.remove();
                document.removeEventListener('click', closeMenu);
                document.removeEventListener('mousedown', closeMenuOnWebview);
            };
            
            // Click on overlay should close menu
            overlay.addEventListener('click', (e) => {
                console.log('Overlay clicked, closing menu');
                closeMenuAndCleanup();
            });
            
            // Add the event listeners after a brief delay to avoid immediate closure
            setTimeout(() => {
                document.addEventListener('click', closeMenu);
                // Use mousedown for webview areas as it fires before click is captured
                document.addEventListener('mousedown', closeMenuOnWebview);
                
                // Also listen for focus events on webviews
                const webviews = document.querySelectorAll('webview');
                webviews.forEach(webview => {
                    webview.addEventListener('focus', () => {
                        console.log('Closing menu due to webview focus');
                        closeMenuAndCleanup();
                    }, { once: true });
                });
            }, 0);
            
            // Prevent clicks inside the menu from bubbling up
            menu.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        };
        
        // Request IDW environments
        console.log('Requesting IDW environments...');
        window.api.getIDWEnvironments((receivedEnvironments) => {
            console.log('Received IDW environments:', receivedEnvironments);
            environments = receivedEnvironments || [];
            populateMenu();
        });
    });
    
    backButton.addEventListener('click', () => {
        if (activeTabId) {
            const tab = tabs.find(t => t.id === activeTabId);
            if (tab) {
                try {
                    // Use try-catch in case canGoBack() fails
                    if (tab.webview.canGoBack()) {
                        console.log(`Navigating back in tab ${activeTabId}`);
                        tab.webview.goBack();
                    } else {
                        console.log(`Cannot go back in tab ${activeTabId} - no history`);
                    }
                    // Force update nav state after navigation
                    setTimeout(() => updateNavigationState(activeTabId), 300);
                } catch (error) {
                    console.error(`Error navigating back in tab ${activeTabId}:`, error);
                }
            } else {
                console.log(`Cannot go back in tab ${activeTabId} - tab not found`);
            }
        }
    });
    
    forwardButton.addEventListener('click', () => {
        if (activeTabId) {
            const tab = tabs.find(t => t.id === activeTabId);
            if (tab) {
                try {
                    // Use try-catch in case canGoForward() fails
                    if (tab.webview.canGoForward()) {
                        console.log(`Navigating forward in tab ${activeTabId}`);
                        tab.webview.goForward();
                    } else {
                        console.log(`Cannot go forward in tab ${activeTabId} - no forward history`);
                    }
                    // Force update nav state after navigation
                    setTimeout(() => updateNavigationState(activeTabId), 300);
                } catch (error) {
                    console.error(`Error navigating forward in tab ${activeTabId}:`, error);
                }
            } else {
                console.log(`Cannot go forward in tab ${activeTabId} - tab not found`);
            }
        }
    });
    
    refreshButton.addEventListener('click', () => {
        if (activeTabId) {
            const tab = tabs.find(t => t.id === activeTabId);
            if (tab) {
                console.log(`Refreshing tab ${activeTabId}`);
                // Force reload regardless of ready state
                tab.webview.reload();
                // Force update nav state after short delay
                setTimeout(() => updateNavigationState(activeTabId), 300);
            } else {
                console.log(`Cannot refresh tab ${activeTabId} - tab not found`);
            }
        }
    });
    
    // Add Debug button handler
    const debugButton = document.getElementById('debug-button');
    if (debugButton) {
        debugButton.addEventListener('click', () => {
            console.log('Debug button clicked!');
            debugSessionIsolation();
        });
    } else {
        console.error('Debug button not found in DOM');
    }
    
    // Add Black Hole Widget button handler
    const blackHoleButton = document.getElementById('black-hole-button');
    console.log('Black Hole button element:', blackHoleButton); // Debug log
    
    if (!blackHoleButton) {
      console.error('Black Hole button not found in DOM!');
      return;
    }
    
    let blackHoleTimeout = null;
    let isBlackHoleOpen = false;
    let isBlackHoleActive = false; // Track if space chooser is open
    
    // Function to open the Black Hole Widget
    const openBlackHole = () => {
        if (!isBlackHoleOpen) {
            console.log('Opening Black Hole Widget');
            isBlackHoleOpen = true;
            
            // Get button position to show black hole near it
            const buttonRect = blackHoleButton.getBoundingClientRect();
            console.log('Button rect:', buttonRect);
            console.log('Window position:', { screenX: window.screenX, screenY: window.screenY });
            
            // Get the title bar height (approximate - usually around 22-30px on macOS)
            // We can calculate this by comparing outer and inner height
            const titleBarHeight = window.outerHeight - window.innerHeight;
            console.log('Estimated title bar height:', titleBarHeight);
            
            // Calculate position to center the black hole over the button
            // The black hole widget is 150px wide/tall
            const blackHoleSize = 150;
            const position = {
                x: Math.round(window.screenX + buttonRect.left + (buttonRect.width / 2) - (blackHoleSize / 2)),
                y: Math.round(window.screenY + titleBarHeight + buttonRect.top + (buttonRect.height / 2) - (blackHoleSize / 2))
            };
            
            console.log('Black Hole calculated position (centered on button):', position);
            
            // Send message to main process to open Black Hole Widget with position
            window.api.send('open-black-hole-widget', position);
            
            // Set timeout to close after 5 seconds (only if not active)
            blackHoleTimeout = setTimeout(() => {
                if (!isBlackHoleActive) {
                    console.log('Auto-closing Black Hole Widget after 5 seconds');
                    window.api.send('close-black-hole-widget');
                    isBlackHoleOpen = false;
                } else {
                    console.log('Black Hole Widget is active, not auto-closing');
                }
            }, 5000); // 5 seconds
        }
    };
    
    // NOTE: Removed mouseover handler as it blocks clicks by opening widget over the button
    // The button should only respond to clicks (for clipboard) and drags (for files)
    
    // Drag events - open when dragging files over the button
    blackHoleButton.addEventListener('dragenter', (e) => {
        console.log('Black Hole dragenter event triggered');
        e.preventDefault();
        openBlackHole();
    });
    
    blackHoleButton.addEventListener('dragover', (e) => {
        console.log('Black Hole dragover event triggered');
        e.preventDefault(); // Important: prevent default to allow drop
        openBlackHole();
    });
    
    // Cancel auto-close if user clicks the button or drops files
    const cancelAutoClose = () => {
        if (blackHoleTimeout) {
            console.log('Cancelling Black Hole auto-close');
            clearTimeout(blackHoleTimeout);
            blackHoleTimeout = null;
        }
    };
    
    blackHoleButton.addEventListener('click', () => {
        console.log('Black Hole click event triggered'); // Debug log
        cancelAutoClose();
        
        // Always open the clipboard viewer when clicked
        console.log('Sending request to open clipboard viewer');
        window.api.send('open-clipboard-viewer');
    });
    
    blackHoleButton.addEventListener('drop', (e) => {
        console.log('Black Hole drop event triggered');
        e.preventDefault();
        cancelAutoClose();
        // The actual drop will be handled by the Black Hole Widget itself
    });
    
    // Listen for black hole closed event from main process
    window.api.receive('black-hole-closed', () => {
        console.log('Black Hole Widget closed');
        isBlackHoleOpen = false;
        isBlackHoleActive = false;
        if (blackHoleTimeout) {
            clearTimeout(blackHoleTimeout);
            blackHoleTimeout = null;
        }
    });
    
    // Listen for black hole active state (space chooser open)
    window.api.receive('black-hole-active', () => {
        console.log('Black Hole Widget is active (space chooser open)');
        isBlackHoleActive = true;
        // Cancel any existing auto-close timer
        cancelAutoClose();
    });
    
    // Listen for black hole inactive state (space chooser closed)
    window.api.receive('black-hole-inactive', () => {
        console.log('Black Hole Widget is inactive (space chooser closed)');
        isBlackHoleActive = false;
        // If black hole is still open but inactive, start auto-close timer
        if (isBlackHoleOpen) {
            blackHoleTimeout = setTimeout(() => {
                if (!isBlackHoleActive && isBlackHoleOpen) {
                    console.log('Auto-closing inactive Black Hole Widget');
                    window.api.send('close-black-hole-widget');
                    isBlackHoleOpen = false;
                }
            }, 5000); // 5 seconds
        }
    });
    
    console.log('Black Hole event listeners attached successfully'); // Debug log
    
    // Listen for message events from webviews
    window.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'new-window') {
            console.log('Received postMessage for new window:', event.data.url);
            
            // Check if it's a chat URL
            if (event.data.url.includes('/chat/') || 
                event.data.url.startsWith('https://flow-desc.chat.edison.onereach.ai/')) {
                
                // First check if this URL is already open
                if (findAndFocusTab(event.data.url)) {
                    console.log('Chat URL already open, focused existing tab');
                    return;
                }
                
                if (openChatLinksInNewTab) {
                    console.log('Chat URL in postMessage, creating new tab (preference):', event.data.url);
                    createNewTab(event.data.url);
                } else {
                    console.log('Chat URL in postMessage, navigating in current tab:', event.data.url);
                    // Navigate in the current tab
                    const activeTab = tabs.find(t => t.id === activeTabId);
                    if (activeTab && activeTab.webview) {
                        activeTab.webview.src = event.data.url;
                    }
                }
            } else {
                createNewTab(event.data.url);
            }
        } else if (event.data && event.data.type === 'request-new-tab') {
            console.log('Received postMessage for request-new-tab:', event.data.url);
            createNewTab(event.data.url);
        }
    });
    
    // Load saved tabs or create initial tab if none exist
    loadSavedTabs();
    
    // Handle messages from main process
    window.api.receive('open-in-new-tab', (data) => {
        // Extract URL from data
        const url = typeof data === 'string' ? data : (data && data.url ? data.url : null);
        
        // Check if this is a problematic site that should open in default browser
        const problematicSites = ['elevenlabs.io'];
        if (url && problematicSites.some(site => url.includes(site))) {
            console.log(`Opening ${url} in default browser due to compatibility issues`);
            if (window.flipboardAPI && window.flipboardAPI.openExternal) {
                window.flipboardAPI.openExternal(url);
            } else {
                // Try shell.openExternal via IPC
                window.api.send('open-external', url);
            }
            return;
        }
        
        // Check if it's a simple URL string or an object with additional data
        if (typeof data === 'string') {
            createNewTab(data);
        } else if (data && data.url) {
            // Handle ChatGPT with enhanced permissions
            if (data.isChatGPT) {
                console.log('Creating enhanced tab for ChatGPT:', data.url);
                createChatGPTTab(data.url, data.label);
            } else if (data.isImageCreator || data.isVideoCreator) {
                // Handle image and video creators
                console.log(`Creating tab for ${data.isVideoCreator ? 'video' : 'image'} creator:`, data.url);
                createNewTab(data.url);
            } else {
                createNewTab(data.url);
            }
        }
    });
    
    // Handle chat URLs specifically
    window.api.receive('handle-chat-url', (url) => {
        console.log('Renderer received handle-chat-url message for URL:', url);
        
        // First check if this URL is already open
        if (findAndFocusTab(url)) {
            console.log('Chat URL already open, focused existing tab');
            return;
        }
        
        if (openChatLinksInNewTab) {
            console.log('Creating new tab for chat URL (preference):', url);
            createNewTab(url);
        } else {
            console.log('Navigating to chat URL in current tab:', url);
            // Navigate in the current tab
            const activeTab = tabs.find(t => t.id === activeTabId);
            if (activeTab && activeTab.webview) {
                activeTab.webview.src = url;
            } else {
                console.error('No active tab found to navigate');
            }
        }
    });
    
    // Listen for app-before-quit event to save tab state
    window.api.receive('save-tabs-state', () => {
        console.log('Saving tab state before app quit');
        saveTabState();
    });

    // Listen for auth URL handling
    window.api.receive('handle-auth-url', (url) => {
        console.log('Received auth URL to handle:', url);
        
        // Get the current active tab
        const activeTab = document.querySelector('.tab.active');
        if (!activeTab) {
            console.error('No active tab found to handle auth URL');
            return;
        }
        
        // Get the webview in the active tab
        const webview = activeTab.querySelector('webview');
        if (!webview) {
            console.error('No webview found in active tab');
            return;
        }
        
        // Load the auth URL in the current webview
        console.log('Loading auth URL in current webview:', url);
        webview.loadURL(url);
    });
    
    // Custom context menu implementation
    const customContextMenu = document.getElementById('custom-context-menu');
    const pasteToBlackHoleItem = document.getElementById('paste-to-black-hole');
    
    // Handle right-click to show custom context menu
    document.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        
        // Don't show on tabs
        if (e.target.closest('.tab')) {
            return;
        }
        
        console.log('Showing custom context menu at:', e.clientX, e.clientY);
        
        // Position and show the menu
        customContextMenu.style.left = `${e.clientX}px`;
        customContextMenu.style.top = `${e.clientY}px`;
        customContextMenu.style.display = 'block';
    });
    
    // Hide context menu on click elsewhere
    document.addEventListener('click', (e) => {
        if (!customContextMenu.contains(e.target)) {
            customContextMenu.style.display = 'none';
        }
    });
    
    // Handle paste to black hole click
    pasteToBlackHoleItem.addEventListener('click', () => {
        console.log('Paste to Black Hole clicked from custom menu');
        customContextMenu.style.display = 'none';
        
        // Send request to show black hole
        window.api.send('show-black-hole');
        
        // Get clipboard text and send to black hole
        window.api.send('get-clipboard-text');
        window.api.receive('clipboard-text-result', (text) => {
            if (text) {
                console.log('Sending clipboard text to black hole');
                window.api.send('paste-to-black-hole', {
                    type: 'text',
                    content: text
                });
            }
        });
    });
});

// Load tabs from localStorage
function loadSavedTabs() {
    try {
        const savedTabsJSON = localStorage.getItem('savedTabs');
        if (savedTabsJSON) {
            const savedTabs = JSON.parse(savedTabsJSON);
            console.log('Restoring saved tabs:', savedTabs);
            
            if (savedTabs.tabs && savedTabs.tabs.length > 0) {
                // Create each saved tab
                savedTabs.tabs.forEach((tabData, index) => {
                    console.log(`Restoring tab ${index}: URL=${tabData.url}, Partition=${tabData.partition}`);
                    // Create the tab with the saved URL and partition
                    createNewTabWithPartition(tabData.url, tabData.partition);
                });
                
                // Activate the previously active tab
                if (savedTabs.activeTabIndex >= 0 && savedTabs.activeTabIndex < tabs.length) {
                    activateTab(tabs[savedTabs.activeTabIndex].id);
                }
                
                return;
            }
        }
    } catch (error) {
        console.error('Error loading saved tabs:', error);
    }
    
    // If no tabs were loaded or there was an error, create a default tab
    createNewTab('https://my.onereach.ai/');
}

// Save current tab state to localStorage
function saveTabState() {
    try {
        const tabsToSave = tabs.map(tab => {
            return {
                url: tab.webview.src,
                title: tab.element.querySelector('.tab-title').textContent,
                partition: tab.webview.dataset.partition
            };
        });
        
        const activeTabIndex = tabs.findIndex(tab => tab.id === activeTabId);
        
        const tabState = {
            tabs: tabsToSave,
            activeTabIndex: activeTabIndex
        };
        
        localStorage.setItem('savedTabs', JSON.stringify(tabState));
        console.log('Tab state saved:', tabState);
    } catch (error) {
        console.error('Error saving tab state:', error);
    }
}

// Get the favicon URL for a website
function getFaviconUrl(url) {
    try {
        const urlObj = new URL(url);
        return `${urlObj.origin}/favicon.ico`;
    } catch (error) {
        console.error('Error generating favicon URL:', error);
        return null;
    }
}

// Update a tab's favicon
function updateTabFavicon(tabId, url) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;
    
    const faviconElement = tab.element.querySelector('.tab-favicon');
    if (!faviconElement) return;
    
    const faviconUrl = getFaviconUrl(url);
    if (!faviconUrl) {
        // Set default favicon if we couldn't generate a valid URL
        faviconElement.style.backgroundImage = '';
        faviconElement.classList.add('default-favicon');
        return;
    }
    
    // Create a new image to test if the favicon exists
    const img = new Image();
    img.onload = () => {
        faviconElement.style.backgroundImage = `url(${faviconUrl})`;
        faviconElement.classList.remove('default-favicon');
    };
    img.onerror = () => {
        // If favicon.ico doesn't exist, try the Google favicon service
        const googleFaviconUrl = `https://www.google.com/s2/favicons?domain=${url}`;
        faviconElement.style.backgroundImage = `url(${googleFaviconUrl})`;
        faviconElement.classList.remove('default-favicon');
    };
    img.src = faviconUrl;
}

// Create a new tab with the given URL and partition
function createNewTabWithPartition(url = 'https://my.onereach.ai/', partition = null) {
    // Check if this is a problematic site that should open in default browser
    const problematicSites = ['elevenlabs.io'];
    const shouldOpenExternal = problematicSites.some(site => url.includes(site));
    
    if (shouldOpenExternal) {
        console.log(`Opening ${url} in default browser due to compatibility issues`);
        // Use the flipboard API to open in default browser
        if (window.flipboardAPI && window.flipboardAPI.openExternal) {
            window.flipboardAPI.openExternal(url);
        } else {
            // Fallback: send IPC message
            console.log('Falling back to IPC message for external URL');
            window.api.send('open-in-new-tab', { url: url, external: true });
        }
        return null;
    }
    
    // Create a unique ID for this tab
    const tabId = `tab-${tabCounter++}`;
    
    // Create the tab UI element
    const tabElement = document.createElement('div');
    tabElement.className = 'tab';
    tabElement.dataset.tabId = tabId;
    tabElement.innerHTML = `
        <div class="tab-favicon default-favicon"></div>
        <div class="tab-title">New Tab</div>
        <div class="tab-close" data-tab-id="${tabId}">×</div>
    `;
    
    // Create the webview container
    const webviewContainer = document.createElement('div');
    webviewContainer.className = 'webview-container';
    webviewContainer.dataset.tabId = tabId;
    
    // Use the provided partition or create a new unique one for complete isolation
    const partitionName = partition || `persist:tab-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
    
    console.log(`Creating webview for tab ${tabId} with partition: ${partitionName} for URL: ${url}`);
    
    // Create the webview element
    const webview = document.createElement('webview');
    webview.dataset.tabId = tabId;
    webview.setAttribute('allowpopups', 'true');
    // Turn off security features to allow all popups and links
    webview.setAttribute('webpreferences', 'contextIsolation=yes, nativeWindowOpen=true, enableBlinkFeatures=MediaStreamAPI,WebRTC,AudioWorklet,WebAudio,MediaRecorder, allowPopups=true, javascript=true');
    webview.setAttribute('disablewebsecurity', 'true');  // Allow cross-origin requests
    webview.setAttribute('allowrunninginsecurecontent', 'true');  // Allow mixed content
    // Set partition as both attribute and property for proper isolation
    webview.setAttribute('partition', partitionName);
    webview.partition = partitionName;  // Also set as property
    
    // Set src after partition to ensure it's applied
    webview.src = url;
    
    // Add preload script for IDW sites to handle authentication
    if (url && (url.includes('onereach.ai') || url.includes('edison.onereach.ai'))) {
        // The preload script path needs to be a file:// URL in the renderer
        webview.setAttribute('preload', 'file://' + window.location.pathname.replace('tabbed-browser.html', 'preload-minimal.js'));
        
        // For OneReach sites, don't disable web security as it can break authentication
        webview.removeAttribute('disablewebsecurity');
        webview.removeAttribute('allowrunninginsecurecontent');
    }
    
    // Add permissions for media access (microphone for voice mode)
    webview.setAttribute('nodeintegration', 'false');
    webview.setAttribute('plugins', 'true');
    webview.setAttribute('allowfullscreen', 'true');
    
    // Enable getUserMedia for microphone access
    webview.setAttribute('webrtc', 'true');
    webview.setAttribute('autoplay', 'true');
    webview.setAttribute('experimentalfeatures', 'true');
    webview.setAttribute('enableremotemodule', 'false');
    
    // Set a Chrome-like user agent for all tabs
    const chromeVersion = '120.0.0.0';
    webview.setAttribute('useragent', `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`);
    
    // Store the partition name in the dataset for future reference
    webview.dataset.partition = partitionName;
    
    // Verify partition is set
    console.log(`Webview ${tabId} partition attribute: ${webview.getAttribute('partition')}`);
    console.log(`Webview ${tabId} dataset.partition: ${webview.dataset.partition}`);
    
    // Handle permission requests (for microphone access in voice mode)
    webview.addEventListener('permission-request', (e) => {
        console.log(`Permission request in webview ${tabId}:`, e.permission);
        
        // Allow media and other important permissions
        if (e.permission === 'media' || 
            e.permission === 'audioCapture' || 
            e.permission === 'microphone' ||
            e.permission === 'camera' ||
            e.permission === 'notifications' ||
            e.permission === 'clipboard-read' ||
            e.permission === 'clipboard-write') {
            console.log(`Allowing ${e.permission} permission for webview ${tabId}`);
            e.request.allow();
        } else {
            console.log(`Denying ${e.permission} permission for webview ${tabId}`);
            e.request.deny();
        }
    });
    

    

    
    // Add the elements to the DOM
    webviewContainer.appendChild(webview);
    document.getElementById('browser-container').appendChild(webviewContainer);
    

    
    // Insert the tab before the new tab button
    const tabBar = document.querySelector('.tab-bar');
    tabBar.insertBefore(tabElement, document.getElementById('new-tab-button'));
    
    // Set up event listeners for the tab
    tabElement.addEventListener('click', (e) => {
        if (!e.target.classList.contains('tab-close')) {
            activateTab(tabId);
        }
    });
    
    // Add right-click context menu for tabs
    tabElement.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        
        // Create context menu
        const existingMenu = document.querySelector('.tab-context-menu');
        if (existingMenu) existingMenu.remove();
        
        const menu = document.createElement('div');
        menu.className = 'tab-context-menu';
        menu.style.cssText = `
            position: fixed;
            left: ${e.clientX}px;
            top: ${e.clientY}px;
            background: #2a2a2a;
            border: 1px solid #444;
            border-radius: 4px;
            padding: 4px 0;
            z-index: 10000;
            box-shadow: 0 2px 10px rgba(0,0,0,0.3);
        `;
        
        const menuItems = [
            { label: 'Reload Tab', action: () => webview.reload() },
            { label: 'Clear Session Data', action: () => {
        webview.executeJavaScript(`
                    localStorage.clear();
                    sessionStorage.clear();
                    document.cookie.split(";").forEach(function(c) { 
                        document.cookie = c.replace(/^ +/, "").replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/"); 
                    });
                    location.reload();
                `).then(() => {
                    console.log(`Cleared session data for tab ${tabId}`);
                }).catch(err => console.error('Error clearing session data:', err));
            }},
            { label: 'Check Authentication', action: () => {
                // Manually trigger the authentication check
                checkTabAuthentication(tabId, webview);
            }},
            { label: 'Inspect Session', action: () => {
                tab.checkSession();
            }},
            { label: '─────────', action: null }, // Separator
            { label: (openChatLinksInNewTab ? '✓ ' : '') + 'Chat Links Open in New Tab', action: () => {
                openChatLinksInNewTab = !openChatLinksInNewTab;
                console.log('Chat links will now open in', openChatLinksInNewTab ? 'new tabs' : 'current tab');
                // Save preference
                localStorage.setItem('openChatLinksInNewTab', openChatLinksInNewTab);
                menu.remove();
            }}
        ];
        
        menuItems.forEach(item => {
            const menuItem = document.createElement('div');
            
            // Check if it's a separator
            if (item.action === null) {
                menuItem.style.cssText = `
                    height: 1px;
                    background: rgba(255,255,255,0.2);
                    margin: 4px 8px;
                `;
            } else {
                menuItem.textContent = item.label;
                menuItem.style.cssText = `
                    padding: 8px 16px;
                    cursor: pointer;
                    color: white;
                    font-size: 14px;
                `;
                menuItem.onmouseover = () => menuItem.style.background = '#444';
                menuItem.onmouseout = () => menuItem.style.background = 'transparent';
                menuItem.onclick = () => {
                    item.action();
                    if (item.label !== (openChatLinksInNewTab ? '✓ ' : '') + 'Chat Links Open in New Tab') {
                        menu.remove();
                    }
                };
            }
            
            menu.appendChild(menuItem);
        });
        
        document.body.appendChild(menu);
        
        // Remove menu when clicking elsewhere
        const removeMenu = (e) => {
            // Don't remove if it's a right-click context menu
            if (e.button === 2) return;
            
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', removeMenu);
            }
        };
        setTimeout(() => document.addEventListener('click', removeMenu), 0);
    });
    
    tabElement.querySelector('.tab-close').addEventListener('click', () => {
        closeTab(tabId);
    });
    
    // Flag to track if webview is ready
    let webviewReady = false;
    let loadingTimeout = null;
    let isInitialLoad = true;
    
    // Set up webview event listeners
    webview.addEventListener('dom-ready', () => {
        console.log(`Webview ${tabId} dom-ready event fired (initial load: ${isInitialLoad})`);
        console.log(`Webview ${tabId} partition in dom-ready: ${webview.partition} (getAttribute: ${webview.getAttribute('partition')})`);
        webviewReady = true;
        clearTimeout(loadingTimeout);
        
        // Get the webContents ID and use it to access the webContents directly
        const webContentsId = webview.getWebContentsId();
        console.log(`Webview ${tabId} webContentsId:`, webContentsId);
        
        // Log the actual partition being used
        console.log(`Webview ${tabId} actual partition property:`, webview.partition);
        
        // Send a message to the main process to set up window open handlers
        window.api.send('setup-webcontents-handlers', {
            webContentsId: webContentsId,
            tabId: tabId
        });
        
        // Inject link click handler to debug and control navigation
        webview.executeJavaScript(`
            (function() {
                console.log('Injecting link click handler for debugging');
                
                // Get the current preference value
                const openChatLinksInNewTab = ${openChatLinksInNewTab};
                console.log('Chat links preference:', openChatLinksInNewTab ? 'new tabs' : 'current tab');
                
                // Debug: Log all links on the page
                setTimeout(() => {
                    const allLinks = document.querySelectorAll('a[href]');
                    console.log('=== All links on page ===');
                    allLinks.forEach((link, index) => {
                        console.log(\`Link \${index}: \${link.href} (text: "\${link.textContent.trim()}")\`);
                    });
                    console.log('=== End links ===');
                    
                    // Also check for any data attributes or onclick handlers
                    const linksWithHandlers = document.querySelectorAll('a[onclick], [data-href], [data-url]');
                    if (linksWithHandlers.length > 0) {
                        console.log('=== Links with handlers or data attributes ===');
                        linksWithHandlers.forEach((link, index) => {
                            console.log(\`Special link \${index}:\`, {
                                href: link.href,
                                onclick: link.onclick ? link.onclick.toString() : null,
                                dataHref: link.dataset.href,
                                dataUrl: link.dataset.url,
                                text: link.textContent.trim()
                            });
                        });
                    }
                }, 2000); // Wait for page to fully load
                
                // Track all clicks on links
            document.addEventListener('click', function(e) {
                let target = e.target;
                while (target && target.tagName !== 'A') {
                    target = target.parentElement;
                }
                
                if (target && target.tagName === 'A' && target.href) {
                        console.log('Link clicked:', {
                            href: target.href,
                            target: target.target,
                            text: target.textContent,
                            isDefaultPrevented: e.defaultPrevented
                        });
                        
                        // If it's a chat link and doesn't have target="_blank", let it navigate in current tab
                        if (!target.target || target.target === '_self') {
                            console.log('Link should navigate in current tab');
                            // Don't prevent default - let normal navigation happen
                        }
                    }
                }, true); // Use capture phase to see all clicks
                
                // Also monitor window.open calls
                const originalOpen = window.open;
                window.open = function(url, target, features) {
                    console.log('window.open called:', {
                        url: url,
                        target: target,
                        features: features,
                        caller: new Error().stack // Show where it was called from
                    });
                    
                    // Log any OneReach-specific variables that might affect URL selection
                    console.log('OneReach context at window.open:', {
                        currentUser: window.currentUser || 'none',
                        userProfile: window.userProfile || 'none',
                        idwConfig: window.idwConfig || 'none',
                        localStorage_idw: localStorage.getItem('selectedIdw') || localStorage.getItem('currentIdw') || 'none'
                    });
                    
                    // Check if it's a chat URL and we should navigate in current tab
                    if (url && (url.includes('/chat/') || 
                               url.startsWith('https://flow-desc.chat.edison.onereach.ai/') ||
                               url.includes('chat.') && url.includes('.onereach.ai'))) {
                        
                        // Check if we should open in current tab (preference is false)
                        if (!openChatLinksInNewTab) {
                            console.log('Chat URL in window.open, navigating in current tab instead');
                            window.location.href = url;
                            return null; // Return null to indicate no window was opened
                        }
                    }
                    
                    // Otherwise, use the original window.open
                    return originalOpen.call(window, url, target, features);
                };
                
                // Monitor location changes
                const originalPushState = history.pushState;
                history.pushState = function() {
                    console.log('history.pushState called:', arguments);
                    return originalPushState.apply(history, arguments);
                };
                
                const originalReplaceState = history.replaceState;
                history.replaceState = function() {
                    console.log('history.replaceState called:', arguments);
                    return originalReplaceState.apply(history, arguments);
                };
                
                console.log('Link click debugging enabled');
            })();
        `).catch(err => {
            console.error(`Error injecting link handler into webview ${tabId}:`, err);
        });
        
        // Update navigation button states if this is the active tab
        if (tabId === activeTabId) {
            updateNavigationState(tabId);
        }
        
        // Update favicon 
        updateTabFavicon(tabId, webview.src);
        
        // Save tab state when page is fully loaded
        saveTabState();
        

    });
    
    // Add error handling for failed loads
    webview.addEventListener('did-fail-load', (e) => {
        console.error(`Webview ${tabId} failed to load:`, e.errorCode, e.errorDescription);
        webviewReady = false;
        clearTimeout(loadingTimeout);
        isInitialLoad = false;
        
        // Update the tab title to show error
        const tabElement = document.querySelector(`.tab[data-tab-id="${tabId}"]`);
        if (tabElement) {
            const titleElement = tabElement.querySelector('.tab-title');
            if (titleElement) {
                titleElement.textContent = 'Failed to load page';
            }
        }
    });

    // Add loading state management
    webview.addEventListener('did-start-loading', () => {
        console.log(`Webview ${tabId} started loading (initial load: ${isInitialLoad})`);
        webviewReady = false;
        
        // Clear any existing timeout
        clearTimeout(loadingTimeout);
        
        // Set new timeout for loading
        loadingTimeout = setTimeout(() => {
            if (!webviewReady) {
                console.warn(`Webview ${tabId} loading timeout`);
            }
        }, 30000); // 30 second timeout
    });

    // Handle page load completion
    webview.addEventListener('did-finish-load', () => {
        console.log(`Webview ${tabId} finished loading (initial load: ${isInitialLoad})`);
        webviewReady = true;
        clearTimeout(loadingTimeout);
        
        // Update tab title with actual page title
        webview.executeJavaScript('document.title').then(title => {
            const tabElement = document.querySelector(`.tab[data-tab-id="${tabId}"]`);
            if (tabElement) {
                const titleElement = tabElement.querySelector('.tab-title');
                if (titleElement) {
                    titleElement.textContent = title || 'New Tab';
                }
            }
        }).catch(err => console.error('Error getting page title:', err));
        
        // Update navigation state
        if (tabId === activeTabId) {
            updateNavigationState(tabId);
        }
        
        // Mark initial load as complete
        isInitialLoad = false;
    });

    // Handle page load stop
    webview.addEventListener('did-stop-loading', () => {
        console.log(`Webview ${tabId} stopped loading (initial load: ${isInitialLoad})`);
        clearTimeout(loadingTimeout);
        
        // Update navigation state whenever loading stops
        if (tabId === activeTabId) {
            updateNavigationState(tabId);
        }
    });

    // Handle page title updates
    webview.addEventListener('page-title-updated', (e) => {
        console.log(`Webview ${tabId} title updated: ${e.title} (initial load: ${isInitialLoad})`);
        const tabElement = document.querySelector(`.tab[data-tab-id="${tabId}"]`);
        if (tabElement) {
            const titleElement = tabElement.querySelector('.tab-title');
            if (titleElement) {
                titleElement.textContent = e.title;
            }
        }
    });
    
    webview.addEventListener('did-navigate', (e) => {
        console.log(`Webview ${tabId} did-navigate to: ${e.url}`);
        
        // Update the tab's current URL
        const tab = tabs.find(t => t.id === tabId);
        if (tab) {
            tab.currentUrl = e.url;
            console.log(`Updated tab ${tabId} currentUrl to: ${e.url}`);
        }
        
        // Keep track of navigation for the tab
        if (tabId === activeTabId) {
            // Update navigation state
            updateNavigationState(tabId);
        }
        
        // Update favicon when navigation completes
        updateTabFavicon(tabId, e.url);
        
        // Save tab state when navigation completes
        saveTabState();
    });
    
    webview.addEventListener('did-navigate-in-page', (e) => {
        console.log(`Webview ${tabId} did-navigate-in-page to: ${e.url}`);
        
        // Update the tab's current URL for in-page navigation too
        const tab = tabs.find(t => t.id === tabId);
        if (tab) {
            tab.currentUrl = e.url;
            console.log(`Updated tab ${tabId} currentUrl (in-page) to: ${e.url}`);
        }
        
        // This is critical for chat interfaces that use history API
        if (tabId === activeTabId) {
            updateNavigationState(tabId);
        }
    });
    
    // Intercept navigation attempts to check for existing tabs
    webview.addEventListener('will-navigate', (e) => {
        console.log(`Webview ${tabId} will-navigate to: ${e.url}`);
        
        // DISABLED: This was preventing navigation to different chat URLs
        // The findAndFocusTab was being too aggressive in matching URLs
        /*
        // Check if it's a chat URL
        if (e.url.includes('/chat/') || 
            e.url.startsWith('https://flow-desc.chat.edison.onereach.ai/')) {
            
            // Check if this URL is already open in another tab
            if (findAndFocusTab(e.url)) {
                console.log('Chat URL already open, preventing navigation and focusing existing tab');
                e.preventDefault();
                return;
            }
        }
        */
    });
    
    webview.addEventListener('new-window', (e) => {
        console.log('Webview new-window event detected:', {
            url: e.url,
            disposition: e.disposition,
            frameName: e.frameName,
            options: e.options,
            referrer: e.referrer
        });
        
        // Check if this is actually a request to open in a new window/tab
        const isNewWindowRequest = ['new-window', 'foreground-tab', 'background-tab'].includes(e.disposition);
        
        // If it's not a new window request (e.g., 'other' for same-window navigation), let it proceed normally
        if (!isNewWindowRequest && e.disposition !== 'save-to-disk') {
            console.log('Navigation in same window detected, allowing default behavior');
            return; // Don't prevent default, allow normal navigation
        }
        
        // Check if this is an authentication URL that needs special handling
        if (e.url.includes('accounts.google.com') || 
            e.url.includes('sso.global.api.onereach.ai') || 
            e.url.includes('auth.edison.onereach.ai') ||
            e.url.includes('login.onereach.ai') ||
            e.url.includes('login.edison.onereach.ai') ||
            e.url.includes('oauth') ||
            e.url.includes('/auth/') ||
            e.url.includes('firebase') ||
            e.url.includes('elevenlabs.io/auth')) {
            console.log('Auth URL detected, allowing popup for OAuth flow:', e.url);
            // Don't prevent default - let the auth popup open normally
            // The main process will handle the popup window with same session
            return;
        }
        
        // For other URLs that are actual new window requests, prevent default and handle as before
        e.preventDefault();
        
        // Check if this is a chat URL
        if (e.url.includes('/chat/') || 
            e.url.startsWith('https://flow-desc.chat.edison.onereach.ai/')) {
            
            // REMOVED: Don't check for existing tabs - each chat URL should be able to open
            // The previous check was preventing different chat URLs from opening
            /*
            // First check if this URL is already open
            if (findAndFocusTab(e.url)) {
                console.log('Chat URL already open, focused existing tab');
                return;
            }
            */
            
            if (openChatLinksInNewTab) {
                console.log('Chat URL detected in new-window event, creating new tab (preference)');
                createNewTab(e.url);
            } else {
            console.log('Chat URL detected in new-window event, navigating in current tab');
                // Navigate in the current tab instead of creating a new one
                webview.src = e.url;
            }
            return;
        }
        
        // For all other URLs, create a new tab
        console.log('Non-chat/auth URL in new-window event, creating new tab');
        createNewTab(e.url);
    });
    
    // Set up console message listener for debugging
    webview.addEventListener('console-message', (e) => {
        console.log(`[Webview ${tabId}]: ${e.message}`);
    });
    
    // Update favicon initially
    updateTabFavicon(tabId, url);
    
    // Add tab object to tabs array
    const tab = {
        id: tabId,
        element: tabElement,
        container: webviewContainer,
        webview: webview,
        currentUrl: url || 'https://my.onereach.ai/',
        isReady: () => webviewReady,
        checkSession: () => {
            // Test session isolation by checking local storage and session info
        webview.executeJavaScript(`
            (function() {
                    try {
                        // Check various authentication indicators
                        const localStorageKeys = Object.keys(localStorage);
                        const sessionStorageKeys = Object.keys(sessionStorage);
                        
                        // Look for OneReach-specific auth tokens
                        const authToken = localStorage.getItem('authToken') || 
                                        localStorage.getItem('access_token') ||
                                        localStorage.getItem('idToken');
                        
                        // Check if user is logged in based on page content
                        const isLoginPage = window.location.href.includes('login') || 
                                          window.location.href.includes('auth');
                        
                        // Check for user info in localStorage
                        const userInfo = localStorage.getItem('user') || 
                                       localStorage.getItem('userInfo') ||
                                       localStorage.getItem('currentUser');
                        
                        return {
                            url: window.location.href,
                            partition: '${partitionName}',
                            cookies: document.cookie || 'No cookies',
                            hasAuthToken: !!authToken,
                            isLoginPage: isLoginPage,
                            hasUserInfo: !!userInfo,
                            localStorageItemCount: localStorageKeys.length,
                            sessionStorageItemCount: sessionStorageKeys.length,
                            // Sample some localStorage keys (first 5)
                            sampleLocalStorageKeys: localStorageKeys.slice(0, 5).join(', ') || 'None'
                        };
                    } catch (error) {
                        return {
                            error: error.message,
                            url: window.location.href,
                            partition: '${partitionName}'
                        };
                    }
                })();
            `).then(result => {
                console.log(`\nTab ${tabId} Session Info:`);
                console.log(`- Partition: ${result.partition}`);
                console.log(`- URL: ${result.url}`);
                console.log(`- Has Auth Token: ${result.hasAuthToken || false}`);
                console.log(`- Is Login Page: ${result.isLoginPage || false}`);
                console.log(`- Has User Info: ${result.hasUserInfo || false}`);
                console.log(`- LocalStorage Items: ${result.localStorageItemCount || 0}`);
                console.log(`- SessionStorage Items: ${result.sessionStorageItemCount || 0}`);
                console.log(`- Sample Keys: ${result.sampleLocalStorageKeys || 'None'}`);
                console.log(`- Cookies: ${result.cookies}`);
                if (result.error) {
                    console.log(`- Error: ${result.error}`);
                }
            }).catch(err => {
                console.error(`Error checking session for tab ${tabId}:`, err);
            });
        }
    };
    tabs.push(tab);
    
    // Activate the newly created tab
    activateTab(tabId);
    
    // If URL was provided, make sure it's the one being loaded
    if (url && url !== 'https://my.onereach.ai/') {
        // Make sure the tab has initialized before navigating
        if (webviewReady) {
            webview.src = url;
        }
    }
    
    return tab;
}

// Activate a tab by ID
function activateTab(tabId) {
    // Deactivate current active tab
    tabs.forEach(tab => {
        tab.element.classList.remove('active');
        tab.container.classList.remove('active');
    });
    
    // Activate the requested tab
    const tab = tabs.find(t => t.id === tabId);
    if (tab) {
        tab.element.classList.add('active');
        tab.container.classList.add('active');
        activeTabId = tabId;
        
        // Update navigation button states if webview is ready
        if (tab.isReady()) {
            updateNavigationState(tabId);
        }
        
        // Save tab state when active tab changes
        saveTabState();
    }
}

// Function to update navigation state (back/forward buttons)
function updateNavigationState(tabId) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) {
        console.log(`Cannot update navigation state - tab ${tabId} not found`);
        return;
    }
    
    const backButton = document.getElementById('back-button');
    const forwardButton = document.getElementById('forward-button');
    
    try {
        console.log(`Updating navigation state for tab ${tabId}`);
        
        // Safely check navigation state
        let canGoBack = false;
        let canGoForward = false;
        
        try {
            // Try to get navigation state even if webview isn't fully ready
            canGoBack = tab.webview.canGoBack();
            canGoForward = tab.webview.canGoForward();
        } catch (error) {
            console.warn(`Could not determine navigation state for ${tabId}, assuming false:`, error);
            // Keep default false values
        }
        
        console.log(`Navigation state: canGoBack=${canGoBack}, canGoForward=${canGoForward}`);
        
        // Update UI based on navigation state
        if (canGoBack) {
            backButton.classList.add('active');
        } else {
            backButton.classList.remove('active');
        }
        
        if (canGoForward) {
            forwardButton.classList.add('active');
        } else {
            forwardButton.classList.remove('active');
        }
    } catch (error) {
        console.error('Error updating navigation state:', error);
        // Ensure buttons are in a valid state even if there's an error
        backButton.classList.remove('active');
        forwardButton.classList.remove('active');
    }
}

// Close a tab by ID
function closeTab(tabId) {
    const tabIndex = tabs.findIndex(t => t.id === tabId);
    if (tabIndex !== -1) {
        const tab = tabs[tabIndex];
        
        // Remove DOM elements
        tab.element.remove();
        tab.container.remove();
        
        // Remove from tabs array
        tabs.splice(tabIndex, 1);
        
        // If this was the active tab, activate another one
        if (activeTabId === tabId) {
            if (tabs.length > 0) {
                // Prefer the tab to the right, otherwise the one to the left
                const newActiveTab = tabs[tabIndex] || tabs[tabIndex - 1];
                activateTab(newActiveTab.id);
            } else {
                // No tabs left, create a new one
                createNewTab();
            }
        }
        
        // Save tab state after closing a tab
        saveTabState();
    }
}

// Debug function to check session isolation
function debugSessionIsolation() {
    console.log('=== Debugging Session Isolation ===');
    tabs.forEach((tab, index) => {
        console.log(`\nTab ${index} (${tab.id}):`);
        console.log(`- URL: ${tab.webview.src}`);
        console.log(`- Partition attribute: ${tab.webview.getAttribute('partition')}`);
        console.log(`- Partition property: ${tab.webview.partition}`);
        console.log(`- WebContentsId: ${tab.webview.getWebContentsId ? tab.webview.getWebContentsId() : 'N/A'}`);
        
        // Check session details
        if (tab.checkSession) {
            tab.checkSession();
        }
        
        // Additional check: look for OneReach-specific data
        tab.webview.executeJavaScript(`
            (function() {
                const oneReachData = {};
                
                // Check for OneReach-specific localStorage items
                for (let key in localStorage) {
                    if (key.includes('onereach') || key.includes('idToken') || key.includes('auth')) {
                        oneReachData[key] = localStorage[key];
                    }
                }
                
                // Check cookies
                const cookies = document.cookie.split(';').map(c => c.trim());
                const authCookies = cookies.filter(c => 
                    c.includes('auth') || c.includes('token') || c.includes('session')
                );
                
                // Check current user context
                const userContext = {
                    windowLocation: window.location.href,
                    documentTitle: document.title,
                    hasChat: !!document.querySelector('[class*="chat"]'),
                    hasMessages: !!document.querySelector('[class*="message"]')
                };
                
                return {
                    oneReachData: oneReachData,
                    authCookies: authCookies,
                    userContext: userContext
                };
            })();
        `).then(result => {
            console.log(`  OneReach Data:`, result.oneReachData);
            console.log(`  Auth Cookies:`, result.authCookies);
            console.log(`  User Context:`, result.userContext);
        }).catch(err => {
            console.error(`  Error checking OneReach data:`, err);
        });
    });
    console.log('=== End Debug ===');
}

// Add keyboard shortcut for debugging - add to both window and document
const debugShortcutHandler = (e) => {
    // Ctrl/Cmd + Shift + D for debug
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'D') {
        e.preventDefault();
        console.log('Debug shortcut triggered!');
        debugSessionIsolation();
    }
};

// Add to window to capture even when webview has focus
window.addEventListener('keydown', debugShortcutHandler, true);
document.addEventListener('keydown', debugShortcutHandler, true);

// Add "Start Fresh" hotkey - Ctrl/Cmd + Shift + R
window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'R') {
        e.preventDefault();
        console.log('Start Fresh hotkey triggered!');
        
        // Confirm with user
        const confirmed = confirm('This will clear ALL data and cookies. Continue?');
        if (confirmed) {
            // Clear all localStorage
            localStorage.clear();
            
            // Ask main process to wipe all partitions
            window.api.send('wipe-all-partitions');
            
            // Show feedback
            console.log('✅ All data cleared. Reloading...');
            
            // Reload after a short delay
            setTimeout(() => {
                window.location.reload();
            }, 100);
        }
    }
}, true);

// Navigate the active tab to a URL
function navigateToUrl(url) {
    if (activeTabId) {
        const tab = tabs.find(t => t.id === activeTabId);
        if (tab && tab.isReady()) {
            // If URL doesn't start with a protocol, assume http
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                url = 'https://' + url;
            }
            
            tab.webview.src = url;
            
            // Save tab state after navigation
            saveTabState();
        }
    }
}

// Handle chat URLs specifically in the current tab
function handleChatUrl(url) {
    console.log('Handling chat URL in current tab:', url);
    if (activeTabId) {
        const tab = tabs.find(t => t.id === activeTabId);
        if (tab && tab.isReady()) {
            tab.webview.src = url;
            
            // Save tab state after handling chat URL
            saveTabState();
        }
    }
}

// Check tab authentication status
function checkTabAuthentication(tabId, webview) {
    console.log(`Manually checking authentication for tab ${tabId}`);
    
    webview.executeJavaScript(`
        (function() {
            // Check if we're on a login page or need authentication
            const isLoginPage = window.location.href.includes('/login') || 
                              window.location.href.includes('/auth') ||
                              document.querySelector('input[type="password"]') !== null;
            
            // Check for common login/auth UI elements
            const hasLoginForm = document.querySelector('form[action*="login"]') !== null ||
                               document.querySelector('button[type="submit"]') !== null;
            
            // Check page content for login keywords
            const bodyText = document.body ? document.body.innerText.toLowerCase() : '';
            const hasLoginKeywords = bodyText.includes('sign in') || 
                                   bodyText.includes('log in') ||
                                   bodyText.includes('login') ||
                                   bodyText.includes('password');
            
            // Check if we have any content that suggests we're authenticated
            const hasAuthenticatedContent = document.querySelector('.chat-interface') !== null ||
                                          document.querySelector('[class*="message"]') !== null ||
                                          document.querySelector('[class*="chat"]') !== null ||
                                          document.querySelector('iframe[src*="chat"]') !== null;
            
            // Check for empty or minimal content (common when not authenticated)
            const isEmptyPage = !document.body || 
                              document.body.innerText.trim().length < 50 ||
                              document.body.children.length < 3;
            
            // Check for OneReach-specific elements that indicate authentication
            const hasOneReachChat = document.querySelector('[id*="onereach"]') !== null ||
                                  document.querySelector('[class*="onereach"]') !== null ||
                                  window.OneReach !== undefined;
            
            // For OneReach chat URLs, if the page is empty or minimal, it likely needs auth
            const isOneReachChatUrl = window.location.href.includes('chat.') && 
                                    window.location.href.includes('.onereach.ai');
            
            const needsAuth = (isLoginPage || hasLoginForm || hasLoginKeywords || 
                             (isOneReachChatUrl && isEmptyPage && !hasAuthenticatedContent)) && 
                             !hasAuthenticatedContent;
            
            return {
                needsAuth: needsAuth,
                currentUrl: window.location.href,
                title: document.title,
                bodyLength: document.body ? document.body.innerText.length : 0,
                hasAuthenticatedContent: hasAuthenticatedContent,
                isEmptyPage: isEmptyPage,
                isOneReachChatUrl: isOneReachChatUrl
            };
        })();
    `).then(authCheck => {
        console.log(`Tab ${tabId} auth check:`, authCheck);
        console.log(`- needsAuth: ${authCheck.needsAuth}`);
        console.log(`- currentUrl: ${authCheck.currentUrl}`);
        console.log(`- title: ${authCheck.title}`);
        console.log(`- bodyLength: ${authCheck.bodyLength}`);
        console.log(`- hasAuthenticatedContent: ${authCheck.hasAuthenticatedContent}`);
        console.log(`- isEmptyPage: ${authCheck.isEmptyPage}`);
        console.log(`- isOneReachChatUrl: ${authCheck.isOneReachChatUrl}`);
        
        if (authCheck.needsAuth) {
            console.log(`Tab ${tabId} needs authentication`);
            
            // REMOVED: Authentication overlay popup
            // The overlay was showing an annoying popup, so it's been disabled
            /*
            // Inject a helpful message
            webview.executeJavaScript(`
                (function() {
                    // Remove any existing overlay
                    const existingOverlay = document.getElementById('auth-required-overlay');
                    if (existingOverlay) existingOverlay.remove();
                    
                    // Create a helpful overlay
                    const overlay = document.createElement('div');
                    overlay.id = 'auth-required-overlay';
                    overlay.style.cssText = \`
                        position: fixed;
                        top: 50%;
                        left: 50%;
                        transform: translate(-50%, -50%);
                        background: #2a2a2a;
                        color: white;
                        padding: 30px;
                        border-radius: 10px;
                        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
                        z-index: 99999;
                        text-align: center;
                        max-width: 400px;
                    \`;
                    
                    overlay.innerHTML = \`
                        <h2 style="margin: 0 0 15px 0; color: #4CAF50;">Authentication Required</h2>
                        <p style="margin: 0 0 20px 0; line-height: 1.5;">
                            To access this chat, please first navigate to your IDW environment 
                            using the <strong>+</strong> menu in the tab bar.
                        </p>
                        <p style="margin: 0 0 20px 0; font-size: 14px; opacity: 0.8;">
                            Each tab has its own login session for security.
                        </p>
                        <button onclick="this.parentElement.remove()" style="
                            background: #4CAF50;
                            color: white;
                            border: none;
                            padding: 10px 20px;
                            border-radius: 5px;
                            cursor: pointer;
                            font-size: 16px;
                        ">Got it</button>
                    \`;
                    
                    document.body.appendChild(overlay);
                    
                    // Auto-remove after 10 seconds
                    setTimeout(() => {
                        if (overlay.parentElement) {
                            overlay.remove();
                        }
                    }, 10000);
                })();
            `).catch(err => console.error('Error showing auth message:', err));
            */
        } else {
            console.log(`Tab ${tabId} appears to be authenticated`);
        }
    }).catch(err => {
        console.error(`Error checking auth state for tab ${tabId}:`, err);
    });
}

// Create a new tab with the given URL (or default to new tab page)
function createNewTab(url = 'https://my.onereach.ai/') {
    // DISABLED: Don't prevent creating new tabs for chat URLs
    // Each chat URL should be allowed to open in its own tab
    /*
    // First check if this URL is already open
    if (url !== 'https://my.onereach.ai/' && findAndFocusTab(url)) {
        console.log('URL already open in a tab, focusing it instead of creating new tab');
        return null;
    }
    */
    
    return createNewTabWithPartition(url, null);
}

// Create a new tab specifically for ChatGPT with enhanced permissions
function createChatGPTTab(url, label = 'ChatGPT') {
    // For now, just create a regular tab - we can enhance this later if needed
    return createNewTabWithPartition(url, null);
}

// Find and focus a tab with the given URL, returns true if found
function findAndFocusTab(url) {
    // Disable duplicate prevention for OneReach chat URLs
    if (url.includes('/chat/') || (url.includes('chat.') && url.includes('.onereach.ai'))) {
        return false; // Always allow new chat tabs
    }
    console.log('Looking for existing tab with URL:', url);
    
    // Normalize the URL for comparison
    let normalizedSearchUrl;
    try {
        const searchUrl = new URL(url);
        normalizedSearchUrl = searchUrl.origin + searchUrl.pathname + searchUrl.search;
    } catch (e) {
        normalizedSearchUrl = url;
    }
    
    // Check each tab
    for (const tab of tabs) {
        if (tab.webview && tab.webview.src) {
            try {
                const tabUrl = new URL(tab.webview.src);
                const normalizedTabUrl = tabUrl.origin + tabUrl.pathname + tabUrl.search;
                
                // Compare normalized URLs (ignoring hash/fragment)
                if (normalizedTabUrl === normalizedSearchUrl) {
                    console.log(`Found existing tab ${tab.id} with matching URL`);
                    activateTab(tab.id);
                    
                    // Add a brief highlight effect to show which tab was focused
                    tab.element.style.transition = 'background-color 0.3s ease';
                    tab.element.style.backgroundColor = '#4CAF50';
                    setTimeout(() => {
                        tab.element.style.backgroundColor = '';
                    }, 300);
                    
                    return true;
                }
            } catch (e) {
                // If URL parsing fails, do simple comparison
                if (tab.webview.src === url) {
                    console.log(`Found existing tab ${tab.id} with exact URL match`);
                    activateTab(tab.id);
                    
                    // Add a brief highlight effect
                    tab.element.style.transition = 'background-color 0.3s ease';
                    tab.element.style.backgroundColor = '#4CAF50';
                    setTimeout(() => {
                        tab.element.style.backgroundColor = '';
                    }, 300);
                    
                    return true;
                }
            }
        }
    }
    
    console.log('No existing tab found with URL:', url);
    return false;
} 