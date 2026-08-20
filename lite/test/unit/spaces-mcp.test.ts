/**
 * Spaces MCP server (2026-08-20: "connect spaces to a claude project or
 * whatever the equivalent would be"). Pins the seams: the tool registry
 * registers against the REAL client type (one implementation — the
 * whole point), identity is required (fail closed, ADR-051), and the
 * export writes the folder shape claude.ai Project knowledge accepts.
 */
import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createSpacesClient, registerTools, exportSpace } from '../../mcp/spaces-mcp.js';
import type { SdkSpacesClient } from '../../spaces/sdk-client.js';

function fakeClient(): SdkSpacesClient {
  return {
    listSpaces: vi.fn(async () => [{ id: 'sp-1', name: 'Data Bricks' }]),
    listItems: vi.fn(async () => [
      { id: 'i-1', title: 'Plan A', kind: 'playbook' },
      { id: 'i-2', title: 'Notes: q3 / summary?', kind: 'doc' },
    ]),
    getItem: vi.fn(async (id: string) => ({ id, title: `Item ${id}`, content: `body of ${id}` })),
    searchItems: vi.fn(async () => []),
    getCurrentPlaybook: vi.fn(async () => null),
    listRecentEvents: vi.fn(async () => []),
    createAsset: vi.fn(async () => ({ id: 'new-1' })),
  } as unknown as SdkSpacesClient;
}

describe('identity is the permission scope', () => {
  it('refuses to build a client without a viewer id — fail closed', () => {
    expect(() => createSpacesClient('')).toThrow(/SPACES_VIEWER_ID/);
    expect(() => createSpacesClient('   ')).toThrow(/SPACES_VIEWER_ID/);
  });
});

describe('tool registry', () => {
  it('registers the full toolset against the real client surface', () => {
    const names: string[] = [];
    const server = {
      registerTool: (name: string) => {
        names.push(name);
      },
    };
    registerTools(server as never, fakeClient());
    expect(names.sort()).toEqual([
      'create_asset',
      'get_asset',
      'get_current_playbook',
      'list_space_contents',
      'list_spaces',
      'search_assets',
      'space_activity',
    ]);
  });

  it('handlers return MCP text content from client data', async () => {
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    const server = {
      registerTool: (name: string, _cfg: unknown, handler: never) => {
        handlers.set(name, handler);
      },
    };
    const client = fakeClient();
    registerTools(server as never, client);
    const out = (await handlers.get('list_spaces')!({})) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(out.content[0]!.type).toBe('text');
    expect(out.content[0]!.text).toContain('Data Bricks');
    // A missing asset says so instead of returning nothing.
    const miss = fakeClient();
    (miss.getItem as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const h2 = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    registerTools(
      { registerTool: (n: string, _c: unknown, h: never) => h2.set(n, h) } as never,
      miss
    );
    const notFound = (await h2.get('get_asset')!({ id: 'x' })) as {
      content: Array<{ text: string }>;
    };
    expect(notFound.content[0]!.text).toMatch(/not found|not visible/i);
  });
});

describe('exportSpace — the claude.ai Project knowledge bridge', () => {
  it('writes one sanitized markdown file per visible asset plus INDEX.md', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'spaces-export-'));
    const client = fakeClient();
    const out = await exportSpace(client, 'sp-1', dir);
    expect(out.files).toBe(2);
    const listing = await fs.readdir(dir);
    expect(listing).toContain('INDEX.md');
    expect(listing).toContain('Plan-A.md');
    // Punctuation is stripped from filenames, content survives whole.
    const notes = listing.find((f) => f.startsWith('Notes'));
    expect(notes).toBeDefined();
    const body = await fs.readFile(path.join(dir, 'Plan-A.md'), 'utf8');
    expect(body).toContain('body of i-1');
    const index = await fs.readFile(path.join(dir, 'INDEX.md'), 'utf8');
    expect(index).toContain('Plan A');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('an invisible asset is omitted, never guessed about', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'spaces-export-'));
    const client = fakeClient();
    (client.getItem as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) =>
      id === 'i-2' ? null : { id, title: 'Plan A', content: 'x' }
    );
    const out = await exportSpace(client, 'sp-1', dir);
    expect(out.files).toBe(1);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
