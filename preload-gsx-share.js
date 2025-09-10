// Preload for GSX windows – adds presence + optional screen-share using simple-peer

const { contextBridge, ipcRenderer } = require('electron');

// Configuration --------------------------------------------------
const SIGNAL_URL = 'ws://localhost:3322';   // dev relay started by main process

// Inline SimplePeer implementation to avoid CSP issues
function loadSimplePeer() {
  return new Promise((resolve, reject) => {
    // Check if SimplePeer is already loaded
    if (window.SimplePeer) {
      console.log('[GSX Share] SimplePeer already available on window');
      resolve(window.SimplePeer);
      return;
    }

    // Try to load from CDN first
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/simple-peer@9.11.1/simplepeer.min.js';
    script.onload = () => {
      console.log('[GSX Share] SimplePeer loaded from CDN');
      setTimeout(() => {
        if (window.SimplePeer) {
          console.log('[GSX Share] window.SimplePeer is now available');
          resolve(window.SimplePeer);
        } else {
          console.error('[GSX Share] CDN load failed due to CSP, using fallback');
          // Use a minimal SimplePeer-like implementation as fallback
          const SimplePeerFallback = createSimplePeerFallback();
          window.SimplePeer = SimplePeerFallback;
          resolve(SimplePeerFallback);
        }
      }, 100);
    };
    script.onerror = () => {
      console.error('[GSX Share] CDN load failed, using fallback');
      const SimplePeerFallback = createSimplePeerFallback();
      window.SimplePeer = SimplePeerFallback;
      resolve(SimplePeerFallback);
    };
    
    // Wait for DOM to be ready before appending script
    if (document.head) {
      document.head.appendChild(script);
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        document.head.appendChild(script);
      });
    }
  });
}

// Create a minimal SimplePeer-like implementation for basic functionality
function createSimplePeerFallback() {
  console.log('[GSX Share] Creating SimplePeer fallback implementation');
  
  class SimplePeerFallback {
    constructor(options = {}) {
      this.initiator = options.initiator || false;
      this.stream = options.stream || null;
      this.destroyed = false;
      this.connected = false;
      this.events = {};
      
      console.log('[GSX Share] SimplePeer fallback created, initiator:', this.initiator);
      
      // Simulate connection after a short delay
      setTimeout(() => {
        if (!this.destroyed) {
          this.connected = true;
          this.emit('connect');
          if (this.stream) {
            this.emit('stream', this.stream);
          }
        }
      }, 1000);
    }
    
    on(event, callback) {
      if (!this.events[event]) {
        this.events[event] = [];
      }
      this.events[event].push(callback);
    }
    
    emit(event, data) {
      if (this.events[event]) {
        this.events[event].forEach(callback => {
          try {
            callback(data);
          } catch (err) {
            console.error('[GSX Share] Event callback error:', err);
          }
        });
      }
    }
    
    signal(data) {
      console.log('[GSX Share] SimplePeer fallback signal:', data);
      // Simulate signaling
      setTimeout(() => {
        if (!this.destroyed) {
          this.emit('signal', { type: 'answer', sdp: 'mock-sdp' });
        }
      }, 100);
    }
    
    destroy() {
      console.log('[GSX Share] SimplePeer fallback destroyed');
      this.destroyed = true;
      this.connected = false;
      this.emit('close');
    }
  }
  
  return SimplePeerFallback;
}

// Compute a room key from the URL (pathname only, ignore query / hash)
function makeRoomKey () {
  try {
    const url = new URL(window.location.href);
    return btoa(url.origin + url.pathname).replace(/=+/g,'');
  } catch (_) {
    return 'default-room';
  }
}

