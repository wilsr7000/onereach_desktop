/**
 * Spaces MCP server — connect Spaces to Claude (2026-08-20: "could we
 * connect spaces to a claude project or whatever the equivalent would
 * be … or the other way, whatever claude allows users to add docs to").
 *
 * Both directions, one program:
 *
 *   LIVE (MCP, stdio)  Claude Code / Claude Desktop attach this server
 *                      and get tools to list, read, search, and create
 *                      Space assets — a Space becomes live project
 *                      knowledge. (claude.ai custom connectors need a
 *                      HOSTED remote MCP; this runs locally.)
 *
 *   DOCS (export)      `--export <spaceId> <dir>` materializes a Space
 *                      as clean markdown (one file per asset + INDEX.md)
 *                      for claude.ai Project knowledge — which has no
 *                      upload API, so a drag-in folder is the honest
 *                      bridge.
 *
 * One implementation, not a parallel one: this wraps the REAL
 * SdkSpacesClient, so every read/write rides the production Cypher —
 * ADR-051 visibility, ADR-074 read-only roles, ADR-070 caller tag
 * (`spaces-mcp`) — with the viewer identity from SPACES_VIEWER_ID.
 * No identity, no access: the queries themselves fail closed.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { SdkSpacesClient } from '../spaces/sdk-client.js';
import { resolveSessionViewer } from './session-identity.js';

const NEON2 =
  'https://em.edison.api.onereach.ai/http/35254342-4a2e-475b-aec1-18547e517e29/omnidata/neon2';
const CALLER_TAG = 'spaces-mcp';

/** Build the production client on a plain-fetch neon2 transport. */
export function createSpacesClient(viewerId: string): SdkSpacesClient {
  if (viewerId.trim().length === 0) {
    throw new Error(
      'SPACES_VIEWER_ID is required — the viewer identity IS the permission scope (ADR-051).'
    );
  }
  return new SdkSpacesClient({
    viewerId: () => viewerId,
    query: async (cypher, parameters) => {
      const tagged = cypher.startsWith('/* caller:')
        ? cypher
        : `/* caller:${CALLER_TAG} */\n${cypher}`;
      const res = await fetch(NEON2, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cypher: tagged, parameters: parameters ?? {} }),
      });
      const body = (await res.json().catch(() => null)) as {
        result?: { status?: string; records?: Array<Record<string, unknown>> };
        message?: string;
      } | null;
      if (!res.ok || body?.result?.status !== 'ok') {
        throw new Error(body?.message ?? `neon2 HTTP ${res.status}`);
      }
      return body.result.records ?? [];
    },
  });
}

function text(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [
      { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
    ],
  };
}

/** Register every tool. Exported so tests drive handlers with a fake client. */
export function registerTools(server: McpServer, client: SdkSpacesClient): void {
  server.registerTool(
    'list_spaces',
    {
      description:
        'List every Space the viewer can see: id, name, kind (user|shared), item count, pinned.',
      inputSchema: {},
    },
    async () => text(await client.listSpaces())
  );

  server.registerTool(
    'list_space_contents',
    {
      description: 'List the assets in one Space (summaries: id, title, kind, timestamps).',
      inputSchema: {
        spaceId: z.string().describe('Space id, from list_spaces'),
        limit: z.number().optional().describe('Max rows (default 50)'),
      },
    },
    async ({ spaceId, limit }) =>
      text(await client.listItems({ kind: 'space', spaceId }, { limit: limit ?? 50 }))
  );

  server.registerTool(
    'get_asset',
    {
      description: 'Read one asset in full — title, kind, content, metadata, tags.',
      inputSchema: { id: z.string().describe('Asset id') },
    },
    async ({ id }) => {
      const item = await client.getItem(id);
      return text(item ?? 'Not found (or not visible to this viewer).');
    }
  );

  server.registerTool(
    'search_assets',
    {
      description:
        'Substring search across asset titles, descriptions, and content. Scope to one Space with spaceId.',
      inputSchema: {
        query: z.string(),
        spaceId: z.string().optional(),
        limit: z.number().optional(),
      },
    },
    async ({ query, spaceId, limit }) =>
      text(
        await client.searchItems({
          query,
          ...(spaceId !== undefined ? { spaceId } : {}),
          limit: limit ?? 25,
        })
      )
  );

  server.registerTool(
    'get_current_playbook',
    {
      description:
        "One Space's designated current playbook (the plan agents work against), or a note that none is set.",
      inputSchema: { spaceId: z.string() },
    },
    async ({ spaceId }) => {
      const pb = await client.getCurrentPlaybook(spaceId);
      return text(pb ?? 'No current playbook set for this space.');
    }
  );

  server.registerTool(
    'space_activity',
    {
      description: 'Recent events in a Space (who did what, when). Omit spaceId for all spaces.',
      inputSchema: { spaceId: z.string().optional(), limit: z.number().optional() },
    },
    async ({ spaceId, limit }) =>
      text(
        await client.listRecentEvents({
          ...(spaceId !== undefined ? { spaceId } : {}),
          limit: limit ?? 30,
        })
      )
  );

  server.registerTool(
    'create_asset',
    {
      description:
        'Create a text/markdown asset in a Space. Writes ride the same permission gate as the app (read-only members are refused).',
      inputSchema: {
        spaceId: z.string(),
        title: z.string(),
        content: z.string(),
        kind: z.string().optional().describe("Asset kind (default 'doc')"),
      },
    },
    async ({ spaceId, title, content, kind }) =>
      text(
        await client.createAsset({
          spaceId,
          title,
          content,
          type: kind ?? 'doc',
        } as never)
      )
  );
}

