/**
 * GSX Designer → Spaces sync (ADR-091).
 *
 * When the Spaces window opens, the bots the signed-in account has in
 * GSX Designer ("the space that flows are in") become Spaces, and every
 * flow inside them becomes an **agent** asset of that Space — a
 * **GSX agent flow**, the name these carry everywhere in Lite since
 * 2026-09-05. Each one links two ways: the flow in Designer, and the
 * flow's View in Action Desk when it has one. Re-running
 * is idempotent: ids derive from the GSX ids (plus the viewer, because a
 * Space has one creator), names/descriptions are refreshed, and a flow
 * that vanished from Designer retires its asset (soft delete).
 *
 * Soft-failing by design:
 *   - signed out / no account → aborts quietly (retried on next open),
 *   - the account has no `refresh_token` flow (404) → aborts quietly,
 *   - one bot's flow list failing (the data hub 500s on one of them
 *     today) is counted and skipped — it never stops the sweep,
 *   - the GRAPH being down (2026-09-05: the neon2 proxy answered every
 *     query, even `RETURN 1`, with HTTP 500 after 29 s) must cost one
 *     cheap ping, not twelve bots × 29 s of writes that cannot land: the
 *     sweep pings the graph before it reads Designer, and the first bot
 *     that fails on a graph error stops the sweep (circuit-breaker).
 *     Both abort with reason `graph-unavailable`; the trigger's cooldown
 *     spaces the retries.
 *
 * Fully dependency-injected so tests drive it without Electron, the
 * graph, or GSX.
 */

import type { GsxFlowsPort, GsxView } from './gsx-flows-port.js';
import { GsxFlowsError } from './gsx-flows-port.js';

/** Slice of the SdkSpacesClient the sync needs. */
export interface GsxFlowSyncClient {
  upsertGsxFlowSpace(input: {
    id: string;
    gsxBotId: string;
    name: string;
    description: string;
  }): Promise<{
    id: string;
    created: boolean;
    /** ADR-099 — false when the person only holds READ sight of another creator's mirror. */
    writable?: boolean;
  }>;
  /** True when a NON-synced Space already uses this name (case-insensitive). */
  spaceNameTaken(name: string, exceptSpaceId: string): Promise<boolean>;
  /** One batched write per bot (UNWIND); returns one row per flow. */
  upsertGsxFlowAgents(
    spaceId: string,
    gsxBotId: string,
    rows: Array<{
      assetId: string;
      agentId: string;
      typeId: string;
      gsxFlowId: string;
      name: string;
      description: string;
      content: string;
      sourceUrl: string;
      metadata: Record<string, string>;
    }>
  ): Promise<Array<{ id: string; created: boolean }>>;
  listGsxFlowAgents(spaceId: string): Promise<Array<{ assetId: string; gsxFlowId: string }>>;
  retireGsxFlowAgent(assetId: string): Promise<boolean>;
  /**
   * ADR-092 — the viewer's own Space that became this bot (created in
   * Lite, then mirrored to Designer). When it exists, the bot's flows
   * land there and no mirror Space is minted.
   */
  spaceByGsxBotId?(gsxBotId: string): Promise<{ id: string; name: string } | null>;
  /**
   * Cheap graph liveness check (`RETURN 1`); false or a throw means the
   * graph is not answering and the sweep must not start. Optional so
   * older clients and fakes still work; without it the sweep relies on
   * the circuit-breaker alone.
   */
  ping?(): Promise<boolean>;
  /** ADR-099 — the group Space new mirrors are born inside; null when a person deleted it. */
  upsertGroupSpace?(input: {
    id: string;
    name: string;
    description: string;
    color: string;
    iconKey: string;
  }): Promise<{ id: string; name: string } | null>;
  /** ADR-085 — nest (inheritance off): organization only. */
  nestSpace?(
    childId: string,
    parentId: string,
    inheritsPermissions: boolean,
    inheritsUntil: string | null
  ): Promise<unknown>;
  /** ADR-099 convergence — retire this person's legacy viewer-suffixed mirror (their own items stay theirs). */
  foldLegacyGsxMirror?(
    legacyId: string,
    targetId: string
  ): Promise<{ folded: boolean; agentsRetired: number; itemsKept: number }>;
  /** ADR-099 — the viewer's writable mirrors, for orphan detection after a complete sweep. */
  listGsxMirrorSpaces?(): Promise<Array<{ id: string; gsxBotId: string }>>;
  /** ADR-099 — archive a mirror whose bot left Designer. */
  archiveSpace?(id: string, reason: string): Promise<boolean>;
}

