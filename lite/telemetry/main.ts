/**
 * Telemetry wiring — the impure shell around the pure core.
 *
 * Owns: the three userData files (identity, consent, day state), the
 * consent dialog, the event subscriptions that feed counters, the
 * minute tick, and the seal-and-send path into the per-install Space.
 *
 * The load-bearing property: `sealAndSend` is the ONLY function that
 * lets data leave the machine, and its first line is the consent gate.
 * Everything else — counting, ticking, sealing to a local file — runs
 * regardless of consent, because local bookkeeping is not disclosure.
 * A user who grants consent on day 30 starts sending from day 30; we
 * do not retroactively ship the backlog, because they never agreed to
 * the period in which it was collected.
 *
 * @internal — consumers go through `./api.ts` (ADR-019).
 */

import { app, dialog, ipcMain, type BrowserWindow } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { getLoggingApi } from '../logging/api.js';
import { getHealthApi } from '../health/api.js';
import { getSpacesApi } from '../spaces/api.js';
import { loadOrMintIdentity, shortInstallId } from './identity.js';
import {
  freshDayState,
  parseDayState,
  rollDay,
  bumpLaunch,
  bumpError,
  bumpSurface,
  bumpBugReport,
  addActiveMs,
  type TelemetryDayState,
} from './store.js';
import { buildDailyRollup, rollupTitle } from './rollup.js';
import {
  maySend,
  shouldPrompt,
  recordDecision,
  disclosureViolations,
  CONSENT_DISCLOSURE,
} from './consent.js';
import type { DailyRollup, InstallIdentity, TelemetryConsentRecord } from './types.js';
import { _setTelemetryApiForTesting, type TelemetryStatus } from './api.js';

const TICK_MS = 60_000;

/**
 * The maintainer who gets standing access to every install Space
 * during the alpha. Hardcoded by design for this phase: the roster is
 * one person, and a config surface for it would be pure speculation.
 * Person ids are lowercased emails per the ADR-051 viewer convention.
 */
const MAINTAINER_PERSON_ID = 'robb@onereach.com';

/**
 * Surface-open events worth counting, mapped to their fixed labels.
 * A closed vocabulary on purpose — see `normalizeLabel` for why open
 * sets are a leak risk.
 */
const SURFACE_EVENTS: ReadonlyArray<{ event: string; label: string }> = [
  { event: 'spaces.ipc.open', label: 'spaces' },
  { event: 'window.settings.ready-to-show', label: 'settings' },
  { event: 'window.help.ready-to-show', label: 'help' },
  { event: 'window.api-docs.ready-to-show', label: 'api-docs' },
  { event: 'window.bug-report.ready-to-show', label: 'bug-report' },
];

export interface InitTelemetryOptions {
  version: string;
  userDataPath: string;
  logger?: {
    info: (msg: string, data?: unknown) => void;
    warn: (msg: string, data?: unknown) => void;
    error: (msg: string, data?: unknown) => void;
  };
}

import type { TelemetryApi } from './api.js';

/** The api surface plus boot-owned teardown. */
export interface TelemetryHandle extends TelemetryApi {
  dispose(): void;
}

export const TELEMETRY_IPC = {
  GET_STATUS: 'lite:telemetry:getStatus',
  SET_CONSENT: 'lite:telemetry:setConsent',
} as const;