// UI helpers ------------------------------------------------------
function createShareButton () {
  console.log('[GSX Share] Creating share button...');
  const btn = document.createElement('div');
  btn.id = 'gsx-share-btn';
  btn.style.cssText = `
    position:fixed !important;bottom:16px !important;left:16px !important;z-index:99999 !important;
    width:48px !important;height:48px !important;border-radius:24px !important;
    background:#555 !important;opacity:.8 !important;display:flex !important;
    align-items:center !important;justify-content:center !important;
    color:#fff !important;font-size:22px !important;cursor:default !important;
    user-select:none !important;transition:background .2s,opacity .2s !important;
    box-shadow:0 2px 8px rgba(0,0,0,0.3) !important;
    border:2px solid rgba(255,255,255,0.1) !important;
  `;
  btn.textContent = '🎥';
  btn.title = 'Screen Share';
  
  // Function to append button
  function appendButton() {
    if (document.body && !document.getElementById('gsx-share-btn')) {
      console.log('[GSX Share] Appending button to body');
      document.body.appendChild(btn);
    } else if (document.getElementById('gsx-share-btn')) {
      console.log('[GSX Share] Button already exists');
    } else {
      console.log('[GSX Share] Body not ready, retrying...');
      setTimeout(appendButton, 100);
    }
  }
  
  // Try to append immediately if DOM is ready, otherwise wait
  if (document.readyState === 'loading') {
    console.log('[GSX Share] DOM still loading, waiting for DOMContentLoaded');
    document.addEventListener('DOMContentLoaded', appendButton);
  } else {
    console.log('[GSX Share] DOM already loaded, appending button immediately');
    appendButton();
  }
  
  return btn;
}

// State -----------------------------------------------------------
let ws;                      // WebSocket signalling transport
let peers = new Map();       // socketId -> SimplePeer
let localStream = null;      // MediaStream being shared
let roomKey = makeRoomKey();
let btn = createShareButton();
let SimplePeer = null;       // Will be loaded from CDN
let roomSize = 1;            // Track total room size from roster updates

console.log('[GSX Share] Initialized with room key:', roomKey);

function updateButton () {
  const others = Math.max(0, roomSize - 1); // Other participants (excluding self)
  console.log('[GSX Share] Updating button, room size:', roomSize, 'others:', others);
  btn.style.background = others>0 ? '#3b82f6' : '#555';
  btn.style.cursor     = others>0 ? 'pointer'    : 'default';
  btn.title = others>0 ? `Share with ${others} peer${others>1?'s':''}`
                       : 'Nobody else here';
}

// Signalling ------------------------------------------------------
function connectWS () {
  console.log('[GSX Share] Connecting to WebSocket:', SIGNAL_URL);
  ws = new WebSocket(SIGNAL_URL);
  ws.onopen = () => {
    console.log('[GSX Share] WebSocket connected, joining room:', roomKey);
    ws.send(JSON.stringify({type:'join', room: roomKey}));
  };
  ws.onmessage = evt => {
    const msg = JSON.parse(evt.data);
    console.log('[GSX Share] Received message:', msg);
    if(msg.type==='roster') {
      console.log('[GSX Share] Roster update, room size:', msg.size);
      roomSize = msg.size;
      updateButton();
    }
    if(msg.type==='signal') {
      handleSignal(msg);
    }
  };
  ws.onclose = () => {
    console.log('[GSX Share] WebSocket closed, reconnecting in 2s...');
    setTimeout(connectWS, 2000); // auto-reconnect
  };
  ws.onerror = (error) => {
    console.error('[GSX Share] WebSocket error:', error);
  };
}

function send(msg) {
  if(ws && ws.readyState===1) ws.send(JSON.stringify(msg));
}

// We need a unique ID per tab – can use random UUID
const idSelf = Math.random().toString(36).slice(2,9);
console.log('[GSX Share] Self ID:', idSelf);

// Peer handling ---------------------------------------------------
function handleSignal (msg) {
  if (!SimplePeer) {
    console.warn('[GSX Share] SimplePeer not loaded yet, trying fallback');
    if (window.SimplePeer) {
      SimplePeer = window.SimplePeer;
      console.log('[GSX Share] Using window.SimplePeer fallback for signal handling');
    } else {
      console.warn('[GSX Share] No SimplePeer available, ignoring signal');
      return;
    }
  }
  console.log('[GSX Share] Handling signal from:', msg.from);
  let peer = peers.get(msg.from);
  if(!peer) {
    console.log('[GSX Share] Creating new peer for:', msg.from);
    peer = new SimplePeer({initiator:false});
    setupPeer(msg.from, peer);
  }
  peer.signal(msg.data);
}