/**
 * True when an error means the GRAPH is not answering (as opposed to
 * Designer, one bot, or a permission refusal) — the case where continuing
 * the sweep can only fail the same way for every remaining bot.
 */
export function isGraphOutage(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
  // The client's own transport code: the graph, never this query.
  if (e.code === 'SPACES_NETWORK') return true;
  // Look through the client's wrap to the transport error it carries.
  // A query the graph REFUSED (bad Cypher, a constraint, a 4xx) is that
  // bot's problem and must not stop the sweep for every bot after it
  // (2026-09-06 review); a timeout, a network failure or a 5xx is the
  // graph, and so is a transport error we cannot classify.
  const neon = neonErrorIn(e);
  if (neon !== null) {
    if (neon.code === 'NEON_QUERY' || neon.code === 'NEON_BAD_INPUT') return false;
    if (neon.code === 'NEON_HTTP' && typeof neon.status === 'number' && neon.status >= 400 && neon.status < 500) return false;
    return true;
  }
  if (e.code === 'SPACES_CYPHER') return true;
  const message = typeof e.message === 'string' ? e.message : '';
  return /Neon query failed|omnidata\/neon/i.test(message);
}

function neonErrorIn(e: { name?: unknown; cause?: unknown }): { code?: unknown; status?: unknown } | null {
  if (e.name === 'NeonError') return e as { code?: unknown; status?: unknown };
  const cause = e.cause;
  if (cause !== null && typeof cause === 'object' && (cause as { name?: unknown }).name === 'NeonError') {
    return cause as { code?: unknown; status?: unknown };
  }
  return null;
}

export interface GsxFlowSyncLog {
  start(name: string, data?: unknown): { finish(data?: unknown): void; fail(err: unknown): void };
  event(name: string, data?: unknown): void;
  info(category: string, message: string, data?: unknown): void;
  warn(category: string, message: string, data?: unknown): void;
}

export interface GsxFlowSyncDeps {
  client: GsxFlowSyncClient;
  port: GsxFlowsPort;
  log: GsxFlowSyncLog;
  /** The signed-in viewer (Person id); null when signed out. */
  viewerId: () => string | null;
  /** GSX environment for Designer links (`studio.<env>.onereach.ai`). */
  env: string;
  /** The GSX account, appended to view links so Action Desk opens the right account. */
  accountId?: string;
  /** Plan only: read Designer, touch nothing in the graph (counts as "created"). */
  dryRun?: boolean;
}

export interface GsxFlowSyncResult {
  bots: number;
  botsFailed: number;
  spacesCreated: number;
  spacesUpdated: number;
  flows: number;
  agentsCreated: number;
  agentsUpdated: number;
  agentsRetired: number;
  /** ADR-099 — mirrors archived because their bot left Designer. */
  spacesArchived: number;
  /** ADR-099 — legacy per-person mirrors folded into account Spaces. */
  legacyFolded: number;
  aborted: boolean;
  reason?: string;
}

/**
 * ADR-099 — deterministic, ACCOUNT-level ids: one mirror Space per bot,
 * one agent per flow, whoever syncs. The first person to sync creates
 * the Space; everyone after is granted sight (GRANT_SELF_GSX_MIRROR).
 */
