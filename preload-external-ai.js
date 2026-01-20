// Preload script for external AI windows (ChatGPT, Claude, etc.)
// This script provides clipboard functionality and other necessary APIs
const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Function to detect AI service and set up interceptors
// Must be called after page navigation starts
let chatGPTInterceptorInstalled = false;
let grokInterceptorInstalled = false;
let geminiInterceptorInstalled = false;

function setupChatGPTInterceptor() {
  // Prevent duplicate installation
  if (chatGPTInterceptorInstalled) {
    return;
  }
  
  const currentUrl = window.location?.href || '';
  
  // Only set up for ChatGPT
  if (!currentUrl.includes('chatgpt.com') && !currentUrl.includes('openai.com')) {
    return;
  }
  
  chatGPTInterceptorInstalled = true;
  console.log('[ChatGPT Preload] Detected ChatGPT, setting up fetch interceptor...');
  
  webFrame.executeJavaScript(`
    (function() {
      // Prevent duplicate installation
      if (window.__chatgptInterceptorInstalled) {
        console.log('[ChatGPT Interceptor] Already installed, skipping');
        return;
      }
      window.__chatgptInterceptorInstalled = true;
      
      console.log('[ChatGPT Interceptor] Installing fetch interceptor...');
      
      const originalFetch = window.fetch;
      window.fetch = async function(...args) {
        const [input, init] = args;
        const url = typeof input === 'string' ? input : (input?.url || '');
        
        // Only intercept actual conversation POST requests (not init, not GET, not autocompletions)
        const isConversationPost = url.includes('/backend-api') && 
                                   url.includes('/conversation') && 
                                   !url.includes('/init') &&
                                   !url.includes('/prepare') &&
                                   !url.includes('/stream_status') &&
                                   !url.includes('/textdocs') &&
                                   !url.includes('conversations?') &&
                                   !url.includes('/gizmos/') &&
                                   !url.includes('/autocompletions');
        
        if (isConversationPost) {
          console.log('[ChatGPT Interceptor] Intercepting conversation:', url);
          
          try {
            const response = await originalFetch.apply(this, args);
            const clonedResponse = response.clone();
            
            // Check for streaming response
            const contentType = response.headers.get('content-type') || '';
            console.log('[ChatGPT Interceptor] Response content-type:', contentType);
            
            if (contentType.includes('text/event-stream') || contentType.includes('octet-stream') || contentType.includes('application/json')) {
              console.log('[ChatGPT Interceptor] Capturing streaming response...');
              
              // Read stream in background
              (async () => {
                try {
                  const reader = clonedResponse.body.getReader();
                  const decoder = new TextDecoder();
                  let fullText = '';
                  
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    fullText += decoder.decode(value, { stream: true });
                  }
                  
                  console.log('[ChatGPT Interceptor] Stream complete, length:', fullText.length);
                  
                  // Parse SSE data - ChatGPT uses delta encoding (v1)
                  let conversationId = null;
                  let assistantMessage = '';
                  let isDeltaEncoding = false;
                  
                  // Split on actual newlines
                  const lines = fullText.split(/\\r?\\n/);
                  console.log('[ChatGPT Interceptor] Total lines:', lines.length);
                  
                  // Check for delta encoding
                  if (fullText.includes('delta_encoding') || fullText.includes('"v1"')) {
                    isDeltaEncoding = true;
                    console.log('[ChatGPT Interceptor] Detected delta encoding format');
                  }
                  
                  for (const line of lines) {
                    if (line.startsWith('data: ')) {
                      const data = line.substring(6).trim();
                      if (data === '[DONE]' || data === '"v1"') continue;
                      if (!data) continue;
                      
                      try {
                        const parsed = JSON.parse(data);
                        
                        // Get conversation ID from resume token
                        if (parsed.conversation_id) {
                          conversationId = parsed.conversation_id;
                        }
                        
                        // Handle delta encoding format (p=path, o=operation, v=value)
                        if (isDeltaEncoding && parsed.v !== undefined) {
                          // Delta format: p is path like "/message/content/parts/0"
                          // v is the value (text content for message deltas)
                          const path = parsed.p || '';
                          
                          // Check if this is a message content delta
                          if (path.includes('/message/content/parts') || path.includes('/content/parts')) {
                            if (typeof parsed.v === 'string') {
                              assistantMessage += parsed.v;
                            }
                          }
                          // Also capture from other text paths
                          else if (path.includes('/text') || path === '') {
                            if (typeof parsed.v === 'string' && parsed.v.length > 0) {
                              // Only append if it looks like text content, not metadata
                              if (!parsed.v.startsWith('{') && !parsed.v.startsWith('[')) {
                                assistantMessage += parsed.v;
                              }
                            }
                          }
                        }
                        
                        // Also handle non-delta format (fallback)
                        if (parsed.message?.content?.parts && Array.isArray(parsed.message.content.parts)) {
                          const text = parsed.message.content.parts.join('');
                          if (text && text.length > assistantMessage.length) {
                            assistantMessage = text;
                          }
                        }
                        // OpenAI API streaming format
                        if (parsed.choices?.[0]?.delta?.content) {
                          assistantMessage += parsed.choices[0].delta.content;
                        }
                      } catch (e) {
                        // Skip non-JSON lines
                      }
                    }
                  }
                  
                  console.log('[ChatGPT Interceptor] Delta encoding:', isDeltaEncoding, 'Message length:', assistantMessage.length);
                  
                  console.log('[ChatGPT Interceptor] Parsed - conversationId:', conversationId, 'messageLen:', assistantMessage.length);
                  
                  if (assistantMessage && assistantMessage.length > 0) {
                    console.log('[ChatGPT Interceptor] ✅ Captured response (' + assistantMessage.length + ' chars)');
                    
                    // Use postMessage to cross context boundary
                    window.postMessage({
                      type: '__CHATGPT_RESPONSE__',
                      conversationId: conversationId,
                      message: assistantMessage
                    }, '*');
                  } else {
                    console.log('[ChatGPT Interceptor] No assistant message found in stream');
                  }
                } catch (err) {
                  console.error('[ChatGPT Interceptor] Stream error:', err);
                }
              })();
            }
            
            return response;
          } catch (err) {
            console.error('[ChatGPT Interceptor] Fetch error:', err);
            return originalFetch.apply(this, args);
          }
        }
        
        return originalFetch.apply(this, args);
      };
      
      console.log('[ChatGPT Interceptor] Fetch interceptor installed');
    })();
  `).then(() => {
    console.log('[ChatGPT Preload] Fetch interceptor injected successfully');
  }).catch(err => {
    console.error('[ChatGPT Preload] Failed to inject fetch interceptor:', err);
  });
  
  // Listen for postMessage from the page context
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === '__CHATGPT_RESPONSE__') {
      console.log('[ChatGPT Preload] Received response via postMessage');
      const { conversationId, message } = event.data;
      if (message) {
        console.log('[ChatGPT Preload] Sending to main process, message length:', message.length);
        ipcRenderer.send('chatgpt-response-captured', {
          conversationId,
          message,
          timestamp: new Date().toISOString()
        });
      }
    }
  });
}

