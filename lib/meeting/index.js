/**
 * WISER Meeting — the recorder subsystem's portable core.
 *
 * This package gathers every meeting-owned library so a host app (the
 * full app today, Onereach.ai Lite tomorrow) consumes ONE surface
 * instead of six scattered files. See PORTING.md in this directory for
 * the host-services contract — what a host must provide and which Lite
 * module implements each piece.
 *
 * Layering (who may import what):
 *   - This package depends on npm packages and TWO host-app seams only:
 *     `../log-event-queue` (structured logging) and
 *     `../gsx-flow-context` (GSX auth token for the server-mint path).
 *     A Lite port swaps those two requires for lite/logging + lite/auth.
 *   - The HOST SHELL stays outside the package: `recorder.js` (main-
 *     process IPC wiring), `recorder.html` (renderer), and
 *     `preload-recorder.js` are the full app's adapter layer around
 *     this core. They import from here; nothing here imports them.
 */

'use strict';

const livekit = require('./livekit-service');
const linkKeys = require('./meeting-link-keys');
const schema = require('./meeting-schema');
const templates = require('./meeting-templates');
const guestPage = require('./capture-guest-page');
const graphBridge = require('./meeting-graph-bridge');

module.exports = {
  /** LiveKit room + token minting (credential precedence: mint URL > settings > legacy). */
  livekit,
  /** Per-install ECDSA link signing — KV is an untrusted channel. */
  linkKeys,
  /** Meeting object model (fromSpaceItem / completeMeeting / toSpaceItem). */
  schema,
  /** Custom meeting templates. */
  templates,
  /** Published web guest page (GUEST_PAGE_VERSION gated). */
  guestPage,
  /** ADR-061 — mirror completed meetings into the shared account graph. */
  graphBridge,
};
