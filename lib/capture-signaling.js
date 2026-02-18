/**
 * @deprecated -- REPLACED BY LiveKit SFU (lib/livekit-service.js)
 *
 * This module is no longer used by WISER Meeting.
 * LiveKit handles signaling, ICE, and TURN internally.
 * Kept for reference only — will be removed in a future release.
 *
 * Original description:
 * Lightweight local HTTP signaling server for WebRTC peer-to-peer
 * session establishment. Host creates a session with SDP offer,
 * guest retrieves and posts answer, then signaling shuts down.
 */

const http = require('http');
const os = require('os');
const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

// Guest page HTML (rebuilt each server start, bakes in GSX KV URL)
let _guestPageHTML = null;
function getGuestPageHTML() {
  if (!_guestPageHTML) {
    try {
      const { buildGuestPageHTML } = require('./capture-guest-page');
      // Bake in the GSX KV endpoint so the public guest page can signal
      const FALLBACK_ACCOUNT = '35254342-4a2e-475b-aec1-18547e517e29';
      let kvUrl = '';
      try {
        if (global.settingsManager) {
          const refreshUrl = global.settingsManager.get('gsxRefreshUrl');
          if (refreshUrl) kvUrl = refreshUrl.replace('/refresh_token', '/keyvalue');
        }
      } catch {
        /* no-op */
      }
      if (!kvUrl) {
        kvUrl = `https://em.edison.api.onereach.ai/http/${FALLBACK_ACCOUNT}/keyvalue`;
      }
      _guestPageHTML = buildGuestPageHTML({ relayUrl: kvUrl });
    } catch (_e) {
      _guestPageHTML = '<html><body><h1>Guest page not available</h1></body></html>';
    }
  }
  return _guestPageHTML;
}

// ============================================
// SESSION CODE WORD LIST
// ============================================

/**
 * Curated list of memorable, unambiguous, fun words for session codes.
 * Criteria: 1-3 syllables, easy to spell, no homophones, PG-rated.
 */
const SESSION_WORDS = [
  // Space / Sci-fi
  'nova',
  'comet',
  'orbit',
  'nebula',
  'quasar',
  'pulsar',
  'cosmos',
  'zenith',
  'solar',
  'lunar',
  'astro',
  'photon',
  'plasma',
  'vortex',
  'galaxy',
  'meteor',
  'saturn',
  'pluto',
  'titan',
  'atlas',
  // Animals
  'falcon',
  'raven',
  'viper',
  'cobra',
  'tiger',
  'phoenix',
  'hawk',
  'wolf',
  'panther',
  'jaguar',
  'mustang',
  'raptor',
  'condor',
  'fox',
  'orca',
  'puma',
  'lynx',
  'mantis',
  'osprey',
  'badger',
  // Action / Energy
  'blaze',
  'storm',
  'bolt',
  'spark',
  'surge',
  'pulse',
  'flash',
  'rush',
  'drift',
  'quest',
  'blast',
  'strike',
  'turbo',
  'nitro',
  'thrust',
  'boost',
  'flare',
  'crux',
  'apex',
  // Nature / Elements
  'frost',
  'ember',
  'coral',
  'summit',
  'canyon',
  'ridge',
  'boulder',
  'river',
  'cedar',
  'tundra',
  'delta',
  'mesa',
  'dusk',
  'dawn',
  'crest',
  'grove',
  'oasis',
  'lagoon',
  'harbor',
  'glacier',
  // Tech / Cool
  'cipher',
  'prism',
  'onyx',
  'matrix',
  'pixel',
  'vector',
  'chrome',
  'carbon',
  'cobalt',
  'neon',
  'argon',
  'fusion',
  'helix',
  'quantum',
  'sonic',
  'radar',
  'laser',
  'omega',
  'sigma',
  'echo',
  // Pop culture nods
  'maverick',
  'fletch',
  'gotham',
  'shelby',
  'ronin',
  'bandit',
  'jedi',
  'wookie',
  'hobbit',
  'gandalf',
  'stark',
  'loki',
  'ripley',
  'neo',
  'morpheus',
  'trinity',
  'zion',
  'shire',
  'gondor',
  'vulcan',
  // Objects / Misc
  'arrow',
  'blade',
  'shield',
  'anvil',
  'beacon',
  'compass',
  'sentry',
  'turret',
  'bastion',
  'rampart',
  'citadel',
  'fortress',
  'sentinel',
  'outpost',
  'signal',
  'vertex',
  'nexus',
  'portal',
  'keystone',
  'pinnacle',
  // Colors / Materials
  'crimson',
  'scarlet',
  'amber',
  'ivory',
  'obsidian',
  'marble',
  'copper',
  'bronze',
  'silver',
  'indigo',
  'violet',
  'azure',
  'jade',
  'ruby',
  'topaz',
  'opal',
  'garnet',
  'pearl',
  'slate',
  'granite',
];