// Grok (X.ai) fetch interceptor
function setupGrokInterceptor() {
  // Prevent duplicate installation
  if (grokInterceptorInstalled) {
    return;
  }
  
  const currentUrl = window.location?.href || '';
  
  // Only set up for Grok (x.ai, grok.x.com, or grok.com)
  if (!currentUrl.includes('x.ai') && !currentUrl.includes('grok.x.com') && !currentUrl.includes('grok.com')) {
    return;
  }
  
  grokInterceptorInstalled = true;
  console.log('[Grok Preload] Detected Grok, setting up fetch interceptor...');
  
  webFrame.executeJavaScript(`
    (function() {
      // Prevent duplicate installation
      if (window.__grokInterceptorInstalled) {
        console.log('[Grok Interceptor] Already installed, skipping');
        return;
      }
      window.__grokInterceptorInstalled = true;
      
      console.log('[Grok Interceptor] Installing fetch interceptor...');
      
      const originalFetch = window.fetch;
      window.fetch = async function(...args) {
        const [input, init] = args;
        const url = typeof input === 'string' ? input : (input?.url || '');
        
        // Grok API endpoints - capture new conversations and follow-up responses
        const isGrokConversation = url.includes('/rest/app-chat/conversations/new') ||
                                   url.includes('/responses') ||
                                   (url.includes('/rest/app-chat/conversations_v2/') && !url.includes('?'));
        
        if (isGrokConversation) {
          console.log('[Grok Interceptor] Intercepting conversation:', url);
          
          try {
            const response = await originalFetch.apply(this, args);
            const clonedResponse = response.clone();
            
            const contentType = response.headers.get('content-type') || '';
            console.log('[Grok Interceptor] Response content-type:', contentType);
            
            if (contentType.includes('text/event-stream') || contentType.includes('octet-stream') || contentType.includes('application/json') || contentType.includes('text/plain')) {
              console.log('[Grok Interceptor] Capturing response...');
              
              (async () => {
                try {
                  const reader = clonedResponse.body.getReader();
                  const decoder = new TextDecoder();
                  let fullText = '';
                  
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    fullText += decoder.decode(value, { stream: true });
                  }
                  
                  console.log('[Grok Interceptor] Stream complete, length:', fullText.length);
                  console.log('[Grok Interceptor] Raw sample:', fullText.substring(0, 500));
                  
                  let conversationId = null;
                  let assistantMessage = '';
                  
                  // Grok uses NDJSON format (newline-delimited JSON)
                  // Each line is a separate JSON object
                  const lines = fullText.split(/\\r?\\n/).filter(line => line.trim());
                  console.log('[Grok Interceptor] NDJSON lines:', lines.length);
                  
                  // Try to extract conversation ID from URL for follow-up messages
                  const urlConvMatch = url.match(/conversations\\/([a-f0-9-]+)/i);
                  if (urlConvMatch) {
                    conversationId = urlConvMatch[1];
                    console.log('[Grok Interceptor] Got conversationId from URL:', conversationId);
                  }
                  
                  for (const line of lines) {
                    try {
                      const parsed = JSON.parse(line);
                      
                      // Get conversation ID from result.conversation (new conversation format)
                      if (parsed.result?.conversation?.conversationId) {
                        conversationId = parsed.result.conversation.conversationId;
                      }
                      
                      // Format 1: New conversation - result.response.modelResponse
                      if (parsed.result?.response?.modelResponse?.message) {
                        const msg = parsed.result.response.modelResponse.message;
                        if (msg && msg.length > assistantMessage.length) {
                          assistantMessage = msg;
                          console.log('[Grok Interceptor] Found response.modelResponse.message:', msg.substring(0, 100));
                        }
                      }
                      
                      // Format 2: Follow-up response - result.modelResponse (direct)
                      if (parsed.result?.modelResponse?.message) {
                        const msg = parsed.result.modelResponse.message;
                        if (msg && msg.length > assistantMessage.length) {
                          assistantMessage = msg;
                          console.log('[Grok Interceptor] Found modelResponse.message:', msg.substring(0, 100));
                        }
                      }
                      
                      // Token streaming (partial responses)
                      if (parsed.result?.response?.token) {
                        assistantMessage += parsed.result.response.token;
                      }
                      if (parsed.result?.token) {
                        assistantMessage += parsed.result.token;
                      }
                      
                      // Alternative paths
                      if (parsed.result?.response?.message) {
                        const msg = parsed.result.response.message;
                        if (msg && msg.length > assistantMessage.length) {
                          assistantMessage = msg;
                        }
                      }
                    } catch (e) {
                      // Skip non-JSON lines
                    }
                  }
                  
                  console.log('[Grok Interceptor] Parsed - conversationId:', conversationId, 'messageLen:', assistantMessage.length);
                  
                  if (assistantMessage && assistantMessage.length > 0) {
                    console.log('[Grok Interceptor] ✅ Captured response (' + assistantMessage.length + ' chars)');
                    
                    window.postMessage({
                      type: '__GROK_RESPONSE__',
                      conversationId: conversationId,
                      message: assistantMessage
                    }, '*');
                  } else {
                    console.log('[Grok Interceptor] No message found in response');
                  }
                } catch (err) {
                  console.error('[Grok Interceptor] Stream error:', err);
                }
              })();
            }
            
            return response;
          } catch (err) {
            console.error('[Grok Interceptor] Fetch error:', err);
            return originalFetch.apply(this, args);
          }
        }
        
        return originalFetch.apply(this, args);
      };
      
      console.log('[Grok Interceptor] Fetch interceptor installed');
    })();
  `).then(() => {
    console.log('[Grok Preload] Fetch interceptor injected successfully');
  }).catch(err => {
    console.error('[Grok Preload] Failed to inject fetch interceptor:', err);
  });
  
  // Listen for postMessage from the page context
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === '__GROK_RESPONSE__') {
      console.log('[Grok Preload] Received response via postMessage');
      const { conversationId, message } = event.data;
      if (message) {
        console.log('[Grok Preload] Sending to main process, message length:', message.length);
        ipcRenderer.send('grok-response-captured', {
          conversationId,
          message,
          timestamp: new Date().toISOString()
        });
      }
    }
  });
}