export function gsxSyncIds(botId: string, flowId?: string): {
  spaceId: string;
  assetId: string;
  agentId: string;
  typeId: string;
} {
  const f = flowId ?? '';
  return {
    spaceId: `space-gsxbot-${botId}`,
    assetId: `asset-gsxflow-${f}`,
    agentId: `agent-gsxflow-${f}`,
    typeId: `agenttype-gsxflow-${f}`,
  };
}

/**
 * ADR-091's viewer-scoped ids (`…-<hash of viewer>`), kept only so each
 * person's sync can find and fold the private copies it minted before
 * ADR-099. Never used for anything new.
 */
export function legacyGsxSyncIds(viewerId: string, botId: string, flowId?: string): {
  spaceId: string;
  assetId: string;
  agentId: string;
  typeId: string;
} {
  const v = shortHash(viewerId);
  const f = flowId ?? '';
  return {
    spaceId: `space-gsxbot-${botId}-${v}`,
    assetId: `asset-gsxflow-${f}-${v}`,
    agentId: `agent-gsxflow-${f}-${v}`,
    typeId: `agenttype-gsxflow-${f}-${v}`,
  };
}

/**
 * ADR-099 — the group Space Lite's Designer mirrors are born inside.
 * Inheritance off: the group is organization, never permission.
 */
export const GSX_DESIGNER_GROUP = {
  id: 'space-group-gsx-designer',
  name: 'GSX Designer',
  description:
    'Spaces Onereach Desktop makes on its own: one per GSX Designer bot, filled with that bot\'s agent flows. ' +
    'Put your own Spaces anywhere; these stay grouped here unless you move them.',
  color: '#3f78c0',
  iconKey: 'bot',
} as const;

/** FNV-1a 32-bit, hex — stable across processes, no crypto needed. */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function designerBotUrl(env: string, botId: string): string {
  return `https://studio.${env}.onereach.ai/flows/${encodeURIComponent(botId)}`;
}

export function designerFlowUrl(env: string, botId: string, flowId: string): string {
  return `${designerBotUrl(env, botId)}/${encodeURIComponent(flowId)}`;
}

/**
 * A view in Action Desk (`actiondesk.<env>.onereach.ai/views/<id>`, the
 * link Action Desk's own list uses), with the account so a multi-account
 * user lands in the right one.
 */
export function actionDeskViewUrl(env: string, viewId: string, accountId?: string): string {
  const base = `https://actiondesk.${env}.onereach.ai/views/${encodeURIComponent(viewId)}`;
  return accountId !== undefined && accountId.length > 0 ? `${base}?accountId=${encodeURIComponent(accountId)}` : base;
}

/**
 * The view for each flow: the most recently modified one when a flow
 * has several (Action Desk keeps every version a user saved).
 */
export function viewsByFlow(views: readonly GsxView[]): Map<string, GsxView> {
  const out = new Map<string, GsxView>();
  for (const v of views) {
    if (v.flowId === null) continue;
    const prev = out.get(v.flowId);
    if (prev === undefined || (v.dateModified ?? 0) > (prev.dateModified ?? 0)) out.set(v.flowId, v);
  }
  return out;
}

/** The agent's body — what the detail pane shows for a GSX agent flow. */
export function flowAgentContent(input: {
  label: string;
  botLabel: string;
  description: string;
  categories: string[];
  version: string;
  dateModified: number | null;
  url: string;
  viewUrl?: string | null;
  viewLabel?: string;
}): string {
  const viewUrl = typeof input.viewUrl === 'string' && input.viewUrl.length > 0 ? input.viewUrl : null;
  const lines = [
    `# ${input.label}`,
    '',
    `A GSX agent flow in **${input.botLabel}**, synced into this Space as an agent.`,
    '',
    ...(input.description.length > 0 ? [input.description, ''] : []),
    `- Open in Designer: ${input.url}`,
    ...(viewUrl !== null
      ? [`- Open view${input.viewLabel !== undefined && input.viewLabel.length > 0 ? ` (${input.viewLabel})` : ''}: ${viewUrl}`]
      : []),
    ...(input.categories.length > 0 ? [`- Categories: ${input.categories.join(', ')}`] : []),
    ...(input.version.length > 0 ? [`- Version: ${input.version}`] : []),
    ...(input.dateModified !== null ? [`- Last modified: ${new Date(input.dateModified).toISOString()}`] : []),
  ];
  return lines.join('\n');
}

