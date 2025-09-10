const { contextBridge, ipcRenderer, shell } = require('electron');

console.log('Flipboard feed preload script starting...');

// Remove all existing listeners
ipcRenderer.removeAllListeners();

// Track if we've already sent RSS data to prevent duplicates
let rssSent = false;

// Create a unique namespace for our API
const api = {
    // RSS feed handling
    onRSSData: (callback) => {
        console.log('Setting up RSS data listener');
        const handleRSSData = (_, data) => {
            // Allow fresh data through even if we've sent cached data
            if (rssSent && data.fromCache) {
                console.log('Skipping duplicate cached data');
                return;
            }
            
            // Mark as sent only for cached data
            if (data.fromCache) {
                rssSent = true;
            }
            
            console.log(`Received ${data.fromCache ? 'cached' : 'fresh'} RSS data`);

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
    
    // Article handling
    fetchRSS: async (url) => {
        console.log('Fetching RSS/Article:', url);
        try {
            const content = await ipcRenderer.invoke('fetch-rss', url);
            console.log('Received content, length:', content?.length || 0);
            return content;
        } catch (error) {
            console.error('Error fetching RSS/Article:', error);
            throw error;
        }
    },
    
    // URL handling
    openUrl: (url) => {
        ipcRenderer.send('open-url', { url });
    },

    // Add additional methods for persisting the reading log
    saveReadingLog: (log) => ipcRenderer.send('save-reading-log', log),
    saveReadingLogSync: (log) => ipcRenderer.sendSync('save-reading-log-sync', log),
    loadReadingLog: () => ipcRenderer.invoke('load-reading-log'),

    // New method for opening external links
    openExternal: (url) => {
        // Use shell.openExternal for URLs
        ipcRenderer.send('open-external-link', url);
    }
};

// Expose the API with a unique name
try {
    contextBridge.exposeInMainWorld('flipboardAPI', api);
} catch (error) {
    console.error('Failed to expose API:', error);
}

// Reset flag when window is reloaded
window.addEventListener('beforeunload', () => {
    rssSent = false;
});

console.log('Flipboard feed preload script complete');

// Assuming you have a function to create tiles
function createTile(item) {
    const tile = document.createElement('div');
    tile.classList.add('tile');
    tile.innerHTML = `
        <div class="tile-content">
            <h2>${item.title}</h2>
            <p>${item.description}</p>
        </div>
    `;

    // Add click event listener to open the article
    tile.addEventListener('click', () => {
        console.log('Tile clicked:', item.title); // Debugging log
        openArticle(item);
    });

    return tile;
}

// Example of adding tiles to the grid
function addTilesToGrid(items) {
    const grid = document.querySelector('.grid');
    items.forEach(item => {
        const tile = createTile(item);
        grid.appendChild(tile);
    });
}

function openArticle(item) {
    console.log('Opening article:', item.title); // Debugging log
    const viewer = document.getElementById('article-viewer');
    const titleEl = document.getElementById('article-title');
    const contentEl = document.getElementById('article-content');
    
    if (viewer && titleEl && contentEl) {
        // Set the title
        titleEl.innerHTML = item.title || 'No Title';
        // Display the full item content (using the 'content' field, which you populate from <content:encoded>)
        contentEl.innerHTML = item.content 
                             ? item.content 
                             : (item.description || 'No Content Available');
        
        // Show the overlay
        viewer.style.display = "block";
    } else {
        console.error("Error: Article viewer elements not found.");
    }
} 