// Gemini (Google) fetch interceptor
function setupGeminiInterceptor() {
  // Prevent duplicate installation
  if (geminiInterceptorInstalled) {
    return;
  }
  
  const currentUrl = window.location?.href || '';
  
  // Only set up for Gemini
  if (!currentUrl.includes('gemini.google.com') && !currentUrl.includes('bard.google.com')) {
    return;
  }
  
  geminiInterceptorInstalled = true;
  console.log('[Gemini Preload] Detected Gemini, setting up fetch interceptor...');
  
  webFrame.executeJavaScript(`
    (function() {
      // Prevent duplicate installation
      if (window.__geminiInterceptorInstalled) {
        console.log('[Gemini Interceptor] Already installed, skipping');
        return;
      }
      window.__geminiInterceptorInstalled = true;
      
      console.log('[Gemini Interceptor] Installing fetch and XHR interceptor...');
      
      // Also intercept XMLHttpRequest since Gemini might use XHR
      const originalXHROpen = XMLHttpRequest.prototype.open;
      const originalXHRSend = XMLHttpRequest.prototype.send;
      
      XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this._geminiUrl = url;
        this._geminiMethod = method;
        return originalXHROpen.apply(this, [method, url, ...rest]);
      };
      
      XMLHttpRequest.prototype.send = function(body) {
        const url = this._geminiUrl || '';
        const method = this._geminiMethod || 'GET';
        
        // Log POST requests to Gemini
        if (method === 'POST' && (url.includes('gemini.google.com') || url.includes('bard'))) {
          console.log('[Gemini XHR] POST:', url.substring(0, 200));
        }
        
        // Intercept conversation responses - focus on StreamGenerate which has actual AI responses
        if (method === 'POST' && url.includes('StreamGenerate')) {
          console.log('[Gemini XHR] Intercepting StreamGenerate conversation');
          
          this.addEventListener('load', function() {
            try {
              const responseText = this.responseText;
              console.log('[Gemini XHR] StreamGenerate response length:', responseText?.length);
              
              if (responseText && responseText.length > 500) {
                let assistantMessage = '';
                let conversationId = null;
                
                // Look for conversation ID pattern: c_XXXXX
                const convMatch = responseText.match(/c_([a-f0-9]+)/);
                if (convMatch) {
                  conversationId = convMatch[1];
                  console.log('[Gemini XHR] Found conversation ID:', conversationId);
                }
                
                // Gemini StreamGenerate has deeply nested JSON with actual text
                // Look for text patterns that indicate real conversation content
                // The format is often: ["Actual message text", ...] or "7":["text"]
                
                const extractedTexts = [];
                
                // Method 1: Look for text in specific Gemini response patterns
                // Pattern like: ["Some actual text here",null,null,...]
                // Avoid JSON-like strings that start with [ or {
                const textPatterns = [
                  /\\["']([^"'\\[\\]{}]{15,500})["']/g,  // Quoted text not starting with brackets
                  /\\[["']([A-Z][^"'\\[\\]{}]{10,500})["']\\]/g,  // Arrays with capitalized text
                ];
                
                for (const pattern of textPatterns) {
                  let match;
                  while ((match = pattern.exec(responseText)) !== null) {
                    const text = match[1];
                    if (text && 
                        !text.startsWith('http') &&
                        !text.startsWith('/') &&
                        !text.startsWith('data:') &&
                        !text.includes('google.com') &&
                        !text.includes('gstatic') &&
                        !text.includes('.svg') &&
                        !text.includes('.png') &&
                        !text.match(/^[a-f0-9_-]{16,}$/i) &&
                        !text.match(/^[A-Z0-9_]{6,}$/) &&
                        !text.match(/^MESSAGE_TYPE/) &&
                        !text.match(/^SWML_|^boq_/) &&
                        !text.match(/^rc_|^r_|^c_/) &&
                        !text.includes('wrb.fr') &&
                        !text.startsWith('null') &&
                        !text.startsWith('[') &&
                        !text.startsWith('{') &&
                        /[a-zA-Z\\s]{8,}/.test(text) &&
                        text.split(' ').length >= 2) {
                      extractedTexts.push(text);
                    }
                  }
                }
                
                // Method 2: Direct regex for readable text (fallback)
                if (extractedTexts.length === 0) {
                  // Look for strings that look like natural language
                  const simpleMatches = responseText.match(/"([A-Z][a-z][^"]{8,200})"/g);
                  if (simpleMatches) {
                    for (const m of simpleMatches) {
                      const text = m.slice(1, -1);
                      if (!text.includes('google') &&
                          !text.includes('http') &&
                          !text.startsWith('/') &&
                          !text.match(/^[A-Z_]+$/) &&
                          text.split(' ').length >= 2) {
                        extractedTexts.push(text);
                      }
                    }
                  }
                }
                
                if (extractedTexts.length > 0) {
                  // Take the longest meaningful text
                  const uniqueTexts = [...new Set(extractedTexts)].sort((a, b) => b.length - a.length);
                  assistantMessage = uniqueTexts[0];
                  console.log('[Gemini XHR] StreamGenerate extracted', extractedTexts.length, 'text segments');
                  console.log('[Gemini XHR] Message preview:', assistantMessage.substring(0, 150));
                }
                
                if (assistantMessage && assistantMessage.length > 10) {
                  console.log('[Gemini XHR] ✅ StreamGenerate captured (' + assistantMessage.length + ' chars)');
                  
                  window.postMessage({
                    type: '__GEMINI_RESPONSE__',
                    conversationId: conversationId,
                    message: assistantMessage
                  }, '*');
                } else {
                  console.log('[Gemini XHR] StreamGenerate: No meaningful message extracted');
                  // Don't send raw JSON - batchexecute will likely have the response
                }
              }
            } catch (e) {
              console.error('[Gemini XHR] Error parsing StreamGenerate:', e);
            }
          });
        } else if (method === 'POST' && url.includes('batchexecute')) {
          // Also capture batchexecute responses that might contain conversation content
          this.addEventListener('load', function() {
            const responseText = this.responseText;
            if (responseText && responseText.length > 5000) {
              console.log('[Gemini XHR] Large batchexecute response:', responseText.length, 'bytes');
              
              // Check if this looks like a conversation response (contains message-like content)
              // Look for patterns that indicate actual AI response text
              if (responseText.includes('MESSAGE_TYPE') || 
                  (responseText.match(/c_[a-f0-9]{16}/) && responseText.length > 10000)) {
                console.log('[Gemini XHR] Detected potential conversation in batchexecute');
                
                try {
                  let assistantMessage = '';
                  let conversationId = null;
                  
                  // Extract conversation ID
                  const convMatch = responseText.match(/c_([a-f0-9]+)/);
                  if (convMatch) {
                    conversationId = convMatch[1];
                    console.log('[Gemini XHR] Found conversation ID:', conversationId);
                  }
                  
                  // Extract meaningful text using regex
                  // Look for quoted strings that are likely conversation content
                  const textMatches = responseText.match(/"([^"]{10,5000})"/g);
                  const extractedTexts = [];
                  
                  if (textMatches) {
                    for (const m of textMatches) {
                      const t = m.slice(1, -1);
                      // Filter out metadata, URLs, IDs, base64, etc.
                      if (!t.startsWith('http') && 
                          !t.startsWith('/') &&
                          !t.startsWith('data:') &&
                          !t.startsWith('\\\\u') &&
                          !t.includes('google.com') &&
                          !t.includes('gstatic') &&
                          !t.includes('googleusercontent') &&
                          !t.includes('.svg') &&
                          !t.includes('.png') &&
                          !t.includes('.jpg') &&
                          !t.match(/^[a-f0-9_-]{16,}$/i) &&
                          !t.match(/^[A-Z0-9_]{8,}$/) &&
                          !t.match(/^[A-Za-z0-9+\\/=]{40,}$/) && // base64
                          !t.includes('wrb.fr') &&
                          !t.match(/^rc_|^r_|^c_/) &&
                          !t.match(/^MESSAGE_TYPE/) &&
                          !t.match(/^SWML_/) &&
                          !t.match(/^boq_/) &&
                          /[a-zA-Z]/.test(t) && // Must have letters
                          t.split(' ').length >= 2) { // Must have at least 2 words
                        extractedTexts.push(t);
                      }
                    }
                  }
                  
                  if (extractedTexts.length > 0) {
                    // Take the longest meaningful text
                    const uniqueTexts = [...new Set(extractedTexts)].sort((a, b) => b.length - a.length);
                    assistantMessage = uniqueTexts[0];
                    console.log('[Gemini XHR] Extracted', extractedTexts.length, 'text segments from batchexecute');
                    console.log('[Gemini XHR] Message preview:', assistantMessage.substring(0, 150));
                  }
                  
                  if (assistantMessage && assistantMessage.length > 20) {
                    console.log('[Gemini XHR] ✅ Captured batchexecute response (' + assistantMessage.length + ' chars)');
                    
                    window.postMessage({
                      type: '__GEMINI_RESPONSE__',
                      conversationId: conversationId,
                      message: assistantMessage
                    }, '*');
                  }
                } catch (e) {
                  console.error('[Gemini XHR] Error parsing batchexecute:', e);
                }
              }
            }
          });
        }
        
        return originalXHRSend.apply(this, [body]);
      };
      
      const originalFetch = window.fetch;
      window.fetch = async function(...args) {
        const [input, init] = args;
        const url = typeof input === 'string' ? input : (input?.url || '');
        
        // Gemini uses various API endpoints for conversations
        // Common patterns: /_/BardChatUi/data/..., /batchexecute, StreamGenerate, etc.
        // Exclude CSP reports and tracking
        const isNotTracking = !url.includes('cspreport') && 
                              !url.includes('/csp/') && 
                              !url.includes('googletagmanager') &&
                              !url.includes('google-analytics') &&
                              !url.includes('/measurement/') &&
                              !url.includes('/pagead/') &&
                              !url.includes('/ccm/collect');
        
        const isGeminiConversation = isNotTracking && init?.method === 'POST' && (
          url.includes('batchexecute') ||
          url.includes('StreamGenerate') ||
          (url.includes('BardChatUi') && url.includes('/data/')) ||
          url.includes('/generate') ||
          url.includes('/assistant')
        );
        
        // Debug logging for POST requests to Gemini domains (excluding tracking)
        if ((url.includes('gemini.google.com') || url.includes('bard.google.com')) && 
            init?.method === 'POST' && isNotTracking) {
          console.log('[Gemini Interceptor] POST Request:', url.substring(0, 200));
        }
        
        if (isGeminiConversation) {
          console.log('[Gemini Interceptor] Intercepting conversation:', url);
          
          try {
            const response = await originalFetch.apply(this, args);
            const clonedResponse = response.clone();
            
            const contentType = response.headers.get('content-type') || '';
            console.log('[Gemini Interceptor] Response content-type:', contentType);
            
            // Gemini can return various content types
            if (contentType.includes('text/event-stream') || 
                contentType.includes('application/json') || 
                contentType.includes('text/plain') ||
                contentType.includes('application/x-protobuf') ||
                contentType.includes('octet-stream')) {
              console.log('[Gemini Interceptor] Capturing response...');
              
              (async () => {
                try {
                  const reader = clonedResponse.body.getReader();
                  const decoder = new TextDecoder();
                  let fullText = '';
                  
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    fullText += decoder.decode(value, { stream: true });
                  }
                  
                  console.log('[Gemini Interceptor] Response complete, length:', fullText.length);
                  
                  // Debug: log first part of response to understand format
                  if (fullText.length > 0) {
                    console.log('[Gemini Interceptor] Response sample:', fullText.substring(0, 500));
                  }
                  
                  let conversationId = null;
                  let assistantMessage = '';
                  
                  // Try multiple parsing strategies for Gemini's response format
                  
                  // Strategy 1: SSE format (data: lines)
                  if (fullText.includes('data:')) {
                    const lines = fullText.split(/\\r?\\n/);
                    for (const line of lines) {
                      if (line.startsWith('data:')) {
                        const data = line.substring(5).trim();
                        if (!data || data === '[DONE]') continue;
                        
                        try {
                          const parsed = JSON.parse(data);
                          
                          // Extract conversation ID if available
                          if (parsed.conversationId) {
                            conversationId = parsed.conversationId;
                          }
                          
                          // Gemini API format: candidates[].content.parts[].text
                          if (parsed.candidates && Array.isArray(parsed.candidates)) {
                            for (const candidate of parsed.candidates) {
                              if (candidate.content?.parts) {
                                for (const part of candidate.content.parts) {
                                  if (part.text) {
                                    assistantMessage += part.text;
                                  }
                                }
                              }
                            }
                          }
                          
                          // Alternative format: direct text field
                          if (parsed.text) {
                            assistantMessage += parsed.text;
                          }
                          
                          // Another format: modelOutput
                          if (parsed.modelOutput) {
                            if (typeof parsed.modelOutput === 'string') {
                              assistantMessage += parsed.modelOutput;
                            } else if (parsed.modelOutput.text) {
                              assistantMessage += parsed.modelOutput.text;
                            }
                          }
                        } catch (e) {
                          // Skip non-JSON lines
                        }
                      }
                    }
                  }
                  
                  // Strategy 2: Gemini web app format (nested arrays/protobuf-like JSON)
                  // Gemini web responses are often in a specific nested format
                  if (!assistantMessage && fullText.startsWith('[')) {
                    try {
                      // Gemini web uses )]}' prefix sometimes
                      let jsonText = fullText;
                      if (jsonText.startsWith(")]}'")) {
                        jsonText = jsonText.substring(4).trim();
                      }
                      
                      // Try to parse as JSON array
                      const parsed = JSON.parse(jsonText);
                      
                      // Navigate Gemini's nested structure
                      // Typical path: [0][2] or [0][4] contains the response text
                      function extractText(obj, depth = 0) {
                        if (depth > 10) return ''; // Prevent infinite recursion
                        if (typeof obj === 'string' && obj.length > 50) {
                          // Likely a message if it's a long string
                          return obj;
                        }
                        if (Array.isArray(obj)) {
                          for (const item of obj) {
                            const text = extractText(item, depth + 1);
                            if (text && text.length > assistantMessage.length) {
                              return text;
                            }
                          }
                        }
                        if (obj && typeof obj === 'object') {
                          // Check common text fields
                          if (obj.text && typeof obj.text === 'string') return obj.text;
                          if (obj.content && typeof obj.content === 'string') return obj.content;
                          if (obj.message && typeof obj.message === 'string') return obj.message;
                          
                          // Recurse into object values
                          for (const value of Object.values(obj)) {
                            const text = extractText(value, depth + 1);
                            if (text && text.length > 50) return text;
                          }
                        }
                        return '';
                      }
                      
                      const extracted = extractText(parsed);
                      if (extracted && extracted.length > assistantMessage.length) {
                        assistantMessage = extracted;
                      }
                      
                    } catch (e) {
                      console.log('[Gemini Interceptor] JSON parse error:', e.message);
                    }
                  }
                  
                  // Strategy 3: Plain text or NDJSON
                  if (!assistantMessage && fullText.trim()) {
                    const lines = fullText.split(/\\r?\\n/).filter(l => l.trim());
                    for (const line of lines) {
                      try {
                        const parsed = JSON.parse(line);
                        
                        // Look for text content in various formats
                        if (parsed.candidates?.[0]?.content?.parts?.[0]?.text) {
                          const text = parsed.candidates[0].content.parts[0].text;
                          if (text.length > assistantMessage.length) {
                            assistantMessage = text;
                          }
                        }
                        
                        // Get conversation ID
                        if (parsed.conversationId || parsed.conversation_id) {
                          conversationId = parsed.conversationId || parsed.conversation_id;
                        }
                      } catch (e) {
                        // Not JSON, might be plain text response
                      }
                    }
                  }
                  
                  console.log('[Gemini Interceptor] Parsed - conversationId:', conversationId, 'messageLen:', assistantMessage.length);
                  
                  if (assistantMessage && assistantMessage.length > 0) {
                    console.log('[Gemini Interceptor] ✅ Captured response (' + assistantMessage.length + ' chars)');
                    
                    window.postMessage({
                      type: '__GEMINI_RESPONSE__',
                      conversationId: conversationId,
                      message: assistantMessage
                    }, '*');
                  } else {
                    console.log('[Gemini Interceptor] No message found in response');
                  }
                } catch (err) {
                  console.error('[Gemini Interceptor] Stream error:', err);
                }
              })();
            }
            
            return response;
          } catch (err) {
            console.error('[Gemini Interceptor] Fetch error:', err);
            return originalFetch.apply(this, args);
          }
        }
        
        return originalFetch.apply(this, args);
      };
      
      console.log('[Gemini Interceptor] Fetch interceptor installed');
    })();
  `).then(() => {
    console.log('[Gemini Preload] Fetch interceptor injected successfully');
  }).catch(err => {
    console.error('[Gemini Preload] Failed to inject fetch interceptor:', err);
  });
  
  // Listen for postMessage from the page context
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === '__GEMINI_RESPONSE__') {
      console.log('[Gemini Preload] Received response via postMessage');
      const { conversationId, message } = event.data;
      if (message) {
        console.log('[Gemini Preload] Sending to main process, message length:', message.length);
        ipcRenderer.send('gemini-response-captured', {
          conversationId,
          message,
          timestamp: new Date().toISOString()
        });
      }
    }
  });
}

