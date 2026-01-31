// Helper to extract the "Featured image courtesy:" block from the RSS content using DOM parsing.
function extractAuthorBlock(content) {
    if (!content) return null;
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = content;
    // Get all paragraph elements
    const paragraphs = Array.from(tempDiv.querySelectorAll('p'));
    // Filter paragraphs that contain an <em> element with the text "Featured image courtesy:"
    const matchingParagraphs = paragraphs.filter(p => {
         const em = p.querySelector('em');
         return em && em.textContent.toLowerCase().includes('featured image courtesy:');
    });
    if (matchingParagraphs.length > 0) {
         // Return the last matching paragraph
         console.log("DEBUG: extractAuthorBlock found matching paragraph:", matchingParagraphs[matchingParagraphs.length - 1].outerHTML);
         return matchingParagraphs[matchingParagraphs.length - 1].outerHTML;
    }
    console.log("DEBUG: extractAuthorBlock no matching paragraph found.");
    return null;
}

// Helper to extract the second-to-last <p> element (which should contain the author info) from the RSS content.
function extractLastParagraph(content) {
    if (!content) return null;
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = content;
    const paragraphs = tempDiv.querySelectorAll('p');
    console.log("DEBUG: extractLastParagraph - found", paragraphs.length, "paragraph(s)");
    if (paragraphs && paragraphs.length > 1) {
        console.log("DEBUG: extractLastParagraph - second-to-last paragraph:", paragraphs[paragraphs.length - 2].outerHTML);
        return paragraphs[paragraphs.length - 2].outerHTML;
    } else if (paragraphs && paragraphs.length === 1) {
        console.log("DEBUG: extractLastParagraph - only one paragraph available:", paragraphs[0].outerHTML);
        return paragraphs[0].outerHTML;
    }
    return null;
}

class FlipboardReader {
    constructor() {
        console.log('🚀🚀🚀 FLIPBOARD READER CONSTRUCTOR CALLED 🚀🚀🚀');
        console.log('🔥 READING TIME FIX IS ACTIVE 🔥');
        this.grid = document.querySelector('.grid');
        this.loadingSpinner = document.querySelector('.loading-spinner');
        this.articleViewer = document.querySelector('.article-viewer');
        this.articleOverlay = document.querySelector('.article-overlay');
        
        // Initialize with empty data
        this.items = [];
        
        // Add default logos back
        this.defaultLogos = {
            'uxmag.com': 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgZmlsbD0iIzFhMWExYSIvPjx0ZXh0IHg9IjEwMCIgeT0iMTAwIiBmb250LWZhbWlseT0iQXJpYWwiIGZvbnQtc2l6ZT0iMjQiIGZpbGw9IiNmZmZmZmYiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGFsaWdubWVudC1iYXNlbGluZT0ibWlkZGxlIj5VWCBNYWC8L3RleHQ+PC9zdmc+',
            'onereach.ai': 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgZmlsbD0iIzFhMWExYSIvPjx0ZXh0IHg9IjEwMCIgeT0iMTAwIiBmb250LWZhbWlseT0iQXJpYWwiIGZvbnQtc2l6ZT0iMjQiIGZpbGw9IiM0YmVhNWEiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGFsaWdubWVudC1iYXNlbGluZT0ibWlkZGxlIj5PbmVSZWFjaDwvdGV4dD48L3N2Zz4=',
            'default': 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgZmlsbD0iIzFhMWExYSIvPjx0ZXh0IHg9IjEwMCIgeT0iMTAwIiBmb250LWZhbWlseT0iQXJpYWwiIGZvbnQtc2l6ZT0iMTQiIGZpbGw9IiNmZmZmZmYiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGFsaWdubWVudC1iYXNlbGluZT0ibWlkZGxlIj5ObyBJbWFnZTwvdGV4dD48L3N2Zz4='
        };

        this.setupEventListeners();
        this.setupArticleViewer();
        
        // Add request tracking
        this.lastRequestTime = 0;
        this.REQUEST_COOLDOWN = 1000; // 1 second between requests
        
        // Playlist state
        this.playlist = [];
        this.playlistQueue = []; // Articles checked for listening
        this.currentPlaylistIndex = -1;
        this.currentlyPlayingArticle = null;
        this.currentlyPlayingPlayer = null;
        this.isPlaylistPlaying = false;
        this.playlistBuilt = false;
        
        // Track Blob URLs for cleanup (prevent memory leaks)
        this.currentAudioBlobUrl = null;
        
        // Initialize RSS data handling and playlist bar
        this.initializeRSSHandling();
    }
    
    // Helper to set audio source and clean up old Blob URLs
    setAudioSource(audioPlayer, blob) {
        // Revoke old Blob URL to prevent memory leak
        if (this.currentAudioBlobUrl) {
            console.log('[Memory] 🗑️ Revoking old Blob URL');
            URL.revokeObjectURL(this.currentAudioBlobUrl);
        }
        // Create new Blob URL
        this.currentAudioBlobUrl = URL.createObjectURL(blob);
        audioPlayer.src = this.currentAudioBlobUrl;
        
        // Log memory usage
        if (performance.memory) {
            const usedMB = Math.round(performance.memory.usedJSHeapSize / 1024 / 1024);
            console.log(`[Memory] 📊 Heap: ${usedMB} MB (after setting audio source)`);
        }
    }
    
    // Cleanup method for when audio is done
    cleanupAudioBlobUrl() {
        if (this.currentAudioBlobUrl) {
            console.log('[Memory] 🧹 Cleaning up audio Blob URL');
            URL.revokeObjectURL(this.currentAudioBlobUrl);
            this.currentAudioBlobUrl = null;
        }
    }
    
    // Log current memory usage (call from console: window.reader.logMemory())
    logMemory() {
        if (performance.memory) {
            const used = Math.round(performance.memory.usedJSHeapSize / 1024 / 1024);
            const total = Math.round(performance.memory.totalJSHeapSize / 1024 / 1024);
            console.log(`[Memory] 📊 Used: ${used} MB / Total: ${total} MB`);
            return { used, total };
        }
        console.log('[Memory] ⚠️ performance.memory not available');
        return null;
    }
    