/** Space → markdown folder, for claude.ai Project knowledge. */
export async function exportSpace(
  client: SdkSpacesClient,
  spaceId: string,
  outDir: string
): Promise<{ files: number; indexPath: string }> {
  const items = await client.listItems({ kind: 'space', spaceId }, { limit: 500 });
  await fs.mkdir(outDir, { recursive: true });
  const indexLines: string[] = ['# Space export', ''];
  let files = 0;
  for (const summary of items) {
    const full = await client.getItem(summary.id).catch(() => null);
    if (full === null) continue; // not visible / vanished — never guess
    const safe =
      (summary.title || summary.id)
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .slice(0, 60) || summary.id;
    const file = `${safe}.md`;
    const body = [
      `# ${summary.title || '(untitled)'}`,
      '',
      `> kind: ${summary.kind} · id: ${summary.id}`,
      '',
      typeof (full as { content?: unknown }).content === 'string'
        ? ((full as { content: string }).content)
        : '(no textual content)',
      '',
    ].join('\n');
    await fs.writeFile(path.join(outDir, file), body, 'utf8');
    indexLines.push(`- [${summary.title || summary.id}](${file}) — ${summary.kind}`);
    files += 1;
  }
  const indexPath = path.join(outDir, 'INDEX.md');
  await fs.writeFile(indexPath, indexLines.join('\n') + '\n', 'utf8');
  return { files, indexPath };
}

async function main(): Promise<void> {
  // Tied to the signed-in user: ask the running app's bridge for the
  // authenticated viewer; the env var is only a loud dev fallback.
  const { viewerId } = await resolveSessionViewer({
    env: process.env,
    log: (m) => process.stderr.write(`[spaces-mcp] ${m}\n`),
  });
  const client = createSpacesClient(viewerId);

  const exportAt = process.argv.indexOf('--export');
  if (exportAt >= 0) {
    const spaceId = process.argv[exportAt + 1];
    const dir = process.argv[exportAt + 2];
    if (spaceId === undefined || dir === undefined) {
      process.stderr.write('usage: spaces-mcp --export <spaceId> <outDir>\n');
      process.exit(2);
    }
    const out = await exportSpace(client, spaceId, dir);
    process.stdout.write(
      `Exported ${out.files} asset(s) → ${dir} (drag the folder into a claude.ai Project's knowledge).\n`
    );
    return;
  }

  const server = new McpServer({ name: 'onereach-spaces', version: '1.0.0' });
  registerTools(server, client);
  await server.connect(new StdioServerTransport());
}

// Only run as a program — imports (tests) get the seams without side effects.
if (process.argv[1] !== undefined && /spaces-mcp/.test(process.argv[1])) {
  // Fail closed, but LEGIBLY: a missing identity must be a one-line
  // refusal on stderr, not an unhandled-rejection dump of the bundle.
  main().catch((err: unknown) => {
    process.stderr.write(`[spaces-mcp] refusing to start: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
