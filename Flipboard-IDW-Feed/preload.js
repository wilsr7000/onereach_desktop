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
    },
    
    // Text-to-Speech for articles
    generateArticleTTS: async (options) => {
        console.log('[TTS] Generating TTS for article');
        try {
            const result = await ipcRenderer.invoke('article:generate-tts', options);
            return result;
        } catch (error) {
            console.error('[TTS] Error generating TTS:', error);
            return { success: false, error: error.message };
        }
    },
    
    // Create audio script using GPT
    createAudioScript: async (options) => {
        console.log('[AudioScript] Creating audio script for:', options.title);
        try {
            const result = await ipcRenderer.invoke('clipboard:create-audio-script', {
                title: options.title,
                content: options.content
            });
            return result;
        } catch (error) {
            console.error('[AudioScript] Error creating script:', error);
            return { success: false, error: error?.message || 'Script creation failed' };
        }
    },
    
    // Generate TTS for a single chunk (for streaming playback)
    generateTTSChunk: async (options) => {
        console.log('[TTS] Generating chunk, length:', options.text?.length);
        try {
            const result = await ipcRenderer.invoke('clipboard:generate-speech', {
                text: options.text,
                voice: options.voice || 'nova'
            });
            return result;
        } catch (error) {
            console.error('[TTS] Error generating chunk:', error);
            return { success: false, error: error?.message || 'TTS failed' };
        }
    },
    
    generateArticleTTS: async (options) => {
        console.log('[TTS] Generating TTS for article:', options.articleId);
        try {
            // First, generate the speech using the same handler as Spaces Manager
            const speechResult = await ipcRenderer.invoke('clipboard:generate-speech', {
                text: options.text,
                voice: options.voice || 'nova'
            });
            
            console.log('[TTS] Speech generation result:', speechResult?.success);
            
            if (!speechResult.success) {
                return speechResult;
            }
            
            // Save to article-tts directory
            const saveResult = await ipcRenderer.invoke('article:save-tts', {
                articleId: options.articleId,
                audioData: speechResult.audioData
            });
            
            return { 
                success: true, 
                audioData: speechResult.audioData,
                saved: saveResult?.success 
            };
        } catch (error) {
            console.error('[TTS] Error generating TTS:', error);
            return { success: false, error: error?.message || 'TTS generation failed' };
        }
    },
    
    getArticleTTS: async (articleId) => {
        console.log('[TTS] Getting TTS for article:', articleId);
        try {
            const result = await ipcRenderer.invoke('article:get-tts', articleId);
            return result;
        } catch (error) {
            console.error('[TTS] Error getting TTS:', error);
            return { success: false, error: error.message };
        }
    },
    
    saveArticleTTS: async (options) => {
        console.log('[TTS] Saving TTS for article:', options.articleId);
        try {
            const result = await ipcRenderer.invoke('article:save-tts', options);
            return result;
        } catch (error) {
            console.error('[TTS] Error saving TTS:', error);
            return { success: false, error: error.message };
        }
    },
    
    // Persistent cache operations (saves to disk, survives app restart)
    saveCache: async (cacheName, data) => {
        try {
            const result = await ipcRenderer.invoke('cache:save', { cacheName, data });
            return result;
        } catch (error) {
            console.error(`[Cache] Error saving ${cacheName}:`, error);
            return { success: false, error: error.message };
        }
    },
    
    loadCache: async (cacheName) => {
        try {
            const result = await ipcRenderer.invoke('cache:load', cacheName);
            return result;
        } catch (error) {
            console.error(`[Cache] Error loading ${cacheName}:`, error);
            return { success: false, error: error.message };
        }
    },
    
    getSettings: async () => {
        try {
            const settings = await ipcRenderer.invoke('get-settings');
            return settings;
        } catch (error) {
            console.error('[Settings] Error getting settings:', error);
            return {};
        }
    }
};

// Expose the API with a unique name
try {
    contextBridge.exposeInMainWorld('flipboardAPI', api);
    console.log('API exposed successfully');
} catch (error) {
    console.error('Failed to expose API:', error);
} 