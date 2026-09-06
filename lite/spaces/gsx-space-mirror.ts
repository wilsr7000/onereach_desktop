/**
 * A Space made in Lite is a GSX space too (ADR-092, 2026-09-05).
 *
 * "When a space is created it should be created in GSX as well as in
 * NEON." What GSX Designer calls a space is a **bot**, so creating a
 * Space in Lite also creates a bot of the same name in Designer, and
 * the Space remembers it (`gsxBotId`). From then on the Designer sync
 * (ADR-091) fills THIS Space with the bot's GSX agent flows instead of
 * minting a mirror Space of the same name.
 *
 * Best-effort by design: the Space exists in NEON before this runs and
 * stays whatever happens here. Signed out, a hub that refuses, a
 * network that is down — each is a logged, reported outcome, never a
 * failed Space. Fully dependency-injected so tests drive it without
 * Electron, the graph, or GSX.
 */

import type { GsxFlowsPort } from './gsx-flows-port.js';
import { GsxFlowsError } from './gsx-flows-port.js';

export interface GsxSpaceMirrorClient {
  /** Stamp the Space with its Designer bot; false when the Space is not writable. */
  setSpaceGsxBot(spaceId: string, gsxBotId: string, gsxBotLabel: string): Promise<boolean>;
}

export interface GsxSpaceMirrorLog {
  start(name: string, data?: unknown): { finish(data?: unknown): void; fail(err: unknown): void };
  warn(category: string, message: string, data?: unknown): void;
}

export interface GsxSpaceMirrorDeps {
  /** Null when nobody is signed in (no account, no token). */
  port: Pick<GsxFlowsPort, 'createBot'> | null;
  client: GsxSpaceMirrorClient;
  log: GsxSpaceMirrorLog;
}

export type GsxSpaceMirrorResult =
  | { mirrored: true; botId: string; stamped: boolean }
  | { mirrored: false; reason: 'signed-out' | 'unsupported' | 'failed'; error?: string };

/** Human wording for the toast, one line, no jargon. */
export function describeMirrorOutcome(result: GsxSpaceMirrorResult): string {
  if (result.mirrored) {
    return result.stamped
      ? 'also created as a GSX space in Designer'
      : 'created as a GSX space in Designer, but this Space could not be linked to it';
  }
  switch (result.reason) {
    case 'signed-out':
      return 'not created in GSX — sign in to OneReach first';
    case 'unsupported':
      return 'not created in GSX';
    default:
      return 'not created in GSX — Designer did not accept it (see Logs)';
  }
}

export async function mirrorSpaceToGsx(
  deps: GsxSpaceMirrorDeps,
  space: { id: string; name: string; description?: string }
): Promise<GsxSpaceMirrorResult> {
  if (deps.port === null) return { mirrored: false, reason: 'signed-out' };
  if (typeof deps.port.createBot !== 'function') return { mirrored: false, reason: 'unsupported' };
  const span = deps.log.start('spaces.gsxBot.create', { spaceId: space.id });
  let botId: string;
  try {
    const bot = await deps.port.createBot({ label: space.name, description: space.description ?? '' });
    botId = bot.id;
  } catch (err) {
    span.fail(err);
    const status = err instanceof GsxFlowsError ? err.status : undefined;
    return {
      mirrored: false,
      reason: status === 401 ? 'signed-out' : 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
  // The bot exists now. A stamp that fails leaves a bot with no Space
  // pointing at it — the sync would then mint a mirror Space for it on
  // its next sweep, which is the pre-ADR-092 behaviour, so nothing is
  // lost; it is reported, not hidden.
  let stamped = false;
  try {
    stamped = await deps.client.setSpaceGsxBot(space.id, botId, space.name);
  } catch (err) {
    deps.log.warn('spaces', 'gsx space mirror: bot created but the Space could not be stamped', {
      spaceId: space.id,
      botId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  span.finish({ botId, stamped });
  return { mirrored: true, botId, stamped };
}
