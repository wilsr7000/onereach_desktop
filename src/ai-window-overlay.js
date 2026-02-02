/**
 * AI Window Overlay
 * 
 * Provides floating controls for conversation capture:
 * - Recording status indicator
 * - Pause/Resume button
 * - "Don't Save This" button
 * - "Save to Space" button for manual copying
 * - Toast notifications for save/undo
 */

class AIWindowOverlay {
  constructor(aiService) {
    this.aiService = aiService;
    this.isPaused = false;
    this.currentDoNotSave = false;
    this.privateMode = false;
    this.toasts = [];
    
    this.init();
  }

  async init() {
    // Get initial state from main process
    try {
      this.isPaused = await window.api.conversation.isPaused();
      this.currentDoNotSave = await window.api.conversation.isMarkedDoNotSave(this.aiService);
    } catch (error) {
      console.error('[AIOverlay] Error getting initial state:', error);
    }

    // No UI overlay - user knows they're recording because they opened in Onereach app
    // Just listen for save notifications in case we need to handle them programmatically
    window.addEventListener('conversation-saved', (event) => {
      console.log('[AIOverlay] Conversation saved:', event.detail);
    });
  }

  injectStyles() {
    // No styles needed - no UI overlay
  }

  injectOverlay() {
    // No overlay needed - user knows they're recording
  }

  setupEventListeners() {
    // No event listeners needed - no UI
  }

  // All UI methods removed - no overlay displayed
}

