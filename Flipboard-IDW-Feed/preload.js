const { contextBridge, ipcRenderer } = require('electron');

// Create a unique namespace for our API
const api = {
    // RSS feed handling
    onRSSData: (callback) => {
        console.log('Setting up RSS data listener');
        const handleRSSData = (_, data) => {
            console.log('Received RSS data in preload:', {
                hasData: !!data,
                itemCount: data?.items?.length,
                firstItem: data?.items?.[0],
                dataKeys: Object.keys(data || {})
            });
            callback(data);
        };
        
        // Set up single listener
        ipcRenderer.on('rss-data-loaded', handleRSSData);
    },
    
    // Article handling - enhanced with better error handling
    fetchRSS: async (url) => {
        console.log('Fetching RSS feed:', url);
        try {
            const content = await ipcRenderer.invoke('fetch-rss', url);
            console.log('Received RSS content, length:', content?.length || 0);
            return content;
        } catch (error) {
            console.error('Error fetching RSS feed:', error);
            throw error;
        }
    },
    
    // Article content handling - separate from RSS feeds
    fetchArticle: async (url) => {
        console.log('Fetching article content:', url);
        try {
            const result = await ipcRenderer.invoke('fetch-article', url);
            console.log('Received article result:', result);
            
            // Handle both old format (string) and new format (object)
            if (typeof result === 'string') {
                console.log('Received article content (old format), length:', result.length);
                return result;
            } else if (result && result.content) {
                console.log('Received article content (new format), length:', result.content.length);
                console.log('🔥 READING TIME FROM MAIN PROCESS:', result.readingTime);
                console.log('📊 WORD COUNT FROM MAIN PROCESS:', result.wordCount);
                return result.content;
            } else {
                throw new Error('Invalid response format');
            }
        } catch (error) {
            console.error('Error fetching article content:', error);
            throw error;
        }
    },
    
    // URL handling - properly expose external link opening
    openUrl: (url) => {
        console.log('Opening external URL:', url);
        ipcRenderer.send('open-external-link', url);
    },

    // Reading log operations - enhanced with better error handling
    saveReadingLog: (log) => {
        console.log('Saving reading log');
        ipcRenderer.send('save-reading-log', log);
    },
    
    saveReadingLogSync: (log) => {
        console.log('Saving reading log synchronously');
        return ipcRenderer.sendSync('save-reading-log-sync', log);
    },
    
    loadReadingLog: async () => {
        console.log('Loading reading log');
        try {
            const log = await ipcRenderer.invoke('load-reading-log');
            console.log('Reading log loaded successfully');
            return log;
        } catch (error) {
            console.error('Error loading reading log:', error);
            return {};
        }
    },

    // Debug function to save content to file
    debugSaveContent: async (url, content) => {
        console.log('Saving debug content for:', url);
        try {
            const filepath = await ipcRenderer.invoke('debug-save-content', url, content);
            console.log('Debug content saved to:', filepath);
            return filepath;
        } catch (error) {
            console.error('Error saving debug content:', error);
            return null;
        }
    },

    // Listen for reading time updates from main process
    onReadingTimeUpdate: (callback) => {
        console.log('Setting up reading time update listener');
        const handleReadingTime = (_, data) => {
            console.log('🔥 RECEIVED READING TIME UPDATE:', data);
            callback(data);
        };
        
        ipcRenderer.on('article-reading-time', handleReadingTime);
    }
};

// Expose the API with a unique name
try {
    contextBridge.exposeInMainWorld('flipboardAPI', api);
    console.log('API exposed successfully');
} catch (error) {
    console.error('Failed to expose API:', error);
} 