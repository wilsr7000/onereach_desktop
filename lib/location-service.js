/**
 * Location Service (main-process)
 *
 * Agents deserve to know where the user actually IS, not some stale value
 * typed into a markdown file six months ago. This service maintains the
 * freshest, most-precise location it can get, with graceful fallbacks:
 *
 *   1. PRECISE  - GPS/WiFi-assisted location from navigator.geolocation,
 *                 pushed by the renderer (orb) via location:report-precise.
 *                 Accuracy: typically 10-100m on macOS. TTL: 10 min.
 *   2. IP       - ipapi.co lookup. Accuracy: ~5-50km (city level). TTL: 30 min.
 *   3. STORED   - A previously remembered value persisted to userData. Used
 *                 when network is unavailable. No TTL (but flagged as stale).
 *   4. DEFAULT  - Value from main.md (gsx-agent space). Last resort.
 *
 * The service exposes its state synchronously via getSnapshot() for agents
 * that need to inject location into prompts, and asynchronously via
 * getLocation({ freshMs }) when an agent wants a guaranteed-fresh value.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { getLogQueue } = require('./log-event-queue');

const PRECISE_TTL_MS = 10 * 60 * 1000;   // 10 minutes
const IP_TTL_MS = 30 * 60 * 1000;        // 30 minutes
const IP_ENDPOINT = 'https://ipapi.co/json/';
const IP_FETCH_TIMEOUT_MS = 4000;

class LocationService {
  constructor() {
    this._log = getLogQueue();
    this._precise = null;   // { latitude, longitude, accuracy, city, region, country, timezone, reportedAt }
    this._ip = null;        // { latitude, longitude, city, region, country, timezone, fetchedAt }
    this._stored = null;    // Same shape as _ip; read from disk once at init
    this._diskPath = null;
    this._inflightIpFetch = null;
  }

  init(userDataDir) {
    if (userDataDir) {
      try {
        const dir = path.join(userDataDir, 'location');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        this._diskPath = path.join(dir, 'last-known.json');
        if (fs.existsSync(this._diskPath)) {
          const raw = JSON.parse(fs.readFileSync(this._diskPath, 'utf8'));
          this._stored = raw;
          this._log.info('app', '[LocationService] Loaded stored location', {
            city: raw.city,
            ageMs: Date.now() - (raw.fetchedAt || raw.reportedAt || 0),
          });
        }
      } catch (err) {
        this._log.warn('app', '[LocationService] Init warning', { error: err.message });
      }
    }

    // Kick off a non-blocking IP refresh so first-request latency is low.
    this._refreshIp().catch(() => { /* best effort at boot */ });
    return this;
  }

  /**
   * Record a precise location pushed from the renderer (navigator.geolocation).
   * Optionally enriches with reverse-geocoded city/region if not supplied.
   */
  reportPrecise({ latitude, longitude, accuracy, city, region, country, timezone }) {
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      this._log.warn('app', '[LocationService] reportPrecise ignored: missing coords');
      return false;
    }
    this._precise = {
      latitude,
      longitude,
      accuracy: typeof accuracy === 'number' ? accuracy : null,
      city: city || null,
      region: region || null,
      country: country || null,
      timezone: timezone || null,
      reportedAt: Date.now(),
      source: 'precise',
    };
    this._log.info('app', '[LocationService] Precise location received', {
      lat: latitude.toFixed(4),
      lon: longitude.toFixed(4),
      accuracyM: accuracy,
    });

    // If we got lat/lon but no city, try to fill that from the stored IP response
    if (!this._precise.city && this._ip && this._ip.city) {
      this._precise.city = this._ip.city;
      this._precise.region = this._precise.region || this._ip.region;
      this._precise.country = this._precise.country || this._ip.country;
      this._precise.timezone = this._precise.timezone || this._ip.timezone;
    }
    this._persist();
    return true;
  }

  /**
   * Return the best known location. By default this is a snapshot -- fast,
   * no network. Pass { refresh: true } to force an IP refresh if precise
   * is stale or missing.
   *
   * @param {{ refresh?: boolean, freshMs?: number }} opts
   * @returns {Promise<LocationSnapshot>}
   */
  async getLocation(opts = {}) {
    const refresh = opts.refresh === true;
    const freshMs = typeof opts.freshMs === 'number' ? opts.freshMs : null;
    const now = Date.now();

    const preciseAge = this._precise ? now - this._precise.reportedAt : Infinity;
    const ipAge = this._ip ? now - this._ip.fetchedAt : Infinity;

    // Freshness requirement from caller overrides TTL constants.
    const preciseOk = this._precise && preciseAge <= (freshMs || PRECISE_TTL_MS);
    const ipOk = this._ip && ipAge <= (freshMs || IP_TTL_MS);

    if (preciseOk) return this._snapshot(this._precise, 'precise', preciseAge);

    // Precise is stale or missing; IP is usable.
    if (ipOk && !refresh) return this._snapshot(this._ip, 'ip', ipAge);

    // Need a fresh IP lookup (or caller forced refresh).
    try {
      await this._refreshIp();
      if (this._ip) return this._snapshot(this._ip, 'ip', 0);
    } catch (err) {
      this._log.warn('app', '[LocationService] IP refresh failed', { error: err.message });
    }

    // Network unavailable: fall back to stored then empty.
    if (this._stored) return this._snapshot(this._stored, 'stored', now - (this._stored.fetchedAt || 0));
    return { source: 'unknown', accuracy: null, ageMs: null };
  }

  /**
   * Synchronous snapshot -- returns whatever we have cached without any
   * network I/O. Agents use this to inject location into prompts cheaply.
   */
  getSnapshot() {
    const now = Date.now();
    if (this._precise) return this._snapshot(this._precise, 'precise', now - this._precise.reportedAt);
    if (this._ip) return this._snapshot(this._ip, 'ip', now - this._ip.fetchedAt);
    if (this._stored) {
      return this._snapshot(this._stored, 'stored', now - (this._stored.fetchedAt || 0));
    }
    return { source: 'unknown', accuracy: null, ageMs: null };
  }

  /**
   * Internal: fetch IP geolocation from ipapi.co. Coalesces concurrent calls.
   */
  async _refreshIp() {
    if (this._inflightIpFetch) return this._inflightIpFetch;
    this._inflightIpFetch = (async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), IP_FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(IP_ENDPOINT, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`ipapi ${res.status}`);
        const data = await res.json();
        this._ip = {
          latitude: typeof data.latitude === 'number' ? data.latitude : null,
          longitude: typeof data.longitude === 'number' ? data.longitude : null,
          city: data.city || null,
          region: data.region || null,
          country: data.country_name || data.country || null,
          timezone: data.timezone || null,
          accuracy: 5000, // ipapi is typically city-level (~5km)
          fetchedAt: Date.now(),
          source: 'ip',
        };
        this._log.info('app', '[LocationService] IP location refreshed', {
          city: this._ip.city,
          region: this._ip.region,
        });
        this._persist();
      } finally {
        clearTimeout(timer);
        this._inflightIpFetch = null;
      }
    })();
    return this._inflightIpFetch;
  }

  /**
   * Save the best known location to disk so we have something on next launch
   * even if the network is down.
   */
  _persist() {
    if (!this._diskPath) return;
    try {
      const best = this._precise || this._ip;
      if (!best) return;
      fs.writeFileSync(this._diskPath, JSON.stringify(best, null, 2));
    } catch (err) {
      this._log.warn('app', '[LocationService] Persist failed', { error: err.message });
    }
  }

  _snapshot(loc, source, ageMs) {
    return {
      latitude: loc.latitude || null,
      longitude: loc.longitude || null,
      accuracy: typeof loc.accuracy === 'number' ? loc.accuracy : null,
      city: loc.city || null,
      region: loc.region || null,
      country: loc.country || null,
      timezone: loc.timezone || null,
      source,
      ageMs,
    };
  }

  /** Testing hook: reset state between tests. */
  _resetForTests() {
    this._precise = null;
    this._ip = null;
    this._stored = null;
    this._inflightIpFetch = null;
  }
}

let _instance = null;
function getLocationService() {
  if (!_instance) _instance = new LocationService();
  return _instance;
}

module.exports = { LocationService, getLocationService };