// Expose a comprehensive API for external AI windows
contextBridge.exposeInMainWorld('electronAPI', {
  // Method to close the window
  closeWindow: () => {
    ipcRenderer.send('close-content-window');
  },
  
  // Method to get window info
  getWindowInfo: () => {
    return {
      isElectron: true,
      platform: process.platform
    };
  },
  
  // Method to open Spaces picker for file uploads
  openSpacesPicker: () => {
    return ipcRenderer.invoke('open-spaces-picker');
  }
});

// Expose clipboard API for external AI windows
contextBridge.exposeInMainWorld('clipboard', {
  // Basic clipboard operations
  getHistory: () => ipcRenderer.invoke('clipboard:get-history'),
  addItem: (item) => ipcRenderer.invoke('clipboard:add-item', item),
  pasteItem: (id) => ipcRenderer.invoke('clipboard:paste-item', id),
  
  // Spaces functionality
  getSpaces: () => ipcRenderer.invoke('clipboard:get-spaces'),
  getSpacesEnabled: () => ipcRenderer.invoke('clipboard:get-spaces-enabled'),
  getCurrentSpace: () => ipcRenderer.invoke('clipboard:get-active-space'),
  
  // Text/content capture
  captureText: (text) => ipcRenderer.invoke('clipboard:capture-text', text),
  captureHTML: (html) => ipcRenderer.invoke('clipboard:capture-html', html),
  
  // Event listeners
  onHistoryUpdate: (callback) => {
    ipcRenderer.on('clipboard:history-updated', (event, history) => {
      callback(history);
    });
  }
});

