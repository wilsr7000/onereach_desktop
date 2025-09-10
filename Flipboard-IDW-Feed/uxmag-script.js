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
            // Otherwise, attempt to fetch an image directly from the article page.
            this.fetchArticleImage(item.link).then(articleImageUrl => {
                if (articleImageUrl) {
                    imageElement.style.backgroundImage = `url(${this.cleanImageUrl(articleImageUrl)})`;
                } else {
                    imageElement.style.backgroundImage = `url(${this.getDefaultLogo(item.link)})`;
                }
            });
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
        
        // Get the logged time for this article
        const articleId = this.normalizeUrl(item.link);
        const loggedTime = this.readingLog[articleId] || 0;
        
        // Initially show just the logged time, estimated time will be updated when available
        progressText.textContent = `${this.formatTime(loggedTime)} / Loading...`;
        // Set initial progress bar width to 0 until we get the actual reading time
        progressFill.style.width = '0%';
        
        progressBar.appendChild(progressText);
        tile.appendChild(progressBar);
        
        // Add recent article indicator based on pubDate (within the last week)
        if (item.pubDate) {
            const pubDate = new Date(item.pubDate);
            const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            if (pubDate >= oneWeekAgo) {
                // Check if the recent indicator isn't already added
                if (!tile.querySelector('.recent-pill')) {
                    const recentPill = document.createElement('span');
                    recentPill.classList.add('recent-pill');
                    recentPill.textContent = "Recent";
                    tile.appendChild(recentPill);
                }
            }
        }
        
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
            // Use the main process to fetch the article content
            const articleContent = await window.flipboardAPI.fetchArticle(item.link);
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

    // Update fetchFullArticleContent to use direct fetching
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

    loadImageCache() {
        try {
            const cached = localStorage.getItem('imageCache');
            if (cached) {
                this.imageCache = new Map(JSON.parse(cached));
            }
        } catch (err) {
            console.error('Error loading image cache:', err);
        }
    }

    saveImageCache() {
        try {
            localStorage.setItem('imageCache', 
                JSON.stringify(Array.from(this.imageCache.entries()))
            );
        } catch (err) {
            console.error('Error saving image cache:', err);
        }
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

    // New method: Fetch image from the article page
    async fetchArticleImage(articleUrl) {
        try {
            // Use the main process to fetch the article content
            const articleContent = await window.flipboardAPI.fetchArticle(articleUrl);
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

            return possibleImages[0] || null;
        } catch (error) {
            console.error("Error fetching article image:", error);
            return null;
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
        // Get previously logged time for this article (if any)
        let loggedTime = this.readingLog[articleId] || 0;
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
                this.readingLog[articleId] = (this.readingLog[articleId] || 0) + sessionTime;
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
                
                // Get the logged time for this article
                const loggedTime = this.readingLog[normalizedUrl] || 0;
                
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

// Initialize the reader
console.log('📝 ABOUT TO CREATE FLIPBOARD READER INSTANCE');
console.log('🚨🚨🚨 SCRIPT LOADED AT:', new Date().toISOString());
console.log('🚨🚨🚨 READING TIME FIX VERSION: 4.0 - SYNTAX FIXED');
const reader = new FlipboardReader();
window.reader = reader; // Make it globally available
console.log('✅ FLIPBOARD READER INSTANCE CREATED SUCCESSFULLY');

// Don't load feed immediately - let the IPC data come through
// const defaultFeed = 'https://uxmag.com/feed';
// document.getElementById('rssUrl').value = defaultFeed;
// reader.loadFeed(defaultFeed); 

document.addEventListener('DOMContentLoaded', () => {
    window.reader = new FlipboardReader();
    
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