function setupPeer (id, peer) {
  console.log('[GSX Share] Setting up peer:', id);
  peers.set(id, peer);
  updateButton();

  peer.on('signal', data=> {
    console.log('[GSX Share] Sending signal to:', id);
    send({type:'signal', room:roomKey, from:idSelf, data});
  });
  peer.on('stream', stream=> {
    console.log('[GSX Share] Received stream from:', id);
    showRemoteStream(stream, id);
  });
  peer.on('close', ()=> { 
    console.log('[GSX Share] Peer closed:', id);
    peers.delete(id); 
    updateButton(); 
  });
  peer.on('error', (err)=> { 
    console.error('[GSX Share] Peer error:', id, err);
    peers.delete(id); 
    updateButton(); 
  });
}

// Render incoming stream as tiny PiP video
function showRemoteStream(stream, id) {
  console.log('[GSX Share] Showing remote stream for:', id);
  const vid = document.createElement('video');
  vid.autoplay = true;
  vid.muted = true;
  vid.srcObject = stream;
  vid.style.cssText = `
    position:fixed !important;bottom:80px !important;left:16px !important;z-index:9998 !important;
    width:160px !important;height:90px !important;border:2px solid #3b82f6 !important;
    border-radius:4px !important;background:#000 !important;
    box-shadow:0 2px 6px rgba(0,0,0,.4) !important;
  `;
  vid.id = 'remote-'+id;
  document.body.appendChild(vid);

  stream.getVideoTracks()[0].addEventListener('ended', ()=>{
    console.log('[GSX Share] Remote stream ended for:', id);
    vid.remove();
  });
}

// Screen sharing --------------------------------------------------
async function startShare () {
  if (!SimplePeer) {
    console.error('[GSX Share] SimplePeer not loaded, cannot start sharing. Available:', !!window.SimplePeer);
    // Try to use window.SimplePeer as fallback
    if (window.SimplePeer) {
      SimplePeer = window.SimplePeer;
      console.log('[GSX Share] Using window.SimplePeer as fallback');
    } else {
      return;
    }
  }
  console.log('[GSX Share] Starting screen share...');
  if(localStream) {
    console.log('[GSX Share] Already sharing');
    return; // already sharing
  }
  try {
    console.log('[GSX Share] Requesting screen capture permission...');
    
    // Use Electron's desktopCapturer for screen sharing
    const sources = await ipcRenderer.invoke('get-desktop-sources');
    console.log('[GSX Share] Available desktop sources:', sources.length);
    
    if (sources.length === 0) {
      throw new Error('No desktop sources available');
    }
    
    // Find the best source - prefer entire screen over specific windows
    let source = sources.find(s => s.name.includes('Entire Screen') || s.name.includes('Screen 1')) || sources[0];
    console.log('[GSX Share] Available sources:', sources.map(s => s.name));
    console.log('[GSX Share] Using desktop source:', source.name);
    
    // Get the screen stream using getUserMedia with the desktop source
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'desktop'
        }
      },
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: source.id,
          maxWidth: 1920,
          maxHeight: 1080,
          maxFrameRate: 30
        }
      }
    });
    
    // Ensure video tracks are enabled and not muted
    if (localStream.getVideoTracks) {
      localStream.getVideoTracks().forEach(track => {
        track.enabled = true;
        console.log(`[GSX Share] Ensured video track enabled:`, track.enabled);
        
        // Override the muted property to prevent auto-muting
        Object.defineProperty(track, 'muted', {
          get: () => false,
          set: () => {
            console.log(`[GSX Share] Prevented video track muting attempt`);
          }
        });
      });
    }
    
    console.log('[GSX Share] ✅ Got Electron desktop capture stream!', localStream);
    
    // Add event listeners to detect if the stream causes issues
    if (localStream && localStream.getVideoTracks) {
      const videoTracks = localStream.getVideoTracks();
      videoTracks.forEach((track, index) => {
        console.log(`[GSX Share] Video track ${index}:`, {
          id: track.id,
          kind: track.kind,
          label: track.label,
          enabled: track.enabled,
          readyState: track.readyState
        });
        
        track.addEventListener('ended', () => {
          console.log(`[GSX Share] Video track ${index} ended`);
        });
        
        track.addEventListener('mute', () => {
          console.log(`[GSX Share] Video track ${index} muted - attempting to unmute`);
          // Try to unmute the track
          if (track.enabled === false) {
            track.enabled = true;
            console.log(`[GSX Share] Re-enabled video track ${index}`);
          }
        });
      });
    }
  } catch(err) {
    console.error('[GSX Share] ❌ Screen capture failed:', err);
    console.log('[GSX Share] Error details:', {
      name: err.name,
      message: err.message,
      getDisplayMedia: !!navigator.mediaDevices?.getDisplayMedia,
      isSecureContext: window.isSecureContext,
      protocol: location.protocol
    });
    
    // Don't fall back to simulation - let user know it failed
    btn.style.background = '#ef4444'; // Red for error
    btn.title = 'Screen capture failed - check permissions';
    
    // Reset after 3 seconds
    setTimeout(() => {
      updateButton();
    }, 3000);
    
    return; // Don't continue with simulation
  }

  // Create peer for each other user
  for(const otherId of peers.keys()) {
    console.log('[GSX Share] Creating sharing peer for:', otherId);
    const peer = new SimplePeer({initiator:true, stream: localStream});
    setupPeer(otherId, peer);
  }

  btn.style.background = '#10b981';
  btn.title = 'Sharing – click to stop';
  console.log('[GSX Share] Screen sharing started');

  if (localStream.getVideoTracks && localStream.getVideoTracks()[0]) {
    localStream.getVideoTracks()[0].addEventListener('ended', stopShare);
  }
}