export function initTelemetry(opts: InitTelemetryOptions): TelemetryHandle {
  const log = opts.logger ?? { info: () => {}, warn: () => {}, error: () => {} };
  const fileOf = (name: string): string => path.join(opts.userDataPath, name);

  // ── Identity + consent + day state, all file-backed ────────────────
  const identity: InstallIdentity = loadOrMintIdentity(
    {
      read: () => (fs.existsSync(fileOf('telemetry-identity.json'))
        ? fs.readFileSync(fileOf('telemetry-identity.json'), 'utf8')
        : null),
      write: (content) => fs.writeFileSync(fileOf('telemetry-identity.json'), content),
    },
    randomUUID,
    () => new Date().toISOString()
  );

  let consent: TelemetryConsentRecord = readConsentFile(fileOf('telemetry-consent.json'));
  let state: TelemetryDayState = readDayFile(fileOf('telemetry-day.json')) ?? freshDayState(Date.now());
  let installSpaceId: string | null = null;
  let disposed = false;

  const persistDay = (): void => {
    try {
      fs.writeFileSync(fileOf('telemetry-day.json'), JSON.stringify(state));
    } catch {
      /* lost tick, not worth more than that */
    }
  };
  const persistConsent = (): void => {
    try {
      fs.writeFileSync(fileOf('telemetry-consent.json'), JSON.stringify(consent, null, 2));
    } catch (err) {
      log.error('consent persist failed', { error: (err as Error).message });
    }
  };

  // A boot that lands on a NEW day must first seal the old one.
  const rolled = rollDay(state, Date.now());
  state = rolled.state;
  if (rolled.toSeal !== null) void sealAndSend(rolled.toSeal);
  bumpLaunch(state);
  persistDay();

  // ── Counters from the event stream ─────────────────────────────────
  // One wildcard subscription; cheap filters inside. ERROR levels
  // count by category; the fixed surface vocabulary counts opens; a
  // finished bug-report save counts as filed.
  const unsubscribe = getLoggingApi().onEvent('*', (ev) => {
    if (disposed) return;
    if (ev.level === 'error') bumpError(state, ev.category);
    if (ev.name === 'bug-report.save.finish') bumpBugReport(state);
    const surface = SURFACE_EVENTS.find((s) => s.event === ev.name);
    if (surface !== undefined) bumpSurface(state, surface.label);
  });

  // ── The minute tick: accumulate open-time, roll the day ────────────
  const tick = setInterval(() => {
    if (disposed) return;
    addActiveMs(state, TICK_MS);
    const r = rollDay(state, Date.now());
    state = r.state;
    if (r.toSeal !== null) void sealAndSend(r.toSeal);
    persistDay();
  }, TICK_MS);
  // Do not keep the process alive for a telemetry tick.
  tick.unref?.();

  // ── Seal-and-send ──────────────────────────────────────────────────
  async function sealAndSend(finished: TelemetryDayState): Promise<void> {
    // THE gate. Local counting always runs; leaving the machine is
    // opt-in, checked at the moment of sending, strictly.
    if (!maySend(consent)) {
      log.info('rollup sealed locally, consent not granted — not sent', { day: finished.day });
      return;
    }
    try {
      const health = await getHealthApi().snapshot();
      const rollup = buildDailyRollup({
        installId: identity.installId,
        nowMs: Date.now(),
        version: opts.version,
        platform: process.platform,
        arch: process.arch,
        activeMs: finished.activeMs,
        counters: finished.counters,
        health: {
          signedIn: health.auth.signedIn === true,
          neonConfigured: health.neon.ready === true,
          totpConfigured: health.totp.configured === true,
          updaterHealthy: health.updater.failedAttempts === 0,
        },
      });
      // Belt-and-braces on the boundary: nothing beyond the disclosure
      // may ship, even if a future field slips past review.
      const violations = disclosureViolations(rollup);
      if (violations.length > 0) {
        log.error('rollup exceeds the consent disclosure — refusing to send', { violations });
        return;
      }
      const spaceId = await ensureInstallSpace();
      if (spaceId === null) {
        log.warn('install Space unavailable — rollup not sent', { day: rollup.day });
        return;
      }
      await getSpacesApi().items.create({
        spaceId,
        title: rollupTitle(rollup),
        kind: 'text',
        content: renderRollupContent(rollup),
        metadata: {
          source: 'lite-telemetry',
          installId: rollup.installId,
          day: rollup.day,
          schemaVersion: rollup.schemaVersion,
        },
      });
      log.info('daily rollup sent', { day: rollup.day, spaceId });
    } catch (err) {
      // Soft by contract: telemetry must never surface an error to the
      // user or retry aggressively. Missing a day is fine.
      log.warn('rollup send failed', { day: finished.day, error: (err as Error).message });
    }
  }

  // ── The per-install Space ──────────────────────────────────────────
  // Restricted, with the maintainer granted permanent access. The
  // creating user is auto-granted by the ADR-051 restrict path, so the
  // install's own user can always see what their machine reports —
  // the transparency half of the consent story.
  async function ensureInstallSpace(): Promise<string | null> {
    if (installSpaceId !== null) return installSpaceId;
    const name = `Lite Install ${shortInstallId(identity.installId)}`;
    try {
      const spaces = await getSpacesApi().listSpaces();
      const existing = spaces.find((s) => s.name === name);
      if (existing !== undefined) {
        installSpaceId = existing.id;
        return installSpaceId;
      }
      const created = await getSpacesApi().createSpace({
        name,
        description:
          'Daily usage rollups from one installed copy of Onereach.ai Lite. ' +
          'Each item is a per-day summary: version, platform, app-open minutes, ' +
          'error counts by area, and which surfaces were opened. Sent only with ' +
          'the user’s consent; no content, filenames, or messages are ever included.',
        color: '#7bdbff',
        iconKey: 'activity',
      });
      await getSpacesApi().updateSpace(created.id, { visibility: 'restricted' });
      try {
        await getSpacesApi().members.add(created.id, MAINTAINER_PERSON_ID, { expiresAt: null });
      } catch (err) {
        // The Space still works for the user themselves; the maintainer
        // grant can be repaired later. Log loudly — a silent miss here
        // means the alpha dashboard quietly sees nothing.
        log.warn('maintainer grant failed on install Space', {
          spaceId: created.id,
          error: (err as Error).message,
        });
      }
      installSpaceId = created.id;
      return installSpaceId;
    } catch (err) {
      log.warn('ensureInstallSpace failed', { error: (err as Error).message });
      return null;
    }
  }

  // ── IPC for the Settings toggle ────────────────────────────────────
  const getStatus = (): TelemetryStatus => ({
    installId: identity.installId,
    consent,
    day: state.day,
    spaceId: installSpaceId,
  });

  const setConsent = (decision: 'granted' | 'denied'): TelemetryStatus => {
    consent = recordDecision(decision, opts.version, new Date().toISOString());
    persistConsent();
    log.info('telemetry consent changed', { state: decision });
    return getStatus();
  };

  ipcMain.handle(TELEMETRY_IPC.GET_STATUS, () => getStatus());
  ipcMain.handle(TELEMETRY_IPC.SET_CONSENT, (_ev, payload: { state?: unknown }) => {
    const requested = payload?.state;
    // Strict: an IPC payload is untrusted input. Anything that is not
    // exactly one of the two decisions is ignored, state unchanged.
    if (requested !== 'granted' && requested !== 'denied') return getStatus();
    return setConsent(requested);
  });

  // ── The one-time ask ───────────────────────────────────────────────
  async function promptIfNeeded(parent: BrowserWindow | null): Promise<void> {
    if (!shouldPrompt(consent)) return;
    const detail = [
      CONSENT_DISCLOSURE.body,
      '',
      'What is shared:',
      ...CONSENT_DISCLOSURE.sends.map((s) => `  • ${s}`),
      '',
      'Never shared:',
      ...CONSENT_DISCLOSURE.neverSends.map((s) => `  • ${s}`),
      '',
      CONSENT_DISCLOSURE.footer,
    ].join('\n');
    const options = {
      type: 'question' as const,
      title: CONSENT_DISCLOSURE.title,
      message: CONSENT_DISCLOSURE.title,
      detail,
      buttons: ['Share', 'Don’t Share'],
      // Escape / close means the safe answer, and the default focus is
      // the affirmative — the same shape Apple uses for its analytics
      // ask: easy to accept, but dismissal never consents.
      defaultId: 0,
      cancelId: 1,
    };
    const result =
      parent !== null && !parent.isDestroyed()
        ? await dialog.showMessageBox(parent, options)
        : await dialog.showMessageBox(options);
    setConsent(result.response === 0 ? 'granted' : 'denied');
  }

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearInterval(tick);
    unsubscribe();
    persistDay();
    ipcMain.removeHandler(TELEMETRY_IPC.GET_STATUS);
    ipcMain.removeHandler(TELEMETRY_IPC.SET_CONSENT);
  };
  app.on('before-quit', dispose);

  log.info('telemetry initialized', {
    installId: identity.installId,
    consent: consent.state,
    day: state.day,
  });

  const handle: TelemetryHandle = { promptIfNeeded, getStatus, setConsent, dispose };
  // Install the real implementation behind getTelemetryApi() (ADR-019
  // singleton swap -- same shape as health/auth/spaces).
  _setTelemetryApiForTesting(handle);
  return handle;
}