// Also expose the standard API that the main app uses
contextBridge.exposeInMainWorld('api', {
  send: (channel, data) => {
    const validChannels = [
      'app-message',
      'show-notification',
      'open-clipboard-viewer',
      'open-black-hole-widget',
      'chatgpt-response-captured',  // For ChatGPT fetch interceptor
      'grok-response-captured',     // For Grok fetch interceptor
      'gemini-response-captured'    // For Gemini fetch interceptor
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  },
  
  // Show notifications
  showNotification: (options) => {
    // Ensure options has valid title and body
    const notification = {
      title: options?.title || options?.message || 'Notification',
      body: options?.body || options?.text || '',
      type: options?.type || 'info'
    };
    ipcRenderer.send('show-notification', notification);
  },
  
  // Get overlay script content
  getOverlayScript: () => ipcRenderer.invoke('get-overlay-script'),
  
  // Conversation capture API
  conversation: {
    isEnabled: () => ipcRenderer.invoke('conversation:isEnabled'),
    isPaused: () => ipcRenderer.invoke('conversation:isPaused'),
    setPaused: (paused) => ipcRenderer.invoke('conversation:setPaused', paused),
    markDoNotSave: (serviceId) => ipcRenderer.invoke('conversation:markDoNotSave', serviceId),
    isMarkedDoNotSave: (serviceId) => ipcRenderer.invoke('conversation:isMarkedDoNotSave', serviceId),
    getCurrent: (serviceId) => ipcRenderer.invoke('conversation:getCurrent', serviceId),
    undoSave: (itemId) => ipcRenderer.invoke('conversation:undoSave', itemId),
    copyToSpace: (conversationId, targetSpaceId) => ipcRenderer.invoke('conversation:copyToSpace', conversationId, targetSpaceId)
  }
});

// Listen for close events from the main process
ipcRenderer.on('close-window', () => {
  window.dispatchEvent(new Event('electron-window-closing'));
});

// Set up AI interceptors when DOM is ready (URL will be available then)
function setupAllInterceptors() {
  setupChatGPTInterceptor();
  setupGrokInterceptor();
  setupGeminiInterceptor();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupAllInterceptors);
} else {
  // DOM already loaded, run immediately
  setupAllInterceptors();
}

// Also try on window load in case DOMContentLoaded was missed
window.addEventListener('load', () => {
  // Small delay to ensure all scripts are loaded
  setTimeout(setupAllInterceptors, 100);
});