// ============================================
// LOCAL SIGNALING SERVER
// ============================================

const SIGNALING_PORT_MIN = 48100;
const SIGNALING_PORT_MAX = 48199;
const SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours (safety net -- sessions are cleaned up explicitly when the host closes)

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
    this.localPollInterval = null; // LAN polling (in-memory)
    this.publicPollInterval = null; // Public relay polling (KV)
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

    // Serve guest join page
    if ((path === '/join' || path === '/') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getGuestPageHTML());
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
      res.end(
        JSON.stringify({
          code: code,
          sdpOffer: session.sdpOffer,
          status: session.status,
        })
      );
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
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          session.sdpAnswer = data.sdpAnswer;
          session.status = 'answered';
          log.info('recorder', 'Answer received for session', { code: code });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (_err) {
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

    // POST /session/:code/status - guest posts join progress
    const statusPostMatch = path.match(/^\/session\/([a-z]+)\/status$/);
    if (statusPostMatch && req.method === 'POST') {
      const code = statusPostMatch[1];
      const session = this.sessions.get(code);

      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }

      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        try {
          session.guestStatus = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        }
      });
      return;
    }

    // GET /session/:code/status - host polls for guest join progress
    const statusGetMatch = path.match(/^\/session\/([a-z]+)\/status$/);
    if (statusGetMatch && req.method === 'GET') {
      const code = statusGetMatch[1];
      const session = this.sessions.get(code);

      if (!session || !session.guestStatus) {
        res.writeHead(204);
        res.end();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(session.guestStatus));
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
   * @param {string} [explicitCode] - Optional code to use (e.g. from the space name). Falls back to random word.
   * @returns {Promise<{code: string, ip: string, port: number}>} Session info
   */
  async createSession(sdpOffer, explicitCode) {
    // Start signaling server if not running
    const { port, ip } = await this.startServer();

    // Use explicit code (e.g. space name) if provided, otherwise generate random
    let code = explicitCode ? explicitCode.toLowerCase().trim() : this.generateCode();
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
      guestStatus: null,
      createdAt: Date.now(),
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
   * Poll for guest join status (local, in-memory).
   * @param {string} code - Session code word
   * @returns {Object|null} Guest status object or null
   */
  pollForGuestStatus(code) {
    const session = this.sessions.get(code.toLowerCase().trim());
    return session ? session.guestStatus : null;
  }

  /**
   * Start polling for the guest's answer (host side).
   * Checks the in-memory store directly (no HTTP needed for host).
   * Also polls for guest join status and calls onGuestStatus when it changes.
   * Polls indefinitely until the guest answers or the host stops/closes the session.
   *
   * @param {string} code - Session code word
   * @param {Function} onAnswer - Callback with the SDP answer
   * @param {Function} [onGuestStatus] - Callback with guest join progress
   * @param {number} intervalMs - Poll interval (default 500ms -- local, so fast)
   */
  startPolling(code, onAnswer, onGuestStatus, intervalMs = 500) {
    this.stopLocalPolling();
    let lastStatusJson = '';

    this.localPollInterval = setInterval(() => {
      // Check for guest status changes
      if (onGuestStatus) {
        const status = this.pollForGuestStatus(code);
        const statusJson = status ? JSON.stringify(status) : '';
        if (statusJson && statusJson !== lastStatusJson) {
          lastStatusJson = statusJson;
          onGuestStatus(status);
        }
      }

      // Check for answer
      const answer = this.pollForAnswer(code);
      if (answer) {
        this.stopAllPolling();
        onAnswer(answer);
      }
    }, intervalMs);
  }

  /**
   * Stop local (LAN) polling only
   */
  stopLocalPolling() {
    if (this.localPollInterval) {
      clearInterval(this.localPollInterval);
      this.localPollInterval = null;
    }
  }

  /**
   * Stop public (relay) polling only
   */
  stopPublicPolling() {
    if (this.publicPollInterval) {
      clearInterval(this.publicPollInterval);
      this.publicPollInterval = null;
    }
  }

  /**
   * Stop all polling (both local and public)
   */
  stopAllPolling() {
    this.stopLocalPolling();
    this.stopPublicPolling();
  }

  /**
   * @deprecated Use stopAllPolling() instead
   */
  stopPolling() {
    this.stopAllPolling();
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
        status: data.status,
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
      body: JSON.stringify({ sdpAnswer }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Failed to post answer: HTTP ${response.status}`);
    }

    log.info('recorder', 'Answer posted for session', { normalizedCode: normalizedCode });
  }

  // ============================================
  // PUBLIC INTERNET SIGNALING (via GSX KeyValue)
  // ============================================

  /**
   * Get the GSX KV endpoint URL.
   * Derives from gsxRefreshUrl in settings, or uses the hardcoded fallback account.
   * @returns {string}
   */
  _getKvUrl() {
    const FALLBACK_ACCOUNT = '35254342-4a2e-475b-aec1-18547e517e29';
    try {
      if (global.settingsManager) {
        const refreshUrl = global.settingsManager.get('gsxRefreshUrl');
        if (refreshUrl) {
          return refreshUrl.replace('/refresh_token', '/keyvalue');
        }
      }
    } catch {
      /* no-op */
    }
    return `https://em.edison.api.onereach.ai/http/${FALLBACK_ACCOUNT}/keyvalue`;
  }

  /**
   * Get a SignalingClient instance for the GSX KV endpoint.
   * @returns {SignalingClient}
   */
  _getRelayClient() {
    const { SignalingClient } = require('./signaling-client');
    return new SignalingClient(this._getKvUrl());
  }

  /**
   * Push the SDP offer to the GSX KV for public internet signaling.
   *
   * @param {string} sdpOffer - JSON-stringified SDP offer
   * @param {string} [explicitCode] - Use this code (from LAN session) instead of generating one
   * @returns {Promise<{code: string, kvUrl: string}>}
   */
  async createSessionPublic(sdpOffer, explicitCode) {
    const client = this._getRelayClient();

    let code = explicitCode;
    if (!code) {
      // Generate unique code (check KV for collisions)
      code = this.generateCode();
      let attempts = 0;
      while (attempts < 10) {
        const existing = await client.getOffer(code).catch((err) => {
          console.warn('[capture-signaling] getOffer collision check:', err.message);
          return null;
        });
        if (!existing) break;
        code = this.generateCode();
        attempts++;
      }
    }

    await client.putOffer(code, sdpOffer);
    this.sessionCode = code;

    log.info('recorder', 'Public session created on GSX KV', { code });
    return { code, kvUrl: this._getKvUrl() };
  }

  /**
   * Poll the relay for the guest's SDP answer.
   * @param {string} code - Session code word
   * @returns {Promise<Object|null>} Parsed SDP answer or null
   */
  async pollForAnswerPublic(code) {
    try {
      const client = this._getRelayClient();
      const answer = await client.getAnswer(code);
      if (answer) return JSON.parse(answer);
    } catch (e) {
      log.warn('recorder', 'Relay poll error', { error: e.message });
    }
    return null;
  }

  /**
   * Poll the relay for guest join status.
   * @param {string} code - Session code word
   * @returns {Promise<Object|null>} Status object or null
   */
  async pollForGuestStatusPublic(code) {
    try {
      const client = this._getRelayClient();
      return await client.getStatus(code);
    } catch {
      return null;
    }
  }

  /**
   * Start polling the relay for the guest's answer.
   * Also polls for guest join status and calls onGuestStatus when it changes.
   * Polls indefinitely until the guest answers or the host stops/closes the session.
   * @param {string} code - Session code word
   * @param {Function} onAnswer - Callback with parsed SDP answer
   * @param {Function} [onGuestStatus] - Callback with guest join progress
   * @param {number} intervalMs - Poll interval (default 2s for cloud)
   */
  startPollingPublic(code, onAnswer, onGuestStatus, intervalMs = 2000) {
    this.stopPublicPolling();
    let lastStatusJson = '';

    this.publicPollInterval = setInterval(async () => {
      // Check for guest status changes
      if (onGuestStatus) {
        const status = await this.pollForGuestStatusPublic(code);
        const statusJson = status ? JSON.stringify(status) : '';
        if (statusJson && statusJson !== lastStatusJson) {
          lastStatusJson = statusJson;
          onGuestStatus(status);
        }
      }

      // Check for answer
      const answer = await this.pollForAnswerPublic(code);
      if (answer) {
        this.stopAllPolling();
        onAnswer(answer);
      }
    }, intervalMs);
  }

  /**
   * Delete the session from the relay (cleanup).
   * TTL handles this automatically, but explicit cleanup is polite.
   * @param {string} code - Session code word
   */
  async cleanupSessionPublic(code) {
    try {
      const client = this._getRelayClient();
      await client.deleteSession(code);
      log.info('recorder', 'Public session cleaned up from relay', { code });
    } catch (e) {
      log.warn('recorder', 'Relay cleanup error', { error: e.message });
    }
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
   * Full cleanup — stop polling, delete local session, stop server,
   * and remove relay session if it exists.
   */
  async destroy() {
    this.stopPolling();
    if (this.sessionCode) {
      this.deleteSession(this.sessionCode);
      // Also clean up from relay (non-blocking, TTL handles it anyway)
      this.cleanupSessionPublic(this.sessionCode).catch((_ignored) => {
        /* cleanup best-effort, TTL handles expiry */
      });
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
  getLocalIP,
};