/**
 * Run one sweep. Never throws — every outcome resolves to a result the
 * caller can log and forget.
 */
export async function runGsxFlowSync(deps: GsxFlowSyncDeps): Promise<GsxFlowSyncResult> {
  const result: GsxFlowSyncResult = {
    bots: 0,
    botsFailed: 0,
    spacesCreated: 0,
    spacesUpdated: 0,
    flows: 0,
    agentsCreated: 0,
    agentsUpdated: 0,
    agentsRetired: 0,
    spacesArchived: 0,
    legacyFolded: 0,
    aborted: false,
  };
  const span = deps.log.start('spaces.gsxFlowSync');
  const viewer = deps.viewerId();
  if (viewer === null || viewer.length === 0) {
    result.aborted = true;
    result.reason = 'signed-out';
    span.finish({ ...result });
    return result;
  }

  // Pre-flight: one cheap graph round-trip BEFORE Designer is read. When
  // the graph is down every write below would wait out the proxy timeout
  // and fail; abort here for the price of a single ping.
  if (typeof deps.client.ping === 'function') {
    let alive = false;
    let pingError: string | null = null;
    try {
      alive = await deps.client.ping();
    } catch (err) {
      pingError = err instanceof Error ? err.message : String(err);
    }
    if (!alive) {
      result.aborted = true;
      result.reason = 'graph-unavailable';
      deps.log.warn('spaces', 'gsx-flow-sync: graph unavailable; aborting before Designer is read', {
        ...(pingError !== null ? { error: pingError } : {}),
      });
      span.finish({ ...result });
      return result;
    }
  }

  let bots;
  try {
    bots = await deps.port.listBots();
  } catch (err) {
    result.aborted = true;
    result.reason = err instanceof GsxFlowsError && err.status === 404 ? 'no-refresh-token-flow' : 'bots-unavailable';
    deps.log.info('spaces', 'gsx-flow-sync: bots unavailable; aborting', {
      reason: result.reason,
      error: err instanceof Error ? err.message : String(err),
    });
    span.finish({ ...result });
    return result;
  }
  result.bots = bots.length;

  // Views once per sweep (there are few); a flow's view rides along on
  // its agent. Unavailable views never stop the sweep — the agents just
  // link to Designer only, as before.
  let viewByFlow = new Map<string, GsxView>();
  if (typeof deps.port.listViews === 'function') {
    try {
      viewByFlow = viewsByFlow(await deps.port.listViews());
    } catch (err) {
      deps.log.info('spaces', 'gsx-flow-sync: views unavailable; agents link to Designer only', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ADR-099 — the group new mirrors are born inside. Resolved once per
  // sweep, lazily (a sweep that creates nothing never touches it); a
  // failure leaves mirrors top-level rather than stopping the sync.
  let groupId: string | null | undefined;
  const groupSpaceId = async (): Promise<string | null> => {
    if (groupId !== undefined) return groupId;
    if (deps.dryRun === true || typeof deps.client.upsertGroupSpace !== 'function') {
      groupId = null;
      return null;
    }
    try {
      const group = await deps.client.upsertGroupSpace(GSX_DESIGNER_GROUP);
      groupId = group?.id ?? null;
    } catch (err) {
      groupId = null;
      deps.log.warn('spaces', 'gsx-flow-sync: group Space unavailable; mirrors stay top-level', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return groupId;
  };

  for (const bot of bots) {
    const botSpan = deps.log.start('spaces.gsxFlowSync.bot', { botId: bot.id });
    try {
      const ids = gsxSyncIds(bot.id);
      // ADR-092: a Space the viewer created in Lite that became this bot
      // is the bot's home — its flows go there, its name and description
      // stay the user's, and no mirror Space is minted.
      const own =
        typeof deps.client.spaceByGsxBotId === 'function' ? await deps.client.spaceByGsxBotId(bot.id) : null;
      let space: { id: string; created: boolean; writable?: boolean };
      if (own !== null) {
        space = { id: own.id, created: false };
      } else {
        // Name: the bot's label, unless a user-made Space already owns it.
        let name = bot.label.trim().length > 0 ? bot.label.trim() : bot.id;
        if (await deps.client.spaceNameTaken(name, ids.spaceId)) name = `${name} (GSX)`;
        const description =
          `Synced from GSX Designer — the GSX agent flows of bot “${bot.label}”. ${designerBotUrl(deps.env, bot.id)}` +
          (bot.description.length > 0 ? `\n\n${bot.description}` : '');
        space =
          deps.dryRun === true
            ? { id: ids.spaceId, created: true }
            : await deps.client.upsertGsxFlowSpace({
                id: ids.spaceId,
                gsxBotId: bot.id,
                name,
                description,
              });
      }
      if (space.created) result.spacesCreated += 1;
      else result.spacesUpdated += 1;

      if (own === null && deps.dryRun !== true) {
        // Born nested — only when CREATED: a person who pulls a mirror out
        // of the group is not fought on the next sweep.
        if (space.created && typeof deps.client.nestSpace === 'function') {
          const parent = await groupSpaceId();
          if (parent !== null) {
            try {
              await deps.client.nestSpace(space.id, parent, false, null);
            } catch (err) {
              deps.log.warn('spaces', 'gsx-flow-sync: could not nest mirror in the group', {
                spaceId: space.id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
      }

      // ADR-099 — another person's sync keeps this mirror: this person
      // holds read sight and writes nothing into it.
      if (space.writable === false) {
        botSpan.finish({ readOnly: true });
        continue;
      }

      let flows;
      try {
        flows = await deps.port.listFlows(bot.id);
      } catch (err) {
        // One bot's list failing (the data hub 500s on one today) must not
        // stop the sweep — and must not retire that bot's agents either.
        result.botsFailed += 1;
        deps.log.warn('spaces', 'gsx-flow-sync: flows unavailable for bot; skipping', {
          botId: bot.id,
          error: err instanceof Error ? err.message : String(err),
        });
        botSpan.finish({ skipped: true });
        continue;
      }
      const live = flows.filter((f) => !f.isDeleted);
      result.flows += live.length;
      const seen = new Set<string>();
      const rows: Parameters<GsxFlowSyncClient['upsertGsxFlowAgents']>[2] = [];
      for (const flow of live) {
        const fids = gsxSyncIds(bot.id, flow.id);
        const url = designerFlowUrl(deps.env, bot.id, flow.id);
        const view = viewByFlow.get(flow.id) ?? null;
        const viewUrl = view !== null ? actionDeskViewUrl(deps.env, view.id, deps.accountId) : null;
        seen.add(flow.id);
        rows.push({
          assetId: fids.assetId,
          agentId: fids.agentId,
          typeId: fids.typeId,
          gsxFlowId: flow.id,
          name: flow.label,
          description: flow.description.length > 0 ? flow.description : `GSX agent flow in ${bot.label}.`,
          content: flowAgentContent({
            label: flow.label,
            botLabel: bot.label,
            description: flow.description,
            categories: flow.categories,
            version: flow.version,
            dateModified: flow.dateModified,
            url,
            viewUrl,
            ...(view !== null ? { viewLabel: view.label } : {}),
          }),
          sourceUrl: url,
          metadata: {
            source: 'gsx-designer',
            gsxBotId: bot.id,
            gsxBotLabel: bot.label,
            gsxFlowId: flow.id,
            gsxDesignerUrl: url,
            gsxVersion: flow.version,
            gsxDateModified: flow.dateModified !== null ? new Date(flow.dateModified).toISOString() : '',
            gsxCategories: flow.categories.join(', '),
            ...(view !== null && viewUrl !== null
              ? { gsxViewId: view.id, gsxViewUrl: viewUrl, gsxViewLabel: view.label }
              : {}),
          },
        });
      }
      if (deps.dryRun === true) {
        result.agentsCreated += rows.length;
      } else if (rows.length > 0) {
        const written = await deps.client.upsertGsxFlowAgents(space.id, bot.id, rows);
        for (const w of written) {
          if (w.created) result.agentsCreated += 1;
          else result.agentsUpdated += 1;
        }
      }
      // Flows that left Designer retire their agent (soft delete).
      const existing = deps.dryRun === true ? [] : await deps.client.listGsxFlowAgents(space.id);
      for (const row of existing) {
        if (seen.has(row.gsxFlowId)) continue;
        if (await deps.client.retireGsxFlowAgent(row.assetId)) result.agentsRetired += 1;
      }
      // ADR-099 convergence — only once the account Space holds this
      // bot's agents: this person's pre-ADR-099 private copy retires its
      // synced agents (a no-op once it is gone); their own items stay
      // theirs in a Space that stops being a mirror.
      if (own === null && deps.dryRun !== true && typeof deps.client.foldLegacyGsxMirror === 'function') {
        const legacyId = legacyGsxSyncIds(viewer, bot.id).spaceId;
        if (legacyId !== space.id) {
          const fold = await deps.client.foldLegacyGsxMirror(legacyId, space.id);
          if (fold.folded) {
            result.legacyFolded += 1;
            deps.log.info('spaces', 'gsx-flow-sync: legacy mirror folded', {
              legacyId,
              spaceId: space.id,
              agentsRetired: fold.agentsRetired,
              itemsKept: fold.itemsKept,
              keptAsOwnSpace: fold.itemsKept > 0,
            });
          }
        }
      }
      botSpan.finish({ flows: live.length });
    } catch (err) {
      result.botsFailed += 1;
      botSpan.fail(err);
      if (isGraphOutage(err)) {
        // Circuit-breaker: the graph stopped answering mid-sweep. Every
        // remaining bot would fail the same way after the same timeout.
        result.aborted = true;
        result.reason = 'graph-unavailable';
        deps.log.warn('spaces', 'gsx-flow-sync: graph unavailable; sweep stopped', {
          botId: bot.id,
          botsDone: bots.indexOf(bot),
          botsSkipped: bots.length - bots.indexOf(bot) - 1,
          error: err instanceof Error ? err.message : String(err),
        });
        break;
      }
      deps.log.warn('spaces', 'gsx-flow-sync: bot failed', {
        botId: bot.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ADR-099 — mirrors whose bot left Designer are archived, not kept
  // forever (the gap ADR-091 documented). Only after a sweep that listed
  // Designer completely and was not cut off: an aborted sweep or an empty
  // listing says nothing about any bot.
  if (
    !result.aborted &&
    bots.length > 0 &&
    deps.dryRun !== true &&
    typeof deps.client.listGsxMirrorSpaces === 'function' &&
    typeof deps.client.archiveSpace === 'function'
  ) {
    try {
      const live = new Set(bots.map((b) => b.id));
      for (const mirror of await deps.client.listGsxMirrorSpaces()) {
        if (live.has(mirror.gsxBotId)) continue;
        if (await deps.client.archiveSpace(mirror.id, 'gsx-bot-gone')) {
          result.spacesArchived += 1;
          deps.log.info('spaces', 'gsx-flow-sync: mirror archived; its bot left Designer', {
            spaceId: mirror.id,
            gsxBotId: mirror.gsxBotId,
          });
        }
      }
    } catch (err) {
      deps.log.warn('spaces', 'gsx-flow-sync: orphan check failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  span.finish({ ...result });
  return result;
}
