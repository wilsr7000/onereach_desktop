# Improved IDW Tab Tracking System

## Current Problems
- URL matching is fragile and prone to false positives/negatives
- IDW IDs aren't consistently tracked across all tab creation methods
- No single source of truth for "which IDW is this tab?"

## Proposed Solution: Metadata-Based Tracking

### 1. Enhanced Tab Metadata
Store comprehensive IDW info with each tab:

```javascript
// When creating ANY tab, detect if it's an IDW
function createNewTab(url) {
    const tab = createTabElement();
    
    // Detect and store IDW metadata
    const idwInfo = detectIDWFromURL(url);
    if (idwInfo) {
        tab.metadata = {
            type: 'idw',
            idwId: idwInfo.id,
            environment: idwInfo.environment,
            label: idwInfo.label,
            canonicalUrl: idwInfo.canonicalUrl,
            originalEntry: idwInfo  // Full IDW config
        };
    }
    
    return tab;
}

// Smart IDW detection
function detectIDWFromURL(url) {
    // Check against all known IDW patterns
    for (const env of getAllIDWEnvironments()) {
        if (isURLForIDW(url, env)) {
            return env;
        }
    }
    return null;
}

// Robust URL matching
function isURLForIDW(url, idwEnv) {
    const normalizedUrl = normalizeURL(url);
    const patterns = [
        idwEnv.homeUrl,
        idwEnv.chatUrl,
        // Also check common variations
        `https://idw.${idwEnv.environment}.onereach.ai/${idwEnv.id}`,
        `https://chat.${idwEnv.environment}.onereach.ai/*/${idwEnv.id}`,
    ];
    
    return patterns.some(pattern => 
        matchesPattern(normalizedUrl, pattern)
    );
}
```

### 2. Centralized IDW Registry
Single source of truth for all IDW states:

```javascript
class IDWRegistry {
    constructor() {
        this.environments = [];  // All configured IDWs
        this.openTabs = new Map();  // IDW ID -> Tab ID mapping
    }
    
    // Load IDW configurations
    loadEnvironments() {
        this.environments = readIDWConfig();
        this.validateEnvironments();
    }
    
    // Track tab-IDW associations
    registerTab(tabId, idwId) {
        this.openTabs.set(idwId, tabId);
    }
    
    unregisterTab(tabId) {
        for (const [idwId, tid] of this.openTabs) {
            if (tid === tabId) {
                this.openTabs.delete(idwId);
                break;
            }
        }
    }
    
    // Get available IDWs (not open)
    getAvailableIDWs() {
        return this.environments.filter(env => 
            !this.openTabs.has(env.id)
        );
    }
    
    // Check if IDW is open
    isIDWOpen(idwId) {
        return this.openTabs.has(idwId);
    }
}
```

### 3. URL Normalization
Consistent URL comparison:

```javascript
function normalizeURL(url) {
    try {
        const u = new URL(url);
        // Remove trailing slashes
        u.pathname = u.pathname.replace(/\/+$/, '');
        // Sort query parameters
        u.searchParams.sort();
        // Remove common tracking params
        u.searchParams.delete('utm_source');
        u.searchParams.delete('utm_medium');
        // Return canonical form
        return u.toString().toLowerCase();
    } catch {
        return url.toLowerCase();
    }
}
```

### 4. Persistent Tab State
Save tab-IDW associations:

```javascript
// Save state when tabs change
function saveTabState() {
    const tabState = tabs.map(tab => ({
        id: tab.id,
        url: tab.webview.src,
        metadata: tab.metadata,
        idwId: tab.metadata?.idwId
    }));
    
    localStorage.setItem('tabState', JSON.stringify(tabState));
}

// Restore on app launch
function restoreTabState() {
    const saved = localStorage.getItem('tabState');
    if (saved) {
        const tabState = JSON.parse(saved);
        tabState.forEach(state => {
            const tab = createNewTab(state.url);
            if (state.metadata) {
                tab.metadata = state.metadata;
            }
        });
    }
}
```

### 5. Webview Navigation Tracking
Track IDW changes within tabs:

```javascript
webview.addEventListener('did-navigate', (e) => {
    const newUrl = e.url;
    const oldIDW = tab.metadata?.idwId;
    const newIDW = detectIDWFromURL(newUrl);
    
    if (newIDW?.id !== oldIDW) {
        // IDW changed within same tab
        if (oldIDW) registry.unregisterTab(tab.id);
        if (newIDW) {
            tab.metadata = { ...newIDW };
            registry.registerTab(tab.id, newIDW.id);
        }
        
        // Update UI
        refreshPlusMenu();
    }
});
```

## Implementation Benefits

### Reliability Improvements
- ✅ No false positives/negatives in IDW detection
- ✅ Handles all tab creation methods consistently
- ✅ Survives URL changes and redirects
- ✅ Single source of truth for IDW state
- ✅ Persistent across app restarts

### Performance Benefits
- ✅ O(1) lookup for "is IDW open?" via Map
- ✅ No repeated URL parsing/comparison
- ✅ Cached IDW metadata reduces file I/O

### Maintainability
- ✅ Clear separation of concerns
- ✅ Centralized IDW logic
- ✅ Easier to test and debug
- ✅ Consistent behavior across features

## Migration Path

1. **Phase 1**: Add IDWRegistry alongside existing code
2. **Phase 2**: Update tab creation to use registry
3. **Phase 3**: Update plus menu to use registry.getAvailableIDWs()
4. **Phase 4**: Remove old URL matching logic
5. **Phase 5**: Add persistence and validation

## Testing Strategy

```javascript
// Unit tests for IDW detection
describe('IDW Detection', () => {
    test('detects IDW from home URL', () => {
        const url = 'https://idw.edison.onereach.ai/marvin-2';
        const idw = detectIDWFromURL(url);
        expect(idw.id).toBe('marvin-2');
    });
    
    test('detects IDW from chat URL', () => {
        const url = 'https://idw.edison.onereach.ai/chat/abc-123';
        const idw = detectIDWFromURL(url);
        expect(idw).toBeTruthy();
    });
    
    test('handles URL variations', () => {
        const urls = [
            'https://idw.edison.onereach.ai/marvin-2',
            'https://idw.edison.onereach.ai/marvin-2/',
            'https://idw.edison.onereach.ai/marvin-2?param=1',
        ];
        
        const idws = urls.map(detectIDWFromURL);
        expect(new Set(idws.map(i => i.id)).size).toBe(1);
    });
});
```

## Conclusion

The current URL-based matching is fragile. A metadata-based registry system would be:
- More reliable (no false matches)
- More performant (O(1) lookups)
- More maintainable (single source of truth)
- More robust (handles all edge cases)

This would be a significant improvement worth implementing in a future version.
