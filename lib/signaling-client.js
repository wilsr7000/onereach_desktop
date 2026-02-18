/**
 * @deprecated -- REPLACED BY LiveKit SFU (lib/livekit-service.js)
 *
 * This module is no longer used by WISER Meeting.
 * LiveKit handles signaling internally; no KV relay needed.
 * Kept for reference only — will be removed in a future release.
 *
 * Original description:
 * Uses the OneReach Edison KeyValue API as a signaling relay
 * for WebRTC session establishment over the public internet.
 */

const COLLECTION = 'gsx:capture:signaling';

class SignalingClient {
  /**
   * @param {string} apiUrl - GSX KV endpoint (e.g., https://em.edison.api.onereach.ai/http/{accountId}/keyvalue)
   */
  constructor(apiUrl) {
    this.apiUrl = apiUrl;
  }

  /** Build the full URL with query params */
  _url(key) {
    return `${this.apiUrl}?id=${encodeURIComponent(COLLECTION)}&key=${encodeURIComponent(key)}`;
  }

  /**
   * Store the SDP offer for a session code.
   * @param {string} code - Session code word
   * @param {string} sdpOffer - JSON-stringified SDP offer
   */
  async putOffer(code, sdpOffer) {
    const key = `${code}:offer`;
    const resp = await fetch(this._url(key), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: COLLECTION, key, itemValue: JSON.stringify(sdpOffer) }),
    });
    if (!resp.ok) throw new Error(`PUT offer failed: ${resp.status}`);
  }

  /**
   * Retrieve the SDP offer for a session code.
   * @param {string} code - Session code word
   * @returns {string|null} JSON-stringified SDP offer, or null if not found
   */
  async getOffer(code) {
    const resp = await fetch(this._url(`${code}:offer`));
    if (!resp.ok) return null;
    const result = await resp.json();
    if (result.Status === 'No data found.' || !result.value) return null;
    try {
      return JSON.parse(result.value);
    } catch {
      return result.value;
    }
  }

  /**
   * Store the SDP answer for a session code.
   * @param {string} code - Session code word
   * @param {string} sdpAnswer - JSON-stringified SDP answer
   */
  async putAnswer(code, sdpAnswer) {
    const key = `${code}:answer`;
    const resp = await fetch(this._url(key), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: COLLECTION, key, itemValue: JSON.stringify(sdpAnswer) }),
    });
    if (!resp.ok) throw new Error(`PUT answer failed: ${resp.status}`);
  }

  /**
   * Retrieve the SDP answer for a session code.
   * @param {string} code - Session code word
   * @returns {string|null} JSON-stringified SDP answer, or null if not found
   */
  async getAnswer(code) {
    const resp = await fetch(this._url(`${code}:answer`));
    if (!resp.ok) return null;
    const result = await resp.json();
    if (result.Status === 'No data found.' || !result.value) return null;
    try {
      return JSON.parse(result.value);
    } catch {
      return result.value;
    }
  }

  /**
   * Store guest join status (presence awareness).
   * @param {string} code - Session code word
   * @param {Object} status - { state: 'joining'|'error'|'connected', step, message, timestamp }
   */
  async putStatus(code, status) {
    const key = `${code}:status`;
    const resp = await fetch(this._url(key), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: COLLECTION, key, itemValue: JSON.stringify(status) }),
    });
    if (!resp.ok) throw new Error(`PUT status failed: ${resp.status}`);
  }

  /**
   * Retrieve guest join status.
   * @param {string} code - Session code word
   * @returns {Object|null} Status object or null
   */
  async getStatus(code) {
    const resp = await fetch(this._url(`${code}:status`));
    if (!resp.ok) return null;
    const result = await resp.json();
    if (result.Status === 'No data found.' || !result.value) return null;
    try {
      return JSON.parse(result.value);
    } catch {
      return null;
    }
  }

  /**
   * Delete offer, answer, and status for a session (cleanup).
   * @param {string} code - Session code word
   */
  async deleteSession(code) {
    await Promise.allSettled([
      fetch(this._url(`${code}:offer`), { method: 'DELETE' }),
      fetch(this._url(`${code}:answer`), { method: 'DELETE' }),
      fetch(this._url(`${code}:status`), { method: 'DELETE' }),
    ]);
  }

  /**
   * Health check — store and retrieve a test value.
   * @returns {boolean}
   */
  async isHealthy() {
    try {
      const key = `_health_${Date.now()}`;
      await fetch(this._url(key), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: COLLECTION, key, itemValue: JSON.stringify('ok') }),
      });
      const resp = await fetch(this._url(key));
      const result = await resp.json();
      fetch(this._url(key), { method: 'DELETE' }).catch((err) =>
        console.warn('[signaling-client] health check cleanup:', err.message)
      );
      return result.value != null;
    } catch {
      return false;
    }
  }
}

// Node.js / CommonJS export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SignalingClient, COLLECTION };
}
