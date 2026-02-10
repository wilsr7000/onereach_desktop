/**
 * Capture Signaling Module
 * 
 * Lightweight local HTTP signaling server for WebRTC peer-to-peer
 * session establishment in GSX Capture.
 * 
 * Flow:
 * 1. Host starts a local signaling server and creates a session with a code word + SDP offer
 * 2. Guest connects to host's IP:port and retrieves the offer by code
 * 3. Guest posts their SDP answer
 * 4. Host receives the answer, completes the WebRTC handshake
 * 5. Signaling server shuts down — everything is P2P from here
 * 
 * No external dependencies (no OmniGraph, no cloud).
 * Works on any local network.
 */

const http = require('http');
const os = require('os');
const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

// ============================================
// SESSION CODE WORD LIST
// ============================================

/**
 * Curated list of memorable, unambiguous, fun words for session codes.
 * Criteria: 1-3 syllables, easy to spell, no homophones, PG-rated.
 */
const SESSION_WORDS = [
  // Space / Sci-fi
  'nova', 'comet', 'orbit', 'nebula', 'quasar', 'pulsar', 'cosmos',
  'zenith', 'solar', 'lunar', 'astro', 'photon', 'plasma', 'vortex',
  'galaxy', 'meteor', 'saturn', 'pluto', 'titan', 'atlas',
  // Animals
  'falcon', 'raven', 'viper', 'cobra', 'tiger', 'phoenix', 'hawk',
  'wolf', 'panther', 'jaguar', 'mustang', 'raptor', 'condor', 'fox',
  'orca', 'puma', 'lynx', 'mantis', 'osprey', 'badger',
  // Action / Energy
  'blaze', 'storm', 'bolt', 'spark', 'surge', 'pulse', 'flash',
  'rush', 'drift', 'quest', 'blast', 'strike', 'turbo', 'nitro',
  'thrust', 'boost', 'flare', 'crux', 'apex',
  // Nature / Elements
  'frost', 'ember', 'coral', 'summit', 'canyon', 'ridge', 'boulder',
  'river', 'cedar', 'tundra', 'delta', 'mesa', 'dusk', 'dawn',
  'crest', 'grove', 'oasis', 'lagoon', 'harbor', 'glacier',
  // Tech / Cool
  'cipher', 'prism', 'onyx', 'matrix', 'pixel', 'vector', 'chrome',
  'carbon', 'cobalt', 'neon', 'argon', 'fusion', 'helix', 'quantum',
  'sonic', 'radar', 'laser', 'omega', 'sigma', 'echo',
  // Pop culture nods
  'maverick', 'fletch', 'gotham', 'shelby', 'ronin', 'bandit',
  'jedi', 'wookie', 'hobbit', 'gandalf', 'stark', 'loki',
  'ripley', 'neo', 'morpheus', 'trinity', 'zion', 'shire',
  'gondor', 'vulcan',
  // Objects / Misc
  'arrow', 'blade', 'shield', 'anvil', 'beacon', 'compass',
  'sentry', 'turret', 'bastion', 'rampart', 'citadel', 'fortress',
  'sentinel', 'outpost', 'signal', 'vertex', 'nexus', 'portal',
  'keystone', 'pinnacle',
  // Colors / Materials
  'crimson', 'scarlet', 'amber', 'ivory', 'obsidian', 'marble',
  'copper', 'bronze', 'silver', 'indigo', 'violet', 'azure',
  'jade', 'ruby', 'topaz', 'opal', 'garnet', 'pearl',
  'slate', 'granite'
];

// ============================================
// LOCAL SIGNALING SERVER
// ============================================

const SIGNALING_PORT_MIN = 48100;
const SIGNALING_PORT_MAX = 48199;
const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Get the local network IP address (non-loopback IPv4)
 * @returns {string} LAN IP address or '127.0.0.1' if none found
 */
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// ============================================
// SIGNALING CLASS
// ============================================

class CaptureSignaling {
  constructor() {
    this.pollInterval = null;
    this.sessionCode = null;
    this.server = null;
    this.serverPort = null;
    this.sessions = new Map(); // code -> { sdpOffer, sdpAnswer, status, createdAt }
  }