// Auto-initialize when loaded
if (typeof window !== 'undefined' && window.location) {
  
  // Detect AI service from URL
  let aiService = 'Unknown';
  const url = window.location.href;
  
  if (url.includes('chatgpt.com') || url.includes('openai.com')) {
    aiService = 'ChatGPT';
  } else if (url.includes('claude.ai')) {
    aiService = 'Claude';
  } else if (url.includes('gemini.google.com') || url.includes('bard.google.com')) {
    aiService = 'Gemini';
  } else if (url.includes('perplexity.ai')) {
    aiService = 'Perplexity';
  } else if (url.includes('x.ai') || url.includes('grok.x.com') || url.includes('grok.com')) {
    aiService = 'Grok';
  }
  
  
  // For ChatGPT, intercept fetch to capture streaming responses
  if (aiService === 'ChatGPT') {
    console.log('[ChatGPT Interceptor] Setting up fetch interceptor for conversation capture...');
    
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
      const [input, init] = args;
      const url = typeof input === 'string' ? input : input.url;
      
      // Only intercept conversation API calls
      if (url && url.includes('/backend-api') && url.includes('conversation') && !url.includes('/init')) {
        console.log('[ChatGPT Interceptor] Intercepting conversation request:', url);
        
        try {
          const response = await originalFetch.apply(this, args);
          
          // Clone the response so we can read it and still return it
          const clonedResponse = response.clone();
          
          // Check if it's a streaming response
          const contentType = response.headers.get('content-type') || '';
          if (contentType.includes('text/event-stream') || contentType.includes('application/octet-stream')) {
            console.log('[ChatGPT Interceptor] Detected streaming response, capturing...');
            
            // Read the stream in the background
            (async () => {
              try {
                const reader = clonedResponse.body.getReader();
                const decoder = new TextDecoder();
                let fullText = '';
                let conversationId = null;
                
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  
                  const chunk = decoder.decode(value, { stream: true });
                  fullText += chunk;
                }
                
                console.log('[ChatGPT Interceptor] Stream complete, parsing SSE data...');
                
                // Parse SSE format
                const lines = fullText.split('\n');
                let assistantMessage = '';
                
                for (const line of lines) {
                  if (line.startsWith('data: ')) {
                    const data = line.substring(6);
                    if (data === '[DONE]') break;
                    
                    try {
                      const parsed = JSON.parse(data);
                      
                      // Extract conversation ID
                      if (parsed.conversation_id) {
                        conversationId = parsed.conversation_id;
                      }
                      
                      // Extract message content - ChatGPT format
                      if (parsed.message?.content?.parts) {
                        assistantMessage = parsed.message.content.parts.join('');
                      }
                      
                      // Also check for delta format
                      if (parsed.delta?.content) {
                        assistantMessage += parsed.delta.content;
                      }
                    } catch (e) {
                      // Not JSON, skip
                    }
                  }
                }
                
                if (assistantMessage && assistantMessage.length > 0) {
                  console.log('[ChatGPT Interceptor] Captured response:', assistantMessage.substring(0, 100) + '...');
                  console.log('[ChatGPT Interceptor] Conversation ID:', conversationId);
                  
                  // Send to main process via IPC
                  if (window.electronAPI && window.electronAPI.sendChatGPTResponse) {
                    window.electronAPI.sendChatGPTResponse({
                      conversationId: conversationId,
                      message: assistantMessage,
                      timestamp: new Date().toISOString()
                    });
                  } else if (window.api && window.api.send) {
                    window.api.send('chatgpt-response-captured', {
                      conversationId: conversationId,
                      message: assistantMessage,
                      timestamp: new Date().toISOString()
                    });
                  } else {
                    console.log('[ChatGPT Interceptor] No IPC channel available, logging response');
                    // Store in a global for debugging
                    window.__lastChatGPTResponse = {
                      conversationId: conversationId,
                      message: assistantMessage,
                      timestamp: new Date().toISOString()
                    };
                  }
                }
              } catch (err) {
                console.error('[ChatGPT Interceptor] Error reading stream:', err);
              }
            })();
          }
          
          return response;
        } catch (err) {
          console.error('[ChatGPT Interceptor] Error intercepting request:', err);
          return originalFetch.apply(this, args);
        }
      }
      
      return originalFetch.apply(this, args);
    };
    
    console.log('[ChatGPT Interceptor] Fetch interceptor installed');
  }
  
  // For Claude, monitor for artifact creation in the DOM
  if (aiService === 'Claude') {
    console.log('[Artifact Monitor] Setting up Claude artifact monitoring...');
    
    // Track captured artifacts to avoid duplicates
    const capturedHashes = new Set();
    
    // Helper to generate simple hash of content
    const simpleHash = (str) => {
      let hash = 0;
      for (let i = 0; i < Math.min(str.length, 500); i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
      }
      return hash.toString(36);
    };
    
    // Helper to check if element is in an artifact content area (not UI chrome)
    const isInArtifactContent = (element) => {
      try {
        let current = element;
        while (current && current !== document.body) {
          // Handle both regular className (string) and SVG className (SVGAnimatedString)
          const classValue = typeof current.className === 'string' 
            ? current.className 
            : (current.className?.baseVal || '');
          
          // Look for iframe or main content containers, not buttons/icons
          if (classValue.includes('artifact-frame') || 
              classValue.includes('artifact-content') ||
              current.tagName === 'IFRAME') {
            return true;
          }
          
          // Exclude if it's clearly UI chrome
          if (classValue.includes('button') || 
              classValue.includes('icon') || 
              classValue.includes('toolbar') ||
              classValue.includes('header')) {
            return false;
          }
          
          current = current.parentElement;
        }
        return false;
      } catch (e) {
        return false;
      }
    };
    
    // Watch for artifact panels being added to the DOM
    const artifactObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === 1) { // Element node
            try {
              // Check for SVG artifacts (but skip small icons)
              const svgs = node.querySelectorAll ? node.querySelectorAll('svg') : [];
              svgs.forEach(svg => {
                // Skip small SVGs (likely UI icons)
                const width = svg.getAttribute('width') || svg.viewBox?.baseVal?.width || 0;
                const height = svg.getAttribute('height') || svg.viewBox?.baseVal?.height || 0;
                
                if (width <= 32 && height <= 32) {
                  return; // Skip small icons
                }
                
                if (isInArtifactContent(svg)) {
                  const svgContent = svg.outerHTML;
                  if (svgContent && svgContent.length > 200) { // Substantial content only
                    const hash = simpleHash(svgContent);
                    if (!capturedHashes.has(hash)) {
                      capturedHashes.add(hash);
                      console.log('[Artifact Monitor] 📄 Captured SVG artifact (' + width + 'x' + height + '):', svgContent.substring(0, 150) + '...');
                      window.__capturedArtifacts = window.__capturedArtifacts || [];
                      window.__capturedArtifacts.push({
                        type: 'svg',
                        content: svgContent,
                        timestamp: new Date().toISOString()
                      });
                    }
                  }
                }
              });
              
              // Check for code artifacts
              const codeBlocks = node.querySelectorAll ? node.querySelectorAll('pre code, textarea') : [];
              codeBlocks.forEach(code => {
                if (code.textContent && code.textContent.length > 100 && isInArtifactContent(code)) {
                  const hash = simpleHash(code.textContent);
                  if (!capturedHashes.has(hash)) {
                    capturedHashes.add(hash);
                    console.log('[Artifact Monitor] 📄 Captured code artifact:', code.textContent.substring(0, 150) + '...');
                    window.__capturedArtifacts = window.__capturedArtifacts || [];
                    window.__capturedArtifacts.push({
                      type: 'code',
                      content: code.textContent,
                      timestamp: new Date().toISOString()
                    });
                  }
                }
              });
            } catch (e) {
              // Silently ignore errors in mutation processing
            }
          }
        }
      }
    });
    
    // Start observing after DOM loads
    setTimeout(() => {
      if (document.body) {
        artifactObserver.observe(document.body, {
          childList: true,
          subtree: true
        });
        console.log('[Artifact Monitor] ✅ Started watching for Claude artifacts');
      }
    }, 2000);
  }

  // Initialize overlay after page loads
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.aiOverlay = new AIWindowOverlay(aiService);
    });
  } else {
    window.aiOverlay = new AIWindowOverlay(aiService);
  }
}