// ── File readers (tolerant by design) ────────────────────────────────

function readConsentFile(file: string): TelemetryConsentRecord {
  try {
    if (!fs.existsSync(file)) return { state: 'unset' };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { state?: unknown };
    if (parsed.state === 'granted' || parsed.state === 'denied') {
      return parsed as TelemetryConsentRecord;
    }
    return { state: 'unset' };
  } catch {
    // Unreadable consent is UNSET, never granted: the ask is re-owed,
    // and nothing sends meanwhile.
    return { state: 'unset' };
  }
}

function readDayFile(file: string): TelemetryDayState | null {
  try {
    if (!fs.existsSync(file)) return null;
    return parseDayState(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Human-readable body for the Space item; the JSON block is for tools. */
function renderRollupContent(rollup: DailyRollup): string {
  const lines: string[] = [];
  lines.push(`# Daily rollup — ${rollup.day}`);
  lines.push('');
  lines.push(`- **Version:** ${rollup.version} (${rollup.platform}/${rollup.arch})`);
  lines.push(`- **App open:** ${rollup.activeMinutes} min`);
  lines.push(`- **Launches:** ${rollup.counters.launches}`);
  lines.push(`- **Bug reports filed:** ${rollup.counters.bugReportsFiled}`);
  const errs = Object.entries(rollup.counters.errorsByCategory);
  lines.push(
    errs.length === 0
      ? '- **Errors:** none'
      : `- **Errors:** ${errs.map(([k, v]) => `${k} ×${v}`).join(', ')}`
  );
  const surf = Object.entries(rollup.counters.surfacesOpened);
  if (surf.length > 0) {
    lines.push(`- **Surfaces:** ${surf.map(([k, v]) => `${k} ×${v}`).join(', ')}`);
  }
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(rollup, null, 2));
  lines.push('```');
  return lines.join('\n');
}