    // Initialize RSS data handling and playlist bar (called from constructor)
    initializeRSSHandling() {
        // Setup playlist bar when DOM is ready
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.setupPlaylistBar());
        } else {
            this.setupPlaylistBar();
        }
        
        // Listen for RSS data if the API is available
        if (window.flipboardAPI && typeof window.flipboardAPI.onRSSData === 'function') {
            window.flipboardAPI.onRSSData((data) => {
                // Check if this request is too soon after the last one
                const now = Date.now();
                if (now - this.lastRequestTime < this.REQUEST_COOLDOWN) {
                    console.log('Request too soon, skipping...');
                    return;
                }
                this.lastRequestTime = now;

                console.log('Received RSS data:', data);
                if (data && data.items) {
                    // Store the data
                    this.items = data.items;
                    
                    // Handle the data with debounce
                    if (this.rssDataDebounceTimer) {
                        clearTimeout(this.rssDataDebounceTimer);
                    }
                    
                    // Determine if this is cached data
                    const isCached = data.fromCache === true;
                    
                    // Use a single debounce timer for both cached and fresh data
                    this.rssDataDebounceTimer = setTimeout(() => {
                        if (isCached) {
                            console.log('Loading from cache...');
                        } else {
                            console.log('Processing fresh data...');
                        }
                        this._handleRSSData(data, isCached);
                    }, isCached ? 0 : 1000); // No delay for cached, 1s delay for fresh
                }
            });
        } else {
            console.warn('RSS data API not available, falling back to direct feed loading');
            // Load both feeds directly
            this.loadMultipleFeeds();
        }

        // Add flag to track if we're currently processing RSS data
        this.isProcessingRSS = false;
        
        // Add processed items tracking
        this.processedItems = new Set();
        
        // Add debounce timer
        this.rssDataDebounceTimer = null;

        // Add image cache
        this.imageCache = new Map();
        this.loadImageCache();
        
        // Add article content cache for faster TTS and offline reading
        this.articleCache = new Map();
        this.loadArticleCache();

        // Initialize reading log to track cumulative seconds read per article.
        this.readingLog = {};
        // Load the reading log immediately when the reader starts
        this.loadReadingLog().then(() => {
            console.log('Initial reading log loaded:', this.readingLog);
            // Update all existing tiles if they're already rendered
            if (this.items) {
                this.items.forEach(item => this.updateReadingProgress(item));
            }
        });

        // Ensure that when the app is closed or reloaded,
        // any running reading timer is stopped and the reading log is persisted.
        window.addEventListener('beforeunload', () => {
            console.log('App is unloading (beforeunload); stopping reading timer and saving reading log.');
            this.stopReadingTimer();
        });
        // Add an additional unload event listener as a fallback
        window.addEventListener('unload', () => {
            console.log('App is unloading (unload event); stopping reading timer and saving reading log.');
            this.stopReadingTimer();
        });

        // Set up listener for reading time updates from main process
        if (window.flipboardAPI && window.flipboardAPI.onReadingTimeUpdate) {
            window.flipboardAPI.onReadingTimeUpdate((data) => {
                console.log('🔥 RECEIVED READING TIME UPDATE IN RENDERER:', data);
                this.updateTileReadingTime(data.url, data.readingTime);
            });
        }
    }

    // ==================== PLAYLIST MANAGEMENT ====================
    
    setupPlaylistBar() {
        console.log('[Playlist] setupPlaylistBar called, readyState:', document.readyState);
        
        const playPauseBtn = document.getElementById('playlistPlayPause');
        const prevBtn = document.getElementById('playlistPrev');
        const nextBtn = document.getElementById('playlistNext');
        const toggleBtn = document.getElementById('playlistToggle');
        const progressBar = document.querySelector('.playlist-progress');
        const selectAllBtn = document.getElementById('playlistSelectAll');
        
        console.log('[Playlist] Elements found - toggleBtn:', !!toggleBtn, 'playPauseBtn:', !!playPauseBtn);
        const deselectAllBtn = document.getElementById('playlistDeselectAll');
        
        // Play/Pause button
        if (playPauseBtn) {
            playPauseBtn.addEventListener('click', () => this.togglePlaylistPlayback());
        }
        
        // Previous button
        if (prevBtn) {
            prevBtn.addEventListener('click', () => this.playPreviousInPlaylist());
        }
        
        // Next button
        if (nextBtn) {
            nextBtn.addEventListener('click', () => this.playNextInPlaylist());
        }
        
        // Toggle playlist panel - make both button and the entire queue toggle area clickable
        const queueToggleArea = document.querySelector('.playlist-queue-toggle');
        
        if (toggleBtn) {
            console.log('[Playlist] Toggle button found, adding click handler');
            toggleBtn.addEventListener('click', (e) => {
                console.log('[Playlist] Toggle button clicked!');
                e.stopPropagation();
                this.togglePlaylistPanel();
            });
        } else {
            console.error('[Playlist] Toggle button NOT found!');
        }
        
        // Also make the entire queue area clickable
        if (queueToggleArea) {
            console.log('[Playlist] Queue toggle area found, adding click handler');
            queueToggleArea.addEventListener('click', (e) => {
                // Only trigger if not clicking the button itself (to avoid double trigger)
                if (e.target !== toggleBtn && !toggleBtn?.contains(e.target)) {
                    console.log('[Playlist] Queue area clicked!');
                    this.togglePlaylistPanel();
                }
            });
        }
        
        // Progress bar seek
        if (progressBar) {
            progressBar.addEventListener('click', (e) => {
                if (this.currentlyPlayingPlayer && this.currentlyPlayingPlayer.duration) {
                    const rect = progressBar.getBoundingClientRect();
                    const clickPosition = (e.clientX - rect.left) / rect.width;
                    this.currentlyPlayingPlayer.currentTime = clickPosition * this.currentlyPlayingPlayer.duration;
                }
            });
        }
        
        // Select/Deselect all
        if (selectAllBtn) {
            selectAllBtn.addEventListener('click', () => this.selectAllPlaylist(true));
        }
        if (deselectAllBtn) {
            deselectAllBtn.addEventListener('click', () => this.selectAllPlaylist(false));
        }
        
        // Save state when window is closed or hidden
        window.addEventListener('beforeunload', () => {
            if (this.currentlyPlayingPlayer && this.currentlyPlayingArticle) {
                console.log('[Playlist] Saving state before unload');
                this.savePlaylistState();
            }
        });
        
        // Also save when visibility changes (e.g., switching tabs or minimizing)
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden' && this.currentlyPlayingPlayer && this.currentlyPlayingArticle) {
                console.log('[Playlist] Saving state on visibility change');
                this.savePlaylistState();
            }
        });
        
        console.log('[Playlist] Bar initialized');
    }
    
    buildPlaylist() {
        console.log('[Playlist] ====== buildPlaylist called ======');
        console.log('[Playlist] this.items count:', this.items?.length || 0);
        
        // Build playlist from items (newest first based on pubDate)
        if (!this.items || this.items.length === 0) {
            console.log('[Playlist] ERROR: No items to build playlist from');
            return;
        }
        
        // Filter to only include unread/unlistened articles
        const unreadItems = this.items.filter(item => {
            const normalizedUrl = this.normalizeUrl(item.link);
            const isRead = this.readArticles && this.readArticles.has(item.link);
            const readingLogEntry = this.readingLog[normalizedUrl];
            const isListened = readingLogEntry && readingLogEntry.listenCompleted;
            
            // Include if NOT read AND NOT fully listened
            return !isRead && !isListened;
        });
        
        console.log('[Playlist] Unread/unlistened items:', unreadItems.length, 'of', this.items.length);
        
        // Sort by date (newest first)
        const sortedItems = [...unreadItems].sort((a, b) => {
            const dateA = new Date(a.pubDate || 0);
            const dateB = new Date(b.pubDate || 0);
            return dateB - dateA;
        });
        
        console.log('[Playlist] Sorted unread items count:', sortedItems.length);
        if (sortedItems.length > 0) {
            console.log('[Playlist] First unread item:', sortedItems[0]?.title);
        }
        
        this.playlist = sortedItems.map((item, index) => ({
            id: this.normalizeUrl(item.link),
            title: item.title,
            link: item.link,
            source: item.source || 'Unknown',
            pubDate: item.pubDate,
            checked: true, // All unread items are checked by default
            hasAudio: false, // Will be updated when checked
            index: index
        }));
        
        console.log('[Playlist] Playlist created with', this.playlist.length, 'unread items');
        
        // Update queue based on checked items
        this.updatePlaylistQueue();
        
        // Render playlist items
        console.log('[Playlist] Rendering playlist items...');
        this.renderPlaylistItems();
        
        // Update queue count
        this.updateQueueCount();
        
        console.log(`[Playlist] ====== Playlist build complete: ${this.playlist.length} unread items in queue ======`);
    }
    
    renderPlaylistItems() {
        const container = document.getElementById('playlistItems');
        console.log('[Playlist] renderPlaylistItems - container found:', !!container);
        if (!container) {
            console.error('[Playlist] ERROR: playlistItems container not found!');
            return;
        }
        
        container.innerHTML = '';
        console.log('[Playlist] Rendering', this.playlist.length, 'items to container');
        
        this.playlist.forEach((item, index) => {
            const itemEl = document.createElement('div');
            itemEl.className = 'playlist-item';
            if (this.currentPlaylistIndex === index) {
                itemEl.classList.add('current');
            }
            itemEl.dataset.id = item.id;
            
            itemEl.innerHTML = `
                <input type="checkbox" class="playlist-item-checkbox" ${item.checked ? 'checked' : ''}>
                <span class="playlist-item-number">${index + 1}</span>
                <div class="playlist-item-info">
                    <div class="playlist-item-title" title="${item.title}">${item.title}</div>
                    <div class="playlist-item-meta">
                        <span>${item.source}</span>
                        <span>${item.pubDate ? new Date(item.pubDate).toLocaleDateString() : ''}</span>
                    </div>
                </div>
                <span class="playlist-item-status ${item.hasAudio ? 'ready' : ''}">${item.hasAudio ? '✓ Ready' : ''}</span>
            `;
            
            // Checkbox change handler
            const checkbox = itemEl.querySelector('.playlist-item-checkbox');
            checkbox.addEventListener('change', (e) => {
                e.stopPropagation();
                item.checked = checkbox.checked;
                this.updatePlaylistQueue();
                this.updateQueueCount();
                this.savePlaylistPreferences();
            });
            
            // Click to play
            itemEl.addEventListener('click', (e) => {
                if (e.target.type === 'checkbox') return;
                this.playPlaylistItem(index);
            });
            
            container.appendChild(itemEl);
        });
    }
    
    updatePlaylistQueue() {
        this.playlistQueue = this.playlist
            .map((item, index) => ({ ...item, originalIndex: index }))
            .filter(item => item.checked);
        console.log('[Playlist] Queue updated:', this.playlistQueue.length, 'items checked');
    }
    
    updateQueueCount() {
        const countEl = document.getElementById('playlistQueueCount');
        console.log('[Playlist] Updating queue count, element found:', !!countEl, 'queue length:', this.playlistQueue.length);
        if (countEl) {
            const count = this.playlistQueue.length;
            countEl.textContent = `${count} in queue`;
            console.log('[Playlist] Queue count display updated to:', count);
        }
    }
    
    togglePlaylistPanel() {
        console.log('[Playlist] togglePlaylistPanel called');
        
        // Use the existing preferences panel with the playlist tab
        const panel = document.getElementById('preferencesPanel');
        if (!panel) {
            console.error('[Playlist] Preferences panel not found!');
            return;
        }
        
        // If panel is already open with playlist tab, close it
        if (panel.classList.contains('show')) {
            const playlistTab = document.querySelector('.panel-tab[data-tab="playlist"]');
            if (playlistTab && playlistTab.classList.contains('active')) {
                panel.classList.remove('show');
                return;
            }
        }
        
        // Switch to playlist tab
        this.switchPanelTab('playlist');
        
        // Open the panel
        panel.classList.add('show');
        
        // Populate the playlist tab
        this.populatePlaylistTab();
    }
    
    switchPanelTab(tabName) {
        console.log('[Playlist] switchPanelTab called with:', tabName);
        
        // Update tab buttons
        const tabs = document.querySelectorAll('.panel-tab');
        console.log('[Playlist] Found', tabs.length, 'tab buttons');
        tabs.forEach(tab => {
            const isActive = tab.dataset.tab === tabName;
            tab.classList.toggle('active', isActive);
            console.log('[Playlist] Tab:', tab.dataset.tab, 'active:', isActive);
        });
        
        // Update tab content
        const contents = document.querySelectorAll('.tab-content');
        console.log('[Playlist] Found', contents.length, 'tab contents');
        contents.forEach(content => {
            const targetId = `${tabName}Tab`;
            const isActive = content.id === targetId;
            content.classList.toggle('active', isActive);
            console.log('[Playlist] Content:', content.id, 'looking for:', targetId, 'active:', isActive);
        });
    }
    
    populatePlaylistTab() {
        const container = document.getElementById('playlistTabItems');
        if (!container) {
            console.error('[Playlist] Playlist tab container not found!');
            return;
        }
        
        const playlist = this.playlist || [];
        console.log('[Playlist] Populating playlist tab with', playlist.length, 'items');
        
        container.innerHTML = '';
        
        if (playlist.length === 0) {
            container.innerHTML = `
                <div class="playlist-empty">
                    <div class="playlist-empty-icon">🎉</div>
                    <p>No unread articles in queue.</p>
                    <p style="font-size: 12px; margin-top: 10px;">New articles will appear here automatically.</p>
                </div>
            `;
            return;
        }
        
        playlist.forEach((item, index) => {
            const itemEl = document.createElement('div');
            itemEl.className = 'playlist-item' + (this.currentPlaylistIndex === index ? ' playing' : '');
            itemEl.innerHTML = `
                <input type="checkbox" class="playlist-item-checkbox" ${item.checked !== false ? 'checked' : ''} data-index="${index}">
                <span class="playlist-item-number">${index + 1}</span>
                <div class="playlist-item-info">
                    <div class="playlist-item-title">${item.title}</div>
                    <div class="playlist-item-meta">${item.source || 'Unknown'} • ${item.pubDate ? new Date(item.pubDate).toLocaleDateString() : ''}</div>
                </div>
            `;
            
            // Checkbox handler
            const checkbox = itemEl.querySelector('.playlist-item-checkbox');
            checkbox.addEventListener('click', (e) => {
                e.stopPropagation();
                this.playlist[index].checked = checkbox.checked;
                this.updateQueueCount();
                this.savePlaylistPreferences();
            });
            
            // Click to play
            itemEl.addEventListener('click', (e) => {
                if (e.target === checkbox) return;
                document.getElementById('preferencesPanel').classList.remove('show');
                this.playPlaylistItem(index);
            });
            
            container.appendChild(itemEl);
        });
    }
    
    selectAllPlaylist(select) {
        this.playlist.forEach(item => {
            item.checked = select;
        });
        this.updatePlaylistQueue();
        this.updateQueueCount();
        this.renderPlaylistItems();
        this.populatePlaylistTab(); // Refresh the tab view
        this.savePlaylistPreferences();
    }
    
    async togglePlaylistPlayback() {
        const playBtn = document.getElementById('playlistPlayPause');
        const playIcon = playBtn?.querySelector('.playlist-play-icon');
        
        if (this.currentlyPlayingPlayer && !this.currentlyPlayingPlayer.paused) {
            // Pause
            this.currentlyPlayingPlayer.pause();
            if (playIcon) playIcon.textContent = '▶';
            this.isPlaylistPlaying = false;
            // Save state immediately when pausing
            this.savePlaylistState();
        } else if (this.currentlyPlayingPlayer && this.currentlyPlayingPlayer.src) {
            // Resume
            this.currentlyPlayingPlayer.play();
            if (playIcon) playIcon.textContent = '⏸';
            this.isPlaylistPlaying = true;
        } else if (this.pendingResumeState) {
            // Resume from saved state (after app restart)
            console.log('[Playlist] Resuming from saved state at', this.pendingResumeState.currentTime, 'seconds');
            const state = this.pendingResumeState;
            
            // Find the item in the playlist
            const itemIndex = this.playlist.findIndex(item => item.link === state.articleLink);
            if (itemIndex >= 0) {
                // Store the resume position for playAudioData to use
                this.resumeFromPosition = state.currentTime;
                await this.playPlaylistItem(itemIndex);
            } else {
                console.log('[Playlist] Could not find article in playlist, starting fresh');
                this.pendingResumeState = null;
                if (this.playlistQueue.length > 0) {
                    await this.playPlaylistItem(this.playlistQueue[0]?.originalIndex || 0);
                }
            }
        } else {
            // Start from beginning or current position
            if (this.playlistQueue.length > 0) {
                const startIndex = this.currentPlaylistIndex >= 0 ? this.currentPlaylistIndex : 0;
                await this.playPlaylistItem(this.playlistQueue[startIndex]?.originalIndex || 0);
            }
        }
    }
    
    async playPlaylistItem(index) {
        if (index < 0 || index >= this.playlist.length) return;
        
        const item = this.playlist[index];
        this.currentPlaylistIndex = index;
        
        // Update UI
        this.updatePlaylistUI(item);
        this.highlightCurrentItem(index);
        
        // Get or generate audio
        await this.loadAndPlayArticle(item);
    }
    
    async loadAndPlayArticle(item) {
        const playBtn = document.getElementById('playlistPlayPause');
        const playIcon = playBtn?.querySelector('.playlist-play-icon');
        const labelEl = document.getElementById('playlistLabel');
        
        // Show loading
        if (playIcon) playIcon.textContent = '⏳';
        if (labelEl) labelEl.textContent = 'Loading...';
        
        try {
            // Check for existing audio
            const existingAudio = await window.flipboardAPI.getArticleTTS(item.id);
            
            if (existingAudio.success && existingAudio.hasAudio) {
                // Use existing audio
                await this.playAudioData(item, existingAudio.audioData);
                item.hasAudio = true;
                this.updateItemStatus(item.id, 'ready');
            } else {
                // Need to generate - trigger tile click or generate here
                if (labelEl) labelEl.textContent = 'Generating audio...';
                this.updateItemStatus(item.id, 'generating');
                
                // Find the tile and trigger its audio generation
                const normalizedUrl = this.normalizeUrl(item.link);
                const tile = document.querySelector(`.tile[data-link="${normalizedUrl}"]`);
                
                if (tile) {
                    const audioBtn = tile.querySelector('.tile-audio-btn');
                    if (audioBtn) {
                        audioBtn.click();
                        // The tile's click handler will generate audio
                        // We'll hook into when it's ready
                        return;
                    }
                }
                
                throw new Error('Could not find article tile to generate audio');
            }
        } catch (error) {
            console.error('[Playlist] Error loading article:', error);
            if (labelEl) labelEl.textContent = 'Error loading';
            if (playIcon) playIcon.textContent = '▶';
            
            // Try next after delay
            setTimeout(() => this.playNextInPlaylist(), 2000);
        }
    }
    
    async playAudioData(item, audioData) {
        const playIcon = document.getElementById('playlistPlayPause')?.querySelector('.playlist-play-icon');
        const labelEl = document.getElementById('playlistLabel');
        
        // Create or reuse audio player
        if (!this.currentlyPlayingPlayer) {
            this.currentlyPlayingPlayer = new Audio();
        }
        
        const audioPlayer = this.currentlyPlayingPlayer;
        audioPlayer.dataset.articleLink = item.link;
        
        // Load audio (with Blob URL cleanup)
        const blob = this.base64ToBlob(audioData, 'audio/mpeg');
        this.setAudioSource(audioPlayer, blob);
        
        // Set up event handlers
        this.setupPlaylistProgress(audioPlayer);
        
        // Wait for load and play
        await new Promise((resolve, reject) => {
            audioPlayer.onloadedmetadata = resolve;
            audioPlayer.onerror = reject;
        });
        
        // Check if we need to resume from a specific position
        if (this.resumeFromPosition && this.resumeFromPosition > 0) {
            console.log('[Playlist] Seeking to saved position:', this.resumeFromPosition, 'seconds');
            audioPlayer.currentTime = this.resumeFromPosition;
            this.resumeFromPosition = null; // Clear after using
            this.pendingResumeState = null; // Clear the pending state
        }
        
        audioPlayer.play();
        
        // Update UI
        if (playIcon) playIcon.textContent = '⏸';
        if (labelEl) labelEl.textContent = 'Now Playing';
        this.isPlaylistPlaying = true;
        
        // Update currently playing
        this.currentlyPlayingArticle = { title: item.title, link: item.link };
        
        // Save state
        this.savePlaylistState();
        
        console.log('[Playlist] Playing:', item.title);
    }
    
    setupPlaylistProgress(audioPlayer) {
        const progressFill = document.getElementById('playlistProgressFill');
        const timeEl = document.getElementById('playlistTime');
        const playIcon = document.getElementById('playlistPlayPause')?.querySelector('.playlist-play-icon');
        
        let lastSaveTime = 0;
        
        const updateProgress = () => {
            if (audioPlayer.duration) {
                const progress = (audioPlayer.currentTime / audioPlayer.duration) * 100;
                if (progressFill) progressFill.style.width = `${progress}%`;
                if (timeEl) timeEl.textContent = `${this.formatTime(audioPlayer.currentTime)} / ${this.formatTime(audioPlayer.duration)}`;
                
                // Update reading log
                const articleLink = audioPlayer.dataset.articleLink;
                if (articleLink && Math.floor(audioPlayer.currentTime) % 5 === 0) {
                    this.updateListenProgress(articleLink, audioPlayer.currentTime, audioPlayer.duration);
                }
                
                // Save state periodically
                const now = Date.now();
                if (now - lastSaveTime > 5000) {
                    lastSaveTime = now;
                    this.savePlaylistState();
                }
            }
        };
        
        const updatePlayState = () => {
            if (playIcon) {
                playIcon.textContent = audioPlayer.paused ? '▶' : '⏸';
            }
        };
        
        const handleEnded = () => {
            // Mark as completed in reading log
            const articleLink = audioPlayer.dataset.articleLink;
            if (articleLink && audioPlayer.duration) {
                this.updateListenProgress(articleLink, audioPlayer.duration, audioPlayer.duration, true);
            }
            
            // Update item status
            if (this.currentPlaylistIndex >= 0) {
                const item = this.playlist[this.currentPlaylistIndex];
                if (item) {
                    this.markItemPlayed(item.id);
                }
            }
            
            // Auto-play next
            this.playNextInPlaylist();
        };
        
        // Remove old listeners
        audioPlayer.removeEventListener('timeupdate', audioPlayer._playlistUpdate);
        audioPlayer.removeEventListener('play', audioPlayer._playlistPlayState);
        audioPlayer.removeEventListener('pause', audioPlayer._playlistPlayState);
        audioPlayer.removeEventListener('ended', audioPlayer._playlistEnded);
        
        // Store and add new listeners
        audioPlayer._playlistUpdate = updateProgress;
        audioPlayer._playlistPlayState = updatePlayState;
        audioPlayer._playlistEnded = handleEnded;
        
        audioPlayer.addEventListener('timeupdate', audioPlayer._playlistUpdate);
        audioPlayer.addEventListener('play', audioPlayer._playlistPlayState);
        audioPlayer.addEventListener('pause', audioPlayer._playlistPlayState);
        audioPlayer.addEventListener('ended', audioPlayer._playlistEnded);
    }
    
    playNextInPlaylist() {
        // Find next checked item
        const currentQueueIndex = this.playlistQueue.findIndex(
            item => item.originalIndex === this.currentPlaylistIndex
        );
        
        if (currentQueueIndex >= 0 && currentQueueIndex < this.playlistQueue.length - 1) {
            const nextItem = this.playlistQueue[currentQueueIndex + 1];
            this.playPlaylistItem(nextItem.originalIndex);
        } else {
            // End of queue
            console.log('[Playlist] End of queue');
            this.isPlaylistPlaying = false;
            const playIcon = document.getElementById('playlistPlayPause')?.querySelector('.playlist-play-icon');
            const labelEl = document.getElementById('playlistLabel');
            if (playIcon) playIcon.textContent = '▶';
            if (labelEl) labelEl.textContent = 'Queue complete';
        }
    }
    
    playPreviousInPlaylist() {
        const currentQueueIndex = this.playlistQueue.findIndex(
            item => item.originalIndex === this.currentPlaylistIndex
        );
        
        if (currentQueueIndex > 0) {
            const prevItem = this.playlistQueue[currentQueueIndex - 1];
            this.playPlaylistItem(prevItem.originalIndex);
        }
    }
    
    updatePlaylistUI(item) {
        const titleEl = document.getElementById('playlistCurrentTitle');
        if (titleEl) {
            titleEl.textContent = item.title;
            titleEl.title = item.title;
        }
    }
    
    highlightCurrentItem(index) {
        const items = document.querySelectorAll('.playlist-item');
        items.forEach((el, i) => {
            el.classList.toggle('current', i === index);
        });
    }
    
    updateItemStatus(itemId, status) {
        const itemEl = document.querySelector(`.playlist-item[data-id="${itemId}"]`);
        if (itemEl) {
            const statusEl = itemEl.querySelector('.playlist-item-status');
            if (statusEl) {
                statusEl.className = `playlist-item-status ${status}`;
                statusEl.textContent = status === 'ready' ? '✓ Ready' : status === 'generating' ? '⏳' : '';
            }
        }
    }
    
    markItemPlayed(itemId) {
        const itemEl = document.querySelector(`.playlist-item[data-id="${itemId}"]`);
        if (itemEl) {
            itemEl.classList.add('played');
        }
    }
    
    // Persistence
    savePlaylistPreferences() {
        try {
            const prefs = this.playlist.map(item => ({
                id: item.id,
                checked: item.checked
            }));
            localStorage.setItem('playlistPreferences', JSON.stringify(prefs));
        } catch (e) {
            console.error('[Playlist] Error saving preferences:', e);
        }
    }
    
    loadPlaylistPreferences() {
        try {
            const saved = localStorage.getItem('playlistPreferences');
            if (saved) {
                const prefs = JSON.parse(saved);
                console.log('[Playlist] Loading saved preferences for', prefs.length, 'items');
                let matchCount = 0;
                prefs.forEach(pref => {
                    const item = this.playlist.find(i => i.id === pref.id);
                    if (item) {
                        item.checked = pref.checked;
                        matchCount++;
                    }
                });
                console.log('[Playlist] Applied preferences to', matchCount, 'items');
                
                // If no items are checked, check all by default (fresh start)
                const checkedCount = this.playlist.filter(i => i.checked).length;
                if (checkedCount === 0) {
                    console.log('[Playlist] No items checked, enabling all by default');
                    this.playlist.forEach(item => item.checked = true);
                }
            } else {
                console.log('[Playlist] No saved preferences, all items checked by default');
            }
        } catch (e) {
            console.error('[Playlist] Error loading preferences:', e);
            // On error, ensure all are checked
            this.playlist.forEach(item => item.checked = true);
        }
    }
    
    savePlaylistState() {
        if (!this.currentlyPlayingArticle || !this.currentlyPlayingPlayer) return;
        
        const state = {
            articleId: this.normalizeUrl(this.currentlyPlayingArticle.link),
            articleTitle: this.currentlyPlayingArticle.title,
            articleLink: this.currentlyPlayingArticle.link,
            currentTime: this.currentlyPlayingPlayer.currentTime,
            duration: this.currentlyPlayingPlayer.duration || 0,
            playlistIndex: this.currentPlaylistIndex,
            timestamp: Date.now()
        };
        
        try {
            localStorage.setItem('playlistState', JSON.stringify(state));
        } catch (e) {
            console.error('[Playlist] Error saving state:', e);
        }
    }
    
    async restorePlaylistState() {
        try {
            const saved = localStorage.getItem('playlistState');
            if (!saved) return;
            
            const state = JSON.parse(saved);
            
            // Check if not too old (24 hours)
            if (Date.now() - state.timestamp > 24 * 60 * 60 * 1000) {
                localStorage.removeItem('playlistState');
                return;
            }
            
            // Update UI to show resume state
            this.currentPlaylistIndex = state.playlistIndex;
            this.highlightCurrentItem(state.playlistIndex);
            
            const titleEl = document.getElementById('playlistCurrentTitle');
            const labelEl = document.getElementById('playlistLabel');
            const progressFill = document.getElementById('playlistProgressFill');
            const timeEl = document.getElementById('playlistTime');
            
            if (titleEl) titleEl.textContent = state.articleTitle;
            if (labelEl) labelEl.textContent = 'Click ▶ to resume';
            if (progressFill && state.duration) {
                progressFill.style.width = `${(state.currentTime / state.duration) * 100}%`;
            }
            if (timeEl) {
                timeEl.textContent = `${this.formatTime(state.currentTime)} / ${this.formatTime(state.duration)}`;
            }
            
            // Store for resume
            this.pendingResumeState = state;
            
            console.log('[Playlist] State restored for:', state.articleTitle);
            
        } catch (e) {
            console.error('[Playlist] Error restoring state:', e);
        }
    }
    
    // Called from showNowPlaying to integrate with tile audio
    showNowPlaying(articleTitle, audioPlayer, articleLink) {
        // Update playlist UI when audio starts from tile
        this.currentlyPlayingArticle = { title: articleTitle, link: articleLink };
        this.currentlyPlayingPlayer = audioPlayer;
        
        // Find and highlight in playlist
        const itemIndex = this.playlist.findIndex(item => item.link === articleLink);
        if (itemIndex >= 0) {
            this.currentPlaylistIndex = itemIndex;
            this.highlightCurrentItem(itemIndex);
            this.playlist[itemIndex].hasAudio = true;
            this.updateItemStatus(this.playlist[itemIndex].id, 'ready');
        }
        
        // Update bar
        const titleEl = document.getElementById('playlistCurrentTitle');
        const labelEl = document.getElementById('playlistLabel');
        const playIcon = document.getElementById('playlistPlayPause')?.querySelector('.playlist-play-icon');
        
        if (titleEl) titleEl.textContent = articleTitle;
        if (labelEl) labelEl.textContent = 'Now Playing';
        if (playIcon) playIcon.textContent = '⏸';
        
        // Set up progress tracking
        this.setupPlaylistProgress(audioPlayer);
        this.isPlaylistPlaying = true;
        
        console.log('[Playlist] Now playing from tile:', articleTitle);
    }
    
    formatTime(seconds) {
        if (!seconds || isNaN(seconds)) return '0:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    setupEventListeners() {
        // Only set up download button event listener
        const downloadButton = document.getElementById('downloadReadingLogs');
        if (downloadButton) {
            downloadButton.addEventListener('click', () => {
                this.downloadReadingLogs();
            });
        }
    }

    setupArticleViewer() {
        console.log('Setting up article viewer...');
        const closeButton = document.querySelector('.close-article');
        if (closeButton) {
            console.log('Found close button, adding click handler');
            closeButton.addEventListener('click', () => {
                console.log('Close button clicked');
                this.closeArticle();
            });
        } else {
            console.log('No close button found in initial setup');
        }
        
        // Create article viewer if it doesn't exist
        if (!this.articleViewer) {
            console.log('Creating article viewer element');
            this.articleViewer = document.createElement('div');
            this.articleViewer.id = 'article-viewer';
            this.articleViewer.classList.add('article-viewer');
            document.body.appendChild(this.articleViewer);
        }
        
        // Create article overlay if it doesn't exist
        if (!this.articleOverlay) {
            console.log('Creating article overlay element');
            this.articleOverlay = document.createElement('div');
            this.articleOverlay.classList.add('article-overlay');
            document.body.appendChild(this.articleOverlay);
        }
        
        // Add click handler to overlay
        this.articleOverlay.addEventListener('click', () => {
            console.log('Overlay clicked');
            this.closeArticle();
        });
    }

    showLoading(show = true) {
        this.loadingSpinner.style.display = show ? 'block' : 'none';
    }

    async loadMultipleFeeds() {
        const feeds = [
            { url: 'https://uxmag.com/feed', source: 'UX Magazine' },
            { url: 'https://onereach.ai/feed/', source: 'OneReach' }
        ];
        
        this.showLoading(true);
        
        try {
            // Load all feeds in parallel
            const feedPromises = feeds.map(feed => this.fetchFeedItems(feed));
            const feedResults = await Promise.all(feedPromises);
            
            // Combine all items from both feeds
            const allItems = [];
            feedResults.forEach((result, index) => {
                if (result.items) {
                    // Add source information to each item
                    result.items.forEach(item => {
                        item.source = feeds[index].source;
                        item.sourceUrl = feeds[index].url;
                    });
                    allItems.push(...result.items);
                }
            });
            
            // Sort all items by date, newest first
            allItems.sort((a, b) => {
                const dateA = new Date(a.pubDate || 0);
                const dateB = new Date(b.pubDate || 0);
                return dateB - dateA;
            });
            
            console.log(`Found ${allItems.length} total items from all feeds`);
            this.handleRSSData({ items: allItems });
        } catch (error) {
            console.error('Error loading feeds:', error);
            this.grid.innerHTML = `
                <div class="error-message">
                    <h2>Error Loading Feeds</h2>
                    <p>${error.message}</p>
                    <button onclick="window.reader.loadMultipleFeeds()">Try Again</button>
                </div>
            `;
        } finally {
            this.showLoading(false);
        }
    }

    async fetchFeedItems(feed) {
        try {
            console.log(`Loading feed from ${feed.source}:`, feed.url);
            const text = await window.flipboardAPI.fetchRSS(feed.url);
            if (!text) {
                throw new Error(`No content received from ${feed.source} feed`);
            }

            const parser = new DOMParser();
            const xml = parser.parseFromString(text, 'text/xml');
            
            // Check for parsing errors
            const parseError = xml.querySelector('parsererror');
            if (parseError) {
                throw new Error(`Failed to parse ${feed.source} RSS feed: ${parseError.textContent}`);
            }

            const items = Array.from(xml.querySelectorAll('item')).map(item => ({
                title: item.querySelector('title')?.textContent || '',
                description: item.querySelector('description')?.textContent || '',
                content: item.querySelector('content\\:encoded')?.textContent || '',
                link: item.querySelector('link')?.textContent || '',
                pubDate: item.querySelector('pubDate')?.textContent || '',
                creator: item.querySelector('dc\\:creator')?.textContent || '',
                author: item.querySelector('author')?.textContent || ''
            }));
            
            console.log(`Found ${items.length} items in ${feed.source} feed`);
            return { items };
        } catch (error) {
            console.error(`Error loading ${feed.source} feed:`, error);
            // Return empty items array instead of throwing to allow other feeds to load
            return { items: [] };
        }
    }

    async loadFeed(url) {
        // Legacy method for single feed loading if needed
        const source = url.includes('uxmag.com') ? 'UX Magazine' : 'OneReach';
        const feed = { url, source };
        
        this.showLoading(true);
        
        try {
            const result = await this.fetchFeedItems(feed);
            if (result.items) {
                result.items.forEach(item => {
                    item.source = source;
                    item.sourceUrl = url;
                });
            }
            
            this.handleRSSData(result);
        } catch (error) {
            console.error('Error loading feed:', error);
            this.grid.innerHTML = `
                <div class="error-message">
                    <h2>Error Loading Feed</h2>
                    <p>${error.message}</p>
                    <button onclick="window.reader.loadFeed('${url}')">Try Again</button>
                </div>
            `;
        } finally {
            this.showLoading(false);
        }
    }

    async fetchRSS(url) {
        try {
            console.log('Fetching RSS feed directly:', url);
            const content = await window.flipboardAPI.fetchRSS(url);
            if (!content) {
                throw new Error('No content received from feed');
            }
            return this.parseRSS(content);
        } catch (error) {
            console.error('Error fetching RSS feed:', error);
            throw error;
        }
    }

    parseRSS(xmlText) {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
        const items = xmlDoc.querySelectorAll('item');
        const isUXMag = xmlText.includes('uxmag.com');
        const isHackerNews = xmlText.includes('ycombinator.com');
        const isVerge = xmlText.includes('theverge.com');
        
        // Process items in batches to avoid rate limiting
        const batchSize = 3;
        const delay = 1000; // 1 second delay between batches

        const processInBatches = async (items) => {
            const results = [];
            for (let i = 0; i < items.length; i += batchSize) {
                const batch = items.slice(i, i + batchSize);
                const batchResults = await Promise.all(batch.map(item => this.processItem(item, { isUXMag, isHackerNews, isVerge })));
                results.push(...batchResults);
                if (i + batchSize < items.length) {
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
            return results;
        };

        return processInBatches(Array.from(items));
    }

    async processItem(item, { isUXMag, isHackerNews, isVerge }) {
        let description = item.querySelector('description')?.textContent || '';
        let content = item.querySelector('content\\:encoded')?.textContent || description;
        let imageUrl = '';
        const link = item.querySelector('link')?.textContent || '';

        try {
            if (isUXMag) {
                imageUrl = await this.getUXMagImage(item);
                if (!imageUrl) {
                    imageUrl = this.defaultLogos['uxmag.com'];
                }
            } else if (isHackerNews) {
                imageUrl = this.defaultLogos['news.ycombinator.com'];
            } else if (isVerge) {
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = description;
                imageUrl = tempDiv.querySelector('img')?.src || this.defaultLogos['theverge.com'];
            } else {
                imageUrl = this.extractImageFromContent(content, description);
                if (!imageUrl) {
                    imageUrl = this.getDefaultLogo(link);
                }
            }
        } catch (error) {
            console.error('Error processing item:', error);
            imageUrl = this.getDefaultLogo(link);
        }

        // Clean up the image URL
        if (imageUrl) {
            imageUrl = imageUrl.replace(/^http:/, 'https:');
            imageUrl = imageUrl.split('?')[0];
            if (imageUrl.startsWith('/')) {
                imageUrl = `https://${new URL(item.link).hostname}${imageUrl}`;
            }
        }
        
        // Get the author
        let author = item.querySelector('dc\\:creator')?.textContent;
        if (!author && isUXMag) {
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = description;
            author = tempDiv.querySelector('.field-name-field-author')?.textContent || '';
        }
        
        // Log final item data
        console.log('Final item data:', {
            title: item.querySelector('title')?.textContent,
            imageUrl,
            contentLength: content?.length,
            hasDescription: !!description
        });

        console.log("Author field:", item.author, item['dc:creator'], extractAuthorBlock(item.content || item["content:encoded"] || item.description));

        return {
            title: item.querySelector('title')?.textContent || '',
            description: content,
            link: item.querySelector('link')?.textContent || '',
            author: author || '',
            pubDate: item.querySelector('pubDate')?.textContent || '',
            thumbnail: imageUrl,
            enclosure: {
                link: imageUrl || ''
            }
        };
    }

    async handleRSSData(data, isCached = false) {
        // Debounce RSS data handling
        this.rssDataDebounceTimer = setTimeout(async () => {
            await this._handleRSSData(data, isCached);
        }, isCached ? 0 : 1000); // No delay for cached data, 1s delay for fresh
    }

    async _handleRSSData(data, isCached) {
        if (this.isProcessingRSS) {
            console.log('Already processing RSS data, skipping...');
            return;
        }
        
        // Load stored article links from localStorage
        this.seenArticles = this.loadStoredArticles();
        // Also load the read articles from localStorage
        this.readArticles = this.loadReadArticles();
        
        this.isProcessingRSS = true;
        console.log(`Processing ${isCached ? 'cached' : 'fresh'} RSS data...`);
        
        try {
            if (!data || !data.items) {
                console.error('Invalid RSS data:', data);
                return;
            }
            console.log('Processing RSS items:', data.items.length);
            
            // Clear grid for fresh data to avoid duplicates
            if (!isCached) {
                this.clearGrid();
                console.log('Grid cleared for fresh content');
                this.processedItems.clear();
            }
            
            // Process each item's content
            data.items = data.items.map(item => ({
                ...item,
                content: this.processContentLinks(item.content),
                description: this.processContentLinks(item.description)
            }));

            // Sort items by publication date, newest first
            data.items.sort((a, b) => {
                const dateA = new Date(a.pubDate);
                const dateB = new Date(b.pubDate);
                return dateB - dateA; // For newest to oldest
            });
            
            // IMPORTANT: Update this.items with processed/sorted data for playlist
            this.items = data.items;
            console.log('[Playlist] Updated this.items with', this.items.length, 'processed items');
            
            // Process feed items and create tiles
            for (const item of data.items) {
                if (this.processedItems.has(item.link)) {
                    console.log(`Skipping already processed item: ${item.title}`);
                    continue;
                }
                // Check whether this article is new and/or read
                const isNew = !this.seenArticles.has(item.link);
                const isRead = this.readArticles.has(item.link);
                console.log(`Creating tile for ${isCached ? 'cached' : 'fresh'} item: ${item.title}, new: ${isNew}, read: ${isRead}`);
                const tile = this.createTile(item, isNew, isRead);
                if (tile) {
                    this.grid.appendChild(tile); // Append the tile to the grid
                    this.processedItems.add(item.link);
                }
                // Mark the article as seen
                this.seenArticles.add(item.link);
            }
            
            console.log(`Finished processing ${isCached ? 'cached' : 'fresh'} RSS data`);

            // After processing all items and creating tiles
            console.log('Updating reading progress for all items');
            if (this.items && this.items.length) {
                this.items.forEach(item => {
                    this.updateReadingProgress(item);
                });
            }
            
            // Build/update playlist after items are loaded
            if (!this.playlistBuilt || !isCached) {
                console.log('[Playlist] Building playlist with', this.items.length, 'items');
                this.buildPlaylist();
                this.restorePlaylistState();
                this.playlistBuilt = true;
            }
        } catch (error) {
            console.error('Error processing RSS data:', error);
        } finally {
            this.isProcessingRSS = false;
            // Save the updated set of seen articles to localStorage
            this.saveStoredArticles(this.seenArticles);
            // Also, save the updated read status
            this.saveReadArticles(this.readArticles);
        }
    }

    createTile(item, isNew = false, isRead = false) {
        if (!item || !item.title) {
            console.error('Invalid item data:', item);
            return null;
        }

        console.log('=== CREATING TILE ===');
        console.log('Creating tile for:', item.title);
        console.log('Item link:', item.link);
        console.log('Item content length:', (item.content || '').length);
        console.log('Item description length:', (item.description || '').length);

        const tile = document.createElement('div');
        tile.setAttribute('data-link', this.normalizeUrl(item.link));
        tile.classList.add('tile');
        
        // Create tile header with audio button
        const tileHeader = document.createElement('div');
        tileHeader.className = 'tile-header';
        
        // Add audio player button in header
        const audioContainer = document.createElement('div');
        audioContainer.className = 'tile-audio-container';
        audioContainer.innerHTML = `
            <div class="audio-status" style="display: none;"></div>
            <button class="tile-audio-btn" data-article-id="${this.normalizeUrl(item.link)}" title="Listen to article">
                <span class="audio-icon">▶</span>
                <span class="audio-text">Listen</span>
            </button>
            <audio class="tile-audio-player"></audio>
        `;
        tileHeader.appendChild(audioContainer);
        tile.appendChild(tileHeader);
        
        // Add source badge
        const sourceBadge = document.createElement('span');
        sourceBadge.classList.add('source-badge');
        sourceBadge.classList.add(item.source === 'UX Magazine' ? 'uxmag' : 'onereach');
        sourceBadge.textContent = item.source;
        tile.appendChild(sourceBadge);
        
        if (isRead) {
            tile.classList.add('read');
        } else if (isNew) {
            const newPill = document.createElement('span');
            newPill.classList.add('new-pill');
            newPill.textContent = "New";
            tile.appendChild(newPill);
        }
        
        // Create and add image container first
        const imageContainer = document.createElement('div');
        imageContainer.classList.add('tile-image-container');
        
        const imageElement = document.createElement('div');
        imageElement.classList.add('tile-image');
        
        // Try to get image from content or description from the feed first
        const imageUrl = this.extractImageFromContent(item.content, item.description);
        if (imageUrl && imageUrl !== this.defaultLogos.default) {
            imageElement.style.backgroundImage = `url(${this.cleanImageUrl(imageUrl)})`;
        } else {
            // Check image cache first
            const normalizedUrl = this.normalizeUrl(item.link);
            if (this.imageCache.has(normalizedUrl)) {
                const cachedImage = this.imageCache.get(normalizedUrl);
                imageElement.style.backgroundImage = `url(${this.cleanImageUrl(cachedImage)})`;
            } else {
                // Show default logo immediately while fetching
                imageElement.style.backgroundImage = `url(${this.getDefaultLogo(item.link)})`;
                
                // Fetch image in background and update when ready
                this.fetchArticleImage(item.link).then(articleImageUrl => {
                    if (articleImageUrl && articleImageUrl !== this.getDefaultLogo(item.link)) {
                        imageElement.style.backgroundImage = `url(${this.cleanImageUrl(articleImageUrl)})`;
                    }
                }).catch(err => {
                    console.log('[Image] Fetch failed, keeping default logo');
                });
            }
        }
        
        imageContainer.appendChild(imageElement);
        tile.appendChild(imageContainer);
        
        // Create the tile content
        const tileContent = document.createElement('div');
        tileContent.classList.add('tile-content');
        
        // Add title
        const title = document.createElement('h2');
        title.classList.add('tile-title');
        title.textContent = item.title;
        tileContent.appendChild(title);
        
        // Create a placeholder for reading time that will be updated when data comes in
            const readingTimeElem = document.createElement('span');
            readingTimeElem.classList.add('tile-reading-time');
        readingTimeElem.textContent = 'Loading...'; // Temporary placeholder
        readingTimeElem.style.opacity = '0.6';
        readingTimeElem.setAttribute('data-article-url', this.normalizeUrl(item.link));
            tileContent.appendChild(readingTimeElem);
        console.log('📝 CREATED READING TIME PLACEHOLDER FOR:', item.title);
        
        // Add description
        const description = document.createElement('p');
        description.classList.add('tile-excerpt');
        description.textContent = this.truncateText(item.description || '', 150);
        tileContent.appendChild(description);
        
        // Add metadata
        const meta = document.createElement('div');
        meta.classList.add('tile-meta');
        if (item.author) {
            const author = document.createElement('span');
            author.classList.add('tile-author');
            author.textContent = item.author;
            meta.appendChild(author);
        }
        if (item.pubDate) {
            const date = document.createElement('span');
            date.classList.add('tile-date');
            date.textContent = new Date(item.pubDate).toLocaleDateString();
            meta.appendChild(date);
        }
        tileContent.appendChild(meta);
        
        // Append the content container to the tile
        tile.appendChild(tileContent);
        
        // Append the reading progress bar element to the tile
        const progressBar = document.createElement('div');
        progressBar.className = 'reading-progress-bar';
        const progressFill = document.createElement('div');
        progressFill.className = 'reading-progress-fill';
        progressBar.appendChild(progressFill);
        
        // Add a text overlay to show elapsed and total time
        const progressText = document.createElement('div');
        progressText.className = 'reading-progress-text';
        
        // Get the logged time for this article (handle both old number format and new object format)
        const articleId = this.normalizeUrl(item.link);
        const logEntry = this.readingLog[articleId];
        const loggedTime = typeof logEntry === 'number' ? logEntry : (logEntry?.readTime || 0);
        
        // Initially show just the logged time, estimated time will be updated when available
        progressText.textContent = `${this.formatTime(loggedTime)} / Loading...`;
        // Set initial progress bar width to 0 until we get the actual reading time
        progressFill.style.width = '0%';
        
        progressBar.appendChild(progressText);
        tile.appendChild(progressBar);
        
        // Set up audio button click handler (using audioContainer from header)
        const audioBtn = audioContainer.querySelector('.tile-audio-btn');
        const audioPlayer = audioContainer.querySelector('.tile-audio-player');
        const audioStatus = audioContainer.querySelector('.audio-status');
        
        // Store article link for reading log updates
        audioPlayer.dataset.articleLink = item.link;
        
        // Load saved listen progress and display on button
        const savedLogEntry = this.readingLog[articleId];
        if (savedLogEntry && typeof savedLogEntry === 'object') {
            const savedListenProgress = savedLogEntry.listenProgress || 0;
            if (savedListenProgress > 0) {
                audioBtn.style.setProperty('--listen-progress', `${savedListenProgress}%`);
                if (savedLogEntry.listenCompleted) {
                    audioBtn.classList.add('completed');
                }
            }
        }
        
        audioBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            const articleId = this.normalizeUrl(item.link);
            const audioIcon = audioBtn.querySelector('.audio-icon');
            const audioText = audioBtn.querySelector('.audio-text');
            
            // Check if audio is currently playing
            if (!audioPlayer.paused && audioPlayer.src) {
                audioPlayer.pause();
                audioIcon.textContent = '▶';
                audioText.textContent = 'Listen';
                audioBtn.classList.remove('playing');
                // Don't hide Now Playing bar - just update play state
                return;
            }
            
            // Check if we already have audio loaded
            if (audioPlayer.src && audioPlayer.src !== '') {
                audioPlayer.play();
                audioIcon.textContent = '⏸';
                audioText.textContent = 'Pause';
                audioBtn.classList.add('playing');
                // Show Now Playing bar
                this.showNowPlaying(item.title, audioPlayer, item.link);
                return;
            }
            
            // Check for existing TTS audio
            audioIcon.textContent = '⏳';
            audioText.textContent = '...';
            audioBtn.classList.add('loading');
            audioStatus.style.display = 'block';
            audioStatus.textContent = 'Loading...';
            
            try {
                const existingAudio = await window.flipboardAPI.getArticleTTS(articleId);
                
                if (existingAudio.success && existingAudio.hasAudio) {
                    // Use existing audio (with Blob URL cleanup)
                    const blob = this.base64ToBlob(existingAudio.audioData, 'audio/mpeg');
                    this.setAudioSource(audioPlayer, blob);
                    audioPlayer.play();
                    audioIcon.textContent = '⏸';
                    audioText.textContent = 'Pause';
                    audioBtn.classList.remove('loading');
                    audioBtn.classList.add('playing');
                    audioStatus.textContent = 'Playing';
                    // Show Now Playing bar
                    this.showNowPlaying(item.title, audioPlayer, item.link);
                } else {
                    // Generate new audio
                    audioStatus.textContent = 'Fetching article...';
                    
                    // Get article title
                    const articleTitle = item.title || '';
                    
                    // Fetch FULL article content from the URL (not just RSS description)
                    console.log('[Audio] Fetching full article from:', item.link);
                    let fullArticleContent = await this.fetchFullArticleContent(item.link);
                    
                    // Fall back to RSS content if fetch fails
                    if (!fullArticleContent) {
                        console.log('[Audio] Falling back to RSS content');
                        fullArticleContent = item.description || item.content || '';
                    }
                    
                    // Strip HTML tags and clean text
                    const tempDiv = document.createElement('div');
                    tempDiv.innerHTML = fullArticleContent;
                    let cleanContent = (tempDiv.textContent || tempDiv.innerText || '').trim();
                    cleanContent = cleanContent.replace(/\s+/g, ' '); // Normalize whitespace
                    
                    console.log('[Audio] Article title:', articleTitle);
                    console.log('[Audio] Raw article content length:', cleanContent.length);
                    
                    if (!cleanContent || cleanContent.length < 100) {
                        throw new Error('Not enough content to generate audio');
                    }
                    
                    // Use GPT to create an audio-optimized script
                    audioStatus.textContent = 'Creating script...';
                    console.log('[Audio] Sending to GPT for audio script creation...');
                    
                    const scriptResult = await window.flipboardAPI.createAudioScript({
                        title: articleTitle,
                        content: cleanContent
                    });
                    
                    if (!scriptResult.success) {
                        console.error('[Audio] Script creation failed:', scriptResult.error);
                        throw new Error(scriptResult.error || 'Failed to create audio script');
                    }
                    
                    const audioScript = scriptResult.script;
                    console.log('[Audio] Audio script created, length:', audioScript.length);
                    
                    // Split script into chunks for streaming playback
                    const MAX_CHUNK_SIZE = 4000;
                    const textChunks = [];
                    
                    if (audioScript.length <= MAX_CHUNK_SIZE) {
                        textChunks.push(audioScript);
                    } else {
                        let remaining = audioScript;
                        while (remaining.length > 0) {
                            if (remaining.length <= MAX_CHUNK_SIZE) {
                                textChunks.push(remaining);
                                break;
                            }
                            // Find sentence boundary
                            let breakPoint = MAX_CHUNK_SIZE;
                            const lastPeriod = remaining.lastIndexOf('. ', MAX_CHUNK_SIZE);
                            const lastQuestion = remaining.lastIndexOf('? ', MAX_CHUNK_SIZE);
                            const lastExclaim = remaining.lastIndexOf('! ', MAX_CHUNK_SIZE);
                            const bestBreak = Math.max(lastPeriod, lastQuestion, lastExclaim);
                            if (bestBreak > MAX_CHUNK_SIZE * 0.5) {
                                breakPoint = bestBreak + 1;
                            }
                            textChunks.push(remaining.substring(0, breakPoint).trim());
                            remaining = remaining.substring(breakPoint).trim();
                        }
                    }
                    
                    console.log(`[Audio] Split into ${textChunks.length} chunks for streaming`);
                    
                    // Generate first chunk and start playing immediately
                    audioStatus.textContent = 'Starting...';
                    
                    const firstResult = await window.flipboardAPI.generateTTSChunk({
                        text: textChunks[0],
                        voice: 'nova'
                    });
                    
                    if (!firstResult.success) {
                        throw new Error(firstResult.error || 'Failed to generate audio');
                    }
                    
                    // Start playing first chunk immediately (with Blob URL cleanup)
                    const firstBlob = this.base64ToBlob(firstResult.audioData, 'audio/mpeg');
                    this.setAudioSource(audioPlayer, firstBlob);
                    audioPlayer.play();
                    audioIcon.textContent = '⏸';
                    audioText.textContent = 'Pause';
                    audioBtn.classList.remove('loading');
                    audioBtn.classList.add('playing');
                    audioStatus.textContent = 'Playing';
                    // Show Now Playing bar
                    this.showNowPlaying(item.title, audioPlayer, item.link);
                    
                    // Queue remaining chunks in background
                    if (textChunks.length > 1) {
                        const audioQueue = [firstResult.audioData];
                        let currentChunkIndex = 0;
                        let isGeneratingChunks = true;
                        
                        // Generate remaining chunks in background
                        (async () => {
                            for (let i = 1; i < textChunks.length; i++) {
                                console.log(`[Audio] Generating chunk ${i + 1}/${textChunks.length} in background`);
                                audioStatus.textContent = `Loading ${i + 1}/${textChunks.length}...`;
                                
                                const chunkResult = await window.flipboardAPI.generateTTSChunk({
                                    text: textChunks[i],
                                    voice: 'nova'
                                });
                                
                                if (chunkResult.success) {
                                    audioQueue.push(chunkResult.audioData);
                                    console.log(`[Audio] Chunk ${i + 1} ready, queue size: ${audioQueue.length}`);
                                } else {
                                    console.error(`[Audio] Failed to generate chunk ${i + 1}:`, chunkResult.error);
                                }
                            }
                            isGeneratingChunks = false;
                            audioStatus.textContent = 'Playing';
                            console.log('[Audio] All chunks generated');
                            
                            // Combine all chunks and save to disk for persistence
                            console.log('[Audio] Saving combined audio to disk...');
                            try {
                                const combinedAudio = this.combineAudioChunks(audioQueue);
                                await window.flipboardAPI.saveArticleTTS({
                                    articleId: articleId,
                                    audioData: combinedAudio
                                });
                                console.log('[Audio] Audio saved successfully for:', articleId);
                            } catch (saveErr) {
                                console.error('[Audio] Failed to save combined audio:', saveErr);
                            }
                        })();
                        
                        // When current chunk ends, play next from queue
                        const playNextChunk = () => {
                            currentChunkIndex++;
                            if (currentChunkIndex < audioQueue.length) {
                                console.log(`[Audio] Playing chunk ${currentChunkIndex + 1}/${textChunks.length}`);
                                const nextBlob = this.base64ToBlob(audioQueue[currentChunkIndex], 'audio/mpeg');
                                this.setAudioSource(audioPlayer, nextBlob);
                                audioPlayer.play();
                            } else if (isGeneratingChunks) {
                                // Wait for next chunk to be ready
                                console.log('[Audio] Waiting for next chunk...');
                                audioStatus.textContent = 'Buffering...';
                                const waitForChunk = setInterval(() => {
                                    if (currentChunkIndex < audioQueue.length) {
                                        clearInterval(waitForChunk);
                                        playNextChunk();
                                    } else if (!isGeneratingChunks) {
                                        clearInterval(waitForChunk);
                                        // All done
                                        audioIcon.textContent = '✓';
                                        audioText.textContent = 'Done';
                                        audioBtn.classList.remove('playing');
                                        audioBtn.classList.add('completed');
                                    }
                                }, 500);
                            } else {
                                // All chunks played
                                console.log('[Audio] All chunks played');
                            }
                        };
                        
                        // Override the ended handler for streaming
                        audioPlayer.onended = playNextChunk;
                    } else {
                        // Single chunk - save immediately
                        console.log('[Audio] Single chunk, saving to disk...');
                        try {
                            await window.flipboardAPI.saveArticleTTS({
                                articleId: articleId,
                                audioData: firstResult.audioData
                            });
                            console.log('[Audio] Single chunk audio saved for:', articleId);
                        } catch (saveErr) {
                            console.error('[Audio] Failed to save single chunk audio:', saveErr);
                        }
                    }
                }
                
                // Hide status after a moment
                setTimeout(() => {
                    audioStatus.style.display = 'none';
                }, 2000);
                
            } catch (error) {
                console.error('Audio error:', error);
                audioIcon.textContent = '!';
                audioText.textContent = 'Error';
                audioBtn.classList.remove('loading');
                const errorMsg = error?.message || 'Error';
                audioStatus.textContent = errorMsg;
                
                setTimeout(() => {
                    audioIcon.textContent = '▶';
                    audioText.textContent = 'Listen';
                    audioStatus.style.display = 'none';
                }, 2000);
            }
        });
        
        // Track audio progress and update reading log
        audioPlayer.addEventListener('timeupdate', () => {
            if (audioPlayer.duration) {
                const progress = (audioPlayer.currentTime / audioPlayer.duration) * 100;
                
                // Update the button's fill progress (visual indicator)
                audioBtn.style.setProperty('--listen-progress', `${progress}%`);
                
                // Update reading log with listen progress (every 5 seconds)
                const articleLink = audioPlayer.dataset.articleLink;
                if (articleLink && Math.floor(audioPlayer.currentTime) % 5 === 0) {
                    this.updateListenProgress(articleLink, audioPlayer.currentTime, audioPlayer.duration);
                }
            }
        });
        
        // Handle audio ended
        audioPlayer.addEventListener('ended', () => {
            const audioIcon = audioBtn.querySelector('.audio-icon');
            const audioText = audioBtn.querySelector('.audio-text');
            audioIcon.textContent = '✓';
            audioText.textContent = 'Done';
            audioBtn.classList.remove('playing');
            audioBtn.classList.add('completed');
            audioBtn.style.setProperty('--listen-progress', '100%');
            
            // Mark as fully listened in reading log
            const articleLink = audioPlayer.dataset.articleLink;
            if (articleLink) {
                this.updateListenProgress(articleLink, audioPlayer.duration, audioPlayer.duration, true);
            }
            
            // Reset to listen after a moment (but keep progress visible)
            setTimeout(() => {
                audioIcon.textContent = '▶';
                audioText.textContent = 'Listen';
            }, 3000);
        });
        
        // Add click event listener to open the article
        console.log('Adding click handler to tile:', item.title);
        tile.addEventListener('click', (e) => {
            console.log('Tile clicked:', item.title);
            e.preventDefault();
            e.stopPropagation();
            this.openArticle(item);
        });

        return tile;
    }
    
    // Helper to convert base64 to blob
    base64ToBlob(base64, mimeType) {
        const byteCharacters = atob(base64);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        return new Blob([byteArray], { type: mimeType });
    }
    
    // Helper to combine multiple base64 audio chunks into one
    combineAudioChunks(base64Chunks) {
        // Convert each base64 chunk to binary
        const binaryChunks = base64Chunks.map(chunk => {
            const binary = atob(chunk);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            return bytes;
        });
        
        // Calculate total length
        const totalLength = binaryChunks.reduce((sum, chunk) => sum + chunk.length, 0);
        
        // Combine all chunks
        const combined = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of binaryChunks) {
            combined.set(chunk, offset);
            offset += chunk.length;
        }
        
        // Convert back to base64
        let binary = '';
        for (let i = 0; i < combined.length; i++) {
            binary += String.fromCharCode(combined[i]);
        }
        return btoa(binary);
    }

    truncateText(text, maxLength) {
        // Remove HTML tags and decode HTML entities
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = text;
        const plainText = tempDiv.textContent || tempDiv.innerText;
        if (plainText.length <= maxLength) return plainText;
        return plainText.substr(0, maxLength).trim() + '...';
    }

    sanitizeContent(html) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;
        
        // Remove unwanted elements
        const unwanted = tempDiv.querySelectorAll('script, style, iframe');
        unwanted.forEach(elem => elem.remove());
        
        // Clean the text
        let text = tempDiv.textContent || tempDiv.innerText;
        text = text.replace(/\s+/g, ' ').trim();
        return text;
    }

    escapeHtml(text) {
        if (!text) return '';
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    async getUXMagImage(item) {
        // First try to extract an image from the item content/description
        let imageFromContent = this.extractImageFromContent(item.content, item.description);
        if (imageFromContent && imageFromContent !== this.defaultLogos.default) {
             console.log("Using image from content:", imageFromContent);
             return imageFromContent;
        }

        console.log("No image found in content; fetching featured image from article page for", item.link);
        try {
            // Use the main process to fetch the article content
            const articleContent = await window.flipboardAPI.fetchArticle(item.link);
            if (!articleContent) {
                console.log('No content received for article image');
                return null;
            }

                const parser = new DOMParser();
            const doc = parser.parseFromString(articleContent, 'text/html');
            
                // Try multiple selectors to find a featured image
            const possibleImages = [
                    doc.querySelector('meta[property="og:image"]')?.content,
                    doc.querySelector('meta[name="twitter:image"]')?.content,
                    doc.querySelector('.featured-image img')?.src,
                    doc.querySelector('article img')?.src,
                    doc.querySelector('.post-thumbnail img')?.src,
            ].filter(Boolean);

                if (possibleImages.length > 0) {
                    const featuredImage = possibleImages[0];
                    console.log("Featured image found:", featuredImage);
                    this.imageCache.set(item.link, featuredImage);
                    this.saveImageCache();
                    return featuredImage;
            }
        } catch (error) {
            console.error('Error fetching UX Mag image for', item.link, error);
        }
        console.warn("No featured image found for", item.link);
        return null;
    }

    extractImageFromContent(content, description) {
        if (!content && !description) return this.defaultLogos.default;
        return this.getImagesFromHtml(content)[0] || 
               this.getImagesFromHtml(description)[0] || 
               this.defaultLogos.default;
    }

    getImagesFromHtml(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        // Remove any unsupported attributes from all images (e.g. web-share)
        const imgs = doc.querySelectorAll('img');
        imgs.forEach(img => {
            if (img.hasAttribute('web-share')) {
                console.log("Removing unsupported attribute 'web-share' from image");
                img.removeAttribute('web-share');
            }
        });

        // Get the first image element and attempt to return its source.
        let imgElement = doc.querySelector('img');
        if (imgElement) {
            // Support lazy-loaded images by checking data-src first.
            const src = imgElement.getAttribute('data-src') || imgElement.src;
            return src ? [src] : [];
        }
        return [];
    }

    getDefaultLogo(link) {
        // Check the domain and return appropriate logo
        try {
            const url = new URL(link);
            const hostname = url.hostname.toLowerCase();
            
            if (hostname.includes('uxmag.com')) {
                return this.defaultLogos['uxmag.com'];
            } else if (hostname.includes('onereach.ai')) {
                return this.defaultLogos['onereach.ai'];
            }
        } catch (e) {
            console.error('Error parsing URL:', link, e);
        }
        
        // Return default logo as fallback
        return this.defaultLogos.default;
    }

    async openArticle(item) {
        console.log('=== OPENING ARTICLE ===');
        console.log('Article title:', item.title);
        console.log('Article link:', item.link);
        console.log('Article description preview:', (item.description || '').substring(0, 100) + '...');
        this.startReadingTimer(item);
        
        // Ensure article viewer exists
        if (!this.articleViewer) {
            console.log('Creating article viewer');
            this.articleViewer = document.createElement('div');
            this.articleViewer.id = 'article-viewer';
            this.articleViewer.classList.add('article-viewer');
            document.body.appendChild(this.articleViewer);
        }
        
        // Ensure article overlay exists
        if (!this.articleOverlay) {
            console.log('Creating article overlay');
            this.articleOverlay = document.createElement('div');
            this.articleOverlay.classList.add('article-overlay');
            document.body.appendChild(this.articleOverlay);
        }
        
        // Get the image URL from the corresponding tile
        const tileElem = document.querySelector(`.tile[data-link="${this.normalizeUrl(item.link)}"]`);
        let headerImageUrl = this.getDefaultLogo(item.link); // fallback to default
        
        if (tileElem) {
            const tileImageDiv = tileElem.querySelector('.tile-image');
            if (tileImageDiv && tileImageDiv.style.backgroundImage) {
                headerImageUrl = tileImageDiv.style.backgroundImage
                    .replace(/^url\(['"]?/, '')
                    .replace(/['"]?\)$/, '');
            }
        }

        // Show loading state
        this.articleViewer.innerHTML = `
            <div class="loading-spinner"></div>
            <div class="article-header">
                <img class="article-header-image" src="${headerImageUrl}" alt="${item.title}">
                <div class="article-header-overlay">
                    <h1 id="article-title">${item.title || 'No Title'}</h1>
                </div>
            </div>
        `;

        // Show the viewer and overlay
        this.articleViewer.style.display = 'block';
        this.articleOverlay.style.display = 'block';
        this.articleViewer.classList.add('active');
        document.body.classList.add('article-open');

        try {
            console.log('Fetching article content from:', item.link);
            console.log('Article title:', item.title);
            
            // Check raw HTML cache first
            const cacheKey = 'raw_' + this.normalizeUrl(item.link);
            let articleContent = null;
            
            const cachedRaw = this.articleCache.get(cacheKey);
            if (cachedRaw) {
                console.log('[Cache] HIT - Using cached raw HTML');
                articleContent = cachedRaw.content;
            } else {
                // Fetch from network
                articleContent = await window.flipboardAPI.fetchArticle(item.link);
                
                // Cache the raw HTML for future use
                if (articleContent) {
                    this.articleCache.set(cacheKey, {
                        content: articleContent,
                        timestamp: Date.now()
                    });
                    this.saveArticleCache();
                    console.log('[Cache] Stored raw HTML');
                }
            }
            
            console.log('Received article content, length:', articleContent?.length || 0);
            
            // Create a simple hash of the content to see if we're getting the same content
            const contentHash = articleContent ? articleContent.substring(0, 100) + '...' + articleContent.substring(articleContent.length - 100) : 'no content';
            console.log('Content hash (first+last 100 chars):', contentHash);
            
            // Save the fetched content to a file for debugging
            if (articleContent && window.flipboardAPI.debugSaveContent) {
                window.flipboardAPI.debugSaveContent(item.link, articleContent).then(filepath => {
                    console.log('Raw HTML saved for debugging:', filepath);
                }).catch(err => console.error('Failed to save debug content:', err));
            }
            
            if (articleContent) {
                const parser = new DOMParser();
                const doc = parser.parseFromString(articleContent, 'text/html');
                
                console.log('=== PARSING HTML DOCUMENT ===');
                console.log('Document title:', doc.title);
                console.log('Article source:', item.source);
                console.log('Available article selectors:');
                console.log('- .entry-content:', !!doc.querySelector('.entry-content'));
                console.log('- .post-content:', !!doc.querySelector('.post-content'));
                console.log('- article:', !!doc.querySelector('article'));
                console.log('- .content:', !!doc.querySelector('.content'));
                console.log('- main:', !!doc.querySelector('main'));
                
                // Determine if this is OneReach or UXMag
                const isOneReach = item.source === 'OneReach' || item.link.includes('onereach.ai');
                let articleElement;
                
                if (isOneReach) {
                    console.log('=== PARSING ONEREACH ARTICLE ===');
                    // Log all main content containers for debugging
                    console.log('OneReach content selectors check:');
                    console.log('- .post-content:', !!doc.querySelector('.post-content'));
                    console.log('- .blog-content:', !!doc.querySelector('.blog-content'));
                    console.log('- .article-content:', !!doc.querySelector('.article-content'));
                    console.log('- .wp-site-blocks:', !!doc.querySelector('.wp-site-blocks'));
                    console.log('- .wp-block-post-content:', !!doc.querySelector('.wp-block-post-content'));
                    console.log('- .entry-content:', !!doc.querySelector('.entry-content'));
                    console.log('- main article:', !!doc.querySelector('main article'));
                    
                    // OneReach-specific selectors
                    articleElement = doc.querySelector('.wp-block-post-content') ||
                                   doc.querySelector('.post-content') ||
                                   doc.querySelector('.blog-content') ||
                                   doc.querySelector('.article-content') ||
                                   doc.querySelector('.content-wrapper') ||
                                   doc.querySelector('article .entry-content') ||
                                   doc.querySelector('.single-post .entry-content') ||
                                   doc.querySelector('.post-body') ||
                                   doc.querySelector('main .content') ||
                                   doc.querySelector('.page-content') ||
                                   doc.querySelector('[itemprop="articleBody"]') ||
                                   doc.querySelector('.entry-content') ||
                                   doc.querySelector('main article');
                } else {
                    console.log('=== PARSING UXMAG ARTICLE ===');
                    // UXMag uses Elementor, so we need to look for the theme-post-content widget
                    articleElement = doc.querySelector('[data-widget_type="theme-post-content.default"] .elementor-widget-container') ||
                                   doc.querySelector('.elementor-widget-theme-post-content .elementor-widget-container') ||
                                   doc.querySelector('.entry-content') ||
                                   doc.querySelector('.post-content') ||
                                   doc.querySelector('.content-area .content') ||
                                   doc.querySelector('article .content') ||
                                   doc.querySelector('.single-post .content') ||
                                   doc.querySelector('article') ||
                                   doc.querySelector('.content') ||
                                   doc.querySelector('main');
                }
                
                let processedContent = '';
                if (articleElement) {
                    console.log('=== FOUND ARTICLE ELEMENT ===');
                    console.log('Element tag:', articleElement.tagName);
                    console.log('Element class:', articleElement.className);
                    console.log('Element ID:', articleElement.id);
                    console.log('Element innerHTML length:', articleElement.innerHTML.length);
                    console.log('Raw content preview (first 300 chars):', articleElement.innerHTML.substring(0, 300) + '...');
                    
                    // Check if this element contains the expected article title
                    const titleInContent = articleElement.innerHTML.includes(item.title.substring(0, 20));
                    console.log('Does content contain article title?', titleInContent);
                    
                    // Get the main content, handling different structures
                    let contentToProcess = articleElement.innerHTML;
                    
                    // For OneReach, check if we need to extract inner content
                    if (isOneReach) {
                        // Check if there's a more specific content container inside
                        const innerContent = articleElement.querySelector('.wp-block-group__inner-container') ||
                                           articleElement.querySelector('.entry-content-inner') ||
                                           articleElement.querySelector('.post-content-inner');
                        if (innerContent) {
                            console.log('Found inner content container for OneReach');
                            contentToProcess = innerContent.innerHTML;
                        }
                    }
                    
                    // Remove common unwanted elements
                    const tempDiv = document.createElement('div');
                    tempDiv.innerHTML = contentToProcess;
                    
                    // Remove navigation, sidebars, ads, etc.
                    let unwantedSelectors = [
                        '.sidebar', '.navigation', '.nav', '.menu',
                        '.ads', '.advertisement', '.social-share',
                        '.related-posts', '.comments', '.comment-form',
                        '.footer', '.header', '.breadcrumb'
                    ];
                    
                    // Add OneReach-specific unwanted selectors
                    if (isOneReach) {
                        unwantedSelectors = unwantedSelectors.concat([
                            '.sharedaddy', '.jp-relatedposts', '.post-navigation',
                            '.entry-meta', '.entry-footer', '.author-bio',
                            '.newsletter-signup', '.cta-section', '.promotion',
                            'script', 'style', 'noscript', 'iframe',
                            '.wp-block-button', '.wp-block-buttons',
                            '.post-tags', '.post-categories', '.share-buttons'
                        ]);
                    }
                    
                    unwantedSelectors.forEach(selector => {
                        const elements = tempDiv.querySelectorAll(selector);
                        elements.forEach(el => el.remove());
                    });
                    
                    // For OneReach, clean up WordPress block markup
                    if (isOneReach) {
                        // Replace WordPress block comments
                        tempDiv.innerHTML = tempDiv.innerHTML.replace(/<!-- wp:.*?-->/g, '');
                        tempDiv.innerHTML = tempDiv.innerHTML.replace(/<!-- \/wp:.*?-->/g, '');
                        
                        // Clean up empty paragraphs
                        const emptyParagraphs = tempDiv.querySelectorAll('p:empty, p:blank');
                        emptyParagraphs.forEach(p => p.remove());
                        
                        // Remove unnecessary wrapper divs
                        const wrapperDivs = tempDiv.querySelectorAll('.wp-block-group');
                        wrapperDivs.forEach(wrapper => {
                            // Check if this wrapper only contains other wrappers or no meaningful content
                            const hasContent = wrapper.querySelector('p, h1, h2, h3, h4, h5, h6, ul, ol, blockquote, img, table, pre');
                            if (!hasContent && wrapper.children.length === 1 && wrapper.firstElementChild) {
                                wrapper.replaceWith(wrapper.firstElementChild);
                            }
                        });
                    }
                    
                    processedContent = this.processContentLinks(tempDiv.innerHTML);
                    console.log('Processed content length:', processedContent.length);
                    console.log('Processed content preview:', processedContent.substring(0, 300) + '...');
        } else {
                    console.log('No specific article element found, trying to extract from body');
                    
                    // Try to find content by looking for paragraphs with substantial text
                    const paragraphs = doc.querySelectorAll('p');
                    const substantialParagraphs = Array.from(paragraphs).filter(p => 
                        p.textContent.trim().length > 50 && 
                        !p.closest('.sidebar') && 
                        !p.closest('.navigation') &&
                        !p.closest('.footer')
                    );
                    
                    if (substantialParagraphs.length > 0) {
                        console.log(`Found ${substantialParagraphs.length} substantial paragraphs`);
                        const contentDiv = document.createElement('div');
                        substantialParagraphs.forEach(p => {
                            contentDiv.appendChild(p.cloneNode(true));
                        });
                                                 processedContent = this.processContentLinks(contentDiv.innerHTML);
                         console.log('Processed content from paragraphs, length:', processedContent.length);
                         console.log('Processed content preview:', processedContent.substring(0, 300) + '...');
                    } else {
                        console.log('Falling back to body content');
                                                 processedContent = this.processContentLinks(doc.body.innerHTML);
                         console.log('Processed content from body, length:', processedContent.length);
                         console.log('Processed content preview:', processedContent.substring(0, 300) + '...');
                    }
        }

        const articleHTML = `
            <div class="reading-progress-indicator"></div>
            <button class="close-article">×</button>
            <div class="article-header">
                <img class="article-header-image" src="${headerImageUrl}" alt="${item.title}">
                <div class="article-header-overlay">
                    <h1 id="article-title">${item.title || 'No Title'}</h1>
                </div>
            </div>
            <div class="article-metadata">
                <span class="article-date">${new Date(item.pubDate).toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric'
                })}</span>
                        ${item.author ? `<span class="article-author">By ${item.author}</span>` : ''}
            </div>
            <div id="article-content">
                        ${processedContent}
            </div>
            <div class="article-footer">
                <p>Thanks for reading!</p>
            </div>
        `;

                console.log('=== SETTING ARTICLE HTML ===');
                console.log('Final article title in HTML:', item.title);
                console.log('Final processed content length:', processedContent.length);
                console.log('Final processed content preview:', processedContent.substring(0, 200) + '...');
                
                this.articleViewer.innerHTML = articleHTML;
                console.log('Article HTML set successfully');
            } else {
                throw new Error('No content received from article fetch');
            }
        } catch (error) {
            console.error('Error fetching article content:', error);
            // Fall back to RSS content
            console.log('=== FALLING BACK TO RSS CONTENT ===');
            console.log('Fallback article title:', item.title);
            console.log('Fallback article link:', item.link);
            console.log('RSS content preview:', (item.content || item.description || '').substring(0, 200) + '...');
            const fallbackContent = this.processContentLinks(item.content || item.description || 'No content available');
            console.log('Fallback processed content length:', fallbackContent.length);
            console.log('Fallback processed content preview:', fallbackContent.substring(0, 200) + '...');
            this.articleViewer.innerHTML = `
                <div class="reading-progress-indicator"></div>
                <button class="close-article">×</button>
                <div class="article-header">
                    <img class="article-header-image" src="${headerImageUrl}" alt="${item.title}">
                    <div class="article-header-overlay">
                        <h1 id="article-title">${item.title || 'No Title'}</h1>
                    </div>
                </div>
                <div class="article-metadata">
                    <span class="article-date">${new Date(item.pubDate).toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric'
                    })}</span>
                    ${item.author ? `<span class="article-author">By ${item.author}</span>` : ''}
                </div>
                <div id="article-content">
                    ${fallbackContent}
                </div>
                <div class="article-footer">
                    <p>Thanks for reading!</p>
                </div>
            `;
        }
        
        // Add click event listener to close button
        const closeButton = this.articleViewer.querySelector('.close-article');
        if (closeButton) {
            console.log('Adding click handler to close button');
            closeButton.addEventListener('click', () => {
                console.log('Close button clicked');
                this.closeArticle();
            });
        }
    }

    closeArticle() {
        console.log('Closing article');
        // Stop the continuous reading timer (and persist logged time)
        this.stopReadingTimer();

        // Also clear the read timer if it exists
        if (this.readTimer) {
            clearTimeout(this.readTimer);
            this.readTimer = null;
        }

        document.body.classList.remove('article-open');

        if (this.articleViewer) {
            // Remove the "active" class to hide the viewer
            this.articleViewer.classList.remove("active");
            // Hide the viewer after transition
            setTimeout(() => {
                this.articleViewer.style.display = "none";
            }, 300);
        }

        if (this.articleOverlay) {
            this.articleOverlay.style.display = "none";
        }
    }

    clearGrid() {
        this.grid.innerHTML = '';
    }

    // Update the cleanImageUrl method
    cleanImageUrl(url) {
        if (!url) return "";
        // If the URL is already relative (e.g. starts with "./" or "/"), return it as is
        if (url.startsWith('./') || url.startsWith('/')) {
            return url;
        }
        // Otherwise, perform any necessary cleaning. For now, we simply return the URL.
        return url;
    }

    // Update fetchArticleFeaturedImage to use direct fetching
    async fetchArticleFeaturedImage(link) {
        try {
            console.log("Fetching article page directly:", link);
            const articleContent = await window.flipboardAPI.fetchArticle(link);
            if (!articleContent) {
                console.log('No content received for article image');
            return null;
        }

        const parser = new DOMParser();
            const doc = parser.parseFromString(articleContent, 'text/html');

            // Try multiple selectors to find a featured image
            const possibleImages = [
                doc.querySelector('meta[property="og:image"]')?.content,
                doc.querySelector('meta[name="twitter:image"]')?.content,
                doc.querySelector('.featured-image img')?.src,
                doc.querySelector('article img')?.src,
                doc.querySelector('.post-thumbnail img')?.src,
            ].filter(Boolean);

            if (possibleImages.length > 0) {
                const featuredImage = possibleImages[0];
                console.log("Featured image found:", featuredImage);
                this.imageCache.set(link, featuredImage);
                this.saveImageCache();
                return featuredImage;
                    }
        } catch (error) {
            console.error('Error fetching article image:', error);
                }
        return null;
    }

    // Update fetchFullArticleContent to use direct fetching with caching
    async fetchFullArticleContent(link) {
        try {
            // Check cache first
            const cachedContent = this.getCachedArticle(link);
            if (cachedContent) {
                console.log("[TTS] Using cached article content");
                return cachedContent;
            }
            
            console.log("[TTS] Fetching full article from:", link);
            const articleContent = await window.flipboardAPI.fetchArticle(link);
            if (!articleContent) {
                console.log('[TTS] No content received for article');
                return null;
            }

            const parser = new DOMParser();
            const doc = parser.parseFromString(articleContent, 'text/html');
            
            // Determine source type
            const isOneReach = link.includes('onereach.ai');
            const isUXMag = link.includes('uxmag.com');
            
            let articleElement = null;
            
            if (isUXMag) {
                // UXMag-specific selectors
                const selectors = [
                    '.elementor-widget-theme-post-content .elementor-widget-container',
                    '.elementor-widget-container',
                    'article .entry-content',
                    '.post-content',
                    'article'
                ];
                for (const selector of selectors) {
                    articleElement = doc.querySelector(selector);
                    if (articleElement && articleElement.textContent.trim().length > 500) {
                        console.log('[TTS] Found UXMag content with selector:', selector);
                        break;
                    }
                }
            } else if (isOneReach) {
                // OneReach-specific selectors
                const selectors = [
                    '.blog-post-content',
                    '.entry-content',
                    'article .content',
                    'main article',
                    'article'
                ];
                for (const selector of selectors) {
                    articleElement = doc.querySelector(selector);
                    if (articleElement && articleElement.textContent.trim().length > 500) {
                        console.log('[TTS] Found OneReach content with selector:', selector);
                        break;
                    }
                }
            }
            
            // Generic fallbacks
            if (!articleElement || articleElement.textContent.trim().length < 500) {
                const fallbackSelectors = [
                    'article',
                    '.entry-content',
                    '.post-content',
                    '.content',
                    'main',
                    '.blog-content'
                ];
                for (const selector of fallbackSelectors) {
                    const el = doc.querySelector(selector);
                    if (el && el.textContent.trim().length > 500) {
                        articleElement = el;
                        console.log('[TTS] Found content with fallback selector:', selector);
                        break;
                    }
                }
            }
            
            // Last resort: body
            if (!articleElement) {
                articleElement = doc.body;
                console.log('[TTS] Using body as fallback');
            }
            
            // Remove unwanted elements (nav, scripts, styles, etc.)
            const unwantedSelectors = ['script', 'style', 'nav', 'header', 'footer', '.comments', '.sidebar', '.related-posts', '.share-buttons', '.author-bio'];
            unwantedSelectors.forEach(selector => {
                articleElement.querySelectorAll(selector).forEach(el => el.remove());
            });
            
            console.log("[TTS] Full article content length:", articleElement.innerHTML.length);
            console.log("[TTS] Full article text length:", articleElement.textContent.trim().length);
            
            // Cache the processed content for future use
            const processedContent = articleElement.innerHTML;
            this.cacheArticle(link, processedContent);
            
            return processedContent;
        } catch (error) {
            console.error("[TTS] Error fetching full article:", error);
            return null;
        }
    }

    // New helper method to get initial image
    async getInitialImage(item) {
        // First try content images
        const contentImages = this.getImagesFromHtml(item.content);
        if (contentImages.length > 0) {
            return contentImages[0];
        }
        
        // Then try description images
        const descriptionImages = this.getImagesFromHtml(item.description);
        if (descriptionImages.length > 0) {
            return descriptionImages[0];
        }
        
        // Fall back to default image "uxMag.png"
        return "uxMag.png";
    }

    // New method to update tile image in background
    async updateTileWithFeaturedImage(tile, item) {
        try {
            const featuredImage = await this.fetchArticleFeaturedImage(item.link);
            if (featuredImage) {
                // Update the background image of the tile container using !important
                const tileImageContainer = tile.querySelector('.tile-image');
                if (tileImageContainer) {
                    tileImageContainer.style.setProperty('background-image', `url(${featuredImage})`, 'important');
                    tileImageContainer.style.setProperty('background-size', 'cover', 'important');
                    tileImageContainer.style.setProperty('background-position', 'center', 'important');
                }

                // Also update the hidden <img> element's src
                const img = tile.querySelector('img');
                if (img) {
                    img.src = featuredImage;
                }
                console.log("Tile updated with featured image:", featuredImage);
            } else {
                console.warn("No featured image found for", item.link);
            }
        } catch (error) {
            console.error("Error updating tile with featured image:", error);
        }
    }

    async loadImageCache() {
        try {
            // Try loading from disk first (persists across app restarts)
            if (window.flipboardAPI && window.flipboardAPI.loadCache) {
                const cached = await window.flipboardAPI.loadCache('imageCache');
                if (cached && cached.data) {
                    this.imageCache = new Map(cached.data);
                    console.log(`[ImageCache] Loaded ${this.imageCache.size} cached images from disk`);
                    return;
                }
            }
            // Fallback to localStorage
            const cached = localStorage.getItem('imageCache');
            if (cached) {
                this.imageCache = new Map(JSON.parse(cached));
                console.log(`[ImageCache] Loaded ${this.imageCache.size} cached images from localStorage`);
            }
        } catch (err) {
            console.error('[ImageCache] Error loading:', err);
        }
    }

    async saveImageCache() {
        try {
            const data = Array.from(this.imageCache.entries());
            // Save to disk (persists across app restarts)
            if (window.flipboardAPI && window.flipboardAPI.saveCache) {
                await window.flipboardAPI.saveCache('imageCache', data);
            }
            // Also save to localStorage as backup
            localStorage.setItem('imageCache', JSON.stringify(data));
        } catch (err) {
            console.error('[ImageCache] Error saving:', err);
        }
    }
    
    // Article content cache for faster TTS and offline reading
    async loadArticleCache() {
        try {
            // Try loading from disk first (persists across app restarts)
            if (window.flipboardAPI && window.flipboardAPI.loadCache) {
                const cached = await window.flipboardAPI.loadCache('articleCache');
                if (cached && cached.data) {
                    this.articleCache = new Map(cached.data);
                    console.log(`[ArticleCache] Loaded ${this.articleCache.size} cached articles from disk`);
                    return;
                }
            }
            // Fallback to localStorage
            const cached = localStorage.getItem('articleCache');
            if (cached) {
                const parsed = JSON.parse(cached);
                this.articleCache = new Map(parsed);
                console.log(`[ArticleCache] Loaded ${this.articleCache.size} cached articles from localStorage`);
            }
        } catch (err) {
            console.error('[ArticleCache] Error loading:', err);
            this.articleCache = new Map();
        }
    }
    
    async saveArticleCache() {
        try {
            // Limit cache size (keep most recent 50 articles)
            const MAX_CACHE_SIZE = 50;
            if (this.articleCache.size > MAX_CACHE_SIZE) {
                const entries = Array.from(this.articleCache.entries());
                // Sort by timestamp (newest first) and keep only MAX_CACHE_SIZE
                entries.sort((a, b) => (b[1].timestamp || 0) - (a[1].timestamp || 0));
                this.articleCache = new Map(entries.slice(0, MAX_CACHE_SIZE));
            }
            
            const data = Array.from(this.articleCache.entries());
            
            // Save to disk (persists across app restarts)
            if (window.flipboardAPI && window.flipboardAPI.saveCache) {
                await window.flipboardAPI.saveCache('articleCache', data);
            }
            
            // Also save to localStorage as backup (may be truncated for large caches)
            try {
                localStorage.setItem('articleCache', JSON.stringify(data));
            } catch (e) {
                // localStorage might be full, ignore
            }
        } catch (err) {
            console.error('[ArticleCache] Error saving:', err);
            // If storage is full, clear old entries
            if (err.name === 'QuotaExceededError') {
                console.log('[ArticleCache] Storage full, clearing old entries...');
                const entries = Array.from(this.articleCache.entries());
                this.articleCache = new Map(entries.slice(-20)); // Keep only 20 newest
                try {
                    localStorage.setItem('articleCache', 
                        JSON.stringify(Array.from(this.articleCache.entries()))
                    );
                } catch (e) {
                    console.error('[Cache] Still cannot save, clearing cache');
                    localStorage.removeItem('articleCache');
                }
            }
        }
    }
    
    // Get cached article content
    getCachedArticle(url) {
        const normalizedUrl = this.normalizeUrl(url);
        const cached = this.articleCache.get(normalizedUrl);
        if (cached) {
            console.log(`[Cache] HIT for ${normalizedUrl}`);
            return cached.content;
        }
        console.log(`[Cache] MISS for ${normalizedUrl}`);
        return null;
    }
    
    // Cache article content
    cacheArticle(url, content) {
        const normalizedUrl = this.normalizeUrl(url);
        this.articleCache.set(normalizedUrl, {
            content: content,
            timestamp: Date.now()
        });
        this.saveArticleCache();
        console.log(`[Cache] Stored article: ${normalizedUrl} (${content.length} chars)`);
    }

    // New method to fetch the full article content from the article page
    async fetchFullArticleContent(link) {
        try {
            console.log("Fetching full article directly from:", link);
            const articleContent = await window.flipboardAPI.fetchArticle(link);
            if (!articleContent) {
                console.log('No content received for article');
                return null;
            }
            
            const parser = new DOMParser();
            const doc = parser.parseFromString(articleContent, 'text/html');
            let fullArticle = doc.querySelector('article');
            if (!fullArticle) {
                fullArticle = doc.querySelector('div.entry-content');
            }
            if (!fullArticle) {
                fullArticle = doc.body;
            }
            console.log("Successfully fetched full article directly. Length:", fullArticle.innerHTML.length);
            return fullArticle.innerHTML;
        } catch (error) {
            console.error("Error fetching full article:", error);
            return null;
        }
    }

    // New method: Fetch image from the article page with caching and retry
    async fetchArticleImage(articleUrl, retryCount = 0) {
        const maxRetries = 2;
        
        try {
            const normalizedUrl = this.normalizeUrl(articleUrl);
            
            // Check image cache first
            if (this.imageCache.has(normalizedUrl)) {
                const cachedImage = this.imageCache.get(normalizedUrl);
                console.log('[ImageCache] HIT for:', normalizedUrl);
                return cachedImage;
            }
            
            // Check if we have cached article content to extract image from
            const rawCacheKey = 'raw_' + normalizedUrl;
            let articleContent = null;
            
            const cachedRaw = this.articleCache.get(rawCacheKey);
            if (cachedRaw) {
                console.log('[ImageCache] Using cached article HTML');
                articleContent = cachedRaw.content;
            } else {
                // Fetch from network
                console.log(`[ImageCache] Fetching (attempt ${retryCount + 1}/${maxRetries + 1}):`, articleUrl.substring(0, 50));
                articleContent = await window.flipboardAPI.fetchArticle(articleUrl);
                
                // Cache the raw HTML
                if (articleContent) {
                    this.articleCache.set(rawCacheKey, {
                        content: articleContent,
                        timestamp: Date.now()
                    });
                    this.saveArticleCache();
                }
            }
            
            if (!articleContent) {
                console.log('[ImageCache] No content for article image');
                return this.getDefaultLogo(articleUrl);
            }

            const parser = new DOMParser();
            const doc = parser.parseFromString(articleContent, 'text/html');

            // Try multiple selectors to find a featured image
            const possibleImages = [
                doc.querySelector('meta[property="og:image"]')?.content,
                doc.querySelector('meta[name="twitter:image"]')?.content,
                doc.querySelector('.featured-image img')?.src,
                doc.querySelector('article img')?.src,
                doc.querySelector('.post-thumbnail img')?.src,
                doc.querySelector('.elementor-widget-image img')?.src,
                doc.querySelector('img.wp-post-image')?.src,
            ].filter(Boolean);

            if (possibleImages.length > 0) {
                const featuredImage = possibleImages[0];
                // Cache the image URL
                this.imageCache.set(normalizedUrl, featuredImage);
                this.saveImageCache();
                console.log('[ImageCache] Found and cached image:', featuredImage.substring(0, 50) + '...');
                return featuredImage;
            }
            
            console.log('[ImageCache] No image found, using default');
            return this.getDefaultLogo(articleUrl);
        } catch (error) {
            // Retry on failure
            if (retryCount < maxRetries) {
                console.log(`[ImageCache] Retry ${retryCount + 1}/${maxRetries} after error:`, error.message || error);
                await new Promise(r => setTimeout(r, 1000)); // Wait 1 second before retry
                return this.fetchArticleImage(articleUrl, retryCount + 1);
            }
            console.error("[ImageCache] All retries failed for:", articleUrl);
            return this.getDefaultLogo(articleUrl);
        }
    }

    // New Methods for handling seen articles in localStorage
    loadStoredArticles() {
        try {
            const stored = localStorage.getItem('seenArticles');
            return stored ? new Set(JSON.parse(stored)) : new Set();
        } catch (e) {
            console.error("Error loading seen articles", e);
            return new Set();
        }
    }

    saveStoredArticles(seenSet) {
        try {
            localStorage.setItem('seenArticles', JSON.stringify(Array.from(seenSet)));
        } catch (e) {
            console.error("Error saving seen articles", e);
        }
    }

    loadReadArticles() {
        try {
            const stored = localStorage.getItem('readArticles');
            return stored ? new Set(JSON.parse(stored)) : new Set();
        } catch (e) {
            console.error("Error loading read articles", e);
            return new Set();
        }
    }

    saveReadArticles(readSet) {
        try {
            localStorage.setItem('readArticles', JSON.stringify(Array.from(readSet)));
        } catch (e) {
            console.error("Error saving read articles", e);
        }
    }

    updateTileReadStatus(articleLink) {
        // Normalize the article link for consistent matching
        const normalizedLink = this.normalizeUrl(articleLink);
        // Find the tile in the grid with data-link matching the normalized link
        const tile = this.grid.querySelector(`.tile[data-link="${normalizedLink}"]`);
        if (tile) {
            // Remove any existing badge (either "New" or "Read")
            const existingPill = tile.querySelector('.new-pill, .read-pill');
            if (existingPill) {
                existingPill.remove();
            }
            // Create the "Read" badge and add it
            const readPill = document.createElement('span');
            readPill.classList.add('read-pill');
            readPill.textContent = "Read";
            tile.appendChild(readPill);
            // Also mark the tile as read (greyed out)
            tile.classList.add('read');
        }
    }

    // New normalizeUrl to ensure consistent keys (e.g., lower-case, trimmed URL)
    normalizeUrl(url) {
        try {
            const u = new URL(url);
            return u.href.toLowerCase();
        } catch (e) {
            return url.trim().toLowerCase();
        }
    }

    calculateReadingTime(text) {
        if (!text) {
            console.log('calculateReadingTime: No text provided');
            return '';
        }
        
        // Remove HTML tags first to get plain text
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = text;
        const plainText = tempDiv.textContent || tempDiv.innerText || '';
        
        console.log('calculateReadingTime: Plain text length:', plainText.length);
        
        if (!plainText.trim()) {
            console.log('calculateReadingTime: No plain text after HTML removal');
            return '';
        }
        
        // Count words in the text
        const words = plainText.trim().split(/\s+/).length;
        const wordsPerMinute = 200; // Average reading speed
        const minutes = Math.ceil(words / wordsPerMinute);
        
        console.log('calculateReadingTime: Word count:', words, 'Minutes:', minutes);
        
        return minutes + " min read";
    }

    // New helper method to format seconds into mm:ss format
    formatTime(seconds) {
        const minutes = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${minutes}:${secs.toString().padStart(2, '0')}`;
    }

    // New method to estimate reading time (in seconds) based on word count
    estimateTimeInSeconds(text) {
        if (!text) return 60; // default to 1 minute if no content
        const words = text.trim().split(/\s+/).length;
        const wordsPerMinute = 200;
        const minutes = words / wordsPerMinute;
        return minutes * 60; // convert minutes to seconds
    }

    // New method to start tracking reading time for an article
    startReadingTimer(item) {
        this.currentReadingItem = item;
        this.readingStartTime = Date.now();
        if (this.readingTimer) clearInterval(this.readingTimer);
        this.readingTimer = setInterval(() => {
            this.updateReadingProgress(item);
        }, 1000);
    }

    // New method to update the reading progress bar of the current article's tile
    updateReadingProgress(item) {
        const articleId = this.normalizeUrl(item.link);
        
        // Try to get the actual estimated time from the tile's reading time element
        const tile = document.querySelector(`.tile[data-link="${articleId}"]`);
        let estimatedTime = 300; // Default 5 minutes
        
        if (tile) {
            const readingTimeElem = tile.querySelector('.tile-reading-time');
            if (readingTimeElem && readingTimeElem.textContent && readingTimeElem.textContent !== 'Loading...') {
                // Extract minutes from reading time (e.g., "14 min read" -> 14)
                const match = readingTimeElem.textContent.match(/(\d+)/);
                if (match) {
                    const minutes = parseInt(match[1]);
                    estimatedTime = minutes * 60; // Convert to seconds
                    console.log('📊 Using actual reading time for progress:', minutes, 'minutes =', estimatedTime, 'seconds');
                }
            }
        }
        
        if (estimatedTime === 300) {
            // Fallback to RSS content estimation
            let rssEstimatedTime = this.estimateTimeInSeconds(item.content || item.description);
            if (item.link && item.link.includes('uxmag.com') && rssEstimatedTime < 60) {
                rssEstimatedTime = 300; // 5 minutes default for UXMag articles
            }
            estimatedTime = rssEstimatedTime;
        }
        // Get previously logged time for this article (handle both old and new format)
        const logEntry = this.readingLog[articleId];
        let loggedTime = typeof logEntry === 'number' ? logEntry : (logEntry?.readTime || 0);
        let currentSession = 0;
        if (this.currentReadingItem && this.normalizeUrl(this.currentReadingItem.link) === articleId) {
            currentSession = (Date.now() - this.readingStartTime) / 1000;
        }
        const totalElapsed = loggedTime + currentSession;
        //console.log('Updating progress for article:', articleId, { loggedTime, currentSession, totalElapsed, estimatedTime });
        const progress = Math.min(totalElapsed / estimatedTime, 1);
        // Use the tile we already found above
        if (tile) {
            const progressFill = tile.querySelector('.reading-progress-fill');
            if (progressFill) {
                progressFill.style.width = `${progress * 100}%`;
            }
            const progressText = tile.querySelector('.reading-progress-text');
            if (progressText) {
                progressText.textContent = `${this.formatTime(totalElapsed)} / ${this.formatTime(estimatedTime)}`;
            }
            
            // Gamification: Add a badge if the article has been read at least 50%
            if (progress >= 0.5) {
                // Check if badge already exists
                if (!tile.querySelector('.badge')) {
                    const badge = document.createElement('span');
                    badge.classList.add('badge');
                    badge.textContent = "Read";
                    // Append the badge; position it via CSS
                    tile.appendChild(badge);
                }
            }
        }
    }

    // New method to stop the reading timer when the article is closed
    stopReadingTimer() {
        if (this.readingTimer) {
            clearInterval(this.readingTimer);
            this.readingTimer = null;
            if (this.currentReadingItem) {
                const articleId = this.normalizeUrl(this.currentReadingItem.link);
                const sessionTime = (Date.now() - this.readingStartTime) / 1000;
                console.log('Stopping reading timer for article:', articleId, 'Session time:', sessionTime);
                
                // Handle both old number format and new object format
                const currentEntry = this.readingLog[articleId];
                if (typeof currentEntry === 'number') {
                    // Convert old format to new format
                    this.readingLog[articleId] = { readTime: currentEntry + sessionTime, listenTime: 0, listenProgress: 0 };
                } else if (currentEntry) {
                    currentEntry.readTime = (currentEntry.readTime || 0) + sessionTime;
                } else {
                    this.readingLog[articleId] = { readTime: sessionTime, listenTime: 0, listenProgress: 0 };
                }
                // Persist the updated reading log synchronously if possible
                if (window.flipboardAPI && window.flipboardAPI.saveReadingLogSync) {
                    window.flipboardAPI.saveReadingLogSync(this.readingLog);
                } else if (window.flipboardAPI && window.flipboardAPI.saveReadingLog) {
                    window.flipboardAPI.saveReadingLog(this.readingLog);
                }
            }
        }
        this.currentReadingItem = null;
    }

    // Update listen progress in reading log and on screen
    updateListenProgress(articleLink, currentTime, duration, completed = false) {
        if (!articleLink || !duration) return;
        
        const articleId = this.normalizeUrl(articleLink);
        const listenProgress = Math.round((currentTime / duration) * 100);
        const listenTimeSeconds = Math.round(currentTime);
        
        // Initialize reading log entry if needed
        if (!this.readingLog[articleId]) {
            this.readingLog[articleId] = { readTime: 0, listenTime: 0, listenProgress: 0 };
        } else if (typeof this.readingLog[articleId] === 'number') {
            // Convert old format to new format
            this.readingLog[articleId] = { 
                readTime: this.readingLog[articleId], 
                listenTime: 0, 
                listenProgress: 0 
            };
        }
        
        // Update listen progress
        this.readingLog[articleId].listenTime = listenTimeSeconds;
        this.readingLog[articleId].listenProgress = listenProgress;
        this.readingLog[articleId].listenCompleted = completed;
        
        // Save to persistent storage (throttled)
        if (window.flipboardAPI?.saveReadingLog) {
            window.flipboardAPI.saveReadingLog(this.readingLog);
        }
        
        // Update the tile's reading progress bar to reflect combined read+listen progress
        this.updateTileProgressWithListen(articleLink, listenProgress, completed);
        
        console.log(`[Audio] Listen progress: ${listenProgress}% (${listenTimeSeconds}s / ${Math.round(duration)}s)`);
    }
    
    // Update tile progress bar with listen progress
    updateTileProgressWithListen(articleLink, listenProgress, completed) {
        const normalizedUrl = this.normalizeUrl(articleLink);
        const tile = document.querySelector(`.tile[data-link="${normalizedUrl}"]`);
        
        if (!tile) return;
        
        const progressFill = tile.querySelector('.progress-fill');
        const progressText = tile.querySelector('.progress-text');
        
        if (progressFill && listenProgress > 0) {
            // Show listen progress in green
            progressFill.style.background = completed ? '#10b981' : 'linear-gradient(90deg, #3b82f6 0%, #10b981 100%)';
            
            // Update progress bar to show listen progress
            const currentWidth = parseFloat(progressFill.style.width) || 0;
            const newWidth = Math.max(currentWidth, listenProgress);
            progressFill.style.width = `${newWidth}%`;
        }
        
        if (progressText && listenProgress > 0) {
            if (completed) {
                progressText.textContent = '✓ Listened';
            } else {
                progressText.textContent = `🎧 ${listenProgress}%`;
            }
        }
    }

    // New method to load reading log with better error handling
    async loadReadingLog() {
        if (!window.flipboardAPI?.loadReadingLog) {
            console.warn('Reading log API not available');
            return;
        }
        
        try {
            const log = await window.flipboardAPI.loadReadingLog();
            this.readingLog = log || {};
            console.log('Reading log loaded:', this.readingLog);
        } catch (error) {
            console.error('Failed to load reading log:', error);
            this.readingLog = {};
        }
    }

    // Method to update reading time in background by fetching full article
    async updateReadingTimeInBackground(tile, item, readingTimeElement) {
        try {
            console.log('Fetching full article for reading time calculation:', item.title);
            const articleContent = await window.flipboardAPI.fetchArticle(item.link);
            
            if (articleContent) {
                const parser = new DOMParser();
                const doc = parser.parseFromString(articleContent, 'text/html');
                
                // Use the same selector logic as in openArticle
                const articleElement = doc.querySelector('[data-widget_type="theme-post-content.default"] .elementor-widget-container') ||
                                     doc.querySelector('.elementor-widget-theme-post-content .elementor-widget-container') ||
                                     doc.querySelector('.entry-content') ||
                                     doc.querySelector('.post-content') ||
                                     doc.querySelector('article') ||
                                     doc.querySelector('main');
                
                if (articleElement) {
                    const fullContent = articleElement.textContent || articleElement.innerText || '';
                    const actualReadingTime = this.calculateReadingTime(fullContent);
                    
                    if (actualReadingTime && actualReadingTime !== '5 min read') {
                        console.log('Updated reading time for', item.title, 'from 5 min to', actualReadingTime);
                        readingTimeElement.textContent = actualReadingTime;
                    }
                }
            }
        } catch (error) {
            console.log('Could not fetch reading time for', item.title, '- using default');
            // Keep the default reading time if fetching fails
        }
    }

    // Method to update reading time for a specific tile
    updateTileReadingTime(url, readingTime) {
        const normalizedUrl = this.normalizeUrl(url);
        console.log('🎯 UPDATING TILE READING TIME:', normalizedUrl, readingTime);
        
        // Find the tile for this article
        const tile = document.querySelector(`.tile[data-link="${normalizedUrl}"]`);
        
        if (tile) {
            // Update the reading time element
            const readingTimeElem = tile.querySelector('.tile-reading-time');
            if (readingTimeElem) {
                readingTimeElem.textContent = readingTime;
                readingTimeElem.style.opacity = '1'; // Make it fully visible
                readingTimeElem.style.backgroundColor = '#4CAF50'; // Green background to show it's updated
                readingTimeElem.style.color = 'white';
                readingTimeElem.style.padding = '2px 6px';
                readingTimeElem.style.borderRadius = '3px';
                console.log('✅ UPDATED READING TIME FOR TILE:', readingTime);
                
                // Remove the highlight after a few seconds
                setTimeout(() => {
                    readingTimeElem.style.backgroundColor = '';
                    readingTimeElem.style.color = '';
                }, 3000);
            }
            
            // Update the progress bar with the new estimated time
            const progressText = tile.querySelector('.reading-progress-text');
            const progressFill = tile.querySelector('.reading-progress-fill');
            
            if (progressText && progressFill) {
                // Convert reading time to seconds (e.g., "14 min read" -> 840 seconds)
                const minutes = parseInt(readingTime.match(/(\d+)/)[1]);
                const estimatedSeconds = minutes * 60;
                
                // Get the logged time for this article (handle both formats)
                const logEntry = this.readingLog[normalizedUrl];
                const loggedTime = typeof logEntry === 'number' ? logEntry : (logEntry?.readTime || 0);
                
                // Update progress bar
                const progress = Math.min(loggedTime / estimatedSeconds, 1);
                progressFill.style.width = `${progress * 100}%`;
                progressText.textContent = `${this.formatTime(loggedTime)} / ${this.formatTime(estimatedSeconds)}`;
                
                console.log('📊 UPDATED PROGRESS BAR:', {
                    estimatedMinutes: minutes,
                    estimatedSeconds: estimatedSeconds,
                    loggedTime: loggedTime,
                    progress: `${Math.round(progress * 100)}%`
                });
            }
        } else {
            console.log('❌ COULD NOT FIND TILE FOR:', normalizedUrl);
        }
    }

    // Method to process links in content
    processContentLinks(content) {
        if (!content) {
            console.warn('No content provided to processContentLinks');
            return 'No content available';
        }
        
        console.log('Processing content links...');
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = content;
        
        // Process all links in the content
        const links = tempDiv.getElementsByTagName('a');
        console.log('Found links:', links.length);

        for (let link of Array.from(links)) {
            const href = link.getAttribute('href');
            
            // Skip if no href
            if (!href) continue;
            
            console.log('Processing link:', href);
            // Handle relative URLs
            if (href.startsWith('/')) {
                link.href = `https://uxmag.com${href}`;
            }
            
            // Set attributes for external opening
            link.setAttribute('target', '_blank');
            link.setAttribute('rel', 'noreferrer noopener external');
            link.setAttribute('data-wpel-link', 'external');
            
            // Add click event listener
            link.addEventListener('click', async (e) => {
                console.log('Link clicked!');
                e.preventDefault();
                const timestamp = new Date().toISOString();
                const clickData = {
                    url: link.href,
                    text: link.textContent.trim(),
                    timestamp: timestamp,
                    articleId: this.normalizeUrl(window.location.href)
                };
                
                // Log to console
                console.log('Article link clicked:', clickData);
                
                // Add to reading log
                try {
                    const readingLog = await window.flipboardAPI.loadReadingLog() || {};
                    const articleId = this.normalizeUrl(window.location.href);
                    
                    // Initialize clicks array if it doesn't exist
                    if (!readingLog[articleId]) {
                        readingLog[articleId] = { clicks: [] };
                    } else if (!readingLog[articleId].clicks) {
                        readingLog[articleId].clicks = [];
                    }
                    
                    // Add click data
                    readingLog[articleId].clicks.push(clickData);
                    
                    // Save updated reading log
                    await window.flipboardAPI.saveReadingLog(readingLog);
                } catch (error) {
                    console.error('Failed to save link click to reading log:', error);
                }
                
                // Open the link using the correct API
                if (window.flipboardAPI && window.flipboardAPI.openUrl) {
                    window.flipboardAPI.openUrl(link.href);
                } else {
                    console.warn('External link API not available');
                }
            });
            
            // Remove any onclick handlers
            link.removeAttribute('onclick');
        }
        
        // Process images
        const images = tempDiv.getElementsByTagName('img');
        console.log('Found images:', images.length);
        
        for (let img of Array.from(images)) {
            const src = img.getAttribute('src');
            if (!src) continue;
            
            // Handle relative image URLs
            if (src.startsWith('/')) {
                img.src = `https://uxmag.com${src}`;
            }
            
            // Add error handling for images
            img.onerror = function() {
                console.warn('Image failed to load:', src);
                this.style.display = 'none';
            };
        }
        
        console.log('Finished processing content');
        return tempDiv.innerHTML;
    }

    // New method to download reading logs
    async downloadReadingLogs() {
        try {
            console.log('Downloading reading logs...');
            
            // Load the reading log
            const readingLog = this.readingLog || {};
            
            // Create a more user-friendly export format
            const exportData = {
                exportDate: new Date().toISOString(),
                totalArticles: Object.keys(readingLog).length,
                totalReadingTime: Object.values(readingLog).reduce((sum, time) => sum + (typeof time === 'number' ? time : 0), 0),
                articles: []
            };
            
            // Format each article's reading data
            for (const [url, timeOrData] of Object.entries(readingLog)) {
                // Handle both legacy format (just time) and new format (object with time and clicks)
                let readingTime = 0;
                let clicks = [];
                
                if (typeof timeOrData === 'number') {
                    readingTime = timeOrData;
                } else if (typeof timeOrData === 'object') {
                    readingTime = timeOrData.time || 0;
                    clicks = timeOrData.clicks || [];
                }
                
                // Find the article title from the current items
                let title = 'Unknown Article';
                const item = this.items?.find(item => this.normalizeUrl(item.link) === url);
                if (item) {
                    title = item.title;
                }
                
                exportData.articles.push({
                    title: title,
                    url: url,
                    readingTimeSeconds: Math.round(readingTime),
                    readingTimeFormatted: this.formatTime(readingTime),
                    percentComplete: this.calculatePercentComplete(url, readingTime),
                    linksClicked: clicks.length,
                    clickDetails: clicks
                });
            }
            
            // Sort articles by reading time (most read first)
            exportData.articles.sort((a, b) => b.readingTimeSeconds - a.readingTimeSeconds);
            
            // Format total reading time
            exportData.totalReadingTimeFormatted = this.formatTime(exportData.totalReadingTime);
            
            // Create the JSON blob
            const json = JSON.stringify(exportData, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            
            // Create download link
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            
            // Generate filename with date
            const date = new Date().toISOString().split('T')[0];
            link.download = `ux-mag-reading-logs-${date}.json`;
            
            // Trigger download
            link.click();
            URL.revokeObjectURL(link.href);
            
            console.log('Reading logs downloaded successfully');
            
            // Show a success message
            this.showDownloadSuccess();
            
        } catch (error) {
            console.error('Error downloading reading logs:', error);
            alert('Failed to download reading logs. Please try again.');
        }
    }
    
    // Helper method to calculate percent complete
    calculatePercentComplete(url, readingTime) {
        const tile = document.querySelector(`.tile[data-link="${url}"]`);
        if (!tile) return 0;
        
        const readingTimeElem = tile.querySelector('.tile-reading-time');
        if (readingTimeElem && readingTimeElem.textContent && readingTimeElem.textContent !== 'Loading...') {
            const match = readingTimeElem.textContent.match(/(\d+)/);
            if (match) {
                const estimatedMinutes = parseInt(match[1]);
                const estimatedSeconds = estimatedMinutes * 60;
                return Math.min(Math.round((readingTime / estimatedSeconds) * 100), 100);
            }
        }
        
        return 0;
    }
    
    // Helper method to show download success
    showDownloadSuccess() {
        const message = document.createElement('div');
        message.className = 'download-success-message';
        message.innerHTML = '<i class="fa fa-check-circle"></i> Reading logs downloaded successfully!';
        document.body.appendChild(message);
        
        // Remove after 3 seconds
        setTimeout(() => {
            message.remove();
        }, 3000);
    }
}

// Update these feed URLs in the HTML
const reliableFeeds = [
    'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
    'https://feeds.bbci.co.uk/news/world/rss.xml',
    'https://www.reddit.com/r/worldnews/.rss',
    'https://news.ycombinator.com/rss',
    'https://feeds.feedburner.com/TechCrunch',
    'https://lifehacker.com/rss'
]; 

async function showArticle() {
    const articleViewer = document.querySelector('.article-viewer');
    const content = document.querySelector('.article-content');
    
    try {
        console.log("Requesting RSS feed from main process...");
        // This bypasses CORS by having the main process do the fetch.
        const rssText = await window.electronAPI.fetchRSS();
        content.textContent = rssText;
    } catch (e) {
        console.error("Error fetching RSS feed via IPC:", e);
        content.textContent = "Failed to load RSS feed.";
    }
    
    // Display the article viewer overlay
    articleViewer.classList.add("active");
    document.body.classList.add("article-open");
}

// Initialize the reader - only once after DOM is ready
console.log('📝 FLIPBOARD READER - Waiting for DOM...');
console.log('🚨🚨🚨 SCRIPT LOADED AT:', new Date().toISOString());
console.log('🚨🚨🚨 READING TIME FIX VERSION: 4.1 - MEMORY LEAK FIX');

// Only create reader once DOM is ready to prevent double instantiation
document.addEventListener('DOMContentLoaded', () => {
    // Check if reader already exists to prevent double creation
    if (window.reader) {
        console.log('⚠️ FlipboardReader already exists, skipping creation');
        return;
    }
    
    console.log('📝 Creating FlipboardReader instance...');
    window.reader = new FlipboardReader();
    console.log('✅ FLIPBOARD READER INSTANCE CREATED SUCCESSFULLY');
    
    // Ensure the close button is set up after DOM is loaded
    const closeButton = document.getElementById('close-article');
    if (closeButton) {
        closeButton.addEventListener('click', function() {
            const viewer = document.getElementById('article-viewer');
            if (viewer) {
                viewer.style.display = "none";
            }
        });
    }

    // Prevent internal navigation
    document.addEventListener('click', (e) => {
        const link = e.target.closest('a');
        if (link) {
            e.preventDefault();
            
            const href = link.getAttribute('href');
            if (href) {
                // Open all links externally
                window.flipboardAPI.openUrl(href);
            }
        }
    }, true);
}); 

function createArticleElement(article) {
    console.log('Creating article element...');
    const articleElement = document.createElement('div');
    articleElement.className = 'article';
    
    // Create article content
    articleElement.innerHTML = `
        <h2>${article.title}</h2>
        <div class="article-meta">
            <span class="date">${formatDate(article.pubDate)}</span>
            <span class="author">${article.creator || article.author || 'Unknown'}</span>
        </div>
        <div class="article-content">
            ${processContentLinks(article.content || article.description)}
        </div>
    `;
    console.log('Article element created');
    return articleElement;
} 