  /**
   * Generate a random memorable session code word
   * @returns {string} A single memorable word (lowercase)
   */
  generateCode() {
    const index = Math.floor(Math.random() * SESSION_WORDS.length);
    return SESSION_WORDS[index];
  }

  // ============================================
  // LOCAL HTTP SIGNALING SERVER
  // ============================================

  /**
   * Start the local signaling HTTP server
   * Listens on 0.0.0.0 so other machines on the LAN can reach it.
   * @returns {Promise<{port: number, ip: string}>}
   */
  async startServer() {
    if (this.server) {
      return { port: this.serverPort, ip: getLocalIP() };
    }

    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this._handleRequest(req, res);
      });

      // Try ports in the range until one works
      let port = SIGNALING_PORT_MIN + Math.floor(Math.random() * (SIGNALING_PORT_MAX - SIGNALING_PORT_MIN));
      const tryListen = (attempt) => {
        if (attempt > 10) {
          reject(new Error('Could not find available port for signaling server'));
          return;
        }

        server.listen(port, '0.0.0.0', () => {
          this.server = server;
          this.serverPort = port;
          const ip = getLocalIP();
          log.info('recorder', 'Local signaling server started on', { ip: ip, port: port });
          resolve({ port, ip });
        });

        server.on('error', (err) => {
          if (err.code === 'EADDRINUSE') {
            port = SIGNALING_PORT_MIN + Math.floor(Math.random() * (SIGNALING_PORT_MAX - SIGNALING_PORT_MIN));
            tryListen(attempt + 1);
          } else {
            reject(err);
          }
        });
      };

      tryListen(0);
    });
  }

  /**
   * Stop the local signaling server
   */
  stopServer() {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.serverPort = null;
      log.info('recorder', 'Local signaling server stopped');
    }
  }

  /**
   * Handle incoming HTTP requests to the signaling server
   * Routes:
   *   GET  /session/:code        - Get session offer (guest retrieves host's offer)
   *   POST /session/:code/answer - Post SDP answer (guest posts their answer)
   *   GET  /ping                 - Health check
   */
  _handleRequest(req, res) {
    // CORS headers for cross-origin requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://localhost:${this.serverPort}`);
    const path = url.pathname;

    // Health check
    if (path === '/ping' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, app: 'gsx-capture-signaling' }));
      return;
    }

    // GET /session/:code - retrieve offer
    const getMatch = path.match(/^\/session\/([a-z]+)$/);
    if (getMatch && req.method === 'GET') {
      const code = getMatch[1];
      const session = this.sessions.get(code);

      if (!session || session.status !== 'waiting') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found or expired' }));
        return;
      }

      // Check expiry
      if (Date.now() > session.createdAt + SESSION_TIMEOUT_MS) {
        this.sessions.delete(code);
        res.writeHead(410, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session expired' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        code: code,
        sdpOffer: session.sdpOffer,
        status: session.status
      }));
      return;
    }

    // POST /session/:code/answer - guest posts SDP answer
    const answerMatch = path.match(/^\/session\/([a-z]+)\/answer$/);
    if (answerMatch && req.method === 'POST') {
      const code = answerMatch[1];
      const session = this.sessions.get(code);

      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }

      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          session.sdpAnswer = data.sdpAnswer;
          session.status = 'answered';
          log.info('recorder', 'Answer received for session', { code: code });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        }
      });
      return;
    }

    // GET /session/:code/answer - host polls for answer
    const pollMatch = path.match(/^\/session\/([a-z]+)\/answer$/);
    if (pollMatch && req.method === 'GET') {
      const code = pollMatch[1];
      const session = this.sessions.get(code);

      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }

      if (session.status === 'answered' && session.sdpAnswer) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sdpAnswer: session.sdpAnswer }));
      } else {
        res.writeHead(204); // No content yet
        res.end();
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  // ============================================
  // HOST OPERATIONS
  // ============================================

  /**
   * Create a new session (host side)
   * Stores the SDP offer locally and makes it available via the signaling server.
   * 
   * @param {string} sdpOffer - JSON stringified RTCSessionDescription (with all ICE candidates)
   * @returns {Promise<{code: string, ip: string, port: number}>} Session info
   */
  async createSession(sdpOffer) {
    // Start signaling server if not running
    const { port, ip } = await this.startServer();

    // Generate unique code
    let code = this.generateCode();
    let attempts = 0;
    while (this.sessions.has(code) && attempts < 10) {
      code = this.generateCode();
      attempts++;
    }

    // Store session in memory
    this.sessions.set(code, {
      sdpOffer,
      sdpAnswer: null,
      status: 'waiting',
      createdAt: Date.now()
    });

    this.sessionCode = code;
    log.info('recorder', 'Session created: (server: :)', { code: code, ip: ip, port: port });

    return { code, ip, port };
  }

  /**
   * Poll for a guest's SDP answer (host side)
   * Checks in-memory session store directly.
   * 
   * @param {string} code - Session code word
   * @returns {Object|null} SDP answer or null
   */
  pollForAnswer(code) {
    const session = this.sessions.get(code.toLowerCase().trim());
    if (session && session.status === 'answered' && session.sdpAnswer) {
      return JSON.parse(session.sdpAnswer);
    }
    return null;
  }

  /**
   * Start polling for the guest's answer (host side)
   * Checks the in-memory store directly (no HTTP needed for host).
   * 
   * @param {string} code - Session code word
   * @param {Function} onAnswer - Callback with the SDP answer
   * @param {Function} onTimeout - Callback if session times out
   * @param {number} intervalMs - Poll interval (default 500ms -- local, so fast)
   * @param {number} timeoutMs - Timeout (default 5 minutes)
   */
  startPolling(code, onAnswer, onTimeout, intervalMs = 500, timeoutMs = 300000) {
    this.stopPolling();

    const startTime = Date.now();

    this.pollInterval = setInterval(() => {
      // Check timeout
      if (Date.now() - startTime > timeoutMs) {
        this.stopPolling();
        if (onTimeout) onTimeout();
        return;
      }

      const answer = this.pollForAnswer(code);
      if (answer) {
        this.stopPolling();
        onAnswer(answer);
      }
    }, intervalMs);
  }

  /**
   * Stop polling
   */
  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  // ============================================
  // GUEST OPERATIONS (use HTTP to reach host)
  // ============================================

  /**
   * Find a session by code on a remote host (guest side)
   * @param {string} code - Session code word
   * @param {string} hostAddress - Host IP:port (e.g., "192.168.1.5:48150")
   * @returns {Promise<Object|null>} Session data with SDP offer, or null
   */
  async findSession(code, hostAddress) {
    const normalizedCode = code.toLowerCase().trim();
    const url = `http://${hostAddress}/session/${normalizedCode}`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) return null;

      const data = await response.json();
      return {
        code: data.code,
        sdpOffer: data.sdpOffer,
        status: data.status
      };
    } catch (error) {
      log.warn('recorder', 'Find session error', { error: error.message });
      return null;
    }
  }

  /**
   * Post the SDP answer for a session (guest side)
   * @param {string} code - Session code word
   * @param {string} sdpAnswer - JSON stringified RTCSessionDescription
   * @param {string} hostAddress - Host IP:port
   */
  async postAnswer(code, sdpAnswer, hostAddress) {
    const normalizedCode = code.toLowerCase().trim();
    const url = `http://${hostAddress}/session/${normalizedCode}/answer`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sdpAnswer })
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Failed to post answer: HTTP ${response.status}`);
    }

    log.info('recorder', 'Answer posted for session', { normalizedCode: normalizedCode });
  }

  // ============================================
  // CLEANUP
  // ============================================

  /**
   * Delete a session from memory
   * @param {string} code - Session code word
   */
  deleteSession(code) {
    if (code) {
      this.sessions.delete(code.toLowerCase().trim());
      log.info('recorder', 'Session deleted', { code: code });
    }
  }

  /**
   * Full cleanup — stop polling, delete session, stop server
   */
  async destroy() {
    this.stopPolling();
    if (this.sessionCode) {
      this.deleteSession(this.sessionCode);
      this.sessionCode = null;
    }
    this.stopServer();
  }
}

// Singleton
let signalingInstance = null;

function getCaptureSignaling() {
  if (!signalingInstance) {
    signalingInstance = new CaptureSignaling();
  }
  return signalingInstance;
}

module.exports = {
  CaptureSignaling,
  getCaptureSignaling,
  SESSION_WORDS,
  getLocalIP
};