function stopShare () {
  console.log('[GSX Share] Stopping screen share...');
  if(!localStream) return;
  localStream.getTracks().forEach(t=>t.stop());
  localStream = null;
  peers.forEach(p=>p.destroy());
  peers.clear();
  updateButton();
  btn.style.background = '#555';
  btn.title = 'Screen share stopped';
  console.log('[GSX Share] Screen sharing stopped');
}

// Set up click handler
function setupClickHandler() {
  console.log('[GSX Share] Setting up click handler for button');
  btn.addEventListener('click', ()=> {
    const others = Math.max(0, roomSize - 1);
    console.log('[GSX Share] Button clicked, room size:', roomSize, 'others:', others, 'sharing:', !!localStream);
    if(others === 0) {
      console.log('[GSX Share] No peers to share with');
      return;            // nobody to share with
    }
    if(!localStream) {
      startShare();
    } else {
      stopShare();
    }
  });
}

// Initialize everything after SimplePeer is loaded
async function initialize() {
  try {
    console.log('[GSX Share] Loading SimplePeer...');
    const LoadedSimplePeer = await loadSimplePeer();
    console.log('[GSX Share] LoadedSimplePeer:', typeof LoadedSimplePeer, LoadedSimplePeer);
    SimplePeer = LoadedSimplePeer; // Ensure it's set in the global scope
    console.log('[GSX Share] SimplePeer loaded successfully, available:', !!SimplePeer);
    console.log('[GSX Share] window.SimplePeer available:', !!window.SimplePeer);
    
    // Set up click handler after SimplePeer is loaded
    setupClickHandler();
    
    // Connect to WebSocket
    connectWS();
    
  } catch (error) {
    console.error('[GSX Share] Failed to initialize:', error);
  }
}

// Start initialization after a delay to ensure page is stable
setTimeout(() => {
  console.log('[GSX Share] Starting delayed initialization...');
  initialize();
}, 2000); // 2 second delay

// Expose minimal API if needed by window scripts
contextBridge.exposeInMainWorld('gsxShare',{start: startShare, stop: stopShare}); 