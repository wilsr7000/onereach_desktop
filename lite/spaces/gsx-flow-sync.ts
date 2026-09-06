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
 *     today) is counted and skipped — it never stops the sweep.
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
  }): Promise<{ id: string; created: boolean }>;
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
  aborted: boolean;
  reason?: string;
}

/** Deterministic, viewer-scoped ids — a Space has exactly one creator. */
export function gsxSyncIds(viewerId: string, botId: string, flowId?: string): {
  spaceId: string;
  assetId: string;
  agentId: string;
  typeId: string;
} {
  const v = shortHash(viewerId);
  const spaceId = `space-gsxbot-${botId}-${v}`;
  const f = flowId ?? '';
  return {
    spaceId,
    assetId: `asset-gsxflow-${f}-${v}`,
    agentId: `agent-gsxflow-${f}-${v}`,
    typeId: `agenttype-gsxflow-${f}-${v}`,
  };
}

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

  for (const bot of bots) {
    const botSpan = deps.log.start('spaces.gsxFlowSync.bot', { botId: bot.id });
    try {
      const ids = gsxSyncIds(viewer, bot.id);
      // ADR-092: a Space the viewer created in Lite that became this bot
      // is the bot's home — its flows go there, its name and description
      // stay the user's, and no mirror Space is minted.
      const own =
        typeof deps.client.spaceByGsxBotId === 'function' ? await deps.client.spaceByGsxBotId(bot.id) : null;
      let space: { id: string; created: boolean };
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
        const fids = gsxSyncIds(viewer, bot.id, flow.id);
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
      botSpan.finish({ flows: live.length });
    } catch (err) {
      result.botsFailed += 1;
      deps.log.warn('spaces', 'gsx-flow-sync: bot failed', {
        botId: bot.id,
        error: err instanceof Error ? err.message : String(err),
      });
      botSpan.fail(err);
    }
  }
  span.finish({ ...result });
  return result;
}
